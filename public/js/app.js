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
export function getTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

export function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('nova-os:theme', theme);
  updateThemeUI();
  const meta = $('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', theme === 'dark' ? '#0b0f17' : '#ffffff');
  }
}

export function toggleTheme() {
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
  $('#btn-theme')?.addEventListener('click', toggleTheme);
  $('#btn-notifs')?.addEventListener('click', () => { location.hash = '#/avisos'; });
  $('#btn-user')?.addEventListener('click', showUserProfile);

  // Reações do Store
  on((ev) => {
    updateHeader();
    if (ev === 'user') {
      renderNav();
      updateHeader();
      router();
    }
    if (typeof ev === 'object' && ev?.type === 'new-notifs') {
      for (const n of ev.items) {
        const isStop = /PARADA/.test(n.title);
        toast(`${n.title}: ${n.body}`, isStop ? 'alarm' : 'warn', 5000);
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(n.title, { body: n.body, icon: '/icons/icon.svg' });
        }
      }
    }
  });

  // Inicializa o banco de dados cliente e carrega sessão salva
  await init();

  updateHeader();
  renderNav();
  router();
  startClocks();
  registerSW();

  // Sincronização periódica a cada 30s se houver conexão e usuário logado
  setInterval(() => {
    if (state.user && state.online && !state.syncing) sync();
  }, 30000);

  // Primeira sincronização se logado
  if (state.user && state.online) sync();
}

window.addEventListener('DOMContentLoaded', start);
