// Cerebro de CODEC 47: modelos de NVIDIA (API compatible con OpenAI) + herramientas para
// controlar dispositivos, clima, pendientes, servidores, Wikipedia y WhatsApp.
import { Device, Message, Task, User } from './models.js';
import { audit, isOnline, sendCommand } from './hub.js';
import { getWeather } from './weather.js';
import { findYouTube, wikipedia } from './search.js';
import { waRecent, waSendImage, waSendLocation, waSendText, waStatus } from './whatsapp.js';

const BASE = () => process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
// Modelo principal y de respaldo (si uno falla o lo retiran, se usa el siguiente)
const MODELS = () =>
  [
    process.env.AI_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b',
    ...(process.env.AI_FALLBACK_MODELS || 'nvidia/nemotron-3.5-super-vl-120b-a12b,nvidia/nemotron-3.5-lightning-30b-a3b').split(','),
  ]
    .map((m) => m.trim())
    .filter((m, i, a) => m && a.indexOf(m) === i);

// Acciones que entiende cada tipo de dispositivo (se las explicamos al modelo)
export const ACTIONS = {
  android: {
    flashlight: '{ on: true|false } linterna',
    take_photo: '{ front?: bool } toma una foto y la guarda en la galería',
    open_camera: '{} abre la cámara',
    play_music: '{ query: "artista, canción o género", app?: "youtube"|"youtube_music"|"spotify" } busca y REPRODUCE música',
    media: '{ cmd: "play"|"pause"|"next"|"previous" } controla la música que ya suena',
    volume: '{ level?: 0-100, cmd?: "up"|"down"|"mute" }',
    bluetooth: '{} abre el ajuste de Bluetooth (Android no deja activarlo solo)',
    wifi: '{} abre el panel de Wi-Fi',
    add_calendar_event: '{ title, start: ISO-8601, end?: ISO-8601, description?, location? }',
    list_calendar_events: '{ days?: number }',
    read_emails: '{ limit?: number } correos recientes (desde las notificaciones)',
    read_notifications: '{ limit?: number }',
    open_app: '{ name } abre una app instalada',
    call: '{ number }',
    navigate: '{ destination } Google Maps',
    set_alarm: '{ hour, minute, label? }',
    set_timer: '{ seconds, label? }',
    global: '{ action: "back"|"home"|"recents"|"notifications"|"quick_settings"|"lock"|"screenshot" }',
    battery: '{}',
    get_location: '{} ubicación GPS actual',
  },
  chrome: {
    play_music: '{ query, service?: "youtube"|"youtube_music"|"spotify" } abre y REPRODUCE música en Chrome',
    media: '{ cmd: "play"|"pause"|"next"|"previous" }',
    open_url: '{ url }',
    search: '{ query } busca en Google',
    list_tabs: '{}',
    close_tab: '{ match? }',
  },
  pc: {
    open_url: '{ url }',
    open_app: '{ name } (ej. notepad, calc, spotify, code)',
    play_music: '{ query, service?: "youtube"|"spotify" }',
    media: '{ cmd: "play"|"pause"|"next"|"previous" }',
    volume: '{ cmd: "up"|"down"|"mute" }',
    lock: '{}',
    status: '{} CPU, RAM, disco',
    security_scan: '{}',
    shutdown: '{ restart?: bool } solo si el agente lo permite',
    shell: '{ command } solo si el agente lo permite',
  },
  server: {
    status: '{} CPU, RAM, disco, carga',
    security_scan: '{} auditoría de seguridad',
    shell: '{ command } solo si el agente lo permite',
  },
};

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const S = (description) => ({ type: 'string', description });

