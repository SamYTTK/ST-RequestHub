# ST-RequestHub — Documentation for Extension Developers (and Agents)

This file is the single source of truth for using the hub. If you are an AI
agent wiring another extension to the hub, **read this whole file first**.

## 1. What the hub is

`ST-RequestHub` is a shared LLM request backend for SillyTavern third-party
extensions. Any extension sends it a plain **JSON request** describing *what*
it wants (prompt, model, samplers, tools, limits). The hub validates the
request, builds the model call, runs it — once or autonomously over multiple
rounds — and hands the **final answer back**. The caller never touches HTTP,
API keys routing, presets, or prompt assembly.

The hub owns **execution only**. It owns no policy: no approvals, no write
gates, no dry-runs, no business rules. Rules and limitations belong to the
extension (or medium) that sends the request.

## 2. How to link to the hub

- The hub publishes a frozen global: `globalThis.STRequestHub`.
- It loads early (`loading_order: 5`), so by the time most extensions init,
  the global exists. Still, never assume — always probe:
  ```js
  const hub = globalThis.STRequestHub;
  const ready = !!hub
      && typeof hub.request === 'function'
      && (typeof hub.isReady !== 'function' || hub.isReady());
  ```
- The hub emits `hub:ready` on ST's `eventSource` when it registers, and
  exposes `hub.on('ready', cb)` / `hub.off(...)`. Re-check availability on
  `hub:ready` if you probed too early.
- **If the hub is missing or disabled, fall through gracefully.** Never crash
  the host extension: disable the hub-dependent feature, show a notice, or
  degrade to normal ST behavior. The hub being absent must never break a chat.
- Version tolerance: check `hub.apiVersion` (number, currently `6`) and the
  `hub.capabilities` array instead of hard-coding behavior. Require only the
  capabilities you use (`'request'`, `'decide'`, `'agent'`, `'tools'`,
  `'profiles'`, `'presets'`, `'stats'`, `'harness'`, …).
- `hub.version` is the package version (currently `1.6.0`).

## 3. Quick start (lorebook example)

```js
const hub = globalThis.STRequestHub;

// Single-turn: "use model X to do job Y"
const res = await hub.request({
    mode: 'single',
    input: { text: 'Summarize these lore entries: ...' },
    settings: {
        connection: { apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-…', model: 'gpt-4o-mini' },
        samplers: { temperature: 0.3, top_k: 40 },
        maxTokens: 1024,
    },
    consumer: 'EnhancedLorebook',
});
console.log(res.content); // final answer string

// Multi-turn agentic: model autonomously calls YOUR tools, then answers
const run = await hub.request({
    mode: 'agent',
    input: { text: 'Find outdated entries about X and propose rewrites.' },
    settings: {
        connection: { apiUrl: '…', apiKey: '…', model: 'gpt-4o' },
        samplers: { temperature: 0.2 },
    },
    tools: { include: ['LorebookSearch', 'LorebookGet', 'LorebookProposeRewrite'] },
    limits: { maxSteps: 10 },
    consumer: 'EnhancedLorebook',
    onStep: ({ step, toolCalls }) => console.log('step', step, toolCalls.map(t => t.function.name)),
});
console.log(run.content); // final answer
console.log(run.steps);   // auditable trace of every tool round
```

## 4. Full JSON request contract

