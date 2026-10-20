import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../lib/request.js';
import { runAgent } from '../lib/agent.js';

function sseResponse(sseText, headers = {}) {
    const bytes = new TextEncoder().encode(sseText);
    let sent = false;
    return {
        ok: true,
        status: 200,
        headers,
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

function jsonResponse(json, headers = {}) {
    return {
        ok: true,
        status: 200,
        headers,
        json: async () => json,
        clone() {
            return { text: async () => JSON.stringify(json) };
        },
    };
}

function toolCallSSE() {
    return 'data: {"choices":[{"delta":{"role":"assistant","content":"","reasoning_content":"planning...","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"echo","arguments":"{\\"text\\":\\"hi\\"}"}}]}}]}\n\n' +
        'data: [DONE]\n\n';
}

function finalSSE() {
    return 'data: {"choices":[{"delta":{"role":"assistant","content":"final ","reasoning_content":"r1"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"answer","reasoning_content":"r2"}}]}\n\n' +
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
        'data: [DONE]\n\n';
}

function echoTool() {
    return {
        name: 'echo',
        description: 'echo tool',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        action: async (args) => `echo:${args.text}`,
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

describe('mocked onRound agent run', () => {
    it('streams SSE tool-call then final answer with explicit stream:true', async () => {
        let calls = 0;
        const bodies = [];
        globalThis.fetch = async (url, opts) => {
            calls += 1;
            try { bodies.push(JSON.parse(opts?.body ?? '{}')); } catch { bodies.push({}); }
            if (calls === 1) return sseResponse(toolCallSSE(), {});
            return sseResponse(finalSSE(), {
                'x-ratelimit-limit-requests': '60',
                'x-ratelimit-remaining-requests': '59',
                'x-ratelimit-reset-requests': '60s',
            });
        };

        const events = [];
        const raw = {
            mode: 'agent',
            input: { messages: [{ role: 'user', content: 'say hi' }] },
            settings: {
                connection: { apiUrl: 'https://api.example.com/v1', apiKey: '', model: 'test-model' },
                maxTokens: 64,
                stream: true,
            },
            tools: { extra: [echoTool()] },
            limits: { maxSteps: 0, totalTimeoutMs: 30000 },
            consumer: 'test',
            label: 'agent-test',
            onRound: (evt) => {
                events.push(evt);
            },
        };

        const n = parseRequest(raw);
        assert.equal(n.limits.maxSteps, 0);
        assert.equal(n.stream, true);
        assert.equal(typeof n.onRound, 'function');

        const out = await runAgent(n);

        assert.equal(calls, 2, `expected 2 model rounds, got ${calls}`);
        assert.equal(bodies[0].stream, true);
        assert.equal(bodies[1].stream, true);
        assert.equal(out.content, 'final answer');
        assert.equal(out.reasoning, 'r1r2');
        assert.equal(out.steps.length, 1);
        assert.equal(out.steps[0].reasoning, 'planning...');
        assert.equal(out.steps[0].toolCalls.length, 1);
        assert.equal(out.steps[0].toolCalls[0].name, 'echo');
        assert.equal(out.steps[0].results[0].ok, true);
        assert.ok(String(out.steps[0].results[0].result).includes('echo:hi'));

        const phases = events.map((e) => e.phase);
        assert.ok(phases.includes('request'), `missing request trace, got ${phases}`);
        assert.ok(phases.includes('response'), `missing response trace, got ${phases}`);
        const req1 = events.find((e) => e.phase === 'request' && e.round === 1);
        assert.ok(req1, 'missing round-1 request');
        assert.equal(req1.model, 'test-model');
        assert.ok(Array.isArray(req1.messages) && req1.messages.length === 1);
        const res1 = events.find((e) => e.phase === 'response' && e.round === 1);
        assert.ok(res1, 'missing round-1 response');
        assert.equal(res1.toolCalls.length, 1);
        assert.equal(res1.toolCalls[0].name, 'echo');
        const res2 = events.find((e) => e.phase === 'response' && e.round === 2);
        assert.ok(res2, 'missing round-2 response');
        assert.equal(res2.content, 'final answer');

        assert.ok(events.some((e) => e.phase === 'delta'), 'expected streamed delta events');

        assert.equal(out.usage.promptTokens, 10);
        assert.equal(out.usage.completionTokens, 5);
        assert.equal(out.usage.totalTokens, 15);
        assert.ok(Array.isArray(out.rateLimits) && out.rateLimits.length > 0, 'expected rateLimits from headers');
        assert.equal(out.meta.stepsUsed, 2);

        const before = JSON.stringify(n.messages);
        await Promise.resolve();
        assert.equal(JSON.stringify(n.messages), before, 'trace must not mutate the request');
    });

    it('does not stream when onRound is set without stream:true', async () => {
        let calls = 0;
        const bodies = [];
        globalThis.fetch = async (url, opts) => {
            calls += 1;
            try { bodies.push(JSON.parse(opts?.body ?? '{}')); } catch { bodies.push({}); }
            if (calls === 1) {
                return jsonResponse({
                    choices: [{ message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }] } }],
                    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
                });
            }
            return jsonResponse({
                choices: [{ message: { content: 'plain answer' } }],
                usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
            });
        };

        const events = [];
        const n = parseRequest({
            mode: 'agent',
            input: { messages: [{ role: 'user', content: 'say hi' }] },
            settings: {
                connection: { apiUrl: 'https://api.example.com/v1', apiKey: '', model: 'm' },
            },
            tools: { extra: [echoTool()] },
            limits: { maxSteps: 5 },
            consumer: 'test',
            onRound: (e) => events.push(e),
        });
        assert.equal(n.stream, false);

        const out = await runAgent(n);
        assert.equal(out.content, 'plain answer');
        assert.ok(bodies.every((b) => b.stream === false), 'wire must stay non-streamed');
        assert.ok(!events.some((e) => e.phase === 'delta'), 'no delta events without explicit stream');
        assert.ok(events.some((e) => e.phase === 'request'));
        assert.ok(events.some((e) => e.phase === 'response'));
    });

    it('retries non-streaming when the streamed round fails empty', async () => {
        let calls = 0;
        globalThis.fetch = async () => {
            calls += 1;
            if (calls === 1) return sseResponse('data: [DONE]\n\n', {});
            return jsonResponse({
                choices: [{ message: { content: 'recovered' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
        };

        const events = [];
        const n = parseRequest({
            mode: 'agent',
            input: { messages: [{ role: 'user', content: 'hi' }] },
            settings: {
                connection: { apiUrl: 'https://api.example.com/v1', apiKey: '', model: 'm' },
                stream: true,
            },
            tools: { extra: [echoTool()] },
            limits: { maxSteps: 2 },
            consumer: 'test',
            onRound: (e) => events.push(e),
        });

        const out = await runAgent(n);
        assert.equal(out.content, 'recovered');
        assert.equal(calls, 2, 'expected stream attempt + non-stream retry');
    });

    it('attaches usage to sendStep errors', async () => {
        globalThis.fetch = async () => ({
            ok: false,
            status: 500,
            headers: {},
            text: async () => 'boom',
            clone() { return { text: async () => 'boom' }; },
        });

        const n = parseRequest({
            mode: 'agent',
            input: { messages: [{ role: 'user', content: 'hi' }] },
            settings: {
                connection: { apiUrl: 'https://api.example.com/v1', apiKey: '', model: 'm' },
                stream: true,
            },
            tools: { extra: [echoTool()] },
            limits: { maxSteps: 2 },
            consumer: 'test',
            onRound: () => {},
        });
        n.retries = 0;
        n.timeoutMs = 5000;

        let err = null;
        try {
            await runAgent(n);
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'expected runAgent to throw');
        assert.ok(err.usage && typeof err.usage === 'object', 'error must carry usage');
        assert.ok(Array.isArray(err.rateLimits), 'error must carry rateLimits');
    });
});
