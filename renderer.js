/* ===== i18n ===== */
const {
  DEFAULT_LANG,
  LANGUAGES,
  getLangConfig,
  getUiStrings,
  normalizeLang
} = window.AG_I18N;

let currentLang = DEFAULT_LANG;

function t(key) {
  return getUiStrings(currentLang)[key] || key;
}

function populateLanguageSelect() {
  selectLanguage.innerHTML = '';
  LANGUAGES.forEach((lang) => {
    const option = document.createElement('option');
    option.value = lang.code;
    option.textContent = lang.label;
    selectLanguage.appendChild(option);
  });
}

function populateTranslateLanguageSelect() {
  selectTranslateLanguage.innerHTML = '';
  LANGUAGES.forEach((lang) => {
    const option = document.createElement('option');
    option.value = lang.code;
    option.textContent = lang.label;
    selectTranslateLanguage.appendChild(option);
  });
}

function applyI18n() {
  const langConfig = getLangConfig(currentLang);
  document.documentElement.lang = langConfig.htmlLang;
  document.body.classList.toggle('is-rtl', !!langConfig.rtl);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  windowControlsEl?.setAttribute('aria-label', t('windowControls'));
  btnMinimizeWindow.title = t('minimizeWindow');
  btnMinimizeWindow.setAttribute('aria-label', t('minimizeWindow'));
  btnCloseWindow.title = t('closeWindow');
  btnCloseWindow.setAttribute('aria-label', t('closeWindow'));
  address.placeholder = t('addressPlaceholder');
  btnBack.title = t('back');
  btnFwd.title = t('forward');
  btnReload.title = t('reloadPage');
  btnNew.title = t('newTab');
  btnReadMode.title = tabs.find(x => x.id === activeId)?.readModeEnabled ? t('exitReadMode') : t('readMode');
  btnReadMode.setAttribute('aria-label', btnReadMode.title);
  btnTranslate.title = t('translatePage');
  btnTranslate.setAttribute('aria-label', t('translatePage'));
  btnDownloads.title = t('downloads');
  btnExtensions.title = t('extensions');
  btnSettings.title = t('settings');

  // Theme buttons
  btnThemeDark.textContent = t('dark');
  btnThemeLight.textContent = t('light');
  selectLanguage.setAttribute('aria-label', t('language'));
  selectLanguage.value = currentLang;
  selectTranslateLanguage.setAttribute('aria-label', t('translateLanguage'));
  renderTranslatePanel();
  applyWindowState(windowState);
}

