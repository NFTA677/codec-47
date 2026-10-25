#!/usr/bin/env node
// Agente CODEC 47 para PCs y servidores (Windows, Linux, macOS). Sin dependencias, Node 22+.
//
//   node agent.js --server https://tu-app.onrender.com --key c47_xxx
//
// Opciones (también por variables de entorno o agent/config.json):
//   --server / CODEC_SERVER     URL del servidor
//   --key    / CODEC_KEY        clave del dispositivo (créala en la web → Dispositivos)
//   --allow-power / CODEC_ALLOW_POWER=1   permite apagar/reiniciar
//   --allow-shell / CODEC_ALLOW_SHELL=1   permite ejecutar comandos (¡cuidado!)
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
let fileCfg = {};
try {
  fileCfg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json'), 'utf8'));
} catch {}

const CFG = {
  server: (opt('--server') || process.env.CODEC_SERVER || fileCfg.server || '').replace(/\/+$/, ''),
  key: opt('--key') || process.env.CODEC_KEY || fileCfg.key,
  allowPower: flag('--allow-power') || process.env.CODEC_ALLOW_POWER === '1' || !!fileCfg.allowPower,
  allowShell: flag('--allow-shell') || process.env.CODEC_ALLOW_SHELL === '1' || !!fileCfg.allowShell,
  metricsEvery: 30_000,
  securityEvery: 30 * 60_000,
};

if (!CFG.server || !CFG.key) {
  console.error('Uso: node agent.js --server https://tu-app.onrender.com --key c47_xxx');
  process.exit(1);
}
if (typeof WebSocket === 'undefined') {
  console.error('Necesitas Node 22 o superior (WebSocket nativo).');
  process.exit(1);
}

const PLATFORM = process.platform; // win32 | linux | darwin
const log = (...a) => console.log(new Date().toISOString(), ...a);

function run(cmd, cmdArgs = [], timeout = 30_000) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
    });
  });
}
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);

// ---------------- Métricas ----------------
let lastCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i]?.times || c.times;
    const t = c.times;
    idle += t.idle - p.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle - (p.user + p.nice + p.sys + p.irq + p.idle);
  });
  lastCpu = now;
  return total > 0 ? +(100 * (1 - idle / total)).toFixed(1) : 0;
}

