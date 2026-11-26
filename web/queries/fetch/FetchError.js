/**
 * Normalized HTTP and transport error preserving original Error.cause and abort/timeout flags.
 */
export class FetchError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, url?: string, body?: unknown, headers?: Headers | null, cause?: unknown, isTimeout?: boolean, isAborted?: boolean }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'FetchError';
    this.status = options.status ?? 0;
    this.url = options.url ?? '';
    this.body = options.body ?? null;
    this.headers = options.headers ?? null;

    const causeName = options.cause && typeof options.cause === 'object' ? options.cause.name : '';
    this.isTimeout = Boolean(options.isTimeout || causeName === 'TimeoutError');
    this.isAborted = Boolean(options.isAborted || causeName === 'AbortError');
  }
}

/** User-facing error text that names the failing server, e.g. "MethodNotImplemented (HTTP 501 from bsky.social/xrpc/chat.bsky.convo.getConvoForMembers)". */
export function describeFetchError(err, fallback = 'Request failed.') {
  const base = err?.message || fallback;
  if (!(err instanceof FetchError) || !err.status || !err.url) return base;
  try {
    const u = new URL(err.url);
    return `${base} (HTTP ${err.status} from ${u.host}${u.pathname})`;
  } catch {
    return `${base} (HTTP ${err.status})`;
  }
}
