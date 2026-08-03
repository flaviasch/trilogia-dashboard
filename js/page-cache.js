/**
 * page-cache.js
 * Cache local (localStorage) com TTL, no padrão stale-while-revalidate:
 * mostra o último dado salvo na hora enquanto a página busca a versão
 * fresca em segundo plano. Mesmo padrão que já existia só em index.html
 * (dash_v1_${uid}), agora genérico pra qualquer página (PF ou PJ).
 *
 * IMPORTANTE: nunca usar o valor deste cache pra decidir redirecionamento
 * de acesso (onboarding, bloqueio, apenasClube etc.) — essas decisões
 * devem sempre vir da chamada fresca ao servidor, porque o cache pode
 * estar desatualizado por até o TTL inteiro. Usar só pra exibir dado
 * instantaneamente enquanto a chamada fresca não volta.
 */

const PREFIX = 'pcache_v1_';

/**
 * Retorna o dado em cache, ou null se não existir ou tiver expirado.
 * @param {string} key
 */
export function cacheGet(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed._exp || parsed._exp < Date.now()) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return parsed._d;
  } catch (_) {
    return null;
  }
}

/**
 * Salva um dado em cache com TTL (padrão 1h, igual ao dash_v1_ do index.html).
 * @param {string} key
 * @param {*} data
 * @param {number} ttlMs
 */
export function cacheSet(key, data, ttlMs = 3_600_000) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ _d: data, _exp: Date.now() + ttlMs }));
  } catch (_) {
    // localStorage cheio/indisponível — falha silenciosa, não é crítico
  }
}

/**
 * Remove uma entrada do cache (ex: no logout, ou quando o dado muda).
 * @param {string} key
 */
export function cacheClear(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch (_) {}
}
