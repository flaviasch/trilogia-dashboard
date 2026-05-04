'use strict';

const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

function buildAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurada.');
  return new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes: SCOPES });
}

// ─── Schema das abas ──────────────────────────────────────────────────────────
// Cada aba define: cabeçalhos, larguras de coluna (pixels) e validações dropdown.

const ABAS = {
  orcamento: {
    headers: ['mes', 'ano', 'categoria', 'tipo', 'valor'],
    colWidths: [60, 70, 220, 100, 120],
    validacoes: [
      // Coluna D (índice 3) = tipo: receita | despesa
      {
        colIndex: 3,
        valores: ['receita', 'despesa'],
      },
    ],
  },
  patrimonio: {
    headers: ['classe', 'valor', 'atualizado'],
    colWidths: [160, 150, 130],
    validacoes: [
      {
        colIndex: 0,
        valores: ['pos', 'infl', 'pre', 'rv', 'mm', 'int', 'alt'],
      },
    ],
  },
  investimentos: {
    headers: ['classe', 'valor', 'atualizado'],
    colWidths: [160, 150, 130],
    validacoes: [
      {
        colIndex: 0,
        valores: ['pos', 'infl', 'pre', 'rv', 'mm', 'int', 'alt'],
      },
    ],
  },
  dividas: {
    headers: ['id', 'nome', 'tipo', 'saldo', 'parcela', 'termino'],
    colWidths: [160, 240, 160, 120, 120, 120],
    validacoes: [
      {
        colIndex: 2,
        valores: ['financiamento', 'carro', 'emprestimo', 'cartao', 'outro'],
      },
    ],
  },
  reservas: {
    headers: ['id', 'nome', 'meta', 'acumulado', 'dataMeta', 'aporte'],
    colWidths: [160, 240, 130, 130, 120, 120],
    validacoes: [],
  },
  perfil: {
    headers: ['perfil', 'dataAtualizacao'],
    colWidths: [160, 160],
    validacoes: [
      {
        colIndex: 0,
        valores: ['conservador', 'moderado', 'arrojado'],
      },
    ],
  },
};

// Cor do cabeçalho: navy (#0D2B45)
const COR_HEADER = { red: 0.051, green: 0.169, blue: 0.271 };
const COR_TEXTO  = { red: 1, green: 1, blue: 1 };
const COR_ALT    = { red: 0.965, green: 0.961, blue: 0.957 }; // off-white para linhas alternadas

/**
 * Cria a planilha Google Sheets de uma nova mentorada na conta da Flávia,
 * com cabeçalhos, formatação visual, larguras de coluna e validações dropdown.
 *
 * @param {string} nome      - Nome da mentorada (título do arquivo)
 * @param {string} folderId  - ID da pasta no Drive da Flávia
 * @returns {Promise<string>} - spreadsheetId criado
 */
async function provisionar(nome, folderId) {
  const auth   = buildAuth();
  const client = await auth.getClient();
  const api    = google.sheets({ version: 'v4', auth: client });
  const drive  = google.drive({ version: 'v3', auth: client });

  // ── 1. Criar arquivo com todas as abas ──────────────────────────────────────
  const { data: spreadsheet } = await api.spreadsheets.create({
    requestBody: {
      properties: { title: `Trilogia — ${nome}`, locale: 'pt_BR' },
      sheets: Object.keys(ABAS).map((title, i) => ({
        properties: { sheetId: i, title, index: i },
      })),
    },
  });

  const fileId    = spreadsheet.spreadsheetId;
  const sheetMeta = spreadsheet.sheets; // array com sheetId numérico de cada aba

  // ── 2. Inserir cabeçalhos ───────────────────────────────────────────────────
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: fileId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: Object.entries(ABAS).map(([aba, cfg]) => ({
        range:  `${aba}!A1`,
        values: [cfg.headers],
      })),
    },
  });

  // ── 3. Formatação visual + validações (batchUpdate de requests) ─────────────
  const requests = [];

  for (const [nomeAba, cfg] of Object.entries(ABAS)) {
    const sheet = sheetMeta.find(s => s.properties.title === nomeAba);
    if (!sheet) continue;
    const sid = sheet.properties.sheetId;
    const nCols = cfg.headers.length;

    // 3a. Congelar linha 1
    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId: sid,
          gridProperties: { frozenRowCount: 1 },
        },
        fields: 'gridProperties.frozenRowCount',
      },
    });

    // 3b. Fundo navy + texto branco + negrito no cabeçalho (linha 1)
    requests.push({
      repeatCell: {
        range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: nCols },
        cell: {
          userEnteredFormat: {
            backgroundColor: COR_HEADER,
            textFormat: { foregroundColor: COR_TEXTO, bold: true, fontSize: 10 },
            verticalAlignment: 'MIDDLE',
            padding: { top: 6, bottom: 6, left: 8, right: 8 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,padding)',
      },
    });

    // 3c. Cor alternada nas linhas de dados (linhas 2–200)
    requests.push({
      addBanding: {
        bandedRange: {
          bandedRangeId: sid * 100,
          range: { sheetId: sid, startRowIndex: 1, endRowIndex: 200, startColumnIndex: 0, endColumnIndex: nCols },
          rowProperties: {
            headerColor: COR_HEADER,
            firstBandColor: { red: 1, green: 1, blue: 1 },
            secondBandColor: COR_ALT,
          },
        },
      },
    });

    // 3d. Largura das colunas
    cfg.colWidths.forEach((px, i) => {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId: sid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: px },
          fields: 'pixelSize',
        },
      });
    });

    // 3e. Validações dropdown
    for (const val of cfg.validacoes) {
      requests.push({
        setDataValidation: {
          range: {
            sheetId: sid,
            startRowIndex: 1, endRowIndex: 1000,
            startColumnIndex: val.colIndex, endColumnIndex: val.colIndex + 1,
          },
          rule: {
            condition: {
              type: 'ONE_OF_LIST',
              values: val.valores.map(v => ({ userEnteredValue: v })),
            },
            showCustomUi: true,
            strict: true,
          },
        },
      });
    }
  }

  await api.spreadsheets.batchUpdate({
    spreadsheetId: fileId,
    requestBody: { requests },
  });

  // ── 4. Mover para a pasta da Flávia no Drive ────────────────────────────────
  if (folderId) {
    const fileMeta = await drive.files.get({ fileId, fields: 'parents' });
    const parentsAtuais = (fileMeta.data.parents || []).join(',');
    await drive.files.update({
      fileId,
      addParents:    folderId,
      removeParents: parentsAtuais,
      fields:        'id, parents',
    });
  }

  // ── 5. Compartilhar com a Flávia como editora ───────────────────────────────
  const flaviaEmail = process.env.FLAVIA_EMAIL || 'flaviasch@gmail.com';
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'writer', type: 'user', emailAddress: flaviaEmail },
    sendNotificationEmail: false,
  });

  return fileId;
}

module.exports = { provisionar };
