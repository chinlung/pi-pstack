#!/usr/bin/env bash
# Read-only worktree prune audit. Classifies every git worktree by size, merge
# state, uncommitted work, remote/PR state, and the most recent chat that
# operated in it. Emits a table sorted by size with a suggested bucket. Never
# deletes anything; deletion stays a human-gated step in the playbook.
#
# Usage: worktree-audit.sh [-b|--base <ref>] [repo-path]
#   repo-path defaults to the current repo.
#   -b sets the ref the MERGED column checks against (e.g. origin/integration).
#   Without it the base is origin/HEAD, then origin/main, then origin/master.
#   origin/HEAD is the remote's default branch, not necessarily the branch PRs
#   merge into; pass -b when they differ.
set -u
set -o pipefail

# GNU coreutils (Linux, nix, Homebrew gnubin) reads `stat -f` as file system status,
# which succeeds with unrelated output, and `date -r` as a file. Pick the flags once
# instead of trying BSD first and falling back on failure.
if stat -c %Y / >/dev/null 2>&1; then
	file_mtime() { stat -c '%Y' "$1"; }; fmt_day() { date -d "@$1" '+%Y-%m-%d'; }
else
	file_mtime() { stat -f '%m' "$1"; }; fmt_day() { date -r "$1" '+%Y-%m-%d'; }
fi

session_path() {
	node -e '
		const path = process.argv[1];
		const expanded = path === "~" || path.startsWith("~/") ? require("node:os").homedir() + path.slice(1) : path;
		const local = expanded.startsWith("file://") ? require("node:url").fileURLToPath(expanded) : expanded;
		process.stdout.write(require("node:path").resolve(local));
	' "$1" 2>/dev/null || { echo "error: cannot resolve Pi session storage path" >&2; return 1; }
}
# Resolve relative configuration before changing to the audited repository.
agent_dir=$(session_path "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}") || exit 1
session_dir=""
if [ -n "${PI_CODING_AGENT_SESSION_DIR:-}" ]; then session_dir=$(session_path "$PI_CODING_AGENT_SESSION_DIR") || exit 1; fi

base=""
while [ $# -gt 0 ]; do
	case "$1" in
	-b|--base) [ $# -ge 2 ] || { echo "error: $1 needs a ref" >&2; exit 2; }; base="$2"; shift 2 ;;
	-h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
	-*) echo "error: unknown option: $1" >&2; exit 2 ;;
	*) break ;;
	esac
done

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1
git rev-parse --git-dir >/dev/null 2>&1 || { echo "error: not a git repo: $repo" >&2; exit 1; }

# Main worktree is the first entry; everything else is a candidate.
main_wt=$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -1)

if [ -z "$base" ]; then
	for cand in "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do
		[ -n "$cand" ] && git rev-parse --verify --quiet "$cand^{commit}" >/dev/null && { base="$cand"; break; }
	done
	[ -z "$base" ] && { echo "error: no base ref (origin/HEAD, origin/main, origin/master all missing); pass -b <ref>" >&2; exit 1; }
	echo "warn: no -b given; MERGED checks against $base" >&2
fi

