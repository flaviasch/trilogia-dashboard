'use strict';

// Espelho Financeiro admin ↔ PJ: Firestore falso em memória + simulação dos
// dois gatilhos (cada escrita enfileira o evento; roda até parar). Prova que
// cada cenário converge sem loop e sem duplicar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarEspelho, planoRecebimento, planoCobranca } = require('../lib/espelho-financeiro');

const DEL = { __del: true };
const TS = 'TS';

function criarMundo() {
  const docs = new Map(); // path -> data
  const fila = [];
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  function gravar(path, novo) {
    const antes = docs.has(path) ? clone(docs.get(path)) : null;
    if (novo == null) docs.delete(path); else docs.set(path, novo);
    fila.push({ path, antes, depois: novo == null ? null : clone(novo) });
  }
  function aplicar(base, upd) {
    const out = { ...base };
    Object.entries(upd).forEach(([k, v]) => { if (v && v.__del) delete out[k]; else out[k] = v; });
    return out;
  }
  function docRef(path) {
    return {
      id: path.split('/').pop(), path,
      async get() { const d = docs.get(path); return { exists: !!d, id: path.split('/').pop(), data: () => clone(d), ref: docRef(path) }; },
      async set(data, opt) { gravar(path, opt && opt.merge ? aplicar(docs.get(path) || {}, data) : aplicar({}, data)); },
      async create(data) { if (docs.has(path)) { const e = new Error('already exists'); e.code = 6; throw e; } gravar(path, aplicar({}, data)); },
      async update(data) { if (!docs.has(path)) throw new Error('NOT_FOUND ' + path); gravar(path, aplicar(docs.get(path), data)); },
      async delete() { if (docs.has(path)) gravar(path, null); },
      collection(n) { return colRef(`${path}/${n}`); },
    };
  }
  function colRef(path, filtros = []) {
    return {
      doc(id) { return docRef(`${path}/${id || Math.random().toString(36).slice(2)}`); },
      where(c, op, v) { return colRef(path, [...filtros, [c, v]]); },
      async get() {
        const prof = path.split('/').length + 1;
        const out = [...docs.entries()]
          .filter(([p, d]) => p.startsWith(path + '/') && p.split('/').length === prof && filtros.every(([c, v]) => d[c] === v))
          .map(([p, d]) => ({ id: p.split('/').pop(), data: () => clone(d), ref: docRef(p) }));
        return { docs: out, empty: !out.length, size: out.length };
      },
    };
  }
  const db = {
    collection: n => colRef(n),
    batch() { const ops = []; return { update: (r, d) => ops.push(() => r.update(d)), set: (r, d) => ops.push(() => r.set(d)), delete: r => ops.push(() => r.delete()), async commit() { for (const o of ops) await o(); } }; },
  };
  const FieldValue = { serverTimestamp: () => TS, delete: () => DEL };
  const impostos = [];
  // Mesmo comportamento essencial do _aplicarPagamentoCobranca do index.js.
  async function aplicarPagamento(cobRef, cob, dataPagamento, valorRecebido) {
    await cobRef.update({ pago: true, dataPagamento, valorRecebido });
    if (cob.tipo === 'recorrente') {
      const [a, m, d] = cob.vencimento.split('-').map(Number);
      const prox = new Date(Date.UTC(a, m, d)).toISOString().slice(0, 10);
      await db.collection('cobrancas').doc().set({ ...cob, numero: cob.numero + 1, vencimento: prox, pago: false, dataPagamento: null, valorRecebido: null, notaId: DEL, recebimentoId: DEL });
    }
  }
  const espelho = criarEspelho({ db, FieldValue, aplicarPagamento, regerarImpostos: async (...a) => impostos.push(a), log: { log() {} } });

  async function rodar() {
    let n = 0;
    while (fila.length) {
      if (++n > 300) throw new Error('loop: eventos não param');
      const ev = fila.shift();
      const p = ev.path.split('/');
      if (p[0] === 'cobrancas' && p.length === 2) await espelho.aoMudarCobranca(p[1], ev.antes, ev.depois);
      else if (p[0] === 'notasEmitidas' && p[2] === 'recebimentos') await espelho.aoMudarRecebimento(p[1], p[3], ev.antes, ev.depois);
    }
    return n;
  }
  const lista = prefixo => [...docs.entries()].filter(([p]) => p.startsWith(prefixo)).map(([p, d]) => ({ path: p, ...d }));
  return { db, docs, rodar, espelho, impostos, lista, get: p => clone(docs.get(p)) };
}

