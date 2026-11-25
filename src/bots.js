/**
 * Bot & AI agent classification registry, enriched from ai-robots-txt/ai.robots.txt.
 * Order matters: more specific tokens appear before generic ones.
 * Search crawlers and link-preview bots remain protected by NEVER_TAG_RE / NEVER_REDIRECT_RE.
 */

export const BOTS = [
  // OpenAI
  ['OAI-SearchBot', /oai-searchbot/i, 'OpenAI', 'search'],
  ['ChatGPT Agent', /chatgpt agent/i, 'OpenAI', 'agent'],
  ['ChatGPT-User', /chatgpt-user/i, 'OpenAI', 'assistant'],
  ['Operator', /\boperator\b/i, 'OpenAI', 'agent'],
  ['Codex', /\bcodex\b/i, 'OpenAI', 'coding-agent'],
  ['GPTBot', /gptbot/i, 'OpenAI', 'training'],
  // Anthropic
  ['Claude-SearchBot', /claude-searchbot/i, 'Anthropic', 'search'],
  ['Claude-User', /claude-user/i, 'Anthropic', 'assistant'],
  ['Claude-Agent', /claude-agent/i, 'Anthropic', 'agent'],
  ['Claude-Code', /claude-code/i, 'Anthropic', 'coding-agent'],
  ['ClaudeBot', /claudebot/i, 'Anthropic', 'training'],
  ['anthropic-ai', /anthropic-ai/i, 'Anthropic', 'training'],
  // Perplexity
  ['Perplexity-User', /perplexity-user/i, 'Perplexity', 'assistant'],
  ['PerplexityBot', /perplexitybot/i, 'Perplexity', 'search'],
  // xAI
  ['xAI-Grok', /xai-grok/i, 'xAI', 'search'],
  ['GrokAppAndroid', /grokappandroid/i, 'xAI', 'assistant'],
  ['GrokBot', /grokbot/i, 'xAI', 'search'],
  // Google (Search bots must stay distinct from AI fetchers)
  ['GoogleAgent-Mariner', /googleagent-mariner/i, 'Google', 'agent'],
  ['GoogleAgent-URLContext', /googleagent-urlcontext/i, 'Google', 'assistant'],
  ['Google-NotebookLM', /google-notebooklm|notebooklm/i, 'Google', 'assistant'],
  ['Google-Extended', /google-extended/i, 'Google', 'training'],
  ['Google-CloudVertexBot', /google-cloudvertexbot/i, 'Google', 'training'],
  ['GoogleOther', /googleother/i, 'Google', 'crawler'],
  ['Google-InspectionTool', /google-inspectiontool/i, 'Google', 'search-engine'],
  ['Googlebot', /googlebot/i, 'Google', 'search-engine'],
  // Microsoft / Bing
  ['AzureAI-SearchBot', /azureai-searchbot/i, 'Microsoft', 'search'],
  ['Bingbot', /bingbot/i, 'Microsoft', 'search-engine'],
  // Apple
  ['Applebot-Extended', /applebot-extended/i, 'Apple', 'training'],
  ['Applebot', /applebot/i, 'Apple', 'search-engine'],
  // Amazon
  ['AmazonBuyForMe', /amazonbuyforme/i, 'Amazon', 'agent'],
  ['Amzn-SearchBot', /amzn-searchbot/i, 'Amazon', 'search'],
  ['Amzn-User', /amzn-user/i, 'Amazon', 'assistant'],
  ['bedrockbot', /bedrockbot/i, 'Amazon', 'training'],
  ['Amazonbot', /amazonbot/i, 'Amazon', 'training'],
  // Meta
  ['Meta-ExternalAgent', /meta-externalagent/i, 'Meta', 'training'],
  ['Meta-ExternalFetcher', /meta-externalfetcher/i, 'Meta', 'assistant'],
  ['FacebookBot', /facebookbot/i, 'Meta', 'training'],
  ['facebookexternalhit', /facebookexternalhit/i, 'Meta', 'link-preview'],
  // Mistral / DeepSeek / Cohere / Others
  ['MistralAI-Index', /mistralai-index/i, 'Mistral', 'search'],
  ['MistralAI-Training', /mistralai-training/i, 'Mistral', 'training'],
  ['MistralAI-User', /mistralai-user/i, 'Mistral', 'assistant'],
  ['DeepSeekBot', /deepseekbot/i, 'DeepSeek', 'training'],
  ['cohere-ai', /cohere-ai|cohere-training-data-crawler/i, 'Cohere', 'training'],
  ['Manus-User', /manus-user/i, 'Manus', 'agent'],
  ['NovaAct', /novaact/i, 'Nova', 'agent'],
  ['Cursor', /\bcursor\//i, 'Cursor', 'coding-agent'],
  ['Cloudflare-AutoRAG', /cloudflare-autorag/i, 'Cloudflare', 'search'],
  ['Bytespider', /bytespider/i, 'ByteDance', 'training'],
  ['CCBot', /ccbot/i, 'CommonCrawl', 'training'],
  ['DuckAssistBot', /duckassistbot/i, 'DuckDuckGo', 'assistant'],
  ['DuckDuckBot', /duckduckbot/i, 'DuckDuckGo', 'search-engine'],
  ['YandexBot', /yandex(bot|images|mobilebot|accessibilitybot)/i, 'Yandex', 'search-engine'],
  ['Baiduspider', /baiduspider/i, 'Baidu', 'search-engine'],
  ['PetalBot', /petalbot/i, 'Huawei', 'search-engine'],
  ['Diffbot', /diffbot/i, 'Diffbot', 'training'],
  ['YouBot', /youbot/i, 'You.com', 'search'],
  ['AI2Bot', /ai2bot/i, 'AllenAI', 'training'],
  ['Timpibot', /timpibot/i, 'Timpi', 'training'],
  ['ImagesiftBot', /imagesiftbot/i, 'Hive', 'training'],
  ['Omgilibot', /omgili/i, 'Webz.io', 'training'],
  // Link previews & SEO crawlers
  ['Twitterbot', /twitterbot/i, 'X', 'link-preview'],
  ['Slackbot', /slackbot/i, 'Slack', 'link-preview'],
  ['LinkedInBot', /linkedinbot/i, 'LinkedIn', 'link-preview'],
  ['Discordbot', /discordbot/i, 'Discord', 'link-preview'],
  ['WhatsApp', /whatsapp/i, 'Meta', 'link-preview'],
  ['TelegramBot', /telegrambot/i, 'Telegram', 'link-preview'],
  ['SemrushBot', /semrushbot/i, 'Semrush', 'seo'],
  ['AhrefsBot', /ahrefsbot/i, 'Ahrefs', 'seo'],
  ['DataForSeoBot', /dataforseobot/i, 'DataForSEO', 'seo'],
  ['MJ12bot', /mj12bot/i, 'Majestic', 'seo'],
];

export const BOT_META = new Map(BOTS.map(([name, _re, operator, role]) => [name, { operator, role }]));

export const AI_TAG_RE = /gptbot|chatgpt-user|chatgpt agent|oai-searchbot|claudebot|claude-user|claude-searchbot|claude-agent|claude-code|anthropic-ai|perplexitybot|perplexity-user|ccbot|bytespider|amazonbot|amzn-user|amzn-searchbot|amazonbuyforme|bedrockbot|meta-externalagent|meta-externalfetcher|cohere-ai|cohere-training-data-crawler|diffbot|mistralai-user|mistralai-index|mistralai-training|deepseekbot|grokbot|xai-grok|grokappandroid|manus-user|novaact|youbot|ai2bot|timpibot|duckassistbot|imagesiftbot|omgili|cloudflare-autorag/i;

export const NEVER_TAG_RE = /googlebot|google-|googleother|adsbot|mediapartners|bingbot|bingpreview|msnbot|adidxbot|applebot|petalbot|duckduckbot|yandex|baiduspider|slurp|seznambot|naver|yeti|sogou|qwantify|qwantbot|mojeek|ecosia|exabot|facebookexternalhit|twitterbot|slackbot|linkedinbot|discordbot|whatsapp|telegrambot|embedly|skypeuripreview|iframely|redditbot|pinterest|semrush|ahrefs|dataforseo|mj12bot/i;

export const REDIRECT_RE = /gptbot|claudebot|anthropic-ai|perplexitybot|ccbot|bytespider|amazonbot/i;
export const NEVER_REDIRECT_RE = /googlebot|google-|bingbot|bingpreview|facebookexternalhit|twitterbot|slackbot|linkedinbot|discordbot|whatsapp|telegrambot|embedly|skypeuripreview|iframely|redditbot|pinterest/i;
const GENERIC_RE = /([a-z0-9][a-z0-9._-]{0,40}(?:bot|crawler|spider))/i;

export function classifyBot(ua) {
  if (!ua) return null;
  for (const [name, re] of BOTS) if (re.test(ua)) return name;
  if (/cubot/i.test(ua)) return null;
  const m = ua.match(GENERIC_RE);
  if (m) return 'other:' + m[1].toLowerCase().slice(0, 40);
  return null;
}

export function getBotMeta(botName) {
  return BOT_META.get(botName) || null;
}
