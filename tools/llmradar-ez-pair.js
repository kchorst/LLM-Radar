#!/usr/bin/env node
/*
  LLM Radar EZ Pair Service v0.7.0
  Computer-side Phone Access service. Detects local AI services, starts a tiny pairing server,
  renders offline QR SVG and keeps advanced diagnostics behind Troubleshooting. Windows setup changes happen only in Start_Here.bat.
*/
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const zlib = require('zlib');
const QRCode = require('./vendor/QRCode');
const QRErrorCorrectLevel = require('./vendor/QRCode/QRErrorCorrectLevel');

const HELPER_VERSION = '0.7.0';
const DEFAULT_HELPER_PORT = Number(process.env.LLMRADAR_HELPER_PORT || 49321);
const HELPER_PORT_MAX = Number(process.env.LLMRADAR_HELPER_PORT_MAX || 49329);
const BASE_HELPER_PORT = 49321;
const PORTS = [8080, 11434, 1234, 3000, 8000, 5000];
const TIMEOUT_MS = 650;
let phoneTouches = [];
let activeHelperPort = DEFAULT_HELPER_PORT;
let activeResult = null;
let activePackCache = null;
let activeRagDocument = null;
let lastDiagnosticsAt = 0;
let diagnosticsInFlight = null;
const DIAGNOSTICS_CACHE_MS = 45000;
const KNOWN_AI_PORT = Number(process.env.LLMRADAR_AI_PORT || 0);
const QUIET_CONSOLE = process.env.LLMRADAR_QUIET_HELPER === '1';

function startConsoleHeartbeat(label) {
  if (QUIET_CONSOLE) return () => {};
  const cleanLabel = String(label || 'Working').trim() || 'Working';
  let tick = 0;
  process.stdout.write(`${cleanLabel} `);
  const timer = setInterval(() => {
    tick += 1;
    const dots = '.'.repeat((tick % 3) + 1).padEnd(3, ' ');
    process.stdout.write(`
${cleanLabel}${dots} keep this window open`);
  }, 1000);
  return () => {
    clearInterval(timer);
    process.stdout.write(`
${cleanLabel} done.                         
`);
  };
}

function privateScore(address, name) {
  const n = String(name || '').toLowerCase();
  let score = 0;
  if (/wi-?fi|wireless|wlan/.test(n)) score += 60;
  if (/ethernet|lan/.test(n)) score += 45;
  if (/virtual|vmware|virtualbox|docker|hyper-v|vethernet|loopback|local area connection\*/.test(n)) score -= 120;
  if (address.startsWith('192.168.')) score += 40;
  if (address.startsWith('10.')) score += 25;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 20;
  if (address.startsWith('192.168.137.')) score -= 90;
  if (address.startsWith('169.254.')) score -= 100;
  return score;
}

function getCandidateIps() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, entries] of Object.entries(nets)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const address = entry.address;
      if (!address || address === '127.0.0.1') continue;
      candidates.push({ name, address, score: privateScore(address, name) });
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function fetchText(url, timeoutMs = TIMEOUT_MS) {
  return new Promise(resolve => {
    const lib = url.startsWith('https:') ? https : http;
    const started = Date.now();
    const req = lib.request(url, { method: 'GET', timeout: timeoutMs, headers: { Accept: 'application/json,text/html,*/*' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 9000) body += chunk; });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode || 0, text: body, durationMs: Date.now() - started }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', error => resolve({ ok: false, status: 0, text: '', error: error.message, durationMs: Date.now() - started }));
    req.end();
  });
}


function fetchJson(url, options = {}) {
  return new Promise(resolve => {
    const lib = url.startsWith('https:') ? https : http;
    const method = options.method || 'GET';
    const timeoutMs = options.timeoutMs || 12000;
    const started = Date.now();
    const body = options.body ? JSON.stringify(options.body) : null;
    const headers = Object.assign({ Accept: 'application/json,*/*' }, options.headers || {});
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request(url, { method, timeout: timeoutMs, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (text.length < 30000) text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode || 0, text, json, durationMs: Date.now() - started });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', error => resolve({ ok: false, status: 0, text: '', json: null, error: error.message, durationMs: Date.now() - started }));
    if (body) req.write(body);
    req.end();
  });
}

function safePreview(text, max = 260) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isPrivateLanUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.') || h.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch {
    return false;
  }
}

function localityLabel(url) {
  if (!url) return { label: 'Unknown', risk: 'Medium', detail: 'No endpoint URL was detected.' };
  if (isPrivateLanUrl(url)) return { label: 'Local LAN', risk: 'Low', detail: 'Endpoint uses a private/local address. This does not prove authentication is enabled.' };
  return { label: 'Cloud/Public or non-private', risk: 'High', detail: 'Endpoint does not look like a private LAN address. Review before sharing.' };
}

function estimateTokens(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

async function listModels(detected) {
  if (!detected || !detected.baseUrl) return { ok: false, models: [], quality: 'Unknown', error: 'No endpoint detected.' };
  if (detected.kind === 'ollama' || detected.path === '/api/tags') {
    const res = await fetchJson(`${detected.baseUrl}/api/tags`, { timeoutMs: 9000 });
    const models = res.json && Array.isArray(res.json.models) ? res.json.models.map(m => m.name || m.model).filter(Boolean) : [];
    return { ok: res.ok && models.length > 0, models, status: res.status, durationMs: res.durationMs, quality: models.length ? 'Exact' : 'Unknown', error: res.error || (!models.length ? 'No Ollama models returned.' : '') };
  }
  const res = await fetchJson(`${detected.baseUrl}/v1/models`, { timeoutMs: 9000 });
  const models = res.json && Array.isArray(res.json.data) ? res.json.data.map(m => m.id).filter(Boolean) : [];
  return { ok: res.ok && models.length > 0, models, status: res.status, durationMs: res.durationMs, quality: models.length ? 'Exact' : 'Unknown', error: res.error || (!models.length ? 'No OpenAI-compatible models returned.' : '') };
}

async function runQuickPrompt(detected, models) {
  if (!detected || !detected.baseUrl) return { ok: false, skipped: true, quality: 'Unknown', error: 'No endpoint detected.' };
  const prompt = 'Reply with exactly this short phrase: LLM Radar OK';
  const model = models && models[0] ? models[0] : '';
  if (detected.kind === 'open-webui' || detected.path === '/') {
    return { ok: false, skipped: true, quality: 'Unknown', error: 'Detected a web UI/root page, not a compatible chat API for this quick test.' };
  }
  if (detected.kind === 'ollama' || detected.path === '/api/tags') {
    if (!model) return { ok: false, skipped: true, quality: 'Unknown', error: 'Ollama answered, but no loaded model name was available.' };
    const started = Date.now();
    const res = await fetchJson(`${detected.baseUrl}/api/generate`, { method: 'POST', timeoutMs: 20000, body: { model, prompt, stream: false, options: { temperature: 0, num_predict: 24 } } });
    const text = res.json && typeof res.json.response === 'string' ? res.json.response : res.text;
    return { ok: res.ok && !!text, model, prompt, responsePreview: safePreview(text), status: res.status, durationMs: Date.now() - started, quality: 'Measured', error: res.error || '' };
  }
  const started = Date.now();
  const body = { model: model || 'local-model', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 32, stream: false };
  const res = await fetchJson(`${detected.baseUrl}/v1/chat/completions`, { method: 'POST', timeoutMs: 20000, body });
  let text = '';
  if (res.json && Array.isArray(res.json.choices) && res.json.choices[0]) {
    const c = res.json.choices[0];
    text = (c.message && c.message.content) || c.text || '';
  }
  if (!text) text = res.text;
  const usage = res.json && res.json.usage ? res.json.usage : null;
  return { ok: res.ok && !!text, model: model || body.model, prompt, responsePreview: safePreview(text), status: res.status, durationMs: Date.now() - started, quality: 'Measured', usageQuality: usage ? 'Exact' : 'Unknown', usage, error: res.error || '' };
}

async function buildLocalAiReport(result) {
  const detected = result && result.detected ? result.detected : null;
  const modelInfo = await listModels(detected);
  const quick = await runQuickPrompt(detected, modelInfo.models || []);
  const locality = localityLabel(detected ? detected.baseUrl : '');
  const status = detected && quick.ok ? 'Ready' : detected ? 'Partial' : 'Blocked';
  const now = new Date().toISOString();
  const outputTokens = quick.usage && Number(quick.usage.completion_tokens) ? Number(quick.usage.completion_tokens) : estimateTokens(quick.responsePreview || '');
  const outputTps = quick.ok && quick.durationMs ? Number((outputTokens / (quick.durationMs / 1000)).toFixed(1)) : null;
  return {
    app: 'LLM Radar',
    helperVersion: HELPER_VERSION,
    reportType: 'Computer-side Local AI Validation Preview',
    generatedAt: now,
    overallStatus: status,
    endpoint: detected ? {
      url: detected.baseUrl,
      hostIp: result.ip ? result.ip.address : '',
      adapter: result.ip ? result.ip.name : '',
      port: detected.port,
      provider: detected.provider,
      serviceHint: detected.kind,
      detectedPath: detected.path,
      reachabilityStatus: 'Pass',
      detectionLatencyMs: detected.durationMs,
      detectionLatencyQuality: 'Measured'
    } : null,
    locality: {
      status: locality.label,
      privacyRisk: locality.risk,
      detail: locality.detail,
      quality: 'Estimated'
    },
    models: {
      status: modelInfo.ok ? 'Pass' : 'Unknown',
      modelIds: modelInfo.models || [],
      modelCount: (modelInfo.models || []).length,
      quality: modelInfo.quality,
      error: modelInfo.error || ''
    },
    quickTest: {
      status: quick.ok ? 'Pass' : quick.skipped ? 'Skipped' : 'Fail',
      model: quick.model || '',
      responseTimeMs: quick.durationMs || null,
      responseTimeQuality: quick.durationMs ? 'Measured' : 'Unknown',
      outputTokens: outputTokens || null,
      outputTokensQuality: quick.usage && quick.usage.completion_tokens ? 'Exact' : quick.responsePreview ? 'Estimated' : 'Unknown',
      outputTokensPerSecond: outputTps,
      outputTokensPerSecondQuality: outputTps ? 'Estimated from total response time' : 'Unknown',
      responsePreview: quick.responsePreview || '',
      error: quick.error || ''
    },
    recommendation: status === 'Ready'
      ? 'Local AI is reachable from this computer LAN address and passed a quick prompt test. This setup is ready for phone pairing or consultant reporting.'
      : status === 'Partial'
        ? 'Endpoint was detected, but the quick prompt test did not fully pass. Check that a model is loaded and the API supports chat/generate requests.'
        : 'No LAN-ready Local AI endpoint was detected. Start the Local AI server if needed, then click Refresh Status on the LLM Radar browser page.'
  };
}

function reportMarkdown(report) {
  const endpoint = report.endpoint || {};
  const models = report.models || {};
  const quick = report.quickTest || {};
  return `# LLM Radar Local AI Report Preview\n\n` +
    `Generated: ${report.generatedAt}\n\n` +
    `## Summary\n` +
    `- Overall status: ${report.overallStatus}\n` +
    `- Locality: ${report.locality.status} (${report.locality.quality})\n` +
    `- Privacy risk: ${report.locality.privacyRisk}\n` +
    `- Endpoint: ${endpoint.url || 'Not detected'}\n` +
    `- Service: ${endpoint.provider || 'Unknown'}\n` +
    `- Models: ${(models.modelIds || []).slice(0, 5).join(', ') || 'Unknown'} (${models.quality})\n` +
    `- Quick test: ${quick.status}\n` +
    `- Response time: ${quick.responseTimeMs || 'Unknown'} ms (${quick.responseTimeQuality})\n` +
    `- Output TPS: ${quick.outputTokensPerSecond || 'Unknown'} (${quick.outputTokensPerSecondQuality})\n\n` +
    `## Recommendation\n${report.recommendation}\n\n` +
    `## Sanitized response preview\n${quick.responsePreview || 'No response preview.'}\n`;
}


const BENCHMARK_PROMPTS = [
  {
    id: 'basic-answer',
    title: 'Basic answer',
    category: 'Connectivity',
    prompt: 'Reply with exactly this short phrase: LLM Radar OK',
    maxTokens: 32
  },
  {
    id: 'structured-json',
    title: 'Structured JSON',
    category: 'App readiness',
    prompt: 'Return only valid JSON with exactly these keys: status and app. Use status "ok" and app "LLM Radar".',
    maxTokens: 96,
    expectJson: true
  },
  {
    id: 'instruction-following',
    title: 'Instruction following',
    category: 'Consultant use',
    prompt: 'In one short sentence, say that local AI reporting is ready.',
    maxTokens: 48
  },
  {
    id: 'long-context-smoke',
    title: 'Long-context smoke',
    category: 'App readiness',
    prompt: 'Use this context: LLM Radar validates local AI endpoints, measures performance, checks app readiness, and creates consultant reports. In one short sentence, say what LLM Radar is validating.',
    maxTokens: 80
  }
];

function extractJsonCandidate(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) return raw.slice(first, last + 1);
  return raw;
}

