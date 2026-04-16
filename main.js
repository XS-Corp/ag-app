const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  shell,
  dialog,
  globalShortcut,
  Menu,
  desktopCapturer,
  systemPreferences
} = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath, pathToFileURL } = require('url');
const AdmZip = require('adm-zip');
const { DEFAULT_LANG, getMenuStrings, getUiStrings, normalizeLang } = require('./i18n');

const APP_ROOT = __dirname;
const DEFAULT_HOMEPAGE = 'https://search.kickedstorm.com/';
const EMPTY_EXT_THEME = '/* no extension theme active */\n';
const SEARCH_FALLBACK_PREFIX = 'https://www.google.com/search?q=';
const SAFE_BROWSER_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_VIEW_EXTERNAL_PROTOCOLS = new Set(['mailto:', 'tel:']);
const SAFE_UI_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const HOSTLIKE_INPUT_RE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#].*)?$/i;
const LOCAL_HOST_INPUT_RE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i;
const LOOPBACK_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;
const DISPLAY_SOURCE_THUMBNAIL_SIZE = { width: 360, height: 220 };
const AUTO_ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);
const ALWAYS_ALLOW_PERMISSIONS = new Set(['storage-access', 'top-level-storage-access']);
const REQUESTABLE_PERMISSION_CHECKS = new Set(['media', 'storage-access', 'top-level-storage-access']);
const PROMPTED_PERMISSIONS = new Set([
  'media',
  'display-capture',
  'fileSystem',
  'geolocation',
  'notifications',
  'clipboard-read',
  'idle-detection',
  'openExternal',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
  'window-management',
  'keyboardLock'
]);

let win;
let tabs = [];
let activeTabId = null;
let nextId = 1;
let downloads = [];
let loadedExtensions = [];
let uiHidden = false;
let store = {};
let closedTabsStack = []; // for Cmd/Ctrl+Shift+T (reopen closed tab)
let activeHtmlOverridePath = null;
let nextPermissionPromptId = 1;
let permissionPromptQueue = Promise.resolve();
const pendingPermissionPrompts = new Map();

function getRuntimeRoot() {
  return app.getPath('userData');
}

function getBundledExtensionsDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'extensions');
  }
  return path.join(APP_ROOT, 'extensions');
}

function getRuntimeExtensionsDir() {
  return path.join(getRuntimeRoot(), 'extensions');
}

function getRuntimeThemeFile() {
  return path.join(getRuntimeRoot(), 'ext-theme.css');
}

function getBundledIndexHtml() {
  return path.join(APP_ROOT, 'index.html');
}

function getCurrentIndexHtml() {
  return activeHtmlOverridePath || getBundledIndexHtml();
}

function getRuntimeThemeHref() {
  return pathToFileURL(getRuntimeThemeFile()).toString();
}

function safeParseUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || '').trim());
  } catch {
    return null;
  }
}

function normalizeRawUrlInput(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return '';
  if (HOSTLIKE_INPUT_RE.test(input)) {
    const scheme = LOCAL_HOST_INPUT_RE.test(input) ? 'http' : 'https';
    return `${scheme}://${input}`;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)) {
    return input;
  }
  if (input.includes('.') && !/\s/.test(input)) {
    return `https://${input}`;
  }
  return '';
}

function resolveBrowserUrl(rawUrl, { fallbackUrl = DEFAULT_HOMEPAGE, allowSearchFallback = true } = {}) {
  const fallbackParsed = safeParseUrl(fallbackUrl);
  const safeFallback = fallbackParsed && SAFE_BROWSER_PROTOCOLS.has(fallbackParsed.protocol)
    ? fallbackParsed.toString()
    : DEFAULT_HOMEPAGE;

  const input = String(rawUrl || '').trim();
  const normalized = normalizeRawUrlInput(input);
  if (normalized) {
    const parsed = safeParseUrl(normalized);
    if (parsed && SAFE_BROWSER_PROTOCOLS.has(parsed.protocol)) {
      return parsed.toString();
    }
    return safeFallback;
  }

  if (!input) return safeFallback;
  if (!allowSearchFallback) return safeFallback;
  return `${SEARCH_FALLBACK_PREFIX}${encodeURIComponent(input)}`;
}

function isSafeBrowserUrl(rawUrl) {
  const parsed = safeParseUrl(rawUrl);
  return !!parsed && SAFE_BROWSER_PROTOCOLS.has(parsed.protocol);
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isAllowedUiFileUrl(rawUrl) {
  const parsed = safeParseUrl(rawUrl);
  if (!parsed || parsed.protocol !== 'file:') return false;

  try {
    const targetPath = fs.realpathSync(fileURLToPath(parsed));
    const allowedRoots = [APP_ROOT, getRuntimeExtensionsDir()]
      .filter(fs.existsSync)
      .map(root => fs.realpathSync(root));
    return allowedRoots.some(root => isPathInside(targetPath, root));
  } catch {
    return false;
  }
}

function isSecureOrigin(origin) {
  const parsed = safeParseUrl(origin);
  return !!parsed && parsed.protocol === 'https:';
}

function isTrustworthyPermissionOrigin(origin) {
  const parsed = safeParseUrl(origin);
  if (!parsed) return false;
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && LOOPBACK_HOST_RE.test(parsed.hostname);
}

function isExtensionOrigin(origin) {
  const parsed = safeParseUrl(origin);
  if (!parsed) return false;
  if (parsed.protocol === 'chrome-extension:') return true;
  if (parsed.protocol !== 'file:') return false;

  try {
    const targetPath = fs.realpathSync(fileURLToPath(parsed));
    const runtimeExtDir = getRuntimeExtensionsDir();
    if (!fs.existsSync(runtimeExtDir)) return false;
    return isPathInside(targetPath, fs.realpathSync(runtimeExtDir));
  } catch {
    return false;
  }
}

function openExternalUrl(rawUrl, allowedProtocols) {
  const parsed = safeParseUrl(rawUrl);
  if (!parsed || !allowedProtocols.has(parsed.protocol)) return false;
  void shell.openExternal(parsed.toString());
  return true;
}

function formatString(template, replacements = {}) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = replacements[key];
    return value == null ? '' : String(value);
  });
}

function getCurrentUiStrings() {
  return getUiStrings(store.settings?.lang || DEFAULT_LANG);
}

function getOriginFromUrl(rawUrl) {
  const parsed = safeParseUrl(rawUrl);
  if (!parsed) return '';
  if (parsed.origin && parsed.origin !== 'null') return parsed.origin;
  return parsed.href || '';
}

function getRequestOrigin(details = {}) {
  return getOriginFromUrl(
    details.securityOrigin ||
    details.requestingOrigin ||
    details.requestingUrl ||
    details.externalURL
  );
}

function getSiteDisplayName(origin) {
  const parsed = safeParseUrl(origin);
  return parsed?.hostname || origin || 'Unknown site';
}

function ensurePermissionStore() {
  if (!store.permissions || typeof store.permissions !== 'object') {
    store.permissions = {};
  }
}

function getPermissionBucket(origin, create = false) {
  ensurePermissionStore();
  if (!origin) return null;
  if (!store.permissions[origin] && create) {
    store.permissions[origin] = {};
  }
  return store.permissions[origin] || null;
}

