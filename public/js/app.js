// Orquestrador do aplicativo Nova OS
// Roteador por hash, controle de autenticação e permissões, atualização de relógios em tempo real
import { state, init, on, sync, pendingOps, failedOps, resetNotifTracking, logout } from './store.js';
import { $, $$, sheet, avatar, esc, icon, toast, clock, ROLE, roleBadge } from './ui.js';
import {
  listView, detailView, newView, plansView, kpiView, moreView, machinesView, notifsView, syncView, configView,
  loginView, usersView, cadastrosView, changePasswordModal
} from './views.js';

let currentCleanup = null;
let deferredInstallPrompt = null;

// ======================================================================
// ROTEADOR
// ======================================================================
function parseHash() {
  const hash = location.hash.slice(1) || '/';
  const [path, queryStr] = hash.split('?');
  const params = Object.fromEntries(new URLSearchParams(queryStr || ''));
  return { path, params };
}

function router() {
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }

  const { path, params } = parseHash();
  const root = $('#view');
  window.scrollTo(0, 0);

  // Se não autenticado, força login
  if (!state.user) {
    renderNav();
    updateHeader();
    currentCleanup = loginView(root);
    return;
  }

  // Se já autenticado e navega para /login, redireciona para home
  if (path === '/login') {
    location.hash = '#/';
    return;
  }

  // Renderiza a navegação de acordo com o papel do usuário
  renderNav();
  updateNav(path);
  updateHeader();

  const role = state.user.role;
  const isStaff = role === 'admin' || role === 'superadmin';

  // Bloqueio de rotas administrativas para telas simplificadas (manutentor e solicitante)
  if (!isStaff) {
    if (['/indicadores', '/config', '/usuarios', '/preventivas', '/maquinas', '/cadastros'].includes(path)) {
      toast('Recurso restrito à gestão de manutenção', 'warn');
      location.hash = '#/';
      return;
    }
    if (path === '/mais') {
      showUserProfile();
      location.hash = '#/';
      return;
    }
  }

  // Rotas
  if (path === '/' || path === '') {
    currentCleanup = listView(root, params);
  } else if (path.startsWith('/os/')) {
    const id = path.slice(4);
    currentCleanup = detailView(root, { id });
  } else if (path === '/nova') {
    currentCleanup = newView(root, params);
  } else if (path === '/cadastros') {
    currentCleanup = cadastrosView(root, params);
  } else if (path === '/usuarios') {
    currentCleanup = cadastrosView(root, { ...params, tab: 'usuarios' });
  } else if (path === '/maquinas') {
    currentCleanup = cadastrosView(root, { ...params, tab: 'maquinas' });
  } else if (path === '/preventivas') {
    currentCleanup = plansView(root);
  } else if (path === '/indicadores') {
    currentCleanup = kpiView(root);
  } else if (path === '/mais') {
    currentCleanup = moreView(root);
  } else if (path === '/avisos') {
    currentCleanup = notifsView(root);
  } else if (path === '/sync') {
    currentCleanup = syncView(root);
  } else if (path === '/config') {
    currentCleanup = configView(root);
  } else {
    location.hash = '#/';
  }
}

