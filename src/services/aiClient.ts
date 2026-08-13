import { DEFAULT_PROBE_TIMEOUT_MS } from '../constants/discovery';
import { CapabilityProfile, EndpointRecord, LocalityStatus, MetricQuality, ModelInfo, PrivacyRisk, RagReadinessResult, ServiceKind } from '../types/domain';
import { makeId } from '../utils/id';
import { estimateTokens, hostFrom, normalizeBaseUrl, parseHostPort, sanitizeError, truncate } from '../utils/text';
import { fetchJson } from './http';
import { storage } from './storage';

type AnyJson = Record<string, any>;

const BASE_CAPABILITIES: CapabilityProfile = {
  chat: 'unknown',
  streaming: 'unknown',
  embeddings: 'unknown',
  jsonMode: 'unknown',
  vision: 'unknown',
  toolCalling: 'unknown',
  contextWindow: 'unknown'
};

export interface ProbeOptions {
  timeoutMs?: number;
  token?: string;
  name?: string;
  signal?: AbortSignal;
}

export interface ChatRequest {
  endpoint: EndpointRecord;
  modelId: string;
  prompt: string;
  timeoutMs?: number;
  token?: string;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  durationMs: number;
  estimatedTokens: number;
  estimatedTps: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  stopReason?: string;
  metricQuality?: {
    durationMs: MetricQuality;
    estimatedTokens: MetricQuality;
    estimatedTps: MetricQuality;
    promptTokens: MetricQuality;
    completionTokens: MetricQuality;
  };
}

export interface StreamingChatResponse extends ChatResponse {
  ttftMs: number | null;
  outputTps: number | null;
  streamOk: boolean;
  usedFallback: boolean;
  chunkCount: number;
  metricQuality: {
    ttftMs: MetricQuality;
    outputTps: MetricQuality;
    durationMs: MetricQuality;
    completionTokens: MetricQuality;
    promptTokens: MetricQuality;
    estimatedTokens: MetricQuality;
    estimatedTps: MetricQuality;
  };
}

export async function probeEndpoint(baseUrlRaw: string, options: ProbeOptions = {}): Promise<EndpointRecord | null> {
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  if (!baseUrl) return null;

  const timeoutMs = options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS;
  const auth = authHeaders(options.token);
  const requestBase = { timeoutMs, headers: auth, signal: options.signal };
  const evidence: string[] = [];

  const ollama = await fetchJson<AnyJson>(`${baseUrl}/api/tags`, requestBase);
  if (ollama.ok && Array.isArray(ollama.data?.models)) {
    evidence.push('/api/tags responded');
    return buildEndpoint({
      baseUrl,
      kind: 'ollama',
      provider: 'Ollama',
      name: options.name,
      models: modelsFromOllama(ollama.data),
      capabilities: { ...BASE_CAPABILITIES, chat: true, streaming: true, embeddings: 'unknown', jsonMode: 'unknown' },
      latencyMs: ollama.durationMs,
      evidence,
      fingerprintSource: ollama.data
    });
  }

  const openAi = await fetchJson<AnyJson>(`${baseUrl}/v1/models`, requestBase);
  if (openAi.ok && Array.isArray(openAi.data?.data)) {
    evidence.push('/v1/models responded');
    const guessedKind = guessOpenAiCompatibleKind(baseUrl, openAi.data);
    return buildEndpoint({
      baseUrl,
      kind: guessedKind.kind,
      provider: guessedKind.provider,
      name: options.name,
      models: modelsFromOpenAi(openAi.data),
      capabilities: { ...BASE_CAPABILITIES, chat: true, streaming: true, jsonMode: true },
      latencyMs: openAi.durationMs,
      evidence,
      fingerprintSource: openAi.data
    });
  }

  const health = await fetchJson<AnyJson>(`${baseUrl}/health`, { timeoutMs: Math.min(timeoutMs, 900), headers: auth, signal: options.signal });
  if (health.ok) {
    evidence.push('/health responded');
    const guessedKind = guessHealthKind(baseUrl, health.data, health.text);
    return buildEndpoint({
      baseUrl,
      kind: guessedKind.kind,
      provider: guessedKind.provider,
      name: options.name,
      models: [],
      capabilities: { ...BASE_CAPABILITIES, chat: true, streaming: 'unknown' },
      latencyMs: health.durationMs,
      evidence,
      status: 'warning',
      error: `${guessedKind.provider} is reachable, but model inventory was not exposed.`,
      fingerprintSource: health.data || { text: health.text }
    });
  }

  const root = await fetchJson<AnyJson>(`${baseUrl}/`, { timeoutMs: Math.min(timeoutMs, 900), headers: auth, signal: options.signal });
  if (root.ok && looksLikeOpenWebUi(root.text || '')) {
    evidence.push('/ responded like Open WebUI');
    return buildEndpoint({
      baseUrl,
      kind: 'open-webui',
      provider: 'Open WebUI',
      name: options.name,
      models: [],
      capabilities: { ...BASE_CAPABILITIES, chat: 'unknown' },
      latencyMs: root.durationMs,
      evidence,
      status: 'warning',
      error: 'Open WebUI detected, but model API was not available without credentials.',
      fingerprintSource: { text: root.text }
    });
  }

  return null;
}

