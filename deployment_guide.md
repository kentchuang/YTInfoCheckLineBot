# 🚀 AI 資訊查核助手：詳細部署指南

本指南針對 **LINE Developers** 與 **Google AI Studio** 的設定細節進行深入說明，確保您的機器人能順利運行於群組中。

---

## 1. LINE Developers 設定指南

### 🔹 建立 Messaging API Channel
1. 登入 [LINE Developers Console](https://developers.line.biz/)。
2. 建立一個 **Provider** (服務提供者)，名稱可自訂（如：MyTools）。
3. 點選 **Create a new channel**，選擇 **Messaging API**。
4. 填寫必要資訊：
   - **Channel name**：機器人名稱（如：AI 資訊查核助手）。
   - **Channel description**：機器人描述。
   - **Category**：隨選即可。

### 🔹 取得 Channel Access Token
1. 進入剛建立的 Channel。
2. 切換到 **Messaging API** 頁籤。
3. 捲動到最下方 **Channel access token** 區塊。
4. 點選 **Issue** 按鈕，複製產出的長字串。這就是 `LINE_ACCESS_TOKEN`。

### 🔹 重要功能設定 (必做！)
為了確保機器人在群組中運作正常且不干擾使用者，請務必檢查以下設定：

| 設定項目 | 位置 | 設定值 | 說明 |
| :--- | :--- | :--- | :--- |
| **Webhook URL** | Messaging API 頁籤 | 貼入 GAS Web App URL | 必須以 `https://` 開頭，貼上後點選 **Verify** 驗證。 |
| **Use webhook** | Messaging API 頁籤 | **開啟 (ON)** | 若未開啟，機器人將收不到任何訊息。 |
| **Allow bot to join groups** | Messaging API 頁籤 | **Enabled** | **非常重要**：若未開啟，機器人將無法被拉入群組。 |
| **Auto-response messages** | Messaging API 頁籤 > LINE Official Account features | **編輯 ➔ 停用** | **強烈建議**：關閉 LINE 預設的自動回覆，避免機器人對每則訊息都回覆「感謝您的訊息」。 |
| **Greeting messages** | Messaging API 頁籤 > LINE Official Account features | **編輯 ➔ 停用** | 關閉加入好友時的歡迎訊息。 |

---

## 2. Google AI Studio 設定指南

### 🔹 取得 Gemini API Key
1. 前往 [Google AI Studio (aistudio.google.com)](https://aistudio.google.com/)。
2. 點選左側選單的 **Get API key**。
3. 點選 **Create API key in new project**。
4. 複製產出的金鑰字串。這就是 `GEMINI_API_KEY`。

### 🔹 提升穩定性：信用卡綁定 (建議)
雖然 Gemini 提供 **Free Tier (免費版)**，但其每分鐘請求次數 (RPM) 較低且在高負載時容易出錯。
1. 在 AI Studio 中點選左下角的 **Settings** (齒輪)。
2. 找到 **Billing** 區塊並點選 **Set up billing**。
3. 綁定信用卡後，您會進入 **Pay-as-you-go** 模式。
4. **為什麼要綁定？**
   - **高優先權**：在高負載時，付費專案的穩定度遠高於免費版。
   - **聯網功能**：若您想開啟 `ENABLE_GROUNDING = true`，付費模式能提供更穩定的搜尋體驗。
   - **費用極低**：若僅用於個人/小群組，Gemini 的 Token 費用通常不到 $1 USD，甚至是免費的 (視特定模型額度而定)。

---

## 3. 回到 Google Apps Script (GAS)

完成上述設定後，請回到 GAS 編輯器：
1. 點選 **專案設定 (⚙️)** ➔ **指令碼屬性**。
2. 將 `LINE_ACCESS_TOKEN` 與 `GEMINI_API_KEY` 填入。
3. 若要啟用群組鎖定，請先將機器人**加入任一群組**並輸入 `/get_group_id` 取得 ID，再回填至 `ALLOWED_GROUP_IDS`。

> 💡 **部署提醒**：每次修改 `Code.gs` 後，請務必執行 **「部署 ➔ 管理部署 ➔ 編輯 ➔ 新版本」**，否則 LINE Webhook 執行的是舊版程式碼。
