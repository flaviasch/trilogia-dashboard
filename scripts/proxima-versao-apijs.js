'use strict';
/**
 * proxima-versao-apijs.js
 *
 * Achado 14/08/2026: 3 bugs de produção na mesma sessão (cartoes-pj.html,
 * reservas-pj.html, admin.html) causados pelo mesmo erro — bumpar
 * `./js/api.js?v=N` pra um número que JÁ estava em uso por outra página do
 * repo, então o navegador serve o conteúdo antigo cacheado daquela outra
 * página (sem os exports novos), o import nomeado falha, e a página inteira
 * não roda.
 *
 * Regra: antes de qualquer bump manual de `?v=` em js/api.js, rode este
 * script e use o número que ele sugerir — nunca escolha um número "que
 * parece livre" de cabeça.
 *
 * Uso:
 *   node proxima-versao-apijs.js            → mostra o mapa atual + próxima versão segura
 *   node proxima-versao-apijs.js --checar N → avisa se a versão N já está em uso por outra página
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REGEX_VERSAO = /(?:from\s*)?['"]\.?\/?js\/api\.js\?v=(\d+)['"]/g;

function coletar() {
  const arquivos = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  const mapa = []; // { arquivo, versao }
  for (const arquivo of arquivos) {
    const conteudo = fs.readFileSync(path.join(ROOT, arquivo), 'utf-8');
    let m;
    REGEX_VERSAO.lastIndex = 0;
    while ((m = REGEX_VERSAO.exec(conteudo))) {
      mapa.push({ arquivo, versao: Number(m[1]) });
    }
  }
  return mapa;
}

function main() {
  const mapa = coletar();
  if (!mapa.length) {
    console.log('Nenhuma referência a js/api.js?v= encontrada nos HTMLs.');
    process.exit(0);
  }

  const args = process.argv.slice(2);
  if (args[0] === '--checar') {
    const alvo = Number(args[1]);
    if (!Number.isInteger(alvo)) { console.error('Uso: node proxima-versao-apijs.js --checar N'); process.exit(1); }
    const emUsoPor = mapa.filter(m => m.versao === alvo).map(m => m.arquivo);
    if (emUsoPor.length) {
      console.log(`⚠️  v=${alvo} JÁ está em uso por: ${emUsoPor.join(', ')}`);
      console.log(`   Não reutilize esse número a menos que seja EXATAMENTE essas mesmas páginas que você está bumpando junto.`);
    } else {
      console.log(`✅ v=${alvo} está livre — nenhuma página do repo usa esse número hoje.`);
    }
    process.exit(0);
  }

  const maxVersao = Math.max(...mapa.map(m => m.versao));
  const porVersao = {};
  mapa.forEach(m => { (porVersao[m.versao] = porVersao[m.versao] || []).push(m.arquivo); });

  console.log('Versões de js/api.js em uso hoje:\n');
  Object.keys(porVersao).map(Number).sort((a, b) => a - b).forEach(v => {
    console.log(`  v=${v}: ${porVersao[v].join(', ')}`);
  });
  console.log(`\nMaior versão em uso: v=${maxVersao}`);
  console.log(`\n➡️  Próxima versão SEGURA pra qualquer bump novo: v=${maxVersao + 1}`);
}

main();
