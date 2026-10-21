/**
 * ===================================================================
 * MÓDULO DE INTEGRAÇÃO WHATSAPP (PADRÃO ADAPTER / PROVIDER)
 * ===================================================================
 * Suporta múltiplos provedores:
 *  - 'baileys': Conexão nativa direta Baileys (zero Docker, integrado no Node.js)
 *  - 'wapi': API gerenciada W-API (https://docs.w-api.app/)
 *  - 'evolution': Evolution API v2 (auto-hospedada no Docker/CloudPanel)
 *
 * Configuração via variáveis de ambiente (.env):
 *  - WHATSAPP_ENABLED: 'true' para ativar, 'false' para desativar
 *  - WHATSAPP_PROVIDER: 'baileys', 'wapi' ou 'evolution'
 *  - WHATSAPP_GROUP_ID: JID do grupo (ex: 120363000000000000@g.us)
 * ===================================================================
 */

import {
  initBaileys,
  getBaileysStatus,
  sendBaileysMessage,
  joinGroupByInvite,
  listParticipatingGroups,
  disconnectBaileys,
  onBaileysMessage,
} from './baileys.js';
import { renderTemplate } from './whatsapp-bot.js';

export function isWhatsAppEnabled() {
  return String(process.env.WHATSAPP_ENABLED || 'false').trim().toLowerCase() === 'true';
}

export function getWhatsAppProvider() {
  return String(process.env.WHATSAPP_PROVIDER || 'wapi').trim().toLowerCase();
}

/**
 * Normaliza o destinatário (número de telefone ou ID de grupo).
 * Se for grupo (@g.us), preserva exatamente como está.
 * Se for número comum, remove caracteres especiais.
 */
export function normalizeRecipient(recipient) {
  if (!recipient) return '';
  const trimmed = String(recipient).trim();
  if (trimmed.includes('@')) {
    return trimmed;
  }
  return trimmed.replace(/\D/g, '');
}

/**
 * Monta o layout limpo e profissional da mensagem de nova OS
 */
export function formatNewOrderMessage({
  number,
  type,
  priority,
  machineStopped,
  machine,
  sector,
  tag,
  description,
  requesterName,
  responsibleName,
}, db = null) {
  const isStopped = Number(machineStopped) === 1;
  const statusEmoji = isStopped ? '🛑 *MÁQUINA PARADA!*' : '⚡ Máquina Operando';
  
  const prioMap = {
    urgente: '🔴 URGENTE',
    alta: '🟠 ALTA',
    media: '🟡 MÉDIA',
    baixa: '🟢 BAIXA',
  };
  const prioLabel = prioMap[String(priority || 'media').toLowerCase()] || '🟡 MÉDIA';
  const typeLabel = String(type || 'corretiva').toUpperCase();
  const timeNow = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  if (db) {
    try {
      const techText = responsibleName ? `👷 *Técnico Atribuído:* ${responsibleName}` : `📢 *Aviso:* Disponível para atendimento da equipe`;
      const rendered = renderTemplate(db, 'group_order_notification', {
        numero: number || 'S/N',
        tipo: typeLabel,
        prioridade: prioLabel,
        status_parada: statusEmoji,
        setor: sector || 'Não informado',
        maquina: machine || 'Não informada',
        tag: tag ? `(TAG: ${tag})` : '',
        solicitante: requesterName || 'Não identificado',
        tecnico: techText,
        descricao: description ? description.trim() : 'Sem descrição',
        horario: timeNow,
      });
      if (rendered && rendered.trim()) return rendered;
    } catch (_) {}
  }

  const lines = [
    `🚨 *NOVA ORDEM DE SERVIÇO #${number || 'S/N'}*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `📋 *Tipo:* ${typeLabel}`,
    `⚠️ *Prioridade:* ${prioLabel}`,
    `⚙️ *Status:* ${statusEmoji}`,
    ``,
    `🏭 *Setor:* ${sector || 'Não informado'}`,
    `🔧 *Máquina:* ${machine || 'Não informada'} ${tag ? `(TAG: ${tag})` : ''}`,
    `👤 *Solicitante:* ${requesterName || 'Não identificado'}`,
  ];

  if (responsibleName) {
    lines.push(`👷 *Técnico Atribuído:* ${responsibleName}`);
  } else {
    lines.push(`📢 *Aviso:* Disponível para atendimento da equipe`);
  }

  lines.push(
    ``,
    `📝 *Descrição do Problema:*`,
    `${description ? description.trim() : 'Sem descrição'}`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🕒 _Abertura registrada em: ${timeNow}_`
  );

  return lines.join('\n');
}

/**
 * Adaptador para envio via W-API (docs.w-api.app)
 */
