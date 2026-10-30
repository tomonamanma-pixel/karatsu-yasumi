const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8787;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const DEFAULT_STORE = {
  staff: [],
  requests: [],
  submissions: [],
  deletions: [],
  settings: {
    warnAt: 2,
    notice: '休み希望は、前の月の15日までに入れてください。入った希望は、みんなに見えます。',
    code: ''
  },
  savedAt: null
};

let queue = Promise.resolve();
let codeFails = 0;
let codeLockedUntil = 0;

function readStore() {
  if (!fs.existsSync(DATA_FILE)) return JSON.parse(JSON.stringify(DEFAULT_STORE));
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!Array.isArray(parsed.staff)) parsed.staff = [];
  if (!Array.isArray(parsed.requests)) parsed.requests = [];
  if (!Array.isArray(parsed.submissions)) parsed.submissions = [];
  if (!Array.isArray(parsed.deletions)) parsed.deletions = [];
  parsed.settings = Object.assign({}, DEFAULT_STORE.settings, parsed.settings || {});
  return parsed;
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  store.savedAt = new Date().toISOString();
  const json = JSON.stringify(store, null, 2);
  const tmp = DATA_FILE + '.tmp';
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch (err) { /* keep going */ }
  }
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    fs.copyFileSync(tmp, DATA_FILE);
    fs.rmSync(tmp, { force: true });
  }
}

function mutate(fn) {
  const run = queue.then(() => {
    const store = readStore();
    const result = fn(store) || {};
    if (result.write !== false) writeStore(store);
    return { store, result };
  });
  queue = run.then(() => {}, () => {});
  return run;
}

function publicStore(store) {
  return {
    staff: store.staff,
    requests: store.requests,
    submissions: store.submissions,
    deletions: store.deletions || [],
    settings: {
      warnAt: store.settings.warnAt,
      notice: store.settings.notice,
      codeSet: Boolean(store.settings.code)
    },
    savedAt: store.savedAt
  };
}

function cleanName(value) {
  return String(value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function validMonth(value) {
  return /^\d{4}-\d{2}$/.test(value);
}

function ymdLocal(dt) {
  const z = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + z(dt.getMonth() + 1) + '-' + z(dt.getDate());
}

function deadlinePassed(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const saturday = new Date(dt);
  saturday.setDate(dt.getDate() + (6 - dt.getDay()));
  const deadline = new Date(saturday);
  deadline.setDate(saturday.getDate() - 21);
  return ymdLocal(deadline) < ymdLocal(new Date());
}

function newId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function checkCode(store, code) {
  const expected = store.settings.code || '';
  if (!expected) return { ok: true };
  const now = Date.now();
  if (now < codeLockedUntil) {
    return { ok: false, error: '合言葉の間違いが続いています。少し待ってから、もう一度入れてください。' };
  }
  if (String(code || '') !== expected) {
    codeFails += 1;
    if (codeFails >= 5) {
      codeLockedUntil = now + 30000;
      codeFails = 0;
    }
    return { ok: false, error: '合言葉が違います。' };
  }
  codeFails = 0;
  return { ok: true };
}

function lanUrls() {
  const urls = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && !net.internal) urls.push('http://' + net.address + ':' + PORT);
    }
  }
  return urls;
}

