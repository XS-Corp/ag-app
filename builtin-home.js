/**
 * (c) 2026 KickedStorm (kickedstorm.com)
 * Project: AG Browser
 * License: GNU AGPLv3
 * Unauthorized copying of this file is strictly prohibited.
 */
const BUILTIN_HOMEPAGE_URL = 'ag://home/';
const DEFAULT_CUSTOM_HOMEPAGE = 'https://search.kickedstorm.com/';
const HOMEPAGE_MODE_BUILTIN = 'builtin';
const HOMEPAGE_MODE_CUSTOM = 'custom';

function safeParseUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || '').trim());
  } catch {
    return null;
  }
}

function isBuiltinHomepageUrl(rawUrl) {
  const parsed = safeParseUrl(rawUrl);
  return !!parsed && parsed.protocol === 'ag:' && parsed.hostname === 'home';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildBuiltinHomepageHtml({
  theme = 'dark',
  lang = 'en',
  strings = {},
  quickLinks = [],
  section = null,
  searchBaseUrl = DEFAULT_CUSTOM_HOMEPAGE
} = {}) {
  void quickLinks;
  void section;

  const searchHintMarkup = strings.searchHint
    ? `<p class="search-panel__hint">${escapeHtml(strings.searchHint)}</p>`
    : '';

  const payload = JSON.stringify({
    searchBaseUrl,
    searchApiKey: 'AIzaSyCkc0By2042HCEwIHAOlOQBkbKXHvc7dhk',
    searchEngineId: 'c50de946528d04497',
    labels: {
      resultsTitle: strings.resultsTitle || 'Results',
      searchLoading: strings.searchLoading || 'Searching...',
      searchNoResults: strings.searchNoResults || 'Nothing was found.',
      searchError: strings.searchError || 'Inline search is unavailable right now.',
      searchFallbackAction: strings.searchFallbackAction || 'Open in AG Search'
    }
  }).replace(/</g, '\\u003c');

  const isLight = theme === 'light';

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(strings.pageTitle || 'AG Home')}</title>
  <style>
    :root {
      color-scheme: ${isLight ? 'light' : 'dark'};
      --page-bg: ${isLight ? '#ece8df' : '#121212'};
      --page-bg-alt: ${isLight ? '#f7f4ed' : '#1b1b1b'};
      --shell-bg: ${isLight ? 'rgba(251, 248, 242, 0.94)' : 'rgba(28, 28, 28, 0.94)'};
      --input-bg: ${isLight ? '#fffdf8' : '#181818'};
      --results-bg: ${isLight ? 'rgba(255, 255, 255, 0.72)' : 'rgba(19, 19, 19, 0.66)'};
      --result-card-bg: ${isLight ? 'rgba(255, 255, 255, 0.92)' : 'rgba(31, 31, 31, 0.92)'};
      --border: ${isLight ? '#d8cebe' : '#313131'};
      --border-strong: ${isLight ? '#b9ac99' : '#494949'};
      --text: ${isLight ? '#191714' : '#f5f1e8'};
      --text-muted: ${isLight ? '#655d52' : '#b0a79a'};
      --text-soft: ${isLight ? '#837867' : '#8c8378'};
      --link: ${isLight ? '#285cb8' : '#90baff'};
      --accent: ${isLight ? '#35584d' : '#9bc0b2'};
      --button-bg: ${isLight ? '#191714' : '#f5f1e8'};
      --button-text: ${isLight ? '#fbf8f2' : '#161311'};
      --badge-bg: ${isLight ? '#efe6d8' : '#25211d'};
      --badge-text: ${isLight ? '#5f5342' : '#d6cab7'};
      --shadow: ${isLight ? '0 1px 0 rgba(25, 23, 20, 0.03), 0 22px 48px rgba(25, 23, 20, 0.08)' : '0 1px 0 rgba(255, 255, 255, 0.02), 0 24px 56px rgba(0, 0, 0, 0.28)'};
      --focus-ring: ${isLight ? 'rgba(53, 88, 77, 0.18)' : 'rgba(155, 192, 178, 0.22)'};
      --font-sans: "Inter", "Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      --font-display: "Canela", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      --font-mono: "SFMono-Regular", "SF Mono", "JetBrains Mono", "Fira Code", monospace;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      min-height: 100%;
    }

    body {
      font-family: var(--font-sans);
      background: var(--page-bg);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
    }

    a,
    button,
    input {
      font: inherit;
    }

    a {
      color: inherit;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .home {
      min-height: 100vh;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: clamp(16px, 3vw, 28px);
      background:
        radial-gradient(circle at top, ${isLight ? 'rgba(255,255,255,0.52)' : 'rgba(255,255,255,0.04)'} 0, transparent 48%),
        var(--page-bg);
    }

    .home__inner {
      width: min(920px, 100%);
      max-height: calc(100dvh - clamp(32px, 6vw, 56px));
    }

    .shell {
      display: grid;
      gap: 22px;
      max-height: 100%;
      padding: clamp(24px, 4vw, 36px);
      border-radius: 30px;
      background: var(--shell-bg);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
    }

    .shell__header {
      display: grid;
      justify-items: center;
      gap: 16px;
      text-align: center;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      max-width: 100%;
    }

    .brand__mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 46px;
      height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--badge-bg);
      color: var(--badge-text);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .brand__label {
      min-width: 0;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--text-soft);
      overflow-wrap: anywhere;
    }

    .home__title {
      margin: 0;
      max-width: 12ch;
      font-family: var(--font-display);
      font-size: clamp(38px, 7vw, 62px);
      line-height: 0.96;
      letter-spacing: -0.03em;
      font-weight: 600;
      overflow-wrap: anywhere;
    }

    .home__subtitle {
      margin: 0;
      max-width: 42rem;
      color: var(--text-muted);
      font-size: 16px;
      line-height: 1.6;
      overflow-wrap: anywhere;
    }

    .search-panel {
      display: grid;
      gap: 14px;
      padding: 22px;
      border-radius: 24px;
      background: var(--page-bg-alt);
      border: 1px solid var(--border);
    }

    .search-panel__row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: stretch;
    }

    .search-panel__input {
      width: 100%;
      min-width: 0;
      min-height: 58px;
      padding: 0 18px;
      border-radius: 18px;
      border: 1px solid var(--border-strong);
      background: var(--input-bg);
      color: var(--text);
      outline: none;
      font-size: 16px;
      transition: border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease;
    }

    .search-panel__input::placeholder {
      color: var(--text-muted);
      opacity: 1;
    }

    .search-panel__input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px var(--focus-ring);
    }

    .search-panel__button {
      min-height: 58px;
      min-width: 120px;
      padding: 0 22px;
      border: 1px solid var(--button-bg);
      border-radius: 18px;
      background: var(--button-bg);
      color: var(--button-text);
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.16s ease, transform 0.16s ease;
    }

    .search-panel__button:hover {
      opacity: 0.92;
      transform: translateY(-1px);
    }

    .search-panel__button:focus-visible {
      outline: none;
      box-shadow: 0 0 0 4px var(--focus-ring);
    }

    .search-panel__hint {
      margin: 0;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.5;
      text-align: center;
      overflow-wrap: anywhere;
    }

    .results {
      display: grid;
      gap: 12px;
      min-height: 0;
    }

    .results[hidden] {
      display: none;
    }

    .results__header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }

    .results__title {
      margin: 0;
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 1.4;
      font-weight: 600;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--text-soft);
      overflow-wrap: anywhere;
    }

    .results__status {
      min-width: 0;
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .results-box {
      display: grid;
      gap: 10px;
      min-height: 0;
      max-height: min(52vh, 560px);
      padding: 6px 4px 6px 0;
      overflow-y: auto;
      background: var(--results-bg);
      border-radius: 20px;
    }

    .results-box::-webkit-scrollbar {
      width: 8px;
    }

    .results-box::-webkit-scrollbar-thumb {
      background: var(--border-strong);
      border-radius: 999px;
    }

    .result-item,
    .results-empty {
      display: grid;
      gap: 10px;
      padding: 16px;
      border-radius: 18px;
      border: 1px solid var(--border);
      background: var(--result-card-bg);
    }

    .result-item {
      transition: border-color 0.16s ease, transform 0.16s ease;
    }

    .result-item:hover {
      border-color: var(--border-strong);
      transform: translateY(-1px);
    }

    .result-item__top {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      gap: 12px;
      align-items: start;
    }

    .favicon {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      margin-top: 3px;
    }

    .result-item__text {
      min-width: 0;
      display: grid;
      gap: 3px;
    }

    .result-item__title {
      color: var(--link);
      text-decoration: none;
      font-size: 16px;
      line-height: 1.35;
      font-weight: 600;
      overflow-wrap: anywhere;
    }

    .result-item__title:hover {
      text-decoration: underline;
    }

    .result-item__domain {
      color: var(--text-soft);
      font-size: 12px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }

    .result-item__snippet {
      margin: 0;
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }

    .youtube-preview {
      overflow: hidden;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--page-bg-alt);
    }

    .youtube-preview img {
      display: block;
      width: 100%;
      max-width: 320px;
      aspect-ratio: 16 / 9;
      object-fit: cover;
    }

    .results-empty {
      color: var(--text-muted);
    }

    .results-fallback {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      width: fit-content;
      padding: 0 14px;
      border-radius: 12px;
      border: 1px solid var(--border-strong);
      background: var(--input-bg);
      color: var(--text);
      text-decoration: none;
      font-weight: 600;
    }

    .results-fallback:hover {
      border-color: var(--accent);
    }

    .reveal {
      opacity: 0;
      transform: translateY(8px);
      animation: reveal 220ms ease-out forwards;
    }

    @keyframes reveal {
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @media (max-width: 640px) {
      .home {
        padding: 12px;
      }

      .home__inner {
        max-height: none;
      }

      .shell {
        gap: 18px;
        padding: 18px;
      }

      .search-panel {
        padding: 14px;
      }

      .search-panel__row {
        grid-template-columns: 1fr;
      }

      .search-panel__button {
        width: 100%;
      }

      .results-box {
        max-height: none;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .reveal,
      .result-item {
        opacity: 1;
        transform: none;
        animation: none;
        transition: none;
      }

      .search-panel__button,
      .search-panel__input {
        transition: none;
      }
    }
  </style>
</head>
<body>
  <main class="home">
    <div class="home__inner">
      <section class="shell reveal">
        <header class="shell__header">
          <div class="brand" aria-label="${escapeHtml(strings.brandLabel || 'AG Browser')}">
            <span class="brand__mark" aria-hidden="true">AG</span>
            <span class="brand__label" dir="auto">${escapeHtml(strings.brandLabel || 'AG Browser')}</span>
          </div>

          <h1 class="home__title">${escapeHtml(strings.searchTitle || 'AG Search')}</h1>
          <p class="home__subtitle">${escapeHtml(strings.subtitle || 'Search the web without leaving the start page.')}</p>
        </header>

        <form id="homeSearchForm" class="search-panel" autocomplete="off">
          <label class="sr-only" for="homeSearchInput">${escapeHtml(strings.searchPlaceholder || 'Search the web or type a URL')}</label>
          <div class="search-panel__row">
            <input
              id="homeSearchInput"
              class="search-panel__input"
              type="text"
              spellcheck="false"
              autocapitalize="none"
              autocomplete="off"
              placeholder="${escapeHtml(strings.searchPlaceholder || 'Search the web or type a URL')}"
              enterkeyhint="search"
            />
            <button class="search-panel__button" type="submit">${escapeHtml(strings.searchButton || 'Search')}</button>
          </div>
          ${searchHintMarkup}
        </form>

        <section id="homeResults" class="results" aria-live="polite" hidden>
          <div class="results__header">
            <h2 class="results__title">${escapeHtml(strings.resultsTitle || 'Results')}</h2>
            <span id="homeResultsStatus" class="results__status"></span>
          </div>
          <div id="homeResultsBox" class="results-box"></div>
        </section>
      </section>
    </div>
  </main>

  <script>
    const HOME_CONFIG = ${payload};
    const DIRECT_URL_RE = /^(https?|ag):\\/\\//i;
    const HOSTLIKE_INPUT_RE = /^(localhost|\\d{1,3}(?:\\.\\d{1,3}){3}|(?:[a-z0-9-]+\\.)+[a-z]{2,})(?::\\d+)?(?:[/?#].*)?$/i;
    const LOCAL_HOST_INPUT_RE = /^(localhost|\\d{1,3}(?:\\.\\d{1,3}){3})(?::\\d+)?(?:[/?#].*)?$/i;

    const form = document.getElementById('homeSearchForm');
    const input = document.getElementById('homeSearchInput');
    const resultsSection = document.getElementById('homeResults');
    const resultsStatus = document.getElementById('homeResultsStatus');
    const resultsBox = document.getElementById('homeResultsBox');

    function escapeHtmlJs(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function safeParseUrlJs(rawUrl) {
      try {
        return new URL(String(rawUrl || '').trim());
      } catch {
        return null;
      }
    }

    function normalizeInput(value) {
      const trimmed = String(value || '').trim();
      if (!trimmed) return '';
      if (DIRECT_URL_RE.test(trimmed)) return trimmed;

      if (HOSTLIKE_INPUT_RE.test(trimmed)) {
        const scheme = LOCAL_HOST_INPUT_RE.test(trimmed) ? 'http' : 'https';
        return scheme + '://' + trimmed;
      }

      return '';
    }

    function buildFallbackSearchUrl(query) {
      try {
        const base = new URL(HOME_CONFIG.searchBaseUrl || '${DEFAULT_CUSTOM_HOMEPAGE}');
        base.searchParams.set('q', query);
        return base.toString();
      } catch {
        return 'https://www.google.com/search?q=' + encodeURIComponent(query);
      }
    }

    function getDomain(rawUrl) {
      const parsed = safeParseUrlJs(rawUrl);
      return parsed?.hostname ? parsed.hostname.replace(/^www\\./i, '') : '';
    }

    function toSafeHttpUrl(rawUrl) {
      const parsed = safeParseUrlJs(rawUrl);
      if (!parsed) return '';
      return /^(https?):$/i.test(parsed.protocol) ? parsed.toString() : '';
    }

    function getFaviconUrl(domain) {
      return domain
        ? 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(domain) + '&sz=32'
        : '';
    }

    function getYouTubeVideoId(rawUrl) {
      const parsed = safeParseUrlJs(rawUrl);
      if (!parsed) return '';
      if (parsed.hostname.includes('youtube.com')) return parsed.searchParams.get('v') || '';
      if (parsed.hostname.includes('youtu.be')) return parsed.pathname.slice(1);
      return '';
    }

    function buildResultMarkup(item) {
      const safeLink = toSafeHttpUrl(item?.link);
      if (!safeLink) return '';

      const title = escapeHtmlJs(item?.title || safeLink);
      const snippet = escapeHtmlJs(item?.snippet || '');
      const domain = getDomain(safeLink);
      const domainLabel = escapeHtmlJs(domain || safeLink);
      const safeHref = escapeHtmlJs(safeLink);
      const faviconUrl = getFaviconUrl(domain);
      const youtubeId = escapeHtmlJs(getYouTubeVideoId(safeLink));
      const previewMarkup = youtubeId
        ? '<div class="youtube-preview"><img src="https://i.ytimg.com/vi/' + youtubeId + '/mqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer" /></div>'
        : '';

      return [
        '<article class="result-item">',
        '  <div class="result-item__top">',
        faviconUrl
          ? '    <img class="favicon" src="' + escapeHtmlJs(faviconUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" />'
          : '    <span class="favicon" aria-hidden="true"></span>',
        '    <div class="result-item__text">',
        '      <a class="result-item__title" href="' + safeHref + '">' + title + '</a>',
        '      <div class="result-item__domain">' + domainLabel + '</div>',
        '    </div>',
        '  </div>',
        snippet ? '  <p class="result-item__snippet">' + snippet + '</p>' : '',
        previewMarkup,
        '</article>'
      ].filter(Boolean).join('\\n');
    }

    function renderMessage(message, fallbackUrl = '') {
      const safeMessage = escapeHtmlJs(message);
      const safeFallbackUrl = fallbackUrl ? escapeHtmlJs(fallbackUrl) : '';
      resultsBox.innerHTML = fallbackUrl
        ? '<div class="results-empty"><p>' + safeMessage + '</p><a class="results-fallback" href="' + safeFallbackUrl + '">' + escapeHtmlJs(HOME_CONFIG.labels.searchFallbackAction) + '</a></div>'
        : '<div class="results-empty">' + safeMessage + '</div>';
    }

    async function searchInline(query) {
      const apiKey = HOME_CONFIG.searchApiKey;
      const engineId = HOME_CONFIG.searchEngineId;
      const fallbackUrl = buildFallbackSearchUrl(query);

      resultsSection.hidden = false;
      resultsStatus.textContent = query;
      renderMessage(HOME_CONFIG.labels.searchLoading);

      try {
        const searchUrl = 'https://www.googleapis.com/customsearch/v1?key='
          + encodeURIComponent(apiKey)
          + '&cx=' + encodeURIComponent(engineId)
          + '&q=' + encodeURIComponent(query);

        const response = await fetch(searchUrl, {
          method: 'GET',
          headers: { Accept: 'application/json' }
        });

        if (!response.ok) {
          throw new Error('Search API Error');
        }

        const data = await response.json();
        const items = Array.isArray(data?.items)
          ? data.items.map(buildResultMarkup).filter(Boolean)
          : [];

        if (!items.length) {
          renderMessage(HOME_CONFIG.labels.searchNoResults, fallbackUrl);
          return;
        }

        resultsBox.innerHTML = items.join('');
        resultsBox.scrollTop = 0;
      } catch (error) {
        console.error('Inline search error:', error);
        renderMessage(HOME_CONFIG.labels.searchError, fallbackUrl);
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = String(input.value || '').trim();
      if (!value) {
        input.focus();
        return;
      }

      const directUrl = normalizeInput(value);
      if (directUrl) {
        window.location.assign(directUrl);
        return;
      }

      void searchInline(value);
    });

    requestAnimationFrame(() => {
      const shouldFocus = typeof window.matchMedia !== 'function'
        || !window.matchMedia('(pointer: coarse)').matches;

      if (shouldFocus) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  </script>
</body>
</html>`;
}

module.exports = {
  BUILTIN_HOMEPAGE_URL,
  DEFAULT_CUSTOM_HOMEPAGE,
  HOMEPAGE_MODE_BUILTIN,
  HOMEPAGE_MODE_CUSTOM,
  isBuiltinHomepageUrl,
  buildBuiltinHomepageHtml
};
