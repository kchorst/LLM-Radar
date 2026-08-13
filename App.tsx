import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, BackHandler, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeScanningResult } from 'expo-camera';
import { Button, Card, EmptyState, Field, Metric, Pill, Row, SectionTitle } from './src/components/Base';
import { DEEP_AI_PORTS, QUICK_AI_PORTS, SERVICE_TARGETS } from './src/constants/discovery';
import type { ServiceTarget } from './src/constants/discovery';
import { EndpointCard } from './src/components/EndpointCard';
import { TabBar, TabKey } from './src/components/TabBar';
import { colors, spacing, typography } from './src/constants/theme';
import { demoBenchmarks, demoEndpoints } from './src/services/demoData';
import { discoverManualSmart, discoverOnWifi } from './src/services/discovery';
import { getNetworkSnapshot } from './src/services/networkInfo';
import type { NetworkSnapshot } from './src/services/networkInfo';
import { scanPrompt } from './src/services/privacy';
import { storage } from './src/services/storage';
import { benchmarkCsv, buildConsultantSummary, buildLanInvite, buildLanInvitePayload, buildMarkdownReport, buildReport, compareReports, endpointCsv, shareTextFile } from './src/services/reports';
import { classifyLocality, refreshEndpoint, runChatCompletion } from './src/services/aiClient';
import { runStandardBenchmark } from './src/services/benchmark';
import { buildQrMatrix, type QrMatrix } from './src/services/qr';
import type { AppSettings, BenchmarkResult, BenchmarkRunProgress, ChatMessage, DiscoveryProgress, EndpointRecord, PrivacyScanResult, ResponseMode } from './src/types/domain';
import { makeId } from './src/utils/id';
import { formatDate, formatDuration, sanitizeError, truncate } from './src/utils/text';

type WizardStep = 'phone' | 'localai' | 'radarComputer' | 'pair' | 'save';
type HeartbeatStatus = 'checking' | 'ok' | 'failed' | 'none';

interface HeartbeatState {
  status: HeartbeatStatus;
  message: string;
  checkedAt?: number;
  endpoint?: EndpointRecord;
}

interface ConnectionFeedback {
  title: string;
  message: string;
  endpointUrl?: string;
  model?: string;
  source: string;
  at: number;
}

interface ActionFeedback {
  status: 'running' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  detail?: string;
  at: number;
}

interface RagProofState {
  status?: string;
  action?: 'status' | 'summary' | 'search' | 'ask' | 'error';
  document?: any;
  summary?: string;
  answer?: string;
  query?: string;
  snippets?: any[];
  source?: string;
  generatedAt?: string;
  error?: string;
}

const WIZARD_STEPS: { key: WizardStep; label: string }[] = [
  { key: 'phone', label: 'Phone Wi‑Fi' },
  { key: 'localai', label: 'Local AI' },
  { key: 'radarComputer', label: 'Phone Access' },
  { key: 'pair', label: 'QR' },
  { key: 'save', label: 'Connected' }
];

