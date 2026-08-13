import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { AppSettings, BenchmarkResult, ConsultantReport, EndpointRecord, ReportComparison } from '../types/domain';
import { toCsv } from '../utils/csv';
import { formatDuration } from '../utils/text';

const APP_VERSION = '0.5.0h';

export function buildReport(endpoints: EndpointRecord[], benchmarks: BenchmarkResult[], settings: AppSettings): ConsultantReport {
  const latest = benchmarks[0];
  const endpoint = latest ? endpoints.find(e => e.id === latest.endpointId) || endpoints[0] : endpoints[0];
  const comparison = compareReports(benchmarks[0], benchmarks[1]);
  const warnings = buildWarnings(endpoint, latest);
  const topMetrics = {
    overallVerdict: latest?.verdict || (endpoint?.status === 'healthy' ? 'Good for Demo' : 'Blocked'),
    model: latest?.modelId || endpoint?.models?.[0]?.id || 'Unknown',
    engine: latest?.provider || endpoint?.provider || 'Unknown',
    endpoint: latest?.locality || endpoint?.locality || 'Unknown',
    reachability: endpoint?.status === 'healthy' ? 'Pass' as const : endpoint?.status === 'offline' ? 'Fail' as const : 'Unknown' as const,
    chatTest: latest ? (latest.successCount > 0 ? 'Pass' as const : 'Fail' as const) : 'Unknown' as const,
    streaming: latest ? (latest.streamingPassed ? 'Pass' as const : 'Fail' as const) : 'Unknown' as const,
    avgTtft: latest?.avgTtftMs == null ? 'Unknown' : `${(latest.avgTtftMs / 1000).toFixed(2)}s measured`,
    avgOutputSpeed: latest?.avgOutputTps == null ? 'Unknown' : `${latest.avgOutputTps} tok/s ${latest.metricQuality?.outputTps || 'measured'}`,
    avgTotalResponse: latest?.avgTotalResponseMs == null ? 'Unknown' : `${(latest.avgTotalResponseMs / 1000).toFixed(1)}s measured`,
    successRate: latest ? `${latest.successCount}/${latest.promptCount} (${Math.round((latest.successCount / Math.max(1, latest.promptCount)) * 100)}%)` : 'Unknown',
    privacyStatus: `${latest?.locality || endpoint?.locality || 'Unknown'} / ${latest?.privacyRisk || endpoint?.privacyRisk || 'Unknown'} exposure risk`,
    recommendation: latest?.recommendation || 'Run a benchmark to produce a consultant-ready recommendation.'
  };

  return {
    generatedAt: Date.now(),
    appName: 'LLM Radar',
    appVersion: APP_VERSION,
    executiveSummary: buildExecutiveSummary(endpoint, latest, topMetrics.recommendation),
    topMetrics,
    endpoint,
    latestBenchmark: latest,
    comparison,
    endpoints,
    benchmarks,
    settingsSummary: {
      demoMode: settings.demoMode,
      privacyReview: settings.privacyReview,
      ports: settings.ports
    },
    warnings
  };
}

export function buildExecutiveSummary(endpoint?: EndpointRecord, latest?: BenchmarkResult, recommendation?: string): string {
  if (!endpoint && !latest) return 'LLM Radar has not tested a local AI endpoint yet. Run EZ Connect and a standard benchmark to create a consultant-ready report.';
  const model = latest?.modelId || endpoint?.models?.[0]?.id || 'unknown model';
  const engine = latest?.provider || endpoint?.provider || 'unknown engine';
  const url = latest?.endpointUrl || endpoint?.baseUrl || 'unknown endpoint';
  const verdict = latest?.verdict || (endpoint?.status === 'healthy' ? 'Good for Demo' : 'Blocked');
  const ttft = latest?.avgTtftMs == null ? 'unknown TTFT' : `${(latest.avgTtftMs / 1000).toFixed(2)}s average TTFT`;
  const tps = latest?.avgOutputTps == null ? 'unknown output speed' : `${latest.avgOutputTps} tokens/sec average output`;
  const locality = latest?.locality || endpoint?.locality || 'Unknown locality';
  return `LLM Radar tested ${url} running ${model} on ${engine}. Verdict: ${verdict}. The setup reported ${ttft}, ${tps}, and ${latest ? `${latest.successCount}/${latest.promptCount} benchmark prompts passed` : 'no benchmark run yet'}. LLM Radar classified the endpoint as ${locality}. Recommended next step: ${recommendation || 'run the standard benchmark and review the privacy/locality summary.'}`;
}

