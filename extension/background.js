// Service worker de la extensión CODEC 47.
// Mantiene un WebSocket con el servidor y ejecuta las órdenes que llegan (ej. "pon música").
let ws = null;
let pinger = null;
let status = 'desconectado';

async function getConfig() {
  const { serverUrl = 'https://codec-47.onrender.com', deviceKey = '' } = await chrome.storage.local.get(['serverUrl', 'deviceKey']);
  return { serverUrl: serverUrl.replace(/\/+$/, ''), deviceKey };
}

function setStatus(s) {
  status = s;
  chrome.action.setBadgeText({ text: s === 'conectado' ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ff5d6c' });
  chrome.runtime.sendMessage({ type: 'status', status: s }).catch(() => {});
}

async function connect() {
  const { serverUrl, deviceKey } = await getConfig();
  if (!serverUrl || !deviceKey) return setStatus('sin configurar');
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;

  const url = serverUrl.replace(/^http/, 'ws') + '/ws';
  try {
    ws = new WebSocket(url);
  } catch (e) {
    return setStatus('URL inválida');
  }
  setStatus('conectando');

  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', key: deviceKey }));
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'auth_ok') {
      setStatus('conectado');
      ws.send(
        JSON.stringify({
          type: 'hello',
          info: { os: navigator.userAgent, app: 'chrome-extension' },
          capabilities: Object.keys(ACTIONS),
        })
      );
    } else if (msg.type === 'auth_error') {
      setStatus('clave inválida');
    } else if (msg.type === 'command') {
      let result;
      try {
        const fn = ACTIONS[msg.action];
        if (!fn) throw new Error(`Acción no soportada en Chrome: ${msg.action}`);
        result = { ok: true, output: await fn(msg.params || {}) };
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      ws?.send(JSON.stringify({ type: 'result', id: msg.id, ...result }));
    } else if (msg.type === 'chat_reply') {
      chrome.runtime.sendMessage({ type: 'chat_reply', text: msg.text }).catch(() => {});
    }
  };
  ws.onclose = () => {
    clearInterval(pinger);
    ws = null;
    if (status === 'conectado' || status === 'conectando') setStatus('desconectado');
  };
  ws.onerror = () => {};

  // Chrome 116+ mantiene vivo el service worker mientras haya tráfico en el WebSocket
  clearInterval(pinger);
  pinger = setInterval(() => ws?.readyState === 1 && ws.send('{"type":"ping"}'), 20_000);
}

// --------- Acciones ---------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForLoad(tabId, timeout = 15_000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(t);
      resolve();
    };
    const listener = (id, info) => id === tabId && info.status === 'complete' && done();
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function openOrReuse(urlPrefix, url) {
  const [existing] = await chrome.tabs.query({ url: urlPrefix + '*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { url, active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return existing;
  }
  return chrome.tabs.create({ url, active: true });
}

// Hace clic en un elemento de la página (reintenta mientras carga)
async function clickInTab(tabId, selectors) {
  for (let i = 0; i < 20; i++) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sels) => {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el) {
            el.click();
            return true;
          }
        }
        return false;
      },
      args: [selectors],
    });
    if (res?.result) return true;
    await sleep(500);
  }
  return false;
}

