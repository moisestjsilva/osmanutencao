// ============================================================================
// MÓDULO DE FROTA (caminhões) — núcleo: schema, permissões, validações, regras,
// alertas e relatórios. As rotas HTTP ficam em fleet.js.
// ============================================================================
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './db.js';
import { applyOp, notify, getSetting, setSetting } from './domain.js';
import { sendWhatsAppMessage, isWhatsAppEnabled } from './whatsapp.js';
import { fleetAccessOf } from './auth.js';

export const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- Constantes
export const VEHICLE_STATUS = ['ativo', 'manutencao', 'inativo', 'vendido'];
export const VEHICLE_TYPES = ['cavalo', 'truck', 'toco', 'vuc', 'carreta', 'utilitario', 'van', 'outro'];
export const FUEL_TYPES = ['diesel_s10', 'diesel_s500', 'gasolina', 'etanol', 'gnv', 'arla32'];
export const DOC_TYPES_VEHICLE = ['CRLV', 'Licenciamento', 'IPVA', 'Seguro', 'Seguro de carga (RCF-DC)', 'RNTRC/ANTT', 'Tacógrafo (aferição)', 'Inspeção veicular', 'Outro'];
export const DOC_TYPES_DRIVER = ['Exame toxicológico', 'MOPP', 'Exame médico', 'Curso', 'Outro'];
export const COST_CATEGORIES = ['manutencao', 'pneus', 'pecas', 'pedagio', 'estacionamento', 'lavagem', 'seguro', 'impostos', 'diaria', 'outros'];
export const TIRE_STATUS = ['em_uso', 'estoque', 'recapagem', 'descartado'];
export const TIRE_EVENTS = ['instalacao', 'rodizio', 'recapagem', 'remocao', 'calibragem', 'reparo', 'descarte'];
export const DRIVER_STATUS = ['ativo', 'ferias', 'afastado', 'inativo'];
export const FINE_STATUS = ['pendente', 'paga', 'recurso', 'cancelada'];
export const CNH_CATEGORIES = ['A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE'];
export const FLEET_LEVELS = ['gestor', 'mecanico', 'motorista'];

export class FleetError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------- Permissões
// Admin/Super Admin/Gerente do sistema = gestor de frota. Demais usuários dependem
// do perfil de frota (users.fleet_role): gestor | mecanico | motorista.
export { fleetAccessOf };

// ---------------------------------------------------------------- Datas / números
export function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const round2 = (n) => Math.round(n * 100) / 100;

export function normPlate(p) {
  return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
export const PLATE_RE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/; // antiga (ABC1234) e Mercosul (ABC1D23)

export function validCpf(raw) {
  const c = String(raw || '').replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(c[i]) * (len + 1 - i);
    const dv = ((sum * 10) % 11) % 10;
    if (dv !== Number(c[len])) return false;
  }
  return true;
}

// ---------------------------------------------------------------- Validador de campos
const INVALID = Symbol('invalid');
function conv(def, v) {
  if (v === undefined) return undefined;
  const empty = v === null || v === '';
  switch (def.t) {
    case 'str': return empty ? null : String(v).trim().slice(0, def.max || 200) || null;
    case 'num': case 'int': {
      if (empty) return null;
      const n = Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n)) return INVALID;
      if (def.min != null && n < def.min) return INVALID;
      if (def.max != null && n > def.max) return INVALID;
      return def.t === 'int' ? Math.round(n) : n;
    }
    case 'date': {
      if (empty) return null;
      const s = String(v).slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00Z')) ? s : INVALID;
    }
    case 'dt': {
      if (empty) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? INVALID : d.toISOString();
    }
    case 'enum': return empty ? (def.def ?? null) : (def.list.includes(v) ? v : INVALID);
    case 'bool': return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
    case 'plate': {
      if (empty) return null;
      const p = normPlate(v);
      return PLATE_RE.test(p) ? p : INVALID;
    }
    default: return v;
  }
}

// Converte e valida o corpo da requisição conforme o schema. partial=true (edição): só campos enviados.
export function parseBody(schema, body, { partial = false } = {}) {
  const out = {};
  for (const [field, def] of Object.entries(schema)) {
    const raw = body?.[field];
    const label = def.label || field;
    if (raw === undefined) {
      if (partial) continue;
      if (def.req) throw new FleetError(400, `${label} é obrigatório`);
      out[field] = def.def !== undefined ? def.def : null;
      continue;
    }
    const v = conv(def, raw);
    if (v === INVALID) throw new FleetError(400, `${label}: valor inválido`);
    if (def.req && (v === null || v === undefined)) throw new FleetError(400, `${label} é obrigatório`);
    out[field] = v;
  }
  return out;
}