# The base drives the merge check. The fetch is best-effort (stale is fine for
# a first pass) and runs before the check, since -b may name a branch not
# fetched yet. The explicit refspec creates it even in a single-branch clone.
case "$base" in
origin/*) git fetch origin "+refs/heads/${base#origin/}:refs/remotes/$base" --quiet 2>/dev/null \
	|| echo "warn: could not fetch $base; merged column may be stale" >&2 ;;
esac
git rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1 || { echo "error: base ref not found: $base" >&2; exit 1; }
base_ref=$(git rev-parse --symbolic-full-name "$base" 2>/dev/null)
case "$base_ref" in
refs/remotes/origin/*) base_branch=${base_ref#refs/remotes/origin/} ;;
refs/heads/*) base_branch=${base_ref#refs/heads/} ;;
*) base_branch="" ;;
esac

# Origin supplies no verified SHA here; its PRs can hold a tree, but only
# ancestry can prove it safe. GitHub merges must match both HEAD and base.
pr_limit=1000
normalize_prs() {
	jq -e --arg source "$1" --argjson limit "$pr_limit" '
		if type != "array" then error("expected PR array")
		elif length >= $limit then error("PR listing may be truncated") else
			map(if $source == "origin" then
				{number, state: (.status | ascii_downcase), head: .headRef, headSha: null}
			else
				{number, state: (.state | ascii_downcase), head: .headRefName, headSha: .headRefOid, base: .baseRefName}
			end)
			| if all(.[]; (.head | type == "string" and length > 0)
				and (.state == "open" or .state == "draft" or .state == "closed" or .state == "merged"))
			then . else error("invalid PR head or state") end
		end'
}
prs=$(mktemp)
trap 'rm -f "$prs"' EXIT
if command -v origin >/dev/null 2>&1 \
	&& raw=$(origin pr list --state all --limit "$pr_limit" \
		--json number,status,headRef 2>/dev/null) \
	&& printf '%s' "$raw" | normalize_prs origin > "$prs" 2>/dev/null; then
	:
elif raw=$(gh pr list --state all --limit "$pr_limit" \
	--json number,state,headRefName,headRefOid,baseRefName 2>/dev/null) \
	&& printf '%s' "$raw" | normalize_prs github > "$prs" 2>/dev/null; then
	:
else
	echo "error: could not inspect PR state through Origin or GitHub" >&2
	exit 1
fi

# Default sessions are cwd-scoped; an explicit store is searched only for this worktree's path.
pi_session_dir() { printf '%s/sessions/--%s--' "$agent_dir" "$(printf '%s' "$1" | sed 's#^[/\\]##; s#[/\\:]#-#g')"; }
transcripts=${session_dir:-$(pi_session_dir "$main_wt")}
now=$(date +%s)

echo "# base: $base"
printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE\n"

git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r wt; do
	[ "$wt" = "$main_wt" ] && continue

	size=$(du -sh "$wt" 2>/dev/null | awk '{print $1}')
	head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
	head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
	age=$([ "$head_ts" -gt 0 ] 2>/dev/null && echo "$(( (now - head_ts) / 86400 ))d" || echo "?")

	# Squash merges need the PR record; ancestry proves fast-forward merges.
	git merge-base --is-ancestor "$head" "$base" 2>/dev/null && merged=YES || merged=no

	if ! porcelain=$(git -C "$wt" status --porcelain --untracked-files=all --ignore-submodules=none 2>/dev/null); then dirty=unknown
	elif [ -z "$porcelain" ]; then dirty=clean
	elif tracked=$(printf '%s\n' "$porcelain" | grep -cv '^??'); then
		dirty="wip:$tracked"
	else dirty="untracked:$(printf '%s\n' "$porcelain" | grep -c '^??')"; fi

	branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
	if [ -z "$branch" ]; then remote=detached
	elif git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
		[ "$(git -C "$wt" rev-parse "origin/$branch" 2>/dev/null)" = "$head" ] \
			&& remote=pushed \
			|| remote="ahead$(git -C "$wt" rev-list --count "origin/$branch..HEAD" 2>/dev/null)"
	else remote=no-remote; fi

	# Keep one record intact and let any open PR veto cleanup.
	pr_record=$([ -n "$branch" ] && jq -c --arg b "$branch" \
		'[.[] | select(.head==$b)] | (map(select(.state=="open" or .state=="draft"))[0] // .[0]) // empty' "$prs" 2>/dev/null)
	pr=$(jq -r '"#\(.number)/\(.state)"' <<< "$pr_record")
	[ -n "$pr" ] || pr="-"
	pr_head=$(jq -r '.headSha // empty' <<< "$pr_record")
	pr_base=$(jq -r '.base // empty' <<< "$pr_record")

	# Match a path boundary so glint-482 does not match glint-482-r37.
	last="-"; last_ts=0
	wt_sessions=""
	if [ -z "$session_dir" ]; then wt_sessions=$(pi_session_dir "$wt"); fi
	if [ -d "$transcripts" ] || [ -d "$wt_sessions" ]; then
		json_wt=$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]).slice(1, -1))' "$wt") || {
			echo "error: could not encode worktree path for session search" >&2
			exit 1
		}
		if ! f=$( { if [ -d "$transcripts" ]; then
				rg --hidden --no-ignore -F -l -0 -e "${wt}/" -e "${wt}\"" -e "${json_wt}/" -e "${json_wt}\"" "$transcripts" 2>/dev/null || [ "$?" -eq 1 ] || exit 1
			fi
			if [ -d "$wt_sessions" ]; then find "$wt_sessions" -name '*.jsonl' -type f -print0 2>/dev/null || exit 1; fi; } \
			| while IFS= read -r -d '' transcript; do
				mtime=$(file_mtime "$transcript" 2>/dev/null) || exit 1
				printf '%s\n' "$mtime"
			done | sort -rn | sed -n '1p'); then
			echo "error: could not inspect sessions for $wt" >&2
			exit 1
		fi
		if [ -n "$f" ]; then last_ts="$f"
			last=$(fmt_day "$last_ts" 2>/dev/null); fi
	fi
	recent=$([ "$last_ts" -gt 0 ] 2>/dev/null && [ $(( (now - last_ts) / 86400 )) -le 4 ] && echo yes || echo no)

	case "$dirty" in unknown) bucket=hold-unknown ;; wip:*) bucket=hold-wip ;; untracked:*) bucket=hold-untracked ;; *)
		case "$pr" in */open|*/draft) bucket=hold-open-pr ;; *)
			if [ "$recent" = yes ]; then bucket=verify-recent-chat
			elif [ "$merged" = YES ] || { [ -n "$head" ] && [ -n "$base_branch" ] && [ "${pr##*/}" = merged ] && [ "$pr_head" = "$head" ] && [ "$pr_base" = "$base_branch" ]; }; then bucket=safe
			else bucket=review; fi ;;
		esac ;;
	esac

	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh || exit
