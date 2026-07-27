'use strict';

const { ErrorReporting } = require('@google-cloud/error-reporting');
const errors = new ErrorReporting({ projectId: 'trilogia-dashboard', reportUnhandledRejections: true });

const { setGlobalOptions }   = require('firebase-functions/v2');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');

// Todas as funções deployam em São Paulo (menor latência para usuárias brasileiras)
setGlobalOptions({ region: 'southamerica-east1' });
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
const sMailerLite         = defineSecret('MAILERLITE_API_KEY');
const sMailerLiteRaiox    = defineSecret('MAILERLITE_GRUPO_RAIOX');
const sMailerLiteMapa     = defineSecret('MAILERLITE_GRUPO_MAPA');
const sMailerLiteJdd      = defineSecret('MAILERLITE_GRUPO_JDD');
const sMailerLiteReserva  = defineSecret('MAILERLITE_GRUPO_RESERVA_RENDE');
const sZapiId             = defineSecret('ZAPI_INSTANCE_ID');
const sZapiToken  = defineSecret('ZAPI_TOKEN');
const sZapiClient = defineSecret('ZAPI_CLIENT_TOKEN');
const sAnthropic  = defineSecret('ANTHROPIC_API_KEY'); // categorizarExtratoIA — substitui o Custom GPT do Raio-X
const sSmokeToken = defineSecret('SMOKE_TEST_TOKEN'); // smokeTestAlerta — token compartilhado com scripts/smoke-test.js

const { requireAuth, requireAdmin, requireSelfOrAdmin, getSheetId } = require('./lib/auth');
const { SheetsClient }    = require('./lib/sheets');
const { provisionar, deletePlanilha } = require('./lib/provisionar');
const { MailerLiteClient } = require('./lib/mailerlite');
const { ZApiClient }       = require('./lib/zapi');
const {
  sendEmail,
  emailRenovacaoPerfil,
  emailSemPerfil,
  emailLembreteOrcamento,
  emailLembreteAporte,
  emailLembretePlanejamento,
  emailNovidades,
  emailNovidadesJun2026,
  emailNovidadesJun2026v3,
  emailNovidadesJun2026Completo,
  emailNovidadesJul2026,
  emailBalancoJul2026,
  emailMultiplasContasJul2026,
  emailRaioXJul2026,
  emailPatrimonioIAJul2026,
  emailJornadaDashboard,
  emailIR,
  emailReenvioAcesso,
  emailBoasVindas,
  emailExpiracaoProxima,
  emailCobrancasDia,
  emailImpostosDia,
  emailRetencaoDia1,
  emailRetencaoDia3,
  emailRetencaoDia7,
  emailRelatorioMensal,
  emailComunicadoTecnico,
  emailUpgradeDashboard,
} = require('./lib/mailer');

admin.initializeApp();
const db = admin.firestore();

// ─── Helpers internos ─────────────────────────────────────────────────────────
function maskEmail(e) {
  if (!e) return '';
  const s = String(e);
  const i = s.indexOf('@');
  if (i < 2) return '***@***';
  return s.slice(0, 2) + '***' + s.slice(i);
}

async function deleteSubcolecao(uid, nomeColecao) {
  const snap = await db.collection('mentoradas').doc(uid).collection(nomeColecao).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// Arrays de defineSecret para cada grupo de funções.
const SECRETS_EMAIL  = [sGmail];
const SECRETS_SHEETS = [sSA, sFolderId];
const SECRETS_ALL    = [sGmail, sClientId, sClientSec, sRefresh, sFolderId, sSA];
const SECRETS_PUSH   = [sVapidPub, sVapidPriv];

// ID da pasta no Google Drive da Flávia onde ficam as planilhas das mentoradas.
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';

// ─── Monitoramento de erros ───────────────────────────────────────────────────

/**
 * Envia alerta de erro para o admin por e-mail.
 * Usado pelas funções agendadas críticas quando falham de forma inesperada.
 */
async function alertarErro(funcao, erro) {
  // Reporta ao Cloud Error Reporting (capturado no GCP Console + alertas automáticos)
  try { errors.report(erro instanceof Error ? erro : new Error(String(erro))); } catch (_) {}

  const nodemailer = require('nodemailer');
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: 'flaviasch@gmail.com', pass: process.env.GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from:    '"Trilogia Dashboard" <flaviasch@gmail.com>',
      to:      'flaviasch@gmail.com',
      subject: `⚠️ Erro na função ${funcao}`,
      html: `
        <p style="font-family:sans-serif;font-size:14px;">
          A função <strong>${funcao}</strong> falhou em
          <strong>${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</strong>.
        </p>
        <pre style="background:#f4f4f5;padding:16px;border-radius:8px;font-size:13px;overflow:auto;">${String(erro?.stack || erro?.message || erro)}</pre>
        <p style="font-family:sans-serif;font-size:13px;color:#6b7280;">
          Verifique os logs em
          <a href="https://console.firebase.google.com/project/trilogia-dashboard/functions/logs">Firebase Console → Functions → Logs</a>.
        </p>`,
    });
  } catch (emailErr) {
    console.error('[alertarErro] Falha ao enviar alerta:', emailErr.message);
  }
}

/**
 * smokeTestAlerta — recebe o resultado do teste de fumaça pós-deploy
 * (scripts/smoke-test.js, rodado manualmente pela Flávia depois de cada deploy)
 * e dispara alertarErro se alguma das funções críticas falhou.
 *
 * Protegida por token compartilhado (SMOKE_TEST_TOKEN), mesmo padrão do
 * syncDiagnosticoWebhook — não é dado sensível (não dá acesso a nada além de
 * poder disparar um e-mail de alerta falso), mas ainda assim fica em Secret
 * Manager, nunca hardcoded.
 *
 * Body esperado: { token, ok: boolean, resultados: [{ funcao, ok, erro }] }
 */
exports.smokeTestAlerta = onRequest({ secrets: [sGmail, sSmokeToken] }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const tokenRecebido = req.headers['x-smoke-test-token'] || req.body?.token;
  if (tokenRecebido !== sSmokeToken.value()) {
    console.warn('[smokeTestAlerta] Token inválido — requisição ignorada.');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const { ok, resultados } = req.body || {};

  if (ok === false) {
    const falhas = (Array.isArray(resultados) ? resultados : []).filter(r => !r.ok);
    const resumo = falhas.length > 0
      ? falhas.map(f => `• ${f.funcao}: ${f.erro}`).join('\n')
      : 'Smoke test reportou falha, mas sem detalhe de qual função.';
    console.error('[smokeTestAlerta] Falhas detectadas no pós-deploy:\n' + resumo);
    await alertarErro('smokeTest (pós-deploy)', new Error(resumo)).catch(() => {});
  } else {
    console.log('[smokeTestAlerta] ✅ Smoke test passou — nenhuma ação necessária.');
  }

  res.status(200).json({ recebido: true });
});

/**
 * Envolve uma função agendada com try/catch + alerta de erro.
 */
