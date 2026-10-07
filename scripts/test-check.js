import { openDb } from '../server/db.js';
import { verifyPassword, hashPassword } from '../server/auth.js';

const db = openDb();
const users = db.prepare("SELECT id, name, email, username, role, password_hash, salt FROM users WHERE role='superadmin' OR username='admin'").all();
console.log('Users found:', users.map(u => ({ id: u.id, name: u.name, email: u.email, username: u.username, role: u.role })));

for (const u of users) {
  for (const p of ['1234', 'admin123', '123456']) {
    if (u.password_hash && verifyPassword(p, u.password_hash, u.salt)) {
      console.log(`User ${u.username || u.email} matches password: '${p}'`);
    }
  }
}
