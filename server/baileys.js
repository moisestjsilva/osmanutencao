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
  decryptPollVote,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHash } from 'node:crypto';

// Cache em memória das enquetes (Polls) enviadas para descriptografar o clique do usuário
const sentPolls = new Map();

function saveSentPoll(result, myUser) {
  if (!result?.key?.id || !result?.message) return;
  if (sentPolls.size > 500) {
    const firstKey = sentPolls.keys().next().value;
    if (firstKey) sentPolls.delete(firstKey);
  }
  sentPolls.set(result.key.id, {
    key: result.key,
    message: result.message,
    creatorJid: myUser?.id ? jidNormalizedUser(myUser.id) : null,
  });
}

function extractPollVoteText(m, myUser) {
  try {
    const pollUpdate = m.message?.pollUpdateMessage;
    if (!pollUpdate?.vote) return '';
    const pollMsgId = pollUpdate.pollCreationMessageKey?.id;
    const saved = pollMsgId ? sentPolls.get(pollMsgId) : null;
    if (!saved?.message) return '';

    const pollMsg =
      saved.message.pollCreationMessage ||
      saved.message.pollCreationMessageV2 ||
      saved.message.pollCreationMessageV3;
    const options = pollMsg?.options || [];
    const pollEncKey = saved.message.messageContextInfo?.messageSecret || pollMsg?.encKey;
    if (!pollEncKey || !options.length) return '';

    const pollCreatorJid = saved.creatorJid || (myUser?.id ? jidNormalizedUser(myUser.id) : jidNormalizedUser(pollUpdate.pollCreationMessageKey?.remoteJid || ''));
    const voterJid = jidNormalizedUser(m.key.participant || m.key.remoteJid || '');

    const decoded = decryptPollVote(pollUpdate.vote, {
      pollCreatorJid,
      pollMsgId,
      pollEncKey,
      voterJid,
    });

    const hashMap = new Map();
    for (const opt of options) {
      const name = opt.optionName || '';
      const h = createHash('sha256').update(Buffer.from(name)).digest('hex');
      hashMap.set(h, name);
    }

    const picked = [];
    for (const sel of decoded?.selectedOptions || []) {
      const h = Buffer.from(sel).toString('hex');
      if (hashMap.has(h)) picked.push(hashMap.get(h));
    }
    return picked.join(', ');
  } catch (err) {
    console.warn('[WhatsApp-Baileys] Aviso ao ler voto de enquete:', err.message);
    return '';
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const AUTH_DIR = path.join(DATA_DIR, 'whatsapp_auth');

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
        extractPollVoteText(m, connectedUser) ||
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
            reply: async (replyText, opts = {}) => {
              return await sendBaileysMessage({ to: jid, text: replyText, poll: opts?.poll });
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
export async function sendBaileysMessage({ to, text, image, caption, poll }) {
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

  console.log(`[WhatsApp-Baileys] 📤 Enviando resposta para ${jid}... ${image ? '(com imagem)' : poll ? '(com enquete)' : ''}`);
  let result;
  if (image) {
    const imgBuffer = Buffer.isBuffer(image) ? image : fs.readFileSync(image);
    result = await sock.sendMessage(jid, { image: imgBuffer, caption: caption || text || '' });
  } else if (text) {
    result = await sock.sendMessage(jid, { text: String(text || '') });
  }
  if (poll && Array.isArray(poll.values) && poll.values.length >= 2) {
    try {
      const pollRes = await sock.sendMessage(jid, {
        poll: {
          name: poll.name || 'Selecione uma opção:',
          values: poll.values,
          selectableCount: poll.selectableCount || 1,
        },
      });
      saveSentPoll(pollRes, connectedUser);
      result = pollRes;
    } catch (pollErr) {
      console.warn('[WhatsApp-Baileys] Falha ao enviar enquete:', pollErr.message);
    }
  }
  return { success: true, provider: 'baileys', messageId: result?.key?.id, to: jid };
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

  return { ok: true };
}

// =========================================================================
// SEGUNDA INSTÂNCIA DEDICADA À FROTA (OPCIONAL - SEGUNDO APARELHO)
// =========================================================================
const FLEET_AUTH_DIR = path.join(DATA_DIR, 'whatsapp_fleet_auth');
if (!fs.existsSync(FLEET_AUTH_DIR)) {
  fs.mkdirSync(FLEET_AUTH_DIR, { recursive: true });
}

let fleetSock = null;
let fleetQrDataUrl = null;
let fleetStatus = 'disconnected';
let fleetUser = null;
let fleetReconnectTimer = null;
let fleetInitializing = false;
let fleetIncomingHandler = null;

export function getFleetBaileysStatus() {
  return {
    status: fleetStatus,
    user: fleetUser,
    qrCode: fleetQrDataUrl,
    hasAuth: fs.existsSync(path.join(FLEET_AUTH_DIR, 'creds.json')),
  };
}

export function onFleetBaileysMessage(handler) {
  fleetIncomingHandler = handler;
}

export async function initFleetBaileys(forceNew = false) {
  if (fleetInitializing && !forceNew) return { status: fleetStatus, user: fleetUser };
  if (fleetSock && fleetStatus === 'connected' && !forceNew) return { status: fleetStatus, user: fleetUser };

  if (fleetSock) {
    try {
      fleetSock.ev.removeAllListeners();
      fleetSock.end(undefined);
    } catch (_) {}
    fleetSock = null;
  }

  fleetInitializing = true;
  fleetStatus = 'connecting';
  console.info('[WhatsApp-Frota] Iniciando instância dedicada de WhatsApp da Frota...');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(FLEET_AUTH_DIR);
    let version = undefined;
    try {
      const vInfo = await fetchLatestBaileysVersion();
      version = vInfo.version;
    } catch (_) {}

    fleetSock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Nova OS Frota', 'Chrome', '1.0.0'],
      defaultQueryTimeoutMs: 60000,
    });

    fleetSock.ev.on('creds.update', saveCreds);

    fleetSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          fleetQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
        } catch (_) {}
        fleetStatus = 'connecting';
        fleetInitializing = false;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        fleetStatus = 'disconnected';
        fleetUser = null;
        fleetInitializing = false;
        if (shouldReconnect) {
          if (!fleetReconnectTimer) {
            fleetReconnectTimer = setTimeout(() => {
              fleetReconnectTimer = null;
              initFleetBaileys();
            }, 5000);
          }
        } else {
          try {
            fs.rmSync(FLEET_AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(FLEET_AUTH_DIR, { recursive: true });
          } catch (_) {}
          fleetQrDataUrl = null;
        }
      } else if (connection === 'open') {
        fleetStatus = 'connected';
        fleetInitializing = false;
        fleetQrDataUrl = null;
        fleetUser = fleetSock.user;
        console.info(`[WhatsApp-Frota] ✅ WHATSAPP DA FROTA CONECTADO! ID: ${fleetUser?.id || 'Conectado'}`);
      }
    });

    fleetSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
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
          extractPollVoteText(m, fleetUser) ||
          '';

        let mediaAttachment = null;
        if (imageMsg) {
          try {
            const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: fleetSock?.updateMediaMessage });
            if (buffer && buffer.length > 0) {
              const mime = imageMsg.mimetype || 'image/jpeg';
              const ext = mime.includes('png') ? 'png' : (mime.includes('webp') ? 'webp' : 'jpg');
              const attId = randomUUID();
              const filename = `wa-frota-${Date.now()}-${attId.slice(0, 8)}.${ext}`;
              fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
              mediaAttachment = { id: attId, file: filename, mime, size: buffer.length };
            }
          } catch (_) {}
        }

        if (!text && mediaAttachment) text = 'Registro fotográfico anexado';
        if (!text || !text.trim()) continue;

        const pushName = m.pushName || '';
        const isGroup = jid.endsWith('@g.us');
        let sender = isGroup ? (m.key.participant || jid) : jid;

        if (sender.endsWith('@lid')) {
          const alt = isGroup ? m.key.participantAlt : m.key.remoteJidAlt;
          let pn = alt && alt.includes('@s.whatsapp.net') ? alt : null;
          if (!pn) {
            try { pn = await fleetSock.signalRepository?.lidMapping?.getPNForLID(sender); } catch (_) {}
          }
          if (pn) sender = pn;
        }

        if (fleetIncomingHandler) {
          try {
            await fleetIncomingHandler({
              jid,
              sender,
              text: text.trim(),
              pushName,
              isGroup,
              mediaAttachment,
              presence: async (presenceType) => {
                if (fleetSock && fleetStatus === 'connected') {
                  try {
                    const targetJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
                    await fleetSock.sendPresenceUpdate(presenceType, targetJid);
                  } catch (_) {}
                }
              },
              reply: async (replyText, opts = {}) => sendFleetBaileysMessage({ to: jid, text: replyText, poll: opts?.poll }),
            });
          } catch (err) {
            console.error('[WhatsApp-Frota] Erro ao processar mensagem:', err.message);
          }
        }
      }
    });

    return { status: fleetStatus };
  } catch (err) {
    fleetInitializing = false;
    fleetStatus = 'disconnected';
    throw err;
  }
}

