# pstack in Pi

pstack skills use Cursor names. In Pi, read this file once per session, then map each Cursor name in a skill with the tables below. `<pstack>` means the folder that holds `skills/`, `agents/`, and `docs/`. It is two directories above the `SKILL.md` you are reading: a skill at `<pstack>/skills/<name>/SKILL.md` resolves `<pstack>` as `../..` from its own folder. If a Cursor field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

55 of the 56 pstack skills set `disable-model-invocation: true`, so Pi leaves them out of the skill list in your system prompt. A skill missing from that list is not missing from the package. Find it by path under `<pstack>/skills/`, never by the skill list.

## Tools

| Cursor | Pi |
| --- | --- |
| `Task` | The `subagent` tool. `subagent({ agent, task })` launches one child. pi-subagents can hold `subagent` back behind a loader: a new empty session normally gets `subagent` at once, but a session with history, or a model that cannot take new tools mid-conversation, may show `subagents_enable` instead. When you see `subagents_enable` and no `subagent`, call `subagents_enable({})` once; the full `subagent` tool is available on the next request. A pstack skill that tells you to spawn is the authorization pi-subagents asks for. |
| `AskQuestion` | `ask_user_question` when the session has it. It comes from an optional package, not from Pi itself, and takes up to 4 questions with 2-4 options each. Without it, ask in plain text. |
| Open a todolist | The `scratchpad` tool when the session has it. It comes from the optional `pi-memory` package. `scratchpad({ action: "add", text })` adds a checklist item. Without it, keep the checklist in your reply and update it at each phase. |
| Run another pstack skill (`/name` or "the **name** skill") | Read `<pstack>/skills/<name>/SKILL.md` and follow it. The user can also type `/skill:<name>`, which inlines the skill even when it is hidden from the skill list. You cannot type slash commands, so read the file. |
| `Grep`, `Glob` | `bash` with `rg` and `find`. The `grep`, `find`, and `ls` tools also exist. |
| `Read` | `read` |
| `Shell` | `bash` |

## Subagent fields

| Cursor | Pi |
| --- | --- |
| `subagent_type: generalPurpose` | `agent: "delegate"`. The `delegate` agent inherits the parent's model and edits files. |
| `poteto-agent`, `comment-sicko` | `agent: "poteto-agent"`, `agent: "comment-sicko"`. `poteto-agent` can edit files and can spawn its own subagents, because the Feature playbook has the owner of code-coupled work fan out internally. `comment-sicko` reports and never edits, but it can spawn subagents, because its prompt runs the **how** and **why** skills on a doubtful comment, and those skills fan out through `delegate`. A runtime agent definition cannot restrict which agents a child may launch, so nothing but the brief keeps those children from editing; whoever spawned `comment-sicko` checks `git status` after it reports. Both stay inside pi-subagents' nesting limit, an absolute depth counted from the root session that defaults to 2. Either agent can fan out only when the main session spawned it. One spawned at depth 2, such as a `comment-sicko` run by a `poteto-agent`, cannot spawn: it does the work itself and says it skipped the fan-out. The pi-pstack extension registers both as pi-subagents runtime agents at session start, and is the only source of them. No other agent file may use either name: not the package manifest, not `~/.pi/agent/agents/`, not a project's `.pi/agents/`. pi-subagents checks runtime agents against discovered agents only when it merges them for a launch, and a collision there throws, which fails agent discovery for every launch, not only for these two names. |
| `readonly: true` | Pi has no general-purpose read-only agent. `scout` is not read-only: it carries `bash` and `write`. For review work use `agent: "reviewer"`, whose tools are read-only. For any other read-only job use `agent: "delegate"`, say "do not edit files" in the brief, and check `git status` after it returns. |
| `readonly: false` | `agent: "delegate"`, or any agent with edit tools. |
| `environment: "cloud"` | `worktree: true`. The child gets its own git worktree. |
| `environment: "local"` | Omit. The child shares the working directory. |
| `cloud_base_branch: <b>` | Tell the worker to check out `<b>` first. |
| `run_in_background: true` | `async: true`. The call returns a run id and the result arrives later. |
| `resume` | `subagent({ action: "resume", id: "<run-id>", message: "<the new instruction>" })`. Resume checks eligibility itself and may reject a run that is not retained or not resumable; `{ action: "children.list" }` shows which recent workflow children are resumable. When resume rejects, spawn a fresh agent with the earlier result pasted into its brief, and say it is a fallback. poteto-mode prefers a fresh agent anyway, except when the work needs state that lives only in the old one. |
| `file_attachments` | List the paths in the brief. |

