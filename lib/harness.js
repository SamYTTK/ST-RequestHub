/**
 * Harness-identity helpers (hub-owned).
 *
 * Some gated APIs (e.g. OpenCode Go) only accept traffic that looks like it
 * comes from a coding harness rather than a generic HTTP client. Such
 * endpoints are still OpenAI-compatible on the wire — what they additionally
 * require is harness identity carried in headers:
 *
 *   1. a stable per-conversation session id
 *      (`x-opencode-session` on Go; other harnesses use their own names,
 *      which is why the header name is configurable per request), and
 *   2. a distinctive `User-Agent` (e.g. `my-coding-agent/1.0`) instead of a
 *      generic SDK / HTTP-library name.
 *
 * Browser limits (honest, read before debugging):
 * - `fetch` in the browser CANNOT set `User-Agent` — it is a forbidden
 *   header and is silently dropped. The hub still attempts it (harmless;
 *   works in Node-side contexts) and additionally sends the configured
 *   value as `x-harness-user-agent` so logs/proxies can see intent.
 * - Custom `x-*` headers (including `x-opencode-session`) ARE settable from
 *   the browser and ARE forwarded upstream by ST's `/proxy/` CORS proxy
 *   (it forwards every header except its small blocklist, which covers
 *   neither `user-agent` nor `x-*`). Harness requests therefore prefer the
 *   proxy route (see lib/direct.js) — the session header is the operative
 *   signal, and a browser UA (`Mozilla/…`) is already a distinctive,
 *   non-SDK identity.
 *
 * Session-id discipline (abuse monitoring exists on these APIs):
 * - One stable id per conversation (default scope `chat`: consumer+chat).
 *   Reuse it for every request/round in that conversation so upstream
 *   routing + prompt caching work; never mint per request.
 * - Agent runs resolve ONE id before step 1 and reuse it for all steps.
 */

export const SESSION_HEADER_DEFAULT = 'x-opencode-session';
export const USER_AGENT_ALIAS = 'x-harness-user-agent';
export const DEFAULT_USER_AGENT = 'ST-RequestHub';
export const HARNESS_SCOPES = Object.freeze(['chat', 'consumer', 'global', 'none']);

/** Headers a caller must never override (auth/c framing stay hub-owned). */
const PROTECTED_HEADERS = new Set([
    'authorization', 'content-type', 'content-length', 'host',
    'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
    'cookie', 'origin', 'referer', 'sec-fetch-mode', 'sec-fetch-site',
    'sec-fetch-dest', 'x-csrf-token',
]);

const MAX_HEADERS = 16;

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function cleanStr(v, max = 512) {
    if (v === null || v === undefined) return '';
    const s = String(v).trim();
    return s.length > max ? s.slice(0, max) : s;
}

/**
 * Keep only safe string headers. Returns { headers, dropped[] }.
 * Comparison is case-insensitive; the caller's original key casing is kept.
 */
export function sanitizeExtraHeaders(raw) {
    const headers = {};
    const dropped = [];
    if (!isPlainObject(raw)) return { headers, dropped };
    for (const [k, v] of Object.entries(raw)) {
        if (Object.keys(headers).length >= MAX_HEADERS) {
            dropped.push(String(k));
            continue;
        }
        const name = cleanStr(k, 128);
        if (!name || !/^[A-Za-z0-9-]+$/.test(name)) {
            dropped.push(String(k));
            continue;
        }
        if (PROTECTED_HEADERS.has(name.toLowerCase())) {
            dropped.push(String(k));
            continue;
        }
        if (typeof v !== 'string') {
            dropped.push(String(k));
            continue;
        }
        const value = v.trim();
        if (!value || value.length > 2048 || /[\r\n]/.test(value)) {
            dropped.push(String(k));
            continue;
        }
        headers[name] = value;
    }
    return { headers, dropped };
}

/**
 * Normalize the per-request `settings.harness` block (no persistence here —
 * auto session ids are resolved at send time so validateRequest() stays
 * side-effect free).
 * @returns {{ userAgent, sessionId, sessionScope, sessionHeader, sendSessionHeader }}
 */
export function normalizeHarness(raw, errors = []) {
    const h = isPlainObject(raw) ? raw : {};
    if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
        errors.push('settings.harness must be an object.');
    }
    let scope = cleanStr(h.sessionScope || h.scope, 64).toLowerCase();
    if (!scope) scope = '';
    else if (scope.startsWith('custom:')) scope = `custom:${cleanStr(scope.slice(7), 128)}`;
    else if (!HARNESS_SCOPES.includes(scope)) {
        errors.push(`settings.harness.sessionScope must be one of ${HARNESS_SCOPES.join(', ')} or "custom:<key>".`);
        scope = '';
    }
    const sessionHeader = cleanStr(h.sessionHeader, 128) || SESSION_HEADER_DEFAULT;
    if (sessionHeader && !/^[A-Za-z0-9-]+$/.test(sessionHeader)) {
        errors.push('settings.harness.sessionHeader must be a valid header name.');
    }
    return {
        userAgent: cleanStr(h.userAgent, 128),
        sessionId: cleanStr(h.sessionId, 128),
        sessionScope: scope, // '' = hub default ('chat')
        sessionHeader: /^[A-Za-z0-9-]+$/.test(sessionHeader) ? sessionHeader : SESSION_HEADER_DEFAULT,
        sendSessionHeader: h.sendSessionHeader !== false,
    };
}

