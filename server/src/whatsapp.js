// WhatsApp de CODEC 47: se vincula como "dispositivo vinculado" (igual que WhatsApp Web) escaneando un QR.
// Permite leer mensajes, enviar textos/ubicación/fotos y el "modo privacidad" (responde por ti).
import * as Baileys from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { User, WaAuth, WaContact, WaMessage } from './models.js';
import { notifyUser } from './hub.js';
import { quickReply } from './ai.js';

const { BufferJSON, initAuthCreds, proto, DisconnectReason, Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = Baileys;
const makeWASocket = Baileys.makeWASocket || Baileys.default?.default || Baileys.default;
const logger = pino({ level: 'silent' });

const sessions = new Map(); // userId -> { sock, status, qr, me }
const lastAuto = new Map(); // jid -> [timestamps]

// ---------- Credenciales guardadas en MongoDB ----------
async function useMongoAuthState(userId) {
  const read = async (key) => {
    const d = await WaAuth.findOne({ userId, key }).lean();
    return d ? JSON.parse(d.value, BufferJSON.reviver) : null;
  };
  const write = (key, val) => WaAuth.updateOne({ userId, key }, { value: JSON.stringify(val, BufferJSON.replacer) }, { upsert: true });
  const del = (key) => WaAuth.deleteOne({ userId, key });
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
  return { state: { creds, keys: makeCacheableSignalKeyStore ? makeCacheableSignalKeyStore(keys, logger) : keys }, saveCreds: () => write('creds', creds) };
}

function setStatus(userId, patch) {
  const s = sessions.get(String(userId)) || {};
  Object.assign(s, patch);
  sessions.set(String(userId), s);
  notifyUser(userId, { type: 'wa', status: s.status, qr: s.qr || null, me: s.me || null });
}

export function waStatus(userId) {
  const s = sessions.get(String(userId));
  return { status: s?.status || 'desconectado', qr: s?.qr || null, me: s?.me || null };
}

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

export async function waConnect(userId) {
  userId = String(userId);
  const cur = sessions.get(userId);
  if (cur?.sock && ['conectado', 'conectando', 'qr'].includes(cur.status)) return waStatus(userId);

  const { state, saveCreds } = await useMongoAuthState(userId);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
  const sock = makeWASocket({
    auth: state,
    version,
    logger,
    browser: Browsers.ubuntu('CODEC 47'),
    markOnlineOnConnect: false, // así tu teléfono sigue recibiendo notificaciones
    syncFullHistory: false,
  });
  setStatus(userId, { sock, status: 'conectando', qr: null });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (u.qr) setStatus(userId, { status: 'qr', qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 300 }) });
    if (u.connection === 'open') {
      const me = sock.user ? { name: sock.user.name || '', id: sock.user.id.split(':')[0].split('@')[0] } : null;
      setStatus(userId, { status: 'conectado', qr: null, me });
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        await WaAuth.deleteMany({ userId });
        setStatus(userId, { sock: null, status: 'desconectado', qr: null, me: null });
      } else if (sessions.get(userId)?.status === 'qr' && code === DisconnectReason.timedOut) {
        // Nadie escaneó el QR: no seguir generando códigos
        setStatus(userId, { sock: null, status: 'desconectado', qr: null });
      } else {
        setStatus(userId, { sock: null, status: 'reconectando' });
        setTimeout(() => waConnect(userId).catch(() => {}), 4000);
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
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        await handleIncoming(userId, sock, m);
      } catch (e) {
        console.error('[wa msg]', e.message);
      }
    }
  });

  return waStatus(userId);
}

async function handleIncoming(userId, sock, m) {
  const jid = m.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  const text = textOf(m);
  if (!text) return;
  const fromMe = !!m.key.fromMe;
  const name = fromMe ? null : m.pushName || null;
  const altPhone = (m.key.remoteJidAlt || m.key.senderPn || '').split('@')[0] || null;
  if (name) await saveContact(userId, jid, name, altPhone || (jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null));
  const contact = await WaContact.findOne({ userId, jid }).lean();
  const display = name || contact?.name || jid.split('@')[0];

  await WaMessage.create({ userId, jid, name: display, fromMe, text });
  if (fromMe) return;
  notifyUser(userId, { type: 'wa_msg', jid, name: display, text });

  // ----- Modo privacidad: CODEC 47 responde por ti -----
  const user = await User.findById(userId);
  if (!user?.wa?.privacy) return;
  const allowed =
    user.wa.replyAll ||
    (user.wa.allow || []).some((a) => {
      const al = a.toLowerCase().trim();
      const digits = a.replace(/\D/g, '');
      return (al && display.toLowerCase().includes(al)) || (digits.length >= 6 && (jid + (altPhone || '')).includes(digits));
    });
  if (!allowed) return;

  // Anti-bucle: máximo 1 respuesta cada 20 s y 15 por hora por contacto
  const now = Date.now();
  const hist = (lastAuto.get(jid) || []).filter((t) => now - t < 3600_000);
  if (hist.length >= 15 || (hist.length && now - hist[hist.length - 1] < 20_000)) return;
  hist.push(now);
  lastAuto.set(jid, hist);

  const convo = (await WaMessage.find({ userId, jid }).sort({ createdAt: -1 }).limit(10).lean()).reverse();
  const reply = await quickReply(user, display, convo);
  if (!reply) return;
  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200 + Math.min(4000, reply.length * 25)));
  await sock.sendMessage(jid, { text: reply });
  await WaMessage.create({ userId, jid, name: display, fromMe: true, text: reply, autoReply: true });
  notifyUser(userId, { type: 'wa_msg', jid, name: display, text: reply, fromMe: true, autoReply: true });
}

export async function waLogout(userId) {
  const s = sessions.get(String(userId));
  try {
    await s?.sock?.logout();
  } catch {}
  await WaAuth.deleteMany({ userId });
  setStatus(userId, { sock: null, status: 'desconectado', qr: null, me: null });
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
  const ids = await WaAuth.distinct('userId', { key: 'creds' });
  for (const id of ids) waConnect(id).catch((e) => console.error('[wa start]', e.message));
}
