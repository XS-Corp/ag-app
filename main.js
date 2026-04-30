/**
 * (c) 2026 KickedStorm (kickedstorm.com)
 * Project: AG Browser
 * License: GNU AGPLv3
 * Unauthorized copying of this file is strictly prohibited.
 */
const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  protocol,
  shell,
  clipboard,
  dialog,
  globalShortcut,
  Menu,
  desktopCapturer,
  systemPreferences,
  webContents: electronWebContents
} = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { fileURLToPath, pathToFileURL } = require('url');
const AdmZip = require('adm-zip');
const {
  BUILTIN_HOMEPAGE_URL,
  DEFAULT_CUSTOM_HOMEPAGE,
  HOMEPAGE_MODE_BUILTIN,
  HOMEPAGE_MODE_CUSTOM,
  isBuiltinHomepageUrl,
  buildBuiltinHomepageHtml
} = require('./builtin-home');
const {
  DEFAULT_LANG,
  LANGUAGES,
  getLangConfig,
  getMenuStrings,
  getTranslationLangCode,
  getUiStrings,
  normalizeLang
} = require('./i18n');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ag',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);

const APP_ROOT = __dirname;
const BROWSER_PRELOAD_FILE = path.join(APP_ROOT, 'browser-preload.js');
const EMPTY_EXT_THEME = '/* no extension theme active */\n';
const SEARCH_FALLBACK_PREFIX = 'https://www.google.com/search?q=';
const GOOGLE_TRANSLATE_API_URL = 'https://translate.googleapis.com/translate_a/t';
const GOOGLE_TRANSLATE_BATCH_LIMIT = 6000;
const SAFE_BROWSER_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_VIEW_EXTERNAL_PROTOCOLS = new Set(['mailto:', 'tel:']);
const SAFE_UI_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const HOSTLIKE_INPUT_RE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#].*)?$/i;
const LOCAL_HOST_INPUT_RE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i;
const LOOPBACK_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;
const DISPLAY_SOURCE_THUMBNAIL_SIZE = { width: 360, height: 220 };
const AUTO_ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);
const ALWAYS_ALLOW_PERMISSIONS = new Set();
const REQUESTABLE_PERMISSION_CHECKS = new Set(['storage-access', 'top-level-storage-access']);
const DEFAULT_PERMISSION_RULES = Object.freeze({
  camera: 'ask',
  microphone: 'ask',
  displayCapture: 'ask',
  fileSystem: 'ask',
  cookies: 'ask',
  canvasRead: 'ask',
  geolocation: 'ask',
  notifications: 'ask',
  clipboardRead: 'ask',
  idleDetection: 'ask',
  openExternal: 'ask',
  speakerSelection: 'ask',
  storageAccess: 'ask',
  windowManagement: 'ask',
  keyboardLock: 'ask'
});
const VALID_PERMISSION_RULES = new Set(['ask', 'allow', 'deny']);
const WEBRTC_IP_HANDLING_POLICY = 'default_public_interface_only';
const PROMPTED_PERMISSIONS = new Set([
  'media',
  'display-capture',
  'fileSystem',
  'cookies',
  'canvas-read',
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
const TRANSLATION_CODE_TO_LANG = new Map(
  LANGUAGES.map((lang) => [getTranslationLangCode(lang.code), lang.code])
);

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
const pendingSynchronousPermissionPrompts = new Set();
const sessionPermissionDecisions = new Map();
const configuredSessions = new WeakSet();
const MAX_HISTORY_ITEMS = 36;
const HOMEPAGE_SECTION_ITEMS = 8;
const BUILTIN_HOME_QUICK_LINKS = [
  { title: 'YouTube', url: 'https://www.youtube.com/', icon: 'YT', accent: '#ff4d6d' },
  { title: 'Telegram', url: 'https://web.telegram.org/', icon: 'TG', accent: '#44b2ff' },
  { title: 'GitHub', url: 'https://github.com/', icon: 'GH', accent: '#7c8aa5' },
  { title: 'Gmail', url: 'https://mail.google.com/', icon: 'GM', accent: '#ff7b54' },
  { title: 'Drive', url: 'https://drive.google.com/', icon: 'DR', accent: '#5aa5ff' },
  { title: 'Calendar', url: 'https://calendar.google.com/', icon: 'CL', accent: '#3d8bfd' }
];

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

function isInternalBrowserUrl(rawUrl) {
  return isBuiltinHomepageUrl(rawUrl);
}

function isNavigableBrowserUrl(rawUrl) {
  return isSafeBrowserUrl(rawUrl) || isInternalBrowserUrl(rawUrl);
}

function normalizeHomepageMode(value) {
  return value === HOMEPAGE_MODE_CUSTOM ? HOMEPAGE_MODE_CUSTOM : HOMEPAGE_MODE_BUILTIN;
}

function resolveBrowserUrl(rawUrl, { fallbackUrl = DEFAULT_CUSTOM_HOMEPAGE, allowSearchFallback = true } = {}) {
  const fallbackParsed = safeParseUrl(fallbackUrl);
  const safeFallback = isInternalBrowserUrl(fallbackUrl)
    ? BUILTIN_HOMEPAGE_URL
    : fallbackParsed && SAFE_BROWSER_PROTOCOLS.has(fallbackParsed.protocol)
      ? fallbackParsed.toString()
      : DEFAULT_CUSTOM_HOMEPAGE;

  const input = String(rawUrl || '').trim();
  if (isInternalBrowserUrl(input)) {
    return BUILTIN_HOMEPAGE_URL;
  }

  const normalized = normalizeRawUrlInput(input);
  if (normalized) {
    if (isInternalBrowserUrl(normalized)) {
      return BUILTIN_HOMEPAGE_URL;
    }
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, (match, entity) => {
    const normalized = String(entity || '').toLowerCase();
    switch (normalized) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
      case '#39':
        return "'";
      default:
        break;
    }

    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function stripHashFromUrl(rawUrl) {
  const parsed = safeParseUrl(rawUrl);
  if (!parsed) return String(rawUrl || '');
  parsed.hash = '';
  return parsed.toString();
}

function getComparableBrowserUrl(rawUrl) {
  const resolved = resolveBrowserUrl(rawUrl, {
    fallbackUrl: '',
    allowSearchFallback: false
  });
  if (!isSafeBrowserUrl(resolved)) return '';
  return stripHashFromUrl(resolved);
}

function isSameComparableBrowserUrl(left, right) {
  const normalizedLeft = getComparableBrowserUrl(left);
  const normalizedRight = getComparableBrowserUrl(right);
  return !!normalizedLeft && normalizedLeft === normalizedRight;
}

function getUiLangFromTranslationCode(code) {
  if (!code) return DEFAULT_LANG;
  return TRANSLATION_CODE_TO_LANG.get(code) || normalizeLang(code);
}

function getTranslationStateFromUrl(rawUrl) {
  const parsed = safeParseUrl(rawUrl);
  if (!parsed || parsed.pathname !== '/translate' || !/^translate\.google\./i.test(parsed.hostname)) {
    return null;
  }

  const originalUrl = parsed.searchParams.get('u');
  const targetCode = parsed.searchParams.get('tl');
  if (!originalUrl || !targetCode) return null;

  const normalizedOriginalUrl = resolveBrowserUrl(originalUrl, {
    fallbackUrl: '',
    allowSearchFallback: false
  });
  if (!isSafeBrowserUrl(normalizedOriginalUrl)) return null;

  return {
    originalUrl: normalizedOriginalUrl,
    targetLang: getUiLangFromTranslationCode(targetCode)
  };
}

function normalizeTranslationText(value) {
  return String(value || '').replace(/\r\n/g, '\n');
}

function decodeTranslatedText(value) {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?[^>]+>/g, '')
  );
}

function parseTranslatedBatchHtml(translatedHtml, expectedCount) {
  const translatedItems = new Array(expectedCount).fill('');
  const matcher = /<span\b[^>]*\bdata-ag-index=(["']?)(\d+)\1[^>]*>([\s\S]*?)<\/span>/gi;
  let match;
  while ((match = matcher.exec(String(translatedHtml || '')))) {
    const index = Number.parseInt(match[2], 10);
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) continue;
    translatedItems[index] = decodeTranslatedText(match[3]);
  }
  return translatedItems;
}

function requestGoogleTranslationBatch(html, targetCode) {
  return new Promise((resolve, reject) => {
    const url = `${GOOGLE_TRANSLATE_API_URL}?client=gtx&sl=auto&tl=${encodeURIComponent(targetCode)}&dj=1&source=input`;
    const body = new URLSearchParams({ q: html }).toString();
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'AG Browser'
      }
    }, (res) => {
      let responseText = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseText += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Google Translate request failed with status ${res.statusCode}`));
          return;
        }

        try {
          const payload = JSON.parse(responseText);
          const translatedHtml = Array.isArray(payload?.[0]) ? payload[0][0] : '';
          if (typeof translatedHtml !== 'string') {
            reject(new Error('Google Translate returned an unexpected payload'));
            return;
          }
          resolve(translatedHtml);
        } catch (error) {
          reject(new Error(`Google Translate response parse failed: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });
    req.write(body);
    req.end();
  });
}

