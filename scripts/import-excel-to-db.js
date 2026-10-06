import xlsx from 'xlsx';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const file = path.resolve('Relatorio_Geral_Manutencao_Rufato_2026-10-06.xlsx');
if (!fs.existsSync(file)) {
  console.error('Arquivo Excel não encontrado:', file);
  process.exit(1);
}

const wb = xlsx.readFile(file);
const wosRaw = xlsx.utils.sheet_to_json(wb.Sheets['Ordens de Serviço']);
const machinesRaw = xlsx.utils.sheet_to_json(wb.Sheets['Maquinário e TAGs']);
const techsRaw = xlsx.utils.sheet_to_json(wb.Sheets['Manutentores']);

console.log(`Lendo Excel: ${wosRaw.length} OS, ${machinesRaw.length} Máquinas, ${techsRaw.length} Manutentores.`);

function norm(str) {
  return String(str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function clean(str) {
  return String(str || '').trim();
}

// Caminho do banco SQLite
const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'nova-os.db');

// Backup se existir
if (fs.existsSync(DB_FILE)) {
  fs.copyFileSync(DB_FILE, path.join(DATA_DIR, 'nova-os.db.backup'));
  console.log('Backup do banco criado: nova-os.db.backup');
}

// Remove arquivo existente para recriar 100% limpo com novo esquema
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Recriação de tabelas com número como TEXT e colunas extras úteis
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
    title TEXT NOT NULL,
    body TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT
  );

  CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    wo_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    op_id TEXT NOT NULL,
    type TEXT NOT NULL,
    server_state TEXT,
    incoming_payload TEXT,
    message TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
  );
