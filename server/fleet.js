// ============================================================================
// MÓDULO DE FROTA — rotas HTTP (/api/fleet/*)
// Perfis: gestor (admin/superadmin/gerente ou fleet_role=gestor), mecanico, motorista.
// ============================================================================
import { randomUUID } from 'node:crypto';
import { notify } from './domain.js';
import {
  FleetError, nowIso, today, addDays, fleetAccessOf, parseBody, SCHEMAS, tx, insertRow, updateRow,
  getVehicle, getDriverByUser, ensureMachineForVehicle, setOdometer, recomputeConsumption, planStatus, docStatus,
  openWorkOrder, fleetUserIds, fleetSettings, computeAlerts, dispatchAlerts, vehicleCostSummary, costReport, costReportCsv,
  validCpf, saveChecklistPhoto, DOC_TYPES_VEHICLE, DOC_TYPES_DRIVER, COST_CATEGORIES, TIRE_EVENTS, FLEET_LEVELS, VEHICLE_STATUS,
  VEHICLE_TYPES, FUEL_TYPES, DRIVER_STATUS, FINE_STATUS, CNH_CATEGORIES,
} from './fleet-core.js';
import { setSetting } from './domain.js';

const round2 = (n) => Math.round(n * 100) / 100;
const ALL = FLEET_LEVELS;
const GM = ['gestor', 'mecanico'];
const G = ['gestor'];
const DRIVER_COST_CATS = ['pedagio', 'estacionamento', 'lavagem', 'diaria', 'outros'];

const TRIP_SCHEMA = {
  vehicle_id: { t: 'str', max: 60, req: true, label: 'Veículo' },
  driver_id: { t: 'str', max: 60, label: 'Motorista' },
  origin: { t: 'str', max: 120, label: 'Origem' },
  destination: { t: 'str', max: 120, label: 'Destino' },
  cargo: { t: 'str', max: 150, label: 'Carga' },
  start_km: { t: 'num', min: 0, max: 5000000, label: 'Km inicial' },
  start_at: { t: 'dt', label: 'Início' },
  notes: { t: 'str', max: 500, label: 'Observações' },
};