export function buildConsultantSummary(report: ConsultantReport): string {
  const t = report.topMetrics;
  return `LLM Radar confirmed ${t.engine} using ${t.model}. Verdict: ${t.overallVerdict}. Reachability: ${t.reachability}; chat: ${t.chatTest}; streaming: ${t.streaming}; avg TTFT: ${t.avgTtft}; avg output: ${t.avgOutputSpeed}; success: ${t.successRate}. Privacy/locality: ${t.privacyStatus}. Recommendation: ${t.recommendation}`;
}

export function buildMarkdownReport(report: ConsultantReport): string {
  const t = report.topMetrics;
  const latest = report.latestBenchmark;
  const lines: string[] = [];
  lines.push(`# LLM Radar Consultant Report`);
  lines.push('');
  lines.push(`Generated: ${new Date(report.generatedAt).toLocaleString()}`);
  lines.push(`App version: ${report.appVersion}`);
  lines.push('');
  lines.push(`## 1. Executive Summary`);
  lines.push(report.executiveSummary);
  lines.push('');
  lines.push(`## 2. Top Metrics Card`);
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Overall Verdict | ${t.overallVerdict} |`);
  lines.push(`| Model | ${t.model} |`);
  lines.push(`| Engine | ${t.engine} |`);
  lines.push(`| Endpoint | ${t.endpoint} |`);
  lines.push(`| Reachability | ${t.reachability} |`);
  lines.push(`| Chat Test | ${t.chatTest} |`);
  lines.push(`| Streaming | ${t.streaming} |`);
  lines.push(`| Avg TTFT | ${t.avgTtft} |`);
  lines.push(`| Avg Output Speed | ${t.avgOutputSpeed} |`);
  lines.push(`| Avg Total Response | ${t.avgTotalResponse} |`);
  lines.push(`| Test Success Rate | ${t.successRate} |`);
  lines.push(`| Privacy Status | ${t.privacyStatus} |`);
  lines.push(`| Recommendation | ${t.recommendation} |`);
  lines.push('');
  lines.push(`## 3. Verdict and Recommendation`);
  lines.push(`${t.overallVerdict}: ${t.recommendation}`);
  lines.push('');
  lines.push(`## 4. Model + Engine Tested`);
  lines.push(`- Endpoint URL: ${report.endpoint?.baseUrl || latest?.endpointUrl || 'Unknown'}`);
  lines.push(`- Engine/provider: ${t.engine}`);
  lines.push(`- Engine kind: ${report.endpoint?.kind || latest?.engineKind || 'Unknown'}`);
  lines.push(`- Service fingerprint: ${report.endpoint?.serviceFingerprint || latest?.serviceFingerprint || 'Unknown'}`);
  lines.push(`- Computer URL: ${report.endpoint?.helperUrl || 'Unknown'}`);
  lines.push(`- Phone Access version: ${report.endpoint?.helperVersion || 'Unknown'}`);
  lines.push(`- Phone Access port: ${report.endpoint?.helperPort || 'Unknown'}`);
  lines.push(`- AI port: ${report.endpoint?.aiPort || report.endpoint?.port || 'Unknown'}`);
  lines.push(`- Model: ${t.model}`);
  lines.push('');
  lines.push(`## 5. Performance Results`);
  if (latest) {
    for (const d of latest.details) {
      lines.push(`- ${d.title}: ${d.ok ? 'PASS' : 'FAIL'}; TTFT ${d.ttftMs == null ? 'unknown' : `${d.ttftMs}ms ${d.ttftQuality || ''}`}; output ${d.outputTps == null ? 'unknown' : `${d.outputTps} tok/s ${d.outputTpsQuality || ''}`}; total ${formatDuration(d.durationMs)}.`);
    }
  } else {
    lines.push('- No benchmark run yet.');
  }
  lines.push('');
  lines.push(`## 6. Health Checks`);
  lines.push(`- Reachability: ${t.reachability}`);
  lines.push(`- Chat: ${t.chatTest}`);
  lines.push(`- Streaming: ${t.streaming}`);
  lines.push(`- JSON output: ${latest?.jsonPassed == null ? 'Unknown' : latest.jsonPassed ? 'Pass' : 'Fail'}`);
  lines.push(`- App readiness: ${latest?.appReadiness ? `${latest.appReadiness.score}/${latest.appReadiness.maxScore}` : 'Unknown'}`);
  lines.push(`- PDF readiness: ${latest?.ragReadiness ? `${latest.ragReadiness.score}/${latest.ragReadiness.maxScore}` : 'Unknown'}`);
  lines.push('');
  lines.push(`## 7. Privacy / Locality Review`);
  lines.push(`- Locality: ${t.endpoint}`);
  lines.push(`- Risk: ${t.privacyStatus}`);
  lines.push(`- Raw prompts/responses: excluded by default.`);
  lines.push(`- Warning: this report may include local IP addresses and port numbers.`);
  for (const warning of report.warnings) lines.push(`- ${warning}`);
  lines.push('');
  lines.push(`## 8. Share / Invite Options`);
  lines.push(`Use Share Report for safe external sharing. Use LAN Invite only for trusted people on the same Wi-Fi.`);
  lines.push('');
  lines.push(`## 9. Technical Details`);
  lines.push(`- Benchmarks stored: ${report.benchmarks.length}`);
  lines.push(`- Endpoints stored: ${report.endpoints.length}`);
  if (report.comparison?.available) lines.push(`- Comparison: ${report.comparison.summary}`);
  lines.push('');
  lines.push(`## 10. Raw JSON / Advanced Export`);
  lines.push('Raw JSON is available through the JSON export. It is intentionally last, not first.');
  return lines.join('\n');
}

