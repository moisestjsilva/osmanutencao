// Telas do app. Cada tela recebe o elemento raiz e devolve uma função de limpeza opcional.
import {
  state, on, api, enqueue, sync, workOrders, fetchDetail, pendingOps, failedOps, retryOp, discardOp, markRead, loadBoot, kv, uuid, NetError, userName,
  login, logout, changePassword, fetchUsers, createUser, updateUser, deleteUser,
  uploadImage, fetchSectors, createSector, updateSector, deleteSector,
  fetchMachines, createMachine, updateMachine, deleteMachine
} from './store.js';
import {
  esc, $, $$, icon, avatar, machineBadge, toast, sheet, askReason, confirmDialog, fmtDateTime, fmtDate, fmtMin, fmtTime, timeAgo, clock, statusBadge, prioBadge, roleBadge,
  PRIORITY, PRIO_COLOR, ROLE, compressImage, localInputValue,
} from './ui.js';
import { scanQR, extractCode, cameraSupported } from './scanner.js';

const CLOSED = ['Concluída', 'Cancelada'];
const isClosed = (w) => CLOSED.includes(w.status);
const me = () => state.user;
const isTech = () => ['manutentor', 'gerente', 'admin', 'superadmin'].includes(me()?.role);
const isAdmin = () => ['admin', 'superadmin', 'gerente'].includes(me()?.role);
const isSuperAdmin = () => me()?.role === 'superadmin';
const isOnlyTech = () => me()?.role === 'manutentor';
const isManager = () => isAdmin();
const PRANK = { urgente: 0, alta: 1, media: 2, baixa: 3 };
const isStoppedNow = (w) => w.machineStopped && !isClosed(w) && w.machineRecovered !== true;
const go = (h) => (location.hash = h);
const savedMsg = () => (state.online ? 'Registrado' : 'Salvo no aparelho — será enviado ao reconectar');

// ======================================================================
// LISTA DE OS
// ======================================================================
export function listView(root) {
  const isSol = me()?.role === 'solicitante';
  const onlyTech = isOnlyTech();

  let defaultFilter = 'abertas';
  if (onlyTech) defaultFilter = 'minhas';
  if (isSol) defaultFilter = 'abertas';

  let filter = sessionStorage.getItem('nova-os:filter') || defaultFilter;
  let q = '';

  let FILTERS = [];
  if (onlyTech) {
    FILTERS = [
      ['minhas', 'Minhas Atribuídas', (w) => !isClosed(w) && (w.responsible?.id === me()?.id || w.participants?.some((p) => p.userId === me()?.id))],
      ['disponiveis', 'Disponíveis na Fábrica', (w) => !isClosed(w) && !w.responsible?.id],
      ['concluidas', 'Concluídas por Mim', (w) => isClosed(w) && (w.responsible?.id === me()?.id || w.participants?.some((p) => p.userId === me()?.id))],
      ['paradas', 'Máquinas Paradas', isStoppedNow],
    ];
  } else if (isSol) {
    FILTERS = [
      ['abertas', 'Em Andamento', (w) => !isClosed(w)],
      ['concluidas', 'Concluídos', isClosed],
      ['todas', 'Todos os Chamados', () => true],
    ];
  } else {
    FILTERS = [
      ['abertas', 'Abertas', (w) => !isClosed(w)],
      ['minhas', 'Minhas', (w) => !isClosed(w) && (w.responsible?.id === me()?.id || w.participants?.some((p) => p.userId === me()?.id) || w.requester?.id === me()?.id)],
      ['paradas', 'Paradas', isStoppedNow],
      ['preventivas', 'Preventivas', (w) => w.type === 'preventiva' && !isClosed(w)],
      ['concluidas', 'Encerradas', isClosed],
    ];
  }

  const pageTitle = onlyTech ? 'Minhas Ordens de Serviço' : (isSol ? 'Meus Chamados de Manutenção' : 'Ordens de Serviço');

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${pageTitle}</h1>
        <p id="list-sub"></p>
      </div>
      <button class="icon-btn" id="btn-refresh" aria-label="Atualizar">${icon('refresh', 18)}</button>
    </div>
    <div id="stopped-wrap"></div>
    <div class="input-group" style="margin-bottom:10px">
      <input class="input" id="search" type="search" placeholder="Buscar por nº, máquina ou descrição" aria-label="Buscar OS" />
    </div>
    <div class="chips" id="filters" role="tablist"></div>
    <div id="list" style="margin-top:8px"></div>`;

  function render() {
    const wos = workOrders();
    const stopped = wos.filter(isStoppedNow).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    $('#list-sub', root).textContent = `${wos.filter((w) => !isClosed(w)).length} abertas • ${stopped.length} máquina(s) parada(s)`;
    $('#stopped-wrap', root).innerHTML = stopped.length ? `
      <div class="section-title"><span>Máquinas paradas</span><span class="badge stopped">${stopped.length}</span></div>
      <div class="stopped-strip">${stopped.map((w) => `
        <article class="stopped-card" data-open="${w.id}" id="stopped-${w.id}">
          <div class="label-top"><span class="dot"></span>PARADA • OS ${w.number ?? '(pendente)'}</div>
          <h3>${esc(w.machine?.name)}</h3>
          <div class="small" style="opacity:.8">${esc(w.machine?.sector || '')} • ${esc(w.status)}</div>
          <div class="timer mono" data-clock="${w.createdAt}">${clock(w.createdAt)}</div>
        </article>`).join('')}</div>` : '';

    $('#filters', root).innerHTML = FILTERS.map(([k, label, fn]) =>
      `<button class="chip ${filter === k ? 'active' : ''}" data-filter="${k}" id="filter-${k}">${label}<span class="count">${wos.filter(fn).length}</span></button>`).join('');

    const fn = FILTERS.find((f) => f[0] === filter)[2];
    const ql = q.toLowerCase();
    const items = wos.filter(fn).filter((w) => !ql || `${w.number} ${w.machine?.name} ${w.machine?.code} ${w.description} ${w.machine?.sector}`.toLowerCase().includes(ql))
      .sort((a, b) => filter === 'concluidas'
        ? (b.closedAt || '').localeCompare(a.closedAt || '')
        : (isStoppedNow(b) - isStoppedNow(a)) || (PRANK[a.priority] - PRANK[b.priority]) || (b.overdue - a.overdue) || b.createdAt.localeCompare(a.createdAt));

    $('#list', root).innerHTML = items.length ? items.map((w, i) => woCard(w, i)).join('') : `
      <div class="empty"><div class="ico">${icon('check', 28)}</div><strong>Nenhuma OS aqui</strong><p class="small">Toque em + para abrir um chamado.</p></div>`;
  }

  root.addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) { filter = f.dataset.filter; sessionStorage.setItem('nova-os:filter', filter); render(); return; }
    const o = e.target.closest('[data-open]');
    if (o) go(`#/os/${o.dataset.open}`);
    if (e.target.closest('#btn-refresh')) sync().then(() => toast('Atualizado'));
  });
  $('#search', root).addEventListener('input', (e) => { q = e.target.value; render(); });
  render();
  return on((w) => ['wos', 'queue', 'sync', 'change'].includes(w) && render());
}

function woCard(w, i = 0) {
  const parts = w.participants || [];
  const working = parts.filter((p) => p.state === 'trabalhando');
  const stopped = isStoppedNow(w);
  const m = w.machine;
  let costBadge = '';
  if (stopped && m?.hourly_cost > 0) {
    const elapsedHours = (Date.now() - new Date(w.createdAt).getTime()) / 3600000;
    const estimatedCost = Math.round(elapsedHours * m.hourly_cost);
    costBadge = `<span class="cost-chip" title="Custo de parada: R$ ${m.hourly_cost}/hora">${icon('alert', 12)} R$ ${estimatedCost.toLocaleString('pt-BR')}</span>`;
  }
  return `
  <article class="wo-card ${stopped ? 'is-stopped' : ''}" data-open="${w.id}" id="wo-${w.id}" style="--prio:${PRIO_COLOR[w.priority]};animation-delay:${Math.min(i, 10) * 30}ms">
    <div>
      <div class="top">
        <span class="num">${w.number ? `OS ${w.number}` : 'OS nova'}</span>
        ${statusBadge(w.status)}
        ${stopped ? '<span class="badge stopped">PARADA</span>' : ''}
        ${costBadge}
        ${w.type === 'preventiva' ? '<span class="badge prev">Preventiva</span>' : ''}
        ${w.overdue ? '<span class="badge late">Atrasada</span>' : ''}
        ${w._pending ? `<span class="badge pending">${icon('cloud', 12)} pendente</span>` : ''}
        <span style="margin-left:auto">${prioBadge(w.priority)}</span>
      </div>
      <div class="card-main">
        ${machineBadge(m, 'sm')}
        <div class="card-content">
          <h3>${esc(m?.name || 'Equipamento')} <span class="muted small" style="font-weight:500">${m?.code ? `• TAG ${esc(m.code)} ` : ''}• ${esc(m?.sector || '')}</span></h3>
          <div class="desc">${esc(w.description)}</div>
        </div>
      </div>
    </div>
    <div class="meta">
      ${parts.length ? `<span class="avatar-stack">${parts.slice(0, 4).map((p) => avatar(p.name, 'sm', p.avatar_url)).join('')}</span>` : `<span>${icon('user', 14)} sem responsável</span>`}
      ${working.length ? `<span style="color:var(--accent)">● ${working.length} em atendimento</span>` : ''}
      <span style="margin-left:auto">${w.dueDate && !isClosed(w) ? `vence ${fmtDate(w.dueDate)}` : timeAgo(w.createdAt)}</span>
    </div>
  </article>`;
}

