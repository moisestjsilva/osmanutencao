import xlsx from 'xlsx';
import path from 'node:path';

const file = path.resolve('Relatorio_Geral_Manutencao_Rufato_2026-10-06.xlsx');
const wb = xlsx.readFile(file);

function inspectSheet(name) {
  const sheet = wb.Sheets[name];
  const rows = xlsx.utils.sheet_to_json(sheet);
  console.log(`\n========================================`);
  console.log(`ANALISANDO ABA: ${name} (Total: ${rows.length} registros)`);
  console.log(`========================================`);
  if (rows.length === 0) return;
  console.log('Chaves/Colunas:', Object.keys(rows[0]));
  return rows;
}

const wos = inspectSheet('Ordens de Serviço');
const machines = inspectSheet('Maquinário e TAGs');
const techs = inspectSheet('Manutentores');

// Resumo dos valores únicos em Ordens de Serviço
const statuses = new Set();
const types = new Set();
const situations = new Set();
const specialties = new Set();
const sectors = new Set();
const requesters = new Set();
const techNamesInWo = new Set();

for (const w of wos) {
  if (w['Status']) statuses.add(String(w['Status']).trim());
  if (w['Tipo de Manutenção']) types.add(String(w['Tipo de Manutenção']).trim());
  if (w['Situação do Equipamento']) situations.add(String(w['Situação do Equipamento']).trim());
  if (w['Especialidade']) specialties.add(String(w['Especialidade']).trim());
  if (w['Setor / Local']) sectors.add(String(w['Setor / Local']).trim());
  if (w['Solicitante']) requesters.add(String(w['Solicitante']).trim());
  if (w['Manutentores Responsáveis']) techNamesInWo.add(String(w['Manutentores Responsáveis']).trim());
}

console.log('\n--- VALORES ÚNICOS EM ORDENS DE SERVIÇO ---');
console.log('Status encontrados:', Array.from(statuses));
console.log('Tipos de Manutenção:', Array.from(types));
console.log('Situação do Equipamento:', Array.from(situations));
console.log('Especialidades:', Array.from(specialties));
console.log('Setores:', Array.from(sectors));
console.log('Solicitantes:', Array.from(requesters));
console.log('Manutentores nas OS:', Array.from(techNamesInWo));

console.log('\n--- AMOSTRA DE MÁQUINAS ---');
console.log(machines.slice(0, 5));

console.log('\n--- AMOSTRA DE MANUTENTORES ---');
console.log(techs);
