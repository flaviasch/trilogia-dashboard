'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

const { requireAuth, requireAdmin, requireSelfOrAdmin, getSheetId } = require('./lib/auth');
const { SheetsClient } = require('./lib/sheets');
const { provisionar }  = require('./lib/provisionar');
const {
  sendEmail,
  emailRenovacaoPerfil,
  emailSemPerfil,
  emailLembreteOrcamento,
  emailLembreteAporte,
  emailIR,
  emailReenvioAcesso,
  emailBoasVindas,
  emailExpiracaoProxima,
} = require('./lib/mailer');

admin.initializeApp();
const db = admin.firestore();

// Secrets declaradas explicitamente para que o runtime v2 as injete via env.
// GOOGLE_SERVICE_ACCOUNT_JSON: lê/escreve nas planilhas (SA compartilhada em provisionar)
// SECRETS_ALL: cria planilha via OAuth da Flávia + SA JSON p/ gravar o email de sharing
const SECRETS_SHEETS = ['GOOGLE_SERVICE_ACCOUNT_JSON'];
const SECRETS_ALL    = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
                        'DRIVE_FOLDER_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON'];

// ID da pasta no Google Drive da Flávia onde ficam as planilhas das mentoradas.
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hoje() {
  return new Date().toISOString().split('T')[0];
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
  const { sheetId, inicio, perfil: perfilFirestore, lgpdAceite } = docSnap.data();
  if (!sheetId) {
    throw new HttpsError('failed-precondition', 'Planilha ainda não configurada para esta mentorada.');
  }

  const agora = new Date();
  const mes   = agora.getMonth() + 1;
  const ano   = agora.getFullYear();

  // Fallback: dados da planilha zerados enquanto SA não tem acesso
  let orcamento = [], patrimonio = [], investimentos = [], dividas = [], reservas = [];
  let perfil     = { perfil: perfilFirestore || null, dataAtualizacao: null };
  let sheetError = false;

  // Encapsula a criação do cliente E a leitura das abas em try/catch unificado.
  // Se GOOGLE_SERVICE_ACCOUNT_JSON não estiver disponível ou a SA não tiver
  // permissão na planilha, o dashboard ainda carrega com dados do Firestore.
  try {
    const sheets = new SheetsClient(sheetId);

    const [orcResult, patResult, invResult, divResult, resResult, perfilResult] =
      await Promise.allSettled([
        sheets.getOrcamento(mes, ano),
        sheets.getPatrimonio(),
        sheets.getInvestimentos(),
        sheets.getDividas(),
        sheets.getReservas(),
        sheets.getPerfil(),
      ]);

    orcamento     = orcResult.status === 'fulfilled' ? orcResult.value : [];
    patrimonio    = patResult.status === 'fulfilled' ? patResult.value : [];
    investimentos = invResult.status === 'fulfilled' ? invResult.value : [];
    dividas       = divResult.status === 'fulfilled' ? divResult.value : [];
    reservas      = resResult.status === 'fulfilled' ? resResult.value : [];
    // Perfil da planilha sobrescreve o Firestore quando disponível
    if (perfilResult.status === 'fulfilled') perfil = perfilResult.value;

    sheetError = [orcResult, patResult, invResult, divResult, resResult, perfilResult]
      .some(r => r.status === 'rejected');
    if (sheetError) {
      const motivo = [orcResult, patResult, invResult, divResult, resResult, perfilResult]
        .find(r => r.status === 'rejected')?.reason?.message || 'desconhecido';
      console.warn(`[getDashboard] Falha parcial na planilha (uid=${uid}): ${motivo}`);
    }
  } catch (e) {
    // Exceção inesperada ao criar o cliente (ex: secret não configurado)
    sheetError = true;
    console.error(`[getDashboard] Erro ao inicializar SheetsClient (uid=${uid}): ${e.message}`);
  }

  // Consolida ativos = patrimônio declarado no IR + posição da corretora
  const ativosConsolidados = consolidarAtivos(patrimonio, investimentos);

  const totalAtivos  = ativosConsolidados.reduce((s, a) => s + a.valor, 0);
  const totalDividas = dividas.reduce((s, d) => s + d.saldo, 0);
  const receita      = orcamento.filter(i => i.tipo === 'receita').reduce((s, i) => s + i.valor, 0);
  const despesa      = orcamento.filter(i => i.tipo === 'despesa').reduce((s, i) => s + i.valor, 0);

  const pl           = totalAtivos - totalDividas;
  const sobra        = receita - despesa;
  const totalReservas = reservas.reduce((s, r) => s + (r.acumulado || 0), 0);

  // Cacheia snapshot financeiro no Firestore para o painel admin.
  // Executa em background — não bloqueia a resposta para a aluna.
  docSnap.ref.update({
    pl,
    sobra,
    totalReservas,
    dadosAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.warn(`[getDashboard] Falha ao cachear snapshot (uid=${uid}):`, e.message));

  return {
    orcamento: { receita, despesa, sobra, mes, ano },
    patrimonio: { ativos: totalAtivos, dividas: totalDividas, pl },
    reservas,
    perfil,
    inicio:     inicio     || null,
    lgpdAceite: lgpdAceite || false,
    sheetError: sheetError,
  };
});

