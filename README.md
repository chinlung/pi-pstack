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
- `pstack_models` tool — 給模型用的唯讀版本。slash command 只有使用者能打，模型要查某個角色該用哪個模型，靠的是這個 tool。
- `poteto-agent` 與 `comment-sicko` 兩個 subagent。
- 56 個 skill（含 24 個 `principle-*`），用 `/skill:<name>` 呼叫。extension 另為其中 30 個非 `principle-*` 的 skill 註冊同名的短指令（`/how`、`/tdd` 等，等同 `/skill:<name>`），所以上游指南裡的範例照打即可；`principle-*` 仍要用 `/skill:principle-<name>`。其中 55 個設了 `disable-model-invocation: true`，Pi 不會把它們列進模型的 skill 清單，只能由使用者用 `/skill:<name>` 叫出，或由正在讀的 skill 依路徑讀取。

## 快速開始

兩步：

1. 跑 `/setup-pstack`，選一個推理預算，選你要的模型。
2. 之後任何需要嚴謹的工作，都從 `/poteto-mode` 開始。

```text
/poteto-mode 這個 PR 的 scroll 在閒置時每 750ms 會漂移一次。先重現，再修好並驗證。
```

你不需要指名 playbook 或列出 skill。「先重現」加上一個可檢查的結果，就是 `/poteto-mode` 需要的全部路由訊號。它會對應到 Bug fix playbook，把步驟複製進 checklist，並在每個步驟 fire 時叫出對應的 skill。

`/poteto-mode <task>` 等同於送出 `/skill:poteto-mode <task>`：它把 `poteto-mode` skill 的全文連同絕對路徑交給模型，再接上你的任務。`poteto-mode` 被隱藏在 skill 清單外，所以不能只叫模型「去讀 poteto-mode skill」——模型在清單裡找不到它。

### 在互動 session 裡用

`/poteto-mode` 是一個 slash command，它啟動的 turn 由 Pi 的互動 session 承接。在 `pi -p` 這種一次性的 print 模式下，**會啟動模型 turn 的** extension command 拿不到模型的輸出（`/btw` 等既有 extension 也一樣），所以 `pi -p "/poteto-mode ..."` 會沒有回應。只印報告的 `/pstack-models` 在 print 模式下會輸出，但走的是 **stderr**：Pi 在 print 模式會把 `process.stdout` 導到 stderr，只把模型的最終回覆寫到 stdout。要擷取它就用 `pi -p "/pstack-models" 2>&1`。要在腳本或 CI 裡跑 `/poteto-mode`，用 RPC 模式：

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
| `readonly: true` / `false` | review 用 `reviewer`；其他唯讀工作用 `delegate` 加「不要改檔」與事後 `git status` / `delegate` |
| `run_in_background: true` | `async: true` |
| `environment: "cloud"` | `worktree: true` |
| `AskQuestion` | `ask_user_question`（選用套件，沒有時用純文字問） |
| todolist | `scratchpad`（`pi-memory` 選用套件，沒有時把 checklist 寫在回覆裡） |
| `~/.cursor/rules/pstack-models.mdc` | `~/.pi/agent/state/pi-pstack/models.json` |

完整對照表在 [`docs/harness/pi.md`](docs/harness/pi.md)。每個 skill 都會連到那張表，所以模型讀到任何 Cursor 名稱都知道該怎麼換。

### 模型路由

上游的模型預設值（`claude-opus-5-5-xhigh`、`grok-4.7-xhigh-fast`）是 Cursor 專屬的 slug。Pi 的 model catalog 跟著機器走，所以這裡換成**角色表**：skill 只說「這是哪個角色」，具體模型由角色表決定。

角色表的行為：

