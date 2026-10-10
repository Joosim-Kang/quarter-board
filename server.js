'use strict';
// 3팀 쿼터 점수판 서버. 외부 라이브러리 없이 Node 18+ 기본 모듈만 사용해요.
// 방(코드) 단위로 점수를 메모리에 두고, 접속한 모든 화면에 SSE로 바로 보내요.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

const MAX_ROOMS = 1000;
const MAX_CLIENTS_PER_ROOM = 300;
const ROOM_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_BODY = 8 * 1024;
const POSTS_PER_MINUTE = 120;

const PAIRS = [[0, 1], [0, 2], [1, 2]];
const DEF_NAMES = ['1팀', '2팀', '3팀'];
const CODE_RE = /^[A-Z0-9]{4,8}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// 앱 설치에 필요한 파일들. 이 목록에 있는 것만 내려줘요.
const STATIC = {
  '/sw.js': { file: 'sw.js', type: 'application/javascript; charset=utf-8', cache: 'no-cache' },
  '/icon-192.png': { file: 'icon-192.png', type: 'image/png', cache: 'public, max-age=86400' },
  '/icon-512.png': { file: 'icon-512.png', type: 'image/png', cache: 'public, max-age=86400' },
  '/apple-touch-icon.png': { file: 'apple-touch-icon.png', type: 'image/png', cache: 'public, max-age=86400' },
};

