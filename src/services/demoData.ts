import { BenchmarkResult, EndpointRecord } from '../types/domain';

const now = Date.now();

export const demoEndpoints: EndpointRecord[] = [
  {
    id: 'demo-ollama-1',
    name: 'Studio Laptop',
    baseUrl: 'http://192.168.1.42:11434',
    host: '192.168.1.42:11434',
    ip: '192.168.1.42',
    port: 11434,
    kind: 'ollama',
    provider: 'Ollama',
    status: 'healthy',
    models: [
      { id: 'llama3.1:8b', name: 'llama3.1:8b', size: '4 GB' },
      { id: 'mistral:7b', name: 'mistral:7b', size: '4 GB' },
      { id: 'phi3:mini', name: 'phi3:mini', size: '2 GB' }
    ],
    capabilities: { chat: true, streaming: true, embeddings: true, jsonMode: true, vision: false, toolCalling: 'unknown', contextWindow: 'unknown', inspectedAt: now },
    serviceFingerprint: 'Ollama / ollama / 192.168.1.42:11434 / llama3.1:8b',
    locality: 'Local LAN',
    privacyRisk: 'Medium',
    lastSeenAt: now - 1000 * 60 * 3,
    lastCheckedAt: now - 1000 * 60 * 3,
    latencyMs: 284,
    favorite: true,
    evidence: ['/api/tags responded'],
    demo: true
  },
  {
    id: 'demo-lmstudio-1',
    name: 'Gaming PC',
    baseUrl: 'http://192.168.1.50:1234',
    host: '192.168.1.50:1234',
    ip: '192.168.1.50',
    port: 1234,
    kind: 'lm-studio',
    provider: 'LM Studio',
    status: 'healthy',
    models: [
      { id: 'qwen2.5-coder-7b-instruct', name: 'qwen2.5-coder-7b-instruct' },
      { id: 'gemma-3-4b-it', name: 'gemma-3-4b-it' }
    ],
    capabilities: { chat: true, streaming: true, embeddings: 'unknown', jsonMode: true, vision: 'unknown', toolCalling: 'unknown', contextWindow: 'unknown', inspectedAt: now },
    serviceFingerprint: 'LM Studio / lm-studio / 192.168.1.50:1234 / qwen2.5-coder-7b-instruct',
    locality: 'Local LAN',
    privacyRisk: 'Medium',
    lastSeenAt: now - 1000 * 60 * 8,
    lastCheckedAt: now - 1000 * 60 * 8,
    latencyMs: 410,
    evidence: ['/v1/models responded'],
    demo: true
  },
  {
    id: 'demo-openwebui-1',
    name: 'Home Server',
    baseUrl: 'http://192.168.1.20:3000',
    host: '192.168.1.20:3000',
    ip: '192.168.1.20',
    port: 3000,
    kind: 'open-webui',
    provider: 'Open WebUI',
    status: 'warning',
    models: [],
    capabilities: { chat: 'unknown', streaming: 'unknown', embeddings: 'unknown', jsonMode: 'unknown', vision: 'unknown', toolCalling: 'unknown', contextWindow: 'unknown', inspectedAt: now },
    locality: 'Local LAN',
    privacyRisk: 'Medium',
    lastSeenAt: now - 1000 * 60 * 14,
    lastCheckedAt: now - 1000 * 60 * 14,
    latencyMs: 530,
    evidence: ['/ responded like Open WebUI'],
    error: 'Detected UI. Model API needs credentials or direct backend URL.',
    demo: true
  }
];

export const demoBenchmarks: BenchmarkResult[] = [
  {
    id: 'demo-bench-1',
    endpointId: 'demo-ollama-1',
    endpointName: 'Studio Laptop',
    modelId: 'llama3.1:8b',
    provider: 'Ollama',
    startedAt: now - 1000 * 60 * 4,
    durationMs: 12850,
    promptCount: 3,
    successCount: 3,
    failureCount: 0,
    avgLatencyMs: 4283,
    estimatedTokens: 322,
    estimatedTps: 25.06,
    mode: 'standard',
    avgTtftMs: 820,
    avgOutputTps: 24.6,
    avgTotalResponseMs: 4283,
    streamingPassed: true,
    jsonPassed: true,
    verdict: 'Ready',
    locality: 'Local LAN',
    privacyRisk: 'Medium',
    recommendation: 'Good for lightweight local demos. Add authentication or use trusted Wi-Fi only before inviting colleagues.',
    metricQuality: { ttft: 'measured', outputTps: 'measured', totalResponse: 'measured', completionTokens: 'estimated' },
    appReadiness: { jsonOutput: 'pass', summarization: 'pass', extraction: 'pass', classification: 'pass', longContext: 'pass', score: 5, maxScore: 5, notes: ['Demo app readiness passed.'] },
    ragReadiness: { embeddingsEndpoint: 'pass', embeddingLatencyMs: 180, vectorDimension: 4096, localOnly: 'pass', score: 4, maxScore: 4, notes: ['Demo embeddings endpoint returned a vector.'] },
    status: 'success',
    details: [
      { promptId: 'basic-chat', title: 'Basic chat', category: 'basic', durationMs: 3810, ok: true, estimatedTokens: 104, ttftMs: 790, ttftQuality: 'measured', outputTps: 26.4, outputTpsQuality: 'estimated', streamOk: true, responsePreview: 'A local language model server runs models on your own machine or network...' },
      { promptId: 'json-format', title: 'JSON output', category: 'json', durationMs: 4201, ok: true, estimatedTokens: 86, ttftMs: 820, ttftQuality: 'measured', outputTps: 22.1, outputTpsQuality: 'estimated', streamOk: true, responsePreview: '{"summary":"Local AI service detected","strengths":"Private and fast","risk":"Network configuration"}' },
      { promptId: 'instruction-following', title: 'Instruction following', category: 'instruction', durationMs: 4839, ok: true, estimatedTokens: 132, ttftMs: 850, ttftQuality: 'measured', outputTps: 25.3, outputTpsQuality: 'estimated', streamOk: true, responsePreview: '• Verifies that endpoints are reachable...' }
    ],
    demo: true
  }
];
