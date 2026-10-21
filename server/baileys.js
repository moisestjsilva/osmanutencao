/**
 * ===================================================================
 * MÓDULO BAILEYS - CONEXÃO NATIVA WHATSAPP (SEM DOCKER)
 * ===================================================================
 * Gerencia a sessão multi-dispositivo do WhatsApp Web diretamente no
 * Node.js, com persistência local de credenciais em data/whatsapp_auth/.
 * ===================================================================
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

const AUTH_DIR = path.resolve(process.cwd(), 'data', 'whatsapp_auth');

let sock = null;
let currentQrRaw = null;
let currentQrDataUrl = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let connectedUser = null;
let reconnectTimer = null;

// Garante que o diretório de autenticação existe
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

export function getBaileysStatus() {
  return {
    status: connectionStatus,
    user: connectedUser,
    qrCode: currentQrDataUrl,
    hasAuth: fs.existsSync(path.join(AUTH_DIR, 'creds.json')),
  };
}

export async function initBaileys(forceNew = false) {
  if (forceNew && sock) {
    try {
      sock.end(undefined);
    } catch (_) {}
    sock = null;
  }

  if (sock && connectionStatus === 'connected') {
    return { status: connectionStatus, user: connectedUser };
  }

  connectionStatus = 'connecting';
  console.info('[WhatsApp-Baileys] Iniciando serviço WhatsApp nativo...');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version = undefined;
  try {
    const vInfo = await fetchLatestBaileysVersion();
    version = vInfo.version;
  } catch (_) {
    // Usa a versão padrão empacotada
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['Nova OS Manutenção', 'Chrome', '1.0.0'],
    defaultQueryTimeoutMs: 60000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQrRaw = qr;
      try {
        currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
      } catch (err) {
        console.error('[WhatsApp-Baileys] Erro ao converter QR Code:', err.message);
      }
      connectionStatus = 'connecting';
      console.info('[WhatsApp-Baileys] Novo QR Code gerado! Acesse /whatsapp ou escaneie no terminal.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'disconnected';
      connectedUser = null;

      console.warn(
        `[WhatsApp-Baileys] Conexão encerrada (código: ${statusCode || 'desconhecido'}). Reconectar: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            initBaileys();
          }, 4000);
        }
      } else {
        // Deslogado explicitamente pelo celular -> limpa credenciais
        console.warn('[WhatsApp-Baileys] Sessão desconectada pelo aparelho. Limpando credenciais antigas.');
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        } catch (_) {}
        currentQrDataUrl = null;
        currentQrRaw = null;
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      currentQrDataUrl = null;
      currentQrRaw = null;
      connectedUser = sock.user;
      console.info(
        `[WhatsApp-Baileys] ✅ WHATSAPP CONECTADO COM SUCESSO! ID: ${connectedUser?.id || 'Conectado'}`
      );
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) {
      if (!m.message) continue;
      if (m.key.fromMe) continue;

      const jid = m.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.imageMessage?.caption ||
        '';

      if (!text || !text.trim()) continue;

      const pushName = m.pushName || '';
      const isGroup = jid.endsWith('@g.us');
      const sender = isGroup ? (m.key.participant || jid) : jid;

      if (incomingMessageHandler) {
        try {
          await incomingMessageHandler({
            jid,
            sender,
            text: text.trim(),
            pushName,
            isGroup,
            reply: async (replyText) => {
              return await sendBaileysMessage({ to: jid, text: replyText });
            },
          });
        } catch (err) {
          console.error('[WhatsApp-Baileys] Erro no processamento da mensagem recebida:', err.message);
        }
      }
    }
  });

  return { status: connectionStatus };
}

let incomingMessageHandler = null;

export function onBaileysMessage(handler) {
  incomingMessageHandler = handler;
}

/**
 * Envia mensagem via Baileys para número ou ID de grupo
 */
export async function sendBaileysMessage({ to, text }) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp não está conectado. Acesse /whatsapp para escanear o QR Code.');
  }

  let jid = String(to || '').trim();

  // Tratamento de JID
  if (jid.includes('@g.us') || jid.includes('@s.whatsapp.net')) {
    // Já possui o sufixo correto
  } else if (jid.length > 15) {
    // Provavelmente ID de grupo sem sufixo
    jid = `${jid}@g.us`;
  } else {
    // Número individual: limpa caracteres não numéricos
    const cleanNumber = jid.replace(/\D/g, '');
    jid = `${cleanNumber}@s.whatsapp.net`;
  }

  const result = await sock.sendMessage(jid, { text });
  return { success: true, provider: 'baileys', messageId: result.key?.id, to: jid };
}

/**
 * Entra em um grupo via link de convite (ex: https://chat.whatsapp.com/HHkKt72CIvQ9Ez8cnJA5dU)
 * e retorna o JID (@g.us) do grupo.
 */
export async function joinGroupByInvite(inviteLinkOrCode) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp precisa estar conectado para entrar no grupo.');
  }

  let code = String(inviteLinkOrCode || '').trim();
  const match = code.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  if (match) {
    code = match[1];
  }

  try {
    const groupJid = await sock.groupAcceptInvite(code);
    return { success: true, groupJid: `${groupJid}@g.us` };
  } catch (err) {
    // Se já estiver no grupo, tenta obter metadados
    throw new Error(`Falha ao entrar no grupo via convite: ${err.message}`);
  }
}

/**
 * Lista todos os grupos dos quais o WhatsApp conectado participa
 */
export async function listParticipatingGroups() {
  if (!sock || connectionStatus !== 'connected') {
    return [];
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({
      id: g.id,
      subject: g.subject,
      participantsCount: g.participants?.length || 0,
      creation: g.creation,
    }));
  } catch (err) {
    console.warn('[WhatsApp-Baileys] Erro ao listar grupos:', err.message);
    return [];
  }
}

/**
 * Desconecta e limpa sessão
 */
export async function disconnectBaileys() {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
      sock.end(undefined);
    }
  } catch (_) {}

  sock = null;
  connectionStatus = 'disconnected';
  connectedUser = null;
  currentQrDataUrl = null;
  currentQrRaw = null;

  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  } catch (_) {}

  return { success: true, message: 'Sessão desconectada e credenciais removidas.' };
}