function getStoredPermissionDecision(origin, key) {
  return getPermissionBucket(origin)?.[key] || null;
}

function setStoredPermissionDecision(origin, key, decision) {
  if (!origin || !key) return;

  if (!decision) {
    const bucket = getPermissionBucket(origin);
    if (!bucket) return;
    delete bucket[key];
    if (!Object.keys(bucket).length) {
      delete store.permissions[origin];
    }
    saveStore();
    return;
  }

  const bucket = getPermissionBucket(origin, true);
  bucket[key] = decision;
  saveStore();
}

function clearStoredPermissionDecisions() {
  store.permissions = {};
  saveStore();
}

function queuePermissionPrompt(task) {
  const scheduled = permissionPromptQueue.then(task, task);
  permissionPromptQueue = scheduled.catch(() => undefined);
  return scheduled;
}

function resolvePendingPermissionPrompt(id, response) {
  const entry = pendingPermissionPrompts.get(id);
  if (!entry) return false;
  pendingPermissionPrompts.delete(id);
  entry.resolve(response);
  return true;
}

function denyAllPendingPermissionPrompts() {
  for (const [id, entry] of pendingPermissionPrompts.entries()) {
    entry.resolve({ id, action: 'deny', remember: false });
  }
  pendingPermissionPrompts.clear();
}

function promptInUi(payload) {
  if (!win || win.isDestroyed()) {
    return Promise.resolve({ action: 'deny', remember: false });
  }

  return queuePermissionPrompt(() => new Promise((resolve) => {
    const id = nextPermissionPromptId++;
    pendingPermissionPrompts.set(id, { resolve });
    win.webContents.send('permission:prompt', { id, ...payload });
  }));
}

function getPermissionStorageKeys(permission, details = {}) {
  switch (permission) {
    case 'media': {
      const wantsAudio = details.mediaTypes?.includes('audio') || details.mediaType === 'audio';
      const wantsVideo = details.mediaTypes?.includes('video') || details.mediaType === 'video';
      const keys = [];
      if (wantsVideo || !wantsAudio) keys.push('camera');
      if (wantsAudio || !wantsVideo) keys.push('microphone');
      return Array.from(new Set(keys));
    }
    case 'display-capture':
      return ['displayCapture'];
    case 'fileSystem':
      return [details.fileAccessType === 'writable' ? 'fileSystemWrite' : 'fileSystemRead'];
    case 'geolocation':
      return ['geolocation'];
    case 'notifications':
      return ['notifications'];
    case 'clipboard-read':
      return ['clipboardRead'];
    case 'idle-detection':
      return ['idleDetection'];
    case 'openExternal':
      return ['openExternal'];
    case 'speaker-selection':
      return ['speakerSelection'];
    case 'storage-access':
    case 'top-level-storage-access':
      return ['storageAccess'];
    case 'window-management':
      return ['windowManagement'];
    case 'keyboardLock':
      return ['keyboardLock'];
    default:
      return [];
  }
}

function getStoredPermissionResult(permission, details = {}) {
  const origin = getRequestOrigin(details);
  const keys = getPermissionStorageKeys(permission, details);
  if (!origin || !keys.length) return null;

  let sawAllow = false;
  for (const key of keys) {
    const stored = getStoredPermissionDecision(origin, key);
    if (stored === 'deny') return false;
    if (stored === 'allow') sawAllow = true;
    if (!stored) return null;
  }
  return sawAllow ? true : null;
}

function persistPermissionDecision(permission, details, allowed) {
  const origin = getRequestOrigin(details);
  const keys = getPermissionStorageKeys(permission, details);
  if (!origin || !keys.length) return;

  for (const key of keys) {
    setStoredPermissionDecision(origin, key, allowed ? 'allow' : 'deny');
  }
}

function getPermissionLabelKey(permission, details = {}) {
  switch (permission) {
    case 'media': {
      const wantsAudio = details.mediaTypes?.includes('audio') || details.mediaType === 'audio';
      const wantsVideo = details.mediaTypes?.includes('video') || details.mediaType === 'video';
      if (wantsAudio && wantsVideo) return 'permissionLabelCameraAndMicrophone';
      if (wantsVideo) return 'permissionLabelCamera';
      return 'permissionLabelMicrophone';
    }
    case 'display-capture':
      return 'permissionLabelScreen';
    case 'fileSystem':
      return 'permissionLabelFiles';
    case 'geolocation':
      return 'permissionLabelLocation';
    case 'notifications':
      return 'permissionLabelNotifications';
    case 'clipboard-read':
      return 'permissionLabelClipboard';
    case 'idle-detection':
      return 'permissionLabelIdleDetection';
    case 'openExternal':
      return 'permissionLabelExternalApps';
    case 'speaker-selection':
      return 'permissionLabelSpeakerSelection';
    case 'storage-access':
    case 'top-level-storage-access':
      return 'permissionLabelCookiesAndStorage';
    case 'window-management':
      return 'permissionLabelWindowManagement';
    case 'keyboardLock':
      return 'permissionLabelKeyboardLock';
    default:
      return 'permissionLabelAdditionalAccess';
  }
}

function getPermissionPromptNote(permission, details = {}, strings = getCurrentUiStrings()) {
  if (permission === 'fileSystem') {
    const parts = [
      details.fileAccessType === 'writable'
        ? strings.permissionFileWriteNote
        : strings.permissionFileReadNote
    ];
    if (details.isDirectory) parts.push(strings.permissionFolderNote);
    return parts.filter(Boolean).join(' ');
  }

  if (permission === 'display-capture' && process.platform === 'darwin') {
    return strings.permissionScreenNoteMac;
  }

  if (permission === 'storage-access' || permission === 'top-level-storage-access') {
    return strings.permissionStorageAccessNote || '';
  }

  return '';
}

function buildPermissionPromptPayload(permission, details = {}) {
  const strings = getCurrentUiStrings();
  const origin = getRequestOrigin(details);
  const site = getSiteDisplayName(origin);
  const label = strings[getPermissionLabelKey(permission, details)] || strings.permissionLabelStorageAccess || strings.permissionLabelAdditionalAccess;
  const messageKey = permission === 'display-capture'
    ? 'permissionScreenPromptMessage'
    : 'permissionPromptMessage';
  const allowAlways = ALWAYS_ALLOW_PERMISSIONS.has(permission);

  return {
    kind: 'permission',
    title: label,
    site,
    origin,
    originLabel: strings.permissionOrigin,
    message: formatString(strings[messageKey], { site, permission: label }),
    note: getPermissionPromptNote(permission, details, strings),
    allowLabel: permission === 'display-capture'
      ? strings.permissionShare
      : (allowAlways ? (strings.permissionAllowOnce || strings.permissionAllow) : strings.permissionAllow),
    alwaysAllowLabel: allowAlways ? (strings.permissionAlwaysAllow || strings.permissionAllow) : '',
    denyLabel: permission === 'display-capture' ? strings.permissionCancel : strings.permissionDeny,
    rememberLabel: allowAlways ? '' : strings.permissionRemember,
    canRemember: !allowAlways
  };
}

function serializeDisplaySource(source, strings) {
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? strings.permissionSourceScreen : strings.permissionSourceWindow,
    thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : '',
    icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : ''
  };
}

