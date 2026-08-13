import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { AppSettings, BenchmarkResult, ChatMessage, EndpointRecord } from '../types/domain';
import { COMMON_AI_PORTS, DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_SCAN_CONCURRENCY } from '../constants/discovery';

const KEYS = {
  endpoints: 'llmradar:endpoints',
  benchmarks: 'llmradar:benchmarks',
  chats: 'llmradar:chats',
  settings: 'llmradar:settings',
  tokenIndex: 'llmradar:token-index',
  helperPacks: 'llmradar:helper-packs',
  ragProofs: 'llmradar:rag-proofs'
};

export const DEFAULT_SETTINGS: AppSettings = {
  demoMode: false,
  privacyReview: true,
  defaultPrivacyAction: 'warn',
  scanConcurrency: DEFAULT_SCAN_CONCURRENCY,
  probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
  ports: COMMON_AI_PORTS,
  onboardingSeen: false,
  responseMode: 'normal'
};

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

async function readArray<T>(key: string): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeJson<T>(key: string, value: T): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

async function readTokenIndex(): Promise<string[]> {
  return readArray<string>(KEYS.tokenIndex);
}

async function saveTokenIndex(keys: string[]): Promise<void> {
  await writeJson(KEYS.tokenIndex, Array.from(new Set(keys)).sort());
}

export const storage = {
  async getSettings(): Promise<AppSettings> {
    return readJson<AppSettings>(KEYS.settings, DEFAULT_SETTINGS);
  },

  async saveSettings(settings: AppSettings): Promise<void> {
    await writeJson(KEYS.settings, settings);
  },

  async getEndpoints(): Promise<EndpointRecord[]> {
    return readArray<EndpointRecord>(KEYS.endpoints);
  },

  async saveEndpoints(endpoints: EndpointRecord[]): Promise<void> {
    const clean = endpoints.slice().sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    await writeJson(KEYS.endpoints, clean);
  },

  async upsertEndpoint(endpoint: EndpointRecord): Promise<EndpointRecord[]> {
    const endpoints = await this.getEndpoints();
    const normalized = endpoints.filter(e => e.baseUrl !== endpoint.baseUrl && e.id !== endpoint.id);
    const next = [endpoint, ...normalized];
    await this.saveEndpoints(next);
    return next;
  },

  async deleteEndpoint(id: string): Promise<EndpointRecord[]> {
    const next = (await this.getEndpoints()).filter(e => e.id !== id);
    await this.setBearerToken(id, '');
    await this.saveEndpoints(next);
    return next;
  },

  async getBenchmarks(): Promise<BenchmarkResult[]> {
    return readArray<BenchmarkResult>(KEYS.benchmarks);
  },

  async saveBenchmarks(benchmarks: BenchmarkResult[]): Promise<void> {
    await writeJson(KEYS.benchmarks, benchmarks.slice(0, 100));
  },

  async addBenchmark(result: BenchmarkResult): Promise<BenchmarkResult[]> {
    const next = [result, ...(await this.getBenchmarks())].slice(0, 100);
    await this.saveBenchmarks(next);
    return next;
  },

  async getHelperPacks(): Promise<any[]> {
    return readArray<any>(KEYS.helperPacks);
  },

  async saveHelperPacks(packs: any[]): Promise<void> {
    const clean = packs
      .filter(pack => pack && typeof pack === 'object')
      .slice(0, 25);
    await writeJson(KEYS.helperPacks, clean);
  },

  async addHelperPack(pack: any): Promise<any[]> {
    const packs = await this.getHelperPacks();
    const key = String(pack?.generatedAt || pack?.id || Date.now());
    const next = [{ ...pack, importedAt: Date.now(), importId: key }, ...packs.filter(item => String(item?.generatedAt || item?.id || item?.importId) !== key)].slice(0, 25);
    await this.saveHelperPacks(next);
    return next;
  },

  async getRagProofs(): Promise<any[]> {
    return readArray<any>(KEYS.ragProofs);
  },

  async saveRagProofs(proofs: any[]): Promise<void> {
    const clean = proofs.filter(proof => proof && typeof proof === 'object').slice(0, 30);
    await writeJson(KEYS.ragProofs, clean);
  },

  async addRagProof(proof: any): Promise<any[]> {
    const proofs = await this.getRagProofs();
    const key = String(proof?.proofId || proof?.generatedAt || Date.now());
    const next = [{ ...proof, savedAt: Date.now(), proofId: key }, ...proofs.filter(item => String(item?.proofId || item?.generatedAt || item?.savedAt) !== key)].slice(0, 30);
    await this.saveRagProofs(next);
    return next;
  },

  async getChat(endpointId: string): Promise<ChatMessage[]> {
    const all = await readJson<Record<string, ChatMessage[]>>(KEYS.chats, {});
    return Array.isArray(all[endpointId]) ? all[endpointId] : [];
  },

  async saveChat(endpointId: string, messages: ChatMessage[]): Promise<void> {
    const all = await readJson<Record<string, ChatMessage[]>>(KEYS.chats, {});
    all[endpointId] = messages.slice(-80);
    await writeJson(KEYS.chats, all);
  },

  async clearChat(endpointId: string): Promise<void> {
    const all = await readJson<Record<string, ChatMessage[]>>(KEYS.chats, {});
    delete all[endpointId];
    await writeJson(KEYS.chats, all);
  },

  async getBearerToken(endpointId: string): Promise<string> {
    return (await SecureStore.getItemAsync(`llmradar:token:${endpointId}`)) || '';
  },

  async setBearerToken(endpointId: string, token: string): Promise<void> {
    const key = `llmradar:token:${endpointId}`;
    const index = await readTokenIndex();
    if (!token.trim()) {
      await SecureStore.deleteItemAsync(key);
      await saveTokenIndex(index.filter(item => item !== key));
    } else {
      await SecureStore.setItemAsync(key, token.trim());
      await saveTokenIndex([...index, key]);
    }
  },

  async clearAll(): Promise<void> {
    const tokenKeys = await readTokenIndex();
    await Promise.all(tokenKeys.map(key => SecureStore.deleteItemAsync(key).catch(() => undefined)));
    await AsyncStorage.multiRemove([KEYS.endpoints, KEYS.benchmarks, KEYS.chats, KEYS.settings, KEYS.tokenIndex, KEYS.helperPacks, KEYS.ragProofs]);
  }
};
