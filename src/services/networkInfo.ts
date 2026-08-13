import * as Network from 'expo-network';

export interface NetworkSnapshot {
  type: string;
  isConnected: boolean;
  isInternetReachable: boolean | null;
  ipAddress: string;
  subnetPrefix: string;
  note: string;
}

export async function getNetworkSnapshot(): Promise<NetworkSnapshot> {
  const state = await Network.getNetworkStateAsync();
  const ipAddress = await Network.getIpAddressAsync().catch(() => '0.0.0.0');
  const subnetPrefix = inferSubnetPrefix(ipAddress);
  const type = String(state.type || 'UNKNOWN');
  return {
    type,
    isConnected: !!state.isConnected,
    isInternetReachable: state.isInternetReachable ?? null,
    ipAddress,
    subnetPrefix,
    note: type === 'WIFI'
      ? 'Scanning is limited to this Wi‑Fi subnet.'
      : 'Connect to the same Wi‑Fi as your local AI server for discovery.'
  };
}

export function inferSubnetPrefix(ipAddress: string): string {
  const parts = String(ipAddress || '').split('.');
  if (parts.length !== 4) return '';
  const nums = parts.map(Number);
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return '';
  return `${nums[0]}.${nums[1]}.${nums[2]}`;
}

export function expandSubnet(prefix: string): string[] {
  const clean = String(prefix || '').trim().replace(/\.$/, '');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return [];
  return Array.from({ length: 254 }, (_, idx) => `${clean}.${idx + 1}`);
}
