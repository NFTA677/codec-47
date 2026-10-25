import express from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { Audit, Device, Message, Metric, Task, User } from './models.js';
import { deviceFromKey, hashKey, loginLimiter, newDeviceKey, requireUser, signUser } from './auth.js';
import { audit, isOnline, sendCommand } from './hub.js';
import { chat } from './ai.js';
import { getWeather } from './weather.js';
import { synthesize, VOICES } from './tts.js';
import { waConnect, waLogout, waRecent, waStatus } from './whatsapp.js';

export const apiRouter = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const validId = (id) => mongoose.isValidObjectId(id);

const publicUser = (u) => ({ id: u._id, email: u.email, name: u.name, city: u.city, tz: u.tz, voice: u.voice, wa: u.wa });
const publicDevice = (d) => ({
  id: d._id,
  name: d.name,
  type: d.type,
  online: isOnline(d._id),
  lastSeen: d.lastSeen,
  info: d.info,
  metrics: d.metrics,
  security: d.security,
  securityAt: d.securityAt,
});

// ---------- Autenticación ----------
apiRouter.post(
  '/auth/register',
  loginLimiter,
  wrap(async (req, res) => {
    const { email, password, name } = req.body || {};
    const count = await User.countDocuments();
    if (count > 0 && process.env.ALLOW_REGISTER !== 'true')
      return res.status(403).json({ error: 'El registro está cerrado' });
    if (!email || !password || password.length < 8)
      return res.status(400).json({ error: 'Email y contraseña (mínimo 8 caracteres) son obligatorios' });
    if (await User.findOne({ email: String(email).toLowerCase() }))
      return res.status(409).json({ error: 'Ese email ya está registrado' });
    const user = await User.create({ email, name: name || '', passwordHash: await bcrypt.hash(password, 12) });
    res.json({ token: signUser(user), user: publicUser(user) });
  })
);

apiRouter.post(
  '/auth/login',
  loginLimiter,
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    const user = await User.findOne({ email: String(email || '').toLowerCase() });
    if (!user || !(await bcrypt.compare(String(password || ''), user.passwordHash)))
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    res.json({ token: signUser(user), user: publicUser(user) });
  })
);

apiRouter.get('/auth/status', wrap(async (req, res) => {
  res.json({ hasUsers: (await User.countDocuments()) > 0, registerOpen: process.env.ALLOW_REGISTER === 'true' });
}));

// ---------- Voz (NVIDIA Magpie): la usan la web, la app y la extensión ----------
// Autoriza con sesión web (Bearer) o con la clave de un dispositivo (X-Device-Key)
async function userOrDevice(req, res, next) {
  const key = req.headers['x-device-key'];
  if (key) {
    const d = await deviceFromKey(String(key));
    if (d) {
      req.user = await User.findById(d.userId);
      if (req.user) return next();
    }
    return res.status(401).json({ error: 'No autorizado' });
  }
  return requireUser(req, res, next);
}
const ttsLimit = new Map();
apiRouter.post(
  '/tts',
  userOrDevice,
  wrap(async (req, res) => {
    const id = String(req.user._id);
    const now = Date.now();
    const hits = (ttsLimit.get(id) || []).filter((t) => now - t < 60_000);
    if (hits.length > 40) return res.status(429).json({ error: 'Demasiadas peticiones de voz' });
    hits.push(now);
    ttsLimit.set(id, hits);
    const audio = await synthesize(String(req.body?.text || ''), req.body?.voice || req.user.voice);
    res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }).send(audio);
  })
);

apiRouter.use(requireUser);

apiRouter.get('/voices', (req, res) => res.json({ voices: VOICES, current: req.user.voice }));

apiRouter.get('/me', (req, res) => res.json(publicUser(req.user)));
apiRouter.patch(
  '/me',
  wrap(async (req, res) => {
    const { name, city, tz, voice } = req.body || {};
    if (typeof name === 'string') req.user.name = name.slice(0, 80);
    if (typeof city === 'string') req.user.city = city.slice(0, 80);
    if (typeof voice === 'string' && VOICES.some((v) => v.id === voice)) req.user.voice = voice;
    if (typeof tz === 'string' && tz.length < 60) {
      try {
        new Intl.DateTimeFormat('es', { timeZone: tz });
        req.user.tz = tz;
      } catch {}
    }
    await req.user.save();
    res.json(publicUser(req.user));
  })
);

// ---------- Chat ----------
apiRouter.post(
  '/chat',
  wrap(async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: 'Mensaje vacío' });
    res.json(await chat({ userId: req.user._id, text }));
  })
);

apiRouter.get(
  '/messages',
  wrap(async (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 60);
    const msgs = await Message.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(limit);
    res.json(msgs.reverse().map((m) => ({ role: m.role, content: m.content, source: m.source, at: m.createdAt })));
  })
);

apiRouter.delete(
  '/messages',
  wrap(async (req, res) => {
    await Message.deleteMany({ userId: req.user._id });
    res.json({ ok: true });
  })
);

// ---------- Dispositivos ----------
apiRouter.get(
  '/devices',
  wrap(async (req, res) => {
    const list = await Device.find({ userId: req.user._id }).sort({ createdAt: 1 });
    res.json(list.map(publicDevice));
  })
);

