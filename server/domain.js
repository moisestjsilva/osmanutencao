// Regras de negócio das ordens de serviço.
// Toda alteração chega como uma "operação" com ID único (opId) — o mesmo formato
// usado pela fila offline do aparelho. O servidor deduplica pelo opId, aplica as
// regras, registra o evento (append-only) e devolve o resultado por operação.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './db.js';

export const CLOSED = ['Concluída', 'Cancelada'];
const nowIso = () => new Date().toISOString();
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

export class OpError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // 'rejected' | 'conflict' | 'invalid' | 'forbidden'
    this.extra = extra;
  }
}

// ---------------- Consultas auxiliares ----------------
export function getSetting(db, key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : def;
}
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
const getUser = (db, id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const getWoRow = (db, id) => db.prepare('SELECT * FROM work_orders WHERE id=?').get(id);
const isTech = (u) => u && (u.role === 'manutentor' || u.role === 'gerente');
const isManager = (u) => u && u.role === 'gerente';

function nextNumber(db) {
  const n = Number(getSetting(db, 'next_wo_number', '1001'));
  setSetting(db, 'next_wo_number', n + 1);
  return n;
}

function addEvent(db, woId, userId, action, localTime, { reason = null, data = null, origin = 'online', id = null } = {}) {
  db.prepare(`INSERT INTO wo_events (id,wo_id,user_id,action,reason,data_json,local_time,received_at,origin)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id || randomUUID(), woId, userId, action, reason, data ? JSON.stringify(data) : null, localTime, nowIso(), origin);
}

function bump(db, woId) {
  db.prepare('UPDATE work_orders SET version = version + 1 WHERE id=?').run(woId);
}

function openInterval(db, woId, userId) {
  return db.prepare('SELECT * FROM work_intervals WHERE wo_id=? AND user_id=? AND ended_at IS NULL').get(woId, userId);
}

function participant(db, woId, userId) {
  return db.prepare('SELECT * FROM wo_participants WHERE wo_id=? AND user_id=?').get(woId, userId);
}

function ensureParticipant(db, woId, userId, role, at) {
  const p = participant(db, woId, userId);
  if (!p) {
    db.prepare('INSERT INTO wo_participants (wo_id,user_id,role,state,joined_at) VALUES (?,?,?,?,?)').run(woId, userId, role, 'aguardando', at);
  } else if (role === 'responsavel' && p.role !== 'responsavel') {
    db.prepare('UPDATE wo_participants SET role=? WHERE wo_id=? AND user_id=?').run('responsavel', woId, userId);
  }
}

function setPartState(db, woId, userId, state) {
  db.prepare('UPDATE wo_participants SET state=? WHERE wo_id=? AND user_id=?').run(state, woId, userId);
}

// Estado global derivado dos estados de trabalho individuais
function recomputeStatus(db, woId) {
  const wo = getWoRow(db, woId);
  if (CLOSED.includes(wo.status)) return;
  const open = db.prepare('SELECT COUNT(*) n FROM work_intervals WHERE wo_id=? AND ended_at IS NULL').get(woId).n;
  const any = db.prepare('SELECT COUNT(*) n FROM work_intervals WHERE wo_id=?').get(woId).n;
  let status = 'Aberta';
  if (open > 0) status = 'Em atendimento';
  else if (any > 0) status = 'Pausada';
  else if (wo.responsible_id) status = 'Assumida';
  if (status !== wo.status) db.prepare('UPDATE work_orders SET status=? WHERE id=?').run(status, woId);
}

function validTime(t) {
  const d = new Date(t);
  if (isNaN(d)) throw new OpError('invalid', 'Horário inválido');
  // Horário local do aparelho não pode estar muito no futuro (relógio errado)
  if (d.getTime() - Date.now() > 10 * 60000) throw new OpError('invalid', 'Horário do aparelho está adiantado');
  return d.toISOString();
}

// ---------------- Paradas de máquina (sem dupla contagem) ----------------
function openMachineStop(db, machineId, woId, at) {
  const cur = db.prepare('SELECT * FROM machine_stops WHERE machine_id=? AND ended_at IS NULL').get(machineId);
  if (cur) {
    const ids = JSON.parse(cur.wo_ids_json);
    if (!ids.includes(woId)) ids.push(woId);
    db.prepare('UPDATE machine_stops SET wo_ids_json=? WHERE id=?').run(JSON.stringify(ids), cur.id);
  } else {
    db.prepare('INSERT INTO machine_stops (id,machine_id,started_at,wo_ids_json) VALUES (?,?,?,?)')
      .run(randomUUID(), machineId, at, JSON.stringify([woId]));
  }
}

function maybeCloseMachineStop(db, machineId, at) {
  const others = db.prepare(`SELECT COUNT(*) n FROM work_orders WHERE machine_id=? AND machine_stopped=1
                             AND status NOT IN ('Concluída','Cancelada') AND (machine_recovered IS NULL OR machine_recovered=0)`).get(machineId).n;
  if (others === 0) {
    db.prepare('UPDATE machine_stops SET ended_at=? WHERE machine_id=? AND ended_at IS NULL').run(at, machineId);
  }
}

// ---------------- Notificações ----------------
export function resolveRecipients(db, mode, list) {
  const techs = db.prepare(`SELECT id, team_id FROM users WHERE active=1 AND role IN ('manutentor','gerente')`).all();
  if (mode === 'equipe') {
    const teams = new Set(list || []);
    return techs.filter((u) => teams.has(u.team_id) || false).map((u) => u.id);
  }
  if (mode === 'selecionados') {
    const ids = new Set(list || []);
    return techs.filter((u) => ids.has(u.id)).map((u) => u.id);
  }
  return techs.map((u) => u.id);
}

export function notify(db, userIds, { woId = null, kind, title, body }) {
  const st = db.prepare(`INSERT INTO notifications (id,wo_id,user_id,channel,kind,title,body,status,created_at)
                         VALUES (?,?,?,?,?,?,?,?,?)`);
  const at = nowIso();
  for (const uid of new Set(userIds)) st.run(randomUUID(), woId, uid, 'app', kind, title, body || '', 'enviada', at);
}

function woLabel(db, wo) {
  const m = db.prepare('SELECT m.name, s.name sector FROM machines m JOIN sectors s ON s.id=m.sector_id WHERE m.id=?').get(wo.machine_id);
  return { machine: m?.name || '', sector: m?.sector || '' };
}

// ---------------- Aplicação de operações ----------------
const handlers = {
  create_wo(db, op, user) {
    const p = op.payload || {};
    const id = p.id || op.woId;
    if (!id) throw new OpError('invalid', 'ID da OS ausente');
    if (getWoRow(db, id)) return { woId: id, duplicate: true };
    const machine = db.prepare('SELECT * FROM machines WHERE id=? AND active=1').get(p.machineId);
    if (!machine) throw new OpError('invalid', 'Máquina inválida — selecione uma máquina cadastrada');
    const desc = (p.description || '').trim();
    if (desc.length < 3) throw new OpError('invalid', 'Descreva o problema');
    const type = p.type === 'preventiva' ? 'preventiva' : 'corretiva';
    const priority = ['baixa', 'media', 'alta', 'urgente'].includes(p.priority) ? p.priority : 'media';
    const mode = ['todos', 'equipe', 'selecionados'].includes(p.recipientsMode) ? p.recipientsMode : getSetting(db, 'default_recipients_mode', 'todos');
    const recipients = Array.isArray(p.recipients) ? p.recipients : [];
    if (mode !== 'todos' && recipients.length === 0) throw new OpError('invalid', 'Selecione ao menos um destinatário');
    const at = validTime(op.localTime);
    const number = nextNumber(db);
    const stopped = p.machineStopped ? 1 : 0;
    db.prepare(`INSERT INTO work_orders (id,number,machine_id,type,priority,machine_stopped,requester_id,status,title,description,
                recipients_mode,recipients_json,rework_of,created_at,received_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, number, machine.id, type, priority, stopped, user.id, 'Aberta', p.title || null, desc, mode, JSON.stringify(recipients),
        p.reworkOf || null, at, nowIso());
    const effective = resolveRecipients(db, mode, recipients);
    addEvent(db, id, user.id, 'criar', at, { origin: op.origin, data: { recipientsMode: mode, recipients, effectiveRecipients: effective } });
    if (stopped) openMachineStop(db, machine.id, id, at);
    const lbl = woLabel(db, { machine_id: machine.id });
    notify(db, effective.filter((u) => u !== user.id), {
      woId: id,
      kind: 'nova_os',
      title: `${stopped ? 'MÁQUINA PARADA • ' : ''}OS ${number} • ${priority.toUpperCase()}`,
      body: `${lbl.machine} — ${lbl.sector}: ${desc.slice(0, 90)}`,
    });
    return { woId: id, number };
  },

  assume(db, op, user, wo) {
    if (!isTech(user)) throw new OpError('forbidden', 'Somente manutentores podem assumir OS');
    if (wo.responsible_id === user.id) return { woId: wo.id, already: true };
    if (CLOSED.includes(wo.status)) throw new OpError('conflict', `OS já está ${wo.status}`);
    const at = validTime(op.localTime);
    // Atômico: só assume se ninguém assumiu ainda
    const r = db.prepare(`UPDATE work_orders SET responsible_id=?, version=version+1 WHERE id=? AND responsible_id IS NULL
                          AND status NOT IN ('Concluída','Cancelada')`).run(user.id, wo.id);
    if (r.changes === 0) {
      const cur = getWoRow(db, wo.id);
      const owner = getUser(db, cur.responsible_id);
      throw new OpError('rejected', `OS já assumida por ${owner?.name || 'outro manutentor'}`);
    }
    ensureParticipant(db, wo.id, user.id, 'responsavel', at);
    addEvent(db, wo.id, user.id, 'assumir', at, { origin: op.origin });
    recomputeStatus(db, wo.id);
    return { woId: wo.id };
  },

  join(db, op, user, wo) {
    if (!isTech(user)) throw new OpError('forbidden', 'Somente manutentores participam de OS');
    if (CLOSED.includes(wo.status)) throw new OpError('conflict', `OS já está ${wo.status}`);
    if (participant(db, wo.id, user.id)) return { woId: wo.id, already: true };
    const at = validTime(op.localTime);
    ensureParticipant(db, wo.id, user.id, 'colaborador', at);
    addEvent(db, wo.id, user.id, 'participar', at, { origin: op.origin });
    bump(db, wo.id);
    return { woId: wo.id };
  },

  start(db, op, user, wo) {
    if (!isTech(user)) throw new OpError('forbidden', 'Somente manutentores registram atendimento');
    if (CLOSED.includes(wo.status)) throw new OpError('conflict', `Não é possível iniciar: OS ${wo.status}`);
    const at = validTime(op.localTime);
    if (openInterval(db, wo.id, user.id)) return { woId: wo.id, already: true };
    // Sem responsável: quem inicia assume
    if (!wo.responsible_id) {
      const r = db.prepare('UPDATE work_orders SET responsible_id=? WHERE id=? AND responsible_id IS NULL').run(user.id, wo.id);
      if (r.changes) {
        ensureParticipant(db, wo.id, user.id, 'responsavel', at);
        addEvent(db, wo.id, user.id, 'assumir', at, { origin: op.origin, data: { auto: true } });
      }
    }
    ensureParticipant(db, wo.id, user.id, 'colaborador', at);
    // Proíbe sobreposição de intervalos da mesma pessoa na mesma OS
    const last = db.prepare('SELECT MAX(ended_at) e FROM work_intervals WHERE wo_id=? AND user_id=?').get(wo.id, user.id).e;
    if (last && last > at) throw new OpError('conflict', 'Início anterior ao fim do último intervalo registrado');
    const p = participant(db, wo.id, user.id);
    db.prepare('INSERT INTO work_intervals (id,wo_id,user_id,started_at) VALUES (?,?,?,?)').run(randomUUID(), wo.id, user.id, at);
    setPartState(db, wo.id, user.id, 'trabalhando');
    addEvent(db, wo.id, user.id, p.state === 'pausado' || p.state === 'concluido' ? 'retomar' : 'iniciar', at, { origin: op.origin });
    recomputeStatus(db, wo.id);
    bump(db, wo.id);
    return { woId: wo.id };
  },

  pause(db, op, user, wo) {
    const reason = (op.payload?.reason || '').trim();
    if (!reason) throw new OpError('invalid', 'Informe o motivo da pausa');
    return stopWork(db, op, user, wo, 'pausar', 'pausado', reason);
  },

  finish_part(db, op, user, wo) {
    return stopWork(db, op, user, wo, 'encerrar_parte', 'concluido', op.payload?.note || null);
  },

  transfer(db, op, user, wo) {
    const to = getUser(db, op.payload?.toUserId);
    const reason = (op.payload?.reason || '').trim();
    if (!to || !isTech(to)) throw new OpError('invalid', 'Destino da transferência inválido');
    if (!reason) throw new OpError('invalid', 'Informe o motivo da transferência');
    if (!(wo.responsible_id === user.id || isManager(user))) throw new OpError('forbidden', 'Somente o responsável ou o gerente transfere a OS');
    if (CLOSED.includes(wo.status)) throw new OpError('conflict', `OS já está ${wo.status}`);
    const at = validTime(op.localTime);
    if (wo.responsible_id) db.prepare(`UPDATE wo_participants SET role='colaborador' WHERE wo_id=? AND user_id=?`).run(wo.id, wo.responsible_id);
    db.prepare('UPDATE work_orders SET responsible_id=? WHERE id=?').run(to.id, wo.id);
    ensureParticipant(db, wo.id, to.id, 'responsavel', at);
    addEvent(db, wo.id, user.id, 'transferir', at, { reason, origin: op.origin, data: { from: wo.responsible_id, to: to.id } });
    notify(db, [to.id], { woId: wo.id, kind: 'transferencia', title: `OS ${wo.number} transferida para você`, body: reason });
    recomputeStatus(db, wo.id);
    bump(db, wo.id);
    return { woId: wo.id };
  },

  update_checklist(db, op, user, wo) {
    if (!isTech(user)) throw new OpError('forbidden', 'Sem permissão');
    if (CLOSED.includes(wo.status)) throw new OpError('conflict', `OS já está ${wo.status}`);
    const list = sanitizeChecklist(op.payload?.checklist);
    db.prepare('UPDATE work_orders SET checklist_json=? WHERE id=?').run(JSON.stringify(list), wo.id);
    addEvent(db, wo.id, user.id, 'checklist', validTime(op.localTime), { origin: op.origin, data: { done: list.filter((i) => i.done).length, total: list.length } });
    bump(db, wo.id);
    return { woId: wo.id };
  },

  complete(db, op, user, wo) {
    if (!(isTech(user) && (wo.responsible_id === user.id || isManager(user) || participant(db, wo.id, user.id))))
      throw new OpError('forbidden', 'Somente participantes da OS ou o gerente podem concluir');
    if (CLOSED.includes(wo.status)) throw new OpError('conflict', `OS já foi ${wo.status === 'Concluída' ? 'concluída' : 'cancelada'} por outro registro`);
    const p = op.payload || {};
    const service = (p.serviceDone || '').trim();
    if (service.length < 3) throw new OpError('invalid', 'Descreva o serviço realizado');
    let checklist = wo.checklist_json ? JSON.parse(wo.checklist_json) : null;
    if (p.checklist) checklist = sanitizeChecklist(p.checklist);
    if (checklist && checklist.length && checklist.some((i) => !i.done))
      throw new OpError('invalid', 'Checklist incompleto — marque todos os itens');
    const at = validTime(op.localTime);
    const returnedAt = wo.machine_stopped && p.machineRecovered ? validTime(p.returnedAt || at) : null;
    // Encerra intervalos ativos de todos os participantes no horário da conclusão
    const open = db.prepare('SELECT * FROM work_intervals WHERE wo_id=? AND ended_at IS NULL').all(wo.id);
    for (const iv of open) {
      const end = iv.started_at > at ? iv.started_at : at;
      db.prepare(`UPDATE work_intervals SET ended_at=?, end_reason='conclusao' WHERE id=?`).run(end, iv.id);
      if (iv.user_id !== user.id) addEvent(db, wo.id, iv.user_id, 'encerrado_na_conclusao', end, { origin: op.origin, data: { by: user.id } });
    }
    db.prepare(`UPDATE wo_participants SET state='concluido' WHERE wo_id=?`).run(wo.id);
    db.prepare(`UPDATE work_orders SET status='Concluída', service_done=?, cause=?, solution=?, machine_recovered=?, returned_at=?,
                checklist_json=?, closed_at=?, responsible_id=COALESCE(responsible_id, ?) WHERE id=?`)
      .run(service, (p.cause || '').trim() || null, (p.solution || '').trim() || null,
        wo.machine_stopped ? (p.machineRecovered ? 1 : 0) : null, returnedAt,
        checklist ? JSON.stringify(checklist) : null, at, user.id, wo.id);
    addEvent(db, wo.id, user.id, 'concluir', at, { origin: op.origin, data: { closedIntervals: open.length, machineRecovered: !!p.machineRecovered } });
    if (wo.machine_stopped && p.machineRecovered) maybeCloseMachineStop(db, wo.machine_id, returnedAt);
    if (wo.requester_id && wo.requester_id !== user.id)
      notify(db, [wo.requester_id], { woId: wo.id, kind: 'conclusao', title: `OS ${wo.number} concluída`, body: service.slice(0, 100) });
    bump(db, wo.id);
    return { woId: wo.id };
  },

  cancel(db, op, user, wo) {
    if (!isManager(user)) throw new OpError('forbidden', 'Somente o gerente cancela OS');
    if (CLOSED.includes(wo.status)) throw new OpError('conflict', `OS já está ${wo.status}`);
    const reason = (op.payload?.reason || '').trim();
    if (!reason) throw new OpError('invalid', 'Informe o motivo do cancelamento');
    const at = validTime(op.localTime);
    db.prepare(`UPDATE work_intervals SET ended_at=?, end_reason='cancelamento' WHERE wo_id=? AND ended_at IS NULL`).run(at, wo.id);
    db.prepare(`UPDATE work_orders SET status='Cancelada', cancelled_reason=?, closed_at=? WHERE id=?`).run(reason, at, wo.id);
    addEvent(db, wo.id, user.id, 'cancelar', at, { reason, origin: op.origin });
    if (wo.machine_stopped) maybeCloseMachineStop(db, wo.machine_id, at);
    bump(db, wo.id);
    return { woId: wo.id };
  },

  reopen(db, op, user, wo) {
    if (!(isManager(user) || user.id === wo.requester_id)) throw new OpError('forbidden', 'Somente o gerente ou o solicitante reabre a OS');
    if (wo.status !== 'Concluída') throw new OpError('conflict', 'Apenas OS concluídas podem ser reabertas');
    const reason = (op.payload?.reason || '').trim();
    if (!reason) throw new OpError('invalid', 'Informe o motivo da reabertura');
    const rework = !!op.payload?.rework;
    const at = validTime(op.localTime);
    db.prepare(`UPDATE work_orders SET status='Aberta', closed_at=NULL, reopened_count=reopened_count+1 WHERE id=?`).run(wo.id);
    db.prepare(`UPDATE wo_participants SET state='aguardando' WHERE wo_id=?`).run(wo.id);
    if (wo.machine_stopped && op.payload?.machineStopped) {
      db.prepare('UPDATE work_orders SET machine_recovered=0, returned_at=NULL WHERE id=?').run(wo.id);
      openMachineStop(db, wo.machine_id, wo.id, at);
    }
    addEvent(db, wo.id, user.id, 'reabrir', at, { reason, origin: op.origin, data: { rework } });
    recomputeStatus(db, wo.id);
    const targets = [wo.responsible_id, ...db.prepare('SELECT user_id FROM wo_participants WHERE wo_id=?').all(wo.id).map((r) => r.user_id)].filter(Boolean);
    notify(db, targets, { woId: wo.id, kind: 'reabertura', title: `OS ${wo.number} reaberta${rework ? ' (retrabalho)' : ''}`, body: reason });
    bump(db, wo.id);
    return { woId: wo.id };
  },

  attach(db, op, user, wo) {
    const p = op.payload || {};
    const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(p.dataUrl || '');
    if (!m) throw new OpError('invalid', 'Foto em formato inválido');
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > MAX_PHOTO_BYTES) throw new OpError('invalid', 'Foto excede 4 MB');
    const id = p.id || randomUUID();
    if (db.prepare('SELECT 1 FROM attachments WHERE id=?').get(id)) return { woId: wo.id, already: true };
    const file = `${id}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    db.prepare('INSERT INTO attachments (id,wo_id,user_id,file,mime,size,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, wo.id, user.id, file, m[1], buf.length, validTime(op.localTime));
    addEvent(db, wo.id, user.id, 'foto', validTime(op.localTime), { origin: op.origin });
    bump(db, wo.id);
    return { woId: wo.id, attachmentId: id };
  },

  // Correção administrativa de tempo — exige motivo e preserva valor anterior
  correct_interval(db, op, user, wo) {
    if (!isManager(user)) throw new OpError('forbidden', 'Somente o gerente corrige registros');
    const p = op.payload || {};
    const reason = (p.reason || '').trim();
    if (!reason) throw new OpError('invalid', 'Correção exige motivo');
    const iv = db.prepare('SELECT * FROM work_intervals WHERE id=? AND wo_id=?').get(p.intervalId, wo.id);
    if (!iv) throw new OpError('invalid', 'Intervalo não encontrado');
    const s = validTime(p.startedAt || iv.started_at);
    const e = p.endedAt ? validTime(p.endedAt) : iv.ended_at;
    if (e && e <= s) throw new OpError('invalid', 'Fim deve ser posterior ao início');
    const overlap = db.prepare(`SELECT COUNT(*) n FROM work_intervals WHERE wo_id=? AND user_id=? AND id<>?
       AND started_at < COALESCE(?, '9999') AND COALESCE(ended_at,'9999') > ?`).get(wo.id, iv.user_id, iv.id, e, s).n;
    if (overlap) throw new OpError('invalid', 'Correção criaria intervalos sobrepostos');
    const audit = db.prepare(`INSERT INTO audit_log (id,entity,entity_id,field,old_value,new_value,reason,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    if (s !== iv.started_at) audit.run(randomUUID(), 'work_interval', iv.id, 'started_at', iv.started_at, s, reason, user.id, nowIso());
    if (e !== iv.ended_at) audit.run(randomUUID(), 'work_interval', iv.id, 'ended_at', iv.ended_at, e, reason, user.id, nowIso());
    db.prepare('UPDATE work_intervals SET started_at=?, ended_at=? WHERE id=?').run(s, e, iv.id);
    addEvent(db, wo.id, user.id, 'corrigir_tempo', nowIso(), { reason, origin: op.origin, data: { intervalId: iv.id, before: [iv.started_at, iv.ended_at], after: [s, e] } });
    recomputeStatus(db, wo.id);
    bump(db, wo.id);
    return { woId: wo.id };
  },
};

function stopWork(db, op, user, wo, action, state, reason) {
  const iv = openInterval(db, wo.id, user.id);
  if (!iv) {
    if (CLOSED.includes(wo.status)) throw new OpError('conflict', `OS já está ${wo.status}; o intervalo foi encerrado na conclusão`);
    if (state === 'concluido' && participant(db, wo.id, user.id)) {
      setPartState(db, wo.id, user.id, 'concluido');
      addEvent(db, wo.id, user.id, action, validTime(op.localTime), { reason, origin: op.origin });
      bump(db, wo.id);
      return { woId: wo.id };
    }
    return { woId: wo.id, already: true };
  }
  const at = validTime(op.localTime);
  if (at < iv.started_at) throw new OpError('conflict', 'Horário de pausa anterior ao início do intervalo');
  db.prepare('UPDATE work_intervals SET ended_at=?, end_reason=? WHERE id=?').run(at, action, iv.id);
  setPartState(db, wo.id, user.id, state);
  addEvent(db, wo.id, user.id, action, at, { reason, origin: op.origin });
  recomputeStatus(db, wo.id);
  bump(db, wo.id);
  return { woId: wo.id };
}

function sanitizeChecklist(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).map((i) => ({ text: String(i.text || '').slice(0, 200), done: !!i.done, note: i.note ? String(i.note).slice(0, 200) : undefined }));
}

