const { app, BrowserWindow, BrowserView, ipcMain, shell, dialog, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

const EXT_DIR = path.join(__dirname, 'extensions');
const BACKUP_DIR = path.join(__dirname, 'extensions', '.backups');
const DEFAULT_HOMEPAGE = 'https://search.kickedstorm.com/';

const BROWSER_ROOT = __dirname;
const EXT_THEME_FILE = path.join(BROWSER_ROOT, 'ext-theme.css');

let win;
let tabs = [];
let activeTabId = null;
let nextId = 1;
let downloads = [];
let loadedExtensions = [];
let uiHidden = false;
let store = {};
let closedTabsStack = []; // for Cmd/Ctrl+Shift+T (reopen closed tab)

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
  if (!store.settings.lang) store.settings.lang = 'ru';
  if (!store.settings.homepage) store.settings.homepage = DEFAULT_HOMEPAGE;
  if (!store.extensions) store.extensions = {};
  if (!store.pinnedTabs) store.pinnedTabs = [];
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
  return store.settings.homepage || DEFAULT_HOMEPAGE;
}

/* ---------- WebAssembly & Performance ---------- */
app.commandLine.appendSwitch('enable-features', 'WebAssembly,WebAssemblyStreaming,SharedArrayBuffer');
app.commandLine.appendSwitch('enable-webassembly');
app.commandLine.appendSwitch('js-flags', '--wasm-staging');