```js
{
    mode: 'single' | 'agent' | 'decide', // default 'single'
    input: {
        text: '…',                     // required in single/agent, unless messages is given
        messages: [{ role, content }], // ready-made; takes precedence over text
        decide: {                       // DECIDE MODE ONLY — replaces text/messages (§4b)
            state: '…' | { … },        // required: the text/object to judge
            questions: {                // required: >= 1 typed question
                <id>: {
                    type: 'choice' | 'score' | 'noul',
                    instructions: '…',
                    criteria: { … } | […],
                },
            },
            options: {                  // optional: preset, task, lang, lang_guess,
                                        // min_confidence, max_len, head_max_len
            },
        },
        history: '…' | null,           // conversation text, or null to attach live chat
        task: '{{input}} …',           // template; {{input}} {{history}} {{prev:id}} {{wi}}
        prev: { agentId: '…' },        // previous outputs for {{prev:id}} stitching
        wi: '…' | null,                // world-info block override
        useWI: false,                  // fetch live world info when wi is null
        maxHistory: 20,
        attachChat: true,              // attach live chat when history is null
    },
    settings: {
        connection: {
            apiUrl: '…',               // OpenAI-compatible base URL; EMPTY = ST backend
                                        // (decide mode: decision-server URL, REQUIRED — §4b)
            apiKey: '…',               // per-request key (stored by the caller, never by the hub)
            model: '…',                // REQUIRED when apiUrl is set; optional override on backend route
            extraHeaders: { … },       // extra outbound headers, sanitized (§5c); explicit keys win
        },
        harness: {                      // harness identity for gated APIs, e.g. OpenCode Go (§5c)
            userAgent: '…',             // '' = hub default ('ST-RequestHub')
            sessionId: '…',             // stable per-conversation id; '' = auto by scope
            sessionScope: 'chat',       // 'chat'|'consumer'|'global'|'none'|'custom:<key>'
            sessionHeader: 'x-opencode-session',
            sendSessionHeader: true,
        },
        apiProfile: 'ProfileName',     // named hub profile (URL+key+model+harness); explicit fields win per field (§5b)
        preset: 'PresetName',          // ST chat-completion preset — IGNORED in decide mode (§4b)
        useOwnConfig: false,           // false = preset samplers win; true = samplers below win
        samplers: { … },               // full per-request config — see §5 (IGNORED in decide mode)
        maxTokens: 1024,               // IGNORED in decide mode
        timeoutMs: 90000,              // per model round (0 = off); hub default fills gaps
                                        // (decide: covers cold model loads, which take seconds)
        retries: 1,                    // network/429/5xx/timeout only (decide: +503 busy/loading)
        stream: false,                 // final-answer streaming callback (see §7; IGNORED in decide mode)
    },
    tools: {                           // AGENT MODE ONLY — rejected in single/decide mode
        include: ['ToolA'],            // allowlist over ST's ToolManager registry
        exclude: ['GenerateImage'],    // denylist, applied after include
        extra: [{                      // one-off inline tools, no global registration needed
            name: 'MyTool', displayName: '…', description: '…',
            parameters: { type: 'object', properties: { … } },  // JSON Schema
            action: async (args) => '…',  // JS function, runs in-page
            override: false,           // true to replace a same-named registered tool
        }],
        choice: 'auto',                // 'auto' | 'none' | { type:'function', function:{ name } }
    },
    limits: {                          // AGENT MODE ONLY
        maxSteps: 10,                  // model↔tool rounds; clamped to hub cap (default 25)
        totalTimeoutMs: 600000,        // whole-run wall clock (0 = off)
    },
    label: '…',                        // trace tag, shown in errors/logs
    consumer: 'YourExtensionName',      // trace tag: who sent this (ALWAYS SET THIS)
    // Runtime attachments (not JSON, passed alongside — never validated away):
    //   signal   AbortSignal for the whole request/run
    //   onChunk  ({ text, reasoning }) streaming callback (single mode final text)
    //   onStep   ({ step, toolCalls, results, text }) per agent round
}
```

Validation rules: unknown fields are **ignored with a warning** (forward
compatibility). Conflicts are hard errors (`INVALID_REQUEST` with a `details[]`
list): `tools`/`limits` with `mode:'single'` or `mode:'decide'`, unknown
`mode`, empty `input.text` without `messages` (single/agent), missing
`input.decide` (decide), malformed decide state/questions, decide without
`apiUrl`, URL-set-but-model-empty, nothing-to-send-with.
Use `hub.validateRequest(json)` → `{ ok, errors[] }` to pre-check without sending.

## 4b. Decide mode (Laya-style decision models)

`mode: 'decide'` routes classifying questions to a decision model (e.g. Laya
via Ollaya) instead of a chat-completion endpoint. A decision model never
generates text: it scores a **state** against typed **questions** in a single
forward pass (~10ms warm) and returns typed answers with calibrated
probabilities. Transport is the TypeSafe-compatible `POST /v1/systemone`
(served by both Ollaya and official `laya-serve`); the hub appends the path
when the profile URL is bare (`http://127.0.0.1:11435` → `…/v1/systemone`).