// ─── ORÇAMENTO (orcamento.html) ───────────────────────────────────────────────

exports.getOrcamento = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, mes, ano } = request.data;
  requireSelfOrAdmin(request, uid);

  const sheetId = await getSheetId(db, uid);
  const sheets  = new SheetsClient(sheetId);
  return sheets.getOrcamento(mes, ano);
});

/**
 * Salva itens de orçamento importados do CSV do Raio-X.
 * Espera: { uid, mes, ano, itens: [{ categoria, tipo, valor }] }
 */
exports.saveOrcamento = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, mes, ano, itens } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!Array.isArray(itens)) throw new HttpsError('invalid-argument', 'itens deve ser um array.');

  const sheetId = await getSheetId(db, uid);
  const sheets  = new SheetsClient(sheetId);
  await sheets.saveOrcamento(mes, ano, itens);
  return { ok: true };
});

// ─── PATRIMÔNIO (patrimonio.html) ─────────────────────────────────────────────

exports.getPatrimonio = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);

  const sheetId = await getSheetId(db, uid);
  const sheets  = new SheetsClient(sheetId);
  const [patrimonio, investimentos, dividas] = await Promise.all([
    sheets.getPatrimonio(),
    sheets.getInvestimentos(),
    sheets.getDividas(),
  ]);

  const ativos = consolidarAtivos(patrimonio, investimentos);
  return { ativos, dividas };
});

exports.savePatrimonio = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, itens, tipo } = request.data; // tipo: 'ir' | 'corretora'
  requireSelfOrAdmin(request, uid);

  if (!Array.isArray(itens)) throw new HttpsError('invalid-argument', 'itens deve ser um array.');

  const sheetId = await getSheetId(db, uid);
  const sheets  = new SheetsClient(sheetId);

  if (tipo === 'corretora') {
    await sheets.saveInvestimentos(itens);
  } else {
    await sheets.savePatrimonio(itens);
  }
  return { ok: true };
});

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

  if (!classe || typeof valor !== 'number' || valor <= 0) {
    throw new HttpsError('invalid-argument', 'classe e valor são obrigatórios.');
  }

  const sheetId = await getSheetId(db, uid);
  const sheets  = new SheetsClient(sheetId);

  const [patrimonio, investimentos] = await Promise.all([
    sheets.getPatrimonio(),
    sheets.getInvestimentos(),
  ]);

  const classeLC = classe.toLowerCase();

  // Investimentos tem prioridade no consolidado — atualiza lá se já existir
  const idxInv = investimentos.findIndex(i => i.classe.toLowerCase() === classeLC);
  if (idxInv !== -1) {
    investimentos[idxInv].valor += valor;
    await sheets.saveInvestimentos(investimentos);
  } else {
    // Classe está em patrimônio (IR) ou é nova — grava em patrimônio
    const idxPat = patrimonio.findIndex(i => i.classe.toLowerCase() === classeLC);
    if (idxPat !== -1) {
      patrimonio[idxPat].valor += valor;
    } else {
      patrimonio.push({ classe, valor });
    }
    await sheets.savePatrimonio(patrimonio);
  }

  // Upsert histórico com o total consolidado
  const consolidado = consolidarAtivos(patrimonio, investimentos);
  const totalAtivos = consolidado.reduce((s, i) => s + i.valor, 0);
  const data = hoje().slice(0, 7);
  await sheets.upsertHistorico(data, totalAtivos, 0);

  return { ok: true };
});