function jsonParseStatus(text) {
  try {
    const parsed = JSON.parse(extractJsonCandidate(text));
    return { valid: true, keys: Object.keys(parsed || {}) };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

async function runBenchmarkPrompt(detected, model, promptDef) {
  if (!detected || !detected.baseUrl) {
    return { promptId: promptDef.id, title: promptDef.title, category: promptDef.category, status: 'Skipped', error: 'No endpoint detected.', responseTimeQuality: 'Unknown', outputTokensQuality: 'Unknown', outputTokensPerSecondQuality: 'Unknown', ttftQuality: 'Unknown' };
  }
  if (detected.kind === 'open-webui' || detected.path === '/') {
    return { promptId: promptDef.id, title: promptDef.title, category: promptDef.category, status: 'Skipped', error: 'Detected a web UI/root page, not a compatible chat API for this benchmark.', responseTimeQuality: 'Unknown', outputTokensQuality: 'Unknown', outputTokensPerSecondQuality: 'Unknown', ttftQuality: 'Unknown' };
  }
  const started = Date.now();
  let res;
  let text = '';
  let usage = null;
  if (detected.kind === 'ollama' || detected.path === '/api/tags') {
    if (!model) return { promptId: promptDef.id, title: promptDef.title, category: promptDef.category, status: 'Skipped', error: 'Ollama answered, but no model name was available.', responseTimeQuality: 'Unknown', outputTokensQuality: 'Unknown', outputTokensPerSecondQuality: 'Unknown', ttftQuality: 'Unknown' };
    res = await fetchJson(`${detected.baseUrl}/api/generate`, { method: 'POST', timeoutMs: 30000, body: { model, prompt: promptDef.prompt, stream: false, options: { temperature: 0, num_predict: promptDef.maxTokens || 64 } } });
    text = res.json && typeof res.json.response === 'string' ? res.json.response : res.text;
    usage = res.json && Number(res.json.eval_count) ? { completion_tokens: Number(res.json.eval_count) } : null;
  } else {
    const body = { model: model || 'local-model', messages: [{ role: 'user', content: promptDef.prompt }], temperature: 0, max_tokens: promptDef.maxTokens || 64, stream: false };
    res = await fetchJson(`${detected.baseUrl}/v1/chat/completions`, { method: 'POST', timeoutMs: 30000, body });
    if (res.json && Array.isArray(res.json.choices) && res.json.choices[0]) {
      const c = res.json.choices[0];
      text = (c.message && c.message.content) || c.text || '';
    }
    if (!text) text = res.text;
    usage = res.json && res.json.usage ? res.json.usage : null;
  }
  const durationMs = Date.now() - started;
  const preview = safePreview(text, 360);
  const outputTokens = usage && Number(usage.completion_tokens) ? Number(usage.completion_tokens) : estimateTokens(preview);
  const outputTps = outputTokens && durationMs ? Number((outputTokens / (durationMs / 1000)).toFixed(1)) : null;
  const jsonStatus = promptDef.expectJson ? jsonParseStatus(text) : null;
  const ok = !!(res && res.ok && preview) && (!promptDef.expectJson || jsonStatus.valid);
  return {
    promptId: promptDef.id,
    title: promptDef.title,
    category: promptDef.category,
    status: ok ? 'Pass' : 'Fail',
    model: model || '',
    responseTimeMs: durationMs,
    responseTimeQuality: 'Measured',
    ttftMs: null,
    ttftQuality: 'Unknown',
    outputTokens: outputTokens || null,
    outputTokensQuality: usage && usage.completion_tokens ? 'Exact' : preview ? 'Estimated' : 'Unknown',
    outputTokensPerSecond: outputTps,
    outputTokensPerSecondQuality: outputTps ? 'Estimated from total response time' : 'Unknown',
    responsePreview: preview,
    jsonValid: jsonStatus ? jsonStatus.valid : null,
    jsonKeys: jsonStatus && jsonStatus.keys ? jsonStatus.keys : [],
    error: (res && res.error) || (jsonStatus && jsonStatus.error) || ''
  };
}

async function buildBenchmarkReport(result) {
  const detected = result && result.detected ? result.detected : null;
  const modelInfo = await listModels(detected);
  const model = modelInfo.models && modelInfo.models[0] ? modelInfo.models[0] : '';
  const locality = localityLabel(detected ? detected.baseUrl : '');
  const tests = [];
  for (const promptDef of BENCHMARK_PROMPTS) {
    tests.push(await runBenchmarkPrompt(detected, model, promptDef));
  }
  const passCount = tests.filter(t => t.status === 'Pass').length;
  const failCount = tests.filter(t => t.status === 'Fail').length;
  const skippedCount = tests.filter(t => t.status === 'Skipped').length;
  const timed = tests.filter(t => t.responseTimeMs);
  const speeds = tests.filter(t => t.outputTokensPerSecond).map(t => t.outputTokensPerSecond);
  const avgResponseMs = timed.length ? Math.round(timed.reduce((sum, t) => sum + t.responseTimeMs, 0) / timed.length) : null;
  const avgTps = speeds.length ? Number((speeds.reduce((sum, x) => sum + x, 0) / speeds.length).toFixed(1)) : null;
  const status = detected && passCount === tests.length ? 'Ready' : detected && passCount > 0 ? 'Partial' : 'Blocked';
  const best = timed.length ? timed.slice().sort((a, b) => a.responseTimeMs - b.responseTimeMs)[0] : null;
  const slowest = timed.length ? timed.slice().sort((a, b) => b.responseTimeMs - a.responseTimeMs)[0] : null;
  return {
    app: 'LLM Radar',
    helperVersion: HELPER_VERSION,
    reportType: 'Computer-side Quick Benchmark Preview',
    generatedAt: new Date().toISOString(),
    overallStatus: status,
    endpoint: detected ? {
      url: detected.baseUrl,
      hostIp: result.ip ? result.ip.address : '',
      adapter: result.ip ? result.ip.name : '',
      port: detected.port,
      provider: detected.provider,
      serviceHint: detected.kind,
      detectedPath: detected.path,
      reachabilityStatus: 'Pass',
      detectionLatencyMs: detected.durationMs,
      detectionLatencyQuality: 'Measured'
    } : null,
    locality: {
      status: locality.label,
      privacyRisk: locality.risk,
      detail: locality.detail,
      quality: 'Estimated'
    },
    models: {
      status: modelInfo.ok ? 'Pass' : 'Unknown',
      modelIds: modelInfo.models || [],
      modelCount: (modelInfo.models || []).length,
      quality: modelInfo.quality,
      error: modelInfo.error || ''
    },
    benchmark: {
      mode: 'Quick Benchmark',
      promptCount: tests.length,
      passCount,
      failCount,
      skippedCount,
      averageResponseMs: avgResponseMs,
      averageResponseQuality: avgResponseMs ? 'Measured' : 'Unknown',
      averageOutputTokensPerSecond: avgTps,
      averageOutputTokensPerSecondQuality: avgTps ? 'Estimated from total response time' : 'Unknown',
      ttftQuality: 'Unknown',
      bestTest: best ? best.title : 'Unknown',
      slowestTest: slowest ? slowest.title : 'Unknown',
      tests
    },
    recommendation: status === 'Ready'
      ? 'The local AI endpoint passed the quick benchmark. This setup is ready for consultant reporting and LAN invite sharing.'
      : status === 'Partial'
        ? 'The endpoint answered, but not every benchmark prompt passed. Review the failed prompt(s), loaded model, and API compatibility before presenting this setup as ready.'
        : 'No benchmark-ready Local AI endpoint was detected. Start the Local AI server if needed, then click Refresh Status on the LLM Radar browser page.'
  };
}

function benchmarkMarkdown(report) {
  const endpoint = report.endpoint || {};
  const models = report.models || {};
  const bm = report.benchmark || {};
  const tests = bm.tests || [];
  return `# LLM Radar Quick Benchmark Preview\n\n` +
    `Generated: ${report.generatedAt}\n\n` +
    `## Executive summary\n` +
    `- Overall status: ${report.overallStatus}\n` +
    `- Endpoint: ${endpoint.url || 'Not detected'}\n` +
    `- Service: ${endpoint.provider || 'Unknown'}\n` +
    `- Models: ${(models.modelIds || []).slice(0, 5).join(', ') || 'Unknown'} (${models.quality})\n` +
    `- Locality: ${report.locality.status} (${report.locality.quality})\n` +
    `- Privacy risk: ${report.locality.privacyRisk}\n` +
    `- Benchmark: ${bm.passCount || 0}/${bm.promptCount || 0} passed\n` +
    `- Average response time: ${bm.averageResponseMs || 'Unknown'} ms (${bm.averageResponseQuality})\n` +
    `- Average output TPS: ${bm.averageOutputTokensPerSecond || 'Unknown'} (${bm.averageOutputTokensPerSecondQuality})\n` +
    `- TTFT: Unknown (streaming benchmark not run in this no-APK preview)\n\n` +
    `## Recommendation\n${report.recommendation}\n\n` +
    `## Prompt results\n` +
    tests.map(t => `### ${t.title}\n- Category: ${t.category}\n- Status: ${t.status}\n- Response time: ${t.responseTimeMs || 'Unknown'} ms (${t.responseTimeQuality})\n- Output tokens: ${t.outputTokens || 'Unknown'} (${t.outputTokensQuality})\n- Output TPS: ${t.outputTokensPerSecond || 'Unknown'} (${t.outputTokensPerSecondQuality})\n${(t.jsonValid === true || t.jsonValid === false) ? `- JSON valid: ${t.jsonValid ? 'Yes' : 'No'}\n` : ''}- Preview: ${t.responsePreview || 'No preview.'}\n${t.error ? `- Note: ${t.error}\n` : ''}`).join('\n');
}

function benchmarkHtml(report) {
  const endpoint = report.endpoint || {};
  const models = report.models || {};
  const bm = report.benchmark || {};
  const tests = bm.tests || [];
  const badgeClass = report.overallStatus === 'Ready' ? 'ok' : report.overallStatus === 'Partial' ? 'warn' : 'bad';
  const md = benchmarkMarkdown(report);
  const testCards = tests.map(t => `<section class="card"><h2>${htmlEscape(t.title)}</h2><div class="grid"><div class="metric"><span class="label">Category</span><br><b>${htmlEscape(t.category)}</b></div><div class="metric"><span class="label">Status</span><br><b>${htmlEscape(t.status)}</b></div><div class="metric"><span class="label">Response time</span><br><b>${htmlEscape(String(t.responseTimeMs || 'Unknown'))} ms</b> <span class="label">(${htmlEscape(t.responseTimeQuality || 'Unknown')})</span></div><div class="metric"><span class="label">Output TPS</span><br><b>${htmlEscape(String(t.outputTokensPerSecond || 'Unknown'))}</b> <span class="label">(${htmlEscape(t.outputTokensPerSecondQuality || 'Unknown')})</span></div></div>${(t.jsonValid === true || t.jsonValid === false) ? `<p>JSON valid: <b>${t.jsonValid ? 'Yes' : 'No'}</b></p>` : ''}<p><b>Sanitized response preview:</b></p><pre>${htmlEscape(t.responsePreview || 'No response preview.')}</pre>${t.error ? `<p class="warn">${htmlEscape(t.error)}</p>` : ''}</section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Quick Benchmark</title>
<style>body{margin:0;background:#0B0F14;color:#E6EDF3;font-family:Segoe UI,Arial,sans-serif}.shell{width:min(980px,92vw);margin:32px auto;background:#111822;border:1px solid #263241;border-radius:24px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.42)}h1{margin:0 0 8px;font-size:32px}h2{font-size:19px}.card{border:1px solid #263241;border-radius:16px;padding:16px;margin:14px 0;background:#0F151E}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.metric{border-top:1px solid #263241;padding:10px 0}.label{color:#9AA7B3}.ok{color:#7DD3A8;font-weight:900}.warn{color:#E6C36A;font-weight:900}.bad{color:#F08A8A;font-weight:900}p,li{color:#9AA7B3;line-height:1.55}pre{background:#0B0F14;color:#E6EDF3;border:1px solid #263241;border-radius:12px;padding:10px;white-space:pre-wrap;word-break:break-word}button,.button{display:inline-block;background:#8AB4F8;color:#0B0F14;border:0;border-radius:12px;padding:11px 14px;font-weight:900;cursor:pointer;margin:6px 8px 6px 0;text-decoration:none}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:8px 0 12px}@media(max-width:760px){.grid{grid-template-columns:1fr}}</style>
<script>function copyBench(btn){const text=document.getElementById('md').textContent;if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>{if(btn){btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy Benchmark Markdown',1600);}}).catch(()=>alert('Copy failed. Select the text and copy manually.'));}}</script>
</head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack',href:'/pack'},{label:'Quick Benchmark'}])}<h1>LLM Radar Quick Benchmark</h1><p>This no-APK benchmark runs three small prompts from the LLM Radar computer and produces a consultant-readable result.</p>
<section class="card"><h2>Executive summary</h2><p class="${badgeClass}">${htmlEscape(report.overallStatus)}</p><div class="grid"><div class="metric"><span class="label">Endpoint</span><br><b>${htmlEscape(endpoint.url || 'Not detected')}</b></div><div class="metric"><span class="label">Service</span><br><b>${htmlEscape(endpoint.provider || 'Unknown')}</b></div><div class="metric"><span class="label">Model</span><br><b>${htmlEscape((models.modelIds || [])[0] || 'Unknown')}</b></div><div class="metric"><span class="label">Locality</span><br><b>${htmlEscape(report.locality.status)}</b> <span class="label">(${htmlEscape(report.locality.quality)})</span></div><div class="metric"><span class="label">Prompt results</span><br><b>${htmlEscape(String(bm.passCount || 0))}/${htmlEscape(String(bm.promptCount || 0))} passed</b></div><div class="metric"><span class="label">Average response</span><br><b>${htmlEscape(String(bm.averageResponseMs || 'Unknown'))} ms</b> <span class="label">(${htmlEscape(bm.averageResponseQuality || 'Unknown')})</span></div><div class="metric"><span class="label">Average output TPS</span><br><b>${htmlEscape(String(bm.averageOutputTokensPerSecond || 'Unknown'))}</b> <span class="label">(${htmlEscape(bm.averageOutputTokensPerSecondQuality || 'Unknown')})</span></div><div class="metric"><span class="label">TTFT</span><br><b>Unknown</b> <span class="label">(streaming not run)</span></div></div><p>${htmlEscape(report.recommendation)}</p></section>
${testCards}
<section class="card"><h2>Shareable benchmark report</h2><div class="actions"><button onclick="copyBench(this)">Copy Benchmark Markdown</button><a class="button" href="/benchmark.json">Open JSON</a><a class="button" href="/report">Back to Report Preview</a><a class="button" href="/invite">Preview LAN Invite</a><a class="button" href="/pack">Run Consultant Pack</a></div><pre id="md">${htmlEscape(md)}</pre></section>
<p><a class="button" href="/pack">Back to Consultant Pack</a> <a class="button secondary" href="/">Back to Phone Access</a></p></main></body></html>`;
}

function formatInviteGeneratedAt(value) {
  return value || new Date().toISOString();
}

async function buildLanInvite(result, helperUrl, payloadText) {
  const detected = result && result.detected ? result.detected : null;
  const modelInfo = await listModels(detected);
  const locality = localityLabel(detected ? detected.baseUrl : '');
  const payload = payloadText ? JSON.parse(payloadText) : null;
  return {
    app: 'LLM Radar',
    helperVersion: HELPER_VERSION,
    reportType: 'Same-Wi-Fi LAN Invite Preview',
    generatedAt: new Date().toISOString(),
    status: detected ? 'Ready' : 'Blocked',
    helperUrl,
    pairingUrl: helperUrl + '/pair',
    endpointUrl: detected ? detected.baseUrl : '',
    provider: detected ? detected.provider : 'Unknown',
    detectedPath: detected ? detected.path : '',
    computerName: os.hostname(),
    computerIp: result && result.ip ? result.ip.address : '',
    aiPort: detected ? detected.port : null,
    modelIds: modelInfo.models || [],
    modelQuality: modelInfo.quality || 'Unknown',
    locality: {
      status: locality.label,
      privacyRisk: locality.risk,
      quality: 'Estimated',
      detail: locality.detail
    },
    payload,
    sameWifiWarning: 'This invite shares a local AI endpoint URL. Only share it with trusted people on the same Wi-Fi. If the server has no password/authentication, anyone with the URL on this Wi-Fi may be able to use it.',
    recommendation: detected
      ? 'LAN invite is ready. Share the QR or manual pairing link only with trusted same-Wi-Fi users.'
      : 'LAN invite is not ready. Start the Local AI server if needed, then click Refresh Status on the LLM Radar browser page.'
  };
}

function inviteMarkdown(invite) {
  return `# LLM Radar Same-Wi-Fi LAN Invite\n\n` +
    `Generated: ${formatInviteGeneratedAt(invite.generatedAt)}\n\n` +
    `## Invite status\n` +
    `- Status: ${invite.status}\n` +
    `- LLM Radar computer URL: ${invite.helperUrl || 'Unknown'}\n` +
    `- Phone URL: ${invite.pairingUrl || 'Unknown'}\n` +
    `- Endpoint URL: ${invite.endpointUrl || 'Not detected'}\n` +
    `- Service: ${invite.provider || 'Unknown'}\n` +
    `- Model: ${(invite.modelIds || [])[0] || 'Unknown'} (${invite.modelQuality || 'Unknown'})\n` +
    `- Locality: ${invite.locality.status} (${invite.locality.quality})\n` +
    `- Privacy risk: ${invite.locality.privacyRisk}\n\n` +
    `## Same-Wi-Fi warning\n${invite.sameWifiWarning}\n\n` +
    `## Instructions for the invited user\n` +
    `1. Connect to the same trusted Wi-Fi as ${invite.computerName || 'this computer'}.\n` +
    `2. Open LLM Radar on the phone.\n` +
    `3. Scan the QR code on the LLM Radar computer page, or use the pairing URL above.\n\n` +
    `## Recommendation\n${invite.recommendation}\n`;
}

function inviteHtml(invite, qrSvg) {
  const badgeClass = invite.status === 'Ready' ? 'ok' : 'bad';
  const md = inviteMarkdown(invite);
  const modelRows = (invite.modelIds || []).slice(0, 8).map(m => `<li>${htmlEscape(m)}</li>`).join('') || '<li>Unknown / not returned</li>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar LAN Invite</title>
<style>body{margin:0;background:#0B0F14;color:#E6EDF3;font-family:Segoe UI,Arial,sans-serif}.shell{width:min(980px,92vw);margin:32px auto;background:#111822;border:1px solid #263241;border-radius:24px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.42)}h1{margin:0 0 8px;font-size:32px}h2{font-size:19px}.card{border:1px solid #263241;border-radius:16px;padding:16px;margin:14px 0;background:#0F151E}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.metric{border-top:1px solid #263241;padding:10px 0}.label{color:#9AA7B3}.ok{color:#7DD3A8;font-weight:900}.warn{color:#E6C36A;font-weight:900}.bad{color:#F08A8A;font-weight:900}p,li{color:#9AA7B3;line-height:1.55}.qr{width:332px;min-height:332px;background:#fff;border-radius:20px;margin:20px auto;display:grid;place-items:center;padding:16px}code,pre{background:#0B0F14;color:#E6EDF3;border:1px solid #263241;border-radius:12px;padding:10px;white-space:pre-wrap;word-break:break-word}button,.button{display:inline-block;background:#8AB4F8;color:#0B0F14;border:0;border-radius:12px;padding:11px 14px;font-weight:900;cursor:pointer;margin:6px 8px 6px 0;text-decoration:none}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:8px 0 12px}@media(max-width:760px){.grid{grid-template-columns:1fr}}</style>
<script>function copyInvite(btn){const text=document.getElementById('md').textContent;if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>{if(btn){btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy LAN Invite Markdown',1600);}}).catch(()=>alert('Copy failed. Select the text and copy manually.'));}}</script>
</head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack',href:'/pack'},{label:'LAN Invite'}])}<h1>LLM Radar LAN Invite Preview</h1><p>This no-APK page previews the same-Wi-Fi invite a consultant would share after the computer-side endpoint is validated.</p>
<section class="card"><h2>Invite summary</h2><p class="${badgeClass}">${htmlEscape(invite.status)}</p><div class="grid"><div class="metric"><span class="label">Phone URL</span><br><b>${htmlEscape(invite.pairingUrl || 'Unknown')}</b></div><div class="metric"><span class="label">Endpoint URL</span><br><b>${htmlEscape(invite.endpointUrl || 'Not detected')}</b></div><div class="metric"><span class="label">Service</span><br><b>${htmlEscape(invite.provider || 'Unknown')}</b></div><div class="metric"><span class="label">Computer IP</span><br><b>${htmlEscape(invite.computerIp || 'Unknown')}</b></div><div class="metric"><span class="label">Locality</span><br><b>${htmlEscape(invite.locality.status)}</b> <span class="label">(${htmlEscape(invite.locality.quality)})</span></div><div class="metric"><span class="label">Privacy risk</span><br><b>${htmlEscape(invite.locality.privacyRisk)}</b></div></div><p>${htmlEscape(invite.recommendation)}</p></section>
<section class="card"><h2>QR and manual pairing</h2>${qrSvg ? `<div class="qr">${qrSvg}</div>` : '<p class="bad">No QR is available because the endpoint is not ready.</p>'}<pre>${htmlEscape(invite.pairingUrl || 'No pairing URL yet.')}</pre></section>
<section class="card"><h2>Same-Wi-Fi warning</h2><p class="warn">${htmlEscape(invite.sameWifiWarning)}</p></section>
<section class="card"><h2>Models</h2><ul>${modelRows}</ul></section>
<section class="card"><h2>Shareable LAN invite</h2><div class="actions"><button onclick="copyInvite(this)">Copy LAN Invite Markdown</button><a class="button" href="/invite.json">Open JSON</a><a class="button" href="/report">Back to Report Preview</a><a class="button" href="/benchmark">Run Quick Benchmark</a><a class="button" href="/invite">Preview LAN Invite</a><a class="button" href="/pack">Run Consultant Pack</a></div><pre id="md">${htmlEscape(md)}</pre></section>
<p><a class="button" href="/">Back to Phone Access</a></p></main></body></html>`;
}


function appDataDir() {
  const base = process.env.LLMRADAR_DATA_DIR || process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir() || process.cwd();
  return path.join(base, 'LLM Radar');
}

function ensureDataDirs() {
  const dirs = [appDataDir(), reportsDir(), profilesDir(), ragDir()];
  for (const dir of dirs) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}

function reportsDir() {
  return path.join(appDataDir(), 'reports');
}

function ragDir() {
  return path.join(appDataDir(), 'rag');
}

function safeFileStamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, '-').replace(/[^A-Za-z0-9_-]/g, '_');
}

function readSnapshotIndex() {
  try {
    const file = path.join(reportsDir(), 'index.json');
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(row => row && typeof row === 'object');
  } catch {
    return [];
  }
}

function writeSnapshotIndex(rows) {
  try {
    fs.mkdirSync(reportsDir(), { recursive: true });
    const clean = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === 'object');
    fs.writeFileSync(path.join(reportsDir(), 'index.json'), JSON.stringify(clean.slice(0, 50), null, 2), 'utf8');
  } catch {}
}

function latestSavedPack() {
  const rows = readSnapshotIndex();
  const newest = rows && rows[0] ? rows[0] : null;
  if (!newest || !newest.jsonPath) return null;
  try {
    if (!fs.existsSync(newest.jsonPath)) return null;
    return JSON.parse(fs.readFileSync(newest.jsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function comparePackToPrevious(pack, previous) {
  if (!previous) return { status: 'No previous snapshot', detail: 'Save this consultant pack to establish a baseline for later comparison.' };
  const currentBm = pack.benchmark && pack.benchmark.benchmark ? pack.benchmark.benchmark : {};
  const prevBm = previous.benchmark && previous.benchmark.benchmark ? previous.benchmark.benchmark : {};
  const currentPass = Number(currentBm.passCount || 0);
  const prevPass = Number(prevBm.passCount || 0);
  const currentResp = Number(currentBm.averageResponseMs || 0);
  const prevResp = Number(prevBm.averageResponseMs || 0);
  const currentTps = Number(currentBm.averageOutputTokensPerSecond || 0);
  const prevTps = Number(prevBm.averageOutputTokensPerSecond || 0);
  const lines = [];
  if (currentPass || prevPass) lines.push(`Prompt passes: ${currentPass} now vs ${prevPass} previous`);
  if (currentResp && prevResp) lines.push(`Average response: ${currentResp} ms now vs ${prevResp} ms previous (${currentResp <= prevResp ? 'faster/same' : 'slower'})`);
  if (currentTps && prevTps) lines.push(`Estimated output TPS: ${currentTps} now vs ${prevTps} previous (${currentTps >= prevTps ? 'higher/same' : 'lower'})`);
  const currentModel = ((pack.report && pack.report.models && pack.report.models.modelIds) || [])[0] || '';
  const prevModel = ((previous.report && previous.report.models && previous.report.models.modelIds) || [])[0] || '';
  if (currentModel || prevModel) lines.push(`Model: ${currentModel || 'Unknown'} now vs ${prevModel || 'Unknown'} previous${currentModel && prevModel && currentModel !== prevModel ? ' (changed)' : ''}`);
  return { status: 'Compared to previous snapshot', previousGeneratedAt: previous.generatedAt || previous.packGeneratedAt || '', detail: lines.join('\n') || 'Previous snapshot found, but comparable benchmark metrics were unavailable.' };
}

function appReadinessFromBenchmark(benchmark) {
  const tests = benchmark && benchmark.benchmark && Array.isArray(benchmark.benchmark.tests) ? benchmark.benchmark.tests : [];
  const byId = id => tests.find(t => t.promptId === id) || {};
  const basic = byId('basic-answer');
  const json = byId('structured-json');
  const follow = byId('instruction-following');
  return [
    { name: 'Basic chat', status: basic.status || 'Unknown', evidence: basic.responsePreview || basic.error || '' },
    { name: 'Structured JSON', status: json.status || 'Unknown', evidence: json.jsonValid === true ? 'Returned parseable JSON.' : (json.error || json.responsePreview || '') },
    { name: 'Instruction following', status: follow.status || 'Unknown', evidence: follow.responsePreview || follow.error || '' },
    { name: 'Report export', status: 'Pass', evidence: 'Markdown and JSON report endpoints are available from the LLM Radar computer.' },
    { name: 'LAN invite payload', status: 'Pass', evidence: 'QR/manual pairing payload is available when the endpoint is detected.' }
  ];
}

function accessReviewFromReport(report) {
  const endpoint = report && report.endpoint ? report.endpoint : null;
  const modelListPass = report && report.models && report.models.status === 'Pass';
  if (!endpoint) return { status: 'Unknown', risk: 'Medium', detail: 'No endpoint was detected, so access risk could not be reviewed.' };
  if (modelListPass) {
    return { status: 'Review recommended', risk: 'Medium', detail: 'The model list was reachable from this computer without credentials during this test. That is normal for many local demos, but on shared Wi-Fi it means anyone with the endpoint URL may be able to use the server unless you add network controls or authentication.' };
  }
  return { status: 'Unknown', risk: 'Medium', detail: 'LLM Radar could not confirm whether authentication is required.' };
}


function normalizeTextForRag(text) {
  return String(text || '').replace(/\r/g, '\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function pdfLiteralToText(value) {
  return String(value || '')
    .replace(/\\([\\()nrtbf])/g, (_, ch) => ch === 'n' ? '\n' : ch === 'r' ? '\n' : ch === 't' ? ' ' : ch === 'b' || ch === 'f' ? ' ' : ch)
    .replace(/\\\d{1,3}/g, ' ');
}

function extractStringsFromPdfText(raw) {
  const text = String(raw || '');
  const parts = [];
  const literal = /\((?:\\.|[^\\)]){2,}\)/g;
  let m;
  while ((m = literal.exec(text))) {
    const item = pdfLiteralToText(m[0].slice(1, -1));
    if (/[A-Za-z0-9]/.test(item)) parts.push(item);
  }
  const hex = /<([0-9A-Fa-f\s]{8,})>/g;
  while ((m = hex.exec(text))) {
    try {
      const clean = m[1].replace(/\s+/g, '');
      const buf = Buffer.from(clean, 'hex');
      const decoded = buf.toString('utf16be').replace(/\u0000/g, '') || buf.toString('utf8');
      if (/[A-Za-z0-9]/.test(decoded)) parts.push(decoded);
    } catch {}
  }
  return normalizeTextForRag(parts.join(' '));
}

function analyzeExtractedTextQuality(text, kind = 'file') {
  const clean = normalizeTextForRag(text);
  const length = clean.length;
  const letters = (clean.match(/[A-Za-z]/g) || []).length;
  const digits = (clean.match(/[0-9]/g) || []).length;
  const spaces = (clean.match(/\s/g) || []).length;
  const wordList = clean.match(/[A-Za-z][A-Za-z0-9'-]{2,}/g) || [];
  const words = wordList.length;
  const uniqueWordRatio = new Set(wordList.map(word => word.toLowerCase())).size / Math.max(1, words);
  const vowelWordRatio = wordList.filter(word => /[aeiouy]/i.test(word)).length / Math.max(1, words);
  const weird = (clean.match(/[^\w\s.,;:!?()\[\]{}'"\-–—/$%#@&+*=<>]/g) || []).length;
  const alphaRatio = letters / Math.max(1, length);
  const wordDensity = words / Math.max(1, length / 100);
  const weirdRatio = weird / Math.max(1, length);
  const spaceRatio = spaces / Math.max(1, length);
  const minChars = kind === 'txt' ? 40 : 180;
  const minWords = kind === 'txt' ? 8 : 35;
  const reasons = [];
  if (length < minChars) reasons.push('too little readable text');
  if (words < minWords) reasons.push('too few normal words');
  if (alphaRatio < 0.32) reasons.push('low letter ratio');
  if (wordDensity < 2.0) reasons.push('low word density');
  if (weirdRatio > 0.08) reasons.push('too many unusual characters');
  if (spaceRatio < 0.05 && length > 120) reasons.push('words do not look separated');
  if (words >= 8 && vowelWordRatio < 0.35) reasons.push('words look like gibberish');
  if (words >= 20 && uniqueWordRatio < 0.18) reasons.push('too much repeated token text');
  const ok = reasons.length === 0;
  const score = Math.max(0, Math.min(100, Math.round(
    (Math.min(1, length / 1200) * 25) +
    (Math.min(1, words / 120) * 30) +
    (Math.min(1, alphaRatio / 0.55) * 25) +
    (Math.max(0, 1 - weirdRatio / 0.08) * 20)
  )));
  const warning = ok ? '' : `The file uploaded, but the readable text looks low quality (${reasons.join(', ')}). Try a clean text-based PDF, TXT, or MD file.`;
  return { ok, score, length, words, letters, digits, alphaRatio: Number(alphaRatio.toFixed(3)), wordDensity: Number(wordDensity.toFixed(2)), weirdRatio: Number(weirdRatio.toFixed(3)), vowelWordRatio: Number(vowelWordRatio.toFixed(3)), uniqueWordRatio: Number(uniqueWordRatio.toFixed(3)), warning, reasons };
}

function extractPdfText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const latin = buf.toString('latin1');
  const pages = Math.max(1, (latin.match(/\/Type\s*\/Page\b/g) || []).length);
  const streams = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(latin))) {
    const raw = Buffer.from(m[1], 'latin1');
    let decoded = '';
    try { decoded = zlib.inflateSync(raw).toString('latin1'); } catch {
      try { decoded = zlib.inflateRawSync(raw).toString('latin1'); } catch { decoded = raw.toString('latin1'); }
    }
    const extracted = extractStringsFromPdfText(decoded);
    if (extracted) streams.push(extracted);
  }
  let text = normalizeTextForRag(streams.join('\n\n'));
  if (!text || text.length < 80) text = extractStringsFromPdfText(latin);
  const quality = analyzeExtractedTextQuality(text, 'pdf');
  return { text, pages, warning: quality.warning, quality };
}

function extractUploadedText(filename, buffer) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.txt') || name.endsWith('.text') || name.endsWith('.md')) {
    const text = normalizeTextForRag(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || ''));
    const quality = analyzeExtractedTextQuality(text, 'txt');
    return { text, pages: 1, warning: quality.warning, quality };
  }
  return extractPdfText(buffer);
}

function chunkRagText(text, pages) {
  const clean = normalizeTextForRag(text);
  if (!clean) return [];
  const target = 850;
  const overlap = 140;
  const chunks = [];
  for (let start = 0; start < clean.length; start += Math.max(1, target - overlap)) {
    const slice = clean.slice(start, start + target).trim();
    if (!slice) continue;
    const page = pages ? Math.min(pages, Math.max(1, Math.round((start / Math.max(1, clean.length)) * pages) + 1)) : 1;
    chunks.push({ id: `chunk-${chunks.length + 1}`, page, text: slice });
    if (start + target >= clean.length) break;
  }
  return chunks.slice(0, 80);
}

function scoreChunk(query, chunk) {
  const q = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  const text = String(chunk.text || '').toLowerCase();
  if (!q.length) return 0;
  let score = 0;
  for (const word of q) {
    const hits = text.split(word).length - 1;
    if (hits) score += Math.min(4, hits) * (word.length > 5 ? 2 : 1);
  }
  return score;
}

function ragSearch(query, limit = 5) {
  const doc = activeRagDocument;
  if (!doc || !doc.ready) return [];
  const ranked = doc.chunks.map(chunk => ({ ...chunk, score: scoreChunk(query, chunk) }))
    .filter(chunk => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const fallback = doc.chunks.slice(0, limit).map((chunk, i) => ({ ...chunk, score: i === 0 ? 1 : 0 }));
  return (ranked.length ? ranked : fallback).slice(0, limit).map(x => ({ id: x.id, page: x.page, score: x.score, text: safePreview(x.text, 700) }));
}

function ragDocumentStatus() {
  if (!activeRagDocument) return { ready: false, filename: '', pages: 0, chunkCount: 0, warning: 'No file uploaded yet.' };
  return {
    ready: !!activeRagDocument.ready,
    filename: activeRagDocument.filename,
    pages: activeRagDocument.pages,
    chunkCount: activeRagDocument.chunks.length,
    uploadedAt: activeRagDocument.uploadedAt,
    textChars: activeRagDocument.text.length,
    extractionQuality: activeRagDocument.quality || null,
    warning: activeRagDocument.warning || ''
  };
}

function clearRagDocument() {
  activeRagDocument = null;
  return ragDocumentStatus();
}

function readRequestBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Upload too large. Use a small PDF, TXT, or MD file under 5 MB.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartPdf(body, contentType) {
  const boundaryMatch = String(contentType || '').match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = body.indexOf(marker);
  while (start >= 0) {
    let next = body.indexOf(marker, start + marker.length);
    if (next < 0) break;
    const part = body.slice(start + marker.length + 2, next - 2);
    parts.push(part);
    start = next;
  }
  for (const part of parts) {
    const sep = part.indexOf(Buffer.from('\r\n\r\n'));
    if (sep < 0) continue;
    const header = part.slice(0, sep).toString('utf8');
    const data = part.slice(sep + 4);
    if (/name="pdf"/i.test(header) || /filename=/i.test(header)) {
      const fname = (header.match(/filename="([^"]+)"/i) || [])[1] || 'uploaded.pdf';
      return { filename: path.basename(fname), data };
    }
  }
  return null;
}

function saveRagUpload(filename, data) {
  ensureDataDirs();
  const cleanName = path.basename(filename || 'uploaded.pdf').replace(/[^A-Za-z0-9_.-]/g, '_') || 'uploaded.pdf';
  const savedPath = path.join(ragDir(), `${safeFileStamp(new Date().toISOString())}-${cleanName}`);
  fs.writeFileSync(savedPath, data);
  const extracted = extractUploadedText(cleanName, data);
  const chunks = chunkRagText(extracted.text, extracted.pages);
  const extractionOk = !!(extracted.quality && extracted.quality.ok);
  activeRagDocument = {
    ready: chunks.length > 0 && extractionOk,
    filename: cleanName,
    savedPath,
    pages: extracted.pages,
    text: extracted.text,
    chunks: extractionOk ? chunks : [],
    rejectedChunks: extractionOk ? [] : chunks.slice(0, 4),
    quality: extracted.quality || null,
    warning: extracted.warning,
    uploadedAt: new Date().toISOString()
  };
  return ragDocumentStatus();
}

async function runRagModelPrompt(result, prompt, timeoutMs = 45000) {
  const detected = result && result.detected ? result.detected : null;
  if (!detected || !detected.baseUrl) return { ok: false, text: '', error: 'No local AI endpoint detected.' };
  const modelInfo = await listModels(detected);
  const model = (modelInfo.models || [])[0] || '';
  if (!model) return { ok: false, text: '', error: 'No model available for file answer.' };
  if (detected.kind === 'ollama' || detected.path === '/api/tags') {
    const res = await fetchJson(`${detected.baseUrl}/api/generate`, { method: 'POST', timeoutMs, body: { model, prompt, stream: false, options: { temperature: 0.1, num_predict: 360 } } });
    return { ok: res.ok, text: safePreview(res.json && res.json.response ? res.json.response : res.text, 2400), error: res.error || '' };
  }
  const res = await fetchJson(`${detected.baseUrl}/v1/chat/completions`, { method: 'POST', timeoutMs, body: { model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 420, stream: false } });
  let text = '';
  if (res.json && Array.isArray(res.json.choices) && res.json.choices[0]) text = (res.json.choices[0].message && res.json.choices[0].message.content) || res.json.choices[0].text || '';
  return { ok: res.ok, text: safePreview(text || res.text, 2400), error: res.error || '' };
}

async function ragSummary(result) {
  const doc = activeRagDocument;
  if (!doc || !doc.ready) return { ok: false, error: 'No file uploaded yet.', document: ragDocumentStatus(), snippets: [] };
  const snippets = doc.chunks.slice(0, 4).map((x, i) => ({ id: x.id, page: x.page, score: i === 0 ? 1 : 0, text: safePreview(x.text, 700) }));
  const context = snippets.map(s => `[page ${s.page}] ${s.text}`).join('\n\n');
  const model = await runRagModelPrompt(result, `Summarize this small uploaded file for a phone user. Use only the provided snippets. Keep it concise.\n\n${context}`);
  const fallback = safePreview(doc.text, 1200);
  return { ok: true, document: ragDocumentStatus(), summary: model.ok && model.text ? model.text : `Extracted text preview: ${fallback}`, snippets, modelUsed: model.ok, modelError: model.error || '', generatedAt: new Date().toISOString() };
}

async function ragAsk(result, question) {
  const doc = activeRagDocument;
  if (!doc || !doc.ready) return { ok: false, error: 'No file uploaded yet.', document: ragDocumentStatus(), snippets: [] };
  const snippets = ragSearch(question, 5);
  const context = snippets.map(s => `[page ${s.page}] ${s.text}`).join('\n\n');
  const model = await runRagModelPrompt(result, `Answer the question using only these file snippets. If the answer is not present, say that the uploaded file snippets do not show it.\n\nQuestion: ${question}\n\nSnippets:\n${context}`);
  const fallback = snippets.length ? `Best matching snippets are shown below. The local model answer was unavailable.${model.error ? ` ${model.error}` : ''}` : 'No matching snippets were found.';
  return { ok: true, document: ragDocumentStatus(), question, answer: model.ok && model.text ? model.text : fallback, snippets, modelUsed: model.ok, modelError: model.error || '', generatedAt: new Date().toISOString() };
}

function ragUploadHtml(helperUrl) {
  const doc = ragDocumentStatus();
  const status = doc.ready ? `<p class="ok">Ready for Local AI: ${htmlEscape(doc.filename)} · ${doc.pages || 'unknown'} pages · ${doc.chunkCount} chunks</p>` : activeRagDocument ? `<p class="warn">Uploaded, but not ready for Local AI.</p>` : `<p class="warn">No file uploaded yet.</p>`;
  const preview = doc.ready && activeRagDocument && activeRagDocument.text ? `<p class="muted"><b>Readable preview:</b> ${htmlEscape(safePreview(activeRagDocument.text, 220))}</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar File Test</title><style>${sharedCss()}</style></head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'File Test'}])}<h1>File Test Upload</h1><section class="card"><h2>Upload PDF, TXT, or MD</h2><p>This page separates file upload from readable text. Summary and ask only work after the file is readable and ready for Local AI.</p>${status}${doc.warning ? `<p class="warn">${htmlEscape(doc.warning)}</p>` : ''}${preview}<form method="post" action="/rag/upload" enctype="multipart/form-data"><input type="file" name="pdf" accept="application/pdf,text/plain,.txt,.md,text/markdown" required><button type="submit">Upload File</button></form></section><details class="card"><summary>Advanced diagnostics</summary><p>Use these when you need to tell whether the Local AI can handle clean TXT/Markdown before troubleshooting PDFs.</p><div class="actions"><a class="button" href="/diagnostics/document">Test Clean TXT/MD</a><a class="button secondary" href="/rag/upload-check">Upload Check JSON</a><a class="button secondary" href="/rag/status">Status JSON</a><a class="button secondary" href="/rag/summary">Summary JSON</a><a class="button secondary" href="/rag/clear">Clear document</a></div></details><section class="card"><h2>Phone URL</h2><pre>${htmlEscape(helperUrl)}</pre></section><p><a class="button" href="/">Back to Phone Access</a> <a class="button secondary" href="/pack">Consultant Pack</a></p></main></body></html>`;
}

function loadSampleRagDocument() {
  const text = 'LLM Radar is a phone-first local AI radar. The phone connects to a local LLM running on a computer on the same Wi-Fi or LAN. The model does not run on the phone. The computer with the LLM Radar files handles QR pairing, diagnostics, file processing, reports, profiles, storage, and heavier consultant analysis. The phone verifies connection, shows model and endpoint proof, supports chat, light measurement, file result viewing, sharing, and client-friendly presentation.';
  const chunks = chunkRagText(text, 1);
  activeRagDocument = { ready: true, filename: 'sample-rag-proof.txt', savedPath: '', pages: 1, text, chunks, warning: '', uploadedAt: new Date().toISOString() };
  return ragDocumentStatus();
}

const DOCUMENT_DIAGNOSTIC_TEXT = `# LLM Radar Document Diagnostic

This built-in diagnostic checks document capability separately from basic chat.

Important facts:
- A model can pass a short chat test and still be weak at document tasks.
- TXT or Markdown success means the model can process clean extracted text.
- PDF success also requires readable text extraction before the model is asked to summarize.
- If clean TXT or Markdown works but PDF fails, the likely problem is PDF extraction quality, not basic chat.

Answer key: document capability is separate from chat capability.`;

function assessDocumentDiagnosticResponses(summary, answer) {
  const s = String(summary || '').toLowerCase();
  const a = String(answer || '').toLowerCase();
  const summaryOk = /chat/.test(s) && /(document|txt|markdown|pdf|text)/.test(s);
  const answerOk = /(yes|separate|different|can)/.test(a) && /chat/.test(a) && /(document|pdf|text|markdown)/.test(a);
  return {
    summaryOk,
    answerOk,
    status: summaryOk && answerOk ? 'Pass' : summaryOk || answerOk ? 'Partial' : 'Review',
    recommendation: summaryOk && answerOk
      ? 'Clean TXT/Markdown document tasks look usable for this model. If PDFs still fail, focus on PDF extraction/readability.'
      : 'Basic chat may work, but this model did not clearly prove clean document summarization and question answering. Try a stronger model or shorter document text before blaming PDF upload.'
  };
}

async function buildDocumentDiagnostic(result) {
  const text = normalizeTextForRag(DOCUMENT_DIAGNOSTIC_TEXT);
  const quality = analyzeExtractedTextQuality(text, 'txt');
  const chunks = chunkRagText(text, 1);
  const detected = result && result.detected ? result.detected : null;
  const base = {
    ok: false,
    app: 'LLM Radar',
    helperVersion: HELPER_VERSION,
    generatedAt: new Date().toISOString(),
    diagnostic: 'Clean TXT/Markdown document capability',
    userVisibleLocation: 'Troubleshooting and diagnostics only',
    cleanText: {
      ready: quality.ok && chunks.length > 0,
      kind: 'Markdown/TXT diagnostic text',
      chars: text.length,
      chunks: chunks.length,
      extractionQuality: quality,
      preview: safePreview(text, 260)
    },
    localAi: detected ? { provider: detected.provider, baseUrl: detected.baseUrl, port: detected.port, path: detected.path } : null,
    summary: null,
    answer: null,
    assessment: null
  };
  if (!base.cleanText.ready) {
    base.assessment = { status: 'Blocked', recommendation: 'The built-in clean text diagnostic failed its own readability gate. This is a code issue, not a user file issue.' };
    return base;
  }
  if (!detected) {
    base.assessment = { status: 'Blocked', recommendation: 'Start Local AI first, then rerun this diagnostic. This test is for model document capability, not phone upload.' };
    return base;
  }
  const context = chunks.slice(0, 3).map(x => `[text chunk ${x.id}] ${x.text}`).join('\n\n');
  const summaryPrompt = `Summarize this diagnostic text in two short bullets. Use only the provided text.

${context}`;
  const askPrompt = `Using only the diagnostic text, answer yes or no: can a Local AI pass chat while still being weak at document/PDF tasks? Explain in one sentence.

${context}`;
  const summary = await runRagModelPrompt(result, summaryPrompt, 30000);
  const answer = await runRagModelPrompt(result, askPrompt, 30000);
  const assessment = assessDocumentDiagnosticResponses(summary.text, answer.text);
  base.ok = summary.ok && answer.ok && assessment.status === 'Pass';
  base.summary = { ok: summary.ok, text: summary.text || '', error: summary.error || '' };
  base.answer = { ok: answer.ok, text: answer.text || '', error: answer.error || '' };
  base.assessment = assessment;
  return base;
}

function documentDiagnosticMarkdown(diag) {
  return `# LLM Radar Document Diagnostic

Generated: ${diag.generatedAt}
Version: ${diag.helperVersion}

## Purpose
This advanced test checks clean TXT/Markdown document capability separately from basic chat. It is a troubleshooting tool, not the main user flow.

## Clean text gate
- Ready: ${diag.cleanText.ready}
- Chars: ${diag.cleanText.chars}
- Chunks: ${diag.cleanText.chunks}
- Quality score: ${diag.cleanText.extractionQuality ? diag.cleanText.extractionQuality.score : 'Unknown'}

## Local AI
${diag.localAi ? `- ${diag.localAi.provider} at ${diag.localAi.baseUrl}` : '- Not detected'}

## Summary response
${diag.summary && diag.summary.text ? diag.summary.text : diag.summary && diag.summary.error ? diag.summary.error : 'Not run'}

## Question response
${diag.answer && diag.answer.text ? diag.answer.text : diag.answer && diag.answer.error ? diag.answer.error : 'Not run'}

## Assessment
- Status: ${diag.assessment ? diag.assessment.status : 'Unknown'}
- Recommendation: ${diag.assessment ? diag.assessment.recommendation : 'Unknown'}
`;
}

function documentDiagnosticHtml(diag) {
  const cls = diag.assessment && diag.assessment.status === 'Pass' ? 'ok' : diag.assessment && diag.assessment.status === 'Blocked' ? 'bad' : 'warn';
  const summaryText = diag.summary && diag.summary.text ? diag.summary.text : diag.summary && diag.summary.error ? diag.summary.error : 'Not run yet.';
  const answerText = diag.answer && diag.answer.text ? diag.answer.text : diag.answer && diag.answer.error ? diag.answer.error : 'Not run yet.';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Document Diagnostics</title><style>${sharedCss()}</style></head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Troubleshooting',href:'/'},{label:'Document Diagnostics'}])}<h1>Advanced Document Diagnostics</h1><p>This buried troubleshooting test uses clean TXT/Markdown text to check whether the Local AI can handle document-style work. It is separate from chat and separate from PDF extraction.</p><section class="card"><h2>Result</h2><p class="${cls}">${htmlEscape(diag.assessment ? diag.assessment.status : 'Unknown')}</p><p>${htmlEscape(diag.assessment ? diag.assessment.recommendation : '')}</p></section><section class="card"><h2>Clean text gate</h2><div class="grid"><div class="metric"><span class="label">Readable</span><br><b>${diag.cleanText.ready ? 'Yes' : 'No'}</b></div><div class="metric"><span class="label">Quality score</span><br><b>${htmlEscape(String(diag.cleanText.extractionQuality ? diag.cleanText.extractionQuality.score : 'Unknown'))}</b></div><div class="metric"><span class="label">Text length</span><br><b>${htmlEscape(String(diag.cleanText.chars))} chars</b></div><div class="metric"><span class="label">Chunks</span><br><b>${htmlEscape(String(diag.cleanText.chunks))}</b></div></div><p class="muted">Preview: ${htmlEscape(diag.cleanText.preview)}</p></section><section class="card"><h2>Local AI</h2><p>${diag.localAi ? `${htmlEscape(diag.localAi.provider)} at <code>${htmlEscape(diag.localAi.baseUrl)}</code>` : '<span class="warn">Not detected. Start Local AI, then rerun this diagnostic.</span>'}</p><div class="actions"><a class="button" href="/diagnostics/document">Run Again</a><a class="button secondary check-action" href="/recheck">Recheck Local AI</a></div></section><section class="card"><h2>Model document responses</h2><h3>Summary test</h3><pre>${htmlEscape(summaryText)}</pre><h3>Question test</h3><pre>${htmlEscape(answerText)}</pre></section><p><a class="button" href="/">Back to Phone Access</a> <a class="button secondary" href="/diagnostics/document.md">Open Markdown</a> <a class="button secondary" href="/diagnostics/document.json">Open JSON</a></p></main></body></html>`;
}

async function buildRagReadiness(result) {
  const detected = result && result.detected ? result.detected : null;
  if (!detected || !detected.baseUrl) {
    return { status: 'Unknown', score: 0, embeddingStatus: 'Unknown', vectorDimension: null, latencyMs: null, latencyQuality: 'Unknown', groundingStatus: 'Not run', recommendation: 'File readiness needs a detected local AI endpoint first.' };
  }
  const modelInfo = await listModels(detected);
  const model = (modelInfo.models || []).find(m => /embed|embedding/i.test(m)) || (modelInfo.models || [])[0] || '';
  if (!model) {
    return { status: 'Partial', score: 1, embeddingStatus: 'Unknown', vectorDimension: null, latencyMs: null, latencyQuality: 'Unknown', groundingStatus: 'Not run', recommendation: 'Endpoint is reachable, but no model list was available to test embeddings.' };
  }
  const input = 'LLM Radar checks whether local AI endpoints can support app and file workflows.';
  let res;
  if (detected.kind === 'ollama' || detected.path === '/api/tags') {
    res = await fetchJson(`${detected.baseUrl}/api/embeddings`, { method: 'POST', timeoutMs: 16000, body: { model, prompt: input } });
  } else {
    res = await fetchJson(`${detected.baseUrl}/v1/embeddings`, { method: 'POST', timeoutMs: 16000, body: { model, input } });
  }
  let vector = null;
  if (res.json && Array.isArray(res.json.embedding)) vector = res.json.embedding;
  if (res.json && Array.isArray(res.json.data) && res.json.data[0] && Array.isArray(res.json.data[0].embedding)) vector = res.json.data[0].embedding;
  const ok = !!(res.ok && vector && vector.length);
  return {
    status: ok ? 'Ready' : 'Partial',
    score: ok ? 3 : 1,
    embeddingStatus: ok ? 'Pass' : 'Not detected',
    embeddingModel: model,
    vectorDimension: ok ? vector.length : null,
    latencyMs: res.durationMs || null,
    latencyQuality: res.durationMs ? 'Measured' : 'Unknown',
    groundingStatus: ok ? 'Embeddings endpoint returned a vector. Full file grounding is not built in this no-APK preview.' : 'Not run',
    error: ok ? '' : (res.error || `Embedding endpoint returned HTTP ${res.status || 'unknown'}.`),
    recommendation: ok ? 'Embeddings are available. This endpoint is a candidate for lightweight file workflows.' : 'Chat/app tests can still pass without embeddings. Use this as a file preview, not a full file workbench.'
  };
}

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function consultantPackCsv(pack) {
  const endpoint = (pack.report && pack.report.endpoint) || {};
  const models = (pack.report && pack.report.models) || {};
  const bm = (pack.benchmark && pack.benchmark.benchmark) || {};
  const rag = pack.ragReadiness || {};
  const access = pack.accessReview || {};
  const rows = [
    ['generatedAt', pack.generatedAt],
    ['overallStatus', pack.overallStatus],
    ['endpoint', endpoint.url || ''],
    ['service', endpoint.provider || ''],
    ['model', (models.modelIds || [])[0] || ''],
    ['locality', pack.report && pack.report.locality ? pack.report.locality.status : ''],
    ['privacyRisk', pack.report && pack.report.locality ? pack.report.locality.privacyRisk : ''],
    ['accessReview', `${access.status || 'Unknown'} / ${access.risk || 'Unknown'}`],
    ['benchmarkPassCount', bm.passCount || 0],
    ['benchmarkPromptCount', bm.promptCount || 0],
    ['averageResponseMs', bm.averageResponseMs || ''],
    ['averageOutputTPS', bm.averageOutputTokensPerSecond || ''],
    ['ragReadiness', rag.status || 'Unknown'],
    ['embeddingStatus', rag.embeddingStatus || 'Unknown'],
    ['embeddingVectorDimension', rag.vectorDimension || '']
  ];
  return 'metric,value\n' + rows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
}

function profilesDir() { return path.join(appDataDir(), 'profiles'); }

function readProfilesIndex() {
  try {
    const file = path.join(profilesDir(), 'index.json');
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(row => row && typeof row === 'object');
  } catch { return []; }
}

function writeProfilesIndex(rows) {
  try {
    fs.mkdirSync(profilesDir(), { recursive: true });
    const clean = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === 'object');
    fs.writeFileSync(path.join(profilesDir(), 'index.json'), JSON.stringify(clean.slice(0, 50), null, 2), 'utf8');
  } catch {}
}

function saveProfileFromPack(pack, name) {
  const endpoint = (pack.report && pack.report.endpoint) || {};
  const models = (pack.report && pack.report.models) || {};
  const profileName = safePreview(name || `${(models.modelIds || [])[0] || 'Local AI'} on ${endpoint.hostIp || 'computer'}`, 80) || 'Local AI profile';
  const profile = {
    name: profileName,
    savedAt: new Date().toISOString(),
    endpointUrl: endpoint.url || '',
    service: endpoint.provider || 'Unknown',
    modelIds: models.modelIds || [],
    lastStatus: pack.overallStatus,
    lastBenchmarkPasses: pack.benchmark && pack.benchmark.benchmark ? pack.benchmark.benchmark.passCount : 0,
    notes: 'Saved from no-APK Consultant Pack Preview.'
  };
  fs.mkdirSync(profilesDir(), { recursive: true });
  const file = path.join(profilesDir(), `${safeFileStamp(profile.savedAt)}-${safeFileStamp(profileName).slice(0, 50)}.json`);
  fs.writeFileSync(file, JSON.stringify(profile, null, 2), 'utf8');
  const rows = readProfilesIndex();
  rows.unshift(Object.assign({ jsonPath: file }, profile));
  writeProfilesIndex(rows);
  return { ok: true, profile, jsonPath: file, count: rows.length };
}


function fileExistsSafe(file) {
  try { return !!(file && fs.existsSync(file)); } catch { return false; }
}

function dataStatus() {
  ensureDataDirs();
  const snapshots = readSnapshotIndex();
  const profiles = readProfilesIndex();
  const snapshotFilesValid = snapshots.filter(r => fileExistsSafe(r.jsonPath) && fileExistsSafe(r.markdownPath)).length;
  const profileFilesValid = profiles.filter(r => fileExistsSafe(r.jsonPath)).length;
  return {
    ok: true,
    appDataDir: appDataDir(),
    reportsDir: reportsDir(),
    profilesDir: profilesDir(),
    snapshotIndex: path.join(reportsDir(), 'index.json'),
    profileIndex: path.join(profilesDir(), 'index.json'),
    snapshotCount: snapshots.length,
    profileCount: profiles.length,
    snapshotFilesValid,
    profileFilesValid,
    latestSnapshot: snapshots[0] || null,
    latestProfile: profiles[0] || null,
    note: 'These files are stored outside the extracted release folder, so deleting older LLM Radar zip/extracted folders should not remove saved snapshots or profiles.'
  };
}

function storageHtml() {
  const st = dataStatus();
  const rows = [
    ['Persistent data folder', st.appDataDir],
    ['Reports folder', st.reportsDir],
    ['Profiles folder', st.profilesDir],
    ['Snapshot index', st.snapshotIndex],
    ['Profile index', st.profileIndex],
    ['Saved snapshots', String(st.snapshotCount)],
    ['Snapshot files valid', `${st.snapshotFilesValid}/${st.snapshotCount}`],
    ['Saved profiles', String(st.profileCount)],
    ['Profile files valid', `${st.profileFilesValid}/${st.profileCount}`]
  ].map(r => `<tr><th>${htmlEscape(r[0])}</th><td><code>${htmlEscape(r[1])}</code></td></tr>`).join('');
  const latestSnap = st.latestSnapshot ? `<li>${htmlEscape(st.latestSnapshot.generatedAt || '')} — ${htmlEscape(st.latestSnapshot.endpoint || '')}</li>` : '<li>No snapshot saved yet.</li>';
  const latestProfile = st.latestProfile ? `<li>${htmlEscape(st.latestProfile.name || '')} — ${htmlEscape(st.latestProfile.endpointUrl || '')}</li>` : '<li>No profile saved yet.</li>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Storage</title><style>${sharedCss()}</style></head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack',href:'/pack'},{label:'Storage'}])}<h1>Storage and Data</h1><p>${htmlEscape(st.note)}</p><section class="card"><h2>Persistent locations</h2><table><tbody>${rows}</tbody></table></section><section class="card"><h2>Latest saved items</h2><h3>Snapshot</h3><ul>${latestSnap}</ul><h3>Profile</h3><ul>${latestProfile}</ul></section><p><a class="button" href="/pack">Back to Consultant Pack</a> <a class="button secondary" href="/history">View History</a> <a class="button secondary" href="/profiles">View Profiles</a> <a class="button secondary" href="/">Back to Phone Access</a></p></main></body></html>`;
}

function sharedCss() {
  return `body{margin:0;background:#0B0F14;color:#E6EDF3;font-family:Segoe UI,Arial,sans-serif}.shell{width:min(1060px,92vw);margin:32px auto;background:#111822;border:1px solid #263241;border-radius:24px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.42)}h1{margin:0 0 8px;font-size:32px}h2{font-size:19px}.card{border:1px solid #263241;border-radius:16px;padding:16px;margin:14px 0;background:#0F151E}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.metric{border-top:1px solid #263241;padding:10px 0}.label{color:#9AA7B3}.ok{color:#7DD3A8;font-weight:900}.warn{color:#E6C36A;font-weight:900}.bad{color:#F08A8A;font-weight:900}p,li,small,td,th{color:#9AA7B3;line-height:1.55}table{width:100%;border-collapse:collapse}td,th{border-top:1px solid #263241;padding:10px;text-align:left}pre{background:#0B0F14;color:#E6EDF3;border:1px solid #263241;border-radius:12px;padding:10px;white-space:pre-wrap;word-break:break-word}button,.button{display:inline-block;background:#8AB4F8;color:#0B0F14;border:0;border-radius:12px;padding:11px 14px;font-weight:900;cursor:pointer;margin:6px 8px 6px 0;text-decoration:none}.button.secondary{background:#263241;color:#E6EDF3}.button.loading{opacity:.8}.button.loading:after{content:" ..."}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:8px 0 12px}.step{border-left:4px solid #8AB4F8;padding-left:14px;margin:18px 0}.muted{color:#9AA7B3}.crumbs{font-size:14px;margin:0 0 18px;color:#9AA7B3}.crumbs a{color:#8AB4F8;text-decoration:none;font-weight:800}.crumbs span{margin:0 7px;color:#607080}.feature-note{border-left:4px solid #7DD3A8;padding-left:14px}.action-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}@media(max-width:760px){.grid{grid-template-columns:1fr}}`;
}

