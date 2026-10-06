// Servidor HTTP — API + arquivos estáticos do app.
// IMPORTANTE (versão de teste): a identidade vem do cabeçalho X-User-Id escolhido no app.
// Em produção, substituir o middleware `identify` por autenticação real (sessão/JWT);
// as checagens de permissão já são feitas aqui no servidor.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { openDb, resetDb, UPLOAD_DIR } from './db.js';
import { applyOp, getSetting, setSetting, CLOSED } from './domain.js';
import { generateCycle, runScheduler } from './preventive.js';
import { computeIndicators } from './indicators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);

let db = openDb();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));

// ---------- Estáticos ----------
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], setHeaders: (res, p) => {
  if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
}}));
app.get('/vendor/jsQR.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', 'jsqr', 'dist', 'jsQR.js')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

// ---------- Identidade (simulada) ----------
function identify(req, res, next) {
  const id = req.get('X-User-Id');
  req.user = id ? db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(id) : null;
  next();
}
const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Selecione um usuário' }));
const requireManager = (req, res, next) => (req.user?.role === 'gerente' ? next() : res.status(403).json({ error: 'Somente o gerente de manutenção' }));
app.use('/api', identify);

// ---------- Serialização ----------
const nameOf = (id) => (id ? db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name : null);

function serializeWo(w, full = false) {
  const m = db.prepare('SELECT m.id, m.code, m.name, m.criticality, s.id sector_id, s.name sector FROM machines m JOIN sectors s ON s.id=m.sector_id WHERE m.id=?').get(w.machine_id);
  const parts = db.prepare(`SELECT p.*, u.name FROM wo_participants p JOIN users u ON u.id=p.user_id WHERE p.wo_id=? ORDER BY p.role DESC, p.joined_at`).all(w.id);
  const ivs = db.prepare('SELECT * FROM work_intervals WHERE wo_id=? ORDER BY started_at').all(w.id);
  const now = Date.now();
  const participants = parts.map((p) => {
    const mine = ivs.filter((i) => i.user_id === p.user_id);
    const open = mine.find((i) => !i.ended_at);
    const minutes = mine.reduce((s, i) => s + ((i.ended_at ? new Date(i.ended_at) : now) - new Date(i.started_at)) / 60000, 0);
    return { userId: p.user_id, name: p.name, role: p.role, state: p.state, minutes: Math.round(minutes), activeSince: open?.started_at || null };
  });
  const today = new Date().toISOString().slice(0, 10);
  const out = {
    id: w.id, number: w.number, type: w.type, priority: w.priority, machineStopped: !!w.machine_stopped,
    status: w.status, title: w.title, description: w.description,
    machine: m, requester: { id: w.requester_id, name: nameOf(w.requester_id) || 'Agendador' },
    responsible: w.responsible_id ? { id: w.responsible_id, name: nameOf(w.responsible_id) } : null,
    participants, recipientsMode: w.recipients_mode, recipients: JSON.parse(w.recipients_json || '[]'),
    createdAt: w.created_at, closedAt: w.closed_at, dueDate: w.due_date, planId: w.plan_id,
    overdue: !!(w.due_date && w.due_date < today && !CLOSED.includes(w.status)),
    machineRecovered: w.machine_recovered == null ? null : !!w.machine_recovered, returnedAt: w.returned_at,
    reopenedCount: w.reopened_count, reworkOf: w.rework_of, version: w.version,
    checklist: w.checklist_json ? JSON.parse(w.checklist_json) : null,
    photos: db.prepare('SELECT COUNT(*) n FROM attachments WHERE wo_id=?').get(w.id).n,
  };
  if (full) {
    Object.assign(out, {
      serviceDone: w.service_done, cause: w.cause, solution: w.solution, cancelledReason: w.cancelled_reason,
      intervals: ivs.map((i) => ({ ...i, userName: nameOf(i.user_id) })),
      events: db.prepare(`SELECT e.*, u.name user_name FROM wo_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.wo_id=? ORDER BY e.local_time, e.received_at`).all(w.id)
        .map((e) => ({ id: e.id, action: e.action, reason: e.reason, data: e.data_json ? JSON.parse(e.data_json) : null, userId: e.user_id, userName: e.user_name || 'Sistema',
          localTime: e.local_time, receivedAt: e.received_at, origin: e.origin })),
      attachments: db.prepare('SELECT * FROM attachments WHERE wo_id=? ORDER BY created_at').all(w.id)
        .map((a) => ({ id: a.id, url: `/uploads/${a.file}`, size: a.size, createdAt: a.created_at, userName: nameOf(a.user_id) })),
      conflicts: db.prepare('SELECT * FROM conflicts WHERE wo_id=? ORDER BY created_at DESC').all(w.id),
      audit: db.prepare(`SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
                         WHERE a.entity_id IN (SELECT id FROM work_intervals WHERE wo_id=?) ORDER BY a.created_at`).all(w.id),
    });
  }
  return out;
}