// 방마다 시작 주소가 다른 설치 설정. 홈 화면 아이콘을 누르면 그 방이 바로 열려요.
function manifestFor(code, view) {
  const start = code ? '/r/' + code + (view ? '?view=1' : '') : '/';
  return {
    id: start,
    name: '3팀 쿼터 점수판',
    short_name: '점수판',
    description: '로그인 없이 여럿이 같이 보고 입력하는 3팀 쿼터 점수판',
    lang: 'ko',
    start_url: start,
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#EDF0F3',
    theme_color: '#1D4ED8',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
}

/** code -> { state, clients:Set<ServerResponse>, seen:number } */
const rooms = new Map();

/* ---------- 상태 검증 ---------- */
function isInt(n, min, max) { return Number.isInteger(n) && n >= min && n <= max; }
function validOrder(o) { return Array.isArray(o) && o.length === 3 && [0, 1, 2].every((x) => o.includes(x)); }
function validFirst(f) { return Array.isArray(f) && f.length === 3 && f.every((t, p) => PAIRS[p].includes(t)); }

function freshState() {
  // first: 1쿼터 선공 팀, left: 1쿼터에 코트 왼쪽에 있는 팀 (둘 다 경기 순서 0,1,2 = 1vs2, 1vs3, 2vs3 기준)
  return { names: DEF_NAMES.slice(), quarters: 4, order: [0, 1, 2], first: [0, 0, 1], left: [0, 0, 1], started: false, scores: [], gen: 0, v: 1, updatedAt: Date.now() };
}

// 파일이나 클라이언트에서 온 값은 믿지 않고 항상 이 함수로 걸러요.
function sanitize(o) {
  const s = freshState();
  if (!o || typeof o !== 'object') return s;
  if (Array.isArray(o.names) && o.names.length === 3) s.names = o.names.map((x) => String(x == null ? '' : x).slice(0, 8));
  if (isInt(o.quarters, 1, 6)) s.quarters = o.quarters;
  if (validOrder(o.order)) s.order = o.order.slice();
  if (validFirst(o.first)) s.first = o.first.slice();
  if (validFirst(o.left)) s.left = o.left.slice(); // 예전 방에는 없는 값이라 없으면 기본값을 써요
  s.started = !!o.started;
  if (Array.isArray(o.scores)) {
    for (const p of o.scores) {
      if (s.scores.length >= s.quarters * 3) break;
      if (Array.isArray(p) && p.length === 2 && isInt(p[0], 0, 9999) && isInt(p[1], 0, 9999)) s.scores.push([p[0], p[1]]);
      else break;
    }
  }
  s.gen = isInt(o.gen, 0, 1e9) ? o.gen : 0;
  s.v = isInt(o.v, 1, 1e9) ? o.v : 1;
  s.updatedAt = Date.now();
  return s;
}

/* ---------- 액션 처리 ---------- */
function bad(status, error) { return { status, error }; }

// 성공하면 null, 실패하면 {status, error}. s는 복사본이라 실패해도 원본은 그대로예요.
function apply(s, a) {
  if (!a || typeof a !== 'object') return bad(400, '잘못된 요청이에요.');
  switch (a.type) {
    case 'config': {
      if (s.started) return bad(409, '게임이 이미 시작돼서 설정을 바꿀 수 없어요.');
      const p = a.patch;
      if (!p || typeof p !== 'object') return bad(400, '잘못된 요청이에요.');
      if ('names' in p) {
        if (!Array.isArray(p.names) || p.names.length !== 3) return bad(400, '팀 이름이 올바르지 않아요.');
        s.names = p.names.map((x) => String(x == null ? '' : x).slice(0, 8));
      }
      if ('quarters' in p) {
        if (!isInt(p.quarters, 1, 6)) return bad(400, '쿼터 수가 올바르지 않아요.');
        s.quarters = p.quarters;
      }
      if ('order' in p) {
        if (!validOrder(p.order)) return bad(400, '경기 순서가 올바르지 않아요.');
        s.order = p.order.slice();
      }
      if ('first' in p) {
        if (!validFirst(p.first)) return bad(400, '선공 설정이 올바르지 않아요.');
        s.first = p.first.slice();
      }
      if ('left' in p) {
        if (!validFirst(p.left)) return bad(400, '코트 위치 설정이 올바르지 않아요.');
        s.left = p.left.slice();
      }
      return null;
    }
    case 'start':
      if (s.started) return bad(409, '이미 시작한 게임이에요.');
      s.started = true; s.scores = []; s.gen += 1;
      return null;
    case 'score': {
      if (!s.started) return bad(409, '아직 게임을 시작하지 않았어요.');
      if (!isInt(a.a, 0, 9999) || !isInt(a.b, 0, 9999)) return bad(400, '점수는 0부터 9999 사이의 숫자로 입력해 주세요.');
      if (!isInt(a.i, 0, s.quarters * 3 - 1)) return bad(400, '경기 번호가 올바르지 않아요.');
      if (a.mode === 'edit') {
        if (a.i >= s.scores.length) return bad(409, '아직 입력하지 않은 경기예요.');
        s.scores[a.i] = [a.a, a.b];
        return null;
      }
      if (a.i !== s.scores.length) return bad(409, '방금 다른 사람이 이 경기 점수를 먼저 입력했어요. 화면을 새로 맞췄어요.');
      s.scores.push([a.a, a.b]);
      return null;
    }
    case 'undo':
      if (a.n !== s.scores.length) return bad(409, '그사이 점수가 바뀌었어요. 화면을 새로 맞췄으니 다시 확인해 주세요.');
      if (!s.scores.length) return bad(409, '취소할 입력이 없어요.');
      s.scores.pop();
      return null;
    case 'reset':
      s.started = false; s.scores = []; s.gen += 1;
      return null;
    default:
      return bad(400, '알 수 없는 요청이에요.');
  }
}

/* ---------- 방 관리 ---------- */
function lastActive(room) { return Math.max(room.seen, room.state.updatedAt); }

function prune() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && now - lastActive(room) > ROOM_TTL_MS) rooms.delete(code);
  }
  if (rooms.size >= MAX_ROOMS) {
    let oldest = null;
    for (const [code, room] of rooms) {
      if (room.clients.size === 0 && (!oldest || lastActive(room) < lastActive(rooms.get(oldest)))) oldest = code;
    }
    if (oldest) rooms.delete(oldest);
  }
}