```js
const res = await hub.request({
    mode: 'decide',
    input: {
        decide: {
            state: 'I was charged twice. Please refund one charge.',
            questions: {
                department: {
                    type: 'choice',
                    instructions: 'Which team should handle this ticket?',
                    criteria: {
                        billing: 'Payments, invoices and refunds',
                        technical: 'Bugs, errors and outages',
                        account: 'Login, profile and settings',
                    },
                },
                urgency: {
                    type: 'score',
                    instructions: 'How urgent is this ticket?',
                    criteria: ['Can wait', 'Needs attention this week', 'Needs attention today'],
                },
                refund: { type: 'noul', instructions: 'The customer asks for money back.' },
            },
            options: { min_confidence: 0.7 }, // optional, only-when-set
        },
    },
    settings: { apiProfile: 'laya-local' }, // { apiUrl: 'http://127.0.0.1:11435', model: 'laya:en' }
    consumer: 'YourExtensionName',
});
console.log(res.answers.department.choice);        // 'billing'
console.log(res.answers.department.probabilities); // { billing: 0.85, … }
console.log(res.routing);                          // { model: 'laya:en', … } — why this checkpoint answered
```

Question types:

| Type | `criteria` | Answer fields |
|---|---|---|
| `choice` | object option→description, or label list; 2+ options (~125 max on `en`, ~250 multilingual) | `choice`, `confidence`, `probabilities` |
| `score` | ordered list of 2–10 levels | `score` (expected level), `confidence`, `legend`, `probabilities` |
| `noul` | optional `{true:'…', false:'…'}` | `noul`: probability the statement holds |

Decide-mode rules (enforced by validation, hard `INVALID_REQUEST` on violation):

- `input.decide` with non-empty `state` + ≥1 well-formed question is required;
  chat `text`/`messages`/history/task/WI fields are ignored with a warning.
- `settings.connection.apiUrl` (or an apiProfile supplying it) is **required** —
  decision models have no ST-backend route.
- `tools`/`limits` are rejected (agent mode only). `preset` / `samplers` /
  `useOwnConfig` / `maxTokens` / `stream` / `onChunk` / `onStep` are chat-mode
  concepts: warned and ignored, never sent.
- Response is `{ answers, routing, usage, meta }` with
  `meta: { route:'decide', model, profile, consumer }` — there is no content
  string. Server 422/413 (malformed question, too many options) surfaces as
  non-retryable `INVALID_REQUEST`; 503 busy/loading is retried (covers the
  on-demand first-request-of-the-day model load).
- There is also a low-level `hub.decide({ state, questions, options?,
  connection, timeoutMs?, retries?, signal?, label?, profileName?, consumer? })`
  mirroring `hub.generate()` — same result shape, for callers that already
  hold a resolved connection.

## 5. Model & sampler config (full per-request control)

Yes — the JSON fully controls model and sampling. `settings.connection.model`
picks the model; `settings.samplers` carries everything else. Every key is
**only-when-set**: omitted keys are never sent, so picky endpoints never see
parameters they don't understand.

| Sampler key | Direct route (own URL) | ST-backend route (empty URL) |
|---|---|---|
| `temperature`, `top_p`, `top_k`, `top_a`, `min_p` | ✅ sent | ✅ override preset payload |
| `frequency_penalty`, `presence_penalty`, `repetition_penalty` | ✅ sent | ✅ override preset payload |
| `seed` | ✅ sent | ✅ override preset payload |
| `stop` (string or string[]) | ✅ sent | ✅ override preset payload |
| `logit_bias` (object) | ✅ sent | ⚠️ passed through; backend may ignore |
| `response_format` (e.g. `{type:'json_object'}`) | ✅ sent | ⚠️ passed through; backend may ignore |
| `reasoning_effort` (`low`/`medium`/`high`) | ✅ sent | ⚠️ passed through; backend may ignore |
| `max_completion_tokens` | ✅ sent **instead of** `max_tokens` (for reasoning models that reject it) | n/a (uses `maxTokens`) |
| any other key | ❌ ignored by body builder | ⚠️ passed through; backend may ignore |

Sampler precedence (explicit JSON always wins over the preset):
`useOwnConfig: true` → preset ignored entirely, your `samplers` only.
`false` (default) → preset is the base, your `samplers` override it
key-by-key (`meta.samplerSource`: `'preset'`, `'merged'`, or `'own'`).
On the ST-backend route the preset applies first, then your sampler keys
override that payload per request — the active ST connection ultimately
interprets them, and some sources ignore some keys.

