import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './d1shim.mjs';
import worker, { REF_RE, NOTE_MAX_CHARS, composeNote } from '../src/worker.js';

class FakeHTMLRewriter {
  constructor() { this.handlers = []; }
  on(sel, h) { if (sel === 'a[href]') this.handlers.push(h); return this; }
  transform(res) {
    const hs = this.handlers;
    const p = res.text().then((html) => html.replace(/<a\b([^>]*?)\bhref="([^"]*)"/gi, (_m, pre, href) => {
      let v = href;
      const el = { getAttribute: () => v, setAttribute: (_k, x) => { v = x; } };
      for (const h of hs) h.element(el);
      return '<a' + pre + 'href="' + v + '"';
    }));
    const stream = new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode(await p)); c.close(); } });
    return new Response(stream, { status: res.status, headers: res.headers });
  }
}
globalThis.HTMLRewriter = FakeHTMLRewriter;

const here = new URL('.', import.meta.url).pathname;
const MIGRATION = [here + '../migrations/0001_agent_notes.sql', here + '../migrations/0002_enhancements.sql'];

const UA = {
  browser: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15',
  google: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bing: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  apple: 'Mozilla/5.0 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  gpt: 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  claude: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  pplx: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
};

const HTML = '<!doctype html><html><head><link rel="canonical" href="https://example.com/pricing/" /></head><body>' +
  '<a href="/docs/">docs</a> <a href="https://example.com/guide/#top">guide</a> <a href="es/">es</a>' +
  ' <a href="https://github.com/example/repo">gh</a> <a href="#top">top</a></body></html>';
const AGENTS = '# AGENTS.md\n\n- Docs: https://example.com/docs/\n- [Pricing](/pricing/)\n';

function envWith(extra = {}) {
  return {
    DB: makeD1(MIGRATION),
    SITE_ORIGIN: 'https://example.com',
    IP_SALT: 'unit-test-salt',
    READ_TOKEN: 'rt-secret',
    REDIRECT_ENABLED: 'true',
    TAG_LINKS_ENABLED: 'true',
    ...extra,
  };
}

function harness(env = envWith()) {
  const waits = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    const p = new URL(url).pathname;
    if (p === '/AGENTS.md') {
      return new Response(AGENTS, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8', etag: '"a1"' } });
    }
    return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', etag: '"h1"' } });
  };
  const ctx = { waitUntil: (p) => waits.push(p) };
  const run = async (path, ua, { method = 'GET', headers = {}, body } = {}) => {
    const req = new Request('https://example.com' + path, {
      method,
      headers: { 'user-agent': ua, 'cf-connecting-ip': '198.51.100.42', ...headers },
      body,
    });
    const res = await worker.fetch(req, env, ctx);
    const text = method === 'HEAD' ? '' : await res.text();
    await Promise.all(waits);
    return { res, text, headers: Object.fromEntries(res.headers) };
  };
  return { env, run };
}

test('zero cloaking: search crawlers and humans receive byte-identical HTML and AGENTS.md', async () => {
  const h = harness();
  const baseHtml = await h.run('/pricing/', UA.browser);
  const baseMd = await h.run('/AGENTS.md', UA.browser);
  for (const ua of [UA.google, UA.bing, UA.apple, 'GPTBot/1.2 Googlebot/2.1']) {
    const r1 = await h.run('/pricing/', ua);
    assert.equal(r1.text, baseHtml.text);
    assert.deepEqual(r1.headers, baseHtml.headers);
    assert.ok(!r1.text.includes('ref=ab'));
    const r2 = await h.run('/AGENTS.md', ua);
    assert.equal(r2.text, baseMd.text);
    assert.deepEqual(r2.headers, baseMd.headers);
  }
});

