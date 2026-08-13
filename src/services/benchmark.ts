import { APP_READINESS_PROMPTS, STANDARD_PROMPTS } from '../constants/benchmarks';
import { AppReadinessResult, BenchmarkDetail, BenchmarkPrompt, BenchmarkResult, BenchmarkRunProgress, ConsultantVerdict, EndpointRecord, LocalityStatus, PrivacyRisk, RagReadinessResult } from '../types/domain';
import { makeId } from '../utils/id';
import { estimateTokens, sanitizeError, truncate } from '../utils/text';
import { classifyLocality, classifyPrivacyRisk, inspectEmbeddings, runStreamingChatCompletion } from './aiClient';

export interface BenchmarkRunOptions {
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: BenchmarkRunProgress) => void;
  mode?: 'quick' | 'standard' | 'consultant';
}

const DEFAULT_PROMPT_TIMEOUT_MS = 35000;

export async function runStandardBenchmark(endpoint: EndpointRecord, modelId: string, tokenOrOptions: string | BenchmarkRunOptions = ''): Promise<BenchmarkResult> {
  const options: BenchmarkRunOptions = typeof tokenOrOptions === 'string' ? { token: tokenOrOptions } : tokenOrOptions;
  const token = options.token || '';
  const timeoutMs = options.timeoutMs || DEFAULT_PROMPT_TIMEOUT_MS;
  const mode = options.mode || 'quick';
  const corePrompts = mode === 'quick' ? STANDARD_PROMPTS.slice(0, 1) : mode === 'standard' ? STANDARD_PROMPTS.slice(0, 3) : STANDARD_PROMPTS;
  const runAppReadiness = mode === 'consultant';
  const runRagReadiness = mode === 'consultant';
  const startedAt = Date.now();
  const details: BenchmarkDetail[] = [];
  const totalSteps = corePrompts.length + (runAppReadiness ? APP_READINESS_PROMPTS.length : 0) + (runRagReadiness ? 1 : 0);
  let step = 0;
  let estimatedTokens = 0;
  let jsonPassed = false;
  let streamingPassed = true;
  let canceled = false;
  let progressNote = '';

  const emit = (phase: BenchmarkRunProgress['phase'], message: string, promptTitle?: string) => {
    options.onProgress?.({ running: !['complete', 'canceled', 'error'].includes(phase), current: Math.min(step, totalSteps), total: totalSteps, phase, message, promptTitle });
  };

  emit('starting', mode === 'quick' ? 'Preparing one-prompt quick benchmark.' : mode === 'standard' ? 'Preparing three-prompt standard benchmark.' : 'Preparing consultant benchmark. Raw prompts and raw responses are not saved by default.');

  for (const prompt of corePrompts) {
    if (options.signal?.aborted) { canceled = true; progressNote = 'Benchmark canceled before all core prompts completed.'; break; }
    step += 1;
    emit('core', `Core prompt ${step}/${totalSteps}: ${prompt.title}`, prompt.title);
    const detail = await runPrompt(endpoint, modelId, prompt, token, { timeoutMs, signal: options.signal });
    if (detail.error === 'Benchmark canceled by user.') { canceled = true; progressNote = 'Benchmark canceled by user. Partial results were saved.'; break; }
    if (prompt.expects === 'json') jsonPassed = detail.ok;
    if (detail.streamOk === false) streamingPassed = false;
    estimatedTokens += detail.estimatedTokens;
    details.push(detail);
  }

  let appReadiness: AppReadinessResult = emptyAppReadiness(runAppReadiness ? 'Not run. Benchmark was canceled before app-readiness checks.' : 'Not run for this benchmark level. Use Consultant Benchmark for app-readiness checks.');
  let ragReadiness: RagReadinessResult = emptyRagReadiness(runRagReadiness ? 'Not run. Benchmark was canceled before PDF-lite check.' : 'Not run for this benchmark level. Use Consultant Benchmark for PDF-lite readiness.');

  if (!canceled && runAppReadiness) {
    const app = await runAppReadinessChecks(endpoint, modelId, token, {
      timeoutMs,
      signal: options.signal,
      onPromptStart: prompt => {
        step += 1;
        emit('app-readiness', `App-readiness ${step}/${totalSteps}: ${prompt.title}`, prompt.title);
      }
    });
    appReadiness = app.result;
    if (app.canceled) {
      canceled = true;
      progressNote = 'Benchmark canceled during app-readiness checks. Partial results were saved.';
    }
  }

  if (!canceled && runRagReadiness) {
    step += 1;
    emit('rag-lite', `PDF-lite ${step}/${totalSteps}: checking embeddings endpoint.`);
    ragReadiness = await inspectEmbeddings(endpoint, token);
  }

  const durationMs = Date.now() - startedAt;
  const successCount = details.filter(d => d.ok).length;
  const failureCount = details.length - successCount;
  const avgLatencyMs = average(details.map(d => d.durationMs));
  const ttfts = details.map(d => d.ttftMs).filter((v): v is number => typeof v === 'number');
  const outputSpeeds = details.map(d => d.outputTps).filter((v): v is number => typeof v === 'number');
  const avgTtftMs = average(ttfts);
  const avgOutputTps = averageFloat(outputSpeeds);
  const estimatedTps = durationMs > 0 ? Number((estimatedTokens / (durationMs / 1000)).toFixed(2)) : null;
  const locality = endpoint.locality || classifyLocality(endpoint.baseUrl);
  const privacyRisk = endpoint.privacyRisk || classifyPrivacyRisk(endpoint.baseUrl, endpoint.authMode);
  const verdict = canceled
    ? (successCount > 0 ? 'Partial' : 'Blocked')
    : classifyVerdict({ successCount, total: corePrompts.length, streamingPassed, avgTtftMs, avgOutputTps, locality, privacyRisk });
  const status: BenchmarkResult['status'] = canceled || failureCount > 0 || details.length < corePrompts.length ? (successCount > 0 ? 'warning' : 'failure') : 'success';

  const result: BenchmarkResult = {
    id: makeId('bench'),
    endpointId: endpoint.id,
    endpointName: endpoint.name,
    endpointUrl: endpoint.baseUrl,
    modelId,
    provider: endpoint.provider,
    engineKind: endpoint.kind,
    serviceFingerprint: endpoint.serviceFingerprint || `${endpoint.provider} / ${endpoint.kind}`,
    startedAt,
    durationMs,
    promptCount: corePrompts.length,
    successCount,
    failureCount,
    avgLatencyMs,
    estimatedTokens,
    estimatedTps,
    mode,
    avgTtftMs,
    avgOutputTps,
    avgTotalResponseMs: avgLatencyMs,
    streamingPassed,
    jsonPassed,
    appReadiness,
    ragReadiness,
    verdict,
    locality,
    privacyRisk,
    recommendation: canceled ? 'Benchmark was canceled. Review partial results, then rerun when the endpoint is idle and stable.' : recommendationFor(verdict, appReadiness, ragReadiness),
    metricQuality: {
      ttft: avgTtftMs == null ? 'unknown' : 'measured',
      outputTps: avgOutputTps == null ? 'unknown' : 'measured',
      totalResponse: avgLatencyMs == null ? 'unknown' : 'measured',
      completionTokens: details.some(d => d.completionTokensQuality === 'exact') ? 'exact' : details.length ? 'estimated' : 'unknown'
    },
    includeRawResponses: false,
    status,
    details,
    canceled,
    progressNote
  };

  emit(canceled ? 'canceled' : 'complete', canceled ? 'Benchmark stopped. Partial report saved.' : mode === 'quick' ? 'Quick benchmark complete. Local AI proof is ready.' : mode === 'standard' ? 'Standard benchmark complete.' : 'Consultant benchmark complete. Consultant report is ready.');
  return result;
}

