import { HubError } from './util.js';
import { hubWarn, withAbortableTimeout, retry } from './net.js';
import { resolveSamplers } from './preset.js';
import { sendDirect } from './direct.js';
import { sendViaBackend } from './service.js';
import { buildMessages } from './messages.js';
import { readHubSettings } from './request.js';
import { resolveEffectiveHarness } from './harness.js';

/**
 * Autonomous agent loop (mode:'agent').
 *
 * Takes a normalized request (see lib/request.js parseRequest), resolves the
 * allowed tool set from the core ToolManager registry + inline extras, then
 * runs model → tool_calls → execute → feed-back rounds until the model
 * answers without tool calls or a limit is hit.
 *
 * The hub owns NO policy: no approvals, no write gates, no dry-run. The
 * calling extension defines the tools and enforces its own rules around
 * the call. Tool failures are fed back to the model as error tool messages
 * (core behavior) so it can recover on the next round.
 */

function getToolManager() {
    try {
        return SillyTavern.getContext()?.ToolManager ?? null;
    } catch {
        return null;
    }
}

function cloneForTrace(v) {
    try {
        if (typeof structuredClone === 'function') return structuredClone(v);
    } catch { /* fall through */ }
    try {
        return JSON.parse(JSON.stringify(v));
    } catch {
        return Array.isArray(v) ? [...v] : { ...(v ?? {}) };
    }
}

/** Normalize one tool_calls entry from any transport into OpenAI shape. */
function normalizeCall(tc) {
    if (!tc || typeof tc !== 'object') return null;
    const fn = tc.function ?? {};
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) return null;
    return {
        id: typeof tc.id === 'string' && tc.id ? tc.id : `hub_${Math.random().toString(36).slice(2)}`,
        type: 'function',
        function: {
            name,
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        },
    };
}

function toOpenAIDef(tool) {
    if (tool && typeof tool.toFunctionOpenAI === 'function') {
        try {
            const d = tool.toFunctionOpenAI();
            if (d && (d.function?.name || d.name)) return d.type ? d : { type: 'function', function: d };
        } catch (e) {
            hubWarn(`Tool "${tool?.name}" toFunctionOpenAI failed, using fallback def:`, e?.message ?? e);
        }
    }
    return {
        type: 'function',
        function: {
            name: String(tool?.name ?? ''),
            description: String(tool?.description ?? ''),
            parameters: tool?.parameters && typeof tool.parameters === 'object'
                ? tool.parameters
                : { type: 'object', properties: {} },
        },
    };
}

/**
 * Resolve the runnable tool set: registry (filtered) + inline extras.
 * @returns {Promise<{ defs:Array, run:Map<string, function>, names:Array<string> }>}
 */
async function resolveTools(spec, TM) {
    const include = spec?.include ?? [];
    const exclude = new Set(spec?.exclude ?? []);
    const registry = TM && Array.isArray(TM.tools) ? TM.tools : [];
    const defs = [];
    const run = new Map();

    for (const tool of registry) {
        const name = tool?.name;
        if (!name || typeof name !== 'string') continue;
        if (include.length > 0 && !include.includes(name)) continue;
        if (exclude.has(name)) continue;
        try {
            if (typeof tool.shouldRegister === 'function' && !(await tool.shouldRegister())) continue;
        } catch {
            continue;
        }
        defs.push(toOpenAIDef(tool));
        run.set(name, async (args) => {
            const r = await TM.invokeFunctionTool(name, args);
            if (r instanceof Error) return { ok: false, result: `Tool "${name}" failed: ${r.message}` };
            return { ok: true, result: typeof r === 'string' ? r : JSON.stringify(r) };
        });
    }

    for (const t of spec?.extra ?? []) {
        if (run.has(t.name) && !t.override) {
            throw new HubError(
                `Inline tool "${t.name}" collides with a registered tool. Set override:true to replace it.`,
                'TOOL_CONFLICT',
            );
        }
        defs.push({
            type: 'function',
            function: { name: t.name, description: t.description ?? '', parameters: t.parameters },
        });
        const action = t.action;
        run.set(t.name, async (args) => {
            const r = await action(args);
            return { ok: true, result: typeof r === 'string' ? r : JSON.stringify(r ?? '') };
        });
    }
    return { defs, run, names: [...run.keys()] };
}