function breadcrumbHtml(items) {
  const safe = (items || []).filter(x => x && x.label);
  if (!safe.length) return '';
  return '<nav class="crumbs" style="font-size:14px;margin:0 0 18px;color:#9AA7B3">' + safe.map((x, i) => {
    const label = htmlEscape(x.label);
    const part = x.href ? `<a style="color:#8AB4F8;text-decoration:none;font-weight:800" href="${htmlEscape(x.href)}">${label}</a>` : `<b style="color:#E6EDF3">${label}</b>`;
    return (i ? '<span style="margin:0 7px;color:#607080">›</span>' : '') + part;
  }).join('') + '</nav>';
}


function historyHtml() {
  const rows = readSnapshotIndex();
  const items = rows.map((r, i) => `<tr><td>${htmlEscape(r.generatedAt || '')}</td><td>${htmlEscape(r.overallStatus || '')}</td><td>${htmlEscape(r.endpoint || '')}</td><td>${htmlEscape(r.model || '')}</td><td><a class="button secondary" href="/snapshot?i=${i}">Open</a> <a class="button secondary" href="/snapshot.md?i=${i}">Markdown</a></td></tr>`).join('') || '<tr><td colspan="5">No snapshots saved yet.</td></tr>';
  const compareActions = rows.length >= 2
    ? '<a class="button" href="/compare">Compare Latest Snapshots</a><a class="button secondary" href="/compare.md">Open Comparison Markdown</a>'
    : '<p class="warn"><b>Comparison needs two saved snapshots.</b><br>Save another Consultant Pack later to compare changes.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Report History</title><style>${sharedCss()}</style></head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack',href:'/pack'},{label:'Report History'}])}<h1>Report History</h1><p>Saved consultant pack snapshots are stored in the persistent LLM Radar data folder, not inside the release zip folder.</p><section class="card"><h2>Storage</h2><p><code>${htmlEscape(reportsDir())}</code></p><p><a class="button secondary" href="/storage">Storage and Data</a></p></section><section class="card"><div class="actions">${compareActions}</div></section><section class="card"><table><thead><tr><th>Generated</th><th>Status</th><th>Endpoint</th><th>Model</th><th>Open</th></tr></thead><tbody>${items}</tbody></table></section><p><a class="button" href="/pack">Back to Consultant Pack</a> <a class="button secondary" href="/">Back to Phone Access</a></p></main></body></html>`;
}

function profilesHtml() {
  const rows = readProfilesIndex();
  const items = rows.map(r => `<tr><td>${htmlEscape(r.name || '')}</td><td>${htmlEscape(r.endpointUrl || '')}</td><td>${htmlEscape(r.service || '')}</td><td>${htmlEscape((r.modelIds || [])[0] || '')}</td><td>${htmlEscape(r.savedAt || '')}</td></tr>`).join('') || '<tr><td colspan="5">No profiles saved yet.</td></tr>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Profiles</title><style>${sharedCss()}</style></head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack',href:'/pack'},{label:'Saved Profiles'}])}<h1>Saved Profiles</h1><p>Computer-side local AI profiles are stored in the persistent LLM Radar data folder.</p><section class="card"><h2>Storage</h2><p><code>${htmlEscape(profilesDir())}</code></p><p><a class="button secondary" href="/storage">Storage and Data</a></p></section><section class="card"><table><thead><tr><th>Name</th><th>Endpoint</th><th>Service</th><th>Model</th><th>Saved</th></tr></thead><tbody>${items}</tbody></table></section><p><a class="button" href="/pack">Back to Consultant Pack</a> <a class="button secondary" href="/">Back to Phone Access</a></p></main></body></html>`;
}

