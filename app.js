const API_URL = '/api/print?sid=';
const DEFAULT_IMAGE = 'https://cdn-70144.picnjc.qpic.cn/newwxpaylogo/smartdevice/1787390436677_9c587acb97b2f8fe237c0da72f612c5c.png?imageView2/1/w/280/h/280';
const SAVED_DEVICES_KEY = 'wechat-printer.devices';
const TELEGRAM_API_KEY = 'wechat-printer.telegram-api';
const TELEGRAM_PROXY_KEY = 'wechat-printer.telegram-proxy';
const TELEGRAM_RULES_KEY = 'wechat-printer.telegram-rules';
const DEVICE_DRAFT_KEY = 'wechat-printer.device-draft';
const TELEGRAM_DRAFT_KEY = 'wechat-printer.telegram-draft';
const IMAGE_HOST_KEY = 'wechat-printer.image-host';
const STORAGE_MODE_KEY = 'wechat-printer.storage-mode';
const TEXT_LINE_CAPACITY = 32;
const UINT32_MAX = 4294967295;
const DEFAULT_CACHE_EXPIRE_DAYS = 7;
const MAX_CACHE_EXPIRE_DAYS = 36500;
const { printableText, containsUnsupportedText } = PrinterTextCompatibility;
const { isSidExpired } = PrinterResponse;
let imageRenderId = 0;
const previewSources = new Map();
const MAX_IMAGE_SIZE = 280;
let cropState = null;
let developerMode = false;
let developerJsonDirty = false;
let imageHostSettings = { provider: 'imgchr', cacheExpireDays: DEFAULT_CACHE_EXPIRE_DAYS, deleteExpiredCache: false };
let storageMode = 'browser';
let localConfig = null;
let configSaveTimer = null;
let hydratingConfig = false;
let telegramBlacklist = [];
let telegramStatusState = 'idle';
let telegramRunning = false;
let telegramActionPending = false;
let lastImageHostCleanupNotice = '';

const $ = (id) => document.getElementById(id);
const fields = {
  deviceSn: $('deviceSn'),
  sid: $('sid'),
  accountType: $('accountType'),
};

let contentItems = [
  { type: 'text', columns: [''] },
];

function readSavedDevices() {
  let source;
  if (storageMode === 'local' && localConfig) {
    source = localConfig.device?.sn && localConfig.device?.sid ? [localConfig.device] : [];
  } else {
    const draft = readDraft(DEVICE_DRAFT_KEY);
    const hasDraft = Object.prototype.hasOwnProperty.call(draft, 'sn')
      || Object.prototype.hasOwnProperty.call(draft, 'sid')
      || Object.prototype.hasOwnProperty.call(draft, 'accountType')
      || Object.prototype.hasOwnProperty.call(draft, 'account_type');
    if (hasDraft) source = draft.sn && draft.sid ? [draft] : [];
    else {
      try {
        const legacy = JSON.parse(localStorage.getItem(SAVED_DEVICES_KEY) || '[]');
        source = Array.isArray(legacy) && legacy.length ? [legacy[0]] : [];
      } catch { source = []; }
    }
  }
  return Array.isArray(source) ? source.filter((item) => item?.sn && item?.sid).map((item) => ({
    sn: String(item.sn),
    sid: String(item.sid),
    account_type: (() => {
      const value = item.account_type ?? item.accountType;
      return value != null && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : 2;
    })(),
  })) : [];
}

function writeSavedDevices(devices) {
  const device = Array.isArray(devices) && devices[0] ? devices[0] : null;
  if (storageMode === 'local') {
    if (!localConfig) localConfig = currentConfig();
    if (device) {
      localConfig.device = { sn: device.sn, sid: device.sid, accountType: device.account_type };
    } else {
      localConfig.device = { sn: '', sid: '', accountType: '' };
    }
    delete localConfig.savedDevices;
    scheduleLocalConfigSave();
    return;
  }
  if (device) writeDraft(DEVICE_DRAFT_KEY, { sn: device.sn, sid: device.sid, accountType: device.account_type });
  else localStorage.removeItem(DEVICE_DRAFT_KEY);
  localStorage.removeItem(SAVED_DEVICES_KEY);
}

function readDraft(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}

function writeDraft(key, values) {
  try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* browser storage may be unavailable */ }
}

function browserStorageMode() {
  return localStorage.getItem(STORAGE_MODE_KEY) === 'local' ? 'local' : 'browser';
}

function currentConfig() {
  const config = {
    device: { sn: fields.deviceSn.value, sid: fields.sid.value, accountType: fields.accountType.value.trim() },
    telegram: {
      apiBase: $('telegramApiBase').value, token: $('telegramToken').value,
      proxyEnabled: $('telegramProxyEnabled').checked, proxyUrl: $('telegramProxyUrl').value,
      maxPerMinute: Number($('telegramMaxPerMinute').value) || 0, maxCharsPerTask: Number($('telegramMaxCharsPerTask').value) || 0, stickerEnabled: $('telegramStickerEnabled').checked,
      rateLimitStrikeWindowMinutes: Number($('telegramStrikeWindowMinutes').value) || 1,
      rateLimitPenaltyMinutes: [1, 2, 3].map((index) => Number($(`telegramPenalty${index}`).value) || 0),
      rateLimitBlacklistOnThird: $('telegramBlacklistOnThird').checked,
      blacklist: telegramBlacklist,
      webmStickerEnabled: $('telegramWebmStickerEnabled').checked, webmStickerFrame: $('telegramWebmFrame').value,
      photoEnabled: $('telegramPhotoEnabled').checked,
      reply_printing: $('replyPrinting').value, reply_printed: $('replyPrinted').value,
      reply_print_failed: $('replyPrintFailed').value, reply_unsupported: $('replyUnsupported').value,
      reply_rate_limited: $('replyRateLimited').value,
    },
    imageHost: imageHostSettings,
  };
  return config;
}

function clearBrowserConfig() {
  [SAVED_DEVICES_KEY, TELEGRAM_API_KEY, TELEGRAM_PROXY_KEY, TELEGRAM_RULES_KEY, DEVICE_DRAFT_KEY, TELEGRAM_DRAFT_KEY, IMAGE_HOST_KEY].forEach((key) => localStorage.removeItem(key));
}

function scheduleLocalConfigSave() {
  if (storageMode !== 'local' || hydratingConfig) return;
  localConfig = currentConfig();
  clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(async () => {
    try {
      const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(localConfig) });
      if (!response.ok) throw new Error('本地配置文件写入失败');
    } catch (error) {
      setNotice('error', '本地配置保存失败', error.message);
    }
  }, 250);
}

function writeBrowserConfig(config) {
  const value = config || currentConfig();
  localStorage.setItem(DEVICE_DRAFT_KEY, JSON.stringify({ sn: value.device?.sn || '', sid: value.device?.sid || '', accountType: value.device?.accountType ?? value.device?.account_type ?? '' }));
  localStorage.setItem(TELEGRAM_DRAFT_KEY, JSON.stringify({ proxyEnabled: Boolean(value.telegram?.proxyEnabled), apiBase: value.telegram?.apiBase || '', token: value.telegram?.token || '' }));
  localStorage.setItem(TELEGRAM_API_KEY, value.telegram?.apiBase || '');
  localStorage.setItem(TELEGRAM_PROXY_KEY, value.telegram?.proxyUrl || '');
  localStorage.setItem(TELEGRAM_RULES_KEY, JSON.stringify({ maxPerMinute: value.telegram?.maxPerMinute ?? 2, maxCharsPerTask: value.telegram?.maxCharsPerTask ?? 0, rateLimitStrikeWindowMinutes: value.telegram?.rateLimitStrikeWindowMinutes ?? 1, rateLimitPenaltyMinutes: value.telegram?.rateLimitPenaltyMinutes || [2, 10, 1440], rateLimitBlacklistOnThird: value.telegram?.rateLimitBlacklistOnThird === true, blacklist: value.telegram?.blacklist || [], stickerEnabled: value.telegram?.stickerEnabled !== false, webmStickerEnabled: value.telegram?.webmStickerEnabled !== false, webmStickerFrame: value.telegram?.webmStickerFrame || 'penultimate', photoEnabled: value.telegram?.photoEnabled !== false, reply_printing: value.telegram?.reply_printing || '', reply_printed: value.telegram?.reply_printed || '', reply_print_failed: value.telegram?.reply_print_failed || '', reply_unsupported: value.telegram?.reply_unsupported || '', reply_rate_limited: value.telegram?.reply_rate_limited || '', proxyEnabled: Boolean(value.telegram?.proxyEnabled) }));
  localStorage.setItem(IMAGE_HOST_KEY, JSON.stringify(value.imageHost || { provider: 'imgchr' }));
  localStorage.removeItem(SAVED_DEVICES_KEY);
}

function normalizeCacheExpireDays(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_CACHE_EXPIRE_DAYS;
  const days = Number(value);
  return Number.isFinite(days) ? Math.max(0, Math.min(MAX_CACHE_EXPIRE_DAYS, Math.floor(days))) : DEFAULT_CACHE_EXPIRE_DAYS;
}

function applyConfig(config) {
  const value = config || {};
  fields.deviceSn.value = value.device?.sn || '';
  fields.sid.value = value.device?.sid || '';
  fields.accountType.value = String(value.device?.accountType ?? value.device?.account_type ?? '');
  const telegram = value.telegram || {};
  syncTelegramDeviceFieldsFromMain();
  $('telegramApiBase').value = telegram.apiBase || 'https://api.telegram.org';
  $('telegramToken').value = telegram.token || '';
  $('telegramProxyEnabled').checked = Boolean(telegram.proxyEnabled);
  $('telegramProxyUrl').value = telegram.proxyUrl || '';
  $('telegramMaxPerMinute').value = Number.isFinite(Number(telegram.maxPerMinute)) ? Number(telegram.maxPerMinute) : 2;
  $('telegramMaxCharsPerTask').value = Number.isFinite(Number(telegram.maxCharsPerTask)) ? Number(telegram.maxCharsPerTask) : 0;
  $('telegramStrikeWindowMinutes').value = Number.isFinite(Number(telegram.rateLimitStrikeWindowMinutes)) ? Number(telegram.rateLimitStrikeWindowMinutes) : 1;
  [1, 2, 3].forEach((index) => { $(`telegramPenalty${index}`).value = Number.isFinite(Number(telegram.rateLimitPenaltyMinutes?.[index - 1])) ? Number(telegram.rateLimitPenaltyMinutes[index - 1]) : [2, 10, 1440][index - 1]; });
  $('telegramBlacklistOnThird').checked = telegram.rateLimitBlacklistOnThird === true;
  telegramBlacklist = Array.isArray(telegram.blacklist) ? telegram.blacklist : [];
  renderTelegramBlacklist(telegramBlacklist);
  $('telegramStickerEnabled').checked = telegram.stickerEnabled !== false;
  $('telegramStickerState').textContent = $('telegramStickerEnabled').checked ? '已开启' : '已关闭';
  $('telegramWebmStickerEnabled').checked = telegram.webmStickerEnabled !== false;
  $('telegramWebmStickerState').textContent = $('telegramWebmStickerEnabled').checked ? '已开启' : '已关闭';
  $('telegramWebmFrame').value = ['first', 'second', 'penultimate', 'last'].includes(telegram.webmStickerFrame) ? telegram.webmStickerFrame : 'penultimate';
  $('telegramPhotoEnabled').checked = telegram.photoEnabled !== false;
  $('telegramPhotoState').textContent = $('telegramPhotoEnabled').checked ? '已开启' : '已关闭';
  const replyFields = { replyPrinting: 'reply_printing', replyPrinted: 'reply_printed', replyPrintFailed: 'reply_print_failed', replyUnsupported: 'reply_unsupported', replyRateLimited: 'reply_rate_limited' };
  Object.entries(replyFields).forEach(([id, key]) => { if (Object.prototype.hasOwnProperty.call(telegram, key)) $(id).value = telegram[key]; });
  imageHostSettings = value.imageHost?.provider === 'cfbed'
    ? { ...value.imageHost, cacheExpireDays: normalizeCacheExpireDays(value.imageHost.cacheExpireDays), deleteExpiredCache: value.imageHost.deleteExpiredCache === true }
    : { provider: 'imgchr', cacheExpireDays: DEFAULT_CACHE_EXPIRE_DAYS, deleteExpiredCache: false };
  renderSavedDevices();
  renderImageHostSettings();
  updateProxyControls();
}

function updateProxyControls() {
  const enabled = $('telegramProxyEnabled').checked;
  $('telegramProxyField').classList.toggle('hidden-proxy', !enabled);
  $('telegramProxyUrl').disabled = !enabled;
  $('telegramProxyState').textContent = enabled ? '已开启' : '直连';
}

