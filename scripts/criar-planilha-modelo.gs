/**
 * criar-planilha-modelo.gs
 * Google Apps Script — cria a planilha modelo do Trilogia Dashboard.
 *
 * COMO USAR:
 *   1. Acesse script.google.com e crie um novo projeto.
 *   2. Cole este código e clique em "Executar" → criarPlanilhaModelo().
 *   3. Autorize as permissões solicitadas.
 *   4. A planilha será criada no seu Drive e o ID será exibido nos logs.
 *   5. Copie o ID para usar como template ao provisionar novas mentoradas.
 *
 * Esse script é equivalente ao provisionar.js das Cloud Functions,
 * mas roda diretamente na conta da Flávia — útil para testes antes do deploy.
 */

// ─── Configurações ─────────────────────────────────────────────────────────────

// ID da pasta no Google Drive onde criar a planilha.
// Deixe vazio para criar na raiz do Drive.
var FOLDER_ID = '';

// Nome da planilha modelo (para testes use "MODELO — Trilogia Dashboard")
var NOME_PLANILHA = 'MODELO — Trilogia Dashboard';

// Cor navy do Trilogia (em formato {r,g,b} de 0 a 1)
var COR_NAVY = { red: 0.051, green: 0.169, blue: 0.271 };

// ─── Schema das abas ───────────────────────────────────────────────────────────

var ABAS = {
  orcamento: {
    headers:    ['mes', 'ano', 'categoria', 'tipo', 'valor'],
    colWidths:  [60, 70, 220, 100, 120],
    validacoes: [{ col: 4, valores: ['receita', 'despesa'] }],  // col D (1-indexed)
    notas: {
      A1: 'Número do mês (1–12)',
      B1: 'Ano com 4 dígitos',
      C1: 'Ex: Moradia, Alimentação, Salário',
      D1: 'receita ou despesa',
      E1: 'Valor em R$ sem símbolo',
    },
  },
  patrimonio: {
    headers:    ['classe', 'valor', 'atualizado'],
    colWidths:  [160, 150, 130],
    validacoes: [{ col: 1, valores: ['pos', 'infl', 'pre', 'rv', 'mm', 'int', 'alt'] }],
    notas: {
      A1: 'pos=RF Pós | infl=RF Inflação | pre=RF Pré | rv=Renda Variável | mm=Multimercado | int=Internacional | alt=Alternativos',
      B1: 'Valor total nesta classe (R$)',
      C1: 'Data da última atualização (AAAA-MM-DD)',
    },
  },
  investimentos: {
    headers:    ['classe', 'valor', 'atualizado'],
    colWidths:  [160, 150, 130],
    validacoes: [{ col: 1, valores: ['pos', 'infl', 'pre', 'rv', 'mm', 'int', 'alt'] }],
    notas: {
      A1: 'Mesmas classes que patrimônio — posição atual na corretora',
      B1: 'Valor total nesta classe (R$)',
      C1: 'Data do extrato (AAAA-MM-DD)',
    },
  },
  dividas: {
    headers:    ['id', 'nome', 'tipo', 'saldo', 'parcela', 'termino'],
    colWidths:  [160, 240, 160, 120, 120, 120],
    validacoes: [{ col: 3, valores: ['financiamento', 'carro', 'emprestimo', 'cartao', 'outro'] }],
    notas: {
      A1: 'ID único gerado pelo dashboard (não editar)',
      B1: 'Descrição da dívida',
      C1: 'financiamento | carro | emprestimo | cartao | outro',
      D1: 'Saldo devedor atual (R$)',
      E1: 'Parcela mensal (R$)',
      F1: 'Término previsto (AAAA-MM)',
    },
  },
  reservas: {
    headers:    ['id', 'nome', 'meta', 'acumulado', 'dataMeta', 'aporte'],
    colWidths:  [160, 240, 130, 130, 120, 120],
    validacoes: [],
    notas: {
      A1: 'ID único gerado pelo dashboard (não editar)',
      B1: 'Nome da reserva (ex: Viagem Europa)',
      C1: 'Valor total da meta (R$)',
      D1: 'Valor já acumulado (R$)',
      E1: 'Mês objetivo (AAAA-MM)',
      F1: 'Aporte mensal planejado (R$)',
    },
  },
  perfil: {
    headers:    ['perfil', 'dataAtualizacao'],
    colWidths:  [160, 160],
    validacoes: [{ col: 1, valores: ['conservador', 'moderado', 'arrojado'] }],
    notas: {
      A1: 'conservador | moderado | arrojado',
      B1: 'Data do último suitability (AAAA-MM-DD) — válido por 2 anos',
    },
  },
};

// ─── Função principal ──────────────────────────────────────────────────────────

