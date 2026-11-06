// Script automático para migrar todo o banco de dados e uploads para o Coolify via API
// Sem precisar de SSH!
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'nova-os.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// O domínio gerado pelo Coolify para sua aplicação
const TARGET_URL = process.env.COOLIFY_APP_URL || 'https://os.moveisrufato.com.br';
const SECRET = process.env.MIGRATION_SECRET || 'nova-os-coolify-migration-2026';

async function main() {
  console.log(`=======================================================`);
  console.log(`MIGRAÇÃO DE DADOS PARA O COOLIFY`);
  console.log(`Destino: ${TARGET_URL}`);
  console.log(`=======================================================\n`);

  if (!fs.existsSync(DB_FILE)) {
    console.error(`❌ Erro: Banco de dados não encontrado em ${DB_FILE}`);
    process.exit(1);
  }

  // 1. Criar snapshot limpo com VACUUM INTO
  const tempSnap = path.join(ROOT, 'scratch', 'temp-migrate.db');
  fs.mkdirSync(path.dirname(tempSnap), { recursive: true });
  if (fs.existsSync(tempSnap)) fs.unlinkSync(tempSnap);

  console.log('1. Gerando snapshot seguro do banco de dados SQLite...');
  const localDb = new DatabaseSync(DB_FILE);
  localDb.exec(`VACUUM INTO '${tempSnap.replace(/'/g, "''")}'`);
  localDb.close();

  const dbBuffer = fs.readFileSync(tempSnap);
  const dbBase64 = dbBuffer.toString('base64');
  console.log(`   Tamanho do banco: ${(dbBuffer.length / (1024 * 1024)).toFixed(2)} MB`);

  // 2. Coletar uploads (fotos)
  console.log('\n2. Coletando fotos e anexos da pasta uploads...');
  const uploads = [];
  if (fs.existsSync(UPLOADS_DIR)) {
    const files = fs.readdirSync(UPLOADS_DIR).filter(f => !f.startsWith('.'));
    for (const file of files) {
      const full = path.join(UPLOADS_DIR, file);
      if (fs.statSync(full).isFile()) {
        uploads.push({
          filename: file,
          base64: fs.readFileSync(full).toString('base64'),
        });
      }
    }
  }
  console.log(`   Total de fotos/anexos encontrados: ${uploads.length}`);

  // 3. Enviar para o Coolify via API
  console.log(`\n3. Enviando dados para o Coolify (${TARGET_URL})...`);
  const endpoint = `${TARGET_URL.replace(/\/+$/, '')}/api/admin/restore-database`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Migration-Secret': SECRET,
      },
      body: JSON.stringify({ dbBase64, uploads }),
    });

    const json = await res.json();
    if (!res.ok) {
      throw new Error(`Servidor respondeu HTTP ${res.status}: ${JSON.stringify(json)}`);
    }

    console.log(`\n✅ SUCESSO TOTAL!`);
    console.log(`Mensagem do servidor: ${json.message}`);
    console.log(`Uploads restaurados: ${json.restoredUploads || 0}`);
    console.log(`\nO Coolify aplicou os dados e reiniciou o container com o banco migrado!`);
  } catch (err) {
    console.error(`\n❌ Falha ao enviar para o Coolify:`, err.message);
    console.error(`Verifique se o container está rodando e acessível no endereço acima.`);
  } finally {
    if (fs.existsSync(tempSnap)) fs.unlinkSync(tempSnap);
  }
}

main();

