/**
 * agent-notes — pass-through Cloudflare Worker for AI agent interaction, verification, discovery, and private notes.
 *
 * - Every normal page request defaults to fetch(request), unchanged (fail-open).
 * - Search crawlers (Googlebot, Bingbot, Applebot, ...) and human browsers receive byte-identical origin responses.
 * - /agent-note accepts short notes with optional RFC 9421 Web Bot Auth verification and signed receipts.
 * - /.well-known/agent-card.json (A2A) and POST /mcp provide standardized agent discovery & tool access.
 */

import {
  NOTE_PATHS, REF_RE, handleAgentNote, tagForAiBot, detectAiReferral, sendEvent, siteOrigin,
} from './agent-features.js';
import { BOTS, REDIRECT_RE, NEVER_REDIRECT_RE, classifyBot, getBotMeta } from './bots.js';
import { buildAgentFeaturesSummary, buildNotesDigest, runRetention, timingSafeEqualStr } from './storage.js';
import { handleAgentCard, handleMcpRequest } from './discovery.js';

export * from './agent-features.js';
export { BOTS, classifyBot, getBotMeta };

export function shouldRedirect(request, ua, env) {
  if (String(env && env.REDIRECT_ENABLED).toLowerCase() !== 'true') return false;
  const m = request.method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  const url = new URL(request.url);
  if (url.pathname !== '/') return false;
  if (!ua || NEVER_REDIRECT_RE.test(ua)) return false;
  return REDIRECT_RE.test(ua);
}

export async function ipHash(ip, salt) {
  if (!ip || !salt) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip)));
  let hex = '';
  for (let i = 0; i < 8; i++) hex += sig[i].toString(16).padStart(2, '0');
  return hex;
}

export async function buildPayload(request, env, bot, status, redirected) {
  const url = new URL(request.url);
  const cf = request.cf || {};
  const ua = request.headers.get('user-agent') || '';
  const ip = request.headers.get('cf-connecting-ip') || '';
  return {
    ts: Date.now(),
    bot,
    ua: ua.slice(0, 512),
    path: url.pathname.slice(0, 500),
    method: request.method.toUpperCase().slice(0, 10),
    status: Number(status) || 0,
    redirected: redirected ? 1 : 0,
    asn: cf.asn != null ? Number(cf.asn) || null : null,
    as_org: cf.asOrganization ? String(cf.asOrganization).slice(0, 120) : null,
    country: cf.country ? String(cf.country).slice(0, 8) : null,
    referer: (request.headers.get('referer') || '').slice(0, 300) || null,
    ip_hash: await ipHash(ip, env && env.IP_SALT),
  };
}

export async function sendHit(request, env, bot, status, redirected) {
  try {
    if (!env || !env.EDGE_TOKEN || !env.ANALYTICS_URL) return;
    const body = JSON.stringify(await buildPayload(request, env, bot, status, redirected));
    await fetch(String(env.ANALYTICS_URL).replace(/\/$/, '') + '/api/edge-hit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-token': env.EDGE_TOKEN },
      body,
    });
  } catch (err) {
    console.error('edge-hit failed', String((err && err.message) || err));
  }
}

export function originRequest(request, env) {
  const url = new URL(request.url);
  if (!url.hostname.endsWith('.workers.dev')) return request;
  return new Request(siteOrigin(env) + url.pathname + url.search, request);
}