// ======================================================================
// NAVEGAÇÃO ADAPTATIVA POR NÍVEL DE ACESSO
// ======================================================================
function renderNav() {
  const nav = $('.bottom-nav');
  if (!nav) return;

  if (!state.user) {
    nav.classList.add('hidden');
    nav.style.display = 'none';
    return;
  }

  nav.classList.remove('hidden');
  nav.style.display = '';

  const role = state.user.role;
  let html = '';

  if (role === 'manutentor') {
    // Manutentor: visual ultra-simplificado para o chão de fábrica (SEM indicadores e SEM configurações)
    html = `
      <button class="nav-item" data-nav="#/" id="nav-os">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>
        Minhas OS
      </button>
      <button class="nav-item" data-nav="#/?scope=disponiveis" id="nav-disp">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/></svg>
        Disponíveis
      </button>
      <button class="nav-fab" data-nav="#/nova" id="nav-new" aria-label="Abrir nova OS">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button class="nav-item" data-action="profile" id="nav-profile">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
        Meu Perfil
      </button>
    `;
  } else if (role === 'solicitante') {
    // Solicitante: apenas abertura e acompanhamento dos seus chamados
    html = `
      <button class="nav-item" data-nav="#/" id="nav-os">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>
        Meus Chamados
      </button>
      <button class="nav-fab" data-nav="#/nova" id="nav-new" aria-label="Abrir chamado">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button class="nav-item" data-action="profile" id="nav-profile">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
        Meu Perfil
      </button>
    `;
  } else {
    // Admin e Super Admin: visão completa com cadastros unificados e indicadores
    html = `
      <button class="nav-item" data-nav="#/" id="nav-os">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>
        Ordens
      </button>
      <button class="nav-item" data-nav="#/cadastros" id="nav-cad">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/><path d="M19 11v6M22 14h-6"/></svg>
        Cadastros
      </button>
      <button class="nav-fab" data-nav="#/nova" id="nav-new" aria-label="Abrir nova OS">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button class="nav-item" data-nav="#/indicadores" id="nav-kpi">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>
        Indicadores
      </button>
      <button class="nav-item" data-nav="#/mais" id="nav-more">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
        Mais
      </button>
    `;
  }
  nav.innerHTML = html;

  $$('.nav-item, .nav-fab', nav).forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.action === 'profile') {
        showUserProfile();
        return;
      }
      const target = btn.dataset.nav;
      if (target) location.hash = target;
    };
  });
}

function updateNav(path) {
  const fullHash = location.hash.slice(1) || '/';
  $$('.nav-item').forEach((item) => {
    const navNav = item.dataset.nav?.replace('#', '') || '';
    let isActive = false;
    if (navNav === '/' || navNav === '') {
      isActive = (fullHash === '/' || fullHash.startsWith('/os/'));
    } else if (navNav.includes('?')) {
      isActive = fullHash === navNav;
    } else {
      isActive = fullHash.startsWith(navNav);
    }
    item.classList.toggle('active', !!isActive);
  });
}

// ======================================================================
// MODAL / SHEET DO PERFIL DO USUÁRIO
// ======================================================================
function showUserProfile() {
  if (!state.user) {
    location.hash = '#/login';
    return;
  }
  const u = state.user;
  sheet(`
    <div style="text-align:center;padding:12px 0 8px">
      <div style="display:inline-block;margin-bottom:10px">${avatar(u.name, 64, u.avatar_url)}</div>
      <h2 style="margin:0 0 4px;font-size:20px">${esc(u.name)}</h2>
      <div class="muted small" style="margin-bottom:8px">${esc(u.email || u.username || '')}</div>
      <div style="margin-bottom:6px">${roleBadge(u.role)}</div>
      ${u.specialty ? `<div class="muted xs">${esc(u.specialty)}</div>` : ''}
    </div>

    <div class="profile-actions" style="display:flex;flex-direction:column;gap:8px;margin-top:16px">
      <button class="btn" id="btn-prof-install" style="justify-content:flex-start">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span class="grow" style="text-align:left">Instalar no Celular / Computador</span>
      </button>

      <button class="btn" id="btn-prof-chpass" style="justify-content:flex-start">
        ${icon('key', 18)} <span class="grow" style="text-align:left">Alterar Minha Senha</span>
      </button>

      ${(u.role === 'admin' || u.role === 'superadmin') ? `
      <button class="btn" id="btn-prof-cadastros" style="justify-content:flex-start">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/><path d="M19 11v6M22 14h-6"/></svg>
        <span class="grow" style="text-align:left">Central de Cadastros (Máquinas, Setores, Equipe)</span>
      </button>
      ` : ''}

      <button class="btn danger" id="btn-prof-logout" style="justify-content:flex-start;margin-top:8px">
        ${icon('logOut', 18)} <span class="grow" style="text-align:left">Sair da Conta (Logout)</span>
      </button>
    </div>
  `, {
    onMount(el, modal) {
      $('#btn-prof-install', el)?.addEventListener('click', () => {
        modal.close();
        openInstallModal();
      });
      $('#btn-prof-chpass', el)?.addEventListener('click', () => {
        modal.close();
        changePasswordModal();
      });
      $('#btn-prof-cadastros', el)?.addEventListener('click', () => {
        modal.close();
        location.hash = '#/cadastros';
      });
      $('#btn-prof-logout', el)?.addEventListener('click', async () => {
        modal.close();
        await logout();
        toast('Você saiu do sistema');
        renderNav();
        updateHeader();
        router();
      });
    }
  });
}