// ─── HISTÓRICO DE PL ─────────────────────────────────────────────────────────

exports.getHistoricoPatrimonio = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);

  const sheetId = await getSheetId(db, uid);
  return new SheetsClient(sheetId).getHistorico();
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

  const data = hoje().slice(0, 7); // AAAA-MM
  const sheetId = await getSheetId(db, uid);
  await new SheetsClient(sheetId).upsertHistorico(data, ativos ?? 0, dividas ?? 0);
  return { ok: true };
});

// ─── DÍVIDAS ──────────────────────────────────────────────────────────────────

exports.saveDivida = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, divida } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!divida?.id || !divida?.nome) {
    throw new HttpsError('invalid-argument', 'id e nome são obrigatórios.');
  }

  const sheetId = await getSheetId(db, uid);
  await new SheetsClient(sheetId).saveDivida(divida);
  return { ok: true };
});

exports.deleteDivida = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, dividaId } = request.data;
  requireSelfOrAdmin(request, uid);

  const sheetId = await getSheetId(db, uid);
  await new SheetsClient(sheetId).deleteDivida(dividaId);
  return { ok: true };
});

// ─── RESERVAS (reservas.html) ─────────────────────────────────────────────────

exports.getReservas = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);

  const sheetId = await getSheetId(db, uid);
  return new SheetsClient(sheetId).getReservas();
});

exports.saveReserva = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, reserva } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!reserva?.id || !reserva?.nome) {
    throw new HttpsError('invalid-argument', 'id e nome são obrigatórios.');
  }

  const sheetId = await getSheetId(db, uid);
  await new SheetsClient(sheetId).saveReserva(reserva);
  return { ok: true };
});

exports.deleteReserva = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, reservaId } = request.data;
  requireSelfOrAdmin(request, uid);

  const sheetId = await getSheetId(db, uid);
  await new SheetsClient(sheetId).deleteReserva(reservaId);
  return { ok: true };
});

// ─── PERFIL DE INVESTIDOR (perfil.html) ───────────────────────────────────────

exports.getPerfil = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid } = request.data;
  requireSelfOrAdmin(request, uid);

  const sheetId = await getSheetId(db, uid);
  return new SheetsClient(sheetId).getPerfil();
});

exports.savePerfil = onCall({ secrets: SECRETS_SHEETS }, async (request) => {
  const auth = requireAuth(request);
  const { uid, perfil } = request.data;
  requireSelfOrAdmin(request, uid);

  if (!perfil) throw new HttpsError('invalid-argument', 'perfil é obrigatório.');

  const sheetId = await getSheetId(db, uid);
  await new SheetsClient(sheetId).savePerfil(perfil, hoje());

  // Espelha no Firestore para servir de fallback no getDashboard
  // quando a planilha estiver temporariamente inacessível.
  await db.collection('mentoradas').doc(uid).update({ perfil });

  return { ok: true };
});

// ─── ADMIN — Mentoradas (admin.html) ──────────────────────────────────────────

/**
 * Retorna a lista de todas as mentoradas com dados resumidos.
 * Exclusivo para admin.
 */