export function buildLanInvitePayload(endpoint: EndpointRecord): Record<string, unknown> {
  const model = endpoint.models?.[0]?.id || 'selected model';
  return {
    type: 'llm-radar-lan-invite',
    version: 1,
    endpointUrl: endpoint.baseUrl,
    baseUrl: endpoint.baseUrl,
    helperUrl: endpoint.helperUrl,
    helperVersion: endpoint.helperVersion,
    helperPort: endpoint.helperPort,
    aiPort: endpoint.aiPort || endpoint.port,
    service: endpoint.kind,
    serviceHint: endpoint.kind,
    provider: endpoint.provider,
    modelName: model,
    laptopName: endpoint.laptopName,
    laptopIp: endpoint.laptopIp || endpoint.ip,
    locality: endpoint.locality || 'Unknown',
    warning: 'This shares the local AI endpoint URL. Anyone on this Wi-Fi with the URL may be able to use the server if no password is configured.',
    createdAt: new Date().toISOString()
  };
}

export function buildLanInvite(endpoint?: EndpointRecord): string {
  if (!endpoint) return 'LLM Radar LAN Invite unavailable: no endpoint is saved yet.';
  const payload = buildLanInvitePayload(endpoint);
  return [
    'LLM Radar LAN Invite',
    '',
    `Endpoint: ${endpoint.baseUrl}`,
    `Computer URL: ${endpoint.helperUrl || 'No computer URL saved'}`,
    `Service: ${endpoint.provider}`,
    `Model: ${endpoint.models?.[0]?.id || 'selected model'}`,
    `Locality: ${endpoint.locality || 'Unknown'}`,
    '',
    'Warning: This shares the local AI endpoint URL. Anyone on this Wi-Fi with the URL may be able to use the server if no password is configured.',
    '',
    `QR/manual payload: ${JSON.stringify(payload)}`
  ].join('\n');
}

