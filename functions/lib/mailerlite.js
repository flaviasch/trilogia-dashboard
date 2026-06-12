'use strict';

/**
 * Cliente MailerLite para esteira de pós-venda.
 *
 * Pré-requisito: criar os grupos no painel MailerLite e configurar os secrets:
 *   MAILERLITE_API_KEY          — chave da API (Settings → Integrations → API)
 *   MAILERLITE_GRUPO_EBOOK      — ID do grupo para compradores de ebook
 *   MAILERLITE_GRUPO_CURSO      — ID do grupo para compradores de curso
 *
 * Como pegar o ID do grupo no MailerLite:
 *   Subscribers → Groups → clica no grupo → o ID aparece na URL:
 *   /subscribers/groups/123456789/subscribers → ID = 123456789
 */

const MAILERLITE_API_URL = 'https://connect.mailerlite.com/api';

// Mapa produto específico → ID do grupo no MailerLite
// Os valores vêm de variáveis de ambiente (secrets do Firebase)
function getGrupos() {
  return {
    raiox:         process.env.MAILERLITE_GRUPO_RAIOX        || null,
    mapa:          process.env.MAILERLITE_GRUPO_MAPA          || null,
    jdd:           process.env.MAILERLITE_GRUPO_JDD           || null,
    reserva_rende: process.env.MAILERLITE_GRUPO_RESERVA_RENDE || null,
  };
}

class MailerLiteClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error('[MailerLite] API key não configurada.');
    this.apiKey = apiKey;
  }

  /**
   * Inscreve ou atualiza um contato no grupo do produto comprado.
   * Idempotente: se o contato já existir, apenas adiciona ao grupo.
   *
   * @param {string} email   — e-mail do comprador
   * @param {string} nome    — nome completo
   * @param {string} produto — 'ebook' | 'curso'
   */
  async inscreverNaSequencia(email, nome, produto) {
    const grupos = getGrupos();
    const grupoId = grupos[produto];

    if (!grupoId) {
      console.warn(`[MailerLite] Grupo não configurado para produto "${produto}". Configure MAILERLITE_GRUPO_${produto.toUpperCase()}.`);
      return null;
    }

    const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

    // Cria/atualiza o subscriber
    const resSub = await fetch(`${MAILERLITE_API_URL}/subscribers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        email,
        fields: { name: nome.split(' ')[0] }, // só o primeiro nome nos e-mails
        status: 'active',
      }),
    });

    if (!resSub.ok) {
      const err = await resSub.text();
      throw new Error(`[MailerLite] Falha ao criar subscriber ${email}: ${err}`);
    }

    const subData = await resSub.json();
    const subscriberId = subData.data?.id;

    if (!subscriberId) {
      throw new Error(`[MailerLite] Subscriber criado mas sem ID no retorno para ${email}`);
    }

    // Adiciona ao grupo (dispara a automação)
    const resGrupo = await fetch(`${MAILERLITE_API_URL}/subscribers/${subscriberId}/groups`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ groups: [grupoId] }),
    });

    if (!resGrupo.ok) {
      const err = await resGrupo.text();
      throw new Error(`[MailerLite] Falha ao adicionar ${email} ao grupo ${grupoId}: ${err}`);
    }

    console.log(`[MailerLite] ✅ ${email} inscrita na sequência "${produto}" (grupo ${grupoId})`);
    return subscriberId;
  }
}

module.exports = { MailerLiteClient };
