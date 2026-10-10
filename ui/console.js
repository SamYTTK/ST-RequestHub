import { Popup, POPUP_TYPE } from '../../../../popup.js';

const MODULE_NAME = 'ST-RequestHub';
const EXT_PATH = 'third-party/ST-RequestHub';
const REFRESH_MS = 1500;

let openPromise = null;

function ctx() {
    return SillyTavern.getContext();
}

function hub() {
    return globalThis.STRequestHub;
}

function loadSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = {};
    }
    const s = extensionSettings[MODULE_NAME];
    if (!Array.isArray(s.apiProfiles)) s.apiProfiles = [];
    return s;
}

const esc = (v) => String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
    const d = new Date(Number(ts) || 0);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtDate(ts) {
    const d = new Date(Number(ts) || 0);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtMs(ms) {
    const v = Math.round(Number(ms) || 0);
    if (v < 1000) return `${v}ms`;
    return `${(v / 1000).toFixed(1)}s`;
}

/** Dot-bar row: label, value, fraction of max. Pure CSS, no libs. */
function barRow(label, value, frac) {
    const pct = Math.max(2, Math.min(100, Math.round(frac * 100)));
    return `<div class="strh-meter"><span class="strh-meter-label">${esc(label)}</span>`
        + `<span class="strh-meter-track"><span class="strh-meter-fill" style="width:${pct}%"></span></span>`
        + `<span class="strh-meter-value">${esc(value)}</span></div>`;
}

function breakdown(map, fmtVal = (v) => String(v)) {
    const entries = Object.entries(map ?? {});
    if (!entries.length) return '<div class="strh-empty">— no data yet —</div>';
    const max = Math.max(...entries.map(([, v]) => Number(v) || 0), 1);
    return entries
        .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
        .slice(0, 8)
        .map(([k, v]) => barRow(k || '(none)', fmtVal(v), (Number(v) || 0) / max))
        .join('');
}

function renderOverview(root) {
    const h = hub();
    if (!h) return;
    const stats = h.getUsageStats();
    const s = loadSettings();
    const profiles = (s.apiProfiles ?? []).filter((p) => p && p.name);
    const presets = h.listPresets();

    const statusEl = root.querySelector('#strh-ov-status');
    if (statusEl) {
        statusEl.innerHTML = `<div class="strh-big">${esc(String(stats.requests))}</div>`
            + `<div class="strh-dim">TOTAL REQUESTS · SINCE ${esc(fmtDate(stats.startedAt))}</div>`
            + `<div class="strh-kv"><span>VERSION</span><b>v${esc(h.version)}</b></div>`
            + `<div class="strh-kv"><span>API</span><b>v${esc(String(h.apiVersion))}</b></div>`
            + `<div class="strh-kv"><span>PROFILES</span><b>${profiles.length}</b></div>`
            + `<div class="strh-kv"><span>PRESETS</span><b>${presets.length}</b></div>`
            + `<div class="strh-kv"><span>DEFAULT</span><b>${esc(s.defaultApiProfile || '(ST backend)')}</b></div>`;
    }
    const trafficEl = root.querySelector('#strh-ov-traffic');
    if (trafficEl) {
        const okCount = stats.requests - stats.errors;
        const errPct = stats.requests > 0 ? Math.round((stats.errors / stats.requests) * 100) : 0;
        trafficEl.innerHTML = `<div class="strh-big">${esc(String(okCount))}<span class="strh-dim"> / ${esc(String(stats.requests))}</span></div>`
            + `<div class="strh-dim">SUCCEEDED / TOTAL</div>`
            + barRow('errors', `${stats.errors} (${errPct}%)`, stats.requests > 0 ? stats.errors / stats.requests : 0)
            + breakdown(stats.byError);
    }
    const latencyEl = root.querySelector('#strh-ov-latency');
    if (latencyEl) {
        const last = h.getRecentRequests(20).slice().reverse();
        const max = Math.max(...last.map((e) => e.durationMs || 0), 1);
        const dots = last.length
            ? `<div class="strh-spark">${last.map((e) => `<span class="strh-spark-dot" style="opacity:${(0.25 + 0.75 * ((e.durationMs || 0) / max)).toFixed(2)}" title="${esc(fmtTime(e.tsStart))} · ${esc(fmtMs(e.durationMs))}"></span>`).join('')}</div>`
            : '<div class="strh-empty">— no data yet —</div>';
        latencyEl.innerHTML = `<div class="strh-big">${esc(fmtMs(stats.avgMs))}</div>`
            + `<div class="strh-dim">AVG PER REQUEST</div>${dots}`;
    }
    const modesEl = root.querySelector('#strh-ov-modes');
    if (modesEl) modesEl.innerHTML = breakdown(stats.byMode);
    const consumersEl = root.querySelector('#strh-ov-consumers');
    if (consumersEl) consumersEl.innerHTML = breakdown(stats.byConsumer);
    const profilesEl = root.querySelector('#strh-ov-profiles');
    if (profilesEl) profilesEl.innerHTML = breakdown(stats.byProfile);

    const recentEl = root.querySelector('#strh-ov-recent');
    if (recentEl) {
        const rows = h.getRecentRequests(20);
        recentEl.innerHTML = rows.length
            ? `<table class="strh-table"><thead><tr><th>TIME</th><th>CONSUMER</th><th>MODE</th><th>MODEL / PROFILE</th><th>MS</th><th>STATUS</th></tr></thead>`
            + `<tbody>${rows.map((e) => `<tr><td class="strh-num">${esc(fmtTime(e.tsStart))}</td>`
                + `<td>${esc(e.consumer || '—')}</td><td>${esc(e.mode || '—')}</td>`
                + `<td>${esc(e.model || '—')}${e.profile ? ` <span class="strh-dim">· ${esc(e.profile)}</span>` : ''}</td>`
                + `<td class="strh-num">${esc(fmtMs(e.durationMs))}</td>`
                + `<td>${e.ok ? '<span class="strh-ok">● OK</span>' : `<span class="strh-err">● ${esc(e.errorCode || 'ERR')}</span>`}</td>`
                + `</tr>`).join('')}</tbody></table>`
            : '<div class="strh-empty">— no requests this session —</div>';
    }
    const verEl = root.querySelector('#strh-con-version');
    if (verEl) verEl.textContent = `v${h.version} · api v${h.apiVersion}`;
}

/** Decide-ping heuristic: Laya-style models/endpoints answer /v1/systemone, not chat. */
function isDecideProfile(p) {
    const model = String(p?.model ?? '').toLowerCase();
    const url = String(p?.apiUrl ?? '').toLowerCase();
    return model.startsWith('laya') || url.includes('systemone') || url.includes('11435');
}

function renderProfiles(root) {
    const h = hub();
    const s = loadSettings();
    const list = root.querySelector('#strh-pf-list');
    const sel = root.querySelector('#strh-pf-default');
    const profiles = (s.apiProfiles ?? []).filter((p) => p && p.name);
    if (sel) {
        const cur = s.defaultApiProfile ?? '';
        sel.innerHTML = `<option value="">(none — ST backend)</option>` + profiles
            .map((p) => `<option value="${esc(p.name)}"${p.name === cur ? ' selected' : ''}>${esc(p.name)}</option>`)
            .join('');
    }
    if (!list) return;
    list.innerHTML = '';
    if (!profiles.length) {
        list.innerHTML = '<div class="strh-empty">— no profiles yet — add one below —</div>';
    }
    profiles.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'strh-pf-row';
        row.innerHTML = `
            <input data-k="name" placeholder="Profile name" value="${esc(p.name)}">
            <input data-k="apiUrl" placeholder="Base URL (empty = ST backend)" value="${esc(p.apiUrl)}">
            <input data-k="apiKey" type="password" placeholder="API key" value="${esc(p.apiKey)}" autocomplete="new-password">
            <input data-k="model" placeholder="Default model" value="${esc(p.model)}">
            <span class="strh-pf-flags">${p.apiKey ? '<span class="strh-ok" title="Key stored">●KEY</span>' : '<span class="strh-dim">○KEY</span>'}${isDecideProfile(p) ? '<span class="strh-tag">DECIDE</span>' : '<span class="strh-tag">CHAT</span>'}</span>
            <button class="strh-btn strh-btn--sm strh-pf-test">TEST</button>
            <button class="strh-btn strh-btn--sm strh-btn--danger strh-pf-del" title="Delete profile">✕</button>`;
        row.querySelectorAll('input').forEach((inp) => {
            inp.addEventListener('change', () => {
                p[inp.dataset.k] = inp.value;
                ctx().saveSettingsDebounced();
                renderProfiles(root);
                renderOverview(root);
            });
        });
        row.querySelector('.strh-pf-del')?.addEventListener('click', () => {
            s.apiProfiles = (s.apiProfiles ?? []).filter((x) => x !== p);
            if (s.defaultApiProfile === p.name) s.defaultApiProfile = '';
            ctx().saveSettingsDebounced();
            renderProfiles(root);
            renderOverview(root);
        });
        row.querySelector('.strh-pf-test')?.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            const status = root.querySelector('#strh-pf-status');
            btn.disabled = true;
            try {
                const conn = { apiUrl: p.apiUrl ?? '', apiKey: p.apiKey ?? '', model: p.model ?? '' };
                const res = isDecideProfile(p)
                    ? await h.testDecideConnection(conn)
                    : await h.testConnection(conn);
                if (status) {
                    status.innerHTML = `<span class="${res.success ? 'strh-ok' : 'strh-err'}">●</span> ${esc(p.name)} — ${esc(res.message)}`;
                }
            } catch (e) {
                if (status) status.innerHTML = `<span class="strh-err">●</span> ${esc(p.name)} — ${esc(e?.message ?? e)}`;
            } finally {
                btn.disabled = false;
            }
        });
        list.appendChild(row);
    });
}