export async function sendFleetBaileysMessage({ to, text, image, caption, poll }) {
  if (fleetStatus === 'connecting') {
    const start = Date.now();
    while (fleetStatus === 'connecting' && Date.now() - start < 4000) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!fleetSock || fleetStatus !== 'connected') {
    throw new Error('WhatsApp exclusivo da Frota não está conectado.');
  }

  let jid = String(to || '').trim();
  if (jid.includes('@g.us')) {
    // Grupo
  } else if (jid.includes('@')) {
    const [userPart, server] = jid.split('@');
    jid = `${userPart.split(':')[0].replace(/\D/g, '')}@${server}`;
  } else if (jid.length > 15) {
    jid = `${jid}@g.us`;
  } else {
    jid = `${jid.split('@')[0].split(':')[0].replace(/\D/g, '')}@s.whatsapp.net`;
  }

  let result;
  if (image) {
    const imgBuffer = Buffer.isBuffer(image) ? image : fs.readFileSync(image);
    result = await fleetSock.sendMessage(jid, { image: imgBuffer, caption: caption || text || '' });
  } else if (text) {
    result = await fleetSock.sendMessage(jid, { text: String(text || '') });
  }
  if (poll && Array.isArray(poll.values) && poll.values.length >= 2) {
    try {
      const pollRes = await fleetSock.sendMessage(jid, {
        poll: {
          name: poll.name || 'Selecione uma opção:',
          values: poll.values,
          selectableCount: poll.selectableCount || 1,
        },
      });
      saveSentPoll(pollRes, fleetUser);
      result = pollRes;
    } catch (pollErr) {
      console.warn('[WhatsApp-Frota] Falha ao enviar enquete:', pollErr.message);
    }
  }
  return { success: true, provider: 'baileys-fleet', messageId: result?.key?.id, to: jid };
}

