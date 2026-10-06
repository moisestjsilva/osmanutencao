import { Client } from 'ssh2';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const HOST = '186.225.65.17';
const PORT = 22;
const USERNAME = 'osrufato';
const PASSWORD = 'ImDs5nSJ8BmeFOTjS4L2';
const REMOTE_TARGET = '/home/os_rufato/htdocs/os.moveisrufato.com.br';

function connectSSH() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      console.log(`[SSH] Conectado com sucesso em ${HOST}:${PORT} como ${USERNAME}`);
      resolve(conn);
    });
    conn.on('error', (err) => reject(err));
    conn.connect({
      host: HOST,
      port: PORT,
      username: USERNAME,
      password: PASSWORD,
      readyTimeout: 15000,
    });
  });
}

function exec(conn, cmd) {
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve({ code: -1, stdout: '', stderr: err.message });
      let stdout = '';
      let stderr = '';
      stream.on('data', d => { stdout += d.toString(); });
      stream.stderr.on('data', d => { stderr += d.toString(); });
      stream.on('close', code => resolve({ code, stdout, stderr }));
    });
  });
}

async function sftpUploadDir(sftp, localDir, remoteDir) {
  const entries = fs.readdirSync(localDir, { withFileTypes: true });

  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`.replace(/\\/g, '/');

    // Ignora pastas pesadas ou locais
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === '.gemini' ||
      entry.name.endsWith('.tmp')
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      await new Promise((res) => {
        sftp.mkdir(remotePath, () => res());
      });
      await sftpUploadDir(sftp, localPath, remotePath);
    } else {
      await new Promise((res, rej) => {
        console.log(`[SFTP Upload] ${entry.name}`);
        sftp.fastPut(localPath, remotePath, (err) => {
          if (err) {
            console.warn(`[SFTP Warn] Falha ao enviar ${entry.name}: ${err.message}`);
          }
          res();
        });
      });
    }
  }
}

async function main() {
  let conn;
  try {
    conn = await connectSSH();

    // 1. Diagnóstico do servidor
    console.log('[Remote Info]');
    const res = await exec(conn, 'uname -a; php -v 2>&1 | head -n 1; mysql --version 2>&1 | head -n 1; which node 2>&1; which npm 2>&1; which pm2 2>&1');
    console.log(res.stdout);

    // 2. Abre SFTP e envia os arquivos
    console.log(`[SFTP] Iniciando envio dos arquivos para ${REMOTE_TARGET}...`);
    const sftp = await new Promise((res, rej) => {
      conn.sftp((err, s) => (err ? rej(err) : res(s)));
    });

    await sftpUploadDir(sftp, ROOT, REMOTE_TARGET);
    console.log('[SFTP] Todos os arquivos enviados com sucesso!');

    // 3. Ajuste de permissões
    await exec(conn, `chmod -R 775 ${REMOTE_TARGET}`);
    console.log('[Permissions] Permissões ajustadas para 775');

    // 4. Verificação dos arquivos no destino
    const check = await exec(conn, `ls -la ${REMOTE_TARGET}`);
    console.log('[Destino ls -la]:\n', check.stdout);

  } catch (err) {
    console.error('[Erro]', err.message);
  } finally {
    if (conn) conn.end();
  }
}

main();
