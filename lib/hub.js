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

export { HubError };

function toHubError(e, label = 'request') {
    if (e instanceof HubError) return e;
    if (e?.name === 'AbortError') return new HubError(`${label} aborted.`, 'ABORTED');
    const code = e?.code ?? (/timeout/i.test(String(e?.message ?? '')) ? 'TIMEOUT' : 'UNKNOWN');
    return new HubError(e?.message ?? String(e), code, { status: e?.status ?? null, retryable: e?.retryable });
}

import { readHubSettings as hubSettings } from './request.js';

/**
 * Generic generation for any consumer extension.
 *
 * @param {object} req
 * @param {Array<{role:string,content:string}>} [req.messages] - ready-made messages (takes precedence)
 * @param {object} [req.prompt] - {input, history?, task?, prev?, wi?} assembled via buildMessages
 * @param {object} [req.connection] - {apiUrl?, apiKey?, model?}; empty apiUrl = ST backend
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
 * @returns {Promise<{content:string, reasoning:string, meta:object}>}
 */
export async function generate(req = {}) {
    const defs = hubSettings();
    const {
        messages = null,
        prompt = null,
        connection = {},
        presetName = '',
        samplers = {},
        useOwnConfig = false,
        maxTokens = 1024,
        timeoutMs = defs.defaultTimeoutMs ?? 90000,
        retries = defs.defaultRetries ?? 1,
        stream = false,
        signal = null,
        onChunk = null,
        opts = {},
        label = 'hub request',
        profileName = '',
    } = req;

    const { apiUrl = '', apiKey = '', model = '' } = connection ?? {};
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

    const dispatch = async (sig) => {
        if (route === 'direct') {
            try {
                return await sendDirect({
                    apiUrl, apiKey: apiKey ?? '', model: String(model).trim(),
                    messages: msgs, samplers: effSamplers, maxTokens: maxT,
                    signal: sig, stream: wantStream, onChunk: wantStream ? onChunk : null,
                    preferProxy: defs.preferProxy !== false,
                });
            } catch (e) {
                if (sig?.aborted || e?.name === 'AbortError') throw e;
                if (wantStream) {
                    console.warn('[ST-RequestHub] streaming failed, retrying non-streaming:', e?.message ?? e);
                    return await sendDirect({
                        apiUrl, apiKey: apiKey ?? '', model: String(model).trim(),
                        messages: msgs, samplers: effSamplers, maxTokens: maxT,
                        signal: sig, stream: false,
                        preferProxy: defs.preferProxy !== false,
                    });
                }
                throw e;
            }
        }
        return await sendViaBackend({
            messages: msgs, model: String(model ?? '').trim(), presetName,
            samplers: effSamplers, maxTokens: maxT, signal: sig, onChunk,
        });
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
 * @returns {Promise<{content, reasoning, steps?, meta} | {answers, routing, usage, meta}>}
 *   decide mode returns {answers, routing, usage, meta} — no content string.
 * @throws {HubError} INVALID_REQUEST on contract violations; transport errors otherwise
 */
export async function request(raw = {}) {
    const n = parseRequest(raw);
    // Usage tracking: metadata only (consumer/mode/route/model/profile,
    // timings, outcome). Prompt text, answers and keys are never captured.
    const span = recordStart({ consumer: n.consumer, label: n.label, mode: n.mode });
    const finishOk = (out) => {
        recordComplete(span, {
            route: out?.meta?.route ?? '',
            model: out?.meta?.model ?? n.connection?.model ?? '',
            profile: out?.meta?.profile ?? n.profileName ?? '',
            ok: true,
        });
        return out;
    };
    const finishErr = (e) => {
        recordComplete(span, {
            route: '',
            model: n.connection?.model ?? '',
            profile: n.profileName ?? '',
            ok: false,
            errorCode: e?.code ?? 'UNKNOWN',
        });
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
        presetName: n.presetName,
        samplers: n.samplers,
        useOwnConfig: n.useOwnConfig,
        maxTokens: n.maxTokens,
        timeoutMs: n.timeoutMs,
        retries: n.retries,
        stream: n.stream,
        signal: n.signal,
        onChunk: n.onChunk,
        opts: n.opts,
        label: n.label || n.consumer || 'hub request',
        profileName: n.profileName,
    }).then(finishOk, finishErr);
}

export { listApiProfiles, resolveConnection } from './profiles.js';

export { runAgent } from './agent.js';
export { listTools } from './agent.js';
export { sendDecide, validateDecidePayload, DECIDE_QUESTION_TYPES } from './decide.js';
export { parseRequest, validateRequest, readHubSettings, HUB_DEFAULTS, REQUEST_MODES } from './request.js';
export { getUsageStats, getRecentRequests, clearUsageStats } from './stats.js';

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
};