- 來源是 `ctx.scopedModels`，也就是你 `enabledModels` 設限後真正能啟動的模型，不會寫進你根本沒權限用的 slug。沒設 `enabledModels` 時 Pi 給的是空清單，意思是「全部已驗證的模型都能用」，所以這時改用 registry 裡已驗證的模型。把空清單當成「沒有模型」會讓 setup 在最常見的設定下直接失敗。
- 推理預算（`unlimited` / `large` / `medium` / `small`）存一次在角色表的 `budget` 欄位，解析角色時才以 Pi 的 `:level` suffix 套上，並取模型宣告的 level 中不超過預算的最高者。角色值本身不帶 suffix，所以換預算不必重寫每個角色。有些 provider 只開放窄的 level 區間（例如 Bedrock 的 `["xhigh", "max"]`），這種模型沒辦法壓到預算內，報告會標 `(above budget)`，不會靜默超支。
- **判斷類角色**（`judgment and prose`、`hardest tasks`、`how explainer`、`why synthesizer` 等）拿最強的模型，因為答錯比答慢貴。「最強」是指：取模型宣告的 level 中不超過預算的最高者來比，不是比模型宣告的最高 level（宣告到 `max` 的模型在 `medium` 預算下強度是 `high`，不能因為它也提供 `max` 就被排除）；完全沒有預算內 level 的模型排最後；同分時才以單價較高者為準。價格只是拿來打破平手的代理指標，不是強弱本身。
- **程式類角色**（`feature, refactoring`、`bug-fix`、`swarm workers` 等）拿中價位模型，因為它每次改檔都會跑。
- **panel 角色**（`arena runners`、`arena cross-judge pool`、`architect runners`、`interrogate reviewers`）的每個 entry 先分到不同 model family，再在該 family 內依判斷類或程式類挑模型。panel 多樣性優先於「挑最強」：family 不夠分時改用同 family 的不同模型；只要可用模型多於一個，兩個 entry 就不能是同一個模型，否則比較的意義就沒了。
- **family 是模型的血統，不是 provider**：`claude`、`gpt`、`gemini`、`grok`、`deepseek`、`glm`、`qwen` 等。`anthropic/claude-sonnet-5-5` 與 `amazon-bedrock/global.anthropic.claude-sonnet-5-5` 是同一個模型經兩個 provider 提供，屬於同一個 family。以 provider 當 family 會讓 panel 拿到「同一個模型的兩份」，等於沒有第二意見。
- 重跑 `/setup-pstack` 會保留你之前手動設的角色（只要模型仍可用），只重新解析缺少的角色和模型已消失的角色。panel 角色整組保留或整組重解，避免 entry 數與 family 分布被打亂；已退役的角色名稱會被移除並列在報告裡。
- 手寫角色表時寫成 `provider/id:xhigh` 也可以：讀取時會拿掉合法的 level suffix 並回報，level 一律由預算決定。只有在完整字串本身不是 catalog id 時才拿掉，因為有些 id 本身就含冒號。
- 模型查角色時呼叫 `pstack_models` tool。有 tool、沒有角色表時，回傳由偵測到的模型解析出的預設值（`source: default`）；沒有 tool 或指定的角色不在表裡時，子代理直接用目前對話的模型，並在回覆裡說一聲，不自己編 slug。省略 `role` 時 tool 回傳全部 17 個角色，缺的角色以 parent 席位補上。

```bash
/pstack-models          # 看現在長什麼樣
/setup-pstack large     # 直接指定預算，跳過預算選單；有 UI 時仍會逐一確認角色
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
extension/          Pi extension：runtime agent 註冊、指令、pstack_models tool、模型解析
skills/             56 個 skill（生成產物）
agents/             poteto-agent 與 comment-sicko 的 prompt（生成產物，由 extension 讀取後註冊）
docs/guide/         pstack 指南（生成產物）
docs/harness/pi.md  Cursor → Pi 名稱對照表
upstream/           上游 pstack 0.15.29 原始碼
overrides/          機械式移植做不到、改以手寫的檔案
scripts/            移植與檢查腳本
```

## 開發

```bash
npm install          # 開發依賴：typescript、@types/node
npm run check        # typecheck + test + check:skills，提交前跑這個
npm run typecheck    # tsc，strict
npm test             # node --test
npm run port:skills  # 重新產生 skills/、agents/、docs/guide/
npm run check:skills # 確認生成產物是最新的
```

`typecheck` 與 `test` 會先跑 `scripts/link-host-packages.mjs`，把 Pi 提供給 extension 的套件（`@earendil-works/pi-coding-agent`、`typebox`）從 `~/.pi/agent/PI_VERSION` 指定的版本連進 `node_modules`，並連入 `~/.pi/agent/npm` 下安裝的 `pi-subagents`，讓測試用它真正的 runtime agent registry 驗證兩個 agent 的定義。這些套件由 Pi 在執行時提供，不能列為 dependency；`npm install` 會清掉這些連結，所以每次都重建。

`port:skills` 會做四件事：