export function compareReports(current?: BenchmarkResult, previous?: BenchmarkResult): ReportComparison {
  if (!current || !previous) return { available: false, summary: 'Need two saved benchmark reports to compare.' };
  const successRate = (r: BenchmarkResult) => r.successCount / Math.max(1, r.promptCount);
  const ttftDeltaMs = current.avgTtftMs != null && previous.avgTtftMs != null ? current.avgTtftMs - previous.avgTtftMs : null;
  const outputTpsDelta = current.avgOutputTps != null && previous.avgOutputTps != null ? Number((current.avgOutputTps - previous.avgOutputTps).toFixed(2)) : null;
  const successRateDelta = Number(((successRate(current) - successRate(previous)) * 100).toFixed(1));
  const modelChanged = current.modelId !== previous.modelId;
  const engineChanged = current.engineKind !== previous.engineKind || current.provider !== previous.provider;
  const endpointChanged = current.endpointUrl !== previous.endpointUrl;
  const parts = [
    ttftDeltaMs == null ? 'TTFT delta unknown' : `TTFT ${ttftDeltaMs <= 0 ? 'improved' : 'slower'} by ${Math.abs(ttftDeltaMs)}ms`,
    outputTpsDelta == null ? 'TPS delta unknown' : `TPS ${outputTpsDelta >= 0 ? 'improved' : 'dropped'} by ${Math.abs(outputTpsDelta)}`,
    `success rate ${successRateDelta >= 0 ? 'changed +' : 'changed '}${successRateDelta}%`,
    modelChanged ? 'model changed' : 'same model',
    engineChanged ? 'engine changed' : 'same engine',
    endpointChanged ? 'endpoint changed' : 'same endpoint'
  ];
  return { available: true, currentId: current.id, previousId: previous.id, ttftDeltaMs, outputTpsDelta, successRateDelta, modelChanged, engineChanged, endpointChanged, summary: parts.join('; ') };
}

function buildWarnings(endpoint?: EndpointRecord, latest?: BenchmarkResult): string[] {
  const warnings: string[] = ['This report includes local network details such as IP address and port numbers. It does not include chat history unless you choose to include it.'];
  if (endpoint?.authMode === 'none') warnings.push('No authentication was detected. Anyone on the same Wi-Fi may be able to use this endpoint if they know the URL.');
  if ((latest?.locality || endpoint?.locality) !== 'Local LAN') warnings.push('Endpoint locality is not confirmed as private LAN. Review before sharing externally.');
  return warnings;
}

export function endpointCsv(endpoints: EndpointRecord[]): string {
  return toCsv(endpoints.map(e => ({
    name: e.name,
    baseUrl: e.baseUrl,
    provider: e.provider,
    kind: e.kind,
    status: e.status,
    locality: e.locality || '',
    privacyRisk: e.privacyRisk || '',
    serviceFingerprint: e.serviceFingerprint || '',
    helperUrl: e.helperUrl || '',
    helperVersion: e.helperVersion || '',
    helperPort: e.helperPort || '',
    aiPort: e.aiPort || e.port || '',
    laptopName: e.laptopName || '',
    laptopIp: e.laptopIp || e.ip || '',
    models: e.models.length,
    modelNames: e.models.map(m => m.name).join(' | '),
    latencyMs: e.latencyMs ?? '',
    latencyQuality: e.latencyQuality || '',
    lastSeenAt: e.lastSeenAt ? new Date(e.lastSeenAt).toISOString() : '',
    favorite: !!e.favorite,
    demo: !!e.demo
  })));
}

export function benchmarkCsv(results: BenchmarkResult[]): string {
  return toCsv(results.map(r => ({
    endpointName: r.endpointName,
    endpointUrl: r.endpointUrl || '',
    provider: r.provider,
    engineKind: r.engineKind || '',
    modelId: r.modelId,
    verdict: r.verdict || '',
    status: r.status,
    promptCount: r.promptCount,
    successCount: r.successCount,
    failureCount: r.failureCount,
    avgTtftMs: r.avgTtftMs ?? '',
    avgOutputTps: r.avgOutputTps ?? '',
    avgLatencyMs: r.avgLatencyMs ?? '',
    estimatedTps: r.estimatedTps ?? '',
    estimatedTokens: r.estimatedTokens,
    streamingPassed: r.streamingPassed ?? '',
    jsonPassed: r.jsonPassed ?? '',
    appReadinessScore: r.appReadiness ? `${r.appReadiness.score}/${r.appReadiness.maxScore}` : '',
    ragReadinessScore: r.ragReadiness ? `${r.ragReadiness.score}/${r.ragReadiness.maxScore}` : '',
    locality: r.locality || '',
    privacyRisk: r.privacyRisk || '',
    startedAt: new Date(r.startedAt).toISOString(),
    demo: !!r.demo
  })));
}

export async function shareTextFile(filename: string, content: string): Promise<string> {
  try {
    await Share.share({ title: filename, message: content });
    return 'shared-via-system-sheet';
  } catch {
    await Clipboard.setStringAsync(content);
    return 'copied-to-clipboard';
  }
}

export async function copyText(content: string): Promise<void> {
  await Clipboard.setStringAsync(content);
}
