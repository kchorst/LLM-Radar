import { sanitizeError } from '../utils/text';

export interface FetchJsonOptions {
  timeoutMs: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

export interface FetchJsonResult<T = unknown> {
  ok: boolean;
  status: number;
  durationMs: number;
  data?: T;
  text?: string;
  error?: string;
  aborted?: boolean;
}

export async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions): Promise<FetchJsonResult<T>> {
  const start = Date.now();
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  const timer = setTimeout(abort, options.timeoutMs);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await res.text();
    let data: T | undefined;
    try { data = text ? JSON.parse(text) as T : undefined; } catch { /* raw body kept below */ }
    return {
      ok: res.ok,
      status: res.status,
      durationMs: Date.now() - start,
      data,
      text: text.slice(0, 500)
    };
  } catch (error) {
    const aborted = ctrl.signal.aborted || !!options.signal?.aborted;
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - start,
      error: aborted ? 'Request stopped.' : sanitizeError(error),
      aborted
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