## Models

| Cursor | Pi |
| --- | --- |
| `claude-<family>-<version>-<effort>[-fast]`, such as `claude-opus-5-5-xhigh` | `provider/id:level`, such as `anthropic/claude-opus-5-5:xhigh`. The level is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| A `grok-*`, `gpt-*`, or other non-Claude slug | The same shape, `provider/id:level`. The provider is the first path segment. |
| `auto` or `inherit-parent` | Omit `model`. The child runs on the parent chat model. |
| The `pstack-models.mdc` rule | The pstack role map. The `pstack_models` tool returns it resolved, and the user's `/pstack-models` command prints the same view. `/setup-pstack` rewrites it. The file lives at `~/.pi/agent/state/pi-pstack/models.json`. |
| A role value `<model> <effort>`, such as `opus high` | `provider/id:level`. |

Pi model ids are provider-scoped, so a role value names one concrete model rather than a family. `/setup-pstack` resolves every role against the models the session can actually launch, so a stored role never names a model that fails at spawn time.

A model's **family** is its vendor lineage, not its provider: `claude`, `gpt`, `gemini`, `grok`, `deepseek`, `glm`, `qwen`, `llama`, `mistral`, `kimi`, and so on. Read it from the model part of the id, after the provider and after any routing prefix such as `global.`, `us.`, `anthropic.` or `openai.`. `anthropic/claude-sonnet-5-5` and `amazon-bedrock/global.anthropic.claude-sonnet-5-5` are the same family, and the same model reached through two providers. A model whose lineage cannot be read is its own family. Panel diversity and every "same family" fallback in the skills use this definition, because two providers serving one model give a panel no second opinion.

A model's reasoning levels come only from its catalog entry's `thinkingLevelMap`. A Pi model id carries no effort token: `anthropic/claude-opus-5-5` names the model, not its effort. Upstream's slug rule, which read the effort from a token such as `-xhigh` or `-xhigh-fast` at the end of the slug, has nothing to read in Pi and must not be used to rank models.

A model's **strength** is the highest reasoning level it declares at or below the budget's level, not the highest level it declares at all. A model that declares `off` through `max` has a strength of `high` under a `medium` budget, and must not be dropped because it also offers `max`. A model that declares no level at or below the budget, such as one that offers only `xhigh` and `max` under a `medium` budget, ranks after every model that does, because choosing it means running above the budget. When two models tie, the one with the higher price per token is treated as stronger. Price is a proxy, used only to break ties.

### Resolve a role's model

When a skill says to set `model` from a role's line, resolve it this way:

