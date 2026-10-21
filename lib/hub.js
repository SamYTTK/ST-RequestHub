import { withAbortableTimeout, retry } from './net.js';
import { listPresets, getPresetSamplers, resolveSamplers } from './preset.js';
import { sendDirect } from './direct.js';
import { sendDecide } from './decide.js';
import { sendViaBackend } from './service.js';
import { buildMessages, fetchWorldInfo } from './messages.js';
import { countTokens, fitBudget, testConnection, testDecideConnection, HubError } from './util.js';
import { parseRequest } from './request.js';
import { runAgent } from './agent.js';
import { recordStart, recordComplete } from './stats.js';
import { recordUsage } from './usage.js';
import { normalizeHarness, resolveEffectiveHarness, sanitizeExtraHeaders, ensureHarnessSession, clearHarnessSessions } from './harness.js';
import { fetchModels, clearModelsCache } from './models.js';
import { resolveConnection } from './profiles.js';

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function cloneForTrace(v) {
    try {
        if (typeof structuredClone === 'function') return structuredClone(v);
    } catch { /* fall through */ }
    try {
        return JSON.parse(JSON.stringify(v));
    } catch {
        return Array.isArray(v) ? [...v] : { ...(v ?? {}) };
    }
}

export { HubError };

function toHubError(e, label = 'request') {
    if (e instanceof HubError) return e;
    let out;
    if (e?.name === 'AbortError') out = new HubError(`${label} aborted.`, 'ABORTED');
    else {
        const code = e?.code ?? (/timeout/i.test(String(e?.message ?? '')) ? 'TIMEOUT' : 'UNKNOWN');
        out = new HubError(e?.message ?? String(e), code, { status: e?.status ?? null, retryable: e?.retryable });
    }
    for (const k of ['usage', 'rateLimits', 'endpoint', 'model', 'partialSteps']) {
        if (e?.[k] !== undefined) out[k] = e[k];
    }
    return out;
}

import { readHubSettings as hubSettings } from './request.js';

/**
 * Generic generation for any consumer extension.
 *
 * @param {object} req
 * @param {Array<{role:string,content:string}>} [req.messages] - ready-made messages (takes precedence)
 * @param {object} [req.prompt] - {input, history?, task?, prev?, wi?} assembled via buildMessages
 * @param {object} [req.connection] - {apiUrl?, apiKey?, model?, extraHeaders?}; empty apiUrl = ST backend
 * @param {object} [req.harness] - harness identity {userAgent?, sessionId?, sessionScope?, sessionHeader?, sendSessionHeader?}
 * @param {object} [req.extraHeaders] - additional outbound headers (sanitized; explicit keys win)
 * @param {string} [req.presetName]
 * @param {object} [req.samplers] - own sampler values
 * @param {boolean} [req.useOwnConfig] - false = preset samplers win
 * @param {number} [req.maxTokens]
 * @param {number} [req.timeoutMs] - hub default when omitted
 * @param {number} [req.retries] - hub default when omitted
 * @param {boolean} [req.stream]
 * @param {AbortSignal} [req.signal]
 * @param {function} [req.onChunk]
 * @param {object} [req.opts] - {useWI, maxHistory, attachChat} for prompt assembly
 * @returns {Promise<{content:string, reasoning:string, usage:object|null, rateLimits:Array, finish_reason:string, meta:object}>}
 */
