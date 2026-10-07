import { randomUUID } from 'node:crypto';

async function test() {
  const base = 'http://localhost:3000';

  // 1. Login
  const loginRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'moisestj86@gmail.com', password: '1234' })
  });
  const loginData = await loginRes.json();
  if (!loginData.ok) {
    console.error('Falha no login:', loginData);
    process.exit(1);
  }
  console.log('✅ 1. Login Super Admin OK');
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + loginData.token };

  // 2. Fetch sectors
  const secRes = await fetch(base + '/api/sectors', { headers });
  const secData = await secRes.json();
  const sector = secData.sectors[0];

  // 3. Cadastrar máquina com Ficha de Preventiva Padrão
  const standardChecklist = [
    'Verificar nível e pressão do óleo lubrificante',
    'Limpar filtros de ar e dissipadores de calor',
    'Reapertar bornes elétricos e conexões',
    'Inspecionar desgaste de correias e rolamentos'
  ];

  const tag = 'TAG-PREV-' + Date.now().toString().slice(-4);
  const createMacRes = await fetch(base + '/api/machines', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      code: tag,
      name: 'Centro de Usinagem com Preventiva ' + tag,
      sectorId: sector.id,
      criticality: 'alta',
      hourlyCost: 320.00,
      operatingHoursPerDay: 18.0,
      defaultChecklist: standardChecklist
    })
  });
  const createdMacData = await createMacRes.json();
  const machine = createdMacData.machine;
  console.log('✅ 2. Máquina cadastrada:', machine.code);
  console.log('   Ficha de preventiva padrão salva:', machine.default_checklist_json);

  const parsedItems = JSON.parse(machine.default_checklist_json || '[]');
  if (parsedItems.length !== 4) {
    throw new Error('Checklist padrão esperado com 4 itens, mas obteve ' + parsedItems.length);
  }
  console.log('✅ 3. Itens na ficha padrão validados:', parsedItems.length, 'itens');

  // 4. Criar OS Preventiva editando o checklist (ex: alterando e adicionando item na hora)
  const editedChecklist = [
    ...parsedItems,
    'Item extra adicionado na hora: Calibrar batente pneumático'
  ];

  const woId = 'wo-prev-' + randomUUID();
  const syncRes = await fetch(base + '/api/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ops: [{
        opId: 'op-' + randomUUID(),
        woId,
        type: 'create_wo',
        localTime: new Date().toISOString(),
        payload: {
          id: woId,
          machineId: machine.id,
          type: 'preventiva',
          priority: 'media',
          machineStopped: false,
          description: 'Preventiva mensal com checklist editado',
          checklist: editedChecklist
        }
      }]
    })
  });

  const syncData = await syncRes.json();
  const opResult = syncData.results?.[0];
  console.log('✅ 4. OS Preventiva gerada:', opResult?.status === 'ok' ? `OS #${opResult.number}` : 'ERRO');

  // 5. Verificar detalhes da OS no backend
  const woDetailRes = await fetch(base + `/api/workorders/${woId}`, { headers });
  const woDetail = await woDetailRes.json();
  console.log('✅ 5. Checklist recuperado na OS:', woDetail.checklist?.length, 'itens');
  console.log('   Primeiro item:', woDetail.checklist?.[0]?.text);
  console.log('   Último item (adicionado na hora):', woDetail.checklist?.[woDetail.checklist.length - 1]?.text);

  if (woDetail.checklist?.length !== 5) {
    throw new Error('Esperado 5 itens no checklist da OS, obteve ' + woDetail.checklist?.length);
  }

  // 6. Limpeza do teste
  await fetch(base + '/api/machines/' + machine.id, { method: 'DELETE', headers });
  console.log('✅ 6. Máquina de teste excluída');

  console.log('\n======================================================');
  console.log('🎉 FICHA DE PREVENTIVA PADRÃO VALIDADA COM 100% DE SUCESSO!');
  console.log('======================================================\n');
}

test().catch(err => {
  console.error('Erro no teste:', err);
  process.exit(1);
});
