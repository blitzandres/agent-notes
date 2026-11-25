/**
 * D1 storage, rate limiting, verification, and summary queries for standalone agent-notes.
 * Never stores raw IPs; ip_hash is used solely as a salted hourly rate-limit key and purged after 48h.
 */

export const AGENT_NOTE_MAX_CHARS = 500;
export const AGENT_NOTE_DEFAULT_PER_HOUR = 5;
export const AGENT_NOTE_DEFAULT_DAILY_CAP = 200;
export const EDGE_EVENT_CAPS = { tag: 5000, reuse: 5000, referral: 20000 };
export const REF_TAG_RE = /^ab[a-z2-7]{8}$/;

export const AI_REF_SOURCES = new Set([
  'chatgpt', 'perplexity', 'gemini', 'copilot', 'claude', 'you',
  'phind', 'poe', 'meta-ai', 'grok', 'deepseek', 'mistral', 'kimi', 'qwen',
]);

const AI_REF_HOST_MAP = [
  ['chatgpt.com', 'chatgpt'], ['chat.openai.com', 'chatgpt'], ['openai.com', 'chatgpt'],
  ['perplexity.ai', 'perplexity'],
  ['gemini.google.com', 'gemini'], ['bard.google.com', 'gemini'],
  ['copilot.microsoft.com', 'copilot'], ['copilot.cloud.microsoft', 'copilot'],
  ['claude.ai', 'claude'],
  ['you.com', 'you'],
  ['phind.com', 'phind'],
  ['poe.com', 'poe'],
  ['meta.ai', 'meta-ai'],
  ['grok.com', 'grok'], ['x.ai', 'grok'],
  ['deepseek.com', 'deepseek'],
  ['chat.mistral.ai', 'mistral'],
  ['kimi.moonshot.cn', 'kimi'], ['kimi.com', 'kimi'],
  ['chat.qwen.ai', 'qwen'],
];

const EXPECTED_ORG = {
  Googlebot: /google/i, 'Google-Extended': /google/i, GoogleOther: /google/i, 'Google-InspectionTool': /google/i,
  Bingbot: /microsoft/i,
  GPTBot: /microsoft|openai/i, 'OAI-SearchBot': /microsoft|openai/i, 'ChatGPT-User': /microsoft|openai/i,
  ClaudeBot: /anthropic|amazon|google/i, 'Claude-User': /anthropic|amazon|google/i, 'Claude-SearchBot': /anthropic|amazon|google/i,
  PerplexityBot: /perplexity|amazon|cloudflare/i,
  Applebot: /apple/i, 'Applebot-Extended': /apple/i,
  Amazonbot: /amazon/i,
  'Meta-ExternalAgent': /facebook|meta/i, FacebookBot: /facebook|meta/i,
};

export function utcDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function timingSafeEqualStr(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function aiSourceOfHost(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  for (const [d, s] of AI_REF_HOST_MAP) if (host === d || host.endsWith('.' + d)) return s;
  return null;
}

export const cleanStr = (v, n) =>
  v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) || null;

export const cleanPath = (v) => {
  let p = cleanStr(v, 300);
  if (!p) return null;
  p = p.split('?')[0].split('#')[0] || '/';
  return p[0] === '/' ? p : '/' + p;
};

export const cleanBot = (v) => {
  const b = cleanStr(v, 64);
  return b && /^[A-Za-z0-9 ._:+-]+$/.test(b) ? b : null;
};

export function botVerifiedByOrg(bot, org) {
  if (!bot || !EXPECTED_ORG[bot]) return null;
  return !org || !EXPECTED_ORG[bot].test(org) ? 0 : 1;
}

async function bumpEventDaily(env, day, kind) {
  const r = await env.DB.prepare(
    `INSERT INTO edge_event_daily (day, kind, n) VALUES (?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1 RETURNING n`
  ).bind(day, kind).first();
  return Number(r && r.n) || 1;
}

