import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    recordUsage, getUsageSnapshot, clearUsage, onUsage, getKeyInfo,
    flushUsageWrites,
} from '../lib/usage.js';

function stubContext(settings = {}) {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { 'ST-RequestHub': settings },
            saveSettingsDebounced() {},
        }),
    };
}

beforeEach(() => {
    clearUsage();
    stubContext({});
});

describe('P1-2 getKeyInfo masking', () => {
    it('masks long keys with first/last 4', () => {
        stubContext({
            apiProfiles: [{ name: 'long', apiUrl: 'https://api.example.com/v1', apiKey: 'sk-abcdefghijklmnopqrstuvwxyz', model: 'm' }],
        });
        const info = getKeyInfo('long');
        assert.equal(info.hasKey, true);
        assert.ok(info.masked.startsWith('sk-a'));
        assert.ok(info.masked.endsWith('wxyz'));
        assert.ok(!info.masked.includes('mnop'), 'middle of key must not leak');
    });

    it('uses fixed mask for short keys', () => {
        stubContext({
            apiProfiles: [{ name: 'short', apiUrl: 'https://api.example.com/v1', apiKey: 'sk-short', model: 'm' }],
        });
        const info = getKeyInfo('short');
        assert.equal(info.masked, '••••');
        assert.ok(!info.masked.includes('sk-short'));
    });

    it('returns empty mask without key', () => {
        stubContext({ apiProfiles: [{ name: 'nokey', apiUrl: 'https://api.example.com/v1', apiKey: '', model: 'm' }] });
        assert.equal(getKeyInfo('nokey').masked, '');
    });
});

describe('P2-4 rate-limit model scoping and expiry', () => {
    it('keeps windows per model on one key', () => {
        const rl = (model, remaining) => [{
            kind: 'requests', limit: 60, remaining, used: 60 - remaining,
            resetAt: Date.now() + 600000, windowSeconds: 600,
            source: 'provider', confidence: 'high', family: 'openai',
        }];
        recordUsage({
            consumer: 'c', mode: 'single', route: 'direct', profile: 'p', model: 'model-a',
            apiUrl: 'https://api.example.com/v1', apiKey: 'sk-same',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: null, currency: 'USD' },
            rateLimits: rl('model-a', 59), ok: true,
        });
        recordUsage({
            consumer: 'c', mode: 'single', route: 'direct', profile: 'p', model: 'model-b',
            apiUrl: 'https://api.example.com/v1', apiKey: 'sk-same',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: null, currency: 'USD' },
            rateLimits: rl('model-b', 10), ok: true,
        });
        const snap = getUsageSnapshot();
        const entries = Object.values(snap.limits);
        assert.equal(entries.length, 2, `expected per-model entries, got ${JSON.stringify(Object.keys(snap.limits))}`);
        const models = entries.map((e) => e.model).sort();
        assert.deepEqual(models, ['model-a', 'model-b']);
    });

    it('drops expired windows from snapshots', () => {
        recordUsage({
            consumer: 'c', mode: 'single', route: 'direct', profile: 'p', model: 'm',
            apiUrl: 'https://api.example.com/v1', apiKey: 'sk-x',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: null, currency: 'USD' },
            rateLimits: [{
                kind: 'requests', limit: 60, remaining: 0, used: 60,
                resetAt: Date.now() - 60000, windowSeconds: 0,
                source: 'provider', confidence: 'high', family: 'openai',
            }],
            ok: true,
        });
        const snap = getUsageSnapshot();
        assert.deepEqual(snap.limits, {}, 'expired windows must disappear');
    });
});

describe('P2-5 emit passes copies', () => {
    it('listener mutation does not corrupt recent', () => {
        const unsub = onUsage((evt) => {
            if (evt && typeof evt === 'object' && !evt.kind) {
                evt.consumer = 'MUTATED';
                evt.promptTokens = 999999;
                if (Array.isArray(evt.rateLimits)) evt.rateLimits.push({ kind: 'evil' });
            }
        });
        try {
            recordUsage({
                consumer: 'orig', mode: 'single', route: 'direct', profile: '', model: 'm',
                apiUrl: 'https://api.example.com/v1', apiKey: '',
                usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: null, currency: 'USD' },
                ok: true,
            });
        } finally {
            unsub();
        }
        const snap = getUsageSnapshot();
        assert.equal(snap.recent[0].consumer, 'orig');
        assert.equal(snap.recent[0].promptTokens, 5);
        assert.deepEqual(snap.recent[0].rateLimits, []);
    });
});

describe('P2-6 cost provenance', () => {
    it('marks pricing-derived cost as estimated', () => {
        stubContext({ usagePricing: { 'priced-model': { input: 1, output: 2 } } });
        const evt = recordUsage({
            consumer: 'c', mode: 'single', route: 'direct', profile: '', model: 'priced-model',
            apiUrl: 'https://api.example.com/v1', apiKey: '',
            usage: { promptTokens: 1000000, completionTokens: 1000000, totalTokens: 2000000, cost: null, currency: 'USD' },
            ok: true,
        });
        assert.equal(evt.estimated, true);
        assert.ok(evt.cost > 0);
    });

    it('preserves null cost in byKey/day instead of 0', () => {
        stubContext({});
        clearUsage();
        recordUsage({
            consumer: 'c', mode: 'single', route: 'direct', profile: 'p', model: 'm',
            apiUrl: 'https://api.example.com/v1', apiKey: 'sk-k',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: null, currency: 'USD' },
            ok: true,
        });
        const snap = getUsageSnapshot();
        const keyEntry = Object.values(snap.totals.byKey)[0];
        assert.equal(keyEntry.cost, null);
        assert.equal(snap.days[snap.days.length - 1].cost, null);
    });
});

describe('P2-11 flush and map caps', () => {
    it('flushUsageWrites drains the debounce timer', () => {
        recordUsage({
            consumer: 'c', mode: 'single', route: 'direct', profile: '', model: 'm',
            apiUrl: '', apiKey: '',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: null, currency: 'USD' },
            ok: true,
        });
        assert.equal(flushUsageWrites(), true);
        assert.equal(flushUsageWrites(), false);
    });

    it('caps byModel/byProfile maps', () => {
        clearUsage();
        for (let i = 0; i < 70; i++) {
            recordUsage({
                consumer: 'c', mode: 'single', route: 'direct', profile: `profile-${i}`, model: `model-${i}`,
                apiUrl: '', apiKey: '',
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: null, currency: 'USD' },
                ok: true,
            });
        }
        flushUsageWrites();
        const snap = getUsageSnapshot();
        assert.ok(Object.keys(snap.totals.byModel).length <= 51, `byModel grew to ${Object.keys(snap.totals.byModel).length}`);
        assert.ok(Object.keys(snap.totals.byProfile).length <= 51, `byProfile grew to ${Object.keys(snap.totals.byProfile).length}`);
    });
});
