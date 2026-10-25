// WhatsApp de CODEC 47: se vincula como "dispositivo vinculado" (igual que WhatsApp Web)
// con un QR o con un código de 8 letras. Lee mensajes, envía textos/ubicación/fotos y,
// en "modo privacidad", responde por ti (todos los chats o solo los que elijas).
import * as Baileys from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import mongoose from 'mongoose';
import { Audit, Device, User, WaAuth, WaContact, WaMessage } from './models.js';
import { isOnline, notifyUser, sendCommand } from './hub.js';
import { quickReply } from './ai.js';

const { BufferJSON, initAuthCreds, proto, DisconnectReason, Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, normalizeMessageContent, getContentType, isLidUser } = Baileys;
const makeWASocket = Baileys.makeWASocket || Baileys.default?.default || Baileys.default;
const logger = pino({ level: 'silent' });

const sessions = new Map(); // userId -> { sock, status, qr, code, me, lastError }
const lastAuto = new Map(); // jid -> [timestamps]
const URGENT = /(urgente|urgencia|emergencia|hospital|accidente|auxilio|socorro|ayuda|polic[ií]a|ambulancia|grave)/i;

export const DEFAULT_INTRO = (name) =>
  `Hola, soy CODEC, el asistente de ${name || 'mi usuario'}. Esta opción está habilitada en caso de emergencias: ahora no puede responder, pero yo te atiendo y le paso tu mensaje.`;

async function log(userId, detail, severity = 'info') {
  console.log('[wa]', detail);
  await Audit.create({ userId, deviceName: 'WhatsApp', kind: 'whatsapp', severity, detail: String(detail).slice(0, 300) }).catch(() => {});
}

// ---------- Credenciales guardadas en MongoDB ----------
async function useMongoAuthState(userId) {
  // Escrituras en serie por clave: evita choques (E11000) al guardar la misma clave dos veces a la vez
  const queues = new Map();
  const serial = (key, fn) => {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn).catch((e) => console.error('[wa auth]', key, e.message));
    queues.set(key, next);
    return next;
  };
  const read = async (key) => {
    const d = await WaAuth.findOne({ userId, key }).lean();
    return d ? JSON.parse(d.value, BufferJSON.reviver) : null;
  };
  const write = (key, val) =>
    serial(key, () => WaAuth.updateOne({ userId, key }, { $set: { value: JSON.stringify(val, BufferJSON.replacer) } }, { upsert: true }));
  const del = (key) => serial(key, () => WaAuth.deleteOne({ userId, key }));

  const creds = (await read('creds')) || initAuthCreds();
  const keys = {
    get: async (type, ids) => {
      const data = {};
      await Promise.all(
        ids.map(async (id) => {
          let v = await read(`${type}-${id}`);
          if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
          data[id] = v;
        })
      );
      return data;
    },
    set: async (data) => {
      const ops = [];
      for (const cat in data) for (const id in data[cat]) ops.push(data[cat][id] ? write(`${cat}-${id}`, data[cat][id]) : del(`${cat}-${id}`));
      await Promise.all(ops);
    },
  };
  return {
    state: { creds, keys: makeCacheableSignalKeyStore ? makeCacheableSignalKeyStore(keys, logger) : keys },
    saveCreds: () => write('creds', creds),
  };
}

function setStatus(userId, patch) {
  const s = sessions.get(String(userId)) || {};
  Object.assign(s, patch);
  sessions.set(String(userId), s);
  notifyUser(userId, { type: 'wa', ...waStatus(userId) });
}

export function waStatus(userId) {
  const s = sessions.get(String(userId));
  return { status: s?.status || 'desconectado', qr: s?.qr || null, code: s?.code || null, me: s?.me || null, lastError: s?.lastError || null };
}

