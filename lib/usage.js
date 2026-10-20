/**
 * ST-RequestHub — usage + quota tracking.
 *
 * General-purpose, provider-agnostic usage layer. Every `hub.request()` feeds
 * it (tokens, cost, rate-limit windows) and every extension can read it back
 * through the public API:
 *
 *   hub.getUsageSnapshot(filter)
 *   hub.getUsage(filter)
 *   hub.getRateLimits(filter)
 *   hub.getUsageHistory({ scope, window, limit })
 *   hub.onUsage(cb)
 *   hub.refreshQuota(profile?)
 *   hub.registerQuotaProvider(id, adapter)
 *   hub.listQuotaProviders()
 *   hub.getKeyInfo(profile)
 *
 * Privacy rules: prompts, answers and raw API keys are NEVER stored. Keys are
 * reduced to a short fingerprint. Recent events stay in memory; only aggregate
 * counters and normalized limit windows are persisted.
 */

import { resolveConnection } from './profiles.js';

const MODULE_KEY = 'ST-RequestHub';
const RECENT_CAP = 500;
const DAY_CAP = 31;
const PERSIST_DEBOUNCE_MS = 750;

const RATE_KINDS = ['requests', 'tokens', 'input-tokens', 'output-tokens', 'prompt-tokens', 'generated-tokens'];

let recent = [];
let listeners = new Set();
let quotaProviders = new Map();
let persistTimer = null;
let _seq = 0;
let liveState = null;

function ctx() {
    try { return SillyTavern.getContext(); } catch { return null; }
}

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function str(v, cap = 120) {
    return String(v ?? '').slice(0, cap);
}

export function providerHost(apiUrl) {
    try { return new URL(String(apiUrl || '')).host.toLowerCase(); } catch { return ''; }
}

/**
 * Short, non-reversible-enough fingerprint for display/correlation. This is
 * NOT a security boundary: only the hub sees the raw key, and the fingerprint
 * is never sufficient to reconstruct it.
 */
export function fingerprintKey(key) {
    const s = String(key ?? '');
    if (!s) return '';
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `k_${h.toString(16).padStart(8, '0')}_${s.length}`;
}

function scopeKey({ profile = '', providerHost: host = '', keyFingerprint = '', model = '' } = {}) {
    return [profile || '(default)', host || '(none)', keyFingerprint || '(nokey)', model || '(anymodel)'].join('|');
}

function isExpiredWindow(w, now = Date.now()) {
    return w && typeof w === 'object' && Number.isFinite(Number(w.resetAt)) && Number(w.resetAt) <= now;
}