function buildDisplaySourcePromptPayload(request, sources) {
  const strings = getCurrentUiStrings();
  const origin = getOriginFromUrl(request.securityOrigin);
  const site = getSiteDisplayName(origin);

  return {
    kind: 'display-source',
    title: strings.permissionSelectSource,
    site,
    origin,
    originLabel: strings.permissionOrigin,
    message: formatString(strings.permissionScreenPromptMessage, { site }),
    note: process.platform === 'darwin' ? strings.permissionScreenNoteMac : '',
    allowLabel: strings.permissionShare,
    denyLabel: strings.permissionCancel,
    canRemember: false,
    sources: sources.map(source => serializeDisplaySource(source, strings))
  };
}

async function showPermissionWarning(message) {
  if (!message || !win || win.isDestroyed()) return;
  await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'AG Browser',
    message
  });
}

async function ensureSystemMediaAccess(mediaType) {
  if (process.platform !== 'darwin') return true;

  const strings = getCurrentUiStrings();
  const blockedMessage = mediaType === 'camera'
    ? strings.permissionSystemCameraDenied
    : strings.permissionSystemMicrophoneDenied;

  const status = systemPreferences.getMediaAccessStatus(mediaType);
  if (status === 'granted' || status === 'unknown') return true;
  if (status === 'not-determined') {
    try {
      const granted = await systemPreferences.askForMediaAccess(mediaType);
      if (granted) return true;
    } catch {
      // fall through to warning
    }
  }

  await showPermissionWarning(blockedMessage);
  return false;
}

function canRequestSystemMediaAccess(mediaType) {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus(mediaType);
  return status !== 'denied' && status !== 'restricted';
}

async function ensureMediaSystemAccess(details = {}) {
  const mediaKeys = getPermissionStorageKeys('media', details);
  for (const mediaKey of mediaKeys) {
    const systemMediaType = mediaKey === 'camera' ? 'camera' : 'microphone';
    const systemAllowed = await ensureSystemMediaAccess(systemMediaType);
    if (!systemAllowed) return false;
  }
  return true;
}

function canPotentiallyRequestMediaAccess(details = {}) {
  const mediaKeys = getPermissionStorageKeys('media', details);
  return mediaKeys.every((mediaKey) => {
    const systemMediaType = mediaKey === 'camera' ? 'camera' : 'microphone';
    return canRequestSystemMediaAccess(systemMediaType);
  });
}

function getAutoPermissionDecision(permission, details = {}) {
  const origin = getRequestOrigin(details);
  if (isExtensionOrigin(origin)) return true;
  if (AUTO_ALLOWED_PERMISSIONS.has(permission)) return true;

  switch (permission) {
    case 'pointerLock':
      return isTrustworthyPermissionOrigin(origin);
    case 'mediaKeySystem':
      return isSecureOrigin(origin);
    default:
      return null;
  }
}

function canPromptPermission(permission, details = {}) {
  const origin = getRequestOrigin(details);
  if (!origin) return false;

  switch (permission) {
    case 'media':
    case 'display-capture':
    case 'fileSystem':
    case 'geolocation':
    case 'notifications':
    case 'clipboard-read':
    case 'idle-detection':
    case 'speaker-selection':
    case 'storage-access':
    case 'top-level-storage-access':
    case 'window-management':
    case 'keyboardLock':
      return isTrustworthyPermissionOrigin(origin);
    case 'openExternal': {
      const target = safeParseUrl(details.externalURL);
      return !!target && !SAFE_BROWSER_PROTOCOLS.has(target.protocol) && isTrustworthyPermissionOrigin(origin);
    }
    default:
      return false;
  }
}

async function requestPermissionFromUser(permission, details = {}) {
  const autoDecision = getAutoPermissionDecision(permission, details);
  if (autoDecision !== null) {
    if (autoDecision && permission === 'media') {
      return ensureMediaSystemAccess(details);
    }
    return autoDecision;
  }

  const storedDecision = getStoredPermissionResult(permission, details);
  if (storedDecision !== null) {
    if (storedDecision && permission === 'media') {
      return ensureMediaSystemAccess(details);
    }
    return storedDecision;
  }
  if (!PROMPTED_PERMISSIONS.has(permission) || !canPromptPermission(permission, details)) return false;

  const response = await promptInUi(buildPermissionPromptPayload(permission, details));
  const allowed = response?.action === 'allow' || response?.action === 'allow-always';

  if (allowed && permission === 'media') {
    const systemAllowed = await ensureMediaSystemAccess(details);
    if (!systemAllowed) return false;
  }

  const shouldPersistAllow = response?.action === 'allow-always' || (!!response?.remember && allowed);
  const shouldPersistDeny = !!response?.remember && !allowed && !ALWAYS_ALLOW_PERMISSIONS.has(permission);

  if (shouldPersistAllow) {
    persistPermissionDecision(permission, details, true);
  } else if (shouldPersistDeny) {
    persistPermissionDecision(permission, details, false);
  }

  return allowed;
}

function getPermissionCheckDecision(permission, details = {}) {
  const autoDecision = getAutoPermissionDecision(permission, details);
  if (autoDecision !== null) {
    if (autoDecision && permission === 'media') {
      return canPotentiallyRequestMediaAccess(details);
    }
    return autoDecision;
  }

  if (!canPromptPermission(permission, details)) return false;

  const storedDecision = getStoredPermissionResult(permission, details);
  if (storedDecision === false) return false;
  if (storedDecision === true) {
    if (permission === 'media') {
      return canPotentiallyRequestMediaAccess(details);
    }
    return true;
  }

  if (REQUESTABLE_PERMISSION_CHECKS.has(permission)) {
    if (permission === 'media') {
      return canPotentiallyRequestMediaAccess(details);
    }
    return true;
  }

  return false;
}

async function handleDisplayMediaRequest(request, callback) {
  const origin = getOriginFromUrl(request.securityOrigin);
  const strings = getCurrentUiStrings();

  if (!origin || !isTrustworthyPermissionOrigin(origin) || request.userGesture === false) {
    if (request.userGesture === false) {
      await showPermissionWarning(strings.permissionRequiresGesture);
    }
    callback({});
    return;
  }

  if (getStoredPermissionDecision(origin, 'displayCapture') === 'deny') {
    callback({});
    return;
  }

  if (process.platform === 'darwin') {
    const screenStatus = systemPreferences.getMediaAccessStatus('screen');
    if (screenStatus === 'denied' || screenStatus === 'restricted') {
      await showPermissionWarning(strings.permissionSystemScreenDenied);
      callback({});
      return;
    }
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: DISPLAY_SOURCE_THUMBNAIL_SIZE,
    fetchWindowIcons: true
  });

  if (!sources.length) {
    await showPermissionWarning(strings.permissionNoDisplaySources);
    callback({});
    return;
  }

  const response = await promptInUi(buildDisplaySourcePromptPayload(request, sources));
  if (response?.action !== 'allow' || !response.sourceId) {
    callback({});
    return;
  }

  const selectedSource = sources.find(source => source.id === response.sourceId);
  if (!selectedSource) {
    callback({});
    return;
  }

  const streams = {};
  if (request.videoRequested !== false) {
    streams.video = selectedSource;
  }
  if (request.audioRequested && process.platform === 'win32') {
    streams.audio = 'loopbackWithMute';
  }

  callback(streams);
}

