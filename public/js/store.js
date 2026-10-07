// Camada de dados do app: cache local (IndexedDB), fila persistente de operações
// offline, sincronização idempotente com o servidor e aplicação otimista local.
const DB_NAME = 'nova-os';
const listeners = new Set();

export const state = {
  user: null,
  token: localStorage.getItem('nova-os:token') || null,
  boot: null,            // máquinas, setores, equipes, usuários, configurações
  serverWos: [],         // última lista confirmada pelo servidor
  queue: [],             // operações pendentes/falhas (persistidas)
  online: navigator.onLine,
  syncing: false,
  lastSync: null,
  notifs: [],
  unread: 0,
};

export const on = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const emit = (what = 'change') => listeners.forEach((fn) => fn(what));

// ---------------- IndexedDB ----------------
let dbp;
function idb() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'opId' });
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}
async function store(name, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const s = t.objectStore(name);
    const req = fn(s);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Armazenamento cheio ou indisponível'));
  });
}
export const kv = {
  get: async (key) => (await store('cache', 'readonly', (s) => s.get(key)))?.value,
  set: (key, value) => store('cache', 'readwrite', (s) => s.put({ key, value })),
};
const qAll = () => store('queue', 'readonly', (s) => s.getAll());
const qPut = (op) => store('queue', 'readwrite', (s) => s.put(op));
const qDel = (id) => store('queue', 'readwrite', (s) => s.delete(id));

// ---------------- Utilidades ----------------
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class NetError extends Error {}
export class ApiError extends Error {}

export async function api(path, { method = 'GET', body, userId } = {}) {
  let res;
  const headers = {
    'Content-Type': 'application/json',
    'X-User-Id': userId || state.user?.id || '',
  };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  try {
    res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    setOnline(false);
    throw new NetError('Sem conexão com o servidor');
  }
  setOnline(true);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/login') {
    // Sessão expirada ou inválida
    if (state.token) {
      logout(false);
    }
    throw new ApiError(data.error || 'Sessão expirada. Faça login novamente.');
  }
  if (!res.ok) throw new ApiError(data.error || `Erro ${res.status}`);
  return data;
}

function setOnline(v) {
  if (state.online !== v) {
    state.online = v;
    emit('online');
  }
}

// ---------------- Autenticação no Cliente ----------------
export async function login(usernameOrEmail, password) {
  const data = await api('/api/auth/login', {
    method: 'POST',
    body: { login: usernameOrEmail, password }
  });

  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('nova-os:token', data.token);
  localStorage.setItem('nova-os:user', data.user.id);
  state.notifs = [];
  state.unread = 0;

  await loadBoot();
  await refresh();
  emit('user');
  return data.user;
}

export async function logout(callApi = true) {
  if (callApi && state.token) {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {}
  }
  state.token = null;
  state.user = null;
  localStorage.removeItem('nova-os:token');
  localStorage.removeItem('nova-os:user');
  state.serverWos = [];
  emit('user');
}

export async function changePassword(currentPassword, newPassword) {
  return await api('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword, newPassword }
  });
}

// ---------------- Gestão de Usuários (Admin / Super Admin) ----------------
export async function fetchUsers() {
  const r = await api('/api/users');
  return r.users || [];
}

export async function createUser(userData) {
  return await api('/api/users', {
    method: 'POST',
    body: userData
  });
}

