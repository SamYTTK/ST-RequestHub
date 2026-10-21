import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    recordUsage, getUsageSnapshot, getUsage, clearUsage, parseUsage, flushUsageWrites,
} from '../lib/usage.js';
import { parseRequest } from '../lib/request.js';

function stubContext(settings = {}) {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { 'ST-RequestHub': settings },
            saveSettingsDebounced() {},
        }),
    };
}

function rec(over = {}) {
    return recordUsage({
        consumer: 'c1',
        label: 't',
        mode: 'single',
        route: 'direct',
        profile: 'p1',
        model: 'm1',
        apiUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: null, currency: 'USD' },
        ok: true,
        ...over,
    });
}

beforeEach(() => {
    stubContext({});
    clearUsage();
});

describe('cache write tokens', () => {
    it('parses the Anthropic shape (cache_creation_input_tokens)', () => {
        const u = parseUsage({
            usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_read_input_tokens: 50,
                cache_creation_input_tokens: 30,
            },
        });
        assert.equal(u.cacheWriteTokens, 30);
        assert.equal(u.cachedTokens, 50);
        assert.equal(u.promptTokens, 100);
        assert.equal(u.completionTokens, 20);
    });

    it('parses the OpenAI shape (prompt_tokens_details.cache_write_tokens)', () => {
        const u = parseUsage({
            usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 25 },
            },
        });
        assert.equal(u.cacheWriteTokens, 25);
        assert.equal(u.cachedTokens, 10);
    });

    it('parses the input_tokens_details shape', () => {
        const u = parseUsage({
            usage: {
                input_tokens: 10,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 4, cache_write_tokens: 6 },
            },
        });
        assert.equal(u.cacheWriteTokens, 6);
        assert.equal(u.cachedTokens, 4);
    });

    it('defaults to 0 when the provider reports no cache counter', () => {
        const u = parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 2 } });
        assert.equal(u.cacheWriteTokens, 0);
    });

    it('records the counter on the event and in the totals', () => {
        const evt = rec({ usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0, cacheWriteTokens: 7, reasoningTokens: 0, cost: null, currency: 'USD' } });
        assert.equal(evt.cacheWriteTokens, 7);
        const snap = getUsageSnapshot();
        assert.equal(snap.totals.cacheWriteTokens, 7);
    });

    it('survives a reload through the persisted counters', () => {
        rec({ usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0, cacheWriteTokens: 9, reasoningTokens: 0, cost: null, currency: 'USD' } });
        flushUsageWrites();
        const settings = globalThis.SillyTavern.getContext().extensionSettings['ST-RequestHub'];
        assert.equal(settings.usageV2.totals.cacheWriteTokens, 9);
    });
});

describe('per-session usage scope', () => {
    it('stores the session id on the event', () => {
        const evt = rec({ sessionId: 'sess-a' });
        assert.equal(evt.sessionId, 'sess-a');
    });

    it('filters by session id', () => {
        rec({ sessionId: 'sess-a' });
        rec({ sessionId: 'sess-b' });
        const snap = getUsageSnapshot({ sessionId: 'sess-a' });
        assert.equal(snap.recent.length, 1);
        assert.equal(snap.recent[0].sessionId, 'sess-a');
    });

    it('keeps every existing filter key working', () => {
        rec({ profile: 'p1', model: 'm1', consumer: 'c1', apiUrl: 'https://api.example.com/v1' });
        rec({ profile: 'p2', model: 'm2', consumer: 'c2', apiUrl: 'https://other.example.com/v1' });
        assert.equal(getUsageSnapshot({ profile: 'p1' }).recent.length, 1);
        assert.equal(getUsageSnapshot({ model: 'm2' }).recent.length, 1);
        assert.equal(getUsageSnapshot({ consumer: 'c2' }).recent.length, 1);
        assert.equal(getUsageSnapshot({ providerHost: 'other.example.com' }).recent.length, 1);
        assert.equal(getUsageSnapshot({ keyFingerprint: 'nope' }).recent.length, 0);
    });

    it('takes the session scope from settings.sessionId or harness.sessionId', () => {
        const n = parseRequest({
            mode: 'single',
            input: { text: 'hi' },
            settings: {
                connection: { apiUrl: 'https://api.example.com/v1', model: 'm' },
                sessionId: 'scope-explicit',
            },
            consumer: 'c',
        });
        assert.equal(n.sessionId, 'scope-explicit');

        const h = parseRequest({
            mode: 'single',
            input: { text: 'hi' },
            settings: {
                connection: { apiUrl: 'https://api.example.com/v1', model: 'm' },
                harness: { sessionId: 'scope-harness' },
            },
            consumer: 'c',
        });
        assert.equal(h.sessionId, 'scope-harness');
    });
});