function dayKey(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function blankTotals() {
    return {
        requests: 0,
        errors: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        cost: 0,
        byProfile: {},
        byModel: {},
        byConsumer: {},
        byMode: {},
        byKey: {},
    };
}

function blankState() {
    return {
        version: 2,
        startedAt: Date.now(),
        totals: blankTotals(),
        days: {},
        limits: {},
        updatedAt: Date.now(),
    };
}

function historyKeysAllowed() {
    return true;
}

function readState() {
    const blank = blankState();
    try {
        const stored = ctx()?.extensionSettings?.[MODULE_KEY]?.usageV2;
        if (!stored || typeof stored !== 'object') return blank;
        const s = blank;
        if (Number.isFinite(Number(stored.startedAt))) s.startedAt = Number(stored.startedAt);
        if (Number.isFinite(Number(stored.updatedAt))) s.updatedAt = Number(stored.updatedAt);
        const t = stored.totals;
        if (t && typeof t === 'object') {
            for (const k of ['requests', 'errors', 'promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens', 'cost']) {
                const v = Number(t[k]);
                if (Number.isFinite(v) && v >= 0) s.totals[k] = v;
            }
            for (const k of ['byProfile', 'byModel', 'byConsumer', 'byMode']) {
                const m = t[k];
                if (m && typeof m === 'object' && !Array.isArray(m)) {
                    for (const [key, v] of Object.entries(m).slice(0, 200)) {
                        if (Number.isFinite(Number(v))) s.totals[k][str(key)] = Number(v);
                    }
                }
            }
            const byKey = t.byKey;
            if (byKey && typeof byKey === 'object' && !Array.isArray(byKey)) {
                for (const [key, v] of Object.entries(byKey).slice(0, 200)) {
                    if (!v || typeof v !== 'object') continue;
                    s.totals.byKey[str(key, 220)] = {
                        profile: str(v.profile),
                        model: str(v.model),
                        providerHost: str(v.providerHost),
                        requests: Number(v.requests) || 0,
                        totalTokens: Number(v.totalTokens) || 0,
                        cost: (v.cost === null || v.cost === undefined) ? null : (Number(v.cost) || 0),
                    };
                }
            }
        }
        if (stored.days && typeof stored.days === 'object' && !Array.isArray(stored.days)) {
            for (const [key, v] of Object.entries(stored.days).slice(-DAY_CAP * 2)) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !v || typeof v !== 'object') continue;
                s.days[key] = {
                    requests: Number(v.requests) || 0,
                    errors: Number(v.errors) || 0,
                    promptTokens: Number(v.promptTokens) || 0,
                    completionTokens: Number(v.completionTokens) || 0,
                    totalTokens: Number(v.totalTokens) || 0,
                    cost: (v.cost === null || v.cost === undefined) ? null : (Number(v.cost) || 0),
                };
            }
        }
        if (stored.limits && typeof stored.limits === 'object' && !Array.isArray(stored.limits)) {
            const now = Date.now();
            for (const [key, v] of Object.entries(stored.limits).slice(0, 100)) {
                if (!v || typeof v !== 'object' || !Array.isArray(v.windows)) continue;
                const windows = v.windows.slice(0, 12).map(sanitizeWindow).filter(Boolean)
                    .filter((w) => !isExpiredWindow(w, now));
                if (!windows.length) continue;
                s.limits[str(key, 220)] = {
                    profile: str(v.profile),
                    providerHost: str(v.providerHost),
                    model: str(v.model),
                    keyFingerprint: str(v.keyFingerprint),
                    planLabel: str(v.planLabel, 80),
                    updatedAt: Number(v.updatedAt) || Date.now(),
                    windows,
                };
            }
        }
        return s;
    } catch {
        return blank;
    }
}

function sanitizeWindow(w) {
    if (!w || typeof w !== 'object') return null;
    const kind = str(w.kind, 32);
    if (!kind) return null;
    const out = {
        kind,
        limit: num(w.limit),
        remaining: num(w.remaining),
        used: num(w.used),
        resetAt: num(w.resetAt),
        windowSeconds: num(w.windowSeconds),
        source: str(w.source, 16) || 'provider',
        confidence: str(w.confidence, 12) || 'high',
        family: str(w.family, 24),
    };
    if (w.valueLabel !== undefined && w.valueLabel !== null && String(w.valueLabel) !== '') {
        out.valueLabel = str(w.valueLabel, 48);
    }
    return out;
}

function writeState(state) {
    try {
        for (const k of ['byProfile', 'byModel', 'byConsumer', 'byMode']) {
            if (state?.totals?.[k] && typeof state.totals[k] === 'object') capMap(state.totals[k]);
        }
        liveState = state;
        const c = ctx();
        if (!c?.extensionSettings) return;
        if (!c.extensionSettings[MODULE_KEY] || typeof c.extensionSettings[MODULE_KEY] !== 'object') {
            c.extensionSettings[MODULE_KEY] = {};
        }
        state.updatedAt = Date.now();
        c.extensionSettings[MODULE_KEY].usageV2 = state;
        c.saveSettingsDebounced?.();
    } catch { /* ignore */ }
}

function getState() {
    if (!liveState) liveState = readState();
    return liveState;
}

function schedulePersist(state) {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        writeState(state);
    }, PERSIST_DEBOUNCE_MS);
}

export function flushUsageWrites() {
    if (!persistTimer) return false;
    clearTimeout(persistTimer);
    persistTimer = null;
    try {
        writeState(getState());
    } catch { /* ignore */ }
    return true;
}

try {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', () => { try { flushUsageWrites(); } catch { /* ignore */ } });
        window.addEventListener('beforeunload', () => { try { flushUsageWrites(); } catch { /* ignore */ } });
    }
} catch { /* non-browser — ignore */ }

