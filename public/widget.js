const chatToggle = document.getElementById('chat-toggle');
const chatPanel = document.getElementById('chat-panel');
const chatClose = document.getElementById('chat-close');
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');

let conversation = [];

chatToggle.addEventListener('click', () => chatPanel.classList.toggle('hidden'));
chatClose.addEventListener('click', () => chatPanel.classList.add('hidden'));

function appendMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  appendMessage('user', text);
  chatInput.value = '';
  conversation.push({ role: 'user', content: text });

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: conversation }),
    });
    const data = await res.json();
    if (data.error) {
      appendMessage('bot', 'Lo siento, ha ocurrido un error. Intentalo de nuevo en un momento.');
      return;
    }
    conversation = data.messages;
    appendMessage('bot', data.reply);
  } catch (err) {
    appendMessage('bot', 'No he podido conectar con el servidor.');
  }
});

async function loadBusinessInfo() {
  const res = await fetch('/api/business');
  const business = await res.json();

  const servicios = document.getElementById('servicios');
  business.servicios.forEach((s) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${s.nombre}</span><span>${s.precio}</span>`;
    servicios.appendChild(li);
  });

  document.getElementById('horario').textContent = `Horario: ${business.horario}`;
  document.getElementById('direccion').textContent = `Direccion: ${business.direccion}`;

  appendMessage('bot', `Hola! Soy el asistente de ${business.name}. Puedo responder tus dudas o reservarte una cita. En que puedo ayudarte?`);
}

loadBusinessInfo();
