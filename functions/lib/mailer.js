'use strict';

/**
 * Envio de e-mail via Gmail API usando OAuth2 (googleapis).
 *
 * Usa as mesmas credenciais já disponíveis nas Cloud Functions:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *
 * REQUISITO: o refresh token deve incluir o escopo gmail.send.
 * Caso o token atual não o inclua, será necessário revogar e re-autorizar
 * adicionando o escopo: https://www.googleapis.com/auth/gmail.send
 */

const { google } = require('googleapis');

const REMETENTE_NOME  = 'Trilogia Dashboard';
const REMETENTE_EMAIL = 'flaviasch@gmail.com';

/**
 * Converte texto para Base64 URL-safe (necessário para a Gmail API).
 */
function toBase64(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Monta uma mensagem RFC 2822 em Base64 URL-safe.
 */
function montarMensagem({ to, subject, html }) {
  const boundary = `----=_Part_${Date.now()}`;
  const raw = [
    `From: ${REMETENTE_NOME} <${REMETENTE_EMAIL}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${toBase64(subject)}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    toBase64(html),
    '',
    `--${boundary}--`,
  ].join('\r\n');

  return toBase64(raw);
}

/**
 * Envia um e-mail via Gmail API (OAuth2 de Flávia).
 * @param {{ to: string, subject: string, html: string }} opts
 */
async function sendEmail({ to, subject, html }) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: montarMensagem({ to, subject, html }) },
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

module.exports = {
  sendEmail,
  emailRenovacaoPerfil,
  emailSemPerfil,
  emailLembreteOrcamento,
  emailLembreteAporte,
};
