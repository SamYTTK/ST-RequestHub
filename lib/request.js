import { HubError } from './util.js';
import { hubWarn } from './net.js';
import { resolveConnection } from './profiles.js';
import { normalizeHarness, sanitizeExtraHeaders } from './harness.js';
import { validateDecidePayload } from './decide.js';

/**
 * Unified JSON request contract for ST-RequestHub.
 *
 * Any extension builds a plain JSON request describing WHAT it wants:
 * prompt, settings, tools, limits. The hub validates it, builds the model
 * call, runs it (once for mode:'single', autonomously for mode:'agent'),
 * and hands the final answer back. Non-serializable runtime attachments
 * (AbortSignal, callbacks) ride alongside the JSON untouched.
 *
 * Top-level shape (chat modes: 'single' | 'agent'):
 * {
 *   mode: 'single' | 'agent',            // default 'single'
 *   input: {
 *     text?: string,                     // required unless messages given
 *     messages?: [{role, content}],      // ready-made; takes precedence
 *     history?, task?, prev?, wi?,       // prompt assembly (buildMessages)
 *     useWI?, maxHistory?, attachChat?,  // assembly opts
 *   },
 *   settings: {
 *     connection: { apiUrl?, apiKey?, model?, extraHeaders? },  // empty apiUrl = ST backend
 *       // extraHeaders: { 'x-opencode-session'?: '…', … } — sanitized, never auth/framing
 *     harness?: {                       // harness identity for gated APIs (e.g. OpenCode Go)
 *       userAgent?: '…',                // distinctive UA; '' = hub default
 *       sessionId?: '…',                // stable per-conversation id; '' = auto (scope-based)
 *       sessionScope?: 'chat'|'consumer'|'global'|'none'|'custom:<key>',  // default 'chat'
 *       sessionHeader?: 'x-opencode-session',  // header carrying the session id
 *       sendSessionHeader?: true,       // false = no session header at all
 *     },
 *     apiProfile?: 'ProfileName',  // named hub profile (URL+key+model+harness); explicit fields win per field
 *     preset?: string, useOwnConfig?: bool,
 *     samplers?: {                               // full per-request config; only-when-set
 *       temperature?, top_p?, top_k?, top_a?, min_p?,
 *       frequency_penalty?, presence_penalty?, repetition_penalty?,
 *       seed?, stop?, logit_bias?, response_format?, reasoning_effort?,
 *       max_completion_tokens?,                  // replaces maxTokens on direct route when set
 *     },
 *     maxTokens?: number, timeoutMs?: number, retries?: number, stream?: bool,
 *   },
 *   // Sampler precedence: useOwnConfig=true → samplers win; false → preset
 *   // wins, samplers are fallback. On the ST-backend route, sampler keys
 *   // override the preset payload per request (backend interprets them).
 *   tools?: {                             // agent mode only
 *     include?: [names], exclude?: [names],
 *     extra?: [{ name, description?, parameters?, action, override? }],
 *     choice?: 'auto' | 'none' | { type:'function', function:{ name } },
 *   },
 *   limits?: { maxSteps?: number, totalTimeoutMs?: number },  // agent mode only
 *   label?: string, consumer?: string,    // trace tags
 *   signal?, onChunk?, onStep?,           // runtime attachments (not validated)
 * }
 *
 * Decide mode ('decide') — Laya-style decision models, NOT chat:
 * {
 *   mode: 'decide',
 *   input: {
 *     decide: {
 *       state: '…' | { … } | […],       // required: the text/object to judge
 *       questions: {                     // required: >= 1 typed question
 *         <id>: {
 *           type: 'choice' | 'score' | 'noul',  // required
 *           instructions: '…',            // required
 *           criteria: {…} | […],          // choice: 2+ options; score: 2-10 levels; noul: optional
 *         },
 *       },
 *       options?: {                      // optional per-request controls (only-when-set)
 *         preset?, task?, lang?, lang_guess?, min_confidence?,
 *         max_len?, head_max_len?,
 *       },
 *     },
 *   },
 *   settings: {
 *     connection: { apiUrl?, apiKey?, model? },  // apiUrl REQUIRED (decision servers only)
 *     apiProfile?: 'ProfileName',
 *     // NOTE: preset / samplers / useOwnConfig / maxTokens / stream are
 *     // chat-mode concepts and are ignored in decide mode (warned, not sent).
 *     timeoutMs?: number, retries?: number,
 *   },
 *   // tools / limits are rejected in decide mode (agent mode only).
 *   // Response: { answers, routing, usage, meta } — no content string.
 *   label?: string, consumer?: string,    // trace tags
 *   signal?,                             // runtime attachment (not validated)
 * }
 */

