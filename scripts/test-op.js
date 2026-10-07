import { openDb } from '../server/db.js';
import { applyOp } from '../server/domain.js';
import { randomUUID } from 'node:crypto';

const db = openDb();
const user = db.prepare("SELECT * FROM users WHERE role='superadmin'").get();
const machine = db.prepare("SELECT * FROM machines LIMIT 1").get();
const tech = db.prepare("SELECT * FROM users WHERE role='manutentor' LIMIT 1").get();

const woId = 'wo-debug-' + randomUUID();
const op = {
  opId: 'op-debug-' + randomUUID(),
  woId,
  type: 'create_wo',
  localTime: new Date().toISOString(),
  userId: user.id,
  payload: {
    id: woId,
    machineId: machine.id,
    type: 'corretiva',
    priority: 'alta',
    machineStopped: true,
    description: 'Teste de depuração de erro',
    responsibleId: tech.id,
    recipientsMode: 'todos'
  }
};

try {
  const res = applyOp(db, op);
  console.log('Resultado applyOp:', res);
} catch (err) {
  console.error('Catch:', err);
}
