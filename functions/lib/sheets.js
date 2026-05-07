'use strict';

const { google } = require('googleapis');
const { HttpsError } = require('firebase-functions/v2/https');

/**
 * Cria o cliente autenticado com a conta de serviço.
 * A SA tem acesso às planilhas porque provisionar.js compartilha
 * cada nova planilha com ela no momento da criação.
 */
function buildAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurada.');
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

/**
 * Wrapper da Google Sheets API para um arquivo específico.
 * Cada instância representa a planilha de uma mentorada.
 */
class SheetsClient {
  constructor(sheetId) {
    this.sheetId = sheetId;
    this._auth = buildAuth();
  }

  async _api() {
    const client = await this._auth.getClient();
    return google.sheets({ version: 'v4', auth: client });
  }

  // ─── Primitivas ────────────────────────────────────────────────────────────

  async read(range) {
    try {
      const api = await this._api();
      const res = await api.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range,
      });
      return res.data.values || [];
    } catch (err) {
      throw new HttpsError('internal', `Erro ao ler planilha (${range}): ${err.message}`);
    }
  }

  async write(range, values) {
    try {
      const api = await this._api();
      await api.spreadsheets.values.update({
        spreadsheetId: this.sheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      });
    } catch (err) {
      throw new HttpsError('internal', `Erro ao escrever planilha (${range}): ${err.message}`);
    }
  }

  async append(range, values) {
    try {
      const api = await this._api();
      await api.spreadsheets.values.append({
        spreadsheetId: this.sheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });
    } catch (err) {
      throw new HttpsError('internal', `Erro ao inserir linha (${range}): ${err.message}`);
    }
  }

  async clear(range) {
    try {
      const api = await this._api();
      await api.spreadsheets.values.clear({
        spreadsheetId: this.sheetId,
        range,
      });
    } catch (err) {
      throw new HttpsError('internal', `Erro ao limpar planilha (${range}): ${err.message}`);
    }
  }

  // ─── Orçamento ─────────────────────────────────────────────────────────────
  // Aba: orcamento | Colunas: mes | ano | categoria | tipo | valor
  // tipo: 'receita' | 'despesa'

  async getOrcamento(mes, ano) {
    const rows = await this.read('orcamento!A2:E');
    return rows
      .filter(r => parseInt(r[0]) === mes && parseInt(r[1]) === ano)
      .map(r => ({
        mes:       parseInt(r[0]),
        ano:       parseInt(r[1]),
        categoria: r[2] || '',
        tipo:      r[3] || 'despesa',
        valor:     parseFloat(r[4]) || 0,
      }));
  }

  /**
   * Substitui todos os registros do mês/ano pelos novos itens.
   * Chamado após importar CSV do Raio-X.
   */
  async saveOrcamento(mes, ano, itens) {
    const rows = await this.read('orcamento!A2:E');
    const outros = rows.filter(r => !(parseInt(r[0]) === mes && parseInt(r[1]) === ano));
    const novos  = itens.map(i => [mes, ano, i.categoria, i.tipo, i.valor]);
    await this.clear('orcamento!A2:E');
    const tudo = [...outros, ...novos];
    if (tudo.length > 0) await this.write('orcamento!A2', tudo);
  }

  // ─── Patrimônio ────────────────────────────────────────────────────────────
  // Aba: patrimonio | Colunas: classe | valor | atualizado (AAAA-MM-DD)
  // Classes: pos | infl | pre | rv | mm | int | imov | alt

  async getPatrimonio() {
    const rows = await this.read('patrimonio!A2:C');
    return rows.map(r => ({
      classe:     r[0] || '',
      valor:      parseFloat(r[1]) || 0,
      atualizado: r[2] || '',
    }));
  }

  async savePatrimonio(itens) {
    const hoje = new Date().toISOString().split('T')[0];
    await this.clear('patrimonio!A2:C');
    if (itens.length > 0) {
      await this.write('patrimonio!A2', itens.map(i => [i.classe, i.valor, i.atualizado || hoje]));
    }
  }

  // ─── Investimentos ─────────────────────────────────────────────────────────
  // Aba: investimentos | Colunas: classe | valor | atualizado
  // Separado de patrimônio pois vem do PDF da corretora (posição atual).

  async getInvestimentos() {
    const rows = await this.read('investimentos!A2:C');
    return rows.map(r => ({
      classe:     r[0] || '',
      valor:      parseFloat(r[1]) || 0,
      atualizado: r[2] || '',
    }));
  }

  async saveInvestimentos(itens) {
    const hoje = new Date().toISOString().split('T')[0];
    await this.clear('investimentos!A2:C');
    if (itens.length > 0) {
      await this.write('investimentos!A2', itens.map(i => [i.classe, i.valor, i.atualizado || hoje]));
    }
  }

  // ─── Dívidas ───────────────────────────────────────────────────────────────
  // Aba: dividas | Colunas: id | nome | tipo | saldo | parcela | termino

  async getDividas() {
    const rows = await this.read('dividas!A2:F');
    return rows.map(r => ({
      id:      r[0] || '',
      nome:    r[1] || '',
      tipo:    r[2] || 'outro',
      saldo:   parseFloat(r[3]) || 0,
      parcela: parseFloat(r[4]) || 0,
      termino: r[5] || '',
    }));
  }

  async saveDivida(divida) {
    const rows = await this.read('dividas!A2:F');
    const idx = rows.findIndex(r => r[0] === divida.id);
    const row = [divida.id, divida.nome, divida.tipo, divida.saldo, divida.parcela, divida.termino || ''];
    if (idx === -1) {
      await this.append('dividas!A2', [row]);
    } else {
      await this.write(`dividas!A${idx + 2}:F${idx + 2}`, [row]);
    }
  }

  async deleteDivida(id) {
    const rows = await this.read('dividas!A2:F');
    const filtradas = rows.filter(r => r[0] !== id);
    await this.clear('dividas!A2:F');
    if (filtradas.length > 0) await this.write('dividas!A2', filtradas);
  }

  // ─── Reservas ──────────────────────────────────────────────────────────────
  // Aba: reservas | Colunas: id | nome | meta | acumulado | dataMeta | aporte

  async getReservas() {
    const rows = await this.read('reservas!A2:F');
    return rows.map(r => ({
      id:        r[0] || '',
      nome:      r[1] || '',
      meta:      parseFloat(r[2]) || 0,
      acumulado: parseFloat(r[3]) || 0,
      dataMeta:  r[4] || '',
      aporte:    parseFloat(r[5]) || 0,
    }));
  }

  async saveReserva(reserva) {
    const rows = await this.read('reservas!A2:F');
    const idx = rows.findIndex(r => r[0] === reserva.id);
    const row = [reserva.id, reserva.nome, reserva.meta, reserva.acumulado, reserva.dataMeta || '', reserva.aporte];
    if (idx === -1) {
      await this.append('reservas!A2', [row]);
    } else {
      await this.write(`reservas!A${idx + 2}:F${idx + 2}`, [row]);
    }
  }

  async deleteReserva(id) {
    const rows = await this.read('reservas!A2:F');
    const filtradas = rows.filter(r => r[0] !== id);
    await this.clear('reservas!A2:F');
    if (filtradas.length > 0) await this.write('reservas!A2', filtradas);
  }

  // ─── Histórico de PL ───────────────────────────────────────────────────────
  // Aba: historico | Colunas: data | ativos | dividas | pl
  // data: AAAA-MM (ex: 2025-03) — uma linha por mês, upsert por data.

  async getHistorico() {
    try {
      const rows = await this.read('historico!A2:D');
      return rows
        .filter(r => r[0])
        .map(r => ({
          data:    r[0],
          ativos:  parseFloat(r[1]) || 0,
          dividas: parseFloat(r[2]) || 0,
          pl:      parseFloat(r[3]) || 0,
        }))
        .sort((a, b) => a.data.localeCompare(b.data));
    } catch {
      return []; // aba pode não existir em planilhas antigas
    }
  }

  async upsertHistorico(data, ativos, dividas) {
    const pl = ativos - dividas;
    try {
      let rows;
      try {
        rows = await this.read('historico!A2:D');
      } catch {
        // Aba não existe — cria e adiciona cabeçalho
        await this._criarAbaHistorico();
        rows = [];
      }
      const idx = rows.findIndex(r => r[0] === data);
      const row = [data, ativos, dividas, pl];
      if (idx === -1) {
        await this.append('historico!A2', [row]);
      } else {
        await this.write(`historico!A${idx + 2}:D${idx + 2}`, [row]);
      }
    } catch {
      // Silencioso: não bloqueia o restante
    }
  }

  async _criarAbaHistorico() {
    try {
      const api = await this._api();
      // 1. Adiciona a aba
      await api.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: 'historico' } } }],
        },
      });
      // 2. Escreve o cabeçalho
      await this.write('historico!A1', [['data', 'ativos', 'dividas', 'pl']]);
    } catch { /* ignora se a aba já existir com outro erro */ }
  }

  // ─── Perfil de investidor ───────────────────────────────────────────────────
  // Aba: perfil | Colunas: perfil | dataAtualizacao
  // Apenas uma linha de dados (A2:B2).

  async getPerfil() {
    const rows = await this.read('perfil!A2:B2');
    if (!rows.length || !rows[0][0]) return { perfil: null, dataAtualizacao: null };
    return {
      perfil:           rows[0][0],
      dataAtualizacao:  rows[0][1] || null,
    };
  }

  async savePerfil(perfil, dataAtualizacao) {
    await this.write('perfil!A2:B2', [[perfil, dataAtualizacao]]);
  }
}

module.exports = { SheetsClient };
