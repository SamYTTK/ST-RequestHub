import { hubWarn } from './net.js';
import { LOCAL_RE } from './direct.js';

/**
 * Decision-model transport (internal to the hub).
 *
 * Talks to Laya-style decision endpoints over the TypeSafe-compatible
 * `POST /v1/systemone` wire protocol (served by both Ollaya and the
 * official `laya-serve`). This is NOT chat completions and NOT embeddings:
 * the request carries a `state` plus typed `questions`, and the response
 * carries typed `answers` with calibrated probabilities — nothing is
 * generated, streamed, or sampled.
 *
 * Local endpoints go via ST's /proxy/ CORS fallback first (same as chat),
 * then direct — so no CORS allow-listing is needed on the decision server.
 */

export const DECIDE_QUESTION_TYPES = Object.freeze(['choice', 'score', 'noul']);

/** Optional per-request decision controls passed through only-when-set. */
const DECIDE_OPTION_KEYS = Object.freeze([
    'preset', 'task', 'lang', 'lang_guess',
    'min_confidence', 'max_len', 'head_max_len',
]);

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeDecideEndpoint(apiUrl) {
    let endpoint = String(apiUrl ?? '').trim().replace(/\/+$/, '');
    if (!endpoint) {
        const e = new Error('API URL is empty.');
        e.code = 'CONFIG';
        e.retryable = false;
        throw e;
    }
    if (!/^https?:\/\//i.test(endpoint)) endpoint = `http://${endpoint}`;
    if (!/\/v1\/systemone\/?$/i.test(endpoint) && !/\/api\/decide\/?$/i.test(endpoint)) {
        endpoint += '/v1/systemone';
    }
    return endpoint;
}

/**
 * Structural pre-check of one decide payload. The server remains the source
 * of truth (it 422s with a naming message); this only catches obvious
 * client mistakes before any network round-trip.
 * @returns {string[]} error details (empty = ok)
 */
export function validateDecidePayload({ state, questions } = {}) {
    const errors = [];
    const stateOk = (typeof state === 'string' && state.trim())
        || (isPlainObject(state) && Object.keys(state).length > 0)
        || Array.isArray(state);
    if (!stateOk) errors.push('decide.state must be a non-empty string, array, or object.');
    if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
        errors.push('decide.questions must be an object with at least one question.');
        return errors;
    }
    for (const [id, q] of Object.entries(questions)) {
        if (!isPlainObject(q)) {
            errors.push(`decide.questions["${id}"] must be an object.`);
            continue;
        }
        if (!DECIDE_QUESTION_TYPES.includes(q.type)) {
            errors.push(`decide.questions["${id}"].type must be one of ${DECIDE_QUESTION_TYPES.join(', ')}.`);
            continue;
        }
        if (typeof q.instructions !== 'string' || !q.instructions.trim()) {
            errors.push(`decide.questions["${id}"].instructions must be a non-empty string.`);
        }
        const c = q.criteria;
        if (q.type === 'choice') {
            const opts = Array.isArray(c) ? c : (isPlainObject(c) ? Object.keys(c) : []);
            if (opts.length < 2) errors.push(`decide.questions["${id}"] (choice) needs criteria with at least 2 options.`);
        } else if (q.type === 'score') {
            if (!Array.isArray(c) || c.length < 2 || c.length > 10) {
                errors.push(`decide.questions["${id}"] (score) needs criteria as an array of 2-10 levels.`);
            }
        } else if (q.type === 'noul' && c !== undefined && c !== null && !isPlainObject(c)) {
            errors.push(`decide.questions["${id}"] (noul) criteria must be an object when given.`);
        }
    }
    return errors;
}

export function buildDecideBody({ model, state, questions, options = {} }) {
    const body = { model, state, questions };
    const opts = isPlainObject(options) ? options : {};
    for (const k of DECIDE_OPTION_KEYS) {
        const v = opts[k];
        if (v === '' || v === null || v === undefined) continue;
        if ((k === 'min_confidence' || k === 'max_len' || k === 'head_max_len') && Number.isNaN(Number(v))) continue;
        body[k] = v;
    }
    return body;
}

function proxyHeaders() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    } catch { /* ignore */ }
    return { 'Content-Type': 'application/json' };
}

function hubError(message, code, { status = null, retryable = false } = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    e.retryable = retryable;
    return e;
}

/** @returns {Promise<{answers:object, routing:object|null, usage:object|null, model:string}>} */
export async function sendDecide({ apiUrl, apiKey, model, state, questions, options = {}, signal = null, preferProxy = true }) {
    if (!model) throw hubError('Model is empty.', 'CONFIG');
    const structural = validateDecidePayload({ state, questions });
    if (structural.length) {
        throw hubError(`Invalid decide payload: ${structural[0]}`, 'INVALID_REQUEST', { details: structural });
    }
    const endpoint = normalizeDecideEndpoint(apiUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const body = buildDecideBody({ model, state, questions, options });
    const isLocal = LOCAL_RE.test(endpoint);

    let response = null;
    let lastError = null;
    const attempts = isLocal && preferProxy ? [true, false] : [false];
    for (const useProxy of attempts) {
        try {
            const url = useProxy ? `/proxy/${endpoint}` : endpoint;
            const h = useProxy ? { ...proxyHeaders(), ...headers } : headers;
            response = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal });
            lastError = null;
            break;
        } catch (e) {
            lastError = e;
            if (signal?.aborted) throw e;
            hubWarn(`decide POST ${useProxy ? 'via proxy' : 'direct'} failed:`, e?.message ?? e);
        }
    }
    if (!response) {
        throw hubError(
            `Could not reach ${endpoint}: ${lastError?.message ?? 'fetch failed'}. For local servers enable enableCorsProxy in config.yaml.`,
            /abort/i.test(String(lastError?.message ?? '')) ? 'ABORTED' : 'NETWORK',
            { retryable: true },
        );
    }
    if (!response.ok) {
        const text = await response.text().catch(() => 'Unknown error');
        const short = text.slice(0, 300);
        if (response.status === 422 || response.status === 413) {
            throw hubError(`Decision endpoint rejected the request (HTTP ${response.status}): ${short}`, 'INVALID_REQUEST', {
                status: response.status,
                retryable: false,
                details: [short],
            });
        }
        // 503 = server busy or model (cold-)loading — retryable; hub retry
        // covers the on-demand first-request-of-the-day load.
        const retryable = response.status === 429 || response.status >= 500;
        throw hubError(`Decision endpoint returned ${response.status}: ${short}`, `HTTP_${response.status}`, {
            status: response.status,
            retryable,
        });
    }
    const json = await response.json().catch(() => null);
    if (!json || typeof json !== 'object') {
        throw hubError('Decision endpoint returned a non-JSON response.', 'EMPTY_RESPONSE');
    }
    if (json?.error) {
        throw hubError(String(json.error?.message ?? 'Decision endpoint error'), 'HTTP_4xx', { retryable: false });
    }
    if (!isPlainObject(json.answers) || Object.keys(json.answers).length === 0) {
        throw hubError('Decision endpoint returned no answers.', 'EMPTY_RESPONSE');
    }
    return {
        answers: json.answers,
        routing: isPlainObject(json.routing) ? json.routing : null,
        usage: isPlainObject(json.usage) ? json.usage : null,
        model: typeof json.model === 'string' && json.model ? json.model : String(model),
    };
}