export default function App() {
  const [active, setActive] = useState<TabKey>('dashboard');
  const scrollRef = useRef<ScrollView | null>(null);
  const lastActiveRef = useRef<TabKey>('dashboard');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointRecord[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkResult[]>([]);
  const [network, setNetwork] = useState<NetworkSnapshot | null>(null);
  const [selectedEndpointId, setSelectedEndpointId] = useState<string>('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [laptopPort, setLaptopPort] = useState('8080');
  const [manualMode, setManualMode] = useState<'guided' | 'fallback'>('guided');
  const [notice, setNotice] = useState('Ready. Discovery stays on this device and local network.');
  const [progress, setProgress] = useState<DiscoveryProgress>({ running: false, mode: 'idle', scanned: 0, total: 0, message: '' });
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [pendingPrivacy, setPendingPrivacy] = useState<PrivacyScanResult | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState('');
  const scanAbortRef = useRef<AbortController | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [qrLocked, setQrLocked] = useState(false);
  const [qrPreview, setQrPreview] = useState('');
  const [qrReconnectMode, setQrReconnectMode] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>('phone');
  const [heartbeat, setHeartbeat] = useState<HeartbeatState>({ status: 'none', message: 'No saved endpoint checked yet.' });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showConsultantTools, setShowConsultantTools] = useState(false);
  const [httpTestUrl, setHttpTestUrl] = useState('');
  const [httpTestResult, setHttpTestResult] = useState('');
  const [benchmarkProgress, setBenchmarkProgress] = useState<BenchmarkRunProgress>({ running: false, current: 0, total: 0, phase: 'starting', message: '' });
  const benchmarkAbortRef = useRef<AbortController | null>(null);
  const [lanInvitePreview, setLanInvitePreview] = useState<{ payload: string; text: string; matrix: QrMatrix } | null>(null);
  const [helperPacks, setHelperPacks] = useState<any[]>([]);
  const [helperImportUrl, setHelperImportUrl] = useState('');
  const [ragHelperUrl, setRagHelperUrl] = useState('');
  const [ragQuestion, setRagQuestion] = useState('');
  const [ragSearchQuery, setRagSearchQuery] = useState('');
  const [ragProof, setRagProof] = useState<RagProofState | null>(null);
  const [ragProofs, setRagProofs] = useState<any[]>([]);
  const [ragBusy, setRagBusy] = useState(false);
  const [chatWaitingPrompt, setChatWaitingPrompt] = useState('');
  const [connectionFeedback, setConnectionFeedback] = useState<ConnectionFeedback | null>(null);
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
  const [readiness, setReadiness] = useState<any | null>(null);
  const [readinessBusy, setReadinessBusy] = useState(false);
  const [showModelDetails, setShowModelDetails] = useState(false);
  const [pdfUploadStage, setPdfUploadStage] = useState<'idle' | 'uploading' | 'processing' | 'ready' | 'error'>('idle');
  const [showBenchmarkOptions, setShowBenchmarkOptions] = useState(false);
  const [showHomeActions, setShowHomeActions] = useState(false);
  const [morePanel, setMorePanel] = useState<'main' | 'connection' | 'tools' | 'share' | 'diagnostics' | 'cleanup' | 'about'>('main');
  const [documentDiagnostic, setDocumentDiagnostic] = useState<any | null>(null);
  const [documentDiagnosticBusy, setDocumentDiagnosticBusy] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [chatInputFocused, setChatInputFocused] = useState(false);
  const [ragQuestionFocused, setRagQuestionFocused] = useState(false);
  const [ragFocusMode, setRagFocusMode] = useState<'normal' | 'ask' | 'summary'>('normal');
  const [chatComposerHeight, setChatComposerHeight] = useState(86);
  const [chatInteractionAnchor, setChatInteractionAnchor] = useState(0);
  const chatScrollRef = useRef<FlatList<ChatMessage> | null>(null);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (progress.running) {
        stopWifiScan();
        return true;
      }
      if (active === 'qr') {
        setActive('wizard');
        setWizardStep('pair');
        return true;
      }
      if (active === 'manual') {
        setActive('dashboard');
        return true;
      }
      if (active !== 'dashboard') {
        setActive('dashboard');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [active, progress.running]);

  const selected = useMemo(() => endpoints.find(e => e.id === selectedEndpointId) || endpoints.find(e => e.models.length) || endpoints[0], [endpoints, selectedEndpointId]);
  const usableEndpoints = useMemo(() => endpoints.filter(e => e.models.length > 0 && e.status !== 'offline'), [endpoints]);
  const hasModels = usableEndpoints.length > 0;
  const selectedModel = selectedModelId || selected?.models[0]?.id || '';
  const latestAssistantMessage = useMemo(() => [...chatMessages].reverse().find(m => m.role === 'assistant'), [chatMessages]);
  const latestUserMessage = useMemo(() => [...chatMessages].reverse().find(m => m.role === 'user'), [chatMessages]);

  useEffect(() => {
    if (selected?.id) void storage.getChat(selected.id).then(setChatMessages);
    if (selected?.models?.[0]?.id) setSelectedModelId(prev => selected.models.some(m => m.id === prev) ? prev : selected.models[0].id);
  }, [selected?.id]);

  useEffect(() => {
    if (lastActiveRef.current !== active) {
      lastActiveRef.current = active;
      setTimeout(() => scrollRef.current?.scrollTo({ y: 0, animated: false }), 60);
    }
  }, [active]);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', event => {
      setKeyboardVisible(true);
      setKeyboardHeight(Number(event.endCoordinates?.height || 0));
      if (active === 'chat') setTimeout(() => chatScrollRef.current?.scrollToOffset({ offset: 0, animated: true }), 80);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
      setChatInputFocused(false);
      setRagQuestionFocused(false);
      setKeyboardHeight(0);
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, [active]);

  useEffect(() => {
    if (active === 'chat') setTimeout(() => chatScrollRef.current?.scrollToOffset({ offset: 0, animated: true }), 90);
  }, [active, chatMessages.length, chatWaitingPrompt]);

  async function boot() {
    const [savedSettings, savedEndpoints, savedBenchmarks, savedHelperPacks, savedRagProofs, snapshot] = await Promise.all([
      storage.getSettings(),
      storage.getEndpoints(),
      storage.getBenchmarks(),
      storage.getHelperPacks(),
      storage.getRagProofs(),
      getNetworkSnapshot().catch(() => null)
    ]);
    setSettings(savedSettings);
    setHelperPacks(savedHelperPacks);
    setRagProofs(savedRagProofs);
    const withDemoEndpoints = savedSettings.demoMode ? mergeEndpoints(savedEndpoints, demoEndpoints) : savedEndpoints.filter(e => !e.demo);
    const withDemoBenchmarks = savedSettings.demoMode ? mergeBenchmarks(savedBenchmarks, demoBenchmarks) : savedBenchmarks.filter(b => !b.demo);
    setBenchmarks(withDemoBenchmarks);
    setNetwork(snapshot);

    const realEndpoints = withDemoEndpoints.filter(e => !e.demo);
    const lastEndpoint = realEndpoints.find(e => e.id === savedSettings.lastEndpointId) || realEndpoints[0];

    if (lastEndpoint) {
      setEndpoints(withDemoEndpoints);
      setSelectedEndpointId(lastEndpoint.id);
      if (lastEndpoint.helperUrl) { setHelperImportUrl(lastEndpoint.helperUrl); setRagHelperUrl(lastEndpoint.helperUrl); }
      setHeartbeat({ status: 'checking', message: `Checking last connection: ${lastEndpoint.baseUrl}` });
      setNotice('Checking the last saved local AI connection before opening the app.');
      try {
        const fresh = await refreshEndpoint(lastEndpoint);
        const nextEndpoints = mergeEndpoints(withDemoEndpoints.filter(e => e.id !== lastEndpoint.id), [fresh]);
        setEndpoints(nextEndpoints);
        await storage.saveEndpoints(nextEndpoints);
        const ok = fresh.status !== 'offline';
        const nextSettings = { ...savedSettings, lastEndpointId: fresh.id, lastHeartbeatAt: Date.now(), lastHeartbeatStatus: fresh.status };
        setSettings(nextSettings);
        await storage.saveSettings(nextSettings);
        setHeartbeat({
          status: ok ? 'ok' : 'failed',
          message: ok ? `${fresh.provider} answered.` : `${fresh.baseUrl} did not answer.`,
          checkedAt: Date.now(),
          endpoint: fresh
        });
        setSelectedEndpointId(fresh.id);
        if (ok) {
          setActive('dashboard');
          setNotice(`Heartbeat passed: ${fresh.provider} is reachable.`);
        } else {
          setWizardStep('phone');
          setActive('wizard');
          setNotice('Last connection did not heartbeat. EZ Connect Wizard will help fix it step by step.');
        }
      } catch (error) {
        setEndpoints(withDemoEndpoints);
        setHeartbeat({ status: 'failed', message: sanitizeError(error), checkedAt: Date.now(), endpoint: lastEndpoint });
        setWizardStep('phone');
        setActive('wizard');
        setNotice('Last connection check failed. EZ Connect Wizard will help fix it step by step.');
      }
      return;
    }

    setEndpoints(withDemoEndpoints);
    setSelectedEndpointId(withDemoEndpoints[0]?.id || '');
    setHeartbeat({ status: 'none', message: 'No saved endpoint yet.' });
    setActive(savedSettings.onboardingSeen ? 'dashboard' : 'dashboard');
    setNotice('Ready.');
  }

  async function persistEndpoints(next: EndpointRecord[]) {
    setEndpoints(next);
    await storage.saveEndpoints(next);
  }

  async function persistBenchmarks(next: BenchmarkResult[]) {
    setBenchmarks(next);
    await storage.saveBenchmarks(next);
  }

  async function updateSettings(next: AppSettings) {
    setSettings(next);
    await storage.saveSettings(next);
  }

  async function completeSuccessfulConnection(endpoint: EndpointRecord, source: string) {
    const ok = endpoint.status !== 'offline' && endpoint.models.length > 0;
    setSelectedEndpointId(endpoint.id);
    if (endpoint.helperUrl) { setHelperImportUrl(endpoint.helperUrl); setRagHelperUrl(endpoint.helperUrl); }
    if (settings) {
      await updateSettings({
        ...settings,
        onboardingSeen: true,
        lastEndpointId: endpoint.id,
        lastHeartbeatAt: Date.now(),
        lastHeartbeatStatus: endpoint.status
      });
    }
    setHeartbeat({
      status: ok ? 'ok' : 'failed',
      message: ok
        ? `${endpoint.provider} answered.`
        : `${endpoint.provider} was detected, but no usable model list was returned yet.`,
      checkedAt: Date.now(),
      endpoint
    });
    setConnectionFeedback({
      title: ok ? 'Connected' : 'Model not ready',
      message: ok
        ? 'Local AI is ready. Next: open Chat.'
        : 'The phone reached the address, but no model is available yet.',
      endpointUrl: endpoint.baseUrl,
      model: endpoint.models[0]?.name || endpoint.models[0]?.id || '',
      source,
      at: Date.now()
    });
    setActionFeedback({
      status: ok ? 'success' : 'warning',
      title: ok ? 'Connected' : 'Model needed',
      message: ok
        ? 'Next: send a message.'
        : 'Choose another model or recheck Local AI.',
      detail: ok ? `${endpoint.provider} · ${endpoint.models[0]?.name || endpoint.models[0]?.id || 'model detected'}` : endpoint.error,
      at: Date.now()
    });
    setShowAdvanced(false);
    setShowConsultantTools(false);
    setWizardStep('save');
    setNotice(ok ? 'Local AI is ready. Next: open Chat.' : 'Model inventory needs attention.');
    setActive('dashboard');
  }

  async function startWizard(step: WizardStep = 'phone') {
    setWizardStep(step);
    setActive('wizard');
    if (settings && !settings.onboardingSeen) {
      const next = { ...settings, onboardingSeen: true };
      setSettings(next);
      await storage.saveSettings(next);
    }
  }

  async function retestPhoneNetwork() {
    try {
      const snapshot = await getNetworkSnapshot();
      setNetwork(snapshot);
      const onWifi = snapshot.type === 'WIFI' && !!snapshot.subnetPrefix && snapshot.ipAddress !== '0.0.0.0';
      setNotice(onWifi ? 'Phone Wi‑Fi ready.' : 'Connect the phone to the same Wi‑Fi, then recheck.');
    } catch (error) {
      setNotice(sanitizeError(error));
    }
  }

  async function heartbeatSelectedEndpoint() {
    const endpoint = selected || endpoints.find(e => !e.demo);
    if (!endpoint || busy) {
      setWizardStep('phone');
      setActive('wizard');
      setNotice('No saved real endpoint yet. EZ Connect Wizard will create one.');
      return;
    }
    setBusy(true);
    setHeartbeat({ status: 'checking', message: `Checking ${endpoint.baseUrl}`, endpoint });
    try {
      const fresh = await refreshEndpoint(endpoint);
      const next = mergeEndpoints(endpoints.filter(e => e.id !== endpoint.id), [fresh]);
      await persistEndpoints(next);
      setSelectedEndpointId(fresh.id);
      const ok = fresh.status !== 'offline';
      if (settings) {
        const nextSettings = { ...settings, lastEndpointId: fresh.id, lastHeartbeatAt: Date.now(), lastHeartbeatStatus: fresh.status };
        await updateSettings(nextSettings);
      }
      setHeartbeat({
        status: ok ? 'ok' : 'failed',
        message: ok ? `${fresh.provider} answered.` : `${fresh.baseUrl} did not answer.`,
        checkedAt: Date.now(),
        endpoint: fresh
      });
      if (ok) {
        await completeSuccessfulConnection(fresh, 'Heartbeat retest');
      } else {
        setWizardStep('phone');
        setActive('wizard');
        setNotice('Heartbeat failed. EZ Connect Wizard will walk through the fix.');
      }
    } catch (error) {
      setHeartbeat({ status: 'failed', message: sanitizeError(error), checkedAt: Date.now(), endpoint });
      setWizardStep('phone');
      setActive('wizard');
      setNotice('Heartbeat failed. EZ Connect Wizard will walk through the fix.');
    } finally {
      setBusy(false);
    }
  }

  async function startWifiScan(mode: 'quick' | 'deep' = 'quick') {
    if (!settings || progress.running) return;
    const ports = mode === 'quick' ? QUICK_AI_PORTS : DEEP_AI_PORTS;
    const timeoutMs = mode === 'quick' ? Math.min(settings.probeTimeoutMs, 700) : settings.probeTimeoutMs;
    const concurrency = mode === 'quick' ? Math.max(settings.scanConcurrency, 48) : Math.max(settings.scanConcurrency, 64);
    const ctrl = new AbortController();
    scanAbortRef.current = ctrl;

    setActive('discovery');
    setProgress({ running: true, mode: 'wifi', scanned: 0, total: 0, message: mode === 'quick' ? 'Starting quick scan…' : 'Starting deep scan…' });
    setNotice(mode === 'quick'
      ? 'Quick scan checks common local AI fingerprints first. Use Stop anytime.'
      : 'Deep scan checks more ports and may take longer. Use Stop anytime.');
    try {
      const snapshot = await getNetworkSnapshot();
      setNetwork(snapshot);
      const result = await discoverOnWifi({
        subnetPrefix: settings.lastSubnetPrefix || snapshot.subnetPrefix,
        ports,
        timeoutMs,
        concurrency,
        signal: ctrl.signal,
        onProgress: (scanned, total, message) => setProgress({ running: true, mode: 'wifi', scanned, total, message })
      });
      const next = mergeEndpoints(endpoints, result.endpoints);
      await persistEndpoints(next);
      if (result.endpoints[0]) {
        await completeSuccessfulConnection(result.endpoints[0], mode === 'quick' ? 'Quick Wi‑Fi scan' : 'Deep Wi‑Fi scan');
      } else {
        setNotice(result.message);
      }
    } catch (error) {
      setNotice(sanitizeError(error));
    } finally {
      if (scanAbortRef.current === ctrl) scanAbortRef.current = null;
      setProgress(p => ({ ...p, running: false, message: p.message || 'Scan complete.' }));
    }
  }

  function stopWifiScan() {
    if (!progress.running || !scanAbortRef.current) return;
    scanAbortRef.current.abort();
    setNotice('Stopping scan. Results found so far will be kept.');
    setProgress(p => ({ ...p, message: 'Stopping scan…' }));
  }


  async function addManualEndpoint() {
    if (!settings || busy) return;
    const maybePair = parsePairingPayload(manualUrl);
    if (maybePair?.helperUrl) {
      await connectFromPairingPayload({ ...maybePair, token: manualToken.trim() || maybePair.token });
      return;
    }
    setBusy(true);
    setProgress({ running: true, mode: 'manual', scanned: 0, total: 1, message: 'Checking endpoint…' });
    try {
      const fallbackPorts = buildManualFallbackPorts(laptopPort);
      const endpoint = await discoverManualSmart(manualUrl, settings.probeTimeoutMs, manualToken, fallbackPorts);
      if (!endpoint) {
        setNotice('No supported AI API was detected. Try Auto-find by service first; manual IP entry is the fallback.');
        return;
      }
      endpoint.authMode = manualToken.trim() ? 'bearer' : 'none';
      const next = mergeEndpoints(endpoints, [endpoint]);
      await persistEndpoints(next);
      if (manualToken.trim()) await storage.setBearerToken(endpoint.id, manualToken.trim());
      setManualUrl('');
      setManualToken('');
      await completeSuccessfulConnection(endpoint, 'Manual connection');
    } catch (error) {
      setNotice(sanitizeError(error));
    } finally {
      setBusy(false);
      setProgress({ running: false, mode: 'manual', scanned: 1, total: 1, message: 'Manual check complete.' });
    }
  }


  async function findLocalAiService(target: ServiceTarget | { ports: number[]; label: string }, labelOverride?: string) {
    if (!settings || progress.running) return;
    const ports = target.ports?.length ? Array.from(new Set(target.ports)) : [parsePort(laptopPort, 8080)];
    const label = labelOverride || target.label || (ports.length === 1 ? `port ${ports[0]}` : `ports ${ports.join(', ')}`);
    const ctrl = new AbortController();
    scanAbortRef.current = ctrl;
    setActive('discovery');
    setProgress({ running: true, mode: 'wifi', scanned: 0, total: 0, message: `Auto-finding ${label}…` });
    setNotice(`No IP needed. LLM Radar is checking ${label} across this Wi‑Fi.`);
    try {
      const snapshot = await getNetworkSnapshot();
      setNetwork(snapshot);
      const result = await discoverOnWifi({
        subnetPrefix: settings.lastSubnetPrefix || snapshot.subnetPrefix,
        ports,
        timeoutMs: Math.min(settings.probeTimeoutMs, ports.length === 1 ? 500 : 650),
        concurrency: 96,
        signal: ctrl.signal,
        onProgress: (scanned, total, message) => setProgress({ running: true, mode: 'wifi', scanned, total, message })
      });
      const next = mergeEndpoints(endpoints, result.endpoints);
      await persistEndpoints(next);
      if (result.endpoints[0]) {
        setManualUrl(result.endpoints[0].baseUrl);
        await completeSuccessfulConnection(result.endpoints[0], `Auto-find ${label}`);
      } else {
        setNotice(`No local AI answered for ${label}. Use service setup help below; IP lookup is still a last resort.`);
      }
    } catch (error) {
      setNotice(sanitizeError(error));
    } finally {
      if (scanAbortRef.current === ctrl) scanAbortRef.current = null;
      setProgress(p => ({ ...p, running: false, message: p.message || 'Local AI search complete.' }));
    }
  }

  async function refreshSelected() {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const fresh = await refreshEndpoint(selected);
      const next = mergeEndpoints(endpoints.filter(e => e.id !== selected.id), [fresh]);
      await persistEndpoints(next);
      setSelectedEndpointId(fresh.id);
      setNotice(fresh.status === 'healthy' ? 'Status refreshed.' : fresh.error || 'Refresh found an issue.');
      if (fresh.status !== 'offline' && fresh.models.length > 0) {
        await completeSuccessfulConnection(fresh, 'Refresh');
      }
    } catch (error) {
      setNotice(sanitizeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function runBenchmark(mode: 'quick' | 'standard' | 'consultant' = 'quick') {
    if (!selected || !selectedModel || busy) return;
    const ctrl = new AbortController();
    benchmarkAbortRef.current = ctrl;
    setBusy(true);
    setActive('benchmark');
    const total = mode === 'quick' ? 1 : mode === 'standard' ? 3 : 11;
    setBenchmarkProgress({ running: true, current: 0, total, phase: 'starting', message: mode === 'quick' ? 'Starting one short speed check…' : mode === 'standard' ? 'Starting standard check…' : 'Starting consultant check…' });
    setActionFeedback({ status: 'running', title: mode === 'quick' ? 'Checking speed' : 'Check running', message: mode === 'quick' ? 'One short prompt is running now.' : `${mode} check is running now.`, at: Date.now() });
    setNotice(mode === 'quick' ? 'Checking speed now…' : 'Deeper check running. Progress is shown at the top of this screen.');
    try {
      const token = selected.authMode === 'bearer' ? await storage.getBearerToken(selected.id) : '';
      const result = await runStandardBenchmark(selected, selectedModel, {
        token,
        timeoutMs: mode === 'quick' ? 20000 : 35000,
        signal: ctrl.signal,
        mode,
        onProgress: setBenchmarkProgress
      });
      const next = [result, ...benchmarks];
      await persistBenchmarks(next);
      setActionFeedback({
        status: result.canceled ? 'warning' : result.status === 'success' ? 'success' : result.status === 'warning' ? 'warning' : 'error',
        title: result.canceled ? 'Speed check stopped' : `${mode === 'quick' ? 'Speed check' : mode === 'standard' ? 'Standard check' : 'Consultant check'} complete`,
        message: `${result.successCount}/${result.promptCount} prompts passed.`,
        detail: `Average total ${formatDuration(result.avgTotalResponseMs || result.avgLatencyMs)} · Output ${result.avgOutputTps ?? result.estimatedTps ?? '—'} TPS`,
        at: Date.now()
      });
      setNotice(result.canceled
        ? `Check stopped. Partial result saved: ${result.successCount}/${result.promptCount} prompts passed.`
        : `${mode === 'quick' ? 'Speed check' : mode === 'standard' ? 'Standard check' : 'Consultant check'} complete: ${result.successCount}/${result.promptCount} prompts passed.`);
    } catch (error) {
      setBenchmarkProgress({ running: false, current: 0, total: 0, phase: 'error', message: sanitizeError(error) });
      setActionFeedback({ status: 'error', title: 'Speed check failed', message: sanitizeError(error), at: Date.now() });
      setNotice(sanitizeError(error));
    } finally {
      if (benchmarkAbortRef.current === ctrl) benchmarkAbortRef.current = null;
      setBusy(false);
      setBenchmarkProgress(prev => ({ ...prev, running: false }));
    }
  }

  function cancelBenchmark() {
    if (!benchmarkAbortRef.current) return;
    benchmarkAbortRef.current.abort();
    setBenchmarkProgress(prev => ({ ...prev, running: false, phase: 'canceled', message: 'Stopping after the current network request…' }));
    setNotice('Stopping check. Partial results will be saved if any prompt finished.');
  }

  async function sendChat(useText?: string) {
    if (!settings || !selected || !selectedModel || busy) return;
    const prompt = (useText ?? chatInput).trim();
    if (!prompt) return;

    if (settings.privacyReview && !useText) {
      const scan = scanPrompt(prompt);
      if (scan.decision !== 'none') {
        setPendingPrivacy(scan);
        setPendingPrompt(prompt);
        return;
      }
    }

    setPendingPrivacy(null);
    setPendingPrompt('');
    setChatInputFocused(false);
    Keyboard.dismiss();
    setBusy(true);
    setChatWaitingPrompt(prompt);
    setChatInteractionAnchor(Date.now());
    const requestPrompt = prompt;
    setActionFeedback({ status: 'running', title: 'Sending chat message', message: 'Waiting for the exact local AI response.', detail: prompt, at: Date.now() });
    const userMessage: ChatMessage = { id: makeId('chat'), role: 'user', text: prompt, createdAt: Date.now(), privacy: settings.privacyReview ? scanPrompt(prompt) : undefined };
    const optimistic = [...chatMessages, userMessage];
    setChatMessages(optimistic);
    setChatInput('');
    try {
      const token = selected.authMode === 'bearer' ? await storage.getBearerToken(selected.id) : '';
      const response = await runChatCompletion({ endpoint: selected, modelId: selectedModel, prompt: requestPrompt, token });
      const assistant: ChatMessage = {
        id: makeId('chat'),
        role: 'assistant',
        text: response.text,
        createdAt: Date.now(),
        metrics: { durationMs: response.durationMs, estimatedTokens: response.estimatedTokens, estimatedTps: response.estimatedTps }
      };
      const next = [...optimistic, assistant];
      setChatMessages(next);
      await storage.saveChat(selected.id, next);
      setActionFeedback({
        status: 'success',
        title: 'Chat answered',
        message: 'The exact Local AI response is shown in Chat.',
        at: Date.now()
      });
      setChatInputFocused(false);
      Keyboard.dismiss();
      setNotice('Answer shown. Choose what to check next when ready.');
    } catch (error) {
      const fail: ChatMessage = { id: makeId('chat'), role: 'assistant', text: 'Request failed.', createdAt: Date.now(), error: sanitizeError(error) };
      const next = [...optimistic, fail];
      setChatMessages(next);
      await storage.saveChat(selected.id, next);
      setActionFeedback({ status: 'error', title: 'Local AI request failed', message: fail.error || 'Request failed.', detail: prompt, at: Date.now() });
      setChatInputFocused(false);
      Keyboard.dismiss();
      setNotice(fail.error || 'Request failed.');
    } finally {
      setBusy(false);
      setChatWaitingPrompt('');
    }
  }

  async function clearCurrentChat() {
    if (!selected) return;
    await storage.clearChat(selected.id);
    setChatMessages([]);
    setChatWaitingPrompt('');
    setActionFeedback({ status: 'success', title: 'New chat started', message: 'Chat history on this phone was cleared for the selected endpoint.', at: Date.now() });
    setNotice('New chat session started. This also helps when a local server context feels exhausted.');
  }

  async function clearFileState(clearComputer = true) {
    const helper = currentRagHelperUrl();
    setRagQuestion('');
    setRagSearchQuery('');
    setRagProof(null);
    setRagFocusMode('normal');
    setPdfUploadStage('idle');
    if (clearComputer && helper) {
      setRagBusy(true);
      setNotice('Clearing the current file…');
      try {
        await fetchJsonWithTimeout(`${helper}/rag/clear`, 9000);
      } catch {
        // Local phone state still clears even if the computer route is unavailable.
      } finally {
        setRagBusy(false);
      }
    }
    setNotice('Current file state cleared. Choose a file when ready.');
  }

  async function clearFileResults() {
    await storage.saveRagProofs([]);
    setRagProofs([]);
    setRagProof(null);
    setRagQuestion('');
    setRagSearchQuery('');
    setRagFocusMode('normal');
    setNotice('Saved file results cleared.');
  }

  async function clearImportedPacks() {
    await storage.saveHelperPacks([]);
    setHelperPacks([]);
    setNotice('Imported packs cleared.');
  }

  async function clearCheckResults() {
    await persistBenchmarks([]);
    setReadiness(null);
    setBenchmarkProgress({ running: false, current: 0, total: 0, phase: 'starting', message: '' });
    setActionFeedback(null);
    setNotice('Previous checks cleared.');
  }

  async function clearDiagnosticsState() {
    setDocumentDiagnostic(null);
    setReadiness(null);
    setHttpTestResult('');
    setPendingPrivacy(null);
    setPendingPrompt('');
    setActionFeedback(null);
    setNotice('Diagnostics results cleared.');
  }

  async function forgetPhoneConnection() {
    Alert.alert('Forget phone connection?', 'This clears saved Local AI profiles and the Phone Access URL from this phone. It does not change the computer.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: async () => {
          await Promise.all(endpoints.map(endpoint => storage.setBearerToken(endpoint.id, '').catch(() => undefined)));
          await persistEndpoints([]);
          setSelectedEndpointId('');
          setHelperImportUrl('');
          setRagHelperUrl('');
          setManualUrl('');
          setManualToken('');
          setConnectionFeedback(null);
          setHeartbeat({ status: 'none', message: 'No saved endpoint yet.' });
          if (settings) await updateSettings({ ...settings, lastEndpointId: '', lastHeartbeatAt: undefined, lastHeartbeatStatus: undefined, onboardingSeen: false });
          await clearCurrentPhoneSessionOnly();
          setWizardStep('phone');
          setActive('wizard');
          setNotice('Phone connection forgotten. Start Setup will create a fresh connection.');
        }
      }
    ]);
  }

  async function clearCurrentPhoneSessionOnly() {
    setChatMessages([]);
    setChatInput('');
    setChatWaitingPrompt('');
    setRagProof(null);
    setRagQuestion('');
    setRagSearchQuery('');
    setRagFocusMode('normal');
    setPdfUploadStage('idle');
    setDocumentDiagnostic(null);
    setReadiness(null);
    setHttpTestResult('');
    setActionFeedback(null);
    setConnectionFeedback(null);
  }

  async function startFresh() {
    Alert.alert('Start fresh?', 'This clears chat/test history, file state, saved file results, diagnostics, checks, and the saved phone connection on this phone. It does not delete files from your computer except the currently loaded LLM Radar file if the computer is reachable.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Start Fresh',
        style: 'destructive',
        onPress: async () => {
          const helper = currentRagHelperUrl();
          if (helper) await fetchJsonWithTimeout(`${helper}/rag/clear`, 7000).catch(() => undefined);
          await storage.clearAll();
          setSettings(await storage.getSettings());
          setEndpoints([]);
          setBenchmarks([]);
          setHelperPacks([]);
          setRagProofs([]);
          setSelectedEndpointId('');
          setSelectedModelId('');
          setManualUrl('');
          setManualToken('');
          setHelperImportUrl('');
          setRagHelperUrl('');
          await clearCurrentPhoneSessionOnly();
          setHeartbeat({ status: 'none', message: 'No saved endpoint yet.' });
          setWizardStep('phone');
          setMorePanel('main');
          setActive('dashboard');
          setShowHomeActions(false);
          setShowModelDetails(false);
          setNotice('Fresh start complete. Start Setup when ready.');
        }
      }
    ]);
  }

  async function setResponseMode(mode: ResponseMode) {
    if (!settings) return;
    await updateSettings({ ...settings, responseMode: mode });
    setNotice(`Response mode set to ${mode}.`);
  }

  async function saveRagProof(proof: RagProofState) {
    const saved = await storage.addRagProof({ ...proof, proofId: `${proof.action || 'rag'}-${Date.now()}`, endpointUrl: selected?.baseUrl || '', helperUrl: currentRagHelperUrl(), generatedAt: proof.generatedAt || new Date().toISOString() });
    setRagProofs(saved);
  }

  function currentRagHelperUrl(): string {
    return currentRagHelperCandidates()[0] || '';
  }

  function currentRagHelperCandidates(): string[] {
    const explicit = [selected?.helperUrl, helperImportUrl, ragHelperUrl]
      .map(value => normalizeHelperBase(value || ''))
      .filter(Boolean);
    const derived = [selected?.helperUrl, helperImportUrl, ragHelperUrl, selected?.baseUrl]
      .flatMap(value => buildHelperPortCandidates(value || ''));
    return Array.from(new Set([...explicit, ...derived].filter(Boolean)));
  }

  async function findReachableRagHelper(timeoutMs = 4500): Promise<{ helper: string; check: any } | null> {
    const candidates = currentRagHelperCandidates();
    for (const candidate of candidates) {
      const check = await fetchJsonWithTimeout(`${candidate}/rag/upload-check`, timeoutMs);
      if (check.ok && check.data?.uploadReady !== false) {
        if (candidate !== ragHelperUrl) setRagHelperUrl(candidate);
        if (candidate !== helperImportUrl) setHelperImportUrl(candidate);
        return { helper: candidate, check };
      }
    }
    return null;
  }

  function setPhoneUploadFailure(title: string, message: string, detail?: string, source?: string) {
    const cleanMessage = message || 'File upload could not continue.';
    const proof: RagProofState = { action: 'error', status: 'error', source: source || currentRagHelperUrl(), generatedAt: new Date().toISOString(), error: cleanMessage };
    setPdfUploadStage('error');
    setRagBusy(false);
    setRagProof(proof);
    setActionFeedback({ status: 'error', title, message: cleanMessage, detail, at: Date.now() });
    setNotice(`${title}: ${cleanMessage}`);
  }

  function chatHasConfirmedResponse(): boolean {
    return chatMessages.some(message => message.role === 'assistant' && !message.error && !!String(message.text || '').trim());
  }

  function setSampleTextQrRefreshFailure(detail?: string, source?: string) {
    const message = 'Chat works. Sample text did not transfer. Reconnect QR, then retry.';
    const proof: RagProofState = { action: 'error', status: 'error', source: source || currentRagHelperUrl(), generatedAt: new Date().toISOString(), error: message };
    setPdfUploadStage('error');
    setRagProof(proof);
    setActionFeedback({ status: 'error', title: 'QR refresh needed', message, detail, at: Date.now() });
    setNotice('QR refresh needed.');
  }

  async function uploadPdfFromPhone() {
    const candidates = currentRagHelperCandidates();
    let helper = candidates[0] || '';
    if (!helper) {
      setPhoneUploadFailure('No Computer file route', 'Use Home → Connect and scan the current QR from Start_Here, then try Files again.');
      return;
    }

    setRagBusy(true);
    setRagHelperUrl(helper);
    setPdfUploadStage('uploading');
    setNotice('Checking file route…');

    try {
      const reachable = await findReachableRagHelper(6500);
      if (!reachable) {
        setPhoneUploadFailure('Computer file route not found', 'Rescan the QR from the current Start_Here window. Chat can work while Files fail because Files use the LLM Radar computer service.', `Tried: ${currentRagHelperCandidates().join(', ') || helper}`, helper);
        return;
      }
      helper = reachable.helper;
      setRagHelperUrl(helper);
      setHelperImportUrl(helper);
    } catch (error) {
      const message = sanitizeError(error);
      setPhoneUploadFailure('Computer file route not found', message.includes('Network request failed') ? `Rescan the QR from the current Start_Here window, then try Files again.` : message, `Tried: ${currentRagHelperCandidates().join(', ') || helper}`, helper);
      return;
    }

    let asset: DocumentPicker.DocumentPickerAsset | undefined;
    try {
      const pick = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'text/plain', 'text/markdown'],
        multiple: false,
        copyToCacheDirectory: true
      });
      if (pick.canceled) {
        setRagBusy(false);
        setPdfUploadStage('idle');
        setNotice('File selection canceled. Recheck File Upload is ready when you want to try again.');
        return;
      }
      asset = pick.assets?.[0];
    } catch (error) {
      setPhoneUploadFailure('Document picker URI issue', sanitizeError(error), 'The phone could not hand the selected file to LLM Radar.', helper);
      return;
    }

    if (!asset?.uri) {
      setPhoneUploadFailure('Document picker URI issue', 'The selected file did not provide a readable phone URI. Choose the file again or copy it to local phone storage first.', undefined, helper);
      return;
    }

    const name = asset.name || 'phone-upload.txt';
    const lowerName = name.toLowerCase();
    const mime = String(asset.mimeType || '').toLowerCase();
    const isTxt = lowerName.endsWith('.txt') || lowerName.endsWith('.md') || mime.startsWith('text/');
    const isPdf = lowerName.endsWith('.pdf') || mime === 'application/pdf';
    const size = Number(asset.size || 0);
    if (!isPdf && !isTxt) {
      setPhoneUploadFailure('Upload route rejected', 'Choose a PDF, TXT, or Markdown file.', `Selected file: ${name}`, helper);
      return;
    }
    if (size && size > 5 * 1024 * 1024) {
      setPhoneUploadFailure('Upload route rejected', 'This file is too large for the quick phone test. Choose a small PDF, TXT, or MD file under 5 MB.', `Selected file: ${name}`, helper);
      return;
    }

    try {
      setNotice(`Uploading ${name} to Phone Access at ${helper}…`);
      const form = new FormData();
      form.append('pdf', { uri: asset.uri, name, type: asset.mimeType || (isTxt ? 'text/plain' : 'application/pdf') } as any);
      const upload = await uploadFormDataWithTimeout(`${helper}/rag/upload`, form, 30000);
      let uploadData: any = null;
      try { uploadData = upload.text ? JSON.parse(upload.text) : null; } catch { uploadData = null; }

      if (upload.status === 0 || upload.error) {
        setPhoneUploadFailure('Multipart upload failed', upload.error || `Network request failed while uploading to ${helper}.`, `Phone Access URL: ${helper}`, helper);
        return;
      }
      if (!upload.ok && upload.status !== 422) {
        setPhoneUploadFailure('Upload route rejected', uploadData?.error || `HTTP ${upload.status}`, `Phone Access URL: ${helper}`, helper);
        return;
      }

      if (upload.status === 422 || uploadData?.document?.ready === false) {
        const document = uploadData?.document;
        const message = uploadData?.error || document?.warning || 'The file uploaded, but readable text quality was too low. Try a clean text-based PDF, TXT, or MD file.';
        const proof: RagProofState = { action: 'status', status: 'error', document, source: helper, generatedAt: new Date().toISOString(), error: message };
        setRagProof(proof);
        setPdfUploadStage('error');
        setActionFeedback({ status: 'error', title: 'Readable text gate failed', message, detail: `File: ${name}`, at: Date.now() });
        setNotice(`Readable text gate failed: ${message}`);
        return;
      }

      setPdfUploadStage('processing');
      setNotice('File uploaded. Reading text before any model summary…');
      const status = await fetchJsonWithTimeout(`${helper}/rag/status`, 9000);
      if (!status.ok) {
        setPhoneUploadFailure('Upload route rejected', status.error || `HTTP ${status.status}`, `Phone Access URL: ${helper}`, helper);
        return;
      }
      const proof: RagProofState = { action: 'status', status: status.data?.document?.ready ? 'ok' : 'error', document: status.data?.document, source: helper, generatedAt: new Date().toISOString(), error: status.data?.document?.ready ? '' : (status.data?.document?.warning || 'Readable text gate failed.') };
      setRagProof(proof);
      if (status.data?.document?.ready) {
        setPdfUploadStage('ready');
        setRagFocusMode('normal');
        setActionFeedback({ status: 'success', title: 'File ready', message: `${name} is ready.`, detail: `Phone Access URL: ${helper}`, at: Date.now() });
        setNotice('File ready.');
      } else {
        const message = status.data?.document?.warning || 'The file uploaded, but readable text quality was too low. Try a clean text-based PDF, TXT, or MD file.';
        setPdfUploadStage('error');
        setActionFeedback({ status: 'error', title: 'Readable text gate failed', message, detail: `File: ${name}`, at: Date.now() });
        setNotice(`Readable text gate failed: ${message}`);
      }
    } catch (error) {
      const message = sanitizeError(error);
      setPhoneUploadFailure('Multipart upload failed', message.includes('Network request failed') ? `File upload did not reach ${helper}. Recheck Phone Connection or rescan QR.` : message, `Phone Access URL: ${helper}`, helper);
    } finally {
      setRagBusy(false);
    }
  }

  async function recheckFileUploadRoute() {
    const candidates = currentRagHelperCandidates();
    let helper = candidates[0] || '';
    if (!helper) {
      setActionFeedback({ status: 'error', title: 'No Computer file route', message: 'Use Home → Connect and scan the current QR from Start_Here.', at: Date.now() });
      setNotice('No Computer file route is saved. Scan the current QR from Start_Here.');
      return;
    }
    setRagBusy(true);
    setRagHelperUrl(helper);
    setNotice('Checking file route…');
    try {
      const reachable = await findReachableRagHelper(6500);
      if (reachable) {
        helper = reachable.helper;
        setPdfUploadStage(pdfUploadStage === 'error' ? 'idle' : pdfUploadStage);
        setActionFeedback({ status: 'success', title: 'File route ready', message: 'Choose File or Sample.', detail: helper, at: Date.now() });
        setNotice('File route ready.');
        return;
      }

      const candidates = currentRagHelperCandidates();
      let reachabilityNote = '';
      for (const candidate of candidates.length ? candidates : [helper]) {
        const reach = await fetchJsonWithTimeout(`${candidate}/reachability`, 4500);
        if (reach.ok) {
          reachabilityNote = `Computer answered at ${candidate}, but /rag/upload-check did not.`;
          break;
        }
      }
      setPdfUploadStage('error');
      setActionFeedback({
        status: 'error',
        title: 'File route failed',
        message: reachabilityNote || 'Phone cannot reach the computer file route. Chat can still work because it uses the Local AI endpoint, not the file route.',
        detail: `Tried: ${(candidates.length ? candidates : [helper]).join(', ')}`,
        at: Date.now()
      });
      setNotice('File route failed. Open More → Diagnostics, use Sample, or rescan QR from the current Start_Here window.');
    } catch (error) {
      const message = sanitizeError(error);
      setPdfUploadStage('error');
      setActionFeedback({ status: 'error', title: 'File route failed', message, detail: `Computer URL: ${helper}`, at: Date.now() });
      setNotice('File route failed. Rescan QR from the current Start_Here window.');
    } finally {
      setRagBusy(false);
    }
  }

  async function refreshRagStatus() {
    let helper = currentRagHelperUrl();
    if (!helper) {
      setNotice('Connect first, or enter the computer URL.');
      return;
    }
    setRagBusy(true);
    setRagHelperUrl(helper);
    setNotice('Checking file status…');
    try {
      const result = await fetchJsonWithTimeout(`${helper}/rag/status`, 6000);
      const proof: RagProofState = { action: 'status', status: result.ok ? 'ok' : 'error', document: result.data?.document, source: helper, generatedAt: new Date().toISOString(), error: result.ok ? '' : result.error || `HTTP ${result.status}` };
      setRagProof(proof);
      const loadedButNotReadable = !!(result.ok && result.data?.document?.filename && !result.data?.document?.ready);
      setPdfUploadStage(result.ok && result.data?.document?.ready ? 'ready' : loadedButNotReadable ? 'error' : 'idle');
      setNotice(result.ok && result.data?.document?.ready ? 'File ready.' : loadedButNotReadable ? (result.data?.document?.warning || 'File uploaded, but readable text quality was too low.') : 'No file loaded yet.');
    } catch (error) {
      const proof: RagProofState = { action: 'error', status: 'error', source: helper, generatedAt: new Date().toISOString(), error: sanitizeError(error) };
      setRagProof(proof);
      setNotice(proof.error || 'File status failed.');
    } finally {
      setRagBusy(false);
    }
  }

  async function loadRagSampleDocument() {
    const candidates = currentRagHelperCandidates();
    let helper = candidates[0] || '';
    if (!helper) {
      if (chatHasConfirmedResponse()) {
        setSampleTextQrRefreshFailure();
        return;
      }
      const message = 'Reconnect with QR, then try Sample.';
      setPdfUploadStage('error');
      setActionFeedback({ status: 'error', title: 'No Computer file route', message, at: Date.now() });
      setNotice(message);
      return;
    }
    setRagBusy(true);
    setNotice('Finding file route…');
    try {
      const reachable = await findReachableRagHelper(5000);
      if (!reachable) {
        if (chatHasConfirmedResponse()) {
          setSampleTextQrRefreshFailure(`Tried: ${candidates.join(', ')}`, helper);
          return;
        }
        const message = 'Reconnect with QR, then try Sample again.';
        const proof: RagProofState = { action: 'error', status: 'error', source: helper, generatedAt: new Date().toISOString(), error: message };
        setRagProof(proof);
        setPdfUploadStage('error');
        setActionFeedback({ status: 'error', title: 'Computer file route not found', message, detail: `Tried: ${candidates.join(', ')}`, at: Date.now() });
        setNotice(message);
        return;
      }
      helper = reachable.helper;
      setRagHelperUrl(helper);
      setHelperImportUrl(helper);
      setNotice('Loading sample…');
      const result = await fetchJsonWithTimeout(`${helper}/rag/sample`, 9000);
      const proof: RagProofState = { action: 'status', status: result.ok ? 'ok' : 'error', document: result.data?.document || result.data, source: helper, generatedAt: new Date().toISOString(), error: result.ok ? '' : result.error || `HTTP ${result.status}` };
      setRagProof(proof);
      const ready = !!proof.document?.ready;
      setPdfUploadStage(result.ok && ready ? 'ready' : 'error');
      if (result.ok && ready) {
        setActionFeedback({ status: 'success', title: 'Sample ready', message: 'Use Summarize or Ask.', detail: helper, at: Date.now() });
        setRagFocusMode('normal');
        setActive('rag');
      } else if (chatHasConfirmedResponse()) {
        setSampleTextQrRefreshFailure(`Phone Access URL: ${helper}`, helper);
        return;
      } else {
        setActionFeedback({ status: 'error', title: 'Sample failed', message: proof.error || 'Sample did not become ready.', detail: helper, at: Date.now() });
      }
      setNotice(result.ok && ready ? 'Sample ready.' : proof.error || 'Sample load failed.');
    } catch (error) {
      const message = sanitizeError(error);
      if (chatHasConfirmedResponse()) {
        setSampleTextQrRefreshFailure(`Tried: ${currentRagHelperCandidates().join(', ') || helper}`, helper);
      } else {
        const proof: RagProofState = { action: 'error', status: 'error', source: helper, generatedAt: new Date().toISOString(), error: message };
        setRagProof(proof);
        setPdfUploadStage('error');
        setActionFeedback({ status: 'error', title: 'Sample failed', message, detail: `Tried: ${currentRagHelperCandidates().join(', ') || helper}`, at: Date.now() });
        setNotice(message || 'Sample load failed.');
      }
    } finally { setRagBusy(false); }
  }

  async function clearHelperRagDocument() {
    let helper = currentRagHelperUrl();
    if (!helper) { setNotice('Connect first, or enter the computer URL.'); return; }
    setRagBusy(true);
    setNotice('Clearing file on the computer with LLM Radar files…');
    try {
      const result = await fetchJsonWithTimeout(`${helper}/rag/clear`, 9000);
      const proof: RagProofState = { action: 'status', status: result.ok ? 'ok' : 'error', document: result.data?.document, source: helper, generatedAt: new Date().toISOString(), error: result.ok ? '' : result.error || `HTTP ${result.status}` };
      setRagProof(proof);
      setNotice(result.ok ? 'File cleared.' : proof.error || 'Clear failed.');
    } catch (error) {
      const proof: RagProofState = { action: 'error', status: 'error', source: helper, generatedAt: new Date().toISOString(), error: sanitizeError(error) };
      setRagProof(proof);
      setNotice(proof.error || 'Clear failed.');
    } finally { setRagBusy(false); }
  }

  async function runRagSummary() {
    let helper = currentRagHelperUrl();
    if (!helper) { setNotice('Reconnect with the current QR, then try Summary again.'); return; }
    setRagBusy(true);
    setRagFocusMode('summary');
    Keyboard.dismiss();
    setNotice('Summarizing…');
    try {
      const reachable = await findReachableRagHelper(5000);
      if (reachable) helper = reachable.helper;
      const result = await fetchJsonWithTimeout(`${helper}/rag/summary`, 45000);
      const proof: RagProofState = { action: 'summary', status: result.ok ? 'ok' : 'error', document: result.data?.document, summary: result.data?.summary || '', snippets: result.data?.snippets || [], source: helper, generatedAt: result.data?.generatedAt || new Date().toISOString(), error: result.ok ? '' : result.error || `HTTP ${result.status}` };
      setRagProof(proof);
      if (result.ok) await saveRagProof(proof);
      setNotice(result.ok ? 'Summary ready.' : proof.error || 'Summary failed.');
    } catch (error) {
      const proof: RagProofState = { action: 'error', status: 'error', source: helper, generatedAt: new Date().toISOString(), error: sanitizeError(error) };
      setRagProof(proof);
      setNotice(proof.error || 'Summary failed.');
    } finally { setRagBusy(false); }
  }

  async function runRagSearch() {
    const helper = currentRagHelperUrl();
    const query = ragSearchQuery.trim();
    if (!helper || !query) { setNotice('Upload and summarize a file first.'); return; }
    setRagBusy(true);
    setNotice('Searching extracted file text…');
    try {
      const result = await fetchJsonWithTimeout(`${helper}/rag/search?q=${encodeURIComponent(query)}`, 12000);
      const proof: RagProofState = { action: 'search', status: result.ok ? 'ok' : 'error', document: result.data?.document, query, snippets: result.data?.snippets || [], source: helper, generatedAt: result.data?.generatedAt || new Date().toISOString(), error: result.ok ? '' : result.error || `HTTP ${result.status}` };
      setRagProof(proof);
      if (result.ok) await saveRagProof(proof);
      setNotice(result.ok ? 'File search saved in Library.' : proof.error || 'File search failed.');
    } catch (error) {
      const proof: RagProofState = { action: 'error', status: 'error', source: helper, generatedAt: new Date().toISOString(), error: sanitizeError(error) };
      setRagProof(proof);
      setNotice(proof.error || 'File search failed.');
    } finally { setRagBusy(false); }
  }

  async function runRagAsk() {
    let helper = currentRagHelperUrl();
    const question = ragQuestion.trim();
    if (!helper || !question) { setNotice('Load a file, then type a question.'); return; }
    setRagBusy(true);
    setRagFocusMode('ask');
    Keyboard.dismiss();
    setNotice('Asking…');
    try {
      const reachable = await findReachableRagHelper(5000);
      if (reachable) helper = reachable.helper;
      const result = await fetchJsonPostWithTimeout(`${helper}/rag/ask`, { question }, 65000);
      const proof: RagProofState = { action: 'ask', status: result.ok ? 'ok' : 'error', document: result.data?.document, query: question, answer: result.data?.answer || '', snippets: result.data?.snippets || [], source: helper, generatedAt: result.data?.generatedAt || new Date().toISOString(), error: result.ok ? '' : result.error || `HTTP ${result.status}` };
      setRagProof(proof);
      if (result.ok) await saveRagProof(proof);
      setNotice(result.ok ? 'Answer ready.' : proof.error || 'Ask failed.');
    } catch (error) {
      const proof: RagProofState = { action: 'error', status: 'error', source: helper, generatedAt: new Date().toISOString(), error: sanitizeError(error) };
      setRagProof(proof);
      setNotice(proof.error || 'Ask failed.');
    } finally { setRagBusy(false); }
  }

  async function shareRagProof(proof = ragProof || ragProofs[0]) {
    if (!proof) { setNotice('No file result available yet.'); return; }
    await shareTextFile(`llm-radar-rag-proof-${Date.now()}.md`, buildRagProofMarkdown(proof));
    setNotice('File result prepared for sharing.');
  }

  async function copyRagProof(proof = ragProof || ragProofs[0]) {
    if (!proof) { setNotice('No file result available yet.'); return; }
    await Clipboard.setStringAsync(buildRagProofMarkdown(proof));
    setNotice('File result copied.');
  }

  async function shareJsonReport() {
    if (!settings) return;
    const report = buildReport(endpoints, benchmarks, settings);
    await shareTextFile(`llm-radar-consultant-report-${Date.now()}.json`, JSON.stringify(report, null, 2));
    setNotice('Full JSON report prepared. Raw JSON stays last in the consultant flow, not first.');
  }

  async function shareMarkdownReport() {
    if (!settings) return;
    const report = buildReport(endpoints, benchmarks, settings);
    await shareTextFile(`llm-radar-consultant-report-${Date.now()}.md`, buildMarkdownReport(report));
    setNotice('Markdown consultant report prepared for email, docs, GitHub, or client notes.');
  }

  async function shareConsultantSummary() {
    if (!settings) return;
    const report = buildReport(endpoints, benchmarks, settings);
    const summary = buildConsultantSummary(report);
    await Clipboard.setStringAsync(summary);
    setNotice('Consultant summary copied. Paste into email, SMS, Slack, Teams, or LinkedIn.');
  }

  function prepareLanInvitePreview() {
    const endpoint = selected || endpoints.find(e => !e.demo) || endpoints[0];
    if (!endpoint) {
      setNotice('No endpoint is saved yet. Connect to local AI before creating a LAN invite.');
      return null;
    }
    const payload = JSON.stringify(buildLanInvitePayload(endpoint));
    const text = buildLanInvite(endpoint);
    const matrix = buildQrMatrix(payload);
    const preview = { payload, text, matrix };
    setLanInvitePreview(preview);
    return preview;
  }

  async function shareLanInvite() {
    const preview = prepareLanInvitePreview();
    if (!preview) return;
    await shareTextFile(`llm-radar-lan-invite-${Date.now()}.txt`, preview.text);
    setNotice('LAN invite prepared and QR preview shown. Share only with trusted people on the same Wi-Fi.');
  }

  async function copyLanInvitePayload() {
    const preview = lanInvitePreview || prepareLanInvitePreview();
    if (!preview) return;
    await Clipboard.setStringAsync(preview.payload);
    setNotice('LAN invite QR payload copied. Trusted same-Wi-Fi colleagues can paste it into Manual entry if scanning is inconvenient.');
  }

  async function importHelperConsultantPack() {
    const raw = helperImportUrl.trim() || selected?.helperUrl || '';
    if (!raw) {
      setNotice('Enter or scan an Computer URL first. Example: http://192.168.12.151:49321');
      return;
    }
    const helperBase = normalizeHelperBase(raw);
    setHelperImportUrl(helperBase);
    setBusy(true);
    setNotice(`Importing Consultant Pack from ${helperBase}…`);
    try {
      const reach = await fetchJsonWithTimeout(`${helperBase}/reachability`, 4000);
      if (!reach.ok) {
        setNotice(`Phone could not reach the computer with LLM Radar files at ${helperBase}. Keep the LLM Radar Windows Setup command window open and confirm both devices are on the same Wi‑Fi.`);
        return;
      }
      const result = await fetchJsonWithTimeout(`${helperBase}/pack.json`, 45000);
      if (!result.ok || !result.data || typeof result.data !== 'object') {
        setNotice('The computer with LLM Radar files was reachable, but Consultant Pack JSON was not available. Run Consultant Pack on that computer, then retry.');
        return;
      }
      const pack = { ...result.data, importedFromHelperUrl: helperBase, importedAt: Date.now() };
      const next = await storage.addHelperPack(pack);
      setHelperPacks(next);
      setNotice('Consultant Pack imported and saved on this phone.');
    } catch (error) {
      setNotice(sanitizeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function shareLatestImportedPack() {
    const pack = helperPacks[0];
    if (!pack) {
      setNotice('No imported Consultant Pack yet. Import from the computer with LLM Radar files first.');
      return;
    }
    await shareTextFile(`llm-radar-imported-consultant-pack-${Date.now()}.md`, buildImportedPackMarkdown(pack));
    setNotice('Imported Consultant Pack prepared for native Android sharing.');
  }

  async function copyLatestImportedSummary() {
    const pack = helperPacks[0];
    if (!pack) {
      setNotice('No imported Consultant Pack yet.');
      return;
    }
    await Clipboard.setStringAsync(importedPackSummary(pack));
    setNotice('Imported Consultant Pack summary copied.');
  }

  async function toggleFavoriteEndpoint(endpoint: EndpointRecord) {
    const next = mergeEndpoints(endpoints.filter(e => e.id !== endpoint.id), [{ ...endpoint, favorite: !endpoint.favorite }]);
    await persistEndpoints(next);
    setSelectedEndpointId(endpoint.id);
    setNotice(!endpoint.favorite ? 'Profile marked as favorite.' : 'Profile favorite removed.');
  }

  async function deleteEndpointProfile(endpoint: EndpointRecord) {
    Alert.alert('Delete this profile?', `This removes ${endpoint.name} from this device. Saved speed/check reports remain.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await storage.setBearerToken(endpoint.id, ''); const next = endpoints.filter(e => e.id !== endpoint.id); await persistEndpoints(next); setSelectedEndpointId(next[0]?.id || ''); setNotice('Endpoint profile deleted.'); } }
    ]);
  }

  async function deleteBenchmarkReport(result: BenchmarkResult) {
    Alert.alert('Delete this report?', 'This removes the saved benchmark report from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { const next = benchmarks.filter(b => b.id !== result.id); await persistBenchmarks(next); setNotice('Check report deleted.'); } }
    ]);
  }

  async function shareSpecificMarkdownReport(result: BenchmarkResult) {
    if (!settings) return;
    const report = buildReport(endpoints, [result, ...benchmarks.filter(b => b.id !== result.id)], settings);
    await shareTextFile(`llm-radar-report-${result.id}.md`, buildMarkdownReport(report));
    setNotice('Saved report prepared as Markdown.');
  }

  async function shareCsvReport() {
    const content = [`# Endpoints`, endpointCsv(endpoints), '', '# Benchmarks', benchmarkCsv(benchmarks)].join('\n');
    await shareTextFile(`llm-radar-report-${Date.now()}.csv`, content);
    setNotice('CSV report prepared for spreadsheet comparison.');
  }

  async function copyDiagnostics() {
    const diagnostics = JSON.stringify({ network, settings, selected, progress, heartbeat, connectionFeedback, actionFeedback, readiness, ragProof, ragProofCount: ragProofs.length }, null, 2);
    await Clipboard.setStringAsync(diagnostics);
    setNotice('Diagnostics copied.');
  }

  async function runCleanDocumentDiagnostic() {
    let helper = currentRagHelperUrl();
    if (!helper) {
      setNotice('Connect first, then open More → Diagnostics → Test Clean TXT/MD.');
      setDocumentDiagnostic({ error: 'No computer URL is saved yet. Scan QR or enter the Phone Access URL first.' });
      return;
    }
    setDocumentDiagnosticBusy(true);
    setDocumentDiagnostic(null);
    setNotice('Running clean TXT/MD document diagnostic. This is separate from chat and PDF.');
    try {
      const result = await fetchJsonWithTimeout(`${helper}/diagnostics/document.json`, 70000);
      const data = result.data || { error: result.error || `HTTP ${result.status}` };
      setDocumentDiagnostic(data);
      const status = data?.assessment?.status || (result.ok ? 'Review' : 'Error');
      const recommendation = data?.assessment?.recommendation || data?.error || 'Diagnostic finished.';
      setActionFeedback({
        status: status === 'Pass' ? 'success' : status === 'Blocked' || status === 'Error' ? 'error' : 'warning',
        title: `Document diagnostic: ${status}`,
        message: recommendation,
        at: Date.now()
      });
      setNotice(`Document diagnostic: ${status}.`);
    } catch (error) {
      const message = sanitizeError(error);
      setDocumentDiagnostic({ error: message });
      setActionFeedback({ status: 'error', title: 'Document diagnostic failed', message, at: Date.now() });
      setNotice(message);
    } finally {
      setDocumentDiagnosticBusy(false);
    }
  }

  async function runPhoneReadinessCheck() {
    setReadinessBusy(true);
    setActionFeedback({ status: 'running', title: 'Running phone readiness check', message: 'Checking current status.', at: Date.now() });
    const checks: any[] = [];
    const endpoint = selected || null;
    const connected = !!endpoint && endpoint.status !== 'offline' && endpoint.models.length > 0;
    checks.push({ label: 'Local AI connection', status: connected ? 'pass' : 'fail', detail: connected ? `${endpoint.provider} · ${endpoint.baseUrl}` : 'No chat-ready endpoint is selected.' });
    checks.push({ label: 'Model inventory', status: endpoint?.models?.length ? 'pass' : 'fail', detail: endpoint?.models?.length ? endpoint.models.map(m => m.name || m.id).slice(0, 3).join(', ') : 'No model list is visible yet.' });
    const locality = endpoint ? classifyLocality(endpoint.baseUrl) : 'Unknown';
    checks.push({ label: 'Locality', status: locality === 'Local LAN' ? 'pass' : 'review', detail: endpoint ? `${locality} · ${endpoint.baseUrl}` : 'No endpoint available.' });

    const helper = currentRagHelperUrl();
    let helperDoctor: any = null;
    if (helper) {
      const reach = await fetchJsonWithTimeout(`${helper}/reachability`, 5500);
      checks.push({ label: 'Computer reachability', status: reach.ok ? 'pass' : 'review', detail: reach.ok ? `${helper} answered from the phone.` : reach.error || `HTTP ${reach.status}` });
      const doctor = await fetchJsonWithTimeout(`${helper}/doctor`, 7000);
      helperDoctor = doctor.data || null;
      checks.push({ label: 'Computer status', status: doctor.ok && doctor.data?.ok ? 'pass' : doctor.ok ? 'review' : 'review', detail: doctor.ok ? `${doctor.data?.summary || 'Doctor data returned.'}` : doctor.error || `HTTP ${doctor.status}` });
      const rag = await fetchJsonWithTimeout(`${helper}/rag/status`, 7000);
      checks.push({ label: 'Loaded file', status: rag.ok && rag.data?.document?.ready ? 'pass' : 'review', detail: rag.ok ? (rag.data?.document?.ready ? `${rag.data.document.filename} · ${rag.data.document.chunkCount || 0} chunks` : 'No file loaded.') : rag.error || `HTTP ${rag.status}` });
    } else {
      checks.push({ label: 'Computer URL', status: 'review', detail: 'No Computer URL is saved. Scan QR or paste the computer URL in Files.' });
    }

    const lastAssistant = [...chatMessages].reverse().find(msg => msg.role === 'assistant');
    checks.push({ label: 'Chat proof', status: lastAssistant && !lastAssistant.error ? 'pass' : 'review', detail: lastAssistant ? (lastAssistant.error || truncate(lastAssistant.text, 180)) : 'No successful chat response in the current session yet.' });
    const latestRag = ragProof || ragProofs[0];
    checks.push({ label: 'File result', status: latestRag && latestRag.status !== 'error' ? 'pass' : 'review', detail: latestRag ? `${latestRag.action || 'file'} · ${latestRag.document?.filename || 'document proof'}` : 'No saved file result yet.' });
    const latestBenchmark = benchmarks[0];
    checks.push({ label: 'Speed/report', status: latestBenchmark ? 'pass' : 'review', detail: latestBenchmark ? `${latestBenchmark.successCount}/${latestBenchmark.promptCount} prompts passed · ${latestBenchmark.modelId}` : 'No phone-side speed report saved yet.' });

    const failed = checks.filter(c => c.status === 'fail').length;
    const review = checks.filter(c => c.status === 'review').length;
    const status = failed ? 'blocked' : review ? 'review' : 'ready';
    const next = status === 'ready'
      ? 'Ready for demo/share: connection, chat, file, and report proof are present.'
      : status === 'blocked'
        ? 'Fix the local AI connection first, then rerun readiness.'
        : 'Usable, but complete the review items before calling it client-ready.';
    const snapshot = { generatedAt: new Date().toISOString(), appVersion: '0.7.0', status, checks, helperDoctor, endpoint: endpoint ? { baseUrl: endpoint.baseUrl, provider: endpoint.provider, models: endpoint.models.map(m => m.name || m.id), status: endpoint.status } : null, network, latestRag, latestBenchmark, chatMessages: chatMessages.length, suggestedNext: next };
    setReadiness(snapshot);
    setActionFeedback({ status: status === 'ready' ? 'success' : status === 'blocked' ? 'error' : 'warning', title: status === 'ready' ? 'Readiness passed' : status === 'blocked' ? 'Readiness blocked' : 'Readiness needs review', message: `${checks.length - failed - review}/${checks.length} checks passed · ${review} review · ${failed} blocked`, detail: next, at: Date.now() });
    setNotice(next);
    setReadinessBusy(false);
  }

  async function shareProofBundle() {
    const snapshot = readiness || { generatedAt: new Date().toISOString(), appVersion: '0.7.0', status: 'not-run', checks: [], endpoint: selected ? { baseUrl: selected.baseUrl, provider: selected.provider, models: selected.models.map(m => m.name || m.id), status: selected.status } : null, network, latestRag: ragProof || ragProofs[0] || null, latestBenchmark: benchmarks[0] || null, chatMessages: chatMessages.length, suggestedNext: 'Run readiness check for a fuller bundle.' };
    await shareTextFile(`llm-radar-phone-proof-bundle-${Date.now()}.md`, buildPhoneProofBundleMarkdown(snapshot));
    setNotice('Phone proof bundle prepared for sharing.');
  }

  async function copyProofBundle() {
    const snapshot = readiness || { generatedAt: new Date().toISOString(), appVersion: '0.7.0', status: 'not-run', checks: [], endpoint: selected ? { baseUrl: selected.baseUrl, provider: selected.provider, models: selected.models.map(m => m.name || m.id), status: selected.status } : null, network, latestRag: ragProof || ragProofs[0] || null, latestBenchmark: benchmarks[0] || null, chatMessages: chatMessages.length, suggestedNext: 'Run readiness check for a fuller bundle.' };
    await Clipboard.setStringAsync(buildPhoneProofBundleMarkdown(snapshot));
    setNotice('Phone proof bundle copied.');
  }

  async function openQrScanner() {
    setQrLocked(false);
    setQrPreview('');
    setQrReconnectMode(true);
    setWizardStep('pair');
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        setNotice('Camera permission is needed for QR.');
        return;
      }
    }
    setActive('qr');
    setNotice('Scan the QR on the computer.');
  }

  async function handleQrScanned(result: BarcodeScanningResult) {
    if (qrLocked || busy || !settings) return;
    const raw = String(result.data || '').trim();
    if (!raw) return;
    setQrLocked(true);
    setQrPreview(raw);

    const payload = parsePairingPayload(raw);
    if (!payload) {
      setNotice('That QR code was readable, but it was not an LLM Radar endpoint. Tap Scan again to retry.');
      setActionFeedback({
        status: 'error',
        title: 'QR was readable, but not usable',
        message: 'This QR is not an LLM Radar QR or local AI address.',
        detail: truncate(raw, 160),
        at: Date.now()
      });
      setQrLocked(false);
      return;
    }

    await connectFromPairingPayload(payload);
  }

  async function connectFromPairingPayload(payload: PairingPayload) {
    if (!settings || busy) return;
    setBusy(true);
    setProgress({ running: true, mode: 'manual', scanned: 0, total: 3, message: 'QR scanned. Checking…' });
    setActionFeedback({
      status: 'running',
      title: 'QR scanned — checking now',
      message: 'Checking the computer and Local AI.',
      at: Date.now()
    });
    setNotice('QR scanned. Checking…');
    try {
      let endpointUrl = payload.baseUrl || payload.endpointUrl || '';
      let pairingName = payload.name;
      let pairingToken = payload.token || '';
      let pairingServiceHint = payload.serviceHint;
      const helperMetadata: Partial<EndpointRecord> = {
        helperUrl: payload.helperUrl,
        helperVersion: payload.helperVersion,
        helperPort: payload.helperPort,
        aiPort: payload.aiPort || payload.port,
        laptopName: payload.laptopName,
        laptopIp: payload.laptopIp,
        pairingSource: 'qr',
        pairedAt: Date.now()
      };

      if (payload.helperUrl) {
        const helperBase = normalizeHelperBase(payload.helperUrl);
        helperMetadata.helperUrl = helperBase;
        const reach = await fetchJsonWithTimeout(`${helperBase}/reachability`, Math.max(1800, Math.min(settings.probeTimeoutMs, 3200)));
        if (!reach.ok) {
          if (!endpointUrl) {
            const message = `Phone could not reach the computer at ${helperBase}.`;
            setNotice(message);
            setActionFeedback({ status: 'error', title: 'QR computer check failed', message, detail: reach.error || `HTTP ${reach.status}`, at: Date.now() });
            setQrLocked(false);
            return;
          }
          setActionFeedback({
            status: 'warning',
            title: 'Computer did not answer; testing endpoint from QR',
            message: 'Trying the Local AI address from the QR.',
            detail: reach.error || `HTTP ${reach.status}`,
            at: Date.now()
          });
        } else {
          setProgress({ running: true, mode: 'manual', scanned: 1, total: 3, message: 'Computer reachable…' });
          if (reach.data) {
            helperMetadata.helperVersion = stringOrUndefined(reach.data.version) || helperMetadata.helperVersion;
            helperMetadata.helperPort = numberOrUndefined(reach.data.helperPort) || helperMetadata.helperPort;
            helperMetadata.laptopIp = stringOrUndefined(reach.data.laptopIp) || helperMetadata.laptopIp;
          }
          const pair = await fetchJsonWithTimeout(`${helperBase}/pair`, Math.max(1800, Math.min(settings.probeTimeoutMs, 3200)));
          if (pair.ok && pair.data?.payload) {
            const helperPayload = pair.data.payload as Record<string, unknown>;
            endpointUrl = String(helperPayload.endpointUrl || helperPayload.baseUrl || endpointUrl || '').trim();
            pairingName = String(helperPayload.name || helperPayload.provider || pairingName || '').trim() || pairingName;
            pairingServiceHint = String(helperPayload.serviceHint || pairingServiceHint || '').trim() || pairingServiceHint;
            helperMetadata.helperVersion = stringOrUndefined(helperPayload.helperVersion) || helperMetadata.helperVersion;
            helperMetadata.helperPort = numberOrUndefined(helperPayload.helperPort) || helperMetadata.helperPort;
            helperMetadata.aiPort = numberOrUndefined(helperPayload.aiPort) || helperMetadata.aiPort;
            helperMetadata.laptopName = stringOrUndefined(helperPayload.laptopName) || helperMetadata.laptopName;
            helperMetadata.laptopIp = stringOrUndefined(helperPayload.laptopIp) || helperMetadata.laptopIp;
          } else if (!endpointUrl) {
            const message = 'Phone reached the computer with LLM Radar files, but it did not return a LAN-ready Local AI address. Fix the computer with LLM Radar files page, then scan again.';
            setNotice(message);
            setActionFeedback({ status: 'error', title: 'QR had no Local AI address', message, detail: pair.error || `HTTP ${pair.status}`, at: Date.now() });
            setQrLocked(false);
            return;
          } else {
            setActionFeedback({
              status: 'warning',
              title: 'Using endpoint embedded in QR',
              message: 'Trying the Local AI address from the QR.',
              detail: pair.error || `HTTP ${pair.status}`,
              at: Date.now()
            });
          }
        }
      }

      if (!endpointUrl) {
        setNotice('QR was readable, but no Local AI address was found.');
        setActionFeedback({ status: 'error', title: 'QR had no endpoint', message: 'No Local AI address was found in the QR.', at: Date.now() });
        setQrLocked(false);
        return;
      }

      setProgress({ running: true, mode: 'manual', scanned: 2, total: 3, message: 'Testing Local AI…' });
      const fallbackPorts = payload.port ? buildManualFallbackPorts(String(payload.port)) : buildManualFallbackPorts('8080');
      const endpoint = await discoverManualSmart(endpointUrl, settings.probeTimeoutMs, pairingToken, fallbackPorts);
      if (!endpoint) {
        const message = `Phone reached the computer, but not Local AI.`;
        setNotice(message);
        setActionFeedback({ status: 'error', title: 'Endpoint check failed', message, detail: endpointUrl, at: Date.now() });
        setQrLocked(false);
        return;
      }
      endpoint.name = pairingName || endpoint.name;
      endpoint.notes = pairingServiceHint ? `Paired through QR. Hint: ${pairingServiceHint}` : endpoint.notes;
      endpoint.authMode = pairingToken ? 'bearer' : 'none';
      Object.assign(endpoint, helperMetadata);
      endpoint.aiPort = endpoint.aiPort || endpoint.port;
      const next = mergeEndpoints(endpoints, [endpoint]);
      await persistEndpoints(next);
      if (pairingToken) await storage.setBearerToken(endpoint.id, pairingToken);
      setManualUrl(endpoint.baseUrl);
      if (endpoint.helperUrl) setHelperImportUrl(endpoint.helperUrl);
      setManualToken('');
      setQrLocked(false);
      setQrReconnectMode(false);
      await completeSuccessfulConnection(endpoint, 'QR / EZ Connect');
    } catch (error) {
      const message = sanitizeError(error);
      setNotice(message);
      setActionFeedback({ status: 'error', title: 'QR verification failed', message, at: Date.now() });
      setQrLocked(false);
    } finally {
      setBusy(false);
      setProgress({ running: false, mode: 'manual', scanned: 3, total: 3, message: 'Pairing verification complete.' });
    }
  }

  async function runPhoneHttpTest() {
    const url = normalizeMaybeUrl(httpTestUrl);
    if (!url) {
      setHttpTestResult('Enter a local HTTP URL first, such as http://192.168.12.151:8080/health.');
      return;
    }
    setHttpTestResult(`Testing ${url} from inside the LLM Radar APK…`);
    try {
      const result = await fetchTextWithTimeout(url, 4000);
      setHttpTestResult(result.ok
        ? `PASS: phone app reached ${url}. HTTP ${result.status}. ${truncate(result.text || '', 220)}`
        : `FAIL: phone app could not reach ${url}. ${result.error || 'No response.'}`);
    } catch (error) {
      setHttpTestResult(`FAIL: ${sanitizeError(error)}`);
    }
  }

  async function toggleDemoMode(value: boolean) {
    if (!settings) return;
    const nextSettings = { ...settings, demoMode: value };
    await updateSettings(nextSettings);
    const nextEndpoints = value ? mergeEndpoints(endpoints, demoEndpoints) : endpoints.filter(e => !e.demo);
    const nextBenchmarks = value ? mergeBenchmarks(benchmarks, demoBenchmarks) : benchmarks.filter(b => !b.demo);
    await persistEndpoints(nextEndpoints);
    await persistBenchmarks(nextBenchmarks);
    setSelectedEndpointId(nextEndpoints[0]?.id || '');
    setNotice(value ? 'Demo mode enabled for screenshots and LinkedIn walkthroughs.' : 'Demo mode hidden. Real endpoints remain.');
  }

  async function clearLocalData() {
    Alert.alert('Clear local data?', 'This removes endpoints, chats, benchmarks, settings, and saved bearer tokens from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => { await storage.clearAll(); await boot(); setNotice('Local data cleared.'); } }
    ]);
  }

  if (!settings) {
    return <Shell notice="Loading local workspace…"><Text style={styles.title}>LLM Radar</Text></Shell>;
  }

  const enabledTabs: Partial<Record<TabKey, boolean>> = {
    dashboard: true,
    wizard: true,
    discovery: true,
    service: true,
    manual: true,
    qr: true,
    benchmark: hasModels,
    chat: hasModels,
    rag: hasModels,
    library: true,
    more: true,
    reports: true,
    settings: true
  };

  const connected = !!selected && selected.status !== 'offline' && selected.models.length > 0;
  const shellPill = settings.demoMode ? 'DEMO' : connected ? 'CONNECTED' : 'SETUP';
  const shellTone = settings.demoMode ? 'info' : connected ? 'good' : 'neutral';
  const quietConnectedNotice = connected && /^(connected|local ai is ready|heartbeat passed)/i.test(notice || '');
  const compactNotice = quietConnectedNotice ? '' : notice;
  const hideTabsForTyping = (active === 'chat' && (keyboardVisible || chatInputFocused)) || (active === 'rag' && (keyboardVisible || ragQuestionFocused));

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={styles.headerCompact}>
        <View style={{ flex: 1 }}>
          <Text style={styles.titleCompact}>LLM Radar</Text>
          <Text style={styles.subtitle}>Local AI proof</Text>
        </View>
        {active === 'dashboard' && connected ? null : <Pill label={shellPill} tone={shellTone} />}
      </View>
      {compactNotice ? <View style={styles.notice}><Text style={styles.noticeText}>{compactNotice}</Text></View> : null}
      <View pointerEvents="none" style={styles.bottomUnderlay} />
      {active === 'chat' ? (
        renderChat()
      ) : (
        <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          {active === 'dashboard' && renderDashboard()}
          {active === 'wizard' && renderWizard()}
          {active === 'discovery' && renderDiscovery()}
          {active === 'service' && renderServiceChoice()}
          {active === 'manual' && renderManual()}
          {active === 'qr' && renderQrPair()}
          {active === 'benchmark' && renderBenchmark()}
          {active === 'rag' && renderRag()}
          {active === 'library' && renderLibrary()}
          {active === 'more' && renderMore()}
          {active === 'reports' && renderReports()}
          {active === 'settings' && renderSettings()}
        </ScrollView>
      )}
      {!hideTabsForTyping ? <TabBar active={active} setActive={tab => enabledTabs[tab] !== false && setActive(tab)} enabled={enabledTabs} /> : null}
    </SafeAreaView>
  );



  function renderWizard() {
    const phoneReady = network?.type === 'WIFI' && !!network?.subnetPrefix && network.ipAddress !== '0.0.0.0';
    const connected = !!selected && selected.status !== 'offline' && selected.models.length > 0;
    const activeIndex = WIZARD_STEPS.findIndex(step => step.key === wizardStep);
    if (connected || wizardStep === 'save') {
      return (
        <View style={styles.stack}>
          <Card style={styles.connectedHeroCard}>
            <Pill label="CONNECTED" tone="good" />
            <Text style={styles.heroTitle}>Local AI ready</Text>
            {selected ? <Text style={styles.bodyStrong}>{selected.models[0]?.name || selected.provider}</Text> : null}
            <View style={styles.buttonRow}>
              <Button title="Chat" onPress={() => setActive('chat')} />
              <Button title="See Speed" variant="secondary" onPress={() => setActive('benchmark')} />
              <Button title="Files" variant="secondary" onPress={() => setActive('rag')} />
              <Button title="Reconnect QR" variant="ghost" onPress={() => void openQrScanner()} />
            </View>
          </Card>
        </View>
      );
    }
    return (
      <View style={styles.stack}>
        <SectionTitle title="Setup" />
        <Card>
          <View style={styles.stepListCompact}>
            {WIZARD_STEPS.map((step, index) => (
              <StepStatus key={step.key} label={step.label} state={index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'todo'} onPress={() => setWizardStep(step.key)} />
            ))}
          </View>
        </Card>

        {wizardStep === 'phone' ? (
          <Card style={styles.modeCard}>
            <Pill label={phoneReady ? 'READY' : 'NEEDS WI‑FI'} tone={phoneReady ? 'good' : 'warn'} />
            <Text style={styles.cardTitle}>Phone Wi‑Fi</Text>
            <Row label="Phone" value={network?.ipAddress || 'Unknown'} />
            <View style={styles.buttonRow}>
              <Button title="Recheck" variant="secondary" onPress={() => void retestPhoneNetwork()} />
              <Button title="Next" onPress={() => setWizardStep('localai')} disabled={!phoneReady} />
            </View>
          </Card>
        ) : null}

        {wizardStep === 'localai' ? (
          <Card style={styles.modeCard}>
            <Text style={styles.cardTitle}>Local AI</Text>
            <Text style={styles.body}>Start llama-server, Ollama, LM Studio, or another local AI server.</Text>
            <View style={styles.buttonRow}>
              <Button title="Local AI is Running" onPress={() => setWizardStep('radarComputer')} />
              <Button title="Back" variant="ghost" onPress={() => setWizardStep('phone')} />
            </View>
          </Card>
        ) : null}

        {wizardStep === 'radarComputer' ? (
          <Card style={styles.modeCard}>
            <Text style={styles.cardTitle}>Computer with LLM Radar files</Text>
            <Text style={styles.body}>On the computer with the LLM Radar files, double-click Start_Here.bat. Keep that command window open, then use the QR page it opens.</Text>
            <View style={styles.buttonRow}>
              <Button title="QR Page Is Open" onPress={() => setWizardStep('pair')} />
              <Button title="Back" variant="ghost" onPress={() => setWizardStep('localai')} />
            </View>
          </Card>
        ) : null}

        {wizardStep === 'pair' ? (
          <Card style={styles.modeCard}>
            <Text style={styles.cardTitle}>Pair this phone</Text>
            {progress.running || progress.scanned ? <Text style={styles.body}>{progress.message} {progress.total ? `(${progress.scanned}/${progress.total})` : ''}</Text> : null}
            <View style={styles.buttonRow}>
              <Button title="Scan QR" onPress={() => void openQrScanner()} loading={busy} />
              <Button title="Enter Address" variant="secondary" onPress={() => { setManualMode('fallback'); setActive('manual'); }} />
              <Button title="Back" variant="ghost" onPress={() => setWizardStep('radarComputer')} />
            </View>
          </Card>
        ) : null}

        {heartbeat.status === 'failed' ? (
          <Card style={styles.feedbackError}>
            <Text style={styles.cardTitle}>Connection needs attention</Text>
            <Text style={styles.warnText}>{heartbeat.message}</Text>
            <View style={styles.buttonRow}>
              <Button title="Recheck" onPress={() => void heartbeatSelectedEndpoint()} />
              <Button title="Troubleshooting" variant="secondary" onPress={() => setActive('more')} />
            </View>
          </Card>
        ) : null}
      </View>
    );
  }

  function renderActionFeedbackCard() {
    if (!actionFeedback) return null;
    const tone = actionFeedback.status === 'success' ? 'good' : actionFeedback.status === 'error' ? 'bad' : actionFeedback.status === 'warning' ? 'warn' : 'info';
    return (
      <Card style={[styles.feedbackCard, actionFeedback.status === 'success' && styles.feedbackSuccess, actionFeedback.status === 'error' && styles.feedbackError]}>
        <View style={styles.detailHead}>
          <View style={{ flex: 1, gap: 5 }}>
            <Text style={styles.cardTitle}>{actionFeedback.title}</Text>
            <Text style={styles.body}>{actionFeedback.message}</Text>
          </View>
          <Pill label={actionFeedback.status.toUpperCase()} tone={tone} />
        </View>
        {actionFeedback.detail ? <Text style={styles.resultText}>{actionFeedback.detail}</Text> : null}
      </Card>
    );
  }


  function renderDashboard() {
    const connected = !!selected && selected.status !== 'offline' && selected.models.length > 0;
    return (
      <View style={styles.stack}>
        <Card style={[styles.heroCard, connected && styles.connectedHeroCard]}>
          {!connected ? <Pill label="SETUP" tone={heartbeat.status === 'checking' ? 'info' : 'neutral'} /> : null}
          <Text style={styles.heroTitle}>{connected ? 'Connected' : 'Connect to Local AI'}</Text>
          {connected && selected ? <Text style={styles.bodyStrong}>Local AI reachable: {selected.models[0]?.name || selected.provider}</Text> : null}
          {!connected && heartbeat.status === 'failed' ? <Text style={styles.warnText}>{heartbeat.message}</Text> : null}
          <View style={styles.buttonRow}>
            {!connected ? <Button title="Start Setup" onPress={() => void startWizard('phone')} /> : null}
            {connected ? <Button title="Chat" onPress={() => setActive('chat')} /> : null}
            {connected ? <Button title={showHomeActions ? 'Hide More' : 'More Actions'} variant="secondary" onPress={() => setShowHomeActions(v => !v)} /> : null}
          </View>
        </Card>

        {connected && showHomeActions ? (
          <Card style={styles.modeCard}>
            <Text style={styles.cardTitle}>Next</Text>
            <View style={styles.choiceGrid}>
              <View style={styles.compactButtonCell}><Button title="See Model" variant="secondary" onPress={() => setShowModelDetails(v => !v)} /></View>
              <View style={styles.compactButtonCell}><Button title="See Speed" variant="secondary" onPress={() => setActive('benchmark')} /></View>
              <View style={styles.compactButtonCell}><Button title="Ask File" variant="secondary" onPress={() => setActive('rag')} /></View>
              <View style={styles.compactButtonCell}><Button title="Share Result" variant="secondary" onPress={() => void shareProofBundle()} /></View>
              <View style={styles.compactButtonCell}><Button title={selected && selected.models.length > 1 ? 'Switch Model' : 'Connection'} variant="ghost" onPress={() => selected && selected.models.length > 1 ? setActive('benchmark') : void startWizard('localai')} /></View>
            </View>
          </Card>
        ) : null}

        {connected && showHomeActions && showModelDetails && selected ? (
          <Card style={styles.modeCard}>
            <Text style={styles.cardTitle}>Model</Text>
            <Row label="Model" value={selected.models[0]?.name || selected.models[0]?.id || 'No model returned yet'} />
            <Row label="Server" value={selected.provider || selected.kind || 'Unknown'} />
            <View style={styles.buttonRow}>
              <Button title="Refresh" variant="secondary" onPress={refreshSelected} loading={busy} />
              <Button title="Hide" variant="ghost" onPress={() => setShowModelDetails(false)} />
            </View>
          </Card>
        ) : null}

        {active === 'dashboard' && !(connected && actionFeedback?.status === 'success' && /^connected$/i.test(actionFeedback.title)) ? renderActionFeedbackCard() : null}

        {!connected && heartbeat.status !== 'none' ? (
          <Card>
            <Text style={styles.cardTitle}>Status</Text>
            <Text style={styles.body}>{heartbeat.message}</Text>
            <View style={styles.buttonRow}>
              <Button title="Refresh" variant="secondary" onPress={() => void heartbeatSelectedEndpoint()} loading={heartbeat.status === 'checking' || busy} />
              {heartbeat.status === 'failed' ? <Button title="Fix Connection" onPress={() => void startWizard('phone')} /> : null}
            </View>
          </Card>
        ) : null}
      </View>
    );
  }

  function renderDiscovery() {
    const activePorts = progress.running ? 'running' : `${QUICK_AI_PORTS.join(', ')}`;
    return (
      <View style={styles.stack}>
        <SectionTitle title="Discover" />
        <Card>
          <Text style={styles.cardTitle}>Automatic discovery</Text>
          
          <Row label="Network" value={network?.type || 'Unknown'} />
          <Row label="Phone IP" value={network?.ipAddress || 'Unknown'} />
          <Row label="Subnet" value={settings?.lastSubnetPrefix || network?.subnetPrefix || 'Unknown'} />
          <Row label="Quick ports" value={activePorts} />
          {progress.running || progress.scanned ? <Text style={styles.body}>{progress.message} {progress.total ? `(${progress.scanned}/${progress.total})` : ''}</Text> : null}
          <View style={styles.buttonRow}>
            <Button title="Start discovery" onPress={() => void findLocalAiService(SERVICE_TARGETS[0])} loading={progress.running && progress.mode === 'wifi'} />
            {progress.running ? <Button title="Stop" variant="danger" onPress={stopWifiScan} /> : <Button title="Deep scan" variant="secondary" onPress={() => startWifiScan('deep')} />}
          </View>
        </Card>

        <Card>
          <Text style={styles.cardTitle}>Need another way?</Text>
          <View style={styles.buttonRow}>
            <Button title="Choose service" variant="secondary" onPress={() => setActive('service')} />
            <Button title="Scan QR" variant="secondary" onPress={() => void openQrScanner()} />
            <Button title="Manual entry" variant="ghost" onPress={() => { setManualMode('fallback'); setActive('manual'); }} />
          </View>
        </Card>

        {selected ? renderEndpointDetail(selected) : <EmptyState title="No endpoint selected" body="Use Choose service, Scan QR, or Manual entry if discovery finds nothing." />}
      </View>
    );
  }

  function renderServiceChoice() {
    const primaryTargets = SERVICE_TARGETS.filter(target => target.key !== 'all');
    return (
      <View style={styles.stack}>
        <SectionTitle title="Choose service" />
        {primaryTargets.map(target => (
          <Card key={target.key}>
            <View style={styles.detailHead}>
              <View style={{ flex: 1, gap: 5 }}>
                <Text style={styles.cardTitle}>{target.label.replace('Find ', '')}</Text>

              </View>
              <Pill label={target.ports.join(', ')} tone="info" />
            </View>

            <View style={styles.buttonRow}>
              <Button title={`Find ${target.label.replace('Find ', '')}`} onPress={() => void findLocalAiService(target)} loading={progress.running && progress.mode === 'wifi'} />
              <Button title="Scan QR" variant="secondary" onPress={() => void openQrScanner()} />
            </View>
          </Card>
        ))}
        <Card>
          <Text style={styles.cardTitle}>Need manual entry?</Text>
          <View style={styles.buttonRow}>
            <Button title="Manual entry" variant="secondary" onPress={() => { setManualMode('fallback'); setActive('manual'); }} />
            <Button title="Discover instead" variant="ghost" onPress={() => setActive('discovery')} />
          </View>
        </Card>
      </View>
    );
  }

  function renderManual() {
    const port = String(parsePort(laptopPort, 8080));
    const exampleUrl = network?.subnetPrefix ? `http://${network.subnetPrefix}.25:${port}` : `http://192.168.1.25:${port}`;
    return (
      <View style={styles.stack}>
        <SectionTitle title="Manual entry" />

        <Card>
          <Text style={styles.cardTitle}>Enter endpoint</Text>
          
          <Field label="IP, host:port, or endpoint URL" value={manualUrl} onChangeText={setManualUrl} placeholder={exampleUrl} />
          <Field label="Bearer token, optional" value={manualToken} onChangeText={setManualToken} placeholder="Only if your endpoint requires it" secureTextEntry />
          {progress.running || progress.scanned ? <Text style={styles.body}>{progress.message} {progress.total ? `(${progress.scanned}/${progress.total})` : ''}</Text> : null}
          <View style={styles.buttonRow}>
            <Button title="Check endpoint" onPress={addManualEndpoint} loading={busy && progress.mode === 'manual'} disabled={!manualUrl.trim()} />
            <Button title="Scan QR" variant="secondary" onPress={() => void openQrScanner()} />
            <Button title="Choose service" variant="ghost" onPress={() => setActive('service')} />
          </View>
        </Card>


      </View>
    );
  }

  function renderServiceSetupCard(target: ServiceTarget) {
    return (
      <Card key={target.key}>
        <View style={styles.detailHead}>
          <View style={{ flex: 1, gap: 5 }}>
            <Text style={styles.cardTitle}>{target.label}</Text>
            <Text style={styles.body}>{target.primaryPath}</Text>
          </View>
          <Pill label={target.ports.join(', ')} tone="info" />
        </View>
        <Text style={styles.body}>{target.help}</Text>
        <View style={styles.buttonRow}>
          <Button title="Search now" variant="secondary" onPress={() => void findLocalAiService(target)} loading={progress.running && progress.mode === 'wifi'} />
        </View>
      </Card>
    );
  }

  function renderEndpointDetail(endpoint: EndpointRecord) {
    return (
      <Card>
        <View style={styles.detailHead}>
          <View style={{ flex: 1, gap: 5 }}>
            <Text style={styles.cardTitle}>{endpoint.name}</Text>
            <Text style={styles.body}>{endpoint.baseUrl}</Text>
          </View>
          <Pill label={endpoint.status.toUpperCase()} tone={endpoint.status === 'healthy' ? 'good' : endpoint.status === 'warning' ? 'warn' : 'bad'} />
        </View>
        <Row label="Provider" value={endpoint.provider} />
        <Row label="Kind" value={endpoint.kind} />
        <Row label="Latency" value={formatDuration(endpoint.latencyMs)} />
        <Row label="Last seen" value={formatDate(endpoint.lastSeenAt)} />
        <Row label="Computer URL" value={endpoint.helperUrl || '—'} />
        <Row label="Phone Access version" value={endpoint.helperVersion || '—'} />
        <Row label="Ports" value={`Phone Access port ${endpoint.helperPort || '—'} · AI ${endpoint.aiPort || endpoint.port || '—'}`} />
        <Row label="Evidence" value={endpoint.evidence?.join(', ') || '—'} />
        {endpoint.error ? <Text style={styles.warnText}>{endpoint.error}</Text> : null}
        <View style={styles.buttonRow}>
          <Button title="Refresh endpoint" variant="secondary" onPress={refreshSelected} loading={busy} />
          <Button title={endpoint.favorite ? 'Unfavorite profile' : 'Favorite profile'} variant="ghost" onPress={() => void toggleFavoriteEndpoint(endpoint)} />
          <Button title="Delete profile" variant="ghost" onPress={() => void deleteEndpointProfile(endpoint)} />
        </View>
        {endpoint.models.length ? (
          <View style={styles.stackSmall}>
            <Text style={styles.cardTitle}>Models</Text>
            <View style={styles.wrap}>{endpoint.models.map(model => <Pill key={model.id} label={model.name} tone={model.id === selectedModel ? 'good' : 'neutral'} />)}</View>
            <View style={styles.buttonRow}>
              <Button title="Chat" onPress={() => setActive('chat')} />
              <Button title="Ask File" variant="secondary" onPress={() => setActive('rag')} />
              <Button title="Library" variant="secondary" onPress={() => setActive('library')} />
              <Button title="More tools" variant="ghost" onPress={() => setActive('more')} />
            </View>
          </View>
        ) : <Text style={styles.body}>No model inventory exposed yet. Speed check and test message stay hidden until models are available.</Text>}
      </Card>
    );
  }

  function renderQrPair() {
    const canScan = !!cameraPermission?.granted;
    const connected = !!selected && selected.status !== 'offline' && selected.models.length > 0;
    if (connected && !qrPreview && !qrReconnectMode) {
      return (
        <View style={styles.stack}>
          <Card style={styles.connectedHeroCard}>
            <Pill label="CONNECTED" tone="good" />
            <Text style={styles.heroTitle}>Phone is paired</Text>
            {selected ? <Text style={styles.bodyStrong}>{selected.models[0]?.name || selected.provider}</Text> : null}
            <View style={styles.buttonRow}>
              <Button title="Chat" onPress={() => setActive('chat')} />
              <Button title="Reconnect QR" variant="secondary" onPress={() => { setQrLocked(false); setQrPreview(''); void openQrScanner(); }} />
              <Button title="Home" variant="ghost" onPress={() => setActive('dashboard')} />
            </View>
          </Card>
        </View>
      );
    }
    return (
      <View style={styles.stack}>
        <SectionTitle title="Scan QR" />
        {!canScan ? (
          <Card>
            <Text style={styles.cardTitle}>Camera permission</Text>
            <Button title="Allow Camera" onPress={() => void openQrScanner()} />
          </Card>
        ) : (
          <View style={styles.cameraWrap}>
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={qrLocked ? undefined : handleQrScanned}
            />
            <View pointerEvents="none" style={styles.cameraOverlay}>
              <View style={styles.scannerFrame} />
              <Text style={styles.cameraHint}>{qrLocked ? 'Verifying…' : 'Hold QR inside frame'}</Text>
            </View>
          </View>
        )}
        {qrPreview ? (
          <Card style={actionFeedback?.status === 'success' ? styles.feedbackSuccess : styles.modeCard}>
            <Text style={styles.cardTitle}>{actionFeedback?.status === 'success' ? 'Connected' : 'Verifying QR'}</Text>
            {progress.running || progress.scanned ? <Text style={styles.resultText}>{progress.message} {progress.total ? `(${progress.scanned}/${progress.total})` : ''}</Text> : null}
            {actionFeedback ? <Text style={styles.body}>{actionFeedback.message}</Text> : null}
            <View style={styles.buttonRow}>
              <Button title={actionFeedback?.status === 'success' ? 'Send Message' : 'Scan Again'} variant={actionFeedback?.status === 'success' ? 'primary' : 'secondary'} onPress={() => actionFeedback?.status === 'success' ? setActive('chat') : (setQrLocked(false), setQrPreview(''), setNotice('Ready to scan.'))} />
              <Button title="Enter Address" variant="ghost" onPress={() => setActive('manual')} />
            </View>
          </Card>
        ) : null}
        {!canScan || !qrPreview ? (
          <Card>
            <Text style={styles.cardTitle}>No QR?</Text>
            <View style={styles.buttonRow}>
              <Button title="Enter Address" variant="secondary" onPress={() => setActive('manual')} />
              <Button title="Setup" variant="ghost" onPress={() => setActive('wizard')} />
            </View>
          </Card>
        ) : null}
      </View>
    );
  }

  function renderBenchmark() {
    if (!selected || !selected.models.length) return <EmptyState title="Speed locked" body="Connect first." />;
    const latest = benchmarks[0];
    const latestRate = latest ? Math.round((latest.successCount / Math.max(1, latest.promptCount)) * 100) : 0;
    const progressLabel = benchmarkProgress.phase === 'rag-lite' ? 'FILE-LITE' : String(benchmarkProgress.phase || 'DONE').toUpperCase();
    return (
      <View style={styles.stack}>
        <SectionTitle title="See Speed" />

        {benchmarkProgress.running || benchmarkProgress.message ? (
          <Card style={styles.modeCard}>
            <View style={styles.detailHead}>
              <View style={{ flex: 1, gap: 5 }}>
                <Text style={styles.cardTitle}>{benchmarkProgress.running ? 'Checking speed…' : 'Last check status'}</Text>
                <Text style={styles.body}>{benchmarkProgress.message || 'Ready.'}</Text>
              </View>
              <Pill label={benchmarkProgress.running ? 'RUNNING' : progressLabel} tone={benchmarkProgress.running ? 'info' : benchmarkProgress.phase === 'error' ? 'bad' : 'neutral'} />
            </View>
            {benchmarkProgress.total ? <Row label="Progress" value={`${benchmarkProgress.current}/${benchmarkProgress.total}`} /> : null}
            {benchmarkProgress.promptTitle ? <Row label="Now" value={benchmarkProgress.promptTitle} /> : null}
            {benchmarkProgress.running ? <Button title="Cancel" variant="danger" onPress={cancelBenchmark} /> : null}
          </Card>
        ) : null}

        {latest ? (
          <Card style={styles.connectedHeroCard}>
            <View style={styles.detailHead}>
              <View style={{ flex: 1, gap: 5 }}>
                <Text style={styles.cardTitle}>Latest speed result</Text>
                <Text style={styles.body}>{latest.modelId}</Text>
              </View>
              <Pill label={(latest.verdict || latest.status).toUpperCase()} tone={latest.status === 'success' ? 'good' : latest.status === 'warning' ? 'warn' : 'bad'} />
            </View>
            <View style={styles.metricsRow}>
              <Metric label="passed" value={`${latestRate}%`} tone={latest.status === 'success' ? 'good' : 'warn'} />
              <Metric label="total" value={formatDuration(latest.avgTotalResponseMs || latest.avgLatencyMs)} tone="info" />
              <Metric label="tokens/sec" value={latest.avgOutputTps ?? latest.estimatedTps ?? '—'} tone="good" />
            </View>
            <View style={styles.buttonRow}>
              <Button title="Share Result" variant="secondary" onPress={() => void shareSpecificMarkdownReport(latest)} />
              <Button title="More Metrics" variant="ghost" onPress={() => setShowBenchmarkOptions(v => !v)} />
            </View>
          </Card>
        ) : null}

        <Card style={styles.modeCard}>
          <Text style={styles.cardTitle}>Check this model</Text>
          {selected.models.length > 1 ? <View style={styles.wrap}>{selected.models.map(m => <Button key={m.id} title={m.name} variant={selectedModel === m.id ? 'primary' : 'secondary'} onPress={() => setSelectedModelId(m.id)} />)}</View> : <Row label="Model" value={selected.models[0]?.name || selectedModel || 'Selected model'} />}
          <Button title="Check Speed" onPress={() => void runBenchmark('quick')} loading={busy || benchmarkProgress.running} disabled={busy || benchmarkProgress.running} />
        </Card>

        <Card>
          <Button title={showBenchmarkOptions ? 'Hide More Checks' : 'Show More Checks'} variant="secondary" onPress={() => setShowBenchmarkOptions(v => !v)} />
          {showBenchmarkOptions ? (
            <View style={styles.buttonRow}>
              <Button title="Run Standard Check" variant="secondary" onPress={() => void runBenchmark('standard')} disabled={busy || benchmarkProgress.running} />
              <Button title="Run Consultant Check" variant="ghost" onPress={() => void runBenchmark('consultant')} disabled={busy || benchmarkProgress.running} />
            </View>
          ) : null}
        </Card>

        {showBenchmarkOptions && benchmarks.length > 1 ? (
          <>
            <SectionTitle title="Previous results" subtitle="Most recent first." />
            {benchmarks.slice(1, 6).map(result => {
              const successRate = Math.round((result.successCount / Math.max(1, result.promptCount)) * 100);
              return (
                <Card key={result.id}>
                  <View style={styles.detailHead}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>{result.mode === 'quick' ? 'Quick' : result.mode === 'consultant' ? 'Consultant' : 'Standard'} · {result.modelId}</Text>
                      <Text style={styles.body}>{formatDate(result.startedAt)}</Text>
                    </View>
                    <Pill label={(result.verdict || result.status).toUpperCase()} tone={result.status === 'success' ? 'good' : result.status === 'warning' ? 'warn' : 'bad'} />
                  </View>
                  <View style={styles.metricsRow}>
                    <Metric label="passed" value={`${successRate}%`} tone={result.status === 'success' ? 'good' : 'warn'} />
                    <Metric label="tokens/sec" value={result.avgOutputTps ?? result.estimatedTps ?? '—'} tone="good" />
                  </View>
                </Card>
              );
            })}
          </>
        ) : null}
      </View>
    );
  }

  function buildChatTurns() {
    const turns: { id: string; user?: ChatMessage | null; assistant?: ChatMessage | null; waiting?: boolean; pendingPrompt?: string; createdAt: number }[] = [];
    let pendingUser: ChatMessage | null = null;
    for (const message of chatMessages) {
      if (message.role === 'user') {
        if (pendingUser) {
          turns.push({ id: pendingUser.id, user: pendingUser, createdAt: pendingUser.createdAt });
        }
        pendingUser = message;
      } else if (pendingUser) {
        turns.push({ id: `${pendingUser.id}-${message.id}`, user: pendingUser, assistant: message, createdAt: Math.max(pendingUser.createdAt, message.createdAt) });
        pendingUser = null;
      } else {
        turns.push({ id: message.id, assistant: message, createdAt: message.createdAt });
      }
    }
    if (pendingUser) turns.push({ id: pendingUser.id, user: pendingUser, createdAt: pendingUser.createdAt });
    if (chatWaitingPrompt) {
      const lastMatchingUserTurn = [...turns].reverse().find(turn => !turn.assistant && turn.user?.text === chatWaitingPrompt);
      if (lastMatchingUserTurn) {
        lastMatchingUserTurn.waiting = true;
        lastMatchingUserTurn.createdAt = chatInteractionAnchor || lastMatchingUserTurn.createdAt;
      } else {
        turns.push({ id: `waiting-${chatInteractionAnchor || Date.now()}`, pendingPrompt: chatWaitingPrompt, waiting: true, createdAt: chatInteractionAnchor || Date.now() });
      }
    }
    return turns.sort((a, b) => b.createdAt - a.createdAt);
  }

  function renderChatTurn({ item }: { item: { id: string; user?: ChatMessage | null; assistant?: ChatMessage | null; waiting?: boolean; pendingPrompt?: string } }) {
    const user = item.user;
    const assistant = item.assistant;
    const promptText = user?.text || item.pendingPrompt || '';
    return (
      <View style={styles.chatTurnCard}>
        {promptText ? (
          <View style={[styles.chatBubble, styles.userBubble]}>
            <Text style={styles.userMessageText}>{promptText}</Text>
          </View>
        ) : null}
        {item.waiting ? (
          <View style={[styles.chatBubble, styles.aiBubble, styles.aiBubbleAttached]}>
            <Text style={styles.messageText}>Thinking…</Text>
          </View>
        ) : assistant ? (
          <View style={[styles.chatBubble, styles.aiBubble, styles.aiBubbleAttached, assistant.error && styles.feedbackError]}>
            <Text style={styles.messageText}>{assistant.error || assistant.text}</Text>
          </View>
        ) : null}
      </View>
    );
  }

  function renderChatFooter() {
    if (!pendingPrivacy) return null;
    return (
      <View style={styles.chatFooterStack}>
        <Card style={styles.privacyBox}>
          <Pill label={`${pendingPrivacy.highestRisk.toUpperCase()} RISK`} tone={pendingPrivacy.highestRisk === 'critical' || pendingPrivacy.highestRisk === 'high' ? 'bad' : 'warn'} />
          <Text style={styles.warnText}>{pendingPrivacy.message}</Text>
          <View style={styles.buttonRow}>
            <Button title="Redact & Send" onPress={() => void sendChat(pendingPrivacy.redactedText)} />
            <Button title="Send Anyway" variant="secondary" onPress={() => void sendChat(pendingPrompt)} />
            <Button title="Cancel" variant="ghost" onPress={() => { setPendingPrivacy(null); setPendingPrompt(''); }} />
          </View>
        </Card>
      </View>
    );
  }

  function renderChat() {
    if (!selected || !selected.models.length) return <EmptyState title="Chat locked" body="Connect first." />;
    const canSend = !!chatInput.trim() && !busy;
    const chatTurns = buildChatTurns();
    const latestTurns = chatTurns.slice(0, 8);
    return (
      <KeyboardAvoidingViewShim>
        <View style={styles.chatShell}>
          <View style={styles.chatTitleRowCompact}>
            <Text style={styles.chatScreenTitleCompact}>Chat</Text>
          </View>
          <View style={styles.chatTopComposer}>
            <TextInput
              value={chatInput}
              onChangeText={setChatInput}
              placeholder="Enter chat here"
              placeholderTextColor="#BFD0E8"
              multiline
              autoCapitalize="sentences"
              autoCorrect
              selectionColor="#7DB3FF"
              textAlignVertical="top"
              style={styles.chatTopInput}
              onFocus={() => setChatInputFocused(true)}
              onBlur={() => { if (!keyboardVisible) setChatInputFocused(false); }}
            />
            <Pressable
              onPress={canSend ? () => void sendChat() : undefined}
              disabled={!canSend}
              style={({ pressed }) => [styles.chatSendMini, !canSend && styles.chatSendDisabled, pressed && canSend && { opacity: 0.82 }]}
            >
              <Text style={styles.chatSendText}>{busy ? 'Sending…' : 'Send'}</Text>
            </Pressable>
            {(chatMessages.length || chatWaitingPrompt) ? (
              <Pressable onPress={() => void clearCurrentChat()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.clearSubtleTop}>
                <Text style={styles.clearSubtleText}>Clear</Text>
              </Pressable>
            ) : null}
          </View>
          <FlatList
            ref={chatScrollRef as any}
            style={styles.chatScroll}
            data={latestTurns}
            keyExtractor={item => item.id}
            renderItem={renderChatTurn}
            contentContainerStyle={[styles.chatContentTop, latestTurns.length ? null : styles.chatContentEmpty]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            ListEmptyComponent={null}
            ListFooterComponent={renderChatFooter}
            onContentSizeChange={() => chatScrollRef.current?.scrollToOffset({ offset: 0, animated: true })}
            onLayout={() => chatScrollRef.current?.scrollToOffset({ offset: 0, animated: false })}
          />
        </View>
      </KeyboardAvoidingViewShim>
    );
  }

  function renderChatHistory() {
    if (!selected || !selected.models.length) return <EmptyState title="Chat locked" body="Connect first." />;
    return null;
  }

  function renderChatComposer() {
    return null;
  }


  function renderRag() {
    if (!selected || !selected.models.length) return <EmptyState title="Files locked" body="Connect first." />;
    const doc = ragProof?.document || {};
    const snippets = Array.isArray(ragProof?.snippets) ? ragProof?.snippets || [] : [];
    const docReady = !!doc.ready && pdfUploadStage !== 'error';
    const latestSummary = ragProof?.summary ? ragProof : ragProofs.find((proof: any) => proof.action === 'summary' && (!doc.filename || proof.document?.filename === doc.filename));
    const latestAnswer = ragProof?.answer ? ragProof : ragProofs.find((proof: any) => proof.action === 'ask' && (!doc.filename || proof.document?.filename === doc.filename));
    const fileName = String(doc.filename || 'No file loaded');
    const helper = currentRagHelperUrl();
    const readyTone = docReady ? 'good' : pdfUploadStage === 'error' ? 'bad' : pdfUploadStage === 'uploading' || pdfUploadStage === 'processing' ? 'info' : 'neutral';
    const readyLabel = docReady ? 'READY' : pdfUploadStage === 'uploading' ? 'UPLOADING' : pdfUploadStage === 'processing' ? 'READING' : pdfUploadStage === 'error' ? 'FIX NEEDED' : 'NO FILE';
    const sampleNeedsQrRefresh = actionFeedback?.title === 'QR refresh needed';

    if (ragFocusMode === 'summary') {
      return (
        <View style={styles.stackTight}>
          <SectionTitle title="Summary" />
          <Card style={styles.focusCard}>
            <View style={styles.detailHead}>
              <Text style={[styles.cardTitleSmall, { flex: 1 }]}>{fileName}</Text>
              <Pill label={ragBusy ? 'WORKING' : latestSummary?.summary ? 'READY' : ragProof?.error ? 'ERROR' : 'WAITING'} tone={ragProof?.error ? 'bad' : latestSummary?.summary ? 'good' : 'info'} />
            </View>
            {ragBusy ? <Text style={styles.bodySmall}>Summarizing…</Text> : null}
            {ragProof?.error ? <Text style={styles.warnTextSmall}>{ragProof.error}</Text> : null}
            {latestSummary?.summary ? <Text style={styles.resultTextCompact}>{latestSummary.summary}</Text> : null}
            <View style={styles.compactButtonGrid}>
              {docReady ? <View style={styles.compactButtonCell}><Button title="Ask" onPress={() => setRagFocusMode('ask')} /></View> : null}
              <View style={styles.compactButtonCell}><Button title="Back" variant="secondary" onPress={() => setRagFocusMode('normal')} /></View>
              {latestSummary?.summary ? <View style={styles.compactButtonCell}><Button title="Share" variant="secondary" onPress={() => void shareRagProof(latestSummary)} /></View> : null}
              <View style={styles.compactButtonCell}><Button title="New File" variant="ghost" onPress={() => { setRagFocusMode('normal'); void uploadPdfFromPhone(); }} /></View>
            </View>
          </Card>
        </View>
      );
    }

    if (ragFocusMode === 'ask') {
      const answerReady = !!(ragProof?.action === 'ask' && (ragProof.answer || ragProof.error));
      return (
        <KeyboardAvoidingViewShim>
          <View style={styles.stackTight}>
            <SectionTitle title={answerReady ? 'Answer' : 'Ask'} />
            {!answerReady ? (
              <Card style={styles.focusCard}>
                <Text style={styles.cardTitleSmall}>{fileName}</Text>
                <TextInput
                  value={ragQuestion}
                  onChangeText={setRagQuestion}
                  placeholder="Ask about this file"
                  placeholderTextColor="#BFD0E8"
                  multiline
                  autoCapitalize="sentences"
                  autoCorrect
                  selectionColor="#7DB3FF"
                  textAlignVertical="top"
                  style={styles.askTopInput}
                  onFocus={() => setRagQuestionFocused(true)}
                  onBlur={() => { if (!keyboardVisible) setRagQuestionFocused(false); }}
                />
                <View style={styles.askActionRow}>
                  <View style={styles.askSendCell}><Button title={ragBusy ? 'Asking…' : 'Ask'} onPress={() => void runRagAsk()} loading={ragBusy} disabled={!ragQuestion.trim() || ragBusy || !docReady} /></View>
                  <View style={styles.askBackCell}><Button title="Back" variant="ghost" onPress={() => setRagFocusMode('normal')} /></View>
                </View>
              </Card>
            ) : (
              <Card style={ragProof?.status === 'error' ? styles.feedbackError : styles.feedbackSuccess}>
                <View style={styles.detailHead}>
                  <Text style={[styles.cardTitleSmall, { flex: 1 }]}>Response</Text>
                  <Pill label={ragProof?.status === 'error' ? 'ERROR' : 'OK'} tone={ragProof?.status === 'error' ? 'bad' : 'good'} />
                </View>
                {ragProof?.query ? <Text style={styles.questionCompact}>Q: {ragProof.query}</Text> : null}
                {ragProof?.error ? <Text style={styles.warnTextSmall}>{ragProof.error}</Text> : null}
                {ragProof?.answer ? <Text style={styles.resultTextCompact}>{ragProof.answer}</Text> : null}
                {snippets.length ? <Text style={styles.bodySmall}>Sources: {snippets.length}</Text> : null}
                <View style={styles.compactButtonGrid}>
                  <View style={styles.compactButtonCell}><Button title="Ask Again" onPress={() => { setRagQuestion(''); setRagFocusMode('ask'); }} /></View>
                  <View style={styles.compactButtonCell}><Button title="Back" variant="secondary" onPress={() => setRagFocusMode('normal')} /></View>
                  <View style={styles.compactButtonCell}><Button title="Share" variant="secondary" onPress={() => void shareRagProof()} /></View>
                </View>
              </Card>
            )}
          </View>
        </KeyboardAvoidingViewShim>
      );
    }

    return (
      <View style={styles.stackTight}>
        <SectionTitle title="Files" />
        <Card style={styles.modeCard}>
          <View style={styles.detailHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitleSmall}>{docReady ? 'Ready' : pdfUploadStage === 'error' ? 'Action needed' : 'Test a file'}</Text>
              <Text style={styles.bodySmall}>{docReady ? fileName : pdfUploadStage === 'error' ? (sampleNeedsQrRefresh ? 'Reconnect QR, then retry sample.' : 'Reconnect the Computer file route.') : 'Choose a small PDF/TXT/MD or load Sample.'}</Text>
            </View>
            <Pill label={readyLabel} tone={readyTone} />
          </View>
          {pdfUploadStage === 'uploading' || pdfUploadStage === 'processing' ? <Text style={styles.bodySmall}>{pdfUploadStage === 'uploading' ? 'Uploading…' : 'Reading text…'}</Text> : null}
          {doc.warning ? <Text style={styles.warnTextSmall}>{String(doc.warning)}</Text> : null}
          {ragProof?.error && !docReady ? <Text style={styles.warnTextSmall}>{ragProof.error}</Text> : null}
          <View style={styles.compactButtonGrid}>
            {!docReady ? <View style={styles.compactButtonCell}><Button title="Choose File" onPress={() => void uploadPdfFromPhone()} loading={ragBusy && (pdfUploadStage === 'uploading' || pdfUploadStage === 'processing')} /></View> : null}
            {!docReady ? <View style={styles.compactButtonCell}><Button title="Sample" variant="secondary" onPress={() => void loadRagSampleDocument()} loading={ragBusy} disabled={!helper && !currentRagHelperCandidates().length} /></View> : null}
            {docReady ? <View style={styles.compactButtonCell}><Button title="Summarize" onPress={() => void runRagSummary()} loading={ragBusy} disabled={ragBusy} /></View> : null}
            {docReady ? <View style={styles.compactButtonCell}><Button title="Ask" variant="secondary" onPress={() => setRagFocusMode('ask')} disabled={ragBusy} /></View> : null}
            {docReady ? <View style={styles.compactButtonCell}><Button title="New File" variant="ghost" onPress={() => void uploadPdfFromPhone()} loading={ragBusy && (pdfUploadStage === 'uploading' || pdfUploadStage === 'processing')} /></View> : null}
            {(doc.filename || ragProof || pdfUploadStage !== 'idle') ? <View style={styles.compactButtonCell}><Button title="Clear" variant="ghost" onPress={() => void clearFileState(true)} loading={ragBusy} /></View> : null}
          </View>
        </Card>

        {pdfUploadStage === 'error' || actionFeedback?.status === 'error' ? (
          <Card style={styles.diagnosticHintCard}>
            <View style={styles.detailHead}>
              <Text style={[styles.cardTitleSmall, { flex: 1 }]}>Next step</Text>
              <Pill label="FIX" tone="warn" />
            </View>
            <Text style={styles.bodySmall}>{actionFeedback?.message || 'File route failed.'}</Text>
            <View style={styles.compactButtonGrid}>
              <View style={styles.compactButtonCell}><Button title={sampleNeedsQrRefresh ? "Reconnect QR" : "Rescan QR"} onPress={() => void openQrScanner()} /></View>
              <View style={styles.compactButtonCell}><Button title="Try Sample" variant="secondary" onPress={() => void loadRagSampleDocument()} loading={ragBusy} disabled={!helper && !currentRagHelperCandidates().length} /></View>
              <View style={styles.compactButtonCell}><Button title="Diagnostics" variant="ghost" onPress={() => { setMorePanel('diagnostics'); setActive('more'); }} /></View>
              <View style={styles.compactButtonCell}><Button title="Check Again" variant="ghost" onPress={() => void recheckFileUploadRoute()} loading={ragBusy} /></View>
            </View>
          </Card>
        ) : null}

        {(latestSummary?.summary || latestAnswer?.answer) ? (
          <Card style={styles.focusCard}>
            <Text style={styles.cardTitleSmall}>Latest result</Text>
            {latestAnswer?.answer ? <Text style={styles.resultTextPreview}>{truncate(latestAnswer.answer, 120)}</Text> : latestSummary?.summary ? <Text style={styles.resultTextPreview}>{truncate(latestSummary.summary, 120)}</Text> : null}
            <View style={styles.compactButtonGrid}>
              {latestSummary?.summary ? <View style={styles.compactButtonCell}><Button title="Open Summary" variant="secondary" onPress={() => setRagFocusMode('summary')} /></View> : null}
              {latestAnswer?.answer ? <View style={styles.compactButtonCell}><Button title="Open Answer" variant="secondary" onPress={() => setRagFocusMode('ask')} /></View> : null}
            </View>
          </Card>
        ) : null}
      </View>
    );
  }

  function renderLibrary() {
    return (
      <View style={styles.stack}>
        <SectionTitle title="Library" />
        <View style={styles.metricsRow}>
          <Metric label="endpoints" value={endpoints.length} tone={endpoints.length ? 'info' : 'neutral'} />
          <Metric label="benchmarks" value={benchmarks.length} tone={benchmarks.length ? 'good' : 'neutral'} />
          <Metric label="file results" value={ragProofs.length} tone={ragProofs.length ? 'good' : 'neutral'} />
          <Metric label="packs" value={helperPacks.length} tone={helperPacks.length ? 'good' : 'neutral'} />
        </View>

        <Card style={styles.heroCard}>
          <Text style={styles.cardTitle}>Phone proof bundle</Text>
          
          {readiness ? <Pill label={`READINESS · ${String(readiness.status || 'unknown').toUpperCase()}`} tone={readiness.status === 'ready' ? 'good' : readiness.status === 'blocked' ? 'bad' : 'warn'} /> : <Pill label="READINESS NOT RUN" tone="neutral" />}
          <View style={styles.buttonRow}>
            <Button title="Run readiness" onPress={() => void runPhoneReadinessCheck()} loading={readinessBusy} />
            <Button title="Share bundle" variant="secondary" onPress={() => void shareProofBundle()} />
            <Button title="Copy bundle" variant="ghost" onPress={() => void copyProofBundle()} />
          </View>
          {readiness?.suggestedNext ? <Text style={styles.body}>{readiness.suggestedNext}</Text> : null}
        </Card>

        <SectionTitle title="Endpoint profiles" />
        {endpoints.length ? endpoints.map(endpoint => <EndpointCard key={endpoint.id} endpoint={endpoint} onPress={() => { setSelectedEndpointId(endpoint.id); setActive('discovery'); }} />) : <EmptyState title="No endpoints saved" body="Connect with EZ Connect first." />}

        <SectionTitle title="File results" subtitle={ragProofs.length ? 'Most recent first.' : 'No file results saved yet.'} />
        {ragProofs.length ? <View style={styles.buttonRow}><Button title="Clear File Results" variant="ghost" onPress={() => void clearFileResults()} /></View> : null}
        {ragProofs.length ? ragProofs.slice(0, 8).map((proof, index) => (
          <Card key={proof.proofId || index}>
            <View style={styles.detailHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{proof.action || 'File'} · {proof.document?.filename || 'file proof'}</Text>
                <Text style={styles.body}>{proof.generatedAt || (proof.savedAt ? formatDate(proof.savedAt) : '')}</Text>
              </View>
              <Pill label={(proof.status || 'saved').toUpperCase()} tone={proof.status === 'error' ? 'bad' : 'good'} />
            </View>
            {proof.summary ? <Text style={styles.body}>{truncate(proof.summary, 360)}</Text> : null}
            {proof.answer ? <Text style={styles.body}>{truncate(proof.answer, 360)}</Text> : null}
            {Array.isArray(proof.snippets) && proof.snippets.length ? <Row label="Snippets/pages" value={proof.snippets.slice(0, 4).map((x: any) => `p${x.page || '?'}`).join(', ')} /> : null}
            <View style={styles.buttonRow}>
              <Button title="Copy" variant="secondary" onPress={() => void copyRagProof(proof)} />
              <Button title="Share" variant="ghost" onPress={() => void shareRagProof(proof)} />
            </View>
          </Card>
        )) : <EmptyState title="No file results" body="Use Files after uploading a small PDF, TXT, or MD from this phone." />}

        <SectionTitle title="Check reports" subtitle={benchmarks.length ? 'Open Advanced tools for full report actions.' : 'No check reports yet.'} />
        {benchmarks.length ? <View style={styles.buttonRow}><Button title="Clear Checks" variant="ghost" onPress={() => void clearCheckResults()} /></View> : null}
        {benchmarks.slice(0, 5).map(result => <Card key={result.id}><Text style={styles.cardTitle}>{result.mode || 'benchmark'} · {result.modelId}</Text><Text style={styles.body}>{formatDate(result.startedAt)} · {result.successCount}/{result.promptCount} prompts passed</Text></Card>)}

        {helperPacks.length ? <Card><Text style={styles.cardTitle}>Latest imported Consultant Pack</Text><Text style={styles.body}>{importedPackSummary(helperPacks[0])}</Text><View style={styles.buttonRow}><Button title="Share imported pack" variant="secondary" onPress={() => void shareLatestImportedPack()} /><Button title="Clear Imports" variant="ghost" onPress={() => void clearImportedPacks()} /></View></Card> : null}
      </View>
    );
  }

  function renderMore() {
    const connected = !!selected && selected.status !== 'offline' && selected.models.length > 0;
    const diagnosticDoc = ragProof?.document || null;
    const diagnosticDocReady = !!diagnosticDoc?.ready;
    const showMain = morePanel === 'main';
    return (
      <View style={styles.stackTight}>
        <SectionTitle title="More" />
        <Card>
          <View style={styles.detailHead}>
            <Text style={[styles.cardTitleSmall, { flex: 1 }]}>{showMain ? 'Choose a category' : morePanel === 'tools' ? 'Advanced' : morePanel.charAt(0).toUpperCase() + morePanel.slice(1)}</Text>
            <Pill label={connected ? 'CONNECTED' : 'SETUP'} tone={connected ? 'good' : 'warn'} />
          </View>
          {!showMain ? <Button title="Back to Categories" variant="ghost" onPress={() => setMorePanel('main')} /> : null}
          {showMain ? (
            <View style={styles.compactButtonGrid}>
              <View style={styles.compactButtonCell}><Button title="Connection" variant="secondary" onPress={() => setMorePanel('connection')} /></View>
              <View style={styles.compactButtonCell}><Button title="Advanced" variant="secondary" onPress={() => setMorePanel('tools')} /></View>
              <View style={styles.compactButtonCell}><Button title="Diagnostics" variant="secondary" onPress={() => setMorePanel('diagnostics')} /></View>
              <View style={styles.compactButtonCell}><Button title="Share" variant="secondary" onPress={() => setMorePanel('share')} /></View>
              <View style={styles.compactButtonCell}><Button title="Clean Up" variant="ghost" onPress={() => setMorePanel('cleanup')} /></View>
              <View style={styles.compactButtonCell}><Button title="About" variant="ghost" onPress={() => setMorePanel('about')} /></View>
            </View>
          ) : null}
        </Card>

        {morePanel === 'connection' ? (
          <Card style={styles.modeCard}>
            <View style={styles.compactButtonGrid}>
              <View style={styles.compactButtonCell}><Button title={connected ? 'Change' : 'Setup'} onPress={() => void startWizard('phone')} /></View>
              <View style={styles.compactButtonCell}><Button title="Refresh" variant="secondary" onPress={() => void heartbeatSelectedEndpoint()} loading={heartbeat.status === 'checking' || busy} /></View>
              {endpoints.length ? <View style={styles.compactButtonCell}><Button title="Forget" variant="ghost" onPress={() => void forgetPhoneConnection()} /></View> : null}
            </View>
            <Button title={showAdvanced ? 'Hide Troubleshooting' : 'Troubleshooting'} variant="ghost" onPress={() => setShowAdvanced(!showAdvanced)} />
            {showAdvanced ? (
              <View style={styles.compactButtonGrid}>
                <View style={styles.compactButtonCell}><Button title="Service" variant="secondary" onPress={() => setActive('service')} /></View>
                <View style={styles.compactButtonCell}><Button title="Discover" variant="secondary" onPress={() => setActive('discovery')} /></View>
                <View style={styles.compactButtonCell}><Button title="Manual" variant="secondary" onPress={() => { setManualMode('fallback'); setActive('manual'); }} /></View>
              </View>
            ) : null}
          </Card>
        ) : null}

        {morePanel === 'tools' ? (
          <Card style={styles.modeCard}>
            <View style={styles.compactButtonGrid}>
              <View style={styles.compactButtonCell}><Button title="Speed" variant="secondary" onPress={() => setActive('benchmark')} disabled={!hasModels} /></View>
              <View style={styles.compactButtonCell}><Button title="Files" variant="secondary" onPress={() => setActive('rag')} disabled={!hasModels} /></View>
              <View style={styles.compactButtonCell}><Button title="Reports" variant="secondary" onPress={() => setActive('reports')} /></View>
              <View style={styles.compactButtonCell}><Button title="Library" variant="secondary" onPress={() => setActive('library')} /></View>
            </View>
          </Card>
        ) : null}

        {morePanel === 'share' ? (
          <Card style={styles.modeCard}>
            <View style={styles.compactButtonGrid}>
              <View style={styles.compactButtonCell}><Button title="Readiness" onPress={() => void runPhoneReadinessCheck()} loading={readinessBusy} /></View>
              <View style={styles.compactButtonCell}><Button title="Share Bundle" variant="secondary" onPress={() => void shareProofBundle()} /></View>
            </View>
            {readiness ? <Row label="Status" value={String(readiness.status || 'unknown').toUpperCase()} /> : null}
          </Card>
        ) : null}

        {morePanel === 'diagnostics' ? (
          <Card style={styles.modeCard}>
            <View style={styles.compactButtonGrid}>
              <View style={styles.compactButtonCell}><Button title="Sample" variant="secondary" onPress={() => void loadRagSampleDocument()} loading={ragBusy} disabled={!currentRagHelperUrl()} /></View>
              <View style={styles.compactButtonCell}><Button title="Test TXT/MD" onPress={() => void runCleanDocumentDiagnostic()} loading={documentDiagnosticBusy} disabled={!currentRagHelperUrl()} /></View>
              <View style={styles.compactButtonCell}><Button title="File Route" variant="secondary" onPress={() => void recheckFileUploadRoute()} loading={ragBusy} /></View>
              <View style={styles.compactButtonCell}><Button title="Refresh" variant="secondary" onPress={() => void heartbeatSelectedEndpoint()} loading={heartbeat.status === 'checking' || busy} /></View>
              {(documentDiagnostic || httpTestResult || readiness || diagnosticDoc) ? <View style={styles.compactButtonCell}><Button title="Clear" variant="ghost" onPress={() => void clearDiagnosticsState()} /></View> : null}
            </View>
            {diagnosticDoc ? (
              <View style={styles.inlineResultBoxCompact}>
                <View style={styles.detailHead}>
                  <Text style={[styles.cardTitleSmall, { flex: 1 }]}>{diagnosticDocReady ? 'Sample ready' : 'Sample failed'}</Text>
                  <Pill label={diagnosticDocReady ? 'READY' : 'CHECK'} tone={diagnosticDocReady ? 'good' : 'bad'} />
                </View>
                {diagnosticDoc.warning ? <Text style={styles.warnTextSmall}>{String(diagnosticDoc.warning)}</Text> : null}
                {diagnosticDocReady ? (
                  <View style={styles.compactButtonGrid}>
                    <View style={styles.compactButtonCell}><Button title="Summarize" onPress={() => { setActive('rag'); setRagFocusMode('summary'); void runRagSummary(); }} loading={ragBusy} disabled={ragBusy || !hasModels} /></View>
                    <View style={styles.compactButtonCell}><Button title="Ask" variant="secondary" onPress={() => { setActive('rag'); setRagFocusMode('ask'); }} /></View>
                  </View>
                ) : null}
              </View>
            ) : null}
            {documentDiagnostic ? (
              <View style={styles.inlineResultBoxCompact}>
                <View style={styles.detailHead}>
                  <Text style={[styles.cardTitleSmall, { flex: 1 }]}>TXT/MD check</Text>
                  <Pill label={documentDiagnostic.assessment?.status ? String(documentDiagnostic.assessment.status).toUpperCase() : documentDiagnostic.error ? 'ERROR' : 'DONE'} tone={documentDiagnostic.error ? 'bad' : 'info'} />
                </View>
                {documentDiagnostic.error ? <Text style={styles.warnTextSmall}>{documentDiagnostic.error}</Text> : null}
                {documentDiagnostic.summary?.text ? <Text style={styles.resultTextPreview}>{truncate(documentDiagnostic.summary.text, 140)}</Text> : null}
              </View>
            ) : null}
            {actionFeedback?.status === 'error' ? <Text style={styles.warnTextSmall}>{actionFeedback.message}</Text> : null}
          </Card>
        ) : null}

        {morePanel === 'cleanup' ? (
          <Card style={styles.cleanupCard}>
            <View style={styles.compactButtonGrid}>
              {(chatMessages.length || chatWaitingPrompt) ? <View style={styles.compactButtonCell}><Button title="Clear Chat" variant="ghost" onPress={() => void clearCurrentChat()} /></View> : null}
              {(ragProof || pdfUploadStage !== 'idle' || ragQuestion || ragSearchQuery) ? <View style={styles.compactButtonCell}><Button title="Clear File" variant="ghost" onPress={() => void clearFileState(true)} loading={ragBusy} /></View> : null}
              {ragProofs.length ? <View style={styles.compactButtonCell}><Button title="Clear Results" variant="ghost" onPress={() => void clearFileResults()} /></View> : null}
              {(benchmarks.length || readiness) ? <View style={styles.compactButtonCell}><Button title="Clear Checks" variant="ghost" onPress={() => void clearCheckResults()} /></View> : null}
              {(documentDiagnostic || httpTestResult || actionFeedback) ? <View style={styles.compactButtonCell}><Button title="Clear Diag" variant="ghost" onPress={() => void clearDiagnosticsState()} /></View> : null}
              {helperPacks.length ? <View style={styles.compactButtonCell}><Button title="Clear Imports" variant="ghost" onPress={() => void clearImportedPacks()} /></View> : null}
              {endpoints.length ? <View style={styles.compactButtonCell}><Button title="Forget Phone" variant="ghost" onPress={() => void forgetPhoneConnection()} /></View> : null}
              <View style={styles.compactButtonCell}><Button title="Start Fresh" variant="danger" onPress={() => void startFresh()} /></View>
            </View>
          </Card>
        ) : null}

        {morePanel === 'about' ? (
          <Card style={styles.modeCard}>
            <Text style={styles.cardTitleSmall}>LLM Radar 0.7.0</Text>
          </Card>
        ) : null}
      </View>
    );
  }

  function renderReports() {
    const report = settings ? buildReport(endpoints, benchmarks, settings) : null;
    const top = report?.topMetrics;
    const comparison = compareReports(benchmarks[0], benchmarks[1]);
    return (
      <View style={styles.stack}>
        <SectionTitle title="Advanced" />
        {endpoints.length || benchmarks.length || helperPacks.length ? (
          <>
            {report && top ? (
              <Card style={styles.heroCard}>
                <Pill label={top.overallVerdict.toUpperCase()} tone={top.overallVerdict === 'Ready' ? 'good' : top.overallVerdict === 'Blocked' || top.overallVerdict === 'Not Recommended for This Use Case' ? 'bad' : 'warn'} />
                <Text style={styles.cardTitle}>Executive summary</Text>
                <Text style={styles.body}>{report.executiveSummary}</Text>
                <View style={styles.metricsRow}>
                  <Metric label="TTFT" value={top.avgTtft} tone="info" />
                  <Metric label="output" value={top.avgOutputSpeed} tone="good" />
                  <Metric label="success" value={top.successRate} tone="neutral" />
                </View>
                <Row label="Model" value={top.model} />
                <Row label="Engine" value={top.engine} />
                <Row label="Privacy/locality" value={top.privacyStatus} />
                <Text style={styles.body}>{top.recommendation}</Text>
              </Card>
            ) : null}

            <Card>
              <Text style={styles.cardTitle}>Consultant Pack</Text>
              
              <Field label="Computer URL" value={helperImportUrl} onChangeText={setHelperImportUrl} placeholder={selected?.helperUrl || 'http://192.168.12.151:49321'} />
              <View style={styles.buttonRow}>
                {selected?.helperUrl ? <Button title="Use saved computer URL" variant="secondary" onPress={() => setHelperImportUrl(selected?.helperUrl || '')} /> : null}
                <Button title="Import Consultant Pack" onPress={() => void importHelperConsultantPack()} loading={busy} />
                {helperPacks.length ? <Button title="Share imported pack" variant="secondary" onPress={() => void shareLatestImportedPack()} /> : null}
                {helperPacks.length ? <Button title="Copy imported summary" variant="ghost" onPress={() => void copyLatestImportedSummary()} /> : null}
              </View>
              {helperPacks.length ? (
                <View style={styles.stackSmall}>
                  <Pill label={`${helperPacks.length} IMPORTED`} tone="good" />
                  <Text style={styles.body}>{importedPackSummary(helperPacks[0])}</Text>
                </View>
              ) : <Text style={styles.body}>No Consultant Pack imported yet.</Text>}
            </Card>

            <Card>
              <Text style={styles.cardTitle}>Share report</Text>
              
              <View style={styles.buttonRow}>
                <Button title="Share Markdown" onPress={shareMarkdownReport} />
                <Button title="Copy summary" variant="secondary" onPress={shareConsultantSummary} />
                <Button title="Share LAN invite" variant="secondary" onPress={shareLanInvite} />
                <Button title="Share JSON" variant="ghost" onPress={shareJsonReport} />
                <Button title="Share CSV" variant="ghost" onPress={shareCsvReport} />
              </View>
            </Card>

            <Card>
              <Text style={styles.cardTitle}>Same-Wi-Fi LAN invite</Text>
              
              <Text style={styles.warnText}>Use only on trusted Wi‑Fi.</Text>
              <View style={styles.buttonRow}>
                <Button title="Show LAN QR" variant="secondary" onPress={() => prepareLanInvitePreview()} />
                <Button title="Copy QR payload" variant="ghost" onPress={() => void copyLanInvitePayload()} />
              </View>
              {lanInvitePreview ? (
                <View style={styles.stackSmall}>
                  
                  <QrMatrixView matrix={lanInvitePreview.matrix} />
                  <Text style={styles.mono}>{truncate(lanInvitePreview.payload, 260)}</Text>
                </View>
              ) : null}
            </Card>

            <Card>
              <Text style={styles.cardTitle}>Comparison preview</Text>
              <Text style={styles.body}>{comparison.summary}</Text>
              {comparison.available ? (
                <View style={styles.metricsRow}>
                  <Metric label="TTFT delta" value={comparison.ttftDeltaMs == null ? '—' : `${comparison.ttftDeltaMs > 0 ? '+' : ''}${comparison.ttftDeltaMs}ms`} tone={comparison.ttftDeltaMs != null && comparison.ttftDeltaMs <= 0 ? 'good' : 'warn'} />
                  <Metric label="TPS delta" value={comparison.outputTpsDelta == null ? '—' : `${comparison.outputTpsDelta > 0 ? '+' : ''}${comparison.outputTpsDelta}`} tone={comparison.outputTpsDelta != null && comparison.outputTpsDelta >= 0 ? 'good' : 'warn'} />
                  <Metric label="success delta" value={comparison.successRateDelta == null ? '—' : `${comparison.successRateDelta > 0 ? '+' : ''}${comparison.successRateDelta}%`} tone="info" />
                </View>
              ) : null}
            </Card>
          </>
        ) : <EmptyState title="Advanced tools locked" body="Connect first." />}
      </View>
    );
  }

  function renderSettings() {
    return (
      <View style={styles.stack}>
        <SectionTitle title="Settings" />
        <Card>
          <SettingSwitch label="Demo mode" value={settings?.demoMode ?? false} onValueChange={toggleDemoMode} body="Adds sample results." />
          <SettingSwitch label="Privacy review" value={settings?.privacyReview ?? true} onValueChange={value => { if (settings) void updateSettings({ ...settings, privacyReview: value }); }} body="Review before sending." />
        </Card>
        <Card>
          <Text style={styles.cardTitle}>Network diagnostics</Text>
          <Row label="Network type" value={network?.type || 'Unknown'} />
          <Row label="Connected" value={network?.isConnected ? 'Yes' : 'No'} />
          <Row label="Phone IP" value={network?.ipAddress || 'Unknown'} />
          <Row label="Subnet" value={network?.subnetPrefix || 'Unknown'} />
          <Row label="Quick ports" value={QUICK_AI_PORTS.join(', ')} />
          <Row label="Deep ports" value={DEEP_AI_PORTS.join(', ')} />
          <View style={styles.buttonRow}>
            <Button title="Refresh network" variant="secondary" onPress={() => getNetworkSnapshot().then(setNetwork).catch(error => setNotice(sanitizeError(error)))} />
          </View>
        </Card>
        <Card>
          <Text style={styles.cardTitle}>Phone HTTP Test</Text>
          
          <Field label="Local HTTP URL" value={httpTestUrl} onChangeText={setHttpTestUrl} placeholder="http://192.168.12.151:8080/health" />
          <View style={styles.buttonRow}>
            <Button title="Test from APK" onPress={() => void runPhoneHttpTest()} disabled={!httpTestUrl.trim()} />
            {selected ? <Button title="Use selected /health" variant="secondary" onPress={() => setHttpTestUrl(`${selected.baseUrl}/health`)} /> : null}
          </View>
          {httpTestResult ? <Text style={styles.mono}>{httpTestResult}</Text> : null}
          
        </Card>

        <Card>
          <Text style={styles.cardTitle}>Clean up</Text>
          <Text style={styles.body}>Use Start Fresh when you want to clear saved tests, files, diagnostics, checks, and phone connection state on this phone.</Text>
          <Button title="Start Fresh" variant="danger" onPress={startFresh} />
        </Card>
      </View>
    );
  }
}


function applyResponseMode(prompt: string, mode: ResponseMode): string {
  if (mode === 'short') return `${prompt}\n\nResponse style: answer briefly in 1-3 short sentences unless the user explicitly asks for more.`;
  if (mode === 'detailed') return `${prompt}\n\nResponse style: provide a clear, useful, detailed answer. Use brief structure only where it helps.`;
  return prompt;
}

function buildRagProofMarkdown(proof: any): string {
  const doc = proof?.document || {};
  const snippets = Array.isArray(proof?.snippets) ? proof.snippets : [];
  const lines = [
    '# LLM Radar Ask About a File',
    '',
    `Generated: ${proof?.generatedAt || proof?.savedAt || new Date().toISOString()}`,
    `Action: ${proof?.action || 'rag'}`,
    `Status: ${proof?.status || 'unknown'}`,
    `computer with LLM Radar files: ${proof?.source || proof?.helperUrl || 'unknown'}`,
    `Endpoint: ${proof?.endpointUrl || 'unknown'}`,
    '',
    '## Document',
    `- File: ${doc.filename || 'Unknown'}`,
    `- Pages: ${doc.pages || 'Unknown'}`,
    `- Chunks: ${doc.chunkCount || snippets.length || 0}`,
    doc.warning ? `- Warning: ${doc.warning}` : '',
    '',
    proof?.query ? `## Query\n${proof.query}\n` : '',
    proof?.summary ? `## Summary\n${proof.summary}\n` : '',
    proof?.answer ? `## Answer\n${proof.answer}\n` : '',
    proof?.error ? `## Error\n${proof.error}\n` : '',
    '## Snippets / pages used',
    snippets.length ? snippets.map((s: any, i: number) => `### Snippet ${i + 1}\n- Page: ${s.page || 'Unknown'}\n- Score: ${s.score ?? 'Unknown'}\n\n${s.text || s.preview || ''}`).join('\n\n') : 'No snippets returned.'
  ].filter(Boolean);
  return lines.join('\n');
}



function buildPhoneProofBundleMarkdown(snapshot: any): string {
  const checks = Array.isArray(snapshot?.checks) ? snapshot.checks : [];
  const endpoint = snapshot?.endpoint || {};
  const latestRag = snapshot?.latestRag || {};
  const latestBenchmark = snapshot?.latestBenchmark || {};
  const network = snapshot?.network || {};
  const ragLine = latestRag?.document
    ? `- Action: ${latestRag.action || 'rag'}\n- File: ${latestRag.document?.filename || 'Unknown'}\n- Status: ${latestRag.status || 'Unknown'}\n- Snippets/pages: ${Array.isArray(latestRag.snippets) ? latestRag.snippets.map((snip: any) => `p${snip.page || '?'}`).slice(0, 6).join(', ') : 'Unknown'}`
    : '- No file result captured.';
  const benchmarkLine = latestBenchmark?.id
    ? `- Model: ${latestBenchmark.modelId || 'Unknown'}\n- Result: ${latestBenchmark.successCount ?? '?'} / ${latestBenchmark.promptCount ?? '?'} prompts passed\n- Average response: ${latestBenchmark.avgTotalResponseMs || latestBenchmark.avgLatencyMs || 'Unknown'} ms`
    : '- No phone benchmark report captured.';
  const readinessLines = checks.length
    ? checks.map((check: any) => `- ${String(check.status || 'unknown').toUpperCase()}: ${check.label} — ${check.detail || ''}`).join('\n')
    : '- Readiness check has not been run yet.';
  const lines = [
    '# LLM Radar Phone Proof Bundle',
    '',
    `Generated: ${snapshot?.generatedAt || new Date().toISOString()}`,
    `App version: ${snapshot?.appVersion || '0.7.0'}`,
    `Readiness: ${String(snapshot?.status || 'not-run').toUpperCase()}`,
    '',
    '## Endpoint',
    `- Provider: ${endpoint.provider || 'Unknown'}`,
    `- URL: ${endpoint.baseUrl || 'Unknown'}`,
    `- Status: ${endpoint.status || 'Unknown'}`,
    `- Models: ${Array.isArray(endpoint.models) && endpoint.models.length ? endpoint.models.join(', ') : 'Unknown'}`,
    '',
    '## Phone/network',
    `- Network type: ${network.type || 'Unknown'}`,
    `- Phone IP: ${network.ipAddress || 'Unknown'}`,
    `- Subnet: ${network.subnetPrefix || 'Unknown'}`,
    `- Test messages in selected session: ${snapshot?.chatMessages ?? 'Unknown'}`,
    '',
    '## Readiness checks',
    readinessLines,
    '',
    '## Latest file result',
    ragLine,
    '',
    '## Latest benchmark/report',
    benchmarkLine,
    '',
    '## Suggested next action',
    snapshot?.suggestedNext || 'Run readiness check, then share this bundle when the result matches the intended demo/client use.'
  ];
  return lines.filter(Boolean).join('\n');
}


function buildSetupSuggestion(endpoint: EndpointRecord | undefined, latestChat: ChatMessage | undefined, latestPdf: RagProofState | null, latestBenchmark: BenchmarkResult | undefined): string {
  if (!endpoint) return '';
  const chatOk = !!latestChat && !latestChat.error;
  const pdfOk = !!latestPdf && latestPdf.status !== 'error' && (!!latestPdf.summary || !!latestPdf.answer);
  const pdfFailed = !!latestPdf && latestPdf.status === 'error';
  const speed = latestBenchmark?.avgOutputTps ?? latestBenchmark?.estimatedTps ?? null;
  const slow = typeof speed === 'number' && speed > 0 && speed < 8;
  const server = endpoint.provider || endpoint.kind || 'this server';

  if (chatOk && pdfOk && slow) {
    return `Test message and file reading worked, but speed looks low. Consider trying a smaller model or use LLM Parametizer on the Local AI computer: run Autotune, save a profile, restart with that profile, then retest here.`;
  }
  if (chatOk && pdfFailed) {
    return `Test message worked, but the file reading test did not complete. This setup may need more context or a cleaner text-based PDF, TXT, or MD file. For deeper tuning, use LLM Parametizer on the Local AI computer: Autotune → Save Profile → Restart Local LLM → Retest here.`;
  }
  if (chatOk && pdfOk) {
    return `This setup answered chat and handled the file test. Good next steps: share the result, see speed, or switch models and compare.`;
  }
  if (chatOk) {
    return `The test message worked. Next, choose one task: see the model, see speed, ask about a file, share the result, or switch models.`;
  }
  if (endpoint.status !== 'offline') {
    return `Connection is ready for ${server}. Send one short test message, then choose what to check next.`;
  }
  return '';
}

function importedPackSummary(pack: any): string {
  const endpoint = pack?.report?.endpoint?.url || pack?.invite?.endpointUrl || 'Unknown endpoint';
  const model = (pack?.report?.models?.modelIds || [])[0] || 'Unknown model';
  const benchmark = pack?.benchmark?.benchmark || {};
  const passCount = benchmark.passCount ?? '—';
  const promptCount = benchmark.promptCount ?? '—';
  const status = pack?.overallStatus || 'Unknown';
  const locality = pack?.report?.locality?.status || 'Unknown locality';
  return `LLM Radar Consultant Pack: ${status}. Endpoint: ${endpoint}. Model: ${model}. Check: ${passCount}/${promptCount} prompts passed. Locality: ${locality}.`;
}

function buildImportedPackMarkdown(pack: any): string {
  const endpoint = pack?.report?.endpoint || {};
  const models = pack?.report?.models || {};
  const benchmark = pack?.benchmark?.benchmark || {};
  const rag = pack?.ragReadiness || {};
  const access = pack?.accessReview || {};
  const appReadiness = Array.isArray(pack?.appReadiness) ? pack.appReadiness : [];
  const appRows = appReadiness.map((item: any) => `- ${item?.name || 'Check'}: ${item?.status || 'Unknown'}${item?.evidence ? ` — ${item.evidence}` : ''}`).join('\n') || '- Not available';
  const lines = [
    '# LLM Radar Imported Consultant Pack',
    '',
    `Imported: ${pack?.importedAt ? new Date(pack.importedAt).toLocaleString() : 'Unknown'}`,
    `Generated by computer with LLM Radar files: ${pack?.generatedAt || 'Unknown'}`,
    `computer with LLM Radar files: ${pack?.importedFromHelperUrl || endpoint.helperUrl || 'Unknown'}`,
    '',
    '## Executive summary',
    `- Overall status: ${pack?.overallStatus || 'Unknown'}`,
    `- Endpoint: ${endpoint.url || pack?.invite?.endpointUrl || 'Unknown'}`,
    `- Service: ${endpoint.provider || endpoint.service || 'Unknown'}`,
    `- Model: ${(models.modelIds || [])[0] || 'Unknown'}`,
    `- Locality: ${pack?.report?.locality?.status || 'Unknown'}`,
    `- Privacy risk: ${pack?.report?.locality?.privacyRisk || 'Unknown'}`,
    `- Access review: ${access.status || 'Unknown'} / ${access.risk || 'Unknown'}`,
    '',
    '## Benchmark',
    `- Prompts passed: ${benchmark.passCount ?? 'Unknown'}/${benchmark.promptCount ?? 'Unknown'}`,
    `- Average response: ${benchmark.averageResponseMs ?? 'Unknown'} ms`,
    `- Estimated output TPS: ${benchmark.averageOutputTokensPerSecond ?? 'Unknown'}`,
    '',
    '## App readiness',
    appRows,
    '',
    '## File readiness',
    `- Status: ${rag.status || 'Unknown'}`,
    `- Embeddings: ${rag.embeddingStatus || 'Unknown'}`,
    `- Vector dimension: ${rag.vectorDimension || 'Unknown'}`,
    '',
    '## Recommendation',
    pack?.recommendation || 'Use this imported pack as portable proof from the phone.'
  ];
  return lines.join('\n');
}


interface PairingPayload {
  baseUrl?: string;
  endpointUrl?: string;
  helperUrl?: string;
  helperVersion?: string;
  helperPort?: number;
  aiPort?: number;
  laptopName?: string;
  laptopIp?: string;
  name?: string;
  token?: string;
  serviceHint?: string;
  provider?: string;
  port?: number;
}

function parsePairingPayload(raw: string): PairingPayload | null {
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const helperUrl = String(obj.helperUrl || obj.pairingUrl || '').trim();
      const endpointUrl = String(obj.endpointUrl || obj.baseUrl || obj.url || obj.endpoint || obj.apiBaseUrl || '').trim();
      if (helperUrl || endpointUrl) {
        return {
          helperUrl: helperUrl || undefined,
          baseUrl: endpointUrl || undefined,
          endpointUrl: endpointUrl || undefined,
          name: stringOrUndefined(obj.name || obj.laptopName),
          token: stringOrUndefined(obj.token || obj.bearerToken),
          serviceHint: stringOrUndefined(obj.serviceHint || obj.kind || obj.provider),
          provider: stringOrUndefined(obj.provider),
          helperVersion: stringOrUndefined(obj.helperVersion),
          helperPort: numberOrUndefined(obj.helperPort),
          aiPort: numberOrUndefined(obj.aiPort),
          laptopName: stringOrUndefined(obj.laptopName),
          laptopIp: stringOrUndefined(obj.laptopIp),
          port: numberOrUndefined(obj.port || obj.aiPort)
        };
      }
    }
  } catch {
    // Not JSON; try URL formats below.
  }

  try {
    const url = new URL(text);
    if (url.protocol === 'llmradar:' || url.protocol === 'llm-radar:') {
      const helperUrl = url.searchParams.get('helperUrl') || url.searchParams.get('pairingUrl') || '';
      const baseUrl = url.searchParams.get('baseUrl') || url.searchParams.get('endpointUrl') || url.searchParams.get('url') || '';
      if (!helperUrl && !baseUrl) return null;
      return {
        helperUrl: helperUrl || undefined,
        baseUrl: baseUrl || undefined,
        endpointUrl: baseUrl || undefined,
        name: url.searchParams.get('name') || undefined,
        token: url.searchParams.get('token') || undefined,
        serviceHint: url.searchParams.get('serviceHint') || undefined,
        helperVersion: url.searchParams.get('helperVersion') || undefined,
        helperPort: numberOrUndefined(url.searchParams.get('helperPort')),
        aiPort: numberOrUndefined(url.searchParams.get('aiPort')),
        laptopName: url.searchParams.get('laptopName') || undefined,
        laptopIp: url.searchParams.get('laptopIp') || undefined,
        port: numberOrUndefined(url.searchParams.get('port') || url.searchParams.get('aiPort'))
      };
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const path = url.pathname.toLowerCase();
      if (path === '/pair' || path === '/reachability' || path === '/status') {
        return { helperUrl: `${url.protocol}//${url.host}` };
      }
      return { baseUrl: text, endpointUrl: text, port: numberOrUndefined(url.port) };
    }
  } catch {
    // Not a URL.
  }

  const normalized = text.match(/^(?:https?:\/\/)?[a-zA-Z0-9.-]+(?::\d{2,5})?(?:\/.*)?$/) ? normalizeMaybeUrl(text) : '';
  return normalized ? { baseUrl: normalized, endpointUrl: normalized } : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = String(value || '').trim();
  return text || undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined;
}

