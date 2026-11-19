import { classifyAddressSpace } from '../../constants/endpoints.js';
import { FetchError } from './FetchError.js';

function isMultipartOrBinaryBody(value) {
  if (value === null || value === undefined) return false;
  if (typeof FormData !== 'undefined' && value instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return true;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  return false;
}

function buildCompositeSignal(callerSignal, timeoutMs) {
  const timeoutSignal = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? AbortSignal.timeout(timeoutMs)
    : null;
  const signals = [callerSignal, timeoutSignal].filter(Boolean);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function extractErrorMessage(body, status) {
  if (body && typeof body === 'object') {
    if (typeof body.error === 'string' && body.error) return body.error;
    if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') {
      return body.error.message;
    }
    if (typeof body.message === 'string' && body.message) return body.message;
  }
  if (typeof body === 'string' && body.trim()) {
    return body.trim();
  }
  return `HTTP ${status}`;
}

async function parseErrorBody(res) {
  const contentType = res.headers?.get?.('content-type') || '';
  try {
    if (contentType.includes('json')) {
      return await res.json();
    }
    const text = await res.text();
    if (text && text.trim().startsWith('{')) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Unified HTTP request wrapper with AbortSignal.any timeout+cancel merging,
 * low-priority background tagging, and HTTPS->LAN targetAddressSpace hints.
 *
 * @param {string} url
 * @param {{
 *   method?: string,
 *   headers?: HeadersInit,
 *   body?: BodyInit | null,
 *   json?: unknown,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   background?: boolean,
 *   targetAddressSpace?: 'local' | 'loopback' | 'public',
 *   responseType?: 'auto' | 'json' | 'text' | 'blob' | 'raw',
 *   credentials?: RequestCredentials,
 *   locationObj?: { protocol?: string },
 *   fetchImpl?: typeof fetch,
 * }} [options]
 * @returns {Promise<any>}
 */
export async function fetchWrapper(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    json,
    signal,
    timeoutMs = 15000,
    background = false,
    targetAddressSpace,
    responseType = 'auto',
    credentials,
    locationObj = globalThis.location,
    fetchImpl = globalThis.fetch,
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new FetchError('Fetch API is unavailable in this runtime', { url: String(url) });
  }

  const reqHeaders = new Headers(headers);
  let reqBody;
  if (json !== undefined) {
    reqBody = JSON.stringify(json);
    if (!reqHeaders.has('Content-Type')) {
      reqHeaders.set('Content-Type', 'application/json');
    }
  } else if (body !== undefined && body !== null) {
    reqBody = body;
    if (isMultipartOrBinaryBody(body)) {
      // Leave Content-Type for the platform boundary/type generator unless explicitly provided.
    }
  }

  const init = {
    method,
    headers: reqHeaders,
  };
  if (reqBody !== undefined) {
    init.body = reqBody;
  }

  const mergedSignal = buildCompositeSignal(signal, timeoutMs);
  if (mergedSignal) {
    init.signal = mergedSignal;
  }

  if (background === true) {
    init.priority = 'low';
  }

  if (credentials !== undefined) {
    init.credentials = credentials;
  }

  if (targetAddressSpace) {
    init.targetAddressSpace = targetAddressSpace;
  } else if (locationObj?.protocol === 'https:') {
    try {
      const parsed = new URL(String(url));
      if (parsed.protocol === 'http:') {
        const space = classifyAddressSpace(parsed);
        if (space === 'local' || space === 'loopback') {
          init.targetAddressSpace = space;
        }
      }
    } catch {
      // Leave invalid URL errors to the underlying fetch rejection handler.
    }
  }

  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    if (err instanceof FetchError) {
      throw err;
    }
    const isTimeout = err?.name === 'TimeoutError';
    const isAborted = err?.name === 'AbortError';
    const fallbackMessage = isTimeout
      ? `Request timed out after ${timeoutMs}ms`
      : (err?.message || 'Network request failed');
    throw new FetchError(fallbackMessage, {
      url: String(url),
      cause: err,
      isTimeout,
      isAborted,
    });
  }

  if (!res.ok) {
    const errorBody = await parseErrorBody(res);
    const message = extractErrorMessage(errorBody, res.status);
    throw new FetchError(message, {
      status: res.status,
      url: String(url),
      body: errorBody,
      headers: res.headers,
    });
  }

  if (responseType === 'raw') {
    return res;
  }
  if (responseType === 'blob') {
    return res.blob();
  }
  if (responseType === 'text') {
    return res.text();
  }
  if (res.status === 204) {
    return null;
  }

  const contentType = res.headers?.get?.('content-type') || '';
  if (responseType === 'json' || contentType.includes('json')) {
    return res.json();
  }
  return res.text();
}
