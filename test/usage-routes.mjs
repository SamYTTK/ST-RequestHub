import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendDecide } from '../lib/decide.js';
import { sendViaBackend } from '../lib/service.js';

function stubContext(overrides = {}) {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { 'ST-RequestHub': {} },
            saveSettingsDebounced() {},
            ...overrides,
        }),
    };
}

beforeEach(() => {
    stubContext();
});

describe('decide-mode usage', () => {
    it('normalizes the provider usage through parseUsage', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                answers: { ok: { noul: 0.9 } },
                usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
            }),
            text: async () => '{}',
        });
        const out = await sendDecide({
            apiUrl: 'http://127.0.0.1:11435',
            model: 'laya:en',
            state: 'text',
            questions: { ok: { type: 'noul', instructions: 'yes or no' } },
        });
        assert.ok(out.usage, 'decide mode must report usage');
        assert.equal(out.usage.promptTokens, 12);
        assert.equal(out.usage.completionTokens, 3);
        assert.equal(out.usage.totalTokens, 15);
        assert.equal(out.usage.cacheWriteTokens, 0);
    });

    it('reports cache creation tokens when the server sends them', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                answers: { ok: { noul: 0.9 } },
                usage: { input_tokens: 20, output_tokens: 4, cache_creation_input_tokens: 6 },
            }),
            text: async () => '{}',
        });
        const out = await sendDecide({
            apiUrl: 'http://127.0.0.1:11435',
            model: 'laya:en',
            state: 'text',
            questions: { ok: { type: 'noul', instructions: 'yes or no' } },
        });
        assert.equal(out.usage.promptTokens, 20);
        assert.equal(out.usage.cacheWriteTokens, 6);
    });
});

describe('ST-backend usage', () => {
    it('reads usage and finish_reason from the backend payload', async () => {
        stubContext({
            ChatCompletionService: {
                processRequest: async (_req, _opts, extractData) => {
                    assert.equal(extractData, false, 'the raw payload is needed for the usage');
                    return {
                        choices: [{
                            message: { content: 'hello there', reasoning_content: 'thinking' },
                            finish_reason: 'stop',
                        }],
                        usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37 },
                    };
                },
            },
        });
        const out = await sendViaBackend({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o' });
        assert.equal(out.content, 'hello there');
        assert.equal(out.reasoning, 'thinking');
        assert.equal(out.finish_reason, 'stop');
        assert.ok(out.usage, 'the backend route must report usage');
        assert.equal(out.usage.promptTokens, 30);
        assert.equal(out.usage.completionTokens, 7);
    });

    it('reads the Anthropic-ish backend shape', async () => {
        stubContext({
            ChatCompletionService: {
                processRequest: async () => ({
                    content: [
                        { type: 'thinking', thinking: 'hmm' },
                        { type: 'text', text: 'the answer' },
                    ],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 11, output_tokens: 2, cache_creation_input_tokens: 4 },
                }),
            },
        });
        const out = await sendViaBackend({ messages: [{ role: 'user', content: 'hi' }], model: 'claude' });
        assert.equal(out.content, 'the answer');
        assert.equal(out.reasoning, 'hmm');
        assert.equal(out.finish_reason, 'end_turn');
        assert.equal(out.usage.promptTokens, 11);
        assert.equal(out.usage.cacheWriteTokens, 4);
    });

    it('returns null usage when the backend reports none', async () => {
        stubContext({
            ChatCompletionService: {
                processRequest: async () => ({ choices: [{ message: { content: 'hi' } }] }),
            },
        });
        const out = await sendViaBackend({ messages: [{ role: 'user', content: 'hi' }], model: 'm' });
        assert.equal(out.usage, null);
        assert.equal(out.finish_reason, '');
        assert.equal(out.content, 'hi');
    });
});
