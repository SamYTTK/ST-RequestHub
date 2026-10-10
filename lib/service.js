/**
 * ST-backend path: ChatCompletionService with a preset applied in full
 * (prompts + samplers, server-side stored keys). Used when the request
 * has no per-request API URL.
 */

function ctx() {
    return SillyTavern.getContext();
}

/**
 * @returns {Promise<{content:string, reasoning:string, tool_calls:Array}>}
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
    const resp = await c.ChatCompletionService.processRequest(
        req,
        { presetName: presetName || undefined },
        true,
        signal,
    );
    if (typeof resp === 'function') {
        let text = '';
        let reasoning = '';
        for await (const chunk of resp()) {
            text = chunk?.text ?? text;
            reasoning = chunk?.state?.reasoning ?? reasoning;
            try { onChunk?.({ text, reasoning }); } catch { /* ignore */ }
        }
        return { content: text ?? '', reasoning: reasoning ?? '', tool_calls: [] };
    }
    return {
        content: resp?.content ?? '',
        reasoning: resp?.reasoning ?? '',
        tool_calls: Array.isArray(resp?.tool_calls) ? resp.tool_calls : [],
    };
}