async function diskPercent() {
  try {
    const st = fs.statfsSync(PLATFORM === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/');
    return +(100 * (1 - st.bavail / st.blocks)).toFixed(1);
  } catch {
    return null;
  }
}

async function metrics() {
  return {
    cpu: cpuPercent(),
    mem: +(100 * (1 - os.freemem() / os.totalmem())).toFixed(1),
    disk: await diskPercent(),
    load: +os.loadavg()[0].toFixed(2),
    uptimeH: +(os.uptime() / 3600).toFixed(1),
    memTotalGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    cpus: os.cpus().length,
  };
}

// ---------------- Auditoría de seguridad ----------------
const RISKY_PORTS = {
  21: 'FTP', 23: 'Telnet', 25: 'SMTP', 110: 'POP3', 135: 'RPC', 139: 'NetBIOS', 445: 'SMB',
  1433: 'SQL Server', 2375: 'Docker sin TLS', 3306: 'MySQL', 3389: 'Escritorio remoto (RDP)',
  5432: 'PostgreSQL', 5900: 'VNC', 6379: 'Redis', 9200: 'Elasticsearch', 11211: 'Memcached', 27017: 'MongoDB',
};

async function securityScan() {
  const f = [];
  const add = (id, severity, title, fix) => f.push({ id, severity, title, fix });

  // Puertos escuchando en todas las interfaces
  let listening = [];
  if (PLATFORM === 'linux') {
    const r = await run('ss', ['-tulnH']);
    listening = r.out.split('\n').map((l) => l.trim().split(/\s+/)[4]).filter(Boolean);
  } else {
    const r = await run('netstat', ['-an']);
    listening = r.out.split('\n').filter((l) => /LISTEN/i.test(l)).map((l) => l.trim().split(/\s+/)[PLATFORM === 'win32' ? 1 : 3]);
  }
  const publicPorts = new Set();
  for (const addr of listening) {
    const m = String(addr).match(/^(.*)[:.](\d+)$/);
    if (!m) continue;
    const host = m[1];
    const port = Number(m[2]);
    if (/^(0\.0\.0\.0|\*|\[::\]|::|)$/.test(host)) publicPorts.add(port);
  }
  for (const p of publicPorts) {
    if (RISKY_PORTS[p]) add(`port-${p}`, [23, 2375, 6379, 27017, 9200, 11211].includes(p) ? 'high' : 'warn',
      `Puerto ${p} (${RISKY_PORTS[p]}) abierto a toda la red`, 'Ciérralo en el firewall o limítalo a IPs de confianza');
  }
  add('ports', 'info', `Puertos públicos: ${[...publicPorts].sort((a, b) => a - b).join(', ') || 'ninguno'}`);

  if (PLATFORM === 'linux') {
    // SSH
    try {
      const sshd = fs.readFileSync('/etc/ssh/sshd_config', 'utf8');
      const val = (k) => sshd.match(new RegExp(`^\\s*${k}\\s+(\\S+)`, 'mi'))?.[1]?.toLowerCase();
      if (val('PermitRootLogin') === 'yes') add('ssh-root', 'high', 'SSH permite login directo como root', 'Pon PermitRootLogin no');
      if (val('PasswordAuthentication') !== 'no') add('ssh-pass', 'warn', 'SSH acepta contraseñas', 'Usa solo llaves: PasswordAuthentication no');
    } catch {}
    // Firewall
    const ufw = await run('ufw', ['status']);
    if (ufw.ok && /inactive/i.test(ufw.out)) add('fw', 'high', 'El firewall (ufw) está desactivado', 'sudo ufw enable');
    if (!ufw.ok) {
      const nft = await run('nft', ['list', 'ruleset']);
      if (nft.ok && !nft.out.trim()) add('fw', 'warn', 'No hay reglas de firewall (nftables vacío)', 'Configura ufw o nftables');
    }
    // Intentos fallidos de SSH en la última hora
    const j = await run('journalctl', ['-u', 'ssh', '-u', 'sshd', '--since', '1 hour ago', '--no-pager', '-q']);
    if (j.ok) {
      const fails = (j.out.match(/Failed password|Invalid user/g) || []).length;
      if (fails > 20) add('ssh-brute', 'high', `${fails} intentos de login SSH fallidos en la última hora (posible ataque)`, 'Instala fail2ban');
      else if (fails > 0) add('ssh-fails', 'info', `${fails} intentos SSH fallidos en la última hora`);
    }
    // Actualizaciones pendientes
    const apt = await run('sh', ['-c', 'apt list --upgradable 2>/dev/null | grep -ci security'], 20_000);
    const n = parseInt(apt.out, 10);
    if (n > 0) add('updates', 'warn', `${n} actualizaciones de seguridad pendientes`, 'sudo apt update && sudo apt upgrade');
    // Usuarios con UID 0 aparte de root
    try {
      const roots = fs.readFileSync('/etc/passwd', 'utf8').split('\n').filter((l) => l.split(':')[2] === '0').map((l) => l.split(':')[0]);
      if (roots.length > 1) add('uid0', 'high', `Usuarios con privilegios de root: ${roots.join(', ')}`, 'Revisa /etc/passwd');
    } catch {}
  }

  if (PLATFORM === 'win32') {
    const fw = await run('netsh', ['advfirewall', 'show', 'allprofiles', 'state']);
    if (/OFF|DESACTIVADO|INACTIVO/i.test(fw.out)) add('fw', 'high', 'Algún perfil del Firewall de Windows está desactivado', 'Actívalo en Seguridad de Windows');
    const def = await ps('Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled,AntivirusSignatureAge | ConvertTo-Json');
    try {
      const d = JSON.parse(def.out);
      if (d.RealTimeProtectionEnabled === false) add('av', 'high', 'La protección en tiempo real de Defender está apagada', 'Actívala en Seguridad de Windows');
      if (d.AntivirusSignatureAge > 7) add('av-sig', 'warn', `Firmas del antivirus con ${d.AntivirusSignatureAge} días de antigüedad`, 'Actualiza Windows Defender');
    } catch {}
    const upd = await ps('(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0").Updates.Count');
    const n = parseInt(upd.out, 10);
    if (n > 0) add('updates', 'warn', `${n} actualizaciones de Windows pendientes`, 'Instálalas desde Windows Update');
  }

  const m = await metrics();
  if (m.disk > 90) add('disk', 'high', `Disco casi lleno (${m.disk}%)`, 'Libera espacio');
  return f;
}

// ---------------- Comandos ----------------
const SAFE_NAME = /^[\w .\-]{1,60}$/;

async function openUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Solo URLs http/https');
  if (PLATFORM === 'win32') await run('rundll32.exe', ['url.dll,FileProtocolHandler', u.href]);
  else if (PLATFORM === 'darwin') await run('open', [u.href]);
  else await run('xdg-open', [u.href]);
  return `Abrí ${u.host}`;
}

// Teclas multimedia de Windows (códigos virtuales)
const VK = { play: 179, pause: 179, next: 176, previous: 177, mute: 173, up: 175, down: 174 };

