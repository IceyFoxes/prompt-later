export const PROVIDERS = {
  chatgpt: {
    label: 'ChatGPT',
    host: 'chatgpt.com',
    experimental: false,
    pathPattern: /^(?:\/g\/[A-Za-z0-9_-]+)?\/c\/[A-Za-z0-9_-]+$/,
    selectors: {
      editors: ['#prompt-textarea', '[data-testid="composer-text-input"]'],
      sends: [
        'button[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send message"]',
        'button[aria-label="Send"]',
      ],
      users: ['[data-message-author-role="user"]'],
    },
  },
  claude: {
    label: 'Claude',
    host: 'claude.ai',
    experimental: false,
    pathPattern: /^\/chat\/[A-Za-z0-9_-]+$/,
    selectors: {
      editors: [
        '[data-testid="chat-input"][contenteditable="true"]',
        '[data-testid="composer"] [contenteditable="true"]',
        '.ProseMirror[contenteditable="true"]',
        '[role="textbox"][contenteditable="true"]',
      ],
      sends: [
        'button[aria-label="Send message"]',
        'button[aria-label="Send Message"]',
        'button[data-testid="send-button"]',
      ],
      users: ['[data-testid="user-message"]', '[data-testid="user-message-content"]'],
    },
  },
  devin: {
    label: 'Devin',
    host: 'app.devin.ai',
    experimental: true,
    pathPattern: /^\/sessions\/[A-Za-z0-9_-]+$/,
    selectors: {
      editors: [
        'textarea[placeholder*="Devin" i]',
        '[role="textbox"][contenteditable="true"]',
        'main textarea',
      ],
      sends: [
        'button[data-testid="send-message-button"]',
        'button[aria-label="Send message"]',
        'button[aria-label="Send"]',
      ],
      users: ['[data-message-role="user"]', '[data-role="user"]', '[data-testid="user-message"]'],
    },
  },
  gemini: {
    label: 'Gemini',
    host: 'gemini.google.com',
    experimental: true,
    pathPattern: /^(?:\/u\/\d+)?\/app\/[A-Za-z0-9_-]{8,128}$/,
    enhanced: true,
    accountQuery: ['authuser'],
    composerScopes: 'input-container, .input-area-container, .input-area, form',
    selectors: {
      editors: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"][role="textbox"]'],
      sends: ['button.send-button', 'button[aria-label="Send message"]', 'button[aria-label="Send"]'],
      users: ['user-query', '[data-message-author="user"]'],
    },
    userTextSelector: '.query-text',
    busySelectors: ['button.send-button.stop', 'button[aria-label="Stop response"]', 'button[aria-label="停止回答"]'],
  },
  deepseek: {
    label: 'DeepSeek',
    host: 'chat.deepseek.com',
    experimental: true,
    pathPattern: /^\/a\/chat\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    enhanced: true,
    composerScopes: 'form',
    selectors: {
      editors: ['textarea#chat-input', 'textarea[placeholder*="DeepSeek" i]'],
      sends: ['[role="button"][aria-label="Send message"]', '[role="button"][aria-label="Send"]', '[role="button"][aria-label="发送"]', 'button[data-testid="send-button"]', 'input[type="file"] ~ div > div[role="button"]:not(.ds-toggle-button):has(svg):not(:has(svg rect))'],
      users: ['[data-message-author-role="user"]', '[data-role="user"]', '[data-author="user"]', '.fbb737a4'],
    },
    busySelectors: ['input[type="file"] ~ div > div[role="button"]:has(svg rect)', '[role="button"][aria-label="停止生成"]'],
  },
  kimi: {
    label: 'Kimi',
    host: 'www.kimi.com',
    additionalHosts: ['kimi.com'],
    experimental: true,
    pathPattern: /^\/chat\/[A-Za-z0-9_-]{8,128}$/,
    enhanced: true,
    navigationQuery: { chat_enter_method: 'history' },
    composerScopes: '.chat-editor, .chat-input, .chat-input-container, .chat-input-area, form',
    selectors: {
      editors: ['.chat-input-editor[contenteditable="true"]', '[data-lexical-editor="true"][contenteditable="true"]', '[role="textbox"][contenteditable="true"]'],
      sends: ['.send-button-container:has(svg[name="Send"])', 'button[aria-label="Send message"]'],
      users: ['.chat-content-item-user', '.segment-user'],
    },
    userTextSelector: '.segment-content, .ext-text',
    busySelectors: ['.send-button-container.stop', 'svg[name="Stop"]'],
  },
  perplexity: {
    label: 'Perplexity',
    host: 'www.perplexity.ai',
    additionalHosts: ['perplexity.ai'],
    experimental: true,
    pathPattern: /^\/search\/[A-Za-z0-9_.-]{8,512}$/,
    enhanced: true,
    composerScopes: 'form',
    selectors: {
      editors: ['#ask-input[contenteditable="true"]', 'textarea#ask-input', '[data-lexical-editor="true"][contenteditable="true"][role="textbox"]'],
      sends: ['button[aria-label="Submit"]', 'button[aria-label="Send"]', 'button[aria-label="Send message"]'],
      users: ['[class~="group/query"]', '[data-testid="user-message"]', '[data-role="user"]'],
    },
    busySelectors: ['button[aria-label="Stop"]', 'button[aria-label="Stop generating"]'],
  },
  copilot: {
    label: 'Microsoft Copilot',
    host: 'copilot.microsoft.com',
    experimental: true,
    pathPattern: /^\/chats\/[A-Za-z0-9_-]{8,128}$/,
    enhanced: true,
    composerScopes: 'form',
    selectors: {
      editors: ['textarea#userInput', 'textarea[data-testid="composer-input"]'],
      sends: ['button[aria-label="Submit"]', 'button[aria-label="Send message"]', 'button[aria-label="Send"]'],
      users: ['[data-content="user"]', '[data-testid="user-message"]', '.user-turn'],
    },
    busySelectors: ['button[aria-label="Stop"]', 'button[aria-label="Stop responding"]'],
  },
  qwen: {
    label: 'Qwen',
    host: 'chat.qwen.ai',
    experimental: true,
    pathPattern: /^\/c\/[A-Za-z0-9_-]{8,128}$/,
    enhanced: true,
    composerScopes: '.message-input-container, .prompt-input-container, form',
    selectors: {
      editors: ['textarea.message-input-textarea', 'textarea#chat-input'],
      sends: ['.message-input-right-button-send button', '.message-input-right-button-send', 'button#send-message-button', '.chat-prompt-send-button .send-button'],
      users: ['.qwen-chat-message-user', '.user-message-content', '[data-role="user"]'],
    },
    userTextSelector: '.user-message-content',
    busySelectors: ['.chat-prompt-send-button .stop-button', '.message-input-right-button-send:has(svg rect)', 'button[aria-label="Stop"]'],
  },
  mistral: {
    label: 'Mistral Le Chat',
    host: 'chat.mistral.ai',
    experimental: true,
    pathPattern: /^\/chat\/[A-Za-z0-9_-]{8,128}$/,
    enhanced: true,
    composerScopes: 'form',
    selectors: {
      editors: ['.ProseMirror[contenteditable="true"]', '[role="textbox"][contenteditable="true"]'],
      sends: ['button[aria-label="Send"]', 'button[aria-label="Send message"]', 'button[type="submit"]'],
      users: ['[data-message-author-role="user"]', '[data-role="user"]', '.user-message'],
    },
    userTextSelector: '[dir="auto"]',
    busySelectors: ['button[aria-label="Stop"]', 'button[aria-label="Stop generation"]'],
  },
};

export function providerForHost(host) {
  if (typeof host !== 'string') return null;
  const normalized = host.toLowerCase() === 'chat.openai.com' ? 'chatgpt.com' : host.toLowerCase();
  return Object.entries(PROVIDERS).find(([, config]) => config.host === normalized || config.additionalHosts?.includes(normalized))?.[0] || null;
}

export function providerLabel(id) {
  const config = Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
  return config ? `${config.label}${config.experimental ? ' (experimental)' : ''}` : 'Unknown provider';
}

export function optionalHostPermissions() {
  return [...new Set(Object.values(PROVIDERS).flatMap(config => [config.host, ...(config.additionalHosts || [])]))]
    .map(host => `https://${host}/*`);
}