export async function generate(req = {}) {
    const defs = hubSettings();
    const {
        messages = null,
        prompt = null,
        connection = {},
        harness = null,
        extraHeaders = null,
        presetName = '',
        samplers = {},
        useOwnConfig = false,
        maxTokens = 1024,
        timeoutMs = defs.defaultTimeoutMs ?? 90000,
        retries = defs.defaultRetries ?? 1,
        stream = false,
        signal = null,
        onChunk = null,
        onRound = null,
        opts = {},
        label = 'hub request',
        profileName = '',
        consumer = '',
    } = req;

    const { apiUrl = '', apiKey = '', model = '' } = connection ?? {};
    const mergedExtra = {
        ...(isPlainObj(connection?.extraHeaders) ? connection.extraHeaders : {}),
        ...(isPlainObj(extraHeaders) ? extraHeaders : {}),
    };
    const effHarness = resolveEffectiveHarness(normalizeHarness(harness ?? undefined), { consumer });
    const { headers: effExtra } = sanitizeExtraHeaders(mergedExtra);
    const { samplers: effSamplers, source: samplerSource } = resolveSamplers({ presetName, samplers, useOwnConfig });
    if (samplerSource === 'own' && !useOwnConfig && presetName) {
        console.warn(`[ST-RequestHub] preset "${presetName}" not found — falling back to provided sampler values`);
    }

    let msgs = messages;
    if (!msgs) {
        if (!prompt) throw new HubError('Either messages or prompt.input is required.', 'CONFIG');
        msgs = await buildMessages(
            { input: prompt.input ?? '', history: prompt.history ?? null, task: prompt.task ?? '{{input}}', prev: prompt.prev ?? {}, wi: prompt.wi ?? null },
            { useWI: !!opts.useWI, maxHistory: opts.maxHistory ?? 20, attachChat: opts.attachChat !== false },
        );
    }
    if (!Array.isArray(msgs) || msgs.length === 0) throw new HubError('No messages to send.', 'CONFIG');

    const hasUrl = apiUrl && String(apiUrl).trim();
    if (hasUrl && !(model && String(model).trim())) {
        throw new HubError('API URL is set but model is empty.', 'CONFIG');
    }
    if (!hasUrl && !presetName && !(model && String(model).trim())) {
        throw new HubError('No API URL, model, or preset. Set an API URL + model, or pick a chat completion preset.', 'CONFIG');
    }

    const wantStream = !!stream && typeof onChunk === 'function';
    const route = hasUrl ? 'direct' : 'st-backend';
    const maxT = Number(maxTokens ?? 1024) || 1024;
    const trace = (phase, payload = {}) => {
        if (typeof onRound !== 'function') return;
        try { onRound({ phase, at: Date.now(), ...payload }); } catch { /* ignore */ }
    };

    const dispatch = async (sig) => {
        const requestInfo = {
            round: 1,
            route,
            model: String(model ?? ''),
            profile: profileName ?? '',
            presetName: presetName ?? '',
            samplers: cloneForTrace(effSamplers),
            maxTokens: maxT,
            messages: cloneForTrace(msgs),
        };
        trace('request', requestInfo);
        const roundStarted = Date.now();
        try {
            let out;
            if (route === 'direct') {
                try {
                    out = await sendDirect({
                        apiUrl, apiKey: apiKey ?? '', model: String(model).trim(),
                        messages: msgs, samplers: effSamplers, maxTokens: maxT,
                        signal: sig, stream: wantStream, onChunk: wantStream ? onChunk : null,
                        preferProxy: defs.preferProxy !== false,
                        harness: effHarness, extraHeaders: effExtra,
                    });
                } catch (e) {
                    if (sig?.aborted || e?.name === 'AbortError') throw e;
                    if (wantStream) {
                        console.warn('[ST-RequestHub] streaming failed, retrying non-streaming:', e?.message ?? e);
                        out = await sendDirect({
                            apiUrl, apiKey: apiKey ?? '', model: String(model).trim(),
                            messages: msgs, samplers: effSamplers, maxTokens: maxT,
                            signal: sig, stream: false,
                            preferProxy: defs.preferProxy !== false,
                            harness: effHarness, extraHeaders: effExtra,
                        });
                    } else {
                        throw e;
                    }
                }
            } else {
                out = await sendViaBackend({
                    messages: msgs, model: String(model ?? '').trim(), presetName,
                    samplers: effSamplers, maxTokens: maxT, signal: sig, onChunk,
                });
            }
            trace('response', {
                round: 1,
                durationMs: Date.now() - roundStarted,
                content: String(out?.content ?? ''),
                reasoning: String(out?.reasoning ?? ''),
                finish_reason: String(out?.finish_reason ?? ''),
                usage: out?.usage ?? null,
                rateLimits: Array.isArray(out?.rateLimits) ? out.rateLimits : [],
                status: Number(out?.status) || 0,
            });
            return out;
        } catch (e) {
            trace('error', {
                round: 1,
                durationMs: Date.now() - roundStarted,
                errorCode: e?.code ?? 'UNKNOWN',
                message: String(e?.message ?? e).slice(0, 500),
                rateLimits: Array.isArray(e?.rateLimits) ? e.rateLimits : [],
            });
            throw e;
        }
    };

    try {
        const out = await retry(
            () => withAbortableTimeout((sig) => dispatch(sig), Number(timeoutMs) || 0, label, signal),
            { retries: Number(retries) || 0, delayMs: 1000, label },
        );
        const content = String(out?.content ?? '');
        const reasoning = String(out?.reasoning ?? '');
        if (!content.trim() && !reasoning.trim()) {
            throw new HubError('Endpoint returned an empty response.', 'EMPTY_RESPONSE');
        }
        return {
            content, reasoning,
            usage: out?.usage ?? null,
            rateLimits: Array.isArray(out?.rateLimits) ? out.rateLimits : [],
            finish_reason: String(out?.finish_reason ?? ''),
            meta: { route, samplerSource, model: String(model ?? ''), presetName: presetName ?? '', profile: profileName ?? '' },
        };
    } catch (e) {
        throw toHubError(e, label);
    }
}