const IGNORE_TYPES = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage', 'pinInChatMessage', 'encReactionMessage']);
let undecryptedLogged = 0;
const textOf = (m) =>
  m.message?.conversation ||
  m.message?.extendedTextMessage?.text ||
  m.message?.imageMessage?.caption ||
  m.message?.videoMessage?.caption ||
  (m.message?.imageMessage && '[foto]') ||
  (m.message?.audioMessage && '[audio]') ||
  (m.message?.videoMessage && '[video]') ||
  (m.message?.stickerMessage && '[sticker]') ||
  (m.message?.locationMessage && '[ubicación]') ||
  (m.message?.documentMessage && '[documento]') ||
  null;

async function saveContact(userId, jid, name, phone) {
  if (!jid || !name) return;
  await WaContact.updateOne({ userId, jid }, { $set: { name, ...(phone ? { phone } : {}) } }, { upsert: true }).catch(() => {});
}

/**
 * Inicia la vinculación. Si se pasa [phone] (con código de país), en vez de QR genera
 * un código de 8 letras para "Vincular con número de teléfono".
 */
export async function waConnect(userId, { phone } = {}) {
  userId = String(userId);
  const cur = sessions.get(userId);
  if (cur?.sock && cur.status === 'conectado') return waStatus(userId);
  if (cur?.sock && !phone && ['conectando', 'qr'].includes(cur.status)) return waStatus(userId);
  if (cur?.sock) {
    try { cur.sock.end(undefined); } catch {}
  }

  const { state, saveCreds } = await useMongoAuthState(userId);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
  const sock = makeWASocket({
    auth: state,
    version,
    logger,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false, // así tu teléfono sigue recibiendo notificaciones
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
  });
  setStatus(userId, { sock, status: 'conectando', qr: null, code: null, lastError: null });

  sock.ev.on('creds.update', saveCreds);

  let codeRequested = false;
  sock.ev.on('connection.update', async (u) => {
    if (sessions.get(userId)?.sock !== sock) return; // evento de un socket viejo
    if (u.qr) {
      if (phone && !state.creds.registered) {
        if (!codeRequested) {
          codeRequested = true;
          try {
            const code = await sock.requestPairingCode(String(phone).replace(/\D/g, ''));
            setStatus(userId, { status: 'codigo', code: code?.match(/.{1,4}/g)?.join('-') || code, qr: null });
            await log(userId, 'Código de vinculación generado');
          } catch (e) {
            setStatus(userId, { lastError: 'No se pudo generar el código: ' + e.message });
            await log(userId, 'Error al pedir código: ' + e.message, 'warn');
          }
        }
      } else {
        setStatus(userId, { status: 'qr', qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 300 }) });
      }
    }
    if (u.connection === 'open') {
      const me = sock.user ? { name: sock.user.name || '', id: sock.user.id.split(':')[0].split('@')[0] } : null;
      setStatus(userId, { status: 'conectado', qr: null, code: null, me, lastError: null });
      await log(userId, `WhatsApp vinculado (${me?.id || ''})`);
    }
    if (u.connection === 'close') {
      const err = u.lastDisconnect?.error;
      const code = err?.output?.statusCode;
      const reason = `${code || '?'} ${err?.message || ''}`.trim();
      await log(userId, `Conexión cerrada: ${reason}`, code === DisconnectReason.restartRequired ? 'info' : 'warn');
      if (code === DisconnectReason.loggedOut || code === 403) {
        await WaAuth.deleteMany({ userId });
        setStatus(userId, { sock: null, status: 'desconectado', qr: null, code: null, me: null, lastError: 'WhatsApp cerró la sesión. Vuelve a vincular.' });
      } else if (['qr', 'codigo'].includes(sessions.get(userId)?.status) && code === DisconnectReason.timedOut) {
        setStatus(userId, { sock: null, status: 'desconectado', qr: null, code: null, lastError: 'El código expiró sin escanear. Pulsa Vincular otra vez.' });
      } else {
        // 515 = "reinicio necesario" justo después de escanear: es normal, se reconecta solo
        setStatus(userId, { sock: null, status: 'reconectando', lastError: code === DisconnectReason.restartRequired ? null : reason });
        setTimeout(() => waConnect(userId).catch((e) => log(userId, 'Reconexión falló: ' + e.message, 'warn')), code === DisconnectReason.restartRequired ? 1500 : 5000);
      }
    }
  });

  const onContacts = (list) => {
    for (const c of list || []) saveContact(userId, c.id, c.name || c.notify || c.verifiedName, c.id?.split('@')[0]);
  };
  sock.ev.on('contacts.upsert', onContacts);
  sock.ev.on('contacts.update', onContacts);
  sock.ev.on('messaging-history.set', ({ contacts }) => onContacts(contacts));

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) {
      if (type === 'append' && !m.key?.fromMe) continue; // historial: solo guardamos lo que escribes tú
      try {
        await handleIncoming(userId, sock, m, type);
      } catch (e) {
        console.error('[wa msg]', e.message);
      }
    }
  });

  return waStatus(userId);
}

