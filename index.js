const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // Cache por 1 hora

app.use(cors()); // Permite requisições do seu site Onbox
app.use(express.json());

const SINDUSCON_URL = 'https://sindusconpr.com.br/incc-di-fgv-310-p';

/**
 * Faz o scraping da página do Sinduscon e retorna os dados do INCC
 */
async function fetchINCC() {
  const cachedData = cache.get('incc_data');
  if (cachedData) {
    console.log('[Cache] Retornando dados do cache');
    return cachedData;
  }

  console.log('[Scraping] Buscando dados do Sinduscon...');
  const { data: html } = await axios.get(SINDUSCON_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; INCCBot/1.0)',
    },
    timeout: 10000,
  });

  const $ = cheerio.load(html);
  const rows = [];

  // Localiza a tabela do INCC-DI
  $('table tr').each((i, row) => {
    const cols = $(row).find('td');
    if (cols.length < 5) return;

    const mes = $(cols[0]).text().trim();
    const indice = $(cols[1]).text().trim();
    const noMes = $(cols[2]).text().trim();
    const noAno = $(cols[3]).text().trim();
    const dozeMeses = $(cols[4]).text().trim();

    // Filtra linhas que parecem dados reais (mês contém "/")
    if (mes.includes('/') && indice && noMes && noAno && dozeMeses) {
      rows.push({
        mes,
        indice: parseFloat(indice.replace('.', '').replace(',', '.')),
        variacao: {
          no_mes: parseFloat(noMes.replace(',', '.')),
          no_ano: parseFloat(noAno.replace(',', '.')),
          doze_meses: parseFloat(dozeMeses.replace(',', '.')),
        },
      });
    }
  });

  if (rows.length === 0) {
    throw new Error('Nenhum dado encontrado na página. A estrutura do site pode ter mudado.');
  }

  const ultimo = rows[rows.length - 1];

  const result = {
    fonte: 'SINDUSCON-PR / FGV',
    url_fonte: SINDUSCON_URL,
    atualizado_em: new Date().toISOString(),
    ultimo: ultimo,
    historico: rows,
  };

  cache.set('incc_data', result);
  return result;
}

// ──────────────────────────────────────────
// ROTAS
// ──────────────────────────────────────────

/**
 * GET /incc
 * Retorna todos os dados: último índice + histórico completo
 */
app.get('/incc', async (req, res) => {
  try {
    const data = await fetchINCC();
    res.json({ success: true, data });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /incc/ultimo
 * Retorna apenas o último índice disponível
 */
app.get('/incc/ultimo', async (req, res) => {
  try {
    const data = await fetchINCC();
    res.json({ success: true, data: data.ultimo, atualizado_em: data.atualizado_em, fonte: data.fonte });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /incc/mes/:mes
 * Busca o índice de um mês específico. Ex: /incc/mes/Janeiro/2026
 */
app.get('/incc/mes/:mes/:ano', async (req, res) => {
  try {
    const { mes, ano } = req.params;
    const data = await fetchINCC();
    const busca = `${mes}/${ano}`;

    const encontrado = data.historico.find(
      (item) => item.mes.toLowerCase() === busca.toLowerCase()
    );

    if (!encontrado) {
      return res.status(404).json({ success: false, error: `Mês "${busca}" não encontrado` });
    }

    res.json({ success: true, data: encontrado, fonte: data.fonte });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /incc/cache/clear
 * Limpa o cache manualmente (útil para forçar atualização)
 */
app.post('/incc/cache/clear', (req, res) => {
  cache.flushAll();
  res.json({ success: true, message: 'Cache limpo. Próxima requisição buscará dados frescos.' });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ API INCC rodando em http://localhost:${PORT}`);
  console.log(`   GET  /incc          → todos os dados`);
  console.log(`   GET  /incc/ultimo   → último índice`);
  console.log(`   GET  /incc/mes/:mes/:ano`);
  console.log(`   POST /incc/cache/clear`);
});
