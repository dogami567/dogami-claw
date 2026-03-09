# AI-KP Memory And Context Export Notes

This note summarizes the current AI-KP memory/context stack in this workspace, what is already reusable, what is still coupled to the `onebot` extension, and the minimum file set to export for other Clawdbot installs.

## 1. Current stack

There are two layers.

### Layer A: runtime persistence layer

Source repo:

- `.runtime/workspace/clawd-ai-kp`

Main files:

- `.runtime/workspace/clawd-ai-kp/adapter/onebot/log-store.js`
- `.runtime/workspace/clawd-ai-kp/adapter/onebot/single-session.js`
- `.runtime/workspace/clawd-ai-kp/adapter/onebot/runtime.js`

Responsibilities:

- append raw inbound/outbound chat logs
- append operation ledger logs
- append per-player operation logs
- write latest state snapshot
- write latest context snapshot
- auto-roll up older chat into summary chunks
- expose save/archive/resume/new-line state
- provide the runtime prompt used by AI-KP mode

This layer is already close to a standalone package because it is its own git repo and does not depend on Clawdbot internals for the actual persistence logic.

### Layer B: Clawdbot OneBot semantic bridge

Source repo:

- `extensions/onebot`

Main files:

- `extensions/onebot/src/ai-kp-context.ts`
- `extensions/onebot/src/ai-kp-tool.ts`
- `extensions/onebot/src/ai-kp-semantic-scene.ts`
- `extensions/onebot/src/ai-kp-scene-rules.ts`
- `extensions/onebot/src/monitor.ts`

Responsibilities:

- resolve where the AI-KP runtime lives on disk
- read the latest context packet and meta state
- inject persona + scene state + recent logs + tool guide into the OneBot system prompt
- expose AI-KP tools to the model
- let the model call `session`, `roll`, `sceneTurn`, `history`
- merge AI-KP prompt blocks into the normal OneBot reply path

This layer is reusable, but it is not yet a separately published extension package. It currently lives inside the built-in `onebot` extension and uses Clawdbot plugin APIs directly.

### Layer C: Clawdbot native memory/session system

Source repo:

- `src/memory`
- `src/auto-reply/reply`

Main files:

- `src/memory/manager.ts`
- `src/auto-reply/reply/agent-runner-memory.ts`
- `src/config/types.agent-defaults.ts`

Responsibilities:

- workspace memory indexing
- `memory_search` and `memory_get` style retrieval
- pre-compaction memory flush
- session compaction tracking

This is not part of the custom AI-KP plugin work. It is Clawdbot core.

## 2. What is actually being persisted now

The custom AI-KP stack currently persists these artifacts per conversation:

- `sessions/<conversation>.json`
  - active AI-KP session state
- `meta/<conversation>.json`
  - mode, archive history, story-pack selection, pending choices, summary state
- `logs/<conversation>/chat/events.jsonl`
  - raw player messages and AI replies
- `logs/<conversation>/ledger/operations.jsonl`
  - structured operation timeline
- `logs/<conversation>/players/*.jsonl`
  - per-player operation chains
- `logs/<conversation>/state/latest.json`
  - latest reduced state snapshot
- `logs/<conversation>/context/latest.json`
  - latest context packet used for prompt injection
- `logs/<conversation>/summaries/*.md`
  - rolled-up summary chunks after thresholds are hit
- `archives/<conversation>/<save-id>/...`
  - archived saves for resume/new-line flows

## 3. What each custom module does

### `log-store.js`

Key functions:

- `appendChatLog`
- `appendOperationLog`
- `appendPlayerOperationLogs`
- `writeStateSnapshot`
- `writeContextSnapshot`
- `buildContextPacket`
- `maybeRollupSummaries`

What it gives you:

- append-only chat log
- append-only action ledger
- player-specific state-machine style logs
- automatic summary chunk generation
- a compact context packet that can be re-injected before the next reply

This is the cleanest part to export.

### `single-session.js`

Key functions:

- `getKpRuntimePrompt`
- `buildStorageLayoutFromConversationKey`
- `ensureConversationControlState`
- `loadConversationContext`
- `handleOneBotMessage`
- `archiveConversationState`
- `restoreArchivedConversation`

What it gives you:

- single conversation runtime
- session mode management
- save/archive/resume/new-line support
- runtime prompt/persona source
- natural-intent handling inside the AI-KP runtime path

This is also exportable, but it brings more game/runtime behavior with it than `log-store.js`.

### `ai-kp-context.ts`

Key functions:

- `resolveOneBotAiKpConfig`
- `resolveOneBotAiKpBaseDir`
- `loadOneBotAiKpContextPacket`
- `loadOneBotAiKpContext`
- `mergeOneBotGroupSystemPrompt`

What it gives you:

- auto-discovery of the external AI-KP runtime repo
- reading current AI-KP mode and current context packet
- construction of the injected prompt block
- an idle prompt block and an active prompt block
- optional log-path hint injection

