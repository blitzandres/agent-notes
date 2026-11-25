/**
 * Core edge agent features (fail-open; humans and search crawlers always get the origin response untouched).
 *
 * 1) /agent-note        — GET: plain-text explainer; GET ?agent=...&purpose=... or POST: short note (<=500 chars).
 *                          Always X-Robots-Tag: noindex, nofollow. Stores directly in D1 (env.DB) or forwards to ANALYTICS_URL.
 * 2) Tracking links     — Only for AI-only crawlers (GPTBot, ClaudeBot, CCBot, PerplexityBot, ...): internal links in HTML
 *                          and /AGENTS.md get ?ref=<tag>. Search crawlers (Googlebot, Bingbot, Applebot, ...) and
 *                          humans are never tagged. Later requests carrying a known tag log a reuse event.
 * 3) AI referrals       — Human (non-bot) HTML page views whose Referer host or utm_source is an AI assistant are
 *                          logged as (source, landing path, via) aggregates. Read-only: response untouched.
 */

import { saveAgentNote, saveEdgeEvent, REF_TAG_RE, aiSourceOfHost } from './storage.js';

export { REF_TAG_RE as REF_RE };
export const NOTE_PATHS = new Set(['/agent-note', '/agent-note/']);
export const NOTE_MAX_CHARS = 500;
export const NOTE_MAX_BYTES = 2048;

// AI-only crawlers / agents that may receive ?ref= tagged internal links.
export const AI_TAG_RE = /gptbot|chatgpt-user|oai-searchbot|claudebot|claude-user|claude-searchbot|anthropic-ai|perplexitybot|perplexity-user|ccbot|bytespider|amazonbot|meta-externalagent|meta-externalfetcher|cohere-ai|cohere-training-data-crawler|diffbot|mistralai-user|youbot|ai2bot|timpibot|duckassistbot|imagesiftbot|omgili/i;

// Never tagged (and never store GET /agent-note?agent= crawls), even if UA also contains an AI token.
export const NEVER_TAG_RE = /googlebot|google-|googleother|adsbot|mediapartners|bingbot|bingpreview|msnbot|adidxbot|applebot|petalbot|duckduckbot|yandex|baiduspider|slurp|seznambot|naver|yeti|sogou|qwantify|qwantbot|mojeek|ecosia|exabot|facebookexternalhit|twitterbot|slackbot|linkedinbot|discordbot|whatsapp|telegrambot|embedly|skypeuripreview|iframely|redditbot|pinterest|semrush|ahrefs|dataforseo|mj12bot/i;

const UTM_ALIASES = {
  chatgpt: 'chatgpt', openai: 'chatgpt', perplexity: 'perplexity', gemini: 'gemini', bard: 'gemini', copilot: 'copilot',
  claude: 'claude', you: 'you', phind: 'phind', poe: 'poe', 'meta.ai': 'meta-ai', metaai: 'meta-ai', grok: 'grok',
  deepseek: 'deepseek', mistral: 'mistral', lechat: 'mistral', kimi: 'kimi', qwen: 'qwen',
};

export function siteOrigin(env) {
  return String((env && env.SITE_ORIGIN) || 'https://example.com').replace(/\/$/, '');
}

export function siteHost(env) {
  try { return new URL(siteOrigin(env)).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return 'example.com'; }
}

export function isSiteHost(hostname, env) {
  const h = String(hostname || '').toLowerCase();
  const base = siteHost(env);
  return h === base || h === 'www.' + base;
}

export function aiSourceFromHost(host) {
  return aiSourceOfHost(host);
}

