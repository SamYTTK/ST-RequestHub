import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRateLimitHeaders, resetToMs } from '../lib/usage.js';

describe('rate-limit header parsing', () => {
    it('parses OpenAI duration resets', () => {
        const now = Date.now();
        const out = parseRateLimitHeaders({
            'x-ratelimit-limit-requests': '60',
            'x-ratelimit-remaining-requests': '59',
            'x-ratelimit-reset-requests': '1m30s',
        }, now);
        const w = out.find((x) => x.kind === 'requests');
        assert.ok(w, 'expected requests window');
        assert.equal(w.limit, 60);
        assert.equal(w.remaining, 59);
        assert.equal(w.used, 1);
        assert.ok(Math.abs(w.resetAt - (now + 90000)) < 2000, `resetAt ${w.resetAt} ~ now+90s`);
        assert.ok(Math.abs(w.windowSeconds - 90) <= 1);
        assert.equal(w.family, 'openai');
    });

    it('parses Anthropic ISO resets', () => {
        const iso = '2030-01-01T00:00:00.000Z';
        const out = parseRateLimitHeaders({
            'anthropic-ratelimit-requests-limit': '1000',
            'anthropic-ratelimit-requests-remaining': '999',
            'anthropic-ratelimit-requests-reset': iso,
        });
        const w = out.find((x) => x.kind === 'requests');
        assert.ok(w, 'expected requests window');
        assert.equal(w.limit, 1000);
        assert.equal(w.remaining, 999);
        assert.equal(w.used, 1);
        assert.equal(w.resetAt, Date.parse(iso));
        assert.equal(w.family, 'anthropic');
    });

    it('parses numeric retry-after', () => {
        const now = Date.now();
        const out = parseRateLimitHeaders({ 'retry-after': '120' }, now);
        const w = out.find((x) => x.kind === 'retry');
        assert.ok(w, 'expected retry window');
        assert.equal(w.remaining, 0);
        assert.ok(Math.abs(w.resetAt - (now + 120000)) < 2000);
    });

    it('parses HTTP-date retry-after', () => {
        const now = Date.now();
        const date = new Date(now + 60000).toUTCString();
        const out = parseRateLimitHeaders({ 'retry-after': date }, now);
        const w = out.find((x) => x.kind === 'retry');
        assert.ok(w, 'expected retry window for HTTP date');
        assert.ok(Math.abs(w.resetAt - (now + 60000)) < 5000, `resetAt ${w.resetAt} ~ ${date}`);
    });

    it('accepts Headers instances', () => {
        const h = new Headers();
        h.set('x-ratelimit-limit-tokens', '1000');
        h.set('x-ratelimit-remaining-tokens', '800');
        h.set('x-ratelimit-reset-tokens', '30s');
        const out = parseRateLimitHeaders(h);
        const w = out.find((x) => x.kind === 'tokens');
        assert.ok(w);
        assert.equal(w.limit, 1000);
        assert.equal(w.remaining, 800);
        assert.equal(w.used, 200);
    });

    it('resetToMs handles durations and epochs', () => {
        const now = Date.now();
        assert.ok(Math.abs(resetToMs('6m', now) - (now + 360000)) < 1000);
        assert.ok(Math.abs(resetToMs('2h', now) - (now + 7200000)) < 1000);
        const epochSec = Math.floor(now / 1000) + 60;
        assert.equal(resetToMs(String(epochSec), now), epochSec * 1000);
    });
});