export const SCHEMAS = {
  vehicle: {
    plate: { t: 'plate', req: true, label: 'Placa' },
    nickname: { t: 'str', max: 60, label: 'Apelido' },
    type: { t: 'enum', list: VEHICLE_TYPES, def: 'truck', label: 'Tipo' },
    brand: { t: 'str', max: 60, label: 'Marca' },
    model: { t: 'str', max: 80, label: 'Modelo' },
    year_manufacture: { t: 'int', min: 1950, max: 2100, label: 'Ano de fabricação' },
    year_model: { t: 'int', min: 1950, max: 2100, label: 'Ano do modelo' },
    chassis: { t: 'str', max: 30, label: 'Chassi' },
    renavam: { t: 'str', max: 20, label: 'Renavam' },
    color: { t: 'str', max: 30, label: 'Cor' },
    fuel_type: { t: 'enum', list: FUEL_TYPES, def: 'diesel_s10', label: 'Combustível' },
    tank_capacity_l: { t: 'num', min: 0, max: 5000, label: 'Capacidade do tanque' },
    axles: { t: 'int', min: 2, max: 9, def: 2, label: 'Eixos' },
    capacity_kg: { t: 'num', min: 0, max: 200000, label: 'Capacidade de carga' },
    default_driver_id: { t: 'str', max: 60, label: 'Motorista padrão' },
    notes: { t: 'str', max: 1000, label: 'Observações' },
    photo_url: { t: 'str', max: 300, label: 'Foto' },
  },
  driver: {
    name: { t: 'str', max: 120, req: true, label: 'Nome' },
    cpf: { t: 'str', max: 14, label: 'CPF' },
    phone: { t: 'str', max: 20, label: 'Telefone' },
    cnh_number: { t: 'str', max: 20, label: 'Nº da CNH' },
    cnh_category: { t: 'enum', list: CNH_CATEGORIES, label: 'Categoria da CNH' },
    cnh_expiry: { t: 'date', label: 'Validade da CNH' },
    user_id: { t: 'str', max: 60, label: 'Usuário' },
    status: { t: 'enum', list: DRIVER_STATUS, def: 'ativo', label: 'Situação' },
    notes: { t: 'str', max: 1000, label: 'Observações' },
  },
  fuel: {
    vehicle_id: { t: 'str', max: 60, req: true, label: 'Veículo' },
    driver_id: { t: 'str', max: 60, label: 'Motorista' },
    filled_at: { t: 'dt', label: 'Data/hora' },
    km: { t: 'num', min: 0, max: 5000000, req: true, label: 'Quilometragem' },
    liters: { t: 'num', min: 0.1, max: 5000, req: true, label: 'Litros' },
    price_per_l: { t: 'num', min: 0, max: 1000, label: 'Preço por litro' },
    total: { t: 'num', min: 0, max: 1000000, label: 'Valor total' },
    full_tank: { t: 'bool', label: 'Tanque cheio' },
    fuel_type: { t: 'enum', list: FUEL_TYPES, label: 'Combustível' },
    station: { t: 'str', max: 100, label: 'Posto' },
    notes: { t: 'str', max: 500, label: 'Observações' },
  },
  plan: {
    vehicle_id: { t: 'str', max: 60, req: true, label: 'Veículo' },
    title: { t: 'str', max: 120, req: true, label: 'Título' },
    every_km: { t: 'num', min: 1, max: 1000000, label: 'Intervalo (km)' },
    every_days: { t: 'int', min: 1, max: 3650, label: 'Intervalo (dias)' },
    last_km: { t: 'num', min: 0, max: 5000000, label: 'Última execução (km)' },
    last_date: { t: 'date', label: 'Última execução (data)' },
    lead_km: { t: 'num', min: 0, max: 100000, def: 1000, label: 'Antecedência (km)' },
    lead_days: { t: 'int', min: 0, max: 365, def: 15, label: 'Antecedência (dias)' },
    active: { t: 'bool', def: 1, label: 'Ativo' },
    notes: { t: 'str', max: 500, label: 'Observações' },
  },
  tire: {
    serial: { t: 'str', max: 40, label: 'Nº de fogo/série' },
    brand: { t: 'str', max: 60, label: 'Marca' },
    model: { t: 'str', max: 60, label: 'Modelo' },
    size: { t: 'str', max: 30, label: 'Medida' },
    status: { t: 'enum', list: TIRE_STATUS, def: 'estoque', label: 'Situação' },
    vehicle_id: { t: 'str', max: 60, label: 'Veículo' },
    position: { t: 'str', max: 40, label: 'Posição' },
    install_km: { t: 'num', min: 0, max: 5000000, label: 'Km de instalação' },
    install_date: { t: 'date', label: 'Data de instalação' },
    expected_km: { t: 'num', min: 0, max: 1000000, label: 'Vida útil (km)' },
    cost: { t: 'num', min: 0, max: 100000, label: 'Custo' },
    notes: { t: 'str', max: 500, label: 'Observações' },
  },
  document: {
    entity_type: { t: 'enum', list: ['vehicle', 'driver'], req: true, label: 'Tipo' },
    entity_id: { t: 'str', max: 60, req: true, label: 'Veículo/Motorista' },
    doc_type: { t: 'str', max: 60, req: true, label: 'Documento' },
    number: { t: 'str', max: 60, label: 'Número' },
    issue_date: { t: 'date', label: 'Emissão' },
    expiry_date: { t: 'date', label: 'Vencimento' },
    cost: { t: 'num', min: 0, max: 1000000, label: 'Valor' },
    file_url: { t: 'str', max: 300, label: 'Arquivo' },
    notes: { t: 'str', max: 500, label: 'Observações' },
  },
  fine: {
    vehicle_id: { t: 'str', max: 60, req: true, label: 'Veículo' },
    driver_id: { t: 'str', max: 60, label: 'Motorista' },
    fine_date: { t: 'dt', req: true, label: 'Data da infração' },
    infraction: { t: 'str', max: 200, req: true, label: 'Infração' },
    ait_number: { t: 'str', max: 40, label: 'Nº do AIT' },
    location: { t: 'str', max: 150, label: 'Local' },
    points: { t: 'int', min: 0, max: 20, label: 'Pontos' },
    amount: { t: 'num', min: 0, max: 100000, req: true, label: 'Valor' },
    due_date: { t: 'date', label: 'Vencimento' },
    status: { t: 'enum', list: FINE_STATUS, def: 'pendente', label: 'Situação' },
    paid_date: { t: 'date', label: 'Data de pagamento' },
    notes: { t: 'str', max: 500, label: 'Observações' },
  },
  cost: {
    vehicle_id: { t: 'str', max: 60, req: true, label: 'Veículo' },
    category: { t: 'enum', list: COST_CATEGORIES, req: true, label: 'Categoria' },
    cost_date: { t: 'date', label: 'Data' },
    amount: { t: 'num', min: 0.01, max: 10000000, req: true, label: 'Valor' },
    description: { t: 'str', max: 200, label: 'Descrição' },
    km: { t: 'num', min: 0, max: 5000000, label: 'Quilometragem' },
  },
  checklistItem: {
    label: { t: 'str', max: 150, req: true, label: 'Item' },
    category: { t: 'str', max: 60, label: 'Categoria' },
    critical: { t: 'bool', label: 'Crítico' },
    active: { t: 'bool', def: 1, label: 'Ativo' },
    sort_order: { t: 'int', min: 0, max: 9999, def: 0, label: 'Ordem' },
  },
};

// ---------------------------------------------------------------- Banco de dados
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* já finalizada */ }
    throw e;
  }
}