// ======================================================================
// DETALHE DA OS
// ======================================================================
export function detailView(root, { id }) {
  let wo = null;
  let alive = true;
  root.innerHTML = '<div class="skeleton" style="height:180px"></div><div class="skeleton"></div><div class="skeleton"></div>';

  async function load() {
    try {
      wo = await fetchDetail(id);
      if (alive) render();
    } catch (e) {
      if (alive) root.innerHTML = `<div class="empty"><div class="ico">${icon('alert', 28)}</div><strong>${esc(e.message)}</strong><p><a href="#/">Voltar à lista</a></p></div>`;
    }
  }

  function render() {
    const u = me();
    const myPart = wo.participants?.find((p) => p.userId === u?.id);
    const stoppedNow = isStoppedNow(wo);
    const evs = (wo.events || []);
    root.innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <button class="btn ghost sm" id="btn-back">${icon('back', 18)} Ordens</button>
        <span class="grow"></span>
        ${wo._pending ? `<span class="badge pending">${icon('cloud', 12)} ${wo._pending} pendente(s)</span>` : ''}
      </div>

      <section class="card detail-hero ${wo.machineStopped ? 'is-stopped' : ''}">
        ${wo.machineStopped ? (stoppedNow
          ? `<div class="stop-banner">${icon('alert', 20)} MÁQUINA PARADA <span class="timer mono" data-clock="${wo.createdAt}">${clock(wo.createdAt)}</span></div>`
          : `<div class="stop-banner recovered">${icon('check', 20)} Máquina retornou à operação ${wo.returnedAt ? `• ${fmtDateTime(wo.returnedAt)}` : ''}</div>`) : ''}
        <div class="row wrap">
          <h1 style="font-size:24px">${wo.number ? `OS ${wo.number}` : 'OS (aguardando nº)'}</h1>
          ${statusBadge(wo.status)} ${prioBadge(wo.priority)}
          ${wo.type === 'preventiva' ? '<span class="badge prev">Preventiva</span>' : '<span class="badge">Corretiva</span>'}
          ${wo.specialty ? `<span class="badge" style="background:var(--accent-glow);color:var(--accent);font-weight:600">${esc(wo.specialty)}</span>` : ''}
          ${wo.overdue ? '<span class="badge late">Atrasada</span>' : ''}
        </div>
        <h2 style="font-size:18px;margin-top:10px">${esc(wo.machine?.name)}</h2>
        <div class="muted small">${wo.machine?.code ? `TAG: <strong>${esc(wo.machine.code)}</strong> • ` : ''}${esc(wo.machine?.sector || '')}</div>
        <p style="margin:12px 0 0;white-space:pre-wrap">${esc(wo.description)}</p>
        <div class="kv">
          <div><span>Solicitante</span><strong>${esc(wo.requester?.name || '—')}</strong></div>
          <div><span>Aberta em</span><strong>${fmtDateTime(wo.createdAt)}</strong></div>
          <div><span>Responsável</span><strong>${esc(wo.responsible?.name || 'Ninguém assumiu')}</strong></div>
          <div><span>${wo.dueDate ? 'Vencimento' : 'Avisados'}</span><strong>${wo.dueDate ? fmtDate(wo.dueDate) : recipientsLabel(wo)}</strong></div>
          ${wo.closedAt ? `<div><span>${wo.status === 'Cancelada' ? 'Cancelada em' : 'Concluída em'}</span><strong>${fmtDateTime(wo.closedAt)}</strong></div>` : ''}
          ${wo.reopenedCount ? `<div><span>Reaberturas</span><strong>${wo.reopenedCount}</strong></div>` : ''}
        </div>
      </section>

      ${(wo.status === 'Concluída' && wo.serviceDone) || wo.materialsUsed || wo.toolsUsed || wo.notes ? `
      <section class="card">
        <div class="section-title" style="margin-top:0">Conclusão e Detalhes da Execução</div>
        <div class="stack small">
          ${wo.serviceDone ? `<div><div class="label">Serviço realizado</div>${esc(wo.serviceDone)}</div>` : ''}
          ${wo.cause ? `<div><div class="label">Possível Causa</div>${esc(wo.cause)}</div>` : ''}
          ${wo.solution && wo.solution !== wo.serviceDone ? `<div><div class="label">Solução</div>${esc(wo.solution)}</div>` : ''}
          ${wo.materialsUsed ? `<div><div class="label">Peças / Materiais Utilizados</div>${esc(wo.materialsUsed)}</div>` : ''}
          ${wo.toolsUsed ? `<div><div class="label">Ferramentas Utilizadas</div>${esc(wo.toolsUsed)}</div>` : ''}
          ${wo.notes ? `<div><div class="label">Observações Gerais</div>${esc(wo.notes)}</div>` : ''}
        </div>
      </section>` : ''}
      ${wo.status === 'Cancelada' ? `<div class="warn-box" style="margin-top:12px">Cancelada: ${esc(wo.cancelledReason || '')}</div>` : ''}

      <div class="section-title"><span>Participantes</span><span class="muted xs">Tempo individual (exclui pausas)</span></div>
      <section class="card tight">
        ${wo.participants?.length ? wo.participants.map((p) => `
          <div class="part-row">
            ${avatar(p.name)}
            <div class="grow">
              <div style="font-weight:600">${esc(p.name)} ${p.role === 'responsavel' ? '<span class="badge" style="height:20px">Responsável</span>' : ''}</div>
              <div class="small muted"><span class="state-dot state-${p.state}"></span>${{ trabalhando: 'Trabalhando', pausado: 'Pausado', concluido: 'Parte encerrada', aguardando: 'Aguardando início' }[p.state] || p.state}</div>
            </div>
            <div class="timer mono" ${p.activeSince ? `data-clock="${p.activeSince}" data-base="${p.minutes - (Date.now() - new Date(p.activeSince)) / 60000}"` : ''}>${p.activeSince ? clock(p.activeSince, p.minutes - (Date.now() - new Date(p.activeSince)) / 60000) : fmtMin(p.minutes)}</div>
          </div>`).join('') : '<p class="muted small" style="margin:6px 0">Nenhum manutentor ainda.</p>'}
      </section>

      ${wo.checklist?.length ? `
      <div class="section-title"><span>Checklist</span><span class="muted xs">${wo.checklist.filter((c) => c.done).length}/${wo.checklist.length}</span></div>
      <section class="card tight" id="checklist">
        ${wo.checklist.map((c, i) => `
          <label class="check-row ${c.done ? 'checked' : ''}" data-check="${i}">
            <input type="checkbox" ${c.done ? 'checked' : ''} ${isTech() && !isClosed(wo) ? '' : 'disabled'} />
            <span class="box">${icon('check', 16, 3)}</span><span class="text">${esc(c.text)}</span>
          </label>`).join('')}
      </section>` : ''}

      <div class="section-title"><span>Fotos</span><span class="muted xs">${(wo.attachments?.length || 0) + (wo._localPhotos?.length || 0)}</span></div>
      <section class="photos">
        ${(wo.attachments || []).map((a) => `<a href="${a.url}" target="_blank" rel="noopener"><img src="${a.url}" alt="Foto da OS" loading="lazy" /></a>`).join('')}
        ${(wo._localPhotos || []).map((d) => `<div class="ph"><img src="${d}" alt="Foto pendente" /><span class="tag">pendente</span></div>`).join('')}
        ${!isClosed(wo) ? `<label class="add-photo" id="add-photo" aria-label="Adicionar foto">${icon('camera', 24)}<input type="file" accept="image/*" capture="environment" hidden id="photo-input" /></label>` : ''}
      </section>

      ${wo.intervals?.length ? `
      <div class="section-title"><span>Intervalos de trabalho</span></div>
      <section class="card tight">
        ${wo.intervals.map((iv) => `
          <div class="part-row small">
            <div class="grow"><strong>${esc(iv.userName)}</strong><div class="muted xs">${fmtDateTime(iv.started_at)} → ${iv.ended_at ? fmtTime(iv.ended_at) : 'em andamento'} ${iv.end_reason ? `• ${esc(iv.end_reason.replace('_', ' '))}` : ''}</div></div>
            <span class="mono">${fmtMin(((iv.ended_at ? new Date(iv.ended_at) : Date.now()) - new Date(iv.started_at)) / 60000)}</span>
            ${isManager() ? `<button class="icon-btn" data-correct="${iv.id}" aria-label="Corrigir intervalo">${icon('edit', 16)}</button>` : ''}
          </div>`).join('')}
        ${wo.audit?.length ? `<div class="info-box xs" style="margin-top:8px">${wo.audit.length} correção(ões) auditada(s): ${wo.audit.map((a) => `${esc(a.user_name)} alterou ${a.field === 'started_at' ? 'início' : 'fim'} de ${fmtDateTime(a.old_value)} para ${fmtDateTime(a.new_value)} — “${esc(a.reason)}”`).join('; ')}</div>` : ''}
      </section>` : ''}

      ${wo.conflicts?.length && isManager() ? `
      <div class="section-title"><span>Conflitos de sincronização</span></div>
      ${wo.conflicts.map((c) => `<div class="${c.resolved_at ? 'info-box' : 'error-box'} small" style="margin-bottom:8px"><strong>${esc(c.type)}</strong> de ${esc(userName(c.user_id))}: ${esc(c.reason)} ${c.resolved_at ? `<br>Resolvido: ${esc(c.resolution)}` : `<br><a href="#/sync">Revisar</a>`}</div>`).join('')}` : ''}

      <div class="section-title"><span>Histórico</span><span class="muted xs">horário do evento</span></div>
      <section class="card">
        ${evs.length ? `<div class="timeline">${evs.map(eventItem).join('')}</div>` : '<p class="muted small">Histórico disponível ao sincronizar.</p>'}
      </section>
    `;
    renderActions(myPart);
    bind();
  }

  function renderActions(myPart) {
    const bar = document.createElement('div');
    bar.className = 'action-bar';
    bar.id = 'action-bar';
    const btns = [];
    const u = me();
    if (!isClosed(wo) && isTech()) {
      if (myPart?.state === 'trabalhando') {
        btns.push(`<button class="btn lg" data-act="pause" id="act-pause">${icon('pause', 18)} Pausar</button>`);
        btns.push(`<button class="btn lg success" data-act="complete" id="act-complete">${icon('check', 18)} Concluir</button>`);
      } else if (!wo.responsible) {
        btns.push(`<button class="btn lg" data-act="start" id="act-start">${icon('play', 18)} Iniciar</button>`);
        btns.push(`<button class="btn lg primary" data-act="assume" id="act-assume">${icon('hand', 18)} Assumir</button>`);
      } else if (myPart) {
        btns.push(`<button class="btn lg primary" data-act="start" id="act-start">${icon('play', 18)} ${myPart.state === 'aguardando' ? 'Iniciar' : 'Retomar'}</button>`);
        if (wo.responsible?.id === u.id || isManager()) btns.push(`<button class="btn lg success" data-act="complete" id="act-complete">${icon('check', 18)} Concluir</button>`);
      } else {
        btns.push(`<button class="btn lg" data-act="join" id="act-join">${icon('users', 18)} Participar</button>`);
        btns.push(`<button class="btn lg primary" data-act="start" id="act-start">${icon('play', 18)} Iniciar junto</button>`);
      }
      btns.push(`<button class="btn lg" data-act="more" id="act-more" style="flex:0 0 56px" aria-label="Mais ações">⋯</button>`);
    } else if (!isClosed(wo) && isManager()) {
      btns.push(`<button class="btn lg" data-act="more" id="act-more">Mais ações</button>`);
    } else if (wo.status === 'Concluída' && (isManager() || wo.requester?.id === u?.id)) {
      btns.push(`<button class="btn lg" data-act="reopen" id="act-reopen">${icon('undo', 18)} Reabrir OS</button>`);
    }
    $('#action-bar')?.remove();
    document.body.classList.toggle('has-action-bar', btns.length > 0);
    if (btns.length) {
      bar.innerHTML = btns.join('');
      document.body.appendChild(bar);
      bar.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) act(b.dataset.act); });
    }
  }

  async function doOp(type, payload = {}, msg) {
    try {
      await enqueue(type, wo.id, payload);
      toast(msg || savedMsg(), state.online ? 'ok' : 'warn');
      wo = await fetchDetail(id).catch(() => wo);
      render();
    } catch (e) {
      toast(esc(e.message), 'err');
    }
  }

  async function act(a) {
    const u = me();
    if (a === 'assume') return doOp('assume', {}, 'OS assumida');
    if (a === 'join') return doOp('join', {}, 'Você agora participa desta OS');
    if (a === 'start') return doOp('start', {}, 'Atendimento iniciado');
    if (a === 'pause') {
      const r = await askReason({ title: 'Pausar atendimento', subtitle: 'Só o seu tempo é pausado; outros participantes continuam.', confirm: 'Pausar',
        suggestions: ['Aguardando peça', 'Aguardando liberação da produção', 'Refeição', 'Fim de turno', 'Atender outra prioridade', 'Aguardando apoio'] });
      if (r) doOp('pause', { reason: r.reason }, 'Atendimento pausado');
      return;
    }
    if (a === 'finish_part') {
      if (await confirmDialog({ title: 'Encerrar minha parte?', body: 'Seu tempo é finalizado nesta OS. A OS continua aberta para os demais.', confirm: 'Encerrar parte' }))
        doOp('finish_part', {}, 'Sua parte foi encerrada');
      return;
    }
    if (a === 'complete') return completeSheet();
    if (a === 'transfer') return transferSheet();
    if (a === 'cancel') {
      const r = await askReason({ title: 'Cancelar OS', subtitle: 'O cancelamento fica auditado no histórico.', confirm: 'Cancelar OS', danger: true,
        suggestions: ['Chamado duplicado', 'Aberto por engano', 'Resolvido pela produção'] });
      if (r) doOp('cancel', { reason: r.reason }, 'OS cancelada');
      return;
    }
    if (a === 'reopen') {
      const r = await askReason({ title: 'Reabrir OS', confirm: 'Reabrir', suggestions: ['Falha voltou a ocorrer', 'Serviço incompleto', 'Validação reprovada'],
        extra: `<label class="check-row" style="margin-top:12px"><input type="checkbox" data-extra="rework" /><span class="box">${icon('check', 16, 3)}</span><span class="text">Marcar como retrabalho (conta no indicador)</span></label>
          ${wo.machineStopped ? `<label class="check-row"><input type="checkbox" data-extra="machineStopped" /><span class="box">${icon('check', 16, 3)}</span><span class="text">A máquina está parada novamente</span></label>` : ''}` ,
      });
      if (r) doOp('reopen', { reason: r.reason, rework: !!r.rework, machineStopped: !!r.machineStopped }, 'OS reaberta');
      return;
    }
    if (a === 'more') {
      const myPart = wo.participants?.find((p) => p.userId === u.id);
      const items = [];
      if (myPart && ['trabalhando', 'pausado', 'aguardando'].includes(myPart.state)) items.push(['finish_part', 'clock', 'Encerrar minha parte', 'Finaliza só o seu tempo']);
      if (myPart?.state !== 'trabalhando' && (wo.responsible?.id === u.id || isManager() || myPart)) items.push(['complete', 'check', 'Concluir OS', 'Registrar serviço realizado']);
      if (wo.responsible?.id === u.id || isManager()) items.push(['transfer', 'swap', 'Transferir responsável', 'Fica registrado no histórico']);
      if (!wo.responsible && isTech()) items.push(['assume', 'hand', 'Assumir OS', '']);
      items.push(['photo', 'camera', 'Adicionar foto', '']);
      if (isManager()) items.push(['cancel', 'x', 'Cancelar OS', 'Somente gerente, com motivo']);
      sheet(`<h2>Ações</h2><div class="menu-list" style="margin-top:8px">${items.map(([k, ic, t, s]) => `
        <button class="menu-item" data-more="${k}"><span class="ico">${icon(ic, 18)}</span><span><strong>${t}</strong>${s ? `<div class="muted xs">${s}</div>` : ''}</span></button>`).join('')}</div>`, {
        onMount(el, sh) {
          el.addEventListener('click', (e) => {
            const b = e.target.closest('[data-more]');
            if (!b) return;
            sh.close();
            if (b.dataset.more === 'photo') $('#photo-input')?.click(); else act(b.dataset.more);
          });
        },
      });
    }
  }

  function completeSheet() {
    const others = (wo.participants || []).filter((p) => p.state === 'trabalhando');
    const checklist = structuredClone(wo.checklist || []);
    sheet(`
      <h2>Concluir OS ${wo.number || ''}</h2>
      <p class="muted small">${esc(wo.machine?.name)}</p>
      <label class="field"><span>Serviço realizado *</span><textarea class="input" id="c-service" rows="3" placeholder="O que foi feito" autofocus></textarea></label>
      ${wo.type === 'corretiva' ? `
      <label class="field"><span>Causa (opcional)</span><input class="input" id="c-cause" placeholder="Ex.: rolamento gasto, contatora queimada" /></label>
      <label class="field"><span>Solução (opcional)</span><input class="input" id="c-solution" placeholder="Ex.: troca do rolamento" /></label>` : ''}
      ${checklist.length ? `<div class="field"><span>Checklist (obrigatório)</span>${checklist.map((c, i) => `
        <label class="check-row ${c.done ? 'checked' : ''}" data-cc="${i}"><input type="checkbox" ${c.done ? 'checked' : ''} /><span class="box">${icon('check', 16, 3)}</span><span class="text">${esc(c.text)}</span></label>`).join('')}</div>` : ''}
      ${wo.machineStopped ? `
      <div class="field"><span>Máquina</span>
        <label class="check-row checked" id="c-rec-row"><input type="checkbox" id="c-recovered" checked /><span class="box">${icon('check', 16, 3)}</span><span class="text">Máquina voltou a operar</span></label>
        <label class="field" id="c-ret-wrap" style="margin-top:8px"><span>Horário de retorno</span><input class="input" type="datetime-local" id="c-returned" value="${localInputValue()}" /></label>
      </div>` : ''}
      ${others.length ? `<div class="warn-box small" style="margin-top:12px">${icon('clock', 14)} Intervalos ativos serão encerrados agora: <strong>${others.map((p) => esc(p.name)).join(', ')}</strong></div>` : ''}
      <div class="error-box hidden" id="c-err" style="margin-top:12px"></div>
      <div class="sheet-actions"><button class="btn" data-close>Voltar</button><button class="btn success" id="c-ok">${icon('check', 18)} Concluir</button></div>
    `, {
      onMount(el, sh) {
        el.querySelectorAll('[data-cc]').forEach((row) => row.addEventListener('click', (e) => {
          e.preventDefault();
          const i = +row.dataset.cc;
          checklist[i].done = !checklist[i].done;
          row.classList.toggle('checked', checklist[i].done);
        }));
        const rec = el.querySelector('#c-rec-row');
        rec?.addEventListener('click', (e) => {
          e.preventDefault();
          const cb = el.querySelector('#c-recovered');
          cb.checked = !cb.checked;
          rec.classList.toggle('checked', cb.checked);
          el.querySelector('#c-ret-wrap').classList.toggle('hidden', !cb.checked);
        });
        el.querySelector('#c-ok').addEventListener('click', () => {
          const err = (m) => { const b = el.querySelector('#c-err'); b.textContent = m; b.classList.remove('hidden'); };
          const serviceDone = el.querySelector('#c-service').value.trim();
          if (serviceDone.length < 3) return err('Descreva o serviço realizado');
          if (checklist.some((c) => !c.done)) return err('Marque todos os itens do checklist');
          const recovered = el.querySelector('#c-recovered')?.checked;
          const retVal = el.querySelector('#c-returned')?.value;
          if (recovered && retVal && new Date(retVal) > new Date(Date.now() + 60000)) return err('Horário de retorno no futuro');
          sh.close();
          doOp('complete', {
            serviceDone, cause: el.querySelector('#c-cause')?.value, solution: el.querySelector('#c-solution')?.value,
            checklist: checklist.length ? checklist : undefined,
            machineRecovered: !!recovered, returnedAt: recovered && retVal ? new Date(retVal).toISOString() : undefined,
          }, 'OS concluída');
        });
      },
    });
  }

  function transferSheet() {
    const techs = state.boot.users.filter((u) => ['manutentor', 'gerente'].includes(u.role) && u.id !== wo.responsible?.id);
    let to = null;
    sheet(`<h2>Transferir responsável</h2>
      <div style="margin-top:12px">${techs.map((u) => `<button class="user-option" data-to="${u.id}">${avatar(u.name)}<span class="grow"><strong>${esc(u.name)}</strong><div class="muted xs">${esc(u.specialty || ROLE[u.role])}</div></span></button>`).join('')}</div>
      <label class="field" style="margin-top:12px"><span>Motivo *</span><input class="input" id="t-reason" placeholder="Ex.: fim de turno, especialidade elétrica" /></label>
      <div class="error-box hidden" id="t-err" style="margin-top:10px"></div>
      <div class="sheet-actions"><button class="btn" data-close>Voltar</button><button class="btn primary" id="t-ok">Transferir</button></div>`, {
      onMount(el, sh) {
        el.querySelectorAll('[data-to]').forEach((b) => b.addEventListener('click', () => {
          to = b.dataset.to;
          el.querySelectorAll('[data-to]').forEach((x) => x.classList.toggle('active', x === b));
        }));
        el.querySelector('#t-ok').addEventListener('click', () => {
          const reason = el.querySelector('#t-reason').value.trim();
          const err = el.querySelector('#t-err');
          if (!to || !reason) { err.textContent = 'Escolha o novo responsável e informe o motivo'; return err.classList.remove('hidden'); }
          sh.close();
          doOp('transfer', { toUserId: to, reason }, 'OS transferida');
        });
      },
    });
  }

  function correctSheet(ivId) {
    const iv = wo.intervals.find((i) => i.id === ivId);
    sheet(`<h2>Corrigir intervalo</h2><p class="muted small">${esc(iv.userName)} — o valor anterior fica preservado na auditoria.</p>
      <label class="field"><span>Início</span><input class="input" type="datetime-local" id="ci-s" value="${localInputValue(new Date(iv.started_at))}" /></label>
      <label class="field"><span>Fim</span><input class="input" type="datetime-local" id="ci-e" value="${iv.ended_at ? localInputValue(new Date(iv.ended_at)) : ''}" /></label>
      <label class="field"><span>Motivo da correção *</span><input class="input" id="ci-r" placeholder="Ex.: esqueceu de pausar no almoço" /></label>
      <div class="error-box hidden" id="ci-err" style="margin-top:10px"></div>
      <div class="sheet-actions"><button class="btn" data-close>Voltar</button><button class="btn primary" id="ci-ok">Salvar correção</button></div>`, {
      onMount(el, sh) {
        el.querySelector('#ci-ok').addEventListener('click', () => {
          const reason = el.querySelector('#ci-r').value.trim();
          const s = el.querySelector('#ci-s').value, e = el.querySelector('#ci-e').value;
          const err = el.querySelector('#ci-err');
          if (!reason) { err.textContent = 'Informe o motivo'; return err.classList.remove('hidden'); }
          if (e && new Date(e) <= new Date(s)) { err.textContent = 'Fim deve ser após o início'; return err.classList.remove('hidden'); }
          sh.close();
          doOp('correct_interval', { intervalId: iv.id, startedAt: new Date(s).toISOString(), endedAt: e ? new Date(e).toISOString() : undefined, reason }, 'Correção registrada');
        });
      },
    });
  }

  function bind() {
    $('#btn-back', root)?.addEventListener('click', () => (history.length > 1 ? history.back() : go('#/')));
    $$('[data-check]', root).forEach((row) => row.addEventListener('click', (e) => {
      e.preventDefault();
      if (!isTech() || isClosed(wo)) return;
      const list = structuredClone(wo.checklist);
      const i = +row.dataset.check;
      list[i].done = !list[i].done;
      row.classList.toggle('checked', list[i].done);
      enqueue('update_checklist', wo.id, { checklist: list }).then(async () => { wo = await fetchDetail(id).catch(() => wo); render(); });
    }));
    $('#photo-input', root)?.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const dataUrl = await compressImage(f);
        await doOp('attach', { id: uuid(), dataUrl }, state.online ? 'Foto enviada' : 'Foto salva — envio pendente');
      } catch (err) { toast(esc(err.message), 'err'); }
    });
    $$('[data-correct]', root).forEach((b) => b.addEventListener('click', () => correctSheet(b.dataset.correct)));
  }

  load();
  const off = on((w) => { if (w === 'wos' && alive) fetchDetail(id).then((d) => { wo = d; render(); }).catch(() => {}); });
  return () => { alive = false; off(); $('#action-bar')?.remove(); document.body.classList.remove('has-action-bar'); };
}

function recipientsLabel(wo) {
  if (wo.recipientsMode === 'equipe') return `Equipe: ${(wo.recipients || []).map((t) => state.boot?.teams.find((x) => x.id === t)?.name || t).join(', ')}`;
  if (wo.recipientsMode === 'selecionados') return `${(wo.recipients || []).length} selecionado(s)`;
  return 'Todos';
}

const EV = {
  criar: ['Chamado aberto', 'var(--info)'], assumir: ['Assumiu a OS', 'var(--violet)'], participar: ['Entrou como colaborador', 'var(--violet)'],
  iniciar: ['Iniciou atendimento', 'var(--accent)'], retomar: ['Retomou atendimento', 'var(--accent)'], pausar: ['Pausou', 'var(--warn)'],
  encerrar_parte: ['Encerrou sua parte', 'var(--ok)'], encerrado_na_conclusao: ['Intervalo encerrado na conclusão', 'var(--ok)'],
  transferir: ['Transferiu responsável', 'var(--violet)'], concluir: ['Concluiu a OS', 'var(--ok)'], cancelar: ['Cancelou a OS', 'var(--text-3)'],
  reabrir: ['Reabriu a OS', 'var(--danger)'], foto: ['Adicionou foto', 'var(--text-3)'], checklist: ['Atualizou checklist', 'var(--text-3)'],
  gerar_preventiva: ['OS preventiva gerada', 'hsl(180 70% 50%)'], corrigir_tempo: ['Corrigiu tempo (auditado)', 'var(--danger)'],
};
function eventItem(e) {
  const [label, color] = EV[e.action] || [e.action, 'var(--text-3)'];
  let extra = '';
  if (e.action === 'transferir' && e.data?.to) extra = ` → ${esc(userName(e.data.to))}`;
  if (e.action === 'assumir' && e.data?.auto) extra = ' (ao iniciar)';
  if (e.action === 'reabrir' && e.data?.rework) extra = ' • retrabalho';
  if (e.action === 'checklist' && e.data) extra = ` (${e.data.done}/${e.data.total})`;
  const late = e.receivedAt && Math.abs(new Date(e.receivedAt) - new Date(e.localTime)) > 120000;
  return `<div class="tl-item" style="--c:${color}">
    <div class="what">${esc(e.userName)} — ${label}${extra} ${e.pending ? `<span class="badge pending" style="height:20px">pendente</span>` : ''}</div>
    <div class="when">${fmtDateTime(e.localTime)}${late ? ` • recebido ${fmtDateTime(e.receivedAt)} (offline)` : ''}</div>
    ${e.reason ? `<div class="why">${esc(e.reason)}</div>` : ''}
  </div>`;
}

// ======================================================================
// NOVA OS
// ======================================================================
export function newView(root, params) {
  const boot = state.boot;
  let machine = null;
  let sectorMachines = null;
  let photos = [];
  let stopped = false;
  let priority = 'media';
  let type = 'corretiva';
  let mode = boot.settings.defaultRecipientsMode || 'todos';
  let selTeams = new Set();
  let selUsers = new Set();
  let error = '';
  let codeTyped = '';
  let search = '';

  async function resolve(code) {
    code = extractCode(code);
    codeTyped = code;
    error = '';
    sectorMachines = null;
    const m = boot.machines.find((x) => x.code.toUpperCase() === code);
    if (m) { machine = m; return render(); }
    const s = boot.sectors.find((x) => x.code.toUpperCase() === code);
    if (s) { sectorMachines = { sector: s, machines: boot.machines.filter((x) => x.sector_id === s.id) }; return render(); }
    try {
      const r = await api(`/api/resolve/${encodeURIComponent(code)}`);
      if (r.kind === 'machine') machine = r.machine;
      else sectorMachines = { sector: r.sector, machines: r.machines };
    } catch {
      error = `Código “${esc(code)}” não encontrado. Confira a etiqueta ou busque a máquina pelo nome abaixo.`;
      search = '';
    }
    render();
  }

  const sectorName = (id) => boot.sectors.find((s) => s.id === id)?.name || '';

  function render() {
    if (!machine) {
      const list = sectorMachines ? sectorMachines.machines : boot.machines;
      const ql = search.toLowerCase();
      const filtered = list.filter((m) => !ql || `${m.code} ${m.name} ${sectorName(m.sector_id)}`.toLowerCase().includes(ql));
      root.innerHTML = `
        <div class="page-head"><div><h1>Abrir OS</h1><p>Identifique a máquina pelo QR ou código</p></div></div>
        <div class="big-actions">
          <button class="big-action" id="btn-scan"><div class="ico">${icon('qr', 24)}</div><strong>Escanear QR</strong><span>${cameraSupported() ? 'Usar a câmera' : 'Requer HTTPS'}</span></button>
          <button class="big-action" id="btn-type"><div class="ico">${icon('keyboard', 24)}</div><strong>Digitar código</strong><span>Ex.: M-PRS01</span></button>
        </div>
        <form id="code-form" class="input-group" style="margin-top:12px">
          <input class="input" id="code-input" placeholder="Código da máquina ou setor" value="${esc(codeTyped)}" autocapitalize="characters" autocomplete="off" />
          <button class="btn primary" type="submit" id="btn-resolve">Buscar</button>
        </form>
        ${error ? `<div class="error-box" style="margin-top:12px">${error}</div>` : ''}
        ${sectorMachines ? `<div class="info-box" style="margin-top:12px">QR do setor <strong>${esc(sectorMachines.sector.name)}</strong> — escolha a máquina:</div>` : ''}
        <div class="section-title"><span>${sectorMachines ? 'Máquinas do setor' : 'Ou escolha na lista'}</span>
          ${sectorMachines ? '<button class="btn ghost sm" id="btn-all">Ver todas</button>' : ''}</div>
        <input class="input" id="m-search" placeholder="Filtrar por nome ou setor" value="${esc(search)}" style="margin-bottom:10px" />
        <div id="m-list">${filtered.map((m) => `
          <button class="machine-pick" data-machine="${m.id}" id="pick-${m.code}">
            <span class="code">${esc(m.code)}</span>
            <span class="grow"><strong>${esc(m.name)}</strong><div class="muted xs"><span class="crit crit-${m.criticality}"></span>${esc(sectorName(m.sector_id))}</div></span>
            ${icon('chev', 18)}
          </button>`).join('') || '<p class="muted">Nenhuma máquina encontrada.</p>'}</div>`;
      $('#btn-scan', root).onclick = async () => { const c = await scanQR(); if (c) resolve(c); };
      $('#btn-type', root).onclick = () => $('#code-input', root).focus();
      $('#code-form', root).onsubmit = (e) => { e.preventDefault(); const v = $('#code-input', root).value.trim(); if (v) resolve(v); };
      $('#btn-all', root)?.addEventListener('click', () => { sectorMachines = null; render(); });
      $('#m-search', root).oninput = (e) => {
        search = e.target.value;
        const pos = e.target.selectionStart;
        render();
        const i = $('#m-search', root); i.focus(); i.setSelectionRange(pos, pos);
      };
      $$('[data-machine]', root).forEach((b) => (b.onclick = () => { machine = boot.machines.find((m) => m.id === b.dataset.machine); error = ''; render(); }));
      return;
    }

    const techs = boot.users.filter((u) => ['manutentor', 'gerente'].includes(u.role));
    const openOnMachine = workOrders().filter((w) => w.machine?.id === machine.id && !isClosed(w));
    root.innerHTML = `
      <div class="page-head"><div><h1>Abrir OS</h1><p>Solicitante: ${esc(me().name)}</p></div></div>
      <div class="machine-selected">
        <div class="ico">${icon('factory', 22)}</div>
        <div class="grow"><strong style="font-size:16px">${esc(machine.name)}</strong><div class="muted small">${esc(machine.code)} • ${esc(sectorName(machine.sector_id))}</div></div>
        <button class="btn ghost sm" id="btn-change">Trocar</button>
      </div>
      ${openOnMachine.length ? `<div class="warn-box small" style="margin-top:10px">Já existe ${openOnMachine.length} OS aberta nesta máquina: ${openOnMachine.map((w) => `<a href="#/os/${w.id}">OS ${w.number ?? 'nova'}</a>`).join(', ')}. Confira antes de abrir outra.</div>` : ''}

      <form id="new-form" style="margin-top:16px">
        <button type="button" class="toggle-stop ${stopped ? 'on' : ''}" id="toggle-stop" aria-pressed="${stopped}">
          <span class="sw"></span>
          <span><strong>Máquina parada</strong><span class="muted small">${stopped ? 'Será destacada e todos os avisados serão alertados' : 'Toque se a máquina não está produzindo'}</span></span>
        </button>

        <label class="field" style="margin-top:14px"><span>O que está acontecendo? *</span>
          <textarea class="input" id="desc" rows="3" placeholder="Ex.: prensa não desce, barulho no motor, vazamento de óleo…"></textarea></label>

        <div class="field"><span>Prioridade</span>
          <div class="segmented priority" id="seg-prio">${Object.entries(PRIORITY).map(([k, v]) => `<button type="button" data-value="${k}" class="${priority === k ? 'active' : ''}">${v}</button>`).join('')}</div></div>

        <div class="field"><span>Tipo</span>
          <div class="segmented" id="seg-type"><button type="button" data-value="corretiva" class="${type === 'corretiva' ? 'active' : ''}">Corretiva</button><button type="button" data-value="preventiva" class="${type === 'preventiva' ? 'active' : ''}">Preventiva/Inspeção</button></div></div>

        <div class="field"><span>Fotos (opcional)</span>
          <div class="photos">
            ${photos.map((p, i) => `<div class="ph"><img src="${p}" alt="Foto ${i + 1}" /><button type="button" class="rm" data-rm="${i}" aria-label="Remover foto">×</button></div>`).join('')}
            <label class="add-photo" aria-label="Adicionar foto">${icon('camera', 24)}<input type="file" accept="image/*" capture="environment" multiple hidden id="new-photo" /></label>
          </div></div>

        <label class="field">
          <span>Manutentor Direcionado (Opcional)</span>
          <select class="input select" id="new-responsible">
            <option value="">Não direcionar (Alerta geral para todos os técnicos)</option>
            ${techs.map((t) => `<option value="${t.id}">${esc(t.name)} ${t.specialty ? `(${esc(t.specialty)})` : ''}</option>`).join('')}
          </select>
          <span class="muted xs" style="display:block;margin-top:3px">
            Se direcionado a um técnico específico, ele receberá um alerta sonoro direto. Deixe em aberto para acionar toda a fábrica.
          </span>
        </label>

        <div class="field"><span>Quem será avisado</span>
          <div class="segmented" id="seg-mode">
            <button type="button" data-value="todos" class="${mode === 'todos' ? 'active' : ''}">Todos</button>
            <button type="button" data-value="equipe" class="${mode === 'equipe' ? 'active' : ''}">Equipe</button>
            <button type="button" data-value="selecionados" class="${mode === 'selecionados' ? 'active' : ''}">Selecionados</button>
          </div>
          ${mode === 'equipe' ? `<div class="chips" style="margin-top:10px">${boot.teams.map((t) => `<button type="button" class="chip ${selTeams.has(t.id) ? 'active' : ''}" data-team="${t.id}">${esc(t.name)}</button>`).join('')}</div>` : ''}
          ${mode === 'selecionados' ? `<div style="margin-top:10px">${techs.map((u) => `
            <label class="check-row ${selUsers.has(u.id) ? 'checked' : ''}" data-user="${u.id}"><input type="checkbox" /><span class="box">${icon('check', 16, 3)}</span>
              <span class="text grow">${esc(u.name)}</span><span class="muted xs">${esc(u.specialty || ROLE[u.role])}</span></label>`).join('')}</div>` : ''}
          ${mode === 'todos' ? `<p class="muted xs" style="margin:8px 2px 0">${techs.length} manutentores/gerente serão avisados.</p>` : ''}
        </div>

        <div class="error-box hidden" id="new-err" style="margin-top:14px"></div>
        <button type="submit" class="btn primary lg block" style="margin-top:18px" id="btn-submit">${icon('check', 20)} Registrar OS</button>
        <p class="muted xs" style="text-align:center;margin-top:8px">Se a internet cair, o chamado fica salvo no aparelho e é enviado ao reconectar.</p>
      </form>`;

    const desc = $('#desc', root);
    desc.value = sessionStorage.getItem('nova-os:draft') || '';
    desc.oninput = () => sessionStorage.setItem('nova-os:draft', desc.value);
    $('#btn-change', root).onclick = () => { machine = null; render(); };
    $('#toggle-stop', root).onclick = () => { stopped = !stopped; if (stopped && PRANK[priority] > 1) priority = 'alta'; render(); };
    const seg = (sel, set) => $$(`${sel} button`, root).forEach((b) => (b.onclick = () => { set(b.dataset.value); render(); }));
    seg('#seg-prio', (v) => (priority = v));
    seg('#seg-type', (v) => (type = v));
    seg('#seg-mode', (v) => (mode = v));
    $$('[data-team]', root).forEach((b) => (b.onclick = () => { selTeams.has(b.dataset.team) ? selTeams.delete(b.dataset.team) : selTeams.add(b.dataset.team); render(); }));
    $$('[data-user]', root).forEach((b) => (b.onclick = (e) => { e.preventDefault(); selUsers.has(b.dataset.user) ? selUsers.delete(b.dataset.user) : selUsers.add(b.dataset.user); render(); }));
    $$('[data-rm]', root).forEach((b) => (b.onclick = () => { photos.splice(+b.dataset.rm, 1); render(); }));
    $('#new-photo', root).onchange = async (e) => {
      for (const f of [...e.target.files].slice(0, 6)) {
        try { photos.push(await compressImage(f)); } catch { toast('Uma das imagens não pôde ser lida', 'err'); }
      }
      render();
    };
    $('#new-form', root).onsubmit = async (e) => {
      e.preventDefault();
      const err = (m) => { const b = $('#new-err', root); b.textContent = m; b.classList.remove('hidden'); b.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
      const description = desc.value.trim();
      if (description.length < 3) return err('Descreva o problema');
      const recipients = mode === 'equipe' ? [...selTeams] : mode === 'selecionados' ? [...selUsers] : [];
      if (mode !== 'todos' && !recipients.length) return err(mode === 'equipe' ? 'Escolha ao menos uma equipe' : 'Escolha ao menos um manutentor');
      const responsibleId = $('#new-responsible', root)?.value || null;
      $('#btn-submit', root).disabled = true;
      const id = uuid();
      try {
        await enqueue('create_wo', id, { id, machineId: machine.id, description, type, priority, machineStopped: stopped, recipientsMode: mode, recipients, responsibleId });
        for (const p of photos) await enqueue('attach', id, { id: uuid(), dataUrl: p });
      } catch (ex) {
        $('#btn-submit', root).disabled = false;
        return err(ex.message);
      }
      sessionStorage.removeItem('nova-os:draft');
      toast(state.online ? 'OS registrada e avisos enviados' : 'OS salva no aparelho — será enviada ao reconectar', state.online ? 'ok' : 'warn', 4000);
      go(`#/os/${id}`);
    };
  }

  if (!['solicitante', 'manutentor', 'gerente', 'admin', 'superadmin'].includes(me()?.role)) return;
  if (params.qr) resolve(params.qr); else render();
}

