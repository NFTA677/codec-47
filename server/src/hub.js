// Hub en tiempo real: todos los dispositivos (Android, Chrome, PC, servidores) y la web
// se conectan aquí por WebSocket en /ws. Protocolo: mensajes JSON con campo "type".
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Audit, Device, Metric } from './models.js';
import { deviceFromKey, userFromToken } from './auth.js';
import { chat } from './ai.js';

const deviceSockets = new Map(); // deviceId -> ws
const webSockets = new Map(); // userId -> Set<ws>
const pending = new Map(); // commandId -> { resolve, timer }
const alertThrottle = new Map(); // `${deviceId}:${kind}` -> timestamp

export function isOnline(deviceId) {
  return deviceSockets.has(String(deviceId));
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Avisar a las pestañas web abiertas del usuario
export function notifyUser(userId, msg) {
  for (const ws of webSockets.get(String(userId)) || []) send(ws, msg);
}

export async function audit(device, kind, detail, severity = 'info') {
  const ev = await Audit.create({
    userId: device.userId,
    deviceId: device._id,
    deviceName: device.name,
    kind,
    detail,
    severity,
  });
  notifyUser(device.userId, { type: 'audit', event: ev });
  return ev;
}

// Enviar una orden a un dispositivo y esperar su respuesta
export function sendCommand(device, action, params = {}, timeoutMs = 35_000) {
  const ws = deviceSockets.get(String(device._id));
  if (!ws) return Promise.resolve({ ok: false, error: `${device.name} está desconectado` });
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'El dispositivo no respondió a tiempo' });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    send(ws, { type: 'command', id, action, params });
  });
}

async function throttledAlert(device, kind, detail, severity) {
  const k = `${device._id}:${kind}`;
  const last = alertThrottle.get(k) || 0;
  if (Date.now() - last < 15 * 60_000) return;
  alertThrottle.set(k, Date.now());
  await audit(device, 'alert', detail, severity);
}

async function handleDeviceMessage(device, ws, msg) {
  switch (msg.type) {
    case 'ping':
      return send(ws, { type: 'pong' });

    case 'hello': {
      device.info = msg.info || {};
      device.capabilities = Array.isArray(msg.capabilities) ? msg.capabilities.slice(0, 100) : [];
      await device.save();
      return;
    }

    case 'result': {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve({ ok: !!msg.ok, output: msg.output, error: msg.error });
      }
      return;
    }

    case 'metrics': {
      const d = msg.data || {};
      device.metrics = { ...d, at: new Date() };
      device.lastSeen = new Date();
      await device.save();
      await Metric.create({ deviceId: device._id, cpu: d.cpu, mem: d.mem, disk: d.disk, load: d.load });
      notifyUser(device.userId, { type: 'metrics', deviceId: device._id, metrics: device.metrics });
      if (d.cpu > 90) await throttledAlert(device, 'cpu', `CPU al ${d.cpu}%`, 'warn');
      if (d.mem > 90) await throttledAlert(device, 'mem', `Memoria al ${d.mem}%`, 'warn');
      if (d.disk > 90) await throttledAlert(device, 'disk', `Disco al ${d.disk}%`, 'high');
      return;
    }

    case 'security': {
      const findings = Array.isArray(msg.findings) ? msg.findings.slice(0, 200) : [];
      const prevIds = new Set((device.security || []).map((f) => f.id));
      for (const f of findings) {
        if (!prevIds.has(f.id) && f.severity !== 'info') {
          await audit(device, 'security', f.title, f.severity === 'high' ? 'high' : 'warn');
        }
      }
      device.security = findings;
      device.securityAt = new Date();
      await device.save();
      notifyUser(device.userId, { type: 'security', deviceId: device._id, findings });
      return;
    }

    case 'chat': {
      // Ej.: el teléfono escucha tu voz y manda el texto aquí
      const text = String(msg.text || '').slice(0, 4000);
      if (!text) return;
      try {
        const reply = await chat({ userId: device.userId, text, fromDevice: device });
        send(ws, { type: 'chat_reply', id: msg.id, text: reply.text, actions: reply.actions });
        notifyUser(device.userId, { type: 'chat', source: device.name, user: text, assistant: reply.text });
      } catch (e) {
        console.error('[chat]', e);
        send(ws, { type: 'chat_reply', id: msg.id, text: 'Lo siento, tuve un problema al pensar la respuesta.', error: true });
      }
      return;
    }
  }
}

export function attachWS(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    let device = null;
    let user = null;
    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 10_000);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Primer mensaje obligatorio: { type: "auth", key } (dispositivo) o { type: "auth", token } (web)
      if (!device && !user) {
        if (msg.type !== 'auth') return ws.close(4001, 'auth required');
        clearTimeout(authTimer);
        if (msg.key) device = await deviceFromKey(msg.key);
        else if (msg.token) user = await userFromToken(msg.token);
        if (!device && !user) {
          send(ws, { type: 'auth_error' });
          return ws.close(4003, 'invalid credentials');
        }

        if (device) {
          const id = String(device._id);
          const old = deviceSockets.get(id);
          if (old && old !== ws) old.close(4000, 'replaced');
          deviceSockets.set(id, ws);
          device.online = true;
          device.lastSeen = new Date();
          await device.save();
          send(ws, { type: 'auth_ok', device: { id, name: device.name, type: device.type } });
          await audit(device, 'connect', `${device.name} se conectó`);
          notifyUser(device.userId, { type: 'device', id, online: true });
        } else {
          const id = String(user._id);
          if (!webSockets.has(id)) webSockets.set(id, new Set());
          webSockets.get(id).add(ws);
          send(ws, { type: 'auth_ok', user: { id, name: user.name } });
        }
        return;
      }

      if (device) {
        try {
          // Recargar para no pisar cambios hechos desde la web
          device = (await Device.findById(device._id)) || device;
          await handleDeviceMessage(device, ws, msg);
        } catch (e) {
          console.error('[ws device]', e);
        }
      } else if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
      }
    });

    ws.on('close', async () => {
      clearTimeout(authTimer);
      if (device) {
        const id = String(device._id);
        if (deviceSockets.get(id) === ws) {
          deviceSockets.delete(id);
          const d = await Device.findById(id);
          if (d) {
            d.online = false;
            d.lastSeen = new Date();
            await d.save();
            const sev = d.type === 'server' ? 'high' : 'info';
            await audit(d, 'disconnect', `${d.name} se desconectó`, sev);
            notifyUser(d.userId, { type: 'device', id, online: false });
          }
        }
      }
      if (user) webSockets.get(String(user._id))?.delete(ws);
    });
  });

  // Latido: cierra conexiones muertas cada 30 s
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));

  return wss;
}
