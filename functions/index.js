'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const admin = require('firebase-admin');

// Secrets via defineSecret — garante resolução para a versão mais recente a cada deploy.
const sGmail      = defineSecret('GMAIL_APP_PASSWORD');
const sClientId   = defineSecret('GOOGLE_CLIENT_ID');
const sClientSec  = defineSecret('GOOGLE_CLIENT_SECRET');
const sRefresh    = defineSecret('GOOGLE_REFRESH_TOKEN');
const sFolderId   = defineSecret('DRIVE_FOLDER_ID');
const sSA         = defineSecret('GOOGLE_SERVICE_ACCOUNT_JSON');
const sNotion     = defineSecret('NOTION_TOKEN');
const sDiagSecret = defineSecret('DIAGNOSTICO_WEBHOOK_SECRET');
const sKiwify     = defineSecret('KIWIFY_WEBHOOK_SECRET');
const sVapidPub   = defineSecret('VAPID_PUBLIC_KEY');
const sVapidPriv  = defineSecret('VAPID_PRIVATE_KEY');

const { requireAuth, requireAdmin, requireSelfOrAdmin, getSheetId } = require('./lib/auth');
const { SheetsClient } = require('./lib/sheets');
const { provisionar }  = require('./lib/provisionar');
const {
  sendEmail,
  emailRenovacaoPerfil,
  emailSemPerfil,
  emailLembreteOrcamento,
  emailLembreteAporte,
  emailLembretePlanejamento,
  emailNovidades,
  emailIR,
  emailReenvioAcesso,
  emailBoasVindas,
  emailExpiracaoProxima,
  emailCobrancasDia,
  emailRetencaoDia1,
  emailRetencaoDia3,
  emailRetencaoDia7,
  emailRelatorioMensal,
} = require('./lib/mailer');

admin.initializeApp();
const db = admin.firestore();

// Arrays de defineSecret para cada grupo de funções.
const SECRETS_EMAIL  = [sGmail];
const SECRETS_SHEETS = [sSA, sFolderId];
const SECRETS_ALL    = [sGmail, sClientId, sClientSec, sRefresh, sFolderId, sSA];
const SECRETS_PUSH   = [sVapidPub, sVapidPriv];

// ID da pasta no Google Drive da Flávia onde ficam as planilhas das mentoradas.
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';

// ─── Push helper ─────────────────────────────────────────────────────────────

/**
 * Envia push para todas as subscriptions ativas de um uid.
 * Limpa automaticamente subscriptions inválidas (410 Gone).
 * Requer que sVapidPub e sVapidPriv estejam nos secrets da função chamadora.
 */
async function sendPushToUid(uid, payload) {
  const webpush = require('web-push');
  webpush.setVapidDetails(
    'mailto:flaviasch@gmail.com',
    sVapidPub.value(),
    sVapidPriv.value(),
  );

  const snap = await db.collection('mentoradas').doc(uid)
    .collection('pushSubscriptions').get();
  if (snap.empty) return;

  const payloadStr = JSON.stringify(payload);
  const promises = snap.docs.map(async (doc) => {
    try {
      await webpush.sendNotification(doc.data(), payloadStr);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expirada — remove do Firestore
        await doc.ref.delete().catch(() => {});
      }
    }
  });
  await Promise.allSettled(promises);
}

/**
 * Envia push para todas as mentoradas ativas.
 */
async function sendPushToAtivas(payload) {
  const webpush = require('web-push');
  webpush.setVapidDetails(
    'mailto:flaviasch@gmail.com',
    sVapidPub.value(),
    sVapidPriv.value(),
  );

  const payloadStr = JSON.stringify(payload);
  const subsSnap = await db.collectionGroup('pushSubscriptions').get();
  const promises = subsSnap.docs.map(async (doc) => {
    try {
      await webpush.sendNotification(doc.data(), payloadStr);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await doc.ref.delete().catch(() => {});
      }
    }
  });
  await Promise.allSettled(promises);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hoje() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Rate limiting por usuária/ação usando Firestore como contador.
 * Lança HttpsError 'resource-exhausted' se o limite for atingido.
 *
 * @param {string} uid          — uid da usuária
 * @param {string} action       — nome da ação (ex: 'saveOrcamento')
 * @param {number} maxCalls     — máximo de chamadas permitidas na janela
 * @param {number} windowMs     — tamanho da janela em milissegundos
 */
async function checkRateLimit(uid, action, maxCalls, windowMs) {
  const now   = Date.now();
  const docId = `${uid}_${action}`;
  const ref   = db.collection('rateLimit').doc(docId);

  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.exists) {
      const { count, resetAt } = doc.data();
      if (now < resetAt) {
        if (count >= maxCalls) {
          throw new HttpsError(
            'resource-exhausted',
            `Limite de requisições atingido para "${action}". Tente em alguns instantes.`
          );
        }
        tx.update(ref, { count: admin.firestore.FieldValue.increment(1) });
      } else {
        tx.set(ref, { count: 1, resetAt: now + windowMs, uid, action });
      }
    } else {
      tx.set(ref, { count: 1, resetAt: now + windowMs, uid, action });
    }
  });
}

// ─── DASHBOARD (index.html) ───────────────────────────────────────────────────

/**
 * Retorna todos os dados necessários para a tela principal de uma mentorada:
 * orçamento do mês atual, patrimônio, reservas e perfil.
 */
exports.getDashboard = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const uid  = request.data?.uid || auth.uid;
  requireSelfOrAdmin(request, uid);

  // Lê o doc Firestore para obter sheetId, inicio e perfil (fallback)
  const docSnap = await db.collection('mentoradas').doc(uid).get();
  if (!docSnap.exists) {
    throw new HttpsError('not-found', `Mentorada não encontrada: ${uid}`);
  }
  const { sheetId, inicio, nome, perfil: perfilFirestore, lgpdAceite, ultimoAcessoMes,
          assinaturaClube, assinaturaDashboard } = docSnap.data();

  // Verifica se tem acesso ao dashboard:
  // — admin nunca é bloqueado
  // — assinaturaDashboard: true  → tem dashboard
  // — assinaturaDashboard: false → não tem dashboard
  // — assinaturaDashboard: undefined + assinaturaClube: true  → Clube-only (sem dashboard)
  // — assinaturaDashboard: undefined + assinaturaClube falsy  → usuária legada, mantém acesso
  const isAdminUser = request.auth?.token?.admin === true;
  const clubeOnly   = assinaturaClube === true && assinaturaDashboard !== true;
  const temDashboard = isAdminUser || !clubeOnly;

  // Resposta mínima para membros apenas do Clube (sem dashboard)
  const respostaApenasClube = {
    nome:            nome       || null,
    inicio:          inicio     || null,
    lgpdAceite:      lgpdAceite || false,
    assinaturaClube: true,
    apenasClube:     true,
    orcamento:  { receita: 0, despesa: 0, sobra: 0, mes: new Date().getMonth() + 1, ano: new Date().getFullYear() },
    patrimonio: { ativos: 0, dividas: 0, pl: 0 },
    reservas:   [],
    perfil:     { perfil: perfilFirestore || null, dataAtualizacao: null },
    sheetError: false,
  };

  if (!sheetId) {
    if (assinaturaClube) return respostaApenasClube;
    throw new HttpsError('failed-precondition', 'Planilha ainda não configurada para esta mentorada.');
  }

  // Tem planilha mas só assinou o Clube → redireciona ao clube.html
  if (!temDashboard && assinaturaClube) return respostaApenasClube;

  const agora    = new Date();
  const mes      = agora.getMonth() + 1;
  const ano      = agora.getFullYear();
  const mesAtual = agora.toISOString().slice(0, 7); // YYYY-MM

  let orcamento = [], ir = [], corretora = [], dividas = [], reservas = [];
  let perfil     = { perfil: perfilFirestore?.perfil || perfilFirestore || null, dataAtualizacao: null };
  let sheetError = false;

  // ── Orçamento: Firestore ─────────────────────────────────────────────────
  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const orcSnap = await db.collection('mentoradas').doc(uid)
    .collection('orcamento').doc(mesKey).get().catch(() => null);
  if (orcSnap?.exists) {
    orcamento = orcSnap.data().itens || [];
  }

  // ── Patrimônio + dívidas: Firestore ─────────────────────────────────────
  const patSnap = await db.collection('mentoradas').doc(uid)
    .collection('patrimonio').doc('dados').get().catch(() => null);
  if (patSnap?.exists) {
    ir        = patSnap.data().ir        || [];
    corretora = patSnap.data().corretora || [];
    dividas   = patSnap.data().dividas   || [];
  }

  // ── Reservas: Firestore ──────────────────────────────────────────────────
  const resSnap = await db.collection('mentoradas').doc(uid)
    .collection('reservas').get().catch(() => null);
  if (resSnap && !resSnap.empty) {
    reservas = resSnap.docs.map(d => ({ ...d.data(), id: d.id }));
  }

  // ── Perfil: Firestore ────────────────────────────────────────────────────
  const perfilSnap = await db.collection('mentoradas').doc(uid)
    .collection('perfil').doc('dados').get().catch(() => null);
  if (perfilSnap?.exists) perfil = perfilSnap.data();

  // ── Fallback Sheets: só usa se Firestore não tiver dados ─────────────────
  const precisaSheets = (!patSnap?.exists || !resSnap || resSnap.empty || !perfilSnap?.exists);
  if (precisaSheets && sheetId) {
    try {
      const sheets = new SheetsClient(sheetId);
      const tarefas = [];

      if (!orcamento.length) tarefas.push(['orc', sheets.getOrcamento(mes, ano)]);
      if (!patSnap?.exists)  tarefas.push(['ir', sheets.getPatrimonio()], ['cor', sheets.getInvestimentos()], ['div', sheets.getDividas()]);
      if (!resSnap || resSnap.empty) tarefas.push(['res', sheets.getReservas()]);
      if (!perfilSnap?.exists) tarefas.push(['per', sheets.getPerfil()]);

      const results = await Promise.allSettled(tarefas.map(([, p]) => p));
      tarefas.forEach(([key], i) => {
        const r = results[i];
        if (r.status !== 'fulfilled') { sheetError = true; return; }
        if (key === 'orc') orcamento = r.value;
        if (key === 'ir')  ir        = r.value;
        if (key === 'cor') corretora = r.value;
        if (key === 'div') dividas   = r.value;
        if (key === 'res') reservas  = r.value;
        if (key === 'per') perfil    = r.value;
      });
    } catch (e) {
      sheetError = true;
      console.error(`[getDashboard] Erro no fallback Sheets (uid=${uid}): ${e.message}`);
    }
  }

  // Consolida ativos = IR + corretora
  const ativosConsolidados = consolidarAtivos(ir, corretora);

  const totalAtivos  = ativosConsolidados.reduce((s, a) => s + a.valor, 0);
  const totalDividas = dividas.reduce((s, d) => s + d.saldo, 0);
  const receita      = orcamento.filter(i => i.tipo === 'receita').reduce((s, i) => s + i.valor, 0);
  const despesa      = orcamento.filter(i => i.tipo === 'despesa').reduce((s, i) => s + i.valor, 0);
  const aporte       = orcamento.filter(i => i.tipo === 'aporte').reduce((s, i) => s + i.valor, 0);

  const pl           = totalAtivos - totalDividas;
  const sobra        = receita - despesa;
  const totalReservas = reservas.reduce((s, r) => s + (r.acumulado || 0), 0);

  // Cacheia snapshot financeiro + registra acesso no Firestore para o painel admin.
  // Executa em background — não bloqueia a resposta para a aluna.
  // Acesso só é registrado quando a mentorada carrega o próprio dashboard (não quando admin visualiza).
  const acessoFields = uid === auth.uid ? {
    ultimoAcesso:    admin.firestore.FieldValue.serverTimestamp(),
    totalAcessos:    admin.firestore.FieldValue.increment(1),
    acessosMes:      ultimoAcessoMes === mesAtual
                       ? admin.firestore.FieldValue.increment(1)
                       : 1,
    ultimoAcessoMes: mesAtual,
  } : {};

  docSnap.ref.update({
    pl,
    sobra,
    totalReservas,
    dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    ...acessoFields,
  }).catch(e => console.warn(`[getDashboard] Falha ao cachear snapshot (uid=${uid}):`, e.message));

  return {
    nome:            nome            || null,
    orcamento:      { receita, despesa, sobra, aporte, mes, ano },
    patrimonio:     { ativos: totalAtivos, dividas: totalDividas, pl },
    reservas,
    perfil,
    inicio:          inicio          || null,
    lgpdAceite:      lgpdAceite      || false,
    assinaturaClube: assinaturaClube || false,
    sheetError:      sheetError,
  };
});

// ─── ORÇAMENTO (orcamento.html) ───────────────────────────────────────────────

exports.getOrcamento = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  requireAuth(request);
  const { uid, mes, ano } = request.data;
  requireSelfOrAdmin(request, uid);

  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;

  // ── Firestore first ───────────────────────────────────────────────────────
  const docSnap = await db.collection('mentoradas').doc(uid)
    .collection('orcamento').doc(mesKey).get();
  if (docSnap.exists) {
    return docSnap.data().itens || [];
  }

  // ── Fallback: Sheets (dados antes da migração) ────────────────────────────
  try {
    const sheetId = await getSheetId(db, uid);
    if (!sheetId) return [];
    return await new SheetsClient(sheetId).getOrcamento(mes, ano);
  } catch {
    return [];
  }
});

/**
 * Salva itens de orçamento importados do CSV do Raio-X.
 * Espera: { uid, mes, ano, itens: [{ categoria, tipo, valor }] }
 */
exports.saveOrcamento = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, mes, ano, itens } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'saveOrcamento', 30, 60_000); // 30/min

  // ── Validação ──────────────────────────────────────────────────────────────
  if (!Number.isInteger(mes) || mes < 1 || mes > 12)
    throw new HttpsError('invalid-argument', 'mes deve ser inteiro entre 1 e 12.');
  if (!Number.isInteger(ano) || ano < 2020 || ano > 2100)
    throw new HttpsError('invalid-argument', 'ano deve ser inteiro entre 2020 e 2100.');
  if (!Array.isArray(itens))
    throw new HttpsError('invalid-argument', 'itens deve ser um array.');
  if (itens.length > 500)
    throw new HttpsError('invalid-argument', 'Limite de 500 itens por mês excedido.');

  const TIPOS_VALIDOS = new Set(['receita', 'despesa', 'aporte']);
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i];
    if (!it.categoria || typeof it.categoria !== 'string' || it.categoria.trim() === '')
      throw new HttpsError('invalid-argument', `Item ${i + 1}: categoria é obrigatória.`);
    if (!TIPOS_VALIDOS.has(it.tipo))
      throw new HttpsError('invalid-argument', `Item ${i + 1}: tipo inválido "${it.tipo}". Use receita, despesa ou aporte.`);
    if (typeof it.valor !== 'number' || isNaN(it.valor) || it.valor < 0)
      throw new HttpsError('invalid-argument', `Item ${i + 1}: valor deve ser número não-negativo.`);
    if (it.valor > 10_000_000)
      throw new HttpsError('invalid-argument', `Item ${i + 1}: valor acima do limite permitido.`);
    // Sanitiza strings longas
    if (it.categoria.length > 200) it.categoria = it.categoria.slice(0, 200);
    if (it.descricao && it.descricao.length > 500) it.descricao = it.descricao.slice(0, 500);
  }

  // ── Grava no Firestore (operação atômica — sem clear+write) ─────────────
  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  await db.collection('mentoradas').doc(uid)
    .collection('orcamento').doc(mesKey).set({
      uid, mes, ano, itens,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

  // ── Cache de sobra calculado direto dos itens (sem re-leitura) ──────────
  const receita = itens.filter(i => i.tipo === 'receita').reduce((s, i) => s + i.valor, 0);
  const despesa = itens.filter(i => i.tipo === 'despesa').reduce((s, i) => s + i.valor, 0);
  db.collection('mentoradas').doc(uid).update({
    sobra: receita - despesa,
    dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.warn('[saveOrcamento] Falha ao atualizar cache:', e.message));

  return { ok: true };
});

// ─── RECORRENTES (despesas fixas mensais) ─────────────────────────────────────

/**
 * Lista as despesas recorrentes de uma mentorada.
 * Espera: { uid }
 */
exports.getRecorrentes = onCall(async (request) => {
  requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);

  const snap = await db.collection('mentoradas').doc(uid)
    .collection('recorrentes').orderBy('criadoEm', 'asc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
});

/**
 * Cria ou atualiza uma despesa recorrente.
 * Espera: { uid, recorrente: { id?, categoria, descricao, valor, dia, ativo } }
 */
exports.saveRecorrente = onCall(async (request) => {
  requireAuth(request);
  const { uid, recorrente } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!recorrente?.categoria || typeof recorrente.categoria !== 'string')
    throw new HttpsError('invalid-argument', 'categoria é obrigatória.');
  if (typeof recorrente.valor !== 'number' || recorrente.valor < 0 || recorrente.valor > 10_000_000)
    throw new HttpsError('invalid-argument', 'valor inválido.');
  if (!Number.isInteger(recorrente.dia) || recorrente.dia < 1 || recorrente.dia > 28)
    throw new HttpsError('invalid-argument', 'dia deve ser inteiro entre 1 e 28.');

  const col = db.collection('mentoradas').doc(uid).collection('recorrentes');
  const dados = {
    categoria:  recorrente.categoria.trim().slice(0, 200),
    descricao:  (recorrente.descricao || '').trim().slice(0, 500),
    valor:      recorrente.valor,
    dia:        recorrente.dia,
    ativo:      recorrente.ativo !== false,
  };

  if (recorrente.id) {
    await col.doc(recorrente.id).update(dados);
    return { id: recorrente.id };
  } else {
    const ref = await col.add({ ...dados, criadoEm: admin.firestore.FieldValue.serverTimestamp() });
    return { id: ref.id };
  }
});