async function translateTextsWithGoogle(texts, lang) {
  const targetCode = getTranslationLangCode(lang);
  const normalizedTexts = texts.map((text) => normalizeTranslationText(text));
  const uniqueTexts = [];
  const uniqueIndexByText = new Map();
  const indexes = normalizedTexts.map((text) => {
    if (!text) return -1;
    if (uniqueIndexByText.has(text)) return uniqueIndexByText.get(text);
    const index = uniqueTexts.length;
    uniqueIndexByText.set(text, index);
    uniqueTexts.push(text);
    return index;
  });
  const uniqueTranslations = new Array(uniqueTexts.length).fill('');

  let cursor = 0;
  while (cursor < uniqueTexts.length) {
    const batch = [];
    let encodedLength = 0;

    while (cursor < uniqueTexts.length) {
      const batchIndex = batch.length;
      const text = uniqueTexts[cursor];
      const fragment = `<span data-ag-index="${batchIndex}">${escapeHtml(text)}</span>`;
      const fragmentLength = encodeURIComponent(fragment).length;
      if (batch.length > 0 && encodedLength + fragmentLength > GOOGLE_TRANSLATE_BATCH_LIMIT) {
        break;
      }
      batch.push({
        uniqueIndex: cursor,
        fragment,
        text
      });
      encodedLength += fragmentLength;
      cursor += 1;
    }

    const translatedHtml = await requestGoogleTranslationBatch(
      batch.map((item) => item.fragment).join(''),
      targetCode
    );
    const translatedBatch = parseTranslatedBatchHtml(translatedHtml, batch.length);

    batch.forEach((item, index) => {
      uniqueTranslations[item.uniqueIndex] = translatedBatch[index] || item.text;
    });
  }

  return indexes.map((index, originalIndex) => {
    if (index === -1) return normalizedTexts[originalIndex];
    return uniqueTranslations[index] || normalizedTexts[originalIndex];
  });
}

function buildPrepareTranslationScript() {
  return `
    (() => {
      const STATE_KEY = '__ag_translate_state__';
      const PAGE_KEY = location.origin + location.pathname + location.search;
      const BLOCKED_SELECTOR = 'script,style,noscript,iframe,canvas,svg,code,pre,kbd,samp,[translate="no"],.notranslate,.skiptranslate';
      const ATTRIBUTE_SELECTOR = '[placeholder],[title],[aria-label],[alt],input[type="button"],input[type="submit"],input[type="reset"]';
      const LETTER_RE = /[\\p{L}]/u;

      const trimEdges = (value) => {
        const source = String(value || '');
        const match = source.match(/^(\\s*)([\\s\\S]*?)(\\s*)$/);
        return {
          leading: match ? match[1] : '',
          core: match ? match[2] : source,
          trailing: match ? match[3] : ''
        };
      };

      const isVisibleElement = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };

      const hasTranslatableText = (value) => LETTER_RE.test(String(value || ''));

      const existingState = window[STATE_KEY];
      if (existingState && existingState.pageKey === PAGE_KEY && Array.isArray(existingState.entries) && existingState.entries.length) {
        return {
          ok: true,
          reused: true,
          texts: existingState.entries.map((entry) => entry.original)
        };
      }

      const root = document.body || document.documentElement;
      if (!root) {
        return { ok: false, reason: 'no-root' };
      }

      const entries = [];
      const addEntry = (entry) => {
        if (!entry || !entry.original || !hasTranslatableText(entry.original)) return;
        entries.push(entry);
      };

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest(BLOCKED_SELECTOR)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (!isVisibleElement(parent)) {
            return NodeFilter.FILTER_REJECT;
          }
          const parts = trimEdges(node.nodeValue || '');
          if (!parts.core || !hasTranslatableText(parts.core)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      let currentNode = walker.nextNode();
      while (currentNode) {
        const parts = trimEdges(currentNode.nodeValue || '');
        addEntry({
          type: 'text',
          node: currentNode,
          original: parts.core,
          leading: parts.leading,
          trailing: parts.trailing
        });
        currentNode = walker.nextNode();
      }

      Array.from(root.querySelectorAll(ATTRIBUTE_SELECTOR)).forEach((element) => {
        if (!isVisibleElement(element) || element.closest(BLOCKED_SELECTOR)) {
          return;
        }

        ['placeholder', 'title', 'aria-label', 'alt'].forEach((attrName) => {
          if (!element.hasAttribute(attrName)) return;
          const parts = trimEdges(element.getAttribute(attrName) || '');
          addEntry({
            type: 'attr',
            element,
            attrName,
            original: parts.core,
            leading: parts.leading,
            trailing: parts.trailing
          });
        });

        if (element.matches('input[type="button"],input[type="submit"],input[type="reset"]')) {
          const parts = trimEdges(element.value || '');
          addEntry({
            type: 'value',
            element,
            original: parts.core,
            leading: parts.leading,
            trailing: parts.trailing
          });
        }
      });

      const titleText = String(document.title || '').trim();
      if (hasTranslatableText(titleText)) {
        addEntry({
          type: 'title',
          original: titleText,
          leading: '',
          trailing: ''
        });
      }

      window[STATE_KEY] = {
        pageKey: PAGE_KEY,
        originalLang: document.documentElement.getAttribute('lang') || '',
        appliedLang: '',
        entries
      };

      return {
        ok: entries.length > 0,
        texts: entries.map((entry) => entry.original)
      };
    })();
  `;
}

function buildApplyTranslationScript(translations, lang) {
  const serializedTranslations = JSON.stringify(translations);
  const targetDocumentLang = JSON.stringify(getLangConfig(lang).htmlLang || lang);

  return `
    (() => {
      const state = window.__ag_translate_state__;
      if (!state || !Array.isArray(state.entries) || !state.entries.length) {
        return { ok: false, reason: 'missing-state' };
      }

      const translations = ${serializedTranslations};
      let applied = 0;

      const withWhitespace = (entry, value) => \`\${entry.leading || ''}\${value}\${entry.trailing || ''}\`;

      state.entries.forEach((entry, index) => {
        const translated = typeof translations[index] === 'string' ? translations[index] : entry.original;
        const nextValue = withWhitespace(entry, translated || entry.original);

        if (entry.type === 'text') {
          if (entry.node && entry.node.isConnected) {
            entry.node.nodeValue = nextValue;
            applied += 1;
          }
          return;
        }

        if (entry.type === 'attr') {
          if (entry.element && entry.element.isConnected) {
            entry.element.setAttribute(entry.attrName, nextValue);
            try {
              entry.element[entry.attrName] = nextValue;
            } catch {}
            applied += 1;
          }
          return;
        }

        if (entry.type === 'value') {
          if (entry.element && entry.element.isConnected) {
            entry.element.value = nextValue;
            entry.element.setAttribute('value', nextValue);
            applied += 1;
          }
          return;
        }

        if (entry.type === 'title') {
          document.title = translated || entry.original;
          applied += 1;
        }
      });

      document.documentElement.setAttribute('lang', ${targetDocumentLang});
      state.appliedLang = ${JSON.stringify(lang)};
      return { ok: applied > 0, applied };
    })();
  `;
}

function buildRestoreTranslationScript() {
  return `
    (() => {
      const state = window.__ag_translate_state__;
      if (!state || !Array.isArray(state.entries) || !state.entries.length) {
        return { ok: false, reason: 'missing-state' };
      }

      let restored = 0;
      const withWhitespace = (entry, value) => \`\${entry.leading || ''}\${value}\${entry.trailing || ''}\`;

      state.entries.forEach((entry) => {
        const nextValue = withWhitespace(entry, entry.original || '');

        if (entry.type === 'text') {
          if (entry.node && entry.node.isConnected) {
            entry.node.nodeValue = nextValue;
            restored += 1;
          }
          return;
        }

        if (entry.type === 'attr') {
          if (entry.element && entry.element.isConnected) {
            entry.element.setAttribute(entry.attrName, nextValue);
            try {
              entry.element[entry.attrName] = nextValue;
            } catch {}
            restored += 1;
          }
          return;
        }

        if (entry.type === 'value') {
          if (entry.element && entry.element.isConnected) {
            entry.element.value = nextValue;
            entry.element.setAttribute('value', nextValue);
            restored += 1;
          }
          return;
        }

        if (entry.type === 'title') {
          document.title = entry.original || document.title;
          restored += 1;
        }
      });

      if (state.originalLang) {
        document.documentElement.setAttribute('lang', state.originalLang);
      } else {
        document.documentElement.removeAttribute('lang');
      }
      state.appliedLang = '';
      return { ok: restored > 0, restored };
    })();
  `;
}

