const path = require('path');
const fs = require('fs');
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const business = require('./config/business.json');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const DATA_DIR = path.join(__dirname, 'data');
const APPOINTMENTS_FILE = path.join(DATA_DIR, 'appointments.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(APPOINTMENTS_FILE)) fs.writeFileSync(APPOINTMENTS_FILE, '[]');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function buildSystemPrompt() {
  const servicios = business.servicios
    .map((s) => `- ${s.nombre}: ${s.precio} (${s.duracion})`)
    .join('\n');
  const faq = business.faq
    .map((f) => `P: ${f.pregunta}\nR: ${f.respuesta}`)
    .join('\n\n');

  return `Eres el asistente virtual de "${business.name}" (${business.sector}).
Tono: ${business.tone}.
Horario: ${business.horario}.
Direccion: ${business.direccion}.

Servicios y precios:
${servicios}

Preguntas frecuentes:
${faq}

Reglas:
- Responde siempre en espanol, en frases cortas, como si fuera un chat de WhatsApp.
- Si el usuario quiere reservar cita, pide (uno por mensaje si hace falta): nombre, servicio deseado, y fecha/hora preferida.
- En cuanto tengas nombre, servicio y fecha/hora, usa la herramienta reservar_cita para registrar la reserva. No inventes disponibilidad real, solo confirma que ha quedado registrada.
- Si preguntan algo que no esta en esta informacion, dilo con honestidad y ofrece que un humano del centro lo confirme.`;
}

const tools = [
  {
    name: 'reservar_cita',
    description: 'Registra una cita cuando el usuario ha dado nombre, servicio y fecha/hora preferida.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del cliente' },
        servicio: { type: 'string', description: 'Servicio solicitado' },
        fecha_hora: { type: 'string', description: 'Fecha y hora preferida tal como la ha dado el cliente' },
        telefono: { type: 'string', description: 'Telefono de contacto si lo ha dado' },
      },
      required: ['nombre', 'servicio', 'fecha_hora'],
    },
  },
];

function guardarCita(input) {
  const citas = JSON.parse(fs.readFileSync(APPOINTMENTS_FILE, 'utf8'));
  const cita = { ...input, creada_en: new Date().toISOString() };
  citas.push(cita);
  fs.writeFileSync(APPOINTMENTS_FILE, JSON.stringify(citas, null, 2));
  return cita;
}

// Logica compartida por el widget web y por WhatsApp: dado el historial de la
// conversacion, habla con Claude (resolviendo cualquier tool_use) y devuelve
// la respuesta final en texto junto con el historial actualizado.
async function runAssistant(messages) {
  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: buildSystemPrompt(),
    tools,
    messages,
  });

  const conversation = [...messages, { role: 'assistant', content: response.content }];

  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = toolUseBlocks.map((block) => {
      if (block.name === 'reservar_cita') {
        const cita = guardarCita(block.input);
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Cita registrada: ${cita.nombre} - ${cita.servicio} - ${cita.fecha_hora}`,
        };
      }
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: 'Herramienta desconocida',
        is_error: true,
      };
    });

    conversation.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: buildSystemPrompt(),
      tools,
      messages: conversation,
    });

    conversation.push({ role: 'assistant', content: response.content });
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  return { reply: textBlock ? textBlock.text : '', messages: conversation };
}

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages debe ser un array no vacio' });
    }

    const result = await runAssistant(messages);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error hablando con el asistente. Revisa tu ANTHROPIC_API_KEY.' });
  }
});

app.get('/api/business', (req, res) => {
  res.json(business);
});

// --- Integracion con WhatsApp (Meta Cloud API) ---
// WhatsApp no manda el historial completo en cada mensaje, asi que guardamos
// la conversacion de cada numero en memoria (se pierde si el servidor
// reinicia; suficiente para el demo, para produccion real convendria una DB).
const whatsappConversations = new Map();

app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
}

app.post('/webhook/whatsapp', async (req, res) => {
  // Responder rapido a Meta para que no reintente el envio
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const from = message.from;
    const text = message.text.body;

    const history = whatsappConversations.get(from) || [];
    history.push({ role: 'user', content: text });

    const { reply, messages } = await runAssistant(history);
    whatsappConversations.set(from, messages);

    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error('Error procesando mensaje de WhatsApp', err);
  }
});

app.listen(PORT, () => {
  console.log(`Demo de chatbot corriendo en http://localhost:${PORT}`);
});