export async function joinFleetGroupByInvite(inviteLinkOrCode) {
  if (!fleetSock || fleetStatus !== 'connected') {
    throw new Error('Conecte o WhatsApp da Frota antes de entrar no grupo.');
  }
  let code = String(inviteLinkOrCode || '').trim();
  const match = code.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  if (match) code = match[1];
  const groupJid = await fleetSock.groupAcceptInvite(code);
  return { success: true, groupJid: groupJid.endsWith('@g.us') ? groupJid : `${groupJid}@g.us` };
}

export async function listFleetParticipatingGroups() {
  if (!fleetSock || fleetStatus !== 'connected') return [];
  try {
    const groups = await fleetSock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({
      id: g.id,
      subject: g.subject,
      participantsCount: g.participants?.length || 0,
      creation: g.creation,
    }));
  } catch (_) {
    return [];
  }
}

export async function disconnectFleetBaileys() {
  try {
    if (fleetSock) {
      await fleetSock.logout().catch(() => {});
      fleetSock.end(undefined);
    }
  } catch (_) {}
  fleetSock = null;
  fleetStatus = 'disconnected';
  fleetUser = null;
  fleetQrDataUrl = null;
  try {
    fs.rmSync(FLEET_AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(FLEET_AUTH_DIR, { recursive: true });
  } catch (_) {}
  return { success: true };
}