export function aiSourceFromUtm(v) {
  v = String(v || '').toLowerCase().trim().slice(0, 80);
  if (!v) return null;
  const h = aiSourceOfHost(v.replace(/^https?:\/\//, '').split('/')[0]);
  if (h) return h;
  return UTM_ALIASES[v] || null;
}

/** Returns { source, via } for an AI-assistant referral, or null. Pure read of the request. */
export function detectAiReferral(request) {
  const url = new URL(request.url);
  const ref = request.headers.get('referer') || '';
  if (ref) {
    let host = '';
    try { host = new URL(ref).hostname; } catch {}
    const s = aiSourceFromHost(host);
    if (s) return { source: s, via: 'referer' };
  }
  const s2 = aiSourceFromUtm(url.searchParams.get('utm_source'));
  if (s2) return { source: s2, via: 'utm' };
  return null;
}

export function isAiTagUa(ua) {
  ua = String(ua || '');
  return !!ua && AI_TAG_RE.test(ua) && !NEVER_TAG_RE.test(ua);
}

export function isSearchOrPreviewUa(ua) {
  return NEVER_TAG_RE.test(String(ua || ''));
}

export function newTag() {
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = 'ab';
  for (const x of b) s += A[x & 31];
  return s;
}

/** Is an href internal to the configured site (relative, root-relative, or absolute on SITE_ORIGIN)? */
export function isInternalHref(href, env) {
  href = String(href || '').trim();
  if (!href || href[0] === '#' || href.startsWith('?')) return false;
  if (/^\/\//.test(href)) {
    try { return isSiteHost(new URL('https:' + href).hostname, env); } catch { return false; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    if (!/^https?:/i.test(href)) return false;
    try { return isSiteHost(new URL(href).hostname, env); } catch { return false; }
  }
  return true;
}

export function addRef(href, tag) {
  const i = href.indexOf('#');
  const base = i >= 0 ? href.slice(0, i) : href;
  const frag = i >= 0 ? href.slice(i) : '';
  if (/[?&]ref=/.test(base)) return href;
  return base + (base.includes('?') ? '&' : '?') + 'ref=' + tag + frag;
}

/** Tag site links inside Markdown/plain text (AGENTS.md). */
export function tagMarkdown(text, tag, env) {
  const host = siteHost(env).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const urlRe = new RegExp(`https?:\\/\\/(?:www\\.)?${host}(?:\\/[^\\s)\\]>"'\`<]*)?`, 'gi');
  let out = text.replace(urlRe, (m) => {
    const t = m.match(/[.,;:!?]+$/);
    const core = t ? m.slice(0, -t[0].length) : m;
    return addRef(core, tag) + (t ? t[0] : '');
  });
  out = out.replace(/\]\((\/[^)\s]*)\)/g, (_m, p) => '](' + addRef(p, tag) + ')');
  return out;
}

function taggedHeaders(res, request, env) {
  const h = new Headers(res.headers);
  for (const k of ['content-length', 'content-encoding', 'etag', 'last-modified']) h.delete(k);
  h.set('cache-control', 'private, no-store');
  h.set('vary', 'User-Agent');
  const u = new URL(request.url);
  h.set('link', `<${siteOrigin(env)}${u.pathname}>; rel="canonical"`);
  return h;
}

/**
 * For AI-only crawlers: returns { response, tag, kind } with tagged internal links, or null (= serve original).
 * Never throws; never called for search crawlers or humans.
 */
export async function tagForAiBot(request, res, ua, env) {
  try {
    if (String(env && env.TAG_LINKS_ENABLED).toLowerCase() !== 'true') return null;
    if (request.method.toUpperCase() !== 'GET' || res.status !== 200 || !isAiTagUa(ua)) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const path = new URL(request.url).pathname;
    const tag = newTag();
    if (path === '/AGENTS.md' && /text\/(markdown|plain|x-markdown)/.test(ct)) {
      const len = Number(res.headers.get('content-length') || 0);
      if (len > 1048576) return null;
      const text = await res.clone().text();
      if (text.length > 1048576) return null;
      return {
        response: new Response(tagMarkdown(text, tag, env), {
          status: res.status, statusText: res.statusText, headers: taggedHeaders(res, request, env),
        }),
        tag,
        kind: 'agents_md',
      };
    }
    if (ct.includes('text/html') && typeof HTMLRewriter === 'function') {
      const rw = new HTMLRewriter().on('a[href]', {
        element(el) {
          try {
            const href = el.getAttribute('href');
            if (isInternalHref(href, env)) el.setAttribute('href', addRef(href, tag));
          } catch {}
        },
      });
      const t = rw.transform(res);
      return {
        response: new Response(t.body, {
          status: res.status, statusText: res.statusText, headers: taggedHeaders(res, request, env),
        }),
        tag,
        kind: 'html',
      };
    }
    return null;
  } catch (err) {
    console.error('edge: tagging failed, serving original', String((err && err.message) || err));
    return null;
  }
}

/* ───── /agent-note ───── */
const NOTE_BASE_HEADERS = {
  'x-robots-tag': 'noindex, nofollow',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function noteResp(body, status, extra = {}) {
  const isJson = typeof body !== 'string';
  return new Response(body == null ? null : isJson ? JSON.stringify(body) : body, {
    status,
    headers: {
      ...NOTE_BASE_HEADERS,
      'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

export function buildNoteHelp(env) {
  const origin = siteOrigin(env);
  const host = siteHost(env);
  return [
    `${host} — agent note`,
    '',
    'If you are an AI agent acting for a person, you may tell us who you are helping and why.',
    'This is optional. Please do not include personal data, secrets, or contact details.',
    '',
    'Fields (all optional, at least one needed): agent (who you are / who you help), purpose (why), note (free text), page (path you were reading).',
    '',
    `GET  ${origin}/agent-note?agent=...&purpose=...&page=/docs/`,
    `POST ${origin}/agent-note`,
    '  Content-Type: application/json   body: {"agent": "...", "purpose": "...", "page": "/..."}  (or {"note": "...", "page": "/..."})',
    '  Content-Type: application/x-www-form-urlencoded   agent=...&purpose=...&note=...&page=...',
    '  Content-Type: text/plain         body: your note',
    '',
    'Limits: 500 characters for agent + purpose + note combined, 2 KB per request, a few notes per hour per client.',
    'Responses: 201 saved · 400 empty/invalid · 413 too long · 429 slow down · 503 try later.',
    'Notes are read privately by the site owner; they are not published.',
    '',
  ].join('\n');
}

async function readCapped(request, max) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch {} return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

export function cleanNote(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .trim();
}

export function composeNote({ agent, purpose, note } = {}) {
  const a = cleanNote(agent).replace(/\n+/g, ' ');
  const p = cleanNote(purpose).replace(/\n+/g, ' ');
  const n = cleanNote(note);
  if (!a && !p) return n;
  return [a && 'agent: ' + a, p && 'purpose: ' + p, n && 'note: ' + n].filter(Boolean).join(' | ');
}

const strOrNull = (v) => (typeof v === 'string' ? v : v == null ? null : undefined);

export async function handleAgentNote(request, env, bot, buildPayload) {
  const m = request.method.toUpperCase();
  const url = new URL(request.url);
  const q = url.searchParams;
  const hasQueryFields = ['agent', 'purpose', 'note'].some((k) => (q.get(k) || '').trim() !== '');
  const ua = request.headers.get('user-agent') || '';
  if (m === 'OPTIONS') return noteResp(null, 204);
  if (m === 'HEAD') return noteResp(null, 200, { 'cache-control': hasQueryFields ? 'no-store' : 'public, max-age=300' });
  if (m === 'GET' && (!hasQueryFields || isSearchOrPreviewUa(ua))) {
    return noteResp(buildNoteHelp(env), 200, { 'cache-control': hasQueryFields || url.search ? 'no-store' : 'public, max-age=300' });
  }
  if (m !== 'GET' && m !== 'POST') return noteResp({ error: 'method not allowed' }, 405, { allow: 'GET, POST, OPTIONS' });

  const asText = m === 'GET';
  const fail = (status, error) => (asText ? noteResp(error + '\n', status) : noteResp({ error }, status));
  let fields = { agent: q.get('agent'), purpose: q.get('purpose'), note: q.get('note') };
  let page = q.get('page');

  if (m === 'POST') {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > NOTE_MAX_BYTES) return noteResp({ error: 'too large', max_bytes: NOTE_MAX_BYTES }, 413);
    const raw = await readCapped(request, NOTE_MAX_BYTES);
    if (raw == null) return noteResp({ error: 'too large', max_bytes: NOTE_MAX_BYTES }, 413);
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      let o;
      try { o = JSON.parse(raw); } catch { return noteResp({ error: 'bad json' }, 400); }
      if (!o || typeof o !== 'object' || Array.isArray(o)) return noteResp({ error: 'expected {"agent","purpose","note","page"}' }, 400);
      const f = { agent: strOrNull(o.agent), purpose: strOrNull(o.purpose), note: strOrNull(o.note) };
      if (Object.values(f).some((v) => v === undefined)) return noteResp({ error: 'agent, purpose and note must be strings' }, 400);
      fields = { agent: f.agent ?? fields.agent, purpose: f.purpose ?? fields.purpose, note: f.note ?? fields.note };
      if (typeof o.page === 'string') page = o.page;
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      const p = new URLSearchParams(raw);
      fields = { agent: p.get('agent') ?? fields.agent, purpose: p.get('purpose') ?? fields.purpose, note: p.get('note') ?? fields.note };
      if (p.get('page')) page = p.get('page');
    } else if (raw.trim()) {
      fields = { ...fields, note: raw };
    }
  }

  const note = composeNote(fields);
  if (!note) return fail(400, 'empty note');
  if (note.length > NOTE_MAX_CHARS) {
    return asText
      ? noteResp(`note too long (max ${NOTE_MAX_CHARS} characters)\n`, 413)
      : noteResp({ error: 'note too long', max_chars: NOTE_MAX_CHARS }, 413);
  }
  if (!page) {
    try {
      const r = new URL(request.headers.get('referer') || '');
      if (isSiteHost(r.hostname, env)) page = r.pathname;
    } catch {}
  }
  if (page) page = String(page).split('?')[0].split('#')[0].slice(0, 300);

  const base = await buildPayload(request, env, bot || null, 0, false);
  const record = { ...base, path: '/agent-note', note, page: page || null };

  // Mode 1: standalone local D1 database
  if (env && env.DB) {
    try {
      const r = await saveAgentNote(env, record);
      if (r.status === 201) return asText ? noteResp('Thanks, your note was received.\n', 201) : noteResp({ ok: true, message: 'Thanks, your note was received.' }, 201);
      if (r.status === 429) return asText ? noteResp('rate limited, try again later\n', 429, { 'retry-after': '3600' }) : noteResp({ error: 'rate limited, try again later' }, 429, { 'retry-after': '3600' });
      if (r.status === 400 || r.status === 413) return fail(r.status, r.error || 'invalid note');
      return fail(503, 'unavailable');
    } catch (err) {
      console.error('agent-note D1 write failed', String((err && err.message) || err));
      return fail(503, 'unavailable');
    }
  }

  // Mode 2: forward to a separate analytics Worker
  if (!env || !env.EDGE_TOKEN || !env.ANALYTICS_URL) return fail(503, 'unavailable');
  try {
    const r = await fetch(String(env.ANALYTICS_URL).replace(/\/$/, '') + '/api/agent-note', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-token': env.EDGE_TOKEN },
      body: JSON.stringify(record),
    });
    if (r.status === 201) return asText ? noteResp('Thanks, your note was received.\n', 201) : noteResp({ ok: true, message: 'Thanks, your note was received.' }, 201);
    if (r.status === 429) return asText ? noteResp('rate limited, try again later\n', 429, { 'retry-after': '3600' }) : noteResp({ error: 'rate limited, try again later' }, 429, { 'retry-after': '3600' });
    if (r.status === 400 || r.status === 413) return fail(r.status, 'invalid note');
    return fail(503, 'unavailable');
  } catch (err) {
    console.error('agent-note forward failed', String((err && err.message) || err));
    return fail(503, 'unavailable');
  }
}

/** Fire-and-forget event persistence (tag issued / tag reused / AI referral). Never throws. */
export async function sendEvent(env, payload) {
  try {
    if (env && env.DB) {
      await saveEdgeEvent(env, payload);
      return;
    }
    if (!env || !env.EDGE_TOKEN || !env.ANALYTICS_URL) return;
    await fetch(String(env.ANALYTICS_URL).replace(/\/$/, '') + '/api/edge-event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-token': env.EDGE_TOKEN },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('edge-event failed', String((err && err.message) || err));
  }
}
