---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects the models Pi can launch and writes the role map that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write the pstack role map, the file that sets pstack's model per role. The `pi-pstack` extension owns the file format and the resolution rules; this skill is the interactive flow around `/setup-pstack`.

## Steps

### 1. Detect the available models

The models Pi can launch are the ones whose provider has working credentials. `/setup-pstack` reads that set from the session's model registry, so it never writes a model that fails at spawn time. If you need the list by hand, read it from `/pstack-models`, which prints every role and the model it resolves to.

A model id is `provider/id`. A bare id works when it is unique in the catalog. The aliases `inherit-parent` and `auto` are always valid even though they are not detected ids.

### 2. Load the current state

The stored role map is at `~/.pi/agent/state/pi-pstack/models.json`. Read it and treat its `budget` field and its role values as the current choices. If it does not exist, start from the skill defaults.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer `ask_user_question` over free text. Offer these four options with these exact labels, and name the current budget when the map records one. With no map, say that `large` matches the skill defaults.

- `unlimited — max reasoning`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** The budget sets the reasoning effort of every role's model, panel entries included.

- `unlimited` sets the effort to `max`.
- `large` sets it to `xhigh`.
- `medium` sets it to `high`.
- `small` sets it to `medium`.

Pi carries the effort as a suffix on the model id, so a role's model is `provider/id:level`. The level is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. When the model does not declare the budget's level, use its highest declared level at or below the target, so a role never runs above the budget the user chose. `inherit-parent` and `auto` do not change, because they name no model of their own.

On a re-run, keep any role the user changed by family, list, or alias.

**(c) Show the roles and confirm.** Show every role with its model, marking any role whose configured model is not available as needing a choice. Also list each role you dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat model) as the options. Prefer `ask_user_question` over free text.

For panel roles (`arena runners`, `architect runners`, `interrogate reviewers`) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real model written must be one the session can launch. `inherit-parent` and `auto` always pass. If a chosen model is not available, stop and ask again.

### 5. Write the map

`/setup-pstack` writes the map. Write it by hand only when the command is unavailable; the format is the same either way. The file is JSON at `~/.pi/agent/state/pi-pstack/models.json`. Overwrite the whole file so re-runs stay idempotent.

```json
{
  "budget": "large",
  "roles": {
    "feature, refactoring": "openrouter/some-model:xhigh",
    "bug-fix": "openrouter/some-model:xhigh",
    "perf-issue": "openrouter/some-model:xhigh",
    "hillclimb": "openrouter/some-model:xhigh",
    "judgment and prose": "anthropic/some-model:xhigh",
    "hardest tasks": "anthropic/some-model:xhigh",
    "how explorer": "openrouter/some-model:xhigh",
    "how explainer": "anthropic/some-model:xhigh",
    "why investigators": "openrouter/some-model:xhigh",
    "why synthesizer": "anthropic/some-model:xhigh",
    "reflect tooling": "openrouter/some-model:xhigh",
    "reflect judgment, divergent, synthesizer": "anthropic/some-model:xhigh",
    "arena runners": ["anthropic/some-model:xhigh", "openrouter/some-model:xhigh"],
    "arena cross-judge pool": ["anthropic/some-model:xhigh", "openrouter/some-model:xhigh"],
    "swarm workers": "openrouter/some-model:xhigh",
    "architect runners": ["anthropic/some-model:xhigh", "openrouter/some-model:xhigh"],
    "interrogate reviewers": ["anthropic/some-model:xhigh", "openrouter/some-model:xhigh"]
  }
}
```

A role's value is one model id, or a list for a panel role. `inherit-parent` and `auto` are valid values, and an alias entry in a panel list still counts toward its fan-out.

### 6. Confirm

Tell the user the map was written and that it applies to new sessions. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill`. On no, move on without pushing.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /create-formal-verification-skill." On yes, invoke `/create-formal-verification-skill`. On no, move on without pushing.
