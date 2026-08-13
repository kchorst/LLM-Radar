import { PrivacyMatch, PrivacyScanResult, RiskLevel } from '../types/domain';

interface Rule {
  id: string;
  label: string;
  category: string;
  risk: RiskLevel;
  action: 'advise' | 'gate' | 'block' | '';
  redactionLabel: string;
  regex: string;
  flags: string;
  luhn?: boolean;
}

const RISK_RANK: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };

// Adapted from Sentinel+ default protection rules. No raw prompt persistence.
const RULES: Rule[] = [
  { id: 'email', label: 'Email Address', category: 'PII', risk: 'medium', action: 'advise', redactionLabel: '[EMAIL REDACTED]', regex: String.raw`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`, flags: 'g' },
  { id: 'phone_us', label: 'Phone Number', category: 'PII', risk: 'medium', action: 'advise', redactionLabel: '[PHONE REDACTED]', regex: String.raw`(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b`, flags: 'g' },
  { id: 'phone_international', label: 'Possible International Phone Number', category: 'PII', risk: 'medium', action: 'advise', redactionLabel: '[PHONE REDACTED]', regex: String.raw`(^|[^\w])\+[1-9]\d{0,2}(?:[\s().-]*\d){6,14}(?![\w])`, flags: 'g' },
  { id: 'iban', label: 'Possible IBAN Bank Account', category: 'Financial', risk: 'high', action: 'gate', redactionLabel: '[IBAN REDACTED]', regex: String.raw`\b[A-Z]{2}\d{2}[\s-]?(?:[A-Z0-9][\s-]?){11,30}\b`, flags: 'gi' },
  { id: 'swift_bic', label: 'Possible SWIFT/BIC Code', category: 'Financial', risk: 'medium', action: 'advise', redactionLabel: '[SWIFT/BIC REDACTED]', regex: String.raw`\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b`, flags: 'g' },
  { id: 'passport_labeled', label: 'Labeled Passport Number', category: 'PII', risk: 'high', action: 'gate', redactionLabel: '[PASSPORT REDACTED]', regex: String.raw`\b(?:passport(?:\s+(?:no\.?|number|#))?|travel\s+document(?:\s+(?:no\.?|number|#))?)\s*[:#-]?\s*[A-Z0-9]{6,12}\b`, flags: 'gi' },
  { id: 'tax_id_labeled', label: 'Labeled Tax/VAT/TIN Number', category: 'PII', risk: 'high', action: 'gate', redactionLabel: '[TAX ID REDACTED]', regex: String.raw`\b(?:VAT|TIN|tax\s+ID|tax\s+identification\s+number|national\s+tax\s+number)\s*[:#-]?\s*[A-Z0-9][A-Z0-9\s.-]{5,24}\b`, flags: 'gi' },
  { id: 'ip_address', label: 'IP Address', category: 'Network', risk: 'low', action: 'advise', redactionLabel: '[IP REDACTED]', regex: String.raw`\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b`, flags: 'g' },
  { id: 'ssn', label: 'Social Security Number', category: 'PII', risk: 'high', action: 'gate', redactionLabel: '[SSN REDACTED]', regex: String.raw`\b\d{3}[-.\s]*\d{2}[-.\s]*\d{4}\b`, flags: 'g' },
  { id: 'credit_card_like', label: 'Credit Card-like Number', category: 'Financial', risk: 'high', action: 'gate', redactionLabel: '[CARD REDACTED]', luhn: true, regex: String.raw`\b(?:\d[\s-]*){12,18}\d\b`, flags: 'g' },
  { id: 'api_key', label: 'API Key or Token', category: 'Credentials', risk: 'critical', action: 'gate', redactionLabel: '[API KEY REDACTED]', regex: String.raw`(?:sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|ey[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{10,}\.?[A-Za-z0-9_.+/=-]*)`, flags: 'g' },
  { id: 'password_assignment', label: 'Password or Secret', category: 'Credentials', risk: 'critical', action: 'gate', redactionLabel: '[SECRET REDACTED]', regex: String.raw`\b(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)\s*[:=]\s*\S+`, flags: 'gi' },
  { id: 'private_key_block', label: 'Private Key Block', category: 'Credentials', risk: 'critical', action: 'gate', redactionLabel: '[PRIVATE KEY REDACTED]', regex: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`, flags: 'g' }
];

export function scanPrompt(text: string): PrivacyScanResult {
  let redactedText = text;
  let highestRisk: RiskLevel = 'low';
  const matches: PrivacyMatch[] = [];

  for (const rule of RULES) {
    let re: RegExp;
    try { re = new RegExp(rule.regex, rule.flags.includes('g') ? rule.flags : `${rule.flags}g`); } catch { continue; }
    const found: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = normalizeValue(rule, m[0]);
      if (!raw) continue;
      if (rule.id === 'credit_card_like' && !luhn(raw.replace(/\D/g, ''))) continue;
      if (rule.id === 'iban' && !isLikelyIban(raw)) continue;
      if (rule.id === 'phone_international') {
        const digits = raw.replace(/\D/g, '');
        if (!raw.includes('+') || digits.length < 8 || digits.length > 15) continue;
      }
      found.push(m[0]);
      if (m.index === re.lastIndex) re.lastIndex++;
    }

    if (found.length) {
      const risk = rule.risk;
      if (RISK_RANK[risk] > RISK_RANK[highestRisk]) highestRisk = risk;
      for (const value of found) redactedText = redactedText.split(value).join(rule.redactionLabel);
      matches.push({ id: rule.id, label: rule.id === 'credit_card_like' ? 'Valid-looking Credit Card Number' : rule.label, category: rule.category, risk, action: rule.action, count: found.length });
    }
  }

  const decision = matches.length === 0 ? 'none' : RISK_RANK[highestRisk] >= RISK_RANK.high ? 'gate' : 'advise';
  return {
    decision,
    highestRisk,
    matches,
    redactedText,
    message: buildMessage(decision, highestRisk, matches)
  };
}

function buildMessage(decision: PrivacyScanResult['decision'], risk: RiskLevel, matches: PrivacyMatch[]): string {
  if (decision === 'none') return 'No sensitive patterns detected.';
  const names = [...new Set(matches.map(m => m.label))].slice(0, 3).join(', ');
  if (decision === 'advise') return `Privacy review noticed ${names}. Check before sending.`;
  return `Privacy review found ${risk} risk information: ${names}.`;
}

function normalizeValue(rule: Rule, value: string): string {
  if (['credit_card_like', 'phone_us', 'phone_international', 'ssn'].includes(rule.id)) return String(value || '').replace(/\D/g, '');
  if (['iban', 'swift_bic'].includes(rule.id)) return String(value || '').replace(/[\s-]/g, '').toUpperCase();
  return String(value || '').trim();
}

function luhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function isLikelyIban(value: string): boolean {
  const compact = String(value || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const part = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of part) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
