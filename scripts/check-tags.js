import xlsx from 'xlsx';
import path from 'node:path';

const file = path.resolve('Relatorio_Geral_Manutencao_Rufato_2026-10-06.xlsx');
const wb = xlsx.readFile(file);
const machines = xlsx.utils.sheet_to_json(wb.Sheets['Maquinário e TAGs']);

console.log('Total de linhas em Maquinário e TAGs:', machines.length);
const tagCounts = {};
const noTagList = [];

for (const m of machines) {
  const tag = String(m['TAG'] || '').trim();
  const name = String(m['Equipamento'] || '').trim();
  const sector = String(m['Setor'] || '').trim();
  if (!tag || tag.toLowerCase() === 'sem número' || tag.toLowerCase() === 'sem numero') {
    noTagList.push({ name, sector, tag });
  } else {
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  }
}

console.log('Máquinas sem TAG específica ("Sem número" ou vazio):', noTagList.length);
console.log('Exemplos de máquinas sem número:', noTagList.slice(0, 10));

const duplicateTags = Object.entries(tagCounts).filter(([k, v]) => v > 1);
console.log('TAGs duplicadas:', duplicateTags);
