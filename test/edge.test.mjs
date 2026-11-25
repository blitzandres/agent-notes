import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { classifyBot } from '../src/worker.js';

const UA = {
  human: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  gpt: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  claude: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  google: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bing: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  twitter: 'Twitterbot/1.0',
  fbhit: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  weird: 'Mozilla/5.0 (compatible; FooCrawler/3.1)',
  cubot: 'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
};
const ENV = {
  SITE_ORIGIN: 'https://example.com',
  EDGE_TOKEN: 'test-token',
  IP_SALT: 'test-salt',
  ANALYTICS_URL: 'https://analytics.example',
  REDIRECT_ENABLED: 'false',
};
const RAW_IP = '203.0.113.77';

function harness(env = ENV, { originThrowsOnPost = false } = {}) {
  const calls = { origin: [], posts: [] };
  const waits = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://analytics.example')) {
      if (originThrowsOnPost) throw new Error('analytics down');
      calls.posts.push({ url, headers: init.headers, body: JSON.parse(init.body), raw: init.body });
      return new Response(null, { status: 204 });
    }
    calls.origin.push(url);
    return new Response('ORIGIN ' + new URL(url).pathname, { status: 200, headers: { 'x-origin': '1' } });
  };
  const ctx = { waitUntil: (p) => waits.push(p) };
  const run = async (path, ua, method = 'GET') => {
    const req = new Request('https://example.com' + path, {
      method, headers: { 'user-agent': ua, 'cf-connecting-ip': RAW_IP, referer: 'https://ref.example/x?y=1' },
    });
    const res = await worker.fetch(req, env, ctx);
    await Promise.all(waits);
    return res;
  };
  return { calls, run };
}

test('human: pass-through unchanged, no POST', async () => {
  const h = harness({ ...ENV, REDIRECT_ENABLED: 'true' });
  const r = await h.run('/', UA.human);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ORIGIN /');
  assert.equal(r.headers.get('x-origin'), '1');
  assert.equal(h.calls.posts.length, 0);
  assert.equal(h.calls.origin.length, 1);
});

test('GPTBot on / with REDIRECT_ENABLED=true -> 302 + POST redirected=1', async () => {
  const h = harness({ ...ENV, REDIRECT_ENABLED: 'true' });
  const r = await h.run('/', UA.gpt);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://example.com/AGENTS.md');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('vary'), 'User-Agent');
  assert.equal(h.calls.origin.length, 0);
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].body.bot, 'GPTBot');
  assert.equal(h.calls.posts[0].body.redirected, 1);
});

test('Googlebot / Bingbot / link-preview bots on / never redirected', async () => {
  const h = harness({ ...ENV, REDIRECT_ENABLED: 'true' });
  for (const ua of [UA.google, UA.bing, UA.twitter, UA.fbhit, 'GPTBot Twitterbot']) {
    const r = await h.run('/', ua);
    assert.equal(r.status, 200, ua);
  }
  assert.ok(h.calls.posts.every((p) => p.body.redirected === 0));
});

test('/AGENTS.md never redirected — no loop', async () => {
  const h = harness({ ...ENV, REDIRECT_ENABLED: 'true' });
  for (const p of ['/AGENTS.md', '/docs/', '/index.html']) {
    assert.equal((await h.run(p, UA.gpt)).status, 200);
  }
});

test('no raw IP in payload; ip_hash is 16 hex', async () => {
  const h = harness();
  await h.run('/docs/?utm_source=x&token=secret', UA.google);
  const p = h.calls.posts[0];
  assert.ok(!p.raw.includes(RAW_IP));
  assert.ok(!p.raw.includes('token=secret'));
  assert.match(p.body.ip_hash, /^[0-9a-f]{16}$/);
});

test('analytics POST throws -> still pass-through (fail-open)', async () => {
  const h = harness(ENV, { originThrowsOnPost: true });
  const r = await h.run('/', UA.gpt);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ORIGIN /');
});

test('classifier labels', () => {
  assert.equal(classifyBot(UA.human), null);
  assert.equal(classifyBot(UA.cubot), null);
  assert.equal(classifyBot(UA.weird), 'other:foocrawler');
  assert.equal(classifyBot('OAI-SearchBot/1.0'), 'OAI-SearchBot');
  assert.equal(classifyBot('Perplexity-User/1.0'), 'Perplexity-User');
});
