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
function emailBoasVindas(nome, linkSenha) {
  return layout(`
    <h2 style="${S.h2}">Bem-vinda ao Trilogia Dashboard</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Seu acesso ao Trilogia Dashboard está pronto. Clique no botão abaixo
      para criar sua senha e acessar a plataforma pela primeira vez.
    </p>
    <a href="${linkSenha}" style="${S.btn}">
      Criar minha senha
    </a>
    <p style="${S.pSmall}">
      Após definir sua senha, você terá acesso ao acompanhamento completo
      do seu patrimônio, reservas e orçamento — tudo no mesmo lugar.
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

module.exports = {
  sendEmail,
  emailRenovacaoPerfil,
  emailSemPerfil,
  emailLembreteOrcamento,
  emailLembreteAporte,
  emailLembretePlanejamento,
  emailIR,
  emailReenvioAcesso,
  emailBoasVindas,
  emailExpiracaoProxima,
  emailCobrancasDia,
};
