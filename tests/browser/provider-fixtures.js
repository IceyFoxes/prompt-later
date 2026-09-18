export function fixtureForNew(host, options = {}) {
  const key = host === 'kimi.com' ? 'www.kimi.com' : host === 'perplexity.ai' ? 'www.perplexity.ai' : host;
  if (!Object.hasOwn(fixtures, key)) return null;
  const config = fixtures[key];
  const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const script = `
    const options = ${json(options)};
    const host = ${json(key)};
    const editor = document.querySelector(${json(config.editorQuery)});
    const firstSend = document.querySelector(${json(config.sendQuery)});
    if (options.duplicateSend && firstSend) firstSend.parentElement.append(firstSend.cloneNode(true));
    const sends = [...document.querySelectorAll(${json(config.sendQuery)})];
    window.__sendClicks = 0;
    window.__otherClicks = 0;
    const read = () => editor?.value === undefined ? editor?.innerText || '' : editor?.value || '';
    const setText = value => { if (editor?.value === undefined) editor.innerText = value; else editor.value = value; };
    setText(options.draft || '');
    if (options.editorState === 'hidden') editor.style.display = 'none';
    if (options.editorState === 'readonly') {
      if (editor instanceof HTMLTextAreaElement) editor.readOnly = true;
      else editor.setAttribute('aria-readonly', 'true');
    }
    if (options.editorState === 'modal') {
      const dialog = document.createElement('dialog');
      dialog.setAttribute('open', '');
      editor.parentElement.insertBefore(dialog, editor);
      dialog.append(editor);
    }
    if (options.busy) {
      for (const send of sends) {
        if (host === 'www.kimi.com') {
          send.classList.add('stop', 'disabled');
          send.querySelector('svg')?.setAttribute('name', 'Stop');
        } else if (host === 'chat.qwen.ai' || host === 'chat.deepseek.com') {
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('width', '12'); rect.setAttribute('height', '12');
          send.querySelector('svg')?.replaceChildren(rect);
        } else {
          send.setAttribute('aria-label', 'Stop');
          if (host === 'gemini.google.com') send.classList.add('stop');
        }
      }
    }
    const updateSend = () => {
      const disabled = Boolean(options.disabledSend || options.busy || !read().trim());
      for (const send of sends) {
        const buttons = send instanceof HTMLButtonElement ? [send] : [...send.querySelectorAll('button')];
        if (buttons.length) buttons.forEach(button => { button.disabled = disabled; });
        else send.setAttribute('aria-disabled', String(disabled));
      }
    };
    editor?.addEventListener('input', updateSend);
    document.querySelectorAll('form').forEach(form => form.addEventListener('submit', event => event.preventDefault()));
    document.querySelectorAll('[data-fixture-other]').forEach(control => control.addEventListener('click', () => { window.__otherClicks += 1; }));
    for (const send of sends) send.addEventListener('click', event => {
      event.preventDefault();
      window.__sendClicks += 1;
      if (options.disabledSend || options.busy) return;
      if (!options.noAck) { ${config.user} }
      if (options.assistantEcho) {
        const echo = document.createElement('div');
        echo.setAttribute('data-role', 'assistant');
        echo.className = 'assistant-message prose';
        echo.textContent = read();
        document.querySelector('#messages').append(echo);
      }
      if (!options.noClear) setText('');
      editor?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    updateSend();
  `;
  return `<!doctype html><html><head><style>main{display:block;width:700px;min-height:240px;padding:24px}form{display:block;width:650px;min-height:150px}input-container,rich-textarea{display:block}.ql-editor,[contenteditable=true],textarea{display:block;width:500px;min-height:48px;border:1px solid #555;padding:12px}button{display:block;min-width:90px;min-height:30px;margin:8px}.send-button-container,.controls>div,.message-input-right-button-send{display:block;width:100px;min-height:30px}svg{width:16px;height:16px}user-query,.chat-content-item-user,.qwen-chat-message-user,.user-message{display:block;margin:10px;padding:8px;border:1px solid #aaa}</style></head><body><main>${config.editor}<div id="messages"></div></main><script>${script}</script></body></html>`;
}

const fixtures = {
  'gemini.google.com': {
    editor: '<input-container><form><rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button class="send-button" aria-label="Send message"></button></form></input-container>', editorQuery: '.ql-editor', sendQuery: '.send-button', user: "const node=document.createElement('user-query');const text=document.createElement('div');text.className='query-text';text.textContent=read();node.append(text);document.querySelector('#messages').append(node);",
  },
  'chat.deepseek.com': {
    editor: '<form><textarea id="chat-input" placeholder="Message DeepSeek"></textarea><input type="file"><div class="controls"><button type="button" data-fixture-other aria-label="Attach file">Attach</button><div class="ds-toggle-button" role="button" data-fixture-other>DeepThink</div><div class="ds-icon-button" role="button" aria-disabled="true"><svg><path d="M8 2 L2 8 H6 V14 H10 V8 H14 Z"></path></svg></div></div></form>', editorQuery: '#chat-input', sendQuery: '.ds-icon-button', user: "const node=document.createElement('div');node.className='ds-message fbb737a4';node.textContent=read();document.querySelector('#messages').append(node);",
  },
  'www.kimi.com': {
    editor: '<form class="chat-editor"><div class="chat-input-editor" role="textbox" contenteditable="true"></div><div class="send-button-container"><svg name="Send"></svg></div></form>', editorQuery: '.chat-input-editor', sendQuery: '.send-button-container', user: "const node=document.createElement('div');node.className='chat-content-item-user';const segment=document.createElement('div');segment.className='segment-user';const text=document.createElement('div');text.className='segment-content';text.textContent=read();segment.append(text);node.append(segment);document.querySelector('#messages').append(node);",
  },
  'www.perplexity.ai': {
    editor: '<form><div id="ask-input" data-lexical-editor="true" role="textbox" contenteditable="true"></div><button aria-label="Submit"></button></form>', editorQuery: '#ask-input', sendQuery: 'button[aria-label="Submit"]', user: "const node=document.createElement('div');node.className='group/query';node.textContent=read();document.querySelector('#messages').append(node);",
  },
  'copilot.microsoft.com': {
    editor: '<form><textarea id="userInput"></textarea><button aria-label="Submit"></button></form>', editorQuery: '#userInput', sendQuery: 'button[aria-label="Submit"]', user: "const node=document.createElement('div');node.dataset.content='user';node.textContent=read();document.querySelector('#messages').append(node);",
  },
  'chat.qwen.ai': {
    editor: '<form class="message-input-container"><textarea class="message-input-textarea"></textarea><div class="message-input-right-button-send"><button><svg><path d="M8 2 L2 8 H6 V14 H10 V8 H14 Z"></path></svg></button></div></form>', editorQuery: '.message-input-textarea', sendQuery: '.message-input-right-button-send', user: "const node=document.createElement('div');node.className='qwen-chat-message-user';const text=document.createElement('div');text.className='user-message-content';text.textContent=read();node.append(text);document.querySelector('#messages').append(node);",
  },
  'chat.mistral.ai': {
    editor: '<form><div class="ProseMirror" role="textbox" contenteditable="true"></div><button aria-label="Send" type="submit"></button></form>', editorQuery: '.ProseMirror', sendQuery: 'button[aria-label="Send"]', user: "const node=document.createElement('div');node.className='user-message';node.dataset.messageAuthorRole='user';const text=document.createElement('div');text.dir='auto';text.textContent=read();node.append(text);document.querySelector('#messages').append(node);",
  },
};