export async function refreshEndpoint(endpoint: EndpointRecord): Promise<EndpointRecord> {
  const token = endpoint.authMode === 'bearer' ? await storage.getBearerToken(endpoint.id) : '';
  const fresh = await probeEndpoint(endpoint.baseUrl, { token, timeoutMs: 2200 });
  if (!fresh) {
    return {
      ...endpoint,
      status: 'offline',
      lastCheckedAt: Date.now(),
      error: 'Endpoint was not reachable during the last check.'
    };
  }
  return {
    ...endpoint,
    ...fresh,
    id: endpoint.id,
    name: endpoint.name || fresh.name,
    favorite: endpoint.favorite,
    notes: endpoint.notes,
    authMode: endpoint.authMode,
    lastCheckedAt: Date.now()
  };
}

export async function runChatCompletion(request: ChatRequest): Promise<ChatResponse> {
  const timeoutMs = request.timeoutMs || 45000;
  const start = Date.now();
  const endpoint = request.endpoint;
  const headers = authHeaders(request.token);

  if (endpoint.kind === 'ollama') {
    const response = await fetchJson<AnyJson>(`${endpoint.baseUrl}/api/chat`, {
      timeoutMs,
      method: 'POST',
      headers,
      signal: request.signal,
      body: {
        model: request.modelId,
        messages: [{ role: 'user', content: request.prompt }],
        stream: false
      }
    });
    if (!response.ok) throw new Error(response.error || `Ollama returned ${response.status}`);
    const text = String(response.data?.message?.content || response.data?.response || '').trim();
    if (!text) throw new Error('Model returned an empty response.');
    const promptTokens = numericOrNull(response.data?.prompt_eval_count);
    const completionTokens = numericOrNull(response.data?.eval_count) ?? estimateTokens(text);
    return metricsResponse(text, Date.now() - start, promptTokens, completionTokens, response.data?.done_reason || response.data?.stop_reason);
  }

  const response = await fetchJson<AnyJson>(`${endpoint.baseUrl}/v1/chat/completions`, {
    timeoutMs,
    method: 'POST',
    headers,
    signal: request.signal,
    body: {
      model: request.modelId,
      messages: [{ role: 'user', content: request.prompt }],
      stream: false,
      temperature: 0.2
    }
  });

  if (!response.ok) throw new Error(response.error || `API returned ${response.status}`);
  const text = String(response.data?.choices?.[0]?.message?.content || response.data?.choices?.[0]?.text || '').trim();
  if (!text) throw new Error('Model returned an empty response.');
  const usage = response.data?.usage || {};
  const promptTokens = numericOrNull(usage.prompt_tokens);
  const completionTokens = numericOrNull(usage.completion_tokens) ?? estimateTokens(text);
  return metricsResponse(text, Date.now() - start, promptTokens, completionTokens, response.data?.choices?.[0]?.finish_reason);
}

