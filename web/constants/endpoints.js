/**
 * Network limits, transport endpoints, and strict origin/address-space validators.
 */

export const MASTODON_MAX_CHARS = 500;
export const BLUESKY_MAX_GRAPHEMES = 300;
export const THREADS_MAX_CHARS = 500;

export const BLUESKY_CHAT_PROXY = 'did:web:api.bsky.chat#bsky_chat';
export const DEFAULT_BSKY_SERVICE = 'https://bsky.social';
export const PUBLIC_BSKY_API = 'https://public.api.bsky.app';
export const BLUESKY_VIDEO_SERVICE = 'https://video.bsky.app';
export const THREADS_GRAPH_BASE = 'https://graph.threads.net/v1.0';
export const THREADS_TOKEN_BASE = 'https://graph.threads.net';
export const THREADS_OAUTH_AUTHORIZE_URL = 'https://threads.net/oauth/authorize';
export const DEFAULT_THREADS_SCOPES = 'threads_basic,threads_content_publish,threads_delete,threads_read_replies,threads_manage_replies,threads_manage_insights';

const LOCAL_DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|ts\.net)$/;
const TAILSCALE_DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const EXPLICIT_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const DISALLOWED_COLON_SCHEME_RE = /^(?:javascript|data|vbscript|blob|file|capacitor|ionic):/i;
const LOCAL_PREFIX_HINT_RE = /^(?:localhost|127\.|10\.|192\.168\.|172\.|100\.|\[::1\]|::1)/i;

/**
 * Parse a canonical dotted-quad IPv4 literal into four byte octets, or null.
 * Rejects leading zeros and out-of-range octets.
 * @param {string} hostname
 * @returns {number[] | null}
 */
export function parseIpv4Octets(hostname) {
  if (typeof hostname !== 'string') return null;
  const match = IPV4_RE.exec(hostname.trim());
  if (!match) return null;
  const octets = [];
  for (let i = 1; i <= 4; i += 1) {
    const part = match[i];
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255 || String(num) !== part) {
      return null;
    }
    octets.push(num);
  }
  return octets;
}

function normalizeHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host === '::1' || host === '[::1]') {
    return true;
  }
  const octets = parseIpv4Octets(host);
  return octets !== null && octets[0] === 127;
}

/**
 * @param {number[] | null} octets
 * @returns {boolean}
 */
