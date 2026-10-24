import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchModels, clearModelsCache, filterModelsByAllowList } from '../lib/models.js';
import { listModels } from '../lib/hub.js';
import { listApiProfiles } from '../lib/profiles.js';
import { parseRequest, validateRequest } from '../lib/request.js';

const CATALOG_A = {
    object: 'list',
    data: [
        { id: 'kimi-k2.6', name: 'Kimi K2.6', metadata: { supported_reasoning_efforts: ['low', 'high'] } },
        { id: 'glm-5.3', name: 'GLM 5.3' },
        { id: 'grok-4', name: 'Grok 4' },
    ],
};

const CATALOG_B = {
    object: 'list',
    data: [
        { id: 'secret-model', name: 'Secret model' },
    ],
};

function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        const payload = await handler(url, init);
        return {
            ok: true,
            status: 200,
            json: async () => payload,
            text: async () => JSON.stringify(payload),
        };
    };
    return calls;
}

function stubContext(settings = {}) {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { 'ST-RequestHub': settings },
            saveSettingsDebounced() {},
        }),
    };
}

beforeEach(() => {
    stubContext({});
    clearModelsCache();
});

describe('per-profile model allow-list', () => {
    it('keeps only the allowed ids and matches case-insensitively', async () => {
        stubFetch(() => CATALOG_A);
        const { models } = await fetchModels({
            apiUrl: 'https://api.example.com/v1',
            allowedModels: ['KIMI-K2.6', 'grok-4'],
            refresh: true,
        });
        assert.deepEqual(models.map((m) => m.id), ['kimi-k2.6', 'grok-4']);
        // The original entry survives the filter (metadata + variants intact).
        const kimi = models.find((m) => m.id === 'kimi-k2.6');
        assert.equal(kimi.name, 'Kimi K2.6');
        assert.deepEqual(kimi.variants, [{ id: 'low' }, { id: 'high' }]);
    });

    it('offers everything when the allow-list is empty', async () => {
        stubFetch(() => CATALOG_A);
        const { models } = await fetchModels({ apiUrl: 'https://api.example.com/v1', allowedModels: [], refresh: true });
        assert.equal(models.length, CATALOG_A.data.length);
    });

    it('filters per request without poisoning the shared cache', async () => {
        stubFetch(() => CATALOG_A);
        const wide = await fetchModels({ apiUrl: 'https://api.example.com/v1', refresh: true });
        assert.equal(wide.models.length, 3);
        const narrow = await fetchModels({ apiUrl: 'https://api.example.com/v1', allowedModels: ['glm-5.3'] });
        assert.equal(narrow.cached, true, 'the narrow read comes from the cache');
        assert.deepEqual(narrow.models.map((m) => m.id), ['glm-5.3']);
        const wideAgain = await fetchModels({ apiUrl: 'https://api.example.com/v1' });
        assert.equal(wideAgain.models.length, 3, 'the cached catalog stays unfiltered');
    });

    it('filterModelsByAllowList is a no-op for an empty list', () => {
        const models = [{ id: 'a' }, { id: 'b' }];
        assert.deepEqual(filterModelsByAllowList(models, []), models);
        assert.deepEqual(filterModelsByAllowList(models, ['B']).map((m) => m.id), ['b']);
    });
});

describe('explicit catalog endpoint', () => {
    it('uses modelsEndpoint verbatim instead of the derived URL', async () => {
        const calls = stubFetch(() => CATALOG_A);
        const out = await fetchModels({
            apiUrl: 'https://api.example.com/v1',
            modelsEndpoint: 'http://127.0.0.1:11434/v1/models',
            refresh: true,
        });
        assert.equal(out.url, 'http://127.0.0.1:11434/v1/models');
        assert.ok(calls.some((c) => String(c.url).includes('127.0.0.1:11434/v1/models')));
        assert.ok(!calls.some((c) => String(c.url).includes('api.example.com')));
    });

    it('takes the allow-list and the catalog URL from the named profile', async () => {
        stubContext({
            apiProfiles: [{
                name: 'laya-local',
                apiUrl: 'http://127.0.0.1:11434',
                apiKey: 'key-laya',
                model: 'laya:en',
                allowedModels: ['laya:en', 'laya:de'],
                modelsEndpoint: 'http://127.0.0.1:11434/v1/models',
            }],
        });
        stubFetch(() => ({ data: [{ id: 'laya:en' }, { id: 'laya:de' }, { id: 'other' }] }));
        const out = await listModels({ apiProfile: 'laya-local', refresh: true });
        assert.deepEqual(out.models.map((m) => m.id), ['laya:en', 'laya:de']);
        assert.equal(out.url, 'http://127.0.0.1:11434/v1/models');
        assert.equal(out.profile, 'laya-local');
    });

    it('exposes the new fields in the profile metadata (never keys)', async () => {
        stubContext({
            apiProfiles: [{
                name: 'p1',
                apiUrl: 'https://api.example.com/v1',
                apiKey: 'sk-secret',
                model: 'm',
                allowedModels: ['a', 'b'],
                modelsEndpoint: 'https://api.example.com/v1/models',
            }],
        });
        const [p] = listApiProfiles();
        assert.deepEqual(p.allowedModels, ['a', 'b']);
        assert.equal(p.modelsEndpoint, 'https://api.example.com/v1/models');
        assert.equal(p.hasKey, true);
        assert.ok(!JSON.stringify(p).includes('sk-secret'), 'the key must never be exposed');
    });
});

describe('model allow-list enforcement', () => {
    it('rejects a model outside the allow-list with MODEL_NOT_ALLOWED', () => {
        stubContext({
            apiProfiles: [{
                name: 'laya-local',
                apiUrl: 'http://127.0.0.1:11434',
                apiKey: 'k',
                model: 'laya:en',
                allowedModels: ['laya:en', 'laya:de'],
            }],
        });
        let err = null;
        try {
            parseRequest({
                mode: 'single',
                input: { text: 'hi' },
                settings: { apiProfile: 'laya-local', connection: { model: 'gpt-4o' } },
                consumer: 'c',
            });
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'expected the request to be rejected');
        assert.equal(err.code, 'MODEL_NOT_ALLOWED');
        assert.match(err.message, /gpt-4o/);
        assert.match(err.message, /laya-local/);
        assert.match(err.message, /laya:en, laya:de/);
    });

    it('accepts a model inside the allow-list', () => {
        stubContext({
            apiProfiles: [{
                name: 'laya-local',
                apiUrl: 'http://127.0.0.1:11434',
                apiKey: 'k',
                model: 'laya:en',
                allowedModels: ['laya:en', 'laya:de'],
            }],
        });
        const n = parseRequest({
            mode: 'single',
            input: { text: 'hi' },
            settings: { apiProfile: 'laya-local', connection: { model: 'LAYA:DE' } },
            consumer: 'c',
        });
        assert.equal(n.connection.model, 'LAYA:DE');
        assert.deepEqual(n.connection.allowedModels, ['laya:en', 'laya:de']);
    });

    it('reports the code through validateRequest', () => {
        stubContext({
            apiProfiles: [{
                name: 'p',
                apiUrl: 'https://api.example.com/v1',
                model: 'm1',
                allowedModels: ['m1'],
            }],
        });
        const res = validateRequest({
            mode: 'single',
            input: { text: 'hi' },
            settings: { apiProfile: 'p', connection: { model: 'm2' } },
            consumer: 'c',
        });
        assert.equal(res.ok, false);
        assert.equal(res.code, 'MODEL_NOT_ALLOWED');
    });
});