Related helpers: `hub.listPresets()`, `hub.getPresetSamplers(name)`,
`hub.resolveSamplers({presetName, samplers, useOwnConfig})`,
`hub.testConnection({apiUrl, apiKey, model})`.

## 5b. API profiles + the precedence system

API profiles are named connection presets stored in the hub's own settings:
`{ name, apiUrl, apiKey, model }`, plus one optional **default profile**. A
request selects one with `settings.apiProfile: 'Name'` — the name is the only
thing that travels; the hub resolves URL/key/model internally at send time.

**Connection precedence (per field — apiUrl, apiKey, model independently):**

1. Explicit JSON fields (`settings.connection.*`) — always win where non-empty.
2. Named profile (`settings.apiProfile`) — fills every blank the JSON leaves.
3. Hub default profile — fills remaining blanks when the request names none.
4. Empty — routes to the ST backend with server-stored keys.

Unknown profile names fail fast (`INVALID_REQUEST`, listing available names).
`meta.profile` reports which profile supplied the connection (`''` when none);
`meta` never contains a key. `hub.listApiProfiles()` returns
`[{ name, apiUrl, model, hasKey, isDefault }]` — metadata only, safe for any
consumer dropdown UI.

**Full precedence table (all axes):**

| Axis | Winner → loser |
|---|---|
| Connection + model | explicit JSON → named profile → default profile → ST backend |
| Samplers | explicit JSON keys → chat preset base → (nothing) |
| Preset on/off | `useOwnConfig: true` drops the preset entirely |
| Model source | presets never supply the model (rule, both routes) |
| Prompts | preset (backend route) + `input.task` template stitching |

**Plaintext caveat:** profiles live in ST's `settings.json` in plain text —
the same storage every ST extension (and ST itself) uses for keys. The hub
minimizes exposure (names travel, keys don't; masked settings UI; redacted
`validateRequest()` output) but anyone with file access to the server can read
them. Do not add extra key-handling code in consumers — send the profile name
and let the hub resolve it.

## 5c. Harness identity (gated APIs such as OpenCode Go)

Some providers only accept traffic that looks like it comes from a coding
harness instead of a generic HTTP client. The wire protocol stays
OpenAI-compatible — what they additionally require is **harness identity in
headers** (see OpenCode Go docs, "Where can I use it?"):

1. a stable **session id per conversation** (`x-opencode-session` on Go),
   used upstream for routing + prompt caching, and
2. a distinctive **`User-Agent`** (e.g. `my-coding-agent/1.0`) instead of a
   generic SDK / HTTP-library name.

The hub sends both whenever `settings.harness` (or the profile's harness
fields) carries them — on `single` AND `agent` modes, on every retry and
every agent step with the same id:

```js
// One-off request with an explicit session (the caller owns stability here)
const res = await hub.request({
    mode: 'single',
    input: { text: 'Refactor this function: …' },
    settings: {
        connection: {
            apiUrl: 'https://opencode.ai/inference/openai/v1/chat/completions',
            apiKey: '<service-account-key>',
            model: 'kimi-k2.6',
        },
        harness: {
            userAgent: 'MyExtension/1.0',
            sessionId: 'a-stable-uuid-per-conversation', // re-send SAME id next turn
        },
        maxTokens: 2048,
    },
    consumer: 'MyExtension',
});

// Easier: name a profile in the Hub Console (URL + key + model + optional
// session id / user agent) and let the hub resolve + auto-scope sessions:
const res2 = await hub.request({
    mode: 'agent',
    input: { text: 'Find and fix the bug described in the chat.' },
    settings: { apiProfile: 'opencode-go' },
    tools: { include: ['MySearchTool'] },
    limits: { maxSteps: 10 },
    consumer: 'MyExtension',
});
```

Rules that keep you off the abuse radar:

- **One id per conversation.** Default scope `'chat'` auto-generates and
  persists one id per `consumer + chat` and reuses it across all requests,
  retries and agent steps. `'consumer'` scopes per extension, `'global'`
  shares one id, `'custom:<key>'` scopes to your own key, `'none'` sends no
  auto id (explicit `sessionId` still wins). Never mint an id per request.