/* ---------- Window ---------- */
async function createWindow() {
  loadStore();

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

  win.loadFile(path.join(__dirname, 'index.html'));

  win.on('resize', layoutActiveView);
  win.on('maximize', layoutActiveView);
  win.on('unmaximize', layoutActiveView);
  win.on('enter-full-screen', layoutActiveView);
  win.on('leave-full-screen', () => {
    if (uiHidden) {
      uiHidden = false;
      win.webContents.send('ui-visibility', true);
    }
    layoutActiveView();
  });

  // User-Agent
  const sess = win.webContents.session;
  const defaultUA = sess.getUserAgent();
  const chromeVersion = process.versions.chrome || '131.0.0.0';
  const customUA = `AG Browser/8.0 Chrome/${chromeVersion} ${defaultUA.replace(/Electron\/\S+\s*/g, '')}`;
  sess.setUserAgent(customUA);

  wireDownloads(sess);

  // Load extensions BEFORE creating any tabs so content scripts are ready
  await loadAllExtensions(sess);
  win.webContents.send('ext:list', getExtensionsList());

  globalShortcut.register('F11', () => {
    uiHidden = !uiHidden;
    layoutActiveView();
    if (win) win.webContents.send('ui-visibility', !uiHidden);
  });

  win.on('closed', () => {
    globalShortcut.unregisterAll();
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

  // Build application menu with keyboard shortcuts
  buildAppMenu();

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
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => { const tab = createTab(getHomepage()); setActiveTab(tab.id); } },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => { if (activeTabId != null) closeTab(activeTabId); } },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: reopenClosedTab },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: 'Quit', accelerator: 'Alt+F4', role: 'quit' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => { const t = getActiveTab(); if (t) t.view.webContents.reload(); } },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: hardReload },
        { label: 'Reload', accelerator: 'F5', visible: false, click: () => { const t = getActiveTab(); if (t) t.view.webContents.reload(); } },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => zoomActive(0.5) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, click: () => zoomActive(0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoomActive(-0.5) },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: resetZoom },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: isMac ? 'Cmd+Alt+I' : 'Ctrl+Shift+I', click: openDevTools },
        { label: 'Developer Tools', accelerator: 'F12', visible: false, click: openDevTools }
      ]
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Back', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: () => { const t = getActiveTab(); if (t?.view.webContents.canGoBack()) t.view.webContents.goBack(); } },
        { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: () => { const t = getActiveTab(); if (t?.view.webContents.canGoForward()) t.view.webContents.goForward(); } },
        { type: 'separator' },
        { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: focusAddress },
        { label: 'Focus Address Bar', accelerator: 'Alt+D', visible: false, click: focusAddress },
        { label: 'Focus Address Bar', accelerator: 'F6', visible: false, click: focusAddress }
      ]
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: isMac ? 'Cmd+Shift+]' : 'Ctrl+Tab', click: nextTab },
        { label: 'Previous Tab', accelerator: isMac ? 'Cmd+Shift+[' : 'Ctrl+Shift+Tab', click: prevTab },
        { label: 'Next Tab', accelerator: 'Ctrl+PageDown', visible: false, click: nextTab },
        { label: 'Previous Tab', accelerator: 'Ctrl+PageUp', visible: false, click: prevTab },
        { type: 'separator' },
        ...[1,2,3,4,5,6,7,8].map(n => ({
          label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, visible: false, click: () => switchToTabByIndex(n - 1)
        })),
        { label: 'Last Tab', accelerator: 'CmdOrCtrl+9', visible: false, click: () => switchToTabByIndex(8) }
      ]
    },
    ...(isMac ? [{
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'front' }
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
  const topBars = uiHidden ? 0 : 116;
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
    if (!/^https?:/i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    view.webContents.loadURL(url);
    return { action: 'deny' };
  });

  view.webContents.on('will-navigate', (e, url) => {
    if (!/^https?:/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
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
    id, view, url,
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
    if (win) win.webContents.send('tab:updated', serializeTab(tab));
  };

  view.webContents.on('did-start-loading', () => {
    tab.loading = true;
    if (win) win.webContents.send('tab:updated', serializeTab(tab));
  });
  view.webContents.on('did-stop-loading', () => {
    tab.loading = false;
    if (win) win.webContents.send('tab:updated', serializeTab(tab));
  });

  view.webContents.on('page-title-updated', updateState);
  view.webContents.on('did-navigate', updateState);
  view.webContents.on('did-navigate-in-page', updateState);
  view.webContents.on('did-finish-load', updateState);
  view.webContents.on('page-favicon-updated', (event, favicons) => {
    if (favicons?.length > 0) {
      tab.favicon = favicons[0];
      if (win) win.webContents.send('tab:updated', serializeTab(tab));
    }
  });

  view.webContents.loadURL(url);
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
      win.webContents.send('tab:updated', serializeTab(tab));
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
  if (!fs.existsSync(EXT_DIR)) return;
  const dirs = fs.readdirSync(EXT_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(EXT_DIR, d.name));

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
    const hasOverrides = hasActiveOverrides(dirName);

    if (enabled) {
      // Apply zip overrides if needed
      if (isZip) {
        applyZipOverrides(d, dirName);
      }

      try {
        const ext = await sess.loadExtension(d, { allowFileAccess: true });
        loadedExtensions.push({ id: ext.id, name: ext.name, version: ext.version, path: d, enabled: true, hasPopup, dirName, isZip, hasOverrides: isZip || hasOverrides });
      } catch (e) {
        console.warn('Extension load failed:', d, e.message);
        loadedExtensions.push({ id: dirName, name: dirName, version: '?', path: d, enabled: true, hasPopup, dirName, loadError: true, isZip, hasOverrides: isZip || hasOverrides });
      }
    } else {
      // Disabled - restore backups if this zip ext had overrides
      if (hasOverrides) {
        removeOverrides(dirName);
      }

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
  saveStore();
}

/* ---------- ZIP Extension Helpers ---------- */
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Back up original index.html before a zip extension overwrites it
function backupIndexHtml(extDirName) {
  ensureBackupDir();
  const backupSubDir = path.join(BACKUP_DIR, extDirName);
  if (!fs.existsSync(backupSubDir)) fs.mkdirSync(backupSubDir, { recursive: true });
  const src = path.join(BROWSER_ROOT, 'index.html');
  const dst = path.join(backupSubDir, 'index.html');
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    fs.copyFileSync(src, dst);
  }
}

// Apply zip extension overrides:
//   browser.css -> ext-theme.css (layered on top of styles.css, NOT replacing it)
//   browser.html -> index.html (full replacement, backed up first)
function applyZipOverrides(extDir, extDirName) {
  const applied = [];

  // CSS: copy as ext-theme.css (additive, loaded via <link> in index.html)
  const cssSrc = path.join(extDir, 'browser.css');
  if (fs.existsSync(cssSrc)) {
    fs.copyFileSync(cssSrc, EXT_THEME_FILE);
    applied.push('ext-theme.css');
  }

  // HTML: full replacement (backup original first)
  const htmlSrc = path.join(extDir, 'browser.html');
  if (fs.existsSync(htmlSrc)) {
    backupIndexHtml(extDirName);
    fs.copyFileSync(htmlSrc, path.join(BROWSER_ROOT, 'index.html'));
    applied.push('index.html');
  }

  return applied;
}

// Remove overrides: clear ext-theme.css, restore index.html if backed up
function removeOverrides(extDirName) {
  // Write empty file instead of deleting (avoids 404 caching issues)
  fs.writeFileSync(EXT_THEME_FILE, '/* no extension theme active */\n');

  // Restore original index.html from backup
  const backupSubDir = path.join(BACKUP_DIR, extDirName);
  if (fs.existsSync(backupSubDir)) {
    const backupHtml = path.join(backupSubDir, 'index.html');
    if (fs.existsSync(backupHtml)) {
      fs.copyFileSync(backupHtml, path.join(BROWSER_ROOT, 'index.html'));
    }
    fs.rmSync(backupSubDir, { recursive: true, force: true });
  }
}

// Check if a zip extension has overrides active
function hasActiveOverrides(extDirName) {
  return fs.existsSync(path.join(BACKUP_DIR, extDirName)) || fs.existsSync(EXT_THEME_FILE);
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
  t.view.webContents.loadURL(url);
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

ipcMain.handle('view:hideActive', () => { hideAllViews(); return true; });
ipcMain.handle('view:showActive', () => { showActiveView(); return true; });

// Downloads
ipcMain.handle('dl:list', () => downloads);
ipcMain.handle('dl:reveal', (_e, id) => { const d = downloads.find(x => x.id === id); if (d?.savePath) shell.showItemInFolder(d.savePath); });
ipcMain.handle('dl:clear-finished', () => { downloads = downloads.filter(d => d.state === 'progressing' || d.state === 'interrupted'); return downloads; });

// Extensions
ipcMain.handle('ext:list', () => getExtensionsList());
ipcMain.handle('ext:reload', async () => {
  const sess = win.webContents.session;
  for (const ext of loadedExtensions) {
    if (ext.enabled && !ext.loadError) { try { await sess.removeExtension(ext.id); } catch {} }
  }
  await loadAllExtensions(sess);
  if (win) win.webContents.send('ext:list', getExtensionsList());
  return getExtensionsList();
});

ipcMain.handle('ext:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import extension (.js)',
    filters: [{ name: 'JavaScript', extensions: ['js'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (canceled || !filePaths.length) return { success: false };
  if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });

  for (const srcPath of filePaths) {
    const baseName = path.basename(srcPath, '.js');
    const extDir = path.join(EXT_DIR, baseName);
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

  const sess = win.webContents.session;
  for (const ext of loadedExtensions) {
    if (ext.enabled && !ext.loadError) { try { await sess.removeExtension(ext.id); } catch {} }
  }
  await loadAllExtensions(sess);
  if (win) win.webContents.send('ext:list', getExtensionsList());
  return { success: true };
});

ipcMain.handle('ext:importZip', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import extension (.zip)',
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (canceled || !filePaths.length) return { success: false };
  if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });

  let needsReload = false;

  for (const zipPath of filePaths) {
    try {
      const zip = new AdmZip(zipPath);
      const baseName = path.basename(zipPath, '.zip');
      const extDir = path.join(EXT_DIR, baseName);

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
        applyZipOverrides(extDir, baseName);
        needsReload = true;
      }

      saveExtensionState(baseName, true);
      if (!store.extensions[baseName]) store.extensions[baseName] = {};
      store.extensions[baseName].isZip = true;
      saveStore();
    } catch (e) {
      console.warn('Failed to import zip:', zipPath, e.message);
    }
  }

  // Reload extensions in session
  const sess = win.webContents.session;
  for (const ext of loadedExtensions) {
    if (ext.enabled && !ext.loadError) { try { await sess.removeExtension(ext.id); } catch {} }
  }
  await loadAllExtensions(sess);
  if (win) win.webContents.send('ext:list', getExtensionsList());

  // If browser UI files were overridden, reload the window
  if (needsReload && win) {
    win.loadFile(path.join(__dirname, 'index.html'));
  }

  return { success: true, reloaded: needsReload };
});

