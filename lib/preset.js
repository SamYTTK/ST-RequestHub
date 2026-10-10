/**
 * Chat completion preset helpers (hub-canonical sampler mapping).
 * API / URL / model always stay per-request, never come from here.
 */

export const SAMPLER_KEYS = [
    'temperature',
    'top_p',
    'top_k',
    'top_a',
    'min_p',
    'frequency_penalty',
    'presence_penalty',
    'repetition_penalty',
    'seed',
];

function ctx() {
    return SillyTavern.getContext();
}

export function listPresets() {
    try {
        const pm = ctx().getPresetManager?.('openai');
        const all = pm?.getAllPresets?.();
        if (Array.isArray(all)) return all.filter((x) => typeof x === 'string' && x.length);
        return [];
    } catch {
        return [];
    }
}

export function getPresetSamplers(presetName) {
    if (!presetName) return null;
    try {
        const pm = ctx().getPresetManager?.('openai');
        const preset = pm?.getCompletionPresetByName?.(presetName);
        if (!preset || typeof preset !== 'object') return null;
        const out = {};
        for (const k of SAMPLER_KEYS) {
            if (preset[k] !== undefined && preset[k] !== null && preset[k] !== '') {
                const n = Number(preset[k]);
                out[k] = Number.isNaN(n) ? preset[k] : n;
            }
        }
        return out;
    } catch {
        return null;
    }
}

/**
 * Sampler precedence (explicit JSON always wins over the preset):
 * - useOwnConfig=true → preset ignored entirely, explicit only.
 * - preset found → preset is the base, explicit keys override it per key.
 * - no preset → explicit only.
 * @param {{presetName?:string, samplers?:object, useOwnConfig?:boolean}} opts
 * @returns {{samplers:object, source:'own'|'preset'|'merged'}}
 */
export function resolveSamplers({ presetName = '', samplers = {}, useOwnConfig = false } = {}) {
    const explicit = { ...(samplers ?? {}) };
    if (useOwnConfig) {
        return { samplers: explicit, source: 'own' };
    }
    const fromPreset = getPresetSamplers(presetName);
    if (fromPreset) {
        const keys = Object.keys(explicit).filter((k) => explicit[k] !== undefined);
        if (keys.length === 0) return { samplers: fromPreset, source: 'preset' };
        return { samplers: { ...fromPreset, ...explicit }, source: 'merged' };
    }
    return { samplers: explicit, source: 'own' };
}