test('AI-only crawlers get tagged internal links and canonical Link header', async () => {
  const h = harness();
  const r = await h.run('/pricing/', UA.gpt);
  const tag = (r.text.match(/ref=(ab[a-z2-7]{8})/) || [])[1];
  assert.ok(tag && REF_RE.test(tag));
  assert.ok(r.text.includes(`href="/docs/?ref=${tag}"`));
  assert.ok(r.text.includes(`href="https://example.com/guide/?ref=${tag}#top"`));
  assert.ok(r.text.includes('href="https://github.com/example/repo"'));
  assert.equal(r.headers.link, '<https://example.com/pricing/>; rel="canonical"');
  assert.equal(r.headers['cache-control'], 'private, no-store');

  // Later reuse by a human from ChatGPT is recorded
  await h.run(`/docs/?ref=${tag}`, UA.browser, { headers: { referer: 'https://chatgpt.com/' } });
  const rows = h.env.DB.raw.prepare('SELECT * FROM edge_ref_reuse').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].issued_bot, 'GPTBot');
  assert.equal(rows[0].ai_source, 'chatgpt');
});

test('/agent-note: GET explainer, GET/POST submissions, noindex, rate limit, never stores raw IP', async () => {
  const h = harness();
  const help = await h.run('/agent-note', UA.browser);
  assert.equal(help.res.status, 200);
  assert.equal(help.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(help.text, /agent note/);

  // Search crawler following ?agent= gets explainer only, nothing saved
  const crawl = await h.run('/agent-note?agent=Googlebot&purpose=crawl', UA.google);
  assert.equal(crawl.res.status, 200);
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS c FROM agent_notes').get().c, 0);

  // GET submission
  const g = await h.run('/agent-note?agent=ChatGPT-User&purpose=comparing+docs&page=/docs/', UA.gpt);
  assert.equal(g.res.status, 201);
  assert.equal(g.headers['x-robots-tag'], 'noindex, nofollow');

  // POST JSON submission
  const p = await h.run('/agent-note', UA.claude, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'Claude-User', purpose: 'reading pricing', page: '/pricing/?x=1' }),
  });
  assert.equal(p.res.status, 201);

  // Validation: empty & >500 chars
  assert.equal((await h.run('/agent-note', UA.gpt, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '   ' })).res.status, 400);
  assert.equal((await h.run('/agent-note', UA.gpt, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(NOTE_MAX_CHARS + 1) })).res.status, 413);

  const notes = h.env.DB.raw.prepare('SELECT * FROM agent_notes ORDER BY id').all();
  assert.equal(notes.length, 2);
  assert.equal(notes[0].note, 'agent: ChatGPT-User | purpose: comparing docs');
  assert.equal(notes[1].page, '/pricing/');
  assert.ok(!JSON.stringify(notes).includes('198.51.100.42'));

  // Rate limit: 5 per hour per ip_hash (2 already sent above)
  for (let i = 0; i < 3; i++) {
    assert.equal((await h.run('/agent-note', UA.gpt, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'n' + i })).res.status, 201);
  }
  assert.equal((await h.run('/agent-note', UA.gpt, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'over' })).res.status, 429);
});

test('/api/agent-notes/summary requires Bearer READ_TOKEN and hides ip_hash', async () => {
  const h = harness();
  await h.run('/agent-note', UA.gpt, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'GPTBot', purpose: 'summary test', page: '/' }),
  });
  assert.equal((await h.run('/api/agent-notes/summary', UA.browser)).res.status, 401);
  const res = await h.run('/api/agent-notes/summary?days=7', UA.browser, { headers: { authorization: 'Bearer rt-secret' } });
  assert.equal(res.res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.agent_notes.count, 1);
  assert.ok(!res.text.includes('ip_hash'));
});

test('composeNote formats bare note vs structured fields cleanly', () => {
  assert.equal(composeNote({ note: 'hello' }), 'hello');
  assert.equal(composeNote({ agent: 'A', purpose: 'B', note: 'C' }), 'agent: A | purpose: B | note: C');
});

test('scheduled retention purges expired rate rows', async () => {
  const env = envWith();
  env.DB.raw.prepare('INSERT INTO agent_note_rate (k, hour, n) VALUES (?, ?, 1)').run('old', Math.floor(Date.now() / 3600000) - 100);
  const waits = [];
  await worker.scheduled({ cron: '0 7 * * *', scheduledTime: Date.now() }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM agent_note_rate').get().c, 0);
});
