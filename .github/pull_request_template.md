## 變更內容
<!-- 一兩句：做了什麼、為什麼。範圍以這裡寫的為準，順手改的東西另開 PR。 -->

## Testing
<!-- 跑了什麼、結果如何：貼命令與 exit code，不只寫「已測」。例：
     `npm run check > out.log 2>&1; RC=$?` → RC=0，126 passed（worktree-audit 測試需要 jq、rg）
     沒跑的檢查要寫出來並說為什麼（沒環境／不適用）。Claude 可以填，提出變更的人簽名。 -->

## Risk
<!-- low：文件、文案、flag 後的加法變更
     medium：一般產品變更；或動到快取、自動更新、system prompt 等敏感區
     deep：auth／crypto／payment／IaC／parser／LLM context 組裝、CI workflow、release／installer
     deep 要附 /code-audit-rigor 與 claude-security scan changes 的結果連結或摘要。 -->

## How to revert
<!-- 一行：revert 這個 PR 就夠？還是有 migration／flag／資料要先處理？ -->
