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
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM = join(ROOT, "upstream");
const SKILLS_OUT = join(ROOT, "skills");
const AGENTS_OUT = join(ROOT, "agents");
const GUIDE_OUT = join(ROOT, "docs", "guide");
const ADAPTER_DIR = join(ROOT, "docs", "harness");

/**
 * The file types whose contents are prose. Only these are rewritten.
 *
 * Source files are copied verbatim. A prose replacement applied to a TypeScript file can
 * corrupt an identifier, and upstream's `watch-pr` code matches a review bot by its login
 * name, so rewriting `bugbot` in code breaks both the build and the behavior it implements.
 */
const PROSE_EXTENSIONS = new Set([".md", ".sh", ".mjs", ".txt"]);

/**
 * The Cursor-to-Pi term table.
 *
 * Each entry is a plain string replacement, applied in order. The order matters: the longer,
 * more specific patterns come first so a short one cannot consume part of a longer one.
 */
const REPLACEMENTS = [
	// The subagent tool. Cursor's Task tool is Pi's subagent tool.
	[/`Task` tool/g, "the `subagent` tool"],
	[/`Task` subagent/g, "a `subagent` call"],
	[/`Task` call/g, "`subagent` call"],
	[/`Task` calls/g, "`subagent` calls"],
	[/`Task` prompt/g, "`subagent` prompt"],
	[/\bTask spawn\b/g, "subagent spawn"],
	[/\bthe Task schema\b/g, "the subagent schema"],
	[/with the Task tool/g, "with the `subagent` tool"],
	[/If the Task tool rejects/g, "If the `subagent` tool rejects"],
	[/omit Task `model`/g, "omit the `model` field"],
	[/the Task tool rejects/g, "the `subagent` tool rejects"],
	[
		/Spawn `Task` with/g,
		"Spawn a `subagent` with",
	],
	[
		/nesting works to depth 3, and a nested spawn has the full Task schema including `environment`/g,
		"nesting works to depth 3, and a nested spawn has the full subagent schema including `cwd` and `worktree`",
	],
	[
		/Substituting `generalPurpose` skips that read and drifts/g,
		"Substituting a plain agent skips that read and drifts.",
	],
	[
		/set their own `subagent_type` for diverse-model review/g,
		"set their own `agent` for diverse-model review",
	],
	[
		/One `Task` call, `subagent_type: generalPurpose`/g,
		'One `subagent` call, `agent: "delegate"`',
	],
	[
		/Reviewers return findings in the `Task` response body\./g,
		"Reviewers return findings in the `subagent` response body.",
	],

	// The subagent's type and read-only flags.
	[/`subagent_type: generalPurpose`/g, "`agent: \"delegate\"`"],
	[/`subagent_type: "poteto-agent"`/g, "`agent: \"poteto-agent\"`"],
	[/`subagent_type: "comment-sicko"`/g, "`agent: \"comment-sicko\"`"],
	[/`subagent_type: generalPurpose`/g, "`agent: \"delegate\"`"],
	[/`readonly: true`/g, "read-only"],
	[/`readonly: false`/g, "agent mode"],
	[/readonly\/Ask mode/g, "read-only mode"],
	[/and readonly strips MCPs/g, "and read-only mode strips MCPs"],
	[/`run_in_background: true`/g, "`async: true`"],
	[/`environment: "cloud"`/g, "`worktree: true`"],
	[/`environment: "local"`/g, "no `worktree` flag"],

	// The per-role model map. Upstream keeps it in an always-applied Cursor rule; Pi keeps it
	// as JSON managed by the `/pstack-setup` command.
	[
		/`~\/\.cursor\/rules\/pstack-models\.mdc`/g,
		"the pstack role map (`/pstack-models` shows it)",
	],
	[/the `pstack-models\.mdc` rule/g, "the pstack role map"],
	[/the pstack-models\.mdc rule/g, "the pstack role map"],
	[/`pstack-models\.mdc`/g, "the pstack role map"],
	[/pstack-models\.mdc/g, "the pstack role map"],

	// Cursor's skill and plugin locations. Pi installs skills from the package and the user's
	// agent directory.
	[/`~\/\.cursor\/plugins\/`/g, "the pi-pstack package's"],
	[/`~\/\.cursor\/skills\/`/g, "`~/.pi/agent/skills/`"],
	[/`\.cursor\/skills\/`/g, "the project's `.pi/skills/`"],
	[/`\.cursor\/skills\/verify-<app>\/`/g, "the project's `.pi/skills/verify-<app>/`"],
	[/`\.cursor\/skills\/verify-<app>`/g, "`.pi/skills/verify-<app>`"],
	[/`\.cursor\/skills\/<handle>\/<handle>-mode\/SKILL\.md`/g, "`.pi/skills/<handle>/<handle>-mode/SKILL.md`"],
	[/`\.cursor\/skills\/<handle>-mode\/SKILL\.md`/g, "`.pi/skills/<handle>-mode/SKILL.md`"],
	[/`\.cursor\/skills\/<handle>\/`/g, "`.pi/skills/<handle>/`"],
	[/`\.cursor\/skills\/`/g, "`.pi/skills/`"],
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
		/find the active workspace's `agent-transcripts\/` directory the system prompt names/g,
		"find the active workspace's session directory under `~/.pi/agent/sessions/`",
	],
	[
		/Reading local transcripts under `agent-transcripts\/`\./g,
		"Reading the current session's local transcript.",
	],
	[
		/<agent-transcripts>/g,
		"<session-dir>",
	],
	[
		/# Transcripts dir: ~\/\.cursor\/projects\/<slugified-repo-path>\/agent-transcripts\./g,
		"# Transcripts dir: Pi's session directory.",
	],
	[
		/slug=\$\(printf '%s' "\$main_wt" \| sed 's#\^\/##; s#\/#-#g'\)\ntranscripts="\$HOME\/\.cursor\/projects\/\$slug\/agent-transcripts"/g,
		'transcripts="$HOME/.pi/agent/sessions"',
	],

	// The interactive question tool.
	[/`AskQuestion`/g, "`ask_user_question`"],
	[/\bAskQuestion\b/g, "`ask_user_question`"],

	// The todo list. Pi has a `scratchpad` tool for a checklist of things to keep in mind.
	[/\bOpen a todolist\b/g, "Open a checklist"],
	[/\ba todolist\b/g, "a checklist"],
	[/\bthe todolist\b/g, "the checklist"],
	[/\btodolist\b/g, "checklist"],
	[/\btodo list\b/g, "checklist"],

	// Cursor-only features. The adapter documents each one, so the skill keeps the step and
	// says what Pi does instead.
	//
	// "Bugbot" stays a proper noun. It names a review bot, and a GitHub PR's review threads
	// are still review threads in Pi, so the triage rules apply unchanged.
	[/Cursor Automations/g, "Cursor Automations (not available in Pi)"],
	[/\bCursor cloud agents\b/g, "Cursor cloud agents (not available in Pi)"],
	[/\bCursor cloud agent\b/g, "Cursor cloud agent (not available in Pi)"],
	[/\bcloud agent\b/g, "remote agent"],
	[/\bcloud VM\b/g, "isolated environment"],
	[/the built-in PR tool/g, "the `gh` CLI"],

	// The `cursor-team-kit` plugin's skills. Pi has no equivalent, so the skill names what Pi
	// does instead: the project's own scripts, the `bash` tool, or the `unslop` skill.
	//
	// The specific rules come first. A generic `/deslop` rule would rewrite the text before
	// the rule that also mentions `cursor-team-kit` gets a chance to match it.
	[
		/- `\/deslop`, `control-cli`, and `control-ui` ship in the `cursor-team-kit` plugin\./g,
		"- `unslop` ships with pstack. The other two have no Pi equivalent; drive the surface with the project's own scripts.",
	],
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
	[
		/`cursor-team-kit` publishes `control-cli` \(CLIs and TUIs\) and `control-ui` \(browser \/ Electron \/ web UIs\)/g,
		"Pi drives those surfaces with the project's own scripts or the `bash` tool",
	],
	[/`\/deslop`/g, "the `unslop` skill"],

	// Cursor's background loop. Pi has no `/loop`; a subagent that waits polls instead.
	[/Cursor's `\/loop` command/g, "a polling watcher"],
	[/`\/loop` command/g, "a polling watcher"],
	[/`\/loop`/g, "a polling watcher"],
];