async function sendViaWApi({ to, text }) {
  const baseUrl = (process.env.WAPI_BASE_URL || 'https://api.w-api.app/v1').replace(/\/+$/, '');
  const instanceId = process.env.WAPI_INSTANCE_ID || '';
  const apiKey = process.env.WAPI_API_KEY || '';

  if (!apiKey) {
    throw new Error('WAPI_API_KEY não foi configurada nas variáveis de ambiente');
  }

  // W-API suporta instanceId via query parameter e/ou body
  const queryParam = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
  const endpoint = `${baseUrl}/message/send-text${queryParam}`;

  const body = {
    instanceId: instanceId || undefined,
    number: to,
    phone: to,
    text: text,
    message: text,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'token': apiKey,
    },
    body: JSON.stringify(body),
  });

  const responseData = await response.json().catch(() => null);

  if (!response.ok) {
    const errorDetail = responseData?.message || responseData?.error || `HTTP ${response.status} ${response.statusText}`;
    throw new Error(`[W-API] Erro no envio (${errorDetail})`);
  }

  return { success: true, provider: 'wapi', data: responseData };
}

/**
 * Adaptador para envio via Evolution API v2 (Docker / CloudPanel)
 */
async function sendViaEvolution({ to, text }) {
  const baseUrl = (process.env.EVOLUTION_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const instance = process.env.EVOLUTION_INSTANCE_NAME || 'manutencao';
  const apiKey = process.env.EVOLUTION_API_KEY;

  if (!apiKey) {
    throw new Error('EVOLUTION_API_KEY não foi configurada nas variáveis de ambiente');
  }

  const endpoint = `${baseUrl}/message/sendText/${encodeURIComponent(instance)}`;
  const body = {
    number: to,
    text: text,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': apiKey,
    },
    body: JSON.stringify(body),
  });

  const responseData = await response.json().catch(() => null);

  if (!response.ok) {
    const errorDetail = responseData?.message || responseData?.error || `HTTP ${response.status} ${response.statusText}`;
    throw new Error(`[Evolution API] Erro no envio (${errorDetail})`);
  }

  return { success: true, provider: 'evolution', data: responseData };
}

/**
 * Função central de envio de mensagem de texto.
 * Roteia automaticamente para o provedor selecionado no .env
 */
export async function sendWhatsAppMessage({ to, text }) {
  if (!isWhatsAppEnabled()) {
    return { skipped: true, reason: 'WHATSAPP_ENABLED não está ativo (false)' };
  }

  const rawRecipient = to || process.env.WHATSAPP_GROUP_ID;
  const target = normalizeRecipient(rawRecipient);

  if (!target) {
    console.warn('[WhatsApp] Destinatário não fornecido e WHATSAPP_GROUP_ID não definido no .env');
    return { skipped: true, reason: 'Nenhum destinatário ou ID de grupo configurado' };
  }

  const provider = getWhatsAppProvider();

  try {
    let result;
    if (provider === 'baileys') {
      result = await sendBaileysMessage({ to: target, text });
    } else if (provider === 'evolution') {
      result = await sendViaEvolution({ to: target, text });
    } else {
      result = await sendViaWApi({ to: target, text });
    }
    console.info(`[WhatsApp] Mensagem enviada com sucesso via ${provider.toUpperCase()} para [${target}]`);
    return result;
  } catch (err) {
    console.error(`[WhatsApp] Falha ao enviar via ${provider.toUpperCase()}:`, err.message);
    throw err;
  }
}

/**
 * Notifica a criação de uma nova Ordem de Serviço no WhatsApp.
 * Esta função foi projetada para ser chamada de forma assíncrona ("fire and forget"),
 * garantindo que falhas de rede ou saldo na API do WhatsApp nunca impeçam ou atrasem
 * a abertura da OS no banco de dados.
 */
export async function notifyNewOrderWhatsApp(orderData, recipient = null, db = null) {
  if (!isWhatsAppEnabled()) return;

  try {
    const text = formatNewOrderMessage(orderData, db);
    await sendWhatsAppMessage({ to: recipient, text });
  } catch (err) {
    // Registra o alerta no console sem propagar o erro
    console.warn('[WhatsApp] Notificação de nova OS não pôde ser enviada:', err.message);
  }
}

/**
 * Função de teste de conexão para diagnosticar configurações
 */
export async function testWhatsAppConnection(target) {
  const provider = getWhatsAppProvider();
  const testRecipient = target || process.env.WHATSAPP_GROUP_ID;
  const timeNow = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const text = [
    `🧪 *TESTE DE INTEGRAÇÃO WHATSAPP - NOVA OS*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `✅ Conexão estabelecida com sucesso!`,
    `📡 *Provedor Ativo:* ${provider.toUpperCase()}`,
    `🕒 *Horário:* ${timeNow}`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `O sistema está pronto para enviar notificações automáticas de Ordens de Serviço neste canal.`,
  ].join('\n');

  return sendWhatsAppMessage({ to: testRecipient, text });
}

export {
  initBaileys,
  getBaileysStatus,
  joinGroupByInvite,
  listParticipatingGroups,
  disconnectBaileys,
  onBaileysMessage,
};