export function isRfc1918Ipv4(octets) {
  if (!Array.isArray(octets) || octets.length !== 4) return false;
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Tailscale CGNAT range 100.64.0.0/10 (100.64.0.0 - 100.127.255.255).
 * @param {number[] | null} octets
 * @returns {boolean}
 */
export function isTailscaleCgnatIpv4(octets) {
  if (!Array.isArray(octets) || octets.length !== 4) return false;
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Validate bounded .local (mDNS) and .ts.net (Tailscale MagicDNS) hostnames.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLocalDomainHost(hostname) {
  const host = normalizeHost(hostname);
  return LOCAL_DOMAIN_RE.test(host);
}

function parseHttpOriginUrl(urlInput) {
  const parsed = urlInput instanceof URL ? urlInput : new URL(String(urlInput));
  if (parsed.origin === 'null') {
    throw new TypeError('Opaque "null" origins are not allowed');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Unsupported protocol: ${parsed.protocol}`);
  }
  if (!parsed.hostname) {
    throw new TypeError('URL hostname is required');
  }
  return parsed;
}

function classifyParsedHost(parsed) {
  const host = normalizeHost(parsed.hostname);
  if (isLoopbackHost(host)) {
    return 'loopback';
  }
  const octets = parseIpv4Octets(host);
  if (isRfc1918Ipv4(octets) || isTailscaleCgnatIpv4(octets) || isLocalDomainHost(host)) {
    return 'local';
  }
  return 'public';
}

/**
 * Classify a URL's network address space as 'loopback', 'local', or 'public'.
 * @param {string | URL} urlInput
 * @returns {'loopback' | 'local' | 'public'}
 */
export function classifyAddressSpace(urlInput) {
  const parsed = parseHttpOriginUrl(urlInput);
  return classifyParsedHost(parsed);
}

/**
 * Permit https:// anywhere with a non-opaque origin, and cleartext http:// strictly
 * for loopback, RFC1918 LAN, Tailscale CGNAT (100.64.0.0/10), .local, and .ts.net.
 * @param {string | URL} urlInput
 * @returns {boolean}
 */
export function isAllowedNodeUrl(urlInput) {
  if (!(urlInput instanceof URL) && (typeof urlInput !== 'string' || !urlInput.trim())) {
    return false;
  }
  let parsed;
  try {
    parsed = parseHttpOriginUrl(urlInput);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  if (parsed.protocol === 'https:') {
    return true;
  }
  const space = classifyParsedHost(parsed);
  return space === 'loopback' || space === 'local';
}

/**
 * Allow cleartext Sanctuary connections only to the same device.
 * Network clients must use HTTPS to avoid exposing credentials and user data.
 * @param {string | URL} urlInput
 * @returns {boolean}
 */
export function isSecureSanctuaryNodeUrl(urlInput) {
  let parsed;
  try {
    parsed = parseHttpOriginUrl(urlInput);
  } catch {
    return false;
  }
  const host = normalizeHost(parsed.hostname);
  return parsed.protocol === 'https:'
    || isLoopbackHost(host)
    || isTailscaleCgnatIpv4(parseIpv4Octets(host))
    || TAILSCALE_DOMAIN_RE.test(host);
}

/**
 * Require https:// and a public, non-opaque origin for Fediverse / social endpoints.
 * @param {string | URL} urlInput
 * @returns {boolean}
 */
export function isAllowedSocialUrl(urlInput) {
  if (!(urlInput instanceof URL) && (typeof urlInput !== 'string' || !urlInput.trim())) {
    return false;
  }
  let parsed;
  try {
    parsed = parseHttpOriginUrl(urlInput);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.protocol !== 'https:') {
    return false;
  }
  return classifyParsedHost(parsed) === 'public';
}

/**
 * Normalize a public Fediverse / ATProto instance URL to its strict https:// origin.
 * @param {string} input
 * @returns {string}
 */
export function normalizeInstanceUrl(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Social instance URL must be a string');
  }
  const trimmed = input.trim();
  if (!trimmed || DISALLOWED_COLON_SCHEME_RE.test(trimmed)) {
    throw new TypeError('Social instance URL is invalid');
  }
  const candidate = EXPLICIT_SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!isAllowedSocialUrl(candidate)) {
    throw new TypeError(`Disallowed social instance URL: ${trimmed}`);
  }
  return new URL(candidate).origin;
}

/**
 * @param {string | URL} urlInput
 * @returns {boolean}
 */
export function isTailscaleFunnelUrl(urlInput) {
  if (!(urlInput instanceof URL) && (typeof urlInput !== 'string' || !urlInput.trim())) {
    return false;
  }
  try {
    const parsed = parseHttpOriginUrl(urlInput);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return false;
    }
    return TAILSCALE_DOMAIN_RE.test(normalizeHost(parsed.hostname));
  } catch {
    return false;
  }
}

function isLocalSchemelessInput(trimmed) {
  const hostAndPort = trimmed.split(/[/?#]/)[0];
  if (LOCAL_PREFIX_HINT_RE.test(hostAndPort)) {
    return true;
  }
  const bareHost = hostAndPort.replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '');
  return LOCAL_DOMAIN_RE.test(bareHost);
}

/**
 * Normalize a user-supplied Sanctuary companion node URL.
 * Returns "" for empty input, or validated origin+path without trailing slash.
 * @param {string} input
 * @returns {string}
 */
export function normalizeNodeUrl(input) {
  if (input === null || input === undefined) {
    return '';
  }
  if (typeof input !== 'string') {
    throw new TypeError('Sanctuary node URL must be a string');
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }
  if (DISALLOWED_COLON_SCHEME_RE.test(trimmed)) {
    throw new TypeError(`Disallowed Sanctuary node URL scheme: ${trimmed}`);
  }
  const candidate = EXPLICIT_SCHEME_RE.test(trimmed)
    ? trimmed
    : isLocalSchemelessInput(trimmed)
      ? `http://${trimmed}`
      : trimmed;

  if (!isAllowedNodeUrl(candidate)) {
    throw new TypeError(`Disallowed Sanctuary node URL: ${trimmed}`);
  }
  const parsed = new URL(candidate);
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}

/**
 * Auto-detect a same-origin Sanctuary node when served over HTTP(S) from Flask/desktop.py.
 * Returns "" inside Capacitor native WebViews, file://, or public static PWA hosting.
 * @param {{ locationObj?: Location, capacitorObj?: { isNativePlatform?: () => boolean } }} [opts]
 * @returns {string}
 */
export function detectDefaultNodeUrl({
  locationObj = globalThis.location,
  capacitorObj = globalThis.Capacitor,
} = {}) {
  if (capacitorObj && typeof capacitorObj.isNativePlatform === 'function' && capacitorObj.isNativePlatform()) {
    return '';
  }
  if (!locationObj || typeof locationObj.origin !== 'string' || !locationObj.origin || locationObj.origin === 'null') {
    return '';
  }
  if (locationObj.protocol !== 'http:' && locationObj.protocol !== 'https:') {
    return '';
  }
  let space;
  try {
    space = classifyAddressSpace(locationObj.origin);
  } catch {
    return '';
  }
  if (space === 'loopback' || space === 'local') {
    return locationObj.origin;
  }
  return '';
}

/**
 * Resolve a Sanctuary API, SSE, or media path against a validated base node URL.
 * Passes through data: and blob: URIs untouched.
 * @param {string} path
 * @param {string} nodeUrl
 * @returns {string}
 */
export function resolveNodeUrl(path, nodeUrl) {
  if (typeof path === 'string' && (path.startsWith('data:') || path.startsWith('blob:'))) {
    return path;
  }
  const base = normalizeNodeUrl(nodeUrl || '');
  if (!base) {
    throw new Error('Sanctuary node URL is not configured');
  }
  const raw = String(path || '').trim();
  if (!raw) {
    return base;
  }
  if (EXPLICIT_SCHEME_RE.test(raw)) {
    const parsedPath = new URL(raw);
    const parsedBase = new URL(base);
    if (parsedPath.origin === parsedBase.origin && parsedPath.origin !== 'null') {
      return raw;
    }
    throw new TypeError(`Refusing cross-origin Sanctuary URL resolution: ${raw}`);
  }
  const cleanRel = raw.replace(/^\.?\//, '');
  return `${base}/${cleanRel}`;
}

/** Resolve the account's real PDS origin from an atproto session/didDoc; '' when absent. */
export function bskyPdsFromDidDoc(didDoc) {
  const services = Array.isArray(didDoc?.service) ? didDoc.service : [];
  const pds = services.find((s) => String(s?.id || '').endsWith('#atproto_pds') && s?.type === 'AtprotoPersonalDataServer');
  const endpoint = String(pds?.serviceEndpoint || '').trim();
  return endpoint.startsWith('https://') ? normalizeInstanceUrl(endpoint) : '';
}