const MAP_KEY_CAP = 50;

function bump(map, key, amount = 1) {
    const k = str(key) || '(none)';
    if (!Object.hasOwn(map, k)) {
        if (Object.keys(map).filter((x) => x !== '_other').length >= MAP_KEY_CAP) {
            map._other = (Number(map._other) || 0) + amount;
            return;
        }
    }
    map[k] = (Number(map[k]) || 0) + amount;
}

function capMap(map) {
    const keys = Object.keys(map).filter((x) => x !== '_other');
    if (keys.length <= MAP_KEY_CAP) return;
    let overflow = Number(map._other) || 0;
    for (const k of keys.slice(0, keys.length - MAP_KEY_CAP)) {
        overflow += Number(map[k]) || 0;
        delete map[k];
    }
    if (overflow) map._other = overflow;
}

function addWindowToState(state, scope, window) {
    const key = scopeKey(scope);
    const entry = state.limits[key] || {
        profile: scope.profile || '',
        providerHost: scope.providerHost || '',
        model: scope.model || '',
        keyFingerprint: scope.keyFingerprint || '',
        planLabel: '',
        windows: [],
        updatedAt: Date.now(),
    };
    const idx = entry.windows.findIndex((w) => w.kind === window.kind);
    if (idx === -1) entry.windows.push(window);
    else entry.windows[idx] = { ...entry.windows[idx], ...window };
    entry.updatedAt = Date.now();
    state.limits[key] = entry;
}

/**
 * Normalize one set of response headers into provider-neutral windows.
 * @param {Headers|object} headers
 * @param {number} [now]
 * @returns {Array<object>}
 */
export function parseRateLimitHeaders(headers, now = Date.now()) {
    const h = {};
    try {
        if (headers && typeof headers.forEach === 'function' && typeof headers.get === 'function') {
            headers.forEach((v, k) => { h[String(k).toLowerCase()] = String(v); });
        } else if (headers && typeof headers === 'object') {
            for (const [k, v] of Object.entries(headers)) h[String(k).toLowerCase()] = String(v);
        }
    } catch { /* ignore */ }

    const out = [];
    const seen = new Set();
    const parseReset = (v) => resetToMs(v, now);

    const push = (kind, limit, remaining, reset, family) => {
        if (seen.has(kind)) return;
        const lim = num(limit);
        const rem = num(remaining);
        const resetAt = parseReset(reset);
        if (lim === null && rem === null && resetAt === null) return;
        seen.add(kind);
        out.push({
            kind,
            limit: lim,
            remaining: rem,
            used: lim !== null && rem !== null ? Math.max(0, lim - rem) : null,
            resetAt,
            windowSeconds: resetAt ? Math.max(0, Math.round((resetAt - now) / 1000)) : null,
            source: 'provider',
            confidence: lim !== null && rem !== null ? 'high' : 'medium',
            family,
        });
    };

    // Anthropic: anthropic-ratelimit-<kind>-{limit,remaining,reset}
    for (const kind of RATE_KINDS) {
        const p = `anthropic-ratelimit-${kind}`;
        if (h[`${p}-limit`] !== undefined || h[`${p}-remaining`] !== undefined || h[`${p}-reset`] !== undefined) {
            push(kind, h[`${p}-limit`], h[`${p}-remaining`], h[`${p}-reset`], 'anthropic');
        }
    }

    // OpenAI / Groq / xAI / Together / Mistral / Fireworks / generic.
    // Fireworks uses e.g. x-ratelimit-limit-tokens-prompt; fold those into
    // prompt-tokens / generated-tokens.
    for (const rawKind of Object.keys(h)) {
        const m = rawKind.match(/^x-ratelimit-limit-(.+)$/);
        if (!m) continue;
        let kind = m[1];
        kind = kind.replace(/^tokens-prompt$/, 'prompt-tokens').replace(/^tokens-cache-adjusted-prompt$/, 'prompt-tokens').replace(/^tokens-generated$/, 'generated-tokens');
        if (!/^[a-z0-9-]+$/.test(kind)) continue;
        push(kind, h[`x-ratelimit-limit-${m[1]}`], h[`x-ratelimit-remaining-${m[1]}`], h[`x-ratelimit-reset-${m[1]}`], 'openai');
    }

    // OpenRouter style (no kind) — treat as requests.
    if (h['x-ratelimit-limit'] !== undefined || h['x-ratelimit-remaining'] !== undefined || h['x-ratelimit-reset'] !== undefined) {
        push('requests', h['x-ratelimit-limit'], h['x-ratelimit-remaining'], h['x-ratelimit-reset'], 'openrouter');
    }

    // 429 hint.
    const retryAfter = h['retry-after'];
    if (retryAfter !== undefined && !seen.has('retry')) {
        const resetAt = parseReset(retryAfter);
        if (resetAt !== null) {
            out.push({
                kind: 'retry',
                limit: null,
                remaining: 0,
                used: null,
                resetAt,
                windowSeconds: Math.max(0, Math.round((resetAt - now) / 1000)),
                source: 'provider',
                confidence: 'high',
                family: 'retry-after',
            });
        }
    }

    return out;
}

