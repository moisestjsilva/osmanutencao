// Módulo de Autenticação, Criptografia e Sessões (Nova OS)
import crypto from 'node:crypto';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  if (!hash || !salt || !password) return false;
  try {
    const computed = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    return false;
  }
}

export function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function migrateAuth(db) {
  // 1. Cria tabela de sessões
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  // 2. Verifica se a tabela users suporta superadmin e admin
  const userTableDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql || '';
  if (!userTableDef.includes('superadmin')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      CREATE TABLE users_migrated (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        username TEXT,
        role TEXT NOT NULL CHECK (role IN ('superadmin','admin','manutentor','solicitante','gerente')),
        team_id TEXT REFERENCES teams(id),
        specialty TEXT,
        password_hash TEXT,
        salt TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT
      );
    `);

    // Copia dados existentes preservando colunas que existirem
    const tableInfo = db.prepare("PRAGMA table_info('users')").all();
    const cols = tableInfo.map((c) => c.name);
    const hasEmail = cols.includes('email');
    const hasUsername = cols.includes('username');
    const hasHash = cols.includes('password_hash');
    const hasSalt = cols.includes('salt');
    const hasCreatedAt = cols.includes('created_at');

    db.exec(`
      INSERT INTO users_migrated (id, name, email, username, role, team_id, specialty, password_hash, salt, active, created_at)
      SELECT id, name,
             ${hasEmail ? 'email' : 'NULL'},
             ${hasUsername ? 'username' : 'NULL'},
             role, team_id, specialty,
             ${hasHash ? 'password_hash' : 'NULL'},
             ${hasSalt ? 'salt' : 'NULL'},
             active,
             ${hasCreatedAt ? 'created_at' : 'NULL'}
      FROM users;
    `);

    db.exec(`
      DROP TABLE users;
      ALTER TABLE users_migrated RENAME TO users;
      PRAGMA foreign_keys = ON;
    `);
  }

  // Cria índices únicos
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
}

export function seedAuthUsers(db) {
  migrateAuth(db);

  const now = new Date().toISOString();

  // 1. SUPER ADMIN: Moisés Silva (moisestj86@gmail.com)
  const existingSuper = db.prepare("SELECT * FROM users WHERE LOWER(email) = 'moisestj86@gmail.com' OR id = 'u-superadmin'").get();
  if (!existingSuper) {
    const { hash, salt } = hashPassword('admin123');
    db.prepare(`
      INSERT INTO users (id, name, email, username, role, specialty, password_hash, salt, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      'u-superadmin',
      'Moisés Silva (Super Admin)',
      'moisestj86@gmail.com',
      'moises',
      'superadmin',
      'Super Administrador do Sistema',
      hash,
      salt,
      now
    );
    console.log('[Auth] Super Admin criado: moisestj86@gmail.com (senha: admin123)');
  } else {
    // Garante que é superadmin e tem email
    db.prepare(`
      UPDATE users SET role = 'superadmin', email = 'moisestj86@gmail.com', username = COALESCE(username, 'moises')
      WHERE id = ?
    `).run(existingSuper.id);
  }

  // 2. ADMIN GERAL: admin@rufato.com.br
  const existingAdmin = db.prepare("SELECT * FROM users WHERE LOWER(username) = 'admin' OR LOWER(email) = 'admin@rufato.com.br'").get();
  if (!existingAdmin) {
    const { hash, salt } = hashPassword('admin123');
    db.prepare(`
      INSERT INTO users (id, name, email, username, role, specialty, password_hash, salt, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      'u-admin-rufato',
      'Administrador Geral',
      'admin@rufato.com.br',
      'admin',
      'admin',
      'Gestão de Manutenção e Manutentores',
      hash,
      salt,
      now
    );
    console.log('[Auth] Admin criado: admin@rufato.com.br (senha: admin123)');
  }

  // Atualiza Gisele Ramos para Admin
  const gisele = db.prepare("SELECT * FROM users WHERE id = 'u-gerente'").get();
  if (gisele) {
    const { hash, salt } = hashPassword('admin123');
    db.prepare(`
      UPDATE users SET role = 'admin', email = COALESCE(email, 'gisele@rufato.com.br'),
                       username = COALESCE(username, 'gisele'),
                       password_hash = COALESCE(password_hash, ?),
                       salt = COALESCE(salt, ?)
      WHERE id = 'u-gerente'
    `).run(hash, salt);
  }

  // 3. MANUTENTORES REAIS: definir username amigável e senha padrão (123456)
  const defaultTechPass = hashPassword('123456');
  const techs = db.prepare("SELECT * FROM users WHERE role = 'manutentor'").all();

  for (const t of techs) {
    const rawClean = t.name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
    const cleanUsername = rawClean.split('/')[0].slice(0, 20) || `user${t.id.slice(-4)}`;
    const email = `${cleanUsername}@rufato.com.br`;

    db.prepare(`
      UPDATE users
      SET username = COALESCE(username, ?),
          email = COALESCE(email, ?),
          password_hash = COALESCE(password_hash, ?),
          salt = COALESCE(salt, ?),
          created_at = COALESCE(created_at, ?)
      WHERE id = ?
    `).run(cleanUsername, email, defaultTechPass.hash, defaultTechPass.salt, now, t.id);
  }

  // 4. Solicitantes: se não tiverem senha, define padrão
  const defaultSolPass = hashPassword('123456');
  const others = db.prepare("SELECT * FROM users WHERE password_hash IS NULL").all();
  for (const o of others) {
    const cleanU = o.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '').slice(0, 15) || `user_${o.id.slice(-4)}`;
    db.prepare(`
      UPDATE users
      SET username = COALESCE(username, ?),
          password_hash = ?,
          salt = ?,
          created_at = COALESCE(created_at, ?)
      WHERE id = ?
    `).run(cleanU + '_' + o.id.slice(-3), defaultSolPass.hash, defaultSolPass.salt, now, o.id);
  }
}

export function createSession(db, userId, days = 30) {
  const token = createToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 86400000).toISOString();

  db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, now.toISOString(), expiresAt);

  return { token, expiresAt };
}

export function getSessionUser(db, token) {
  if (!token) return null;
  const now = new Date().toISOString();
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, u.username, u.role, u.team_id, u.specialty, u.active, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1
  `).get(token, now);

  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username,
    role: row.role,
    teamId: row.team_id,
    specialty: row.specialty,
    active: !!row.active
  };
}

export function deleteSession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function cleanExpiredSessions(db) {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}
