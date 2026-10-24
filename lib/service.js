/**
 * ST-backend path: ChatCompletionService with a preset applied in full
 * (prompts + samplers, server-side stored keys). Used when the request
 * has no per-request API URL.
 *
 * The backend route returns the PROVIDER payload, so the hub asks for it
 * un-extracted (`extractData: false`) and reads the usage + finish reason
 * from it — the ST backend path used to record no usage at all.
 */

import { parseUsage } from './usage.js';

function ctx() {
    return SillyTavern.getContext();
}

/**
 * Extract the assistant text from a raw backend payload.
 * Mirrors ST's own openai extraction (content parts / choices[0].message).
 * @param {object} json
 * @returns {string}
 */
function extractBackendContent(json) {
    const parts = json?.content;
    if (Array.isArray(parts)) {
        return parts.filter((p) => p?.type === 'text' && p?.text).map((p) => p.text).join('\n\n');
    }
    const msg = json?.choices?.[0]?.message;
    if (typeof msg?.content === 'string') return msg.content;
    if (Array.isArray(msg?.content)) {
        return msg.content.filter((p) => p?.type === 'text' && p?.text).map((p) => p.text).join('');
    }
    if (typeof json?.choices?.[0]?.text === 'string') return json.choices[0].text;
    if (typeof json?.text === 'string') return json.text;
    if (typeof json?.message?.content?.[0]?.text === 'string') return json.message.content[0].text;
    if (typeof json?.message?.tool_plan === 'string') return json.message.tool_plan;
    if (typeof json?.content === 'string') return json.content;
    return '';
}

/**
 * Extract the reasoning text from a raw backend payload (best effort —
 * covers the OpenAI-ish, Claude-ish, Gemini-ish and Mistral-ish shapes).
 * @param {object} json
 * @returns {string}
 */
function extractBackendReasoning(json) {
    const msg = json?.choices?.[0]?.message;
    const direct = msg?.reasoning_content ?? msg?.reasoning;
    if (typeof direct === 'string' && direct) return direct;
    if (Array.isArray(json?.content)) {
        const thinking = json.content
            .filter((p) => p?.type === 'thinking')
            .map((p) => p?.thinking ?? p?.text)
            .filter(Boolean)
            .join('\n\n');
        if (thinking) return thinking;
    }
    if (Array.isArray(json?.responseContent?.parts)) {
        const thought = json.responseContent.parts
            .filter((p) => p?.thought)
            .map((p) => p?.text)
            .filter(Boolean)
            .join('\n\n');
        if (thought) return thought;
    }
    if (Array.isArray(msg?.content?.[0]?.thinking)) {
        const t = msg.content[0].thinking.map((p) => p?.text).filter(Boolean).join('\n\n');
        if (t) return t;
    }
    return '';
}

/**
 * @returns {Promise<{content:string, reasoning:string, tool_calls:Array, usage:object|null, finish_reason:string}>}
 * Per-request sampler overrides ride in `samplers` and beat the preset
 * (core merges requestData over the preset payload). Only-when-set.
 */
export async function sendViaBackend({ messages, model = '', presetName = '', samplers = {}, maxTokens = 1024, signal = null, onChunk = null, tools = null, toolChoice = 'auto' }) {
    const c = ctx();
    const req = { stream: false, messages, max_tokens: maxTokens };
    const sm = samplers ?? {};
    const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
    for (const k of ['temperature', 'top_p', 'top_k', 'min_p', 'top_a', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed']) {
        const v = num(sm[k]);
        if (v !== undefined && !Number.isNaN(v)) req[k] = v;
    }
    if (sm.stop !== undefined && sm.stop !== null && sm.stop !== '') req.stop = sm.stop;
    if (sm.response_format && typeof sm.response_format === 'object' && !Array.isArray(sm.response_format)) {
        req.response_format = sm.response_format;
    }
    if (Array.isArray(tools) && tools.length > 0) {
        req.tools = tools;
        req.tool_choice = toolChoice ?? 'auto';
    }
    if (model && String(model).trim()) req.model = String(model).trim();
    // extractData:false → the raw provider payload (usage + finish_reason).
    const resp = await c.ChatCompletionService.processRequest(
        req,
        { presetName: presetName || undefined },
        false,
        signal,
    );
    if (typeof resp === 'function') {
        let text = '';
        let reasoning = '';
        for await (const chunk of resp()) {
            text = chunk?.text ?? text;
            reasoning = chunk?.state?.reasoning ?? reasoning;
            // CUMULATIVE snapshot (full text so far), not an incremental delta.
            try { onChunk?.({ text, reasoning }); } catch { /* ignore */ }
        }
        return { content: text ?? '', reasoning: reasoning ?? '', tool_calls: [], usage: null, finish_reason: '' };
    }
    const raw = resp && typeof resp === 'object' ? resp : {};
    const content = extractBackendContent(raw).replace(/[^\S\r\n]+$/gm, '');
    const reasoning = extractBackendReasoning(raw);
    const toolCalls = Array.isArray(raw?.choices?.[0]?.message?.tool_calls)
        ? raw.choices[0].message.tool_calls
        : [];
    return {
        content,
        reasoning,
        tool_calls: toolCalls,
        usage: parseUsage(raw),
        finish_reason: String(raw?.choices?.[0]?.finish_reason ?? raw?.stop_reason ?? ''),
    };
}