/* ===== DOM refs ===== */
const windowControlsEl = document.querySelector('.window-controls');
const btnMinimizeWindow = document.getElementById('btnMinimizeWindow');
const btnToggleMaximizeWindow = document.getElementById('btnToggleMaximizeWindow');
const btnCloseWindow = document.getElementById('btnCloseWindow');
const tabsEl = document.getElementById('tabs');
const btnBack = document.getElementById('btnBack');
const btnFwd = document.getElementById('btnFwd');
const btnReload = document.getElementById('btnReload');
const btnNew = document.getElementById('btnNew');
const address = document.getElementById('address');
const btnReadMode = document.getElementById('btnReadMode');
const btnTranslate = document.getElementById('btnTranslate');
const btnDownloads = document.getElementById('btnDownloads');
const btnExtensions = document.getElementById('btnExtensions');
const btnSettings = document.getElementById('btnSettings');
const panelOverlay = document.getElementById('panelOverlay');
const toastHost = document.getElementById('toastHost');
const panelDownloads = document.getElementById('panelDownloads');
const downloadsList = document.getElementById('downloadsList');
const btnCloseDownloads = document.getElementById('btnCloseDownloads');
const btnClearFinished = document.getElementById('btnClearFinished');
const panelExtensions = document.getElementById('panelExtensions');
const extensionsList = document.getElementById('extensionsList');
const btnCloseExtensions = document.getElementById('btnCloseExtensions');
const btnReloadExt = document.getElementById('btnReloadExt');
const btnImportExt = document.getElementById('btnImportExt');
const btnImportZip = document.getElementById('btnImportZip');
const panelTranslate = document.getElementById('panelTranslate');
const btnCloseTranslate = document.getElementById('btnCloseTranslate');
const selectTranslateLanguage = document.getElementById('selectTranslateLanguage');
const translateStatus = document.getElementById('translateStatus');
const translatePageUrl = document.getElementById('translatePageUrl');
const btnTranslateApply = document.getElementById('btnTranslateApply');
const btnTranslateRestore = document.getElementById('btnTranslateRestore');
const panelSettings = document.getElementById('panelSettings');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const btnThemeDark = document.getElementById('btnThemeDark');
const btnThemeLight = document.getElementById('btnThemeLight');
const selectLanguage = document.getElementById('selectLanguage');
const inputHomepage = document.getElementById('inputHomepage');
const btnSaveHomepage = document.getElementById('btnSaveHomepage');
const btnClearPermissions = document.getElementById('btnClearPermissions');
const permissionOverlay = document.getElementById('permissionOverlay');
const permissionModal = document.getElementById('permissionModal');
const permissionTitle = document.getElementById('permissionTitle');
const permissionSite = document.getElementById('permissionSite');
const permissionMessage = document.getElementById('permissionMessage');
const permissionOriginLabel = document.getElementById('permissionOriginLabel');
const permissionOriginValue = document.getElementById('permissionOriginValue');
const permissionNote = document.getElementById('permissionNote');
const permissionRememberRow = document.getElementById('permissionRememberRow');
const permissionRemember = document.getElementById('permissionRemember');
const permissionRememberText = document.getElementById('permissionRememberText');
const permissionSources = document.getElementById('permissionSources');
const btnPermissionDeny = document.getElementById('btnPermissionDeny');
const btnPermissionAlwaysAllow = document.getElementById('btnPermissionAlwaysAllow');
const btnPermissionAllow = document.getElementById('btnPermissionAllow');

populateLanguageSelect();
populateTranslateLanguageSelect();

/* ===== State ===== */
let tabs = [];
let activeId = null;
let dls = [];
let exts = [];
let activePanel = null;
let isBrowserFullscreen = false;
let contextMenu = null;
let settings = {};
let extThemeHref = '';
let windowState = { isMaximized: false };
let permissionRequestState = null;
let selectedPermissionSourceId = null;
const scheduledUiTasks = new Map();

