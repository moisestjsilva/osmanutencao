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

import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './db.js';
import {
  initBaileys,
  getBaileysStatus,
  sendBaileysMessage,
  joinGroupByInvite,
  listParticipatingGroups,
  disconnectBaileys,
  onBaileysMessage,
  getFleetBaileysStatus,
  initFleetBaileys,
  sendFleetBaileysMessage,
  joinFleetGroupByInvite,
  listFleetParticipatingGroups,
  disconnectFleetBaileys,
  onFleetBaileysMessage,
} from './baileys.js';
import { renderTemplate } from './whatsapp-bot.js';
import { getSetting } from './domain.js';

export function isWhatsAppEnabled(db = null) {
  // 1. Se Baileys estiver conectado ou autenticado no aparelho, WhatsApp está ativo!
  const bState = getBaileysStatus();
  if (bState && (bState.status === 'connected' || bState.hasAuth)) {
    return true;
  }
  // 2. Variável de ambiente explícita
  if (process.env.WHATSAPP_ENABLED !== undefined) {
    const envVal = String(process.env.WHATSAPP_ENABLED).trim().toLowerCase();
    if (envVal === 'true') return true;
  }
  return false;
}

export function getWhatsAppProvider(db = null) {
  // Se Baileys estiver conectado ou autenticado, prioriza Baileys
  const bState = getBaileysStatus();
  if (bState && (bState.status === 'connected' || bState.hasAuth)) {
    return 'baileys';
  }
  if (process.env.WHATSAPP_PROVIDER) {
    return String(process.env.WHATSAPP_PROVIDER).trim().toLowerCase();
  }
  return 'baileys';
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
  hasPhoto = false,
  photoFile = null,
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
      const photoText = hasPhoto ? `📸 *Foto do Problema:* Anexada na OS` : '';
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
        foto_anexada: photoText,
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

  if (hasPhoto) {
    lines.push(`📸 *Foto do Problema:* Anexada na OS`);
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
export async function sendWhatsAppMessage({ to, text, image = null }) {
  const bState = getBaileysStatus();
  const provider = getWhatsAppProvider();

  // Se Baileys estiver conectado ou com credencial salva, está habilitado
  const isEnabled = (bState && (bState.status === 'connected' || bState.hasAuth)) || isWhatsAppEnabled();
  if (!isEnabled) {
    return { skipped: true, reason: 'WhatsApp não está conectado nem habilitado' };
  }

  const rawRecipient = to || process.env.WHATSAPP_GROUP_ID;
  const target = normalizeRecipient(rawRecipient);

  if (!target) {
    console.warn('[WhatsApp] Destinatário não fornecido e nenhum grupo padrão configurado');
    return { skipped: true, reason: 'Nenhum destinatário ou ID de grupo configurado' };
  }

  try {
    let result;
    if (provider === 'baileys') {
      result = await sendBaileysMessage({ to: target, text, image });
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
  const isFleetOrder = String(orderData?.sector || '').trim().toUpperCase() === 'FROTA';

  try {
    let imagePath = null;
    if (orderData.photoFile) {
      const candidate = path.join(UPLOAD_DIR, path.basename(orderData.photoFile));
      if (fs.existsSync(candidate)) imagePath = candidate;
    }

    if (isFleetOrder) {
      let kmVal = orderData.km;
      if (kmVal == null && db && orderData.tag) {
        const veh = db.prepare('SELECT odometer_km FROM fleet_vehicles WHERE UPPER(plate) = UPPER(?)').get(orderData.tag);
        if (veh) kmVal = veh.odometer_km;
      }
      const text = formatFleetOrderMessage({
        number: orderData.number,
        type: orderData.type,
        priority: orderData.priority,
        machineStopped: orderData.machineStopped,
        vehicle: orderData.machine,
        plate: orderData.tag,
        km: kmVal,
        description: orderData.description,
        hasPhoto: orderData.hasPhoto,
        requesterName: orderData.requesterName,
        responsibleName: orderData.responsibleName,
      }, db);
      const fleetGroup = db ? getSetting(db, 'fleet_whatsapp_group_id', '') : '';
      await sendFleetWhatsAppMessage({ to: fleetGroup || recipient, text, image: imagePath }, db);
      return;
    }

    const bState = getBaileysStatus();
    const isEnabled = (bState && (bState.status === 'connected' || bState.hasAuth)) || isWhatsAppEnabled();
    if (!isEnabled) return;

    const text = formatNewOrderMessage(orderData, db);
    await sendWhatsAppMessage({ to: recipient, text, image: imagePath });
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
  getFleetBaileysStatus,
  initFleetBaileys,
  sendFleetBaileysMessage,
  joinFleetGroupByInvite,
  listFleetParticipatingGroups,
  disconnectFleetBaileys,
  onFleetBaileysMessage,
};

/**
 * Envia mensagem pelo canal de WhatsApp da Frota:
 * 1) Se Evolution dedicada da Frota estiver configurada e ativa -> envia via Evolution da Frota
 * 2) Se Aparelho Baileys exclusivo da Frota estiver conectado -> envia via Baileys da Frota
 * 3) Caso contrário -> usa o WhatsApp principal da Manutenção como fallback transparente
 */
export async function sendFleetWhatsAppMessage({ to, text, image = null }, db = null) {
  const fleetGroup = db ? getSetting(db, 'fleet_whatsapp_group_id', '') : '';
  const mainGroup = db ? getSetting(db, 'whatsapp_group_id', process.env.WHATSAPP_GROUP_ID || '') : (process.env.WHATSAPP_GROUP_ID || '');
  const target = normalizeRecipient(to || fleetGroup || mainGroup);
  if (!target) {
    return { skipped: true, reason: 'Nenhum destinatário ou grupo configurado para a Frota' };
  }

  // 1. Evolution dedicada da Frota (se configurada)
  const evoEnabled = db ? getSetting(db, 'fleet_evolution_enabled', '0') === '1' : false;
  const evoUrl = (db ? getSetting(db, 'fleet_evolution_url', '') : '') || process.env.FLEET_EVOLUTION_BASE_URL || '';
  const evoInstance = (db ? getSetting(db, 'fleet_evolution_instance', '') : '') || process.env.FLEET_EVOLUTION_INSTANCE || '';
  const evoKey = (db ? getSetting(db, 'fleet_evolution_apikey', '') : '') || process.env.FLEET_EVOLUTION_API_KEY || '';

  if (evoEnabled && evoUrl && evoInstance && evoKey) {
    const endpoint = `${evoUrl.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(evoInstance)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: evoKey },
      body: JSON.stringify({ number: target, text }),
    });
    const responseData = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`[Evolution-Frota] Erro no envio (${responseData?.message || response.status})`);
    }
    return { success: true, provider: 'evolution-fleet', data: responseData };
  }

  // 2. Baileys dedicado da Frota (segundo telefone conectado em /whatsapp-frota)
  const fb = getFleetBaileysStatus();
  if (fb && fb.status === 'connected') {
    return sendFleetBaileysMessage({ to: target, text, image });
  }

  // 3. Fallback: usa o WhatsApp principal (mesmo número da manutenção)
  return sendWhatsAppMessage({ to: target, text, image });
}

export function formatFleetOrderMessage({
  number,
  type,
  priority,
  machineStopped,
  vehicle,
  plate,
  km,
  description,
  hasPhoto = false,
  requesterName,
  responsibleName,
}, db = null) {
  const isStopped = Number(machineStopped) === 1;
  const statusEmoji = isStopped ? '🛑 *VEÍCULO PARADO / IMOBILIZADO*' : '⚡ Veículo Rodando com Alerta';
  const prioMap = { urgente: '🔴 URGENTE', alta: '🟠 ALTA', media: '🟡 MÉDIA', baixa: '🟢 BAIXA' };
  const prioLabel = prioMap[String(priority || 'media').toLowerCase()] || '🟡 MÉDIA';
  const typeLabel = String(type || 'corretiva').toUpperCase();
  const timeNow = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const kmText = km != null && Number(km) > 0 ? `${Number(km).toLocaleString('pt-BR')} km` : 'Não informado';

  if (db) {
    try {
      const techText = responsibleName ? `👷 *Mecânico Atribuído:* ${responsibleName}` : `📢 *Aviso:* Disponível para a oficina da Frota`;
      const photoText = hasPhoto ? `📸 *Foto do Defeito:* Anexada na OS` : '';
      const rendered = renderTemplate(db, 'fleet_group_order_notification', {
        numero: number || 'S/N',
        tipo: typeLabel,
        prioridade: prioLabel,
        status_parada: statusEmoji,
        veiculo: vehicle || plate || 'Veículo',
        placa: plate || 'S/P',
        km: kmText,
        solicitante: requesterName || 'Não identificado',
        tecnico: techText,
        foto_anexada: photoText,
        descricao: description ? description.trim() : 'Sem descrição',
        horario: timeNow,
      });
      if (rendered && rendered.trim()) return rendered;
    } catch (_) {}
  }

  return [
    `🚚🚨 *NOVA OS DE FROTA #${number || 'S/N'}*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🪪 *Placa:* *${plate || 'S/P'}*`,
    `🚛 *Veículo:* ${vehicle || 'Veículo'}`,
    `📏 *Hodômetro:* ${kmText}`,
    `⚠️ *Prioridade:* ${prioLabel}`,
    `⚙️ *Status:* ${statusEmoji}`,
    `👤 *Solicitante:* ${requesterName || 'Não identificado'}`,
    ``,
    `📝 *Problema Relatado:*`,
    `${description ? description.trim() : 'Sem descrição'}`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🕒 _Abertura registrada em: ${timeNow}_`,
  ].join('\n');
}

