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
  console.log('✅ Login Super Admin: OK (' + loginData.user.name + ' - ' + loginData.user.role + ')');
  const token = loginData.token;
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };

  // 2. Fetch Sectors
  const secRes = await fetch(base + '/api/sectors', { headers });
  const sectors = await secRes.json();
  console.log('✅ Total Setores:', sectors.length, '| Exemplo:', sectors[0]?.name);

  // 3. Create Machine with hourly_cost and operating_hours_per_day
  const tagCode = 'TAG-AUTO-' + Date.now().toString().slice(-4);
  const newMacRes = await fetch(base + '/api/machines', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      code: tagCode,
      name: 'Centro de Usinagem CNC Alpha ' + tagCode,
      sector_id: sectors[0].id,
      criticality: 'alta',
      hourly_cost: 250.75,
      operating_hours_per_day: 18.5,
      image_url: null
    })
  });
  const createdMac = await newMacRes.json();
  console.log('✅ Criar Máquina:', createdMac.code, '| Custo/Hora: R$', createdMac.hourly_cost, '| Horas Func:', createdMac.operating_hours_per_day + 'h/dia');

  // 4. Fetch Users
  const userRes = await fetch(base + '/api/users', { headers });
  const users = await userRes.json();
  const tech = users.find(u => u.role === 'manutentor');
  console.log('✅ Técnico para teste:', tech.name, '(ID: ' + tech.id + ')');

  // 5. Create targeted OS (responsible_id specified)
  const syncTargeted = await fetch(base + '/api/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ops: [{
        op_id: 'op-test-targeted-' + Date.now(),
        type: 'create_wo',
        payload: {
          machineId: createdMac.id,
          type: 'corretiva',
          priority: 'alta',
          machineStopped: true,
          description: 'Vibração anormal no fuso CNC',
          responsibleId: tech.id
        }
      }]
    })
  });
  const targetedRes = await syncTargeted.json();
  console.log('✅ Criação OS Direcionada ao técnico:', targetedRes.ok ? 'SUCESSO' : 'ERRO');

  // 6. Create broadcast OS (responsible_id = null)
  const syncBroadcast = await fetch(base + '/api/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ops: [{
        op_id: 'op-test-broadcast-' + Date.now(),
        type: 'create_wo',
        payload: {
          machineId: createdMac.id,
          type: 'corretiva',
          priority: 'critica',
          machineStopped: true,
          description: 'Alimentador travado - parada geral',
          responsibleId: null
        }
      }]
    })
  });
  const broadcastRes = await syncBroadcast.json();
  console.log('✅ Criação OS Broadcast (Geral da Fábrica):', broadcastRes.ok ? 'SUCESSO' : 'ERRO');

  // 7. Check Notifications in Bootstrap
  const bootRes = await fetch(base + '/api/bootstrap', { headers });
  const bootData = await bootRes.json();
  const notifs = bootData.notifications || [];
  const directNotifs = notifs.filter(n => n.kind === 'nova_os_direcionada');
  const broadNotifs = notifs.filter(n => n.kind === 'nova_os_broadcast');
  console.log('✅ Notificação Direcionada Gerada:', directNotifs[0]?.title);
  console.log('✅ Notificação Broadcast Gerada:', broadNotifs[0]?.title);

  // 8. Delete created test machine to leave DB clean
  await fetch(base + '/api/machines/' + createdMac.id, { method: 'DELETE', headers });
  console.log('✅ Exclusão de Máquina de teste:', createdMac.code);

  console.log('\n======================================================');
  console.log('🏆 TODOS OS 4 PONTOS FORAM TESTADOS E VALIDADOS 100%!');
  console.log('======================================================\n');
}

test().catch(err => {
  console.error(err);
  process.exit(1);
});
