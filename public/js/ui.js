// Utilitários de interface: escape, formatação pt-BR, ícones, toasts, folhas modais, fotos.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const dtf = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const tf = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
export const fmtDateTime = (iso) => (iso ? dtf.format(new Date(iso)).replace(',', '') : '—');
export const fmtDate = (d) => (d ? df.format(new Date(d.length === 10 ? d + 'T12:00:00' : d)) : '—');
export const fmtTime = (iso) => (iso ? tf.format(new Date(iso)) : '—');

export function fmtMin(min) {
  if (min == null || isNaN(min)) return '—';
  min = Math.round(min);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return `${h}h${m ? String(m).padStart(2, '0') : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
export function clock(sinceIso, baseMin = 0) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(sinceIso)) / 1000) + Math.round(baseMin * 60));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
}
export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
}
export const initials = (name = '?') => name.replace(/\(.*\)/, '').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
export const hue = (str = '') => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
export const avatar = (name, cls = '') => `<span class="avatar ${cls}" style="--h:${hue(name)}" title="${esc(name)}">${esc(initials(name))}</span>`;

export const PRIORITY = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };
export const PRIO_COLOR = { urgente: 'var(--danger)', alta: 'hsl(355 70% 55%)', media: 'var(--accent)', baixa: 'var(--text-3)' };
export const ROLE = { superadmin: 'Super Admin', admin: 'Admin', manutentor: 'Manutentor', solicitante: 'Solicitante', gerente: 'Admin' };
export const statusBadge = (s) => `<span class="badge st-${esc(s)}"><span class="dot"></span>${esc(s)}</span>`;
export const prioBadge = (p) => `<span class="badge pr-${esc(p)}">${esc(PRIORITY[p] || p)}</span>`;
export const roleBadge = (r) => {
  const lbl = ROLE[r] || r;
  const cls = r === 'superadmin' ? 'role-super' : (r === 'admin' ? 'role-admin' : 'role-tech');
  return `<span class="badge ${cls}">${esc(lbl)}</span>`;
};

// Ícones (traço)
const P = {
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3.5 16a2 2 0 0 1 2.8-2.8L8 15"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  swap: '<path d="M17 3l4 4-4 4M21 7H9M7 21l-4-4 4-4M3 17h12"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  chev: '<path d="M9 18l6-6-6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  factory: '<path d="M2 20V9l6 4V9l6 4V4h4l2 16z"/><path d="M6 17h.01M10 17h.01M14 17h.01"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
  logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<path d="M21 2l-2 2m-1.5 1.5L14 9l-1.5-1.5L11 9l-1-1-1 1-1-1-1 1-2-2a5 5 0 1 0 7 7l6.5-6.5"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 13 3.5 3.5 0 0 0 6 19z"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
};
export const icon = (name, size = 20, sw = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

// Toasts
export function toast(msg, kind = 'ok', ms = 3200) {
  const root = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const ic = kind === 'err' ? 'alert' : kind === 'warn' ? 'cloud' : kind === 'alarm' ? 'alert' : 'check';
  el.innerHTML = `<span class="ti">${icon(ic, 18)}</span><span>${msg}</span>`;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
  return el;
}

// Folha modal (bottom sheet no celular)
export function sheet(html, { onMount, dismissable = true } = {}) {
  const root = $('#modal-root');
  const back = document.createElement('div');
  back.className = 'sheet-backdrop';
  back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div>`;
  root.appendChild(back);
  const el = back.firstElementChild;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.style.animation = 'fade .18s reverse forwards';
    setTimeout(() => back.remove(), 170);
    api.onClose?.();
  };
  const api = { el, close, onClose: null };
  if (dismissable) back.addEventListener('click', (e) => { if (e.target === back) close(); });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  onMount?.(el, api);
  setTimeout(() => el.querySelector('[autofocus]')?.focus(), 80);
  return api;
}

// Pede motivo (com sugestões rápidas)
export function askReason({ title, subtitle = '', suggestions = [], confirm = 'Confirmar', danger = false, extra = '' }) {
  return new Promise((resolve) => {
    const s = sheet(`
      <h2>${esc(title)}</h2>
      ${subtitle ? `<p class="muted small">${esc(subtitle)}</p>` : ''}
      <div class="reason-chips">${suggestions.map((r) => `<button class="chip" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>
      <label class="field"><span>Motivo</span><textarea class="input" id="reason-input" rows="3" placeholder="Descreva o motivo" ${suggestions.length ? '' : 'autofocus'}></textarea></label>
      ${extra}
      <div class="error-box hidden" id="reason-err">Informe o motivo</div>
      <div class="sheet-actions"><button class="btn" data-close>Voltar</button><button class="btn ${danger ? 'danger' : 'primary'}" id="reason-ok">${esc(confirm)}</button></div>
    `, {
      onMount(el, api) {
        const input = el.querySelector('#reason-input');
        el.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => {
          el.querySelectorAll('[data-r]').forEach((x) => x.classList.toggle('active', x === b));
          input.value = b.dataset.r;
        }));
        el.querySelector('#reason-ok').addEventListener('click', () => {
          const v = input.value.trim();
          if (!v) return el.querySelector('#reason-err').classList.remove('hidden');
          const extraVals = {};
          el.querySelectorAll('[data-extra]').forEach((x) => (extraVals[x.dataset.extra] = x.type === 'checkbox' ? x.checked : x.value));
          resolved = true;
          api.close();
          resolve({ reason: v, ...extraVals });
        });
        let resolved = false;
        api.onClose = () => { if (!resolved) resolve(null); };
      },
    });
  });
}

export function confirmDialog({ title, body = '', confirm = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    sheet(`<h2>${esc(title)}</h2><div class="muted" style="margin-top:6px">${body}</div>
      <div class="sheet-actions"><button class="btn" data-close>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cf-ok">${esc(confirm)}</button></div>`, {
      onMount(el, api) {
        el.querySelector('#cf-ok').addEventListener('click', () => { ok = true; api.close(); });
        api.onClose = () => resolve(ok);
      },
    });
  });
}

// Compressão de foto no aparelho (reduz dados para envio em rede instável)
export function compressImage(file, maxSide = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagem inválida')); };
    img.src = url;
  });
}

export const localInputValue = (d = new Date()) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 16);
};