function configureSessionSecurity(sess) {
  sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
    void requestPermissionFromUser(permission, { ...details, requestingOrigin: getRequestOrigin(details) })
      .then((allowed) => callback(allowed))
      .catch((error) => {
        console.warn(`Permission request failed for ${permission}:`, error.message);
        callback(false);
      });
  });

  if (typeof sess.setDisplayMediaRequestHandler === 'function') {
    sess.setDisplayMediaRequestHandler((request, callback) => {
      void handleDisplayMediaRequest(request, callback).catch((error) => {
        console.warn('Display media request failed:', error.message);
        callback({});
      });
    });
  }

  if (typeof sess.setPermissionCheckHandler === 'function') {
    sess.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details = {}) => {
      const requestDetails = { ...details, requestingOrigin };
      return getPermissionCheckDecision(permission, requestDetails);
    });
  }
}

function loadSafeUrl(webContents, rawUrl, options) {
  const targetUrl = resolveBrowserUrl(rawUrl, options);
  return webContents.loadURL(targetUrl).catch((error) => {
    console.warn(`Failed to load ${targetUrl}: ${error.message}`);
    return false;
  });
}

function sameTabState(a, b) {
  return !!a && !!b &&
    a.id === b.id &&
    a.url === b.url &&
    a.title === b.title &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.pinned === b.pinned &&
    a.favicon === b.favicon &&
    a.loading === b.loading;
}

function emitTabUpdate(tab) {
  if (!win || !tab) return;
  const serialized = serializeTab(tab);
  if (sameTabState(serialized, tab.lastBroadcastState)) return;
  tab.lastBroadcastState = serialized;
  win.webContents.send('tab:updated', serialized);
}

function queueTabUpdate(tab) {
  if (!tab || tab.updateTimer) return;
  tab.updateTimer = setTimeout(() => {
    tab.updateTimer = null;
    if (!tabs.some(current => current.id === tab.id)) return;
    emitTabUpdate(tab);
  }, 16);
}

function clearQueuedTabUpdate(tab) {
  if (tab?.updateTimer) {
    clearTimeout(tab.updateTimer);
    tab.updateTimer = null;
  }
}

function ensureRuntimeFiles() {
  fs.mkdirSync(getRuntimeExtensionsDir(), { recursive: true });
  if (!fs.existsSync(getRuntimeThemeFile())) {
    fs.writeFileSync(getRuntimeThemeFile(), EMPTY_EXT_THEME);
  }
}

function syncBundledExtensions() {
  ensureRuntimeFiles();
  const bundledExtDir = getBundledExtensionsDir();
  if (!fs.existsSync(bundledExtDir)) return;

  const bundledDirs = fs.readdirSync(bundledExtDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));

  for (const dir of bundledDirs) {
    if (store.extensions?.[dir.name]?.removed) continue;
    const src = path.join(bundledExtDir, dir.name);
    const dst = path.join(getRuntimeExtensionsDir(), dir.name);
    fs.cpSync(src, dst, { recursive: true, force: true });
  }
}

function resetRuntimeTheme() {
  ensureRuntimeFiles();
  fs.writeFileSync(getRuntimeThemeFile(), EMPTY_EXT_THEME);
}

async function unloadLoadedExtensions(sess) {
  for (const ext of loadedExtensions) {
    if (ext.enabled && !ext.loadError) {
      try {
        await sess.removeExtension(ext.id);
      } catch {}
    }
  }
}

async function refreshExtensionsAndUi() {
  if (!win) return;

  const sess = win.webContents.session;
  const previousIndexHtml = getCurrentIndexHtml();
  await unloadLoadedExtensions(sess);
  await loadAllExtensions(sess);

  const nextIndexHtml = getCurrentIndexHtml();
  const needsFullReload =
    previousIndexHtml !== nextIndexHtml ||
    previousIndexHtml !== getBundledIndexHtml() ||
    nextIndexHtml !== getBundledIndexHtml();

  if (needsFullReload) {
    await win.loadFile(nextIndexHtml);
  } else {
    win.webContents.send('reload-css');
  }

  win.webContents.send('ext:list', getExtensionsList());
}

function getWindowState() {
  if (!win) return { isMaximized: false };
  return {
    isMaximized: win.isMaximized()
  };
}

function emitWindowState() {
  if (win) win.webContents.send('window:state', getWindowState());
}

/* ---------- Persistent Store ---------- */
function storeFile() {
  return path.join(app.getPath('userData'), 'ag-store.json');
}

function loadStore() {
  try {
    if (fs.existsSync(storeFile())) {
      store = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    }
  } catch { /* ignore corrupt file */ }
  // defaults
  if (!store.settings) store.settings = {};
  if (!store.settings.theme) store.settings.theme = 'dark';
  store.settings.lang = normalizeLang(store.settings.lang || DEFAULT_LANG);
  if (!store.settings.homepage) store.settings.homepage = DEFAULT_HOMEPAGE;
  if (!store.extensions) store.extensions = {};
  if (!store.pinnedTabs) store.pinnedTabs = [];
  if (!store.permissions || typeof store.permissions !== 'object') store.permissions = {};
}

function saveStore() {
  try {
    fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2));
  } catch (e) {
    console.warn('Failed to save store:', e.message);
  }
}

function savePinnedTabs() {
  store.pinnedTabs = tabs.filter(t => t.pinned).map(t => t.url);
  saveStore();
}

function getHomepage() {
  return resolveBrowserUrl(store.settings.homepage || DEFAULT_HOMEPAGE, {
    fallbackUrl: DEFAULT_HOMEPAGE,
    allowSearchFallback: false
  });
}

/* ---------- WebAssembly & Performance ---------- */
app.commandLine.appendSwitch('enable-features', 'WebAssembly,WebAssemblyStreaming,SharedArrayBuffer');
app.commandLine.appendSwitch('enable-webassembly');

