import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendDirect } from '../lib/direct.js';
import { parseRequest } from '../lib/request.js';
import { runAgent } from '../lib/agent.js';

function sseResponse(sseText) {
    const bytes = new TextEncoder().encode(sseText);
    let sent = false;
    return {
        ok: true,
        status: 200,
        headers: {},
        body: {
            getReader() {
                return {
                    async read() {
                        if (!sent) {
                            sent = true;
                            return { done: false, value: bytes };
                        }
                        return { done: true, value: undefined };
                    },
                    releaseLock() {},
                };
            },
        },
        clone() {
            return { text: async () => '' };
        },
    };
}

function jsonResponse(json) {
    return {
        ok: true,
        status: 200,
        headers: {},
        json: async () => json,
        clone() {
            return { text: async () => JSON.stringify(json) };
        },
    };
}

beforeEach(() => {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { 'ST-RequestHub': {} },
            saveSettingsDebounced() {},
            ToolManager: { tools: [] },
            chat: [],
            substituteParams: (s) => s,
        }),
    };
});

describe('streaming contract', () => {
    it('delivers CUMULATIVE snapshots to onChunk', async () => {
        globalThis.fetch = async () => sseResponse(
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
            + 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
            + 'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n'
            + 'data: [DONE]\n\n',
        );
        const chunks = [];
        const out = await sendDirect({
            apiUrl: 'https://api.example.com/v1',
            apiKey: '',
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            samplers: {},
            maxTokens: 32,
            stream: true,
            onChunk: (c) => chunks.push(c),
        });
        assert.deepEqual(chunks.map((c) => c.text), ['Hel', 'Hello', 'Hello world']);
        assert.equal(out.content, 'Hello world');
        assert.equal(out.finish_reason, 'stop');
    });

    it('exposes finish_reason on a non-streamed direct response', async () => {
        globalThis.fetch = async () => jsonResponse({
            choices: [{ message: { content: 'done' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
        const out = await sendDirect({
            apiUrl: 'https://api.example.com/v1',
            apiKey: '',
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            samplers: {},
            maxTokens: 32,
        });
        assert.equal(out.finish_reason, 'length');
        assert.equal(out.usage.totalTokens, 4);
    });
});

describe('agent round trace', () => {
    it('sends the cumulative snapshot under `snapshot` and keeps the old aliases', async () => {
        globalThis.fetch = async () => sseResponse(
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
            + 'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n'
            + 'data: [DONE]\n\n',
        );
        const events = [];
        const n = parseRequest({
            mode: 'agent',
            input: { messages: [{ role: 'user', content: 'hi' }] },
            settings: {
                connection: { apiUrl: 'https://api.example.com/v1', apiKey: '', model: 'm' },
                stream: true,
            },
            tools: { extra: [{ name: 'noop', description: 'noop', parameters: { type: 'object' }, action: async () => 'ok' }] },
            limits: { maxSteps: 2 },
            consumer: 'test',
            onRound: (e) => events.push(e),
        });
        const out = await runAgent(n);
        const deltas = events.filter((e) => e.phase === 'delta');
        assert.ok(deltas.length >= 1, 'expected delta events');
        assert.deepEqual(deltas.map((d) => d.snapshot.text), ['Hel', 'Hello']);
        assert.equal(deltas[0].text, 'Hel', 'the legacy alias stays');
        assert.equal(deltas[0].reasoning, '');
        const res = events.find((e) => e.phase === 'response');
        assert.equal(res.finish_reason, 'stop');
        assert.equal(out.finish_reason, 'stop');
    });
});
