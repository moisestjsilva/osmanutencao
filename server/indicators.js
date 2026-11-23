import { calcOperatingStoppedMinutes } from './business-hours.js';

const MIN = 60000;
const mins = (a, b) => (new Date(b) - new Date(a)) / MIN;
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const pctDelta = (cur, prev) => {
  if (prev == null || prev === 0) return cur > 0 ? 100 : 0;
  return round(((cur - prev) / prev) * 100, 1);
};

const MONTH_NAMES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59));
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    fromDate: start.toISOString().slice(0, 10),
    toDate: end.toISOString().slice(0, 10),
  };
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]}/${String(y).slice(-2)}`;
}

export function computeIndicators(db, q = {}) {
  const now = new Date();
  let from;
  let to;
  let prevFrom;
  let prevTo;
  let periodLabel = '';
  let selectedMonth = null;

  if (q.month && /^\d{4}-\d{2}$/.test(q.month)) {
    selectedMonth = q.month;
    const cur = monthBounds(q.month);
    const prev = monthBounds(shiftMonth(q.month, -1));
    from = new Date(cur.from);
    to = new Date(cur.to);
    prevFrom = new Date(prev.from);
    prevTo = new Date(prev.to);
    periodLabel = monthLabel(q.month);
  } else {
    to = q.to ? new Date(q.to + 'T23:59:59') : now;
    if (q.from === 'tudo' || q.from === 'all') {
      from = new Date('2020-01-01T00:00:00');
      prevFrom = null;
      prevTo = null;
    } else if (q.from) {
      from = new Date(q.from + 'T00:00:00');
      const span = Math.max(86400000, to.getTime() - from.getTime());
      prevTo = new Date(from.getTime() - 1000);
      prevFrom = new Date(prevTo.getTime() - span);
    } else {
      from = new Date(to.getTime() - 30 * 24 * 60 * MIN);
      const span = to.getTime() - from.getTime();
      prevTo = new Date(from.getTime() - 1000);
      prevFrom = new Date(prevTo.getTime() - span);
    }
  }

  const F = from.toISOString();
  const T = to.toISOString();
  const PF = prevFrom ? prevFrom.toISOString() : null;
  const PT = prevTo ? prevTo.toISOString() : null;

  // Identifica máquinas da Frota para excluí-las 100% dos indicadores do Maquinário (Fábrica)
  let fleetMachineIds = new Set();
  let fleetPlates = new Set();
  try {
    const fv = db.prepare('SELECT machine_id, plate FROM fleet_vehicles').all();
    fleetMachineIds = new Set(fv.map((v) => v.machine_id).filter(Boolean));
    fleetPlates = new Set(fv.map((v) => String(v.plate || '').toUpperCase()).filter(Boolean));
  } catch (_) {}

  const allMachinesRaw = db.prepare(`
    SELECT m.*, s.name sector_name, s.code sector_code
    FROM machines m
    JOIN sectors s ON s.id = m.sector_id
  `).all();

  const isFleetMachineRow = (m) => {
    if (!m) return false;
    if (fleetMachineIds.has(m.id)) return true;
    if (fleetPlates.has(String(m.code || '').toUpperCase())) return true;
    if (String(m.sector_name || '').toUpperCase() === 'FROTA') return true;
    if (String(m.sector_code || '').toUpperCase() === 'S-FROTA') return true;
    return false;
  };

  // Somente máquinas industriais (Fábrica)
  const machines = allMachinesRaw.filter((m) => !isFleetMachineRow(m));
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
  const woById = Object.fromEntries(allWos.map((w) => [w.id, w]));
  const intervals = db.prepare('SELECT * FROM work_intervals').all().filter((iv) => Boolean(woById[iv.wo_id]));
  const ivByWo = {};
  for (const iv of intervals) (ivByWo[iv.wo_id] ||= []).push(iv);

  const peopleFilter = (uid) => {
    const u = uById[uid];
    if (!u || !(u.role === 'manutentor' || u.role === 'gerente')) return false;
    if (q.userId && uid !== q.userId) return false;
    if (q.teamId && u.team_id !== q.teamId) return false;
    return true;
  };
  const hasPeopleFilter = !!(q.userId || q.teamId);
  const parts = db.prepare('SELECT * FROM wo_participants').all().filter((p) => Boolean(woById[p.wo_id]));
  const partByWo = {};
  for (const p of parts) (partByWo[p.wo_id] ||= []).push(p);
  const woPeopleOk = (w) => !hasPeopleFilter ||
    (partByWo[w.id] || []).some((p) => peopleFilter(p.user_id)) ||
    peopleFilter(w.responsible_id) ||
    (ivByWo[w.id] || []).some((iv) => peopleFilter(iv.user_id));

  const filteredWos = allWos.filter(woPeopleOk);
  const inPeriod = filteredWos.filter((w) => w.created_at >= F && w.created_at <= T);
  const completedInPeriod = filteredWos.filter((w) => w.status === 'Concluída' && w.closed_at && w.closed_at >= F && w.closed_at <= T);
  const todayStr = now.toISOString().slice(0, 10);

  // Período anterior (para comparativo)
  const prevInPeriod = PF ? filteredWos.filter((w) => w.created_at >= PF && w.created_at <= PT) : [];
  const prevCompletedInPeriod = PF ? filteredWos.filter((w) => w.status === 'Concluída' && w.closed_at && w.closed_at >= PF && w.closed_at <= PT) : [];

  // Situação atual (apenas maquinário da fábrica)
  const openNow = filteredWos.filter((w) => !['Concluída', 'Cancelada'].includes(w.status));
  const overdueNow = openNow.filter((w) => w.type === 'preventiva' && w.due_date && w.due_date < todayStr);
  const stopsOpen = db.prepare('SELECT * FROM machine_stops WHERE ended_at IS NULL').all().filter((s) => machineOk(s.machine_id));
  const byStatus = {};
  for (const w of openNow) byStatus[w.status] = (byStatus[w.status] || 0) + 1;

  const calcPeriodTimes = (wosList, startIso, endIso) => {
    const resp = [];
    for (const w of wosList) {
      const ivs = ivByWo[w.id];
      if (!ivs?.length) continue;
      const first = ivs.map((i) => i.started_at).sort()[0];
      const r = mins(w.created_at, first);
      if (r >= 0) resp.push(r);
    }
    const corrDone = wosList.filter((w) => w.type === 'corretiva' && w.status === 'Concluída' && w.closed_at);
    const durs = corrDone.map((w) => mins(w.created_at, w.closed_at)).filter((x) => x >= 0);
    const reps = corrDone.filter((w) => w.machine_stopped && w.returned_at).map((w) => {
      const opHours = mById[w.machine_id]?.operating_hours_per_day || 8;
      return calcOperatingStoppedMinutes(w.created_at, w.returned_at, opHours);
    }).filter((x) => x >= 0);

    const stops = db.prepare('SELECT * FROM machine_stops WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)').all(endIso, startIso)
      .filter((s) => machineOk(s.machine_id));
    let totalStoppedMin = 0;
    let totalStopCost = 0;
    const stoppedByMachine = {};
    for (const s of stops) {
      const a = s.started_at < startIso ? startIso : s.started_at;
      const bRaw = s.ended_at || now.toISOString();
      const b = bRaw > endIso ? endIso : bRaw;
      if (b <= a) continue;
      const mObj = mById[s.machine_id];
      const opHours = mObj?.operating_hours_per_day || 8;
      const m = calcOperatingStoppedMinutes(a, b, opHours);
      totalStoppedMin += m;
      stoppedByMachine[s.machine_id] = (stoppedByMachine[s.machine_id] || 0) + m;
      const hc = Number(mObj?.hourly_cost || 0);
      if (hc > 0) totalStopCost += (m / 60) * hc;
    }

    return {
      responses: resp,
      durations: durs,
      repairs: reps,
      correctiveDone: corrDone,
      stops,
      stoppedMin: totalStoppedMin,
      stopCost: round(totalStopCost, 2),
      stoppedByMachine,
    };
  };

  const curTimes = calcPeriodTimes(inPeriod, F, T);
  const prevTimes = PF ? calcPeriodTimes(prevInPeriod, PF, PT) : null;

  // Preventivas no prazo
  const due = filteredWos.filter((w) => w.type === 'preventiva' && w.due_date && w.due_date >= F.slice(0, 10) && w.due_date <= T.slice(0, 10) && w.status !== 'Cancelada');
  const dueEligible = due.filter((w) => w.status === 'Concluída' || w.due_date < todayStr);
  const onTime = dueEligible.filter((w) => w.status === 'Concluída' && w.closed_at && w.closed_at.slice(0, 10) <= w.due_date);

  // Retrabalho (apenas OS de maquinário)
  const reworkEvents = db.prepare(`SELECT e.* FROM wo_events e WHERE e.action='reabrir' AND e.local_time BETWEEN ? AND ?`).all(F, T)
    .filter((e) => {
      const w = woById[e.wo_id];
      if (!w || !woPeopleOk(w)) return false;
      try { return !!JSON.parse(e.data_json || '{}').rework; } catch { return false; }
    });
  const reworkLinked = inPeriod.filter((w) => w.rework_of);

  // Distribuição por prioridade e tipo no período
  const byPriority = { urgente: 0, alta: 0, media: 0, baixa: 0 };
  let correctiveCount = 0;
  let preventiveCount = 0;
  for (const w of inPeriod) {
    if (w.type === 'preventiva') preventiveCount++;
    else correctiveCount++;
    const p = String(w.priority || 'media').toLowerCase();
    if (byPriority[p] !== undefined) byPriority[p]++;
  }

  // Ocorrências por máquina
  const occ = {};
  const prevByMachine = {};
  const openByMachine = {};
  for (const w of openNow) openByMachine[w.machine_id] = (openByMachine[w.machine_id] || 0) + 1;
  for (const w of inPeriod) {
    if (w.type === 'preventiva') prevByMachine[w.machine_id] = (prevByMachine[w.machine_id] || 0) + 1;
    else occ[w.machine_id] = (occ[w.machine_id] || 0) + 1;
  }
  const touchedMachineIds = new Set([...Object.keys(occ), ...Object.keys(curTimes.stoppedByMachine)]);
  const byMachine = [...touchedMachineIds].map((mid) => {
    const m = mById[mid];
    const stMin = round(curTimes.stoppedByMachine[mid] || 0, 0);
    const hc = Number(m?.hourly_cost || 0);
    return {
      machineId: mid,
      code: m?.code,
      name: m?.name,
      sector: m?.sector_name,
      corrective: occ[mid] || 0,
      preventive: prevByMachine[mid] || 0,
      openNow: openByMachine[mid] || 0,
      stoppedMin: stMin,
      stopCost: round((stMin / 60) * hc, 2),
    };
  }).sort((a, b) => (b.stoppedMin - a.stoppedMin) || (b.corrective - a.corrective));

  // Distribuição por setor
  const sectorMap = {};
  for (const w of inPeriod) {
    const m = mById[w.machine_id];
    if (!m) continue;
    const s = (sectorMap[m.sector_id] ||= { sectorId: m.sector_id, sector: m.sector_name || 'Geral', total: 0, corrective: 0, preventive: 0, stoppedMin: 0, stopCost: 0 });
    s.total++;
    if (w.type === 'preventiva') s.preventive++;
    else s.corrective++;
  }
  for (const [mid, stMin] of Object.entries(curTimes.stoppedByMachine)) {
    const m = mById[mid];
    if (!m) continue;
    const s = (sectorMap[m.sector_id] ||= { sectorId: m.sector_id, sector: m.sector_name || 'Geral', total: 0, corrective: 0, preventive: 0, stoppedMin: 0, stopCost: 0 });
    s.stoppedMin += stMin;
    s.stopCost += (stMin / 60) * Number(m.hourly_cost || 0);
  }
  const bySector = Object.values(sectorMap)
    .map((s) => ({ ...s, stoppedMin: round(s.stoppedMin, 0), stopCost: round(s.stopCost, 2) }))
    .sort((a, b) => (b.total - a.total) || (b.stoppedMin - a.stoppedMin));

  // Evolução mensal (últimos 6 meses terminando no mês selecionado ou mês atual)
  const anchorYm = selectedMonth || `${to.getUTCFullYear()}-${String(to.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthlyTrend = [];
  for (let i = 5; i >= 0; i--) {
    const ym = shiftMonth(anchorYm, -i);
    const mb = monthBounds(ym);
    const mOpened = filteredWos.filter((w) => w.created_at >= mb.from && w.created_at <= mb.to);
    const mCompleted = filteredWos.filter((w) => w.status === 'Concluída' && w.closed_at && w.closed_at >= mb.from && w.closed_at <= mb.to);
    const mStops = db.prepare('SELECT * FROM machine_stops WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)').all(mb.to, mb.from)
      .filter((s) => machineOk(s.machine_id));
    let mStopMin = 0;
    let mStopCost = 0;
    for (const s of mStops) {
      const a = s.started_at < mb.from ? mb.from : s.started_at;
      const bRaw = s.ended_at || now.toISOString();
      const b = bRaw > mb.to ? mb.to : bRaw;
      if (b <= a) continue;
      const mObj = mById[s.machine_id];
      const mm = calcOperatingStoppedMinutes(a, b, mObj?.operating_hours_per_day || 8);
      mStopMin += mm;
      mStopCost += (mm / 60) * Number(mObj?.hourly_cost || 0);
    }
    monthlyTrend.push({
      month: ym,
      label: monthLabel(ym),
      opened: mOpened.length,
      completed: mCompleted.length,
      corrective: mOpened.filter((w) => w.type !== 'preventiva').length,
      preventive: mOpened.filter((w) => w.type === 'preventiva').length,
      stoppedHours: round(mStopMin / 60, 1),
      stopCost: round(mStopCost, 2),
    });
  }

  // Principais causas raiz no período
  const causeCounts = {};
  for (const w of inPeriod) {
    if (w.cause && w.cause.trim()) {
      const c = w.cause.trim().replace(/\s+/g, ' ');
      const key = c.charAt(0).toUpperCase() + c.slice(1);
      causeCounts[key] = (causeCounts[key] || 0) + 1;
    }
  }
  const topCauses = Object.entries(causeCounts)
    .map(([cause, count]) => ({ cause, count, pct: round((count / Math.max(1, inPeriod.length)) * 100, 1) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Equipe de manutenção (somente horas e OS do maquinário da fábrica)
  const techs = users.filter((u) => u.role === 'manutentor' && u.active !== 0 && peopleFilter(u.id));
  const people = techs.map((u) => {
    let workMin = 0;
    const wosTouched = new Set();
    for (const iv of intervals) {
      if (iv.user_id !== u.id) continue;
      const w = woById[iv.wo_id];
      if (!w) continue;
      const a = iv.started_at < F ? F : iv.started_at;
      const bRaw = iv.ended_at || now.toISOString();
      const b = bRaw > T ? T : bRaw;
      if (b <= a) continue;
      workMin += mins(a, b);
      wosTouched.add(iv.wo_id);
    }
    for (const w of inPeriod) {
      if (w.responsible_id === u.id || (partByWo[w.id] || []).some((p) => p.user_id === u.id)) wosTouched.add(w.id);
    }
    for (const w of completedInPeriod) {
      if (w.responsible_id === u.id || (partByWo[w.id] || []).some((p) => p.user_id === u.id)) wosTouched.add(w.id);
    }
    const asResp = completedInPeriod.filter((w) => w.responsible_id === u.id);
    const asCollab = completedInPeriod.filter((w) => w.responsible_id !== u.id && ((partByWo[w.id] || []).some((p) => p.user_id === u.id) || (ivByWo[w.id] || []).some((iv) => iv.user_id === u.id)));
    const prevDone = completedInPeriod.filter((w) => w.type === 'preventiva' && (w.responsible_id === u.id || (partByWo[w.id] || []).some((p) => p.user_id === u.id)));
    const reworkOnMine = reworkEvents.filter((e) => woById[e.wo_id]?.responsible_id === u.id).length;
    const totalCompleted = asResp.length + asCollab.length;
    return {
      userId: u.id,
      name: u.name,
      team: u.team_id,
      specialty: u.specialty,
      avatar_url: u.avatar_url || null,
      workMin: round(workMin, 0),
      wosWorked: wosTouched.size,
      completedAsResponsible: asResp.length,
      completedAsCollaborator: asCollab.length,
      totalCompleted,
      preventiveDone: prevDone.length,
      rework: reworkOnMine,
    };
  }).sort((a, b) => (b.totalCompleted - a.totalCompleted) || (b.workMin - a.workMin) || a.name.localeCompare(b.name, 'pt-BR'));

  const missingCause = curTimes.correctiveDone.filter((w) => !w.cause || !w.cause.trim()).length;
  const withoutStart = inPeriod.filter((w) => !(ivByWo[w.id]?.length)).length;
  const factoryWoIds = new Set(allWos.map((w) => w.id));
  const events = db.prepare('SELECT wo_id FROM wo_events WHERE local_time BETWEEN ? AND ?').all(F, T)
    .filter((e) => factoryWoIds.has(e.wo_id)).length;

  // Insights Automáticos para Tomada de Decisão
  const insights = [];
  if (stopsOpen.length > 0) {
    insights.push({
      level: 'danger',
      title: `${stopsOpen.length} máquina(s) parada(s) neste momento`,
      detail: `Equipamentos parados agora: ${stopsOpen.map((s) => mById[s.machine_id]?.code || s.machine_id).join(', ')}. Priorize a liberação imediata.`,
    });
  }
  const topMachine = byMachine[0];
  if (topMachine && (topMachine.stoppedMin > 0 || topMachine.corrective >= 3)) {
    const sharePct = curTimes.stoppedMin > 0 ? round((topMachine.stoppedMin / curTimes.stoppedMin) * 100, 0) : null;
    insights.push({
      level: 'warn',
      title: `Gargalo do período: ${topMachine.code} (${topMachine.name})`,
      detail: `${topMachine.corrective} corretiva(s)${topMachine.stoppedMin > 0 ? ` e ${round(topMachine.stoppedMin / 60, 1)}h parada (${sharePct}% do tempo parado da fábrica)` : ''}${topMachine.stopCost > 0 ? ` — custo est. R$ ${topMachine.stopCost.toFixed(2)}` : ''}. Avaliar plano preventivo ou revisão geral.`,
      machineId: topMachine.machineId,
    });
  }
  const backlogDelta = inPeriod.length - completedInPeriod.length;
  if (inPeriod.length > 0) {
    if (backlogDelta > 3) {
      insights.push({
        level: 'warn',
        title: `Fila de OS cresceu (+${backlogDelta} OS no período)`,
        detail: `Foram abertas ${inPeriod.length} OS e concluídas ${completedInPeriod.length} (${round((completedInPeriod.length / inPeriod.length) * 100, 0)}% de vazão). Verifique gargalos de peças ou alocação da equipe.`,
      });
    } else if (completedInPeriod.length >= inPeriod.length) {
      insights.push({
        level: 'ok',
        title: `Equipe venceu a demanda do período`,
        detail: `${completedInPeriod.length} OS concluídas frente a ${inPeriod.length} abertas — backlog sob controle.`,
      });
    }
  }
  const prevRatio = inPeriod.length ? round((preventiveCount / inPeriod.length) * 100, 0) : null;
  if (inPeriod.length >= 5 && prevRatio != null && prevRatio < 20) {
    insights.push({
      level: 'info',
      title: `Manutenção altamente reativa (${100 - prevRatio}% corretivas)`,
      detail: `Apenas ${preventiveCount} preventiva(s) contra ${correctiveCount} corretiva(s). Ampliar preventivas nas 5 máquinas críticas tende a reduzir paradas inesperadas.`,
    });
  }
  if (overdueNow.length > 0) {
    insights.push({
      level: 'danger',
      title: `${overdueNow.length} preventiva(s) atrasada(s) em aberto`,
      detail: `Reprograme ou conclua as preventivas vencidas para evitar falhas corretivas em cascata.`,
    });
  }
  if (curTimes.correctiveDone.length >= 5 && missingCause / curTimes.correctiveDone.length > 0.4) {
    insights.push({
      level: 'info',
      title: `${missingCause} de ${curTimes.correctiveDone.length} corretivas sem causa raiz`,
      detail: `Preencher a causa raiz ao concluir a OS ajuda a identificar falhas repetitivas e reduzir custos de manutenção.`,
    });
  }

  // Dossiê da máquina selecionada (mantido e enriquecido)
  let machineDetail = null;
  if (q.machineId && mById[q.machineId]) {
    const m = mById[q.machineId];
    const allMachineWos = db.prepare(`
      SELECT w.*, u_req.name as requester_name, u_resp.name as responsible_name
      FROM work_orders w
      LEFT JOIN users u_req ON u_req.id = w.requester_id
      LEFT JOIN users u_resp ON u_resp.id = w.responsible_id
      WHERE w.machine_id = ?
      ORDER BY w.created_at DESC
    `).all(q.machineId);

    const wosInSelectedPeriod = allMachineWos.filter((w) => (
      (w.created_at >= F && w.created_at <= T) ||
      (w.closed_at && w.closed_at >= F && w.closed_at <= T)
    ));
    const corrWos = wosInSelectedPeriod.filter((w) => w.type === 'corretiva');
    const prevWos = wosInSelectedPeriod.filter((w) => w.type === 'preventiva');
    const stoppedWos = wosInSelectedPeriod.filter((w) => w.machine_stopped);
    const stoppedMinVal = round(curTimes.stoppedByMachine[m.id] || 0, 0);
    const hourlyCost = Number(m.hourly_cost || 0);
    const stoppedCost = round(((stoppedMinVal / 60) * hourlyCost), 2);

    const statusCounts = {};
    const specialtyCounts = {};
    const problemCounts = {};
    const mCauseCounts = {};
    for (const w of wosInSelectedPeriod) {
      statusCounts[w.status] = (statusCounts[w.status] || 0) + 1;
      const spec = w.specialty ? w.specialty.trim() : 'Geral';
      specialtyCounts[spec] = (specialtyCounts[spec] || 0) + 1;
      const raw = (w.description || w.title || '').trim();
      if (raw) {
        const clean = raw.replace(/\s+/g, ' ');
        const key = clean.charAt(0).toUpperCase() + clean.slice(1);
        problemCounts[key] = (problemCounts[key] || 0) + 1;
      }
      if (w.cause && w.cause.trim()) {
        const c = w.cause.trim().replace(/\s+/g, ' ');
        const key = c.charAt(0).toUpperCase() + c.slice(1);
        mCauseCounts[key] = (mCauseCounts[key] || 0) + 1;
      }
    }

    const topProblems = Object.entries(problemCounts)
      .map(([problem, count]) => ({ problem, count, pct: round((count / Math.max(1, wosInSelectedPeriod.length)) * 100, 1) }))
      .sort((a, b) => b.count - a.count).slice(0, 15);
    const mTopCauses = Object.entries(mCauseCounts)
      .map(([cause, count]) => ({ cause, count, pct: round((count / Math.max(1, wosInSelectedPeriod.length)) * 100, 1) }))
      .sort((a, b) => b.count - a.count).slice(0, 10);

    const wosList = wosInSelectedPeriod.map((w) => {
      const ivs = ivByWo[w.id] || [];
      let totalWorkMinutes = 0;
      for (const iv of ivs) if (iv.started_at && iv.ended_at) totalWorkMinutes += mins(iv.started_at, iv.ended_at);
      return {
        id: w.id, number: w.number, type: w.type, priority: w.priority, status: w.status,
        machineStopped: !!w.machine_stopped, title: w.title, description: w.description,
        specialty: w.specialty, cause: w.cause, solution: w.solution, serviceDone: w.service_done,
        materialsUsed: w.materials_used, toolsUsed: w.tools_used, notes: w.notes,
        requesterName: w.requester_name, responsibleName: w.responsible_name,
        createdAt: w.created_at, closedAt: w.closed_at, returnedAt: w.returned_at,
        workMin: round(totalWorkMinutes, 0),
        durationMin: w.closed_at ? round(mins(w.created_at, w.closed_at), 0) : null,
      };
    });

    machineDetail = {
      machine: {
        id: m.id, code: m.code, name: m.name, sectorId: m.sector_id, sectorName: m.sector_name,
        criticality: m.criticality, hourlyCost, operatingHoursPerDay: m.operating_hours_per_day || 8,
        imageUrl: m.image_url || null,
      },
      stats: {
        totalWos: wosInSelectedPeriod.length, lifetimeWos: allMachineWos.length,
        corrective: corrWos.length, preventive: prevWos.length, withStop: stoppedWos.length,
        stoppedMin: stoppedMinVal, stoppedCost,
        openNow: allMachineWos.filter((w) => !['Concluída', 'Cancelada'].includes(w.status)).length,
      },
      statusCounts, specialtyCounts, topProblems, topCauses: mTopCauses, wos: wosList,
    };
  }

  return {
    scope: 'fabrica',
    period: { from: F, to: T, month: selectedMonth, label: periodLabel },
    summary: {
      opened: inPeriod.length,
      prevOpened: prevTimes ? prevInPeriod.length : null,
      openedDeltaPct: prevTimes ? pctDelta(inPeriod.length, prevInPeriod.length) : null,
      completed: completedInPeriod.length,
      prevCompleted: prevTimes ? prevCompletedInPeriod.length : null,
      completedDeltaPct: prevTimes ? pctDelta(completedInPeriod.length, prevCompletedInPeriod.length) : null,
      backlogDelta,
      completionRatePct: inPeriod.length ? round((completedInPeriod.length / inPeriod.length) * 100, 0) : null,
      correctiveCount,
      preventiveCount,
      preventiveRatioPct: prevRatio,
      stoppedMin: round(curTimes.stoppedMin, 0),
      prevStoppedMin: prevTimes ? round(prevTimes.stoppedMin, 0) : null,
      stoppedDeltaPct: prevTimes ? pctDelta(curTimes.stoppedMin, prevTimes.stoppedMin) : null,
      estimatedStopCost: curTimes.stopCost,
      avgResponseMin: round(avg(curTimes.responses)),
      prevAvgResponseMin: prevTimes ? round(avg(prevTimes.responses)) : null,
      avgMttrMin: round(avg(curTimes.repairs)),
      prevAvgMttrMin: prevTimes ? round(avg(prevTimes.repairs)) : null,
    },
    current: {
      open: openNow.length,
      byStatus,
      overduePreventive: overdueNow.length,
      stoppedMachines: (q.userId ? stopsOpen.filter((s) => openNow.some((w) => w.machine_id === s.machine_id)) : stopsOpen)
        .map((s) => ({ machineId: s.machine_id, code: mById[s.machine_id]?.code, name: mById[s.machine_id]?.name, since: s.started_at })),
    },
    responseTime: { avgMin: round(avg(curTimes.responses)), n: curTimes.responses.length },
    correctiveDuration: { avgMin: round(avg(curTimes.durations)), n: curTimes.durations.length },
    mttr: { avgMin: round(avg(curTimes.repairs)), n: curTimes.repairs.length },
    stoppedTime: { totalMin: round(curTimes.stoppedMin, 0), intervals: curTimes.stops.length, estimatedCost: curTimes.stopCost },
    preventiveOnTime: { onTime: onTime.length, eligible: dueEligible.length, pct: dueEligible.length ? round((onTime.length / dueEligible.length) * 100, 0) : null },
    rework: {
      reopened: reworkEvents.length,
      linked: reworkLinked.length,
      completed: completedInPeriod.length,
      pct: completedInPeriod.length ? round(((reworkEvents.length + reworkLinked.length) / completedInPeriod.length) * 100, 0) : null,
    },
    byPriority,
    bySector,
    monthlyTrend,
    topCauses,
    byMachine,
    people,
    insights,
    machineDetail,
    dataQuality: { wosInPeriod: inPeriod.length, events, completed: completedInPeriod.length, missingCause, withoutStart },
  };
}