/** Parse a duration / ISO / epoch value into an epoch-ms timestamp. */
export function resetToMs(value, now = Date.now()) {
    if (value === null || value === undefined || value === '') return null;
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const t = Date.parse(s);
        return Number.isFinite(t) ? t : null;
    }
    if (/^\d+(?:\.\d+)?$/.test(s)) {
        const n = Number(s);
        if (!Number.isFinite(n)) return null;
        if (n > 1e12) return n; // already ms
        if (n > 1e9) return n * 1000; // epoch seconds
        return now + n * 1000; // seconds from now
    }
    let ms = 0;
    let matched = false;
    const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi;
    let m;
    while ((m = re.exec(s))) {
        matched = true;
        const n = Number(m[1]);
        const unit = m[2].toLowerCase();
        ms += n * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit] || 0);
    }
    if (matched) return now + ms;
    const parsed = Date.parse(s);
    if (Number.isFinite(parsed)) return parsed;
    return null;
}

/**
 * Normalize token/cost usage from any supported response body.
 * @returns {{promptTokens:number,completionTokens:number,totalTokens:number,cachedTokens:number,reasoningTokens:number,cost:number|null,currency:string,serviceTier?:string}|null}
 */
export function parseUsage(json) {
    const u = json?.usage ?? json?.response?.usage ?? (json && typeof json === 'object' && ('prompt_tokens' in json || 'input_tokens' in json) ? json : null);
    if (!u || typeof u !== 'object') return null;
    const prompt = num(u.prompt_tokens ?? u.input_tokens) ?? 0;
    const completion = num(u.completion_tokens ?? u.output_tokens) ?? 0;
    const total = num(u.total_tokens) ?? (prompt + completion);
    const cached = num(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? u.cache_read_input_tokens) ?? 0;
    const reasoning = num(u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens) ?? 0;
    const cost = num(u.cost ?? u.total_cost);
    if (!prompt && !completion && !total && !cost) return null;
    return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total,
        cachedTokens: cached,
        reasoningTokens: reasoning,
        cost: cost === null ? null : cost,
        currency: str(u.currency, 8) || 'USD',
        serviceTier: str(u.service_tier, 24) || '',
    };
}

function priceFor(model) {
    try {
        const p = ctx()?.extensionSettings?.[MODULE_KEY]?.usagePricing?.[model];
        if (!p || typeof p !== 'object') return null;
        const input = Number(p.input);
        const output = Number(p.output);
        const cached = Number(p.cached ?? p.cache ?? NaN);
        if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
        return { input, output, cached: Number.isFinite(cached) ? cached : input };
    } catch { return null; }
}

/**
 * Record one completed request. Metadata + token/cost only — never prompts,
 * answers or raw keys.
 * @param {object} rec
 */
