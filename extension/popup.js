const $ = (s) => document.querySelector(s);

function showStatus(s) {
  $('#status').textContent = s;
  $('#status').className = s === 'conectado' ? 'ok' : '';
  if (s !== 'conectado') $('#cfg').open = true;
}

function add(text, user) {
  const d = document.createElement('div');
  d.className = 'm' + (user ? ' u' : '');
  d.textContent = text;
  $('#log').append(d);
  $('#log').scrollTop = $('#log').scrollHeight;
}

// Voz de CODEC 47: la más natural disponible, frase por frase
// Voz neuronal de NVIDIA desde el servidor (la misma del teléfono); si falla, la de Chrome
let audio = null;
async function speak(text) {
  chrome.tts.stop();
  audio?.pause();
  try {
    const { serverUrl = 'https://codec-47.onrender.com', deviceKey = '' } = await chrome.storage.local.get(['serverUrl', 'deviceKey']);
    const r = await fetch(serverUrl.replace(/\/+$/, '') + '/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': deviceKey },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error();
    audio = new Audio(URL.createObjectURL(await r.blob()));
    await audio.play();
  } catch {
    chromeSpeak(text);
  }
}

function chromeSpeak(text) {
  const clean = text.replace(/[\p{Extended_Pictographic}*_#`]/gu, '').replace(/\s+/g, ' ').trim();
  chrome.tts.getVoices((voices) => {
    const es = voices.filter((v) => (v.lang || '').toLowerCase().startsWith('es'));
    const score = (v) =>
      (/jorge|pablo|alvaro|diego|raul|male/i.test(v.voiceName) ? 120 : 0) + (/natural|neural/i.test(v.voiceName) ? 100 : 0) + (/google/i.test(v.voiceName) ? 50 : 0) +
      (v.remote ? 10 : 0) + (/es-(mx|us|419)/i.test(v.lang) ? 20 : 0);
    const best = es.sort((a, b) => score(b) - score(a))[0];
    chrome.tts.speak(clean, { voiceName: best?.voiceName, lang: best?.lang || 'es-MX', rate: 1.05 });
  });
}

chrome.storage.local.get(['serverUrl', 'deviceKey']).then(({ serverUrl = 'https://codec-47.onrender.com', deviceKey = '' }) => {
  $('#server').value = serverUrl;
  $('#key').value = deviceKey;
});
chrome.runtime.sendMessage({ type: 'get_status' }).then((r) => showStatus(r?.status || '?'));

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'status') showStatus(m.status);
  if (m.type === 'chat_reply') {
    add(m.text, false);
    speak(m.text);
  }
});

$('#save').onclick = async () => {
  const serverUrl = $('#server').value.trim();
  try {
    const u = new URL(serverUrl);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return showStatus('usa https://');
  } catch {
    return showStatus('URL inválida');
  }
  await chrome.storage.local.set({ serverUrl, deviceKey: $('#key').value.trim() });
  chrome.runtime.sendMessage({ type: 'reconnect' });
};

$('#chat').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#text').value.trim();
  if (!text) return;
  add(text, true);
  $('#text').value = '';
  chrome.runtime.sendMessage({ type: 'chat', text });
};
