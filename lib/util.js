/**
 * Helper endpoints: token counting, connection test. (Your "requests + helpers" choice.)
 */

export class HubError extends Error {
    constructor(message, code = 'UNKNOWN', { status = null, retryable = false, details = null } = {}) {
        super(message);
        this.name = 'HubError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        if (details !== null && details !== undefined) this.details = details;
    }
}

function ctx() {
    return SillyTavern.getContext();
}

export async function countTokens(text) {
    try {
        return await ctx().getTokenCountAsync(String(text ?? ''));
    } catch {
        return Math.ceil(String(text ?? '').length / 4);
    }
}

/** Truncate oldest lines so `text` fits `budget` tokens (rough, helper-grade). */
export async function fitBudget(text, budget) {
    const s = String(text ?? '');
    if (!budget || budget <= 0) return s;
    let tokens = await countTokens(s);
    if (tokens <= budget) return s;
    const lines = s.split('\n');
    while (lines.length > 1 && tokens > budget) {
        lines.shift();
        tokens = await countTokens(lines.join('\n'));
    }
    return lines.join('\n');
}

export async function testConnection({ apiUrl, apiKey = '', model, harness = null, extraHeaders = null }) {
    const { sendDirect } = await import('./direct.js');
    const { resolveEffectiveHarness } = await import('./harness.js');
    try {
        const out = await sendDirect({
            apiUrl,
            apiKey,
            model,
            messages: [{ role: 'user', content: 'Respond with exactly: CONNECTION_OK' }],
            samplers: { temperature: 0 },
            maxTokens: 32,
            stream: false,
            harness: resolveEffectiveHarness(harness ?? null, { consumer: 'hub-test' }),
            extraHeaders,
        });
        return { success: true, message: `Connection successful! Response: "${String(out.content).slice(0, 100)}"` };
    } catch (e) {
        return { success: false, message: `Connection failed: ${e?.message ?? e}` };
    }
}

/** Ping a Laya-style decision endpoint (used by the console profile TEST button). */
export async function testDecideConnection({ apiUrl, apiKey = '', model }) {
    const { sendDecide } = await import('./decide.js');
    try {
        const out = await sendDecide({
            apiUrl,
            apiKey,
            model,
            state: 'Connection check. Answer as instructed.',
            questions: {
                ok: { type: 'noul', instructions: 'This is a connection check.' },
            },
        });
        const keys = Object.keys(out.answers ?? {});
        return { success: true, message: `Decision endpoint OK! Answered: ${keys.join(', ') || '(none)'}` };
    } catch (e) {
        return { success: false, message: `Decision endpoint failed: ${e?.message ?? e}` };
    }
}