/**
 * Exclui uma despesa recorrente.
 * Espera: { uid, id }
 */
exports.deleteRecorrente = onCall(async (request) => {
  requireAuth(request);
  const { uid, id } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');
  await db.collection('mentoradas').doc(uid).collection('recorrentes').doc(id).delete();
  return { ok: true };
});

// ─── CARTÕES DE CRÉDITO ───────────────────────────────────────────────────────

exports.getCartoes = onCall(async (request) => {
  requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);
  const snap = await db.collection('mentoradas').doc(uid)
    .collection('cartoes').orderBy('criadoEm', 'asc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
});

exports.saveCartao = onCall(async (request) => {
  requireAuth(request);
  const { uid, cartao } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!cartao?.nome || typeof cartao.nome !== 'string')
    throw new HttpsError('invalid-argument', 'nome é obrigatório.');
  if (!Number.isInteger(cartao.diaCorte) || cartao.diaCorte < 1 || cartao.diaCorte > 28)
    throw new HttpsError('invalid-argument', 'diaCorte deve ser entre 1 e 28.');
  if (cartao.diaVencimento != null && (!Number.isInteger(cartao.diaVencimento) || cartao.diaVencimento < 1 || cartao.diaVencimento > 28))
    throw new HttpsError('invalid-argument', 'diaVencimento deve ser entre 1 e 28.');

  const dados = {
    nome:           cartao.nome.trim().slice(0, 100),
    diaCorte:       cartao.diaCorte,
    diaVencimento:  cartao.diaVencimento || null,
    limite:         typeof cartao.limite === 'number' ? cartao.limite : null,
    ativo:          cartao.ativo !== false,
  };

  const col = db.collection('mentoradas').doc(uid).collection('cartoes');
  if (cartao.id) {
    await col.doc(cartao.id).update(dados);
    return { id: cartao.id };
  } else {
    const ref = await col.add({ ...dados, criadoEm: admin.firestore.FieldValue.serverTimestamp() });
    return { id: ref.id };
  }
});

exports.deleteCartao = onCall(async (request) => {
  requireAuth(request);
  const { uid, id } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');
  await db.collection('mentoradas').doc(uid).collection('cartoes').doc(id).delete();
  return { ok: true };
});

/**
 * Migra os dados de orçamento do Sheets para o Firestore para todas as usuárias.
 * Pula meses que já existem no Firestore. Idempotente — seguro rodar múltiplas vezes.
 * Admin only.
 */
exports.migrarOrcamento = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  requireAdmin(request);
  const snap = await db.collection('mentoradas').get();
  let migradas = 0, erros = 0, mesesMigrados = 0;

  for (const doc of snap.docs) {
    const { sheetId } = doc.data();
    if (!sheetId) continue;
    try {
      const sheets = new SheetsClient(sheetId);
      let rows;
      try {
        rows = await sheets.read('orcamento!A2:I');
      } catch { continue; }

      // Agrupa por mes+ano
      const porMes = {};
      for (const r of rows) {
        const m = parseInt(r[0]), a = parseInt(r[1]);
        if (!m || !a) continue;
        const key = `${a}-${String(m).padStart(2, '0')}`;
        if (!porMes[key]) porMes[key] = { mes: m, ano: a, itens: [] };
        porMes[key].itens.push({
          categoria: r[2] || '', tipo: r[3] || 'despesa',
          valor: parseFloat(r[4]) || 0,
          data: r[5] || '', descricao: r[6] || '',
          cartao: r[7] === '1', fatura: r[8] || '',
        });
      }

      for (const [key, data] of Object.entries(porMes)) {
        const ref = db.collection('mentoradas').doc(doc.id)
          .collection('orcamento').doc(key);
        const existing = await ref.get();
        if (!existing.exists) {
          await ref.set({
            uid: doc.id, mes: data.mes, ano: data.ano, itens: data.itens,
            atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
          });
          mesesMigrados++;
        }
      }
      migradas++;
    } catch (err) {
      console.error(`[migrarOrcamento] Erro em ${doc.id}:`, err.message);
      erros++;
    }
  }
  return { ok: true, migradas, mesesMigrados, erros };
});

// ─── PLANEJAMENTO DE ORÇAMENTO POR MÊS ───────────────────────────────────────
// Armazena o orçamento planejado por categoria para um mês específico.
// Coleção: mentoradas/{uid}/planejamento/{YYYY-MM}
// Documento: { categorias: [{ nome, limite }], atualizadoEm }

/**
 * Retorna o planejamento de categorias para um mês/ano específico.
 * Retorna array vazio se ainda não configurou.
 */
exports.getCategoriasMes = onCall(async (request) => {
  requireAuth(request);
  const { uid, mes, ano } = request.data;
  requireSelfOrAdmin(request, uid);

  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const snap = await db.collection('mentoradas').doc(uid)
    .collection('planejamento').doc(mesKey).get();
  if (!snap.exists) return { categorias: [] };
  return { categorias: snap.data().categorias || [] };
});

/**
 * Salva o planejamento de categorias para um mês/ano específico.
 * Espera: { uid, mes, ano, categorias: [{ nome, limite }] }
 */
exports.saveCategoriasMes = onCall(async (request) => {
  requireAuth(request);
  const { uid, mes, ano, categorias } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!Array.isArray(categorias)) throw new HttpsError('invalid-argument', 'categorias deve ser um array.');
  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  await db.collection('mentoradas').doc(uid)
    .collection('planejamento').doc(mesKey).set({
      categorias,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
  return { ok: true };
});

// ─── CATEGORIAS GLOBAIS (legacy — mantido para compatibilidade) ───────────────
exports.getCategorias = onCall(async (request) => {
  requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);
  const snap = await db.collection('mentoradas').doc(uid)
    .collection('config').doc('categorias').get();
  if (!snap.exists) return { categorias: [] };
  return { categorias: snap.data().categorias || [] };
});

exports.saveCategorias = onCall(async (request) => {
  requireAuth(request);
  const { uid, categorias } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!Array.isArray(categorias)) throw new HttpsError('invalid-argument', 'categorias deve ser um array.');
  await db.collection('mentoradas').doc(uid)
    .collection('config').doc('categorias').set({ categorias });
  return { ok: true };
});

// ─── PATRIMÔNIO (patrimonio.html) ─────────────────────────────────────────────

exports.getPatrimonio = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);

  // ── Firestore first ───────────────────────────────────────────────────────
  const docSnap = await db.collection('mentoradas').doc(uid)
    .collection('patrimonio').doc('dados').get();
  if (docSnap.exists) {
    const { ir = [], corretora = [], dividas = [] } = docSnap.data();
    return { ativos: consolidarAtivos(ir, corretora), dividas };
  }

  // ── Fallback: Sheets + auto-migra ────────────────────────────────────────
  const sheetId = await getSheetId(db, uid);
  if (!sheetId) return { ativos: [], dividas: [] };
  const sheets  = new SheetsClient(sheetId);
  const [ir, corretora, dividas] = await Promise.all([
    sheets.getPatrimonio(), sheets.getInvestimentos(), sheets.getDividas(),
  ]);
  // Persiste no Firestore para próximas leituras
  db.collection('mentoradas').doc(uid).collection('patrimonio').doc('dados')
    .set({ ir, corretora, dividas, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() })
    .catch(e => console.warn('[getPatrimonio] Falha ao migrar:', e.message));
  return { ativos: consolidarAtivos(ir, corretora), dividas };
});

exports.savePatrimonio = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, itens, tipo } = request.data; // tipo: 'ir' | 'corretora'
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'savePatrimonio', 10, 60_000); // 10/min

  // ── Validação ──────────────────────────────────────────────────────────────
  if (!Array.isArray(itens))
    throw new HttpsError('invalid-argument', 'itens deve ser um array.');
  if (!['ir', 'corretora'].includes(tipo))
    throw new HttpsError('invalid-argument', 'tipo deve ser "ir" ou "corretora".');
  if (itens.length > 200)
    throw new HttpsError('invalid-argument', 'Limite de 200 ativos excedido.');

  for (let i = 0; i < itens.length; i++) {
    const it = itens[i];
    if (!it.classe || typeof it.classe !== 'string' || it.classe.trim() === '')
      throw new HttpsError('invalid-argument', `Item ${i + 1}: classe é obrigatória.`);
    if (typeof it.valor !== 'number' || isNaN(it.valor) || it.valor < 0)
      throw new HttpsError('invalid-argument', `Item ${i + 1}: valor deve ser número não-negativo.`);
    if (it.valor > 100_000_000)
      throw new HttpsError('invalid-argument', `Item ${i + 1}: valor acima do limite permitido.`);
    if (it.classe.length > 200) it.classe = it.classe.slice(0, 200);
  }

  // ── Lê estado atual do Firestore (ou Sheets como fallback) ──────────────
  const patRef  = db.collection('mentoradas').doc(uid).collection('patrimonio').doc('dados');
  const patSnap = await patRef.get();
  let ir        = patSnap.exists ? (patSnap.data().ir       || []) : [];
  let corretora = patSnap.exists ? (patSnap.data().corretora || []) : [];
  let dividas   = patSnap.exists ? (patSnap.data().dividas   || []) : [];

  if (!patSnap.exists) {
    // Fallback Sheets
    try {
      const sheetId = await getSheetId(db, uid);
      if (sheetId) {
        const sheets = new SheetsClient(sheetId);
        [ir, corretora, dividas] = await Promise.all([
          sheets.getPatrimonio(), sheets.getInvestimentos(), sheets.getDividas(),
        ]);
      }
    } catch (e) { console.warn('[savePatrimonio] Fallback Sheets falhou:', e.message); }
  }

  // Aplica a atualização
  if (tipo === 'corretora') corretora = itens;
  else                      ir        = itens;

  await patRef.set({
    ir, corretora, dividas,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Backup no Sheets (fire-and-forget, não bloqueia resposta)
  getSheetId(db, uid).then(sheetId => {
    if (!sheetId) return;
    const sheets = new SheetsClient(sheetId);
    return tipo === 'corretora' ? sheets.saveInvestimentos(itens) : sheets.savePatrimonio(itens);
  }).catch(e => console.warn('[savePatrimonio] Backup Sheets falhou:', e.message));

  // Atualiza cache de PL
  const totalAtivos  = consolidarAtivos(ir, corretora).reduce((s, a) => s + a.valor, 0);
  const totalDividas = dividas.reduce((s, d) => s + d.saldo, 0);
  db.collection('mentoradas').doc(uid).update({
    pl: totalAtivos - totalDividas,
    dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.warn('[savePatrimonio] Cache PL falhou:', e.message));

  return { ok: true };
});

// ─── DÉBITO PROPORCIONAL DE PATRIMÔNIO (retirada de reservas) ────────────────

/**
 * Debita `valor` proporcionalmente de todos os ativos financeiros do usuário.
 * Opera de forma ATÔMICA: lê uma vez, aplica todos os débitos, salva uma vez.
 * Evita race condition de múltiplas chamadas simultâneas ao aportePatrimonio.
 */
// exports.debitarPatrimonio — removido do deploy (fluxo manual preferido; código mantido para referência)
const debitarPatrimonio = async (request) => { // eslint-disable-line no-unused-vars
  requireAuth(request);
  const { uid, valor } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!uid || typeof valor !== 'number' || valor <= 0) {
    throw new HttpsError('invalid-argument', 'uid e valor (positivo) são obrigatórios.');
  }

  const sheetId = await getSheetId(db, uid);
  const sheets  = new SheetsClient(sheetId);

  const [patrimonio, investimentos] = await Promise.all([
    sheets.getPatrimonio(),
    sheets.getInvestimentos(),
  ]);

  const CLASSES_NAO_FINANCEIRAS = new Set([
    'imoveis','imóveis','imovel','imóvel','imoveis e direitos','imóveis e direitos',
    'bens imoveis','bens imóveis','imovel residencial','imóvel residencial',
    'veiculos','veículos','veiculo','veículo','veiculos e embarcacoes','veículos e embarcações',
    'automovel','automóvel','carro','motocicleta','moto','caminhao','caminhão',
    'embarcacao','embarcação','lancha','barco','aeronave','aviao','avião',
    'joias','jóias','obras de arte','obra de arte','animais','semoventes','gado',
    'bens moveis','bens móveis','outros bens','outros bens e direitos',
  ]);

  // Consolida para identificar os ativos financeiros e seus valores
  const consolidado = consolidarAtivos(patrimonio, investimentos);
  const financeiros = consolidado.filter(a => {
    const lc = a.classe.toLowerCase();
    return !CLASSES_NAO_FINANCEIRAS.has(lc) && a.valor > 0;
  });

  const totalFin = financeiros.reduce((s, a) => s + a.valor, 0);
  if (totalFin <= 0) {
    throw new HttpsError('failed-precondition', 'Nenhum ativo financeiro encontrado no patrimônio.');
  }

  // Aplica débitos proporcionais — atualiza investimentos e patrimonio em memória
  let investimentosModificados = false;
  let patrimonioModificado = false;

  for (const ativo of financeiros) {
    const debito = -(valor * ativo.valor / totalFin);
    const classeLC = ativo.classe.toLowerCase();

    const idxInv = investimentos.findIndex(i => i.classe.toLowerCase() === classeLC);
    if (idxInv !== -1) {
      investimentos[idxInv].valor += debito;
      investimentosModificados = true;
    } else {
      const idxPat = patrimonio.findIndex(i => i.classe.toLowerCase() === classeLC);
      if (idxPat !== -1) {
        patrimonio[idxPat].valor += debito;
        patrimonioModificado = true;
      }
      // Se não encontrar (classe no consolidado mas não nas fontes), ignora
    }
  }

  // Salva cada fonte UMA ÚNICA VEZ (atômico — sem race condition)
  const saves = [];
  if (investimentosModificados) saves.push(sheets.saveInvestimentos(investimentos));
  if (patrimonioModificado)     saves.push(sheets.savePatrimonio(patrimonio));
  await Promise.all(saves);

  // Atualiza histórico com o novo total
  const consolidadoAtualizado = consolidarAtivos(patrimonio, investimentos);
  const totalAtivos = consolidadoAtualizado.reduce((s, i) => s + i.valor, 0);
  const data = hoje().slice(0, 7);
  await sheets.upsertHistorico(data, totalAtivos, 0);

  return { ok: true, debitado: valor };
}; // fim debitarPatrimonio (não exportado)

// ─── APORTE PATRIMÔNIO (orcamento.html) ──────────────────────────────────────

/**
 * Soma o valor aportado à classe indicada.
 * Prioridade: investimentos (posição corretora) > patrimônio (IR).
 * Assim o efeito é visível no consolidado exibido em patrimônio.html e reservas.html.
 */