// ======================================================================
// GESTÃO DE TEMA CLARO / ESCURO
// ======================================================================
function getTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('nova-os:theme', theme);
  updateThemeUI();
  const meta = $('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', theme === 'dark' ? '#0b0f17' : '#ffffff');
  }
}

function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  toast(`Tema ${next === 'dark' ? 'escuro' : 'claro'} ativado`);
}

function updateThemeUI() {
  const current = getTheme();
  const btn = $('#btn-theme');
  if (btn) {
    btn.innerHTML = icon(current === 'dark' ? 'sun' : 'moon', 18);
    btn.title = current === 'dark' ? 'Alternar para tema claro' : 'Alternar para tema escuro';
    btn.setAttribute('aria-label', btn.title);
  }
}

// ======================================================================
// CABEÇALHO E ATUALIZAÇÕES GLOBAIS
// ======================================================================
function updateHeader() {
  updateThemeUI();
  const av = $('#user-avatar');
  const syncPill = $('#sync-pill');
  const notifBtn = $('#btn-notifs');

  if (state.user) {
    av.textContent = state.user.name.slice(0, 2).toUpperCase();
    av.title = `${state.user.name} (${ROLE[state.user.role] || state.user.role})`;
    if (syncPill) syncPill.style.display = '';
    if (notifBtn) notifBtn.style.display = '';
  } else {
    av.innerHTML = icon('user', 18);
    av.title = 'Fazer Login';
    if (syncPill) syncPill.style.display = 'none';
    if (notifBtn) notifBtn.style.display = 'none';
  }

  // Pílula de sincronização
  if (state.user && syncPill) {
    const label = $('#sync-label');
    const pend = pendingOps().length;
    const fail = failedOps().length;

    syncPill.classList.remove('offline', 'pending', 'syncing');
    if (!state.online) {
      syncPill.classList.add('offline');
      if (label) label.textContent = pend ? `Offline (${pend})` : 'Offline';
    } else if (state.syncing) {
      syncPill.classList.add('syncing');
      if (label) label.textContent = 'Enviando…';
    } else if (fail > 0) {
      syncPill.classList.add('offline');
      if (label) label.textContent = `Falha (${fail})`;
    } else if (pend > 0) {
      syncPill.classList.add('pending');
      if (label) label.textContent = `Pendente (${pend})`;
    } else {
      if (label) label.textContent = 'Online';
    }

    // Notificações
    const nBadge = $('#notif-count');
    if (nBadge) {
      if (state.unread > 0) {
        nBadge.textContent = state.unread > 99 ? '99+' : state.unread;
        nBadge.classList.remove('hidden');
      } else {
        nBadge.classList.add('hidden');
      }
    }
  }

  // Banner offline
  const offBanner = $('#offline-banner');
  if (offBanner) offBanner.classList.toggle('hidden', state.online);
}

