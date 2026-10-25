import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { connectDB } from './db.js';
import { apiRouter } from './routes.js';
import { attachWS } from './hub.js';
import { Device } from './models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

for (const v of ['MONGODB_URI', 'JWT_SECRET', 'NVIDIA_API_KEY']) {
  if (!process.env[v]) console.warn(`[config] Falta la variable ${v}`);
}

const app = express();
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'connect-src': ["'self'", 'wss:', 'ws:'],
        'img-src': ["'self'", 'data:'],
      },
    },
  })
);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api', apiRouter);

// Descargas: el agente para PCs/servidores
app.get('/download/agent.js', (req, res) => res.download(path.join(ROOT, 'agent', 'agent.js'), 'agent.js'));

app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message?.startsWith('NVIDIA') ? 'La IA no está disponible ahora' : 'Error interno' });
});

const server = http.createServer(app);
attachWS(server);

await connectDB();
// Al reiniciar, nadie está conectado todavía
await Device.updateMany({}, { online: false });

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`[codec47] escuchando en http://localhost:${PORT}`));