// ======================================================================
// PREVENTIVAS
// ======================================================================
export function plansView(root) {
  let plans = null;
  let alive = true;
  async function load() {
    try {
      plans = (await api('/api/plans')).plans;
      kv.set('plans', plans);
    } catch {
      plans = (await kv.get('plans')) || [];
      if (alive) toast('Sem conexão — exibindo planos salvos', 'warn');
    }
    if (alive) render();
  }
  function render() {
    const today = new Date().toISOString().slice(0, 10);
    const lateOrders = workOrders().filter((w) => w.type === 'preventiva' && w.overdue);
    root.innerHTML = `
      <div class="page-head"><div><h1>Preventivas</h1><p>Calendário fixo • uma OS por ciclo</p></div>
        ${isManager() ? `<button class="btn primary sm" id="btn-new-plan">${icon('plus', 16)} Novo plano</button>` : ''}</div>
      ${lateOrders.length ? `<div class="error-box" style="margin-bottom:12px">${icon('alert', 14)} ${lateOrders.length} preventiva(s) atrasada(s): ${lateOrders.map((w) => `<a href="#/os/${w.id}" style="color:inherit;text-decoration:underline">OS ${w.number}</a>`).join(', ')}</div>` : ''}
      ${!plans.length ? `<div class="empty"><div class="ico">${icon('calendar', 28)}</div><strong>Nenhum plano preventivo</strong></div>` : ''}
      ${plans.map((p) => {
        const days = Math.round((new Date(p.next_due + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000);
        const late = p.openOrders.filter((o) => o.due_date < today);
        const pct = Math.max(0, Math.min(100, 100 - (days / p.frequency_days) * 100));
        return `
        <article class="card plan-card" id="plan-${p.id}" style="${p.active ? '' : 'opacity:.55'}">
          <div class="row" style="align-items:flex-start">
            <div class="progress-ring" style="--p:${pct}" data-label="${p.frequency_days}d"></div>
            <div class="grow">
              <strong style="font-size:16px">${esc(p.title)}</strong>
              <div class="muted small">${esc(p.machine?.code)} • ${esc(p.machine?.name)}</div>
            </div>
            ${!p.active ? '<span class="badge">Pausado</span>' : ''}
          </div>
          <div class="kv">
            <div><span>Próximo ciclo</span><strong>${fmtDate(p.next_due)} <span class="muted xs">(${days >= 0 ? `em ${days}d` : `${-days}d atrás`})</span></strong></div>
            <div><span>Responsável</span><strong>${esc(p.responsibleName || 'Todos')}</strong></div>
            <div><span>Gera com antecedência</span><strong>${p.lead_days} dia(s)</strong></div>
            <div><span>Última concluída</span><strong>${p.lastDone ? `${fmtDate(p.lastDone.closed_at)}${p.lastDone.closed_at.slice(0, 10) > p.lastDone.due_date ? ' <span class="badge late" style="height:18px">fora do prazo</span>' : ''}` : '—'}</strong></div>
          </div>
          <div class="muted xs" style="margin-top:10px">Checklist: ${p.checklist.map((c) => esc(c.text)).join(' • ')}</div>
          ${p.openOrders.length ? `<div class="row wrap" style="margin-top:10px">${p.openOrders.map((o) => `<a class="badge ${o.due_date < today ? 'late' : 'prev'}" href="#/os/${o.id}">OS ${o.number} • ${fmtDate(o.due_date)}${o.due_date < today ? ' • atrasada' : ''}</a>`).join('')}</div>` : ''}
          ${isManager() ? `<div class="row" style="margin-top:12px">
            <button class="btn sm" data-gen="${p.id}" ${p.active ? '' : 'disabled'}>${icon('plus', 14)} Gerar OS do próximo ciclo</button>
            <button class="btn ghost sm" data-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Pausar plano' : 'Reativar'}</button></div>` : ''}
          ${late.length ? '' : ''}
        </article>`;
      }).join('')}
      <p class="muted xs" style="margin-top:14px">O servidor gera automaticamente a OS de cada ciclo dentro da antecedência configurada e avisa atrasos. Datas seguem calendário fixo (não dependem da data de execução) — regra a validar com a equipe.</p>`;

    $('#btn-new-plan', root)?.addEventListener('click', newPlanSheet);
    $$('[data-gen]', root).forEach((b) => (b.onclick = async () => {
      try {
        const r = await api(`/api/plans/${b.dataset.gen}/generate`, { method: 'POST' });
        toast(r.duplicate ? `Ciclo já tinha OS ${r.number}; próxima data avançada` : `OS ${r.number} gerada`);
        await sync(); load();
      } catch (e) { toast(esc(e.message), 'err'); }
    }));
    $$('[data-toggle]', root).forEach((b) => (b.onclick = async () => {
      try { await api(`/api/plans/${b.dataset.toggle}`, { method: 'PUT', body: { active: b.dataset.active !== '1' } }); load(); } catch (e) { toast(esc(e.message), 'err'); }
    }));
  }

  function newPlanSheet() {
    const boot = state.boot;
    const techs = boot.users.filter((u) => u.role === 'manutentor');
    sheet(`<h2>Novo plano preventivo</h2>
      <label class="field" style="margin-top:12px"><span>Máquina *</span><select class="input" id="p-m">${boot.machines.map((m) => `<option value="${m.id}">${esc(m.code)} — ${esc(m.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Título *</span><input class="input" id="p-t" placeholder="Ex.: Lubrificação geral" /></label>
      <div class="field"><span>Frequência</span><div class="chips" id="p-freq">${[[7, 'Semanal'], [15, 'Quinzenal'], [30, 'Mensal'], [90, 'Trimestral'], [180, 'Semestral'], [365, 'Anual']].map(([d, l]) => `<button class="chip ${d === 30 ? 'active' : ''}" data-d="${d}">${l}</button>`).join('')}</div></div>
      <div class="row"><label class="field grow"><span>Primeiro vencimento *</span><input class="input" type="date" id="p-a" value="${new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)}" /></label>
        <label class="field" style="width:120px;margin-top:0"><span>Antecedência</span><input class="input" type="number" id="p-l" min="0" max="30" value="2" /></label></div>
      <label class="field"><span>Responsável</span><select class="input" id="p-r"><option value="">Todos os manutentores</option>${techs.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Checklist (um item por linha)</span><textarea class="input" id="p-c" rows="4" placeholder="Verificar nível de óleo&#10;Reapertar parafusos"></textarea></label>
      <div class="error-box hidden" id="p-err" style="margin-top:10px"></div>
      <div class="sheet-actions"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="p-ok">Criar plano</button></div>`, {
      onMount(el, sh) {
        let freq = 30;
        el.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => { freq = +b.dataset.d; el.querySelectorAll('[data-d]').forEach((x) => x.classList.toggle('active', x === b)); }));
        el.querySelector('#p-ok').onclick = async () => {
          try {
            await api('/api/plans', { method: 'POST', body: {
              machineId: el.querySelector('#p-m').value, title: el.querySelector('#p-t').value, frequencyDays: freq,
              anchorDate: el.querySelector('#p-a').value, leadDays: +el.querySelector('#p-l').value, responsibleId: el.querySelector('#p-r').value,
              checklist: el.querySelector('#p-c').value.split('\n'),
            } });
            sh.close(); toast('Plano criado'); sync(); load();
          } catch (e) {
            const b = el.querySelector('#p-err'); b.textContent = e instanceof NetError ? 'Sem conexão — planos exigem internet' : e.message; b.classList.remove('hidden');
          }
        };
      },
    });
  }

  root.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  load();
  return () => { alive = false; };
}

// ======================================================================
// INDICADORES
// ======================================================================
export function kpiView(root) {
  const boot = state.boot;
  const f = JSON.parse(sessionStorage.getItem('nova-os:kpi') || '{"days":"30"}');
  let alive = true;
  root.innerHTML = `
    <div class="page-head"><div><h1>Indicadores</h1><p id="kpi-period"></p></div></div>
    <div class="chips" id="kpi-days">${[['7', '7 dias'], ['30', '30 dias'], ['90', '90 dias'], ['365', '12 meses']].map(([d, l]) => `<button class="chip ${f.days === d ? 'active' : ''}" data-days="${d}">${l}</button>`).join('')}</div>
    <div class="filters" style="margin:8px 0 6px">
      <select class="input" id="f-sector"><option value="">Todos os setores</option>${boot.sectors.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <select class="input" id="f-machine"><option value="">Todas as máquinas</option>${boot.machines.map((m) => `<option value="${m.id}">${esc(m.code)} ${esc(m.name)}</option>`).join('')}</select>
      <select class="input" id="f-team"><option value="">Todas as equipes</option>${boot.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <select class="input" id="f-user"><option value="">Todos os manutentores</option>${boot.users.filter((u) => u.role === 'manutentor').map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
    </div>
    <div id="kpi-body"><div class="skeleton"></div></div>`;
  for (const [k, sel] of [['sectorId', '#f-sector'], ['machineId', '#f-machine'], ['teamId', '#f-team'], ['userId', '#f-user']]) {
    $(sel, root).value = f[k] || '';
    $(sel, root).onchange = (e) => { f[k] = e.target.value; load(); };
  }
  $$('[data-days]', root).forEach((b) => (b.onclick = () => { f.days = b.dataset.days; $$('[data-days]', root).forEach((x) => x.classList.toggle('active', x === b)); load(); }));

  async function load() {
    sessionStorage.setItem('nova-os:kpi', JSON.stringify(f));
    const to = new Date();
    const from = new Date(Date.now() - (Number(f.days) - 1) * 86400000);
    const qs = new URLSearchParams({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), ...Object.fromEntries(['sectorId', 'machineId', 'teamId', 'userId'].filter((k) => f[k]).map((k) => [k, f[k]])) });
    let d;
    try { d = await api(`/api/indicators?${qs}`); kv.set('kpi', d); }
    catch { d = await kv.get('kpi'); if (!d) { $('#kpi-body', root).innerHTML = '<div class="empty">Indicadores exigem conexão.</div>'; return; } toast('Sem conexão — últimos indicadores salvos', 'warn'); }
    if (alive) render(d);
  }

  function render(d) {
    $('#kpi-period', root).textContent = `${fmtDate(d.period.from)} a ${fmtDate(d.period.to)} • ${d.dataQuality.wosInPeriod} OS no período`;
    const maxOcc = Math.max(1, ...d.byMachine.map((m) => m.corrective));
    const kpi = (k, v, unit, s, color, na) => `<div class="kpi ${na ? 'na' : ''}" style="--kc:${color || 'var(--text)'}"><div class="k">${k}</div><div class="v">${v}${unit ? `<small>${unit}</small>` : ''}</div><div class="s">${s || ''}</div></div>`;
    const split = (min) => { if (min == null) return ['—', '']; if (min < 60) return [Math.round(min), 'min']; return [(min / 60).toFixed(1).replace('.', ','), 'h']; };
    const [rv, ru] = split(d.responseTime.avgMin);
    const [mv, mu] = split(d.mttr.avgMin);
    const [sv, su] = split(d.stoppedTime.totalMin);
    const [cv, cu] = split(d.correctiveDuration.avgMin);
    $('#kpi-body', root).innerHTML = `
      <div class="section-title"><span>Situação agora</span></div>
      <div class="kpis">
        ${kpi('OS abertas', d.current.open, '', Object.entries(d.current.byStatus).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' • '), 'var(--info)')}
        ${kpi('Máquinas paradas', d.current.stoppedMachines.length, '', d.current.stoppedMachines.map((m) => esc(m.code)).join(', ') || 'nenhuma', d.current.stoppedMachines.length ? 'var(--danger)' : 'var(--ok)')}
        ${kpi('Preventivas atrasadas', d.current.overduePreventive, '', 'abertas após vencimento', d.current.overduePreventive ? 'var(--danger)' : 'var(--ok)')}
        ${kpi('Preventivas no prazo', d.preventiveOnTime.pct == null ? '—' : d.preventiveOnTime.pct, d.preventiveOnTime.pct == null ? '' : '%', `${d.preventiveOnTime.onTime}/${d.preventiveOnTime.eligible} ciclos devidos`, 'hsl(180 70% 55%)')}
      </div>
      <div class="section-title"><span>Tempos</span></div>
      <div class="kpis">
        ${kpi('Tempo de resposta', rv, ru, `média • abertura → 1º início (${d.responseTime.n} OS)`, 'var(--accent)')}
        ${kpi('MTTR', mv, mu, `parada → retorno (${d.mttr.n} reparos)`, 'var(--violet)')}
        ${kpi('Duração corretivas', cv, cu, `abertura → conclusão (${d.correctiveDuration.n})`, 'var(--text)')}
        ${kpi('Tempo parado', sv, su, `${d.stoppedTime.intervals} parada(s), sem dupla contagem`, 'var(--danger)')}
        ${kpi('Retrabalho', d.rework.pct == null ? '—' : d.rework.pct, d.rework.pct == null ? '' : '%', `${d.rework.reopened + d.rework.linked} de ${d.rework.completed} concluídas`, 'var(--warn)')}
        ${kpi('MTBF', 'Não calculado', '', d.mtbf.reason, null, true)}
        ${kpi('Disponibilidade', 'Não calculada', '', d.availability.reason, null, true)}
      </div>

      <div class="section-title"><span>Ocorrências corretivas por máquina</span></div>
      <section class="card">
        ${d.byMachine.length ? d.byMachine.map((m) => `
          <div class="bar-row"><div class="ellipsis"><strong>${esc(m.code)}</strong> <span class="muted small">${esc(m.name)}</span></div>
            <div class="mono small">${m.corrective} OS • ${fmtMin(m.stoppedMin)} parada</div>
            <div class="bar ${m.stoppedMin > 0 ? 'red' : ''}"><i style="width:${(m.corrective / maxOcc) * 100}%"></i></div></div>`).join('') : '<p class="muted small">Sem corretivas no período.</p>'}
      </section>

      <div class="section-title"><span>Trabalho por manutentor</span></div>
      <section class="card">
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Manutentor</th><th class="num">Horas ativas</th><th class="num">OS trabalhadas</th><th class="num">Concl. resp.</th><th class="num">Colaborou</th><th class="num">Prev.</th><th class="num">Retrab.</th></tr></thead>
          <tbody>${d.people.map((p) => `<tr><td><div class="row">${avatar(p.name, 'sm')}<span><strong>${esc(p.name)}</strong><div class="muted xs">${esc(p.specialty || '')}</div></span></div></td>
            <td class="num">${fmtMin(p.workMin)}</td><td class="num">${p.wosWorked}</td><td class="num">${p.completedAsResponsible}</td><td class="num">${p.completedAsCollaborator}</td><td class="num">${p.preventiveDone}</td><td class="num">${p.rework}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="muted xs" style="margin:10px 0 0">Ordem alfabética, sem ranking automático. Horas-pessoa somam intervalos individuais (excluem pausas) e não equivalem a tempo de máquina parada. Compare considerando especialidade, complexidade e disponibilidade.</p>
      </section>

      <div class="section-title"><span>Qualidade dos dados</span></div>
      <section class="card small">
        <div class="kv" style="margin-top:0">
          <div><span>OS no período</span><strong>${d.dataQuality.wosInPeriod}</strong></div>
          <div><span>Eventos registrados</span><strong>${d.dataQuality.events}</strong></div>
          <div><span>Sem início de atendimento</span><strong>${d.dataQuality.withoutStart}</strong></div>
          <div><span>Corretivas sem causa</span><strong>${d.dataQuality.missingCause}</strong></div>
        </div>
      </section>`;
  }
  load();
  return () => { alive = false; };
}

// ======================================================================
// MAIS / MÁQUINAS / AVISOS / SINCRONIZAÇÃO / CONFIGURAÇÕES
// ======================================================================
export function moreView(root) {
  const isAdm = isAdmin();
  const isSuper = isSuperAdmin();

  const items = [
    ...(isAdm ? [['#/usuarios', 'users', isSuper ? 'Gestão de Usuários e Manutentores' : 'Gestão de Manutentores', 'Cadastrar equipe, gerenciar acessos e senhas']] : []),
    ['#/maquinas', 'qr', 'Máquinas e etiquetas QR', 'Cadastro e impressão de QR'],
    ['#/avisos', 'bell', 'Central de avisos', `${state.notifs?.length || 0} avisos registrados`],
    ['#/sync', 'cloud', 'Sincronização offline', `${pendingOps().length} pendente(s) • ${failedOps().length} com falha`],
    ['chpass', 'key', 'Alterar Minha Senha', 'Trocar senha da conta atual'],
    ['logout', 'logOut', 'Sair da Conta (Logout)', `Conectado como ${me()?.name} (${ROLE[me()?.role] || me()?.role})`],
  ];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Mais Opções</h1>
        <p>${esc(me()?.name)} • ${roleBadge(me()?.role)}</p>
      </div>
    </div>
    <section class="card menu-list" style="padding:6px">
      ${items.map(([h, ic, t, s]) => `
        <button class="menu-item ${h === 'logout' ? 'menu-logout' : ''}" data-go="${h}" id="menu-${ic}">
          <span class="ico">${icon(ic, 19)}</span>
          <span class="grow">
            <strong>${t}</strong>
            <div class="muted xs">${esc(s)}</div>
          </span>
          <span class="chev">${icon('chev', 18)}</span>
        </button>`).join('')}
    </section>
  `;

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    if (b.dataset.go === 'chpass') {
      changePasswordModal();
    } else if (b.dataset.go === 'logout') {
      confirmDialog({
        title: 'Sair do sistema?',
        body: 'Deseja encerrar sua sessão atual na Nova OS?',
        confirm: 'Sair',
        danger: true
      }).then((ok) => {
        if (ok) {
          logout();
          toast('Sessão encerrada com sucesso');
          location.hash = '#/';
        }
      });
    } else {
      go(b.dataset.go);
    }
  });
}

export function machinesView(root) {
  const boot = state.boot;
  root.innerHTML = `
    <div class="page-head"><div><h1>Máquinas e QR</h1><p>${boot.machines.length} máquinas • ${boot.sectors.length} setores</p></div>
      <button class="btn sm no-print" id="btn-print">${icon('print', 16)} Imprimir</button></div>
    <p class="muted small no-print">O QR da máquina abre o chamado já preenchido. O QR do setor pede a escolha da máquina. Leitura também funciona pela câmera nativa do celular.</p>
    ${boot.sectors.map((s) => `
      <div class="section-title"><span>${esc(s.name)}</span></div>
      <div class="qr-grid">
        <div class="qr-card" style="border-color:hsl(36 100% 56% / 0.4)"><div class="qr"><img src="/api/qr/${encodeURIComponent(s.code)}.svg" alt="QR do setor ${esc(s.name)}" loading="lazy" /></div>
          <strong>${esc(s.code)}</strong><div class="muted xs">Setor ${esc(s.name)}</div></div>
        ${boot.machines.filter((m) => m.sector_id === s.id).map((m) => `
        <div class="qr-card" data-qr="${esc(m.code)}" style="cursor:pointer"><div class="qr"><img src="/api/qr/${encodeURIComponent(m.code)}.svg" alt="QR ${esc(m.name)}" loading="lazy" /></div>
          <strong>${esc(m.code)}</strong><div class="muted xs"><span class="crit crit-${m.criticality}"></span>${esc(m.name)}</div></div>`).join('')}
      </div>`).join('')}`;
  $('#btn-print', root).onclick = () => window.print();
  $$('[data-qr]', root).forEach((c) => (c.onclick = () => go(`#/nova?qr=${encodeURIComponent(c.dataset.qr)}`)));
}

export function notifsView(root) {
  function render() {
    const list = state.notifs;
    root.innerHTML = `
      <div class="page-head"><div><h1>Avisos</h1><p>${state.unread} não lido(s)</p></div>
        ${state.unread ? '<button class="btn sm" id="btn-read-all">Marcar todos como lidos</button>' : ''}</div>
      ${list.length ? list.map((n) => `
        <div class="notif ${n.read_at ? '' : 'unread'} k-${n.kind} ${/PARADA/.test(n.title) ? 'stop' : ''}" data-n="${n.id}" data-wo="${n.wo_id || ''}">
          <div class="ico">${icon(n.kind === 'conclusao' ? 'check' : n.kind === 'preventiva' ? 'calendar' : n.kind === 'atraso' || /PARADA/.test(n.title) ? 'alert' : 'bell', 18)}</div>
          <div class="grow"><strong class="small">${esc(n.title)}</strong><div class="muted small">${esc(n.body)}</div><div class="muted xs">${timeAgo(n.created_at)} • canal: ${esc(n.channel)} • ${esc(n.status)}</div></div>
          ${n.read_at ? '' : '<span class="unread-dot"></span>'}
        </div>`).join('') : `<div class="empty"><div class="ico">${icon('bell', 28)}</div><strong>Sem avisos</strong></div>`}`;
    $('#btn-read-all', root)?.addEventListener('click', () => markRead().catch((e) => toast(esc(e.message), 'err')));
    $$('[data-n]', root).forEach((el) => (el.onclick = () => {
      markRead([el.dataset.n]).catch(() => {});
      if (el.dataset.wo) go(`#/os/${el.dataset.wo}`);
    }));
  }
  render();
  return on((w) => w === 'notifs' && render());
}

export function syncView(root) {
  let conflicts = [];
  async function loadConflicts() {
    try { conflicts = (await api('/api/conflicts')).conflicts; } catch {}
    render();
  }
  const TYPE = { create_wo: 'Abrir OS', assume: 'Assumir', join: 'Participar', start: 'Iniciar/retomar', pause: 'Pausar', finish_part: 'Encerrar parte', complete: 'Concluir',
    cancel: 'Cancelar', reopen: 'Reabrir', transfer: 'Transferir', attach: 'Foto', update_checklist: 'Checklist', correct_interval: 'Correção de tempo' };
  const woNum = (id) => { const w = workOrders().find((x) => x.id === id); return w ? (w.number ? `OS ${w.number}` : 'OS nova') : 'OS'; };
  function render() {
    const pend = pendingOps(), fail = failedOps();
    root.innerHTML = `
      <div class="page-head"><div><h1>Sincronização</h1><p>${state.online ? 'Conectado' : 'Sem conexão'} • última: ${state.lastSync ? fmtDateTime(state.lastSync) : 'nunca'}</p></div>
        <button class="btn primary sm" id="btn-sync-now" ${state.syncing ? 'disabled' : ''}>${icon('refresh', 16)} Sincronizar</button></div>
      <div class="info-box small">Os registros ficam numa fila no aparelho com ID único e horário local. O envio é repetido ao reconectar ou pelo botão; repetir não duplica OS nem tempos.</div>

      <div class="section-title"><span>Pendentes de envio</span><span class="badge pending">${pend.length}</span></div>
      ${pend.length ? `<section class="card tight">${pend.map((o) => `
        <div class="part-row small"><div class="grow"><strong>${TYPE[o.type] || o.type}</strong> • ${woNum(o.woId)}<div class="muted xs">${esc(userName(o.userId))} • ${fmtDateTime(o.localTime)}${o.attempts ? ` • ${o.attempts} tentativa(s): ${esc(o.lastError || '')}` : ''}</div></div>
        ${o.type === 'attach' ? `<span class="muted xs">${Math.round((o.payload.dataUrl?.length || 0) / 1365)} KB</span>` : ''}</div>`).join('')}</section>` : '<p class="muted small">Nada pendente. ✓</p>'}

      <div class="section-title"><span>Não aceitos pelo servidor</span><span class="badge late">${fail.length}</span></div>
      ${fail.length ? fail.map((o) => `
        <div class="card tight"><div class="row"><div class="grow small"><strong>${TYPE[o.type] || o.type}</strong> • ${woNum(o.woId)}<div class="muted xs">${fmtDateTime(o.localTime)}</div>
          <div style="color:var(--danger);margin-top:4px">${esc(o.message || 'Rejeitado')}</div></div></div>
          <div class="row" style="margin-top:10px"><button class="btn sm" data-retry="${o.opId}">Reenviar</button><button class="btn ghost sm" data-discard="${o.opId}">Descartar</button></div></div>`).join('') : '<p class="muted small">Nenhuma falha.</p>'}

      <div class="section-title"><span>Conflitos registrados no servidor</span><span class="muted xs">${isManager() ? 'revisão do gerente' : 'seus registros'}</span></div>
      ${conflicts.length ? conflicts.map((c) => `
        <div class="card tight ${c.resolved_at ? '' : ''}" style="${c.resolved_at ? 'opacity:.6' : 'border-color:hsl(355 90% 62% / 0.4)'}">
          <div class="small"><strong>${TYPE[c.type] || c.type}</strong> • ${c.number ? `<a href="#/os/${c.wo_id}">OS ${c.number}</a>` : 'OS'} • ${esc(c.user_name || '')}
          <div class="muted xs">Evento: ${fmtDateTime(c.payload?.localTime)} • recebido ${fmtDateTime(c.created_at)}</div>
          <div style="margin-top:4px">${esc(c.reason)}</div>
          ${c.payload?.payload?.serviceDone ? `<div class="muted xs" style="margin-top:4px">Serviço informado: “${esc(c.payload.payload.serviceDone)}”</div>` : ''}
          ${c.resolved_at ? `<div class="xs" style="color:var(--ok);margin-top:4px">Resolvido: ${esc(c.resolution)}</div>` : ''}</div>
          ${!c.resolved_at && isManager() ? `<button class="btn sm" style="margin-top:8px" data-resolve="${c.id}">Registrar resolução</button>` : ''}
        </div>`).join('') : '<p class="muted small">Nenhum conflito.</p>'}`;
    $('#btn-sync-now', root).onclick = async () => {
      const r = await sync();
      if (r.network) toast('Sem conexão — tentaremos de novo automaticamente', 'warn');
      else toast(r.failed.length ? `${r.failed.length} registro(s) não aceito(s)` : 'Tudo sincronizado', r.failed.length ? 'err' : 'ok');
      loadConflicts();
    };
    $$('[data-retry]', root).forEach((b) => (b.onclick = () => retryOp(b.dataset.retry).then(loadConflicts)));
    $$('[data-discard]', root).forEach((b) => (b.onclick = async () => {
      if (await confirmDialog({ title: 'Descartar registro?', body: 'O registro local será removido do aparelho. No servidor, rejeições ficam guardadas para revisão.', confirm: 'Descartar', danger: true })) discardOp(b.dataset.discard);
    }));
    $$('[data-resolve]', root).forEach((b) => (b.onclick = async () => {
      const r = await askReason({ title: 'Resolução do conflito', confirm: 'Salvar', suggestions: ['Registro mantido como está', 'Tempo corrigido manualmente', 'OS reaberta para complementar'] });
      if (r) { await api(`/api/conflicts/${b.dataset.resolve}/resolve`, { method: 'POST', body: { resolution: r.reason } }); loadConflicts(); }
    }));
  }
  render();
  loadConflicts();
  return on((w) => ['queue', 'sync', 'online'].includes(w) && render());
}

export function configView(root) {
  function render() {
    const mode = state.boot.settings.defaultRecipientsMode;
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    root.innerHTML = `
      <div class="page-head"><div><h1>Configurações</h1></div></div>
      <section class="card">
        <strong>Aparência do aplicativo</strong>
        <p class="muted small">Alterne entre o tema claro clean e o tema escuro industrial.</p>
        <div class="segmented" id="seg-theme" style="margin-top:10px">
          <button data-th="light" class="${currentTheme === 'light' ? 'active' : ''}">${icon('sun', 16)} Claro</button>
          <button data-th="dark" class="${currentTheme === 'dark' ? 'active' : ''}">${icon('moon', 16)} Escuro</button>
        </div>
      </section>
      <section class="card">
        <strong>Avisos no aparelho</strong>
        <p class="muted small">Mostra alerta do sistema enquanto o app está aberto. Push com app fechado depende da plataforma (fora do escopo desta versão).</p>
        <button class="btn sm" id="btn-perm" ${perm === 'granted' || perm === 'unsupported' ? 'disabled' : ''}>${perm === 'granted' ? 'Ativado ✓' : perm === 'unsupported' ? 'Não suportado' : 'Ativar avisos'}</button>
      </section>
      ${isManager() ? `
      <section class="card">
        <strong>Destinatários padrão de novas OS</strong>
        <p class="muted small">Pode ser trocado em cada OS no momento da abertura.</p>
        <div class="segmented" id="seg-def">${['todos', 'equipe', 'selecionados'].map((m) => `<button data-value="${m}" class="${mode === m ? 'active' : ''}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>
      </section>
      <section class="card">
        <strong>Dados de demonstração</strong>
        <p class="muted small">Apaga OS, planos e avisos do servidor e recria os dados fictícios.</p>
        <button class="btn danger sm" id="btn-reset">Restaurar dados de demonstração</button>
      </section>` : '<div class="info-box small" style="margin-top:12px">Demais configurações são exclusivas do gerente de manutenção.</div>'}`;
    $$('#seg-theme button', root).forEach((b) => (b.onclick = () => {
      const th = b.dataset.th;
      document.documentElement.setAttribute('data-theme', th);
      localStorage.setItem('nova-os:theme', th);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', th === 'dark' ? '#0b0f17' : '#ffffff');
      const btn = document.querySelector('#btn-theme');
      if (btn) {
        btn.innerHTML = icon(th === 'dark' ? 'sun' : 'moon', 18);
        btn.title = th === 'dark' ? 'Alternar para tema claro' : 'Alternar para tema escuro';
      }
      toast(`Tema ${th === 'dark' ? 'escuro' : 'claro'} ativado`);
      render();
    }));
    $('#btn-perm', root).onclick = async () => { await Notification.requestPermission(); render(); };
    $$('#seg-def button', root).forEach((b) => (b.onclick = async () => {
      try { await api('/api/settings', { method: 'PUT', body: { defaultRecipientsMode: b.dataset.value } }); await loadBoot(); render(); toast('Padrão atualizado'); } catch (e) { toast(esc(e.message), 'err'); }
    }));
    $('#btn-reset', root)?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Restaurar demonstração?', body: 'Todos os registros de teste serão apagados.', confirm: 'Restaurar', danger: true }))) return;
      try { await api('/api/admin/reset', { method: 'POST' }); await loadBoot(); await sync(); toast('Dados restaurados'); } catch (e) { toast(esc(e.message), 'err'); }
    });
  }
  render();
}

// ======================================================================
// TELA DE LOGIN
// ======================================================================
export function loginView(root) {
  root.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-brand">
          <div class="login-logo">${icon('wrench', 30)}</div>
          <h1>Nova OS</h1>
          <p>Móveis Rufato • Sistema de Manutenção</p>
        </div>

        <form class="login-form" id="form-login">
          <div class="login-field">
            <label for="login-input">Usuário ou E-mail</label>
            <div class="input-wrap">
              <span class="input-ico">${icon('user', 18)}</span>
              <input class="input" id="login-input" type="text" placeholder="Ex: moisestj86@gmail.com ou reinilson" required autofocus autocomplete="username" />
            </div>
          </div>

          <div class="login-field">
            <label for="pass-input">Senha de Acesso</label>
            <div class="input-wrap">
              <span class="input-ico">${icon('lock', 18)}</span>
              <input class="input" id="pass-input" type="password" placeholder="Digite sua senha" required autocomplete="current-password" />
              <button type="button" class="toggle-pass" id="btn-toggle-pass" aria-label="Mostrar ou ocultar senha">${icon('eye', 18)}</button>
            </div>
          </div>

          <button type="submit" class="btn-login" id="btn-submit-login">
            <span>Entrar no Sistema</span> ${icon('chev', 18)}
          </button>
        </form>
      </div>
    </div>
  `;

  const form = $('#form-login', root);
  const loginInp = $('#login-input', root);
  const passInp = $('#pass-input', root);
  const toggleBtn = $('#btn-toggle-pass', root);
  const submitBtn = $('#btn-submit-login', root);

  toggleBtn.onclick = () => {
    const isPass = passInp.type === 'password';
    passInp.type = isPass ? 'text' : 'password';
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const u = loginInp.value.trim();
    const p = passInp.value;
    if (!u || !p) return;

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Verificando...</span>';

    try {
      const user = await login(u, p);
      toast(`Bem-vindo(a), ${user.name}!`);
      if (location.hash === '#/' || !location.hash) {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } else {
        go('#/');
      }
    } catch (err) {
      toast(err.message || 'Falha no login', 'alarm');
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<span>Entrar no Sistema</span> ${icon('chev', 18)}`;
      passInp.focus();
    }
  };
}

// ======================================================================
// GESTÃO DE USUÁRIOS E MANUTENTORES (ADMIN / SUPER ADMIN)
// ======================================================================
export function usersView(root) {
  if (!isAdmin()) {
    toast('Acesso restrito para administradores', 'warn');
    go('#/');
    return;
  }

  let users = [];
  let filterRole = 'todos';
  let q = '';

  async function load() {
    try {
      users = await fetchUsers();
      render();
    } catch (err) {
      root.innerHTML = `<div class="error-box">Erro ao carregar usuários: ${esc(err.message)}</div>`;
    }
  }

  function canDelete(u) {
    if (!u || u.id === me()?.id) return false;
    if (u.role === 'superadmin') return false;
    if (!isAdmin()) return false;
    if (me()?.role === 'admin' && (u.role === 'admin' || u.role === 'superadmin')) return false;
    return true;
  }

  async function executeDelete(u) {
    const ok = await confirmDialog({
      title: 'Excluir usuário permanentemente?',
      body: `Deseja realmente excluir "${u.name}" (${ROLE[u.role] || u.role})? O acesso será cancelado e o usuário removido do sistema.`,
      confirm: 'Sim, Excluir',
      danger: true
    });
    if (!ok) return;

    try {
      await deleteUser(u.id);
      toast(`Usuário "${u.name}" excluído com sucesso!`);
      await loadBoot();
      load();
    } catch (err) {
      toast(err.message || 'Erro ao excluir usuário', 'alarm');
    }
  }

  function render() {
    const canCreateAny = isSuperAdmin();
    const techs = users.filter((u) => u.role === 'manutentor');
    const admins = users.filter((u) => u.role === 'admin' || u.role === 'superadmin');
    const sols = users.filter((u) => u.role === 'solicitante');

    const filtered = users.filter((u) => {
      if (filterRole !== 'todos' && u.role !== filterRole) return false;
      if (!q) return true;
      const ql = q.toLowerCase();
      return (
        u.name.toLowerCase().includes(ql) ||
        (u.username || '').toLowerCase().includes(ql) ||
        (u.email || '').toLowerCase().includes(ql) ||
        (u.specialty || '').toLowerCase().includes(ql)
      );
    });

    root.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${isSuperAdmin() ? 'Usuários do Sistema' : 'Gestão de Manutentores'}</h1>
          <p>${techs.length} manutentores • ${admins.length} administradores • ${sols.length} solicitantes</p>
        </div>
        <button class="btn primary sm" id="btn-new-user">
          ${icon('userPlus', 16)} ${isSuperAdmin() ? 'Novo Usuário' : 'Novo Manutentor'}
        </button>
      </div>

      <div class="input-group" style="margin-bottom:12px">
        <input class="input" id="search-users" type="search" placeholder="Buscar por nome, usuário ou especialidade..." value="${esc(q)}" />
      </div>

      <div class="chips" style="margin-bottom:14px">
        <button class="chip ${filterRole === 'todos' ? 'active' : ''}" data-role="todos">Todos (${users.length})</button>
        <button class="chip ${filterRole === 'manutentor' ? 'active' : ''}" data-role="manutentor">Manutentores (${techs.length})</button>
        <button class="chip ${filterRole === 'admin' ? 'active' : ''}" data-role="admin">Admins (${admins.length})</button>
        <button class="chip ${filterRole === 'solicitante' ? 'active' : ''}" data-role="solicitante">Solicitantes (${sols.length})</button>
      </div>

      <div id="users-list">
        ${filtered.length ? filtered.map((u) => `
          <div class="user-card-item ${u.active ? '' : 'inactive'}" data-uid="${u.id}">
            ${avatar(u.name)}
            <div class="grow" style="min-width:0">
              <div class="row wrap" style="gap:6px;align-items:center">
                <strong style="font-size:15px">${esc(u.name)}</strong>
                ${roleBadge(u.role)}
                ${u.active ? '' : '<span class="badge" style="background:var(--danger-soft);color:var(--danger)">Inativo</span>'}
              </div>
              <div class="muted small" style="margin-top:2px">
                <span class="mono">${esc(u.username || u.email || 'sem login')}</span>
                ${u.specialty ? ` • ${esc(u.specialty)}` : ''}
                ${u.team_name ? ` • ${esc(u.team_name)}` : ''}
              </div>
            </div>
            <div class="row" style="gap:4px">
              <button class="icon-btn" data-edit="${u.id}" title="Editar ou trocar senha">${icon('wrench', 16)}</button>
              ${canDelete(u) ? `
                <button class="icon-btn danger" data-del="${u.id}" title="Excluir usuário" style="color:var(--danger)">
                  ${icon('trash', 16)}
                </button>
              ` : ''}
            </div>
          </div>
        `).join('') : '<div class="empty"><p class="muted">Nenhum usuário encontrado com esse filtro.</p></div>'}
      </div>
    `;

    $('#search-users', root).oninput = (e) => {
      q = e.target.value;
      render();
    };

    $$('[data-role]', root).forEach((chip) => {
      chip.onclick = () => {
        filterRole = chip.dataset.role;
        render();
      };
    });

    $('#btn-new-user', root).onclick = () => openUserModal();

    $$('[data-edit]', root).forEach((btn) => {
      btn.onclick = () => {
        const u = users.find((x) => x.id === btn.dataset.edit);
        if (u) openUserModal(u);
      };
    });

    $$('[data-del]', root).forEach((btn) => {
      btn.onclick = () => {
        const u = users.find((x) => x.id === btn.dataset.del);
        if (u) executeDelete(u);
      };
    });
  }

  function openUserModal(target = null) {
    const isEdit = !!target;
    const canChooseRole = isSuperAdmin();
    const allowDeleteTarget = isEdit && canDelete(target);

    sheet(`
      <h2>${isEdit ? 'Editar Usuário' : (canChooseRole ? 'Cadastrar Novo Usuário' : 'Cadastrar Novo Manutentor')}</h2>
      <p class="muted small">${isEdit ? 'Atualize os dados ou defina uma nova senha' : 'Preencha os dados de acesso do colaborador'}</p>

      <form id="form-user-edit" style="margin-top:16px;display:flex;flex-direction:column;gap:12px">
        <label class="field">
          <span>Nome Completo *</span>
          <input class="input" id="u-name" required value="${esc(target?.name || '')}" placeholder="Ex: Carlos Mendes" />
        </label>

        <label class="field">
          <span>Login / Nome de Usuário *</span>
          <input class="input" id="u-username" required ${isEdit ? 'disabled' : ''} value="${esc(target?.username || '')}" placeholder="Ex: carlos" />
        </label>

        <label class="field">
          <span>E-mail</span>
          <input class="input" id="u-email" type="email" value="${esc(target?.email || '')}" placeholder="Ex: carlos@rufato.com.br" />
        </label>

        ${canChooseRole && !isEdit ? `
        <label class="field">
          <span>Nível de Acesso</span>
          <select class="input select" id="u-role">
            <option value="manutentor" selected>Manutentor (Acesso simplificado às suas OS)</option>
            <option value="admin">Admin (Gestão de Manutenção e Manutentores)</option>
            <option value="superadmin">Super Admin (Acesso total)</option>
            <option value="solicitante">Solicitante (Abertura de chamados)</option>
          </select>
        </label>` : ''}

        <label class="field">
          <span>Equipe</span>
          <select class="input select" id="u-team">
            <option value="">Nenhuma equipe</option>
            ${(state.boot?.teams || []).map((t) => `<option value="${t.id}" ${target?.team_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
        </label>

        <label class="field">
          <span>Especialidade</span>
          <input class="input" id="u-spec" value="${esc(target?.specialty || '')}" placeholder="Ex: Mecânico, Eletricista" />
        </label>

        <label class="field">
          <span>${isEdit ? 'Nova Senha (deixe em branco para manter)' : 'Senha de Acesso *'}</span>
          <input class="input" id="u-pass" type="password" ${isEdit ? '' : 'required'} minlength="4" placeholder="${isEdit ? 'Opcional' : 'Mínimo 4 caracteres'}" />
        </label>

        <div class="sheet-actions" style="margin-top:16px;display:flex;align-items:center;justify-content:space-between">
          ${allowDeleteTarget ? `
            <button type="button" class="btn danger" id="btn-modal-del" style="margin-right:auto">
              ${icon('trash', 16)} Excluir Usuário
            </button>
          ` : '<div></div>'}
          <div class="row" style="gap:8px">
            <button type="button" class="btn" data-close>Cancelar</button>
            <button type="submit" class="btn primary">${isEdit ? 'Salvar Alterações' : 'Cadastrar'}</button>
          </div>
        </div>
      </form>
    `, {
      onMount(el, modal) {
        if (allowDeleteTarget) {
          $('#btn-modal-del', el)?.addEventListener('click', async () => {
            modal.close();
            await executeDelete(target);
          });
        }

        $('#form-user-edit', el).onsubmit = async (e) => {
          e.preventDefault();
          const name = $('#u-name', el).value.trim();
          const username = $('#u-username', el).value.trim();
          const email = $('#u-email', el).value.trim();
          const teamId = $('#u-team', el).value || null;
          const specialty = $('#u-spec', el).value.trim() || null;
          const password = $('#u-pass', el).value.trim();
          const role = $('#u-role', el)?.value || (target?.role || 'manutentor');

          try {
            if (isEdit) {
              await updateUser(target.id, { name, email, teamId, specialty, password: password || undefined });
              toast('Usuário atualizado com sucesso!');
            } else {
              await createUser({ name, username, email, role, teamId, specialty, password });
              toast('Novo colaborador cadastrado com sucesso!');
            }
            modal.close();
            await loadBoot();
            load();
          } catch (err) {
            toast(err.message || 'Erro ao salvar usuário', 'alarm');
          }
        };
      }
    });
  }

  load();
}

// ======================================================================
// MODAL DE ALTERAÇÃO DE SENHA
// ======================================================================
export function changePasswordModal() {
  sheet(`
    <h2>Alterar Minha Senha</h2>
    <p class="muted small">Digite sua senha atual e a nova senha desejada.</p>
    <form id="form-chpass" style="margin-top:14px;display:flex;flex-direction:column;gap:12px">
      <label class="field">
        <span>Senha Atual</span>
        <input class="input" id="ch-curr" type="password" required placeholder="Sua senha atual" />
      </label>
      <label class="field">
        <span>Nova Senha</span>
        <input class="input" id="ch-new" type="password" required minlength="4" placeholder="Mínimo 4 caracteres" />
      </label>
      <div class="sheet-actions" style="margin-top:14px">
        <button type="button" class="btn" data-close>Cancelar</button>
        <button type="submit" class="btn primary">Alterar Senha</button>
      </div>
    </form>
  `, {
    onMount(el, modal) {
      $('#form-chpass', el).onsubmit = async (e) => {
        e.preventDefault();
        const curr = $('#ch-curr', el).value;
        const npass = $('#ch-new', el).value;
        try {
          await changePassword(curr, npass);
          modal.close();
          toast('Senha alterada com sucesso!');
        } catch (err) {
          toast(err.message || 'Erro ao alterar senha', 'alarm');
        }
      };
    }
  });
}