function comMonitoramento(nomeFuncao, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[${nomeFuncao}] ERRO CRÍTICO:`, err);
      await alertarErro(nomeFuncao, err).catch(() => {});
      throw err; // propaga para o Cloud Functions registrar no log
    }
  };
}

/**
 * Idempotência para funções agendadas.
 * Usa transação atômica para garantir que mesmo com retry paralelo
 * a função executa apenas uma vez por data.
 *
 * @returns {boolean} true se já executou hoje (deve abortar), false se pode prosseguir
 */
async function jaExecutouHoje(nomeFuncao) {
  const hoje = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const ref  = db.collection('_notif_ctrl').doc(`${nomeFuncao}_${hoje}`);
  try {
    await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (snap.exists) {
        // Já existe (executando ou enviado) — aborta via erro controlado
        throw Object.assign(new Error('JA_EXECUTOU'), { jaExecutou: true });
      }
      // Marca como executando — qualquer retry paralelo vai cair no branch acima
      t.set(ref, {
        status:     'executando',
        iniciadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    return false; // pode prosseguir
  } catch (err) {
    if (err.jaExecutou) {
      console.log(`[${nomeFuncao}] Já executou hoje (${hoje}) — abortando retry.`);
      return true;
    }
    // Erro real na transação — loga mas deixa a função continuar (melhor enviar do que não enviar)
    console.warn(`[${nomeFuncao}] Falha ao verificar idempotência:`, err.message);
    return false;
  }
}

/**
 * Marca a função agendada como concluída para a data de hoje.
 */
async function marcarEnviado(nomeFuncao) {
  const hoje = new Date().toISOString().slice(0, 10);
  const ref  = db.collection('_notif_ctrl').doc(`${nomeFuncao}_${hoje}`);
  await ref.update({
    status:       'enviado',
    concluidoEm:  admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.warn(`[${nomeFuncao}] Falha ao marcar enviado:`, e.message));
}

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

/**
 * Calcula o score de saúde financeira (0–100) a partir dos itens do orçamento,
 * das reservas e das categorias com limite planejado.
 *
 * Fallback usado só por getDashboardHome, quando ainda não existe score salvo
 * pro mês (salvarScoreMes, chamado por orcamento.html com a fórmula completa
 * — js/orcamento-calc.js). Deploy do Cloud Functions empacota só a pasta
 * functions/ (ver firebase.json), então não dá pra importar js/orcamento-calc.js
 * direto daqui — por isso essa cópia existe.
 *
 * Diferença conhecida e intencional: esta versão NÃO exclui compras na
 * fatura de cartão em ABERTO (getDashboardHome não lê a coleção de cartões,
 * pra ficar leve) — orcamento.html exclui. Na prática o score fica um pouco
 * mais pessimista aqui até a mentorada abrir a aba Orçamento uma vez no mês
 * (o que salva o score correto e sobrescreve este). Pesos/faixas de pontos
 * abaixo devem continuar batendo com calcularScore() em orcamento.html —
 * cobertos por testes em functions/test/score.test.js.
 */
function calcularScoreMes(orcItens, reservas, cats) {
  const receita      = orcItens.filter(i => i.tipo === 'receita').reduce((s, i) => s + i.valor, 0);
  const despesa      = orcItens.filter(i => i.tipo === 'despesa').reduce((s, i) => s + i.valor, 0);
  const totalAporte  = orcItens.filter(i => i.tipo === 'aporte' ).reduce((s, i) => s + i.valor, 0);
  const sobra        = receita - despesa;
  const totalPlan    = (reservas || []).reduce((s, r) => s + (r.aporte || 0), 0);

  // ① Sobra
  const sobraPct = receita > 0 ? sobra / receita * 100 : 0;
  let ptsSobra = 0;
  if      (sobraPct >= 30) ptsSobra = 100;
  else if (sobraPct >= 20) ptsSobra = 80;
  else if (sobraPct >= 10) ptsSobra = 50;
  else if (sobraPct > 0)   ptsSobra = 20;

  // ② Aporte
  let ptsAporte = 0;
  if (totalPlan > 0) {
    const execPct = totalAporte / totalPlan * 100;
    if      (execPct >= 100) ptsAporte = 100;
    else if (execPct >= 80)  ptsAporte = 80;
    else if (execPct >= 50)  ptsAporte = 50;
    else if (execPct > 0)    ptsAporte = 20;
  }

  // ③ Orçamento (categorias com limite)
  const catsComLimite = (cats || []).filter(c => c.limite > 0);
  let ptsOrcamento = 75; // neutro quando sem limites definidos
  if (catsComLimite.length > 0) {
    const despesasArr = orcItens.filter(i => i.tipo === 'despesa');
    const estouradas = catsComLimite.filter(c => {
      // _normCat (case/acento-insensível) — mesmo critério de orcamento.html;
      // comparação exata deixava "Alimentação"/"alimentação" contarem separado.
      const gasto = despesasArr.filter(d => _normCat(d.categoria) === _normCat(c.nome)).reduce((s, d) => s + d.valor, 0);
      return gasto > c.limite;
    }).length;
    if      (estouradas === 0) ptsOrcamento = 100;
    else if (estouradas === 1) ptsOrcamento = 70;
    else if (estouradas === 2) ptsOrcamento = 40;
    else                       ptsOrcamento = 0;
  }

  // ④ Regularidade
  const ptsRegularidade = (receita > 0 || despesa > 0) ? 100 : 0;

  return Math.round(ptsSobra * 0.30 + ptsAporte * 0.35 + ptsOrcamento * 0.25 + ptsRegularidade * 0.10);
}

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
/**
 * getNivelAcesso — leitura mínima (1 campo) usada só para o guard de acesso em
 * patrimonio.html/reservas.html/perfil.html, que não chamam getDashboard/getDashboardHome.
 * Contas nivelAcesso: 'raio-x' (degustação, só módulo Orçamento) são redirecionadas
 * para orcamento.html por essas páginas ao ver este retorno.
 */
exports.getNivelAcesso = onCall({}, async (request) => {
  const auth = requireAuth(request);
  const uid  = request.data?.uid || auth.uid;
  requireSelfOrAdmin(request, uid);
  const docSnap = await db.collection('mentoradas').doc(uid).get();
  if (!docSnap.exists) throw new HttpsError('not-found', `Mentorada não encontrada: ${uid}`);
  return { nivelAcesso: docSnap.data().nivelAcesso || null };
});

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
          assinaturaClube, assinaturaDashboard, nivelAcesso,
          scoreMes, scoreChave } = docSnap.data();

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

  // ── Firestore: 4 leituras em paralelo ───────────────────────────────────
  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const [orcSnap, patSnap, resSnap, perfilSnap] = await Promise.all([
    db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKey).get().catch(() => null),
    db.collection('mentoradas').doc(uid).collection('patrimonio').doc('dados').get().catch(() => null),
    db.collection('mentoradas').doc(uid).collection('reservas').get().catch(() => null),
    db.collection('mentoradas').doc(uid).collection('perfil').doc('dados').get().catch(() => null),
  ]);

  if (orcSnap?.exists)   orcamento = orcSnap.data().itens || [];
  if (patSnap?.exists) {
    ir        = patSnap.data().ir        || [];
    corretora = patSnap.data().corretora || [];
    dividas   = patSnap.data().dividas   || [];
  }
  if (resSnap && !resSnap.empty) reservas = resSnap.docs.map(d => ({ ...d.data(), id: d.id }));
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
    nivelAcesso:     nivelAcesso     || null, // 'raio-x' → frontend esconde Patrimônio/Reservas/Perfil
    sheetError:      sheetError,
    scoreMes:        scoreMes        ?? null,
    scoreChave:      scoreChave      ?? null,
  };
});

/**
 * getDashboardHome — versão leve do getDashboard para carregar a home rapidamente.
 * Lê APENAS o documento principal + subcoleção reservas (2 reads paralelos, sem Sheets).
 * Usa valores cacheados (pl, sobra, scoreMes) para os cards que precisam de cálculo.
 * O frontend chama getOrcamento e getPatrimonio em background para completar os dados.
 */
exports.getDashboardHome = onCall({ minInstances: 1 }, async (request) => {
  const auth = requireAuth(request);
  const uid  = request.data?.uid || auth.uid;
  requireSelfOrAdmin(request, uid);

  const agora    = new Date();
  const mes      = agora.getMonth() + 1;
  const ano      = agora.getFullYear();
  const mesAtual = agora.toISOString().slice(0, 7);

  // Lê doc principal + reservas + missão do mês + orçamento atual + planejamento em paralelo
  const [docSnap, resSnap, missaoSnap, orcSnap, planSnap] = await Promise.all([
    db.collection('mentoradas').doc(uid).get(),
    db.collection('mentoradas').doc(uid).collection('reservas').get().catch(() => null),
    db.collection('config').doc('missaoMes').get().catch(() => null),
    db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesAtual).get().catch(() => null),
    db.collection('mentoradas').doc(uid).collection('planejamento').doc(mesAtual).get().catch(() => null),
  ]);

  if (!docSnap.exists) throw new HttpsError('not-found', `Mentorada não encontrada: ${uid}`);

  const { nome, inicio, perfil: perfilFirestore, lgpdAceite, ultimoAcessoMes,
          assinaturaClube, assinaturaDashboard, mentoriaEncerrada, nivelAcesso,
          pl, sobra, totalReservas, scoreMes, scoreChave, sheetId, dataExpiracao } = docSnap.data();

  // Controle de acesso
  const isAdminUser = request.auth?.token?.admin === true;

  // Bloqueio em tempo real se a mentoria acabou (encerrada explicitamente OU
  // dataExpiracao vencida — mesmos dois sinais que o cron verificarExpiracoes
  // e o webhook da Kiwify já usam pra desabilitar o Auth) e não há assinatura
  // ativa, recalculado a cada carregamento da home (achado 26/07/2026: antes
  // disso só o cron das 9h desabilitava o Auth — entre o cancelamento/
  // vencimento e o cron rodar, ou se o Auth for reabilitado manualmente por
  // qualquer motivo, ex: teste do Dashboard PJ — o dashboard continuava
  // liberado inteiro, só com um banner de upsell por cima. dataExpiracao
  // sozinha não bastava: uma mentoria pode estar `mentoriaEncerrada: true`
  // com dataExpiracao ainda no futuro, sobrando de quando o contrato foi
  // criado. Sem exceção pra PJ ativo aqui, de propósito: PJ ativo é motivo
  // pra manter o Auth compartilhado habilitado — pra login-pj/impostos-pj
  // continuarem funcionando — mas não é motivo pra liberar o conteúdo
  // financeiro do PF de graça, que é um produto separado. achado 26/07/2026,
  // Flávia: "não deveria [continuar acessando o PF]" testando com PJ ativo).
  // Admin (viewAsUid) sempre passa, pra poder inspecionar a conta.
  const hoje = agora.toISOString().slice(0, 10);
  const semAssinaturaAtiva = assinaturaDashboard !== true && assinaturaClube !== true;
  const mentoriaAcabou = mentoriaEncerrada === true || (dataExpiracao && dataExpiracao <= hoje);
  const acessoExpirado = !isAdminUser && semAssinaturaAtiva && mentoriaAcabou;
  if (acessoExpirado) {
    return { acessoBloqueado: true, nome: nome || null, inicio: inicio || null, lgpdAceite: lgpdAceite || false };
  }

  const clubeOnly   = assinaturaClube === true && assinaturaDashboard !== true;
  const temDashboard = isAdminUser || !clubeOnly;

  if (!temDashboard && assinaturaClube) {
    return { apenasClube: true, nome: nome || null, inicio: inicio || null, lgpdAceite: lgpdAceite || false, assinaturaClube: true };
  }
  // Admin ou assinante do dashboard sem Sheets ainda → home carrega com dados do Firestore
  if (!sheetId && !assinaturaClube && !isAdminUser && !assinaturaDashboard) {
    throw new HttpsError('failed-precondition', 'Planilha ainda não configurada para esta mentorada.');
  }

  const reservas = resSnap?.docs.map(d => ({ ...d.data(), id: d.id })) || [];

  // Orçamento do mês atual (para onboarding e cards iniciais)
  const orcItens   = orcSnap?.exists ? (orcSnap.data().itens || []) : [];
  const receitaMes = orcItens.filter(i => i.tipo === 'receita').reduce((s, i) => s + i.valor, 0);
  const despesaMes = orcItens.filter(i => i.tipo === 'despesa').reduce((s, i) => s + i.valor, 0);
  const aporteMes  = orcItens.filter(i => i.tipo === 'aporte').reduce((s, i) => s + i.valor, 0);
  const sobraMes   = receitaMes - despesaMes;

  // Se o orcamento.html já salvou um score pro mês atual (via salvarScoreMes,
  // usando a fórmula completa com fatura aberta/fechada e despesas fixas
  // virtuais — ver js/orcamento-calc.js), usa esse valor. Só recalcula aqui
  // com a fórmula simplificada (sem essas nuances) quando ainda não existe
  // nada salvo pro mês — evita a home sobrescrever com um número divergente
  // do que a aba Orçamento mostra (achado em 07/07/2026).
  const cats = planSnap?.exists ? (planSnap.data().categorias || []) : [];
  let scoreCalculado, scoreChaveCalculado;
  if (scoreChave === mesAtual && scoreMes != null) {
    scoreCalculado = scoreMes;
    scoreChaveCalculado = scoreChave;
  } else {
    scoreCalculado = orcItens.length > 0 ? calcularScoreMes(orcItens, reservas, cats) : null;
    scoreChaveCalculado = scoreCalculado != null ? mesAtual : null;
    if (scoreCalculado != null) {
      docSnap.ref.update({ scoreMes: scoreCalculado, scoreChave: scoreChaveCalculado })
        .catch(e => console.warn(`[getDashboardHome] Falha ao salvar score: ${e.message}`));
    }
  }

  // Registra acesso em background (fire-and-forget)
  if (uid === auth.uid) {
    docSnap.ref.update({
      ultimoAcesso:    admin.firestore.FieldValue.serverTimestamp(),
      totalAcessos:    admin.firestore.FieldValue.increment(1),
      acessosMes:      ultimoAcessoMes === mesAtual
                         ? admin.firestore.FieldValue.increment(1)
                         : 1,
      ultimoAcessoMes: mesAtual,
    }).catch(e => console.warn(`[getDashboardHome] Falha ao registrar acesso: ${e.message}`));
  }

  return {
    nome:            nome            || null,
    inicio:          inicio          || null,
    lgpdAceite:      lgpdAceite      || false,
    assinaturaClube: assinaturaClube || false,
    perfil:          { perfil: perfilFirestore?.perfil || perfilFirestore || null, dataAtualizacao: null },
    reservas,
    // Valores cacheados (atualizados a cada save de orçamento/patrimônio)
    plCacheado:          pl            ?? null,
    sobraCacheada:       sobra         ?? null,
    totalReservasCacheado: totalReservas ?? null,
    scoreMes:           scoreCalculado    ?? scoreMes  ?? null,
    scoreChave:         scoreChaveCalculado ?? scoreChave ?? null,
    mentoriaEncerrada:  mentoriaEncerrada || false,
    assinaturaDashboard: assinaturaDashboard || false,
    nivelAcesso:        nivelAcesso       || null, // 'raio-x' → frontend esconde Patrimônio/Reservas/Perfil
    mes,
    ano,
    orcamento:       { receita: receitaMes, despesa: despesaMes, sobra: sobraMes, aporte: aporteMes, mes, ano },
    sheetError:      false,
    missaoMes: (() => {
      const d = missaoSnap?.data();
      if (!d || d.mes !== mesAtual) return null;
      return { titulo: d.titulo || null, descricao: d.descricao || null };
    })(),
  };
});

// ─── MATERIAIS DA JORNADA (jornada.html — seção "Ferramentas da sua Jornada") ──
// Ver dashboard/MATERIAIS_JORNADA_SPEC.md para o desenho completo.
// Formulários de reflexão e calculadoras salvam em materiaisJornada/{ferramentaId}
// (um doc por ferramenta, sobrescrito a cada save). O fluxo de decisão
// P.A.R.I.S.+Anti-Impulso usa uma coleção separada (decisoesFinanceiras) por ser
// um log de múltiplos registros — ainda não implementado nesta leva.

const _FERRAMENTAS_JORNADA_VALIDAS = new Set([
  'diario-historias', 'quiz-vieses', 'mapa-ambiente', 'conexao-familia',
  'calculadora-reserva', 'plano-comportamental', 'desafio-7-dias',
  'preco-real-decisao', 'mapa-liberdade',
]);

exports.getMateriaisJornada = onCall(async (request) => {
  const auth = requireAuth(request);
  const uid  = request.data?.uid || auth.uid;
  requireSelfOrAdmin(request, uid);

  const snap = await db.collection('mentoradas').doc(uid).collection('materiaisJornada').get();
  const materiais = {};
  snap.docs.forEach(d => { materiais[d.id] = d.data(); });
  return { materiais };
});

exports.salvarMaterialJornada = onCall(async (request) => {
  const auth = requireAuth(request);
  const uid  = request.data?.uid || auth.uid;
  requireSelfOrAdmin(request, uid);

  const { ferramentaId, respostas, status } = request.data || {};
  if (!ferramentaId || !_FERRAMENTAS_JORNADA_VALIDAS.has(ferramentaId)) {
    throw new HttpsError('invalid-argument', 'ferramentaId inválido.');
  }
  if (typeof respostas !== 'object' || respostas === null) {
    throw new HttpsError('invalid-argument', 'respostas deve ser um objeto.');
  }

  await db.collection('mentoradas').doc(uid).collection('materiaisJornada').doc(ferramentaId).set({
    ferramentaId,
    respostas,
    status: status || 'em_andamento',
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { ok: true };
});

// Fluxo P.A.R.I.S. + Checklist Anti-Impulso (Encontro 4): diferente das demais
// ferramentas por ser um LOG — cada decisão vira um novo documento, não sobrescreve
// a anterior. Ver MATERIAIS_JORNADA_SPEC.md seção 2 (Encontro 4).
exports.registrarDecisaoFinanceira = onCall(async (request) => {
  const auth = requireAuth(request);
  const uid  = request.data?.uid || auth.uid;
  requireSelfOrAdmin(request, uid);

  const { descricaoCompra, paris, antiImpulso, decisao } = request.data || {};
  if (!descricaoCompra || typeof descricaoCompra !== 'string') {
    throw new HttpsError('invalid-argument', 'descricaoCompra é obrigatória.');
  }
  if (typeof paris !== 'object' || paris === null) {
    throw new HttpsError('invalid-argument', 'paris deve ser um objeto.');
  }
  if (typeof antiImpulso !== 'object' || antiImpulso === null) {
    throw new HttpsError('invalid-argument', 'antiImpulso deve ser um objeto.');
  }

  const ref = await db.collection('mentoradas').doc(uid).collection('decisoesFinanceiras').add({
    descricaoCompra,
    paris,
    antiImpulso,
    decisao: decisao || null,
    criadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true, id: ref.id };
});

exports.getDecisoesFinanceiras = onCall(async (request) => {
  const auth = requireAuth(request);
  const uid  = request.data?.uid || auth.uid;
  requireSelfOrAdmin(request, uid);

  const snap = await db.collection('mentoradas').doc(uid).collection('decisoesFinanceiras')
    .orderBy('criadoEm', 'desc').limit(50).get();
  const decisoes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return { decisoes };
});

// ─── MAPA DA LIBERDADE FINANCEIRA — motor completo ─────────────────────────────
// Ver dashboard/MAPA_LIBERDADE_MOTOR_SPEC.md para o desenho completo. Bloco A:
// só o motor de simulação — a UI (liberdade.html) vem no Bloco B.
//
// Simplificação assumida (documentada, não escondida): quando um objetivo ou a
// renda desejada de aposentadoria é atribuída a "casal", usa a Pessoa 1 como
// relógio de referência (idade dela converte "idade-alvo" em mês da simulação).
// Rendas/despesas usam data calendário própria, não dependem de idade de ninguém.

function _addMeses(dataISO, n) {
  const d = new Date(dataISO + 'T00:00:00');
  d.setMonth(d.getMonth() + n);
  return d;
}

function _mesesEntre(dataInicioISO, dataFimISO) {
  const a = new Date(dataInicioISO + 'T00:00:00');
  const b = new Date(dataFimISO + 'T00:00:00');
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

// Renda/despesa está vigente no mês `mes` (0 = hoje) se a data desse mês cai
// dentro de [dataInicio, dataFim ?? infinito].
function _rdVigenteNoMes(rd, hojeISO, mes) {
  const dataMes = _addMeses(hojeISO, mes);
  const inicio = new Date((rd.dataInicio || hojeISO) + 'T00:00:00');
  if (dataMes < inicio) return false;
  if (rd.dataFim) {
    const fim = new Date(rd.dataFim + 'T00:00:00');
    if (dataMes > fim) return false;
  }
  return true;
}

// Valor líquido mensal equivalente de uma renda/despesa, dado o mês simulado.
// "única" só conta no mês exato de dataInicio. "anual" só conta no mês em que
// bate o aniversário de dataInicio. "mensal" conta todo mês vigente.
function _rdValorNoMes(rd, hojeISO, mes) {
  if (!_rdVigenteNoMes(rd, hojeISO, mes)) return 0;
  const liquido = rd.tipo === 'renda' ? rd.valorBruto * (1 - (rd.impostoPct || 0) / 100) : rd.valorBruto;
  if (rd.frequencia === 'mensal') return liquido;
  if (rd.frequencia === 'unica') {
    return mes === _mesesEntre(hojeISO, rd.dataInicio) ? liquido : 0;
  }
  if (rd.frequencia === 'anual') {
    const mesesDesdeInicio = mes - _mesesEntre(hojeISO, rd.dataInicio);
    return (mesesDesdeInicio >= 0 && mesesDesdeInicio % 12 === 0) ? liquido : 0;
  }
  return 0;
}

// Soma o equivalente mensal das despesas que continuam ativas depois da
// aposentadoria (decidido em 22/07/2026, mesmo critério da XP: despesa sem
// "Ao se aposentar" marcado — ou seja, sem dataFim, ou com dataFim depois do
// mês de aposentadoria — soma na necessidade mensal de saque, além da renda
// desejada). Despesas "única" não contam (não são um custo recorrente) nem
// despesas que já encerraram até a aposentadoria.
function _despesaMensalContinuaAposAposentadoria(rendasDespesas, hojeISO, mesAposentadoria) {
  let total = 0;
  (rendasDespesas || []).forEach(rd => {
    if (rd.tipo !== 'despesa' || rd.frequencia === 'unica') return;
    const mesInicio = _mesesEntre(hojeISO, rd.dataInicio || hojeISO);
    if (mesInicio > mesAposentadoria) return; // ainda não começou até a aposentadoria
    if (rd.dataFim) {
      const mesFim = _mesesEntre(hojeISO, rd.dataFim);
      if (mesFim <= mesAposentadoria) return; // já encerrou até lá
    }
    total += rd.frequencia === 'anual' ? (rd.valorBruto || 0) / 12 : (rd.valorBruto || 0);
  });
  return total;
}

function _resolverPessoa(atribuidoA, pessoas) {
  if (atribuidoA === 'casal') return pessoas[0];
  return pessoas.find(p => p.id === atribuidoA) || pessoas[0];
}

function _mesesAteIdade(pessoa, idadeAlvo) {
  return Math.max(0, Math.round((idadeAlvo - pessoa.idadeAtual) * 12));
}

// Valor presente de uma anuidade mensal `pmt` por `n` meses a taxa mensal `i`.
function _valorPresenteAnuidade(pmt, n, i) {
  if (n <= 0) return 0;
  if (i === 0) return pmt * n;
  return pmt * (1 - Math.pow(1 + i, -n)) / i;
}

function _simularLiberdade({ pessoas, patrimonioInicial, rendaMensalDesejadaAposentadoria, objetivosExtras, rendasDespesas, premissas }) {
  const hojeISO = new Date().toISOString().slice(0, 10);
  const i = (premissas?.taxaRealMensalPct ?? 0.8) / 100;

  const pessoaRef = pessoas[0]; // relógio mestre da simulação
  const totalMeses = Math.max(...pessoas.map(p => _mesesAteIdade(p, p.expectativaVida)));
  const mesAposentadoria = _mesesAteIdade(pessoaRef, pessoaRef.idadeAposentadoria);

  // Pré-calcula em que mês cada objetivo extra saca do patrimônio. Guarda a
  // descrição também — usado pro gráfico marcar o momento de cada objetivo
  // (estilo XP: números no gráfico indicando quando cada um é realizado).
  const saques = []; // { mes, valor, descricao }
  (objetivosExtras || []).forEach(obj => {
    const pessoa = _resolverPessoa(obj.atribuidoA, pessoas);
    const mesAlvo = _mesesAteIdade(pessoa, obj.idadeAtingimento);
    const descricao = obj.descricao || 'Objetivo';
    if (obj.frequencia === 'unica') {
      saques.push({ mes: mesAlvo, valor: obj.valor, descricao });
    } else {
      const n = Math.max(1, obj.numOcorrencias || 1);
      for (let k = 0; k < n; k++) saques.push({ mes: mesAlvo + k * 12, valor: obj.valor / n, descricao });
    }
  });

  let patrimonio = patrimonioInicial || 0;
  const serieAtual = [];
  for (let mes = 0; mes <= totalMeses; mes++) {
    let netMes = 0;
    (rendasDespesas || []).forEach(rd => {
      const v = _rdValorNoMes(rd, hojeISO, mes);
      netMes += rd.tipo === 'renda' ? v : -v;
    });

    // A partir do mês seguinte à aposentadoria, a pessoa passa a sacar a renda
    // mensal desejada pra viver — sem isso a Linha 1 nunca entrava na fase de
    // consumo e só crescia pra sempre, mesmo sem nenhuma renda de trabalho
    // depois de parar (achado 22/07/2026, no teste ao vivo do gráfico: a curva
    // ia a R$60mi aos 98 anos sem nunca cair). Despesas que já continuam
    // vigentes em rendasDespesas (ex: aluguel) já são descontadas acima — aqui
    // só entra o valor NOVO que a pessoa passa a sacar pra viver.
    if (mes > mesAposentadoria) netMes -= rendaMensalDesejadaAposentadoria;

    patrimonio += netMes;

    saques.filter(s => s.mes === mes).forEach(s => { patrimonio -= s.valor; });

    patrimonio *= (1 + i);
    // Trava em zero — patrimônio negativo não faz sentido no gráfico (não
    // modelamos dívida); o ponto já fica claro no diagnóstico "Inadequado".
    if (patrimonio < 0) patrimonio = 0;
    serieAtual.push({ mes, patrimonio: Math.round(patrimonio) });
  }

  // Marcadores dos objetivos no gráfico (estilo XP: números indicando o
  // momento/idade em que cada objetivo é realizado/sacado do patrimônio).
  const marcadores = saques
    .filter(s => s.mes >= 0 && s.mes <= totalMeses)
    .map((s, idx) => ({
      numero: idx + 1,
      mes: s.mes,
      descricao: s.descricao,
      valor: Math.round(s.valor),
      patrimonio: serieAtual[s.mes]?.patrimonio ?? null,
    }));

  // Linhas de referência (mesma lógica das calculadoras simples — ver
  // MATERIAIS_JORNADA_SPEC.md seção 2, Encontro 5). A necessidade mensal soma a
  // renda desejada + despesas que continuam ativas na aposentadoria (decidido
  // em 22/07/2026, mesmo critério da XP — evita subestimar quanto é preciso ter).
  const despesaContinuaAposAposentadoria = _despesaMensalContinuaAposAposentadoria(rendasDespesas, hojeISO, mesAposentadoria);
  const necessidadeMensalAposentadoria = rendaMensalDesejadaAposentadoria + despesaContinuaAposAposentadoria;
  const mesesConsumo = Math.max(0, Math.round((pessoaRef.expectativaVida - pessoaRef.idadeAposentadoria) * 12));
  const patrimonioConsumo = _valorPresenteAnuidade(necessidadeMensalAposentadoria, mesesConsumo, i);
  const patrimonioPreservacao = i > 0 ? necessidadeMensalAposentadoria / i : Infinity;

  const patrimonioNaAposentadoria = serieAtual[Math.min(mesAposentadoria, serieAtual.length - 1)]?.patrimonio ?? patrimonio;

  let classificacao, diferenca;
  if (patrimonioNaAposentadoria < patrimonioConsumo) {
    classificacao = 'inadequado';
    diferenca = patrimonioConsumo - patrimonioNaAposentadoria;
  } else if (patrimonioNaAposentadoria < patrimonioPreservacao) {
    classificacao = 'adequado';
    diferenca = patrimonioPreservacao - patrimonioNaAposentadoria;
  } else {
    classificacao = 'confortavel';
    diferenca = patrimonioNaAposentadoria - patrimonioPreservacao;
  }

  // Aporte mensal adicional pra fechar a diferença até a aposentadoria, se inadequado.
  let aporteAdicionalSugerido = 0;
  if (classificacao === 'inadequado' && mesAposentadoria > 0) {
    const falta = patrimonioConsumo - patrimonioNaAposentadoria;
    aporteAdicionalSugerido = i === 0
      ? falta / mesAposentadoria
      : falta * i / (Math.pow(1 + i, mesAposentadoria) - 1);
  }

  return {
    serieAtual,
    marcadores,
    mesAposentadoria,
    necessidadeMensalAposentadoria: Math.round(necessidadeMensalAposentadoria),
    despesaContinuaAposAposentadoria: Math.round(despesaContinuaAposAposentadoria),
    patrimonioConsumo: Math.round(patrimonioConsumo),
    patrimonioPreservacao: isFinite(patrimonioPreservacao) ? Math.round(patrimonioPreservacao) : null,
    patrimonioNaAposentadoria,
    diagnostico: {
      classificacao,
      diferenca: Math.round(diferenca),
      aporteAdicionalSugerido: Math.round(aporteAdicionalSugerido),
    },
  };
}

exports.simularLiberdadeFinanceira = onCall(async (request) => {
  const auth = requireAuth(request);
  const uid  = request.data?.uid || auth.uid;
  requireSelfOrAdmin(request, uid);

  const { pessoas, patrimonioInicial, rendaMensalDesejadaAposentadoria, objetivosExtras, rendasDespesas, premissas } = request.data || {};

  if (!Array.isArray(pessoas) || pessoas.length === 0 || pessoas.length > 2) {
    throw new HttpsError('invalid-argument', 'pessoas deve ter 1 ou 2 itens.');
  }
  for (const p of pessoas) {
    if (!p.id || p.idadeAtual == null || p.idadeAposentadoria == null || p.expectativaVida == null) {
      throw new HttpsError('invalid-argument', 'Cada pessoa precisa de id, idadeAtual, idadeAposentadoria e expectativaVida.');
    }
    if (p.idadeAposentadoria <= p.idadeAtual || p.expectativaVida <= p.idadeAposentadoria) {
      throw new HttpsError('invalid-argument', 'As idades precisam seguir: atual < aposentadoria < expectativa de vida.');
    }
  }
  if (!rendaMensalDesejadaAposentadoria || rendaMensalDesejadaAposentadoria <= 0) {
    throw new HttpsError('invalid-argument', 'rendaMensalDesejadaAposentadoria é obrigatória e deve ser positiva.');
  }

  const resultado = _simularLiberdade({
    pessoas,
    patrimonioInicial: patrimonioInicial || 0,
    rendaMensalDesejadaAposentadoria,
    objetivosExtras: Array.isArray(objetivosExtras) ? objetivosExtras : [],
    rendasDespesas: Array.isArray(rendasDespesas) ? rendasDespesas : [],
    premissas: premissas || {},
  });

  // Salva os inputs (não o resultado — recalcula a cada abertura) no mesmo padrão
  // das outras ferramentas da Jornada.
  await db.collection('mentoradas').doc(uid).collection('materiaisJornada').doc('mapa-liberdade').set({
    ferramentaId: 'mapa-liberdade',
    respostas: { pessoas, patrimonioInicial, rendaMensalDesejadaAposentadoria, objetivosExtras, rendasDespesas, premissas },
    status: 'concluido',
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return resultado;
});

// ─── ORÇAMENTO (orcamento.html) ───────────────────────────────────────────────

const _CATEGORIAS_CODIGO = {
  1:'Aluguel', 2:'Financiamento Imóvel', 3:'IPTU', 4:'Condomínio', 5:'Manutenção',
  6:'Energia', 7:'Água', 8:'Gás', 9:'Suprimentos', 10:'Outros Moradia',
  11:'Supermercado', 12:'Restaurante', 13:'Café', 14:'Barzinho',
  15:'Celular', 16:'Internet', 17:'Streaming', 18:'Telefonia Fixa', 19:'TV a Cabo', 20:'Outros Comunicação',
  21:'Academia', 22:'Assistência Médica', 23:'Cabelo e Unha', 24:'Cosméticos',
  25:'Dentista', 26:'Exames médicos', 27:'Farmácia', 28:'Médicos particular',
  29:'Suplementos', 30:'Outros Saúde',
  31:'Roupas', 32:'Acessórios', 33:'Outros Vestuário',
  34:'Veterinário', 35:'Remédios', 36:'Alimentação', 37:'Outros Pet',
  40:'Aplicativos', 41:'Combustível', 42:'Estacionamento', 43:'Financiamento',
  44:'IPVA', 45:'Licenciamento', 46:'Manutenção', 47:'Passagens',
  48:'Seguro', 49:'Táxi', 50:'Transporte Público', 51:'Outros Transporte',
  52:'Mensalidades', 53:'Idiomas', 54:'Despesas Gerais', 55:'Cursos',
  56:'Livros e Revistas', 57:'FIES', 58:'Outros Educação',
  60:'Cinema', 61:'Esportes', 62:'Shows', 63:'Viagens', 64:'Outros Lazer',
  70:'Cama, Mesa e Banho', 71:'Consertos', 72:'Eletrodomésticos', 73:'Móveis',
  74:'TV, Som e Informática', 75:'Utensílios e decoração', 76:'Outros Artigos',
  80:'Presentes', 81:'Doações', 82:'Cigarro', 83:'Outros',
  90:'Juros Cartão de Crédito', 91:'Empréstimos', 92:'Outros Financeiro',
  93:'Reserva Financeira', 94:'Aposentadoria', 95:'Casa Própria', 96:'Outros Projetos',
};

function _resolverCategoria(cat) {
  if (!cat) return cat;
  const n = parseInt(cat, 10);
  return (!isNaN(n) && String(n) === String(cat).trim() && _CATEGORIAS_CODIGO[n])
    ? _CATEGORIAS_CODIGO[n]
    : cat;
}

// Chave normalizada de nome de estabelecimento — usada para lembrar a
// categoria que a usuária já confirmou para esse estabelecimento (aprendizado
// da importação por IA, ver categorizarExtratoIA/salvarCategoriaAprendida).
function _normalizarEstabelecimento(desc) {
  return String(desc || '').trim().toUpperCase().replace(/\s+/g, ' ').slice(0, 200);
}

// Chave normalizada de categoria (minúscula, sem acento, sem espaços nas
// pontas) — usada só pra COMPARAR/AGRUPAR categorias, nunca reescreve o
// texto salvo de um lançamento existente. Mesma lógica do cliente (orcamento.html).
function _normCat(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// Retorna o mês de pagamento de um item de fatura no formato YYYY-MM.
// Convenção: fatura = mês do débito na conta, então o mês de pagamento = a própria fatura.
function _mesPagamento(fatura) {
  if (!fatura) return null;
  const [fAno, fMes] = fatura.split('-').map(Number);
  if (isNaN(fAno) || isNaN(fMes)) return null;
  return fatura;
}

// Mesma lógica do sugerirFatura() do cliente (orcamento.html) — calcula a chave
// de fatura (mês de pagamento) que uma compra feita em dataCompra geraria, dado
// o dia de corte e de vencimento do cartão.
function _sugerirFatura(dataCompra, diaCorte, diaVencimento) {
  const dia = parseInt(dataCompra.split('-')[2], 10);
  const d   = new Date(dataCompra + 'T12:00:00');
  if (dia > diaCorte) d.setMonth(d.getMonth() + 1);
  if (!diaVencimento || diaVencimento <= diaCorte) d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

exports.getOrcamento = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  requireAuth(request);
  const { uid, mes, ano } = request.data;
  requireSelfOrAdmin(request, uid);

  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;

  // Mês anterior — fornece itens de fatura cujo vencimento cai neste mês
  const prevMes = mes === 1 ? 12 : mes - 1;
  const prevAno = mes === 1 ? ano - 1 : ano;
  const prevKey = `${prevAno}-${String(prevMes).padStart(2, '0')}`;

  const col = db.collection('mentoradas').doc(uid).collection('orcamento');
  const cartoesCol = db.collection('mentoradas').doc(uid).collection('cartoes');
  const [docSnap, prevSnap, cartoesSnap] = await Promise.all([
    col.doc(mesKey).get(), col.doc(prevKey).get(), cartoesCol.get(),
  ]);

  const cartaoMap = {};
  cartoesSnap.forEach(doc => { cartaoMap[doc.id] = doc.data(); });

  // Wrapper que usa dados do cartão para determinar o mês de pagamento correto
  const _mp = item => {
    const c = cartaoMap[item.cartaoId];
    return _mesPagamento(item.fatura);
  };

  // Fatura genuinamente "aberta" = o ciclo que uma compra feita HOJE geraria
  // pra aquele cartão — não apenas "mês de pagamento diferente do mês
  // visualizado". Esse critério antigo classificava como aberta qualquer coisa
  // com mês de pagamento diferente do mês em tela, mesmo quando o ciclo já
  // tinha fechado de verdade (ex: navegando pro mesmo mês do vencimento de uma
  // fatura ainda em curso, em cartão com dia de vencimento ≤ dia de corte).
  const hojeStr = hoje();
  const _abertaKeyPorCartao = {};
  const _ehCicloAberto = item => {
    if (!item.cartao || !item.fatura || !item.cartaoId) return false;
    const c = cartaoMap[item.cartaoId];
    if (!c?.diaCorte) return false;
    if (!(item.cartaoId in _abertaKeyPorCartao)) {
      _abertaKeyPorCartao[item.cartaoId] = _sugerirFatura(hojeStr, c.diaCorte, c.diaVencimento || 1);
    }
    return item.fatura === _abertaKeyPorCartao[item.cartaoId];
  };

  const normalizar = arr => (arr || []).filter(item => item != null).map(item =>
    item.categoria ? { ...item, categoria: _resolverCategoria(item.categoria) } : item
  );

  const todosItensMes = normalizar(docSnap.exists ? docSnap.data().itens : []);

  // Faturas abertas: só o que é de verdade o ciclo em curso hoje
  const itensFaturaAberta = todosItensMes
    .filter(item => _ehCicloAberto(item))
    .map(item => ({ ...item, _faturaAberta: true }));

  // Itens do mês atual: tudo que não é o ciclo em aberto de verdade
  const itensMes = todosItensMes
    .filter(item => !_ehCicloAberto(item));

  // Itens do mês anterior: só fatura com pagamento neste mês. Se a fatura
  // emprestada for a mesma que está aberta hoje pra aquele cartão, marca
  // _faturaAberta também — senão o item fica escondido da aba Detalhe quando
  // visto pelo mês nativo (fatura aberta não aparece lá, só na aba Faturas),
  // mas aparecia normalmente quando emprestado pro mês seguinte, dando a
  // impressão de duplicata (mesma fatura, uma "sumida" outra "visível") —
  // achado em 05/07/2026.
  const itensPrev = normalizar(prevSnap.exists ? prevSnap.data().itens : [])
    .filter(item => item.cartao && item.fatura && _mp(item) === mesKey)
    .map(item => ({
      ...item,
      _sourceMes: prevMes,
      _sourceAno: prevAno,
      ...(_ehCicloAberto(item) ? { _faturaAberta: true } : {}),
    }));

  return [...itensMes, ...itensPrev, ...itensFaturaAberta];
});

/**
 * Salva itens de orçamento importados do CSV do Raio-X.
 * Espera: { uid, mes, ano, itens: [{ categoria, tipo, valor }] }
 */
exports.saveOrcamento = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, mes, ano, itens, permitirReducao } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'saveOrcamento', 30, 60_000); // 30/min
  return _gravarOrcamento({ uid, mes, ano, itens, permitirReducao });
});

/**
 * Núcleo de gravação de orçamento, extraído de saveOrcamento em 10/07/2026 para
 * ser reaproveitado por categorizarExtratoRaioX (import via IA) sem duplicar a
 * lógica de validação/versionamento/merge de faturas. Comportamento idêntico ao
 * que já existia dentro do onCall — só mudou de onde os parâmetros vêm.
 */
async function _gravarOrcamento({ uid, mes, ano, itens, permitirReducao }) {
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
    // Traduz código numérico de categoria e sanitiza strings longas
    it.categoria = _resolverCategoria(it.categoria);
    if (it.categoria.length > 200) it.categoria = it.categoria.slice(0, 200);
    if (it.descricao && it.descricao.length > 500) it.descricao = it.descricao.slice(0, 500);
  }

  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const col    = db.collection('mentoradas').doc(uid).collection('orcamento');

  // Separa itens por mês de origem (_sourceMes/_sourceAno = campos opcionais vindos do
  // frontend) e remove campos ephemeral/computados pelo backend na leitura
  // (_sourceMes, _sourceAno, _faturaAberta) — nunca devem ser persistidos de volta,
  // senão "vazam" e o item passa a carregar um estado antigo/errado permanentemente
  // (achado em 04/07/2026, mesma causa raiz do incidente de duplicação).
  const itensPorOrigem = {}; // key → array de itens (sem os campos ephemeral)
  for (const it of itens) {
    const srcMes = it._sourceMes ?? mes;
    const srcAno = it._sourceAno ?? ano;
    const key    = `${srcAno}-${String(srcMes).padStart(2, '0')}`;
    const { _sourceMes, _sourceAno, _faturaAberta, ...clean } = it;
    if (!itensPorOrigem[key]) itensPorOrigem[key] = [];
    itensPorOrigem[key].push(clean);
  }

  // Para o mês atual: grava direto (substitui tudo — comportamento histórico)
  const itensMesAtual = itensPorOrigem[mesKey] || [];

  // ── Histórico de versões + trava de encolhimento suspeito (04/07/2026) ──
  // saveOrcamento sempre substitui a lista inteira do mês. Se algum fluxo do
  // frontend rodar com um estado em memória desatualizado (ex: aba antiga,
  // corrida entre sessões), ele apaga silenciosamente o que não está na lista
  // enviada — foi exatamente assim que receitas e saldo em conta sumiram em
  // 03/07/2026. Toda escrita agora guarda a versão anterior (recuperável) e
  // bloqueia sobrescritas que fariam sumir um tipo inteiro de lançamento ou
  // encolheriam a lista pela metade, a menos que o chamador confirme de
  // propósito com permitirReducao=true (usado só por import de CSV e pela
  // ferramenta de dedup, que são substituições intencionais).
  const docRef    = col.doc(mesKey);
  const antesSnap = await docRef.get();
  const itensAntes = antesSnap.exists ? (antesSnap.data().itens || []) : [];

  if (itensAntes.length > 0) {
    await docRef.collection('versoes').add({
      itens: itensAntes,
      salvoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Mantém só as últimas ~30 versões por mês (poda progressiva, evita
    // crescimento sem limite já que salvarEAtualizar roda a cada ação).
    const antigasSnap = await docRef.collection('versoes').orderBy('salvoEm', 'desc').offset(30).limit(20).get();
    antigasSnap.forEach(d => d.ref.delete().catch(() => {}));

    if (!permitirReducao) {
      const tiposPerdidos = ['receita', 'despesa', 'aporte'].filter(tipo =>
        itensAntes.some(i => i.tipo === tipo) && !itensMesAtual.some(i => i.tipo === tipo)
      );
      const encolheuMuito = itensMesAtual.length < itensAntes.length * 0.5;
      if (tiposPerdidos.length > 0 || encolheuMuito) {
        throw new HttpsError('failed-precondition',
          `Salvamento bloqueado por segurança: iria de ${itensAntes.length} para ${itensMesAtual.length} itens` +
          (tiposPerdidos.length ? ` e apagaria todos os lançamentos de ${tiposPerdidos.join(', ')}` : '') +
          '. Recarregue a página e tente de novo — se o problema persistir, isso pode indicar dados desatualizados na tela.');
      }
    }
  }

  await docRef.set({
    uid, mes, ano, itens: itensMesAtual,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Para meses de origem diferentes: faz merge (substitui só as faturas com pagamento = mesKey)
  const outrosMeses = Object.entries(itensPorOrigem).filter(([k]) => k !== mesKey);
  if (outrosMeses.length) {
    const cartoesSnap = await db.collection('mentoradas').doc(uid).collection('cartoes').get();
    const cartaoMap = {};
    cartoesSnap.forEach(doc => { cartaoMap[doc.id] = doc.data(); });
    const _mp = item => {
      const c = cartaoMap[item.cartaoId];
      return _mesPagamento(item.fatura);
    };
    for (const [srcKey, srcItens] of outrosMeses) {
      const snap = await col.doc(srcKey).get();
      const existentes = snap.exists ? (snap.data().itens || []) : [];
      const restantes  = existentes.filter(i => !(i.cartao && i.fatura && _mp(i) === mesKey));
      const merged     = [...restantes, ...srcItens];
      const [srcAno, srcMesStr] = srcKey.split('-');
      await col.doc(srcKey).set({
        uid,
        mes: parseInt(srcMesStr, 10),
        ano: parseInt(srcAno, 10),
        itens: merged,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  // ── Cache de sobra (usa só os itens do mês atual) ──────────────────────
  const receita = itensMesAtual.filter(i => i.tipo === 'receita').reduce((s, i) => s + i.valor, 0);
  const despesa = itensMesAtual.filter(i => i.tipo === 'despesa' && !(i.cartao && i.fatura)).reduce((s, i) => s + i.valor, 0);
  db.collection('mentoradas').doc(uid).update({
    sobra: receita - despesa,
    dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.warn('[saveOrcamento] Falha ao atualizar cache:', e.message));

  return { ok: true };
}

/**
 * categorizarExtratoIA — substitui o Agente Raio-X (Custom GPT no ChatGPT) por
 * categorização via API da Anthropic, direto no backend. Recebe o extrato/fatura
 * (texto colado, ou PDF/imagem em base64) e devolve os lançamentos já extraídos
 * e categorizados, no MESMO formato que parsearCsvRaioX() já produz no frontend
 * (categoria, tipo, valor, data, descricao, fixa) — de propósito, para que
 * orcamento.html trate o resultado exatamente como já trata o CSV do Custom GPT
 * hoje (normaliza categoria contra as já existentes no mês, preserva lançamentos
 * manuais/recorrentes/parcelamentos, detecta fixas para o modal de confirmação,
 * chama saveOrcamento com permitirReducao=true). Esta função NÃO grava no
 * Firestore — só extrai e categoriza. Ver dashboard/raio-x-no-dashboard/BLUEPRINT.md.
 */
exports.categorizarExtratoIA = onCall(
  { secrets: [sAnthropic], timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    const auth = requireAuth(request);
    const { uid, conteudo, tipoConteudo, nomesCartoes } = request.data;
    requireSelfOrAdmin(request, uid);
    // 10 a cada 10min — uso típico é 1-2 importações por mês; generoso o bastante
    // contra abuso sem incomodar uso legítimo (várias contas/cartões no mesmo dia).
    await checkRateLimit(uid, 'categorizarExtratoIA', 10, 600_000);

    if (!conteudo || typeof conteudo !== 'string') {
      throw new HttpsError('invalid-argument', 'conteudo é obrigatório (texto colado ou base64 do arquivo).');
    }
    const TIPOS_CONTEUDO = new Set(['texto', 'pdf', 'imagem']);
    if (!TIPOS_CONTEUDO.has(tipoConteudo)) {
      throw new HttpsError('invalid-argument', 'tipoConteudo deve ser "texto", "pdf" ou "imagem".');
    }
    // Limites de tamanho — protege custo de API e timeout da function.
    if (tipoConteudo === 'texto' && conteudo.length > 60_000) {
      throw new HttpsError('invalid-argument', 'Texto muito longo (máximo ~60.000 caracteres). Envie em partes menores.');
    }
    if (tipoConteudo !== 'texto' && conteudo.length > 15_000_000) { // ~10MB decodificado de base64
      throw new HttpsError('invalid-argument', 'Arquivo muito grande (máximo ~10MB).');
    }

    const listaCategorias = Object.entries(_CATEGORIAS_CODIGO)
      .map(([cod, nome]) => `${cod}=${nome}`).join(', ');

    // Aprendizado por estabelecimento: categorias que a própria usuária já
    // confirmou manualmente em importações anteriores (ver salvarCategoriaAprendida).
    const aprendidasSnap = await db.collection('mentoradas').doc(uid).collection('categoriasAprendidas').get();
    const aprendidasMap = {};
    aprendidasSnap.docs.forEach(d => { aprendidasMap[d.id] = d.data().categoria; });
    const listaAprendidas = aprendidasSnap.docs.map(d => `${d.data().descricaoOriginal} → ${d.data().categoria}`);

    const CATEGORIAS_RECEITA = ['Salário', 'Freelance / Prestação de Serviço', 'Transferência Recebida', 'Reembolso', 'Rendimento de Investimento', 'Restituição / Estorno', 'Outros'];

    const listaCartoesConhecidos = Array.isArray(nomesCartoes)
      ? nomesCartoes.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim().slice(0, 60)).slice(0, 20)
      : [];

    const systemPrompt = `Você extrai e categoriza transações de extratos bancários e faturas de cartão de crédito brasileiros.

Categorias válidas para DESPESA (código=nome) — use SEMPRE o código numérico para despesas, nunca invente categoria fora desta lista:
${listaCategorias}

Categorias válidas para RECEITA — são uma lista SEPARADA, NUNCA use um código de despesa (a lista acima) para uma receita, mesmo que pareça genérico (ex: "Despesas Gerais" nunca é categoria de receita). Escolha uma destas, como texto (não código): ${CATEGORIAS_RECEITA.join(', ')}.
${listaAprendidas.length ? `
Mapeamento de estabelecimentos já confirmado pela própria usuária em importações anteriores — sempre que um desses aparecer (mesmo com pequenas variações de grafia, sufixo ou pontuação), use exatamente o código/categoria correspondente na lista acima, e marque "categoriaIncerta": false:
${listaAprendidas.join('\n')}
` : ''}
Regras obrigatórias:
- Formato do documento: extratos e faturas brasileiros variam muito entre bancos/cartões — PDF, foto, ou texto/CSV com qualquer delimitador (vírgula, ponto e vírgula, tab), qualquer ordem de colunas, cabeçalhos em português variando de nome (Histórico/Descrição/Estabelecimento/Lançamento), datas em DD/MM/AAAA ou AAAA-MM-DD, valores como "1.234,56" ou "1234.56". Nunca assuma um layout fixo — leia os cabeçalhos/estrutura reais de CADA documento e adapte. As regras abaixo descrevem princípios (o que é despesa/receita/pagamento/parcela), não um formato específico.
- Ignore saldos e linhas de resumo/cabeçalho. "Duplicidade" real é a MESMA transação (mesma data E mesmo valor E mesma descrição) aparecendo duas vezes no documento — comum quando duas páginas/períodos se sobrepõem. NUNCA trate como duplicata duas linhas só porque têm a mesma descrição/mesmo estabelecimento — isso é normal (ex: duas transferências pro mesmo destinatário em dias diferentes, duas compras no mesmo mercado) e as DUAS são transações reais e distintas que devem entrar em "itens". Na dúvida entre "é duplicata" e "são duas transações reais", inclua as duas — errar incluindo uma repetida é menos grave que errar apagando uma transação real (achado 14/07/2026: duas linhas "TRANSF CC PARA CC BIG AGENTES..." com datas e valores diferentes, R$1.800 e R$20.000, e uma delas foi descartada por engano como se fosse duplicata).
- "tipo" (despesa/receita) é determinado SOMENTE pela natureza da operação — a coluna Crédito/Débito, o sinal (+/-) ou marcador "C"/"D" impresso no documento. O histórico/descrição da linha NUNCA é usado para decidir "tipo" — ele só serve de base para escolher a "categoria". Isso vale MESMO quando o texto parece sugerir o contrário — duas armadilhas reais já confirmadas (extrato Bradesco):
  (a) achado 13/07/2026: "PAGTO ELETRON COBRANCA BANCO INTER - DEPOSITO POR BOLETO" com valor na coluna Débito é DESPESA — a palavra "depósito" descreve o MÉTODO do pagamento, não dinheiro entrando;
  (b) achado 14/07/2026: "TRANSF CC PARA CC BIG AGENTES AUTONOMOS DE INVESTI" com valor na coluna CRÉDITO é RECEITA (dinheiro entrando na conta) — mesmo a palavra "PARA" no texto parecendo indicar saída de dinheiro (como se fosse uma transferência enviada), a coluna diz o contrário e ela é quem manda. Regra geral: SEMPRE que o texto e a coluna parecerem apontar em direções diferentes, a coluna vence — nunca deixe a leitura do texto sobrepor o indicador estrutural, em nenhum sentido (nem "parece despesa" nem "parece receita").
  Se a linha genuinamente não tiver nenhum indicador estrutural de crédito/débito (documento sem essa distinção visível, ex. texto colado sem coluna nem sinal), marque "tipoIncerto": true e ainda assim preencha "tipo" com seu melhor palpite — nunca decida com confiança só pelo texto quando não há indicador.
- Pagamento de fatura de cartão de crédito debitado na conta corrente NÃO é uma despesa própria — NÃO inclua essa linha em "itens" (o gasto real já está nos itens individuais da fatura, se ela também foi enviada; incluir aqui TAMBÉM duplicaria o gasto). Em vez disso, inclua essa linha em "pagamentosFatura" (ver formato abaixo), com a descrição completa da linha (para identificar qual cartão/bandeira foi pago), o valor e a data. Nem sempre a linha diz "cartão"/"fatura" explicitamente — bancos frequentemente descrevem isso como um pagamento genérico ("PAGTO ELETRON COBRANCA [NOME]", "PGTO TITULO", "DEB AUT FATURA") para uma instituição financeira. Dois sinais fortes de que é pagamento de fatura, mesmo sem a palavra "cartão": (1) o nome no destinatário bate com um dos cartões conhecidos da usuária${listaCartoesConhecidos.length ? ` — cartões ativos dela: ${listaCartoesConhecidos.join(', ')}` : ' (nenhum cartão cadastrado informado — use só o sinal 2 abaixo)'}; (2) o valor da linha bate com o total de uma fatura que também está sendo analisada nesta mesma importação. Na dúvida entre "é despesa normal" e "é pagamento de fatura", prefira "pagamentosFatura" quando houver QUALQUER um desses dois sinais — a usuária confirma manualmente antes de salvar, então um falso positivo aqui é barato de corrigir; deixar como despesa comum quando na verdade é fatura duplica o gasto sem que ela perceba (achado 14/07/2026, extrato Bradesco real: "PAGTO ELETRON COBRANCA BANCO XP S.A" R$9.457,14 era pagamento da fatura do cartão XP e ficou classificado como despesa comum, duplicando com os itens da fatura).
- Dentro de uma FATURA (o documento é a própria fatura, não um extrato de conta corrente), uma linha de valor negativo ou marcado como crédito representando o pagamento da fatura anterior sendo aplicado (ex: "Pagamentos Válidos", "Pagamento Recebido", "Crédito", "Estorno de pagamento") NÃO é receita nem despesa — é só informativo (mostra o saldo anterior sendo quitado). Não inclua em "itens" nem em "pagamentosFatura" (essa regra é só para extrato de conta corrente); ignore a linha, igual a um saldo/resumo. Diferente é um estorno de UMA COMPRA específica (ex: "Estorno Amazon") — esse sim é receita normal, categoria "Restituição / Estorno". Faturas Bradesco reais marcam esse estorno SEM a palavra "Estorno": a linha repete o mesmo estabelecimento e valor de uma compra já listada mais acima, com um "-" solto no final do valor (ex: compra "30/05 MERCADOLIVRE*MERCADOLIVRE OSASCO 83,16" seguida depois por "15/06 MERCADOLIVRE*MERCADOLIVRE OSASCO 83,16 -") — esse "-" É o indicador estrutural de crédito (mesma lógica da regra de "tipo" acima), então essa segunda linha entra em "itens" como receita, categoria "Restituição / Estorno", mesmo sem nenhuma palavra escrita indicando estorno (achado 15/07/2026: ler as duas como despesa dobrou o valor da fatura no total, porque o crédito não estava cancelando a compra original).
  Cuidado pra não confundir com uma TARIFA/ENCARGO real que aparece na mesma área do topo da fatura, perto do "Pagamentos Válidos"/saldo anterior, ANTES da lista de compras por portador começar — isso é uma despesa de verdade (ex: "CUSTO TRANS. EXTERIOR-IOF", "Tarifa de emissão", "Anuidade", "Juros de mora") e TEM que entrar em "itens" como despesa, categoria conforme o que for (IOF/tarifa bancária → categoria mais próxima disponível). A regra de "ignore linha informativa de saldo" vale só pra a linha do PAGAMENTO/crédito em si, nunca pra uma cobrança real só porque está posicionada perto dela (achado 15/07/2026: uma linha "CUSTO TRANS. EXTERIOR-IOF 3,79" ficou de fora da fatura, deixando o total R$3,79 abaixo do valor real impresso — pequeno, mas o suficiente pra não bater com o pagamento registrado no extrato bancário).
- Identifique o estabelecimento pelo nome mesmo com abreviações/sufixos de operadora (ex: "ANTHROPIC* CLAUDE SUB", "NETFLIX.COM", "UBER *TRIP") e categorize pelo que o estabelecimento realmente vende, não pela primeira palavra parecida. Assinatura de software/IA (ChatGPT, Claude, Notion, Adobe, Spotify, etc.) → categoria 17 (Streaming), nunca Cosméticos ou outra categoria não relacionada. Na dúvida entre duas categorias, prefira a mais genérica da mesma área (ex: "Outros Saúde") a uma categoria de área errada.
- "fixa": true para despesas que claramente se repetem todo mês com valor igual ou parecido — aluguel, mensalidade, assinatura de streaming, academia, tratamento recorrente — MESMO quando pagas em parcelas (ex: "Academia Parcela 2/12" é fixa: true, porque é uma mensalidade parcelada). Compras avulsas de cartão parceladas que não se repetem depois de quitadas (eletrônico, móvel, roupa, viagem) NUNCA são fixa: true.
- "parcelaAtual" e "parcelasTotal": a informação de parcela pode vir de duas formas — embutida na descrição (ex: "Parcela 2/12", "Parc 02/12", "2/12" no fim do texto) OU numa coluna própria do documento (ex: coluna "Parcela" com valor "1 de 4", "02/12"). Preencha os dois números onde quer que essa informação apareça; senão, null nos dois. Preencha isso independente do valor de "fixa".
- "categoriaIncerta": marque true quando você genuinamente não tiver confiança na categoria escolhida (estabelecimento desconhecido ou ambíguo, e que não está no mapeamento já confirmado acima) — mesmo assim preencha "categoria" com seu melhor palpite. Marque false quando tiver certeza, ou quando o estabelecimento estava no mapeamento já confirmado.
- "tipoIncerto": marque true só no caso descrito acima (linha sem nenhum indicador estrutural de crédito/débito) — na imensa maioria das vezes, com extrato/fatura normal, isso é false porque o indicador existe e é claro.
- "valor" sempre positivo, tipo número (não string), com ponto decimal.
- "data" no formato AAAA-MM-DD. Se o ano não estiver explícito, use o ano corrente (${new Date().getFullYear()}).
- "vencimentoFatura": SE o documento for uma fatura de cartão de crédito (não extrato de conta corrente) E tiver uma data de vencimento impressa (ex: "Vencimento: 20/07/2026", "Data de vencimento", "Pagamento até"), preencha no formato AAAA-MM-DD. Isso é o vencimento IMPRESSO no documento, não uma data que você calcula — se não encontrar essa informação impressa, ou se for extrato de conta corrente, use null.
- "pagamentosFatura": array com as linhas de pagamento de fatura de cartão identificadas (ver regra acima) — [] se não houver nenhuma ou se o documento for a própria fatura (não faz sentido dentro de uma fatura).
- Responda APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, COMPACTO (uma linha só, sem indentação nem quebras de linha). Formato:
  {"vencimentoFatura": "AAAA-MM-DD"|null, "pagamentosFatura": [{"descricao": "<texto completo da linha>", "valor": <número>, "data": "AAAA-MM-DD"}], "itens": [{"categoria": "<código numérico como string, se despesa — ou texto da lista de receita, se receita>", "tipo": "despesa"|"receita", "valor": <número>, "data": "AAAA-MM-DD", "descricao": "<nome do estabelecimento ou lançamento>", "fixa": true|false, "parcelaAtual": <número ou null>, "parcelasTotal": <número ou null>, "categoriaIncerta": true|false, "tipoIncerto": true|false}, ...]}`;

    const contentBlock = tipoConteudo === 'texto'
      ? { type: 'text', text: conteudo }
      : tipoConteudo === 'pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: conteudo } }
        : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: conteudo } };

    let respostaIA;
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': sAnthropic.value(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16000,
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: [contentBlock, { type: 'text', text: 'Extraia e categorize todas as transações deste extrato/fatura.' }],
          }],
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error(`[categorizarExtratoIA] Erro API Anthropic (${resp.status}) uid=${uid}: ${errText.slice(0, 500)}`);
        if (/password protected/i.test(errText)) {
          throw new HttpsError('invalid-argument', 'Este PDF está protegido por senha. Remova a senha do arquivo (geralmente há uma opção "salvar sem senha" no app do banco/cartão) e envie de novo — ou cole o texto do extrato diretamente.');
        }
        throw new HttpsError('internal', 'Erro ao processar o extrato. Tente novamente em instantes.');
      }
      respostaIA = await resp.json();
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      console.error(`[categorizarExtratoIA] Falha na chamada à API (uid=${uid}):`, err.message);
      throw new HttpsError('internal', 'Erro ao processar o extrato. Tente novamente em instantes.');
    }

    const textoResposta = respostaIA?.content?.[0]?.text || '';
    let itensBrutos;
    let vencimentoFatura = null;
    let pagamentosFaturaBrutos = [];
    try {
      // Remove eventuais cercas de markdown (```json ... ```) que o modelo às vezes inclui.
      const limpo = textoResposta.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const respostaParsed = JSON.parse(limpo);
      if (!respostaParsed || !Array.isArray(respostaParsed.itens)) throw new Error('resposta não tem "itens" como array');
      itensBrutos = respostaParsed.itens;
      if (typeof respostaParsed.vencimentoFatura === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(respostaParsed.vencimentoFatura)) {
        vencimentoFatura = respostaParsed.vencimentoFatura;
      }
      if (Array.isArray(respostaParsed.pagamentosFatura)) {
        pagamentosFaturaBrutos = respostaParsed.pagamentosFatura;
      }
    } catch (err) {
      console.error(`[categorizarExtratoIA] Resposta da IA não é JSON válido (uid=${uid}):`, textoResposta.slice(0, 500));
      throw new HttpsError('internal', 'Não consegui interpretar esse arquivo. Tente novamente ou envie um extrato mais claro.');
    }

    if (itensBrutos.length === 0) {
      throw new HttpsError('invalid-argument', 'Nenhuma transação foi identificada neste arquivo.');
    }
    if (itensBrutos.length > 500) {
      throw new HttpsError('invalid-argument', 'Muitas transações identificadas (limite de 500). Envie um período menor.');
    }

    const TIPOS_ITEM = new Set(['receita', 'despesa']);
    const itens = itensBrutos.map((it, i) => {
      if (!TIPOS_ITEM.has(it.tipo)) throw new HttpsError('internal', `Item ${i + 1}: tipo inválido retornado pela IA.`);
      const valor = Number(it.valor);
      if (!Number.isFinite(valor) || valor < 0) throw new HttpsError('internal', `Item ${i + 1}: valor inválido retornado pela IA.`);
      const descricao = typeof it.descricao === 'string' ? it.descricao.slice(0, 200) : '';
      // Se já existe categoria aprendida pra esse estabelecimento, ela sempre
      // vence — mesmo que a IA não tenha aplicado corretamente o mapeamento
      // do prompt (garante consistência sem depender só do modelo obedecer).
      const categoriaAprendida = aprendidasMap[_normalizarEstabelecimento(descricao)];
      return {
        categoria:  categoriaAprendida || _resolverCategoria(String(it.categoria ?? '')) || 'Outros',
        tipo:       it.tipo,
        valor,
        data:       typeof it.data === 'string' ? it.data : '',
        descricao,
        ...(it.fixa === true ? { fixa: true } : {}),
        ...(Number.isInteger(it.parcelaAtual) && Number.isInteger(it.parcelasTotal) && it.parcelasTotal > 0
          ? { parcelaAtual: it.parcelaAtual, parcelasTotal: it.parcelasTotal }
          : {}),
        ...(!categoriaAprendida && it.categoriaIncerta === true ? { categoriaIncerta: true } : {}),
        ...(it.tipoIncerto === true ? { tipoIncerto: true } : {}),
      };
    });

    const pagamentosFatura = pagamentosFaturaBrutos
      .filter(p => p && typeof p.descricao === 'string' && Number.isFinite(Number(p.valor)) && typeof p.data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.data))
      .map(p => ({ descricao: p.descricao.slice(0, 200), valor: Number(p.valor), data: p.data }))
      .slice(0, 20);

    console.log(`[categorizarExtratoIA] uid=${uid} — ${itens.length} lançamentos extraídos via IA (tipoConteudo=${tipoConteudo}, vencimentoFatura=${vencimentoFatura || 'não encontrado'}, pagamentosFatura=${pagamentosFatura.length})`);
    return { itens, vencimentoFatura, pagamentosFatura };
  },
);

/**
 * categorizarPatrimonioIA — extrai e classifica ativos ou dívidas a partir de
 * declaração de IR, posição de corretora, ou lista de dívidas (texto colado,
 * PDF ou foto), via Claude API direto. Substitui o Agente de Patrimônio e o
 * Agente de Investimentos do ChatGPT (ver dashboard/ajuda.html).
 *
 * modo 'ativos'  → retorna { itens: [{classe, valor}] }, MESMO formato que
 *                  parsearCsvPatrimonio() já produz no frontend — serve tanto
 *                  para declaração de IR quanto para posição de corretora
 *                  (patrimonio.html chama savePatrimonio(itens, tipo) igual
 *                  para os dois, tipo só diferencia a origem).
 * modo 'dividas' → retorna { itens: [{nome, tipo, saldo, parcela, termino}] },
 *                  MESMO formato que parsearCsvDividas() produz (sem "id" —
 *                  o frontend gera o id antes de chamar saveDivida, igual já
 *                  faz hoje com o resultado do CSV).
 * Esta função NÃO grava no Firestore — só extrai e categoriza.
 */
exports.categorizarPatrimonioIA = onCall(
  { secrets: [sAnthropic], timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    const auth = requireAuth(request);
    const { uid, conteudo, tipoConteudo, modo, origem } = request.data;
    requireSelfOrAdmin(request, uid);
    // Liberado geral em 20/07/2026 (achado: era exatamente esse gate esquecido
    // que já tinha causado bug 3x no categorizarExtratoIA e no webhook da
    // Kiwify — removido por completo, não só desativado).
    await checkRateLimit(uid, 'categorizarPatrimonioIA', 10, 600_000);

    if (!conteudo || typeof conteudo !== 'string') {
      throw new HttpsError('invalid-argument', 'conteudo é obrigatório (texto colado ou base64 do arquivo).');
    }
    const TIPOS_CONTEUDO = new Set(['texto', 'pdf', 'imagem']);
    if (!TIPOS_CONTEUDO.has(tipoConteudo)) {
      throw new HttpsError('invalid-argument', 'tipoConteudo deve ser "texto", "pdf" ou "imagem".');
    }
    if (!['ativos', 'dividas'].includes(modo)) {
      throw new HttpsError('invalid-argument', 'modo deve ser "ativos" ou "dividas".');
    }
    if (modo === 'ativos' && !['ir', 'corretora'].includes(origem)) {
      throw new HttpsError('invalid-argument', 'origem deve ser "ir" ou "corretora" quando modo é "ativos".');
    }
    if (tipoConteudo === 'texto' && conteudo.length > 60_000) {
      throw new HttpsError('invalid-argument', 'Texto muito longo (máximo ~60.000 caracteres). Envie em partes menores.');
    }
    if (tipoConteudo !== 'texto' && conteudo.length > 15_000_000) {
      throw new HttpsError('invalid-argument', 'Arquivo muito grande (máximo ~10MB).');
    }

    // Importante: declaração de IR e posição de corretora usam prompts DIFERENTES,
    // de propósito. A declaração de IR só entra 1x/ano — se ela também importasse
    // aplicações financeiras, esses valores ficariam desatualizados o ano inteiro,
    // competindo com a posição da corretora (atualizada mensalmente). Por isso o
    // cartão "Importar declaração IR" só traz bens NÃO financeiros (imóveis, bens
    // móveis); tudo que é investimento entra exclusivamente pela corretora.
    const systemPrompt = modo === 'ativos'
      ? (origem === 'ir'
        ? `Você extrai bens patrimoniais NÃO FINANCEIROS a partir de declarações de Imposto de Renda (bens e direitos) de usuárias brasileiras.

IMPORTANTE — regra de escopo: extraia SOMENTE bens não financeiros. NÃO inclua aplicações financeiras, ações, fundos, ETFs, FIIs, previdência (PGBL/VGBL), contas bancárias/poupança/conta investimento, criptomoedas, ou qualquer outro investimento — mesmo que apareçam na mesma declaração. Esses itens são atualizados separadamente, todo mês, pela importação da posição da corretora; incluí-los aqui os deixaria desatualizados (só seriam revistos 1x por ano). Se uma linha da declaração for claramente um investimento financeiro, IGNORE-A por completo — não a inclua no resultado.

Classifique cada bem NÃO FINANCEIRO em UMA destas classes (use exatamente estes nomes em português):
- "Imóveis" — casas, apartamentos, terrenos, salas comerciais, imóvel rural
- "Automóveis" — carros, motos, caminhões, ônibus, embarcações, aeronaves
- "Bens Móveis" — joias, obras de arte, antiguidades, colecionáveis, consórcio não contemplado, outros bens e direitos não financeiros
Se um item genuinamente não couber em nenhuma classe acima (e não for financeiro), use um nome curto e descritivo em português.

Regra importante: NUNCA use "Alternativos" para bem físico — essa classe é reservada exclusivamente a ativos financeiros (criptomoedas, ouro, COE, private equity), que não entram por este documento.

Regras obrigatórias:
- Leia a estrutura real do documento (colunas "Discriminação"/"Situação em 31/12" ou similares) sem assumir um layout fixo.
- Use o valor mais recente/atual disponível (ex: "Situação em 31/12/2025"). Ignore colunas de valor do ano anterior se houver as duas.
- Ignore linhas de total/subtotal/resumo.
- Some itens da MESMA classe entre si (ex: dois imóveis → uma linha "Imóveis" com a soma), a menos que o documento já venha agregado.
- "valor" sempre positivo, tipo número (não string), com ponto decimal.
- Responda APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, COMPACTO (uma linha só). Formato:
  {"itens": [{"classe": "<nome da classe>", "valor": <número>}, ...]}`
        : `Você extrai e classifica ativos FINANCEIROS a partir de posições consolidadas de corretora de usuárias brasileiras.

Classifique cada ativo em UMA destas classes — use EXATAMENTE esta grafia
(mesmo texto usado em todo o resto do sistema; qualquer variação, mesmo
gramatical, faz o item não ser reconhecido e sumir de comparativos em
outras telas — achado 20/07/2026):
- "RF Pós (liquidez diária)" — Tesouro Selic, CDB pós, LCI/LCA, conta corrente, conta investimento, caixa/disponibilidades
- "RF Pré-fixado" — Tesouro Prefixado, LTN, NTN-F, CDB pré
- "RF Inflação" — Tesouro IPCA+, NTN-B, CDB IPCA, debêntures, CRI, CRA
- "Multimercado" — fundos multimercado de verdade (macro, long & short, estratégias mistas), previdência privada (PGBL/VGBL), fundo de pensão
- "Renda Variável" — ações, FIIs, ETFs, participações societárias, cotas de LTDA
- "Internacional" — ativos no exterior, BDRs, moeda estrangeira, dólar, euro
- "Alternativos" — criptomoedas, ouro (ativo financeiro), COE, FIPs, commodities
Se um item genuinamente não couber em nenhuma classe acima, use um nome curto e descritivo em português (o sistema aceita qualquer nome de classe, mas não vai agrupar automaticamente com as classes padrão). Não classifique nada como "Imóveis", "Automóveis", "Bens Móveis" ou qualquer bem físico — este documento é só de ativos financeiros.

IMPORTANTE — classifique pela estratégia REAL do fundo, não só pelo rótulo legal/regulatório impresso no documento. No Brasil, a sigla no nome ("FIM", "FIC FIM", "Fundo Multimercado") é o TIPO REGULATÓRIO (CVM/ANBIMA), que existe por motivos de estrutura/flexibilidade e frequentemente NÃO reflete a exposição real — é comum um fundo rotulado "Multimercado" ser, na prática, majoritariamente ações (ex: fundos de gestoras conhecidas por posições concentradas em renda variável, mesmo usando wrapper FIM). Quando você reconhecer o nome do fundo ou da gestora com confiança razoável (conhecimento geral sobre gestoras brasileiras conhecidas), classifique pela estratégia real, não pelo rótulo do documento. Quando NÃO reconhecer o fundo/gestora com confiança, ou não tiver certeza da estratégia real, marque "confianca": "baixa" e classifique pelo rótulo regulatório do documento como melhor palpite — a usuária vai revisar e confirmar os itens de baixa confiança antes de salvar, então não é grave errar aqui, só não minta confiança que você não tem.

Regras obrigatórias:
- Leia a estrutura real do documento (colunas "Ativo"/"Saldo bruto"/"Instituição" ou similares) sem assumir um layout fixo.
- Use o saldo bruto/atual disponível, não valores históricos.
- Ignore linhas de total/subtotal/resumo.
- NÃO agregue itens de nomes diferentes numa linha só, mesmo que a classe pareça igual — cada ativo/fundo do documento vira um item individual próprio (com seu nome), mesmo que dois acabem na mesma classe. A soma final por classe é feita depois, fora deste passo.
- Se algum ativo estiver em dólar, euro ou outra moeda estrangeira, converta para reais usando a cotação aproximada do dia de hoje (${new Date().toISOString().slice(0, 10)}) antes de somar — nunca deixe valores em moeda estrangeira misturados com reais no mesmo total.
- "valor" sempre positivo, tipo número (não string), com ponto decimal, já em reais.
- "nome": nome do ativo/fundo como aparece no documento (curto, até 80 caracteres).
- "confianca": "alta" quando você tem certeza razoável da classe real (inclusive por reconhecer o fundo/gestora), "baixa" quando está no melhor palpite (documento ambíguo, fundo desconhecido, ou rótulo regulatório pode não bater com a estratégia real).
- Responda APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, COMPACTO (uma linha só). Formato:
  {"itens": [{"nome": "<nome do ativo/fundo>", "classe": "<nome da classe>", "valor": <número>, "confianca": "alta"|"baixa"}, ...]}`)
      : `Você extrai dívidas e financiamentos a partir de documentos ou texto descrevendo passivos de usuárias brasileiras (financiamentos, empréstimos, faturas de cartão em aberto).

Para cada dívida, identifique:
- "nome": descrição curta (ex: "Financiamento apartamento", "Empréstimo consignado Banco X")
- "tipo": exatamente um destes códigos — "financiamento" (imóvel), "carro" (veículo), "emprestimo" (empréstimo pessoal/consignado), "cartao" (fatura de cartão), "outro"
- "saldo": saldo devedor atual (número positivo)
- "parcela": valor da parcela/prestação mensal, se informado (número, ou 0 se não informado)
- "termino": data ou período previsto de término, se informado, como texto livre (ex: "12/2028"), ou string vazia "" se não informado

Regras obrigatórias:
- Ignore linhas de total/resumo.
- "saldo" e "parcela" sempre números (não string), com ponto decimal, nunca negativos.
- Responda APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, COMPACTO (uma linha só). Formato:
  {"itens": [{"nome": "<texto>", "tipo": "financiamento"|"carro"|"emprestimo"|"cartao"|"outro", "saldo": <número>, "parcela": <número>, "termino": "<texto>"}, ...]}`;

    const contentBlock = tipoConteudo === 'texto'
      ? { type: 'text', text: conteudo }
      : tipoConteudo === 'pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: conteudo } }
        : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: conteudo } };

    let respostaIA;
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': sAnthropic.value(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8000,
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: [contentBlock, {
              type: 'text',
              text: modo === 'ativos'
                ? 'Extraia e classifique todos os ativos deste documento.'
                : 'Extraia todas as dívidas/financiamentos deste documento.',
            }],
          }],
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error(`[categorizarPatrimonioIA] Erro API Anthropic (${resp.status}) uid=${uid} modo=${modo}: ${errText.slice(0, 500)}`);
        if (/password protected/i.test(errText)) {
          throw new HttpsError('invalid-argument', 'Este PDF está protegido por senha. Remova a senha do arquivo e envie de novo — ou cole o texto diretamente.');
        }
        throw new HttpsError('internal', 'Erro ao processar o documento. Tente novamente em instantes.');
      }
      respostaIA = await resp.json();
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      console.error(`[categorizarPatrimonioIA] Falha na chamada à API (uid=${uid}):`, err.message);
      throw new HttpsError('internal', 'Erro ao processar o documento. Tente novamente em instantes.');
    }

    const textoResposta = respostaIA?.content?.[0]?.text || '';
    let itensBrutos;
    try {
      const limpo = textoResposta.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const respostaParsed = JSON.parse(limpo);
      if (!respostaParsed || !Array.isArray(respostaParsed.itens)) throw new Error('resposta não tem "itens" como array');
      itensBrutos = respostaParsed.itens;
    } catch (err) {
      console.error(`[categorizarPatrimonioIA] Resposta da IA não é JSON válido (uid=${uid}):`, textoResposta.slice(0, 500));
      throw new HttpsError('internal', 'Não consegui interpretar esse documento. Tente novamente ou envie um arquivo mais claro.');
    }

    if (itensBrutos.length === 0) {
      throw new HttpsError('invalid-argument', modo === 'ativos' ? 'Nenhum ativo foi identificado neste documento.' : 'Nenhuma dívida foi identificada neste documento.');
    }
    if (itensBrutos.length > 200) {
      throw new HttpsError('invalid-argument', 'Muitos itens identificados (limite de 200).');
    }

    let itens;
    if (modo === 'ativos' && origem === 'corretora') {
      // Corretora: item a item (não agregado), com nome do fundo/ativo e
      // confiança da classificação — rótulo legal (FIM/FIC) nem sempre bate
      // com a estratégia real do fundo. Baixa confiança fica pra usuária
      // revisar antes de salvar (achado 20/07/2026, Flávia: fundo Alaska
      // aparecendo como Multimercado quando na prática é Renda Variável).
      itens = itensBrutos.map((it, i) => {
        const valor = Number(it.valor);
        if (!Number.isFinite(valor) || valor < 0) throw new HttpsError('internal', `Item ${i + 1}: valor inválido retornado pela IA.`);
        const classe = typeof it.classe === 'string' ? it.classe.trim().slice(0, 60) : '';
        if (!classe) throw new HttpsError('internal', `Item ${i + 1}: classe vazia retornada pela IA.`);
        const nome = typeof it.nome === 'string' && it.nome.trim() ? it.nome.trim().slice(0, 80) : classe;
        const confianca = it.confianca === 'baixa' ? 'baixa' : 'alta';
        return { nome, classe, valor, confianca };
      });
    } else if (modo === 'ativos') {
      itens = itensBrutos.map((it, i) => {
        const valor = Number(it.valor);
        if (!Number.isFinite(valor) || valor < 0) throw new HttpsError('internal', `Item ${i + 1}: valor inválido retornado pela IA.`);
        const classe = typeof it.classe === 'string' ? it.classe.trim().slice(0, 60) : '';
        if (!classe) throw new HttpsError('internal', `Item ${i + 1}: classe vazia retornada pela IA.`);
        return { classe, valor };
      });
    } else {
      const TIPOS_DIVIDA = new Set(['financiamento', 'carro', 'emprestimo', 'cartao', 'outro']);
      itens = itensBrutos.map((it, i) => {
        const saldo = Number(it.saldo);
        if (!Number.isFinite(saldo) || saldo < 0) throw new HttpsError('internal', `Item ${i + 1}: saldo inválido retornado pela IA.`);
        const nome = typeof it.nome === 'string' ? it.nome.trim().slice(0, 100) : '';
        if (!nome) throw new HttpsError('internal', `Item ${i + 1}: nome vazio retornado pela IA.`);
        const tipo = TIPOS_DIVIDA.has(it.tipo) ? it.tipo : 'outro';
        const parcela = Number(it.parcela) || 0;
        const termino = typeof it.termino === 'string' ? it.termino.trim().slice(0, 30) : '';
        return { nome, tipo, saldo, parcela, termino };
      });
    }

    console.log(`[categorizarPatrimonioIA] uid=${uid} modo=${modo} — ${itens.length} itens extraídos via IA (tipoConteudo=${tipoConteudo})`);
    return { itens };
  },
);

/**
 * Salva a categoria que a usuária confirmou manualmente para um estabelecimento
 * cuja categorização a IA marcou como incerta — essa mesma categoria passa a
 * ser aplicada automaticamente em futuras importações via categorizarExtratoIA.
 */
exports.salvarCategoriaAprendida = onCall(async (request) => {
  const auth = requireAuth(request);
  const { uid, descricao, categoria } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!descricao || typeof descricao !== 'string' || !descricao.trim())
    throw new HttpsError('invalid-argument', 'descricao é obrigatória.');
  if (!categoria || typeof categoria !== 'string' || !categoria.trim())
    throw new HttpsError('invalid-argument', 'categoria é obrigatória.');
  await checkRateLimit(uid, 'salvarCategoriaAprendida', 30, 60_000);

  const chave = _normalizarEstabelecimento(descricao);
  await db.collection('mentoradas').doc(uid).collection('categoriasAprendidas').doc(chave).set({
    categoria: categoria.trim().slice(0, 200),
    descricaoOriginal: descricao.trim().slice(0, 200),
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

// ─── FATURA ESTADOS ───────────────────────────────────────────────────────────

/**
 * Retorna estados de faturas (ajuste, pagamento, rollover) para todos os cartões.
 * Armazenados em mentoradas/{uid}/faturaEstados/{cartaoId}_{faturaKey}
 */
exports.getFaturaEstados = onCall({ secrets: [] }, async (request) => {
  requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);

  const snaps = await db.collection('mentoradas').doc(uid)
    .collection('faturaEstados').get();

  const estados = {};
  snaps.forEach(doc => { estados[doc.id] = doc.data(); });
  return estados;
});

/**
 * Salva o estado de uma fatura específica (ajuste total, pagamento, rollover).
 * Espera: { uid, cartaoId, faturaKey, ajusteTotal?, estado?, valorPago?, rollover?,
 *           nomeCartao?, nextMesKey?, contaId? }
 * Se estado=paga_parcial e rollover>0, cria automaticamente uma despesa no nextMesKey.
 */
exports.saveFaturaEstado = onCall({ secrets: [] }, async (request) => {
  requireAuth(request);
  const { uid, cartaoId, faturaKey, ajusteTotal, estado, valorPago, rollover,
          nomeCartao, nextMesKey, contaId } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'saveFaturaEstado', 20, 60_000); // 20/min

  if (!cartaoId || typeof cartaoId !== 'string')
    throw new HttpsError('invalid-argument', 'cartaoId é obrigatório.');
  if (!faturaKey || !/^\d{4}-\d{2}$/.test(faturaKey))
    throw new HttpsError('invalid-argument', 'faturaKey deve estar no formato YYYY-MM.');

  const docId  = `${cartaoId}_${faturaKey}`;
  const col    = db.collection('mentoradas').doc(uid).collection('faturaEstados');
  const update = { cartaoId, faturaKey, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() };

  if (ajusteTotal  != null) update.ajusteTotal  = ajusteTotal;
  if (estado       != null) update.estado        = estado;
  if (valorPago    != null) update.valorPago      = valorPago;
  if (rollover     != null) update.rollover       = rollover;
  if (contaId      != null) update.contaId        = contaId;

  const ops = [col.doc(docId).set(update, { merge: true })];

  // Pagamento parcial: cria despesa de saldo pendente no mês seguinte
  if (estado === 'paga_parcial' && rollover > 0 && nextMesKey && /^\d{4}-\d{2}$/.test(nextMesKey)) {
    const [nAno, nMes] = nextMesKey.split('-').map(Number);
    const dataItem = `${nAno}-${String(nMes).padStart(2, '0')}-01`;
    const nomeCartaoSafe = (nomeCartao || cartaoId).slice(0, 60);
    const [fAno, fMes] = faturaKey.split('-').map(Number);
    const MESES_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const mesFaturaLabel = `${MESES_PT[fMes - 1]}/${fAno}`;
    const novoItem = {
      tipo: 'despesa',
      categoria: 'Cartão de crédito',
      descricao: `Saldo pendente ${nomeCartaoSafe} - Fatura ${mesFaturaLabel}`,
      valor: Math.round(rollover * 100) / 100,
      data: dataItem,
      origem: 'rollover',
      cartaoId,
      _rollover: true,
    };
    const orcCol = db.collection('mentoradas').doc(uid).collection('orcamento');
    const nextDoc = orcCol.doc(nextMesKey);
    ops.push(
      db.runTransaction(async t => {
        const snap = await t.get(nextDoc);
        const itens = snap.exists ? (snap.data().itens || []) : [];
        t.set(nextDoc, { itens: [...itens, novoItem] }, { merge: true });
      })
    );
  }

  await Promise.all(ops);
  return { ok: true };
});

// ─── PARCELAMENTO ─────────────────────────────────────────────────────────────

/**
 * Cria N lançamentos parcelados a partir de uma compra.
 * Cada parcela é salva como item individual no documento do mês correto no Firestore.
 */
exports.saveParcelamento = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, categoria, descricao, valorTotal, nParcelas, mesInicio, anoInicio } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'saveParcelamento', 10, 60_000); // 10/min

  if (!categoria || !valorTotal || !nParcelas || !mesInicio || !anoInicio) {
    throw new HttpsError('invalid-argument', 'categoria, valorTotal, nParcelas, mesInicio e anoInicio são obrigatórios.');
  }
  if (nParcelas < 2 || nParcelas > 60) {
    throw new HttpsError('invalid-argument', 'nParcelas deve ser entre 2 e 60.');
  }
  if (typeof valorTotal !== 'number' || valorTotal <= 0) {
    throw new HttpsError('invalid-argument', 'valorTotal deve ser número positivo.');
  }

  const parcelamentoId = require('crypto').randomUUID();
  const valorParcela   = Math.round((valorTotal / nParcelas) * 100) / 100;

  for (let i = 0; i < nParcelas; i++) {
    const d   = new Date(anoInicio, mesInicio - 1 + i, 1);
    const mes = d.getMonth() + 1;
    const ano = d.getFullYear();
    const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
    const data   = `${mesKey}-01`;

    const novaParcela = {
      categoria,
      tipo:           'despesa',
      valor:          valorParcela,
      data,
      descricao:      `${descricao || categoria} — Parcela ${i + 1}/${nParcelas}`,
      origem:         'parcelamento',
      parcelamentoId,
      parcelaAtual:   i + 1,
      parcelasTotal:  nParcelas,
    };

    const ref     = db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKey);
    const docSnap = await ref.get();
    const itens   = docSnap.exists ? (docSnap.data().itens || []) : [];
    itens.push(novaParcela);
    await ref.set({ uid, mes, ano, itens, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });
  }

  // Atualiza cache de sobra do mês inicial
  try {
    const mesKey0 = `${anoInicio}-${String(mesInicio).padStart(2, '0')}`;
    const snap0   = await db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKey0).get();
    const itens0  = snap0.exists ? (snap0.data().itens || []) : [];
    const receita = itens0.filter(i => i.tipo === 'receita').reduce((s, i) => s + i.valor, 0);
    const despesa = itens0.filter(i => i.tipo === 'despesa').reduce((s, i) => s + i.valor, 0);
    db.collection('mentoradas').doc(uid).update({
      sobra: receita - despesa,
      dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(e => console.warn('[saveParcelamento] Falha ao atualizar cache:', e.message));
  } catch (e) {
    console.warn('[saveParcelamento] Falha ao recalcular sobra:', e.message);
  }

  return { ok: true, parcelamentoId, parcelas: nParcelas };
});

/**
 * Remove todas as parcelas futuras (a partir do mês atual) de um parcelamentoId.
 * Parcelas de meses já passados são mantidas para preservar o histórico.
 */
exports.cancelarParcelamento = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, parcelamentoId } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!parcelamentoId) throw new HttpsError('invalid-argument', 'parcelamentoId é obrigatório.');

  const agora    = new Date();
  const mesAtual = agora.getMonth() + 1;
  const anoAtual = agora.getFullYear();

  let removidas = 0;
  for (let i = 0; i < 60; i++) {
    const d   = new Date(anoAtual, mesAtual - 1 + i, 1);
    const mes = d.getMonth() + 1;
    const ano = d.getFullYear();
    const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;

    const ref     = db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKey);
    const docSnap = await ref.get();
    if (!docSnap.exists) {
      if (i > 2 && removidas === 0) break;
      continue;
    }

    const itens     = docSnap.data().itens || [];
    const filtrados = itens.filter(it => it.parcelamentoId !== parcelamentoId);
    if (filtrados.length < itens.length) {
      await ref.set({ uid, mes, ano, itens: filtrados, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });
      removidas += itens.length - filtrados.length;
    }
    if (i > 2 && removidas === 0) break;
  }

  return { ok: true, removidas };
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
    .collection('recorrentes').get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      // Ordena por criadoEm se disponível; documentos sem o campo ficam no início
      const ta = a.criadoEm?._seconds ?? a.criadoEm?.seconds ?? 0;
      const tb = b.criadoEm?._seconds ?? b.criadoEm?.seconds ?? 0;
      if (ta !== tb) return ta - tb;
      return (a.descricao || '').localeCompare(b.descricao || '');
    });
});

/**
 * Cria ou atualiza uma recorrente (despesa ou receita fixa).
 * Espera: { uid, recorrente: { id?, tipo?, categoria, descricao, valor, dia, ativo } }
 * tipo: 'despesa' (padrão) ou 'receita'. Cartão só se aplica a despesa.
 */
exports.saveRecorrente = onCall(async (request) => {
  requireAuth(request);
  const { uid, recorrente } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'saveRecorrente', 20, 60_000); // 20/min

  if (!recorrente?.categoria || typeof recorrente.categoria !== 'string')
    throw new HttpsError('invalid-argument', 'categoria é obrigatória.');
  if (typeof recorrente.valor !== 'number' || recorrente.valor < 0 || recorrente.valor > 10_000_000)
    throw new HttpsError('invalid-argument', 'valor inválido.');

  const frequencia = ['semanal', 'quinzenal', 'mensal'].includes(recorrente.frequencia) ? recorrente.frequencia : 'mensal';
  const minDia = frequencia === 'semanal' ? 0 : 1;
  const maxDia = frequencia === 'quinzenal' ? 14 : 28;
  if (!Number.isInteger(recorrente.dia) || recorrente.dia < minDia || recorrente.dia > maxDia)
    throw new HttpsError('invalid-argument', 'dia inválido para a frequência informada.');

  // tipo: 'despesa' (padrão, compatível com todas as recorrentes já
  // cadastradas antes de 22/07/2026) ou 'receita' — cartão nunca se aplica a
  // receita (não existe "receita no cartão de crédito").
  const tipo = recorrente.tipo === 'receita' ? 'receita' : 'despesa';
  const cartao = tipo === 'despesa' && recorrente.cartao === true;
  const mesesRestantes = Number.isInteger(recorrente.mesesRestantes) && recorrente.mesesRestantes >= 0
    ? recorrente.mesesRestantes : null;

  const col = db.collection('mentoradas').doc(uid).collection('recorrentes');
  const dados = {
    tipo,
    categoria:  recorrente.categoria.trim().slice(0, 200),
    descricao:  (recorrente.descricao || '').trim().slice(0, 500),
    valor:      recorrente.valor,
    dia:        recorrente.dia,
    frequencia,
    mesesRestantes,
    ativo:      recorrente.ativo !== false,
    cartao,
    cartaoId:   cartao ? String(recorrente.cartaoId || '').slice(0, 200) : '',
  };

  if (recorrente.id) {
    // mesInicio/anoInicio nunca mudam numa edição — só valem na criação, senão
    // editar valor/descrição empurraria o início da recorrência pra frente.
    await col.doc(recorrente.id).update(dados);
    return { id: recorrente.id };
  } else {
    // Recorrente só vale a partir do mês em que foi criada — sem isso, uma
    // despesa fixa cadastrada hoje aparecia retroativamente em meses
    // passados também (achado em 06/07/2026). Se o cliente informar
    // mesInicio/anoInicio explícitos (ex: criada a partir de uma data
    // futura escolhida no modal de lançamento), usa esses; senão usa o mês
    // corrente do servidor.
    const hoje = new Date();
    const mesInicio = Number.isInteger(recorrente.mesInicio) && recorrente.mesInicio >= 1 && recorrente.mesInicio <= 12
      ? recorrente.mesInicio : hoje.getMonth() + 1;
    const anoInicio = Number.isInteger(recorrente.anoInicio) && recorrente.anoInicio >= 2020 && recorrente.anoInicio <= 2100
      ? recorrente.anoInicio : hoje.getFullYear();
    const ref = await col.add({ ...dados, mesInicio, anoInicio, criadoEm: admin.firestore.FieldValue.serverTimestamp() });
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

/**
 * Atualiza valor/descrição de uma recorrente em TODOS os meses (passados e futuros)
 * que já tenham esse item lançado. Usa batch write para eficiência.
 * Espera: { uid, recorrenteId, valor, descricao }
 */
exports.atualizarRecorrenteEmTodos = onCall(async (request) => {
  requireAuth(request);
  const { uid, recorrenteId, valor, descricao } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!recorrenteId || typeof recorrenteId !== 'string')
    throw new HttpsError('invalid-argument', 'recorrenteId inválido.');
  if (typeof valor !== 'number' || valor < 0 || valor > 10_000_000)
    throw new HttpsError('invalid-argument', 'valor inválido.');

  const col  = db.collection('mentoradas').doc(uid).collection('orcamento');
  const snap = await col.get();

  const batch = db.batch();
  let mesesAlterados = 0;

  snap.forEach(doc => {
    const itens = doc.data().itens || [];
    let changed = false;
    const novosItens = itens.map(item => {
      if (item.recorrenteId !== recorrenteId) return item;
      changed = true;
      return { ...item, valor, descricao: descricao ?? item.descricao };
    });
    if (changed) {
      batch.update(doc.ref, { itens: novosItens });
      mesesAlterados++;
    }
  });

  if (mesesAlterados > 0) await batch.commit();
  return { ok: true, mesesAlterados };
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
  await checkRateLimit(uid, 'saveCartao', 10, 60_000); // 10/min

  if (!cartao?.nome || typeof cartao.nome !== 'string')
    throw new HttpsError('invalid-argument', 'nome é obrigatório.');
  if (!Number.isInteger(cartao.diaCorte) || cartao.diaCorte < 1 || cartao.diaCorte > 31)
    throw new HttpsError('invalid-argument', 'diaCorte deve ser entre 1 e 31.');
  if (cartao.diaVencimento != null && (!Number.isInteger(cartao.diaVencimento) || cartao.diaVencimento < 1 || cartao.diaVencimento > 31))
    throw new HttpsError('invalid-argument', 'diaVencimento deve ser entre 1 e 31.');

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
  if (!snap.exists) return { categorias: [], renda: null, percentual: null };
  const data = snap.data();
  return { categorias: data.categorias || [], renda: data.renda ?? null, percentual: data.percentual ?? null };
});

/**
 * Salva o planejamento de categorias para um mês/ano específico.
 * Espera: { uid, mes, ano, categorias: [{ nome, limite }] }
 */
exports.saveCategoriasMes = onCall(async (request) => {
  requireAuth(request);
  const { uid, mes, ano, categorias, permitirReducao } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'saveCategoriasMes', 20, 60_000); // 20/min

  if (!Array.isArray(categorias)) throw new HttpsError('invalid-argument', 'categorias deve ser um array.');
  if (categorias.length > 100) throw new HttpsError('invalid-argument', 'Máximo de 100 categorias por mês.');
  for (const c of categorias) {
    if (typeof c.nome !== 'string' || c.nome.length > 200) throw new HttpsError('invalid-argument', 'Nome de categoria inválido.');
    if (c.limite != null && (typeof c.limite !== 'number' || c.limite < 0)) throw new HttpsError('invalid-argument', 'Limite inválido.');
  }
  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const ref = db.collection('mentoradas').doc(uid).collection('planejamento').doc(mesKey);

  // Histórico de versão + trava de encolhimento suspeito (mesma proteção do
  // saveOrcamento) — achado em 04/07/2026: "Copiar de mês anterior" substituía
  // a lista inteira e apagava categorias que só existiam no mês atual.
  const antesSnap = await ref.get();
  const categoriasAntes = antesSnap.exists ? (antesSnap.data().categorias || []) : [];
  if (categoriasAntes.length > 0) {
    await ref.collection('versoes').add({
      categorias: categoriasAntes,
      salvoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
    const antigasSnap = await ref.collection('versoes').orderBy('salvoEm', 'desc').offset(30).limit(20).get();
    antigasSnap.forEach(d => d.ref.delete().catch(() => {}));

    if (!permitirReducao && categorias.length < categoriasAntes.length * 0.5) {
      throw new HttpsError('failed-precondition',
        `Salvamento bloqueado por segurança: iria de ${categoriasAntes.length} para ${categorias.length} categorias. Recarregue a página e tente de novo.`);
    }
  }

  await ref.set({
    categorias,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/**
 * Atualiza (ou remove, se limite <= 0) o limite de UMA categoria no
 * planejamento do mês, via transaction. Ao contrário de saveCategoriasMes
 * (que sobrescreve a lista inteira com o que o cliente tinha em memória),
 * esta função lê e funde no servidor — evita que uma aba/dispositivo com
 * dados desatualizados apague edições feitas em outro lugar.
 * Espera: { uid, mes, ano, nome, limite }
 */
exports.upsertCategoriaLimite = onCall(async (request) => {
  requireAuth(request);
  const { uid, mes, ano, nome, limite } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'upsertCategoriaLimite', 20, 60_000); // 20/min

  if (typeof nome !== 'string' || !nome || nome.length > 200) throw new HttpsError('invalid-argument', 'Nome de categoria inválido.');
  if (typeof limite !== 'number' || limite < 0) throw new HttpsError('invalid-argument', 'Limite inválido.');

  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const ref = db.collection('mentoradas').doc(uid).collection('planejamento').doc(mesKey);

  const categorias = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const atuais = snap.exists ? (snap.data().categorias || []) : [];
    // Compara por nome normalizado (maiúscula/minúscula e acento não geram
    // entrada duplicada) — evita que "Alimentação" e "alimentação" acabem
    // com limites diferentes e nenhum deles bata com o total exibido.
    const idx = atuais.findIndex(c => _normCat(c.nome) === _normCat(nome));
    let novas;
    if (limite > 0) {
      novas = idx === -1
        ? [...atuais, { nome, limite }]
        : atuais.map((c, i) => i === idx ? { ...c, nome, limite } : c);
    } else {
      novas = atuais.filter(c => _normCat(c.nome) !== _normCat(nome));
    }
    tx.set(ref, { categorias: novas, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });
    return novas;
  });

  return { ok: true, categorias };
});

/**
 * Renomeia uma categoria do Planejamento do mês. Se o novo nome já
 * corresponder a outra categoria existente (comparação normalizada, igual
 * upsertCategoriaLimite), os limites são somados automaticamente em vez de
 * criar uma entrada duplicada — pedido em 22/07/2026 (limpar categorias
 * "duplicadas" tipo "Mercado" / "Supermercado" juntando os limites).
 * Escopo: só o limite do Planejamento deste mês — não retroage em
 * lançamentos (despesas/receitas) já registrados.
 * Espera: { uid, mes, ano, nomeAntigo, nomeNovo }
 */
exports.renomearCategoriaLimite = onCall(async (request) => {
  requireAuth(request);
  const { uid, mes, ano, nomeAntigo, nomeNovo } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'renomearCategoriaLimite', 20, 60_000); // 20/min

  if (typeof nomeAntigo !== 'string' || !nomeAntigo) throw new HttpsError('invalid-argument', 'nomeAntigo é obrigatório.');
  if (typeof nomeNovo !== 'string' || !nomeNovo.trim() || nomeNovo.length > 200) throw new HttpsError('invalid-argument', 'nomeNovo inválido.');

  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const ref = db.collection('mentoradas').doc(uid).collection('planejamento').doc(mesKey);
  const nomeNovoLimpo = nomeNovo.trim();

  const resultado = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const atuais = snap.exists ? (snap.data().categorias || []) : [];

    const idxAntiga = atuais.findIndex(c => _normCat(c.nome) === _normCat(nomeAntigo));
    if (idxAntiga === -1) throw new HttpsError('not-found', 'Categoria não encontrada neste mês.');
    const categoriaAntiga = atuais[idxAntiga];

    // Mesmo nome normalizado (só mudou acento/caixa) — renomeia sem mesclar.
    if (_normCat(nomeNovoLimpo) === _normCat(nomeAntigo)) {
      const novas = atuais.map((c, i) => i === idxAntiga ? { ...c, nome: nomeNovoLimpo } : c);
      tx.set(ref, { categorias: novas, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });
      return { categorias: novas, mesclou: false };
    }

    const idxDestino = atuais.findIndex((c, i) => i !== idxAntiga && _normCat(c.nome) === _normCat(nomeNovoLimpo));
    let novas;
    let mesclou = false;
    let nomeDestino = nomeNovoLimpo;
    if (idxDestino === -1) {
      // Nome novo, sem conflito — troca o nome, mantém o limite.
      novas = atuais.map((c, i) => i === idxAntiga ? { ...c, nome: nomeNovoLimpo } : c);
    } else {
      // Já existe categoria com esse nome — soma os limites nela e remove a antiga.
      mesclou = true;
      nomeDestino = atuais[idxDestino].nome; // preserva a grafia já usada no destino
      const limiteSomado = (atuais[idxDestino].limite || 0) + (categoriaAntiga.limite || 0);
      novas = atuais
        .filter((c, i) => i !== idxAntiga)
        .map((c, i) => _normCat(c.nome) === _normCat(nomeNovoLimpo) ? { ...c, limite: limiteSomado } : c);
    }
    tx.set(ref, { categorias: novas, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });
    return { categorias: novas, mesclou, nomeDestino };
  });

  return { ok: true, ...resultado };
});

/**
 * Atualiza renda planejada + percentual planejado do mês, sem tocar em
 * `categorias` — mesmo padrão de merge via transaction do upsertCategoriaLimite,
 * pra não sobrescrever categorias salvas em outra aba/dispositivo.
 * Espera: { uid, mes, ano, renda, percentual }
 */
exports.savePlanejamentoMeta = onCall(async (request) => {
  requireAuth(request);
  const { uid, mes, ano, renda, percentual } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'savePlanejamentoMeta', 20, 60_000); // 20/min

  if (typeof renda !== 'number' || renda < 0) throw new HttpsError('invalid-argument', 'Renda inválida.');
  if (typeof percentual !== 'number' || percentual < 0 || percentual > 100) throw new HttpsError('invalid-argument', 'Percentual inválido.');

  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const ref = db.collection('mentoradas').doc(uid).collection('planejamento').doc(mesKey);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const atuais = snap.exists ? snap.data() : {};
    tx.set(ref, { ...atuais, renda, percentual, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });
  });

  return { ok: true };
});

// ─── CONTAS CORRENTES (múltiplas contas) ─────────────────────────────────────
// Coleção: mentoradas/{uid}/contas/{contaId}. A conta "principal" nunca
// precisa de documento próprio — é sintetizada em getContas() quando não
// existe override salvo, pra quem nunca mexer nisso continuar exatamente
// como está hoje (saldoConta único, sem nenhuma configuração extra).
const CONTA_PRINCIPAL_ID = 'principal';
const CONTA_PRINCIPAL_PADRAO = { id: CONTA_PRINCIPAL_ID, nome: 'Conta principal', ativa: true, principal: true };
const MAX_CONTAS = 10;

/**
 * Lista as contas da mentorada, sempre incluindo a principal (sintetizada
 * se não houver override salvo). Ordena: principal primeiro, depois por nome.
 */
exports.getContas = onCall(async (request) => {
  requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);

  const snap = await db.collection('mentoradas').doc(uid).collection('contas').get();
  const porId = {};
  snap.docs.forEach(d => { porId[d.id] = { ...d.data(), id: d.id }; });

  const principal = { ...CONTA_PRINCIPAL_PADRAO, ...(porId[CONTA_PRINCIPAL_ID] || {}), id: CONTA_PRINCIPAL_ID, principal: true };
  delete porId[CONTA_PRINCIPAL_ID];

  const secundarias = Object.values(porId)
    .map(c => ({ ...c, principal: false }))
    .sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));

  return { contas: [principal, ...secundarias] };
});

/**
 * Cria ou atualiza (rename/reativar) uma conta. Espera: { uid, id?, nome, ativa? }.
 * Sem id → cria nova. Com id (inclusive 'principal') → atualiza/renomeia.
 */
exports.saveConta = onCall(async (request) => {
  requireAuth(request);
  const { uid, id, nome, ativa } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'saveConta', 20, 60_000); // 20/min

  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo || nomeLimpo.length > 100) throw new HttpsError('invalid-argument', 'Nome da conta inválido.');

  const colRef = db.collection('mentoradas').doc(uid).collection('contas');

  if (!id) {
    // Exclui a principal da contagem (pode ter documento próprio se já foi
    // renomeada) — o limite é sobre contas SECUNDÁRIAS, a principal não conta.
    const countSnap = await colRef.count().get();
    const totalSecundarias = countSnap.data().count - (await colRef.doc(CONTA_PRINCIPAL_ID).get()).exists;
    if (totalSecundarias >= MAX_CONTAS - 1) {
      throw new HttpsError('failed-precondition', `Limite de ${MAX_CONTAS - 1} contas secundárias atingido.`);
    }
    const novaRef = colRef.doc();
    await novaRef.set({ nome: nomeLimpo, ativa: true, criadaEm: admin.firestore.FieldValue.serverTimestamp() });
    return { id: novaRef.id, nome: nomeLimpo, ativa: true, principal: false };
  }

  const ref = colRef.doc(String(id));
  const snap = await ref.get();
  await ref.set({
    nome: nomeLimpo,
    ...(ativa != null ? { ativa: !!ativa } : {}),
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    ...(snap.exists ? {} : { criadaEm: admin.firestore.FieldValue.serverTimestamp() }),
  }, { merge: true });

  return { id: String(id), nome: nomeLimpo, ativa: ativa != null ? !!ativa : true, principal: id === CONTA_PRINCIPAL_ID };
});

/**
 * Arquiva (ativa:false) ou reativa uma conta secundária — nunca a principal,
 * que é a base pra todo lançamento sem contaId explícito.
 */
exports.arquivarConta = onCall(async (request) => {
  requireAuth(request);
  const { uid, id, ativa } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'arquivarConta', 20, 60_000); // 20/min

  if (!id || id === CONTA_PRINCIPAL_ID) throw new HttpsError('invalid-argument', 'A conta principal não pode ser arquivada.');

  await db.collection('mentoradas').doc(uid).collection('contas').doc(String(id))
    .set({ ativa: !!ativa, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  return { ok: true };
});

/**
 * Exclui uma conta secundária permanentemente — nunca a principal. Não há
 * lançamento vinculado a excluir junto: despesas/receitas/cartões ainda não
 * têm campo contaId na interface (isso chega numa fase futura), então uma
 * conta secundária hoje só carrega nome + saldo inicial por mês.
 */
exports.deletarConta = onCall(async (request) => {
  requireAuth(request);
  const { uid, id } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'deletarConta', 20, 60_000); // 20/min

  if (!id || id === CONTA_PRINCIPAL_ID) throw new HttpsError('invalid-argument', 'A conta principal não pode ser excluída.');

  await db.collection('mentoradas').doc(uid).collection('contas').doc(String(id)).delete();

  return { ok: true };
});

// ─── SALDO INICIAL POR CONTA E MÊS ────────────────────────────────────────────
// Coleção: mentoradas/{uid}/saldosConta/{YYYY-MM} = { [contaId]: valor }.
// Substitui o item-sentinela "__saldo_conta__" (que vivia dentro do array de
// itens do orçamento) — o frontend decide o valor de cada mês (carryover do
// Saldo Final do mês anterior, ou fallback pro sentinela legado de meses já
// salvos antes dessa coleção existir) e persiste aqui via saveSaldoConta.

exports.getSaldosConta = onCall(async (request) => {
  requireAuth(request);
  const { uid, mes, ano } = request.data;
  requireSelfOrAdmin(request, uid);

  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const snap = await db.collection('mentoradas').doc(uid).collection('saldosConta').doc(mesKey).get();
  return { saldos: snap.exists ? (snap.data().saldos || {}) : {} };
});

/**
 * Atualiza o saldo inicial de UMA conta no mês, via transaction (merge no
 * servidor — não sobrescreve o saldo de outras contas salvo em paralelo).
 * Espera: { uid, mes, ano, contaId, valor }
 */
exports.saveSaldoConta = onCall(async (request) => {
  requireAuth(request);
  const { uid, mes, ano, contaId, valor } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'saveSaldoConta', 30, 60_000); // 30/min — carryover automático pode disparar em background

  if (!contaId || typeof contaId !== 'string') throw new HttpsError('invalid-argument', 'contaId inválido.');
  if (typeof valor !== 'number' || !Number.isFinite(valor)) throw new HttpsError('invalid-argument', 'Valor inválido.');

  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const ref = db.collection('mentoradas').doc(uid).collection('saldosConta').doc(mesKey);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const saldosAtuais = snap.exists ? (snap.data().saldos || {}) : {};
    tx.set(ref, {
      saldos: { ...saldosAtuais, [contaId]: valor },
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
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
  if (categorias.length > 100) throw new HttpsError('invalid-argument', 'Máximo de 100 categorias.');
  for (const c of categorias) {
    if (typeof c.nome !== 'string' || c.nome.length > 200) throw new HttpsError('invalid-argument', 'Nome de categoria inválido.');
    if (c.limite != null && (typeof c.limite !== 'number' || c.limite < 0)) throw new HttpsError('invalid-argument', 'Limite inválido.');
  }
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
    return { ativos: consolidarAtivos(ir, corretora), dividas, corretoraPosicoes: agruparPosicoesCorretora(corretora) };
  }

  // ── Fallback: Sheets + auto-migra ────────────────────────────────────────
  const sheetId = await getSheetId(db, uid);
  if (!sheetId) return { ativos: [], dividas: [], corretoraPosicoes: [] };
  const sheets  = new SheetsClient(sheetId);
  const [ir, corretora, dividas] = await Promise.all([
    sheets.getPatrimonio(), sheets.getInvestimentos(), sheets.getDividas(),
  ]);
  // Persiste no Firestore para próximas leituras
  db.collection('mentoradas').doc(uid).collection('patrimonio').doc('dados')
    .set({ ir, corretora, dividas, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() })
    .catch(e => console.warn('[getPatrimonio] Falha ao migrar:', e.message));
  return { ativos: consolidarAtivos(ir, corretora), dividas, corretoraPosicoes: agruparPosicoesCorretora(corretora) };
});

/**
 * Cria ou atualiza UMA posição nomeada da corretora (achado 20/07/2026:
 * antes, importar uma segunda posição — casal, mais de uma corretora —
 * sobrescrevia a primeira por inteiro). Sem posicaoId = nova posição; com
 * posicaoId = substitui só os itens dessa posição, sem tocar nas outras.
 * Espera: { uid, posicaoId?, nome, itens: [{classe, valor}] }
 */
exports.saveCorretoraPosicao = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, posicaoId, nome, itens } = request.data;
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'saveCorretoraPosicao', 10, 60_000);

  if (!nome || typeof nome !== 'string' || !nome.trim())
    throw new HttpsError('invalid-argument', 'nome da posição é obrigatório.');
  if (!Array.isArray(itens) || itens.length === 0)
    throw new HttpsError('invalid-argument', 'itens deve ser um array não vazio.');
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i];
    if (!it.classe || typeof it.classe !== 'string' || it.classe.trim() === '')
      throw new HttpsError('invalid-argument', `Item ${i + 1}: classe é obrigatória.`);
    if (typeof it.valor !== 'number' || isNaN(it.valor) || it.valor < 0)
      throw new HttpsError('invalid-argument', `Item ${i + 1}: valor deve ser número não-negativo.`);
  }

  const patRef  = db.collection('mentoradas').doc(uid).collection('patrimonio').doc('dados');
  const patSnap = await patRef.get();
  const ir       = patSnap.exists ? (patSnap.data().ir       || []) : [];
  const dividas  = patSnap.exists ? (patSnap.data().dividas  || []) : [];
  let corretora  = patSnap.exists ? (patSnap.data().corretora || []) : [];

  const idFinal = posicaoId || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // Remove os itens antigos dessa MESMA posição (se for edição) — nunca mexe
  // nos itens de outras posições.
  corretora = corretora.filter(item => (item.posicaoId || '__legado__') !== idFinal);
  const agora = new Date().toISOString();
  corretora.push(...itens.map(it => ({
    classe: it.classe, valor: it.valor,
    posicaoId: idFinal, posicaoNome: nome.trim(), posicaoAtualizadoEm: agora,
  })));

  await patRef.set({ ir, corretora, dividas, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });

  const totalAtivos  = consolidarAtivos(ir, corretora).reduce((s, a) => s + a.valor, 0);
  const totalDividas = dividas.reduce((s, d) => s + d.saldo, 0);
  db.collection('mentoradas').doc(uid).update({
    pl: totalAtivos - totalDividas,
    dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.warn('[saveCorretoraPosicao] Cache PL falhou:', e.message));

  getSheetId(db, uid).then(sheetId => {
    if (!sheetId) return;
    return new SheetsClient(sheetId).saveInvestimentos(corretora);
  }).catch(e => console.warn('[saveCorretoraPosicao] Backup Sheets falhou:', e.message));

  return { ok: true, posicaoId: idFinal };
});

/**
 * Remove uma posição inteira da corretora (todos os itens com esse
 * posicaoId), sem afetar as demais posições.
 */
exports.deleteCorretoraPosicao = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, posicaoId } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!posicaoId || typeof posicaoId !== 'string')
    throw new HttpsError('invalid-argument', 'posicaoId é obrigatório.');

  const patRef  = db.collection('mentoradas').doc(uid).collection('patrimonio').doc('dados');
  const patSnap = await patRef.get();
  if (!patSnap.exists) return { ok: true };

  const ir       = patSnap.data().ir      || [];
  const dividas  = patSnap.data().dividas || [];
  const corretora = (patSnap.data().corretora || [])
    .filter(item => (item.posicaoId || '__legado__') !== posicaoId);

  await patRef.set({ ir, corretora, dividas, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });

  const totalAtivos  = consolidarAtivos(ir, corretora).reduce((s, a) => s + a.valor, 0);
  const totalDividas = dividas.reduce((s, d) => s + d.saldo, 0);
  db.collection('mentoradas').doc(uid).update({
    pl: totalAtivos - totalDividas,
    dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.warn('[deleteCorretoraPosicao] Cache PL falhou:', e.message));

  getSheetId(db, uid).then(sheetId => {
    if (!sheetId) return;
    return new SheetsClient(sheetId).saveInvestimentos(corretora);
  }).catch(e => console.warn('[deleteCorretoraPosicao] Backup Sheets falhou:', e.message));

  return { ok: true };
});

// Só cuida do patrimônio IR (bem físico, 1x/ano, sempre uma posição só —
// não faz sentido "mais de uma declaração de IR" do mesmo jeito que faz
// sentido mais de uma posição de corretora). Corretora tem posições
// nomeadas independentes — ver saveCorretoraPosicao/deleteCorretoraPosicao
// (achado 20/07/2026: savePatrimonio(tipo='corretora') sobrescrevia tudo,
// perdendo a posição de quem já tinha importado antes).
exports.savePatrimonio = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, itens, tipo } = request.data; // tipo: 'ir' (único suportado)
  requireSelfOrAdmin(request, uid);
  await checkRateLimit(uid, 'savePatrimonio', 10, 60_000); // 10/min

  // ── Validação ──────────────────────────────────────────────────────────────
  if (!Array.isArray(itens))
    throw new HttpsError('invalid-argument', 'itens deve ser um array.');
  if (tipo !== 'ir')
    throw new HttpsError('invalid-argument', 'tipo deve ser "ir" — corretora usa saveCorretoraPosicao.');
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
  let corretora = patSnap.exists ? (patSnap.data().corretora || []) : [];
  let dividas   = patSnap.exists ? (patSnap.data().dividas   || []) : [];

  if (!patSnap.exists) {
    // Fallback Sheets
    try {
      const sheetId = await getSheetId(db, uid);
      if (sheetId) {
        const sheets = new SheetsClient(sheetId);
        [, corretora, dividas] = await Promise.all([
          sheets.getPatrimonio(), sheets.getInvestimentos(), sheets.getDividas(),
        ]);
      }
    } catch (e) { console.warn('[savePatrimonio] Fallback Sheets falhou:', e.message); }
  }

  const ir = itens;

  await patRef.set({
    ir, corretora, dividas,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Backup no Sheets (fire-and-forget, não bloqueia resposta)
  getSheetId(db, uid).then(sheetId => {
    if (!sheetId) return;
    return new SheetsClient(sheetId).savePatrimonio(itens);
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

/**
 * Corrige manualmente o snapshot histórico de um mês específico (admin only).
 * Uso pontual: quando o auto-snapshot gravou um valor incorreto (ex: contaminado
 * por edição feita antes do fim do mês) e precisa ser reconciliado à mão.
 * Espera: { uid, mesKey (YYYY-MM), ativos, dividas }
 */
exports.corrigirHistoricoMes = onCall(async (request) => {
  requireAdmin(request);
  const { uid, mesKey, ativos, dividas } = request.data;

  if (!uid || typeof uid !== 'string') throw new HttpsError('invalid-argument', 'uid é obrigatório.');
  if (!mesKey || !/^\d{4}-\d{2}$/.test(mesKey)) throw new HttpsError('invalid-argument', 'mesKey deve estar no formato YYYY-MM.');
  if (typeof ativos !== 'number' || typeof dividas !== 'number') throw new HttpsError('invalid-argument', 'ativos e dividas devem ser números.');

  const pl = ativos - dividas;
  await db.collection('mentoradas').doc(uid).collection('historico').doc(mesKey).set({
    data: mesKey, ativos, dividas, pl,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true, pl };
});

/**
 * Snapshot mensal automático do patrimônio de todas as mentoradas ativas —
 * roda nos dias 1 e 28 (início e fim do mês). Complementa os snapshots feitos
 * ao importar CSV, garantindo um ponto de referência no gráfico de evolução
 * mesmo em meses sem nenhuma importação/edição.
 */
async function snapshotMensalPatrimonioTodasAtivas() {
  const mesKey = hoje().slice(0, 7);
  const mentoradas = await getAtivas();
  for (const m of mentoradas) {
    try {
      const docSnap = await db.collection('mentoradas').doc(m.id).collection('patrimonio').doc('dados').get();
      if (!docSnap.exists) continue;
      const { ir = [], corretora = [], dividas = [] } = docSnap.data();
      const totalAtivos  = consolidarAtivos(ir, corretora).reduce((s, a) => s + a.valor, 0);
      const totalDividas = dividas.reduce((s, d) => s + d.saldo, 0);
      if (!totalAtivos && !totalDividas) continue;
      await db.collection('mentoradas').doc(m.id).collection('historico').doc(mesKey).set({
        data: mesKey, ativos: totalAtivos, dividas: totalDividas, pl: totalAtivos - totalDividas,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.warn(`[snapshotMensalPatrimonio] Falha para ${m.id}:`, e.message);
    }
  }
}

exports.snapshotMensalPatrimonioDia1 = onSchedule(
  { schedule: '0 8 1 * *', timeZone: 'America/Sao_Paulo' },
  comMonitoramento('snapshotMensalPatrimonioDia1', async () => {
    if (await jaExecutouHoje('snapshotMensalPatrimonioDia1')) return;
    await snapshotMensalPatrimonioTodasAtivas();
  })
);

exports.snapshotMensalPatrimonioDia28 = onSchedule(
  { schedule: '0 8 28 * *', timeZone: 'America/Sao_Paulo' },
  comMonitoramento('snapshotMensalPatrimonioDia28', async () => {
    if (await jaExecutouHoje('snapshotMensalPatrimonioDia28')) return;
    await snapshotMensalPatrimonioTodasAtivas();
  })
);

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

  // Fallback Sheets: garante que ir/corretora não ficam vazios se ainda não migrou
  if (!patSnap.exists) {
    try {
      const sheetId = await getSheetId(db, uid);
      if (sheetId) {
        const sheets = new SheetsClient(sheetId);
        [ir, corretora, dividas] = await Promise.all([
          sheets.getPatrimonio(), sheets.getInvestimentos(), sheets.getDividas(),
        ]);
      }
    } catch (e) { console.warn('[saveDivida] Fallback Sheets falhou:', e.message); }
  }

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

  // Firestore primary — criadoEm só é definido na criação (não sobrescreve em updates)
  const reservaRef = db.collection('mentoradas').doc(uid).collection('reservas').doc(String(reserva.id));
  const reservaSnap = await reservaRef.get();
  await reservaRef.set({
    ...reserva,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    ...(reservaSnap.exists ? {} : { criadoEm: admin.firestore.FieldValue.serverTimestamp() }),
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
    perfil,
    perfilData: dataAtualizacao,
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
  const agora = new Date();
  const mesAtualKey = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;

  // setupPassosFeitos (0-4): mesma checagem do onboarding que a mentorada vê
  // em index.html (perfil, patrimônio, reservas, orçamento do mês) — usado
  // pro alerta "Onboarding incompleto" no admin, pra sinalizar quem começou
  // fora de ordem e pode travar numa ação sem saber o motivo (achado no
  // feedback da Juliana Valerio, 07/07/2026). Calculado ao vivo aqui, não
  // cacheado no doc, pra não repetir o bug de divergência do scoreMes.
  return Promise.all(snap.docs.map(async (doc) => {
    const m = { uid: doc.id, ...doc.data() };
    if (m.status === 'inativa') return m;

    const [resSnap, orcSnap, patSnap] = await Promise.all([
      doc.ref.collection('reservas').limit(1).get().catch(() => null),
      doc.ref.collection('orcamento').doc(mesAtualKey).get().catch(() => null),
      doc.ref.collection('patrimonio').doc('dados').get().catch(() => null),
    ]);

    const temPerfil     = !!m.perfil;
    const temPatrimonio = !!(patSnap?.exists && ((patSnap.data().ir || []).length > 0 || (patSnap.data().corretora || []).length > 0));
    const temReservas   = !!(resSnap && !resSnap.empty);
    const temOrcamento  = (orcSnap?.exists ? (orcSnap.data().itens || []) : []).some(i => i.tipo === 'receita' && i.valor > 0);

    const setupPassosFeitos = [temPerfil, temPatrimonio, temReservas, temOrcamento].filter(Boolean).length;
    return { ...m, setupPassosFeitos };
  }));
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
    // Alerta imediato — provável expiração do token OAuth2 do Drive
    alertarErro('createMentorada (Drive OAuth2)', new Error(
      `Falha ao criar planilha para ${email}: ${err.message}\n\n` +
      `Se o erro for "invalid_grant" ou "Token has been expired", o token OAuth2 expirou.\n` +
      `Acesse o Firebase Console → Functions → Secrets e regenere GOOGLE_REFRESH_TOKEN.`
    )).catch(() => {});
    // Continua — planilha pode ser criada/vinculada manualmente depois
  }

  // 3. Salvar no Firestore
  // Flags de assinatura derivadas do produto selecionado:
  // dashboard → assinaturaDashboard: true
  // clube     → assinaturaClube: true
  // combo     → ambos true
  const produtoNorm = (produto || '').toLowerCase();
  const flagsAssinatura = {};
  if (produtoNorm === 'dashboard' || produtoNorm === 'combo') flagsAssinatura.assinaturaDashboard = true;
  if (produtoNorm === 'clube'     || produtoNorm === 'combo') flagsAssinatura.assinaturaClube     = true;

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
    ...flagsAssinatura,
  });

  // 4. Enviar e-mail de boas-vindas SEM link de acesso.
  //    O link é gerado separadamente via "Reenviar acesso" no painel admin,
  //    garantindo que nunca chegue expirado à mentorada.
  let emailEnviado = false;
  let emailErro    = null;
  try {
    await sendEmail({
      to:      email,
      subject: 'Bem-vinda ao Trilogia Dashboard',
      html:    emailBoasVindas(nome),
    });
    emailEnviado = true;
  } catch (err) {
    emailErro = err.message;
    console.error(`[createMentorada] Falha ao enviar e-mail de boas-vindas para ${email}:`, err.message);
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
exports.updateMentorada = onCall({ secrets: [sGmail] }, async (request) => {
  requireAdmin(request);

  const { uid, campos } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  const permitidos = [
    'status', 'nota', 'perfil', 'inicio',
    'produto', 'valorMensal', 'formaPagamento', 'dataExpiracao',
    'mentoriaEncerrada', 'assinaturaDashboard', 'assinaturaClube',
    'notionLicoesPendentes', 'nome', 'email',
  ];
  const atualizacao = {};
  for (const [k, v] of Object.entries(campos || {})) {
    // Ignora undefined e null — Firebase pode descartar nulos na serialização callable
    if (permitidos.includes(k) && v !== undefined && v !== null) atualizacao[k] = v;
  }

  if (Object.keys(atualizacao).length === 0) {
    throw new HttpsError('invalid-argument', 'Nenhum campo válido para atualizar.');
  }

  // Se produto foi alterado, sincroniza flags de assinatura automaticamente
  // para evitar estado inconsistente (ex: assinaturaClube: true sem assinaturaDashboard)
  if (atualizacao.produto) {
    const p = atualizacao.produto.toLowerCase();
    if (p === 'dashboard' || p === 'combo') atualizacao.assinaturaDashboard = true;
    if (p === 'clube'     || p === 'combo') atualizacao.assinaturaClube     = true;
  }

  await db.collection('mentoradas').doc(uid).update(atualizacao);

  // Espelha nome e e-mail no Firebase Auth
  const authUpdate = {};
  if (atualizacao.nome)  authUpdate.displayName = atualizacao.nome;
  if (atualizacao.email) authUpdate.email        = atualizacao.email;
  if (Object.keys(authUpdate).length > 0) {
    await admin.auth().updateUser(uid, authUpdate);
  }

  // Upgrade self-service: envia e-mail quando mentoria é encerrada
  if (atualizacao.mentoriaEncerrada === true) {
    const snap = await db.collection('mentoradas').doc(uid).get();
    const { nome, email } = snap.data() || {};
    if (email) {
      sendEmail({
        to:      email,
        subject: 'Sua mentoria chegou ao fim — e sua jornada continua',
        html:    emailUpgradeDashboard(nome || 'mentorada'),
      }).catch(e => console.warn('[updateMentorada] Falha ao enviar e-mail de upgrade:', e.message));
    }
  }

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

  // Desabilita a conta E revoga todos os refresh tokens ativos
  // (elimina sessões abertas imediatamente, sem esperar o JWT de 1h expirar)
  await Promise.all([
    admin.auth().updateUser(uid, { disabled: true }),
    admin.auth().revokeRefreshTokens(uid),
  ]);
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
exports.deletarMentorada = onCall({ secrets: [sClientId, sClientSec, sRefresh, sNotion] }, async (request) => {
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

  // Apaga subcoleções de dados financeiros (LGPD — Firestore não deleta subcoleções automaticamente)
  for (const sub of ['orcamento', 'reservas', 'perfil', 'historico', 'planejamento', 'scores']) {
    try { await deleteSubcolecao(uid, sub); } catch (err) {
      console.warn(`[deletarMentorada] Falha ao remover ${sub} de ${uid}:`, err.message);
    }
  }

  // Apaga planilha do Google Drive (LGPD — direito de apagamento)
  let planilhaApagada = false;
  if (docData.sheetId) {
    try {
      await deletePlanilha(docData.sheetId);
      planilhaApagada = true;
    } catch (err) {
      console.warn(`[deletarMentorada] Falha ao apagar planilha ${docData.sheetId}:`, err.message);
    }
  }

  // Arquiva página no Notion (LGPD — dados de mentoria: temas, lições, notas comportamentais)
  if (docData.notionPageId) {
    try {
      const notionToken = process.env.NOTION_TOKEN;
      if (notionToken) {
        const resp = await fetch(`https://api.notion.com/v1/pages/${docData.notionPageId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${notionToken}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
          },
          body: JSON.stringify({ archived: true }),
        });
        if (!resp.ok) console.warn(`[deletarMentorada] Falha ao arquivar Notion ${docData.notionPageId}:`, resp.status);
      }
    } catch (err) {
      console.warn(`[deletarMentorada] Erro ao arquivar Notion:`, err.message);
    }
  }

  // Audit log LGPD — mesmo TTL de 5 anos usado em _lgpd_log (achado na
  // auditoria de segurança de 06/07/2026: esse log guardava nome/e-mail de
  // quem pediu exclusão sem nenhum prazo de retenção definido).
  const expireAtDeletada = new Date();
  expireAtDeletada.setFullYear(expireAtDeletada.getFullYear() + 5);
  try {
    await db.collection('mentoradas_deletadas').doc(uid).set({
      nome:            docData.nome            || null,
      email:           docData.email           || null,
      produto:         docData.produto         || null,
      inicio:          docData.inicio          || null,
      sheetId:         docData.sheetId         || null,
      notionPageId:    docData.notionPageId    || null,
      planilhaApagada,
      deletadoEm:      admin.firestore.FieldValue.serverTimestamp(),
      deletadoPor:     request.auth?.uid       || 'admin',
      expireAt:        expireAtDeletada,
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
    link = await admin.auth().generatePasswordResetLink(userRecord.email, {
      url: 'https://dashboard.flaviaschusciman.com/login.html',
    });
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
 * Solicita redefinição de senha via Gmail — substitui o sendPasswordResetEmail
 * do Firebase (que usa noreply@firebaseapp.com e cai em spam).
 * Não requer autenticação. Sempre retorna ok=true (não revela se e-mail existe).
 */
exports.solicitarRedefinicaoSenha = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  const { email } = request.data;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new HttpsError('invalid-argument', 'E-mail inválido.');
  }
  const emailNorm = email.trim().toLowerCase();
  try {
    const userRecord = await admin.auth().getUserByEmail(emailNorm);
    const link = await admin.auth().generatePasswordResetLink(userRecord.email, {
      url: 'https://dashboard.flaviaschusciman.com/login.html',
    });
    const snap = await db.collection('mentoradas').doc(userRecord.uid).get();
    const nome = snap.exists ? (snap.data().nome || userRecord.displayName || 'mentorada') : (userRecord.displayName || 'mentorada');
    await sendEmail({
      to: userRecord.email,
      subject: 'Seu link de acesso — Trilogia Dashboard',
      html: emailReenvioAcesso(nome, link),
    });
    console.log(`[solicitarRedefinicaoSenha] e-mail enviado para ${maskEmail(emailNorm)}`);
  } catch (err) {
    // Silencia auth/user-not-found e outros erros — não revela se o e-mail existe
    console.warn(`[solicitarRedefinicaoSenha] ${emailNorm}: ${err.message}`);
  }
  return { ok: true };
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
  'extrato_ia_importado', // categorizarExtratoIA — substitui o Agente Raio-X do ChatGPT
  // Eventos de abandono (5.3/5.4)
  'ir_importado', 'corretora_importada', 'divida_cadastrada',
  'reserva_retirada', 'aba_anual_aberta', 'divida_pagamento_confirmado',
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

// ─── SCORE DE SAÚDE FINANCEIRA ───────────────────────────────────────────────

/**
 * Salva o score de saúde financeira do mês no Firestore.
 * Atualiza o campo scoreMes no doc principal (usado pela home)
 * e registra o histórico na subcoleção scores/{YYYY-MM}.
 */
exports.salvarScoreMes = onCall({}, async (request) => {
  const { mes, ano, score, componentes, uid: uidBody } = request.data;
  // Sem uid explícito, caía sempre em auth.uid — quando o admin testava via
  // "Visualizando como mentorada", o score calculado a partir dos dados DELA
  // era salvo no documento do ADMIN, e o score da mentorada nunca atualizava
  // (achado 16/07/2026: score da Luiza ficou preso num valor de dias atrás,
  // mesmo com testes extensivos feitos via ViewAs no mesmo dia).
  const uid = uidBody || requireAuth(request).uid;
  requireSelfOrAdmin(request, uid);
  if (!mes || !ano || score == null) throw new HttpsError('invalid-argument', 'mes, ano e score são obrigatórios.');

  const chave = `${ano}-${String(mes).padStart(2, '0')}`;

  await db.collection('mentoradas').doc(uid).update({
    scoreMes:          score,
    scoreChave:        chave,
    scoreAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('mentoradas').doc(uid)
    .collection('scores').doc(chave).set({
      score,
      componentes: componentes || {},
      mes, ano,
      calculadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

  return { ok: true };
});

/**
 * Retorna os últimos 12 scores mensais da mentorada (ou da mentorada em viewAs).
 */
exports.getScoreHistorico = onCall({}, async (request) => {
  requireAuth(request);
  const { viewAsUid } = request.data || {};
  const targetUid = viewAsUid || request.auth.uid;
  requireSelfOrAdmin(request, targetUid);

  const snap = await db.collection('mentoradas').doc(targetUid)
    .collection('scores')
    .orderBy('calculadoEm', 'desc')
    .limit(12)
    .get();

  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

  // Patrimônio, dívidas: Firestore first → fallback Sheets
  let patrimonio = [], investimentos = [], dividas = [], reservas = [], perfil = null;
  const patSnap = await db.collection('mentoradas').doc(uid).collection('patrimonio').doc('dados').get();
  if (patSnap.exists) {
    patrimonio    = patSnap.data().ir        || [];
    investimentos = patSnap.data().corretora || [];
    dividas       = patSnap.data().dividas   || [];
  } else if (conta.sheetId) {
    const sheets = new SheetsClient(conta.sheetId);
    [patrimonio, investimentos, dividas] = await Promise.allSettled([
      sheets.getPatrimonio(), sheets.getInvestimentos(), sheets.getDividas(),
    ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : []));
  }

  // Reservas: Firestore first → fallback Sheets
  const resSnap = await db.collection('mentoradas').doc(uid).collection('reservas').get();
  if (!resSnap.empty) {
    reservas = resSnap.docs.map(d => ({ ...d.data(), id: d.id }));
  } else if (conta.sheetId) {
    reservas = await new SheetsClient(conta.sheetId).getReservas().catch(() => []);
  }

  // Perfil: Firestore first → fallback Sheets
  const perfilSnap = await db.collection('mentoradas').doc(uid).collection('perfil').doc('dados').get();
  if (perfilSnap.exists) {
    perfil = perfilSnap.data();
  } else if (conta.sheetId) {
    perfil = await new SheetsClient(conta.sheetId).getPerfil().catch(() => null);
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

/**
 * Verifica o escopo e validade da Service Account (diagnóstico de segurança).
 * Retorna: email da SA, escopos configurados, se o secret existe.
 */
exports.verificarSA = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  requireAdmin(request);
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) return { ok: false, erro: 'Secret não configurado.' };
    const cred = JSON.parse(raw);
    return {
      ok:           true,
      email:        cred.client_email || '?',
      projeto:      cred.project_id   || '?',
      escopo:       'spreadsheets (somente Sheets — sem Drive, sem Gmail)',
      tipo:         cred.type         || '?',
      criado:       'verificar em GCP Console → IAM → Service Accounts',
    };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
});

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
 * Edita o vencimento de uma cobrança pendente (não paga, não cancelada).
 */
exports.editarVencimento = onCall({}, async (request) => {
  requireAdmin(request);
  const { cobrancaId, novoVencimento } = request.data;
  if (!cobrancaId || !novoVencimento) throw new HttpsError('invalid-argument', 'cobrancaId e novoVencimento obrigatórios.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(novoVencimento)) throw new HttpsError('invalid-argument', 'novoVencimento deve estar no formato YYYY-MM-DD.');
  const ref  = db.collection('cobrancas').doc(cobrancaId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Cobrança não encontrada.');
  const data = snap.data();
  if (data.pago) throw new HttpsError('failed-precondition', 'Cobrança já paga — vencimento não pode ser alterado.');
  if (data.cancelada) throw new HttpsError('failed-precondition', 'Cobrança cancelada — vencimento não pode ser alterado.');
  await ref.update({ vencimento: novoVencimento });
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

// ─── PÓS-VENDA: sequência de e-mail + WhatsApp agendado ──────────────────────

/**
 * Aciona a esteira de pós-venda para compradores de ebook ou curso:
 *  1. Inscreve o contato no grupo MailerLite correspondente (dispara a sequência de e-mail)
 *  2. Cria documentos em `whatsapp_agendado` para envio nos dias programados
 *
 * Sequências de WhatsApp por produto:
 *  ebook → D+14 (contato pessoal) e D+21 (oferta do curso)
 *  curso → D+60 (check de progresso) e D+75 (convite para mentoria)
 *
 * Chamada em background (fire-and-forget) — falha não bloqueia o webhook.
 */
async function acionarEsteiraPosVenda({ email, nome, telefone, produto, produtoEspecifico, dataPagamento }) {
  const PRODUTOS_ESTEIRA = ['ebook', 'curso'];
  if (!PRODUTOS_ESTEIRA.includes(produto)) return;

  const mailerApiKey = sMailerLite.value();
  if (!mailerApiKey) {
    console.warn('[posVenda] MAILERLITE_API_KEY não configurada — pulando MailerLite.');
  } else if (!produtoEspecifico) {
    console.warn(`[posVenda] produtoEspecifico ausente para produto "${produto}" — MailerLite ignorado.`);
  } else {
    try {
      const ml = new MailerLiteClient(mailerApiKey);
      await ml.inscreverNaSequencia(email, nome, produtoEspecifico);
    } catch (err) {
      console.error(`[posVenda] Erro ao inscrever ${email} no MailerLite:`, err.message);
    }
  }

  // Agenda mensagens WhatsApp no Firestore (processaWhatsAppAgendado as envia diariamente)
  if (!telefone) {
    console.warn(`[posVenda] Telefone ausente para ${email} — WhatsApp não agendado.`);
    return;
  }

  const diasPorProduto = {
    ebook: [
      { dias: 14, mensagem: `Oi, ${nome.split(' ')[0]}! Aqui é a Flávia. Vi que você baixou o ebook — como está indo? Teve alguma dúvida ou travamento no caminho? Pode me chamar aqui. 😊` },
      { dias: 21, mensagem: `Oi, ${nome.split(' ')[0]}! Voltei para saber se o ebook ajudou. Se quiser dar um próximo passo e entender como organizar seu financeiro de verdade, posso te contar sobre o curso. Sem compromisso — é só me falar. 🙏` },
    ],
    curso: [
      { dias: 60, mensagem: `Oi, ${nome.split(' ')[0]}! Aqui é a Flávia. Você já está no curso há dois meses — como está sendo? O que mais te travou até agora? Quero entender sua experiência. 💙` },
      { dias: 75, mensagem: `Oi, ${nome.split(' ')[0]}! Vi que você está avançando no curso. Queria te convidar para uma conversa rápida sobre seu próximo passo financeiro — sem compromisso, só para entender onde você está e para onde quer ir. Topa? 🙏` },
    ],
  };

  const dataBase = new Date(dataPagamento + 'T12:00:00-03:00');
  const agendamentos = diasPorProduto[produto] || [];

  const batch = db.batch();
  for (const { dias, mensagem } of agendamentos) {
    const dataEnvio = new Date(dataBase);
    dataEnvio.setDate(dataEnvio.getDate() + dias);
    const dataEnvioStr = dataEnvio.toISOString().slice(0, 10);

    const ref = db.collection('whatsapp_agendado').doc();
    batch.set(ref, {
      email,
      nome,
      telefone,
      produto,
      mensagem,
      dataEnvio: dataEnvioStr,
      enviado:   false,
      criadoEm:  admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[posVenda] WhatsApp agendado para ${maskEmail(email)} em D+${dias} (${dataEnvioStr})`);
  }

  await batch.commit().catch(err =>
    console.error('[posVenda] Falha ao salvar WhatsApp agendado:', err.message)
  );
}

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
exports.kiwifyWebhook = onRequest({ cors: false, secrets: [...SECRETS_ALL, sKiwify, sMailerLite, sMailerLiteRaiox, sMailerLiteMapa, sMailerLiteJdd, sMailerLiteReserva] }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  // Verificação de origem Kiwify via HMAC-SHA256 — obrigatória
  // Kiwify envia: X-Kiwify-Signature = HMAC-SHA256(rawBody, secret) em hex
  const kiwifySecret = sKiwify.value();
  if (!kiwifySecret) {
    console.error('[kiwify] KIWIFY_WEBHOOK_SECRET não configurado.');
    res.status(500).json({ error: 'Server misconfigured' }); return;
  }

  const assinaturaRecebida = req.headers['x-kiwify-signature'] || req.headers['x-webhook-token'] || '';
  const crypto = require('crypto');
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));

  const assinaturaEsperada = crypto
    .createHmac('sha256', kiwifySecret)
    .update(rawBody)
    .digest('hex');

  const hmacValido  = crypto.timingSafeEqual(
    Buffer.from(assinaturaEsperada, 'hex'),
    Buffer.from(assinaturaRecebida.replace(/^sha256=/, ''), 'hex').length === 32
      ? Buffer.from(assinaturaRecebida.replace(/^sha256=/, ''), 'hex')
      : Buffer.alloc(32),
  );
  if (!hmacValido) {
    console.warn(`[kiwify] Requisição rejeitada — assinatura inválida.`);
    errors.report(new Error(`[kiwify] Tentativa com assinatura inválida`));
    res.status(401).json({ error: 'Unauthorized' }); return;
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

      console.log(`[kiwify] Cancelamento/atraso: ${maskEmail(emailCancelado)} | produto: ${nomeProdutoCancelado} | ehDashboard: ${ehDashboard}`);

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

        // Só bloqueia Auth e marca inativa se não houver dashboard ativo nem
        // conta PJ ativa (Auth é compartilhado entre PF e PJ — achado
        // 26/07/2026: cancelar produto PF não pode derrubar acesso PJ dela).
        const mantemAcesso = (temDashboardAtivo && !ehDashboard && !ehCombo) || await _temAcessoPJAtivo(mUid);
        if (!mantemAcesso) {
          await Promise.all([
            admin.auth().updateUser(mUid, { disabled: true }),
            admin.auth().revokeRefreshTokens(mUid),
          ]);
          flagsRevogados.status = 'inativa';
        }

        await mRef.update(flagsRevogados);
        const acao = mantemAcesso ? 'mentoria_encerrada_dashboard_ativo' : 'bloqueada';
        console.log(`[kiwify] ${mantemAcesso ? '🟡' : '🔴'} ${acao} — ${nomeProdutoCancelado || 'produto'} cancelado: ${maskEmail(emailCancelado)}`);
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
    let produtoCodigo    = null;
    let produtoEspecifico = null;
    if ((hasDash && hasClube) || /combo/i.test(nomeProduto)) produtoCodigo = 'combo';
    else if (/private/i.test(nomeProduto))                   produtoCodigo = 'private';
    else if (/mentoria|mentoring/i.test(nomeProduto))        produtoCodigo = 'mentoria';
    else if (hasClube)                                       produtoCodigo = 'clube';
    else if (hasDash)                                        produtoCodigo = 'dashboard';
    // Produtos de entrada — mapeados com código específico para MailerLite
    else if (/raio.?x/i.test(nomeProduto))                      { produtoCodigo = 'ebook'; produtoEspecifico = 'raiox'; }
    else if (/mapa da reserva|mapa reserva/i.test(nomeProduto)) { produtoCodigo = 'ebook'; produtoEspecifico = 'mapa'; }
    else if (/jornada domine|jdd/i.test(nomeProduto))           { produtoCodigo = 'curso'; produtoEspecifico = 'jdd'; }
    else if (/reserva que rende/i.test(nomeProduto))            { produtoCodigo = 'curso'; produtoEspecifico = 'reserva_rende'; }
    else if (/curso|course/i.test(nomeProduto))                  produtoCodigo = 'curso';
    else if (/ebook|e-book|livro digital/i.test(nomeProduto))    produtoCodigo = 'ebook';

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
      dashboard: { min: 60,   max: 1000  },  // R$67/mês ou R$670/ano standalone (atualizado 17/07/2026)
      clube:     { min: 50,   max: 200   },  // legado — fundadoras R$67
      combo:     { min: 60,   max: 1000  },  // R$97/mês ou R$970/ano com Clube (atualizado 17/07/2026)
      curso:     { min: 97,   max: 997   },  // produtos de entrada
      ebook:     { min: 9,    max: 97    },  // ebook / material digital
    };
    const rangeValor = produtoCodigo ? RANGES_VALOR[produtoCodigo] : null;
    if (rangeValor && (valorRecebido < rangeValor.min || valorRecebido > rangeValor.max)) {
      console.warn(`[kiwify] ⚠️ Valor suspeito para "${produtoCodigo}": R$${valorRecebido} (bruto: ${valorBruto}). Verificar unidade no payload.`);
    }

    const dataPagamento = new Date().toISOString().slice(0, 10);

    console.log(`[kiwify] Evento: ${event} | E-mail: ${maskEmail(email)} | Produto: ${nomeProduto} (${produtoCodigo}) | Valor: R$${valorRecebido}`);

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
        console.warn(`[kiwify] Auto-criação impossível — nome ausente para: ${maskEmail(email)}`);
        res.status(200).json({ ok: false, msg: 'Mentorada não encontrada e nome ausente no payload.' });
        return;
      }

      // Protege conta admin de ser recriada via webhook
      if (email.toLowerCase() === ADMIN_MASTER_EMAIL.toLowerCase()) {
        console.error(`[kiwify] Tentativa de auto-criação bloqueada para e-mail admin.`);
        errors.report(new Error('[kiwify] Tentativa de auto-criação com e-mail admin'));
        res.status(200).json({ ok: false, msg: 'Operação não permitida.' });
        return;
      }

      console.log(`[kiwify] 🆕 Auto-criando mentorada: (${maskEmail(email)})`);

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
      // Detecta anual pelo valor: >= R$500 após conversão de centavos = plano anual
      if (['dashboard', 'clube', 'combo'].includes(produtoCodigo)) {
        const ehAnual = valorRecebido >= 500;
        const exp = new Date();
        if (ehAnual) exp.setFullYear(exp.getFullYear() + 1);
        else         exp.setMonth(exp.getMonth() + 1);
        flagsNovaM.dataExpiracao = exp.toISOString().slice(0, 10);
        console.log(`[kiwify] dataExpiracao nova mentorada: ${ehAnual ? 'anual' : 'mensal'} → ${flagsNovaM.dataExpiracao} (R$${valorRecebido})`);
      }

      // Raio-X: degustação de 30 dias no módulo Orçamento — pagamento único, sem
      // assinatura recorrente. Expira sozinho via verificarExpiracoes (mesmo cron
      // que já bloqueia dashboard/clube vencidos), a menos que a cliente assine o
      // Dashboard completo depois (assinaturaDashboard: true passa a manter acesso).
      if (produtoEspecifico === 'raiox') {
        const exp = new Date();
        exp.setDate(exp.getDate() + 30);
        flagsNovaM.dataExpiracao = exp.toISOString().slice(0, 10);
        flagsNovaM.nivelAcesso   = 'raio-x'; // gate de UI: só módulo Orçamento liberado
        console.log(`[kiwify] dataExpiracao nova mentorada (degustação Raio-X, 30 dias) → ${flagsNovaM.dataExpiracao}`);
      }

      // 4. Documento Firestore
      await db.collection('mentoradas').doc(novoUid).set({
        nome:              nomeCliente,
        email,
        produto:           produtoParaFS,
        produtoEspecifico: produtoEspecifico || null,
        valorMensal:       valorRecebido || 0,
        formaPagamento:    'kiwify',
        inicio:            new Date().toISOString().slice(0, 7),
        sheetId,
        criadoViaKiwify:   true,
        criadoEm:          admin.firestore.FieldValue.serverTimestamp(),
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
        const link = await admin.auth().generatePasswordResetLink(email, {
          url: 'https://dashboard.flaviaschusciman.com/login.html',
        });
        const contextoBoasVindas = produtoEspecifico === 'raiox' ? 'raio-x' : 'mentoria';
        const assuntoBoasVindas  = contextoBoasVindas === 'raio-x'
          ? 'Bem-vinda ao seu Raio-X Financeiro'
          : 'Bem-vinda ao Trilogia Dashboard';
        await sendEmail({ to: email, subject: assuntoBoasVindas, html: emailBoasVindas(nomeCliente, contextoBoasVindas) });
      } catch (err) {
        console.error(`[kiwify] Falha no e-mail de boas-vindas para ${maskEmail(email)}:`, err.message);
      }

      console.log(`[kiwify] ✅ Mentorada criada via compra Kiwify (uid: ${novoUid})`);

      // Esteira pós-venda para produtos de entrada (ebook / curso)
      const telefoneNovo = (
        body.Customer?.mobile_phone || body.Customer?.phone ||
        data?.customer?.phone || ''
      ).replace(/\D/g, '');
      acionarEsteiraPosVenda({
        email, nome: nomeCliente, telefone: telefoneNovo,
        produto: produtoCodigo, produtoEspecifico, dataPagamento,
      }).catch(err => console.error('[kiwify] Erro na esteira pós-venda (nova):', err.message));

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
        console.log(`[kiwify] ✅ Acesso reativado (${produtoCodigo}): ${maskEmail(email)}`);
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

    console.log(`[kiwify] ✅ Pagamento registrado: ${maskEmail(email)} | cobrança ${alvo.id} | R$${valorRecebido || alvo.valor}`);

    // Esteira pós-venda para produtos de entrada (ebook / curso) — mentorada existente
    const telefoneMent = (() => {
      const mDoc = mentSnap.docs[0]?.data();
      return (mDoc?.telefone || '').replace(/\D/g, '');
    })();
    const nomeMent = mentSnap.docs[0]?.data()?.nome || '';
    acionarEsteiraPosVenda({
      email, nome: nomeMent, telefone: telefoneMent,
      produto: produtoCodigo, produtoEspecifico, dataPagamento,
    }).catch(err => console.error('[kiwify] Erro na esteira pós-venda (existente):', err.message));

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
  if (await jaExecutouHoje('notifCobrancasDia')) return;
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
  await marcarEnviado('notifCobrancasDia');
});

// ─── IMPOSTOS PREVISTOS (admin.html) ──────────────────────────────────────────
// Provisionamento de tributos a partir do valor de notas fiscais emitidas
// (23/07/2026, Flávia: hoje controla isso numa planilha à parte, quer trazer
// pra dentro do Financeiro do admin). Duas peças cadastráveis:
//   - tributosConfig: as regras (nome, tipo 'percentual'|'fixo', percentual OU
//     valorFixo, dia de vencimento, defasagem em meses entre a competência e o
//     vencimento). Cadastrada uma vez, revisada com a contadora.
//   - notasEmitidas: lançamento manual de cada nota emitida (valor + competência).
// Toda vez que uma nota é salva/removida, os tributos 'percentual' da mesma
// competência são recalculados automaticamente sobre a SOMA das notas do mês
// (impostosPrevistos, origem:'auto'). Os 'fixo' (ex: IRPJ/CSLL de Lucro
// Presumido, que não é % direto sobre a nota) são criados uma vez por
// competência com o valor padrão da config, mas se a usuária editar o valor
// manualmente (editarValorImpostoPrevisto) ele vira origem:'manual' e para de
// ser sobrescrito nas próximas regerações — mesma lógica pra qualquer linha já
// marcada como paga, nunca mexe de novo.

/** Converte competência (mes/ano) + regra (dia, defasagem) em data de vencimento ISO. */
function _competenciaParaVencimento(mes, ano, dia, defasagemMeses) {
  let m = mes + (defasagemMeses || 0);
  let a = ano;
  while (m > 12) { m -= 12; a++; }
  while (m < 1)  { m += 12; a--; }
  const ultimoDiaMes = new Date(a, m, 0).getDate();
  const diaFinal = Math.min(dia, ultimoDiaMes);
  return `${a}-${String(m).padStart(2, '0')}-${String(diaFinal).padStart(2, '0')}`;
}

/**
 * Último dia útil (seg-sex, sem feriados) de um mês — usado pro vencimento
 * de DARF trimestral (IRPJ/CSLL Lucro Presumido), que a Receita define como
 * "último dia útil do mês seguinte ao trimestre". Não considera feriados
 * nacionais/municipais (só fins de semana) — ajuste manual na tela se cair
 * num feriado (achado 23/07/2026, pedido da Flávia pra separar tributos
 * mensais dos trimestrais em vez de provisionar tudo por mês).
 */
function _ultimoDiaUtilISO(ano, mes) {
  const d = new Date(ano, mes, 0); // dia 0 do mês seguinte = último dia do mês atual
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1); // domingo=0, sábado=6
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Trimestre (1-4) de um mês, e o mês/ano de vencimento (mês seguinte ao trimestre). */
function _trimestreDoMes(mes) { return Math.ceil(mes / 3); }
function _mesesDoTrimestre(trimestre) { return [trimestre * 3 - 2, trimestre * 3 - 1, trimestre * 3]; }
function _vencimentoTrimestral(ultimoMesTrimestre, ano) {
  let m = ultimoMesTrimestre + 1, a = ano;
  if (m > 12) { m = 1; a++; }
  return _ultimoDiaUtilISO(a, m);
}

// Retrofit 24/07/2026 (auditoria de segurança, item 1 do plano de ação): as
// 3 coleções deste módulo ganharam campo `uid` pra segregar por conta —
// pré-requisito pro Dashboard PJ, que vai expor essas mesmas funções a
// contas de mentoradas, não só à Flávia via admin. Toda leitura/escrita
// abaixo agora filtra/grava por uid; sem isso, uma conta enxergaria dado da
// outra (Firestore rules não protegem essas coleções — o client nunca
// acessa Firestore direto neste projeto, a segurança é 100% nos guards
// destas Cloud Functions).
async function _regerarImpostosPrevistos(uid, mes, ano) {
  const tributosSnap = await db.collection('tributosConfig')
    .where('uid', '==', uid).where('ativo', '==', true).get();
  const tributos = tributosSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!tributos.length) return;

  // Linha mensal — TODO tributo (mensal ou trimestral) continua gerando sua
  // provisão de referência sobre a nota do próprio mês, sem mudança nenhuma
  // (pedido explícito da Flávia, achado 23/07/2026: quer manter os valores
  // mensais de todos, com somatório, e ADICIONAR a provisão trimestral —
  // não substituir).
  const notasSnap  = await db.collection('notasEmitidas')
    .where('uid', '==', uid).where('mes', '==', mes).where('ano', '==', ano).get();
  const totalNotas = notasSnap.docs.reduce((s, d) => s + (d.data().valor || 0), 0);

  const existentesSnap = await db.collection('impostosPrevistos')
    .where('uid', '==', uid).where('mes', '==', mes).where('ano', '==', ano).get();
  const existentesPorTributo = {};
  existentesSnap.docs.forEach(d => { existentesPorTributo[d.data().tributoId] = { id: d.id, ...d.data() }; });

  const batch = db.batch();
  // Anual (ex: TFE) não tem "competência" mensal — não depende de notas, não
  // entra nesse loop (ver _regerarTributoAnual, disparado só quando o
  // tributo é salvo/editado, achado 25/07/2026: TFE é valor fixo pago 1x por
  // ano, sem relação com o mês em que uma nota foi emitida).
  for (const trib of tributos.filter(t => t.periodicidade !== 'anual')) {
    const existente = existentesPorTributo[trib.id];
    if (existente?.pago) continue; // já paga — nunca recalcula
    if (trib.tipo === 'fixo' && existente?.origem === 'manual') continue; // valor já ajustado à mão

    const vencimento = _competenciaParaVencimento(mes, ano, trib.diaVencimento, trib.defasagemMeses);
    const valor = trib.tipo === 'percentual'
      ? Math.round(totalNotas * (trib.percentual / 100) * 100) / 100
      : (trib.valorFixo || 0);

    const ref = existente
      ? db.collection('impostosPrevistos').doc(existente.id)
      : db.collection('impostosPrevistos').doc();
    // referenciaTrimestral: true nos tributos 'trimestral' (IRPJ/CSLL) marca
    // que essa linha MENSAL é só informativa (mostra quanto seria sobre a
    // nota do mês) — quem é pago de verdade é a linha trimestral acumulada
    // em _regerarProvisaoTrimestral. Sem isso o KPI de total previsto/a
    // pagar soma a mesma competência duas vezes (achado 24/07/2026, Flávia:
    // "o valor do tri está sendo somado, não é pra somar").
    batch.set(ref, {
      uid, tributoId: trib.id, tributoNome: trib.nome, tipo: trib.tipo,
      mes, ano, vencimento, valor, pago: false, origem: 'auto',
      referenciaTrimestral: trib.periodicidade === 'trimestral',
    }, { merge: true });
  }
  await batch.commit();

  // Linha trimestral extra — só pros tributos marcados periodicidade:'trimestral'
  // (IRPJ/CSLL Lucro Presumido). Acumula as notas dos 3 meses do trimestre e
  // gera UMA linha adicional, com vencimento no último dia útil do mês
  // seguinte ao trimestre — ao lado das 3 linhas mensais de referência que
  // continuam existindo normalmente.
  const trimestrais = tributos.filter(t => t.periodicidade === 'trimestral');
  if (trimestrais.length) {
    await _regerarProvisaoTrimestral(uid, trimestrais, _trimestreDoMes(mes), ano);
  }
}

async function _regerarProvisaoTrimestral(uid, trimestrais, trimestre, ano) {
  const meses = _mesesDoTrimestre(trimestre);
  const ultimoMes = meses[2];

  // Soma as notas dos 3 meses do trimestre — busca por uid+ano (equality-only,
  // não exige índice composto novo) e filtra "mes" em memória, pra não
  // precisar de mais um índice composto.
  const notasSnap = await db.collection('notasEmitidas').where('uid', '==', uid).where('ano', '==', ano).get();
  const totalNotasTrimestre = notasSnap.docs.reduce((s, d) => {
    const data = d.data();
    return meses.includes(data.mes) ? s + (data.valor || 0) : s;
  }, 0);

  // Guarda a linha trimestral no mês final do trimestre, com uma chave de
  // tributoId virtual ("<id>_tri") pra não colidir com a linha mensal do
  // mesmo tributo nesse mesmo mês (ex: setembro tem a linha mensal normal
  // de IRPJ + a linha trimestral acumulada do 3º tri, lado a lado).
  const existentesSnap = await db.collection('impostosPrevistos')
    .where('uid', '==', uid).where('mes', '==', ultimoMes).where('ano', '==', ano).get();
  const existentesPorChave = {};
  existentesSnap.docs.forEach(d => {
    const data = d.data();
    if (data.trimestre === trimestre) existentesPorChave[data.tributoId] = { id: d.id, ...data };
  });

  const vencimento = _vencimentoTrimestral(ultimoMes, ano);
  const batch = db.batch();
  for (const trib of trimestrais) {
    const chave = `${trib.id}_tri`;
    const existente = existentesPorChave[chave];
    if (existente?.pago) continue;
    if (trib.tipo === 'fixo' && existente?.origem === 'manual') continue;

    const valor = trib.tipo === 'percentual'
      ? Math.round(totalNotasTrimestre * (trib.percentual / 100) * 100) / 100
      : (trib.valorFixo || 0);

    const ref = existente
      ? db.collection('impostosPrevistos').doc(existente.id)
      : db.collection('impostosPrevistos').doc();
    batch.set(ref, {
      uid, tributoId: chave, tributoNome: `${trib.nome} — ${trimestre}º tri/${ano} acumulado`,
      tipo: trib.tipo, mes: ultimoMes, ano, trimestre, vencimento, valor,
      pago: false, origem: 'auto',
    }, { merge: true });
  }
  await batch.commit();
}

// Anual (ex: TFE — Taxa de Fiscalização de Estabelecimentos): valor fixo
// pago 1x por ano, no mês configurado (mesVencimento) — não depende de
// notas emitidas, então não é disparado pelo fluxo de save/delete de nota
// como mensal/trimestral; é gerado aqui, chamado direto no save do próprio
// tributo, sempre pro ano corrente (achado 25/07/2026, Flávia: TFE é anual,
// periodicidade não suportava isso ainda).
async function _regerarTributoAnual(uid, trib, ano) {
  const vencimento = _competenciaParaVencimento(trib.mesVencimento, ano, trib.diaVencimento, 0);
  const existentesSnap = await db.collection('impostosPrevistos')
    .where('uid', '==', uid).where('tributoId', '==', trib.id).where('ano', '==', ano).get();
  const existente = existentesSnap.docs[0];
  if (existente?.data().pago) return; // já paga — nunca recalcula
  if (existente?.data().origem === 'manual') return; // valor já ajustado à mão

  const ref = existente ? existente.ref : db.collection('impostosPrevistos').doc();
  await ref.set({
    uid, tributoId: trib.id, tributoNome: trib.nome, tipo: 'fixo',
    mes: trib.mesVencimento, ano, vencimento, valor: trib.valorFixo || 0,
    pago: false, origem: 'auto',
  }, { merge: true });
}

exports.getTributosConfig = onCall({}, async (request) => {
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);
  const snap = await db.collection('tributosConfig').where('uid', '==', uid).get();
  // orderBy('ordem') tirado da query (evitaria precisar de índice composto
  // uid+ordem) — ordena em memória, coleção pequena por conta.
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
});

exports.saveTributoConfig = onCall({}, async (request) => {
  const { uid, id, nome, tipo, percentual, valorFixo, diaVencimento, defasagemMeses, mesVencimento, ativo, periodicidade } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!nome || typeof nome !== 'string' || !nome.trim())
    throw new HttpsError('invalid-argument', 'nome é obrigatório.');
  if (tipo !== 'percentual' && tipo !== 'fixo')
    throw new HttpsError('invalid-argument', "tipo deve ser 'percentual' ou 'fixo'.");
  if (tipo === 'percentual' && (typeof percentual !== 'number' || percentual < 0 || percentual > 100))
    throw new HttpsError('invalid-argument', 'percentual deve ser um número entre 0 e 100.');
  if (tipo === 'fixo' && (typeof valorFixo !== 'number' || valorFixo < 0))
    throw new HttpsError('invalid-argument', 'valorFixo deve ser um número não-negativo.');
  const dia = Number(diaVencimento);
  if (!Number.isInteger(dia) || dia < 1 || dia > 28)
    throw new HttpsError('invalid-argument', 'diaVencimento deve ser um inteiro entre 1 e 28.');
  const defasagem = Number.isInteger(defasagemMeses) ? defasagemMeses : 0;
  // 'trimestral' (ex: IRPJ/CSLL Lucro Presumido) gera, além da linha mensal
  // de referência de sempre, uma linha extra acumulando as notas dos 3
  // meses do trimestre — ver _regerarProvisaoTrimestral (achado 23/07/2026).
  // 'anual' (ex: TFE) é valor fixo pago 1x por ano — não depende de notas,
  // não tem "competência" mensal, então exige tipo:'fixo' e um mês de
  // vencimento direto em vez de defasagem (achado 25/07/2026).
  if (periodicidade !== 'mensal' && periodicidade !== 'trimestral' && periodicidade !== 'anual')
    throw new HttpsError('invalid-argument', "periodicidade deve ser 'mensal', 'trimestral' ou 'anual'.");
  if (periodicidade === 'anual' && tipo !== 'fixo')
    throw new HttpsError('invalid-argument', "tributo anual só pode ser tipo 'fixo' (não calcula sobre notas).");
  const mesVenc = Number(mesVencimento);
  if (periodicidade === 'anual' && (!Number.isInteger(mesVenc) || mesVenc < 1 || mesVenc > 12))
    throw new HttpsError('invalid-argument', 'mesVencimento deve ser um inteiro entre 1 e 12.');

  const dados = {
    nome: nome.trim().slice(0, 100),
    tipo,
    percentual: tipo === 'percentual' ? percentual : null,
    valorFixo: tipo === 'fixo' ? valorFixo : null,
    diaVencimento: dia,
    defasagemMeses: defasagem,
    periodicidade,
    mesVencimento: periodicidade === 'anual' ? mesVenc : null,
    ativo: ativo !== false,
  };

  let tributoId = id;
  if (id) {
    const ref  = db.collection('tributosConfig').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Tributo não encontrado.');
    if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
    await ref.update(dados);
  } else {
    const countSnap = await db.collection('tributosConfig').where('uid', '==', uid).get();
    dados.uid = uid;
    dados.ordem = countSnap.size;
    const ref = await db.collection('tributosConfig').add(dados);
    tributoId = ref.id;
  }

  if (periodicidade === 'anual' && dados.ativo) {
    await _regerarTributoAnual(uid, { ...dados, id: tributoId }, new Date().getFullYear());
  }

  return { id: tributoId, ok: true };
});

exports.deleteTributoConfig = onCall({}, async (request) => {
  const { uid, id } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');
  const ref  = db.collection('tributosConfig').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Tributo não encontrado.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
  await ref.delete();
  return { ok: true };
});

exports.getNotasEmitidas = onCall({}, async (request) => {
  const { uid, mes, ano } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!mes || !ano) throw new HttpsError('invalid-argument', 'mes e ano são obrigatórios.');
  const snap = await db.collection('notasEmitidas')
    .where('uid', '==', uid).where('mes', '==', mes).where('ano', '==', ano).orderBy('dataEmissao').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
});

// Sugestão de prazo (dias) até o dinheiro cair, por forma de pagamento —
// achado 26/07/2026 (Flávia, CFP): PIX/dinheiro caem na hora e sem taxa, mas
// débito/crédito têm prazo de liquidação da adquirente E taxa descontada,
// mesmo em pagamento único. Só um ponto de partida, sempre editável depois
// (ver salvarRecebimento/_notaDoUid mais abaixo).
const SUGESTAO_PRAZO_DIAS = { pix: 0, dinheiro: 0, debito: 2, credito_avista: 30, credito_parcelado: 30, boleto: 3, outro: 0 };
const FORMAS_PAGAMENTO = Object.keys(SUGESTAO_PRAZO_DIAS);

function _somarDiasISO(iso, dias) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Gera os recebimentos iniciais de uma nota nova, a partir só de forma de
 * pagamento (+ nº de parcelas quando for crédito parcelado) — achado
 * 27/07/2026 (Flávia: cadastrar parcela por parcela na mão é trabalhoso).
 * Faz o split automático (valor e taxa divididos igualmente entre as
 * parcelas, resto na última pra fechar o total certinho) com datas espaçadas
 * de 30 em 30 dias a partir do prazo sugerido da forma de pagamento. É só um
 * ponto de partida: cada parcela continua editável individualmente depois
 * (salvarRecebimento) se a divisão real não for exatamente igual.
 */
function _gerarRecebimentosIniciais(valor, dataEmissao, formaPagamento, numeroParcelas, taxaTotal) {
  const n = formaPagamento === 'credito_parcelado'
    ? Math.max(2, Math.min(24, Number.isInteger(numeroParcelas) ? numeroParcelas : 2))
    : 1;
  const prazoBase   = SUGESTAO_PRAZO_DIAS[formaPagamento] ?? 0;
  const valorCents  = Math.round(valor * 100);
  const taxaCents   = Math.round((taxaTotal || 0) * 100);
  const baseValor   = Math.floor(valorCents / n);
  const baseTaxa    = Math.floor(taxaCents / n);

  const recebimentos = [];
  for (let i = 0; i < n; i++) {
    const ultima     = i === n - 1;
    const vBrutoCents = ultima ? valorCents - baseValor * (n - 1) : baseValor;
    const vTaxaCents  = ultima ? taxaCents  - baseTaxa  * (n - 1) : baseTaxa;
    const dias = formaPagamento === 'credito_parcelado' ? prazoBase + 30 * i : prazoBase;
    recebimentos.push({
      formaPagamento,
      valorBruto:    vBrutoCents / 100,
      taxa:          vTaxaCents / 100,
      valorLiquido: (vBrutoCents - vTaxaCents) / 100,
      dataPrevista:  _somarDiasISO(dataEmissao, dias),
      dataRecebimento: null,
      parcelaAtual: n > 1 ? i + 1 : null,
      parcelaTotal: n > 1 ? n : null,
    });
  }
  return recebimentos;
}

exports.saveNotaEmitida = onCall({}, async (request) => {
  const { uid, id, valor, mes, ano, dataEmissao, formaPagamento, numeroParcelas, taxaTotal } = request.data;
  requireSelfOrAdmin(request, uid);
  if (typeof valor !== 'number' || valor <= 0) throw new HttpsError('invalid-argument', 'valor deve ser maior que zero.');
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw new HttpsError('invalid-argument', 'mes inválido.');
  if (!Number.isInteger(ano) || ano < 2020 || ano > 2100) throw new HttpsError('invalid-argument', 'ano inválido.');
  if (dataEmissao && !/^\d{4}-\d{2}-\d{2}$/.test(dataEmissao))
    throw new HttpsError('invalid-argument', 'dataEmissao deve estar no formato YYYY-MM-DD.');
  // formaPagamento só é usado na criação (gera os recebimentos iniciais);
  // numa edição de nota existente, os recebimentos já lançados não são
  // regerados/apagados — evita sobrescrever confirmações já feitas.
  const forma = id ? null : (formaPagamento || 'pix');
  if (forma && !FORMAS_PAGAMENTO.includes(forma))
    throw new HttpsError('invalid-argument', `formaPagamento deve ser uma de: ${FORMAS_PAGAMENTO.join(', ')}.`);

  const dados = { valor, mes, ano, dataEmissao: dataEmissao || new Date().toISOString().slice(0, 10) };
  let notaId = id;
  if (id) {
    const ref  = db.collection('notasEmitidas').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Nota não encontrada.');
    if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
    await ref.update(dados);
  } else {
    const ref = await db.collection('notasEmitidas')
      .add({ ...dados, uid, criadoEm: admin.firestore.FieldValue.serverTimestamp() });
    notaId = ref.id;
    const recebimentos = _gerarRecebimentosIniciais(valor, dados.dataEmissao, forma, numeroParcelas, taxaTotal);
    const batch = db.batch();
    recebimentos.forEach(r => {
      batch.set(ref.collection('recebimentos').doc(), {
        uid, ...r, dataEmissaoNota: dados.dataEmissao,
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
  }
  await _regerarImpostosPrevistos(uid, mes, ano);
  return { id: notaId, ok: true };
});

exports.deleteNotaEmitida = onCall({}, async (request) => {
  const { uid, id } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');
  const ref  = db.collection('notasEmitidas').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Nota não encontrada.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
  const { mes, ano } = snap.data();
  // Firestore não apaga subcoleção junto do documento pai — limpa os
  // recebimentos manualmente antes de excluir a nota.
  const recebSnap = await ref.collection('recebimentos').get();
  if (!recebSnap.empty) {
    const batchDel = db.batch();
    recebSnap.docs.forEach(d => batchDel.delete(d.ref));
    await batchDel.commit();
  }
  await ref.delete();
  await _regerarImpostosPrevistos(uid, mes, ano);
  return { ok: true };
});

// ─── Contas a Receber (recebimentos de notasEmitidas) ─────────────────────────
// Achado 26/07/2026 (Flávia, CFP): nota emitida é o valor faturado (regime de
// competência, usado na DRE — fatia futura). O que efetivamente cai no caixa
// é outra coisa: PIX/dinheiro caem na hora e sem desconto, mas débito,
// crédito à vista e crédito parcelado têm prazo de liquidação da adquirente E
// uma taxa descontada — isso vale mesmo pra pagamento único, não só parcelado.
// Por isso cada nota tem uma subcoleção de recebimentos (não um campo único):
// cada um com sua forma de pagamento, valor bruto, taxa (a usuária digita o
// que sabe que foi descontado — sem tentar automatizar tabela de adquirente),
// valor líquido calculado, data prevista (sugerida pela forma de pagamento,
// sempre editável) e data em que confirmou que caiu de verdade.
// (SUGESTAO_PRAZO_DIAS/FORMAS_PAGAMENTO ficam declarados mais acima, perto de
// saveNotaEmitida, que também precisa deles pra gerar as parcelas iniciais.)

async function _notaDoUid(uid, notaId) {
  const ref  = db.collection('notasEmitidas').doc(notaId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Nota não encontrada.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
  return { ref, dataEmissao: snap.data().dataEmissao };
}

exports.getRecebimentosNota = onCall({}, async (request) => {
  const { uid, notaId } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!notaId) throw new HttpsError('invalid-argument', 'notaId é obrigatório.');
  const { ref: notaRef } = await _notaDoUid(uid, notaId);
  const snap = await notaRef.collection('recebimentos').orderBy('dataPrevista').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
});

exports.salvarRecebimento = onCall({}, async (request) => {
  const { uid, notaId, id, formaPagamento, valorBruto, taxa, dataPrevista, parcelaAtual, parcelaTotal } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!notaId) throw new HttpsError('invalid-argument', 'notaId é obrigatório.');
  if (!FORMAS_PAGAMENTO.includes(formaPagamento))
    throw new HttpsError('invalid-argument', `formaPagamento deve ser uma de: ${FORMAS_PAGAMENTO.join(', ')}.`);
  if (typeof valorBruto !== 'number' || valorBruto <= 0)
    throw new HttpsError('invalid-argument', 'valorBruto deve ser maior que zero.');
  const taxaNum = typeof taxa === 'number' && taxa >= 0 ? taxa : 0;
  if (taxaNum > valorBruto) throw new HttpsError('invalid-argument', 'taxa não pode ser maior que o valor bruto.');
  if (!dataPrevista || !/^\d{4}-\d{2}-\d{2}$/.test(dataPrevista))
    throw new HttpsError('invalid-argument', 'dataPrevista deve estar no formato YYYY-MM-DD.');

  const { ref: notaRef, dataEmissao: dataEmissaoNota } = await _notaDoUid(uid, notaId);
  const col = notaRef.collection('recebimentos');
  const dados = {
    uid, formaPagamento, valorBruto, taxa: taxaNum,
    valorLiquido: Math.round((valorBruto - taxaNum) * 100) / 100,
    dataPrevista,
    parcelaAtual: Number.isInteger(parcelaAtual) ? parcelaAtual : null,
    parcelaTotal: Number.isInteger(parcelaTotal) ? parcelaTotal : null,
  };

  let recebimentoId = id;
  if (id) {
    const ref  = col.doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Recebimento não encontrado.');
    if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
    await ref.update(dados);
  } else {
    // dataEmissaoNota denormalizado aqui só pra _calcularPMR não precisar de
    // N+1 leituras (uma por recebimento) pra achar a competência da nota mãe
    // — fica um pouco desatualizado se a nota mudar de dataEmissao depois de
    // já ter recebimento (raro, e PMR é só sugestão, não trava nada).
    const ref = await col.add({ ...dados, dataEmissaoNota, dataRecebimento: null, criadoEm: admin.firestore.FieldValue.serverTimestamp() });
    recebimentoId = ref.id;
  }
  return { id: recebimentoId, ok: true };
});

/**
 * Gera N recebimentos de crédito parcelado de uma vez pra uma nota já
 * existente — achado 27/07/2026, Flávia: cadastrar parcela por parcela na
 * mão em "+ Adicionar recebimento" é impraticável. Reaproveita o mesmo split
 * automático (valor/taxa divididos, resto na última, datas de 30 em 30 dias)
 * já usado em saveNotaEmitida quando a forma é escolhida na criação da nota;
 * aqui serve pra quando a nota já foi criada (ex: como PIX por engano) e a
 * usuária precisa registrar que na verdade foi parcelado. Soma-se aos
 * recebimentos que já existem — não apaga nada; a usuária exclui manualmente
 * o que não fizer mais sentido (ex: o PIX default gerado na criação).
 */
exports.gerarParcelasRecebimento = onCall({}, async (request) => {
  const { uid, notaId, valorTotal, numeroParcelas, taxaTotal, dataBase } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!notaId) throw new HttpsError('invalid-argument', 'notaId é obrigatório.');
  if (typeof valorTotal !== 'number' || valorTotal <= 0)
    throw new HttpsError('invalid-argument', 'valorTotal deve ser maior que zero.');
  const taxaNum = typeof taxaTotal === 'number' && taxaTotal >= 0 ? taxaTotal : 0;
  if (taxaNum > valorTotal) throw new HttpsError('invalid-argument', 'taxaTotal não pode ser maior que valorTotal.');
  if (!dataBase || !/^\d{4}-\d{2}-\d{2}$/.test(dataBase))
    throw new HttpsError('invalid-argument', 'dataBase deve estar no formato YYYY-MM-DD.');

  const { ref: notaRef } = await _notaDoUid(uid, notaId);
  const recebimentos = _gerarRecebimentosIniciais(valorTotal, dataBase, 'credito_parcelado', numeroParcelas, taxaNum);
  const batch = db.batch();
  recebimentos.forEach(r => {
    batch.set(notaRef.collection('recebimentos').doc(), {
      uid, ...r, dataEmissaoNota: dataBase, criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  return { ok: true, quantidade: recebimentos.length };
});

exports.confirmarRecebimento = onCall({}, async (request) => {
  const { uid, notaId, id, dataRecebimento } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!notaId || !id) throw new HttpsError('invalid-argument', 'notaId e id são obrigatórios.');
  if (!dataRecebimento || !/^\d{4}-\d{2}-\d{2}$/.test(dataRecebimento))
    throw new HttpsError('invalid-argument', 'dataRecebimento deve estar no formato YYYY-MM-DD.');
  const { ref: notaRef } = await _notaDoUid(uid, notaId);
  const ref  = notaRef.collection('recebimentos').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Recebimento não encontrado.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
  await ref.update({ dataRecebimento });
  return { ok: true };
});

exports.estornarRecebimento = onCall({}, async (request) => {
  const { uid, notaId, id } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!notaId || !id) throw new HttpsError('invalid-argument', 'notaId e id são obrigatórios.');
  const { ref: notaRef } = await _notaDoUid(uid, notaId);
  const ref  = notaRef.collection('recebimentos').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Recebimento não encontrado.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
  await ref.update({ dataRecebimento: null });
  return { ok: true };
});

exports.deleteRecebimento = onCall({}, async (request) => {
  const { uid, notaId, id } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!notaId || !id) throw new HttpsError('invalid-argument', 'notaId e id são obrigatórios.');
  const { ref: notaRef } = await _notaDoUid(uid, notaId);
  const ref  = notaRef.collection('recebimentos').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Recebimento não encontrado.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
  await ref.delete();
  return { ok: true };
});

// ─── Despesas PJ (fatia 2) ─────────────────────────────────────────────────
// Schema deliberadamente mais simples que `recorrentes` do PF (que tem
// cartão, parcelamento, frequência semanal/quinzenal) — despesa fixa mensal
// só, mesmo espírito de `tributosConfig`. Se virar demanda real, é retrofit
// futuro, não construído agora (ver .build-scope.md).
exports.getDespesasPJ = onCall({}, async (request) => {
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);
  const snap = await db.collection('despesasPJ').where('uid', '==', uid).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
});

exports.saveDespesaPJ = onCall({}, async (request) => {
  const { uid, id, nome, valor, diaVencimento, data, tipo, categoria, ativo } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!nome || typeof nome !== 'string' || !nome.trim())
    throw new HttpsError('invalid-argument', 'nome é obrigatório.');
  if (typeof valor !== 'number' || valor < 0)
    throw new HttpsError('invalid-argument', 'valor deve ser um número não-negativo.');
  // tipo 'fixa' (default, retrocompatível) recorre todo mês no diaVencimento;
  // 'unica' é lançamento avulso numa data específica, não repete — achado
  // 27/07/2026, Flávia: nem toda despesa é recorrente/fixa (ex: comprou um
  // notebook uma vez só).
  const tipoDespesa = tipo === 'unica' ? 'unica' : 'fixa';
  const dados = {
    nome: nome.trim().slice(0, 150),
    valor,
    tipo: tipoDespesa,
    categoria: categoria ? String(categoria).trim().slice(0, 100) : null,
    ativo: ativo !== false,
  };
  if (tipoDespesa === 'unica') {
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data))
      throw new HttpsError('invalid-argument', 'data deve estar no formato YYYY-MM-DD.');
    dados.data = data;
    dados.diaVencimento = null;
  } else {
    const dia = Number(diaVencimento);
    if (!Number.isInteger(dia) || dia < 1 || dia > 28)
      throw new HttpsError('invalid-argument', 'diaVencimento deve ser um inteiro entre 1 e 28.');
    dados.diaVencimento = dia;
    dados.data = null;
  }

  let despesaId = id;
  if (id) {
    const ref  = db.collection('despesasPJ').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Despesa não encontrada.');
    if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
    await ref.update(dados);
  } else {
    const countSnap = await db.collection('despesasPJ').where('uid', '==', uid).get();
    dados.uid = uid;
    dados.ordem = countSnap.size;
    const ref = await db.collection('despesasPJ').add(dados);
    despesaId = ref.id;
  }
  return { id: despesaId, ok: true };
});

exports.deleteDespesaPJ = onCall({}, async (request) => {
  const { uid, id } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');
  const ref  = db.collection('despesasPJ').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Despesa não encontrada.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
  await ref.delete();
  return { ok: true };
});

// ─── Outras entradas PJ (fatia 2, achado 27/07/2026) ───────────────────────
// Nem toda entrada de caixa é venda: aporte de sócio (capital, não é
// receita) e reembolso (dinheiro que volta, não é venda) são eventos reais
// que o Fluxo de Caixa precisa refletir sem passar por nota fiscal. Categoria
// é fechada nessas duas + "outro" — NÃO existe categoria pra receita não
// declarada: isso é sonegação fiscal (Lei 8.137/90), fora de questão como
// funcionalidade suportada por este sistema.
const CATEGORIA_OUTRA_ENTRADA = ['aporte_socio', 'reembolso', 'outro'];

exports.getOutrasEntradasPJ = onCall({}, async (request) => {
  const { uid, mes, ano } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!mes || !ano) throw new HttpsError('invalid-argument', 'mes e ano são obrigatórios.');
  const snap = await db.collection('outrasEntradasPJ')
    .where('uid', '==', uid).where('mes', '==', mes).where('ano', '==', ano).orderBy('data').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
});

exports.saveOutraEntradaPJ = onCall({}, async (request) => {
  const { uid, id, descricao, valor, data, categoria } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!descricao || typeof descricao !== 'string' || !descricao.trim())
    throw new HttpsError('invalid-argument', 'descricao é obrigatória.');
  if (typeof valor !== 'number' || valor <= 0) throw new HttpsError('invalid-argument', 'valor deve ser maior que zero.');
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data))
    throw new HttpsError('invalid-argument', 'data deve estar no formato YYYY-MM-DD.');
  if (!CATEGORIA_OUTRA_ENTRADA.includes(categoria))
    throw new HttpsError('invalid-argument', `categoria deve ser uma de: ${CATEGORIA_OUTRA_ENTRADA.join(', ')}.`);

  const [ano, mes] = data.split('-').map(Number);
  const dados = { descricao: descricao.trim().slice(0, 200), valor, data, categoria, mes, ano };

  let entradaId = id;
  if (id) {
    const ref  = db.collection('outrasEntradasPJ').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Lançamento não encontrado.');
    if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
    await ref.update(dados);
  } else {
    const ref = await db.collection('outrasEntradasPJ')
      .add({ ...dados, uid, criadoEm: admin.firestore.FieldValue.serverTimestamp() });
    entradaId = ref.id;
  }
  return { id: entradaId, ok: true };
});

exports.deleteOutraEntradaPJ = onCall({}, async (request) => {
  const { uid, id } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');
  const ref  = db.collection('outrasEntradasPJ').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Lançamento não encontrado.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
  await ref.delete();
  return { ok: true };
});

exports.getImpostosPrevistos = onCall({}, async (request) => {
  const { uid, mes, ano } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!mes || !ano) throw new HttpsError('invalid-argument', 'mes e ano são obrigatórios.');

  const porId = new Map();

  // 1) Linhas da própria competência (mês pra provisionar/acompanhar) — só
  // leitura quando o vencimento cai num mês diferente da competência (o
  // caso comum: defasagemMeses>0), porque a ação de pagar só faz sentido
  // no mês do vencimento real (ver bloco 3 abaixo). referenciaTrimestral
  // (linha mensal do IRPJ/CSLL, só informativa) nunca tem ação, em
  // nenhum mês.
  const snap = await db.collection('impostosPrevistos')
    .where('uid', '==', uid).where('mes', '==', mes).where('ano', '==', ano).orderBy('vencimento').get();
  snap.docs.forEach(d => {
    const data = d.data();
    const mesVenc = Number((data.vencimento || '').slice(5, 7));
    const somenteLeitura = !!data.referenciaTrimestral || mesVenc !== mes;
    porId.set(d.id, { id: d.id, ...data, ...(somenteLeitura ? { somenteLeitura: true } : {}) });
  });

  // 2) Linha trimestral acumulada (IRPJ/CSLL) fica guardada no último mês do
  // trimestre, mas mostra em TODOS os 3 meses do trimestre — a usuária quer
  // ver o valor acumulado assim que existir, não só no mês de fechamento
  // (achado 23/07/2026). Sempre só leitura aqui — a ação de pagar só libera
  // no mês do vencimento real (bloco 3), que não é nenhum dos 3 meses do
  // trimestre (vencimento é no mês SEGUINTE ao trimestre fechar).
  const trimestre = _trimestreDoMes(mes);
  const ultimoMesTrimestre = _mesesDoTrimestre(trimestre)[2];
  if (mes !== ultimoMesTrimestre) {
    const snapTri = await db.collection('impostosPrevistos')
      .where('uid', '==', uid).where('mes', '==', ultimoMesTrimestre).where('ano', '==', ano).get();
    snapTri.docs
      .filter(d => d.data().trimestre === trimestre)
      .forEach(d => porId.set(d.id, { id: d.id, ...d.data(), somenteLeitura: true }));
  }

  // 3) Linhas cujo VENCIMENTO cai neste mês, não importa em que competência
  // foram geradas (ex: DARF de julho vence em agosto; provisão trimestral
  // de julho/agosto/setembro vence em outubro) — aqui a ação de pagar
  // libera de verdade, sobrescrevendo o somenteLeitura dos blocos acima se
  // a mesma linha também apareceu como competência/acumulado de outro mês
  // (achado 25/07/2026, Flávia: "o botão de pagamento deve aparecer
  // somente no mês de vencimento" — mais fácil baixar o boleto no mês que
  // ele realmente vence do que voltar pro mês de competência).
  // referenciaTrimestral nunca entra aqui — nunca tem ação, em mês nenhum.
  const inicioMes = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const fimMes = `${ano}-${String(mes).padStart(2, '0')}-${String(new Date(ano, mes, 0).getDate()).padStart(2, '0')}`;
  const snapVencimento = await db.collection('impostosPrevistos')
    .where('uid', '==', uid).where('vencimento', '>=', inicioMes).where('vencimento', '<=', fimMes).get();
  snapVencimento.docs.forEach(d => {
    const data = d.data();
    if (data.referenciaTrimestral) return;
    porId.set(d.id, { id: d.id, ...data });
  });

  return [...porId.values()].sort((a, b) => (a.vencimento || '').localeCompare(b.vencimento || ''));
});

exports.editarValorImpostoPrevisto = onCall({}, async (request) => {
  const { uid, id, valor } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');
  if (typeof valor !== 'number' || valor < 0) throw new HttpsError('invalid-argument', 'valor deve ser um número não-negativo.');
  const ref  = db.collection('impostosPrevistos').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Imposto previsto não encontrado.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
  // origem 'manual' pra essa linha nunca mais ser sobrescrita por uma
  // regeração automática futura (relevante pros tributos tipo 'fixo').
  await ref.update({ valor, origem: 'manual' });
  return { ok: true };
});

exports.marcarImpostoPago = onCall({}, async (request) => {
  const { uid, id, pago } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');
  const ref  = db.collection('impostosPrevistos').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Imposto previsto não encontrado.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
  const marcarPago = pago !== false;
  await ref.update({
    pago: marcarPago,
    ...(marcarPago
      ? { pagoEm: new Date().toISOString().slice(0, 10) }
      : { pagoEm: admin.firestore.FieldValue.delete() }),
  });
  return { ok: true };
});

exports.deleteImpostoPrevisto = onCall({}, async (request) => {
  const { uid, id } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!id) throw new HttpsError('invalid-argument', 'id é obrigatório.');
  const ref  = db.collection('impostosPrevistos').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Imposto previsto não encontrado.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Acesso negado.');
  await ref.delete();
  return { ok: true };
});

/**
 * Notificação diária de tributos PJ com vencimento hoje.
 * Enviada para a Flávia às 8h (horário de Brasília), mesmo horário e mesmo
 * padrão do notifCobrancasDia (pedido 24/07/2026: "quero aviso para me
 * lembrar desses vcto assim como vc fez para lembrar as cobranças").
 *
 * Retrofit 24/07/2026: escopo continua só a conta admin da Flávia (uid
 * resolvido em runtime pelo e-mail master) — vira multi-conta quando o
 * Dashboard PJ estiver no ar de verdade, cada PJ com seu próprio lembrete.
 */
exports.notifImpostosDia = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'America/Sao_Paulo', secrets: ['GMAIL_APP_PASSWORD'] },
  async () => {
  if (await jaExecutouHoje('notifImpostosDia')) return;
  const hoje = new Date().toISOString().slice(0, 10);

  const adminUser = await admin.auth().getUserByEmail(ADMIN_MASTER_EMAIL);
  const snap = await db.collection('impostosPrevistos')
    .where('uid', '==', adminUser.uid)
    .where('vencimento', '==', hoje)
    .where('pago', '==', false)
    .get();

  if (snap.empty) return;

  // Exclui as linhas mensais de referência dos tributos trimestrais — o
  // vencimento delas não é um prazo de pagamento real (só a linha
  // trimestral acumulada é paga de fato), avisar dessa data confundiria.
  const impostos = snap.docs.map(d => d.data()).filter(i => !i.referenciaTrimestral);
  if (!impostos.length) return;

  await sendEmail({
    to:      ADMIN_EMAIL,
    subject: `Tributos de hoje — ${hoje}`,
    html:    emailImpostosDia(impostos),
  });
  await marcarEnviado('notifImpostosDia');
});

// ─── DASHBOARD PJ (fatia 1: conta + onboarding + Impostos) ────────────────────
// 24/07/2026. Decisão de Flávia: login separado (login-pj.html), mas MESMO
// Firebase Auth do projeto — uma mentorada pode usar o mesmo e-mail/senha na
// conta PF e na PJ. A separação é de coleção (`contasPJ`, nunca `mentoradas`)
// e de páginas, não de identidade de autenticação. As 3 coleções do módulo de
// Impostos (retrofit multi-tenant, ver acima) já funcionam com qualquer uid
// sem mudança nenhuma — a conta PJ simplesmente passa o próprio uid.

/**
 * Devolve o doc de onboarding da conta PJ do uid, ou null se ainda não
 * completou (usado por login-pj.html pra decidir onboarding-pj x impostos-pj).
 */
exports.getContaPJ = onCall({}, async (request) => {
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);
  const snap = await db.collection('contasPJ').doc(uid).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
});

/**
 * Cria ou atualiza o onboarding da conta PJ (nome da empresa, CNPJ opcional,
 * regime tributário — campo informativo, não aciona cálculo nenhum, ver
 * BLUEPRINT do Dashboard PJ). `ativo` só é setado na criação (true por
 * padrão) — depois disso é controlado só pelo admin via definirAcessoPJ,
 * nunca reescrito aqui num reenvio do formulário de onboarding.
 */
exports.salvarOnboardingPJ = onCall({}, async (request) => {
  const { uid, nomeEmpresa, cnpj, regime } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!nomeEmpresa || typeof nomeEmpresa !== 'string' || !nomeEmpresa.trim())
    throw new HttpsError('invalid-argument', 'nomeEmpresa é obrigatório.');
  if (!['mei', 'simples', 'presumido'].includes(regime))
    throw new HttpsError('invalid-argument', "regime deve ser 'mei', 'simples' ou 'presumido'.");
  if (cnpj && !/^\d{14}$/.test(String(cnpj).replace(/\D/g, '')))
    throw new HttpsError('invalid-argument', 'cnpj deve ter 14 dígitos.');

  const ref  = db.collection('contasPJ').doc(uid);
  const jaExiste = (await ref.get()).exists;
  await ref.set({
    nomeEmpresa: nomeEmpresa.trim().slice(0, 150),
    cnpj:        cnpj ? String(cnpj).replace(/\D/g, '') : null,
    regime,
    ...(jaExiste ? {} : { ativo: true, criadoEm: admin.firestore.FieldValue.serverTimestamp() }),
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true };
});

/**
 * Liga/desliga o acesso PJ de um uid (independente do PF — achado 26/07/2026:
 * uma mentorada pode ter PF, PJ, ou os dois, e cada um precisa ser
 * controlável separado, sem depender do Auth `disabled` compartilhado).
 * Exclusivo para admin.
 */
exports.definirAcessoPJ = onCall({}, async (request) => {
  requireAdmin(request);
  const { uid, ativo } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');
  if (typeof ativo !== 'boolean') throw new HttpsError('invalid-argument', 'ativo deve ser true ou false.');
  const ref  = db.collection('contasPJ').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Esta conta ainda não tem onboarding PJ.');
  await ref.update({ ativo });
  return { ok: true };
});

/**
 * true se o uid tem conta PJ com acesso ativo (ativo !== false — contas
 * criadas antes deste campo existir contam como ativas por padrão).
 * Usado pra decidir se `verificarExpiracoes`/webhook Kiwify podem desabilitar
 * o Auth compartilhado: se a PJ dela ainda está ativa, o Auth continua
 * habilitado mesmo com a mentoria PF expirada (mesma lógica já aplicada a
 * assinaturaDashboard/assinaturaClube, agora simétrica pro PJ).
 */
async function _temAcessoPJAtivo(uid) {
  const snap = await db.collection('contasPJ').doc(uid).get();
  return snap.exists && snap.data().ativo !== false;
}

// ─── Fluxo de Caixa PJ (fatia 2) ───────────────────────────────────────────
// Saldo projetado: entradas de recebimentos (reais na dataRecebimento, ou
// projetadas na dataPrevista enquanto não confirmado) menos saídas de
// despesasPJ + impostosPrevistos (na data de vencimento real, não na
// competência) — ver .build-scope.md pro racional completo.

exports.atualizarSaldoCaixaPJ = onCall({}, async (request) => {
  const { uid, saldo } = request.data;
  requireSelfOrAdmin(request, uid);
  if (typeof saldo !== 'number') throw new HttpsError('invalid-argument', 'saldo deve ser um número.');
  await db.collection('contasPJ').doc(uid).update({
    saldoCaixaAtual: saldo,
    saldoCaixaAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/**
 * Prazo médio de recebimento sugerido (dias), calculado a partir dos
 * recebimentos já confirmados (dataRecebimento preenchida), ponderado por
 * valorLiquido. null se não houver histórico suficiente (< 3 recebimentos) —
 * quem chama decide o fallback (ver getFluxoCaixaPJ).
 */
async function _calcularPMR(uid) {
  const snap = await db.collectionGroup('recebimentos').where('uid', '==', uid).get();
  const confirmados = snap.docs
    .map(d => d.data())
    .filter(r => r.dataRecebimento && r.dataEmissaoNota);
  if (confirmados.length < 3) return null;

  let somaDiasPonderada = 0;
  let somaValor = 0;
  for (const r of confirmados) {
    const dias = (new Date(r.dataRecebimento) - new Date(r.dataEmissaoNota)) / 86_400_000;
    if (dias < 0) continue; // dado inconsistente (recebeu antes de emitir) — ignora
    somaDiasPonderada += dias * r.valorLiquido;
    somaValor += r.valorLiquido;
  }
  if (somaValor === 0) return null;
  return Math.round(somaDiasPonderada / somaValor);
}

exports.getFluxoCaixaPJ = onCall({}, async (request) => {
  const { uid, mes, ano } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw new HttpsError('invalid-argument', 'mes inválido.');
  if (!Number.isInteger(ano) || ano < 2020 || ano > 2100) throw new HttpsError('invalid-argument', 'ano inválido.');
  const prefixoMes = `${ano}-${String(mes).padStart(2, '0')}`;

  const contaSnap = await db.collection('contasPJ').doc(uid).get();
  const conta = contaSnap.exists ? contaSnap.data() : {};
  const pmrCalculado = await _calcularPMR(uid);
  // Sem histórico suficiente (< 3 recebimentos confirmados), cai num padrão
  // de 30 dias só pra exibição/contexto — nada trava nem exige configuração
  // manual, já que cada recebimento já tem sua própria dataPrevista real
  // (sugerida por forma de pagamento em SUGESTAO_PRAZO_DIAS).
  const pmrEfetivo = pmrCalculado ?? 30;

  const movimentos = [];

  // Entradas: todos os recebimentos da conta, projetando quem ainda não foi
  // confirmado na dataPrevista (a própria dataPrevista já é a melhor
  // estimativa por forma de pagamento — só cai no PMR genérico se a nota tiver
  // sido criada sem recebimento próprio, o que não deveria acontecer já que
  // saveNotaEmitida sempre cria um default, mas o fallback protege contra
  // dado legado/editado na mão).
  const recebSnap = await db.collectionGroup('recebimentos').where('uid', '==', uid).get();
  recebSnap.docs.forEach(d => {
    const r = d.data();
    const dataEfetiva = r.dataRecebimento || r.dataPrevista || r.dataEmissaoNota;
    if (!dataEfetiva || !dataEfetiva.startsWith(prefixoMes)) return;
    movimentos.push({
      data: dataEfetiva,
      tipo: 'entrada',
      descricao: `Recebimento (${r.formaPagamento})${r.parcelaTotal ? ` ${r.parcelaAtual}/${r.parcelaTotal}` : ''}`,
      valor: r.valorLiquido,
      confirmado: !!r.dataRecebimento,
    });
  });

  // Entradas: lançamentos avulsos que não são venda (aporte de sócio,
  // reembolso, outro) — não passam por nota fiscal nem entram na DRE, só no
  // caixa (achado 27/07/2026).
  const CATEGORIA_LABEL_ENTRADA = { aporte_socio: 'Aporte de sócio', reembolso: 'Reembolso', outro: 'Outra entrada' };
  const outrasSnap = await db.collection('outrasEntradasPJ')
    .where('uid', '==', uid).where('mes', '==', mes).where('ano', '==', ano).get();
  outrasSnap.docs.forEach(d => {
    const o = d.data();
    movimentos.push({
      data: o.data, tipo: 'entrada',
      descricao: `${CATEGORIA_LABEL_ENTRADA[o.categoria] || 'Outra entrada'}: ${o.descricao}`,
      valor: o.valor, confirmado: true,
    });
  });

  // Saídas: despesas fixas recorrem todo mês no diaVencimento; despesas
  // únicas (tipo 'unica') só entram no mês da sua própria data (achado
  // 27/07/2026: nem toda despesa é recorrente).
  const despesasSnap = await db.collection('despesasPJ').where('uid', '==', uid).where('ativo', '==', true).get();
  despesasSnap.docs.forEach(d => {
    const desp = d.data();
    if (desp.tipo === 'unica') {
      if (!desp.data || !desp.data.startsWith(prefixoMes)) return;
      movimentos.push({ data: desp.data, tipo: 'saida', descricao: desp.nome, valor: desp.valor, confirmado: false });
      return;
    }
    const dataVenc = `${prefixoMes}-${String(desp.diaVencimento).padStart(2, '0')}`;
    movimentos.push({ data: dataVenc, tipo: 'saida', descricao: desp.nome, valor: desp.valor, confirmado: false });
  });

  // Saídas: impostos previstos com vencimento real neste mês (exclui linhas
  // só-informativas do trimestral — referenciaTrimestral nunca é saída de
  // caixa própria, quem paga de fato é a linha acumulada no mês de fechamento).
  const impSnap = await db.collection('impostosPrevistos').where('uid', '==', uid).get();
  impSnap.docs.forEach(d => {
    const imp = d.data();
    if (imp.referenciaTrimestral) return;
    if (!imp.vencimento || !imp.vencimento.startsWith(prefixoMes)) return;
    movimentos.push({ data: imp.vencimento, tipo: 'saida', descricao: imp.tributoNome, valor: imp.valor, confirmado: !!imp.pago });
  });

  movimentos.sort((a, b) => a.data.localeCompare(b.data));

  let saldo = conta.saldoCaixaAtual ?? 0;
  const linhas = movimentos.map(m => {
    saldo += m.tipo === 'entrada' ? m.valor : -m.valor;
    return { ...m, saldoAcumulado: Math.round(saldo * 100) / 100 };
  });

  return {
    movimentos: linhas,
    saldoInicial: conta.saldoCaixaAtual ?? 0,
    saldoCaixaAtualizadoEm: conta.saldoCaixaAtualizadoEm || null,
    saldoFinal: linhas.length ? linhas[linhas.length - 1].saldoAcumulado : (conta.saldoCaixaAtual ?? 0),
    pmrEfetivo,
    pmrCalculado: pmrCalculado !== null,
  };
});

// ─── Contas a Receber consolidada (achado 27/07/2026) ─────────────────────────
// A fatia 2 entregou o auto-split de parcelas e o registro de recebimentos
// por nota, mas não entregou nenhuma visão que cruze todas as notas — pra ver
// o que está pendente era preciso abrir nota por nota. Esta function agrega
// os recebimentos ainda não confirmados de todas as notas da conta, junto
// com os totais do mês em foco, pra alimentar uma tela única (mesmo espírito
// da sub-aba "Recebimentos" de Financeiro no admin.html).
exports.getRecebimentosPendentesPJ = onCall({}, async (request) => {
  const { uid, mes, ano } = request.data;
  requireSelfOrAdmin(request, uid);
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw new HttpsError('invalid-argument', 'mes inválido.');
  if (!Number.isInteger(ano) || ano < 2020 || ano > 2100) throw new HttpsError('invalid-argument', 'ano inválido.');
  const prefixoMes = `${ano}-${String(mes).padStart(2, '0')}`;
  const hoje = new Date().toISOString().slice(0, 10);

  // Mesmo padrão de getFluxoCaixaPJ/_calcularPMR: filtra só por uid no
  // Firestore (já coberto pelo fieldOverride de collectionGroup criado na
  // fatia 2), resto — período e status — em memória. Volume por conta é
  // baixo o suficiente pra não justificar índice composto novo.
  const snap = await db.collectionGroup('recebimentos').where('uid', '==', uid).get();

  let previstoNoMes = 0, recebidoNoMes = 0, aReceber = 0;
  const pendentes = [];

  snap.docs.forEach(d => {
    const r = d.data();
    if (r.dataPrevista && r.dataPrevista.startsWith(prefixoMes)) previstoNoMes += r.valorLiquido;
    if (r.dataRecebimento && r.dataRecebimento.startsWith(prefixoMes)) recebidoNoMes += r.valorLiquido;
    if (r.dataRecebimento) return; // já confirmado, não entra na lista de pendentes

    // "A receber" não é filtrado por mês de propósito — um recebimento
    // vencido em mês anterior continua pendente até ser confirmado, não
    // pode sumir só porque a usuária navegou pro mês seguinte.
    aReceber += r.valorLiquido;
    pendentes.push({
      id: d.id,
      notaId: d.ref.parent.parent.id,
      formaPagamento: r.formaPagamento,
      valorBruto: r.valorBruto,
      taxa: r.taxa || 0,
      valorLiquido: r.valorLiquido,
      dataPrevista: r.dataPrevista,
      parcelaAtual: r.parcelaAtual || null,
      parcelaTotal: r.parcelaTotal || null,
      vencido: !!r.dataPrevista && r.dataPrevista < hoje,
    });
  });

  pendentes.sort((a, b) => (a.dataPrevista || '').localeCompare(b.dataPrevista || ''));

  return {
    kpis: {
      previstoNoMes: Math.round(previstoNoMes * 100) / 100,
      recebidoNoMes: Math.round(recebidoNoMes * 100) / 100,
      aReceber: Math.round(aReceber * 100) / 100,
    },
    pendentes,
  };
});

// Bootstrap de conta de teste PJ é feito via script (scripts/criar-conta-pj-teste.js),
// mesmo padrão de criar-perfil-admin.js — não precisa de Cloud Function pra
// isso, e evita expor mais um endpoint admin-only sem produto Kiwify real
// por trás ainda (fase Venda, fora do escopo desta fatia).

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

  // `investimentos` pode ter mais de um item pra mesma classe quando vêm de
  // posições diferentes da corretora (casal, mais de uma corretora — achado
  // 20/07/2026) — soma por classe em vez de sobrescrever, senão a segunda
  // posição importada apagava o valor da primeira na tela consolidada.
  const somaPorClasse = {};
  for (const item of investimentos) {
    if (item.valor > 0) somaPorClasse[item.classe] = (somaPorClasse[item.classe] || 0) + item.valor;
  }
  for (const classe in somaPorClasse) {
    mapa[classe] = { classe, valor: somaPorClasse[classe], source: 'investimentos' };
  }

  return Object.values(mapa).filter(a => a.valor > 0);
}

/**
 * Agrupa o array flat de `corretora` (itens com posicaoId/posicaoNome) em
 * posições nomeadas, pra exibição/gestão na UI. Itens legados (importados
 * antes dessa funcionalidade existir, sem posicaoId) caem numa posição
 * implícita "legado" — nunca ficam invisíveis, só sem nome próprio até a
 * usuária reimportar ou renomear.
 */
function agruparPosicoesCorretora(investimentos) {
  const porPosicao = {};
  for (const item of investimentos) {
    const id   = item.posicaoId || '__legado__';
    const nome = item.posicaoNome || 'Corretora (sem nome)';
    if (!porPosicao[id]) porPosicao[id] = { id, nome, itens: [], atualizadoEm: item.posicaoAtualizadoEm || null };
    porPosicao[id].itens.push({ classe: item.classe, valor: item.valor });
  }
  return Object.values(porPosicao).map(p => ({
    ...p,
    total: p.itens.reduce((s, i) => s + i.valor, 0),
  }));
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
  comMonitoramento('notifDia1', async () => {
    if (await jaExecutouHoje('notifDia1')) return;
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
      // (savePerfil grava `perfil` como string simples e a data em `perfilData`,
      // não como objeto aninhado — ver exports.savePerfil)
      if (!m.perfil) {
        tarefas.push(sendEmail({
          to:      m.email,
          subject: 'Configure seu perfil de investidor',
          html:    emailSemPerfil(m.nome || 'mentorada'),
        }));
      }
      // Perfil desatualizado (> 180 dias) → aviso de renovação
      else if (m.perfilData) {
        const [pA, pM, pD] = m.perfilData.split('-').map(Number);
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
    await marcarEnviado('notifDia1');
  }));


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
        subject: 'Novidades no seu Dashboard — Junho 2026',
        html:    emailNovidades(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[anunciarNovidades] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  await db.collection('config').doc('comunicados').set(
    { novidades: { enviadoEm: admin.firestore.FieldValue.serverTimestamp(), enviados, erros } },
    { merge: true }
  );
  return { ok: true, enviados, erros };
});

/**
 * Dispara e-mail de novidades Jun/2026 (v2) para todas as mentoradas ativas.
 * Substitui anunciarNovidades (já enviado com conteúdo antigo em 08/06/2026).
 */
exports.anunciarNovidadesJun2026 = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  requireAdmin(request);
  const mentoradas = await getAtivas();
  let enviados = 0, erros = 0;
  for (const m of mentoradas) {
    if (!m.email) continue;
    try {
      await sendEmail({
        to:      m.email,
        subject: 'Novidades no seu Dashboard — Junho 2026',
        html:    emailNovidadesJun2026(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[anunciarNovidadesJun2026] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  await db.collection('config').doc('comunicados').set(
    { novidadesJun2026: { enviadoEm: admin.firestore.FieldValue.serverTimestamp(), enviados, erros } },
    { merge: true }
  );
  return { ok: true, enviados, erros };
});

exports.anunciarJornadaDashboard = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  requireAdmin(request);
  const mentoradas = await getAtivas();
  let enviados = 0, erros = 0;
  for (const m of mentoradas) {
    if (!m.email) continue;
    try {
      await sendEmail({
        to:      m.email,
        subject: 'Nova aba no seu Dashboard: Minha Jornada',
        html:    emailJornadaDashboard(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[anunciarJornadaDashboard] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  await db.collection('config').doc('comunicados').set(
    { jornadaDashboard: { enviadoEm: admin.firestore.FieldValue.serverTimestamp(), enviados, erros } },
    { merge: true }
  );
  return { ok: true, enviados, erros };
});

/**
 * Dispara e-mail de novidades Jun/2026 (v3) para todas as mentoradas ativas.
 * Texto livre + detecção de mês no CSV.
 */
exports.anunciarNovidadesJun2026v3 = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  requireAdmin(request);
  const mentoradas = await getAtivas();
  let enviados = 0, erros = 0;
  for (const m of mentoradas) {
    if (!m.email) continue;
    try {
      await sendEmail({
        to:      m.email,
        subject: 'Novidade no seu Dashboard: registre gastos com uma frase',
        html:    emailNovidadesJun2026v3(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[anunciarNovidadesJun2026v3] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  await db.collection('config').doc('comunicados').set(
    { novidadesJun2026v3: { enviadoEm: admin.firestore.FieldValue.serverTimestamp(), enviados, erros } },
    { merge: true }
  );
  return { ok: true, enviados, erros };
});

/**
 * Dispara e-mail de novidades Jul/2026 para todas as mentoradas ativas.
 * Faturas no mês de pagamento + pagamento parcial com rollover + materiais na Jornada.
 */
exports.anunciarNovidadesJun2026Completo = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  requireAdmin(request);
  const mentoradas = await getAtivas();
  let enviados = 0, erros = 0;
  for (const m of mentoradas) {
    if (!m.email) continue;
    try {
      await sendEmail({
        to:      m.email,
        subject: 'Tudo que melhoramos em Junho para você — Trilogia Dashboard',
        html:    emailNovidadesJun2026Completo(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[anunciarNovidadesJun2026Completo] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  await db.collection('config').doc('comunicados').set(
    { novidadesJun2026Completo: { enviadoEm: admin.firestore.FieldValue.serverTimestamp(), enviados, erros } },
    { merge: true }
  );
  return { ok: true, enviados, erros };
});

exports.anunciarNovidadesJul2026 = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  requireAdmin(request);
  const mentoradas = await getAtivas();
  let enviados = 0, erros = 0;
  for (const m of mentoradas) {
    if (!m.email) continue;
    try {
      await sendEmail({
        to:      m.email,
        subject: 'Atualizações no Dashboard: faturas e Minha Jornada',
        html:    emailNovidadesJul2026(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[anunciarNovidadesJul2026] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  await db.collection('config').doc('comunicados').set(
    { novidadesJul2026: { enviadoEm: admin.firestore.FieldValue.serverTimestamp(), enviados, erros } },
    { merge: true }
  );
  return { ok: true, enviados, erros };
});

exports.anunciarBalancoJul2026 = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  requireAdmin(request);
  const mentoradas = await getAtivas();
  let enviados = 0, erros = 0;
  for (const m of mentoradas) {
    if (!m.email) continue;
    try {
      await sendEmail({
        to:      m.email,
        subject: 'Detalhe, Planejamento e despesas fixas — mais precisos',
        html:    emailBalancoJul2026(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[anunciarBalancoJul2026] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  await db.collection('config').doc('comunicados').set(
    { balancoJul2026: { enviadoEm: admin.firestore.FieldValue.serverTimestamp(), enviados, erros } },
    { merge: true }
  );
  return { ok: true, enviados, erros };
});

exports.anunciarMultiplasContasJul2026 = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  requireAdmin(request);
  const mentoradas = await getAtivas();
  let enviados = 0, erros = 0;
  for (const m of mentoradas) {
    if (!m.email) continue;
    try {
      await sendEmail({
        to:      m.email,
        subject: 'Chegou: múltiplas contas correntes no seu Dashboard',
        html:    emailMultiplasContasJul2026(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[anunciarMultiplasContasJul2026] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  await db.collection('config').doc('comunicados').set(
    { multiplasContasJul2026: { enviadoEm: admin.firestore.FieldValue.serverTimestamp(), enviados, erros } },
    { merge: true }
  );
  return { ok: true, enviados, erros };
});

exports.anunciarRaioXJul2026 = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  requireAdmin(request);
  const mentoradas = await getAtivas();
  let enviados = 0, erros = 0;
  for (const m of mentoradas) {
    if (!m.email) continue;
    try {
      await sendEmail({
        to:      m.email,
        subject: 'Chegou: importar extrato com IA, direto no Dashboard',
        html:    emailRaioXJul2026(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[anunciarRaioXJul2026] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  await db.collection('config').doc('comunicados').set(
    { raioXJul2026: { enviadoEm: admin.firestore.FieldValue.serverTimestamp(), enviados, erros } },
    { merge: true }
  );
  return { ok: true, enviados, erros };
});

exports.anunciarPatrimonioIAJul2026 = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  requireAdmin(request);
  const mentoradas = await getAtivas();
  let enviados = 0, erros = 0;
  for (const m of mentoradas) {
    if (!m.email) continue;
    try {
      await sendEmail({
        to:      m.email,
        subject: 'Chegou: importe seu Patrimônio com IA',
        html:    emailPatrimonioIAJul2026(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[anunciarPatrimonioIAJul2026] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  await db.collection('config').doc('comunicados').set(
    { patrimonioIAJul2026: { enviadoEm: admin.firestore.FieldValue.serverTimestamp(), enviados, erros } },
    { merge: true }
  );
  return { ok: true, enviados, erros };
});

/**
 * Envia comunicado técnico para todas as mentoradas ativas.
 * Usado quando há instabilidade no app — orienta a reinstalar o PWA.
 */
exports.comunicadoTecnico = onCall({ secrets: SECRETS_EMAIL }, async (request) => {
  requireAdmin(request);
  const mentoradas = await getAtivas();
  let enviados = 0, erros = 0;
  for (const m of mentoradas) {
    if (!m.email) continue;
    try {
      await sendEmail({
        to:      m.email,
        subject: 'Aviso sobre o Trilogia Dashboard',
        html:    emailComunicadoTecnico(m.nome || 'mentorada'),
      });
      enviados++;
    } catch (err) {
      console.error(`[comunicadoTecnico] Erro ao enviar para ${m.email}:`, err.message);
      erros++;
    }
  }
  await db.collection('config').doc('comunicados').set(
    { tecnico: { enviadoEm: admin.firestore.FieldValue.serverTimestamp(), enviados, erros } },
    { merge: true }
  );
  return { ok: true, enviados, erros };
});

/**
 * Retorna o histórico de envio dos comunicados.
 */
exports.getComunicadosStatus = onCall({}, async (request) => {
  requireAdmin(request);
  const snap = await db.collection('config').doc('comunicados').get();
  return snap.exists ? snap.data() : {};
});

/**
 * Define a missão do mês (exibida no dashboard das mentoradas após onboarding).
 * Somente admin. Espera: { titulo, descricao }
 */
exports.saveMissaoMes = onCall({}, async (request) => {
  requireAdmin(request);
  const { titulo, descricao } = request.data;
  if (!titulo) throw new HttpsError('invalid-argument', 'titulo é obrigatório.');
  const mes = new Date().toISOString().slice(0, 7); // YYYY-MM
  await db.collection('config').doc('missaoMes').set({ titulo, descricao: descricao || '', mes });
  return { ok: true, mes };
});

/**
 * Envia push manual para todas as mentoradas com subscription ativa.
 * Somente admin. Espera: { titulo, corpo, url? }
 */
exports.enviarPushManual = onCall({ secrets: SECRETS_PUSH }, async (request) => {
  requireAdmin(request);
  const { titulo, corpo, url } = request.data;
  if (!titulo || !corpo) throw new HttpsError('invalid-argument', 'titulo e corpo são obrigatórios.');
  const enviados = await sendPushToAtivas({
    titulo,
    corpo,
    url: url || '/index.html',
    tag: 'push-manual',
  });
  return { ok: true };
});

exports.notifDia28 = onSchedule(
  { schedule: '0 8 28 * *', timeZone: 'America/Sao_Paulo', secrets: [...SECRETS_EMAIL, ...SECRETS_PUSH] },
  comMonitoramento('notifDia28', async () => {
    if (await jaExecutouHoje('notifDia28')) return;
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
    await marcarEnviado('notifDia28');
  }));

/**
 * notifRetencao — diariamente às 10h (Sao_Paulo)
 * Envia série de e-mails para mentoradas com status=alerta:
 *   Dia 1: lembrete suave
 *   Dia 3: urgência (o que está em risco)
 *   Dia 7: último aviso antes do bloqueio
 */
exports.notifRetencao = onSchedule(
  { schedule: '0 10 * * *', timeZone: 'America/Sao_Paulo', secrets: SECRETS_EMAIL },
  comMonitoramento('notifRetencao', async () => {
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
        console.log(`[retencao] ${tarefas.length} e-mail(s) enviados para ${maskEmail(email)} (dia ${diasEmAlerta} de alerta)`);
      }
    }
  }));

/**
 * notifMaioIR — todo dia 5 de maio, 08h (Sao_Paulo)
 *   • Lembrete de importação da declaração de IR
 */
exports.notifMaioIR = onSchedule(
  { schedule: '0 8 5 5 *', timeZone: 'America/Sao_Paulo', secrets: SECRETS_EMAIL },
  async () => {
    if (await jaExecutouHoje('notifMaioIR')) return;
    const mentoradas = await getAtivas();

    for (const m of mentoradas) {
      await sendEmail({
        to:      m.email,
        subject: 'Atualize seu patrimônio com a declaração de IR',
        html:    emailIR(m.nome || 'mentorada'),
      }).catch(err => console.error(`Erro ao enviar IR para ${m.email}:`, err));
    }
    await marcarEnviado('notifMaioIR');
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

    const agora = new Date();
    const expireAt = new Date(agora);
    expireAt.setFullYear(expireAt.getFullYear() + 5); // TTL LGPD: 5 anos

    for (const doc of snap.docs) {
      const { sheetId, nome, email, deletadoEm } = doc.data();

      if (!sheetId) {
        await doc.ref.update({ planilhaApagada: true, planilhaApagadaEm: agora });
        await db.collection('_lgpd_log').add({
          uid:              doc.id,
          nome:             nome || null,
          email:            email || null,
          sheetId:          null,
          acao:             'sem_planilha_registrada',
          deletadoEm:       deletadoEm || null,
          planilhaApagadaEm: agora,
          expireAt,
        });
        continue;
      }

      try {
        await drive.files.delete({ fileId: sheetId });
        await doc.ref.update({ planilhaApagada: true, planilhaApagadaEm: agora });
        await db.collection('_lgpd_log').add({
          uid:               doc.id,
          nome:              nome  || null,
          email:             email || null,
          sheetId,
          acao:              'planilha_apagada',
          deletadoEm:        deletadoEm || null,
          planilhaApagadaEm: agora,
          expireAt,
        });
        console.log(`[limparDadosExpirados] Planilha apagada: ${nome} (${sheetId})`);
      } catch (err) {
        await db.collection('_lgpd_log').add({
          uid:        doc.id,
          nome:       nome  || null,
          email:      email || null,
          sheetId,
          acao:       'falha_apagar_planilha',
          erro:       err.message,
          deletadoEm: deletadoEm || null,
          tentativaEm: agora,
          expireAt,
        });
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
  { schedule: '0 9 * * *', timeZone: 'America/Sao_Paulo', secrets: [sGmail] },
  comMonitoramento('verificarExpiracoes', async () => {
    const hoje = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    // Query simples por status (sem compound index) + filtro em memória.
    // Cron diário com poucas dezenas de docs — não justifica índice composto.
    const snap = await db.collection('mentoradas')
      .where('status', '==', 'ativa')
      .get();

    for (const doc of snap.docs) {
      const { dataExpiracao, assinaturaDashboard, assinaturaClube } = doc.data();
      if (!dataExpiracao) continue;
      if (dataExpiracao > hoje) continue; // ainda não expirou

      // Mantém acesso se tem assinatura ativa de dashboard ou clube
      if (assinaturaDashboard === true) {
        console.log(`Mentoria expirada mas dashboard ativo — acesso mantido: ${doc.id}`);
        continue;
      }
      if (assinaturaClube === true) {
        console.log(`Mentoria expirada mas clube ativo — acesso mantido: ${doc.id}`);
        continue;
      }
      // Mantém acesso se tem conta PJ ativa — o Auth é compartilhado entre
      // PF e PJ (mesmo e-mail/senha), então desabilitar por mentoria PF
      // expirada derrubaria o acesso PJ dela também (achado 26/07/2026).
      if (await _temAcessoPJAtivo(doc.id)) {
        console.log(`Mentoria expirada mas PJ ativo — acesso mantido: ${doc.id}`);
        continue;
      }

      await Promise.allSettled([
        admin.auth().updateUser(doc.id, { disabled: true }),
        admin.auth().revokeRefreshTokens(doc.id),
      ]);
      await doc.ref.update({ status: 'inativa' });
      console.log(`Conta expirada e inativada: ${doc.id} (${dataExpiracao})`);
    }
  }));

/**
 * notifExpiracaoProxima — diariamente às 07h (Sao_Paulo)
 * Avisa alunas cuja dataExpiracao está próxima.
 * Roda ANTES de verificarExpiracoes (09h) para garantir que o aviso chega antes do bloqueio.
 *
 * Régua padrão (dashboard/clube pago): só D-7, aviso genérico de renovação — comportamento
 * inalterado desde antes de 10/07/2026.
 * Régua Raio-X (nivelAcesso: 'raio-x', degustação de 30 dias): D-7, D-3 e D-0, com copy de
 * upgrade para o Dashboard completo (emailUpgradeDashboard contexto 'raio-x').
 */
exports.notifExpiracaoProxima = onSchedule(
  { schedule: '0 7 * * *', timeZone: 'America/Sao_Paulo', secrets: SECRETS_EMAIL },
  async () => {
    if (await jaExecutouHoje('notifExpiracaoProxima')) return;

    const dataAlvo = (diasAFrente) => {
      const d = new Date();
      d.setDate(d.getDate() + diasAFrente);
      return d.toISOString().slice(0, 10);
    };
    const REGUA = [
      { dias: 7, alvo: dataAlvo(7) },
      { dias: 3, alvo: dataAlvo(3) },
      { dias: 0, alvo: dataAlvo(0) },
    ];

    const snap = await db.collection('mentoradas')
      .where('status', '==', 'ativa')
      .where('dataExpiracao', 'in', REGUA.map(r => r.alvo))
      .get();

    for (const doc of snap.docs) {
      const m = doc.data();
      if (!m.email) continue;
      // Não notifica quem tem assinatura ativa de dashboard ou clube (não vai expirar)
      if (m.assinaturaDashboard === true || m.assinaturaClube === true) continue;

      const matchRegua = REGUA.find(r => r.alvo === m.dataExpiracao);
      const diasRestantes = matchRegua ? matchRegua.dias : null;
      const ehRaioX = m.nivelAcesso === 'raio-x';

      // D-3 e D-0 só existem para a régua do Raio-X; produtos fora dela mantêm só D-7.
      if (!ehRaioX && diasRestantes !== 7) continue;

      const subject = ehRaioX
        ? (diasRestantes === 0
            ? 'Hoje é o último dia da sua degustação do Raio-X'
            : `Sua degustação do Raio-X termina em ${diasRestantes} dias`)
        : 'Seu acesso ao Dashboard expira em 7 dias';

      const html = ehRaioX
        ? emailUpgradeDashboard(m.nome || 'mentorada', 'raio-x', diasRestantes)
        : emailExpiracaoProxima(m.nome || 'mentorada');

      await sendEmail({ to: m.email, subject, html })
        .catch(err => console.error(`Erro ao enviar expiração para ${m.email}:`, err));
    }
    await marcarEnviado('notifExpiracaoProxima');
  },
);

// ─── WHATSAPP AGENDADO (esteira pós-venda) ────────────────────────────────────

/**
 * processaWhatsAppAgendado — roda todo dia às 10h (Sao_Paulo).
 * Lê `whatsapp_agendado` com dataEnvio = hoje e enviado = false,
 * envia cada mensagem via Z-API e marca como enviado.
 *
 * Estrutura do documento:
 *   whatsapp_agendado/{id}
 *     email, nome, telefone, produto, mensagem,
 *     dataEnvio: "YYYY-MM-DD", enviado: false
 */
exports.processaWhatsAppAgendado = onSchedule(
  {
    schedule: '0 10 * * *',
    timeZone: 'America/Sao_Paulo',
    secrets:  [sZapiId, sZapiToken, sZapiClient],
  },
  comMonitoramento('processaWhatsAppAgendado', async () => {
    if (await jaExecutouHoje('processaWhatsAppAgendado')) return;

    const zapiId     = sZapiId.value();
    const zapiToken  = sZapiToken.value();
    const zapiClient = sZapiClient.value();

    if (!zapiId || !zapiToken) {
      console.warn('[whatsappAgendado] Secrets Z-API não configurados — abortando.');
      return;
    }

    const zapi = new ZApiClient(zapiId, zapiToken, zapiClient);

    // Verifica conexão antes de tentar enviar
    const conectado = await zapi.verificarConexao().catch(() => false);
    if (!conectado) {
      console.error('[whatsappAgendado] Z-API desconectada (WhatsApp não logado). Escanear QR code em app.z-api.io.');
      await alertarErro('processaWhatsAppAgendado', new Error('Z-API desconectada — WhatsApp offline'));
      return;
    }

    const hoje = new Date().toISOString().slice(0, 10);
    const snap = await db.collection('whatsapp_agendado')
      .where('dataEnvio', '==', hoje)
      .where('enviado', '==', false)
      .get();

    if (snap.empty) {
      console.log(`[whatsappAgendado] Nenhuma mensagem agendada para hoje (${hoje}).`);
      await marcarEnviado('processaWhatsAppAgendado');
      return;
    }

    console.log(`[whatsappAgendado] ${snap.size} mensagem(ns) para enviar em ${hoje}.`);

    for (const doc of snap.docs) {
      const { telefone, mensagem, email, nome, produto } = doc.data();

      if (!telefone) {
        console.warn(`[whatsappAgendado] Telefone ausente para ${email} — pulando.`);
        await doc.ref.update({ enviado: true, erroEnvio: 'telefone_ausente', enviadoEm: admin.firestore.FieldValue.serverTimestamp() });
        continue;
      }

      try {
        await zapi.enviarTexto(telefone, mensagem);
        await doc.ref.update({
          enviado:   true,
          enviadoEm: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[whatsappAgendado] ✅ ${maskEmail(email)} (${produto}) — mensagem enviada.`);
      } catch (err) {
        console.error(`[whatsappAgendado] Falha ao enviar para ${maskEmail(email)}:`, err.message);
        await doc.ref.update({
          erroEnvio:    err.message,
          tentativas:   admin.firestore.FieldValue.increment(1),
          ultimaTentativa: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Pausa entre envios para não disparar rate limit do Z-API
      await new Promise(r => setTimeout(r, 1500));
    }

    await marcarEnviado('processaWhatsAppAgendado');
  }),
);

// ─── FATURAMENTO (admin.html) ─────────────────────────────────────────────────

/**
 * getFaturamento — agrega cobranças pagas por produto para o painel admin.
 * Retorna faturamento do mês solicitado + mês anterior (para comparativo).
 *
 * Parâmetros: { mes: number, ano: number }
 * Resposta:
 *   {
 *     mesAtual:    { total, porProduto: { mentoria, private, dashboard, clube, combo, curso, ebook } },
 *     mesAnterior: { total, porProduto: { ... } },
 *     ticketMedio: number,
 *   }
 */
exports.getFaturamento = onCall({}, async (request) => {
  requireAdmin(request);
  const { mes, ano } = request.data;

  if (!Number.isInteger(mes) || mes < 1 || mes > 12)
    throw new HttpsError('invalid-argument', 'mes deve ser inteiro entre 1 e 12.');
  if (!Number.isInteger(ano) || ano < 2020 || ano > 2100)
    throw new HttpsError('invalid-argument', 'ano deve ser inteiro entre 2020 e 2100.');

  // Calcula mês anterior
  const mesAnt = mes === 1 ? 12 : mes - 1;
  const anoAnt = mes === 1 ? ano - 1 : ano;

  const PRODUTOS = ['mentoria', 'private', 'dashboard', 'clube', 'combo', 'curso', 'ebook'];

  function prefixoMes(m, a) {
    return `${a}-${String(m).padStart(2, '0')}`;
  }

  async function agregarMes(m, a) {
    const prefixo = prefixoMes(m, a);

    // Busca todas as cobranças pagas no mês pelo vencimento
    const snap = await db.collection('cobrancas')
      .where('pago', '==', true)
      .where('vencimento', '>=', `${prefixo}-01`)
      .where('vencimento', '<=', `${prefixo}-31`)
      .get();

    const porProduto = Object.fromEntries(PRODUTOS.map(p => [p, 0]));
    let total = 0;

    for (const doc of snap.docs) {
      const { produto, valorRecebido, valor } = doc.data();
      const v = valorRecebido || valor || 0;
      total += v;
      const key = PRODUTOS.includes(produto) ? produto : 'outros';
      porProduto[key] = (porProduto[key] || 0) + v;
    }

    return { total: Math.round(total * 100) / 100, porProduto, qtd: snap.size };
  }

  const [mesAtual, mesAnterior] = await Promise.all([
    agregarMes(mes, ano),
    agregarMes(mesAnt, anoAnt),
  ]);

  const ticketMedio = mesAtual.qtd > 0
    ? Math.round((mesAtual.total / mesAtual.qtd) * 100) / 100
    : 0;

  const variacao = mesAnterior.total > 0
    ? Math.round(((mesAtual.total - mesAnterior.total) / mesAnterior.total) * 10000) / 100
    : null;

  return { mesAtual, mesAnterior, ticketMedio, variacao };
});

// ─── BACKUP AUTOMÁTICO ───────────────────────────────────────────────────────

/**
 * backupDiario — todo dia às 03h (Sao_Paulo)
 * Cria snapshot de todos os docs de mentoradas em backups/{YYYY-MM-DD}.
 * Mantém os últimos 30 dias. Backups mais antigos são removidos automaticamente.
 *
 * Estrutura: backups/{data}/mentoradas/{uid}           → campos principais
 *            backups/{data}/contratos/{uid}_{contratoId} → cópia integral de cada contrato
 *            backups/{data}/cobrancas/{cobrancaId}        → cópia integral de cada cobrança
 *
 * Contratos e cobranças entraram em 21/07/2026 (decisão: são o registro de
 * receita — se corromper, reconciliar na mão olhando a Kiwify é o tipo de
 * trabalho que vale evitar. Patrimônio ficou de fora porque já espelha no
 * Sheets, que tem histórico de revisão próprio do Drive; reservas ficou de
 * fora por ser baixo custo de recadastrar).
 */
/**
 * Grava um array de { ref, data } em lotes de até 450 (margem do limite de
 * 500 operações por batch do Firestore) — cobrancas cresce ao longo do tempo
 * e pode passar de 500 antes de mentoradas passar de 100.
 */
async function commitEmLotes(writes) {
  const TAMANHO_LOTE = 450;
  for (let i = 0; i < writes.length; i += TAMANHO_LOTE) {
    const lote  = writes.slice(i, i + TAMANHO_LOTE);
    const batch = db.batch();
    lote.forEach(({ ref, data }) => batch.set(ref, data));
    await batch.commit();
  }
}
/**
 * Retorna metadata do backup mais recente.
 */
exports.getBackupStatus = onCall({}, async (request) => {
  requireAdmin(request);
  const snap = await db.collection('backups').orderBy('data', 'desc').limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0].data();
  return {
    data:            d.data,
    totalMentoradas: d.totalMentoradas,
    totalContratos:  d.totalContratos ?? null,
    totalCobrancas:  d.totalCobrancas ?? null,
    criadoEm:        d.criadoEm?.toDate?.()?.toISOString() || null,
  };
});

exports.backupDiario = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'America/Sao_Paulo', secrets: [sGmail] },
  comMonitoramento('backupDiario', async () => {
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

    // ── 2. Snapshot de contratos (collection group — todas as mentoradas de uma vez) ──
    const contratosSnap = await db.collectionGroup('contratos').get();
    const writesContratos = contratosSnap.docs.map(doc => {
      const uidMentorada = doc.ref.parent.parent?.id || null;
      return {
        ref:  backupRef.collection('contratos').doc(`${uidMentorada}_${doc.id}`),
        data: { ...doc.data(), uidMentorada, contratoId: doc.id, backedUpAt: admin.firestore.FieldValue.serverTimestamp() },
      };
    });
    await commitEmLotes(writesContratos);

    // ── 3. Snapshot de cobranças (coleção raiz) ───────────────────────────
    const cobrancasSnap = await db.collection('cobrancas').get();
    const writesCobrancas = cobrancasSnap.docs.map(doc => ({
      ref:  backupRef.collection('cobrancas').doc(doc.id),
      data: { ...doc.data(), backedUpAt: admin.firestore.FieldValue.serverTimestamp() },
    }));
    await commitEmLotes(writesCobrancas);

    // ── 4. Metadata do backup ──────────────────────────────────────────────
    await backupRef.set({
      data:            dataHoje,
      totalMentoradas: mentSnap.size,
      totalContratos:  contratosSnap.size,
      totalCobrancas:  cobrancasSnap.size,
      criadoEm:        admin.firestore.FieldValue.serverTimestamp(),
    });

    // ── 5. Remove backups com mais de 30 dias ─────────────────────────────
    const limite = new Date();
    limite.setDate(limite.getDate() - 30);
    const limitStr = limite.toISOString().slice(0, 10);

    const velhos = await db.collection('backups')
      .where('data', '<', limitStr).get();

    for (const velho of velhos.docs) {
      // Remove as 3 subcoleções do backup antigo (mentoradas, contratos, cobrancas)
      for (const nomeSub of ['mentoradas', 'contratos', 'cobrancas']) {
        const subSnap = await velho.ref.collection(nomeSub).get();
        if (!subSnap.empty) {
          const refsParaDeletar = subSnap.docs.map(d => ({ ref: d.ref, data: null }));
          // Reaproveita commitEmLotes só pra chunking — batch.delete em vez de set
          for (let i = 0; i < refsParaDeletar.length; i += 450) {
            const lote  = refsParaDeletar.slice(i, i + 450);
            const delBatch = db.batch();
            lote.forEach(({ ref }) => delBatch.delete(ref));
            await delBatch.commit();
          }
        }
      }
      await velho.ref.delete();
    }

    console.log(`[backup] ${dataHoje}: ${mentSnap.size} mentoradas, ${contratosSnap.size} contratos, ${cobrancasSnap.size} cobranças. ${velhos.size} backup(s) antigo(s) removidos.`);
  }));

// ─── NOTION CRM ───────────────────────────────────────────────────────────────

// ID da página-mãe "🌙 Mentoradas" — usada como fallback quando a busca global não retorna nada
const MENTORADAS_PAGE_ID = '361dc774-3897-80bf-9362-d7575f493a3e';

/** Extrai texto puro de um array de rich_text do Notion. */
function getRichText(richText) {
  if (!Array.isArray(richText)) return '';
  return richText.map(r => r.plain_text || '').join('');
}

function getFirstHref(richText) {
  for (const rt of richText || []) {
    if (rt.href) return rt.href;
  }
  return null;
}

/**
 * Normaliza uma string para comparação de nomes:
 * minúsculas, sem acentos, split por espaço.
 */
function normWords(str) {
  return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean);
}

/**
 * Verifica se dois conjuntos de palavras representam o mesmo nome.
 * Lida com: nome do meio ausente no título, preposições, abreviações.
 */
function nomeCorresponde(nomeWords, titleWords) {
  const preposicoes = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'del', 'di']);
  const nomeKeyWords = nomeWords.filter(w => !preposicoes.has(w));
  // Abreviação: primeiro + último nome
  const nomeAbrevWords = nomeKeyWords.length >= 3
    ? [nomeKeyWords[0], nomeKeyWords[nomeKeyWords.length - 1]]
    : [];

  return titleWords.every(w => nomeWords.includes(w)) ||
         nomeWords.every(w => titleWords.includes(w)) ||
         (nomeKeyWords.length && nomeKeyWords.every(w => titleWords.includes(w))) ||
         (nomeAbrevWords.length >= 2 && nomeAbrevWords.every(w => titleWords.includes(w)));
}

/**
 * Busca a página Notion da mentorada pelo nome.
 * Estratégia 1: busca global via /search (rápida, mas depende de permissão de pesquisa)
 * Estratégia 2: lê filhos da página-mãe Mentoradas (sempre acessível se a parent foi compartilhada)
 * Retorna { id, url } ou null.
 */
async function buscarPaginaNotionPorNome(nome, headers) {
  const nomePartes = nome.trim().split(/\s+/);
  const nomeAbrev  = nomePartes.length >= 3
    ? `${nomePartes[0]} ${nomePartes[nomePartes.length - 1]}`
    : null;
  const queries = [
    `Mentoria Trilogia ${nome}`,
    nome,
    ...(nomeAbrev ? [`Mentoria Trilogia ${nomeAbrev}`, nomeAbrev] : []),
  ];

  const nomeWords = normWords(nome);

  // ── Estratégia 1: busca global ──────────────────────────────────────────────
  for (const query of queries) {
    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, filter: { value: 'page', property: 'object' }, page_size: 100 }),
    });
    if (!res.ok) break; // se a busca falhar, vai para estratégia 2
    const data = await res.json();
    const page = (data.results || []).find(p => {
      const raw = getRichText(p.properties?.title?.title) || getRichText(p.properties?.Name?.title) || '';
      return raw && nomeCorresponde(nomeWords, normWords(raw));
    });
    if (page) {
      console.log(`[buscarNotion] match via search: "${page.properties?.title?.title?.[0]?.plain_text || page.id}"`);
      return { id: page.id, url: page.url };
    }
  }

  // ── Estratégia 2: filhos da página-mãe ─────────────────────────────────────
  console.log(`[buscarNotion] search falhou para "${nome}", tentando filhos da página-mãe`);
  let cursor;
  do {
    const url = `https://api.notion.com/v1/blocks/${MENTORADAS_PAGE_ID}/children?page_size=100`
      + (cursor ? `&start_cursor=${cursor}` : '');
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[buscarNotion] falha ao ler filhos da página-mãe: ${res.status}`);
      break;
    }
    const data = await res.json();
    for (const block of (data.results || [])) {
      if (block.type !== 'child_page') continue;
      const titulo = block.child_page?.title || '';
      if (titulo && nomeCorresponde(nomeWords, normWords(titulo))) {
        console.log(`[buscarNotion] match via filhos: "${titulo}" → ${block.id}`);
        return { id: block.id, url: `https://notion.so/${block.id.replace(/-/g, '')}` };
      }
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  console.warn(`[buscarNotion] página NÃO encontrada para "${nome}"`);
  return null;
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
    const found = await buscarPaginaNotionPorNome(nome, headers);
    if (!found) {
      console.warn(`[getNotionCRM] Página não encontrada para: "${nome}" (uid=${uid})`);
      return { notionPageUrl: null, ultimoEncontro: null, licoesPendentes: [] };
    }
    pageId  = found.id;
    pageUrl = found.url;
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

// ─── BOOTSTRAP NOTION PAGE IDs (admin — uma vez) ─────────────────────────────

/**
 * Percorre todas as mentoradas sem notionPageId e tenta descobrir a página Notion.
 * Admin only. Retorna { ok, atualizadas, falhas }.
 */
exports.bootstrapNotionPageIds = onCall({ secrets: [sNotion] }, async (request) => {
  requireAdmin(request);

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  const snap = await db.collection('mentoradas').get();
  let atualizadas = 0, falhas = 0;

  for (const doc of snap.docs) {
    const { nome, notionPageId } = doc.data();
    if (notionPageId || !nome) continue;

    const found = await buscarPaginaNotionPorNome(nome, headers);
    if (found) {
      await doc.ref.update({ notionPageId: found.id }).catch(() => {});
      atualizadas++;
      console.log(`[bootstrapNotionPageIds] ✓ ${nome} → ${found.id}`);
    } else {
      falhas++;
      console.warn(`[bootstrapNotionPageIds] ✗ ${nome} — não encontrada`);
    }
  }

  return { ok: true, atualizadas, falhas };
});

// ─── MINHA JORNADA (mentorada — jornada.html) ─────────────────────────────────

/**
 * getMinhaJornada — retorna todos os encontros da mentorada com lições pendentes e concluídas.
 * Acessível pela própria mentorada (ou admin visualizando como ela).
 *
 * Usa notionPageId cacheado no Firestore — a Flávia precisa ter chamado getNotionCRM
 * pelo menos uma vez para o cache existir. Se não houver cache, retorna erro amigável.
 *
 * Retorno:
 *   {
 *     encontros: [{ numero, tema, data, licoesPendentes: string[], licoesFeitas: string[] }],
 *     notionPageUrl: string | null,
 *     syncedAt: string | null,
 *   }
 */
exports.getMinhaJornada = onCall({ secrets: [sNotion] }, async (request) => {
  const auth = requireAuth(request);
  const uid  = request.data?.uid || auth.uid;
  requireSelfOrAdmin(request, uid);

  const docSnap = await db.collection('mentoradas').doc(uid).get();
  if (!docSnap.exists) throw new HttpsError('not-found', 'Mentorada não encontrada.');

  const { nome, notionPageId: cachedPageId, notionSyncedAt } = docSnap.data();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  let notionPageId = cachedPageId || null;
  console.log(`[getMinhaJornada] uid=${uid} nome="${nome}" cachedPageId=${cachedPageId || 'null'}`);

  // Sem cache: busca pelo nome no Notion (mesma lógica do getNotionCRM)
  if (!notionPageId && nome) {
    console.log(`[getMinhaJornada] buscando página para "${nome}" (uid=${uid})`);
    const found = await buscarPaginaNotionPorNome(nome, headers);
    if (found) {
      notionPageId = found.id;
      console.log(`[getMinhaJornada] pageId descoberto e cacheado: ${notionPageId}`);
      await db.collection('mentoradas').doc(uid).update({ notionPageId }).catch(() => {});
    }
  }

  if (!notionPageId) {
    return { encontros: [], notionPageUrl: null, syncedAt: null, semDados: true };
  }
  console.log(`[getMinhaJornada] lendo blocos do pageId: ${notionPageId}`);

  // Lê blocos da página (com paginação)
  const blocks = [];
  let cursor   = undefined;
  do {
    const url = `https://api.notion.com/v1/blocks/${notionPageId}/children?page_size=100`
      + (cursor ? `&start_cursor=${cursor}` : '');
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // pageId stale — limpa cache
      await db.collection('mentoradas').doc(uid).update({ notionPageId: null }).catch(() => {});
      throw new HttpsError('internal', `Notion falhou: ${err.message || res.status}. Peça à Flávia para sincronizar.`);
    }
    const page = await res.json();
    blocks.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  // Expande heading/toggle recursivamente: os encontros podem ser heading_2 toggleáveis,
  // e as seções internas (materiais, lições) podem ser heading_3 toggleáveis dentro deles.
  // Processa em profundidade para garantir que todos os níveis sejam expandidos.
  const expandedBlocks = [];
  const queue = [...blocks];
  while (queue.length) {
    const block = queue.shift();
    expandedBlocks.push(block);
    if (block.has_children &&
        (block.type === 'heading_1' || block.type === 'heading_2' || block.type === 'heading_3' ||
         block.type === 'toggle' || block.type === 'callout')) {
      const childRes = await fetch(
        `https://api.notion.com/v1/blocks/${block.id}/children?page_size=100`, { headers });
      if (childRes.ok) {
        const childPage = await childRes.json();
        const children = childPage.results || [];
        queue.unshift(...children);
      }
    }
  }

  // Parseia encontros — retorna TODOS com alinhamentos, lições e materiais
  const encontros     = [];
  let encontroAtual   = null;
  let emSecao         = null; // 'alinhamentos' | 'licao' | 'materiais' | null
  let mapaUrl         = null;
  let gravacaoUrl     = null;
  let alinhamentos    = [];
  let licoesPendentes = [];
  let licoesFeitas    = [];
  let materiais       = [];

  const pushEncontro = () => {
    if (encontroAtual) {
      encontros.push({ ...encontroAtual, mapaUrl, gravacaoUrl, alinhamentos, licoesPendentes, licoesFeitas, materiais });
    }
  };

  for (const block of expandedBlocks) {
    const type = block.type;

    if (type === 'heading_2') {
      const text  = getRichText(block.heading_2?.rich_text);
      const match = text.match(/Encontro\s+(\d+)\s*[|\\]\s*(.+?)\s*[|\\]\s*(.+)/i);
      if (match) {
        pushEncontro();
        encontroAtual   = { numero: parseInt(match[1], 10), tema: match[2].trim(), data: match[3].trim() };
        emSecao         = null;
        mapaUrl         = null; gravacaoUrl = null;
        alinhamentos    = []; licoesPendentes = []; licoesFeitas = []; materiais = [];
      }
      continue;
    }

    if (!encontroAtual) continue;

    if (type === 'heading_3' || type === 'toggle') {
      const text = getRichText(block[type]?.rich_text);
      if      (/alinhamento/i.test(text))                                                   emSecao = 'alinhamentos';
      else if (/li[çc][õaã]o?.*casa|compromisso/i.test(text))                              emSecao = 'licao';
      else if (/materi[ao]|recurso|entregáv|entregav|link|documento|arquivo/i.test(text))     emSecao = 'materiais';
      else                                                                                   emSecao = null;
      continue;
    }

    if (type === 'divider') { emSecao = null; continue; }

    // Paragraphs sem seção definida (logo após o heading do encontro) → links de mapa/gravação
    if (type === 'paragraph' && emSecao === null) {
      const rt   = block.paragraph?.rich_text || [];
      const text = getRichText(rt);
      const url  = getFirstHref(rt);
      if (url) {
        if (/mapa mental/i.test(text)) mapaUrl = url;
        else if (/grava[çc][aã]o/i.test(text)) gravacaoUrl = url;
      }
      continue;
    }

    if (type === 'bulleted_list_item' && emSecao === 'alinhamentos') {
      const text = getRichText(block.bulleted_list_item?.rich_text).trim();
      if (text) alinhamentos.push(text);
      continue;
    }

    if (type === 'to_do' && emSecao === 'licao') {
      const texto   = getRichText(block.to_do?.rich_text).trim();
      const checked = block.to_do?.checked === true;
      if (texto) {
        if (checked) licoesFeitas.push({ id: block.id, texto });
        else         licoesPendentes.push({ id: block.id, texto });
      }
      continue;
    }

    if (emSecao === 'materiais') {
      if (type === 'bulleted_list_item' || type === 'numbered_list_item') {
        const rt   = block[type]?.rich_text || [];
        const text = getRichText(rt).trim();
        const url  = getFirstHref(rt);
        if (text) materiais.push({ texto: text, url: url || null });
      } else if (type === 'paragraph') {
        const rt   = block.paragraph?.rich_text || [];
        const text = getRichText(rt).trim();
        const url  = getFirstHref(rt);
        if (text || url) materiais.push({ texto: text || url, url: url || null });
      } else if (type === 'bookmark') {
        const b    = block.bookmark;
        const text = getRichText(b?.caption).trim() || b?.url || 'Link';
        if (b?.url) materiais.push({ texto: text, url: b.url });
      } else if (type === 'link_preview' || type === 'embed') {
        const url = block[type]?.url;
        if (url) materiais.push({ texto: url, url });
      } else if (type === 'file') {
        const f    = block.file;
        const text = getRichText(f?.caption).trim() || 'Arquivo';
        const url  = f?.type === 'external' ? f.external?.url : f?.file?.url;
        if (url) materiais.push({ texto: text, url, arquivo: true });
      } else if (type === 'pdf') {
        const p    = block.pdf;
        const text = getRichText(p?.caption).trim() || 'PDF';
        const url  = p?.type === 'external' ? p.external?.url : p?.file?.url;
        if (url) materiais.push({ texto: text, url, arquivo: true });
      }
      continue;
    }
  }

  pushEncontro();

  console.log(`[getMinhaJornada] total de blocos: ${blocks.length}, encontros parseados: ${encontros.length}`);

  // Ordena do mais recente para o mais antigo
  encontros.sort((a, b) => b.numero - a.numero);

  const pageUrl = `https://notion.so/${notionPageId.replace(/-/g, '')}`;
  const syncedAt = notionSyncedAt?.toDate?.()?.toISOString?.() || null;

  return { encontros, notionPageUrl: pageUrl, syncedAt };
});

/**
 * Marca ou desmarca uma lição de casa no Notion (PATCH to_do block).
 */
exports.marcarLicaoCasa = onCall({ secrets: [sNotion] }, async (request) => {
  const auth = requireAuth(request);
  const uid  = request.data?.uid || auth.uid;
  requireSelfOrAdmin(request, uid);

  const { blockId, checked } = request.data;
  if (!blockId || typeof checked !== 'boolean') {
    throw new HttpsError('invalid-argument', 'blockId e checked são obrigatórios.');
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const res = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to_do: { checked } }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new HttpsError('internal', `Notion falhou: ${err.message || res.status}`);
  }

  return { ok: true };
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
  if (p.includes('combo'))    return 'Combo Dashboard + Clube R$97/mês';
  if (p.includes('clube'))    return 'Clube Trilogia (Fundadoras R$67/mês)';
  if (p.includes('dashboard') && !p.includes('combo')) return 'Dashboard Trilogia R$67/mês';
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
  // Comparação timing-safe (mesmo padrão do kiwifyWebhook) — evita vazar,
  // por tempo de resposta, quantos caracteres do secret o chamador acertou.
  // Hash os dois lados antes de comparar: assim os buffers têm sempre o
  // mesmo tamanho (32 bytes), sem precisar ramificar por tamanho do input.
  const crypto = require('crypto');
  const secret = String(req.body?.secret || '');
  const secretEsperado = sDiagSecret.value();
  const hashRecebido  = crypto.createHash('sha256').update(secret).digest();
  const hashEsperado  = crypto.createHash('sha256').update(secretEsperado).digest();
  if (!crypto.timingSafeEqual(hashRecebido, hashEsperado)) {
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

/**
 * backupFirestore — exporta o Firestore para o Cloud Storage semanalmente.
 * Roda todo domingo às 02h (Sao_Paulo).
 * Pré-requisito (1x manual via gcloud):
 *   gcloud projects add-iam-policy-binding trilogia-dashboard \
 *     --member="serviceAccount:$(gcloud projects describe trilogia-dashboard --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
 *     --role="roles/datastore.importExportAdmin"
 */
exports.backupFirestore = onSchedule(
  { schedule: '0 2 * * 0', timeZone: 'America/Sao_Paulo' },
  comMonitoramento('backupFirestore', async () => {
    const { GoogleAuth } = require('google-auth-library');
    const auth   = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const token  = await client.getAccessToken();

    const date   = new Date().toISOString().slice(0, 10);
    const bucket = `gs://trilogia-dashboard.appspot.com/firestore-backups/${date}`;

    const res = await fetch(
      'https://firestore.googleapis.com/v1/projects/trilogia-dashboard/databases/(default):exportDocuments',
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${token.token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ outputUriPrefix: bucket }),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Firestore export falhou: ${JSON.stringify(err)}`);
    }

    const result = await res.json();
    console.log(`[backupFirestore] Export iniciado para ${bucket}:`, result.name);
  })
);

/**
 * healthCheck — endpoint público para smoke tests pós-deploy.
 * Chamado pelo GitHub Actions após cada push na main.
 * Retorna ok:true enquanto a Cloud Function estiver rodando.
 */
exports.healthCheck = onRequest({ cors: false }, (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Expõe helpers internos puros só para teste (node:test) — não muda
// comportamento de produção, nenhum desses precisa de secrets ou Firestore.
exports._test = { _normCat, _resolverCategoria, _sugerirFatura, _mesPagamento, calcularScoreMes };
