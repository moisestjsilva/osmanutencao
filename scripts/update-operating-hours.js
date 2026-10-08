import { DatabaseSync } from 'node:sqlite';
import { Client } from 'ssh2';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DB = path.join(__dirname, '..', 'data', 'nova-os.db');

// 1. Atualiza no SQLite local
try {
  const db = new DatabaseSync(LOCAL_DB);
  const info = db.prepare('UPDATE machines SET operating_hours_per_day = 8.0').run();
  console.log(`[Local SQLite] ${info.changes} máquina(s) atualizada(s) para operating_hours_per_day = 8.`);
} catch (err) {
  console.warn('[Local SQLite] Aviso:', err.message);
}

// 2. Conecta via SSH para atualizar no MySQL remoto (CloudPanel phpMyAdmin) e no SQLite do servidor
const c = new Client();
c.on('ready', () => {
  console.log('[SSH] Conectado. Atualizando MySQL remoto...');
  const remoteCmd = `
    mysql -u osrufato -pa888zBgiSoBXlHYRCA2t osrufato -e "UPDATE machines SET operating_hours_per_day = 8.0; SELECT COUNT(*) as total_maquinas, operating_hours_per_day FROM machines GROUP BY operating_hours_per_day;"

    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
    export PATH=$PATH:/usr/local/bin:/usr/bin:~/.nvm/versions/node/$(ls ~/.nvm/versions/node 2>/dev/null | tail -n 1)/bin
    node -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/home/os_rufato/htdocs/os.moveisrufato.com.br/data/nova-os.db'); db.prepare('UPDATE machines SET operating_hours_per_day = 8.0').run(); console.log('SQLite do servidor CloudPanel atualizado!');"
  `;

  c.exec(remoteCmd, (err, stream) => {
    if (err) {
      console.error(err);
      c.end();
      return;
    }
    stream.on('data', (d) => process.stdout.write(d));
    stream.stderr.on('data', (d) => process.stderr.write(d));
    stream.on('close', (code) => {
      console.log('[SSH] Comando finalizado com código:', code);
      c.end();
    });
  });
}).connect({
  host: '186.225.65.17',
  port: 22,
  username: 'osrufato',
  password: 'ImDs5nSJ8BmeFOTjS4L2'
});