- **Pre-resolve when you need to display or correlate it:**
  `hub.ensureHarnessSession({ consumer: 'MyExtension', scope: 'chat' })`
  returns the same stored id the next send will use.
- **Routing:** harness requests prefer ST's `/proxy/` CORS proxy first
  (it forwards custom headers server-side; requires `enableCorsProxy` on
  the ST server for remote hosts), then fall back to direct `fetch`.
- **Browser honesty:** `fetch` cannot set `User-Agent` (forbidden header —
  silently dropped). The hub still attempts it and additionally sends the
  value as `x-harness-user-agent`. The **session header is the operative
  signal**; a browser UA is already a distinctive non-SDK identity.
- **`extraHeaders`** (`connection.extraHeaders`) carries any other
  `X-*` headers a gated API asks for. Values must be strings; auth/framing
  headers (`authorization`, `content-type`, `host`, …) are dropped with a
  warning. Explicit keys beat profile keys per key.
- Full endpoint paths are preserved (`…/responses`, `…/messages`,
  `:generateContent`, …) — only bare hosts / `/v1` get
  `/v1/chat/completions` appended.
- Agent mode with a focused tool allowlist is the closest traffic shape to
  a coding harness; single-shot calls should share the conversation's
  session id and a stable system-prompt prefix for cache hits.
- Decide mode ignores harness/extra headers (decision endpoints need none).

## 6. Tools (agent mode)

- Tool source is ST core's `ToolManager` registry — the same one
  user-facing chat tool-calling uses. Any extension can
  `getContext().registerFunctionTool({name, displayName, description,
  parameters, action})` and the hub can call it. Precedent: the
  `stable-diffusion` extension's `GenerateImage` tool.