export function recordUsage(rec = {}) {
    const c = rec.consumer || '';
    const label = rec.label || '';
    const mode = rec.mode || '';
    const route = rec.route || '';
    const profile = rec.profile || '';
    const model = rec.model || '';
    const apiUrl = rec.apiUrl || '';
    const host = providerHost(apiUrl);
    const keyFingerprint = fingerprintKey(rec.apiKey || '');
    const usage = rec.usage || null;
    const rateLimits = Array.isArray(rec.rateLimits) ? rec.rateLimits.map(sanitizeWindow).filter(Boolean) : [];
    const now = Date.now();

    let promptTokens = Number(usage?.promptTokens) || 0;
    let completionTokens = Number(usage?.completionTokens) || 0;
    let totalTokens = Number(usage?.totalTokens) || (promptTokens + completionTokens);
    const cachedTokens = Number(usage?.cachedTokens) || 0;
    const reasoningTokens = Number(usage?.reasoningTokens) || 0;
    let cost = usage?.cost === null || usage?.cost === undefined ? null : Number(usage.cost);
    let priced = false;
    if (cost === null && usage && totalTokens > 0) {
        const price = priceFor(model);
        if (price) {
            const cachedPart = Math.min(cachedTokens, promptTokens);
            cost = ((promptTokens - cachedPart) * price.input + cachedPart * price.cached + completionTokens * price.output) / 1_000_000;
            priced = true;
        }
    }
    if (cost !== null && !Number.isFinite(cost)) { cost = null; priced = false; }

    const addCost = (cur, delta) => {
        if (delta === null || delta === undefined) return cur;
        if (cur === null || cur === undefined) return delta;
        return cur + delta;
    };

    const event = {
        id: `${now.toString(36)}-${(++_seq).toString(36)}`,
        ts: now,
        durationMs: Number(rec.durationMs) || 0,
        consumer: str(c),
        label: str(label),
        mode: str(mode, 16),
        route: str(route, 16),
        profile: str(profile),
        model: str(model),
        providerHost: str(host),
        keyFingerprint,
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
        reasoningTokens,
        cost,
        currency: str(usage?.currency, 8) || 'USD',
        estimated: !!rec.estimated || priced,
        ok: rec.ok !== false,
        status: Number(rec.status) || 0,
        errorCode: str(rec.errorCode, 32),
        rateLimits,
    };

    recent.unshift(event);
    if (recent.length > RECENT_CAP) recent.length = RECENT_CAP;

    const state = getState();
    const t = state.totals;
    t.requests += 1;
    if (!event.ok) t.errors += 1;
    t.promptTokens += promptTokens;
    t.completionTokens += completionTokens;
    t.totalTokens += totalTokens;
    t.cachedTokens += cachedTokens;
    t.reasoningTokens += reasoningTokens;
    if (cost !== null) t.cost += cost;

    bump(t.byProfile, profile);
    bump(t.byModel, model);
    bump(t.byConsumer, c);
    bump(t.byMode, mode);

    const sk = scopeKey({ profile, providerHost: host, keyFingerprint, model });
    const keyTotals = t.byKey[sk] || { profile, model, providerHost: host, requests: 0, totalTokens: 0, cost: null };
    keyTotals.requests += 1;
    keyTotals.totalTokens += totalTokens;
    keyTotals.cost = addCost(keyTotals.cost, cost);
    keyTotals.model = keyTotals.model || model;
    t.byKey[sk] = keyTotals;

    const day = dayKey(now);
    const d = state.days[day] || { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: null };
    d.requests += 1;
    if (!event.ok) d.errors += 1;
    d.promptTokens += promptTokens;
    d.completionTokens += completionTokens;
    d.totalTokens += totalTokens;
    d.cost = addCost(d.cost, cost);
    state.days[day] = d;
    const days = Object.keys(state.days).sort();
    while (days.length > DAY_CAP) delete state.days[days.shift()];

    const scope = { profile, providerHost: host, model, keyFingerprint };
    for (const w of rateLimits) addWindowToState(state, scope, w);

    schedulePersist(state);
    emit(event);
    return event;
}

function copyEvent(event) {
    if (!event || typeof event !== 'object') return event;
    return {
        ...event,
        rateLimits: Array.isArray(event.rateLimits) ? event.rateLimits.map((w) => ({ ...w })) : [],
    };
}

