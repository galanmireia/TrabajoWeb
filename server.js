const path = require('path');
const fs = require('fs');
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');

const business = require('./config/business.json');

// Usamos Resend (email por API HTTPS) en vez de SMTP directo: Railway (como
// la mayoria de plataformas cloud) bloquea las conexiones SMTP salientes,
// asi que un envio por Gmail/SMTP normal nunca llegaria desde aqui.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function escapeHtml(valor) {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Email en HTML con estilos en linea (asi se ve bien en Gmail/Outlook, que
// ignoran las hojas de estilo externas). Se manda junto a una version en
// texto plano para los pocos clientes que no rendericen HTML.
function buildEmailHtml(cita) {
  const fila = (etiqueta, valor) => `
    <tr>
      <td style="padding:10px 0;color:#64748b;font-size:14px;width:120px;">${etiqueta}</td>
      <td style="padding:10px 0;color:#0f172a;font-size:15px;font-weight:600;">${escapeHtml(valor)}</td>
    </tr>`;

  return `<div style="background:#f1f5f9;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(15,23,42,0.08);">
      <div style="background:#2563eb;padding:24px 28px;">
        <p style="margin:0;color:#bfdbfe;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;">New booking</p>
        <p style="margin:4px 0 0;color:#ffffff;font-size:20px;font-weight:700;">${escapeHtml(business.name)}</p>
      </div>
      <div style="padding:24px 28px;">
        <table style="width:100%;border-collapse:collapse;">
          ${fila('Customer', cita.name)}
          ${fila('Service', cita.service)}
          ${fila('Date/time', cita.date_time)}
          ${fila('Phone', cita.phone || 'not provided')}
        </table>
      </div>
      <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;">
        <p style="margin:0;color:#94a3b8;font-size:12px;">Automatic notification from your AI assistant. See all bookings in your appointments dashboard.</p>
      </div>
    </div>
  </div>`;
}

// Avisa al dueno del negocio por email de que ha entrado una reserva nueva.
// Si no hay credenciales de email configuradas (o no hay direccion de aviso
// en config/business.json), simplemente no hace nada: el email es un extra,
// nunca debe romper la reserva en si.
async function avisarPorEmail(cita) {
  if (!resend || !business.email_notificaciones) return;

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
      to: business.email_notificaciones,
      subject: `New booking: ${cita.name} - ${cita.date_time}`,
      text: `A new appointment has been booked.\n\nName: ${cita.name}\nService: ${cita.service}\nDate/time: ${cita.date_time}\nPhone: ${cita.phone || 'not provided'}`,
      html: buildEmailHtml(cita),
    });
  } catch (err) {
    console.error('Error enviando email de aviso', err);
  }
}

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
// En Railway, DATA_DIR apunta a un volumen persistente (ver README) para que
// las reservas sobrevivan a los redespliegues. Sin esa variable, cae en una
// carpeta local normal, util para desarrollo.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
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
    .map((f) => `Q: ${f.pregunta}\nA: ${f.respuesta}`)
    .join('\n\n');
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return `You are the virtual assistant for "${business.name}" (${business.sector}).
Tone: ${business.tone}.
Hours: ${business.horario}.
Address: ${business.direccion}.
Today is ${today}. Use this date to work out what day the customer means when they say "today", "tomorrow", "next Thursday", etc.

Services and prices:
${servicios}

Frequently asked questions:
${faq}

Rules:
- Always reply in English, in short sentences, like a WhatsApp chat.
- If the customer wants to book an appointment, ask (one per message if needed) for: name, desired service, and preferred date/time. Convert "tomorrow", "next Thursday", etc. into a specific date before calling the tool.
- As soon as you have name, service and date/time, use the book_appointment tool to try to register the booking.
- If the tool says that time slot is already taken, say so naturally and ask the customer for an alternative date/time. Never confirm an appointment the tool hasn't successfully registered.
- If asked something not covered by this information, say so honestly and offer to have a staff member confirm it.`;
}

const tools = [
  {
    name: 'book_appointment',
    description: 'Books an appointment once the customer has given a name, service and preferred date/time.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Customer name' },
        service: { type: 'string', description: 'Requested service' },
        date_time: { type: 'string', description: 'Preferred date and time, as given by the customer' },
        phone: { type: 'string', description: 'Contact phone number, if provided' },
      },
      required: ['name', 'service', 'date_time'],
    },
  },
];

function leerCitas() {
  return JSON.parse(fs.readFileSync(APPOINTMENTS_FILE, 'utf8'));
}

function normalizar(texto) {
  return texto.trim().toLowerCase();
}

// Comprobacion sencilla: si ya existe una cita guardada con la misma
// fecha/hora (comparando el texto tal cual), se considera ocupada. No es un
// calendario real con duraciones ni huecos, pero evita el caso mas obvio: dos
// reservas exactamente a la misma hora.
function horarioOcupado(dateTime) {
  const citas = leerCitas();
  return citas.some((c) => normalizar(c.date_time) === normalizar(dateTime));
}

