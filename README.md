# pi-pstack

把 [pstack](https://github.com/cursor/plugins/tree/main/pstack) 這套「先深後快」的工程流程移植到 Pi。

pstack 的原始碼是 Lauren Tan 為 Cursor 寫的 plugin，核心主張很直接：**AI 寫太多廢碼**。它不追求行數，而是用一套嚴謹的 playbook、刻意分工的 subagent、乾淨的散文，以及「先證明再做完了」的工作紀律，把同一件事寫得更少但更好。

這個 repo 是它的 Pi 版本。上游程式碼放在 `upstream/`，`skills/`、`agents/`、`docs/guide/` 全部由 `scripts/port-skills.mjs` 機械式生成，所以上游更新後可以重新產生，不會產生無止境的合併衝突。

## 安裝

```bash
pi install /path/to/pi-pstack
```

或者在本 repo 直接試跑：

```bash
pi -e . 
```

安裝後你會拿到：

- `/poteto-mode` — 主入口。給它一個任務，它挑 playbook、照著步驟走。
- `/setup-pstack` — 設定每個角色用哪個模型、推理預算多高。
- `/pstack-models` — 檢視目前的角色對應表。
- 56 個 skill（含 24 個 `principle-*`），用 `/skill:<name>` 呼叫。

## 快速開始

兩步：

1. 跑 `/setup-pstack`，選一個推理預算，選你要的模型。
2. 之後任何需要嚴謹的工作，都從 `/poteto-mode` 開始。

```text
/poteto-mode 這個 PR 的 scroll 在閒置時每 750ms 會漂移一次。先重現，再修好並驗證。
```

你不需要指名 playbook 或列出 skill。「先重現」加上一個可檢查的結果，就是 `/poteto-mode` 需要的全部路由訊號。它會對應到 Bug fix playbook，把步驟複製進 checklist，並在每個步驟 fire 時叫出對應的 skill。

### 在互動 session 裡用

`/poteto-mode` 是一個 slash command，它啟動的 turn 由 Pi 的互動 session 承接。在 `pi -p` 這種一次性的 print 模式下，**任何** extension command 都拿不到模型的輸出（`/btw` 等既有 extension 也一樣），所以 `pi -p "/poteto-mode ..."` 會沒有回應。要在腳本或 CI 裡跑，用 RPC 模式：

```bash
pi -e . --mode rpc
```

## 與上游的差異

移植不是字串替換而已。以下是實際改了什麼，以及為什麼。

### 工具名稱

| Cursor | Pi |
| --- | --- |
| `Task` tool | `subagent` tool |
| `subagent_type: generalPurpose` | `agent: "delegate"` |
| `subagent_type: "poteto-agent"` | `agent: "poteto-agent"` |
| `readonly: true` / `false` | 唯讀工具組 / agent mode |
| `run_in_background: true` | `async: true` |
| `environment: "cloud"` | `worktree: true` |
| `AskQuestion` | `ask_user_question` |
| todolist | `scratchpad` |
| `~/.cursor/rules/pstack-models.mdc` | `~/.pi/agent/state/pi-pstack/models.json` |

完整對照表在 [`docs/harness/pi.md`](docs/harness/pi.md)。每個 skill 都會連到那張表，所以模型讀到任何 Cursor 名稱都知道該怎麼換。

### 模型路由

上游的模型預設值（`claude-opus-5-5-xhigh`、`grok-4.7-xhigh-fast`）是 Cursor 專屬的 slug。Pi 的 model catalog 跟著機器走，所以這裡換成**角色表**：skill 只說「這是哪個角色」，具體模型由角色表決定。

角色表的行為：

- 來源是 `ctx.scopedModels`，也就是你 `enabledModels` 設限後真正能啟動的模型，不會寫進你根本沒權限用的 slug。
- 推理預算（`unlimited` / `large` / `medium` / `small`）以 Pi 的 `:level` suffix 承載，並受模型自己宣告的 level 上限約束。角色不會在你選的預算之外偷偷燒錢。
- **判斷類角色**（`judgment and prose`、`hardest tasks`、`interrogate reviewers` 等）拿最貴的模型，因為答錯比答慢貴。
- **程式類角色**（`feature, refactoring`、`bug-fix`、`swarm workers` 等）拿中價位模型，因為它每次改檔都會跑。
- **panel 角色**（`arena runners`、`architect runners`、`interrogate reviewers`）會分散到不同 model family。兩個 entry 用同一個模型的 panel，比較的意義就沒了。

```bash
/pstack-models          # 看現在長什麼樣
/setup-pstack large     # 直接指定預算，不進互動選單
```

### Cursor 專屬功能

以下功能 Pi 沒有。skill 會保留該步驟，並在回覆裡寫一行 `Skipped in Pi: <step>. <reason>.`，然後繼續往下走，不停下來問。

| Cursor | Pi 的替代做法 |
| --- | --- |
| Cursor Automations | 略過該步 |
| Bugbot | GitHub PR 的 review comment 照常是 review thread，triage 規則不變 |
| Cursor cloud agents | `worktree: true` |
| 內建 PR 工具 | `gh` CLI |
| `/loop` | polling watcher |
| `cursor-team-kit` 的 `deslop` | `unslop` + 專案自己的 formatter / linter |
| `cursor-team-kit` 的 `control-cli` / `control-ui` | 專案自己的 driver script |

## 目錄結構

```text
extension/          Pi extension：runtime agent 註冊、指令、模型解析
skills/             56 個 skill（生成產物）
agents/             poteto-agent 與 comment-sicko（生成產物）
docs/guide/         pstack 指南（生成產物）
docs/harness/pi.md  Cursor → Pi 名稱對照表
upstream/           上游 pstack 0.15.29 原始碼
overrides/          機械式移植做不到、改以手寫的檔案
scripts/            移植與檢查腳本
```

## 開發

```bash
npm run link:host    # 把 host 的 pi-coding-agent 連到 node_modules，測試需要
npm run typecheck   # tsc，strict
npm test            # node --test
npm run port:skills  # 重新產生 skills/、agents/、docs/guide/
npm run check:skills # 確認生成產物是最新的
```

`port:skills` 會做兩件事：

1. 套用 Cursor → Pi 的名稱替換表。**只套用在散文檔**（`.md`、`.sh`、`.mjs`）。上游的 TypeScript 會逐字複製，因為把散文替換套在程式碼上會弄壞識別字——上游的 `watch-pr` 有一行是拿 review bot 的登入名比對，替換掉就壞了。
2. 驗證沒有 Cursor 名稱殘留。殘留的名稱會讓 port 直接失敗，因為那是靜默的行為差異：模型讀到一個 Pi 裡不存在的名字，會自己猜一個或跳過那一步。

`upstream/` 保持上游原樣，`overrides/` 放的是機械式移植做不到的檔案。目前只有 `setup-pstack`：上游那一版的每一步都是 Cursor 專屬的（寫 always-applied rule、從 Cursor 偵測模型），所以是整份重寫，不是改寫。

## 與上游同步

```bash
# 更新 upstream/ 到新的上游版本，然後：
npm run port:skills
npm run check:skills
```

上游改了 skill 的內容，port 會自動跟上。上游改了 skill 的「形狀」（例如 `setup-pstack` 那種每步都不同的），就需要在 `overrides/` 補一份。

## 授權

上游 pstack 是 MIT，見 [`LICENSE`](LICENSE)。這個移植沿用同一份授權。
