---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects the models Pi can launch and writes the role map that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

The pstack role map sets the model each pstack role runs on and the reasoning budget for all of them. The `pi-pstack` extension owns it: `/setup-pstack` writes it, `/pstack-models` shows it, and the `pstack_models` tool returns it resolved.

## Steps

### 1. Hand the user the command

`/setup-pstack` is the user's command. You cannot type slash commands. Tell the user to run it, with the budget as its argument when they already named one:

```text
/setup-pstack large
```

The command detects the models the session can launch, asks for a budget when none was given, keeps every role the user set before whose model is still available, lets the user confirm or change each role, and writes the map. A budget argument only skips the budget question; with dialog UI the user still confirms the roles.

### 2. Explain the budget when asked

The budget caps the reasoning level of every role's model, panel seats included.

- `unlimited — max reasoning`
- `large — xhigh reasoning` (upstream pstack's default)
- `medium — high reasoning`
- `small — medium reasoning`

The budget is stored once. Role values carry no level; a role resolves to the highest level its model supports at or below the budget. A model that offers only levels above the budget runs at its lowest one and is reported as above budget.

### 3. Show the current map when asked

Call the `pstack_models` tool. It returns the budget, whether the map is the user's stored map or defaults, and each role's seats with the level applied.

### 4. Write the map by hand only when the command is unavailable

Ask the user first. The file is JSON at `~/.pi/agent/state/pi-pstack/models.json`. Write all of it, so a re-run stays idempotent. A role's value is a `provider/id` model id, a list of them for a panel role, or `inherit-parent` / `auto` for the parent chat model. An alias in a panel still counts as a seat.

```json
{
  "budget": "large",
  "roles": {
    "feature, refactoring": { "value": "openai/gpt-6-sol" },
    "bug-fix": { "value": "openai/gpt-6-sol" },
    "perf-issue": { "value": "openai/gpt-6-sol" },
    "hillclimb": { "value": "openai/gpt-6-sol" },
    "judgment and prose": { "value": "anthropic/claude-opus-5-5" },
    "hardest tasks": { "value": "anthropic/claude-opus-5-5" },
    "how explorer": { "value": "openai/gpt-6-sol" },
    "how explainer": { "value": "anthropic/claude-opus-5-5" },
    "why investigators": { "value": "openai/gpt-6-sol" },
    "why synthesizer": { "value": "anthropic/claude-opus-5-5" },
    "reflect tooling": { "value": "openai/gpt-6-sol" },
    "reflect judgment, divergent, synthesizer": { "value": "anthropic/claude-opus-5-5" },
    "arena runners": { "value": ["anthropic/claude-sonnet-5-5", "openai/gpt-6-sol"] },
    "arena cross-judge pool": { "value": ["anthropic/claude-opus-5-5", "openai/gpt-6-astra"] },
    "swarm workers": { "value": "openai/gpt-6-sol" },
    "architect runners": { "value": ["anthropic/claude-opus-5-5", "openai/gpt-6-astra"] },
    "interrogate reviewers": { "value": ["anthropic/claude-opus-5-5", "openai/gpt-6-astra"] }
  }
}
```

The model ids above are examples. Use ids from the `pstack_models` tool or from the user. Give a panel's seats different model families (`claude`, `gpt`, `gemini`, …), not one model through two providers, because a panel exists to get a second opinion. A role name not listed above is retired and is dropped when the map is read.

### 5. Confirm

Tell the user the map was written and that it applies to subagents launched after it. Re-running `/setup-pstack` updates it.

### 6. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill`. On no, move on without pushing.

### 7. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /create-formal-verification-skill." On yes, invoke `/create-formal-verification-skill`. On no, move on without pushing.