/* ---------- Window ---------- */
async function createWindow() {
  loadStore();
  ensureRuntimeFiles();
  syncBundledExtensions();

  win = new BrowserWindow({
    width: 1280,
    height: 840,
    backgroundColor: store.settings.theme === 'light' ? '#f5f5f7' : '#0b0b0c',
    titleBarStyle: 'hidden',
    frame: false,
    autoHideMenuBar: true,  // hide menu bar on Windows/Linux to prevent layout shift
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  buildAppMenu();

  win.on('resize', layoutActiveView);
  win.on('maximize', () => {
    layoutActiveView();
    emitWindowState();
  });
  win.on('unmaximize', () => {
    layoutActiveView();
    emitWindowState();
  });
  win.on('enter-full-screen', () => {
    layoutActiveView();
    emitWindowState();
  });
  win.on('leave-full-screen', () => {
    if (uiHidden) {
      uiHidden = false;
      win.webContents.send('ui-visibility', true);
    }
    layoutActiveView();
    emitWindowState();
  });

  // User-Agent
  const sess = win.webContents.session;
  const defaultUA = sess.getUserAgent();
  const chromeVersion = process.versions.chrome || '131.0.0.0';
  const customUA = `AG Browser/8.0 Chrome/${chromeVersion} ${defaultUA.replace(/Electron\/\S+\s*/g, '')}`;
  sess.setUserAgent(customUA);
  configureSessionSecurity(sess);

  wireDownloads(sess);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUiFileUrl(url)) {
      return { action: 'allow' };
    }
    openExternalUrl(url, SAFE_UI_EXTERNAL_PROTOCOLS);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedUiFileUrl(url)) return;
    event.preventDefault();
    openExternalUrl(url, SAFE_UI_EXTERNAL_PROTOCOLS);
  });

  // Load extensions BEFORE creating any tabs so content scripts are ready
  try {
    await loadAllExtensions(sess);
  } catch (e) {
    console.warn('Failed to initialize extensions:', e.message);
    loadedExtensions = [];
    activeHtmlOverridePath = null;
    resetRuntimeTheme();
  }

  await win.loadFile(getCurrentIndexHtml());
  win.webContents.send('ext:list', getExtensionsList());
  emitWindowState();

  globalShortcut.register('F11', () => {
    uiHidden = !uiHidden;
    layoutActiveView();
    if (win) win.webContents.send('ui-visibility', !uiHidden);
  });

  win.on('closed', () => {
    globalShortcut.unregisterAll();
    denyAllPendingPermissionPrompts();
  });

  // Trackpad swipe gestures (macOS: two-finger swipe for back/forward)
  win.on('swipe', (_e, direction) => {
    if (direction === 'left') {
      const t = getActiveTab();
      if (t?.view.webContents.canGoForward()) t.view.webContents.goForward();
    } else if (direction === 'right') {
      const t = getActiveTab();
      if (t?.view.webContents.canGoBack()) t.view.webContents.goBack();
    }
  });

  // Mouse back/forward buttons (4 & 5) on BrowserView
  // Handled via before-input-event on each view -- see createTab

  // Restore pinned tabs
  const pinnedUrls = store.pinnedTabs || [];
  for (const url of pinnedUrls) {
    createTab(url, true);
  }

  // First regular tab
  const first = createTab(getHomepage());
  setActiveTab(first.id);
}

/* ---------- Keyboard Shortcuts (App Menu) ---------- */
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const menuStrings = getMenuStrings(store.settings?.lang);
  const uiStrings = getUiStrings(store.settings?.lang);

  function switchToTabByIndex(index) {
    if (index < 0) return;
    // index 8 (Cmd+9) = last tab
    const target = index === 8 ? tabs[tabs.length - 1] : tabs[index];
    if (target) setActiveTab(target.id);
  }

  function nextTab() {
    if (!tabs.length) return;
    const idx = tabs.findIndex(t => t.id === activeTabId);
    const next = tabs[(idx + 1) % tabs.length];
    if (next) setActiveTab(next.id);
  }

  function prevTab() {
    if (!tabs.length) return;
    const idx = tabs.findIndex(t => t.id === activeTabId);
    const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
    if (prev) setActiveTab(prev.id);
  }

  function reopenClosedTab() {
    const url = closedTabsStack.pop();
    if (url) {
      const tab = createTab(url);
      setActiveTab(tab.id);
    }
  }

  function zoomActive(delta) {
    const t = getActiveTab();
    if (!t) return;
    const wc = t.view.webContents;
    const current = wc.getZoomLevel();
    wc.setZoomLevel(current + delta);
  }

  function resetZoom() {
    const t = getActiveTab();
    if (t) t.view.webContents.setZoomLevel(0);
  }

  function hardReload() {
    const t = getActiveTab();
    if (t) t.view.webContents.reloadIgnoringCache();
  }

  function focusAddress() {
    if (win) win.webContents.send('focus-address');
  }

  function openDevTools() {
    const t = getActiveTab();
    if (t) t.view.webContents.toggleDevTools();
  }

  const template = [
    ...(isMac ? [{
      label: 'AG Browser',
      submenu: [
        { label: menuStrings.aboutApp, role: 'about' },
        { type: 'separator' },
        { label: menuStrings.hideApp, role: 'hide' },
        { label: menuStrings.hideOthers, role: 'hideOthers' },
        { label: menuStrings.showAll, role: 'unhide' },
        { type: 'separator' },
        { label: menuStrings.quit, role: 'quit' }
      ]
    }] : []),
    {
      label: menuStrings.fileMenu,
      submenu: [
        { label: uiStrings.newTab, accelerator: 'CmdOrCtrl+T', click: () => { const tab = createTab(getHomepage()); setActiveTab(tab.id); } },
        { label: uiStrings.closeTab, accelerator: 'CmdOrCtrl+W', click: () => { if (activeTabId != null) closeTab(activeTabId); } },
        { label: menuStrings.reopenClosedTab, accelerator: 'CmdOrCtrl+Shift+T', click: reopenClosedTab },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: menuStrings.quit, accelerator: 'Alt+F4', role: 'quit' }])
      ]
    },
    {
      label: menuStrings.editMenu,
      submenu: [
        { label: menuStrings.undo, role: 'undo' },
        { label: menuStrings.redo, role: 'redo' },
        { type: 'separator' },
        { label: menuStrings.cut, role: 'cut' },
        { label: menuStrings.copy, role: 'copy' },
        { label: menuStrings.paste, role: 'paste' },
        { label: menuStrings.selectAll, role: 'selectAll' }
      ]
    },
    {
      label: menuStrings.viewMenu,
      submenu: [
        { label: uiStrings.reloadPage, accelerator: 'CmdOrCtrl+R', click: () => { const t = getActiveTab(); if (t) t.view.webContents.reload(); } },
        { label: menuStrings.hardReload, accelerator: 'CmdOrCtrl+Shift+R', click: hardReload },
        { label: uiStrings.reloadPage, accelerator: 'F5', visible: false, click: () => { const t = getActiveTab(); if (t) t.view.webContents.reload(); } },
        { type: 'separator' },
        { label: menuStrings.zoomIn, accelerator: 'CmdOrCtrl+Plus', click: () => zoomActive(0.5) },
        { label: menuStrings.zoomIn, accelerator: 'CmdOrCtrl+=', visible: false, click: () => zoomActive(0.5) },
        { label: menuStrings.zoomOut, accelerator: 'CmdOrCtrl+-', click: () => zoomActive(-0.5) },
        { label: menuStrings.resetZoom, accelerator: 'CmdOrCtrl+0', click: resetZoom },
        { type: 'separator' },
        { label: menuStrings.developerTools, accelerator: isMac ? 'Cmd+Alt+I' : 'Ctrl+Shift+I', click: openDevTools },
        { label: menuStrings.developerTools, accelerator: 'F12', visible: false, click: openDevTools }
      ]
    },
    {
      label: menuStrings.navigateMenu,
      submenu: [
        { label: uiStrings.back, accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: () => { const t = getActiveTab(); if (t?.view.webContents.canGoBack()) t.view.webContents.goBack(); } },
        { label: uiStrings.forward, accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: () => { const t = getActiveTab(); if (t?.view.webContents.canGoForward()) t.view.webContents.goForward(); } },
        { type: 'separator' },
        { label: menuStrings.focusAddressBar, accelerator: 'CmdOrCtrl+L', click: focusAddress },
        { label: menuStrings.focusAddressBar, accelerator: 'Alt+D', visible: false, click: focusAddress },
        { label: menuStrings.focusAddressBar, accelerator: 'F6', visible: false, click: focusAddress }
      ]
    },
    {
      label: menuStrings.tabsMenu,
      submenu: [
        { label: menuStrings.nextTab, accelerator: isMac ? 'Cmd+Shift+]' : 'Ctrl+Tab', click: nextTab },
        { label: menuStrings.previousTab, accelerator: isMac ? 'Cmd+Shift+[' : 'Ctrl+Shift+Tab', click: prevTab },
        { label: menuStrings.nextTab, accelerator: 'Ctrl+PageDown', visible: false, click: nextTab },
        { label: menuStrings.previousTab, accelerator: 'Ctrl+PageUp', visible: false, click: prevTab },
        { type: 'separator' },
        ...[1,2,3,4,5,6,7,8].map(n => ({
          label: `${menuStrings.tabLabel} ${n}`, accelerator: `CmdOrCtrl+${n}`, visible: false, click: () => switchToTabByIndex(n - 1)
        })),
        { label: menuStrings.lastTab, accelerator: 'CmdOrCtrl+9', visible: false, click: () => switchToTabByIndex(8) }
      ]
    },
    ...(isMac ? [{
      label: menuStrings.windowMenu,
      submenu: [
        { label: uiStrings.minimizeWindow, role: 'minimize' },
        { label: menuStrings.zoomWindow, role: 'zoom' },
        { label: menuStrings.toggleFullScreen, role: 'togglefullscreen' },
        { type: 'separator' },
        { label: menuStrings.bringAllToFront, role: 'front' }
      ]
    }] : [])
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/* ---------- Layout ---------- */
function layoutActiveView() {
  if (!win) return;
  const contentBounds = win.getContentBounds();
  const topBars = uiHidden ? 0 : 120;
  const bounds = {
    x: 0,
    y: topBars,
    width: contentBounds.width,
    height: Math.max(0, contentBounds.height - topBars)
  };
  const active = getActiveTab();
  if (active) {
    active.view.setAutoResize({ width: false, height: false });
    active.view.setBounds(bounds);
    active.view.setAutoResize({ width: true, height: true });
  }
}

