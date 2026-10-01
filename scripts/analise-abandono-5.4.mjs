// Item 5.4 do plano de ação — mapa de pontos de abandono.
// Lê os eventos de engajamento direto do Firestore (sem passar pelo admin) e
// imprime adoção por evento + funil de abandono + dump por aluna.
// Uso:  gcloud auth login (conta com acesso ao projeto)  &&  node scripts/analise-abandono-5.4.mjs
// Requer Node 18+ (fetch global). Relatório de referência: analise-abandono-5.4-2026-09.md
import { execSync } from 'node:child_process';
const TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const BASE = 'https://firestore.googleapis.com/v1/projects/trilogia-dashboard/databases/(default)/documents';
async function fx(path, params = '') {
  const r = await fetch(`${BASE}${path}${params}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) { const t = await r.text(); const e = new Error(`${r.status} ${path}`); e.status = r.status; e.body = t; throw e; }
  return r.json();
}
function uv(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) { const o = {}; for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = uv(val); return o; }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(uv);
  return JSON.stringify(v);
}
function fields(doc) { const o = {}; for (const [k, v] of Object.entries(doc.fields || {})) o[k] = uv(v); return o; }
async function listAll(path) {
  let out = [], token = '';
  do { const j = await fx(path, `?pageSize=300${token ? `&pageToken=${token}` : ''}`); out = out.concat(j.documents || []); token = j.nextPageToken || ''; } while (token);
  return out;
}
// Parse events from a doc that may have flat "eventos.X" keys OR nested eventos map
function parseEventos(f) {
  const ev = {};
  if (f.eventos && typeof f.eventos === 'object') for (const [k, v] of Object.entries(f.eventos)) ev[k] = (ev[k] || 0) + Number(v || 0);
  for (const [k, v] of Object.entries(f)) if (k.startsWith('eventos.')) ev[k.slice(8)] = (ev[k.slice(8)] || 0) + Number(v || 0);
  return ev;
}
const EVENTOS = ['csv_importado','aporte_registrado','patrimonio_atualizado','reserva_salva','perfil_atualizado','planejamento_configurado','fixa_cadastrada','cartao_cadastrado','extrato_ia_importado','ir_importado','corretora_importada','divida_cadastrada','reserva_retirada','aba_anual_aberta','divida_pagamento_confirmado'];

const docs = await listAll('/mentoradas');
const rows = [];
for (const d of docs) {
  const uid = d.name.split('/').pop();
  const f = fields(d);
  let ev = null, meses = [];
  try {
    const g = await fx(`/mentoradas/${uid}/analytics/geral`);
    ev = parseEventos(fields(g));
  } catch (e) { if (e.status !== 404) console.error('ERR', uid, e.status); }
  try {
    const all = await listAll(`/mentoradas/${uid}/analytics`);
    meses = all.filter(x => x.name.endsWith('geral') === false).map(x => ({ mes: x.name.split('/').pop(), ev: parseEventos(fields(x)) }));
  } catch {}
  // onboarding data presence
  const has = {};
  for (const [coll, doc] of [['perfil','perfil'],['patrimonio','atual'],['orcamento',null]]) {
    // skip — too many reads; use cached fields instead
  }
  rows.push({
    uid, nome: f.nome || '(sem nome)', status: f.status || '?',
    inicio: f.inicio || '', assinaturaDashboard: !!f.assinaturaDashboard,
    mentoriaEncerrada: !!f.mentoriaEncerrada, produto: f.produto || '',
    totalAcessos: f.totalAcessos || 0, acessosMes: f.acessosMes || 0,
    ultimoAcesso: f.ultimoAcesso ? String(f.ultimoAcesso).slice(0, 10) : '',
    pl: f.pl ?? null, sobra: f.sobra ?? null, scoreMes: f.scoreMes ?? null,
    perfilCampo: f.perfil || '', ev, meses,
  });
}
const evc = (r, n) => (r.ev && r.ev[n]) || 0;
const base = rows.filter(r => (r.status === 'ativa' || r.assinaturaDashboard) && !/^Fl[aá]via|^Luiza|Rodrigo Victoriano/.test(r.nome));
// Real mentee base = ativas/assinantes excluding Flávia's own test accounts + Rodrigo (contingência) + Luiza (teste)
console.log(`\nBASE REAL (ativas/assinantes, sem contas-teste): ${base.length}`);
base.forEach(r => console.log('  -', r.nome, '| acc', r.totalAcessos, '| último', r.ultimoAcesso, '| início', r.inicio));

console.log('\n=== ADOÇÃO POR EVENTO (base real) ===');
for (const e of EVENTOS) {
  const u = base.filter(r => evc(r, e) > 0);
  console.log(`${e.padEnd(28)} ${String(u.length).padStart(2)}/${base.length}  Σ${base.reduce((s, r) => s + evc(r, e), 0)}   ${u.map(r=>r.nome.split(' ')[0]).join(',')}`);
}
console.log('\n=== FUNIL / ABANDONO (base real) ===');
const f1 = base.filter(r => evc(r,'csv_importado')>0 || evc(r,'extrato_ia_importado')>0);
console.log(`importou orçamento (csv OU ia): ${f1.length}/${base.length} -> ${f1.map(r=>r.nome.split(' ')[0])}`);
const f2 = f1.filter(r => evc(r,'aporte_registrado')===0);
console.log(`  ...desses, SEM aporte_registrado: ${f2.length} -> ${f2.map(r=>r.nome.split(' ')[0])}`);
const f3 = f1.filter(r => evc(r,'planejamento_configurado')===0);
console.log(`  ...desses, SEM planejamento_configurado: ${f3.length} -> ${f3.map(r=>r.nome.split(' ')[0])}`);
const p1 = base.filter(r => evc(r,'ir_importado')>0);
console.log(`ir_importado > 0: ${p1.length}/${base.length} -> ${p1.map(r=>r.nome.split(' ')[0])}`);
const p2 = base.filter(r => evc(r,'corretora_importada')>0);
console.log(`corretora_importada > 0: ${p2.length}/${base.length} -> ${p2.map(r=>r.nome.split(' ')[0])}`);
const p3 = base.filter(r => evc(r,'patrimonio_atualizado')>0);
console.log(`patrimonio_atualizado > 0: ${p3.length}/${base.length} -> ${p3.map(r=>r.nome.split(' ')[0])}`);
const r1 = base.filter(r => evc(r,'reserva_salva')>0);
console.log(`reserva_salva > 0: ${r1.length}/${base.length} -> ${r1.map(r=>r.nome.split(' ')[0])}`);
const a1 = base.filter(r => evc(r,'aba_anual_aberta')>0);
console.log(`aba_anual_aberta > 0: ${a1.length}/${base.length}`);
const pl1 = base.filter(r => evc(r,'planejamento_configurado')>0);
console.log(`planejamento_configurado > 0: ${pl1.length}/${base.length} -> ${pl1.map(r=>r.nome.split(' ')[0])}`);

console.log('\n=== DUMP (todas as 17) ===');
for (const r of rows.sort((a,b)=>(a.status+a.nome).localeCompare(b.status+b.nome))) {
  const evs = r.ev === null ? 'SEM-DOC-ANALYTICS' : (Object.entries(r.ev).filter(([,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(' ') || '(doc existe, 0 eventos)');
  console.log(`[${r.status}${r.assinaturaDashboard?'+ass':''}${r.mentoriaEncerrada?' ENC':''}] ${r.nome.padEnd(22)} acc:${String(r.totalAcessos).padStart(3)} ult:${r.ultimoAcesso||'nunca'} ini:${r.inicio||'?'} score:${r.scoreMes??'-'}\n    ${evs}`);
}
