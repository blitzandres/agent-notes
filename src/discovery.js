/**
 * Agent discovery & stateless MCP endpoint (A2A /.well-known/agent-card.json + POST /mcp).
 * Non-cloaking: these dedicated endpoints return the same response to all user agents,
 * leaving every normal HTML page and AGENTS.md byte-identical across browsers and search bots.
 */

import { siteOrigin, siteHost, handleAgentNote } from './agent-features.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
};

export function buildAgentCard(env) {
  const origin = siteOrigin(env);
  const host = siteHost(env);
  return {
    name: `${host} Agent Interface`,
    description: String((env && env.SITE_SUMMARY) || `Public machine-readable guidance and optional /agent-note inbox for ${host}.`),
    url: origin,
    version: '1.0.0',
    protocolVersion: '0.3.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    documentationUrl: `${origin}/AGENTS.md`,
    endpoints: {
      agent_note: `${origin}/agent-note`,
      agents_md: `${origin}/AGENTS.md`,
      llms_txt: `${origin}/llms.txt`,
      mcp: `${origin}/mcp`,
    },
    skills: [
      {
        id: 'leave_agent_note',
        name: 'Leave an agent note',
        description: 'Send a short (<= 500 chars), non-personal note explaining who you are helping and what page you read.',
        tags: ['feedback', 'agent-note', 'inbox'],
        examples: [
          `GET ${origin}/agent-note?agent=ExampleBot&purpose=comparing+docs&page=/docs/`,
          `POST ${origin}/agent-note {"agent":"ExampleBot","purpose":"checking pricing","page":"/pricing/"}`,
        ],
      },
      {
        id: 'read_site_guidance',
        name: 'Read site guidance and key pages',
        description: 'Read AGENTS.md, llms.txt, or query the read-only MCP endpoint for public site summary and page index.',
        tags: ['discovery', 'llms-txt', 'agents-md', 'mcp'],
      },
    ],
  };
}

export function handleAgentCard(request, env) {
  const m = request.method.toUpperCase();
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (m !== 'GET' && m !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: JSON_HEADERS });
  }
  const body = m === 'HEAD' ? null : JSON.stringify(buildAgentCard(env), null, 2);
  return new Response(body, {
    status: 200,
    headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=300' },
  });
}

function getConfiguredPages(env) {
  const origin = siteOrigin(env);
  if (env && env.PUBLIC_PAGES_JSON) {
    try {
      const parsed = JSON.parse(env.PUBLIC_PAGES_JSON);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [
    { path: '/', url: `${origin}/`, title: 'Home', description: 'Primary landing page' },
    { path: '/AGENTS.md', url: `${origin}/AGENTS.md`, title: 'AGENTS.md', description: 'Crawl guidance and /agent-note instructions' },
    { path: '/llms.txt', url: `${origin}/llms.txt`, title: 'llms.txt', description: 'Structured index of public pages' },
  ];
}

const MCP_TOOLS = [
  {
    name: 'leave_agent_note',
    description: 'Leave a short (<= 500 chars) optional note for the site owner explaining who you are helping and why. Do not include personal data or secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent or product name (e.g., ChatGPT-User, Claude-User)' },
        purpose: { type: 'string', description: 'Short non-personal summary of what the user is looking for' },
        note: { type: 'string', description: 'Optional free-text note' },
        page: { type: 'string', description: 'Site path read (e.g., /docs/)' },
      },
    },
  },
  {
    name: 'get_agent_guidance',
    description: 'Return the site summary, /agent-note rules, and canonical discovery links (AGENTS.md, llms.txt, agent-card).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_public_pages',
    description: 'List configured public pages and machine-readable files on the site.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function rpcOk(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), {
    status: 200,
    headers: { ...JSON_HEADERS, 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' },
  });
}

function rpcErr(id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), {
    status: 200,
    headers: { ...JSON_HEADERS, 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' },
  });
}

export async function handleMcpRequest(request, env, bot, buildPayload) {
  const m = request.method.toUpperCase();
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (m !== 'POST') {
    return new Response(JSON.stringify({
      error: 'Use POST with JSON-RPC 2.0 (methods: initialize, tools/list, tools/call)',
      tools: MCP_TOOLS.map((t) => t.name),
    }), {
      status: m === 'GET' ? 200 : 405,
      headers: { ...JSON_HEADERS, 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' },
    });
  }

  let msg;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return rpcErr(null, -32600, 'request too large');
    msg = JSON.parse(raw);
  } catch {
    return rpcErr(null, -32700, 'parse error');
  }
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcErr(msg && msg.id, -32600, 'invalid JSON-RPC 2.0 request');
  }

  const origin = siteOrigin(env);
  const host = siteHost(env);

  if (msg.method === 'initialize') {
    return rpcOk(msg.id, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: `${host}-agent-notes`, version: '1.1.0' },
    });
  }
  if (msg.method === 'notifications/initialized') {
    return new Response(null, { status: 204, headers: { ...JSON_HEADERS, 'x-robots-tag': 'noindex, nofollow' } });
  }
  if (msg.method === 'tools/list') {
    return rpcOk(msg.id, { tools: MCP_TOOLS });
  }
  if (msg.method === 'tools/call') {
    const params = msg.params || {};
    const name = params.name;
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};

    if (name === 'get_agent_guidance') {
      const payload = {
        site: origin,
        summary: String((env && env.SITE_SUMMARY) || `Public site ${host}.`),
        agents_md: `${origin}/AGENTS.md`,
        llms_txt: `${origin}/llms.txt`,
        agent_card: `${origin}/.well-known/agent-card.json`,
        agent_note_endpoint: `${origin}/agent-note`,
        rules: 'Max 500 chars combined, no personal data or secrets, notes are private and not published.',
      };
      return rpcOk(msg.id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
    }

    if (name === 'list_public_pages') {
      return rpcOk(msg.id, { content: [{ type: 'text', text: JSON.stringify({ pages: getConfiguredPages(env) }, null, 2) }] });
    }

    if (name === 'leave_agent_note') {
      const fwdReq = new Request(`${origin}/agent-note`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': request.headers.get('user-agent') || '',
          'cf-connecting-ip': request.headers.get('cf-connecting-ip') || '',
          referer: request.headers.get('referer') || '',
          ...(request.headers.get('signature-input') ? { 'signature-input': request.headers.get('signature-input') } : {}),
          ...(request.headers.get('signature') ? { signature: request.headers.get('signature') } : {}),
          ...(request.headers.get('signature-agent') ? { 'signature-agent': request.headers.get('signature-agent') } : {}),
        },
        body: JSON.stringify({
          agent: typeof args.agent === 'string' ? args.agent : null,
          purpose: typeof args.purpose === 'string' ? args.purpose : null,
          note: typeof args.note === 'string' ? args.note : null,
          page: typeof args.page === 'string' ? args.page : null,
        }),
      });
      const res = await handleAgentNote(fwdReq, env, bot, buildPayload);
      const text = await res.text();
      return rpcOk(msg.id, { isError: res.status >= 400, content: [{ type: 'text', text }] });
    }

    return rpcErr(msg.id, -32601, `unknown tool: ${String(name || '')}`);
  }

  return rpcErr(msg.id, -32601, `method not found: ${msg.method}`);
}