ipcMain.handle('ext:remove', async (_e, extId) => {
  const ext = loadedExtensions.find(x => x.id === extId || x.dirName === extId);
  if (!ext) return false;
  const sess = win.webContents.session;
  if (ext.enabled && !ext.loadError) { try { await sess.removeExtension(ext.id); } catch {} }

  // Restore browser files if this was a zip extension with overrides
  let needsHtmlReload = false;
  let needsCssReload = false;
  if (hasActiveOverrides(ext.dirName)) {
    const hadHtmlBackup = fs.existsSync(path.join(BACKUP_DIR, ext.dirName, 'index.html'));
    removeOverrides(ext.dirName);
    if (hadHtmlBackup) needsHtmlReload = true;
    else needsCssReload = true;
  }

  if (ext.path && fs.existsSync(ext.path)) fs.rmSync(ext.path, { recursive: true, force: true });
  delete store.extensions[ext.dirName];
  saveStore();
  loadedExtensions = loadedExtensions.filter(x => x !== ext);
  if (win) win.webContents.send('ext:list', getExtensionsList());

  if (needsHtmlReload && win) {
    win.loadFile(path.join(__dirname, 'index.html'));
  } else if (needsCssReload && win) {
    win.webContents.send('reload-css');
  }
  return true;
});

