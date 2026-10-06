// Gerador de preventivas (calendário fixo) e avisos de vencimento/atraso.
// Cada ciclo tem chave única plano:vencimento — uma OS por ciclo, sem duplicação.
import { randomUUID } from 'node:crypto';
import { getSetting, setSetting, notify } from './domain.js';

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function generateCycle(db, plan, { userId = null, origin = 'agendador' } = {}) {
  const cycleKey = `${plan.id}:${plan.next_due}`;
  const exists = db.prepare('SELECT id, number FROM work_orders WHERE cycle_key=?').get(cycleKey);
  let created = null;
  if (!exists) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const n = Number(getSetting(db, 'next_wo_number', '1001'));
    setSetting(db, 'next_wo_number', n + 1);
    const checklist = JSON.parse(plan.checklist_json || '[]').map((i) => ({ text: i.text, done: false }));
    const recipients = plan.responsible_id ? [plan.responsible_id] : [];
    db.prepare(`INSERT INTO work_orders (id,number,machine_id,type,priority,machine_stopped,requester_id,responsible_id,status,title,description,
                recipients_mode,recipients_json,checklist_json,plan_id,cycle_key,due_date,created_at,received_at)
                VALUES (?,?,?,'preventiva','media',0,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, n, plan.machine_id, userId, plan.responsible_id, plan.responsible_id ? 'Assumida' : 'Aberta', plan.title,
        `Preventiva: ${plan.title} (vencimento ${plan.next_due.split('-').reverse().join('/')})`,
        plan.responsible_id ? 'selecionados' : 'todos', JSON.stringify(recipients), JSON.stringify(checklist),
        plan.id, cycleKey, plan.next_due, now, now);
    db.prepare(`INSERT INTO wo_events (id,wo_id,user_id,action,data_json,local_time,received_at,origin) VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), id, userId, 'gerar_preventiva', JSON.stringify({ planId: plan.id, cycleKey, origin }), now, now, origin);
    if (plan.responsible_id) {
      db.prepare(`INSERT INTO wo_participants (wo_id,user_id,role,state,joined_at) VALUES (?,?,'responsavel','aguardando',?)`).run(id, plan.responsible_id, now);
    }
    const m = db.prepare('SELECT name FROM machines WHERE id=?').get(plan.machine_id);
    const targets = plan.responsible_id ? [plan.responsible_id] : db.prepare(`SELECT id FROM users WHERE role='manutentor' AND active=1`).all().map((u) => u.id);
    notify(db, targets, { woId: id, kind: 'preventiva', title: `Preventiva OS ${n} • vence ${plan.next_due.split('-').reverse().join('/')}`, body: `${m?.name}: ${plan.title}` });
    created = { id, number: n };
  }
  // Calendário fixo: próxima data avança pela frequência, independentemente da execução
  db.prepare('UPDATE preventive_plans SET next_due=? WHERE id=?').run(addDays(plan.next_due, plan.frequency_days), plan.id);
  return created || { id: exists.id, number: exists.number, duplicate: true };
}

export function runScheduler(db) {
  const t = today();
  const out = { generated: 0, overdueNotified: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const plans = db.prepare('SELECT * FROM preventive_plans WHERE active=1').all();
    for (let plan of plans) {
      let guard = 0;
      while (addDays(plan.next_due, -plan.lead_days) <= t && guard++ < 12) {
        const r = generateCycle(db, plan);
        if (!r.duplicate) out.generated++;
        plan = db.prepare('SELECT * FROM preventive_plans WHERE id=?').get(plan.id);
      }
    }
    // Avisos de atraso (uma vez por OS)
    const late = db.prepare(`SELECT w.* FROM work_orders w WHERE w.type='preventiva' AND w.status NOT IN ('Concluída','Cancelada')
        AND w.due_date IS NOT NULL AND w.due_date < ?
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.wo_id=w.id AND n.kind='atraso')`).all(t);
    const managers = db.prepare(`SELECT id FROM users WHERE role='gerente' AND active=1`).all().map((u) => u.id);
    for (const w of late) {
      notify(db, [w.responsible_id, ...managers].filter(Boolean), {
        woId: w.id, kind: 'atraso', title: `Preventiva ATRASADA • OS ${w.number}`,
        body: `Venceu em ${w.due_date.split('-').reverse().join('/')}`,
      });
      out.overdueNotified++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Agendador de preventivas falhou', e);
  }
  return out;
}