async function buildConsultantPack(result, helperUrl, payload) {
  const report = await buildLocalAiReport(result);
  const benchmark = await buildBenchmarkReport(result);
  const invite = await buildLanInvite(result, helperUrl, payload);
  const ragReadiness = await buildRagReadiness(result);
  const previous = latestSavedPack();
  const pack = {
    app: 'LLM Radar',
    helperVersion: HELPER_VERSION,
    reportType: 'No-APK Consultant Pack Preview',
    generatedAt: new Date().toISOString(),
    overallStatus: benchmark.overallStatus === 'Ready' && report.overallStatus === 'Ready' ? 'Ready' : (report.overallStatus === 'Blocked' ? 'Blocked' : 'Partial'),
    report,
    benchmark,
    invite,
    appReadiness: appReadinessFromBenchmark(benchmark),
    ragReadiness,
    accessReview: accessReviewFromReport(report),
    comparison: null,
    recommendation: 'This consultant pack combines endpoint validation, quick benchmark, app-readiness checks, File readiness preview, LAN invite details, snapshots, and shareable exports without requiring a new APK build.'
  };
  pack.comparison = comparePackToPrevious(pack, previous);
  return pack;
}

function consultantPackCacheKey(result) {
  const detected = result && result.detected ? result.detected : null;
  return detected ? `${detected.baseUrl}|${detected.provider}|${detected.path}` : 'no-endpoint';
}