function attachView(tab) {
  if (!win) return;
  win.setBrowserView(tab.view);
  layoutActiveView();
}

function detachView(tab) {
  if (!win) return;
  if (tab?.view && win.getBrowserViews().includes(tab.view)) {
    win.removeBrowserView(tab.view);
  }
}

function hideAllViews() {
  tabs.forEach(tab => detachView(tab));
}

function showActiveView() {
  const active = getActiveTab();
  if (active) attachView(active);
}

/* ---------- Tabs ---------- */
function createTab(url, pinned = false) {
  const initialUrl = resolveBrowserUrl(url, { fallbackUrl: getHomepage() });
  const view = new BrowserView({
    webPreferences: {
      session: win.webContents.session,  // share session so extensions work
      contextIsolation: true,
      sandbox: true,
      nativeWindowOpen: false,
      webSecurity: true
    }
  });

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (!isSafeBrowserUrl(url)) {
      openExternalUrl(url, SAFE_VIEW_EXTERNAL_PROTOCOLS);
      return { action: 'deny' };
    }
    void loadSafeUrl(view.webContents, url, {
      fallbackUrl: getHomepage(),
      allowSearchFallback: false
    });
    return { action: 'deny' };
  });

  view.webContents.on('will-navigate', (e, url) => {
    if (!isSafeBrowserUrl(url)) {
      e.preventDefault();
      openExternalUrl(url, SAFE_VIEW_EXTERNAL_PROTOCOLS);
    }
  });

  view.webContents.on('did-fail-load', (e, errorCode, errorDescription) => {
    console.warn(`Failed to load ${url}: ${errorDescription}`);
  });

  view.webContents.on('enter-html-full-screen', () => {
    if (view === getActiveTab()?.view) {
      uiHidden = true;
      layoutActiveView();
      win.webContents.send('ui-visibility', false);
    }
  });

  view.webContents.on('leave-html-full-screen', () => {
    if (view === getActiveTab()?.view) {
      uiHidden = false;
      layoutActiveView();
      win.webContents.send('ui-visibility', true);
    }
  });

  // Mouse back/forward buttons (button 3 = back, button 4 = forward)
  view.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'mouseDown') {
      if (input.button === 'back') {
        if (view.webContents.canGoBack()) view.webContents.goBack();
      } else if (input.button === 'forward') {
        if (view.webContents.canGoForward()) view.webContents.goForward();
      }
    }
  });

  const id = nextId++;
  const tab = {
    id, view, url: initialUrl,
    title: 'Loading...',
    canGoBack: false,
    canGoForward: false,
    pinned,
    favicon: null,
    loading: true
  };
  tabs.push(tab);

  const updateState = () => {
    tab.url = view.webContents.getURL();
    tab.title = view.webContents.getTitle() || tab.url || 'New Tab';
    tab.canGoBack = view.webContents.canGoBack();
    tab.canGoForward = view.webContents.canGoForward();
    try {
      tab.favicon = view.webContents.getURL().split('/').slice(0, 3).join('/') + '/favicon.ico';
    } catch { tab.favicon = null; }
    queueTabUpdate(tab);
  };

  view.webContents.on('did-start-loading', () => {
    tab.loading = true;
    queueTabUpdate(tab);
  });
  view.webContents.on('did-stop-loading', () => {
    tab.loading = false;
    queueTabUpdate(tab);
  });

  view.webContents.on('page-title-updated', updateState);
  view.webContents.on('did-navigate', updateState);
  view.webContents.on('did-navigate-in-page', updateState);
  view.webContents.on('did-finish-load', updateState);
  view.webContents.on('page-favicon-updated', (event, favicons) => {
    if (favicons?.length > 0) {
      tab.favicon = favicons[0];
      queueTabUpdate(tab);
    }
  });

  void loadSafeUrl(view.webContents, initialUrl, { fallbackUrl: getHomepage() });
  return tab;
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  const wasActive = activeTabId === id;

  // Save URL for reopen (Cmd/Ctrl+Shift+T)
  if (tab.url && tab.url !== 'about:blank') {
    closedTabsStack.push(tab.url);
    if (closedTabsStack.length > 20) closedTabsStack.shift();
  }

  clearQueuedTabUpdate(tab);
  detachView(tab);
  try { tab.view.webContents.destroy(); } catch { /* no-op */ }
  tabs.splice(idx, 1);

  if (wasActive) {
    const fallback = tabs[idx] || tabs[idx - 1];
    if (fallback) setActiveTab(fallback.id);
    else activeTabId = null;
  }
  broadcastTabs();
  savePinnedTabs();
}

function setActiveTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  const current = getActiveTab();
  if (current) detachView(current);
  activeTabId = id;
  attachView(tab);
  if (win) {
    win.webContents.send('tabs:active-changed', id);
    broadcastTabs();
  }
}

function togglePinTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (tab) {
    tab.pinned = !tab.pinned;
    if (win) {
      emitTabUpdate(tab);
      broadcastTabs();
    }
    savePinnedTabs();
    return tab.pinned;
  }
  return false;
}

function getActiveTab() {
  return tabs.find(t => t.id === activeTabId) || null;
}

