import xlsx from 'xlsx';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb } from '../server/db.js';

function norm(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function clean(val) {
  if (val === undefined || val === null) return '';
  return String(val).trim();
}

export function importMissingWorkOrders(db, excelFilePath) {
  const file = path.resolve(excelFilePath);
  const wb = xlsx.readFile(file);
  const sheet = wb.Sheets['Ordens de Serviço'];
  if (!sheet) {
    throw new Error('Aba "Ordens de Serviço" não encontrada na planilha.');
  }

  const allWos = xlsx.utils.sheet_to_json(sheet);
  console.log(`Planilha lida com sucesso: ${allWos.length} linhas encontradas.`);

  const existingWos = db.prepare('SELECT number FROM work_orders').all().map(r => clean(r.number));
  const existingSet = new Set(existingWos);

  const missingWos = allWos.filter(w => {
    const num = clean(w['Nº O.S.']);
    return num && !existingSet.has(num);
  });

  console.log(`Ordens de serviço ausentes no banco: ${missingWos.length}`);
  if (missingWos.length === 0) {
    console.log('Todas as OS da planilha já estão cadastradas no banco de dados!');
    return { importedCount: 0, missingCount: 0 };
  }

  // Setores existentes
  const sectors = db.prepare('SELECT id, name FROM sectors').all();
  const sectorsMap = new Map();
  for (const s of sectors) {
    sectorsMap.set(norm(s.name), s);
  }

  function getOrCreateSector(secName) {
    const cleanName = clean(secName) || 'GERAL';
    const key = norm(cleanName);
    if (sectorsMap.has(key)) return sectorsMap.get(key);

    const num = sectorsMap.size + 1;
    const id = 'sec-' + key.replace(/[^a-z0-9]/g, '-').slice(0, 15) + '-' + num;
    const code = 'S-' + cleanName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) + String(num).padStart(2, '0');
    const sec = { id, code, name: cleanName.toUpperCase() };
    sectorsMap.set(key, sec);
    db.prepare('INSERT INTO sectors (id, code, name) VALUES (?,?,?)').run(sec.id, sec.code, sec.name);
    return sec;
  }

  // Usuários existentes
  const users = db.prepare('SELECT id, name, role, username FROM users WHERE active=1').all();
  const usersMap = new Map();
  for (const u of users) {
    usersMap.set(norm(u.name), u);
    if (u.username) usersMap.set(norm(u.username), u);
    const firstName = norm(u.name.split(' ')[0]);
    if (!usersMap.has(firstName)) usersMap.set(firstName, u);
  }

  function getOrCreateRequester(reqName) {
    const cleanName = clean(reqName);
    if (!cleanName) return usersMap.get('gerente') || users[0];
    const key = norm(cleanName);
    if (usersMap.has(key)) return usersMap.get(key);

    // Tenta primeiro nome
    const firstName = norm(cleanName.split(' ')[0]);
    if (usersMap.has(firstName)) return usersMap.get(firstName);

    // Cria solicitante
    const num = usersMap.size + 1;
    const id = 'u-sol-' + key.replace(/[^a-z0-9]/g, '').slice(0, 15) + '-' + num;
    const username = key.replace(/[^a-z0-9]/g, '').slice(0, 15) || `solicitante${num}`;
    const userObj = { id, name: cleanName, role: 'solicitante', username };
    try {
      db.prepare("INSERT INTO users (id, name, role, username, active) VALUES (?, ?, 'solicitante', ?, 1)")
        .run(userObj.id, userObj.name, userObj.username);
      usersMap.set(key, userObj);
      return userObj;
    } catch (_) {
      return users[0];
    }
  }

  // Máquinas existentes
  const machines = db.prepare('SELECT id, code, name, sector_id FROM machines WHERE active=1').all();
  const machineLookup = new Map();
  const codeSet = new Set();
  let macSeq = machines.length + 1;

  for (const m of machines) {
    if (m.code) {
      machineLookup.set('tag:' + norm(m.code), m);
      codeSet.add(m.code.toUpperCase());
    }
    machineLookup.set('eq:' + norm(m.name) + '||' + m.sector_id, m);
  }

  function getOrCreateMachine(rawTag, eqName, sector) {
    const hasRealTag = rawTag && !['sem tag', 'sem numero', 'sem número', '0000', '0'].includes(norm(rawTag));
    const cleanEq = clean(eqName) || 'Equipamento Geral';

    if (hasRealTag && machineLookup.has('tag:' + norm(rawTag))) {
      return machineLookup.get('tag:' + norm(rawTag));
    }
    if (machineLookup.has('eq:' + norm(cleanEq) + '||' + sector.id)) {
      return machineLookup.get('eq:' + norm(cleanEq) + '||' + sector.id);
    }

    let code = hasRealTag ? rawTag.toUpperCase() : `EQ-${norm(sector.name).replace(/[^a-z0-9]/g, '').slice(0, 3).toUpperCase()}-${String(macSeq).padStart(3, '0')}`;
    if (codeSet.has(code.toUpperCase())) {
      code = `${code}-${macSeq}`;
    }
    codeSet.add(code.toUpperCase());

    const id = 'm-' + (macSeq++);
    const newMac = { id, code, name: cleanEq, sector_id: sector.id, criticality: 'media', active: 1 };
    db.prepare('INSERT INTO machines (id, code, name, sector_id, criticality, active) VALUES (?,?,?,?,?,1)')
      .run(newMac.id, newMac.code, newMac.name, newMac.sector_id, newMac.criticality);

    if (hasRealTag) machineLookup.set('tag:' + norm(rawTag), newMac);
    machineLookup.set('eq:' + norm(cleanEq) + '||' + sector.id, newMac);
    return newMac;
  }

  // Prepared statements
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

  db.exec('BEGIN TRANSACTION;');

  let importedCount = 0;
  for (const w of missingWos) {
    const num = clean(w['Nº O.S.']);
    const woId = 'wo-' + num;

    const sector = getOrCreateSector(w['Setor / Local']);
    const mac = getOrCreateMachine(clean(w.TAG), clean(w.Equipamento), sector);

    // Datas
    const rawDataAbertura = clean(w['Data de Abertura']);
    let createdDate = new Date().toISOString().slice(0, 10);
    if (rawDataAbertura.includes('/')) {
      const parts = rawDataAbertura.split('/');
      if (parts.length === 3) {
        createdDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      }
    } else if (rawDataAbertura.includes('-')) {
      createdDate = rawDataAbertura.slice(0, 10);
    }

    const horaInicio = clean(w['Hora Início']) || '08:00:00';
    const createdAtIso = `${createdDate}T${horaInicio.length === 5 ? horaInicio + ':00' : horaInicio}.000Z`;

    // Status
    let status = clean(w.Status);
    const normStat = norm(status);
    if (normStat === 'concluida') status = 'Concluída';
    else if (normStat === 'aguardando') status = 'Aguardando';
    else if (normStat === 'cancelada') status = 'Cancelada';
    else status = 'Aberta';

    // Situação e Parada
    const sit = clean(w['Situação do Equipamento']);
    const machineStopped = sit.toLowerCase().includes('parada') ? 1 : 0;
    const priority = machineStopped ? 'urgente' : (sit.toLowerCase().includes('restricao') || sit.toLowerCase().includes('restrição') ? 'alta' : 'media');

    // Tipo
    const rawType = clean(w['Tipo de Manutenção']);
    const type = norm(rawType).includes('programada') || norm(rawType).includes('preventiva') ? 'preventiva' : 'corretiva';

    // Solicitante
    const requester = getOrCreateRequester(clean(w.Solicitante));

    // Manutentores
    const techNamesRaw = clean(w['Manutentores Responsáveis']);
    const techTokens = techNamesRaw.split(',').map(x => clean(x)).filter(Boolean);
    const techObjs = [];
    for (const tk of techTokens) {
      const u = usersMap.get(norm(tk)) || usersMap.get(norm(tk.split(' ')[0]));
      if (u) techObjs.push(u);
    }
    const responsibleId = techObjs.length > 0 ? techObjs[0].id : null;

    // Datas de Conclusão / Previsão
    let dataInicio = clean(w['Data Início Reparo']) || createdDate;
    if (dataInicio.includes('/')) dataInicio = dataInicio.split('/').reverse().join('-');
    const startAtIso = `${dataInicio}T${horaInicio.length === 5 ? horaInicio + ':00' : horaInicio}.000Z`;

    let closedAtIso = null;
    if (status === 'Concluída') {
      let dataFim = clean(w['Data Conclusão / Previsão']) || dataInicio;
      if (dataFim.includes('/')) dataFim = dataFim.split('/').reverse().join('-');
      const horaFim = clean(w['Hora Conclusão']) || '17:00:00';
      closedAtIso = `${dataFim}T${horaFim.length === 5 ? horaFim + ':00' : horaFim}.000Z`;
    }

    const problemDesc = clean(w['Descrição do Problema']) || clean(w['Serviços Executados']) || `Manutenção ${mac.name}`;
    const servDone = clean(w['Serviços Executados']) || null;
    const cause = clean(w['Possíveis Causas']) || null;
    const solution = servDone;
    const matUsed = clean(w['Peças / Materiais Utilizados']) || null;
    const toolsUsed = clean(w['Ferramentas Utilizadas']) || null;
    const notes = clean(w['Observações Gerais']) || null;
    const specialty = clean(w.Especialidade) || null;
    const title = `${specialty ? `[${specialty}] ` : ''}${mac.name}: ${problemDesc.slice(0, 50).trim()}`;

    insWo.run(
      woId, num, mac.id, type, priority, machineStopped,
      requester.id, responsibleId, status, title, problemDesc,
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
    insEvent.run(randomUUID(), woId, requester.id, 'criar', 'Criação da OS (Planilha)', createdAtIso, createdAtIso);
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

    importedCount++;
  }

  db.exec('COMMIT;');
  console.log(`✅ Sucesso: ${importedCount} novas Ordens de Serviço foram inseridas no banco de dados!`);
  return { importedCount, missingCount: missingWos.length };
}

// Execução direta via terminal
if (process.argv[1] && process.argv[1].endsWith('import_missing_wos.js')) {
  const db = openDb();
  const filePath = process.argv[2] || 'Relatorio_Geral_Manutencao_Rufato_2026-10-21.xlsx';
  importMissingWorkOrders(db, filePath);
}
