/**
 * GPS 출퇴근 통합 버전 · Cloudflare Worker + D1
 * 바인딩: DB (D1), 환경변수: ADMIN_KEY (관리자 키), ALLOWED_ORIGIN (선택, 기본 *)
 */
const MAX_ACC = 100;   // GPS 오차 허용 상한(m)
const MIN_RADIUS = 10; // 최소 반경(m)

// ---------- 유틸
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
const err = (msg, status = 400) => json({ ok: false, error: msg }, status);

function cors(env, req) {
  const origin = env.ALLOWED_ORIGIN || '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-admin-key',
    'access-control-max-age': '86400',
  };
}

function distM(a, b, c, d) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(c - a), dLng = toR(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a)) * Math.cos(toR(c)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function judge(lat, lng, acc, store) {
  const distance = Math.round(distM(lat, lng, store.lat, store.lng));
  const accOk = acc <= MAX_ACC;
  const inRange = accOk && (distance - acc <= store.radius_m);
  return { distance, inRange, accOk };
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const pinHash = (phone, pin) => sha256(`${phone}:${pin}:gpsatt`);
const randToken = () => {
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
};
const normPhone = p => String(p || '').replace(/\D/g, '');

async function readJson(req) { try { return await req.json(); } catch { return null; } }

async function authUser(req, env) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  return env.DB.prepare('SELECT id,name,phone,store_id,active FROM users WHERE token=? AND active=1').bind(token).first();
}
function isAdmin(req, env) {
  const k = req.headers.get('x-admin-key') || '';
  return !!env.ADMIN_KEY && k === env.ADMIN_KEY;
}

// ---------- 핸들러
async function listStores(env) {
  const { results } = await env.DB.prepare('SELECT id,name,address FROM stores WHERE active=1 ORDER BY name').all();
  return json({ ok: true, stores: results });
}

async function signup(req, env) {
  const b = await readJson(req); if (!b) return err('잘못된 요청');
  const name = String(b.name || '').trim(), phone = normPhone(b.phone), pin = String(b.pin || '');
  const storeId = parseInt(b.store_id, 10);
  if (name.length < 1) return err('이름을 입력하세요');
  if (phone.length < 9) return err('휴대폰 번호를 확인하세요');
  if (!/^\d{4,6}$/.test(pin)) return err('PIN은 숫자 4~6자리');
  const store = await env.DB.prepare('SELECT id FROM stores WHERE id=? AND active=1').bind(storeId).first();
  if (!store) return err('매장을 선택하세요');
  const exists = await env.DB.prepare('SELECT id FROM users WHERE phone=?').bind(phone).first();
  if (exists) return err('이미 가입된 번호입니다. 로그인하세요', 409);
  const token = randToken();
  await env.DB.prepare('INSERT INTO users (name,phone,pin_hash,store_id,token) VALUES (?,?,?,?,?)')
    .bind(name, phone, await pinHash(phone, pin), storeId, token).run();
  return json({ ok: true, token, name, store_id: storeId });
}

async function login(req, env) {
  const b = await readJson(req); if (!b) return err('잘못된 요청');
  const phone = normPhone(b.phone), pin = String(b.pin || '');
  const u = await env.DB.prepare('SELECT id,name,pin_hash,store_id,active FROM users WHERE phone=?').bind(phone).first();
  if (!u || !u.active || u.pin_hash !== await pinHash(phone, pin)) return err('번호 또는 PIN이 올바르지 않습니다', 401);
  const token = randToken();
  await env.DB.prepare('UPDATE users SET token=? WHERE id=?').bind(token, u.id).run();
  return json({ ok: true, token, name: u.name, store_id: u.store_id });
}

async function myStore(user, env) {
  const s = await env.DB.prepare('SELECT id,name,address,lat,lng,radius_m FROM stores WHERE id=?').bind(user.store_id).first();
  if (!s) return err('소속 매장이 없습니다', 404);
  return json({ ok: true, user: { id: user.id, name: user.name }, store: s, rules: { max_accuracy_m: MAX_ACC } });
}

async function postAttendance(req, user, env) {
  const b = await readJson(req); if (!b) return err('잘못된 요청');
  const type = b.type === 'OUT' ? 'OUT' : b.type === 'IN' ? 'IN' : null;
  const lat = +b.lat, lng = +b.lng, acc = Math.round(+b.accuracy_m);
  const cid = String(b.client_record_id || '').slice(0, 80);
  if (!type || !cid || !isFinite(lat) || !isFinite(lng) || !isFinite(acc)) return err('필수 값 누락');
  const dup = await env.DB.prepare('SELECT id,distance_m,in_range,flagged FROM attendance_records WHERE client_record_id=?').bind(cid).first();
  if (dup) return json({ ok: true, record_id: dup.id, distance_m: dup.distance_m, in_range: !!dup.in_range, flagged: !!dup.flagged, dup: true });
  const store = await env.DB.prepare('SELECT id,lat,lng,radius_m FROM stores WHERE id=?').bind(user.store_id).first();
  if (!store) return err('소속 매장이 없습니다', 404);
  const j = judge(lat, lng, acc, store);
  const clientSaidIn = b.client_in_range !== false; // 클라이언트 판정과 불일치 시 flagged
  const flagged = (!j.inRange) || (clientSaidIn !== j.inRange) ? 1 : 0;
  const recordedAt = b.recorded_at || new Date().toISOString();
  const r = await env.DB.prepare(`INSERT INTO attendance_records
    (client_record_id,user_id,store_id,type,recorded_at,lat,lng,accuracy_m,distance_m,store_lat,store_lng,store_radius_m,in_range,flagged,device_info)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(cid, user.id, store.id, type, recordedAt, lat, lng, acc, j.distance, store.lat, store.lng, store.radius_m, j.inRange ? 1 : 0, flagged, String(b.device_info || '').slice(0, 120))
    .run();
  return json({ ok: true, record_id: r.meta.last_row_id, distance_m: j.distance, in_range: j.inRange, flagged: !!flagged });
}

async function myAttendance(url, user, env) {
  const from = url.searchParams.get('from') || '1970-01-01', to = url.searchParams.get('to') || '2999-12-31';
  const { results } = await env.DB.prepare(
    'SELECT id,type,recorded_at,distance_m,accuracy_m,in_range,flagged FROM attendance_records WHERE user_id=? AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC LIMIT 200')
    .bind(user.id, from, to + 'T23:59:59').all();
  return json({ ok: true, records: results });
}

// ---------- 관리자
async function adminStores(env) {
  const { results } = await env.DB.prepare('SELECT * FROM stores ORDER BY active DESC, name').all();
  return json({ ok: true, stores: results });
}
async function adminUpsertStore(req, env) {
  const b = await readJson(req); if (!b) return err('잘못된 요청');
  const name = String(b.name || '').trim(), lat = +b.lat, lng = +b.lng;
  let radius = parseInt(b.radius_m, 10); if (!isFinite(radius)) radius = 50; radius = Math.max(MIN_RADIUS, radius);
  if (!name || !isFinite(lat) || !isFinite(lng)) return err('매장명·좌표 필수');
  if (b.id) {
    const prev = await env.DB.prepare('SELECT lat,lng,radius_m FROM stores WHERE id=?').bind(b.id).first();
    if (!prev) return err('매장 없음', 404);
    if (prev.lat !== lat || prev.lng !== lng || prev.radius_m !== radius)
      await env.DB.prepare('INSERT INTO store_location_history (store_id,lat,lng,radius_m) VALUES (?,?,?,?)').bind(b.id, prev.lat, prev.lng, prev.radius_m).run();
    await env.DB.prepare('UPDATE stores SET name=?,address=?,lat=?,lng=?,radius_m=?,kakao_place_id=?,active=?,updated_at=datetime(\'now\') WHERE id=?')
      .bind(name, b.address || null, lat, lng, radius, b.kakao_place_id || null, b.active === false ? 0 : 1, b.id).run();
    return json({ ok: true, id: b.id });
  }
  const r = await env.DB.prepare('INSERT INTO stores (name,address,lat,lng,radius_m,kakao_place_id) VALUES (?,?,?,?,?,?)')
    .bind(name, b.address || null, lat, lng, radius, b.kakao_place_id || null).run();
  return json({ ok: true, id: r.meta.last_row_id });
}
async function adminUsers(url, env) {
  const storeId = url.searchParams.get('store_id');
  const q = storeId
    ? env.DB.prepare('SELECT u.id,u.name,u.phone,u.store_id,u.active,u.created_at,s.name AS store_name FROM users u LEFT JOIN stores s ON s.id=u.store_id WHERE u.store_id=? ORDER BY u.name').bind(storeId)
    : env.DB.prepare('SELECT u.id,u.name,u.phone,u.store_id,u.active,u.created_at,s.name AS store_name FROM users u LEFT JOIN stores s ON s.id=u.store_id ORDER BY s.name,u.name');
  const { results } = await q.all();
  return json({ ok: true, users: results });
}
async function adminAttendance(url, env) {
  const storeId = url.searchParams.get('store_id');
  const from = url.searchParams.get('from') || '1970-01-01', to = (url.searchParams.get('to') || '2999-12-31') + 'T23:59:59';
  const flaggedOnly = url.searchParams.get('flagged') === '1';
  let sql = `SELECT a.*, u.name AS user_name, u.phone, s.name AS store_name
             FROM attendance_records a JOIN users u ON u.id=a.user_id JOIN stores s ON s.id=a.store_id
             WHERE a.recorded_at BETWEEN ? AND ?`;
  const args = [from, to];
  if (storeId) { sql += ' AND a.store_id=?'; args.push(storeId); }
  if (flaggedOnly) sql += ' AND a.flagged=1';
  sql += ' ORDER BY a.recorded_at DESC LIMIT 2000';
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  if (url.searchParams.get('format') === 'csv') {
    const head = ['기록일시', '매장', '이름', '전화', '구분', '거리m', '오차m', '반경m', '반경내', '플래그', '기기'];
    const rows = results.map(r => [r.recorded_at, r.store_name, r.user_name, r.phone, r.type === 'IN' ? '출근' : '퇴근', r.distance_m, r.accuracy_m, r.store_radius_m, r.in_range ? 'Y' : 'N', r.flagged ? 'Y' : '', r.device_info]
      .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
    return new Response('﻿' + [head.join(','), ...rows].join('\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="attendance.csv"' } });
  }
  return json({ ok: true, records: results });
}
async function adminSetUser(req, env) {
  const b = await readJson(req); if (!b || !b.id) return err('잘못된 요청');
  if (b.store_id) await env.DB.prepare('UPDATE users SET store_id=? WHERE id=?').bind(b.store_id, b.id).run();
  if (typeof b.active === 'boolean') await env.DB.prepare('UPDATE users SET active=?, token=CASE WHEN ?=0 THEN NULL ELSE token END WHERE id=?').bind(b.active ? 1 : 0, b.active ? 1 : 0, b.id).run();
  if (b.reset_pin) {
    const u = await env.DB.prepare('SELECT phone FROM users WHERE id=?').bind(b.id).first();
    await env.DB.prepare('UPDATE users SET pin_hash=?, token=NULL WHERE id=?').bind(await pinHash(u.phone, String(b.reset_pin)), b.id).run();
  }
  return json({ ok: true });
}

// ---------- 라우터
export default {
  async fetch(req, env) {
    const headers = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;
    try {
      let res;
      if (p === '/' && m === 'GET') res = json({ ok: true, service: 'gps-attendance-api', time: new Date().toISOString() });
      else if (p === '/stores' && m === 'GET') res = await listStores(env);
      else if (p === '/auth/signup' && m === 'POST') res = await signup(req, env);
      else if (p === '/auth/login' && m === 'POST') res = await login(req, env);
      else if (p.startsWith('/admin/')) {
        if (!isAdmin(req, env)) res = err('관리자 인증 실패', 401);
        else if (p === '/admin/stores' && m === 'GET') res = await adminStores(env);
        else if (p === '/admin/stores' && (m === 'POST' || m === 'PUT')) res = await adminUpsertStore(req, env);
        else if (p === '/admin/users' && m === 'GET') res = await adminUsers(url, env);
        else if (p === '/admin/users' && m === 'POST') res = await adminSetUser(req, env);
        else if (p === '/admin/attendance' && m === 'GET') res = await adminAttendance(url, env);
        else res = err('없는 경로', 404);
      } else {
        const user = await authUser(req, env);
        if (!user) res = err('로그인이 필요합니다', 401);
        else if (p === '/me/store' && m === 'GET') res = await myStore(user, env);
        else if (p === '/attendance' && m === 'POST') res = await postAttendance(req, user, env);
        else if (p === '/attendance' && m === 'GET') res = await myAttendance(url, user, env);
        else res = err('없는 경로', 404);
      }
      Object.entries(headers).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    } catch (e) {
      const res = err('서버 오류: ' + (e && e.message ? e.message : String(e)), 500);
      Object.entries(headers).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }
  }
};
