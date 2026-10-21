/**
 * Model catalog (hub-owned).
 *
 * Fetches the OpenAI-style model list (`GET …/v1/models` → `{data:[{id}]}`)
 * an endpoint serves, so callers stop hand-typing model ids. Works against
 * any OpenAI-compatible server — including keyed catalogs that only list
 * what the given key may use (the key is resolved hub-side and never
 * logged or exposed).
 *
 * Entries keep the upstream metadata (name, context window, capabilities,
 * pricing, …) and expose a normalized `variants[]` list — the thinking /
 * reasoning levels a UI can offer per model.
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

/**
 * Read the id of one variant declaration (`{ id }`, `{ name }`, `{ key }`).
 * @returns {string|null}
 */
function variantId(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
        for (const k of ['id', 'name', 'key']) {
            if (typeof value[k] === 'string' && value[k].trim()) return value[k];
        }
    }
    return null;
}

/**
 * Normalize one upstream "thinking level" declaration into `{ id }` entries.
 * Accepts an array of strings, an array of `{ id }` objects, or an object
 * keyed by id. Order is preserved; ids are trimmed.
 * @param {unknown} raw
 * @returns {Array<{id:string}>}
 */
export function normalizeVariants(raw) {
    const out = [];
    const push = (value) => {
        if (typeof value === 'string' && value.trim()) out.push({ id: value.trim() });
    };
    if (Array.isArray(raw)) {
        for (const v of raw) {
            const id = variantId(v);
            if (id !== null) push(id);
        }
        return out;
    }
    if (raw && typeof raw === 'object') {
        for (const key of Object.keys(raw)) {
            const v = raw[key];
            const inline = (v && typeof v === 'object' && typeof v.id === 'string') ? v.id : null;
            push(inline !== null ? inline : key);
        }
    }
    return out;
}

function toFiniteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim()) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/**
 * Collect the thinking levels of one upstream model entry, in rule order:
 * a) `variants` · b) `supported_reasoning_efforts` · c) `thinking_variants` /
 * `capabilities.variants` / `capabilities.reasoning_efforts` · d) none.
 * @param {object} src
 * @returns {Array<{id:string}>}
 */
function collectVariants(src) {
    const meta = (src.metadata && typeof src.metadata === 'object') ? src.metadata : null;
    const caps = (src.capabilities && typeof src.capabilities === 'object') ? src.capabilities : null;

    const explicit = normalizeVariants(src.variants);
    if (explicit.length) return explicit;

    for (const raw of [meta?.supported_reasoning_efforts, src.supported_reasoning_efforts]) {
        if (raw === undefined || raw === null) continue;
        const list = normalizeVariants(raw);
        if (list.length) return list;
    }

    for (const raw of [meta?.thinking_variants, caps?.variants, caps?.reasoning_efforts]) {
        if (raw === undefined || raw === null) continue;
        const list = normalizeVariants(raw);
        if (list.length) return list;
    }

    return [];
}

/**
 * Build one normalized catalog entry: the upstream id (kept exactly as the
 * catalog reported it) plus the metadata a UI needs to describe the model
 * and offer its thinking levels.
 * @param {unknown} raw upstream entry
 * @param {string} id trimmed upstream id
 */
function buildModelEntry(raw, id) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const entry = { id };
    if (typeof src.name === 'string' && src.name) entry.name = src.name;
    if (typeof src.owned_by === 'string' && src.owned_by) entry.owned_by = src.owned_by;
    if (typeof src.description === 'string' && src.description) entry.description = src.description;
    const ctxWindow = toFiniteNumber(src.context_window ?? src.context_length);
    if (ctxWindow !== null) entry.context_window = ctxWindow;
    if (src.context_length !== undefined && src.context_length !== null) entry.context_length = src.context_length;
    for (const key of ['capabilities', 'metadata', 'pricing', 'created']) {
        if (src[key] !== undefined && src[key] !== null) entry[key] = src[key];
    }
    entry.variants = collectVariants(src);
    return entry;
}

/**
 * Parse an OpenAI-style catalog payload into normalized entries.
 * @param {object|Array} json
 * @returns {Array<{id:string, variants:Array<{id:string>}>}|null}
 */
export function parseModels(json) {
    const raw = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const m of raw) {
        const id = typeof m === 'string' ? m : m?.id;
        if (typeof id === 'string' && id.trim()) out.push(buildModelEntry(m, id.trim()));
    }
    return out;
}

/**
 * GET the catalog. Proxy-first (avoids CORS preflight on keyed requests),
 * direct fallback. Responses are cached per endpoint+key-presence.
 * @returns {Promise<{models:Array<{id:string, variants:Array<{id:string}>}>, cached:boolean, cachedAt:number, url:string}>}
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
