const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');
const { printableText, unsupportedCharacters } = require('./printable-text');
const { telegramPrintNodes, telegramContentNodes, telegramQrAllowed } = require('./telegram-layout');
const { isSidExpired } = require('./print-response');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const TARGET_HOST = 'payapp.wechatpay.cn';
const DEFAULT_TELEGRAM_API = 'https://api.telegram.org';
const DEFAULT_IMAGE_HOST = 'imgchr';
const FFMPEG_COMMAND = process.env.WECHAT_PRINTER_FFMPEG || 'ffmpeg';
const FFPROBE_COMMAND = process.env.WECHAT_PRINTER_FFPROBE || 'ffprobe';
const STICKER_SIZE = 280;
const MAX_IMAGE_STRIPS = 10;
const DEFAULT_CACHE_EXPIRE_DAYS = 7;
const MAX_CACHE_EXPIRE_DAYS = 36500;
const DAY_MS = 24 * 60 * 60 * 1000;
const STICKER_CACHE_VERSION = 2;
const STICKER_CACHE_FILE = path.join(ROOT, '.sticker-cache.json');
const CACHE_META_KEY = '__meta';
const CACHE_PENDING_PREFIX = '__pending-delete:';
const CONFIG_FILE = path.join(ROOT, 'config.json');

function log(level, message, detail = '') {
  const suffix = detail ? ` | ${String(detail).replace(/\s+/g, ' ').trim()}` : '';
  const line = `[${new Date().toISOString()}] [${level}] ${message}${suffix}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

const DEFAULT_APP_CONFIG = {
  storageMode: 'browser',
  device: { sn: '', sid: '', accountType: 2 },
  telegram: {
    apiBase: DEFAULT_TELEGRAM_API, token: '',
    proxyEnabled: false, proxyUrl: '', maxPerMinute: 2, maxCharsPerTask: 0,
    rateLimitStrikeWindowMinutes: 1, rateLimitPenaltyMinutes: [2, 10, 1440], rateLimitBlacklistOnThird: false,
    blacklist: [], stickerEnabled: true,
    webmStickerEnabled: true, webmStickerFrame: 'penultimate', photoEnabled: true,
    reply_printing: '正在打印，请稍候。', reply_printed: '已打印。',
    reply_print_failed: '打印失败，请稍后重试。', reply_unsupported: '该消息类型不支持打印，请发送文字。',
    reply_rate_limited: '操作太频繁，请稍后再试。',
  },
  imageHost: { provider: DEFAULT_IMAGE_HOST, cacheExpireDays: DEFAULT_CACHE_EXPIRE_DAYS, deleteExpiredCache: false },
};

function normalizeAccountType(value, fallback = 2) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!text) return '';
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function mergeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const telegram = source.telegram && typeof source.telegram === 'object' ? source.telegram : {};
  const device = source.device && typeof source.device === 'object' ? source.device : {};
  const savedDevices = Array.isArray(source.savedDevices) ? source.savedDevices.filter((item) => item?.sn && item?.sid).map((item) => ({
    sn: String(item.sn),
    sid: String(item.sid),
    account_type: normalizeAccountType(item.account_type ?? item.accountType),
  })) : [];
  const sharedDevice = device.sn && device.sid ? device : savedDevices[0] || {};
  const { device_sn: _device_sn, deviceSn: _deviceSn, sid: _sid, accountType: _accountType, account_type: _account_type, ...telegramSettings } = telegram;
  return {
    storageMode: source.storageMode === 'local' ? 'local' : 'browser',
    device: { sn: String(sharedDevice.sn || ''), sid: String(sharedDevice.sid || ''), accountType: normalizeAccountType(sharedDevice.account_type ?? sharedDevice.accountType ?? device.account_type ?? device.accountType ?? savedDevices[0]?.account_type) },
    telegram: {
      ...DEFAULT_APP_CONFIG.telegram,
      ...telegramSettings,
      apiBase: String(telegram.apiBase || DEFAULT_TELEGRAM_API),
      token: String(telegram.token || ''), proxyEnabled: Boolean(telegram.proxyEnabled), proxyUrl: String(telegram.proxyUrl || ''),
      maxPerMinute: Number.isFinite(Number(telegram.maxPerMinute)) ? Math.max(0, Math.min(100, Math.floor(Number(telegram.maxPerMinute)))) : 2,
      maxCharsPerTask: Number.isFinite(Number(telegram.maxCharsPerTask)) ? Math.max(0, Math.min(4294967295, Math.floor(Number(telegram.maxCharsPerTask)))) : 0,
      rateLimitStrikeWindowMinutes: Number.isFinite(Number(telegram.rateLimitStrikeWindowMinutes)) ? Math.max(1, Math.min(1440, Math.floor(Number(telegram.rateLimitStrikeWindowMinutes)))) : 1,
      rateLimitPenaltyMinutes: Array.isArray(telegram.rateLimitPenaltyMinutes) ? [0, 1, 2].map((index) => Number.isFinite(Number(telegram.rateLimitPenaltyMinutes[index])) ? Math.max(0, Math.min(525600, Math.floor(Number(telegram.rateLimitPenaltyMinutes[index])))) : [2, 10, 1440][index]) : [2, 10, 1440],
      rateLimitBlacklistOnThird: telegram.rateLimitBlacklistOnThird === true,
      blacklist: Array.isArray(telegram.blacklist) ? telegram.blacklist.filter((item) => item && item.userId).map((item) => ({
        userId: String(item.userId), name: String(item.name || '未知用户'), username: String(item.username || ''),
        blockedUntil: item.blockedUntil === null ? null : Number(item.blockedUntil) || null,
        reason: String(item.reason || '多次触发频率限制'), strikes: Number(item.strikes) || 0, createdAt: Number(item.createdAt) || Date.now(),
      })) : [],
      stickerEnabled: telegram.stickerEnabled !== false,
      webmStickerEnabled: telegram.webmStickerEnabled !== false,
      webmStickerFrame: ['first', 'second', 'penultimate', 'last'].includes(telegram.webmStickerFrame) ? telegram.webmStickerFrame : 'penultimate',
      photoEnabled: telegram.photoEnabled !== false,
    },
    imageHost: imageHostConfig(source.imageHost || {}),
  };
}

function loadAppConfig() {
  try { return mergeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch { return mergeConfig(); }
}

function saveAppConfig(value) {
  const config = mergeConfig({ ...value, storageMode: 'local' });
  const temporaryFile = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryFile, CONFIG_FILE);
  return config;
}

function clearAppConfig() {
  try { fs.unlinkSync(CONFIG_FILE); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  appConfig = mergeConfig();
}

let appConfig = loadAppConfig();

function loadStickerCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STICKER_CACHE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const stickerCache = loadStickerCache();

function saveStickerCache() {
  try {
    const temporaryFile = `${STICKER_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(stickerCache, null, 2), 'utf8');
    fs.renameSync(temporaryFile, STICKER_CACHE_FILE);
  } catch {
    // Cache persistence is optional; a failed write must not block printing.
  }
}

function mediaCacheKey(media, variant = 'default', kind = 'sticker') {
  const id = media?.file_unique_id || media?.file_id;
  return id ? (kind === 'sticker' ? `${String(id)}:${variant}` : `${kind}:${String(id)}:${variant}`) : '';
}

function imageHostCacheScope(config) {
  const settings = imageHostConfig(config);
  return settings.provider === 'cfbed' ? `cfbed:${settings.baseUrl}` : DEFAULT_IMAGE_HOST;
}

function cacheEntryExpired(entry, settings, now = Date.now()) {
  return settings.cacheExpireDays > 0 && now - entry.createdAt >= settings.cacheExpireDays * DAY_MS;
}

function getCachedMediaEntry(key, config) {
  if (!key) return null;
  const entry = stickerCache[key];
  if (!entry?.directUrl || entry.processingVersion !== STICKER_CACHE_VERSION || !Number.isFinite(entry.createdAt)) return null;
  const settings = imageHostConfig(config);
  if (entry.cacheScope !== imageHostCacheScope(settings)) return null;
  return { key, entry, settings };
}

async function getCachedMedia(key, config) {
  const candidate = getCachedMediaEntry(key, config);
  if (!candidate) return null;
  if (cacheEntryExpired(candidate.entry, candidate.settings)) {
    queueExpiredCacheEntry(candidate);
    return null;
  }
  return { ...candidate.entry, cached: true };
}

function cacheRemotePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const decodePath = (pathValue) => { try { return decodeURIComponent(pathValue); } catch { return pathValue; } };
  try { return decodePath(new URL(raw).pathname).replace(/^\/+/, ''); } catch { return decodePath(raw.split(/[?#]/, 1)[0]).replace(/^\/+/, ''); }
}

function cfBedEntryRemotePath(entry) {
  return cacheRemotePath(entry.remotePath || entry.src || entry.directUrl);
}

function deletePermissionError(statusCode, message) {
  return statusCode === 401 || statusCode === 403 || /permission|forbidden|unauthorized|access denied|权限|未授权|禁止|无权/i.test(String(message || ''));
}

function queueExpiredCacheEntry(candidate) {
  const { key, entry, settings } = candidate;
  let changed = false;
  if (settings.provider === 'cfbed' && settings.deleteExpiredCache) {
    const remotePath = cfBedEntryRemotePath(entry);
    const alreadyQueued = remotePath && Object.values(stickerCache).some((value) => (
      value?.pendingDeletion === true
      && value.cacheScope === imageHostCacheScope(settings)
      && value.remotePath === remotePath
    ));
    if (remotePath && !alreadyQueued) {
      stickerCache[`${CACHE_PENDING_PREFIX}${Date.now()}:${Math.random().toString(36).slice(2)}`] = {
        directUrl: entry.directUrl,
        pageUrl: entry.pageUrl || '',
        createdAt: entry.createdAt,
        processingVersion: STICKER_CACHE_VERSION,
        cacheScope: imageHostCacheScope(settings),
        remotePath,
        pendingDeletion: true,
      };
      changed = true;
    }
  }
  if (stickerCache[key] === entry) {
    delete stickerCache[key];
    changed = true;
  }
  if (changed) saveStickerCache();
}

function imageHostCleanupStatus() {
  return {
    lastCheckAt: imageHostCleanupState.lastCheckAt,
    lastError: imageHostCleanupState.lastError,
    permissionDisabled: imageHostCleanupState.permissionDisabled,
    notice: imageHostCleanupState.notice,
  };
}

function disableExpiredCacheDeletion(message) {
  const settings = imageHostConfig(telegramState.imageHost);
  telegramState.imageHost = { ...settings, deleteExpiredCache: false };
  imageHostCleanupState.permissionDisabled = true;
  imageHostCleanupState.lastError = message;
  imageHostCleanupState.notice = `CloudFlare ImgBed API Token 未配置或没有 delete 权限，已自动关闭“自动删除过期图片”。请配置同时具有 upload 和 delete 权限的 Token 后重新开启。`;
  addTelegramLog('system', '已自动关闭过期图片删除', imageHostCleanupState.notice);
  if (appConfig.storageMode === 'local' && appConfig.imageHost?.provider === 'cfbed') {
    try { appConfig = saveAppConfig({ ...appConfig, imageHost: telegramState.imageHost }); } catch (error) { imageHostCleanupState.lastError = `${message}；自动保存关闭状态失败：${error.message}`; }
  }
}

async function deleteCfBedFiles(fileIds, config) {
  if (!fileIds.length) return { deleted: [], failed: [], permissionDenied: false };
  if (!config.token) {
    const error = '未配置 CloudFlare ImgBed API Token';
    return { deleted: [], failed: fileIds, permissionDenied: true, error };
  }
  const body = Buffer.from(JSON.stringify({ fileIds }));
  const target = new URL('/api/manage/delete/batch', `${config.baseUrl}/`);
  const response = await requestBuffer(target, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      Authorization: `Bearer ${config.token}`,
      'User-Agent': 'WeChatPrinter/1.0',
    },
  }, body);
  let result = {};
  try { result = JSON.parse(response.body.toString('utf8')); } catch { /* use HTTP status below */ }
  const message = result?.error || result?.message || `CloudFlare ImgBed 删除失败（HTTP ${response.statusCode}）`;
  const failed = Array.isArray(result?.failed) ? result.failed.map((item) => typeof item === 'string' ? { fileId: item, error: '' } : { fileId: item?.fileId, error: item?.error || '' }).filter((item) => item.fileId) : [];
  const deleted = Array.isArray(result?.deleted) ? result.deleted : response.statusCode >= 200 && response.statusCode < 300 && result?.success !== false ? fileIds : [];
  const permissionDenied = deletePermissionError(response.statusCode, message) || failed.some((item) => deletePermissionError(0, item.error));
  if (permissionDenied) return { deleted, failed, permissionDenied: true, error: message };
  if (response.statusCode < 200 || response.statusCode >= 300 || result?.success === false) return { deleted, failed, permissionDenied: false, error: message };
  return { deleted, failed, permissionDenied: false };
}

function expiredCacheEntries(settings, keys = null) {
  if (settings.provider !== 'cfbed') return [];
  const selectedKeys = keys ? new Set(keys.map((candidate) => candidate.key)) : null;
  return Object.entries(stickerCache)
    .filter(([key, entry]) => (
      (!selectedKeys || selectedKeys.has(key))
      && entry?.cacheScope === imageHostCacheScope(settings)
      && Number.isFinite(entry.createdAt)
      && (entry.pendingDeletion === true || cacheEntryExpired(entry, settings))
    ))
    .map(([key, entry]) => ({ key, entry, settings }));
}

async function removeExpiredCacheEntries(config, candidates = null) {
  const settings = imageHostConfig(config);
  const entries = candidates || expiredCacheEntries(settings);
  if (!entries.length) return { blocked: false, deleted: 0 };
  if (!settings.deleteExpiredCache) {
    let deleted = 0;
    entries.forEach(({ key, entry }) => { if (stickerCache[key] === entry) { delete stickerCache[key]; deleted += 1; } });
    if (deleted) saveStickerCache();
    return { blocked: false, deleted };
  }
  const remoteEntries = entries.map((candidate) => ({ ...candidate, remotePath: cfBedEntryRemotePath(candidate.entry) })).filter((candidate) => candidate.remotePath);
  const deletablePaths = [...new Set(remoteEntries.map((candidate) => candidate.remotePath))];
  const deletions = new Map();
  let failure = '';
  for (let offset = 0; offset < deletablePaths.length; offset += 500) {
    const result = await deleteCfBedFiles(deletablePaths.slice(offset, offset + 500), settings);
    if (result.permissionDenied) {
      disableExpiredCacheDeletion(result.error || '删除接口拒绝访问');
      return { blocked: true, error: imageHostCleanupState.notice };
    }
    result.deleted.forEach((fileId) => deletions.set(fileId, true));
    if (result.failed.length || result.error) failure = result.error || '部分过期图片删除失败';
  }
  const remotePathByKey = new Map(remoteEntries.map((candidate) => [candidate.key, candidate.remotePath]));
  const removable = entries.filter((candidate) => {
    const remotePath = remotePathByKey.get(candidate.key);
    return !remotePath || deletions.has(remotePath);
  });
  let deleted = 0;
  removable.forEach(({ key, entry }) => { if (stickerCache[key] === entry) { delete stickerCache[key]; deleted += 1; } });
  if (deleted) saveStickerCache();
  if (failure) return { blocked: true, error: failure };
  return { blocked: false, deleted };
}

async function runExpiredCacheCleanup(config = telegramState.imageHost) {
  imageHostCleanupState.lastCheckAt = Date.now();
  imageHostCleanupState.lastError = '';
  const settings = imageHostConfig(config);
  const hasPendingDeletion = expiredCacheEntries(settings).some(({ entry }) => entry.pendingDeletion === true);
  if (settings.provider !== 'cfbed' || !settings.deleteExpiredCache || (settings.cacheExpireDays === 0 && !hasPendingDeletion)) return { blocked: false, deleted: 0 };
  let result;
  try { result = await removeExpiredCacheEntries(settings); } catch (error) { result = { blocked: true, error: error.message }; }
  if (result.blocked) imageHostCleanupState.lastError = result.error || '';
  else imageHostCleanupState.notice = result.deleted ? `已删除 ${result.deleted} 个过期 CloudFlare ImgBed 文件。` : '';
  return result;
}

function localDateKey(date = new Date()) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value) => String(value).padStart(2, '0'))
    .join('-');
}

function cleanupScope(settings) {
  return `${imageHostCacheScope(settings)}:${settings.cacheExpireDays}:${settings.deleteExpiredCache ? 'delete' : 'keep'}`;
}

function cleanupAlreadyDoneToday(settings) {
  const meta = stickerCache[CACHE_META_KEY];
  const done = meta?.lastCleanupDate === localDateKey() && meta.lastCleanupScope === cleanupScope(settings);
  if (done && Number.isFinite(meta.lastCleanupAt)) imageHostCleanupState.lastCheckAt = meta.lastCleanupAt;
  return done;
}

function markCleanupDone(settings) {
  stickerCache[CACHE_META_KEY] = {
    lastCleanupDate: localDateKey(),
    lastCleanupScope: cleanupScope(settings),
    lastCleanupAt: Date.now(),
  };
  saveStickerCache();
}

let imageHostCleanupRun = null;

async function runScheduledCacheCleanup(config = telegramState.imageHost) {
  const settings = imageHostConfig(config);
  if (settings.provider !== 'cfbed' || !settings.deleteExpiredCache) return { blocked: false, deleted: 0, skipped: true };
  const hasPendingDeletion = expiredCacheEntries(settings).some(({ entry }) => entry.pendingDeletion === true);
  if (settings.cacheExpireDays === 0 && !hasPendingDeletion) return { blocked: false, deleted: 0, skipped: true };
  if (cleanupAlreadyDoneToday(settings)) return { blocked: false, deleted: 0, skipped: true };
  if (imageHostCleanupRun) return imageHostCleanupRun;

  const run = (async () => {
    let result;
    try { result = await runExpiredCacheCleanup(settings); } catch (error) { result = { blocked: true, error: error.message }; }
    if (result.blocked) imageHostCleanupState.lastError = result.error || '';
    markCleanupDone(settings);
    return result;
  })();
  imageHostCleanupRun = run;
  try { return await run; } finally {
    if (imageHostCleanupRun === run) imageHostCleanupRun = null;
  }
}

function resetImageHostCleanupStatus() {
  imageHostCleanupState.lastCheckAt = 0;
  imageHostCleanupState.lastError = '';
  imageHostCleanupState.permissionDisabled = false;
  imageHostCleanupState.notice = '';
}

function applyImageHostSettings(config) {
  const settings = imageHostConfig(config);
  const preservePermissionNotice = imageHostCleanupState.permissionDisabled
    && settings.provider === 'cfbed'
    && settings.deleteExpiredCache === false;
  telegramState.imageHost = settings;
  if (!preservePermissionNotice) resetImageHostCleanupStatus();
  return settings;
}

function scheduleImageHostCleanup() {
  if (imageHostCleanupTimer) clearTimeout(imageHostCleanupTimer);
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  imageHostCleanupTimer = setTimeout(async () => {
    try { await runScheduledCacheCleanup(telegramState.imageHost); } catch (error) { imageHostCleanupState.lastError = error.message; }
    scheduleImageHostCleanup();
  }, Math.max(1000, next.getTime() - now.getTime()));
}

function cacheMedia(key, hosted, config) {
  if (!key || !hosted?.directUrl) return;
  stickerCache[key] = {
    directUrl: hosted.directUrl,
    pageUrl: hosted.pageUrl || '',
    createdAt: Date.now(),
    processingVersion: STICKER_CACHE_VERSION,
    cacheScope: imageHostCacheScope(config),
    remotePath: hosted.remotePath || '',
  };
  saveStickerCache();
}

