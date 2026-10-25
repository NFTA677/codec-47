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

chrome.storage.local.get(['serverUrl', 'deviceKey']).then(({ serverUrl = '', deviceKey = '' }) => {
  $('#server').value = serverUrl;
  $('#key').value = deviceKey;
});
chrome.runtime.sendMessage({ type: 'get_status' }).then((r) => showStatus(r?.status || '?'));

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'status') showStatus(m.status);
  if (m.type === 'chat_reply') add(m.text, false);
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
