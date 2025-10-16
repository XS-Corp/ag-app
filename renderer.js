const tabsEl = document.getElementById('tabs');
const btnBack = document.getElementById('btnBack');
const btnFwd = document.getElementById('btnFwd');
const btnReload = document.getElementById('btnReload');
const btnNew = document.getElementById('btnNew');
const address = document.getElementById('address');

const btnDownloads = document.getElementById('btnDownloads');
const btnExtensions = document.getElementById('btnExtensions');

const panelOverlay = document.getElementById('panelOverlay');
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
let activePanel = null;
let isBrowserFullscreen = false;
let contextMenu = null;

function isHttp(url) {
    return /^https?:\/\//i.test(url);
}

function normalizeUrl(u) {
    if (!u) return '';
    u = u.trim();
    if (isHttp(u)) return u;
    if (u.includes('.') && !u.includes(' ')) {
        return `https://${u}`;
    }
    return `https://www.google.com/search?q=${encodeURIComponent(u)}`;
}

function renderTabs() {
    tabsEl.innerHTML = '';
    
    // Сортируем вкладки: сначала закрепленные, потом обычные
    const pinnedTabs = tabs.filter(t => t.pinned);
    const normalTabs = tabs.filter(t => !t.pinned);
    const sortedTabs = [...pinnedTabs, ...normalTabs];
    
    sortedTabs.forEach(t => {
        const el = document.createElement('div');
        el.className = 'tab' + (t.id === activeId ? ' active' : '') + (t.pinned ? ' pinned' : '');
        el.title = t.title || t.url;
        el.setAttribute('data-tab-id', t.id);

        const favicon = document.createElement('img');
        favicon.className = 'favicon';
        favicon.src = t.favicon || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTggMS4zMzMzQzQuMzIgMS4zMzMzIDEuMzMzMyA0LjMyIDEuMzMzMyA4QzEuMzMzMyAxMS42OCA0LjMyIDE0LjY2NjcgOCAxNC42NjY3QzExLjY4IDE0LjY2NjcgMTQuNjY2NyAxMS42OCAxNC42NjY3IDhDMTQuNjY2NyA0LjMyIDExLjY4IDEuMzMzMyA4IDEuMzMzM1pNOC44NjY2NyA4VjQuNjY2NjdINy4xMzMzM1Y4SDEwLjY2NjdWNi4yNjY2N0g4Ljg2NjY3VjhaIiBmaWxsPSIjOTlhMGE2Ii8+Cjwvc3ZnPgo=';
        favicon.onerror = () => {
            favicon.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTggMS4zMzMzQzQuMzIgMS4zMzMzIDEuMzMzMyA0LjMyIDEuMzMzMyA4QzEuMzMzMyAxMS42OCA0LjMyIDE0LjY2NjcgOCAxNC42NjY3QzExLjY4IDE0LjY2NjcgMTQuNjY2NyAxMS42OCAxNC42NjY3IDhDMTQuNjY2NyA0LjMyIDExLjY4IDEuMzMzMyA4IDEuMzMzM1pNOC44NjY2NyA4VjQuNjY2NjdINy4xMzMzM1Y4SDEwLjY2NjdWNi4yNjY2N0g4Ljg2NjY3VjhaIiBmaWxsPSIjOTlhMGE2Ii8+Cjwvc3ZnPgo=';
        };

        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = t.title || t.url || 'New Tab';

        const pinIndicator = document.createElement('div');
        pinIndicator.className = 'pin-indicator';
        pinIndicator.innerHTML = '📌';
        pinIndicator.title = 'Закрепленная вкладка';

        const close = document.createElement('div');
        close.className = 'close';
        close.textContent = '✕';
        close.onclick = (e) => {
            e.stopPropagation();
            window.ag.closeTab(t.id);
        };

        el.appendChild(favicon);
        el.appendChild(title);
        if (t.pinned) {
            el.appendChild(pinIndicator);
        }
        if (!t.pinned) {
            el.appendChild(close);
        }

        el.onclick = () => window.ag.activateTab(t.id);
        
        // Контекстное меню по правому клику
        el.oncontextmenu = (e) => {
            e.preventDefault();
            showTabContextMenu(e.clientX, e.clientY, t);
        };

        tabsEl.appendChild(el);
    });
}

