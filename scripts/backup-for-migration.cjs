// Gera backup consistente (SQLite + uploads + sessão WhatsApp) em backup-migracao/
// Uso: node scripts/backup-for-migration.cjs
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const data = path.join(root, 'data');
const out = path.join(root, 'backup-migracao');
fs.mkdirSync(out, { recursive: true });
const dest = path.join(out, 'nova-os.db');
if (fs.existsSync(dest)) fs.unlinkSync(dest);
const db = new DatabaseSync(path.join(data, 'nova-os.db'));
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
const chk = new DatabaseSync(dest).prepare('PRAGMA integrity_check').get();
console.log('integrity_check:', JSON.stringify(chk));
for (const d of ['uploads', 'whatsapp_auth']) {
  const src = path.join(data, d);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(out, d), { recursive: true });
}
console.log('Backup em', out);