exports.aportePatrimonio = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, classe, valor } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!classe || typeof valor !== 'number' || valor === 0) {
    throw new HttpsError('invalid-argument', 'classe e valor são obrigatórios.');
  }

  const patRef  = db.collection('mentoradas').doc(uid).collection('patrimonio').doc('dados');
  const patSnap = await patRef.get();
  let ir        = patSnap.exists ? (patSnap.data().ir        || []) : [];
  let corretora = patSnap.exists ? (patSnap.data().corretora || []) : [];
  let dividas   = patSnap.exists ? (patSnap.data().dividas   || []) : [];

  // Fallback Sheets se Firestore ainda não tem dados
  if (!patSnap.exists) {
    try {
      const sheetId = await getSheetId(db, uid);
      if (sheetId) {
        const sheets = new SheetsClient(sheetId);
        [ir, corretora, dividas] = await Promise.all([
          sheets.getPatrimonio(), sheets.getInvestimentos(), sheets.getDividas(),
        ]);
      }
    } catch (e) { console.warn('[aportePatrimonio] Fallback Sheets falhou:', e.message); }
  }

  const classeLC = classe.toLowerCase();

  // Corretora tem prioridade — atualiza lá se a classe já existir
  const idxInv = corretora.findIndex(i => i.classe.toLowerCase() === classeLC);
  if (idxInv !== -1) {
    corretora[idxInv].valor += valor;
  } else {
    const idxPat = ir.findIndex(i => i.classe.toLowerCase() === classeLC);
    if (idxPat !== -1) ir[idxPat].valor += valor;
    else               ir.push({ classe, valor });
  }

  // Salva no Firestore
  await patRef.set({
    ir, corretora, dividas,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Atualiza cache de PL + upsert histórico no Firestore
  const consolidado = consolidarAtivos(ir, corretora);
  const totalAtivos = consolidado.reduce((s, i) => s + i.valor, 0);
  const totalDividas = dividas.reduce((s, d) => s + d.saldo, 0);
  const mesKey = hoje().slice(0, 7);
  await Promise.allSettled([
    db.collection('mentoradas').doc(uid).update({
      pl: totalAtivos - totalDividas,
      dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    }),
    db.collection('mentoradas').doc(uid).collection('historico').doc(mesKey).set({
      data: mesKey, ativos: totalAtivos, dividas: totalDividas,
      pl: totalAtivos - totalDividas,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }),
  ]);

  // Backup Sheets (fire-and-forget)
  getSheetId(db, uid).then(sheetId => {
    if (!sheetId) return;
    const sheets = new SheetsClient(sheetId);
    return Promise.all([
      sheets.saveInvestimentos(corretora),
      sheets.savePatrimonio(ir),
      sheets.upsertHistorico(mesKey, totalAtivos, totalDividas),
    ]);
  }).catch(e => console.warn('[aportePatrimonio] Backup Sheets falhou:', e.message));

  return { ok: true };
});

// ─── HISTÓRICO DE PL ─────────────────────────────────────────────────────────

exports.getHistoricoPatrimonio = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);

  // ── Firestore first ───────────────────────────────────────────────────────
  const snap = await db.collection('mentoradas').doc(uid)
    .collection('historico').orderBy('data', 'asc').limit(12).get();
  if (!snap.empty) {
    return snap.docs.map(d => ({ data: d.id, ...d.data() }));
  }

  // ── Fallback Sheets + auto-migra ──────────────────────────────────────────
  const sheetId = await getSheetId(db, uid);
  if (!sheetId) return [];
  const historico = await new SheetsClient(sheetId).getHistorico();
  // Persiste no Firestore
  const batch = db.batch();
  historico.forEach(h => {
    if (!h.data) return;
    const ref = db.collection('mentoradas').doc(uid).collection('historico').doc(h.data);
    batch.set(ref, { ...h, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
  batch.commit().catch(e => console.warn('[getHistorico] Falha ao migrar:', e.message));
  return historico;
});

/**
 * Grava (ou atualiza) o snapshot mensal de ativos/dívidas/PL.
 * Chamado pelo frontend após qualquer alteração de patrimônio.
 * Espera: { uid, ativos: number, dividas: number }
 */
exports.upsertHistoricoPatrimonio = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, ativos, dividas } = request.data;
  requireSelfOrAdmin(request, uid);

  const mesKey = hoje().slice(0, 7);
  const pl = (ativos ?? 0) - (dividas ?? 0);

  // Firestore primary
  await db.collection('mentoradas').doc(uid).collection('historico').doc(mesKey).set({
    data: mesKey, ativos: ativos ?? 0, dividas: dividas ?? 0, pl,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  // Backup Sheets (fire-and-forget)
  getSheetId(db, uid).then(sheetId => {
    if (!sheetId) return;
    return new SheetsClient(sheetId).upsertHistorico(mesKey, ativos ?? 0, dividas ?? 0);
  }).catch(e => console.warn('[upsertHistorico] Backup Sheets:', e.message));

  return { ok: true };
});

// ─── DÍVIDAS ──────────────────────────────────────────────────────────────────

exports.saveDivida = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, divida } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!divida?.id || !divida?.nome)
    throw new HttpsError('invalid-argument', 'id e nome são obrigatórios.');

  await checkRateLimit(uid, 'saveDivida', 10, 60_000);

  // Lê estado atual do Firestore
  const patRef  = db.collection('mentoradas').doc(uid).collection('patrimonio').doc('dados');
  const patSnap = await patRef.get();
  let ir        = patSnap.exists ? (patSnap.data().ir        || []) : [];
  let corretora = patSnap.exists ? (patSnap.data().corretora || []) : [];
  let dividas   = patSnap.exists ? (patSnap.data().dividas   || []) : [];

  // Upsert da dívida
  const idx = dividas.findIndex(d => d.id === divida.id);
  if (idx !== -1) dividas[idx] = divida;
  else            dividas.push(divida);

  await patRef.set({ ir, corretora, dividas, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });

  // Atualiza cache PL
  const totalAtivos  = consolidarAtivos(ir, corretora).reduce((s, a) => s + a.valor, 0);
  const totalDividas = dividas.reduce((s, d) => s + d.saldo, 0);
  db.collection('mentoradas').doc(uid).update({
    pl: totalAtivos - totalDividas,
    dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.warn('[saveDivida] Cache PL:', e.message));

  // Backup Sheets
  getSheetId(db, uid).then(sheetId => {
    if (!sheetId) return;
    return new SheetsClient(sheetId).saveDivida(divida);
  }).catch(e => console.warn('[saveDivida] Backup Sheets:', e.message));

  return { ok: true };
});

exports.deleteDivida = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, dividaId } = request.data;
  requireSelfOrAdmin(request, uid);

  const patRef  = db.collection('mentoradas').doc(uid).collection('patrimonio').doc('dados');
  const patSnap = await patRef.get();
  if (patSnap.exists) {
    const data = patSnap.data();
    const dividas = (data.dividas || []).filter(d => d.id !== dividaId);
    await patRef.update({ dividas, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });
  }

  // Backup Sheets
  getSheetId(db, uid).then(sheetId => {
    if (!sheetId) return;
    return new SheetsClient(sheetId).deleteDivida(dividaId);
  }).catch(e => console.warn('[deleteDivida] Backup Sheets:', e.message));

  return { ok: true };
});

// ─── RESERVAS (reservas.html) ─────────────────────────────────────────────────

exports.getReservas = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);

  // ── Firestore first ───────────────────────────────────────────────────────
  const snap = await db.collection('mentoradas').doc(uid)
    .collection('reservas').orderBy('criadoEm', 'asc').get();
  if (!snap.empty) {
    return snap.docs.map(d => ({ ...d.data(), id: d.id }));
  }

  // ── Fallback Sheets + auto-migra ──────────────────────────────────────────
  const sheetId = await getSheetId(db, uid);
  if (!sheetId) return [];
  const reservas = await new SheetsClient(sheetId).getReservas();
  // Persiste no Firestore
  const batch = db.batch();
  reservas.forEach(r => {
    if (!r.id) return;
    const ref = db.collection('mentoradas').doc(uid).collection('reservas').doc(String(r.id));
    batch.set(ref, { ...r, criadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
  batch.commit().catch(e => console.warn('[getReservas] Falha ao migrar:', e.message));
  return reservas;
});

exports.saveReserva = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, reserva } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!reserva?.id || !reserva?.nome)
    throw new HttpsError('invalid-argument', 'id e nome são obrigatórios.');

  await checkRateLimit(uid, 'saveReserva', 10, 60_000);

  // Firestore primary
  await db.collection('mentoradas').doc(uid).collection('reservas').doc(String(reserva.id)).set({
    ...reserva,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    criadoEm:     admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  // Atualiza cache totalReservas
  const snap = await db.collection('mentoradas').doc(uid).collection('reservas').get();
  const totalReservas = snap.docs.reduce((s, d) => s + (d.data().acumulado || 0), 0);
  db.collection('mentoradas').doc(uid).update({
    totalReservas, dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});

  // Backup Sheets
  getSheetId(db, uid).then(sheetId => {
    if (!sheetId) return;
    return new SheetsClient(sheetId).saveReserva(reserva);
  }).catch(e => console.warn('[saveReserva] Backup Sheets:', e.message));

  return { ok: true };
});

exports.deleteReserva = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, reservaId } = request.data;
  requireSelfOrAdmin(request, uid);

  // Firestore primary
  await db.collection('mentoradas').doc(uid).collection('reservas').doc(String(reservaId)).delete();

  // Atualiza cache totalReservas
  const snap = await db.collection('mentoradas').doc(uid).collection('reservas').get();
  const totalReservas = snap.docs.reduce((s, d) => s + (d.data().acumulado || 0), 0);
  db.collection('mentoradas').doc(uid).update({
    totalReservas, dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});

  // Backup Sheets
  getSheetId(db, uid).then(sheetId => {
    if (!sheetId) return;
    return new SheetsClient(sheetId).deleteReserva(reservaId);
  }).catch(e => console.warn('[deleteReserva] Backup Sheets:', e.message));

  return { ok: true };
});

// ─── PERFIL DE INVESTIDOR (perfil.html) ───────────────────────────────────────

exports.getPerfil = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);

  // ── Firestore first ───────────────────────────────────────────────────────
  const snap = await db.collection('mentoradas').doc(uid)
    .collection('perfil').doc('dados').get();
  if (snap.exists) return snap.data();

  // ── Fallback Sheets + auto-migra ──────────────────────────────────────────
  const sheetId = await getSheetId(db, uid);
  if (!sheetId) return null;
  const perfilData = await new SheetsClient(sheetId).getPerfil();
  if (perfilData?.perfil) {
    db.collection('mentoradas').doc(uid).collection('perfil').doc('dados')
      .set({ ...perfilData, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
      .catch(() => {});
  }
  return perfilData;
});

exports.savePerfil = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, perfil } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!perfil) throw new HttpsError('invalid-argument', 'perfil é obrigatório.');

  const dataAtualizacao = hoje();

  // Firestore primary
  await db.collection('mentoradas').doc(uid).collection('perfil').doc('dados').set({
    perfil, dataAtualizacao,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Espelha no doc principal (para getDashboard e alertas de renovação)
  await db.collection('mentoradas').doc(uid).update({
    perfil: { perfil, dataAtualizacao },
  });

  // Backup Sheets
  getSheetId(db, uid).then(sheetId => {
    if (!sheetId) return;
    return new SheetsClient(sheetId).savePerfil(perfil, dataAtualizacao);
  }).catch(e => console.warn('[savePerfil] Backup Sheets:', e.message));

  return { ok: true };
});

// ─── ADMIN — Mentoradas (admin.html) ──────────────────────────────────────────

/**
 * Retorna a lista de todas as mentoradas com dados resumidos.
 * Exclusivo para admin.
 */
exports.getMentoradas = onCall({}, async (request) => {
  requireAdmin(request);

  const snap = await db.collection('mentoradas').orderBy('nome').get();
  return snap.docs.map(doc => ({ uid: doc.id, ...doc.data() }));
});

/**
 * Cria conta Firebase Auth + documento Firestore + planilha Sheets para nova mentorada.
 * Exclusivo para admin.
 */
exports.createMentorada = onCall({ secrets: SECRETS_ALL }, async (request) => {
  requireAdmin(request);

  const { nome, email, inicio, perfil, produto, valorMensal, formaPagamento, dataExpiracao } = request.data;
  if (!nome || !email) throw new HttpsError('invalid-argument', 'nome e email são obrigatórios.');

  // 1. Criar usuária no Firebase Auth
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email,
      displayName: nome,
      password: gerarSenhaTemporaria(),
      emailVerified: false,
    });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'Já existe uma conta com esse e-mail.');
    }
    throw new HttpsError('internal', `Erro ao criar usuária: ${err.message}`);
  }

  // 2. Criar planilha no Google Sheets (falha não bloqueia criação da conta)
  let sheetId = null;
  try {
    sheetId = await provisionar(nome, DRIVE_FOLDER_ID);
  } catch (err) {
    console.error(`[createMentorada] Falha ao criar planilha para ${email}:`, err.message);
    // Continua — planilha pode ser criada/vinculada manualmente depois
  }

  // 3. Salvar no Firestore
  await db.collection('mentoradas').doc(userRecord.uid).set({
    nome,
    email,
    inicio:          inicio          || hoje().slice(0, 7),
    perfil:          perfil          || null,
    produto:         produto         || null,
    valorMensal:     valorMensal     || null,
    formaPagamento:  formaPagamento  || null,
    dataExpiracao:   dataExpiracao   || null,
    status:          'ativa',
    sheetId:         sheetId || null,
    nota:            '',
    ultimoAcesso:    null,
    totalAcessos:    0,
    lgpdAceite:      false,
    lgpdAceiteData:  null,
    criadoEm:        admin.firestore.FieldValue.serverTimestamp(),
  });

  // 4. Gerar link + enviar e-mail de boas-vindas (falha não bloqueia criação)
  let emailEnviado = false;
  let emailErro    = null;
  try {
    const linkSenha = await admin.auth().generatePasswordResetLink(email);
    await sendEmail({
      to:      email,
      subject: 'Bem-vinda ao Trilogia Dashboard',
      html:    emailBoasVindas(nome, linkSenha),
    });
    emailEnviado = true;
  } catch (err) {
    emailErro = err.message;
    console.error(`[createMentorada] Falha ao enviar e-mail de boas-vindas para ${email}:`, err.message);
    // Conta criada com sucesso — admin pode reenviar o link manualmente pelo painel
  }

  return { uid: userRecord.uid, sheetId, emailEnviado, emailErro };
});

/**
 * Provisiona planilha para mentorada que ainda não tem sheetId.
 * Exclusivo para admin.
 */
exports.criarPlanilha = onCall({ secrets: SECRETS_ALL }, async (request) => {
  requireAdmin(request);
  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  const docRef  = db.collection('mentoradas').doc(uid);
  const docSnap = await docRef.get();
  if (!docSnap.exists) throw new HttpsError('not-found', 'Mentorada não encontrada.');

  const { sheetId: existente, nome } = docSnap.data();
  if (existente) throw new HttpsError('already-exists', 'Esta mentorada já tem planilha vinculada.');

  let sheetId;
  try {
    sheetId = await provisionar(nome, DRIVE_FOLDER_ID);
  } catch (err) {
    console.error('[criarPlanilha] Erro no provisionar:', err.message, err.stack);
    throw new HttpsError('internal', `Falha ao criar planilha: ${err.message}`);
  }
  await docRef.update({ sheetId });
  return { sheetId };
});

/**
 * Atualiza campos editáveis de uma mentorada (status, nota, perfil).
 * Exclusivo para admin.
 */
exports.updateMentorada = onCall({}, async (request) => {
  requireAdmin(request);

  const { uid, campos } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  const permitidos = [
    'status', 'nota', 'perfil', 'inicio',
    'produto', 'valorMensal', 'formaPagamento', 'dataExpiracao',
    'mentoriaEncerrada', 'assinaturaDashboard', 'assinaturaClube',
    'notionLicoesPendentes',
  ];
  const atualizacao = {};
  for (const [k, v] of Object.entries(campos || {})) {
    // Ignora undefined e null — Firebase pode descartar nulos na serialização callable
    if (permitidos.includes(k) && v !== undefined && v !== null) atualizacao[k] = v;
  }

  if (Object.keys(atualizacao).length === 0) {
    throw new HttpsError('invalid-argument', 'Nenhum campo válido para atualizar.');
  }

  await db.collection('mentoradas').doc(uid).update(atualizacao);
  return { ok: true };
});

/**
 * Bloqueia o acesso de uma mentorada (desabilita no Firebase Auth).
 * Exclusivo para admin.
 */
exports.bloquearMentorada = onCall({}, async (request) => {
  requireAdmin(request);

  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  await admin.auth().updateUser(uid, { disabled: true });
  await db.collection('mentoradas').doc(uid).update({ status: 'inativa' });
  return { ok: true };
});

/**
 * Reativa o acesso de uma mentorada.
 * Exclusivo para admin.
 */
exports.reativarMentorada = onCall({}, async (request) => {
  requireAdmin(request);

  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  await admin.auth().updateUser(uid, { disabled: false });
  await db.collection('mentoradas').doc(uid).update({ status: 'ativa' });
  return { ok: true };
});

/**
 * Remove permanentemente a mentorada: apaga a conta do Firebase Auth
 * e o documento Firestore. A planilha no Google Drive não é removida
 * automaticamente (pode ser feita manualmente se necessário).
 * Exclusivo para admin.
 */