function emit(event) {
    const snapshot = copyEvent(event);
    for (const cb of [...listeners]) {
        try { cb(copyEvent(snapshot)); } catch (e) { console.warn('[ST-RequestHub] usage listener failed', e?.message ?? e); }
    }
}

/** Subscribe to completed requests / quota refreshes. Returns an unsubscribe fn. */
export function onUsage(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function matchesFilter(value, filter) {
    if (!filter) return true;
    for (const key of ['profile', 'model', 'consumer', 'providerHost', 'keyFingerprint']) {
        if (filter[key] !== undefined && filter[key] !== null && String(filter[key]) !== String(value[key] ?? '')) return false;
    }
    return true;
}

function withDerived(w) {
    const now = Date.now();
    const resetInMs = w.resetAt ? Math.max(0, w.resetAt - now) : null;
    const usedPercent = w.limit && w.used !== null ? Math.max(0, Math.min(100, (w.used / w.limit) * 100)) : null;
    const remainingPercent = w.limit && w.remaining !== null ? Math.max(0, Math.min(100, (w.remaining / w.limit) * 100)) : null;
    return { ...w, resetInMs, usedPercent, remainingPercent };
}

/** Cached, synchronous snapshot for dashboards. */
export function getUsageSnapshot(filter = {}) {
    const state = getState();
    const now = Date.now();
    const limits = {};
    for (const [key, entry] of Object.entries(state.limits)) {
        if (!matchesFilter({ ...entry, consumer: '' }, filter)) continue;
        const windows = entry.windows.map(withDerived)
            .filter((w) => w.resetAt === null || w.resetAt === undefined || w.resetAt > now);
        if (!windows.length) continue;
        limits[key] = {
            ...entry,
            windows,
        };
    }
    const recentFiltered = recent.filter((e) => matchesFilter(e, filter)).slice(0, 100)
        .map((e) => ({ ...e, rateLimits: Array.isArray(e.rateLimits) ? e.rateLimits.map((w) => ({ ...w })) : [] }));
    const days = Object.entries(state.days)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, v]) => ({ day, ...v }));
    let totals;
    try {
        totals = JSON.parse(JSON.stringify(state.totals));
    } catch {
        totals = { ...state.totals };
    }
    return {
        version: 2,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        totals,
        limits,
        days,
        recent: recentFiltered,
    };
}

/** Aggregate usage, optionally filtered. */
export function getUsage(filter = {}) {
    const snap = getUsageSnapshot(filter);
    return {
        totals: snap.totals,
        limits: snap.limits,
        days: snap.days,
        recent: snap.recent,
    };
}

/** Normalized rate-limit windows for the requested scope(s). */
export function getRateLimits(filter = {}) {
    const snap = getUsageSnapshot(filter);
    return Object.entries(snap.limits).map(([key, entry]) => ({ key, ...entry }));
}

/**
 * Session-only rolling history derived from the recent ring.
 * @param {{scope?:object, window?:'minute'|'hour'|'day', limit?:number}} opts
 */
export function getUsageHistory(opts = {}) {
    const window = opts.window || 'hour';
    const size = window === 'minute' ? 60000 : window === 'day' ? 86400000 : 3600000;
    const limit = Math.max(1, Math.min(240, Number(opts.limit) || 24));
    const now = Date.now();
    const buckets = [];
    for (let i = limit - 1; i >= 0; i--) {
        const start = now - i * size;
        buckets.push({ start, requests: 0, totalTokens: 0, cost: 0, errors: 0 });
    }
    for (const e of recent) {
        if (!matchesFilter(e, opts.scope || null)) continue;
        const age = now - e.ts;
        if (age < 0 || age >= size * limit) continue;
        const idx = limit - 1 - Math.floor(age / size);
        const b = buckets[idx];
        if (!b) continue;
        b.requests += 1;
        b.totalTokens += e.totalTokens || 0;
        b.cost += e.cost || 0;
        if (!e.ok) b.errors += 1;
    }
    return buckets;
}

export function clearUsage() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    const state = blankState();
    writeState(state);
    recent = [];
    return state;
}

