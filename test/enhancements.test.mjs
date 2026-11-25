import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './d1shim.mjs';
import worker, { classifyBot, getBotMeta } from '../src/worker.js';
import { jwkThumbprintEd25519, clearWebBotAuthCache } from '../src/web-bot-auth.js';
import { scoreNoteRisk } from '../src/receipts.js';

const here = new URL('.', import.meta.url).pathname;
const MIGRATIONS = [
  here + '../migrations/0001_agent_notes.sql',
  here + '../migrations/0002_enhancements.sql',
];

function envWith(extra = {}) {
  return {
    DB: makeD1(MIGRATIONS),
    SITE_ORIGIN: 'https://example.com',
    SITE_SUMMARY: 'Example developer documentation and pricing.',
    IP_SALT: 'test-salt',
    READ_TOKEN: 'rt-secret',
    RECEIPT_SECRET: 'rcpt-secret',
    TAG_LINKS_ENABLED: 'true',
    ...extra,
  };
}

function bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

test('ai-robots-txt expansion: classifies modern AI agents & search crawlers with metadata', () => {
  assert.equal(classifyBot('GrokBot/1.0 (+https://x.ai)'), 'GrokBot');
  assert.deepEqual(getBotMeta('GrokBot'), { operator: 'xAI', role: 'search' });
  assert.equal(classifyBot('DeepSeekBot/1.0'), 'DeepSeekBot');
  assert.equal(classifyBot('MistralAI-Index/1.0'), 'MistralAI-Index');
  assert.equal(classifyBot('Claude-Agent/1.0'), 'Claude-Agent');
  assert.equal(classifyBot('ChatGPT Agent/1.0'), 'ChatGPT Agent');
  assert.equal(classifyBot('Manus-User/1.0'), 'Manus-User');
  assert.equal(classifyBot('AmazonBuyForMe/1.0'), 'AmazonBuyForMe');
  // Search engine protection still intact
  assert.equal(classifyBot('Mozilla/5.0 (compatible; Googlebot/2.1)'), 'Googlebot');
});

test('Web Bot Auth (RFC 9421): verifies valid Ed25519 signature and fails open on tamper', async () => {
  clearWebBotAuthCache();
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const keyid = await jwkThumbprintEd25519(pubJwk);
  const nowSec = Math.floor(Date.now() / 1000);
  const agentDirUrl = 'https://bot.example/.well-known/http-message-signatures-directory';
  const sigParams = `("@authority" "signature-agent");created=${nowSec - 10};expires=${nowSec + 120};keyid="${keyid}";tag="web-bot-auth"`;
  const sigAgentHeader = `sig1="${agentDirUrl}"`;
  const sigBase = `"@authority": example.com\n"signature-agent": ${sigAgentHeader}\n"@signature-params": ${sigParams}`;
  const sigBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(sigBase)));

  const fetcher = async (url) => {
    assert.equal(url, agentDirUrl);
    return new Response(JSON.stringify({ keys: [pubJwk] }), {
      status: 200,
      headers: { 'content-type': 'application/http-message-signatures-directory+json' },
    });
  };

  const env = envWith({ _wbaOpts: { fetcher, nowSec } });
  const req = new Request('https://example.com/agent-note', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'GrokBot/1.0',
      'cf-connecting-ip': '198.51.100.10',
      'signature-agent': sigAgentHeader,
      'signature-input': `sig1=${sigParams}`,
      signature: `sig1=:${bytesToB64(sigBytes)}:`,
    },
    body: JSON.stringify({ agent: 'GrokBot', purpose: 'signed verification test', page: '/docs/' }),
  });

  const res = await worker.fetch(req, env, { waitUntil() {} });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.receipt.auth_method, 'web-bot-auth');
  assert.ok(body.receipt.receipt_id.startsWith('rcpt_'));
  assert.match(body.receipt.receipt_sig, /^[0-9a-f]{32}$/);

  const row = env.DB.raw.prepare('SELECT auth_method, signature_agent, keyid, bot_verified FROM agent_notes').get();
  assert.equal(row.auth_method, 'web-bot-auth');
  assert.equal(row.signature_agent, agentDirUrl);
  assert.equal(row.keyid, keyid);
  assert.equal(row.bot_verified, 1);

  // Tampered signature still fails open cleanly (stored with auth_method='none', not rejected)
  const badReq = new Request('https://example.com/agent-note', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'GrokBot/1.0',
      'cf-connecting-ip': '198.51.100.11',
      'signature-agent': sigAgentHeader,
      'signature-input': `sig1=${sigParams}`,
      signature: `sig1=:${bytesToB64(new Uint8Array(64))}:`,
    },
    body: JSON.stringify({ agent: 'GrokBot', purpose: 'tampered sig', page: '/docs/' }),
  });
  const badRes = await worker.fetch(badReq, env, { waitUntil() {} });
  assert.equal(badRes.status, 201);
  const badBody = await badRes.json();
  assert.equal(badBody.receipt.auth_method, 'none');
});