function hubSettings() {
    try {
        return SillyTavern.getContext().extensionSettings?.['ST-RequestHub'] ?? {};
    } catch {
        return {};
    }
}

function saveHubSettingsSoon() {
    try {
        SillyTavern.getContext()?.saveSettingsDebounced?.();
    } catch { /* ignore */ }
}

function currentChatId() {
    try {
        const c = SillyTavern.getContext();
        const id = c?.chatId ?? c?.activeChatId ?? c?.chat?.chatId ?? '';
        return String(id || '').trim() || 'no-chat';
    } catch {
        return 'no-chat';
    }
}

function randomId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch { /* ignore */ }
    return `harness-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Stable session-id store: key → id, persisted in hub settings.
 * Key derivation: explicit key > custom scope > consumer/chat/global scope.
 */
export function ensureHarnessSession({ consumer = '', scope = '', key = '', sessionId = '' } = {}) {
    const explicit = cleanStr(sessionId, 128);
    if (explicit) return explicit;
    const rawKey = cleanStr(key, 192);
    const sc = (cleanStr(scope, 192) || (rawKey ? rawKey : '') || 'chat').toLowerCase();
    let mapKey = '';
    if (rawKey && !rawKey.toLowerCase().startsWith('custom:')) {
        mapKey = rawKey;
    } else if (sc.startsWith('custom:')) {
        mapKey = `custom:${cleanStr(sc.slice(7), 128)}`;
    } else if (sc === 'consumer') {
        mapKey = `consumer:${cleanStr(consumer, 128) || 'hub'}`;
    } else if (sc === 'global') {
        mapKey = 'global';
    } else if (sc === 'none') {
        return '';
    } else {
        // 'chat' (default): one id per consumer per chat.
        mapKey = `chat:${cleanStr(consumer, 128) || 'hub'}::${currentChatId()}`;
    }
    const s = hubSettings();
    if (!isPlainObject(s.harnessSessions)) s.harnessSessions = {};
    if (typeof s.harnessSessions[mapKey] !== 'string' || !s.harnessSessions[mapKey]) {
        s.harnessSessions[mapKey] = randomId();
        saveHubSettingsSoon();
    }
    return s.harnessSessions[mapKey];
}

/**
 * Resolve the effective harness for one send: explicit sessionId wins,
 * otherwise (scope !== 'none') a stable stored id is ensured. Never throws.
 */
export function resolveEffectiveHarness(harness = {}, { consumer = '' } = {}) {
    const h = isPlainObject(harness) ? harness : {};
    const s = hubSettings();
    const userAgent = cleanStr(h.userAgent, 128)
        || cleanStr(s.harnessUserAgent, 128)
        || DEFAULT_USER_AGENT;
    const scope = cleanStr(h.sessionScope, 192).toLowerCase() || cleanStr(s.defaultSessionScope, 64).toLowerCase() || 'chat';
    let sessionId = cleanStr(h.sessionId, 128);
    if (!sessionId && scope !== 'none' && h.sendSessionHeader !== false) {
        try {
            sessionId = ensureHarnessSession({ consumer, scope });
        } catch {
            sessionId = '';
        }
    }
    return {
        userAgent,
        sessionId,
        sessionScope: scope,
        sessionHeader: cleanStr(h.sessionHeader, 128) || SESSION_HEADER_DEFAULT,
        sendSessionHeader: h.sendSessionHeader !== false,
    };
}

/**
 * Build the outbound header set: base + harness identity + explicit extras.
 * Precedence: explicit extraHeaders > harness-derived > base.
 * @returns {{ headers:object, warnings:string[] }}
 */
export function buildHarnessHeaders({ apiKey = '', harness = {}, extraHeaders = {} } = {}) {
    const warnings = [];
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const h = isPlainObject(harness) ? harness : {};
    if (h.userAgent) {
        // No-op in browsers (forbidden header, silently dropped) but
        // effective in any Node-side forward. Always also send the alias.
        headers['User-Agent'] = h.userAgent;
        headers[USER_AGENT_ALIAS] = h.userAgent;
    }
    if (h.sendSessionHeader !== false && h.sessionId) {
        const name = /^[A-Za-z0-9-]+$/.test(h.sessionHeader || '') ? h.sessionHeader : SESSION_HEADER_DEFAULT;
        headers[name] = h.sessionId;
    }
    const { headers: extra, dropped } = sanitizeExtraHeaders(extraHeaders);
    for (const d of dropped) warnings.push(`Dropped unsafe extra header "${d}".`);
    return { headers: { ...headers, ...extra }, warnings };
}

/** Forget stored session ids (key prefix match; empty prefix clears all). */
export function clearHarnessSessions(prefix = '') {
    const s = hubSettings();
    if (!isPlainObject(s.harnessSessions)) {
        s.harnessSessions = {};
        return 0;
    }
    const p = String(prefix || '');
    let n = 0;
    for (const k of Object.keys(s.harnessSessions)) {
        if (!p || k.startsWith(p)) {
            delete s.harnessSessions[k];
            n++;
        }
    }
    if (n) saveHubSettingsSoon();
    return n;
}
