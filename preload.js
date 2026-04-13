const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ag', {
  // tabs
  createTab: (url, pinned = false) => ipcRenderer.invoke('tabs:create', url, pinned),
  activateTab: (id) => ipcRenderer.invoke('tabs:activate', id),
  closeTab: (id) => ipcRenderer.invoke('tabs:close', id),
  togglePinTab: (id) => ipcRenderer.invoke('tabs:togglePin', id),

  // nav
  goTo: (url) => ipcRenderer.invoke('nav:go', url),
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload'),

  // view management
  hideActiveView: () => ipcRenderer.invoke('view:hideActive'),
  showActiveView: () => ipcRenderer.invoke('view:showActive'),

  // state
  getState: () => ipcRenderer.invoke('state:get'),
  onTabsList: (cb) => ipcRenderer.on('tabs:list', (_e, list, activeId) => cb(list, activeId)),
  onActiveChanged: (cb) => ipcRenderer.on('tabs:active-changed', (_e, id) => cb(id)),
  onTabUpdated: (cb) => ipcRenderer.on('tab:updated', (_e, tab) => cb(tab)),

  // downloads
  dlList: () => ipcRenderer.invoke('dl:list'),
  dlReveal: (id) => ipcRenderer.invoke('dl:reveal', id),
  dlClearFinished: () => ipcRenderer.invoke('dl:clear-finished'),
  onDlCreated: (cb) => ipcRenderer.on('dl:created', (_e, d) => cb(d)),
  onDlProgress: (cb) => ipcRenderer.on('dl:progress', (_e, d) => cb(d)),
  onDlDone: (cb) => ipcRenderer.on('dl:done', (_e, d) => cb(d)),

  // extensions
  extList: () => ipcRenderer.invoke('ext:list'),
  extReload: () => ipcRenderer.invoke('ext:reload'),
  extImport: () => ipcRenderer.invoke('ext:import'),
  extImportZip: () => ipcRenderer.invoke('ext:importZip'),
  extRemove: (id) => ipcRenderer.invoke('ext:remove', id),
  extToggle: (id) => ipcRenderer.invoke('ext:toggle', id),
  extOpenPopup: (id) => ipcRenderer.invoke('ext:openPopup', id),
  onExtList: (cb) => ipcRenderer.on('ext:list', (_e, list) => cb(list)),

  // settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (s) => ipcRenderer.invoke('settings:set', s),

  // UI visibility
  toggleUiHide: () => ipcRenderer.invoke('ui:toggleHide'),
  onUiVisibility: (cb) => ipcRenderer.on('ui-visibility', (_e, visible) => cb(visible)),

  // CSS reload (for extension theme changes)
  onReloadCss: (cb) => ipcRenderer.on('reload-css', () => cb()),

  // Focus address bar (from menu shortcut)
  onFocusAddress: (cb) => ipcRenderer.on('focus-address', () => cb()),

  // Reopen closed tab
  reopenClosedTab: () => ipcRenderer.invoke('tabs:reopenClosed')
});
