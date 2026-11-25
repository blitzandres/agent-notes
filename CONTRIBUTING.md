# Contributing to `agent-notes`

Contributions are welcome! Please keep these core principles intact:

1. **Zero-cloaking guarantee:** Search crawlers (`Googlebot`, `Bingbot`, `Applebot`, `DuckDuckBot`, etc.), link-preview bots, and human browsers must always receive byte-identical origin HTML and `AGENTS.md`. Never alter search-crawler responses.
2. **Fail-open edge behavior:** If storage, classification, or analytics fails, the Worker must pass the origin response through untouched without delaying or breaking page loads.
3. **Privacy by default:** Never store raw visitor IPs. Rate-limiting uses a salted 16-hex HMAC hash purged after 48 hours. Never log personal details or secrets.
4. **Free-tier safe:** Keep D1 writes bounded by daily caps and avoid heavy dependencies.

## Running tests locally

Requires Node.js >= 22.5 (uses built-in `node:sqlite` for the D1 test shim, zero `npm install` needed):

```bash
npm test
```

## Opening a Pull Request

1. Fork the repo and create a feature branch (`git checkout -b feat/my-improvement`).
2. Add or update tests in `test/` covering both normal behavior and the no-cloaking / fail-open invariants.
3. Verify `npm test` passes cleanly and no secrets, account IDs, or personal data appear in your diff.
4. Open a Pull Request describing what you changed and why.
