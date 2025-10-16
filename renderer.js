const tabsEl = document.getElementById('tabs');
const btnBack = document.getElementById('btnBack');
const btnFwd = document.getElementById('btnFwd');
const btnReload = document.getElementById('btnReload');
const btnNew = document.getElementById('btnNew');
const address = document.getElementById('address');

const btnDownloads = document.getElementById('btnDownloads');
const btnExtensions = document.getElementById('btnExtensions');

const panelDownloads = document.getElementById('panelDownloads');
const downloadsList = document.getElementById('downloadsList');
const btnCloseDownloads = document.getElementById('btnCloseDownloads');
const btnClearFinished = document.getElementById('btnClearFinished');

const panelExtensions = document.getElementById('panelExtensions');
const extensionsList = document.getElementById('extensionsList');
const btnCloseExtensions = document.getElementById('btnCloseExtensions');
const btnReloadExt = document.getElementById('btnReloadExt');

let tabs = [];
let activeId = null;
let dls = [];
let exts = [];

function isHttp(url) { return /^https?:\/\//i.test(url); }
function normalizeUrl(u) { if (!u) return ''; return isHttp(u) ? u : `https://${u}`; }

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeId ? ' active' : '');
    el.title = t.title || t.url;

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = t.title || t.url || 'New Tab';

    const close = document.createElement('div');
    close.className = 'close';
    close.textContent = '✕';
    close.onclick = (e) => { e.stopPropagation(); window.ag.closeTab(t.id); };

    el.onclick = () => window.ag.activateTab(t.id);
    el.appendChild(title);
    el.appendChild(close);
    tabsEl.appendChild(el);
  }
}

function updateToolbarState() {
  const t = tabs.find(x => x.id === activeId);
  btnBack.disabled = !(t && t.canGoBack);
  btnFwd.disabled = !(t && t.canGoForward);
  address.value = t ? t.url : '';
}

btnBack.onclick = () => window.ag.back();
btnFwd.onclick = () => window.ag.forward();
btnReload.onclick = () => window.ag.reload();
btnNew.onclick = () => window.ag.createTab('https://xs-corp.github.io/ag/');

address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const url = normalizeUrl(address.value.trim());
    if (url) window.ag.goTo(url);
  }
});

// Панели
function toggle(el, show) { el.classList[show ? 'remove' : 'add']('hidden'); }

btnDownloads.onclick = async () => {
  dls = await window.ag.dlList();
  renderDownloads();
  toggle(panelDownloads, true);
};
btnCloseDownloads.onclick = () => toggle(panelDownloads, false);
btnClearFinished.onclick = async () => { dls = await window.ag.dlClearFinished(); renderDownloads(); };

btnExtensions.onclick = async () => {
  exts = await window.ag.extList();
  renderExtensions();
  toggle(panelExtensions, true);
};
btnCloseExtensions.onclick = () => toggle(panelExtensions, false);
btnReloadExt.onclick = async () => { exts = await window.ag.extReload(); renderExtensions(); };

// Рендер загрузок/расширений
function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const k = 1024; const units = ['B','KB','MB','GB','TB'];
  let i = 0, val = n;
  while (val >= k && i < units.length - 1) { val /= k; i++; }
  return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
function renderDownloads() {
  downloadsList.innerHTML = '';
  for (const d of dls) {
    const pct = d.total ? Math.min(100, Math.floor(100 * d.received / d.total)) : 0;
    const el = document.createElement('div'); el.className = 'item';
    el.innerHTML = `
      <div class="row">
        <div class="title">${d.filename}</div>
        <div class="badge">${d.state}</div>
      </div>
      <div class="sub">${d.url}</div>
      <div class="sub">${fmtBytes(d.received)} / ${fmtBytes(d.total)}</div>
      <div class="progress"><div style="width:${pct}%;"></div></div>
      <div class="row" style="margin-top:8px;">
        <div class="sub">${d.savePath || ''}</div>
        <div><button data-id="${d.id}" class="reveal">Показать в папке</button></div>
      </div>`;
    el.querySelector('.reveal').onclick = () => window.ag.dlReveal(d.id);
    downloadsList.appendChild(el);
  }
}
function renderExtensions() {
  extensionsList.innerHTML = '';
  for (const e of exts) {
    const el = document.createElement('div'); el.className = 'item';
    el.innerHTML = `
      <div class="row">
        <div class="title">${e.name} <span class="sub">v${e.version}</span></div>
        <div class="badge">ID: ${e.id}</div>
      </div>
      <div class="sub">${e.path}</div>`;
    extensionsList.appendChild(el);
  }
}

// IPC события
window.ag.onTabsList((list, active) => { tabs = list; activeId = active; renderTabs(); updateToolbarState(); });
window.ag.onActiveChanged((id) => { activeId = id; renderTabs(); updateToolbarState(); });
window.ag.onTabUpdated((tab) => {
  const i = tabs.findIndex(t => t.id === tab.id);
  if (i !== -1) tabs[i] = tab;
  if (tab.id === activeId) address.value = tab.url;
  renderTabs(); updateToolbarState();
});

window.ag.onDlCreated((d) => { dls.push(d); renderDownloads(); });
window.ag.onDlProgress((p) => {
  const i = dls.findIndex(x => x.id === p.id);
  if (i !== -1) { dls[i] = { ...dls[i], ...p }; renderDownloads(); }
});
window.ag.onDlDone((p) => {
  const i = dls.findIndex(x => x.id === p.id);
  if (i !== -1) { dls[i] = { ...dls[i], ...p }; renderDownloads(); }
});
window.ag.onExtList((list) => { exts = list; renderExtensions(); });

// init
(async () => {
  const state = await window.ag.getState();
  tabs = state.tabs || [];
  activeId = state.activeId || (tabs[0]?.id ?? null);
  if (!tabs.length) await window.ag.createTab('https://xs-corp.github.io/ag/');
  renderTabs(); updateToolbarState();
})();
