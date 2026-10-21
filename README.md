# ST-RequestHub

## What is this?

Most of my other extensions need to talk to an AI model at some point —
Familiar needs to chat, Enhanced Lorebook's agents need to read and suggest.
Instead of each of them setting up its own connection, they all go through
this one shared backend.

That's all RequestHub is: one place where your model connections live, which
my other extensions borrow whenever they need to generate something. You set
up a connection once, and everything else just uses it.

## Which extensions use it?

- [Familiar](https://github.com/SamYTTK/ST-Familiar) — for its chats.
- [Enhanced Lorebook](https://github.com/SamYTTK/ST-EnhancedLorebook) — for
  its lorebook agents.

If either of those complains that the hub is missing, it means this extension
isn't installed or isn't switched on.

## Setting it up

1. In SillyTavern, go to **Extensions** → **Install from URL** and paste
   `https://github.com/SamYTTK/ST-RequestHub`, then enable it.
2. Open its settings and add an **API profile**: give it a name, the address
   of the service, your key, and the model you want. You can add several
   (say, a cheap one for everyday use and a stronger one for hard jobs).
3. That's it. Your other extensions will offer those profiles by name, and
   you pick one wherever you need it.

There's a test button to check a profile actually connects, and a usage
overview that shows which profiles and models have been used.

## Dependencies

None.

## Good to know

- RequestHub only runs requests. It never decides anything on its own and
  never writes anything anywhere — whatever asked it is responsible for what
  happens with the answer.
- Profiles can also carry **harness identity** (session id + user agent) for
  gated APIs such as OpenCode Go: point a profile at
  `https://opencode.ai/inference/openai/v1/chat/completions` with your
  service key and model, and the hub sends the required
  `x-opencode-session` header with a stable per-chat id automatically.
  Each profile also has a MODELS button that lists what the endpoint
  serves for its key, so you can pick a model instead of typing its id.
  Details in `HUB_Documentation.md` §5c (harness) and §9b (catalog).
- If a server lists models it *could* run instead of the ones it serves
  (ollama / llama.cpp do), give the profile an **allow-list** (comma-separated
  model ids) and the hub offers only those — and refuses any other model with
  a clear error. The same profile row also takes an explicit **catalog URL**
  when the model list does not live at `/v1/models`.
- Details in `HUB_Documentation.md` §5b (profiles).
- If you build extensions (or are an AI agent wiring one up), the technical
  manual is `HUB_Documentation.md` in this repo.
