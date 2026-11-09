// Teste ponta-a-ponta do módulo de Frota (banco temporário; WhatsApp/MySQL desativados)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, ['--no-warnings', 'server/server.js'], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), WHATSAPP_ENABLED: 'false', WHATSAPP_PROVIDER: 'wapi',
    WHATSAPP_GROUP_ID: '', WAPI_INSTANCE_ID: '', WAPI_API_KEY: '', MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '1', MIGRATION_SECRET: '', FLEET_SKIP_SEED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => (log += d));
srv.stderr.on('data', (d) => (log += d));

let pass = 0;
const ok = (name) => { pass++; console.log('  ✓', name); };
async function call(method, url, body, token) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ...json };
}
async function login(u, p) { const r = await call('POST', '/api/auth/login', { login: u, password: p }); assert.equal(r.status, 200, `login ${u}`); return r.token; }

async function main() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  const adm = await login('admin', 'admin123');

  console.log('Segurança');
  let r = await call('POST', '/api/admin/restore-database', { dbBase64: 'AAAA' }, null);
  assert.equal(r.status, 403); ok('restore sem credencial → 403');
  r = await fetch(BASE + '/api/admin/restore-database', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Migration-Secret': 'nova-os-coolify-migration-2026' }, body: '{"dbBase64":"AAAA"}' });
  assert.equal(r.status, 403); ok('senha antiga hardcoded não funciona mais');

  console.log('Permissões / equipe');
  const mkUser = async (username, role = 'solicitante') => (await call('POST', '/api/users', { name: username.toUpperCase(), username, password: 'senha123', role }, adm)).user;
  const joao = await mkUser('joao'); const mec = await mkUser('mecanico1'); const plain = await mkUser('semfrota');
  let t = await login('joao', 'senha123');
  assert.equal((await call('GET', '/api/fleet/me', null, t)).status, 403); ok('usuário sem perfil de frota → 403');
  r = await call('PUT', `/api/fleet/team/${joao.id}`, { fleet_role: 'motorista' }, adm);
  assert.equal(r.status, 200); assert.ok(r.driver_id); ok('gestor define motorista e cadastro de motorista é criado');
  r = await call('PUT', `/api/fleet/team/${mec.id}`, { fleet_role: 'mecanico' }, adm); assert.equal(r.status, 200);
  const tJoao = await login('joao', 'senha123'); const tMec = await login('mecanico1', 'senha123'); const tPlain = await login('semfrota', 'senha123');
  assert.equal((await call('GET', '/api/fleet/me', null, tPlain)).status, 403);
  r = await call('PUT', `/api/fleet/team/${plain.id}`, { fleet_role: 'gestor' }, tMec); assert.equal(r.status, 403); ok('mecânico não gerencia equipe');

  console.log('Veículos');
  r = await call('POST', '/api/fleet/vehicles', { plate: 'ab-1234', type: 'truck', model: 'Atego' }, tJoao); assert.equal(r.status, 403); ok('motorista não cadastra veículo');
  r = await call('POST', '/api/fleet/vehicles', { plate: 'XX', model: 'x' }, adm); assert.equal(r.status, 400); ok('placa inválida → 400');
  r = await call('POST', '/api/fleet/vehicles', { plate: 'ABC-1D23', nickname: 'Truck 01', type: 'truck', brand: 'MB', model: 'Atego 2430', fuel_type: 'diesel_s10', tank_capacity_l: 400, axles: 3, odometer_km: 100000 }, adm);
  assert.equal(r.status, 201, JSON.stringify(r)); const V = r.vehicle; assert.equal(V.plate, 'ABC1D23'); assert.ok(V.machine_id); ok('veículo criado + máquina vinculada (setor FROTA)');
  r = await call('POST', '/api/fleet/vehicles', { plate: 'ABC1D23' }, adm); assert.equal(r.status, 409); ok('placa duplicada → 409');
  r = await call('GET', '/api/fleet/vehicles', null, tJoao); assert.equal(r.vehicles.length, 1); assert.equal(r.vehicles[0].chassis, undefined); ok('motorista vê lista reduzida');
  r = await call('GET', `/api/fleet/vehicles/${V.id}`, null, tJoao); assert.equal(r.status, 403); ok('motorista não vê detalhe do veículo');

  console.log('Abastecimento / consumo / odômetro');
  r = await call('POST', '/api/fleet/fuel', { vehicle_id: V.id, km: 100500, liters: 200, price_per_l: 6, full_tank: true }, tJoao); assert.equal(r.status, 201, JSON.stringify(r));
  r = await call('POST', '/api/fleet/fuel', { vehicle_id: V.id, km: 99000, liters: 50, price_per_l: 6 }, tJoao); assert.equal(r.status, 400); ok('km menor que o atual é recusado');
  r = await call('POST', '/api/fleet/fuel', { vehicle_id: V.id, km: 101300, liters: 250, total: 1500, full_tank: true }, tJoao);
  assert.equal(r.status, 201); assert.equal(r.fuel.consumption_km_l, 3.2); assert.equal(r.fuel.price_per_l, 6); ok('consumo tanque-a-tanque = 3,2 km/l; preço/litro derivado do total');
  r = await call('GET', `/api/fleet/vehicles/${V.id}`, null, adm); assert.equal(r.vehicle.odometer_km, 101300); ok('odômetro atualizado pelo abastecimento');
  r = await call('POST', '/api/fleet/fuel', { vehicle_id: V.id, km: 101400, liters: 900, price_per_l: 6 }, tJoao); assert.ok(r.warnings.length); ok('aviso de litros acima do tanque');

  console.log('Checklist (bloqueio + OS automática)');
  const items = (await call('GET', '/api/fleet/checklist-items', null, tJoao)).items; assert.ok(items.length >= 20);
  r = await call('POST', '/api/fleet/checklists', { vehicle_id: V.id, type: 'saida', answers: [] }, tJoao); assert.equal(r.status, 400); ok('checklist incompleto é recusado');
  const answers = items.map((i, idx) => ({ item_id: i.id, status: idx === 0 ? 'problema' : 'ok', note: idx === 0 ? 'Pneu dianteiro careca' : '' }));
  assert.ok(items[0].critical);
  r = await call('POST', '/api/fleet/checklists', { vehicle_id: V.id, type: 'saida', km: 101400, answers }, tJoao);
  assert.equal(r.status, 201, JSON.stringify(r)); assert.equal(r.blocked, true); assert.ok(r.wo?.number); ok(`problema crítico bloqueia o veículo e abre OS ${r.wo.number}`);
  r = await call('GET', `/api/fleet/vehicles/${V.id}`, null, adm); assert.equal(r.vehicle.status, 'manutencao'); assert.equal(r.open_orders.length, 1); ok('veículo em manutenção com OS aberta vinculada');
  const wos = await call('GET', '/api/workorders', null, adm); assert.ok(wos.workOrders.some((w) => w.description.includes('Pneu dianteiro careca'))); ok('OS aparece no sistema de manutenção');
  const DRV = (await call('GET', '/api/fleet/me', null, tJoao)).driver;
  r = await call('POST', '/api/fleet/trips/start', { vehicle_id: V.id, origin: 'A', destination: 'B' }, tJoao); assert.equal(r.status, 400); ok('veículo em manutenção não inicia viagem');
  r = await call('POST', `/api/fleet/vehicles/${V.id}/status`, { status: 'ativo' }, tMec); assert.equal(r.status, 200); ok('mecânico libera o veículo');

  console.log('Viagens');
  r = await call('POST', '/api/fleet/trips/start', { vehicle_id: V.id, origin: 'Fábrica', destination: 'Cliente X', cargo: 'Móveis' }, tJoao); assert.equal(r.status, 201, JSON.stringify(r));
  const trip = r.trip; assert.equal(trip.start_km, 101400);
  r = await call('POST', '/api/fleet/trips/start', { vehicle_id: V.id }, tJoao); assert.equal(r.status, 409); ok('segunda viagem simultânea é recusada');
  r = await call('POST', `/api/fleet/trips/${trip.id}/end`, { end_km: 101000 }, tJoao); assert.equal(r.status, 400); ok('km final menor que o inicial é recusado');
  r = await call('POST', `/api/fleet/trips/${trip.id}/end`, { end_km: 101900, expenses: [{ category: 'pedagio', amount: 85.5 }] }, tJoao);
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.trip.distance_km, 500); ok('viagem encerrada (500 km) com despesa de pedágio');
  r = await call('POST', `/api/fleet/trips/start`, { vehicle_id: V.id, driver_id: DRV.id, origin: 'x', destination: 'y' }, tMec); assert.equal(r.status, 403); ok('mecânico não inicia viagem');

  console.log('Motorista: CNH vencida bloqueia viagem');
  r = await call('PUT', `/api/fleet/drivers/${DRV.id}`, { cnh_expiry: '2020-01-01', cnh_category: 'E', cpf: '529.982.247-25' }, adm); assert.equal(r.status, 200);
  r = await call('POST', '/api/fleet/trips/start', { vehicle_id: V.id }, tJoao); assert.equal(r.status, 400); assert.match(r.error, /CNH/); ok('CNH vencida → viagem bloqueada');
  r = await call('PUT', `/api/fleet/drivers/${DRV.id}`, { cpf: '111.111.111-11' }, adm); assert.equal(r.status, 400); ok('CPF inválido recusado');
  r = await call('PUT', `/api/fleet/drivers/${DRV.id}`, { cnh_expiry: '2030-12-31' }, adm); assert.equal(r.status, 200);

  console.log('Manutenção por km');
  r = await call('POST', '/api/fleet/plans', { vehicle_id: V.id, title: 'Troca de óleo', every_km: 1500, last_km: 100000, lead_km: 500 }, tMec);
  assert.equal(r.status, 201, JSON.stringify(r)); assert.equal(r.plan.state, 'vencida'); const plan = r.plan; ok('plano por km vence corretamente (101.900 > 101.500)');
  r = await call('GET', '/api/fleet/dashboard', null, adm); assert.ok(r.alerts.some((a) => a.kind === 'manutencao')); ok('alerta de manutenção no painel');
  r = await call('POST', `/api/fleet/plans/${plan.id}/open-os`, {}, tMec); assert.equal(r.status, 200); assert.ok(r.wo.number); ok('abre OS preventiva a partir do plano');
  r = await call('POST', `/api/fleet/plans/${plan.id}/done`, { cost: 750, notes: 'Óleo 15W40' }, tMec); assert.equal(r.status, 200); assert.equal(r.plan.state, 'ok'); ok('plano concluído reinicia o ciclo');
  r = await call('GET', '/api/fleet/costs', null, tMec); assert.equal(r.status, 403); ok('mecânico não vê custos');
  r = await call('GET', '/api/fleet/costs', null, adm); assert.ok(r.costs.some((c) => c.category === 'manutencao' && c.amount === 750)); ok('custo da manutenção lançado automaticamente');

  console.log('Pneus');
  const mk = async (serial) => (await call('POST', '/api/fleet/tires', { serial, brand: 'Pirelli', size: '295/80R22.5', expected_km: 80000 }, tMec)).tire;
  const p1 = await mk('F001'); const p2 = await mk('F002');
  r = await call('POST', `/api/fleet/tires/${p1.id}/event`, { type: 'instalacao', vehicle_id: V.id, position: 'E1 Esq' }, tMec); assert.equal(r.status, 200, JSON.stringify(r));
  r = await call('POST', `/api/fleet/tires/${p2.id}/event`, { type: 'instalacao', vehicle_id: V.id, position: 'E1 Esq' }, tMec); assert.equal(r.status, 409); ok('posição ocupada é recusada');
  r = await call('POST', `/api/fleet/tires/${p2.id}/event`, { type: 'instalacao', vehicle_id: V.id, position: 'E1 Dir' }, tMec); assert.equal(r.status, 200);
  r = await call('POST', `/api/fleet/tires/${p1.id}/event`, { type: 'rodizio', position: 'E1 Dir' }, tMec); assert.equal(r.status, 200); assert.equal(r.tire.position, 'E1 Dir'); ok('rodízio troca posições');
  r = await call('POST', `/api/fleet/tires/${p2.id}/event`, { type: 'recapagem', cost: 400, km: 102500 }, tMec); assert.equal(r.status, 200); assert.equal(r.tire.status, 'recapagem'); assert.equal(r.tire.retread_count, 1); assert.equal(r.tire.vehicle_id, null); ok('recapagem retira do veículo e acumula km');

  console.log('Documentos / multas / relatórios');
  r = await call('POST', '/api/fleet/documents', { entity_type: 'vehicle', entity_id: V.id, doc_type: 'CRLV', expiry_date: '2020-03-31' }, adm); assert.equal(r.status, 201);
  r = await call('POST', '/api/fleet/documents', { entity_type: 'vehicle', entity_id: V.id, doc_type: 'Seguro', expiry_date: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) }, adm); assert.equal(r.status, 201);
  r = await call('GET', '/api/fleet/dashboard', null, adm);
  assert.ok(r.alerts.some((a) => a.kind === 'documento' && a.level === 'vencido')); assert.ok(r.alerts.some((a) => a.kind === 'documento' && a.level === 'vencendo')); ok('alertas de documento vencido e a vencer');
  r = await call('POST', '/api/fleet/fines', { vehicle_id: V.id, fine_date: trip.start_at, infraction: 'Excesso de velocidade', amount: 293.47, points: 5, due_date: '2030-01-10' }, adm);
  assert.equal(r.status, 201); assert.equal(r.driver_detected, true); assert.equal(r.fine.driver_id, DRV.id); ok('multa identifica o motorista pela viagem');
  r = await call('GET', '/api/fleet/fines', null, tJoao); assert.equal(r.fines.length, 1); ok('motorista vê apenas as próprias multas');
  r = await call('GET', '/api/fleet/fines', null, tMec); assert.equal(r.status, 403);
  r = await call('GET', '/api/fleet/reports/costs', null, adm); assert.equal(r.status, 200);
  const row = r.rows.find((x) => x.plate === 'ABC1D23'); assert.ok(row.fuel > 0 && row.km >= 1900 && row.cost_per_km > 0); ok(`relatório: custo/km R$ ${row.cost_per_km} • ${row.km} km`);
  const csv = await fetch(BASE + '/api/fleet/reports/costs.csv', { headers: { Authorization: `Bearer ${adm}` } });
  assert.equal(csv.status, 200); assert.match(await csv.text(), /ABC1D23/); ok('exporta CSV');
  r = await call('GET', '/api/fleet/dashboard', null, tJoao); assert.equal(r.access, 'motorista'); assert.ok(r.driver); ok('painel do motorista');

  console.log('Exclusão');
  r = await call('DELETE', `/api/fleet/vehicles/${V.id}`, null, adm); assert.equal(r.soft, true); ok('veículo com histórico é apenas inativado');

  console.log('Robô WhatsApp da Frota (Separado por Placa + Evolution)');
  await call('POST', '/api/whatsapp/delay', { delay: 0 }, adm);
  r = await call('POST', '/api/fleet/vehicles', { plate: 'RMI1A95', brand: 'MERCEDES', model: 'ACCELO 1016 2P', type: 'vuc', odometer_km: 150000 }, adm);
  assert.equal(r.status, 201);
  ok('veículo RMI1A95 cadastrado para teste do WhatsApp da Frota');
  r = await call('GET', '/api/whatsapp/templates', null, adm);
  assert.equal(r.status, 200);
  assert.ok(r.templates.length > 0 && r.templates.every((t) => !String(t.category || '').startsWith('frota')), 'templates da fábrica não devem misturar com frota');
  ok('templates da fábrica permanecem 100% isolados');

  r = await call('GET', '/api/whatsapp-frota/templates', null, adm);
  assert.equal(r.status, 200);
  assert.ok(r.templates.length >= 10 && r.templates.some((t) => t.key === 'fleet_bot_ask_plate'), 'templates da frota presentes');
  ok(`${r.templates.length} templates exclusivos da frota carregados`);

  // Teste fluxo normal da fábrica (não pode quebrar)
  r = await call('POST', '/api/whatsapp/simulate', { phone: '5532999990001', text: 'oi' }, adm);
  assert.equal(r.status, 200);
  assert.match(r.reply, /Nova OS|Nome Completo/i);
  r = await call('POST', '/api/whatsapp/simulate', { phone: '5532999990001', text: 'mecanico1' }, adm);
  assert.equal(r.status, 200);
  assert.match(r.reply, /TAG/i);
  ok('fluxo de OS da fábrica continua intacto (identifica colaborador e pede TAG)');

  // Teste gatilho "frota" no WhatsApp principal
  r = await call('POST', '/api/whatsapp/simulate', { phone: '5532999990002', text: 'frota' }, adm);
  assert.equal(r.status, 200);
  assert.match(r.reply, /PLACA/i);
  ok('digitar "frota" inicia fluxo separado solicitando a PLACA');

  // Continuar fluxo da frota até abrir OS por placa (RMI1A95)
  r = await call('POST', '/api/whatsapp-frota/simulate', { phone: '5532999990002', text: 'RMI1A95' }, adm);
  assert.equal(r.status, 200);
  assert.match(r.reply, /RMI1A95/);
  assert.match(r.reply, /KM/i);
  ok('placa RMI1A95 localizada no cadastro da frota e solicita KM');

  r = await call('POST', '/api/whatsapp-frota/simulate', { phone: '5532999990002', text: '158400' }, adm);
  assert.equal(r.status, 200);
  assert.match(r.reply, /urgência|prioridade/i);
  ok('hodômetro 158.400 km recebido e solicita prioridade');

  r = await call('POST', '/api/whatsapp-frota/simulate', { phone: '5532999990002', text: '3' }, adm);
  assert.equal(r.status, 200);
  assert.match(r.reply, /imobilizado|parado/i);
  ok('prioridade alta selecionada e pergunta se o caminhão está parado');

  r = await call('POST', '/api/whatsapp-frota/simulate', { phone: '5532999990002', text: '1' }, adm);
  assert.equal(r.status, 200);
  assert.match(r.reply, /defeito|problema|foto/i);
  ok('status parado selecionado e solicita descrição/foto do problema');

  r = await call('POST', '/api/whatsapp-frota/simulate', { phone: '5532999990002', text: 'Vazamento de ar na cuíca de freio traseira' }, adm);
  assert.equal(r.status, 200);
  assert.equal(r.orderCreated, true);
  assert.match(r.reply, /OS DE FROTA #\d+ ABERTA COM SUCESSO/i);
  assert.match(r.reply, /RMI1A95/);
  const fleetWoId = r.workOrder?.id;
  ok(`OS da frota aberta via WhatsApp por placa (#${r.workOrder?.number})`);

  // Teste de visibilidade das OS da Frota:
  // 1) Solicitante sem acesso à Frota (tPlain) NÃO pode ver OS da Frota
  r = await call('GET', '/api/workorders', null, tPlain);
  assert.equal(r.status, 200);
  assert.equal(r.workOrders.some((w) => w.id === fleetWoId || w.machine?.sector === 'FROTA'), false);
  r = await call('GET', `/api/workorders/${fleetWoId}`, null, tPlain);
  assert.equal(r.status, 403);
  ok('solicitante sem acesso à frota NÃO visualiza OS da frota (403 no detalhe e oculta na lista)');

  // 2) Manutentor da fábrica SEM acesso à Frota NÃO pode ver OS da Frota
  r = await call('POST', '/api/users', { name: 'Manutentor Fabrica', username: 'manutfab', password: 'senha123', role: 'manutentor' }, adm);
  const techFab = await login('manutfab', 'senha123');
  r = await call('GET', '/api/workorders', null, techFab);
  assert.equal(r.status, 200);
  assert.equal(r.workOrders.some((w) => w.id === fleetWoId || w.machine?.sector === 'FROTA'), false);
  r = await call('GET', `/api/workorders/${fleetWoId}`, null, techFab);
  assert.equal(r.status, 403);
  ok('manutentor da fábrica sem acesso à frota NÃO visualiza OS da frota');

  // 3) Solicitante COM permissão de Gestor da Frota (ex.: Bruno Ribeiro) VISUALIZA todas as OS da Frota
  r = await call('POST', '/api/users', { name: 'Bruno Gestor Frota', username: 'brunofrota', password: 'senha123', role: 'solicitante' }, adm);
  const brunoId = r.user.id;
  r = await call('PUT', `/api/fleet/team/${brunoId}`, { fleet_role: 'gestor' }, adm);
  assert.equal(r.status, 200);
  const bruno = await login('brunofrota', 'senha123');
  r = await call('GET', '/api/workorders', null, bruno);
  assert.equal(r.status, 200);
  assert.equal(r.workOrders.some((w) => w.id === fleetWoId), true);
  r = await call('GET', `/api/workorders/${fleetWoId}`, null, bruno);
  assert.equal(r.id, fleetWoId);
  assert.equal(r.status, 'Aberta');
  ok('solicitante com permissão de Gestor da Frota visualiza OS abertas da frota');

  // 4) Motorista e Mecânico da Frota também visualizam as OS abertas da Frota
  r = await call('GET', '/api/workorders', null, tJoao);
  assert.equal(r.workOrders.some((w) => w.id === fleetWoId), true);
  r = await call('GET', '/api/fleet/dashboard', null, tJoao);
  assert.equal(r.open_orders.some((w) => w.id === fleetWoId), true);
  r = await call('GET', '/api/workorders', null, tMec);
  assert.equal(r.workOrders.some((w) => w.id === fleetWoId), true);
  ok('motorista e mecânico da frota visualizam as OS abertas da frota');

  console.log(`\n${pass} verificações OK`);
}

main().then(() => { srv.kill(); process.exit(0); }).catch((e) => {
  console.error('\n✗ FALHOU:', e.message); console.error(e.stack?.split('\n').slice(1, 4).join('\n'));
  console.error('--- log do servidor ---\n' + log.slice(-1500));
  srv.kill(); process.exit(1);
});

