'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const { requireAuth, requireAdmin, requireSelfOrAdmin, getSheetId } = require('./lib/auth');
const { SheetsClient } = require('./lib/sheets');
const { provisionar }  = require('./lib/provisionar');

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

  // Lê o doc Firestore para obter sheetId e o campo 'inicio'
  const docSnap = await db.collection('mentoradas').doc(uid).get();
  if (!docSnap.exists) {
    throw new HttpsError('not-found', `Mentorada não encontrada: ${uid}`);
  }
  const { sheetId, inicio } = docSnap.data();
  if (!sheetId) {
    throw new HttpsError('failed-precondition', 'Planilha ainda não configurada para esta mentorada.');
  }

  const sheets  = new SheetsClient(sheetId);

  const agora = new Date();
  const mes   = agora.getMonth() + 1;
  const ano   = agora.getFullYear();

  const [orcamento, patrimonio, investimentos, dividas, reservas, perfil] = await Promise.all([
    sheets.getOrcamento(mes, ano),
    sheets.getPatrimonio(),
    sheets.getInvestimentos(),
    sheets.getDividas(),
    sheets.getReservas(),
    sheets.getPerfil(),
  ]);

  // Consolida ativos = patrimônio declarado no IR + posição da corretora
  const ativosConsolidados = consolidarAtivos(patrimonio, investimentos);

  const totalAtivos  = ativosConsolidados.reduce((s, a) => s + a.valor, 0);
  const totalDividas = dividas.reduce((s, d) => s + d.saldo, 0);
  const receita      = orcamento.filter(i => i.tipo === 'receita').reduce((s, i) => s + i.valor, 0);
  const despesa      = orcamento.filter(i => i.tipo === 'despesa').reduce((s, i) => s + i.valor, 0);

  return {
    orcamento: { receita, despesa, sobra: receita - despesa, mes, ano },
    patrimonio: { ativos: totalAtivos, dividas: totalDividas, pl: totalAtivos - totalDividas },
    reservas,
    perfil,
    inicio: inicio || null,   // AAAA-MM (ex: "2025-03")
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

  const { nome, email, inicio, perfil } = request.data;
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
    inicio:    inicio || hoje().slice(0, 7), // AAAA-MM
    perfil:    perfil || null,
    status:    'ativa',
    sheetId,
    nota:      '',
    criadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 4. Enviar e-mail de redefinição de senha via Firebase Auth REST API
  const FIREBASE_API_KEY = 'AIzaSyCbgekmh90OPhr7DZJsVS-GXAYMOqtZ3Ds';
  await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
    }
  );

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

  const permitidos = ['status', 'nota', 'perfil', 'inicio'];
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