export async function updateUser(id, userData) {
  return await api(`/api/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: userData
  });
}

export async function deleteUser(id) {
  return await api(`/api/users/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

// ---------------- Inicialização ----------------
export async function init() {
  state.queue = (await qAll()).sort((a, b) => a.seq - b.seq);
  state.boot = await kv.get('boot');
  state.serverWos = (await kv.get('wos')) || [];
  state.lastSync = await kv.get('lastSync');

  // Verifica se há token salvo
  const token = localStorage.getItem('nova-os:token');
  if (token) {
    state.token = token;
    try {
      const me = await api('/api/auth/me');
      state.user = me.user;
    } catch (e) {
      // Token inválido ou expirado
      state.token = null;
      state.user = null;
      localStorage.removeItem('nova-os:token');
    }
  }

  try {
    await loadBoot();
  } catch {}
}

export async function loadBoot() {
  const b = await api('/api/bootstrap');
  state.boot = b;
  if (b.currentUser) {
    state.user = b.currentUser;
  }
  await kv.set('boot', b);
  emit();
  return b;
}

export function setUser(u) {
  state.user = u;
  localStorage.setItem('nova-os:user', u.id);
  state.notifs = [];
  state.unread = 0;
  emit('user');
}

// ---------------- Leitura ----------------
export async function refresh(scope = '') {
  try {
    const qs = scope ? `?scope=${encodeURIComponent(scope)}` : '';
    const r = await api(`/api/workorders${qs}`);
    state.serverWos = r.workOrders;
    await kv.set('wos', r.workOrders);
    emit('wos');
  } catch (e) {
    if (e instanceof NetError) {
      // offline: mantém cache
    } else throw e;
  }
}

export async function fetchDetail(id) {
  try {
    const d = await api(`/api/workorders/${id}`);
    await kv.set(`wo:${id}`, d);
    return withLocal(d, true);
  } catch (e) {
    if (e instanceof ApiError && !pendingFor(id).length) throw e;
    const cached = await kv.get(`wo:${id}`);
    if (cached) return withLocal(cached, true);
    const fromList = workOrders().find((w) => w.id === id);
    if (fromList) return { ...fromList, events: [], attachments: [], intervals: [], _offlineOnly: true };
    throw e;
  }
}

export const pendingFor = (woId) => state.queue.filter((o) => o.woId === woId && o.status === 'pending');
export const failedOps = () => state.queue.filter((o) => o.status === 'failed');
export const pendingOps = () => state.queue.filter((o) => o.status === 'pending');

// Lista mesclada: dados do servidor + operações locais ainda não confirmadas
export function workOrders() {
  const list = state.serverWos.map((w) => structuredClone(w));
  for (const op of pendingOps()) applyLocal(list, op);
  return list;
}

function withLocal(detail, includeEvents) {
  const list = [structuredClone(detail)];
  for (const op of pendingOps().filter((o) => o.woId === detail.id)) {
    applyLocal(list, op);
    if (includeEvents) {
      list[0].events = list[0].events || [];
      list[0].events.push({ id: op.opId, action: actionName(op.type), reason: op.payload?.reason, userName: userName(op.userId), localTime: op.localTime, pending: true });
    }
  }
  return list[0];
}

const actionName = (t) => ({ create_wo: 'criar', assume: 'assumir', join: 'participar', start: 'iniciar', pause: 'pausar', finish_part: 'encerrar_parte',
  complete: 'concluir', cancel: 'cancelar', reopen: 'reabrir', transfer: 'transferir', attach: 'foto', update_checklist: 'checklist', correct_interval: 'corrigir_tempo' }[t] || t);
export const userName = (id) => state.boot?.users.find((u) => u.id === id)?.name || '—';

function recompute(wo) {
  if (['Concluída', 'Cancelada'].includes(wo.status)) return;
  if (wo.participants.some((p) => p.state === 'trabalhando')) wo.status = 'Em atendimento';
  else if (wo.participants.some((p) => p.state === 'pausado' || p.state === 'concluido')) wo.status = 'Pausada';
  else if (wo.responsible) wo.status = 'Assumida';
  else wo.status = 'Aberta';
}

function applyLocal(list, op) {
  const p = op.payload || {};
  if (op.type === 'create_wo') {
    if (list.some((w) => w.id === p.id)) return;
    const m = state.boot?.machines.find((x) => x.id === p.machineId);
    const s = state.boot?.sectors.find((x) => x.id === m?.sector_id);
    list.unshift({
      id: p.id, number: null, type: p.type, priority: p.priority, machineStopped: !!p.machineStopped, status: 'Aberta',
      description: p.description, machine: m ? { ...m, sector: s?.name } : { name: '?' },
      requester: { id: op.userId, name: userName(op.userId) }, responsible: null, participants: [], recipientsMode: p.recipientsMode,
      recipients: p.recipients, createdAt: op.localTime, photos: 0, checklist: null, _pending: 1, _local: true,
    });
    return;
  }
  const wo = list.find((w) => w.id === op.woId);
  if (!wo) return;
  wo._pending = (wo._pending || 0) + 1;
  const me = { id: op.userId, name: userName(op.userId) };
  const part = () => {
    let x = wo.participants.find((q) => q.userId === op.userId);
    if (!x) { x = { userId: op.userId, name: me.name, role: 'colaborador', state: 'aguardando', minutes: 0, activeSince: null }; wo.participants.push(x); }
    return x;
  };
  const stop = (st) => {
    const x = part();
    if (x.activeSince) x.minutes += Math.max(0, (new Date(op.localTime) - new Date(x.activeSince)) / 60000);
    x.activeSince = null; x.state = st;
  };
  switch (op.type) {
    case 'assume': if (!wo.responsible) { wo.responsible = me; part().role = 'responsavel'; } break;
    case 'join': part(); break;
    case 'start': {
      if (!wo.responsible) { wo.responsible = me; part().role = 'responsavel'; }
      const x = part(); x.state = 'trabalhando'; x.activeSince = x.activeSince || op.localTime; break;
    }
    case 'pause': stop('pausado'); break;
    case 'finish_part': stop('concluido'); break;
    case 'transfer': {
      const to = state.boot.users.find((u) => u.id === p.toUserId);
      wo.participants.forEach((q) => { if (q.role === 'responsavel') q.role = 'colaborador'; });
      wo.responsible = { id: to.id, name: to.name };
      const x = wo.participants.find((q) => q.userId === to.id);
      if (x) x.role = 'responsavel'; else wo.participants.push({ userId: to.id, name: to.name, role: 'responsavel', state: 'aguardando', minutes: 0 });
      break;
    }
    case 'update_checklist': wo.checklist = p.checklist; break;
    case 'complete':
      wo.participants.forEach((q) => { if (q.activeSince) q.minutes += (new Date(op.localTime) - new Date(q.activeSince)) / 60000; q.activeSince = null; q.state = 'concluido'; });
      wo.status = 'Concluída'; wo.closedAt = op.localTime; wo.serviceDone = p.serviceDone; wo.cause = p.cause; wo.solution = p.solution;
      if (wo.machineStopped) { wo.machineRecovered = !!p.machineRecovered; wo.returnedAt = p.returnedAt; }
      if (p.checklist) wo.checklist = p.checklist;
      return;
    case 'cancel': wo.status = 'Cancelada'; wo.cancelledReason = p.reason; return;
    case 'reopen': wo.status = 'Aberta'; wo.closedAt = null; wo.participants.forEach((q) => (q.state = 'aguardando')); break;
    case 'attach': wo.photos = (wo.photos || 0) + 1; wo._localPhotos = [...(wo._localPhotos || []), p.dataUrl]; return;
  }
  recompute(wo);
}

// ---------------- Fila e sincronização ----------------
let seqCounter = 0;
export async function enqueue(type, woId, payload = {}) {
  if (!state.user) throw new Error('Selecione um usuário');
  const op = {
    opId: uuid(), seq: Date.now() * 1000 + (seqCounter++ % 1000), type, woId, payload,
    localTime: new Date().toISOString(), userId: state.user.id,
    createdOffline: !state.online || !navigator.onLine, status: 'pending', attempts: 0,
  };
  try {
    await qPut(op);
  } catch (e) {
    throw new Error('Não foi possível salvar no aparelho (armazenamento cheio?)');
  }
  state.queue.push(op);
  emit('queue');
  sync();
  return op;
}

let syncPromise = null;
export function sync() {
  if (!syncPromise) syncPromise = doSync().finally(() => { syncPromise = null; });
  return syncPromise;
}

async function doSync() {
  const pending = pendingOps().sort((a, b) => a.seq - b.seq);
  const summary = { ok: 0, failed: [], network: false };
  if (pending.length) {
    state.syncing = true;
    emit('sync');
    // Agrupa por usuário (aparelho compartilhado) mantendo a ordem
    const groups = [];
    for (const op of pending) {
      const g = groups[groups.length - 1];
      if (g && g.userId === op.userId) g.ops.push(op); else groups.push({ userId: op.userId, ops: [op] });
    }
    for (const g of groups) {
      // Fotos vão em lotes menores
      const batches = [];
      let cur = [], size = 0;
      for (const op of g.ops) {
        const s = op.payload?.dataUrl?.length || 500;
        if (cur.length && (size + s > 6_000_000 || cur.length >= 50)) { batches.push(cur); cur = []; size = 0; }
        cur.push(op); size += s;
      }
      if (cur.length) batches.push(cur);
      for (const batch of batches) {
        let res;
        try {
          res = await api('/api/sync', {
            method: 'POST', userId: g.userId,
            body: { ops: batch.map((o) => ({ opId: o.opId, type: o.type, woId: o.woId, payload: o.payload, localTime: o.localTime, userId: o.userId,
              origin: o.createdOffline || o.attempts > 0 ? 'offline' : 'online' })) },
          });
        } catch (e) {
          summary.network = e instanceof NetError;
          for (const o of batch) { o.attempts++; o.lastError = e.message; await qPut(o); }
          if (summary.network) break;
          continue;
        }
        for (const r of res.results) {
          const op = state.queue.find((o) => o.opId === r.opId);
          if (!op) continue;
          if (r.status === 'ok') {
            await qDel(op.opId);
            state.queue = state.queue.filter((o) => o.opId !== op.opId);
            summary.ok++;
          } else if (r.status === 'retry' && op.attempts < 10) {
            op.attempts++; op.lastError = r.message; await qPut(op);
          } else {
            op.status = 'failed'; op.message = r.message; op.result = r.status; await qPut(op);
            summary.failed.push(op);
            // Sem a OS criada, operações dependentes também falham (preservadas para revisão)
            if (op.type === 'create_wo') {
              for (const d of state.queue.filter((o) => o.woId === op.woId && o.status === 'pending' && o !== op)) {
                d.status = 'failed'; d.message = 'OS de origem não foi aceita'; await qPut(d);
              }
            }
          }
        }
      }
      if (summary.network) break;
    }
    state.syncing = false;
  }
  if (!summary.network) {
    state.lastSync = new Date().toISOString();
    kv.set('lastSync', state.lastSync);
    await refresh();
    await loadNotifs();
  }
  emit('sync');
  return summary;
}

export async function retryOp(opId) {
  const op = state.queue.find((o) => o.opId === opId);
  if (!op) return;
  // Nova tentativa precisa de novo ID, pois o servidor já registrou o resultado do anterior
  await qDel(op.opId);
  Object.assign(op, { opId: uuid(), status: 'pending', message: null, attempts: 0, localTime: op.type === 'attach' ? op.localTime : op.localTime });
  await qPut(op);
  emit('queue');
  return sync();
}

export async function discardOp(opId) {
  await qDel(opId);
  state.queue = state.queue.filter((o) => o.opId !== opId);
  emit('queue');
}

// ---------------- Avisos ----------------
const seen = new Set(JSON.parse(sessionStorage.getItem('nova-os:seen') || '[]'));
let firstLoad = true;
export async function loadNotifs() {
  if (!state.user) return;
  try {
    const r = await api('/api/notifications');
    const fresh = r.notifications.filter((n) => !n.read_at && !seen.has(n.id));
    state.notifs = r.notifications;
    state.unread = r.unread;
    r.notifications.forEach((n) => seen.add(n.id));
    sessionStorage.setItem('nova-os:seen', JSON.stringify([...seen].slice(-500)));
    if (!firstLoad && fresh.length) emit({ type: 'new-notifs', items: fresh });
    firstLoad = false;
    emit('notifs');
  } catch {}
}
export function resetNotifTracking() { firstLoad = true; }

export async function markRead(ids) {
  await api('/api/notifications/read', { method: 'POST', body: ids ? { ids } : { all: true } });
  await loadNotifs();
}

window.addEventListener('online', () => { setOnline(true); sync(); });
window.addEventListener('offline', () => setOnline(false));
