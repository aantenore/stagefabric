export type BoundedFetchFailureCode =
  | 'invalid_configuration'
  | 'request_rejected'
  | 'request_aborted'
  | 'request_timeout'
  | 'upstream_redirect'
  | 'upstream_response_invalid'
  | 'upstream_response_too_large'
  | 'network_failure';

export class BoundedFetchError extends Error {
  readonly code: BoundedFetchFailureCode;
  readonly statusCode: number | undefined;

  constructor(code: BoundedFetchFailureCode, statusCode?: number) {
    super(code);
    this.name = 'BoundedFetchError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface CreateBoundedFetchOptions {
  readonly baseUrl: string;
  /** Absolute pathnames the caller may reach beneath baseUrl (no query/hash). */
  readonly allowedPathnames: readonly string[];
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly fetch?: typeof globalThis.fetch;
}

function configurationError(): never {
  throw new BoundedFetchError('invalid_configuration');
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') {
    return true;
  }
  const octets = hostname.split('.');
  if (octets.length !== 4) {
    return false;
  }
  const numbers = octets.map(Number);
  return (
    numbers.every(
      (octet, index) =>
        Number.isInteger(octet) &&
        octet >= 0 &&
        octet <= 255 &&
        String(octet) === octets[index],
    ) && numbers[0] === 127
  );
}

function hasUnsafePathEncoding(pathname: string): boolean {
  return pathname.includes('\\') || /%(?:2e|2f|5c)/i.test(pathname);
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return configurationError();
  }

  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    hasUnsafePathEncoding(url.pathname) ||
    value.includes('\\')
  ) {
    return configurationError();
  }
  return url;
}

function normalizedPathPrefix(url: URL): string {
  const pathname = url.pathname.replace(/\/+$/, '');
  return pathname === '' ? '/' : pathname;
}

function isWithinPathPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/') {
    return pathname.startsWith('/');
  }
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function parseAllowedPathnames(
  values: readonly string[],
  prefix: string,
): ReadonlySet<string> {
  if (values.length === 0) configurationError();
  const allowed = new Set<string>();
  for (const value of values) {
    if (
      !value.startsWith('/') ||
      value.includes('?') ||
      value.includes('#') ||
      value.includes('\\') ||
      hasUnsafePathEncoding(value) ||
      !isWithinPathPrefix(value, prefix) ||
      new URL(value, 'https://stagefabric.invalid').pathname !== value ||
      allowed.has(value)
    ) {
      configurationError();
    }
    allowed.add(value);
  }
  return allowed;
}

function parseRequestUrl(value: string): URL {
  if (
    value.includes('\\') ||
    /%(?:2e|2f|5c)/i.test(value) ||
    /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/.test(value)
  ) {
    throw new BoundedFetchError('request_rejected');
  }
  try {
    return new URL(value);
  } catch {
    throw new BoundedFetchError('request_rejected');
  }
}

interface RequestSnapshot {
  readonly fetchInput: RequestInfo | URL;
  readonly fetchInit: RequestInit | undefined;
  readonly requestUrl: URL;
  readonly callerSignal: AbortSignal | undefined;
}

function snapshotRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): RequestSnapshot {
  if (input instanceof Request) {
    try {
      const request = new Request(input, init);
      return {
        fetchInput: request,
        fetchInit: undefined,
        requestUrl: parseRequestUrl(request.url),
        callerSignal: request.signal,
      };
    } catch {
      throw new BoundedFetchError('request_rejected');
    }
  }

  let rawUrl: string;
  if (typeof input === 'string') {
    rawUrl = input;
  } else if (input instanceof URL) {
    try {
      // Bypass a subclass override and read the native URL internal slot once.
      rawUrl = URL.prototype.toString.call(input);
    } catch {
      throw new BoundedFetchError('request_rejected');
    }
  } else {
    // Runtime callers do not get the broader coercion accepted by native fetch.
    throw new BoundedFetchError('request_rejected');
  }

  const requestUrl = parseRequestUrl(rawUrl);
  return {
    // Forward the validated canonical string, never the original coercible value.
    fetchInput: requestUrl.href,
    fetchInit: init,
    requestUrl,
    callerSignal: init?.signal ?? undefined,
  };
}

function validatePositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    configurationError();
  }
}

function assertedContentLength(
  response: Response,
  maxResponseBytes: number,
): void {
  const header = response.headers.get('content-length');
  if (header === null) {
    return;
  }
  if (!/^\d+$/.test(header)) {
    throw new BoundedFetchError('upstream_response_invalid', response.status);
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length)) {
    throw new BoundedFetchError('upstream_response_invalid', response.status);
  }
  if (length > maxResponseBytes) {
    throw new BoundedFetchError('upstream_response_too_large', response.status);
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort and must not replace the bounded error.
  }
}

async function readBoundedBody(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (response.body === null) {
    return new ArrayBuffer(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortableRead(reader, signal);
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel();
        throw new BoundedFetchError(
          'upstream_response_too_large',
          response.status,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BoundedFetchError) {
      throw error;
    }
    throw new BoundedFetchError('network_failure', response.status);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A custom stream may keep a read pending after cancellation.
    }
  }

  const body = new ArrayBuffer(total);
  const view = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function abortableRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      void reader.cancel().catch(() => undefined);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function reconstructedResponse(
  response: Response,
  body: ArrayBuffer,
): Response {
  const statusForbidsBody =
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304;
  return new Response(
    statusForbidsBody || body.byteLength === 0 ? null : body,
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

function isAborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Wraps fetch with a host-controlled origin/path boundary, deadline, redirect
 * denial, and a streaming response-size limit. Error messages contain only
 * stable reason codes so endpoints, bodies, credentials, and causes never leak.
 */
export function createBoundedFetch(
  options: CreateBoundedFetchOptions,
): typeof globalThis.fetch {
  const baseUrl = parseBaseUrl(options.baseUrl);
  const pathPrefix = normalizedPathPrefix(baseUrl);
  const allowedPathnames = parseAllowedPathnames(
    options.allowedPathnames,
    pathPrefix,
  );
  validatePositiveInteger(options.timeoutMs);
  validatePositiveInteger(options.maxResponseBytes);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return async (input, init) => {
    const snapshot = snapshotRequest(input, init);
    const { requestUrl } = snapshot;
    if (
      requestUrl.origin !== baseUrl.origin ||
      !allowedPathnames.has(requestUrl.pathname) ||
      requestUrl.username !== '' ||
      requestUrl.password !== '' ||
      requestUrl.search !== '' ||
      requestUrl.hash !== '' ||
      hasUnsafePathEncoding(requestUrl.pathname)
    ) {
      throw new BoundedFetchError('request_rejected');
    }

    const callerSignal = snapshot.callerSignal;
    if (isAborted(callerSignal)) {
      throw new BoundedFetchError('request_aborted');
    }

    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, options.timeoutMs);
    const signal =
      callerSignal === undefined
        ? timeoutController.signal
        : AbortSignal.any([callerSignal, timeoutController.signal]);

    let rejectAbort: (reason?: unknown) => void = () => undefined;
    const abortFailure = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort(
        new BoundedFetchError(timedOut ? 'request_timeout' : 'request_aborted'),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    const performFetch = async () => {
      const response = await fetchImplementation(snapshot.fetchInput, {
        ...snapshot.fetchInit,
        redirect: 'manual',
        signal,
      });

      if (response.status >= 300 && response.status < 400) {
        await cancelBody(response);
        throw new BoundedFetchError('upstream_redirect', response.status);
      }

      try {
        assertedContentLength(response, options.maxResponseBytes);
      } catch (error) {
        await cancelBody(response);
        throw error;
      }
      const body = await readBoundedBody(
        response,
        options.maxResponseBytes,
        signal,
      );
      return reconstructedResponse(response, body);
    };

    try {
      return await Promise.race([performFetch(), abortFailure]);
    } catch (error) {
      if (
        error instanceof BoundedFetchError &&
        error.code !== 'network_failure'
      ) {
        throw error;
      }
      if (timedOut) {
        throw new BoundedFetchError('request_timeout');
      }
      if (isAborted(callerSignal)) {
        throw new BoundedFetchError('request_aborted');
      }
      if (error instanceof BoundedFetchError) {
        throw error;
      }
      throw new BoundedFetchError('network_failure');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  };
}