exports.getMentoradas = onCall(async (request) => {
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

  // 2. Criar planilha no Google Sheets
  const sheetId = await provisionar(nome, DRIVE_FOLDER_ID);

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
    sheetId,
    nota:            '',
    ultimoAcesso:    null,
    totalAcessos:    0,
    lgpdAceite:      false,
    lgpdAceiteData:  null,
    criadoEm:        admin.firestore.FieldValue.serverTimestamp(),
  });

  // 4. Gerar link de redefinição de senha
  const linkSenha = await admin.auth().generatePasswordResetLink(email);

  // 5. Enviar e-mail de boas-vindas com o link
  await sendEmail({
    to:      email,
    subject: 'Bem-vinda ao Trilogia Dashboard',
    html:    emailBoasVindas(nome, linkSenha),
  });

  return { uid: userRecord.uid, sheetId };
});

/**
 * Atualiza campos editáveis de uma mentorada (status, nota, perfil).
 * Exclusivo para admin.
 */
exports.updateMentorada = onCall(async (request) => {
  requireAdmin(request);

  const { uid, campos } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  const permitidos = [
    'status', 'nota', 'perfil', 'inicio',
    'produto', 'valorMensal', 'formaPagamento', 'dataExpiracao',
  ];
  const atualizacao = {};
  for (const [k, v] of Object.entries(campos || {})) {
    if (permitidos.includes(k)) atualizacao[k] = v;
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
exports.bloquearMentorada = onCall(async (request) => {
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
exports.reativarMentorada = onCall(async (request) => {
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
exports.deletarMentorada = onCall(async (request) => {
  requireAdmin(request);

  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  // Apaga conta Auth (ignora se já não existir)
  try {
    await admin.auth().deleteUser(uid);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') {
      throw new HttpsError('internal', `Erro ao remover conta: ${err.message}`);
    }
    // Se já não existia no Auth, continua para limpar o Firestore
  }

  // Apaga documento Firestore
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
exports.reenviarAcesso = onCall({ secrets: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'] }, async (request) => {
  requireAdmin(request);

  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  const userRecord = await admin.auth().getUser(uid);
  if (!userRecord.email) throw new HttpsError('failed-precondition', 'Mentorada sem e-mail cadastrado.');

  const link = await admin.auth().generatePasswordResetLink(userRecord.email);

  const snap = await db.collection('mentoradas').doc(uid).get();
  const nome = snap.exists ? (snap.data().nome || userRecord.displayName || 'Mentorada') : (userRecord.displayName || 'Mentorada');

  await sendEmail({
    to: userRecord.email,
    subject: 'Seu link de acesso — Trilogia Dashboard',
    html: emailReenvioAcesso(nome, link),
  });

  return { ok: true };
});

/**
 * Registra acesso da aluna: atualiza ultimoAcesso e incrementa contadores.
 * Chamado pelo client no load do dashboard.
 */
exports.registrarAcesso = onCall(async (request) => {
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
 * Registra aceite do termo LGPD pela aluna.
 */
exports.aceitarLGPD = onCall(async (request) => {
  const auth = requireAuth(request);
  await db.collection('mentoradas').doc(auth.uid).update({
    lgpdAceite:     true,
    lgpdAceiteData: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

// ─── ADMIN — Bootstrap inicial ───────────────────────────────────────────────

/**
 * Auto-configura a claim admin=true para a conta master (flaviasch@gmail.com).
 * Chamado uma vez pelo próprio usuário master quando ainda não tem a claim.
 * Não exige claim prévia — verifica o e-mail diretamente no token JWT.
 */
const ADMIN_MASTER_EMAIL = 'flaviasch@gmail.com';

exports.bootstrapAdmin = onCall(async (request) => {
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
exports.setAdminClaim = onCall(async (request) => {
  requireAdmin(request);

  const { uid, conceder } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  // Nunca remova sua própria claim de admin acidentalmente
  if (uid === request.auth.uid && conceder === false) {
    throw new HttpsError('failed-precondition', 'Você não pode remover seu próprio acesso admin.');
  }

  const user          = await admin.auth().getUser(uid);
  const claimsAtuais  = user.customClaims || {};
  await admin.auth().setCustomUserClaims(uid, { ...claimsAtuais, admin: conceder === true });

  return { ok: true, uid, admin: conceder === true };
});

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Consolida patrimônio do IR com posição atual da corretora.
 * Usa o valor mais recente para cada classe de ativo.
 */
function consolidarAtivos(patrimonioIR, investimentos) {
  const mapa = {};

  for (const item of patrimonioIR) {
    mapa[item.classe] = { ...item };
  }

  for (const item of investimentos) {
    // Posição da corretora sobrescreve o IR para classes de ativos financeiros
    if (item.valor > 0) mapa[item.classe] = { ...item };
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

const SECRETS_EMAIL = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];

/**
 * Dia 1 de cada mês às 08h (Brasília):
 *   • Lembrete de orçamento (todas as ativas)
 *   • Renovação de perfil (perfil ausente ou > 180 dias)
 */
exports.notifDia1 = onSchedule(
  { schedule: '0 8 1 * *', timeZone: 'America/Sao_Paulo', secrets: SECRETS_EMAIL },
  async () => {
    const agora   = new Date();
    const mes     = agora.getMonth() + 1;
    const ano     = agora.getFullYear();
    const nomesMes = nomeMesPt(mes, ano);

    const mentoradas = await getAtivas();

    for (const m of mentoradas) {
      if (!m.email) continue;
      const tarefas = [];

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
  },
);

/**
 * Dia 28 de cada mês às 08h (Brasília):
 *   • Lembrete de aporte (todas as ativas)
 */
exports.notifDia28 = onSchedule(
  { schedule: '0 8 28 * *', timeZone: 'America/Sao_Paulo', secrets: SECRETS_EMAIL },
  async () => {
    const agora    = new Date();
    const mes      = agora.getMonth() + 1;
    const ano      = agora.getFullYear();
    const nomesMes = nomeMesPt(mes, ano);

    const mentoradas = await getAtivas();

    for (const m of mentoradas) {
      if (!m.email) continue;
      await sendEmail({
        to:      m.email,
        subject: `Efetive o aporte de ${nomesMes}`,
        html:    emailLembreteAporte(m.nome || 'mentorada', nomesMes),
      }).catch(err => console.error(`Erro ao enviar aporte para ${m.email}:`, err));
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
 * verificarExpiracoes — diariamente às 07h (Sao_Paulo)
 * Inativa contas cuja dataExpiracao já passou.
 */
exports.verificarExpiracoes = onSchedule(
  { schedule: '0 7 * * *', timeZone: 'America/Sao_Paulo' },
  async () => {
    const hoje = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const snap = await db.collection('mentoradas')
      .where('status', '==', 'ativa')
      .where('dataExpiracao', '<=', hoje)
      .get();

    for (const doc of snap.docs) {
      const { dataExpiracao } = doc.data();
      if (!dataExpiracao) continue; // sem expiração definida: ignora
      await admin.auth().updateUser(doc.id, { disabled: true }).catch(() => {});
      await doc.ref.update({ status: 'inativa' });
      console.log(`Conta expirada e inativada: ${doc.id} (${dataExpiracao})`);
    }
  },
);

/**
 * notifExpiracaoProxima — diariamente às 08h (Sao_Paulo)
 * Avisa alunas cuja dataExpiracao é daqui a 7 dias.
 */
exports.notifExpiracaoProxima = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'America/Sao_Paulo', secrets: SECRETS_EMAIL },
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
      await sendEmail({
        to:      m.email,
        subject: 'Seu acesso ao Dashboard expira em 7 dias',
        html:    emailExpiracaoProxima(m.nome || 'mentorada'),
      }).catch(err => console.error(`Erro ao enviar expiração para ${m.email}:`, err));
    }
  },
);
