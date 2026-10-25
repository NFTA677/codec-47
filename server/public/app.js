// Interfaz web de CODEC 47 (JS puro, sin frameworks)
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k.nodeType ? k : String(k));
  return e;
};

const state = { token: localStorageGet('c47_token'), user: null, devices: [], ws: null, registering: false };

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && state.token) { logout(); throw new Error('Sesión expirada'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
}

// ---------------- Auth ----------------
async function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  try {
    const s = await api('/auth/status');
    if (!s.hasUsers) setRegistering(true);
    else if (!s.registerOpen) $('#auth-toggle').classList.add('hidden');
  } catch {}
}
function setRegistering(on) {
  state.registering = on;
  $('#auth-name').classList.toggle('hidden', !on);
  $('#auth-btn').textContent = on ? 'Crear cuenta' : 'Entrar';
  $('#auth-toggle').textContent = on ? 'Ya tengo cuenta' : 'Crear cuenta';
  $('#auth-sub').textContent = on ? 'Crea tu cuenta (la primera será la dueña del sistema).' : 'Inicia sesión para hablar con tu asistente.';
}
$('#auth-toggle').onclick = () => setRegistering(!state.registering);
$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  $('#auth-err').textContent = '';
  try {
    const body = { email: $('#auth-email').value, password: $('#auth-pass').value, name: $('#auth-name').value };
    const r = await api(state.registering ? '/auth/register' : '/auth/login', { method: 'POST', body });
    state.token = r.token;
    localStorageSet('c47_token', r.token);
    start();
  } catch (err) { $('#auth-err').textContent = err.message; }
};
function logout() {
  state.token = null;
  localStorageSet('c47_token', null);
  state.ws?.close();
  location.reload();
}
$('#logout').onclick = logout;

// ---------------- Navegación ----------------
document.querySelectorAll('.nav').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
function showView(v) {
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + v));
  localStorageSet('c47_view', v);
  if (v === 'devices') loadDevices();
  if (v === 'servers') { loadDevices(); loadAudit(); }
  if (v === 'tasks') loadTasks();
  if (v === 'settings') fillSettings();
}

// ---------------- Chat ----------------
function addMsg(role, text, meta = '', actions = []) {
  const m = el('div', { class: 'msg ' + role }, text);
  if (actions?.length) m.append(el('div', { class: 'acts' }, actions.map((a) => el('span', { class: 'chip' + (a.ok ? '' : ' fail') }, `${a.device}: ${a.action}`))));
  if (meta) m.append(el('span', { class: 'meta' }, meta));
  $('#messages').append(m);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}
async function loadMessages() {
  $('#messages').innerHTML = '';
  const msgs = await api('/messages?limit=60');
  if (!msgs.length) addMsg('assistant', `¡Hola${state.user?.name ? ' ' + state.user.name : ''}! Soy CODEC 47. Pregúntame la hora, el clima, tus pendientes o dime que ponga música en tu PC.`);
  for (const m of msgs) addMsg(m.role, m.content, m.source !== 'web' ? `desde ${m.source}` : '');
}
async function sendChat(text) {
  if (!text.trim()) return;
  addMsg('user', text);
  $('#orb').classList.add('thinking');
  try {
    const r = await api('/chat', { method: 'POST', body: { text } });
    addMsg('assistant', r.text, '', r.actions);
    speak(r.text);
  } catch (e) {
    addMsg('assistant', '⚠️ ' + e.message);
  } finally { $('#orb').classList.remove('thinking'); }
}
$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#chat-input').value;
  $('#chat-input').value = '';
  sendChat(t);
};
$('#clear-chat').onclick = async () => {
  if (!confirm('¿Borrar todo el historial de conversación?')) return;
  await api('/messages', { method: 'DELETE' });
  loadMessages();
};