// ---------- API ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/bootstrap', (req, res) => {
  res.json({
    serverTime: new Date().toISOString(),
    sectors: db.prepare('SELECT * FROM sectors ORDER BY name').all(),
    teams: db.prepare('SELECT * FROM teams ORDER BY name').all(),
    users: db.prepare('SELECT id,name,role,team_id,specialty FROM users WHERE active=1 ORDER BY role, name').all(),
    machines: db.prepare('SELECT * FROM machines WHERE active=1 ORDER BY code').all(),
    settings: { defaultRecipientsMode: getSetting(db, 'default_recipients_mode', 'todos') },
  });
});

app.get('/api/workorders', (req, res) => {
  const since = new Date(Date.now() - Number(req.query.days || 30) * 86400000).toISOString();
  const rows = db.prepare(`SELECT * FROM work_orders WHERE status NOT IN ('Concluída','Cancelada') OR closed_at >= ? OR created_at >= ?
                           ORDER BY machine_stopped DESC, created_at DESC`).all(since, since);
  res.json({ serverTime: new Date().toISOString(), workOrders: rows.map((w) => serializeWo(w)) });
});

app.get('/api/workorders/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM work_orders WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'OS não encontrada' });
  res.json(serializeWo(w, true));
});

// Recebe a fila de operações (online ou offline). Cada operação é confirmada individualmente.
app.post('/api/sync', requireUser, (req, res) => {
  const ops = Array.isArray(req.body?.ops) ? req.body.ops.slice(0, 200) : [];
  const results = ops.map((op) => {
    // O usuário do cabeçalho é a fonte da identidade — impede registrar em nome de outro
    if (op.userId && op.userId !== req.user.id) return { opId: op.opId, status: 'forbidden', message: 'Operação de outro usuário' };
    return applyOp(db, { ...op, userId: req.user.id });
  });
  res.json({ serverTime: new Date().toISOString(), results });
});

// Identificação por QR/código
app.get('/api/resolve/:code', (req, res) => {
  const code = decodeURIComponent(req.params.code).trim().toUpperCase();
  const m = db.prepare('SELECT * FROM machines WHERE UPPER(code)=? AND active=1').get(code);
  if (m) return res.json({ kind: 'machine', machine: m });
  const s = db.prepare('SELECT * FROM sectors WHERE UPPER(code)=?').get(code);
  if (s) return res.json({ kind: 'sector', sector: s, machines: db.prepare('SELECT * FROM machines WHERE sector_id=? AND active=1 ORDER BY code').all(s.id) });
  res.status(404).json({ error: `Código "${code}" não encontrado` });
});

app.get('/api/qr/:code.svg', async (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${base}/#/nova?qr=${encodeURIComponent(req.params.code)}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

// Central de avisos
app.get('/api/notifications', requireUser, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ notifications: rows, unread: rows.filter((r) => !r.read_at).length });
});
app.post('/api/notifications/read', requireUser, (req, res) => {
  const at = new Date().toISOString();
  if (req.body?.all) db.prepare('UPDATE notifications SET read_at=?, status=? WHERE user_id=? AND read_at IS NULL').run(at, 'lida', req.user.id);
  for (const id of req.body?.ids || []) db.prepare('UPDATE notifications SET read_at=?, status=? WHERE id=? AND user_id=?').run(at, 'lida', id, req.user.id);
  res.json({ ok: true });
});

// Planos preventivos
const planRow = (p) => ({ ...p, checklist: JSON.parse(p.checklist_json || '[]'), responsibleName: nameOf(p.responsible_id),
  machine: db.prepare('SELECT code,name FROM machines WHERE id=?').get(p.machine_id),
  openOrders: db.prepare(`SELECT id, number, due_date, status FROM work_orders WHERE plan_id=? AND status NOT IN ('Concluída','Cancelada') ORDER BY due_date`).all(p.id),
  lastDone: db.prepare(`SELECT number, closed_at, due_date FROM work_orders WHERE plan_id=? AND status='Concluída' ORDER BY closed_at DESC LIMIT 1`).get(p.id) || null });

app.get('/api/plans', (req, res) => {
  res.json({ plans: db.prepare('SELECT * FROM preventive_plans ORDER BY active DESC, next_due').all().map(planRow) });
});

