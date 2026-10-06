// Orquestrador do aplicativo Nova OS
// Roteador por hash, controle de usuário de teste, atualização de relógios em tempo real
import { state, init, on, setUser, sync, pendingOps, failedOps, resetNotifTracking } from './store.js';
import { $, $$, sheet, avatar, esc, icon, toast, clock, ROLE } from './ui.js';
import {
  listView, detailView, newView, plansView, kpiView, moreView, machinesView, notifsView, syncView, configView
} from './views.js';

let currentCleanup = null;

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

  // Atualiza destaque na barra inferior
  updateNav(path);

  // Verificação de usuário antes de telas restritas
  if (!state.user && state.boot) {
    promptUserSelection(true);
    return;
  }

  // Rotas
  if (path === '/' || path === '') {
    currentCleanup = listView(root);
  } else if (path.startsWith('/os/')) {
    const id = path.slice(4);
    currentCleanup = detailView(root, { id });
  } else if (path === '/nova') {
    currentCleanup = newView(root, params);
  } else if (path === '/preventivas') {
    currentCleanup = plansView(root);
  } else if (path === '/indicadores') {
    currentCleanup = kpiView(root);
  } else if (path === '/mais') {
    currentCleanup = moreView(root);
  } else if (path === '/maquinas') {
    currentCleanup = machinesView(root);
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

function updateNav(path) {
  $$('.nav-item').forEach((item) => {
    const navPath = item.dataset.nav?.replace('#', '');
    const isActive = navPath === '/'
      ? (path === '/' || path.startsWith('/os/'))
      : (navPath && path.startsWith(navPath));
    item.classList.toggle('active', !!isActive);
  });
}

// ======================================================================
// SELETOR DE USUÁRIO DE TESTE
// ======================================================================
function promptUserSelection(forced = false) {
  if (!state.boot) return;
  const users = state.boot.users;

  sheet(`
    <h2>Selecionar usuário de teste</h2>
    <p class="muted small">${forced ? 'Escolha um perfil para começar a testar o aplicativo.' : 'Alterne entre perfis para testar permissões e fluxos distintos.'}</p>
    <div style="margin-top:14px; max-height:60vh; overflow-y:auto">
      ${users.map((u) => `
        <button class="user-option ${state.user?.id === u.id ? 'active' : ''}" data-uid="${u.id}" id="pick-user-${u.id}">
          ${avatar(u.name)}
          <span class="grow">
            <strong>${esc(u.name)}</strong>
            <div class="muted xs">${esc(u.specialty || '')} ${u.specialty ? '•' : ''} <span class="role-tag role-${u.role}">${ROLE[u.role] || u.role}</span></div>
          </span>
          ${state.user?.id === u.id ? icon('check', 18) : ''}
        </button>`).join('')}
    </div>
    <div class="sheet-actions" style="margin-top:14px">
      ${forced ? '' : '<button class="btn" data-close>Cancelar</button>'}
    </div>
  `, {
    dismissable: !forced,
    onMount(el, modal) {
      el.querySelectorAll('[data-uid]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const u = users.find((x) => x.id === btn.dataset.uid);
          if (u) {
            setUser(u);
            resetNotifTracking();
            modal.close();
            toast(`Perfil ativo: ${u.name}`);
            updateHeader();
            router();
            sync();
          }
        });
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
  // Atualiza meta theme-color para a barra do navegador mobile
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
  // Usuário
  const av = $('#user-avatar');
  if (state.user) {
    av.textContent = state.user.name.slice(0, 2).toUpperCase();
    av.title = `${state.user.name} (${ROLE[state.user.role] || state.user.role})`;
  } else {
    av.textContent = '?';
  }

  // Pílula de sincronização
  const pill = $('#sync-pill');
  const label = $('#sync-label');
  const pend = pendingOps().length;
  const fail = failedOps().length;

  pill.classList.remove('offline', 'pending', 'syncing');
  if (!state.online) {
    pill.classList.add('offline');
    label.textContent = pend ? `Offline (${pend})` : 'Offline';
  } else if (state.syncing) {
    pill.classList.add('syncing');
    label.textContent = 'Enviando…';
  } else if (fail > 0) {
    pill.classList.add('offline');
    label.textContent = `Falha (${fail})`;
  } else if (pend > 0) {
    pill.classList.add('pending');
    label.textContent = `Pendente (${pend})`;
  } else {
    label.textContent = 'Online';
  }

  // Notificações
  const nBadge = $('#notif-count');
  if (state.unread > 0) {
    nBadge.textContent = state.unread > 99 ? '99+' : state.unread;
    nBadge.classList.remove('hidden');
  } else {
    nBadge.classList.add('hidden');
  }

  // Banner offline
  $('#offline-banner').classList.toggle('hidden', state.online);
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
  $('#sync-pill').addEventListener('click', () => { location.hash = '#/sync'; });
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-notifs').addEventListener('click', () => { location.hash = '#/avisos'; });
  $('#btn-user').addEventListener('click', () => promptUserSelection(false));
  window.addEventListener('pick-user', () => promptUserSelection(false));

  // Navegação inferior
  $$('.nav-item, .nav-fab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav;
      if (target) location.hash = target;
    });
  });

  // Reações do Store
  on((ev) => {
    updateHeader();
    if (typeof ev === 'object' && ev?.type === 'new-notifs') {
      for (const n of ev.items) {
        const isStop = /PARADA/.test(n.title);
        toast(`${n.title}: ${n.body}`, isStop ? 'alarm' : 'warn', 5000);
        // Notificação nativa se permitida
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(n.title, { body: n.body, icon: '/icons/icon.svg' });
        }
      }
    }
  });

  // Inicializa o banco de dados cliente e carrega dados
  await init();

  // Se não há usuário selecionado, define um padrão (Carlos Mendes - Manutentor) ou pergunta
  if (!state.user && state.boot?.users?.length) {
    const defaultUser = state.boot.users.find((u) => u.id === 'u-carlos') || state.boot.users[0];
    setUser(defaultUser);
  }

  updateHeader();
  router();
  startClocks();
  registerSW();

  // Sincronização periódica a cada 30s se houver conexão
  setInterval(() => {
    if (state.online && !state.syncing) sync();
  }, 30000);

  // Primeira sincronização
  if (state.online) sync();
}

window.addEventListener('DOMContentLoaded', start);
