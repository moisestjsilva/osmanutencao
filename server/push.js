// Módulo de Notificações Web Push (VAPID + RFC 8030)
// Permite alertar manutentores e gestores mesmo com o aparelho bloqueado,
// aplicativo minimizado ou tela desligada.
import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import { getSetting, setSetting } from './domain.js';

let vapidInitialized = false;

/**
 * Garante que as chaves VAPID estejam geradas e configuradas.
 * As chaves são persistidas na tabela 'settings' para manter a mesma identidade VAPID.
 */
export function ensureVapid(db) {
  if (vapidInitialized) return;

  let pubKey = getSetting(db, 'vapid_public_key');
  let privKey = getSetting(db, 'vapid_private_key');
  let subject = getSetting(db, 'vapid_subject') || 'mailto:admin@manutencao.local';

  if (!pubKey || !privKey) {
    const keys = webpush.generateVAPIDKeys();
    pubKey = keys.publicKey;
    privKey = keys.privateKey;
    setSetting(db, 'vapid_public_key', pubKey);
    setSetting(db, 'vapid_private_key', privKey);
    setSetting(db, 'vapid_subject', subject);
  }

  webpush.setVapidDetails(subject, pubKey, privKey);
  vapidInitialized = true;
}

/**
 * Retorna a chave pública VAPID necessária para o navegador assinar o push.
 */
export function getVapidPublicKey(db) {
  ensureVapid(db);
  return getSetting(db, 'vapid_public_key');
}

/**
 * Salva ou atualiza a inscrição push de um usuário específico.
 */
export function saveSubscription(db, userId, subscription, userAgent = '') {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error('Formato de subscrição push inválido');
  }

  const { endpoint, keys } = subscription;
  const p256dh = keys.p256dh;
  const auth = keys.auth;

  if (!p256dh || !auth) {
    throw new Error('Chaves de criptografia da subscrição ausentes');
  }

  const now = new Date().toISOString();

  // Verifica se o endpoint já existe
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint=?').get(endpoint);
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET user_id=?, p256dh=?, auth=?, user_agent=?, created_at=? WHERE id=?')
      .run(userId, p256dh, auth, userAgent, now, existing.id);
    return existing.id;
  } else {
    const id = randomUUID();
    db.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, endpoint, p256dh, auth, userAgent, now);
    return id;
  }
}

/**
 * Remove uma subscrição por endpoint (ex: logout ou permissão revogada).
 */
export function removeSubscription(db, endpoint) {
  if (!endpoint) return;
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
}

/**
 * Envia notificação Web Push para uma lista de usuários.
 * Limpa automaticamente subscrições inválidas ou expiradas (404 / 410 Gone).
 */
export async function sendPushToUsers(db, userIds, payload) {
  try {
    ensureVapid(db);
  } catch (e) {
    console.error('[WebPush] Falha ao inicializar VAPID:', e.message);
    return;
  }

  const uniqueUserIds = [...new Set(userIds)].filter(Boolean);
  if (!uniqueUserIds.length) return;

  const placeholders = uniqueUserIds.map(() => '?').join(',');
  const subscriptions = db.prepare(
    `SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${placeholders})`
  ).all(...uniqueUserIds);

  if (!subscriptions.length) {
    return;
  }

  const payloadString = JSON.stringify({
    title: payload.title || 'Nova OS - Manutenção',
    body: payload.body || 'Você possui uma nova notificação de serviço.',
    woId: payload.woId || null,
    kind: payload.kind || 'alerta',
    url: payload.woId ? `/#/os/${payload.woId}` : '/#/avisos',
    timestamp: Date.now()
  });

  const pushOptions = {
    TTL: 60 * 60 * 24, // 24 horas de validade na fila do serviço Push
    urgency: 'high'
  };

  const tasks = subscriptions.map(async (sub) => {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth
      }
    };

    try {
      await webpush.sendNotification(pushSubscription, payloadString, pushOptions);
    } catch (err) {
      // 404 Not Found ou 410 Gone indicam que o usuário revogou permissão ou trocou de navegador
      if (err.statusCode === 404 || err.statusCode === 410) {
        try {
          db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
        } catch {}
      } else {
        console.warn(`[WebPush] Erro ao enviar push para usuário ${sub.user_id} (${err.statusCode || err.code}): ${err.message}`);
      }
    }
  });

  // Executa em paralelo sem travar a requisição principal
  await Promise.allSettled(tasks);
}
