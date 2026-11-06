/**
 * ===================================================================
 * MOTOR DE CHATBOT E GERENCIADOR DE TEMPLATES WHATSAPP - NOVA OS
 * ===================================================================
 * Permite a abertura interativa de Ordens de Serviço via WhatsApp
 * através de máquina de estados conversacional, suporte a múltiplos
 * provedores (Baileys, Evolution API, W-API) e personalização total
 * dos textos das mensagens e templates de notificação.
 * ===================================================================
 */

import { randomUUID } from 'node:crypto';
import { applyOp, getSetting } from './domain.js';
import { setOdometer, ensureMachineForVehicle } from './fleet-core.js';

export const DEFAULT_TEMPLATES = [
  {
    key: 'bot_welcome_known',
    name: 'Boas-vindas (Usuário Identificado)',
    category: 'bot',
    description: 'Enviada quando o solicitante já possui o WhatsApp cadastrado e inicia uma conversa.',
    variables: ['{nome}', '{telefone}'],
    template: [
      '👋 Olá *{nome}*! Bem-vindo ao assistente de Manutenção da Nova OS.',
      '',
      'Para abrir uma nova Ordem de Serviço, digite a *TAG da Máquina* (ex: *X12*, *TOR-01*):',
      '',
      '_(Envie *cancelar* a qualquer momento para desistir)_'
    ].join('\n')
  },
  {
    key: 'bot_welcome_unknown',
    name: 'Boas-vindas (Usuário Não Cadastrado)',
    category: 'bot',
    description: 'Enviada quando o número de WhatsApp ainda não está vinculado a nenhum colaborador.',
    variables: ['{telefone}', '{nome_whatsapp}'],
    template: [
      '👋 Olá *{nome_whatsapp}*! Bem-vindo ao assistente de Manutenção da Nova OS.',
      '',
      'Identificamos que seu número (*{telefone}*) ainda não está vinculado ao seu perfil.',
      '',
      'Por favor, digite seu *Nome Completo* ou *Nome de Usuário* cadastrado no sistema para identificarmos quem está solicitando o chamado:'
    ].join('\n')
  },
  {
    key: 'bot_user_confirmed',
    name: 'Confirmação de Vínculo de Usuário',
    category: 'bot',
    description: 'Enviada assim que o colaborador é localizado e vinculado com sucesso ao WhatsApp.',
    variables: ['{nome}', '{funcao}', '{telefone}'],
    template: [
      '✅ Identificado com sucesso: *{nome}* ({funcao})!',
      'Seu WhatsApp foi vinculado ao seu cadastro no sistema.',
      '',
      'Agora, por favor, digite a *TAG ou código da máquina* que precisa de manutenção (ex: *X12*, *PRE-01*):'
    ].join('\n')
  },
  {
    key: 'bot_ask_tag',
    name: 'Pergunta da TAG da Máquina',
    category: 'bot',
    description: 'Solicita a TAG do equipamento para abertura da OS.',
    variables: ['{nome}'],
    template: [
      '🔍 Por favor, digite a *TAG ou código da máquina* (ex: *X12*, *TOR-01*, *EMP-03*):',
      '_(Ou digite *cancelar* para sair)_'
    ].join('\n')
  },
  {
    key: 'bot_tag_not_found',
    name: 'TAG Não Encontrada (Opções de Fallback)',
    category: 'bot',
    description: 'Enviada quando a TAG digitada não consta no cadastro de máquinas ativas.',
    variables: ['{tag}'],
    template: [
      '⚠️ *A TAG "{tag}" não foi localizada no cadastro!*',
      '',
      'Como deseja prosseguir?',
      '*1* - Digitar a TAG novamente',
      '*2* - Escolher a máquina navegando pelo *Setor*',
      '*3* - Cadastrar essa máquina agora com a TAG *{tag}*',
      '',
      '_(Responda digitando o número *1*, *2* ou *3*)_'
    ].join('\n')
  },
  {
    key: 'bot_choose_sector',
    name: 'Seleção de Setor da Fábrica',
    category: 'bot',
    description: 'Apresenta a lista numerada dos setores ativos cadastrados na fábrica.',
    variables: ['{lista_setores}'],
    template: [
      '🏭 *Selecione o Setor onde está a máquina:*',
      '',
      '{lista_setores}',
      '',
      '_(Digite o número do setor desejado ou *voltar*)_'
    ].join('\n')
  },
  {
    key: 'bot_choose_machine',
    name: 'Seleção de Máquina por Setor',
    category: 'bot',
    description: 'Apresenta a lista numerada de máquinas cadastradas no setor selecionado.',
    variables: ['{setor}', '{lista_maquinas}'],
    template: [
      '🔧 *Máquinas cadastradas no setor {setor}:*',
      '',
      '{lista_maquinas}',
      '',
      '_(Digite o número da máquina desejada ou *voltar*)_'
    ].join('\n')
  },
  {
    key: 'bot_ask_new_machine_name',
    name: 'Cadastro Rápido de Máquina (Nome)',
    category: 'bot',
    description: 'Solicita o nome descritivo para registrar uma nova TAG inexistente.',
    variables: ['{tag}', '{setor}'],
    template: [
      '📝 Digite o *Nome da nova máquina* para cadastrar com a TAG *{tag}* no setor *{setor}*:',
      '_(Exemplo: Seladora Contínua de Embalagens 02)_'
    ].join('\n')
  },
  {
    key: 'bot_ask_priority',
    name: 'Seleção de Prioridade',
    category: 'bot',
    description: 'Questiona a prioridade e criticidade do atendimento.',
    variables: ['{maquina}', '{tag}', '{setor}'],
    template: [
      '⚙️ Máquina selecionada: *{maquina}* (TAG: *{tag}* • {setor})',
      '',
      'Qual é a *Prioridade* do chamado?',
      '*1* - 🟢 Baixa (não impacta produção imediata)',
      '*2* - 🟡 Média (planejada / rotina operacional)',
      '*3* - 🟠 Alta (risco iminente de parada)',
      '*4* - 🔴 Urgente (impacto grave / linha crítica)',
      '',
      '_(Digite 1, 2, 3 ou 4)_'
    ].join('\n')
  },
  {
    key: 'bot_ask_stopped',
    name: 'Pergunta: Máquina Parada?',
    category: 'bot',
    description: 'Pergunta se o equipamento está impedindo a linha de produzir.',
    variables: ['{maquina}', '{tag}'],
    template: [
      '🛑 A máquina está *PARADA* no momento impedindo o trabalho?',
      '',
      '*1* - 🛑 Sim, máquina completamente parada!',
      '*2* - ⚡ Não, operando com falha ou alerta.',
      '',
      '_(Digite 1 ou 2)_'
    ].join('\n')
  },
  {
    key: 'bot_ask_description',
    name: 'Descrição do Problema',
    category: 'bot',
    description: 'Solicita os detalhes do defeito ou sintoma observado.',
    variables: ['{maquina}', '{tag}'],
    template: [
      '📸 *FOTO OU DESCRIÇÃO DO PROBLEMA:*',
      '',
      'Por favor, envie uma *FOTO do problema* (com ou sem legenda) ou descreva em texto o defeito observado:',
      '',
      '• 📷 *Com foto:* Tire ou anexe a foto do defeito (pode escrever na legenda se quiser)',
      '• ✍️ *Apenas texto:* Digite o que está acontecendo (ex: _vazamento de óleo no cilindro_)',
      '',
      '_(Envie a foto ou mensagem agora)_'
    ].join('\n')
  },
  {
    key: 'bot_success',
    name: 'Confirmação de OS Aberta',
    category: 'bot',
    description: 'Mensagem final enviada ao solicitante no WhatsApp com o número oficial da OS.',
    variables: ['{numero}', '{maquina}', '{tag}', '{setor}', '{prioridade}', '{status_parada}', '{solicitante}', '{foto_anexada}', '{descricao}', '{horario}'],
    template: [
      '✅ *ORDEM DE SERVIÇO #{numero} ABERTA COM SUCESSO!*',
      '━━━━━━━━━━━━━━━━━━━━━━',
      '🏭 *Setor:* {setor}',
      '🔧 *Máquina:* {maquina} (TAG: {tag})',
      '⚠️ *Prioridade:* {prioridade}',
      '⚙️ *Status:* {status_parada}',
      '👤 *Solicitante:* {solicitante}',
      '{foto_anexada}',
      '',
      '📝 *Descrição:*',
      '{descricao}',
      '━━━━━━━━━━━━━━━━━━━━━━',
      '🕒 _Registrado em: {horario}_',
      '📢 A equipe de manutenção já foi alertada e o chamado está ativo no sistema!'
    ].join('\n')
  },
  {
    key: 'bot_cancel',
    name: 'Cancelamento da Conversa',
    category: 'bot',
    description: 'Enviada quando o usuário digita cancelar ou desiste do processo.',
    variables: ['{nome}'],
    template: [
      '❌ Abertura de Ordem de Serviço cancelada.',
      'Quando precisar de manutenção, basta enviar *abrir os* ou digitar a *TAG* da máquina aqui.'
    ].join('\n')
  },
  {
    key: 'group_order_notification',
    name: 'Alerta de Nova OS no Grupo da Manutenção',
    category: 'grupo',
    description: 'Mensagem que o sistema dispara no grupo oficial do WhatsApp ao abrir qualquer OS.',
    variables: ['{numero}', '{tipo}', '{prioridade}', '{status_parada}', '{setor}', '{maquina}', '{tag}', '{solicitante}', '{tecnico}', '{foto_anexada}', '{descricao}', '{horario}'],
    template: [
      '🚨 *NOVA ORDEM DE SERVIÇO #{numero}*',
      '━━━━━━━━━━━━━━━━━━━━━━',
      '📋 *Tipo:* {tipo}',
      '⚠️ *Prioridade:* {prioridade}',
      '⚙️ *Status:* {status_parada}',
      '',
      '🏭 *Setor:* {setor}',
      '🔧 *Máquina:* {maquina} {tag}',
      '👤 *Solicitante:* {solicitante}',
      '{tecnico}',
      '{foto_anexada}',
      '',
      '📝 *Descrição do Problema:*',
      '{descricao}',
      '━━━━━━━━━━━━━━━━━━━━━━',
      '🕒 _Abertura registrada em: {horario}_'
    ].join('\n')
  },
  // =========================================================================
  // TEMPLATES EXCLUSIVOS DA FROTA DE CAMINHÕES (CATEGORIA: frota)
  // =========================================================================
  {
    key: 'fleet_bot_welcome',
    name: 'Frota: Boas-vindas e Solicitação da Placa',
    category: 'frota',
    description: 'Enviada quando o motorista ou colaborador digita FROTA para abrir uma OS de veículo.',
    variables: ['{nome}', '{telefone}'],
    template: [
      '🚚 Olá *{nome}*! Você está na *Central de Manutenção da Frota*.',
      '',
      'Para abrir uma Ordem de Serviço de veículo, digite a *PLACA do Caminhão/Veículo* (ex: *RMI1A95*, *GSW0232*):',
      '',
      '_(Ou digite *cancelar* para sair)_'
    ].join('\n')
  },
  {
    key: 'fleet_bot_ask_plate',
    name: 'Frota: Solicitar Placa Novamente',
    category: 'frota',
    description: 'Solicita a placa do veículo da frota.',
    variables: ['{nome}'],
    template: [
      '🔍 Digite a *PLACA do veículo* (ex: *RMI1A95*, *QXV7C91*) ou parte do modelo:',
      '_(Digite *cancelar* para desistir)_'
    ].join('\n')
  },
  {
    key: 'fleet_bot_plate_not_found',
    name: 'Frota: Placa Não Localizada',
    category: 'frota',
    description: 'Enviada quando a placa informada não consta nos veículos cadastrados na Frota.',
    variables: ['{placa}'],
    template: [
      '⚠️ *O veículo com placa "{placa}" não foi encontrado na Frota!*',
      '',
      'Como deseja prosseguir?',
      '*1* - Digitar a Placa novamente',
      '*2* - Ver a lista de veículos da Frota para escolher',
      '',
      '_(Responda digitando *1* ou *2*, ou *cancelar*)_'
    ].join('\n')
  },
  {
    key: 'fleet_bot_choose_vehicle',
    name: 'Frota: Lista de Veículos para Escolha',
    category: 'frota',
    description: 'Apresenta a lista numerada dos veículos cadastrados na frota.',
    variables: ['{lista_veiculos}'],
    template: [
      '🚛 *Selecione o veículo da Frota:*',
      '',
      '{lista_veiculos}',
      '',
      '_(Digite o *número* correspondente ao veículo ou *voltar*)_'
    ].join('\n')
  },
  {
    key: 'fleet_bot_ask_km',
    name: 'Frota: Pergunta do Hodômetro (Km Atual)',
    category: 'frota',
    description: 'Solicita a quilometragem atual do veículo ao abrir a OS.',
    variables: ['{veiculo}', '{placa}', '{km_atual}'],
    template: [
      '🚛 Veículo selecionado: *{veiculo}* (Placa: *{placa}*)',
      '📏 Último Km registrado: *{km_atual} km*',
      '',
      'Qual é a *Quilometragem (Km) atual* no painel?',
      '_(Digite apenas os números do Km ou envie *0* se não souber agora)_'
    ].join('\n')
  },
  {
    key: 'fleet_bot_ask_priority',
    name: 'Frota: Seleção de Prioridade / Gravidade',
    category: 'frota',
    description: 'Questiona a urgência do reparo no veículo.',
    variables: ['{veiculo}', '{placa}', '{km}'],
    template: [
      '⚠️ Qual é a *Prioridade* da manutenção para *{veiculo}* (*{placa}*)?',
      '',
      '*1* - 🟢 Baixa (detalhe leve / pode aguardar revisão)',
      '*2* - 🟡 Média (manutenção necessária em breve)',
      '*3* - 🟠 Alta (risco de agravar defeito / atenção imediata)',
      '*4* - 🔴 Urgente (socorro em rota / caminhão imobilizado)',
      '',
      '_(Digite 1, 2, 3 ou 4)_'
    ].join('\n')
  },
  {
    key: 'fleet_bot_ask_stopped',
    name: 'Frota: Pergunta se o Veículo está Parado / Imobilizado',
    category: 'frota',
    description: 'Pergunta se o veículo está impedido de rodar.',
    variables: ['{veiculo}', '{placa}'],
    template: [
      '🛑 O veículo *{placa}* está *PARADO / IMOBILIZADO* sem condições de rodar?',
      '',
      '*1* - 🛑 Sim, veículo parado (bloqueado p/ manutenção)',
      '*2* - ⚡ Não, veículo ainda consegue rodar',
      '',
      '_(Digite 1 ou 2)_'
    ].join('\n')
  },
  {
    key: 'fleet_bot_ask_description',
    name: 'Frota: Foto ou Descrição do Defeito no Veículo',
    category: 'frota',
    description: 'Solicita foto ou texto explicando o defeito mecânico/elétrico do veículo.',
    variables: ['{veiculo}', '{placa}'],
    template: [
      '📸 *FOTO OU DESCRIÇÃO DO DEFEITO NO VEÍCULO ({placa}):*',
      '',
      'Envie uma *FOTO* do problema ou descreva o defeito observado no caminhão/veículo (ex: _freio, pneu, vazamento, elétrica, motor_):',
      '',
      '_(Envie a foto ou digite a descrição agora)_'
    ].join('\n')
  },
  {
    key: 'fleet_bot_success',
    name: 'Frota: Confirmação de OS de Frota Aberta',
    category: 'frota',
    description: 'Mensagem final enviada ao motorista/solicitante confirmando a abertura da OS da Frota.',
    variables: ['{numero}', '{veiculo}', '{placa}', '{km}', '{prioridade}', '{status_parada}', '{solicitante}', '{foto_anexada}', '{descricao}', '{horario}'],
    template: [
      '✅ *OS DE FROTA #{numero} ABERTA COM SUCESSO!*',
      '━━━━━━━━━━━━━━━━━━━━━━',
      '🚛 *Veículo:* {veiculo}',
      '🪪 *Placa:* {placa}',
      '📏 *Hodômetro:* {km}',
      '⚠️ *Prioridade:* {prioridade}',
      '⚙️ *Situação:* {status_parada}',
      '👤 *Solicitante:* {solicitante}',
      '{foto_anexada}',
      '',
      '📝 *Defeito Relatado:*',
      '{descricao}',
      '━━━━━━━━━━━━━━━━━━━━━━',
      '🕒 _Registrado em: {horario}_',
      '🔧 A equipe de manutenção da frota já foi acionada!'
    ].join('\n')
  },
  {
    key: 'fleet_group_order_notification',
    name: 'Frota: Alerta de Nova OS no Grupo da Frota',
    category: 'frota_grupo',
    description: 'Mensagem disparada no grupo do WhatsApp quando uma OS de veículo da Frota é aberta.',
    variables: ['{numero}', '{tipo}', '{prioridade}', '{status_parada}', '{veiculo}', '{placa}', '{km}', '{solicitante}', '{tecnico}', '{foto_anexada}', '{descricao}', '{horario}'],
    template: [
      '🚚🚨 *NOVA OS DE FROTA #{numero}*',
      '━━━━━━━━━━━━━━━━━━━━━━',
      '🪪 *Placa:* *{placa}*',
      '🚛 *Veículo:* {veiculo}',
      '📏 *Hodômetro:* {km}',
      '⚠️ *Prioridade:* {prioridade}',
      '⚙️ *Status:* {status_parada}',
      '👤 *Solicitante:* {solicitante}',
      '{tecnico}',
      '{foto_anexada}',
      '',
      '📝 *Problema Relatado:*',
      '{descricao}',
      '━━━━━━━━━━━━━━━━━━━━━━',
      '🕒 _Abertura registrada em: {horario}_'
    ].join('\n')
  }
];

