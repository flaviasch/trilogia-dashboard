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

/**
 * E-mail: anúncio das novidades da Fase 2 do orçamento.
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
      O Trilogia Dashboard ganhou três novidades este mês — todas pensadas para deixar seu acompanhamento financeiro mais claro, mais visual e mais fácil de usar.
    </p>
    <p style="margin:0 0 16px;font-size:14px;font-weight:700;color:#0D2B45;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      O que chegou:
    </p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:24px;">
      ${featureItem('✦','Missão do mês','Ao concluir a configuração do seu dashboard, uma missão personalizada aparece na tela inicial a cada mês. Ela combina uma meta definida especialmente para você com o seu score financeiro atual — para você saber exatamente onde focar.')}
      ${featureItem('📊','Exportação anual em PDF','Na aba Anual do Orçamento, agora existe um botão para exportar o resumo completo do ano em PDF — receita, despesa, sobra e score mês a mês, tudo em uma página organizada para guardar ou compartilhar.')}
      ${featureItem('★','Clube Trilogia renovado','Gravações e materiais adicionados nos últimos 7 dias ganham o selo Novo para você não perder nada. As seções aparecem apenas quando há conteúdo publicado, e cada vídeo agora exibe uma descrição do que você vai encontrar.')}
    </table>
    <a href="https://dashboard.flaviaschusciman.com" style="${S.btn}">
      Acessar agora →
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
 * E-mail de upgrade: enviado à mentorada quando a mentoria é encerrada.
 * Oferece assinatura standalone do Dashboard (mensal ou anual).
 */
function emailUpgradeDashboard(nome) {
  return layout(`
    <h2 style="${S.h2}">Sua mentoria chegou ao fim — e sua jornada continua</h2>
    <p style="${S.p}">Olá, ${nome}!</p>
    <p style="${S.p}">
      Sua Mentoria Trilogia Financeira foi encerrada. Foi uma trajetória de muito aprendizado
      e avanço na sua vida financeira — e tudo que você construiu fica guardado no seu Dashboard.
    </p>
    <p style="${S.p}">
      Para continuar acompanhando seu patrimônio, reservas, orçamento e score financeiro,
      você pode manter o acesso com a assinatura do Trilogia Dashboard:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td align="center" style="padding:0 8px 12px;">
          <a href="https://pay.kiwify.com.br/ntySa9B" style="${S.btn}">
            Mensal — R$&nbsp;147/mês
          </a>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:0 8px;">
          <a href="https://pay.kiwify.com.br/KIhxony" style="display:inline-block;background:#f3f4f6;color:#0D2B45;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;text-decoration:none;">
            Anual — R$&nbsp;1.470/ano <span style="font-size:12px;font-weight:400;color:#6b7280;">(economize 2 meses)</span>
          </a>
        </td>
      </tr>
    </table>
    <p style="${S.pSmall}">
      Em caso de dúvidas, fale diretamente com a Flávia pelo WhatsApp ou e-mail.
    </p>
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
  emailComunicadoTecnico,
  emailIR,
  emailReenvioAcesso,
  emailBoasVindas,
  emailExpiracaoProxima,
  emailCobrancasDia,
  emailRetencaoDia1,
  emailRetencaoDia3,
  emailRetencaoDia7,
  emailRelatorioMensal,
  emailUpgradeDashboard,
};
