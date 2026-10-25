# CODEC 47: tu asistente personal con IA

Un asistente que vive en tu teléfono, en tu navegador, en tu PC y en tus servidores, y que funciona con un solo cerebro: la IA de NVIDIA, que corre en un servidor de Render con la base de datos en MongoDB Atlas.

```
 Android (burbuja + voz)  ─┐
 Extensión de Chrome      ─┤   WebSocket    ┌──────────────────────────┐    ┌───────────────┐
 Agente PC (Win/Linux/Mac)─┼───────────────▶│ Servidor Render (Node.js)│───▶│ NVIDIA NIM IA │
 Agente servidores        ─┤                │ + interfaz web           │    └───────────────┘
 Interfaz web (chat/voz)  ─┘                └────────────┬─────────────┘
                                                         ▼
                                                  MongoDB Atlas
```

| Carpeta | Qué es |
|---|---|
| `server/` | API, WebSocket, IA y la **interfaz web** (chat con voz, dispositivos, monitoreo, pendientes) |
| `android/` | App Android: burbuja flotante, voz, linterna, cámara, calendario, música, control del sistema |
| `extension/` | Extensión de Chrome: pone música en YouTube, YouTube Music o Spotify, controla pestañas y tiene un mini chat |
| `agent/` | Agente para PC o servidor: rendimiento, auditoría de seguridad, conexión/desconexión, control remoto |

## Ejemplos de lo que puedes decir
- "Pon música de Daft Punk en la laptop": la extensión abre YouTube y reproduce.
- "Enciende la linterna", "toma una foto", "baja el volumen", "pausa la música".
- "Agrega al calendario dentista el martes a las 5".
- "Léeme mis correos", "¿qué notificaciones tengo?".
- "¿Qué hora es?", "¿cómo estará el clima mañana?", "¿qué pendientes tengo?".
- "¿Cómo están mis servidores?", "escanea la seguridad del VPS".
- "Abre WhatsApp", "llama a mamá al 55…", "llévame al aeropuerto", "pon una alarma a las 7".

---

## 1. MongoDB Atlas
1. Entra a https://cloud.mongodb.com y crea un clúster **M0 (gratis)**.
2. En **Database Access**, crea un usuario con contraseña.
3. En **Network Access**, agrega `0.0.0.0/0`, porque Render no tiene IP fija.
4. En **Connect → Drivers**, copia la cadena `mongodb+srv://...` y pon tu contraseña en ella.

## 2. Probar en tu PC
```bash
cd server
npm install
# Edita server/.env: pega tu MONGODB_URI (la clave de NVIDIA ya está puesta)
npm start
```
Abre http://localhost:3000. La **primera cuenta que registres será la dueña**, y después el registro se cierra.

## 3. Subir a Render
1. Sube este proyecto a un repositorio **privado** de GitHub. `.env` está en `.gitignore`, así que tus claves no se suben.
2. En https://render.com, ve a **New → Blueprint** y elige el repositorio. Render lee `render.yaml`.
3. Te pedirá `MONGODB_URI` y `NVIDIA_API_KEY`: pégalas. `JWT_SECRET` se genera solo.
4. Cuando termine, tendrás una URL como `https://codec47.onrender.com`.

> En el plan gratis, Render "duerme" el servidor tras 15 minutos sin tráfico. Los dispositivos conectados envían señales periódicas y suelen mantenerlo despierto, pero si quieres que esté disponible las 24 horas usa el plan Starter.

## 4. Conectar dispositivos
En la web, abre **Dispositivos → + Agregar**, elige el tipo y copia la clave que aparece. Solo se muestra una vez.

### Android
1. Abre `android/` con Android Studio y pulsa ▶ Run, o instala `android/app/build/outputs/apk/debug/app-debug.apk`.
2. Pega la URL del servidor y la clave.
3. Toca cada botón ⚠ para dar los permisos: **superposición** (burbuja), **accesibilidad** (control del teléfono), **notificaciones** (leer correos), y micrófono, cámara y calendario.
4. **Toca la burbuja "47"** para hablar. Mantenla presionada para abrir la app. Puedes arrastrarla.
5. Opcional: activa **Manos libres** para que escuche siempre y responda al decir "Codec…".
6. Opcional: en Ajustes → Apps → Asistente predeterminado, elige CODEC 47 para abrirlo manteniendo presionado el botón de inicio.

