// Script para corrigir o status das OS antigas no SQLite de acordo com a planilha oficial
const { DatabaseSync } = require('node:sqlite');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const dbFile = path.join(root, 'data', 'nova-os.db');
const excelFile = path.join(root, 'Relatorio_Geral_Manutencao_Rufato_2026-10-21.xlsx');

if (!fs.existsSync(dbFile) || !fs.existsSync(excelFile)) {
  console.error('Arquivos não encontrados.');
  process.exit(1);
}

const db = new DatabaseSync(dbFile);
const wb = xlsx.readFile(excelFile);
const sheet = wb.Sheets['Ordens de Serviço'];
const rows = xlsx.utils.sheet_to_json(sheet);

function norm(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

console.log('--- Analisando OSs na planilha e no banco ---');

// 1. Atualiza OSs históricas da planilha que estavam marcadas como Concluída
let fixedCount = 0;
const updateStmt = db.prepare(`
  UPDATE work_orders
  SET status = 'Concluída',
      closed_at = ?,
      machine_recovered = 1,
      returned_at = ?
  WHERE id = ? OR number = ?
`);

const insEvent = db.prepare(`
  INSERT INTO wo_events (id, wo_id, user_id, action, reason, local_time, received_at)
  VALUES (?, ?, ?, 'concluir', 'Concluído conforme histórico da planilha', ?, ?)
`);

for (const r of rows) {
  const num = String(r['Nº O.S.'] || '').trim();
  const rawStatus = norm(r['Status']);
  if (!num || rawStatus !== 'concluida') continue;

  const currentWo = db.prepare('SELECT id, number, status, created_at, closed_at, responsible_id FROM work_orders WHERE number = ? OR id = ?').get(num, 'wo-' + num);
  if (currentWo && currentWo.status !== 'Concluída' && currentWo.status !== 'Cancelada') {
    let dataFim = String(r['Data Conclusão / Previsão'] || '').trim();
    if (dataFim.includes('/')) dataFim = dataFim.split('/').reverse().join('-');
    const horaFim = String(r['Hora Conclusão'] || '17:00:00').trim();
    const closedIso = dataFim ? `${dataFim}T${horaFim.length === 5 ? horaFim + ':00' : horaFim}.000Z` : currentWo.created_at;

    updateStmt.run(closedIso, closedIso, currentWo.id, currentWo.number);
    try {
      insEvent.run(
        'evt-fix-' + num,
        currentWo.id,
        currentWo.responsible_id || 'u-admin-1',
        closedIso,
        closedIso
      );
    } catch (_) {}

    console.log(`✅ OS corrigida para Concluída: ${num} (era: ${currentWo.status})`);
    fixedCount++;
  }
}

// 2. Limpeza de OSs de testes antigos fictícios (ex: 1001.0 até 1010.0, 77777.0)
const testWos = ['1001.0', '1002.0', '1003.0', '1004.0', '1005.0', '1006.0', '1007.0', '1008.0', '1009.0', '1010.0', '77777.0'];
const cancelStmt = db.prepare(`
  UPDATE work_orders
  SET status = 'Cancelada',
      cancelled_reason = 'OS fictícia de teste inicial',
      closed_at = created_at
  WHERE number = ? AND status NOT IN ('Concluída', 'Cancelada')
`);

let cancelledTests = 0;
for (const tNum of testWos) {
  const res = cancelStmt.run(tNum);
  if (res.changes > 0) {
    console.log(`🧹 Teste antigo cancelado para não poluir tela: ${tNum}`);
    cancelledTests++;
  }
}

console.log(`\nResumo da correção:`);
console.log(`- OSs históricas corrigidas para Concluída: ${fixedCount}`);
console.log(`- Testes antigos fictícios cancelados: ${cancelledTests}`);
console.log(`Banco local atualizado com sucesso!`);
