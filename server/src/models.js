import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, default: '' },
    city: { type: String, default: '' },
    tz: { type: String, default: () => process.env.DEFAULT_TZ || 'America/Mexico_City' },
    voice: { type: String, default: 'Magpie-Multilingual.ES-US.Diego.Calm' },
    // WhatsApp: modo privacidad = CODEC 47 responde por ti
    wa: {
      privacy: { type: Boolean, default: false },
      replyAll: { type: Boolean, default: false }, // true = responde a todos; false = solo a "allow"
      allow: { type: [String], default: [] }, // nombres o números permitidos
      instructions: { type: String, default: '' }, // ej. "di que estoy en una reunión hasta las 5"
      introEnabled: { type: Boolean, default: true }, // saludo de emergencia al empezar
      intro: { type: String, default: '' }, // texto del saludo (vacío = el predeterminado)
    },
  },
  { timestamps: true }
);

// Sesión de WhatsApp (credenciales cifradas por WhatsApp, guardadas como en disco pero en Mongo)
const WaAuthSchema = new Schema({
  userId: { type: Types.ObjectId, index: true, required: true },
  key: { type: String, required: true },
  value: { type: String, required: true },
});
WaAuthSchema.index({ userId: 1, key: 1 }, { unique: true });

const WaMessageSchema = new Schema(
  {
    userId: { type: Types.ObjectId, index: true, required: true },
    jid: String,
    name: String,
    fromMe: Boolean,
    text: String,
    autoReply: { type: Boolean, default: false },
    msgId: { type: String, index: true },
  },
  { timestamps: true }
);
WaMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

const WaContactSchema = new Schema({
  userId: { type: Types.ObjectId, index: true, required: true },
  jid: { type: String, required: true },
  name: String,
  phone: String,
  auto: { type: Boolean, default: false }, // responder automáticamente en este chat
  instructions: { type: String, default: '' }, // instrucciones solo para este chat
  introAt: Date, // cuándo se envió el saludo de emergencia
  blocked: { type: Boolean, default: false },
});
WaContactSchema.index({ userId: 1, jid: 1 }, { unique: true });

// type: android | chrome | pc | server
const DeviceSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', index: true, required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['android', 'chrome', 'pc', 'server'], required: true },
    keyHash: { type: String, required: true, unique: true },
    online: { type: Boolean, default: false },
    lastSeen: Date,
    info: { type: Schema.Types.Mixed, default: {} },
    capabilities: { type: [String], default: [] },
    metrics: { type: Schema.Types.Mixed, default: null },
    security: { type: [Schema.Types.Mixed], default: [] },
    securityAt: Date,
  },
  { timestamps: true }
);

const MessageSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', index: true, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    source: { type: String, default: 'web' }, // web | nombre del dispositivo
  },
  { timestamps: true }
);

const TaskSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', index: true, required: true },
    title: { type: String, required: true },
    due: Date,
    done: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const AuditSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', index: true, required: true },
    deviceId: { type: Types.ObjectId, ref: 'Device', index: true },
    deviceName: String,
    kind: { type: String, required: true }, // connect | disconnect | alert | security | command
    severity: { type: String, enum: ['info', 'warn', 'high'], default: 'info' },
    detail: String,
  },
  { timestamps: true }
);
AuditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }); // 90 días

const MetricSchema = new Schema({
  deviceId: { type: Types.ObjectId, ref: 'Device', index: true, required: true },
  ts: { type: Date, default: Date.now },
  cpu: Number,
  mem: Number,
  disk: Number,
  load: Number,
});
MetricSchema.index({ ts: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 }); // 7 días

export const User = model('User', UserSchema);
export const Device = model('Device', DeviceSchema);
export const Message = model('Message', MessageSchema);
export const Task = model('Task', TaskSchema);
export const Audit = model('Audit', AuditSchema);
export const Metric = model('Metric', MetricSchema);
export const WaAuth = model('WaAuth', WaAuthSchema);
export const WaMessage = model('WaMessage', WaMessageSchema);
export const WaContact = model('WaContact', WaContactSchema);
