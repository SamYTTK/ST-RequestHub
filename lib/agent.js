import { HubError } from './util.js';
import { hubWarn, withAbortableTimeout, retry } from './net.js';
import { resolveSamplers } from './preset.js';
import { sendDirect } from './direct.js';
import { sendViaBackend } from './service.js';
import { buildMessages } from './messages.js';
import { readHubSettings } from './request.js';

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
async function sendStep({ route, connection, model, presetName, messages, samplers, maxTokens, toolDefs, toolChoice, timeoutMs, retries, label, signal, defs }) {
    const { apiUrl = '', apiKey = '' } = connection ?? {};
    const maxT = Number(maxTokens ?? 1024) || 1024;
    const dispatch = async (sig) => {
        if (route === 'direct') {
            return await sendDirect({
                apiUrl, apiKey, model, messages, samplers, maxTokens: maxT,
                signal: sig, stream: false,
                preferProxy: defs.preferProxy !== false,
                tools: toolDefs, toolChoice,
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

    const maxSteps = Math.max(1, Number(n.limits?.maxSteps) || defs.defaultMaxSteps || 10);
    const totalMs = Number(n.limits?.totalTimeoutMs) || 0;
    const started = Date.now();
    const steps = [];
    const convo = [...messages];

    const checkBudget = () => {
        if (n.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (totalMs > 0 && Date.now() - started > totalMs) {
            const e = new HubError(`${label} exceeded total timeout (${totalMs}ms) at step ${steps.length + 1}.`, 'TIMEOUT', { retryable: true });
            e.partialSteps = steps;
            throw e;
        }
    };

    for (let step = 1; step <= maxSteps; step++) {
        checkBudget();
        let out;
        try {
            out = await sendStep({
                route, connection: n.connection, model, presetName: n.presetName, messages: convo,
                samplers: effSamplers, maxTokens: n.maxTokens,
                toolDefs, toolChoice: n.tools?.choice ?? 'auto',
                timeoutMs: n.timeoutMs, retries: n.retries, label, signal: n.signal, defs,
            });
        } catch (e) {
            if (e && !('partialSteps' in e)) e.partialSteps = steps;
            throw e;
        }
        const calls = (Array.isArray(out?.tool_calls) ? out.tool_calls : []).map(normalizeCall).filter(Boolean);

        if (calls.length === 0) {
            const content = String(out?.content ?? '');
            const reasoning = String(out?.reasoning ?? '');
            if (!content.trim() && !reasoning.trim()) {
                throw new HubError('Endpoint returned an empty response.', 'EMPTY_RESPONSE');
            }
            return {
                content, reasoning, steps,
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
            toolCalls: calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
            results: results.map((r) => ({ id: r.id, name: r.name, ok: r.ok, result: r.result })),
        });
        try { n.onStep?.({ step, toolCalls: calls, results, text: String(out?.content ?? '') }); } catch { /* ignore */ }

        convo.push({ role: 'assistant', content: out?.content ?? null, tool_calls: calls });
        for (const r of results) {
            convo.push({ role: 'tool', tool_call_id: r.id, content: String(r.result ?? '') });
        }
    }

    const e = new HubError(`${label} reached maxSteps (${maxSteps}) without a final answer.`, 'MAX_STEPS');
    e.partialSteps = steps;
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