function newCode() {
  for (let t = 0; t < 30; t++) {
    let c = '';
    for (let i = 0; i < 5; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function addRoom(code, state) {
  const room = { state, clients: new Set(), seen: Date.now() };
  rooms.set(code, room);
  scheduleSave();
  return room;
}

function broadcast(room) {
  const msg = 'data: ' + JSON.stringify(room.state) + '\n\n';
  for (const res of room.clients) {
    try { res.write(msg); } catch (e) { room.clients.delete(res); }
  }
}

/* ---------- 파일 저장 (무료 호스팅에서는 재시작하면 지워질 수 있어요) ---------- */
let saveTimer = null;
function saveNow() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const o = {};
    for (const [c, r] of rooms) o[c] = r.state;
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(o));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) { console.error('저장하지 못했어요:', e.message); }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 2000);
  saveTimer.unref();
}
function loadRooms() {
  try {
    const o = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const code of Object.keys(o)) {
      if (CODE_RE.test(code) && rooms.size < MAX_ROOMS) rooms.set(code, { state: sanitize(o[code]), clients: new Set(), seen: Date.now() });
    }
    console.log('저장된 방 ' + rooms.size + '개를 불러왔어요.');
  } catch (e) { /* 파일이 없으면 새로 시작해요 */ }
}

