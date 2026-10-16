import { openDb } from '../server/db.js';

function mergeUsers() {
  const db = openDb();

  console.log('--- Iniciando unificação de usuários ---');

  // Grupos a unificar:
  // 1. Diego (Diego, Diego Júnior, Diego junio) -> manter Diego Júnior
  // 2. Franciel (Franciel, Franciel Mendes, Franciel Meneses) -> manter Franciel Mendes
  // 3. Junim (JUNIM, JUNIM líder, JUNIM líder setor) -> manter Junim (Líder)
  // 4. Talis (Tales, Talis, Tallis, Talos) -> manter Talis

  const allUsers = db.prepare('SELECT id, name, username, role, email FROM users').all();

  const groups = [
    {
      name: 'Diego',
      matcher: (u) => /diego/i.test(u.name) || /diego/i.test(u.username),
      pickPrimary: (list) => list.find((u) => /j[uú]nior/i.test(u.name)) || list[0],
      finalName: 'Diego Júnior',
      finalUsername: 'diegojunior'
    },
    {
      name: 'Franciel',
      matcher: (u) => /franciel/i.test(u.name) || /franciel/i.test(u.username),
      pickPrimary: (list) => list.find((u) => /mendes/i.test(u.name)) || list[0],
      finalName: 'Franciel Mendes',
      finalUsername: 'francielmendes'
    },
    {
      name: 'Junim',
      matcher: (u) => /junim/i.test(u.name) || /junim/i.test(u.username),
      pickPrimary: (list) => list.find((u) => /l[ií]der/i.test(u.name)) || list[0],
      finalName: 'Junim (Líder)',
      finalUsername: 'junim'
    },
    {
      name: 'Talis',
      matcher: (u) => /^(tales|talis|tallis|talos)/i.test(u.name) || /^(tales|talis|tallis|talos)/i.test(u.username),
      pickPrimary: (list) => list.find((u) => /^talis/i.test(u.name)) || list[0],
      finalName: 'Talis',
      finalUsername: 'talis'
    },
    {
      name: 'Ranieri / Raliele',
      matcher: (u) => /^(raliele|ranieri)/i.test(u.name) || /^(raliele|ranieri)/i.test(u.username),
      pickPrimary: (list) => list.find((u) => /^ranieri/i.test(u.name)) || list[0],
      finalName: 'Ranieri',
      finalUsername: 'ranieri'
    },
    {
      name: 'Rherisson / Rhe',
      matcher: (u) => /^(rhe$|rherisson)/i.test(u.name) || /^(rhe_-|rherisson)/i.test(u.username),
      pickPrimary: (list) => list.find((u) => /^rherisson/i.test(u.name)) || list[0],
      finalName: 'Rherisson',
      finalUsername: 'rherisson'
    },
    {
      name: 'Ronielly / Ronielliy',
      matcher: (u) => /^roniell/i.test(u.name) || /^roniell/i.test(u.username),
      pickPrimary: (list) => list.find((u) => /^ronielly$/i.test(u.name)) || list[0],
      finalName: 'Ronielly',
      finalUsername: 'ronielly'
    }
  ];

  db.exec('BEGIN TRANSACTION;');
  try {
    for (const g of groups) {
      const matched = allUsers.filter(g.matcher);
      if (matched.length <= 1) {
        console.log(`[${g.name}] Apenas ${matched.length} usuário encontrado. Pulando.`);
        continue;
      }

      const primary = g.pickPrimary(matched);
      const secondaries = matched.filter((u) => u.id !== primary.id);

      console.log(`\nUnificando grupo "${g.name}":`);
      console.log(`  -> Usuário Principal a Manter: [${primary.id}] "${primary.name}" (@${primary.username})`);
      console.log(`  -> Secundários a Absorver:`);
      for (const s of secondaries) {
        const wosCount = db.prepare('SELECT COUNT(*) n FROM work_orders WHERE requester_id = ? OR responsible_id = ?').get(s.id, s.id).n;
        console.log(`     - [${s.id}] "${s.name}" (@${s.username}) com ${wosCount} OS vinculada(s)`);
      }

      for (const s of secondaries) {
        // 1. work_orders
        const reqWos = db.prepare('UPDATE work_orders SET requester_id = ? WHERE requester_id = ?').run(primary.id, s.id);
        const respWos = db.prepare('UPDATE work_orders SET responsible_id = ? WHERE responsible_id = ?').run(primary.id, s.id);

        // 2. wo_participants (evita conflito UNIQUE de primaryId + woId)
        db.prepare(`
          DELETE FROM wo_participants 
          WHERE user_id = ? 
            AND wo_id IN (SELECT wo_id FROM wo_participants WHERE user_id = ?)
        `).run(s.id, primary.id);
        const parts = db.prepare('UPDATE wo_participants SET user_id = ? WHERE user_id = ?').run(primary.id, s.id);

        // 3. work_intervals
        const ivs = db.prepare('UPDATE work_intervals SET user_id = ? WHERE user_id = ?').run(primary.id, s.id);

        // 4. wo_events
        const evs = db.prepare('UPDATE wo_events SET user_id = ? WHERE user_id = ?').run(primary.id, s.id);

        // 5. attachments
        const atts = db.prepare('UPDATE attachments SET user_id = ? WHERE user_id = ?').run(primary.id, s.id);

        // 6. audit_log
        db.prepare('UPDATE audit_log SET user_id = ? WHERE user_id = ?').run(primary.id, s.id);

        // 7. Limpezas de sessões, notificações e push do usuário secundário
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(s.id);
        db.prepare('DELETE FROM notifications WHERE user_id = ?').run(s.id);
        db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(s.id);

        // 8. Exclui o usuário secundário
        db.prepare('DELETE FROM users WHERE id = ?').run(s.id);
        console.log(`     ✓ Migrado [${s.id}]: ${reqWos.changes} OS sol., ${respWos.changes} OS resp., ${parts.changes} part., ${ivs.changes} interv., ${evs.changes} eventos.`);
      }

      // Atualiza o principal para o nome e login final limpos
      // Se outro usuário tiver esse finalUsername, verifica antes
      const usernameConflict = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(g.finalUsername, primary.id);
      const cleanUser = usernameConflict ? primary.username : g.finalUsername;

      db.prepare('UPDATE users SET name = ?, username = ? WHERE id = ?').run(g.finalName, cleanUser, primary.id);
      console.log(`  => Usuário final atualizado para Nome: "${g.finalName}", Login: "${cleanUser}"`);
    }

    db.exec('COMMIT;');
    console.log('\n--- Unificação concluída com sucesso! ---');
  } catch (err) {
    db.exec('ROLLBACK;');
    console.error('Erro na transação de unificação:', err);
    throw err;
  }
}

mergeUsers();
