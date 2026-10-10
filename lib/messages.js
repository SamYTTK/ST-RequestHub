/**
 * Prompt/message assembly (hub-owned, pure strings + optional ST reads).
 * Nothing here touches chat[] or the DOM.
 */

export function expandTemplate(template, { input = '', history = '', prev = {}, wi = '' } = {}) {
    let out = String(template ?? '');
    out = out.split('{{input}}').join(input);
    out = out.split('{{history}}').join(history);
    out = out.split('{{wi}}').join(wi);
    out = out.replace(/\{\{prev:([^}]+)\}\}/g, (_, id) => String(prev[String(id).trim()] ?? ''));
    return out;
}

export function buildHistoryText(chatArray, n = 20) {
    try {
        const slice = (chatArray ?? []).filter((m) => !m?.is_system).slice(-n);
        return slice.map((m) => `${m?.name ?? (m?.is_user ? 'User' : 'Assistant')}: ${m?.mes ?? ''}`).join('\n');
    } catch {
        return '';
    }
}

function ctx() {
    return SillyTavern.getContext();
}

/** Fetch world-info block for the current chat. Helper for consumers. */
export async function fetchWorldInfo() {
    try {
        const c = ctx();
        const chatSlice = (c.chat ?? []).filter((m) => !m?.is_system);
        const wi = await c.getWorldInfoPrompt(chatSlice, Number(c.maxContext ?? 4096) || 4096, false);
        const parts = [];
        if (wi?.worldInfoString) parts.push(wi.worldInfoString);
        if (wi?.worldInfoBefore) parts.push(wi.worldInfoBefore);
        if (wi?.worldInfoAfter) parts.push(wi.worldInfoAfter);
        return parts.join('\n\n').trim();
    } catch (e) {
        console.warn('[ST-RequestHub] WI fetch failed:', e?.message ?? e);
        return '';
    }
}

/**
 * Build a one-message OpenAI-style array from prompt parts.
 * Callers without chat access pass history/wi strings directly.
 */
export async function buildMessages(
    { input = '', history = null, task = '{{input}}', prev = {}, wi = null } = {},
    { useWI = false, maxHistory = 20, attachChat = false } = {},
) {
    const c = ctx();
    let hist = history;
    if (hist === null && attachChat) hist = buildHistoryText(c.chat, maxHistory);
    hist = hist ?? '';
    let wiBlock = wi;
    if (wiBlock === null && useWI) wiBlock = await fetchWorldInfo();
    wiBlock = wiBlock ?? '';

    const taskText = expandTemplate(task, { input, history: hist, prev, wi: wiBlock });
    const user = [
        hist ? `Conversation so far:\n${hist}` : '',
        wiBlock ? `Relevant world info:\n${wiBlock}` : '',
        `Current user message:\n${input}`,
        `Task:\n${taskText}`,
    ].filter(Boolean).join('\n\n');
    return [{ role: 'user', content: c.substituteParams(user) }];
}
