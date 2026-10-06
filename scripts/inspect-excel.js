import xlsx from 'xlsx';
import path from 'node:path';

const file = path.resolve('Relatorio_Geral_Manutencao_Rufato_2026-10-06.xlsx');
const workbook = xlsx.readFile(file);

console.log('=== ABA DAS PLANILHAS ===');
console.log(workbook.SheetNames);

for (const sheetName of workbook.SheetNames) {
  console.log(`\n========================================`);
  console.log(`ABA: ${sheetName}`);
  console.log(`========================================`);
  const sheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
  console.log(`Total de linhas: ${data.length}`);
  if (data.length > 0) {
    console.log('Linha 0 (Cabeçalhos potenciais):', data[0]);
    if (data.length > 1) {
      console.log('Linha 1 (Amostra 1):', data[1]);
    }
    if (data.length > 2) {
      console.log('Linha 2 (Amostra 2):', data[2]);
    }
  }
}