const TOOLS = [
  fn(
    'device_command',
    'Ejecuta una acción en un dispositivo del usuario (teléfono, Chrome, PC o servidor). Si no dice dónde y es acción de teléfono, usa el dispositivo desde el que habla.',
    { device: S('Nombre o id del dispositivo'), action: S('Acción, ej. flashlight, play_music'), params: { type: 'object', description: 'Parámetros de la acción' } },
    ['action']
  ),
  fn('get_weather', 'Clima actual y pronóstico de 3 días de una ciudad', { city: S('Ciudad') }),
  fn('search_knowledge', 'Busca en Wikipedia datos de personas, lugares, historia, ciencia o hechos que quieras verificar', { query: S('Qué buscar') }, ['query']),
  fn('add_task', 'Agrega un pendiente/recordatorio', { title: S('Título'), due: S('Fecha ISO-8601 opcional') }, ['title']),
  fn('list_tasks', 'Lista los pendientes', { include_done: { type: 'boolean' } }),
  fn('complete_task', 'Marca un pendiente como hecho', { title: S('Texto aproximado del título') }, ['title']),
  fn('server_report', 'Rendimiento y seguridad de los servidores/PCs', { device: S('Opcional') }),
  fn('whatsapp_send', 'Envía un mensaje de WhatsApp', { to: S('Nombre del contacto o número con código de país'), text: S('Mensaje') }, ['to', 'text']),
  fn('whatsapp_send_location', 'Envía por WhatsApp la ubicación actual del teléfono del usuario', { to: S('Contacto o número') }, ['to']),
  fn(
    'whatsapp_send_photo',
    'Envía por WhatsApp una foto: la última de la galería del teléfono o una nueva tomada ahora',
    { to: S('Contacto o número'), source: { type: 'string', enum: ['last', 'new'] }, caption: S('Texto opcional'), front: { type: 'boolean' } },
    ['to']
  ),
  fn('whatsapp_read', 'Lee los mensajes de WhatsApp recibidos recientemente', { from: S('Filtrar por contacto (opcional)'), limit: { type: 'number' } }),
  fn(
    'whatsapp_privacy',
    'Activa/desactiva el modo privacidad (CODEC 47 responde los WhatsApp por el usuario) y define a quién responder',
    {
      on: { type: 'boolean' },
      reply_all: { type: 'boolean', description: 'true = responder a todos' },
      allow: { type: 'array', items: { type: 'string' }, description: 'Contactos a los que sí responder' },
      instructions: S('Qué decir, ej. "estoy en una reunión hasta las 5"'),
    }
  ),
];

