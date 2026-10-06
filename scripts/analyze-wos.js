import xlsx from 'xlsx';
import path from 'node:path';

const file = path.resolve('Relatorio_Geral_Manutencao_Rufato_2026-10-06.xlsx');
const wb = xlsx.readFile(file);
const wos = xlsx.utils.sheet_to_json(wb.Sheets['Ordens de Serviço']);

console.log('Total de OS:', wos.length);
console.log('Exemplo 1:');
console.log(JSON.stringify(wos[0], null, 2));

console.log('\nExemplo com peças/ferramentas se houver:');
const withParts = wos.filter(w => w['Peças / Materiais Utilizados'] || w['Possíveis Causas']);
console.log(`OS com Peças ou Causas: ${withParts.length}`);
if (withParts.length > 0) {
  console.log(JSON.stringify(withParts[0], null, 2));
}

// Analisar status
const statusCounts = {};
for (const w of wos) {
  const s = String(w['Status'] || '').trim();
  statusCounts[s] = (statusCounts[s] || 0) + 1;
}
console.log('\nDistribuição de Status:', statusCounts);

// Analisar Situação do Equipamento
const sitCounts = {};
for (const w of wos) {
  const s = String(w['Situação do Equipamento'] || '').trim();
  sitCounts[s] = (sitCounts[s] || 0) + 1;
}
console.log('\nDistribuição de Situação:', sitCounts);

// Analisar Tipo de Manutenção
const typeCounts = {};
for (const w of wos) {
  const s = String(w['Tipo de Manutenção'] || '').trim();
  typeCounts[s] = (typeCounts[s] || 0) + 1;
}
console.log('\nDistribuição de Tipos:', typeCounts);