function buildEnableReadModeScript() {
  return `
    (() => {
      const ROOT_ID = '__ag_reader_root__';
      const STYLE_ID = '__ag_reader_style__';
      const rootExists = document.getElementById(ROOT_ID);
      if (rootExists) {
        return { ok: true, alreadyOpen: true };
      }

      if (!document.body) {
        return { ok: false, reason: 'no-body' };
      }

      const blockedSelectors = 'script,style,noscript,iframe,canvas,svg,nav,aside,form,button,input,select,textarea,footer,[role="navigation"],[aria-hidden="true"],[hidden],[translate="no"],.notranslate,.skiptranslate';
      const contentHintRe = /(article|content|post|entry|story|main|body|text|read)/i;

      const getTextLength = (node) => (node?.innerText || node?.textContent || '').replace(/\\s+/g, ' ').trim().length;
      const getParagraphCount = (node) => node ? node.querySelectorAll('p').length : 0;
      const getLinkDensity = (node) => {
        const textLength = getTextLength(node);
        if (!textLength) return 1;
        const linkText = Array.from(node.querySelectorAll('a')).reduce((total, link) => total + getTextLength(link), 0);
        return linkText / textLength;
      };
      const isVisible = (node) => {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
        const style = window.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };

      const scoreNode = (node) => {
        if (!node || !isVisible(node) || node.matches(blockedSelectors)) return 0;
        const textLength = getTextLength(node);
        if (textLength < 180) return 0;

        const paragraphCount = getParagraphCount(node);
        const headingCount = node.querySelectorAll('h1, h2, h3, h4').length;
        const imageCount = node.querySelectorAll('img, video, figure').length;
        const listCount = node.querySelectorAll('ul, ol').length;
        const interactiveCount = node.querySelectorAll('nav,aside,form,button,input,select,textarea').length;
        const linkDensity = getLinkDensity(node);
        const hintText = [node.id, node.className].filter(Boolean).join(' ');
        const hintBoost = contentHintRe.test(hintText) ? 420 : 0;
        const tagBoost = node.matches('article') ? 900 : node.matches('main, [role="main"]') ? 700 : node.matches('section') ? 260 : 0;

        return textLength +
          (paragraphCount * 150) +
          (headingCount * 80) +
          (imageCount * 22) +
          (listCount * 30) +
          hintBoost +
          tagBoost -
          (interactiveCount * 75) -
          (linkDensity * 1350);
      };

      const candidateSet = new Set([
        document.querySelector('article'),
        document.querySelector('main'),
        document.querySelector('[role="main"]'),
        document.body
      ]);
      document.querySelectorAll('article, main, [role="main"], section, div').forEach((node) => {
        candidateSet.add(node);
      });

      let bestNode = null;
      let bestScore = 0;

      for (const node of candidateSet) {
        const score = scoreNode(node);
        if (score > bestScore) {
          bestScore = score;
          bestNode = node;
        }
      }

      if (!bestNode) {
        return { ok: false, reason: 'no-content' };
      }

      const clone = bestNode.cloneNode(true);
      clone.querySelectorAll(blockedSelectors).forEach((node) => node.remove());
      clone.querySelectorAll('*').forEach((node) => {
        for (const attr of Array.from(node.attributes)) {
          if (/^(src|href|alt|title|colspan|rowspan|target|rel|controls|poster)$/i.test(attr.name)) continue;
          node.removeAttribute(attr.name);
        }

        if (node.matches('a')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noreferrer noopener');
        }

        const textLength = getTextLength(node);
        if (node.matches('div, section, article') && textLength < 40 && !node.querySelector('img, video, pre, code, ul, ol, table, blockquote')) {
          node.remove();
          return;
        }

        if (getLinkDensity(node) > 0.55 && textLength < 1200 && !node.matches('a')) {
          node.remove();
        }
      });

      const articleTextLength = getTextLength(clone);
      if (articleTextLength < 350) {
        return { ok: false, reason: 'too-short' };
      }

      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = \`
        #\${ROOT_ID} {
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          overflow-y: auto;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0)),
            rgba(17, 24, 39, 0.94);
          color: #f8fafc;
          padding: 56px 24px 72px;
          box-sizing: border-box;
          font-family: Georgia, "Times New Roman", serif;
        }

        #\${ROOT_ID} * {
          box-sizing: border-box;
        }

        #\${ROOT_ID} .ag-reader-shell {
          width: min(900px, 100%);
          margin: 0 auto;
          background: rgba(15, 23, 42, 0.82);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 26px;
          padding: 40px min(7vw, 56px);
          box-shadow: 0 24px 80px rgba(0,0,0,0.45);
          backdrop-filter: blur(20px);
        }

        #\${ROOT_ID} .ag-reader-title {
          margin: 0;
          font-size: clamp(30px, 4vw, 50px);
          line-height: 1.06;
          letter-spacing: -0.04em;
          color: #fff;
        }

        #\${ROOT_ID} .ag-reader-meta {
          margin-top: 12px;
          margin-bottom: 28px;
          color: rgba(226,232,240,0.72);
          font: 600 12px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }

        #\${ROOT_ID} .ag-reader-content {
          font-size: clamp(18px, 2vw, 21px);
          line-height: 1.82;
          color: rgba(248,250,252,0.95);
        }

        #\${ROOT_ID} .ag-reader-content h1,
        #\${ROOT_ID} .ag-reader-content h2,
        #\${ROOT_ID} .ag-reader-content h3,
        #\${ROOT_ID} .ag-reader-content h4 {
          margin: 1.8em 0 0.7em;
          line-height: 1.18;
          color: #fff;
        }

        #\${ROOT_ID} .ag-reader-content p,
        #\${ROOT_ID} .ag-reader-content ul,
        #\${ROOT_ID} .ag-reader-content ol,
        #\${ROOT_ID} .ag-reader-content blockquote,
        #\${ROOT_ID} .ag-reader-content pre,
        #\${ROOT_ID} .ag-reader-content figure {
          margin: 0 0 1.1em;
        }

        #\${ROOT_ID} .ag-reader-content a {
          color: #93c5fd;
        }

        #\${ROOT_ID} .ag-reader-content img,
        #\${ROOT_ID} .ag-reader-content video {
          max-width: 100%;
          height: auto;
          display: block;
          margin: 1.4em auto;
          border-radius: 18px;
        }

        #\${ROOT_ID} .ag-reader-content blockquote {
          padding: 0.2em 0 0.2em 1em;
          border-left: 3px solid rgba(147,197,253,0.55);
          color: rgba(226,232,240,0.88);
        }

        #\${ROOT_ID} .ag-reader-content pre,
        #\${ROOT_ID} .ag-reader-content code {
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        }

        #\${ROOT_ID} .ag-reader-content pre {
          padding: 16px 18px;
          overflow-x: auto;
          border-radius: 16px;
          background: rgba(15,23,42,0.88);
        }

        @media (max-width: 720px) {
          #\${ROOT_ID} {
            padding: 18px 12px 32px;
          }

          #\${ROOT_ID} .ag-reader-shell {
            border-radius: 20px;
            padding: 24px 18px 28px;
          }

          #\${ROOT_ID} .ag-reader-content {
            font-size: 18px;
            line-height: 1.72;
          }
        }
      \`;

      const root = document.createElement('div');
      root.id = ROOT_ID;
      root.dataset.previousDocumentOverflow = document.documentElement.style.overflow || '';
      root.dataset.previousBodyOverflow = document.body.style.overflow || '';

      const titleNode = document.createElement('h1');
      titleNode.className = 'ag-reader-title';
      titleNode.textContent = (
        bestNode.querySelector('h1, h2')?.innerText ||
        document.querySelector('h1')?.innerText ||
        document.title ||
        location.hostname ||
        ''
      ).trim();

      const metaNode = document.createElement('div');
      metaNode.className = 'ag-reader-meta';
      metaNode.textContent = location.hostname;

      const contentNode = document.createElement('div');
      contentNode.className = 'ag-reader-content';
      contentNode.appendChild(clone);

      const shellNode = document.createElement('div');
      shellNode.className = 'ag-reader-shell';
      shellNode.appendChild(titleNode);
      shellNode.appendChild(metaNode);
      shellNode.appendChild(contentNode);
      root.appendChild(shellNode);

      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      document.documentElement.appendChild(style);
      document.documentElement.appendChild(root);

      return { ok: true };
    })();
  `;
}

function getDisableReadModeScript() {
  return `
    (() => {
      const root = document.getElementById('__ag_reader_root__');
      const style = document.getElementById('__ag_reader_style__');
      if (root) {
        document.documentElement.style.overflow = root.dataset.previousDocumentOverflow || '';
        if (document.body) {
          document.body.style.overflow = root.dataset.previousBodyOverflow || '';
        }
        root.remove();
      }
      if (style) style.remove();
      return { ok: true };
    })();
  `;
}

function getCurrentUiStrings() {
  return getUiStrings(store.settings?.lang || DEFAULT_LANG);
}

function getCurrentMenuStrings() {
  return getMenuStrings(store.settings?.lang || DEFAULT_LANG);
}

function formatLocalizedString(template, replacements = {}) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = replacements[key];
    return value == null ? '' : String(value);
  });
}

