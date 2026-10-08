import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'data', 'nova-os.db');

export const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'osrufato',
  password: process.env.MYSQL_PASSWORD || 'a888zBgiSoBXlHYRCA2t',
  database: process.env.MYSQL_DATABASE || 'osrufato',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

const TABLES_DDL = `
CREATE TABLE IF NOT EXISTS settings (
  \`key\` VARCHAR(191) PRIMARY KEY,
  \`value\` LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sectors (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`code\` VARCHAR(64) NOT NULL UNIQUE,
  \`name\` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS teams (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`name\` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`name\` VARCHAR(255) NOT NULL,
  \`email\` VARCHAR(191),
  \`username\` VARCHAR(191),
  \`role\` VARCHAR(32) NOT NULL,
  \`team_id\` VARCHAR(64),
  \`sector_id\` VARCHAR(64),
  \`specialty\` VARCHAR(255),
  \`password_hash\` VARCHAR(255),
  \`salt\` VARCHAR(255),
  \`active\` TINYINT(1) NOT NULL DEFAULT 1,
  \`avatar_url\` LONGTEXT,
  \`created_at\` VARCHAR(64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS machines (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`code\` VARCHAR(64) NOT NULL UNIQUE,
  \`name\` VARCHAR(255) NOT NULL,
  \`sector_id\` VARCHAR(64) NOT NULL,
  \`criticality\` VARCHAR(32) NOT NULL DEFAULT 'media',
  \`active\` TINYINT(1) NOT NULL DEFAULT 1,
  \`hourly_cost\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  \`operating_hours_per_day\` DECIMAL(6,2) NOT NULL DEFAULT 8.00,
  \`image_url\` LONGTEXT,
  \`default_checklist_json\` LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS work_orders (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`number\` VARCHAR(64) UNIQUE,
  \`machine_id\` VARCHAR(64) NOT NULL,
  \`type\` VARCHAR(32) NOT NULL,
  \`priority\` VARCHAR(32) NOT NULL DEFAULT 'media',
  \`machine_stopped\` TINYINT(1) NOT NULL DEFAULT 0,
  \`requester_id\` VARCHAR(64),
  \`responsible_id\` VARCHAR(64),
  \`status\` VARCHAR(32) NOT NULL DEFAULT 'Aberta',
  \`title\` VARCHAR(255),
  \`description\` LONGTEXT NOT NULL,
  \`specialty\` VARCHAR(255),
  \`recipients_mode\` VARCHAR(32) NOT NULL DEFAULT 'todos',
  \`recipients_json\` LONGTEXT,
  \`service_done\` LONGTEXT,
  \`cause\` LONGTEXT,
  \`solution\` LONGTEXT,
  \`materials_used\` LONGTEXT,
  \`tools_used\` LONGTEXT,
  \`notes\` LONGTEXT,
  \`machine_recovered\` TINYINT(1),
  \`returned_at\` VARCHAR(64),
  \`checklist_json\` LONGTEXT,
  \`plan_id\` VARCHAR(64),
  \`cycle_key\` VARCHAR(191) UNIQUE,
  \`due_date\` VARCHAR(64),
  \`reopened_count\` INT NOT NULL DEFAULT 0,
  \`rework_of\` VARCHAR(64),
  \`created_at\` VARCHAR(64) NOT NULL,
  \`received_at\` VARCHAR(64) NOT NULL,
  \`closed_at\` VARCHAR(64),
  \`cancelled_reason\` LONGTEXT,
  \`version\` INT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wo_participants (
  \`wo_id\` VARCHAR(64) NOT NULL,
  \`user_id\` VARCHAR(64) NOT NULL,
  \`role\` VARCHAR(32) NOT NULL DEFAULT 'colaborador',
  \`state\` VARCHAR(32) NOT NULL DEFAULT 'aguardando',
  \`joined_at\` VARCHAR(64) NOT NULL,
  PRIMARY KEY (\`wo_id\`, \`user_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS work_intervals (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`wo_id\` VARCHAR(64) NOT NULL,
  \`user_id\` VARCHAR(64) NOT NULL,
  \`started_at\` VARCHAR(64) NOT NULL,
  \`ended_at\` VARCHAR(64),
  \`end_reason\` LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wo_events (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`wo_id\` VARCHAR(64) NOT NULL,
  \`user_id\` VARCHAR(64),
  \`action\` VARCHAR(64) NOT NULL,
  \`reason\` LONGTEXT,
  \`data_json\` LONGTEXT,
  \`local_time\` VARCHAR(64) NOT NULL,
  \`received_at\` VARCHAR(64) NOT NULL,
  \`origin\` VARCHAR(32) NOT NULL DEFAULT 'online'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attachments (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`wo_id\` VARCHAR(64) NOT NULL,
  \`user_id\` VARCHAR(64),
  \`file\` VARCHAR(255) NOT NULL,
  \`mime\` VARCHAR(64),
  \`size\` INT,
  \`created_at\` VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS machine_stops (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`machine_id\` VARCHAR(64) NOT NULL,
  \`started_at\` VARCHAR(64) NOT NULL,
  \`ended_at\` VARCHAR(64),
  \`wo_ids_json\` LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS preventive_plans (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`machine_id\` VARCHAR(64) NOT NULL,
  \`title\` VARCHAR(255) NOT NULL,
  \`frequency_days\` INT NOT NULL,
  \`anchor_date\` VARCHAR(64) NOT NULL,
  \`next_due\` VARCHAR(64) NOT NULL,
  \`lead_days\` INT NOT NULL DEFAULT 2,
  \`tolerance_days\` INT NOT NULL DEFAULT 0,
  \`checklist_json\` LONGTEXT,
  \`responsible_id\` VARCHAR(64),
  \`active\` TINYINT(1) NOT NULL DEFAULT 1,
  \`created_at\` VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`wo_id\` VARCHAR(64),
  \`user_id\` VARCHAR(64) NOT NULL,
  \`channel\` VARCHAR(32) NOT NULL DEFAULT 'app',
  \`kind\` VARCHAR(32) NOT NULL,
  \`title\` VARCHAR(255) NOT NULL,
  \`body\` LONGTEXT,
  \`status\` VARCHAR(32) NOT NULL DEFAULT 'enviada',
  \`attempts\` INT NOT NULL DEFAULT 1,
  \`created_at\` VARCHAR(64) NOT NULL,
  \`read_at\` VARCHAR(64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS processed_ops (
  \`op_id\` VARCHAR(64) PRIMARY KEY,
  \`user_id\` VARCHAR(64),
  \`type\` VARCHAR(64),
  \`status\` VARCHAR(32) NOT NULL,
  \`result_json\` LONGTEXT,
  \`local_time\` VARCHAR(64),
  \`received_at\` VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conflicts (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`op_id\` VARCHAR(64) NOT NULL,
  \`wo_id\` VARCHAR(64),
  \`user_id\` VARCHAR(64),
  \`type\` VARCHAR(64),
  \`payload_json\` LONGTEXT,
  \`reason\` LONGTEXT NOT NULL,
  \`created_at\` VARCHAR(64) NOT NULL,
  \`resolved_at\` VARCHAR(64),
  \`resolved_by\` VARCHAR(64),
  \`resolution\` LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`entity\` VARCHAR(64) NOT NULL,
  \`entity_id\` VARCHAR(64) NOT NULL,
  \`field\` VARCHAR(64),
  \`old_value\` LONGTEXT,
  \`new_value\` LONGTEXT,
  \`reason\` LONGTEXT,
  \`user_id\` VARCHAR(64),
  \`created_at\` VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  \`token\` VARCHAR(128) PRIMARY KEY,
  \`user_id\` VARCHAR(64) NOT NULL,
  \`created_at\` VARCHAR(64) NOT NULL,
  \`expires_at\` VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

export async function migrateAndSyncToMySQL() {
  console.log('[MySQL] Conectando ao MySQL em', MYSQL_CONFIG.host, 'banco', MYSQL_CONFIG.database, '...');
  const pool = mysql.createPool(MYSQL_CONFIG);

  try {
    const conn = await pool.getConnection();
    console.log('[MySQL] Conexão estabelecida com sucesso!');
    conn.release();

    // 1. Criar tabelas se não existirem
    const statements = TABLES_DDL.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const sql of statements) {
      await pool.query(sql);
    }
    console.log('[MySQL] Todas as 17 tabelas verificadas/criadas no MySQL com sucesso!');

    // 2. Se houver banco SQLite local/remoto, sincroniza todos os dados para o MySQL
    const sqliteDb = new DatabaseSync(DB_FILE);
    const tables = [
      'settings', 'sectors', 'teams', 'users', 'machines',
      'work_orders', 'wo_participants', 'work_intervals', 'wo_events',
      'attachments', 'machine_stops', 'preventive_plans', 'notifications',
      'processed_ops', 'conflicts', 'audit_log', 'sessions'
    ];

    for (const tbl of tables) {
      try {
        const rows = sqliteDb.prepare(`SELECT * FROM ${tbl}`).all();
        if (!rows || rows.length === 0) continue;

        const first = rows[0];
        const cols = Object.keys(first);
        const colNames = cols.map((c) => `\`${c}\``).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const updateClause = cols.map((c) => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');

        const insertSql = `INSERT INTO \`${tbl}\` (${colNames}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateClause}`;

        for (const row of rows) {
          const vals = cols.map((c) => row[c] !== undefined ? row[c] : null);
          await pool.execute(insertSql, vals);
        }
        console.log(`[MySQL] Tabela ${tbl}: ${rows.length} registro(s) sincronizado(s).`);
      } catch (err) {
        console.warn(`[MySQL] Aviso ao sincronizar ${tbl}:`, err.message);
      }
    }

    console.log('[MySQL] Sincronização inicial concluída com sucesso!');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate-to-mysql.js')) {
  migrateAndSyncToMySQL()
    .then(() => {
      console.log('Migração finalizada.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Erro na migração:', err);
      process.exit(1);
    });
}
