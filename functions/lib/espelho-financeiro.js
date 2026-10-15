'use strict';

// ─── Espelho Financeiro: admin (contratos/cobranças) ↔ Dashboard PJ da Flávia ─
// Pedido 15/10/2026 (Flávia): "o que fizesse em um, espelhasse no outro".
// Regras de negócio confirmadas por ela:
//   - toda venda do admin vira nota no PJ dela;
//   - nota emitida na compra, valor cheio (contrato parcelado = 1 nota com N
//     recebimentos); assinatura (recorrente) = 1 nota por mês, na compra/pagamento;
//   - pix/transferência: "pago" no admin = "recebido" no PJ; Kiwify/outro: no PJ
//     só fica recebido quando ela confirma que o dinheiro caiu (com a taxa real);
//   - contrato cancelado depois da nota: só avisa pra cancelar a NF, não mexe na nota;
//   - notas que não são de mentorada ficam fora do espelho.
//
// Mecanismo: dois gatilhos do Firestore (cobrança mudou / recebimento mudou).
// Cada lado só escreve no "gêmeo" se o que ele quer copiar estiver diferente,
// então o eco do outro gatilho encontra tudo igual e para (sem loop). Criação
// usa ID determinístico + create(), então evento repetido não duplica.
// Vínculo explícito: cobrança.{notaId, recebimentoId} ↔ recebimento.cobrancaId.
// `espelhoPJ: false` numa cobrança/contrato desliga o espelho só dela.
//
// Liga/desliga em config/espelhoFinanceiro:
//   { modo: 'desligado'|'teste'|'ligado', uidPJ, desde, uidsTeste, desdeTeste }
// Só entra no espelho o que nasceu DEPOIS de ligar (parcelado: contrato criado
// depois; recorrente: pagamento depois) — histórico fica de fora de propósito.

const FORMAS_INSTANTANEAS = ['pix', 'transferencia'];
const PRAZO_DIFERIDO_DIAS = { kiwify: 30 };

function _cent(v) { return Math.round((Number(v) || 0) * 100); }
function _reais(c) { return c / 100; }
function _somarDias(iso, dias) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
function hojeSP() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}
function _iso(ts) {
  if (!ts) return null;
  if (typeof ts === 'string') return ts;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return null;
}

function formaInstantanea(formaAdmin) { return FORMAS_INSTANTANEAS.includes(formaAdmin); }
function formaPJ(formaAdmin) { return formaAdmin === 'pix' ? 'pix' : 'outro'; }
function formaAdmin(formaPj) { return formaPj === 'pix' ? 'pix' : 'outro'; }

/** Cobrança deste uid entra no espelho? Devolve o "desde" que vale pra ela, ou null. */
function limiarEspelho(config, uidMentorada) {
  if (!config || !config.uidPJ) return null;
  if (Array.isArray(config.uidsTeste) && config.uidsTeste.includes(uidMentorada) &&
      (config.modo === 'teste' || config.modo === 'ligado')) {
    return config.desdeTeste || config.desde || null;
  }
  if (config.modo === 'ligado') return config.desde || null;
  return null;
}

/**
 * Campos que o recebimento gêmeo deveria ter, dado o estado da cobrança.
 * Só os campos que o admin governa: datas e dinheiro. Forma e nº da parcela
 * só são escritos na criação (o PJ pode refinar a forma, ex: crédito).
 */
function planoRecebimento(cob, twin) {
  const instant = formaInstantanea(cob.formaPagamento);
  const recebidoPJ = twin && twin.dataRecebimento ? twin.dataRecebimento : null;
  const d = { clienteNome: cob.nomeAluna || null };

  if (!cob.pago) {
    // Taxa estimada é coisa do PJ (adquirente) — mantém a que estiver lá.
    const taxaC = Math.min(_cent(twin ? twin.taxa : 0), _cent(cob.valor));
    d.dataPrevista = cob.vencimento;
    d.dataRecebimento = null;
    d.valorBruto = _reais(_cent(cob.valor));
    d.taxa = _reais(taxaC);
    d.valorLiquido = _reais(_cent(cob.valor) - taxaC);
    return d;
  }

  const vrC = _cent(cob.valorRecebido != null ? cob.valorRecebido : cob.valor);
  if (instant) {
    d.dataRecebimento = cob.dataPagamento;
    d.dataPrevista = (twin && twin.dataPrevista) || cob.vencimento;
  } else {
    d.dataRecebimento = recebidoPJ;
    d.dataPrevista = recebidoPJ
      ? ((twin && twin.dataPrevista) || cob.vencimento)
      : _somarDias(cob.dataPagamento || cob.vencimento, PRAZO_DIFERIDO_DIAS[cob.formaPagamento] || 0);
  }
  if (twin && twin.dataRecebimento && _cent(twin.valorLiquido) === vrC) {
    // Mesmo líquido: preserva a divisão bruto/taxa que a Flávia digitou no PJ.
    d.valorBruto = twin.valorBruto; d.taxa = twin.taxa || 0; d.valorLiquido = twin.valorLiquido;
  } else {
    const brutoC = Math.max(_cent(cob.valor), vrC);
    d.valorBruto = _reais(brutoC);
    d.taxa = _reais(brutoC - vrC);
    d.valorLiquido = _reais(vrC);
  }
  return d;
}