// Voz: hablar (TTS) y escuchar (reconocimiento de voz del navegador)
$('#tts-toggle').checked = localStorageGet('c47_tts') !== '0';
$('#tts-toggle').onchange = (e) => localStorageSet('c47_tts', e.target.checked ? '1' : '0');
function speak(text) {
  if (!$('#tts-toggle').checked || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'es-MX';
  const v = speechSynthesis.getVoices().find((v) => v.lang.startsWith('es'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
$('#mic').onclick = () => {
  if (!SR) return alert('Tu navegador no soporta reconocimiento de voz. Usa Chrome o Edge.');
  if (rec) { rec.stop(); return; }
  speechSynthesis?.cancel();
  rec = new SR();
  rec.lang = 'es-MX';
  rec.interimResults = true;
  rec.onresult = (e) => {
    const t = Array.from(e.results).map((r) => r[0].transcript).join('');
    $('#chat-input').value = t;
    if (e.results[e.results.length - 1].isFinal) { $('#chat-input').value = ''; sendChat(t); }
  };
  rec.onend = () => { rec = null; $('#mic').classList.remove('on'); $('#orb').classList.remove('listening'); };
  rec.start();
  $('#mic').classList.add('on');
  $('#orb').classList.add('listening');
};

// ---------------- Dispositivos ----------------
const TYPE_LABEL = { android: 'Android', chrome: 'Chrome', pc: 'PC', server: 'Servidor' };
const QUICK = {
  android: [['🔦 Linterna', 'flashlight', { on: true }], ['🔦 Apagar', 'flashlight', { on: false }], ['⏯️ Música', 'media', { cmd: 'play' }], ['🔋 Batería', 'battery', {}]],
  chrome: [['⏯️ Play/Pausa', 'media', { cmd: 'play' }], ['⏭️ Siguiente', 'media', { cmd: 'next' }], ['📑 Pestañas', 'list_tabs', {}]],
  pc: [['📊 Estado', 'status', {}], ['🛡️ Escanear', 'security_scan', {}], ['🔒 Bloquear', 'lock', {}], ['⏯️ Media', 'media', { cmd: 'play' }]],
  server: [['📊 Estado', 'status', {}], ['🛡️ Escanear', 'security_scan', {}]],
};

async function loadDevices() {
  state.devices = await api('/devices');
  renderDevices();
  renderServers();
}
function ago(d) {
  if (!d) return 'nunca';
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return new Date(d).toLocaleString();
}
function renderDevices() {
  const list = $('#device-list');
  list.innerHTML = '';
  if (!state.devices.length) list.append(el('p', { class: 'muted' }, 'Aún no tienes dispositivos. Pulsa “+ Agregar”.'));
  for (const d of state.devices) {
    const out = el('div', { class: 'muted small' });
    list.append(
      el('div', { class: 'card' },
        el('h3', {}, el('span', { class: 'dot' + (d.online ? ' on' : '') }), d.name, el('span', { class: 'badge' }, TYPE_LABEL[d.type])),
        el('div', { class: 'muted small' }, d.online ? 'En línea' : 'Visto ' + ago(d.lastSeen)),
        d.info?.os ? el('div', { class: 'muted small' }, d.info.os) : null,
        el('div', { class: 'actions' },
          (QUICK[d.type] || []).map(([label, action, params]) =>
            el('button', { class: 'btn small', onclick: async () => {
              out.textContent = '…';
              try { const r = await api(`/devices/${d.id}/command`, { method: 'POST', body: { action, params } }); out.textContent = r.ok ? fmt(r.output) : '⚠️ ' + r.error; }
              catch (e) { out.textContent = '⚠️ ' + e.message; }
            } }, label)),
          el('button', { class: 'btn small ghost', onclick: () => rotateKey(d) }, '🔑 Nueva clave'),
          el('button', { class: 'btn small ghost danger', onclick: () => removeDevice(d) }, 'Eliminar')
        ),
        out
      )
    );
  }
}
const fmt = (o) => (typeof o === 'string' ? o : JSON.stringify(o ?? 'ok'));

function modal(build) {
  const body = $('#modal-body');
  body.innerHTML = '';
  build(body);
  $('#modal').showModal();
}
function showKey(name, key) {
  modal((b) => b.append(
    el('h3', {}, `Clave de “${name}”`),
    el('p', { class: 'muted small' }, 'Cópiala ahora: no se volverá a mostrar. Pégala en la app/extensión/agente junto con la URL del servidor.'),
    el('div', { class: 'keybox' }, key),
    el('div', { class: 'muted small' }, 'Servidor: ' + location.origin),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn', onclick: () => navigator.clipboard.writeText(key) }, 'Copiar clave'),
      el('button', { class: 'btn primary' }, 'Listo'))
  ));
}
$('#add-device').onclick = () => modal((b) => {
  const name = el('input', { placeholder: 'Nombre, ej. “Mi Pixel”, “Laptop”, “VPS Render”', required: '' });
  const type = el('select', {}, Object.entries(TYPE_LABEL).map(([v, l]) => el('option', { value: v }, l)));
  const err = el('p', { class: 'error' });
  b.append(el('h3', {}, 'Agregar dispositivo'), name, type, err,
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn ghost', onclick: () => $('#modal').close() }, 'Cancelar'),
      el('button', { type: 'button', class: 'btn primary', onclick: async () => {
        try {
          const r = await api('/devices', { method: 'POST', body: { name: name.value, type: type.value } });
          $('#modal').close();
          await loadDevices();
          showKey(r.device.name, r.key);
        } catch (e) { err.textContent = e.message; }
      } }, 'Crear')));
});
async function rotateKey(d) {
  if (!confirm(`¿Generar una nueva clave para ${d.name}? La anterior dejará de funcionar.`)) return;
  const r = await api(`/devices/${d.id}/rotate-key`, { method: 'POST' });
  showKey(d.name, r.key);
}
async function removeDevice(d) {
  if (!confirm(`¿Eliminar ${d.name}?`)) return;
  await api('/devices/' + d.id, { method: 'DELETE' });
  loadDevices();
}

// ---------------- Servidores ----------------
function meter(label, v) {
  const val = Number(v ?? 0);
  const fill = el('div', { class: 'fill' + (val > 90 ? ' bad' : val > 75 ? ' warn' : '') });
  fill.style.width = Math.min(100, val) + '%';
  return el('div', { class: 'meter' }, el('div', { class: 'lbl' }, el('span', {}, label), el('span', {}, v == null ? '—' : val.toFixed(0) + '%')), el('div', { class: 'bar' }, fill));
}
function sparkline(rows, key) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', '0 0 100 30');
  svg.setAttribute('preserveAspectRatio', 'none');
  if (rows.length > 1) {
    const pts = rows.map((r, i) => `${(i / (rows.length - 1)) * 100},${30 - ((r[key] ?? 0) / 100) * 30}`).join(' ');
    const p = document.createElementNS(ns, 'polyline');
    p.setAttribute('points', pts);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', key === 'cpu' ? '#3ad1ff' : '#76b900');
    p.setAttribute('stroke-width', '1.2');
    p.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(p);
  }
  return svg;
}
async function renderServers() {
  const list = $('#server-list');
  if ($('#view-servers').classList.contains('hidden')) return;
  list.innerHTML = '';
  const servers = state.devices.filter((d) => d.type === 'server' || d.type === 'pc');
  if (!servers.length) list.append(el('p', { class: 'muted' }, 'Agrega un dispositivo tipo Servidor o PC y ejecuta el agente para ver su rendimiento y seguridad.'));
  for (const d of servers) {
    const m = d.metrics || {};
    const card = el('div', { class: 'card', id: 'srv-' + d.id },
      el('h3', {}, el('span', { class: 'dot' + (d.online ? ' on' : '') }), d.name, el('span', { class: 'badge' }, TYPE_LABEL[d.type])),
      el('div', { class: 'muted small' }, d.online ? `En línea · uptime ${m.uptimeH ?? '—'} h` : 'Desconectado · visto ' + ago(d.lastSeen)),
      meter('CPU', m.cpu), meter('RAM', m.mem), meter('Disco', m.disk));
    const spark = el('div');
    card.append(spark);
    const findings = (d.security || []).filter((f) => f.severity !== 'info');
    card.append(el('div', { class: 'small muted' }, `Seguridad: ${findings.length ? findings.length + ' hallazgo(s)' : 'sin problemas'} · ${d.securityAt ? ago(d.securityAt) : 'sin escanear'}`));
    if (findings.length) card.append(el('ul', { class: 'findings' }, findings.map((f) => el('li', { class: 'sev-' + f.severity }, `● ${f.title}`, f.fix ? el('div', { class: 'muted small' }, f.fix) : null))));
    list.append(card);
    api(`/devices/${d.id}/metrics?hours=24`).then((rows) => spark.append(sparkline(rows, 'cpu'), sparkline(rows, 'mem'))).catch(() => {});
  }
}
async function loadAudit() {
  const sev = $('#audit-filter').value;
  const rows = await api('/audit?limit=150' + (sev ? '&severity=' + sev : ''));
  const list = $('#audit-list');
  list.innerHTML = '';
  if (!rows.length) list.append(el('p', { class: 'muted' }, 'Sin eventos.'));
  for (const r of rows) list.append(auditRow(r));
}
const auditRow = (r) => el('div', { class: 'ev' },
  el('span', { class: 'muted' }, new Date(r.createdAt).toLocaleString()),
  el('span', { class: 'sev-' + r.severity }, `${r.deviceName || ''} · ${r.kind}`),
  el('span', {}, r.detail));
$('#audit-filter').onchange = loadAudit;

// ---------------- Pendientes ----------------
async function loadTasks() {
  const tasks = await api('/tasks');
  const ul = $('#task-list');
  ul.innerHTML = '';
  if (!tasks.length) ul.append(el('li', { class: 'muted' }, 'Nada pendiente. 🎉'));
  for (const t of tasks) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = t.done;
    cb.onchange = async () => { await api('/tasks/' + t._id, { method: 'PATCH', body: { done: cb.checked } }); loadTasks(); };
    ul.append(el('li', { class: t.done ? 'done' : '' }, cb, el('span', { class: 'grow' }, t.title),
      t.due ? el('span', { class: 'muted small' }, new Date(t.due).toLocaleString()) : null,
      el('button', { class: 'btn small ghost', onclick: async () => { await api('/tasks/' + t._id, { method: 'DELETE' }); loadTasks(); } }, '✕')));
  }
}
$('#task-form').onsubmit = async (e) => {
  e.preventDefault();
  const due = $('#task-due').value;
  await api('/tasks', { method: 'POST', body: { title: $('#task-title').value, due: due ? new Date(due).toISOString() : undefined } });
  $('#task-title').value = '';
  $('#task-due').value = '';
  loadTasks();
};

