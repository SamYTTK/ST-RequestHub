import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchModels, clearModelsCache } from '../lib/models.js';

const CATALOG_A = {
    object: 'list',
    data: [
        { id: 'kimi-k2.6', name: 'Kimi K2.6' },
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

beforeEach(() => {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { 'ST-RequestHub': {} },
            saveSettingsDebounced() {},
        }),
    };
    clearModelsCache();
});

describe('model catalog cache key', () => {
    it('keys the cache on the api key identity, not its presence', async () => {
        const calls = stubFetch((_url, init) => {
            const auth = init?.headers?.Authorization ?? '';
            return auth === 'Bearer key-a' ? CATALOG_A : CATALOG_B;
        });

        const a = await fetchModels({ apiUrl: 'https://api.example.com/v1', apiKey: 'key-a', refresh: true });
        const b = await fetchModels({ apiUrl: 'https://api.example.com/v1', apiKey: 'key-b', refresh: true });

        assert.deepEqual(a.models.map((m) => m.id), CATALOG_A.data.map((d) => d.id));
        assert.deepEqual(b.models.map((m) => m.id), CATALOG_B.data.map((d) => d.id));
        assert.equal(calls.length, 2, 'each key must hit the endpoint on its own');

        // Same key again → cache hit, still the key's own catalog.
        const a2 = await fetchModels({ apiUrl: 'https://api.example.com/v1', apiKey: 'key-a' });
        assert.equal(a2.cached, true);
        assert.deepEqual(a2.models.map((m) => m.id), CATALOG_A.data.map((d) => d.id));
        assert.equal(calls.length, 2, 'the second key-a call must be served from the cache');

        // No key at all is a third, separate cache entry.
        const anon = await fetchModels({ apiUrl: 'https://api.example.com/v1', refresh: true });
        assert.equal(anon.cached, false);
        assert.equal(calls.length, 3);
    });

    it('never leaks the api key into the cache key', async () => {
        stubFetch(() => CATALOG_A);
        await fetchModels({ apiUrl: 'https://api.example.com/v1', apiKey: 'sk-super-secret', refresh: true });
        // clearModelsCache works on a URL prefix — the key must not be part of it.
        assert.equal(clearModelsCache('https://api.example.com/v1'), 1);
    });
});
