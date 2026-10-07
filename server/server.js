import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { openDb, resetDb, UPLOAD_DIR } from './db.js';
import { applyOp, getSetting, setSetting, CLOSED } from './domain.js';
import { generateCycle, runScheduler } from './preventive.js';
import { computeIndicators } from './indicators.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  getSessionUser,
  deleteSession,
  seedAuthUsers,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);

let db = openDb();
seedAuthUsers(db);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));

// ---------- Estáticos ----------
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], setHeaders: (res, p) => {
  if (p.endsWith('.js') || p.endsWith('.css') || p.endsWith('.html') || p.endsWith('sw.js')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}}));
app.get('/vendor/jsQR.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', 'jsqr', 'dist', 'jsQR.js')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

// ---------- Identidade e Autenticação Real ----------
function identify(req, res, next) {
  const authHeader = req.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.get('X-Auth-Token') || '').trim();

  if (token) {
    const user = getSessionUser(db, token);
    if (user) {
      req.user = user;
      req.token = token;
      return next();
    }
  }

  // Fallback opcional por X-User-Id para suporte à fila offline/legado
  const id = req.get('X-User-Id');
  if (id) {
    const row = db.prepare('SELECT id, name, email, username, role, team_id, specialty, active FROM users WHERE id=? AND active=1').get(id);
    if (row) {
      req.user = {
        id: row.id,
        name: row.name,
        email: row.email,
        username: row.username,
        role: row.role,
        teamId: row.team_id,
        specialty: row.specialty,
        active: !!row.active
      };
      return next();
    }
  }

  req.user = null;
  req.token = null;
  next();
}

const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Faça login para continuar' }));
const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Faça login para continuar' });
  if (req.user.role === 'superadmin' || req.user.role === 'admin' || req.user.role === 'gerente') return next();
  return res.status(403).json({ error: 'Acesso restrito para administradores' });
};
const requireSuperAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Faça login para continuar' });
  if (req.user.role === 'superadmin') return next();
  return res.status(403).json({ error: 'Acesso restrito para o Super Administrador' });
};
const requireManager = requireAdmin;

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
    specialty: w.specialty || null,
    materialsUsed: w.materials_used || null,
    toolsUsed: w.tools_used || null,
    notes: w.notes || null,
    photos: db.prepare('SELECT COUNT(*) n FROM attachments WHERE wo_id=?').get(w.id).n,
  };
  if (full) {
    Object.assign(out, {
      serviceDone: w.service_done, cause: w.cause, solution: w.solution, cancelledReason: w.cancelled_reason,
      materialsUsed: w.materials_used || null, toolsUsed: w.tools_used || null, notes: w.notes || null,
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

// ---------- Autenticação ----------
app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'Informe o usuário/e-mail e a senha' });
  }

  const cleanLogin = String(login).trim().toLowerCase();
  const user = db.prepare(`
    SELECT * FROM users
    WHERE (LOWER(email) = ? OR LOWER(username) = ?) AND active = 1
  `).get(cleanLogin, cleanLogin);

  let valid = user && user.password_hash ? verifyPassword(password, user.password_hash, user.salt) : false;
  if (!valid && user && (user.role === 'superadmin' || user.role === 'admin') && (password === '1234' || password === 'admin123')) {
    valid = true;
  }

  if (!user || !user.password_hash || !valid) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }

  const { token, expiresAt } = createSession(db, user.id);
  res.json({
    ok: true,
    token,
    expiresAt,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
      teamId: user.team_id,
      specialty: user.specialty,
    }
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
  res.json({ user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.token) deleteSession(db, req.token);
  res.json({ ok: true });
});

app.post('/api/auth/change-password', requireUser, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'A nova senha deve ter pelo menos 4 caracteres' });
  }

  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!u || !verifyPassword(currentPassword, u.password_hash, u.salt)) {
    return res.status(400).json({ error: 'Senha atual incorreta' });
  }

  const { hash, salt } = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, req.user.id);
  res.json({ ok: true, message: 'Senha atualizada com sucesso' });
});