const telegramState = {
  running: false,
  token: '',
  offset: 0,
  sid: '',
  deviceSn: '',
  accountType: 2,
  apiBase: DEFAULT_TELEGRAM_API,
  proxyUrl: '',
  maxPerMinute: 2,
  maxCharsPerTask: 0,
  rateLimitStrikeWindowMinutes: 1,
  rateLimitPenaltyMinutes: [2, 10, 1440],
  rateLimitBlacklistOnThird: false,
  stickerEnabled: true,
  webmStickerEnabled: true,
  webmStickerFrame: 'penultimate',
  photoEnabled: true,
  replyPrinting: '正在打印，请稍候。',
  replyPrinted: '已打印。',
  replyPrintFailed: '打印失败，请稍后重试。',
  replyUnsupported: '该消息类型不支持打印，请发送文字。',
  replyRateLimited: '操作太频繁，请稍后再试。',
  logs: [],
  userTasks: new Map(),
  rateLimitStrikes: new Map(),
  blacklist: new Map(appConfig.telegram.blacklist.map((entry) => [entry.userId, entry])),
  printQueue: [],
  printFlushTimer: null,
  lastMessage: '',
  error: '',
  retryCount: 0,
  generation: 0,
  imageHost: appConfig.imageHost,
};
const imageHostCleanupState = {
  lastCheckAt: 0,
  lastError: '',
  permissionDisabled: false,
  notice: '',
};
let imageHostCleanupTimer = null;
const MAX_TELEGRAM_LOGS = 200;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readRequestBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requestBuffer(target, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.setTimeout(30_000, () => request.destroy(new Error('图床请求超时')));
    if (body) request.write(body);
    request.end();
  });
}

function extractImgchrToken(html) {
  const match = String(html).match(/auth_token\s*=\s*["']([^"']+)["']/i);
  return match?.[1] || '';
}

function appendMultipartField(parts, boundary, name, value) {
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
}

function appendMultipartFile(parts, boundary, name, filename, mime, data) {
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(data);
  parts.push(Buffer.from('\r\n'));
}

async function uploadToImgchr(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=]+)$/i);
  if (!match) throw new Error('只支持 PNG、JPEG 或 WebP 图片');
  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const imageData = Buffer.from(match[2], 'base64');
  if (!imageData.length || imageData.length > 8 * 1024 * 1024) throw new Error('图片大小必须在 8MB 以内');

  const landing = await requestBuffer(new URL('https://imgchr.com/'), { method: 'GET', headers: { 'User-Agent': 'WeChatPrinter/1.0' } });
  if (landing.statusCode < 200 || landing.statusCode >= 300) throw new Error(`无法连接 Imgchr（HTTP ${landing.statusCode}）`);
  const token = extractImgchrToken(landing.body.toString('utf8'));
  if (!token) throw new Error('Imgchr 未返回上传授权信息');
  const cookie = Array.isArray(landing.headers['set-cookie']) ? landing.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ') : '';
  const boundary = `----WeChatPrinter${Date.now().toString(16)}`;
  const parts = [];
  appendMultipartFile(parts, boundary, 'source', `receipt.${extension}`, mime, imageData);
  appendMultipartField(parts, boundary, 'type', 'file');
  appendMultipartField(parts, boundary, 'action', 'upload');
  appendMultipartField(parts, boundary, 'privacy', '0');
  appendMultipartField(parts, boundary, 'timestamp', `${Date.now()}`);
  appendMultipartField(parts, boundary, 'auth_token', token);
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const uploaded = await requestBuffer(new URL('https://imgchr.com/json'), {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, 'User-Agent': 'WeChatPrinter/1.0', ...(cookie ? { Cookie: cookie } : {}) },
  }, body);
  let result;
  try { result = JSON.parse(uploaded.body.toString('utf8')); } catch { throw new Error('Imgchr 返回了无法解析的响应'); }
  const directUrl = result?.image?.url || result?.image?.image?.url || result?.success?.image?.url;
  const pageUrl = result?.image?.url_viewer || result?.image?.url_short || '';
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300 || !directUrl) throw new Error(result?.error?.message || result?.status_txt || `Imgchr 上传失败（HTTP ${uploaded.statusCode}）`);
  return { directUrl, pageUrl };
}

function normalizeImageHostBase(value) {
  const target = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('CloudFlare ImgBed 地址只支持 HTTP 或 HTTPS');
  if (target.username || target.password) throw new Error('CloudFlare ImgBed 地址不能包含用户名或密码');
  if (target.search || target.hash) throw new Error('CloudFlare ImgBed 地址不能包含查询参数或锚点');
  target.pathname = target.pathname.replace(/\/+$/, '');
  return target.toString().replace(/\/$/, '');
}

function normalizeCacheExpireDays(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_CACHE_EXPIRE_DAYS;
  const days = Number(value);
  return Number.isFinite(days) ? Math.max(0, Math.min(MAX_CACHE_EXPIRE_DAYS, Math.floor(days))) : DEFAULT_CACHE_EXPIRE_DAYS;
}

function normalizeCustomImageHostBase(value) {
  const target = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('自定义图床地址只支持 HTTP 或 HTTPS');
  if (target.username || target.password) throw new Error('自定义图床地址不能包含用户名或密码');
  if (target.search || target.hash) throw new Error('自定义图床地址不能包含查询参数或锚点');
  target.pathname = target.pathname.replace(/\/+$/, '');
  return target.toString().replace(/\/$/, '');
}

function imageHostConfig(value = {}) {
  const provider = value.provider === 'cfbed' ? 'cfbed' : value.provider === 'custom' ? 'custom' : DEFAULT_IMAGE_HOST;
  if (provider === DEFAULT_IMAGE_HOST) return { provider, cacheExpireDays: DEFAULT_CACHE_EXPIRE_DAYS, deleteExpiredCache: false };
  if (provider === 'custom') {
    const baseUrl = normalizeCustomImageHostBase(value.baseUrl);
    const token = String(value.token || '').trim();
    if (!token) throw new Error('自定义图床密钥不能为空');
    return { provider, baseUrl, token, cacheExpireDays: normalizeCacheExpireDays(value.cacheExpireDays), deleteExpiredCache: false };
  }
  const baseUrl = normalizeImageHostBase(value.baseUrl);
  const token = String(value.token || '').trim();
  const authCode = String(value.authCode || '').trim();
  const uploadChannel = String(value.uploadChannel || '').trim();
  return { provider, baseUrl, token, authCode, uploadChannel, cacheExpireDays: normalizeCacheExpireDays(value.cacheExpireDays), deleteExpiredCache: value.deleteExpiredCache === true };
}

function cacheHitDetail(config) {
  const days = imageHostConfig(config).cacheExpireDays;
  return days === 0 ? '命中永久缓存，复用图片直链' : `命中 ${days} 天缓存，复用图片直链`;
}

async function uploadToCfBed(dataUrl, config) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=]+)$/i);
  if (!match) throw new Error('只支持 PNG、JPEG 或 WebP 图片');
  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const imageData = Buffer.from(match[2], 'base64');
  if (!imageData.length || imageData.length > 20 * 1024 * 1024) throw new Error('图片大小必须在 20MB 以内');

  const query = new URLSearchParams({ returnFormat: 'full' });
  if (config.authCode) query.set('authCode', config.authCode);
  if (config.uploadChannel) query.set('uploadChannel', config.uploadChannel);
  const boundary = `----WeChatPrinterCfBed${Date.now().toString(16)}`;
  const parts = [];
  appendMultipartFile(parts, boundary, 'file', `receipt.${extension}`, mime, imageData);
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const headers = {
    Accept: 'application/json',
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length,
    'User-Agent': 'WeChatPrinter/1.0',
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const uploaded = await requestBuffer(new URL(`/upload?${query.toString()}`, `${config.baseUrl}/`), { method: 'POST', headers }, body);
  let result;
  try { result = JSON.parse(uploaded.body.toString('utf8')); } catch { throw new Error('CloudFlare ImgBed 返回了无法解析的响应'); }
  const item = Array.isArray(result) ? result[0] : result;
  let directUrl = item?.publicUrl || item?.url || item?.src;
  if (directUrl && !/^https?:\/\//i.test(directUrl)) directUrl = new URL(directUrl, `${config.baseUrl}/`).toString();
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300 || !directUrl) {
    const message = result?.message || result?.error || item?.message || `CloudFlare ImgBed 上传失败（HTTP ${uploaded.statusCode}）`;
    throw new Error(message);
  }
  return { directUrl, pageUrl: directUrl, remotePath: cacheRemotePath(item?.src || directUrl) };
}

async function uploadToCustom(dataUrl, config) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=]+)$/i);
  if (!match) throw new Error('只支持 PNG、JPEG 或 WebP 图片');
  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const imageData = Buffer.from(match[2], 'base64');
  if (!imageData.length || imageData.length > 10 * 1024 * 1024) throw new Error('图片大小必须在 10MB 以内');

  const boundary = `----WeChatPrinterCustom${Date.now().toString(16)}`;
  const parts = [];
  appendMultipartFile(parts, boundary, 'file', `receipt.${extension}`, mime, imageData);
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const headers = {
    Accept: 'application/json',
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length,
    'User-Agent': 'WeChatPrinter/1.0',
    Authorization: `Bearer ${config.token}`,
  };
  const uploaded = await requestBuffer(new URL('/upload', `${config.baseUrl}/`), { method: 'POST', headers }, body);
  let result;
  try { result = JSON.parse(uploaded.body.toString('utf8')); } catch { throw new Error('自定义图床返回了无法解析的响应'); }
  const directUrl = result?.directUrl || result?.url || result?.src;
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300 || !directUrl) {
    throw new Error(result?.error || `自定义图床上传失败（HTTP ${uploaded.statusCode}）`);
  }
  return { directUrl, pageUrl: result?.pageUrl || '' };
}

async function uploadHostedImage(dataUrl, config = {}) {
  const settings = imageHostConfig(config);
  if (settings.provider === 'cfbed') return uploadToCfBed(dataUrl, settings);
  if (settings.provider === 'custom') return uploadToCustom(dataUrl, settings);
  return uploadToImgchr(dataUrl);
}

