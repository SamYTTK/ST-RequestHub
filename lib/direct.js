import { hubWarn } from './net.js';

/**
 * Direct OpenAI-compatible POST (internal to the hub).
 * Cloud endpoints direct; local endpoints via ST's /proxy/ CORS fallback.
 */

export const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?/i;

export function normalizeEndpoint(apiUrl) {
    let endpoint = String(apiUrl ?? '').trim().replace(/\/+$/, '');
    if (!endpoint) {
        const e = new Error('API URL is empty.');
        e.code = 'CONFIG';
        e.retryable = false;
        throw e;
    }
    if (!/^https?:\/\//i.test(endpoint)) endpoint = `http://${endpoint}`;
    if (!endpoint.endsWith('/chat/completions')) {
        if (endpoint.endsWith('/v1')) endpoint += '/chat/completions';
        else if (!endpoint.includes('/chat/completions')) endpoint += '/v1/chat/completions';
    }
    return endpoint;
}

function proxyHeaders() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    } catch { /* ignore */ }
    return { 'Content-Type': 'application/json' };
}

export function buildBody({ model, messages, samplers, maxTokens, tools = null, toolChoice = 'auto' }) {
    const s = samplers ?? {};
    const body = { model, messages, stream: false };
    if (Array.isArray(tools) && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = toolChoice ?? 'auto';
    }
    const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
    const t = num(s.temperature);
    const topP = num(s.top_p);
    const freq = num(s.frequency_penalty ?? s.freq_pen);
    const pres = num(s.presence_penalty ?? s.pres_pen);
    const maxT = num(maxTokens);
    if (t !== undefined && !Number.isNaN(t)) body.temperature = t;
    if (topP !== undefined && !Number.isNaN(topP)) body.top_p = topP;
    if (freq !== undefined && !Number.isNaN(freq)) body.frequency_penalty = freq;
    if (pres !== undefined && !Number.isNaN(pres)) body.presence_penalty = pres;
    const topK = num(s.top_k);
    const minP = num(s.min_p);
    const topA = num(s.top_a);
    const repPen = num(s.repetition_penalty ?? s.rep_pen);
    if (topK !== undefined && !Number.isNaN(topK) && topK > 0) body.top_k = topK;
    if (minP !== undefined && !Number.isNaN(minP) && minP > 0) body.min_p = minP;
    if (topA !== undefined && !Number.isNaN(topA) && topA > 0) body.top_a = topA;
    if (repPen !== undefined && !Number.isNaN(repPen) && repPen !== 1) body.repetition_penalty = repPen;
    if (maxT !== undefined && !Number.isNaN(maxT) && maxT > 0) body.max_tokens = maxT;
    // Full-config keys (all only-when-set; omitted otherwise so picky endpoints never see them)
    const seed = num(s.seed);
    if (seed !== undefined && Number.isInteger(seed)) body.seed = seed;
    if (s.stop !== undefined && s.stop !== null && s.stop !== '') {
        if (typeof s.stop === 'string' || (Array.isArray(s.stop) && s.stop.every((x) => typeof x === 'string'))) {
            body.stop = s.stop;
        }
    }
    if (s.logit_bias && typeof s.logit_bias === 'object' && !Array.isArray(s.logit_bias)) body.logit_bias = s.logit_bias;
    if (s.response_format && typeof s.response_format === 'object' && !Array.isArray(s.response_format)) {
        body.response_format = s.response_format;
    }
    if (typeof s.reasoning_effort === 'string' && s.reasoning_effort.trim()) body.reasoning_effort = s.reasoning_effort.trim();
    const mct = num(s.max_completion_tokens);
    if (mct !== undefined && !Number.isNaN(mct) && mct > 0) {
        // Newer reasoning models reject max_tokens — explicit opt-in replaces it.
        body.max_completion_tokens = mct;
        delete body.max_tokens;
    }
    return body;
}

async function postJson(endpoint, headers, body, signal, { useProxy }) {
    const url = useProxy ? `/proxy/${endpoint}` : endpoint;
    const h = useProxy ? { ...proxyHeaders(), ...headers } : headers;
    return await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal });
}

function extractContent(json) {
    const msg = json?.choices?.[0]?.message;
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    if (typeof msg?.content === 'string' && msg.content) return { content: msg.content, reasoning: '', tool_calls: toolCalls };
    if (Array.isArray(msg?.content)) {
        const text = msg.content.filter((p) => p?.type === 'text' && p?.text).map((p) => p.text).join('');
        if (text) return { content: text, reasoning: '', tool_calls: toolCalls };
    }
    const reasoning = msg?.reasoning_content ?? msg?.reasoning ?? json?.choices?.[0]?.delta?.reasoning_content ?? '';
    const fallback = typeof json?.content === 'string' ? json.content : '';
    return { content: fallback, reasoning: typeof reasoning === 'string' ? reasoning : '', tool_calls: toolCalls };
}