const UID_PJ = 'flavia';
async function mundoLigado() {
  const w = criarMundo();
  await w.db.collection('config').doc('espelhoFinanceiro').set({ modo: 'ligado', uidPJ: UID_PJ, desde: '2026-10-15T00:00:00.000Z' });
  await w.db.collection('mentoradas').doc('m1').set({ nome: 'Ana', email: 'ana@x.com' });
  await w.rodar();
  return w;
}
async function contratoParcelado(w, { forma = 'pix', criadoEm = '2026-10-16T13:00:00.000Z', n = 3 } = {}) {
  await w.db.collection('mentoradas').doc('m1').collection('contratos').doc('c1').set({ produto: 'mentoria', tipo: 'parcelado', valorTotal: 300 * n, formaPagamento: forma, status: 'ativo', criadoEm });
  for (let i = 1; i <= n; i++) {
    await w.db.collection('cobrancas').doc(`k${i}`).set({ uidMentorada: 'm1', nomeAluna: 'Ana', contratoId: 'c1', produto: 'mentoria', formaPagamento: forma, tipo: 'parcelado', numero: i, total: n, valor: 300, vencimento: ['2026-10-20', '2026-11-20', '2026-12-20'][i - 1], pago: false, dataPagamento: null, valorRecebido: null });
  }
  await w.rodar();
}
const recs = w => w.lista('notasEmitidas/ctr_c1/recebimentos/');

test('contrato parcelado vira 1 nota cheia + 1 recebimento por parcela, sem duplicar', async () => {
  const w = await mundoLigado();
  await contratoParcelado(w);
  const nota = w.get('notasEmitidas/ctr_c1');
  assert.equal(nota.valor, 900);
  assert.equal(nota.uid, UID_PJ);
  assert.equal(nota.dataEmissao, '2026-10-16');
  assert.equal(nota.clienteNome, 'Ana');
  assert.equal(w.impostos.length, 1, 'impostos recalculados uma vez só');
  assert.equal(recs(w).length, 3);
  assert.deepEqual(recs(w).map(r => r.parcelaAtual).sort(), [1, 2, 3]);
  assert.equal(w.get('cobrancas/k1').recebimentoId, 'cob_k1');
  // reprocessar os mesmos eventos não cria nada novo
  await w.espelho.aoMudarCobranca('k1', null, w.get('cobrancas/k1'));
  await w.rodar();
  assert.equal(recs(w).length, 3);
});

test('contrato criado antes de ligar fica fora (histórico)', async () => {
  const w = await mundoLigado();
  await contratoParcelado(w, { criadoEm: '2026-10-01T10:00:00.000Z' });
  assert.equal(w.get('notasEmitidas/ctr_c1'), undefined);
});

test('pix: pagar no admin confirma no PJ, e estornar no PJ estorna no admin', async () => {
  const w = await mundoLigado();
  await contratoParcelado(w);
  await w.db.collection('cobrancas').doc('k1').update({ pago: true, dataPagamento: '2026-10-20', valorRecebido: 300 });
  await w.rodar();
  let r = w.get('notasEmitidas/ctr_c1/recebimentos/cob_k1');
  assert.equal(r.dataRecebimento, '2026-10-20');
  assert.equal(r.valorLiquido, 300);

  await w.db.collection('notasEmitidas').doc('ctr_c1').collection('recebimentos').doc('cob_k1').update({ dataRecebimento: null });
  await w.rodar();
  const c = w.get('cobrancas/k1');
  assert.equal(c.pago, false);
  assert.equal(c.dataPagamento, undefined);
});

