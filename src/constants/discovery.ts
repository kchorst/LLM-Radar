export const SERVICE_PORTS = {
  llamaServer: [8080],
  ollama: [11434],
  lmStudio: [1234],
  openWebUi: [3000, 8080],
  localAi: [8080],
  openAiCompatible: [8000, 8080, 1234, 5000]
};

export const QUICK_AI_PORTS = [8080, 11434, 1234, 3000, 8000, 5000];
export const DEEP_AI_PORTS = [8080, 11434, 1234, 3000, 8000, 5000, 7860, 8081, 8082, 5001, 7000, 9000];
export const COMMON_AI_PORTS = QUICK_AI_PORTS;
export const DEFAULT_PROBE_TIMEOUT_MS = 650;
export const DEFAULT_SCAN_CONCURRENCY = 48;
export const MAX_SCAN_CONCURRENCY = 128;

export const SERVICE_HINTS: Record<number, string> = {
  8080: 'llama-server / LocalAI / local service common',
  11434: 'Ollama default',
  1234: 'LM Studio common',
  3000: 'Open WebUI common',
  8000: 'Generic OpenAI-compatible common',
  5000: 'Generic local API common',
  5001: 'Generic local API common',
  7000: 'Generic local service common',
  7860: 'AI UI common',
  8081: 'Local service common',
  8082: 'Local service common',
  9000: 'Generic local service common'
};

export type ServiceTargetKey = 'all' | 'llama-server' | 'ollama' | 'lm-studio' | 'open-webui' | 'localai' | 'openai-compatible';

export interface ServiceTarget {
  key: ServiceTargetKey;
  label: string;
  ports: number[];
  primaryPath: string;
  help: string;
}

export const SERVICE_TARGETS: ServiceTarget[] = [
  {
    key: 'all',
    label: 'Auto-find local AI',
    ports: QUICK_AI_PORTS,
    primaryPath: 'Best first step.',
    help: 'Search common local AI ports.'
  },
  {
    key: 'llama-server',
    label: 'Find llama-server',
    ports: SERVICE_PORTS.llamaServer,
    primaryPath: 'Port 8080.',
    help: 'Use --host 0.0.0.0 --port 8080.'
  },
  {
    key: 'ollama',
    label: 'Find Ollama',
    ports: SERVICE_PORTS.ollama,
    primaryPath: 'Port 11434.',
    help: 'Enable LAN access if needed.'
  },
  {
    key: 'lm-studio',
    label: 'Find LM Studio',
    ports: SERVICE_PORTS.lmStudio,
    primaryPath: 'Port 1234.',
    help: 'Start the local server and enable LAN.'
  },
  {
    key: 'open-webui',
    label: 'Find Open WebUI',
    ports: SERVICE_PORTS.openWebUi,
    primaryPath: 'Ports 3000 / 8080.',
    help: 'API may require credentials.'
  },
  {
    key: 'localai',
    label: 'Find LocalAI',
    ports: SERVICE_PORTS.localAi,
    primaryPath: 'Port 8080.',
    help: 'Add bearer token if protected.'
  },
  {
    key: 'openai-compatible',
    label: 'Find OpenAI-compatible',
    ports: SERVICE_PORTS.openAiCompatible,
    primaryPath: 'Common API ports.',
    help: 'For custom local servers.'
  }
];