/** Display-safe key metadata. Never returns the key itself. */
export function getKeyInfo(profile = '') {
    const resolved = resolveConnection({ apiProfile: profile });
    const conn = resolved?.connection || {};
    const key = conn.apiKey || '';
    const skey = String(key);
    return {
        profile,
        providerHost: providerHost(conn.apiUrl || ''),
        model: conn.model || '',
        hasKey: !!key,
        keyFingerprint: fingerprintKey(key),
        masked: key ? (skey.length > 12 ? `${skey.slice(0, 4)}…${skey.slice(-4)}` : '••••') : '',
        profileLabel: resolved?.profileName || '',
    };
}

// ────── Provider quota adapters ──────

function originOf(apiUrl) {
    try {
        const u = new URL(String(apiUrl || ''));
        return `${u.protocol}//${u.host}`;
    } catch { return ''; }
}

async function fetchQuotaJson(url, headers, signal) {
    const attempts = [url, `/proxy/${url}`];
    let last = null;
    for (const target of attempts) {
        try {
            const res = await fetch(target, { method: 'GET', headers, signal });
            if (!res.ok) { last = new Error(`HTTP ${res.status}`); continue; }
            return await res.json();
        } catch (e) { last = e; }
    }
    throw last || new Error('Quota request failed');
}

function quotaWindow(kind, { limit = null, remaining = null, used = null, resetAt = null, windowSeconds = null, valueLabel = '', source = 'provider', confidence = 'high' }) {
    return withDerived({
        kind,
        limit: num(limit),
        remaining: num(remaining),
        used: num(used),
        resetAt: num(resetAt),
        windowSeconds: num(windowSeconds),
        source,
        confidence,
        family: 'quota',
        valueLabel: str(valueLabel, 48),
    });
}

/** OpenRouter: /api/v1/key + /api/v1/credits (credits need a different base, best effort). */
const openrouterAdapter = {
    id: 'openrouter',
    label: 'OpenRouter',
    detect({ apiUrl }) { return /openrouter\.ai/i.test(String(apiUrl || '')); },
    async fetch({ apiUrl, apiKey }, { signal } = {}) {
        const base = originOf(apiUrl);
        const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
        const out = [];
        let planLabel = '';
        try {
            const key = await fetchQuotaJson(`${base}/api/v1/key`, headers, signal);
            const d = key?.data || key || {};
            planLabel = d.is_free_tier ? 'free tier' : (d.label || '');
            const resetAt = d.limit_reset ? resetSeconds(d.limit_reset) : null;
            if (Number.isFinite(Number(d.limit)) && Number.isFinite(Number(d.limit_remaining))) {
                out.push(quotaWindow('credits', {
                    limit: Number(d.limit), remaining: Number(d.limit_remaining),
                    used: Number(d.usage), resetAt, windowSeconds: resetAt ? Math.round((resetAt - Date.now()) / 1000) : null,
                    valueLabel: '$',
                }));
            } else if (Number.isFinite(Number(d.usage))) {
                out.push(quotaWindow('credits', { used: Number(d.usage), valueLabel: '$' }));
            }
            const rl = d.rate_limit;
            if (rl && Number.isFinite(Number(rl.requests))) {
                out.push(quotaWindow('requests', { limit: Number(rl.requests), windowSeconds: Number(rl.interval) || null }));
            }
        } catch { /* key endpoint unavailable */ }
        return { windows: out, planLabel, raw: null };
    },
};

function resetSeconds(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1e9 ? n * 1000 : Date.now() + n * 1000;
    return resetToMs(v);
}

