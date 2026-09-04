<?php
require __DIR__ . '/config.php';

// ─── 工具函数 ───

function json_response($data, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function error_response($message, $status = 400) {
    json_response(['error' => $message], $status);
}

function get_auth_token() {
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (str_starts_with($auth, 'Bearer ')) {
        return trim(substr($auth, 7));
    }
    return '';
}

function load_keys() {
    if (!file_exists(KEYS_FILE)) return [];
    $data = json_decode(file_get_contents(KEYS_FILE), true);
    return is_array($data['keys'] ?? null) ? $data['keys'] : [];
}

function save_keys($keys) {
    $dir = dirname(KEYS_FILE);
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    file_put_contents(KEYS_FILE, json_encode(['keys' => $keys], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
}

function is_valid_key($token) {
    foreach (load_keys() as $k) {
        if ($k['key'] === $token) return true;
    }
    return false;
}

function generate_filename($ext) {
    return bin2hex(random_bytes(8)) . '.' . $ext;
}

function get_file_age_days($filename) {
    $path = UPLOADS_DIR . $filename;
    if (!file_exists($path)) return INF;
    return (time() - filemtime($path)) / 86400;
}

function get_base_url() {
    $proto = $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ($_SERVER['HTTPS'] ?? 'off') === 'on' ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost';
    return $proto . '://' . $host;
}

function check_admin_auth() {
    session_start();
    if (!empty($_SESSION['admin'])) return true;
    return false;
}

// ─── 路由 ───

$method = $_SERVER['REQUEST_METHOD'];
$uri = $_SERVER['REQUEST_URI'];
$script = $_SERVER['SCRIPT_NAME'];

// 去掉 query string
$path = parse_url($uri, PHP_URL_PATH);

// Nginx 会把所有请求 rewrite 到 index.php，所以用 REQUEST_URI
// 如果是直接访问 index.php，则用 PATH_INFO 或 REQUEST_URI
if ($path === $script || $path === '/index.php') {
    $path = '/';
}

// ─── 管理页面登录 ───

if ($method === 'POST' && $path === '/api/login') {
    $input = json_decode(file_get_contents('php://input'), true);
    $password = $input['password'] ?? '';
    if ($password !== ADMIN_PASSWORD) {
        error_response('密码错误', 401);
    }
    session_start();
    $_SESSION['admin'] = true;
    json_response(['ok' => true]);
}

if ($method === 'POST' && $path === '/api/logout') {
    session_start();
    session_destroy();
    json_response(['ok' => true]);
}

// ─── 管理页面 ───

if ($method === 'GET' && $path === '/') {
    session_start();
    $logged_in = !empty($_SESSION['admin']);

    if (!$logged_in) {
        // 显示登录页面
        show_login_page();
        exit;
    }

    show_admin_page();
    exit;
}

// ─── API: 列出密钥 ───

if ($method === 'GET' && $path === '/api/keys') {
    if (!check_admin_auth()) error_response('未登录', 401);
    $keys = load_keys();
    $file_count = 0;
    if (is_dir(UPLOADS_DIR)) {
        $file_count = count(array_filter(scandir(UPLOADS_DIR), fn($f) => !str_starts_with($f, '.')));
    }
    json_response(['keys' => $keys, 'fileCount' => $file_count]);
}

// ─── API: 生成密钥 ───

if ($method === 'POST' && $path === '/api/keys') {
    if (!check_admin_auth()) error_response('未登录', 401);
    $input = json_decode(file_get_contents('php://input'), true);
    $note = mb_substr(trim($input['note'] ?? ''), 0, 100);
    $key = bin2hex(random_bytes(16));
    // 格式化为 UUID 格式
    $key = sprintf('%s-%s-%s-%s-%s',
        substr($key, 0, 8), substr($key, 8, 4), substr($key, 12, 4),
        substr($key, 16, 4), substr($key, 20, 12)
    );
    $keys = load_keys();
    $keys[] = ['key' => $key, 'createdAt' => date('c'), 'note' => $note];
    save_keys($keys);
    json_response(['key' => $key]);
}

// ─── API: 删除密钥 ───

if ($method === 'DELETE' && str_starts_with($path, '/api/keys/')) {
    if (!check_admin_auth()) error_response('未登录', 401);
    $key = substr($path, strlen('/api/keys/'));
    $keys = load_keys();
    $filtered = array_values(array_filter($keys, fn($k) => $k['key'] !== $key));
    if (count($filtered) === count($keys)) error_response('密钥不存在', 404);
    save_keys($filtered);
    json_response(['ok' => true]);
}

// ─── 上传图片 ───

if ($method === 'POST' && $path === '/upload') {
    $token = get_auth_token();
    if (!$token || !is_valid_key($token)) {
        error_response('无效的上传密钥', 401);
    }

    if (!isset($_FILES['file'])) {
        error_response('未找到文件字段');
    }

    $file = $_FILES['file'];
    if ($file['error'] !== UPLOAD_ERR_OK) {
        error_response('上传错误: ' . $file['error']);
    }

    if ($file['size'] > MAX_FILE_SIZE) {
        error_response('文件过大，最大 ' . (MAX_FILE_SIZE / 1024 / 1024) . 'MB');
    }

    $mime = mime_content_type($file['tmp_name']);
    if (!isset(ALLOWED_TYPES[$mime])) {
        error_response('仅支持 PNG、JPEG、WebP 格式');
    }

    $ext = ALLOWED_TYPES[$mime];
    $filename = generate_filename($ext);
    $dest = UPLOADS_DIR . $filename;

    if (!is_dir(UPLOADS_DIR)) mkdir(UPLOADS_DIR, 0755, true);
    if (!move_uploaded_file($file['tmp_name'], $dest)) {
        error_response('保存文件失败', 500);
    }

    $base = get_base_url();
    json_response([
        'directUrl' => $base . '/images/' . $filename,
        'pageUrl'   => '',
        'filename'  => $filename,
    ]);
}

// ─── 删除图片 ───

if ($method === 'DELETE' && str_starts_with($path, '/file/')) {
    $token = get_auth_token();
    if (!$token || !is_valid_key($token)) {
        error_response('无效的上传密钥', 401);
    }

    $filename = basename(substr($path, strlen('/file/')));
    $filepath = UPLOADS_DIR . $filename;
    if (!file_exists($filepath)) error_response('文件不存在', 404);

    unlink($filepath);
    json_response(['ok' => true]);
}

// ─── 访问图片 ───

if ($method === 'GET' && str_starts_with($path, '/images/')) {
    $filename = basename(substr($path, strlen('/images/')));
    $filepath = UPLOADS_DIR . $filename;
    if (!file_exists($filepath)) {
        http_response_code(404);
        echo 'Not Found';
        exit;
    }

    $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
    $mime = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp'][$ext] ?? 'application/octet-stream';

    $size = filesize($filepath);
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . $size);
    header('Cache-Control: public, max-age=31536000');
    readfile($filepath);
    exit;
}

// ─── 404 ───

http_response_code(404);
echo 'Not Found';

// ═══════════════════════════════════════════
//  页面渲染
// ═══════════════════════════════════════════

function show_login_page() {
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>图床管理 - 登录</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:#fff;padding:32px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:320px}
h1{font-size:18px;margin-bottom:20px;text-align:center}
input{width:100%;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:14px;margin-bottom:12px}
button{width:100%;padding:10px;border:none;border-radius:8px;background:#333;color:#fff;font-size:14px;cursor:pointer}
button:hover{background:#555}
.error{color:#e44;font-size:13px;margin-bottom:8px;display:none}
</style>
</head>
<body>
<div class="login-box">
  <h1>🖨️ 图床管理</h1>
  <div class="error" id="err"></div>
  <input type="password" id="pwd" placeholder="管理密码" autofocus>
  <button onclick="doLogin()">登录</button>
</div>
<script>
document.getElementById('pwd').addEventListener('keydown', e => { if(e.key==='Enter') doLogin() });
async function doLogin() {
  const pwd = document.getElementById('pwd').value;
  const res = await fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:pwd})});
  if (res.ok) location.reload();
  else { const d = await res.json(); document.getElementById('err').textContent = d.error||'登录失败'; document.getElementById('err').style.display='block'; }
}
</script>
</body>
</html>
<?php
}

function show_admin_page() {
    $base = get_base_url();
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>图床管理</title>
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
.top-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.logout{color:#888;font-size:12px;cursor:pointer}
.logout:hover{color:#333}
</style>
</head>
<body>
<div class="container">
  <div class="top-bar">
    <div>
      <h1>🖨️ 图床管理</h1>
      <p class="subtitle">生成密钥后，在 WeChat Printer 图床设置中填入服务器地址和密钥即可使用。</p>
    </div>
    <span class="logout" onclick="fetch('/api/logout',{method:'POST'}).then(()=>location.reload())">退出登录</span>
  </div>

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
    <div class="server-url"><?= htmlspecialchars($base) ?></div>
    <p style="font-size:12px;color:#888">在 WeChat Printer → 设置 → 图床设置 → 选择「自定义图床」，填入上方地址和你生成的密钥。</p>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

async function loadKeys() {
  const res = await fetch('/api/keys');
  if (res.status === 401) { location.reload(); return; }
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
  stats.innerHTML = `<span>共 ${data.keys.length} 个密钥</span><span>${data.fileCount || 0} 张图片</span>`;
  list.innerHTML = data.keys.map(k => `
    <li>
      <div style="flex:1;margin-right:12px">
        <div class="key-value">${k.key}</div>
        <div class="key-meta">${k.note ? k.note + ' · ' : ''}创建于 ${new Date(k.createdAt).toLocaleString('zh-CN')}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="copyKey('${k.key}')">复制</button>
      <button class="btn btn-danger btn-sm" onclick="deleteKey('${k.key}')" style="margin-left:4px">删除</button>
    </li>
  `).join('');
}

async function generateKey() {
  const note = document.getElementById('noteInput').value.trim();
  const res = await fetch('/api/keys', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({note}) });
  const data = await res.json();
  if (data.key) {
    document.getElementById('noteInput').value = '';
    toast('密钥已生成');
    loadKeys();
  }
}

async function deleteKey(key) {
  if (!confirm('确定删除此密钥？')) return;
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
</html>
<?php
}
