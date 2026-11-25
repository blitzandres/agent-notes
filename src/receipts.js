/**
 * Signed submission receipts, lightweight zero-LLM PII/spam risk scoring,
 * and multi-error validation helpers (inspired by agent-lounge & agentfeedback).
 */

export function newReceiptId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = 'rcpt_';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export async function signReceipt(payload, secret) {
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const canonical = JSON.stringify({
    receipt_id: payload.receipt_id,
    ts: payload.ts,
    stored_chars: payload.stored_chars,
    bot: payload.bot || null,
    auth_method: payload.auth_method || 'none',
  });
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += sig[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Heuristic zero-LLM risk scoring for stored notes (0..100).
 * Flags accidental PII/secrets or link spam so owners can triage safely without dropping borderline notes.
 */
export function scoreNoteRisk(note) {
  const text = String(note || '');
  const flags = [];
  let score = 0;

  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) {
    flags.push('email_like');
    score += 35;
  }
  if (/(?:\+?\d[\d\s().-]{7,}\d)/.test(text)) {
    flags.push('phone_like');
    score += 30;
  }
  if (/\b(?:sk-[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/.test(text)) {
    flags.push('secret_like');
    score += 50;
  }
  const urls = text.match(/https?:\/\/\S+/gi) || [];
  if (urls.length >= 2) {
    flags.push('url_burst');
    score += 30;
  }
  if (/ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt/i.test(text)) {
    flags.push('prompt_injection_like');
    score += 25;
  }

  return { spam_score: Math.min(100, score), flags };
}

/**
 * Validate note fields and return ALL validation problems at once with a plain-language hint,
 * so automated callers can fix issues in one retry instead of failing field-by-field.
 */
export function validateNoteInput({ note, maxChars = 500, fields }) {
  const errors = [];
  if (fields && Object.values(fields).some((v) => v === undefined)) {
    errors.push({ field: 'agent|purpose|note', code: 'invalid_type', message: 'agent, purpose, and note must be strings when provided' });
  }
  if (!note) {
    errors.push({ field: 'note', code: 'empty', message: 'At least one of agent, purpose, or note must be non-empty' });
  } else if (note.length > maxChars) {
    errors.push({
      field: 'note',
      code: 'too_long',
      message: `Combined note length is ${note.length} chars (max ${maxChars})`,
    });
  }
  if (!errors.length) return null;
  return {
    error: errors[0].code === 'too_long' ? 'note too long' : errors[0].message,
    errors,
    hint: `Send GET /agent-note?agent=...&purpose=...&page=/... or POST JSON {"agent":"...","purpose":"...","page":"/..."} within ${maxChars} characters and without personal data.`,
    max_chars: maxChars,
  };
}