/**
 * Typed decision for any consumer extension (Laya-style decision models).
 *
 * Sends {state, questions} to a decision endpoint (`POST /v1/systemone`,
 * TypeSafe-compatible — served by Ollaya and `laya-serve`) and returns the
 * typed answers. No prompt assembly, no presets, no samplers, no streaming:
 * decision endpoints score in a single forward pass.
 *
 * @param {object} req
 * @param {string|object|Array} req.state - the text/object to judge
 * @param {object} req.questions - question id → {type, instructions, criteria}
 * @param {object} [req.options] - {preset, task, lang, lang_guess, min_confidence, max_len, head_max_len}
 * @param {object} [req.connection] - {apiUrl, apiKey?, model?}; apiUrl REQUIRED (no ST-backend route)
 * @param {number} [req.timeoutMs] - hub default when omitted (cold model loads take seconds)
 * @param {number} [req.retries] - hub default when omitted (503 busy/loading is retried)
 * @param {AbortSignal} [req.signal]
 * @param {string} [req.label]
 * @param {string} [req.profileName] - for meta only (resolution happens in parseRequest)
 * @param {string} [req.consumer]
 * @returns {Promise<{answers:object, routing:object|null, usage:object|null, meta:object}>}
 */
export async function decide(req = {}) {
    const defs = hubSettings();
    const {
        state = null,
        questions = null,
        options = {},
        connection = {},
        timeoutMs = defs.defaultTimeoutMs ?? 90000,
        retries = defs.defaultRetries ?? 1,
        signal = null,
        label = 'hub decide',
        profileName = '',
        consumer = '',
    } = req;

    const { apiUrl = '', apiKey = '', model = '' } = connection ?? {};
    if (!apiUrl || !String(apiUrl).trim()) {
        throw new HubError('Decide mode needs an API URL (decision models have no ST-backend route).', 'CONFIG');
    }
    if (!model || !String(model).trim()) {
        throw new HubError('Model is empty.', 'CONFIG');
    }

    try {
        const out = await retry(
            () => withAbortableTimeout((sig) => sendDecide({
                apiUrl,
                apiKey: apiKey ?? '',
                model: String(model).trim(),
                state,
                questions,
                options,
                signal: sig,
                preferProxy: defs.preferProxy !== false,
            }), Number(timeoutMs) || 0, label, signal),
            { retries: Number(retries) || 0, delayMs: 1000, label },
        );
        return {
            answers: out.answers,
            routing: out.routing,
            usage: out.usage,
            meta: { route: 'decide', model: String(model ?? ''), profile: profileName ?? '', consumer },
        };
    } catch (e) {
        throw toHubError(e, label);
    }
}

