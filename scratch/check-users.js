import { openDb } from '../server/db.js';

const db = openDb();
const list = db.prepare(`
  SELECT id, name, username, role, specialty, active
  FROM users
  ORDER BY role, name
`).all();

console.log(`Total users in DB: ${list.length}`);
for (const u of list) {
  const woResp = db.prepare('SELECT COUNT(*) as n FROM work_orders WHERE responsible_id = ?').get(u.id).n;
  const woReq = db.prepare('SELECT COUNT(*) as n FROM work_orders WHERE requester_id = ?').get(u.id).n;
  console.log(`[${u.role.padEnd(11)}] ${u.name.padEnd(28)} (login: ${(u.username||'-').padEnd(18)}) -> Resp: ${woResp}, Req: ${woReq}`);
}