export const REQUEST_MODES = Object.freeze(['single', 'agent', 'decide']);

export const HUB_DEFAULTS = Object.freeze({
    defaultTimeoutMs: 90000,
    defaultRetries: 1,
    defaultMaxSteps: 10,
    maxStepsCap: 25,
    defaultTotalTimeoutMs: 600000,
    defaultApiProfile: '',
    preferProxy: true,
    harnessUserAgent: 'ST-RequestHub',
    defaultSessionScope: 'chat',
});

const KNOWN_TOP = new Set([
    'mode', 'input', 'settings', 'tools', 'limits',
    'label', 'consumer', 'signal', 'onChunk', 'onStep',
]);

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function invalid(details) {
    const list = Array.isArray(details) ? details : [details];
    return new HubError(`Invalid hub request: ${list[0]}`, 'INVALID_REQUEST', { details: list });
}

/** Hub settings with hardcoded fallbacks when ST context is unavailable (tests). */
export function readHubSettings() {
    let stored = null;
    try {
        stored = SillyTavern.getContext().extensionSettings?.['ST-RequestHub'] ?? null;
    } catch { /* ignore */ }
    const s = isPlainObject(stored) ? stored : {};
    const out = {};
    for (const k of Object.keys(HUB_DEFAULTS)) {
        const v = s[k];
        out[k] = (v === undefined || v === null) ? HUB_DEFAULTS[k] : v;
    }
    return out;
}

const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));

function asString(v, fallback = '') {
    return (v === null || v === undefined) ? fallback : String(v);
}

function normalizeInput(raw, errors) {
    const inp = isPlainObject(raw) ? raw : {};
    let messages = null;
    if (raw !== undefined && !isPlainObject(raw)) {
        errors.push('input must be an object.');
    }
    if (Array.isArray(inp.messages)) {
        messages = inp.messages;
        if (messages.length === 0) errors.push('input.messages must not be empty.');
        for (const m of messages) {
            if (!isPlainObject(m) || typeof m.role !== 'string') {
                errors.push('input.messages entries must be objects with a role string.');
                break;
            }
        }
    }
    const text = asString(inp.text, '');
    if (!messages && !text.trim()) {
        errors.push('input.text (non-empty) or input.messages is required.');
    }
    return {
        messages,
        prompt: messages ? null : {
            input: text,
            history: inp.history ?? null,
            task: inp.task ?? '{{input}}',
            prev: isPlainObject(inp.prev) ? inp.prev : {},
            wi: inp.wi ?? null,
        },
        opts: {
            useWI: !!inp.useWI,
            maxHistory: num(inp.maxHistory) ?? 20,
            attachChat: inp.attachChat !== false,
        },
    };
}

function normalizeDecideInput(raw, errors) {
    const inp = isPlainObject(raw) ? raw : {};
    if (raw !== undefined && !isPlainObject(raw)) {
        errors.push('input must be an object.');
        return null;
    }
    const d = inp.decide;
    if (!isPlainObject(d)) {
        errors.push('input.decide (object with state + questions) is required in decide mode.');
        return null;
    }
    for (const k of Object.keys(inp)) {
        if (k !== 'decide') hubWarn(`Ignoring input field "${k}" in decide mode (only input.decide is sent).`);
    }
    for (const e of validateDecidePayload({ state: d.state, questions: d.questions })) errors.push(e);
    return {
        state: d.state,
        questions: d.questions,
        options: isPlainObject(d.options) ? d.options : {},
    };
}

