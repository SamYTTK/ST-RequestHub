/**
 * Model catalog (hub-owned).
 *
 * Fetches the OpenAI-style model list (`GET …/v1/models` → `{data:[{id}]}`)
 * an endpoint serves, so callers stop hand-typing model ids. Works against
 * any OpenAI-compatible server — including keyed catalogs that only list
 * what the given key may use (the key is resolved hub-side and never
 * logged or exposed).
 *
 * Decision endpoints (`/v1/systemone`, …) serve no catalog and fail fast
 * with CATALOG_UNSUPPORTED instead of an error spray.
 */

import { hubWarn } from './net.js';
import { LOCAL_RE } from './direct.js';

export const MODELS_TTL_MS = 15 * 60 * 1000;

const cache = new Map(); // `${endpoint}|${hasKey?'k':'a'}` → { at, models }

function hubError(message, code, { status = null, retryable = false } = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    e.retryable = retryable;
    return e;
}

/**
 * Derive the catalog URL from any model base URL / full endpoint path.
 * - `…/v1/chat/completions` → `…/v1/models` (also /responses, /messages,
 *   /embeddings, /completions suffixes)
 * - `…/v1` → `…/v1/models`; bare host → `…/v1/models`
 * - Decision paths throw CATALOG_UNSUPPORTED (no catalog exists there).
 */
export function normalizeModelsEndpoint(apiUrl) {
    let base = String(apiUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) throw hubError('API URL is empty.', 'CONFIG', { retryable: false });
    if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
    if (/(\/v1\/systemone|\/api\/decide)\/?$/i.test(base)) {
        throw hubError('Model catalog is not available for decision endpoints.', 'CATALOG_UNSUPPORTED', { retryable: false });
    }
    base = base.replace(/(\/chat\/completions|\/responses|\/messages|\/embeddings|\/completions)\/?$/i, '');
    if (!/\/v1\/?$/i.test(base) && !/\/models\/?$/i.test(base)) base += '/v1';
    if (!/\/models\/?$/i.test(base)) base += '/models';
    return base;
}

function proxyHeaders() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    } catch { /* ignore */ }
    return {};
}

function parseModels(json) {
    const raw = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const m of raw) {
        const id = typeof m === 'string' ? m : m?.id;
        if (typeof id === 'string' && id.trim()) out.push({ id: id.trim() });
    }
    return out;
}

/**
 * GET the catalog. Proxy-first (avoids CORS preflight on keyed requests),
 * direct fallback. Responses are cached per endpoint+key-presence.
 * @returns {Promise<{models:Array<{id}>, cached:boolean, cachedAt:number, url:string}>}
 */
export async function fetchModels({ apiUrl, apiKey = '', signal = null, preferProxy = true, refresh = false } = {}) {
    const url = normalizeModelsEndpoint(apiUrl);
    const key = `${url}|${apiKey ? 'k' : 'a'}`;
    if (!refresh) {
        const hit = cache.get(key);
        if (hit && (Date.now() - hit.at) < MODELS_TTL_MS) {
            return { models: hit.models, cached: true, cachedAt: hit.at, url };
        }
    }
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const isLocal = LOCAL_RE.test(url);
    const attempts = preferProxy !== false || isLocal ? [`/proxy/${url}`, url] : [url];
    let lastError = null;
    for (const u of attempts) {
        try {
            const h = u.startsWith('/proxy/') ? { ...proxyHeaders(), ...headers } : headers;
            const res = await fetch(u, { method: 'GET', headers: h, signal });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                lastError = hubError(`Model catalog returned ${res.status}: ${text.slice(0, 200)}`, `HTTP_${res.status}`, {
                    status: res.status,
                    retryable: res.status === 429 || res.status >= 500,
                });
                continue; // proxy-disabled etc. — try the next route before failing
            }
            const json = await res.json().catch(() => null);
            const models = parseModels(json);
            if (!models) {
                throw hubError('Model catalog returned an unexpected shape.', 'EMPTY_RESPONSE');
            }
            const at = Date.now();
            cache.set(key, { at, models });
            return { models, cached: false, cachedAt: at, url };
        } catch (e) {
            if (e?.name === 'AbortError' || signal?.aborted) throw e;
            lastError = e;
            hubWarn(`catalog GET ${u.startsWith('/proxy/') ? 'via proxy' : 'direct'} failed:`, e?.message ?? e);
        }
    }
    throw lastError ?? hubError(`Could not reach ${url}.`, 'NETWORK', { retryable: true });
}

/** Drop cached catalogs (endpoint prefix match; empty clears all). */
export function clearModelsCache(prefix = '') {
    const p = String(prefix || '');
    let n = 0;
    for (const k of [...cache.keys()]) {
        if (!p || k.startsWith(p)) {
            cache.delete(k);
            n++;
        }
    }
    return n;
}