- Per run, scope with `tools.include` / `tools.exclude`, or skip global
  registration and pass `tools.extra` inline. Omit `tools` entirely to expose
  everything registered (each tool's own `shouldRegister()` is still honored).
- Name collisions between `extra` and the registry throw `TOOL_CONFLICT`
  unless the extra sets `override: true`.
- The model needs **native function calling**. Without it the run fails fast
  with `TOOLS_UNSUPPORTED` — there is no text-parsing fallback. On the direct
  route this is detected when the endpoint rejects `tools`; on the backend
  route it is gated on the ST connection's tool support.
- Agent mode with zero resolved tools is `INVALID_REQUEST` (use single mode).
- Tool failures are returned to the model as error tool messages so it can
  recover next round; unknown/hallucinated tool names are reported the same way.

## 7. Responses

Single mode → `{ content, reasoning, meta }`.
Agent mode → `{ content, reasoning, steps, meta }`, where each step is
`{ step, text, toolCalls: [{id, name, arguments}], results: [{id, name, ok, result}] }`
and `meta` is `{ route, samplerSource, model, presetName, profile,
stepsUsed, toolsUsed[], consumer }` (`profile` is `''` when no profile was
involved; the key itself never appears anywhere).
Decide mode → `{ answers, routing, usage, meta }`, where `answers` maps each
question id to its typed answer (`choice`/`score`/`noul` + `confidence` +
`probabilities`), `routing` says which checkpoint answered and why, and
`meta` is `{ route:'decide', model, profile, consumer }`.

- Failures **throw** `hub.HubError` with `.code` (and `.details[]` for
  `INVALID_REQUEST`, `.partialSteps[]` for `MAX_STEPS`/`TIMEOUT` mid-run).
  Error codes: `INVALID_REQUEST`, `CONFIG`, `TOOLS_UNSUPPORTED`,
  `TOOL_CONFLICT`, `MAX_STEPS`, `EMPTY_RESPONSE`, `TIMEOUT`, `ABORTED`,
  `NETWORK`, `HTTP_4xx/5xx`.
- The hub **never writes to chat**. Committing results (chat messages,
  lorebook edits, UI updates) is the caller's job — e.g. LayeredAgents commits
  via `saveReply`; a lorebook flow shows the proposed rewrite in its own
  verification UI.
- Streaming (`stream: true` + `onChunk`) covers the **final answer text only**;
  intermediate agent rounds are non-streamed. `onStep` reports round progress.

## 8. Capabilities and limitations (read carefully)

**Can do:** single-turn generation on any OpenAI-compatible endpoint or the ST
backend; multi-round autonomous tool loops; harness-identified requests for
gated APIs (stable session id + user agent + extra headers, §5c); typed
decisions on Laya-style decision endpoints (`mode:'decide'`, §4b); per-request model + full sampler
config; preset-driven or own-config sampling; registry + inline tools with
per-run scoping; retry/timeout/stream-fallback ownership; token helpers
(`countTokens`, `fitBudget`), prompt assembly (`buildMessages`),
world-info fetch, connection test.

**Cannot / will not do:**
- No policy of any kind: approvals, write gates, dry-runs, budgets-as-rules.
  The caller enforces its own. (Lorebook rewrites, for example, must go
  through that extension's own verification UI — the hub just returns text.)
- No chat writes, no swipes, no message edits, no group-room handling, no
  attachments/vision input. The hub returns data; the caller acts on it.
- No text-based (ReAct-style) tool fallback for models without function
  calling — such runs fail with `TOOLS_UNSUPPORTED` by design.
- No cross-request memory: each `request()` is stateless. Multi-step plans
  spanning separate requests are the caller's orchestration, not the hub's.
- ST-backend sampler support depends on the user's active connection; some
  sources ignore some keys (§5 table). When exact sampling matters, prefer the
  direct route with an explicit model + samplers.
- The hub stores no API keys and keeps no per-consumer state; hub settings
  hold only shared defaults (timeouts, retries, step caps) plus aggregate
  usage counters (§9).

## 9. Console + usage stats

The extension drawer is a slim launcher (`OPEN CONSOLE` button); the real UI
is the **Hub Console**, an in-page popup (`POPUP_TYPE.DISPLAY`, wide+large)
with three tabs: **01 OVERVIEW** (status, traffic, latency sparkline,
by-mode/consumer/profile breakdowns, live recent-requests table),
**02 PROFILES** (create/save/test/delete, default profile), **03 SETTINGS**
(defaults + agent caps + preset check). Open it programmatically with
`hub.openConsole()` (requires the `'console'` capability).

Every `request()` — all modes — records a metadata-only usage entry:
`{ tsStart, tsEnd, durationMs, consumer, label, mode, route, model, profile,
ok, errorCode }`. Prompt text, messages, answers and keys are **never**
captured. Aggregates persist in the hub's extension settings; the recent-100
ring is session-only.

```js
hub.getUsageStats();       // { requests, errors, totalMs, avgMs, byMode,
                           //   byConsumer, byRoute, byProfile, byError,
                           //   startedAt, recentKept, recentCap }
hub.getRecentRequests(20); // newest-first session ring (max 100)
hub.clearUsageStats();     // reset counters + ring
```

Capabilities for this area: `'stats'`, `'console'`. Profile TEST buttons use
`hub.testConnection()` for chat endpoints and `hub.testDecideConnection()`
for Laya-style ones (auto-selected per profile).

## 10. Instructions for future agents integrating with the hub

1. **Read this file and the live `hub.capabilities` before designing.** If the
   hub already does what you need, use it as-is.
2. **Keep ALL policy in your extension.** Never ask the hub to approve, gate,
   confirm, or restrict — that is your UI's job around the `request()` call.
3. **Never fork, copy, or work around the hub.** Do not duplicate its HTTP,
   preset, retry, or loop code into your extension. If the hub lacks something
   you need (a sampler key, a helper, a transport behavior):
   - **STOP and explicitly ask the user to have it implemented in the hub**,
     generically, for all consumers — not just for your extension.
   - The hub must stay the single generic execution layer; one-off local
     reimplementations rot and diverge.
4. **Contract discipline:** always set `consumer`, always set a `label` for
   non-trivial runs, pre-check with `validateRequest()` when building requests
   dynamically, sniff `apiVersion`/`capabilities` instead of assuming, and
   handle every `HubError` code your flow can hit (at minimum
   `INVALID_REQUEST`, `TOOLS_UNSUPPORTED`, `MAX_STEPS`, `TIMEOUT`).
5. **Test without a live chat session running user-facing work:** stub
   `SillyTavern.getContext()` and `fetch` in an isolated harness (see
   `hubtest/` notes in the repo history), `node --check` every touched file,
   and never degrade behavior when the hub is absent.