test('PJ confirma com taxa: admin fica pago com o líquido, e o PJ mantém bruto/taxa digitados', async () => {
  const w = await mundoLigado();
  await contratoParcelado(w);
  await w.db.collection('notasEmitidas').doc('ctr_c1').collection('recebimentos').doc('cob_k2')
    .update({ dataRecebimento: '2026-11-12', valorBruto: 300, taxa: 9, valorLiquido: 291 });
  await w.rodar();
  const c = w.get('cobrancas/k2');
  assert.equal(c.pago, true);
  assert.equal(c.valorRecebido, 291);
  assert.equal(c.dataPagamento, '2026-11-12');
  const r = w.get('notasEmitidas/ctr_c1/recebimentos/cob_k2');
  assert.equal(r.taxa, 9);
  assert.equal(r.valorBruto, 300);
});

test('kiwify: pago no admin deixa o PJ pendente (data prevista +30), e só a confirmação no PJ marca recebido', async () => {
  const w = await mundoLigado();
  await contratoParcelado(w, { forma: 'kiwify' });
  await w.db.collection('cobrancas').doc('k1').update({ pago: true, dataPagamento: '2026-10-20', valorRecebido: 300 });
  await w.rodar();
  let r = w.get('notasEmitidas/ctr_c1/recebimentos/cob_k1');
  assert.equal(r.dataRecebimento, null);
  assert.equal(r.dataPrevista, '2026-11-19');
  assert.equal(w.get('cobrancas/k1').pago, true, 'PJ pendente não estorna o admin no Kiwify');

  await w.db.collection('notasEmitidas').doc('ctr_c1').collection('recebimentos').doc('cob_k1')
    .update({ dataRecebimento: '2026-11-19', valorBruto: 300, taxa: 27, valorLiquido: 273 });
  await w.rodar();
  const c = w.get('cobrancas/k1');
  assert.equal(c.valorRecebido, 273, 'admin passa a mostrar o líquido que caiu');
  assert.equal(c.dataPagamento, '2026-10-20', 'data em que a aluna pagou fica');
});

test('editar vencimento no admin muda data prevista no PJ e vice-versa', async () => {
  const w = await mundoLigado();
  await contratoParcelado(w);
  await w.db.collection('cobrancas').doc('k3').update({ vencimento: '2027-01-05' });
  await w.rodar();
  assert.equal(w.get('notasEmitidas/ctr_c1/recebimentos/cob_k3').dataPrevista, '2027-01-05');
  await w.db.collection('notasEmitidas').doc('ctr_c1').collection('recebimentos').doc('cob_k3').update({ dataPrevista: '2027-01-15' });
  await w.rodar();
  assert.equal(w.get('cobrancas/k3').vencimento, '2027-01-15');
});

test('cancelar contrato apaga recebimentos pendentes, mantém a nota e gera alerta', async () => {
  const w = await mundoLigado();
  await contratoParcelado(w);
  await w.db.collection('cobrancas').doc('k1').update({ pago: true, dataPagamento: '2026-10-20', valorRecebido: 300 });
  await w.rodar();
  await w.db.collection('mentoradas').doc('m1').collection('contratos').doc('c1').update({ status: 'cancelado' });
  await w.db.collection('cobrancas').doc('k2').update({ cancelada: true });
  await w.db.collection('cobrancas').doc('k3').update({ cancelada: true });
  await w.rodar();
  assert.equal(recs(w).length, 1, 'só o recebido fica');
  assert.ok(w.get('notasEmitidas/ctr_c1'), 'nota fica');
  const alertas = await w.espelho.listarAlertas();
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].codigo, 'contrato-cancelado');
  await w.espelho.resolverAlerta('ctr_c1', 'contrato-cancelado');
  assert.equal((await w.espelho.listarAlertas()).length, 0);
});