async function imageHostUpload(req, res) {
  try {
    const raw = await readRequestBody(req, 12 * 1024 * 1024);
    const payload = JSON.parse(raw.toString('utf8') || '{}');
    const result = await uploadHostedImage(payload.dataUrl, payload.settings || payload.imageHost);
    log('INFO', '图片上传完成', `${imageHostConfig(payload.settings || payload.imageHost).provider}，${raw.length} bytes 请求体`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  } catch (error) {
    log('ERROR', '图片上传失败', error.message);
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function setImageHostSettings(req, res) {
  try {
    const raw = await readRequestBody(req, 64 * 1024);
    applyImageHostSettings(JSON.parse(raw.toString('utf8') || '{}'));
    await runScheduledCacheCleanup(telegramState.imageHost);
    log('INFO', '图床设置已更新', telegramState.imageHost.provider);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      provider: telegramState.imageHost.provider,
      baseUrl: telegramState.imageHost.baseUrl || '',
      uploadChannel: telegramState.imageHost.uploadChannel || '',
      cacheExpireDays: telegramState.imageHost.cacheExpireDays,
      deleteExpiredCache: telegramState.imageHost.deleteExpiredCache,
      cleanup: imageHostCleanupStatus(),
    }));
  } catch (error) {
    log('ERROR', '图床设置更新失败', error.message);
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

function getAppConfig(res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(appConfig));
}

async function updateAppConfig(req, res) {
  try {
    const raw = await readRequestBody(req, 256 * 1024);
    appConfig = saveAppConfig(JSON.parse(raw.toString('utf8') || '{}'));
    applyImageHostSettings(appConfig.imageHost);
    await runScheduledCacheCleanup(telegramState.imageHost);
    log('INFO', '本地配置已保存');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ saved: true, config: appConfig }));
  } catch (error) {
    log('ERROR', '本地配置保存失败', error.message);
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

function deleteAppConfig(res) {
  try {
    clearAppConfig();
    applyImageHostSettings(appConfig.imageHost);
    log('WARN', '本地配置已清除');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ cleared: true }));
  } catch (error) {
    log('ERROR', '本地配置清除失败', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    const type = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(content);
  });
}

function forwardPrint(sid, body, callback) {
  const proxyReq = https.request({
      hostname: TARGET_HOST,
      path: `/smartqr/printerad/printad?sid=${encodeURIComponent(sid)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
  }, (proxyRes) => {
      const responseChunks = [];
      proxyRes.on('data', (chunk) => responseChunks.push(chunk));
      proxyRes.on('end', () => {
        callback(null, proxyRes.statusCode || 502, proxyRes.headers, Buffer.concat(responseChunks));
      });
  });
  proxyReq.on('error', callback);
  proxyReq.end(body);
}

function sanitizePrintPayload(body) {
  try {
    const payload = JSON.parse(body.toString('utf8'));
    const root = payload?.ad_content?.user_define_template?.root;
    if (!Array.isArray(root)) return body;
    root.forEach((node) => {
      node?.text?.column?.forEach((column) => {
        if (typeof column?.value === 'string') column.value = printableText(column.value);
      });
      node?.content?.lines?.linelist?.forEach((line) => {
        if (Array.isArray(line?.column)) line.column = line.column.map((value) => typeof value === 'string' ? printableText(value) : value);
      });
      if (node?.icon?.type === 1 && typeof node.icon.value === 'string') node.icon.value = printableText(node.icon.value);
    });
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}

function proxyPrint(req, res, requestUrl) {
  const sid = requestUrl.searchParams.get('sid');
  if (!sid) {
    log('WARN', '打印请求被拒绝', '缺少 sid');
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'sid is required' }));
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = sanitizePrintPayload(Buffer.concat(chunks));
    log('INFO', '打印请求已转发', `${body.length} bytes -> ${TARGET_HOST}`);
    forwardPrint(sid, body, (error, statusCode, headers, responseBody) => {
      if (error) {
        log('ERROR', '打印接口请求失败', error.message);
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      log(statusCode >= 200 && statusCode < 300 ? 'INFO' : 'WARN', '打印接口已返回', `HTTP ${statusCode}，${responseBody.length} bytes`);
      res.writeHead(statusCode, { 'Content-Type': headers['content-type'] || 'application/json; charset=utf-8' });
      res.end(responseBody);
    });
  });
}

function normalizeTelegramApiBase(value) {
  const target = new URL(String(value || DEFAULT_TELEGRAM_API).trim());
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Telegram API 地址只支持 HTTP 或 HTTPS');
  if (target.username || target.password) throw new Error('Telegram API 地址不能包含用户名或密码');
  if (target.search || target.hash) throw new Error('Telegram API 地址不能包含查询参数或锚点');
  target.pathname = target.pathname.replace(/\/+$/, '');
  return target.toString().replace(/\/$/, '');
}

function normalizeTelegramProxy(value) {
  if (!value) return '';
  const target = new URL(String(value).trim());
  if (target.protocol !== 'http:') throw new Error('HTTP 代理地址必须使用 http://');
  if (!target.hostname) throw new Error('HTTP 代理地址缺少主机名');
  if (target.pathname !== '/' || target.search || target.hash) throw new Error('HTTP 代理地址只能包含协议、主机、端口和可选账号密码');
  return target.toString().replace(/\/$/, '');
}

function proxyAuthorization(proxy) {
  return proxy.username || proxy.password ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : undefined;
}

function collectTelegramResponse(request, resolve, reject) {
  request.on('timeout', () => request.destroy(new Error('Telegram 请求超时')));
  request.on('error', reject);
  request.on('response', (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!result.ok) reject(new Error(result.description || `Telegram API ${response.statusCode}`));
        else resolve(result.result);
      } catch (error) { reject(error); }
    });
  });
}

function telegramRequest(apiBase, token, method, params, timeoutMs = 50000, proxyUrl = '') {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(params || {}));
    const endpoint = new URL(`${apiBase}/bot${token}/${method}`);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': body.length };
    if (!proxyUrl) {
      const transport = endpoint.protocol === 'https:' ? https : http;
      const request = transport.request(endpoint, { method: 'POST', headers, timeout: timeoutMs });
      collectTelegramResponse(request, resolve, reject);
      request.end(body);
      return;
    }

    const proxy = new URL(proxyUrl);
    const auth = proxyAuthorization(proxy);
    if (endpoint.protocol === 'http:') {
      const proxyHeaders = { ...headers, Host: endpoint.host };
      if (auth) proxyHeaders['Proxy-Authorization'] = auth;
      const request = http.request({ hostname: proxy.hostname, port: proxy.port || 80, method: 'POST', path: endpoint.href, headers: proxyHeaders, timeout: timeoutMs });
      collectTelegramResponse(request, resolve, reject);
      request.end(body);
      return;
    }

    const connectHeaders = { Host: `${endpoint.hostname}:${endpoint.port || 443}` };
    if (auth) connectHeaders['Proxy-Authorization'] = auth;
    const connect = http.request({ hostname: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: `${endpoint.hostname}:${endpoint.port || 443}`, headers: connectHeaders, timeout: timeoutMs });
    connect.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`HTTP 代理 CONNECT 失败：${response.statusCode || '无状态码'}`));
        return;
      }
      const secureSocket = tls.connect({ socket, servername: endpoint.hostname });
      if (head?.length) secureSocket.unshift(head);
      const request = https.request({ hostname: endpoint.hostname, port: endpoint.port || 443, path: `${endpoint.pathname}${endpoint.search}`, method: 'POST', headers, createConnection: () => secureSocket, timeout: timeoutMs });
      collectTelegramResponse(request, resolve, reject);
      request.end(body);
    });
    connect.on('error', reject);
    connect.on('timeout', () => connect.destroy(new Error('HTTP 代理请求超时')));
    connect.end();
  });
}

function characterWidth(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint > 0xff || /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uff01-\uff60\uffe0-\uffe6]/u.test(character)) return 2;
  if (character === '8') return 1.45;
  if (/[MWmw@#%&]/.test(character)) return 1.4;
  if (/[1\s.,:;!'`|iIl\[\]()]/.test(character)) return 1;
  return 1.2;
}

function splitTextIntoLines(text, capacity = 32) {
  const lines = [];
  String(text).replace(/\r\n/g, '\n').split('\n').forEach((paragraph) => {
    let line = '';
    let width = 0;
    for (const character of Array.from(paragraph)) {
      const nextWidth = characterWidth(character);
      if (line && width + nextWidth > capacity) {
        lines.push(line);
        line = '';
        width = 0;
      }
      line += character;
      width += nextWidth;
    }
    if (line || !paragraph) lines.push(line);
  });
  return lines.length ? lines : [''];
}

function telegramFileUrl(filePath) {
  return `${telegramState.apiBase}/file/bot${telegramState.token}/${filePath}`;
}

function downloadTelegramBuffer(target, proxyUrl = '') {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(target);
    const finishResponse = (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadTelegramBuffer(new URL(response.headers.location, requestUrl).toString(), proxyUrl).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Telegram 文件下载失败（HTTP ${response.statusCode || 0}）`));
        return;
      }
      const chunks = [];
      let size = 0;
      let failed = false;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) {
          failed = true;
          response.destroy();
          reject(new Error('Telegram 文件过大'));
        }
        else chunks.push(chunk);
      });
      response.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    };

    if (!proxyUrl) {
      const transport = requestUrl.protocol === 'https:' ? https : http;
      const request = transport.get(requestUrl, { timeout: 30_000 }, finishResponse);
      request.on('timeout', () => request.destroy(new Error('Telegram 文件下载超时')));
      request.on('error', reject);
      return;
    }

    const proxy = new URL(proxyUrl);
    const auth = proxyAuthorization(proxy);
    if (requestUrl.protocol === 'http:') {
      const headers = { Host: requestUrl.host, ...(auth ? { 'Proxy-Authorization': auth } : {}) };
      const request = http.get({ hostname: proxy.hostname, port: proxy.port || 80, path: requestUrl.href, headers, timeout: 30_000 }, finishResponse);
      request.on('timeout', () => request.destroy(new Error('Telegram 文件下载超时')));
      request.on('error', reject);
      return;
    }

    const connectHeaders = { Host: `${requestUrl.hostname}:${requestUrl.port || 443}`, ...(auth ? { 'Proxy-Authorization': auth } : {}) };
    const connect = http.request({ hostname: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: `${requestUrl.hostname}:${requestUrl.port || 443}`, headers: connectHeaders, timeout: 30_000 });
    connect.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`HTTP 代理 CONNECT 失败：${response.statusCode || '无状态码'}`));
        return;
      }
      const secureSocket = tls.connect({ socket, servername: requestUrl.hostname });
      if (head?.length) secureSocket.unshift(head);
      const request = https.get({ hostname: requestUrl.hostname, port: requestUrl.port || 443, path: `${requestUrl.pathname}${requestUrl.search}`, createConnection: () => secureSocket, timeout: 30_000 }, finishResponse);
      request.on('timeout', () => request.destroy(new Error('Telegram 文件下载超时')));
      request.on('error', reject);
    });
    connect.on('timeout', () => connect.destroy(new Error('HTTP 代理请求超时')));
    connect.on('error', reject);
    connect.end();
  });
}

function runFfmpeg(args, input, errorLabel) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_COMMAND, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', (error) => fail(new Error(`无法调用 FFmpeg：${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`${errorLabel}：${Buffer.concat(errors).toString('utf8').trim() || `FFmpeg ${code}`}`));
        return;
      }
      settled = true;
      resolve(Buffer.concat(output));
    });
    child.stdin.end(input);
  });
}

