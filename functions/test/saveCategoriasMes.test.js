'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { fns, auth, uidTeste } = require('./setup');

const MES = 7, ANO = 2026;
const db = admin.firestore();

test('saveCategoriasMes', async (t) => {
  await t.test('salva a lista normalmente na primeira vez', async () => {
    const uid = uidTeste();
    const categorias = [{ nome: 'Saúde', limite: 4800 }, { nome: 'Moradia', limite: 2650 }];
    const res = await fns.saveCategoriasMes.run({ data: { uid, mes: MES, ano: ANO, categorias }, auth: auth(uid) });
    assert.equal(res.ok, true);

    const snap = await db.collection('mentoradas').doc(uid).collection('planejamento').doc('2026-07').get();
    assert.equal(snap.data().categorias.length, 2);
  });

  await t.test('achado 04/07/2026: bloqueia "Copiar de mês anterior" sobrescrevendo com lista bem menor', async () => {
    const uid = uidTeste();
    const doze = Array.from({ length: 12 }, (_, i) => ({ nome: `Categoria ${i}`, limite: 100 }));
    await fns.saveCategoriasMes.run({ data: { uid, mes: MES, ano: ANO, categorias: doze }, auth: auth(uid) });

    // Simula "Copiar de Jun" mandando só 5 categorias (substituição, não mescla)
    await assert.rejects(
      fns.saveCategoriasMes.run({ data: { uid, mes: MES, ano: ANO, categorias: doze.slice(0, 5) }, auth: auth(uid) }),
      { code: 'failed-precondition' }
    );

    const snap = await db.collection('mentoradas').doc(uid).collection('planejamento').doc('2026-07').get();
    assert.equal(snap.data().categorias.length, 12, 'lista original de 12 deve permanecer intacta');
  });

  await t.test('permitirReducao=true autoriza a redução', async () => {
    const uid = uidTeste();
    const doze = Array.from({ length: 12 }, (_, i) => ({ nome: `Categoria ${i}`, limite: 100 }));
    await fns.saveCategoriasMes.run({ data: { uid, mes: MES, ano: ANO, categorias: doze }, auth: auth(uid) });

    const res = await fns.saveCategoriasMes.run({
      data: { uid, mes: MES, ano: ANO, categorias: doze.slice(0, 5), permitirReducao: true },
      auth: auth(uid),
    });
    assert.equal(res.ok, true);
  });

  await t.test('guarda versão anterior antes de sobrescrever', async () => {
    const uid = uidTeste();
    await fns.saveCategoriasMes.run({ data: { uid, mes: MES, ano: ANO, categorias: [{ nome: 'Saúde', limite: 4800 }] }, auth: auth(uid) });
    await fns.saveCategoriasMes.run({ data: { uid, mes: MES, ano: ANO, categorias: [{ nome: 'Saúde', limite: 5000 }] }, auth: auth(uid) });

    const versoesSnap = await db.collection('mentoradas').doc(uid).collection('planejamento').doc('2026-07').collection('versoes').get();
    assert.equal(versoesSnap.size, 1);
    assert.equal(versoesSnap.docs[0].data().categorias[0].limite, 4800);
  });

  await t.test('rejeita categoria com limite negativo', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.saveCategoriasMes.run({ data: { uid, mes: MES, ano: ANO, categorias: [{ nome: 'X', limite: -1 }] }, auth: auth(uid) }),
      { code: 'invalid-argument' }
    );
  });
});
