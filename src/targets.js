export const PROVIDERS = {
  chatgpt: { label: 'ChatGPT', host: 'chatgpt.com', experimental: false },
  claude: { label: 'Claude', host: 'claude.ai', experimental: false },
  devin: { label: 'Devin', host: 'app.devin.ai', experimental: true },
};

function targetError(message) {
  return new Error(message);
}

export function parseTarget(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw targetError('Enter an existing conversation URL.');
  let parsed;
  try { parsed = new URL(raw.trim()); } catch { throw targetError('Enter a valid HTTPS conversation URL.'); }
  if (parsed.protocol !== 'https:') throw targetError('Conversation URLs must use HTTPS.');
  if (parsed.username || parsed.password || parsed.port) throw targetError('Conversation URLs cannot include credentials or a custom port.');
  const host = parsed.hostname.toLowerCase();
  const canonicalHost = host === 'chat.openai.com' ? 'chatgpt.com' : host;
  let provider = Object.entries(PROVIDERS).find(([, value]) => value.host === canonicalHost)?.[0];
  if (!provider) throw targetError('Use a ChatGPT, Claude, or Devin conversation URL.');
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  const patterns = {
    chatgpt: /^(?:\/g\/[A-Za-z0-9_-]+)?\/c\/[A-Za-z0-9_-]+$/,
    claude: /^\/chat\/[A-Za-z0-9_-]+$/,
    devin: /^\/sessions\/[A-Za-z0-9_-]+$/,
  };
  if (!patterns[provider].test(path)) throw targetError('Open an existing conversation first; home, share, settings, and login pages are not targets.');
  const origin = `https://${PROVIDERS[provider].host}`;
  return { url: `${origin}${path}`, origin, provider, label: PROVIDERS[provider].label, experimental: PROVIDERS[provider].experimental };
}

export function sameTarget(left, right) {
  try { return parseTarget(left).url === parseTarget(right).url; } catch { return false; }
}
