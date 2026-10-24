import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchModels, parseModels, clearModelsCache } from '../lib/models.js';
import { listModels } from '../lib/hub.js';

const CATALOG = {
    object: 'list',
    data: [
        {
            id: 'kimi-k2.6',
            name: 'Kimi K2.6',
            owned_by: 'moonshot',
            context_window: 262144,
            description: 'Long-context MoE model',
            created: 1735689600,
            capabilities: { tools: true, vision: false },
            metadata: { family: 'kimi', supported_reasoning_efforts: ['low', 'medium', 'high'] },
            pricing: { input: 0.6, output: 2.5 },
        },
        {
            id: 'glm-5.3',
            name: 'GLM 5.3',
            variants: { low: { label: 'Low' }, high: { label: 'High' } },
        },
        {
            id: 'grok-4',
            variants: [{ id: 'fast' }, { id: 'deep' }],
        },
        {
            id: 'qwen-max',
            metadata: { thinking_variants: ['minimal', 'high'] },
        },
        {
            id: 'cap-variants',
            capabilities: { variants: ['standard', 'extended'] },
        },
        {
            id: 'cap-efforts',
            capabilities: { reasoning_efforts: { low: {}, high: {} } },
        },
        {
            id: 'plain-model',
            name: 'Plain model',
        },
    ],
};

function stubFetch(payload = CATALOG) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return {
            ok: true,
            status: 200,
            json: async () => payload,
            text: async () => JSON.stringify(payload),
        };
    };
    return calls;
}

beforeEach(() => {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { 'ST-RequestHub': {} },
            saveSettingsDebounced() {},
        }),
    };
    stubFetch();
    clearModelsCache();
});

describe('model catalog metadata', () => {
    it('keeps every upstream id and normalizes the thinking variants', async () => {
        const { models } = await fetchModels({ apiUrl: 'https://api.example.com/v1', refresh: true });
        assert.ok(Array.isArray(models));
        assert.equal(models.length, CATALOG.data.length);
        for (const m of models) {
            assert.equal(typeof m.id, 'string');
            assert.ok(m.id.trim());
        }
        assert.deepEqual(models.map((m) => m.id), CATALOG.data.map((d) => d.id));

        const byId = new Map(models.map((m) => [m.id, m]));
        // (b) metadata.supported_reasoning_efforts
        assert.deepEqual(byId.get('kimi-k2.6').variants, [{ id: 'low' }, { id: 'medium' }, { id: 'high' }]);
        // (a) variants as an object keyed by id
        assert.deepEqual(byId.get('glm-5.3').variants, [{ id: 'low' }, { id: 'high' }]);
        // (a) variants as an array of { id }
        assert.deepEqual(byId.get('grok-4').variants, [{ id: 'fast' }, { id: 'deep' }]);
        // (c) metadata.thinking_variants
        assert.deepEqual(byId.get('qwen-max').variants, [{ id: 'minimal' }, { id: 'high' }]);
        // (c) capabilities.variants
        assert.deepEqual(byId.get('cap-variants').variants, [{ id: 'standard' }, { id: 'extended' }]);
        // (c) capabilities.reasoning_efforts
        assert.deepEqual(byId.get('cap-efforts').variants, [{ id: 'low' }, { id: 'high' }]);
        // (d) no thinking metadata at all
        assert.deepEqual(byId.get('plain-model').variants, []);
    });

    it('keeps the upstream metadata fields', async () => {
        const { models } = await fetchModels({ apiUrl: 'https://api.example.com/v1', refresh: true });
        const kimi = models.find((m) => m.id === 'kimi-k2.6');
        assert.equal(kimi.name, 'Kimi K2.6');
        assert.equal(kimi.owned_by, 'moonshot');
        assert.equal(kimi.context_window, 262144);
        assert.equal(kimi.description, 'Long-context MoE model');
        assert.equal(kimi.created, 1735689600);
        assert.deepEqual(kimi.capabilities, { tools: true, vision: false });
        assert.equal(kimi.metadata.family, 'kimi');
        assert.deepEqual(kimi.pricing, { input: 0.6, output: 2.5 });
    });

    it('falls back to context_length for the context window', async () => {
        const out = parseModels({ data: [{ id: 'm', context_length: 131072 }] });
        assert.equal(out[0].context_window, 131072);
        assert.equal(out[0].context_length, 131072);
    });

    it('keeps the id-only consumer contract working', async () => {
        const { models } = await fetchModels({ apiUrl: 'https://api.example.com/v1', refresh: true });
        const ids = (models || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
        assert.deepEqual(ids, CATALOG.data.map((d) => d.id));
    });

    it('keeps plain string entries as id + empty variants', () => {
        const out = parseModels({ data: ['  gpt-4o  ', { id: 'x' }] });
        assert.deepEqual(out, [{ id: 'gpt-4o', variants: [] }, { id: 'x', variants: [] }]);
    });

    it('listModels() passes the enriched entries through unchanged', async () => {
        const res = await listModels({
            connection: { apiUrl: 'https://api.example.com/v1', apiKey: '' },
            refresh: true,
        });
        assert.deepEqual(res.models.map((m) => m.id), CATALOG.data.map((d) => d.id));
        const kimi = res.models.find((m) => m.id === 'kimi-k2.6');
        assert.deepEqual(kimi.variants, [{ id: 'low' }, { id: 'medium' }, { id: 'high' }]);
        assert.equal(kimi.context_window, 262144);
        assert.deepEqual(res.models.find((m) => m.id === 'plain-model').variants, []);
    });
});
