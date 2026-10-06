import { Client } from 'ssh2';
import path from 'node:path';

const HOST = '186.225.65.17';
const PORTS = [22, 3033];
const PASSWORD = 'ImDs5nSJ8BmeFOTjS4L2';
const USERS = ['os_rufato', 'osrufato'];
const REPO_URL = 'https://github.com/moisestjsilva/osmanutencao.git';

async function tryConnect(username) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      console.log(`[SSH] Conectado com sucesso como usuário "${username}"!`);
      resolve(conn);
    });
    conn.on('error', (err) => {
      reject(err);
    });
    conn.connect({
      host: HOST,
      port: PORT,
      username: username,
      password: PASSWORD,
      readyTimeout: 20000,
    });
  });
}

function runRemote(conn, command) {
  return new Promise((resolve, reject) => {
    console.log(`[SSH Remote Exec] $ ${command}`);
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('close', (code, signal) => {
        if (code === 0) {
          resolve({ stdout, stderr, code });
        } else {
          console.warn(`[SSH Remote] Comando retornou código ${code}: ${stderr || stdout}`);
          resolve({ stdout, stderr, code });
        }
      });
      stream.on('data', (data) => {
        stdout += data.toString();
        process.stdout.write(data);
      });
      stream.stderr.on('data', (data) => {
        stderr += data.toString();
        process.stderr.write(data);
      });
    });
  });
}

async function main() {
  let conn = null;
  let activeUser = null;

  for (const user of USERS) {
    try {
      console.log(`[SSH] Tentando conectar como "${user}" em ${HOST}:${PORT}...`);
      conn = await tryConnect(user);
      activeUser = user;
      break;
    } catch (err) {
      console.log(`[SSH] Falha ao conectar como "${user}": ${err.message}`);
    }
  }

  if (!conn) {
    console.error('[SSH] Não foi possível conectar com nenhum dos usuários.');
    process.exit(1);
  }

  try {
    // 1. Diagnóstico do ambiente remoto
    await runRemote(conn, 'whoami; pwd; node -v; npm -v; git --version');

    // 2. Localiza a pasta do site
    const htdocsDir = `/home/${activeUser}/htdocs/os.moveisrufato.com.br`;
    console.log(`[Deploy] Verificando pasta do site: ${htdocsDir}`);
    await runRemote(conn, `ls -la ${htdocsDir}`);

    // 3. Clona ou atualiza o repositório do GitHub no servidor
    const cloneCmd = `
      if [ -d "${htdocsDir}/.git" ]; then
        echo "Repositório git existente encontrado. Atualizando..."
        cd ${htdocsDir} && git fetch origin && git reset --hard origin/main && git pull origin main
      else
        echo "Clonando repositório do GitHub..."
        mkdir -p ${htdocsDir}
        cd ${htdocsDir}
        # se a pasta tiver arquivos iniciais do CloudPanel (ex: index.html default), faz backup
        if [ "$(ls -A ${htdocsDir} 2>/dev/null)" ]; then
          git clone ${REPO_URL} /tmp/os_repo_tmp
          cp -rT /tmp/os_repo_tmp ${htdocsDir}
          rm -rf /tmp/os_repo_tmp
        else
          git clone ${REPO_URL} ${htdocsDir}
        fi
      fi
    `;
    await runRemote(conn, cloneCmd);

    // 4. Instala dependências no servidor
    console.log('[Deploy] Instalando dependências no servidor...');
    await runRemote(conn, `cd ${htdocsDir} && npm install --omit=dev`);

    // 5. Inicializa o banco de dados (SQLite nativo) se não existir
    console.log('[Deploy] Verificando / Inicializando banco de dados...');
    await runRemote(conn, `
      cd ${htdocsDir}
      mkdir -p data/uploads
      if [ ! -f "data/nova-os.db" ]; then
        echo "Criando banco de dados com dados iniciais..."
        node --no-warnings server/reset.js
      else
        echo "Banco de dados já existente preservado."
      fi
    `);

    // 6. Verifica gerenciador de processos (PM2 / CloudPanel)
    console.log('[Deploy] Verificando status de processos...');
    await runRemote(conn, `
      cd ${htdocsDir}
      which pm2 >/dev/null 2>&1 && pm2 status || echo "PM2 não está no PATH do usuário"
    `);

    // 7. Reinicia aplicação se o CloudPanel usa PM2 ou systemd
    console.log('[Deploy] Configurando/Reiniciando app...');
    await runRemote(conn, `
      cd ${htdocsDir}
      if which pm2 >/dev/null 2>&1; then
        pm2 restart os.moveisrufato.com.br || pm2 restart all || pm2 start server/server.js --name "os.moveisrufato.com.br"
      fi
    `);

    console.log('\n=============================================');
    console.log('✅ Deploy no CloudPanel concluído com sucesso!');
    console.log(`URL do site: http://os.moveisrufato.com.br`);
    console.log('=============================================\n');
  } catch (err) {
    console.error('[Deploy Error]', err);
  } finally {
    conn.end();
  }
}

main();
