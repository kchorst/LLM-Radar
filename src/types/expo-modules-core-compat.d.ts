// LLM Radar build-compat shim.
// Some Expo 55 dependency trees expose legacy expo-file-system TypeScript sources
// that still import older expo-modules-core names during `tsc --noEmit`.
// The app does not import expo-file-system directly; this shim keeps typecheck
// focused on app code without patching node_modules.
declare module 'expo-modules-core' {
  export type EventSubscription = { remove(): void };
  export type Subscription = { remove(): void };
  export class NativeModule {}
  export function requireOptionalNativeModule<ModuleType = any>(moduleName: string): ModuleType | null;
  export function uuid(): string;
}