function serializeTab(t) {
  return {
    id: t.id, url: t.url, title: t.title,
    canGoBack: t.canGoBack, canGoForward: t.canGoForward,
    pinned: t.pinned, favicon: t.favicon, loading: t.loading
  };
}

function broadcastTabs() {
  if (win) win.webContents.send('tabs:list', tabs.map(serializeTab), activeTabId);
}

/* ---------- Extensions ---------- */
async function loadAllExtensions(sess) {
  loadedExtensions = [];
  activeHtmlOverridePath = null;
  ensureRuntimeFiles();
  syncBundledExtensions();
  resetRuntimeTheme();

  const runtimeExtDir = getRuntimeExtensionsDir();
  if (!fs.existsSync(runtimeExtDir)) return;
  const dirs = fs.readdirSync(runtimeExtDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => path.join(runtimeExtDir, d.name));

  for (const d of dirs) {
    const dirName = path.basename(d);
    const savedState = store.extensions[dirName];
    const enabled = savedState !== undefined ? savedState.enabled !== false : true;

    let hasPopup = false;
    const mfPath = path.join(d, 'manifest.json');
    if (fs.existsSync(mfPath)) {
      try {
        const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
        hasPopup = !!(mf.action?.default_popup || mf.browser_action?.default_popup);
      } catch {}
    }

    // Detect if this is a zip-type extension (has browser.html or browser.css)
    const isZip = fs.existsSync(path.join(d, 'browser.html')) || fs.existsSync(path.join(d, 'browser.css'));

    if (enabled) {
      // Apply zip overrides if needed
      if (isZip) {
        applyZipOverrides(d);
      }

      try {
        const ext = await sess.loadExtension(d, { allowFileAccess: true });
        loadedExtensions.push({ id: ext.id, name: ext.name, version: ext.version, path: d, enabled: true, hasPopup, dirName, isZip, hasOverrides: isZip });
      } catch (e) {
        console.warn('Extension load failed:', d, e.message);
        loadedExtensions.push({ id: dirName, name: dirName, version: '?', path: d, enabled: true, hasPopup, dirName, loadError: true, isZip, hasOverrides: isZip });
      }
    } else {
      let name = dirName, version = '?';
      if (fs.existsSync(mfPath)) {
        try {
          const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
          name = mf.name || dirName;
          version = mf.version || '?';
        } catch {}
      }
      loadedExtensions.push({ id: dirName, name, version, path: d, enabled: false, hasPopup, dirName, isZip, hasOverrides: false });
    }
  }
}

function getExtensionsList() { return loadedExtensions.map(e => ({ id: e.id, name: e.name, version: e.version, path: e.path, enabled: e.enabled, hasPopup: e.hasPopup, dirName: e.dirName, isZip: !!e.isZip, hasOverrides: !!e.hasOverrides })); }

function saveExtensionState(dirName, enabled) {
  if (!store.extensions[dirName]) store.extensions[dirName] = {};
  store.extensions[dirName].enabled = enabled;
  delete store.extensions[dirName].removed;
  saveStore();
}

/* ---------- ZIP Extension Helpers ---------- */
// Apply zip extension overrides:
//   browser.css -> runtime ext-theme.css in userData
//   browser.html -> alternate entry file loaded directly by BrowserWindow
function applyZipOverrides(extDir) {
  const applied = [];

  // CSS: copy as runtime ext-theme.css (additive, loaded by renderer)
  const cssSrc = path.join(extDir, 'browser.css');
  if (fs.existsSync(cssSrc)) {
    fs.copyFileSync(cssSrc, getRuntimeThemeFile());
    applied.push('ext-theme.css');
  }

  // HTML: use extension file directly instead of overwriting packaged assets
  const htmlSrc = path.join(extDir, 'browser.html');
  if (fs.existsSync(htmlSrc)) {
    activeHtmlOverridePath = htmlSrc;
    applied.push('index.html');
  }

  return applied;
}

// If a zip extracted with a single subfolder wrapping everything, move contents up
function flattenSingleSubdir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'));
  // Only flatten if there's exactly one subfolder and no other files
  if (entries.length === 1 && entries[0].isDirectory()) {
    const subDir = path.join(dir, entries[0].name);
    const innerEntries = fs.readdirSync(subDir);
    for (const item of innerEntries) {
      const src = path.join(subDir, item);
      const dst = path.join(dir, item);
      fs.renameSync(src, dst);
    }
    fs.rmSync(subDir, { recursive: true, force: true });
  }
}

/* ---------- Downloads ---------- */
function getUniqueFilePath(dir, filename) {
  let filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let counter = 1;
  while (fs.existsSync(filePath)) {
    filePath = path.join(dir, `${base} (${counter})${ext}`);
    counter++;
  }
  return filePath;
}

function wireDownloads(sess) {
  sess.on('will-download', (_e, item) => {
    const id = Date.now() + Math.random();
    const filename = item.getFilename();
    const total = item.getTotalBytes();
    const downloadDir = app.getPath('downloads');
    const filePath = getUniqueFilePath(downloadDir, filename);
    item.setSavePath(filePath);

    const d = { id, url: item.getURL(), filename, received: 0, total, state: 'progressing', savePath: filePath };
    downloads.push(d);
    if (win) win.webContents.send('dl:created', d);

    item.on('updated', (_ev, state) => {
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      d.state = state;
      if (win) {
        win.setProgressBar(d.total ? d.received / d.total : -1);
        win.webContents.send('dl:progress', { id, received: d.received, total: d.total, state: d.state });
      }
    });

    item.once('done', (_ev, state) => {
      d.state = state;
      d.received = item.getReceivedBytes();
      if (win) {
        win.setProgressBar(-1);
        win.webContents.send('dl:done', { id, state, savePath: d.savePath, received: d.received });
      }
    });
  });
}

/* ---------- IPC ---------- */
ipcMain.handle('tabs:create', (_e, url, pinned = false) => {
  const tab = createTab(url || getHomepage(), pinned);
  setActiveTab(tab.id);
  if (pinned) savePinnedTabs();
  return serializeTab(tab);
});

ipcMain.handle('tabs:activate', (_e, id) => { setActiveTab(id); return true; });
ipcMain.handle('tabs:close', (_e, id) => { closeTab(id); return true; });
ipcMain.handle('tabs:togglePin', (_e, id) => togglePinTab(id));

ipcMain.handle('nav:go', (_e, url) => {
  const t = getActiveTab();
  if (!t) return false;
  void loadSafeUrl(t.view.webContents, url, { fallbackUrl: getHomepage() });
  return true;
});
ipcMain.handle('nav:back', () => { const t = getActiveTab(); if (t?.view.webContents.canGoBack()) t.view.webContents.goBack(); });
ipcMain.handle('nav:forward', () => { const t = getActiveTab(); if (t?.view.webContents.canGoForward()) t.view.webContents.goForward(); });
ipcMain.handle('nav:reload', () => { const t = getActiveTab(); if (t) t.view.webContents.reload(); });

ipcMain.handle('state:get', () => ({ tabs: tabs.map(serializeTab), activeId: activeTabId }));

ipcMain.handle('tabs:reopenClosed', () => {
  const url = closedTabsStack.pop();
  if (!url) return null;
  const tab = createTab(url);
  setActiveTab(tab.id);
  return serializeTab(tab);
});

