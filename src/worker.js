/**
 * agent-notes — pass-through Cloudflare Worker for AI agent interaction, attribution, and private notes.
 *
 * - Every request defaults to fetch(request), unchanged. Any internal error falls back to pass-through (fail open).
 * - Search crawlers (Googlebot, Bingbot, Applebot, ...) and human browsers receive byte-identical origin responses.
 * - /agent-note accepts short, optional notes from AI agents (GET explainer or GET/POST submission; X-Robots-Tag: noindex).
 * - Raw IPs never leave the Worker; rate limiting uses the first 16 hex chars of HMAC-SHA256(ip, IP_SALT).
 */

import {
  NOTE_PATHS, REF_RE, handleAgentNote, tagForAiBot, detectAiReferral, sendEvent, siteOrigin,
} from './agent-features.js';
import { buildAgentFeaturesSummary, runRetention, timingSafeEqualStr } from './storage.js';

export * from './agent-features.js';

export const BOTS = [
  ['OAI-SearchBot', /oai-searchbot/i],
  ['ChatGPT-User', /chatgpt-user/i],
  ['GPTBot', /gptbot/i],
  ['Claude-SearchBot', /claude-searchbot/i],
  ['Claude-User', /claude-user/i],
  ['ClaudeBot', /claudebot/i],
  ['anthropic-ai', /anthropic-ai/i],
  ['Perplexity-User', /perplexity-user/i],
  ['PerplexityBot', /perplexitybot/i],
  ['Google-Extended', /google-extended/i],
  ['Google-CloudVertexBot', /google-cloudvertexbot/i],
  ['GoogleOther', /googleother/i],
  ['Googlebot', /googlebot/i],
  ['Google-InspectionTool', /google-inspectiontool/i],
  ['Bingbot', /bingbot/i],
  ['Applebot-Extended', /applebot-extended/i],
  ['Applebot', /applebot/i],
  ['Amazonbot', /amazonbot/i],
  ['Meta-ExternalAgent', /meta-externalagent/i],
  ['Meta-ExternalFetcher', /meta-externalfetcher/i],
  ['FacebookBot', /facebookbot/i],
  ['facebookexternalhit', /facebookexternalhit/i],
  ['Bytespider', /bytespider/i],
  ['CCBot', /ccbot/i],
  ['cohere-ai', /cohere-ai|cohere-training-data-crawler/i],
  ['DuckAssistBot', /duckassistbot/i],
  ['DuckDuckBot', /duckduckbot/i],
  ['YandexBot', /yandex(bot|images|mobilebot|accessibilitybot)/i],
  ['Baiduspider', /baiduspider/i],
  ['PetalBot', /petalbot/i],
  ['Diffbot', /diffbot/i],
  ['MistralAI-User', /mistralai-user/i],
  ['YouBot', /youbot/i],
  ['AI2Bot', /ai2bot/i],
  ['Timpibot', /timpibot/i],
  ['ImagesiftBot', /imagesiftbot/i],
  ['Omgilibot', /omgili/i],
  ['Twitterbot', /twitterbot/i],
  ['Slackbot', /slackbot/i],
  ['LinkedInBot', /linkedinbot/i],
  ['Discordbot', /discordbot/i],
  ['WhatsApp', /whatsapp/i],
  ['TelegramBot', /telegrambot/i],
  ['SemrushBot', /semrushbot/i],
  ['AhrefsBot', /ahrefsbot/i],
  ['DataForSeoBot', /dataforseobot/i],
  ['MJ12bot', /mj12bot/i],
];

const REDIRECT_RE = /gptbot|claudebot|anthropic-ai|perplexitybot|ccbot|bytespider|amazonbot/i;
const NEVER_REDIRECT_RE = /googlebot|google-|bingbot|bingpreview|facebookexternalhit|twitterbot|slackbot|linkedinbot|discordbot|whatsapp|telegrambot|embedly|skypeuripreview|iframely|redditbot|pinterest/i;
const GENERIC_RE = /([a-z0-9][a-z0-9._-]{0,40}(?:bot|crawler|spider))/i;

export function classifyBot(ua) {
  if (!ua) return null;
  for (const [name, re] of BOTS) if (re.test(ua)) return name;
  if (/cubot/i.test(ua)) return null;
  const m = ua.match(GENERIC_RE);
  if (m) return 'other:' + m[1].toLowerCase().slice(0, 40);
  return null;
}

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

async function handleSummaryApi(request, env) {
  const auth = request.headers.get('authorization') || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!env || !env.READ_TOKEN || !tok || !(await timingSafeEqualStr(tok, env.READ_TOKEN))) {
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
