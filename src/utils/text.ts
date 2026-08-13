export function estimateTokens(text: string): number {
  const length = String(text || '').trim().length;
  return length ? Math.max(1, Math.round(length / 4)) : 0;
}

export function truncate(text: string, max = 180): string {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function sanitizeError(value: unknown): string {
  return String(value instanceof Error ? value.message : value || 'Unknown error')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_\-.]{32,}/g, '[redacted]')
    .replace(/file:\/\/[^\s]+/gi, '[local-path]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[local-path]')
    .replace(/\/Users\/[^\s]+/g, '[local-path]')
    .slice(0, 180)
    .trim();
}

export function formatDate(ts?: number): string {
  if (!ts) return 'Never';
  return new Date(ts).toLocaleString();
}

export function formatDuration(ms?: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function hostFrom(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return String(value || '').replace(/^https?:\/\//, '').split('/')[0];
  }
}

export function normalizeBaseUrl(value: string): string {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withProtocol);
    if (!/^https?:$/.test(url.protocol)) return '';
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

export function parseHostPort(baseUrl: string): { ip?: string; port?: number } {
  try {
    const url = new URL(baseUrl);
    const maybePort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return { ip: url.hostname, port: Number.isFinite(maybePort) ? maybePort : undefined };
  } catch {
    return {};
  }
}