/* ---------- HTTP 도우미 ---------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC);
  if (status === 413) headers.Connection = 'close';
  res.writeHead(status, headers);
  res.end(body);
}

function sendIndex(res, code, view) {
  fs.readFile(INDEX_FILE, 'utf8', (err, html) => {
    if (err) { res.writeHead(500, SEC); res.end('index.html을 찾을 수 없어요.'); return; }
    // 방 주소로 들어오면, 설치 설정도 그 방용으로 바꿔서 내려줘요.
    if (code) html = html.replace('href="/manifest.webmanifest"', 'href="/manifest.webmanifest?r=' + code + (view ? '&amp;v=1' : '') + '"');
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP }, SEC));
    res.end(html);
  });
}

function sendStatic(res, item) {
  fs.readFile(path.join(__dirname, 'public', item.file), (err, buf) => {
    if (err) { res.writeHead(404, SEC); res.end('Not found'); return; }
    res.writeHead(200, Object.assign({ 'Content-Type': item.type, 'Cache-Control': item.cache }, SEC));
    res.end(buf);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; let tooBig = false; const chunks = [];
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; reject(Object.assign(new Error('too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const hits = new Map();
function limited(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset) { h = { n: 0, reset: now + 60000 }; hits.set(ip, h); }
  h.n += 1;
  return h.n > POSTS_PER_MINUTE;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 60000).unref();

function openStream(req, res, room) {
  if (room.clients.size >= MAX_CLIENTS_PER_ROOM) { sendJson(res, 503, { error: '이 방에 접속한 사람이 너무 많아요.' }); return; }
  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  }, SEC));
  res.write('retry: 3000\n\n');
  res.write('data: ' + JSON.stringify(room.state) + '\n\n');
  room.clients.add(res);
  req.on('close', () => room.clients.delete(res));
}

setInterval(() => {
  for (const room of rooms.values()) for (const res of room.clients) { try { res.write(': ping\n\n'); } catch (e) { room.clients.delete(res); } }
}, 20000).unref();
setInterval(prune, 30 * 60 * 1000).unref();

/* ---------- 라우팅 ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method;

    if (method === 'GET' && url.pathname === '/healthz') { res.writeHead(200, SEC); res.end('ok'); return; }
    if (method === 'GET' && parts.length === 0) { sendIndex(res); return; }
    if (method === 'GET' && parts[0] === 'r' && parts.length === 2) {
      const rc = String(parts[1]).toUpperCase();
      sendIndex(res, CODE_RE.test(rc) ? rc : null, url.searchParams.get('view') === '1');
      return;
    }
    if (method === 'GET' && url.pathname === '/manifest.webmanifest') {
      const rc = String(url.searchParams.get('r') || '').toUpperCase();
      const body = JSON.stringify(manifestFor(CODE_RE.test(rc) ? rc : null, url.searchParams.get('v') === '1'));
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' }, SEC));
      res.end(body);
      return;
    }
    if (method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC, url.pathname)) { sendStatic(res, STATIC[url.pathname]); return; }

    if (parts[0] === 'api' && parts[1] === 'rooms') {
      if (parts.length === 2 && method === 'POST') {
        if (limited(req)) { sendJson(res, 429, { error: '요청이 너무 많아요. 잠시 뒤에 다시 시도해 주세요.' }); return; }
        prune();
        if (rooms.size >= MAX_ROOMS) { sendJson(res, 503, { error: '지금은 방을 더 만들 수 없어요.' }); return; }
        const code = newCode();
        if (!code) { sendJson(res, 503, { error: '방 코드를 만들지 못했어요. 다시 시도해 주세요.' }); return; }
        addRoom(code, freshState());
        sendJson(res, 201, { code });
        return;
      }

      const code = String(parts[2] || '').toUpperCase();
      if (!CODE_RE.test(code)) { sendJson(res, 404, { error: '방 코드가 올바르지 않아요.' }); return; }
      const room = rooms.get(code);
      const sub = parts[3] || '';

      if (parts.length <= 4 && method === 'GET' && sub === '') {
        if (!room) { sendJson(res, 404, { error: '방을 찾을 수 없어요.' }); return; }
        room.seen = Date.now();
        sendJson(res, 200, room.state);
        return;
      }
      if (parts.length === 4 && method === 'GET' && sub === 'events') {
        if (!room) { sendJson(res, 404, { error: '방을 찾을 수 없어요.' }); return; }
        room.seen = Date.now();
        openStream(req, res, room);
        return;
      }
      if (parts.length === 4 && method === 'POST' && (sub === 'action' || sub === 'restore')) {
        if (limited(req)) { sendJson(res, 429, { error: '요청이 너무 많아요. 잠시 뒤에 다시 시도해 주세요.' }); return; }
        let body;
        try { body = await readJson(req); }
        catch (e) { sendJson(res, e.status || 400, { error: '요청을 읽지 못했어요.' }); return; }

        if (sub === 'restore') {
          // 서버가 재시작돼서 방이 사라졌을 때, 접속해 있던 기기가 마지막 점수를 다시 올려 방을 되살려요.
          if (room) { sendJson(res, 409, { error: '방이 이미 있어요.', state: room.state }); return; }
          prune();
          if (rooms.size >= MAX_ROOMS) { sendJson(res, 503, { error: '지금은 방을 복구할 수 없어요.' }); return; }
          const st = sanitize(body && body.state);
          st.v = (body && body.state && isInt(body.state.v, 1, 1e9) ? body.state.v : 1) + 1;
          addRoom(code, st);
          sendJson(res, 201, { state: st });
          return;
        }

        if (!room) { sendJson(res, 404, { error: '방을 찾을 수 없어요.' }); return; }
        room.seen = Date.now();
        const next = JSON.parse(JSON.stringify(room.state));
        const err = apply(next, body);
        if (err) { sendJson(res, err.status, { error: err.error, state: room.state }); return; }
        next.v = room.state.v + 1;
        next.updatedAt = Date.now();
        room.state = next;
        broadcast(room);
        scheduleSave();
        sendJson(res, 200, { state: next });
        return;
      }
    }

    res.writeHead(404, SEC); res.end('Not found');
  } catch (e) {
    console.error(e);
    try { sendJson(res, 500, { error: '서버에 문제가 생겼어요.' }); } catch (_) { /* 이미 응답 중 */ }
  }
});

function shutdown() { saveNow(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) {
  loadRooms();
  server.listen(PORT, '0.0.0.0', () => console.log('점수판 서버가 켜졌어요: http://localhost:' + PORT));
}

module.exports = { server, apply, sanitize, freshState };
