/**
 * Lightweight Web Bot Auth (RFC 9421 HTTP Message Signatures + Signature-Agent directory) verifier.
 * Reference: https://github.com/cloudflare/web-bot-auth
 *
 * Fail-open: never blocks requests; returns verification status so notes/logs can record
 * auth_method ('web-bot-auth' when verified, 'none' otherwise) without affecting normal traffic.
 */

const KEY_CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;
const MAX_SKEW_SEC = 60;

function b64UrlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7638 JWK Thumbprint for OKP Ed25519 keys. */
export async function jwkThumbprintEd25519(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) return null;
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  return bytesToB64Url(digest);
}

function isSafeHttpsUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(h)) return false;
    if (h.startsWith('[') && (/^\[(::1|fc|fd|fe80)/i.test(h))) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse RFC 8941 dictionary member for `Signature-Input`:
 * e.g. `sig1=("@authority" "signature-agent");created=1735689600;expires=1735689900;keyid="...";tag="web-bot-auth"`
 */
export function parseSignatureInput(headerVal) {
  if (!headerVal || typeof headerVal !== 'string') return null;
  const m = headerVal.match(/^\s*([a-zA-Z0-9_-]+)=\(([^)]*)\)((?:;[^\s,;]+(?:=(?:"[^"]*"|[^\s,;]+))?)*)/);
  if (!m) return null;
  const label = m[1];
  const rawParams = `(${m[2]})${m[3]}`;
  const components = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  const params = {};
  for (const pm of m[3].matchAll(/;([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|([^\s,;]+)))?/g)) {
    const k = pm[1];
    const v = pm[2] !== undefined ? pm[2] : pm[3] !== undefined ? (/^\d+$/.test(pm[3]) ? Number(pm[3]) : pm[3]) : true;
    params[k] = v;
  }
  return { label, components, params, rawParams };
}

export function parseSignatureHeader(headerVal, label) {
  if (!headerVal || typeof headerVal !== 'string') return null;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = headerVal.match(new RegExp(`(?:^|,)\\s*${escaped}=:([A-Za-z0-9+/=_-]+):`));
  if (!m) return null;
  try {
    return b64ToBytes(m[1].replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
}

export function parseSignatureAgent(headerVal) {
  if (!headerVal || typeof headerVal !== 'string') return null;
  // Accepts either `sig1="https://..."` (with optional ;type=cimd) or bare `"https://..."` / `https://...`
  const m = headerVal.match(/(?:[a-zA-Z0-9_-]+=)?"(https:\/\/[^"]+)"/) || headerVal.match(/(https:\/\/[^\s;,]+)/);
  if (!m) return null;
  const url = m[1];
  return isSafeHttpsUrl(url) ? url : null;
}

export function buildSignatureBase(request, components, rawParams) {
  const url = new URL(request.url);
  const lines = [];
  for (const comp of components) {
    let val;
    if (comp === '@authority') val = url.host;
    else if (comp === '@method') val = request.method.toUpperCase();
    else if (comp === '@path') val = url.pathname;
    else if (comp === '@target-uri') val = url.toString();
    else if (comp === '@scheme') val = url.protocol.replace(/:$/, '');
    else if (comp === '@query') val = url.search || '?';
    else if (comp.startsWith('@')) return null; // unsupported derived component
    else {
      val = request.headers.get(comp);
      if (val == null) return null;
      val = val.replace(/\s+/g, ' ').trim();
    }
    lines.push(`"${comp}": ${val}`);
  }
  lines.push(`"@signature-params": ${rawParams}`);
  return lines.join('\n');
}

async function fetchKeyDirectory(agentUrl, fetcher = fetch) {
  const now = Date.now();
  const cached = KEY_CACHE.get(agentUrl);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.keys;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetcher(agentUrl, {
      headers: { accept: 'application/http-message-signatures-directory+json, application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 65536) return null;
    const doc = JSON.parse(text);
    let keys = Array.isArray(doc && doc.keys) ? doc.keys : null;

    // Signature Agent Card (CIMD) points to `jwks_uri`
    if (!keys && doc && typeof doc.jwks_uri === 'string' && isSafeHttpsUrl(doc.jwks_uri)) {
      const res2 = await fetcher(doc.jwks_uri, {
        headers: { accept: 'application/http-message-signatures-directory+json, application/json' },
        signal: ctrl.signal,
      });
      if (res2.ok) {
        const text2 = await res2.text();
        if (text2.length <= 65536) {
          const doc2 = JSON.parse(text2);
          if (Array.isArray(doc2 && doc2.keys)) keys = doc2.keys;
        }
      }
    }

    // Fallback: origin/.well-known/http-message-signatures-directory
    if (!keys) {
      const u = new URL(agentUrl);
      if (u.pathname !== '/.well-known/http-message-signatures-directory') {
        const dirUrl = `${u.origin}/.well-known/http-message-signatures-directory`;
        if (isSafeHttpsUrl(dirUrl)) {
          const res3 = await fetcher(dirUrl, {
            headers: { accept: 'application/http-message-signatures-directory+json, application/json' },
            signal: ctrl.signal,
          });
          if (res3.ok) {
            const text3 = await res3.text();
            if (text3.length <= 65536) {
              const doc3 = JSON.parse(text3);
              if (Array.isArray(doc3 && doc3.keys)) keys = doc3.keys;
            }
          }
        }
      }
    }

    if (!keys) return null;
    if (KEY_CACHE.size >= MAX_CACHE_ENTRIES) {
      const firstKey = KEY_CACHE.keys().next().value;
      if (firstKey) KEY_CACHE.delete(firstKey);
    }
    KEY_CACHE.set(agentUrl, { ts: now, keys });
    return keys;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findMatchingJwk(keys, keyid) {
  for (const jwk of keys) {
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) continue;
    if (jwk.kid && jwk.kid === keyid) return jwk;
    const thumb = await jwkThumbprintEd25519(jwk);
    if (thumb && thumb === keyid) return jwk;
  }
  return null;
}

/**
 * Verify an incoming request's RFC 9421 Web Bot Auth signature.
 * Accepts optional `{ fetcher, nowSec, staticKeys }` for deterministic offline unit tests.
 */
export async function verifyWebBotAuth(request, opts = {}) {
  try {
    const sigInputRaw = request.headers.get('signature-input');
    const sigRaw = request.headers.get('signature');
    const agentRaw = request.headers.get('signature-agent');
    if (!sigInputRaw || !sigRaw) return { verified: false, reason: 'unsigned' };

    const parsed = parseSignatureInput(sigInputRaw);
    if (!parsed) return { verified: false, reason: 'invalid_signature_input' };
    if (parsed.params.tag !== 'web-bot-auth') return { verified: false, reason: 'wrong_tag' };
    if (!parsed.components.includes('@authority')) return { verified: false, reason: 'missing_authority' };

    const keyid = String(parsed.params.keyid || '');
    if (!keyid) return { verified: false, reason: 'missing_keyid' };

    const nowSec = typeof opts.nowSec === 'number' ? opts.nowSec : Math.floor(Date.now() / 1000);
    const created = Number(parsed.params.created);
    const expires = Number(parsed.params.expires);
    if (!Number.isFinite(created) || !Number.isFinite(expires)) return { verified: false, reason: 'missing_timestamps' };
    if (created > nowSec + MAX_SKEW_SEC || expires < nowSec - MAX_SKEW_SEC || expires <= created) {
      return { verified: false, reason: 'expired_or_future' };
    }

    const sigBytes = parseSignatureHeader(sigRaw, parsed.label);
    if (!sigBytes || sigBytes.length !== 64) return { verified: false, reason: 'invalid_signature_bytes' };

    const base = buildSignatureBase(request, parsed.components, parsed.rawParams);
    if (!base) return { verified: false, reason: 'unresolvable_components' };

    const agentUrl = parseSignatureAgent(agentRaw);
    let keys = opts.staticKeys || null;
    if (!keys && agentUrl) {
      keys = await fetchKeyDirectory(agentUrl, opts.fetcher || fetch);
    }
    if (!keys) return { verified: false, reason: 'missing_key_directory', signature_agent: agentUrl, keyid };

    const jwk = await findMatchingJwk(keys, keyid);
    if (!jwk) return { verified: false, reason: 'unknown_keyid', signature_agent: agentUrl, keyid };

    const pubKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const ok = await crypto.subtle.verify('Ed25519', pubKey, sigBytes, new TextEncoder().encode(base));
    return ok
      ? { verified: true, auth_method: 'web-bot-auth', signature_agent: agentUrl || 'static', keyid }
      : { verified: false, reason: 'bad_signature', signature_agent: agentUrl, keyid };
  } catch {
    return { verified: false, reason: 'error' };
  }
}

export function clearWebBotAuthCache() {
  KEY_CACHE.clear();
}
