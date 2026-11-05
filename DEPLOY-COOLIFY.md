# Deploy no Coolify (GitHub Actions)

## 1. No Coolify
1. **New Resource → Public/Private Repository** → `moisestjsilva/osmanutencao`, branch `main`, Build Pack **Dockerfile**, porta **3000**.
2. **Persistent Storage**: adicione um volume com destino `/data` (guarda `nova-os.db`, `uploads/` e `whatsapp_auth/`).
3. **Environment Variables** (copie do `.env` local; veja `.env.example`): `PUBLIC_URL`, `WHATSAPP_*`, `WAPI_*`, e `MYSQL_*` se ainda usar o sync MySQL (`MYSQL_HOST` deve ser alcançável a partir do container; `127.0.0.1` não funciona). `DATA_DIR=/data` já vem no Dockerfile.
4. Desative **Auto Deploy** do Coolify (o GitHub Action dispara o deploy) — opcional.
5. **Keys & Tokens → API tokens**: crie um token (permissão *deploy*) e ative a API em *Settings → Advanced*.

## 2. No GitHub (Settings → Secrets and variables → Actions)
| Secret | Valor |
|---|---|
| `COOLIFY_URL` | `https://seu-coolify.exemplo.com` (sem `/` final) |
| `COOLIFY_TOKEN` | token da API |
| `COOLIFY_APP_UUID` | UUID da aplicação (URL da app no Coolify) |

Todo push na `main` roda checagem + deploy ([deploy-coolify.yml](.github/workflows/deploy-coolify.yml)).

## 3. Migrar os dados (sem perda)
Os dados **não estão no Git** (`data/` é ignorado). Faça assim:
1. Pare o app local/antigo e rode `node scripts/backup-for-migration.cjs` → gera `backup-migracao/` (banco consistente + uploads + sessão WhatsApp).
2. Faça o primeiro deploy (cria o volume `/data`).
3. No terminal do container no Coolify (ou via `docker cp` no servidor), copie o conteúdo de `backup-migracao/` para `/data` (substituindo `nova-os.db`), e reinicie a app.
   - Servidor: `docker cp backup-migracao/. <container>:/data/`
4. Confira `/api/health`, login, OS, fotos. Só então desligue o CloudPanel.

> Backups: ative **Scheduled Backups** do volume ou copie `/data` periodicamente.