function normalizeMaybeUrl(value: string): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text : `http://${text}`;
}



function buildHelperPortCandidates(value: string): string[] {
  const normalized = normalizeMaybeUrl(value).replace(/\/+$/, '');
  if (!normalized) return [];
  try {
    const url = new URL(normalized);
    const host = url.hostname;
    if (!host) return [];
    const candidates: string[] = [];
    for (let port = 49321; port <= 49329; port += 1) candidates.push(`${url.protocol}//${host}:${port}`);
    if (url.port) candidates.unshift(`${url.protocol}//${host}:${url.port}`);
    return Array.from(new Set(candidates));
  } catch {
    return [];
  }
}

function normalizeHelperBase(value: string): string {
  const normalized = normalizeMaybeUrl(value).replace(/\/+$/, '');
  try {
    const url = new URL(normalized);
    return `${url.protocol}//${url.host}`;
  } catch {
    return normalized;
  }
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; data?: any; text?: string; error?: string }> {
  const raw = await fetchTextWithTimeout(url, timeoutMs);
  let data: any;
  try { data = raw.text ? JSON.parse(raw.text) : undefined; } catch { data = undefined; }
  return { ...raw, data };
}

function uploadFormDataWithTimeout(url: string, form: FormData, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    const timer = setTimeout(() => {
      try { xhr.abort(); } catch {}
      resolve({ ok: false, status: 0, text: '', error: `Upload timed out before ${url} answered.` });
    }, timeoutMs);
    xhr.open('POST', url);
    xhr.setRequestHeader('Accept', 'application/json,text/plain,text/html,*/*');
    xhr.onload = () => {
      clearTimeout(timer);
      const status = Number(xhr.status || 0);
      resolve({ ok: status >= 200 && status < 300, status, text: String(xhr.responseText || '') });
    };
    xhr.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, status: Number(xhr.status || 0), text: String(xhr.responseText || ''), error: `Network request failed while uploading to ${url}.` });
    };
    xhr.onabort = () => {
      clearTimeout(timer);
      resolve({ ok: false, status: Number(xhr.status || 0), text: '', error: `Upload was canceled before ${url} answered.` });
    };
    try {
      xhr.send(form);
    } catch (error) {
      clearTimeout(timer);
      resolve({ ok: false, status: 0, text: '', error: sanitizeError(error) });
    }
  });
}