/**
 * Per-file replacements, applied after the global table. A file-specific rule wins over the
 * global table for text the global table cannot express.
 */
const FILE_RULES = [
	{
		match: "docs/guide/01-setup.md",
		rules: [
			[
				/## Install the plugin\n\nIn a Cursor chat, run:\n\n```text\n\/add-plugin pstack\n```\n\nCursor confirms the plugin is installed\.\n\nIn Claude Code, run `\/plugin marketplace add cursor\/plugins`, then `\/plugin install pstack@cursor-plugins`\. Claude Code prefixes plugin commands, so each command in this guide takes a `pstack:` prefix there, such as `\/pstack:setup-pstack`, which writes its model rule to `~\/\.claude\/rules\/pstack-models\.md`\. The \[Claude Code adapter\]\(\.\.\/harness\/claude-code\.md\) covers the other differences\./g,
				"## Install the package\n\nInstall it from the Pi package directory:\n\n```bash\npi install /path/to/pi-pstack\n```\n\nPi confirms the package is installed. The extension registers the `/poteto-mode`, `/setup-pstack` and `/pstack-models` commands, and the skills load as `/skill:<name>` commands. The [Pi adapter](../harness/pi.md) covers the differences from Cursor.",
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
				/It drafts `\.pi\/skills\/<your-name>-mode\/SKILL\.md` through Cursor's built-in `create-skill` flow/g,
				"It drafts `.pi/skills/<your-name>-mode/SKILL.md` through the authoring-a-skill playbook",
			],
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
				'Every spawn is a read-only `subagent` call with `agent: "delegate"`.',
			],
		],
	},
	{
		match: "skills/why/SKILL.md",
		rules: [
			[
				/Every spawn is `generalPurpose` with agent mode \(agent mode\)\./g,
				'Every spawn is a `delegate` agent with agent mode.',
			],
			[/list the available MCPs from the Cursor environment/g, "list the available MCP servers from the Pi environment"],
			[/inspect the `mcps\/` directory Cursor exposes for enabled MCP servers/g, "inspect the MCP servers the session has registered"],
		],
	},
	{
		match: "skills/poteto-mode/SKILL.md",
		rules: [
			[
				/The `deslop` skill from the `cursor-team-kit` plugin \(`\/deslop`\)/g,
				"the `unslop` skill (Pi has no `deslop` skill)",
			],
			[
				/Shipping UI \/ IDE \/ CLI → the matching control skill\. `cursor-team-kit` publishes `control-cli` \(CLIs and TUIs\) and `control-ui` \(browser \/ Electron \/ web UIs\)\./g,
				"Shipping UI / IDE / CLI → drive the surface yourself with the project's own scripts or the `bash` tool.",
			],
			[
				/Before commit → the `deslop` skill from the `cursor-team-kit` plugin \(`\/deslop`\)\./g,
				"Before commit → the `unslop` skill, then the project's own formatter and linter.",
			],
			[
				/Agent-facing prose also follows the `create-skill` skill \(Cursor's built-in for authoring SKILL\.md files\)\./g,
				"Agent-facing prose also follows the `authoring-a-skill` playbook.",
			],
			[
				/Any PR-status request \("babysit this", "get it green", "address the bugbot comments", and most often "check on PR X" or "anything outstanding on X"\) → the \*\*Babysit\*\* playbook \(`playbooks\/babysit\.md`\), not Cursor's built-in babysit skill, whose description matches the same words\./g,
				'Any PR-status request ("babysit this", "get it green", "address the review comments", and most often "check on PR X" or "anything outstanding on X") → the **Babysit** playbook (`playbooks/babysit.md`).',
			],
		],
	},
	{
		match: "skills/poteto-mode/playbooks/orchestrate.md",
		rules: [
			[
				/includes `environment`/g,
				"includes `cwd` and `worktree`",
			],
		],
	},
	{
		match: "skills/swarm/SKILL.md",
		rules: [
			[
				/Spawn all N workers in one message with `agent: "delegate"`, `environment: "cloud"`, `run_in_background: true`, and the step 4 model, left unset for `auto` or `inherit-parent`\. Use `environment: "local"` only when the worker needs access to something on the user's computer\./g,
				"Spawn all N workers in one message with `agent: \"delegate\"`, `async: true`, and the step 4 model, left unset for `auto` or `inherit-parent`. Use `worktree: true` when a worker needs its own checkout.",
			],
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
				'Each reviewer gets `agent: "delegate"`, a read-only tool set, and `model` set to its configured entry',
			],
		],
	},
	{
		match: "skills/reflect/SKILL.md",
		rules: [
			[
				/One message, three `subagent` calls, `agent: "delegate"`, agent mode \(agent mode\)\./g,
				'One message, three `subagent` calls, `agent: "delegate"`, agent mode.',
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
				"Locate the active workspace's transcripts before fanning out. Pi keeps them under `~/.pi/agent/sessions/`. Use only the current session's file. That reads private chats from unrelated projects otherwise.",
			],
		],
	},
	{
		match: "skills/poteto-mode/playbooks/session-pickup.md",
		rules: [
			[
				/A local transcript under the active workspace's `agent-transcripts\/` directory \(the system prompt names the path\. Do not glob across `~\/\.cursor\/projects\/\*\/`, that crosses workspace boundaries and reads private chats from unrelated projects\), a cloud-agent URL, or a pushed branch\./g,
				"A local transcript in Pi's session directory under `~/.pi/agent/sessions/` (read only the current session's file, that crosses workspace boundaries otherwise), or a pushed branch.",
			],
		],
	},
	{
		match: "skills/poteto-mode/playbooks/eval.md",
		rules: [
			[
				/Read each candidate's local transcript under the active workspace's `agent-transcripts\/` directory \(the system prompt names this path\)\. Do not glob across `~\/\.cursor\/projects\/\*\/`\. That crosses workspace boundaries and reads private chats from unrelated projects\./g,
				"Read each candidate's local transcript in Pi's session directory under `~/.pi/agent/sessions/`. Read only the current session's file. That reads private chats from unrelated projects otherwise.",
			],
		],
	},
	{
		match: "skills/poteto-mode/scripts/worktree-audit.sh",
		rules: [
			[
				/transcripts="\$HOME\/\.cursor\/projects\/\$slug\/agent-transcripts"/g,
				'transcripts="$HOME/.pi/agent/sessions"',
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
			[
				/\(under `\.pi\/skills\/`, `~\/\.pi\/agent\/skills\/`, or the pi-pstack package's\)/g,
				"(under the project's `.pi/skills/`, `~/.pi/agent/skills/`, or the pi-pstack package's)",
			],
			[/\ba `Task` prompt naming its path/g, "a `subagent` prompt naming its path"],
		],
	},
	{
		match: "skills/reflect/references/tooling-reviewer.md",
		rules: [
			[
				/\(under `\.pi\/skills\/`, `~\/\.pi\/agent\/skills\/`, or the pi-pstack package's\)/g,
				"(under the project's `.pi/skills/`, `~/.pi/agent/skills/`, or the pi-pstack package's)",
			],
			[/\ba `Task` prompt naming its path/g, "a `subagent` prompt naming its path"],
		],
	},
	{
		match: "skills/reflect/references/divergent-reviewer.md",
		rules: [
			[
				/\(under `\.pi\/skills\/`, `~\/\.pi\/agent\/skills\/`, or the pi-pstack package's\)/g,
				"(under the project's `.pi/skills/`, `~/.pi/agent/skills/`, or the pi-pstack package's)",
			],
			[/\ba `Task` prompt naming its path/g, "a `subagent` prompt naming its path"],
		],
	},
	{
		match: "skills/maintain-verification-skill/SKILL.md",
		rules: [
			[
				/\(usually `\.pi\/skills\/verify-\*\/`\)/g,
				"(usually `.pi/skills/verify-*/`)",
			],
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
		/default to one each on `claude-opus-5-5-xhigh` and `grok-4\.7-xhigh-fast`/g,
		"default to one on each of the two families the role map names for that role",
	],
	[
		/`claude-opus-5-5-xhigh` and `grok-4\.7-xhigh-fast`/g,
		"the two families the role map names for that role",
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
	[
		/`claude-opus-5-5-xhigh` by default/g,
		"the role map's entry for that role, by default",
	],
	[/use `grok-4\.7-xhigh-fast`/g, "use the role map's entry for that role"],
	[/\(default `grok-4\.7-xhigh-fast`\)/g, "(the role map's entry for that role)"],
	[/\(default `claude-opus-5-5-xhigh`\)/g, "(the role map's entry for that role)"],
	[
		/`grok-4\.7-xhigh-fast` \(default\)/g,
		"the role map's entry for that role (default)",
	],
	[
		/`claude-opus-5-5-xhigh` \(default\)/g,
		"the role map's entry for that role (default)",
	],
	[
		/`grok-4\.7-xhigh-fast` by default\)/g,
		"the role map's entry for that role, by default)",
	],
	[
		/`claude-opus-5-5-xhigh` by default\)/g,
		"the role map's entry for that role, by default)",
	],
	[/use `grok-4\.7-xhigh-fast`\./g, "use the role map's entry for that role."],
	[/default `grok-4\.7-xhigh-fast`\./g, "the role map's entry for that role."],
	[/default `claude-opus-5-5-xhigh`\./g, "the role map's entry for that role."],

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
		/stays on the `swarm workers` model and speed \(`grok-4\.7-xhigh-fast` by default\)/g,
		"stays on the `swarm workers` model and speed",
	],
	[
		/`model` from the `reflect judgment, divergent, synthesizer` line \(default `claude-opus-5-5-xhigh`\)/g,
		"`model` from the `reflect judgment, divergent, synthesizer` line",
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
		"Pi model ids are provider-scoped, so the family is the provider prefix. A rejected entry runs on the same role's other entry. With no family match, use the role map's first entry.",
	],
	[
		/A refused `composer-\*` entry runs on Reviewer B's default\. With no family match, use Reviewer A's default\./g,
		"A rejected entry runs on the same role's other entry. With no family match, use the role map's first entry.",
	],
	[
		/Families go by prefix: `claude-\*`, and `grok-\*` with `cursor-grok-\*` and `composer-\*`\./g,
		"Pi model ids are provider-scoped, so the family is the provider prefix.",
	],
	[
		/So `unlimited` turns `claude-opus-5-5-xhigh` into `claude-opus-5-5-max`\. Grok slugs top out at `xhigh`, so under `unlimited` the fallback puts Grok at `xhigh` and keeps `grok-4\.7-xhigh-fast` as it is\. `large` keeps both defaults\. `small` turns them into `claude-opus-5-5-medium` and `grok-4\.7-medium-fast`\./g,
		"A budget raises or lowers the effort token of each role's model, within the levels that model declares. `large` keeps the role map as it is.",
	],
];

function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		if (name === ".DS_Store" || name === "node_modules") return [];
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

/** Applies the replacement table to one file's text. */
function port(text, relativePath) {
	// A source file is copied verbatim. A prose replacement applied to code can corrupt an
	// identifier, so the rewrite never touches a file that is not prose.
	if (!PROSE_EXTENSIONS.has(extname(relativePath))) return text;
	let out = text;
	for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
	for (const [pattern, replacement] of MODEL_DEFAULTS) out = out.replace(pattern, replacement);
	for (const rule of FILE_RULES) {
		if (rule.match !== relativePath) continue;
		for (const [pattern, replacement] of rule.rules) out = out.replace(pattern, replacement);
	}
	return out;
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

function render() {
	const files = new Map();

	for (const path of walk(join(UPSTREAM, "skills"))) {
		const relativePath = relative(join(UPSTREAM, "skills"), path);
		files.set(`skills/${relativePath}`, readFileSync(path, "utf8"));
	}
	for (const path of walk(join(UPSTREAM, "agents"))) {
		const relativePath = relative(join(UPSTREAM, "agents"), path);
		files.set(`agents/${relativePath}`, readFileSync(path, "utf8"));
	}
	// The guide is prose, so the same term table applies. Its images are binary, so they are
	// read as bytes and copied without a rewrite.
	for (const path of walk(join(UPSTREAM, "docs", "guide"))) {
		const relativePath = relative(join(UPSTREAM, "docs", "guide"), path);
		const key = `docs/guide/${relativePath}`;
		files.set(key, PROSE_EXTENSIONS.has(extname(relativePath)) ? readFileSync(path, "utf8") : readFileSync(path));
	}

	const rendered = new Map();
	for (const [relativePath, content] of files) {
		// A hand-written file replaces the ported one entirely.
		const override = join(OVERRIDES_DIR, relativePath);
		if (existsSync(override)) {
			rendered.set(relativePath, readFileSync(override, "utf8"));
			continue;
		}
		// A binary file is copied, not rewritten.
		if (!PROSE_EXTENSIONS.has(extname(relativePath))) {
			rendered.set(relativePath, content);
			continue;
		}
		let out = port(content, relativePath);
		// The agent prompts are not skills, so they get no adapter line, but they do get the
		// Cursor names removed. The guide pages are read by a human, so they get the adapter
		// link only when they mention a Cursor name.
		if (relativePath.endsWith("SKILL.md") && needsAdapter(out) && /^# /m.test(out)) {
			out = out.replace(/^(# .*)\n+/m, `$1\n\n${ADAPTER_LINE}\n\n`);
		}
		rendered.set(relativePath, out);
	}
	return rendered;
}

const rendered = render();

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
		if (path.includes("setup-pstack") && path.endsWith("SKILL.md")) continue;
		if (typeof content !== "string") continue;
		for (const rule of FORBIDDEN) {
			if (rule.except.includes(path)) continue;
			const match = content.match(rule.pattern);
			if (match) {
				const line = content.slice(0, match.index).split("\n").length;
				problems.push(`${path}:${line} ${rule.label} (${match[0]})`);
			}
		}
	}
	return problems;
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
		if (!have.equals(want)) drifted.push(path);
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
		const out = path.startsWith("agents/")
			? join(AGENTS_OUT, path.slice("agents/".length))
			: path.startsWith("docs/guide/")
				? join(GUIDE_OUT, path.slice("docs/guide/".length))
				: join(SKILLS_OUT, path.slice("skills/".length));
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, content);
	}
	console.log(`ported ${rendered.size} files into skills/, agents/ and docs/guide/`);
}