/**
 * Inicializa os templates padrão no banco se não existirem
 */
export function seedDefaultTemplates(db) {
  const now = new Date().toISOString();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO whatsapp_templates (key, name, description, category, template, default_template, variables_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateMetaStmt = db.prepare(`
    UPDATE whatsapp_templates 
    SET default_template = ?, variables_json = ?, name = ?, description = ?
    WHERE key = ?
  `);

  for (const t of DEFAULT_TEMPLATES) {
    insertStmt.run(
      t.key,
      t.name,
      t.description || '',
      t.category || 'bot',
      t.template,
      t.template,
      JSON.stringify(t.variables || []),
      now
    );
    updateMetaStmt.run(
      t.template,
      JSON.stringify(t.variables || []),
      t.name,
      t.description || '',
      t.key
    );

    // Atualiza automaticamente o texto ativo para sincronizar melhorias oficiais de foto
    if (['bot_ask_description', 'bot_success', 'group_order_notification'].includes(t.key)) {
      db.prepare(`
        UPDATE whatsapp_templates 
        SET template = ?, default_template = ?, updated_at = ?
        WHERE key = ? AND (template NOT LIKE '%FOTO OU DESCRIÇÃO%' OR template = default_template)
      `).run(t.template, t.template, now, t.key);
    }
  }
}

/**
 * Retorna todos os templates cadastrados
 */
export function getTemplates(db) {
  return db.prepare('SELECT * FROM whatsapp_templates ORDER BY category DESC, key ASC').all().map(row => ({
    ...row,
    variables: JSON.parse(row.variables_json || '[]'),
  }));
}

/**
 * Retorna um template específico pelo identificador
 */
export function getTemplate(db, key) {
  const row = db.prepare('SELECT * FROM whatsapp_templates WHERE key = ?').get(key);
  if (row) {
    return {
      ...row,
      variables: JSON.parse(row.variables_json || '[]'),
    };
  }
  const def = DEFAULT_TEMPLATES.find(t => t.key === key);
  return def ? { ...def, default_template: def.template } : null;
}

/**
 * Atualiza o texto de um template
 */
export function saveTemplate(db, key, templateText) {
  const now = new Date().toISOString();
  const res = db.prepare(`
    UPDATE whatsapp_templates 
    SET template = ?, updated_at = ? 
    WHERE key = ?
  `).run(templateText, now, key);
  return res.changes > 0;
}

/**
 * Restaura um template para seu valor padrão original
 */
export function resetTemplate(db, key) {
  const row = db.prepare('SELECT default_template FROM whatsapp_templates WHERE key = ?').get(key);
  if (!row) return false;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE whatsapp_templates 
    SET template = default_template, updated_at = ? 
    WHERE key = ?
  `).run(now, key);
  return true;
}

/**
 * Renderiza um template substituindo as chaves {variavel}
 */
export function renderTemplate(db, key, vars = {}) {
  const tplObj = getTemplate(db, key);
  let text = tplObj ? tplObj.template : '';
  if (!text) {
    const fallback = DEFAULT_TEMPLATES.find(t => t.key === key);
    text = fallback ? fallback.template : '';
  }

  for (const [k, v] of Object.entries(vars)) {
    const regex = new RegExp(`\\{${k}\\}`, 'gi');
    text = text.replace(regex, v !== undefined && v !== null ? String(v) : '');
  }

  // Remove placeholders não substituídos (ex: {foto_anexada} quando vazia)
  text = text.replace(/\{[a-z0-9_]+\}/gi, '');

  return text;
}

/**
 * Normaliza número de telefone para busca exata ou sufixo
 */
export function cleanDigits(phone) {
  if (!phone) return '';
  let raw = String(phone).trim();
  if (raw.includes('@')) {
    raw = raw.split('@')[0];
  }
  if (raw.includes(':')) {
    raw = raw.split(':')[0];
  }
  return raw.replace(/\D/g, '');
}

/**
 * Compara dois números de telefone considerando variações brasileiras:
 * - Com ou sem DDI 55
 * - Com ou sem o 9º dígito
 * - Mesmo DDD e mesmos 8 dígitos finais
 */
export function matchBrazilianPhones(p1, p2) {
  const d1 = cleanDigits(p1);
  const d2 = cleanDigits(p2);
  if (!d1 || !d2) return false;
  if (d1 === d2) return true;

  const core8_1 = d1.slice(-8);
  const core8_2 = d2.slice(-8);
  if (core8_1 !== core8_2) return false;

  let ddd1 = '';
  if (d1.startsWith('55') && d1.length >= 12) ddd1 = d1.slice(2, 4);
  else if (d1.length >= 10) ddd1 = d1.slice(0, 2);

  let ddd2 = '';
  if (d2.startsWith('55') && d2.length >= 12) ddd2 = d2.slice(2, 4);
  else if (d2.length >= 10) ddd2 = d2.slice(0, 2);

  if (ddd1 && ddd2) {
    return ddd1 === ddd2;
  }
  return true;
}

/**
 * Localiza usuário no banco a partir do número de WhatsApp
 */
export function findUserByPhone(db, rawPhone) {
  const digits = cleanDigits(rawPhone);
  if (!digits || digits.length < 8) return null;

  // Tenta busca exata
  let user = db.prepare("SELECT * FROM users WHERE active=1 AND phone IS NOT NULL AND phone != '' AND phone = ?").get(digits);
  if (user) return user;

  // Busca e compara todos os usuários ativos com telefone cadastrado
  const users = db.prepare("SELECT * FROM users WHERE active=1 AND phone IS NOT NULL AND phone != ''").all();
  for (const u of users) {
    if (matchBrazilianPhones(u.phone, digits)) {
      return u;
    }
  }

  return null;
}

/**
 * Gerenciamento de Sessão Conversacional
 */
export function getSession(db, phone) {
  const digits = cleanDigits(phone);
  const row = db.prepare('SELECT * FROM whatsapp_sessions WHERE phone = ?').get(digits);
  if (!row) return null;

  // Timeout de 45 minutos de inatividade
  const updated = new Date(row.updated_at).getTime();
  const now = Date.now();
  if (now - updated > 45 * 60 * 1000) {
    db.prepare('DELETE FROM whatsapp_sessions WHERE phone = ?').run(digits);
    return null;
  }

  return {
    ...row,
    data: JSON.parse(row.data_json || '{}'),
  };
}

export function saveSession(db, phone, step, data = {}, userId = null) {
  const digits = cleanDigits(phone);
  const now = new Date().toISOString();
  const dataJson = JSON.stringify(data);

  const existing = db.prepare('SELECT phone FROM whatsapp_sessions WHERE phone = ?').get(digits);
  if (existing) {
    db.prepare(`
      UPDATE whatsapp_sessions 
      SET step = ?, data_json = ?, user_id = COALESCE(?, user_id), updated_at = ? 
      WHERE phone = ?
    `).run(step, dataJson, userId, now, digits);
  } else {
    db.prepare(`
      INSERT INTO whatsapp_sessions (phone, user_id, step, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(digits, userId, step, dataJson, now, now);
  }
}

export function deleteSession(db, phone) {
  const digits = cleanDigits(phone);
  db.prepare('DELETE FROM whatsapp_sessions WHERE phone = ?').run(digits);
}

export function listActiveSessions(db) {
  return db.prepare(`
    SELECT s.phone, s.step, s.data_json, s.updated_at, s.created_at, u.name as user_name
    FROM whatsapp_sessions s
    LEFT JOIN users u ON u.id = s.user_id
    ORDER BY s.updated_at DESC
  `).all().map(s => ({
    ...s,
    data: JSON.parse(s.data_json || '{}'),
  }));
}

/**
 * ===================================================================
 * PROCESSADOR CENTRAL DE MENSAGENS RECEBIDAS (CHATBOT CORE)
 * ===================================================================
 */
export async function processIncomingWhatsAppMessage(db, {
  from,
  text,
  pushName = '',
  isGroup = false,
  mediaAttachment = null,
  presenceFn = null,
  replyFn = null,
  forceFleetMode = false,
}) {
  const rawText = String(text || '').trim();
  if (!rawText && !mediaAttachment) return null;

  const phone = cleanDigits(from);
  if (!phone) return null;

  // Helper para enviar a resposta de volta com delay e presença humanizada
  const sendReply = async (replyText) => {
    if (typeof replyFn === 'function') {
      const delaySec = Number(getSetting(db, 'whatsapp_bot_delay', '2'));
      if (delaySec > 0) {
        if (typeof presenceFn === 'function') {
          try { await presenceFn('composing'); } catch (_) {}
        }
        await new Promise((r) => setTimeout(r, delaySec * 1000));
        if (typeof presenceFn === 'function') {
          try { await presenceFn('paused'); } catch (_) {}
        }
      }
      return await replyFn(replyText);
    }
    return { ok: true, text: replyText };
  };

  const lowerText = rawText.toLowerCase();
  const isFleetCommand =
    forceFleetMode ||
    ['frota', '!frota', '#frota', 'os frota', 'abrir frota', 'caminhao', 'caminhão', 'veiculo', 'veículo'].includes(lowerText) ||
    lowerText.startsWith('frota ');

  // 1. Mensagens em Grupos do WhatsApp
  if (isGroup) {
    const lower = rawText.toLowerCase();
    if (lower.startsWith('!frota') || lower === 'frota' || lower === '#frota') {
      const resp = `🚚 Olá *${pushName || 'colega'}*! Para abrir uma Ordem de Serviço da *Frota* pela placa do veículo, envie *frota* diretamente para este número no *privado*.`;
      await sendReply(resp);
      return { handled: true, action: 'group_redirect_fleet', response: resp };
    }
    if (lower.startsWith('!os') || lower.startsWith('abrir os') || lower === '#os') {
      const resp = `👋 Olá *${pushName || 'colega'}*! Para abrir uma Ordem de Serviço de forma guiada, por favor envie uma mensagem diretamente para este número no *privado*.`;
      await sendReply(resp);
      return { handled: true, action: 'group_redirect', response: resp };
    }
    // Ignora conversas normais dentro de grupos para não poluir
    return { skipped: true, reason: 'Mensagem de grupo não acionou comando !os' };
  }

  // 2. Comandos globais de cancelamento e reinício
  const cancelCommands = ['cancelar', 'sair', 'parar', 'zerar', 'desistir'];
  if (cancelCommands.includes(lowerText)) {
    deleteSession(db, phone);
    const cancelMsg = renderTemplate(db, 'bot_cancel', {
      nome: pushName || 'Colega',
    });
    await sendReply(cancelMsg);
    return { handled: true, action: 'cancelled', response: cancelMsg };
  }

  // 3. Obtém ou inicializa a sessão do usuário
  let session = getSession(db, phone);
  let user = findUserByPhone(db, phone);

  // Se o usuário digitar explicitamente "frota" (ou "frota PLACA") a qualquer momento (inclusive sem vínculo prévio ou no meio de outra conversa), inicia o fluxo de Frota!
  if (
    ['frota', '!frota', '#frota', 'os frota', 'abrir frota'].includes(lowerText) ||
    lowerText.startsWith('frota ')
  ) {
    if (session && !session.step.startsWith('FLEET_')) {
      deleteSession(db, phone);
      session = null;
    }
  }

  if (session && user && ['AWAITING_USER_IDENTIFICATION', 'SELECTING_USER_CANDIDATE'].includes(session.step)) {
    const prevMode = session.data?.mode;
    deleteSession(db, phone);
    session = null;
    if (prevMode === 'fleet') forceFleetMode = true;
  }

  // Para o fluxo da Frota, se o número não estiver na tabela users, tenta localizar em fleet_drivers ou usa solicitante padrão
  const resolveFleetRequester = () => {
    if (user) return user;
    try {
      const drivers = db.prepare("SELECT * FROM fleet_drivers WHERE active = 1 AND phone IS NOT NULL AND phone != ''").all();
      for (const d of drivers) {
        if (matchBrazilianPhones(d.phone, phone)) {
          const fallbackU = db.prepare("SELECT id FROM users WHERE active = 1 ORDER BY CASE role WHEN 'solicitante' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END LIMIT 1").get();
          return { id: d.user_id || fallbackU?.id || 'u-admin', name: d.name, username: 'motorista' };
        }
      }
    } catch (_) {}
    const fallbackU = db.prepare("SELECT id, name FROM users WHERE active = 1 ORDER BY CASE role WHEN 'solicitante' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END LIMIT 1").get();
    return {
      id: fallbackU?.id || 'u-admin',
      name: pushName && pushName !== 'Simulador' ? `${pushName} (${phone})` : (pushName || `Motorista (${phone})`),
      username: 'frota',
    };
  };

  console.log(`[WhatsApp-Bot] 🤖 Avaliando mensagem de "${phone}" (${pushName}): "${rawText}" | Sessão: ${session ? session.step : 'NOVA'} | Usuário: ${user ? `${user.name} (@${user.username})` : 'NÃO VINCULADO'}`);

  // Helper para buscar veículo na tabela fleet_vehicles por placa ou apelido/modelo
  const findFleetVehicle = (input) => {
    const cleanPlate = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const rawUpper = String(input || '').toUpperCase().trim();
    if (!cleanPlate && !rawUpper) return null;
    return db.prepare(`
      SELECT * FROM fleet_vehicles
      WHERE active = 1
        AND (UPPER(plate) = ? OR UPPER(nickname) = ? OR UPPER(plate) LIKE ? OR UPPER(model) LIKE ?)
      ORDER BY CASE WHEN UPPER(plate) = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(cleanPlate, rawUpper, `%${cleanPlate}%`, `%${rawUpper}%`, cleanPlate);
  };

  // Se não houver sessão ativa
  if (!session) {
    // =========================================================================
    // ENTRADA NO FLUXO EXCLUSIVO DA FROTA (por palavra "frota" ou canal exclusivo)
    // =========================================================================
    if (isFleetCommand) {
      const fleetUser = resolveFleetRequester();
      // Verifica se já digitou "frota PLACA" (ex: "frota RMI1A95")
      const afterCmd = rawText.replace(/^(?:!frota|#frota|os frota|abrir frota|frota)\s*/i, '').trim();
      if (afterCmd && afterCmd.toLowerCase() !== rawText.toLowerCase()) {
        const v = findFleetVehicle(afterCmd);
        if (v) {
          const vehLabel = [v.brand, v.model, v.nickname ? `(${v.nickname})` : ''].filter(Boolean).join(' ').trim() || v.plate;
          saveSession(db, phone, 'FLEET_AWAITING_KM', {
            mode: 'fleet',
            requester_id: fleetUser.id,
            requester_name: fleetUser.name,
            vehicle_id: v.id,
            plate: v.plate,
            vehicle_label: vehLabel,
            current_km: v.odometer_km || 0,
          }, fleetUser.id);
          const msg = renderTemplate(db, 'fleet_bot_ask_km', {
            veiculo: vehLabel,
            placa: v.plate,
            km_atual: Number(v.odometer_km || 0).toLocaleString('pt-BR'),
          });
          await sendReply(msg);
          return { handled: true, step: 'FLEET_AWAITING_KM', response: msg };
        }
      }

      // Se estamos na instância dedicada da frota (forceFleetMode) e o motorista já digitou direto a placa na 1ª mensagem
      if (forceFleetMode) {
        const directVeh = findFleetVehicle(rawText);
        if (directVeh && rawText.replace(/[^A-Za-z0-9]/g, '').length >= 6) {
          const vehLabel = [directVeh.brand, directVeh.model, directVeh.nickname ? `(${directVeh.nickname})` : ''].filter(Boolean).join(' ').trim() || directVeh.plate;
          saveSession(db, phone, 'FLEET_AWAITING_KM', {
            mode: 'fleet',
            requester_id: fleetUser.id,
            requester_name: fleetUser.name,
            vehicle_id: directVeh.id,
            plate: directVeh.plate,
            vehicle_label: vehLabel,
            current_km: directVeh.odometer_km || 0,
          }, fleetUser.id);
          const msg = renderTemplate(db, 'fleet_bot_ask_km', {
            veiculo: vehLabel,
            placa: directVeh.plate,
            km_atual: Number(directVeh.odometer_km || 0).toLocaleString('pt-BR'),
          });
          await sendReply(msg);
          return { handled: true, step: 'FLEET_AWAITING_KM', response: msg };
        }
      }

      saveSession(db, phone, 'FLEET_AWAITING_PLATE', {
        mode: 'fleet',
        requester_id: fleetUser.id,
        requester_name: fleetUser.name,
      }, fleetUser.id);

      const msg = renderTemplate(db, 'fleet_bot_welcome', {
        nome: fleetUser.name,
        telefone: phone,
      });
      await sendReply(msg);
      return { handled: true, step: 'FLEET_AWAITING_PLATE', response: msg };
    }

    // Início de nova conversa no Fluxo Industrial Padrão (Intocado)
    if (!user) {
      // Usuário ainda não tem o telefone vinculado
      saveSession(db, phone, 'AWAITING_USER_IDENTIFICATION', { pushName });
      const msg = renderTemplate(db, 'bot_welcome_unknown', {
        telefone: phone,
        nome_whatsapp: pushName || 'Colega',
      });
      await sendReply(msg);
      return { handled: true, step: 'AWAITING_USER_IDENTIFICATION', response: msg };
    }

    // Usuário já cadastrado! (Fluxo Industrial Padrão - Intocado)
    // Verifica se a primeira mensagem já foi uma TAG direta existente (ex: "X12")
    const quickTag = rawText.toUpperCase().trim();
    const existingMachine = db.prepare(`
      SELECT m.*, s.name as sector_name 
      FROM machines m 
      LEFT JOIN sectors s ON s.id = m.sector_id 
      WHERE m.active=1 AND UPPER(m.code) = ?
    `).get(quickTag);

    if (existingMachine) {
      // Fast-track: Pula direto para a seleção de prioridade!
      saveSession(db, phone, 'AWAITING_PRIORITY', {
        requester_id: user.id,
        requester_name: user.name,
        machine_id: existingMachine.id,
        machine_code: existingMachine.code,
        machine_name: existingMachine.name,
        sector_name: existingMachine.sector_name || 'Geral',
      }, user.id);

      const msg = renderTemplate(db, 'bot_ask_priority', {
        maquina: existingMachine.name,
        tag: existingMachine.code,
        setor: existingMachine.sector_name || 'Geral',
      });
      await sendReply(msg);
      return { handled: true, step: 'AWAITING_PRIORITY', response: msg };
    }

    // Inicia fluxo normal pedindo a TAG
    saveSession(db, phone, 'AWAITING_TAG', {
      requester_id: user.id,
      requester_name: user.name,
    }, user.id);

    const msg = renderTemplate(db, 'bot_welcome_known', {
      nome: user.name,
      telefone: phone,
    });
    await sendReply(msg);
    return { handled: true, step: 'AWAITING_TAG', response: msg };
  }

  // ===================================================================
  // MÁQUINA DE ESTADOS DA CONVERSA
  // ===================================================================
  const step = session.step;
  const data = session.data || {};

  // -------------------------------------------------------------
  // ETAPA: Identificação de Usuário Não Cadastrado
  // -------------------------------------------------------------
  if (step === 'AWAITING_USER_IDENTIFICATION') {
    const searchTerms = rawText.toLowerCase().trim();
    const matchedUsers = db.prepare(`
      SELECT * FROM users 
      WHERE active=1 
        AND (LOWER(name) LIKE ? OR LOWER(username) = ? OR id = ?)
      LIMIT 5
    `).all(`%${searchTerms}%`, searchTerms, searchTerms);

    if (matchedUsers.length === 1) {
      const matched = matchedUsers[0];
      // Vincula o número de telefone ao usuário no banco!
      db.prepare("UPDATE users SET phone = ? WHERE id = ? AND (phone IS NULL OR phone = '')").run(phone, matched.id);

      data.requester_id = matched.id;
      data.requester_name = matched.name;
      if (data.mode === 'fleet' || forceFleetMode) {
        saveSession(db, phone, 'FLEET_AWAITING_PLATE', data, matched.id);
        const msg = renderTemplate(db, 'fleet_bot_welcome', {
          nome: matched.name,
          telefone: phone,
        });
        await sendReply(msg);
        return { handled: true, step: 'FLEET_AWAITING_PLATE', response: msg };
      }
      saveSession(db, phone, 'AWAITING_TAG', data, matched.id);

      const roleMap = {
        solicitante: 'Solicitante / Produção',
        manutentor: 'Técnico de Manutenção',
        gerente: 'Gestor de Manutenção',
        admin: 'Administrador',
        superadmin: 'Super Admin',
      };

      const msg = renderTemplate(db, 'bot_user_confirmed', {
        nome: matched.name,
        funcao: roleMap[matched.role] || matched.role,
        telefone: phone,
      });
      await sendReply(msg);
      return { handled: true, step: 'AWAITING_TAG', response: msg };
    }

    if (matchedUsers.length > 1) {
      // Múltiplos encontrados: apresenta opções numeradas
      data.candidate_users = matchedUsers.map(u => ({ id: u.id, name: u.name, role: u.role }));
      saveSession(db, phone, 'SELECTING_USER_CANDIDATE', data);

      const listText = matchedUsers.map((u, i) => `*${i + 1}* - ${u.name} (${u.role})`).join('\n');
      const msg = `👥 Encontramos mais de um colaborador com esse nome:\n\n${listText}\n\n_(Digite o número correspondente ao seu nome ou *cancelar*)_`;
      await sendReply(msg);
      return { handled: true, step: 'SELECTING_USER_CANDIDATE', response: msg };
    }

    // Nenhum encontrado
    const msg = `⚠️ Não encontramos nenhum colaborador ativo com o nome ou usuário *"${rawText}"*.\n\nPor favor, digite seu *Nome Completo* ou *Matrícula* conforme cadastrado no aplicativo (ou digite *cancelar*):`;
    await sendReply(msg);
    return { handled: true, step: 'AWAITING_USER_IDENTIFICATION', response: msg };
  }

  // -------------------------------------------------------------
  // ETAPA: Escolha entre múltiplos usuários com nome similar
  // -------------------------------------------------------------
  if (step === 'SELECTING_USER_CANDIDATE') {
    const choice = parseInt(rawText, 10);
    const candidates = data.candidate_users || [];
    if (isNaN(choice) || choice < 1 || choice > candidates.length) {
      const msg = `Opção inválida. Digite um número de 1 a ${candidates.length} para selecionar seu nome:`;
      await sendReply(msg);
      return { handled: true, step: 'SELECTING_USER_CANDIDATE', response: msg };
    }

    const selected = candidates[choice - 1];
    db.prepare("UPDATE users SET phone = ? WHERE id = ? AND (phone IS NULL OR phone = '')").run(phone, selected.id);

    data.requester_id = selected.id;
    data.requester_name = selected.name;
    delete data.candidate_users;
    if (data.mode === 'fleet' || forceFleetMode) {
      saveSession(db, phone, 'FLEET_AWAITING_PLATE', data, selected.id);
      const msg = renderTemplate(db, 'fleet_bot_welcome', {
        nome: selected.name,
        telefone: phone,
      });
      await sendReply(msg);
      return { handled: true, step: 'FLEET_AWAITING_PLATE', response: msg };
    }
    saveSession(db, phone, 'AWAITING_TAG', data, selected.id);

    const msg = renderTemplate(db, 'bot_user_confirmed', {
      nome: selected.name,
      funcao: selected.role,
      telefone: phone,
    });
    await sendReply(msg);
    return { handled: true, step: 'AWAITING_TAG', response: msg };
  }

  // -------------------------------------------------------------
  // ETAPA: Pergunta da TAG da Máquina
  // -------------------------------------------------------------
  if (step === 'AWAITING_TAG') {
    const inputTag = rawText.toUpperCase().trim();

    // Busca por código (TAG) ou nome
    const machine = db.prepare(`
      SELECT m.*, s.name as sector_name 
      FROM machines m 
      LEFT JOIN sectors s ON s.id = m.sector_id 
      WHERE m.active=1 
        AND (UPPER(m.code) = ? OR UPPER(m.name) = ? OR UPPER(m.code) LIKE ?)
      LIMIT 1
    `).get(inputTag, inputTag, `%${inputTag}%`);

    if (machine) {
      data.machine_id = machine.id;
      data.machine_code = machine.code;
      data.machine_name = machine.name;
      data.sector_name = machine.sector_name || 'Geral';

      saveSession(db, phone, 'AWAITING_PRIORITY', data, session.user_id);

      const msg = renderTemplate(db, 'bot_ask_priority', {
        maquina: machine.name,
        tag: machine.code,
        setor: machine.sector_name || 'Geral',
      });
      await sendReply(msg);
      return { handled: true, step: 'AWAITING_PRIORITY', response: msg };
    }

    // TAG não encontrada -> Oferece opções de fallback
    data.attempted_tag = inputTag;
    saveSession(db, phone, 'TAG_NOT_FOUND_CHOICE', data, session.user_id);

    const msg = renderTemplate(db, 'bot_tag_not_found', {
      tag: inputTag,
    });
    await sendReply(msg);
    return { handled: true, step: 'TAG_NOT_FOUND_CHOICE', response: msg };
  }

  // -------------------------------------------------------------
  // ETAPA: Escolha de Fallback para TAG Não Encontrada
  // -------------------------------------------------------------
  if (step === 'TAG_NOT_FOUND_CHOICE') {
    if (lowerText === '1') {
      saveSession(db, phone, 'AWAITING_TAG', data, session.user_id);
      const msg = renderTemplate(db, 'bot_ask_tag', { nome: data.requester_name || '' });
      await sendReply(msg);
      return { handled: true, step: 'AWAITING_TAG', response: msg };
    }

    if (lowerText === '2') {
      // Listar Setores
      const sectors = db.prepare('SELECT id, code, name FROM sectors ORDER BY name').all();
      if (!sectors.length) {
        const msg = '⚠️ Não há setores cadastrados no momento. Digite a TAG novamente:';
        saveSession(db, phone, 'AWAITING_TAG', data, session.user_id);
        await sendReply(msg);
        return { handled: true, step: 'AWAITING_TAG', response: msg };
      }

      data.sectors_list = sectors;
      saveSession(db, phone, 'SELECTING_SECTOR', data, session.user_id);

      const formattedSectors = sectors.map((s, i) => `*${i + 1}* - ${s.name} (${s.code})`).join('\n');
      const msg = renderTemplate(db, 'bot_choose_sector', {
        lista_setores: formattedSectors,
      });
      await sendReply(msg);
      return { handled: true, step: 'SELECTING_SECTOR', response: msg };
    }

    if (lowerText === '3') {
      // Cadastrar nova máquina rápida com essa TAG
      const sectors = db.prepare('SELECT id, code, name FROM sectors ORDER BY name').all();
      data.sectors_list = sectors;
      saveSession(db, phone, 'NEW_MACHINE_SELECT_SECTOR', data, session.user_id);

      const formattedSectors = sectors.map((s, i) => `*${i + 1}* - ${s.name}`).join('\n');
      const msg = `🏭 Para cadastrar a máquina com a TAG *${data.attempted_tag}*, escolha o setor correspondente:\n\n${formattedSectors}\n\n_(Digite o número do setor)_`;
      await sendReply(msg);
      return { handled: true, step: 'NEW_MACHINE_SELECT_SECTOR', response: msg };
    }

    const msg = `Opção inválida. Digite:\n*1* - Digitar TAG novamente\n*2* - Escolher pelo Setor\n*3* - Cadastrar nova máquina`;
    await sendReply(msg);
    return { handled: true, step: 'TAG_NOT_FOUND_CHOICE', response: msg };
  }

  // -------------------------------------------------------------
  // ETAPA: Seleção de Setor para navegar máquinas
  // -------------------------------------------------------------
  if (step === 'SELECTING_SECTOR') {
    if (lowerText === 'voltar') {
      saveSession(db, phone, 'TAG_NOT_FOUND_CHOICE', data, session.user_id);
      const msg = renderTemplate(db, 'bot_tag_not_found', { tag: data.attempted_tag || '' });
      await sendReply(msg);
      return { handled: true, step: 'TAG_NOT_FOUND_CHOICE', response: msg };
    }

    const choice = parseInt(rawText, 10);
    const sectors = data.sectors_list || [];
    if (isNaN(choice) || choice < 1 || choice > sectors.length) {
      const msg = `Opção inválida. Digite o número do setor (1 a ${sectors.length}) ou *voltar*:`;
      await sendReply(msg);
      return { handled: true, step: 'SELECTING_SECTOR', response: msg };
    }

    const selectedSector = sectors[choice - 1];
    data.selected_sector_id = selectedSector.id;
    data.selected_sector_name = selectedSector.name;

    const machines = db.prepare(`
      SELECT id, code, name 
      FROM machines 
      WHERE sector_id = ? AND active = 1 
      ORDER BY name
    `).all(selectedSector.id);

    if (!machines.length) {
      const msg = `⚠️ Nenhuma máquina ativa cadastrada no setor *${selectedSector.name}*.\n\nDigite *1* para escolher outro setor ou *cancelar*:`;
      saveSession(db, phone, 'TAG_NOT_FOUND_CHOICE', data, session.user_id);
      await sendReply(msg);
      return { handled: true, step: 'TAG_NOT_FOUND_CHOICE', response: msg };
    }

    data.machines_list = machines;
    saveSession(db, phone, 'SELECTING_MACHINE', data, session.user_id);

    const formattedMachines = machines.map((m, i) => `*${i + 1}* - ${m.name} (TAG: ${m.code})`).join('\n');
    const msg = renderTemplate(db, 'bot_choose_machine', {
      setor: selectedSector.name,
      lista_maquinas: formattedMachines,
    });
    await sendReply(msg);
    return { handled: true, step: 'SELECTING_MACHINE', response: msg };
  }

  // -------------------------------------------------------------
  // ETAPA: Seleção de Máquina da Lista do Setor
  // -------------------------------------------------------------
  if (step === 'SELECTING_MACHINE') {
    if (lowerText === 'voltar') {
      saveSession(db, phone, 'SELECTING_SECTOR', data, session.user_id);
      const sectors = data.sectors_list || [];
      const formattedSectors = sectors.map((s, i) => `*${i + 1}* - ${s.name}`).join('\n');
      const msg = renderTemplate(db, 'bot_choose_sector', { lista_setores: formattedSectors });
      await sendReply(msg);
      return { handled: true, step: 'SELECTING_SECTOR', response: msg };
    }

    const choice = parseInt(rawText, 10);
    const machines = data.machines_list || [];
    if (isNaN(choice) || choice < 1 || choice > machines.length) {
      const msg = `Opção inválida. Digite o número da máquina (1 a ${machines.length}) ou *voltar*:`;
      await sendReply(msg);
      return { handled: true, step: 'SELECTING_MACHINE', response: msg };
    }

    const selectedMachine = machines[choice - 1];
    data.machine_id = selectedMachine.id;
    data.machine_code = selectedMachine.code;
    data.machine_name = selectedMachine.name;
    data.sector_name = data.selected_sector_name || 'Geral';

    saveSession(db, phone, 'AWAITING_PRIORITY', data, session.user_id);

    const msg = renderTemplate(db, 'bot_ask_priority', {
      maquina: selectedMachine.name,
      tag: selectedMachine.code,
      setor: data.sector_name,
    });
    await sendReply(msg);
    return { handled: true, step: 'AWAITING_PRIORITY', response: msg };
  }

  // -------------------------------------------------------------
  // ETAPA: Nova Máquina Rápida - Escolha do Setor
  // -------------------------------------------------------------
  if (step === 'NEW_MACHINE_SELECT_SECTOR') {
    const choice = parseInt(rawText, 10);
    const sectors = data.sectors_list || [];
    if (isNaN(choice) || choice < 1 || choice > sectors.length) {
      const msg = `Opção inválida. Digite o número do setor (1 a ${sectors.length}):`;
      await sendReply(msg);
      return { handled: true, step: 'NEW_MACHINE_SELECT_SECTOR', response: msg };
    }

    const selectedSector = sectors[choice - 1];
    data.new_sector_id = selectedSector.id;
    data.new_sector_name = selectedSector.name;

    saveSession(db, phone, 'NEW_MACHINE_NAME', data, session.user_id);

    const msg = renderTemplate(db, 'bot_ask_new_machine_name', {
      tag: data.attempted_tag,
      setor: selectedSector.name,
    });
    await sendReply(msg);
    return { handled: true, step: 'NEW_MACHINE_NAME', response: msg };
  }

  // -------------------------------------------------------------
  // ETAPA: Nova Máquina Rápida - Nome do Equipamento
  // -------------------------------------------------------------
  if (step === 'NEW_MACHINE_NAME') {
    const machineName = rawText.trim();
    if (machineName.length < 3) {
      const msg = 'Por favor, digite um nome descritivo com pelo menos 3 caracteres:';
      await sendReply(msg);
      return { handled: true, step: 'NEW_MACHINE_NAME', response: msg };
    }

    const newMachId = 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    db.prepare(`
      INSERT INTO machines (id, code, name, sector_id, criticality, active)
      VALUES (?, ?, ?, ?, 'media', 1)
    `).run(newMachId, data.attempted_tag, machineName, data.new_sector_id);

    data.machine_id = newMachId;
    data.machine_code = data.attempted_tag;
    data.machine_name = machineName;
    data.sector_name = data.new_sector_name;

    saveSession(db, phone, 'AWAITING_PRIORITY', data, session.user_id);

    const msg = renderTemplate(db, 'bot_ask_priority', {
      maquina: machineName,
      tag: data.attempted_tag,
      setor: data.new_sector_name,
    });
    await sendReply(msg);
    return { handled: true, step: 'AWAITING_PRIORITY', response: msg };
  }

  // -------------------------------------------------------------
  // ETAPA: Escolha de Prioridade (1-Baixa, 2-Média, 3-Alta, 4-Urgente)
  // -------------------------------------------------------------
  if (step === 'AWAITING_PRIORITY') {
    let priority = 'media';
    if (['1', 'baixa'].includes(lowerText)) priority = 'baixa';
    else if (['2', 'media', 'média'].includes(lowerText)) priority = 'media';
    else if (['3', 'alta'].includes(lowerText)) priority = 'alta';
    else if (['4', 'urgente'].includes(lowerText)) priority = 'urgente';
    else {
      const msg = `⚠️ Opção de prioridade inválida. Digite:\n*1* - Baixa\n*2* - Média\n*3* - Alta\n*4* - Urgente`;
      await sendReply(msg);
      return { handled: true, step: 'AWAITING_PRIORITY', response: msg };
    }

    data.priority = priority;
    saveSession(db, phone, 'AWAITING_STOPPED', data, session.user_id);

    const msg = renderTemplate(db, 'bot_ask_stopped', {
      maquina: data.machine_name,
      tag: data.machine_code,
    });
    await sendReply(msg);
    return { handled: true, step: 'AWAITING_STOPPED', response: msg };
  }

  // -------------------------------------------------------------
  // ETAPA: Pergunta Máquina Parada? (1-Sim, 2-Não)
  // -------------------------------------------------------------
  if (step === 'AWAITING_STOPPED') {
    let stopped = 0;
    if (['1', 'sim', 's', 'parada', 'parou'].includes(lowerText)) {
      stopped = 1;
    } else if (['2', 'nao', 'não', 'n', 'operando', 'rodando'].includes(lowerText)) {
      stopped = 0;
    } else {
      const msg = `⚠️ Opção inválida. A máquina está parada no momento?\n*1* - Sim, máquina parada 🛑\n*2* - Não, operando ⚡`;
      await sendReply(msg);
      return { handled: true, step: 'AWAITING_STOPPED', response: msg };
    }

    data.machine_stopped = stopped;
    saveSession(db, phone, 'AWAITING_DESCRIPTION', data, session.user_id);

    const msg = renderTemplate(db, 'bot_ask_description', {
      maquina: data.machine_name,
      tag: data.machine_code,
    });
    await sendReply(msg);
    return { handled: true, step: 'AWAITING_DESCRIPTION', response: msg };
  }

  // -------------------------------------------------------------
  // ETAPA: Descrição do Problema & Finalização da OS
  // -------------------------------------------------------------
  if (step === 'AWAITING_DESCRIPTION') {
    let description = rawText.trim();

    // Se o usuário anexou uma foto nesta etapa
    if (mediaAttachment) {
      if (!data.attachments) data.attachments = [];
      data.attachments.push(mediaAttachment);

      // Se enviou foto sem legenda ou com texto automático
      if (description === 'Registro fotográfico anexado' || description === 'Foto anexada' || description.length < 3) {
        description = 'Registro fotográfico anexado pelo solicitante via WhatsApp';
      }
    }

    const hasAttachments = Array.isArray(data.attachments) && data.attachments.length > 0;

    if (description.length < 3 && !hasAttachments) {
      const msg = 'Por favor, descreva o defeito com um pouco mais de detalhes (mínimo 3 caracteres) ou envie uma foto do problema:';
      await sendReply(msg);
      return { handled: true, step: 'AWAITING_DESCRIPTION', response: msg };
    }

    // Identifica o solicitante (ID registrado na sessão)
    let requesterId = data.requester_id || session.user_id;
    if (!requesterId) {
      const fallbackUser = db.prepare("SELECT id, name FROM users WHERE active=1 ORDER BY CASE role WHEN 'solicitante' THEN 1 ELSE 2 END LIMIT 1").get();
      requesterId = fallbackUser?.id;
      data.requester_name = fallbackUser?.name || 'Solicitante';
    }

    const woId = 'wo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const opId = 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);

    const op = {
      opId,
      userId: requesterId,
      type: 'create_wo',
      localTime: new Date().toISOString(),
      origin: 'whatsapp_bot',
      payload: {
        id: woId,
        machineId: data.machine_id,
        type: 'corretiva',
        priority: data.priority || 'media',
        machineStopped: Number(data.machine_stopped) === 1,
        description: description,
        recipientsMode: 'todos',
        attachments: data.attachments || [],
      }
    };

    let result;
    try {
      result = applyOp(db, op);
    } catch (err) {
      console.error('[WhatsApp-Bot] Falha ao criar OS:', err.message);
      const errorMsg = `❌ Ocorreu um erro ao registrar a Ordem de Serviço no sistema: ${err.message}\nPor favor, tente novamente ou procure o suporte.`;
      deleteSession(db, phone);
      await sendReply(errorMsg);
      return { error: err.message, response: errorMsg };
    }

    const osNumber = result?.number || (db.prepare('SELECT number FROM work_orders WHERE id = ?').get(woId)?.number) || 'S/N';

    // Remove a sessão conversacional após a conclusão bem-sucedida
    deleteSession(db, phone);

    const prioLabelMap = {
      urgente: '🔴 Urgente',
      alta: '🟠 Alta',
      media: '🟡 Média',
      baixa: '🟢 Baixa',
    };

    const timeNow = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const hasPhoto = data.attachments && data.attachments.length > 0;
    const photoText = hasPhoto ? '📸 *Foto Anexada:* Registrada com sucesso no sistema' : '';

    const successMsg = renderTemplate(db, 'bot_success', {
      numero: osNumber,
      maquina: data.machine_name,
      tag: data.machine_code,
      setor: data.sector_name,
      prioridade: prioLabelMap[data.priority] || data.priority,
      status_parada: Number(data.machine_stopped) === 1 ? '🛑 MÁQUINA PARADA' : '⚡ Operando com alerta',
      solicitante: data.requester_name || 'Solicitante',
      foto_anexada: photoText,
      descricao: description,
      horario: timeNow,
    });

    await sendReply(successMsg);

    return {
      handled: true,
      step: 'COMPLETED',
      woId,
      number: osNumber,
      response: successMsg,
    };
  }

  // =========================================================================
  // MÁQUINA DE ESTADOS EXCLUSIVA DA FROTA (SOMENTE VEÍCULOS / PLACA)
  // =========================================================================
  if (step === 'FLEET_AWAITING_PLATE') {
    const v = findFleetVehicle(rawText);
    if (v) {
      const vehLabel = [v.brand, v.model, v.nickname ? `(${v.nickname})` : ''].filter(Boolean).join(' ').trim() || v.plate;
      data.vehicle_id = v.id;
      data.plate = v.plate;
      data.vehicle_label = vehLabel;
      data.current_km = v.odometer_km || 0;
      saveSession(db, phone, 'FLEET_AWAITING_KM', data, session.user_id);

      const msg = renderTemplate(db, 'fleet_bot_ask_km', {
        veiculo: vehLabel,
        placa: v.plate,
        km_atual: Number(v.odometer_km || 0).toLocaleString('pt-BR'),
      });
      await sendReply(msg);
      return { handled: true, step: 'FLEET_AWAITING_KM', response: msg };
    }

    data.attempted_plate = rawText.toUpperCase().trim();
    saveSession(db, phone, 'FLEET_PLATE_NOT_FOUND_CHOICE', data, session.user_id);
    const msg = renderTemplate(db, 'fleet_bot_plate_not_found', {
      placa: data.attempted_plate,
    });
    await sendReply(msg);
    return { handled: true, step: 'FLEET_PLATE_NOT_FOUND_CHOICE', response: msg };
  }

  if (step === 'FLEET_PLATE_NOT_FOUND_CHOICE') {
    if (lowerText === '1') {
      saveSession(db, phone, 'FLEET_AWAITING_PLATE', data, session.user_id);
      const msg = renderTemplate(db, 'fleet_bot_ask_plate', { nome: data.requester_name || '' });
      await sendReply(msg);
      return { handled: true, step: 'FLEET_AWAITING_PLATE', response: msg };
    }

    if (lowerText === '2') {
      const vehicles = db.prepare('SELECT id, plate, brand, model, nickname, odometer_km FROM fleet_vehicles WHERE active = 1 ORDER BY plate').all();
      data.vehicles_list = vehicles.map((v) => ({
        id: v.id,
        plate: v.plate,
        label: [v.brand, v.model, v.nickname ? `(${v.nickname})` : ''].filter(Boolean).join(' ').trim() || v.plate,
        km: v.odometer_km || 0,
      }));
      saveSession(db, phone, 'FLEET_SELECTING_VEHICLE', data, session.user_id);

      const listStr = data.vehicles_list.map((v, i) => `*${i + 1}* - *${v.plate}* • ${v.label}`).join('\n');
      const msg = renderTemplate(db, 'fleet_bot_choose_vehicle', {
        lista_veiculos: listStr,
      });
      await sendReply(msg);
      return { handled: true, step: 'FLEET_SELECTING_VEHICLE', response: msg };
    }

    // Se o motorista já digitou outra placa diretamente, tenta localizar
    const directVeh = findFleetVehicle(rawText);
    if (directVeh) {
      const vehLabel = [directVeh.brand, directVeh.model, directVeh.nickname ? `(${directVeh.nickname})` : ''].filter(Boolean).join(' ').trim() || directVeh.plate;
      data.vehicle_id = directVeh.id;
      data.plate = directVeh.plate;
      data.vehicle_label = vehLabel;
      data.current_km = directVeh.odometer_km || 0;
      saveSession(db, phone, 'FLEET_AWAITING_KM', data, session.user_id);
      const msg = renderTemplate(db, 'fleet_bot_ask_km', {
        veiculo: vehLabel,
        placa: directVeh.plate,
        km_atual: Number(directVeh.odometer_km || 0).toLocaleString('pt-BR'),
      });
      await sendReply(msg);
      return { handled: true, step: 'FLEET_AWAITING_KM', response: msg };
    }

    const msg = `Opção inválida. Digite *1* para informar a Placa novamente ou *2* para ver a lista de veículos da Frota:`;
    await sendReply(msg);
    return { handled: true, step: 'FLEET_PLATE_NOT_FOUND_CHOICE', response: msg };
  }

  if (step === 'FLEET_SELECTING_VEHICLE') {
    if (lowerText === 'voltar') {
      saveSession(db, phone, 'FLEET_AWAITING_PLATE', data, session.user_id);
      const msg = renderTemplate(db, 'fleet_bot_ask_plate', { nome: data.requester_name || '' });
      await sendReply(msg);
      return { handled: true, step: 'FLEET_AWAITING_PLATE', response: msg };
    }

    const choice = parseInt(rawText, 10);
    const list = data.vehicles_list || [];
    if (isNaN(choice) || choice < 1 || choice > list.length) {
      // Também aceita se digitou a placa direto
      const byPlate = findFleetVehicle(rawText);
      if (!byPlate) {
        const msg = `Opção inválida. Digite o número do veículo (1 a ${list.length}) ou a Placa:`;
        await sendReply(msg);
        return { handled: true, step: 'FLEET_SELECTING_VEHICLE', response: msg };
      }
      data.vehicle_id = byPlate.id;
      data.plate = byPlate.plate;
      data.vehicle_label = [byPlate.brand, byPlate.model, byPlate.nickname ? `(${byPlate.nickname})` : ''].filter(Boolean).join(' ').trim() || byPlate.plate;
      data.current_km = byPlate.odometer_km || 0;
    } else {
      const sel = list[choice - 1];
      data.vehicle_id = sel.id;
      data.plate = sel.plate;
      data.vehicle_label = sel.label;
      data.current_km = sel.km || 0;
    }

    delete data.vehicles_list;
    saveSession(db, phone, 'FLEET_AWAITING_KM', data, session.user_id);
    const msg = renderTemplate(db, 'fleet_bot_ask_km', {
      veiculo: data.vehicle_label,
      placa: data.plate,
      km_atual: Number(data.current_km || 0).toLocaleString('pt-BR'),
    });
    await sendReply(msg);
    return { handled: true, step: 'FLEET_AWAITING_KM', response: msg };
  }

  if (step === 'FLEET_AWAITING_KM') {
    const cleanNum = rawText.replace(/\./g, '').replace(',', '.').replace(/[^0-9.]/g, '');
    const parsedKm = cleanNum !== '' ? Number(cleanNum) : NaN;
    if (isNaN(parsedKm) || parsedKm < 0) {
      const msg = `Por favor, digite apenas os números da quilometragem atual (ex: *125400*) ou envie *0* se não souber:`;
      await sendReply(msg);
      return { handled: true, step: 'FLEET_AWAITING_KM', response: msg };
    }

    if (parsedKm > 0 && parsedKm < (data.current_km || 0)) {
      const msg = `⚠️ O Km informado (*${parsedKm.toLocaleString('pt-BR')} km*) é menor que o último registrado no sistema (*${Number(data.current_km).toLocaleString('pt-BR')} km*).\n\nDigite o Km correto no painel ou envie *0* para manter o atual:`;
      await sendReply(msg);
      return { handled: true, step: 'FLEET_AWAITING_KM', response: msg };
    }

    data.informed_km = parsedKm > 0 ? Math.round(parsedKm) : (data.current_km || 0);
    saveSession(db, phone, 'FLEET_AWAITING_PRIORITY', data, session.user_id);

    const msg = renderTemplate(db, 'fleet_bot_ask_priority', {
      veiculo: data.vehicle_label,
      placa: data.plate,
      km: `${Number(data.informed_km || 0).toLocaleString('pt-BR')} km`,
    });
    await sendReply(msg);
    return { handled: true, step: 'FLEET_AWAITING_PRIORITY', response: msg };
  }

  if (step === 'FLEET_AWAITING_PRIORITY') {
    let priority = 'media';
    if (['1', 'baixa'].includes(lowerText)) priority = 'baixa';
    else if (['2', 'media', 'média'].includes(lowerText)) priority = 'media';
    else if (['3', 'alta'].includes(lowerText)) priority = 'alta';
    else if (['4', 'urgente'].includes(lowerText)) priority = 'urgente';
    else {
      const msg = `⚠️ Opção inválida. Digite:\n*1* - Baixa\n*2* - Média\n*3* - Alta\n*4* - Urgente`;
      await sendReply(msg);
      return { handled: true, step: 'FLEET_AWAITING_PRIORITY', response: msg };
    }

    data.priority = priority;
    saveSession(db, phone, 'FLEET_AWAITING_STOPPED', data, session.user_id);

    const msg = renderTemplate(db, 'fleet_bot_ask_stopped', {
      veiculo: data.vehicle_label,
      placa: data.plate,
    });
    await sendReply(msg);
    return { handled: true, step: 'FLEET_AWAITING_STOPPED', response: msg };
  }

  if (step === 'FLEET_AWAITING_STOPPED') {
    let stopped = 0;
    if (['1', 'sim', 's', 'parado', 'parada', 'imobilizado'].includes(lowerText)) {
      stopped = 1;
    } else if (['2', 'nao', 'não', 'n', 'rodando', 'operando'].includes(lowerText)) {
      stopped = 0;
    } else {
      const msg = `⚠️ Opção inválida. O veículo *${data.plate}* está parado?\n*1* - Sim, veículo parado 🛑\n*2* - Não, ainda consegue rodar ⚡`;
      await sendReply(msg);
      return { handled: true, step: 'FLEET_AWAITING_STOPPED', response: msg };
    }

    data.machine_stopped = stopped;
    saveSession(db, phone, 'FLEET_AWAITING_DESCRIPTION', data, session.user_id);

    const msg = renderTemplate(db, 'fleet_bot_ask_description', {
      veiculo: data.vehicle_label,
      placa: data.plate,
    });
    await sendReply(msg);
    return { handled: true, step: 'FLEET_AWAITING_DESCRIPTION', response: msg };
  }

  if (step === 'FLEET_AWAITING_DESCRIPTION') {
    let description = rawText.trim();
    if (mediaAttachment) {
      if (!data.attachments) data.attachments = [];
      data.attachments.push(mediaAttachment);
      if (description === 'Registro fotográfico anexado' || description === 'Foto anexada' || description.length < 3) {
        description = 'Registro fotográfico do veículo anexado via WhatsApp';
      }
    }

    const hasAttachments = Array.isArray(data.attachments) && data.attachments.length > 0;
    if (description.length < 3 && !hasAttachments) {
      const msg = 'Por favor, descreva o problema do veículo (mínimo 3 caracteres) ou envie uma foto:';
      await sendReply(msg);
      return { handled: true, step: 'FLEET_AWAITING_DESCRIPTION', response: msg };
    }

    let requesterId = data.requester_id || session.user_id;
    if (!requesterId) {
      const fallbackUser = db.prepare("SELECT id, name FROM users WHERE active=1 ORDER BY CASE role WHEN 'solicitante' THEN 1 ELSE 2 END LIMIT 1").get();
      requesterId = fallbackUser?.id;
      data.requester_name = fallbackUser?.name || 'Motorista';
    }

    const veh = db.prepare('SELECT * FROM fleet_vehicles WHERE id = ?').get(data.vehicle_id);
    if (!veh) {
      deleteSession(db, phone);
      const errMsg = '❌ Veículo não encontrado. Digite *frota* para iniciar novamente.';
      await sendReply(errMsg);
      return { error: 'Veículo não encontrado', response: errMsg };
    }

    // Garante que existe a máquina vinculada no setor FROTA e atualiza Km/Status se necessário
    const machineId = ensureMachineForVehicle(db, veh);
    if (data.informed_km && data.informed_km > (veh.odometer_km || 0)) {
      try { setOdometer(db, veh, data.informed_km, 'os_whatsapp', requesterId, 'Abertura de OS via WhatsApp'); } catch (_) {}
    }
    if (Number(data.machine_stopped) === 1 && veh.status === 'ativo') {
      db.prepare("UPDATE fleet_vehicles SET status = 'manutencao', updated_at = ? WHERE id = ?").run(new Date().toISOString(), veh.id);
    }

    const woId = 'wo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const opId = 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const kmSuffix = data.informed_km ? ` [Km: ${Number(data.informed_km).toLocaleString('pt-BR')}]` : '';

    const op = {
      opId,
      userId: requesterId,
      type: 'create_wo',
      localTime: new Date().toISOString(),
      origin: 'whatsapp_fleet_bot',
      payload: {
        id: woId,
        machineId,
        type: 'corretiva',
        priority: data.priority || 'media',
        machineStopped: Number(data.machine_stopped) === 1,
        description: `${description}${kmSuffix}`,
        recipientsMode: 'todos',
        attachments: data.attachments || [],
      },
    };

    let result;
    try {
      result = applyOp(db, op);
    } catch (err) {
      deleteSession(db, phone);
      const errorMsg = `❌ Erro ao abrir OS de Frota: ${err.message}`;
      await sendReply(errorMsg);
      return { error: err.message, response: errorMsg };
    }

    const osNumber = result?.number || (db.prepare('SELECT number FROM work_orders WHERE id = ?').get(woId)?.number) || 'S/N';
    deleteSession(db, phone);

    const prioLabelMap = { urgente: '🔴 Urgente', alta: '🟠 Alta', media: '🟡 Média', baixa: '🟢 Baixa' };
    const timeNow = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const hasPhoto = data.attachments && data.attachments.length > 0;
    const photoText = hasPhoto ? '📸 *Foto Anexada:* Registrada na OS' : '';

    const successMsg = renderTemplate(db, 'fleet_bot_success', {
      numero: osNumber,
      veiculo: data.vehicle_label,
      placa: data.plate,
      km: data.informed_km ? `${Number(data.informed_km).toLocaleString('pt-BR')} km` : 'Não informado',
      prioridade: prioLabelMap[data.priority] || data.priority,
      status_parada: Number(data.machine_stopped) === 1 ? '🛑 VEÍCULO PARADO / EM MANUTENÇÃO' : '⚡ Rodando com alerta',
      solicitante: data.requester_name || 'Motorista',
      foto_anexada: photoText,
      descricao: description,
      horario: timeNow,
    });

    await sendReply(successMsg);
    return {
      handled: true,
      step: 'COMPLETED',
      orderCreated: true,
      workOrder: { id: woId, number: osNumber },
      woId,
      number: osNumber,
      response: successMsg,
    };
  }

  return { skipped: true, reason: 'Etapa não reconhecida' };
}