function send(res, status, body, type) {
  const payload = (typeof body === 'string' || Buffer.isBuffer(body)) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100000) {
        reject(new Error('too big'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (err) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function serveFile(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  const fromPublic = path.relative(PUBLIC_DIR, file);
  if (fromPublic.startsWith('..') || path.isAbsolute(fromPublic)) {
    send(res, 404, { error: '見つかりません。' });
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(res, 404, { error: '見つかりません。' });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8'
  };
  send(res, 200, fs.readFileSync(file), types[ext] || 'application/octet-stream');
}

async function handleApi(req, res) {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && url === '/api/state') {
    send(res, 200, publicStore(readStore()));
    return;
  }
  if (req.method === 'GET' && url === '/api/info') {
    send(res, 200, { urls: lanUrls(), local: 'http://localhost:' + PORT });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 404, { error: '見つかりません。' });
    return;
  }

  let body;
  try { body = await readBody(req); }
  catch (err) {
    send(res, 400, { error: '送られた内容を読めませんでした。' });
    return;
  }

  try {
    const { store, result } = await mutate((current) => {
      if (url === '/api/unlock') {
        const auth = checkCode(current, body.code);
        if (!auth.ok) return { write: false, error: auth.error, status: 403 };
        return { write: false, ok: true };
      }

      if (url === '/api/staff') {
        const auth = checkCode(current, body.code);
        if (!auth.ok) return { error: auth.error, status: 403, write: false };
        const name = cleanName(body.name);
        if (!name) return { error: '名前を入れてください。', status: 400, write: false };
        if (current.staff.some((s) => s.name === name)) {
          return { error: '同じ名前がいます。区別できるように入れてください。', status: 400, write: false };
        }
        if (current.staff.length >= 40) {
          return { error: '名前は40人までです。', status: 400, write: false };
        }
        current.staff.push({ id: newId(), name });
        return { ok: true };
      }

      if (url === '/api/staff/update' || url === '/api/staff/remove' || url === '/api/staff/move') {
        const auth = checkCode(current, body.code);
        if (!auth.ok) return { error: auth.error, status: 403, write: false };
        const index = current.staff.findIndex((s) => s.id === body.id);
        if (index < 0) return { error: 'その名前は見当たりません。', status: 404, write: false };
        if (url === '/api/staff/update') {
          const name = cleanName(body.name);
          if (!name) return { error: '名前を入れてください。', status: 400, write: false };
          if (current.staff.some((s, i) => s.name === name && i !== index)) {
            return { error: '同じ名前がいます。区別できるように入れてください。', status: 400, write: false };
          }
          current.staff[index].name = name;
        } else if (url === '/api/staff/remove') {
          const id = current.staff[index].id;
          current.staff.splice(index, 1);
          current.requests = current.requests.filter((r) => r.staffId !== id);
          current.submissions = current.submissions.filter((s) => s.staffId !== id);
        } else {
          const dir = Number(body.dir) < 0 ? -1 : 1;
          const next = index + dir;
          if (next >= 0 && next < current.staff.length) {
            const tmp = current.staff[index];
            current.staff[index] = current.staff[next];
            current.staff[next] = tmp;
          }
        }
        return { ok: true };
      }

      if (url === '/api/remove') {
        if (!validDate(body.date)) return { error: '日付が正しくありません。', status: 400, write: false };
        const staff = current.staff.find((s) => s.id === body.id);
        const had = staff && current.requests.some((r) => r.staffId === staff.id && r.date === body.date);
        if (!had) return { error: 'その名前の希望はありません。', status: 400, write: false };
        current.requests = current.requests.filter((r) => !(r.staffId === staff.id && r.date === body.date));
        current.deletions = [];
        return { ok: true };
      }

      if (url === '/api/entry') {
        const name = cleanName(body.name);
        if (!name) return { error: '名前を入れてください。', status: 400, write: false };
        if (!validDate(body.date)) return { error: '日付が正しくありません。', status: 400, write: false };
        if (deadlinePassed(body.date)) return { error: 'この週は締め切りを過ぎているので、入れられません。', status: 400, write: false };
        const comment = String(body.comment || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
        let staff = current.staff.find((s) => s.name === name);
        if (!staff) {
          if (body.on === false) return { error: 'その名前の希望はありません。', status: 400, write: false };
          if (current.staff.length >= 40) return { error: '名前は40人までです。', status: 400, write: false };
          staff = { id: newId(), name };
          current.staff.push(staff);
        }
        current.requests = current.requests.filter((r) => !(r.staffId === staff.id && r.date === body.date));
        if (body.on !== false) current.requests.push({ staffId: staff.id, date: body.date, comment });
        const month = body.date.slice(0, 7);
        if (body.on !== false && !current.submissions.some((s) => s.staffId === staff.id && s.month === month)) {
          current.submissions.push({ staffId: staff.id, month });
        }
        current.requests.sort((a, b) => a.date.localeCompare(b.date) || a.staffId.localeCompare(b.staffId));
        return { ok: true };
      }

      if (url === '/api/request') {
        const staff = current.staff.find((s) => s.id === body.staffId);
        if (!staff) return { error: '名前を選び直してください。', status: 400, write: false };
        if (!validDate(body.date)) return { error: '日付が正しくありません。', status: 400, write: false };
        if (deadlinePassed(body.date)) return { error: 'この週は締め切りを過ぎているので、入れられません。', status: 400, write: false };
        const on = Boolean(body.on);
        current.requests = current.requests.filter((r) => !(r.staffId === staff.id && r.date === body.date));
        if (on) current.requests.push({ staffId: staff.id, date: body.date });
        const month = body.date.slice(0, 7);
        if (on && !current.submissions.some((s) => s.staffId === staff.id && s.month === month)) {
          current.submissions.push({ staffId: staff.id, month });
        }
        current.requests.sort((a, b) => a.date.localeCompare(b.date));
        return { ok: true };
      }

      if (url === '/api/none') {
        const staff = current.staff.find((s) => s.id === body.staffId);
        if (!staff) return { error: '名前を選び直してください。', status: 400, write: false };
        if (!validMonth(body.month)) return { error: '月が正しくありません。', status: 400, write: false };
        const hasDates = current.requests.some((r) => r.staffId === staff.id && r.date.startsWith(body.month));
        if (body.on && hasDates) {
          return { error: '希望の日が残っています。先に取り消してください。', status: 400, write: false };
        }
        current.submissions = current.submissions.filter((s) => !(s.staffId === staff.id && s.month === body.month));
        if (body.on) current.submissions.push({ staffId: staff.id, month: body.month });
        return { ok: true };
      }

      if (url === '/api/settings') {
        const auth = checkCode(current, body.code);
        if (!auth.ok) return { error: auth.error, status: 403, write: false };
        if (body.warnAt != null) {
          const n = Number(body.warnAt);
          if (Number.isFinite(n)) current.settings.warnAt = Math.min(6, Math.max(1, Math.round(n)));
        }
        if (typeof body.notice === 'string') {
          current.settings.notice = body.notice.replace(/[\u0000-\u0008]/g, '').trim().slice(0, 120);
        }
        if (body.clearCode) current.settings.code = '';
        if (typeof body.newCode === 'string' && body.newCode.trim()) {
          current.settings.code = body.newCode.trim().slice(0, 20);
        }
        return { ok: true };
      }

      return { error: '見つかりません。', status: 404, write: false };
    });

    if (result.error) {
      send(res, result.status || 400, { error: result.error });
      return;
    }
    send(res, 200, publicStore(store));
  } catch (err) {
    send(res, 500, { error: '保存できませんでした。もう一度押してください。' });
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) writeStore(JSON.parse(JSON.stringify(DEFAULT_STORE)));

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url.startsWith('/api/')) {
    handleApi(req, res);
    return;
  }
  if (req.method !== 'GET') {
    send(res, 405, { error: 'この操作はできません。' });
    return;
  }
  serveFile(req, res);
});

function openBrowser(url) {
  if (process.argv.includes('--no-open')) return;
  exec('cmd /c start "" "' + url + '"');
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log('すでに起動しています。');
    console.log('http://localhost:' + PORT);
    console.log('黒い画面がもう一つ開いていれば、そちらは閉じないでください。');
    openBrowser('http://localhost:' + PORT);
    setTimeout(() => process.exit(0), 300);
    return;
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  console.log('');
  console.log('唐津店 休み希望を起動しました。');
  console.log('');
  console.log('このパソコン: http://localhost:' + PORT);
  if (urls.length) {
    console.log('同じワイファイのスマホ:');
    urls.forEach((url) => console.log('  ' + url));
  }
  console.log('');
  console.log('この黒い画面は閉じないでください。閉じると止まります。');
  console.log('');
  openBrowser('http://localhost:' + PORT);
});
