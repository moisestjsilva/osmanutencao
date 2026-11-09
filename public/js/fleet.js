// ============================================================================
// MÓDULO DE GESTÃO DE FROTA DE CAMINHÕES (FRONTEND)
// Integrado ao Nova OS com controle de permissões por módulo:
//   • gestor (Admin / Super Admin / Gerente ou fleet_role = 'gestor')
//   • mecanico (fleet_role = 'mecanico')
//   • motorista (fleet_role = 'motorista')
// ============================================================================
import { state, api } from './store.js';
import { $, $$, esc, icon, toast, sheet, confirmDialog, fmtDate, fmtDateTime, localInputValue, avatar } from './ui.js';

export function fleetLevelOf(user = state.user) {
  if (!user) return null;
  if (['superadmin', 'admin', 'gerente'].includes(user.role)) return 'gestor';
  const fr = user.fleetAccess || user.fleetRole || user.fleet_role || null;
  return ['gestor', 'mecanico', 'motorista'].includes(fr) ? fr : null;
}

export function hasFleetAccess(user = state.user) {
  return !!fleetLevelOf(user);
}

const LEVEL_LABEL = {
  gestor: 'Gestor da Frota',
  mecanico: 'Mecânico da Frota',
  motorista: 'Motorista',
};

const VEH_TYPE_LABEL = {
  toco: 'Caminhão Toco (2 eixos)',
  truck: 'Caminhão Truck (3 eixos)',
  bitruck: 'Bitruck (4 eixos)',
  cavalo: 'Cavalo Mecânico',
  carreta: 'Carreta / Conjunto',
  vuc: 'VUC / 3/4',
  utilitario: 'Utilitário / Fiorino / Van',
  outro: 'Outro',
};

const FUEL_LABEL = {
  diesel_s10: 'Diesel S10',
  diesel_s500: 'Diesel S500',
  arla32: 'Arla 32',
  gasolina: 'Gasolina',
  etanol: 'Etanol',
  gnv: 'GNV',
};

const VEH_STATUS_LABEL = {
  ativo: 'Ativo',
  manutencao: 'Em Manutenção',
  inativo: 'Inativo',
  vendido: 'Vendido',
};

const COST_CAT_LABEL = {
  combustivel: 'Combustível',
  manutencao: 'Manutenção / Oficina',
  pneus: 'Pneus / Recapagem',
  pedagio: 'Pedágio',
  seguro: 'Seguro',
  documentacao: 'Documentação / Taxas',
  multa: 'Multa',
  lavagem: 'Lavagem / Higienização',
  estacionamento: 'Estacionamento / Pátio',
  diaria: 'Diária / Alimentação',
  outros: 'Outros',
};

const TIRE_EVENT_LABEL = {
  instalacao: 'Instalar em Veículo',
  rodizio: 'Rodízio de Posição',
  remocao: 'Remover p/ Estoque',
  recapagem: 'Enviar p/ Recapagem',
  calibragem: 'Calibragem / Sulco',
  reparo: 'Conserto / Reparo',
  descarte: 'Descartar (Fim de Vida)',
};

const brl = (v) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const numFmt = (v, d = 0) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const todayIso = () => new Date().toISOString().slice(0, 10);

function statusPill(st) {
  const map = {
    ativo: ['ok', 'Ativo'],
    manutencao: ['warn', 'Em Manutenção'],
    inativo: ['', 'Inativo'],
    vendido: ['', 'Vendido'],
    em_andamento: ['info', 'Em Viagem'],
    concluida: ['ok', 'Concluída'],
    cancelada: ['', 'Cancelada'],
    vencida: ['danger', 'Vencida'],
    vencido: ['danger', 'Vencido'],
    proxima: ['warn', 'Próxima'],
    vencendo: ['warn', 'Vencendo'],
    ok: ['ok', 'Em dia'],
    valido: ['ok', 'Válido'],
    pendente: ['warn', 'Pendente'],
    paga: ['ok', 'Paga'],
    recurso: ['info', 'Em Recurso'],
    em_uso: ['ok', 'Rodando'],
    estoque: ['info', 'Estoque'],
    recapagem: ['warn', 'Recapagem'],
    descartado: ['', 'Descartado'],
  };
  const [cls, lbl] = map[st] || ['', st || '—'];
  return `<span class="badge ${cls}">${esc(lbl)}</span>`;
}

function plateBadge(plate, nickname) {
  return `<span style="display:inline-flex;align-items:center;gap:6px">
    <span style="font-family:'Space Grotesk',monospace;font-weight:800;font-size:13px;letter-spacing:0.6px;padding:3px 8px;border-radius:6px;background:var(--surface-3);border:1.5px solid var(--border-strong);color:var(--text)">${esc(plate || '—')}</span>
    ${nickname ? `<span class="muted small">${esc(nickname)}</span>` : ''}
  </span>`;
}