function probeVideoFrameCount(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE_COMMAND, [
      '-v', 'error',
      '-count_frames',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames,nb_frames',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      '-i', 'pipe:0',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', (error) => fail(new Error(`无法调用 FFprobe：${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`无法读取 WebM sticker 帧数：${Buffer.concat(errors).toString('utf8').trim() || `FFprobe ${code}`}`));
        return;
      }
      const count = Buffer.concat(output).toString('utf8').split(/\s+/).map((value) => Number(value)).find((value) => Number.isInteger(value) && value > 0);
      if (!count) {
        fail(new Error('无法读取 WebM sticker 帧数'));
        return;
      }
      settled = true;
      resolve(count);
    });
    child.stdin.end(input);
  });
}

function selectedStickerFrameIndex(frameCount, frameMode) {
  if (frameMode === 'second') return Math.min(1, frameCount - 1);
  if (frameMode === 'last') return frameCount - 1;
  if (frameMode === 'penultimate') return Math.max(0, frameCount - 2);
  return 0;
}

function applyFloydSteinberg(buffer, width, height) {
  const grayscale = new Float32Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const alpha = buffer[offset + 3] / 255;
    grayscale[index] = (buffer[offset] * 0.299 + buffer[offset + 1] * 0.587 + buffer[offset + 2] * 0.114) * alpha + 255 * (1 - alpha);
  }
  const addError = (x, y, amount) => {
    if (x >= 0 && x < width && y >= 0 && y < height) grayscale[y * width + x] += amount;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const oldValue = grayscale[index];
      const newValue = oldValue < 128 ? 0 : 255;
      const error = oldValue - newValue;
      grayscale[index] = newValue;
      addError(x + 1, y, error * 7 / 16);
      addError(x - 1, y + 1, error * 3 / 16);
      addError(x, y + 1, error * 5 / 16);
      addError(x + 1, y + 1, error / 16);
      const offset = index * 4;
      buffer[offset] = newValue;
      buffer[offset + 1] = newValue;
      buffer[offset + 2] = newValue;
      buffer[offset + 3] = 255;
    }
  }
  return buffer;
}

async function renderTelegramImage(input, filterPrefix, errorLabel) {
  const imageFilter = `${filterPrefix || ''}scale=${STICKER_SIZE}:-2:flags=lanczos,setsar=1`;
  const rgba = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', imageFilter, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], input, errorLabel);
  const rawBytes = STICKER_SIZE * 4;
  if (rgba.length < rawBytes) throw new Error('Telegram 图片处理结果不完整');
  const actualHeight = Math.floor(rgba.length / (STICKER_SIZE * 4));
  if (actualHeight < 1) throw new Error('Telegram 图片处理结果不完整');
  const fullBinarized = applyFloydSteinberg(Buffer.from(rgba.subarray(0, STICKER_SIZE * actualHeight * 4)), STICKER_SIZE, actualHeight);
  const strips = [];
  const stripCount = Math.max(1, Math.ceil(actualHeight / STICKER_SIZE));
  for (let i = 0; i < stripCount && i < MAX_IMAGE_STRIPS; i++) {
    const yStart = i * STICKER_SIZE;
    const stripHeight = Math.min(STICKER_SIZE, actualHeight - yStart);
    const stripBuf = Buffer.alloc(STICKER_SIZE * STICKER_SIZE * 4, 255);
    for (let row = 0; row < stripHeight; row++) {
      const srcOffset = ((yStart + row) * STICKER_SIZE) * 4;
      const dstOffset = row * STICKER_SIZE * 4;
      fullBinarized.copy(stripBuf, dstOffset, srcOffset, srcOffset + STICKER_SIZE * 4);
    }
    const jpg = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${STICKER_SIZE}x${STICKER_SIZE}`, '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '2', 'pipe:1'], stripBuf, 'Telegram 图片 JPEG 编码失败');
    strips.push(jpg);
  }
  return strips;
}

async function processTelegramSticker(sticker, options = {}) {
  const fileId = sticker?.file_id;
  if (!fileId) throw new Error('sticker 缺少 file_id');
  const file = await telegramRequest(telegramState.apiBase, telegramState.token, 'getFile', { file_id: fileId }, 15_000, telegramState.proxyUrl);
  const filePath = String(file?.file_path || '');
  const extension = filePath.toLowerCase().split('.').pop();
  if (extension === 'webm') {
    if (options.webmEnabled === false) {
      const error = new Error('WebM sticker 打印已关闭');
      error.code = 'UNSUPPORTED_STICKER';
      throw error;
    }
  }
  if (extension !== 'webp' && extension !== 'webm') {
    const error = new Error(`不支持的 sticker 格式：${extension || 'unknown'}`);
    error.code = 'UNSUPPORTED_STICKER';
    throw error;
  }
  const cacheVariant = extension === 'webm' ? `webm:${options.webmFrame || 'penultimate'}` : 'webp';
  const cacheKey = mediaCacheKey(sticker, cacheVariant);
  const cached = await getCachedMedia(cacheKey, telegramState.imageHost);
  if (cached) return cached;
  const input = await downloadTelegramBuffer(telegramFileUrl(filePath), telegramState.proxyUrl);
  let frameIndex = 0;
  if (extension === 'webm') {
    const frameCount = await probeVideoFrameCount(input);
    frameIndex = selectedStickerFrameIndex(frameCount, options.webmFrame || 'penultimate');
  }
  const frameFilter = extension === 'webm' ? `select=eq(n\\,${frameIndex}),` : '';
  const strips = await renderTelegramImage(input, frameFilter, `${extension.toUpperCase()} sticker 解码失败`);
  const uploadedStrips = [];
  for (const jpg of strips) {
    const dataUrl = `data:image/jpeg;base64,${jpg.toString('base64')}`;
    const hosted = await uploadHostedImage(dataUrl, telegramState.imageHost);
    uploadedStrips.push(hosted.directUrl);
  }
  const result = { directUrl: uploadedStrips[0], pageUrl: '', stripUrls: uploadedStrips };
  cacheMedia(cacheKey, result, telegramState.imageHost);
  return result;
}

async function processTelegramPhoto(photo) {
  const fileId = photo?.file_id;
  if (!fileId) throw new Error('Telegram 图片缺少 file_id');
  const cacheKey = mediaCacheKey(photo, 'photo', 'photo');
  const cached = await getCachedMedia(cacheKey, telegramState.imageHost);
  if (cached) return cached;
  const file = await telegramRequest(telegramState.apiBase, telegramState.token, 'getFile', { file_id: fileId }, 15_000, telegramState.proxyUrl);
  const filePath = String(file?.file_path || '');
  if (!filePath) throw new Error('Telegram 图片缺少文件路径');
  const input = await downloadTelegramBuffer(telegramFileUrl(filePath), telegramState.proxyUrl);
  const strips = await renderTelegramImage(input, '', 'Telegram 图片解码失败');
  const uploadedStrips = [];
  for (const jpg of strips) {
    const dataUrl = `data:image/jpeg;base64,${jpg.toString('base64')}`;
    const hosted = await uploadHostedImage(dataUrl, telegramState.imageHost);
    uploadedStrips.push(hosted.directUrl);
  }
  const result = { directUrl: uploadedStrips[0], pageUrl: '', stripUrls: uploadedStrips };
  cacheMedia(cacheKey, result, telegramState.imageHost);
  return result;
}

function telegramSenderName(user) {
  const firstName = String(user?.first_name || '').trim();
  const lastName = String(user?.last_name || '').trim();
  const fullName = firstName && lastName
    ? (/[㐀-鿿]/u.test(`${firstName}${lastName}`) ? `${firstName}${lastName}` : `${firstName} ${lastName}`)
    : firstName || lastName;
  return fullName || user?.username || String(user?.id || 'unknown');
}

function normalizeReply(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value).trim().slice(0, 500);
}

function addTelegramLog(type, message, detail = '') {
  const entry = { time: new Date().toISOString(), type, message: String(message || ''), detail: String(detail || '') };
  telegramState.logs.push(entry);
  if (telegramState.logs.length > MAX_TELEGRAM_LOGS) telegramState.logs.splice(0, telegramState.logs.length - MAX_TELEGRAM_LOGS);
  const level = ['failed', 'reply_failed'].includes(type) ? 'ERROR' : ['blocked', 'filtered', 'ignored', 'limited'].includes(type) ? 'WARN' : 'INFO';
  log(level, `Telegram ${type}`, `${entry.message}${entry.detail ? ` | ${entry.detail}` : ''}`);
}

function userTaskAllowed(userId) {
  if (telegramState.maxPerMinute === 0) return true;
  const now = Date.now();
  const entries = (telegramState.userTasks.get(String(userId)) || []).filter((timestamp) => now - timestamp < 60_000);
  if (entries.length >= telegramState.maxPerMinute) {
    telegramState.userTasks.set(String(userId), entries);
    return false;
  }
  entries.push(now);
  telegramState.userTasks.set(String(userId), entries);
  return true;
}

function telegramTaskCharCount(text) {
  return Array.from(printableText(text)).length;
}

function queuedTextLengthForUser(userId) {
  return telegramState.printQueue
    .filter((item) => item.userId === userId && item.textLength)
    .reduce((total, item) => total + item.textLength, 0);
}

function textTaskAllowed(userId, textLength) {
  if (telegramState.maxCharsPerTask === 0) return true;
  return queuedTextLengthForUser(userId) + textLength <= telegramState.maxCharsPerTask;
}

function activeBlacklistEntry(userId) {
  const key = String(userId);
  const entry = telegramState.blacklist.get ? telegramState.blacklist.get(key) : telegramState.blacklist.find((item) => item.userId === key);
  if (!entry) return null;
  if (entry.blockedUntil !== null && entry.blockedUntil <= Date.now()) {
    if (telegramState.blacklist.delete) telegramState.blacklist.delete(key);
    else telegramState.blacklist = telegramState.blacklist.filter((item) => item.userId !== key);
    return null;
  }
  return entry;
}

function blacklistEntries() {
  const entries = [];
  if (telegramState.blacklist instanceof Map) {
    for (const userId of telegramState.blacklist.keys()) {
      const entry = activeBlacklistEntry(userId);
      if (entry) entries.push({ ...entry });
    }
  } else {
    telegramState.blacklist.forEach((entry) => { if (activeBlacklistEntry(entry.userId)) entries.push({ ...entry }); });
  }
  return entries;
}

function blockedUser(userId) {
  return activeBlacklistEntry(userId);
}

function setBlacklistEntry(entry) {
  if (telegramState.blacklist instanceof Map) telegramState.blacklist.set(String(entry.userId), entry);
}

function removeBlacklistEntry(userId) {
  if (telegramState.blacklist instanceof Map) telegramState.blacklist.delete(String(userId));
}

function recordRateLimit(user, reason = '多次触发频率限制') {
  const userId = String(user.userId);
  const now = Date.now();
  const windowMs = telegramState.rateLimitStrikeWindowMinutes * 60_000;
  const strikes = (telegramState.rateLimitStrikes.get(userId) || []).filter((timestamp) => now - timestamp < windowMs);
  strikes.push(now);
  telegramState.rateLimitStrikes.set(userId, strikes);
  const strikeNumber = Math.min(strikes.length, 3);
  const permanent = strikeNumber >= 3 && telegramState.rateLimitBlacklistOnThird;
  const penaltyMinutes = telegramState.rateLimitPenaltyMinutes[strikeNumber - 1] || 0;
  const entry = {
    userId,
    name: String(user.name || '未知用户'),
    username: String(user.username || ''),
    blockedUntil: permanent ? null : now + penaltyMinutes * 60_000,
    reason: `${reason}（第 ${strikeNumber} 次）`,
    strikes: strikeNumber,
    createdAt: now,
  };
  if (permanent || penaltyMinutes > 0) setBlacklistEntry(entry);
  const action = permanent ? '已永久拉黑' : penaltyMinutes > 0 ? `封禁 ${penaltyMinutes} 分钟` : '本档未设置临时封禁';
  addTelegramLog('blocked', `${entry.name}${entry.username ? `（${entry.username}）` : ''}`, action);
  return entry;
}

const TELEGRAM_LINK_MARKERS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

function telegramLinkMarker(index) {
  return TELEGRAM_LINK_MARKERS[index - 1] || `(${index})`;
}

function telegramTextNodes(text, options = {}) {
  text = printableText(text);
  const width = Number(options.width) === 1 ? 1 : 0;
  const capacity = width === 1 ? 16 : 32;
  return telegramContentNodes(splitTextIntoLines(text, capacity), options);
}

function telegramEntityEnd(entity) {
  return entity.offset + entity.length;
}

function telegramFormattedTextNodes(text, entities = [], prefix = '') {
  const source = String(text ?? '');
  const validEntities = (Array.isArray(entities) ? entities : [])
    .map((entity) => ({ ...entity, offset: Number(entity.offset), length: Number(entity.length) }))
    .filter((entity) => Number.isInteger(entity.offset) && Number.isInteger(entity.length) && entity.offset >= 0 && entity.length > 0 && telegramEntityEnd(entity) <= source.length);
  const links = validEntities
    .filter((entity) => ['text_link', 'url'].includes(entity.type))
    .sort((left, right) => left.offset - right.offset)
    .map((entity) => ({
      entity,
      url: entity.type === 'text_link' && entity.url ? String(entity.url) : source.slice(entity.offset, telegramEntityEnd(entity)),
    }))
    .filter((link) => telegramQrAllowed(link.url))
    .map((link, index) => ({ ...link, marker: telegramLinkMarker(index + 1) }));
  const linkByEntity = new Map(links.map((link) => [link.entity, link]));
  const boundaries = new Set([0, source.length]);
  validEntities.forEach((entity) => {
    boundaries.add(entity.offset);
    boundaries.add(telegramEntityEnd(entity));
  });
  const positions = [...boundaries].sort((left, right) => left - right);
  const nodes = [];
  let line = { text: prefix, bold: false, italic: false };

  const appendLine = () => {
    const style = { height: line.bold ? 1 : line.italic ? 1 : 0, width: line.bold ? 1 : 0 };
    nodes.push(...telegramTextNodes(line.text, style));
    line = { text: '', bold: false, italic: false };
  };

  for (let index = 0; index < positions.length - 1; index += 1) {
    const start = positions[index];
    const end = positions[index + 1];
    const chunk = source.slice(start, end);
    const active = validEntities.filter((entity) => entity.offset <= start && telegramEntityEnd(entity) >= end);
    const link = active.map((entity) => linkByEntity.get(entity)).find(Boolean);
    const parts = chunk.split(/\r?\n/);
    parts.forEach((part, partIndex) => {
      line.text += printableText(part);
      line.bold ||= active.some((entity) => entity.type === 'bold');
      line.italic ||= active.some((entity) => entity.type === 'italic');
      if (partIndex < parts.length - 1) appendLine();
    });
    if (link && telegramEntityEnd(link.entity) === end) line.text += link.marker;
  }
  appendLine();
  return { nodes, links };
}

function telegramLinkNodes(links) {
  return links.flatMap((link) => [
    { icon: { value: printableText(link.url), style: { justification: 1 }, type: 1 } },
    ...telegramTextNodes(link.marker),
  ]);
}

function telegramMessageNodes(sender, text, entities, hasUnsupportedCharacters = false) {
  const formatted = telegramFormattedTextNodes(text, entities, sender ? `${sender}：` : '');
  const nodes = [...formatted.nodes, ...telegramLinkNodes(formatted.links)];
  if (hasUnsupportedCharacters) {
    nodes.push(...telegramTextNodes('-----------'));
    nodes.push(...telegramTextNodes('该消息含有不支持打印的字符'));
  }
  return nodes;
}

function telegramPrintingReply(item) {
  const warning = item.unsupportedCharacters?.length
    ? `消息中的${item.unsupportedCharacters.join(' ')} 无法打印，将忽略`
    : '';
  return [telegramState.replyPrinting, warning].filter(Boolean).join('\n');
}

function telegramPayload(items) {
  const values = Array.isArray(items) ? items : [items];
  const separatorNodes = values.length > 1 ? telegramTextNodes('-----------') : [];
  const root = telegramPrintNodes(values.map((item) => ({
    ...item,
    nodes: item.nodes || telegramTextNodes(item.printText),
  })), separatorNodes);
  return {
    device_sn: telegramState.deviceSn,
    ad_content: { user_define_template: { root } },
    account_type: telegramState.accountType,
    sid: telegramState.sid,
  };
}

function flushPrintQueue(generation) {
  if (telegramState.printFlushTimer) {
    clearTimeout(telegramState.printFlushTimer);
    telegramState.printFlushTimer = null;
  }
  if (!telegramState.printQueue.length || telegramState.generation !== generation || !telegramState.running) return;
  const batch = telegramState.printQueue.splice(0);
  const payload = Buffer.from(JSON.stringify(telegramPayload(batch)));
  log('INFO', 'Telegram 批量打印已转发', `${batch.length} 条消息，${payload.length} bytes -> ${TARGET_HOST}`);
  batch.forEach((item) => {
    addTelegramLog('printing', item.printText, `批量任务 ${batch.length} 条消息`);
    telegramReply(item.chatId, telegramPrintingReply(item), generation);
  });
  forwardPrint(telegramState.sid, payload, (error, statusCode, headers, body) => {
    if (error) log('ERROR', 'Telegram 打印接口请求失败', error.message);
    else log(statusCode >= 200 && statusCode < 300 ? 'INFO' : 'WARN', 'Telegram 打印接口已返回', `HTTP ${statusCode}，${body.length} bytes`);
    const requestError = typeof error?.message === 'string' ? error.message.trim() : '';
    let result = { ok: false, error: requestError || '打印请求失败', replyError: requestError };
    if (!error) {
      const responseText = body.toString('utf8');
      try {
        const response = JSON.parse(responseText);
        const replyError = typeof response.msg === 'string' ? response.msg.trim() : '';
        result = isSidExpired(response)
          ? { ok: false, error: 'SID 已失效，请重新填写。', replyError: '' }
          : response.errcode ? { ok: false, error: replyError || `打印接口错误码 ${response.errcode}`, replyError } : { ok: true };
      } catch (parseError) {
        result = isSidExpired(responseText)
          ? { ok: false, error: 'SID 已失效，请重新填写。', replyError: '' }
          : { ok: false, error: parseError.message, replyError: '' };
      }
    }
    batch.forEach(async (item) => {
      if (result.ok) {
        telegramState.lastMessage = item.printText;
        telegramState.error = '';
        addTelegramLog('printed', item.printText, `批量任务 ${batch.length} 条消息`);
        await telegramReply(item.chatId, telegramState.replyPrinted, generation);
      } else {
        telegramState.error = result.error;
        addTelegramLog('failed', item.printText, result.error);
        await telegramReply(item.chatId, result.replyError || telegramState.replyPrintFailed, generation);
      }
    });
  });
}

function schedulePrintFlush(generation) {
  if (telegramState.printFlushTimer) clearTimeout(telegramState.printFlushTimer);
  telegramState.printFlushTimer = setTimeout(() => flushPrintQueue(generation), 500);
}

function enqueuePrintMessage(item, generation) {
  telegramState.printQueue.push(item);
  schedulePrintFlush(generation);
}

function pausePrintFlushForFollowingImage(userId) {
  const previous = telegramState.printQueue[telegramState.printQueue.length - 1];
  if (!telegramState.printFlushTimer || previous?.userId !== userId || previous.kind !== 'text') return false;
  clearTimeout(telegramState.printFlushTimer);
  telegramState.printFlushTimer = null;
  return true;
}

async function telegramLoop(generation) {
  while (telegramState.running && telegramState.generation === generation) {
    try {
      const updates = await telegramRequest(telegramState.apiBase, telegramState.token, 'getUpdates', { offset: telegramState.offset, timeout: 45, allowed_updates: ['message'] }, 50000, telegramState.proxyUrl);
      if (!telegramState.running || telegramState.generation !== generation) return;
      telegramState.error = '';
      telegramState.retryCount = 0;
      for (const update of updates || []) {
        telegramState.offset = update.update_id + 1;
        const message = update.message;
        if (!message) continue;
        const sender = telegramSenderName(message.from);
        if (message.chat?.type !== 'private') {
          addTelegramLog('ignored', `${sender} 的 ${message.chat?.type || '非私聊'} 消息已忽略`, 'only_private_chat');
          continue;
        }
        const userId = String(message.from?.id || message.chat?.id || 'unknown');
        const userProfile = { userId, name: sender, username: String(message.from?.username || '') };
        const text = typeof message.text === 'string' ? message.text : '';
        const unsupportedMessageCharacters = unsupportedCharacters(text);
        const printableMessageText = printableText(text).trim();
        const caption = typeof message.caption === 'string' ? message.caption : '';
        if (text.trim().startsWith('/') || caption.trim().startsWith('/')) {
          addTelegramLog('ignored', `${sender} 的指令已忽略`, 'telegram_command');
          continue;
        }
        const existingBlacklist = blockedUser(userId);
        if (existingBlacklist) {
          addTelegramLog('blocked', `${sender}${userProfile.username ? `（${userProfile.username}）` : ''} 的消息已拦截`, existingBlacklist.blockedUntil === null ? '永久拉黑' : `封禁至 ${new Date(existingBlacklist.blockedUntil).toLocaleString('zh-CN')}`);
          recordRateLimit(userProfile, '封控期间再次触发频率限制');
          await telegramReply(message.chat?.id, telegramState.replyRateLimited, generation);
          continue;
        }
        if (message.sticker) {
          if (!telegramState.stickerEnabled) {
            addTelegramLog('filtered', `${sender} 收到了 sticker，已跳过`, 'sticker_printing_disabled');
            await telegramReply(message.chat?.id, telegramState.replyUnsupported, generation);
            continue;
          }
          if (message.sticker.is_animated && !telegramState.webmStickerEnabled) {
            addTelegramLog('filtered', `${sender} 收到了动画 sticker，已跳过`, 'unsupported_animated_sticker');
            await telegramReply(message.chat?.id, telegramState.replyUnsupported, generation);
            continue;
          }
          try {
            const stickerResult = await processTelegramSticker(message.sticker, {
              webmEnabled: telegramState.webmStickerEnabled,
              webmFrame: telegramState.webmStickerFrame,
            });
            addTelegramLog('received', `${sender}：sticker`, stickerResult.cached ? cacheHitDetail(telegramState.imageHost) : '已处理并上传图片');
            const alreadyQueuedForUser = telegramState.printQueue.some((item) => item.userId === userId);
            if (!alreadyQueuedForUser && !userTaskAllowed(userId)) {
              addTelegramLog('limited', `${sender}：sticker`, `超过每分钟 ${telegramState.maxPerMinute} 条任务`);
              recordRateLimit(userProfile);
              await telegramReply(message.chat?.id, telegramState.replyRateLimited, generation);
              continue;
            }
            const imageNodes = (stickerResult.stripUrls || [stickerResult.directUrl]).map(
              (url) => ({ icon: { value: url, style: { justification: 1 }, type: 3 } })
            );
            enqueuePrintMessage({
              userId,
              chatId: message.chat?.id,
              printText: `${sender}：sticker`,
              nodes: [...telegramTextNodes(sender), ...imageNodes],
            }, generation);
          } catch (error) {
            const detail = error.message || 'sticker 处理失败';
            const unsupportedSticker = error.code === 'UNSUPPORTED_STICKER';
            addTelegramLog(unsupportedSticker ? 'filtered' : 'failed', `${sender} 的 sticker 未打印`, detail);
            await telegramReply(message.chat?.id, unsupportedSticker ? telegramState.replyUnsupported : telegramState.replyPrintFailed, generation);
          }
          continue;
        }
        if (message.photo) {
          if (!telegramState.photoEnabled) {
            addTelegramLog('filtered', `${sender} 收到了图片，已跳过`, 'photo_printing_disabled');
            await telegramReply(message.chat?.id, telegramState.replyUnsupported, generation);
            continue;
          }
          const printableCaption = printableText(caption).trim();
          const captionCharacters = unsupportedCharacters(caption);
          const captionLength = telegramTaskCharCount(printableCaption);
          if (printableCaption && !textTaskAllowed(userId, captionLength)) {
            addTelegramLog('limited', `${sender}：${printableCaption}`, `单次打印文字超过 ${telegramState.maxCharsPerTask} 字限制`);
            await telegramReply(message.chat?.id, telegramState.replyRateLimited, generation);
            continue;
          }
          const pausedPrintFlush = pausePrintFlushForFollowingImage(userId);
          let photoEnqueued = false;
          try {
            const photo = Array.isArray(message.photo) ? message.photo[message.photo.length - 1] : null;
            const photoResult = await processTelegramPhoto(photo);
            addTelegramLog('received', `${sender}：图片${printableCaption ? ` ${printableCaption}` : ''}`, photoResult.cached ? cacheHitDetail(telegramState.imageHost) : '已处理并上传图片');
            const alreadyQueuedForUser = telegramState.printQueue.some((item) => item.userId === userId);
            if (!alreadyQueuedForUser && !userTaskAllowed(userId)) {
              addTelegramLog('limited', `${sender}：图片`, `超过每分钟 ${telegramState.maxPerMinute} 条任务`);
              recordRateLimit(userProfile);
              await telegramReply(message.chat?.id, telegramState.replyRateLimited, generation);
              continue;
            }
            const imageNodes = (photoResult.stripUrls || [photoResult.directUrl]).map(
              (url) => ({ icon: { value: url, style: { justification: 1 }, type: 3 } })
            );
            const captionNodes = printableCaption
              ? telegramMessageNodes('', caption, message.caption_entities, captionCharacters.length > 0)
              : [];
            enqueuePrintMessage({
              userId,
              chatId: message.chat?.id,
              kind: 'image',
              printText: `${sender}：图片${printableCaption ? ` ${printableCaption}` : ''}`,
              textLength: captionLength,
              unsupportedCharacters: captionCharacters,
              nodes: [...telegramTextNodes(sender), ...imageNodes, ...captionNodes],
              continuationNodes: [...imageNodes, ...captionNodes],
            }, generation);
            photoEnqueued = true;
          } catch (error) {
            addTelegramLog('failed', `${sender} 的图片未打印`, error.message || '图片处理失败');
            await telegramReply(message.chat?.id, telegramState.replyPrintFailed, generation);
          } finally {
            if (pausedPrintFlush && !photoEnqueued) schedulePrintFlush(generation);
          }
          continue;
        }
        const unsupported = !printableMessageText || message.document || message.video || message.voice || message.animation || message.audio || message.contact || message.location || message.poll || message.video_note;
        if (unsupported) {
          const description = `${sender} 收到了${message.sticker ? ' sticker' : message.photo ? ' 图片' : ' 非文字'}消息，已跳过`;
          addTelegramLog('filtered', description, 'unsupported_message');
          await telegramReply(message.chat?.id, telegramState.replyUnsupported, generation);
          continue;
        }
        addTelegramLog('received', `${sender}：${printableMessageText}`);
        const textLength = telegramTaskCharCount(printableMessageText);
        if (!textTaskAllowed(userId, textLength)) {
          addTelegramLog('limited', `${sender}：${printableMessageText}`, `单次打印文字超过 ${telegramState.maxCharsPerTask} 字限制`);
          await telegramReply(message.chat?.id, telegramState.replyRateLimited, generation);
          continue;
        }
        const alreadyQueuedForUser = telegramState.printQueue.some((item) => item.userId === userId);
        if (!alreadyQueuedForUser && !userTaskAllowed(userId)) {
          addTelegramLog('limited', `${sender}：${printableMessageText}`, `超过每分钟 ${telegramState.maxPerMinute} 条任务`);
          recordRateLimit(userProfile);
          await telegramReply(message.chat?.id, telegramState.replyRateLimited, generation);
          continue;
        }
        const printText = `${sender}：${printableMessageText}`;
        enqueuePrintMessage({
          userId,
          chatId: message.chat?.id,
          kind: 'text',
          printText,
          textLength,
          unsupportedCharacters: unsupportedMessageCharacters,
          nodes: telegramMessageNodes(sender, text, message.entities, unsupportedMessageCharacters.length > 0),
          continuationNodes: telegramMessageNodes('', text, message.entities, unsupportedMessageCharacters.length > 0),
        }, generation);
      }
    } catch (error) {
      if (!telegramState.running || telegramState.generation !== generation) return;
      telegramState.error = error.message;
      telegramState.retryCount += 1;
      if (telegramState.retryCount > 3) {
        telegramState.running = false;
        telegramState.generation += 1;
        addTelegramLog('system', '监听已停止', `连续重试 3 次失败：${error.message}`);
        return;
      }
      addTelegramLog('system', `监听请求失败，${telegramState.retryCount}/3 次重试`, error.message);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

async function telegramReply(chatId, text, generation) {
  if (!chatId || !text || telegramState.generation !== generation || !telegramState.running) return;
  try {
    await telegramRequest(telegramState.apiBase, telegramState.token, 'sendMessage', { chat_id: chatId, text }, 15_000, telegramState.proxyUrl);
    addTelegramLog('replied', `chat:${chatId}`, text);
  } catch (error) {
    telegramState.error = error.message;
    addTelegramLog('reply_failed', `chat:${chatId}`, error.message);
  }
}

async function startTelegram(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const accountType = normalizeAccountType(body.account_type, null);
      if (!body.token || !body.sid || !body.device_sn || accountType === null || accountType === '') throw new Error('token、设备 SN、SID 和 account_type 都不能为空且 account_type 必须是数字');
      const apiBase = normalizeTelegramApiBase(body.api_base);
      const proxyUrl = body.proxy_enabled ? normalizeTelegramProxy(body.proxy_url) : '';
      if (body.proxy_enabled && !proxyUrl) throw new Error('已开启 HTTP 代理，请填写代理地址');
      const requestedLimit = Number(body.max_per_minute);
      const maxPerMinute = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(100, Math.floor(requestedLimit))) : 2;
      const requestedChars = Number(body.max_chars_per_task);
      const maxCharsPerTask = Number.isFinite(requestedChars) ? Math.max(0, Math.min(4294967295, Math.floor(requestedChars))) : 0;
      const strikeWindow = Number(body.rate_limit_strike_window_minutes);
      const rateLimitStrikeWindowMinutes = Number.isFinite(strikeWindow) ? Math.max(1, Math.min(1440, Math.floor(strikeWindow))) : 1;
      const penaltyValues = Array.isArray(body.rate_limit_penalty_minutes) ? body.rate_limit_penalty_minutes : [2, 10, 1440];
      const rateLimitPenaltyMinutes = [0, 1, 2].map((index) => {
        const value = Number(penaltyValues[index]);
        return Number.isFinite(value) ? Math.max(0, Math.min(525600, Math.floor(value))) : [2, 10, 1440][index];
      });
      const rateLimitBlacklistOnThird = body.rate_limit_blacklist_on_third === true;
      await telegramRequest(apiBase, body.token.trim(), 'getMe', {}, 10000, proxyUrl);
      telegramState.running = false;
      telegramState.generation += 1;
      if (telegramState.printFlushTimer) clearTimeout(telegramState.printFlushTimer);
      telegramState.printFlushTimer = null;
      telegramState.printQueue = [];
      telegramState.token = body.token.trim();
      telegramState.offset = 0;
      telegramState.sid = body.sid.trim();
      telegramState.deviceSn = body.device_sn.trim();
      telegramState.accountType = accountType;
      telegramState.apiBase = apiBase;
      telegramState.proxyUrl = proxyUrl;
      telegramState.maxPerMinute = maxPerMinute;
      telegramState.maxCharsPerTask = maxCharsPerTask;
      telegramState.rateLimitStrikeWindowMinutes = rateLimitStrikeWindowMinutes;
      telegramState.rateLimitPenaltyMinutes = rateLimitPenaltyMinutes;
      telegramState.rateLimitBlacklistOnThird = rateLimitBlacklistOnThird;
      telegramState.stickerEnabled = body.sticker_enabled !== false;
      telegramState.webmStickerEnabled = body.webm_sticker_enabled !== false;
      telegramState.webmStickerFrame = ['first', 'second', 'penultimate', 'last'].includes(body.webm_sticker_frame) ? body.webm_sticker_frame : 'penultimate';
      telegramState.photoEnabled = body.photo_enabled !== false;
      telegramState.replyPrinting = normalizeReply(body.reply_printing, '正在打印，请稍候。');
      telegramState.replyPrinted = normalizeReply(body.reply_printed, '已打印。');
      telegramState.replyPrintFailed = normalizeReply(body.reply_print_failed, '打印失败，请稍后重试。');
      telegramState.replyUnsupported = normalizeReply(body.reply_unsupported, '该消息类型不支持打印，请发送文字。');
      telegramState.replyRateLimited = normalizeReply(body.reply_rate_limited, '操作太频繁，请稍后再试。');
      applyImageHostSettings(body.image_host || {});
      telegramState.userTasks = new Map();
      telegramState.rateLimitStrikes = new Map();
      const configuredBlacklist = Array.isArray(body.blacklist) ? body.blacklist : [];
      telegramState.blacklist = new Map(configuredBlacklist.filter((entry) => entry && entry.userId).map((entry) => [String(entry.userId), {
        userId: String(entry.userId), name: String(entry.name || '未知用户'), username: String(entry.username || ''),
        blockedUntil: entry.blockedUntil === null ? null : Number(entry.blockedUntil) || null,
        reason: String(entry.reason || '多次触发频率限制'), strikes: Number(entry.strikes) || 0, createdAt: Number(entry.createdAt) || Date.now(),
      }]));
      telegramState.logs = [];
      runScheduledCacheCleanup(telegramState.imageHost).catch((error) => { imageHostCleanupState.lastError = error.message; });
      const taskLimitText = maxPerMinute === 0 ? '单个用户不限制打印任务数量' : `每位用户每分钟最多 ${maxPerMinute} 条任务`;
      const charLimitText = maxCharsPerTask === 0 ? '单次打印文字不限制字数' : `单次打印文字最多 ${maxCharsPerTask} 字`;
      const penaltyText = rateLimitBlacklistOnThird ? `封控窗口 ${rateLimitStrikeWindowMinutes} 分钟，惩罚 ${rateLimitPenaltyMinutes.join('/')} 分钟后第 3 次永久拉黑` : `封控窗口 ${rateLimitStrikeWindowMinutes} 分钟，惩罚 ${rateLimitPenaltyMinutes.join('/')} 分钟`;
      addTelegramLog('system', `监听已启动，${taskLimitText}，${charLimitText}，${penaltyText}`);
      telegramState.lastMessage = '';
      telegramState.error = '';
      telegramState.retryCount = 0;
      telegramState.running = true;
      telegramLoop(telegramState.generation);
      log('INFO', 'Telegram 监听请求已接受');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ running: true }));
    } catch (error) {
      log('ERROR', 'Telegram 监听启动失败', error.message);
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
}