test('spam/PII risk scoring and multi-error JSON validation', async () => {
  const s1 = scoreNoteRisk('Looking at pricing');
  assert.equal(s1.spam_score, 0);
  assert.deepEqual(s1.flags, []);

  const s2 = scoreNoteRisk('Contact me at test@example.org https://a.test https://b.test');
  assert.ok(s2.spam_score >= 60);
  assert.ok(s2.flags.includes('email_like'));
  assert.ok(s2.flags.includes('url_burst'));

  const env = envWith();
  const errRes = await worker.fetch(new Request('https://example.com/agent-note', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.20' },
    body: JSON.stringify({ agent: 123 }),
  }), env, { waitUntil() {} });
  assert.equal(errRes.status, 400);
  const errBody = await errRes.json();
  assert.ok(Array.isArray(errBody.errors) && errBody.errors.length >= 2);
  assert.ok(typeof errBody.hint === 'string' && errBody.hint.length > 10);
});

test('A2A agent card (/.well-known/agent-card.json) is identical for Googlebot, GPTBot, and browsers', async () => {
  const env = envWith();
  const resBrowser = await worker.fetch(new Request('https://example.com/.well-known/agent-card.json', {
    headers: { 'user-agent': 'Mozilla/5.0 Safari/605.1.15' },
  }), env, { waitUntil() {} });
  const resGoogle = await worker.fetch(new Request('https://example.com/.well-known/agent-card.json', {
    headers: { 'user-agent': 'Googlebot/2.1' },
  }), env, { waitUntil() {} });
  const resGpt = await worker.fetch(new Request('https://example.com/.well-known/agent-card.json', {
    headers: { 'user-agent': 'GPTBot/1.2' },
  }), env, { waitUntil() {} });

  const t1 = await resBrowser.text();
  assert.equal(resBrowser.status, 200);
  assert.equal(t1, await resGoogle.text());
  assert.equal(t1, await resGpt.text());
  const card = JSON.parse(t1);
  assert.equal(card.endpoints.agent_note, 'https://example.com/agent-note');
  assert.equal(card.endpoints.mcp, 'https://example.com/mcp');
});

test('MCP endpoint (/mcp): initialize, tools/list, get_agent_guidance, list_public_pages, leave_agent_note', async () => {
  const env = envWith();
  const callMcp = (body) => worker.fetch(new Request('https://example.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Claude-Agent/1.0', 'cf-connecting-ip': '198.51.100.30' },
    body: JSON.stringify(body),
  }), env, { waitUntil() {} });

  const init = await (await callMcp({ jsonrpc: '2.0', id: 1, method: 'initialize' })).json();
  assert.equal(init.result.protocolVersion, '2025-03-26');

  const tools = await (await callMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.deepEqual(tools.result.tools.map((t) => t.name), ['leave_agent_note', 'get_agent_guidance', 'list_public_pages']);

  const guidance = await (await callMcp({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_agent_guidance', arguments: {} },
  })).json();
  assert.match(guidance.result.content[0].text, /Example developer documentation/);

  const noteCall = await (await callMcp({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'leave_agent_note', arguments: { agent: 'Claude-Agent', purpose: 'via MCP', page: '/docs/' } },
  })).json();
  assert.equal(noteCall.result.isError, false);
  const receiptJson = JSON.parse(noteCall.result.content[0].text);
  assert.equal(receiptJson.ok, true);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM agent_notes').get().c, 1);
});

test('notes digest API (/api/agent-notes/digest) returns JSON & Markdown with untrusted warning', async () => {
  const env = envWith();
  await worker.fetch(new Request('https://example.com/agent-note', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Perplexity-User/1.0', 'cf-connecting-ip': '198.51.100.40' },
    body: JSON.stringify({ agent: 'Perplexity-User', purpose: 'checking docs', page: '/docs/' }),
  }), env, { waitUntil() {} });

  assert.equal((await worker.fetch(new Request('https://example.com/api/agent-notes/digest'), env, { waitUntil() {} })).status, 401);

  const jsonRes = await worker.fetch(new Request('https://example.com/api/agent-notes/digest?hours=24', {
    headers: { authorization: 'Bearer rt-secret' },
  }), env, { waitUntil() {} });
  assert.equal(jsonRes.status, 200);
  const j = await jsonRes.json();
  assert.equal(j.total, 1);
  assert.equal(j.by_page[0].page, '/docs/');

  const mdRes = await worker.fetch(new Request('https://example.com/api/agent-notes/digest?hours=24&format=markdown', {
    headers: { authorization: 'Bearer rt-secret' },
  }), env, { waitUntil() {} });
  const md = await mdRes.text();
  assert.match(md, /UNTRUSTED visitor input/);
  assert.match(md, /Perplexity-User/);
});