1. 套用 Cursor → Pi 的名稱替換表。**全域替換表只套用在 `.md`**。程式檔（`.ts`、`.mjs`、`.sh`）逐字複製，因為把散文替換套在程式碼上會弄壞識別字——上游的 `watch-pr` 有一行是拿 review bot 的登入名比對，替換掉就壞了。程式檔裡真的需要改的地方，只能用針對單一檔案的規則明確指定，例如 `worktree-audit.sh` 的 transcript 路徑。
2. 驗證沒有 Cursor 名稱殘留。殘留的名稱會讓 port 直接失敗，因為那是靜默的行為差異：模型讀到一個 Pi 裡不存在的名字，會自己猜一個或跳過那一步。`Cursor` 這個字本身也是禁字，只有 `poteto-help`（說明這是 Cursor plugin 的移植版）與 `worktree-cleanup`（清理 Cursor 程式本身的磁碟空間）例外。
3. 每條替換規則都必須至少改到一個檔案，否則 port 失敗。上游改了文字、或前面的規則先改掉了它，這條規則就已經不做它作者以為的事；不檢查的話，它會安靜地失效。
4. 相對連結（inline 連結、圖片、reference-style 定義、`<…>` 包起來的目標）都必須指向這次 port 會產出、或套件根目錄手寫的檔案；生成目錄裡即將被刪除的舊檔不算。指向上游有、但沒移植的部分（目前只有 `automations/`）會改寫成上游的 GitHub 網址；其他找不到的目標都是拼錯或搬走的檔案，port 直接失敗，避免把讀者帶到一個 404。

有一個刻意保留的例外：multi-phase plan 樣板裡的 `` `/loop 1h` ``。`skills/poteto-mode/scripts/check-plan.mjs` 拿它當必要標記驗證計畫，替換掉會讓每份照樣板寫的計畫都檢查失敗。Pi 端的意思由 `docs/harness/pi.md` 的 `/loop` 那一列說明（改用每小時一次的 polling watcher）。

`upstream/` 保持上游原樣，`overrides/` 放的是機械式移植做不到的檔案。目前有 `setup-pstack` 與 `poteto-help`。`setup-pstack` 上游那一版的每一步都是 Cursor 專屬的（寫 always-applied rule、從 Cursor 偵測模型），所以是整份重寫，不是改寫。

## 與上游同步

```bash
# 更新 upstream/ 到新的上游版本，然後：
npm run port:skills
npm run check:skills
```

上游改了 skill 的內容，port 會自動跟上。上游改了 skill 的「形狀」（例如 `setup-pstack` 那種每步都不同的），就需要在 `overrides/` 補一份。

## Subagent 的來源只有一個

`poteto-agent` 與 `comment-sicko` 只由 extension 在 session start 註冊成 pi-subagents runtime agent。其他地方都不能有同名的 agent：`package.json` 的 `pi.subagents.agents`、`~/.pi/agent/agents/`、專案的 `.pi/agents/` 都不行。pi-subagents 註冊時不檢查撞名，而是在每次 launch 合併 agent 清單時才檢查，撞名就丟錯，結果是**每一次** subagent launch 的 agent discovery 都失敗，不只這兩個名字。

兩個 agent 的工具組要對得上它們的 prompt：`poteto-agent` 能改檔，也能再派子代理，因為 Feature playbook 要 code-coupled 工作的負責人在內部展開；`comment-sicko` 只回報不改檔，但要能派子代理，因為它的 prompt 會對可疑註解跑 **how** 與 **why** skill，而這兩個 skill 都會展開。runtime agent 定義不接受 `allowedAgents`，無法限制子代理能用哪些 agent，而 how／why 派的是能改檔的 `delegate`，所以子代理不改檔只靠 brief 約束；`comment-sicko` 沒有 `bash`，由派它出去的上層（**no-comments** skill 的執行者）在它回報後檢查 `git status`。巢狀深度受 pi-subagents 從根 session 算起的絕對上限約束，預設是 2：兩個 agent 只有在主 session 派出時才能再展開；由 `poteto-agent` 再派出的 `comment-sicko` 已在深度 2，不能展開，這時它直接讀程式碼判斷，並在報告裡說明沒有跑 how／why。不要設 `maxSubagentDepth: 1`，那會讓從主 session 派出的 `comment-sicko` 完全不能展開。

選 runtime 註冊而不是 package 檔案，是因為註冊時能把 skill 的絕對路徑寫進 prompt：`poteto-agent` 拿到 `poteto-mode`，`comment-sicko` 拿到 `how` 與 `why`。`poteto-mode` 被隱藏在 skill 清單外，`inheritSkills` 也不會把隱藏的 skill 帶給子代理，所以子代理只能靠這個路徑找到它。上游 frontmatter 的 `is_background: true` 對應到 runtime 定義的 `defaultAsync: true`。

## 授權

上游 pstack 是 MIT，見 [`LICENSE`](LICENSE)。這個移植沿用同一份授權。
