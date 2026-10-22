#!/usr/bin/env node
/**
 * Ports the upstream pstack skill tree to Pi.
 *
 * Upstream pstack targets Cursor: it spawns subagents with a `Task` tool, keeps the per-role
 * model map in an always-applied Cursor rule, and names Cursor-only features (Bugbot, Cursor
 * Automations, cloud agents, `/loop`).
 *
 * Pi runs the same skills with different names, so this script rewrites the Cursor names
 * mechanically. It is deliberately a text transform rather than a hand edit of 111 files: the
 * upstream tree stays pristine, the port is reproducible, and re-running it after an upstream
 * bump produces the same result.
 *
 * Run it from the package root:
 *
 *   node scripts/port-skills.mjs            # write skills/ and agents/
 *   node scripts/port-skills.mjs --check    # fail if skills/ is out of date
 */
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { danglingLinks, relinkUnshipped } from "./port-links.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM = join(ROOT, "upstream");
const SKILLS_OUT = join(ROOT, "skills");
const AGENTS_OUT = join(ROOT, "agents");
const GUIDE_OUT = join(ROOT, "docs", "guide");
const ADAPTER_DIR = join(ROOT, "docs", "harness");

/**
 * The file types read as text. Everything else, such as the guide's images, is copied as bytes.
 *
 * Only Markdown gets the global term table. Code files, upstream's `.ts`, `.mjs` and `.sh`, are
 * copied verbatim unless a single-file rule names them: a prose replacement applied to code
 * corrupts identifiers, and upstream's `watch-pr` matches a review bot by its login name, so
 * rewriting `bugbot` in code breaks both the build and the behavior it implements.
 */
const TEXT_EXTENSIONS = new Set([".md", ".sh", ".mjs", ".ts", ".json", ".txt", ".lock"]);

/**
 * The Cursor-to-Pi term table.
 *
 * Each entry is a plain string replacement, applied in order. The order matters: the longer,
 * more specific patterns come first so a short one cannot consume part of a longer one.
 */
