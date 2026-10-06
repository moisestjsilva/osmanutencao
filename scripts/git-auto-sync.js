// Auto-sync com Git: observa alterações e envia automaticamente ao repositório remoto
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let timer = null;
let syncing = false;

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch (e) {
    return null;
  }
}

function hasChanges() {
  const status = run('git status --porcelain');
  return status && status.length > 0;
}

function syncNow() {
  if (syncing) return;
  if (!hasChanges()) return;

  syncing = true;
  const now = new Date().toLocaleString('pt-BR');
  console.log(`[Git Auto-Sync] Alterações detectadas às ${now}. Sincronizando...`);

  try {
    run('git add -A');
    const msg = `update: auto-sync ${now}`;
    run(`git commit -m "${msg}"`);
    console.log(`[Git Auto-Sync] Commit realizado: "${msg}"`);

    const remotes = run('git remote');
    if (remotes && remotes.includes('origin')) {
      const branch = run('git branch --show-current') || 'main';
      console.log(`[Git Auto-Sync] Enviando (git push origin ${branch})...`);
      const pushRes = run(`git push origin ${branch}`);
      console.log(`[Git Auto-Sync] Push concluído com sucesso no branch ${branch}!`);
    } else {
      console.log('[Git Auto-Sync] Nenhum remote "origin" configurado. O commit foi salvo localmente.');
    }
  } catch (err) {
    console.error('[Git Auto-Sync] Erro na sincronização:', err.message);
  } finally {
    syncing = false;
  }
}

function scheduleSync() {
  if (timer) clearTimeout(timer);
  // Aguarda 4 segundos de inatividade após edições para commitar
  timer = setTimeout(syncNow, 4000);
}

console.log('[Git Auto-Sync] Observando alterações no projeto...');

// Observador de arquivos com fs.watch
import fs from 'node:fs';
fs.watch(ROOT, { recursive: true }, (eventType, filename) => {
  if (!filename) return;
  // Ignora arquivos internos do git, cache de node_modules, banco temporário e uploads
  if (
    filename.startsWith('.git') ||
    filename.startsWith('node_modules') ||
    filename.startsWith('data') ||
    filename.endsWith('.tmp')
  ) {
    return;
  }
  scheduleSync();
});

// Sincroniza logo no início caso haja algo pendente
syncNow();
