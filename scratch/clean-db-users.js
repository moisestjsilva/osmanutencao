import { openDb } from '../server/db.js';

const db = openDb();

function unbindAndDelete(userId, mergeToId = null) {
  if (mergeToId) {
    db.prepare('UPDATE work_orders SET requester_id = ? WHERE requester_id = ?').run(mergeToId, userId);
    db.prepare('UPDATE work_orders SET responsible_id = ? WHERE responsible_id = ?').run(mergeToId, userId);
    db.prepare('UPDATE wo_events SET user_id = ? WHERE user_id = ?').run(mergeToId, userId);
  } else {
    db.prepare('UPDATE work_orders SET requester_id = NULL WHERE requester_id = ?').run(userId);
    db.prepare('UPDATE work_orders SET responsible_id = NULL WHERE responsible_id = ?').run(userId);
    db.prepare('UPDATE wo_events SET user_id = NULL WHERE user_id = ?').run(userId);
  }
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM wo_participants WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM work_intervals WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM audit_log WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// 1. Merge Pablo/Manutenção -> Pablo
const pabloReal = db.prepare("SELECT id FROM users WHERE username = 'pablo'").get();
const pabloFake = db.prepare("SELECT id FROM users WHERE username = 'pablomanutencao'").get();
if (pabloReal && pabloFake) {
  unbindAndDelete(pabloFake.id, pabloReal.id);
  console.log('Mesclado Pablo/Manutenção -> Pablo');
}

// 2. Merge Vinicius/Manutenção e Vinicius/Manuteção -> Vinicius
const viniReal = db.prepare("SELECT id FROM users WHERE username = 'vinicius'").get();
for (const fakeU of ['viniciusmanutencao', 'viniciusmanutecao']) {
  const f = db.prepare("SELECT id FROM users WHERE username = ?").get(fakeU);
  if (viniReal && f) {
    unbindAndDelete(f.id, viniReal.id);
    console.log('Mesclado', fakeU, '-> Vinicius');
  }
}

// 3. Excluir solicitantes de departamentos/códigos de teste
const dummyNames = ['5002', 'Embalagem', 'Furacão', 'Linha', 'Linha de pintura', 'Manutenção'];
for (const name of dummyNames) {
  const u = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (u) {
    unbindAndDelete(u.id, null);
    console.log('Excluído usuário fictício/departamento:', name);
  }
}

const remaining = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
console.log('Total de usuários ativos restantes no banco:', remaining);