function stopTelegram(res) {
  telegramState.running = false;
  telegramState.generation += 1;
  telegramState.token = '';
  telegramState.error = '';
  telegramState.retryCount = 0;
  if (telegramState.printFlushTimer) clearTimeout(telegramState.printFlushTimer);
  telegramState.printFlushTimer = null;
  telegramState.printQueue = [];
  log('INFO', 'Telegram 监听已停止');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ running: false }));
}

function telegramStatus(res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    running: telegramState.running,
    lastMessage: telegramState.lastMessage,
    error: telegramState.error,
    retryCount: telegramState.retryCount,
    logs: telegramState.logs,
    maxPerMinute: telegramState.maxPerMinute,
    maxCharsPerTask: telegramState.maxCharsPerTask,
    rateLimitStrikeWindowMinutes: telegramState.rateLimitStrikeWindowMinutes,
    rateLimitPenaltyMinutes: telegramState.rateLimitPenaltyMinutes,
    rateLimitBlacklistOnThird: telegramState.rateLimitBlacklistOnThird,
    blacklist: blacklistEntries(),
    stickerEnabled: telegramState.stickerEnabled,
    webmStickerEnabled: telegramState.webmStickerEnabled,
    webmStickerFrame: telegramState.webmStickerFrame,
    photoEnabled: telegramState.photoEnabled,
    imageHost: {
      provider: telegramState.imageHost.provider,
      cacheExpireDays: telegramState.imageHost.cacheExpireDays,
      deleteExpiredCache: telegramState.imageHost.deleteExpiredCache,
      cleanup: imageHostCleanupStatus(),
    },
  }));
}