1. Call the `pstack_models` tool with the role name. It returns the map's `budget` and its `level`, a `source` of `stored` or `default`, and the role's seats. Each seat is `{ "kind": "model", "model": "<provider/id:level>", "aboveBudget": … }`, `{ "kind": "parent" }` (omit `model`), or `{ "kind": "unresolved", "value": … }` (the stored model is gone: omit `model`, say so, and tell the user to rerun `/setup-pstack`). Pass a `model` seat's `model` string to the `subagent` tool as it is. A panel role returns one seat per subagent. With no role name it returns every role. When no role map file exists, the tool still answers, with `source: "default"` and defaults built from the detected models, so its answer can differ from step 3; the tool's answer wins.
2. Without the tool, read `~/.pi/agent/state/pi-pstack/models.json`. A role's value is `{ "value": "<provider/id>" }`, or a list under `value` for a panel role. If a hand-written value already ends in `:<level>`, drop that suffix first, under the rule in **Budget** below. Then append `:<level>`, where the level is `max` for an `unlimited` budget, `xhigh` for `large`, `high` for `medium`, and `medium` for `small`. Pi clamps a level the model does not offer to its nearest supported level, upward first, so say so when that can happen.
3. Without the tool, when the file is missing or has no line for the role, omit `model` so the child runs on the parent model, and say so in one line. Only the tool can resolve defaults, because only the extension can see the detected models. Do not invent a slug. The skill text's "default" now means this rule, because upstream's default slugs are Cursor-specific and do not exist in Pi.
4. `auto` and `inherit-parent` always mean omit `model`.

You cannot run `/pstack-models` or `/setup-pstack` yourself. They are the user's commands.

## setup-pstack

`/setup-pstack` picks the per-role models. It reads the models Pi can launch, asks for a reasoning budget, lets the user confirm or change each role, and writes the role map.

