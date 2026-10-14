import { generate, request, runAgent, decide, validateRequest, listTools, listApiProfiles, listModels, getUsageStats, getRecentRequests, clearUsageStats, hubHelpers, HubError, HUB_DEFAULTS } from './lib/hub.js';
import { ensureHarnessSession, clearHarnessSessions, SESSION_HEADER_DEFAULT } from './lib/harness.js';
import { clearModelsCache } from './lib/models.js';

const MODULE_NAME = 'ST-RequestHub';
const EXT_PATH = 'third-party/ST-RequestHub';
const API_VERSION = 6;
const VERSION = '1.6.1';

const DEFAULTS = HUB_DEFAULTS;

function getContext() {
    return SillyTavern.getContext();
}

function loadHubSettings() {
    const { extensionSettings } = getContext();
    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULTS);
    }
    const s = extensionSettings[MODULE_NAME];
    for (const k of Object.keys(DEFAULTS)) {
        if (!Object.hasOwn(s, k)) s[k] = DEFAULTS[k];
    }
    if (!Array.isArray(s.apiProfiles)) s.apiProfiles = [];
    return s;
}

const listeners = {};
function on(evt, cb) {
    (listeners[evt] ??= []).push(cb);
}
function off(evt, cb) {
    listeners[evt] = (listeners[evt] || []).filter((x) => x !== cb);
}
function emitLocal(evt, data) {
    for (const cb of [...(listeners[evt] || [])]) {
        try { cb(data); } catch (e) { console.warn(`[${MODULE_NAME}] listener failed`, e); }
    }
}

/**
 * Open the hub console (DeerFlow-style dashboard popup). Singleton — a
 * second call while open just focuses the existing popup.
 * @returns {Promise<void>} resolves when the console closes
 */
async function openConsole() {
    const { openHubConsole } = await import('./ui/console.js');
    try {
        await openHubConsole();
    } finally {
        refreshLauncher();
    }
}

function refreshLauncher() {
    try {
        const s = loadHubSettings();
        const profiles = Array.isArray(s.apiProfiles) ? s.apiProfiles.filter((p) => p && p.name) : [];
        const stats = getUsageStats();
        const ver = document.getElementById('strh-launcher-version');
        if (ver) ver.textContent = `v${VERSION} · api v${API_VERSION}`;
        const st = document.getElementById('strh-launcher-status');
        if (st) {
            st.innerHTML = '';
            const dot = document.createElement('span');
            dot.className = 'strh-dot strh-dot--on';
            st.append(dot, document.createTextNode(
                ` ${stats.requests} request${stats.requests === 1 ? '' : 's'} · ${profiles.length} profile${profiles.length === 1 ? '' : 's'}`,
            ));
        }
    } catch { /* launcher not rendered yet — ignore */ }
}

function registerGlobal() {
    const api = Object.freeze({
        name: 'ST-RequestHub',
        version: VERSION,
        apiVersion: API_VERSION,
        capabilities: ['request', 'generate', 'decide', 'agent', 'tools', 'profiles', 'models', 'presets', 'messages', 'worldinfo', 'tokens', 'test', 'stats', 'console', 'harness'],
        isReady: () => {
            try {
                return !getContext().extensionSettings.disabledExtensions.includes('ST-RequestHub');
            } catch {
                return true;
            }
        },
        isAvailable: () => true,
        request,
        generate,
        runAgent,
        decide,
        openConsole,
        getUsageStats,
        getRecentRequests,
        clearUsageStats,
        validateRequest,
        listTools,
        listApiProfiles,
        listModels,
        clearModelsCache,
        listPresets: hubHelpers.listPresets,
        getPresetSamplers: hubHelpers.getPresetSamplers,
        resolveSamplers: hubHelpers.resolveSamplers,
        buildMessages: hubHelpers.buildMessages,
        fetchWorldInfo: hubHelpers.fetchWorldInfo,
        countTokens: hubHelpers.countTokens,
        fitBudget: hubHelpers.fitBudget,
        testConnection: hubHelpers.testConnection,
        testDecideConnection: hubHelpers.testDecideConnection,
        ensureHarnessSession,
        clearHarnessSessions,
        sessionHeaderDefault: SESSION_HEADER_DEFAULT,
        HubError,
        on,
        off,
    });
    if (globalThis.STRequestHub && globalThis.STRequestHub.name === 'ST-RequestHub') {
        console.warn(`[${MODULE_NAME}] global already registered (v${globalThis.STRequestHub.version}) — overwriting`);
    } else if (globalThis.STRequestHub) {
        console.error(`[${MODULE_NAME}] globalThis.STRequestHub collision with foreign object — overwriting`);
    }
    globalThis.STRequestHub = api;
    try {
        getContext().eventSource.emit('hub:ready', { version: VERSION, apiVersion: API_VERSION });
    } catch { /* ignore */ }
    emitLocal('ready', { version: VERSION });
    console.log(`[${MODULE_NAME}] registered globalThis.STRequestHub v${VERSION} (api v${API_VERSION})`);
}

function bindLauncherUI() {
    loadHubSettings();
    document.getElementById('strh-open-console')?.addEventListener('click', () => {
        openConsole().catch((e) => console.warn(`[${MODULE_NAME}] console failed`, e));
    });
    refreshLauncher();
}

async function init() {
    loadHubSettings();
    registerGlobal();
    const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (container && !document.querySelector('.st-request-hub-settings')) {
        try {
            const html = await getContext().renderExtensionTemplateAsync(EXT_PATH, 'settings');
            if (html) container.insertAdjacentHTML('beforeend', html);
        } catch (e) {
            console.warn(`[${MODULE_NAME}] settings template failed`, e);
        }
    }
    bindLauncherUI();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else setTimeout(init, 0);
