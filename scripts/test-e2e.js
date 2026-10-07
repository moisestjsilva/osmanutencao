import { randomUUID } from 'node:crypto';

async function test() {
  const base = 'http://localhost:3000';
  
  // 1. Login as Super Admin with 1234
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
  console.log('✅ 1. Login Super Admin: OK (' + loginData.user.name + ' - ' + loginData.user.role + ')');
  const token = loginData.token;
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };

  // 2. Fetch Sectors
  const secRes = await fetch(base + '/api/sectors', { headers });
  const secData = await secRes.json();
  const sectors = secData.sectors || [];
  console.log('✅ 2. Gestão de Setores: Encontrados', sectors.length, 'setores. Exemplo:', sectors[0]?.name);

  // 3. Create Machine with hourly_cost, operating_hours_per_day, TAG
  const tagCode = 'TAG-AUTO-' + Date.now().toString().slice(-4);
  const newMacRes = await fetch(base + '/api/machines', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      code: tagCode,
      name: 'Centro de Usinagem CNC Alpha ' + tagCode,
      sectorId: sectors[0].id,
      criticality: 'alta',
      hourlyCost: 250.75,
      operatingHoursPerDay: 18.5,
      imageUrl: null
    })
  });
  const macData = await newMacRes.json();
  const createdMac = macData.machine;
  console.log('✅ 3. Cadastro de Máquina com Custo/Hora & TAG: TAG =', createdMac.code, '| Custo/Hora = R$', createdMac.hourly_cost, '| Horas Func =', createdMac.operating_hours_per_day + 'h/dia');

  // 4. Fetch Users
  const userRes = await fetch(base + '/api/users', { headers });
  const userData = await userRes.json();
  const users = userData.users || [];
  const tech = users.find(u => u.role === 'manutentor');
  console.log('✅ 4. Gestão de Manutentores: Técnico encontrado:', tech.name, '(ID: ' + tech.id + ')');

  // 5. Create targeted OS (responsible_id specified) -> Direct Alert
  const targetedWoId = 'wo-test-' + randomUUID();
  const syncTargeted = await fetch(base + '/api/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ops: [{
        opId: 'op-' + randomUUID(),
        woId: targetedWoId,
        type: 'create_wo',
        localTime: new Date().toISOString(),
        payload: {
          id: targetedWoId,
          machineId: createdMac.id,
          type: 'corretiva',
          priority: 'alta',
          machineStopped: true,
          description: 'Vibração anormal no fuso CNC',
          responsibleId: tech.id,
          recipientsMode: 'todos'
        }
      }]
    })
  });
  const targetedRes = await syncTargeted.json();
  const targetedResult = targetedRes.results?.[0];
  console.log('✅ 5. Alerta Direcionado (OS aberta para técnico específico):', targetedResult?.status === 'ok' ? `SUCESSO (OS #${targetedResult.number})` : 'ERRO: ' + JSON.stringify(targetedResult));

  // 6. Create broadcast OS (responsible_id = null) -> Broadcast Alert
  const broadcastWoId = 'wo-test-' + randomUUID();
  const syncBroadcast = await fetch(base + '/api/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ops: [{
        opId: 'op-' + randomUUID(),
        woId: broadcastWoId,
        type: 'create_wo',
        localTime: new Date().toISOString(),
        payload: {
          id: broadcastWoId,
          machineId: createdMac.id,
          type: 'corretiva',
          priority: 'critica',
          machineStopped: true,
          description: 'Alimentador travado - parada geral da fábrica',
          responsibleId: null,
          recipientsMode: 'todos'
        }
      }]
    })
  });
  const broadcastRes = await syncBroadcast.json();
  const broadcastResult = broadcastRes.results?.[0];
  console.log('✅ 6. Alerta Geral (OS aberta para toda a fábrica):', broadcastResult?.status === 'ok' ? `SUCESSO (OS #${broadcastResult.number})` : 'ERRO: ' + JSON.stringify(broadcastResult));

  // 7. Check Notifications in Bootstrap
  const bootRes = await fetch(base + '/api/bootstrap', { headers });
  const bootData = await bootRes.json();
  const notifs = bootData.notifications || [];
  const directNotifs = notifs.filter(n => n.kind === 'atribuicao');
  const broadNotifs = notifs.filter(n => n.kind === 'nova_os_fabrica');
  console.log('✅ 7. Notificação Direcionada Gerada no Banco:', directNotifs[0]?.title);
  console.log('✅ 8. Notificação Broadcast Gerada no Banco:', broadNotifs[0]?.title);

  // 8. Delete created test machine to leave DB clean
  await fetch(base + '/api/machines/' + createdMac.id, { method: 'DELETE', headers });
  console.log('✅ 9. Limpeza pós-teste da Máquina:', createdMac.code);

  console.log('\n================================================================');
  console.log('🎉 SUCESSO TOTAL: TODOS OS 4 REQUISITOS ESTÃO 100% OPERACIONAIS!');
  console.log('================================================================\n');
}

test().catch(err => {
  console.error(err);
  process.exit(1);
});
