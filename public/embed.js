(function () {
  var scriptEl = document.currentScript;
  var API_BASE = new URL(scriptEl.src).origin;

  var host = document.createElement('div');
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });

  var style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }',
    '.chat-widget { position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 999999; }',
    '.chat-toggle { background: #2563eb; color: white; border: none; border-radius: 999px; padding: 0.85rem 1.4rem; font-size: 0.95rem; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }',
    '.chat-panel { position: absolute; bottom: 3.5rem; right: 0; width: 320px; max-height: 460px; background: white; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.2); display: flex; flex-direction: column; overflow: hidden; }',
    '.chat-panel.hidden { display: none; }',
    '.chat-header { background: #2563eb; color: white; padding: 0.75rem 1rem; display: flex; justify-content: space-between; align-items: center; }',
    '.chat-header button { background: none; border: none; color: white; font-size: 1.2rem; cursor: pointer; line-height: 1; }',
    '.chat-messages { flex: 1; padding: 0.75rem; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem; min-height: 220px; }',
    '.msg { padding: 0.5rem 0.75rem; border-radius: 10px; max-width: 85%; font-size: 0.9rem; line-height: 1.3; }',
    '.msg.user { align-self: flex-end; background: #2563eb; color: white; }',
    '.msg.bot { align-self: flex-start; background: #e2e8f0; color: #1e293b; }',
    '.chat-form { display: flex; border-top: 1px solid #e2e8f0; }',
    '.chat-form input { flex: 1; border: none; padding: 0.75rem; font-size: 0.9rem; outline: none; }',
    '.chat-form button { border: none; background: #2563eb; color: white; padding: 0 1rem; cursor: pointer; }',
  ].join('\n');
  shadow.appendChild(style);

  var container = document.createElement('div');
  container.className = 'chat-widget';
  container.innerHTML = [
    '<button class="chat-toggle" type="button">Chat with us</button>',
    '<div class="chat-panel hidden">',
    '  <div class="chat-header">',
    '    <span>Virtual assistant</span>',
    '    <button type="button" class="chat-close">&times;</button>',
    '  </div>',
    '  <div class="chat-messages"></div>',
    '  <form class="chat-form">',
    '    <input type="text" placeholder="Type your message..." autocomplete="off" required />',
    '    <button type="submit">Send</button>',
    '  </form>',
    '</div>',
  ].join('\n');
  shadow.appendChild(container);

  var chatToggle = container.querySelector('.chat-toggle');
  var chatPanel = container.querySelector('.chat-panel');
  var chatClose = container.querySelector('.chat-close');
  var chatMessages = container.querySelector('.chat-messages');
  var chatForm = container.querySelector('.chat-form');
  var chatInput = container.querySelector('input');

  var conversation = [];

  chatToggle.addEventListener('click', function () {
    chatPanel.classList.toggle('hidden');
  });
  chatClose.addEventListener('click', function () {
    chatPanel.classList.add('hidden');
  });

  function appendMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  chatForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var text = chatInput.value.trim();
    if (!text) return;

    appendMessage('user', text);
    chatInput.value = '';
    conversation.push({ role: 'user', content: text });

    try {
      var res = await fetch(API_BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: conversation }),
      });
      var data = await res.json();
      if (data.error) {
        appendMessage('bot', 'Sorry, something went wrong. Please try again in a moment.');
        return;
      }
      conversation = data.messages;
      appendMessage('bot', data.reply);
    } catch (err) {
      appendMessage('bot', 'I couldn\'t connect to the server.');
    }
  });

  fetch(API_BASE + '/api/business')
    .then(function (res) { return res.json(); })
    .then(function (business) {
      appendMessage('bot', 'Hi! I\'m the assistant for ' + business.name + '. I can answer your questions or book an appointment for you. How can I help?');
    });
})();
