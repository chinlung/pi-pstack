# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

pi-pstack 是上游 [pstack](https://github.com/cursor/plugins/tree/main/pstack)（Cursor plugin）的 Pi 移植版：一組 skill、兩個 subagent 與一個 Pi extension。使用說明與設計理由在 `README.md`，Cursor → Pi 名稱對照表在 `docs/harness/pi.md`，不在此重複。

## 指令

```bash
npm run check        # typecheck + test + check:skills，提交前的完整閘門
npm run typecheck    # tsc --project extension/tsconfig.json（strict）
npm test             # node --test：extension/tests/*.test.ts 與 scripts/tests/*.test.mjs
npm run port:skills  # 由 upstream/ 與 overrides/ 重新產生 skills/、agents/、docs/guide/
npm run check:skills # 確認生成產物是最新的（不寫檔）
npm run sync:upstream  # 連網：鏡像上游 pstack/ 進 upstream/ 並寫 upstream/.synced-from（--ref 指定版本）
npm run check:upstream # 離線：upstream/ 的內容摘要仍等於 .synced-from 記錄的（已併入 npm run check）
```

跑單一測試檔（`pretest` 不會自動執行，先連結 host 套件）：

```bash
node scripts/link-host-packages.mjs
node --experimental-strip-types --test extension/tests/roles.test.ts
node --experimental-strip-types --test --test-name-pattern='GNU stat' scripts/tests/worktree-audit.test.mjs
```

- `typecheck`／`test` 依賴 `scripts/link-host-packages.mjs` 把 Pi 提供的 `@earendil-works/pi-coding-agent`、`typebox`、`pi-subagents` 連進 `node_modules`（來源是本機安裝的 Pi，`~/.pi/agent/install/current-version` 優先於 `PI_VERSION`）。沒裝 Pi 時，把 `PI_CODING_AGENT_DIR` 指向一個從 npm 組出同樣結構的目錄，做法見 `.github/workflows/ci.yml`。
- CI（`.github/workflows/ci.yml`）在 push 到 main 與每個 PR 跑 `npm run check`。host 套件從 `ci/` 的 lockfile root 以 `npm ci` 安裝：`ci/pi-release/` 是 Pi installer 自己的 lockfile root（`~/.pi/agent/install/releases/<版本>/` 的 `package.json` 與 `package-lock.json` 原樣複製），`ci/pi-agent-npm/` 鎖 `pi-subagents`。升級 Pi 後重新複製這兩份。
- `scripts/tests/worktree-audit.test.mjs` 需要 `bash`、`jq`、`rg`。在 Claude Code 沙箱內 `mktemp` 會寫 `/var/folders` 被擋而讓整檔誤失敗，要在沙箱外跑。

## 架構：誰是原始碼，誰是產物

```
upstream/   上游 pstack 原樣副本（skills、agents、docs），只讀，不手改；來源 commit、版本與內容摘要記在 upstream/.synced-from
overrides/  機械式替換做不到、改以手寫的檔案（setup-pstack、poteto-help、worktree-audit.sh）
   │
   ▼  scripts/port-skills.mjs
skills/  agents/  docs/guide/    生成產物，不手改（check:skills 會抓不同步）
```

- **改 skill 內容只有三處合法**：`scripts/port-skills.mjs` 的規則、`overrides/`、或更新 `upstream/`。直接改 `skills/`、`agents/`、`docs/guide/` 下次 port 就被覆蓋。
- 改完 `port-skills.mjs` 或 `overrides/` 要重跑 `npm run port:skills`，測試讀的是生成後的 `skills/`。
- `port-skills.mjs` 的規則表分三層，順序有意義：`FILE_RULES`（單檔，前後各跑一次）→ `REPLACEMENTS`（全域，僅 `.md`）→ `MODEL_DEFAULTS`（上游 slug 改成 role map 敘述）。程式檔（`.ts`／`.mjs`／`.sh`）逐字複製，只能靠單檔規則改。
- **閘門是設計的一部分**：每條規則必須至少改到一個檔案（失效規則讓 port 失敗）、不得殘留 Cursor 名稱、相對連結必須指向存在的檔案。更新 `upstream/` 後多半是這些閘門紅燈，逐條對照新文字修規則，不要為了過關而放寬閘門。
- 同步上游：`npm run sync:upstream`（取代手動 sparse clone＋rsync；它由實際 checkout 取 commit SHA 寫進 `.synced-from`，別手填；要看上游改了什麼就 `git diff <舊 commit> <新 commit> -- pstack`）→ `npm run port:skills` → 修失效規則 → 同步 `overrides/` 與上游的差異（`diff upstream/skills/<skill>/SKILL.md overrides/skills/<skill>/SKILL.md`，剩下的差異應全是刻意的 Pi 改寫）→ README 與 `docs/harness/pi.md` 裡的版本、skill 總數同步 → `npm run check`。

### extension（`extension/`）

- `index.ts` 註冊三類東西：runtime agent（`poteto-agent`、`comment-sicko`）、指令（`/setup-pstack`、`/pstack-models`、`/poteto-mode`，以及為非 `principle-*` skill 動態註冊的短指令）、模型查詢 tool `pstack_models`。
- 角色對模型的對應（上游放在 Cursor always-applied rule）改存成 `~/.pi/agent/state/pi-pstack/models.json`（`store.ts`）。角色清單與 seat 數在 `roles.ts`，從偵測到的模型解出預設值在 `models.ts`（panel 角色先分 family 再挑模型）。
- 兩個 subagent **只能**由 `runtime-agents.ts` 經 pi-subagents 事件匯流排註冊，不能同時存在於 `package.json` 的 `pi.subagents.agents`、`~/.pi/agent/agents/` 或專案 `.pi/agents/`，否則每次 subagent launch 的 agent discovery 都失敗。原因與工具組細節在 README「Subagent 的來源只有一個」。

## 注意事項

- 改 skill 的措辭前先讀 `docs/harness/pi.md`：Pi 沒有 Cursor 的 cloud agent、Automations、`/loop`，對應是 `worktree: true`、略過該步、polling watcher。移植後的文字要在 Pi 語意下仍成立（例如不能留下「cloud VM」這類 Pi 沒有的概念）。
- `README.md` 與 `docs/harness/pi.md` 寫死了 skill 總數與隱藏數（`disable-model-invocation: true`），新增或移除 skill 時要手動同步。
- `.pi/`、`.claude/`、`*.local.md` 被 git 忽略，是本機工作狀態。