exports.deletarMentorada = onCall({}, async (request) => {
  requireAdmin(request);

  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  // Lê dados antes de apagar (audit log LGPD + preservar sheetId)
  const docSnap = await db.collection('mentoradas').doc(uid).get();
  const docData = docSnap.exists ? docSnap.data() : {};

  // Apaga conta Auth (ignora se já não existir)
  try {
    await admin.auth().deleteUser(uid);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') {
      throw new HttpsError('internal', `Erro ao remover conta: ${err.message}`);
    }
  }

  // Apaga cobranças (coleção raiz)
  try {
    const cobsSnap = await db.collection('cobrancas').where('uidMentorada', '==', uid).get();
    if (!cobsSnap.empty) {
      const batch = db.batch();
      cobsSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (err) {
    console.warn(`[deletarMentorada] Falha ao remover cobranças de ${uid}:`, err.message);
  }

  // Apaga contratos (subcoleção)
  try {
    const contratosSnap = await db.collection('mentoradas').doc(uid)
      .collection('contratos').get();
    if (!contratosSnap.empty) {
      const batch = db.batch();
      contratosSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (err) {
    console.warn(`[deletarMentorada] Falha ao remover contratos de ${uid}:`, err.message);
  }

  // Audit log LGPD: registra deleção para rastreabilidade e para agendar limpeza da planilha
  // Planilha é mantida 12 meses para possibilitar reativação, depois apagada por limparDadosExpirados
  try {
    await db.collection('mentoradas_deletadas').doc(uid).set({
      nome:            docData.nome            || null,
      email:           docData.email           || null,
      produto:         docData.produto         || null,
      inicio:          docData.inicio          || null,
      sheetId:         docData.sheetId         || null,
      planilhaApagada: false,
      deletadoEm:      admin.firestore.FieldValue.serverTimestamp(),
      deletadoPor:     request.auth?.uid       || 'admin',
    });
  } catch (err) {
    // Não bloqueia a deleção — apenas registra o problema
    console.warn(`[deletarMentorada] Falha ao criar audit log para ${uid}:`, err.message);
  }

  // Apaga documento principal
  try {
    await db.collection('mentoradas').doc(uid).delete();
  } catch (err) {
    throw new HttpsError('internal', `Erro ao remover dados: ${err.message}`);
  }

  return { ok: true };
});

/**
 * Reenvía o link de acesso (definição de senha) para a mentorada.
 * Útil quando o e-mail inicial caiu no spam ou o link expirou.
 * Exclusivo para admin.
 */
exports.reenviarAcesso = onCall({ secrets: ['GMAIL_APP_PASSWORD'] }, async (request) => {
  requireAdmin(request);

  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  const userRecord = await admin.auth().getUser(uid);
  if (!userRecord.email) throw new HttpsError('failed-precondition', 'Mentorada sem e-mail cadastrado.');

  // Gera link de redefinição de senha
  let link;
  try {
    link = await admin.auth().generatePasswordResetLink(userRecord.email);
  } catch (err) {
    throw new HttpsError('failed-precondition', `Erro ao gerar link: ${err.message}`);
  }

  // Tenta enviar e-mail; se falhar, retorna o link para envio manual
  try {
    const snap = await db.collection('mentoradas').doc(uid).get();
    const nome = snap.exists ? (snap.data().nome || userRecord.displayName || 'Mentorada') : (userRecord.displayName || 'Mentorada');
    await sendEmail({
      to: userRecord.email,
      subject: 'Seu link de acesso — Trilogia Dashboard',
      html: emailReenvioAcesso(nome, link),
    });
    return { ok: true, emailEnviado: true };
  } catch (err) {
    // E-mail falhou mas link foi gerado — retorna link para o admin enviar manualmente
    console.error('[reenviarAcesso] Erro no e-mail:', err.message);
    return { ok: true, emailEnviado: false, link, email: userRecord.email };
  }
});

/**
 * Registra acesso da aluna: atualiza ultimoAcesso e incrementa contadores.
 * Chamado pelo client no load do dashboard.
 */
exports.registrarAcesso = onCall({}, async (request) => {
  const auth = requireAuth(request);
  const uid  = auth.uid;

  const agora = admin.firestore.FieldValue.serverTimestamp();
  const mesAtual = new Date().toISOString().slice(0, 7); // YYYY-MM

  const docRef = db.collection('mentoradas').doc(uid);
  const snap   = await docRef.get();
  if (!snap.exists) return { ok: true }; // segurança

  const dados = snap.data();
  const ultimoMes = (dados.ultimoAcessoMes || '');

  await docRef.update({
    ultimoAcesso:  agora,
    totalAcessos:  admin.firestore.FieldValue.increment(1),
    // Reinicia contador mensal se mudou o mês
    acessosMes:    ultimoMes === mesAtual
      ? admin.firestore.FieldValue.increment(1)
      : 1,
    ultimoAcessoMes: mesAtual,
  });
  return { ok: true };
});

/**
 * Registra um evento de uso de feature (analytics de engajamento).
 * Espera: { evento } — string, ex: 'csv_importado', 'aporte_registrado', etc.
 * Incrementa contador acumulado + mensal no doc analytics/geral e analytics/YYYY-MM.
 */
const EVENTOS_VALIDOS = new Set([
  'csv_importado', 'aporte_registrado', 'patrimonio_atualizado',
  'reserva_salva', 'perfil_atualizado', 'planejamento_configurado',
  'fixa_cadastrada', 'cartao_cadastrado',
]);

exports.registrarEvento = onCall({}, async (request) => {
  const auth = requireAuth(request);
  const { evento } = request.data;
  if (!evento || !EVENTOS_VALIDOS.has(evento)) return { ok: true }; // ignora silenciosamente

  const uid    = auth.uid;
  const mesKey = new Date().toISOString().slice(0, 7); // YYYY-MM
  const inc    = admin.firestore.FieldValue.increment(1);
  const ts     = admin.firestore.FieldValue.serverTimestamp();

  const base = db.collection('mentoradas').doc(uid).collection('analytics');
  await Promise.allSettled([
    // Acumulado total
    base.doc('geral').set({
      [`eventos.${evento}`]: inc,
      ultimoEventoEm: ts,
    }, { merge: true }),
    // Breakdown mensal
    base.doc(mesKey).set({
      [`eventos.${evento}`]: inc,
      mes: mesKey,
      ultimoEventoEm: ts,
    }, { merge: true }),
  ]);

  return { ok: true };
});

/**
 * Registra aceite do termo LGPD pela aluna.
 */
exports.aceitarLGPD = onCall({}, async (request) => {
  const auth = requireAuth(request);
  await db.collection('mentoradas').doc(auth.uid).update({
    lgpdAceite:     true,
    lgpdAceiteData: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

// ─── PUSH NOTIFICATIONS ──────────────────────────────────────────────────────

/**
 * Salva ou atualiza a subscription de push de uma mentorada.
 * Espera: { subscription } — objeto PushSubscription serializado pelo browser.
 */
exports.savePushSubscription = onCall({}, async (request) => {
  const auth = requireAuth(request);
  const { subscription } = request.data;

  if (!subscription?.endpoint) throw new HttpsError('invalid-argument', 'subscription inválida.');

  // Usa hash do endpoint como ID do doc (idempotente — mesmo browser não duplica)
  const id = Buffer.from(subscription.endpoint).toString('base64').slice(-40).replace(/[^a-zA-Z0-9]/g, '_');
  await db.collection('mentoradas').doc(auth.uid)
    .collection('pushSubscriptions').doc(id).set({
      ...subscription,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
  return { ok: true };
});

/**
 * Remove a subscription de push do dispositivo atual.
 * Espera: { endpoint }
 */
exports.deletePushSubscription = onCall({}, async (request) => {
  const auth = requireAuth(request);
  const { endpoint } = request.data;
  if (!endpoint) throw new HttpsError('invalid-argument', 'endpoint obrigatório.');

  const id = Buffer.from(endpoint).toString('base64').slice(-40).replace(/[^a-zA-Z0-9]/g, '_');
  await db.collection('mentoradas').doc(auth.uid)
    .collection('pushSubscriptions').doc(id).delete();
  return { ok: true };
});

// ─── EXPORTAÇÃO DE DADOS (LGPD — direito à portabilidade) ────────────────────

/**
 * Retorna todos os dados pessoais da usuária em formato estruturado.
 * LGPD Art. 18, inciso V: direito à portabilidade dos dados.
 * Inclui: conta, orçamento (todos os meses), patrimônio, investimentos,
 *         dívidas, reservas e perfil de investidor.
 */
exports.exportarMeusDados = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const uid  = request.data?.uid || auth.uid;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'exportarMeusDados', 3, 3_600_000); // 3/hora

  // Dados do Firestore
  const docSnap = await db.collection('mentoradas').doc(uid).get();
  if (!docSnap.exists) throw new HttpsError('not-found', 'Usuária não encontrada.');
  const conta = docSnap.data();

  // Orçamento: todos os meses no Firestore
  const orcSnap = await db.collection('mentoradas').doc(uid)
    .collection('orcamento').orderBy('__name__').get();
  const orcamento = orcSnap.docs.map(d => ({
    periodo: d.id,
    ...d.data(),
    atualizadoEm: d.data().atualizadoEm?.toDate?.()?.toISOString() || null,
  }));

  // Dados das Sheets (patrimônio, reservas, dívidas, perfil)
  let patrimonio = [], investimentos = [], dividas = [], reservas = [], perfil = null;
  const sheetId = conta.sheetId;
  if (sheetId) {
    const sheets = new SheetsClient(sheetId);
    [patrimonio, investimentos, dividas, reservas, perfil] = await Promise.allSettled([
      sheets.getPatrimonio(),
      sheets.getInvestimentos(),
      sheets.getDividas(),
      sheets.getReservas(),
      sheets.getPerfil(),
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));
  }

  return {
    exportadoEm: new Date().toISOString(),
    conta: {
      nome:           conta.nome,
      email:          conta.email,
      inicio:         conta.inicio,
      produto:        conta.produto,
      lgpdAceite:     conta.lgpdAceite,
      lgpdAceiteData: conta.lgpdAceiteData?.toDate?.()?.toISOString() || null,
    },
    orcamento,
    patrimonio:     patrimonio   || [],
    investimentos:  investimentos || [],
    dividas:        dividas      || [],
    reservas:       reservas     || [],
    perfil:         perfil       || null,
  };
});

// ─── ADMIN — Bootstrap inicial ───────────────────────────────────────────────

/**
 * Auto-configura a claim admin=true para a conta master (flaviasch@gmail.com).
 * Chamado uma vez pelo próprio usuário master quando ainda não tem a claim.
 * Não exige claim prévia — verifica o e-mail diretamente no token JWT.
 */
const ADMIN_MASTER_EMAIL = 'flaviasch@gmail.com';

exports.bootstrapAdmin = onCall({}, async (request) => {
  const auth = requireAuth(request);
  if (auth.token.email !== ADMIN_MASTER_EMAIL) {
    throw new HttpsError('permission-denied', 'Endpoint reservado para a conta master.');
  }
  const uid  = auth.uid;
  const user = await admin.auth().getUser(uid);
  const claimsAtuais = user.customClaims || {};
  await admin.auth().setCustomUserClaims(uid, { ...claimsAtuais, admin: true });
  return { ok: true };
});

// ─── ADMIN — Custom Claims ────────────────────────────────────────────────────

/**
 * Concede ou revoga o acesso admin de uma conta.
 * Só pode ser chamado por quem já é admin.
 * Após executar, o usuário alvo precisa fazer logout/login para o token atualizar.
 *
 * Uso: { uid, conceder: true } ou { uid, conceder: false }
 */
exports.setAdminClaim = onCall({}, async (request) => {
  requireAdmin(request);

  const { uid, conceder } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  if (uid === request.auth.uid && conceder === false) {
    throw new HttpsError('failed-precondition', 'Você não pode remover seu próprio acesso admin.');
  }

  const user         = await admin.auth().getUser(uid);
  const claimsAtuais = user.customClaims || {};
  await admin.auth().setCustomUserClaims(uid, { ...claimsAtuais, admin: conceder === true });

  return { ok: true, uid, admin: conceder === true };
});

// ─── MULTI-ADMIN ──────────────────────────────────────────────────────────────

/**
 * Lista todos os admins cadastrados (doc config/admins).
 */
exports.getAdmins = onCall({}, async (request) => {
  requireAdmin(request);
  const snap = await db.collection('config').doc('admins').get();
  return snap.exists ? (snap.data().lista || []) : [];
});

/**
 * Adiciona um novo admin por e-mail.
 * Espera: { email, nome }
 * Só o master (ADMIN_MASTER_EMAIL) pode conceder acesso admin.
 */
exports.addAdmin = onCall({}, async (request) => {
  const auth = requireAdmin(request);
  if (request.auth?.token?.email !== ADMIN_MASTER_EMAIL) {
    throw new HttpsError('permission-denied', 'Apenas a conta master pode adicionar admins.');
  }

  const { email, nome } = request.data;
  if (!email) throw new HttpsError('invalid-argument', 'email é obrigatório.');

  // Busca o usuário pelo e-mail no Firebase Auth
  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(email);
  } catch {
    throw new HttpsError('not-found', `Nenhuma conta encontrada com o e-mail ${email}. O usuário precisa ter feito login ao menos uma vez.`);
  }

  // Concede custom claim admin
  const claims = userRecord.customClaims || {};
  await admin.auth().setCustomUserClaims(userRecord.uid, { ...claims, admin: true });

  // Registra na lista de admins
  const configRef = db.collection('config').doc('admins');
  const snap = await configRef.get();
  const lista = snap.exists ? (snap.data().lista || []) : [];
  if (!lista.find(a => a.email === email)) {
    lista.push({ email, nome: nome || email, uid: userRecord.uid, addedAt: new Date().toISOString() });
    await configRef.set({ lista });
  }

  return { ok: true, uid: userRecord.uid };
});

/**
 * Remove um admin por uid.
 * Só o master pode remover. Não pode remover a si mesmo.
 */
exports.removeAdmin = onCall({}, async (request) => {
  requireAdmin(request);
  if (request.auth?.token?.email !== ADMIN_MASTER_EMAIL) {
    throw new HttpsError('permission-denied', 'Apenas a conta master pode remover admins.');
  }

  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  const userRecord = await admin.auth().getUser(uid);
  if (userRecord.email === ADMIN_MASTER_EMAIL) {
    throw new HttpsError('failed-precondition', 'Não é possível remover a conta master.');
  }

  // Revoga claim
  const claims = userRecord.customClaims || {};
  await admin.auth().setCustomUserClaims(uid, { ...claims, admin: false });

  // Remove da lista
  const configRef = db.collection('config').doc('admins');
  const snap = await configRef.get();
  if (snap.exists) {
    const lista = (snap.data().lista || []).filter(a => a.uid !== uid);
    await configRef.update({ lista });
  }

  return { ok: true };
});

// ─── CONTRATOS & COBRANÇAS ───────────────────────────────────────────────────

const ADMIN_EMAIL       = 'flaviasch@gmail.com';
const PRODUTOS_RECORRENTES = ['clube', 'dashboard', 'combo'];

/** Avança uma data YYYY-MM-DD por uma periodicidade. */
function proximoVencimento(iso, periodicidade) {
  const d = new Date(iso + 'T12:00:00Z');
  if (periodicidade === 'mensal') d.setUTCMonth(d.getUTCMonth() + 1);
  else                            d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Cria um contrato e suas parcelas (cobrancas).
 * Para parcelado: recebe array de { valor, vencimento }.
 * Para recorrente: recebe { valor, vencimento } (só a primeira parcela).
 */
exports.createContrato = onCall({}, async (request) => {
  requireAdmin(request);
  const { uid, produto, tipo, periodicidade, formaPagamento, parcelas } = request.data;
  if (!uid || !produto || !tipo || !formaPagamento || !parcelas?.length) {
    throw new HttpsError('invalid-argument', 'Campos obrigatórios ausentes.');
  }

  const mDoc = await db.collection('mentoradas').doc(uid).get();
  if (!mDoc.exists) throw new HttpsError('not-found', 'Mentorada não encontrada.');
  const { nome, email } = mDoc.data();

  const valorTotal = parcelas.reduce((s, p) => s + (p.valor || 0), 0);
  const contratoRef = db.collection('mentoradas').doc(uid).collection('contratos').doc();

  const batch = db.batch();
  batch.set(contratoRef, {
    produto, tipo,
    periodicidade: tipo === 'recorrente' ? (periodicidade || 'mensal') : null,
    valorTotal, formaPagamento, status: 'ativo',
    criadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  parcelas.forEach((p, i) => {
    const cobRef = db.collection('cobrancas').doc();
    batch.set(cobRef, {
      uidMentorada: uid, nomeAluna: nome, emailAluna: email,
      contratoId: contratoRef.id, produto, formaPagamento,
      tipo, periodicidade: tipo === 'recorrente' ? (periodicidade || 'mensal') : null,
      numero: i + 1, total: parcelas.length,
      valor: p.valor, vencimento: p.vencimento,
      pago: false, dataPagamento: null, valorRecebido: null,
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  await batch.commit();
  return { contratoId: contratoRef.id };
});

/**
 * Lista contratos de uma mentorada com suas cobranças.
 */
exports.getContratos = onCall({}, async (request) => {
  requireAdmin(request);
  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid obrigatório.');

  const contratosSnap = await db.collection('mentoradas').doc(uid)
    .collection('contratos').orderBy('criadoEm', 'desc').get();

  const contratos = [];
  for (const doc of contratosSnap.docs) {
    const cobSnap = await db.collection('cobrancas')
      .where('uidMentorada', '==', uid)
      .where('contratoId', '==', doc.id)
      .orderBy('numero').get();
    contratos.push({
      id: doc.id,
      ...doc.data(),
      parcelas: cobSnap.docs.map(c => ({ id: c.id, ...c.data() })),
    });
  }
  return contratos;
});

/**
 * Registra pagamento de uma parcela (cobrança).
 * Para recorrente: gera próxima cobrança automaticamente.
 * Para dashboard/clube recorrente: atualiza dataExpiracao da mentorada.
 */
exports.pagarParcela = onCall({}, async (request) => {
  requireAdmin(request);
  const { cobrancaId, dataPagamento, valorRecebido } = request.data;
  if (!cobrancaId || !dataPagamento || valorRecebido == null) {
    throw new HttpsError('invalid-argument', 'cobrancaId, dataPagamento e valorRecebido são obrigatórios.');
  }

  const cobRef  = db.collection('cobrancas').doc(cobrancaId);
  const cobSnap = await cobRef.get();
  if (!cobSnap.exists) throw new HttpsError('not-found', 'Cobrança não encontrada.');
  const cob = cobSnap.data();
  if (cob.pago) throw new HttpsError('failed-precondition', 'Esta cobrança já foi paga.');

  await cobRef.update({ pago: true, dataPagamento, valorRecebido });

  // Ativa flags de acesso conforme produto pago (espelha lógica do kiwifyWebhook)
  const ehClube     = cob.produto === 'clube'     || cob.produto === 'combo';
  const ehDashboard = cob.produto === 'dashboard' || cob.produto === 'combo';
  if (ehClube || ehDashboard) {
    const flagUpdates = {};
    if (ehClube)     flagUpdates.assinaturaClube     = true;
    if (ehDashboard) flagUpdates.assinaturaDashboard = true;
    await db.collection('mentoradas').doc(cob.uidMentorada).update(flagUpdates);
  }

  // Recorrente: gera próxima cobrança
  if (cob.tipo === 'recorrente') {
    const proxVenc = proximoVencimento(cob.vencimento, cob.periodicidade);

    await db.collection('cobrancas').add({
      uidMentorada:  cob.uidMentorada,
      nomeAluna:     cob.nomeAluna,
      emailAluna:    cob.emailAluna,
      contratoId:    cob.contratoId,
      produto:       cob.produto,
      formaPagamento: cob.formaPagamento,
      tipo:          'recorrente',
      periodicidade: cob.periodicidade,
      numero:        cob.numero + 1,
      total:         cob.total,
      valor:         cob.valor,
      vencimento:    proxVenc,
      pago: false, dataPagamento: null, valorRecebido: null,
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Atualiza dataExpiracao para produtos de acesso
    if (PRODUTOS_RECORRENTES.includes(cob.produto)) {
      await db.collection('mentoradas').doc(cob.uidMentorada).update({
        dataExpiracao: proxVenc,
      });
    }
  }

  // Verifica se todas as parcelas do contrato estão pagas (parcelado)
  if (cob.tipo === 'parcelado') {
    const abertas = await db.collection('cobrancas')
      .where('contratoId', '==', cob.contratoId)
      .where('pago', '==', false)
      .get();
    if (abertas.empty) {
      // Quita o contrato
      await db.collection('mentoradas').doc(cob.uidMentorada)
        .collection('contratos').doc(cob.contratoId)
        .update({ status: 'quitado' });
    }
  }

  return { ok: true };
});

/**
 * Edita data e valor de um pagamento já registrado.
 */
exports.editarPagamento = onCall({}, async (request) => {
  requireAdmin(request);
  const { cobrancaId, dataPagamento, valorRecebido } = request.data;
  if (!cobrancaId || !dataPagamento || valorRecebido == null) {
    throw new HttpsError('invalid-argument', 'cobrancaId, dataPagamento e valorRecebido são obrigatórios.');
  }
  const cobRef  = db.collection('cobrancas').doc(cobrancaId);
  const cobSnap = await cobRef.get();
  if (!cobSnap.exists) throw new HttpsError('not-found', 'Cobrança não encontrada.');
  await cobRef.update({ dataPagamento, valorRecebido });
  return { ok: true };
});

/**
 * Estorna um pagamento já registrado — reverte cobrança para não paga
 * e, se o contrato estava quitado (todas pagas), volta para ativo.
 */
exports.estornarPagamento = onCall({}, async (request) => {
  requireAdmin(request);
  const { cobrancaId } = request.data;
  if (!cobrancaId) throw new HttpsError('invalid-argument', 'cobrancaId é obrigatório.');

  const cobRef  = db.collection('cobrancas').doc(cobrancaId);
  const cobSnap = await cobRef.get();
  if (!cobSnap.exists) throw new HttpsError('not-found', 'Cobrança não encontrada.');

  const cob = cobSnap.data();
  if (!cob.pago) throw new HttpsError('failed-precondition', 'Cobrança já está como pendente.');

  await cobRef.update({
    pago:           false,
    dataPagamento:  admin.firestore.FieldValue.delete(),
    valorRecebido:  admin.firestore.FieldValue.delete(),
    formaPagamento: admin.firestore.FieldValue.delete(),
  });

  // Se o contrato estava quitado (todas as parcelas pagas), reverter para ativo
  if (cob.contratoId && cob.uidMentorada) {
    const contratoRef = db.collection('mentoradas').doc(cob.uidMentorada)
      .collection('contratos').doc(cob.contratoId);
    const contratoSnap = await contratoRef.get();
    if (contratoSnap.exists && contratoSnap.data().status === 'quitado') {
      await contratoRef.update({ status: 'ativo' });
    }
  }

  return { ok: true };
});

/**
 * Cancela um contrato (não apaga histórico de cobranças pagas).
 */
exports.cancelarCobranca = onCall({}, async (request) => {
  requireAdmin(request);
  const { cobrancaId } = request.data;
  if (!cobrancaId) throw new HttpsError('invalid-argument', 'cobrancaId obrigatório.');
  const ref  = db.collection('cobrancas').doc(cobrancaId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Cobrança não encontrada.');
  if (snap.data().pago) throw new HttpsError('failed-precondition', 'Cobrança já paga — não pode ser cancelada.');
  await ref.update({ cancelada: true });
  return { ok: true };
});

exports.cancelarContrato = onCall({}, async (request) => {
  requireAdmin(request);
  const { uid, contratoId } = request.data;
  if (!uid || !contratoId) throw new HttpsError('invalid-argument', 'uid e contratoId obrigatórios.');

  await db.collection('mentoradas').doc(uid)
    .collection('contratos').doc(contratoId)
    .update({ status: 'cancelado' });

  // Cancela cobranças futuras não pagas
  const futuras = await db.collection('cobrancas')
    .where('contratoId', '==', contratoId)
    .where('pago', '==', false)
    .get();
  const batch = db.batch();
  futuras.docs.forEach(d => batch.update(d.ref, { cancelada: true }));
  await batch.commit();

  return { ok: true };
});

/**
 * Edita um contrato: produto, formaPagamento, periodicidade.
 * Para contratos parcelados sem parcelas pagas, permite também recriar as parcelas
 * com nova quantidade e novo valor (parcelas = [{ valor, vencimento }]).
 */
exports.editarContrato = onCall({}, async (request) => {
  requireAdmin(request);
  const { uid, contratoId, produto, formaPagamento, periodicidade, parcelas } = request.data;
  if (!uid || !contratoId || !produto || !formaPagamento) {
    throw new HttpsError('invalid-argument', 'uid, contratoId, produto e formaPagamento são obrigatórios.');
  }

  const contratoRef = db.collection('mentoradas').doc(uid).collection('contratos').doc(contratoId);
  const contratoSnap = await contratoRef.get();
  if (!contratoSnap.exists) throw new HttpsError('not-found', 'Contrato não encontrado.');
  const contrato = contratoSnap.data();

  const mDoc = await db.collection('mentoradas').doc(uid).get();
  const { nome, email } = mDoc.data();

  const cobsSnap = await db.collection('cobrancas')
    .where('contratoId', '==', contratoId).get();

  const batch = db.batch();

  if (parcelas && parcelas.length && contrato.tipo === 'parcelado') {
    // Verifica se há parcelas já pagas — não pode recriar nesse caso
    const algumaPaga = cobsSnap.docs.some(d => d.data().pago);
    if (algumaPaga) {
      throw new HttpsError('failed-precondition', 'Não é possível alterar parcelas de um contrato com pagamentos já registrados.');
    }
    // Apaga cobranças antigas e cria novas
    cobsSnap.docs.forEach(d => batch.delete(d.ref));
    const valorTotal = parcelas.reduce((s, p) => s + (p.valor || 0), 0);
    batch.update(contratoRef, { produto, formaPagamento, valorTotal });
    parcelas.forEach((p, i) => {
      const cobRef = db.collection('cobrancas').doc();
      batch.set(cobRef, {
        uidMentorada: uid, nomeAluna: nome, emailAluna: email,
        contratoId, produto, formaPagamento,
        tipo: 'parcelado', periodicidade: null,
        numero: i + 1, total: parcelas.length,
        valor: p.valor, vencimento: p.vencimento,
        pago: false, dataPagamento: null, valorRecebido: null,
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } else {
    // Só atualiza campos básicos
    const updateContrato = { produto, formaPagamento };
    if (contrato.tipo === 'recorrente') updateContrato.periodicidade = periodicidade || 'mensal';
    batch.update(contratoRef, updateContrato);
    cobsSnap.docs.forEach(d => {
      const upd = { produto, formaPagamento };
      if (contrato.tipo === 'recorrente') upd.periodicidade = periodicidade || 'mensal';
      batch.update(d.ref, upd);
    });
  }

  await batch.commit();
  return { ok: true };
});

/**
 * Webhook do Kiwify — registra pagamento automaticamente.
 * Endpoint público: POST /kiwifyWebhook
 *
 * Matching: e-mail da cliente + produto (nome do produto Kiwify deve conter
 * uma das palavras-chave: combo, mentoria, private, clube, dashboard).
 * Cobrança alvo: a não paga com vencimento no mês atual; se não houver,
 * a mais antiga não paga.
 *
 * Eventos aceitos: order_approved, subscription_payment,
 *                  order.approved, subscription.payment (variações de formato)
 */
exports.kiwifyWebhook = onRequest({ cors: false, secrets: [...SECRETS_ALL, sKiwify] }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  // Verificação de origem Kiwify — obrigatória
  const kiwifySecret = sKiwify.value();
  const assinatura   = req.headers['x-kiwify-signature'] || req.headers['x-webhook-token'] || '';
  if (!kiwifySecret || assinatura !== kiwifySecret) {
    console.warn(`[kiwify] Requisição rejeitada — assinatura inválida. Header: "${assinatura}"`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const body = req.body || {};
    // Kiwify envia o evento no campo "webhook_event_type"; outros campos como fallback
    const rawEvent = body.webhook_event_type || body.event || body.type || '';
    const event = rawEvent.toLowerCase().replace(/\./g, '_');
    console.log(`[kiwify] Body keys: ${Object.keys(body).join(', ')}`);
    console.log(`[kiwify] Evento recebido: ${event}`);

    // Eventos de cancelamento/atraso → bloquear ou alertar mentorada
    const eventosCancelamento = ['subscription_canceled', 'subscription_cancelled', 'assinatura_cancelada'];
    const eventosAtraso       = ['subscription_overdue', 'subscription_delayed', 'assinatura_atrasada', 'assinatura_em_atraso'];

    if (eventosCancelamento.includes(event) || eventosAtraso.includes(event)) {
      const data2 = body.data || body;
      // Kiwify usa PascalCase: Customer, Subscription, etc.
      const emailCancelado = (
        body.Customer?.email || body.Subscription?.Customer?.email ||
        data2?.customer?.email || data2?.subscriber?.email || data2?.buyer?.email || ''
      ).toLowerCase().trim();

      // Identifica o produto do cancelamento
      const nomeProdutoCancelado = (
        body.Product?.name || body.Subscription?.Product?.name ||
        data2?.product?.name || data2?.plan?.name || ''
      ).toLowerCase();
      const ehCombo     = /combo/i.test(nomeProdutoCancelado);
      const ehDashboard = !ehCombo && /dashboard|dash/i.test(nomeProdutoCancelado);
      const ehClube     = !ehCombo && /clube|club/i.test(nomeProdutoCancelado);
      const ehMentoria  = /mentoria|mentoring|private/i.test(nomeProdutoCancelado);

      if (!emailCancelado) {
        res.status(200).json({ ok: false, msg: 'E-mail ausente.' });
        return;
      }

      console.log(`[kiwify] Cancelamento/atraso: ${emailCancelado} | produto: ${nomeProdutoCancelado} | ehDashboard: ${ehDashboard}`);

      const mSnap = await db.collection('mentoradas').where('email', '==', emailCancelado).limit(1).get();
      if (mSnap.empty) {
        console.warn(`[kiwify] Mentorada não encontrada para cancelamento: ${emailCancelado}`);
        res.status(200).json({ ok: false, msg: 'Mentorada não encontrada.' });
        return;
      }

      const mUid = mSnap.docs[0].id;
      const mRef = db.collection('mentoradas').doc(mUid);

      if (eventosCancelamento.includes(event)) {
        const mData = mSnap.docs[0].data();
        const temDashboardAtivo = mData.assinaturaDashboard === true;

        const flagsRevogados = {};
        if (ehDashboard || ehCombo) flagsRevogados.assinaturaDashboard = false;
        if (ehClube     || ehCombo) flagsRevogados.assinaturaClube     = false;
        if (ehMentoria) flagsRevogados.mentoriaEncerrada = true;

        // Só bloqueia Auth e marca inativa se não houver dashboard ativo
        // (mentorada pode ter encerrado a mentoria mas continuar no produto dashboard)
        const mantemAcesso = temDashboardAtivo && !ehDashboard && !ehCombo;
        if (!mantemAcesso) {
          await admin.auth().updateUser(mUid, { disabled: true });
          flagsRevogados.status = 'inativa';
        }

        await mRef.update(flagsRevogados);
        const acao = mantemAcesso ? 'mentoria_encerrada_dashboard_ativo' : 'bloqueada';
        console.log(`[kiwify] ${mantemAcesso ? '🟡' : '🔴'} ${acao} — ${nomeProdutoCancelado || 'produto'} cancelado: ${emailCancelado}`);
        res.status(200).json({ ok: true, acao, flags: flagsRevogados, uid: mUid });
      } else {
        // Atraso: marca alerta (não bloqueia ainda) + registra quando começou
        await mRef.update({
          status:             'alerta',
          alertaSince:        admin.firestore.FieldValue.serverTimestamp(),
          alertaEmailsEnviados: [],
        });
        console.log(`[kiwify] ⚠️ Alerta de atraso marcado: ${emailCancelado}`);
        res.status(200).json({ ok: true, acao: 'alerta', uid: mUid });
      }
      return;
    }

    // Aceita todos os eventos de pagamento confirmado do Kiwify
    const eventosAceitos = [
      'order_approved', 'order_completed', 'purchase_approved',
      'subscription_payment', 'subscription_renewed', 'subscription_renewal',
      'assinatura_renovada', 'compra_aprovada',
    ];
    if (!eventosAceitos.includes(event)) {
      console.log(`[kiwify] Evento ignorado: ${event}`);
      res.status(200).json({ ok: true, msg: 'Evento ignorado.' });
      return;
    }

    const data = body.data || body;

    // Extrai e-mail do cliente
    // Kiwify usa PascalCase: Customer.email, Order.Customer.email, Subscription.Customer.email
    const email = (
      body.Customer?.email ||
      body.Order?.Customer?.email ||
      body.Subscription?.Customer?.email ||
      data?.customer?.email ||
      data?.subscriber?.email ||
      data?.buyer?.email ||
      ''
    ).toLowerCase().trim();

    if (!email) {
      console.error('[kiwify] E-mail do cliente ausente no payload:', JSON.stringify(body));
      res.status(200).json({ ok: false, msg: 'E-mail ausente.' });
      return;
    }

    // Extrai nome do produto
    // Kiwify usa PascalCase: Product.name
    const nomeProduto = (
      body.Product?.name ||
      body.Order?.Product?.name ||
      data?.product?.name ||
      data?.plan?.name ||
      data?.product_name ||
      ''
    ).toLowerCase();

    // Mapeia nome do produto para código interno
    // Combo deve vir antes de clube/dashboard (pode conter ambas as palavras)
    // Identifica produto — ordem importa:
    // 1. Combo: nome contém AMBOS "dashboard" e "clube" (ex: "Dashboard + Clube Trilogia")
    //           OU contém a palavra "combo" explicitamente
    // 2. Private: antes de mentoria (ex: "Mentoria Trilogia Private" contém "mentoria" E "private")
    // 3. Mentoria / Clube / Dashboard
    const hasDash  = /dashboard|dash/i.test(nomeProduto);
    const hasClube = /clube|club/i.test(nomeProduto);
    let produtoCodigo = null;
    if ((hasDash && hasClube) || /combo/i.test(nomeProduto)) produtoCodigo = 'combo';
    else if (/private/i.test(nomeProduto))                   produtoCodigo = 'private';
    else if (/mentoria|mentoring/i.test(nomeProduto))        produtoCodigo = 'mentoria';
    else if (hasClube)                                       produtoCodigo = 'clube';
    else if (hasDash)                                        produtoCodigo = 'dashboard';

    // Extrai valor
    // Kiwify usa Order.amount (em reais), ou Subscription.charge_amount
    const valorBruto = (
      body.Order?.amount ||
      body.Subscription?.charge_amount ||
      data?.charges?.[0]?.amount ||
      data?.charge?.amount ||
      data?.total_price ||
      data?.amount ||
      0
    );
    // Heurística: se > 1000 provavelmente é centavos
    const valorRecebido = valorBruto > 1000
      ? valorBruto / 100
      : valorBruto;

    // Validação por range esperado por produto — alerta se valor for suspeito
    const RANGES_VALOR = {
      mentoria:  { min: 500,  max: 15000 },
      private:   { min: 2000, max: 30000 },
      dashboard: { min: 50,   max: 500   },
      clube:     { min: 50,   max: 300   },
      combo:     { min: 100,  max: 1000  },
    };
    const rangeValor = produtoCodigo ? RANGES_VALOR[produtoCodigo] : null;
    if (rangeValor && (valorRecebido < rangeValor.min || valorRecebido > rangeValor.max)) {
      console.warn(`[kiwify] ⚠️ Valor suspeito para "${produtoCodigo}": R$${valorRecebido} (bruto: ${valorBruto}). Verificar unidade no payload.`);
    }

    const dataPagamento = new Date().toISOString().slice(0, 10);

    console.log(`[kiwify] Evento: ${event} | E-mail: ${email} | Produto: ${nomeProduto} (${produtoCodigo}) | Valor: R$${valorRecebido}`);

    // Busca mentorada pelo e-mail
    const mentSnap = await db.collection('mentoradas')
      .where('email', '==', email).limit(1).get();

    // ── AUTO-CRIAÇÃO: compra nova, mentorada não existe ainda ─────────────────
    if (mentSnap.empty) {
      const nomeCliente = (
        body.Customer?.name        || body.Customer?.full_name ||
        body.Order?.Customer?.name || data?.customer?.name || ''
      ).trim();

      if (!nomeCliente) {
        console.warn(`[kiwify] Auto-criação impossível — nome ausente para: ${email}`);
        res.status(200).json({ ok: false, msg: `Mentorada não encontrada e nome ausente no payload: ${email}` });
        return;
      }

      console.log(`[kiwify] 🆕 Auto-criando mentorada: "${nomeCliente}" (${email})`);

      // 1. Firebase Auth
      const senha = Math.random().toString(36).slice(-8) + 'Aa1!';
      const userRecord = await admin.auth().createUser({ email, password: senha, displayName: nomeCliente });
      const novoUid = userRecord.uid;

      // 2. Planilha no Drive (falha não bloqueia o acesso)
      let sheetId = null;
      try {
        sheetId = await provisionar(nomeCliente, DRIVE_FOLDER_ID);
      } catch (err) {
        console.error(`[kiwify] Falha ao provisionar planilha para ${email}:`, err.message);
      }

      // 3. Flags de produto
      const produtoParaFS = produtoCodigo === 'combo' ? 'dashboard' : (produtoCodigo || 'mentoria');
      const flagsNovaM   = { status: 'ativa' };
      if (produtoCodigo === 'dashboard' || produtoCodigo === 'combo') flagsNovaM.assinaturaDashboard = true;
      if (produtoCodigo === 'clube'     || produtoCodigo === 'combo') flagsNovaM.assinaturaClube     = true;

      // dataExpiracao para produtos recorrentes
      if (['dashboard', 'clube', 'combo'].includes(produtoCodigo)) {
        const exp = new Date(); exp.setMonth(exp.getMonth() + 1);
        flagsNovaM.dataExpiracao = exp.toISOString().slice(0, 10);
      }

      // 4. Documento Firestore
      await db.collection('mentoradas').doc(novoUid).set({
        nome:            nomeCliente,
        email,
        produto:         produtoParaFS,
        valorMensal:     valorRecebido || 0,
        formaPagamento:  'kiwify',
        inicio:          new Date().toISOString().slice(0, 7),
        sheetId,
        criadoViaKiwify: true,
        criadoEm:        admin.firestore.FieldValue.serverTimestamp(),
        ...flagsNovaM,
      });

      // 5. Criar contrato recorrente + primeira cobrança já paga
      const contratoRef = db.collection('mentoradas').doc(novoUid).collection('contratos').doc();
      await contratoRef.set({
        produto:        produtoCodigo || 'mentoria',
        tipo:           'recorrente',
        periodicidade:  'mensal',
        valorTotal:     valorRecebido,
        formaPagamento: 'kiwify',
        status:         'ativo',
        criadoEm:       admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection('cobrancas').add({
        uidMentorada:   novoUid,
        nomeAluna:      nomeCliente,
        emailAluna:     email,
        contratoId:     contratoRef.id,
        produto:        produtoCodigo || 'mentoria',
        tipo:           'recorrente',
        periodicidade:  'mensal',
        numero:         1,
        valor:          valorRecebido,
        vencimento:     dataPagamento,
        pago:           true,
        dataPagamento,
        valorRecebido,
        formaPagamento: 'kiwify',
        cancelada:      false,
      });

      // 6. E-mail de boas-vindas (falha não bloqueia)
      try {
        const link = await admin.auth().generatePasswordResetLink(email);
        await sendEmail({ to: email, subject: 'Bem-vinda ao Trilogia Dashboard', html: emailBoasVindas(nomeCliente, link) });
      } catch (err) {
        console.error(`[kiwify] Falha no e-mail de boas-vindas para ${email}:`, err.message);
      }

      console.log(`[kiwify] ✅ Mentorada criada via compra Kiwify: ${nomeCliente} (uid: ${novoUid})`);
      res.status(200).json({ ok: true, acao: 'criada', uid: novoUid, nome: nomeCliente, produto: produtoCodigo });
      return;
    }
    // ── FIM AUTO-CRIAÇÃO ──────────────────────────────────────────────────────

    let uidMentorada = mentSnap.docs[0].id;

    // Busca cobranças pendentes desta mentorada
    let query = db.collection('cobrancas')
      .where('uidMentorada', '==', uidMentorada)
      .where('pago', '==', false);

    const cobsSnap = await query.get();
    let cobrancas = cobsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => !c.cancelada);

    // Filtra por produto se identificado
    if (produtoCodigo) {
      const filtrado = cobrancas.filter(c => c.produto === produtoCodigo);
      if (filtrado.length > 0) cobrancas = filtrado;
    }

    if (!cobrancas.length) {
      console.warn(`[kiwify] Nenhuma cobrança pendente para: ${email}`);
      res.status(200).json({ ok: false, msg: 'Nenhuma cobrança pendente encontrada.' });
      return;
    }

    // Prefere cobrança do mês atual, senão pega a mais antiga
    const hoje = new Date();
    const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const doMes = cobrancas.filter(c => c.vencimento && c.vencimento.startsWith(mesAtual));
    const alvo = (doMes.length > 0 ? doMes : cobrancas)
      .sort((a, b) => (a.vencimento || '').localeCompare(b.vencimento || ''))[0];

    // Registra pagamento (mesma lógica de pagarParcela)
    const cobRef = db.collection('cobrancas').doc(alvo.id);
    await cobRef.update({
      pago: true,
      dataPagamento,
      valorRecebido: valorRecebido || alvo.valor,
      formaPagamento: 'kiwify',
    });

    // Atualiza flags de acesso conforme produto pago
    const ehClubePag     = produtoCodigo === 'clube'     || produtoCodigo === 'combo';
    const ehDashboardPag = produtoCodigo === 'dashboard' || produtoCodigo === 'combo';
    if (ehClubePag || ehDashboardPag) {
      const mDoc = await db.collection('mentoradas').doc(uidMentorada).get();
      const mData = mDoc.data() || {};
      const updates = {};
      if (ehClubePag)     updates.assinaturaClube     = true;
      if (ehDashboardPag) updates.assinaturaDashboard = true;
      if (mData.status === 'inativa' || mData.status === 'alerta') updates.status = 'ativa';
      // Limpa flags de alerta ao regularizar pagamento
      if (mData.status === 'alerta') {
        updates.alertaSince         = admin.firestore.FieldValue.delete();
        updates.alertaEmailsEnviados = admin.firestore.FieldValue.delete();
      }
      await db.collection('mentoradas').doc(uidMentorada).update(updates);
      // Desbloqueia no Auth se estava desabilitada
      const authUser = await admin.auth().getUser(uidMentorada).catch(() => null);
      if (authUser && authUser.disabled) {
        await admin.auth().updateUser(uidMentorada, { disabled: false });
        console.log(`[kiwify] ✅ Acesso reativado (${produtoCodigo}): ${email}`);
      }
    }

    // Recorrente: gera próxima cobrança
    if (alvo.tipo === 'recorrente') {
      const proxVenc = proximoVencimento(alvo.vencimento, alvo.periodicidade);
      await db.collection('cobrancas').add({
        uidMentorada, nomeAluna: alvo.nomeAluna, emailAluna: alvo.emailAluna,
        contratoId: alvo.contratoId, produto: alvo.produto,
        formaPagamento: 'kiwify', tipo: 'recorrente',
        periodicidade: alvo.periodicidade,
        numero: alvo.numero + 1, total: alvo.total,
        valor: alvo.valor, vencimento: proxVenc,
        pago: false, dataPagamento: null, valorRecebido: null,
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (PRODUTOS_RECORRENTES.includes(alvo.produto)) {
        await db.collection('mentoradas').doc(uidMentorada).update({ dataExpiracao: proxVenc });
      }
    }

    // Parcelado: verifica se quita o contrato
    if (alvo.tipo === 'parcelado') {
      const abertas = await db.collection('cobrancas')
        .where('contratoId', '==', alvo.contratoId)
        .where('pago', '==', false).get();
      if (abertas.empty) {
        await db.collection('mentoradas').doc(uidMentorada)
          .collection('contratos').doc(alvo.contratoId)
          .update({ status: 'quitado' });
      }
    }

    console.log(`[kiwify] ✅ Pagamento registrado: ${email} | cobrança ${alvo.id} | R$${valorRecebido || alvo.valor}`);
    res.status(200).json({ ok: true, cobrancaId: alvo.id });

  } catch (err) {
    console.error('[kiwify] Erro interno:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Retorna cobranças filtradas por mês/ano (hub financeiro).
 * Opcionalmente filtra por uid de mentorada.
 */
exports.getCobrancas = onCall({}, async (request) => {
  requireAdmin(request);
  const { mes, ano, uid } = request.data;
  if (!mes || !ano) throw new HttpsError('invalid-argument', 'mes e ano são obrigatórios.');

  const mm     = String(mes).padStart(2, '0');
  const inicio = `${ano}-${mm}-01`;
  const fim    = `${ano}-${mm}-31`;

  // Firestore não permite filtros de desigualdade em dois campos distintos.
  // Filtramos 'cancelada' em memória depois de buscar por 'vencimento'.
  let q = uid
    ? db.collection('cobrancas')
        .where('uidMentorada', '==', uid)
        .where('vencimento', '>=', inicio)
        .where('vencimento', '<=', fim)
        .orderBy('vencimento')
    : db.collection('cobrancas')
        .where('vencimento', '>=', inicio)
        .where('vencimento', '<=', fim)
        .orderBy('vencimento');

  const snap = await q.get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.cancelada !== true);
});

/**
 * Notificação diária de cobranças com vencimento hoje.
 * Enviada para a Flávia às 8h (horário de Brasília = 11h UTC).
 */
exports.notifCobrancasDia = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'America/Sao_Paulo', secrets: ['GMAIL_APP_PASSWORD'] },
  async () => {
  const hoje = new Date().toISOString().slice(0, 10);

  const snap = await db.collection('cobrancas')
    .where('vencimento', '==', hoje)
    .where('pago', '==', false)
    .get();

  if (snap.empty) return;

  const cobrancas = snap.docs
    .map(d => d.data())
    .filter(c => !c.cancelada);

  if (!cobrancas.length) return;

  await sendEmail({
    to:      ADMIN_EMAIL,
    subject: `Cobranças de hoje — ${hoje}`,
    html:    emailCobrancasDia(cobrancas),
  });
});

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Consolida patrimônio do IR com posição atual da corretora.
 * Usa o valor mais recente para cada classe de ativo.
 */
function consolidarAtivos(patrimonioIR, investimentos) {
  const mapa = {};

  for (const item of patrimonioIR) {
    mapa[item.classe] = { ...item, source: 'ir' };
  }

  for (const item of investimentos) {
    // Posição da corretora sobrescreve o IR para classes de ativos financeiros
    if (item.valor > 0) mapa[item.classe] = { ...item, source: 'investimentos' };
  }

  return Object.values(mapa).filter(a => a.valor > 0);
}

function gerarSenhaTemporaria() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── Helpers de e-mail ────────────────────────────────────────────────────────

const NOMES_MESES_PT = [
  'janeiro','fevereiro','março','abril','maio','junho',
  'julho','agosto','setembro','outubro','novembro','dezembro',
];

function nomeMesPt(mes, ano) {
  return `${NOMES_MESES_PT[mes - 1]} de ${ano}`;
}

/**
 * Retorna todas as mentoradas ativas do Firestore.
 * @returns {Promise<Array<{id, nome, email, perfil}>>}
 */
async function getAtivas() {
  const snap = await db.collection('mentoradas').where('status', '==', 'ativa').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── NOTIFICAÇÕES AGENDADAS ───────────────────────────────────────────────────

// SECRETS_EMAIL já definido no topo do arquivo

/**
 * Dia 1 de cada mês às 08h (Brasília):
 *   • Lembrete de orçamento (todas as ativas)
 *   • Renovação de perfil (perfil ausente ou > 180 dias)
 */
exports.notifDia1 = onSchedule(
  { schedule: '0 8 1 * *', timeZone: 'America/Sao_Paulo', secrets: [...SECRETS_EMAIL, ...SECRETS_PUSH] },
  async () => {
    const agora   = new Date();
    const mes     = agora.getMonth() + 1;
    const ano     = agora.getFullYear();
    const nomesMes = nomeMesPt(mes, ano);

    // Mês anterior para o relatório
    const mesPrevNum = mes === 1 ? 12 : mes - 1;
    const anoPrev    = mes === 1 ? ano - 1 : ano;
    const mesKeyPrev = `${anoPrev}-${String(mesPrevNum).padStart(2, '0')}`;
    const nomeMesPrev = nomeMesPt(mesPrevNum, anoPrev);

    const mentoradas = await getAtivas();

    for (const m of mentoradas) {
      if (!m.email) continue;
      const tarefas = [];

      // Relatório do mês anterior — lê orçamento do Firestore
      try {
        const orcSnap = await db.collection('mentoradas').doc(m.id)
          .collection('orcamento').doc(mesKeyPrev).get();
        if (orcSnap.exists) {
          const itens = orcSnap.data().itens || [];
          const orc = {
            receita: itens.filter(i => i.tipo === 'receita').reduce((s, i) => s + i.valor, 0),
            despesa: itens.filter(i => i.tipo === 'despesa').reduce((s, i) => s + i.valor, 0),
            aporte:  itens.filter(i => i.tipo === 'aporte').reduce((s, i) => s + i.valor, 0),
          };
          orc.sobra = orc.receita - orc.despesa;
          // Só envia se tiver ao menos receita ou despesa registrada
          if (orc.receita > 0 || orc.despesa > 0) {
            tarefas.push(sendEmail({
              to:      m.email,
              subject: `Seu resumo financeiro de ${nomeMesPrev}`,
              html:    emailRelatorioMensal(
                m.nome || 'mentorada',
                nomeMesPrev,
                orc,
                m.pl || 0,
                m.totalReservas || 0,
              ),
            }));
          }
        }
      } catch (err) {
        console.warn(`[notifDia1] Erro ao gerar relatório para ${m.id}:`, err.message);
      }

      // Lembrete de orçamento — todas as ativas
      tarefas.push(sendEmail({
        to:      m.email,
        subject: `Registre o orçamento de ${nomesMes}`,
        html:    emailLembreteOrcamento(m.nome || 'mentorada', nomesMes),
      }));

      // Perfil ausente → convite para cadastrar
      if (!m.perfil?.perfil) {
        tarefas.push(sendEmail({
          to:      m.email,
          subject: 'Configure seu perfil de investidor',
          html:    emailSemPerfil(m.nome || 'mentorada'),
        }));
      }
      // Perfil desatualizado (> 180 dias) → aviso de renovação
      else if (m.perfil?.dataAtualizacao) {
        const [pA, pM, pD] = m.perfil.dataAtualizacao.split('-').map(Number);
        const dias = Math.floor((agora - new Date(pA, pM - 1, pD)) / 86400000);
        if (dias > 180) {
          tarefas.push(sendEmail({
            to:      m.email,
            subject: 'Seu perfil de investidor precisa de revisão',
            html:    emailRenovacaoPerfil(m.nome || 'mentorada', Math.floor(dias / 30)),
          }));
        }
      }

      await Promise.allSettled(tarefas);
    }

    // Push para todas as ativas: lembrete de orçamento
    await sendPushToAtivas({
      titulo: `Orçamento de ${nomesMes}`,
      corpo:  'Que tal registrar o orçamento deste mês? Leva menos de 5 minutos.',
      url:    '/orcamento.html',
      tag:    'lembrete-orcamento',
    }).catch(e => console.warn('[notifDia1] Push falhou:', e.message));
  },
);

/**
 * Dia 28 de cada mês às 08h (Brasília):
 *   • Lembrete de aporte (todas as ativas)
 */
/**
 * Dispara e-mail de novidades para todas as mentoradas ativas.
 * Função one-shot — chamar uma vez pelo admin após cada release importante.
 */
exports.anunciarNovidades = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  requireAdmin(request);
  const mentoradas = await getAtivas();
  let enviados = 0, erros = 0;
  for (const m of mentoradas) {
    if (!m.email) continue;
    try {
      await sendEmail({
        to:      m.email,
        subject: 'Seu dashboard acaba de ganhar superpoderes 🎉',
        html:    emailNovidades(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[anunciarNovidades] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  return { ok: true, enviados, erros };
});

exports.notifDia28 = onSchedule(
  { schedule: '0 8 28 * *', timeZone: 'America/Sao_Paulo', secrets: [...SECRETS_EMAIL, ...SECRETS_PUSH] },
  async () => {
    const agora    = new Date();
    const mes      = agora.getMonth() + 1;
    const ano      = agora.getFullYear();
    const nomesMes = nomeMesPt(mes, ano);

    // Próximo mês para o lembrete de planejamento
    const proxMes     = mes === 12 ? 1 : mes + 1;
    const proxAno     = mes === 12 ? ano + 1 : ano;
    const nomeProxMes = nomeMesPt(proxMes, proxAno);

    const mentoradas = await getAtivas();

    for (const m of mentoradas) {
      if (!m.email) continue;
      // Lembrete de aporte do mês atual
      await sendEmail({
        to:      m.email,
        subject: `Efetive o aporte de ${nomesMes}`,
        html:    emailLembreteAporte(m.nome || 'mentorada', nomesMes),
      }).catch(err => console.error(`Erro ao enviar aporte para ${m.email}:`, err));
      // Lembrete de planejamento do próximo mês
      await sendEmail({
        to:      m.email,
        subject: `Configure o planejamento de ${nomeProxMes}`,
        html:    emailLembretePlanejamento(m.nome || 'mentorada', nomeProxMes),
      }).catch(err => console.error(`Erro ao enviar planejamento para ${m.email}:`, err));
    }

    // Push: lembrete de aporte
    await sendPushToAtivas({
      titulo: `Aporte de ${nomesMes}`,
      corpo:  'Faltam 3 dias para o fim do mês. Já transferiu para seus investimentos?',
      url:    '/orcamento.html',
      tag:    'lembrete-aporte',
    }).catch(e => console.warn('[notifDia28] Push falhou:', e.message));
  },
);

/**
 * notifRetencao — diariamente às 10h (Sao_Paulo)
 * Envia série de e-mails para mentoradas com status=alerta:
 *   Dia 1: lembrete suave
 *   Dia 3: urgência (o que está em risco)
 *   Dia 7: último aviso antes do bloqueio
 */
exports.notifRetencao = onSchedule(
  { schedule: '0 10 * * *', timeZone: 'America/Sao_Paulo', secrets: SECRETS_EMAIL },
  async () => {
    const agora = new Date();
    const snap  = await db.collection('mentoradas')
      .where('status', '==', 'alerta').get();

    for (const doc of snap.docs) {
      const { email, nome, alertaSince, alertaEmailsEnviados = [] } = doc.data();
      if (!email || !alertaSince) continue;

      const diasEmAlerta = Math.floor(
        (agora - alertaSince.toDate()) / 86_400_000
      );

      const tarefas = [];

      if (diasEmAlerta >= 1 && !alertaEmailsEnviados.includes(1)) {
        tarefas.push(
          sendEmail({
            to:      email,
            subject: 'Identificamos um atraso no seu pagamento',
            html:    emailRetencaoDia1(nome || 'mentorada'),
          }).then(() =>
            doc.ref.update({ alertaEmailsEnviados: admin.firestore.FieldValue.arrayUnion(1) })
          )
        );
      }

      if (diasEmAlerta >= 3 && !alertaEmailsEnviados.includes(3)) {
        tarefas.push(
          sendEmail({
            to:      email,
            subject: 'Seu acesso ao Dashboard está em risco',
            html:    emailRetencaoDia3(nome || 'mentorada'),
          }).then(() =>
            doc.ref.update({ alertaEmailsEnviados: admin.firestore.FieldValue.arrayUnion(3) })
          )
        );
      }

      if (diasEmAlerta >= 7 && !alertaEmailsEnviados.includes(7)) {
        tarefas.push(
          sendEmail({
            to:      email,
            subject: 'Último aviso — acesso será suspenso em breve',
            html:    emailRetencaoDia7(nome || 'mentorada'),
          }).then(() =>
            doc.ref.update({ alertaEmailsEnviados: admin.firestore.FieldValue.arrayUnion(7) })
          )
        );
      }

      if (tarefas.length) {
        await Promise.allSettled(tarefas);
        console.log(`[retencao] ${tarefas.length} e-mail(s) enviados para ${email} (dia ${diasEmAlerta} de alerta)`);
      }
    }
  },
);

/**
 * notifMaioIR — todo dia 5 de maio, 08h (Sao_Paulo)
 *   • Lembrete de importação da declaração de IR
 */
exports.notifMaioIR = onSchedule(
  { schedule: '0 8 5 5 *', timeZone: 'America/Sao_Paulo', secrets: SECRETS_EMAIL },
  async () => {
    const mentoradas = await getAtivas();

    for (const m of mentoradas) {
      await sendEmail({
        to:      m.email,
        subject: 'Atualize seu patrimônio com a declaração de IR',
        html:    emailIR(m.nome || 'mentorada'),
      }).catch(err => console.error(`Erro ao enviar IR para ${m.email}:`, err));
    }
  },
);

/**
 * agendarLimpezaEncerradas — dia 1 de cada mês às 09h00 (Sao_Paulo)
 * LGPD retenção: mentoradas com mentoriaEncerrada=true E status=inativa há 12+ meses
 * são adicionadas à coleção mentoradas_deletadas para limpeza pelo limparDadosExpirados.
 * Não apaga dados imediatamente — agenda para o próximo ciclo.
 */
exports.agendarLimpezaEncerradas = onSchedule(
  { schedule: '0 9 1 * *', timeZone: 'America/Sao_Paulo' },
  async () => {
    const prazo = new Date();
    prazo.setMonth(prazo.getMonth() - 12);

    const snap = await db.collection('mentoradas')
      .where('mentoriaEncerrada', '==', true)
      .where('status', '==', 'inativa')
      .get();

    let agendadas = 0;
    for (const doc of snap.docs) {
      const { ultimoAcesso, sheetId, nome, email, produto, inicio } = doc.data();
      // Só agenda se o último acesso foi há mais de 12 meses (ou nunca acessou)
      const ts = ultimoAcesso?.toDate?.() || null;
      if (ts && ts > prazo) continue;

      // Verifica se já está em mentoradas_deletadas
      const existing = await db.collection('mentoradas_deletadas').doc(doc.id).get();
      if (existing.exists) continue;

      try {
        await db.collection('mentoradas_deletadas').doc(doc.id).set({
          nome:            nome            || null,
          email:           email           || null,
          produto:         produto         || null,
          inicio:          inicio          || null,
          sheetId:         sheetId         || null,
          planilhaApagada: false,
          deletadoEm:      admin.firestore.FieldValue.serverTimestamp(),
          deletadoPor:     'auto-lgpd-retencao',
          motivo:          'mentoriaEncerrada + inativa 12 meses sem acesso',
        });
        agendadas++;
        console.log(`[agendarLimpeza] Agendada: ${nome} (${doc.id})`);
      } catch (err) {
        console.error(`[agendarLimpeza] Erro em ${doc.id}:`, err.message);
      }
    }
    console.log(`[agendarLimpeza] ${agendadas} mentoradas agendadas para limpeza.`);
  }
);

/**
 * limparDadosExpirados — dia 1 de cada mês às 09h30 (Sao_Paulo)
 * Conformidade LGPD: apaga planilhas Google Drive de mentoradas deletadas há mais de 12 meses.
 * A planilha é mantida intencionalmente durante esse período para possibilitar reativação.
 */
exports.limparDadosExpirados = onSchedule(
  { schedule: '30 9 1 * *', timeZone: 'America/Sao_Paulo', secrets: [sClientId, sClientSec, sRefresh] },
  async () => {
    const prazo = new Date();
    prazo.setMonth(prazo.getMonth() - 12);

    const snap = await db.collection('mentoradas_deletadas')
      .where('planilhaApagada', '==', false)
      .where('deletadoEm', '<', prazo)
      .get();

    if (snap.empty) {
      console.log('[limparDadosExpirados] Nenhuma planilha para apagar.');
      return;
    }

    const { google } = require('googleapis');
    const auth = new google.auth.OAuth2(sClientId.value(), sClientSec.value());
    auth.setCredentials({ refresh_token: sRefresh.value() });
    const drive = google.drive({ version: 'v3', auth });

    for (const doc of snap.docs) {
      const { sheetId, nome } = doc.data();
      if (!sheetId) {
        await doc.ref.update({ planilhaApagada: true, planilhaApagadaEm: new Date() });
        continue;
      }
      try {
        await drive.files.delete({ fileId: sheetId });
        await doc.ref.update({ planilhaApagada: true, planilhaApagadaEm: new Date() });
        console.log(`[limparDadosExpirados] Planilha apagada: ${nome} (${sheetId})`);
      } catch (err) {
        console.error(`[limparDadosExpirados] Falha ao apagar ${sheetId} (${nome}):`, err.message);
      }
    }
  },
);

/**
 * verificarExpiracoes — diariamente às 09h (Sao_Paulo)
 * Inativa contas cuja dataExpiracao já passou.
 * Roda APÓS notifExpiracaoProxima (07h) para garantir que o aviso chega antes do bloqueio.
 */
exports.verificarExpiracoes = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'America/Sao_Paulo' },
  async () => {
    const hoje = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const snap = await db.collection('mentoradas')
      .where('status', '==', 'ativa')
      .where('dataExpiracao', '<=', hoje)
      .get();

    for (const doc of snap.docs) {
      const { dataExpiracao, assinaturaDashboard, assinaturaClube } = doc.data();
      if (!dataExpiracao) continue; // sem expiração definida: ignora

      // Mantém acesso se tem assinatura ativa de dashboard ou clube
      if (assinaturaDashboard === true) {
        console.log(`Mentoria expirada mas dashboard ativo — acesso mantido: ${doc.id}`);
        continue;
      }
      if (assinaturaClube === true) {
        console.log(`Mentoria expirada mas clube ativo — acesso mantido: ${doc.id}`);
        continue;
      }

      await admin.auth().updateUser(doc.id, { disabled: true }).catch(() => {});
      await doc.ref.update({ status: 'inativa' });
      console.log(`Conta expirada e inativada: ${doc.id} (${dataExpiracao})`);
    }
  },
);

/**
 * notifExpiracaoProxima — diariamente às 07h (Sao_Paulo)
 * Avisa alunas cuja dataExpiracao é daqui a 7 dias.
 * Roda ANTES de verificarExpiracoes (09h) para garantir que o aviso chega antes do bloqueio.
 */
exports.notifExpiracaoProxima = onSchedule(
  { schedule: '0 7 * * *', timeZone: 'America/Sao_Paulo', secrets: SECRETS_EMAIL },
  async () => {
    const em7Dias = new Date();
    em7Dias.setDate(em7Dias.getDate() + 7);
    const alvo = em7Dias.toISOString().slice(0, 10);

    const snap = await db.collection('mentoradas')
      .where('status', '==', 'ativa')
      .where('dataExpiracao', '==', alvo)
      .get();

    for (const doc of snap.docs) {
      const m = doc.data();
      if (!m.email) continue;
      // Não notifica quem tem assinatura ativa de dashboard ou clube (não vai expirar)
      if (m.assinaturaDashboard === true || m.assinaturaClube === true) continue;
      await sendEmail({
        to:      m.email,
        subject: 'Seu acesso ao Dashboard expira em 7 dias',
        html:    emailExpiracaoProxima(m.nome || 'mentorada'),
      }).catch(err => console.error(`Erro ao enviar expiração para ${m.email}:`, err));
    }
  },
);

// ─── BACKUP AUTOMÁTICO ───────────────────────────────────────────────────────

/**
 * backupDiario — todo dia às 03h (Sao_Paulo)
 * Cria snapshot de todos os docs de mentoradas em backups/{YYYY-MM-DD}.
 * Mantém os últimos 30 dias. Backups mais antigos são removidos automaticamente.
 *
 * Estrutura: backups/{data}/mentoradas/{uid} → campos principais
 *            backups/{data}/cobrancas_count  → número total de cobranças
 */
/**
 * Retorna metadata do backup mais recente.
 */
exports.getBackupStatus = onCall({}, async (request) => {
  requireAdmin(request);
  const snap = await db.collection('backups').orderBy('data', 'desc').limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0].data();
  return { data: d.data, totalMentoradas: d.totalMentoradas, criadoEm: d.criadoEm?.toDate?.()?.toISOString() || null };
});

exports.backupDiario = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'America/Sao_Paulo' },
  async () => {
    const dataHoje = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // ── 1. Snapshot das mentoradas ────────────────────────────────────────
    const mentSnap = await db.collection('mentoradas').get();
    const backupRef = db.collection('backups').doc(dataHoje);

    const batch = db.batch();
    for (const doc of mentSnap.docs) {
      const d = doc.data();
      // Salva campos críticos (sem subcoleções volumosas)
      batch.set(
        backupRef.collection('mentoradas').doc(doc.id),
        {
          nome:            d.nome            || null,
          email:           d.email           || null,
          status:          d.status          || null,
          produto:         d.produto         || null,
          sheetId:         d.sheetId         || null,
          dataExpiracao:   d.dataExpiracao   || null,
          assinaturaDashboard: d.assinaturaDashboard || false,
          assinaturaClube: d.assinaturaClube || false,
          mentoriaEncerrada: d.mentoriaEncerrada || false,
          pl:              d.pl              || 0,
          totalReservas:   d.totalReservas   || 0,
          lgpdAceite:      d.lgpdAceite      || false,
          backedUpAt:      admin.firestore.FieldValue.serverTimestamp(),
        }
      );
    }
    await batch.commit();

    // ── 2. Metadata do backup ─────────────────────────────────────────────
    await backupRef.set({
      data:          dataHoje,
      totalMentoradas: mentSnap.size,
      criadoEm:      admin.firestore.FieldValue.serverTimestamp(),
    });

    // ── 3. Remove backups com mais de 30 dias ─────────────────────────────
    const limite = new Date();
    limite.setDate(limite.getDate() - 30);
    const limitStr = limite.toISOString().slice(0, 10);

    const velhos = await db.collection('backups')
      .where('data', '<', limitStr).get();

    for (const velho of velhos.docs) {
      // Remove subcoleção de mentoradas do backup antigo
      const subSnap = await velho.ref.collection('mentoradas').get();
      const delBatch = db.batch();
      subSnap.docs.forEach(d => delBatch.delete(d.ref));
      if (!subSnap.empty) await delBatch.commit();
      await velho.ref.delete();
    }

    console.log(`[backup] ${dataHoje}: ${mentSnap.size} mentoradas. ${velhos.size} backup(s) antigo(s) removidos.`);
  },
);

// ─── NOTION CRM ───────────────────────────────────────────────────────────────

/** Extrai texto puro de um array de rich_text do Notion. */
function getRichText(richText) {
  if (!Array.isArray(richText)) return '';
  return richText.map(r => r.plain_text || '').join('');
}

/**
 * Lê a página Notion da mentorada e retorna:
 *   - ultimoEncontro: { numero, tema, data }
 *   - licoesPendentes: string[]   (checkboxes desmarcadas do último encontro)
 *   - notionPageUrl: string
 *
 * Cacheia notionPageId + contagem de lições em Firestore para exibir badge na lista.
 */
exports.getNotionCRM = onCall({ secrets: [sNotion] }, async (request) => {
  requireAdmin(request);
  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  const docSnap = await db.collection('mentoradas').doc(uid).get();
  if (!docSnap.exists) throw new HttpsError('not-found', 'Mentorada não encontrada.');

  const { nome, notionPageId: cachedPageId } = docSnap.data();
  if (!nome) throw new HttpsError('not-found', 'Nome da mentorada não encontrado no Firestore.');

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  // ── 1. Encontrar a página Notion ────────────────────────────────────────────
  let pageId  = cachedPageId || null;
  let pageUrl = pageId ? `https://notion.so/${pageId.replace(/-/g, '')}` : null;

  if (!pageId) {
    const searchRes = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: nome,
        filter: { value: 'page', property: 'object' },
        page_size: 15,
      }),
    });

    if (!searchRes.ok) {
      const err = await searchRes.json();
      throw new HttpsError('internal', `Notion search falhou: ${err.message || searchRes.status}`);
    }

    const searchData = await searchRes.json();
    const page = (searchData.results || []).find(p => {
      const title = getRichText(p.properties?.title?.title) ||
                    getRichText(p.properties?.Name?.title)  || '';
      return title.toLowerCase().includes(nome.toLowerCase());
    });

    if (!page) {
      return { notionPageUrl: null, ultimoEncontro: null, licoesPendentes: [] };
    }
    pageId  = page.id;
    pageUrl = page.url;
  }

  // ── 2. Ler os blocos da página (com paginação) ───────────────────────────
  const blocks = [];
  let cursor   = undefined;

  do {
    const url = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`
      + (cursor ? `&start_cursor=${cursor}` : '');

    const blocksRes = await fetch(url, { headers });

    if (!blocksRes.ok) {
      const err = await blocksRes.json();
      // pageId pode estar stale — limpa o cache e tenta nova busca na próxima vez
      await db.collection('mentoradas').doc(uid).update({ notionPageId: null }).catch(() => {});
      throw new HttpsError('internal', `Notion blocks falhou: ${err.message || blocksRes.status}`);
    }

    const page = await blocksRes.json();
    blocks.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  // ── 3. Parsear encontros e lições ─────────────────────────────────────────
  // Varre todos os blocos e coleta todos os encontros.
  // Ao final, fica com o de maior número (mais recente).
  let encontros       = [];      // { numero, tema, data, licoes[] }
  let encontroAtual   = null;
  let licoesAtuais    = [];
  let emLicao      = false;
  const parseWarnings = [];

  for (const block of blocks) {
    const type = block.type;

    // Heading 2 → marcador de encontro: "Encontro N | Tema | Data"
    if (type === 'heading_2') {
      const text = getRichText(block.heading_2?.rich_text);
      const match = text.match(/Encontro\s+(\d+)\s*[|\\]\s*(.+?)\s*[|\\]\s*(.+)/i);
      if (match) {
        // Salva o encontro anterior antes de começar um novo
        if (encontroAtual) {
          encontros.push({ ...encontroAtual, licoes: licoesAtuais });
        }
        encontroAtual = {
          numero: parseInt(match[1], 10),
          tema:   match[2].trim(),
          data:   match[3].trim(),
        };
        licoesAtuais = [];
        emLicao = false;
        continue;
      }
      // heading_2 fora do padrão esperado — registra para diagnóstico
      if (text.trim()) {
        console.warn(`[getNotionCRM] heading_2 fora do padrão: "${text}" (uid=${uid})`);
        parseWarnings.push(text.trim());
      }
    }

    if (!encontroAtual) continue;

    // Heading 3 → sub-seções do encontro ("Lição de Casa", "Alinhamentos", etc.)
    if (type === 'heading_3') {
      const text = getRichText(block.heading_3?.rich_text);
      emLicao = /li[çc][õaã]o?[eE]?[sS]?\s+de\s+casa|compromissos/i.test(text);
      continue;
    }

    // Divider → separa encontros
    if (type === 'divider') {
      emLicao = false;
      continue;
    }

    // To-do (checkbox) → lição de casa pendente
    if (type === 'to_do' && emLicao && !block.to_do?.checked) {
      const texto = getRichText(block.to_do?.rich_text).trim();
      if (texto) licoesAtuais.push(texto);
    }
  }

  // Salva o último encontro do loop
  if (encontroAtual) {
    encontros.push({ ...encontroAtual, licoes: licoesAtuais });
  }

  // Pega o encontro com maior número (mais recente)
  const melhor = encontros.sort((a, b) => b.numero - a.numero)[0] || null;
  const ultimoEncontro  = melhor ? { numero: melhor.numero, tema: melhor.tema, data: melhor.data } : null;
  const licoesPendentes = melhor ? melhor.licoes : [];

  // ── 4. Cachear no Firestore para o badge na lista ─────────────────────────
  await db.collection('mentoradas').doc(uid).update({
    notionPageId:          pageId,
    notionUltimoEncontro:  ultimoEncontro,
    notionLicoesPendentes: licoesPendentes.length,
    notionSyncedAt:        admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.warn('[getNotionCRM] Falha ao cachear:', e.message));

  return {
    notionPageUrl: pageUrl,
    ultimoEncontro,
    licoesPendentes,
    ...(parseWarnings.length > 0 && { parseWarnings }),
  };
});

// ─── CLUBE TRILOGIA ───────────────────────────────────────────────────────────

/**
 * Retorna todos os itens publicados no Clube, ordenados por ordem asc, data desc.
 * Qualquer usuária logada com assinaturaClube: true pode chamar.
 */
exports.getClubeContent = onCall({}, async (request) => {
  const auth = requireAuth(request);

  const docSnap = await db.collection('mentoradas').doc(auth.uid).get();
  if (!docSnap.exists || !docSnap.data().assinaturaClube) {
    throw new HttpsError('permission-denied', 'Acesso ao Clube não autorizado.');
  }

  // Busca sem orderBy composto (evita exigência de índice) e ordena em memória
  const snap = await db.collection('clubeContent').get();
  const itens = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  itens.sort((a, b) => {
    const ordemDiff = (a.ordem ?? 0) - (b.ordem ?? 0);
    if (ordemDiff !== 0) return ordemDiff;
    // data desc como desempate
    return (b.data || '').localeCompare(a.data || '');
  });
  return itens;
});

/**
 * Cria ou atualiza um item em clubeContent. Somente admin.
 * Campos obrigatórios: tipo, titulo, url, data.
 */
exports.saveClubeItem = onCall({}, async (request) => {
  requireAdmin(request);
  const { id, tipo, titulo, url, data, descricao, ordem } = request.data;

  if (!tipo || !titulo || !url || !data) {
    throw new HttpsError('invalid-argument', 'tipo, titulo, url e data são obrigatórios.');
  }
  if (!['gravacao', 'documento', 'agenda'].includes(tipo)) {
    throw new HttpsError('invalid-argument', 'tipo deve ser gravacao, documento ou agenda.');
  }

  const payload = {
    tipo,
    titulo,
    url,
    data,
    descricao: descricao || '',
    ordem:     typeof ordem === 'number' ? ordem : 0,
  };

  if (id) {
    await db.collection('clubeContent').doc(id).set(payload, { merge: true });
    return { ok: true, id };
  } else {
    payload.criadoEm = admin.firestore.FieldValue.serverTimestamp();
    const ref = await db.collection('clubeContent').add(payload);
    return { ok: true, id: ref.id };
  }
});

/**
 * Deleta um item de clubeContent. Somente admin.
 */
exports.deleteClubeItem = onCall({}, async (request) => {
  requireAdmin(request);
  const { id } = request.data;
  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');
  await db.collection('clubeContent').doc(id).delete();
  return { ok: true };
});

// ─── CRM Pipeline ─────────────────────────────────────────────────────────────

/**
 * Retorna todos os leads da coleção `leads`, ordenados por atualizadoEm desc.
 * Filtros opcionais: segmento, estagio, origem.
 * Inclui campo calculado `diasSemContato`.
 */

// ─── ANALYTICS DE ENGAJAMENTO ─────────────────────────────────────────────────

/**
 * Retorna os dados de engajamento de uma mentorada (acumulado + últimos 3 meses).
 * Exclusivo para admin.
 */
exports.getAnalytics = onCall({}, async (request) => {
  requireAdmin(request);
  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid obrigatório.');

  const base = db.collection('mentoradas').doc(uid).collection('analytics');
  const [geralSnap, mesesSnap] = await Promise.all([
    base.doc('geral').get(),
    base.orderBy('mes', 'desc').limit(3).get(),
  ]);

  return {
    geral:  geralSnap.exists ? geralSnap.data() : null,
    meses:  mesesSnap.docs
      .filter(d => d.id !== 'geral')
      .map(d => ({ mes: d.id, ...d.data() })),
  };
});

exports.getLeads = onCall({}, async (request) => {
  requireAdmin(request);
  const { segmento, estagio, origem } = request.data || {};

  const snap = await db.collection('leads').orderBy('atualizadoEm', 'desc').get();
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  let leads = snap.docs.map(doc => {
    const d = doc.data();
    let diasSemContato = null;
    if (d.ultimoContato) {
      const uc = new Date(d.ultimoContato + 'T00:00:00');
      diasSemContato = Math.floor((hoje - uc) / (1000 * 60 * 60 * 24));
    }
    return {
      id: doc.id,
      ...d,
      criadoEm:     d.criadoEm?.toDate?.()?.toISOString()     || null,
      atualizadoEm: d.atualizadoEm?.toDate?.()?.toISOString() || null,
      diasSemContato,
    };
  });

  if (segmento) leads = leads.filter(l => l.segmento === segmento);
  if (estagio)  leads = leads.filter(l => l.estagio  === estagio);
  if (origem)   leads = leads.filter(l => l.origem   === origem);

  return leads;
});

/**
 * Cria um novo lead. Campos obrigatórios: nome, estagio, segmento.
 */
exports.saveLead = onCall({}, async (request) => {
  requireAdmin(request);
  const { nome, estagio, segmento, ...resto } = request.data || {};
  if (!nome)     throw new HttpsError('invalid-argument', 'nome é obrigatório.');
  if (!estagio)  throw new HttpsError('invalid-argument', 'estagio é obrigatório.');
  if (!segmento) throw new HttpsError('invalid-argument', 'segmento é obrigatório.');

  const agora = admin.firestore.FieldValue.serverTimestamp();
  const ref = await db.collection('leads').add({
    nome, estagio, segmento, ...resto,
    criadoEm:     agora,
    atualizadoEm: agora,
  });
  return { ok: true, id: ref.id };
});

/**
 * Atualiza campos de um lead existente. Sempre atualiza atualizadoEm.
 */
exports.updateLead = onCall({}, async (request) => {
  requireAdmin(request);
  const { id, ...campos } = request.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');

  await db.collection('leads').doc(id).update({
    ...campos,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/**
 * Deleta um lead pelo id.
 */
exports.deleteLead = onCall({}, async (request) => {
  requireAdmin(request);
  const { id } = request.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');
  await db.collection('leads').doc(id).delete();
  return { ok: true };
});

exports.bulkImportLeads = onCall({}, async (request) => {
  requireAdmin(request);
  const { leads } = request.data || {};
  if (!Array.isArray(leads) || !leads.length) throw new HttpsError('invalid-argument', 'leads deve ser array não-vazio.');
  if (leads.length > 500) throw new HttpsError('invalid-argument', 'Máximo de 500 leads por importação.');
  const agora = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  for (const lead of leads) {
    const ref = db.collection('leads').doc();
    batch.set(ref, { ...lead, criadoEm: agora, atualizadoEm: agora });
  }
  await batch.commit();
  return { ok: true, count: leads.length };
});

// ─── Sync Diagnóstico ─────────────────────────────────────────────────────────
// Lê a planilha pública do diagnóstico, deduplica por WhatsApp e importa leads novos.
const DIAGNOSTICO_SHEET_ID = '12Bl-tas3YMjg4EV9nAx3ZVlkA6GPfE8WRR3gccmfBGE';

function parseCSVLine(line) {
  const result = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; }
    else if (c === ',' && !inQuotes) { result.push(field.trim()); field = ''; }
    else { field += c; }
  }
  result.push(field.trim());
  return result;
}

function normalizarTelefone(tel) {
  return (tel || '').replace(/\D/g, '');
}

function mapProdutoDiagnostico(produtoIndicado) {
  const p = (produtoIndicado || '').toLowerCase();
  if (p.includes('mentoria')) return 'Mentoria Trilogia R$4.700';
  if (p.includes('jornada'))  return 'Jornada Domine R$197';
  if (p.includes('clube'))    return 'Clube Trilogia R$97/mês';
  if (p.includes('reserva'))  return 'Reserva que Rende R$247';
  if (p.includes('mapa'))     return 'Mapa da Reserva R$67';
  if (p.includes('raio'))     return 'Raio-X Financeiro R$67';
  return '';
}

// Chave secreta para o webhook de diagnóstico — armazenada no Secret Manager.

// Lógica compartilhada de sync — usada tanto pelo onCall quanto pelo webhook HTTP.
async function runSyncDiagnostico() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${DIAGNOSTICO_SHEET_ID}/export?format=csv`;
  const resp = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Erro ao ler planilha: ${resp.status}`);
  const csv = await resp.text();

  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { ok: true, count: 0, msg: 'Planilha vazia.' };
  const rows = lines.slice(1).map(parseCSVLine);
  // Colunas: [0]Data [1]Nome [2]Email [3]WhatsApp [4]Perfil [5]Renda [6]Investimento [7]Produto [8]Origem

  const existingSnap = await db.collection('leads').get();
  const existingPhones = new Set(
    existingSnap.docs
      .map(d => normalizarTelefone(d.data().whatsapp))
      .filter(p => p.length >= 8)
  );

  const agora = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  let count = 0;

  for (const row of rows) {
    const tel = normalizarTelefone(row[3]);
    if (!row[1] || !tel) continue;
    if (tel.length >= 8 && existingPhones.has(tel)) continue;

    const notas = [
      row[4] ? `Perfil: ${row[4]}` : '',
      row[5] ? `Renda: ${row[5]}` : '',
      row[6] ? `Investimento: ${row[6]}` : '',
      row[2] ? `Email: ${row[2]}` : '',
    ].filter(Boolean).join(' | ');

    const ref = db.collection('leads').doc();
    batch.set(ref, {
      nome:         row[1],
      whatsapp:     row[3],
      origem:       'Diagnóstico',
      produtoAlvo:  mapProdutoDiagnostico(row[7]),
      estagio:      'Lead Frio',
      segmento:     'pipeline',
      probabilidade: 10,
      notas,
      criadoEm:     agora,
      atualizadoEm: agora,
    });
    existingPhones.add(tel);
    count++;
  }

  if (count > 0) await batch.commit();
  return { ok: true, count };
}

// Chamado pelo admin.html (requer autenticação Firebase admin)
exports.syncDiagnostico = onCall({}, async (request) => {
  requireAdmin(request);
  try {
    return await runSyncDiagnostico();
  } catch (err) {
    throw new HttpsError('internal', err.message);
  }
});

// Chamado pelo Apps Script (autenticação via chave secreta)
exports.syncDiagnosticoWebhook = onRequest({ secrets: [sDiagSecret] }, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const secret = req.body?.secret;
  if (secret !== sDiagSecret.value()) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const result = await runSyncDiagnostico();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
