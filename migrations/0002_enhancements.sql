-- Enhancements: Web Bot Auth verification metadata, signed receipts, and heuristic spam/PII risk flags.
ALTER TABLE agent_notes ADD COLUMN auth_method TEXT;      -- 'web-bot-auth' | 'asn-org' | 'none'
ALTER TABLE agent_notes ADD COLUMN signature_agent TEXT;  -- Signature-Agent URL/domain when verified
ALTER TABLE agent_notes ADD COLUMN keyid TEXT;            -- JWK thumbprint / keyid
ALTER TABLE agent_notes ADD COLUMN spam_score INTEGER DEFAULT 0;
ALTER TABLE agent_notes ADD COLUMN risk_flags TEXT;       -- comma-separated flags (e.g. 'email,url_burst')
ALTER TABLE agent_notes ADD COLUMN receipt_id TEXT;
