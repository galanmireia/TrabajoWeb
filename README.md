# Demo: Chatbot de IA para atencion al cliente y reserva de citas

Este proyecto es el **portfolio piece** para ofrecer un servicio de automatizacion con IA
a pequenos negocios (clinicas, peluquerias, restaurantes, inmobiliarias, etc.): un chatbot
que responde preguntas frecuentes y agenda citas automaticamente.

Sirve como base para grabar un video de demo y publicar gigs en Fiverr/Upwork del tipo
"Chatbot de WhatsApp/web con IA para tu negocio".

## Que hace

- Widget de chat embebido en una landing page de un negocio de ejemplo (una clinica dental).
- El asistente responde con la informacion del negocio (horario, servicios, precios, FAQ).
- Cuando el cliente quiere reservar cita, el bot pide los datos necesarios y usa una
  herramienta (`reservar_cita`) para registrar la cita en `data/appointments.json`.
- Toda la informacion del negocio esta en `config/business.json`: para adaptar el demo a
  otro sector (peluqueria, inmobiliaria, restaurante...) solo hay que editar ese archivo,
  no el codigo.

## Como ejecutarlo

```bash
npm install
cp .env.example .env
# Edita .env y pon tu ANTHROPIC_API_KEY
npm start
```

Abre `http://localhost:3000` y prueba el chat (boton abajo a la derecha).

## Como reutilizarlo para un cliente real o para grabar el video de portfolio

1. Edita `config/business.json` con los datos del negocio (real o de ejemplo).
2. Ajusta los textos de `public/index.html` si quieres cambiar el nombre/estilo de la landing.
3. Lanza el servidor y graba una pantalla mostrando una conversacion tipica:
   - Una pregunta de FAQ (ej. "aceptais seguro medico?").
   - Una reserva de cita completa (nombre, servicio, fecha/hora).
4. Ese video es el material para los gigs de Fiverr/Upwork.

## Siguiente paso hacia la version "producto" (WhatsApp real)

Esta version usa un widget web para que el demo se pueda ensenar sin depender de
aprobaciones externas. El siguiente paso para un cliente real es conectar el mismo
endpoint `/api/chat` a la API de WhatsApp Business Cloud (Meta) en lugar del widget web,
reutilizando toda la logica del asistente y de reserva de citas tal cual esta.