/* ===== Helpers ===== */
function isHttp(url) { return /^https?:\/\//i.test(url); }
const HOSTLIKE_INPUT_RE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#].*)?$/i;
const LOCAL_HOST_INPUT_RE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i;

function normalizeUrl(u) {
  if (!u) return '';
  u = u.trim();
  if (isHttp(u)) return u;
  if (HOSTLIKE_INPUT_RE.test(u)) {
    const scheme = LOCAL_HOST_INPUT_RE.test(u) ? 'http' : 'https';
    return `${scheme}://${u}`;
  }
  if (u.includes('.') && !u.includes(' ')) return `https://${u}`;
  return `https://www.google.com/search?q=${encodeURIComponent(u)}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatUiString(template, replacements = {}) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = replacements[key];
    return value == null ? '' : String(value);
  });
}

function getLanguageLabel(langCode) {
  return getLangConfig(normalizeLang(langCode)).label;
}

function getTranslateTargetValue() {
  return normalizeLang(settings.translateTargetLang || currentLang || DEFAULT_LANG);
}

function getActiveTab() {
  return tabs.find(tab => tab.id === activeId) || null;
}

function isTranslatableTab(tab) {
  if (!tab) return false;
  return !!tab.translationOriginalUrl || isHttp(tab.url);
}

function isReadModeAvailable(tab) {
  return !!tab && isHttp(tab.url);
}

function showToast(message) {
  if (!message) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastHost.appendChild(toast);

  const startHide = () => {
    toast.classList.add('toast-hiding');
    setTimeout(() => toast.remove(), 180);
  };

  setTimeout(startHide, 2400);
}

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const k = 1024;
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, val = n;
  while (val >= k && i < units.length - 1) { val /= k; i++; }
  return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function getStateText(state) {
  const map = { progressing: 'progressing', completed: 'completed', cancelled: 'cancelled', interrupted: 'interrupted' };
  return t(map[state] || state);
}

function getTabDisplayTitle(tab) {
  const title = (tab?.title || '').trim();
  if (title && title !== 'New Tab') return title;

  const url = (tab?.url || '').trim();
  if (url && url !== 'about:blank') return url;

  return t('newTab');
}

function ensureRuntimeThemeLink(cacheBust = false) {
  if (!extThemeHref) return;

  let link = document.getElementById('ext-theme-runtime');
  if (!link) {
    link = document.createElement('link');
    link.id = 'ext-theme-runtime';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }

  const base = extThemeHref.split('?')[0];
  link.href = cacheBust ? `${base}?t=${Date.now()}` : base;
}

function applyWindowState(nextState = {}) {
  windowState = { ...windowState, ...nextState };
  const isMaximized = !!windowState.isMaximized;
  btnToggleMaximizeWindow.classList.toggle('is-maximized', isMaximized);
  const label = t(isMaximized ? 'restoreWindow' : 'maximizeWindow');
  btnToggleMaximizeWindow.title = label;
  btnToggleMaximizeWindow.setAttribute('aria-label', label);
}

function scheduleUiTask(key, fn) {
  if (scheduledUiTasks.has(key)) return;
  const handle = window.requestAnimationFrame(() => {
    scheduledUiTasks.delete(key);
    fn();
  });
  scheduledUiTasks.set(key, handle);
}

function scheduleTabsRender() {
  scheduleUiTask('tabs', renderTabs);
}

function scheduleToolbarUpdate() {
  scheduleUiTask('toolbar', updateToolbarState);
}

function scheduleDownloadsRender() {
  if (activePanel !== panelDownloads) return;
  scheduleUiTask('downloads', renderDownloads);
}

function scheduleExtensionsRender() {
  if (activePanel !== panelExtensions) return;
  scheduleUiTask('extensions', renderExtensions);
}

function scheduleTranslatePanelRender() {
  if (activePanel !== panelTranslate) return;
  scheduleUiTask('translate-panel', renderTranslatePanel);
}

function syncBrowserVisibility() {
  if (activePanel || permissionRequestState) {
    window.ag.hideActiveView();
  } else {
    window.ag.showActiveView();
  }
}

/* ===== Theme / Settings ===== */
function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  btnThemeDark.classList.toggle('active', theme === 'dark');
  btnThemeLight.classList.toggle('active', theme === 'light');
}

function applyLang(lang) {
  currentLang = normalizeLang(lang);
  selectLanguage.value = currentLang;
  applyI18n();
  if (!settings.translateTargetLang) {
    settings.translateTargetLang = currentLang;
  }
  selectTranslateLanguage.value = getTranslateTargetValue();
  // Re-render panels that may be open
  renderDownloads();
  renderExtensions();
  renderTabs();
  renderTranslatePanel();
  updateToolbarState();
}

btnThemeDark.onclick = async () => {
  settings = await window.ag.settingsSet({ theme: 'dark' });
  applyTheme('dark');
};
btnThemeLight.onclick = async () => {
  settings = await window.ag.settingsSet({ theme: 'light' });
  applyTheme('light');
};
selectLanguage.onchange = async () => {
  const lang = normalizeLang(selectLanguage.value);
  settings = await window.ag.settingsSet({ lang });
  applyLang(lang);
};
btnSaveHomepage.onclick = async () => {
  const url = inputHomepage.value.trim();
  if (url) {
    settings = await window.ag.settingsSet({ homepage: url });
    inputHomepage.value = settings.homepage || '';
    btnSaveHomepage.textContent = t('saved');
    setTimeout(() => { btnSaveHomepage.textContent = t('save'); }, 1500);
  }
};

/* ===== Tabs Rendering ===== */
const DEFAULT_FAVICON = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSI4IiBjeT0iOCIgcj0iNyIgc3Ryb2tlPSIjOTlhMGE2IiBzdHJva2Utd2lkdGg9IjEuNSIgZmlsbD0ibm9uZSIvPjwvc3ZnPg==';

function renderTabs() {
  tabsEl.innerHTML = '';
  const pinnedTabs = tabs.filter(t => t.pinned);
  const normalTabs = tabs.filter(t => !t.pinned);
  const sorted = [...pinnedTabs, ...normalTabs];

  sorted.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeId ? ' active' : '') + (tab.pinned ? ' pinned' : '');
    const tabTitle = getTabDisplayTitle(tab);
    el.title = tabTitle;
    el.setAttribute('data-tab-id', tab.id);

    if (tab.loading) {
      const spinner = document.createElement('div');
      spinner.className = 'tab-spinner';
      el.appendChild(spinner);
    } else {
      const favicon = document.createElement('img');
      favicon.className = 'favicon';
      favicon.src = tab.favicon || DEFAULT_FAVICON;
      favicon.onerror = () => { favicon.src = DEFAULT_FAVICON; };
      el.appendChild(favicon);
    }

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = tabTitle;
    el.appendChild(title);

    if (tab.pinned) {
      const pin = document.createElement('div');
      pin.className = 'pin-indicator';
      pin.textContent = '\u25C6';
      el.appendChild(pin);
    } else {
      const close = document.createElement('div');
      close.className = 'close';
      close.textContent = '\u2715';
      close.onclick = (e) => { e.stopPropagation(); window.ag.closeTab(tab.id); };
      el.appendChild(close);
    }

    el.onclick = () => window.ag.activateTab(tab.id);
    el.oncontextmenu = (e) => { e.preventDefault(); showTabContextMenu(e.clientX, e.clientY, tab); };
    tabsEl.appendChild(el);
  });
}

/* ===== Context Menu ===== */
function showTabContextMenu(x, y, tab) {
  if (contextMenu) contextMenu.remove();
  contextMenu = document.createElement('div');
  contextMenu.className = 'context-menu';
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';

  const items = [
    { label: tab.pinned ? t('unpinTab') : t('pinTab'), action: () => window.ag.togglePinTab(tab.id) },
    { label: t('closeTab'), action: () => window.ag.closeTab(tab.id) },
    { label: t('closeOthers'), action: () => { tabs.forEach(t => { if (t.id !== tab.id && !t.pinned) window.ag.closeTab(t.id); }); }},
    { label: t('closeRight'), action: () => { const idx = tabs.findIndex(x => x.id === tab.id); if (idx !== -1) for (let i = idx + 1; i < tabs.length; i++) if (!tabs[i].pinned) window.ag.closeTab(tabs[i].id); }}
  ];

  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'context-menu-item';
    el.textContent = item.label;
    el.onclick = () => { item.action(); contextMenu.remove(); contextMenu = null; };
    contextMenu.appendChild(el);
  });

  document.body.appendChild(contextMenu);
  const closeMenu = (e) => {
    if (contextMenu && !contextMenu.contains(e.target)) {
      contextMenu.remove(); contextMenu = null;
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 50);
}

/* ===== Toolbar ===== */
function updateToolbarState() {
  const tab = getActiveTab();
  btnBack.disabled = !(tab && tab.canGoBack);
  btnFwd.disabled = !(tab && tab.canGoForward);
  btnReadMode.disabled = !isReadModeAvailable(tab);
  btnReadMode.classList.toggle('active', !!tab?.readModeEnabled);
  btnReadMode.setAttribute('aria-pressed', String(!!tab?.readModeEnabled));
  btnReadMode.title = tab?.readModeEnabled ? t('exitReadMode') : t('readMode');
  btnReadMode.setAttribute('aria-label', btnReadMode.title);
  btnTranslate.disabled = !isTranslatableTab(tab);
  btnTranslate.classList.toggle('active', !!tab?.translatedTo);
  btnTranslate.setAttribute('aria-pressed', String(!!tab?.translatedTo));
  btnTranslate.title = t('translatePage');
  btnTranslate.setAttribute('aria-label', btnTranslate.title);
  if (document.activeElement !== address) {
    address.value = tab ? tab.url : '';
  }
}

btnBack.onclick = () => window.ag.back();
btnFwd.onclick = () => window.ag.forward();
btnReload.onclick = () => window.ag.reload();
btnReadMode.onclick = async () => {
  const result = await window.ag.toggleReadMode();
  if (!result?.success && result?.messageKey) {
    showToast(t(result.messageKey));
  }
};
btnTranslate.onclick = async () => {
  if (activePanel === panelTranslate) { hideAllPanels(); return; }
  settings = await window.ag.settingsGet();
  if (!settings.translateTargetLang) {
    settings.translateTargetLang = settings.lang || currentLang || DEFAULT_LANG;
  }
  selectTranslateLanguage.value = getTranslateTargetValue();
  renderTranslatePanel();
  showPanel(panelTranslate);
};
btnNew.onclick = () => window.ag.createTab(settings.homepage || '');
btnMinimizeWindow.onclick = () => window.ag.windowMinimize();
btnToggleMaximizeWindow.onclick = async () => {
  const nextState = await window.ag.windowToggleMaximize();
  applyWindowState(nextState);
};
btnCloseWindow.onclick = () => window.ag.windowClose();

address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const url = normalizeUrl(address.value.trim());
    if (url) window.ag.goTo(url).catch(() => {});
  }
});
address.addEventListener('focus', () => address.select());
address.addEventListener('blur', () => {
  const tab = getActiveTab();
  if (tab) address.value = tab.url;
});

function renderTranslatePanel() {
  const tab = getActiveTab();
  const targetLang = getTranslateTargetValue();
  selectTranslateLanguage.value = targetLang;

  if (!tab) {
    translateStatus.textContent = t('translateUnavailable');
    translatePageUrl.textContent = '';
    btnTranslateApply.disabled = true;
    btnTranslateRestore.disabled = true;
    return;
  }

  const sourceUrl = tab.translationOriginalUrl || tab.url || '';
  translatePageUrl.textContent = sourceUrl;
  btnTranslateApply.disabled = !isTranslatableTab(tab);
  btnTranslateRestore.disabled = !tab.translationOriginalUrl;

  if (!isTranslatableTab(tab)) {
    translateStatus.textContent = t('translateUnavailable');
    return;
  }

  if (tab.translatedTo) {
    translateStatus.textContent = formatUiString(t('translateStatusActive'), {
      language: getLanguageLabel(tab.translatedTo)
    });
    return;
  }

  translateStatus.textContent = formatUiString(t('translateStatusReady'), {
    language: getLanguageLabel(targetLang)
  });
}

/* ===== Panels ===== */
function hidePanelsOnly() {
  panelDownloads.classList.add('hidden');
  panelExtensions.classList.add('hidden');
  panelTranslate.classList.add('hidden');
  panelSettings.classList.add('hidden');
  panelOverlay.classList.add('hidden');
  activePanel = null;
}

function showPanel(panel) {
  hidePanelsOnly();
  panel.classList.remove('hidden');
  panelOverlay.classList.remove('hidden');
  activePanel = panel;
  syncBrowserVisibility();
}

function hideAllPanels() {
  hidePanelsOnly();
  syncBrowserVisibility();
}

btnDownloads.onclick = async () => {
  if (activePanel === panelDownloads) { hideAllPanels(); return; }
  dls = await window.ag.dlList();
  renderDownloads();
  showPanel(panelDownloads);
};
btnCloseDownloads.onclick = () => hideAllPanels();
btnClearFinished.onclick = async () => { dls = await window.ag.dlClearFinished(); renderDownloads(); };

btnExtensions.onclick = async () => {
  if (activePanel === panelExtensions) { hideAllPanels(); return; }
  exts = await window.ag.extList();
  renderExtensions();
  showPanel(panelExtensions);
};
btnCloseExtensions.onclick = () => hideAllPanels();
btnReloadExt.onclick = async () => { exts = await window.ag.extReload(); renderExtensions(); };
btnImportExt.onclick = async () => {
  const result = await window.ag.extImport();
  if (result?.success) { exts = await window.ag.extList(); renderExtensions(); }
};
btnImportZip.onclick = async () => {
  const result = await window.ag.extImportZip();
  if (result?.success) { exts = await window.ag.extList(); renderExtensions(); }
};

btnCloseTranslate.onclick = () => hideAllPanels();
selectTranslateLanguage.onchange = async () => {
  const translateTargetLang = normalizeLang(selectTranslateLanguage.value);
  settings = await window.ag.settingsSet({ translateTargetLang });
  renderTranslatePanel();
};
btnTranslateApply.onclick = async () => {
  const translateTargetLang = normalizeLang(selectTranslateLanguage.value);
  settings = await window.ag.settingsSet({ translateTargetLang });
  hideAllPanels();
  const result = await window.ag.translatePage(translateTargetLang);
  if (!result?.success) {
    showToast(t(result?.messageKey || 'translateUnavailable'));
    return;
  }
};
btnTranslateRestore.onclick = async () => {
  hideAllPanels();
  const result = await window.ag.restoreOriginalPage();
  if (!result?.success) {
    showToast(t(result?.messageKey || 'translateUnavailable'));
    return;
  }
};

btnSettings.onclick = async () => {
  if (activePanel === panelSettings) { hideAllPanels(); return; }
  settings = await window.ag.settingsGet();
  applyTheme(settings.theme);
  applyLang(settings.lang || DEFAULT_LANG);
  inputHomepage.value = settings.homepage || '';
  showPanel(panelSettings);
};
btnCloseSettings.onclick = () => hideAllPanels();

btnClearPermissions.onclick = async () => {
  await window.ag.permissionsClear();
  btnClearPermissions.textContent = t('savedPermissionsCleared');
  setTimeout(() => {
    btnClearPermissions.textContent = t('clearSavedPermissions');
  }, 1500);
};

panelOverlay.onclick = () => hideAllPanels();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && permissionRequestState) {
    e.preventDefault();
    submitPermissionResponse('deny');
    return;
  }
  if (e.key === 'Escape' && activePanel) hideAllPanels();
});

/* ===== Permission Prompts ===== */
function closePermissionPrompt() {
  permissionOverlay.classList.add('hidden');
  permissionRequestState = null;
  selectedPermissionSourceId = null;
  permissionRemember.checked = false;
  permissionSources.innerHTML = '';
  permissionSources.classList.add('hidden');
  btnPermissionAlwaysAllow.classList.add('hidden');
  btnPermissionAlwaysAllow.textContent = '';
  permissionNote.textContent = '';
  permissionNote.classList.add('hidden');
  syncBrowserVisibility();
}

function renderPermissionSources(sources = []) {
  permissionSources.innerHTML = '';
  permissionSources.classList.toggle('hidden', sources.length === 0);

  sources.forEach((source) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'permission-source' + (source.id === selectedPermissionSourceId ? ' active' : '');
    button.setAttribute('data-source-id', source.id);

    const thumb = source.thumbnail
      ? `<img src="${escapeHtml(source.thumbnail)}" alt="" />`
      : `<div class="permission-source-placeholder">${escapeHtml(source.kind || '')}</div>`;
    const icon = source.icon
      ? `<img class="permission-source-app-icon" src="${escapeHtml(source.icon)}" alt="" />`
      : '';

    button.innerHTML = `
      <div class="permission-source-thumb">${thumb}</div>
      <div class="permission-source-meta">
        <div>
          <div class="permission-source-name">${escapeHtml(source.name)}</div>
          <div class="permission-source-kind">${escapeHtml(source.kind || '')}</div>
        </div>
        ${icon}
      </div>
    `;

    button.onclick = () => {
      selectedPermissionSourceId = source.id;
      renderPermissionSources(sources);
      btnPermissionAllow.disabled = false;
    };

    permissionSources.appendChild(button);
  });
}

function showPermissionPrompt(payload) {
  hidePanelsOnly();
  permissionRequestState = payload;
  selectedPermissionSourceId = null;

  permissionTitle.textContent = payload.title || '';
  permissionSite.textContent = payload.site || '';
  permissionMessage.textContent = payload.message || '';
  permissionOriginLabel.textContent = payload.originLabel || '';
  permissionOriginValue.textContent = payload.origin || '';
  permissionRememberText.textContent = payload.rememberLabel || '';
  permissionRememberRow.classList.toggle('hidden', payload.canRemember === false);
  permissionRemember.checked = false;
  btnPermissionDeny.textContent = payload.denyLabel || t('permissionDeny');
  btnPermissionAllow.textContent = payload.allowLabel || t('permissionAllow');
  btnPermissionAlwaysAllow.textContent = payload.alwaysAllowLabel || '';
  btnPermissionAlwaysAllow.classList.toggle('hidden', !payload.alwaysAllowLabel);

  if (payload.note) {
    permissionNote.textContent = payload.note;
    permissionNote.classList.remove('hidden');
  } else {
    permissionNote.textContent = '';
    permissionNote.classList.add('hidden');
  }

  renderPermissionSources(payload.sources || []);
  btnPermissionAllow.disabled = payload.kind === 'display-source';

  permissionOverlay.classList.remove('hidden');
  syncBrowserVisibility();
}

function submitPermissionResponse(action) {
  if (!permissionRequestState) return;

  const response = {
    id: permissionRequestState.id,
    action,
    remember: !!permissionRemember.checked
  };

  if (permissionRequestState.kind === 'display-source') {
    response.sourceId = selectedPermissionSourceId;
  }

  closePermissionPrompt();
  window.ag.permissionRespond(response).catch(() => {});
}

btnPermissionDeny.onclick = () => submitPermissionResponse('deny');
btnPermissionAlwaysAllow.onclick = () => submitPermissionResponse('allow-always');
btnPermissionAllow.onclick = () => {
  if (permissionRequestState?.kind === 'display-source' && !selectedPermissionSourceId) return;
  submitPermissionResponse('allow');
};

/* ===== Downloads Rendering ===== */
function renderDownloads() {
  downloadsList.innerHTML = '';
  if (dls.length === 0) {
    downloadsList.innerHTML = `<div class="item"><div class="sub" style="text-align:center;">${t('noDownloads')}</div></div>`;
    return;
  }
  for (const d of dls) {
    const pct = d.total ? Math.min(100, Math.floor(100 * d.received / d.total)) : 0;
    const isActive = d.state === 'progressing';
    const isDone = d.state === 'completed';
    const el = document.createElement('div');
    el.className = 'item' + (isDone ? ' dl-done' : '') + (d.state === 'cancelled' || d.state === 'interrupted' ? ' dl-error' : '');
    const sizeText = isDone ? fmtBytes(d.received || d.total) : `${fmtBytes(d.received)} / ${fmtBytes(d.total)}${d.total ? ` (${pct}%)` : ''}`;
    el.innerHTML = `
      <div class="row">
        <div class="title">${escapeHtml(d.filename)}</div>
        <div class="badge ${isDone ? 'badge-done' : ''}">${getStateText(d.state)}</div>
      </div>
      ${isActive && d.total ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ''}
      <div class="sub">${sizeText}</div>
      <div class="row" style="margin-top:6px;">
        <div class="sub" style="flex:1;word-break:break-all;">${escapeHtml(d.savePath || '')}</div>
        ${d.savePath ? `<button class="reveal" data-dl-id="${d.id}">${t('showInFolder')}</button>` : ''}
      </div>`;
    const revealBtn = el.querySelector('.reveal');
    if (revealBtn) revealBtn.onclick = () => window.ag.dlReveal(d.id);
    downloadsList.appendChild(el);
  }
}

/* ===== Extensions Rendering ===== */
function renderExtensions() {
  extensionsList.innerHTML = '';
  if (exts.length === 0) {
    extensionsList.innerHTML = `<div class="item"><div class="sub" style="text-align:center;">${t('noExtensions')}</div></div>`;
    return;
  }
  for (const e of exts) {
    const el = document.createElement('div');
    el.className = 'item';
    const zipBadgeHtml = e.isZip ? `<span class="badge badge-zip">${t('zipBadge')}</span>` : '';
    const overrideHtml = e.hasOverrides && e.enabled ? `<span class="badge badge-override">${t('uiOverride')}</span>` : '';

    el.innerHTML = `
      <div class="row">
        <div class="title">${escapeHtml(e.name)} <span class="sub" style="margin:0;">v${escapeHtml(e.version)}</span> ${zipBadgeHtml} ${overrideHtml}</div>
        <div class="ext-actions">
          ${e.hasPopup && e.enabled ? `<button class="ext-popup-btn" title="${t('openUi')}">&#x25A3;</button>` : ''}
          <button class="ext-toggle-btn ${e.enabled !== false ? 'active' : ''}" title="${e.enabled !== false ? t('disable') : t('enable')}">${e.enabled !== false ? '&#x25CF;' : '&#x25CB;'}</button>
          <button class="ext-remove-btn" title="${t('remove')}">&#x2715;</button>
        </div>
      </div>
      <div class="sub">${escapeHtml(e.path)}</div>`;

    const popupBtn = el.querySelector('.ext-popup-btn');
    if (popupBtn) popupBtn.onclick = () => window.ag.extOpenPopup(e.id || e.dirName);

    el.querySelector('.ext-toggle-btn').onclick = async () => {
      await window.ag.extToggle(e.id || e.dirName);
      exts = await window.ag.extList();
      renderExtensions();
    };

    el.querySelector('.ext-remove-btn').onclick = async () => {
      await window.ag.extRemove(e.id || e.dirName);
      exts = await window.ag.extList();
      renderExtensions();
    };

    extensionsList.appendChild(el);
  }
}

/* ===== IPC Events ===== */
window.ag.onTabsList((list, active) => {
  tabs = list;
  activeId = active;
  scheduleTabsRender();
  scheduleToolbarUpdate();
  scheduleTranslatePanelRender();
});
window.ag.onActiveChanged((id) => {
  activeId = id;
  scheduleTabsRender();
  scheduleToolbarUpdate();
  scheduleTranslatePanelRender();
});
window.ag.onTabUpdated((tab) => {
  const i = tabs.findIndex(t => t.id === tab.id);
  if (i !== -1) tabs[i] = tab;
  if (tab.id === activeId && document.activeElement !== address) {
    address.value = tab.url;
  }
  scheduleTabsRender();
  scheduleToolbarUpdate();
  scheduleTranslatePanelRender();
});
window.ag.onDlCreated((d) => {
  dls.push(d);
  scheduleDownloadsRender();
});
window.ag.onDlProgress((p) => {
  const i = dls.findIndex(x => x.id === p.id);
  if (i !== -1) {
    dls[i] = { ...dls[i], ...p };
    scheduleDownloadsRender();
  }
});
window.ag.onDlDone((p) => {
  const i = dls.findIndex(x => x.id === p.id);
  if (i !== -1) {
    dls[i] = { ...dls[i], ...p };
    scheduleDownloadsRender();
  }
});
window.ag.onExtList((list) => {
  exts = list;
  scheduleExtensionsRender();
});
window.ag.onWindowState((nextState) => applyWindowState(nextState));
window.ag.onPermissionPrompt((payload) => showPermissionPrompt(payload));

// Focus address bar (triggered by Cmd/Ctrl+L from menu)
window.ag.onFocusAddress(() => {
  address.focus();
  address.select();
});

// CSS hot-reload for extension theme toggling
window.ag.onReloadCss(() => {
  ensureRuntimeThemeLink(true);
});

// UI visibility
window.ag.onUiVisibility((visible) => {
  if (visible) { document.body.classList.remove('browser-fullscreen'); isBrowserFullscreen = false; }
  else {
    document.body.classList.add('browser-fullscreen');
    isBrowserFullscreen = true;
    hideAllPanels();
    if (permissionRequestState) submitPermissionResponse('deny');
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'F11') { e.preventDefault(); window.ag.toggleUiHide(); } });

/* ===== Init ===== */
(async () => {
  // Load settings first
  extThemeHref = await window.ag.extThemeHref();
  ensureRuntimeThemeLink();
  applyWindowState(await window.ag.windowGetState());

  settings = await window.ag.settingsGet();
  applyTheme(settings.theme || 'dark');
  settings.translateTargetLang = normalizeLang(settings.translateTargetLang || settings.lang || DEFAULT_LANG);
  applyLang(settings.lang || DEFAULT_LANG);
  selectTranslateLanguage.value = getTranslateTargetValue();
  renderTranslatePanel();

  exts = await window.ag.extList();
  renderExtensions();

  // Load tabs
  const state = await window.ag.getState();
  tabs = state.tabs || [];
  activeId = state.activeId || (tabs[0]?.id ?? null);
  if (!tabs.length) await window.ag.createTab(settings.homepage || '');
  renderTabs();
  updateToolbarState();
})();
