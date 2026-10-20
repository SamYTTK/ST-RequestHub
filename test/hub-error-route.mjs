import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../lib/hub.js';
import { clearUsage, getUsageSnapshot } from '../lib/usage.js';

function stubBase() {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { 'ST-RequestHub': {} },
            saveSettingsDebounced() {},
            ToolManager: { tools: [] },
            ChatCompletionService: {
                async processRequest() {
                    const e = new Error('backend down');
                    e.code = 'NETWORK';
                    e.retryable = true;
                    throw e;
                },
            },
            chat: [],
            substituteParams: (s) => s,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        }),
    };
}

beforeEach(() => {
    stubBase();
    clearUsage();
});

describe('hub.request error route', () => {
    it('records direct route on direct failures', async () => {
        globalThis.fetch = async () => ({
            ok: false,
            status: 500,
            headers: {},
            text: async () => 'boom',
            clone() { return { text: async () => 'boom' }; },
        });
        let err = null;
        try {
            await request({
                mode: 'single',
                input: { text: 'hi' },
                settings: {
                    connection: { apiUrl: 'https://api.example.com/v1', apiKey: '', model: 'm' },
                    retries: 0,
                    timeoutMs: 5000,
                },
                consumer: 't',
            });
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'expected request to throw');
        const snap = getUsageSnapshot();
        assert.ok(snap.recent.length >= 1);
        assert.equal(snap.recent[0].route, 'direct');
        assert.equal(snap.recent[0].ok, false);
    });

    it('records st-backend route on backend failures', async () => {
        let err = null;
        try {
            await request({
                mode: 'single',
                input: { text: 'hi' },
                settings: { preset: 'whatever', retries: 0, timeoutMs: 5000 },
                consumer: 't',
            });
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'expected request to throw');
        const snap = getUsageSnapshot();
        assert.equal(snap.recent[0].route, 'st-backend');
    });
});