function normalizeSettings(raw, errors, mode = 'single') {
    const st = isPlainObject(raw) ? raw : {};
    if (raw !== undefined && !isPlainObject(raw)) errors.push('settings must be an object.');
    const conn = isPlainObject(st.connection) ? st.connection : {};
    const explicit = {
        apiUrl: asString(conn.apiUrl, '').trim(),
        apiKey: asString(conn.apiKey, ''),
        model: asString(conn.model, '').trim(),
    };
    const apiProfile = asString(st.apiProfile, '').trim();
    const harnessRaw = isPlainObject(st.harness) ? st.harness : {};
    const explicitHarness = {
        userAgent: asString(harnessRaw.userAgent, '').trim(),
        sessionId: asString(harnessRaw.sessionId, '').trim(),
    };
    const explicitExtra = isPlainObject(conn.extraHeaders)
        ? conn.extraHeaders
        : (isPlainObject(st.extraHeaders) ? st.extraHeaders : {});
    // Resolve named/default profiles into a concrete connection (secrets stay hub-side).
    let connection = explicit;
    let profileName = '';
    let profileHarness = { userAgent: '', sessionId: '' };
    let profileExtra = {};
    try {
        const r = resolveConnection({ apiProfile, connection: explicit, harness: explicitHarness, extraHeaders: explicitExtra });
        connection = r.connection;
        profileName = r.profileName;
        profileHarness = r.harness;
        profileExtra = r.extraHeaders;
    } catch (e) {
        errors.push(e?.message ?? String(e));
    }
    // Harness identity: explicit fields win per field over the profile chain
    // (already merged above); scope/header-name come from the request only.
    // Auto session ids are resolved at SEND time (see lib/harness.js), so
    // validation stays side-effect free.
    const harness = normalizeHarness({
        userAgent: profileHarness.userAgent,
        sessionId: profileHarness.sessionId,
        sessionScope: harnessRaw.sessionScope ?? harnessRaw.scope,
        sessionHeader: harnessRaw.sessionHeader,
        sendSessionHeader: harnessRaw.sendSessionHeader,
    }, errors);
    const { headers: extraHeaders, dropped } = sanitizeExtraHeaders(profileExtra);
    for (const d of dropped) hubWarn(`Ignoring unsafe settings extra header "${d}".`);
    const presetName = asString(st.preset ?? st.presetName, '');
    const samplers = isPlainObject(st.samplers) ? st.samplers : {};
    if (mode === 'decide') {
        // Chat-mode concepts do not exist on decision endpoints — warn, never send.
        if (presetName) hubWarn('Ignoring settings.preset in decide mode (decision endpoints have no presets).');
        if (Object.keys(samplers).length) hubWarn('Ignoring settings.samplers in decide mode (decision endpoints do not sample).');
        if (st.useOwnConfig) hubWarn('Ignoring settings.useOwnConfig in decide mode.');
        if (st.maxTokens !== undefined && st.maxTokens !== null && st.maxTokens !== '') {
            hubWarn('Ignoring settings.maxTokens in decide mode.');
        }
        if (st.stream) hubWarn('Ignoring settings.stream in decide mode (decision answers are single-pass, not streamed).');
        if (isPlainObject(st.harness) && Object.keys(st.harness).length) hubWarn('Ignoring settings.harness in decide mode (decision endpoints need no harness identity).');
        if (Object.keys(profileExtra).length) hubWarn('Ignoring extra headers in decide mode.');
    }
    const out = {
        connection,
        apiProfile,
        profileName,
        harness: mode === 'decide' ? null : harness,
        extraHeaders: mode === 'decide' ? {} : extraHeaders,
        presetName: mode === 'decide' ? '' : presetName,
        samplers: mode === 'decide' ? {} : samplers,
        useOwnConfig: mode === 'decide' ? false : !!st.useOwnConfig,
        maxTokens: num(st.maxTokens) ?? 1024,
        timeoutMs: num(st.timeoutMs),
        retries: num(st.retries),
        stream: mode === 'decide' ? false : !!st.stream,
    };
    if (mode !== 'decide' && !(out.maxTokens > 0)) errors.push('settings.maxTokens must be a positive number.');
    if (out.timeoutMs !== undefined && !(out.timeoutMs >= 0)) errors.push('settings.timeoutMs must be >= 0.');
    if (out.retries !== undefined && !(Number.isInteger(out.retries) && out.retries >= 0)) {
        errors.push('settings.retries must be an integer >= 0.');
    }
    const hasUrl = !!connection.apiUrl;
    if (hasUrl && !connection.model) {
        errors.push('settings.connection.model is required when settings.connection.apiUrl is set.');
    }
    if (mode === 'decide' && !hasUrl) {
        errors.push('Decide mode needs settings.connection.apiUrl (or an apiProfile): decision models have no ST-backend route.');
    }
    if (mode !== 'decide' && !hasUrl && !presetName && !connection.model) {
        errors.push('Nothing to send with: set settings.connection.apiUrl + model, or settings.preset.');
    }
    return out;
}