/** Single model round with per-step retry/timeout (hub owns both — callers must not wrap again). */
async function sendStep({ route, connection, model, presetName, messages, samplers, maxTokens, toolDefs, toolChoice, timeoutMs, retries, label, signal, defs, harness = null, extraHeaders = null, stream = false, onDelta = null }) {
    const { apiUrl = '', apiKey = '' } = connection ?? {};
    const maxT = Number(maxTokens ?? 1024) || 1024;
    const dispatch = async (sig) => {
        if (route === 'direct') {
            return await sendDirect({
                apiUrl, apiKey, model, messages, samplers, maxTokens: maxT,
                signal: sig, stream: !!stream,
                onChunk: stream ? (chunk) => { try { onDelta?.(chunk); } catch { /* ignore */ } } : null,
                preferProxy: defs.preferProxy !== false,
                tools: toolDefs, toolChoice,
                harness, extraHeaders,
            });
        }
        return await sendViaBackend({
            messages, model, presetName, samplers, maxTokens: maxT,
            signal: sig, onChunk: null, tools: toolDefs, toolChoice,
        });
    };
    return await retry(
        () => withAbortableTimeout((sig) => dispatch(sig), Number(timeoutMs) || 0, label, signal),
        { retries: Number(retries) || 0, delayMs: 1000, label },
    );
}

/**
 * Run an autonomous agent task from a NORMALIZED request (parseRequest output).
 * @returns {Promise<{content, reasoning, steps, meta}>}
 */