export function insertRow(db, table, data) {
  const cols = Object.keys(data);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => data[c] ?? null));
}
export function updateRow(db, table, id, data, idCol = 'id') {
  const cols = Object.keys(data);
  if (!cols.length) return;
  db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE ${idCol}=?`).run(...cols.map((c) => data[c] ?? null), id);
}

export const DEFAULT_CHECKLIST = [
  ['1️⃣ Cabine & Painel', 'Km e nível de combustível', 1],
  ['1️⃣ Cabine & Painel', 'Luzes de alerta no painel', 1],
  ['1️⃣ Cabine & Painel', 'Nível de Arla 32', 0],
  ['1️⃣ Cabine & Painel', 'Cinto, buzina e limpadores', 1],
  ['2️⃣ Pneus & Rodagem', 'Calibragem / pressão visual', 1],
  ['2️⃣ Pneus & Rodagem', 'Desgaste dos sulcos (TWI)', 1],
  ['2️⃣ Pneus & Rodagem', 'Porcas de roda bem fixadas', 1],
  ['2️⃣ Pneus & Rodagem', 'Estado do estepe', 0],
  ['3️⃣ Iluminação & Sinalização', 'Farol baixo e alto', 1],
  ['3️⃣ Iluminação & Sinalização', 'Lanternas e luz de freio', 1],
  ['3️⃣ Iluminação & Sinalização', 'Setas e pisca-alerta', 1],
  ['4️⃣ Funilaria, Vidros & Itens', 'Para-brisa e retrovisores sem trincas', 1],
  ['4️⃣ Funilaria, Vidros & Itens', 'Lataria e para-choques sem batidas', 0],
  ['4️⃣ Funilaria, Vidros & Itens', 'Kit a bordo (macaco, chave, triângulo, extintor)', 1],
];

export function saveChecklistPhoto(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('/uploads/')) return s;
  if (/^(wa-|ck-|img-)[a-zA-Z0-9._-]+$/.test(s)) return `/uploads/${s}`;
  const m = s.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
  if (m) {
    try {
      const rawExt = m[1].toLowerCase();
      const ext = rawExt === 'jpeg' ? 'jpg' : (['png', 'webp', 'gif'].includes(rawExt) ? rawExt : 'jpg');
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) return null;
      const filename = `ck-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
      return `/uploads/${filename}`;
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function migrateFleet(db) {
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('fleet_role')) db.exec('ALTER TABLE users ADD COLUMN fleet_role TEXT');

  db.exec(`
  CREATE TABLE IF NOT EXISTS fleet_vehicles (
    id TEXT PRIMARY KEY, plate TEXT NOT NULL UNIQUE, nickname TEXT,
    type TEXT NOT NULL DEFAULT 'truck', brand TEXT, model TEXT,
    year_manufacture INTEGER, year_model INTEGER, chassis TEXT, renavam TEXT, color TEXT,
    fuel_type TEXT DEFAULT 'diesel_s10', tank_capacity_l REAL, axles INTEGER DEFAULT 2, capacity_kg REAL,
    odometer_km REAL NOT NULL DEFAULT 0, odometer_updated_at TEXT,
    status TEXT NOT NULL DEFAULT 'ativo', machine_id TEXT REFERENCES machines(id),
    default_driver_id TEXT, notes TEXT, photo_url TEXT,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS fleet_drivers (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, cpf TEXT, phone TEXT,
    cnh_number TEXT, cnh_category TEXT, cnh_expiry TEXT,
    status TEXT NOT NULL DEFAULT 'ativo', notes TEXT,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_drivers_user ON fleet_drivers(user_id) WHERE user_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_drivers_cpf ON fleet_drivers(cpf) WHERE cpf IS NOT NULL;
  CREATE TABLE IF NOT EXISTS fleet_odometer_log (
    id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES fleet_vehicles(id),
    km REAL NOT NULL, source TEXT NOT NULL, user_id TEXT, note TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_fuel (
    id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES fleet_vehicles(id),
    driver_id TEXT, user_id TEXT, filled_at TEXT NOT NULL, km REAL NOT NULL, liters REAL NOT NULL,
    price_per_l REAL, total REAL, full_tank INTEGER NOT NULL DEFAULT 1, fuel_type TEXT, station TEXT,
    consumption_km_l REAL, notes TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_trips (
    id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES fleet_vehicles(id),
    driver_id TEXT, user_id TEXT, origin TEXT, destination TEXT, cargo TEXT,
    start_at TEXT NOT NULL, start_km REAL NOT NULL, end_at TEXT, end_km REAL, distance_km REAL,
    freight_value REAL, status TEXT NOT NULL DEFAULT 'em_andamento', notes TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_checklist_items (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, category TEXT,
    critical INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS fleet_checklists (
    id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES fleet_vehicles(id),
    driver_id TEXT, user_id TEXT, type TEXT NOT NULL DEFAULT 'saida', km REAL,
    answers_json TEXT NOT NULL, has_issues INTEGER NOT NULL DEFAULT 0, critical_issues INTEGER NOT NULL DEFAULT 0,
    notes TEXT, wo_id TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_plans (
    id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES fleet_vehicles(id), title TEXT NOT NULL,
    every_km REAL, every_days INTEGER, last_km REAL, last_date TEXT,
    lead_km REAL NOT NULL DEFAULT 1000, lead_days INTEGER NOT NULL DEFAULT 15,
    active INTEGER NOT NULL DEFAULT 1, notes TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_maintenance_history (
    id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES fleet_vehicles(id), plan_id TEXT, title TEXT NOT NULL,
    km REAL, done_date TEXT NOT NULL, cost REAL, wo_id TEXT, notes TEXT, user_id TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_tires (
    id TEXT PRIMARY KEY, serial TEXT, brand TEXT, model TEXT, size TEXT,
    status TEXT NOT NULL DEFAULT 'estoque', vehicle_id TEXT REFERENCES fleet_vehicles(id), position TEXT,
    install_km REAL, install_date TEXT, expected_km REAL,
    km_accumulated REAL NOT NULL DEFAULT 0, retread_count INTEGER NOT NULL DEFAULT 0,
    cost REAL, notes TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_tire_events (
    id TEXT PRIMARY KEY, tire_id TEXT NOT NULL REFERENCES fleet_tires(id), type TEXT NOT NULL,
    vehicle_id TEXT, position TEXT, km REAL, event_date TEXT NOT NULL, cost REAL, notes TEXT, user_id TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_documents (
    id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, doc_type TEXT NOT NULL,
    number TEXT, issue_date TEXT, expiry_date TEXT, cost REAL, file_url TEXT, notes TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_fines (
    id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES fleet_vehicles(id), driver_id TEXT,
    fine_date TEXT NOT NULL, infraction TEXT NOT NULL, ait_number TEXT, location TEXT, points INTEGER,
    amount REAL NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'pendente', paid_date TEXT, notes TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_costs (
    id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES fleet_vehicles(id), category TEXT NOT NULL,
    cost_date TEXT NOT NULL, amount REAL NOT NULL, description TEXT, km REAL, wo_id TEXT, user_id TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_alert_log (
    alert_key TEXT PRIMARY KEY, level TEXT NOT NULL, last_sent_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_fuel_v ON fleet_fuel(vehicle_id, filled_at);
  CREATE INDEX IF NOT EXISTS idx_fleet_trips_v ON fleet_trips(vehicle_id, status);
  CREATE INDEX IF NOT EXISTS idx_fleet_odo_v ON fleet_odometer_log(vehicle_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_fleet_docs_e ON fleet_documents(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_fleet_costs_v ON fleet_costs(vehicle_id, cost_date);
  CREATE INDEX IF NOT EXISTS idx_fleet_tires_v ON fleet_tires(vehicle_id, status);
  CREATE INDEX IF NOT EXISTS idx_fleet_checklists_v ON fleet_checklists(vehicle_id, created_at);
  `);

  const ckCols = db.prepare('PRAGMA table_info(fleet_checklists)').all().map((c) => c.name);
  if (!ckCols.includes('photos_json')) {
    db.exec('ALTER TABLE fleet_checklists ADD COLUMN photos_json TEXT');
  }

  if (db.prepare('SELECT COUNT(*) n FROM fleet_checklist_items').get().n === 0 || !getSetting(db, 'fleet_checklist_v2_clean')) {
    db.exec('DELETE FROM fleet_checklist_items');
    const ins = db.prepare('INSERT INTO fleet_checklist_items (id,label,category,critical,active,sort_order) VALUES (?,?,?,?,1,?)');
    DEFAULT_CHECKLIST.forEach(([cat, label, crit], i) => ins.run(randomUUID(), label, cat, crit, (i + 1) * 10));
    setSetting(db, 'fleet_checklist_v2_clean', nowIso());
  }
  // Garantir remoção do item "Faixas refletivas" em bancos já existentes
  db.prepare("DELETE FROM fleet_checklist_items WHERE LOWER(label) LIKE '%faixas refletivas%'").run();

  if (process.env.FLEET_SKIP_SEED !== '1' && !getSetting(db, 'fleet_initial_seed_v1')) {
    const count = seedDefaultFleetVehicles(db);
    setSetting(db, 'fleet_initial_seed_v1', nowIso());
    if (count > 0) console.log(`[Frota] ${count} veículos oficiais cadastrados automaticamente.`);
  }
}