function validatePlan(b) {
  const errors = [];
  if (!db.prepare('SELECT 1 FROM machines WHERE id=?').get(b.machineId)) errors.push('Máquina inválida');
  if (!b.title?.trim()) errors.push('Informe o título');
  if (!(Number(b.frequencyDays) >= 1)) errors.push('Frequência inválida');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.anchorDate || '')) errors.push('Data de referência inválida');
  return errors;
}

app.post('/api/plans', requireUser, requireManager, (req, res) => {
  const b = req.body || {};
  const errors = validatePlan(b);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const id = randomUUID();
  const checklist = (b.checklist || []).map((t) => String(t).trim()).filter(Boolean).map((text) => ({ text, done: false }));
  db.prepare(`INSERT INTO preventive_plans (id,machine_id,title,frequency_days,anchor_date,next_due,lead_days,tolerance_days,checklist_json,responsible_id,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.machineId, b.title.trim(), Number(b.frequencyDays), b.anchorDate, b.anchorDate, Number(b.leadDays ?? 2), Number(b.toleranceDays ?? 0),
      JSON.stringify(checklist), b.responsibleId || null, new Date().toISOString());
  runScheduler(db);
  res.json(planRow(db.prepare('SELECT * FROM preventive_plans WHERE id=?').get(id)));
});

app.put('/api/plans/:id', requireUser, requireManager, (req, res) => {
  const p = db.prepare('SELECT * FROM preventive_plans WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Plano não encontrado' });
  const b = req.body || {};
  if (b.active !== undefined) db.prepare('UPDATE preventive_plans SET active=? WHERE id=?').run(b.active ? 1 : 0, p.id);
  if (b.responsibleId !== undefined) db.prepare('UPDATE preventive_plans SET responsible_id=? WHERE id=?').run(b.responsibleId || null, p.id);
  res.json(planRow(db.prepare('SELECT * FROM preventive_plans WHERE id=?').get(p.id)));
});

// Geração manual do próximo ciclo (antecipa a OS e avança a próxima data)
app.post('/api/plans/:id/generate', requireUser, requireManager, (req, res) => {
  const p = db.prepare('SELECT * FROM preventive_plans WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Plano não encontrado' });
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = generateCycle(db, p, { userId: req.user.id, origin: 'manual' });
    db.exec('COMMIT');
    res.json(r);
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/indicators', (req, res) => res.json(computeIndicators(db, req.query)));

// Conflitos de sincronização (revisão do gerente)
app.get('/api/conflicts', requireUser, (req, res) => {
  const where = req.user.role === 'gerente' ? '' : 'WHERE c.user_id = @u';
  const rows = db.prepare(`SELECT c.*, u.name user_name, w.number FROM conflicts c LEFT JOIN users u ON u.id=c.user_id
                           LEFT JOIN work_orders w ON w.id=c.wo_id ${where} ORDER BY c.resolved_at IS NOT NULL, c.created_at DESC LIMIT 200`)
    .all(req.user.role === 'gerente' ? {} : { u: req.user.id });
  res.json({ conflicts: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload_json || '{}') })) });
});
app.post('/api/conflicts/:id/resolve', requireUser, requireManager, (req, res) => {
  const note = (req.body?.resolution || '').trim();
  if (!note) return res.status(400).json({ error: 'Descreva a resolução' });
  db.prepare('UPDATE conflicts SET resolved_at=?, resolved_by=?, resolution=? WHERE id=?').run(new Date().toISOString(), req.user.id, note, req.params.id);
  res.json({ ok: true });
});

app.put('/api/settings', requireUser, requireManager, (req, res) => {
  const mode = req.body?.defaultRecipientsMode;
  if (['todos', 'equipe', 'selecionados'].includes(mode)) setSetting(db, 'default_recipients_mode', mode);
  res.json({ defaultRecipientsMode: getSetting(db, 'default_recipients_mode') });
});

app.post('/api/admin/reset', requireUser, requireManager, (req, res) => {
  db.close();
  resetDb();
  db = openDb();
  runScheduler(db);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Agendador: roda ao iniciar e a cada 5 minutos (geração de preventivas e avisos de atraso)
const sched = runScheduler(db);
console.log(`Agendador: ${sched.generated} preventiva(s) gerada(s), ${sched.overdueNotified} aviso(s) de atraso`);
setInterval(() => runScheduler(db), 5 * 60000);

app.listen(PORT, () => console.log(`Nova OS rodando em http://localhost:${PORT}`));
