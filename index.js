const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const cors = require('cors');
const XLSX = require('xlsx');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 * 6 }); // Cache por 6 horas

app.use(cors());
app.use(express.json());

const SINDUSCON_URL = 'https://sindusconpr.com.br/incc-di-fgv-310-p';
const XLSX_URL = 'https://sindusconpr.com.br/download/10934/310';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; INCCBot/1.0)',
};

const MESES_PT = [
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'
];

function excelSerialToMesAno(serial) {
  const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
  const mes = MESES_PT[date.getUTCMonth()];
  const ano = date.getUTCFullYear();
  return `${mes}/${ano}`;
}

function parseBR(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') return val;
  return parseFloat(String(val).replace(/\./g, '').replace(',', '.'));
}

function normalizarMes(str) {
  if (!str) return null;
  str = String(str).trim();
  for (const mes of MESES_PT) {
    if (str.toLowerCase().startsWith(mes.toLowerCase())) return str;
  }
  const matchMMAAAA = str.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (matchMMAAAA) {
    const m = parseInt(matchMMAAAA[1]) - 1;
    const a = matchMMAAAA[2];
    if (m >= 0 && m < 12) return `${MESES_PT[m]}/${a}`;
  }
  const matchAAAAMM = str.match(/^(\d{4})[\/\-](\d{1,2})$/);
  if (matchAAAAMM) {
    const a = matchAAAAMM[1];
    const m = parseInt(matchAAAAMM[2]) - 1;
    if (m >= 0 && m < 12) return `${MESES_PT[m]}/${a}`;
  }
  return null;
}

async function fetchRecentFromPage() {
  const { data: html } = await axios.get(SINDUSCON_URL, { headers: HEADERS, timeout: 10000 });
  const $ = cheerio.load(html);
  const rows = [];

  $('table tr').each((i, row) => {
    const cols = $(row).find('td');
    if (cols.length < 5) return;
    const mes = $(cols[0]).text().trim();
    const indice = $(cols[1]).text().trim();
    const noMes = $(cols[2]).text().trim();
    const noAno = $(cols[3]).text().trim();
    const dozeMeses = $(cols[4]).text().trim();
    if (mes.includes('/') && indice) {
      rows.push({
        mes,
        indice: parseBR(indice),
        variacao: {
          no_mes: parseBR(noMes),
          no_ano: parseBR(noAno),
          doze_meses: parseBR(dozeMeses),
        },
      });
    }
  });

  return rows;
}

async function fetchHistoricoFromXLSX() {
  console.log('[XLSX] Baixando série histórica...');
  const response = await axios.get(XLSX_URL, {
    headers: HEADERS,
    responseType: 'arraybuffer',
    timeout: 20000,
  });

  const workbook = XLSX.read(response.data, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const rows = [];

  for (const row of raw) {
    if (!row || row.length < 2) continue;
    const col0 = row[0];
    const col1 = row[1];
    if (!col0 || !col1) continue;
    if (typeof col0 === 'string' && isNaN(parseBR(col1))) continue;

    let mesStr = null;
    if (typeof col0 === 'number' && col0 > 1000) {
      mesStr = excelSerialToMesAno(col0);
    } else {
      mesStr = normalizarMes(col0);
    }

    if (!mesStr) continue;
    const indice = parseBR(col1);
    if (!indice || isNaN(indice)) continue;

    rows.push({
      mes: mesStr,
      indice,
      variacao: {
        no_mes: parseBR(row[2]) ?? null,
        no_ano: parseBR(row[3]) ?? null,
        doze_meses: parseBR(row[4]) ?? null,
      },
    });
  }

  console.log(`[XLSX] ${rows.length} registros carregados`);
  return rows;
}

function mergeHistorico(xlsxRows, pageRows) {
  const map = new Map();
  for (const row of xlsxRows) map.set(row.mes.toLowerCase(), row);
  for (const row of pageRows) map.set(row.mes.toLowerCase(), row); // página tem prioridade

  return Array.from(map.values()).sort((a, b) => {
    const [mA, yA] = a.mes.split('/');
    const [mB, yB] = b.mes.split('/');
    const dateA = new Date(`${yA}-${String(MESES_PT.indexOf(mA) + 1).padStart(2,'0')}-01`);
    const dateB = new Date(`${yB}-${String(MESES_PT.indexOf(mB) + 1).padStart(2,'0')}-01`);
    return dateA - dateB;
  });
}

async function fetchINCC() {
  const cached = cache.get('incc_data');
  if (cached) {
    console.log('[Cache] Retornando dados do cache');
    return cached;
  }

  const [xlsxRows, pageRows] = await Promise.all([
    fetchHistoricoFromXLSX().catch(err => {
      console.warn('[XLSX] Falha, usando apenas página:', err.message);
      return [];
    }),
    fetchRecentFromPage(),
  ]);

  if (pageRows.length === 0 && xlsxRows.length === 0) {
    throw new Error('Não foi possível obter dados do INCC.');
  }

  const historico = mergeHistorico(xlsxRows, pageRows);
  const ultimo = historico[historico.length - 1];

  const result = {
    fonte: 'SINDUSCON-PR / FGV',
    url_fonte: SINDUSCON_URL,
    atualizado_em: new Date().toISOString(),
    total_registros: historico.length,
    ultimo,
    historico,
  };

  cache.set('incc_data', result);
  return result;
}

app.get('/incc', async (req, res) => {
  try {
    const data = await fetchINCC();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/incc/ultimo', async (req, res) => {
  try {
    const data = await fetchINCC();
    res.json({ success: true, data: data.ultimo, atualizado_em: data.atualizado_em, fonte: data.fonte });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/incc/historico', async (req, res) => {
  try {
    const data = await fetchINCC();
    res.json({ success: true, total: data.total_registros, fonte: data.fonte, historico: data.historico });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/incc/mes/:mes/:ano', async (req, res) => {
  try {
    const { mes, ano } = req.params;
    const data = await fetchINCC();
    const busca = `${mes}/${ano}`;
    const encontrado = data.historico.find(item => item.mes.toLowerCase() === busca.toLowerCase());
    if (!encontrado) return res.status(404).json({ success: false, error: `Mês "${busca}" não encontrado` });
    res.json({ success: true, data: encontrado, fonte: data.fonte });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/incc/cache/clear', (req, res) => {
  cache.flushAll();
  res.json({ success: true, message: 'Cache limpo.' });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ API INCC rodando em http://localhost:${PORT}`);
  console.log(`   GET  /incc              → histórico completo + último`);
  console.log(`   GET  /incc/ultimo       → último índice`);
  console.log(`   GET  /incc/historico    → array histórico completo`);
  console.log(`   GET  /incc/mes/:mes/:ano`);
  console.log(`   POST /incc/cache/clear`);
});