'use strict';

/**
 * Cliente Z-API para envio de mensagens WhatsApp.
 *
 * Pré-requisito: criar instância em app.z-api.io e configurar os secrets:
 *   ZAPI_INSTANCE_ID   — ID da instância (ex: "3D8F...A12B")
 *   ZAPI_TOKEN         — token da instância
 *   ZAPI_CLIENT_TOKEN  — Security token (Settings → Security Token no painel Z-API)
 *
 * Importante: o número de WhatsApp precisa estar conectado na instância Z-API
 * (escaneado o QR code) para os envios funcionarem.
 */

const ZAPI_BASE = 'https://api.z-api.io/instances';

class ZApiClient {
  /**
   * @param {string} instanceId  — ID da instância Z-API
   * @param {string} token       — token da instância
   * @param {string} clientToken — Security Token (header Client-Token)
   */
  constructor(instanceId, token, clientToken) {
    if (!instanceId || !token) throw new Error('[Z-API] instanceId e token são obrigatórios.');
    this.baseUrl     = `${ZAPI_BASE}/${instanceId}/token/${token}`;
    this.clientToken = clientToken || '';
  }

  /**
   * Envia mensagem de texto para um número WhatsApp.
   *
   * @param {string} telefone — número com DDD, com ou sem +55 (ex: "51999990000" ou "+5551999990000")
   * @param {string} mensagem — texto da mensagem
   */
  async enviarTexto(telefone, mensagem) {
    const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

    // Normaliza o número: remove tudo que não for dígito, garante DDI 55
    let numero = telefone.replace(/\D/g, '');
    if (!numero.startsWith('55')) numero = `55${numero}`;

    const res = await fetch(`${this.baseUrl}/send-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': this.clientToken,
      },
      body: JSON.stringify({ phone: numero, message: mensagem }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`[Z-API] Falha ao enviar para ${numero}: ${res.status} — ${err}`);
    }

    const data = await res.json();
    console.log(`[Z-API] ✅ Mensagem enviada para ${numero} | messageId: ${data.zaapId || data.messageId || 'n/a'}`);
    return data;
  }

  /**
   * Verifica se a instância está conectada (WhatsApp logado).
   * Útil para checar antes de processar o lote diário.
   */
  async verificarConexao() {
    const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

    const res = await fetch(`${this.baseUrl}/status`, {
      headers: { 'Client-Token': this.clientToken },
    });

    if (!res.ok) return false;
    const data = await res.json();
    // Z-API retorna connected: true quando o WhatsApp está logado
    return data.connected === true;
  }
}

module.exports = { ZApiClient };
