// Script para atualizar/importar a lista de máquinas sem duplicar tags existentes
import { openDb } from '../server/db.js';
import crypto from 'crypto';

export const MACHINES_DATA = [
  { "setor": "Corte", "descricao": "Multilamina CRS", "tag": "2074" },
  { "setor": "Corte", "descricao": "Mesa Elevatória Multilan CRS", "tag": "2040" },
  { "setor": "Corte", "descricao": "Multilamina Grossi e Oliveira", "tag": "1021" },
  { "setor": "Corte", "descricao": "Seccionadora Gabbiane", "tag": "2041" },
  { "setor": "Corte", "descricao": "Mesa Elevatória (acompanha Seccionadora Gabbiane)", "tag": "7001" },
  { "setor": "Corte", "descricao": "Seccionadora Giben", "tag": "2001" },
  { "setor": "Corte", "descricao": "Mesa Elevatória (acompanha Seccionadora Giben)", "tag": "7011" },
  { "setor": "Corte", "descricao": "Seccionadora Sulamericana (Corta)", "tag": "1020" },
  { "setor": "Corte", "descricao": "Mesa Elevatória (acompanha Seccionadora Sulamericana (Corta) )", "tag": "8001" },
  { "setor": "Corte", "descricao": "Seccionadora Sulamericana (Aparadeira)", "tag": "1027" },
  { "setor": "Corte", "descricao": "Serra Circular (de avanço)", "tag": "2010" },
  { "setor": "Corte", "descricao": "Serra Circular", "tag": "2011" },
  { "setor": "Corte", "descricao": "Serra Circular", "tag": "2073" },
  { "setor": "Corte", "descricao": "Serra Circular", "tag": "1012" },
  { "setor": "Corte", "descricao": "Serra Circular (de avanço)", "tag": "1014" },
  { "setor": "Corte", "descricao": "Serra Circular (de avanço)", "tag": "1015" },
  { "setor": "Corte", "descricao": "Serra de Fita Automática", "tag": "1031" },
  { "setor": "Corte", "descricao": "Serra de Fita Automática", "tag": "1036" },
  { "setor": "Corte", "descricao": "Mesa elevatória Serra de Fita 1036", "tag": "8002" },
  { "setor": "Corte", "descricao": "Serra de Fita Manual", "tag": "1032" },
  { "setor": "Corte", "descricao": "Tupia", "tag": "1024" },
  { "setor": "Corte", "descricao": "Tupia", "tag": "1025" },
  { "setor": "Corte", "descricao": "Tupia", "tag": "2015" },
  { "setor": "Corte", "descricao": "Tupia Carrossel", "tag": "1010" },
  { "setor": "Corte", "descricao": "Tupia Carrossel", "tag": "1011" },
  { "setor": "Corte", "descricao": "Tupia Superior", "tag": "1029" },
  { "setor": "Corte", "descricao": "Tupia Carrossel", "tag": "1035" },
  { "setor": "Corte", "descricao": "Mesa Elevatória (acompanha Gabbiani)", "tag": "7013" },
  { "setor": "Corte", "descricao": "Mesa Elevatória (acompanha Sulamericana que corta e apara)", "tag": "8003" },
  { "setor": "Filetação", "descricao": "Filetadeira Homag 1", "tag": "1019" },
  { "setor": "Filetação", "descricao": "Mesa elevatória (Filetadeira Homag 1)", "tag": "7015" },
  { "setor": "Filetação", "descricao": "Filetadeira Homag 2", "tag": "2017" },
  { "setor": "Filetação", "descricao": "Mesa elevatória (Filetadeira Homag 2)", "tag": "7016" },
  { "setor": "Filetação", "descricao": "Filetadeira Homag 3", "tag": "2013" },
  { "setor": "Filetação", "descricao": "Filetadeira Manual Usilkraft Junior 3", "tag": "1023" },
  { "setor": "Filetação", "descricao": "Filetadeira Manual Usilkraft (coladeira)", "tag": "1034" },
  { "setor": "Filetação", "descricao": "Filetadeira Manual Usilkraft", "tag": "1080" },
  { "setor": "Filetação", "descricao": "Filetadeira Manual Usilkraft", "tag": "1081" },
  { "setor": "Filetação", "descricao": "Filetadeira Manual Usilkraft", "tag": "1082" },
  { "setor": "Filetação", "descricao": "Filetadeira Manual Usilkraft", "tag": "1083" },
  { "setor": "Filetação", "descricao": "Filetadeira Manual Usilkraft", "tag": "1084" },
  { "setor": "Filetação", "descricao": "Filetadeira Splinter", "tag": "2019" },
  { "setor": "Filetação", "descricao": "Alimentador (Filetadeira Splinter)", "tag": "2070" },
  { "setor": "Filetação", "descricao": "Mesa elevatória (Filetadeira Splinter)", "tag": "7012" },
  { "setor": "Filetação", "descricao": "Filetadeira Sulamericana (Coladeira Esquadra de Borda)", "tag": "2012" },
  { "setor": "Filetação", "descricao": "Alimentador (Filetadeira Sulamericana )", "tag": "1085" },
  { "setor": "Filetação", "descricao": "Mesa elevatória (Filetadeira Sulamericana )", "tag": "7003" },
  { "setor": "Filetação", "descricao": "Mesa elevatória (Filetadeira Sulamericana )", "tag": "8004" },
  { "setor": "Filetação", "descricao": "Filetadeira Esquadra Nanxing", "tag": "2071" },
  { "setor": "Filetação", "descricao": "Descarregador (do Furador F500)", "tag": "2018" },
  { "setor": "Filetação", "descricao": "Seccionadora Sulamericana (Aparadeira)", "tag": "2004" },
  { "setor": "Filetação", "descricao": "Serra Circular", "tag": "1013" },
  { "setor": "Furação", "descricao": "Furador de Bancada", "tag": "1002" },
  { "setor": "Furação", "descricao": "Furador de Bancada", "tag": "1003" },
  { "setor": "Furação", "descricao": "Furador de Bancada", "tag": "1004" },
  { "setor": "Furação", "descricao": "Furador CHINÊS", "tag": "2075" },
  { "setor": "Furação", "descricao": "Furador de Bancada", "tag": "2009" },
  { "setor": "Furação", "descricao": "Furador Duplo Rullitec", "tag": "1037" },
  { "setor": "Furação", "descricao": "Furador Lidear F400 -C", "tag": "1008" },
  { "setor": "Furação", "descricao": "Furador Lidear F400 -C", "tag": "2005" },
  { "setor": "Furação", "descricao": "Furador Lidear F400-T", "tag": "1009" },
  { "setor": "Furação", "descricao": "Furador Lidear F400-T", "tag": "2007" },
  { "setor": "Furação", "descricao": "Mesa elevatória", "tag": "7017" },
  { "setor": "Furação", "descricao": "Furador Lidear F500-B", "tag": "2006" },
  { "setor": "Furação", "descricao": "Mesa elevatória", "tag": "7018" },
  { "setor": "Furação", "descricao": "Furador Rullitec Duplo", "tag": "2076" },
  { "setor": "Furação", "descricao": "Furador Rullitec Duplo", "tag": "1007" },
  { "setor": "Furação", "descricao": "Serra circular", "tag": "1038" },
  { "setor": "Furação", "descricao": "Serra circular", "tag": "1033" },
  { "setor": "Furação", "descricao": "Perfiladeira", "tag": "1016" },
  { "setor": "Furação", "descricao": "Furador Chinês", "tag": "1086" },
  { "setor": "Furação", "descricao": "Aparadeira Tornoaço", "tag": "1089" },
  { "setor": "Embalagem", "descricao": "Seladora Maquinapack INCLUSO TÚNEL", "tag": "2022" },
  { "setor": "Embalagem", "descricao": "Transportador Primário", "tag": "6020" },
  { "setor": "Embalagem", "descricao": "Transportador Secundário", "tag": "6021" },
  { "setor": "Embalagem", "descricao": "Transportador Terciário", "tag": "6022" },
  { "setor": "Embalagem", "descricao": "Aplicadora de Hot Melt (FECHAR PAPELÃO)", "tag": "6026" },
  { "setor": "Embalagem", "descricao": "Seladora de Plástico Projepack INCLUSO TÚNEL", "tag": "6024" },
  { "setor": "Embalagem", "descricao": "Transportador Primário", "tag": "6023" },
  { "setor": "Embalagem", "descricao": "Transportador Secundário", "tag": "6025" },
  { "setor": "Embalagem", "descricao": "Transportador Terciário", "tag": "2020" },
  { "setor": "Embalagem", "descricao": "Aplicadora de Hot Melt (FECHAR PAPELÃO)", "tag": "6027" },
  { "setor": "Embalagem", "descricao": "Esteira", "tag": "6048" },
  { "setor": "Estofação", "descricao": "Bordadeira Lanmax 1", "tag": "6017" },
  { "setor": "Estofação", "descricao": "Bordadeira Lanmax 2", "tag": "6016" },
  { "setor": "Estofação", "descricao": "Bordadeira Lanmax 3", "tag": "6018" },
  { "setor": "Estofação", "descricao": "Bordadeira Automática Chinesa", "tag": "9017" },
  { "setor": "Estofação", "descricao": "Seladora de Fita", "tag": "6012" },
  { "setor": "Estofação", "descricao": "Bordadeira Lanmax NOVA", "tag": "6019" },
  { "setor": "Assistência Técnica", "descricao": "Arqueadeira", "tag": "6007" },
  { "setor": "Lixação", "descricao": "Lixadeira LG 180 VMR", "tag": "1000" },
  { "setor": "Lixação", "descricao": "Lixadeira Bandalarga Tecmatic", "tag": "1005" },
  { "setor": "Linha UV", "descricao": "Alimentador", "tag": "3001" },
  { "setor": "Linha UV", "descricao": "Lixadeira Banda Larga", "tag": "3002" },
  { "setor": "Linha UV", "descricao": "Lixadeira de Massa Tecmatic", "tag": "3006" },
  { "setor": "Linha UV", "descricao": "Lixadeira Quebra Canto", "tag": "3007" },
  { "setor": "Linha UV", "descricao": "Rolo Alisador", "tag": "3015" },
  { "setor": "Linha UV", "descricao": "Rolo de Massa", "tag": "3004" },
  { "setor": "Linha UV", "descricao": "Rolo de Impressão", "tag": "3014" },
  { "setor": "Linha UV", "descricao": "Rolo de Primer duplo", "tag": "3009" },
  { "setor": "Linha UV", "descricao": "Rolo de Primer duplo", "tag": "3011" },
  { "setor": "Linha UV", "descricao": "Rolo de Primer duplo", "tag": "3012" },
  { "setor": "Linha UV", "descricao": "Rolo Duplo Laser", "tag": "3017" },
  { "setor": "Linha UV", "descricao": "Rolo Duplo Laser", "tag": "3018" },
  { "setor": "Linha UV", "descricao": "TAC", "tag": "3019" },
  { "setor": "Linha UV", "descricao": "Transportador Primário", "tag": "3003" },
  { "setor": "Linha UV", "descricao": "Transportador Secundário", "tag": "3008" },
  { "setor": "Linha UV", "descricao": "Túnel UV 2 Impressão", "tag": "3016" },
  { "setor": "Linha UV", "descricao": "Túnel UV 2 Massa", "tag": "3005" },
  { "setor": "Linha UV", "descricao": "Túnel UV 2 Verniz", "tag": "3020" },
  { "setor": "Linha UV", "descricao": "Túnel UV Primer", "tag": "3010" },
  { "setor": "Linha UV", "descricao": "Túnel UV Primer", "tag": "3013" },
  { "setor": "Linha UV", "descricao": "Mesa Elevatória", "tag": "8009" },
  { "setor": "Linha UV", "descricao": "Mesa Elevatória", "tag": "8010" },
  { "setor": "Linha UV", "descricao": "Alimentador", "tag": "4001" },
  { "setor": "Linha UV", "descricao": "Lixadeira de Massa Maquilinea", "tag": "4006" },
  { "setor": "Linha UV", "descricao": "Lixadeira Quebra Canto", "tag": "4007" },
  { "setor": "Linha UV", "descricao": "Rolo Alisador", "tag": "4015" },
  { "setor": "Linha UV", "descricao": "Rolo de Massa", "tag": "4004" },
  { "setor": "Linha UV", "descricao": "Rolo de Impressão", "tag": "4014" },
  { "setor": "Linha UV", "descricao": "Rolo de Primer duplo", "tag": "4009" },
  { "setor": "Linha UV", "descricao": "Rolo de Primer duplo", "tag": "4011" },
  { "setor": "Linha UV", "descricao": "Rolo de Primer duplo", "tag": "4012" },
  { "setor": "Linha UV", "descricao": "Rolo Duplo Laser", "tag": "4017" },
  { "setor": "Linha UV", "descricao": "Rolo Duplo Laser", "tag": "4018" },
  { "setor": "Linha UV", "descricao": "TAC", "tag": "4019" },
  { "setor": "Linha UV", "descricao": "Transportador Primário", "tag": "4003" },
  { "setor": "Linha UV", "descricao": "Transportador Secundário", "tag": "4008" },
  { "setor": "Linha UV", "descricao": "Túnel UV 2 Impressão", "tag": "4016" },
  { "setor": "Linha UV", "descricao": "Túnel UV 2 Massa", "tag": "4005" },
  { "setor": "Linha UV", "descricao": "Túnel UV 3 Verniz", "tag": "4020" },
  { "setor": "Linha UV", "descricao": "Túnel UV Primer", "tag": "4010" },
  { "setor": "Linha UV", "descricao": "Túnel UV Primer", "tag": "4013" },
  { "setor": "Linha UV", "descricao": "Lixadeira Banda Larga CHINA", "tag": "4002" },
  { "setor": "Linha UV", "descricao": "Mesa Elevatória", "tag": "8008" },
  { "setor": "Linha UV", "descricao": "Mesa Elevatória", "tag": "8007" },
  { "setor": "Linha UV", "descricao": "Alimentador", "tag": "5001" },
  { "setor": "Linha UV", "descricao": "Lixadeira de Massa Tecmatic", "tag": "5006" },
  { "setor": "Linha UV", "descricao": "Rolo Alisador", "tag": "5015" },
  { "setor": "Linha UV", "descricao": "Rolo de Massa", "tag": "5004" },
  { "setor": "Linha UV", "descricao": "Rolo de Impressão", "tag": "5014" },
  { "setor": "Linha UV", "descricao": "Rolo de Primer duplo", "tag": "5009" },
  { "setor": "Linha UV", "descricao": "Rolo de Primer duplo", "tag": "5011" },
  { "setor": "Linha UV", "descricao": "Rolo de Primer duplo", "tag": "5012" },
  { "setor": "Linha UV", "descricao": "Rolo Duplo Laser", "tag": "5017" },
  { "setor": "Linha UV", "descricao": "Rolo Duplo Laser", "tag": "5018" },
  { "setor": "Linha UV", "descricao": "TAC", "tag": "5019" },
  { "setor": "Linha UV", "descricao": "Transportador Primário", "tag": "5003" },
  { "setor": "Linha UV", "descricao": "Transportador Secundário", "tag": "5007" },
  { "setor": "Linha UV", "descricao": "Transportador Terciário", "tag": "5008" },
  { "setor": "Linha UV", "descricao": "Túnel UV 2 Impressão", "tag": "5016" },
  { "setor": "Linha UV", "descricao": "Túnel UV 2 Massa", "tag": "5005" },
  { "setor": "Linha UV", "descricao": "Túnel UV 3 Verniz", "tag": "5020" },
  { "setor": "Linha UV", "descricao": "Túnel UV Primer", "tag": "5010" },
  { "setor": "Linha UV", "descricao": "Túnel UV Primer", "tag": "5013" },
  { "setor": "Linha UV", "descricao": "Lixadeira Banda Larga", "tag": "5002" },
  { "setor": "Linha UV", "descricao": "Mesa Elevatória", "tag": "8006" },
  { "setor": "Linha UV", "descricao": "Lixadeira de Rolinho", "tag": "1006" },
  { "setor": "Linha UV", "descricao": "Alimentador", "tag": "6031" },
  { "setor": "Linha UV", "descricao": "Lixadeira Macline", "tag": "6032" },
  { "setor": "Linha UV", "descricao": "Transportador Primário", "tag": "6033" },
  { "setor": "Linha UV", "descricao": "Rolo de massa", "tag": "6034" },
  { "setor": "Linha UV", "descricao": "Túnel UV massa", "tag": "6035" },
  { "setor": "Linha UV", "descricao": "Lixadeira de Massa Tecmatic", "tag": "6036" },
  { "setor": "Linha UV", "descricao": "Transportador Secundário", "tag": "6037" },
  { "setor": "Linha UV", "descricao": "Rolo Primer Duplo 2", "tag": "6038" },
  { "setor": "Linha UV", "descricao": "Túnel UV primer Duplo 2", "tag": "6039" },
  { "setor": "Linha UV", "descricao": "Rolo Primer 2", "tag": "6040" },
  { "setor": "Linha UV", "descricao": "Rolo Primer 3", "tag": "6041" },
  { "setor": "Linha UV", "descricao": "Túnel UV primer 2/4", "tag": "6042" },
  { "setor": "Linha UV", "descricao": "Rolo de impressão", "tag": "6043" },
  { "setor": "Linha UV", "descricao": "Túnel Uv Impressão", "tag": "6044" },
  { "setor": "Linha UV", "descricao": "Rolo Duplo Laser 1", "tag": "6045" },
  { "setor": "Linha UV", "descricao": "Rolo Duplo Laser 2", "tag": "6046" },
  { "setor": "Linha UV", "descricao": "Túnel UV 3 Verniz", "tag": "6047" },
  { "setor": "Filial", "descricao": "Laminadora", "tag": "9000" },
  { "setor": "Filial", "descricao": "Laminadora", "tag": "9001" },
  { "setor": "Filial", "descricao": "Maquina de Caixa de Papelão", "tag": "9002" },
  { "setor": "Filial", "descricao": "Serra de Fita", "tag": "2016" },
  { "setor": "Filial", "descricao": "Serra Circular com Avanço", "tag": "9003" }
];