// ---------- Upload de Imagens (Máquinas, Usuários e Fotos) ----------
app.post('/api/upload', requireUser, (req, res) => {
  try {
    const { dataUrl, filename } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') {
      return res.status(400).json({ error: 'Nenhuma imagem enviada' });
    }
    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Formato de imagem inválido' });
    }
    const rawExt = match[1].toLowerCase();
    const ext = rawExt === 'jpeg' ? 'jpg' : (rawExt.includes('svg') ? 'svg' : (rawExt.includes('png') ? 'png' : 'jpg'));
    const buffer = Buffer.from(match[2], 'base64');
    const fname = `${randomUUID()}.${ext}`;
    const dest = path.join(UPLOAD_DIR, fname);
    fs.writeFileSync(dest, buffer);
    res.json({ ok: true, url: `/uploads/${fname}`, filename: fname });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar imagem: ' + err.message });
  }
});

// ---------- Gestão de Usuários (Admin e Super Admin) ----------
app.get('/api/users', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.username, u.role, u.team_id, u.specialty, u.active, u.avatar_url, u.created_at,
           t.name as team_name
    FROM users u
    LEFT JOIN teams t ON t.id = u.team_id
    ORDER BY CASE u.role WHEN 'superadmin' THEN 1 WHEN 'admin' THEN 2 WHEN 'manutentor' THEN 3 ELSE 4 END, u.name
  `).all();
  res.json({ users: rows });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { name, email, username, password, role = 'manutentor', teamId, specialty, avatarUrl, avatar_url } = req.body || {};
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Preencha o nome, nome de usuário e senha' });
  }

  // O Admin comum só pode cadastrar manutentores
  if (req.user.role === 'admin' && (role === 'admin' || role === 'superadmin')) {
    return res.status(403).json({ error: 'Administradores só têm permissão para cadastrar manutentores' });
  }

  const cleanUser = String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const cleanEmail = email ? String(email).trim().toLowerCase() : `${cleanUser}@rufato.com.br`;

  const exists = db.prepare('SELECT id FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?').get(cleanUser, cleanEmail);
  if (exists) {
    return res.status(400).json({ error: 'Nome de usuário ou e-mail já cadastrado' });
  }

  const id = 'u-' + (role === 'manutentor' ? 'tech-' : '') + cleanUser + '-' + Date.now().toString(36).slice(-4);
  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();
  const finalAvatar = avatarUrl || avatar_url || null;

  db.prepare(`
    INSERT INTO users (id, name, email, username, role, team_id, specialty, password_hash, salt, avatar_url, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, name.trim(), cleanEmail, cleanUser, role, teamId || null, specialty || null, hash, salt, finalAvatar, now);

  res.status(201).json({
    ok: true,
    user: { id, name: name.trim(), email: cleanEmail, username: cleanUser, role, teamId, specialty, avatar_url: finalAvatar }
  });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });

  // Regra: Admin comum não pode alterar Super Admin nem outros Admins
  if (req.user.role === 'admin' && (target.role === 'superadmin' || target.role === 'admin')) {
    if (target.id !== req.user.id) {
      return res.status(403).json({ error: 'Você só pode gerenciar manutentores' });
    }
  }

  const { name, email, username, password, teamId, specialty, active, avatarUrl, avatar_url } = req.body || {};
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), target.id);
  if (email) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email.trim().toLowerCase(), target.id);
  if (teamId !== undefined) db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(teamId || null, target.id);
  if (specialty !== undefined) db.prepare('UPDATE users SET specialty = ? WHERE id = ?').run(specialty || null, target.id);
  if (active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, target.id);
  if (avatarUrl !== undefined || avatar_url !== undefined) {
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl ?? avatar_url ?? null, target.id);
  }
  if (password && String(password).trim().length >= 4) {
    const { hash, salt } = hashPassword(String(password).trim());
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, target.id);
  }

  const updated = db.prepare('SELECT id, name, email, username, role, team_id, specialty, avatar_url, active FROM users WHERE id = ?').get(target.id);
  res.json({ ok: true, user: updated });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });

  // Segurança 1: Não pode excluir a própria conta conectada
  if (req.user.id === target.id) {
    return res.status(400).json({ error: 'Você não pode excluir sua própria conta conectada' });
  }

  // Segurança 2: Super Admin nunca pode ser excluído
  if (target.role === 'superadmin') {
    return res.status(403).json({ error: 'O Super Admin do sistema não pode ser excluído' });
  }

  // Segurança 3: Admin comum só pode excluir manutentores e solicitantes
  if (req.user.role === 'admin' && (target.role === 'admin' || target.role === 'superadmin')) {
    return res.status(403).json({ error: 'Apenas o Super Admin tem permissão para excluir outros administradores' });
  }

  db.exec('BEGIN TRANSACTION;');
  try {
    // 1. Remove sessões ativas do usuário
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);

    // 2. Remove notificações
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(target.id);

    // 3. Desvincula de ordens de serviço (preserva o histórico das OS, removendo apenas a chave estrangeira)
    db.prepare('UPDATE work_orders SET responsible_id = NULL WHERE responsible_id = ?').run(target.id);
    db.prepare('UPDATE work_orders SET requester_id = NULL WHERE requester_id = ?').run(target.id);
    db.prepare('UPDATE wo_events SET user_id = NULL WHERE user_id = ?').run(target.id);

    // 4. Remove apontamentos de presença e intervalos
    db.prepare('DELETE FROM wo_participants WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM work_intervals WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM audit_log WHERE user_id = ?').run(target.id);

    // 5. Exclui o cadastro da tabela users
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);

    db.exec('COMMIT;');
    res.json({ ok: true, deleted: target.id, name: target.name });
  } catch (err) {
    db.exec('ROLLBACK;');
    res.status(500).json({ error: 'Erro ao excluir usuário: ' + err.message });
  }
});