function bindProfiles(root) {
    const s = loadSettings();
    root.querySelector('#strh-pf-add')?.addEventListener('click', () => {
        const name = root.querySelector('#strh-pf-name')?.value?.trim() || `profile-${(s.apiProfiles ?? []).length + 1}`;
        if ((s.apiProfiles ?? []).some((p) => p?.name === name)) {
            const status = root.querySelector('#strh-pf-status');
            if (status) status.innerHTML = `<span class="strh-err">●</span> A profile named ${esc(name)} already exists.`;
            return;
        }
        (s.apiProfiles ??= []).push({
            name,
            apiUrl: root.querySelector('#strh-pf-url')?.value?.trim() ?? '',
            apiKey: root.querySelector('#strh-pf-key')?.value ?? '',
            model: root.querySelector('#strh-pf-model')?.value?.trim() ?? '',
        });
        for (const id of ['#strh-pf-name', '#strh-pf-url', '#strh-pf-key', '#strh-pf-model']) {
            const el = root.querySelector(id);
            if (el) el.value = '';
        }
        ctx().saveSettingsDebounced();
        renderProfiles(root);
        renderOverview(root);
    });
    root.querySelector('#strh-pf-default')?.addEventListener('change', (e) => {
        s.defaultApiProfile = e.target.value;
        ctx().saveSettingsDebounced();
        renderOverview(root);
    });
}