async function fetchJsonPostWithTimeout(url: string, body: any, timeoutMs: number): Promise<{ ok: boolean; status: number; data?: any; text?: string; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', signal: ctrl.signal, headers: { Accept: 'application/json,text/plain,*/*', 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const text = await response.text();
    let data: any;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    return { ok: response.status >= 200 && response.status < 300, status: response.status, text, data };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: sanitizeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: ctrl.signal, headers: { Accept: 'application/json,text/plain,text/html,*/*' } });
    const text = await response.text();
    return { ok: response.status >= 200 && response.status < 300, status: response.status, text };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: sanitizeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function parsePort(value: string, fallback: number): number {
  const parsed = Number(String(value || '').replace(/[^0-9]/g, ''));
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

function buildManualFallbackPorts(primaryPort: string): number[] {
  const first = parsePort(primaryPort, 8080);
  return Array.from(new Set([first, 8080, 11434, 1234, 3000, 8000, 5000]));
}


function KeyboardAvoidingViewShim({ children }: { children: React.ReactNode }) {
  if (Platform.OS === 'ios') {
    return <KeyboardAvoidingView style={styles.chatKav} behavior="padding">{children}</KeyboardAvoidingView>;
  }
  return <View style={styles.chatKav}>{children}</View>;
}

function QrMatrixView({ matrix }: { matrix: QrMatrix }) {
  if (!matrix.length) return <Text style={styles.warnText}>QR could not be generated. Use Copy QR payload instead.</Text>;
  const size = matrix.length;
  const cell = Math.max(2, Math.floor(248 / Math.max(1, size)));
  return (
    <View style={styles.qrOuter}>
      <View style={[styles.qrGrid, { width: cell * size, height: cell * size }]}>
        {matrix.map((row, rowIndex) => row.map((dark, colIndex) => (
          <View key={`${rowIndex}-${colIndex}`} style={{ width: cell, height: cell, backgroundColor: dark ? '#000' : '#fff' }} />
        )))}
      </View>
    </View>
  );
}

function SetupChoice({ step, title, body, primary, onPress }: { step: string; title: string; body: string; primary: string; onPress: () => void }) {
  return (
    <Card style={styles.choiceCard}>
      <View style={styles.choiceBadge}><Text style={styles.choiceBadgeText}>{step}</Text></View>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      <Button title={primary} onPress={onPress} />
    </Card>
  );
}

function StepStatus({ label, state, onPress }: { label: string; state: 'done' | 'active' | 'todo'; onPress?: () => void }) {
  const tone = state === 'done' ? 'good' : state === 'active' ? 'info' : 'neutral';
  return (
    <View style={[styles.stepItem, state === 'active' && styles.stepItemActive]}>
      <Pill label={state === 'done' ? 'DONE' : state === 'active' ? 'NOW' : 'NEXT'} tone={tone} />
      <Text style={styles.stepLabel} onPress={onPress}>{label}</Text>
    </View>
  );
}

function SettingSwitch({ label, body, value, onValueChange }: { label: string; body: string; value: boolean; onValueChange: (value: boolean) => void | Promise<void> }) {
  return (
    <View style={styles.settingRow}>
      <View style={{ flex: 1, gap: 5 }}>
        <Text style={styles.cardTitle}>{label}</Text>
        <Text style={styles.body}>{body}</Text>
      </View>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ false: colors.panel3, true: colors.accentSoft }} thumbColor={value ? colors.accent : colors.faint} />
    </View>
  );
}