const REPLACEMENTS = [
	// The subagent tool. Cursor's Task tool is Pi's subagent tool.
	[/`Task` call/g, "`subagent` call"],
	[/\bTask spawn\b/g, "subagent spawn"],
	[/with the Task tool/g, "with the `subagent` tool"],
	[/only through the Task tool/g, "only through the `subagent` tool"],
	[/If the Task tool rejects/g, "If the `subagent` tool rejects"],
	[/omit Task `model`/g, "omit the `model` field"],
	[
		/Spawn `Task` with/g,
		"Spawn a `subagent` with",
	],
	[
		/Substituting `generalPurpose` skips that read and drifts/g,
		"Substituting a plain agent skips that read and drifts",
	],
	[
		/set their own `subagent_type` for diverse-model review/g,
		"set their own `agent` for diverse-model review",
	],
	[
		/Reviewers return findings in the `Task` response body\./g,
		"Reviewers return findings in the `subagent` response body.",
	],

	// The subagent's type and read-only flags.
	[/`subagent_type: generalPurpose`/g, "`agent: \"delegate\"`"],
	[/`subagent_type: "poteto-agent"`/g, "`agent: \"poteto-agent\"`"],
	[/`subagent_type: "comment-sicko"`/g, "`agent: \"comment-sicko\"`"],
	[/`readonly: true`/g, "read-only"],
	[/`readonly: false`/g, "agent mode"],
	[/readonly\/Ask mode/g, "read-only mode"],
	[/and readonly strips MCPs/g, "and read-only mode strips MCPs"],
	[/`run_in_background: true`/g, "`async: true`"],
	[/`environment: "cloud"`/g, "`worktree: true`"],
	[/`environment: "local"`/g, "no `worktree` flag"],

	// The per-role model map. Upstream keeps it in an always-applied Cursor rule; Pi keeps it
	// as JSON managed by the `/setup-pstack` command, and the model reads it through the
	// `pstack_models` tool, because a model cannot type the user's slash commands.
	[
		/`~\/\.cursor\/rules\/pstack-models\.mdc`/g,
		"the pstack role map (the `pstack_models` tool returns it)",
	],
	[/the `pstack-models\.mdc` rule/g, "the pstack role map"],

	// Cursor's skill and plugin locations. Pi installs skills from the package and the user's
	// agent directory.
	[/`~\/\.cursor\/plugins\/`/g, "the pi-pstack package's"],
	[/`~\/\.cursor\/skills\/`/g, "`~/.pi/agent/skills/`"],
	[/`\.cursor\/skills\/`/g, "the project's `.pi/skills/`"],
	[/`\.cursor\/skills\/verify-<app>\/`/g, "the project's `.pi/skills/verify-<app>/`"],
	[/`\.cursor\/skills\/<handle>\/<handle>-mode\/SKILL\.md`/g, "`.pi/skills/<handle>/<handle>-mode/SKILL.md`"],
	[/`\.cursor\/skills\/<handle>-mode\/SKILL\.md`/g, "`.pi/skills/<handle>-mode/SKILL.md`"],
	[/`\.cursor\/skills\/<handle>\/`/g, "`.pi/skills/<handle>/`"],
	[/~\/\.cursor\/skills\//g, "~/.pi/agent/skills/"],
	[/\.cursor\/skills\//g, ".pi/skills/"],
	[
		/misses one that lives at `\.cursor\/worktrees\/myrepo\/x`/g,
		"misses one that lives at `.pi/worktrees/myrepo/x`",
	],

	// Transcripts. Pi keeps them in its session directory, one JSONL file per session.
	[
		/find this conversation's transcript in the `agent-transcripts\/` directory the system prompt names\. Do not glob across `~\/\.cursor\/projects\/\*\/`\. That crosses workspace boundaries and reads private chats from unrelated projects\./g,
		"find this conversation's transcript in Pi's session directory under `~/.pi/agent/sessions/`. Read only the current session's file. That reads private chats from unrelated projects otherwise.",
	],
	[
		/Reading local transcripts under `agent-transcripts\/`\./g,
		"Reading the current session's local transcript.",
	],
	[
		/<agent-transcripts>/g,
		"<session-dir>",
	],

	// The interactive question tool.
	[/`AskQuestion`/g, "`ask_user_question`"],

	// The todo list. Pi has a `scratchpad` tool for a checklist of things to keep in mind.
	[/\bOpen a todolist\b/g, "Open a checklist"],
	[/\bthe todolist\b/g, "the checklist"],
	[/\btodo list\b/g, "checklist"],

	// Cursor-only features. The adapter documents each one, so the skill keeps the step and
	// says what Pi does instead.
	//
	// "Bugbot" stays a proper noun. It names a review bot, and a GitHub PR's review threads
	// are still review threads in Pi, so the triage rules apply unchanged.
	// A Cursor cloud agent's job, an isolated checkout that keeps working on its own, is what a
	// pi-subagents child launched with `worktree: true` does.
	[/\ba Cursor cloud agent\b/g, "a `subagent` child launched with `worktree: true`"],
	[/\bcloud agents\b/g, "`subagent` children launched with `worktree: true`"],
	[/\bits own cloud VM\b/g, "its own worktree"],
	// Pi has no `create-skill`. The name stays, so the routing labels reflect's templates share
	// still match one another, and the adapter maps it to Pi's skill format.
	[/Cursor's built-in `create-skill` skill/g, "`create-skill`"],
	[/Cursor's built-in `create-skill`/g, "`create-skill`"],
	[/the \*\*create-skill\*\* skill \(Cursor's built-in for authoring SKILL\.md files\)/g, "the **create-skill** skill"],

	// The `cursor-team-kit` plugin's skills. Pi has no equivalent, so the skill names what Pi
	// does instead: the project's own scripts, the `bash` tool, or the `unslop` skill.
	//
	// The specific rules come first. A generic `/deslop` rule would rewrite the text before
	// the rule that also mentions `cursor-team-kit` gets a chance to match it.
	[
		/Run `\/deslop` from `cursor-team-kit` over the diff before commit/g,
		"Run `unslop` over the diff before commit",
	],
	[
		/`control-ui` or `control-cli` runtime verification \(from `cursor-team-kit`\)/g,
		"runtime verification with the project's own driver script",
	],
	[
		/the `deslop` skill from the `cursor-team-kit` plugin \(`\/deslop`\)/g,
		"the `unslop` skill",
	],
	[
		/`control-ui` or `control-cli` from `cursor-team-kit`/g,
		"the project's own driver script",
	],
	[/`control-ui` from `cursor-team-kit`/g, "the project's own driver script"],
	[/`control-cli` from `cursor-team-kit`/g, "the project's own driver script"],
	[/`\/deslop`/g, "the `unslop` skill"],

	// Cursor's background loop. Pi has no `/loop`; a subagent that waits polls instead.
	[/Cursor's `\/loop` command/g, "a polling watcher"],
	[/`\/loop`/g, "a polling watcher"],
];

/**
 * Per-file replacements, applied after the global table. A file-specific rule wins over the
 * global table for text the global table cannot express.
 */
const FILE_RULES = [
	// The rules below run against upstream's own text, before the global table.
	{
		match: "skills/poteto-mode/scripts/worktree-audit.sh",
		rules: [
			[
				"# Transcripts dir: ~/.cursor/projects/<slugified-repo-path>/agent-transcripts.\nslug=$(printf '%s' \"$main_wt\" | sed 's#^/##; s#/#-#g')\ntranscripts=\"$HOME/.cursor/projects/$slug/agent-transcripts\"",
				() =>
					"# Transcripts: Pi keeps one session folder per working directory under\n# ~/.pi/agent/sessions, named for the directory with \"/\", \"\\\" and \":\" turned into \"-\".\npi_session_dir() { printf '%s/.pi/agent/sessions/--%s--' \"$HOME\" \"$(printf '%s' \"$1\" | sed 's#^[/\\\\]##; s#[/\\\\:]#-#g')\"; }\ntranscripts=$(pi_session_dir \"$main_wt\")",
			],
			[
				"\tif [ -d \"$transcripts\" ]; then\n\t\tf=$(rg -l -e \"${wt}/\" -e \"${wt}\\\"\" \"$transcripts\" 2>/dev/null \\",
				() =>
					"\t# A chat that ran in the worktree has its own session folder. A chat that ran in the\n\t# main checkout counts when it names the worktree's path. Sibling folders hold\n\t# unrelated projects' private chats and are never read.\n\twt_sessions=$(pi_session_dir \"$wt\")\n\tif [ -d \"$transcripts\" ] || [ -d \"$wt_sessions\" ]; then\n\t\tf=$( { if [ -d \"$transcripts\" ]; then rg -l -0 -e \"${wt}/\" -e \"${wt}\\\"\" \"$transcripts\" 2>/dev/null; fi\n\t\t\tif [ -d \"$wt_sessions\" ]; then find \"$wt_sessions\" -name '*.jsonl' -type f -print0 2>/dev/null; fi; } \\",
			],
			// A path with a space must survive whole: a truncated worktree path maps to another
			// project's session folder. Paths are cut after "worktree " and file names are
			// NUL-delimited.
			["\t\t\t| xargs stat -f '%m %N'", () => "\t\t\t| xargs -0 stat -f '%m %N'"],
			["main_wt=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')", () => "main_wt=$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -1)"],
			["git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do", () => "git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r wt; do"],
		],
	},
	{
		match: "skills/poteto-mode/playbooks/autonomous-run.md",
		rules: [["using Cursor's `/loop` command (a built-in, not a pstack skill)", "using a polling watcher, a subagent that polls the condition and reports when it holds"]],
	},
	{
		match: "skills/poteto-mode/playbooks/orchestrate.md",
		rules: [
			["the cloud agent's status in the Cursor dashboard", "the run's status from `subagent({ action: \"status\", id })`"],
			["After a Cursor restart: local agents are dead, cloud work is not.", "After a Pi restart: foreground subagents are gone, async background runs keep going."],
			[
				"(nesting works to depth 3, and a nested spawn has the full Task schema including `environment`)",
				"(nesting stops at pi-subagents' depth limit, 2 by default, so workers spawned by a sub-coordinator the main session spawned cannot spawn again; a nested spawn has the full `subagent` schema including `cwd` and `worktree`)",
			],
		],
	},
	{
		match: "skills/poteto-mode/SKILL.md",
		rules: [
			[
				"→ the **Babysit** playbook (`playbooks/babysit.md`), not Cursor's built-in babysit skill, whose description matches the same words.",
				"→ the **Babysit** playbook (`playbooks/babysit.md`).",
			],
			["going offline, a Cursor restart, or imminent context compaction", "going offline, a Pi restart, or imminent context compaction"],
		],
	},
	{
		match: "skills/poteto-mode/playbooks/babysit.md",
		rules: [[" This playbook replaces Cursor's built-in babysit skill for these requests, so do not route there even though its description matches the same words.", ""]],
	},
	{
		match: "docs/guide/01-setup.md",
		rules: [
			[
				"To keep `/poteto-mode` on for the whole chat, pick it from the `/` menu with Option+Enter (Mac) or Alt+Enter (Windows) instead of Enter. That makes it a [Custom Mode](https://cursor.com/docs/skills#using-a-skill-as-a-custom-mode), which stays in context on every turn until you exit it. Custom Modes are available in the Agents Window and the CLI. Plain Enter attaches the skill to one message, and it fades as the chat moves on.",
				"Pi has no persistent modes. `/poteto-mode` inlines the skill into one message, and it fades as the chat moves on, so start each new task with `/poteto-mode` again.",
			],
		],
	},
	{
		match: "docs/guide/02-poteto-mode.md",
		rules: [
			["and a Custom Mode keeps `/poteto-mode` in context on every turn.", "and the skill `/poteto-mode` inlined is still in the conversation."],
			[
				"The cleanest isolation is a [cloud subagent](https://cursor.com/docs/subagents#cloud-subagents). Each one gets its own VM and branch, so it can install dependencies, run your app, and record video of the result without touching your machine. Type `/in-cloud` before the task, or ask the parent chat to hand work to cloud subagents.",
				"The cleanest isolation in Pi is a subagent launched with `worktree: true`. Each one gets its own git worktree and branch, so its edits and build output stay out of your checkout. Ports and other machine-wide resources are still shared, so tell each agent which port to use.",
			],
		],
	},
	{
		match: "docs/guide/01-setup.md",
		rules: [
			[
				/## Install the plugin\n\nIn a Cursor chat, run:\n\n```text\n\/add-plugin pstack\n```\n\nCursor confirms the plugin is installed\.\n\nIn Claude Code, run `\/plugin marketplace add cursor\/plugins`, then `\/plugin install pstack@cursor-plugins`\. Claude Code prefixes plugin commands, so each command in this guide takes a `pstack:` prefix there, such as `\/pstack:setup-pstack`, which writes its model rule to `~\/\.claude\/rules\/pstack-models\.md`\. The \[Claude Code adapter\]\(\.\.\/harness\/claude-code\.md\) covers the other differences\./g,
				"## Install the package\n\nInstall it from the Pi package directory:\n\n```bash\npi install /path/to/pi-pstack\n```\n\nPi confirms the package is installed. The extension registers the `/poteto-mode`, `/setup-pstack` and `/pstack-models` commands, and the skills load as `/skill:<name>` commands. The [Pi adapter](../harness/pi.md) maps upstream's names to Pi.",
			],
			[
				/The defaults run at `xhigh` reasoning, the same as the `large` budget\. `unlimited` lifts each model to its highest tier, up to `max`\. Opus goes to `max`\. Grok tops out at `xhigh`, so it stays there\. `medium` and `small` lower the reasoning and spend fewer tokens\./g,
				"The defaults run at `xhigh` reasoning, the same as the `large` budget. `unlimited` lifts each model to its highest tier, up to `max`, as far as the model declares it. `medium` and `small` lower the reasoning and spend fewer tokens.",
			],
			[
				/A role with no line in the rule keeps the skill's default\. To restore a default, delete that role's line\. A rerun of `\/setup-pstack` keeps any role whose model differs from the default\. When a default changes, a rule written before the change still pins the old default, so delete those role lines, or delete the file, then run `\/setup-pstack` again\./g,
				"A role with no entry in the map keeps the skill's default. To restore a default, delete that role's entry. A rerun of `/setup-pstack` keeps any role whose model differs from the default. When a default changes, a map written before the change still pins the old default, so delete those role entries, or delete the file, then run `/setup-pstack` again.",
			],
		],
	},
	{
		match: "docs/guide/05-build-and-clean.md",
		rules: [
			[
				/The \[Opening a PR playbook\]\(\.\.\/\.\.\/skills\/poteto-mode\/playbooks\/opening-a-pr\.md\) runs the `unslop` skill on the diff before each commit and applies \[`\/unslop`\]\(\.\.\/\.\.\/skills\/unslop\/SKILL\.md\) to the PR description and commit bodies\. the `unslop` skill ships in the `cursor-team-kit` plugin, not in pstack\. If you don't have it, ask for the same outcome in plain words: remove narrating comments, unsupported guards, dead compatibility paths, and unrelated edits\./g,
				"The [Opening a PR playbook](../../skills/poteto-mode/playbooks/opening-a-pr.md) runs the `unslop` skill on the diff before each commit and applies [`/unslop`](../../skills/unslop/SKILL.md) to the PR description and commit bodies. If you want a stronger pass than `unslop` gives, ask for the same outcome in plain words: remove narrating comments, unsupported guards, dead compatibility paths, and unrelated edits.",
			],
		],
	},
	{
		match: "docs/guide/07-overnight.md",
		rules: [
			[
				/a polling watcher is Cursor's built-in wake mechanism, not a pstack skill\./g,
				"a polling watcher is a wake mechanism, not a pstack skill.",
			],
			[
				/or that you're about to go offline or restart Cursor\./g,
				"or that you're about to go offline or restart Pi.",
			],
			[
				/A \[Cursor Project\]\(https:\/\/cursor\.com\/blog\/projects\) gives one coordinator agent a persistent thread\. The coordinator doesn't write code\. It directs subagents, which run in the cloud by default, so the work continues when your laptop is closed\./g,
				"A long-lived Pi session gives one coordinator agent a persistent thread. The coordinator doesn't write code. It directs subagents, which run in the background by default, so the work continues while you are away.",
			],
		],
	},
	{
		match: "docs/guide/09-make-it-yours.md",
		rules: [
			[
				/which routes through Cursor's built-in `create-skill`, validates the frontmatter and links/g,
				"which validates the frontmatter and links",
			],
		],
	},
	{
		match: "skills/how/SKILL.md",
		rules: [
			[
				/Every spawn is a Task subagent with `agent: "delegate"` and read-only\./g,
				'Every spawn is a `subagent` call with `agent: "delegate"`. Pi\'s `delegate` can edit files, so each brief says "do not edit files" and you check `git status` after each returns.',
			],
		],
	},
	{
		match: "skills/why/SKILL.md",
		rules: [
			[
				/Every spawn is `generalPurpose` with agent mode \(agent mode\)\./g,
				'Every spawn is a `delegate` agent with agent mode. Pi\'s `delegate` can edit files, so each brief says "do not edit files" and you check `git status` after each returns.',
			],
			[/list the available MCPs from the Cursor environment/g, "list the available MCP servers from the Pi environment"],
			[/inspect the `mcps\/` directory Cursor exposes for enabled MCP servers/g, "inspect the MCP servers the session has registered"],
		],
	},
	{
		match: "skills/poteto-mode/SKILL.md",
		rules: [
			[
				/Shipping UI \/ IDE \/ CLI → the matching control skill\. `cursor-team-kit` publishes `control-cli` \(CLIs and TUIs\) and `control-ui` \(browser \/ Electron \/ web UIs\)\./g,
				"Shipping UI / IDE / CLI → drive the surface yourself with the project's own scripts or the `bash` tool.",
			],
			[
				/Before commit → the `deslop` skill from the `cursor-team-kit` plugin \(`\/deslop`\)\./g,
				"Before commit → the `unslop` skill, then the project's own formatter and linter.",
			],
		],
	},
	{
		match: "skills/poteto-mode/playbooks/orchestrate.md",
		rules: [
		],
	},
	{
		match: "skills/swarm/SKILL.md",
		rules: [
			[
				/When a worker must start from a non-default pushed branch, pass `cloud_base_branch`\./g,
				"When a worker must start from a non-default pushed branch, tell the worker which branch to check out.",
			],
		],
	},
	{
		match: "skills/interrogate/SKILL.md",
		rules: [
			[
				/Each reviewer gets `agent: "delegate"`, read-only, and `model` set to its configured entry/g,
				'Each reviewer gets `agent: "reviewer"`, whose tools are read-only, and `model` set to its configured entry',
			],
		],
	},
	{
		match: "skills/reflect/SKILL.md",
		rules: [
			[
				/One message, three `subagent` calls, `agent: "delegate"`, agent mode \(agent mode\)\./g,
				'One message, three `subagent` calls, `agent: "delegate"`, agent mode. Reviewers never edit files, so each brief says so and you check `git status` after they return.',
			],
		],
	},
	{
		match: "skills/recall/SKILL.md",
		rules: [
			[
				/Transcripts live at `~\/\.cursor\/projects\/<slug>\/agent-transcripts\/<uuid>\/<uuid>\.jsonl`, where `<slug>` is the workspace path with the leading slash dropped and each "\/" turned into "-" \(so `\/Users\/you\/proj` becomes `Users-you-proj`\)\. Every line is one chat message\./g,
				"Transcripts live in Pi's session directory under `~/.pi/agent/sessions/`. Each session is a JSONL file whose lines are messages, tool calls, and tool results.",
			],
		],
	},
	{
		match: "skills/show-me-your-work/SKILL.md",
		rules: [
			[
				/Read this run's transcript under the active workspace's `agent-transcripts\/` directory \(the system prompt names the path\)\. Don't glob across `~\/\.cursor\/projects\/\*\/`\. That reads unrelated private chats\./g,
				"Read this run's transcript in Pi's session directory under `~/.pi/agent/sessions/`. Read only the current session's file. That reads unrelated private chats otherwise.",
			],
		],
	},
	{
		match: "skills/automate-me/SKILL.md",
		rules: [
			[
				/Locate the active workspace's transcripts before fanning out\. The system prompt names the workspace's `agent-transcripts\/` directory\. Use only that path\. Don't glob across `~\/\.cursor\/projects\/\*\/`\. That crosses workspace boundaries and reads private chats from unrelated projects\./g,
				"Locate the active workspace's transcripts before fanning out. Pi keeps them in `~/.pi/agent/sessions/--<cwd>--/`, one JSONL file per session. Use only this workspace's folder, never a sibling folder, because a sibling holds private chats from unrelated projects.",
			],
		],
	},
	{
		match: "skills/poteto-mode/playbooks/session-pickup.md",
		rules: [
			[
				/A local transcript under the active workspace's `agent-transcripts\/` directory \(the system prompt names the path\. Do not glob across `~\/\.cursor\/projects\/\*\/`, that crosses workspace boundaries and reads private chats from unrelated projects\), a cloud-agent URL, or a pushed branch\./g,
				"A local transcript in this workspace's Pi session folder, `~/.pi/agent/sessions/--<cwd>--/` (the Pi adapter gives the folder name), or a pushed branch. Read only that folder, never a sibling folder, because a sibling crosses workspace boundaries and holds private chats from unrelated projects.",
			],
		],
	},
	{
		match: "skills/poteto-mode/playbooks/eval.md",
		rules: [
			[
				/Read each candidate's local transcript under the active workspace's `agent-transcripts\/` directory \(the system prompt names this path\)\. Do not glob across `~\/\.cursor\/projects\/\*\/`\. That crosses workspace boundaries and reads private chats from unrelated projects\./g,
				"Read each candidate's local transcript. A subagent's transcript is `subagent-artifacts/<runId>_<agent>_transcript.jsonl` inside this workspace's Pi session folder under `~/.pi/agent/sessions/`. Read only that folder, never a sibling folder, because a sibling holds private chats from unrelated projects.",
			],
		],
	},
	{
		match: "agents/poteto-agent.md",
		rules: [
			[
				/With no path, before any other work, search `~\/\.cursor\/plugins\/` for a file whose path ends in `skills\/poteto-mode\/SKILL\.md`\. If more than one file matches, use the copy whose `\.cursor-plugin\/plugin\.json` has the highest `version`\. Your skill catalog hides this skill, so a missing catalog entry does not mean pstack is absent\. If no such file exists, stop and tell your parent\./g,
				"With no path, before any other work, look for the pi-pstack package's `skills/poteto-mode/SKILL.md` under the Pi package directory or `~/.pi/agent/skills/`. Your skill catalog hides this skill, so a missing catalog entry does not mean pstack is absent. If no such file exists, stop and tell your parent.",
			],
		],
	},
	{
		match: "skills/reflect/references/judgment-reviewer.md",
		rules: [
			[/\ba `Task` prompt naming its path/g, "a `subagent` prompt naming its path"],
		],
	},
	{
		match: "skills/reflect/references/tooling-reviewer.md",
		rules: [
			[/\ba `Task` prompt naming its path/g, "a `subagent` prompt naming its path"],
		],
	},
	{
		match: "skills/reflect/references/divergent-reviewer.md",
		rules: [
			[/\ba `Task` prompt naming its path/g, "a `subagent` prompt naming its path"],
		],
	},
	{
		match: "skills/maintain-verification-skill/SKILL.md",
		rules: [
		],
	},
	{
		match: "skills/reflect/SKILL.md",
		rules: [[/agent mode \(agent mode\)/g, "agent mode"]],
	},
	{
		match: "skills/poteto-mode/playbooks/orchestrate.md",
		rules: [
			[
				" in the current agent's store (path in the system prompt).",
				" under `.pi/pstack/` in the working directory and keep it out of git. Pi has no agent store, so export `ORCH_STORE` as that directory's absolute path before any `orch` command.",
			],
			["Run `orch init`.", "Export `ORCH_STORE`, then run `orch init`."],
		],
	},
	{
		match: "skills/poteto-mode/playbooks/autopilot-full.md",
		rules: [
			[" in the root agent's store (path in the system prompt)", " under `.pi/pstack/` in the working directory (kept out of git)"],
			["arm `/loop 1h` to audit", "arm an hourly polling watcher to audit"],
		],
	},
	{
		match: "skills/poteto-mode/playbooks/multi-phase-plan.md",
		rules: [
			["under the agent store's `docs/`", "under `.pi/pstack/docs/`"],
			["Read these from trunk at program start.", "Read these at program start, the pstack files from the installed package and the rest from trunk."],
			[/git show origin\/main:pstack\//g, "read <pstack>/"],
			[/pstack\/skills\//g, "<pstack>/skills/"],
		],
	},
	{
		match: "skills/make-bot-ui/SKILL.md",
		rules: [
			[
				/^# How to make a bot UI\n/m,
				"# How to make a bot UI\n\n**Not supported in Pi.** This skill builds on Cursor Automations: `update_state` routines, `SendToUser` secret requests, and the Routines panel. Pi has none of them. Write `Skipped in Pi: create the webhook routine and request the sender key. Cursor Automations do not exist in Pi.` and stop, unless the user brings their own webhook URL and sender key. With those, build the local page and server below and ignore the routine, panel, and secret-card steps.\n",
			],
		],
	},
	{
		match: "skills/automate-me/SKILL.md",
		rules: [
			[
				"4-6 options each, `allow_multiple: true` for category questions.",
				"2-4 options each, `multiSelect: true` for category questions, and split a larger category across questions.",
			],
		],
	},
	{
		match: "skills/how/references/explainer-prompt.md",
		rules: [["Use Read, Grep, and Glob as needed.", "Use `read`, `grep`, and `find` as needed."]],
	},
	{
		match: "skills/interrogate/references/rubric.md",
		rules: [["(Read, Grep, Glob)", "(`read`, `grep`, `find`)"]],
	},
	...["judgment", "tooling", "divergent"].map((name) => ({
		match: `skills/reflect/references/${name}-reviewer.md`,
		rules: [
			["a `Read` of its `SKILL.md`", "a `read` of its `SKILL.md`"],
			["(Shell, Grep, MCP, etc.)", "(bash, grep, MCP, etc.)"],
		],
	})),
	{
		match: "docs/guide/01-setup.md",
		rules: [
			[
				"At the end of setup, `/setup-pstack` looks for",
				"`/setup-pstack` itself only writes the role map. To get the offers below, also run `/skill:setup-pstack`. The skill looks for",
			],
			["Then setup offers once", "Then the skill offers once"],
			["After setup, start a new chat. The model rule applies to new sessions.", "The role map applies to every subagent launched after it is written, so no new chat is needed."],
			["so the list length sets the panel size.", "so the list length sets the panel size. Each panel has a fixed size of two seats, and a list of another length is dropped."],
			["- Shorten a panel list. Each entry runs one subagent.\n", ""],
		],
	},
	{
		match: "docs/guide/05-build-and-clean.md",
		rules: [["say `deslop it`", "say `unslop the diff`"]],
	},
	{
		match: "docs/guide/07-overnight.md",
		rules: [
			["an isolated worktree or cloud agent", "an isolated worktree"],
			["- Give each body of work its own Project, such as", "- Give each body of work its own worktree and Pi session, such as"],
			[
				"- Drag related chats into the Project, finished ones included. They become context for every agent in it.",
				"- When agents need shared context, put the notes or transcript paths in each brief. Pi sessions do not share context on their own.",
			],
			["One prompt can carry a whole Project, from", "One prompt can carry a whole body of work, from"],
			["pstack ships this as a dormant", "Upstream pstack ships this as a dormant"],
			["and name the target repository to set it up.", "and name the target repository to set it up. It needs Cursor Automations, which Pi does not have, so skip it in Pi."],
		],
	},
];

/**
 * The upstream defaults. Cursor's slugs are replaced with a role reference, because Pi's model
 * catalog is machine-specific. The role map, not the skill text, decides the concrete model.
 *
 * The order matters. The longest, most specific pattern runs first, so a short one cannot
 * consume part of a longer one and leave a dangling fragment.
 */
const MODEL_DEFAULTS = [
	[
		/one each on `claude-opus-5-5-xhigh` and `grok-4\.7-xhigh-fast`/g,
		"one on each of the two families the role map names for that role",
	],
	[
		/choose from `claude-opus-5-5-xhigh` and `grok-4\.7-xhigh-fast`/g,
		"choose from the two families the role map names for that role",
	],
	[
		/use `claude-opus-5-5-xhigh` and `grok-4\.7-xhigh-fast`/g,
		"use the two families the role map names for that role",
	],
	[
		/default `grok-4\.7-xhigh-fast`/g,
		"the role map's entry for that role",
	],
	[/default `claude-opus-5-5-xhigh`/g, "the role map's entry for that role"],
	[
		/`grok-4\.7-xhigh-fast` by default/g,
		"the role map's entry for that role, by default",
	],
	[/use `grok-4\.7-xhigh-fast`/g, "use the role map's entry for that role"],

	// The remaining bare slugs: the family tables and the per-role defaults list. Pi's model
	// ids are provider-scoped, so a bare family prefix becomes a family name.
	[
		/Defaults `grok-4\.7-xhigh-fast` for code, `claude-opus-5-5-xhigh` for prose and judgment/g,
		"Defaults to the role map's code role for code and its judgment role for prose and judgment",
	],
	[
		/go to your strongest judgment model \(`claude-opus-5-5-xhigh`\)/g,
		"go to the role map's `hardest tasks` model",
	],
	[
		/\| `reflect judgment, divergent, synthesizer` \| `claude-opus-5-5-xhigh` \|/g,
		"| `reflect judgment, divergent, synthesizer` | the role map's entry |",
	],
	[
		/\| `reflect tooling` \| `grok-4\.7-xhigh-fast` \|/g,
		"| `reflect tooling` | the role map's entry |",
	],
	[
		/\| Reviewer A \| `claude-opus-5-5-xhigh` \|/g,
		"| Reviewer A | the role map's entry |",
	],
	[
		/\| Reviewer B \| `grok-4\.7-xhigh-fast` \|/g,
		"| Reviewer B | the role map's entry |",
	],
	[
		/Families go by prefix: `claude-\*`, and `grok-\*` with `cursor-grok-\*` and `composer-\*`\. A refused `composer-\*` entry runs on `grok-4\.7-xhigh-fast`\. With no family match, use `claude-opus-5-5-xhigh`\./g,
		"A family is the model's vendor lineage (`claude`, `gpt`, `gemini`, …), not its provider, as the Pi adapter defines it, so one model reached through two providers is one family. A rejected entry runs on the same role's other entry. With no family match, use the role map's first entry.",
	],
	[
		/A refused `composer-\*` entry runs on Reviewer B's default\. With no family match, use Reviewer A's default\./g,
		"A rejected entry runs on the same role's other entry. With no family match, use the role map's first entry.",
	],
	[
		/Families go by prefix: `claude-\*`, and `grok-\*` with `cursor-grok-\*` and `composer-\*`\./g,
		"A family is the model's vendor lineage (`claude`, `gpt`, `gemini`, …), not its provider, as the Pi adapter defines it, so one model reached through two providers is one family.",
	],
];

function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		if (name === ".DS_Store" || name === "node_modules") return [];
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

/**
 * How many files each rule changed. A rule that changes nothing fails the port: either upstream
 * moved the text it was written for, or an earlier rule already rewrote it, and either way the
 * rule no longer does what its author thought.
 */
const hits = new Map();

function apply(entries, text) {
	let out = text;
	for (const entry of entries) {
		const next = out.replace(entry[0], entry[1]);
		if (next !== out) hits.set(entry, (hits.get(entry) ?? 0) + 1);
		out = next;
	}
	return out;
}

function fileRulesFor(relativePath) {
	return FILE_RULES.filter((rule) => rule.match === relativePath).flatMap((rule) => rule.rules);
}

/**
 * Ports one text file. Single-file rules run first, against upstream's own text, and again after
 * the global table, for rules that name text the table produces. Only Markdown gets the table.
 */
function port(text, relativePath) {
	const fileRules = fileRulesFor(relativePath);
	let out = apply(fileRules, text);
	if (extname(relativePath) !== ".md") return out;
	out = apply(REPLACEMENTS, out);
	out = apply(MODEL_DEFAULTS, out);
	return apply(fileRules, out);
}

/**
 * The adapter line every ported skill carries, so a session that runs one skill knows how to
 * map the remaining Cursor names.
 */
const ADAPTER_LINE =
	"In Pi, read [the Pi adapter](../../docs/harness/pi.md) once per session before you follow this skill. " +
	"It maps the Cursor names in pstack skills to Pi.";

/** The skills that need the adapter line: every one that mentions a Cursor-only name. */
const CURSOR_TERMS = [
	/Task tool|Task subagent|Task call|Task spawn/,
	/AskQuestion/,
	/todolist|todo list/,
	/subagent_type/,
	/readonly/,
	/environment: "(cloud|local)"/,
	/cloud_base_branch/,
	/run_in_background/,
	/pstack-models\.mdc/,
	/\.cursor\//,
	/Bugbot|bugbot/,
	/Cursor/,
	/\/loop/,
	/claude-opus-5-5|grok-4\.7/,
	/cursor-team-kit/,
	/generalPurpose/,
	/update_state|SendToUser/,
];

/** The skills that already have an H1, which the adapter line is inserted after. */
function needsAdapter(text) {
	return CURSOR_TERMS.some((term) => term.test(text));
}

/**
 * Files that are ported by hand rather than by the term table, because a mechanical rewrite
 * cannot express what Pi needs. Each one lives in `overrides/` and is copied verbatim.
 *
 * `setup-pstack` is the main one: upstream's version writes a Cursor always-applied rule, and
 * Pi's version is a different file format with a different detection path, so a rewrite of the
 * upstream text would be wrong in every step rather than only in the paths.
 */
const OVERRIDES_DIR = join(ROOT, "overrides");

/**
 * The rendered files that upstream ships executable. A skill runs some of its scripts directly,
 * so a lost execute bit is a broken step that no byte comparison can see.
 */
const executable = new Set();

function render() {
	const files = new Map();
	const track = (key, path) => {
		if (statSync(path).mode & 0o111) executable.add(key);
	};

	for (const path of walk(join(UPSTREAM, "skills"))) {
		const relativePath = relative(join(UPSTREAM, "skills"), path);
		files.set(`skills/${relativePath}`, readFileSync(path, "utf8"));
		track(`skills/${relativePath}`, path);
	}
	for (const path of walk(join(UPSTREAM, "agents"))) {
		const relativePath = relative(join(UPSTREAM, "agents"), path);
		files.set(`agents/${relativePath}`, readFileSync(path, "utf8"));
		track(`agents/${relativePath}`, path);
	}
	// The guide is prose, so the same term table applies. Its images are binary, so they are
	// read as bytes and copied without a rewrite.
	for (const path of walk(join(UPSTREAM, "docs", "guide"))) {
		const relativePath = relative(join(UPSTREAM, "docs", "guide"), path);
		const key = `docs/guide/${relativePath}`;
		files.set(key, TEXT_EXTENSIONS.has(extname(relativePath)) ? readFileSync(path, "utf8") : readFileSync(path));
		track(key, path);
	}

	const rendered = new Map();
	for (const [relativePath, content] of files) {
		// A hand-written file replaces the ported one entirely.
		const override = join(OVERRIDES_DIR, relativePath);
		if (existsSync(override)) {
			rendered.set(relativePath, readFileSync(override, "utf8"));
			if (statSync(override).mode & 0o111) executable.add(relativePath);
			else executable.delete(relativePath);
			continue;
		}
		// A binary file is copied, not rewritten.
		if (typeof content !== "string") {
			rendered.set(relativePath, content);
			continue;
		}
		let out = port(content, relativePath);
		// The agent prompts are not skills, so they get no adapter line, but they do get the
		// Cursor names removed. The guide pages are read by a human, so they get the adapter
		// link only when they mention a Cursor name.
		if (relativePath.endsWith("SKILL.md") && needsAdapter(content) && /^# /m.test(out)) {
			out = out.replace(/^(# .*)\n+/m, `$1\n\n${ADAPTER_LINE}\n\n`);
		}
		rendered.set(relativePath, out);
	}
	for (const [key, content] of rendered) {
		if (typeof content === "string" && key.endsWith(".md")) rendered.set(key, relinkUnshipped(key, content, (target) => ships(target, rendered)));
	}
	return rendered;
}

/** The roots the port regenerates. Their old contents are deleted, so only `rendered` counts. */
const GENERATED_ROOTS = ["agents/", "docs/guide/", "skills/"];

/**
 * True when a link target is a file this package ships: a rendered file, or a hand-written file
 * at the package root such as `README.md` or `docs/harness/pi.md`. A target under a generated
 * root must be rendered, because the port deletes whatever else is there.
 */
function ships(target, rendered) {
	if (rendered.has(target)) return true;
	// A directory link ships when a rendered file lives under it.
	const dir = target.endsWith("/") ? target : `${target}/`;
	for (const key of rendered.keys()) if (key.startsWith(dir)) return true;
	if (target.startsWith("..") || GENERATED_ROOTS.some((root) => target.startsWith(root))) return false;
	return existsSync(join(ROOT, target));
}

/** Relative links whose target the package does not ship and upstream cannot hold. */
function findDanglingLinks(rendered) {
	const dangling = [];
	for (const [key, content] of rendered) {
		if (typeof content !== "string" || !key.endsWith(".md")) continue;
		for (const href of danglingLinks(key, content, (target) => ships(target, rendered))) dangling.push(`${key} links to ${href}`);
	}
	return dangling;
}

/** Where a rendered file is written: each key prefix has its own output root. */
function outputPath(key) {
	for (const [prefix, root] of [
		["agents/", AGENTS_OUT],
		["docs/guide/", GUIDE_OUT],
		["skills/", SKILLS_OUT],
	]) {
		if (key.startsWith(prefix)) return join(root, key.slice(prefix.length));
	}
	throw new Error(`no output root for ${key}`);
}

const rendered = render();

const deadRules = [
	...REPLACEMENTS.map((entry, index) => [`REPLACEMENTS[${index}]`, entry]),
	...MODEL_DEFAULTS.map((entry, index) => [`MODEL_DEFAULTS[${index}]`, entry]),
	...FILE_RULES.flatMap((rule) => rule.rules.map((entry, index) => [`FILE_RULES ${rule.match}[${index}]`, entry])),
].filter(([, entry]) => !hits.has(entry));
if (deadRules.length > 0) {
	console.log(`${deadRules.length} rule(s) changed nothing. Delete each one, or fix it to match the text it is for:`);
	for (const [label, entry] of deadRules) console.log(`  ${label} ${String(entry[0]).slice(0, 110)}`);
	process.exit(1);
}

/**
 * The adapter file every ported skill links to. A skill that points at a missing adapter
 * sends the model to a file that is not there, so its absence fails the port.
 */
const ADAPTER_FILE = join(ADAPTER_DIR, "pi.md");
if (!existsSync(ADAPTER_FILE)) {
	console.log(`The Pi adapter is missing at ${relative(ROOT, ADAPTER_FILE)}.`);
	console.log("Every ported skill links to it, so the port cannot run without it.");
	process.exit(1);
}

/**
 * The Cursor names that must not survive the port.
 *
 * A leftover Cursor name in a ported skill is a silent behavior difference: the model reads a
 * name that does not exist in Pi and either guesses or skips the step. The check therefore
 * fails the port rather than letting it ship.
 *
 * A name is allowed when the adapter or a rule deliberately keeps it, so each entry carries the
 * paths it is allowed in.
 */
const FORBIDDEN = [
	{ pattern: /`Task`/, label: "`Task`", except: [] },
	{ pattern: /Task tool/, label: "Task tool", except: [] },
	{ pattern: /update_state|SendToUser|api2\.cursor/, label: "Cursor Automations tool", except: ["skills/make-bot-ui/SKILL.md"] },
	{ pattern: /subagent_type/, label: "subagent_type", except: [] },
	{ pattern: /generalPurpose/, label: "generalPurpose", except: [] },
	{ pattern: /AskQuestion/, label: "AskQuestion", except: [] },
	{ pattern: /\btodolist\b/i, label: "todolist", except: [] },
	{ pattern: /pstack-models\.mdc/, label: "pstack-models.mdc", except: [] },
	{ pattern: /\.cursor\//, label: ".cursor/", except: [] },
	{ pattern: /run_in_background/, label: "run_in_background", except: [] },
	{ pattern: /cloud_base_branch/, label: "cloud_base_branch", except: [] },
	{ pattern: /environment: "(cloud|local)"/, label: 'environment: "cloud"', except: [] },
	{ pattern: /claude-opus-5-5/, label: "claude-opus-5-5", except: ["skills/setup-pstack/SKILL.md"] },
	{ pattern: /grok-4\.7/, label: "grok-4.7", except: ["skills/setup-pstack/SKILL.md"] },
	{ pattern: /cursor-grok-/, label: "cursor-grok-", except: ["skills/setup-pstack/SKILL.md"] },
	{ pattern: /composer-/, label: "composer-", except: ["skills/setup-pstack/SKILL.md"] },
	{ pattern: /cursor-team-kit/, label: "cursor-team-kit", except: [] },
	{ pattern: /agent-transcripts/, label: "agent-transcripts", except: [] },
	{ pattern: /`\/loop`/, label: "`/loop`", except: [] },
	{ pattern: /\.cursor-plugin/, label: ".cursor-plugin", except: [] },
	{ pattern: /family is the provider/, label: "family is the provider", except: [] },
	{ pattern: /cursor\.com/, label: "cursor.com", except: [] },
	{ pattern: /Custom Mode/, label: "Custom Mode", except: [] },
	// Any other mention of Cursor is a step written for a harness this port does not run in. The
	// two exceptions name Cursor on purpose: the help skill says this is a port of a Cursor
	// plugin, and worktree cleanup reclaims the Cursor app's disk space when it is installed.
	{ pattern: /\bCursor\b/, label: "Cursor", except: ["skills/poteto-help/SKILL.md", "skills/poteto-mode/playbooks/worktree-cleanup.md", "skills/make-bot-ui/SKILL.md", "docs/guide/07-overnight.md"] },
];

/**
 * Reports the Cursor names that survived the port.
 *
 * The adapter and the override files are exempt: the adapter documents the mapping on purpose,
 * and the overrides are hand-written Pi files. The guide is checked too, because a page that
 * tells a reader to run a Cursor command sends them down a path that does not exist here.
 */
function findLeftovers(files) {
	const problems = [];
	for (const [path, content] of files) {
		if (path.startsWith("docs/harness/")) continue;
		if (typeof content !== "string") continue;
		const text = content.replace(ADAPTER_LINE, "");
		for (const rule of FORBIDDEN) {
			if (rule.except.includes(path)) continue;
			const match = text.match(rule.pattern);
			if (match) {
				const line = text.slice(0, match.index).split("\n").length;
				problems.push(`${path}:${line} ${rule.label} (${match[0]})`);
			}
		}
	}
	return problems;
}

const dangling = findDanglingLinks(rendered);
if (dangling.length > 0) {
	console.log(`${dangling.length} relative link(s) point outside the package:`);
	for (const link of dangling) console.log(`  ${link}`);
	process.exit(1);
}

const leftovers = findLeftovers(rendered);
if (leftovers.length > 0) {
	console.log(`The port left ${leftovers.length} Cursor name(s) behind:`);
	for (const problem of leftovers) console.log(`  ${problem}`);
	console.log("Add a replacement for each one to scripts/port-skills.mjs, or an override file.");
	process.exit(1);
}

if (process.argv.includes("--check")) {
	// The rendered keys are `skills/...`, `agents/...`, and `docs/guide/...`, so the on-disk
	// keys are built the same way. A key mismatch would report every file as drifted.
	const onDisk = new Map();
	for (const [root, prefix] of [
		[SKILLS_OUT, "skills"],
		[AGENTS_OUT, "agents"],
		[GUIDE_OUT, "docs/guide"],
	]) {
		if (!existsSync(root)) continue;
		for (const path of walk(root)) {
			onDisk.set(`${prefix}/${relative(root, path)}`, readFileSync(path));
		}
	}
	const drifted = [];
	for (const [path, content] of rendered) {
		const have = onDisk.get(path);
		if (have === undefined) {
			drifted.push(path);
			continue;
		}
		const want = typeof content === "string" ? Buffer.from(content, "utf8") : content;
		const isExecutable = (statSync(outputPath(path)).mode & 0o111) !== 0;
		if (!have.equals(want) || isExecutable !== executable.has(path)) drifted.push(path);
	}
	for (const path of onDisk.keys()) {
		if (!rendered.has(path)) drifted.push(path);
	}
	if (drifted.length > 0) {
		console.log(`skills/, agents/ and docs/guide/ are out of date (${drifted.length} files). Run \`node scripts/port-skills.mjs\`.`);
		for (const path of drifted.slice(0, 20)) console.log(`  ${path}`);
		process.exit(1);
	}
	console.log(`skills/, agents/ and docs/guide/ are up to date (${rendered.size} files).`);
} else {
	rmSync(SKILLS_OUT, { recursive: true, force: true });
	rmSync(AGENTS_OUT, { recursive: true, force: true });
	rmSync(GUIDE_OUT, { recursive: true, force: true });
	for (const [path, content] of rendered) {
		const out = outputPath(path);
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, content);
		chmodSync(out, executable.has(path) ? 0o755 : 0o644);
	}
	console.log(`ported ${rendered.size} files into skills/, agents/ and docs/guide/`);
}
