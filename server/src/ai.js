// Cerebro de CODEC 47: llama al modelo de NVIDIA (API compatible con OpenAI) con
// herramientas para controlar dispositivos, ver el clima, gestionar pendientes, etc.
import { Device, Message, Task, User } from './models.js';
import { audit, isOnline, sendCommand } from './hub.js';
import { getWeather } from './weather.js';

const BASE = () => process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const MODEL = () => process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';

// Acciones que entiende cada tipo de dispositivo (se las explicamos al modelo)
export const ACTIONS = {
  android: {
    flashlight: '{ on: true|false } linterna',
    take_photo: '{ front?: bool } toma una foto y la guarda en la galería',
    open_camera: '{} abre la cámara',
    play_music: '{ query, app?: "youtube"|"youtube_music"|"spotify" } busca y reproduce música',
    media: '{ cmd: "play"|"pause"|"next"|"previous" } controla la música que suena',
    volume: '{ level?: 0-100, cmd?: "up"|"down"|"mute" }',
    bluetooth: '{ on?: bool } abre el panel de Bluetooth (Android no permite activarlo solo)',
    wifi: '{} abre el panel de Wi-Fi',
    add_calendar_event: '{ title, start: ISO-8601, end?: ISO-8601, description?, location? } agrega al calendario',
    list_calendar_events: '{ days?: number } eventos próximos del calendario',
    read_emails: '{ limit?: number } lee los correos recientes recibidos (desde las notificaciones)',
    read_notifications: '{ limit?: number }',
    open_app: '{ name } abre una app instalada por nombre',
    call: '{ number } inicia una llamada',
    navigate: '{ destination } abre Google Maps con navegación',
    set_alarm: '{ hour, minute, label? }',
    set_timer: '{ seconds, label? }',
    global: '{ action: "back"|"home"|"recents"|"notifications"|"quick_settings"|"lock"|"screenshot" } control del sistema',
    battery: '{} nivel de batería',
    speak: '{ text } dice el texto en voz alta',
  },
  chrome: {
    play_music: '{ query, service?: "youtube"|"youtube_music"|"spotify" } abre y reproduce música en Chrome',
    media: '{ cmd: "play"|"pause"|"next"|"previous" } controla la pestaña con audio',
    open_url: '{ url }',
    search: '{ query } busca en Google',
    list_tabs: '{}',
    close_tab: '{ match? } cierra la pestaña activa o la que contenga ese texto',
  },
  pc: {
    open_url: '{ url } abre en el navegador predeterminado',
    open_app: '{ name } abre un programa (ej. notepad, calc, spotify, code)',
    play_music: '{ query, service?: "youtube"|"spotify" }',
    media: '{ cmd: "play"|"pause"|"next"|"previous" } teclas multimedia',
    volume: '{ cmd: "up"|"down"|"mute" }',
    lock: '{} bloquea la sesión',
    status: '{} CPU, RAM, disco, uptime',
    security_scan: '{} auditoría de seguridad ahora',
    shutdown: '{ restart?: bool } solo si el agente lo permite',
    shell: '{ command } solo si el agente lo permite',
  },
  server: {
    status: '{} CPU, RAM, disco, carga, uptime',
    security_scan: '{} auditoría de seguridad ahora (puertos, SSH, firewall, intentos fallidos)',
    shell: '{ command } solo si el agente lo permite',
  },
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'device_command',
      description:
        'Ejecuta una acción en uno de los dispositivos del usuario (teléfono, Chrome, PC o servidor). ' +
        'Si el usuario no dice dónde y es una acción de teléfono, usa el dispositivo desde el que habla.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Nombre o id del dispositivo' },
          action: { type: 'string', description: 'Nombre de la acción, ej. flashlight, play_music' },
          params: { type: 'object', description: 'Parámetros de la acción' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Clima actual y pronóstico de una ciudad',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_task',
      description: 'Agrega un pendiente/recordatorio del usuario',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, due: { type: 'string', description: 'Fecha ISO-8601 opcional' } },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'Lista los pendientes del usuario',
      parameters: { type: 'object', properties: { include_done: { type: 'boolean' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_task',
      description: 'Marca un pendiente como hecho (por texto aproximado del título)',
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'server_report',
      description: 'Rendimiento y hallazgos de seguridad recientes de los servidores/PCs del usuario',
      parameters: { type: 'object', properties: { device: { type: 'string' } } },
    },
  },
];

