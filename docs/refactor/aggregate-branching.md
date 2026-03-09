# Aggregate Branching

Use the aggregate fork as a shared Clawdbot integration repo with one stable rule:

- `main`: shared, merge-worthy Clawdbot changes that should be available to multiple environments.
- `env/<environment>`: environment-specific changes, experiments, or runtime-tied behavior that should not land in `main` by default.

## Recommended Flow

1. Build new work on the environment branch that owns the runtime, for example `env/<environment>`.
2. Validate there first.
3. Merge or cherry-pick into `main` only when the change is shared and safe for other environments.
4. Never force-push `main`.
5. Keep runtime state, secrets, and machine-local files ignored.

## Scope Rules

- Shared features:
  - provider/model support
  - reusable channel behavior
  - generic tooling
  - generic AI-KP abstractions
- Environment branches:
  - machine-specific deployment hooks
  - local gateway wiring
  - environment-only prompts/config
  - temporary experiments

## Merge Rule

If a change is useful beyond one environment, it should eventually be merged back into `main` after validation.