const DEFAULT_FLEET_VEHICLES = [
  // Print 1 (29 veículos)
  { brand: 'MERCEDES', model: 'L1620 3Eixos', year_manufacture: 2000, year_model: 2000, plate: 'GSW0232', chassis: '9BM695301YB249109', notes: null, type: 'truck', axles: 3, fuel_type: 'diesel_s500', status: 'ativo' },
  { brand: 'MERCEDES', model: '708 2p', year_manufacture: 1988, year_model: 1988, plate: 'GMB2437', chassis: '9BM308325JB794112', notes: null, type: 'vuc', axles: 2, fuel_type: 'diesel_s500', status: 'ativo' },
  { brand: 'MERCEDES', model: 'ACCELO 1016 2P', year_manufacture: 2021, year_model: 2021, plate: 'RMI1A95', chassis: '9BM979076MB196412', notes: null, type: 'vuc', axles: 2, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'TROLLER', model: 'T-4 TX4 CONNECT 4X4 3.2 AUT.', year_manufacture: 2021, year_model: 2021, plate: 'OCE6F56', chassis: '94TT41353MH400600', notes: 'Celinho', nickname: 'Celinho', type: 'utilitario', axles: 2, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'MERCEDES', model: 'ATEGO 2425 3EIXOS', year_manufacture: 2011, year_model: 2011, plate: 'HEQ1931', chassis: '9BM958096BB818825', notes: null, type: 'truck', axles: 3, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'MERCEDES', model: 'L1620 3Eixos', year_manufacture: 2008, year_model: 2008, plate: 'HBN7393', chassis: '9BM69530488589997', notes: 'Parado (Pipa)', nickname: 'Pipa', type: 'truck', axles: 3, fuel_type: 'diesel_s500', status: 'manutencao' },
  { brand: 'REBOQUE', model: 'CARGA SECA 3 EIXOS', year_manufacture: 2006, year_model: 2007, plate: 'MWC1576', chassis: '9ADF1503675236320', notes: null, type: 'carreta', axles: 3, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'REBOQUE', model: 'CARGA SECA 3 EIXOS', year_manufacture: 2006, year_model: 2007, plate: 'KKF3964', chassis: '9ADF1503675236130', notes: null, type: 'carreta', axles: 3, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'SCANIA', model: 'P-360 A 6X2 2P', year_manufacture: 2012, year_model: 2012, plate: 'HOF8710', chassis: '9BSP6X200C3806729', notes: null, type: 'cavalo', axles: 3, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'FORD', model: 'CARGO 1317/1317 E T 3-EIXOS', year_manufacture: 2012, year_model: 2012, plate: 'HKF1879', chassis: '9BFXEAEUOCBS01560', notes: 'Parado', type: 'truck', axles: 3, fuel_type: 'diesel_s10', status: 'manutencao' },
  { brand: 'MERCEDES', model: 'ATRON 2324 6X2', year_manufacture: 2013, year_model: 2013, plate: 'OQR2771', chassis: '9BM695304DB915338', notes: 'Parado', type: 'truck', axles: 3, fuel_type: 'diesel_s10', status: 'manutencao' },
  { brand: 'MERCEDES', model: 'ATRON 2324 6X2', year_manufacture: 2013, year_model: 2013, plate: 'OQX9054', chassis: '9BM695304DB924171', notes: null, type: 'truck', axles: 3, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'REBOQUE', model: 'CARGA SECA 3 EIXOS', year_manufacture: 2014, year_model: 2014, plate: 'OXG5573', chassis: '955L1513EES360543', notes: null, type: 'carreta', axles: 3, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'MERCEDES', model: 'ATRON 2324 6X2', year_manufacture: 2014, year_model: 2014, plate: 'PUA9538', chassis: '9BM695304EB605557', notes: 'Parado', type: 'truck', axles: 3, fuel_type: 'diesel_s10', status: 'manutencao' },
  { brand: 'VOLKSWAGEN', model: '9-150 E DELIVERY 2P (DIESEL)', year_manufacture: 2011, year_model: 2012, plate: 'HGK2E32', chassis: '9533A62PXCR212326', notes: null, type: 'vuc', axles: 2, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'MERCEDES', model: 'ATRON 2324 6X2', year_manufacture: 2014, year_model: 2014, plate: 'PUS3218', chassis: '9BM695304EB978287', notes: 'Parado', type: 'truck', axles: 3, fuel_type: 'diesel_s10', status: 'manutencao' },
  { brand: 'FIAT', model: 'STRADA WORKING CELEB 1.4', year_manufacture: 2015, year_model: 2015, plate: 'KRS3464', chassis: '9BD578141F7905433', notes: 'Valdenir', nickname: 'Valdenir', type: 'utilitario', axles: 2, fuel_type: 'gasolina', status: 'ativo' },
  { brand: 'SCANIA', model: 'R-450 A 6X2 2P (diesel) (E5)', year_manufacture: 2023, year_model: 2023, plate: 'RJP7J99', chassis: '9BSR6X200P4024827', notes: null, type: 'cavalo', axles: 3, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'FORD', model: 'CARGO 815', year_manufacture: 2005, year_model: 2005, plate: 'HBN7248', chassis: '9BFV2UHG55BB55057', notes: null, type: 'vuc', axles: 2, fuel_type: 'diesel_s500', status: 'ativo' },
  { brand: 'MERCEDES', model: 'L-1620 3 E', year_manufacture: 2007, year_model: 2007, plate: 'HBN7283', chassis: '9BM69530478544743', notes: 'Movelaria', nickname: 'Movelaria', type: 'truck', axles: 3, fuel_type: 'diesel_s500', status: 'ativo' },
  { brand: 'MERCEDES', model: 'ATEGO 2426 6X2 2P', year_manufacture: 2018, year_model: 2018, plate: 'QPD9874', chassis: '9BM958166JB105827', notes: null, type: 'truck', axles: 3, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'SCANIA', model: 'R-450 A 6X2 2P (diesel) (E5)', year_manufacture: 2019, year_model: 2019, plate: 'QUS3141', chassis: '9BSR6X200K3955560', notes: null, type: 'cavalo', axles: 3, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'MERCEDES', model: 'ATEGO 2426 6X2 2P (diesel) (E5)', year_manufacture: 2020, year_model: 2020, plate: 'QXV7C91', chassis: '9BM958166LB170522', notes: null, type: 'truck', axles: 3, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'MERCEDES', model: 'ATEGO 2426 6X2 2P (diesel) (E5)', year_manufacture: 2020, year_model: 2020, plate: 'QXV7C68', chassis: '9BM958166LB169810', notes: 'Parado', type: 'truck', axles: 3, fuel_type: 'diesel_s10', status: 'manutencao' },
  { brand: 'FIAT', model: 'UNO MILLE 1.0 FIRE 2P', year_manufacture: 2012, year_model: 2012, plate: 'HNP0378', chassis: '9BD15802AC6696746', notes: null, type: 'utilitario', axles: 2, fuel_type: 'gasolina', status: 'ativo' },
  { brand: 'LAND ROVER', model: 'RANGE ROVER SPORT HSE 3.0', year_manufacture: 2019, year_model: 2020, plate: 'QAW9B00', chassis: 'SALWA2BKOLA717846', notes: 'Celinho', nickname: 'Celinho', type: 'utilitario', axles: 2, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'MERCEDES', model: 'SPRINTER 313 CHASSI 2.2', year_manufacture: 2008, year_model: 2008, plate: 'HDI3782', chassis: '8AC9036128A978162', notes: null, type: 'van', axles: 2, fuel_type: 'diesel_s500', status: 'ativo' },
  { brand: 'TOYOTA', model: 'COROLLA XEI 2.0 FLEX 16V AUT', year_manufacture: 2021, year_model: 2022, plate: 'RMV5A70', chassis: '9BRB33BE7N2062963', notes: 'Neivaldo', nickname: 'Neivaldo', type: 'utilitario', axles: 2, fuel_type: 'gasolina', status: 'ativo' },
  { brand: 'VOLKS', model: 'T-CROSS CONFORTLINE 1.0 TSI FLEX', year_manufacture: 2020, year_model: 2020, plate: 'RFC6H66', chassis: '9BWBH6BF7L4078817', notes: 'Italo/Comercial', nickname: 'Italo/Comercial', type: 'utilitario', axles: 2, fuel_type: 'gasolina', status: 'ativo' },
  { brand: 'FIAT', model: 'UNO MILLE 1.0 FIRE 2P', year_manufacture: 2012, year_model: 2012, plate: 'HNP0388', chassis: '9BD15802AC6696734', notes: null, type: 'utilitario', axles: 2, fuel_type: 'gasolina', status: 'ativo' },
  { brand: 'CHEVROLET', model: 'ONIX HATCH LT 1.0 12V FLEX 5 P', year_manufacture: 2022, year_model: 2023, plate: 'RUE3B12', chassis: '9BGEB48A0PG111004', notes: 'Marcelo', nickname: 'Marcelo', type: 'utilitario', axles: 2, fuel_type: 'gasolina', status: 'ativo' },

  // Print 2 (17 veículos)
  { brand: 'MERCEDES', model: 'ATEGO 2426 6X2 2P (diesel) (E5)', year_manufacture: 2022, year_model: 2022, plate: 'RVM8H15', chassis: '9BM958166NB292222', notes: null, type: 'truck', axles: 3, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'VOLKS', model: '8-160 OD ONIBUS', year_manufacture: 2006, year_model: 2006, plate: 'HDI2J14', chassis: '9BM38407868488109', notes: 'Onibus', nickname: 'Ônibus', type: 'outro', axles: 2, fuel_type: 'diesel_s500', status: 'ativo' },
  { brand: 'JEEP', model: 'COMPASS LIMITED 350 2.0 4X4', year_manufacture: 2023, year_model: 2023, plate: 'SHQ1B36', chassis: '988675139PKM17214', notes: 'Lais', nickname: 'Lais', type: 'utilitario', axles: 2, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'RAM', model: 'RAMPAGE LARAMIE 2.2 TB CD 4X4 Aut.', year_manufacture: 2025, year_model: 2026, plate: 'TYP9F40', chassis: '98859125FTKS23824', notes: 'Celinho', nickname: 'Celinho', type: 'utilitario', axles: 2, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'VOLKS', model: '8-150 E DELIVERY PLUS 2P', year_manufacture: 2011, year_model: 2011, plate: 'KOU5E51', chassis: '9533A52P3CR214932', notes: null, type: 'vuc', axles: 2, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'GWM', model: 'Haval H6 GT PHEV AWD', year_manufacture: 2026, year_model: 2026, plate: 'SSL7B77', chassis: '92ZEFUA57TA103803', notes: 'Teka', nickname: 'Teka', type: 'utilitario', axles: 2, fuel_type: 'gasolina', status: 'ativo' },
  { brand: 'MERCEDES', model: 'ONIBUS CEFERAL CITMAX U', year_manufacture: 2005, year_model: 2005, plate: 'JQQ0177', chassis: '9BM38406758431847', notes: 'Onibus', nickname: 'Ônibus', type: 'outro', axles: 2, fuel_type: 'diesel_s500', status: 'ativo' },
  { brand: 'FIAT', model: 'STRADA ENDURANCE 1.3 FLEX CS', year_manufacture: 2024, year_model: 2025, plate: 'TCZ6D93', chassis: '9BD281AJHSYG32677', notes: 'Fabrica', nickname: 'Fábrica', type: 'utilitario', axles: 2, fuel_type: 'gasolina', status: 'ativo' },
  { brand: 'MERCEDES', model: 'L1313 3 EIXOS 2P', year_manufacture: 1982, year_model: 1982, plate: 'GMD7289', chassis: '34500212569181', notes: 'Parado', type: 'truck', axles: 3, fuel_type: 'diesel_s500', status: 'manutencao' },
  { brand: 'MERCEDES', model: '710 PLUS 2P (DIESEL)', year_manufacture: 2000, year_model: 2000, plate: 'MTG3944', chassis: '9BM688156YB225880', notes: null, type: 'vuc', axles: 2, fuel_type: 'diesel_s500', status: 'ativo' },
  { brand: 'MERCEDES', model: 'ACCELO 915C 2P (DIESEL)', year_manufacture: 2009, year_model: 2009, plate: 'GVE6F86', chassis: '9BM97904698671262', notes: null, type: 'vuc', axles: 2, fuel_type: 'diesel_s500', status: 'ativo' },
  { brand: 'MERCEDES', model: 'ACCELO 1117 4x2 2p (diesel) (E6)', year_manufacture: 2025, year_model: 2026, plate: 'TWZ8F87', chassis: '9BM951104TB413752', notes: null, type: 'vuc', axles: 2, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'MERCEDES', model: 'ACCELO 1117 4x2 2p (diesel) (E6)', year_manufacture: 2025, year_model: 2026, plate: 'TWZ8F33', chassis: '9BM951104TB430872', notes: null, type: 'vuc', axles: 2, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'MERCEDES', model: 'OF1620 (Urbano) 47p', year_manufacture: 1997, year_model: 1997, plate: 'GVI2456', chassis: '9BM384087VB127165', notes: 'Onibus', nickname: 'Ônibus', type: 'outro', axles: 2, fuel_type: 'diesel_s500', status: 'ativo' },
  { brand: 'ÔNIBUS', model: 'MARCOPOLO TORINO U', year_manufacture: 2010, year_model: 2010, plate: 'HJF4725', chassis: '9532L82W8AR059452', notes: 'Onibus', nickname: 'Ônibus', type: 'outro', axles: 2, fuel_type: 'diesel_s10', status: 'ativo' },
  { brand: 'VOLKSWAGEN', model: '8-150/8150 E WORKER 2p (diesel)', year_manufacture: 2001, year_model: 2001, plate: 'GXA2676', chassis: '9BWAD52R31R108973', notes: null, type: 'vuc', axles: 2, fuel_type: 'diesel_s500', status: 'ativo' },
  { brand: 'MERCEDES', model: 'Accelo 1016 2p (diesel) (E5)', year_manufacture: 2012, year_model: 2012, plate: 'OOZ6G15', chassis: '9BM979076CS006303', notes: null, type: 'vuc', axles: 2, fuel_type: 'diesel_s10', status: 'ativo' },
];