async function getConsultantPack(result, helperUrl, payload, force = false) {
  const key = consultantPackCacheKey(result);
  const maxAgeMs = 20 * 60 * 1000;
  if (!force && activePackCache && activePackCache.key === key && (Date.now() - activePackCache.savedAtMs) < maxAgeMs) {
    return activePackCache.pack;
  }
  const pack = await buildConsultantPack(result, helperUrl, payload);
  activePackCache = { key, savedAtMs: Date.now(), pack };
  return pack;
}

function invalidateConsultantPackCache() {
  activePackCache = null;
}

function consultantPackMarkdown(pack) {
  const endpoint = (pack.report && pack.report.endpoint) || {};
  const models = (pack.report && pack.report.models) || {};
  const bm = (pack.benchmark && pack.benchmark.benchmark) || {};
  const invite = pack.invite || {};
  const rag = pack.ragReadiness || {};
  const appRows = (pack.appReadiness || []).map(x => `- ${x.name}: ${x.status}${x.evidence ? ` — ${x.evidence}` : ''}`).join('\n');
  const comp = pack.comparison || {};
  return `# LLM Radar Consultant Pack Preview\n\n` +
    `Generated: ${pack.generatedAt}\n\n` +
    `## Executive summary\n` +
    `- Overall status: ${pack.overallStatus}\n` +
    `- Endpoint: ${endpoint.url || 'Not detected'}\n` +
    `- Service: ${endpoint.provider || 'Unknown'}\n` +
    `- Model: ${((models.modelIds || [])[0]) || 'Unknown'} (${models.quality || 'Unknown'})\n` +
    `- Locality: ${pack.report.locality.status} (${pack.report.locality.quality})\n` +
    `- Privacy risk: ${pack.report.locality.privacyRisk}\n` +
    `- Access review: ${pack.accessReview.status} / ${pack.accessReview.risk}\n` +
    `- File readiness: ${rag.status || 'Unknown'}; embeddings: ${rag.embeddingStatus || 'Unknown'}${rag.vectorDimension ? ` (${rag.vectorDimension} dimensions)` : ''}\n` +
    `- Quick benchmark: ${bm.passCount || 0}/${bm.promptCount || 0} prompts passed\n` +
    `- Average response: ${bm.averageResponseMs || 'Unknown'} ms (${bm.averageResponseQuality || 'Unknown'})\n` +
    `- Average output TPS: ${bm.averageOutputTokensPerSecond || 'Unknown'} (${bm.averageOutputTokensPerSecondQuality || 'Unknown'})\n\n` +
    `## App readiness preview\n${appRows || '- Unknown'}\n\n` +
    `## File readiness preview\n` +
    `- Status: ${rag.status || 'Unknown'}\n` +
    `- Embeddings: ${rag.embeddingStatus || 'Unknown'}\n` +
    `${rag.embeddingModel ? `- Embedding model tested: ${rag.embeddingModel}\n` : ''}` +
    `${rag.vectorDimension ? `- Vector dimension: ${rag.vectorDimension}\n` : ''}` +
    `${rag.latencyMs ? `- Embedding latency: ${rag.latencyMs} ms (${rag.latencyQuality})\n` : ''}` +
    `- Grounding: ${rag.groundingStatus || 'Not run'}\n` +
    `- Recommendation: ${rag.recommendation || 'Unknown'}\n\n` +
    `## LAN invite\n` +
    `- Phone URL: ${invite.pairingUrl || 'Unknown'}\n` +
    `- Endpoint URL: ${invite.endpointUrl || endpoint.url || 'Unknown'}\n` +
    `- Warning: ${invite.sameWifiWarning || 'Only share on trusted same-Wi-Fi networks.'}\n\n` +
    `## Snapshot comparison\n` +
    `- Status: ${comp.status || 'Unknown'}\n` +
    `${comp.previousGeneratedAt ? `- Previous snapshot: ${comp.previousGeneratedAt}\n` : ''}` +
    `${comp.detail ? comp.detail.split('\n').map(line => `- ${line}`).join('\n') + '\n' : ''}\n` +
    `## Recommendation\n${pack.recommendation}\n\n` +
    `## Sanitized quick response\n${pack.report.quickTest && pack.report.quickTest.responsePreview ? pack.report.quickTest.responsePreview : 'No quick response preview.'}\n`;
}


function clientBriefFromPack(pack) {
  const endpoint = (pack.report && pack.report.endpoint) || {};
  const models = (pack.report && pack.report.models) || {};
  const bm = (pack.benchmark && pack.benchmark.benchmark) || {};
  const rag = pack.ragReadiness || {};
  const access = pack.accessReview || {};
  const model = ((models.modelIds || [])[0]) || 'Unknown model';
  const endpointUrl = endpoint.url || 'Not detected';
  return {
    generatedAt: new Date().toISOString(),
    title: 'LLM Radar Client Brief',
    overallStatus: pack.overallStatus,
    endpoint: endpointUrl,
    service: endpoint.provider || 'Unknown service',
    model,
    locality: pack.report && pack.report.locality ? `${pack.report.locality.status} (${pack.report.locality.quality})` : 'Unknown',
    privacyRisk: pack.report && pack.report.locality ? pack.report.locality.privacyRisk : 'Unknown',
    benchmarkSummary: `${bm.passCount || 0}/${bm.promptCount || 0} app-readiness prompts passed`,
    responseSummary: `${bm.averageResponseMs || 'Unknown'} ms average response (${bm.averageResponseQuality || 'Unknown'}); ${bm.averageOutputTokensPerSecond || 'Unknown'} output TPS (${bm.averageOutputTokensPerSecondQuality || 'Unknown'})`,
    ragSummary: `${rag.status || 'Unknown'}; embeddings ${rag.embeddingStatus || 'Unknown'}${rag.vectorDimension ? ` (${rag.vectorDimension} dimensions)` : ''}`,
    accessSummary: `${access.status || 'Unknown'} / ${access.risk || 'Unknown'}`,
    consultantRecommendation: pack.overallStatus === 'Ready'
      ? 'This local AI setup is ready for consultant demonstration, phone pairing, and shareable reporting on a trusted same-Wi-Fi network.'
      : pack.overallStatus === 'Partial'
        ? 'This setup is usable for evaluation, but one or more readiness checks should be reviewed before presenting it as fully ready.'
        : 'This setup is not ready yet. Start the local AI server and rerun the consultant pack.'
  };
}

function clientBriefMarkdown(brief) {
  return `# ${brief.title}

` +
    `Generated: ${brief.generatedAt}

` +
    `## Bottom line
${brief.consultantRecommendation}

` +
    `## Setup
` +
    `- Overall status: ${brief.overallStatus}
` +
    `- Endpoint: ${brief.endpoint}
` +
    `- Service: ${brief.service}
` +
    `- Model: ${brief.model}
` +
    `- Locality: ${brief.locality}
` +
    `- Privacy risk: ${brief.privacyRisk}
` +
    `- Access review: ${brief.accessSummary}

` +
    `## Performance and readiness
` +
    `- Benchmark: ${brief.benchmarkSummary}
` +
    `- Response: ${brief.responseSummary}
` +
    `- File readiness: ${brief.ragSummary}
`;
}

function clientBriefHtml(brief) {
  const md = clientBriefMarkdown(brief);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Client Brief</title><style>${sharedCss()}</style><script>function copyBrief(btn){const text=document.getElementById('md').textContent;if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>{if(btn){btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy Client Brief',1600);}}).catch(()=>alert('Copy failed. Select the text and copy manually.'));}}</script></head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack',href:'/pack'},{label:'Client Brief'}])}<h1>Client Brief</h1><p>This is a shorter, client-facing summary derived from the consultant pack. It appears only after endpoint and benchmark data exist.</p><section class="card feature-note"><h2>Bottom line</h2><p>${htmlEscape(brief.consultantRecommendation)}</p></section><section class="card"><h2>Setup</h2><div class="grid"><div class="metric"><span class="label">Status</span><br><b>${htmlEscape(brief.overallStatus)}</b></div><div class="metric"><span class="label">Endpoint</span><br><b>${htmlEscape(brief.endpoint)}</b></div><div class="metric"><span class="label">Service</span><br><b>${htmlEscape(brief.service)}</b></div><div class="metric"><span class="label">Model</span><br><b>${htmlEscape(brief.model)}</b></div><div class="metric"><span class="label">Locality</span><br><b>${htmlEscape(brief.locality)}</b></div><div class="metric"><span class="label">Privacy risk</span><br><b>${htmlEscape(brief.privacyRisk)}</b></div></div></section><section class="card"><h2>Performance and readiness</h2><ul><li>${htmlEscape(brief.benchmarkSummary)}</li><li>${htmlEscape(brief.responseSummary)}</li><li>File readiness: ${htmlEscape(brief.ragSummary)}</li><li>Access review: ${htmlEscape(brief.accessSummary)}</li></ul></section><section class="card"><h2>Shareable Markdown</h2><div class="actions"><button onclick="copyBrief(this)">Copy Client Brief</button><a class="button secondary" href="/brief.md">Open Markdown</a><a class="button secondary" href="/brief.json">Open JSON</a></div><pre id="md">${htmlEscape(md)}</pre></section><p><a class="button" href="/pack">Back to Consultant Pack</a> <a class="button secondary" href="/">Back to Phone Access</a></p></main></body></html>`;
}

function readinessChecklistFromPack(pack) {
  const endpoint = (pack.report && pack.report.endpoint) || {};
  const bm = (pack.benchmark && pack.benchmark.benchmark) || {};
  const models = (pack.report && pack.report.models) || {};
  const rag = pack.ragReadiness || {};
  const invite = pack.invite || {};
  const access = pack.accessReview || {};
  const rows = [
    { area: 'Endpoint reachable', status: endpoint.url ? 'Pass' : 'Blocked', detail: endpoint.url || 'No endpoint detected.' },
    { area: 'Model list', status: (models.modelIds || []).length ? 'Pass' : 'Unknown', detail: ((models.modelIds || [])[0]) || models.error || 'No model returned.' },
    { area: 'Quick benchmark', status: bm.passCount === bm.promptCount && bm.promptCount ? 'Pass' : (bm.passCount ? 'Review' : 'Blocked'), detail: `${bm.passCount || 0}/${bm.promptCount || 0} prompts passed.` },
    { area: 'Structured JSON', status: ((bm.tests || []).find(t => t.promptId === 'structured-json') || {}).status || 'Unknown', detail: 'Useful for app/workflow readiness.' },
    { area: 'Long-context smoke', status: ((bm.tests || []).find(t => t.promptId === 'long-context-smoke') || {}).status || 'Unknown', detail: 'Small preview only; not a full context-window benchmark.' },
    { area: 'File / embeddings', status: rag.embeddingStatus === 'Pass' ? 'Pass' : 'Optional review', detail: rag.recommendation || 'Embeddings not confirmed.' },
    { area: 'LAN invite payload', status: invite.endpointUrl ? 'Pass' : 'Review', detail: invite.endpointUrl || 'Endpoint not available for invite.' },
    { area: 'Access review', status: access.risk === 'Low' ? 'Pass' : 'Review', detail: access.detail || 'Review access before sharing on Wi-Fi.' }
  ];
  const readyCount = rows.filter(r => r.status === 'Pass').length;
  return { generatedAt: new Date().toISOString(), readyCount, totalCount: rows.length, rows };
}

function readinessChecklistMarkdown(checklist) {
  return `# LLM Radar Readiness Checklist\n\nGenerated: ${checklist.generatedAt}\n\n` +
    `## Summary\n- Passed: ${checklist.readyCount}/${checklist.totalCount}\n\n` +
    checklist.rows.map(r => `## ${r.area}\n- Status: ${r.status}\n- Detail: ${r.detail}\n`).join('\n');
}


function readinessChecklistHtml(checklist) {
  const md = readinessChecklistMarkdown(checklist);
  const rows = checklist.rows.map(r => `<tr><td>${htmlEscape(r.area)}</td><td><b>${htmlEscape(r.status)}</b></td><td>${htmlEscape(r.detail)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Readiness Checklist</title><style>${sharedCss()}</style><script>function copyChecklist(btn){const text=document.getElementById('md').textContent;if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>{if(btn){btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy Checklist',1600);}}).catch(()=>alert('Copy failed. Select the text and copy manually.'));}}</script></head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack',href:'/pack'},{label:'Readiness Checklist'}])}<h1>Readiness Checklist</h1><p>This turns the consultant pack into a review checklist before APK testing resumes.</p><section class="card"><h2>Summary</h2><p class="ok"><b>${checklist.readyCount}/${checklist.totalCount}</b> checks passed or ready.</p></section><section class="card"><table><thead><tr><th>Area</th><th>Status</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></section><section class="card"><h2>Checklist Markdown</h2><div class="actions"><button onclick="copyChecklist(this)">Copy Checklist</button><a class="button secondary" href="/checklist.md">Open Markdown</a><a class="button secondary" href="/checklist.json">Open JSON</a></div><pre id="md">${htmlEscape(md)}</pre></section><p><a class="button" href="/pack">Back to Consultant Pack</a> <a class="button secondary" href="/">Back to Phone Access</a></p></main></body></html>`;
}


function snapshotRecord(index) {
  const rows = readSnapshotIndex();
  const i = Number.isFinite(Number(index)) ? Math.max(0, Number(index)) : 0;
  return { index: i, row: rows[i] || null, count: rows.length };
}

function readSnapshotPack(index = 0) {
  const rec = snapshotRecord(index);
  if (!rec.row || !rec.row.jsonPath) return { ok: false, error: 'Snapshot not found.', index: rec.index, count: rec.count };
  try {
    if (!fs.existsSync(rec.row.jsonPath)) return { ok: false, error: 'Snapshot JSON file is missing.', index: rec.index, row: rec.row, count: rec.count };
    const pack = JSON.parse(fs.readFileSync(rec.row.jsonPath, 'utf8'));
    return { ok: true, index: rec.index, row: rec.row, pack, count: rec.count };
  } catch (error) {
    return { ok: false, error: error.message || 'Could not read snapshot.', index: rec.index, row: rec.row, count: rec.count };
  }
}

function readSnapshotMarkdown(index = 0) {
  const rec = snapshotRecord(index);
  if (!rec.row || !rec.row.markdownPath) return { ok: false, markdown: '', error: 'Snapshot not found.', index: rec.index, count: rec.count };
  try {
    if (!fs.existsSync(rec.row.markdownPath)) return { ok: false, markdown: '', error: 'Snapshot Markdown file is missing.', index: rec.index, row: rec.row, count: rec.count };
    return { ok: true, markdown: fs.readFileSync(rec.row.markdownPath, 'utf8'), index: rec.index, row: rec.row, count: rec.count };
  } catch (error) {
    return { ok: false, markdown: '', error: error.message || 'Could not read snapshot Markdown.', index: rec.index, row: rec.row, count: rec.count };
  }
}

function snapshotHtml(index = 0) {
  const md = readSnapshotMarkdown(index);
  const json = readSnapshotPack(index);
  const title = md.ok ? `Snapshot ${Number(index) + 1}` : 'Snapshot unavailable';
  const body = md.ok ? htmlEscape(md.markdown) : htmlEscape(md.error || 'Snapshot unavailable.');
  const status = json.ok && json.pack ? `${json.pack.overallStatus || 'Unknown'} · ${(json.pack.report && json.pack.report.endpoint && json.pack.report.endpoint.url) || 'No endpoint'}` : (md.error || 'Snapshot unavailable.');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Snapshot</title><style>${sharedCss()}</style></head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack',href:'/pack'},{label:'Report History',href:'/history'},{label:title}])}<h1>${htmlEscape(title)}</h1><p>${htmlEscape(status)}</p><section class="card"><h2>Saved Markdown</h2><pre>${body}</pre></section><p><a class="button" href="/history">Back to History</a> <a class="button secondary" href="/pack">Back to Consultant Pack</a> <a class="button secondary" href="/">Back to Phone Access</a></p></main></body></html>`;
}

function compareLatestSnapshots() {
  const current = readSnapshotPack(0);
  const previous = readSnapshotPack(1);
  if (!current.ok) return { ok: false, status: 'No saved snapshot', detail: 'Save a consultant pack snapshot first.', current: null, previous: null };
  if (!previous.ok) return { ok: false, status: 'No previous snapshot', detail: 'Save a second consultant pack later to compare changes.', current: current.pack, previous: null };
  const comparison = comparePackToPrevious(current.pack, previous.pack);
  return { ok: true, status: comparison.status, detail: comparison.detail, previousGeneratedAt: comparison.previousGeneratedAt, current: current.pack, previous: previous.pack };
}

function snapshotCompareMarkdown(compare) {
  return `# LLM Radar Snapshot Comparison\n\n` +
    `Generated: ${new Date().toISOString()}\n\n` +
    `## Status\n- ${compare.status || 'Unknown'}\n\n` +
    `${compare.previousGeneratedAt ? `- Previous snapshot: ${compare.previousGeneratedAt}\n\n` : ''}` +
    `## Details\n${compare.detail || 'No comparison details available.'}\n`;
}

function snapshotCompareHtml(compare) {
  const md = snapshotCompareMarkdown(compare);
  const rows = (compare.detail || '').split('\n').filter(Boolean).map(x => `<li>${htmlEscape(x)}</li>`).join('') || '<li>No comparison details yet.</li>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Snapshot Comparison</title><style>${sharedCss()}</style><script>function copyCompare(btn){const text=document.getElementById('md').textContent;if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>{if(btn){btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy Comparison',1600);}}).catch(()=>alert('Copy failed. Select the text and copy manually.'));}}</script></head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack',href:'/pack'},{label:'Report History',href:'/history'},{label:'Snapshot Comparison'}])}<h1>Snapshot Comparison</h1><p class="${compare.ok ? 'ok' : 'warn'}">${htmlEscape(compare.status || 'Unknown')}</p><section class="card"><h2>Changes</h2><ul>${rows}</ul></section><section class="card"><h2>Shareable comparison</h2><div class="actions"><button onclick="copyCompare(this)">Copy Comparison</button><a class="button secondary" href="/compare.md">Open Markdown</a><a class="button secondary" href="/compare.json">Open JSON</a></div><pre id="md">${htmlEscape(md)}</pre></section><p><a class="button" href="/history">Back to History</a> <a class="button secondary" href="/pack">Back to Consultant Pack</a> <a class="button secondary" href="/">Back to Phone Access</a></p></main></body></html>`;
}