function criarPlanilhaModelo() {
  var ss;

  if (FOLDER_ID) {
    var folder = DriveApp.getFolderById(FOLDER_ID);
    ss = SpreadsheetApp.create(NOME_PLANILHA);
    var file = DriveApp.getFileById(ss.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  } else {
    ss = SpreadsheetApp.create(NOME_PLANILHA);
  }

  var abaNames = Object.keys(ABAS);

  // Renomear a aba padrão para a primeira aba do schema
  var abaDefault = ss.getSheets()[0];
  abaDefault.setName(abaNames[0]);

  // Criar as abas restantes
  for (var i = 1; i < abaNames.length; i++) {
    ss.insertSheet(abaNames[i]);
  }

  // Formatar cada aba
  abaNames.forEach(function(nomeAba) {
    var cfg = ABAS[nomeAba];
    var aba = ss.getSheetByName(nomeAba);
    formatarAba(aba, cfg);
  });

  // Ativar primeira aba
  ss.setActiveSheet(ss.getSheetByName(abaNames[0]));

  var url = ss.getUrl();
  var id  = ss.getId();
  Logger.log('✅ Planilha criada com sucesso!');
  Logger.log('ID: ' + id);
  Logger.log('URL: ' + url);

  // Mostrar popup com o ID para copiar
  SpreadsheetApp.getUi().alert(
    '✅ Planilha criada!\n\n' +
    'ID da planilha:\n' + id + '\n\n' +
    'Cole este ID no campo DRIVE_FOLDER_ID do .env das Cloud Functions.'
  );
}

// ─── Formatação de cada aba ───────────────────────────────────────────────────

function formatarAba(aba, cfg) {
  var headers   = cfg.headers;
  var nCols     = headers.length;
  var ultimaCol = colLetra(nCols);

  // 1. Cabeçalhos
  var rangeHeader = aba.getRange('A1:' + ultimaCol + '1');
  rangeHeader.setValues([headers]);
  rangeHeader.setBackground('#0D2B45');
  rangeHeader.setFontColor('#FFFFFF');
  rangeHeader.setFontWeight('bold');
  rangeHeader.setFontSize(10);
  rangeHeader.setVerticalAlignment('middle');
  aba.setRowHeight(1, 36);

  // 2. Congelar linha 1
  aba.setFrozenRows(1);

  // 3. Largura das colunas
  cfg.colWidths.forEach(function(px, i) {
    aba.setColumnWidth(i + 1, px);
  });

  // 4. Cor alternada nas linhas de dados
  var rangeDados = aba.getRange('A2:' + ultimaCol + '200');
  rangeDados.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);

  // 5. Notas nos cabeçalhos
  if (cfg.notas) {
    Object.entries(cfg.notas).forEach(function(entry) {
      var celula = entry[0];
      var nota   = entry[1];
      aba.getRange(celula).setNote(nota);
    });
  }

  // 6. Validações dropdown
  cfg.validacoes.forEach(function(val) {
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(val.valores, true)
      .setAllowInvalid(false)
      .build();
    var rangeVal = aba.getRange(2, val.col, 999, 1);
    rangeVal.setDataValidation(rule);
  });

  // 7. Formatar colunas de valor como moeda (BRL) — heurística: nome inclui 'valor', 'saldo', 'parcela', 'meta', 'acumulado', 'aporte'
  var formatoMoeda = ['valor', 'saldo', 'parcela', 'meta', 'acumulado', 'aporte'];
  headers.forEach(function(h, i) {
    if (formatoMoeda.includes(h)) {
      aba.getRange(2, i + 1, 999, 1).setNumberFormat('R$ #,##0.00');
    }
  });
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

function colLetra(n) {
  var s = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ─── Função de teste rápido ───────────────────────────────────────────────────

/**
 * Insere dados de exemplo em uma planilha existente para testar a leitura
 * pelas Cloud Functions antes de ter dados reais.
 *
 * USE APENAS EM PLANILHAS DE TESTE.
 *
 * @param {string} spreadsheetId - ID da planilha a preencher
 */
function inserirDadosDeTeste(spreadsheetId) {
  var ss = SpreadsheetApp.openById(spreadsheetId || SpreadsheetApp.getActiveSpreadsheet().getId());

  ss.getSheetByName('orcamento').getRange('A2:E5').setValues([
    [4, 2025, 'Salário CLT',   'receita', 15000],
    [4, 2025, 'Mentoria',      'receita',  1000],
    [4, 2025, 'Moradia',       'despesa',  4200],
    [4, 2025, 'Alimentação',   'despesa',  2100],
  ]);

  ss.getSheetByName('patrimonio').getRange('A2:C4').setValues([
    ['pos',  45000, '2025-04-01'],
    ['rv',   80000, '2025-04-01'],
    ['infl', 30000, '2025-04-01'],
  ]);

  ss.getSheetByName('reservas').getRange('A2:F3').setValues([
    ['r001', 'Fundo de Emergência', 30000, 25500, '2025-08', 1500],
    ['r002', 'Viagem Europa',       25000,  8000, '2026-10',  800],
  ]);

  ss.getSheetByName('perfil').getRange('A2:B2').setValues([
    ['moderado', '2024-03-15'],
  ]);

  Logger.log('✅ Dados de teste inseridos.');
}
