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
  downloadMediaMessage,
  extractMessageContent,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { UPLOAD_DIR } from './db.js';

const AUTH_DIR = path.resolve(process.cwd(), 'data', 'whatsapp_auth');

let sock = null;
let currentQrRaw = null;
let currentQrDataUrl = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let connectedUser = null;
let reconnectTimer = null;
let isInitializing = false;

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
  if (isInitializing && !forceNew) {
    console.info('[WhatsApp-Baileys] Inicialização já em andamento, aguardando...');
    return { status: connectionStatus, user: connectedUser };
  }

  if (sock && connectionStatus === 'connected' && !forceNew) {
    return { status: connectionStatus, user: connectedUser };
  }

  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    } catch (_) {}
    sock = null;
  }

  isInitializing = true;
  connectionStatus = 'connecting';
  console.info('[WhatsApp-Baileys] Iniciando serviço WhatsApp nativo...');

  try {
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
        isInitializing = false;
        console.info('[WhatsApp-Baileys] Novo QR Code gerado! Acesse /whatsapp ou escaneie no terminal.');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = 'disconnected';
        connectedUser = null;
        isInitializing = false;

        console.warn(
          `[WhatsApp-Baileys] Conexão encerrada (código: ${statusCode || 'desconhecido'}). Reconectar: ${shouldReconnect}`
        );

        if (shouldReconnect) {
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              initBaileys();
            }, 5000);
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
        isInitializing = false;
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

      const content = extractMessageContent(m.message);
      if (!content) continue;

      const imageMsg = content.imageMessage || (content.documentMessage?.mimetype?.startsWith('image/') ? content.documentMessage : null);

      let text =
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.documentMessage?.caption ||
        '';

      let mediaAttachment = null;
      if (imageMsg) {
        try {
          const buffer = await downloadMediaMessage(
            m,
            'buffer',
            {},
            {
              logger: pino({ level: 'silent' }),
              reuploadRequest: sock?.updateMediaMessage,
            }
          );
          if (buffer && buffer.length > 0) {
            const mime = imageMsg.mimetype || 'image/jpeg';
            const ext = mime.includes('png') ? 'png' : (mime.includes('webp') ? 'webp' : 'jpg');
            const attId = randomUUID();
            const filename = `wa-${Date.now()}-${attId.slice(0, 8)}.${ext}`;
            const filepath = path.join(UPLOAD_DIR, filename);
            fs.writeFileSync(filepath, buffer);
            mediaAttachment = {
              id: attId,
              file: filename,
              mime,
              size: buffer.length,
            };
            console.log(`[WhatsApp-Baileys] 📸 Foto recebida e salva com sucesso: ${filename} (${buffer.length} bytes)`);
          }
        } catch (mediaErr) {
          console.error('[WhatsApp-Baileys] Erro ao baixar foto recebida:', mediaErr.message);
        }
      }

      if (!text && mediaAttachment) {
        text = 'Registro fotográfico anexado';
      }

      if (!text || !text.trim()) continue;

      const pushName = m.pushName || '';
      const isGroup = jid.endsWith('@g.us');
      let sender = isGroup ? (m.key.participant || jid) : jid;

      // WhatsApp moderno usa LID (ID de privacidade) em vez do telefone.
      // Tenta resolver o número real (PN) para identificar o colaborador.
      if (sender.endsWith('@lid')) {
        const alt = isGroup ? m.key.participantAlt : m.key.remoteJidAlt;
        let pn = alt && alt.includes('@s.whatsapp.net') ? alt : null;
        if (!pn) {
          try {
            pn = await sock.signalRepository?.lidMapping?.getPNForLID(sender);
          } catch (_) {}
        }
        console.log(`[WhatsApp-Baileys] 🔎 LID ${sender} -> telefone ${pn || 'não resolvido'}`);
        if (pn) sender = pn;
      }

      if (incomingMessageHandler) {
        try {
          await incomingMessageHandler({
            jid,
            sender,
            text: text.trim(),
            pushName,
            isGroup,
            mediaAttachment,
            presence: async (presenceType) => {
              if (sock && connectionStatus === 'connected') {
                try {
                  const targetJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
                  await sock.sendPresenceUpdate(presenceType, targetJid);
                } catch (_) {}
              }
            },
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
  } catch (err) {
    isInitializing = false;
    connectionStatus = 'disconnected';
    console.error('[WhatsApp-Baileys] Erro ao inicializar socket Baileys:', err.message);
    throw err;
  }
}

let incomingMessageHandler = null;

export function onBaileysMessage(handler) {
  incomingMessageHandler = handler;
}

/**
 * Envia mensagem via Baileys para número ou ID de grupo
 */
export async function sendBaileysMessage({ to, text, image, caption }) {
  // Se estiver conectando no momento, aguarda até 4 segundos para estabilizar
  if (connectionStatus === 'connecting') {
    const start = Date.now();
    while (connectionStatus === 'connecting' && (Date.now() - start < 4000)) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp não está conectado. Acesse /whatsapp para escanear o QR Code.');
  }

  let jid = String(to || '').trim();

  // Tratamento e limpeza rigorosa de JID
  if (jid.includes('@g.us')) {
    // Grupo
  } else if (jid.includes('@')) {
    // @s.whatsapp.net ou @lid: remove identificador de dispositivo (:22@...)
    const [userPart, server] = jid.split('@');
    const cleanUser = userPart.split(':')[0].replace(/\D/g, '');
    jid = `${cleanUser}@${server}`;
  } else if (jid.length > 15) {
    jid = `${jid}@g.us`;
  } else {
    const cleanNumber = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
    jid = `${cleanNumber}@s.whatsapp.net`;
  }

  console.log(`[WhatsApp-Baileys] 📤 Enviando resposta para ${jid}... ${image ? '(com imagem)' : ''}`);
  let content;
  if (image) {
    const imgBuffer = Buffer.isBuffer(image) ? image : fs.readFileSync(image);
    content = { image: imgBuffer, caption: caption || text || '' };
  } else {
    content = { text: String(text || '') };
  }
  const result = await sock.sendMessage(jid, content);
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