/**
 * O que fazer na cobrança, dado o estado do recebimento gêmeo.
 * Devolve { acao: 'nada'|'pagar'|'estornar'|'atualizar', ... }.
 */
function planoCobranca(rec, cob) {
  if (!cob || cob.cancelada) return { acao: 'nada' };
  const instant = formaInstantanea(cob.formaPagamento);
  if (rec.dataRecebimento) {
    if (!cob.pago) return { acao: 'pagar', dataPagamento: rec.dataRecebimento, valorRecebido: rec.valorLiquido };
    const upd = {};
    if (_cent(rec.valorLiquido) !== _cent(cob.valorRecebido)) upd.valorRecebido = rec.valorLiquido;
    if (instant && rec.dataRecebimento !== cob.dataPagamento) upd.dataPagamento = rec.dataRecebimento;
    return Object.keys(upd).length ? { acao: 'atualizar', upd } : { acao: 'nada' };
  }
  if (cob.pago) return instant ? { acao: 'estornar' } : { acao: 'nada' };
  const upd = {};
  if (rec.dataPrevista && rec.dataPrevista !== cob.vencimento) upd.vencimento = rec.dataPrevista;
  if (_cent(rec.valorBruto) !== _cent(cob.valor)) upd.valor = rec.valorBruto;
  return Object.keys(upd).length ? { acao: 'atualizar', upd } : { acao: 'nada' };
}

/** Só os campos de `desejado` que diferem de `atual` (centavos e null≈undefined). */
function diferencas(desejado, atual) {
  const out = {};
  Object.keys(desejado).forEach(k => {
    const a = atual ? atual[k] : undefined, b = desejado[k];
    const igual = (typeof b === 'number' || typeof a === 'number')
      ? _cent(a) === _cent(b) && (a == null) === (b == null)
      : (a ?? null) === (b ?? null);
    if (!igual) out[k] = b;
  });
  return out;
}

/**
 * Alerta de uma nota espelhada (cancelar/ajustar NF), ou null.
 * `contrato` pro parcelado, `cobranca` pro recorrente.
 */
function alertaNota(nota, contrato, cobranca) {
  if (nota.contratoTipo === 'parcelado') {
    if (!contrato) return { codigo: 'contrato-apagado', texto: 'O contrato desta nota não existe mais. Cancele a NF se a venda não aconteceu.' };
    if (contrato.status === 'cancelado') return { codigo: 'contrato-cancelado', texto: 'Contrato cancelado. Cancele ou substitua a NF na prefeitura.' };
    if (_cent(contrato.valorTotal) !== _cent(nota.valor)) {
      return { codigo: `valor-${_cent(contrato.valorTotal)}`, texto: `Valor do contrato mudou para R$ ${(_cent(contrato.valorTotal) / 100).toFixed(2).replace('.', ',')}. Substitua a NF e ajuste a nota no PJ.` };
    }
    return null;
  }
  if (!cobranca) return { codigo: 'cobranca-apagada', texto: 'A cobrança desta nota não existe mais. Cancele a NF se a venda não aconteceu.' };
  if (cobranca.cancelada) return { codigo: 'cobranca-cancelada', texto: 'Cobrança cancelada. Cancele a NF na prefeitura.' };
  if (!cobranca.pago) return { codigo: 'cobranca-estornada', texto: 'Pagamento estornado no admin. Cancele a NF se a venda não aconteceu.' };
  return null;
}

