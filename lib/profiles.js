import { HubError } from './util.js';

/**
 * Named API connection profiles.
 *
 * A profile is { id, name, apiUrl, apiKey, model, userAgent?, sessionId?,
 * extraHeaders? } stored in the hub's own extension settings (plaintext,
 * same caveat as every ST-stored key). Requests reference profiles BY NAME
 * ONLY — secrets are resolved inside the hub at send time and never cross
 * the request boundary, appear in responses/traces/logs, or leave via
 * listApiProfiles().
 */

function readProfiles() {
    try {
        const s = SillyTavern.getContext().extensionSettings?.['ST-RequestHub'] ?? {};
        const list = Array.isArray(s.apiProfiles) ? s.apiProfiles : [];
        return { list, defaultName: String(s.defaultApiProfile ?? '') };
    } catch {
        return { list: [], defaultName: '' };
    }
}

function cleanStr(v) {
    return (v === null || v === undefined) ? '' : String(v);
}

function cleanHeaders(v) {
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

/**
 * Resolve the effective connection for one request.
 * Precedence per field: explicit JSON > named profile > default profile > ''.
 * Harness identity (userAgent/sessionId) follows the same per-field chain;
 * extraHeaders MERGE per key with the same precedence (explicit keys win).
 * @param {{apiProfile?:string, connection?:{apiUrl?,apiKey?,model?}, harness?:{userAgent?,sessionId?}, extraHeaders?:object}} opts
 * @returns {{connection:{apiUrl,apiKey,model}, harness:{userAgent,sessionId}, extraHeaders:object, profileName:string, source:string}}
 * @throws {HubError} INVALID_REQUEST on unknown profile name.
 */
export function resolveConnection({ apiProfile = '', connection = {}, harness = {}, extraHeaders = {} } = {}) {
    const { list, defaultName } = readProfiles();
    const byName = new Map(list.filter((p) => p && typeof p.name === 'string' && p.name).map((p) => [p.name, p]));

    const wanted = cleanStr(apiProfile);
    let named = null;
    if (wanted) {
        named = byName.get(wanted) ?? null;
        if (!named) {
            const avail = [...byName.keys()];
            throw new HubError(
                `Unknown apiProfile "${wanted}".${avail.length ? ` Available: ${avail.join(', ')}` : ' No profiles saved yet.'}`,
                'INVALID_REQUEST',
                { details: [`Unknown apiProfile "${wanted}".`] },
            );
        }
    }
    const def = (!named && defaultName ? byName.get(defaultName) ?? null : null);

    const pick = (key) => {
        const explicit = cleanStr(connection?.[key]);
        if (explicit) return explicit;
        if (named && cleanStr(named[key])) return cleanStr(named[key]);
        if (def && cleanStr(def[key])) return cleanStr(def[key]);
        return '';
    };
    // apiKey is secret: explicit key travels in the request object, profile
    // keys never leave hub memory except into the outbound fetch headers.
    const explicitKey = connection?.apiKey === null || connection?.apiKey === undefined ? '' : String(connection.apiKey);
    const key = explicitKey || (named ? cleanStr(named.apiKey) : '') || (def ? cleanStr(def.apiKey) : '');

    const resolved = { apiUrl: pick('apiUrl'), apiKey: key, model: pick('model') };
    const profileName = named ? named.name : (def && (def.apiUrl || def.apiKey || def.model) ? def.name : '');
    const source = named
        ? `profile:${named.name}`
        : (profileName ? `default-profile:${profileName}` : (resolved.apiUrl ? 'explicit' : 'st-backend'));
    // Harness identity rides the same profile chain (explicit wins per field).
    const pickHarness = (reqKey, profKey) => {
        const explicit = cleanStr(harness?.[reqKey]);
        if (explicit) return explicit;
        if (named && cleanStr(named[profKey])) return cleanStr(named[profKey]);
        if (def && cleanStr(def[profKey])) return cleanStr(def[profKey]);
        return '';
    };
    const resolvedHarness = {
        userAgent: pickHarness('userAgent', 'userAgent'),
        sessionId: pickHarness('sessionId', 'sessionId'),
    };
    // Extra headers merge per key: explicit > named > default.
    const mergedExtra = {
        ...cleanHeaders(def?.extraHeaders),
        ...cleanHeaders(named?.extraHeaders),
        ...cleanHeaders(extraHeaders),
    };
    return { connection: resolved, harness: resolvedHarness, extraHeaders: mergedExtra, profileName, source };
}

/**
 * List saved profiles — metadata ONLY, never secrets. Safe for any consumer
 * UI (dropdowns) and for logging.
 */
export function listApiProfiles() {
    const { list, defaultName } = readProfiles();
    return list
        .filter((p) => p && typeof p.name === 'string' && p.name)
        .map((p) => ({
            name: p.name,
            apiUrl: cleanStr(p.apiUrl),
            model: cleanStr(p.model),
            hasKey: !!cleanStr(p.apiKey),
            userAgent: cleanStr(p.userAgent),
            hasSession: !!cleanStr(p.sessionId),
            extraHeaderKeys: Object.keys(cleanHeaders(p.extraHeaders)),
            isDefault: p.name === defaultName,
        }));
}