const COMMANDS = {
  status: async () => ({ host: os.hostname(), os: `${os.type()} ${os.release()}`, ...(await metrics()) }),
  security_scan: async () => {
    const findings = await securityScan();
    send({ type: 'security', findings });
    return findings.filter((x) => x.severity !== 'info').map((x) => `${x.severity}: ${x.title}`).join('\n') || 'Sin problemas encontrados';
  },
  open_url: ({ url }) => openUrl(url),
  play_music: ({ query = '', service = 'youtube' }) =>
    service === 'spotify'
      ? openUrl('https://open.spotify.com/search/' + encodeURIComponent(query))
      : openUrl('https://www.youtube.com/results?search_query=' + encodeURIComponent(query)),
  open_app: async ({ name }) => {
    if (!SAFE_NAME.test(name || '')) throw new Error('Nombre de programa no válido');
    if (PLATFORM === 'win32') {
      const r = await ps(`Start-Process '${name}'`);
      if (!r.ok) throw new Error(r.err || 'No pude abrirlo');
    } else if (PLATFORM === 'darwin') await run('open', ['-a', name]);
    else await run('sh', ['-c', `nohup "$0" >/dev/null 2>&1 &`, name]);
    return `Abrí ${name}`;
  },
  media: async ({ cmd = 'play' }) => {
    if (PLATFORM === 'win32') {
      const k = VK[cmd];
      if (!k) throw new Error('Comando multimedia no válido');
      await ps(`(New-Object -ComObject WScript.Shell).SendKeys([char]${k})`);
    } else if (PLATFORM === 'linux') {
      await run('playerctl', [cmd === 'play' || cmd === 'pause' ? 'play-pause' : cmd]);
    } else {
      await run('osascript', ['-e', `tell application "Music" to ${cmd === 'next' ? 'next track' : cmd === 'previous' ? 'previous track' : 'playpause'}`]);
    }
    return 'ok';
  },
  volume: async ({ cmd = 'up' }) => {
    if (PLATFORM === 'win32') {
      const k = VK[cmd];
      if (!k) throw new Error('Usa up, down o mute');
      const times = cmd === 'mute' ? 1 : 5;
      await ps(`$s=New-Object -ComObject WScript.Shell; 1..${times} | % { $s.SendKeys([char]${k}) }`);
    } else if (PLATFORM === 'linux') {
      await run('pactl', ['set-sink-' + (cmd === 'mute' ? 'mute' : 'volume'), '@DEFAULT_SINK@', cmd === 'mute' ? 'toggle' : cmd === 'up' ? '+10%' : '-10%']);
    } else {
      await run('osascript', ['-e', `set volume output volume ((output volume of (get volume settings)) ${cmd === 'down' ? '-' : '+'} 10)`]);
    }
    return 'ok';
  },
  lock: async () => {
    if (PLATFORM === 'win32') await run('rundll32.exe', ['user32.dll,LockWorkStation']);
    else if (PLATFORM === 'darwin') await run('pmset', ['displaysleepnow']);
    else await run('loginctl', ['lock-session']);
    return 'Sesión bloqueada';
  },
  shutdown: async ({ restart = false }) => {
    if (!CFG.allowPower) throw new Error('Apagar/reiniciar está desactivado en este agente (--allow-power)');
    if (PLATFORM === 'win32') await run('shutdown', [restart ? '/r' : '/s', '/t', '30']);
    else await run('shutdown', [restart ? '-r' : '-h', '+1']);
    return restart ? 'Reiniciando en 30-60 s' : 'Apagando en 30-60 s';
  },
  shell: async ({ command }) => {
    if (!CFG.allowShell) throw new Error('Los comandos shell están desactivados en este agente (--allow-shell)');
    const r = PLATFORM === 'win32' ? await ps(String(command)) : await run('sh', ['-c', String(command)], 60_000);
    return (r.out || r.err).slice(0, 4000);
  },
};

// ---------------- Conexión ----------------
let ws = null;
let timers = [];
let backoff = 2000;

function send(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function connect() {
  const url = CFG.server.replace(/^http/, 'ws') + '/ws';
  log('Conectando a', url);
  ws = new WebSocket(url);

  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', key: CFG.key }));

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'auth_ok') {
      backoff = 2000;
      log(`Conectado como "${msg.device.name}" (${msg.device.type})`);
      send({
        type: 'hello',
        info: { os: `${os.type()} ${os.release()} (${os.arch()})`, host: os.hostname(), node: process.version },
        capabilities: Object.keys(COMMANDS),
      });
      const pushMetrics = async () => send({ type: 'metrics', data: await metrics() });
      const pushSecurity = async () => send({ type: 'security', findings: await securityScan() });
      pushMetrics();
      setTimeout(pushSecurity, 5000);
      timers.push(setInterval(pushMetrics, CFG.metricsEvery), setInterval(pushSecurity, CFG.securityEvery));
    } else if (msg.type === 'auth_error') {
      log('Clave inválida. Revisa --key');
      process.exit(2);
    } else if (msg.type === 'command') {
      log('Orden:', msg.action, JSON.stringify(msg.params || {}));
      let res;
      try {
        const fn = COMMANDS[msg.action];
        if (!fn) throw new Error(`Acción no soportada: ${msg.action}`);
        res = { ok: true, output: await fn(msg.params || {}) };
      } catch (err) {
        res = { ok: false, error: err.message };
      }
      send({ type: 'result', id: msg.id, ...res });
    }
  };

  ws.onclose = () => {
    timers.forEach(clearInterval);
    timers = [];
    log(`Desconectado. Reintentando en ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };
  ws.onerror = () => {};
}

connect();
