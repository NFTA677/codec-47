// Voz de CODEC 47 generada en el servidor con NVIDIA Magpie TTS (neuronal).
// Así suena exactamente igual en el teléfono, la web y Chrome.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTION_ID = process.env.NVIDIA_TTS_FUNCTION_ID || '877104f7-e885-42b9-8de8-f6e4c6303969'; // magpie-tts-multilingual
const RATE = 22050;

export const VOICES = [
  { id: 'Magpie-Multilingual.ES-US.Diego.Calm', label: 'Diego · calmado (estilo Jarvis)' },
  { id: 'Magpie-Multilingual.ES-US.Diego', label: 'Diego · natural' },
  { id: 'Magpie-Multilingual.ES-US.Diego.Neutral', label: 'Diego · neutro' },
  { id: 'Magpie-Multilingual.ES-US.Diego.Happy', label: 'Diego · alegre' },
  { id: 'Magpie-Multilingual.ES-US.Ray', label: 'Ray' },
  { id: 'Magpie-Multilingual.ES-US.Leo', label: 'Leo' },
  { id: 'Magpie-Multilingual.ES-US.Pascal', label: 'Pascal' },
  { id: 'Magpie-Multilingual.ES-US.Jason', label: 'Jason' },
  { id: 'Magpie-Multilingual.ES-US.Isabela.Calm', label: 'Isabela · calmada (mujer)' },
];

let client = null;
function getClient() {
  if (!client) {
    const def = loader.loadSync(path.join(__dirname, 'riva_tts.proto'), { enums: Number });
    const pkg = grpc.loadPackageDefinition(def);
    client = new pkg.nvidia.riva.tts.RivaSpeechSynthesis('grpc.nvcf.nvidia.com:443', grpc.credentials.createSsl());
  }
  return client;
}

function synthOne(text, voice) {
  const md = new grpc.Metadata();
  md.set('function-id', FUNCTION_ID);
  md.set('authorization', 'Bearer ' + process.env.NVIDIA_API_KEY);
  return new Promise((resolve, reject) =>
    getClient().Synthesize(
      { text, languageCode: 'es-US', encoding: 1, sampleRateHz: RATE, voiceName: voice },
      md,
      { deadline: Date.now() + 20_000 },
      (err, res) => (err ? reject(err) : resolve(res.audio))
    )
  );
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Limpia el texto para que suene natural (sin emojis, markdown ni URLs)
export function cleanForSpeech(text) {
  return String(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\p{Extended_Pictographic}‍️*_#`>|]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Trozos de máximo ~300 caracteres cortando en fin de frase
function chunks(text) {
  const parts = text.match(/[^.!?¡¿]+[.!?]*|[¡¿][^.!?]+[.!?]*/g) || [text];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > 300 && cur) {
      out.push(cur.trim());
      cur = '';
    }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.flatMap((c) => (c.length > 380 ? c.match(/.{1,380}(\s|$)/g) : [c]));
}

const cache = new Map(); // frases repetidas (saludos, "listo") salen al instante
export async function synthesize(text, voice = VOICES[0].id) {
  const clean = cleanForSpeech(text).slice(0, 1500);
  if (!clean) throw new Error('Texto vacío');
  if (!VOICES.some((v) => v.id === voice)) voice = VOICES[0].id;
  const k = voice + '|' + clean;
  if (cache.has(k)) return cache.get(k);
  const pcms = await Promise.all(chunks(clean).map((c) => synthOne(c, voice)));
  const buf = wav(Buffer.concat(pcms));
  cache.set(k, buf);
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return buf;
}
