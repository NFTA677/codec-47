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

// Íconos de línea (estilo Lucide), sin emojis
const ICONS = {
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  devices: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  whatsapp: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
  tasks: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  next: '<path d="M5 4v16l11-8zM19 5v14"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  light: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
  battery: '<rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  tabs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}
document.querySelectorAll('i[data-icon]').forEach((i) => i.replaceWith(icon(i.dataset.icon)));
const TYPE_ICON = { android: 'devices', chrome: 'globe', pc: 'monitor', server: 'server' };

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
  if (v === 'downloads') {
    $('#agent-cmd2').textContent = `node agent.js --server ${location.origin} --key TU_CLAVE`;
    fetch('/downloads/version.json').then((r) => r.json()).then((j) => ($('#apk-version').textContent = 'v' + j.versionName)).catch(() => {});
  }
  if (v === 'whatsapp') loadWhatsApp();
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
async function sendChat(text, fromVoice = false) {
  if (!text.trim()) return;
  addMsg('user', text);
  $('#orb').classList.add('thinking');
  try {
    const r = await api('/chat', { method: 'POST', body: { text } });
    addMsg('assistant', r.text, '', r.actions);
    // En conversación por voz, al terminar de hablar vuelve a escuchar (salvo que te despidas)
    const bye = /^(ad[ií]os|chao|eso es todo|gracias,? eso es todo|para|detente|silencio|nada m[aá]s)/i.test(text.trim());
    speak(r.text, fromVoice && !bye);
  } catch (e) {
    addMsg('assistant', 'Error: ' + e.message);
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

// ---------------- Voz ----------------
// Habla con la voz neuronal de NVIDIA (la misma del teléfono). Si falla, usa la del navegador.
$('#tts-toggle').checked = localStorageGet('c47_tts') !== '0';
$('#tts-toggle').onchange = (e) => localStorageSet('c47_tts', e.target.checked ? '1' : '0');
$('#conv-toggle').checked = localStorageGet('c47_conv') !== '0';
$('#conv-toggle').onchange = (e) => localStorageSet('c47_conv', e.target.checked ? '1' : '0');

let audioEl = null;
function stopSpeaking() {
  if (audioEl) { audioEl.pause(); audioEl = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
async function speak(text, thenListen = false, voice) {
  stopSpeaking();
  const after = () => { $('#orb').classList.remove('speaking'); if (thenListen && $('#conv-toggle').checked) setTimeout(startMic, 250); };
  if (!$('#tts-toggle').checked) return after();
  $('#orb').classList.add('speaking');
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) throw new Error('tts ' + res.status);
    const url = URL.createObjectURL(await res.blob());
    const a = new Audio(url);
    audioEl = a;
    a.onended = () => { URL.revokeObjectURL(url); if (audioEl === a) { audioEl = null; after(); } };
    await a.play();
  } catch (e) {
    browserSpeak(text, after);
  }
}
function browserSpeak(text, done) {
  if (!('speechSynthesis' in window)) return done();
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('es'));
  const male = voices.find((v) => /jorge|pablo|alvaro|diego|raul|male|hombre/i.test(v.name)) || voices[0];
  const parts = text.replace(/[\p{Extended_Pictographic}*_#`]/gu, '').match(/[^.!?¡¿]+[.!?]*|[¡¿][^.!?]+[.!?]*/g) || [text];
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.trim());
    if (male) u.voice = male;
    u.lang = male?.lang || 'es-MX';
    u.rate = 1.05;
    u.pitch = 0.85;
    if (i === parts.length - 1) u.onend = done;
    speechSynthesis.speak(u);
  });
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function startMic() {
  if (!SR) return alert('Tu navegador no soporta reconocimiento de voz. Usa Chrome o Edge.');
  if (rec) return;
  stopSpeaking();
  rec = new SR();
  rec.lang = 'es-PE';
  rec.interimResults = true;
  rec.onresult = (e) => {
    const t = Array.from(e.results).map((r) => r[0].transcript).join('');
    $('#chat-input').value = t;
    if (e.results[e.results.length - 1].isFinal) { $('#chat-input').value = ''; rec?.stop(); sendChat(t, true); }
  };
  rec.onend = () => { rec = null; $('#mic').classList.remove('on'); $('#orb').classList.remove('listening'); };
  rec.start();
  $('#mic').classList.add('on');
  $('#orb').classList.add('listening');
}
$('#mic').onclick = () => (rec ? rec.stop() : startMic());

// ---------------- Dispositivos ----------------
const TYPE_LABEL = { android: 'Android', chrome: 'Chrome', pc: 'PC', server: 'Servidor' };
const QUICK = {
  android: [['Linterna', 'flashlight', { on: true }, 'light'], ['Apagar linterna', 'flashlight', { on: false }, 'light'], ['Play / pausa', 'media', { cmd: 'play' }, 'play'], ['Batería', 'battery', {}, 'battery']],
  chrome: [['Play / pausa', 'media', { cmd: 'play' }, 'play'], ['Siguiente', 'media', { cmd: 'next' }, 'next'], ['Pestañas', 'list_tabs', {}, 'tabs']],
  pc: [['Estado', 'status', {}, 'activity'], ['Escanear', 'security_scan', {}, 'shield'], ['Bloquear', 'lock', {}, 'lock'], ['Play / pausa', 'media', { cmd: 'play' }, 'play']],
  server: [['Estado', 'status', {}, 'activity'], ['Escanear', 'security_scan', {}, 'shield']],
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
  if (!state.devices.length) list.append(el('p', { class: 'muted' }, 'Aún no tienes dispositivos. Pulsa Agregar para conectar el primero.'));
  for (const d of state.devices) {
    const out = el('div', { class: 'out' });
    list.append(
      el('div', { class: 'card' },
        el('div', { class: 'card-icon' }, icon(TYPE_ICON[d.type])),
        el('h3', {}, d.name, el('span', { class: 'badge' }, TYPE_LABEL[d.type])),
        el('div', { class: 'muted small row' }, el('span', { class: 'dot' + (d.online ? ' on' : '') }), d.online ? 'En línea' : 'Visto ' + ago(d.lastSeen)),
        d.info?.os ? el('div', { class: 'muted small' }, d.info.os) : null,
        el('div', { class: 'actions' },
          (QUICK[d.type] || []).map(([label, action, params, ic]) =>
            el('button', { class: 'btn small', onclick: async () => {
              out.textContent = '…';
              try { const r = await api(`/devices/${d.id}/command`, { method: 'POST', body: { action, params } }); out.textContent = r.ok ? fmt(r.output) : 'Error: ' + r.error; }
              catch (e) { out.textContent = 'Error: ' + e.message; }
            } }, icon(ic), label)),
          el('button', { class: 'btn small ghost', onclick: () => rotateKey(d) }, icon('key'), 'Nueva clave'),
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
  if (!rows.length) list.append(el('div', { class: 'empty' }, 'Sin eventos.'));
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
  if (!tasks.length) ul.append(el('li', { class: 'muted' }, 'Nada pendiente.'));
  for (const t of tasks) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = t.done;
    cb.onchange = async () => { await api('/tasks/' + t._id, { method: 'PATCH', body: { done: cb.checked } }); loadTasks(); };
    ul.append(el('li', { class: t.done ? 'done' : '' }, cb, el('span', { class: 'grow' }, t.title),
      t.due ? el('span', { class: 'muted small' }, new Date(t.due).toLocaleString()) : null,
      el('button', { class: 'btn small ghost', onclick: async () => { await api('/tasks/' + t._id, { method: 'DELETE' }); loadTasks(); } }, icon('x'))));
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
async function loadVoices() {
  const { voices, current } = await api('/voices');
  $('#me-voice').innerHTML = '';
  for (const v of voices) {
    const o = el('option', { value: v.id }, v.label);
    if (v.id === current) o.selected = true;
    $('#me-voice').append(o);
  }
}
$('#voice-test').onclick = () =>
  speak(`Hola${state.user?.name ? ' ' + state.user.name : ''}. Soy CODEC 47. Todos los sistemas están en línea. ¿En qué puedo ayudarte?`, false, $('#me-voice').value);

// ---------------- WhatsApp ----------------
const WA_LABEL = { conectado: 'Vinculado', qr: 'Escanea el QR', codigo: 'Ingresa el código', conectando: 'Conectando…', reconectando: 'Reconectando…', desconectado: 'Sin vincular' };
let waShowPhone = false;

function phoneForm() {
  const input = el('input', { placeholder: 'Tu número con código de país, ej. 51987654321', inputmode: 'tel' });
  const err = el('p', { class: 'error' });
  return el('div', { class: 'form' },
    input, err,
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn primary', onclick: async () => {
        err.textContent = '';
        try { renderWaStatus(await api('/whatsapp/connect', { method: 'POST', body: { phone: input.value } })); }
        catch (e) { err.textContent = e.message; }
      } }, 'Obtener código'),
      el('button', { type: 'button', class: 'btn ghost', onclick: () => { waShowPhone = false; loadWhatsApp(); } }, 'Usar QR')));
}

function renderWaStatus(st) {
  $('#wa-status').textContent = WA_LABEL[st.status] || st.status;
  const b = $('#wa-link-body');
  b.innerHTML = '';
  if (st.lastError && st.status !== 'conectado') b.append(el('p', { class: 'error' }, st.lastError));

  if (st.status === 'conectado') {
    b.append(
      el('p', {}, 'Vinculado ', el('span', { class: 'wa-me' }, st.me ? `${st.me.name || ''} · +${st.me.id}` : '')),
      el('p', { class: 'muted small' }, 'Puedes decirle: “envía un WhatsApp a Carlos diciendo que llego en 10”, “mándale mi ubicación a mamá”, “envíale la última foto a Ana”, “léeme mis WhatsApp”.'),
      el('div', { class: 'actions' }, el('button', { class: 'btn ghost danger', onclick: async () => { if (confirm('¿Desvincular WhatsApp?')) { await api('/whatsapp/logout', { method: 'POST' }); loadWhatsApp(); } } }, 'Desvincular'))
    );
  } else if (st.status === 'codigo' && st.code) {
    b.append(
      el('ol', { class: 'steps small' },
        el('li', {}, 'En WhatsApp: Dispositivos vinculados → Vincular un dispositivo.'),
        el('li', {}, 'Toca “Vincular con el número de teléfono” (abajo).'),
        el('li', {}, 'Escribe este código:')),
      el('div', { class: 'code' }, st.code),
      el('p', { class: 'muted small' }, 'El código vence en unos minutos.'));
  } else if (st.status === 'qr' && st.qr && !waShowPhone) {
    b.append(
      el('ol', { class: 'steps small' },
        el('li', {}, 'Abre WhatsApp en tu teléfono.'),
        el('li', {}, 'Configuración → Dispositivos vinculados → Vincular un dispositivo.'),
        el('li', {}, 'Escanea este código:')),
      el('img', { class: 'qr', src: st.qr, alt: 'Código QR de WhatsApp' }),
      el('button', { class: 'link small', onclick: () => { waShowPhone = true; renderWaStatus(st); } }, '¿No funciona el QR? Vincular con un código'));
  } else if (waShowPhone) {
    b.append(el('p', { class: 'muted small' }, 'Recibirás un código de 8 letras para escribir en WhatsApp → Dispositivos vinculados → Vincular con el número de teléfono.'), phoneForm());
  } else if (st.status === 'conectando' || st.status === 'reconectando') {
    b.append(el('p', { class: 'muted' }, 'Preparando la vinculación…'));
  } else {
    b.append(
      el('p', { class: 'muted small' }, 'CODEC se conecta como un dispositivo vinculado, igual que WhatsApp Web. Tu teléfono sigue funcionando normal.'),
      el('p', { class: 'muted small' }, 'Aviso: es una conexión no oficial. WhatsApp podría limitar cuentas que envían demasiados mensajes automáticos.'),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', onclick: async () => { waShowPhone = false; renderWaStatus(await api('/whatsapp/connect', { method: 'POST' })); } }, 'Vincular con QR'),
        el('button', { class: 'btn', onclick: () => { waShowPhone = true; renderWaStatus(st); } }, 'Vincular con código')));
  }
}

function fmtTime(d) {
  const t = new Date(d);
  return t.toDateString() === new Date().toDateString() ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : t.toLocaleDateString();
}

function chatRow(c, open = false) {
  const auto = el('input', { type: 'checkbox' });
  auto.checked = c.auto;
  auto.onchange = () => api('/whatsapp/chats/' + encodeURIComponent(c.jid), { method: 'PATCH', body: { auto: auto.checked } });
  const out = el('div', { class: 'out' });
  const detail = el('div', { class: 'chat-detail' + (open ? '' : ' hidden') });
  const row = el('div', { class: 'chat-row', 'data-jid': c.jid },
    el('div', {},
      el('div', { class: 'who' }, c.name || c.jid.split('@')[0]),
      el('div', { class: 'prev' }, (c.lastFromMe ? 'Tú: ' : '') + (c.last || ''), ' · ', fmtTime(c.at))),
    el('div', { class: 'ctrl' },
      el('label', { class: 'toggle', title: 'Responder automáticamente en este chat' }, el('span', { class: 'switch' }, auto, el('span')), 'Auto'),
      el('button', { class: 'btn small', title: 'Retoma la conversación y responde de forma natural', onclick: async (e) => {
        e.target.disabled = true; out.textContent = 'Escribiendo…';
        try { const r = await api('/whatsapp/chats/' + encodeURIComponent(c.jid) + '/continue', { method: 'POST' }); out.textContent = 'Enviado: ' + r.text; if (!detail.classList.contains('hidden')) openChat(c, detail); }
        catch (err) { out.textContent = 'Error: ' + err.message; }
        e.target.disabled = false;
      } }, 'Continuar'),
      el('button', { class: 'btn small ghost', onclick: () => { detail.classList.toggle('hidden'); if (!detail.classList.contains('hidden')) openChat(c, detail); } }, 'Ver')),
    out, detail);
  out.style.gridColumn = '1 / -1';
  return row;
}

async function openChat(c, detail) {
  const msgs = await api('/whatsapp/chats/' + encodeURIComponent(c.jid));
  const instr = el('input', { placeholder: 'Instrucciones solo para este chat (ej.: es mi jefe, sé formal)', value: c.instructions || '' });
  detail.innerHTML = '';
  const bubbles = el('div', { class: 'bubbles' }, msgs.map((m) => el('div', { class: 'b' + (m.fromMe ? ' me' : '') }, m.text, el('small', {}, (m.auto ? 'CODEC · ' : '') + fmtTime(m.at)))));
  detail.append(bubbles,
    el('div', { class: 'row' }, instr, el('button', { class: 'btn small', onclick: async () => { await api('/whatsapp/chats/' + encodeURIComponent(c.jid), { method: 'PATCH', body: { instructions: instr.value } }); c.instructions = instr.value; } }, 'Guardar')));
  bubbles.scrollTop = bubbles.scrollHeight;
}

async function loadWaChats() {
  const chats = await api('/whatsapp/chats');
  const list = $('#wa-chats');
  list.innerHTML = '';
  if (!chats.length) list.append(el('div', { class: 'empty' }, 'Aún no hay chats. Cuando te escriban por WhatsApp aparecerán aquí.'));
  for (const c of chats) list.append(chatRow(c));
}

async function loadWhatsApp() {
  const st = await api('/whatsapp');
  renderWaStatus(st);
  const w = st.settings || {};
  $('#wa-privacy').checked = !!w.privacy;
  document.querySelector(`input[name=wa-scope][value=${w.replyAll ? 'all' : 'some'}]`).checked = true;
  $('#wa-allow').value = (w.allow || []).join('\n');
  $('#wa-intro-on').checked = w.introEnabled !== false;
  $('#wa-intro').value = w.intro || '';
  $('#wa-intro').placeholder = st.defaultIntro || '';
  $('#wa-instr').value = w.instructions || '';
  loadWaChats().catch(() => {});
}
$('#wa-form').onsubmit = async (e) => {
  e.preventDefault();
  await api('/whatsapp/settings', { method: 'PATCH', body: {
    privacy: $('#wa-privacy').checked,
    replyAll: document.querySelector('input[name=wa-scope]:checked')?.value === 'all',
    allow: $('#wa-allow').value.split('\n'),
    introEnabled: $('#wa-intro-on').checked,
    intro: $('#wa-intro').value,
    instructions: $('#wa-instr').value } });
  const btn = e.submitter; if (btn) { btn.textContent = 'Guardado'; setTimeout(() => (btn.textContent = 'Guardar'), 1500); }
};

function fillSettings() {
  loadVoices().catch(() => {});
  $('#me-name').value = state.user?.name || '';
  $('#me-city').value = state.user?.city || '';
  $('#me-tz').value = state.user?.tz || '';
  $('#agent-cmd').textContent = `curl -O ${location.origin}/download/agent.js && node agent.js --server ${location.origin} --key TU_CLAVE`;
}
$('#me-form').onsubmit = async (e) => {
  e.preventDefault();
  state.user = await api('/me', { method: 'PATCH', body: { name: $('#me-name').value, city: $('#me-city').value, tz: $('#me-tz').value, voice: $('#me-voice').value } });
  alert('Guardado');
};

// ---------------- Tiempo real ----------------
function connectWS() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: state.token }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'auth_ok') { $('#ws-status').textContent = 'En vivo'; $('#ws-dot').classList.add('on'); }
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
    if (m.type === 'wa' && !$('#view-whatsapp').classList.contains('hidden')) renderWaStatus(m);
    if (m.type === 'wa_msg' && !$('#view-whatsapp').classList.contains('hidden')) { clearTimeout(state.waT); state.waT = setTimeout(() => loadWaChats().catch(() => {}), 600); }
    if (m.type === 'chat') {
      // Conversación hecha desde otro dispositivo (ej. el teléfono): se continúa aquí
      addMsg('user', m.user, 'desde ' + m.source);
      addMsg('assistant', m.assistant);
    }
  };
  const pinger = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 25_000);
  ws.onclose = () => {
    clearInterval(pinger);
    $('#ws-status').textContent = 'Reconectando…'; $('#ws-dot').classList.remove('on');
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
