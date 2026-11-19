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
