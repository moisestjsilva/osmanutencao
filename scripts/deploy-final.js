import { Client } from 'ssh2';

const HOST = '186.225.65.17';
const PORT = 22;
const USERNAME = 'osrufato';
const PASSWORD = 'ImDs5nSJ8BmeFOTjS4L2';
const SITE_DIR = '/home/os_rufato/htdocs/os.moveisrufato.com.br';
const REPO_URL = 'https://github.com/moisestjsilva/osmanutencao.git';

function connectSSH() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      console.log(`[SSH] Conectado com sucesso como ${USERNAME}!`);
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

function runRemote(conn, command) {
  return new Promise((resolve, reject) => {
    console.log(`\n[SSH] $ ${command}`);
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', (code) => {
        resolve({ code, out });
      });
      stream.on('data', (d) => {
        out += d.toString();
        process.stdout.write(d);
      });
      stream.stderr.on('data', (d) => {
        out += d.toString();
        process.stderr.write(d);
      });
    });
  });
}

async function main() {
  const conn = await connectSSH();

  try {
    // 1. Clonar ou atualizar o repositório
    console.log('[Deploy 1/5] Clonando/atualizando arquivos do GitHub...');
    const cloneScript = `
      set -e
      if [ ! -d "${SITE_DIR}" ]; then
        mkdir -p "${SITE_DIR}"
      fi

      cd "${SITE_DIR}"
      git config --global --add safe.directory "*" || true
      if [ -d ".git" ]; then
        git remote set-url origin ${REPO_URL} || true
        git fetch origin
        git reset --hard origin/main
        git pull origin main
      else
        # Se houver arquivos iniciais, move para backup temporário
        mkdir -p /tmp/os_backup_old
        mv * /tmp/os_backup_old/ 2>/dev/null || true
        mv .* /tmp/os_backup_old/ 2>/dev/null || true
        git clone ${REPO_URL} .
      fi
      ls -la
    `;
    await runRemote(conn, cloneScript);

    // 2. Verificar onde está o Node.js no sistema ou instalar Node LTS via nvm no usuário se necessário
    console.log('[Deploy 2/5] Verificando ambiente Node.js...');
    const nodeCheckScript = `
      export PATH=$PATH:/usr/local/bin:/usr/bin:~/.nvm/versions/node/$(ls ~/.nvm/versions/node 2>/dev/null | tail -n 1)/bin
      which node || true
      which npm || true

      if ! command -v node >/dev/null 2>&1; then
        echo "Instalando Node.js localmente no usuário via nvm..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
        nvm install 22
        nvm use 22
      fi
      node -v
      npm -v
    `;
    await runRemote(conn, nodeCheckScript);

    // 3. Instalar dependências e preparar o banco
    console.log('[Deploy 3/5] Instalando dependências e preparando dados...');
    const buildScript = `
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
      export PATH=$PATH:/usr/local/bin:/usr/bin

      cd "${SITE_DIR}"
      npm install --omit=dev
      mkdir -p data/uploads

      if [ ! -f "data/nova-os.db" ]; then
        echo "Inicializando banco de dados SQLite com dados da demonstração..."
        node --no-warnings server/reset.js
      else
        echo "Banco de dados já existente preservado."
      fi
      ls -la data/
    `;
    await runRemote(conn, buildScript);

    // 4. Iniciar/Reiniciar aplicação na porta 3033
    console.log('[Deploy 4/5] Gerenciando processo da aplicação (PM2)...');
    const startScript = `
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
      export PATH=$PATH:/usr/local/bin:/usr/bin:~/.nvm/versions/node/$(ls ~/.nvm/versions/node 2>/dev/null | tail -n 1)/bin

      # Instala PM2 no usuário se não existir
      if ! command -v pm2 >/dev/null 2>&1; then
        npm install -g pm2
      fi

      cd "${SITE_DIR}"
      PORT=3033 pm2 delete os-manutencao 2>/dev/null || true
      PORT=3033 pm2 start server/server.js --name "os-manutencao" --update-env
      pm2 save
      pm2 status
    `;
    await runRemote(conn, startScript);

    // 5. Teste HTTP local no servidor na porta 3033
    console.log('[Deploy 5/5] Testando endpoint HTTP local (porta 3033)...');
    await runRemote(conn, 'curl -s -I http://127.0.0.1:3033/ | head -n 5');

    console.log('\n======================================================');
    console.log('🎉 DEPLOY CONCLUÍDO COM SUCESSO NO CLOUDPANEL!');
    console.log('Aplicação rodando em segundo plano na porta 3033.');
    console.log('======================================================\n');
  } catch (err) {
    console.error('[Erro]', err);
  } finally {
    conn.end();
  }
}

main();