export function fleetView(root, params = {}) {
  let alive = true;
  const access = fleetLevelOf(state.user);

  if (!access) {
    root.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Gestão de Frota</h1>
          <p>Controle de caminhões, viagens, combustível e manutenção</p>
        </div>
      </div>
      <div class="empty">
        <strong>Acesso restrito à equipe da Frota</strong>
        <p class="muted small" style="margin-top:6px">Solicite ao administrador a liberação do seu perfil (Motorista, Mecânico ou Gestor da Frota).</p>
      </div>
    `;
    return () => { alive = false; };
  }

  const tabsByRole = {
    gestor: [
      ['painel', 'gauge', 'Painel'],
      ['veiculos', 'truck', 'Veículos'],
      ['viagens', 'route', 'Viagens'],
      ['abastecimentos', 'fuel', 'Combustível'],
      ['checklists', 'check', 'Checklists'],
      ['manutencao', 'wrench', 'Manutenção (Km)'],
      ['pneus', 'tire', 'Pneus'],
      ['documentos', 'doc', 'Docs & Multas'],
      ['custos', 'calendar', 'Custos & Equipe'],
    ],
    mecanico: [
      ['painel', 'gauge', 'Painel'],
      ['veiculos', 'truck', 'Veículos'],
      ['checklists', 'check', 'Checklists'],
      ['manutencao', 'wrench', 'Manutenção (Km)'],
      ['pneus', 'tire', 'Pneus'],
      ['abastecimentos', 'fuel', 'Combustível'],
      ['viagens', 'route', 'Viagens'],
    ],
    motorista: [
      ['painel', 'gauge', 'Meu Painel'],
      ['viagens', 'route', 'Minhas Viagens'],
      ['checklists', 'check', 'Checklist Diário'],
      ['abastecimentos', 'fuel', 'Abastecer'],
      ['documentos', 'doc', 'CNH & Multas'],
    ],
  };

  const tabs = tabsByRole[access] || tabsByRole.motorista;
  let activeTab = tabs.some(([k]) => k === params.tab) ? params.tab : 'painel';

  // Cache compartilhado entre abas
  const cache = {
    vehicles: [],
    drivers: [],
    me: null,
  };

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap">
          <h1 style="margin:0">Gestão de Frota</h1>
          <span class="badge info">${esc(LEVEL_LABEL[access])}</span>
        </div>
        <p>Controle completo de caminhões, hodômetro, viagens, diesel, pneus, documentos e custo/km</p>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap" id="fleet-top-actions"></div>
    </div>

    <div class="cad-tabs" id="fleet-tabs" style="margin-bottom:14px">
      ${tabs.map(([id, ic, lbl]) => `
        <button class="cad-tab ${activeTab === id ? 'active' : ''}" data-tab="${id}">
          ${icon(ic, 16)} <span>${esc(lbl)}</span>
        </button>
      `).join('')}
    </div>

    <div id="fleet-body"><div class="empty">Carregando dados da frota…</div></div>
  `;

  $$('#fleet-tabs .cad-tab', root).forEach((btn) => {
    btn.onclick = () => {
      activeTab = btn.dataset.tab;
      $$('#fleet-tabs .cad-tab', root).forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
      const newUrl = `#/frota${activeTab === 'painel' ? '' : `?tab=${activeTab}`}`;
      if (location.hash !== newUrl) history.replaceState(null, '', newUrl);
      renderCurrentTab();
    };
  });

  async function ensureBaseData() {
    try {
      const [meRes, vehRes] = await Promise.all([
        api('/api/fleet/me'),
        api('/api/fleet/vehicles'),
      ]);
      cache.me = meRes;
      cache.vehicles = vehRes.vehicles || [];
      if (access !== 'motorista') {
        const drvRes = await api('/api/fleet/drivers');
        cache.drivers = drvRes.drivers || [];
      }
    } catch (e) {
      // silencioso, tratado por cada aba
    }
  }

  async function renderCurrentTab() {
    const body = $('#fleet-body', root);
    const topActions = $('#fleet-top-actions', root);
    if (!body) return;
    body.innerHTML = `<div class="empty">Carregando…</div>`;
    if (topActions) topActions.innerHTML = '';

    await ensureBaseData();
    if (!alive) return;

    try {
      if (activeTab === 'painel') await renderDashboard(body, topActions);
      else if (activeTab === 'veiculos') await renderVehicles(body, topActions);
      else if (activeTab === 'viagens') await renderTrips(body, topActions);
      else if (activeTab === 'abastecimentos') await renderFuel(body, topActions);
      else if (activeTab === 'checklists') await renderChecklists(body, topActions);
      else if (activeTab === 'manutencao') await renderMaintenance(body, topActions);
      else if (activeTab === 'pneus') await renderTires(body, topActions);
      else if (activeTab === 'documentos') await renderDocsAndFines(body, topActions);
      else if (activeTab === 'custos') await renderCostsAndTeam(body, topActions);
    } catch (err) {
      body.innerHTML = `<div class="empty"><strong>Não foi possível carregar esta seção</strong><p class="muted small">${esc(err.message || 'Erro de comunicação')}</p></div>`;
    }
  }

  // ==========================================================================
  // 1. PAINEL / DASHBOARD
  // ==========================================================================
  async function renderDashboard(body, topActions) {
    const d = await api('/api/fleet/dashboard');
    if (!alive) return;

    if (access === 'motorista') {
      topActions.innerHTML = `
        <button class="btn" id="qa-checklist">${icon('check', 16)} Checklist</button>
        <button class="btn" id="qa-fuel">${icon('fuel', 16)} Abastecer</button>
        ${d.open_trip
          ? `<button class="btn primary" id="qa-end-trip">${icon('route', 16)} Encerrar Viagem</button>`
          : `<button class="btn primary" id="qa-start-trip">${icon('route', 16)} Iniciar Viagem</button>`}
      `;
      $('#qa-checklist', topActions)?.addEventListener('click', () => openNewChecklistModal(() => renderCurrentTab()));
      $('#qa-fuel', topActions)?.addEventListener('click', () => openFuelModal(null, () => renderCurrentTab()));
      $('#qa-start-trip', topActions)?.addEventListener('click', () => openStartTripModal(() => renderCurrentTab()));
      $('#qa-end-trip', topActions)?.addEventListener('click', () => openEndTripModal(d.open_trip, () => renderCurrentTab()));

      const drv = d.driver;
      body.innerHTML = `
        ${!drv ? `
          <div class="card" style="border-color:var(--warn);margin-bottom:14px">
            <strong>⚠️ Cadastro de Motorista Pendente</strong>
            <p class="muted small" style="margin:6px 0 0">Seu usuário já tem permissão de Motorista, mas ainda não foi vinculado à ficha de CNH. Peça ao Gestor da Frota para completar seu cadastro na aba Equipe.</p>
          </div>
        ` : `
          <section class="card" style="margin-bottom:14px">
            <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
              <div class="row" style="align-items:center;gap:12px">
                ${avatar(drv.name, 48)}
                <div>
                  <strong style="font-size:16px">${esc(drv.name)}</strong>
                  <div class="muted small">CNH: ${esc(drv.cnh_number || 'Não informada')} ${drv.cnh_category ? `• Cat. ${esc(drv.cnh_category)}` : ''}</div>
                </div>
              </div>
              <div>
                ${drv.cnh_expiry ? `Validade CNH: <strong>${fmtDate(drv.cnh_expiry)}</strong> ${statusPill(drv.cnh_state?.state)}` : '<span class="badge warn">Sem validade de CNH</span>'}
              </div>
            </div>
          </section>
        `}

        ${d.open_trip ? `
          <section class="card" style="border:1.5px solid var(--info);margin-bottom:14px">
            <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
              <div>
                <span class="badge info">🚚 VIAGEM EM ANDAMENTO</span>
                <h3 style="margin:6px 0 2px">${plateBadge(d.open_trip.plate, d.open_trip.nickname)}</h3>
                <div class="small">${esc(d.open_trip.origin || 'Origem')} → <strong>${esc(d.open_trip.destination || 'Destino')}</strong></div>
                <div class="muted xs" style="margin-top:4px">Saída: ${fmtDateTime(d.open_trip.start_at)} • Km inicial: ${numFmt(d.open_trip.start_km)} km ${d.open_trip.cargo ? `• Carga: ${esc(d.open_trip.cargo)}` : ''}</div>
              </div>
              <button class="btn primary" id="btn-card-end-trip">Encerrar Viagem</button>
            </div>
          </section>
        ` : ''}

        ${d.alerts?.length ? `
          <div class="section-title"><span>Meus Alertas</span></div>
          <section class="card" style="margin-bottom:14px">
            ${d.alerts.map((a) => `
              <div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
                <span>${esc(a.title)}</span>
                ${statusPill(a.level)}
              </div>
            `).join('')}
          </section>
        ` : ''}

        ${(d.open_orders || []).length ? `
          <div class="section-title">
            <span>🔧 Ordens de Serviço Abertas da Frota (${d.open_orders.length})</span>
            <a href="#/" class="muted xs" style="text-decoration:underline">Ver todas no Quadro de OS →</a>
          </div>
          <div class="cad-grid" style="margin-bottom:14px">
            ${d.open_orders.map((wo) => `
              <div class="cad-card" style="${wo.machine_stopped ? 'border-color:var(--danger)' : ''}">
                <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
                  <div>
                    ${plateBadge(wo.plate, wo.nickname)}
                    <div class="xs muted" style="margin-top:4px">${esc([wo.brand, wo.model].filter(Boolean).join(' '))}</div>
                  </div>
                  <div class="row" style="gap:4px;flex-wrap:wrap;justify-content:flex-end">
                    <span class="badge ${wo.machine_stopped ? 'danger' : 'info'}">OS #${esc(wo.number)}</span>
                    ${wo.machine_stopped ? '<span class="badge danger">🛑 PARADO</span>' : ''}
                  </div>
                </div>
                <div class="small" style="margin-top:6px">
                  <strong>${esc(wo.description || 'Sem descrição')}</strong>
                  <div class="muted xs" style="margin-top:4px">
                    Status: <strong>${esc(wo.status)}</strong> • Prioridade: <strong>${esc(wo.priority)}</strong>
                  </div>
                  <div class="muted xs">Aberta em: ${fmtDateTime(wo.created_at)}</div>
                </div>
                <div class="cad-card-footer">
                  <span class="muted xs">${wo.responsible_name ? `Resp.: ${esc(wo.responsible_name)}` : 'Aguardando atendimento'}</span>
                  <a class="btn sm primary" href="#/os/${esc(wo.id)}" style="text-decoration:none">Ver OS</a>
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div class="section-title"><span>Meus Últimos Checklists</span></div>
        <section class="card">
          ${(d.recent_checklists || []).length ? d.recent_checklists.map((c) => `
            <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
              <div>
                <strong>${esc(c.plate)}</strong> • <span class="muted small">${c.type === 'saida' ? 'Saída' : 'Retorno'} em ${fmtDateTime(c.created_at)}</span>
              </div>
              <div>${c.has_issues ? `<span class="badge danger">${c.critical_issues ? 'Crítico' : 'Com problema'}</span>` : '<span class="badge ok">OK</span>'}</div>
            </div>
          `).join('') : '<div class="muted small">Nenhum checklist realizado recentemente.</div>'}
        </section>
      `;

      $('#btn-card-end-trip', body)?.addEventListener('click', () => openEndTripModal(d.open_trip, () => renderCurrentTab()));
      return;
    }

    // Painel Gestor / Mecânico
    topActions.innerHTML = `
      <button class="btn" id="qa-ck">${icon('check', 16)} Realizar Checklist</button>
      ${access === 'gestor' ? `
        <a href="/whatsapp-frota" target="_blank" rel="noopener noreferrer" class="btn" style="text-decoration:none;border-color:rgba(14,165,233,0.4);color:var(--info)">${icon('message', 16)} Robô WhatsApp Frota</a>
        <button class="btn" id="qa-fuel">${icon('fuel', 16)} + Abastecimento</button>
        <button class="btn" id="qa-trip">${icon('route', 16)} + Viagem</button>
        <button class="btn primary" id="qa-veh">${icon('plus', 16)} Novo Caminhão</button>
      ` : ''}
    `;
    $('#qa-ck', topActions)?.addEventListener('click', () => openNewChecklistModal(() => renderCurrentTab()));
    $('#qa-fuel', topActions)?.addEventListener('click', () => openFuelModal(null, () => renderCurrentTab()));
    $('#qa-trip', topActions)?.addEventListener('click', () => openStartTripModal(() => renderCurrentTab()));
    $('#qa-veh', topActions)?.addEventListener('click', () => openVehicleModal(null, () => renderCurrentTab()));

    const vs = d.vehicles?.by_status || {};
    const alerts = d.alerts || [];

    body.innerHTML = `
      <div class="kpis" style="margin-bottom:16px">
        <div class="kpi">
          <div class="lbl">Frota Ativa</div>
          <div class="val" style="color:var(--ok)">${vs.ativo || 0}<span class="unit"> / ${d.vehicles?.total || 0}</span></div>
          <div class="sub">${vs.manutencao || 0} em manutenção • ${d.open_trips?.length || 0} em viagem agora</div>
        </div>
        <div class="kpi">
          <div class="lbl">Consumo Médio (30d)</div>
          <div class="val" style="color:var(--info)">${d.avg_consumption_30d != null ? numFmt(d.avg_consumption_30d, 2) : '—'}<span class="unit">${d.avg_consumption_30d != null ? ' km/L' : ''}</span></div>
          <div class="sub">cálculo automático tanque cheio</div>
        </div>
        <div class="kpi">
          <div class="lbl">Alertas da Frota</div>
          <div class="val" style="color:${d.alert_counts?.vencidos ? 'var(--danger)' : d.alert_counts?.proximos ? 'var(--warn)' : 'var(--ok)'}">
            ${(d.alert_counts?.vencidos || 0) + (d.alert_counts?.proximos || 0)}
          </div>
          <div class="sub">${d.alert_counts?.vencidos || 0} vencido(s) • ${d.alert_counts?.proximos || 0} próximo(s)</div>
        </div>
        ${access === 'gestor' && d.costs ? `
          <div class="kpi">
            <div class="lbl">Gasto no Mês Atual</div>
            <div class="val" style="color:var(--accent)">${brl(d.costs.month.total)}</div>
            <div class="sub">Diesel: ${brl(d.costs.month.fuel)} • Outros: ${brl(d.costs.month.other)}</div>
          </div>
        ` : ''}
      </div>

      ${(d.open_orders || []).length ? `
        <div class="section-title">
          <span>🔧 Ordens de Serviço Abertas da Frota (${d.open_orders.length})</span>
          <a href="#/" class="muted xs" style="text-decoration:underline">Ver todas no Quadro de OS →</a>
        </div>
        <div class="cad-grid" style="margin-bottom:16px">
          ${d.open_orders.map((wo) => `
            <div class="cad-card" style="${wo.machine_stopped ? 'border-color:var(--danger)' : ''}">
              <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
                <div>
                  ${plateBadge(wo.plate, wo.nickname)}
                  <div class="xs muted" style="margin-top:4px">${esc([wo.brand, wo.model].filter(Boolean).join(' '))}</div>
                </div>
                <div class="row" style="gap:4px;flex-wrap:wrap;justify-content:flex-end">
                  <span class="badge ${wo.machine_stopped ? 'danger' : 'info'}">OS #${esc(wo.number)}</span>
                  ${wo.machine_stopped ? '<span class="badge danger">🛑 PARADO</span>' : ''}
                </div>
              </div>
              <div class="small" style="margin-top:6px">
                <strong>${esc(wo.description || 'Sem descrição')}</strong>
                <div class="muted xs" style="margin-top:4px">
                  Status: <strong>${esc(wo.status)}</strong> • Prioridade: <strong>${esc(wo.priority)}</strong>
                  ${wo.requester_name ? ` • Solicitante: ${esc(wo.requester_name)}` : ''}
                </div>
                <div class="muted xs">Aberta em: ${fmtDateTime(wo.created_at)}</div>
              </div>
              <div class="cad-card-footer">
                <span class="muted xs">${wo.responsible_name ? `Resp.: ${esc(wo.responsible_name)}` : 'Aguardando atendimento'}</span>
                <a class="btn sm primary" href="#/os/${esc(wo.id)}" style="text-decoration:none">Abrir / Atender OS</a>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${(d.open_trips || []).length ? `
        <div class="section-title"><span>🚚 Caminhões em Viagem Agora (${d.open_trips.length})</span></div>
        <div class="cad-grid" style="margin-bottom:16px">
          ${d.open_trips.map((t) => `
            <div class="cad-card">
              <div class="row" style="justify-content:space-between;align-items:flex-start">
                ${plateBadge(t.plate, t.nickname)}
                <span class="badge info">Em andamento</span>
              </div>
              <div class="small" style="margin-top:4px">
                <strong>${esc(t.origin || 'Origem')} → ${esc(t.destination || 'Destino')}</strong>
                <div class="muted xs">Motorista: ${esc(t.driver_name || '—')} • Saída: ${fmtDateTime(t.start_at)} • Km saída: ${numFmt(t.start_km)}</div>
                ${t.cargo ? `<div class="muted xs">Carga: ${esc(t.cargo)}</div>` : ''}
              </div>
              <div class="cad-card-footer">
                <span class="muted xs">Km inicial ${numFmt(t.start_km)}</span>
                <button class="btn sm primary" data-end-trip="${esc(t.id)}">Encerrar Viagem</button>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div class="section-title">
        <span>⚠️ Central de Alertas (Preventivas por Km, Documentos e CNH)</span>
        <span class="muted xs">${alerts.length} alerta(s) ativo(s)</span>
      </div>
      <section class="card" style="margin-bottom:16px">
        ${alerts.length ? `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Situação</th><th>Tipo</th><th>Descrição</th><th>Detalhe</th></tr></thead>
              <tbody>
                ${alerts.map((a) => `
                  <tr>
                    <td>${statusPill(a.level)}</td>
                    <td><span class="muted xs">${esc(a.kind?.toUpperCase() || '')}</span></td>
                    <td><strong>${esc(a.title)}</strong></td>
                    <td class="muted small">${esc(a.detail || '—')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="muted small" style="padding:8px 0">Tudo em dia! Nenhuma preventiva por km, documento ou CNH vencida/vencendo.</div>'}
      </section>

      ${(d.checklist_issues || []).length ? `
        <div class="section-title"><span>Checklists Recentes com Apontamento (7 dias)</span></div>
        <section class="card">
          ${d.checklist_issues.map((c) => `
            <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:8px">
              <div>
                ${plateBadge(c.plate)}
                <span class="small" style="margin-left:8px">Motorista: <strong>${esc(c.driver_name || '—')}</strong> • ${fmtDateTime(c.created_at)}</span>
              </div>
              <div class="row" style="gap:8px;align-items:center">
                ${c.critical_issues ? `<span class="badge danger">${c.critical_issues} crítico(s)</span>` : '<span class="badge warn">Avaria leve</span>'}
                ${c.wo_id ? `<a class="btn sm" href="#/os/${esc(c.wo_id)}">Ver OS</a>` : ''}
                <button class="btn sm" data-view-ck="${esc(c.id)}">Ver Checklist</button>
              </div>
            </div>
          `).join('')}
        </section>
      ` : ''}
    `;

    $$('[data-end-trip]', body).forEach((b) => {
      b.onclick = () => {
        const trip = (d.open_trips || []).find((x) => x.id === b.dataset.endTrip);
        if (trip) openEndTripModal(trip, () => renderCurrentTab());
      };
    });
    $$('[data-view-ck]', body).forEach((b) => {
      b.onclick = () => openChecklistDetailModal(b.dataset.viewCk);
    });
  }

  // ==========================================================================
  // 2. VEÍCULOS
  // ==========================================================================
  async function renderVehicles(body, topActions) {
    if (access === 'gestor') {
      topActions.innerHTML = `<button class="btn primary" id="btn-new-veh">${icon('plus', 16)} Cadastrar Caminhão</button>`;
      $('#btn-new-veh', topActions).onclick = () => openVehicleModal(null, () => renderCurrentTab());
    }

    const res = await api('/api/fleet/vehicles?include_inactive=1');
    if (!alive) return;
    cache.vehicles = res.vehicles || [];

    if (!cache.vehicles.length) {
      body.innerHTML = `
        <div class="empty">
          <strong>Nenhum caminhão ou veículo cadastrado</strong>
          <p class="muted small" style="margin:6px 0 12px">Cadastre os veículos da frota para controlar hodômetro, diesel, pneus, viagens e preventivas por km.</p>
          ${access === 'gestor' ? `<button class="btn primary" id="btn-empty-veh">${icon('plus', 16)} Cadastrar 1º Caminhão</button>` : ''}
        </div>
      `;
      $('#btn-empty-veh', body)?.addEventListener('click', () => openVehicleModal(null, () => renderCurrentTab()));
      return;
    }

    body.innerHTML = `
      <div class="cad-grid">
        ${cache.vehicles.map((v) => `
          <div class="cad-card">
            <div class="cad-card-header" style="justify-content:space-between">
              <div>
                ${plateBadge(v.plate, v.nickname)}
                <div style="margin-top:6px;font-weight:700;font-size:15px">${esc([v.brand, v.model].filter(Boolean).join(' ') || VEH_TYPE_LABEL[v.type] || 'Veículo')}</div>
                <div class="muted xs">${esc(VEH_TYPE_LABEL[v.type] || v.type)} ${v.year_model ? `• Ano ${v.year_manufacture || v.year_model}/${v.year_model}` : ''} • ${esc(FUEL_LABEL[v.fuel_type] || v.fuel_type)}</div>
              </div>
              <div style="text-align:right;display:flex;flex-direction:column;gap:4px;align-items:flex-end">
                ${statusPill(v.status)}
                ${v.in_trip ? '<span class="badge info">🚚 Em viagem</span>' : ''}
              </div>
            </div>

            <div class="cad-card-body">
              <div class="row" style="justify-content:space-between;background:var(--surface-2);padding:8px 12px;border-radius:10px;border:1px solid var(--border)">
                <div>
                  <div class="muted xs">Hodômetro Atual</div>
                  <strong style="font-size:16px;font-family:'Space Grotesk',sans-serif">${numFmt(v.odometer_km)} km</strong>
                </div>
                <div style="text-align:right">
                  <div class="muted xs">Eixos / Tanque</div>
                  <strong class="small">${v.axles || 2} eixos ${v.tank_capacity_l ? `• ${numFmt(v.tank_capacity_l)} L` : ''}</strong>
                </div>
              </div>
              ${(v.alerts?.vencidos || v.alerts?.proximos) ? `
                <div class="row" style="gap:6px;margin-top:4px">
                  ${v.alerts.vencidos ? `<span class="badge danger">${v.alerts.vencidos} alerta(s) vencido(s)</span>` : ''}
                  ${v.alerts.proximos ? `<span class="badge warn">${v.alerts.proximos} próximo(s)</span>` : ''}
                </div>
              ` : ''}
            </div>

            <div class="cad-card-footer" style="flex-wrap:wrap;gap:6px">
              <button class="btn sm" data-veh-km="${esc(v.id)}">${icon('gauge', 14)} Atualizar Km</button>
              <button class="btn sm" data-veh-detail="${esc(v.id)}">${icon('eye', 14)} Ficha Completa</button>
              ${access === 'gestor' ? `<button class="btn sm" data-veh-edit="${esc(v.id)}">${icon('edit', 14)}</button>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;

    $$('[data-veh-km]', body).forEach((b) => {
      b.onclick = () => {
        const v = cache.vehicles.find((x) => x.id === b.dataset.vehKm);
        if (v) openOdometerModal(v, () => renderCurrentTab());
      };
    });
    $$('[data-veh-detail]', body).forEach((b) => {
      b.onclick = () => openVehicleDetailModal(b.dataset.vehDetail, () => renderCurrentTab());
    });
    $$('[data-veh-edit]', body).forEach((b) => {
      b.onclick = () => {
        const v = cache.vehicles.find((x) => x.id === b.dataset.vehEdit);
        if (v) openVehicleModal(v, () => renderCurrentTab());
      };
    });
  }

  // ==========================================================================
  // 3. VIAGENS
  // ==========================================================================
  async function renderTrips(body, topActions) {
    if (access === 'gestor' || access === 'motorista') {
      topActions.innerHTML = `<button class="btn primary" id="btn-start-trip">${icon('route', 16)} Iniciar Viagem</button>`;
      $('#btn-start-trip', topActions).onclick = () => openStartTripModal(() => renderCurrentTab());
    }

    const res = await api('/api/fleet/trips?limit=100');
    if (!alive) return;
    const trips = res.trips || [];

    body.innerHTML = `
      ${trips.length ? `
        <section class="card">
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Veículo</th>
                  <th>Motorista</th>
                  <th>Rota / Carga</th>
                  <th>Saída</th>
                  <th class="num">Km Inicial → Final</th>
                  <th class="num">Distância</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                ${trips.map((t) => `
                  <tr>
                    <td>${statusPill(t.status)}</td>
                    <td>${plateBadge(t.plate, t.nickname)}</td>
                    <td>${esc(t.driver_name || '—')}</td>
                    <td>
                      <strong>${esc(t.origin || '—')} → ${esc(t.destination || '—')}</strong>
                      ${t.cargo ? `<div class="muted xs">Carga: ${esc(t.cargo)}</div>` : ''}
                    </td>
                    <td class="small">${fmtDateTime(t.start_at)}${t.end_at ? `<div class="muted xs">Fim: ${fmtDateTime(t.end_at)}</div>` : ''}</td>
                    <td class="num small">${numFmt(t.start_km)} → ${t.end_km != null ? numFmt(t.end_km) : '…'}</td>
                    <td class="num"><strong>${t.distance_km != null ? `${numFmt(t.distance_km)} km` : '—'}</strong></td>
                    <td>
                      ${t.status === 'em_andamento' && (access === 'gestor' || access === 'motorista') ? `
                        <button class="btn sm primary" data-end-trip="${esc(t.id)}">Encerrar</button>
                      ` : ''}
                      ${t.status === 'em_andamento' && access === 'gestor' ? `
                        <button class="btn sm danger" data-cancel-trip="${esc(t.id)}">Cancelar</button>
                      ` : ''}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </section>
      ` : `
        <div class="empty">
          <strong>Nenhuma viagem registrada</strong>
          <p class="muted small" style="margin-top:6px">Registre a saída e chegada das viagens para rastrear quilometragem, motorista responsável em cada horário e despesas de rota.</p>
        </div>
      `}
    `;

    $$('[data-end-trip]', body).forEach((b) => {
      b.onclick = () => {
        const t = trips.find((x) => x.id === b.dataset.endTrip);
        if (t) openEndTripModal(t, () => renderCurrentTab());
      };
    });
    $$('[data-cancel-trip]', body).forEach((b) => {
      b.onclick = async () => {
        const ok = await confirmDialog({ title: 'Cancelar viagem?', body: 'A viagem será marcada como cancelada.', confirm: 'Cancelar Viagem', danger: true });
        if (!ok) return;
        try {
          await api(`/api/fleet/trips/${b.dataset.cancelTrip}/cancel`, { method: 'POST', body: { reason: 'Cancelada pelo gestor' } });
          toast('Viagem cancelada');
          renderCurrentTab();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  }

  // ==========================================================================
  // 4. ABASTECIMENTOS / COMBUSTÍVEL
  // ==========================================================================
  async function renderFuel(body, topActions) {
    if (access === 'gestor' || access === 'motorista') {
      topActions.innerHTML = `<button class="btn primary" id="btn-new-fuel">${icon('fuel', 16)} Registrar Abastecimento</button>`;
      $('#btn-new-fuel', topActions).onclick = () => openFuelModal(null, () => renderCurrentTab());
    }

    const res = await api('/api/fleet/fuel?limit=120');
    if (!alive) return;
    const rows = res.fuel || [];
    const tot = res.totals || {};

    body.innerHTML = `
      <div class="kpis" style="margin-bottom:14px">
        <div class="kpi">
          <div class="lbl">Volume Abastecido</div>
          <div class="val">${numFmt(tot.liters, 1)}<span class="unit"> L</span></div>
          <div class="sub">${rows.length} abastecimento(s) listado(s)</div>
        </div>
        <div class="kpi">
          <div class="lbl">Média de Consumo</div>
          <div class="val" style="color:var(--ok)">${tot.avg_consumption != null ? numFmt(tot.avg_consumption, 2) : '—'}<span class="unit">${tot.avg_consumption != null ? ' km/L' : ''}</span></div>
          <div class="sub">cálculo automático entre tanques cheios</div>
        </div>
        ${tot.total != null ? `
          <div class="kpi">
            <div class="lbl">Valor Total</div>
            <div class="val" style="color:var(--accent)">${brl(tot.total)}</div>
            <div class="sub">soma dos abastecimentos listados</div>
          </div>
        ` : ''}
      </div>

      ${rows.length ? `
        <section class="card">
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Veículo</th>
                  <th>Motorista</th>
                  <th>Combustível / Posto</th>
                  <th class="num">Hodômetro</th>
                  <th class="num">Litros</th>
                  ${access !== 'mecanico' ? '<th class="num">Total</th>' : ''}
                  <th class="num">Média (km/L)</th>
                  ${access === 'gestor' ? '<th></th>' : ''}
                </tr>
              </thead>
              <tbody>
                ${rows.map((f) => `
                  <tr>
                    <td class="small">${fmtDateTime(f.filled_at)}</td>
                    <td>${plateBadge(f.plate, f.nickname)}</td>
                    <td class="small">${esc(f.driver_name || '—')}</td>
                    <td class="small">
                      ${esc(FUEL_LABEL[f.fuel_type] || f.fuel_type)}
                      ${f.station ? `<div class="muted xs">${esc(f.station)}</div>` : ''}
                    </td>
                    <td class="num">${numFmt(f.km)} km</td>
                    <td class="num">${numFmt(f.liters, 1)} L ${f.full_tank ? '<span class="badge ok xs">Cheio</span>' : ''}</td>
                    ${access !== 'mecanico' ? `<td class="num"><strong>${brl(f.total)}</strong><div class="muted xs">${f.price_per_l ? `${brl(f.price_per_l)}/L` : ''}</div></td>` : ''}
                    <td class="num">${f.consumption_km_l != null ? `<strong style="color:var(--ok)">${numFmt(f.consumption_km_l, 2)} km/L</strong>` : '<span class="muted xs">—</span>'}</td>
                    ${access === 'gestor' ? `<td><button class="btn sm danger" data-del-fuel="${esc(f.id)}">${icon('trash', 14)}</button></td>` : ''}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </section>
      ` : '<div class="empty"><strong>Nenhum abastecimento registrado</strong><p class="muted small" style="margin-top:6px">Ao lançar abastecimentos com tanque cheio, o sistema calcula automaticamente a média km/L de cada caminhão.</p></div>'}
    `;

    $$('[data-del-fuel]', body).forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog({ title: 'Excluir abastecimento?', body: 'O cálculo de consumo do veículo será recalculado.', confirm: 'Excluir', danger: true }))) return;
        try {
          await api(`/api/fleet/fuel/${b.dataset.delFuel}`, { method: 'DELETE' });
          toast('Abastecimento removido');
          renderCurrentTab();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  }

  // ==========================================================================
  // 5. CHECKLIST DIÁRIO
  // ==========================================================================
  async function renderChecklists(body, topActions) {
    topActions.innerHTML = `<button class="btn primary" id="btn-new-ck">${icon('check', 16)} Realizar Checklist</button>`;
    $('#btn-new-ck', topActions).onclick = () => openNewChecklistModal(() => renderCurrentTab());

    const res = await api('/api/fleet/checklists?limit=60');
    if (!alive) return;
    const rows = res.checklists || [];

    body.innerHTML = `
      ${rows.length ? `
        <section class="card">
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Data/Hora</th>
                  <th>Tipo</th>
                  <th>Veículo</th>
                  <th>Motorista</th>
                  <th class="num">Hodômetro</th>
                  <th>Resultado</th>
                  <th>OS Gerada</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((c) => `
                  <tr>
                    <td class="small">${fmtDateTime(c.created_at)}</td>
                    <td><span class="badge ${c.type === 'saida' ? 'info' : ''}">${c.type === 'saida' ? 'Saída' : 'Retorno'}</span></td>
                    <td>${plateBadge(c.plate, c.nickname)}</td>
                    <td class="small">${esc(c.driver_name || '—')}</td>
                    <td class="num">${c.km != null ? `${numFmt(c.km)} km` : '—'}</td>
                    <td>
                      ${c.has_issues
                        ? `<span class="badge ${c.critical_issues ? 'danger' : 'warn'}">${c.critical_issues ? `${c.critical_issues} Crítico(s)` : 'Com observação'}</span>`
                        : '<span class="badge ok">100% OK</span>'}
                    </td>
                    <td>${c.wo_id ? `<a class="btn sm" href="#/os/${esc(c.wo_id)}">Abrir OS</a>` : '—'}</td>
                    <td><button class="btn sm" data-view-ck="${esc(c.id)}">Ver Itens</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </section>
      ` : '<div class="empty"><strong>Nenhum checklist realizado</strong><p class="muted small" style="margin-top:6px">Itens críticos com problema bloqueiam automaticamente o caminhão para manutenção e abrem uma Ordem de Serviço.</p></div>'}
    `;

    $$('[data-view-ck]', body).forEach((b) => {
      b.onclick = () => openChecklistDetailModal(b.dataset.viewCk);
    });
  }

  // ==========================================================================
  // 6. MANUTENÇÃO PREVENTIVA POR KM / DIAS
  // ==========================================================================
  async function renderMaintenance(body, topActions) {
    topActions.innerHTML = `<button class="btn primary" id="btn-new-plan">${icon('plus', 16)} Novo Plano por Km/Dias</button>`;
    $('#btn-new-plan', topActions).onclick = () => openPlanModal(null, () => renderCurrentTab());

    const [plansRes, histRes] = await Promise.all([
      api('/api/fleet/plans'),
      api('/api/fleet/maintenance-history?limit=40'),
    ]);
    if (!alive) return;
    const plans = plansRes.plans || [];
    const history = histRes.history || [];

    body.innerHTML = `
      <div class="section-title"><span>Planos Preventivos por Quilometragem e Tempo (${plans.length})</span></div>
      ${plans.length ? `
        <div class="cad-grid" style="margin-bottom:18px">
          ${plans.map((p) => `
            <div class="cad-card">
              <div class="row" style="justify-content:space-between;align-items:flex-start">
                <div>
                  ${plateBadge(p.plate, p.nickname)}
                  <h3 style="margin:6px 0 2px;font-size:15px">${esc(p.title)}</h3>
                </div>
                ${statusPill(p.state)}
              </div>
              <div class="small" style="background:var(--surface-2);padding:8px 10px;border-radius:8px">
                ${p.every_km ? `<div>A cada <strong>${numFmt(p.every_km)} km</strong> • Próx: <strong>${numFmt(p.next_km)} km</strong> (${p.remaining_km <= 0 ? `<span style="color:var(--danger)">vencida há ${numFmt(Math.abs(p.remaining_km))} km</span>` : `faltam ${numFmt(p.remaining_km)} km`})</div>` : ''}
                ${p.every_days ? `<div>A cada <strong>${p.every_days} dias</strong> • Próx: <strong>${fmtDate(p.next_date)}</strong> (${p.remaining_days <= 0 ? `<span style="color:var(--danger)">vencida há ${Math.abs(p.remaining_days)}d</span>` : `faltam ${p.remaining_days}d`})</div>` : ''}
                <div class="muted xs" style="margin-top:4px">Última execução: ${p.last_km != null ? `${numFmt(p.last_km)} km` : ''} ${p.last_date ? `em ${fmtDate(p.last_date)}` : ''}</div>
              </div>
              <div class="cad-card-footer" style="gap:6px;flex-wrap:wrap">
                <button class="btn sm primary" data-plan-done="${esc(p.id)}">${icon('check', 14)} Registrar Feito</button>
                <button class="btn sm" data-plan-os="${esc(p.id)}">${icon('wrench', 14)} Gerar OS</button>
                ${access === 'gestor' ? `<button class="btn sm danger" data-plan-del="${esc(p.id)}">${icon('trash', 14)}</button>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty" style="margin-bottom:16px"><strong>Nenhum plano preventivo cadastrado</strong><p class="muted small">Ex.: Troca de óleo do motor a cada 20.000 km ou 180 dias, filtro de ar, diferencial, caixa, aferição de tacógrafo.</p></div>'}

      <div class="section-title"><span>Histórico de Manutenções Executadas</span></div>
      <section class="card">
        ${history.length ? `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Data</th><th>Veículo</th><th>Serviço</th><th class="num">Km</th><th class="num">Custo</th><th>Observações</th></tr></thead>
              <tbody>
                ${history.map((h) => `
                  <tr>
                    <td>${fmtDate(h.done_date)}</td>
                    <td>${plateBadge(h.plate)}</td>
                    <td><strong>${esc(h.title)}</strong></td>
                    <td class="num">${h.km != null ? `${numFmt(h.km)} km` : '—'}</td>
                    <td class="num">${h.cost != null ? brl(h.cost) : '—'}</td>
                    <td class="muted small">${esc(h.notes || '—')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="muted small">Nenhuma execução registrada ainda.</div>'}
      </section>
    `;

    $$('[data-plan-done]', body).forEach((b) => {
      b.onclick = () => {
        const p = plans.find((x) => x.id === b.dataset.planDone);
        if (p) openPlanDoneModal(p, () => renderCurrentTab());
      };
    });
    $$('[data-plan-os]', body).forEach((b) => {
      b.onclick = async () => {
        try {
          const r = await api(`/api/fleet/plans/${b.dataset.planOs}/open-os`, { method: 'POST' });
          toast(`OS #${r.wo.number} gerada com sucesso!`);
        } catch (e) { toast(e.message, 'err'); }
      };
    });
    $$('[data-plan-del]', body).forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog({ title: 'Excluir plano preventivo?', confirm: 'Excluir', danger: true }))) return;
        try {
          await api(`/api/fleet/plans/${b.dataset.planDel}`, { method: 'DELETE' });
          toast('Plano removido');
          renderCurrentTab();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  }

  // ==========================================================================
  // 7. PNEUS (CONTROLE POR FOGO / POSIÇÃO / RODÍZIO / RECAPAGEM)
  // ==========================================================================
  async function renderTires(body, topActions) {
    topActions.innerHTML = `<button class="btn primary" id="btn-new-tire">${icon('plus', 16)} Cadastrar Pneu</button>`;
    $('#btn-new-tire', topActions).onclick = () => openTireModal(null, () => renderCurrentTab());

    const res = await api('/api/fleet/tires');
    if (!alive) return;
    const tires = res.tires || [];

    body.innerHTML = `
      ${tires.length ? `
        <div class="cad-grid">
          ${tires.map((t) => `
            <div class="cad-card">
              <div class="row" style="justify-content:space-between;align-items:flex-start">
                <div>
                  <span class="badge" style="font-family:monospace;font-weight:700">🔥 Fogo: ${esc(t.serial || 'S/N')}</span>
                  <div style="margin-top:6px;font-weight:700">${esc([t.brand, t.model].filter(Boolean).join(' ') || 'Pneu')} ${t.size ? `<span class="muted small">(${esc(t.size)})</span>` : ''}</div>
                </div>
                ${statusPill(t.status)}
              </div>

              <div class="small" style="background:var(--surface-2);padding:8px 10px;border-radius:8px">
                ${t.plate ? `<div>Instalado em: <strong>${esc(t.plate)}</strong> • Posição: <strong>${esc(t.position)}</strong></div>` : '<div class="muted">Fora de veículo (Estoque / Recapagem)</div>'}
                <div style="margin-top:4px">Km rodados: <strong>${numFmt(t.km_run)} km</strong> ${t.expected_km ? `de ${numFmt(t.expected_km)} km (${t.life_pct}%)` : ''}</div>
                <div class="muted xs">Recapagens: ${t.retread_count || 0}</div>
              </div>

              <div class="cad-card-footer" style="gap:6px;flex-wrap:wrap">
                <button class="btn sm primary" data-tire-ev="${esc(t.id)}">Movimentar / Rodízio</button>
                <button class="btn sm" data-tire-hist="${esc(t.id)}">Histórico</button>
              </div>
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty"><strong>Nenhum pneu cadastrado</strong><p class="muted small" style="margin-top:6px">Controle cada pneu pelo número de fogo, posição no eixo (1E, 1D, 2EE, 2EI...), km acumulados e recapagens.</p></div>'}
    `;

    $$('[data-tire-ev]', body).forEach((b) => {
      b.onclick = () => {
        const t = tires.find((x) => x.id === b.dataset.tireEv);
        if (t) openTireEventModal(t, () => renderCurrentTab());
      };
    });
    $$('[data-tire-hist]', body).forEach((b) => {
      b.onclick = async () => {
        const t = tires.find((x) => x.id === b.dataset.tireHist);
        const r = await api(`/api/fleet/tires/${b.dataset.tireHist}/events`);
        sheet(`
          <h2>Histórico do Pneu ${esc(t?.serial || '')}</h2>
          <div style="margin-top:10px">
            ${(r.events || []).map((ev) => `
              <div style="padding:8px 0;border-bottom:1px solid var(--border)">
                <strong>${esc(TIRE_EVENT_LABEL[ev.type] || ev.type)}</strong> • ${fmtDate(ev.event_date)}
                <div class="muted xs">${ev.plate ? `Veículo ${esc(ev.plate)} (${esc(ev.position || '')}) • ` : ''}${ev.km != null ? `${numFmt(ev.km)} km • ` : ''}${ev.cost ? brl(ev.cost) : ''}</div>
                ${ev.notes ? `<div class="small">${esc(ev.notes)}</div>` : ''}
              </div>
            `).join('') || '<div class="muted small">Sem eventos.</div>'}
          </div>
          <div class="sheet-actions"><button class="btn" data-close>Fechar</button></div>
        `);
      };
    });
  }

  // ==========================================================================
  // 8. DOCUMENTOS & MULTAS
  // ==========================================================================
  async function renderDocsAndFines(body, topActions) {
    if (access === 'gestor') {
      topActions.innerHTML = `
        <button class="btn" id="btn-new-doc">${icon('doc', 16)} + Documento</button>
        <button class="btn primary" id="btn-new-fine">${icon('alert', 16)} + Multa</button>
      `;
      $('#btn-new-doc', topActions).onclick = () => openDocModal(() => renderCurrentTab());
      $('#btn-new-fine', topActions).onclick = () => openFineModal(null, () => renderCurrentTab());
    }

    const [docsRes, finesRes] = await Promise.all([
      api('/api/fleet/documents'),
      api('/api/fleet/fines'),
    ]);
    if (!alive) return;
    const docs = docsRes.documents || [];
    const fines = finesRes.fines || [];

    body.innerHTML = `
      <div class="section-title"><span>📄 Documentos e Licenças (CRLV, ANTT, Tacógrafo, Seguro, Toxicológico)</span></div>
      <section class="card" style="margin-bottom:18px">
        ${docs.length ? `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Status</th><th>Vínculo</th><th>Documento</th><th>Número</th><th>Vencimento</th>${access === 'gestor' ? '<th></th>' : ''}</tr></thead>
              <tbody>
                ${docs.map((d) => `
                  <tr>
                    <td>${statusPill(d.status?.state)}</td>
                    <td><strong>${esc(d.owner_label || '—')}</strong> <span class="muted xs">(${d.entity_type === 'vehicle' ? 'Veículo' : 'Motorista'})</span></td>
                    <td>${esc(d.doc_type)}</td>
                    <td class="small">${esc(d.number || '—')}</td>
                    <td><strong>${fmtDate(d.expiry_date)}</strong> ${d.status?.days != null ? `<span class="muted xs">(${d.status.days < 0 ? `vencido há ${Math.abs(d.status.days)}d` : `${d.status.days}d`})</span>` : ''}</td>
                    ${access === 'gestor' ? `<td><button class="btn sm danger" data-del-doc="${esc(d.id)}">${icon('trash', 14)}</button></td>` : ''}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="muted small">Nenhum documento cadastrado.</div>'}
      </section>

      <div class="section-title"><span>🚨 Multas de Trânsito (Identificação Automática do Motorista pela Viagem)</span></div>
      <section class="card">
        ${fines.length ? `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Status</th><th>Data Infração</th><th>Veículo</th><th>Motorista</th><th>Infração / Local</th><th class="num">Pts</th><th class="num">Valor</th><th>Vencimento</th>${access === 'gestor' ? '<th></th>' : ''}</tr></thead>
              <tbody>
                ${fines.map((f) => `
                  <tr>
                    <td>${statusPill(f.status)}</td>
                    <td class="small">${fmtDateTime(f.fine_date)}</td>
                    <td>${plateBadge(f.plate)}</td>
                    <td><strong>${esc(f.driver_name || 'Não identificado')}</strong></td>
                    <td class="small">
                      <strong>${esc(f.infraction)}</strong>
                      <div class="muted xs">${esc([f.ait_number ? `AIT ${f.ait_number}` : '', f.location || ''].filter(Boolean).join(' • '))}</div>
                    </td>
                    <td class="num">${f.points || '—'}</td>
                    <td class="num"><strong>${brl(f.amount)}</strong></td>
                    <td class="small">${fmtDate(f.due_date)}</td>
                    ${access === 'gestor' ? `
                      <td>
                        <div class="row" style="gap:4px">
                          ${f.status === 'pendente' ? `<button class="btn sm primary" data-pay-fine="${esc(f.id)}">Dar Baixa</button>` : ''}
                          <button class="btn sm danger" data-del-fine="${esc(f.id)}">${icon('trash', 14)}</button>
                        </div>
                      </td>
                    ` : ''}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="muted small">Nenhuma multa registrada.</div>'}
      </section>
    `;

    $$('[data-del-doc]', body).forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog({ title: 'Excluir documento?', confirm: 'Excluir', danger: true }))) return;
        await api(`/api/fleet/documents/${b.dataset.delDoc}`, { method: 'DELETE' });
        toast('Documento removido');
        renderCurrentTab();
      };
    });
    $$('[data-pay-fine]', body).forEach((b) => {
      b.onclick = async () => {
        await api(`/api/fleet/fines/${b.dataset.payFine}`, { method: 'PUT', body: { status: 'paga' } });
        toast('Multa marcada como paga');
        renderCurrentTab();
      };
    });
    $$('[data-del-fine]', body).forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog({ title: 'Excluir multa?', confirm: 'Excluir', danger: true }))) return;
        await api(`/api/fleet/fines/${b.dataset.delFine}`, { method: 'DELETE' });
        toast('Multa removida');
        renderCurrentTab();
      };
    });
  }

  // ==========================================================================
  // 9. CUSTOS / KM + MOTORISTAS & PERMISSÕES DA FROTA (GESTOR)
  // ==========================================================================
  async function renderCostsAndTeam(body, topActions) {
    const today = todayIso();
    const firstDay = today.slice(0, 8) + '01';

    topActions.innerHTML = `
      <button class="btn" id="btn-new-driver">${icon('userPlus', 16)} + Motorista</button>
      <button class="btn" id="btn-new-cost">${icon('plus', 16)} + Lançar Custo</button>
      <a class="btn primary" href="/api/fleet/reports/costs.csv?from=${firstDay}&to=${today}" target="_blank">${icon('download', 16)} Exportar CSV</a>
    `;
    $('#btn-new-driver', topActions).onclick = () => openDriverModal(null, () => renderCurrentTab());
    $('#btn-new-cost', topActions).onclick = () => openCostModal(() => renderCurrentTab());

    const [rep, teamRes, drvRes] = await Promise.all([
      api(`/api/fleet/reports/costs?from=${firstDay}&to=${today}`),
      api('/api/fleet/team'),
      api('/api/fleet/drivers'),
    ]);
    if (!alive) return;
    cache.drivers = drvRes.drivers || [];
    const team = teamRes.users || [];

    body.innerHTML = `
      <div class="section-title">
        <span>💰 Custo por Km e Desempenho Financeiro (${fmtDate(rep.from)} a ${fmtDate(rep.to)})</span>
      </div>
      <div class="kpis" style="margin-bottom:14px">
        <div class="kpi">
          <div class="lbl">Custo Total no Período</div>
          <div class="val" style="color:var(--accent)">${brl(rep.totals?.total)}</div>
          <div class="sub">soma de todas as categorias</div>
        </div>
        <div class="kpi">
          <div class="lbl">Combustível</div>
          <div class="val">${brl(rep.totals?.fuel)}</div>
          <div class="sub">${numFmt(rep.totals?.liters, 1)} L abastecidos</div>
        </div>
        <div class="kpi">
          <div class="lbl">Manutenção / Pneus / Outros</div>
          <div class="val">${brl(rep.totals?.other_costs)}</div>
          <div class="sub">Multas pagas: ${brl(rep.totals?.fines)}</div>
        </div>
        <div class="kpi">
          <div class="lbl">Custo Médio / Km da Frota</div>
          <div class="val" style="color:var(--info)">${rep.totals?.cost_per_km != null ? brl(rep.totals.cost_per_km) : '—'}<span class="unit">${rep.totals?.cost_per_km != null ? '/km' : ''}</span></div>
          <div class="sub">${numFmt(rep.totals?.km_driven)} km rodados no período</div>
        </div>
      </div>

      <section class="card" style="margin-bottom:18px">
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Caminhão</th>
                <th class="num">Km Rodados</th>
                <th class="num">Litros</th>
                <th class="num">Média km/L</th>
                <th class="num">Combustível</th>
                <th class="num">Manut./Outros</th>
                <th class="num">Total</th>
                <th class="num">Custo / Km</th>
              </tr>
            </thead>
            <tbody>
              ${(rep.vehicles || []).map((v) => `
                <tr>
                  <td>${plateBadge(v.plate, v.nickname)}</td>
                  <td class="num">${numFmt(v.km_driven)} km</td>
                  <td class="num">${numFmt(v.liters, 1)} L</td>
                  <td class="num">${v.avg_consumption ? `${numFmt(v.avg_consumption, 2)} km/L` : '—'}</td>
                  <td class="num">${brl(v.fuel)}</td>
                  <td class="num">${brl((v.other_costs || 0) + (v.fines || 0))}</td>
                  <td class="num"><strong>${brl(v.total)}</strong></td>
                  <td class="num"><strong>${v.cost_per_km != null ? `${brl(v.cost_per_km)}/km` : '—'}</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </section>

      <div class="section-title">
        <span>🪪 Cadastro de Motoristas e CNH (${cache.drivers.length})</span>
      </div>
      <section class="card" style="margin-bottom:18px">
        ${cache.drivers.length ? `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Motorista</th><th>CPF / Telefone</th><th>CNH / Cat.</th><th>Validade CNH</th><th>Usuário App</th><th></th></tr></thead>
              <tbody>
                ${cache.drivers.map((d) => `
                  <tr>
                    <td><strong>${esc(d.name)}</strong></td>
                    <td class="small">${esc(d.cpf || '—')} ${d.phone ? `• ${esc(d.phone)}` : ''}</td>
                    <td class="small">${esc(d.cnh_number || '—')} ${d.cnh_category ? `<span class="badge">${esc(d.cnh_category)}</span>` : ''}</td>
                    <td>${d.cnh_expiry ? `${fmtDate(d.cnh_expiry)} ${statusPill(d.cnh_state?.state)}` : '<span class="badge warn">Pendente</span>'}</td>
                    <td class="small">${d.username ? `@${esc(d.username)}` : '<span class="muted xs">Sem login vinculado</span>'}</td>
                    <td><button class="btn sm" data-edit-drv="${esc(d.id)}">${icon('edit', 14)} Editar</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="muted small">Nenhum motorista cadastrado.</div>'}
      </section>

      <div class="section-title">
        <span>🔐 Permissões de Acesso ao Módulo de Frota por Usuário</span>
        <span class="muted xs">Defina quem é Motorista, Mecânico ou Gestor da Frota</span>
      </div>
      <section class="card">
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Usuário do Sistema</th>
                <th>Cargo Geral (OS)</th>
                <th>Permissão na Frota</th>
              </tr>
            </thead>
            <tbody>
              ${team.map((u) => `
                <tr>
                  <td>
                    <strong>${esc(u.name)}</strong>
                    <div class="muted xs">@${esc(u.username || '')}</div>
                  </td>
                  <td><span class="badge">${esc(u.role)}</span></td>
                  <td>
                    ${u.implicit ? `
                      <span class="badge ok">Gestor da Frota (Automático pelo cargo de Admin)</span>
                    ` : `
                      <select class="select" data-fleet-role-user="${esc(u.id)}" style="max-width:240px">
                        <option value="" ${!u.fleet_role ? 'selected' : ''}>Sem acesso à Frota</option>
                        <option value="motorista" ${u.fleet_role === 'motorista' ? 'selected' : ''}>Motorista (Viagens, Checklist, Abastecer)</option>
                        <option value="mecanico" ${u.fleet_role === 'mecanico' ? 'selected' : ''}>Mecânico da Frota (Manutenção, Pneus, Km)</option>
                        <option value="gestor" ${u.fleet_role === 'gestor' ? 'selected' : ''}>Gestor da Frota (Acesso Total à Frota)</option>
                      </select>
                    `}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </section>
    `;

    $$('[data-edit-drv]', body).forEach((b) => {
      b.onclick = () => {
        const drv = cache.drivers.find((x) => x.id === b.dataset.editDrv);
        if (drv) openDriverModal(drv, () => renderCurrentTab());
      };
    });

    $$('[data-fleet-role-user]', body).forEach((sel) => {
      sel.onchange = async () => {
        const userId = sel.dataset.fleetRoleUser;
        const fleet_role = sel.value || null;
        try {
          const r = await api(`/api/fleet/team/${userId}`, { method: 'PUT', body: { fleet_role } });
          toast(r.needs_cnh ? 'Permissão de Motorista ativada! Preencha os dados da CNH acima.' : 'Permissão da frota atualizada!');
          renderCurrentTab();
        } catch (e) {
          toast(e.message, 'err');
          renderCurrentTab();
        }
      };
    });
  }

  // ==========================================================================
  // MODAIS DE OPERAÇÃO DA FROTA
  // ==========================================================================
  function openVehicleModal(veh = null, onSaved) {
    const isEdit = !!veh;
    sheet(`
      <h2>${isEdit ? `Editar ${esc(veh.plate)}` : 'Novo Caminhão / Veículo'}</h2>
      <div class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:10px">
        <label class="field"><span>Placa *</span><input class="input" id="fv-plate" value="${esc(veh?.plate || '')}" placeholder="ABC1D23" style="text-transform:uppercase" /></label>
        <label class="field"><span>Apelido / Frota</span><input class="input" id="fv-nick" value="${esc(veh?.nickname || '')}" placeholder="Ex.: Caminhão 01" /></label>
        <label class="field"><span>Tipo *</span>
          <select class="select" id="fv-type">
            ${Object.entries(VEH_TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${(veh?.type || 'truck') === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Marca</span><input class="input" id="fv-brand" value="${esc(veh?.brand || '')}" placeholder="Mercedes, Volks, Volvo..." /></label>
        <label class="field"><span>Modelo</span><input class="input" id="fv-model" value="${esc(veh?.model || '')}" placeholder="Ex.: Atego 2426" /></label>
        <label class="field"><span>Ano Modelo</span><input class="input" type="number" id="fv-year" value="${esc(veh?.year_model || '')}" placeholder="2023" /></label>
        <label class="field"><span>Combustível</span>
          <select class="select" id="fv-fuel">
            ${Object.entries(FUEL_LABEL).map(([k, v]) => `<option value="${k}" ${(veh?.fuel_type || 'diesel_s10') === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Tanque (Litros)</span><input class="input" type="number" id="fv-tank" value="${esc(veh?.tank_capacity_l || '')}" placeholder="275" /></label>
        <label class="field"><span>Nº de Eixos</span><input class="input" type="number" id="fv-axles" value="${esc(veh?.axles || 3)}" min="2" max="9" /></label>
        ${!isEdit ? `<label class="field"><span>Hodômetro Atual (Km)</span><input class="input" type="number" id="fv-km" value="0" /></label>` : ''}
        <label class="field"><span>Renavam</span><input class="input" id="fv-renavam" value="${esc(veh?.renavam || '')}" /></label>
        <label class="field"><span>Chassi</span><input class="input" id="fv-chassis" value="${esc(veh?.chassis || '')}" /></label>
      </div>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="fv-save">${isEdit ? 'Salvar Alterações' : 'Cadastrar Caminhão'}</button>
      </div>
    `, {
      onMount(el, m) {
        $('#fv-save', el).onclick = async () => {
          const payload = {
            plate: $('#fv-plate', el).value.trim().toUpperCase(),
            nickname: $('#fv-nick', el).value.trim() || null,
            type: $('#fv-type', el).value,
            brand: $('#fv-brand', el).value.trim() || null,
            model: $('#fv-model', el).value.trim() || null,
            year_model: $('#fv-year', el).value ? Number($('#fv-year', el).value) : null,
            year_manufacture: $('#fv-year', el).value ? Number($('#fv-year', el).value) : null,
            fuel_type: $('#fv-fuel', el).value,
            tank_capacity_l: $('#fv-tank', el).value ? Number($('#fv-tank', el).value) : null,
            axles: Number($('#fv-axles', el).value) || 2,
            renavam: $('#fv-renavam', el).value.trim() || null,
            chassis: $('#fv-chassis', el).value.trim() || null,
          };
          if (!isEdit) payload.odometer_km = Number($('#fv-km', el).value) || 0;
          try {
            if (isEdit) await api(`/api/fleet/vehicles/${veh.id}`, { method: 'PUT', body: payload });
            else await api('/api/fleet/vehicles', { method: 'POST', body: payload });
            toast(isEdit ? 'Veículo atualizado' : 'Caminhão cadastrado e integrado às OS!');
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openOdometerModal(veh, onSaved) {
    sheet(`
      <h2>Atualizar Hodômetro — ${esc(veh.plate)}</h2>
      <p class="muted small">Hodômetro registrado atualmente: <strong>${numFmt(veh.odometer_km)} km</strong></p>
      <label class="field"><span>Nova Quilometragem (Km) *</span><input class="input" type="number" id="od-km" value="${Math.round(veh.odometer_km || 0)}" autofocus /></label>
      <label class="field"><span>Observação (opcional)</span><input class="input" id="od-note" placeholder="Conferência no pátio" /></label>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="od-save">Salvar Km</button>
      </div>
    `, {
      onMount(el, m) {
        $('#od-save', el).onclick = async () => {
          try {
            await api(`/api/fleet/vehicles/${veh.id}/odometer`, {
              method: 'POST',
              body: { km: Number($('#od-km', el).value), note: $('#od-note', el).value.trim() },
            });
            toast('Hodômetro atualizado!');
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function openVehicleDetailModal(vehId, onChanged) {
    try {
      const d = await api(`/api/fleet/vehicles/${vehId}`);
      const v = d.vehicle;
      sheet(`
        <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
          <div>
            ${plateBadge(v.plate, v.nickname)}
            <h2 style="margin:6px 0 2px">${esc([v.brand, v.model].filter(Boolean).join(' ') || VEH_TYPE_LABEL[v.type])}</h2>
            <div class="muted small">${numFmt(v.odometer_km)} km • ${esc(FUEL_LABEL[v.fuel_type] || v.fuel_type)} • ${v.axles || 2} eixos</div>
          </div>
          ${statusPill(v.status)}
        </div>

        <div class="row" style="gap:6px;flex-wrap:wrap;margin:12px 0">
          <button class="btn sm" id="vd-status-toggle">${v.status === 'manutencao' ? '✅ Liberar p/ Ativo' : '🔧 Colocar em Manutenção'}</button>
          ${v.machine_id ? `<a class="btn sm" href="#/nova?machine=${esc(v.machine_id)}" data-close>➕ Abrir OS p/ este Caminhão</a>` : ''}
        </div>

        ${d.stats?.total != null ? `
          <div class="kv" style="margin-bottom:12px">
            <div><span>Km rodados (90d)</span><strong>${numFmt(d.stats.km_driven)} km</strong></div>
            <div><span>Último consumo</span><strong>${d.stats.last_consumption ? `${numFmt(d.stats.last_consumption, 2)} km/L` : '—'}</strong></div>
            <div><span>Gasto total (90d)</span><strong>${brl(d.stats.total)}</strong></div>
            <div><span>Custo por Km (90d)</span><strong>${d.stats.cost_per_km != null ? `${brl(d.stats.cost_per_km)}/km` : '—'}</strong></div>
          </div>
        ` : ''}

        ${(d.open_orders || []).length ? `
          <div class="section-title"><span>Ordens de Serviço Abertas (${d.open_orders.length})</span></div>
          ${d.open_orders.map((o) => `
            <div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
              <span><strong>OS #${esc(o.number)}</strong> — ${esc(o.description)}</span>
              <a class="btn sm" href="#/os/${esc(o.id)}" data-close>Abrir</a>
            </div>
          `).join('')}
        ` : ''}

        <div class="sheet-actions" style="margin-top:16px">
          <button class="btn" data-close>Fechar</button>
        </div>
      `, {
        onMount(el, m) {
          $('#vd-status-toggle', el)?.addEventListener('click', async () => {
            const next = v.status === 'manutencao' ? 'ativo' : 'manutencao';
            try {
              await api(`/api/fleet/vehicles/${v.id}/status`, { method: 'POST', body: { status: next } });
              toast(`Status alterado para ${VEH_STATUS_LABEL[next]}`);
              m.close();
              onChanged?.();
            } catch (e) { toast(e.message, 'err'); }
          });
        },
      });
    } catch (e) { toast(e.message, 'err'); }
  }

  function openStartTripModal(onSaved) {
    const activeVehs = cache.vehicles.filter((v) => v.status === 'ativo');
    sheet(`
      <h2>🚚 Iniciar Nova Viagem</h2>
      <label class="field"><span>Caminhão / Veículo *</span>
        <select class="select" id="tr-veh">
          <option value="">Selecione...</option>
          ${activeVehs.map((v) => `<option value="${esc(v.id)}" data-km="${v.odometer_km || 0}">${esc(v.plate)} ${v.nickname ? `(${esc(v.nickname)})` : ''} — ${numFmt(v.odometer_km)} km</option>`).join('')}
        </select>
      </label>
      ${access !== 'motorista' ? `
        <label class="field"><span>Motorista *</span>
          <select class="select" id="tr-drv">
            <option value="">Selecione...</option>
            ${cache.drivers.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} ${d.cnh_expiry ? `(CNH ${fmtDate(d.cnh_expiry)})` : ''}</option>`).join('')}
          </select>
        </label>
      ` : ''}
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Origem *</span><input class="input" id="tr-orig" placeholder="Ex.: Fábrica Rufato" /></label>
        <label class="field"><span>Destino *</span><input class="input" id="tr-dest" placeholder="Ex.: São Paulo - SP" /></label>
      </div>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Km de Saída *</span><input class="input" type="number" id="tr-km" /></label>
        <label class="field"><span>Carga / Romaneio</span><input class="input" id="tr-cargo" placeholder="Ex.: Móveis / Carga #402" /></label>
      </div>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="tr-save">Confirmar Saída</button>
      </div>
    `, {
      onMount(el, m) {
        const vehSel = $('#tr-veh', el);
        const kmInp = $('#tr-km', el);
        vehSel.onchange = () => {
          const opt = vehSel.selectedOptions[0];
          if (opt?.dataset.km) kmInp.value = opt.dataset.km;
        };
        $('#tr-save', el).onclick = async () => {
          try {
            const payload = {
              vehicle_id: vehSel.value,
              origin: $('#tr-orig', el).value.trim(),
              destination: $('#tr-dest', el).value.trim(),
              start_km: Number(kmInp.value),
              cargo: $('#tr-cargo', el).value.trim() || null,
            };
            if (access !== 'motorista') payload.driver_id = $('#tr-drv', el).value;
            const r = await api('/api/fleet/trips/start', { method: 'POST', body: payload });
            toast('Viagem iniciada!');
            if (r.warnings?.length) toast(r.warnings[0], 'warn', 5000);
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openEndTripModal(trip, onSaved) {
    sheet(`
      <h2>🏁 Encerrar Viagem — ${esc(trip.plate)}</h2>
      <p class="muted small">${esc(trip.origin || '')} → <strong>${esc(trip.destination || '')}</strong> • Km de saída: <strong>${numFmt(trip.start_km)} km</strong></p>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Km Final de Chegada *</span><input class="input" type="number" id="et-km" value="${Math.round(trip.start_km || 0)}" autofocus /></label>
        <label class="field"><span>Pedágio / Despesa (R$)</span><input class="input" type="number" step="0.01" id="et-exp" placeholder="0,00" /></label>
      </div>
      <label class="field"><span>Observações da Viagem</span><input class="input" id="et-notes" placeholder="Ocorrências na rota, entregas realizadas..." /></label>
      <div class="sheet-actions">
        <button class="btn" data-close>Voltar</button>
        <button class="btn primary" id="et-save">Concluir Viagem</button>
      </div>
    `, {
      onMount(el, m) {
        $('#et-save', el).onclick = async () => {
          const expVal = Number($('#et-exp', el).value);
          const expenses = expVal > 0 ? [{ category: 'pedagio', amount: expVal, description: `Despesa de rota (${trip.origin || ''} → ${trip.destination || ''})` }] : [];
          try {
            await api(`/api/fleet/trips/${trip.id}/end`, {
              method: 'POST',
              body: {
                end_km: Number($('#et-km', el).value),
                notes: $('#et-notes', el).value.trim() || null,
                expenses,
              },
            });
            toast('Viagem encerrada e hodômetro atualizado!');
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openFuelModal(defaultVehId = null, onSaved) {
    sheet(`
      <h2>⛽ Registrar Abastecimento</h2>
      <label class="field"><span>Caminhão / Veículo *</span>
        <select class="select" id="fl-veh">
          <option value="">Selecione...</option>
          ${cache.vehicles.map((v) => `<option value="${esc(v.id)}" data-km="${v.odometer_km || 0}" data-fuel="${v.fuel_type || 'diesel_s10'}" ${v.id === defaultVehId ? 'selected' : ''}>${esc(v.plate)} ${v.nickname ? `(${esc(v.nickname)})` : ''} — ${numFmt(v.odometer_km)} km</option>`).join('')}
        </select>
      </label>
      ${access !== 'motorista' ? `
        <label class="field"><span>Motorista</span>
          <select class="select" id="fl-drv">
            <option value="">(Opcional)</option>
            ${cache.drivers.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
          </select>
        </label>
      ` : ''}
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Hodômetro no Posto (Km) *</span><input class="input" type="number" id="fl-km" /></label>
        <label class="field"><span>Combustível</span>
          <select class="select" id="fl-type">
            ${Object.entries(FUEL_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Litros Abastecidos *</span><input class="input" type="number" step="0.01" id="fl-liters" placeholder="Ex.: 180.5" /></label>
        <label class="field"><span>Preço por Litro (R$) *</span><input class="input" type="number" step="0.001" id="fl-price" placeholder="Ex.: 5.89" /></label>
      </div>
      <label class="field"><span>Posto / Cidade</span><input class="input" id="fl-station" placeholder="Ex.: Posto Graal Rodovia" /></label>
      <label class="row" style="gap:8px;align-items:center;margin:10px 0;cursor:pointer">
        <input type="checkbox" id="fl-full" checked />
        <span><strong>Tanque cheio</strong> (permite calcular a média km/L exata)</span>
      </label>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="fl-save">Salvar Abastecimento</button>
      </div>
    `, {
      onMount(el, m) {
        const vehSel = $('#fl-veh', el);
        vehSel.onchange = () => {
          const opt = vehSel.selectedOptions[0];
          if (opt?.dataset.km) $('#fl-km', el).value = opt.dataset.km;
          if (opt?.dataset.fuel) $('#fl-type', el).value = opt.dataset.fuel;
        };
        $('#fl-save', el).onclick = async () => {
          try {
            const payload = {
              vehicle_id: vehSel.value,
              km: Number($('#fl-km', el).value),
              fuel_type: $('#fl-type', el).value,
              liters: Number($('#fl-liters', el).value),
              price_per_l: Number($('#fl-price', el).value),
              station: $('#fl-station', el).value.trim() || null,
              full_tank: $('#fl-full', el).checked ? 1 : 0,
            };
            if (access !== 'motorista' && $('#fl-drv', el)?.value) payload.driver_id = $('#fl-drv', el).value;
            const r = await api('/api/fleet/fuel', { method: 'POST', body: payload });
            const cons = r.fuel?.consumption_km_l;
            toast(cons ? `Abastecimento salvo! Média: ${numFmt(cons, 2)} km/L` : 'Abastecimento registrado!');
            if (r.warnings?.length) toast(r.warnings[0], 'warn', 5000);
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function openNewChecklistModal(onSaved) {
    const itemsRes = await api('/api/fleet/checklist-items');
    const items = itemsRes.items || [];
    sheet(`
      <h2>✅ Checklist Diário do Caminhão</h2>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <label class="field"><span>Veículo *</span>
          <select class="select" id="ck-veh">
            <option value="">Selecione...</option>
            ${cache.vehicles.map((v) => `<option value="${esc(v.id)}" data-km="${v.odometer_km || 0}">${esc(v.plate)} ${v.nickname ? `(${esc(v.nickname)})` : ''}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Momento</span>
          <select class="select" id="ck-type">
            <option value="saida">Saída da Garagem</option>
            <option value="retorno">Retorno de Viagem</option>
          </select>
        </label>
        <label class="field"><span>Hodômetro (Km)</span><input class="input" type="number" id="ck-km" /></label>
      </div>

      <div style="max-height:52vh;overflow-y:auto;padding-right:4px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        ${items.map((it) => `
          <div class="ck-row" data-item-id="${esc(it.id)}" style="padding:8px 0;border-bottom:1px solid var(--border)">
            <div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
              <div>
                <strong>${esc(it.label)}</strong>
                ${it.critical ? '<span class="badge danger xs">Crítico</span>' : ''}
              </div>
              <div class="row" style="gap:4px">
                <button type="button" class="btn sm primary" data-ck-st="ok">OK</button>
                <button type="button" class="btn sm" data-ck-st="problema">Problema</button>
                <button type="button" class="btn sm" data-ck-st="na">N/A</button>
              </div>
            </div>
            <input class="input hidden" data-ck-note placeholder="Descreva o defeito encontrado (obrigatório)..." style="margin-top:6px" />
          </div>
        `).join('')}
      </div>

      <div class="sheet-actions" style="margin-top:12px">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="ck-submit">Enviar Checklist</button>
      </div>
    `, {
      onMount(el, m) {
        const vehSel = $('#ck-veh', el);
        vehSel.onchange = () => {
          const opt = vehSel.selectedOptions[0];
          if (opt?.dataset.km) $('#ck-km', el).value = opt.dataset.km;
        };
        const stateMap = new Map(items.map((it) => [it.id, 'ok']));
        $$('.ck-row', el).forEach((row) => {
          const id = row.dataset.itemId;
          const noteInp = $('[data-ck-note]', row);
          $$('[data-ck-st]', row).forEach((btn) => {
            btn.onclick = () => {
              const st = btn.dataset.ckSt;
              stateMap.set(id, st);
              $$('[data-ck-st]', row).forEach((b) => {
                b.className = 'btn sm' + (b === btn ? (st === 'problema' ? ' danger' : ' primary') : '');
              });
              noteInp.classList.toggle('hidden', st !== 'problema');
              if (st === 'problema') noteInp.focus();
            };
          });
        });

        $('#ck-submit', el).onclick = async () => {
          const answers = items.map((it) => {
            const row = $(`.ck-row[data-item-id="${it.id}"]`, el);
            return {
              item_id: it.id,
              status: stateMap.get(it.id) || 'ok',
              note: $('[data-ck-note]', row)?.value.trim() || null,
            };
          });
          try {
            const r = await api('/api/fleet/checklists', {
              method: 'POST',
              body: {
                vehicle_id: vehSel.value,
                type: $('#ck-type', el).value,
                km: $('#ck-km', el).value ? Number($('#ck-km', el).value) : null,
                answers,
                open_os: true,
              },
            });
            if (r.wo) {
              toast(`Checklist salvo! OS #${r.wo.number} aberta automaticamente.`, 'warn', 5000);
            } else {
              toast('Checklist diário registrado com sucesso!');
            }
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  async function openChecklistDetailModal(id) {
    try {
      const r = await api(`/api/fleet/checklists/${id}`);
      const c = r.checklist;
      sheet(`
        <h2>Checklist — ${esc(c.plate)} (${c.type === 'saida' ? 'Saída' : 'Retorno'})</h2>
        <p class="muted small">${fmtDateTime(c.created_at)} • Motorista: <strong>${esc(c.driver_name || '—')}</strong> ${c.km != null ? `• ${numFmt(c.km)} km` : ''}</p>
        <div style="max-height:55vh;overflow-y:auto;margin-top:10px">
          ${(c.answers || []).map((a) => `
            <div class="row" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)">
              <div>
                <strong>${esc(a.label)}</strong>
                ${a.note ? `<div class="small" style="color:var(--danger)">Obs.: ${esc(a.note)}</div>` : ''}
              </div>
              <span class="badge ${a.status === 'ok' ? 'ok' : a.status === 'problema' ? 'danger' : ''}">${esc(a.status.toUpperCase())}</span>
            </div>
          `).join('')}
        </div>
        <div class="sheet-actions"><button class="btn" data-close>Fechar</button></div>
      `);
    } catch (e) { toast(e.message, 'err'); }
  }

  function openPlanModal(plan = null, onSaved) {
    sheet(`
      <h2>Novo Plano Preventivo por Km / Dias</h2>
      <label class="field"><span>Caminhão / Veículo *</span>
        <select class="select" id="pl-veh">
          ${cache.vehicles.map((v) => `<option value="${esc(v.id)}" data-km="${v.odometer_km || 0}">${esc(v.plate)} ${v.nickname ? `(${esc(v.nickname)})` : ''} — ${numFmt(v.odometer_km)} km</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Serviço Preventivo *</span><input class="input" id="pl-title" placeholder="Ex.: Troca de óleo motor e filtros" /></label>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Repetir a cada (Km)</span><input class="input" type="number" id="pl-ekm" placeholder="Ex.: 20000" /></label>
        <label class="field"><span>Repetir a cada (Dias)</span><input class="input" type="number" id="pl-edays" placeholder="Ex.: 180" /></label>
        <label class="field"><span>Última execução (Km)</span><input class="input" type="number" id="pl-lkm" value="${cache.vehicles[0]?.odometer_km || 0}" /></label>
        <label class="field"><span>Última execução (Data)</span><input class="input" type="date" id="pl-ldate" value="${todayIso()}" /></label>
      </div>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="pl-save">Salvar Plano</button>
      </div>
    `, {
      onMount(el, m) {
        const vehSel = $('#pl-veh', el);
        vehSel.onchange = () => {
          const opt = vehSel.selectedOptions[0];
          if (opt?.dataset.km) $('#pl-lkm', el).value = opt.dataset.km;
        };
        $('#pl-save', el).onclick = async () => {
          try {
            await api('/api/fleet/plans', {
              method: 'POST',
              body: {
                vehicle_id: vehSel.value,
                title: $('#pl-title', el).value.trim(),
                every_km: $('#pl-ekm', el).value ? Number($('#pl-ekm', el).value) : null,
                every_days: $('#pl-edays', el).value ? Number($('#pl-edays', el).value) : null,
                last_km: $('#pl-lkm', el).value ? Number($('#pl-lkm', el).value) : 0,
                last_date: $('#pl-ldate', el).value || todayIso(),
              },
            });
            toast('Plano preventivo criado!');
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openPlanDoneModal(plan, onSaved) {
    const veh = cache.vehicles.find((v) => v.id === plan.vehicle_id);
    sheet(`
      <h2>Registrar Execução — ${esc(plan.title)}</h2>
      <p class="muted small">Veículo: <strong>${esc(plan.plate)}</strong></p>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Quilometragem na Execução *</span><input class="input" type="number" id="pd-km" value="${Math.round(veh?.odometer_km || plan.last_km || 0)}" /></label>
        <label class="field"><span>Data *</span><input class="input" type="date" id="pd-date" value="${todayIso()}" /></label>
      </div>
      <label class="field"><span>Custo Total de Peças/Mão de Obra (R$)</span><input class="input" type="number" step="0.01" id="pd-cost" placeholder="0,00" /></label>
      <label class="field"><span>Observações / Oficina / NF</span><input class="input" id="pd-notes" placeholder="Ex.: Óleo 15W40 + filtro separador" /></label>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="pd-save">Confirmar Execução</button>
      </div>
    `, {
      onMount(el, m) {
        $('#pd-save', el).onclick = async () => {
          try {
            await api(`/api/fleet/plans/${plan.id}/done`, {
              method: 'POST',
              body: {
                km: Number($('#pd-km', el).value),
                done_date: $('#pd-date', el).value,
                cost: $('#pd-cost', el).value ? Number($('#pd-cost', el).value) : null,
                notes: $('#pd-notes', el).value.trim() || null,
              },
            });
            toast('Preventiva registrada e próximo ciclo atualizado!');
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openTireModal(tire = null, onSaved) {
    sheet(`
      <h2>Cadastrar Pneu</h2>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Nº de Fogo / Série *</span><input class="input" id="ti-serial" placeholder="Ex.: FOGO-101" /></label>
        <label class="field"><span>Medida</span><input class="input" id="ti-size" value="275/80 R22.5" /></label>
        <label class="field"><span>Marca</span><input class="input" id="ti-brand" placeholder="Michelin, Pirelli, Bridgestone..." /></label>
        <label class="field"><span>Modelo / Banda</span><input class="input" id="ti-model" placeholder="X Multi Z" /></label>
        <label class="field"><span>Vida Útil Estimada (Km)</span><input class="input" type="number" id="ti-exp" value="120000" /></label>
        <label class="field"><span>Custo de Compra (R$)</span><input class="input" type="number" step="0.01" id="ti-cost" /></label>
        <label class="field"><span>Instalar no Veículo (opcional)</span>
          <select class="select" id="ti-veh">
            <option value="">Deixar no Estoque</option>
            ${cache.vehicles.map((v) => `<option value="${esc(v.id)}">${esc(v.plate)} ${v.nickname ? `(${esc(v.nickname)})` : ''}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Posição no Eixo</span><input class="input" id="ti-pos" placeholder="Ex.: 1E, 1D, 2EE, 2EI" /></label>
      </div>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="ti-save">Salvar Pneu</button>
      </div>
    `, {
      onMount(el, m) {
        $('#ti-save', el).onclick = async () => {
          try {
            await api('/api/fleet/tires', {
              method: 'POST',
              body: {
                serial: $('#ti-serial', el).value.trim(),
                size: $('#ti-size', el).value.trim() || null,
                brand: $('#ti-brand', el).value.trim() || null,
                model: $('#ti-model', el).value.trim() || null,
                expected_km: $('#ti-exp', el).value ? Number($('#ti-exp', el).value) : null,
                cost: $('#ti-cost', el).value ? Number($('#ti-cost', el).value) : null,
                vehicle_id: $('#ti-veh', el).value || null,
                position: $('#ti-pos', el).value.trim().toUpperCase() || null,
              },
            });
            toast('Pneu cadastrado!');
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openTireEventModal(tire, onSaved) {
    sheet(`
      <h2>Movimentar Pneu 🔥 ${esc(tire.serial || '')}</h2>
      <p class="muted small">Situação atual: <strong>${esc(tire.status)}</strong> ${tire.plate ? `em ${esc(tire.plate)} (${esc(tire.position)})` : ''}</p>
      <label class="field"><span>Operação *</span>
        <select class="select" id="te-type">
          ${Object.entries(TIRE_EVENT_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
        </select>
      </label>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Veículo (p/ Instalação)</span>
          <select class="select" id="te-veh">
            <option value="">Selecione...</option>
            ${cache.vehicles.map((v) => `<option value="${esc(v.id)}" ${v.id === tire.vehicle_id ? 'selected' : ''}>${esc(v.plate)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Posição (Ex.: 1E, 1D, 2EE)</span><input class="input" id="te-pos" value="${esc(tire.position || '')}" /></label>
        <label class="field"><span>Hodômetro (Km)</span><input class="input" type="number" id="te-km" /></label>
        <label class="field"><span>Custo do Serviço (R$)</span><input class="input" type="number" step="0.01" id="te-cost" /></label>
      </div>
      <label class="field"><span>Observações</span><input class="input" id="te-notes" placeholder="Ex.: Sulco 6mm, recapagem Vipal..." /></label>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="te-save">Confirmar</button>
      </div>
    `, {
      onMount(el, m) {
        $('#te-save', el).onclick = async () => {
          try {
            await api(`/api/fleet/tires/${tire.id}/event`, {
              method: 'POST',
              body: {
                type: $('#te-type', el).value,
                vehicle_id: $('#te-veh', el).value || null,
                position: $('#te-pos', el).value.trim().toUpperCase() || null,
                km: $('#te-km', el).value ? Number($('#te-km', el).value) : null,
                cost: $('#te-cost', el).value ? Number($('#te-cost', el).value) : null,
                notes: $('#te-notes', el).value.trim() || null,
              },
            });
            toast('Movimentação de pneu registrada!');
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openDocModal(onSaved) {
    sheet(`
      <h2>📄 Cadastrar Documento / Licença</h2>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Vincular a *</span>
          <select class="select" id="dc-etype">
            <option value="vehicle">Caminhão / Veículo</option>
            <option value="driver">Motorista</option>
          </select>
        </label>
        <label class="field"><span>Selecione *</span>
          <select class="select" id="dc-eid"></select>
        </label>
        <label class="field"><span>Tipo de Documento *</span>
          <input class="input" id="dc-type" placeholder="CRLV, ANTT, Tacógrafo, Seguro, Toxicológico..." />
        </label>
        <label class="field"><span>Número / Apólice</span><input class="input" id="dc-num" /></label>
        <label class="field"><span>Data de Vencimento *</span><input class="input" type="date" id="dc-exp" /></label>
        <label class="field"><span>Valor Pago (R$)</span><input class="input" type="number" step="0.01" id="dc-cost" /></label>
      </div>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="dc-save">Salvar Documento</button>
      </div>
    `, {
      onMount(el, m) {
        const etSel = $('#dc-etype', el);
        const eidSel = $('#dc-eid', el);
        const fillEntities = () => {
          if (etSel.value === 'vehicle') {
            eidSel.innerHTML = cache.vehicles.map((v) => `<option value="${esc(v.id)}">${esc(v.plate)} ${v.nickname ? `(${esc(v.nickname)})` : ''}</option>`).join('');
          } else {
            eidSel.innerHTML = cache.drivers.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
          }
        };
        etSel.onchange = fillEntities;
        fillEntities();

        $('#dc-save', el).onclick = async () => {
          try {
            await api('/api/fleet/documents', {
              method: 'POST',
              body: {
                entity_type: etSel.value,
                entity_id: eidSel.value,
                doc_type: $('#dc-type', el).value.trim(),
                number: $('#dc-num', el).value.trim() || null,
                expiry_date: $('#dc-exp', el).value || null,
                cost: $('#dc-cost', el).value ? Number($('#dc-cost', el).value) : null,
              },
            });
            toast('Documento cadastrado!');
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openFineModal(fine = null, onSaved) {
    sheet(`
      <h2>🚨 Registrar Multa de Trânsito</h2>
      <p class="muted xs">Se você deixar o motorista em branco, o sistema identifica automaticamente quem estava em viagem no caminhão na data/hora da infração.</p>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <label class="field"><span>Veículo *</span>
          <select class="select" id="fn-veh">
            ${cache.vehicles.map((v) => `<option value="${esc(v.id)}">${esc(v.plate)} ${v.nickname ? `(${esc(v.nickname)})` : ''}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Motorista (opcional)</span>
          <select class="select" id="fn-drv">
            <option value="">🔍 Identificar pela viagem no horário</option>
            ${cache.drivers.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Data/Hora da Infração *</span><input class="input" type="datetime-local" id="fn-date" value="${localInputValue()}" /></label>
        <label class="field"><span>Vencimento do Boleto</span><input class="input" type="date" id="fn-due" /></label>
        <label class="field"><span>Valor (R$) *</span><input class="input" type="number" step="0.01" id="fn-amount" placeholder="195.23" /></label>
        <label class="field"><span>Pontos na CNH</span><input class="input" type="number" id="fn-pts" value="5" /></label>
      </div>
      <label class="field"><span>Descrição da Infração *</span><input class="input" id="fn-inf" placeholder="Ex.: Excesso de velocidade até 20%" /></label>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Nº Auto de Infração (AIT)</span><input class="input" id="fn-ait" /></label>
        <label class="field"><span>Local / Rodovia</span><input class="input" id="fn-loc" /></label>
      </div>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="fn-save">Registrar Multa</button>
      </div>
    `, {
      onMount(el, m) {
        $('#fn-save', el).onclick = async () => {
          try {
            const r = await api('/api/fleet/fines', {
              method: 'POST',
              body: {
                vehicle_id: $('#fn-veh', el).value,
                driver_id: $('#fn-drv', el).value || null,
                fine_date: new Date($('#fn-date', el).value).toISOString(),
                due_date: $('#fn-due', el).value || null,
                amount: Number($('#fn-amount', el).value),
                points: Number($('#fn-pts', el).value) || 0,
                infraction: $('#fn-inf', el).value.trim(),
                ait_number: $('#fn-ait', el).value.trim() || null,
                location: $('#fn-loc', el).value.trim() || null,
              },
            });
            toast(r.driver_detected ? `Multa salva! Motorista identificado automaticamente: ${r.fine.driver_name}` : 'Multa registrada!');
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openDriverModal(drv = null, onSaved) {
    const isEdit = !!drv;
    const users = state.boot?.users || [];
    sheet(`
      <h2>${isEdit ? `Editar Motorista — ${esc(drv.name)}` : 'Cadastrar Motorista'}</h2>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Nome Completo *</span><input class="input" id="dr-name" value="${esc(drv?.name || '')}" /></label>
        <label class="field"><span>CPF</span><input class="input" id="dr-cpf" value="${esc(drv?.cpf || '')}" placeholder="000.000.000-00" /></label>
        <label class="field"><span>Telefone / WhatsApp</span><input class="input" id="dr-phone" value="${esc(drv?.phone || '')}" /></label>
        <label class="field"><span>Nº da CNH</span><input class="input" id="dr-cnh" value="${esc(drv?.cnh_number || '')}" /></label>
        <label class="field"><span>Categoria CNH</span>
          <select class="select" id="dr-cat">
            ${['C', 'D', 'E', 'B', 'AC', 'AD', 'AE'].map((c) => `<option value="${c}" ${(drv?.cnh_category || 'E') === c ? 'selected' : ''}>Categoria ${c}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Validade da CNH</span><input class="input" type="date" id="dr-exp" value="${esc(drv?.cnh_expiry || '')}" /></label>
      </div>
      <label class="field"><span>Vincular ao Usuário do Aplicativo (opcional)</span>
        <select class="select" id="dr-user">
          <option value="">Sem vínculo de login</option>
          ${users.map((u) => `<option value="${esc(u.id)}" ${drv?.user_id === u.id ? 'selected' : ''}>${esc(u.name)} (@${esc(u.username || '')})</option>`).join('')}
        </select>
      </label>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="dr-save">${isEdit ? 'Salvar' : 'Cadastrar'}</button>
      </div>
    `, {
      onMount(el, m) {
        $('#dr-save', el).onclick = async () => {
          try {
            const payload = {
              name: $('#dr-name', el).value.trim(),
              cpf: $('#dr-cpf', el).value.trim() || null,
              phone: $('#dr-phone', el).value.trim() || null,
              cnh_number: $('#dr-cnh', el).value.trim() || null,
              cnh_category: $('#dr-cat', el).value,
              cnh_expiry: $('#dr-exp', el).value || null,
              user_id: $('#dr-user', el).value || null,
            };
            if (isEdit) await api(`/api/fleet/drivers/${drv.id}`, { method: 'PUT', body: payload });
            else await api('/api/fleet/drivers', { method: 'POST', body: payload });
            toast('Dados do motorista salvos!');
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  function openCostModal(onSaved) {
    sheet(`
      <h2>💰 Lançar Despesa / Custo da Frota</h2>
      <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Caminhão *</span>
          <select class="select" id="cs-veh">
            ${cache.vehicles.map((v) => `<option value="${esc(v.id)}">${esc(v.plate)} ${v.nickname ? `(${esc(v.nickname)})` : ''}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Categoria *</span>
          <select class="select" id="cs-cat">
            ${Object.entries(COST_CAT_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Valor (R$) *</span><input class="input" type="number" step="0.01" id="cs-val" /></label>
        <label class="field"><span>Data *</span><input class="input" type="date" id="cs-date" value="${todayIso()}" /></label>
      </div>
      <label class="field"><span>Descrição / Fornecedor / NF</span><input class="input" id="cs-desc" placeholder="Ex.: Alinhamento e balanceamento" /></label>
      <div class="sheet-actions">
        <button class="btn" data-close>Cancelar</button>
        <button class="btn primary" id="cs-save">Salvar Custo</button>
      </div>
    `, {
      onMount(el, m) {
        $('#cs-save', el).onclick = async () => {
          try {
            await api('/api/fleet/costs', {
              method: 'POST',
              body: {
                vehicle_id: $('#cs-veh', el).value,
                category: $('#cs-cat', el).value,
                amount: Number($('#cs-val', el).value),
                cost_date: $('#cs-date', el).value,
                description: $('#cs-desc', el).value.trim() || null,
              },
            });
            toast('Custo registrado!');
            m.close();
            onSaved?.();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  renderCurrentTab();
  return () => { alive = false; };
}