function matchesAllow(allow, display, jid, altPhone) {
  return (allow || []).some((a) => {
    const al = a.toLowerCase().trim();
    const digits = a.replace(/\D/g, '');
    return (al && display.toLowerCase().includes(al)) || (digits.length >= 6 && (jid + (altPhone || '')).includes(digits));
  });
}

async function handleIncoming(userId, sock, m, type = 'notify') {
  const jid = m.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  const fromMe = !!m.key.fromMe;

  // Mensaje que no se pudo descifrar (WhatsApp lo reintenta solo)
  if (!m.message) {
    if (!fromMe && m.messageStubType && undecryptedLogged++ < 5) await log(userId, `No pude leer un mensaje de ${m.pushName || jid} (se reintentará)`, 'warn');
    return;
  }
  // Abre envoltorios: mensajes temporales, de una sola vez, editados, enviados desde otro dispositivo…
  const content = normalizeMessageContent(m.message);
  const ctype = content ? getContentType(content) : null;
  if (!ctype || IGNORE_TYPES.has(ctype)) return;
  const text = textOf({ message: content }) || `[${ctype.replace('Message', '')}]`;

  const name = fromMe ? null : m.pushName || null;
  // WhatsApp oculta números tras un "LID": recuperar el número real para la lista de permitidos
  let altPhone = (m.key.remoteJidAlt || m.key.senderPn || '').split('@')[0] || null;
  if (!altPhone && isLidUser?.(jid)) {
    try { altPhone = (await sock.signalRepository?.lidMapping?.getPNForLID(jid))?.split('@')[0]?.split(':')[0] || null; } catch {}
  }
  if (!altPhone && jid.endsWith('@s.whatsapp.net')) altPhone = jid.split('@')[0];
  if (name) await saveContact(userId, jid, name, altPhone || (jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null));
  const contact = await WaContact.findOne({ userId, jid }).lean();
  const display = name || contact?.name || jid.split('@')[0];

  await WaMessage.create({ userId, jid, name: display, fromMe, text });
  notifyUser(userId, { type: 'wa_msg', jid, name: display, text, fromMe });
  if (fromMe || type !== 'notify') return;

  // Mensaje urgente: avisar de verdad al usuario (en voz alta en el teléfono + alerta en la web)
  if (URGENT.test(text)) {
    await log(userId, `Mensaje URGENTE de ${display}: ${text}`, 'high');
    const phones = await Device.find({ userId, type: 'android' });
    for (const p of phones) if (isOnline(p._id)) sendCommand(p, 'speak', { text: `Atención. Mensaje urgente de WhatsApp de ${display}: ${text}` }).catch(() => {});
  }

  // ----- Modo privacidad: CODEC 47 responde por ti -----
  const user = await User.findById(userId);
  if (!user?.wa?.privacy) return;
  const allowed = user.wa.replyAll || contact?.auto || matchesAllow(user.wa.allow, display, jid, altPhone);
  if (!allowed || contact?.blocked) return;

  // Anti-bucle: máximo 1 respuesta cada 20 s y 15 por hora por contacto
  const now = Date.now();
  const hist = (lastAuto.get(jid) || []).filter((t) => now - t < 3600_000);
  if (hist.length >= 15 || (hist.length && now - hist[hist.length - 1] < 20_000)) return;
  hist.push(now);
  lastAuto.set(jid, hist);

  await replyTo(userId, sock, user, jid, display, contact, 'auto');
}