export function registerFleetRoutes(app, getDb) {
  const route = (method, path, levels, fn) => {
    app[method](`/api/fleet${path}`, (req, res) => {
      try {
        if (!req.user) return res.status(401).json({ error: 'Faça login para continuar' });
        const access = fleetAccessOf(req.user);
        if (!access || (levels && !levels.includes(access))) {
          return res.status(403).json({ error: 'Você não tem permissão para esta área da Frota' });
        }
        const db = getDb();
        req.fleet = { access, driver: access === 'motorista' ? getDriverByUser(db, req.user.id) : null };
        const out = fn(req, res, db);
        if (out !== undefined && !res.headersSent) res.json(out);
      } catch (e) {
        if (e instanceof FleetError) return res.status(e.status).json({ error: e.message, ...e.extra });
        if (/UNIQUE constraint/i.test(e?.message || '')) return res.status(409).json({ error: 'Registro duplicado (já existe um cadastro igual)' });
        console.error('[Frota]', req.method, req.path, e);
        res.status(500).json({ error: 'Erro interno no módulo de Frota' });
      }
    });
  };
  const get = (p, l, f) => route('get', p, l, f);
  const post = (p, l, f) => route('post', p, l, f);
  const put = (p, l, f) => route('put', p, l, f);
  const del = (p, l, f) => route('delete', p, l, f);

  const limitOf = (req, def = 100, max = 500) => Math.min(max, Math.max(1, Number(req.query.limit) || def));
  const needDriver = (req) => {
    if (!req.fleet.driver) throw new FleetError(400, 'Seu usuário ainda não está vinculado a um cadastro de motorista. Peça ao gestor da frota.');
    return req.fleet.driver;
  };
  const own = (req, row) => req.fleet.access !== 'motorista'
    || (req.fleet.driver && row.driver_id === req.fleet.driver.id) || row.user_id === req.user.id;
  const dateRange = (req) => {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : to.slice(0, 8) + '01';
    return { from, to };
  };
  const activeVehicle = (db, id) => {
    const v = getVehicle(db, id);
    if (!v.active || v.status === 'inativo' || v.status === 'vendido') throw new FleetError(400, `Veículo ${v.plate} está ${v.status === 'vendido' ? 'vendido' : 'inativo'}`);
    return v;
  };
  const driverCnh = (d) => ({ ...d, cnh_state: docStatus(d.cnh_expiry, fleetSettings(getDb()).alert_days) });

  // ======================================================================= ME / DASHBOARD / CONFIG
  get('/me', ALL, (req) => ({
    access: req.fleet.access,
    driver: req.fleet.driver ? driverCnh(req.fleet.driver) : null,
    options: { vehicle_status: VEHICLE_STATUS, vehicle_types: VEHICLE_TYPES, fuel_types: FUEL_TYPES, driver_status: DRIVER_STATUS,
      fine_status: FINE_STATUS, cnh_categories: CNH_CATEGORIES, cost_categories: COST_CATEGORIES, tire_events: TIRE_EVENTS,
      doc_types_vehicle: DOC_TYPES_VEHICLE, doc_types_driver: DOC_TYPES_DRIVER },
  }));

  get('/settings', G, (req, res, db) => fleetSettings(db));
  put('/settings', G, (req, res, db) => {
    const days = Number(req.body?.alert_days);
    if (Number.isFinite(days) && days >= 1 && days <= 180) setSetting(db, 'fleet_alert_days', String(Math.round(days)));
    if (req.body?.whatsapp_alerts !== undefined) setSetting(db, 'fleet_whatsapp_alerts', req.body.whatsapp_alerts ? '1' : '0');
    return fleetSettings(db);
  });

  get('/dashboard', ALL, (req, res, db) => {
    const access = req.fleet.access;
    const alerts = computeAlerts(db);
    const tripSql = `SELECT t.*, v.plate, v.nickname, d.name driver_name FROM fleet_trips t
                     JOIN fleet_vehicles v ON v.id = t.vehicle_id LEFT JOIN fleet_drivers d ON d.id = t.driver_id`;
    const openOrders = db.prepare(`
      SELECT w.id, w.number, w.status, w.priority, w.machine_stopped, w.description, w.created_at,
             COALESCE(v.plate, m.code) AS plate, v.nickname, v.brand, v.model,
             u.name AS requester_name, r.name AS responsible_name
      FROM work_orders w
      JOIN machines m ON m.id = w.machine_id
      LEFT JOIN sectors s ON s.id = m.sector_id
      LEFT JOIN fleet_vehicles v ON v.machine_id = m.id OR UPPER(v.plate) = UPPER(m.code)
      LEFT JOIN users u ON u.id = w.requester_id
      LEFT JOIN users r ON r.id = w.responsible_id
      WHERE w.status NOT IN ('Concluída', 'Cancelada')
        AND (v.id IS NOT NULL OR UPPER(s.name) = 'FROTA' OR s.code = 'S-FROTA')
      ORDER BY w.machine_stopped DESC, w.created_at DESC
    `).all();
    if (access === 'motorista') {
      const d = req.fleet.driver;
      return {
        access, driver: d ? driverCnh(d) : null,
        open_trip: d ? db.prepare(`${tripSql} WHERE t.driver_id = ? AND t.status = 'em_andamento'`).get(d.id) || null : null,
        open_orders: openOrders,
        alerts: d ? alerts.filter((a) => a.driver_id === d.id) : [],
        pending_fines: d ? db.prepare(`SELECT f.*, v.plate FROM fleet_fines f JOIN fleet_vehicles v ON v.id = f.vehicle_id WHERE f.driver_id = ? AND f.status = 'pendente' ORDER BY f.fine_date DESC`).all(d.id) : [],
        recent_checklists: d ? db.prepare(`SELECT c.id, c.type, c.has_issues, c.critical_issues, c.created_at, v.plate FROM fleet_checklists c JOIN fleet_vehicles v ON v.id = c.vehicle_id WHERE c.driver_id = ? ORDER BY c.created_at DESC LIMIT 5`).all(d.id) : [],
      };
    }
    const byStatus = Object.fromEntries(VEHICLE_STATUS.map((s) => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) n FROM fleet_vehicles WHERE active = 1 GROUP BY status').all()) byStatus[r.status] = r.n;
    const monthFrom = today().slice(0, 8) + '01';
    const out = {
      access,
      vehicles: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), by_status: byStatus },
      alerts,
      alert_counts: {
        vencidos: alerts.filter((a) => a.level === 'vencido' || a.level === 'vencida').length,
        proximos: alerts.filter((a) => a.level === 'vencendo' || a.level === 'proxima').length,
      },
      open_trips: db.prepare(`${tripSql} WHERE t.status = 'em_andamento' ORDER BY t.start_at DESC`).all(),
      open_orders: openOrders,
      checklist_issues: db.prepare(`SELECT c.id, c.type, c.critical_issues, c.wo_id, c.created_at, v.plate, d.name driver_name
                                    FROM fleet_checklists c JOIN fleet_vehicles v ON v.id = c.vehicle_id LEFT JOIN fleet_drivers d ON d.id = c.driver_id
                                    WHERE c.has_issues = 1 AND substr(c.created_at,1,10) >= ? ORDER BY c.created_at DESC LIMIT 8`).all(addDays(today(), -7)),
      avg_consumption_30d: (() => {
        const r = db.prepare("SELECT AVG(consumption_km_l) a FROM fleet_fuel WHERE consumption_km_l IS NOT NULL AND substr(filled_at,1,10) >= ?").get(addDays(today(), -30)).a;
        return r != null ? round2(r) : null;
      })(),
    };
    if (access === 'gestor') {
      const sum = (from, to) => {
        const f = db.prepare('SELECT COALESCE(SUM(total),0) s FROM fleet_fuel WHERE substr(filled_at,1,10) BETWEEN ? AND ?').get(from, to).s;
        const c = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM fleet_costs WHERE cost_date BETWEEN ? AND ?').get(from, to).s;
        const fi = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM fleet_fines WHERE status='paga' AND COALESCE(paid_date, substr(fine_date,1,10)) BETWEEN ? AND ?").get(from, to).s;
        return { fuel: round2(f), other: round2(c), fines: round2(fi), total: round2(f + c + fi) };
      };
      const prevEnd = addDays(monthFrom, -1);
      out.costs = { month: sum(monthFrom, today()), previous_month: sum(prevEnd.slice(0, 8) + '01', prevEnd) };
      const pf = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM fleet_fines WHERE status = 'pendente'").get();
      out.pending_fines = { count: pf.n, amount: round2(pf.s) };
    }
    return out;
  });

  // ======================================================================= VEÍCULOS
  get('/vehicles', ALL, (req, res, db) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const all = req.query.include_inactive === '1' && req.fleet.access === 'gestor';
    let rows = db.prepare(`SELECT * FROM fleet_vehicles ${all ? '' : 'WHERE active = 1'} ORDER BY plate`).all();
    if (q) rows = rows.filter((v) => [v.plate, v.nickname, v.model, v.brand].some((x) => String(x || '').toLowerCase().includes(q)));
    if (req.fleet.access === 'motorista') {
      return { vehicles: rows.filter((v) => v.status === 'ativo').map((v) => ({
        id: v.id, plate: v.plate, nickname: v.nickname, type: v.type, brand: v.brand, model: v.model,
        odometer_km: v.odometer_km, status: v.status, fuel_type: v.fuel_type, tank_capacity_l: v.tank_capacity_l, axles: v.axles })) };
    }
    const alerts = computeAlerts(db);
    const inTrip = new Set(db.prepare("SELECT vehicle_id FROM fleet_trips WHERE status = 'em_andamento'").all().map((r) => r.vehicle_id));
    return { vehicles: rows.map((v) => {
      const mine = alerts.filter((a) => a.vehicle_id === v.id);
      return { ...v, in_trip: inTrip.has(v.id), alerts: {
        vencidos: mine.filter((a) => a.level === 'vencido' || a.level === 'vencida').length,
        proximos: mine.filter((a) => a.level === 'vencendo' || a.level === 'proxima').length } };
    }) };
  });

  get('/vehicles/:id', GM, (req, res, db) => {
    const v = getVehicle(db, req.params.id);
    const id = v.id;
    const lead = fleetSettings(db).alert_days;
    const stats = vehicleCostSummary(db, id, addDays(today(), -90), today());
    const last = db.prepare('SELECT consumption_km_l c FROM fleet_fuel WHERE vehicle_id = ? AND consumption_km_l IS NOT NULL ORDER BY filled_at DESC LIMIT 1').get(id);
    stats.last_consumption = last ? last.c : null;
    if (req.fleet.access !== 'gestor') { stats.total = null; stats.fuel = null; stats.cost_per_km = null; stats.fines = null; stats.categories = null; }
    return {
      vehicle: v,
      alerts: computeAlerts(db).filter((a) => a.vehicle_id === id),
      plans: db.prepare('SELECT * FROM fleet_plans WHERE vehicle_id = ? ORDER BY title').all(id).map((p) => planStatus(p, v)),
      documents: db.prepare("SELECT * FROM fleet_documents WHERE entity_type = 'vehicle' AND entity_id = ? ORDER BY COALESCE(expiry_date,'9999') ").all(id).map((d) => ({ ...d, status: docStatus(d.expiry_date, lead) })),
      tires: db.prepare("SELECT * FROM fleet_tires WHERE vehicle_id = ? AND status = 'em_uso' ORDER BY position").all(id).map((t) => tireOut(t, v)),
      fuel: db.prepare('SELECT * FROM fleet_fuel WHERE vehicle_id = ? ORDER BY filled_at DESC LIMIT 10').all(id),
      trips: db.prepare('SELECT t.*, d.name driver_name FROM fleet_trips t LEFT JOIN fleet_drivers d ON d.id = t.driver_id WHERE t.vehicle_id = ? ORDER BY t.start_at DESC LIMIT 10').all(id),
      checklists: db.prepare('SELECT c.id, c.type, c.has_issues, c.critical_issues, c.wo_id, c.created_at, d.name driver_name FROM fleet_checklists c LEFT JOIN fleet_drivers d ON d.id = c.driver_id WHERE c.vehicle_id = ? ORDER BY c.created_at DESC LIMIT 5').all(id),
      history: db.prepare('SELECT * FROM fleet_maintenance_history WHERE vehicle_id = ? ORDER BY done_date DESC, created_at DESC LIMIT 15').all(id),
      open_orders: v.machine_id ? db.prepare("SELECT id, number, status, priority, description, created_at FROM work_orders WHERE machine_id = ? AND status NOT IN ('Concluída','Cancelada') ORDER BY created_at DESC").all(v.machine_id) : [],
      open_trip: db.prepare("SELECT t.*, d.name driver_name FROM fleet_trips t LEFT JOIN fleet_drivers d ON d.id = t.driver_id WHERE t.vehicle_id = ? AND t.status = 'em_andamento'").get(id) || null,
      stats,
    };
  });

  post('/vehicles', G, (req, res, db) => {
    const data = parseBody(SCHEMAS.vehicle, req.body);
    if (db.prepare('SELECT 1 FROM fleet_vehicles WHERE plate = ?').get(data.plate)) throw new FleetError(409, `Já existe um veículo com a placa ${data.plate}`);
    const km = Number(String(req.body?.odometer_km ?? 0).replace(',', '.')) || 0;
    if (km < 0) throw new FleetError(400, 'Quilometragem inválida');
    const id = randomUUID();
    const at = nowIso();
    tx(db, () => {
      insertRow(db, 'fleet_vehicles', { id, ...data, odometer_km: km, odometer_updated_at: at, status: 'ativo', active: 1, created_at: at, updated_at: at });
      if (km > 0) db.prepare('INSERT INTO fleet_odometer_log (id, vehicle_id, km, source, user_id, note, created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), id, km, 'cadastro', req.user.id, 'Quilometragem inicial', at);
      ensureMachineForVehicle(db, db.prepare('SELECT * FROM fleet_vehicles WHERE id = ?').get(id));
    });
    res.status(201);
    return { ok: true, vehicle: db.prepare('SELECT * FROM fleet_vehicles WHERE id = ?').get(id) };
  });

  put('/vehicles/:id', G, (req, res, db) => {
    const v = getVehicle(db, req.params.id);
    const data = parseBody(SCHEMAS.vehicle, req.body, { partial: true });
    if (data.plate && data.plate !== v.plate && db.prepare('SELECT 1 FROM fleet_vehicles WHERE plate = ? AND id <> ?').get(data.plate, v.id)) {
      throw new FleetError(409, `Já existe um veículo com a placa ${data.plate}`);
    }
    tx(db, () => {
      updateRow(db, 'fleet_vehicles', v.id, { ...data, updated_at: nowIso() });
      const fresh = db.prepare('SELECT * FROM fleet_vehicles WHERE id = ?').get(v.id);
      if (data.plate && data.plate !== v.plate && fresh.machine_id) {
        const clash = db.prepare('SELECT id FROM machines WHERE code = ? AND id <> ?').get(data.plate, fresh.machine_id);
        if (!clash) db.prepare('UPDATE machines SET code = ? WHERE id = ?').run(data.plate, fresh.machine_id);
      }
      ensureMachineForVehicle(db, fresh);
    });
    return { ok: true, vehicle: db.prepare('SELECT * FROM fleet_vehicles WHERE id = ?').get(v.id) };
  });

  post('/vehicles/:id/status', GM, (req, res, db) => {
    const v = getVehicle(db, req.params.id);
    const status = req.body?.status;
    if (!VEHICLE_STATUS.includes(status)) throw new FleetError(400, 'Situação inválida');
    if (req.fleet.access === 'mecanico' && !['ativo', 'manutencao'].includes(status)) throw new FleetError(403, 'Mecânicos só podem alternar entre Ativo e Em manutenção');
    db.prepare('UPDATE fleet_vehicles SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), v.id);
    return { ok: true, vehicle: getVehicle(db, v.id) };
  });

  post('/vehicles/:id/odometer', GM, (req, res, db) => {
    const v = getVehicle(db, req.params.id);
    const km = Number(String(req.body?.km ?? '').replace(',', '.'));
    if (!Number.isFinite(km) || km < 0) throw new FleetError(400, 'Informe a quilometragem atual');
    tx(db, () => setOdometer(db, v, km, 'manual', req.user.id, String(req.body?.note || '').slice(0, 200) || null));
    setImmediate(() => dispatchAlerts(getDb()));
    return { ok: true, vehicle: getVehicle(db, v.id) };
  });

  del('/vehicles/:id', G, (req, res, db) => {
    const v = getVehicle(db, req.params.id);
    const used = ['fleet_fuel', 'fleet_trips', 'fleet_checklists', 'fleet_plans', 'fleet_fines', 'fleet_costs', 'fleet_maintenance_history', 'fleet_tires'].some(
      (t) => db.prepare(`SELECT 1 FROM ${t} WHERE vehicle_id = ?`).get(v.id));
    tx(db, () => {
      if (used) {
        db.prepare("UPDATE fleet_vehicles SET active = 0, status = 'inativo', updated_at = ? WHERE id = ?").run(nowIso(), v.id);
      } else {
        db.prepare('DELETE FROM fleet_odometer_log WHERE vehicle_id = ?').run(v.id);
        db.prepare("DELETE FROM fleet_documents WHERE entity_type = 'vehicle' AND entity_id = ?").run(v.id);
        db.prepare('DELETE FROM fleet_vehicles WHERE id = ?').run(v.id);
      }
      if (v.machine_id) db.prepare('UPDATE machines SET active = 0 WHERE id = ?').run(v.machine_id);
    });
    return { ok: true, soft: used };
  });

  get('/vehicles/:id/odometer-log', GM, (req, res, db) => ({
    log: db.prepare('SELECT * FROM fleet_odometer_log WHERE vehicle_id = ? ORDER BY created_at DESC LIMIT 100').all(req.params.id),
  }));

  // ======================================================================= MOTORISTAS
  const driverChecks = (db, data, selfId = null) => {
    if (data.cpf) {
      if (!validCpf(data.cpf)) throw new FleetError(400, 'CPF inválido');
      data.cpf = data.cpf.replace(/\D/g, '');
      if (db.prepare('SELECT 1 FROM fleet_drivers WHERE cpf = ? AND id <> ?').get(data.cpf, selfId || '')) throw new FleetError(409, 'Já existe motorista com este CPF');
    }
    if (data.user_id) {
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(data.user_id)) throw new FleetError(400, 'Usuário não encontrado');
      if (db.prepare('SELECT 1 FROM fleet_drivers WHERE user_id = ? AND id <> ?').get(data.user_id, selfId || '')) throw new FleetError(409, 'Este usuário já está vinculado a outro motorista');
    }
  };

  get('/drivers', GM, (req, res, db) => ({
    drivers: db.prepare(`SELECT d.*, u.username FROM fleet_drivers d LEFT JOIN users u ON u.id = d.user_id
                         WHERE d.active = 1 ORDER BY d.name`).all().map(driverCnh),
  }));
  post('/drivers', G, (req, res, db) => {
    const data = parseBody(SCHEMAS.driver, req.body);
    driverChecks(db, data);
    const id = randomUUID();
    insertRow(db, 'fleet_drivers', { id, ...data, active: 1, created_at: nowIso() });
    res.status(201);
    return { ok: true, driver: db.prepare('SELECT * FROM fleet_drivers WHERE id = ?').get(id) };
  });
  put('/drivers/:id', G, (req, res, db) => {
    const d = db.prepare('SELECT * FROM fleet_drivers WHERE id = ?').get(req.params.id);
    if (!d) throw new FleetError(404, 'Motorista não encontrado');
    const data = parseBody(SCHEMAS.driver, req.body, { partial: true });
    driverChecks(db, data, d.id);
    updateRow(db, 'fleet_drivers', d.id, data);
    return { ok: true, driver: db.prepare('SELECT * FROM fleet_drivers WHERE id = ?').get(d.id) };
  });
  del('/drivers/:id', G, (req, res, db) => {
    const d = db.prepare('SELECT * FROM fleet_drivers WHERE id = ?').get(req.params.id);
    if (!d) throw new FleetError(404, 'Motorista não encontrado');
    const used = ['fleet_trips', 'fleet_fuel', 'fleet_fines', 'fleet_checklists'].some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE driver_id = ?`).get(d.id));
    if (used) db.prepare("UPDATE fleet_drivers SET active = 0, status = 'inativo' WHERE id = ?").run(d.id);
    else db.prepare('DELETE FROM fleet_drivers WHERE id = ?').run(d.id);
    return { ok: true, soft: used };
  });

  // ======================================================================= ABASTECIMENTOS
  get('/fuel', ALL, (req, res, db) => {
    const { from, to } = req.query.from || req.query.to ? dateRange(req) : { from: '0000-01-01', to: '9999-12-31' };
    const args = [from, to];
    let where = 'substr(f.filled_at,1,10) BETWEEN ? AND ?';
    if (req.query.vehicle_id) { where += ' AND f.vehicle_id = ?'; args.push(req.query.vehicle_id); }
    if (req.fleet.access === 'motorista') {
      where += ' AND (f.user_id = ?' + (req.fleet.driver ? ' OR f.driver_id = ?' : '') + ')';
      args.push(req.user.id); if (req.fleet.driver) args.push(req.fleet.driver.id);
    }
    const rows = db.prepare(`SELECT f.*, v.plate, v.nickname, d.name driver_name FROM fleet_fuel f JOIN fleet_vehicles v ON v.id = f.vehicle_id
                             LEFT JOIN fleet_drivers d ON d.id = f.driver_id WHERE ${where} ORDER BY f.filled_at DESC LIMIT ${limitOf(req)}`).all(...args);
    const cons = rows.filter((r) => r.consumption_km_l != null);
    return { fuel: rows, totals: {
      liters: round2(rows.reduce((a, r) => a + r.liters, 0)),
      total: req.fleet.access === 'mecanico' ? null : round2(rows.reduce((a, r) => a + (r.total || 0), 0)),
      avg_consumption: cons.length ? round2(cons.reduce((a, r) => a + r.consumption_km_l, 0) / cons.length) : null } };
  });

  post('/fuel', ['gestor', 'motorista'], (req, res, db) => {
    const body = { ...req.body };
    if (req.fleet.access === 'motorista') body.driver_id = needDriver(req).id;
    const d = parseBody(SCHEMAS.fuel, body);
    const v = activeVehicle(db, d.vehicle_id);
    d.fuel_type = d.fuel_type || v.fuel_type || 'diesel_s10';
    d.filled_at = d.filled_at || nowIso();
    if (Date.parse(d.filled_at) - Date.now() > 10 * 60000) throw new FleetError(400, 'A data do abastecimento está no futuro');
    if (d.price_per_l == null && d.total == null) throw new FleetError(400, 'Informe o preço por litro ou o valor total');
    if (d.total == null) d.total = round2(d.liters * d.price_per_l);
    if (d.price_per_l == null) d.price_per_l = round2(d.total / d.liters);
    d.full_tank = req.body?.full_tank === undefined ? 1 : d.full_tank;
    const warnings = [];
    if (v.tank_capacity_l && d.liters > v.tank_capacity_l * 1.1 && d.fuel_type !== 'arla32') warnings.push(`Litros acima da capacidade do tanque (${v.tank_capacity_l} L). Confira o lançamento.`);
    const id = randomUUID();
    tx(db, () => {
      insertRow(db, 'fleet_fuel', { id, ...d, user_id: req.user.id, created_at: nowIso() });
      setOdometer(db, v, d.km, 'abastecimento', req.user.id);
      recomputeConsumption(db, v.id);
    });
    const row = db.prepare('SELECT * FROM fleet_fuel WHERE id = ?').get(id);
    if (row.consumption_km_l != null && (row.consumption_km_l < 1 || row.consumption_km_l > 8)) warnings.push(`Consumo calculado fora do esperado (${row.consumption_km_l} km/l). Verifique km e litros.`);
    res.status(201);
    return { ok: true, fuel: row, warnings };
  });

  put('/fuel/:id', G, (req, res, db) => {
    const f = db.prepare('SELECT * FROM fleet_fuel WHERE id = ?').get(req.params.id);
    if (!f) throw new FleetError(404, 'Abastecimento não encontrado');
    const { vehicle_id, driver_id, ...schema } = SCHEMAS.fuel; // eslint-disable-line no-unused-vars
    const d = parseBody(schema, req.body, { partial: true });
    if ((d.liters != null || d.price_per_l != null) && d.total === undefined) {
      const liters = d.liters ?? f.liters;
      const ppl = d.price_per_l ?? f.price_per_l;
      if (ppl != null) d.total = round2(liters * ppl);
    }
    tx(db, () => { updateRow(db, 'fleet_fuel', f.id, d); recomputeConsumption(db, f.vehicle_id); });
    return { ok: true, fuel: db.prepare('SELECT * FROM fleet_fuel WHERE id = ?').get(f.id) };
  });
  del('/fuel/:id', G, (req, res, db) => {
    const f = db.prepare('SELECT * FROM fleet_fuel WHERE id = ?').get(req.params.id);
    if (!f) throw new FleetError(404, 'Abastecimento não encontrado');
    tx(db, () => { db.prepare('DELETE FROM fleet_fuel WHERE id = ?').run(f.id); recomputeConsumption(db, f.vehicle_id); });
    return { ok: true };
  });

  // ======================================================================= VIAGENS
  const tripSelect = `SELECT t.*, v.plate, v.nickname, d.name driver_name FROM fleet_trips t
                      JOIN fleet_vehicles v ON v.id = t.vehicle_id LEFT JOIN fleet_drivers d ON d.id = t.driver_id`;
  get('/trips', ALL, (req, res, db) => {
    const args = [];
    const where = [];
    for (const [q, col] of [['vehicle_id', 't.vehicle_id'], ['driver_id', 't.driver_id'], ['status', 't.status']]) {
      if (req.query[q]) { where.push(`${col} = ?`); args.push(req.query[q]); }
    }
    if (req.fleet.access === 'motorista') {
      where.push('(t.user_id = ?' + (req.fleet.driver ? ' OR t.driver_id = ?' : '') + ')');
      args.push(req.user.id); if (req.fleet.driver) args.push(req.fleet.driver.id);
    }
    const rows = db.prepare(`${tripSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.start_at DESC LIMIT ${limitOf(req)}`).all(...args);
    return { trips: req.fleet.access === 'mecanico' ? rows.map((r) => ({ ...r, freight_value: null })) : rows };
  });

  post('/trips/start', ['gestor', 'motorista'], (req, res, db) => {
    const body = { ...req.body };
    if (req.fleet.access === 'motorista') body.driver_id = needDriver(req).id;
    else if (!body.driver_id) throw new FleetError(400, 'Selecione o motorista');
    const d = parseBody(TRIP_SCHEMA, body);
    const v = activeVehicle(db, d.vehicle_id);
    if (v.status !== 'ativo') throw new FleetError(400, `Veículo ${v.plate} está em manutenção e não pode iniciar viagem`);
    const driver = db.prepare('SELECT * FROM fleet_drivers WHERE id = ? AND active = 1').get(d.driver_id);
    if (!driver) throw new FleetError(400, 'Motorista não encontrado');
    if (driver.status !== 'ativo') throw new FleetError(400, `Motorista ${driver.name} está ${driver.status}`);
    if (driver.cnh_expiry && docStatus(driver.cnh_expiry).state === 'vencido') throw new FleetError(400, `CNH de ${driver.name} vencida em ${driver.cnh_expiry}. Viagem bloqueada.`);
    if (db.prepare("SELECT 1 FROM fleet_trips WHERE vehicle_id = ? AND status = 'em_andamento'").get(v.id)) throw new FleetError(409, `O veículo ${v.plate} já está em viagem`);
    if (db.prepare("SELECT 1 FROM fleet_trips WHERE driver_id = ? AND status = 'em_andamento'").get(driver.id)) throw new FleetError(409, `${driver.name} já está em outra viagem`);
    d.start_at = d.start_at || nowIso();
    d.start_km = d.start_km ?? v.odometer_km;
    const warnings = [];
    const expired = computeAlerts(db).filter((a) => a.vehicle_id === v.id && (a.level === 'vencido' || a.level === 'vencida'));
    for (const a of expired) warnings.push(a.title);
    const lastCk = db.prepare("SELECT created_at FROM fleet_checklists WHERE vehicle_id = ? ORDER BY created_at DESC LIMIT 1").get(v.id);
    if (!lastCk || Date.now() - Date.parse(lastCk.created_at) > 24 * 3600000) warnings.push('Nenhum checklist de saída nas últimas 24h para este veículo.');
    const id = randomUUID();
    tx(db, () => {
      setOdometer(db, v, d.start_km, 'viagem', req.user.id, 'Início de viagem');
      insertRow(db, 'fleet_trips', { id, ...d, user_id: req.user.id, status: 'em_andamento', created_at: nowIso() });
    });
    res.status(201);
    return { ok: true, trip: db.prepare(`${tripSelect} WHERE t.id = ?`).get(id), warnings };
  });

  post('/trips/:id/end', ['gestor', 'motorista'], (req, res, db) => {
    const t = db.prepare('SELECT * FROM fleet_trips WHERE id = ?').get(req.params.id);
    if (!t) throw new FleetError(404, 'Viagem não encontrada');
    if (!own(req, t)) throw new FleetError(403, 'Esta viagem pertence a outro motorista');
    if (t.status !== 'em_andamento') throw new FleetError(409, 'A viagem já foi encerrada');
    const v = getVehicle(db, t.vehicle_id);
    const endKm = Number(String(req.body?.end_km ?? '').replace(',', '.'));
    if (!Number.isFinite(endKm)) throw new FleetError(400, 'Informe o km final');
    if (endKm < t.start_km) throw new FleetError(400, `Km final (${endKm}) menor que o inicial (${t.start_km})`);
    const endAt = req.body?.end_at ? new Date(req.body.end_at).toISOString() : nowIso();
    if (Date.parse(endAt) < Date.parse(t.start_at)) throw new FleetError(400, 'O fim da viagem não pode ser anterior ao início');
    const freight = req.body?.freight_value === undefined || req.body.freight_value === '' ? t.freight_value : Number(String(req.body.freight_value).replace(',', '.'));
    if (freight != null && (!Number.isFinite(freight) || freight < 0)) throw new FleetError(400, 'Valor do frete inválido');
    const notes = [t.notes, String(req.body?.notes || '').trim()].filter(Boolean).join(' | ').slice(0, 500) || null;
    const expenses = Array.isArray(req.body?.expenses) ? req.body.expenses.slice(0, 10) : [];
    tx(db, () => {
      setOdometer(db, v, endKm, 'viagem', req.user.id, 'Fim de viagem');
      db.prepare("UPDATE fleet_trips SET status='concluida', end_km=?, end_at=?, distance_km=?, freight_value=?, notes=? WHERE id=?")
        .run(endKm, endAt, round2(endKm - t.start_km), freight ?? null, notes, t.id);
      for (const e of expenses) {
        const c = parseBody(SCHEMAS.cost, { ...e, vehicle_id: v.id });
        if (req.fleet.access === 'motorista' && !DRIVER_COST_CATS.includes(c.category)) throw new FleetError(403, `Categoria "${c.category}" não permitida para motoristas`);
        insertRow(db, 'fleet_costs', { id: randomUUID(), ...c, cost_date: c.cost_date || today(), km: endKm, description: c.description || `Viagem ${t.origin || ''} → ${t.destination || ''}`.trim(), user_id: req.user.id, created_at: nowIso() });
      }
    });
    setImmediate(() => dispatchAlerts(getDb()));
    return { ok: true, trip: db.prepare(`${tripSelect} WHERE t.id = ?`).get(t.id) };
  });

  post('/trips/:id/cancel', G, (req, res, db) => {
    const t = db.prepare('SELECT * FROM fleet_trips WHERE id = ?').get(req.params.id);
    if (!t) throw new FleetError(404, 'Viagem não encontrada');
    if (t.status !== 'em_andamento') throw new FleetError(409, 'Só viagens em andamento podem ser canceladas');
    db.prepare("UPDATE fleet_trips SET status='cancelada', end_at=?, notes=? WHERE id=?").run(nowIso(), [t.notes, `Cancelada: ${String(req.body?.reason || 'sem motivo informado').slice(0, 120)}`].filter(Boolean).join(' | '), t.id);
    return { ok: true };
  });

  put('/trips/:id', G, (req, res, db) => {
    const t = db.prepare('SELECT * FROM fleet_trips WHERE id = ?').get(req.params.id);
    if (!t) throw new FleetError(404, 'Viagem não encontrada');
    const schema = { ...TRIP_SCHEMA, end_km: { t: 'num', min: 0, max: 5000000, label: 'Km final' }, end_at: { t: 'dt', label: 'Fim' },
      freight_value: { t: 'num', min: 0, max: 100000000, label: 'Frete' } };
    delete schema.vehicle_id;
    const d = parseBody(schema, req.body, { partial: true });
    const sk = d.start_km ?? t.start_km;
    const ek = d.end_km ?? t.end_km;
    if (ek != null) {
      if (ek < sk) throw new FleetError(400, 'Km final menor que o inicial');
      d.distance_km = round2(ek - sk);
    }
    updateRow(db, 'fleet_trips', t.id, d);
    return { ok: true, trip: db.prepare(`${tripSelect} WHERE t.id = ?`).get(t.id) };
  });

  // ======================================================================= CHECKLIST
  get('/checklist-items', ALL, (req, res, db) => ({
    items: db.prepare(`SELECT * FROM fleet_checklist_items ${req.query.all === '1' && req.fleet.access === 'gestor' ? '' : 'WHERE active = 1'} ORDER BY sort_order, label`).all(),
  }));
  post('/checklist-items', G, (req, res, db) => {
    const d = parseBody(SCHEMAS.checklistItem, req.body);
    const id = randomUUID();
    if (!req.body?.sort_order) d.sort_order = (db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM fleet_checklist_items').get().m || 0) + 10;
    insertRow(db, 'fleet_checklist_items', { id, ...d });
    res.status(201);
    return { ok: true, item: db.prepare('SELECT * FROM fleet_checklist_items WHERE id = ?').get(id) };
  });
  put('/checklist-items/:id', G, (req, res, db) => {
    if (!db.prepare('SELECT 1 FROM fleet_checklist_items WHERE id = ?').get(req.params.id)) throw new FleetError(404, 'Item não encontrado');
    updateRow(db, 'fleet_checklist_items', req.params.id, parseBody(SCHEMAS.checklistItem, req.body, { partial: true }));
    return { ok: true, item: db.prepare('SELECT * FROM fleet_checklist_items WHERE id = ?').get(req.params.id) };
  });
  del('/checklist-items/:id', G, (req, res, db) => {
    db.prepare('DELETE FROM fleet_checklist_items WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  const ckSelect = `SELECT c.*, v.plate, v.nickname, d.name driver_name FROM fleet_checklists c
                    JOIN fleet_vehicles v ON v.id = c.vehicle_id LEFT JOIN fleet_drivers d ON d.id = c.driver_id`;
  get('/checklists', ALL, (req, res, db) => {
    const args = [];
    const where = [];
    if (req.query.vehicle_id) { where.push('c.vehicle_id = ?'); args.push(req.query.vehicle_id); }
    if (req.query.issues === '1') where.push('c.has_issues = 1');
    if (req.fleet.access === 'motorista') {
      where.push('(c.user_id = ?' + (req.fleet.driver ? ' OR c.driver_id = ?' : '') + ')');
      args.push(req.user.id); if (req.fleet.driver) args.push(req.fleet.driver.id);
    }
    const rows = db.prepare(`${ckSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.created_at DESC LIMIT ${limitOf(req, 50)}`).all(...args);
    return {
      checklists: rows.map(({ answers_json, photos_json, ...r }) => {
        const photos = JSON.parse(photos_json || '{}');
        const ans = JSON.parse(answers_json || '[]');
        const itemPhotos = ans.filter((a) => a.photo_url).length;
        const stagePhotos = Object.values(photos).filter(Boolean).length;
        return { ...r, photos, photo_count: stagePhotos + itemPhotos };
      }),
    };
  });
  get('/checklists/:id', ALL, (req, res, db) => {
    const c = db.prepare(`${ckSelect} WHERE c.id = ?`).get(req.params.id);
    if (!c) throw new FleetError(404, 'Checklist não encontrado');
    if (!own(req, c)) throw new FleetError(403, 'Checklist de outro motorista');
    const { answers_json, photos_json, ...rest } = c;
    return {
      checklist: {
        ...rest,
        answers: JSON.parse(answers_json || '[]'),
        photos: JSON.parse(photos_json || '{}'),
      },
    };
  });

  post('/checklists', ALL, (req, res, db) => {
    const access = req.fleet.access;
    const driver = access === 'motorista' ? needDriver(req) : (req.body?.driver_id ? db.prepare('SELECT * FROM fleet_drivers WHERE id = ?').get(req.body.driver_id) : req.fleet.driver);
    const v = activeVehicle(db, req.body?.vehicle_id);
    const type = ['retorno', 'chegada'].includes(req.body?.type) ? 'retorno' : 'saida';
    const km = req.body?.km === undefined || req.body.km === '' ? null : Number(String(req.body.km).replace(',', '.'));
    if (km != null && (!Number.isFinite(km) || km < 0)) throw new FleetError(400, 'Quilometragem inválida');
    const generalNotes = String(req.body?.notes || '').trim().slice(0, 500) || null;
    const items = db.prepare('SELECT * FROM fleet_checklist_items WHERE active = 1 ORDER BY sort_order, label').all();
    const given = new Map((Array.isArray(req.body?.answers) ? req.body.answers : []).map((a) => [a.item_id, a]));
    const answers = items.map((it) => {
      const a = given.get(it.id);
      const rawStatus = a?.status === 'irregular' ? 'problema' : a?.status;
      if (!a || !['ok', 'problema', 'na'].includes(rawStatus)) throw new FleetError(400, `Responda o item: ${it.label}`);
      const note = String(a.note || (rawStatus === 'problema' ? generalNotes : '') || '').trim().slice(0, 300);
      if (rawStatus === 'problema' && note.length < 3) throw new FleetError(400, `Descreva a avaria/observação do item irregular: ${it.label}`);
      const photoUrl = saveChecklistPhoto(a.photo_url || a.photo || null);
      return { item_id: it.id, label: it.label, category: it.category, critical: it.critical, status: rawStatus, note: note || null, photo_url: photoUrl };
    });

    const rawPhotos = req.body?.photos && typeof req.body.photos === 'object' ? req.body.photos : {};
    const photos = {};
    for (const k of ['painel', 'pneus', 'iluminacao', 'frente', 'traseira', 'lateral_direita', 'lateral_esquerda']) {
      const saved = saveChecklistPhoto(rawPhotos[k]);
      if (saved) photos[k] = saved;
    }

    if (req.body?.require_photos === true) {
      if (!photos.painel) throw new FleetError(400, '📸 Envie a foto obrigatória do Painel com motor ligado (Etapa 1)');
      const tireProb = answers.some((a) => a.status === 'problema' && String(a.category || '').includes('Pneus'));
      const tireItemPhoto = answers.some((a) => a.photo_url && String(a.category || '').includes('Pneus'));
      if (tireProb && !photos.pneus && !tireItemPhoto) {
        throw new FleetError(400, '📸 Como houve item irregular em Pneus & Rodagem, envie a foto do pneu/defeito (Etapa 2)');
      }
      const lightProb = answers.some((a) => a.status === 'problema' && String(a.category || '').includes('Ilumina'));
      const lightItemPhoto = answers.some((a) => a.photo_url && String(a.category || '').includes('Ilumina'));
      if (lightProb && !photos.iluminacao && !lightItemPhoto) {
        throw new FleetError(400, '📸 Como houve item irregular em Iluminação & Sinalização, envie a foto do defeito (Etapa 3)');
      }
      if (!photos.frente || !photos.traseira || !photos.lateral_direita || !photos.lateral_esquerda) {
        throw new FleetError(400, '📸 Envie as 4 fotos obrigatórias do caminhão: Frente, Traseira, Lateral Direita e Lateral Esquerda (Etapa 4)');
      }
    }

    const problems = answers.filter((a) => a.status === 'problema');
    const critical = problems.filter((a) => a.critical);
    const id = randomUUID();
    const at = nowIso();
    tx(db, () => {
      insertRow(db, 'fleet_checklists', { id, vehicle_id: v.id, driver_id: driver?.id || null, user_id: req.user.id, type, km,
        answers_json: JSON.stringify(answers), photos_json: JSON.stringify(photos), has_issues: problems.length ? 1 : 0, critical_issues: critical.length,
        notes: generalNotes, created_at: at });
      if (km != null) setOdometer(db, v, km, 'checklist', req.user.id);
      if (critical.length && v.status === 'ativo') db.prepare("UPDATE fleet_vehicles SET status='manutencao', updated_at=? WHERE id=?").run(at, v.id);
    });
    const out = { ok: true, blocked: critical.length > 0 && v.status === 'ativo', wo: null, warnings: [] };
    if (problems.length) {
      const text = problems.map((p) => `• ${p.label}${p.critical ? ' [CRÍTICO]' : ''}: ${p.note}`).join('\n');
      const wantOs = critical.length > 0 || req.body?.open_os === true;
      if (wantOs) {
        try {
          const allPhotoUrls = [
            ...Object.values(photos),
            ...answers.map((a) => a.photo_url).filter(Boolean),
          ];
          const woAttachments = allPhotoUrls.map((u) => {
            const fname = String(u).replace(/^\/uploads\//, '');
            return fname ? { id: randomUUID(), file: fname, mime: 'image/jpeg', size: 0 } : null;
          }).filter(Boolean);

          const r = openWorkOrder(db, req.user, v, {
            description: `Checklist de ${type === 'saida' ? 'saída' : 'chegada'} — ${v.plate}${driver ? ` (motorista ${driver.name})` : ''}:\n${text}${generalNotes ? `\nObs.: ${generalNotes}` : ''}`.slice(0, 900),
            priority: critical.length ? 'urgente' : 'media', stopped: critical.length > 0,
            title: `Frota ${v.plate}: problemas no checklist`,
            attachments: woAttachments,
          });
          db.prepare('UPDATE fleet_checklists SET wo_id = ? WHERE id = ?').run(r.woId, id);
          out.wo = { id: r.woId, number: r.number };
        } catch (e) { out.warnings.push(`Checklist salvo, mas a OS não pôde ser aberta: ${e.message}`); }
      }
      const ids = fleetUserIds(db, ['gestor', 'mecanico']).filter((u) => u !== req.user.id);
      if (ids.length) {
        notify(db, ids, { woId: out.wo?.id || null, kind: 'frota_checklist',
          title: `${critical.length ? '🛑' : '⚠️'} Checklist com problemas — ${v.plate}`,
          body: `${problems.length} problema(s)${critical.length ? `, ${critical.length} crítico(s) — veículo bloqueado` : ''}. ${text}`.slice(0, 300) });
      }
    }
    res.status(201);
    return { ...out, checklist: db.prepare(`${ckSelect} WHERE c.id = ?`).get(id) };
  });

  // ======================================================================= MANUTENÇÃO (planos por km/tempo)
  get('/plans', GM, (req, res, db) => {
    const rows = db.prepare(`SELECT p.*, v.plate, v.nickname FROM fleet_plans p JOIN fleet_vehicles v ON v.id = p.vehicle_id
                             WHERE v.active = 1 ${req.query.vehicle_id ? 'AND p.vehicle_id = ?' : ''} ORDER BY v.plate, p.title`).all(...(req.query.vehicle_id ? [req.query.vehicle_id] : []));
    const vmap = new Map(db.prepare('SELECT * FROM fleet_vehicles').all().map((v) => [v.id, v]));
    const order = { vencida: 0, proxima: 1, ok: 2 };
    return { plans: rows.map((p) => ({ ...planStatus(p, vmap.get(p.vehicle_id)), plate: p.plate, nickname: p.nickname }))
      .sort((a, b) => order[a.state] - order[b.state]) };
  });
  post('/plans', GM, (req, res, db) => {
    const d = parseBody(SCHEMAS.plan, req.body);
    if (d.every_km == null && d.every_days == null) throw new FleetError(400, 'Informe o intervalo em km e/ou em dias');
    const v = activeVehicle(db, d.vehicle_id);
    d.last_km = d.last_km ?? v.odometer_km;
    d.last_date = d.last_date || today();
    const id = randomUUID();
    insertRow(db, 'fleet_plans', { id, ...d, created_at: nowIso() });
    setImmediate(() => dispatchAlerts(getDb()));
    res.status(201);
    return { ok: true, plan: planStatus(db.prepare('SELECT * FROM fleet_plans WHERE id = ?').get(id), v) };
  });
  put('/plans/:id', GM, (req, res, db) => {
    const p = db.prepare('SELECT * FROM fleet_plans WHERE id = ?').get(req.params.id);
    if (!p) throw new FleetError(404, 'Plano não encontrado');
    const { vehicle_id, ...schema } = SCHEMAS.plan; // eslint-disable-line no-unused-vars
    const d = parseBody(schema, req.body, { partial: true });
    updateRow(db, 'fleet_plans', p.id, d);
    return { ok: true, plan: planStatus(db.prepare('SELECT * FROM fleet_plans WHERE id = ?').get(p.id), getVehicle(db, p.vehicle_id)) };
  });
  del('/plans/:id', G, (req, res, db) => {
    db.prepare('DELETE FROM fleet_plans WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  post('/plans/:id/done', GM, (req, res, db) => {
    const p = db.prepare('SELECT * FROM fleet_plans WHERE id = ?').get(req.params.id);
    if (!p) throw new FleetError(404, 'Plano não encontrado');
    const v = getVehicle(db, p.vehicle_id);
    const d = parseBody({
      km: { t: 'num', min: 0, max: 5000000, label: 'Quilometragem' }, done_date: { t: 'date', label: 'Data' },
      cost: { t: 'num', min: 0, max: 10000000, label: 'Custo' }, notes: { t: 'str', max: 500, label: 'Observações' },
      wo_id: { t: 'str', max: 60, label: 'OS' },
    }, req.body);
    const km = d.km ?? v.odometer_km;
    const date = d.done_date || today();
    tx(db, () => {
      if (km > v.odometer_km) setOdometer(db, v, km, 'manutencao', req.user.id, `Plano: ${p.title}`);
      db.prepare('UPDATE fleet_plans SET last_km = ?, last_date = ? WHERE id = ?').run(km, date, p.id);
      db.prepare(`INSERT INTO fleet_maintenance_history (id, vehicle_id, plan_id, title, km, done_date, cost, wo_id, notes, user_id, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), v.id, p.id, p.title, km, date, d.cost, d.wo_id, d.notes, req.user.id, nowIso());
      if (d.cost > 0) insertRow(db, 'fleet_costs', { id: randomUUID(), vehicle_id: v.id, category: 'manutencao', cost_date: date, amount: d.cost, description: p.title, km, wo_id: d.wo_id, user_id: req.user.id, created_at: nowIso() });
    });
    setImmediate(() => dispatchAlerts(getDb()));
    return { ok: true, plan: planStatus(db.prepare('SELECT * FROM fleet_plans WHERE id = ?').get(p.id), getVehicle(db, v.id)) };
  });

  post('/plans/:id/open-os', GM, (req, res, db) => {
    const p = db.prepare('SELECT * FROM fleet_plans WHERE id = ?').get(req.params.id);
    if (!p) throw new FleetError(404, 'Plano não encontrado');
    const v = activeVehicle(db, p.vehicle_id);
    const s = planStatus(p, v);
    const r = openWorkOrder(db, req.user, v, {
      description: `Manutenção preventiva da frota: ${p.title} — ${v.plate} (${Math.round(v.odometer_km)} km)${s.remaining_km != null ? `. ${s.remaining_km <= 0 ? 'Vencida' : 'Faltam'} ${Math.abs(s.remaining_km)} km` : ''}`,
      priority: s.state === 'vencida' ? 'alta' : 'media', type: 'preventiva', title: `Frota ${v.plate}: ${p.title}`,
    });
    return { ok: true, wo: { id: r.woId, number: r.number } };
  });

  get('/maintenance-history', GM, (req, res, db) => ({
    history: db.prepare(`SELECT h.*, v.plate FROM fleet_maintenance_history h JOIN fleet_vehicles v ON v.id = h.vehicle_id
                         ${req.query.vehicle_id ? 'WHERE h.vehicle_id = ?' : ''} ORDER BY h.done_date DESC, h.created_at DESC LIMIT ${limitOf(req, 100)}`).all(...(req.query.vehicle_id ? [req.query.vehicle_id] : [])),
  }));

  // ======================================================================= PNEUS
  function tireOut(t, v) {
    const run = (t.km_accumulated || 0) + (t.vehicle_id && t.install_km != null && v ? Math.max(0, v.odometer_km - t.install_km) : 0);
    return { ...t, km_run: Math.round(run), life_pct: t.expected_km ? Math.round((run / t.expected_km) * 100) : null };
  }
  get('/tires', GM, (req, res, db) => {
    const args = [];
    const where = [];
    if (req.query.vehicle_id) { where.push('t.vehicle_id = ?'); args.push(req.query.vehicle_id); }
    if (req.query.status) { where.push('t.status = ?'); args.push(req.query.status); } else where.push("t.status <> 'descartado'");
    const rows = db.prepare(`SELECT t.*, v.plate, v.odometer_km, v.axles FROM fleet_tires t LEFT JOIN fleet_vehicles v ON v.id = t.vehicle_id
                             WHERE ${where.join(' AND ')} ORDER BY v.plate, t.position, t.serial`).all(...args);
    return { tires: rows.map((r) => ({ ...tireOut(r, { odometer_km: r.odometer_km }), plate: r.plate, axles: r.axles })) };
  });
  const tireFree = (db, vehicleId, position, exceptId = null) =>
    !db.prepare("SELECT 1 FROM fleet_tires WHERE vehicle_id = ? AND position = ? AND status = 'em_uso' AND id <> ?").get(vehicleId, position, exceptId || '');
  const logTire = (db, tire, type, { vehicle_id = null, position = null, km = null, cost = null, notes = null, date = null }, userId) => {
    insertRow(db, 'fleet_tire_events', { id: randomUUID(), tire_id: tire.id, type, vehicle_id, position, km, event_date: date || today(), cost, notes, user_id: userId, created_at: nowIso() });
    if (cost > 0 && vehicle_id) insertRow(db, 'fleet_costs', { id: randomUUID(), vehicle_id, category: 'pneus', cost_date: date || today(), amount: cost, description: `Pneu ${tire.serial || ''} — ${type}`.trim(), km, user_id: userId, created_at: nowIso() });
  };
  post('/tires', GM, (req, res, db) => {
    const d = parseBody(SCHEMAS.tire, req.body);
    if (d.serial && db.prepare('SELECT 1 FROM fleet_tires WHERE serial = ?').get(d.serial)) throw new FleetError(409, `Já existe pneu com o número ${d.serial}`);
    const id = randomUUID();
    let v = null;
    if (d.vehicle_id) {
      v = activeVehicle(db, d.vehicle_id);
      if (!d.position) throw new FleetError(400, 'Informe a posição do pneu no veículo');
      if (!tireFree(db, v.id, d.position)) throw new FleetError(409, `A posição ${d.position} já está ocupada neste veículo`);
      d.status = 'em_uso'; d.install_km = d.install_km ?? v.odometer_km; d.install_date = d.install_date || today();
    } else { d.status = d.status === 'descartado' ? 'descartado' : 'estoque'; d.position = null; }
    tx(db, () => {
      insertRow(db, 'fleet_tires', { id, ...d, km_accumulated: 0, retread_count: 0, created_at: nowIso() });
      if (v) logTire(db, { id, serial: d.serial }, 'instalacao', { vehicle_id: v.id, position: d.position, km: d.install_km, date: d.install_date, notes: 'Instalação inicial' }, req.user.id);
    });
    res.status(201);
    return { ok: true, tire: db.prepare('SELECT * FROM fleet_tires WHERE id = ?').get(id) };
  });
  put('/tires/:id', GM, (req, res, db) => {
    const t = db.prepare('SELECT * FROM fleet_tires WHERE id = ?').get(req.params.id);
    if (!t) throw new FleetError(404, 'Pneu não encontrado');
    const { serial, brand, model, size, expected_km, cost, notes } = SCHEMAS.tire;
    const d = parseBody({ serial, brand, model, size, expected_km, cost, notes }, req.body, { partial: true });
    if (d.serial && db.prepare('SELECT 1 FROM fleet_tires WHERE serial = ? AND id <> ?').get(d.serial, t.id)) throw new FleetError(409, `Já existe pneu com o número ${d.serial}`);
    updateRow(db, 'fleet_tires', t.id, d);
    return { ok: true, tire: db.prepare('SELECT * FROM fleet_tires WHERE id = ?').get(t.id) };
  });
  del('/tires/:id', G, (req, res, db) => {
    tx(db, () => { db.prepare('DELETE FROM fleet_tire_events WHERE tire_id = ?').run(req.params.id); db.prepare('DELETE FROM fleet_tires WHERE id = ?').run(req.params.id); });
    return { ok: true };
  });
  get('/tires/:id/events', GM, (req, res, db) => ({
    events: db.prepare('SELECT e.*, v.plate FROM fleet_tire_events e LEFT JOIN fleet_vehicles v ON v.id = e.vehicle_id WHERE e.tire_id = ? ORDER BY e.event_date DESC, e.created_at DESC').all(req.params.id),
  }));

  post('/tires/:id/event', GM, (req, res, db) => {
    const t = db.prepare('SELECT * FROM fleet_tires WHERE id = ?').get(req.params.id);
    if (!t) throw new FleetError(404, 'Pneu não encontrado');
    const type = req.body?.type;
    if (!TIRE_EVENTS.includes(type)) throw new FleetError(400, 'Tipo de evento inválido');
    const e = parseBody({
      km: { t: 'num', min: 0, max: 5000000, label: 'Quilometragem' }, event_date: { t: 'date', label: 'Data' },
      vehicle_id: { t: 'str', max: 60, label: 'Veículo' }, position: { t: 'str', max: 40, label: 'Posição' },
      cost: { t: 'num', min: 0, max: 1000000, label: 'Custo' }, notes: { t: 'str', max: 300, label: 'Observações' },
    }, req.body);
    const curVeh = t.vehicle_id ? getVehicle(db, t.vehicle_id) : null;
    const removeFromVehicle = (km) => {
      const run = t.install_km != null ? Math.max(0, km - t.install_km) : 0;
      return { km_accumulated: round2((t.km_accumulated || 0) + run), vehicle_id: null, position: null, install_km: null, install_date: null };
    };
    tx(db, () => {
      if (type === 'instalacao') {
        if (t.status === 'em_uso') throw new FleetError(409, 'O pneu já está instalado. Remova antes de instalar em outro veículo/posição.');
        if (t.status === 'descartado') throw new FleetError(409, 'Pneu descartado não pode ser instalado');
        const v = activeVehicle(db, e.vehicle_id);
        if (!e.position) throw new FleetError(400, 'Informe a posição');
        if (!tireFree(db, v.id, e.position)) throw new FleetError(409, `A posição ${e.position} já está ocupada`);
        const km = e.km ?? v.odometer_km;
        updateRow(db, 'fleet_tires', t.id, { status: 'em_uso', vehicle_id: v.id, position: e.position, install_km: km, install_date: e.event_date || today() });
        logTire(db, t, type, { vehicle_id: v.id, position: e.position, km, cost: e.cost, notes: e.notes, date: e.event_date }, req.user.id);
      } else if (type === 'rodizio') {
        if (t.status !== 'em_uso') throw new FleetError(409, 'Só pneus instalados podem ser rodiziados');
        if (!e.position || e.position === t.position) throw new FleetError(400, 'Informe a nova posição');
        const other = db.prepare("SELECT * FROM fleet_tires WHERE vehicle_id = ? AND position = ? AND status = 'em_uso'").get(t.vehicle_id, e.position);
        if (other) {
          updateRow(db, 'fleet_tires', other.id, { position: t.position });
          logTire(db, other, 'rodizio', { vehicle_id: t.vehicle_id, position: t.position, km: e.km ?? curVeh.odometer_km, notes: `Troca com pneu ${t.serial || ''}`, date: e.event_date }, req.user.id);
        }
        updateRow(db, 'fleet_tires', t.id, { position: e.position });
        logTire(db, t, type, { vehicle_id: t.vehicle_id, position: e.position, km: e.km ?? curVeh.odometer_km, cost: e.cost, notes: e.notes, date: e.event_date }, req.user.id);
      } else if (type === 'remocao' || type === 'recapagem' || type === 'descarte') {
        const km = e.km ?? curVeh?.odometer_km ?? 0;
        const patch = t.status === 'em_uso' ? removeFromVehicle(km) : {};
        if (type === 'remocao') {
          if (t.status !== 'em_uso') throw new FleetError(409, 'O pneu não está instalado');
          patch.status = 'estoque';
        } else if (type === 'recapagem') {
          patch.status = 'recapagem'; patch.retread_count = (t.retread_count || 0) + 1;
        } else patch.status = 'descartado';
        updateRow(db, 'fleet_tires', t.id, patch);
        logTire(db, t, type, { vehicle_id: t.vehicle_id, position: t.position, km, cost: e.cost, notes: e.notes, date: e.event_date }, req.user.id);
      } else { // calibragem | reparo
        if (type === 'reparo' || e.cost) { /* custo vinculado ao veículo atual, se houver */ }
        logTire(db, t, type, { vehicle_id: t.vehicle_id, position: t.position, km: e.km ?? curVeh?.odometer_km ?? null, cost: e.cost, notes: e.notes, date: e.event_date }, req.user.id);
      }
    });
    const fresh = db.prepare('SELECT * FROM fleet_tires WHERE id = ?').get(t.id);
    return { ok: true, tire: tireOut(fresh, fresh.vehicle_id ? getVehicle(db, fresh.vehicle_id) : null) };
  });

  // ======================================================================= DOCUMENTOS
  const docChecks = (db, d) => {
    if (d.entity_type === 'vehicle') {
      if (!db.prepare('SELECT 1 FROM fleet_vehicles WHERE id = ?').get(d.entity_id)) throw new FleetError(400, 'Veículo não encontrado');
    } else if (!db.prepare('SELECT 1 FROM fleet_drivers WHERE id = ?').get(d.entity_id)) throw new FleetError(400, 'Motorista não encontrado');
    if (d.issue_date && d.expiry_date && d.expiry_date < d.issue_date) throw new FleetError(400, 'O vencimento não pode ser anterior à emissão');
  };
  get('/documents', ALL, (req, res, db) => {
    const lead = fleetSettings(db).alert_days;
    const args = [];
    const where = [];
    if (req.fleet.access === 'motorista') {
      if (!req.fleet.driver) return { documents: [] };
      where.push("d.entity_type = 'driver' AND d.entity_id = ?"); args.push(req.fleet.driver.id);
    } else {
      if (req.query.entity_type) { where.push('d.entity_type = ?'); args.push(req.query.entity_type); }
      if (req.query.entity_id) { where.push('d.entity_id = ?'); args.push(req.query.entity_id); }
    }
    const rows = db.prepare(`SELECT d.*, CASE d.entity_type WHEN 'vehicle' THEN v.plate ELSE dr.name END owner_label
                             FROM fleet_documents d LEFT JOIN fleet_vehicles v ON d.entity_type='vehicle' AND v.id = d.entity_id
                             LEFT JOIN fleet_drivers dr ON d.entity_type='driver' AND dr.id = d.entity_id
                             ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(d.expiry_date,'9999-12-31')`).all(...args);
    let out = rows.map((r) => ({ ...r, status: docStatus(r.expiry_date, lead) }));
    if (req.query.state) out = out.filter((r) => r.status.state === req.query.state);
    if (req.fleet.access === 'mecanico') out = out.map((r) => ({ ...r, cost: null }));
    return { documents: out };
  });
  post('/documents', G, (req, res, db) => {
    const d = parseBody(SCHEMAS.document, req.body);
    docChecks(db, d);
    const id = randomUUID();
    insertRow(db, 'fleet_documents', { id, ...d, created_at: nowIso() });
    setImmediate(() => dispatchAlerts(getDb()));
    res.status(201);
    return { ok: true, document: db.prepare('SELECT * FROM fleet_documents WHERE id = ?').get(id) };
  });
  put('/documents/:id', G, (req, res, db) => {
    const cur = db.prepare('SELECT * FROM fleet_documents WHERE id = ?').get(req.params.id);
    if (!cur) throw new FleetError(404, 'Documento não encontrado');
    const d = parseBody(SCHEMAS.document, req.body, { partial: true });
    docChecks(db, { ...cur, ...d });
    updateRow(db, 'fleet_documents', cur.id, d);
    return { ok: true, document: db.prepare('SELECT * FROM fleet_documents WHERE id = ?').get(cur.id) };
  });
  del('/documents/:id', G, (req, res, db) => {
    db.prepare('DELETE FROM fleet_documents WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  // ======================================================================= MULTAS
  const fineSelect = `SELECT f.*, v.plate, v.nickname, d.name driver_name FROM fleet_fines f
                      JOIN fleet_vehicles v ON v.id = f.vehicle_id LEFT JOIN fleet_drivers d ON d.id = f.driver_id`;
  get('/fines', ['gestor', 'motorista'], (req, res, db) => {
    const args = [];
    const where = [];
    if (req.fleet.access === 'motorista') {
      if (!req.fleet.driver) return { fines: [] };
      where.push('f.driver_id = ?'); args.push(req.fleet.driver.id);
    }
    for (const q of ['vehicle_id', 'driver_id', 'status']) if (req.query[q] && req.fleet.access === 'gestor') { where.push(`f.${q} = ?`); args.push(req.query[q]); }
    return { fines: db.prepare(`${fineSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY f.fine_date DESC LIMIT ${limitOf(req)}`).all(...args) };
  });
  const driverAt = (db, vehicleId, iso) => db.prepare(
    'SELECT driver_id FROM fleet_trips WHERE vehicle_id = ? AND start_at <= ? AND (end_at IS NULL OR end_at >= ?) ORDER BY start_at DESC LIMIT 1').get(vehicleId, iso, iso)?.driver_id || null;
  post('/fines', G, (req, res, db) => {
    const d = parseBody(SCHEMAS.fine, req.body);
    getVehicle(db, d.vehicle_id);
    let detected = false;
    if (!d.driver_id) { d.driver_id = driverAt(db, d.vehicle_id, d.fine_date); detected = !!d.driver_id; }
    if (d.status === 'paga' && !d.paid_date) d.paid_date = today();
    const id = randomUUID();
    insertRow(db, 'fleet_fines', { id, ...d, created_at: nowIso() });
    const driver = d.driver_id ? db.prepare('SELECT user_id, name FROM fleet_drivers WHERE id = ?').get(d.driver_id) : null;
    if (driver?.user_id) notify(db, [driver.user_id], { kind: 'frota_multa', title: '🚨 Multa registrada no seu nome', body: `${d.infraction} • R$ ${round2(d.amount).toFixed(2)}${d.due_date ? ` • vence ${d.due_date}` : ''}` });
    res.status(201);
    return { ok: true, driver_detected: detected, fine: db.prepare(`${fineSelect} WHERE f.id = ?`).get(id) };
  });
  put('/fines/:id', G, (req, res, db) => {
    const cur = db.prepare('SELECT * FROM fleet_fines WHERE id = ?').get(req.params.id);
    if (!cur) throw new FleetError(404, 'Multa não encontrada');
    const d = parseBody(SCHEMAS.fine, req.body, { partial: true });
    if (d.status === 'paga' && !d.paid_date && !cur.paid_date) d.paid_date = today();
    if (d.status && d.status !== 'paga' && d.paid_date === undefined) d.paid_date = null;
    updateRow(db, 'fleet_fines', cur.id, d);
    return { ok: true, fine: db.prepare(`${fineSelect} WHERE f.id = ?`).get(cur.id) };
  });
  del('/fines/:id', G, (req, res, db) => {
    db.prepare('DELETE FROM fleet_fines WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  // ======================================================================= CUSTOS
  get('/costs', G, (req, res, db) => {
    const { from, to } = req.query.from || req.query.to ? dateRange(req) : { from: '0000-01-01', to: '9999-12-31' };
    const args = [from, to];
    let where = 'c.cost_date BETWEEN ? AND ?';
    if (req.query.vehicle_id) { where += ' AND c.vehicle_id = ?'; args.push(req.query.vehicle_id); }
    if (req.query.category) { where += ' AND c.category = ?'; args.push(req.query.category); }
    const rows = db.prepare(`SELECT c.*, v.plate, v.nickname FROM fleet_costs c JOIN fleet_vehicles v ON v.id = c.vehicle_id WHERE ${where} ORDER BY c.cost_date DESC, c.created_at DESC LIMIT ${limitOf(req)}`).all(...args);
    return { costs: rows, total: round2(rows.reduce((a, r) => a + r.amount, 0)) };
  });
  post('/costs', GM, (req, res, db) => {
    const d = parseBody(SCHEMAS.cost, req.body);
    activeVehicle(db, d.vehicle_id);
    const id = randomUUID();
    insertRow(db, 'fleet_costs', { id, ...d, cost_date: d.cost_date || today(), user_id: req.user.id, created_at: nowIso() });
    res.status(201);
    return { ok: true, cost: db.prepare('SELECT * FROM fleet_costs WHERE id = ?').get(id) };
  });
  put('/costs/:id', G, (req, res, db) => {
    if (!db.prepare('SELECT 1 FROM fleet_costs WHERE id = ?').get(req.params.id)) throw new FleetError(404, 'Custo não encontrado');
    const { vehicle_id, ...schema } = SCHEMAS.cost; // eslint-disable-line no-unused-vars
    updateRow(db, 'fleet_costs', req.params.id, parseBody(schema, req.body, { partial: true }));
    return { ok: true, cost: db.prepare('SELECT * FROM fleet_costs WHERE id = ?').get(req.params.id) };
  });
  del('/costs/:id', G, (req, res, db) => {
    db.prepare('DELETE FROM fleet_costs WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  get('/reports/costs', G, (req, res, db) => costReport(db, { ...dateRange(req), vehicleId: req.query.vehicle_id || null }));
  get('/reports/costs.csv', G, (req, res, db) => {
    const r = costReport(db, { ...dateRange(req), vehicleId: req.query.vehicle_id || null });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="frota-custos-${r.from}_${r.to}.csv"`);
    res.send(costReportCsv(r));
  });

  // ======================================================================= EQUIPE / PERMISSÕES
  get('/team', G, (req, res, db) => ({
    users: db.prepare("SELECT id, name, username, role, fleet_role, phone FROM users WHERE active = 1 ORDER BY name").all().map((u) => ({
      ...u, access: fleetAccessOf(u), implicit: ['superadmin', 'admin', 'gerente'].includes(u.role),
      driver_id: db.prepare('SELECT id FROM fleet_drivers WHERE user_id = ? AND active = 1').get(u.id)?.id || null })),
  }));
  put('/team/:userId', G, (req, res, db) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.params.userId);
    if (!u) throw new FleetError(404, 'Usuário não encontrado');
    if (['superadmin', 'admin', 'gerente'].includes(u.role)) throw new FleetError(400, 'Administradores já têm acesso total à frota');
    const fr = req.body?.fleet_role || null;
    if (fr !== null && !FLEET_LEVELS.includes(fr)) throw new FleetError(400, 'Perfil inválido');
    if (fr === 'gestor' && !['superadmin', 'admin', 'gerente'].includes(req.user.role)) throw new FleetError(403, 'Somente administradores podem criar outro gestor de frota');
    tx(db, () => {
      db.prepare('UPDATE users SET fleet_role = ? WHERE id = ?').run(fr, u.id);
      if (fr === 'motorista' && !db.prepare('SELECT 1 FROM fleet_drivers WHERE user_id = ?').get(u.id)) {
        insertRow(db, 'fleet_drivers', { id: randomUUID(), user_id: u.id, name: u.name, phone: u.phone || null, status: 'ativo', active: 1, created_at: nowIso() });
      }
    });
    const driver = db.prepare('SELECT * FROM fleet_drivers WHERE user_id = ? AND active = 1').get(u.id);
    return { ok: true, fleet_role: fr, driver_id: driver?.id || null, needs_cnh: fr === 'motorista' && !driver?.cnh_expiry };
  });
}