function Shell({ children, notice }: { children: React.ReactNode; notice: string }) {
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={styles.header}>{children}</View>
      <View style={styles.notice}><Text style={styles.noticeText}>{notice}</Text></View>
    </SafeAreaView>
  );
}

function mergeEndpoints(existing: EndpointRecord[], incoming: EndpointRecord[]): EndpointRecord[] {
  const map = new Map<string, EndpointRecord>();
  for (const endpoint of existing) map.set(endpoint.baseUrl, endpoint);
  for (const endpoint of incoming) {
    const prev = map.get(endpoint.baseUrl);
    map.set(endpoint.baseUrl, prev ? { ...prev, ...endpoint, id: prev.id, favorite: prev.favorite, notes: prev.notes, authMode: prev.authMode || endpoint.authMode } : endpoint);
  }
  return Array.from(map.values()).sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
}

function mergeBenchmarks(existing: BenchmarkResult[], incoming: BenchmarkResult[]): BenchmarkResult[] {
  const seen = new Set<string>();
  const all = [...incoming, ...existing].filter(item => {
    const key = item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, position: 'relative' },
  bottomUnderlay: { position: 'absolute', left: 0, right: 0, bottom: 0, height: Platform.OS === 'android' ? 230 : 130, backgroundColor: colors.bg, zIndex: 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md, backgroundColor: colors.bg },
  headerCompact: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xs, backgroundColor: colors.bg },
  title: { color: colors.text, fontWeight: '900', fontSize: typography.h1, letterSpacing: -0.5 },
  titleCompact: { color: colors.text, fontWeight: '900', fontSize: 21, letterSpacing: -0.3 },
  subtitle: { color: colors.muted, fontSize: typography.small, marginTop: 1, fontWeight: '700' },
  notice: { marginHorizontal: spacing.lg, backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 10 },
  noticeText: { color: colors.muted, fontSize: typography.small, fontWeight: '700' },
  scroll: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: Platform.OS === 'android' ? 70 : 26, gap: spacing.md },
  stack: { gap: spacing.md },
  stackTight: { gap: spacing.sm },
  chatKav: { flex: 1, backgroundColor: colors.bg },
  chatShell: { flex: 1, backgroundColor: colors.bg },
  chatKeyboardArea: { flex: 1, backgroundColor: colors.bg },
  chatTitleRow: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xs, backgroundColor: colors.bg },
  chatScreenTitle: { color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: -0.4, textAlign: 'center' },
  chatTitleRowCompact: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md, paddingTop: 2, paddingBottom: spacing.xs, backgroundColor: colors.bg },
  chatScreenTitleCompact: { color: colors.text, fontSize: 20, fontWeight: '900', letterSpacing: -0.3, textAlign: 'center' },
  chatScroll: { flex: 1, backgroundColor: colors.bg },
  chatContent: { flexGrow: 1, justifyContent: 'flex-start', paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.sm, backgroundColor: colors.bg },
  chatContentTop: { flexGrow: 1, justifyContent: 'flex-start', paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg, gap: spacing.xs, backgroundColor: colors.bg },
  chatContentEmpty: { justifyContent: 'flex-start' },
  chatFooterStack: { gap: spacing.sm },
  chatEmptyCenter: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg },
  chatEmptyCompact: { alignItems: 'center', justifyContent: 'flex-start', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  chatEmptyText: { color: '#BFD0E8', fontSize: typography.body, lineHeight: 20, fontWeight: '700', textAlign: 'center' },
  chatEmptyTextSmall: { color: '#BFD0E8', fontSize: typography.small, lineHeight: 16, fontWeight: '700', textAlign: 'center' },
  chatComposerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: Platform.OS === 'android' ? spacing.md : spacing.xs, backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)', zIndex: 80, elevation: 18 },
  chatComposerInline: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: Platform.OS === 'android' ? spacing.md : spacing.xs, backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)', zIndex: 80, elevation: 18 },
  chatComposerKeyboardOpen: { paddingBottom: spacing.sm, borderTopColor: 'rgba(138,180,248,0.22)' },
  chatTopComposer: { marginHorizontal: spacing.md, marginTop: spacing.xs, marginBottom: spacing.xs, padding: spacing.sm, borderRadius: 16, borderWidth: 1.5, borderColor: 'rgba(138,180,248,0.58)', backgroundColor: colors.panel },
  chatTopInput: { minHeight: 66, maxHeight: 116, color: '#FFFFFF', backgroundColor: colors.panel2, borderColor: colors.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, fontSize: 14, lineHeight: 18, fontWeight: '800' },
  chatSendWide: { marginTop: spacing.xs, minHeight: 38, borderRadius: 12, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent, borderWidth: 1, borderColor: colors.accent },
  chatSendMini: { marginTop: spacing.xs, minHeight: 36, width: '34%', alignSelf: 'flex-end', borderRadius: 12, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent, borderWidth: 1, borderColor: colors.accent },
  clearSubtle: { alignSelf: 'flex-end', paddingTop: 5, paddingHorizontal: 6, paddingBottom: 2 },
  clearSubtleTop: { alignSelf: 'flex-end', paddingTop: 3, paddingHorizontal: 6, paddingBottom: 0 },
  clearSubtleText: { color: '#BFD0E8', fontSize: typography.small, fontWeight: '800', opacity: 0.72 },
  chatQuickActions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', justifyContent: 'flex-end' },
  chatInputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs, backgroundColor: colors.panel2, borderColor: colors.blue, borderWidth: 1.5, borderRadius: 16, padding: spacing.xs },
  chatInputPlain: { flex: 1, minHeight: 40, maxHeight: 82, color: '#FFFFFF', paddingHorizontal: spacing.sm, paddingVertical: 8, fontSize: 13, lineHeight: 18, fontWeight: '800' },
  chatSendButton: { minHeight: 36, minWidth: 58, borderRadius: 12, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent, borderWidth: 1, borderColor: colors.accent },
  chatSendDisabled: { opacity: 0.42 },
  chatSendText: { color: colors.bg, fontSize: typography.small, fontWeight: '900' },
  testInputLarge: { minHeight: 96, maxHeight: 170, backgroundColor: colors.panel2, borderColor: colors.border, borderWidth: 1, color: colors.text, borderRadius: 12, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: typography.body, textAlignVertical: 'top' },
  stackSmall: { gap: spacing.md },
  heroCard: { backgroundColor: colors.panel2 },
  modeCard: { borderColor: 'rgba(138,180,248,0.45)', borderWidth: 1.5 },
  cleanupCard: { borderColor: 'rgba(234,242,255,0.28)', backgroundColor: colors.panel },
  chatQuestion: { color: colors.text, fontSize: typography.body, lineHeight: 18, fontWeight: '800' },
  chatAnswer: { color: colors.text, fontSize: typography.body, lineHeight: 18, fontWeight: '700' },
  metaText: { color: colors.muted, fontSize: typography.small, lineHeight: 18, fontWeight: '700' },
  chatTurnCard: { gap: 3, paddingBottom: spacing.xs },
  chatBubble: { borderRadius: 12, paddingHorizontal: spacing.sm, paddingVertical: 5, gap: 2, borderWidth: 1 },
  userBubble: { backgroundColor: '#1D7CFF', borderColor: 'rgba(255,255,255,0.14)', alignSelf: 'flex-end', maxWidth: '90%' },
  aiBubble: { backgroundColor: colors.panel2, borderColor: 'rgba(234,242,255,0.18)', alignSelf: 'flex-start', maxWidth: '92%' },
  aiBubbleAttached: { marginTop: 1 },
  chatRole: { color: colors.accent, fontSize: typography.tiny, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.5 },
  chatInputCard: { gap: spacing.sm, borderColor: 'rgba(138,180,248,0.45)' },
  chatInputRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end' },
  chatInput: { flex: 1, minHeight: 38, maxHeight: 90, backgroundColor: colors.panel2, borderColor: colors.border, borderWidth: 1, color: colors.text, borderRadius: 12, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: typography.body },
  connectedHeroCard: { borderColor: 'rgba(125,211,168,0.65)', borderWidth: 2, backgroundColor: colors.greenSoft },
  heroTitle: { color: colors.text, fontWeight: '900', fontSize: 23, lineHeight: 27, letterSpacing: -0.4 },
  bodyStrong: { color: colors.text, fontSize: typography.body, lineHeight: 18, fontWeight: '800' },
  connectionProofBox: { gap: spacing.sm, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(125,211,168,0.35)', backgroundColor: 'rgba(125,211,168,0.08)', padding: spacing.md },
  successTitle: { color: colors.green, fontSize: typography.h3, fontWeight: '900' },
  feedbackCard: { borderWidth: 2 },
  feedbackSuccess: { borderColor: 'rgba(125,211,168,0.7)', backgroundColor: 'rgba(125,211,168,0.08)' },
  feedbackError: { borderColor: 'rgba(240,138,138,0.7)', backgroundColor: 'rgba(240,138,138,0.08)' },
  inlineResultBox: { gap: spacing.sm, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel2, padding: spacing.md, marginTop: spacing.sm },
  inlineResultBoxCompact: { gap: spacing.sm, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel2, padding: spacing.sm, marginTop: spacing.sm },
  focusCard: { borderColor: 'rgba(138,180,248,0.45)', borderWidth: 1.5, backgroundColor: colors.panel },
  diagnosticHintCard: { borderColor: 'rgba(230,195,106,0.55)', borderWidth: 1.5, backgroundColor: colors.panel },
  resultText: { color: colors.text, fontSize: typography.body, lineHeight: 23, fontWeight: '700' },
  resultTextCompact: { color: colors.text, fontSize: 13, lineHeight: 19, fontWeight: '700' },
  resultTextPreview: { color: colors.text, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  choiceGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: spacing.sm, alignItems: 'stretch' },
  compactButtonGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: spacing.sm, alignItems: 'stretch' },
  compactButtonCell: { width: '48%', maxWidth: '48%', flexGrow: 0, flexShrink: 0, minWidth: 0 },
  choiceCard: { gap: spacing.sm },
  choiceBadge: { width: 30, height: 30, borderRadius: 999, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(138,180,248,0.25)' },
  choiceBadgeText: { color: colors.accent, fontSize: typography.small, fontWeight: '900' },
  metricsRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  aboutRow: { alignItems: 'flex-end', paddingTop: spacing.xs },
  aboutText: { color: colors.faint, fontSize: typography.small, fontWeight: '800', paddingVertical: 4 },
  cardTitle: { color: colors.text, fontSize: typography.h3, fontWeight: '900' },
  cardTitleSmall: { color: colors.text, fontSize: 15, fontWeight: '900' },
  body: { color: colors.muted, fontSize: typography.body, lineHeight: 18, fontWeight: '600' },
  bodySmall: { color: colors.muted, fontSize: 12, lineHeight: 16, fontWeight: '700' },
  detailHead: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  detailLine: { gap: spacing.xs, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.05)', paddingTop: spacing.sm },
  warnText: { color: colors.yellow, fontSize: typography.body, lineHeight: 18, fontWeight: '700' },
  warnTextSmall: { color: colors.yellow, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  askTopInput: { minHeight: 88, maxHeight: 140, color: '#FFFFFF', backgroundColor: colors.panel2, borderColor: colors.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, fontSize: 13, lineHeight: 18, fontWeight: '800' },
  askActionRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, alignItems: 'stretch' },
  askSendCell: { width: '38%' },
  askBackCell: { width: '38%' },
  questionCompact: { color: colors.muted, fontSize: 12, lineHeight: 17, fontWeight: '800' },
  privacyBox: { gap: spacing.md, backgroundColor: colors.yellowSoft, borderColor: 'rgba(230, 195, 106, 0.25)', borderWidth: 1, borderRadius: 16, padding: spacing.md },
  messageText: { color: colors.text, fontSize: 13, lineHeight: 18, fontWeight: '700' },
  userMessageText: { color: '#FFFFFF', fontSize: 13, lineHeight: 18, fontWeight: '800' },
  mono: { color: colors.text, fontSize: typography.small, lineHeight: 19, fontFamily: 'monospace' },
  cameraWrap: { minHeight: 320, borderRadius: 24, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, position: 'relative' },
  camera: { flex: 1, minHeight: 320 },
  cameraOverlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, backgroundColor: 'rgba(0,0,0,0.12)' },
  scannerFrame: { width: 230, height: 230, borderWidth: 2, borderColor: colors.accent, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.02)' },
  cameraHint: { color: colors.text, fontWeight: '900', backgroundColor: 'rgba(11,15,20,0.78)', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, overflow: 'hidden' },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 4 },
  stepList: { gap: spacing.sm },
  stepListCompact: { gap: spacing.xs },
  stepItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  stepItemActive: { backgroundColor: colors.panel2, borderRadius: 14, paddingHorizontal: spacing.sm },
  stepLabel: { color: colors.text, fontSize: typography.body, fontWeight: '800', flex: 1 },
  qrOuter: { alignSelf: 'center', backgroundColor: '#fff', padding: 12, borderRadius: 12, marginVertical: spacing.sm },
  qrGrid: { flexDirection: 'row', flexWrap: 'wrap', overflow: 'hidden' },
  inlineCode: { color: colors.text, fontFamily: 'monospace', fontWeight: '900' }
});