export async function runAgent(n) {
    if (!n || n.mode !== 'agent') {
        throw new HubError('runAgent requires a normalized agent-mode request (use hub.request).', 'INVALID_REQUEST');
    }
    const defs = readHubSettings();
    const label = n.label || n.consumer || 'hub agent run';
    const TM = getToolManager();

    const { samplers: effSamplers, source: samplerSource } = resolveSamplers({
        presetName: n.presetName, samplers: n.samplers, useOwnConfig: n.useOwnConfig,
    });

    let messages = n.messages;
    if (!messages) {
        messages = await buildMessages(
            { input: n.prompt.input ?? '', history: n.prompt.history ?? null, task: n.prompt.task ?? '{{input}}', prev: n.prompt.prev ?? {}, wi: n.prompt.wi ?? null },
            { useWI: !!n.opts.useWI, maxHistory: n.opts.maxHistory ?? 20, attachChat: n.opts.attachChat !== false },
        );
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new HubError('No messages to send.', 'INVALID_REQUEST');
    }

    const hasUrl = !!(n.connection.apiUrl && String(n.connection.apiUrl).trim());
    const route = hasUrl ? 'direct' : 'st-backend';
    const model = String(n.connection.model ?? '').trim();

    const { defs: toolDefs, run, names } = await resolveTools(n.tools, TM);
    if (toolDefs.length === 0) {
        throw new HubError(
            'Agent mode resolved zero tools. Register tools, allowlist existing ones, or pass tools.extra — or use mode:\'single\'.',
            'INVALID_REQUEST',
        );
    }
    if (route === 'st-backend') {
        let supported = false;
        try {
            supported = typeof TM?.isToolCallingSupported === 'function' ? !!TM.isToolCallingSupported() : false;
        } catch { /* ignore */ }
        if (!supported) {
            throw new HubError(
                'The current ST connection does not support tool calling (main API, function-calling toggle, or model). Use a direct tool-capable endpoint or mode:\'single\'.',
                'TOOLS_UNSUPPORTED',
            );
        }
    }
    hubWarn(`agent run [${label}]: route=${route}, profile=${n.profileName || 'none'}, tools=[${names.join(', ')}]`);

    // One stable harness identity for the whole run: same session id on
    // every step so harness-gated APIs see one continuous conversation.
    const effHarness = resolveEffectiveHarness(n.harness ?? null, { consumer: n.consumer ?? '' });
    const effExtra = (n.extraHeaders && typeof n.extraHeaders === 'object' && !Array.isArray(n.extraHeaders))
        ? n.extraHeaders
        : null;

    const maxSteps = Math.max(1, Number(n.limits?.maxSteps) || defs.defaultMaxSteps || 10);
    const uncapped = Number(n.limits?.maxSteps) === 0;
    const loopCap = uncapped ? 1000 : maxSteps;
    const totalMs = Number(n.limits?.totalTimeoutMs) || 0;
    const started = Date.now();
    const steps = [];
    const convo = [...messages];
    // Explicit opt-in only: agent rounds stay non-streamed unless the caller
    // set settings.stream:true on the direct route with an onRound trace.
    // (onRound alone must not flip wire semantics for other consumers.)
    const wantAgentStream = route === 'direct' && n.stream === true && typeof n.onRound === 'function';
    let usageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: null, currency: 'USD' };
    let lastRateLimits = [];
    const addUsage = (u) => {
        if (!u || typeof u !== 'object') return;
        usageTotals.promptTokens += Number(u.promptTokens) || 0;
        usageTotals.completionTokens += Number(u.completionTokens) || 0;
        usageTotals.totalTokens += Number(u.totalTokens) || 0;
        usageTotals.cachedTokens += Number(u.cachedTokens) || 0;
        usageTotals.reasoningTokens += Number(u.reasoningTokens) || 0;
        if (u.cost !== null && u.cost !== undefined && Number.isFinite(Number(u.cost))) usageTotals.cost = (usageTotals.cost ?? 0) + Number(u.cost);
        if (u.currency) usageTotals.currency = u.currency;
    };
    const roundTrace = (phase, payload = {}) => {
        try { n.onRound?.({ phase, at: Date.now(), ...payload }); } catch { /* ignore */ }
    };

    const checkBudget = () => {
        if (n.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (totalMs > 0 && Date.now() - started > totalMs) {
            const e = new HubError(`${label} exceeded total timeout (${totalMs}ms) at step ${steps.length + 1}.`, 'TIMEOUT', { retryable: true });
            e.partialSteps = steps;
            e.usage = { ...usageTotals };
            e.rateLimits = [...lastRateLimits];
            throw e;
        }
    };

    const isStreamFallbackable = (e) => {
        if (!e || e?.name === 'AbortError' || e?.code === 'ABORTED') return false;
        if (e?.code === 'EMPTY_RESPONSE') return true;
        if (e instanceof TypeError) return true;
        if ((e?.status === 400 || e?.status === 422) && /stream/i.test(String(e?.message ?? ''))) return true;
        return false;
    };

    for (let step = 1; step <= loopCap; step++) {
        checkBudget();
        const roundStarted = Date.now();
        roundTrace('request', {
            round: step,
            route,
            model,
            profile: n.profileName ?? '',
            presetName: n.presetName ?? '',
            samplers: cloneForTrace(effSamplers),
            maxTokens: n.maxTokens,
            toolChoice: n.tools?.choice ?? 'auto',
            tools: toolDefs.map((t) => t?.function?.name).filter(Boolean),
            messages: cloneForTrace(convo),
        });
        let out;
        try {
            const baseStep = {
                route, connection: n.connection, model, presetName: n.presetName, messages: convo,
                samplers: effSamplers, maxTokens: n.maxTokens,
                toolDefs, toolChoice: n.tools?.choice ?? 'auto',
                timeoutMs: n.timeoutMs, retries: n.retries, label, signal: n.signal, defs,
                harness: effHarness, extraHeaders: effExtra,
            };
            const runStreaming = () => sendStep({
                ...baseStep,
                stream: true,
                onDelta: (chunk) => roundTrace('delta', {
                    round: step,
                    text: String(chunk?.text ?? ''),
                    reasoning: String(chunk?.reasoning ?? ''),
                }),
            });
            if (wantAgentStream) {
                try {
                    out = await runStreaming();
                } catch (e) {
                    if (isStreamFallbackable(e)) {
                        hubWarn(`[${label}] agent stream failed (${e?.code ?? e?.message}), retrying non-streaming.`);
                        out = await sendStep({ ...baseStep, stream: false, onDelta: null });
                    } else {
                        throw e;
                    }
                }
            } else {
                out = await sendStep({ ...baseStep, stream: false, onDelta: null });
            }
        } catch (e) {
            if (e && typeof e === 'object') {
                if (e.usage && typeof e.usage === 'object') addUsage(e.usage);
                if (Array.isArray(e.rateLimits) && e.rateLimits.length) lastRateLimits = e.rateLimits;
                if (!('partialSteps' in e)) e.partialSteps = steps;
                e.usage = { ...usageTotals };
                e.rateLimits = [...lastRateLimits];
            } else if (e && !('partialSteps' in e)) {
                try { e.partialSteps = steps; } catch { /* ignore */ }
            }
            roundTrace('error', {
                round: step,
                durationMs: Date.now() - roundStarted,
                errorCode: e?.code ?? 'UNKNOWN',
                message: String(e?.message ?? e).slice(0, 500),
                rateLimits: Array.isArray(e?.rateLimits) ? e.rateLimits : [],
            });
            throw e;
        }
        addUsage(out?.usage);
        if (Array.isArray(out?.rateLimits) && out.rateLimits.length) lastRateLimits = out.rateLimits;
        roundTrace('response', {
            round: step,
            durationMs: Date.now() - roundStarted,
            content: String(out?.content ?? ''),
            reasoning: String(out?.reasoning ?? ''),
            toolCalls: (Array.isArray(out?.tool_calls) ? out.tool_calls : []).map((c) => ({
                id: c?.id ?? '',
                name: c?.function?.name ?? c?.name ?? '',
                arguments: c?.function?.arguments ?? c?.arguments ?? '{}',
            })),
            usage: out?.usage ?? null,
            rateLimits: Array.isArray(out?.rateLimits) ? out.rateLimits : [],
            status: Number(out?.status) || 0,
        });
        const calls = (Array.isArray(out?.tool_calls) ? out.tool_calls : []).map(normalizeCall).filter(Boolean);

        if (calls.length === 0) {
            const content = String(out?.content ?? '');
            const reasoning = String(out?.reasoning ?? '');
            if (!content.trim() && !reasoning.trim()) {
                const empty = new HubError('Endpoint returned an empty response.', 'EMPTY_RESPONSE');
                empty.partialSteps = steps;
                empty.usage = { ...usageTotals };
                empty.rateLimits = [...lastRateLimits];
                throw empty;
            }
            return {
                content, reasoning, steps,
                usage: usageTotals,
                rateLimits: lastRateLimits,
                meta: {
                    route, samplerSource, model, presetName: n.presetName ?? '',
                    profile: n.profileName ?? '',
                    stepsUsed: step, toolsUsed: names, consumer: n.consumer ?? '',
                },
            };
        }

        const results = [];
        for (const c of calls) {
            const name = c.function.name;
            let args = null;
            let argError = null;
            try {
                args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
            } catch (e) {
                argError = `Invalid JSON arguments: ${e?.message ?? e}`;
            }
            if (argError) {
                results.push({ id: c.id, name, ok: false, result: argError });
                continue;
            }
            const fn = run.get(name);
            if (!fn) {
                results.push({ id: c.id, name, ok: false, result: `Unknown tool "${name}". Available: ${names.join(', ')}` });
                continue;
            }
            try {
                const r = await fn(args);
                results.push({ id: c.id, name, ok: !!r.ok, result: String(r.result ?? '') });
            } catch (e) {
                results.push({ id: c.id, name, ok: false, result: `Tool "${name}" threw: ${e?.message ?? e}` });
            }
        }
        steps.push({
            step,
            text: String(out?.content ?? ''),
            reasoning: String(out?.reasoning ?? ''),
            toolCalls: calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
            results: results.map((r) => ({ id: r.id, name: r.name, ok: r.ok, result: r.result })),
        });
        try { n.onStep?.({ step, toolCalls: calls, results, text: String(out?.content ?? ''), reasoning: String(out?.reasoning ?? '') }); } catch { /* ignore */ }

        convo.push({ role: 'assistant', content: out?.content ?? null, tool_calls: calls });
        for (const r of results) {
            convo.push({ role: 'tool', tool_call_id: r.id, content: String(r.result ?? '') });
        }
    }

    const e = new HubError(
        uncapped
            ? `${label} reached the hub safety cap (${loopCap} rounds) without a final answer.`
            : `${label} reached maxSteps (${maxSteps}) without a final answer.`,
        'MAX_STEPS',
    );
    e.partialSteps = steps;
    e.usage = { ...usageTotals };
    e.rateLimits = [...lastRateLimits];
    throw e;
}

/** Discover currently registered tools (honors shouldRegister). */
export async function listTools() {
    const TM = getToolManager();
    const registry = TM && Array.isArray(TM.tools) ? TM.tools : [];
    const out = [];
    for (const tool of registry) {
        try {
            if (typeof tool.shouldRegister === 'function' && !(await tool.shouldRegister())) continue;
        } catch { continue; }
        out.push({
            name: tool?.name ?? '',
            displayName: tool?.displayName ?? tool?.name ?? '',
            description: String(tool?.description ?? ''),
        });
    }
    return out;
}
