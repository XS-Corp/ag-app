const { app, BrowserWindow, BrowserView, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const HOMEPAGE = 'https://search.kickedstorm.com/';
const EXT_DIR = path.join(__dirname, 'extensions');

let win;
let tabs = [];
let activeTabId = null;
let nextId = 1;
let downloads = [];
let loadedExtensions = [];

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    backgroundColor: '#0b0b0c',
    titleBarStyle: 'hidden',
    frame: false,
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

  // авто-загрузка расширений и провайдер загрузок
  wireDownloads(win.webContents.session);
  loadAllExtensions(win.webContents.session).then(() => {
    win.webContents.send('ext:list', getExtensionsList());
  });

  // первая вкладка
  const first = createTab(HOMEPAGE);
  setActiveTab(first.id);
}

function layoutActiveView() {
  if (!win) return;
  const contentBounds = win.getContentBounds();
  const topBars = 116; // 32 (drag) + 36 (tabs) + 48 (toolbar)
  const bounds = {
    x: 0,
    y: topBars,
    width: contentBounds.width,
    height: Math.max(0, contentBounds.height - topBars)
  };
  const active = getActiveTab();
  if (active) active.view.setBounds(bounds);
}

function attachView(tab) {
  if (!win) return;
  win.setBrowserView(tab.view);
  layoutActiveView();
  tab.view.setAutoResize({ width: true, height: true });
}

function detachView(tab) {
  if (!win) return;
  if (tab?.view && win.getBrowserViews().includes(tab.view)) {
    win.removeBrowserView(tab.view);
  }
}

function hideAllViews() {
  tabs.forEach(tab => {
    detachView(tab);
  });
}

function showActiveView() {
  const active = getActiveTab();
  if (active) {
    attachView(active);
  }
}