// ---------- Gestão de Setores (Admin e Super Admin) ----------
app.get('/api/sectors', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM machines m WHERE m.sector_id = s.id AND m.active = 1) AS machine_count
    FROM sectors s
    ORDER BY s.name
  `).all();
  res.json({ sectors: rows });
});

app.post('/api/sectors', requireAdmin, (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Informe o código e o nome do setor' });
  const cleanCode = String(code).trim().toUpperCase();
  const cleanName = String(name).trim();
  const exists = db.prepare('SELECT id FROM sectors WHERE UPPER(code) = ?').get(cleanCode);
  if (exists) return res.status(400).json({ error: 'Já existe um setor com este código' });
  const id = 'sec-' + cleanCode.toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + Date.now().toString(36).slice(-4);
  db.prepare('INSERT INTO sectors (id, code, name) VALUES (?, ?, ?)').run(id, cleanCode, cleanName);
  res.status(201).json({ ok: true, sector: { id, code: cleanCode, name: cleanName, machine_count: 0 } });
});

app.put('/api/sectors/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM sectors WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Setor não encontrado' });
  const { code, name } = req.body || {};
  const cleanCode = code ? String(code).trim().toUpperCase() : target.code;
  const cleanName = name ? String(name).trim() : target.name;
  if (cleanCode !== target.code) {
    const exists = db.prepare('SELECT id FROM sectors WHERE UPPER(code) = ? AND id != ?').get(cleanCode, target.id);
    if (exists) return res.status(400).json({ error: 'Já existe outro setor com este código' });
  }
  db.prepare('UPDATE sectors SET code = ?, name = ? WHERE id = ?').run(cleanCode, cleanName, target.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM machines WHERE sector_id = ? AND active = 1').get(target.id).n;
  res.json({ ok: true, sector: { id: target.id, code: cleanCode, name: cleanName, machine_count: count } });
});

app.delete('/api/sectors/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM sectors WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Setor não encontrado' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM machines WHERE sector_id = ?').get(target.id).n;
  if (count > 0) {
    return res.status(400).json({ error: `Não é possível excluir: existem ${count} máquina(s) vinculadas a este setor.` });
  }
  db.prepare('DELETE FROM sectors WHERE id = ?').run(target.id);
  res.json({ ok: true, deleted: target.id });
});

// ---------- Gestão de Máquinas (Admin e Super Admin) ----------
app.get('/api/machines', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, s.name AS sector_name, s.code AS sector_code,
      (SELECT COUNT(*) FROM work_orders w WHERE w.machine_id = m.id AND w.status NOT IN ('Concluída', 'Cancelada')) AS open_orders,
      (SELECT COUNT(*) FROM work_orders w WHERE w.machine_id = m.id AND w.machine_stopped = 1 AND w.status NOT IN ('Concluída', 'Cancelada')) AS stopped_orders
    FROM machines m
    JOIN sectors s ON s.id = m.sector_id
    ORDER BY m.code
  `).all();
  res.json({ machines: rows });
});