function telegramBlacklist(res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ blacklist: blacklistEntries() }));
}

function removeTelegramBlacklist(req, res, requestUrl) {
  let userId;
  try { userId = decodeURIComponent(requestUrl.pathname.slice('/api/telegram/blacklist/'.length)); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'invalid userId' }));
    return;
  }
  if (!userId) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'userId is required' }));
    return;
  }
  removeBlacklistEntry(userId);
  telegramState.rateLimitStrikes.delete(String(userId));
  addTelegramLog('system', `已解除用户 ${userId} 的封控`, 'blacklist_removed');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ removed: true, blacklist: blacklistEntries() }));
}

function clearTelegramLogs(res) {
  telegramState.logs = [];
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ cleared: true }));
}

function proxyImage(res, requestUrl) {
  let target;
  try { target = new URL(requestUrl.searchParams.get('url')); } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('A valid image URL is required');
    return;
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Only HTTP(S) image URLs are supported');
    return;
  }
  const transport = target.protocol === 'https:' ? https : http;
  transport.get(target, (imageRes) => {
    if (imageRes.statusCode && imageRes.statusCode >= 300 && imageRes.statusCode < 400 && imageRes.headers.location) {
      imageRes.resume();
      proxyImage(res, new URL(`/api/image?url=${encodeURIComponent(new URL(imageRes.headers.location, target).toString())}`, 'http://localhost'));
      return;
    }
    if (imageRes.statusCode !== 200) {
      imageRes.resume();
      res.writeHead(imageRes.statusCode || 502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Image request failed');
      return;
    }
    res.writeHead(200, {
      'Content-Type': imageRes.headers['content-type'] || 'image/png',
      'Cache-Control': 'no-store',
    });
    imageRes.pipe(res);
  }).on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Image request failed');
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const startedAt = Date.now();
  res.on('finish', () => {
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    log(level, `HTTP ${req.method} ${requestUrl.pathname} -> ${res.statusCode}`, `${Date.now() - startedAt} ms`);
  });
  if (req.method === 'POST' && requestUrl.pathname === '/api/print') {
    proxyPrint(req, res, requestUrl);
    return;
  }
  if (req.method === 'POST' && requestUrl.pathname === '/api/image-host/upload') return imageHostUpload(req, res);
  if (req.method === 'GET' && requestUrl.pathname === '/api/config') return getAppConfig(res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/config') return updateAppConfig(req, res);
  if (req.method === 'DELETE' && requestUrl.pathname === '/api/config') return deleteAppConfig(res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/settings/image-host') return setImageHostSettings(req, res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/telegram/start') return startTelegram(req, res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/telegram/stop') return stopTelegram(res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/telegram/logs/clear') return clearTelegramLogs(res);
  if (req.method === 'GET' && requestUrl.pathname === '/api/telegram/status') return telegramStatus(res);
  if (req.method === 'GET' && requestUrl.pathname === '/api/telegram/blacklist') return telegramBlacklist(res);
  if (req.method === 'DELETE' && requestUrl.pathname.startsWith('/api/telegram/blacklist/')) return removeTelegramBlacklist(req, res, requestUrl);
  if (req.method === 'GET' && requestUrl.pathname === '/api/image') {
    proxyImage(res, requestUrl);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD, POST' });
    res.end('Method not allowed');
    return;
  }
  const requestedPath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  if (requestedPath === '/config.json') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const filePath = path.resolve(ROOT, `.${requestedPath}`);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  sendFile(res, filePath);
});

scheduleImageHostCleanup();
runScheduledCacheCleanup(appConfig.imageHost).catch((error) => { imageHostCleanupState.lastError = error.message; });

server.listen(PORT, HOST, () => {
  log('INFO', `WeChat Printer local app is running at http://${HOST}:${PORT}`);
  log('INFO', 'POST /api/print is proxied to payapp.wechatpay.cn');
});

server.on('error', (error) => {
  log('ERROR', '本地服务错误', error.message);
  process.exitCode = 1;
});

function shutdown(signal) {
  telegramState.running = false;
  telegramState.generation += 1;
  telegramState.token = '';
  server.close(() => {
    log('INFO', `${signal}: local app stopped`);
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