function normalizeStr(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

const SECTOR_DEFS = [
  { id: 'sec-corte-1', code: 'S-CORT01', name: 'CORTE', key: 'corte' },
  { id: 'sec-filetacao-2', code: 'S-FILE02', name: 'FILETAÇÃO', key: 'filetacao' },
  { id: 'sec-furacao-3', code: 'S-FURA03', name: 'FURAÇÃO', key: 'furacao' },
  { id: 'sec-embalagem-8', code: 'S-EMBA08', name: 'EMBALAGEM', key: 'embalagem' },
  { id: 'sec-estofacao-17', code: 'S-ESTO17', name: 'ESTOFAÇÃO', key: 'estofacao' },
  { id: 'sec-lix-m0jh', code: 'LIX', name: 'Lixação', key: 'lixacao' },
  { id: 'sec-assist-j055', code: 'ASSIST', name: 'Assistência Técnica', key: 'assistencia tecnica' },
  { id: 'sec-linha-uv', code: 'LUV', name: 'Linha UV', key: 'linha uv' },
  { id: 'sec-filial', code: 'FIL', name: 'Filial', key: 'filial' },
];

export function updateMachines(db) {
  console.log('--- INICIANDO ATUALIZAÇÃO DA LISTA DE MÁQUINAS ---');

  // 1. Garantir que os setores existam
  const existingSectors = db.prepare('SELECT id, code, name FROM sectors').all();
  const sectorByKey = new Map();

  for (const s of existingSectors) {
    const norm = normalizeStr(s.name);
    sectorByKey.set(norm, s.id);
  }

  for (const def of SECTOR_DEFS) {
    let sectorId = sectorByKey.get(def.key);
    if (!sectorId) {
      // Verifica se o ID já existe
      const byId = db.prepare('SELECT id FROM sectors WHERE id = ?').get(def.id);
      if (byId) {
        sectorId = byId.id;
      } else {
        // Verifica se o código já existe
        const byCode = db.prepare('SELECT id FROM sectors WHERE code = ?').get(def.code);
        if (byCode) {
          sectorId = byCode.id;
        } else {
          db.prepare('INSERT INTO sectors (id, code, name) VALUES (?, ?, ?)').run(def.id, def.code, def.name);
          sectorId = def.id;
          console.log(`[Setor Criado] ${def.name} (${def.id} / ${def.code})`);
        }
      }
      sectorByKey.set(def.key, sectorId);
    }
  }

  // 2. Carregar máquinas existentes
  const allMachines = db.prepare('SELECT id, code, name, sector_id, active FROM machines').all();
  const machineByCode = new Map();
  for (const m of allMachines) {
    const c = m.code ? m.code.trim().toUpperCase() : '';
    if (c) machineByCode.set(c, m);
  }

  const updateStmt = db.prepare(`
    UPDATE machines 
    SET name = ?, sector_id = ?, code = ?, active = 1, operating_hours_per_day = 8.0 
    WHERE id = ?
  `);

  const insertStmt = db.prepare(`
    INSERT INTO machines (
      id, code, name, sector_id, criticality, active, hourly_cost, operating_hours_per_day, default_checklist_json
    ) VALUES (?, ?, ?, ?, 'media', 1, 0.0, 8.0, '[]')
  `);

  let updatedCount = 0;
  let insertedCount = 0;
  const processedTags = new Set();

  db.exec('BEGIN TRANSACTION;');

  try {
    for (const item of MACHINES_DATA) {
      const tag = item.tag.trim();
      const upperTag = tag.toUpperCase();
      const name = item.descricao.trim();
      const sectorKey = normalizeStr(item.setor);
      const sectorId = sectorByKey.get(sectorKey);

      if (!sectorId) {
        throw new Error(`Setor não encontrado para: ${item.setor} (chave: ${sectorKey})`);
      }

      // Procurar máquina existente
      let existing = machineByCode.get(upperTag);

      // Tratamento especial para typo conhecido: '6O26' -> '6026'
      if (!existing && upperTag === '6026' && machineByCode.has('6O26')) {
        existing = machineByCode.get('6O26');
      }

      if (existing) {
        // Atualiza a máquina existente no banco sem duplicar
        updateStmt.run(name, sectorId, tag, existing.id);
        updatedCount++;
        // Atualiza no mapa em memória
        existing.name = name;
        existing.sector_id = sectorId;
        existing.code = tag;
        existing.active = 1;
        machineByCode.set(upperTag, existing);
      } else {
        // Inserir nova máquina
        const cleanTag = tag.toLowerCase().replace(/[^a-z0-9]/g, '');
        const randomSuffix = crypto.randomBytes(2).toString('hex');
        let newId = `m-${cleanTag}-${randomSuffix}`;
        
        insertStmt.run(newId, tag, name, sectorId);
        insertedCount++;

        const newMachine = { id: newId, code: tag, name, sector_id: sectorId, active: 1 };
        machineByCode.set(upperTag, newMachine);
      }

      processedTags.add(upperTag);
    }

    // Garante que todas as máquinas da base fiquem com 8.0 horas/dia
    db.prepare('UPDATE machines SET operating_hours_per_day = 8.0').run();

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  // 3. Validação final
  const totalInDb = db.prepare('SELECT COUNT(*) as n FROM machines').get().n;
  const activeInDb = db.prepare('SELECT COUNT(*) as n FROM machines WHERE active = 1').get().n;

  console.log('\n--- RESULTADO DA OPERAÇÃO ---');
  console.log(`Total de máquinas enviadas no JSON: ${MACHINES_DATA.length}`);
  console.log(`Máquinas já existentes atualizadas (sem duplicar): ${updatedCount}`);
  console.log(`Novas máquinas cadastradas: ${insertedCount}`);
  console.log(`Total geral de máquinas no banco: ${totalInDb} (Ativas: ${activeInDb})`);

  // Checar se todas as 180 tags do JSON estão presentes e ativas
  const missingInDb = [];
  for (const item of MACHINES_DATA) {
    const row = db.prepare('SELECT id, code, name, sector_id, active FROM machines WHERE UPPER(TRIM(code)) = ?').get(item.tag.trim().toUpperCase());
    if (!row || row.active !== 1) {
      missingInDb.push(item.tag);
    }
  }

  if (missingInDb.length > 0) {
    console.error('ALERTA: Algumas tags não foram encontradas ou não estão ativas:', missingInDb);
  } else {
    console.log('✅ SUCESSO: Todas as 180 máquinas foram devidamente cadastradas/atualizadas e estão ativas!');
  }

  return {
    totalInput: MACHINES_DATA.length,
    updated: updatedCount,
    inserted: insertedCount,
    totalInDb,
    activeInDb
  };
}

// Execução direta via CLI
if (process.argv[1] && process.argv[1].endsWith('update_machines_from_json.js')) {
  const db = openDb();
  updateMachines(db);
}
