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
        <p style="margin:0;color:#bfdbfe;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;">Nueva reserva</p>
        <p style="margin:4px 0 0;color:#ffffff;font-size:20px;font-weight:700;">${escapeHtml(business.name)}</p>
      </div>
      <div style="padding:24px 28px;">
        <table style="width:100%;border-collapse:collapse;">
          ${fila('Cliente', cita.nombre)}
          ${fila('Servicio', cita.servicio)}
          ${fila('Fecha/hora', cita.fecha_hora)}
          ${fila('Telefono', cita.telefono || 'no proporcionado')}
        </table>
      </div>
      <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;">
        <p style="margin:0;color:#94a3b8;font-size:12px;">Aviso automatico generado por tu asistente de IA. Consulta todas las reservas en tu panel de citas.</p>
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
      subject: `Nueva reserva: ${cita.nombre} - ${cita.fecha_hora}`,
      text: `Se ha registrado una nueva cita.\n\nNombre: ${cita.nombre}\nServicio: ${cita.servicio}\nFecha/hora: ${cita.fecha_hora}\nTelefono: ${cita.telefono || 'no proporcionado'}`,
      html: buildEmailHtml(cita),
    });
  } catch (err) {
    console.error('Error enviando email de aviso', err);
  }
}

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
  const hoy = new Date().toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return `Eres el asistente virtual de "${business.name}" (${business.sector}).
Tono: ${business.tone}.
Horario: ${business.horario}.
Direccion: ${business.direccion}.
Hoy es ${hoy}. Usa esta fecha para calcular a que dia se refiere el cliente cuando dice "hoy", "manana", "el jueves", etc.

Servicios y precios:
${servicios}

Preguntas frecuentes:
${faq}

Reglas:
- Responde siempre en espanol, en frases cortas, como si fuera un chat de WhatsApp.
- Si el usuario quiere reservar cita, pide (uno por mensaje si hace falta): nombre, servicio deseado, y fecha/hora preferida. Convierte "manana", "el jueves", etc. a una fecha concreta antes de llamar a la herramienta.
- En cuanto tengas nombre, servicio y fecha/hora, usa la herramienta reservar_cita para intentar registrar la reserva.
- Si la herramienta responde que ese horario ya esta ocupado, dilo con naturalidad y pide al cliente otra fecha/hora alternativa. No confirmes nunca una cita que la herramienta no haya registrado con exito.
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
function horarioOcupado(fechaHora) {
  const citas = leerCitas();
  return citas.some((c) => normalizar(c.fecha_hora) === normalizar(fechaHora));
}

function guardarCita(input) {
  const citas = leerCitas();
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
        if (horarioOcupado(block.input.fecha_hora)) {
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Ese horario (${block.input.fecha_hora}) ya esta ocupado por otra cita. Pide al cliente una fecha/hora alternativa.`,
            is_error: true,
          };
        }
        const cita = guardarCita(block.input);
        avisarPorEmail(cita); // no bloqueante: un fallo de email no debe romper la reserva
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

// Vista simple para que el dueno del negocio (o nosotros, en el demo) pueda
// ver las citas registradas. Protegida con una palabra secreta por URL para
// no dejar los datos de clientes totalmente publicos.
app.get('/admin/citas', (req, res) => {
  if (req.query.clave !== process.env.ADMIN_SECRET) {
    return res.status(403).send('Acceso denegado. Anade ?clave=TU_ADMIN_SECRET a la URL.');
  }

  const citas = leerCitas().slice().reverse();
  const inicioHoy = new Date();
  inicioHoy.setHours(0, 0, 0, 0);
  const citasHoy = citas.filter((c) => new Date(c.creada_en) >= inicioHoy).length;
  const ultimaCita = citas[0] ? new Date(citas[0].creada_en).toLocaleString('es-ES') : '-';

  const filas = citas.length
    ? citas
        .map(
          (c, i) => `<tr style="background:${i % 2 === 0 ? '#ffffff' : '#f8fafc'};">
            <td style="padding:12px 16px;font-weight:600;color:#0f172a;">${escapeHtml(c.nombre)}</td>
            <td style="padding:12px 16px;color:#334155;">${escapeHtml(c.servicio)}</td>
            <td style="padding:12px 16px;color:#334155;">${escapeHtml(c.fecha_hora)}</td>
            <td style="padding:12px 16px;color:#334155;">${escapeHtml(c.telefono || '-')}</td>
            <td style="padding:12px 16px;color:#94a3b8;font-size:13px;">${new Date(c.creada_en).toLocaleString('es-ES')}</td>
          </tr>`
        )
        .join('')
    : `<tr><td colspan="5" style="padding:32px;text-align:center;color:#94a3b8;">Todavia no hay ninguna reserva registrada.</td></tr>`;

  res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reservas - ${escapeHtml(business.name)}</title>
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
    <p class="eyebrow">Panel de reservas</p>
    <h1>${escapeHtml(business.name)}</h1>
  </header>
  <div class="wrap">
    <div class="stats">
      <div class="stat"><div class="num">${citas.length}</div><div class="label">Reservas totales</div></div>
      <div class="stat"><div class="num">${citasHoy}</div><div class="label">Registradas hoy</div></div>
      <div class="stat"><div class="num" style="font-size:1.1rem;">${ultimaCita}</div><div class="label">Ultima reserva</div></div>
    </div>
    <div class="card">
      <div class="scroll">
        <table>
          <thead><tr><th>Nombre</th><th>Servicio</th><th>Fecha/hora</th><th>Telefono</th><th>Registrada el</th></tr></thead>
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
