const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const root = __dirname;
const server = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  env: { ...process.env, HOST, PORT: String(PORT) },
  stdio: 'inherit',
});

let opened = false;
const url = `http://${HOST}:${PORT}`;
const openBrowser = () => {
  if (opened) return;
  opened = true;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url] : [url];
  spawn(command, args, { stdio: 'ignore', shell: process.platform === 'win32', detached: true }).unref();
};

const probe = setInterval(() => {
  const request = http.get(url, (response) => {
    response.resume();
    clearInterval(probe);
    openBrowser();
  });
  request.on('error', () => {});
  request.setTimeout(400, () => request.destroy());
}, 100);

const stop = () => {
  clearInterval(probe);
  if (!server.killed) server.kill('SIGTERM');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
server.once('exit', (code, signal) => {
  clearInterval(probe);
  process.exit(code ?? (signal ? 1 : 0));
});