// Processa uma operação com deduplicação e transação
export function applyOp(db, op) {
  if (!op || !op.opId || !op.type) return { opId: op?.opId, status: 'invalid', message: 'Operação malformada' };
  const done = db.prepare('SELECT * FROM processed_ops WHERE op_id=?').get(op.opId);
  if (done) return { ...JSON.parse(done.result_json), duplicate: true };

  const user = getUser(db, op.userId);
  const handler = handlers[op.type];
  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!user || !user.active) throw new OpError('forbidden', 'Usuário inválido');
    if (!handler) throw new OpError('invalid', `Operação desconhecida: ${op.type}`);
    let wo = null;
    if (op.type !== 'create_wo') {
      wo = getWoRow(db, op.woId);
      if (!wo) throw new OpError('invalid', 'OS não encontrada (ainda não sincronizada?)', { retry: true });
    }
    const data = handler(db, op, user, wo);
    result = { opId: op.opId, status: 'ok', ...data };
    db.prepare('INSERT INTO processed_ops (op_id,user_id,type,status,result_json,local_time,received_at) VALUES (?,?,?,?,?,?,?)')
      .run(op.opId, op.userId, op.type, 'ok', JSON.stringify(result), op.localTime || null, nowIso());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    if (!(e instanceof OpError)) {
      console.error('Erro inesperado ao aplicar operação', op.type, e);
      return { opId: op.opId, status: 'error', message: 'Erro interno ao processar' };
    }
    if (e.extra.retry) return { opId: op.opId, status: 'retry', message: e.message };
    result = { opId: op.opId, status: e.kind, message: e.message, woId: op.woId || op.payload?.id };
    // Registros rejeitados/conflitantes são preservados para revisão do gerente
    db.exec('BEGIN');
    try {
      if (e.kind === 'conflict' || (e.kind === 'rejected' && op.origin === 'offline')) {
        db.prepare(`INSERT INTO conflicts (id,op_id,wo_id,user_id,type,payload_json,reason,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(randomUUID(), op.opId, op.woId || null, op.userId, op.type, JSON.stringify({ ...op, payload: stripHeavy(op.payload) }), e.message, nowIso());
      }
      db.prepare('INSERT OR IGNORE INTO processed_ops (op_id,user_id,type,status,result_json,local_time,received_at) VALUES (?,?,?,?,?,?,?)')
        .run(op.opId, op.userId, op.type, e.kind, JSON.stringify(result), op.localTime || null, nowIso());
      db.exec('COMMIT');
    } catch (e2) {
      db.exec('ROLLBACK');
      console.error(e2);
    }
  }
  return result;
}

function stripHeavy(p) {
  if (!p) return p;
  const c = { ...p };
  if (c.dataUrl) c.dataUrl = `[foto ${Math.round(c.dataUrl.length / 1365)} KB]`;
  return c;
}