async function loadLocalConfig() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('无法读取本地配置文件');
  localConfig = await response.json();
  if (localConfig.storageMode !== 'local') return false;
  storageMode = 'local';
  hydratingConfig = true;
  applyConfig(localConfig);
  hydratingConfig = false;
  clearBrowserConfig();
  return true;
}

async function saveCurrentConfigToFile(config) {
  const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '本地配置文件写入失败');
  localConfig = result.config || config;
}

async function clearLocalConfigFile() {
  const response = await fetch('/api/config', { method: 'DELETE' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '无法清除本地配置文件');
  localConfig = null;
}

function readImageHostSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(IMAGE_HOST_KEY) || '{}');
    return value?.provider === 'cfbed' ? {
      provider: 'cfbed',
      baseUrl: String(value.baseUrl || ''),
      token: String(value.token || ''),
      authCode: String(value.authCode || ''),
      uploadChannel: String(value.uploadChannel || ''),
      cacheExpireDays: normalizeCacheExpireDays(value.cacheExpireDays),
      deleteExpiredCache: value.deleteExpiredCache === true,
    } : { provider: 'imgchr', cacheExpireDays: DEFAULT_CACHE_EXPIRE_DAYS, deleteExpiredCache: false };
  } catch { return { provider: 'imgchr', cacheExpireDays: DEFAULT_CACHE_EXPIRE_DAYS, deleteExpiredCache: false }; }
}

function imageHostFormSettings() {
  const provider = $('imageHostProvider').value === 'cfbed' ? 'cfbed' : 'imgchr';
  return {
    provider,
    baseUrl: $('cfBedBaseUrl').value.trim(),
    token: $('cfBedToken').value.trim(),
    authCode: $('cfBedAuthCode').value.trim(),
    uploadChannel: $('cfBedUploadChannel').value,
    cacheExpireDays: provider === 'cfbed' ? normalizeCacheExpireDays($('cfBedCacheExpireDays').value) : DEFAULT_CACHE_EXPIRE_DAYS,
    deleteExpiredCache: provider === 'cfbed' && $('cfBedDeleteExpiredCache').checked,
  };
}

function renderImageHostSettings() {
  const settings = imageHostSettings;
  $('imageHostProvider').value = settings.provider;
  $('cfBedBaseUrl').value = settings.baseUrl || '';
  $('cfBedToken').value = settings.token || '';
  $('cfBedAuthCode').value = settings.authCode || '';
  $('cfBedUploadChannel').value = settings.uploadChannel || '';
  $('cfBedCacheExpireDays').value = normalizeCacheExpireDays(settings.cacheExpireDays);
  $('cfBedDeleteExpiredCache').checked = settings.deleteExpiredCache === true;
  const isCfBed = settings.provider === 'cfbed';
  $('cfBedFields').classList.toggle('hidden-view', !isCfBed);
  $('imageHostStatus').textContent = isCfBed ? 'CloudFlare ImgBed' : '路过图床';
  $('settingsNotice').className = `notice settings-notice ${isCfBed ? 'success' : ''}`.trim();
  $('settingsNotice').querySelector('strong').textContent = isCfBed ? '当前使用 CloudFlare ImgBed' : '当前使用路过图床';
  const cacheExpireDays = normalizeCacheExpireDays(settings.cacheExpireDays);
  const cacheText = cacheExpireDays === 0 ? '缓存永不过期' : `缓存 ${cacheExpireDays} 天后重新上传`;
  const deleteText = settings.deleteExpiredCache ? '，并每天本地 0 点（当天启动未检查时补做）自动删除过期远程文件' : '';
  $('settingsNotice').querySelector('p').textContent = isCfBed ? `处理后的图片会上传到你配置的 CloudFlare ImgBed，并使用响应中的公开直链；${cacheText}${deleteText}。` : '处理后的图片会上传到 Imgchr，并将返回的图片直链写入打印 JSON；相同 Telegram 媒体缓存 7 天。';
}

function setSettingsNotice(type, title, message) {
  const notice = $('settingsNotice');
  notice.className = `notice settings-notice ${type || ''}`.trim();
  notice.querySelector('strong').textContent = title;
  notice.querySelector('p').textContent = message;
}

function handleImageHostCleanupStatus(cleanup) {
  if (!cleanup?.permissionDisabled) return false;
  const message = cleanup.notice || 'CloudFlare ImgBed API Token 未配置或没有 delete 权限，已自动关闭自动删除过期图片。';
  const wasEnabled = imageHostSettings.deleteExpiredCache === true;
  imageHostSettings = { ...imageHostSettings, deleteExpiredCache: false };
  $('cfBedDeleteExpiredCache').checked = false;
  if (wasEnabled) {
    if (storageMode === 'local') scheduleLocalConfigSave();
    else writeBrowserConfig(currentConfig());
  }
  if (message !== lastImageHostCleanupNotice) {
    lastImageHostCleanupNotice = message;
    setSettingsNotice('error', '已自动关闭过期图片删除', message);
    setNotice('error', 'ImgBed 删除权限不足', message);
  }
  return true;
}

async function syncImageHostSettings() {
  const response = await fetch('/api/settings/image-host', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(imageHostSettings),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '无法同步图床设置');
  return { result, disabled: handleImageHostCleanupStatus(result.cleanup) };
}

async function saveImageHostSettings(event) {
  event.preventDefault();
  const settings = imageHostFormSettings();
  if (settings.provider === 'cfbed' && !settings.baseUrl) {
    setNotice('error', '无法保存图床设置', '请填写 CloudFlare ImgBed 站点地址。');
    $('cfBedBaseUrl').focus();
    return;
  }
  const button = $('saveImageHost');
  button.disabled = true;
  try {
    imageHostSettings = settings;
    const targetMode = $('storageMode').value === 'local' ? 'local' : 'browser';
    const config = currentConfig();
    config.imageHost = settings;
    if (targetMode === 'local') {
      await saveCurrentConfigToFile(config);
      clearBrowserConfig();
    } else {
      writeBrowserConfig(config);
      await clearLocalConfigFile();
    }
    storageMode = targetMode;
    localStorage.setItem(STORAGE_MODE_KEY, storageMode);
    renderImageHostSettings();
    $('storageMode').value = storageMode;
    $('storageModeStatus').textContent = storageMode === 'local' ? '当前从本地 config.json 读取' : '当前使用浏览器存储';
    lastImageHostCleanupNotice = '';
    const syncResult = await syncImageHostSettings();
    if (syncResult.disabled) return;
    const cacheText = settings.provider === 'cfbed'
      ? (settings.cacheExpireDays === 0 ? '缓存永不过期' : `缓存 ${settings.cacheExpireDays} 天后重新上传`)
      : '缓存 7 天后重新上传';
    const deleteText = settings.deleteExpiredCache ? '，并每天本地 0 点（当天启动未检查时补做）自动删除过期远程图片' : '';
    const providerText = settings.provider === 'cfbed' ? 'CloudFlare ImgBed' : '路过图床';
    setSettingsNotice('success', '图床设置已保存', `后续图片和 Telegram sticker 将上传到${providerText}，${cacheText}${deleteText}。`);
    setNotice('success', '图床设置已保存', `后续图片和 Telegram sticker 将上传到${providerText}，${cacheText}${deleteText}。`);
  } catch (error) {
    setSettingsNotice('error', '图床设置保存失败', error.message);
    setNotice('error', '图床设置保存失败', error.message);
  } finally { button.disabled = false; }
}

function persistDeviceDraft() {
  if (storageMode === 'local') { scheduleLocalConfigSave(); return; }
  writeDraft(DEVICE_DRAFT_KEY, { sn: fields.deviceSn.value, sid: fields.sid.value, accountType: fields.accountType.value });
}

function persistTelegramDraft() {
  if (storageMode === 'local') { scheduleLocalConfigSave(); return; }
  const draft = {
    proxyEnabled: $('telegramProxyEnabled').checked,
    apiBase: $('telegramApiBase').value,
    token: $('telegramToken').value,
    proxyUrl: $('telegramProxyUrl').value,
  };
  writeDraft(TELEGRAM_DRAFT_KEY, draft);
  try { localStorage.setItem(TELEGRAM_PROXY_KEY, draft.proxyUrl); } catch { /* browser storage may be unavailable */ }
}

function persistTelegramRules() {
  const value = Number($('telegramMaxPerMinute').value);
  const rules = {
    maxPerMinute: Number.isFinite(value) ? Math.max(0, Math.min(100, Math.floor(value))) : 2,
    maxCharsPerTask: Number.isFinite(Number($('telegramMaxCharsPerTask').value)) ? Math.max(0, Math.min(UINT32_MAX, Math.floor(Number($('telegramMaxCharsPerTask').value)))) : 0,
    rateLimitStrikeWindowMinutes: Number.isFinite(Number($('telegramStrikeWindowMinutes').value)) ? Math.max(1, Math.min(1440, Math.floor(Number($('telegramStrikeWindowMinutes').value)))) : 1,
    rateLimitPenaltyMinutes: [1, 2, 3].map((index) => Number.isFinite(Number($(`telegramPenalty${index}`).value)) ? Math.max(0, Math.min(525600, Math.floor(Number($(`telegramPenalty${index}`).value)))) : [2, 10, 1440][index - 1]),
    rateLimitBlacklistOnThird: $('telegramBlacklistOnThird').checked,
    blacklist: telegramBlacklist,
    reply_printing: $('replyPrinting').value,
    reply_printed: $('replyPrinted').value,
    reply_print_failed: $('replyPrintFailed').value,
    reply_unsupported: $('replyUnsupported').value,
    reply_rate_limited: $('replyRateLimited').value,
    sticker_enabled: $('telegramStickerEnabled').checked,
    webm_sticker_enabled: $('telegramWebmStickerEnabled').checked,
    webm_sticker_frame: $('telegramWebmFrame').value,
    photo_enabled: $('telegramPhotoEnabled').checked,
    proxyEnabled: $('telegramProxyEnabled').checked,
  };
  if (storageMode === 'local') { scheduleLocalConfigSave(); return; }
  try { localStorage.setItem(TELEGRAM_RULES_KEY, JSON.stringify(rules)); } catch { /* browser storage may be unavailable */ }
}

function restoreDrafts() {
  const device = readDraft(DEVICE_DRAFT_KEY);
  if (typeof device.sn === 'string') fields.deviceSn.value = device.sn;
  if (typeof device.sid === 'string') fields.sid.value = device.sid;
  if (device.accountType != null || device.account_type != null) fields.accountType.value = String(device.accountType ?? device.account_type);
  const telegram = readDraft(TELEGRAM_DRAFT_KEY);
  if (!fields.deviceSn.value.trim() && typeof telegram.deviceSn === 'string') fields.deviceSn.value = telegram.deviceSn;
  if (!fields.sid.value.trim() && typeof telegram.sid === 'string') fields.sid.value = telegram.sid;
  if (!fields.accountType.value.trim() && (telegram.accountType != null || telegram.account_type != null)) fields.accountType.value = String(telegram.accountType ?? telegram.account_type);
  if (typeof telegram.proxyEnabled === 'boolean') $('telegramProxyEnabled').checked = telegram.proxyEnabled;
  if (typeof telegram.apiBase === 'string' && telegram.apiBase) $('telegramApiBase').value = telegram.apiBase;
  if (typeof telegram.token === 'string') $('telegramToken').value = telegram.token;
  if (typeof telegram.proxyUrl === 'string') $('telegramProxyUrl').value = telegram.proxyUrl;
  syncTelegramDeviceFieldsFromMain();
}

function syncTelegramDeviceFieldsFromMain() {
  $('telegramDeviceSn').value = fields.deviceSn.value;
  $('telegramSid').value = fields.sid.value;
  $('telegramAccountType').value = fields.accountType.value;
}

function syncMainDeviceFieldsFromTelegram() {
  fields.deviceSn.value = $('telegramDeviceSn').value;
  fields.sid.value = $('telegramSid').value;
  fields.accountType.value = $('telegramAccountType').value;
}

