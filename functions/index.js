'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
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
  emailCobrancasDia,
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
  const { sheetId, inicio, nome, perfil: perfilFirestore, lgpdAceite, ultimoAcessoMes } = docSnap.data();
  if (!sheetId) {
    throw new HttpsError('failed-precondition', 'Planilha ainda não configurada para esta mentorada.');
  }

  const agora    = new Date();
  const mes      = agora.getMonth() + 1;
  const ano      = agora.getFullYear();
  const mesAtual = agora.toISOString().slice(0, 7); // YYYY-MM

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
    nome:       nome       || null,
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
exports.getMentoradas = onCall({ cors: true }, async (request) => {
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
  try {
    const linkSenha = await admin.auth().generatePasswordResetLink(email);
    await sendEmail({
      to:      email,
      subject: 'Bem-vinda ao Trilogia Dashboard',
      html:    emailBoasVindas(nome, linkSenha),
    });
  } catch (err) {
    console.error(`[createMentorada] Falha ao enviar e-mail de boas-vindas para ${email}:`, err.message);
    // Conta criada com sucesso — admin pode reenviar o link manualmente pelo painel
  }

  return { uid: userRecord.uid, sheetId, emailEnviado: true };
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
exports.updateMentorada = onCall({ cors: true }, async (request) => {
  requireAdmin(request);

  const { uid, campos } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid é obrigatório.');

  const permitidos = [
    'status', 'nota', 'perfil', 'inicio',
    'produto', 'valorMensal', 'formaPagamento', 'dataExpiracao',
    'mentoriaEncerrada',
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
exports.bloquearMentorada = onCall({ cors: true }, async (request) => {
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
exports.reativarMentorada = onCall({ cors: true }, async (request) => {
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
exports.deletarMentorada = onCall({ cors: true }, async (request) => {
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
exports.registrarAcesso = onCall({ cors: true }, async (request) => {
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
exports.aceitarLGPD = onCall({ cors: true }, async (request) => {
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

exports.bootstrapAdmin = onCall({ cors: true }, async (request) => {
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
exports.setAdminClaim = onCall({ cors: true }, async (request) => {
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

// ─── CONTRATOS & COBRANÇAS ───────────────────────────────────────────────────

const ADMIN_EMAIL       = 'flaviasch@gmail.com';
const PRODUTOS_RECORRENTES = ['clube', 'dashboard'];

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
exports.createContrato = onCall({ cors: true }, async (request) => {
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
exports.getContratos = onCall({ cors: true }, async (request) => {
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
exports.pagarParcela = onCall({ cors: true }, async (request) => {
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
exports.editarPagamento = onCall({ cors: true }, async (request) => {
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
 * Cancela um contrato (não apaga histórico de cobranças pagas).
 */
exports.cancelarCobranca = onCall({ cors: true }, async (request) => {
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

exports.cancelarContrato = onCall({ cors: true }, async (request) => {
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
exports.editarContrato = onCall({ cors: true }, async (request) => {
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
 * uma das palavras-chave: mentoria, private, clube, dashboard).
 * Cobrança alvo: a não paga com vencimento no mês atual; se não houver,
 * a mais antiga não paga.
 *
 * Eventos aceitos: order_approved, subscription_payment,
 *                  order.approved, subscription.payment (variações de formato)
 */
exports.kiwifyWebhook = onRequest({ cors: false }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  try {
    const body = req.body || {};
    const event = (body.event || body.type || '').toLowerCase().replace('.', '_');

    // Aceita order_approved e subscription_payment
    const eventosAceitos = ['order_approved', 'subscription_payment', 'order_completed'];
    if (!eventosAceitos.includes(event)) {
      console.log(`[kiwify] Evento ignorado: ${event}`);
      res.status(200).json({ ok: true, msg: 'Evento ignorado.' });
      return;
    }

    const data = body.data || body;

    // Extrai e-mail do cliente
    const email = (
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
    const nomeProduto = (
      data?.product?.name ||
      data?.plan?.name ||
      data?.product_name ||
      ''
    ).toLowerCase();

    // Mapeia nome do produto para código interno
    let produtoCodigo = null;
    if (/mentoria|mentoring/i.test(nomeProduto))       produtoCodigo = 'mentoria';
    else if (/private/i.test(nomeProduto))             produtoCodigo = 'private';
    else if (/clube|club/i.test(nomeProduto))          produtoCodigo = 'clube';
    else if (/dashboard|dash/i.test(nomeProduto))      produtoCodigo = 'dashboard';

    // Extrai valor (Kiwify envia em centavos)
    const valorCentavos = (
      data?.charges?.[0]?.amount ||
      data?.charge?.amount ||
      data?.total_price ||
      data?.amount ||
      0
    );
    const valorRecebido = valorCentavos > 1000
      ? valorCentavos / 100   // converte centavos → reais
      : valorCentavos;        // já está em reais (alguns planos)

    const dataPagamento = new Date().toISOString().slice(0, 10);

    console.log(`[kiwify] Evento: ${event} | E-mail: ${email} | Produto: ${nomeProduto} (${produtoCodigo}) | Valor: R$${valorRecebido}`);

    // Busca mentorada pelo e-mail
    const mentSnap = await db.collection('mentoradas')
      .where('email', '==', email).limit(1).get();

    if (mentSnap.empty) {
      console.warn(`[kiwify] Mentorada não encontrada para e-mail: ${email}`);
      res.status(200).json({ ok: false, msg: `Mentorada não encontrada: ${email}` });
      return;
    }

    const uidMentorada = mentSnap.docs[0].id;

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
exports.getCobrancas = onCall({ cors: true }, async (request) => {
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
  { schedule: '0 8 * * *', timeZone: 'America/Sao_Paulo', secrets: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'] },
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
exports.getNotionCRM = onCall({ secrets: ['NOTION_TOKEN'] }, async (request) => {
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

  // ── 2. Ler os blocos da página ────────────────────────────────────────────
  const blocksRes = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
    { headers },
  );

  if (!blocksRes.ok) {
    const err = await blocksRes.json();
    // pageId pode estar stale — limpa o cache e tenta nova busca na próxima vez
    await db.collection('mentoradas').doc(uid).update({ notionPageId: null }).catch(() => {});
    throw new HttpsError('internal', `Notion blocks falhou: ${err.message || blocksRes.status}`);
  }

  const blocks = (await blocksRes.json()).results || [];

  // ── 3. Parsear encontros e lições ─────────────────────────────────────────
  // Varre todos os blocos e coleta todos os encontros.
  // Ao final, fica com o de maior número (mais recente).
  let encontros       = [];      // { numero, tema, data, licoes[] }
  let encontroAtual   = null;
  let licoesAtuais    = [];
  let emLicao         = false;

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
    }

    if (!encontroAtual) continue;

    // Heading 3 → sub-seções do encontro ("Lição de Casa", "Alinhamentos", etc.)
    if (type === 'heading_3') {
      const text = getRichText(block.heading_3?.rich_text);
      emLicao = /li[çc][aã]o\s+de\s+casa/i.test(text);
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

  return { notionPageUrl: pageUrl, ultimoEncontro, licoesPendentes };
});