export async function saveAgentNote(env, o) {
  const note = String(o.note == null ? '' : o.note)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .trim();
  if (!note) return { status: 400, error: 'empty note' };
  if (note.length > AGENT_NOTE_MAX_CHARS) return { status: 413, error: 'note too long' };

  const now = Date.now();
  const ipHash = typeof o.ip_hash === 'string' && /^[0-9a-f]{16}$/.test(o.ip_hash) ? o.ip_hash : 'nohash';
  const perHour = Math.max(1, Number(env.AGENT_NOTE_PER_HOUR) || AGENT_NOTE_DEFAULT_PER_HOUR);
  const dailyCap = Math.max(1, Number(env.AGENT_NOTE_DAILY_CAP) || AGENT_NOTE_DEFAULT_DAILY_CAP);
  const hour = Math.floor(now / 3600000);

  const r = await env.DB.prepare(
    `INSERT INTO agent_note_rate (k, hour, n) VALUES (?, ?, 1) ON CONFLICT(k, hour) DO UPDATE SET n = n + 1 RETURNING n`
  ).bind(ipHash, hour).first();
  if ((Number(r && r.n) || 1) > perHour) return { status: 429, error: 'rate limited' };
  if ((await bumpEventDaily(env, utcDay(now), 'note')) > dailyCap) return { status: 429, error: 'daily cap' };

  const bot = cleanBot(o.bot);
  const asOrg = cleanStr(o.as_org, 120);
  let asn = o.asn == null ? null : Math.trunc(Number(o.asn));
  if (!Number.isFinite(asn) || asn < 0) asn = null;
  let refHost = null;
  try { refHost = o.referer ? new URL(String(o.referer)).hostname.slice(0, 120) : null; } catch {}

  await env.DB.prepare(
    `INSERT INTO agent_notes (ts, note, bot, bot_verified, ua, page, referer_host, asn, as_org, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    now, note, bot, botVerifiedByOrg(bot, asOrg), cleanStr(o.ua, 512),
    cleanPath(o.page), refHost, asn, asOrg, cleanStr(o.country, 8)
  ).run();

  return { status: 201, ok: true };
}

export async function saveEdgeEvent(env, o) {
  const now = Date.now();
  let ts = Number(o.ts);
  if (!Number.isFinite(ts) || ts < now - 86400000 || ts > now + 300000) ts = now;
  const type = String(o.type || '');
  if (!(type in EDGE_EVENT_CAPS)) return { status: 400, error: 'invalid type' };

  const DB = env.DB;
  if (type === 'tag') {
    const tag = String(o.tag || '');
    const bot = cleanBot(o.bot);
    if (!REF_TAG_RE.test(tag) || !bot) return { status: 400, error: 'invalid' };
    if ((await bumpEventDaily(env, utcDay(now), type)) > EDGE_EVENT_CAPS.tag) return { status: 204 };
    const kind = o.kind === 'agents_md' ? 'agents_md' : 'html';
    await DB.prepare(`INSERT OR IGNORE INTO edge_ref_tags (tag, ts, bot, kind, path) VALUES (?, ?, ?, ?, ?)`)
      .bind(tag, ts, bot, kind, cleanPath(o.path)).run();
    return { status: 204 };
  }

  if (type === 'reuse') {
    const tag = String(o.tag || '');
    if (!REF_TAG_RE.test(tag)) return { status: 400, error: 'invalid' };
    const issued = await DB.prepare(`SELECT bot, ts FROM edge_ref_tags WHERE tag = ?`).bind(tag).first();
    if (!issued) return { status: 204 };
    if ((await bumpEventDaily(env, utcDay(now), type)) > EDGE_EVENT_CAPS.reuse) return { status: 204 };
    const byBot = cleanBot(o.bot);
    const rh = cleanStr(o.referer_host, 120);
    await DB.prepare(
      `INSERT INTO edge_ref_reuse (ts, tag, issued_bot, issued_ts, by_bot, same_bot, path, referer_host, ai_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      ts, tag, issued.bot, issued.ts, byBot,
      byBot && byBot === issued.bot ? 1 : 0, cleanPath(o.path), rh, aiSourceOfHost(rh)
    ).run();
    return { status: 204 };
  }

  const source = String(o.source || '');
  if (!AI_REF_SOURCES.has(source)) return { status: 400, error: 'invalid' };
  const via = o.via === 'utm' ? 'utm' : 'referer';
  const path = cleanPath(o.path) || '/';
  if ((await bumpEventDaily(env, utcDay(now), type)) > EDGE_EVENT_CAPS.referral) return { status: 204 };
  await DB.prepare(
    `INSERT INTO ai_referrals (hour, source, path, via, n, last_ts) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(hour, source, path, via) DO UPDATE SET n = n + 1, last_ts = excluded.last_ts`
  ).bind(new Date(ts).toISOString().slice(0, 13), source, path, via, ts).run();
  return { status: 204 };
}

