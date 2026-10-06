# Nova OS — Aplicativo de Ordens de Serviço de Manutenção Industrial

Aplicativo web mobile-first para gestão de ordens de serviço (corretivas e preventivas), identificação de máquinas por QR code, acompanhamento de máquinas paradas em tempo real, cálculo de indicadores de manutenção e operação resiliente com fila offline.

Desenvolvido estritamente de acordo com o **[PRD-Manutencao-Industrial.docx](file:///c:/Users/moises.silva/Desktop/NOVA%20OS%20CLODPANEL/PRD-Manutencao-Industrial.docx)**.

---

## 🛠️ Stack Tecnológica

- **Backend**: Node.js (>= 22.13) com Express e `node:sqlite` nativo (sem compilação de binários nativos no servidor, 100% compatível com CloudPanel).
- **Frontend**: Vanilla HTML5, CSS3 moderno (design system escuro industrial com vidro fosco e micro-animações) e JavaScript ES Modules nativo.
- **Armazenamento no Cliente**: IndexedDB com fila persistente de operações (`processed_ops` deduplicadas no servidor via UUIDs).
- **PWA & Offline**: Service Worker para cache do shell do app e manifest para instalação no celular.
- **QR Code**: Leitor pela câmera (`BarcodeDetector` + fallback `jsQR`) e gerador SVG de etiquetas com código por máquina e setor.

---

## 🚀 Como Executar Localmente

### 1. Iniciar o servidor
No terminal do projeto:
```bash
npm start
```
Ou em modo de desenvolvimento com auto-reload:
```bash
npm run dev
```

O aplicativo estará disponível em:
👉 **[http://localhost:3000](http://localhost:3000)**

### 2. Resetar banco com dados de teste
Para restaurar as máquinas, planos e dados fictícios de demonstração:
```bash
npm run reset-db
```

---

## ☁️ Como Fazer Deploy no CloudPanel

Como a aplicação usa Node.js puro sem compilações externas e SQLite nativo, o deploy no CloudPanel é extremamente direto:

1. **Criar Site no CloudPanel**:
   - Vá em **Sites** ➡️ **Add Site** ➡️ **Node.js**.
   - Digite o seu domínio (ex: `manutencao.suaempresa.com`).
   - Selecione a versão do Node.js: **Node.js 22** ou superior.
   - Porta da aplicação: **3000** (ou a porta atribuída pelo CloudPanel).

2. **Copiar os Arquivos**:
   - Faça upload de todo o conteúdo desta pasta para `/home/{site-user}/htdocs/{dominio}/`.
   - Certifique-se de que a pasta `data/` tenha permissão de escrita para o usuário do site.

3. **Instalar Dependências & Iniciar**:
   - No terminal SSH do CloudPanel:
     ```bash
     cd /home/{site-user}/htdocs/{dominio}
     npm install --omit=dev
     ```
   - O CloudPanel utiliza o **PM2** ou o supervisor do Node configurado na aba do site. O comando de início é:
     ```bash
     npm start
     ```
   - No CloudPanel, aponte a rota de entrada para `server/server.js`.

4. **HTTPS / Câmera**:
   - Ative o certificado SSL gratuito (Let's Encrypt) no CloudPanel na aba **SSL/TLS**. O leitor de QR via câmera exige contexto seguro (HTTPS).

---

## 📱 Funcionalidades Entregues (Conforme Seções 3 e 4 do PRD)

1. **Experiência Mobile Prioritária**: Layout sem rolagem horizontal, botões grandes e de toque fácil, barra inferior estilo aplicativo com botão central em destaque.
2. **Identificação por QR Code e Código**:
   - QR da máquina preenche o chamado instantaneamente.
   - QR do setor exibe as máquinas daquele setor para seleção.
   - Alternativa manual digitando o código com busca rápida.
3. **Máquinas Paradas em Destaque**:
   - Carrossel superior de máquinas paradas com cronômetro em tempo real.
   - Intervalos de parada deduplicados no banco para não gerar contagem dupla.
4. **Ciclo de Vida Completo da OS**:
   - Estados: `Aberta`, `Assumida`, `Em atendimento`, `Pausada`, `Concluída` e `Cancelada`.
   - Assunção atômica: se dois manutentores tentarem assumir simultaneamente, apenas um assume e o outro é atualizado.
   - Múltiplos colaboradores com intervalos e cronômetros individuais (a pausa de um não pausa os demais).
   - Pausa com seleção rápida de motivo (aguardando peça, refeição, etc.).
   - Conclusão com validação obrigatória de serviço realizado, causas, checklist e encerramento automático dos intervalos ativos.
   - Reabertura e indicação de retrabalho com auditoria.
   - Transferência de responsável com histórico preservado.
5. **Planos Preventivos (RF08)**:
   - Calendário fixo com avanço da próxima data por frequência.
   - Deduplicação por chave única de ciclo (`plano:data`) evitando geração duplicada.
   - Geração automática e manual de ciclos com checklist integrado.
   - Avisos automáticos de vencimento e atraso.
6. **Operação e Fila Offline (RF09 & RF10)**:
   - Toda alteração gera uma operação persistida no IndexedDB com UUID e horário local.
   - Ao recuperar conexão, o envio é processado com deduplicação.
   - Conflitos e rejeições não são perdidos: ficam gravados na tabela `conflicts` para análise do gerente.
7. **Indicadores Conforme Seção 6 do PRD**:
   - Tempo médio de resposta (abertura ➡️ primeiro início).
   - MTTR (parada ➡️ retorno à operação).
   - Duração média de corretivas.
   - Tempo total de máquinas paradas (deduplicado).
   - Preventivas no prazo (% com atrasadas no denominador).
   - Taxa de retrabalho.
   - Ocorrências corretivas por máquina com gráfico de barras.
   - Produtividade e horas individuais por manutentor (sem ranking injusto, exibindo especialidades).
   - MTBF e Disponibilidade explicados como não calculados na ausência de calendário operacional.
8. **Impressão de Etiquetas QR**: Tela dedicada com QR codes em SVG pronta para impressão e fixação nas máquinas.
