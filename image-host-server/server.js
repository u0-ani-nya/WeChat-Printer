'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3900;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024;
const AUTO_CLEANUP_DAYS = Number(process.env.AUTO_CLEANUP_DAYS) || 0;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function log(level, msg, detail) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${detail ? ` | ${detail}` : ''}`;
  console.log(line);
}

// ─── Key Storage ───

function loadKeys() {
  try {
    const raw = fs.readFileSync(KEYS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.keys) ? data.keys : [];
  } catch { return []; }
}

function saveKeys(keys) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys }, null, 2), 'utf8');
}

function isValidKey(key) {
  return loadKeys().some((k) => k.key === key);
}

// ─── File Upload Helpers ───

function parseMultipart(buffer, boundary) {
  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(sep) + sep.length + 2; // skip \r\n

  while (start < buffer.length) {
    const end = buffer.indexOf(sep, start);
    if (end === -1) break;
    const part = buffer.subarray(start, end - 2); // strip trailing \r\n
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) { start = end + sep.length + 2; continue; }
    const headerStr = part.subarray(0, headerEnd).toString('utf8');
    const body = part.subarray(headerEnd + 4);
    const nameMatch = headerStr.match(/name="([^"]+)"/i);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/i);
    const contentTypeMatch = headerStr.match(/Content-Type:\s*(\S+)/i);
    parts.push({
      name: nameMatch?.[1] || '',
      filename: filenameMatch?.[1] || '',
      contentType: contentTypeMatch?.[1] || '',
      data: body,
    });
    start = end + sep.length + 2;
  }
  return parts;
}

function generateFilename(extension) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${ts}${rand}.${extension}`;
}