Important detail:

- this file is where the prompt is assembled as `persona -> player/session context -> recent chat/ops -> tool guide`

### `ai-kp-tool.ts`

Main tool surface:

- `session`
- `roll`
- `sceneTurn`
- `history`

What it gives you:

- semantic control surface for the model
- persistence after tool execution
- context packet refresh after each meaningful action
- history re-read path after compaction

Important detail:

- `history` is the bridge that lets the model recover older context after compaction by reading summaries/recent logs instead of depending only on the live chat window

### `monitor.ts`

What it gives you:

- injects the AI-KP prompt block into OneBot group handling
- can bypass mention gating when a session is already active
- keeps AI-KP behavior scoped to the current conversation

This is the part that makes the feature feel native inside Clawdbot.

## 4. Can it be exported separately

Yes, but there are two different answers.

### Option A: export only the runtime persistence layer

Recommended if your goal is:

- let other people reuse the memory/log/context system
- let their own Codex or agent read and write the same artifacts
- keep their channel integration custom

Export these:

- `.runtime/workspace/clawd-ai-kp/adapter/onebot/log-store.js`
- `.runtime/workspace/clawd-ai-kp/adapter/onebot/single-session.js`
- `.runtime/workspace/clawd-ai-kp/adapter/onebot/runtime.js`
- required `core/` modules and `data/` files used by `single-session.js`

This is the easiest path because the repo already exists independently as `clawd-ai-kp`.

### Option B: export the full Clawdbot-side integration

Recommended if your goal is:

- let other people drop the same AI-KP experience into Clawdbot
- keep prompt injection, tools, and OneBot wiring working out of the box

Export these:

- `extensions/onebot/src/ai-kp-context.ts`
- `extensions/onebot/src/ai-kp-tool.ts`
- `extensions/onebot/src/ai-kp-semantic-scene.ts`
- `extensions/onebot/src/ai-kp-scene-rules.ts`
- `extensions/onebot/src/ai-kp-shared.ts`
- `extensions/onebot/src/ai-kp-runtime.ts`
- the `monitor.ts` integration points
- the external `clawd-ai-kp` runtime repo

This is absolutely doable, but to make it clean for others you should extract it into a dedicated extension package instead of leaving it half inside `extensions/onebot`.

## 5. Recommended packaging strategy

For distribution to other people, the clean split should be:

### Package 1: `clawd-ai-kp-runtime`

Contents:

- log store
- single-session runtime
- story-pack and scene runtime assets
- archive/save/resume support

Contract:

- input: conversation key, raw message, runtime options
- output: reply text, operation events, refreshed context packet

### Package 2: `clawdbot-extension-onebot-aikp`

Contents:

- prompt/context injector
- AI-KP tool registration
- semantic scene router
- OneBot monitor hook glue

Contract:

- reads/writes `clawd-ai-kp-runtime`
- injects tool guide and context packet into OneBot conversation turns

This split makes the runtime reusable even outside OneBot, and keeps the Clawdbot-specific part thin.

## 6. What is already standalone vs still coupled

Already standalone enough:

- `.runtime/workspace/clawd-ai-kp`

Still coupled to current repo structure:

- `extensions/onebot/src/ai-kp-context.ts`
- `extensions/onebot/src/ai-kp-tool.ts`
- `extensions/onebot/src/monitor.ts`

Main coupling points:

- imports from `clawdbot/plugin-sdk`
- OneBot monitor flow and session routing
- config lookup under `channels.onebot.aiKp`
- runtime path resolution that assumes the `clawd-ai-kp` repo is present nearby

## 7. Minimum shareable export right now

If you want to send something to another person today without more refactor, send these two things together.

### Part 1: external runtime repo

- the full `clawd-ai-kp` repo

### Part 2: Clawdbot patch set

- `extensions/onebot/src/ai-kp-context.ts`
- `extensions/onebot/src/ai-kp-tool.ts`
- `extensions/onebot/src/ai-kp-semantic-scene.ts`
- `extensions/onebot/src/ai-kp-scene-rules.ts`
- `extensions/onebot/src/ai-kp-shared.ts`
- `extensions/onebot/src/ai-kp-runtime.ts`
- `extensions/onebot/src/monitor.ts`

That is the smallest practical "works like your current setup" bundle.

## 8. Bottom line

If the question is "can it be separated", the answer is yes.

If the question is "is it already a clean installable plugin for strangers", the answer is not yet.

Right now:

- the runtime/log/context half is already close to independent
- the Clawdbot/OneBot half still needs one more extraction pass to become a clean standalone extension

If we want, the next concrete step should be:

1. extract the AI-KP bridge code from `extensions/onebot` into a dedicated extension package
2. keep `clawd-ai-kp` as the runtime repo
3. define a tiny filesystem/API contract between the two
4. write install instructions for "drop runtime repo here, enable extension here"