export async function buildAgentFeaturesSummary(env, since, until, { noteLimit = 20, noteChars = 500 } = {}) {
  const DB = env.DB;
  const safe = async (p, d) => {
    try { return await p; } catch (e) { console.error('agent-features query', String((e && e.message) || e)); return d; }
  };
  const all = async (sql, ...b) => safe(DB.prepare(sql).bind(...b).all().then((r) => r.results || []), []);
  const first = async (sql, ...b) => safe(DB.prepare(sql).bind(...b).first(), null);
  const hFrom = new Date(since).toISOString().slice(0, 13);
  const hTo = new Date(until).toISOString().slice(0, 13);

  const [noteCount, notesByBot, recentNotes, tagTot, tagByBot, reuseTot, reuseByIssued, recentReuse, refTot, refBySource, refByPage] =
    await Promise.all([
      first(`SELECT COUNT(*) AS c FROM agent_notes WHERE ts >= ? AND ts < ?`, since, until),
      all(`SELECT COALESCE(bot, '(no bot UA)') AS bot, COUNT(*) AS c, SUM(CASE WHEN bot_verified = 0 THEN 1 ELSE 0 END) AS unverified FROM agent_notes WHERE ts >= ? AND ts < ? GROUP BY 1 ORDER BY c DESC LIMIT 20`, since, until),
      noteLimit > 0 ? all(`SELECT ts, bot, bot_verified, page, note FROM agent_notes WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?`, since, until, noteLimit) : [],
      first(`SELECT COUNT(*) AS c, SUM(CASE WHEN kind = 'agents_md' THEN 1 ELSE 0 END) AS agents_md FROM edge_ref_tags WHERE ts >= ? AND ts < ?`, since, until),
      all(`SELECT bot, COUNT(*) AS c FROM edge_ref_tags WHERE ts >= ? AND ts < ? GROUP BY bot ORDER BY c DESC LIMIT 20`, since, until),
      first(`SELECT COUNT(*) AS c, COUNT(DISTINCT tag) AS tags, SUM(CASE WHEN by_bot IS NULL THEN 1 ELSE 0 END) AS no_bot_ua,
                    SUM(same_bot) AS same_bot, SUM(CASE WHEN by_bot IS NOT NULL AND same_bot = 0 THEN 1 ELSE 0 END) AS other_bot,
                    SUM(CASE WHEN ai_source IS NOT NULL THEN 1 ELSE 0 END) AS from_ai_referer
               FROM edge_ref_reuse WHERE ts >= ? AND ts < ?`, since, until),
      all(`SELECT issued_bot, COUNT(*) AS c, SUM(CASE WHEN same_bot = 0 THEN 1 ELSE 0 END) AS by_others FROM edge_ref_reuse WHERE ts >= ? AND ts < ? GROUP BY issued_bot ORDER BY c DESC LIMIT 20`, since, until),
      all(`SELECT ts, issued_bot, issued_ts, by_bot, same_bot, path, referer_host, ai_source FROM edge_ref_reuse WHERE ts >= ? AND ts < ? AND same_bot = 0 ORDER BY ts DESC LIMIT 20`, since, until),
      first(`SELECT SUM(n) AS c FROM ai_referrals WHERE hour >= ? AND hour <= ?`, hFrom, hTo),
      all(`SELECT source, SUM(n) AS c FROM ai_referrals WHERE hour >= ? AND hour <= ? GROUP BY source ORDER BY c DESC`, hFrom, hTo),
      all(`SELECT source, path, SUM(n) AS c FROM ai_referrals WHERE hour >= ? AND hour <= ? GROUP BY source, path ORDER BY c DESC LIMIT 30`, hFrom, hTo),
    ]);

  return {
    agent_notes: {
      count: Number(noteCount && noteCount.c) || 0,
      by_bot: notesByBot.map((r) => ({ bot: r.bot, notes: r.c, unverified: r.unverified || 0 })),
      recent: recentNotes.map((r) => ({
        ts: r.ts,
        bot: r.bot,
        bot_verified: r.bot_verified == null ? null : Number(r.bot_verified) === 1,
        page: r.page,
        note: String(r.note || '').slice(0, noteChars),
      })),
    },
    tracking_tags: {
      issued: Number(tagTot && tagTot.c) || 0,
      issued_agents_md: Number(tagTot && tagTot.agents_md) || 0,
      issued_by_bot: tagByBot.map((r) => ({ bot: r.bot, tags: r.c })),
      reuse: Number(reuseTot && reuseTot.c) || 0,
      reused_tags: Number(reuseTot && reuseTot.tags) || 0,
      reuse_same_bot: Number(reuseTot && reuseTot.same_bot) || 0,
      reuse_other_bot: Number(reuseTot && reuseTot.other_bot) || 0,
      reuse_no_bot_ua: Number(reuseTot && reuseTot.no_bot_ua) || 0,
      reuse_from_ai_referer: Number(reuseTot && reuseTot.from_ai_referer) || 0,
      reuse_by_issued_bot: reuseByIssued.map((r) => ({ bot: r.issued_bot, reuse: r.c, by_others: r.by_others || 0 })),
      recent_reuse: recentReuse.map((r) => ({
        ts: r.ts, issued_bot: r.issued_bot, issued_ts: r.issued_ts,
        by: r.by_bot || '(no bot UA)', path: r.path, referer_host: r.referer_host, ai_source: r.ai_source,
      })),
    },
    ai_referrals: {
      total: Number(refTot && refTot.c) || 0,
      by_source: refBySource.map((r) => ({ source: r.source, visits: r.c })),
      by_page: refByPage.map((r) => ({ source: r.source, path: r.path, visits: r.c })),
    },
  };
}

export async function runRetention(env, now = Date.now()) {
  if (!env || !env.DB) return;
  try {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM agent_note_rate WHERE hour < ?`).bind(Math.floor(now / 3600000) - 48),
      env.DB.prepare(`DELETE FROM agent_notes WHERE ts < ?`).bind(now - 365 * 86400000),
      env.DB.prepare(`DELETE FROM edge_ref_tags WHERE ts < ?`).bind(now - 90 * 86400000),
      env.DB.prepare(`DELETE FROM edge_ref_reuse WHERE ts < ?`).bind(now - 90 * 86400000),
      env.DB.prepare(`DELETE FROM ai_referrals WHERE hour < ?`).bind(new Date(now - 400 * 86400000).toISOString().slice(0, 13)),
      env.DB.prepare(`DELETE FROM edge_event_daily WHERE day < ?`).bind(utcDay(now - 120 * 86400000)),
    ]);
  } catch (err) {
    console.error('agent-notes retention failed', String((err && err.message) || err));
  }
}