export function seedDefaultFleetVehicles(db) {
  const at = nowIso();
  const findByPlate = db.prepare('SELECT id FROM fleet_vehicles WHERE plate = ?');
  let inserted = 0;
  tx(db, () => {
    for (const v of DEFAULT_FLEET_VEHICLES) {
      if (findByPlate.get(v.plate)) continue;
      const id = 'fv-' + v.plate.toLowerCase();
      insertRow(db, 'fleet_vehicles', {
        id,
        plate: v.plate,
        nickname: v.nickname || null,
        type: v.type || 'truck',
        brand: v.brand,
        model: v.model,
        year_manufacture: v.year_manufacture,
        year_model: v.year_model,
        chassis: v.chassis,
        fuel_type: v.fuel_type || 'diesel_s10',
        axles: v.axles || 2,
        odometer_km: 0,
        odometer_updated_at: at,
        status: v.status || 'ativo',
        notes: v.notes || null,
        active: 1,
        created_at: at,
        updated_at: at,
      });
      ensureMachineForVehicle(db, db.prepare('SELECT * FROM fleet_vehicles WHERE id = ?').get(id));
      inserted++;
    }
  });
  return inserted;
}
export function getDriverByUser(db, userId) {
  return db.prepare('SELECT * FROM fleet_drivers WHERE user_id = ? AND active = 1').get(userId) || null;
}