Mientras hablas o te responde, la música baja de volumen sola y luego vuelve.

### Chrome
1. Ve a `chrome://extensions`, activa el **Modo desarrollador**, pulsa **Cargar descomprimida** y elige la carpeta `extension/`.
2. Pulsa el ícono de CODEC 47 y pega la URL y la clave de un dispositivo tipo **Chrome**.

### PC o servidor (Node 22 o superior)
```bash
curl -O https://TU-APP.onrender.com/download/agent.js
node agent.js --server https://TU-APP.onrender.com --key c47_xxx
```
Opciones: `--allow-power` permite apagar o reiniciar. `--allow-shell` permite ejecutar comandos; úsalo con mucho cuidado.

Para que el agente arranque solo:
- **Linux (systemd):**
  ```ini
  # /etc/systemd/system/codec47.service
  [Unit]
  Description=CODEC 47 agent
  After=network-online.target
  [Service]
  ExecStart=/usr/bin/node /opt/codec47/agent.js --server https://TU-APP.onrender.com --key c47_xxx
  Restart=always
  [Install]
  WantedBy=multi-user.target
  ```
  Después: `sudo systemctl enable --now codec47`
- **Windows:** usa el Programador de tareas con el disparador "Al iniciar sesión" y la acción `node C:\ruta\agent.js --server ... --key ...`. También puedes usar `pm2`.

**Qué audita en los servidores:** CPU, RAM, disco y carga cada 30 segundos (con alertas si pasan del 90 %). Cada 30 minutos revisa: puertos peligrosos abiertos (RDP, SMB, Redis, MongoDB, Telnet…), SSH con root o con contraseña, firewall apagado, ataques de fuerza bruta por SSH, actualizaciones de seguridad pendientes, usuarios con privilegios de root, y en Windows el estado de Defender y del Firewall. También registra cada conexión y desconexión. Si un **servidor** se desconecta, se marca como crítico y la web te avisa con una notificación.

---

## Seguridad
- Cada dispositivo tiene su propia clave, que se guarda **cifrada con hash** en la base de datos. Puedes cambiarla o revocarla desde la web.
- Las contraseñas usan bcrypt. El login tiene límite de intentos y la sesión usa JWT.
- El agente no ejecuta comandos arbitrarios ni apaga el equipo, salvo que lo autorices con `--allow-shell` o `--allow-power`.
- **Tu clave de NVIDIA:** está en `server/.env`, que nunca se sube a git. Como la compartiste en un chat y en una captura de pantalla, es buena idea **generar una nueva** en build.nvidia.com y borrar esta.

## Límites de Android
- **Bluetooth:** desde Android 13, ninguna app puede encenderlo sola. CODEC 47 abre el ajuste para que lo actives con un toque.
- **Correos:** se leen desde las notificaciones (Gmail, Outlook…), así que solo ve los que llegaron como notificación. Para leer toda la bandeja haría falta conectar la API de Gmail con OAuth.
- **Manos libres:** usa el reconocimiento de voz de Google en ciclo. Funciona, pero gasta batería. Para una palabra de activación real y de bajo consumo haría falta un motor como Porcupine.
- Al reiniciar el teléfono, el servicio vuelve solo, pero el micrófono y la cámara no se habilitan hasta que abras la app una vez. Es una regla de Android 14 y versiones posteriores.

## IA
Usa `nvidia/nemotron-3.5-lightning-30b-a3b`, que es rápido y sabe usar herramientas. Puedes cambiarlo con `NVIDIA_MODEL`. Con `NVIDIA_THINKING=false` responde en aproximadamente 1 segundo, pero a veces inventa en vez de consultar los datos. Con `true`, el valor por defecto, tarda de 3 a 6 segundos y es mucho más fiable.