/** Genera y envía una respuesta humanizada en un chat (automática o con el botón "Continuar"). */
async function replyTo(userId, sock, user, jid, display, contact, mode) {
  // Saludo de emergencia: la primera vez (o tras 12 h sin hablar) se presenta
  const introDue = user.wa.introEnabled !== false && (!contact?.introAt || Date.now() - new Date(contact.introAt) > 12 * 3600_000);
  if (introDue && mode === 'auto') {
    const intro = (user.wa.intro || '').trim() || DEFAULT_INTRO(user.name);
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    await sock.sendMessage(jid, { text: intro });
    await WaMessage.create({ userId, jid, name: display, fromMe: true, text: intro, autoReply: true });
    await WaContact.updateOne({ userId, jid }, { $set: { introAt: new Date() } }, { upsert: true });
    notifyUser(userId, { type: 'wa_msg', jid, name: display, text: intro, fromMe: true, autoReply: true });
  }

  const convo = (await WaMessage.find({ userId, jid }).sort({ createdAt: -1 }).limit(14).lean()).reverse();
  const reply = await quickReply(user, display, convo, { mode, chatInstructions: contact?.instructions || '', introduced: introDue || !!contact?.introAt });
  if (!reply) return null;
  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000 + Math.min(4000, reply.length * 25)));
  await sock.sendMessage(jid, { text: reply });
  await WaMessage.create({ userId, jid, name: display, fromMe: true, text: reply, autoReply: true });
  notifyUser(userId, { type: 'wa_msg', jid, name: display, text: reply, fromMe: true, autoReply: true });
  return reply;
}

/** Botón "Continuar": retoma el chat con lo último que se habló. */
export async function waContinueChat(userId, jid) {
  const sock = sockOf(userId);
  const user = await User.findById(userId);
  const contact = await WaContact.findOne({ userId, jid }).lean();
  const last = await WaMessage.findOne({ userId, jid }).sort({ createdAt: -1 }).lean();
  if (!last) throw new Error('No hay mensajes en ese chat todavía');
  const reply = await replyTo(userId, sock, user, jid, contact?.name || last.name || jid.split('@')[0], contact, 'continue');
  if (!reply) throw new Error('No pude generar la respuesta');
  return reply;
}

export async function waChats(userId) {
  const rows = await WaMessage.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(userId)) } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$jid', name: { $first: '$name' }, last: { $first: '$text' }, at: { $first: '$createdAt' }, lastFromMe: { $first: '$fromMe' }, count: { $sum: 1 } } },
    { $sort: { at: -1 } },
    { $limit: 60 },
  ]);
  const contacts = await WaContact.find({ userId, jid: { $in: rows.map((r) => r._id) } }).lean();
  const byJid = new Map(contacts.map((c) => [c.jid, c]));
  return rows.map((r) => {
    const c = byJid.get(r._id) || {};
    return { jid: r._id, name: c.name || r.name, last: r.last, at: r.at, lastFromMe: r.lastFromMe, count: r.count, auto: !!c.auto, instructions: c.instructions || '' };
  });
}

export async function waChatMessages(userId, jid, limit = 40) {
  const rows = await WaMessage.find({ userId, jid }).sort({ createdAt: -1 }).limit(limit).lean();
  return rows.reverse().map((r) => ({ fromMe: r.fromMe, text: r.text, at: r.createdAt, auto: r.autoReply || undefined }));
}