`);

console.log('Tabelas SQLite criadas com sucesso!');

// Inicia transação de inserção
db.exec('BEGIN TRANSACTION;');

// 1. SETORES
const sectorsMap = new Map();
function getOrCreateSector(name) {
  const cleanName = clean(name) || 'GERAL';
  const upper = cleanName.toUpperCase();
  if (sectorsMap.has(upper)) return sectorsMap.get(upper);

  const num = sectorsMap.size + 1;
  const id = 'sec-' + norm(upper).replace(/[^a-z0-9]/g, '-').slice(0, 15) + '-' + num;
  const code = 'S-' + upper.replace(/[^A-Z0-9]/g, '').slice(0, 4) + String(num).padStart(2, '0');
  const sec = { id, code, name: upper };
  sectorsMap.set(upper, sec);
  db.prepare('INSERT INTO sectors (id, code, name) VALUES (?,?,?)').run(sec.id, sec.code, sec.name);
  return sec;
}

for (const m of machinesRaw) getOrCreateSector(m.Setor);
for (const w of wosRaw) getOrCreateSector(w['Setor / Local']);
console.log(`[1/5] Inseridos ${sectorsMap.size} Setores.`);

// 2. EQUIPES
db.prepare("INSERT INTO teams (id, name) VALUES ('team-ele', 'Elétrica')").run();
db.prepare("INSERT INTO teams (id, name) VALUES ('team-mec', 'Mecânica')").run();
db.prepare("INSERT INTO teams (id, name) VALUES ('team-geral', 'Geral')").run();
console.log('[2/5] Inseridas Equipes de Manutenção.');

// 3. USUÁRIOS
const usersMap = new Map();

// Gerente de Manutenção
const gerente = {
  id: 'u-gerente',
  name: 'Gisele Ramos (Gerente)',
  role: 'gerente',
  team_id: null,
  specialty: 'Gestão de Manutenção'
};
usersMap.set('gerente', gerente);
db.prepare('INSERT INTO users (id, name, role, team_id, specialty) VALUES (?,?,?,?,?)')
  .run(gerente.id, gerente.name, gerente.role, gerente.team_id, gerente.specialty);

// Manutentores reais da Rufato
for (const t of techsRaw) {
  const name = clean(t['Nome do Manutentor']);
  if (!name || norm(name) === 'teste') continue;
  const key = norm(name);
  if (!usersMap.has(key)) {
    const id = 'u-tech-' + key.replace(/[^a-z0-9]/g, '');
    const isEletrica = ['pablo', 'felipe'].includes(key);
    const team_id = isEletrica ? 'team-ele' : 'team-mec';
    const specialty = isEletrica ? 'Eletricista' : 'Mecânico';
    const userObj = { id, name, role: 'manutentor', team_id, specialty };
    usersMap.set(key, userObj);
    db.prepare('INSERT INTO users (id, name, role, team_id, specialty) VALUES (?,?,?,?,?)')
      .run(userObj.id, userObj.name, userObj.role, userObj.team_id, userObj.specialty);
  }
}

// Solicitantes das OS reais
for (const w of wosRaw) {
  const req = clean(w.Solicitante);
  if (!req) continue;
  const key = norm(req);
  if (!usersMap.has(key)) {
    const isKnownTech = usersMap.has(norm(req.replace(/\/.*$/, '')));
    const num = usersMap.size + 1;
    const id = (isKnownTech ? 'u-tech-' : 'u-sol-') + norm(req).replace(/[^a-z0-9]/g, '').slice(0, 15) + '-' + num;
    const role = isKnownTech ? 'manutentor' : 'solicitante';
    const team_id = isKnownTech ? 'team-mec' : null;
    const userObj = { id, name: req, role, team_id, specialty: null };
    usersMap.set(key, userObj);
    db.prepare('INSERT INTO users (id, name, role, team_id, specialty) VALUES (?,?,?,?,?)')
      .run(userObj.id, userObj.name, userObj.role, userObj.team_id, userObj.specialty);
  }
}
console.log(`[3/5] Inseridos ${usersMap.size} Usuários (Manutentores, Solicitantes e Gerente).`);

// 4. MÁQUINAS COM TAGS E QR CODES
const machinesList = [];
const machineLookup = new Map();
let macSeq = 1;

for (const m of machinesRaw) {
  const rawTag = clean(m.TAG);
  const hasRealTag = rawTag && !['sem tag', 'sem numero', 'sem número'].includes(norm(rawTag));
  const eqName = clean(m.Equipamento) || 'Equipamento Indefinido';
  const sector = getOrCreateSector(m.Setor);

  // TAG é o código do equipamento
  const code = hasRealTag ? rawTag : `EQ-${norm(sector.name).slice(0, 3).toUpperCase()}-${String(macSeq).padStart(3, '0')}`;
  const id = 'm-' + (hasRealTag ? 'tag-' + norm(rawTag) : 'eq-' + macSeq);
  macSeq++;

  const crit = (m['Paradas Críticas (Máq. Parada)'] > 20) ? 'alta' : (m['Total de O.S.'] > 10 ? 'media' : 'baixa');
  const machineObj = { id, code, name: eqName, sector_id: sector.id, criticality: crit, active: 1 };

  machinesList.push(machineObj);
  if (hasRealTag) machineLookup.set('tag:' + norm(rawTag), machineObj);
  machineLookup.set('eq:' + norm(eqName) + '||' + sector.id, machineObj);

  db.prepare('INSERT INTO machines (id, code, name, sector_id, criticality, active) VALUES (?,?,?,?,?,?)')
    .run(machineObj.id, machineObj.code, machineObj.name, machineObj.sector_id, machineObj.criticality, machineObj.active);
}

// Máquinas adicionais encontradas apenas nas OS
for (const w of wosRaw) {
  const rawTag = clean(w.TAG);
  const hasRealTag = rawTag && !['sem tag', 'sem numero', 'sem número'].includes(norm(rawTag));
  const eqName = clean(w.Equipamento) || 'Equipamento Geral';
  const sector = getOrCreateSector(w['Setor / Local']);

  let found = null;
  if (hasRealTag && machineLookup.has('tag:' + norm(rawTag))) {
    found = machineLookup.get('tag:' + norm(rawTag));
  } else if (machineLookup.has('eq:' + norm(eqName) + '||' + sector.id)) {
    found = machineLookup.get('eq:' + norm(eqName) + '||' + sector.id);
  }

  if (!found) {
    const code = hasRealTag ? rawTag : `EQ-${norm(sector.name).slice(0, 3).toUpperCase()}-${String(macSeq).padStart(3, '0')}`;
    const id = 'm-' + (hasRealTag ? 'tag-' + norm(rawTag) : 'eq-' + macSeq);
    macSeq++;

    const newMachine = { id, code, name: eqName, sector_id: sector.id, criticality: 'media', active: 1 };
    machinesList.push(newMachine);
    if (hasRealTag) machineLookup.set('tag:' + norm(rawTag), newMachine);
    machineLookup.set('eq:' + norm(eqName) + '||' + sector.id, newMachine);

    db.prepare('INSERT INTO machines (id, code, name, sector_id, criticality, active) VALUES (?,?,?,?,?,?)')
      .run(newMachine.id, newMachine.code, newMachine.name, newMachine.sector_id, newMachine.criticality, newMachine.active);
  }
}
console.log(`[4/5] Inseridas ${machinesList.length} Máquinas (100% com TAGs e QR).`);

// 5. IMPORTAÇÃO DAS 1000 ORDENS DE SERVIÇO HISTÓRICAS
const insWo = db.prepare(`
  INSERT INTO work_orders (
    id, number, machine_id, type, priority, machine_stopped,
    requester_id, responsible_id, status, title, description,
    specialty, service_done, cause, solution, materials_used, tools_used, notes,
    machine_recovered, returned_at, created_at, received_at, closed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const insPart = db.prepare(`INSERT OR IGNORE INTO wo_participants (wo_id, user_id, role, state, joined_at) VALUES (?,?,?,?,?)`);
const insInterval = db.prepare(`INSERT INTO work_intervals (id, wo_id, user_id, started_at, ended_at, end_reason) VALUES (?,?,?,?,?,?)`);
const insEvent = db.prepare(`INSERT INTO wo_events (id, wo_id, user_id, action, reason, local_time, received_at) VALUES (?,?,?,?,?,?,?)`);
const insStop = db.prepare(`INSERT INTO machine_stops (id, machine_id, started_at, ended_at, wo_ids_json) VALUES (?,?,?,?,?)`);

let woCount = 0;
for (const w of wosRaw) {
  const num = clean(w['Nº O.S.']);
  const woId = 'wo-' + num;

  const rawTag = clean(w.TAG);
  const hasRealTag = rawTag && !['sem tag', 'sem numero', 'sem número'].includes(norm(rawTag));
  const eqName = clean(w.Equipamento) || 'Equipamento Geral';
  const sector = getOrCreateSector(w['Setor / Local']);

  let mac = null;
  if (hasRealTag && machineLookup.has('tag:' + norm(rawTag))) {
    mac = machineLookup.get('tag:' + norm(rawTag));
  } else if (machineLookup.has('eq:' + norm(eqName) + '||' + sector.id)) {
    mac = machineLookup.get('eq:' + norm(eqName) + '||' + sector.id);
  }

  // Datas
  const [d, m, y] = clean(w['Data de Abertura']).split('/');
  const createdDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const horaInicio = clean(w['Hora Início']) || '08:00:00';
  const createdAtIso = `${createdDate}T${horaInicio}.000Z`;

  // Status
  let status = clean(w.Status);
  if (norm(status) === 'concluida') status = 'Concluída';
  else if (norm(status) === 'aguardando') status = 'Aguardando';
  else if (norm(status) === 'cancelada') status = 'Cancelada';
  else status = 'Aberta';

  // Situação e Parada
  const sit = clean(w['Situação do Equipamento']);
  const machineStopped = sit.toLowerCase().includes('parada') ? 1 : 0;
  const priority = machineStopped ? 'urgente' : (sit.toLowerCase().includes('restricao') || sit.toLowerCase().includes('restrição') ? 'alta' : 'media');

  // Tipo
  const rawType = clean(w['Tipo de Manutenção']);
  const type = norm(rawType).includes('programada') ? 'preventiva' : 'corretiva';

  // Solicitante
  const reqName = clean(w.Solicitante);
  const requester = reqName && usersMap.get(norm(reqName)) ? usersMap.get(norm(reqName)).id : 'u-gerente';

  // Manutentores
  const techNamesRaw = clean(w['Manutentores Responsáveis']);
  const techTokens = techNamesRaw.split(',').map((x) => clean(x)).filter(Boolean);
  const techObjs = [];
  for (const tk of techTokens) {
    const u = usersMap.get(norm(tk));
    if (u) techObjs.push(u);
  }
  const responsibleId = techObjs.length > 0 ? techObjs[0].id : null;

  // Datas de Início e Término
  let dataInicio = clean(w['Data Início Reparo']) || createdDate;
  if (dataInicio.includes('/')) dataInicio = dataInicio.split('/').reverse().join('-');
  const startAtIso = `${dataInicio}T${horaInicio}.000Z`;

  let closedAtIso = null;
  if (status === 'Concluída') {
    let dataFim = clean(w['Data Conclusão / Previsão']) || dataInicio;
    if (dataFim.includes('/')) dataFim = dataFim.split('/').reverse().join('-');
    const horaFim = clean(w['Hora Conclusão']) || '17:00:00';
    closedAtIso = `${dataFim}T${horaFim}.000Z`;
  }

  const problemDesc = clean(w['Descrição do Problema']) || clean(w['Serviços Executados']) || `Manutenção ${mac.name}`;
  const servDone = clean(w['Serviços Executados']) || null;
  const cause = clean(w['Possíveis Causas']) || null;
  const solution = servDone;
  const matUsed = clean(w['Peças / Materiais Utilizados']) || null;
  const toolsUsed = clean(w['Ferramentas Utilizadas']) || null;
  const notes = clean(w['Observações Gerais']) || null;
  const specialty = clean(w['Especialidade']) || null;
  const title = `${specialty ? `[${specialty}] ` : ''}${mac.name}: ${problemDesc.slice(0, 50)}`;

  insWo.run(
    woId, num, mac.id, type, priority, machineStopped,
    requester, responsibleId, status, title, problemDesc,
    specialty, servDone, cause, solution, matUsed, toolsUsed, notes,
    machineStopped && status === 'Concluída' ? 1 : 0,
    machineStopped && status === 'Concluída' ? closedAtIso : null,
    createdAtIso, createdAtIso, closedAtIso
  );

  // Participantes e Intervalos
  for (let i = 0; i < techObjs.length; i++) {
    const t = techObjs[i];
    const isResp = i === 0;
    insPart.run(woId, t.id, isResp ? 'responsavel' : 'colaborador', status === 'Concluída' ? 'concluido' : 'aguardando', createdAtIso);

    if (status === 'Concluída' && closedAtIso) {
      insInterval.run(randomUUID(), woId, t.id, startAtIso, closedAtIso, 'conclusao');
    }
  }

  // Eventos
  insEvent.run(randomUUID(), woId, requester, 'criar', 'Criação da OS', createdAtIso, createdAtIso);
  if (responsibleId) {
    insEvent.run(randomUUID(), woId, responsibleId, 'assumir', 'Atribuído ao técnico', startAtIso, startAtIso);
    if (status === 'Concluída' && closedAtIso) {
      insEvent.run(randomUUID(), woId, responsibleId, 'concluir', 'Serviço finalizado', closedAtIso, closedAtIso);
    }
  }

  // Histórico de Parada de Máquina
  if (machineStopped && status === 'Concluída' && closedAtIso) {
    insStop.run(randomUUID(), mac.id, createdAtIso, closedAtIso, JSON.stringify([woId]));
  }

  woCount++;
}

// Configura próximo número de OS para continuar sequencialmente
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('next_wo_number', '1001')").run();
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_recipients_mode', 'todos')").run();

db.exec('COMMIT;');

console.log(`[5/5] Sucesso! ${woCount} Ordens de Serviço importadas para o banco!`);
console.log('Banco de dados real atualizado com sucesso em data/nova-os.db');
db.close();