/** DeepSeek: /user/balance. */
const deepseekAdapter = {
    id: 'deepseek',
    label: 'DeepSeek',
    detect({ apiUrl }) { return /deepseek\.com/i.test(String(apiUrl || '')); },
    async fetch({ apiUrl, apiKey }, { signal } = {}) {
        const base = originOf(apiUrl);
        const data = await fetchQuotaJson(`${base}/user/balance`, { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal);
        const balances = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
        const b = balances[0] || {};
        const total = num(b.total_balance);
        return {
            planLabel: data?.is_available === false ? 'unavailable' : '',
            windows: total === null ? [] : [quotaWindow('credits', { remaining: total, valueLabel: String(b.currency || '') })],
            raw: null,
        };
    },
};

/** OpenCode Go: /zen/go/v1/usage. */
const opencodeGoAdapter = {
    id: 'opencode-go',
    label: 'OpenCode Go',
    detect({ apiUrl }) { return /opencode\.ai/i.test(String(apiUrl || '')) && /\/zen\//i.test(String(apiUrl || '')); },
    async fetch({ apiUrl, apiKey }, { signal } = {}) {
        const base = originOf(apiUrl);
        const data = await fetchQuotaJson(`${base}/zen/go/v1/usage`, { Authorization: `Bearer ${apiKey}` }, signal);
        const out = [];
        const planLabel = data?.plan || data?.plan_label || '';
        const windows = data?.windows || data?.usage || data?.limits;
        if (Array.isArray(windows)) {
            for (const w of windows.slice(0, 8)) {
                out.push(quotaWindow(w.kind || w.type || 'requests', {
                    limit: w.limit, remaining: w.remaining, used: w.used,
                    resetAt: resetSeconds(w.reset_at ?? w.resetAt ?? w.resets_at),
                    windowSeconds: w.window_seconds ?? w.windowSeconds,
                    valueLabel: w.value_label || w.unit || '',
                }));
            }
        } else if (data && typeof data === 'object') {
            if (Number.isFinite(Number(data.remaining)) || Number.isFinite(Number(data.limit))) {
                out.push(quotaWindow('requests', {
                    limit: data.limit, remaining: data.remaining, used: data.used,
                    resetAt: resetSeconds(data.reset_at ?? data.resets_at),
                    windowSeconds: data.window_seconds,
                }));
            }
        }
        return { windows: out, planLabel, raw: null };
    },
};

for (const a of [openrouterAdapter, deepseekAdapter, opencodeGoAdapter]) quotaProviders.set(a.id, a);

export function registerQuotaProvider(id, adapter) {
    const key = str(id, 48);
    if (!key || !adapter || typeof adapter.fetch !== 'function') {
        throw new TypeError('registerQuotaProvider requires an id and an adapter with fetch(profile).');
    }
    quotaProviders.set(key, { id: key, label: str(adapter.label, 48) || key, detect: adapter.detect, fetch: adapter.fetch });
    return key;
}

export function listQuotaProviders() {
    return [...quotaProviders.values()].map((p) => ({ id: p.id, label: p.label }));
}

/**
 * Refresh provider-reported quota for a profile (or the default profile).
 * Header-derived limits are always available; this adds provider balance /
 * plan windows when the provider exposes an endpoint.
 */
export async function refreshQuota(profile = '', opts = {}) {
    const resolved = resolveConnection({ apiProfile: profile });
    const conn = resolved?.connection || {};
    const apiUrl = conn.apiUrl || '';
    const apiKey = conn.apiKey || '';
    if (!apiUrl) throw new Error('Quota refresh requires an API URL (ST-backend route has no quota endpoint).');
    const adapter = [...quotaProviders.values()].find((p) => {
        try { return typeof p.detect === 'function' ? p.detect({ apiUrl, apiKey, profile }) : false; } catch { return false; }
    });
    if (!adapter) throw new Error(`No quota provider adapter for ${providerHost(apiUrl) || apiUrl}.`);
    const result = await adapter.fetch({ apiUrl, apiKey, profile }, { signal: opts.signal });
    const state = getState();
    const scope = {
        profile: resolved?.profileName || profile || '',
        providerHost: providerHost(apiUrl),
        model: conn.model || '',
        keyFingerprint: fingerprintKey(apiKey),
    };
    for (const w of (result?.windows || [])) addWindowToState(state, scope, sanitizeWindow({ ...w, family: adapter.id }));
    const entry = state.limits[scopeKey(scope)];
    if (entry) entry.planLabel = str(result?.planLabel, 80);
    writeState(state);
    const snapshot = getUsageSnapshot({ profile: scope.profile });
    emit({ kind: 'quota', provider: adapter.id, profile: scope.profile, snapshot });
    return { provider: adapter.id, ...scope, planLabel: result?.planLabel || '', windows: (entry?.windows || []).map(withDerived) };
}