function showTabContextMenu(x, y, tab) {
    // Удаляем старое контекстное меню
    if (contextMenu) {
        contextMenu.remove();
    }

    contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';

    const menuItems = [
        {
            label: tab.pinned ? 'Открепить вкладку' : 'Закрепить вкладку',
            action: () => window.ag.togglePinTab(tab.id)
        },
        {
            label: 'Закрыть вкладку',
            action: () => window.ag.closeTab(tab.id)
        },
        {
            label: 'Закрыть другие вкладки',
            action: () => closeOtherTabs(tab.id)
        },
        {
            label: 'Закрыть вкладки справа',
            action: () => closeTabsToRight(tab.id)
        }
    ];

    menuItems.forEach(item => {
        const menuItem = document.createElement('div');
        menuItem.className = 'context-menu-item';
        menuItem.textContent = item.label;
        menuItem.onclick = () => {
            item.action();
            contextMenu.remove();
            contextMenu = null;
        };
        contextMenu.appendChild(menuItem);
    });

    document.body.appendChild(contextMenu);

    // Закрываем меню при клике вне его
    const closeMenu = (e) => {
        if (contextMenu && !contextMenu.contains(e.target)) {
            contextMenu.remove();
            contextMenu = null;
            document.removeEventListener('click', closeMenu);
        }
    };
    
    setTimeout(() => {
        document.addEventListener('click', closeMenu);
    }, 100);
}

function closeOtherTabs(keepId) {
    tabs.forEach(tab => {
        if (tab.id !== keepId && !tab.pinned) {
            window.ag.closeTab(tab.id);
        }
    });
}

function closeTabsToRight(tabId) {
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex !== -1) {
        for (let i = tabIndex + 1; i < tabs.length; i++) {
            if (!tabs[i].pinned) {
                window.ag.closeTab(tabs[i].id);
            }
        }
    }
}

function updateToolbarState() {
    const t = tabs.find(x => x.id === activeId);
    btnBack.disabled = !(t && t.canGoBack);
    btnFwd.disabled = !(t && t.canGoForward);
    address.value = t ? t.url : '';
}

// Навигация
btnBack.onclick = () => window.ag.back();
btnFwd.onclick = () => window.ag.forward();
btnReload.onclick = () => window.ag.reload();
btnNew.onclick = () => window.ag.createTab('https://xs-corp.github.io/ag/');

// Обработчики адресной строки
address.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const inputUrl = address.value.trim();
        
        if (!inputUrl) return;
        
        const url = normalizeUrl(inputUrl);
        console.log('Navigating to:', url);
        
        if (url) {
            window.ag.goTo(url).then(success => {
                if (!success) {
                    console.error('Failed to navigate');
                }
            }).catch(err => {
                console.error('Navigation error:', err);
            });
        }
    }
});

address.addEventListener('focus', () => {
    address.select();
});

address.addEventListener('blur', () => {
    const t = tabs.find(x => x.id === activeId);
    if (t) {
        address.value = t.url;
    }
});

// Управление панелями
function showPanel(panel) {
    hideAllPanels();
    
    panel.classList.remove('hidden');
    panelOverlay.classList.remove('hidden');
    activePanel = panel;
    
    window.ag.hideActiveView();
}

function hideAllPanels() {
    panelDownloads.classList.add('hidden');
    panelExtensions.classList.add('hidden');
    panelOverlay.classList.add('hidden');
    activePanel = null;
    
    window.ag.showActiveView();
}

// Обработчики для панели загрузок
btnDownloads.onclick = async () => {
    if (activePanel === panelDownloads) {
        hideAllPanels();
        return;
    }
    dls = await window.ag.dlList();
    renderDownloads();
    showPanel(panelDownloads);
};

btnCloseDownloads.onclick = () => hideAllPanels();

btnClearFinished.onclick = async () => {
    dls = await window.ag.dlClearFinished();
    renderDownloads();
};

// Обработчики для панели расширений
btnExtensions.onclick = async () => {
    if (activePanel === panelExtensions) {
        hideAllPanels();
        return;
    }
    exts = await window.ag.extList();
    renderExtensions();
    showPanel(panelExtensions);
};

btnCloseExtensions.onclick = () => hideAllPanels();
btnReloadExt.onclick = async () => {
    exts = await window.ag.extReload();
    renderExtensions();
};

// Закрытие панелей по клику на оверлей или Escape
panelOverlay.onclick = () => hideAllPanels();

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activePanel) {
        hideAllPanels();
    }
});