function getContextMenuSelectionText(text, maxLength = 48) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}\u2026`;
}

function joinMenuSections(sections) {
  const menu = [];
  sections
    .map((section) => section.filter((item, itemIndex) => {
      if (item.type !== 'separator') return true;
      if (itemIndex === 0 || itemIndex === section.length - 1) return false;
      return section[itemIndex - 1]?.type !== 'separator';
    }))
    .filter(section => section.length > 0)
    .forEach((section, index) => {
      if (index > 0) {
        menu.push({ type: 'separator' });
      }
      menu.push(...section);
    });
  return menu;
}

function buildContextMenuTemplate(webContents, params = {}, {
  includeNavigation = true,
  includeInspect = true,
  includeLinkActions = true,
  includeImageActions = true,
  includeSearch = true
} = {}) {
  const uiStrings = getCurrentUiStrings();
  const menuStrings = getCurrentMenuStrings();
  const editFlags = params.editFlags || {};
  const sections = [];

  if (params.isEditable && params.misspelledWord) {
    const spellcheckItems = [];
    if (Array.isArray(params.dictionarySuggestions) && params.dictionarySuggestions.length) {
      params.dictionarySuggestions.slice(0, 6).forEach((suggestion) => {
        spellcheckItems.push({
          label: suggestion,
          click: () => webContents.replaceMisspelling(suggestion)
        });
      });
    } else {
      spellcheckItems.push({
        label: uiStrings.contextMenuNoSuggestions,
        enabled: false
      });
    }

    if (typeof webContents.session?.addWordToSpellCheckerDictionary === 'function') {
      spellcheckItems.push({
        label: uiStrings.contextMenuAddToDictionary,
        click: () => webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      });
    }

    sections.push(spellcheckItems);
  }

  const editItems = [];
  if (params.isEditable) {
    if (editFlags.canUndo) editItems.push({ label: menuStrings.undo, click: () => webContents.undo() });
    if (editFlags.canRedo) editItems.push({ label: menuStrings.redo, click: () => webContents.redo() });
    if (editFlags.canUndo || editFlags.canRedo) editItems.push({ type: 'separator' });
    if (editFlags.canCut) editItems.push({ label: menuStrings.cut, click: () => webContents.cut() });
    if (editFlags.canCopy) editItems.push({ label: menuStrings.copy, click: () => webContents.copy() });
    if (editFlags.canPaste) editItems.push({ label: menuStrings.paste, click: () => webContents.paste() });
    if (editFlags.canSelectAll) editItems.push({ label: menuStrings.selectAll, click: () => webContents.selectAll() });
  } else {
    const hasSelection = !!String(params.selectionText || '').trim();
    if (hasSelection) {
      editItems.push({ label: menuStrings.copy, click: () => webContents.copy() });
    }
    if (editFlags.canSelectAll) {
      editItems.push({ label: menuStrings.selectAll, click: () => webContents.selectAll() });
    }
  }
  sections.push(editItems);

  const linkAndMediaItems = [];
  if (includeLinkActions && params.linkURL) {
    if (isNavigableBrowserUrl(params.linkURL)) {
      linkAndMediaItems.push({
        label: uiStrings.contextMenuOpenLinkInNewTab,
        click: () => {
          const tab = createTab(params.linkURL);
          setActiveTab(tab.id);
        }
      });
    }
    linkAndMediaItems.push({
      label: uiStrings.contextMenuCopyLink,
      click: () => clipboard.writeText(params.linkURL)
    });
  }

  if (includeImageActions && params.mediaType === 'image' && isSafeBrowserUrl(params.srcURL)) {
    linkAndMediaItems.push({
      label: uiStrings.contextMenuOpenImageInNewTab,
      click: () => {
        const tab = createTab(params.srcURL);
        setActiveTab(tab.id);
      }
    });
    linkAndMediaItems.push({
      label: uiStrings.contextMenuCopyImage,
      click: () => clipboard.writeText(params.srcURL)
    });
    linkAndMediaItems.push({
      label: uiStrings.contextMenuSaveImage,
      click: () => webContents.downloadURL(params.srcURL)
    });
  }
  sections.push(linkAndMediaItems);

  const selectionText = String(params.selectionText || '').trim();
  if (includeSearch && selectionText) {
    sections.push([{
      label: formatLocalizedString(uiStrings.contextMenuSearchWeb, {
        text: getContextMenuSelectionText(selectionText)
      }),
      click: () => {
        const tab = createTab(`${SEARCH_FALLBACK_PREFIX}${encodeURIComponent(selectionText)}`);
        setActiveTab(tab.id);
      }
    }]);
  }

  if (includeNavigation) {
    sections.push([
      {
        label: uiStrings.back,
        enabled: webContents.canGoBack(),
        click: () => webContents.goBack()
      },
      {
        label: uiStrings.forward,
        enabled: webContents.canGoForward(),
        click: () => webContents.goForward()
      },
      {
        label: uiStrings.reloadPage,
        click: () => webContents.reload()
      }
    ]);
  }

  if (includeInspect) {
    sections.push([{
      label: uiStrings.contextMenuInspectElement,
      click: () => webContents.inspectElement(params.x ?? 0, params.y ?? 0)
    }]);
  }

  return joinMenuSections(sections);
}

function showContextMenu(webContents, params, options) {
  if (!win) return;
  const template = buildContextMenuTemplate(webContents, params, options);
  if (!template.length) return;
  Menu.buildFromTemplate(template).popup({ window: win });
}

function getDisplayHostname(rawUrl) {
  const parsed = safeParseUrl(rawUrl);
  return parsed?.hostname ? parsed.hostname.replace(/^www\./i, '') : '';
}

function getFallbackSiteLabel(rawUrl) {
  const host = getDisplayHostname(rawUrl);
  if (!host) return String(rawUrl || '').trim();
  const [firstPart] = host.split('.');
  if (!firstPart) return host;
  return firstPart.charAt(0).toUpperCase() + firstPart.slice(1);
}

function getSiteInitials(label) {
  const parts = String(label || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (!parts.length) return 'AG';
  return parts.map(part => part[0]).join('').toUpperCase();
}

function isMeaningfulTabTitle(title, rawUrl) {
  const trimmed = String(title || '').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower === 'loading...' || lower === 'new tab') return false;
  return trimmed !== String(rawUrl || '').trim();
}

function sanitizeHistoryTitle(title, rawUrl, existingTitle = '') {
  if (isMeaningfulTabTitle(title, rawUrl)) {
    return decodeHtmlEntities(String(title || '').trim());
  }
  if (existingTitle) return existingTitle;
  return getFallbackSiteLabel(rawUrl);
}

function getHomepageFallbackFavicon(rawUrl) {
  const host = getDisplayHostname(rawUrl);
  return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64` : '';
}

function upsertHistoryEntry(entry = {}, { touch = true } = {}) {
  const normalizedUrl = getComparableBrowserUrl(entry.url);
  if (!normalizedUrl) return null;

  if (!Array.isArray(store.history)) {
    store.history = [];
  }

  const existingIndex = store.history.findIndex(item => item.url === normalizedUrl);
  const existing = existingIndex >= 0 ? store.history[existingIndex] : null;
  const timestamp = touch ? Date.now() : (existing?.lastVisited || Date.now());
  const nextEntry = {
    url: normalizedUrl,
    title: sanitizeHistoryTitle(entry.title, normalizedUrl, existing?.title || ''),
    favicon: isSafeBrowserUrl(entry.favicon) ? entry.favicon : (existing?.favicon || ''),
    lastVisited: timestamp
  };

  const changed = !existing ||
    existing.title !== nextEntry.title ||
    existing.favicon !== nextEntry.favicon ||
    existing.lastVisited !== nextEntry.lastVisited;

  if (!changed) {
    return existing;
  }

  if (existingIndex >= 0) {
    store.history.splice(existingIndex, 1, nextEntry);
  } else {
    store.history.push(nextEntry);
  }

  store.history.sort((left, right) => (right.lastVisited || 0) - (left.lastVisited || 0));
  store.history = store.history.slice(0, MAX_HISTORY_ITEMS);
  saveStore();
  return nextEntry;
}

function recordTabVisit(tab, { touch = true } = {}) {
  if (!tab) return null;
  const sourceUrl = tab.translationOriginalUrl || tab.url;
  return upsertHistoryEntry({
    url: sourceUrl,
    title: tab.title,
    favicon: tab.favicon
  }, { touch });
}

function buildHomepageSiteItem(rawUrl) {
  const normalizedUrl = getComparableBrowserUrl(rawUrl);
  if (!normalizedUrl) return null;

  const historyEntry = Array.isArray(store.history)
    ? store.history.find(item => item.url === normalizedUrl)
    : null;
  const host = getDisplayHostname(normalizedUrl);
  const title = historyEntry?.title || getFallbackSiteLabel(normalizedUrl);

  return {
    url: normalizedUrl,
    title,
    subtitle: host || normalizedUrl,
    favicon: historyEntry?.favicon || getHomepageFallbackFavicon(normalizedUrl),
    initials: getSiteInitials(title)
  };
}

function getHomepageSection() {
  const uiStrings = getCurrentUiStrings();
  const pinnedUrls = [...new Set((store.pinnedTabs || []).map(url => getComparableBrowserUrl(url)).filter(Boolean))];
  const pinnedItems = pinnedUrls
    .map(buildHomepageSiteItem)
    .filter(Boolean)
    .slice(0, HOMEPAGE_SECTION_ITEMS);

  if (pinnedItems.length > 0) {
    return {
      title: uiStrings.homePinnedSites || 'Pinned sites',
      items: pinnedItems
    };
  }

  const pinnedSet = new Set(pinnedUrls);
  const recentItems = (store.history || [])
    .filter(entry => entry?.url && !pinnedSet.has(entry.url))
    .map(entry => buildHomepageSiteItem(entry.url))
    .filter(Boolean)
    .slice(0, HOMEPAGE_SECTION_ITEMS);

  if (recentItems.length > 0) {
    return {
      title: uiStrings.homeRecentSites || 'Recent visits',
      items: recentItems
    };
  }

  return null;
}