test('excluir recebimento pendente no PJ cancela a cobrança (nunca apaga)', async () => {
  const w = await mundoLigado();
  await contratoParcelado(w);
  await w.db.collection('notasEmitidas').doc('ctr_c1').collection('recebimentos').doc('cob_k3').delete();
  await w.rodar();
  assert.equal(w.get('cobrancas/k3').cancelada, true);
});

test('"Editar formato" no PJ: pendentes trocados viram cobranças novas, antigas canceladas', async () => {
  const w = await mundoLigado();
  await contratoParcelado(w);
  const col = w.db.collection('notasEmitidas').doc('ctr_c1').collection('recebimentos');
  await col.doc('cob_k2').delete();
  await col.doc('cob_k3').delete();
  await col.doc('novo1').set({ uid: UID_PJ, formaPagamento: 'credito', valorBruto: 200, taxa: 0, valorLiquido: 200, dataPrevista: '2026-11-15', dataRecebimento: null, parcelaAtual: 1, parcelaTotal: 3 });
  await col.doc('novo2').set({ uid: UID_PJ, formaPagamento: 'credito', valorBruto: 200, taxa: 0, valorLiquido: 200, dataPrevista: '2026-12-15', dataRecebimento: null, parcelaAtual: 2, parcelaTotal: 3 });
  await col.doc('novo3').set({ uid: UID_PJ, formaPagamento: 'credito', valorBruto: 200, taxa: 0, valorLiquido: 200, dataPrevista: '2027-01-15', dataRecebimento: null, parcelaAtual: 3, parcelaTotal: 3 });
  await w.rodar();
  assert.equal(w.get('cobrancas/k2').cancelada, true);
  assert.equal(w.get('cobrancas/k3').cancelada, true);
  const nova = w.get('cobrancas/rec_novo2');
  assert.equal(nova.valor, 200);
  assert.equal(nova.vencimento, '2026-12-15');
  assert.equal(nova.contratoId, 'c1');
  assert.equal(w.get('notasEmitidas/ctr_c1/recebimentos/novo2').cobrancaId, 'rec_novo2');
  assert.equal(w.get('notasEmitidas/ctr_c1/recebimentos/novo2').formaPagamento, 'credito', 'forma do PJ não é sobrescrita');
});

test('reparcelar no admin (apaga e recria cobranças) troca os recebimentos pendentes', async () => {
  const w = await mundoLigado();
  await contratoParcelado(w);
  for (const k of ['k1', 'k2', 'k3']) await w.db.collection('cobrancas').doc(k).delete();
  await w.db.collection('cobrancas').doc('z1').set({ uidMentorada: 'm1', nomeAluna: 'Ana', contratoId: 'c1', produto: 'mentoria', formaPagamento: 'pix', tipo: 'parcelado', numero: 1, total: 2, valor: 450, vencimento: '2026-10-25', pago: false });
  await w.db.collection('cobrancas').doc('z2').set({ uidMentorada: 'm1', nomeAluna: 'Ana', contratoId: 'c1', produto: 'mentoria', formaPagamento: 'pix', tipo: 'parcelado', numero: 2, total: 2, valor: 450, vencimento: '2026-11-25', pago: false });
  await w.rodar();
  assert.deepEqual(recs(w).map(r => r.path.split('/').pop()).sort(), ['cob_z1', 'cob_z2']);
});