function getFileAge(filename) {
  try {
    const stat = fs.statSync(path.join(UPLOADS_DIR, filename));
    return (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  } catch { return Infinity; }
}

// ─── HTML Pages ───

function adminPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WeChat Printer 图床管理</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:#f5f5f5;color:#333;min-height:100vh}
.container{max-width:640px;margin:0 auto;padding:24px}
h1{font-size:20px;margin-bottom:4px}
.subtitle{color:#888;font-size:13px;margin-bottom:24px}
.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h2{font-size:15px;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.key-list{list-style:none}
.key-list li{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px}
.key-list li:last-child{border:none}
.key-value{font-family:monospace;font-size:12px;word-break:break-all;flex:1;margin-right:12px;color:#555}
.key-meta{color:#999;font-size:11px;white-space:nowrap}
.btn{padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;transition:.15s}
.btn-primary{background:#333;color:#fff}
.btn-primary:hover{background:#555}
.btn-danger{background:#fff;color:#e44;border:1px solid #e44}
.btn-danger:hover{background:#fee}
.btn-sm{padding:4px 10px;font-size:12px}
.input-row{display:flex;gap:8px;margin-bottom:12px}
.input-row input{flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px}
.server-url{background:#f9f9f9;padding:10px 14px;border-radius:8px;font-family:monospace;font-size:12px;word-break:break-all;margin-bottom:12px;border:1px dashed #ddd}
.empty{color:#aaa;font-size:13px;text-align:center;padding:20px}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;z-index:999;opacity:0;transition:.3s;pointer-events:none}
.toast.show{opacity:1}
.stats{display:flex;gap:16px;margin-bottom:16px;font-size:13px;color:#666}
.stats span{background:#f0f0f0;padding:4px 10px;border-radius:6px}
</style>
</head>
<body>
<div class="container">
  <h1>🖨️ WeChat Printer 图床</h1>
  <p class="subtitle">生成密钥后，在 WeChat Printer 的图床设置中填入服务器地址和密钥即可使用。</p>

  <div class="stats" id="stats"></div>

  <div class="card">
    <h2>🔑 上传密钥</h2>
    <div class="input-row">
      <input type="text" id="noteInput" placeholder="备注（可选，如：给小明的密钥）">
      <button class="btn btn-primary" onclick="generateKey()">生成新密钥</button>
    </div>
    <ul class="key-list" id="keyList"></ul>
    <div class="empty" id="emptyHint">暂无密钥，点击上方按钮生成</div>
  </div>

  <div class="card">
    <h2>📋 客户端配置</h2>
    <div class="server-url" id="serverUrl"></div>
    <p style="font-size:12px;color:#888">在 WeChat Printer → 设置 → 图床设置 → 选择「自定义图床」，填入上方地址和你生成的密钥。</p>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const BASE = location.origin;
document.getElementById('serverUrl').textContent = BASE;

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

async function loadKeys() {
  const res = await fetch('/api/keys');
  const data = await res.json();
  const list = document.getElementById('keyList');
  const empty = document.getElementById('emptyHint');
  const stats = document.getElementById('stats');

  if (!data.keys.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    stats.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  stats.innerHTML = \`<span>共 \${data.keys.length} 个密钥</span><span>\${data.fileCount || 0} 张图片</span>\`;
  list.innerHTML = data.keys.map(k => \`
    <li>
      <div style="flex:1;margin-right:12px">
        <div class="key-value">\${k.key}</div>
        <div class="key-meta">\${k.note ? k.note + ' · ' : ''}创建于 \${new Date(k.createdAt).toLocaleString('zh-CN')}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="copyKey('\${k.key}')">复制</button>
      <button class="btn btn-danger btn-sm" onclick="deleteKey('\${k.key}')" style="margin-left:4px">删除</button>
    </li>
  \`).join('');
}

async function generateKey() {
  const note = document.getElementById('noteInput').value.trim();
  const res = await fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) });
  const data = await res.json();
  if (data.key) {
    document.getElementById('noteInput').value = '';
    toast('密钥已生成');
    loadKeys();
  }
}

async function deleteKey(key) {
  if (!confirm('确定删除此密钥？使用此密钥的客户端将无法上传。')) return;
  await fetch('/api/keys/' + key, { method: 'DELETE' });
  toast('密钥已删除');
  loadKeys();
}

function copyKey(key) {
  navigator.clipboard.writeText(key).then(() => toast('已复制到剪贴板'));
}

loadKeys();
</script>
</body>
</html>`;
}

// ─── HTTP Server ───

function readBody(req, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) { req.destroy(); reject(new Error('文件过大')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message) {
  jsonResponse(res, status, { error: message });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // ── Management Page ──
    if (req.method === 'GET' && pathname === '/') {
      const html = adminPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      res.end(html);
      return;
    }

    // ── API: List Keys ──
    if (req.method === 'GET' && pathname === '/api/keys') {
      const keys = loadKeys();
      let fileCount = 0;
      try { fileCount = fs.readdirSync(UPLOADS_DIR).filter(f => !f.startsWith('.')).length; } catch {}
      jsonResponse(res, 200, { keys, fileCount });
      return;
    }

    // ── API: Generate Key ──
    if (req.method === 'POST' && pathname === '/api/keys') {
      const body = await readBody(req, 1024);
      let note = '';
      try { note = JSON.parse(body.toString('utf8')).note || ''; } catch {}
      const key = crypto.randomUUID();
      const keys = loadKeys();
      keys.push({ key, createdAt: new Date().toISOString(), note: String(note).slice(0, 100) });
      saveKeys(keys);
      log('INFO', '密钥已生成', note || key);
      jsonResponse(res, 200, { key });
      return;
    }

    // ── API: Delete Key ──
    if (req.method === 'DELETE' && pathname.startsWith('/api/keys/')) {
      const key = pathname.slice('/api/keys/'.length);
      const keys = loadKeys();
      const filtered = keys.filter((k) => k.key !== key);
      if (filtered.length === keys.length) return sendError(res, 404, '密钥不存在');
      saveKeys(filtered);
      log('INFO', '密钥已删除', key);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // ── Upload ──
    if (req.method === 'POST' && pathname === '/upload') {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!token || !isValidKey(token)) return sendError(res, 401, '无效的上传密钥');

      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/i);
      if (!boundaryMatch) return sendError(res, 400, '请使用 multipart/form-data 格式上传');

      const body = await readBody(req, MAX_FILE_SIZE);
      const parts = parseMultipart(body, boundaryMatch[1]);
      const filePart = parts.find((p) => p.name === 'file' && p.data.length > 0);
      if (!filePart) return sendError(res, 400, '未找到文件字段');

      const mime = (filePart.contentType || '').toLowerCase();
      const extension = ALLOWED_TYPES[mime];
      if (!extension) return sendError(res, 400, '仅支持 PNG、JPEG、WebP 格式');

      const filename = generateFilename(extension);
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), filePart.data);
      const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || `localhost:${PORT}`}`;
      const directUrl = `${baseUrl}/images/${filename}`;
      log('INFO', '图片已上传', `${filename} (${(filePart.data.length / 1024).toFixed(1)}KB)`);
      jsonResponse(res, 200, { directUrl, pageUrl: '', filename });
      return;
    }

    // ── Delete File ──
    if (req.method === 'DELETE' && pathname.startsWith('/file/')) {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!token || !isValidKey(token)) return sendError(res, 401, '无效的上传密钥');

      const filename = path.basename(pathname.slice('/file/'.length));
      const filePath = path.join(UPLOADS_DIR, filename);
      if (!fs.existsSync(filePath)) return sendError(res, 404, '文件不存在');
      fs.unlinkSync(filePath);
      log('INFO', '图片已删除', filename);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // ── Serve Images ──
    if (req.method === 'GET' && pathname.startsWith('/images/')) {
      const filename = path.basename(pathname.slice('/images/'.length));
      const filePath = path.join(UPLOADS_DIR, filename);
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not Found'); return; }
      const ext = path.extname(filename).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
      const stat = fs.statSync(filePath);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=31536000' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (error) {
    log('ERROR', error.message, req.url);
    sendError(res, 500, error.message);
  }
});

// ── Auto Cleanup ──
if (AUTO_CLEANUP_DAYS > 0) {
  setInterval(() => {
    try {
      const files = fs.readdirSync(UPLOADS_DIR);
      let cleaned = 0;
      for (const f of files) {
        if (f.startsWith('.')) continue;
        if (getFileAge(f) > AUTO_CLEANUP_DAYS) {
          fs.unlinkSync(path.join(UPLOADS_DIR, f));
          cleaned++;
        }
      }
      if (cleaned) log('INFO', `自动清理了 ${cleaned} 个过期图片`);
    } catch (error) { log('ERROR', '自动清理失败', error.message); }
  }, 6 * 60 * 60 * 1000); // every 6 hours
}

server.listen(PORT, HOST, () => {
  log('INFO', `图床服务已启动`, `http://${HOST}:${PORT}`);
  log('INFO', '打开管理页面生成上传密钥');
});