export async function waSetChat(userId, jid, { auto, instructions }) {
  const $set = {};
  if (typeof auto === 'boolean') $set.auto = auto;
  if (typeof instructions === 'string') $set.instructions = instructions.slice(0, 500);
  await WaContact.updateOne({ userId, jid }, { $set }, { upsert: true });
}

export async function waLogout(userId) {
  const s = sessions.get(String(userId));
  try {
    await s?.sock?.logout();
  } catch {}
  await WaAuth.deleteMany({ userId });
  setStatus(userId, { sock: null, status: 'desconectado', qr: null, code: null, me: null, lastError: null });
}

function sockOf(userId) {
  const s = sessions.get(String(userId));
  if (!s?.sock || s.status !== 'conectado') throw new Error('WhatsApp no está vinculado. Vincúlalo en la web (sección WhatsApp).');
  return s.sock;
}

// "mamá", "Juan Pérez" o "+51 987 654 321" -> jid
export async function resolveJid(userId, ref) {
  const r = String(ref || '').trim();
  const digits = r.replace(/\D/g, '');
  if (digits.length >= 8 && digits.length >= r.replace(/\s/g, '').length - 2) return { jid: digits + '@s.whatsapp.net', name: r };
  const esc = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const c =
    (await WaContact.findOne({ userId, name: new RegExp(`^${esc}$`, 'i') }).lean()) ||
    (await WaContact.findOne({ userId, name: new RegExp(esc, 'i') }).lean());
  if (c) return { jid: c.jid, name: c.name };
  const msg = await WaMessage.findOne({ userId, name: new RegExp(esc, 'i') }).sort({ createdAt: -1 }).lean();
  if (msg) return { jid: msg.jid, name: msg.name };
  throw new Error(`No encontré a "${r}" en tus chats de WhatsApp. Dime su número con código de país.`);
}

export async function waSendText(userId, to, text) {
  const sock = sockOf(userId);
  const { jid, name } = await resolveJid(userId, to);
  await sock.sendMessage(jid, { text });
  await WaMessage.create({ userId, jid, name, fromMe: true, text });
  return `Mensaje enviado a ${name}`;
}

export async function waSendLocation(userId, to, lat, lng, label) {
  const sock = sockOf(userId);
  const { jid, name } = await resolveJid(userId, to);
  await sock.sendMessage(jid, { location: { degreesLatitude: lat, degreesLongitude: lng, name: label || 'Mi ubicación' } });
  await WaMessage.create({ userId, jid, name, fromMe: true, text: `[ubicación ${lat},${lng}]` });
  return `Ubicación enviada a ${name}`;
}

export async function waSendImage(userId, to, buffer, caption) {
  const sock = sockOf(userId);
  const { jid, name } = await resolveJid(userId, to);
  await sock.sendMessage(jid, { image: buffer, caption: caption || undefined });
  await WaMessage.create({ userId, jid, name, fromMe: true, text: '[foto]' + (caption ? ' ' + caption : '') });
  return `Foto enviada a ${name}`;
}

export async function waRecent(userId, { from, limit = 10, onlyIncoming = true } = {}) {
  const q = { userId };
  if (onlyIncoming) q.fromMe = false;
  if (from) q.name = new RegExp(String(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const rows = await WaMessage.find(q).sort({ createdAt: -1 }).limit(Math.min(50, limit)).lean();
  return rows.map((r) => ({ from: r.fromMe ? 'yo' : r.name, text: r.text, at: r.createdAt, auto: r.autoReply || undefined }));
}

// Al arrancar el servidor, reconecta las sesiones ya vinculadas
export async function startAllWhatsApp() {
  // Solo las que terminaron de vincularse (tienen "me"); las a medio vincular no
  const docs = await WaAuth.find({ key: 'creds' }).lean();
  for (const d of docs) {
    let me = null;
    try { me = JSON.parse(d.value).me; } catch {}
    if (me) waConnect(d.userId).catch((e) => console.error('[wa start]', e.message));
  }
}