ipcMain.handle('ext:toggle', async (_e, extId) => {
  const ext = loadedExtensions.find(x => x.id === extId || x.dirName === extId);
  if (!ext) return false;
  const sess = win.webContents.session;
  let needsHtmlReload = false;
  let needsCssReload = false;

  if (ext.enabled) {
    // Disable
    if (!ext.loadError) { try { await sess.removeExtension(ext.id); } catch {} }
    ext.enabled = false;

    if (hasActiveOverrides(ext.dirName)) {
      // Check what kind of overrides are active
      const hadHtmlBackup = fs.existsSync(path.join(BACKUP_DIR, ext.dirName, 'index.html'));
      removeOverrides(ext.dirName);
      ext.hasOverrides = false;
      if (hadHtmlBackup) needsHtmlReload = true;
      else needsCssReload = true;
    }
  } else {
    // Enable
    try {
      if (ext.isZip) {
        const applied = applyZipOverrides(ext.path, ext.dirName);
        ext.hasOverrides = true;
        if (applied.includes('index.html')) needsHtmlReload = true;
        else if (applied.includes('ext-theme.css')) needsCssReload = true;
      }

      const loaded = await sess.loadExtension(ext.path, { allowFileAccess: true });
      ext.id = loaded.id;
      ext.name = loaded.name;
      ext.version = loaded.version;
      ext.enabled = true;
      ext.loadError = false;
    } catch (e) {
      console.warn('Failed to enable extension:', e.message);
      ext.enabled = false;
    }
  }

  saveExtensionState(ext.dirName, ext.enabled);
  if (win) win.webContents.send('ext:list', getExtensionsList());

  if (needsHtmlReload && win) {
    // Full reload needed -- index.html itself changed
    win.loadFile(path.join(__dirname, 'index.html'));
  } else if (needsCssReload && win) {
    // Just reload the CSS, no full page reload needed
    win.webContents.send('reload-css');
  }
  return ext.enabled;
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

// Settings
ipcMain.handle('settings:get', () => store.settings);
ipcMain.handle('settings:set', (_e, newSettings) => {
  Object.assign(store.settings, newSettings);
  saveStore();
  return store.settings;
});

/* ---------- App lifecycle ---------- */
app.setName('AG Browser');
if (process.platform === 'win32') app.setAppUserModelId('com.kickedstorm.agbrowser');

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
