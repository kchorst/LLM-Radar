import { BenchmarkPrompt } from '../types/domain';

export const STANDARD_PROMPTS: BenchmarkPrompt[] = [
  {
    id: 'basic-chat',
    title: 'Basic answer',
    category: 'basic',
    prompt: 'In one short paragraph, explain what a local language model server does.'
  },
  {
    id: 'json-format',
    title: 'Structured JSON',
    category: 'json',
    expects: 'json',
    prompt: 'Return only valid JSON with these keys: summary, strengths, risk. Keep each value short.'
  },
  {
    id: 'instruction-following',
    title: 'Instruction following',
    category: 'instruction',
    prompt: 'Give exactly three bullet points about why local AI testing is useful. No introduction.'
  },
  {
    id: 'short-reasoning',
    title: 'Short reasoning',
    category: 'reasoning',
    prompt: 'A local model answers in 8 seconds and produces about 160 tokens. Estimate tokens per second and state whether this is good for a live demo.'
  },
  {
    id: 'safe-neutral',
    title: 'Safe neutral prompt',
    category: 'safety',
    prompt: 'Write two neutral safety tips for sharing a local AI endpoint on the same Wi-Fi.'
  }
];

export const APP_READINESS_PROMPTS: BenchmarkPrompt[] = [
  {
    id: 'app-json',
    title: 'App JSON output',
    category: 'json',
    expects: 'json',
    prompt: 'Return only valid JSON: {"task":"classify","label":"local-ai","confidence":0.9}. Do not include markdown.'
  },
  {
    id: 'app-summary',
    title: 'Summarization',
    category: 'summarization',
    prompt: 'Summarize in one sentence: Local AI can help workshops because it runs on nearby hardware, but setup quality affects speed, privacy, and reliability.'
  },
  {
    id: 'app-extraction',
    title: 'Extraction',
    category: 'extraction',
    expects: 'json',
    prompt: 'Extract the model, engine, and port from this text as valid JSON only: The demo uses qwen2.5-coder on llama-server at port 8080.'
  },
  {
    id: 'app-classification',
    title: 'Classification',
    category: 'classification',
    expects: 'classification',
    prompt: 'Classify this message as one of: setup, benchmark, report. Message: We measured TTFT and output TPS from the phone. Return one label only.'
  },
  {
    id: 'long-context-smoke',
    title: 'Long-context smoke',
    category: 'long-context',
    prompt: `Read this repeated workshop note and answer with the exact final action. Workshop note: LLM Radar helps a facilitator test local AI endpoints, verify LAN reachability, measure TTFT, and share a report. The participant should not manually search for the IP unless the guided setup fails. LLM Radar helps a facilitator test local AI endpoints, verify LAN reachability, measure TTFT, and share a report. The participant should not manually search for the IP unless the guided setup fails. Final action: scan the QR from Start_Here.bat. What is the exact final action?`
  }
];