function createTab(url, pinned = false) {
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nativeWindowOpen: false,
      webSecurity: true
    }
  });

  // перехват target=_blank / window.open -> в этой же вкладке
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    view.webContents.loadURL(url);
    return { action: 'deny' };
  });

  // внешние схемы наружу
  view.webContents.on('will-navigate', (e, url) => {
    if (!/^https?:/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Обработка ошибок загрузки
  view.webContents.on('did-fail-load', (e, errorCode, errorDescription) => {
    console.warn(`Failed to load ${url}: ${errorDescription}`);
  });

  // Обработка Fullscreen API
  view.webContents.on('enter-html-full-screen', () => {
    console.log('HTML Fullscreen entered');
    if (view === getActiveTab()?.view) {
      win.webContents.send('enter-html-fullscreen');
    }
  });

  view.webContents.on('leave-html-full-screen', () => {
    console.log('HTML Fullscreen left');
    if (view === getActiveTab()?.view) {
      win.webContents.send('leave-html-fullscreen');
    }
  });

  const id = nextId++;
  const tab = {
    id,
    view,
    url,
    title: 'Loading…',
    canGoBack: false,
    canGoForward: false,
    pinned: pinned,
    favicon: null
  };
  tabs.push(tab);

  // обновление состояния вкладки
  const updateState = () => {
    tab.url = view.webContents.getURL();
    tab.title = view.webContents.getTitle() || tab.url || 'New Tab';
    tab.canGoBack = view.webContents.canGoBack();
    tab.canGoForward = view.webContents.canGoForward();
    
    // Получаем favicon
    try {
      const faviconUrl = view.webContents.getURL().split('/').slice(0, 3).join('/') + '/favicon.ico';
      tab.favicon = faviconUrl;
    } catch (e) {
      tab.favicon = null;
    }
    
    if (win) win.webContents.send('tab:updated', serializeTab(tab));
  };
  
  view.webContents.on('page-title-updated', updateState);
  view.webContents.on('did-navigate', updateState);
  view.webContents.on('did-navigate-in-page', updateState);
  view.webContents.on('did-finish-load', updateState);

  // Обновляем favicon при загрузке
  view.webContents.on('page-favicon-updated', (event, favicons) => {
    if (favicons && favicons.length > 0) {
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
  detachView(tab);
  try { tab.view.webContents.destroy(); } catch { /* no-op */ }
  tabs.splice(idx, 1);

  if (wasActive) {
    const fallback = tabs[idx] || tabs[idx - 1];
    if (fallback) setActiveTab(fallback.id);
    else activeTabId = null;
  }
  broadcastTabs();
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
    return tab.pinned;
  }
  return false;
}

function getActiveTab() {
  return tabs.find(t => t.id === activeTabId) || null;
}

function serializeTab(t) {
  return {
    id: t.id,
    url: t.url,
    title: t.title,
    canGoBack: t.canGoBack,
    canGoForward: t.canGoForward,
    pinned: t.pinned,
    favicon: t.favicon
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
    try {
      const ext = await sess.loadExtension(d, { allowFileAccess: true });
      loadedExtensions.push({ id: ext.id, name: ext.name, version: ext.version, path: d });
    } catch (e) {
      console.warn('Extension load failed:', d, e.message);
    }
  }
}
function getExtensionsList() { return loadedExtensions.slice(); }

/* ---------- Downloads ---------- */
function wireDownloads(sess) {
  sess.on('will-download', async (_e, item) => {
    const id = Date.now() + Math.random();
    const filename = item.getFilename();
    const total = item.getTotalBytes();
    const suggestedPath = path.join(app.getPath('downloads'), filename);

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Сохранить файл',
      defaultPath: suggestedPath
    });
    if (canceled) { item.cancel(); return; }
    item.setSavePath(filePath);

    const d = { id, url: item.getURL(), filename, received: 0, total, state: 'progressing', savePath: filePath };
    downloads.push(d);
    if (win) win.webContents.send('dl:created', d);

    item.on('updated', (_ev, state) => {
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      d.state = state;
      if (win) {
        win.setProgressBar(d.total ? d.received / d.total : 0);
        win.webContents.send('dl:progress', { id, received: d.received, total: d.total, state: d.state });
      }
    });

    item.once('done', (_ev, state) => {
      d.state = state;
      if (win) {
        win.setProgressBar(-1);
        win.webContents.send('dl:done', { id, state, savePath: d.savePath });
      }
    });
  });
}

/* ---------- IPC ---------- */
ipcMain.handle('tabs:create', (_e, url, pinned = false) => {
  const tab = createTab(url || HOMEPAGE, pinned);
  setActiveTab(tab.id);
  return serializeTab(tab);
});

ipcMain.handle('tabs:activate', (_e, id) => {
  setActiveTab(id);
  return true;
});

ipcMain.handle('tabs:close', (_e, id) => {
  closeTab(id);
  return true;
});

ipcMain.handle('tabs:togglePin', (_e, id) => {
  return togglePinTab(id);
});

ipcMain.handle('nav:go', (_e, url) => {
  const t = getActiveTab();
  if (!t) return false;
  t.view.webContents.loadURL(url);
  return true;
});

ipcMain.handle('nav:back', () => {
  const t = getActiveTab();
  if (t && t.view.webContents.canGoBack()) t.view.webContents.goBack();
});

ipcMain.handle('nav:forward', () => {
  const t = getActiveTab();
  if (t && t.view.webContents.canGoForward()) t.view.webContents.goForward();
});

ipcMain.handle('nav:reload', () => {
  const t = getActiveTab();
  if (t) t.view.webContents.reload();
});

ipcMain.handle('state:get', () => ({ tabs: tabs.map(serializeTab), activeId: activeTabId }));

ipcMain.handle('view:hideActive', () => {
  hideAllViews();
  return true;
});

ipcMain.handle('view:showActive', () => {
  showActiveView();
  return true;
});

ipcMain.handle('dl:list', () => downloads);
ipcMain.handle('dl:reveal', (_e, id) => {
  const d = downloads.find(x => x.id === id);
  if (d?.savePath) shell.showItemInFolder(d.savePath);
});
ipcMain.handle('dl:clear-finished', () => {
  downloads = downloads.filter(d => d.state === 'progressing' || d.state === 'interrupted');
  return downloads;
});

ipcMain.handle('ext:list', () => getExtensionsList());
ipcMain.handle('ext:reload', async () => {
  const sess = win.webContents.session;
  for (const ext of loadedExtensions) {
    try { await sess.removeExtension(ext.id); } catch {}
  }
  await loadAllExtensions(sess);
  if (win) win.webContents.send('ext:list', getExtensionsList());
  return getExtensionsList();
});

/* ---------- App lifecycle ---------- */
app.setName('AG App');
if (process.platform === 'win32') app.setAppUserModelId('com.kickedstorm.agapp');

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