- Detect. The detected models are `ctx.scopedModels`, the set the user's `enabledModels` setting scopes the session to. When no scope is configured, that list is empty and means every authenticated model is usable, so detection falls back to the registry's authenticated models. A model id may also be written bare when it is unique in the catalog.
- Defaults. Upstream pstack defaults to `claude-opus-5-5-xhigh` for prose and judgment and `grok-4.7-xhigh-fast` for code work. Those slugs are Cursor-specific, so the Pi default keeps each role and resolves it from the detected models: a judgment role takes the strongest model, a code role takes a capable mid-priced one, and the entries of a panel role take different families before any rule about strength. When fewer families than entries are available, entries take different models within a family, and two entries share a model only when exactly one model is usable. Two panel entries on one model make the comparison worthless.
- Budget. The budget is stored once, as the map's `budget` field, and applied when a role is resolved. Role values are stored without a `:level` suffix, so changing the budget never requires rewriting the roles. A hand-written value may still carry one, because `provider/id:level` is Pi's usual spelling. The reader strips a trailing `:<level>` only when `<level>` is one of the seven levels and the full text is not itself a catalog id, since some ids contain a colon (OpenRouter's `qwen/qwen3-coder:exacto`). It reports the stripped suffix, because the budget, not the suffix, sets the level.
- Confirm. Show every role with its resolved model, mark roles that need a choice and roles that run above the budget, and let the user change any role to a detected model, `inherit-parent`, or `auto`. A budget passed as the argument, as in `/setup-pstack large`, only skips the budget question; the role confirmation still runs when the session has dialog UI. A session without dialog UI keeps the resolved map and reports it.
- Preserve. A re-run keeps every role the user set before, as long as its model is still detected. Only missing roles and roles whose model disappeared are re-resolved. A panel role is kept or re-resolved as a whole: when any of its entries names a model that is gone, the whole panel is re-resolved, so the panel keeps its size and its family spread. A kept role is rewritten in the stored form: each entry becomes its full `provider/id`, with any `:level` suffix removed, so a bare id that is unique today does not turn ambiguous when a second provider serves it. The report names every stored role that was re-resolved. A stored role whose entry count is not the role's seat count is dropped and reported, because the count sets the fan-out. A stored role whose name is not one of the roles below is a retired role. It is dropped and the report names it, as upstream does.
- Write. The role map is JSON at `~/.pi/agent/state/pi-pstack/models.json`, written to a temporary file and renamed over the target so a crash never leaves a truncated map. It has a `budget` field and a `roles` object whose keys are the role names below. The reader also accepts a bare string or list as a role's value, so a hand-written map works.
- Roles. `feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment and prose`, `hardest tasks`, `how explorer`, `how explainer`, `why investigators`, `why synthesizer`, `reflect tooling`, `reflect judgment, divergent, synthesizer`, `arena runners`, `arena cross-judge pool`, `swarm workers`, `architect runners`, `interrogate reviewers`.
- A role value is one model id, or a list for a panel role. One subagent runs per list entry, so the list length sets the fan-out count.
- `inherit-parent` and `auto` both mean the role runs on the parent chat model, and a panel entry with that value still counts toward the fan-out.

## Paths

| Cursor | Pi |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.pi/skills/`, `~/.pi/agent/skills/`, or the pi-pstack package's `skills/` |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | The pi-pstack package directory, and its `package.json` |
| `~/.cursor/rules/*.mdc`, always-applied rules | The pstack role map JSON, resolved by the `pstack_models` tool |
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | `<pstack>/<path>` when that file exists. The package ships the skills, `docs/guide/`, and `README.md`. Read the local copy and never fetch it. Give the user the URL when they need a link. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | `~/.pi/agent/sessions/--<cwd>--/`, where `<cwd>` is the resolved working directory with one leading `/` or `\` dropped and every other `/`, `\` and `:` turned into `-`. Dots are kept, so `/Users/you/proj` is `--Users-you-proj--` and `/Users/you/.pi` is `--Users-you-.pi--`. Each session is one `<timestamp>_<id>.jsonl` file whose lines are messages, tool calls, and tool results. The newest file in that folder is the current session. A session started with `--no-session` writes no file, so when the folder is missing or empty there is no transcript to read: say so and work from the conversation. Read only that workspace's folder, never a sibling folder, because sibling folders hold private chats from unrelated projects. |

## Cursor-only features

Pi has no Cursor Automations, no Cursor cloud agents, and no built-in PR tool. When a step needs one of them, put one line in your reply, `Skipped in Pi: <step>. <reason>.`, then go on to the next step. Do not stop, ask, or retry. When a later step needs what the skipped step made, such as a URL or a key, leave a placeholder and name it in the line.

Bugbot and the agentic security review are review bots, not features of the editor. They post on a GitHub PR only when the repository has them installed, and their comments are handled the same way in Pi as anywhere else, so they are not a skip.

| Cursor | Pi |
| --- | --- |
| Cursor Automations: routines, `update_state` routine calls, `api2.cursor.sh/automations` webhooks, routine wakes, and `SendToUser` secret requests | Skip with the line. |
| Bugbot and the agentic security review | Their comments on a GitHub PR are ordinary review threads, so triage them with the forge command that the step gives and the rules in `<pstack>/skills/poteto-mode/references/bugbot-triage.md`. Skip a step that starts, waits for, or configures either bot when the PR has no such check or comment. |
| Cursor cloud agents | `worktree: true` maps to a worktree. Skip a step that needs the cloud agent itself, such as its dashboard status or its own machine. |
| A built-in PR tool | Use the forge command that the step gives, such as `gh pr create`. That is not a skip, so write no line. |
| The `/loop` command | A polling watcher. A subagent that waits polls the condition it cares about and reports when the condition holds. The multi-phase plan template keeps the literal `` `/loop 1h` `` on purpose: `scripts/check-plan.mjs` requires that marker, so a plan written in Pi still carries it and the coordinator arms the audit tick as an hourly polling watcher. |
| `cursor-team-kit`'s `deslop` skill | The `unslop` skill, then the project's own formatter and linter. |
| `create-skill`, Cursor's built-in skill-authoring skill | Pi has none. Follow Pi's skill format, described in the Pi package's `docs/skills.md`: a folder with a `SKILL.md` whose frontmatter has `name` and `description`. Use the `writing-skills` skill when the session has it. The routing labels in **reflect**'s templates, such as `new skill via create-skill:`, keep the name so the templates still match one another. |
| `cursor-team-kit`'s `control-cli` and `control-ui` skills | Drive the surface with the project's own scripts or the `bash` tool. |