function bindSettings(root) {
    const s = loadSettings();
    const bindNum = (id, key) => {
        const el = root.querySelector(id);
        if (!el) return;
        el.value = s[key];
        el.addEventListener('change', () => {
            s[key] = Number(el.value) || 0;
            ctx().saveSettingsDebounced();
        });
    };
    bindNum('#strh-set-timeout', 'defaultTimeoutMs');
    bindNum('#strh-set-retries', 'defaultRetries');
    bindNum('#strh-set-maxsteps', 'defaultMaxSteps');
    bindNum('#strh-set-maxsteps-cap', 'maxStepsCap');
    bindNum('#strh-set-total-timeout', 'defaultTotalTimeoutMs');
    const proxy = root.querySelector('#strh-set-proxy');
    if (proxy) {
        proxy.checked = s.preferProxy !== false;
        proxy.addEventListener('change', () => {
            s.preferProxy = proxy.checked;
            ctx().saveSettingsDebounced();
        });
    }
    root.querySelector('#strh-set-test-presets')?.addEventListener('click', () => {
        const st = root.querySelector('#strh-set-status');
        try {
            const presets = hub().listPresets();
            if (st) st.textContent = presets.length
                ? `Hub ready. ${presets.length} preset(s): ${presets.slice(0, 8).join(', ')}${presets.length > 8 ? '…' : ''}`
                : 'Hub ready. No chat completion presets found.';
        } catch (e) {
            if (st) st.textContent = `Preset check failed: ${e?.message ?? e}`;
        }
    });
}

function bindOverview(root) {
    root.querySelector('#strh-ov-clear')?.addEventListener('click', () => {
        hub().clearUsageStats();
        renderOverview(root);
    });
}

function bindTabs(root) {
    root.querySelectorAll('[data-strh-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.strhTab;
            root.querySelectorAll('[data-strh-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
            root.querySelectorAll('[data-strh-view]').forEach((v) => v.classList.toggle('is-active', v.dataset.strhView === tab));
            if (tab === 'overview') renderOverview(root);
            if (tab === 'profiles') renderProfiles(root);
        });
    });
}

/**
 * Open the hub console popup. Singleton: repeat calls while open reuse it.
 * @returns {Promise<void>} resolves when the console closes
 */
export async function openHubConsole() {
    if (openPromise) return openPromise;
    openPromise = (async () => {
        const html = await ctx().renderExtensionTemplateAsync(EXT_PATH, 'dashboard');
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        const root = wrap.querySelector('.strh-console');
        if (!root) throw new Error('Dashboard template failed to render.');
        const popup = new Popup(root, POPUP_TYPE.DISPLAY, '', {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        });
        bindTabs(root);
        bindOverview(root);
        bindProfiles(root);
        bindSettings(root);
        renderOverview(root);
        renderProfiles(root);
        const timer = setInterval(() => {
            try {
                const ov = root.querySelector('[data-strh-view="overview"]');
                if (ov?.classList.contains('is-active')) renderOverview(root);
            } catch { /* popup gone — cleaned up below */ }
        }, REFRESH_MS);
        try {
            await popup.show();
        } finally {
            clearInterval(timer);
        }
    })();
    try {
        await openPromise;
    } finally {
        openPromise = null;
    }
}