function hasToolContent(t) {
    if (!isPlainObject(t)) return false;
    return (Array.isArray(t.include) && t.include.length > 0)
        || (Array.isArray(t.exclude) && t.exclude.length > 0)
        || (Array.isArray(t.extra) && t.extra.length > 0)
        || t.choice !== undefined;
}

function normalizeTools(raw, mode, errors) {
    if (raw === undefined || raw === null) return null;
    if (!isPlainObject(raw)) {
        errors.push('tools must be an object.');
        return null;
    }
    if (mode !== 'agent' && hasToolContent(raw)) {
        errors.push(`tools requires mode:'agent' — got mode:'${mode}'.`);
        return null;
    }
    const strList = (v, key) => {
        if (v === undefined) return [];
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) {
            errors.push(`tools.${key} must be an array of non-empty strings.`);
            return [];
        }
        return v.map((x) => x.trim());
    };
    const extra = [];
    if (raw.extra !== undefined) {
        if (!Array.isArray(raw.extra)) {
            errors.push('tools.extra must be an array.');
        } else {
            for (const t of raw.extra) {
                if (!isPlainObject(t) || typeof t.name !== 'string' || !t.name.trim()) {
                    errors.push('tools.extra entries need a non-empty name string.');
                    continue;
                }
                if (typeof t.action !== 'function') {
                    errors.push(`tools.extra "${t.name}": action must be a function.`);
                    continue;
                }
                extra.push({
                    name: t.name.trim(),
                    displayName: asString(t.displayName, t.name.trim()),
                    description: asString(t.description, ''),
                    parameters: isPlainObject(t.parameters) ? t.parameters : { type: 'object', properties: {} },
                    action: t.action,
                    override: !!t.override,
                });
            }
        }
    }
    let choice = 'auto';
    if (raw.choice !== undefined) {
        const c = raw.choice;
        const okStr = c === 'auto' || c === 'none';
        const okObj = isPlainObject(c) && c.type === 'function' && isPlainObject(c.function) && typeof c.function.name === 'string';
        if (!okStr && !okObj) errors.push('tools.choice must be \'auto\', \'none\', or { type:\'function\', function:{ name } }.');
        else choice = c;
    }
    return { include: strList(raw.include, 'include'), exclude: strList(raw.exclude, 'exclude'), extra, choice };
}

function normalizeLimits(raw, mode, defs, errors) {
    if (raw === undefined || raw === null) {
        return { maxSteps: Math.min(defs.defaultMaxSteps, defs.maxStepsCap), totalTimeoutMs: defs.defaultTotalTimeoutMs };
    }
    if (!isPlainObject(raw)) {
        errors.push('limits must be an object.');
        return { maxSteps: defs.defaultMaxSteps, totalTimeoutMs: defs.defaultTotalTimeoutMs };
    }
    if (mode !== 'agent' && (raw.maxSteps !== undefined || raw.totalTimeoutMs !== undefined)) {
        errors.push(`limits requires mode:'agent' — got mode:'${mode}'.`);
    }
    let maxSteps = num(raw.maxSteps) ?? defs.defaultMaxSteps;
    if (!(Number.isInteger(maxSteps) && maxSteps > 0)) {
        errors.push('limits.maxSteps must be a positive integer.');
        maxSteps = defs.defaultMaxSteps;
    }
    const cap = defs.maxStepsCap > 0 ? defs.maxStepsCap : maxSteps;
    if (maxSteps > cap) {
        hubWarn(`limits.maxSteps ${maxSteps} clamped to hub cap ${cap}.`);
        maxSteps = cap;
    }
    let totalTimeoutMs = num(raw.totalTimeoutMs) ?? defs.defaultTotalTimeoutMs;
    if (!(totalTimeoutMs >= 0)) {
        errors.push('limits.totalTimeoutMs must be >= 0.');
        totalTimeoutMs = defs.defaultTotalTimeoutMs;
    }
    return { maxSteps, totalTimeoutMs };
}