// ---------------- Ajustes ----------------
function fillSettings() {
  $('#me-name').value = state.user?.name || '';
  $('#me-city').value = state.user?.city || '';
  $('#me-tz').value = state.user?.tz || '';
  $('#agent-cmd').textContent = `curl -O ${location.origin}/download/agent.js && node agent.js --server ${location.origin} --key TU_CLAVE`;
}
$('#me-form').onsubmit = async (e) => {
  e.preventDefault();
  state.user = await api('/me', { method: 'PATCH', body: { name: $('#me-name').value, city: $('#me-city').value, tz: $('#me-tz').value } });
  alert('Guardado');
};

// ---------------- Tiempo real ----------------
function connectWS() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: state.token }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'auth_ok') $('#ws-status').textContent = '● en vivo';
    if (m.type === 'device') {
      const d = state.devices.find((x) => x.id === m.id);
      if (d) { d.online = m.online; d.lastSeen = new Date(); renderDevices(); renderServers(); }
    }
    if (m.type === 'metrics') {
      const d = state.devices.find((x) => x.id === m.deviceId);
      if (d) { d.metrics = m.metrics; if (!$('#view-servers').classList.contains('hidden')) renderServers(); }
    }
    if (m.type === 'security') {
      const d = state.devices.find((x) => x.id === m.deviceId);
      if (d) { d.security = m.findings; d.securityAt = new Date(); renderServers(); }
    }
    if (m.type === 'audit') {
      if (!$('#view-servers').classList.contains('hidden')) $('#audit-list').prepend(auditRow(m.event));
      if (m.event.severity === 'high' && 'Notification' in window && Notification.permission === 'granted')
        new Notification('CODEC 47 · ' + (m.event.deviceName || ''), { body: m.event.detail });
    }
    if (m.type === 'chat') {
      // Conversación hecha desde otro dispositivo (ej. el teléfono): se continúa aquí
      addMsg('user', m.user, 'desde ' + m.source);
      addMsg('assistant', m.assistant);
    }
  };
  const pinger = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 25_000);
  ws.onclose = () => {
    clearInterval(pinger);
    $('#ws-status').textContent = '● reconectando…';
    if (state.token) setTimeout(connectWS, 3000);
  };
}

// ---------------- Inicio ----------------
async function start() {
  if (!state.token) return showAuth();
  try { state.user = await api('/me'); } catch { return showAuth(); }
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz && tz !== state.user.tz) api('/me', { method: 'PATCH', body: { tz } }).then((u) => (state.user = u)).catch(() => {});
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  await loadMessages();
  await loadDevices();
  connectWS();
  showView(localStorageGet('c47_view') || 'chat');
}
start();