/**
 * Unified front door: validate the JSON request, then run it once
 * (mode:'single', default), autonomously (mode:'agent'), or as a typed
 * decision (mode:'decide').
 * @param {object} raw - JSON request (see lib/request.js contract)
 * @returns {Promise<{content, reasoning, steps?, usage?, finish_reason?, meta} | {answers, routing, usage, meta}>}
 *   decide mode returns {answers, routing, usage, meta} — no content string.
 * @throws {HubError} INVALID_REQUEST on contract violations; MODEL_NOT_ALLOWED
 *   when the profile's allow-list does not permit the requested model;
 *   transport errors otherwise
 */
export async function request(raw = {}) {
    const n = parseRequest(raw);
    // Usage tracking: metadata only (consumer/mode/route/model/profile,
    // timings, outcome). Prompt text, answers and keys are never captured.
    const span = recordStart({ consumer: n.consumer, label: n.label, mode: n.mode });
    const errRoute = n.mode === 'decide'
        ? 'decide'
        : (n.connection?.apiUrl && String(n.connection.apiUrl).trim() ? 'direct' : 'st-backend');
    const finishOk = (out) => {
        recordComplete(span, {
            route: out?.meta?.route ?? '',
            model: out?.meta?.model ?? n.connection?.model ?? '',
            profile: out?.meta?.profile ?? n.profileName ?? '',
            ok: true,
        });
        try {
            recordUsage({
                consumer: n.consumer,
                label: n.label,
                mode: n.mode,
                route: out?.meta?.route ?? '',
                profile: out?.meta?.profile ?? n.profileName ?? '',
                model: out?.meta?.model ?? n.connection?.model ?? '',
                apiUrl: n.connection?.apiUrl ?? '',
                apiKey: n.connection?.apiKey ?? '',
                sessionId: n.sessionId ?? n.harness?.sessionId ?? '',
                usage: out?.usage ?? null,
                rateLimits: out?.rateLimits ?? [],
                ok: true,
                durationMs: Date.now() - span.tsStart,
            });
        } catch { /* usage must never break a request */ }
        return out;
    };
    const finishErr = (e) => {
        recordComplete(span, {
            route: errRoute,
            model: n.connection?.model ?? '',
            profile: n.profileName ?? '',
            ok: false,
            errorCode: e?.code ?? 'UNKNOWN',
        });
        try {
            recordUsage({
                consumer: n.consumer,
                label: n.label,
                mode: n.mode,
                route: errRoute,
                profile: n.profileName ?? '',
                model: n.connection?.model ?? '',
                apiUrl: n.connection?.apiUrl ?? '',
                apiKey: n.connection?.apiKey ?? '',
                sessionId: n.sessionId ?? n.harness?.sessionId ?? '',
                usage: e?.usage ?? null,
                rateLimits: e?.rateLimits ?? [],
                ok: false,
                status: e?.status ?? 0,
                errorCode: e?.code ?? 'UNKNOWN',
                durationMs: Date.now() - span.tsStart,
            });
        } catch { /* usage must never break a request */ }
        throw e;
    };
    if (n.mode === 'agent') {
        try {
            return finishOk(await runAgent(n));
        } catch (e) {
            return finishErr(e);
        }
    }
    if (n.mode === 'decide') {
        try {
            return finishOk(await decide({
                state: n.decide.state,
                questions: n.decide.questions,
                options: n.decide.options,
                connection: n.connection,
                timeoutMs: n.timeoutMs,
                retries: n.retries,
                signal: n.signal,
                label: n.label || n.consumer || 'hub decide',
                profileName: n.profileName,
                consumer: n.consumer,
            }));
        } catch (e) {
            return finishErr(e);
        }
    }
    return await generate({
        messages: n.messages,
        prompt: n.prompt ? {
            input: n.prompt.input ?? '',
            history: n.prompt.history ?? null,
            task: n.prompt.task ?? '{{input}}',
            prev: n.prompt.prev ?? {},
            wi: n.prompt.wi ?? null,
        } : null,
        connection: n.connection,
        harness: n.harness,
        extraHeaders: n.extraHeaders,
        presetName: n.presetName,
        samplers: n.samplers,
        useOwnConfig: n.useOwnConfig,
        maxTokens: n.maxTokens,
        timeoutMs: n.timeoutMs,
        retries: n.retries,
        stream: n.stream,
        signal: n.signal,
        onChunk: n.onChunk,
        onRound: n.onRound,
        opts: n.opts,
        label: n.label || n.consumer || 'hub request',
        profileName: n.profileName,
        consumer: n.consumer,
    }).then(finishOk, finishErr);
}