function exportBundleFromPack(pack) {
  const brief = clientBriefFromPack(pack);
  const checklist = readinessChecklistFromPack(pack);
  return {
    generatedAt: new Date().toISOString(),
    consultantPack: pack,
    clientBrief: brief,
    readinessChecklist: checklist,
    storage: dataStatus()
  };
}

function exportBundleMarkdown(bundle) {
  return `# LLM Radar No-APK Baseline Bundle\n\n` +
    `Generated: ${bundle.generatedAt}\n\n` +
    `## Persistent storage\n` +
    `- Data folder: ${bundle.storage.appDataDir}\n` +
    `- Reports folder: ${bundle.storage.reportsDir}\n` +
    `- Profiles folder: ${bundle.storage.profilesDir}\n` +
    `- Snapshots saved: ${bundle.storage.snapshotCount}\n` +
    `- Profiles saved: ${bundle.storage.profileCount}\n\n` +
    `---\n\n` + consultantPackMarkdown(bundle.consultantPack) +
    `\n---\n\n` + clientBriefMarkdown(bundle.clientBrief) +
    `\n---\n\n` + readinessChecklistMarkdown(bundle.readinessChecklist);
}

function exportBundleHtml(bundle) {
  const md = exportBundleMarkdown(bundle);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Export Bundle</title><style>${sharedCss()}</style><script>function copyBundle(btn){const text=document.getElementById('md').textContent;if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>{if(btn){btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy Bundle',1600);}}).catch(()=>alert('Copy failed. Select the text and copy manually.'));}}</script></head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack',href:'/pack'},{label:'Export Bundle'}])}<h1>No-APK Baseline Bundle</h1><p>This consolidates the consultant pack, client brief, readiness checklist, and persistent storage summary before the next APK build.</p><section class="card"><h2>Bundle actions</h2><div class="actions"><button onclick="copyBundle(this)">Copy Bundle</button><a class="button secondary" href="/bundle.md">Open Markdown</a><a class="button secondary" href="/bundle.json">Open JSON</a></div><pre id="md">${htmlEscape(md)}</pre></section><p><a class="button" href="/pack">Back to Consultant Pack</a> <a class="button secondary" href="/">Back to Phone Access</a></p></main></body></html>`;
}

function saveConsultantPackSnapshot(pack) {
  fs.mkdirSync(reportsDir(), { recursive: true });
  const stamp = safeFileStamp(pack.generatedAt);
  const base = `LLM-Radar-Consultant-Pack-${stamp}`;
  const mdPath = path.join(reportsDir(), `${base}.md`);
  const jsonPath = path.join(reportsDir(), `${base}.json`);
  fs.writeFileSync(mdPath, consultantPackMarkdown(pack), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(pack, null, 2), 'utf8');
  const rows = readSnapshotIndex();
  rows.unshift({ generatedAt: pack.generatedAt, overallStatus: pack.overallStatus, endpoint: pack.report && pack.report.endpoint ? pack.report.endpoint.url : '', model: ((pack.report && pack.report.models && pack.report.models.modelIds) || [])[0] || '', markdownPath: mdPath, jsonPath });
  writeSnapshotIndex(rows);
  return { ok: true, markdownPath: mdPath, jsonPath, count: rows.length };
}

function consultantPackHtml(pack) {
  const endpoint = (pack.report && pack.report.endpoint) || {};
  const models = (pack.report && pack.report.models) || {};
  const bm = (pack.benchmark && pack.benchmark.benchmark) || {};
  const access = pack.accessReview || {};
  const comp = pack.comparison || {};
  const rag = pack.ragReadiness || {};
  const invite = pack.invite || {};
  const appRows = (pack.appReadiness || []).map(x => `<div class="metric"><span class="label">${htmlEscape(x.name)}</span><br><b>${htmlEscape(x.status)}</b><br><small>${htmlEscape(x.evidence || '')}</small></div>`).join('');
  const badgeClass = pack.overallStatus === 'Ready' ? 'ok' : pack.overallStatus === 'Partial' ? 'warn' : 'bad';
  const md = consultantPackMarkdown(pack);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Consultant Pack</title>
<style>${sharedCss()}.stage-title{display:flex;gap:10px;align-items:center}.stage-number{background:#8AB4F8;color:#0B0F14;border-radius:999px;width:30px;height:30px;display:grid;place-items:center;font-weight:900}.primary-action{background:#8AB4F8}.export-action{background:#7DD3A8}.secondary-action{background:#263241;color:#E6EDF3}.disabled-note{color:#9AA7B3;font-size:13px}</style>
<script>
function copyPack(btn){const text=document.getElementById('md').textContent;if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>{if(btn){btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy Markdown',1600);}}).catch(()=>alert('Copy failed. Select the text and copy manually.'));}}
function savePack(btn){fetch('/pack/save',{method:'POST'}).then(r=>r.json()).then(j=>{document.getElementById('saveStatus').textContent=j.ok?'Saved snapshot to persistent reports folder.':'Save failed.'; if(btn&&j.ok){btn.textContent='Saved Snapshot';setTimeout(()=>btn.textContent='Save Snapshot',1600);}}).catch(()=>{document.getElementById('saveStatus').textContent='Save failed.';});}
function saveProfile(btn){fetch('/pack/profile',{method:'POST'}).then(r=>r.json()).then(j=>{document.getElementById('profileStatus').textContent=j.ok?'Saved profile: '+(j.profile&&j.profile.name?j.profile.name:'Local AI profile'):'Profile save failed.'; if(btn&&j.ok){btn.textContent='Saved Profile';setTimeout(()=>btn.textContent='Save Profile',1600);}}).catch(()=>{document.getElementById('profileStatus').textContent='Profile save failed.';});}
</script>
</head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack'}])}<h1>LLM Radar Consultant Pack Plus</h1><p>This no-APK pack keeps the user in a logical flow: validate first, analyze after data exists, then save/export/share. Navigation pages reuse the current pack so users do not accidentally rerun benchmarks while browsing.</p><div class="actions"><a class="button secondary-action" href="/pack?refresh=1">Refresh Consultant Pack</a></div>
<section class="card step"><div class="stage-title"><span class="stage-number">1</span><h2>Validate local AI</h2></div><p class="${badgeClass}">${htmlEscape(pack.overallStatus)}</p><div class="grid"><div class="metric"><span class="label">Endpoint</span><br><b>${htmlEscape(endpoint.url || 'Not detected')}</b></div><div class="metric"><span class="label">Service</span><br><b>${htmlEscape(endpoint.provider || 'Unknown')}</b></div><div class="metric"><span class="label">Model</span><br><b>${htmlEscape((models.modelIds || [])[0] || 'Unknown')}</b></div><div class="metric"><span class="label">Benchmark</span><br><b>${htmlEscape(String(bm.passCount || 0))}/${htmlEscape(String(bm.promptCount || 0))} prompts passed</b></div><div class="metric"><span class="label">Average response</span><br><b>${htmlEscape(String(bm.averageResponseMs || 'Unknown'))} ms</b></div><div class="metric"><span class="label">Average output TPS</span><br><b>${htmlEscape(String(bm.averageOutputTokensPerSecond || 'Unknown'))}</b> <span class="label">(${htmlEscape(bm.averageOutputTokensPerSecondQuality || 'Unknown')})</span></div></div></section>
<section class="card step"><div class="stage-title"><span class="stage-number">2</span><h2>Analyze readiness</h2></div><div class="grid"><div class="metric"><span class="label">Locality</span><br><b>${htmlEscape(pack.report.locality.status)}</b> <span class="label">(${htmlEscape(pack.report.locality.quality)})</span></div><div class="metric"><span class="label">Privacy risk</span><br><b>${htmlEscape(pack.report.locality.privacyRisk)}</b></div><div class="metric"><span class="label">Access review</span><br><b>${htmlEscape(access.status || 'Unknown')}</b> / <b>${htmlEscape(access.risk || 'Unknown')}</b></div><div class="metric"><span class="label">File readiness</span><br><b>${htmlEscape(rag.status || 'Unknown')}</b><br><small>${htmlEscape(rag.embeddingStatus || 'Unknown')}${rag.vectorDimension ? ` · ${htmlEscape(String(rag.vectorDimension))} dimensions` : ''}</small></div></div><p>${htmlEscape(access.detail || '')}</p><p>${htmlEscape(rag.recommendation || '')}</p></section>
<section class="card step"><div class="stage-title"><span class="stage-number">3</span><h2>App-readiness checks</h2></div><div class="grid">${appRows}</div></section>
<section class="card step"><div class="stage-title"><span class="stage-number">4</span><h2>Save and compare</h2></div><p><b>${htmlEscape(comp.status || 'Unknown')}</b></p><pre>${htmlEscape(comp.detail || 'No comparison details yet.')}</pre><div class="actions"><button class="primary-action" onclick="savePack(this)">Save Snapshot</button><button class="primary-action" onclick="saveProfile(this)">Save Profile</button><a class="button secondary-action" href="/history">View History</a><a class="button secondary-action" href="/profiles">View Profiles</a></div><p id="saveStatus" class="ok"></p><p id="profileStatus" class="ok"></p></section>
<section class="card step"><div class="stage-title"><span class="stage-number">5</span><h2>Export and share</h2></div><p>These actions appear here because metrics, endpoint data, and report content now exist.</p><div class="actions"><button class="export-action" onclick="copyPack(this)">Copy Markdown</button><a class="button export-action" href="/pack.json">Open JSON</a><a class="button export-action" href="/pack.csv">Export CSV</a><a class="button secondary-action" href="/brief">Client Brief</a><a class="button secondary-action" href="/checklist">Readiness Checklist</a><a class="button secondary-action" href="/invite">Preview LAN Invite</a><a class="button secondary-action" href="/bundle">Export Baseline Bundle</a><a class="button secondary-action" href="/storage">Storage and Data</a></div><p class="disabled-note">LAN invite endpoint: ${htmlEscape(invite.endpointUrl || endpoint.url || 'Unknown')}</p><pre id="md">${htmlEscape(md)}</pre></section>
<p><a class="button secondary-action" href="/">Back to Phone Access</a></p></main></body></html>`;
}