function renderSavedDevices() {
  ['savedDevice', 'telegramSavedDevice'].forEach((id) => {
    const select = $(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">选择已保存设备</option>';
    readSavedDevices().forEach((device) => {
      const option = document.createElement('option');
      option.value = JSON.stringify([device.sn, device.sid, device.account_type]);
      option.textContent = `${device.sn} · ${device.sid} · account_type ${device.account_type}`;
      select.appendChild(option);
    });
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  });
}

function saveCurrentDevice() {
  const sn = fields.deviceSn.value.trim();
  const sid = fields.sid.value.trim();
  const accountType = fields.accountType.value.trim();
  if (!sn || !sid || !accountType || !Number.isFinite(Number(accountType))) {
    setNotice('error', '无法保存设备', '请填写有效的设备 SN、设备 SID 和 account_type。');
    return;
  }
  const devices = readSavedDevices();
  const existing = devices.find((device) => device.sn === sn);
  if (existing) {
    existing.sid = sid;
    existing.account_type = Number(accountType);
  } else devices.unshift({ sn, sid, account_type: Number(accountType) });
  writeSavedDevices(devices);
  renderSavedDevices();
  $('savedDevice').value = JSON.stringify([sn, sid, Number(accountType)]);
  setNotice('success', '设备已保存', '设备信息已保存为唯一共享 device，下次可从下拉列表或 Telegram 直接调用。');
}

function loadSavedDevice(value) {
  let device;
  try { device = JSON.parse(value); } catch { return; }
  if (!Array.isArray(device) || device.length < 2) return;
  fields.deviceSn.value = device[0];
  fields.sid.value = device[1];
  fields.accountType.value = String(device[2] ?? 2);
  syncTelegramDeviceFieldsFromMain();
  persistDeviceDraft();
  render();
  setNotice('', '设备已调用', '已加载保存的设备信息，可以直接编辑或发送打印。');
}

function deleteSavedDevice() {
  const selected = $('savedDevice').value;
  if (!selected) return;
  let device;
  try { device = JSON.parse(selected); } catch { return; }
  const sn = device[0];
  writeSavedDevices(readSavedDevices().filter((device) => device.sn !== sn));
  fields.deviceSn.value = '';
  fields.sid.value = '';
  fields.accountType.value = '';
  syncTelegramDeviceFieldsFromMain();
  persistDeviceDraft();
  render();
  renderSavedDevices();
  setNotice('', '设备已删除', '已清除唯一共享 device 的设备信息。');
}

function openJsonImport() {
  $('jsonImportModal').classList.remove('hidden');
  $('jsonImportInput').value = '';
  $('jsonImportInput').focus();
}

function closeJsonImport() {
  $('jsonImportModal').classList.add('hidden');
}

function importDeviceJson() {
  let payload;
  try {
    payload = JSON.parse($('jsonImportInput').value.trim());
  } catch (error) {
    setNotice('error', 'JSON 导入失败', `JSON 格式错误：${error.message}`);
    return;
  }
  const sn = payload && payload.device_sn != null ? String(payload.device_sn).trim() : '';
  const sid = payload && payload.sid != null ? String(payload.sid).trim() : '';
  const accountType = payload && payload.account_type != null ? String(payload.account_type).trim() : '';
  if (!sn || !sid || !accountType || !Number.isFinite(Number(accountType))) {
    setNotice('error', 'JSON 导入失败', 'JSON 顶层必须包含有效的 device_sn、sid 和 account_type。');
    return;
  }
  fields.deviceSn.value = sn;
  fields.sid.value = sid;
  fields.accountType.value = accountType;
  syncTelegramDeviceFieldsFromMain();
  persistDeviceDraft();
  saveCurrentDevice();
  render();
  closeJsonImport();
  setNotice('success', '设备 JSON 已导入', `已提取并选中设备 ${sn}。`);
}

function currentTelegramDevice() {
  return { device_sn: fields.deviceSn.value.trim(), sid: fields.sid.value.trim(), account_type: fields.accountType.value.trim() };
}

function setTelegramActionButton(mode) {
  const button = $('startTelegram');
  if (!button) return;
  const states = {
    start: ['radio', '开始监听', false],
    starting: ['loader-circle', '正在启动…', true],
    stop: ['square', '停止监听', false],
    stopping: ['loader-circle', '正在停止…', true],
  };
  const [icon, label, disabled] = states[mode] || states.start;
  if (button.dataset.mode === mode) return;
  button.dataset.mode = mode;
  button.disabled = disabled;
  button.innerHTML = `<i data-lucide="${icon}"></i><span>${label}</span>`;
  if (window.lucide) lucide.createIcons();
}

function syncTelegramActionButton(running) {
  telegramRunning = Boolean(running);
  if (!telegramActionPending) setTelegramActionButton(telegramRunning ? 'stop' : 'start');
}

async function startTelegram() {
  const wasRunning = telegramRunning;
  telegramActionPending = true;
  setTelegramActionButton('starting');
  const token = $('telegramToken').value.trim();
  const apiBase = $('telegramApiBase').value.trim();
  const proxyEnabled = $('telegramProxyEnabled').checked;
  const proxyUrl = $('telegramProxyUrl').value.trim();
  const requestedLimit = Number($('telegramMaxPerMinute').value);
  const maxPerMinute = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(100, Math.floor(requestedLimit))) : 2;
  const requestedChars = Number($('telegramMaxCharsPerTask').value);
  const maxCharsPerTask = Number.isFinite(requestedChars) ? Math.max(0, Math.min(UINT32_MAX, Math.floor(requestedChars))) : 0;
  const requestedStrikeWindow = Number($('telegramStrikeWindowMinutes').value);
  const rateLimitStrikeWindowMinutes = Number.isFinite(requestedStrikeWindow) ? Math.max(1, Math.min(1440, Math.floor(requestedStrikeWindow))) : 1;
  const rateLimitPenaltyMinutes = [1, 2, 3].map((index) => {
    const value = Number($(`telegramPenalty${index}`).value);
    return Number.isFinite(value) ? Math.max(0, Math.min(525600, Math.floor(value))) : [2, 10, 1440][index - 1];
  });
  const rateLimitBlacklistOnThird = $('telegramBlacklistOnThird').checked;
  const stickerEnabled = $('telegramStickerEnabled').checked;
  const webmStickerEnabled = $('telegramWebmStickerEnabled').checked;
  const webmStickerFrame = $('telegramWebmFrame').value;
  const photoEnabled = $('telegramPhotoEnabled').checked;
  const replies = {
    reply_printing: $('replyPrinting').value.trim(),
    reply_printed: $('replyPrinted').value.trim(),
    reply_print_failed: $('replyPrintFailed').value.trim(),
    reply_unsupported: $('replyUnsupported').value.trim(),
    reply_rate_limited: $('replyRateLimited').value.trim(),
  };
  const device = currentTelegramDevice();
  if (!apiBase || !token || !device.device_sn || !device.sid || !device.account_type || !Number.isFinite(Number(device.account_type)) || (proxyEnabled && !proxyUrl)) {
    setNotice('error', '无法启动 Telegram', proxyEnabled ? '请填写 Telegram API 地址、HTTP 代理地址、Bot Token、设备 SN、设备 SID 和 account_type。' : '请填写 Telegram API 地址、Bot Token、设备 SN、设备 SID 和 account_type。');
    telegramActionPending = false;
    syncTelegramActionButton(wasRunning);
    return;
  }
  try {
    const response = await fetch('/api/telegram/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_base: apiBase, proxy_enabled: proxyEnabled, proxy_url: proxyUrl, max_per_minute: maxPerMinute, max_chars_per_task: maxCharsPerTask, rate_limit_strike_window_minutes: rateLimitStrikeWindowMinutes, rate_limit_penalty_minutes: rateLimitPenaltyMinutes, rate_limit_blacklist_on_third: rateLimitBlacklistOnThird, blacklist: telegramBlacklist, sticker_enabled: stickerEnabled, webm_sticker_enabled: webmStickerEnabled, webm_sticker_frame: webmStickerFrame, photo_enabled: photoEnabled, image_host: imageHostSettings, ...replies, token, ...device }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '启动失败');
    if (storageMode === 'browser') {
      localStorage.setItem(TELEGRAM_API_KEY, apiBase);
      localStorage.setItem(TELEGRAM_PROXY_KEY, proxyUrl);
      localStorage.setItem(TELEGRAM_RULES_KEY, JSON.stringify({ maxPerMinute, maxCharsPerTask, rateLimitStrikeWindowMinutes, rateLimitPenaltyMinutes, rateLimitBlacklistOnThird, blacklist: telegramBlacklist, stickerEnabled, webmStickerEnabled, webmStickerFrame, photoEnabled, ...replies }));
    } else scheduleLocalConfigSave();
    syncTelegramActionButton(true);
    setTelegramStatus('active');
    $('telegramLast').textContent = '监听已启动，正在等待文字、图片或 WebP/WebM sticker。';
    setNotice('success', 'Telegram 已连接', '机器人正在监听私聊文字、图片和已开启的 WebP/WebM sticker。');
  } catch (error) {
    telegramRunning = wasRunning;
    setTelegramStatus('error', '连接失败');
    $('telegramLast').textContent = `错误：${error.message}`;
    setNotice('error', 'Telegram 连接失败', error.message);
  } finally {
    telegramActionPending = false;
    syncTelegramActionButton(telegramRunning);
  }
}

async function stopTelegram() {
  telegramActionPending = true;
  setTelegramActionButton('stopping');
  try {
    const response = await fetch('/api/telegram/stop', { method: 'POST' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '停止失败');
    telegramRunning = false;
    setTelegramStatus('idle');
    $('telegramLast').textContent = '监听已停止。';
    setNotice('', 'Telegram 已停止', '机器人已停止监听。');
  } catch (error) {
    setTelegramStatus('error', '停止失败');
    $('telegramLast').textContent = `错误：${error.message}`;
    setNotice('error', 'Telegram 停止失败', error.message);
  } finally {
    telegramActionPending = false;
    syncTelegramActionButton(telegramRunning);
  }
}

async function pollTelegramStatus() {
  try {
    const result = await fetch('/api/telegram/status').then((response) => response.json());
    syncTelegramActionButton(result.running || Boolean(result.retryCount && result.retryCount <= 3));
    setTelegramStatus(result.error && !result.running ? 'error' : result.retryCount ? 'retrying' : result.running ? 'active' : 'idle');
    if (result.lastMessage) $('telegramLast').textContent = `最近打印：${result.lastMessage}`;
    if (result.error) {
      const retryHint = result.running && result.retryCount ? `（正在重试 ${result.retryCount}/3）` : '';
      $('telegramLast').textContent = `错误：${result.error}${retryHint}`;
    }
    handleImageHostCleanupStatus(result.imageHost?.cleanup);
    const nextBlacklist = Array.isArray(result.blacklist) ? result.blacklist : [];
    if (JSON.stringify(nextBlacklist) !== JSON.stringify(telegramBlacklist)) {
      telegramBlacklist = nextBlacklist;
      renderTelegramBlacklist(telegramBlacklist);
      if (storageMode === 'local') scheduleLocalConfigSave();
      else writeBrowserConfig(currentConfig());
    }
    renderTelegramLogs(result.logs || []);
  } catch { /* server may be restarting */ }
}

function formatBlacklistUntil(blockedUntil) {
  if (blockedUntil === null) return '永久';
  const timestamp = Number(blockedUntil);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN') : '未知';
}

function renderTelegramBlacklist(entries = []) {
  const list = $('telegramBlacklistList');
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = '<div class="telegram-blacklist-empty">暂无封禁用户。</div>';
    return;
  }
  list.innerHTML = entries.map((entry) => {
    const displayName = escapeHtml(entry.name || '未知用户');
    const username = entry.username ? `（${escapeHtml(entry.username.startsWith('@') ? entry.username : `@${entry.username}`)}）` : '';
    const reason = escapeHtml(entry.reason || '多次触发频率限制');
    return `<div class="telegram-blacklist-entry"><div class="telegram-blacklist-content"><strong>${displayName}${username}：</strong><span>${formatBlacklistUntil(entry.blockedUntil)}，${reason}</span></div><button class="button telegram-blacklist-remove" type="button" data-blacklist-user-id="${escapeHtml(String(entry.userId))}">解除</button></div>`;
  }).join('');
}

async function removeTelegramBlacklist(userId) {
  try {
    const response = await fetch(`/api/telegram/blacklist/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '解除封禁失败');
    telegramBlacklist = Array.isArray(result.blacklist) ? result.blacklist : telegramBlacklist.filter((entry) => String(entry.userId) !== String(userId));
    renderTelegramBlacklist(telegramBlacklist);
    if (storageMode === 'local') scheduleLocalConfigSave();
    else writeBrowserConfig(currentConfig());
    setNotice('success', '已解除封禁', `用户 ${userId} 已从黑名单移除。`);
  } catch (error) {
    setNotice('error', '解除封禁失败', error.message);
  }
}

function renderTelegramLogs(logs) {
  const list = $('telegramLogList');
  if (!list) return;
  if (!logs.length) {
    list.innerHTML = '<div class="telegram-log-empty">监听启动后，这里会显示收到的消息、过滤结果、打印状态和回复状态。</div>';
    return;
  }
  const labels = { system: '系统', received: '收到', printing: '打印中', printed: '已打印', failed: '打印失败', filtered: '已过滤', ignored: '已忽略', limited: '已限流', blocked: '已封控', replied: '已回复', reply_failed: '回复失败' };
  list.innerHTML = logs.slice().reverse().map((log) => {
    const time = new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false });
    return `<div class="telegram-log-entry log-${log.type}"><span class="telegram-log-time">${time}</span><span class="telegram-log-badge">${labels[log.type] || log.type}</span><span class="telegram-log-message">${escapeHtml(log.message)}</span>${log.detail ? `<span class="telegram-log-detail">${escapeHtml(log.detail)}</span>` : ''}</div>`;
  }).join('');
}

function setTelegramStatus(state, errorLabel = '异常') {
  const labels = { active: '监听中', retrying: '重试中', error: errorLabel, idle: '未连接' };
  const status = $('telegramStatus');
  const label = labels[state] || labels.idle;
  const className = `telegram-status${state === 'idle' ? '' : ` ${state}`}`;
  telegramStatusState = state;
  if (status.textContent !== label) status.textContent = label;
  if (status.className !== className) status.className = className;
  setMessageStatus(label, state);
  updateTelegramNav(state);
}

function setMessageStatus(value, state) {
  const text = $('messageStatusText');
  if (!text) return;
  if (text.textContent !== value) text.textContent = value;
  const chip = text.closest('.status-chip');
  if (chip && chip.dataset.state !== state) chip.dataset.state = state;
}

function updateTelegramNav(state) {
  const dot = $('navTelegramDot');
  const active = state === 'active' || state === 'retrying';
  if (dot?.classList.contains('active') !== active) dot?.classList.toggle('active', active);
  const value = active ? 'Telegram 监听中' : state === 'retrying' ? 'Telegram 重试中' : state === 'error' ? 'Telegram 监听异常' : $('statusText').textContent;
  if ($('topbarStatus').textContent !== value) $('topbarStatus').textContent = value;
}

function updateTopbarFromPrint() {
  if (telegramStatusState === 'idle') $('topbarStatus').textContent = $('statusText').textContent;
}

function updateTextModeControls(viewId = 'textView') {
  document.querySelectorAll('.developer-only').forEach((element) => element.classList.toggle('hidden-view', !developerMode));
  $('jsonPreview').classList.toggle('hidden-view', developerMode);
  $('jsonEditor').classList.toggle('hidden-view', !developerMode);
  $('printButton').classList.toggle('hidden-view', developerMode);
  document.querySelectorAll('.topnav-link').forEach((button) => {
    const active = button.id === 'messageListenNav'
      ? viewId === 'messageView'
      : button.id === 'settingsNav'
        ? viewId === 'settingsView'
      : viewId === 'textView' && (button.dataset.mode === 'developer' ? developerMode : !developerMode);
    button.classList.toggle('active', active);
  });
}

function generatedJson() {
  return JSON.stringify(buildPayload(), null, 2);
}

function setDeveloperJsonStatus(message, type = '') {
  const status = $('jsonEditorStatus');
  status.textContent = message;
  status.className = `json-editor-status ${type}`.trim();
  $('jsonEditor').classList.toggle('json-editor-invalid', type === 'invalid');
  $('jsonEditor').setAttribute('aria-invalid', String(type === 'invalid'));
}

function setServerResponse(value) {
  $('serverResponse').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function captureServerResponse(response, body) {
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  let parsedBody = body;
  try { parsedBody = body ? JSON.parse(body) : ''; } catch { /* keep non-JSON response bodies as text */ }
  setServerResponse({
    status: response.status,
    status_text: response.statusText,
    headers,
    body: parsedBody,
  });
}

function validateDeveloperJson(showNotice = false) {
  const text = $('jsonEditor').value.trim();
  if (!text) {
    const message = '请求 JSON 不能为空。';
    setDeveloperJsonStatus(message, 'invalid');
    if (showNotice) {
      setNotice('error', 'JSON 格式错误', message);
      $('jsonEditor').focus();
    }
    return { ok: false, error: new Error(message) };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 根节点必须是对象。');
    setDeveloperJsonStatus('JSON 格式正确', 'valid');
    return { ok: true, value };
  } catch (error) {
    const message = `JSON 格式错误：${error.message}`;
    setDeveloperJsonStatus(message, 'invalid');
    if (showNotice) {
      setNotice('error', 'JSON 格式错误', `${error.message} 请修正后再发送。`);
      $('jsonEditor').focus();
    }
    return { ok: false, error };
  }
}

function setDeveloperMode(enabled) {
  developerMode = Boolean(enabled);
  if (developerMode) {
    $('jsonEditor').value = generatedJson();
    developerJsonDirty = false;
    setDeveloperJsonStatus('JSON 可编辑');
  }
  updateTextModeControls('textView');
  render();
}

function switchView(viewId) {
  if (viewId === 'settingsView') setDeveloperMode(false);
  if (viewId === 'messageView') {
    setDeveloperMode(false);
    syncTelegramDeviceFieldsFromMain();
  }
  document.querySelectorAll('.page-view').forEach((view) => {
    const active = view.id === viewId;
    view.classList.toggle('hidden-view', !active);
    view.setAttribute('aria-hidden', String(!active));
  });
  updateTextModeControls(viewId);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderContentList() {
  $('contentList').innerHTML = contentItems.map((item, index) => item.type === 'image' ? `
    <div class="content-item image-item" data-content-index="${index}">
      <div class="content-item-title"><span><i data-lucide="image"></i>图片节点 <small>#${index + 1}</small></span><button class="icon-button remove-content" type="button" title="删除图片节点" aria-label="删除图片节点"><i data-lucide="trash-2"></i></button></div>
      <div class="image-row"><input type="url" value="${escapeAttribute(item.url)}" placeholder="https://example.com/image.png" aria-label="图片 URL ${index + 1}" /><button class="button image-upload-button" type="button"><i data-lucide="${item.url && !item.processedDataUrl ? 'sliders-horizontal' : 'upload'}"></i><span>${item.processedDataUrl ? '重新裁剪' : item.url ? '调整效果' : '上传图片'}</span></button></div>
      <input class="image-file-input" type="file" accept="image/*" hidden />
      <div class="content-item-footer"><span>图片节点对齐方式</span><div class="segmented-control compact-segments" role="group" aria-label="图片节点对齐方式 ${index + 1}">
        <button type="button" class="segment ${(item.alignment ?? 1) === 0 ? 'active' : ''}" data-align="0" title="左对齐"><i data-lucide="align-left"></i></button>
        <button type="button" class="segment ${(item.alignment ?? 1) === 1 ? 'active' : ''}" data-align="1" title="居中"><i data-lucide="align-center"></i></button>
        <button type="button" class="segment ${(item.alignment ?? 1) === 2 ? 'active' : ''}" data-align="2" title="右对齐"><i data-lucide="align-right"></i></button>
      </div></div>
      <p class="field-help image-item-help">${item.processedDataUrl ? '已完成 1:1 裁剪与 Floyd-Steinberg 二值化，打印前会自动上传图床。' : '可直接填写图片 URL，或上传本地图片后裁剪。'}</p>
    </div>
  ` : item.type === 'qrcode' ? `
    <div class="content-item qr-item" data-content-index="${index}">
      <div class="content-item-title"><span><i data-lucide="scan-qr-code"></i>二维码节点 <small>#${index + 1}</small></span><button class="icon-button remove-content" type="button" title="删除二维码节点" aria-label="删除二维码节点"><i data-lucide="trash-2"></i></button></div>
      <textarea rows="2" maxlength="1000" placeholder="输入网址或二维码内容" aria-label="二维码内容 ${index + 1}">${escapeHtml(item.value)}</textarea>
      <div class="content-item-footer"><span>二维码节点对齐方式</span><div class="segmented-control compact-segments" role="group" aria-label="二维码节点对齐方式 ${index + 1}">
        <button type="button" class="segment ${(item.alignment ?? 1) === 0 ? 'active' : ''}" data-align="0" title="左对齐"><i data-lucide="align-left"></i></button>
        <button type="button" class="segment ${(item.alignment ?? 1) === 1 ? 'active' : ''}" data-align="1" title="居中"><i data-lucide="align-center"></i></button>
        <button type="button" class="segment ${(item.alignment ?? 1) === 2 ? 'active' : ''}" data-align="2" title="右对齐"><i data-lucide="align-right"></i></button>
      </div></div>
      <p class="field-help">内容会写入二维码 icon 的 value 字段。</p>
    </div>
  ` : item.type === 'table' ? `
    <div class="content-item table-item" data-content-index="${index}">
      <div class="content-item-title"><span><i data-lucide="table-2"></i>表格节点 <small>#${index + 1}</small></span><button class="icon-button remove-content" type="button" title="删除表格节点" aria-label="删除表格节点"><i data-lucide="trash-2"></i></button></div>
      <div class="table-settings">
        <div class="table-column-settings">
          <span class="table-column-label">列设置 · ${item.columns.length} / 16 列</span>
          <div class="table-column-controls">${item.columns.map((column, columnIndex) => `
            <div class="table-column-control">
              <label for="table-${index}-width-${columnIndex}">第 ${columnIndex + 1} 列宽度值</label>
              <input id="table-${index}-width-${columnIndex}" class="table-width" data-column-index="${columnIndex}" type="number" min="0" max="${UINT32_MAX}" step="1" value="${column.width === null || column.width === undefined || column.width === '' ? '' : columnWidthValue(column.width)}" placeholder="自动" aria-label="表格 ${index + 1} 第 ${columnIndex + 1} 列权重，留空或零表示自适应" />
              <div class="segmented-control compact-segments" role="group" aria-label="表格 ${index + 1} 第 ${columnIndex + 1} 列对齐方式">
                <button type="button" class="segment table-align ${(column.alignment ?? 1) === 0 ? 'active' : ''}" data-column-index="${columnIndex}" data-align="0" title="左对齐"><i data-lucide="align-left"></i></button>
                <button type="button" class="segment table-align ${(column.alignment ?? 1) === 1 ? 'active' : ''}" data-column-index="${columnIndex}" data-align="1" title="居中"><i data-lucide="align-center"></i></button>
                <button type="button" class="segment table-align ${(column.alignment ?? 1) === 2 ? 'active' : ''}" data-column-index="${columnIndex}" data-align="2" title="右对齐"><i data-lucide="align-right"></i></button>
              </div>
            </div>
          `).join('')}</div>
        </div>
        ${item.rows.map((row, rowIndex) => `
          <div class="table-row-editor" data-row-index="${rowIndex}">
            <span class="table-row-label">行 ${rowIndex + 1}</span>
            <div class="table-row-cells">${item.columns.map((column, columnIndex) => `<input class="table-cell-input" data-row-index="${rowIndex}" data-column-index="${columnIndex}" type="text" maxlength="500" value="${escapeAttribute(row[columnIndex] || '')}" placeholder="第 ${columnIndex + 1} 列" aria-label="表格 ${index + 1} 第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列" />`).join('')}</div>
            <button class="table-row-remove" type="button" data-row-index="${rowIndex}" title="删除第 ${rowIndex + 1} 行" aria-label="删除第 ${rowIndex + 1} 行" ${item.rows.length <= 1 ? 'disabled' : ''}><i data-lucide="trash-2"></i></button>
          </div>
        `).join('')}
      </div>
      <div class="font-settings" aria-label="表格字体倍率">
        <label class="font-setting"><span>纵向倍率</span><select class="font-height"><option value="0" ${Number(item.height) === 0 ? 'selected' : ''}>普通</option><option value="1" ${Number(item.height) === 1 ? 'selected' : ''}>放大 1</option><option value="2" ${Number(item.height) === 2 ? 'selected' : ''}>放大 2</option></select></label>
        <label class="font-setting"><span>横向倍率</span><select class="font-width"><option value="0" ${Number(item.width) === 0 ? 'selected' : ''}>普通 · 32 字</option><option value="1" ${Number(item.width) === 1 ? 'selected' : ''}>放大 1 · 16 字</option><option value="2" ${Number(item.width) === 2 ? 'selected' : ''}>放大 2 · 10 字</option></select></label>
      </div>
      <div class="table-actions"><button class="table-action-button table-add-column" type="button" ${item.columns.length >= 16 ? 'disabled' : ''}><i data-lucide="columns-3"></i>添加列</button><button class="table-action-button table-remove-column" type="button" ${item.columns.length <= 1 ? 'disabled' : ''}><i data-lucide="columns-2"></i>删除末列</button><button class="table-action-button table-add-row" type="button"><i data-lucide="rows-3"></i>添加行</button></div>
      <p class="field-help">支持 1 至 16 个安全列。全为正整数时按比例分配；与 0 / 留空混用时，正整数占固定字符槽，自适应列平分余量。每行生成一个独立 content 节点。</p>
    </div>
  ` : item.type === 'scaledText' ? `
    <div class="content-item text-item scaled-text-item" data-content-index="${index}">
      <div class="content-item-title"><span><i data-lucide="text-select"></i>放大文字节点 <small>#${index + 1}</small></span><button class="icon-button remove-content" type="button" title="删除放大文字节点" aria-label="删除放大文字节点"><i data-lucide="trash-2"></i></button></div>
      <textarea rows="2" maxlength="500" placeholder="输入要打印的放大文字" aria-label="放大文字内容 ${index + 1}">${escapeHtml(item.text)}</textarea>
      <div class="font-settings" aria-label="放大文字字体倍率">
        <label class="font-setting"><span>对齐</span><select class="scaled-alignment"><option value="0" ${Number(item.alignment) === 0 ? 'selected' : ''}>左</option><option value="1" ${Number(item.alignment) === 1 ? 'selected' : ''}>中</option><option value="2" ${Number(item.alignment) === 2 ? 'selected' : ''}>右</option></select></label>
        <label class="font-setting"><span>纵向倍率</span><select class="font-height"><option value="0" ${Number(item.height) === 0 ? 'selected' : ''}>普通</option><option value="1" ${Number(item.height) === 1 ? 'selected' : ''}>放大 1</option><option value="2" ${Number(item.height) === 2 ? 'selected' : ''}>放大 2</option></select></label>
        <label class="font-setting"><span>横向倍率</span><select class="font-width"><option value="0" ${Number(item.width) === 0 ? 'selected' : ''}>普通 · 32 字</option><option value="1" ${Number(item.width) === 1 ? 'selected' : ''}>放大 1 · 16 字</option><option value="2" ${Number(item.width) === 2 ? 'selected' : ''}>放大 2 · 10 字</option></select></label>
      </div>
    </div>
  ` : item.type === 'eol' ? `
    <div class="content-item eol-item" data-content-index="${index}">
      <div class="content-item-title"><span><i data-lucide="corner-down-left"></i>空行节点 <small>#${index + 1}</small></span><button class="icon-button remove-content" type="button" title="删除空行节点" aria-label="删除空行节点"><i data-lucide="trash-2"></i></button></div>
      <p class="field-help">打印一行空白，不会把 __EOL__ 显示为文字。</p>
    </div>
  ` : `
    <div class="content-item text-item" data-content-index="${index}">
      <div class="content-item-title"><span><i data-lucide="type"></i>文字节点 <small>#${index + 1}</small></span><button class="icon-button remove-content" type="button" title="删除文字节点" aria-label="删除文字节点"><i data-lucide="trash-2"></i></button></div>
      <div class="text-column-list">${textColumnValues(item).map((value, columnIndex) => `
        <div class="text-column-editor">
          <label for="text-${index}-column-${columnIndex}">文本项 ${columnIndex + 1}</label>
          <textarea id="text-${index}-column-${columnIndex}" class="text-column-input" data-column-index="${columnIndex}" rows="2" maxlength="500" placeholder="输入要打印的文字" aria-label="文字节点 ${index + 1} 文本项 ${columnIndex + 1}">${escapeHtml(value)}</textarea>
          <button class="text-column-remove" data-column-index="${columnIndex}" type="button" title="删除文本项 ${columnIndex + 1}" aria-label="删除文本项 ${columnIndex + 1}" ${textColumnValues(item).length <= 1 ? 'disabled' : ''}><i data-lucide="x"></i></button>
        </div>
      `).join('')}</div>
      <div class="text-column-actions"><span>每行最多 4 项，尾行按实际项数重新均分</span><button class="table-action-button text-column-add" type="button"><i data-lucide="plus"></i>添加文本项</button></div>
      <p class="field-help">普通 text 节点固定左对齐；每项支持自动换行、显式换行与空行。</p>
    </div>
  `).join('');
  $('contentList').querySelectorAll('.content-item').forEach((element) => {
    const index = Number(element.dataset.contentIndex);
    const item = contentItems[index];
    const input = element.querySelector('input[type="url"], textarea');
    if (input && ['image', 'qrcode', 'scaledText'].includes(item.type)) input.addEventListener('input', () => {
      item[item.type === 'image' ? 'url' : item.type === 'qrcode' ? 'value' : 'text'] = input.value;
      if (item.type !== 'image') notifyUnsupportedCharacters(input.value);
      if (item.type === 'image') { item.processedDataUrl = ''; item.sourceDataUrl = ''; item.uploadedUrl = ''; }
      render();
    });
    if (item.type === 'text') {
      element.querySelectorAll('.text-column-input').forEach((field) => field.addEventListener('input', () => {
        const values = textColumnValues(item);
        values[Number(field.dataset.columnIndex)] = field.value;
        item.columns = values;
        notifyUnsupportedCharacters(field.value);
        render();
      }));
      element.querySelector('.text-column-add').addEventListener('click', () => {
        const values = textColumnValues(item);
        values.push('');
        item.columns = values;
        renderContentList();
        render();
      });
      element.querySelectorAll('.text-column-remove').forEach((button) => button.addEventListener('click', () => {
        const values = textColumnValues(item);
        if (values.length <= 1) return;
        values.splice(Number(button.dataset.columnIndex), 1);
        item.columns = values;
        renderContentList();
        render();
      }));
    }
    if (item.type === 'image') {
      const uploadButton = element.querySelector('.image-upload-button');
      const fileInput = element.querySelector('.image-file-input');
      uploadButton.addEventListener('click', async () => {
        if (item.processedDataUrl && item.sourceDataUrl) {
          const sourceBlob = await (await fetch(item.sourceDataUrl)).blob();
          openCropModal(new File([sourceBlob], 'receipt-image', { type: sourceBlob.type || 'image/png' }), index);
          return;
        }
        if (item.url && !item.processedDataUrl) {
          try {
            const response = await fetch(`/api/image?url=${encodeURIComponent(item.url.trim())}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            openCropModal(new File([blob], 'remote-image', { type: blob.type || 'image/png' }), index);
          } catch (error) {
            setNotice('error', '图片无法编辑', `远程图片加载失败：${error.message}`);
          }
          return;
        }
        fileInput.click();
      });
      fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) openCropModal(file, index); fileInput.value = ''; });
    }
    if (item.type === 'table') {
      element.querySelectorAll('.table-cell-input').forEach((cell) => cell.addEventListener('input', () => {
        item.rows[Number(cell.dataset.rowIndex)][Number(cell.dataset.columnIndex)] = cell.value;
        notifyUnsupportedCharacters(cell.value);
        render();
      }));
      element.querySelectorAll('.table-width').forEach((widthInput) => widthInput.addEventListener('change', () => {
        const raw = widthInput.value.trim();
        item.columns[Number(widthInput.dataset.columnIndex)].width = raw === '' ? null : columnWidthValue(raw);
        renderContentList();
        render();
      }));
      element.querySelectorAll('.table-align').forEach((button) => button.addEventListener('click', () => {
        item.columns[Number(button.dataset.columnIndex)].alignment = Number(button.dataset.align);
        renderContentList();
        render();
      }));
      element.querySelectorAll('.table-row-remove').forEach((button) => button.addEventListener('click', () => {
        if (item.rows.length <= 1) return;
        item.rows.splice(Number(button.dataset.rowIndex), 1);
        renderContentList();
        render();
      }));
      element.querySelector('.table-add-row').addEventListener('click', () => {
        item.rows.push(item.columns.map(() => ''));
        renderContentList();
        render();
      });
      element.querySelector('.font-height').addEventListener('change', (event) => { item.height = clamp(Number(event.target.value), 0, 2); renderContentList(); render(); });
      element.querySelector('.font-width').addEventListener('change', (event) => { item.width = clamp(Number(event.target.value), 0, 2); renderContentList(); render(); });
      element.querySelector('.table-add-column').addEventListener('click', () => {
        if (item.columns.length >= 16) return;
        item.columns.push({ width: 15, alignment: 1 });
        item.rows.forEach((row) => row.push(''));
        renderContentList();
        render();
      });
      element.querySelector('.table-remove-column').addEventListener('click', () => {
        if (item.columns.length <= 1) return;
        item.columns.pop();
        item.rows.forEach((row) => row.pop());
        renderContentList();
        render();
      });
    }
    if (item.type === 'scaledText') {
      element.querySelector('.scaled-alignment').addEventListener('change', (event) => { item.alignment = clamp(Number(event.target.value), 0, 2); renderContentList(); render(); });
      element.querySelector('.font-height').addEventListener('change', (event) => { item.height = clamp(Number(event.target.value), 0, 2); renderContentList(); render(); });
      element.querySelector('.font-width').addEventListener('change', (event) => { item.width = clamp(Number(event.target.value), 0, 2); renderContentList(); render(); });
    }
    element.querySelector('.remove-content').addEventListener('click', () => { contentItems.splice(index, 1); renderContentList(); render(); });
    if (['image', 'qrcode'].includes(item.type)) element.querySelectorAll('.segment').forEach((button) => button.addEventListener('click', () => {
      item.alignment = Number(button.dataset.align);
      renderContentList();
      render();
    }));
  });
  lucide.createIcons();
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(value) { return escapeAttribute(value).replace(/'/g, '&#39;'); }

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function textColumnValues(item) {
  if (Array.isArray(item.columns) && item.columns.length) return item.columns;
  return [typeof item.text === 'string' ? item.text : ''];
}

function columnWidthValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return clamp(Math.trunc(number), 0, UINT32_MAX);
}

function tableColumnWidth(column) {
  return column.width === null || column.width === undefined || column.width === '' ? null : columnWidthValue(column.width);
}

function drawCropEditor() {
  if (!cropState) return;
  const { canvas, context, image, displayWidth, displayHeight, offsetX, offsetY, crop } = cropState;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#eef2f7';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, offsetX, offsetY, displayWidth, displayHeight);
  const selection = $('cropSelection');
  const displayScale = canvas.clientWidth / canvas.width || 1;
  selection.style.left = `${crop.x * displayScale}px`;
  selection.style.top = `${crop.y * displayScale}px`;
  selection.style.width = `${crop.size * displayScale}px`;
  selection.style.height = `${crop.size * displayScale}px`;
  $('cropSizeRange').value = String(Math.round(crop.size));
  $('cropSizeLabel').textContent = `${Math.round(crop.size)} × ${Math.round(crop.size)} px 选区`;
}

function resizeCropSelection(size) {
  if (!cropState) return;
  const maxSize = Math.min(cropState.displayWidth, cropState.displayHeight);
  cropState.crop.size = clamp(size, 1, maxSize);
  cropState.crop.x = clamp(cropState.crop.x, cropState.offsetX, cropState.offsetX + cropState.displayWidth - cropState.crop.size);
  cropState.crop.y = clamp(cropState.crop.y, cropState.offsetY, cropState.offsetY + cropState.displayHeight - cropState.crop.size);
  drawCropEditor();
}

function openCropModal(file, itemIndex) {
  if (!file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      const canvas = $('cropCanvas');
      const maxDisplay = 320;
      const scale = Math.min(maxDisplay / image.width, maxDisplay / image.height);
      const displayWidth = Math.max(1, Math.round(image.width * scale));
      const displayHeight = Math.max(1, Math.round(image.height * scale));
      canvas.width = maxDisplay;
      canvas.height = maxDisplay;
      const offsetX = Math.round((maxDisplay - displayWidth) / 2);
      const offsetY = Math.round((maxDisplay - displayHeight) / 2);
      const size = Math.min(displayWidth, displayHeight);
      const item = contentItems[itemIndex] || {};
      const isPng = file.type.toLowerCase() === 'image/png';
      cropState = { image, sourceDataUrl: reader.result, itemIndex, isPng, phase: 'crop', alphaBackground: item.alphaBackground || 'white', canvas, context: canvas.getContext('2d'), displayWidth, displayHeight, offsetX, offsetY, crop: { x: offsetX, y: offsetY, size }, gamma: Number(item.gamma) || 1, contrast: Number(item.contrast) || 0 };
      $('cropModal').classList.remove('hidden');
      $('cropStage').classList.remove('hidden');
      $('cropMeta').classList.remove('hidden');
      $('cropWorkspace').classList.remove('processing');
      $('cropResult').classList.add('hidden');
      $('toneControls').classList.add('hidden');
      $('transparencyControl').classList.add('hidden');
      $('applyCrop').innerHTML = '<i data-lucide="arrow-right"></i><span>应用裁剪并继续</span>';
      $('cancelCrop').textContent = '取消';
      lucide.createIcons();
      $('cropSizeRange').min = String(Math.max(1, Math.min(size, Math.round(Math.min(displayWidth, displayHeight) * 0.15))));
      $('cropSizeRange').max = String(size);
      $('gammaRange').value = String(cropState.gamma);
      $('contrastRange').value = String(cropState.contrast);
      $('transparencyMode').value = cropState.alphaBackground;
      updateToneLabels();
      drawCropEditor();
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function closeCropModal() {
  cropState = null;
  $('cropModal').classList.add('hidden');
}

function applyToneAdjustments(value, gamma, contrast) {
  const gammaAdjusted = 255 * Math.pow(clamp(value, 0, 255) / 255, 1 / gamma);
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  return clamp(factor * (gammaAdjusted - 128) + 128, 0, 255);
}

function applyFloydSteinberg(canvas, gamma = 1, contrast = 0, alphaBackground = 'white') {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const width = canvas.width;
  const height = canvas.height;
  const gray = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = pixels.data[index + 3] / 255;
      const background = alphaBackground === 'black' ? 0 : 255;
      const luminance = (pixels.data[index] * 0.299 + pixels.data[index + 1] * 0.587 + pixels.data[index + 2] * 0.114) * alpha + background * (1 - alpha);
      gray[y * width + x] = applyToneAdjustments(luminance, gamma, contrast);
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const position = y * width + x;
      const oldValue = gray[position];
      const newValue = oldValue < 128 ? 0 : 255;
      const error = oldValue - newValue;
      gray[position] = newValue;
      if (x + 1 < width) gray[position + 1] += error * 7 / 16;
      if (y + 1 < height) {
        if (x > 0) gray[position + width - 1] += error * 3 / 16;
        gray[position + width] += error * 5 / 16;
        if (x + 1 < width) gray[position + width + 1] += error / 16;
      }
    }
  }
  for (let index = 0; index < gray.length; index += 1) {
    const value = gray[index] < 128 ? 0 : 255;
    const pixel = index * 4;
    pixels.data[pixel] = value;
    pixels.data[pixel + 1] = value;
    pixels.data[pixel + 2] = value;
    pixels.data[pixel + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
}

function createProcessedCropCanvas() {
  if (!cropState) return null;
  const { image, crop, offsetX, offsetY, displayWidth, gamma, contrast, alphaBackground } = cropState;
  const output = document.createElement('canvas');
  output.width = MAX_IMAGE_SIZE;
  output.height = MAX_IMAGE_SIZE;
  const context = output.getContext('2d', { willReadFrequently: true });
  context.clearRect(0, 0, MAX_IMAGE_SIZE, MAX_IMAGE_SIZE);
  const sourceX = (crop.x - offsetX) / displayWidth * image.width;
  const sourceY = (crop.y - offsetY) / cropState.displayHeight * image.height;
  const sourceSize = crop.size / displayWidth * image.width;
  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, MAX_IMAGE_SIZE, MAX_IMAGE_SIZE);
  applyFloydSteinberg(output, gamma, contrast, alphaBackground);
  return output;
}

function drawProcessedCropPreview() {
  const processed = createProcessedCropCanvas();
  if (!processed) return;
  const preview = $('cropPreviewCanvas');
  preview.width = MAX_IMAGE_SIZE;
  preview.height = MAX_IMAGE_SIZE;
  preview.getContext('2d').drawImage(processed, 0, 0);
}

function updateToneLabels() {
  if (!cropState) return;
  $('gammaValue').textContent = cropState.gamma.toFixed(2);
  $('contrastValue').textContent = cropState.contrast > 0 ? `+${cropState.contrast}` : String(cropState.contrast);
}

function enterProcessingStep() {
  if (!cropState || cropState.phase !== 'crop') return;
  cropState.phase = 'processing';
  $('cropStage').classList.add('hidden');
  $('cropMeta').classList.add('hidden');
  $('cropWorkspace').classList.add('processing');
  $('cropResult').classList.remove('hidden');
  $('toneControls').classList.remove('hidden');
  $('transparencyControl').classList.toggle('hidden', !cropState.isPng);
  $('applyCrop').innerHTML = '<i data-lucide="check"></i><span>完成并使用图片</span>';
  $('cancelCrop').textContent = '返回裁剪';
  lucide.createIcons();
  drawProcessedCropPreview();
}

function finishImageProcessing() {
  if (!cropState) return;
  const { itemIndex, gamma, contrast } = cropState;
  const sourceCanvas = createProcessedCropCanvas();
  const item = contentItems[itemIndex];
  if (item) {
    item.sourceDataUrl = cropState.sourceDataUrl;
    item.processedDataUrl = sourceCanvas.toDataURL('image/png');
    item.gamma = gamma;
    item.contrast = contrast;
    item.alphaBackground = cropState.alphaBackground;
    item.url = '';
    item.uploadedUrl = '';
  }
  closeCropModal();
  renderContentList();
  render();
}

function backToCropStep() {
  if (!cropState || cropState.phase !== 'processing') return closeCropModal();
  cropState.phase = 'crop';
  $('cropStage').classList.remove('hidden');
  $('cropMeta').classList.remove('hidden');
  $('cropWorkspace').classList.remove('processing');
  $('cropResult').classList.add('hidden');
  $('toneControls').classList.add('hidden');
  $('transparencyControl').classList.add('hidden');
  $('applyCrop').innerHTML = '<i data-lucide="arrow-right"></i><span>应用裁剪并继续</span>';
  $('cancelCrop').textContent = '取消';
  lucide.createIcons();
  drawCropEditor();
}

function loadImageFromUrl(url) {
  return fetch(`/api/image?url=${encodeURIComponent(url)}`).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return createImageBitmap(await response.blob());
  });
}