const ACTIONS = {
  async play_music({ query = '', service = 'youtube', videoId, title }) {
    const q = encodeURIComponent(query);
    // El servidor ya encontró el video exacto: abrirlo directamente hace que suene solo
    if (videoId && service !== 'spotify') {
      const url = service === 'youtube_music' ? `https://music.youtube.com/watch?v=${videoId}` : `https://www.youtube.com/watch?v=${videoId}`;
      const tab = await openOrReuse(service === 'youtube_music' ? 'https://music.youtube.com/' : 'https://www.youtube.com/', url);
      await waitForLoad(tab.id);
      // Si el navegador bloqueó el autoplay, pulsa play
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => setTimeout(() => { const v = document.querySelector('video'); if (v && v.paused) v.play().catch(() => document.querySelector('.ytp-play-button')?.click()); }, 1500),
      }).catch(() => {});
      return `Reproduciendo "${title || query}"`;
    }
    if (service === 'spotify') {
      const tab = await openOrReuse('https://open.spotify.com/', `https://open.spotify.com/search/${q}`);
      await waitForLoad(tab.id);
      const ok = await clickInTab(tab.id, ['[data-testid="top-result-card"] button[data-testid="play-button"]', '[data-testid="play-button"]']);
      return ok ? `Reproduciendo "${query}" en Spotify` : 'Abrí Spotify; inicia sesión para reproducir';
    }
    if (service === 'youtube_music') {
      const tab = await openOrReuse('https://music.youtube.com/', `https://music.youtube.com/search?q=${q}`);
      await waitForLoad(tab.id);
      const ok = await clickInTab(tab.id, ['ytmusic-card-shelf-renderer .play-button', 'ytmusic-responsive-list-item-renderer a']);
      return ok ? `Reproduciendo "${query}" en YouTube Music` : 'Abrí YouTube Music con la búsqueda';
    }
    const tab = await openOrReuse('https://www.youtube.com/', `https://www.youtube.com/results?search_query=${q}`);
    await waitForLoad(tab.id);
    const ok = await clickInTab(tab.id, ['ytd-video-renderer a#video-title', 'a#video-title']);
    return ok ? `Reproduciendo "${query}" en YouTube` : 'Abrí YouTube con la búsqueda';
  },

  async media({ cmd = 'play' }) {
    const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://music.youtube.com/*', 'https://open.spotify.com/*'] });
    const tab = tabs.find((t) => t.audible) || tabs[0];
    if (!tab) throw new Error('No hay ninguna pestaña de música abierta');
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (cmd) => {
        const host = location.host;
        const q = (s) => document.querySelector(s);
        if (host.includes('spotify')) {
          const map = {
            play: '[data-testid="control-button-playpause"]',
            pause: '[data-testid="control-button-playpause"]',
            next: '[data-testid="control-button-skip-forward"]',
            previous: '[data-testid="control-button-skip-back"]',
          };
          q(map[cmd])?.click();
          return 'ok';
        }
        const v = q('video');
        if (cmd === 'next') return (q('.ytp-next-button') || q('.next-button'))?.click(), 'siguiente';
        if (cmd === 'previous') return (q('.previous-button') || history.back()), 'anterior';
        if (!v) return 'sin video';
        if (cmd === 'pause' || (cmd === 'play' && !v.paused)) return v.pause(), 'pausado';
        return v.play(), 'reproduciendo';
      },
      args: [cmd],
    });
    return res?.result || 'ok';
  },

  async open_url({ url }) {
    const u = new URL(url); // valida
    if (!/^https?:$/.test(u.protocol)) throw new Error('Solo se permiten URLs http/https');
    await chrome.tabs.create({ url: u.href, active: true });
    return `Abrí ${u.host}`;
  },

  async search({ query }) {
    await chrome.tabs.create({ url: 'https://www.google.com/search?q=' + encodeURIComponent(query) });
    return 'Búsqueda abierta';
  },

  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.slice(0, 40).map((t) => ({ title: t.title, url: t.url, audible: t.audible, active: t.active }));
  },

  async close_tab({ match }) {
    let tab;
    if (match) {
      const m = match.toLowerCase();
      tab = (await chrome.tabs.query({})).find((t) => (t.title + ' ' + t.url).toLowerCase().includes(m));
    } else {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    }
    if (!tab) throw new Error('No encontré esa pestaña');
    await chrome.tabs.remove(tab.id);
    return `Cerré "${tab.title}"`;
  },
};

// --------- Mensajes del popup ---------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'get_status') reply({ status });
  if (msg.type === 'reconnect') {
    ws?.close();
    ws = null;
    connect();
  }
  if (msg.type === 'chat' && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'chat', text: msg.text }));
});

// Reintento periódico por si Chrome durmió el service worker
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