function getBuiltinHomepageStrings() {
  const uiStrings = getCurrentUiStrings();
  return {
    pageTitle: uiStrings.homePageTitle || 'AG Home',
    brandLabel: uiStrings.homeBrandLabel || 'AG Browser',
    searchTitle: uiStrings.homeSearchTitle || 'AG Search',
    subtitle: uiStrings.homeSubtitle || 'Search the web without leaving the start page.',
    searchPlaceholder: uiStrings.homeSearchPlaceholder || 'Search the web or type a URL',
    searchButton: uiStrings.homeSearchButton || 'Search',
    searchHint: uiStrings.homeSearchHint || 'Press Enter to search, or type a URL to open it right away.',
    quickLinksTitle: uiStrings.homeQuickLinks || 'Quick links',
    resultsTitle: uiStrings.homeResultsTitle || 'Results',
    searchLoading: uiStrings.homeSearchLoading || 'Searching...',
    searchNoResults: uiStrings.homeSearchNoResults || 'Nothing was found.',
    searchError: uiStrings.homeSearchError || 'Inline search is unavailable right now.',
    searchFallbackAction: uiStrings.homeSearchFallbackAction || 'Open in AG Search'
  };
}

function buildBuiltinHomepageResponse() {
  const html = buildBuiltinHomepageHtml({
    theme: store.settings?.theme === 'light' ? 'light' : 'dark',
    lang: getLangConfig(store.settings?.lang || DEFAULT_LANG).htmlLang,
    strings: getBuiltinHomepageStrings(),
    searchBaseUrl: DEFAULT_CUSTOM_HOMEPAGE
  });

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function registerAppProtocols() {
  protocol.handle('ag', (request) => {
    const parsed = safeParseUrl(request.url);
    if (!parsed || parsed.hostname !== 'home') {
      return new Response('Not found', { status: 404 });
    }
    return buildBuiltinHomepageResponse();
  });
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

function withPermissionContext(webContents, details = {}, requestingOrigin = '') {
  const resolvedRequestingOrigin = requestingOrigin || getRequestOrigin(details);
  const resolvedEmbeddingOrigin = getOriginFromUrl(details.embeddingOrigin || webContents?.getURL?.());

  return {
    ...details,
    requestingOrigin: resolvedRequestingOrigin,
    ...(resolvedEmbeddingOrigin ? { embeddingOrigin: resolvedEmbeddingOrigin } : {})
  };
}

function getStorageAccessPermissionKey(permission, details = {}) {
  const baseKey = permission === 'top-level-storage-access'
    ? 'topLevelStorageAccess'
    : 'storageAccess';
  const embeddingOrigin = getOriginFromUrl(details.embeddingOrigin);
  const requestingOrigin = getRequestOrigin(details);

  // Storage Access API grants should stay scoped to the site where the
  // third-party content is embedded instead of silently carrying over.
  if (!embeddingOrigin || embeddingOrigin === requestingOrigin) {
    return baseKey;
  }

  return `${baseKey}::${embeddingOrigin}`;
}

function getCookiePermissionKey(details = {}) {
  const requestingOrigin = getRequestOrigin(details);
  const embeddingOrigin = getOriginFromUrl(details.embeddingOrigin);

  // Keep third-party cookie grants tied to the site where the request happens.
  if (!embeddingOrigin || embeddingOrigin === requestingOrigin) {
    return 'cookies';
  }

  return `cookies::${embeddingOrigin}`;
}

function getSiteDisplayName(origin) {
  const parsed = safeParseUrl(origin);
  return parsed?.hostname || origin || 'Unknown site';
}

function normalizePermissionRule(rule) {
  return VALID_PERMISSION_RULES.has(rule) ? rule : 'ask';
}

function normalizePermissionRules(rules = {}) {
  const normalized = { ...DEFAULT_PERMISSION_RULES };
  if (!rules || typeof rules !== 'object') {
    return normalized;
  }

  for (const key of Object.keys(DEFAULT_PERMISSION_RULES)) {
    normalized[key] = normalizePermissionRule(rules[key]);
  }

  return normalized;
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
  sessionPermissionDecisions.clear();
  saveStore();
}

function getPermissionDecisionCacheKey(permission, details = {}) {
  const origin = getRequestOrigin(details);
  const keys = getPermissionStorageKeys(permission, details);
  if (!origin || !keys.length) return '';
  return `${origin}::${keys.slice().sort().join('|')}`;
}

function getPermissionDecisionCacheKeys(permission, details = {}) {
  const origin = getRequestOrigin(details);
  const keys = getPermissionStorageKeys(permission, details);
  if (!origin || !keys.length) return [];
  return Array.from(new Set(keys)).map((key) => `${origin}::${key}`);
}

function getSessionPermissionResult(permission, details = {}) {
  const cacheKeys = getPermissionDecisionCacheKeys(permission, details);
  if (!cacheKeys.length) return null;

  let sawAllow = false;
  for (const cacheKey of cacheKeys) {
    if (!sessionPermissionDecisions.has(cacheKey)) return null;
    const decision = sessionPermissionDecisions.get(cacheKey);
    if (decision === false) return false;
    if (decision === true) sawAllow = true;
  }

  return sawAllow ? true : null;
}

function setSessionPermissionDecision(permission, details, allowed) {
  const cacheKeys = getPermissionDecisionCacheKeys(permission, details);
  if (!cacheKeys.length) return;
  cacheKeys.forEach((cacheKey) => {
    sessionPermissionDecisions.set(cacheKey, !!allowed);
  });
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
    case 'cookies':
      return [getCookiePermissionKey(details)];
    case 'canvas-read':
      return ['canvasRead'];
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
      return [getStorageAccessPermissionKey(permission, details)];
    case 'window-management':
      return ['windowManagement'];
    case 'keyboardLock':
      return ['keyboardLock'];
    default:
      return [];
  }
}

function getPermissionRuleKeys(permission, details = {}) {
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
      return ['fileSystem'];
    case 'cookies':
      return ['cookies'];
    case 'canvas-read':
      return ['canvasRead'];
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

function getConfiguredPermissionResult(permission, details = {}) {
  const rules = normalizePermissionRules(store.settings?.permissionRules);
  const keys = getPermissionRuleKeys(permission, details);
  if (!keys.length) return null;

  let sawAllow = false;
  for (const key of keys) {
    const rule = normalizePermissionRule(rules[key]);
    if (rule === 'deny') return false;
    if (rule === 'allow') {
      sawAllow = true;
      continue;
    }
    return null;
  }

  return sawAllow ? true : null;
}

function getExplicitPermissionDecision(permission, details = {}) {
  const autoDecision = getAutoPermissionDecision(permission, details);
  if (autoDecision !== null) {
    if (autoDecision && permission === 'media') {
      return canPotentiallyRequestMediaAccess(details);
    }
    return autoDecision;
  }

  const configuredDecision = getConfiguredPermissionResult(permission, details);
  if (configuredDecision !== null) {
    if (configuredDecision && permission === 'media') {
      return canPotentiallyRequestMediaAccess(details);
    }
    return configuredDecision;
  }

  const cachedDecision = getCachedPermissionResult(permission, details);
  if (cachedDecision !== null) {
    if (cachedDecision && permission === 'media') {
      return canPotentiallyRequestMediaAccess(details);
    }
    return cachedDecision;
  }

  return null;
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

function getCachedPermissionResult(permission, details = {}) {
  const sessionDecision = getSessionPermissionResult(permission, details);
  if (sessionDecision !== null) return sessionDecision;
  return getStoredPermissionResult(permission, details);
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
    case 'cookies':
      return 'permissionLabelCookies';
    case 'canvas-read':
      return 'permissionLabelCanvasData';
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

  if (permission === 'cookies') {
    const embeddingOrigin = getOriginFromUrl(details.embeddingOrigin);
    const requestingOrigin = getRequestOrigin(details);
    const parts = [];

    if (embeddingOrigin && requestingOrigin && embeddingOrigin !== requestingOrigin) {
      parts.push(formatString(strings.permissionThirdPartyCookiesNote, {
        site: getSiteDisplayName(embeddingOrigin)
      }));
    } else {
      parts.push(strings.permissionCookiesNote);
    }

    if (details.source && strings.permissionPromptSource) {
      parts.push(formatString(strings.permissionPromptSource, { source: details.source }));
    }

    return parts.filter(Boolean).join(' ');
  }

  if (permission === 'canvas-read') {
    const parts = [strings.permissionCanvasReadNote];
    if (details.source && strings.permissionPromptSource) {
      parts.push(formatString(strings.permissionPromptSource, { source: details.source }));
    }
    return parts.filter(Boolean).join(' ');
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

function buildPermissionNoticePayload(message) {
  const strings = getCurrentUiStrings();

  return {
    kind: 'notice',
    title: strings.sitePermissions || 'Site permissions',
    site: '',
    origin: '',
    originLabel: '',
    message,
    note: '',
    allowLabel: strings.permissionOk || 'OK',
    denyLabel: '',
    alwaysAllowLabel: '',
    canRemember: false
  };
}

async function showPermissionWarning(message) {
  if (!message || !win || win.isDestroyed()) return;
  await promptInUi(buildPermissionNoticePayload(message));
}

function queueSynchronousPermissionPrompt(webContents, permission, details = {}) {
  const cacheKey = getPermissionDecisionCacheKey(permission, details)
    || `${permission}::${getRequestOrigin(details)}::${details.source || ''}`;
  if (!cacheKey || pendingSynchronousPermissionPrompts.has(cacheKey)) {
    return;
  }

  pendingSynchronousPermissionPrompts.add(cacheKey);
  void promptInUi(buildPermissionPromptPayload(permission, details))
    .then((response) => {
      const allowed = response?.action === 'allow' || response?.action === 'allow-always';

      if (allowed) {
        setSessionPermissionDecision(permission, details, true);
      } else {
        setSessionPermissionDecision(permission, details, false);
      }

      if (response?.remember && allowed) {
        persistPermissionDecision(permission, details, true);
      } else if (response?.remember && !allowed) {
        persistPermissionDecision(permission, details, false);
      }
    })
    .finally(() => {
      pendingSynchronousPermissionPrompts.delete(cacheKey);
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
    case 'cookies':
    case 'canvas-read':
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
      const systemAllowed = await ensureMediaSystemAccess(details);
      setSessionPermissionDecision(permission, details, systemAllowed);
      return systemAllowed;
    }
    setSessionPermissionDecision(permission, details, autoDecision);
    return autoDecision;
  }

  const configuredDecision = getConfiguredPermissionResult(permission, details);
  if (configuredDecision !== null) {
    if (configuredDecision && permission === 'media') {
      const systemAllowed = await ensureMediaSystemAccess(details);
      setSessionPermissionDecision(permission, details, systemAllowed);
      return systemAllowed;
    }
    setSessionPermissionDecision(permission, details, configuredDecision);
    return configuredDecision;
  }

  const storedDecision = getCachedPermissionResult(permission, details);
  if (storedDecision !== null) {
    if (storedDecision && permission === 'media') {
      const systemAllowed = await ensureMediaSystemAccess(details);
      setSessionPermissionDecision(permission, details, systemAllowed);
      return systemAllowed;
    }
    setSessionPermissionDecision(permission, details, storedDecision);
    return storedDecision;
  }
  if (!PROMPTED_PERMISSIONS.has(permission) || !canPromptPermission(permission, details)) return false;

  const response = await promptInUi(buildPermissionPromptPayload(permission, details));
  const allowed = response?.action === 'allow' || response?.action === 'allow-always';

  setSessionPermissionDecision(permission, details, allowed);

  if (allowed && permission === 'media') {
    const systemAllowed = await ensureMediaSystemAccess(details);
    setSessionPermissionDecision(permission, details, systemAllowed);
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
  if (!canPromptPermission(permission, details)) return false;

  const explicitDecision = getExplicitPermissionDecision(permission, details);
  if (explicitDecision !== null) {
    return explicitDecision;
  }

  if (REQUESTABLE_PERMISSION_CHECKS.has(permission)) {
    return true;
  }

  // For the remaining permissions we only return true once the user or
  // settings explicitly allow the request; otherwise Chromium treats the
  // check result as a final deny and no prompt is shown.
  return false;
}

function getPermissionState(permission, details = {}) {
  if (!canPromptPermission(permission, details)) return 'denied';

  const explicitDecision = getExplicitPermissionDecision(permission, details);
  if (explicitDecision === true) return 'granted';
  if (explicitDecision === false) return 'denied';

  return PROMPTED_PERMISSIONS.has(permission) || REQUESTABLE_PERMISSION_CHECKS.has(permission)
    ? 'prompt'
    : 'denied';
}

function requestSynchronousPermissionFromUser(webContents, permission, details = {}) {
  const requestDetails = withPermissionContext(webContents, details);
  const autoDecision = getAutoPermissionDecision(permission, requestDetails);
  if (autoDecision !== null) {
    return autoDecision;
  }

  const configuredDecision = getConfiguredPermissionResult(permission, requestDetails);
  if (configuredDecision !== null) {
    return configuredDecision;
  }

  const cachedDecision = getCachedPermissionResult(permission, requestDetails);
  if (cachedDecision !== null) {
    return cachedDecision;
  }

  if (!PROMPTED_PERMISSIONS.has(permission) || !canPromptPermission(permission, requestDetails)) {
    return false;
  }

  queueSynchronousPermissionPrompt(webContents, permission, requestDetails);
  return false;
}

function findHeaderName(headers, expectedName) {
  return Object.keys(headers || {}).find((name) => String(name).toLowerCase() === expectedName.toLowerCase()) || '';
}

function getRequestWebContents(details = {}) {
  if (!Number.isInteger(details.webContentsId)) return null;
  try {
    return electronWebContents.fromId(details.webContentsId);
  } catch {
    return null;
  }
}

function isProtectedBrowserTraffic(details = {}, webContents) {
  if (!isSafeBrowserUrl(details.url)) return false;
  if (details.resourceType === 'mainFrame') return true;
  if (isSafeBrowserUrl(webContents?.getURL?.())) return true;
  return isSafeBrowserUrl(details.referrer);
}

function buildCookieTrafficPermissionDetails(details = {}, webContents, source) {
  const requestOrigin = getOriginFromUrl(details.url);
  const embeddingOrigin = details.resourceType === 'mainFrame'
    ? requestOrigin
    : getOriginFromUrl(webContents?.getURL?.() || details.referrer);

  return withPermissionContext(webContents, {
    requestingUrl: details.url,
    requestingOrigin: requestOrigin,
    securityOrigin: requestOrigin,
    embeddingOrigin,
    source
  });
}

function applyRequestPrivacyGuards(details = {}, callback) {
  const requestHeaders = { ...(details.requestHeaders || {}) };
  requestHeaders.DNT = '1';
  requestHeaders['Sec-GPC'] = '1';

  const xClientDataHeader = findHeaderName(requestHeaders, 'X-Client-Data');
  if (xClientDataHeader) {
    delete requestHeaders[xClientDataHeader];
  }

  const webContents = getRequestWebContents(details);
  const cookieHeader = findHeaderName(requestHeaders, 'Cookie');
  if (cookieHeader && isProtectedBrowserTraffic(details, webContents)) {
    const allowed = requestSynchronousPermissionFromUser(
      webContents,
      'cookies',
      buildCookieTrafficPermissionDetails(details, webContents, 'Cookie request header')
    );

    if (!allowed) {
      delete requestHeaders[cookieHeader];
    }
  }

  callback({ requestHeaders });
}

function applyResponsePrivacyGuards(details = {}, callback) {
  const responseHeaders = { ...(details.responseHeaders || {}) };
  const setCookieHeader = findHeaderName(responseHeaders, 'Set-Cookie');
  const webContents = getRequestWebContents(details);

  if (setCookieHeader && isProtectedBrowserTraffic(details, webContents)) {
    const allowed = requestSynchronousPermissionFromUser(
      webContents,
      'cookies',
      buildCookieTrafficPermissionDetails(details, webContents, 'Set-Cookie response header')
    );

    if (!allowed) {
      delete responseHeaders[setCookieHeader];
    }
  }

  callback({ responseHeaders });
}

async function handleDisplayMediaRequest(request, callback) {
  const origin = getOriginFromUrl(request.securityOrigin);
  const strings = getCurrentUiStrings();
  const requestDetails = withPermissionContext(null, {
    securityOrigin: request.securityOrigin,
    requestingOrigin: origin
  });

  if (!origin || !isTrustworthyPermissionOrigin(origin) || request.userGesture === false) {
    if (request.userGesture === false) {
      await showPermissionWarning(strings.permissionRequiresGesture);
    }
    callback({});
    return;
  }

  const configuredDecision = getConfiguredPermissionResult('display-capture', requestDetails);
  if (configuredDecision === false) {
    callback({});
    return;
  }

  if (configuredDecision === null && getStoredPermissionDecision(origin, 'displayCapture') === 'deny') {
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
  if (configuredSessions.has(sess)) return;
  configuredSessions.add(sess);

  sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestDetails = withPermissionContext(webContents, details);
    void requestPermissionFromUser(permission, requestDetails)
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
      const requestDetails = withPermissionContext(_webContents, details, requestingOrigin);
      return getPermissionCheckDecision(permission, requestDetails);
    });
  }

  if (sess.webRequest) {
    const filter = { urls: ['http://*/*', 'https://*/*'] };
    sess.webRequest.onBeforeSendHeaders(filter, applyRequestPrivacyGuards);
    sess.webRequest.onHeadersReceived(filter, applyResponsePrivacyGuards);
  }
}

function configureWebContentsPrivacy(webContents) {
  if (!webContents || typeof webContents.setWebRTCIPHandlingPolicy !== 'function') return;

  try {
    webContents.setWebRTCIPHandlingPolicy(WEBRTC_IP_HANDLING_POLICY);
  } catch (error) {
    console.warn(`Failed to set WebRTC IP handling policy: ${error.message}`);
  }
}

function loadSafeUrl(webContents, rawUrl, options) {
  const targetUrl = resolveBrowserUrl(rawUrl, options);
  return webContents.loadURL(targetUrl).catch((error) => {
    console.warn(`Failed to load ${targetUrl}: ${error.message}`);
    return false;
  });
}

function clearTabTranslationState(tab) {
  if (!tab) return;
  tab.translationOriginalUrl = '';
  tab.translatedTo = '';
  tab.translationMode = '';
}

function syncDerivedTabState(tab) {
  const translationState = getTranslationStateFromUrl(tab.url);
  if (translationState) {
    tab.translationOriginalUrl = translationState.originalUrl;
    tab.translatedTo = translationState.targetLang;
    tab.translationMode = 'proxy';
    return;
  }

  if (tab.translationMode === 'in-page' && isSameComparableBrowserUrl(tab.url, tab.translationOriginalUrl)) {
    return;
  }

  clearTabTranslationState(tab);
}

function canUseReadMode(tab) {
  return !!tab && isSafeBrowserUrl(tab.url);
}

async function applyReadModeToTab(tab, { persist = false } = {}) {
  if (!canUseReadMode(tab)) {
    if (persist && tab) {
      tab.readModeEnabled = false;
      emitTabUpdate(tab);
    }
    return { success: false, messageKey: 'readModeUnavailable' };
  }

  try {
    const result = await tab.view.webContents.executeJavaScript(buildEnableReadModeScript(), true);
    if (!result?.ok) {
      if (persist) {
        tab.readModeEnabled = false;
        emitTabUpdate(tab);
      }
      return { success: false, messageKey: 'readModeUnavailable' };
    }

    if (persist) {
      tab.readModeEnabled = true;
      emitTabUpdate(tab);
    }
    return { success: true };
  } catch (error) {
    if (persist) {
      tab.readModeEnabled = false;
      emitTabUpdate(tab);
    }
    console.warn('Failed to enable read mode:', error.message);
    return { success: false, messageKey: 'readModeUnavailable' };
  }
}

async function disableReadModeForTab(tab, { persist = false } = {}) {
  if (!tab) return { success: false, messageKey: 'readModeUnavailable' };

  try {
    await tab.view.webContents.executeJavaScript(getDisableReadModeScript(), true);
  } catch {
    // Ignore cleanup failures during navigation or teardown.
  }

  if (persist) {
    tab.readModeEnabled = false;
    emitTabUpdate(tab);
  }

  return { success: true };
}

async function reapplyReadModeIfNeeded(tab) {
  if (!tab?.readModeEnabled || tab.readModeSuspended) return;
  if (!tab.view?.webContents || tab.view.webContents.isDestroyed()) return;

  const result = await applyReadModeToTab(tab, { persist: false });
  if (!result.success && tab.readModeEnabled) {
    tab.readModeEnabled = false;
    emitTabUpdate(tab);
  }
}

async function withReadModeSuspended(tab, task) {
  const shouldRestoreReadMode = !!tab?.readModeEnabled;
  if (!shouldRestoreReadMode) {
    return task();
  }

  tab.readModeSuspended = true;
  await disableReadModeForTab(tab, { persist: false });

  try {
    return await task();
  } finally {
    tab.readModeSuspended = false;
    await reapplyReadModeIfNeeded(tab);
  }
}

async function toggleReadModeForTab(tab) {
  if (!tab) return { success: false, messageKey: 'readModeUnavailable' };
  if (tab.readModeEnabled) {
    return disableReadModeForTab(tab, { persist: true });
  }
  return applyReadModeToTab(tab, { persist: true });
}

async function translateTab(tab, lang) {
  if (!tab) return { success: false, messageKey: 'translateUnavailable' };

  const targetLang = normalizeLang(lang);
  const originalUrl = resolveBrowserUrl(tab.translationOriginalUrl || tab.url, {
    fallbackUrl: '',
    allowSearchFallback: false
  });
  if (!isSafeBrowserUrl(originalUrl)) {
    return { success: false, messageKey: 'translateUnavailable' };
  }

  try {
    return await withReadModeSuspended(tab, async () => {
      if (getTranslationStateFromUrl(tab.url)) {
        const loadedOriginal = await loadSafeUrl(tab.view.webContents, originalUrl, {
          fallbackUrl: getHomepage(),
          allowSearchFallback: false
        });
        if (loadedOriginal === false) {
          return { success: false, messageKey: 'translateUnavailable' };
        }
        clearTabTranslationState(tab);
      }

      const prepared = await tab.view.webContents.executeJavaScript(buildPrepareTranslationScript(), true);
      if (!prepared?.ok || !Array.isArray(prepared.texts) || !prepared.texts.length) {
        return { success: false, messageKey: 'translateUnavailable' };
      }

      const translatedTexts = await translateTextsWithGoogle(prepared.texts, targetLang);
      const applied = await tab.view.webContents.executeJavaScript(
        buildApplyTranslationScript(translatedTexts, targetLang),
        true
      );
      if (!applied?.ok) {
        return { success: false, messageKey: 'translateUnavailable' };
      }

      tab.translationOriginalUrl = originalUrl;
      tab.translatedTo = targetLang;
      tab.translationMode = 'in-page';
      emitTabUpdate(tab);
      return { success: true, targetLang };
    });
  } catch (error) {
    console.warn('Failed to translate page:', error.message);
    return { success: false, messageKey: 'translateUnavailable' };
  }
}

async function restoreOriginalTab(tab) {
  if (!tab || !tab.translationOriginalUrl) {
    return { success: false, messageKey: 'translateUnavailable' };
  }

  const originalUrl = tab.translationOriginalUrl;

  try {
    return await withReadModeSuspended(tab, async () => {
      if (tab.translationMode === 'in-page') {
        const restored = await tab.view.webContents.executeJavaScript(buildRestoreTranslationScript(), true)
          .catch(() => null);
        if (restored?.ok) {
          clearTabTranslationState(tab);
          emitTabUpdate(tab);
          return { success: true };
        }
      }

      const loaded = await loadSafeUrl(tab.view.webContents, originalUrl, {
        fallbackUrl: getHomepage(),
        allowSearchFallback: false
      });
      if (loaded === false) {
        return { success: false, messageKey: 'translateUnavailable' };
      }

      clearTabTranslationState(tab);
      emitTabUpdate(tab);
      return { success: true };
    });
  } catch (error) {
    console.warn('Failed to restore original page:', error.message);
    return { success: false, messageKey: 'translateUnavailable' };
  }
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
    a.loading === b.loading &&
    a.readModeEnabled === b.readModeEnabled &&
    a.translatedTo === b.translatedTo &&
    a.translationOriginalUrl === b.translationOriginalUrl;
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
  store.settings.lang = normalizeLang(store.settings.lang || getSystemPreferredLanguage() || DEFAULT_LANG);
  store.settings.translateTargetLang = normalizeLang(store.settings.translateTargetLang || store.settings.lang || DEFAULT_LANG);
  store.settings.permissionRules = normalizePermissionRules(store.settings.permissionRules);
  if (!store.settings.homepage) store.settings.homepage = DEFAULT_CUSTOM_HOMEPAGE;
  const normalizedHomepage = resolveBrowserUrl(store.settings.homepage, {
    fallbackUrl: DEFAULT_CUSTOM_HOMEPAGE,
    allowSearchFallback: false
  });
  store.settings.homepage = normalizedHomepage;
  if (!store.settings.homepageMode) {
    store.settings.homepageMode = normalizedHomepage === DEFAULT_CUSTOM_HOMEPAGE
      ? HOMEPAGE_MODE_BUILTIN
      : HOMEPAGE_MODE_CUSTOM;
  } else {
    store.settings.homepageMode = normalizeHomepageMode(store.settings.homepageMode);
  }
  if (!store.extensions) store.extensions = {};
  if (!store.pinnedTabs) store.pinnedTabs = [];
  store.pinnedTabs = store.pinnedTabs
    .map(url => getComparableBrowserUrl(url))
    .filter(Boolean);
  if (!Array.isArray(store.history)) {
    store.history = [];
  }
  store.history = store.history
    .map((entry) => {
      const normalizedUrl = getComparableBrowserUrl(entry?.url);
      if (!normalizedUrl) return null;
      return {
        url: normalizedUrl,
        title: sanitizeHistoryTitle(entry?.title, normalizedUrl),
        favicon: isSafeBrowserUrl(entry?.favicon) ? entry.favicon : '',
        lastVisited: Number.isFinite(entry?.lastVisited) ? entry.lastVisited : 0
      };
    })
    .filter(Boolean)
    .sort((left, right) => (right.lastVisited || 0) - (left.lastVisited || 0))
    .slice(0, MAX_HISTORY_ITEMS);
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
  store.pinnedTabs = [...new Set(
    tabs
      .filter(t => t.pinned)
      .map(t => getComparableBrowserUrl(t.translationOriginalUrl || t.url))
      .filter(Boolean)
  )];
  saveStore();
  refreshBuiltinHomepageTabs();
}

function getHomepage() {
  if (normalizeHomepageMode(store.settings.homepageMode) === HOMEPAGE_MODE_BUILTIN) {
    return BUILTIN_HOMEPAGE_URL;
  }
  return resolveBrowserUrl(store.settings.homepage || DEFAULT_CUSTOM_HOMEPAGE, {
    fallbackUrl: DEFAULT_CUSTOM_HOMEPAGE,
    allowSearchFallback: false
  });
}

function refreshBuiltinHomepageTabs() {
  tabs
    .filter(tab => isInternalBrowserUrl(tab.url))
    .forEach((tab) => {
      tab.view.webContents.reloadIgnoringCache();
    });
}

function getSystemPreferredLanguage() {
  const candidates = [];
  try {
    candidates.push(...app.getPreferredSystemLanguages());
  } catch {
    // Ignore unsupported Electron/OS combinations.
  }

  try {
    candidates.push(app.getLocale());
  } catch {
    // Ignore locale read failures and fall back to DEFAULT_LANG.
  }

  return normalizeLang(candidates);
}

function configureSpellCheckerLanguages(sess, lang = store.settings?.lang) {
  if (!sess || typeof sess.setSpellCheckerLanguages !== 'function') return;

  const available = Array.isArray(sess.availableSpellCheckerLanguages)
    ? sess.availableSpellCheckerLanguages
    : [];
  if (!available.length) return;

  const normalizedLang = normalizeLang(lang || DEFAULT_LANG);
  const langConfig = getLangConfig(normalizedLang);
  const candidates = [
    normalizedLang,
    langConfig.htmlLang,
    String(langConfig.htmlLang || '').split('-')[0]
  ]
    .filter(Boolean)
    .map(value => String(value).replace(/_/g, '-').toLowerCase());

  const exactMatch = available.find((value) => candidates.includes(String(value).toLowerCase()));
  const prefixMatch = available.find((value) => {
    const lower = String(value).toLowerCase();
    return candidates.some(candidate => lower.startsWith(`${candidate}-`));
  });
  const fallbackMatch = available.find((value) => {
    const lower = String(value).toLowerCase();
    return candidates.some(candidate => lower.split('-')[0] === candidate.split('-')[0]);
  });

  const selected = exactMatch || prefixMatch || fallbackMatch;
  if (!selected) return;

  try {
    sess.setSpellCheckerLanguages([selected]);
  } catch (error) {
    console.warn(`Failed to set spellchecker language ${selected}:`, error.message);
  }
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
  const sessionPreloads = typeof sess.getPreloads === 'function' ? sess.getPreloads() : [];
  sess.setUserAgent(customUA);
  if (typeof sess.setPreloads === 'function') {
    sess.setPreloads(Array.from(new Set([...sessionPreloads, BROWSER_PRELOAD_FILE])));
  }
  configureSessionSecurity(sess);
  configureWebContentsPrivacy(win.webContents);
  configureSpellCheckerLanguages(sess);

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

  win.webContents.on('context-menu', (_event, params) => {
    showContextMenu(win.webContents, params, {
      includeNavigation: false,
      includeInspect: false,
      includeLinkActions: false,
      includeImageActions: false,
      includeSearch: !!String(params.selectionText || '').trim()
    });
  });

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
  configureWebContentsPrivacy(view.webContents);

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (!isNavigableBrowserUrl(url)) {
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
    if (!isNavigableBrowserUrl(url)) {
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

  view.webContents.on('context-menu', (_event, params) => {
    showContextMenu(view.webContents, params, {
      includeNavigation: true,
      includeInspect: true,
      includeLinkActions: true,
      includeImageActions: true,
      includeSearch: !!String(params.selectionText || '').trim()
    });
  });

  const id = nextId++;
  const tab = {
    id, view, url: initialUrl,
    title: 'Loading...',
    canGoBack: false,
    canGoForward: false,
    pinned,
    favicon: null,
    loading: true,
    readModeEnabled: false,
    readModeSuspended: false,
    translatedTo: '',
    translationOriginalUrl: '',
    translationMode: ''
  };
  syncDerivedTabState(tab);
  tabs.push(tab);

  const updateState = () => {
    tab.url = view.webContents.getURL();
    tab.title = view.webContents.getTitle() || tab.url || 'New Tab';
    tab.canGoBack = view.webContents.canGoBack();
    tab.canGoForward = view.webContents.canGoForward();
    syncDerivedTabState(tab);
    try {
      const faviconSourceUrl = tab.translationOriginalUrl || tab.url;
      tab.favicon = isSafeBrowserUrl(faviconSourceUrl)
        ? safeParseUrl(faviconSourceUrl).origin + '/favicon.ico'
        : null;
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

  view.webContents.on('page-title-updated', () => {
    updateState();
    recordTabVisit(tab, { touch: false });
  });
  view.webContents.on('did-navigate', () => {
    updateState();
    recordTabVisit(tab, { touch: true });
  });
  view.webContents.on('did-navigate-in-page', () => {
    updateState();
    recordTabVisit(tab, { touch: true });
  });
  view.webContents.on('did-finish-load', () => {
    updateState();
    recordTabVisit(tab, { touch: false });
    if (tab.translatedTo && tab.translationMode === 'in-page' && isSameComparableBrowserUrl(tab.url, tab.translationOriginalUrl)) {
      void translateTab(tab, tab.translatedTo).then((result) => {
        if (!result.success && tab.translatedTo) {
          clearTabTranslationState(tab);
          emitTabUpdate(tab);
          void reapplyReadModeIfNeeded(tab);
        }
      }).catch((error) => {
        console.warn('Failed to restore translated page after load:', error.message);
        if (tab.translatedTo) {
          clearTabTranslationState(tab);
          emitTabUpdate(tab);
        }
        void reapplyReadModeIfNeeded(tab);
      });
      return;
    }

    void reapplyReadModeIfNeeded(tab);
  });
  view.webContents.on('page-favicon-updated', (event, favicons) => {
    if (favicons?.length > 0) {
      tab.favicon = favicons[0];
      recordTabVisit(tab, { touch: false });
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
    pinned: t.pinned, favicon: t.favicon, loading: t.loading,
    readModeEnabled: !!t.readModeEnabled,
    translatedTo: t.translatedTo || '',
    translationOriginalUrl: t.translationOriginalUrl || ''
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
ipcMain.handle('page:toggleReadMode', async () => {
  return toggleReadModeForTab(getActiveTab());
});
ipcMain.handle('page:translate', async (_e, lang) => {
  return translateTab(getActiveTab(), normalizeLang(lang || store.settings.translateTargetLang || store.settings.lang || DEFAULT_LANG));
});
ipcMain.handle('page:restoreOriginal', async () => {
  return restoreOriginalTab(getActiveTab());
});

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
  configureWebContentsPrivacy(popupWin.webContents);
  popupWin.loadFile(path.join(ext.path, popup));
  return true;
});

// Permissions UI
ipcMain.handle('permission:respond', (_e, response = {}) => {
  return resolvePendingPermissionPrompt(response.id, response);
});
ipcMain.handle('permission:request', async (event, payload = {}) => {
  const permission = String(payload.permission || '');
  const details = payload.details && typeof payload.details === 'object' ? payload.details : {};
  const requestDetails = withPermissionContext(event.sender, details);
  return requestPermissionFromUser(permission, requestDetails);
});
ipcMain.on('permission:sync-request', (event, payload = {}) => {
  const permission = String(payload.permission || '');
  const details = payload.details && typeof payload.details === 'object' ? payload.details : {};
  event.returnValue = requestSynchronousPermissionFromUser(event.sender, permission, details);
});
ipcMain.on('permission:sync-check', (event, payload = {}) => {
  const permission = String(payload.permission || '');
  const details = payload.details && typeof payload.details === 'object' ? payload.details : {};
  const requestDetails = withPermissionContext(event.sender, details);
  event.returnValue = getExplicitPermissionDecision(permission, requestDetails);
});
ipcMain.on('permission:sync-state', (event, payload = {}) => {
  const permission = String(payload.permission || '');
  const details = payload.details && typeof payload.details === 'object' ? payload.details : {};
  const requestDetails = withPermissionContext(event.sender, details);
  event.returnValue = getPermissionState(permission, requestDetails);
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
  if (Object.prototype.hasOwnProperty.call(newSettings, 'translateTargetLang')) {
    newSettings.translateTargetLang = normalizeLang(newSettings.translateTargetLang);
  }
  if (Object.prototype.hasOwnProperty.call(newSettings, 'permissionRules')) {
    const mergedPermissionRules = {
      ...normalizePermissionRules(store.settings.permissionRules),
      ...(newSettings.permissionRules && typeof newSettings.permissionRules === 'object'
        ? newSettings.permissionRules
        : {})
    };
    newSettings.permissionRules = normalizePermissionRules(mergedPermissionRules);
  }
  if (Object.prototype.hasOwnProperty.call(newSettings, 'homepageMode')) {
    newSettings.homepageMode = normalizeHomepageMode(newSettings.homepageMode);
  }
  if (Object.prototype.hasOwnProperty.call(newSettings, 'homepage')) {
    newSettings.homepage = resolveBrowserUrl(newSettings.homepage, {
      fallbackUrl: DEFAULT_CUSTOM_HOMEPAGE,
      allowSearchFallback: false
    });
  }
  Object.assign(store.settings, newSettings);
  saveStore();
  buildAppMenu();
  if (win) {
    configureSpellCheckerLanguages(win.webContents.session);
  }
  refreshBuiltinHomepageTabs();
  return store.settings;
});

/* ---------- App lifecycle ---------- */
app.setName('AG Browser');
if (process.platform === 'win32') app.setAppUserModelId('com.kickedstorm.agbrowser');

app.whenReady().then(() => {
  registerAppProtocols();
  return createWindow();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
