export type ServiceKind = 'ollama' | 'openai-compatible' | 'lm-studio' | 'open-webui' | 'localai' | 'llama-server' | 'unknown';
export type HealthStatus = 'healthy' | 'warning' | 'offline' | 'unknown';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type PrivacyDecision = 'none' | 'advise' | 'gate' | 'block';
export type MetricQuality = 'exact' | 'measured' | 'estimated' | 'unknown';
export type ConsultantVerdict = 'Ready' | 'Partial' | 'Blocked' | 'Needs Tuning' | 'Good for Demo' | 'Good for PDF Testing' | 'Not Recommended for This Use Case';
export type LocalityStatus = 'Local LAN' | 'Cloud/Public' | 'Unknown';
export type PrivacyRisk = 'Low' | 'Medium' | 'High';
export type BenchmarkMode = 'quick' | 'standard' | 'consultant' | 'streaming' | 'app-readiness' | 'rag-lite';
export type ResponseMode = 'short' | 'normal' | 'detailed';

export interface QualityValue<T = number | string | boolean | null> {
  value: T;
  quality: MetricQuality;
  note?: string;
}

export interface CapabilityProfile {
  chat: boolean | 'unknown';
  streaming: boolean | 'unknown';
  embeddings: boolean | 'unknown';
  jsonMode?: boolean | 'unknown';
  vision: boolean | 'unknown';
  toolCalling: boolean | 'unknown';
  contextWindow?: number | 'unknown';
  inspectedAt?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  family?: string;
  size?: string;
  quantization?: string;
  contextWindow?: number | 'unknown';
  modifiedAt?: string;
  raw?: Record<string, unknown>;
}

export interface EndpointRecord {
  id: string;
  name: string;
  baseUrl: string;
  host: string;
  ip?: string;
  port?: number;
  kind: ServiceKind;
  provider: string;
  serviceFingerprint?: string;
  serverVersion?: string;
  helperUrl?: string;
  helperVersion?: string;
  helperPort?: number;
  aiPort?: number;
  laptopName?: string;
  laptopIp?: string;
  pairingSource?: 'qr' | 'manual' | 'helper' | 'lan-invite';
  pairedAt?: number;
  status: HealthStatus;
  models: ModelInfo[];
  capabilities: CapabilityProfile;
  lastSeenAt?: number;
  lastCheckedAt?: number;
  latencyMs?: number | null;
  latencyQuality?: MetricQuality;
  locality?: LocalityStatus;
  privacyRisk?: PrivacyRisk;
  favorite?: boolean;
  notes?: string;
  authMode?: 'none' | 'bearer' | 'unknown';
  evidence?: string[];
  error?: string;
  demo?: boolean;
}

export interface DiscoveryProgress {
  running: boolean;
  mode: 'idle' | 'wifi' | 'manual' | 'demo';
  scanned: number;
  total: number;
  message: string;
}

export interface BenchmarkPrompt {
  id: string;
  title: string;
  category: 'basic' | 'json' | 'instruction' | 'reasoning' | 'safety' | 'summarization' | 'extraction' | 'classification' | 'long-context' | 'rag' | 'tool';
  prompt: string;
  expects?: 'text' | 'json' | 'classification';
}

export interface BenchmarkResult {
  id: string;
  endpointId: string;
  endpointName: string;
  endpointUrl?: string;
  modelId: string;
  provider: string;
  engineKind?: ServiceKind;
  serviceFingerprint?: string;
  startedAt: number;
  durationMs: number;
  promptCount: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number | null;
  estimatedTokens: number;
  estimatedTps: number | null;
  mode?: BenchmarkMode;
  avgTtftMs?: number | null;
  avgOutputTps?: number | null;
  avgTotalResponseMs?: number | null;
  streamingPassed?: boolean;
  jsonPassed?: boolean;
  appReadiness?: AppReadinessResult;
  ragReadiness?: RagReadinessResult;
  verdict?: ConsultantVerdict;
  locality?: LocalityStatus;
  privacyRisk?: PrivacyRisk;
  recommendation?: string;
  metricQuality?: Record<string, MetricQuality>;
  includeRawResponses?: boolean;
  status: 'success' | 'warning' | 'failure';
  details: BenchmarkDetail[];
  canceled?: boolean;
  progressNote?: string;
  demo?: boolean;
}

