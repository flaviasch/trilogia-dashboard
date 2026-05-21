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

const ESTILOS_BASE = `
  body { margin:0; padding:0; background:#0D2B45; font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; }
  .wrap { max-width:560px; margin:0 auto; padding:40px 24px; }
  .logo { font-size:18px; font-weight:700; color:#fff; margin-bottom:32px; letter-spacing:-.3px; }
  .logo span { color:#CFAE65; }
  h2 { font-size:22px; font-weight:700; color:#fff; margin:0 0 12px; line-height:1.3; }
  p  { font-size:14px; color:rgba(255,255,255,.65); line-height:1.6; margin:0 0 20px; }
  .btn {
    display:inline-block; background:#CFAE65; color:#0D2B45; text-decoration:none;
    font-size:14px; font-weight:700; padding:12px 28px; border-radius:8px;
  }
  .footer { margin-top:40px; font-size:11px; color:rgba(255,255,255,.25); line-height:1.6; }
  hr { border:none; border-top:1px solid rgba(255,255,255,.08); margin:32px 0; }
`;

function layout(conteudo) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${ESTILOS_BASE}</style></head>
    <body><div class="wrap">
      <div class="logo">Trilogia <span>Dashboard</span></div>
      ${conteudo}
      <hr>
      <div class="footer">
        Você recebeu este e-mail porque é mentorada da Trilogia Financeira.<br>
        Para dúvidas, responda diretamente a este e-mail.
      </div>
    </div></body></html>`;
}

/**
 * E-mail: renovação de perfil de investidor.
 * @param {string} nome  — nome da mentorada
 * @param {number} meses — meses desde a última atualização
 */
function emailRenovacaoPerfil(nome, meses) {
  return layout(`
    <h2>Hora de revisar seu perfil de investidor</h2>
    <p>Olá, ${nome}!</p>
    <p>
      Seu perfil de investidor foi atualizado há <strong>${meses} meses</strong>.
      Recomendamos revisá-lo pelo menos a cada 6 meses para garantir que
      suas reservas continuem alinhadas ao seu momento de vida e objetivos.
    </p>
    <a href="https://trilogia-dashboard.web.app/perfil.html" class="btn">
      Atualizar perfil
    </a>
  `);
}

/**
 * E-mail: perfil ainda não cadastrado.
 */
function emailSemPerfil(nome) {
  return layout(`
    <h2>Configure seu perfil de investidor</h2>
    <p>Olá, ${nome}!</p>
    <p>
      Você ainda não cadastrou seu perfil de investidor no Dashboard.
      Ele é a base para definir a estratégia de alocação das suas reservas
      e personalizar suas orientações financeiras.
    </p>
    <a href="https://trilogia-dashboard.web.app/perfil.html" class="btn">
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
    <h2>Registre o orçamento de ${nomeMes}</h2>
    <p>Olá, ${nome}!</p>
    <p>
      Começou um novo mês. Mantenha seu controle financeiro em dia
      lançando receitas e despesas de <strong>${nomeMes}</strong> no Dashboard.
    </p>
    <a href="https://trilogia-dashboard.web.app/orcamento.html" class="btn">
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
    <h2>Efetive o aporte de ${nomeMes}</h2>
    <p>Olá, ${nome}!</p>
    <p>
      O mês está chegando ao fim. Não esqueça de confirmar o aporte
      nas suas reservas referente a <strong>${nomeMes}</strong> e registrá-lo
      no Dashboard para manter o histórico atualizado.
    </p>
    <a href="https://trilogia-dashboard.web.app/reservas.html" class="btn">
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
    <h2>Atualize seu patrimônio com a declaração de IR</h2>
    <p>Olá, ${nome}!</p>
    <p>
      É maio — época de declaração de Imposto de Renda. Aproveite para importar
      sua declaração no Dashboard e manter imóveis, participações societárias e
      outros ativos fora da corretora devidamente atualizados no seu patrimônio.
    </p>
    <p>
      Com o patrimônio completo, a visão de alocação e as conciliações com suas
      reservas ficam muito mais precisas.
    </p>
    <a href="https://trilogia-dashboard.web.app/patrimonio.html" class="btn">
      Importar declaração IR
    </a>
  `);
}

/**
 * E-mail: reenvio de link de acesso (quando a aluna não recebeu o e-mail inicial
 * ou perdeu o link antes de criar a senha).
 * @param {string} nome      — nome da mentorada
 * @param {string} linkSenha — link gerado pelo Firebase para definir senha
 */
function emailReenvioAcesso(nome, linkSenha) {
  return layout(`
    <h2>Seu link de acesso ao Dashboard</h2>
    <p>Olá, ${nome}!</p>
    <p>
      Um novo link de acesso foi gerado para sua conta no Trilogia Dashboard.
      Clique no botão abaixo para definir (ou redefinir) sua senha e entrar na plataforma.
    </p>
    <a href="${linkSenha}" class="btn">
      Definir minha senha
    </a>
    <p style="margin-top:20px">
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
    <h2>Bem-vinda ao Trilogia Dashboard</h2>
    <p>Olá, ${nome}!</p>
    <p>
      Seu acesso ao Trilogia Dashboard está pronto. Clique no botão abaixo
      para criar sua senha e acessar a plataforma pela primeira vez.
    </p>
    <a href="${linkSenha}" class="btn">
      Criar minha senha
    </a>
    <p style="margin-top:20px">
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
    <h2>Seu acesso expira em 7 dias</h2>
    <p>Olá, ${nome}!</p>
    <p>
      Seu acesso ao Trilogia Dashboard expira em <strong>7 dias</strong>.
      Para continuar acompanhando seu patrimônio, reservas e orçamento,
      renove sua assinatura antes do vencimento.
    </p>
    <a href="https://trilogia-dashboard.web.app" class="btn">
      Acessar o Dashboard
    </a>
    <p style="margin-top:20px">
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
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);color:#fff">
        ${c.nomeAluna}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);color:rgba(255,255,255,.7)">
        ${PRODUTO_LABEL[c.produto] || c.produto}
        ${c.total > 1 ? `<span style="font-size:11px;color:rgba(255,255,255,.4)"> · ${c.numero}/${c.total}</span>` : ''}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);color:rgba(255,255,255,.7)">
        ${PAGAMENTO_LABEL[c.formaPagamento] || c.formaPagamento || '—'}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);color:#CFAE65;font-weight:600;text-align:right">
        ${brl(c.valor)}
      </td>
    </tr>`).join('');

  const total = cobrancas.reduce((s, c) => s + (c.valor || 0), 0);

  return layout(`
    <h2>Cobranças do dia ${fmt(cobrancas[0]?.vencimento || new Date().toISOString().slice(0,10))}</h2>
    <p>
      Você tem <strong>${cobrancas.length} cobrança${cobrancas.length !== 1 ? 's' : ''}</strong>
      com vencimento hoje. Total previsto: <strong style="color:#CFAE65">${brl(total)}</strong>.
    </p>
    <table style="width:100%;border-collapse:collapse;background:rgba(255,255,255,.03);
                  border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:rgba(255,255,255,.05)">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:rgba(255,255,255,.45);font-weight:500">Aluna</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:rgba(255,255,255,.45);font-weight:500">Produto</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:rgba(255,255,255,.45);font-weight:500">Forma</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;color:rgba(255,255,255,.45);font-weight:500">Valor</th>
        </tr>
      </thead>
      <tbody>${linhas}</tbody>
    </table>
    <div style="margin-top:16px;text-align:right;font-size:13px;color:rgba(255,255,255,.5)">
      Total: <strong style="color:#CFAE65">${brl(total)}</strong>
    </div>
    <br>
    <a href="https://dashboard.flaviaschusciman.com/admin.html" class="btn">
      Abrir painel admin
    </a>
  `);
}

module.exports = {
  sendEmail,
  emailRenovacaoPerfil,
  emailSemPerfil,
  emailLembreteOrcamento,
  emailLembreteAporte,
  emailIR,
  emailReenvioAcesso,
  emailBoasVindas,
  emailExpiracaoProxima,
  emailCobrancasDia,
};
