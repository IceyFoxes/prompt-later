import { PROVIDERS, providerForHost } from './providers.js';

export { PROVIDERS, providerForHost };

function targetError(message) {
  return new Error(message);
}

export function parseTarget(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw targetError('Enter an existing conversation URL.');
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw targetError('Enter a valid HTTPS conversation URL.');
  }
  if (parsed.protocol !== 'https:') throw targetError('Conversation URLs must use HTTPS.');
  if (parsed.username || parsed.password || parsed.port) throw targetError('Conversation URLs cannot include credentials or a custom port.');
  const host = parsed.hostname.toLowerCase();
  const canonicalHost = host === 'chat.openai.com' ? 'chatgpt.com' : host;
  const provider = providerForHost(canonicalHost);
  if (!provider) {
    const labels = Object.values(PROVIDERS).map(config => config.label).join(', ');
    throw targetError(`Use an existing conversation URL from a supported provider: ${labels}.`);
  }
  const config = PROVIDERS[provider];
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  const finalSegment = path.split('/').filter(Boolean).at(-1)?.toLowerCase();
  if (config.enhanced && new Set(['new', 'new-chat', 'new_chat', 'history', 'share', 'settings', 'login', 'auth']).has(finalSegment)) {
    throw targetError('Open an existing conversation first; home, share, settings, and login pages are not targets.');
  }
  if (!config.pathPattern.test(path)) {
    throw targetError('Open an existing conversation first; home, share, settings, and login pages are not targets.');
  }
  const origin = `https://${canonicalHost}`;
  const query = new URLSearchParams();
  for (const key of config.accountQuery || []) {
    const values = parsed.searchParams.getAll(key);
    if (values.length > 1 || (values.length && !values[0].trim())) {
      throw targetError('Use one explicit account selector in the conversation URL.');
    }
    if (values.length) query.set(key, values[0]);
  }
  for (const [key, value] of Object.entries(config.navigationQuery || {})) query.set(key, value);
  const suffix = query.toString() ? `?${query}` : '';
  return {
    url: `${origin}${path}${suffix}`,
    origin,
    provider,
    label: config.label,
    experimental: config.experimental,
  };
}

export function sameTarget(left, right) {
  try {
    return parseTarget(left).url === parseTarget(right).url;
  } catch {
    return false;
  }
}
