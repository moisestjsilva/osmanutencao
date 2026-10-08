// Sincronizador contínuo e bidirecional entre o aplicativo Nova OS e o MySQL (phpMyAdmin do CloudPanel)
import mysql from 'mysql2/promise';

export const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'osrufato',
  password: process.env.MYSQL_PASSWORD || 'a888zBgiSoBXlHYRCA2t',
  database: process.env.MYSQL_DATABASE || 'osrufato',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
};

let pool = null;
let syncRunning = false;

const TABLES = [
  { name: 'settings', pk: 'key' },
  { name: 'sectors', pk: 'id' },
  { name: 'teams', pk: 'id' },
  { name: 'users', pk: 'id' },
  { name: 'machines', pk: 'id' },
  { name: 'work_orders', pk: 'id' },
  { name: 'wo_participants', composite: ['wo_id', 'user_id'] },
  { name: 'work_intervals', pk: 'id' },
  { name: 'wo_events', pk: 'id' },
  { name: 'attachments', pk: 'id' },
  { name: 'machine_stops', pk: 'id' },
  { name: 'preventive_plans', pk: 'id' },
  { name: 'notifications', pk: 'id' },
  { name: 'processed_ops', pk: 'op_id' },
  { name: 'conflicts', pk: 'id' },
  { name: 'audit_log', pk: 'id' },
  { name: 'sessions', pk: 'token' },
];

export async function initMySQLSync(sqliteDb) {
  try {
    pool = mysql.createPool(MYSQL_CONFIG);
    const conn = await pool.getConnection();
    console.log('[MySQL] Conexão com o banco phpMyAdmin (osrufato) estabelecida!');
    conn.release();

    // Sincroniza imediatamente na inicialização
    await syncAllToMySQL(sqliteDb);

    // Agenda sincronização contínua a cada 5 segundos
    setInterval(() => {
      syncAllToMySQL(sqliteDb).catch((e) => console.warn('[MySQL Sync] Erro no ciclo:', e.message));
    }, 5000);
  } catch (err) {
    console.warn('[MySQL Sync] Não foi possível conectar ao MySQL localmente (seguirá usando SQLite):', err.message);
  }
}

export async function syncAllToMySQL(sqliteDb) {
  if (!pool || syncRunning) return;
  syncRunning = true;

  try {
    for (const t of TABLES) {
      const rows = sqliteDb.prepare(`SELECT * FROM ${t.name}`).all();
      if (!rows || rows.length === 0) continue;

      const cols = Object.keys(rows[0]);
      const colNames = cols.map((c) => `\`${c}\``).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const updateClause = cols.map((c) => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');

      const query = `INSERT INTO \`${t.name}\` (${colNames}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateClause}`;

      for (const r of rows) {
        const vals = cols.map((c) => r[c] !== undefined ? r[c] : null);
        await pool.execute(query, vals);
      }
    }
  } catch (err) {
    console.warn('[MySQL Sync] Falha na sincronização:', err.message);
  } finally {
    syncRunning = false;
  }
}