test('assinatura: nota só nasce no pagamento, uma por mês', async () => {
  const w = await mundoLigado();
  await w.db.collection('cobrancas').doc('r1').set({ uidMentorada: 'm1', nomeAluna: 'Ana', contratoId: 'c9', produto: 'clube', formaPagamento: 'pix', tipo: 'recorrente', periodicidade: 'mensal', numero: 1, valor: 97, vencimento: '2026-10-20', pago: false });
  await w.rodar();
  assert.equal(w.lista('notasEmitidas/').length, 0, 'cobrança aberta de assinatura não gera nota');
  await w.db.collection('cobrancas').doc('r1').update({ pago: true, dataPagamento: '2026-10-20', valorRecebido: 97 });
  await w.rodar();
  const nota = w.get('notasEmitidas/cob_r1');
  assert.equal(nota.valor, 97);
  assert.equal(nota.mes, 10);
  assert.equal(w.get('notasEmitidas/cob_r1/recebimentos/cob_r1').dataRecebimento, '2026-10-20');
});

test('assinatura paga pela Kiwify gera nota do mês com recebimento pendente no PJ', async () => {
  const w = await mundoLigado();
  await w.db.collection('cobrancas').doc('r1').set({ uidMentorada: 'm1', nomeAluna: 'Ana', contratoId: 'c9', produto: 'clube', formaPagamento: 'kiwify', tipo: 'recorrente', periodicidade: 'mensal', numero: 1, valor: 97, vencimento: '2026-10-20', pago: true, dataPagamento: '2026-10-20', valorRecebido: 97 });
  await w.rodar();
  assert.equal(w.get('notasEmitidas/cob_r1/recebimentos/cob_r1').dataRecebimento, null, 'Kiwify fica pendente no PJ');
});

test('apagar a nota no PJ (desvincular antes) não cancela nada no admin', async () => {
  const w = await mundoLigado();
  await contratoParcelado(w);
  const nota = w.get('notasEmitidas/ctr_c1');
  const rs = recs(w);
  await w.espelho.desvincularNota('ctr_c1', nota, rs);
  for (const r of rs) await w.db.collection('notasEmitidas').doc('ctr_c1').collection('recebimentos').doc(r.path.split('/').pop()).delete();
  await w.db.collection('notasEmitidas').doc('ctr_c1').delete();
  await w.rodar();
  for (const k of ['k1', 'k2', 'k3']) {
    assert.notEqual(w.get(`cobrancas/${k}`).cancelada, true);
    assert.equal(w.get(`cobrancas/${k}`).espelhoPJ, false);
  }
  assert.equal(w.get('notasEmitidas/ctr_c1'), undefined, 'não recria a nota');
});

test('modo teste: só a mentorada de teste espelha', async () => {
  const w = criarMundo();
  await w.db.collection('config').doc('espelhoFinanceiro').set({ modo: 'teste', uidPJ: UID_PJ, uidsTeste: ['m2'], desdeTeste: '2026-10-15T00:00:00.000Z' });
  await contratoParcelado(w);
  assert.equal(w.get('notasEmitidas/ctr_c1'), undefined);
});

test('modo teste: mentorada de teste espelha', async () => {
  const w = criarMundo();
  await w.db.collection('config').doc('espelhoFinanceiro').set({ modo: 'teste', uidPJ: UID_PJ, uidsTeste: ['m1'], desdeTeste: '2026-10-15T00:00:00.000Z' });
  await contratoParcelado(w);
  assert.equal(w.get('notasEmitidas/ctr_c1').valor, 900);
});

test('desligado: nada acontece', async () => {
  const w = criarMundo();
  await contratoParcelado(w);
  assert.equal(w.lista('notasEmitidas/').length, 0);
});

test('planos puros convergem (gêmeo do gêmeo não muda nada)', () => {
  const cob = { formaPagamento: 'pix', pago: true, dataPagamento: '2026-10-20', valor: 300, valorRecebido: 295, vencimento: '2026-10-20', nomeAluna: 'Ana' };
  const rec = planoRecebimento(cob, null);
  assert.deepEqual(planoCobranca(rec, cob), { acao: 'nada' });
  assert.equal(rec.taxa, 5);
});
