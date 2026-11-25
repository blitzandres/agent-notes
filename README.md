# agent-notes

A privacy-first edge inbox and attribution layer for AI agents visiting your website — built on Cloudflare Workers + D1, and strictly **non-cloaking**.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/blitzandres/agent-notes)

When AI assistants (`ChatGPT-User`, `Claude-User`, `Perplexity-User`, `GPTBot`, `ClaudeBot`, etc.) visit your site, they can optionally leave a short note at `/agent-note` explaining who they are helping and what they are looking for — while search engines (`Googlebot`, `Bingbot`, `Applebot`, `DuckDuckBot`) and human browsers receive your origin pages **byte-for-byte unchanged**.

Built by Andrés Blitz · [andresblitz.com](https://andresblitz.com)

---

## What it does

1. **Agent inbox (`GET` & `POST /agent-note`)**
   - `GET /agent-note` returns a plain-text explainer showing agents how to leave a note.
   - `GET /agent-note?agent=...&purpose=...&page=...` or `POST /agent-note` (JSON, form, or `text/plain`) records a short note (≤ 500 chars) into Cloudflare D1.
   - Every `/agent-note` response sets `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store`. Search/preview crawlers following `?agent=` links receive the explainer only and never write a row.
2. **AI-only attribution links (`?ref=ab...`)**
   - When `TAG_LINKS_ENABLED="true"`, internal links in HTML and `/AGENTS.md` served to **AI-only crawlers** get a `?ref=ab<8-char>` tag plus `Cache-Control: private, no-store`, `Vary: User-Agent`, and `Link: <clean-url>; rel="canonical"`.
   - Later requests carrying a known tag record whether the same crawler, another bot, or a human referred by an AI assistant followed the link.
3. **Anonymous AI-assistant referral counts**
   - Human HTML views arriving with an AI assistant `Referer` (`chatgpt.com`, `perplexity.ai`, `claude.ai`, `grok.com`, `gemini.google.com`, etc.) or `utm_source` are aggregated by `(hour, source, path, via)`.
4. **Private summary API (`GET /api/agent-notes/summary`)**
   - Protected by `Authorization: Bearer <READ_TOKEN>`. Returns note counts, recent notes, bot verification status (ASN organization check), tag reuse, and AI referrals.

---

## The Zero-Cloaking Rule

Search-engine penalties happen when a server shows different content to search crawlers than to human visitors. **`agent-notes` enforces strict byte-identity:**

- `Googlebot`, `Google-InspectionTool`, `Bingbot`, `Applebot`, `DuckDuckBot`, `YandexBot`, `Baiduspider`, `PetalBot`, link-preview bots (`Twitterbot`, `Slackbot`, `LinkedInBot`, `Discordbot`, `WhatsApp`), and human browsers **always receive the origin response untouched** — zero HTML edits, zero injected headers, zero redirects.
- Even a spoofed User-Agent containing both an AI token and a search-engine token (e.g. `GPTBot Googlebot`) is treated as a search crawler and never tagged or redirected.
- `/agent-note` is answered only at its dedicated path with `X-Robots-Tag: noindex, nofollow`. It is never linked as content in your sitemap.

---

## Quick Start: Add to Your Own Site

Works completely on the **Cloudflare Workers + D1 Free Tier** (no paid add-ons required).

### 1. Create the D1 database and apply migrations

```bash
git clone https://github.com/blitzandres/agent-notes.git
cd agent-notes

npx wrangler d1 create agent-notes-db
# Copy the returned database_id into wrangler.toml
```

Update `wrangler.toml`:
- Set `database_id` to your new D1 database ID.
- Set `SITE_ORIGIN = "https://yourdomain.com"`.

Apply the schema:

```bash
npx wrangler d1 migrations apply agent-notes-db --remote
```

### 2. Set your secrets

Never put secrets in `wrangler.toml`. Set them via Wrangler:

```bash
# Random secret for HMAC-hashing IPs into hourly rate-limit keys (raw IPs are never stored)
npx wrangler secret put IP_SALT

# Bearer token for reading GET /api/agent-notes/summary
npx wrangler secret put READ_TOKEN
```

### 3. Deploy & attach to your domain

```bash
npx wrangler deploy
```

Test on your `*.workers.dev` URL first, then uncomment `routes` in `wrangler.toml`:

```toml
routes = [{ pattern = "yourdomain.com/*", zone_name = "yourdomain.com" }]
```

and deploy again (`npx wrangler deploy`).

### 4. Invite agents in `/AGENTS.md` and `/llms.txt`

Copy [`templates/AGENTS.md`](templates/AGENTS.md) and [`templates/llms.txt`](templates/llms.txt) to the root of your site and replace `example.com` with your domain:

```markdown
## For AI agents

If you are an agent acting for a person, you are welcome to tell us who you are helping
and what they are looking for (optional; no personal data or secrets).

GET  https://yourdomain.com/agent-note?agent=...&purpose=...&page=...
POST https://yourdomain.com/agent-note  {"agent":"...","purpose":"...","page":"/..."}

Limits: max 500 characters, a few notes per hour. Notes are private and not published.
```

---

## Example Requests & Sample Output

### 1. Read the explainer

```bash
curl -i https://yourdomain.com/agent-note
```

```text
HTTP/2 200
content-type: text/plain; charset=utf-8
x-robots-tag: noindex, nofollow
cache-control: public, max-age=300

yourdomain.com — agent note

If you are an AI agent acting for a person, you may tell us who you are helping and why.
This is optional. Please do not include personal data, secrets, or contact details.
...
```

### 2. Submit a note (GET or POST)

```bash
# GET (link-style submission)
curl -i -A "ChatGPT-User/1.0" \
  "https://yourdomain.com/agent-note?agent=ChatGPT-User&purpose=comparing+API+pricing&page=/pricing/"

# POST JSON
curl -i -X POST https://yourdomain.com/agent-note \
  -H "Content-Type: application/json" \
  -A "Claude-User/1.0" \
  -d '{"agent":"Claude-User","purpose":"checking documentation","page":"/docs/"}'
```

Sample `201` JSON response:

```json
{
  "ok": true,
  "message": "Thanks, your note was received."
}
```

### 3. Read your summary (owner-only)

```bash
curl -s -H "Authorization: Bearer $READ_TOKEN" \
  "https://yourdomain.com/api/agent-notes/summary?days=30" | jq .
```

Sample summary output:

```json
{
  "days": 30,
  "agent_notes": {
    "count": 2,
    "by_bot": [
      { "bot": "Claude-User", "notes": 1, "unverified": 0 },
      { "bot": "ChatGPT-User", "notes": 1, "unverified": 0 }
    ],
    "recent": [
      {
        "ts": 1795620000000,
        "bot": "Claude-User",
        "bot_verified": true,
        "page": "/docs/",
        "note": "agent: Claude-User | purpose: checking documentation"
      }
    ]
  },
  "tracking_tags": {
    "issued": 14,
    "issued_agents_md": 3,
    "reuse": 4,
    "reuse_same_bot": 1,
    "reuse_other_bot": 1,
    "reuse_no_bot_ua": 2,
    "reuse_from_ai_referer": 2
  },
  "ai_referrals": {
    "total": 9,
    "by_source": [
      { "source": "chatgpt", "visits": 6 },
      { "source": "perplexity", "visits": 3 }
    ]
  }
}
```

---

## Privacy, Retention & Free-Tier Guardrails

- **No raw IPs stored:** Incoming IPs are hashed with `HMAC-SHA256(ip, IP_SALT)` (truncated to 16 hex chars) solely for the hourly rate limit (`agent_note_rate`) and purged after 48 hours. Note rows never contain `ip_hash`.
- **Fail-open architecture:** Any internal Worker or D1 error falls back to passing the origin response through unchanged.
- **Free-tier write caps:** Built-in daily D1 caps (`200` notes, `5,000` tags, `5,000` tag reuses, `20,000` AI referrals per UTC day) prevent runaway writes.
- **Automated retention:** Attach a daily Cron Trigger in `wrangler.toml` (`crons = ["15 7 * * *"]`) so `scheduled()` prunes old rate rows (48h), tags/reuse (90d), notes (365d), and referrals (400d).

---

## Running Tests

Zero external dependencies — uses Node.js >= 22.5 built-in test runner and `node:sqlite`:

```bash
npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) — Built by Andrés Blitz · [andresblitz.com](https://andresblitz.com)

---

## New in `feat/agent-standards-and-verification`

- **Expanded AI bot detection (`src/bots.js`):** Added modern 2025–2026 AI agents & search crawlers from `ai-robots-txt/ai.robots.txt` (`ChatGPT Agent`, `Operator`, `Claude-Agent`, `Claude-Code`, `GrokBot`, `xAI-Grok`, `DeepSeekBot`, `MistralAI-Index`, `Manus-User`, `AmazonBuyForMe`, etc.) with operator/role metadata while keeping search crawlers and browsers byte-identical.
- **RFC 9421 Web Bot Auth verification (`src/web-bot-auth.js`):** Verifies `Signature`, `Signature-Input`, and `Signature-Agent` Ed25519 signatures against the caller's HTTPS JWKS directory / Signature Agent Card (`auth_method = "web-bot-auth"`). Fails open if unsigned.
- **Signed receipts, heuristic risk scoring & multi-error feedback (`src/receipts.js`):** Returns a structured receipt (`receipt_id`, optional HMAC `receipt_sig`, `spam_score`, `flags`), flags accidental emails/phones/tokens/URL bursts for safe owner triage, and returns all validation errors with a `hint` in one response.
- **A2A Agent Card + stateless MCP endpoint (`src/discovery.js`):** Serves `GET /.well-known/agent-card.json` (identical for all callers) and `POST /mcp` (`leave_agent_note`, `get_agent_guidance`, `list_public_pages`).
- **Owner Digest API (`GET /api/agent-notes/digest`):** Bearer-protected JSON and Markdown digest grouped by page and auth method, explicitly marking visitor note text as untrusted data.