// ======================================================================
// ÁUDIO E ALERTAS SONOROS (WEB AUDIO API - 100% OFFLINE)
// ======================================================================
let audioCtx = null;
function playAlertChime(kind = 'normal') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioCtx) audioCtx = new AudioCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);

    if (kind === 'urgent') {
      // Tom direto duplo de alerta (atribuído a você ou máquina parada)
      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(880, now); // A5
      osc1.frequency.exponentialRampToValueAtTime(1174.66, now + 0.15); // D6
      gain1.gain.setValueAtTime(0.3, now);
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.45);
      osc1.start(now);
      osc1.stop(now + 0.45);

      const osc2 = audioCtx.createOscillator();
      const gain2 = audioCtx.createGain();
      osc2.connect(gain2);
      gain2.connect(audioCtx.destination);
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(1174.66, now + 0.18);
      osc2.frequency.exponentialRampToValueAtTime(1760, now + 0.35); // A6
      gain2.gain.setValueAtTime(0.35, now + 0.18);
      gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.6);
      osc2.start(now + 0.18);
      osc2.stop(now + 0.6);
    } else {
      // Chime suave e claro para chamada geral da fábrica
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.18); // A5
      gain1.gain.setValueAtTime(0.25, now);
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
      osc1.start(now);
      osc1.stop(now + 0.5);
    }
  } catch (e) {
    // Silencia se o navegador bloquear autoplay de áudio antes de interação
  }
}

// ======================================================================
// INSTALAÇÃO DO APP NO CELULAR / PWA
// ======================================================================
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updateInstallButton();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  toast('Nova OS instalado com sucesso na sua tela inicial!', 'ok');
  updateInstallButton();
});

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function updateInstallButton() {
  const btn = $('#btn-install');
  if (!btn) return;
  if (isStandalone()) {
    btn.style.display = 'none';
  } else {
    btn.style.display = '';
  }
}

export function openInstallModal() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isStandalone()) {
    return toast('O Nova OS já está instalado como aplicativo!', 'ok');
  }

  sheet(`
    <div style="text-align:center;padding:8px 0 4px">
      <div class="brand-logo" style="width:56px;height:56px;border-radius:16px;margin:0 auto 12px">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg>
      </div>
      <h2 style="font-size:20px;margin-bottom:4px">Instalar Aplicativo no Celular</h2>
      <p class="muted small">Acesse o sistema direto da tela de início, mesmo sem internet no chão de fábrica.</p>
    </div>

    ${isIOS ? `
      <div class="card" style="margin:16px 0;background:var(--surface-2);border-color:var(--border-strong)">
        <div style="font-weight:700;font-size:14px;margin-bottom:10px;color:var(--accent)">
          Como instalar no iPhone / iPad (Safari):
        </div>
        <div class="ios-guide-step">
          <div class="ios-step-num">1</div>
          <div>
            <strong>Toque no botão de Compartilhar</strong>
            <p class="muted xs" style="margin:2px 0 0">Localizado na barra de navegação do Safari (ícone do quadrado com a seta para cima).</p>
          </div>
        </div>
        <div class="ios-guide-step">
          <div class="ios-step-num">2</div>
          <div>
            <strong>Toque em "Adicionar à Tela de Início"</strong>
            <p class="muted xs" style="margin:2px 0 0">Role a lista de opções para baixo e toque no ícone com o sinal (+).</p>
          </div>
        </div>
        <div class="ios-guide-step">
          <div class="ios-step-num">3</div>
          <div>
            <strong>Toque em "Adicionar"</strong>
            <p class="muted xs" style="margin:2px 0 0">No canto superior direito. O aplicativo aparecerá instantaneamente na sua tela inicial!</p>
          </div>
        </div>
      </div>
      <div class="sheet-actions">
        <button class="btn primary block" data-close>Entendido, vou adicionar!</button>
      </div>
    ` : `
      <div class="card tight" style="margin:16px 0;background:var(--surface-2)">
        <div class="row" style="gap:10px;align-items:center;margin-bottom:8px">
          <span style="font-size:20px">🚀</span>
          <span class="small"><strong>Acesso rápido com 1 toque:</strong> abre em tela cheia como app nativo.</span>
        </div>
        <div class="row" style="gap:10px;align-items:center;margin-bottom:8px">
          <span style="font-size:20px">📶</span>
          <span class="small"><strong>Offline no galpão:</strong> consulte ordens e aponte tempos mesmo sem sinal de Wi-Fi.</span>
        </div>
        <div class="row" style="gap:10px;align-items:center">
          <span style="font-size:20px">🔔</span>
          <span class="small"><strong>Alertas sonoros:</strong> seja notificado de chamados direcionados a você.</span>
        </div>
      </div>

      <div class="sheet-actions">
        <button class="btn" data-close>Mais tarde</button>
        <button class="btn primary" id="btn-do-install">
          ${icon('plus', 18)} Instalar Agora
        </button>
      </div>
    `}
  `, {
    onMount(el, modal) {
      $('#btn-do-install', el)?.addEventListener('click', async () => {
        if (deferredInstallPrompt) {
          modal.close();
          deferredInstallPrompt.prompt();
          const { outcome } = await deferredInstallPrompt.userChoice;
          if (outcome === 'accepted') {
            toast('Instalando Nova OS...', 'ok');
          }
          deferredInstallPrompt = null;
        } else {
          modal.close();
          toast('No seu navegador Android/Edge, toque no menu de 3 pontos (⋮) e selecione "Instalar aplicativo" ou "Adicionar à tela inicial".', 'warn', 7000);
        }
      });
    }
  });
}