async function callModel(messages, useTools = true) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('Falta NVIDIA_API_KEY');
  const body = { model: MODEL(), messages, temperature: 0.5, max_tokens: 2048 };
  // NVIDIA_THINKING=false: más rápido pero inventa más (no usa bien las herramientas)
  if (process.env.NVIDIA_THINKING === 'false') body.chat_template_kwargs = { enable_thinking: false };
  if (useTools) {
    body.tools = TOOLS;
    body.tool_choice = 'auto';
  }
  const res = await fetch(`${BASE()}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`NVIDIA API ${res.status}: ${t.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.choices?.[0]?.message || { role: 'assistant', content: '' };
}

function findDevice(devices, ref, fallback) {
  if (ref) {
    const r = String(ref).toLowerCase().trim();
    return (
      devices.find((d) => String(d._id) === r) ||
      devices.find((d) => d.name.toLowerCase() === r) ||
      devices.find((d) => d.name.toLowerCase().includes(r) || r.includes(d.name.toLowerCase())) ||
      devices.find((d) => d.type === r) ||
      (/(tel[eé]fono|celular|m[oó]vil|phone)/.test(r) && devices.find((d) => d.type === 'android')) ||
      (/(pc|laptop|computadora|ordenador)/.test(r) &&
        (devices.find((d) => d.type === 'chrome' && isOnline(d._id)) || devices.find((d) => d.type === 'pc'))) ||
      null
    );
  }
  return fallback || null;
}

function systemPrompt(user, devices, fromDevice) {
  const now = new Date().toLocaleString('es-MX', { timeZone: user.tz, dateStyle: 'full', timeStyle: 'short' });
  const list = devices.length
    ? devices
        .map((d) => {
          const acts = Object.keys(ACTIONS[d.type] || {}).join(', ');
          return `- "${d.name}" (id ${d._id}, tipo ${d.type}, ${isOnline(d._id) ? 'EN LÍNEA' : 'desconectado'}) acciones: ${acts}`;
        })
        .join('\n')
    : '(ninguno todavía)';
  const detail = Object.entries(ACTIONS)
    .map(([t, a]) => `${t}:\n` + Object.entries(a).map(([k, v]) => `  ${k} ${v}`).join('\n'))
    .join('\n');

  return `Eres CODEC 47, el asistente personal y amigo de ${user.name || 'el usuario'}.
Hablas español latino, cálido, cercano y con buen humor, pero vas al grano. Tus respuestas se leen en voz alta muchas veces, así que sé breve (1-3 frases) salvo que te pidan detalle. No uses markdown ni emojis en exceso.
Fecha y hora actual del usuario: ${now} (zona ${user.tz}).${user.city ? ` Ciudad del usuario: ${user.city}.` : ''}
${fromDevice ? `El usuario te habla desde: "${fromDevice.name}" (${fromDevice.type}).` : 'El usuario te habla desde la interfaz web.'}

Dispositivos del usuario:
${list}

Acciones disponibles por tipo:
${detail}

Reglas:
- Para hacer cosas en los dispositivos usa la herramienta device_command. Nunca digas que hiciste algo sin haber llamado a la herramienta y recibido ok.
- "Pon música en la PC/laptop": prefiere el dispositivo Chrome en línea; si no hay, usa el agente pc.
- Si un dispositivo está desconectado, díselo al usuario.
- Para fechas de calendario usa ISO-8601 con la zona horaria del usuario.
- Para acciones peligrosas (apagar, comandos shell) confirma antes con el usuario.
- Si no puedes hacer algo, explícalo con honestidad y sugiere una alternativa.`;
}

async function runTool(name, args, ctx) {
  const { user, devices, fromDevice, actions } = ctx;
  switch (name) {
    case 'device_command': {
      const fallback = fromDevice && fromDevice.type !== 'server' ? fromDevice : devices.find((d) => d.type === 'android');
      const dev = findDevice(devices, args.device, fallback);
      if (!dev) return { ok: false, error: 'No encontré ese dispositivo' };
      const r = await sendCommand(dev, args.action, args.params || {});
      actions.push({ device: dev.name, action: args.action, ok: r.ok });
      await audit(dev, 'command', `${args.action} ${JSON.stringify(args.params || {})} -> ${r.ok ? 'ok' : r.error}`);
      return { device: dev.name, ...r };
    }
    case 'get_weather':
      return getWeather(args.city || user.city || 'Ciudad de México');
    case 'add_task': {
      const due = args.due ? new Date(args.due) : undefined;
      const t = await Task.create({ userId: user._id, title: args.title, due: isNaN(due) ? undefined : due });
      return { ok: true, id: t._id, title: t.title, due: t.due };
    }
    case 'list_tasks': {
      const q = { userId: user._id };
      if (!args.include_done) q.done = false;
      const tasks = await Task.find(q).sort({ due: 1, createdAt: -1 }).limit(30);
      return tasks.map((t) => ({ title: t.title, due: t.due, done: t.done }));
    }
    case 'complete_task': {
      const rx = new RegExp(String(args.title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const t = await Task.findOneAndUpdate({ userId: user._id, done: false, title: rx }, { done: true }, { new: true });
      return t ? { ok: true, title: t.title } : { ok: false, error: 'No encontré ese pendiente' };
    }
    case 'server_report': {
      const list = devices.filter((d) => ['server', 'pc'].includes(d.type));
      const one = args.device ? findDevice(list, args.device) : null;
      const sel = args.device ? (one ? [one] : []) : list;
      return sel.map((d) => ({
        name: d.name,
        online: isOnline(d._id),
        lastSeen: d.lastSeen,
        metrics: d.metrics,
        security: (d.security || []).filter((f) => f.severity !== 'info').map((f) => `${f.severity}: ${f.title}`),
      }));
    }
    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

export async function chat({ userId, text, fromDevice = null }) {
  const user = await User.findById(userId);
  if (!user) throw new Error('Usuario no encontrado');
  const devices = await Device.find({ userId: user._id });
  const history = (await Message.find({ userId: user._id }).sort({ createdAt: -1 }).limit(16)).reverse();

  const messages = [
    { role: 'system', content: systemPrompt(user, devices, fromDevice) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: text },
  ];

  await Message.create({ userId: user._id, role: 'user', content: text, source: fromDevice?.name || 'web' });

  const ctx = { user, devices, fromDevice, actions: [] };
  let useTools = true;
  let reply = '';

  for (let i = 0; i < 6; i++) {
    let msg;
    try {
      msg = await callModel(messages, useTools);
    } catch (e) {
      // Algunos modelos no soportan herramientas: reintenta sin ellas
      if (useTools && e.status === 400) {
        useTools = false;
        i--;
        continue;
      }
      throw e;
    }

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      reply = (msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      break;
    }

    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try {
        args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments || {};
      } catch {}
      let result;
      try {
        result = await runTool(call.function.name, args, ctx);
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) });
    }
  }

  // Quitar markdown (las respuestas se leen en voz alta)
  reply = reply.replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '').trim();
  if (!reply) reply = ctx.actions.length ? 'Listo.' : 'Mmm, no supe qué responder. ¿Me lo repites?';
  await Message.create({ userId: user._id, role: 'assistant', content: reply, source: fromDevice?.name || 'web' });
  return { text: reply, actions: ctx.actions };
}
