import { hubWarn } from './net.js';

/**
 * Usage tracking for ST-RequestHub (powers the console OVERVIEW tab).
 *
 * Privacy/size rules (by design, not convention):
 * - Metadata ONLY: consumer, label, mode, route, model, profile, timings,
 *   ok/errorCode. Prompt text, messages, answers and API keys are NEVER
 *   captured — the record API does not even accept such fields.
 * - Persisted (extensionSettings, tiny): lifetime aggregate counters.
 * - Session-only: rolling recent-100 request ring for the debug table.
 */

const MODULE_KEY = 'ST-RequestHub';
const RECENT_CAP = 100;
const MAP_KEY_CAP = 50;
const STR_CAP = 80;

let recent = [];
let seq = 0;

function blankTotals() {
    return {
        startedAt: Date.now(),
        requests: 0,
        errors: 0,
        totalMs: 0,
        byMode: {},
        byConsumer: {},
        byRoute: {},
        byProfile: {},
        byError: {},
    };
}

function str(v) {
    return String(v ?? '').slice(0, STR_CAP);
}

function bump(map, key) {
    const k = str(key) || '(none)';
    if (!Object.hasOwn(map, k)) {
        const keys = Object.keys(map);
        if (keys.length >= MAP_KEY_CAP) {
            map._other = (map._other ?? 0) + 1;
            return;
        }
    }
    map[k] = (map[k] ?? 0) + 1;
}

function readStoredTotals() {
    try {
        const stored = SillyTavern.getContext().extensionSettings?.[MODULE_KEY]?.usage;
        if (!stored || typeof stored !== 'object') return blankTotals();
        const t = blankTotals();
        for (const k of ['requests', 'errors', 'totalMs']) {
            const v = Number(stored[k]);
            if (Number.isFinite(v) && v >= 0) t[k] = v;
        }
        if (Number.isFinite(Number(stored.startedAt))) t.startedAt = Number(stored.startedAt);
        for (const k of ['byMode', 'byConsumer', 'byRoute', 'byProfile', 'byError']) {
            const m = stored[k];
            if (m && typeof m === 'object' && !Array.isArray(m)) {
                for (const [key, v] of Object.entries(m).slice(0, MAP_KEY_CAP + 1)) {
                    if (Number.isFinite(Number(v))) t[k][str(key)] = Number(v);
                }
            }
        }
        return t;
    } catch {
        return blankTotals();
    }
}

function persistTotals(totals) {
    try {
        const ctx = SillyTavern.getContext();
        const store = ctx.extensionSettings?.[MODULE_KEY];
        if (!store || typeof store !== 'object') return;
        store.usage = totals;
        ctx.saveSettingsDebounced();
    } catch (e) {
        hubWarn('usage persist failed:', e?.message ?? e);
    }
}

/** Begin tracking one hub request. Returns an opaque span token. */
export function recordStart({ consumer = '', label = '', mode = '' } = {}) {
    seq = (seq + 1) % 1000000;
    return {
        id: `${Date.now().toString(36)}-${seq}`,
        tsStart: Date.now(),
        consumer: str(consumer),
        label: str(label),
        mode: str(mode),
    };
}

/** Finish tracking. Metadata only — callers must not pass prompt/answer/key material. */
export function recordComplete(span, { route = '', model = '', profile = '', ok = true, errorCode = '' } = {}) {
    if (!span || typeof span.tsStart !== 'number') return null;
    const tsEnd = Date.now();
    const entry = {
        id: String(span.id ?? ''),
        tsStart: span.tsStart,
        tsEnd,
        durationMs: Math.max(0, tsEnd - span.tsStart),
        consumer: span.consumer || '',
        label: span.label || '',
        mode: span.mode || '',
        route: str(route),
        model: str(model),
        profile: str(profile),
        ok: !!ok,
        errorCode: ok ? '' : str(errorCode) || 'UNKNOWN',
    };
    recent.unshift(entry);
    if (recent.length > RECENT_CAP) recent.length = RECENT_CAP;

    const totals = readStoredTotals();
    totals.requests += 1;
    totals.totalMs += entry.durationMs;
    bump(totals.byMode, entry.mode);
    bump(totals.byConsumer, entry.consumer);
    bump(totals.byRoute, entry.route);
    bump(totals.byProfile, entry.profile);
    if (!entry.ok) {
        totals.errors += 1;
        bump(totals.byError, entry.errorCode);
    }
    persistTotals(totals);
    return entry;
}

/** Aggregate counters (+ derived avg). Safe for any consumer UI. */
export function getUsageStats() {
    const totals = readStoredTotals();
    return {
        ...totals,
        avgMs: totals.requests > 0 ? Math.round(totals.totalMs / totals.requests) : 0,
        recentKept: recent.length,
        recentCap: RECENT_CAP,
    };
}

/** Newest-first recent requests (session-only ring). */
export function getRecentRequests(n = 20) {
    const count = Math.max(1, Math.min(Number(n) || 20, RECENT_CAP));
    return recent.slice(0, count);
}

/** Reset persisted counters + the session ring. */
export function clearUsageStats() {
    recent = [];
    persistTotals(blankTotals());
    return getUsageStats();
}