function reportHtml(report) {
  const endpoint = report.endpoint || {};
  const models = report.models || {};
  const quick = report.quickTest || {};
  const modelRows = (models.modelIds || []).slice(0, 12).map(m => `<li>${htmlEscape(m)}</li>`).join('') || '<li>Unknown / not returned</li>';
  const badgeClass = report.overallStatus === 'Ready' ? 'ok' : report.overallStatus === 'Partial' ? 'warn' : 'bad';
  const md = reportMarkdown(report);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Report Preview</title>
<style>body{margin:0;background:#0B0F14;color:#E6EDF3;font-family:Segoe UI,Arial,sans-serif}.shell{width:min(980px,92vw);margin:32px auto;background:#111822;border:1px solid #263241;border-radius:24px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.42)}h1{margin:0 0 8px;font-size:32px}h2{font-size:19px}.card{border:1px solid #263241;border-radius:16px;padding:16px;margin:14px 0;background:#0F151E}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.metric{border-top:1px solid #263241;padding:10px 0}.label{color:#9AA7B3}.ok{color:#7DD3A8;font-weight:900}.warn{color:#E6C36A;font-weight:900}.bad{color:#F08A8A;font-weight:900}p,li{color:#9AA7B3;line-height:1.55}code,pre{background:#0B0F14;color:#E6EDF3;border:1px solid #263241;border-radius:12px;padding:10px;white-space:pre-wrap;word-break:break-word}button,.button{display:inline-block;background:#8AB4F8;color:#0B0F14;border:0;border-radius:12px;padding:11px 14px;font-weight:900;cursor:pointer;margin:6px 8px 6px 0;text-decoration:none}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:8px 0 12px}@media(max-width:760px){.grid{grid-template-columns:1fr}}</style>
<script>function copyReport(btn){const text=document.getElementById('md').textContent;if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>{if(btn){btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy Markdown Report',1600);}}).catch(()=>alert('Copy failed. Select the text and copy manually.'));}}</script>
</head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access',href:'/'},{label:'Consultant Pack',href:'/pack'},{label:'Report Preview'}])}<h1>LLM Radar Report Preview</h1><p>This is a no-APK computer-side validation report. It proves the local AI endpoint is reachable and gives a consultant-readable preview without requiring a phone build.</p>
<section class="card"><h2>Executive summary</h2><p class="${badgeClass}">${htmlEscape(report.overallStatus)}</p><div class="grid"><div class="metric"><span class="label">Endpoint</span><br><b>${htmlEscape(endpoint.url || 'Not detected')}</b></div><div class="metric"><span class="label">Service</span><br><b>${htmlEscape(endpoint.provider || 'Unknown')}</b></div><div class="metric"><span class="label">Locality</span><br><b>${htmlEscape(report.locality.status)}</b> <span class="label">(${htmlEscape(report.locality.quality)})</span></div><div class="metric"><span class="label">Privacy risk</span><br><b>${htmlEscape(report.locality.privacyRisk)}</b></div></div><p>${htmlEscape(report.recommendation)}</p></section>
<section class="card"><h2>Endpoint evidence</h2><div class="grid"><div class="metric"><span class="label">Computer IP</span><br><b>${htmlEscape(endpoint.hostIp || 'Unknown')}</b></div><div class="metric"><span class="label">Port</span><br><b>${htmlEscape(String(endpoint.port || 'Unknown'))}</b></div><div class="metric"><span class="label">Detected path</span><br><b>${htmlEscape(endpoint.detectedPath || 'Unknown')}</b></div><div class="metric"><span class="label">Detection latency</span><br><b>${htmlEscape(String(endpoint.detectionLatencyMs || 'Unknown'))} ms</b> <span class="label">(${htmlEscape(endpoint.detectionLatencyQuality || 'Unknown')})</span></div></div></section>
<section class="card"><h2>Model list</h2><p>Status: <b>${htmlEscape(models.status || 'Unknown')}</b> <span class="label">(${htmlEscape(models.quality || 'Unknown')})</span></p><ul>${modelRows}</ul>${models.error ? `<p class="warn">${htmlEscape(models.error)}</p>` : ''}</section>
<section class="card"><h2>Quick prompt test</h2><div class="grid"><div class="metric"><span class="label">Status</span><br><b>${htmlEscape(quick.status || 'Unknown')}</b></div><div class="metric"><span class="label">Response time</span><br><b>${htmlEscape(String(quick.responseTimeMs || 'Unknown'))} ms</b> <span class="label">(${htmlEscape(quick.responseTimeQuality || 'Unknown')})</span></div><div class="metric"><span class="label">Output tokens</span><br><b>${htmlEscape(String(quick.outputTokens || 'Unknown'))}</b> <span class="label">(${htmlEscape(quick.outputTokensQuality || 'Unknown')})</span></div><div class="metric"><span class="label">Output TPS</span><br><b>${htmlEscape(String(quick.outputTokensPerSecond || 'Unknown'))}</b> <span class="label">(${htmlEscape(quick.outputTokensPerSecondQuality || 'Unknown')})</span></div></div><p><b>Sanitized response preview:</b></p><pre>${htmlEscape(quick.responsePreview || 'No response preview.')}</pre>${quick.error ? `<p class="warn">${htmlEscape(quick.error)}</p>` : ''}</section>
<section class="card"><h2>Shareable text</h2><div class="actions"><button onclick="copyReport(this)">Copy Markdown Report</button><a class="button" href="/report.json">Open JSON</a><a class="button" href="/benchmark">Run Quick Benchmark</a><a class="button" href="/invite">Preview LAN Invite</a><a class="button" href="/pack">Run Consultant Pack</a></div><pre id="md">${htmlEscape(md)}</pre></section>
<p><a class="button" href="/pack">Back to Consultant Pack</a> <a class="button secondary" href="/">Back to Phone Access</a></p></main></body></html>`;
}

async function detectAtBase(baseUrl, port, timeoutMs = TIMEOUT_MS) {
  const openAiCheck = { path: '/v1/models', kind: port === 1234 ? 'lm-studio' : port === 8080 ? 'llama-server' : 'openai-compatible', provider: port === 1234 ? 'OpenAI-compatible endpoint (LM Studio-style)' : port === 8080 ? 'OpenAI-compatible endpoint (port 8080; likely llama-server)' : 'OpenAI-compatible endpoint', match: t => /"data"\s*:/.test(t) || /"object"\s*:\s*"list"/.test(t) };
  const ollamaCheck = { path: '/api/tags', kind: 'ollama', provider: 'Ollama', match: t => /"models"\s*:/.test(t) };
  const rootCheck = { path: '/', kind: port === 3000 ? 'open-webui' : 'unknown', provider: port === 3000 ? 'Open WebUI / web UI' : 'Local web/API service', match: t => /open webui|llama|localai|ollama|lm studio/i.test(t) };
  let checks;
  if (port === 8080 || port === 1234 || port === 5000 || port === 8000) checks = [openAiCheck, ollamaCheck, rootCheck];
  else if (port === 11434) checks = [ollamaCheck, openAiCheck, rootCheck];
  else if (port === 3000) checks = [rootCheck, openAiCheck, ollamaCheck];
  else checks = [openAiCheck, ollamaCheck, rootCheck];
  for (const check of checks) {
    const res = await fetchText(`${baseUrl}${check.path}`, timeoutMs);
    if (res.ok && check.match(res.text || '')) {
      return { baseUrl, port, kind: check.kind, provider: check.provider, path: check.path, status: res.status, durationMs: res.durationMs };
    }
  }
  return null;
}

async function fastKnownService(candidates) {
  const ports = KNOWN_AI_PORT ? [KNOWN_AI_PORT] : [8080, 11434, 1234];
  const priorityIps = [];
  if (candidates[0]) priorityIps.push(candidates[0]);
  for (const ip of candidates.slice(1)) priorityIps.push(ip);
  for (const port of ports) {
    for (const ip of priorityIps) {
      const base = `http://${ip.address}:${port}`;
      const detected = await detectAtBase(base, port, 550);
      if (detected) return { detected, ip, attempts: [{ ip: ip.address, adapter: ip.name, port, ok: true, fastPath: true }] };
    }
    const local = await detectAtBase(`http://127.0.0.1:${port}`, port, 550);
    if (local) return { detected: null, ip: candidates[0] || null, localhostOnlyFast: local, attempts: [{ ip: '127.0.0.1', adapter: 'localhost', port, ok: true, fastPath: true, localhostOnly: true }] };
  }
  return null;
}

async function findLocalhostServices() {
  const found = [];
  const ports = KNOWN_AI_PORT ? [KNOWN_AI_PORT, ...PORTS.filter(p => p !== KNOWN_AI_PORT)] : PORTS;
  for (const port of ports) {
    const hit = await detectAtBase(`http://127.0.0.1:${port}`, port);
    if (hit) found.push({ ...hit, port });
  }
  return found;
}

async function findLanService(candidates) {
  const attempts = [];
  const ports = KNOWN_AI_PORT ? [KNOWN_AI_PORT, ...PORTS.filter(p => p !== KNOWN_AI_PORT)] : PORTS;
  for (const candidate of candidates) {
    for (const port of ports) {
      const base = `http://${candidate.address}:${port}`;
      const detected = await detectAtBase(base, port);
      attempts.push({ ip: candidate.address, adapter: candidate.name, port, ok: !!detected });
      if (detected) return { detected, ip: candidate, attempts };
    }
  }
  return { detected: null, ip: candidates[0] || null, attempts };
}

async function runDiagnostics() {
  const candidates = getCandidateIps();
  const fast = await fastKnownService(candidates);
  if (fast && fast.detected) {
    return { ...fast, candidates, localOnly: [], generatedAt: new Date().toISOString(), fastPath: true };
  }
  const localOnly = await findLocalhostServices();
  if (fast && fast.localhostOnlyFast && !localOnly.some(x => x.port === fast.localhostOnlyFast.port)) localOnly.unshift(fast.localhostOnlyFast);
  const lan = await findLanService(candidates);
  return { ...lan, candidates, localOnly, generatedAt: new Date().toISOString(), fastPath: false };
}

async function runDiagnosticsCached(options = {}) {
  const force = !!options.force;
  const maxAgeMs = Number(options.maxAgeMs || DIAGNOSTICS_CACHE_MS);
  const now = Date.now();
  if (!force && activeResult && lastDiagnosticsAt && now - lastDiagnosticsAt < maxAgeMs) return activeResult;
  if (diagnosticsInFlight) return diagnosticsInFlight;
  diagnosticsInFlight = runDiagnostics()
    .then(result => {
      activeResult = result;
      lastDiagnosticsAt = Date.now();
      return result;
    })
    .finally(() => { diagnosticsInFlight = null; });
  return diagnosticsInFlight;
}

function htmlEscape(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openUrl(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, { windowsHide: true }, () => {});
}

function openFolder(folderPath) {
  const target = folderPath || process.cwd();
  if (process.platform === 'win32') return execFile('explorer.exe', [target], { windowsHide: true }, () => {});
  if (process.platform === 'darwin') return execFile('open', [target], { windowsHide: true }, () => {});
  return execFile('xdg-open', [target], { windowsHide: true }, () => {});
}

function makeQrSvg(payload, moduleSize = 6, margin = 4) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(payload);
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + margin * 2) * moduleSize;
  const rects = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        rects.push(`<rect x="${(col + margin) * moduleSize}" y="${(row + margin) * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="LLM Radar pairing QR" viewBox="0 0 ${size} ${size}" width="300" height="300"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;
}

function pairingPayload(result, helperUrl) {
  const detected = result.detected;
  if (!detected) return '';
  return JSON.stringify({
    type: 'llm-radar-pairing',
    version: 2,
    helperVersion: HELPER_VERSION,
    helperUrl,
    endpointUrl: detected.baseUrl,
    baseUrl: detected.baseUrl,
    serviceHint: detected.kind,
    provider: detected.provider,
    detectedPath: detected.path,
    computerName: os.hostname(),
    computerIp: result.ip ? result.ip.address : '',
    laptopName: os.hostname(),
    laptopIp: result.ip ? result.ip.address : '',
    helperPort: activeHelperPort,
    aiPort: detected.port,
    verifiedOnComputerLan: true,
    verifiedOnLaptopLan: true,
    createdAt: new Date().toISOString()
  });
}

function resolvePowerShellExe() {
  if (process.platform !== 'win32') return null;
  const root = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'pwsh.exe',
    'powershell.exe'
  ];
  for (const candidate of candidates) {
    if (/^[A-Za-z]:\\/.test(candidate) && fs.existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

function runPowerShell(script, timeoutMs = 9000) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ ok: false, stdout: '', stderr: 'PowerShell checks are Windows-only.' });
    const psExe = resolvePowerShellExe();
    if (!psExe) return resolve({ ok: false, stdout: '', stderr: 'PowerShell is not available on this device.' });
    execFile(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || error?.message || '') });
    });
  });
}

function psSingleQuote(s) {
  return String(s || '').replace(/'/g, "''");
}

async function getFirewallDiagnostics(helperPort, aiPort) {
  if (process.platform !== 'win32') return { supported: false, note: 'Windows diagnostics are available on Windows only.' };
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$profile = Get-NetFirewallProfile -Profile Private | Select-Object Name,Enabled,DefaultInboundAction,AllowInboundRules,AllowLocalFirewallRules,NotifyOnListen
function Get-PortRule([int]$Port) {
  $rows = @()
  Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True | ForEach-Object {
    $rule = $_
    $pf = $rule | Get-NetFirewallPortFilter
    if ($pf -and $pf.Protocol -eq 'TCP' -and ($pf.LocalPort -eq 'Any' -or $pf.LocalPort -eq [string]$Port)) {
      $rows += [PSCustomObject]@{ DisplayName=$rule.DisplayName; Profile=[string]$rule.Profile; Program=''; LocalPort=[string]$pf.LocalPort }
    }
  }
  $rows
}
$helperRules = @(Get-PortRule ${Number(helperPort) || DEFAULT_HELPER_PORT})
$aiRules = @()
if (${Number(aiPort) || 0} -gt 0) { $aiRules = @(Get-PortRule ${Number(aiPort) || 0}) }
$helperProgram = '${psSingleQuote(process.execPath)}'
$programRules = @()
Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True | ForEach-Object {
  $rule = $_
  $af = $rule | Get-NetFirewallApplicationFilter
  if ($af -and $af.Program -and ($af.Program -ieq $helperProgram)) {
    $programRules += [PSCustomObject]@{ DisplayName=$rule.DisplayName; Profile=[string]$rule.Profile; Program=$af.Program }
  }
}
[PSCustomObject]@{
  supported=$true
  helperPort=${Number(helperPort) || DEFAULT_HELPER_PORT}
  aiPort=${Number(aiPort) || 0}
  profile=$profile
  helperPortRules=$helperRules
  aiPortRules=$aiRules
  helperProgram=$helperProgram
  helperProgramRules=$programRules
} | ConvertTo-Json -Depth 6 -Compress
`;
  const res = await runPowerShell(ps);
  if (!res.ok) return { supported: true, error: res.stderr || 'Could not read firewall settings.' };
  try { return JSON.parse(res.stdout); } catch { return { supported: true, error: 'Could not parse firewall settings.', raw: res.stdout }; }
}

function summarizeFirewall(fw, result) {
  if (!fw || !fw.supported) return '<p class="warn">Windows diagnostics are available on Windows only.</p>';
  if (fw.error) return `<p class="warn"><b>Refresh needed.</b><br>Use Refresh Status, or re-run <code>Start_Here.bat</code> if phone access fails.</p><details><summary>Technical detail</summary><pre>${htmlEscape(fw.error)}</pre></details>`;
  const p = fw.profile || {};
  const helperRules = Array.isArray(fw.helperPortRules) ? fw.helperPortRules : fw.helperPortRules ? [fw.helperPortRules] : [];
  const aiRules = Array.isArray(fw.aiPortRules) ? fw.aiPortRules : fw.aiPortRules ? [fw.aiPortRules] : [];
  const programRules = Array.isArray(fw.helperProgramRules) ? fw.helperProgramRules : fw.helperProgramRules ? [fw.helperProgramRules] : [];
  const inboundOk = p.AllowInboundRules === true || String(p.AllowInboundRules).toLowerCase() === 'true';
  const localOk = p.AllowLocalFirewallRules === true || String(p.AllowLocalFirewallRules).toLowerCase() === 'true' || String(p.AllowLocalFirewallRules).toLowerCase() === 'notconfigured';
  const firewallOn = p.Enabled === true || String(p.Enabled).toLowerCase() === 'true';
  const helperPortOk = helperRules.length > 0;
  const aiPortOk = !result.detected || aiRules.length > 0;
  const programOk = programRules.length > 0;
  const row = (ok, label, detail) => `<div class="fwrow"><span class="${ok ? 'ok' : 'bad'}">${ok ? 'PASS' : 'NEEDS ACTION'}</span><div><b>${label}</b><br><small>${detail}</small></div></div>`;
  const infoRow = (label, detail) => `<div class="fwrow"><span class="warn">OPTIONAL</span><div><b>${label}</b><br><small>${detail}</small></div></div>`;
  return `    ${row(firewallOn, 'Private firewall is enabled', 'LLM Radar keeps Windows Firewall on and uses narrow allow rules.')}
    ${row(inboundOk, 'Inbound allow rules are honored', `AllowInboundRules = ${htmlEscape(String(p.AllowInboundRules))}. If false, port rules exist but your phone is still blocked.`)}
    ${row(localOk, 'Local firewall rules are honored', `AllowLocalFirewallRules = ${htmlEscape(String(p.AllowLocalFirewallRules))}.`)}
    ${row(helperPortOk, `Phone Access port ${fw.helperPort} is allowed`, `Rules found: ${helperRules.length}.`)}
    ${row(aiPortOk, result.detected ? `AI server port ${result.detected.port} is allowed` : 'AI server port rule', result.detected ? `Phone needs this to reach ${htmlEscape(result.detected.provider)}. Rules found: ${aiRules.length}.` : 'No LAN-ready AI endpoint detected yet.')}
    ${infoRow('Phone Access program rule', `${programOk ? 'Present' : 'Not present'}. Program: ${htmlEscape(fw.helperProgram || process.execPath)}. Rules found: ${programRules.length}.`)}
    <details><summary>Advanced: remove LLM Radar firewall rules</summary><p class="warn">Run <code>tools\\Remove_LLM_Radar_Firewall_Rules_Admin.bat</code>. It asks for administrator permission and removes only LLM Radar-named rules.</p></details>
    <details><summary>Firewall JSON</summary><pre>${htmlEscape(JSON.stringify(fw, null, 2))}</pre></details>`;
}

async function buildDoctor(result, helperUrl) {
  const detected = result.detected || null;
  const fw = await getFirewallDiagnostics(activeHelperPort, detected ? detected.port : 0);
  const storage = dataStatus();
  const rag = ragDocumentStatus();
  let modelInfo = { ok: false, models: [], error: 'No LAN-ready endpoint detected.' };
  if (detected) {
    try { modelInfo = await listModels(detected); } catch (error) { modelInfo = { ok: false, models: [], error: error.message || String(error) }; }
  }
  const checks = [];
  checks.push({ label: 'LLM Radar computer service', status: helperUrl ? 'pass' : 'fail', detail: helperUrl || 'LLM Radar computer URL not available.' });
  checks.push({ label: 'LAN-ready local AI endpoint', status: detected ? 'pass' : 'fail', detail: detected ? `${detected.provider} at ${detected.baseUrl}` : 'No endpoint detected on the computer LAN address.' });
  checks.push({ label: 'Model inventory', status: modelInfo.ok ? 'pass' : 'review', detail: modelInfo.ok ? modelInfo.models.slice(0, 5).join(', ') : modelInfo.error || 'No model data returned.' });
  checks.push({ label: 'Loaded file', status: rag.ready ? 'pass' : 'review', detail: rag.ready ? `${rag.filename} · ${rag.chunkCount} chunks` : 'No file loaded yet.' });
  checks.push({ label: 'Persistent storage', status: storage.ok ? 'pass' : 'review', detail: storage.appDataDir || 'Storage path not available.' });
  const helperRules = fw && fw.helperPortRules ? (Array.isArray(fw.helperPortRules) ? fw.helperPortRules : [fw.helperPortRules]) : [];
  const aiRules = fw && fw.aiPortRules ? (Array.isArray(fw.aiPortRules) ? fw.aiPortRules : [fw.aiPortRules]) : [];
  checks.push({ label: 'Firewall phone-access rule', status: helperRules.length ? 'pass' : 'review', detail: `${helperRules.length} LLM Radar phone-access rules found for ${activeHelperPort}. This port covers QR, chat/status, and file upload.` });
  checks.push({ label: 'Firewall AI rule', status: !detected || aiRules.length ? 'pass' : 'review', detail: detected ? `${aiRules.length} AI port rules found for ${detected.port}.` : 'Skipped until local AI endpoint is detected.' });
  const fail = checks.filter(c => c.status === 'fail').length;
  const review = checks.filter(c => c.status === 'review').length;
  const summary = fail ? 'Blocked: LLM Radar is running but Local AI is not fully LAN-ready.' : review ? 'Review recommended: LLM Radar is usable, but one or more proof items are incomplete.' : 'Ready: LLM Radar, endpoint, models, storage, firewall, and file test are available.';
  return {
    ok: fail === 0,
    app: 'LLM Radar',
    helperVersion: HELPER_VERSION,
    generatedAt: new Date().toISOString(),
    summary,
    checks,
    helper: { helperUrl, helperPort: activeHelperPort, host: os.hostname(), phoneTouches: phoneTouches.slice(-12) },
    localAi: detected ? { provider: detected.provider, kind: detected.kind, baseUrl: detected.baseUrl, port: detected.port, detectedPath: detected.path } : null,
    models: modelInfo,
    rag,
    storage,
    firewall: fw,
    nextAction: fail ? 'Start Local AI with LAN access, then refresh.' : review ? 'Complete review items, then use Files or Consultant Pack.' : 'Connected. Continue on the phone.'
  };
}

function doctorMarkdown(doctor) {
  const checks = (doctor.checks || []).map(c => `- ${String(c.status || 'unknown').toUpperCase()}: ${c.label} — ${c.detail || ''}`).join('\n') || '- No checks returned.';
  return `# LLM Radar Doctor\n\nGenerated: ${doctor.generatedAt}\nVersion: ${doctor.helperVersion}\n\n## Summary\n${doctor.summary}\n\n## Checks\n${checks}\n\n## Next action\n${doctor.nextAction}\n`;
}

function publicResult(result, helperUrl, firewall = null) {
  const detected = result.detected || null;
  return {
    ok: !!detected,
    helper: { app: 'LLM Radar', version: HELPER_VERSION, helperUrl, helperPort: activeHelperPort, host: os.hostname(), phoneTouches },
    laptop: {
      bestIp: result.ip ? result.ip.address : '',
      adapter: result.ip ? result.ip.name : '',
      candidates: result.candidates || []
    },
    firewall,
    localAi: detected ? {
      provider: detected.provider,
      kind: detected.kind,
      baseUrl: detected.baseUrl,
      endpointUrl: detected.baseUrl,
      detectedPath: detected.path,
      healthUrl: `${detected.baseUrl}${detected.path}`,
      port: detected.port,
      lanReady: true
    } : null,
    localOnly: result.localOnly || [],
    attempts: result.attempts || [],
    generatedAt: result.generatedAt
  };
}

async function buildPage(result, helperUrl, payload) {
  const ok = !!result.detected;
  const ip = result.ip;
  const qrSvg = ok ? makeQrSvg(payload) : '';
  const computerIps = new Set((result.candidates || []).map(c => c.address).concat(['127.0.0.1', '::1']));
  const phoneLikeTouches = phoneTouches.filter(t => t.ip && !computerIps.has(t.ip));
  const phoneInstructions = `<ol>
    <li>On your phone, open <b>LLM Radar</b>.</li>
    <li>Tap <b>Start Setup</b>.</li>
    <li>Continue through <b>Phone Wi-Fi</b>, <b>Local AI</b>, and <b>Phone Access</b>.</li>
    <li>On the <b>QR</b> step, tap <b>Scan QR</b>.</li>
    <li>Point the phone camera at the QR code on this computer page.</li>
  </ol>`;
  const phoneSeen = phoneLikeTouches.length
    ? `<p class="ok"><b>CONNECTED</b><br>Your phone reached this computer. Last phone IP: <b>${htmlEscape(phoneLikeTouches[phoneLikeTouches.length-1].ip)}</b></p>`
    : ok
      ? `<p class="warn"><b>Waiting for phone.</b></p>${phoneInstructions}`
      : `<p class="warn"><b>Not ready for phone pairing yet.</b><br>First make Local AI ready on this computer. The QR code appears after Local AI is detected.</p><p>After the QR appears, use these phone steps:</p>${phoneInstructions}`;
  const candidateList = (result.candidates || []).map(c => `<li><b>${htmlEscape(c.name)}</b> — ${htmlEscape(c.address)}</li>`).join('') || '<li>No LAN IPv4 candidates found.</li>';
  const localOnlyList = (result.localOnly || []).map(x => `<li>${htmlEscape(x.provider)} answered on <b>localhost:${x.port}</b>, but not on the computer LAN address. Go back to the still-open LLM Radar Windows Setup command window after restarting the Local AI server for LAN access.</li>`).join('') || '<li>No localhost-only clues found.</li>';
  const attemptsList = (result.attempts || []).slice(0, 40).map(a => `<li>${a.ok ? 'PASS' : '—'} ${htmlEscape(a.ip)}:${a.port} <small>${htmlEscape(a.adapter)}</small></li>`).join('') || '<li>No LAN attempts yet.</li>';
  const setupSteps = `<ol>
    <li>Stay on this computer.</li>
    <li>If your Local AI server is not running, start llama-server, Ollama, LM Studio, or your chosen Local AI now.</li>
    <li>Come back to this browser page.</li>
    <li>Click <b>Refresh Status</b> below.</li>
    <li>If you need to restart setup, click <b>Open LLM Radar Folder</b> and double-click <b>Start_Here.bat</b>.</li>
  </ol>`;
  const pairingCard = ok
    ? (phoneLikeTouches.length
      ? `<section class="cardlet ready"><h2>Connected</h2><p class="ok">Phone Access is running and ${htmlEscape(result.detected.provider)} is reachable.</p><div class="actions"><a class="button check-action" href="/recheck">Refresh Status</a><button onclick="copyText('pairurl')">Copy Phone URL</button></div><pre id="pairurl" style="display:none">${htmlEscape(helperUrl + '/pair')}</pre></section>`
      : `<section class="cardlet ready"><h2>Ready for phone</h2><p class="ok">${htmlEscape(result.detected.provider)} is reachable. Use the phone steps below to scan this QR code.</p><div class="qr">${qrSvg}</div><pre id="pairurl">${htmlEscape(helperUrl + '/pair')}</pre><div class="actions"><button onclick="copyText('pairurl')">Copy Phone URL</button><a class="button secondary check-action" href="/recheck">Refresh Status</a><a class="button secondary" href="#phone-steps">Show Phone Steps</a></div></section>`)
    : `<section class="cardlet action"><h2>Action needed</h2><p class="warn"><b>Local AI is not ready yet.</b></p><p>Start your Local AI server if needed, then click <b>Refresh Status</b> on this browser page.</p>${setupSteps}<div class="actions"><a class="button check-action" href="/recheck">Refresh Status</a><a class="button secondary" href="/open-folder">Open LLM Radar Folder</a><a class="button secondary" href="/">Refresh This Page</a></div><p><small>This browser page cannot start your Local AI server for you. Start Local AI first, then use Refresh Status here. If setup was closed, open the folder and run <code>Start_Here.bat</code>.</small></p></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Radar Phone Access</title>
<style>body{margin:0;min-height:100vh;background:#0B0F14;color:#F5F9FF;font-family:Segoe UI,Arial,sans-serif}.shell{width:min(900px,92vw);margin:24px auto;background:#111822;border:1px solid #314155;border-radius:18px;padding:20px;box-shadow:0 20px 70px rgba(0,0,0,.38)}h1{margin:0 0 8px;font-size:28px}h2{font-size:18px;margin:0 0 8px}.cardlet{border:1px solid #314155;border-radius:14px;padding:14px;margin:12px 0;background:#0F151E}p,li{color:#E8F1FC;line-height:1.5}.ok{color:#91D18B;font-weight:800}.warn{color:#E6C36A;font-weight:800}.bad{color:#F08A8A;font-weight:800}.qr{width:300px;min-height:300px;background:#fff;border-radius:18px;margin:16px auto;display:grid;place-items:center;padding:14px}pre{background:#0B0F14;border:1px solid #314155;border-radius:12px;padding:10px;color:#F5F9FF;white-space:pre-wrap;word-break:break-all}code{background:#0B0F14;color:#F5F9FF;border:1px solid #314155;border-radius:8px;padding:2px 6px}button,.button{display:inline-block;background:#8AB4F8;color:#07101A;border:0;border-radius:10px;padding:10px 12px;font-weight:900;cursor:pointer;margin-top:6px;text-decoration:none}.button.secondary{background:#1B2634;color:#F5F9FF;border:1px solid #314155}.button.loading{opacity:.8;position:relative}.button.loading:after{content:" ..."}.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.fwrow{display:grid;grid-template-columns:120px 1fr;gap:12px;border-top:1px solid #314155;padding:12px 0}.crumbs{font-size:14px;margin:0 0 14px;color:#D9E7F8}.crumbs a{color:#8AB4F8;text-decoration:none;font-weight:800}.crumbs span{margin:0 7px;color:#9AA7B3}summary{cursor:pointer;font-weight:800;color:#F5F9FF}small{color:#D9E7F8}@media(max-width:760px){.grid{grid-template-columns:1fr}.fwrow{grid-template-columns:1fr}.shell{margin:12px auto;padding:14px}.qr{width:240px;min-height:240px}}</style>
<script>function copyText(id){const text=document.getElementById(id).textContent;navigator.clipboard&&navigator.clipboard.writeText(text).then(()=>alert('Copied')).catch(()=>{});}document.addEventListener('click',function(e){const a=e.target.closest&&e.target.closest('a.check-action');if(!a)return;a.textContent='Checking Local AI...';a.classList.add('loading');});</script>
</head><body><main class="shell">${breadcrumbHtml([{label:'Phone Access'}])}<h1>${phoneLikeTouches.length ? 'Connected' : 'LLM Radar Phone Access'}</h1>
${pairingCard}
<div class="grid"><section class="cardlet"><h2>Phone Access</h2><p>${ip ? `URL: <code>${htmlEscape(helperUrl)}</code><br>Computer IP: <b>${htmlEscape(ip.address)}</b><br>Adapter: <b>${htmlEscape(ip.name)}</b>` : '<span class="bad">No usable LAN IP found. Open the LLM Radar folder, run Start_Here.bat again, and keep this computer on private Wi-Fi.</span>'}</p><div class="actions"><button onclick="copyText('accessurl')">Copy Phone Access URL</button></div><pre id="accessurl" style="display:none">${htmlEscape(helperUrl)}</pre></section><section id="phone-steps" class="cardlet"><h2>Phone reachability</h2>${phoneSeen}</section></div>

<details class="cardlet"><summary>Troubleshooting and diagnostics</summary><p>Use these only when the main action above does not resolve the issue.</p><div class="actions"><a class="button check-action" href="/recheck">Recheck Local AI</a><a class="button secondary" href="/diagnostics/document">Advanced Document Diagnostics</a><a class="button secondary" href="/open-folder">Open LLM Radar Folder</a></div><h3>Candidate computer IPs</h3><ul>${candidateList}</ul><h3>Localhost-only clues</h3><ul>${localOnlyList}</ul><h3>LAN attempts</h3><ul>${attemptsList}</ul></details>
<p>Keep the <b>LLM Radar Windows Setup</b> command window open while using the phone. If a check is slow, wait for the checking message to finish instead of closing the window.</p></main></body></html>`;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Accept', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj, null, 2));
}

function requestIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

async function startServer(result) {
  ensureDataDirs();
  activeResult = result;
  const initialIp = result.ip ? result.ip.address : '127.0.0.1';
  const handler = async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let currentResult = activeResult || result;
    const diagnosticsPaths = new Set(['/recheck', '/status', '/pair', '/qr.svg', '/doctor', '/doctor.md', '/report', '/report.json', '/report.md', '/benchmark', '/benchmark.json', '/benchmark.md', '/invite', '/invite.json', '/invite.md', '/pack', '/pack.json', '/pack.md', '/pack.csv', '/pack/save', '/pack/profile', '/brief', '/brief.json', '/brief.md', '/checklist', '/checklist.json', '/checklist.md', '/compare', '/compare.json', '/compare.md', '/bundle', '/bundle.json', '/bundle.md', '/diagnostics/document', '/diagnostics/document.json', '/diagnostics/document.md']);
    if (diagnosticsPaths.has(url.pathname)) {
      try {
        currentResult = await runDiagnosticsCached({ force: url.pathname === '/recheck' || url.searchParams.get('refresh') === '1' });
      } catch (error) {
        currentResult = activeResult || result;
      }
    }
    const preferredIp = currentResult.ip ? currentResult.ip.address : initialIp;
    const helperUrl = `http://${preferredIp}:${activeHelperPort}`;
    const payload = pairingPayload(currentResult, helperUrl);
    const remote = requestIp(req);
    if (remote && !phoneTouches.some(x => x.ip === remote && x.path === url.pathname)) {
      phoneTouches.push({ ip: remote, clientIp: remote, at: new Date().toISOString(), path: url.pathname });
    }
    if (url.pathname.startsWith('/rag/')) {
      console.log(`[phone] ${remote || 'unknown'} ${req.method || 'GET'} ${url.pathname}`);
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Accept' });
      return res.end();
    }

    if (url.pathname === '/open-folder') {
      openFolder(path.resolve(__dirname, '..'));
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, opened: 'LLM Radar folder' }));
    }

    if (url.pathname === '/recheck') {
      const nextPayload = pairingPayload(currentResult, helperUrl);
      const wantsJson = String(req.headers.accept || '').includes('application/json') || url.searchParams.get('format') === 'json';
      if (wantsJson) return sendJson(res, 200, { ok: !!currentResult.detected, status: publicResult(currentResult, helperUrl, null), generatedAt: new Date().toISOString() });
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: !!currentResult.detected, payloadReady: !!nextPayload }));
    }

    if (url.pathname === '/doctor' || url.pathname === '/doctor.md') {
      const doctor = await buildDoctor(currentResult, helperUrl);
      if (url.pathname === '/doctor.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(doctorMarkdown(doctor));
      }
      return sendJson(res, 200, doctor);
    }

    if (url.pathname === '/diagnostics/document' || url.pathname === '/diagnostics/document.json' || url.pathname === '/diagnostics/document.md') {
      const diag = await buildDocumentDiagnostic(currentResult);
      if (url.pathname === '/diagnostics/document.json') return sendJson(res, 200, diag);
      if (url.pathname === '/diagnostics/document.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(documentDiagnosticMarkdown(diag));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(documentDiagnosticHtml(diag));
    }

    if (url.pathname === '/rag' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(ragUploadHtml(helperUrl));
    }
    if (url.pathname === '/rag/sample') {
      return sendJson(res, 200, { ok: true, document: loadSampleRagDocument(), generatedAt: new Date().toISOString() });
    }
    if (url.pathname === '/rag/status') {
      return sendJson(res, 200, { ok: true, document: ragDocumentStatus(), generatedAt: new Date().toISOString() });
    }

    if (url.pathname === '/rag/upload-check') {
      const info = {
        ok: true,
        uploadReady: true,
        route: '/rag/upload',
        helperPort: activeHelperPort,
        maxBytes: 5 * 1024 * 1024,
        accepted: ['application/pdf', 'text/plain', 'text/markdown', '.txt', '.md'],
        message: 'This phone-access route is reachable. File upload uses the same LLM Radar port prepared by Start_Here.bat. Uploaded PDF, TXT, and Markdown files must pass readable-text quality checks before summary/ask unlock.'
      };
      return sendJson(res, 200, info);
    }
    if (url.pathname === '/rag/clear') {
      return sendJson(res, 200, { ok: true, document: clearRagDocument(), generatedAt: new Date().toISOString() });
    }
    if (url.pathname === '/rag/upload-test') {
      return sendJson(res, 200, {
        ok: true,
        route: '/rag/upload',
        accepts: 'multipart/form-data field named pdf; PDF, TXT, and MD files are supported',
        maxBytes: 5 * 1024 * 1024,
        recommended: 'Small clean text-based PDF, TXT, or MD under 5 MB',
        note: 'This confirms the LLM Radar computer upload route is available. Summary/ask will only unlock after readable text is extracted from a clean PDF, TXT, or MD file.',
        generatedAt: new Date().toISOString()
      });
    }
    if (url.pathname === '/rag/upload' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const upload = parseMultipartPdf(body, req.headers['content-type'] || '');
        if (!upload) return sendJson(res, 400, { ok: false, error: 'No file field named pdf was found.' });
        const document = saveRagUpload(upload.filename, upload.data);
        const wantsJson = String(req.headers.accept || '').includes('application/json');
        if (wantsJson) return sendJson(res, document.ready ? 200 : 422, { ok: !!document.ready, uploadOk: true, document, error: document.ready ? '' : (document.warning || 'The file uploaded, but readable text quality was too low.'), generatedAt: new Date().toISOString() });
        res.writeHead(303, { Location: '/rag', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: true, document }));
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message || String(error) });
      }
    }
    if (url.pathname === '/rag/summary') {
      const summary = await ragSummary(currentResult);
      return sendJson(res, summary.ok ? 200 : 409, summary);
    }
    if (url.pathname === '/rag/search') {
      const q = url.searchParams.get('q') || '';
      if (!activeRagDocument || !activeRagDocument.ready) return sendJson(res, 409, { ok: false, error: 'No file uploaded yet.', document: ragDocumentStatus(), snippets: [] });
      return sendJson(res, 200, { ok: true, query: q, document: ragDocumentStatus(), snippets: ragSearch(q, 8), generatedAt: new Date().toISOString() });
    }
    if (url.pathname === '/rag/ask' && req.method === 'POST') {
      try {
        const raw = await readRequestBody(req, 512 * 1024);
        let parsed = {};
        try { parsed = JSON.parse(raw.toString('utf8') || '{}'); } catch {}
        const question = String(parsed.question || parsed.q || '').trim();
        if (!question) return sendJson(res, 400, { ok: false, error: 'Question is required.' });
        const answer = await ragAsk(currentResult, question);
        return sendJson(res, answer.ok ? 200 : 409, answer);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message || String(error) });
      }
    }

    if (url.pathname === '/brief'  || url.pathname === '/brief.json' || url.pathname === '/brief.md') {
      const pack = await getConsultantPack(currentResult, helperUrl, payload, false);
      const brief = clientBriefFromPack(pack);
      if (url.pathname === '/brief.json') return sendJson(res, 200, brief);
      if (url.pathname === '/brief.md') {
        const md = clientBriefMarkdown(brief);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(md);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(clientBriefHtml(brief));
    }
    if (url.pathname === '/checklist' || url.pathname === '/checklist.json' || url.pathname === '/checklist.md') {
      const pack = await getConsultantPack(currentResult, helperUrl, payload, false);
      const checklist = readinessChecklistFromPack(pack);
      if (url.pathname === '/checklist.json') return sendJson(res, 200, checklist);
      if (url.pathname === '/checklist.md') {
        const md = readinessChecklistMarkdown(checklist);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(md);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readinessChecklistHtml(checklist));
    }

    if (url.pathname === '/storage' || url.pathname === '/storage.json') {
      if (url.pathname === '/storage.json') return sendJson(res, 200, dataStatus());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(storageHtml());
    }

    if (url.pathname === '/history' || url.pathname === '/history.json') {
      if (url.pathname === '/history.json') return sendJson(res, 200, readSnapshotIndex());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(historyHtml());
    }

    if (url.pathname === '/profiles' || url.pathname === '/profiles.json') {
      if (url.pathname === '/profiles.json') return sendJson(res, 200, readProfilesIndex());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(profilesHtml());
    }

    if (url.pathname === '/snapshot' || url.pathname === '/snapshot.json' || url.pathname === '/snapshot.md') {
      const i = Number(url.searchParams.get('i') || 0);
      if (url.pathname === '/snapshot.json') {
        const snap = readSnapshotPack(i);
        return sendJson(res, snap.ok ? 200 : 404, snap);
      }
      if (url.pathname === '/snapshot.md') {
        const md = readSnapshotMarkdown(i);
        res.writeHead(md.ok ? 200 : 404, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(md.ok ? md.markdown : (md.error || 'Snapshot not found.'));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(snapshotHtml(i));
    }

    if (url.pathname === '/compare' || url.pathname === '/compare.json' || url.pathname === '/compare.md') {
      const compare = compareLatestSnapshots();
      if (url.pathname === '/compare.json') return sendJson(res, compare.ok ? 200 : 200, compare);
      if (url.pathname === '/compare.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(snapshotCompareMarkdown(compare));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(snapshotCompareHtml(compare));
    }


    if (url.pathname === '/bundle' || url.pathname === '/bundle.json' || url.pathname === '/bundle.md') {
      const pack = await getConsultantPack(currentResult, helperUrl, payload, false);
      const bundle = exportBundleFromPack(pack);
      if (url.pathname === '/bundle.json') return sendJson(res, 200, bundle);
      if (url.pathname === '/bundle.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(exportBundleMarkdown(bundle));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(exportBundleHtml(bundle));
    }

    if (url.pathname === '/pack' || url.pathname === '/pack.json' || url.pathname === '/pack.md' || url.pathname === '/pack.csv' || url.pathname === '/pack/save' || url.pathname === '/pack/profile') {
      const pack = await getConsultantPack(currentResult, helperUrl, payload, url.searchParams.get('refresh') === '1');
      if (url.pathname === '/pack/save') return sendJson(res, 200, saveConsultantPackSnapshot(pack));
      if (url.pathname === '/pack/profile') return sendJson(res, 200, saveProfileFromPack(pack, url.searchParams.get('name') || ''));
      if (url.pathname === '/pack.json') return sendJson(res, 200, pack);
      if (url.pathname === '/pack.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="LLM-Radar-Consultant-Pack.csv"' });
        return res.end(consultantPackCsv(pack));
      }
      if (url.pathname === '/pack.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(consultantPackMarkdown(pack));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(consultantPackHtml(pack));
    }

    if (url.pathname === '/invite' || url.pathname === '/invite.json' || url.pathname === '/invite.md') {
      const invite = await buildLanInvite(currentResult, helperUrl, payload);
      if (url.pathname === '/invite.json') return sendJson(res, 200, invite);
      if (url.pathname === '/invite.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(inviteMarkdown(invite));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(inviteHtml(invite, payload ? makeQrSvg(payload) : ''));
    }

    if (url.pathname === '/report' || url.pathname === '/report.json' || url.pathname === '/report.md') {
      const report = await buildLocalAiReport(currentResult);
      if (url.pathname === '/report.json') return sendJson(res, 200, report);
      if (url.pathname === '/report.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(reportMarkdown(report));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(reportHtml(report));
    }
    if (url.pathname === '/benchmark' || url.pathname === '/benchmark.json' || url.pathname === '/benchmark.md') {
      const report = await buildBenchmarkReport(currentResult);
      if (url.pathname === '/benchmark.json') return sendJson(res, 200, report);
      if (url.pathname === '/benchmark.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(benchmarkMarkdown(report));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(benchmarkHtml(report));
    }
    if (url.pathname === '/reachability') return sendJson(res, 200, { ok: true, app: 'LLM Radar', version: HELPER_VERSION, helperUrl, helperPort: activeHelperPort, computerIp: preferredIp, clientIp: remote, at: new Date().toISOString() });
    if (url.pathname === '/status') return sendJson(res, 200, publicResult(currentResult, helperUrl, await getFirewallDiagnostics(activeHelperPort, currentResult.detected ? currentResult.detected.port : 0)));
    if (url.pathname === '/pair') return sendJson(res, currentResult.detected ? 200 : 503, { ok: !!currentResult.detected, payload: payload ? JSON.parse(payload) : null, status: publicResult(currentResult, helperUrl, await getFirewallDiagnostics(activeHelperPort, currentResult.detected ? currentResult.detected.port : 0)) });
    if (url.pathname === '/qr.svg') {
      if (!payload) { res.writeHead(404); return res.end('No QR payload yet.'); }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(makeQrSvg(payload));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(await buildPage(currentResult, helperUrl, payload));
  };

  const firstPort = DEFAULT_HELPER_PORT;
  const lastPort = Math.max(firstPort, HELPER_PORT_MAX);
  let server = null;
  let lastError = null;

  for (let port = firstPort; port <= lastPort; port++) {
    activeHelperPort = port;
    server = http.createServer(handler);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', resolve);
      });
      const listenIp = (activeResult && activeResult.ip && activeResult.ip.address) ? activeResult.ip.address : initialIp;
      const helperUrl = `http://${listenIp}:${activeHelperPort}`;
      console.log(`LLM Radar computer service: ${helperUrl}`);
      console.log(`Reachability: ${helperUrl}/reachability`);
      console.log(`Phone URL:     ${helperUrl}/pair`);
      if (activeHelperPort !== DEFAULT_HELPER_PORT) console.log(`Note: requested port ${DEFAULT_HELPER_PORT} was busy; using ${activeHelperPort}.`);
      if (!QUIET_CONSOLE) openUrl(helperUrl);
      return { server, helperUrl };
    } catch (error) {
      lastError = error;
      try { server.close(); } catch {}
      if (!error || error.code !== 'EADDRINUSE' || port >= lastPort) break;
    }
  }

  const detail = lastError && lastError.message ? lastError.message : 'unknown error';
  throw new Error(`Could not start LLM Radar Phone Access on port ${firstPort}${lastPort !== firstPort ? `-${lastPort}` : ''}: ${detail}`);
}

(async () => {
  try {
    console.log('LLM Radar Phone Access Service v0.7.0');
    console.log('1) Checking the most likely local AI endpoint first. Keep this window open.');
    const stopHeartbeat = startConsoleHeartbeat('Checking Local AI');
    const result = await runDiagnosticsCached({ force: true });
    stopHeartbeat();
    if (result.detected) {
      console.log(`PASS: ${result.detected.provider} is LAN-ready at ${result.detected.baseUrl}`);
    } else {
      console.log('No LAN-ready local AI server detected yet. The browser page will keep checking.');
      if (result.localOnly.length) console.log('Localhost-only clues:', result.localOnly.map(x => `${x.provider} on localhost:${x.port}`).join(', '));
    }
    console.log('2) Starting the LLM Radar computer page. Keep this window open while the browser opens...');
    await startServer(result);
    console.log('3) Browser page opened. Keep this window open while using LLM Radar.');
    console.log('Press Ctrl+C to stop Phone Access.');
  } catch (error) {
    const message = error && error.message ? error.message : String(error || 'Unknown error');
    console.error('');
    console.error('LLM Radar could not start the computer service.');
    console.error(message);
    console.error('');
    console.error('Close any old LLM Radar Phone Access windows and run Start_Here.bat again.');
    console.error('Technical detail for support: set LLMRADAR_DEBUG=1 before running to show a stack trace.');
    if (process.env.LLMRADAR_DEBUG === '1' && error && error.stack) console.error(error.stack);
    process.exit(1);
  }
})();
