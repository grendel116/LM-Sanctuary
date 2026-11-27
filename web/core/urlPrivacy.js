/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * URL normalization, tracking-parameter stripping, prefix search routing,
 * and configurable search resolution (with zero forced default engine).
 */

export const NEWTAB_URL = 'sanctuary://newtab';

export const SEARCH_ENGINES = Object.freeze([
  { id: 'duckduckgo', label: 'DuckDuckGo', alias: '@ddg', aliases: ['ddg', 'duckduckgo'], template: 'https://duckduckgo.com/?q=%s' },
  { id: 'ecosia', label: 'Ecosia', alias: '@eco', aliases: ['eco', 'ecosia'], template: 'https://www.ecosia.org/search?q=%s' },
  { id: 'startpage', label: 'Startpage', alias: '@sp', aliases: ['sp', 'startpage'], template: 'https://www.startpage.com/sp/search?query=%s' },
  { id: 'brave', label: 'Brave Search', alias: '@br', aliases: ['br', 'brave'], template: 'https://search.brave.com/search?q=%s' },
  { id: 'kagi', label: 'Kagi', alias: '@kagi', aliases: ['kagi'], template: 'https://kagi.com/search?q=%s' },
  { id: 'qwant', label: 'Qwant', alias: '@qw', aliases: ['qw', 'qwant'], template: 'https://www.qwant.com/?q=%s' },
  { id: 'searxng', label: 'SearXNG Instance', alias: '@sx', aliases: ['sx', 'searxng'], requiresBaseUrl: true },
  { id: 'wikipedia', label: 'Wikipedia', alias: '@w', aliases: ['w', 'wikipedia'], template: 'https://en.wikipedia.org/wiki/Special:Search?search=%s' },
  { id: 'perplexity', label: 'Perplexity', alias: '@pplx', aliases: ['pplx', 'perplexity'], template: 'https://www.perplexity.ai/search?q=%s' },
  { id: 'google', label: 'Google', alias: '@g', aliases: ['g', 'google'], template: 'https://www.google.com/search?q=%s' },
  { id: 'bing', label: 'Bing', alias: '@b', aliases: ['b', 'bing'], template: 'https://www.bing.com/search?q=%s' },
  { id: 'custom', label: 'Custom Search URL (%s)', alias: '', aliases: [], requiresTemplate: true },
]);

export const AT_KEYWORD_ROUTES = Object.freeze({
  yt: { id: 'youtube', template: 'https://www.youtube.com/results?search_query=%s' },
  youtube: { id: 'youtube', template: 'https://www.youtube.com/results?search_query=%s' },
  gh: { id: 'github', template: 'https://github.com/search?q=%s' },
  github: { id: 'github', template: 'https://github.com/search?q=%s' },
  maps: { id: 'openstreetmap', template: 'https://www.openstreetmap.org/search?query=%s' },
  openstreetmap: { id: 'openstreetmap', template: 'https://www.openstreetmap.org/search?query=%s' },
});

export function normalizeSearchEngineId(rawId) {
  const clean = String(rawId || '').trim().toLowerCase();
  if (!clean) return '';
  if (clean === 'ddg') return 'duckduckgo';
  return SEARCH_ENGINES.some((item) => item.id === clean) ? clean : '';
}

export const PREFIX_ROUTES = Object.freeze({
  github: 'https://github.com/search?q=%s',
  arxiv: 'https://arxiv.org/search/?query=%s&searchtype=all',
  hn: 'https://hn.algolia.com/?q=%s',
  wikipedia: 'https://en.wikipedia.org/w/index.php?search=%s',
  bandcamp: 'https://bandcamp.com/search?q=%s',
  kexp: 'https://www.kexp.org/search/?q=%s',
});

const TRACKING_EXACT_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igsh',
  'igshid',
  'si',
  '_hsenc',
  '_hsmi',
  'vero_id',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'rb_clickid',
  's_cid',
  'wickedid',
  'yclid',
]);

const TRACKING_PREFIXES = ['utm_', 'pk_'];

function isTrackingParam(name) {
  const key = String(name || '').toLowerCase();
  if (!key) return false;
  if (TRACKING_EXACT_PARAMS.has(key)) return true;
  return TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Strip known ad/tracker query parameters from http/https URLs while keeping fragments and app params.
 * @param {string} rawUrl
 * @returns {string}
 */
export function stripTrackingParams(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input || input === NEWTAB_URL) return input;
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return input;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (isTrackingParam(key)) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
}

function isLocalOrPrivateHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return false;
  if (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.ts.net') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function looksLikeHostUrl(trimmed) {
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    // Allow host:port/path only when the token after ':' starts with digits
    return /^[a-z0-9.-]+:\d{1,5}(?:[/?#].*)?$/i.test(trimmed);
  }
  if (/^localhost(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)) return true;
  if (/^\[[0-9a-f:]+\](?::\d+)?(?:[/?#].*)?$/i.test(trimmed)) return true;
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?(?:[/?#].*)?$/.exec(trimmed);
  if (ipv4Match) {
    return ipv4Match.slice(1, 5).map(Number).every((n) => n >= 0 && n <= 255);
  }
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d+)?(?:[/?#].*)?$/i.test(trimmed);
}

/**
 * Build a navigable search URL from configured engine settings, or return '' if unconfigured/invalid.
 * @param {string} query
 * @param {{ engine?: string, searxngUrl?: string, customTemplate?: string }} [searchConfig]
 * @returns {string}
 */
export function buildSearchUrl(query, searchConfig = {}) {
  const q = String(query || '').trim();
  const engineId = normalizeSearchEngineId(searchConfig?.engine);
  if (!q || !engineId) return '';

  const encoded = encodeURIComponent(q);
  if (engineId === 'searxng') {
    const base = String(searchConfig?.searxngUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/\S+$/i.test(base)) return '';
    return `${base}/search?q=${encoded}`;
  }

  if (engineId === 'custom') {
    const tmpl = String(searchConfig?.customTemplate || '').trim();
    if (!/^https?:\/\/\S+$/i.test(tmpl) || !tmpl.includes('%s')) return '';
    return tmpl.replaceAll('%s', encoded);
  }

  const def = SEARCH_ENGINES.find((item) => item.id === engineId);
  if (!def?.template) return '';
  return def.template.replaceAll('%s', encoded);
}

/**
 * Resolve address/search bar input into a newtab, @alias/prefix search, direct URL, configured search, or needs_search_engine prompt.
 * @param {string} rawInput
 * @param {{ searchConfig?: { engine?: string, searxngUrl?: string, customTemplate?: string }, stripTrackers?: boolean }} [opts]
 */
export function resolveAddressBarInput(rawInput, { searchConfig = {}, stripTrackers = true } = {}) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed || trimmed === NEWTAB_URL) {
    return { kind: 'newtab', url: NEWTAB_URL };
  }

  const atMatch = /^@([a-z0-9_-]+)\s+(.+)$/i.exec(trimmed);
  if (atMatch) {
    const alias = atMatch[1].toLowerCase();
    const query = atMatch[2].trim();
    if (query) {
      const matchedEngine = SEARCH_ENGINES.find((item) => item.aliases?.includes(alias));
      if (matchedEngine) {
        const aliasUrl = buildSearchUrl(query, { ...searchConfig, engine: matchedEngine.id });
        if (!aliasUrl) {
          return { kind: 'needs_search_engine', query };
        }
        return {
          kind: 'prefix_search',
          prefix: matchedEngine.id,
          query,
          url: aliasUrl,
        };
      }
      const siteRoute = AT_KEYWORD_ROUTES[alias];
      if (siteRoute?.template) {
        return {
          kind: 'prefix_search',
          prefix: siteRoute.id,
          query,
          url: siteRoute.template.replaceAll('%s', encodeURIComponent(query)),
        };
      }
    }
  }

  const prefixMatch = /^(github|arxiv|hn|wikipedia|bandcamp|kexp):\s*(.+)$/i.exec(trimmed);
  if (prefixMatch) {
    const prefix = prefixMatch[1].toLowerCase();
    const query = prefixMatch[2].trim();
    const template = PREFIX_ROUTES[prefix];
    if (template && query) {
      return {
        kind: 'prefix_search',
        prefix,
        query,
        url: template.replaceAll('%s', encodeURIComponent(query)),
      };
    }
  }

  if (looksLikeHostUrl(trimmed)) {
    let candidate = trimmed;
    if (!/^https?:\/\//i.test(candidate)) {
      const hostPart = candidate.split(/[/?#]/)[0].replace(/:\d+$/, '');
      const scheme = isLocalOrPrivateHost(hostPart) ? 'http://' : 'https://';
      candidate = `${scheme}${candidate}`;
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const finalUrl = stripTrackers ? stripTrackingParams(parsed.toString()) : parsed.toString();
        return { kind: 'url', url: finalUrl };
      }
    } catch {
      // Fall through to search handling if host URL fails parsing.
    }
  }

  const searchUrl = buildSearchUrl(trimmed, searchConfig);
  if (!searchUrl) {
    return { kind: 'needs_search_engine', query: trimmed };
  }
  return {
    kind: 'search',
    engine: normalizeSearchEngineId(searchConfig?.engine),
    query: trimmed,
    url: searchUrl,
  };
}

/**
 * Return human-readable display label for the configured search engine, or empty string when unset.
 * @param {{ engine?: string, searxngUrl?: string, customTemplate?: string }} [searchConfig]
 * @returns {string}
 */
export function getSearchEngineLabel(searchConfig = {}) {
  const engineId = normalizeSearchEngineId(searchConfig?.engine);
  if (!engineId) return '';
  if (engineId === 'searxng') {
    const raw = String(searchConfig?.searxngUrl || '').trim();
    try {
      const u = new URL(raw);
      return `SearXNG (${u.host})`;
    } catch {
      return 'SearXNG';
    }
  }
  const found = SEARCH_ENGINES.find((item) => item.id === engineId);
  return found ? found.label : '';
}

/**
 * Extract clean hostname for display/site rules.
 * @param {string} rawUrl
 * @returns {string}
 */
export function extractHostname(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input || input === NEWTAB_URL) return '';
  try {
    const parsed = new URL(input);
    return parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
}