/**
 * Handlers com acesso ao Firestore. `aplicarPagamento(cobRef, cob, data, valor)`
 * vem do index.js (mesmo caminho do pagarParcela: libera acesso, gera próxima
 * recorrente, quita contrato) e `regerarImpostos(uid, mes, ano)` idem.
 */
function criarEspelho({ db, FieldValue, aplicarPagamento, regerarImpostos, log = console }) {
  const configRef = () => db.collection('config').doc('espelhoFinanceiro');

  async function lerConfig() {
    const snap = await configRef().get();
    return snap.exists ? snap.data() : null;
  }

  function recRef(notaId, recId) {
    return db.collection('notasEmitidas').doc(notaId).collection('recebimentos').doc(recId);
  }

  async function _criar(ref, dados) {
    try { await ref.create(dados); return true; }
    catch (e) { if (e.code === 6 || /already exists/i.test(e.message || '')) return false; throw e; }
  }

  async function _garantirNota(notaId, dados) {
    const ref = db.collection('notasEmitidas').doc(notaId);
    const criou = await _criar(ref, { ...dados, criadoEm: FieldValue.serverTimestamp() });
    if (criou) await regerarImpostos(dados.uid, dados.mes, dados.ano);
    return ref;
  }

  /** Gatilho: cobrancas/{cobId} mudou. */
  async function aoMudarCobranca(cobId, antes, depois) {
    const config = await lerConfig();
    if (!config || !config.uidPJ || config.modo === 'desligado' || !config.modo) return 'desligado';

    if (!depois) {
      // Cobrança apagada (editarContrato recria parcelas, deletarMentorada):
      // some o gêmeo pendente; o já recebido fica (é dinheiro que entrou), só sem vínculo.
      if (!antes || !antes.recebimentoId || !antes.notaId) return 'sem-gemeo';
      const ref = recRef(antes.notaId, antes.recebimentoId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().cobrancaId !== cobId) return 'sem-gemeo';
      if (snap.data().dataRecebimento) { await ref.update({ cobrancaId: null, espelhoPJ: false }); return 'desvinculado'; }
      await ref.delete();
      return 'gemeo-apagado';
    }

    const cob = depois;
    if (cob.espelhoPJ === false) return 'optout';
    const desde = limiarEspelho(config, cob.uidMentorada);
    const vinculada = !!(cob.recebimentoId && cob.notaId);
    if (!desde && !vinculada) return 'fora';

    if (vinculada) {
      const ref = recRef(cob.notaId, cob.recebimentoId);
      const snap = await ref.get();
      if (!snap.exists) return 'gemeo-sumiu'; // apagado no PJ: o outro gatilho já cancelou a cobrança
      const twin = snap.data();
      if (cob.cancelada) {
        if (!twin.dataRecebimento) { await ref.delete(); return 'gemeo-apagado'; }
        return 'nada';
      }
      const diff = diferencas(planoRecebimento(cob, twin), twin);
      if (!Object.keys(diff).length) return 'igual';
      await ref.update({ ...diff, sincronizadoEm: FieldValue.serverTimestamp(), origemSync: 'admin' });
      return 'atualizado';
    }

    // Ainda sem gêmeo: cria (se elegível).
    if (cob.cancelada) return 'fora';
    const uidPJ = config.uidPJ;
    let notaId, nota;
    if (cob.tipo === 'parcelado') {
      const ctrSnap = await db.collection('mentoradas').doc(cob.uidMentorada)
        .collection('contratos').doc(cob.contratoId).get();
      if (!ctrSnap.exists) return 'fora';
      const ctr = ctrSnap.data();
      if (ctr.espelhoPJ === false || ctr.status === 'cancelado') return 'fora';
      const criado = _iso(ctr.criadoEm);
      if (!criado || criado < desde) return 'fora';
      const dataEmissao = criado ? new Date(criado).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) : hojeSP();
      notaId = `ctr_${cob.contratoId}`;
      nota = { valor: _reais(_cent(ctr.valorTotal)), dataEmissao, contratoTipo: 'parcelado' };
    } else {
      if (!cob.pago || !cob.dataPagamento) return 'fora';
      if (cob.dataPagamento < desde.slice(0, 10)) return 'fora';
      notaId = `cob_${cobId}`;
      nota = { valor: _reais(_cent(cob.valor)), dataEmissao: cob.dataPagamento, contratoTipo: 'recorrente', cobrancaId: cobId };
    }
    const [ano, mes] = nota.dataEmissao.split('-').map(Number);
    await _garantirNota(notaId, {
      uid: uidPJ, mes, ano, ...nota,
      contratoId: cob.contratoId || null, uidMentorada: cob.uidMentorada,
      clienteNome: cob.nomeAluna || null, produto: cob.produto || null,
      origem: 'espelho-admin',
    });

    const recId = `cob_${cobId}`;
    const ref = recRef(notaId, recId);
    const desejado = planoRecebimento(cob, null);
    const parcelado = cob.tipo === 'parcelado' && (cob.total || 1) > 1;
    await _criar(ref, {
      uid: uidPJ, cobrancaId: cobId, ...desejado,
      formaPagamento: formaPJ(cob.formaPagamento),
      parcelaAtual: parcelado ? cob.numero : null,
      parcelaTotal: parcelado ? cob.total : null,
      dataEmissaoNota: nota.dataEmissao,
      criadoEm: FieldValue.serverTimestamp(), origemSync: 'admin',
    });
    await db.collection('cobrancas').doc(cobId).update({ notaId, recebimentoId: recId });
    return 'criado';
  }

  /** Gatilho: notasEmitidas/{notaId}/recebimentos/{recId} mudou. */
  async function aoMudarRecebimento(notaId, recId, antes, depois) {
    const config = await lerConfig();
    if (!config || !config.uidPJ || config.modo === 'desligado' || !config.modo) return 'desligado';

    if (!depois) {
      if (!antes || !antes.cobrancaId) return 'sem-gemeo';
      const ref = db.collection('cobrancas').doc(antes.cobrancaId);
      const snap = await ref.get();
      if (!snap.exists) return 'sem-gemeo';
      const cob = snap.data();
      if (cob.recebimentoId !== recId) return 'sem-gemeo';
      if (cob.cancelada) return 'nada';
      if (!cob.pago) { await ref.update({ cancelada: true, origemSync: 'pj' }); return 'cancelada'; }
      await ref.update({ espelhoPJ: false, notaId: FieldValue.delete(), recebimentoId: FieldValue.delete() });
      return 'desvinculado';
    }

    const rec = depois;
    if (rec.espelhoPJ === false) return 'optout';
    if (rec.cobrancaId) {
      const ref = db.collection('cobrancas').doc(rec.cobrancaId);
      const snap = await ref.get();
      if (!snap.exists) return 'sem-gemeo';
      const cob = snap.data();
      if (cob.recebimentoId !== recId || cob.espelhoPJ === false) return 'sem-gemeo';
      const plano = planoCobranca(rec, cob);
      if (plano.acao === 'pagar') {
        await aplicarPagamento(ref, cob, plano.dataPagamento, plano.valorRecebido);
        return 'pago';
      }
      if (plano.acao === 'estornar') {
        await ref.update({ pago: false, dataPagamento: FieldValue.delete(), valorRecebido: FieldValue.delete(), origemSync: 'pj' });
        if (cob.contratoId && cob.uidMentorada) {
          const ctrRef = db.collection('mentoradas').doc(cob.uidMentorada).collection('contratos').doc(cob.contratoId);
          const ctr = await ctrRef.get();
          if (ctr.exists && ctr.data().status === 'quitado') await ctrRef.update({ status: 'ativo' });
        }
        return 'estornado';
      }
      if (plano.acao === 'atualizar') { await ref.update({ ...plano.upd, origemSync: 'pj' }); return 'atualizado'; }
      return 'igual';
    }

    // Recebimento novo sem vínculo numa nota espelhada de contrato parcelado
    // ("+ Adicionar recebimento" ou "Editar formato" no PJ): vira cobrança nova.
    const notaSnap = await db.collection('notasEmitidas').doc(notaId).get();
    if (!notaSnap.exists) return 'fora';
    const nota = notaSnap.data();
    if (nota.origem !== 'espelho-admin' || nota.contratoTipo !== 'parcelado' || !nota.contratoId || !nota.uidMentorada) return 'fora';
    const ctrSnap = await db.collection('mentoradas').doc(nota.uidMentorada).collection('contratos').doc(nota.contratoId).get();
    if (!ctrSnap.exists || ctrSnap.data().espelhoPJ === false || ctrSnap.data().status === 'cancelado') return 'fora';
    const mSnap = await db.collection('mentoradas').doc(nota.uidMentorada).get();
    const m = mSnap.exists ? mSnap.data() : {};
    const cobId = `rec_${recId}`;
    const recebido = !!rec.dataRecebimento;
    const criou = await _criar(db.collection('cobrancas').doc(cobId), {
      uidMentorada: nota.uidMentorada, nomeAluna: m.nome || nota.clienteNome || null, emailAluna: m.email || null,
      contratoId: nota.contratoId, produto: nota.produto || ctrSnap.data().produto || null,
      formaPagamento: formaAdmin(rec.formaPagamento), tipo: 'parcelado', periodicidade: null,
      numero: rec.parcelaAtual || 1, total: rec.parcelaTotal || 1,
      valor: rec.valorBruto, vencimento: rec.dataPrevista,
      pago: recebido, dataPagamento: recebido ? rec.dataRecebimento : null,
      valorRecebido: recebido ? rec.valorLiquido : null,
      notaId, recebimentoId: recId, origemSync: 'pj',
      criadoEm: FieldValue.serverTimestamp(),
    });
    await recRef(notaId, recId).update({ cobrancaId: cobId, clienteNome: nota.clienteNome || null });
    return criou ? 'cobranca-criada' : 'ja-existia';
  }

  /**
   * Antes de apagar uma nota no PJ: tira o vínculo das cobranças (e do
   * contrato) pra que apagar a nota NÃO cancele cobrança nenhuma no admin.
   */
  async function desvincularNota(notaId, nota, recebimentos) {
    if (!nota || nota.origem !== 'espelho-admin') return;
    const batch = db.batch();
    let n = 0;
    for (const r of recebimentos) {
      if (!r.cobrancaId) continue;
      const ref = db.collection('cobrancas').doc(r.cobrancaId);
      if ((await ref.get()).exists) {
        batch.update(ref, { espelhoPJ: false, notaId: FieldValue.delete(), recebimentoId: FieldValue.delete() });
        n++;
      }
    }
    if (nota.contratoTipo === 'parcelado' && nota.contratoId && nota.uidMentorada) {
      const ctrRef = db.collection('mentoradas').doc(nota.uidMentorada).collection('contratos').doc(nota.contratoId);
      if ((await ctrRef.get()).exists) { batch.update(ctrRef, { espelhoPJ: false }); n++; }
    }
    if (n) await batch.commit();
  }

  /** Notas espelhadas que pedem ação na NF (contrato cancelado, valor mudou, estorno). */
  async function listarAlertas() {
    const config = await lerConfig();
    if (!config || !config.uidPJ) return [];
    const snap = await db.collection('notasEmitidas')
      .where('uid', '==', config.uidPJ).where('origem', '==', 'espelho-admin').get();
    const out = [];
    for (const d of snap.docs) {
      const nota = d.data();
      let contrato = null, cobranca = null;
      if (nota.contratoTipo === 'parcelado') {
        const c = await db.collection('mentoradas').doc(nota.uidMentorada).collection('contratos').doc(nota.contratoId).get();
        contrato = c.exists ? c.data() : null;
        if (contrato && contrato.espelhoPJ === false) continue;
      } else {
        const c = await db.collection('cobrancas').doc(nota.cobrancaId).get();
        cobranca = c.exists ? c.data() : null;
      }
      const alerta = alertaNota(nota, contrato, cobranca);
      if (!alerta || nota.alertaResolvido === alerta.codigo) continue;
      out.push({
        notaId: d.id, codigo: alerta.codigo, texto: alerta.texto,
        clienteNome: nota.clienteNome || '', produto: nota.produto || '',
        valor: nota.valor, dataEmissao: nota.dataEmissao,
      });
    }
    return out.sort((a, b) => (a.dataEmissao || '').localeCompare(b.dataEmissao || ''));
  }

  async function resolverAlerta(notaId, codigo) {
    await db.collection('notasEmitidas').doc(notaId).update({ alertaResolvido: codigo });
  }

  return { lerConfig, aoMudarCobranca, aoMudarRecebimento, desvincularNota, listarAlertas, resolverAlerta };
}

module.exports = {
  criarEspelho, planoRecebimento, planoCobranca, diferencas, alertaNota, limiarEspelho,
  formaInstantanea, formaPJ, formaAdmin, hojeSP,
};