// Atualiza relógios em tempo real a cada segundo
function startClocks() {
  setInterval(() => {
    $$('[data-clock]').forEach((el) => {
      const since = el.dataset.clock;
      const base = Number(el.dataset.base || 0);
      if (since) {
        el.textContent = clock(since, base);
      }
    });
  }, 1000);
}

// Registra Service Worker para suporte PWA/offline
async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (e) {
      console.warn('Service worker não registrado:', e);
    }
  }
}

// ======================================================================
// INICIALIZAÇÃO
// ======================================================================
async function start() {
  // Listeners de navegação
  window.addEventListener('hashchange', router);

  // Ações do cabeçalho
  $('#sync-pill')?.addEventListener('click', () => { location.hash = '#/sync'; });
  $('#btn-install')?.addEventListener('click', openInstallModal);
  $('#btn-theme')?.addEventListener('click', toggleTheme);
  $('#btn-notifs')?.addEventListener('click', () => { location.hash = '#/avisos'; });
  $('#btn-user')?.addEventListener('click', showUserProfile);

  // Reações do Store e Alertas Inteligentes
  on((ev) => {
    updateHeader();
    updateInstallButton();

    if (ev === 'user') {
      renderNav();
      updateHeader();
      router();
    }

    // Item 3: Sistema inteligente de alertas sonoros e notificações
    if (typeof ev === 'object' && ev?.type === 'new-notifs') {
      for (const n of ev.items) {
        const isStop = /PARADA/i.test(n.title);
        const isDirect = /Atribuída a Você/i.test(n.title) || n.kind === 'atribuicao';

        // Toca o alarme correspondente
        playAlertChime(isDirect || isStop ? 'urgent' : 'normal');

        const toastKind = isStop ? 'alarm' : (isDirect ? 'warn' : 'ok');
        const t = toast(`${n.title}: ${n.body}`, toastKind, 8000);
        if (n.wo_id) {
          t.style.cursor = 'pointer';
          t.title = 'Clique para abrir esta Ordem de Serviço';
          t.onclick = () => {
            location.hash = `#/os/${n.wo_id}`;
          };
        }

        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(n.title, { body: n.body, icon: '/icons/icon.svg' });
        }
      }
    }
  });

  // Inicializa o banco de dados cliente e carrega sessão salva
  await init();

  updateHeader();
  updateInstallButton();
  renderNav();
  router();
  startClocks();
  registerSW();

  // Sincronização periódica a cada 15s para entrega rápida de alertas
  setInterval(() => {
    if (state.user && state.online && !state.syncing) sync();
  }, 15000);

  // Primeira sincronização se logado
  if (state.user && state.online) sync();
}

window.addEventListener('DOMContentLoaded', start);

