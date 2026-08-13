import { EndpointRecord } from '../types/domain';
import { hostFrom, normalizeBaseUrl, sanitizeError } from '../utils/text';
import { expandSubnet, getNetworkSnapshot } from './networkInfo';
import { probeEndpoint } from './aiClient';

export interface DiscoverOptions {
  subnetPrefix?: string;
  ports: number[];
  timeoutMs: number;
  concurrency: number;
  signal?: AbortSignal;
  onProgress?: (scanned: number, total: number, message: string) => void;
}

export interface DiscoverResult {
  endpoints: EndpointRecord[];
  scanned: number;
  total: number;
  message: string;
  subnetPrefix: string;
  errors: string[];
  stopped?: boolean;
}

export async function discoverOnWifi(options: DiscoverOptions): Promise<DiscoverResult> {
  const network = await getNetworkSnapshot();
  const subnetPrefix = options.subnetPrefix?.trim() || network.subnetPrefix;
  const hosts = prioritizeHosts(expandSubnet(subnetPrefix), network.ipAddress);
  const ports = Array.from(new Set(options.ports)).filter(p => p > 0 && p < 65536);
  const targets = hosts.flatMap(host => ports.map(port => `http://${host}:${port}`));
  const total = targets.length;
  const found = new Map<string, EndpointRecord>();
  const errors: string[] = [];
  let scanned = 0;

  if (!subnetPrefix || !targets.length) {
    return { endpoints: [], scanned: 0, total: 0, subnetPrefix, message: 'No valid Wi‑Fi subnet was available.', errors };
  }

  await runPool(targets, Math.max(4, Math.min(96, options.concurrency)), options.signal, async target => {
    if (options.signal?.aborted) return;
    try {
      const endpoint = await probeEndpoint(target, { timeoutMs: options.timeoutMs, signal: options.signal });
      if (endpoint && !found.has(endpoint.baseUrl)) found.set(endpoint.baseUrl, endpoint);
    } catch (error) {
      const clean = sanitizeError(error);
      if (errors.length < 6 && clean !== 'Request stopped.') errors.push(clean);
    } finally {
      scanned += 1;
      if (scanned % 24 === 0 || scanned === total || found.size) {
        options.onProgress?.(scanned, total, found.size ? `${found.size} endpoint${found.size === 1 ? '' : 's'} found` : 'Scanning current Wi‑Fi…');
      }
    }
  });

  const stopped = !!options.signal?.aborted;
  const suffix = found.size ? `${found.size} AI endpoint${found.size === 1 ? '' : 's'} found.` : 'No AI services found on this Wi‑Fi scan.';
  return {
    endpoints: Array.from(found.values()),
    scanned,
    total,
    subnetPrefix,
    message: stopped ? `Scan stopped. ${suffix}` : suffix,
    errors,
    stopped
  };
}

export async function discoverManual(input: string, timeoutMs: number, token?: string): Promise<EndpointRecord | null> {
  const baseUrl = normalizeBaseUrl(input);
  if (!baseUrl) return null;
  return probeEndpoint(baseUrl, { timeoutMs, token });
}

export async function discoverManualSmart(input: string, timeoutMs: number, token?: string, fallbackPorts: number[] = [8080, 11434, 1234, 8000]): Promise<EndpointRecord | null> {
  const baseUrl = normalizeBaseUrl(input);
  if (!baseUrl) return null;

  if (hasExplicitPort(input)) {
    return probeEndpoint(baseUrl, { timeoutMs, token });
  }

  const candidates = buildPortCandidates(baseUrl, fallbackPorts);
  for (const candidate of candidates) {
    const endpoint = await probeEndpoint(candidate, { timeoutMs, token });
    if (endpoint) return endpoint;
  }

  return probeEndpoint(baseUrl, { timeoutMs, token });
}

async function runPool<T>(items: T[], concurrency: number, signal: AbortSignal | undefined, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length && !signal?.aborted) {
      const current = items[idx++];
      await worker(current);
    }
  });
  await Promise.all(workers);
}

function prioritizeHosts(hosts: string[], phoneIp: string): string[] {
  const preferred = new Set<string>();
  const prefix = hosts[0]?.split('.').slice(0, 3).join('.') || '';
  if (prefix) {
    for (const last of [1, 2, 10, 20, 50, 100, 101, 102, 150, 200, 254]) preferred.add(`${prefix}.${last}`);
  }
  const phoneLast = Number(String(phoneIp || '').split('.').pop());
  if (Number.isInteger(phoneLast) && prefix) {
    for (let i = phoneLast - 8; i <= phoneLast + 8; i++) if (i > 0 && i < 255) preferred.add(`${prefix}.${i}`);
  }
  const fast = hosts.filter(h => preferred.has(h));
  const rest = hosts.filter(h => !preferred.has(h));
  return [...fast, ...rest];
}

function hasExplicitPort(input: string): boolean {
  const baseUrl = normalizeBaseUrl(input);
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return !!url.port;
  } catch {
    return /:\d{2,5}(?:\/)?$/.test(String(input || '').trim());
  }
}

function buildPortCandidates(baseUrl: string, ports: number[]): string[] {
  try {
    const url = new URL(baseUrl);
    const uniquePorts = Array.from(new Set(ports.filter(p => p > 0 && p < 65536)));
    return uniquePorts.map(port => `${url.protocol}//${url.hostname}:${port}`);
  } catch {
    const host = hostFrom(baseUrl);
    return Array.from(new Set(ports)).map(port => `http://${host}:${port}`);
  }
}