function guardarCita(input) {
  const citas = leerCitas();
  const cita = { ...input, created_at: new Date().toISOString() };
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
      if (block.name === 'book_appointment') {
        if (horarioOcupado(block.input.date_time)) {
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: `That time slot (${block.input.date_time}) is already booked. Ask the customer for an alternative date/time.`,
            is_error: true,
          };
        }
        const cita = guardarCita(block.input);
        avisarPorEmail(cita); // fire-and-forget: an email failure should never break the booking
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Appointment booked: ${cita.name} - ${cita.service} - ${cita.date_time}`,
        };
      }
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: 'Unknown tool',
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
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }

    const result = await runAssistant(messages);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error talking to the assistant. Check your ANTHROPIC_API_KEY.' });
  }
});

app.get('/api/business', (req, res) => {
  res.json(business);
});

// Borra todas las reservas guardadas. Util para limpiar datos de prueba
// (como los antiguos registros con campos en espanol) antes de grabar el
// video o de entregar el proyecto a un cliente real.
app.get('/admin/reset', (req, res) => {
  if (req.query.clave !== process.env.ADMIN_SECRET) {
    return res.status(403).send('Access denied. Add ?clave=YOUR_ADMIN_SECRET to the URL.');
  }

  fs.writeFileSync(APPOINTMENTS_FILE, '[]');
  res.send('All bookings cleared. <a href="/admin/citas?clave=' + encodeURIComponent(req.query.clave) + '">View dashboard</a>');
});

// Vista simple para que el dueno del negocio (o nosotros, en el demo) pueda
// ver las citas registradas. Protegida con una palabra secreta por URL para
// no dejar los datos de clientes totalmente publicos.
app.get('/admin/citas', (req, res) => {
  if (req.query.clave !== process.env.ADMIN_SECRET) {
    return res.status(403).send('Access denied. Add ?clave=YOUR_ADMIN_SECRET to the URL.');
  }

  const citas = leerCitas().slice().reverse();
  const inicioHoy = new Date();
  inicioHoy.setHours(0, 0, 0, 0);
  const citasHoy = citas.filter((c) => new Date(c.created_at) >= inicioHoy).length;
  const ultimaCita = citas[0] ? new Date(citas[0].created_at).toLocaleString('en-US') : '-';

  const filas = citas.length
    ? citas
        .map(
          (c, i) => `<tr style="background:${i % 2 === 0 ? '#ffffff' : '#f8fafc'};">
            <td style="padding:12px 16px;font-weight:600;color:#0f172a;">${escapeHtml(c.name)}</td>
            <td style="padding:12px 16px;color:#334155;">${escapeHtml(c.service)}</td>
            <td style="padding:12px 16px;color:#334155;">${escapeHtml(c.date_time)}</td>
            <td style="padding:12px 16px;color:#334155;">${escapeHtml(c.phone || '-')}</td>
            <td style="padding:12px 16px;color:#94a3b8;font-size:13px;">${new Date(c.created_at).toLocaleString('en-US')}</td>
          </tr>`
        )
        .join('')
    : `<tr><td colspan="5" style="padding:32px;text-align:center;color:#94a3b8;">No bookings yet.</td></tr>`;

  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bookings - ${escapeHtml(business.name)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; margin: 0; background: #f1f5f9; color: #0f172a; }
    header { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; padding: 2.5rem 2rem 3.5rem; }
    header p.eyebrow { margin: 0; text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.75rem; color: #bfdbfe; }
    header h1 { margin: 0.35rem 0 0; font-size: 1.75rem; }
    .wrap { max-width: 960px; margin: -2.5rem auto 3rem; padding: 0 1.5rem; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .stat { background: white; border-radius: 12px; padding: 1.25rem 1.5rem; box-shadow: 0 4px 16px rgba(15,23,42,0.06); }
    .stat .num { font-size: 1.75rem; font-weight: 700; color: #2563eb; }
    .stat .label { font-size: 0.85rem; color: #64748b; margin-top: 0.25rem; }
    .card { background: white; border-radius: 12px; box-shadow: 0 4px 16px rgba(15,23,42,0.06); overflow: hidden; }
    table { border-collapse: collapse; width: 100%; }
    th { text-align: left; padding: 12px 16px; background: #eff6ff; color: #1e40af; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .scroll { overflow-x: auto; }
  </style>
</head>
<body>
  <header>
    <p class="eyebrow">Bookings dashboard</p>
    <h1>${escapeHtml(business.name)}</h1>
  </header>
  <div class="wrap">
    <div class="stats">
      <div class="stat"><div class="num">${citas.length}</div><div class="label">Total bookings</div></div>
      <div class="stat"><div class="num">${citasHoy}</div><div class="label">Booked today</div></div>
      <div class="stat"><div class="num" style="font-size:1.1rem;">${ultimaCita}</div><div class="label">Latest booking</div></div>
    </div>
    <div class="card">
      <div class="scroll">
        <table>
          <thead><tr><th>Name</th><th>Service</th><th>Date/time</th><th>Phone</th><th>Booked on</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
    </div>
  </div>
</body>
</html>`);
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

// Diagnostico/reparacion: a veces la cuenta de WhatsApp Business se
// "desuscribe" de la app (p.ej. tras cambiar roles/permisos en Meta) y deja
// de reenviar mensajes al webhook aunque este siga marcado como suscrito en
// la app. Esto vuelve a suscribirla explicitamente.
app.get('/admin/whatsapp/resubscribe', async (req, res) => {
  if (req.query.clave !== process.env.ADMIN_SECRET) {
    return res.status(403).send('Access denied. Add ?clave=YOUR_ADMIN_SECRET to the URL.');
  }

  try {
    const wabaId = process.env.WHATSAPP_WABA_ID;
    const token = process.env.WHATSAPP_TOKEN;
    const result = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await result.text();
    res.status(result.status).send(`Status ${result.status}: ${body}`);
  } catch (err) {
    res.status(500).send(String(err));
  }
});

async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
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

  if (!res.ok) {
    const body = await res.text();
    console.error(`WhatsApp send failed (${res.status}):`, body);
  }
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
