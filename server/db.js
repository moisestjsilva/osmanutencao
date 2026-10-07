// Camada de dados (SQLite nativo do Node >= 22.13 — sem dependências nativas para compilar).
// Para produção pode ser trocado por MySQL mantendo as mesmas tabelas.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'nova-os.db');

export function openDb() {
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0) seed(db);
  return db;
}

export function resetDb() {
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  for (const f of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, f));
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE IF NOT EXISTS sectors (
    id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('solicitante','manutentor','gerente')),
    team_id TEXT REFERENCES teams(id), specialty TEXT, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    sector_id TEXT NOT NULL REFERENCES sectors(id),
    criticality TEXT NOT NULL DEFAULT 'media', active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS work_orders (
    id TEXT PRIMARY KEY,
    number TEXT UNIQUE,
    machine_id TEXT NOT NULL REFERENCES machines(id),
    type TEXT NOT NULL CHECK (type IN ('corretiva','preventiva')),
    priority TEXT NOT NULL DEFAULT 'media',
    machine_stopped INTEGER NOT NULL DEFAULT 0,
    requester_id TEXT REFERENCES users(id),
    responsible_id TEXT REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'Aberta',
    title TEXT, description TEXT NOT NULL,
    specialty TEXT,
    recipients_mode TEXT NOT NULL DEFAULT 'todos',
    recipients_json TEXT NOT NULL DEFAULT '[]',
    service_done TEXT, cause TEXT, solution TEXT,
    materials_used TEXT, tools_used TEXT, notes TEXT,
    machine_recovered INTEGER, returned_at TEXT,
    checklist_json TEXT,
    plan_id TEXT, cycle_key TEXT UNIQUE, due_date TEXT,
    reopened_count INTEGER NOT NULL DEFAULT 0,
    rework_of TEXT REFERENCES work_orders(id),
    created_at TEXT NOT NULL, received_at TEXT NOT NULL,
    closed_at TEXT, cancelled_reason TEXT,
    version INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS wo_participants (
    wo_id TEXT NOT NULL REFERENCES work_orders(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'colaborador',
    state TEXT NOT NULL DEFAULT 'aguardando',
    joined_at TEXT NOT NULL,
    PRIMARY KEY (wo_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS work_intervals (
    id TEXT PRIMARY KEY,
    wo_id TEXT NOT NULL REFERENCES work_orders(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL, ended_at TEXT,
    end_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS wo_events (
    id TEXT PRIMARY KEY,
    wo_id TEXT NOT NULL REFERENCES work_orders(id),
    user_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    reason TEXT,
    data_json TEXT,
    local_time TEXT NOT NULL,
    received_at TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'online'
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    wo_id TEXT NOT NULL REFERENCES work_orders(id),
    user_id TEXT, file TEXT NOT NULL, mime TEXT, size INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS machine_stops (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL REFERENCES machines(id),
    started_at TEXT NOT NULL, ended_at TEXT,
    wo_ids_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS preventive_plans (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL REFERENCES machines(id),
    title TEXT NOT NULL,
    frequency_days INTEGER NOT NULL,
    anchor_date TEXT NOT NULL,
    next_due TEXT NOT NULL,
    lead_days INTEGER NOT NULL DEFAULT 2,
    tolerance_days INTEGER NOT NULL DEFAULT 0,
    checklist_json TEXT NOT NULL DEFAULT '[]',
    responsible_id TEXT REFERENCES users(id),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    wo_id TEXT REFERENCES work_orders(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    channel TEXT NOT NULL DEFAULT 'app',
    kind TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT,
    status TEXT NOT NULL DEFAULT 'enviada',
    attempts INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, read_at TEXT
  );

  CREATE TABLE IF NOT EXISTS processed_ops (
    op_id TEXT PRIMARY KEY,
    user_id TEXT, type TEXT,
    status TEXT NOT NULL,
    result_json TEXT,
    local_time TEXT, received_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    op_id TEXT NOT NULL,
    wo_id TEXT, user_id TEXT, type TEXT,
    payload_json TEXT, reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT, resolved_by TEXT, resolution TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    entity TEXT NOT NULL, entity_id TEXT NOT NULL,
    field TEXT, old_value TEXT, new_value TEXT,
    reason TEXT, user_id TEXT, created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_wo ON wo_events(wo_id);
  CREATE INDEX IF NOT EXISTS idx_intervals_wo ON work_intervals(wo_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);
  `);

  // Migração de colunas adicionais para máquinas (custo hora parada, horas funcionamento, foto)
  const machCols = db.prepare(`PRAGMA table_info(machines)`).all().map((c) => c.name);
  if (!machCols.includes('hourly_cost')) {
    db.exec(`ALTER TABLE machines ADD COLUMN hourly_cost REAL NOT NULL DEFAULT 0.0`);
  }
  if (!machCols.includes('operating_hours_per_day')) {
    db.exec(`ALTER TABLE machines ADD COLUMN operating_hours_per_day REAL NOT NULL DEFAULT 16.0`);
  }
  if (!machCols.includes('image_url')) {
    db.exec(`ALTER TABLE machines ADD COLUMN image_url TEXT`);
  }
  if (!machCols.includes('default_checklist_json')) {
    db.exec(`ALTER TABLE machines ADD COLUMN default_checklist_json TEXT NOT NULL DEFAULT '[]'`);
  }

  // Migração de colunas adicionais para usuários (foto/avatar)
  const userCols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  if (!userCols.includes('avatar_url')) {
    db.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT`);
  }

  // Migração para notifications
  const notifCols = db.prepare(`PRAGMA table_info(notifications)`).all().map((c) => c.name);
  if (!notifCols.includes('status')) {
    db.exec(`ALTER TABLE notifications ADD COLUMN status TEXT DEFAULT 'enviada'`);
  }
}

// ---------- Dados fictícios de demonstração ----------
const iso = (d) => d.toISOString();
const daysAgo = (n, h = 8, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, m, 0, 0);
  return d;
};
const addMin = (d, min) => new Date(d.getTime() + min * 60000);
const dateOnly = (d) => d.toISOString().slice(0, 10);

function seed(db) {
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  db.exec('BEGIN');
  try {
    ins(`INSERT INTO settings VALUES ('default_recipients_mode','todos')`);
    ins(`INSERT INTO settings VALUES ('next_wo_number','1001')`);

    const sectors = [
      ['sec-usi', 'S-USI', 'Usinagem'],
      ['sec-est', 'S-EST', 'Estamparia'],
      ['sec-mon', 'S-MON', 'Montagem'],
      ['sec-uti', 'S-UTI', 'Utilidades'],
    ];
    sectors.forEach((s) => ins('INSERT INTO sectors VALUES (?,?,?)', ...s));

    ins(`INSERT INTO teams VALUES ('team-mec','Mecânica')`);
    ins(`INSERT INTO teams VALUES ('team-ele','Elétrica')`);

    const users = [
      ['u-ana', 'Ana Souza (Produção)', 'solicitante', null, null],
      ['u-bruno', 'Bruno Lima (Produção)', 'solicitante', null, null],
      ['u-carlos', 'Carlos Mendes', 'manutentor', 'team-mec', 'Mecânico'],
      ['u-diego', 'Diego Rocha', 'manutentor', 'team-mec', 'Mecânico'],
      ['u-elaine', 'Elaine Costa', 'manutentor', 'team-ele', 'Eletricista'],
      ['u-fabio', 'Fábio Nunes', 'manutentor', 'team-ele', 'Eletricista'],
      ['u-gerente', 'Gisele Ramos (Gerente)', 'gerente', null, null],
    ];
    users.forEach((u) =>
      ins('INSERT INTO users (id,name,role,team_id,specialty) VALUES (?,?,?,?,?)', ...u)
    );

    const machines = [
      ['m-tor01', 'M-TOR01', 'Torno CNC Romi 01', 'sec-usi', 'alta'],
      ['m-tor02', 'M-TOR02', 'Torno CNC Romi 02', 'sec-usi', 'alta'],
      ['m-fre01', 'M-FRE01', 'Fresadora Vertical 01', 'sec-usi', 'media'],
      ['m-prs01', 'M-PRS01', 'Prensa Excêntrica 150t', 'sec-est', 'alta'],
      ['m-prs02', 'M-PRS02', 'Prensa Hidráulica 80t', 'sec-est', 'media'],
      ['m-gui01', 'M-GUI01', 'Guilhotina 3m', 'sec-est', 'media'],
      ['m-lin01', 'M-LIN01', 'Linha de Montagem 01', 'sec-mon', 'alta'],
      ['m-par01', 'M-PAR01', 'Parafusadeira Automática', 'sec-mon', 'baixa'],
      ['m-cmp01', 'M-CMP01', 'Compressor de Parafuso 50hp', 'sec-uti', 'alta'],
      ['m-cal01', 'M-CAL01', 'Caldeira Vapor 01', 'sec-uti', 'alta'],
    ];
    machines.forEach((m) =>
      ins('INSERT INTO machines (id,code,name,sector_id,criticality) VALUES (?,?,?,?,?)', ...m)
    );

    // Planos preventivos
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const plans = [
      ['pp-cmp', 'm-cmp01', 'Troca de filtros e verificação de óleo', 30, dateOnly(addDays(today, -58)), dateOnly(addDays(today, 2)), 3,
        ['Trocar filtro de ar', 'Verificar nível de óleo', 'Drenar condensado', 'Verificar correias'], 'u-carlos'],
      ['pp-prs', 'm-prs01', 'Lubrificação e inspeção de embreagem', 15, dateOnly(addDays(today, -33)), dateOnly(addDays(today, -3)), 2,
        ['Lubrificar guias', 'Inspecionar embreagem/freio', 'Verificar sistema de segurança bimanual'], 'u-diego'],
      ['pp-qde', 'm-lin01', 'Inspeção termográfica de painel', 90, dateOnly(addDays(today, -80)), dateOnly(addDays(today, 10)), 5,
        ['Termografia do painel principal', 'Reaperto de bornes', 'Teste de emergências'], 'u-elaine'],
    ];
    plans.forEach((p) =>
      ins(`INSERT INTO preventive_plans (id,machine_id,title,frequency_days,anchor_date,next_due,lead_days,checklist_json,responsible_id,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        p[0], p[1], p[2], p[3], p[4], p[5], p[6], JSON.stringify(p[7].map((t) => ({ text: t, done: false }))), p[8], iso(daysAgo(60)))
    );

    // Histórico de OS concluídas para indicadores
    let num = 1001;
    const hist = [
      // [dias atrás, máquina, técnico, colaborador, resposta(min), trabalho(min), parada, descrição, causa, solução, tipo]
      [20, 'm-tor01', 'u-carlos', null, 12, 95, 1, 'Torno não liga o eixo árvore', 'Contatora queimada', 'Substituída contatora K1', 'corretiva'],
      [17, 'm-prs01', 'u-diego', 'u-carlos', 25, 140, 1, 'Vazamento de óleo na prensa', 'Retentor gasto', 'Troca do retentor do cilindro', 'corretiva'],
      [15, 'm-cmp01', 'u-elaine', null, 8, 45, 1, 'Compressor desarmando', 'Relé térmico mal ajustado', 'Ajuste do relé e reaperto', 'corretiva'],
      [12, 'm-tor01', 'u-fabio', null, 30, 60, 0, 'Ruído no painel do torno', 'Ventilador do painel travado', 'Substituído ventilador', 'corretiva'],
      [9, 'm-lin01', 'u-carlos', 'u-elaine', 15, 180, 1, 'Esteira parada na estação 3', 'Rolamento travado', 'Troca do rolamento e alinhamento', 'corretiva'],
      [6, 'm-gui01', 'u-diego', null, 40, 50, 0, 'Corte irregular na guilhotina', 'Folga na lâmina', 'Ajuste de folga da lâmina', 'corretiva'],
      [4, 'm-cmp01', 'u-carlos', null, 10, 70, 0, 'Preventiva mensal compressor', null, 'Checklist completo', 'preventiva'],
      [2, 'm-tor02', 'u-elaine', 'u-fabio', 18, 110, 1, 'Erro de servo no eixo Z', 'Cabo do encoder danificado', 'Troca do cabo do encoder', 'corretiva'],
    ];
    for (const h of hist) {
      const [ago, mid, tech, colab, resp, work, stopped, desc, cause, sol, type] = h;
      const id = randomUUID();
      const created = daysAgo(ago, 7 + (ago % 5), 10);
      const start = addMin(created, resp);
      const end = addMin(start, work);
      const closed = addMin(end, 5);
      const requester = ago % 2 ? 'u-ana' : 'u-bruno';
      ins(`INSERT INTO work_orders (id,number,machine_id,type,priority,machine_stopped,requester_id,responsible_id,status,description,
             recipients_mode,service_done,cause,solution,machine_recovered,returned_at,created_at,received_at,closed_at,plan_id,checklist_json)
           VALUES (?,?,?,?,?,?,?,?,'Concluída',?,'todos',?,?,?,?,?,?,?,?,?,?)`,
        id, num++, mid, type, stopped ? 'alta' : 'media', stopped, type === 'preventiva' ? 'u-gerente' : requester, tech, desc,
        sol, cause, sol, stopped ? 1 : null, stopped ? iso(end) : null, iso(created), iso(created), iso(closed),
        type === 'preventiva' ? 'pp-cmp' : null,
        type === 'preventiva' ? JSON.stringify([{ text: 'Trocar filtro de ar', done: true }, { text: 'Verificar nível de óleo', done: true }]) : null);
      const ev = (uid, action, t, reason = null) =>
        ins(`INSERT INTO wo_events (id,wo_id,user_id,action,reason,local_time,received_at) VALUES (?,?,?,?,?,?,?)`,
          randomUUID(), id, uid, action, reason, iso(t), iso(t));
      ev(type === 'preventiva' ? 'u-gerente' : requester, 'criar', created);
      ev(tech, 'assumir', addMin(created, Math.max(1, resp - 3)));
      ins(`INSERT INTO wo_participants VALUES (?,?,?,?,?)`, id, tech, 'responsavel', 'concluido', iso(created));
      ev(tech, 'iniciar', start);
      ins(`INSERT INTO work_intervals VALUES (?,?,?,?,?,?)`, randomUUID(), id, tech, iso(start), iso(end), 'conclusao');
      if (colab) {
        const cs = addMin(start, 20);
        ins(`INSERT INTO wo_participants VALUES (?,?,?,?,?)`, id, colab, 'colaborador', 'concluido', iso(cs));
        ev(colab, 'participar', cs);
        ev(colab, 'iniciar', cs);
        ins(`INSERT INTO work_intervals VALUES (?,?,?,?,?,?)`, randomUUID(), id, colab, iso(cs), iso(addMin(cs, Math.round(work * 0.6))), 'encerrar_parte');
        ev(colab, 'encerrar_parte', addMin(cs, Math.round(work * 0.6)));
      }
      ev(tech, 'concluir', closed);
      if (stopped) {
        ins(`INSERT INTO machine_stops VALUES (?,?,?,?,?)`, randomUUID(), mid, iso(created), iso(end), JSON.stringify([id]));
      }
    }

    // Uma OS aberta com máquina parada e uma em atendimento
    const openId = randomUUID();
    const oc = addMin(new Date(), -35);
    ins(`INSERT INTO work_orders (id,number,machine_id,type,priority,machine_stopped,requester_id,status,description,recipients_mode,created_at,received_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      openId, num++, 'm-prs02', 'corretiva', 'urgente', 1, 'u-ana', 'Aberta', 'Prensa hidráulica sem pressão, bomba fazendo barulho', 'todos', iso(oc), iso(oc));
    ins(`INSERT INTO wo_events (id,wo_id,user_id,action,local_time,received_at) VALUES (?,?,?,?,?,?)`, randomUUID(), openId, 'u-ana', 'criar', iso(oc), iso(oc));
    ins(`INSERT INTO machine_stops VALUES (?,?,?,?,?)`, randomUUID(), 'm-prs02', iso(oc), null, JSON.stringify([openId]));
    for (const u of ['u-carlos', 'u-diego', 'u-elaine', 'u-fabio', 'u-gerente']) {
      ins(`INSERT INTO notifications (id,wo_id,user_id,kind,title,body,created_at) VALUES (?,?,?,?,?,?,?)`,
        randomUUID(), openId, u, 'nova_os', `MÁQUINA PARADA • OS ${num - 1}`, 'Prensa Hidráulica 80t — Estamparia', iso(oc));
    }

    const wipId = randomUUID();
    const wc = addMin(new Date(), -90);
    const ws = addMin(wc, 14);
    ins(`INSERT INTO work_orders (id,number,machine_id,type,priority,machine_stopped,requester_id,responsible_id,status,description,recipients_mode,created_at,received_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      wipId, num++, 'm-fre01', 'corretiva', 'media', 0, 'u-bruno', 'u-elaine', 'Em atendimento', 'Iluminação da fresadora piscando', 'equipe', iso(wc), iso(wc));
    db.prepare('UPDATE work_orders SET recipients_json=? WHERE id=?').run(JSON.stringify(['team-ele']), wipId);
    ins(`INSERT INTO wo_participants VALUES (?,?,?,?,?)`, wipId, 'u-elaine', 'responsavel', 'trabalhando', iso(addMin(wc, 10)));
    ins(`INSERT INTO work_intervals (id,wo_id,user_id,started_at) VALUES (?,?,?,?)`, randomUUID(), wipId, 'u-elaine', iso(ws));
    for (const [u, a, t] of [['u-bruno', 'criar', wc], ['u-elaine', 'assumir', addMin(wc, 10)], ['u-elaine', 'iniciar', ws]]) {
      ins(`INSERT INTO wo_events (id,wo_id,user_id,action,local_time,received_at) VALUES (?,?,?,?,?,?)`, randomUUID(), wipId, u, a, iso(t), iso(t));
    }

    db.prepare(`UPDATE settings SET value=? WHERE key='next_wo_number'`).run(String(num));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
