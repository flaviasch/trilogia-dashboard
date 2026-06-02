'use strict';

const { google } = require('googleapis');

// ─── Schema das abas ──────────────────────────────────────────────────────────

const ABAS = {
  orcamento: {
    headers: ['mes', 'ano', 'categoria', 'tipo', 'valor'],
    colWidths: [60, 70, 220, 100, 120],
    validacoes: [
      { colIndex: 3, valores: ['receita', 'despesa'] },
    ],
  },
  patrimonio: {
    headers: ['classe', 'valor', 'atualizado'],
    colWidths: [160, 150, 130],
    validacoes: [
      { colIndex: 0, valores: ['pos', 'infl', 'pre', 'rv', 'mm', 'int', 'imov', 'alt'] },
    ],
  },
  investimentos: {
    headers: ['classe', 'valor', 'atualizado'],
    colWidths: [160, 150, 130],
    validacoes: [
      { colIndex: 0, valores: ['pos', 'infl', 'pre', 'rv', 'mm', 'int', 'alt'] },
    ],
  },
  dividas: {
    headers: ['id', 'nome', 'tipo', 'saldo', 'parcela', 'termino'],
    colWidths: [160, 240, 160, 120, 120, 120],
    validacoes: [
      { colIndex: 2, valores: ['financiamento', 'carro', 'emprestimo', 'cartao', 'outro'] },
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
      { colIndex: 0, valores: ['conservador', 'moderado', 'arrojado'] },
    ],
  },
  historico: {
    headers: ['data', 'ativos', 'dividas', 'pl'],
    colWidths: [100, 150, 150, 150],
    validacoes: [],
  },
};

const COR_HEADER = { red: 0.051, green: 0.169, blue: 0.271 };
const COR_TEXTO  = { red: 1, green: 1, blue: 1 };
const COR_ALT    = { red: 0.965, green: 0.961, blue: 0.957 };

/**
 * Autentica via OAuth2 com refresh token da Flávia.
 * O arquivo é criado na conta dela (cota dela) e ela é a proprietária.
 * Token não expira se o app OAuth estiver publicado (não em modo Teste).
 */
function buildAuth() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Credenciais OAuth do Drive não configuradas.');
  }

  const oauth2Client = new google.auth.OAuth2(clientId.trim(), clientSecret.trim());
  oauth2Client.setCredentials({ refresh_token: refreshToken.trim() });
  return oauth2Client;
}

/**
 * Cria a planilha Google Sheets de uma nova mentorada usando as credenciais
 * OAuth da Flávia — o arquivo é criado na conta dela, dentro da pasta indicada.
 */
async function provisionar(nome, folderId) {
  const auth  = buildAuth();
  const api   = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  // ── 1. Criar arquivo Sheets na pasta da Flávia via Drive API ────────────────
  const createParams = {
    requestBody: {
      name:     `Trilogia — ${nome}`,
      mimeType: 'application/vnd.google-apps.spreadsheet',
    },
    fields: 'id',
  };
  if (folderId) createParams.requestBody.parents = [folderId];

  const { data: file } = await drive.files.create(createParams);
  const fileId = file.id;

  // ── 2. Configurar abas: renomear a padrão + adicionar as demais ─────────────
  const nomeAbas = Object.keys(ABAS);
  await api.spreadsheets.batchUpdate({
    spreadsheetId: fileId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: 0, title: nomeAbas[0], index: 0 },
            fields: 'title,index',
          },
        },
        ...nomeAbas.slice(1).map((title, i) => ({
          addSheet: {
            properties: { sheetId: i + 1, title, index: i + 1 },
          },
        })),
      ],
    },
  });

  const sheetMeta = nomeAbas.map((title, i) => ({
    properties: { sheetId: i, title },
  }));

  // ── 3. Inserir cabeçalhos ───────────────────────────────────────────────────
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

  // ── 4. Formatação visual + validações ──────────────────────────────────────
  const requests = [];

  for (const [nomeAba, cfg] of Object.entries(ABAS)) {
    const sheet = sheetMeta.find(s => s.properties.title === nomeAba);
    if (!sheet) continue;
    const sid   = sheet.properties.sheetId;
    const nCols = cfg.headers.length;

    requests.push({
      updateSheetProperties: {
        properties: { sheetId: sid, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });

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

    requests.push({
      addBanding: {
        bandedRange: {
          bandedRangeId: sid * 100,
          range: { sheetId: sid, startRowIndex: 1, endRowIndex: 200, startColumnIndex: 0, endColumnIndex: nCols },
          rowProperties: {
            headerColor: COR_HEADER,
            firstBandColor:  { red: 1, green: 1, blue: 1 },
            secondBandColor: COR_ALT,
          },
        },
      },
    });

    cfg.colWidths.forEach((px, i) => {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId: sid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: px },
          fields: 'pixelSize',
        },
      });
    });

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

  // ── 5. Compartilha a planilha com a Service Account do projeto ──────────────
  const saEmail = getSaEmail();
  if (saEmail) {
    try {
      await drive.permissions.create({
        fileId,
        requestBody: {
          role: 'writer',
          type: 'user',
          emailAddress: saEmail,
        },
        sendNotificationEmail: false,
        fields: 'id',
      });
    } catch (err) {
      console.warn('[provisionar] Aviso: não foi possível compartilhar com SA:', err.message);
    }
  }

  return fileId;
}

function getSaEmail() {
  // A SA já é a autora dos arquivos — compartilhamento com ela mesma não é necessário
  return null;
}

module.exports = { provisionar };
