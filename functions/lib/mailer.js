'use strict';

/**
 * Envio de e-mail via SMTP do Gmail com App Password.
 *
 * Usa nodemailer com autenticação simples (SMTP + App Password),
 * que nunca expira enquanto a senha de app não for revogada manualmente.
 *
 * Secret no Firebase: GMAIL_APP_PASSWORD
 */

const nodemailer = require('nodemailer');

const REMETENTE_NOME  = 'Trilogia Dashboard';
const REMETENTE_EMAIL = 'flaviasch@gmail.com';

/**
 * Cria o transporter SMTP do Gmail usando App Password.
 */
function buildTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: REMETENTE_EMAIL,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

/**
 * Envia um e-mail via SMTP do Gmail.
 * @param {{ to: string, subject: string, html: string }} opts
 */
async function sendEmail({ to, subject, html }) {
  const transporter = buildTransporter();
  await transporter.sendMail({
    from: `"${REMETENTE_NOME}" <${REMETENTE_EMAIL}>`,
    to,
    subject,
    html,
  });
}

// ─── Templates ────────────────────────────────────────────────────────────────

function layout(conteudo) {
  // Template com inline styles para máxima compatibilidade entre clientes de e-mail.
  // Fundo claro + texto escuro garante legibilidade no Gmail mobile, Outlook, Apple Mail, etc.
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header navy -->
        <tr>
          <td style="background:#0D2B45;padding:28px 32px;">
            <span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-.3px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
              Trilogia <span style="color:#CFAE65;">Dashboard</span>
            </span>
          </td>
        </tr>

        <!-- Conteúdo -->
        <tr>
          <td style="padding:36px 32px 28px;">
            ${conteudo}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px 28px;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
              Você recebeu este e-mail porque é mentorada da Trilogia Financeira.<br>
              Para dúvidas, responda diretamente a este e-mail.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Helpers de estilo inline reutilizáveis
const S = {
  h2:     'margin:0 0 12px;font-size:22px;font-weight:700;color:#0D2B45;line-height:1.3;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;',
  p:      'margin:0 0 16px;font-size:14px;color:#4b5563;line-height:1.7;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;',
  pSmall: 'margin:16px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;',
  btn:    'display:inline-block;background:#CFAE65;color:#0D2B45;text-decoration:none;font-size:14px;font-weight:700;padding:13px 28px;border-radius:8px;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;',
};

/**
 * E-mail: renovação de perfil de investidor.
 * @param {string} nome  — nome da mentorada
 * @param {number} meses — meses desde a última atualização
 */
function emailRenovacaoPerfil(nome, meses) {
  return layout(`
    <h2 style="${S.h2}">Hora de revisar seu perfil de investidor</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Seu perfil de investidor foi atualizado há <strong>${meses} meses</strong>.
      Recomendamos revisá-lo pelo menos a cada 6 meses para garantir que
      suas reservas continuem alinhadas ao seu momento de vida e objetivos.
    </p>
    <a href="https://dashboard.flaviaschusciman.com/perfil.html" style="${S.btn}">
      Atualizar perfil
    </a>
  `);
}

/**
 * E-mail: perfil ainda não cadastrado.
 */
function emailSemPerfil(nome) {
  return layout(`
    <h2 style="${S.h2}">Configure seu perfil de investidor</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Você ainda não cadastrou seu perfil de investidor no Dashboard.
      Ele é a base para definir a estratégia de alocação das suas reservas
      e personalizar suas orientações financeiras.
    </p>
    <a href="https://dashboard.flaviaschusciman.com/perfil.html" style="${S.btn}">
      Configurar agora
    </a>
  `);
}

/**
 * E-mail: lembrete mensal de lançamento de orçamento.
 * @param {string} nome    — nome da mentorada
 * @param {string} nomeMes — ex. "maio de 2026"
 */
function emailLembreteOrcamento(nome, nomeMes) {
  return layout(`
    <h2 style="${S.h2}">Registre o orçamento de ${nomeMes}</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Começou um novo mês. Mantenha seu controle financeiro em dia
      lançando receitas e despesas de <strong>${nomeMes}</strong> no Dashboard.
    </p>
    <a href="https://dashboard.flaviaschusciman.com/orcamento.html" style="${S.btn}">
      Lançar orçamento
    </a>
  `);
}

/**
 * E-mail: lembrete de aporte mensal.
 * @param {string} nome    — nome da mentorada
 * @param {string} nomeMes — ex. "maio de 2026"
 */
function emailLembreteAporte(nome, nomeMes) {
  return layout(`
    <h2 style="${S.h2}">Efetive o aporte de ${nomeMes}</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      O mês está chegando ao fim. Não esqueça de confirmar o aporte
      nas suas reservas referente a <strong>${nomeMes}</strong> e registrá-lo
      no Dashboard para manter o histórico atualizado.
    </p>
    <a href="https://dashboard.flaviaschusciman.com/reservas.html" style="${S.btn}">
      Ver reservas
    </a>
  `);
}

/**
 * E-mail: lembrete de importação da declaração de IR (todo maio).
 * @param {string} nome — nome da mentorada
 */
function emailIR(nome) {
  return layout(`
    <h2 style="${S.h2}">Atualize seu patrimônio com a declaração de IR</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      É maio — época de declaração de Imposto de Renda. Aproveite para importar
      sua declaração no Dashboard e manter imóveis, participações societárias e
      outros ativos fora da corretora devidamente atualizados no seu patrimônio.
    </p>
    <p style="${S.p}">
      Com o patrimônio completo, a visão de alocação e as conciliações com suas
      reservas ficam muito mais precisas.
    </p>
    <a href="https://dashboard.flaviaschusciman.com/patrimonio.html" style="${S.btn}">
      Importar declaração IR
    </a>
  `);
}

/**
 * E-mail: reenvio de link de acesso.
 * @param {string} nome      — nome da mentorada
 * @param {string} linkSenha — link gerado pelo Firebase para definir senha
 */
function emailReenvioAcesso(nome, linkSenha) {
  return layout(`
    <h2 style="${S.h2}">Seu link de acesso ao Dashboard</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Um novo link de acesso foi gerado para sua conta no Trilogia Dashboard.
      Clique no botão abaixo para definir (ou redefinir) sua senha e entrar na plataforma.
    </p>
    <a href="${linkSenha}" style="${S.btn}">
      Definir minha senha
    </a>
    <p style="${S.pSmall}">
      Se você não esperava este e-mail, pode ignorá-lo com segurança.
      O link expira em 24 horas.
    </p>
  `);
}

/**
 * E-mail: boas-vindas com link de criação de senha.
 * @param {string} nome      — nome da mentorada
 * @param {string} linkSenha — link gerado pelo Firebase para definir senha
 */
function emailBoasVindas(nome, contexto = 'mentoria') {
  const linkLogin = contexto === 'dashboard-pj'
    ? 'https://dashboard.flaviaschusciman.com/login-pj.html'
    : 'https://dashboard.flaviaschusciman.com/login.html';
  const intro = contexto === 'raio-x'
    ? {
        titulo: 'Bem-vinda ao seu Raio-X Financeiro',
        paragrafo: `
          Sua conta está criada e você já tem <strong>30 dias de acesso</strong> ao módulo de
          Orçamento do Trilogia Dashboard. É só entrar, colar ou anexar seu extrato e fatura,
          e a inteligência artificial classifica tudo automaticamente para você.
        `,
        botao: 'Acessar o Dashboard',
        extra: `
          <p style="${S.p}">
            Dentro do Orçamento, clique em <strong>"Importar extrato com IA"</strong> para começar.
            Você pode importar quantas vezes quiser durante os 30 dias.
          </p>
          <p style="${S.pSmall}">
            Se depois da degustação você quiser continuar, o upgrade para o Dashboard completo
            mantém a mesma conta e os mesmos dados — nada se perde.
          </p>
        `,
      }
    : contexto === 'dashboard-pj'
    ? {
        titulo: 'Bem-vinda ao Dashboard PJ',
        paragrafo: `
          Sua conta está criada e o Dashboard PJ da sua empresa já está pronto para você.
          Para definir sua senha e acessar pela primeira vez, clique no botão abaixo:
        `,
        botao: 'Acessar o Dashboard PJ',
        extra: `
          <p style="${S.pSmall}">
            No primeiro acesso, você vai preencher um cadastro rápido da sua empresa
            (nome, CNPJ opcional e regime tributário) antes de começar a usar.
          </p>
        `,
      }
    : {
        titulo: 'Bem-vinda ao Trilogia Dashboard',
        paragrafo: `
          Sua conta está criada e o Dashboard já está pronto para você.
          Para definir sua senha e acessar pela primeira vez, clique no botão abaixo:
        `,
        botao: 'Acessar o Dashboard',
        extra: '',
      };
  return layout(`
    <h2 style="${S.h2}">${intro.titulo}</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">${intro.paragrafo}</p>
    <a href="${linkLogin}" style="${S.btn}">
      ${intro.botao}
    </a>
    <p style="${S.p}" style="margin-top:20px">
      Na tela de login, clique em <strong>"Primeiro acesso — criar minha senha"</strong>
      (ou "Esqueci minha senha"), informe este e-mail e você receberá um link
      para criar sua senha na hora.
    </p>
    ${intro.extra}
    <p style="${S.pSmall}">
      Qualquer dúvida, fale diretamente com a Flávia pelo WhatsApp.
    </p>
  `);
}

/**
 * E-mail: aviso de expiração de acesso em 7 dias.
 * @param {string} nome — nome da mentorada
 */
function emailExpiracaoProxima(nome) {
  return layout(`
    <h2 style="${S.h2}">Seu acesso expira em 7 dias</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Seu acesso ao Trilogia Dashboard expira em <strong>7 dias</strong>.
      Para continuar acompanhando seu patrimônio, reservas e orçamento,
      renove sua assinatura antes do vencimento.
    </p>
    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Acessar o Dashboard
    </a>
    <p style="${S.pSmall}">
      Em caso de dúvidas, entre em contato diretamente com a Flávia
      pelo WhatsApp ou e-mail.
    </p>
  `);
}

/**
 * E-mail: cobranças com vencimento hoje — enviado para a Flávia.
 * @param {Array} cobrancas — lista de objetos { nomeAluna, produto, numero, total, valor, vencimento, formaPagamento }
 */
function emailCobrancasDia(cobrancas) {
  const brl = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmt  = (iso) => {
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
  };
  const PRODUTO_LABEL = {
    mentoria: 'Mentoria', private: 'Private',
    clube: 'Clube', dashboard: 'Dashboard', outro: 'Outro',
  };
  const PAGAMENTO_LABEL = {
    kiwify: 'Kiwify', pix: 'PIX', transferencia: 'Transferência', outro: 'Outro',
  };

  const linhas = cobrancas.map(c => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#111827;font-size:13px;">
        ${c.nomeAluna}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#4b5563;font-size:13px;">
        ${PRODUTO_LABEL[c.produto] || c.produto}
        ${c.total > 1 ? `<span style="font-size:11px;color:#9ca3af"> · ${c.numero}/${c.total}</span>` : ''}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#4b5563;font-size:13px;">
        ${PAGAMENTO_LABEL[c.formaPagamento] || c.formaPagamento || '—'}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#0D2B45;font-weight:700;text-align:right;font-size:13px;">
        ${brl(c.valor)}
      </td>
    </tr>`).join('');

  const total = cobrancas.reduce((s, c) => s + (c.valor || 0), 0);

  return layout(`
    <h2 style="${S.h2}">Cobranças do dia ${fmt(cobrancas[0]?.vencimento || new Date().toISOString().slice(0,10))}</h2>
    <p style="${S.p}">
      Você tem <strong>${cobrancas.length} cobrança${cobrancas.length !== 1 ? 's' : ''}</strong>
      com vencimento hoje. Total previsto: <strong style="color:#0D2B45">${brl(total)}</strong>.
    </p>
    <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Aluna</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Produto</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Forma</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Valor</th>
        </tr>
      </thead>
      <tbody>${linhas}</tbody>
    </table>
    <p style="margin:12px 0 20px;text-align:right;font-size:13px;color:#6b7280;">
      Total: <strong style="color:#0D2B45;">${brl(total)}</strong>
    </p>
    <a href="https://dashboard.flaviaschusciman.com/admin.html" style="${S.btn}">
      Abrir painel admin
    </a>
  `);
}

/**
 * E-mail: tributos PJ com vencimento hoje — enviado para a Flávia.
 * @param {Array} impostos — lista de objetos { tributoNome, mes, ano, trimestre, valor, vencimento }
 */
function emailImpostosDia(impostos) {
  const brl = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmt  = (iso) => {
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
  };
  const MESES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

  const linhas = impostos.map(i => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#111827;font-size:13px;">
        ${i.tributoNome}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#4b5563;font-size:13px;">
        ${i.trimestre ? `${i.trimestre}º tri/${i.ano}` : `${MESES[i.mes - 1]}/${i.ano}`}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#0D2B45;font-weight:700;text-align:right;font-size:13px;">
        ${brl(i.valor)}
      </td>
    </tr>`).join('');

  const total = impostos.reduce((s, i) => s + (i.valor || 0), 0);

  return layout(`
    <h2 style="${S.h2}">Tributos PJ com vencimento ${fmt(impostos[0]?.vencimento || new Date().toISOString().slice(0,10))}</h2>
    <p style="${S.p}">
      Você tem <strong>${impostos.length} tributo${impostos.length !== 1 ? 's' : ''}</strong>
      com vencimento hoje. Total previsto: <strong style="color:#0D2B45">${brl(total)}</strong>.
    </p>
    <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Tributo</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Competência</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Valor</th>
        </tr>
      </thead>
      <tbody>${linhas}</tbody>
    </table>
    <p style="margin:12px 0 20px;text-align:right;font-size:13px;color:#6b7280;">
      Total: <strong style="color:#0D2B45;">${brl(total)}</strong>
    </p>
    <a href="https://dashboard.flaviaschusciman.com/admin.html" style="${S.btn}">
      Abrir painel admin
    </a>
  `);
}

/**
 * E-mail: lembrete para configurar o planejamento do próximo mês (enviado no dia 28).
 * @param {string} nome        — nome da mentorada
 * @param {string} proximoMes  — ex. "junho de 2026"
 */
function emailLembretePlanejamento(nome, proximoMes) {
  return layout(`
    <h2 style="${S.h2}">Configure o planejamento de ${proximoMes}</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      O mês está chegando ao fim. Que tal já definir quanto você planeja gastar
      em cada categoria em <strong>${proximoMes}</strong>?
    </p>
    <p style="${S.p}">
      Com o planejamento configurado, você recebe alertas automáticos quando
      estiver se aproximando do limite em qualquer categoria.
    </p>
    <a href="https://dashboard.flaviaschusciman.com/orcamento.html" style="${S.btn}">
      Configurar planejamento
    </a>
  `);
}

/**
 * E-mail: novidades de junho/2026 — cartões, faturas, fixas, Raio-X, FAB.
 * @param {string} nome — nome da mentorada
 */
function emailNovidades(nome) {
  const featureItem = (emoji, titulo, desc) =>
    `<tr><td style="padding:12px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:32px;vertical-align:top;padding-top:2px;font-size:20px;">${emoji}</td>
        <td style="padding-left:12px;">
          <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Novidades no seu Dashboard — Junho 2026</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Algumas atualizações chegaram no seu dashboard essa semana. Vou te contar o que mudou e como usar.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:24px;">
      ${featureItem('💳','Lançamento no cartão ficou mais inteligente','Agora existe um modal dedicado para despesas no cartão. O sistema calcula automaticamente em qual fatura a compra vai cair, com base no dia de corte cadastrado. Se o banco adiantou o corte por feriado, tem um botão para ajustar manualmente. Compras parceladas também entraram nesse modal: você informa o valor total e o número de parcelas, e o sistema lança o valor correto em cada fatura automaticamente.')}
      ${featureItem('📋','Nova aba: Faturas','As faturas dos seus cartões agora têm uma aba própria. Cada cartão aparece com as despesas do mês, total da fatura e barra de uso do limite — verde, amarelo ou vermelho conforme o percentual gasto.')}
      ${featureItem('📌','Registrar fixas ficou mais fácil','Ao lançar uma despesa manualmente, dois novos atalhos aparecem: Despesa fixa (lança no mês atual e já cadastra como recorrente para os próximos meses) e Recorrência com prazo (você define quantos meses e o sistema lança automaticamente nesse período).')}
      ${featureItem('🤖','Raio-X + despesas fixas automáticas','Quando o Raio-X identifica uma despesa fixa, o CSV sai com essa marcação. Ao importar no dashboard, o sistema detecta e abre uma tela de confirmação: você escolhe quais quer cadastrar como fixas e elas entram direto no gerenciador de recorrentes, sem precisar cadastrar manualmente.')}
      ${featureItem('✦','Atalho rápido para lançar','O botão + dourado na tela inicial agora expande com três opções: Receita, Despesa e Despesa no cartão. Menos cliques para registrar.')}
    </table>
    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Acessar agora →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

// ─── Novidades Jun/2026 (v2) ─────────────────────────────────────────────────

/**
 * E-mail: novidades de junho/2026 v2 — cartões, faturas, fixas, Raio-X, FAB.
 * @param {string} nome — nome da mentorada
 */
function emailNovidadesJun2026(nome) {
  const featureItem = (emoji, titulo, desc) =>
    `<tr><td style="padding:12px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:32px;vertical-align:top;padding-top:2px;font-size:20px;">${emoji}</td>
        <td style="padding-left:12px;">
          <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Novidades no seu Dashboard — Junho 2026</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Algumas atualizações chegaram no seu dashboard essa semana. Vou te contar o que mudou e como usar.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:24px;">
      ${featureItem('💳','Lançamento no cartão ficou mais inteligente','Agora existe um modal dedicado para despesas no cartão. O sistema calcula automaticamente em qual fatura a compra vai cair, com base no dia de corte cadastrado. Se o banco adiantou o corte por feriado, tem um botão para ajustar manualmente. Compras parceladas também entraram nesse modal: você informa o valor total e o número de parcelas, e o sistema lança o valor correto em cada fatura automaticamente.')}
      ${featureItem('📋','Nova aba: Faturas','As faturas dos seus cartões agora têm uma aba própria. Cada cartão aparece com as despesas do mês, total da fatura e barra de uso do limite — verde, amarelo ou vermelho conforme o percentual gasto.')}
      ${featureItem('📌','Registrar fixas ficou mais fácil','Ao lançar uma despesa manualmente, dois novos atalhos aparecem: Despesa fixa (lança no mês atual e já cadastra como recorrente para os próximos meses) e Recorrência com prazo (você define quantos meses e o sistema lança automaticamente nesse período).')}
      ${featureItem('🤖','Raio-X + despesas fixas automáticas','Quando o Raio-X identifica uma despesa fixa, o CSV sai com essa marcação. Ao importar no dashboard, o sistema detecta e abre uma tela de confirmação: você escolhe quais quer cadastrar como fixas e elas entram direto no gerenciador de recorrentes, sem precisar cadastrar manualmente.')}
      ${featureItem('✦','Atalho rápido para lançar','O botão + dourado na tela inicial agora expande com três opções: Receita, Despesa e Despesa no cartão. Menos cliques para registrar.')}
    </table>
    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Acessar agora →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

// ─── Novidades Jun/2026 v3 ───────────────────────────────────────────────────

function emailNovidadesJun2026v3(nome) {
  const featureItem = (emoji, titulo, desc) =>
    `<tr><td style="padding:12px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:32px;vertical-align:top;padding-top:2px;font-size:20px;">${emoji}</td>
        <td style="padding-left:12px;">
          <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Novidade no seu Dashboard — Junho 2026</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Uma função nova está disponível no seu dashboard. Vai economizar tempo em registros do dia a dia.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:24px;">
      ${featureItem('✨','Registre um gasto digitando uma frase','Toque em + na tela inicial, escolha Texto livre e digite algo como "gastei 45 no mercado" ou "recebi 3000 de salário". O dashboard identifica o valor, a categoria e o tipo automaticamente, mostra um preview para você confirmar e salva no orçamento do mês. Menos cliques, mesmo controle.')}
      ${featureItem('📅','CSV importa no mês certo automaticamente','Ao importar um extrato do Raio-X, o sistema agora lê as datas das transações e salva no período correto, sem precisar navegar até o mês antes de importar.')}
    </table>
    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Acessar agora →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

// ─── Novidades Jul/2026 (v4) — Faturas + Jornada ─────────────────────────────

function emailNovidadesJul2026(nome) {
  const featureItem = (emoji, titulo, desc) =>
    `<tr><td style="padding:12px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:32px;vertical-align:top;padding-top:2px;font-size:20px;">${emoji}</td>
        <td style="padding-left:12px;">
          <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Atualizações no seu Dashboard — Julho 2026</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Três melhorias chegaram ao seu dashboard esta semana — no controle de cartão de crédito e na aba Minha Jornada.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:24px;">
      ${featureItem('💳','Faturas no mês certo — o do pagamento','A despesa de cartão agora aparece no mês em que o valor sai da conta. Uma compra feita após a data de corte vai automaticamente para o mês seguinte, sem precisar ajustar nada.')}
      ${featureItem('💸','Pagou parcial? O saldo vai para o próximo mês','Ao confirmar um pagamento parcial de fatura, o saldo restante é lançado como despesa automática no mês seguinte — para o seu planejamento não ficar descoberto.')}
      ${featureItem('🗺️','Materiais dos encontros na Jornada','Documentos, links e entregáveis compartilhados em cada encontro agora aparecem diretamente na aba Minha Jornada do app.')}
    </table>
    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Acessar o Dashboard →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

// ─── Balanço de Julho/2026 — Detalhe, Planejamento e despesas fixas ─────────

function emailBalancoJul2026(nome) {
  const item = (emoji, titulo, desc) =>
    `<tr><td style="padding:11px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:28px;vertical-align:top;padding-top:2px;font-size:18px;">${emoji}</td>
        <td style="padding-left:10px;">
          <p style="margin:0 0 3px;font-size:13px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.55;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  const secao = (titulo) =>
    `<tr><td style="padding:18px 0 6px;">
      <p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Detalhe, Planejamento e despesas fixas — mais precisos</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Revisamos a aba Detalhe do orçamento a fundo esta semana. Agora ela mostra tudo o que compõe o seu mês — e bate certinho com o Planejamento e com a tela inicial:
    </p>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:8px;">

      ${secao('📊 Aba Detalhe — o quadro completo')}
      ${item('🧾','Todas as despesas num só lugar','Já lançadas, pendentes, faturas a vencer e até as despesas fixas que ainda não foram lançadas neste mês — tudo aparece na aba Detalhe agora.')}
      ${item('✅','Total bate com o Planejamento','O total da aba Detalhe agora é exatamente igual ao Realizado do Planejamento — sem mais diferenças entre as duas telas.')}
      ${item('🏠','Tela inicial consistente','O card de Despesa na tela inicial passou a usar o mesmo critério do Detalhe — o número que você vê ao abrir o app agora é o mesmo em qualquer lugar do dashboard.')}

      ${secao('🔄 Despesas fixas — mais previsíveis')}
      ${item('📅','Só valem a partir do mês certo','Uma despesa fixa nova passa a contar a partir do mês que você escolher — ela não aparece mais retroativamente em meses anteriores.')}
      ${item('⏭️','"Pular este mês" funciona em qualquer mês','Corrigimos um problema em que pular uma ocorrência de despesa fixa num mês futuro não tinha efeito.')}
      ${item('🗓️','Lançamento vai pro mês certo','Ao registrar algo com data de outro mês (ex: já pensando no próximo), o lançamento agora é salvo no mês da data escolhida, não no mês que você estava vendo na tela.')}

      ${secao('📈 Saldo Projetado')}
      ${item('🔮','Mais preciso','O Saldo Projetado Futuro agora também desconta as despesas fixas ainda não lançadas, refletindo melhor o que realmente vai sair da conta.')}

    </table>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;background:#FBF8F1;border:1px solid #E8D9B5;border-radius:10px;">
      <tr><td style="padding:16px 18px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#CFAE65;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">🔜 O QUE VEM POR AÍ</p>
        <p style="margin:0;font-size:13px;color:#0D2B45;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
          Estamos trabalhando para permitir <strong>múltiplas contas correntes</strong> dentro do orçamento — pra você acompanhar cada conta separadamente, tudo no mesmo lugar.
        </p>
      </td></tr>
    </table>

    <a href="https://dashboard.flaviaschusciman.com/orcamento.html" style="${S.btn}">
      Ver o orçamento →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

// ─── Múltiplas contas correntes — Jul/2026 ───────────────────────────────────

function emailMultiplasContasJul2026(nome) {
  const item = (emoji, titulo, desc) =>
    `<tr><td style="padding:11px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:28px;vertical-align:top;padding-top:2px;font-size:18px;">${emoji}</td>
        <td style="padding-left:10px;">
          <p style="margin:0 0 3px;font-size:13px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.55;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  const secao = (titulo) =>
    `<tr><td style="padding:18px 0 6px;">
      <p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Chegou: múltiplas contas correntes</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      A novidade que a gente vinha adiantando chegou: agora dá para cadastrar mais de uma conta corrente no seu orçamento e escolher, lançamento a lançamento, onde cada uma entra.
    </p>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:8px;">

      ${secao('🏦 Múltiplas contas')}
      ${item('➕','Cadastre quantas contas usar','Em Contas, no orçamento, adicione cada conta corrente que você movimenta e alterne entre elas ou veja tudo somado no modo Consolidado.')}
      ${item('🎯','Escolha a conta ao lançar','Toda despesa ou receita manual agora tem um campo de conta — só aparece pra quem já tem mais de uma cadastrada.')}
      ${item('💳','E na hora de pagar a fatura também','Ao confirmar o pagamento de uma fatura de cartão, você escolhe de qual conta o valor saiu — o cartão em si não fica preso a nenhuma conta.')}

      ${secao('🛠️ Também corrigimos')}
      ${item('✅','Lançamento de hoje pede confirmação','Receitas e despesas com data de hoje agora só entram no caixa depois de confirmadas — igual já acontecia com datas futuras.')}
      ${item('🧾','Fatura paga não some mais','Corrigimos um erro em que confirmar o pagamento de uma fatura sem itens detalhados (só ajuste) fazia ela desaparecer da aba Faturas e parar de contar no saldo.')}
      ${item('📊','Fatura paga aparece no Resumo por categoria','O valor de uma fatura já paga agora entra também na lista por categoria do Resumo, não só no total do topo.')}

    </table>

    <a href="https://dashboard.flaviaschusciman.com/orcamento.html" style="${S.btn}">
      Ver o orçamento →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

// ─── Importar extrato com IA, direto no Orçamento — Jul/2026 ──────────────────

function emailRaioXJul2026(nome) {
  const item = (emoji, titulo, desc) =>
    `<tr><td style="padding:11px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:28px;vertical-align:top;padding-top:2px;font-size:18px;">${emoji}</td>
        <td style="padding-left:10px;">
          <p style="margin:0 0 3px;font-size:13px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.55;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  const secao = (titulo) =>
    `<tr><td style="padding:18px 0 6px;">
      <p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Chegou: importar extrato com IA, direto no Dashboard</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      A classificação por inteligência artificial que você conhecia pelo Raio-X saiu do agente de chat e entrou direto na aba Orçamento do seu Dashboard. Não precisa mais abrir outra conversa nem colar entre duas telas — cai direto no seu orçamento.
    </p>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:8px;">

      ${secao('⚡ O que mudou')}
      ${item('📥','Botão "Importar extrato com IA" no Orçamento','Na aba Orçamento, cole o texto ou envie o PDF do extrato ou da fatura do cartão — a IA lê e classifica cada lançamento.')}
      ${item('✅','Você só revisa antes de confirmar','Quando um lançamento não é claro, o Dashboard pergunta antes de confirmar — igual o agente já fazia, só que sem sair da tela.')}
      ${item('🔁','Quantas vezes quiser','Importe extratos e faturas à vontade, direto no mês certo, sem depender de outra ferramenta.')}

    </table>

    <a href="https://dashboard.flaviaschusciman.com/orcamento.html" style="${S.btn}">
      Ver o orçamento →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

// ─── Importar Patrimônio com IA — IR, corretora e dívidas — Jul/2026 ──────────

function emailPatrimonioIAJul2026(nome) {
  const item = (emoji, titulo, desc) =>
    `<tr><td style="padding:11px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:28px;vertical-align:top;padding-top:2px;font-size:18px;">${emoji}</td>
        <td style="padding-left:10px;">
          <p style="margin:0 0 3px;font-size:13px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.55;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  const secao = (titulo) =>
    `<tr><td style="padding:18px 0 6px;">
      <p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Chegou: importe seu Patrimônio com IA</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Declaração de IR, posição da corretora e dívidas agora entram no seu Dashboard do mesmo jeito que o extrato do Orçamento: cole o texto ou envie o PDF/foto, e a IA organiza tudo — sem planilha, sem CSV.
    </p>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:8px;">

      ${secao('🏦 O que mudou')}
      ${item('🏠','IR e corretora não se misturam mais','A declaração de IR só traz bens não financeiros (imóveis, veículos, bens móveis) — investimentos entram só pela posição da corretora, sempre atualizados.')}
      ${item('🏦','Mais de uma posição de corretora','Casal ou mais de uma corretora? Cada posição fica separada e nomeada — importar uma nova não apaga a outra, e o total soma todas.')}
      ${item('🚗','Automóveis e Bens Móveis, separados de Alternativos','Um carro não conta mais como cripto ou COE na tela de patrimônio nem na cobertura das suas Reservas.')}
      ${item('🔍','Classificação de fundos mais criteriosa','A IA olha a estratégia real do fundo, não só o rótulo do documento — quando não tem certeza, pede pra você confirmar antes de salvar.')}
      ${item('💳','Dívidas: mais seguro reimportar','Agora avisa antes de substituir a lista, e preserva o checklist de parcelas já pagas das dívidas que continuam existindo.')}

    </table>

    <a href="https://dashboard.flaviaschusciman.com/patrimonio.html" style="${S.btn}">
      Ver o Patrimônio →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

// ─── Comunicado Técnico ───────────────────────────────────────────────────────

function emailComunicadoTecnico(nome) {
  return layout(`
    <h2 style="${S.h2}">Aviso sobre o Trilogia Dashboard</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Identificamos uma instabilidade temporária no acesso ao Trilogia Dashboard pelo celular.
      O problema já foi corrigido — mas se o app estiver travando na tela de carregamento
      ou não abrindo corretamente, siga os passos abaixo para resolver em menos de 1 minuto.
    </p>
    <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      Como resolver no Android:
    </p>
    <p style="margin:0 0 20px;font-size:14px;color:#4b5563;line-height:1.8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      1. Desinstale o app da tela inicial (segure o ícone → Desinstalar)<br>
      2. Abra o Chrome e acesse <strong style="color:#0D2B45;">dashboard.flaviaschusciman.com</strong><br>
      3. Faça login normalmente<br>
      4. Toque em <strong style="color:#0D2B45;">"Instalar"</strong> no banner que aparece na parte de baixo<br>
      5. Pronto — app reinstalado e funcionando
    </p>
    <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      Como resolver no iPhone:
    </p>
    <p style="margin:0 0 28px;font-size:14px;color:#4b5563;line-height:1.8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      1. Exclua o app da tela inicial (segure o ícone → Excluir)<br>
      2. Abra o Safari e acesse <strong style="color:#0D2B45;">dashboard.flaviaschusciman.com</strong><br>
      3. Toque no ícone de compartilhar → <strong style="color:#0D2B45;">"Adicionar à Tela de Início"</strong>
    </p>
    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Acessar o dashboard →
    </a>
    <p style="${S.pSmall}">
      Qualquer dúvida, responda este e-mail.<br>
      <strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong>
    </p>
  `);
}

// ─── Relatório Mensal ─────────────────────────────────────────────────────────

/**
 * E-mail: relatório do mês anterior enviado no dia 1.
 * @param {string} nome
 * @param {string} nomeMes  — ex: "Maio de 2026"
 * @param {object} orc      — { receita, despesa, sobra, aporte }
 * @param {number} pl       — patrimônio líquido atual
 * @param {number} totalReservas
 */
function emailRelatorioMensal(nome, nomeMes, orc, pl, totalReservas) {
  const brl = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const pct = (v, t) => t > 0 ? ((v / t) * 100).toFixed(1) + '%' : '—';

  const sobraPositiva = (orc.sobra || 0) >= 0;
  const sobraColor    = sobraPositiva ? '#16a34a' : '#dc2626';
  const aporteFeito   = (orc.aporte || 0) > 0;

  const card = (label, valor, cor = '#0D2B45', sub = '') => `
    <td style="width:50%;padding:4px;">
      <div style="background:#f8fafc;border-radius:10px;padding:16px 14px;border-left:3px solid ${cor};">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${label}</div>
        <div style="font-size:18px;font-weight:700;color:${cor};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${valor}</div>
        ${sub ? `<div style="font-size:11px;color:#9ca3af;margin-top:3px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${sub}</div>` : ''}
      </div>
    </td>`;

  return layout(`
    <h2 style="${S.h2}">Seu resumo de ${nomeMes}</h2>
    <p style="${S.p}">Olá, ${nome}! Aqui está como foi o seu mês financeiro.</p>

    <!-- Cards de orçamento -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr>
        ${card('Receita', brl(orc.receita), '#0D2B45')}
        ${card('Despesas', brl(orc.despesa), '#dc2626', pct(orc.despesa, orc.receita) + ' da receita')}
      </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr>
        ${card('Sobra do mês', brl(orc.sobra), sobraColor, pct(Math.abs(orc.sobra), orc.receita) + ' da receita')}
        ${card('Aporte efetivado', aporteFeito ? brl(orc.aporte) : '—', aporteFeito ? '#16a34a' : '#9ca3af', aporteFeito ? pct(orc.aporte, orc.receita) + ' da receita' : 'Nenhum aporte registrado')}
      </tr>
    </table>

    <!-- Patrimônio -->
    ${pl > 0 ? `
    <div style="background:#0D2B45;border-radius:10px;padding:18px 20px;margin:16px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:11px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:.05em;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Patrimônio Líquido</div>
          <div style="font-size:22px;font-weight:700;color:#CFAE65;margin-top:4px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${brl(pl)}</div>
        </div>
        ${totalReservas > 0 ? `
        <div style="text-align:right;">
          <div style="font-size:11px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:.05em;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Total em reservas</div>
          <div style="font-size:16px;font-weight:600;color:#fff;margin-top:4px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${brl(totalReservas)}</div>
        </div>` : ''}
      </div>
    </div>` : ''}

    <!-- Mensagem motivacional personalizada -->
    <p style="${S.p}">
      ${!aporteFeito
        ? 'Que tal registrar um aporte este mês? Pequenos investimentos consistentes fazem a maior diferença no longo prazo.'
        : sobraPositiva
          ? 'Ótimo trabalho! Você teve sobra positiva e ainda efetivou um aporte. Siga assim.'
          : 'Você efetivou um aporte — isso é o mais importante. Revise as categorias de despesa para aumentar a sobra no próximo mês.'}
    </p>

    <a href="https://dashboard.flaviaschusciman.com/orcamento.html" style="${S.btn}">
      Ver orçamento completo →
    </a>
  `);
}

// ─── Retenção (série de alerta de pagamento) ──────────────────────────────────

/**
 * Retenção dia 1 — tom suave, lembrete amigável.
 */
function emailRetencaoDia1(nome) {
  return layout(`
    <h2 style="${S.h2}">Identificamos um atraso no seu pagamento</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Parece que houve um atraso na cobrança da sua assinatura do Trilogia Dashboard.
      Isso pode acontecer por vencimento do cartão, limite ou instabilidade temporária.
    </p>
    <p style="${S.p}">
      Regularize pelo link que você recebeu na compra ou entre em contato respondendo este e-mail
      para que a gente possa te ajudar rapidinho.
    </p>
    <p style="${S.p}">Seu acesso continua ativo enquanto isso é resolvido.</p>
    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Acessar o dashboard
    </a>
  `);
}

/**
 * Retenção dia 3 — tom mais urgente, mostra o que está em risco.
 */
function emailRetencaoDia3(nome) {
  return layout(`
    <h2 style="${S.h2}">Seu acesso ao Dashboard está em risco</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      O pagamento da sua assinatura ainda não foi identificado. Se não for regularizado
      em breve, seu acesso ao Trilogia Dashboard será suspenso.
    </p>
    <p style="${S.p}">Você perderia o acompanhamento de:</p>
    <ul style="color:#C8C8D0;font-size:15px;line-height:1.8;padding-left:20px;margin:12px 0 20px;">
      <li>Orçamento mensal e planejamento por categoria</li>
      <li>Evolução do patrimônio líquido e reservas</li>
      <li>Metas e progresso das suas reservas financeiras</li>
      <li>Histórico de 12 meses do seu patrimônio</li>
    </ul>
    <p style="${S.p}">
      Regularize agora para não perder o fio da meada — especialmente com tudo que
      você já construiu até aqui.
    </p>
    <a href="mailto:flaviasch@gmail.com?subject=Regularizar%20assinatura%20Dashboard" style="${S.btn}">
      Falar com a Flávia
    </a>
  `);
}

/**
 * Retenção dia 7 — último aviso antes do bloqueio.
 */
function emailRetencaoDia7(nome) {
  return layout(`
    <h2 style="${S.h2}">Último aviso — acesso será suspenso em breve</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Este é o último aviso antes da suspensão do seu acesso ao Trilogia Dashboard.
      O pagamento está em atraso há 7 dias e, caso não seja regularizado, o acesso
      será bloqueado automaticamente.
    </p>
    <p style="${S.p}">
      Se quiser manter tudo que construiu — seu histórico financeiro, reservas
      e planejamento — regularize agora ou responda este e-mail para conversar.
    </p>
    <p style="${S.p}">
      Você pode reativar o acesso a qualquer momento após a regularização.
    </p>
    <a href="mailto:flaviasch@gmail.com?subject=Reativar%20acesso%20Dashboard" style="${S.btn}">
      Reativar meu acesso
    </a>
  `);
}

/**
 * E-mail de upgrade: oferece assinatura standalone do Dashboard (mensal ou anual).
 * @param {string} nome
 * @param {'mentoria'|'raio-x'} contexto — 'mentoria' (padrão, comportamento original):
 *   enviado quando a mentoria é encerrada. 'raio-x': enviado durante a régua de fim de
 *   degustação (D-7/D-3/D-0) do Raio-X, ver notifExpiracaoProxima.
 * @param {number|null} diasRestantes — só usado no contexto 'raio-x' (7, 3 ou 0).
 *
 * Preços atualizados em 10/07/2026 (R$147/1.470 → R$97/970, confirmado por Flávia).
 * Os links de checkout do Kiwify (pay.kiwify.com.br/...) não foram alterados —
 * confirmar antes do deploy se continuam apontando para os planos corretos com
 * o valor novo, já que o link em si não carrega o preço.
 */
function emailUpgradeDashboard(nome, contexto = 'mentoria', diasRestantes = null) {
  const intro = contexto === 'raio-x'
    ? {
        titulo: diasRestantes === 0
          ? 'Hoje é o último dia da sua degustação do Raio-X'
          : `Faltam ${diasRestantes} dias para o fim da sua degustação do Raio-X`,
        paragrafo: `
          Seu período de degustação do Raio-X no Dashboard Trilogia está chegando ao fim.
          Se ele já te ajudou a enxergar para onde vai o seu dinheiro, o Dashboard completo
          vai além: Patrimônio, Reservas de longo prazo e Perfil de investidor — tudo na
          mesma conta, sem perder nada do que você já lançou no Orçamento.
        `,
      }
    : {
        titulo: 'Sua mentoria chegou ao fim — e sua jornada continua',
        paragrafo: `
          Sua Mentoria Trilogia Financeira foi encerrada. Foi uma trajetória de muito aprendizado
          e avanço na sua vida financeira — e tudo que você construiu fica guardado no seu Dashboard.
        `,
      };
  return layout(`
    <h2 style="${S.h2}">${intro.titulo}</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">${intro.paragrafo}</p>
    <p style="${S.p}">
      Para continuar acompanhando seu patrimônio, reservas, orçamento e score financeiro,
      você pode manter o acesso com a assinatura do Trilogia Dashboard:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td align="center" style="padding:0 8px 12px;">
          <a href="https://pay.kiwify.com.br/PSL7Vy5" style="${S.btn}">
            Mensal — R$&nbsp;67/mês
          </a>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:0 8px;">
          <a href="https://pay.kiwify.com.br/hIoLfti" style="display:inline-block;background:#f3f4f6;color:#0D2B45;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;text-decoration:none;">
            Anual — R$&nbsp;670/ano <span style="font-size:12px;font-weight:400;color:#6b7280;">(economize 2 meses)</span>
          </a>
        </td>
      </tr>
    </table>
    <p style="${S.pSmall}">
      Prefere ter também acesso ao Clube Trilogia junto com o Dashboard? Existe o
      <a href="https://pay.kiwify.com.br/UzajRCK" style="color:#CFAE65;">Combo mensal — R$&nbsp;97/mês</a>
      ou o <a href="https://pay.kiwify.com.br/PcIs3z1" style="color:#CFAE65;">Combo anual — R$&nbsp;970/ano</a>.
    </p>
    <p style="${S.pSmall}">
      Em caso de dúvidas, fale diretamente com a Flávia pelo WhatsApp ou e-mail.
    </p>
  `);
}

// ─── Minha Jornada no Dashboard ──────────────────────────────────────────────

function emailJornadaDashboard(nome) {
  const featureItem = (emoji, titulo, desc) =>
    `<tr><td style="padding:12px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:32px;vertical-align:top;padding-top:2px;font-size:20px;">${emoji}</td>
        <td style="padding-left:12px;">
          <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Nova aba no seu Dashboard: Minha Jornada</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      A partir de agora, quem está em processo de mentoria pode acompanhar a jornada diretamente pelo Dashboard,
      na nova aba <strong style="color:#0D2B45;">Minha Jornada</strong>.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:24px;">
      ${featureItem('📍','Onde você está na mentoria','Visualize em qual etapa do processo você está, quantos encontros já aconteceram e o que vem pela frente.')}
      ${featureItem('✅','Lições de casa do último encontro','As tarefas combinadas no seu encontro mais recente aparecem direto no dashboard, para você não perder nenhum compromisso assumido.')}
      ${featureItem('📅','Histórico de encontros','Todos os encontros realizados ficam registrados com tema, data e anotações — uma linha do tempo da sua jornada financeira.')}
      ${featureItem('🎯','Missão do mês','O foco definido para o mês fica destacado no topo da aba, para orientar suas ações no período.')}
    </table>
    <a href="https://dashboard.flaviaschusciman.com/jornada.html" style="${S.btn}">
      Ver Minha Jornada →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

function emailNovidadesJun2026Completo(nome) {
  const item = (emoji, titulo, desc) =>
    `<tr><td style="padding:11px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:28px;vertical-align:top;padding-top:2px;font-size:18px;">${emoji}</td>
        <td style="padding-left:10px;">
          <p style="margin:0 0 3px;font-size:13px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.55;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  const secao = (titulo) =>
    `<tr><td style="padding:18px 0 6px;">
      <p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Tudo que melhoramos em Junho para você</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Junho foi um mês cheio de novidades no seu Dashboard. Veja o que ficou mais fácil, mais preciso e mais completo:
    </p>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:8px;">

      ${secao('💰 Orçamento — novo card Saldo em Conta')}
      ${item('🏦','Saldo em Conta','Informe quanto está na conta no início do mês. O Dashboard usa esse valor no cálculo da Sobra e do Saldo Final automaticamente.')}
      ${item('🏁','Saldo Final','Novo card que mostra: saldo + receita − despesas − aporte. O retrato real do que sobrou no caixa.')}

      ${secao('💳 Cartão — ciclo de vida completo da fatura')}
      ${item('📆','Despesa cai no mês do pagamento','Compra feita agora aparece no mês em que a fatura vence, não no mês do lançamento. Zero confusão no fluxo de caixa.')}
      ${item('✂️','Fatura aberta e fechada','Controle se a fatura já fechou ou ainda está aberta. O saldo pendente vira fatura do próximo mês automaticamente.')}
      ${item('📋','Despesas fixas em meses futuros','Os lançamentos fixos do mês atual são copiados para os meses seguintes quando você navega para frente.')}

      ${secao('🗺️ Minha Jornada')}
      ${item('✅','Lições de casa clicáveis','As tarefas da sua jornada agora têm checkbox. Marque como feito e o Notion é atualizado em tempo real.')}
      ${item('📚','Materiais do encontro','Links, gravações e materiais de cada sessão aparecem diretamente na aba Minha Jornada.')}

      ${secao('📱 App móvel — Android e iPhone')}
      ${item('🔧','Botões funcionando no Android PWA','Corrigimos travamentos em modais e botões que não respondiam no app instalado no Android.')}
      ${item('🔔','Notificações com dismiss que funciona','O X das notificações agora dispensa corretamente no Android e salva o estado entre sessões.')}
      ${item('🔑','Sessão que não expira do nada','Renovação automática do token de acesso — sem logout inesperado no meio do dia.')}

      ${secao('🔐 Segurança')}
      ${item('🧹','Exclusão completa de dados (LGPD)','Ao encerrar a mentoria, todos os dados pessoais são removidos do Drive e do Notion de forma automática.')}

    </table>

    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Explorar as novidades →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

function emailNovidadesJul2026Completo(nome) {
  const item = (emoji, titulo, desc) =>
    `<tr><td style="padding:11px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:28px;vertical-align:top;padding-top:2px;font-size:18px;">${emoji}</td>
        <td style="padding-left:10px;">
          <p style="margin:0 0 3px;font-size:13px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.55;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  const secao = (titulo) =>
    `<tr><td style="padding:18px 0 6px;">
      <p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Julho foi grande — veja tudo que melhoramos pra você</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Julho trouxe seis grandes mudanças no seu Dashboard. Veja o que ficou mais fácil, mais preciso e mais completo:
    </p>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:8px;">

      ${secao('💳 Cartão, faturas e Minha Jornada')}
      ${item('📆','Despesa cai no mês do pagamento','Compra no cartão aparece no mês em que a fatura vence, não no mês do lançamento.')}
      ${item('✂️','Fatura paga parcial','O saldo pendente vira fatura do próximo mês automaticamente.')}
      ${item('📚','Materiais de cada encontro','Links e gravações da sua Jornada aparecem direto na aba Minha Jornada.')}

      ${secao('📊 Detalhe e Planejamento mais precisos')}
      ${item('🧾','Todas as despesas num só lugar','Já lançadas, pendentes, faturas a vencer e despesas fixas ainda não lançadas — tudo na aba Detalhe.')}
      ${item('✅','Total bate com o Planejamento','O total da aba Detalhe agora é igual ao Realizado do Planejamento e ao card de Despesa da tela inicial.')}
      ${item('🔮','Saldo Projetado mais preciso','Agora também desconta as despesas fixas ainda não lançadas.')}

      ${secao('⚡ Importação por IA')}
      ${item('📥','Importe extrato e fatura direto no Orçamento','Chega de planilha separada — a IA classifica cada lançamento automaticamente e aprende com suas correções.')}
      ${item('🏦','Importe seu Patrimônio com IA','Declaração de IR, posição da corretora (com suporte a mais de uma) e dívidas — cole o texto ou envie o PDF/foto.')}

      ${secao('🏦 Múltiplas contas correntes')}
      ${item('💼','Escolha a conta em cada lançamento','Ao registrar despesa/receita ou confirmar pagamento de fatura, escolha em qual conta isso aconteceu.')}
      ${item('📈','Saldo por conta','Cada conta tem seu próprio saldo, com carryover automático de mês pra mês.')}

      ${secao('🏢 Chegou o Dashboard PJ')}
      ${item('🏢','Finanças da sua empresa, com o mesmo cuidado','Impostos previstos, notas emitidas, contas a pagar/receber, reservas e DRE simplificado — mesmo login do Dashboard pessoal. Responda este e-mail se quiser ativar.')}

    </table>

    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Explorar as novidades →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

function emailNovidadesAgo2026Completo(nome) {
  const item = (emoji, titulo, desc) =>
    `<tr><td style="padding:11px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:28px;vertical-align:top;padding-top:2px;font-size:18px;">${emoji}</td>
        <td style="padding-left:10px;">
          <p style="margin:0 0 3px;font-size:13px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.55;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  const secao = (titulo) =>
    `<tr><td style="padding:18px 0 6px;">
      <p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Tudo que melhoramos em Agosto</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Mais um mês de ajustes direto do uso real do Dashboard. Veja o que chegou:
    </p>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:8px;">

      ${secao('💳 Orçamento')}
      ${item('⇄','Transferência entre contas','Registre transferências entre suas contas cadastradas — o saldo por conta se ajusta, o saldo consolidado não muda.')}
      ${item('💳','Pague a fatura adiantado','Novo botão "Pagar adiantado" no card da fatura aberta. Quando ela fechar, o valor já pago é descontado automaticamente.')}
      ${item('🗂️','Categorias do seu jeito','Agora dá pra criar categorias-mãe próprias, além das já existentes.')}
      ${item('📅','Detalhe também por data','Além de ver por categoria, agora dá pra ver todos os lançamentos do mês organizados por data.')}

      ${secao('🗺️ Minha Jornada')}
      ${item('🧭','Mapa da Liberdade Financeira no Dashboard','A calculadora que projeta sua liberdade financeira mês a mês agora está dentro da Jornada, sem precisar de arquivo separado.')}
      ${item('✅','Checklist antes de decidir','P.A.R.I.S. e Anti-Impulso viraram um checklist guiado direto na Jornada, pra usar antes de qualquer decisão de compra.')}
      ${item('🔥','Desafio dos 7 dias','O desafio da consciência financeira também já está disponível na Jornada.')}

      ${secao('🏢 Dashboard PJ — cresceu')}
      ${item('📊','DRE e Ponto de Equilíbrio','Veja o resultado da empresa e a partir de quanto ela começa a dar lucro.')}
      ${item('📥','Contas a Receber','Controle consolidado do que ainda vai entrar, por cliente e vencimento.')}
      ${item('🏦','Reservas PJ com retirada sugerida','Reservas da empresa com sugestão automática de quanto retirar.')}
      ${item('❓','FAQ do Dashboard PJ','Tutorial e perguntas frequentes direto na área da empresa.')}
      ${item('💰','Calculadora de Pró-labore','Defina um salário fixo por trimestre com previsibilidade, e distribua o excedente entre sazonalidade, emergência, reinvestimento e distribuição.')}

    </table>

    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Explorar as novidades →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

function emailModoClaroAporteAgo2026(nome) {
  const item = (emoji, titulo, desc) =>
    `<tr><td style="padding:11px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="width:28px;vertical-align:top;padding-top:2px;font-size:18px;">${emoji}</td>
        <td style="padding-left:10px;">
          <p style="margin:0 0 3px;font-size:13px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${titulo}</p>
          <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.55;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${desc}</p>
        </td>
      </tr></table>
    </td></tr>`;

  return layout(`
    <h2 style="${S.h2}">Modo claro chegou ao Dashboard</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Duas novidades direto do uso real do Dashboard:
    </p>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:8px;">
      ${item('☀️','Modo claro/escuro','Toque no ícone de sol/lua no menu, ao lado do seu e-mail, pra alternar entre tema claro e escuro. Sua escolha fica salva no navegador, não precisa escolher de novo toda vez.')}
      ${item('💰','Aporte mais simples','Se você pular a etapa de escolher a classe do aporte, o sistema já assume pós-fixado automaticamente e o valor entra direto no seu patrimônio, sem ficar parado só na reserva.')}
    </table>

    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Ver dashboard →
    </a>
    <p style="${S.pSmall}">Com carinho,<br><strong style="color:#0D2B45;">Flávia Schuscimann, CFP®</strong></p>
  `);
}

module.exports = {
  sendEmail,
  emailRenovacaoPerfil,
  emailSemPerfil,
  emailLembreteOrcamento,
  emailLembreteAporte,
  emailLembretePlanejamento,
  emailNovidades,
  emailNovidadesJun2026,
  emailNovidadesJun2026v3,
  emailNovidadesJun2026Completo,
  emailNovidadesJul2026,
  emailNovidadesJul2026Completo,
  emailNovidadesAgo2026Completo,
  emailModoClaroAporteAgo2026,
  emailBalancoJul2026,
  emailMultiplasContasJul2026,
  emailRaioXJul2026,
  emailPatrimonioIAJul2026,
  emailJornadaDashboard,
  emailComunicadoTecnico,
  emailIR,
  emailReenvioAcesso,
  emailBoasVindas,
  emailExpiracaoProxima,
  emailCobrancasDia,
  emailImpostosDia,
  emailRetencaoDia1,
  emailRetencaoDia3,
  emailRetencaoDia7,
  emailRelatorioMensal,
  emailUpgradeDashboard,
};
