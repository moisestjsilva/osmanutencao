import xlsx from 'xlsx';
import path from 'node:path';

const file = path.resolve('Relatorio_Geral_Manutencao_Rufato_2026-10-06.xlsx');
const wb = xlsx.readFile(file);

const wosRaw = xlsx.utils.sheet_to_json(wb.Sheets['Ordens de Serviço']);
const machinesRaw = xlsx.utils.sheet_to_json(wb.Sheets['Maquinário e TAGs']);
const techsRaw = xlsx.utils.sheet_to_json(wb.Sheets['Manutentores']);

console.log(`Planilha lida: ${wosRaw.length} OS, ${machinesRaw.length} Máquinas, ${techsRaw.length} Manutentores.`);

function norm(str) {
  return String(str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function clean(str) {
  return String(str || '').trim();
}

// 1. SETORES
const sectorsMap = new Map(); // nameUpper -> { id, code, name }
function getOrCreateSector(name) {
  const cleanName = clean(name) || 'GERAL';
  const upper = cleanName.toUpperCase();
  if (sectorsMap.has(upper)) return sectorsMap.get(upper);

  const id = 'sec-' + norm(upper).replace(/[^a-z0-9]/g, '-').slice(0, 15) + '-' + (sectorsMap.size + 1);
  const code = 'S-' + upper.replace(/[^A-Z0-9]/g, '').slice(0, 6) + (sectorsMap.size + 1);
  const sec = { id, code, name: upper };
  sectorsMap.set(upper, sec);
  return sec;
}

// Extrair setores de máquinas e de OS
for (const m of machinesRaw) getOrCreateSector(m.Setor);
for (const w of wosRaw) getOrCreateSector(w['Setor / Local']);

console.log(`Total de Setores identificados: ${sectorsMap.size}`);

// 2. EQUIPES
// Criar equipes padrão: Elétrica, Mecânica, Geral
const teams = [
  { id: 'team-ele', name: 'Elétrica' },
  { id: 'team-mec', name: 'Mecânica' },
  { id: 'team-geral', name: 'Geral' }
];

// 3. USUÁRIOS (Manutentores, Solicitantes, Gerente)
const usersMap = new Map(); // norm(name) -> userObj

// Manutentores
for (const t of techsRaw) {
  const name = clean(t['Nome do Manutentor']);
  if (!name || norm(name) === 'teste') continue;
  const key = norm(name);
  if (!usersMap.has(key)) {
    const id = 'u-tech-' + norm(name).replace(/[^a-z0-9]/g, '');
    usersMap.set(key, {
      id,
      name,
      role: 'manutentor',
      team_id: 'team-mec', // default, can adjust by specialty
      specialty: 'Mecânica / Elétrica',
      active: 1
    });
  }
}

// Solicitantes das OS
for (const w of wosRaw) {
  const req = clean(w.Solicitante);
  if (!req) continue;
  const key = norm(req);
  if (!usersMap.has(key)) {
    const isTech = usersMap.has(norm(req.replace(/\/.*$/, '')));
    const id = 'u-sol-' + norm(req).replace(/[^a-z0-9]/g, '').slice(0, 20) + '-' + (usersMap.size + 1);
    usersMap.set(key, {
      id,
      name: req,
      role: isTech ? 'manutentor' : 'solicitante',
      team_id: null,
      specialty: null,
      active: 1
    });
  }
}

// Gerente de Manutenção
usersMap.set('gerente', {
  id: 'u-gerente',
  name: 'Gisele Ramos (Gerente)',
  role: 'gerente',
  team_id: null,
  specialty: 'Gestão de Manutenção',
  active: 1
});

console.log(`Total de Usuários cadastrados: ${usersMap.size}`);

// 4. MÁQUINAS
const machinesList = [];
const machineLookup = new Map(); // tag -> machine, 'eq:norm(name)||sector' -> machine

let machineSeq = 1;
for (const m of machinesRaw) {
  const rawTag = clean(m.TAG);
  const hasRealTag = rawTag && !['sem tag', 'sem numero', 'sem número'].includes(norm(rawTag));
  const eqName = clean(m.Equipamento) || 'Equipamento Indefinido';
  const sector = getOrCreateSector(m.Setor);

  // Código único da máquina para QR code: se tem TAG real, usa a TAG; se não, gera código legível
  const code = hasRealTag ? rawTag : `EQ-${norm(sector.name).slice(0, 3).toUpperCase()}-${String(machineSeq).padStart(3, '0')}`;
  const id = 'm-' + (hasRealTag ? 'tag-' + norm(rawTag) : 'eq-' + machineSeq);
  machineSeq++;

  const crit = (m['Paradas Críticas (Máq. Parada)'] > 20) ? 'alta' : (m['Total de O.S.'] > 10 ? 'media' : 'baixa');

  const machineObj = {
    id,
    code,
    name: eqName,
    sector_id: sector.id,
    criticality: crit,
    active: 1,
    tag: hasRealTag ? rawTag : null
  };

  machinesList.push(machineObj);
  if (hasRealTag) {
    machineLookup.set('tag:' + norm(rawTag), machineObj);
  }
  machineLookup.set('eq:' + norm(eqName) + '||' + sector.id, machineObj);
}

// Verificar máquinas que só existem nas OS
let extraMachines = 0;
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
    const code = hasRealTag ? rawTag : `EQ-${norm(sector.name).slice(0, 3).toUpperCase()}-${String(machineSeq).padStart(3, '0')}`;
    const id = 'm-' + (hasRealTag ? 'tag-' + norm(rawTag) : 'eq-' + machineSeq);
    machineSeq++;
    extraMachines++;

    const newMachine = {
      id,
      code,
      name: eqName,
      sector_id: sector.id,
      criticality: 'media',
      active: 1,
      tag: hasRealTag ? rawTag : null
    };

    machinesList.push(newMachine);
    if (hasRealTag) machineLookup.set('tag:' + norm(rawTag), newMachine);
    machineLookup.set('eq:' + norm(eqName) + '||' + sector.id, newMachine);
  }
}

