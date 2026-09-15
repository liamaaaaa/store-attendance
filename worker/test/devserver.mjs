// 로컬 E2E용: Worker를 Node HTTP로 띄우고(포트 8787) web/ 정적 파일 서빙(포트 8080)
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import worker from '../src/index.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const D1 = { prepare(sql) { let args = []; const st = db.prepare(sql); return {
  bind(...a) { args = a.map(v => v === undefined ? null : v); return this; },
  first() { return st.get(...args) ?? null; }, all() { return { results: st.all(...args) }; },
  run() { const r = st.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } }; } }; } };
const env = { DB: D1, ADMIN_KEY: 'admin-secret', ALLOWED_ORIGIN: '*' };

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request('http://localhost:8787' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787);

const webDir = path.resolve(new URL('../../docs', import.meta.url).pathname);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer((req, res) => {
  let f = path.join(webDir, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  let data = readFileSync(f);
  if (f.endsWith('config.js')) data = Buffer.from(`window.APP_CONFIG={API_BASE:'http://localhost:8787',KAKAO_JS_KEY:'',COMPANY_NAME:'테스트'};`);
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(data);
}).listen(8080);
console.log('api :8787, web :8080');
