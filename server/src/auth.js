import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Device, User } from './models.js';

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) throw new Error('JWT_SECRET falta o es demasiado corto (mínimo 16 caracteres)');
  return s;
};

export const signUser = (user) => jwt.sign({ uid: String(user._id) }, secret(), { expiresIn: '30d' });

export const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
export const newDeviceKey = () => 'c47_' + crypto.randomBytes(24).toString('base64url');

export async function userFromToken(token) {
  try {
    const { uid } = jwt.verify(token, secret());
    return await User.findById(uid);
  } catch {
    return null;
  }
}

export async function deviceFromKey(key) {
  if (!key || typeof key !== 'string') return null;
  return Device.findOne({ keyHash: hashKey(key) });
}

export async function requireUser(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = token && (await userFromToken(token));
  if (!user) return res.status(401).json({ error: 'No autorizado' });
  req.user = user;
  next();
}

// Límite simple de intentos de login por IP (protección contra fuerza bruta)
const attempts = new Map();
export function loginLimiter(req, res, next) {
  const now = Date.now();
  const rec = attempts.get(req.ip) || { n: 0, reset: now + 15 * 60_000 };
  if (now > rec.reset) Object.assign(rec, { n: 0, reset: now + 15 * 60_000 });
  rec.n++;
  attempts.set(req.ip, rec);
  if (rec.n > 10) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  next();
}
