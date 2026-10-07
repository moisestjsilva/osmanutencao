// Indicadores conforme seção 6 do PRD. Cálculos sobre eventos/intervalos reais;
// quando faltam dados (ex.: calendário operacional) o indicador NÃO é exibido como calculado.
const MIN = 60000;
const mins = (a, b) => (new Date(b) - new Date(a)) / MIN;
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function computeIndicators(db, q = {}) {
  const to = q.to ? new Date(q.to + 'T23:59:59') : new Date();
  const from = q.from ? new Date(q.from + 'T00:00:00') : new Date(to.getTime() - 30 * 24 * 60 * MIN);
  const F = from.toISOString();
  const T = to.toISOString();

  const machines = db.prepare(`SELECT m.*, s.name sector_name FROM machines m JOIN sectors s ON s.id=m.sector_id`).all();
  const mById = Object.fromEntries(machines.map((m) => [m.id, m]));
  const users = db.prepare('SELECT * FROM users').all();
  const uById = Object.fromEntries(users.map((u) => [u.id, u]));

  const machineOk = (mid) => {
    const m = mById[mid];
    if (!m) return false;
    if (q.machineId && m.id !== q.machineId) return false;
    if (q.sectorId && m.sector_id !== q.sectorId) return false;
    return true;
  };

  const allWos = db.prepare('SELECT * FROM work_orders').all().filter((w) => machineOk(w.machine_id));
  const intervals = db.prepare('SELECT * FROM work_intervals').all();
  const ivByWo = {};
  for (const iv of intervals) (ivByWo[iv.wo_id] ||= []).push(iv);

  // Filtro por equipe/manutentor: OS em que alguém do filtro participou
  const peopleFilter = (uid) => {
    const u = uById[uid];
    if (!u || !(u.role === 'manutentor' || u.role === 'gerente')) return false;
    if (q.userId && uid !== q.userId) return false;
    if (q.teamId && u.team_id !== q.teamId) return false;
    return true;
  };
  const hasPeopleFilter = !!(q.userId || q.teamId);
  const parts = db.prepare('SELECT * FROM wo_participants').all();
  const partByWo = {};
  for (const p of parts) (partByWo[p.wo_id] ||= []).push(p);
  const woPeopleOk = (w) => !hasPeopleFilter || 
    (partByWo[w.id] || []).some((p) => peopleFilter(p.user_id)) || 
    peopleFilter(w.responsible_id) ||
    (ivByWo[w.id] || []).some((iv) => peopleFilter(iv.user_id));

  const inPeriod = allWos.filter((w) => w.created_at >= F && w.created_at <= T && woPeopleOk(w));
  const todayStr = new Date().toISOString().slice(0, 10);

  // Situação atual
  const openNow = allWos.filter((w) => !['Concluída', 'Cancelada'].includes(w.status) && woPeopleOk(w));
  const overdueNow = openNow.filter((w) => w.type === 'preventiva' && w.due_date && w.due_date < todayStr);
  const stopsOpen = db.prepare('SELECT * FROM machine_stops WHERE ended_at IS NULL').all().filter((s) => machineOk(s.machine_id));
  const byStatus = {};
  for (const w of openNow) byStatus[w.status] = (byStatus[w.status] || 0) + 1;

  // Tempo de resposta: primeiro início efetivo − abertura
  const responses = [];
  for (const w of inPeriod) {
    const ivs = ivByWo[w.id];
    if (!ivs?.length) continue;
    const first = ivs.map((i) => i.started_at).sort()[0];
    const r = mins(w.created_at, first);
    if (r >= 0) responses.push(r);
  }

  // Duração de OS corretiva (abertura → conclusão)
  const correctiveDone = inPeriod.filter((w) => w.type === 'corretiva' && w.status === 'Concluída' && w.closed_at);
  const durations = correctiveDone.map((w) => mins(w.created_at, w.closed_at));

  // MTTR: parada → retorno à operação (OS corretivas com parada e retorno informados)
  const repairs = correctiveDone.filter((w) => w.machine_stopped && w.returned_at).map((w) => mins(w.created_at, w.returned_at)).filter((x) => x >= 0);

  // Tempo de máquina parada, deduplicado por máquina (intervalos de parada)
  const stops = db.prepare('SELECT * FROM machine_stops WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)').all(T, F)
    .filter((s) => machineOk(s.machine_id));
  let stoppedMin = 0;
  const stoppedByMachine = {};
  for (const s of stops) {
    const a = s.started_at < F ? F : s.started_at;
    const bRaw = s.ended_at || new Date().toISOString();
    const b = bRaw > T ? T : bRaw;
    const m = Math.max(0, mins(a, b));
    stoppedMin += m;
    stoppedByMachine[s.machine_id] = (stoppedByMachine[s.machine_id] || 0) + m;
  }

  // Preventivas no prazo: ciclos devidos no período (inclui atrasadas abertas no denominador; cancelamentos excluídos)
  const due = allWos.filter((w) => w.type === 'preventiva' && w.due_date && w.due_date >= F.slice(0, 10) && w.due_date <= T.slice(0, 10)
    && w.status !== 'Cancelada' && woPeopleOk(w));
  const dueEligible = due.filter((w) => w.status === 'Concluída' || w.due_date < todayStr);
  const onTime = dueEligible.filter((w) => w.status === 'Concluída' && w.closed_at.slice(0, 10) <= w.due_date);

  // Retrabalho: reaberturas marcadas como retrabalho / concluídas no período
  const reworkEvents = db.prepare(`SELECT e.* FROM wo_events e WHERE e.action='reabrir' AND e.local_time BETWEEN ? AND ?`).all(F, T)
    .filter((e) => { const w = allWos.find((x) => x.id === e.wo_id); return w && woPeopleOk(w) && JSON.parse(e.data_json || '{}').rework; });
  const reworkLinked = allWos.filter((w) => w.rework_of && w.created_at >= F && w.created_at <= T && woPeopleOk(w));
  const completedInPeriod = allWos.filter((w) => w.status === 'Concluída' && w.closed_at >= F && w.closed_at <= T && woPeopleOk(w));

  // Ocorrências por máquina
  const occ = {};
  const relevantCorretivas = allWos.filter((w) => w.type === 'corretiva' && woPeopleOk(w) && (
    (w.created_at >= F && w.created_at <= T) || 
    (w.status === 'Concluída' && w.closed_at >= F && w.closed_at <= T)
  ));
  for (const w of relevantCorretivas) occ[w.machine_id] = (occ[w.machine_id] || 0) + 1;
  const byMachine = Object.entries(occ).map(([mid, n]) => ({
    machineId: mid, code: mById[mid]?.code, name: mById[mid]?.name, sector: mById[mid]?.sector_name,
    corrective: n, stoppedMin: round(stoppedByMachine[mid] || 0, 0),
  })).sort((a, b) => b.corrective - a.corrective);

  // Trabalho por manutentor (soma de intervalos ativos individuais, recortados ao período) — sem ranking automático
  const techs = users.filter((u) => (u.role === 'manutentor') && peopleFilter(u.id));
  const people = techs.map((u) => {
    let workMin = 0;
    const wosTouched = new Set();
    for (const iv of intervals) {
      if (iv.user_id !== u.id) continue;
      const w = allWos.find((x) => x.id === iv.wo_id);
      if (!w) continue;
      const a = iv.started_at < F ? F : iv.started_at;
      const bRaw = iv.ended_at || new Date().toISOString();
      const b = bRaw > T ? T : bRaw;
      if (b <= a) continue;
      workMin += mins(a, b);
      wosTouched.add(iv.wo_id);
    }
    for (const w of inPeriod) {
      if (w.responsible_id === u.id || (partByWo[w.id] || []).some((p) => p.user_id === u.id)) {
        wosTouched.add(w.id);
      }
    }
    for (const w of completedInPeriod) {
      if (w.responsible_id === u.id || (partByWo[w.id] || []).some((p) => p.user_id === u.id)) {
        wosTouched.add(w.id);
      }
    }
    const asResp = completedInPeriod.filter((w) => w.responsible_id === u.id);
    const asCollab = completedInPeriod.filter((w) => w.responsible_id !== u.id && ((partByWo[w.id] || []).some((p) => p.user_id === u.id) || (ivByWo[w.id] || []).some((iv) => iv.user_id === u.id)));
    const prevDone = completedInPeriod.filter((w) => w.type === 'preventiva' && (w.responsible_id === u.id || (partByWo[w.id] || []).some((p) => p.user_id === u.id)));
    const reworkOnMine = reworkEvents.filter((e) => allWos.find((w) => w.id === e.wo_id)?.responsible_id === u.id).length;
    return {
      userId: u.id, name: u.name, team: u.team_id, specialty: u.specialty,
      workMin: round(workMin, 0), wosWorked: wosTouched.size,
      completedAsResponsible: asResp.length, completedAsCollaborator: asCollab.length,
      preventiveDone: prevDone.length, rework: reworkOnMine,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  const events = db.prepare('SELECT COUNT(*) n FROM wo_events WHERE local_time BETWEEN ? AND ?').get(F, T).n;
  const missingCause = correctiveDone.filter((w) => !w.cause).length;

  return {
    period: { from: F, to: T },
    current: {
      open: openNow.length, byStatus, overduePreventive: overdueNow.length,
      stoppedMachines: (q.userId ? stopsOpen.filter((s) => openNow.some((w) => w.machine_id === s.machine_id)) : stopsOpen).map((s) => ({ machineId: s.machine_id, code: mById[s.machine_id]?.code, name: mById[s.machine_id]?.name, since: s.started_at })),
    },
    responseTime: { avgMin: round(avg(responses)), n: responses.length },
    correctiveDuration: { avgMin: round(avg(durations)), n: durations.length },
    mttr: { avgMin: round(avg(repairs)), n: repairs.length },
    stoppedTime: { totalMin: round(stoppedMin, 0), intervals: stops.length },
    mtbf: { value: null, reason: 'Não calculado: requer calendário operacional ou medição de horas de funcionamento (não inferido pelo número de OS).' },
    availability: { value: null, reason: 'Não calculada: requer tempo operacional previsto (calendário/turnos da máquina).' },
    preventiveOnTime: { onTime: onTime.length, eligible: dueEligible.length, pct: dueEligible.length ? round((onTime.length / dueEligible.length) * 100, 0) : null },
    rework: { reopened: reworkEvents.length, linked: reworkLinked.length, completed: completedInPeriod.length,
      pct: completedInPeriod.length ? round(((reworkEvents.length + reworkLinked.length) / completedInPeriod.length) * 100, 0) : null },
    byMachine,
    people,
    dataQuality: { wosInPeriod: inPeriod.length, events, completed: completedInPeriod.length, missingCause,
      withoutStart: inPeriod.filter((w) => !(ivByWo[w.id]?.length)).length },
  };
}