export function getVehicle(db, id) {
  const v = db.prepare('SELECT * FROM fleet_vehicles WHERE id = ?').get(id);
  if (!v) throw new FleetError(404, 'Veículo não encontrado');
  return v;
}

const TYPE_LABEL = { cavalo: 'Cavalo mecânico', truck: 'Caminhão', toco: 'Caminhão toco', vuc: 'VUC', carreta: 'Carreta', utilitario: 'Utilitário', van: 'Van', outro: 'Veículo' };

// Cada veículo tem uma "máquina" vinculada (setor FROTA) para reutilizar OS, preventivas e QR do sistema.
export function ensureMachineForVehicle(db, v) {
  let machineId = v.machine_id;
  const name = `${TYPE_LABEL[v.type] || 'Veículo'} ${v.nickname || [v.brand, v.model].filter(Boolean).join(' ')} ${v.plate}`.replace(/\s+/g, ' ').trim();
  if (machineId && db.prepare('SELECT id FROM machines WHERE id = ?').get(machineId)) {
    db.prepare('UPDATE machines SET name = ?, active = ? WHERE id = ?').run(name, v.active ? 1 : 0, machineId);
    return machineId;
  }
  let sector = db.prepare("SELECT id FROM sectors WHERE UPPER(name) = 'FROTA' OR code = 'S-FROTA'").get();
  if (!sector) {
    db.prepare('INSERT INTO sectors (id, code, name) VALUES (?,?,?)').run('sec-frota', 'S-FROTA', 'FROTA');
    sector = { id: 'sec-frota' };
  }
  const existing = db.prepare('SELECT id FROM machines WHERE code = ?').get(v.plate);
  if (existing) {
    machineId = existing.id;
  } else {
    machineId = 'm-frota-' + randomUUID().slice(0, 8);
    db.prepare(`INSERT INTO machines (id, code, name, sector_id, criticality, hourly_cost, operating_hours_per_day, default_checklist_json, active)
                VALUES (?,?,?,?,?,?,?,?,1)`).run(machineId, v.plate, name, sector.id, 'alta', 0, 10, '[]');
  }
  db.prepare('UPDATE fleet_vehicles SET machine_id = ? WHERE id = ?').run(machineId, v.id);
  v.machine_id = machineId;
  return machineId;
}

