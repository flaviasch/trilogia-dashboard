'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { fns, auth, uidTeste } = require('./setup');

const db = admin.firestore();
const mesKeyAtual = () => new Date().toISOString().slice(0, 7);

test('registrarEvento', async (t) => {
  await t.test('grava no mapa aninhado eventos.<nome> em geral e no mês', async () => {
    const uid = uidTeste();
    const res = await fns.registrarEvento.run({ data: { evento: 'aporte_registrado', uid }, auth: auth(uid) });
    assert.equal(res.ok, true);

    const base = db.collection('mentoradas').doc(uid).collection('analytics');
    const geral = (await base.doc('geral').get()).data();
    const mes   = (await base.doc(mesKeyAtual()).get()).data();

    assert.equal(geral.eventos.aporte_registrado, 1, 'geral: mapa aninhado');
    assert.equal(mes.eventos.aporte_registrado, 1, 'mês: mapa aninhado');
    assert.equal(mes.mes, mesKeyAtual());
    // não deve existir o campo achatado antigo
    assert.equal(geral['eventos.aporte_registrado'], undefined);
  });

  await t.test('incrementa a cada chamada', async () => {
    const uid = uidTeste();
    await fns.registrarEvento.run({ data: { evento: 'csv_importado', uid }, auth: auth(uid) });
    await fns.registrarEvento.run({ data: { evento: 'csv_importado', uid }, auth: auth(uid) });
    await fns.registrarEvento.run({ data: { evento: 'csv_importado', uid }, auth: auth(uid) });

    const geral = (await db.collection('mentoradas').doc(uid).collection('analytics').doc('geral').get()).data();
    assert.equal(geral.eventos.csv_importado, 3);
  });

  await t.test('ignora evento fora da allowlist sem gravar nada', async () => {
    const uid = uidTeste();
    const res = await fns.registrarEvento.run({ data: { evento: 'evento_inventado', uid }, auth: auth(uid) });
    assert.equal(res.ok, true);
    const geral = await db.collection('mentoradas').doc(uid).collection('analytics').doc('geral').get();
    assert.equal(geral.exists, false);
  });

  await t.test('NÃO conta quando o uid alvo é diferente do autenticado (admin "vendo como")', async () => {
    const adminUid = uidTeste('admin');
    const alunaUid = uidTeste('aluna');
    const res = await fns.registrarEvento.run({
      data: { evento: 'aporte_registrado', uid: alunaUid },
      auth: auth(adminUid, true),
    });
    assert.equal(res.ok, true);
    // nem no doc do admin nem no da aluna
    assert.equal((await db.collection('mentoradas').doc(adminUid).collection('analytics').doc('geral').get()).exists, false);
    assert.equal((await db.collection('mentoradas').doc(alunaUid).collection('analytics').doc('geral').get()).exists, false);
  });

  await t.test('conta normalmente quando uid == autenticado', async () => {
    const uid = uidTeste();
    await fns.registrarEvento.run({ data: { evento: 'perfil_atualizado', uid }, auth: auth(uid) });
    const geral = (await db.collection('mentoradas').doc(uid).collection('analytics').doc('geral').get()).data();
    assert.equal(geral.eventos.perfil_atualizado, 1);
  });

  await t.test('cliente antigo (sem uid) continua gravando no auth.uid', async () => {
    const uid = uidTeste();
    await fns.registrarEvento.run({ data: { evento: 'reserva_salva' }, auth: auth(uid) });
    const geral = (await db.collection('mentoradas').doc(uid).collection('analytics').doc('geral').get()).data();
    assert.equal(geral.eventos.reserva_salva, 1);
  });
});

test('getAnalytics', async (t) => {
  await t.test('normaliza formato achatado antigo e soma com o aninhado novo', async () => {
    const uid = uidTeste();
    const base = db.collection('mentoradas').doc(uid).collection('analytics');
    // simula o histórico gravado no formato achatado antigo
    await base.doc('geral').set({ 'eventos.csv_importado': 7, 'eventos.fixa_cadastrada': 40 });
    // + um incremento no formato novo
    await fns.registrarEvento.run({ data: { evento: 'csv_importado', uid }, auth: auth(uid) });

    const { geral } = await fns.getAnalytics.run({ data: { uid }, auth: auth('adm', true) });
    assert.equal(geral.eventos.csv_importado, 8, '7 antigo + 1 novo');
    assert.equal(geral.eventos.fixa_cadastrada, 40);
    assert.equal(geral['eventos.csv_importado'], undefined, 'campo achatado não vaza pro cliente');
  });

  await t.test('exige admin', async () => {
    await assert.rejects(
      fns.getAnalytics.run({ data: { uid: 'x' }, auth: auth('naoadmin') }),
      (e) => e.code === 'permission-denied' || e.code === 'unauthenticated',
    );
  });
});
