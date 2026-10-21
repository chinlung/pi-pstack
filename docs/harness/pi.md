# pstack in Pi

pstack skills use Cursor names. In Pi, read this file once per session, then map each Cursor name in a skill with the tables below. `<pstack>` means the folder that holds `skills/`, `agents/`, and `docs/`. If a Cursor field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

## Tools

| Cursor | Pi |
| --- | --- |
| `Task` | The `subagent` tool. `subagent({ agent, task })` launches one child. |
| `AskQuestion` | `ask_user_question`. It takes up to 4 questions, each with 2-4 options. |
| Open a todolist | The `scratchpad` tool. `scratchpad({ action: "add", text })` adds a checklist item. |
| Run another pstack skill (`/name` or "the **name** skill") | Read `<pstack>/skills/<name>/SKILL.md` and follow it. A skill with `disable-model-invocation: true` still loads through `/skill:<name>`. |
| `Grep`, `Glob` | `bash` with `rg` and `find`. The `grep`, `find`, and `ls` tools also exist. |
| `Read` | `read` |
| `Shell` | `bash` |

## Subagent fields

| Cursor | Pi |
| --- | --- |
| `subagent_type: generalPurpose` | `agent: "delegate"`. The `delegate` agent inherits the parent's model and edits files. |
| `poteto-agent`, `comment-sicko` | `agent: "poteto-agent"`, `agent: "comment-sicko"`. The pi-pstack extension registers both at session start. |
| `readonly: true` | A child whose `tools` list omits `edit`, `write`, and `bash`. The `scout` agent is read-only by default. |
| `readonly: false` | `agent: "delegate"`, or any agent with edit tools. |
| `environment: "cloud"` | `worktree: true`. The child gets its own git worktree. |
| `environment: "local"` | Omit. The child shares the working directory. |
| `cloud_base_branch: <b>` | Tell the worker to check out `<b>` first. |
| `run_in_background: true` | `async: true`. The call returns a run id and the result arrives later. |
| `resume` | `subagent({ action: "resume", id: "<run-id>" })`. A fresh agent with the earlier result pasted into its brief also works. |
| `file_attachments` | List the paths in the brief. |

## Models

| Cursor | Pi |
| --- | --- |
| `claude-<family>-<version>-<effort>[-fast]`, such as `claude-opus-5-5-xhigh` | `provider/id:level`, such as `anthropic/claude-opus-5-5:xhigh`. The level is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| A `grok-*`, `gpt-*`, or other non-Claude slug | The same shape, `provider/id:level`. The provider is the first path segment. |
| `auto` or `inherit-parent` | Omit `model`. The child runs on the parent chat model. |
| The `pstack-models.mdc` rule | The pstack role map. `/pstack-models` prints it and `/pstack-setup` rewrites it. The file lives at `~/.pi/agent/state/pi-pstack/models.json`. |
| A role value `<model> <effort>`, such as `opus high` | `provider/id:level`. |

Pi model ids are provider-scoped, so a role value names one concrete model rather than a family. `/pstack-setup` resolves every role against the models the session can actually launch, so a stored role never names a model that fails at spawn time.

## setup-pstack

`/pstack-setup` picks the per-role models. It reads the models Pi has, asks for a reasoning budget, and writes the role map.

- Detect. The detected models are the `provider/id` pairs whose provider has working credentials. A model id may also be written bare when it is unique in the catalog.
- Defaults. Upstream pstack defaults to `claude-opus-5-5-xhigh` for prose and judgment and `grok-4.7-xhigh-fast` for code work. Those slugs are Cursor-specific, so the Pi default keeps each role and resolves it to the best model the session has, preferring the same model family.
- Write. The role map is JSON at `~/.pi/agent/state/pi-pstack/models.json`. It has a `budget` field and a `roles` object whose keys are the role names below. Overwrite the whole file so re-runs stay idempotent.
- Roles. `feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment and prose`, `hardest tasks`, `how explorer`, `how explainer`, `why investigators`, `why synthesizer`, `reflect tooling`, `reflect judgment, divergent, synthesizer`, `arena runners`, `arena cross-judge pool`, `swarm workers`, `architect runners`, `interrogate reviewers`.
- A role value is one model id, or a list for a panel role. One subagent runs per list entry, so the list length sets the fan-out count.
- `inherit-parent` and `auto` both mean the role runs on the parent chat model, and a panel entry with that value still counts toward the fan-out.

## Paths

| Cursor | Pi |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.pi/skills/`, `~/.pi/agent/skills/`, or the pi-pstack package's `skills/` |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | The pi-pstack package directory, and its `package.json` |
| `~/.cursor/rules/*.mdc`, always-applied rules | The pstack role map JSON, read by `/pstack-models` |
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | `<pstack>/<path>` when that file exists. The package ships the skills, `docs/guide/`, and `README.md`. Read the local copy and never fetch it. Give the user the URL when they need a link. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | `~/.pi/agent/sessions/`. Each session is a JSONL file whose lines are messages, tool calls, and tool results. Read only the current session's file. |

## Cursor-only features

Pi has no Cursor Automations, no agentic security review bot, no Cursor cloud agents, and no built-in PR tool. When a step needs one, put one line in your reply, `Skipped in Pi: <step>. <reason>.`, then go on to the next step. Do not stop, ask, or retry. When a later step needs what the skipped step made, such as a URL or a key, leave a placeholder and name it in the line.

| Cursor | Pi |
| --- | --- |
| Cursor Automations: routines, `update_state` routine calls, `api2.cursor.sh/automations` webhooks, routine wakes, and `SendToUser` secret requests | Skip with the line. |
| The agentic security review bot's comments | A GitHub PR's review comments are ordinary review threads, so triage them with the forge command that the step gives. Skip a step that starts, waits for, or configures the review bot when the PR has no such check or comment. |
| Cursor cloud agents | `worktree: true` maps to a worktree. Skip a step that needs the cloud agent itself, such as its dashboard status or its own machine. |
| A built-in PR tool | Use the forge command that the step gives, such as `gh pr create`. That is not a skip, so write no line. |
| The `/loop` command | A polling watcher. A subagent that waits polls the condition it cares about and reports when the condition holds. |
| `cursor-team-kit`'s `deslop` skill | The `unslop` skill, then the project's own formatter and linter. |
| `cursor-team-kit`'s `control-cli` and `control-ui` skills | Drive the surface with the project's own scripts or the `bash` tool. |
