export const UI_MESSAGE = 'PL_UI';

export function isUiSender(sender, extensionId) {
  if (!sender || sender.id !== extensionId || typeof sender.url !== 'string') return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === extensionId && url.pathname === '/app.html';
  } catch {
    return false;
  }
}