export function sideEvents(request, res, bot) {
  const out = [];
  const url = new URL(request.url);
  const ref = url.searchParams.get('ref');
  if (ref && REF_RE.test(ref)) {
    let rh = null;
    try { rh = new URL(request.headers.get('referer') || '').hostname.slice(0, 120) || null; } catch {}
    out.push({ type: 'reuse', ts: Date.now(), tag: ref, bot: bot || null, path: url.pathname.slice(0, 300), referer_host: rh });
  }
  if (!bot && request.method.toUpperCase() === 'GET' && res && res.status >= 200 && res.status < 400 &&
      (res.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
    const r = detectAiReferral(request);
    if (r) out.push({ type: 'referral', ts: Date.now(), source: r.source, via: r.via, path: url.pathname.slice(0, 300) });
  }
  return out;
}

async function isReadAuthorized(request, env) {
  const auth = request.headers.get('authorization') || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return !!(env && env.READ_TOKEN && tok && (await timingSafeEqualStr(tok, env.READ_TOKEN)));
}

async function handleSummaryApi(request, env) {
  if (!(await isReadAuthorized(request, env))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' },
    });
  }
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 database (DB) not bound' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' },
    });
  }
  const url = new URL(request.url);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const now = Date.now();
  const summary = await buildAgentFeaturesSummary(env, now - days * 86400000, now + 1);
  return new Response(JSON.stringify({ days, ...summary }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

async function handleDigestApi(request, env) {
  if (!(await isReadAuthorized(request, env))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' },
    });
  }
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 database (DB) not bound' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' },
    });
  }
  const url = new URL(request.url);
  const hours = url.searchParams.get('hours')
    ? Math.min(720, Math.max(1, Number(url.searchParams.get('hours')) || 24))
    : Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 1)) * 24;
  const now = Date.now();
  const digest = await buildNotesDigest(env, now - hours * 3600000, now + 1);
  if (url.searchParams.get('format') === 'markdown') {
    return new Response(digest.markdown, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
    });
  }
  return new Response(JSON.stringify({ hours, ...digest }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

export default {
  async fetch(request, env, ctx) {
    let bot = null, redirect = false, ua = '', pathname = '';
    try {
      ua = request.headers.get('user-agent') || '';
      bot = classifyBot(ua);
      redirect = !!bot && shouldRedirect(request, ua, env);
      pathname = new URL(request.url).pathname;
    } catch (err) {
      console.error('edge: classify failed, passing through', String((err && err.message) || err));
      bot = null; redirect = false; pathname = '';
    }

    if (pathname === '/api/agent-notes/summary' && request.method.toUpperCase() === 'GET') {
      return await handleSummaryApi(request, env);
    }
    if (pathname === '/api/agent-notes/digest' && request.method.toUpperCase() === 'GET') {
      return await handleDigestApi(request, env);
    }
    if (pathname === '/.well-known/agent-card.json') {
      return handleAgentCard(request, env);
    }
    if (pathname === '/mcp' || pathname === '/mcp/') {
      return await handleMcpRequest(request, env, bot, buildPayload);
    }

    if (NOTE_PATHS.has(pathname)) {
      try { return await handleAgentNote(request, env, bot, buildPayload); }
      catch (err) {
        console.error('agent-note failed', String((err && err.message) || err));
        return new Response('{"error":"unavailable"}', {
          status: 503,
          headers: { 'content-type': 'application/json', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' },
        });
      }
    }

    if (redirect) {
      try { ctx.waitUntil(sendHit(request, env, bot, 302, true)); } catch {}
      return new Response(null, {
        status: 302,
        headers: { location: siteOrigin(env) + '/AGENTS.md', 'cache-control': 'no-store', vary: 'User-Agent' },
      });
    }

    let target = request;
    try { target = originRequest(request, env); } catch { target = request; }
    const res = await fetch(target);
    if (bot) {
      try { ctx.waitUntil(sendHit(request, env, bot, res.status, false)); } catch {}
    }
    try {
      for (const ev of sideEvents(request, res, bot)) ctx.waitUntil(sendEvent(env, ev));
    } catch {}
    if (bot) {
      const t = await tagForAiBot(request, res, ua, env);
      if (t) {
        try {
          ctx.waitUntil(sendEvent(env, {
            type: 'tag', ts: Date.now(), tag: t.tag, bot, kind: t.kind, path: pathname.slice(0, 300),
          }));
        } catch {}
        return t.response;
      }
    }
    return res;
  },

  async scheduled(_event, env, ctx) {
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(runRetention(env));
    else await runRetention(env);
  },
};
