import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, validateRequest } from '../lib/request.js';

beforeEach(() => {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { 'ST-RequestHub': {} },
            saveSettingsDebounced() {},
        }),
    };
});

function agentBase(overrides = {}) {
    return {
        mode: 'agent',
        input: { text: 'do work' },
        settings: {
            connection: { apiUrl: 'https://api.example.com/v1', apiKey: 'sk-x', model: 'm' },
        },
        tools: { extra: [{ name: 't', action: async () => 'ok' }] },
        ...overrides,
    };
}

describe('limits.maxSteps 0 acceptance', () => {
    it('accepts 0 as uncapped', () => {
        const n = parseRequest(agentBase({ limits: { maxSteps: 0 } }));
        assert.equal(n.limits.maxSteps, 0);
    });

    it('accepts omitted limits with defaults', () => {
        const n = parseRequest(agentBase());
        assert.ok(Number.isInteger(n.limits.maxSteps) && n.limits.maxSteps > 0);
    });

    it('rejects negative maxSteps', () => {
        assert.throws(() => parseRequest(agentBase({ limits: { maxSteps: -1 } })), /maxSteps/);
    });

    it('clamps positive values to the hub cap', () => {
        const n = parseRequest(agentBase({ limits: { maxSteps: 9999 } }));
        assert.ok(n.limits.maxSteps <= 25, `got ${n.limits.maxSteps}`);
        assert.ok(n.limits.maxSteps > 0);
    });
});

describe('validateRequest does not leak callbacks or secrets', () => {
    it('redacts apiKey, callbacks and tool actions', () => {
        const onRound = () => {};
        const onChunk = () => {};
        const onStep = () => {};
        const signal = new AbortController().signal;
        const res = validateRequest({
            mode: 'agent',
            input: { text: 'hi' },
            settings: {
                connection: { apiUrl: 'https://api.example.com/v1', apiKey: 'sk-secret-123', model: 'm' },
                harness: { sessionId: 'secret-session-id' },
            },
            tools: { extra: [{ name: 'echo', description: 'd', parameters: { type: 'object', properties: {} }, action: async () => 'x' }] },
            limits: { maxSteps: 0 },
            onRound,
            onChunk,
            onStep,
            signal,
        });
        assert.equal(res.ok, true);
        const safe = res.request;
        const dumped = JSON.stringify(safe);
        assert.ok(!dumped.includes('sk-secret-123'), 'raw key leaked');
        assert.ok(!dumped.includes('secret-session-id'), 'sessionId leaked in clear');
        assert.equal(safe.connection.hasKey, true);
        assert.ok(!('apiKey' in safe.connection), 'apiKey key should be removed');
        assert.equal(safe.harness.hasSession, true);
        assert.ok(!('sessionId' in safe.harness), 'sessionId should not be in validate output');
        assert.equal(safe.onRound, true);
        assert.equal(safe.onChunk, true);
        assert.equal(safe.onStep, true);
        assert.equal(safe.signal, true);
        assert.ok(typeof safe.onRound !== 'function');
        assert.ok(typeof safe.onChunk !== 'function');
        assert.equal(safe.tools.extra.length, 1);
        assert.equal(safe.tools.extra[0].hasAction, true);
        assert.ok(!('action' in safe.tools.extra[0]), 'tool action function leaked');
        assert.ok(!dumped.includes('async () =>'));
    });

    it('exposes hub usage/quota surface via lib exports', async () => {
        const hub = await import('../lib/hub.js');
        for (const k of ['getUsageSnapshot', 'getUsage', 'getRateLimits', 'getUsageHistory', 'clearUsage', 'onUsage', 'refreshQuota', 'registerQuotaProvider', 'listQuotaProviders', 'getKeyInfo', 'parseRateLimitHeaders', 'parseUsage']) {
            assert.equal(typeof hub[k], 'function', `hub.${k} should be a function`);
        }
    });
});