ipcMain.handle('ui:toggleHide', () => {
  uiHidden = !uiHidden;
  layoutActiveView();
  if (win) win.webContents.send('ui-visibility', !uiHidden);
  return uiHidden;
});

ipcMain.handle('window:getState', () => getWindowState());
ipcMain.handle('window:minimize', () => {
  if (win) win.minimize();
  return getWindowState();
});
ipcMain.handle('window:toggleMaximize', () => {
  if (win) {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
  return getWindowState();
});
ipcMain.handle('window:close', () => {
  if (win) win.close();
  return true;
});

ipcMain.handle('view:hideActive', () => { hideAllViews(); return true; });
ipcMain.handle('view:showActive', () => { showActiveView(); return true; });

// Downloads
ipcMain.handle('dl:list', () => downloads);
ipcMain.handle('dl:reveal', (_e, id) => { const d = downloads.find(x => x.id === id); if (d?.savePath) shell.showItemInFolder(d.savePath); });
ipcMain.handle('dl:clear-finished', () => { downloads = downloads.filter(d => d.state === 'progressing' || d.state === 'interrupted'); return downloads; });

// Extensions
ipcMain.handle('ext:list', () => getExtensionsList());
ipcMain.handle('runtime:extThemeHref', () => {
  ensureRuntimeFiles();
  return getRuntimeThemeHref();
});
ipcMain.handle('ext:reload', async () => {
  await refreshExtensionsAndUi();
  return getExtensionsList();
});

ipcMain.handle('ext:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import extension (.js)',
    filters: [{ name: 'JavaScript', extensions: ['js'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (canceled || !filePaths.length) return { success: false };
  ensureRuntimeFiles();

  for (const srcPath of filePaths) {
    const baseName = path.basename(srcPath, '.js');
    const extDir = path.join(getRuntimeExtensionsDir(), baseName);
    if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
    const manifestPath = path.join(extDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      fs.writeFileSync(manifestPath, JSON.stringify({
        manifest_version: 3, name: baseName, version: '1.0.0',
        description: `Imported: ${baseName}`,
        content_scripts: [{ matches: ['http://*/*', 'https://*/*'], js: [`${baseName}.js`] }]
      }, null, 2));
    }
    fs.copyFileSync(srcPath, path.join(extDir, `${baseName}.js`));
    saveExtensionState(baseName, true);
  }

  await refreshExtensionsAndUi();
  return { success: true };
});

ipcMain.handle('ext:importZip', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import extension (.zip)',
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (canceled || !filePaths.length) return { success: false };
  ensureRuntimeFiles();

  for (const zipPath of filePaths) {
    try {
      const zip = new AdmZip(zipPath);
      const baseName = path.basename(zipPath, '.zip');
      const extDir = path.join(getRuntimeExtensionsDir(), baseName);

      // Extract to temp location first
      if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
      zip.extractAllTo(extDir, true);

      // If the zip had a single subfolder wrapping everything, flatten it
      // e.g. zip contains "ag-extension/" with all files inside
      flattenSingleSubdir(extDir);

      // Build a proper manifest.json for Electron extension loading
      const manifestPath = path.join(extDir, 'manifest.json');
      const jsFiles = fs.readdirSync(extDir).filter(f => f.endsWith('.js'));

      // Read existing custom manifest for metadata (name, version, description)
      let extName = baseName, extVersion = '1.0.0', extDesc = `Imported zip: ${baseName}`;
      if (fs.existsSync(manifestPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          extName = existing.name || baseName;
          extVersion = existing.version || '1.0.0';
          extDesc = existing.description || extDesc;
        } catch {}
      }

      // Always write a valid Manifest V3 so Electron can load it
      const manifest = {
        manifest_version: 3,
        name: extName,
        version: extVersion,
        description: extDesc
      };
      if (jsFiles.length > 0) {
        manifest.content_scripts = [{ matches: ['http://*/*', 'https://*/*'], js: jsFiles }];
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Check for browser UI overrides and apply
      const hasBrowserHtml = fs.existsSync(path.join(extDir, 'browser.html'));
      const hasBrowserCss = fs.existsSync(path.join(extDir, 'browser.css'));

      if (hasBrowserHtml || hasBrowserCss) {
        applyZipOverrides(extDir);
      }

      saveExtensionState(baseName, true);
      if (!store.extensions[baseName]) store.extensions[baseName] = {};
      store.extensions[baseName].isZip = true;
      saveStore();
    } catch (e) {
      console.warn('Failed to import zip:', zipPath, e.message);
    }
  }

  await refreshExtensionsAndUi();
  return { success: true, reloaded: true };
});

ipcMain.handle('ext:remove', async (_e, extId) => {
  const ext = loadedExtensions.find(x => x.id === extId || x.dirName === extId);
  if (!ext) return false;
  const isBundled = fs.existsSync(path.join(getBundledExtensionsDir(), ext.dirName));

  if (ext.path && fs.existsSync(ext.path)) fs.rmSync(ext.path, { recursive: true, force: true });
  if (isBundled) {
    if (!store.extensions[ext.dirName]) store.extensions[ext.dirName] = {};
    store.extensions[ext.dirName].enabled = false;
    store.extensions[ext.dirName].removed = true;
  } else {
    delete store.extensions[ext.dirName];
  }
  saveStore();
  await refreshExtensionsAndUi();
  return true;
});

ipcMain.handle('ext:toggle', async (_e, extId) => {
  const ext = loadedExtensions.find(x => x.id === extId || x.dirName === extId);
  if (!ext) return false;
  const nextEnabled = !ext.enabled;
  saveExtensionState(ext.dirName, nextEnabled);
  await refreshExtensionsAndUi();
  return nextEnabled;
});

ipcMain.handle('ext:openPopup', async (_e, extId) => {
  const ext = loadedExtensions.find(x => x.id === extId || x.dirName === extId);
  if (!ext) return false;
  const manifestPath = path.join(ext.path, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup;
  if (!popup) return false;
  const popupWin = new BrowserWindow({
    width: 400, height: 500, parent: win, resizable: true, frame: true, title: ext.name,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  popupWin.loadFile(path.join(ext.path, popup));
  return true;
});

// Permissions UI
ipcMain.handle('permission:respond', (_e, response = {}) => {
  return resolvePendingPermissionPrompt(response.id, response);
});
ipcMain.handle('permissions:clear', () => {
  clearStoredPermissionDecisions();
  return true;
});

// Settings
ipcMain.handle('settings:get', () => store.settings);
ipcMain.handle('settings:set', (_e, newSettings = {}) => {
  if (Object.prototype.hasOwnProperty.call(newSettings, 'lang')) {
    newSettings.lang = normalizeLang(newSettings.lang);
  }
  if (Object.prototype.hasOwnProperty.call(newSettings, 'homepage')) {
    newSettings.homepage = resolveBrowserUrl(newSettings.homepage, {
      fallbackUrl: DEFAULT_HOMEPAGE,
      allowSearchFallback: false
    });
  }
  Object.assign(store.settings, newSettings);
  saveStore();
  buildAppMenu();
  return store.settings;
});

/* ---------- App lifecycle ---------- */
app.setName('AG Browser');
if (process.platform === 'win32') app.setAppUserModelId('com.kickedstorm.agbrowser');

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