async function callModel(messages, useTools = true, maxTokens = 1500, models = MODELS(), timeoutMs = 25_000) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('Falta NVIDIA_API_KEY');
  let lastErr;
  for (const model of models) {
    const body = { model, messages, temperature: 0.4, max_tokens: maxTokens };
    if (process.env.AI_THINKING !== 'true') body.chat_template_kwargs = { enable_thinking: false };
    if (useTools) {
      body.tools = TOOLS;
      body.tool_choice = 'auto';
    }
    try {
      const res = await fetch(`${BASE()}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const t = await res.text();
        const err = new Error(`NVIDIA API ${res.status} (${model}): ${t.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return data.choices?.[0]?.message || { role: 'assistant', content: '' };
    } catch (e) {
      lastErr = e;
      if (e.status === 400 && useTools) throw e; // problema con herramientas: lo maneja chat()
      console.warn('[ai] modelo falló, probando el siguiente:', e.message);
    }
  }
  throw lastErr;
}

function findDevice(devices, ref, fallback) {
  if (ref) {
    const r = String(ref).toLowerCase().replace(/\(.*\)/, '').trim();
    return (
      devices.find((d) => String(d._id) === r) ||
      devices.find((d) => d.name.toLowerCase() === r) ||
      devices.find((d) => d.name.toLowerCase().includes(r) || r.includes(d.name.toLowerCase())) ||
      devices.find((d) => d.type === r) ||
      (/(tel[eé]fono|celular|m[oó]vil|phone|android)/.test(r) && devices.find((d) => d.type === 'android')) ||
      (/(pc|laptop|computadora|ordenador|chrome|navegador)/.test(r) &&
        (devices.find((d) => d.type === 'chrome' && isOnline(d._id)) || devices.find((d) => d.type === 'pc'))) ||
      null
    );
  }
  return fallback || null;
}

function systemPrompt(user, devices, fromDevice) {
  const now = new Date().toLocaleString('es-PE', { timeZone: user.tz, dateStyle: 'full', timeStyle: 'short' });
  const list = devices.length
    ? devices
        .map((d) => `- "${d.name}" (tipo ${d.type}, ${isOnline(d._id) ? 'EN LÍNEA' : 'desconectado'})`)
        .join('\n')
    : '(ninguno todavía)';
  const detail = Object.entries(ACTIONS)
    .map(([t, a]) => `${t}:\n` + Object.entries(a).map(([k, v]) => `  ${k} ${v}`).join('\n'))
    .join('\n');
  const wa = waStatus(user._id);

  return `Eres CODEC 47, la inteligencia artificial personal de ${user.name || 'tu usuario'}, al estilo de JARVIS de Iron Man: brillante, elegante, leal, seguro y con un humor fino y sutil. Tu voz es masculina. Llamas al usuario por su nombre y, de vez en cuando, "señor".

CONOCIMIENTO: eres un experto en cultura general, historia, ciencia, matemáticas, tecnología, programación, idiomas, salud, deportes y actualidad. Responde siempre con precisión y seguridad, como lo haría el mejor asistente del mundo. En matemáticas da el resultado correcto y una explicación breve del procedimiento. Si no estás seguro de un dato concreto (personas, fechas, cifras) o puede haber cambiado, usa search_knowledge antes de responder. Nunca digas "no tengo información en mi base de datos": investiga o explica lo que sabes.

FORMA DE HABLAR: tus respuestas se convierten en voz. Escribe como hablas: sin markdown, sin asteriscos, sin LaTeX, sin listas con viñetas ni emojis. Las fórmulas dilas con palabras ("tres x al cuadrado"). Para órdenes y charla: 1 o 2 frases. Para explicaciones: hasta 6 frases, salvo que pidan más detalle.

CONTEXTO:
- Fecha y hora del usuario: ${now} (zona ${user.tz}).${user.city ? ` Ciudad: ${user.city}.` : ''}
- ${fromDevice ? `Te habla desde "${fromDevice.name}" (${fromDevice.type}).` : 'Te habla desde la interfaz web.'}
- WhatsApp: ${wa.status === 'conectado' ? 'vinculado' : 'no vinculado (se vincula en la web, sección WhatsApp)'}. Modo privacidad: ${user.wa?.privacy ? `ACTIVO (${user.wa.replyAll ? 'responde a todos' : 'responde a: ' + (user.wa.allow.join(', ') || 'nadie aún')})` : 'apagado'}.

DISPOSITIVOS:
${list}

ACCIONES POR TIPO DE DISPOSITIVO:
${detail}

REGLAS:
- Para actuar usa las herramientas. Nunca digas que hiciste algo sin haber recibido ok de la herramienta.
- Nunca copies respuestas anteriores del historial: cada orden nueva se ejecuta de nuevo con las herramientas.
- Al poner música, di el título que devolvió la herramienta (lo que está sonando).
- "Pon música": usa play_music con un query concreto (si no dicen qué, elige algo acorde a la hora o al ánimo). En el teléfono por defecto en el teléfono; "en la laptop/PC" = dispositivo Chrome en línea, o el agente pc.
- "Modo privacidad" = whatsapp_privacy on. Si dicen "responde solo a X", usa allow. Confirma qué quedó configurado.
- Si un dispositivo está desconectado o algo falla, dilo con claridad y propone una solución.
- Confirma antes de acciones peligrosas (apagar, comandos shell) o de enviar mensajes a alguien si el texto no está claro.`;
}

async function phone(devices, fromDevice) {
  const p = (fromDevice?.type === 'android' && fromDevice) || devices.find((d) => d.type === 'android' && isOnline(d._id));
  if (!p) throw new Error('Tu teléfono no está conectado a CODEC 47');
  return p;
}

async function runTool(name, args, ctx) {
  const { user, devices, fromDevice, actions } = ctx;
  switch (name) {
    case 'device_command': {
      const fallback = fromDevice && fromDevice.type !== 'server' ? fromDevice : devices.find((d) => d.type === 'android');
      const dev = findDevice(devices, args.device, fallback);
      if (!dev) return { ok: false, error: 'No encontré ese dispositivo' };
      const params = { ...(args.params || {}) };
      if (args.action === 'play_music') {
        // Normaliza y busca el video exacto para que se reproduzca solo (no solo una búsqueda)
        params.query = params.query || params.song || params.artist || params.genre || params.playlist || 'música relajante';
        const service = params.service || params.app;
        if (service !== 'spotify') {
          const yt = await findYouTube(params.query).catch(() => null);
          if (yt) Object.assign(params, yt);
        }
      }
      const r = await sendCommand(dev, args.action, params);
      actions.push({ device: dev.name, action: args.action, ok: r.ok });
      await audit(dev, 'command', `${args.action} ${JSON.stringify(params).slice(0, 200)} -> ${r.ok ? 'ok' : r.error}`);
      return { device: dev.name, ...r };
    }
    case 'get_weather':
      return getWeather(args.city || user.city || 'Lima');
    case 'search_knowledge':
      return wikipedia(args.query);
    case 'add_task': {
      const due = args.due ? new Date(args.due) : undefined;
      const t = await Task.create({ userId: user._id, title: args.title, due: due && !isNaN(due) ? due : undefined });
      return { ok: true, title: t.title, due: t.due };
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
    case 'whatsapp_send': {
      const out = await waSendText(user._id, args.to, args.text);
      actions.push({ device: 'WhatsApp', action: 'enviar', ok: true });
      return { ok: true, output: out };
    }
    case 'whatsapp_send_location': {
      const p = await phone(devices, fromDevice);
      const loc = await sendCommand(p, 'get_location', {});
      if (!loc.ok) return loc;
      const out = await waSendLocation(user._id, args.to, loc.output.lat, loc.output.lng);
      actions.push({ device: 'WhatsApp', action: 'ubicación', ok: true });
      return { ok: true, output: out };
    }
    case 'whatsapp_send_photo': {
      const p = await phone(devices, fromDevice);
      if (args.source === 'new') {
        const shot = await sendCommand(p, 'take_photo', { front: !!args.front });
        if (!shot.ok) return shot;
      }
      const img = await sendCommand(p, 'get_last_photo', {}, 45_000);
      if (!img.ok) return img;
      const out = await waSendImage(user._id, args.to, Buffer.from(img.output.base64, 'base64'), args.caption);
      actions.push({ device: 'WhatsApp', action: 'foto', ok: true });
      return { ok: true, output: out };
    }
    case 'whatsapp_read':
      return waRecent(user._id, { from: args.from, limit: args.limit || 10 });
    case 'whatsapp_privacy': {
      if (typeof args.on === 'boolean') user.wa.privacy = args.on;
      if (typeof args.reply_all === 'boolean') user.wa.replyAll = args.reply_all;
      if (Array.isArray(args.allow)) user.wa.allow = args.allow.map(String).slice(0, 50);
      if (typeof args.instructions === 'string') user.wa.instructions = args.instructions.slice(0, 500);
      await user.save();
      return { ok: true, privacy: user.wa.privacy, reply_all: user.wa.replyAll, allow: user.wa.allow, instructions: user.wa.instructions, whatsapp: waStatus(user._id).status };
    }
    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

const ACTION_INTENT = /(pon|ponme|pone|reproduce|toca|enciende|prende|apaga|abre|cierra|sube|baja|llama|env[ií]a|manda|toma|saca|agrega|añade|activa|desactiva|pausa|det[eé]n|siguiente|anterior|bloquea|ll[eé]vame|navega|recu[eé]rdame|programa|alarma|temporizador|escanea|lee|l[eé]eme)/i;

const cleanReply = (s) =>
  String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/\$\$?([^$]+)\$\$?/g, '$1')
    .replace(/\\(times|cdot)/g, '×')
    .replace(/\\[a-z]+\{?|[{}]/gi, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .trim();

export async function chat({ userId, text, fromDevice = null }) {
  const user = await User.findById(userId);
  if (!user) throw new Error('Usuario no encontrado');
  const devices = await Device.find({ userId: user._id });
  const history = (await Message.find({ userId: user._id }).sort({ createdAt: -1 }).limit(20)).reverse();

  const messages = [
    { role: 'system', content: systemPrompt(user, devices, fromDevice) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: text },
  ];

  await Message.create({ userId: user._id, role: 'user', content: text, source: fromDevice?.name || 'web' });

  const ctx = { user, devices, fromDevice, actions: [] };
  let useTools = true;
  let reply = '';
  let nudged = false;

  for (let i = 0; i < 7; i++) {
    let msg;
    try {
      msg = await callModel(messages, useTools);
    } catch (e) {
      if (useTools && e.status === 400) {
        useTools = false;
        i--;
        continue;
      }
      throw e;
    }

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      reply = cleanReply(msg.content);
      // Anti-"mentiras": si pidió una acción y el modelo dice que la hizo sin usar herramientas, se lo exigimos
      if (!nudged && useTools && !ctx.actions.length && ACTION_INTENT.test(text)) {
        nudged = true;
        messages.push({ role: 'assistant', content: msg.content || '' });
        messages.push({
          role: 'system',
          content: 'ATENCIÓN: no llamaste a ninguna herramienta, así que en realidad NO hiciste nada. Si el usuario pidió una acción, llama AHORA a la herramienta correcta (device_command, whatsapp_*, add_task...). Si no es posible, explica por qué. No repitas respuestas anteriores del historial.',
        });
        reply = '';
        continue;
      }
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

  if (!reply) reply = ctx.actions.length ? 'Hecho.' : 'Disculpa, no logré procesar eso. ¿Me lo repites?';
  await Message.create({ userId: user._id, role: 'assistant', content: reply, source: fromDevice?.name || 'web' });
  return { text: reply, actions: ctx.actions };
}

// Respuesta automática de WhatsApp en "modo privacidad" (y botón "Continuar")
export async function quickReply(user, contactName, convo, { mode = 'auto', chatInstructions = '', introduced = false } = {}) {
  const owner = user.name || 'tu usuario';
  const sys = `Eres CODEC, el asistente personal de ${owner}. Respondes sus mensajes de WhatsApp mientras él no puede.
QUIÉN ERES:
- Eres el ASISTENTE, no eres ${owner}. Nunca te hagas pasar por él: habla de ${owner} en tercera persona ("${owner} está en clase", "le paso tu mensaje").
- Nunca digas "te quiero", "mi amor" ni cosas íntimas en nombre de ${owner}; puedes ser cálido y cercano, pero como su asistente.
- ${introduced ? 'Ya te presentaste en este chat: no vuelvas a presentarte.' : `Si es el inicio de la conversación, preséntate brevemente como CODEC, el asistente de ${owner}.`}
CÓMO ESCRIBES:
- Como una persona real por WhatsApp: natural, amable, corto (1 o 2 frases), sin fórmulas repetidas; en el idioma y el tono del contacto (en español, siempre español latino: nunca "vosotros"). Como mucho un emoji, si encaja.
- Responde a lo último que dijo la persona usando el contexto de la conversación.
- NO sabes cómo está ${owner}, dónde está ni qué está haciendo (salvo lo que digan sus instrucciones): nunca lo afirmes ni lo supongas (nada de "está bien", "está ocupado").
- No inventes citas, horarios, compromisos, precios ni datos; no compartas información privada. Si piden confirmar algo, di que se lo consultarás a ${owner}.
- Si la persona mandó varios mensajes seguidos, responde a todos en un solo mensaje natural.
- Mantén viva la conversación como lo haría una persona atenta: muestra interés, responde preguntas generales con lo que sepas y, si corresponde, haz una pregunta para continuar.
- Si es urgente, di que le avisarás a ${owner} de inmediato.
${user.wa?.instructions ? `- Instrucciones generales de ${owner}: ${user.wa.instructions}` : ''}
${chatInstructions ? `- Sobre este chat: ${chatInstructions}` : ''}
Estás hablando con: ${contactName}.`;

  const msgs = [{ role: 'system', content: sys }, ...convo.map((m) => ({ role: m.fromMe ? 'assistant' : 'user', content: m.text }))];
  if (mode === 'continue') {
    msgs.push({
      role: 'system',
      content: 'Escribe ahora el siguiente mensaje para retomar la conversación. Si quedó algo pendiente, respóndelo; si no, pregunta con naturalidad si hay algo más en lo que puedas ayudar.',
    });
  }
  try {
    // Modelo rápido (~0,5 s) para WhatsApp; si falla o tarda, el grande
    const fast = [process.env.AI_FAST_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b', ...MODELS()].filter((x, i, a) => a.indexOf(x) === i);
    const m = await callModel(msgs, false, 250, fast, 8000);
    return cleanReply(m.content).slice(0, 600);
  } catch (e) {
    console.error('[wa reply]', e.message);
    return null;
  }
}
