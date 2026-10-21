import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    recordUsage, getUsageSnapshot, getUsage, clearUsage,
} from '../lib/usage.js';

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

describe('filtered snapshot semantics', () => {
    it('recomputes totals for a filtered snapshot', () => {
        rec({ profile: 'p1', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0.01, currency: 'USD' } });
        rec({ profile: 'p2', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0.02, currency: 'USD' } });

        const all = getUsageSnapshot();
        assert.equal(all.totals.requests, 2);
        assert.equal(all.totals.totalTokens, 45);

        const filtered = getUsageSnapshot({ profile: 'p1' });
        assert.equal(filtered.totals.requests, 1, 'a filtered snapshot must not show lifetime totals');
        assert.equal(filtered.totals.promptTokens, 10);
        assert.equal(filtered.totals.totalTokens, 15);
        assert.ok(Math.abs(filtered.totals.cost - 0.01) < 1e-9);
    });

    it('recomputes the daily buckets for a filtered snapshot', () => {
        rec({ profile: 'p1' });
        rec({ profile: 'p2' });
        const all = getUsageSnapshot();
        assert.equal(all.days.length, 1);
        assert.equal(all.days[0].requests, 2);

        const filtered = getUsageSnapshot({ profile: 'p2' });
        assert.equal(filtered.days.length, 1);
        assert.equal(filtered.days[0].requests, 1);
    });

    it('scopes the totals to the session too', () => {
        rec({ profile: 'p1', sessionId: 'sess-a' });
        rec({ profile: 'p1', sessionId: 'sess-b' });
        const snap = getUsageSnapshot({ sessionId: 'sess-a' });
        assert.equal(snap.totals.requests, 1);
        assert.equal(snap.recent.length, 1);
    });

    it('keeps the lifetime aggregates when no filter is given', () => {
        rec({ profile: 'p1' });
        rec({ profile: 'p2' });
        const usage = getUsage();
        assert.equal(usage.totals.requests, 2);
        assert.equal(usage.days[0].requests, 2);
    });

    it('keeps the quota windows when a consumer filter is used', () => {
        rec({
            consumer: 'c1',
            rateLimits: [{
                kind: 'requests', limit: 60, remaining: 59, used: 1,
                resetAt: Date.now() + 600000, windowSeconds: 600,
                source: 'provider', confidence: 'high', family: 'openai',
            }],
        });
        const byConsumer = getUsageSnapshot({ consumer: 'c1' });
        assert.equal(Object.keys(byConsumer.limits).length, 1, 'a consumer filter must keep the quota windows');
        const bySession = getUsageSnapshot({ sessionId: 'sess-x' });
        assert.equal(Object.keys(bySession.limits).length, 1, 'a session filter must keep the quota windows');
    });
});