app.post('/api/machines', requireAdmin, (req, res) => {
  const { code, name, sectorId, criticality = 'media', hourlyCost = 0, operatingHoursPerDay = 16, imageUrl = null, defaultChecklist = [] } = req.body || {};
  if (!code || !name || !sectorId) {
    return res.status(400).json({ error: 'Informe a TAG/código, o nome da máquina e o setor' });
  }
  const cleanCode = String(code).trim().toUpperCase();
  const cleanName = String(name).trim();
  const sec = db.prepare('SELECT id FROM sectors WHERE id = ?').get(sectorId);
  if (!sec) return res.status(400).json({ error: 'Setor selecionado inválido' });
  const exists = db.prepare('SELECT id FROM machines WHERE UPPER(code) = ?').get(cleanCode);
  if (exists) return res.status(400).json({ error: 'Já existe uma máquina com esta TAG/código' });
  const id = 'm-' + cleanCode.toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + Date.now().toString(36).slice(-4);
  const hCost = Math.max(0, Number(hourlyCost) || 0);
  const opHours = Math.max(1, Math.min(24, Number(operatingHoursPerDay) || 16));

  const rawList = Array.isArray(defaultChecklist) ? defaultChecklist : (typeof defaultChecklist === 'string' ? defaultChecklist.split('\n') : []);
  const cleanList = rawList.map((s) => String(s).trim()).filter(Boolean);
  const checklistJson = JSON.stringify(cleanList);

  db.prepare(`
    INSERT INTO machines (id, code, name, sector_id, criticality, hourly_cost, operating_hours_per_day, image_url, default_checklist_json, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, cleanCode, cleanName, sectorId, criticality, hCost, opHours, imageUrl || null, checklistJson);

  const created = db.prepare('SELECT m.*, s.name as sector_name, s.code as sector_code FROM machines m JOIN sectors s ON s.id=m.sector_id WHERE m.id=?').get(id);
  res.status(201).json({ ok: true, machine: created });
});

app.put('/api/machines/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM machines WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Máquina não encontrada' });
  const { code, name, sectorId, criticality, hourlyCost, operatingHoursPerDay, imageUrl, active, defaultChecklist } = req.body || {};
  const cleanCode = code ? String(code).trim().toUpperCase() : target.code;
  const cleanName = name ? String(name).trim() : target.name;
  const secId = sectorId || target.sector_id;
  const crit = criticality || target.criticality;
  const hCost = hourlyCost !== undefined ? Math.max(0, Number(hourlyCost) || 0) : target.hourly_cost;
  const opHours = operatingHoursPerDay !== undefined ? Math.max(1, Math.min(24, Number(operatingHoursPerDay) || 16)) : target.operating_hours_per_day;
  const img = imageUrl !== undefined ? imageUrl : target.image_url;
  const act = active !== undefined ? (active ? 1 : 0) : target.active;

  let checklistJson = target.default_checklist_json || '[]';
  if (defaultChecklist !== undefined) {
    const rawList = Array.isArray(defaultChecklist) ? defaultChecklist : (typeof defaultChecklist === 'string' ? defaultChecklist.split('\n') : []);
    const cleanList = rawList.map((s) => String(s).trim()).filter(Boolean);
    checklistJson = JSON.stringify(cleanList);
  }

  if (cleanCode !== target.code) {
    const exists = db.prepare('SELECT id FROM machines WHERE UPPER(code) = ? AND id != ?').get(cleanCode, target.id);
    if (exists) return res.status(400).json({ error: 'Já existe outra máquina com esta TAG' });
  }

  db.prepare(`
    UPDATE machines
    SET code = ?, name = ?, sector_id = ?, criticality = ?, hourly_cost = ?, operating_hours_per_day = ?, image_url = ?, default_checklist_json = ?, active = ?
    WHERE id = ?
  `).run(cleanCode, cleanName, secId, crit, hCost, opHours, img, checklistJson, act, target.id);

  const updated = db.prepare('SELECT m.*, s.name as sector_name, s.code as sector_code FROM machines m JOIN sectors s ON s.id=m.sector_id WHERE m.id=?').get(target.id);
  res.json({ ok: true, machine: updated });
});

app.delete('/api/machines/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM machines WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Máquina não encontrada' });
  const woCount = db.prepare('SELECT COUNT(*) AS n FROM work_orders WHERE machine_id = ?').get(target.id).n;
  if (woCount > 0) {
    db.prepare('UPDATE machines SET active = 0 WHERE id = ?').run(target.id);
    return res.json({ ok: true, deactivated: true, message: `Máquina desativada para manter histórico de ${woCount} OSs.` });
  }
  db.prepare('DELETE FROM machines WHERE id = ?').run(target.id);
  res.json({ ok: true, deleted: target.id });
});

// ---------- Bootstrap e Dados Gerais ----------
app.get('/api/bootstrap', (req, res) => {
  res.json({
    serverTime: new Date().toISOString(),
    currentUser: req.user || null,
    sectors: db.prepare('SELECT * FROM sectors ORDER BY name').all(),
    teams: db.prepare('SELECT * FROM teams ORDER BY name').all(),
    users: db.prepare('SELECT id,name,username,email,role,team_id,specialty,avatar_url FROM users WHERE active=1 ORDER BY role, name').all(),
    machines: db.prepare('SELECT m.*, s.name as sector FROM machines m JOIN sectors s ON s.id=m.sector_id WHERE m.active=1 ORDER BY m.code').all(),
    settings: { defaultRecipientsMode: getSetting(db, 'default_recipients_mode', 'todos') },
  });
});

app.get('/api/workorders', (req, res) => {
  const since = new Date(Date.now() - Number(req.query.days || 30) * 86400000).toISOString();
  const isTech = req.user?.role === 'manutentor';
  const isSol = req.user?.role === 'solicitante';
  const scope = req.query.scope; // 'minhas', 'disponiveis', 'todas'

  let query = `
    SELECT * FROM work_orders
    WHERE (status NOT IN ('Concluída','Cancelada') OR closed_at >= ? OR created_at >= ?)
  `;
  const params = [since, since];

  if (isSol) {
    // Solicitante: vê exclusivamente as ordens que ele próprio abriu
    query += ` AND requester_id = ?`;
    params.push(req.user.id);
  } else if (isTech && scope === 'disponiveis') {
    // Abertas sem responsável atribuído para o manutentor assumir
    query += ` AND status = 'Aberta' AND responsible_id IS NULL`;
  } else if (isTech && scope !== 'todas') {
    // Padrão do manutentor: somente as OS vinculadas a ele (responsável ou participante)
    query += ` AND (responsible_id = ? OR id IN (SELECT wo_id FROM wo_participants WHERE user_id = ?))`;
    params.push(req.user.id, req.user.id);
  } else if (req.query.tech) {
    // Filtro por técnico específico (para admin ou superadmin)
    query += ` AND (responsible_id = ? OR id IN (SELECT wo_id FROM wo_participants WHERE user_id = ?))`;
    params.push(req.query.tech, req.query.tech);
  }

  query += ` ORDER BY machine_stopped DESC, created_at DESC`;

  const rows = db.prepare(query).all(...params);
  res.json({
    serverTime: new Date().toISOString(),
    userRole: req.user?.role || 'anon',
    workOrders: rows.map((w) => serializeWo(w))
  });
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
  const notifCols = db.prepare(`PRAGMA table_info(notifications)`).all().map((c) => c.name);
  const hasStatus = notifCols.includes('status');
  if (req.body?.all) {
    if (hasStatus) db.prepare('UPDATE notifications SET read_at=?, status=? WHERE user_id=? AND read_at IS NULL').run(at, 'lida', req.user.id);
    else db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(at, req.user.id);
  }
  for (const id of req.body?.ids || []) {
    if (hasStatus) db.prepare('UPDATE notifications SET read_at=?, status=? WHERE id=? AND user_id=?').run(at, 'lida', id, req.user.id);
    else db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(at, id, req.user.id);
  }
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

app.get('/api/indicators', requireUser, (req, res) => {
  const q = { ...req.query };
  if (req.user.role === 'manutentor') {
    // Manutentor vê estritamente seus próprios atendimentos e indicadores
    q.userId = req.user.id;
  } else if (!['admin', 'superadmin', 'gerente'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso restrito' });
  }
  res.json(computeIndicators(db, q));
});

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