// Рендер загрузок
function fmtBytes(n) {
    if (!n && n !== 0) return '';
    const k = 1024;
    const units = ['B','KB','MB','GB','TB'];
    let i = 0, val = n;
    while (val >= k && i < units.length - 1) {
        val /= k;
        i++;
    }
    return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function getStateText(state) {
    const states = {
        'progressing': 'Загружается',
        'completed': 'Завершено',
        'cancelled': 'Отменено',
        'interrupted': 'Прервано'
    };
    return states[state] || state;
}

function renderDownloads() {
    downloadsList.innerHTML = '';
    
    if (dls.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'item';
        empty.innerHTML = '<div class="sub" style="text-align: center;">Нет загрузок</div>';
        downloadsList.appendChild(empty);
        return;
    }
    
    for (const d of dls) {
        const pct = d.total ? Math.min(100, Math.floor(100 * d.received / d.total)) : 0;
        const el = document.createElement('div');
        el.className = 'item';
        
        el.innerHTML = `
            <div class="row">
                <div class="title">${d.filename}</div>
                <div class="badge">${getStateText(d.state)}</div>
            </div>
            <div class="sub">${d.url}</div>
            <div class="sub">${fmtBytes(d.received)} / ${fmtBytes(d.total)} (${pct}%)</div>
            ${d.total ? `<div class="progress"><div style="width:${pct}%;"></div></div>` : ''}
            <div class="row" style="margin-top:8px;">
                <div class="sub" style="flex:1;">${d.savePath || ''}</div>
                ${d.savePath ? `<div><button data-id="${d.id}" class="reveal">Показать в папке</button></div>` : ''}
            </div>`;
        
        const revealBtn = el.querySelector('.reveal');
        if (revealBtn) {
            revealBtn.onclick = () => window.ag.dlReveal(d.id);
        }
        downloadsList.appendChild(el);
    }
}

// Рендер расширений
function renderExtensions() {
    extensionsList.innerHTML = '';
    
    if (exts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'item';
        empty.innerHTML = '<div class="sub" style="text-align: center;">Нет расширений</div>';
        extensionsList.appendChild(empty);
        return;
    }
    
    for (const e of exts) {
        const el = document.createElement('div');
        el.className = 'item';
        el.innerHTML = `
            <div class="row">
                <div class="title">${e.name} <span class="sub">v${e.version}</span></div>
                <div class="badge">${e.id}</div>
            </div>
            <div class="sub">${e.path}</div>`;
        extensionsList.appendChild(el);
    }
}

// Обработчики IPC событий
window.ag.onTabsList((list, active) => {
    tabs = list;
    activeId = active;
    renderTabs();
    updateToolbarState();
});

window.ag.onActiveChanged((id) => {
    activeId = id;
    renderTabs();
    updateToolbarState();
});

window.ag.onTabUpdated((tab) => {
    const i = tabs.findIndex(t => t.id === tab.id);
    if (i !== -1) tabs[i] = tab;
    if (tab.id === activeId) {
        address.value = tab.url;
        updateToolbarState();
    }
    renderTabs();
});

window.ag.onDlCreated((d) => {
    dls.push(d);
    renderDownloads();
});

window.ag.onDlProgress((p) => {
    const i = dls.findIndex(x => x.id === p.id);
    if (i !== -1) {
        dls[i] = { ...dls[i], ...p };
        renderDownloads();
    }
});

window.ag.onDlDone((p) => {
    const i = dls.findIndex(x => x.id === p.id);
    if (i !== -1) {
        dls[i] = { ...dls[i], ...p };
        renderDownloads();
    }
});

window.ag.onExtList((list) => {
    exts = list;
    renderExtensions();
});

// Обработчики полноэкранного режима
window.ag.onEnterHtmlFullscreen(() => {
    console.log('Entering HTML fullscreen');
    document.body.classList.add('browser-fullscreen');
    isBrowserFullscreen = true;
    hideAllPanels();
});

window.ag.onLeaveHtmlFullscreen(() => {
    console.log('Leaving HTML fullscreen');
    document.body.classList.remove('browser-fullscreen');
    isBrowserFullscreen = false;
});

// Показываем HUD при движении мыши в полноэкранном режиме
let hideHudTimeout;
document.addEventListener('mousemove', (e) => {
    if (isBrowserFullscreen && e.clientY < 100) {
        document.body.classList.remove('browser-fullscreen');
        clearTimeout(hideHudTimeout);
        hideHudTimeout = setTimeout(() => {
            if (isBrowserFullscreen) {
                document.body.classList.add('browser-fullscreen');
            }
        }, 2000);
    }
});

// Инициализация
(async () => {
    const state = await window.ag.getState();
    tabs = state.tabs || [];
    activeId = state.activeId || (tabs[0]?.id ?? null);
    
    if (!tabs.length) {
        await window.ag.createTab('https://xs-corp.github.io/ag/');
    }
    
    renderTabs();
    updateToolbarState();
})();
