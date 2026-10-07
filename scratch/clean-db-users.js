import { openDb } from '../server/db.js';

const db = openDb();

// 1. Merge Pablo/Manutenção -> Pablo
const pabloReal = db.prepare("SELECT id FROM users WHERE username = 'pablo'").get();
const pabloFake = db.prepare("SELECT id FROM users WHERE username = 'pablomanutencao'").get();
if (pabloReal && pabloFake) {
  db.prepare('UPDATE work_orders SET requester_id = ? WHERE requester_id = ?').run(pabloReal.id, pabloFake.id);
  db.prepare('UPDATE work_orders SET responsible_id = ? WHERE responsible_id = ?').run(pabloReal.id, pabloFake.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(pabloFake.id);
  console.log('Mesclado Pablo/Manutenção -> Pablo');
}

// 2. Merge Vinicius/Manutenção e Vinicius/Manuteção -> Vinicius
const viniReal = db.prepare("SELECT id FROM users WHERE username = 'vinicius'").get();
for (const fakeU of ['viniciusmanutencao', 'viniciusmanutecao']) {
  const f = db.prepare("SELECT id FROM users WHERE username = ?").get(fakeU);
  if (viniReal && f) {
    db.prepare('UPDATE work_orders SET requester_id = ? WHERE requester_id = ?').run(viniReal.id, f.id);
    db.prepare('UPDATE work_orders SET responsible_id = ? WHERE responsible_id = ?').run(viniReal.id, f.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(f.id);
    console.log('Mesclado', fakeU, '-> Vinicius');
  }
}

// 3. Excluir solicitantes de departamentos/códigos de teste
const dummyNames = ['5002', 'Embalagem', 'Furacão', 'Linha', 'Linha de pintura', 'Manutenção'];
for (const name of dummyNames) {
  const u = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (u) {
    db.prepare('UPDATE work_orders SET requester_id = NULL WHERE requester_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    console.log('Excluído usuário fictício/departamento:', name);
  }
}

const remaining = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
console.log('Total de usuários ativos restantes no banco:', remaining);
