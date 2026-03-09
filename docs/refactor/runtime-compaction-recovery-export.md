# Runtime Compaction Recovery Export

This note documents the runtime-only compaction recovery enhancement added in this environment.

Goal:

- before auto-compaction, write a small recovery surface to disk
- after compaction, make the next turn re-read that recovery surface before continuing
- keep the solution workspace-scoped instead of patching Clawdbot core

## What this enhancement does

There are 3 parts.

### 1. Stronger pre-compaction memory flush

The runtime config adds a custom `agents.defaults.compaction.memoryFlush` prompt.

Behavior:

- rewrite `memory/session-state.md` before compaction
- write durable facts to `memory/YYYY-MM-DD.md`
- tell future turns to read the recovery file first after compaction

### 2. Workspace recovery rule

The workspace `AGENTS.md` is extended so that when context feels thin, after a long gap, or after compaction, the agent should read:

1. `memory/session-state.md`
2. today's and yesterday's `memory/YYYY-MM-DD.md`
3. `memory/chatlog/*.md` if conversation-specific detail is still missing

### 3. Session-skill recovery order

The `session-skill` recovery flow is adjusted so compaction recovery uses:

1. `memory/session-state.md`
2. daily notes
3. `memory/chatlog`
4. raw session `.jsonl` only as audit/fallback

## Files to copy

Copy these runtime workspace files:

- `.runtime/workspace/AGENTS.md`
- `.runtime/workspace/skills/session-skill/SKILL.md`
- `.runtime/workspace/memory/session-state.md`

Do not blindly copy this file from the source machine:

- `.runtime/config/clawdbot.json`

That file contains live secrets and machine-specific values.

Instead, copy only the sanitized config fragment below into the target machine's Clawdbot config.

## Sanitized config fragment

Add this under `agents.defaults.compaction` in the target runtime config:

```json
{
  "mode": "safeguard",
  "memoryFlush": {
    "enabled": true,
    "softThresholdTokens": 12000,
    "prompt": "Pre-compaction memory flush. Before context is compacted, do these in order: 1) Rewrite `memory/session-state.md` as the primary recovery file for the current work thread. Keep it concise and include: current focus, latest user intent, active constraints/preferences, open loops, files/paths/commands worth reopening, and the next concrete steps. 2) Write durable facts, decisions, and outcomes into `memory/YYYY-MM-DD.md`. 3) If older conversation details may be needed after compaction, add a short recovery note in `memory/session-state.md` telling future-you to read `memory/session-state.md` first, then today's and yesterday's daily notes, then search `memory/chatlog/*.md` if conversation-specific detail is still missing. 4) Do not append junk logs; keep the recovery surface short and overwrite-in-place. If nothing meaningful changed, reply with NO_REPLY.",
    "systemPrompt": "Pre-compaction recovery turn. The session is near auto-compaction. Your job is not to chat; your job is to leave a clean recovery trail. After compaction, assume the next turn may have lost fine-grained chat memory. Future-you should be able to recover by reading `memory/session-state.md`, then `memory/YYYY-MM-DD.md` plus yesterday's note, then `memory/chatlog/*.md` if needed. Keep the written recovery state short, factual, and actionable. Usually NO_REPLY is correct."
  }
}
```

If the target machine already has `mode: "safeguard"`, only merge in `memoryFlush`.

## Exact file responsibilities

### `memory/session-state.md`

Purpose:

- first recovery surface after compaction
- short overwrite-in-place task/thread snapshot

Expected contents:

- current focus
- latest user intent
- active constraints and preferences
- open loops
- useful paths
- next concrete steps

This file must stay short. It is not a transcript.

### `AGENTS.md`

Purpose:

- make the agent check `memory/session-state.md` automatically when context is thin
- define the recovery order in plain language

### `skills/session-skill/SKILL.md`

Purpose:

- make session-history recovery follow the same order
- ensure compaction recovery prefers clean derived archives instead of raw transcripts

## Recommended install steps on another machine

1. Stop or restart the gateway after editing runtime config.
2. Copy the 3 workspace files listed above.
3. Merge the sanitized `memoryFlush` config into the target `.clawdbot/clawdbot.json`.
4. Ensure the target workspace already has:
   - `memory/`
   - `skills/session-skill/`
   - `memory/chatlog/` if using the clean archive workflow
5. Restart the gateway.

## Verification

After restart, check:

1. `clawdbot cron list`
   - optional; only needed if the target machine also uses the `session-skill` rollup cron flow
2. `clawdbot channels status --probe`
3. inspect the runtime config and confirm `agents.defaults.compaction.memoryFlush` is present
4. confirm `memory/session-state.md` exists

## Runtime-only scope

This enhancement is not a core Clawdbot plugin package.

It is:

- runtime workspace instructions
- runtime config
- session-skill behavior

That means it is easy to migrate between personal machines, but it is not yet a clean standalone extension package.

## Source of truth in this repo

- `.runtime/workspace/AGENTS.md`
- `.runtime/workspace/skills/session-skill/SKILL.md`
- `.runtime/workspace/memory/session-state.md`
- `docs/refactor/runtime-compaction-recovery-export.md`