/**
 * Parse + validate a raw JSON request into the hub's normalized form.
 * @throws {HubError} code 'INVALID_REQUEST' with details[] on any problem.
 */
export function parseRequest(raw = {}) {
    if (!isPlainObject(raw)) throw invalid('Request must be an object.');
    for (const k of Object.keys(raw)) {
        if (!KNOWN_TOP.has(k)) hubWarn(`Ignoring unknown request field "${k}".`);
    }
    const errors = [];
    const mode = raw.mode === undefined ? 'single' : raw.mode;
    if (!REQUEST_MODES.includes(mode)) errors.push(`mode must be one of ${REQUEST_MODES.join(', ')}.`);
    const defs = readHubSettings();
    let messages = null;
    let prompt = null;
    let opts = null;
    let decide = null;
    if (mode === 'decide') {
        decide = normalizeDecideInput(raw.input, errors);
        if (raw.onChunk !== undefined && raw.onChunk !== null) {
            hubWarn('Ignoring onChunk in decide mode (decision answers are not streamed).');
        }
        if (raw.onStep !== undefined && raw.onStep !== null) {
            hubWarn('Ignoring onStep in decide mode (no agent rounds).');
        }
    } else {
        ({ messages, prompt, opts } = normalizeInput(raw.input, errors));
    }
    const settings = normalizeSettings(raw.settings, errors, mode);
    const tools = normalizeTools(raw.tools, mode, errors);
    const limits = mode === 'agent' ? normalizeLimits(raw.limits, mode, defs, errors) : null;
    if (settings.timeoutMs === undefined) settings.timeoutMs = defs.defaultTimeoutMs;
    if (settings.retries === undefined) settings.retries = defs.defaultRetries;
    if (errors.length) throw invalid(errors);
    return {
        mode,
        messages, prompt, opts, decide,
        connection: settings.connection,
        apiProfile: settings.apiProfile,
        profileName: settings.profileName,
        harness: settings.harness,
        extraHeaders: settings.extraHeaders,
        presetName: settings.presetName,
        samplers: settings.samplers,
        useOwnConfig: settings.useOwnConfig,
        maxTokens: settings.maxTokens,
        timeoutMs: settings.timeoutMs,
        retries: settings.retries,
        stream: settings.stream,
        tools, limits,
        label: asString(raw.label, ''),
        consumer: asString(raw.consumer, ''),
        signal: raw.signal ?? null,
        onChunk: mode === 'decide' ? null : (typeof raw.onChunk === 'function' ? raw.onChunk : null),
        onStep: mode === 'decide' ? null : (typeof raw.onStep === 'function' ? raw.onStep : null),
    };
}

/**
 * Pre-check a request without sending. Returns { ok, errors } (+ normalized
 * request when ok, with the apiKey redacted — secrets never leave the hub).
 */
export function validateRequest(raw = {}) {
    try {
        const n = parseRequest(raw);
        const safe = {
            ...n,
            connection: {
                apiUrl: n.connection.apiUrl,
                model: n.connection.model,
                hasKey: !!n.connection.apiKey,
            },
            harness: n.harness ? {
                userAgent: n.harness.userAgent,
                sessionId: n.harness.sessionId,
                hasSession: !!n.harness.sessionId,
                sessionScope: n.harness.sessionScope,
                sessionHeader: n.harness.sessionHeader,
                sendSessionHeader: n.harness.sendSessionHeader,
            } : null,
            extraHeaders: n.extraHeaders ? Object.keys(n.extraHeaders) : [],
            signal: n.signal ? true : null,
            onChunk: n.onChunk ? true : null,
            onStep: n.onStep ? true : null,
        };
        return { ok: true, errors: [], request: safe };
    } catch (e) {
        if (e?.code === 'INVALID_REQUEST') return { ok: false, errors: [...(e.details ?? [e.message])] };
        return { ok: false, errors: [e?.message ?? String(e)] };
    }
}