export { listApiProfiles, resolveConnection } from './profiles.js';

export { runAgent } from './agent.js';
export { listTools } from './agent.js';
export { sendDecide, validateDecidePayload, DECIDE_QUESTION_TYPES } from './decide.js';
export { parseRequest, validateRequest, readHubSettings, HUB_DEFAULTS, REQUEST_MODES } from './request.js';
export { getUsageStats, getRecentRequests, clearUsageStats } from './stats.js';
export {
    getUsageSnapshot, getUsage, getRateLimits, getUsageHistory, clearUsage,
    onUsage, refreshQuota, registerQuotaProvider, listQuotaProviders,
    getKeyInfo, parseRateLimitHeaders, parseUsage, fingerprintKey, providerHost,
    flushUsageWrites,
} from './usage.js';
export { fetchModels, normalizeModelsEndpoint, normalizeCatalogEndpoint, filterModelsByAllowList, clearModelsCache, MODELS_TTL_MS } from './models.js';
export {
    normalizeHarness, resolveEffectiveHarness, sanitizeExtraHeaders, buildHarnessHeaders,
    ensureHarnessSession, clearHarnessSessions,
    SESSION_HEADER_DEFAULT, USER_AGENT_ALIAS, DEFAULT_USER_AGENT, HARNESS_SCOPES,
} from './harness.js';

export const hubHelpers = {
    listPresets,
    getPresetSamplers,
    resolveSamplers,
    buildMessages,
    fetchWorldInfo,
    countTokens,
    fitBudget,
    testConnection,
    testDecideConnection,
    ensureHarnessSession,
    clearHarnessSessions,
    resolveEffectiveHarness,
    listModels,
    clearModelsCache,
};

/**
 * List the models an endpoint serves for the given credentials.
 *
 * Resolves the profile chain (explicit connection wins per field, same as
 * request()), then GETs the endpoint's OpenAI-style catalog with the
 * resolved key — so keyed servers list only what the key may use. The key
 * itself never appears in the result.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiProfile] - named hub profile
 * @param {object} [opts.connection] - {apiUrl?, apiKey?, allowedModels?, modelsEndpoint?} (explicit wins)
 * @param {boolean} [opts.refresh] - bypass the ~15min cache
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{models:Array<{id:string, variants:Array<{id:string}>}>, cached:boolean, cachedAt:number, url:string, profile:string}>}
 * @throws {HubError} CATALOG_UNSUPPORTED on decision endpoints; transport errors otherwise
 */
export async function listModels({ apiProfile = '', connection = {}, refresh = false, signal = null } = {}) {
    const defs = hubSettings();
    let resolved;
    try {
        resolved = resolveConnection({ apiProfile, connection });
    } catch (e) {
        throw toHubError(e, 'model catalog');
    }
    const { apiUrl = '', apiKey = '', allowedModels = [], modelsEndpoint = '' } = resolved.connection ?? {};
    if (!apiUrl || !String(apiUrl).trim()) {
        throw new HubError('Model catalog needs an API URL (or an apiProfile): the ST-backend route has no listable catalog.', 'CONFIG');
    }
    try {
        const out = await fetchModels({
            apiUrl, apiKey: apiKey ?? '', signal,
            allowedModels: Array.isArray(allowedModels) ? allowedModels : [],
            modelsEndpoint: modelsEndpoint ?? '',
            preferProxy: defs.preferProxy !== false, refresh,
        });
        return { ...out, profile: resolved.profileName ?? '' };
    } catch (e) {
        throw toHubError(e, 'model catalog');
    }
}