export async function runStreamingChatCompletion(request: ChatRequest): Promise<StreamingChatResponse> {
  const timeoutMs = request.timeoutMs || 60000;
  const endpoint = request.endpoint;
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const abortFromCaller = () => ctrl.abort();
  if (request.signal?.aborted) ctrl.abort();
  else request.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let ttftMs: number | null = null;
  let chunkCount = 0;
  let text = '';
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let stopReason = '';

  try {
    const isOllama = endpoint.kind === 'ollama';
    const url = isOllama ? `${endpoint.baseUrl}/api/chat` : `${endpoint.baseUrl}/v1/chat/completions`;
    const body = isOllama
      ? { model: request.modelId, messages: [{ role: 'user', content: request.prompt }], stream: true }
      : { model: request.modelId, messages: [{ role: 'user', content: request.prompt }], stream: true, temperature: 0.2 };
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Accept: isOllama ? 'application/x-ndjson,application/json,text/plain' : 'text/event-stream,application/json,text/plain',
        'Content-Type': 'application/json',
        ...authHeaders(request.token)
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Streaming request returned HTTP ${res.status}`);
    if (!res.body || typeof (res.body as any).getReader !== 'function') throw new Error('Streaming reader is not available in this runtime.');

    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      if (request.signal?.aborted) throw new Error('Benchmark canceled by user.');
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;
      buffer += chunk;
      const parsed = parseStreamBuffer(buffer, isOllama);
      buffer = parsed.remainder;
      for (const item of parsed.items) {
        const delta = isOllama ? ollamaDelta(item) : openAiDelta(item);
        if (delta.text) {
          if (ttftMs == null) ttftMs = Date.now() - startedAt;
          chunkCount += 1;
          text += delta.text;
        }
        if (delta.promptTokens != null) promptTokens = delta.promptTokens;
        if (delta.completionTokens != null) completionTokens = delta.completionTokens;
        if (delta.stopReason) stopReason = delta.stopReason;
      }
    }

    if (buffer.trim()) {
      const parsed = parseStreamBuffer(`${buffer}\n`, isOllama);
      for (const item of parsed.items) {
        const delta = isOllama ? ollamaDelta(item) : openAiDelta(item);
        if (delta.text) {
          if (ttftMs == null) ttftMs = Date.now() - startedAt;
          chunkCount += 1;
          text += delta.text;
        }
        if (delta.promptTokens != null) promptTokens = delta.promptTokens;
        if (delta.completionTokens != null) completionTokens = delta.completionTokens;
        if (delta.stopReason) stopReason = delta.stopReason;
      }
    }

    if (!text.trim()) throw new Error('Streaming finished without text.');
    const durationMs = Date.now() - startedAt;
    const estimatedCompletion = completionTokens ?? estimateTokens(text);
    const secondsAfterFirstToken = Math.max(0.001, (durationMs - (ttftMs ?? 0)) / 1000);
    const outputTps = Number((estimatedCompletion / secondsAfterFirstToken).toFixed(2));
    return {
      text: truncate(text, 12000),
      durationMs,
      estimatedTokens: estimatedCompletion,
      estimatedTps: outputTps,
      promptTokens,
      completionTokens: estimatedCompletion,
      stopReason,
      ttftMs,
      outputTps,
      streamOk: true,
      usedFallback: false,
      chunkCount,
      metricQuality: {
        ttftMs: 'measured',
        outputTps: completionTokens != null ? 'measured' : 'estimated',
        durationMs: 'measured',
        completionTokens: completionTokens != null ? 'exact' : 'estimated',
        promptTokens: promptTokens != null ? 'exact' : 'estimated',
        estimatedTokens: completionTokens != null ? 'exact' : 'estimated',
        estimatedTps: completionTokens != null ? 'measured' : 'estimated'
      }
    };
  } catch (error) {
    if (request.signal?.aborted) throw new Error('Benchmark canceled by user.');
    const fallback = await runChatCompletion(request);
    const durationMs = Date.now() - startedAt;
    return {
      ...fallback,
      durationMs,
      ttftMs: null,
      outputTps: fallback.estimatedTps,
      streamOk: false,
      usedFallback: true,
      chunkCount: 0,
      stopReason: fallback.stopReason || `stream fallback: ${sanitizeError(error)}`,
      metricQuality: {
        ttftMs: 'unknown',
        outputTps: fallback.metricQuality?.estimatedTps || 'estimated',
        durationMs: 'measured',
        completionTokens: fallback.metricQuality?.completionTokens || 'estimated',
        promptTokens: fallback.metricQuality?.promptTokens || 'estimated',
        estimatedTokens: fallback.metricQuality?.estimatedTokens || 'estimated',
        estimatedTps: fallback.metricQuality?.estimatedTps || 'estimated'
      }
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function testEmbeddings(endpoint: EndpointRecord, token = ''): Promise<boolean | 'unknown'> {
  const result = await inspectEmbeddings(endpoint, token);
  if (result.embeddingsEndpoint === 'unknown') return 'unknown';
  return result.embeddingsEndpoint === 'pass';
}

export async function inspectEmbeddings(endpoint: EndpointRecord, token = ''): Promise<RagReadinessResult> {
  const startedAt = Date.now();
  const localOnly = classifyLocality(endpoint.baseUrl) === 'Local LAN' ? 'pass' : classifyLocality(endpoint.baseUrl) === 'Cloud/Public' ? 'fail' : 'unknown';
  const model = endpoint.models[0]?.id;
  if (!model) {
    return { embeddingsEndpoint: 'unknown', localOnly, score: localOnly === 'pass' ? 1 : 0, maxScore: 4, notes: ['No model ID is available to test embeddings.'] };
  }
  const headers = authHeaders(token);
  try {
    if (endpoint.kind === 'ollama') {
      const res = await fetchJson<AnyJson>(`${endpoint.baseUrl}/api/embeddings`, {
        timeoutMs: 7000,
        method: 'POST',
        headers,
        body: { model, prompt: 'LLM Radar local PDF readiness check.' }
      });
      const vector = Array.isArray(res.data?.embedding) ? res.data.embedding : [];
      const pass = res.ok && vector.length > 0;
      return ragResult(pass, Date.now() - startedAt, vector.length || null, localOnly);
    }
    const res = await fetchJson<AnyJson>(`${endpoint.baseUrl}/v1/embeddings`, {
      timeoutMs: 7000,
      method: 'POST',
      headers,
      body: { model, input: 'LLM Radar local PDF readiness check.' }
    });
    const vector = Array.isArray(res.data?.data?.[0]?.embedding) ? res.data.data[0].embedding : [];
    const pass = res.ok && vector.length > 0;
    return ragResult(pass, Date.now() - startedAt, vector.length || null, localOnly);
  } catch (error) {
    return { embeddingsEndpoint: 'fail', embeddingLatencyMs: Date.now() - startedAt, vectorDimension: null, localOnly, score: localOnly === 'pass' ? 1 : 0, maxScore: 4, notes: [`Embeddings test failed: ${sanitizeError(error)}`] };
  }
}

function ragResult(pass: boolean, latencyMs: number, dimension: number | null, localOnly: RagReadinessResult['localOnly']): RagReadinessResult {
  const score = (pass ? 2 : 0) + (dimension ? 1 : 0) + (localOnly === 'pass' ? 1 : 0);
  const notes = [
    pass ? 'Embeddings endpoint returned a vector.' : 'Embeddings endpoint did not return a usable vector.',
    dimension ? `Vector dimension: ${dimension}.` : 'Vector dimension unknown.',
    localOnly === 'pass' ? 'Endpoint appears local/private LAN.' : 'Locality is not confirmed.'
  ];
  return { embeddingsEndpoint: pass ? 'pass' : 'fail', embeddingLatencyMs: latencyMs, vectorDimension: dimension, localOnly, score, maxScore: 4, notes };
}

function buildEndpoint(args: {
  baseUrl: string;
  kind: ServiceKind;
  provider: string;
  name?: string;
  models: ModelInfo[];
  capabilities: CapabilityProfile;
  latencyMs?: number | null;
  evidence?: string[];
  status?: EndpointRecord['status'];
  error?: string;
  fingerprintSource?: AnyJson;
}): EndpointRecord {
  const parsed = parseHostPort(args.baseUrl);
  const host = hostFrom(args.baseUrl);
  const locality = classifyLocality(args.baseUrl);
  return {
    id: makeId('endpoint'),
    name: args.name || labelFromHost(host, args.provider),
    baseUrl: args.baseUrl,
    host,
    ip: parsed.ip,
    port: parsed.port,
    kind: args.kind,
    provider: args.provider,
    serviceFingerprint: buildFingerprint(args.kind, args.provider, args.baseUrl, args.fingerprintSource),
    status: args.status || (args.models.length ? 'healthy' : 'warning'),
    models: args.models,
    capabilities: { ...args.capabilities, inspectedAt: Date.now() },
    lastSeenAt: Date.now(),
    lastCheckedAt: Date.now(),
    latencyMs: args.latencyMs ?? null,
    latencyQuality: args.latencyMs == null ? 'unknown' : 'measured',
    locality,
    privacyRisk: classifyPrivacyRisk(args.baseUrl, 'none'),
    authMode: 'none',
    evidence: args.evidence || [],
    error: args.error
  };
}

function modelsFromOllama(data: AnyJson): ModelInfo[] {
  return (data.models || []).map((model: AnyJson) => ({
    id: String(model.name || model.model || 'unknown'),
    name: String(model.name || model.model || 'unknown'),
    size: model.size ? `${Math.round(Number(model.size) / 1024 / 1024 / 1024)} GB` : undefined,
    modifiedAt: model.modified_at,
    raw: slimRaw(model)
  })).filter((m: ModelInfo) => m.id && m.id !== 'unknown');
}

function modelsFromOpenAi(data: AnyJson): ModelInfo[] {
  return (data.data || []).map((model: AnyJson) => ({
    id: String(model.id || model.name || 'unknown'),
    name: String(model.id || model.name || 'unknown'),
    raw: slimRaw(model)
  })).filter((m: ModelInfo) => m.id && m.id !== 'unknown');
}

function slimRaw(value: AnyJson): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of ['name', 'model', 'id', 'modified_at', 'size', 'owned_by', 'object', 'created']) {
    if (value?.[key] != null) raw[key] = value[key];
  }
  return raw;
}

function guessOpenAiCompatibleKind(baseUrl: string, data: AnyJson): { kind: ServiceKind; provider: string } {
  const blob = `${baseUrl} ${JSON.stringify(data).slice(0, 1000)}`.toLowerCase();
  if (blob.includes('lm studio') || baseUrl.includes(':1234')) return { kind: 'lm-studio', provider: 'LM Studio' };
  if (blob.includes('localai') || blob.includes('local-ai')) return { kind: 'localai', provider: 'LocalAI' };
  if (blob.includes('llama') || baseUrl.includes(':8080')) return { kind: 'llama-server', provider: 'llama-server / OpenAI-compatible' };
  return { kind: 'openai-compatible', provider: 'OpenAI-compatible' };
}

function guessHealthKind(baseUrl: string, data?: AnyJson, text?: string): { kind: ServiceKind; provider: string } {
  const blob = `${baseUrl} ${text || ''} ${JSON.stringify(data || {}).slice(0, 500)}`.toLowerCase();
  if (blob.includes('localai') || blob.includes('local-ai')) return { kind: 'localai', provider: 'LocalAI' };
  if (baseUrl.includes(':8080') || blob.includes('llama')) return { kind: 'llama-server', provider: 'llama-server' };
  return { kind: 'openai-compatible', provider: 'OpenAI-compatible' };
}

function looksLikeOpenWebUi(text: string): boolean {
  const lower = String(text || '').toLowerCase();
  return lower.includes('open webui') || lower.includes('open-webui') || lower.includes('ollama webui');
}

function labelFromHost(host: string, provider: string): string {
  return `${provider} · ${host}`;
}

function authHeaders(token?: string): Record<string, string> {
  const clean = String(token || '').trim();
  return clean ? { Authorization: `Bearer ${clean}` } : {};
}

function metricsResponse(text: string, durationMs: number, promptTokens?: number | null, completionTokens?: number | null, stopReason?: string): ChatResponse {
  const estimated = completionTokens ?? estimateTokens(text);
  return {
    text: truncate(text, 12000),
    durationMs,
    estimatedTokens: estimated,
    estimatedTps: durationMs > 0 ? Number((estimated / (durationMs / 1000)).toFixed(2)) : null,
    promptTokens: promptTokens ?? null,
    completionTokens: completionTokens ?? estimated,
    totalTokens: promptTokens != null ? promptTokens + estimated : null,
    stopReason,
    metricQuality: {
      durationMs: 'measured',
      estimatedTokens: completionTokens != null ? 'exact' : 'estimated',
      estimatedTps: completionTokens != null ? 'measured' : 'estimated',
      promptTokens: promptTokens != null ? 'exact' : 'unknown',
      completionTokens: completionTokens != null ? 'exact' : 'estimated'
    }
  };
}

function parseStreamBuffer(buffer: string, ollama: boolean): { items: AnyJson[]; remainder: string } {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() || '';
  const items: AnyJson[] = [];
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;
    if (!ollama) {
      if (!line.startsWith('data:')) continue;
      line = line.replace(/^data:\s*/, '').trim();
      if (line === '[DONE]') continue;
    }
    try { items.push(JSON.parse(line)); } catch { /* ignore partial/non-json stream lines */ }
  }
  return { items, remainder };
}

function ollamaDelta(item: AnyJson): { text: string; promptTokens?: number; completionTokens?: number; stopReason?: string } {
  return {
    text: String(item?.message?.content || item?.response || ''),
    promptTokens: numericOrUndefined(item?.prompt_eval_count),
    completionTokens: numericOrUndefined(item?.eval_count),
    stopReason: item?.done_reason || item?.stop_reason || (item?.done ? 'done' : '')
  };
}

function openAiDelta(item: AnyJson): { text: string; promptTokens?: number; completionTokens?: number; stopReason?: string } {
  const choice = item?.choices?.[0] || {};
  const usage = item?.usage || {};
  return {
    text: String(choice?.delta?.content || choice?.message?.content || choice?.text || ''),
    promptTokens: numericOrUndefined(usage?.prompt_tokens),
    completionTokens: numericOrUndefined(usage?.completion_tokens),
    stopReason: choice?.finish_reason || ''
  };
}

function numericOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function numericOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function buildFingerprint(kind: ServiceKind, provider: string, baseUrl: string, source?: AnyJson): string {
  const modelIds = Array.isArray(source?.models) ? source.models.map((m: AnyJson) => m.name || m.model).filter(Boolean).slice(0, 4).join('|') : Array.isArray(source?.data) ? source.data.map((m: AnyJson) => m.id).filter(Boolean).slice(0, 4).join('|') : '';
  return [provider, kind, hostFrom(baseUrl), modelIds].filter(Boolean).join(' / ');
}

export function classifyLocality(baseUrl: string): LocalityStatus {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return 'Unknown';
    if (host.startsWith('192.168.') || host.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'Local LAN';
    if (host.endsWith('.local') || host.endsWith('.lan')) return 'Local LAN';
    return 'Cloud/Public';
  } catch {
    return 'Unknown';
  }
}

export function classifyPrivacyRisk(baseUrl: string, authMode?: EndpointRecord['authMode']): PrivacyRisk {
  const locality = classifyLocality(baseUrl);
  if (locality === 'Cloud/Public') return 'High';
  if (locality === 'Unknown') return 'Medium';
  return authMode === 'bearer' ? 'Low' : 'Medium';
}

export function explainEndpoint(endpoint: EndpointRecord): string {
  if (endpoint.status === 'healthy') return `${endpoint.provider} is reachable with ${endpoint.models.length} model${endpoint.models.length === 1 ? '' : 's'}.`;
  if (endpoint.status === 'warning') return endpoint.error || `${endpoint.provider} is reachable, but not fully ready.`;
  if (endpoint.status === 'offline') return 'Endpoint is currently offline or blocked by the network.';
  return 'Endpoint has not been checked yet.';
}

export function inspectRequest(endpoint: EndpointRecord, modelId: string, prompt: string): string {
  const isOllama = endpoint.kind === 'ollama';
  const url = isOllama ? `${endpoint.baseUrl}/api/chat` : `${endpoint.baseUrl}/v1/chat/completions`;
  const body = isOllama
    ? { model: modelId, messages: [{ role: 'user', content: prompt }], stream: false }
    : { model: modelId, messages: [{ role: 'user', content: prompt }], stream: false, temperature: 0.2 };
  return JSON.stringify({ method: 'POST', url, body: { ...body, messages: [{ role: 'user', content: '[prompt hidden]' }] } }, null, 2);
}

export function sanitizeModelId(modelId?: string): string {
  return String(modelId || '').trim().slice(0, 160);
}