console.log(`Total de Máquinas registradas: ${machinesList.length} (${machinesRaw.length} da planilha + ${extraMachines} das OS)`);

// 5. TESTAR CONVERSÃO DE TODAS AS 1000 OS
let validWos = 0;
let errors = [];

for (const w of wosRaw) {
  const num = clean(w['Nº O.S.']);
  const sector = getOrCreateSector(w['Setor / Local']);
  const rawTag = clean(w.TAG);
  const hasRealTag = rawTag && !['sem tag', 'sem numero', 'sem número'].includes(norm(rawTag));
  const eqName = clean(w.Equipamento) || 'Equipamento Geral';

  let mac = null;
  if (hasRealTag && machineLookup.has('tag:' + norm(rawTag))) {
    mac = machineLookup.get('tag:' + norm(rawTag));
  } else if (machineLookup.has('eq:' + norm(eqName) + '||' + sector.id)) {
    mac = machineLookup.get('eq:' + norm(eqName) + '||' + sector.id);
  }

  if (!mac) {
    errors.push(`OS ${num}: máquina não encontrada (${eqName}, ${rawTag})`);
    continue;
  }

  // Parse Datas
  // Data de Abertura: DD/MM/YYYY
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

  // Parada
  const machineStopped = clean(w['Situação do Equipamento']).toLowerCase().includes('parada') ? 1 : 0;

  // Tipo
  const rawType = clean(w['Tipo de Manutenção']);
  const type = norm(rawType).includes('programada') ? 'preventiva' : 'corretiva';

  // Conclusão
  let closedAtIso = null;
  if (status === 'Concluída') {
    const dataFim = clean(w['Data Conclusão / Previsão']) || createdDate;
    const horaFim = clean(w['Hora Conclusão']) || '17:00:00';
    // Se dataFim está em formato YYYY-MM-DD
    const isoDate = dataFim.includes('/') ? dataFim.split('/').reverse().join('-') : dataFim;
    closedAtIso = `${isoDate}T${horaFim}.000Z`;
  }

  validWos++;
}

console.log(`OS validadas com sucesso: ${validWos} de ${wosRaw.length}`);
if (errors.length > 0) {
  console.log('Erros:', errors.slice(0, 5));
}