export function setOdometer(db, vehicle, km, source, userId, note = null) {
  if (km == null) return false;
  if (km < vehicle.odometer_km) {
    throw new FleetError(400, `Quilometragem informada (${km} km) é menor que a atual do veículo (${vehicle.odometer_km} km)`);
  }
  if (km === vehicle.odometer_km) return false;
  const at = nowIso();
  db.prepare('UPDATE fleet_vehicles SET odometer_km = ?, odometer_updated_at = ?, updated_at = ? WHERE id = ?').run(km, at, at, vehicle.id);
  db.prepare('INSERT INTO fleet_odometer_log (id, vehicle_id, km, source, user_id, note, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), vehicle.id, km, source, userId || null, note, at);
  vehicle.odometer_km = km;
  vehicle.odometer_updated_at = at;
  return true;
}

export function recomputeConsumption(db, vehicleId) {
  const rows = db.prepare(`SELECT id, km, liters, full_tank FROM fleet_fuel
                           WHERE vehicle_id = ? AND COALESCE(fuel_type,'') <> 'arla32' ORDER BY filled_at, km`).all(vehicleId);
  const upd = db.prepare('UPDATE fleet_fuel SET consumption_km_l = ? WHERE id = ?');
  let prevFullKm = null;
  let litersSince = 0;
  for (const r of rows) {
    litersSince += r.liters;
    if (r.full_tank) {
      let c = null;
      if (prevFullKm != null && r.km > prevFullKm && litersSince > 0) c = round2((r.km - prevFullKm) / litersSince);
      upd.run(c, r.id);
      prevFullKm = r.km;
      litersSince = 0;
    } else {
      upd.run(null, r.id);
    }
  }
}

export function planStatus(plan, vehicle) {
  const baseKm = plan.last_km ?? 0;
  const nextKm = plan.every_km ? baseKm + plan.every_km : null;
  const remainingKm = nextKm != null ? Math.round(nextKm - vehicle.odometer_km) : null;
  const baseDate = plan.last_date || String(plan.created_at || nowIso()).slice(0, 10);
  const nextDate = plan.every_days ? addDays(baseDate, plan.every_days) : null;
  const remainingDays = nextDate ? daysBetween(today(), nextDate) : null;
  let state = 'ok';
  if ((remainingKm != null && remainingKm <= 0) || (remainingDays != null && remainingDays <= 0)) state = 'vencida';
  else if ((remainingKm != null && remainingKm <= plan.lead_km) || (remainingDays != null && remainingDays <= plan.lead_days)) state = 'proxima';
  return { ...plan, next_km: nextKm, remaining_km: remainingKm, next_date: nextDate, remaining_days: remainingDays, state };
}

export function docStatus(expiry, lead = 30) {
  if (!expiry) return { state: 'sem_validade', days: null };
  const days = daysBetween(today(), expiry);
  return { state: days < 0 ? 'vencido' : days <= lead ? 'vencendo' : 'valido', days };
}

export function openWorkOrder(db, user, vehicle, { description, priority = 'media', stopped = false, type = 'corretiva', title = null, attachments = [], origin = 'online' }) {
  const machineId = ensureMachineForVehicle(db, vehicle);
  const woId = randomUUID();
  const r = applyOp(db, {
    opId: randomUUID(), type: 'create_wo', userId: user.id, woId, localTime: nowIso(), origin,
    payload: { id: woId, machineId, description, type, priority, machineStopped: stopped, title, attachments },
  });
  if (r.status !== 'ok') throw new FleetError(400, r.message || 'Não foi possível abrir a OS');
  return r;
}

export function fleetUserIds(db, levels = ['gestor']) {
  const ids = new Set();
  const rows = db.prepare('SELECT id, role, fleet_role FROM users WHERE active = 1').all();
  for (const u of rows) {
    const a = fleetAccessOf(u);
    if (a && levels.includes(a)) ids.add(u.id);
  }
  return [...ids];
}

// ---------------------------------------------------------------- Alertas
export function fleetSettings(db) {
  return {
    alert_days: Math.max(1, Number(getSetting(db, 'fleet_alert_days', '30')) || 30),
    whatsapp_alerts: getSetting(db, 'fleet_whatsapp_alerts', '0') === '1',
  };
}

export function computeAlerts(db) {
  const { alert_days: lead } = fleetSettings(db);
  const alerts = [];
  const vehicles = new Map(db.prepare('SELECT * FROM fleet_vehicles WHERE active = 1').all().map((v) => [v.id, v]));
  const drivers = new Map(db.prepare("SELECT * FROM fleet_drivers WHERE active = 1").all().map((d) => [d.id, d]));
  const label = (v) => `${v.plate}${v.nickname ? ` (${v.nickname})` : ''}`;

  // Documentos: considera só o vencimento mais recente de cada tipo por veículo/motorista
  const latest = new Map();
  for (const d of db.prepare('SELECT * FROM fleet_documents WHERE expiry_date IS NOT NULL').all()) {
    const k = `${d.entity_type}:${d.entity_id}:${d.doc_type}`;
    if (!latest.has(k) || latest.get(k).expiry_date < d.expiry_date) latest.set(k, d);
  }
  for (const d of latest.values()) {
    const st = docStatus(d.expiry_date, lead);
    if (st.state !== 'vencido' && st.state !== 'vencendo') continue;
    const owner = d.entity_type === 'vehicle' ? vehicles.get(d.entity_id) : drivers.get(d.entity_id);
    if (!owner) continue;
    const who = d.entity_type === 'vehicle' ? label(owner) : owner.name;
    alerts.push({
      key: `doc:${d.id}`, kind: 'documento', level: st.state, days: st.days, due: d.expiry_date,
      vehicle_id: d.entity_type === 'vehicle' ? owner.id : null, driver_id: d.entity_type === 'driver' ? owner.id : null,
      user_id: d.entity_type === 'driver' ? owner.user_id : null, roles: ['gestor'],
      title: `${d.doc_type} ${st.state === 'vencido' ? 'vencido' : 'a vencer'} — ${who}`,
      detail: st.state === 'vencido' ? `Venceu em ${d.expiry_date} (${-st.days} dia(s) atrás)` : `Vence em ${d.expiry_date} (${st.days} dia(s))`,
    });
  }
  // CNH dos motoristas
  for (const d of drivers.values()) {
    if (!d.cnh_expiry || d.status === 'inativo') continue;
    const st = docStatus(d.cnh_expiry, lead);
    if (st.state !== 'vencido' && st.state !== 'vencendo') continue;
    alerts.push({
      key: `cnh:${d.id}`, kind: 'cnh', level: st.state, days: st.days, due: d.cnh_expiry,
      vehicle_id: null, driver_id: d.id, user_id: d.user_id, roles: ['gestor'],
      title: `CNH ${st.state === 'vencido' ? 'vencida' : 'a vencer'} — ${d.name}`,
      detail: st.state === 'vencido' ? `Venceu em ${d.cnh_expiry}` : `Vence em ${d.cnh_expiry} (${st.days} dia(s))`,
    });
  }
  // Manutenção por km / tempo
  for (const p of db.prepare('SELECT * FROM fleet_plans WHERE active = 1').all()) {
    const v = vehicles.get(p.vehicle_id);
    if (!v) continue;
    const s = planStatus(p, v);
    if (s.state === 'ok') continue;
    const parts = [];
    if (s.remaining_km != null) parts.push(s.remaining_km <= 0 ? `${-s.remaining_km} km além do prazo` : `faltam ${s.remaining_km} km`);
    if (s.remaining_days != null) parts.push(s.remaining_days <= 0 ? `${-s.remaining_days} dia(s) de atraso` : `faltam ${s.remaining_days} dia(s)`);
    alerts.push({
      key: `plan:${p.id}`, kind: 'manutencao', level: s.state, days: s.remaining_days, due: s.next_date,
      vehicle_id: v.id, driver_id: null, user_id: null, roles: ['gestor', 'mecanico'],
      title: `Manutenção ${s.state === 'vencida' ? 'vencida' : 'próxima'} — ${label(v)}: ${p.title}`,
      detail: parts.join(' • '),
    });
  }
  // Multas pendentes
  for (const f of db.prepare("SELECT * FROM fleet_fines WHERE status = 'pendente' AND due_date IS NOT NULL").all()) {
    const days = daysBetween(today(), f.due_date);
    if (days > 7) continue;
    const v = vehicles.get(f.vehicle_id);
    if (!v) continue;
    alerts.push({
      key: `fine:${f.id}`, kind: 'multa', level: days < 0 ? 'vencida' : 'proxima', days, due: f.due_date,
      vehicle_id: v.id, driver_id: f.driver_id, user_id: null, roles: ['gestor'],
      title: `Multa ${days < 0 ? 'vencida' : 'a vencer'} — ${label(v)}`,
      detail: `${f.infraction} • R$ ${round2(f.amount).toFixed(2)} • vence ${f.due_date}`,
    });
  }
  const order = { vencido: 0, vencida: 0, vencendo: 1, proxima: 1 };
  alerts.sort((a, b) => (order[a.level] - order[b.level]) || ((a.days ?? 9999) - (b.days ?? 9999)));
  return alerts;
}

// Envia notificações internas (e push) apenas quando um alerta surge, muda de nível ou, se vencido, a cada 7 dias.
export function dispatchAlerts(db) {
  try {
    const alerts = computeAlerts(db);
    const log = new Map(db.prepare('SELECT * FROM fleet_alert_log').all().map((r) => [r.alert_key, r]));
    const nowMs = Date.now();
    const upsert = db.prepare('INSERT INTO fleet_alert_log (alert_key, level, last_sent_at) VALUES (?,?,?) ON CONFLICT(alert_key) DO UPDATE SET level=excluded.level, last_sent_at=excluded.last_sent_at');
    for (const a of alerts) {
      const prev = log.get(a.key);
      const urgent = a.level === 'vencido' || a.level === 'vencida';
      const stale = prev && urgent && nowMs - Date.parse(prev.last_sent_at) > 7 * 86400000;
      if (prev && prev.level === a.level && !stale) continue;
      const ids = new Set(fleetUserIds(db, a.roles));
      if (a.user_id) ids.add(a.user_id);
      if (ids.size) notify(db, [...ids], { kind: 'frota_alerta', title: `🚚 ${a.title}`, body: a.detail });
      upsert.run(a.key, a.level, nowIso());
    }
    // Alertas resolvidos saem do log (se voltarem a ocorrer, notificam de novo)
    const keys = new Set(alerts.map((a) => a.key));
    for (const k of log.keys()) if (!keys.has(k)) db.prepare('DELETE FROM fleet_alert_log WHERE alert_key = ?').run(k);
    return alerts;
  } catch (e) {
    console.warn('[Frota] Falha ao despachar alertas:', e.message);
    return [];
  }
}

// Resumo diário opcional no grupo de WhatsApp (desligado por padrão; ativado pelo gestor em Configurações da Frota).
export async function maybeSendDigest(db) {
  try {
    const cfg = fleetSettings(db);
    if (!cfg.whatsapp_alerts || !isWhatsAppEnabled()) return;
    const hour = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo' }));
    if (hour < 7) return;
    if (getSetting(db, 'fleet_last_digest', '') === today()) return;
    const alerts = computeAlerts(db);
    if (!alerts.length) return;
    const group = getSetting(db, 'whatsapp_group_id', process.env.WHATSAPP_GROUP_ID || '');
    if (!group) return;
    const lines = alerts.slice(0, 25).map((a) => `${a.level === 'vencido' || a.level === 'vencida' ? '🔴' : '🟡'} ${a.title}\n   ${a.detail}`);
    const text = [`🚚 *ALERTAS DA FROTA — ${today().split('-').reverse().join('/')}*`, '━━━━━━━━━━━━━━━━━━━━━━', ...lines,
      alerts.length > 25 ? `… e mais ${alerts.length - 25} alerta(s) no app.` : ''].filter(Boolean).join('\n');
    await sendWhatsAppMessage({ to: group, text });
    setSetting(db, 'fleet_last_digest', today());
  } catch (e) {
    console.warn('[Frota] Resumo diário no WhatsApp falhou:', e.message);
  }
}

export function startFleetScheduler(getDb) {
  const tick = () => {
    const db = getDb();
    dispatchAlerts(db);
    maybeSendDigest(db);
  };
  setTimeout(tick, 45 * 1000);
  setInterval(tick, 30 * 60 * 1000);
}

// ---------------------------------------------------------------- Custos / relatórios
function kmDriven(db, vehicleId, from, to) {
  const base = db.prepare('SELECT km FROM fleet_odometer_log WHERE vehicle_id = ? AND substr(created_at,1,10) < ? ORDER BY created_at DESC LIMIT 1').get(vehicleId, from);
  const inPeriod = db.prepare('SELECT MIN(km) lo, MAX(km) hi FROM fleet_odometer_log WHERE vehicle_id = ? AND substr(created_at,1,10) BETWEEN ? AND ?').get(vehicleId, from, to);
  if (inPeriod.hi == null) return 0;
  const start = base ? base.km : inPeriod.lo;
  return Math.max(0, inPeriod.hi - start);
}

export function vehicleCostSummary(db, vehicleId, from, to) {
  const fuel = db.prepare(`SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(liters),0) liters, AVG(consumption_km_l) avg_cons
                           FROM fleet_fuel WHERE vehicle_id = ? AND substr(filled_at,1,10) BETWEEN ? AND ?`).get(vehicleId, from, to);
  const byCat = Object.fromEntries(COST_CATEGORIES.map((c) => [c, 0]));
  for (const r of db.prepare(`SELECT category, SUM(amount) s FROM fleet_costs WHERE vehicle_id = ? AND cost_date BETWEEN ? AND ? GROUP BY category`).all(vehicleId, from, to)) byCat[r.category] = r.s;
  const fines = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM fleet_fines WHERE vehicle_id = ? AND status = 'paga' AND COALESCE(paid_date, substr(fine_date,1,10)) BETWEEN ? AND ?`).get(vehicleId, from, to).s;
  const other = Object.values(byCat).reduce((a, b) => a + b, 0);
  const total = fuel.total + other + fines;
  const km = kmDriven(db, vehicleId, from, to);
  return {
    vehicle_id: vehicleId, fuel: round2(fuel.total), liters: round2(fuel.liters),
    avg_consumption: fuel.avg_cons != null ? round2(fuel.avg_cons) : null,
    categories: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, round2(v)])),
    fines: round2(fines), total: round2(total), km: Math.round(km),
    cost_per_km: km > 0 ? round2(total / km) : null,
  };
}

export function costReport(db, { from, to, vehicleId = null }) {
  const vehicles = db.prepare(`SELECT * FROM fleet_vehicles WHERE active = 1 ${vehicleId ? 'AND id = ?' : ''} ORDER BY plate`).all(...(vehicleId ? [vehicleId] : []));
  const rows = vehicles.map((v) => ({ plate: v.plate, nickname: v.nickname, ...vehicleCostSummary(db, v.id, from, to) }));
  const totals = rows.reduce((t, r) => {
    t.fuel += r.fuel; t.fines += r.fines; t.total += r.total; t.km += r.km; t.liters += r.liters;
    for (const [k, v] of Object.entries(r.categories)) t.categories[k] = (t.categories[k] || 0) + v;
    return t;
  }, { fuel: 0, fines: 0, total: 0, km: 0, liters: 0, categories: {} });
  totals.cost_per_km = totals.km > 0 ? round2(totals.total / totals.km) : null;
  totals.total = round2(totals.total);
  // Série mensal (12 meses) do custo total da frota
  const series = [];
  const [ty, tm] = to.split('-').map(Number);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(ty, tm - 1 - i, 1));
    const ym = d.toISOString().slice(0, 7);
    const mFrom = `${ym}-01`;
    const mTo = `${ym}-31`;
    const f = db.prepare(`SELECT COALESCE(SUM(total),0) s FROM fleet_fuel WHERE substr(filled_at,1,10) BETWEEN ? AND ?${vehicleId ? ' AND vehicle_id = ?' : ''}`).get(mFrom, mTo, ...(vehicleId ? [vehicleId] : [])).s;
    const c = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM fleet_costs WHERE cost_date BETWEEN ? AND ?${vehicleId ? ' AND vehicle_id = ?' : ''}`).get(mFrom, mTo, ...(vehicleId ? [vehicleId] : [])).s;
    const fi = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM fleet_fines WHERE status='paga' AND COALESCE(paid_date, substr(fine_date,1,10)) BETWEEN ? AND ?${vehicleId ? ' AND vehicle_id = ?' : ''}`).get(mFrom, mTo, ...(vehicleId ? [vehicleId] : [])).s;
    series.push({ month: ym, fuel: round2(f), other: round2(c), fines: round2(fi), total: round2(f + c + fi) });
  }
  return { from, to, rows, totals, series };
}

export function costReportCsv(report) {
  const cats = COST_CATEGORIES;
  const head = ['Placa', 'Apelido', 'Km rodados', 'Litros', 'Consumo médio (km/l)', 'Combustível (R$)', ...cats.map((c) => `${c} (R$)`), 'Multas pagas (R$)', 'Total (R$)', 'Custo por km (R$)'];
  const num = (n) => (n == null ? '' : String(n).replace('.', ','));
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(';')];
  for (const r of report.rows) {
    lines.push([esc(r.plate), esc(r.nickname), r.km, num(r.liters), num(r.avg_consumption), num(r.fuel), ...cats.map((c) => num(r.categories[c])), num(r.fines), num(r.total), num(r.cost_per_km)].join(';'));
  }
  const t = report.totals;
  lines.push(['"TOTAL"', '""', t.km, num(round2(t.liters)), '', num(round2(t.fuel)), ...cats.map((c) => num(round2(t.categories[c] || 0))), num(round2(t.fines)), num(t.total), num(t.cost_per_km)].join(';'));
  return '\uFEFF' + lines.join('\r\n');
}