async function runPrompt(endpoint: EndpointRecord, modelId: string, prompt: BenchmarkPrompt, token: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<BenchmarkDetail> {
  const promptStart = Date.now();
  try {
    if (options.signal?.aborted) throw new Error('Benchmark canceled by user.');
    const response = await runStreamingChatCompletion({ endpoint, modelId, prompt: prompt.prompt, token, timeoutMs: options.timeoutMs, signal: options.signal });
    const ok = scoreResponse(prompt, response.text);
    const promptTokens = estimateTokens(prompt.prompt);
    return {
      promptId: prompt.id,
      title: prompt.title,
      category: prompt.category,
      durationMs: Date.now() - promptStart,
      ok,
      promptTokens,
      promptTokensQuality: response.metricQuality.promptTokens === 'exact' ? 'exact' : 'estimated',
      completionTokens: response.completionTokens ?? response.estimatedTokens,
      completionTokensQuality: response.metricQuality.completionTokens,
      estimatedTokens: response.estimatedTokens,
      ttftMs: response.ttftMs,
      ttftQuality: response.metricQuality.ttftMs,
      outputTps: response.outputTps,
      outputTpsQuality: response.metricQuality.outputTps,
      streamOk: response.streamOk,
      stopReason: response.stopReason,
      responsePreview: truncate(response.text, 260),
      error: ok ? undefined : 'Response did not match expected shape.',
      rawSaved: false,
      streamNote: response.usedFallback ? `Streaming fallback used: ${response.stopReason || 'runtime did not expose a stream reader.'}` : undefined
    };
  } catch (error) {
    const message = sanitizeError(error);
    return {
      promptId: prompt.id,
      title: prompt.title,
      category: prompt.category,
      durationMs: Date.now() - promptStart,
      ok: false,
      estimatedTokens: 0,
      ttftMs: null,
      ttftQuality: 'unknown',
      outputTps: null,
      outputTpsQuality: 'unknown',
      streamOk: false,
      error: message,
      rawSaved: false,
      streamNote: message.includes('canceled') ? 'Benchmark canceled before this prompt completed.' : 'No usable streaming or fallback response was received.'
    };
  }
}

async function runAppReadinessChecks(endpoint: EndpointRecord, modelId: string, token: string, options: { timeoutMs: number; signal?: AbortSignal; onPromptStart?: (prompt: BenchmarkPrompt) => void }): Promise<{ result: AppReadinessResult; canceled: boolean }> {
  const notes: string[] = [];
  const statuses: AppReadinessResult = {
    jsonOutput: 'unknown',
    summarization: 'unknown',
    extraction: 'unknown',
    classification: 'unknown',
    longContext: 'unknown',
    score: 0,
    maxScore: 5,
    notes
  };

  for (const prompt of APP_READINESS_PROMPTS) {
    if (options.signal?.aborted) {
      notes.push('Canceled before all app-readiness prompts completed.');
      statuses.score = [statuses.jsonOutput, statuses.summarization, statuses.extraction, statuses.classification, statuses.longContext].filter(v => v === 'pass').length;
      return { result: statuses, canceled: true };
    }
    options.onPromptStart?.(prompt);
    const detail = await runPrompt(endpoint, modelId, prompt, token, { timeoutMs: options.timeoutMs, signal: options.signal });
    if (detail.error === 'Benchmark canceled by user.') {
      notes.push('Canceled during app-readiness checks.');
      statuses.score = [statuses.jsonOutput, statuses.summarization, statuses.extraction, statuses.classification, statuses.longContext].filter(v => v === 'pass').length;
      return { result: statuses, canceled: true };
    }
    const status = detail.ok ? 'pass' : 'fail';
    if (prompt.id === 'app-json') statuses.jsonOutput = status;
    if (prompt.id === 'app-summary') statuses.summarization = status;
    if (prompt.id === 'app-extraction') statuses.extraction = status;
    if (prompt.id === 'app-classification') statuses.classification = status;
    if (prompt.id === 'long-context-smoke') statuses.longContext = status;
    notes.push(`${prompt.title}: ${status}${detail.streamOk === false ? ' (non-streaming fallback or stream failure)' : ''}`);
  }
  statuses.score = [statuses.jsonOutput, statuses.summarization, statuses.extraction, statuses.classification, statuses.longContext].filter(v => v === 'pass').length;
  return { result: statuses, canceled: false };
}

function emptyAppReadiness(note: string): AppReadinessResult {
  return { jsonOutput: 'unknown', summarization: 'unknown', extraction: 'unknown', classification: 'unknown', longContext: 'unknown', score: 0, maxScore: 5, notes: [note] };
}

function emptyRagReadiness(note: string): RagReadinessResult {
  return { embeddingsEndpoint: 'unknown', localOnly: 'unknown', score: 0, maxScore: 4, notes: [note] };
}

function scoreResponse(prompt: BenchmarkPrompt, text: string): boolean {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  if (prompt.expects === 'json') return looksLikeJson(trimmed);
  if (prompt.expects === 'classification') return /^(setup|benchmark|report)\b/i.test(trimmed.replace(/["'`.:]/g, '').trim());
  if (prompt.category === 'instruction') return (trimmed.match(/(^|\n)\s*[-•*]/g) || []).length >= 3 || trimmed.split(/\n/).filter(Boolean).length >= 3;
  if (prompt.category === 'long-context') return /scan\s+the\s+qr/i.test(trimmed);
  return trimmed.length > 10;
}

function looksLikeJson(text: string): boolean {
  const trimmed = String(text || '').trim();
  try {
    JSON.parse(trimmed.replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
    return true;
  } catch {
    return false;
  }
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function averageFloat(values: number[]): number | null {
  if (!values.length) return null;
  return Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(2));
}

function classifyVerdict(args: { successCount: number; total: number; streamingPassed: boolean; avgTtftMs: number | null; avgOutputTps: number | null; locality: LocalityStatus; privacyRisk: PrivacyRisk }): ConsultantVerdict {
  if (args.successCount === 0) return 'Blocked';
  if (args.locality === 'Cloud/Public' || args.privacyRisk === 'High') return 'Not Recommended for This Use Case';
  if (args.successCount < args.total) return 'Partial';
  if (!args.streamingPassed) return 'Good for Demo';
  if ((args.avgTtftMs ?? 0) > 5000 || (args.avgOutputTps ?? 99) < 8) return 'Needs Tuning';
  return 'Ready';
}

function recommendationFor(verdict: ConsultantVerdict, app: AppReadinessResult, rag: { score: number; maxScore: number }): string {
  if (verdict === 'Ready' && rag.score >= 3) return 'Good for lightweight local AI demos and PDF testing. Run client-specific prompts before production use.';
  if (verdict === 'Ready') return 'Good for local chat/benchmark demos. Add or verify embeddings before PDF workflows.';
  if (verdict === 'Good for Demo') return 'Endpoint works, but streaming metrics were unavailable or fell back. Good for demo; confirm TTFT/TPS on the APK before client proof.';
  if (verdict === 'Needs Tuning') return 'Endpoint works, but speed is weak. Try a smaller model, lower context, or tune server settings.';
  if (verdict === 'Partial') return `Endpoint works partially. App readiness score is ${app.score}/${app.maxScore}; review failed tests before client use.`;
  if (verdict === 'Not Recommended for This Use Case') return 'Privacy/locality check is not acceptable for a local-first demo. Use a local LAN endpoint or add authentication.';
  return 'Fix reachability, model list, or chat errors before using this setup.';
}

export function quickScore(result: BenchmarkResult): string {
  if (result.verdict) return result.verdict;
  if (result.status === 'success') return 'Passed';
  if (result.status === 'warning') return 'Partial';
  return 'Failed';
}