apiRouter.post(
  '/devices',
  wrap(async (req, res) => {
    const { name, type } = req.body || {};
    if (!name || !['android', 'chrome', 'pc', 'server'].includes(type))
      return res.status(400).json({ error: 'Nombre y tipo (android, chrome, pc, server) son obligatorios' });
    const key = newDeviceKey();
    const d = await Device.create({ userId: req.user._id, name: String(name).slice(0, 60), type, keyHash: hashKey(key) });
    // La clave solo se muestra UNA vez
    res.json({ device: publicDevice(d), key });
  })
);

apiRouter.post(
  '/devices/:id/rotate-key',
  wrap(async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'No encontrado' });
    const d = await Device.findOne({ _id: req.params.id, userId: req.user._id });
    if (!d) return res.status(404).json({ error: 'No encontrado' });
    const key = newDeviceKey();
    d.keyHash = hashKey(key);
    await d.save();
    res.json({ key });
  })
);

apiRouter.delete(
  '/devices/:id',
  wrap(async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'No encontrado' });
    await Device.deleteOne({ _id: req.params.id, userId: req.user._id });
    await Metric.deleteMany({ deviceId: req.params.id });
    res.json({ ok: true });
  })
);

apiRouter.post(
  '/devices/:id/command',
  wrap(async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'No encontrado' });
    const d = await Device.findOne({ _id: req.params.id, userId: req.user._id });
    if (!d) return res.status(404).json({ error: 'No encontrado' });
    const { action, params } = req.body || {};
    if (!action) return res.status(400).json({ error: 'Falta action' });
    const r = await sendCommand(d, String(action), params || {});
    await audit(d, 'command', `${action} (manual) -> ${r.ok ? 'ok' : r.error}`);
    res.json(r);
  })
);

apiRouter.get(
  '/devices/:id/metrics',
  wrap(async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'No encontrado' });
    const d = await Device.findOne({ _id: req.params.id, userId: req.user._id });
    if (!d) return res.status(404).json({ error: 'No encontrado' });
    const hours = Math.min(168, Number(req.query.hours) || 24);
    const since = new Date(Date.now() - hours * 3600_000);
    const rows = await Metric.find({ deviceId: d._id, ts: { $gte: since } }).sort({ ts: 1 }).limit(5000);
    res.json(rows.map((r) => ({ ts: r.ts, cpu: r.cpu, mem: r.mem, disk: r.disk, load: r.load })));
  })
);

// ---------- Auditoría ----------
apiRouter.get(
  '/audit',
  wrap(async (req, res) => {
    const q = { userId: req.user._id };
    if (req.query.device && validId(req.query.device)) q.deviceId = req.query.device;
    if (req.query.severity) q.severity = String(req.query.severity);
    const rows = await Audit.find(q).sort({ createdAt: -1 }).limit(Math.min(500, Number(req.query.limit) || 100));
    res.json(rows);
  })
);

// ---------- Pendientes ----------
apiRouter.get(
  '/tasks',
  wrap(async (req, res) => {
    res.json(await Task.find({ userId: req.user._id }).sort({ done: 1, due: 1, createdAt: -1 }).limit(200));
  })
);
apiRouter.post(
  '/tasks',
  wrap(async (req, res) => {
    const { title, due } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Falta el título' });
    res.json(await Task.create({ userId: req.user._id, title: String(title).slice(0, 300), due: due ? new Date(due) : undefined }));
  })
);
apiRouter.patch(
  '/tasks/:id',
  wrap(async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'No encontrado' });
    const upd = {};
    if (typeof req.body?.done === 'boolean') upd.done = req.body.done;
    if (typeof req.body?.title === 'string') upd.title = req.body.title.slice(0, 300);
    const t = await Task.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, upd, { new: true });
    res.json(t);
  })
);
apiRouter.delete(
  '/tasks/:id',
  wrap(async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'No encontrado' });
    await Task.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ ok: true });
  })
);

apiRouter.get(
  '/weather',
  wrap(async (req, res) => res.json(await getWeather(String(req.query.city || req.user.city || 'Ciudad de México'))))
);

// ---------- WhatsApp ----------
apiRouter.get('/whatsapp', (req, res) => res.json({ ...waStatus(req.user._id), settings: req.user.wa }));
apiRouter.post('/whatsapp/connect', wrap(async (req, res) => res.json(await waConnect(req.user._id))));
apiRouter.post('/whatsapp/logout', wrap(async (req, res) => {
  await waLogout(req.user._id);
  res.json({ ok: true });
}));
apiRouter.get('/whatsapp/messages', wrap(async (req, res) => {
  res.json(await waRecent(req.user._id, { limit: Math.min(50, Number(req.query.limit) || 30), onlyIncoming: false }));
}));
apiRouter.patch('/whatsapp/settings', wrap(async (req, res) => {
  const { privacy, replyAll, allow, instructions } = req.body || {};
  if (typeof privacy === 'boolean') req.user.wa.privacy = privacy;
  if (typeof replyAll === 'boolean') req.user.wa.replyAll = replyAll;
  if (Array.isArray(allow)) req.user.wa.allow = allow.map((a) => String(a).trim()).filter(Boolean).slice(0, 50);
  if (typeof instructions === 'string') req.user.wa.instructions = instructions.slice(0, 500);
  await req.user.save();
  res.json(req.user.wa);
}));