export interface BenchmarkDetail {
  promptId: string;
  title: string;
  category?: BenchmarkPrompt['category'];
  durationMs: number;
  ok: boolean;
  promptTokens?: number;
  promptTokensQuality?: MetricQuality;
  completionTokens?: number;
  completionTokensQuality?: MetricQuality;
  estimatedTokens: number;
  ttftMs?: number | null;
  ttftQuality?: MetricQuality;
  outputTps?: number | null;
  outputTpsQuality?: MetricQuality;
  streamOk?: boolean;
  stopReason?: string;
  error?: string;
  responsePreview?: string;
  rawSaved?: boolean;
  streamNote?: string;
}

export interface BenchmarkRunProgress {
  running: boolean;
  current: number;
  total: number;
  phase: 'starting' | 'core' | 'app-readiness' | 'rag-lite' | 'saving' | 'complete' | 'canceled' | 'error';
  message: string;
  promptTitle?: string;
}

export interface AppReadinessResult {
  jsonOutput: 'pass' | 'fail' | 'unknown';
  summarization: 'pass' | 'fail' | 'unknown';
  extraction: 'pass' | 'fail' | 'unknown';
  classification: 'pass' | 'fail' | 'unknown';
  longContext: 'pass' | 'fail' | 'unknown';
  score: number;
  maxScore: number;
  notes: string[];
}

export interface RagReadinessResult {
  embeddingsEndpoint: 'pass' | 'fail' | 'unknown';
  embeddingLatencyMs?: number | null;
  vectorDimension?: number | null;
  localOnly: 'pass' | 'fail' | 'unknown';
  score: number;
  maxScore: number;
  notes: string[];
}

export interface ReportComparison {
  available: boolean;
  currentId?: string;
  previousId?: string;
  ttftDeltaMs?: number | null;
  outputTpsDelta?: number | null;
  successRateDelta?: number | null;
  modelChanged?: boolean;
  engineChanged?: boolean;
  endpointChanged?: boolean;
  summary: string;
}

export interface PrivacyMatch {
  id: string;
  label: string;
  category: string;
  risk: RiskLevel;
  count: number;
  action: 'advise' | 'gate' | 'block' | '';
}

export interface PrivacyScanResult {
  decision: PrivacyDecision;
  highestRisk: RiskLevel;
  matches: PrivacyMatch[];
  redactedText: string;
  message: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
  privacy?: PrivacyScanResult;
  metrics?: {
    durationMs: number;
    estimatedTokens: number;
    estimatedTps: number | null;
    ttftMs?: number | null;
    outputTps?: number | null;
  };
  error?: string;
}

export interface AppSettings {
  demoMode: boolean;
  privacyReview: boolean;
  defaultPrivacyAction: 'warn' | 'redact';
  scanConcurrency: number;
  probeTimeoutMs: number;
  ports: number[];
  lastSubnetPrefix?: string;
  onboardingSeen?: boolean;
  lastEndpointId?: string;
  lastHeartbeatAt?: number;
  lastHeartbeatStatus?: HealthStatus;
  responseMode?: ResponseMode;
}

export interface ConsultantReport {
  generatedAt: number;
  appName: string;
  appVersion: string;
  executiveSummary: string;
  topMetrics: {
    overallVerdict: ConsultantVerdict;
    model: string;
    engine: string;
    endpoint: LocalityStatus;
    reachability: 'Pass' | 'Fail' | 'Unknown';
    chatTest: 'Pass' | 'Fail' | 'Unknown';
    streaming: 'Pass' | 'Fail' | 'Unknown';
    avgTtft: string;
    avgOutputSpeed: string;
    avgTotalResponse: string;
    successRate: string;
    privacyStatus: string;
    recommendation: string;
  };
  endpoint?: EndpointRecord;
  latestBenchmark?: BenchmarkResult;
  comparison?: ReportComparison;
  endpoints: EndpointRecord[];
  benchmarks: BenchmarkResult[];
  settingsSummary: Pick<AppSettings, 'demoMode' | 'privacyReview' | 'ports'>;
  warnings: string[];
}

export interface ReportBundle extends ConsultantReport {}
