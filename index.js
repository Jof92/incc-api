const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 * 6 });

app.use(cors());
app.use(express.json());

const SINDUSCON_URL = 'https://sindusconpr.com.br/incc-di-fgv-310-p';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; INCCBot/1.0)' };

const MESES_PT = [
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'
];

// ─── Cria um cliente Supabase novo a cada chamada (evita ECONNRESET) ──────────
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    {
      auth: { persistSession: false },
    }
  );
}

function parseBR(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') return val;
  return parseFloat(String(val).replace(/\./g, '').replace(',', '.'));
}

// ─── Scraping da página (últimos meses) ───────────────────────────────────────
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
    if (!mes.includes('/') || !indice) return;

    const [nomeMes, ano] = mes.split('/');
    const idxMes = MESES_PT.findIndex(m => m.toLowerCase() === nomeMes.toLowerCase());
    if (idxMes === -1) return;

    rows.push({
      data_referencia: `${ano}-${String(idxMes + 1).padStart(2, '0')}-01`,
      mes,
      indice: parseBR(indice),
      variacao_no_mes: parseBR(noMes),
      variacao_no_ano: parseBR(noAno),
      variacao_12_meses: parseBR(dozeMeses),
    });
  });

  return rows;
}

// ─── Verifica e insere novos índices no Supabase ──────────────────────────────
async function sincronizarNovosIndices() {
  console.log('[Sync] Verificando novos índices...');

  const pageRows = await fetchRecentFromPage();
  if (!pageRows.length) return;

  for (const row of pageRows) {
    const { data: existing } = await getSupabase()
      .from('incc_historico')
      .select('id')
      .eq('data_referencia', row.data_referencia)
      .single();

    if (!existing) {
      const { error } = await getSupabase().from('incc_historico').insert(row);
      if (error) {
        console.error(`[Sync] Erro ao inserir ${row.mes}:`, error.message);
      } else {
        console.log(`[Sync] ✅ Novo índice inserido: ${row.mes}`);
        cache.flushAll();
      }
    }
  }

  console.log('[Sync] Verificação concluída');
}

// ─── Busca histórico completo do Supabase ─────────────────────────────────────
async function fetchINCC() {
  const cached = cache.get('incc_data');
  if (cached) {
    console.log('[Cache] Retornando dados do cache');
    return cached;
  }

  console.log('[Supabase] Buscando histórico...');

  const { data, error } = await getSupabase()
    .from('incc_historico')
    .select('*')
    .order('data_referencia', { ascending: true });

  console.log('[Supabase] registros:', data?.length, '| erro:', error?.message ?? 'nenhum');

  if (error) throw new Error('Erro ao buscar dados do Supabase: ' + error.message);
  if (!data || data.length === 0) throw new Error('Nenhum dado encontrado no Supabase.');

  const historico = data.map(row => ({
    mes: row.mes,
    indice: parseFloat(row.indice),
    variacao: {
      no_mes: row.variacao_no_mes,
      no_ano: row.variacao_no_ano,
      doze_meses: row.variacao_12_meses,
    },
  }));

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

// ─── ROTAS ────────────────────────────────────────────────────────────────────

app.get('/incc', async (req, res) => {
  try { res.json({ success: true, data: await fetchINCC() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/incc/ultimo', async (req, res) => {
  try {
    const data = await fetchINCC();
    res.json({ success: true, data: data.ultimo, atualizado_em: data.atualizado_em, fonte: data.fonte });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/incc/historico', async (req, res) => {
  try {
    const data = await fetchINCC();
    res.json({ success: true, total: data.total_registros, fonte: data.fonte, historico: data.historico });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/incc/mes/:mes/:ano', async (req, res) => {
  try {
    const { mes, ano } = req.params;
    const data = await fetchINCC();
    const encontrado = data.historico.find(r => r.mes.toLowerCase() === `${mes}/${ano}`.toLowerCase());
    if (!encontrado) return res.status(404).json({ success: false, error: `Mês "${mes}/${ano}" não encontrado` });
    res.json({ success: true, data: encontrado, fonte: data.fonte });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Sincronização manual
app.post('/incc/sync', async (req, res) => {
  try {
    await sincronizarNovosIndices();
    res.json({ success: true, message: 'Sincronização concluída.' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/incc/cache/clear', (req, res) => {
  cache.flushAll();
  res.json({ success: true, message: 'Cache limpo.' });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Sincronização automática: verifica todo dia às 8h ───────────────────────
function agendarSincronizacaoDiaria() {
  const agora = new Date();
  const proxima = new Date();
  proxima.setHours(8, 0, 0, 0);
  if (proxima <= agora) proxima.setDate(proxima.getDate() + 1);
  const msAte = proxima - agora;

  setTimeout(() => {
    sincronizarNovosIndices().catch(console.error);
    setInterval(() => sincronizarNovosIndices().catch(console.error), 24 * 60 * 60 * 1000);
  }, msAte);

  console.log(`[Sync] Próxima verificação automática: ${proxima.toLocaleString('pt-BR')}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ API INCC rodando em http://localhost:${PORT}`);
  console.log(`   GET  /incc              → histórico completo`);
  console.log(`   GET  /incc/ultimo       → último índice`);
  console.log(`   GET  /incc/historico    → array histórico`);
  console.log(`   GET  /incc/mes/:mes/:ano`);
  console.log(`   POST /incc/sync         → sincroniza novos índices`);
  console.log(`   POST /incc/cache/clear`);
  agendarSincronizacaoDiaria();
});