/** Merge streaming tool_calls deltas (OpenAI index-based accumulation). */
function mergeToolCallDelta(acc, delta) {
    const idx = Number.isInteger(delta?.index) && delta.index >= 0 ? delta.index : 0;
    acc[idx] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
    const t = acc[idx];
    if (typeof delta?.id === 'string' && delta.id) t.id = delta.id;
    if (typeof delta?.type === 'string' && delta.type) t.type = delta.type;
    const fn = delta?.function ?? {};
    if (typeof fn.name === 'string' && fn.name) t.function.name += fn.name;
    if (typeof fn.arguments === 'string' && fn.arguments) t.function.arguments += fn.arguments;
}

async function drainStream(response, onChunk, signal) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let reasoning = '';
    const toolCalls = [];
    try {
        while (true) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed?.choices?.[0]?.delta ?? {};
                    if (typeof delta.content === 'string' && delta.content) full += delta.content;
                    const r = delta.reasoning_content ?? delta.reasoning ?? '';
                    if (typeof r === 'string' && r) reasoning += r;
                    if (Array.isArray(delta.tool_calls)) {
                        for (const tc of delta.tool_calls) mergeToolCallDelta(toolCalls, tc);
                    }
                    try { onChunk?.({ text: full, reasoning }); } catch { /* ignore */ }
                } catch { /* keep-alive / comment */ }
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
    }
    return { content: full, reasoning, tool_calls: toolCalls.filter((t) => t?.function?.name || t?.id) };
}

function hubError(message, code, { status = null, retryable = false } = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    e.retryable = retryable;
    return e;
}

/** @returns {Promise<{content:string, reasoning:string, tool_calls:Array}>} */
export async function sendDirect({ apiUrl, apiKey, model, messages, samplers, maxTokens, signal = null, stream = false, onChunk = null, preferProxy = true, tools = null, toolChoice = 'auto' }) {
    if (!model) throw hubError('Model is empty.', 'CONFIG');
    const endpoint = normalizeEndpoint(apiUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const withTools = Array.isArray(tools) && tools.length > 0;
    const body = { ...buildBody({ model, messages, samplers, maxTokens, tools: withTools ? tools : null, toolChoice }), stream: !!stream };
    const isLocal = LOCAL_RE.test(endpoint);

    let response = null;
    let lastError = null;
    const attempts = isLocal && preferProxy ? [true, false] : [false];
    for (const useProxy of attempts) {
        try {
            response = await postJson(endpoint, headers, body, signal, { useProxy });
            lastError = null;
            break;
        } catch (e) {
            lastError = e;
            if (signal?.aborted) throw e;
            hubWarn(`direct POST ${useProxy ? 'via proxy' : 'direct'} failed:`, e?.message ?? e);
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
        const code = (response.status === 400 && withTools && /tool/i.test(text))
            ? 'TOOLS_UNSUPPORTED'
            : `HTTP_${response.status}`;
        const msg = code === 'TOOLS_UNSUPPORTED'
            ? `Endpoint rejected tool calling (HTTP 400): ${text.slice(0, 300)}`
            : `Endpoint returned ${response.status}: ${text.slice(0, 300)}`;
        throw hubError(msg, code, {
            status: response.status,
            retryable: code === 'TOOLS_UNSUPPORTED' ? false : (response.status >= 500 || response.status === 429),
        });
    }
    if (body.stream) {
        const out = await drainStream(response, onChunk, signal);
        if (!out.content.trim() && !out.reasoning.trim() && !(out.tool_calls?.length)) {
            throw hubError('Endpoint returned an empty stream.', 'EMPTY_RESPONSE');
        }
        return out;
    }
    const json = await response.json();
    if (json?.error) {
        const errMsg = String(json.error?.message ?? 'Endpoint error');
        if (withTools && /tool/i.test(errMsg)) throw hubError(`Endpoint rejected tool calling: ${errMsg.slice(0, 300)}`, 'TOOLS_UNSUPPORTED', { retryable: false });
        throw hubError(errMsg, 'HTTP_4xx', { retryable: false });
    }
    const out = extractContent(json);
    if (!String(out.content ?? '').trim() && !String(out.reasoning ?? '').trim() && !(out.tool_calls?.length)) {
        throw hubError('Endpoint returned an empty response.', 'EMPTY_RESPONSE');
    }
    return out;
}
