// Node 22 내장 sqlite로 D1을 흉내 내어 Worker 핸들러를 통합 테스트
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

// D1 shim
const D1 = {
  prepare(sql) {
    let args = [];
    const st = db.prepare(sql);
    return {
      bind(...a) { args = a.map(v => v === undefined ? null : v); return this; },
      first() { return st.get(...args) ?? null; },
      all() { return { results: st.all(...args) }; },
      run() { const r = st.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
    };
  }
};
const env = { DB: D1, ADMIN_KEY: 'admin-secret', ALLOWED_ORIGIN: '*' };
const call = (method, path, body, headers = {}) =>
  worker.fetch(new Request('https://x' + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }), env)
    .then(async r => ({ status: r.status, body: r.headers.get('content-type').includes('json') ? await r.json() : await r.text() }));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };

// 1. 관리자 매장 등록
let r = await call('POST', '/admin/stores', { name: '제이드앤워터 성수', address: '서울 성동구', lat: 37.5446, lng: 127.0561, radius_m: 5 }, { 'x-admin-key': 'admin-secret' });
ok(r.status === 200 && r.body.id === 1, '매장 등록');
r = await call('GET', '/admin/stores', null, { 'x-admin-key': 'admin-secret' });
ok(r.body.stores[0].radius_m === 10, '최소 반경 10m 보정');
r = await call('GET', '/admin/stores', null, { 'x-admin-key': 'wrong' });
ok(r.status === 401, '관리자 키 오류 시 401');

// 2. 가입/로그인
r = await call('GET', '/stores');
ok(r.body.stores.length === 1 && !('lat' in r.body.stores[0]), '공개 매장 목록(좌표 미노출)');
r = await call('POST', '/auth/signup', { name: '홍길동', phone: '010-1234-5678', pin: '1234', store_id: 1 });
ok(r.status === 200 && r.body.token, '회원가입');
const token = r.body.token;
r = await call('POST', '/auth/signup', { name: '홍길동', phone: '01012345678', pin: '1234', store_id: 1 });
ok(r.status === 409, '중복 번호 가입 차단');
r = await call('POST', '/auth/login', { phone: '01012345678', pin: '0000' });
ok(r.status === 401, '잘못된 PIN 거부');
r = await call('POST', '/auth/login', { phone: '01012345678', pin: '1234' });
ok(r.status === 200 && r.body.token, '로그인');
const token2 = r.body.token;

// 3. 내 매장
r = await call('GET', '/me/store', null, { authorization: 'Bearer ' + token2 });
ok(r.body.store && r.body.store.lat === 37.5446 && r.body.store.radius_m === 10, '가입 매장 좌표 자동 수신');
r = await call('GET', '/me/store', null, { authorization: 'Bearer nope' });
ok(r.status === 401, '토큰 없으면 401');

// 4. 출퇴근 기록
r = await call('POST', '/attendance', { client_record_id: 'c1', type: 'IN', lat: 37.5447, lng: 127.0562, accuracy_m: 8, client_in_range: true }, { authorization: 'Bearer ' + token2 });
ok(r.status === 200 && r.body.in_range === true && r.body.flagged === false, `반경 안 출근 기록 (거리 ${r.body.distance_m}m)`);
r = await call('POST', '/attendance', { client_record_id: 'c1', type: 'IN', lat: 37.5447, lng: 127.0562, accuracy_m: 8 }, { authorization: 'Bearer ' + token2 });
ok(r.body.dup === true, '동일 client_record_id 멱등');
r = await call('POST', '/attendance', { client_record_id: 'c2', type: 'OUT', lat: 37.5500, lng: 127.0562, accuracy_m: 8, client_in_range: true }, { authorization: 'Bearer ' + token2 });
ok(r.body.in_range === false && r.body.flagged === true, `반경 밖 → flagged (거리 ${r.body.distance_m}m)`);
r = await call('POST', '/attendance', { client_record_id: 'c3', type: 'IN', lat: 37.5446, lng: 127.0561, accuracy_m: 150, client_in_range: false }, { authorization: 'Bearer ' + token2 });
ok(r.body.in_range === false && r.body.flagged === true, '오차 150m → 판정 제외·flagged');
r = await call('GET', '/attendance', null, { authorization: 'Bearer ' + token2 });
ok(r.body.records.length === 3, '내 기록 조회 3건');

// 5. 매장 좌표 변경 → 이력 + 과거 기록 보존
r = await call('PUT', '/admin/stores', { id: 1, name: '제이드앤워터 성수', lat: 37.5500, lng: 127.0600, radius_m: 30 }, { 'x-admin-key': 'admin-secret' });
const hist = db.prepare('SELECT * FROM store_location_history').all();
ok(hist.length === 1 && hist[0].lat === 37.5446, '좌표 변경 이력 저장');
r = await call('GET', '/admin/attendance?store_id=1', null, { 'x-admin-key': 'admin-secret' });
ok(r.body.records.every(x => x.store_lat === 37.5446), '과거 기록의 매장 기준 좌표 유지');
r = await call('GET', '/admin/attendance?flagged=1', null, { 'x-admin-key': 'admin-secret' });
ok(r.body.records.length === 2, 'flagged 필터');
r = await call('GET', '/admin/attendance?format=csv', null, { 'x-admin-key': 'admin-secret' });
ok(typeof r.body === 'string' && r.body.split('\n').length === 4, 'CSV 내보내기');

// 6. 사용자 관리
r = await call('POST', '/admin/users', { id: 1, active: false }, { 'x-admin-key': 'admin-secret' });
r = await call('GET', '/me/store', null, { authorization: 'Bearer ' + token2 });
ok(r.status === 401, '비활성 사용자 토큰 무효화');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