function characterWidth(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint > 0xff || /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uff01-\uff60\uffe0-\uffe6]/u.test(character)) return 2;
  if (character === '8') return 1.45;
  if (/[MWmw@#%&]/.test(character)) return 1.4;
  if (/[1\s.,:;!'`|iIl\[\]()]/.test(character)) return 1;
  return 1;
}

function splitTextIntoLines(text, capacity = TEXT_LINE_CAPACITY) {
  const lines = [];
  printableText(text).replace(/\r\n/g, '\n').split('\n').forEach((paragraph) => {
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

function tableColumnCapacity(columns, columnIndex, widthLevel = 0) {
  return Math.max(1, Math.floor(tableColumnLayout(columns, widthLevel)[columnIndex] || 1));
}

function totalTextCapacity(widthLevel = 0) {
  return [32, 16, 10][clamp(Number(widthLevel) || 0, 0, 2)];
}

function tableColumnLayout(columns, widthLevel = 0) {
  const capacity = totalTextCapacity(widthLevel);
  const weights = columns.map((column) => Math.max(0, tableColumnWidth(column) ?? 0));
  const positiveTotal = weights.reduce((sum, value) => sum + value, 0);
  const zeroCount = weights.filter((value) => value === 0).length;
  if (!positiveTotal) return weights.map(() => capacity / Math.max(1, weights.length));
  if (!zeroCount) return weights.map((value) => capacity * value / positiveTotal);
  const fixedTotal = Math.min(capacity, positiveTotal);
  const scale = positiveTotal > capacity ? fixedTotal / positiveTotal : 1;
  const remaining = Math.max(0, capacity - fixedTotal);
  const zeroShare = zeroCount ? remaining / zeroCount : 0;
  return weights.map((value) => value > 0 ? value * scale : zeroShare);
}

function textFlowLines(columns, widthLevel = 0) {
  const values = columns.map((value) => printableText(value));
  const capacity = totalTextCapacity(widthLevel);
  const rows = [];
  for (let offset = 0; offset < values.length; offset += 4) {
    const group = values.slice(offset, offset + 4);
    const columnCapacity = capacity / Math.max(1, group.length);
    const lines = group.map((value) => splitTextIntoLines(value, columnCapacity));
    const rowCount = Math.max(...lines.map((items) => items.length), 1);
    for (let row = 0; row < rowCount; row += 1) {
      rows.push({ columns: lines.map((items) => items[row] ?? '') });
    }
  }
  return rows;
}

function notifyUnsupportedCharacters(value) {
  if (containsUnsupportedText(value)) setNotice('', '不支持的字符将被忽略', '这台打印机不支持部分 emoji、上下标和修饰字符；它们不会出现在预览和打印内容中，点击“发送打印”仍会继续发送请求。');
}

function buildPayload() {
  const root = [];
  contentItems.forEach((item) => {
    const alignment = Number.isInteger(item.alignment) ? item.alignment : 1;
    if (item.type === 'image' && item.url.trim()) root.push({ icon: { value: item.url.trim(), style: { justification: alignment }, type: 3 } });
    if (item.type === 'qrcode' && printableText(item.value).trim()) root.push({ icon: { value: printableText(item.value).trim(), style: { justification: alignment }, type: 1 } });
    if (item.type === 'text') {
      const columns = textColumnValues(item).map((value) => printableText(value));
      if (columns.some((value) => value.trim())) root.push({ text: { column: columns.map((value) => ({ value })), column_align: columns.map(() => ({})) } });
    }
    if (item.type === 'eol') root.push({ text: { column: [{ value: '__EOL__' }], column_align: [{}] } });
    const scaledText = printableText(item.text);
    if (item.type === 'scaledText' && scaledText.trim()) root.push({ content: {
      column_align: [{ column_width: 32, style: { justification: alignment } }],
      lines: { linelist: [{ column: [scaledText] }] },
      maxcolumn: 1,
      style: { height: clamp(Number(item.height) || 0, 0, 2), width: clamp(Number(item.width) || 0, 0, 2), justification: alignment },
    } });
    if (item.type === 'table') item.rows.forEach((row) => {
      const printableRow = row.map((value) => printableText(value));
      if (!printableRow.some((value) => value.trim())) return;
      root.push({ content: {
        column_align: item.columns.map((column) => {
          const columnWidth = tableColumnWidth(column);
          return {
            ...(columnWidth === null ? {} : { column_width: columnWidth }),
            style: { justification: Number.isInteger(column.alignment) ? column.alignment : 1 },
          };
        }),
        lines: { linelist: [{ column: item.columns.map((_, columnIndex) => printableRow[columnIndex] || '') }] },
        maxcolumn: item.columns.length,
        style: { height: clamp(Number(item.height) || 0, 0, 2), justification: 1, width: clamp(Number(item.width) || 0, 0, 2) },
      } });
    });
  });
  return {
    device_sn: fields.deviceSn.value.trim(),
    ad_content: {
      user_define_template: {
        root,
      },
    },
    account_type: Number(fields.accountType.value),
    sid: fields.sid.value.trim(),
  };
}

function render() {
  const preview = $('receiptContent');
  preview.innerHTML = contentItems.map((item, index) => item.type === 'image'
    ? `<div class="receipt-image-wrap align-${item.alignment ?? 1}" id="receiptImageWrap-${index}"><canvas role="img" aria-label="第 ${index + 1} 张小票图片二值化预览"></canvas></div>`
      : item.type === 'qrcode'
      ? `<div class="receipt-qr-wrap align-${item.alignment ?? 1}" id="receiptQrWrap-${index}"><div class="receipt-qr" role="img" aria-label="第 ${index + 1} 个二维码预览">${printableText(item.value).trim() ? '' : '<span class="receipt-qr-empty">请输入二维码内容</span>'}</div></div>`
      : item.type === 'table'
        ? `<div class="receipt-table-wrap font-height-${Number(item.height) || 0} font-width-${Number(item.width) || 0}" id="receiptTableWrap-${index}">${item.rows.filter((row) => row.some((value) => printableText(value).trim())).map((row) => { const layout = tableColumnLayout(item.columns, item.width); return `<div class="receipt-table-row" style="grid-template-columns:${layout.map((value) => `${Math.max(.01, value)}fr`).join(' ')}">${item.columns.map((column, columnIndex) => { const capacity = tableColumnCapacity(item.columns, columnIndex, item.width); const alignment = Number.isInteger(column.alignment) ? column.alignment : 1; return `<div class="receipt-table-cell align-${alignment}" style="text-align:${alignment === 0 ? 'left' : alignment === 2 ? 'right' : 'center'}">${splitTextIntoLines(row[columnIndex] || '', capacity).map((line) => `<span class="receipt-table-cell-line">${escapeHtml(line) || '&nbsp;'}</span>`).join('')}</div>`; }).join('')}</div>`; }).join('')}</div>`
      : item.type === 'scaledText'
        ? `<div class="receipt-text scaled-receipt-text align-${item.alignment ?? 1} font-height-${Number(item.height) || 0} font-width-${Number(item.width) || 0}" style="text-align:${item.alignment === 0 ? 'left' : item.alignment === 2 ? 'right' : 'center'}">${printableText(item.text) ? splitTextIntoLines(item.text, totalTextCapacity(item.width)).map((line) => `<span class="receipt-text-line">${escapeHtml(line) || '&nbsp;'}</span>`).join('') : ''}</div>`
      : item.type === 'eol'
        ? '<div class="receipt-eol" aria-label="空行"></div>'
        : (textColumnValues(item).some((value) => printableText(value).trim()) ? `<div class="receipt-text align-0">${textFlowLines(textColumnValues(item)).map((row) => `<div class="receipt-text-flow-row">${row.columns.map((value) => `<span class="receipt-text-flow-cell">${escapeHtml(value) || '&nbsp;'}</span>`).join('')}</div>`).join('')}</div>` : '')).join('');
  renderBinaryPreview(contentItems.filter((item) => item.type === 'image'));
  renderQrPreviews();
  const json = generatedJson();
  $('jsonPreview').textContent = json;
  if (!developerMode || !developerJsonDirty) $('jsonEditor').value = json;
}

function renderQrPreviews() {
  contentItems.forEach((item, index) => {
    const value = printableText(item.value).trim();
    if (item.type !== 'qrcode' || !value) return;
    const target = $(`receiptQrWrap-${index}`)?.querySelector('.receipt-qr');
    if (!target) return;
    target.replaceChildren();
    if (typeof QRCode !== 'function') {
      target.textContent = '二维码预览不可用';
      return;
    }
    new QRCode(target, {
      text: value,
      width: 132,
      height: 132,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  });
}

function drawBinaryPreview(source, canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  canvas.width = source.width;
  canvas.height = source.height;
  const pixels = context.createImageData(source.width, source.height);
  pixels.data.set(source.data);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const value = pixels.data[index] < 128 ? 0 : 255;
    pixels.data[index] = value;
    pixels.data[index + 1] = value;
    pixels.data[index + 2] = value;
  }
  context.putImageData(pixels, 0, 0);
}

async function renderBinaryPreview(imageItems) {
  const renderId = ++imageRenderId;
  if (!imageItems.length) return;
  try {
    await Promise.all(imageItems.map(async (item, index) => {
      const imageUrl = item.url.trim();
      const canvas = $(`receiptImageWrap-${contentItems.indexOf(item)}`)?.querySelector('canvas');
      if (!canvas || (!imageUrl && !item.processedDataUrl)) return;
      if (item.processedDataUrl) {
        const bitmap = await createImageBitmap(await (await fetch(item.processedDataUrl)).blob());
        if (renderId !== imageRenderId) { bitmap.close(); return; }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        return;
      }
      const cached = previewSources.get(imageUrl);
      if (cached) { drawBinaryPreview(cached, canvas); return; }
      const response = await fetch(`/api/image?url=${encodeURIComponent(imageUrl)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      if (renderId !== imageRenderId) { bitmap.close(); return; }
      const scale = Math.min(1, MAX_IMAGE_SIZE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = width;
      sourceCanvas.height = height;
      const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
      sourceContext.fillStyle = '#fff';
      sourceContext.fillRect(0, 0, width, height);
      sourceContext.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      const pixels = sourceContext.getImageData(0, 0, width, height);
      for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
        const alpha = pixels.data[pixel + 3] / 255;
        const luminance = (pixels.data[pixel] * 0.299 + pixels.data[pixel + 1] * 0.587 + pixels.data[pixel + 2] * 0.114) * alpha + 255 * (1 - alpha);
        pixels.data[pixel] = luminance;
        pixels.data[pixel + 1] = luminance;
        pixels.data[pixel + 2] = luminance;
        pixels.data[pixel + 3] = 255;
      }
      applyFloydSteinberg(sourceCanvas);
      const processed = sourceContext.getImageData(0, 0, width, height);
      const source = { width, height, data: processed.data.slice() };
      previewSources.set(imageUrl, source);
      drawBinaryPreview(source, canvas);
    }));
  } catch {
    if (renderId !== imageRenderId) return;
    imageItems.forEach((item) => {
      const canvas = $(`receiptImageWrap-${contentItems.indexOf(item)}`)?.querySelector('canvas');
      if (!canvas) return;
      const context = canvas.getContext('2d');
      canvas.width = 220;
      canvas.height = 158;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#8795a6';
      context.font = '12px sans-serif';
      context.textAlign = 'center';
      context.fillText('图片暂时无法加载', canvas.width / 2, canvas.height / 2);
    });
  }
}

function setNotice(type, title, message) {
  const notice = $('notice');
  notice.className = `notice ${type || ''}`.trim();
  notice.querySelector('strong').textContent = title;
  notice.querySelector('p').textContent = message;
  const icon = notice.querySelector('[data-lucide]');
  icon.setAttribute('data-lucide', type === 'error' ? 'triangle-alert' : type === 'success' ? 'circle-check' : 'info');
  lucide.createIcons();
}

async function printReceipt() {
  let sidExpired = false;
  let developerPayload = null;
  if (developerMode) {
    const validation = validateDeveloperJson(true);
    if (!validation.ok) return;
    developerPayload = validation.value;
  }
  const deviceSn = fields.deviceSn.value.trim();
  const sid = fields.sid.value.trim();
  const requestDeviceSn = developerMode ? String(developerPayload.device_sn || '').trim() : deviceSn;
  const requestSid = developerMode ? String(developerPayload.sid || '').trim() : sid;
  const requestAccountType = developerMode ? developerPayload.account_type : fields.accountType.value.trim();
  const accountTypeText = requestAccountType == null ? '' : String(requestAccountType).trim();
  if (!requestDeviceSn || !requestSid || !accountTypeText || !Number.isFinite(Number(accountTypeText))) {
    setNotice('error', '还缺少设备信息', developerMode ? '请在请求 JSON 中填写有效的 device_sn、sid 和 account_type，再发送打印请求。' : '请填写有效的设备 SN、设备 SID 和 account_type，再发送打印请求。');
    if (developerMode) {
      setDeveloperJsonStatus('JSON 中必须包含有效的 device_sn、sid 和 account_type。', 'invalid');
      $('jsonEditor').focus();
    } else fields[!deviceSn ? 'deviceSn' : !sid ? 'sid' : 'accountType'].focus();
    return;
  }
  const button = developerMode ? $('developerPrintButton') : $('printButton');
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<i data-lucide="loader-circle"></i><span>发送中…</span>';
  lucide.createIcons();
  setNotice('', '正在发送', '正在连接微信支付打印接口，请稍候。');
  try {
    if (!developerMode) {
      for (const item of contentItems) {
        if (item.type !== 'image' || !item.processedDataUrl || item.uploadedUrl) continue;
        setNotice('', '正在上传图片', '正在将处理后的图片上传到当前图床，请稍候。');
        const uploadResponse = await fetch('/api/image-host/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: item.processedDataUrl, settings: imageHostSettings }) });
        const uploadResult = await uploadResponse.json().catch(() => ({}));
        if (!uploadResponse.ok || !uploadResult.directUrl) throw new Error(uploadResult.error || '图片上传失败');
        item.url = uploadResult.directUrl;
        item.uploadedUrl = uploadResult.directUrl;
      }
      renderContentList();
      render();
    }
    const finalValidation = developerMode ? validateDeveloperJson(true) : { ok: true, value: buildPayload() };
    if (!finalValidation.ok) return;
    const requestPayload = finalValidation.value;
    const response = await fetch(`${API_URL}${encodeURIComponent(developerMode ? requestPayload.sid : sid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(developerMode ? requestPayload : buildPayload()),
    });
    const responseText = await response.text();
    if (developerMode) await captureServerResponse(response, responseText);
    let responseBody;
    try { responseBody = responseText ? JSON.parse(responseText) : {}; } catch { responseBody = {}; }
    if (isSidExpired(responseBody) || isSidExpired(responseText)) {
      sidExpired = true;
      throw new Error('SID 已失效');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (typeof responseBody.errcode === 'number' && responseBody.errcode !== 0) {
      throw new Error(responseBody.msg || `接口业务错误码 ${responseBody.errcode}`);
    }
    setNotice('success', '打印请求已发送', '设备接口返回成功，请检查小票机是否开始出纸。');
    $('statusText').textContent = '已发送';
    updateTopbarFromPrint();
  } catch (error) {
    if (sidExpired) {
      setNotice('error', 'SID 已失效', developerMode ? '请在请求 JSON 中重新填写有效的 sid 后再发送。' : '请重新填写设备 SID 后再发送。');
      $('statusText').textContent = 'SID 已失效';
      const target = developerMode ? $('jsonEditor') : fields.sid;
      target.focus();
      if (!developerMode) target.select();
      updateTopbarFromPrint();
      return;
    }
    if (developerMode) setServerResponse({ error: error.message, message: '未收到服务器响应' });
    const corsHint = error instanceof TypeError ? '浏览器可能拦截了跨域请求（CORS），请将页面部署到具备代理能力的服务端，或在同源环境调用接口。' : `接口返回异常：${error.message}`;
    setNotice('error', '打印请求失败', corsHint);
    $('statusText').textContent = '请求失败';
    updateTopbarFromPrint();
  } finally {
    button.disabled = false;
    button.innerHTML = original;
    lucide.createIcons();
  }
}

function clearForm() {
  fields.deviceSn.value = '';
  fields.sid.value = '';
  fields.accountType.value = '';
  syncTelegramDeviceFieldsFromMain();
  persistDeviceDraft();
  contentItems = [
    { type: 'text', columns: [''] },
  ];
  developerJsonDirty = false;
  renderContentList();
  setNotice('', '打印前检查', '请确认设备 SN、SID、account_type 已填写，并确保当前网络可以访问微信支付打印接口。');
  $('statusText').textContent = '准备打印';
  updateTopbarFromPrint();
  render();
}

[fields.deviceSn, fields.sid, fields.accountType].forEach((element) => element.addEventListener('input', () => {
  syncTelegramDeviceFieldsFromMain();
  persistDeviceDraft();
  render();
}));
$('telegramSavedDevice').addEventListener('change', (event) => {
  let device;
  try { device = JSON.parse(event.target.value); } catch { return; }
  if (!Array.isArray(device)) return;
  fields.deviceSn.value = device[0] || '';
  fields.sid.value = device[1] || '';
  fields.accountType.value = String(device[2] ?? 2);
  syncTelegramDeviceFieldsFromMain();
  persistDeviceDraft();
  render();
});
$('useSavedTelegramDevice').addEventListener('click', () => {
  const value = $('telegramSavedDevice').value;
  if (!value) return;
  let device;
  try { device = JSON.parse(value); } catch { return; }
  if (!Array.isArray(device)) return;
  fields.deviceSn.value = device[0] || '';
  fields.sid.value = device[1] || '';
  fields.accountType.value = String(device[2] ?? 2);
  syncTelegramDeviceFieldsFromMain();
  persistDeviceDraft();
  render();
});
$('textPrintNav').addEventListener('click', () => { switchView('textView'); setDeveloperMode(false); });
$('messageListenNav').addEventListener('click', () => switchView('messageView'));
$('developerModeNav').addEventListener('click', () => { switchView('textView'); setDeveloperMode(true); });
$('settingsNav').addEventListener('click', () => switchView('settingsView'));
$('addImage').addEventListener('click', () => { contentItems.push({ type: 'image', url: '', alignment: 1 }); renderContentList(); render(); });
$('addQrCode').addEventListener('click', () => { contentItems.push({ type: 'qrcode', value: '', alignment: 1 }); renderContentList(); render(); });
$('addTable').addEventListener('click', () => { contentItems.push({ type: 'table', columns: [{ width: 15, alignment: 0 }, { width: 15, alignment: 2 }], rows: [['', '']], height: 0, width: 0 }); renderContentList(); render(); });
$('addText').addEventListener('click', () => { contentItems.push({ type: 'text', columns: [''] }); renderContentList(); render(); });
$('addScaledText').addEventListener('click', () => { contentItems.push({ type: 'scaledText', text: '', alignment: 1, height: 1, width: 1 }); renderContentList(); render(); });
$('addEol').addEventListener('click', () => { contentItems.push({ type: 'eol' }); renderContentList(); render(); });
$('saveDevice').addEventListener('click', saveCurrentDevice);
$('importDeviceJson').addEventListener('click', openJsonImport);
$('savedDevice').addEventListener('change', (event) => loadSavedDevice(event.target.value));
$('deleteDevice').addEventListener('click', deleteSavedDevice);
$('telegramForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (telegramActionPending) return;
  if (telegramRunning) stopTelegram();
  else startTelegram();
});
$('clearForm').addEventListener('click', clearForm);
$('printButton').addEventListener('click', printReceipt);
$('developerPrintButton').addEventListener('click', printReceipt);
$('closeCropModal').addEventListener('click', closeCropModal);
$('cancelCrop').addEventListener('click', () => {
  if (cropState?.phase === 'processing') backToCropStep();
  else closeCropModal();
});
$('applyCrop').addEventListener('click', () => {
  if (!cropState) return;
  if (cropState.phase === 'crop') enterProcessingStep();
  else finishImageProcessing();
});
$('cropSizeRange').addEventListener('input', (event) => resizeCropSelection(Number(event.target.value)));
$('gammaRange').addEventListener('input', (event) => {
  if (!cropState) return;
  cropState.gamma = Number(event.target.value) || 1;
  updateToneLabels();
  drawProcessedCropPreview();
});
$('contrastRange').addEventListener('input', (event) => {
  if (!cropState) return;
  cropState.contrast = Number(event.target.value) || 0;
  updateToneLabels();
  drawProcessedCropPreview();
});
$('transparencyMode').addEventListener('change', (event) => {
  if (!cropState) return;
  cropState.alphaBackground = event.target.value === 'black' ? 'black' : 'white';
  drawProcessedCropPreview();
});
$('cropModal').addEventListener('click', (event) => { if (event.target === $('cropModal')) closeCropModal(); });
$('closeJsonImport').addEventListener('click', closeJsonImport);
$('cancelJsonImport').addEventListener('click', closeJsonImport);
$('confirmJsonImport').addEventListener('click', importDeviceJson);
$('jsonImportModal').addEventListener('click', (event) => { if (event.target === $('jsonImportModal')) closeJsonImport(); });

let cropDrag = null;
$('cropSelection').addEventListener('pointerdown', (event) => {
  if (!cropState) return;
  event.preventDefault();
  const handle = event.target.closest('.crop-handle');
  cropDrag = { mode: handle ? 'resize' : 'move', handle: handle?.className || '', startX: event.clientX, startY: event.clientY, start: { ...cropState.crop } };
  $('cropSelection').setPointerCapture?.(event.pointerId);
});
$('cropSelection').addEventListener('pointermove', (event) => {
  if (!cropDrag || !cropState) return;
  const rect = $('cropCanvas').getBoundingClientRect();
  const scale = rect.width ? $('cropCanvas').width / rect.width : 1;
  const dx = (event.clientX - cropDrag.startX) * scale;
  const dy = (event.clientY - cropDrag.startY) * scale;
  const bounds = { left: cropState.offsetX, top: cropState.offsetY, right: cropState.offsetX + cropState.displayWidth, bottom: cropState.offsetY + cropState.displayHeight };
  if (cropDrag.mode === 'move') {
    cropState.crop.x = clamp(cropDrag.start.x + dx, bounds.left, bounds.right - cropState.crop.size);
    cropState.crop.y = clamp(cropDrag.start.y + dy, bounds.top, bounds.bottom - cropState.crop.size);
  } else {
    const delta = Math.max(dx, dy, -dx, -dy);
    const next = cropDrag.handle.includes('nw') || cropDrag.handle.includes('ne') ? cropDrag.start.size - delta : cropDrag.start.size + delta;
    resizeCropSelection(next);
  }
  drawCropEditor();
});
$('cropSelection').addEventListener('pointerup', () => { cropDrag = null; });
$('copyJson').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(developerMode ? $('jsonEditor').value : $('jsonPreview').textContent);
    $('copyJson').querySelector('span').textContent = '已复制';
    setTimeout(() => { $('copyJson').querySelector('span').textContent = '复制'; }, 1500);
  } catch { setNotice('error', '复制失败', '当前浏览器不允许访问剪贴板，请手动选择 JSON 文本复制。'); }
});
$('resetDeveloperJson').addEventListener('click', () => {
  $('jsonEditor').value = generatedJson();
  developerJsonDirty = false;
  setDeveloperJsonStatus('JSON 已恢复为当前票面内容', 'valid');
});
$('copyServerResponse').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('serverResponse').textContent);
    $('copyServerResponse').querySelector('span').textContent = '已复制';
    setTimeout(() => { $('copyServerResponse').querySelector('span').textContent = '复制'; }, 1500);
  } catch { setNotice('error', '复制失败', '当前浏览器不允许访问剪贴板，请手动选择返回数据复制。'); }
});
$('jsonEditor').addEventListener('input', () => {
  developerJsonDirty = true;
  notifyUnsupportedCharacters($('jsonEditor').value);
  validateDeveloperJson(false);
});

renderSavedDevices();
$('imageHostProvider').addEventListener('change', () => {
  const isCfBed = $('imageHostProvider').value === 'cfbed';
  $('cfBedFields').classList.toggle('hidden-view', !isCfBed);
});
$('storageMode').addEventListener('change', (event) => {
  const nextMode = event.target.value === 'local' ? 'local' : 'browser';
  $('storageModeStatus').textContent = nextMode === 'local' ? '保存图床设置后写入程序目录的 config.json' : '保存图床设置后写入当前浏览器';
});
$('imageHostForm').addEventListener('submit', saveImageHostSettings);
imageHostSettings = readImageHostSettings();
renderImageHostSettings();
$('telegramApiBase').value = 'https://api.telegram.org';
if (storageMode === 'browser') {
  restoreDrafts();
  renderSavedDevices();
  $('telegramApiBase').value = readDraft(TELEGRAM_DRAFT_KEY).apiBase || localStorage.getItem(TELEGRAM_API_KEY) || $('telegramApiBase').value;
  $('telegramProxyUrl').value = localStorage.getItem(TELEGRAM_PROXY_KEY) || '';
  try {
    const rules = JSON.parse(localStorage.getItem(TELEGRAM_RULES_KEY) || '{}');
    if (Object.prototype.hasOwnProperty.call(rules, 'maxPerMinute')) $('telegramMaxPerMinute').value = rules.maxPerMinute;
    if (Object.prototype.hasOwnProperty.call(rules, 'maxCharsPerTask') || Object.prototype.hasOwnProperty.call(rules, 'max_chars_per_task')) $('telegramMaxCharsPerTask').value = rules.maxCharsPerTask ?? rules.max_chars_per_task;
    if (Object.prototype.hasOwnProperty.call(rules, 'rateLimitStrikeWindowMinutes')) $('telegramStrikeWindowMinutes').value = rules.rateLimitStrikeWindowMinutes;
    if (Array.isArray(rules.rateLimitPenaltyMinutes)) [1, 2, 3].forEach((index) => { if (Number.isFinite(Number(rules.rateLimitPenaltyMinutes[index - 1]))) $(`telegramPenalty${index}`).value = rules.rateLimitPenaltyMinutes[index - 1]; });
    if (Object.prototype.hasOwnProperty.call(rules, 'rateLimitBlacklistOnThird')) $('telegramBlacklistOnThird').checked = rules.rateLimitBlacklistOnThird === true;
    if (Array.isArray(rules.blacklist)) { telegramBlacklist = rules.blacklist; renderTelegramBlacklist(telegramBlacklist); }
    if (Object.prototype.hasOwnProperty.call(rules, 'stickerEnabled') || Object.prototype.hasOwnProperty.call(rules, 'sticker_enabled')) {
      const stickerEnabled = Object.prototype.hasOwnProperty.call(rules, 'stickerEnabled') ? rules.stickerEnabled : rules.sticker_enabled;
      $('telegramStickerEnabled').checked = stickerEnabled !== false;
      $('telegramStickerState').textContent = $('telegramStickerEnabled').checked ? '已开启' : '已关闭';
    }
    if (Object.prototype.hasOwnProperty.call(rules, 'webmStickerEnabled') || Object.prototype.hasOwnProperty.call(rules, 'webm_sticker_enabled')) {
      const webmStickerEnabled = Object.prototype.hasOwnProperty.call(rules, 'webmStickerEnabled') ? rules.webmStickerEnabled : rules.webm_sticker_enabled;
      $('telegramWebmStickerEnabled').checked = webmStickerEnabled !== false;
      $('telegramWebmStickerState').textContent = $('telegramWebmStickerEnabled').checked ? '已开启' : '已关闭';
    }
    if (['first', 'second', 'penultimate', 'last'].includes(rules.webmStickerFrame || rules.webm_sticker_frame)) $('telegramWebmFrame').value = rules.webmStickerFrame || rules.webm_sticker_frame;
    if (Object.prototype.hasOwnProperty.call(rules, 'photoEnabled') || Object.prototype.hasOwnProperty.call(rules, 'photo_enabled')) {
      const photoEnabled = Object.prototype.hasOwnProperty.call(rules, 'photoEnabled') ? rules.photoEnabled : rules.photo_enabled;
      $('telegramPhotoEnabled').checked = photoEnabled !== false;
      $('telegramPhotoState').textContent = $('telegramPhotoEnabled').checked ? '已开启' : '已关闭';
    }
    const replyFields = { replyPrinting: 'reply_printing', replyPrinted: 'reply_printed', replyPrintFailed: 'reply_print_failed', replyUnsupported: 'reply_unsupported', replyRateLimited: 'reply_rate_limited' };
    Object.entries(replyFields).forEach(([id, key]) => { if (Object.prototype.hasOwnProperty.call(rules, key)) $(id).value = rules[key]; });
  } catch { /* ignore invalid local preferences */ }
}
$('telegramProxyEnabled').addEventListener('change', (event) => {
  updateProxyControls();
  persistTelegramDraft();
});
updateProxyControls();
[$('telegramDeviceSn'), $('telegramSid'), $('telegramAccountType')].filter(Boolean).forEach((element) => element.addEventListener('input', () => {
  syncMainDeviceFieldsFromTelegram();
  persistDeviceDraft();
  render();
}));
[$('telegramApiBase'), $('telegramToken'), $('telegramProxyUrl')].filter(Boolean).forEach((element) => element.addEventListener('input', persistTelegramDraft));
[$('telegramMaxPerMinute'), $('telegramMaxCharsPerTask'), $('telegramStrikeWindowMinutes'), $('telegramPenalty1'), $('telegramPenalty2'), $('telegramPenalty3'), $('replyPrinting'), $('replyPrinted'), $('replyPrintFailed'), $('replyUnsupported'), $('replyRateLimited')].filter(Boolean).forEach((element) => element.addEventListener('input', persistTelegramRules));
$('telegramBlacklistOnThird').addEventListener('change', persistTelegramRules);
$('telegramBlacklistList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-blacklist-user-id]');
  if (button) removeTelegramBlacklist(button.dataset.blacklistUserId);
});
$('telegramStickerEnabled').addEventListener('change', (event) => {
  $('telegramStickerState').textContent = event.target.checked ? '已开启' : '已关闭';
  persistTelegramRules();
});
$('telegramWebmStickerEnabled').addEventListener('change', (event) => {
  $('telegramWebmStickerState').textContent = event.target.checked ? '已开启' : '已关闭';
  persistTelegramRules();
});
$('telegramWebmFrame').addEventListener('change', persistTelegramRules);
$('telegramPhotoEnabled').addEventListener('change', (event) => {
  $('telegramPhotoState').textContent = event.target.checked ? '已开启' : '已关闭';
  persistTelegramRules();
});
$('clearTelegramLogs').addEventListener('click', async () => {
  await fetch('/api/telegram/logs/clear', { method: 'POST' });
  renderTelegramLogs([]);
});
storageMode = browserStorageMode();
function updateStorageModeDisplay() {
  $('storageMode').value = storageMode;
  $('storageModeStatus').textContent = storageMode === 'local' ? '当前从本地 config.json 读取' : '当前使用浏览器存储';
}
updateStorageModeDisplay();
renderContentList();
render();
lucide.createIcons();
if (document.fonts?.ready) document.fonts.ready.then(render);
pollTelegramStatus();
setInterval(pollTelegramStatus, 2500);
loadLocalConfig().then((loaded) => {
  if (loaded) { updateStorageModeDisplay(); renderContentList(); render(); }
  else if (storageMode === 'local') {
    storageMode = 'browser';
    localStorage.setItem(STORAGE_MODE_KEY, storageMode);
    updateStorageModeDisplay();
    setNotice('error', '本地配置不可用', '未找到有效的 config.json，已回退到浏览器配置。');
  }
}).catch((error) => {
  if (storageMode === 'local') {
    storageMode = 'browser';
    localStorage.setItem(STORAGE_MODE_KEY, storageMode);
    updateStorageModeDisplay();
    setNotice('error', '本地配置读取失败', `${error.message}，已回退到浏览器配置。`);
  }
}).then(() => syncImageHostSettings().catch(() => {}));
