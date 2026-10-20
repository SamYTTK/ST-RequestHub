import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { recordUsage, getUsageSnapshot, clearUsage, getUsage, getRateLimits } from '../lib/usage.js';

describe('usage aggregation', () => {
    it('aggregates two records in one debounce', () => {
        clearUsage();
        recordUsage({
            consumer: 'test-consumer',
            label: 't1',
            mode: 'single',
            route: 'direct',
            profile: 'p1',
            model: 'm1',
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-test-123',
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0, reasoningTokens: 0, cost: 0.01, currency: 'USD' },
            rateLimits: [],
            ok: true,
            durationMs: 100,
        });
        recordUsage({
            consumer: 'test-consumer',
            label: 't2',
            mode: 'single',
            route: 'direct',
            profile: 'p1',
            model: 'm1',
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-test-123',
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, cachedTokens: 0, reasoningTokens: 0, cost: 0.02, currency: 'USD' },
            rateLimits: [],
            ok: true,
            durationMs: 200,
        });
        const snap = getUsageSnapshot();
        assert.equal(snap.totals.requests, 2);
        assert.equal(snap.totals.promptTokens, 30);
        assert.equal(snap.totals.completionTokens, 15);
        assert.equal(snap.totals.totalTokens, 45);
        assert.ok(Math.abs(snap.totals.cost - 0.03) < 1e-9);
        assert.equal(snap.recent.length, 2);
    });

    it('groups byKey on profile+host+fingerprint', () => {
        clearUsage();
        recordUsage({
            consumer: 'c', mode: 'single', route: 'direct', profile: 'p1', model: 'm1',
            apiUrl: 'https://api.example.com/v1', apiKey: 'sk-same-key',
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: null, currency: 'USD' },
            ok: true,
        });
        recordUsage({
            consumer: 'c', mode: 'single', route: 'direct', profile: 'p1', model: 'm1',
            apiUrl: 'https://api.example.com/v1', apiKey: 'sk-same-key',
            usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10, cost: null, currency: 'USD' },
            ok: true,
        });
        recordUsage({
            consumer: 'c', mode: 'single', route: 'direct', profile: 'p2', model: 'm1',
            apiUrl: 'https://api.example.com/v1', apiKey: 'sk-other-key',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: null, currency: 'USD' },
            ok: true,
        });
        const snap = getUsageSnapshot();
        const keys = Object.keys(snap.totals.byKey);
        assert.equal(keys.length, 2);
        const same = Object.values(snap.totals.byKey).find((v) => v.profile === 'p1');
        assert.ok(same);
        assert.equal(same.requests, 2);
        assert.equal(same.totalTokens, 20);
        const other = Object.values(snap.totals.byKey).find((v) => v.profile === 'p2');
        assert.ok(other);
        assert.equal(other.requests, 1);
    });

    it('never stores raw keys', () => {
        clearUsage();
        const evt = recordUsage({
            consumer: 'c', mode: 'single', route: 'direct', profile: '', model: 'm',
            apiUrl: 'https://api.example.com/v1', apiKey: 'sk-super-secret-xyz',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: null, currency: 'USD' },
            ok: true,
        });
        assert.ok(!JSON.stringify(evt).includes('sk-super-secret-xyz'));
        assert.ok(evt.keyFingerprint && !evt.keyFingerprint.includes('sk-super'));
        const snap = getUsageSnapshot();
        assert.ok(!JSON.stringify(snap).includes('sk-super-secret-xyz'));
        assert.ok(typeof getUsage === 'function');
        assert.ok(typeof getRateLimits === 'function');
    });

    after(() => {
        clearUsage();
    });
});
