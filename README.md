# 🤖 YouTube 影片實質內容事實查核 LINE Bot

## 1. 專案概述

本專案為部署於 **Google Apps Script (GAS)** 的高效能 LINE Bot，專為群組設計，能穿透 YouTube 影片的「點擊誘餌（Clickbait）」標題，直接深入分析影片的實質論點與主張。透過 **Gemini 2.5 AI** 的深度推理與 **Google Search 動態檢索查證**，為使用者提供精準、中立且極簡化的查核報表。

---

## 2. 核心技術特色

### 🚀 智慧型標題解析 (oEmbed Integration)

為了解決 AI 對於純 YouTube 網址可能產生的「幻覺」或「亂猜」問題，本程式會先透過官方 oEmbed API 抓取影片的「真實標題」與「頻道名稱」傳遞給 AI，確保分析的起點絕對準確。

### 🛡️ 多模型自動降級備援機制 (Auto-Fallback)

為應對大型模型在高負載時可能出現的 503 或 429 錯誤，系統建立了一套多層防護網，會按成本與效能順序自動切換模型：

1. **Gemini 3.1 Flash-Lite-Preview** (首選：2026 最新、配額最高)
2. **Gemini 2.5 Flash-Lite** (二選：穩定省錢)
3. **Gemini 2.5 Flash** (三選：推理較強備援)
4. **Gemini 1.5 Flash-8B** (四選：RPM 最鬆之最終保底)
5. **Gemini Flash Lite Latest** (保底動態節點)

### 💰 費用優化動態檢索 (Dynamic Retrieval)

不再對每次請求都進行高昂的 Google 搜尋。系統內建 **動態檢索門檻 (Threshold: 0.8)**，AI 只有在極度缺乏資訊時才會連網。這能為您省下絕大多數額外的聯網查核次數，極大程度保證 Free Tier 額度不被濫用。

### ❄️ 冷卻與頻率限制保護 (Rate Limit Protection)

內建 4 秒的降溫機制，當偵測到伺服器繁忙 (429/503) 時會自動暫停更長時間後才重試，有效避免因連續嘗試被系統判定惡意刷量而封鎖。

### ⚙️ 聯網查證功能旗標 (ENABLE_GROUNDING)

程式頂部提供一文字字元可切換整個聯網檢索功能，方便未來升級或降級：

```javascript
// Code.gs 第 11-14 行
const ENABLE_GROUNDING = false; // 預設為 Free Tier 安全模式
```

| 旗標値 | 行為 | 費用 |
| :--- | :--- | :--- |
| `false` | AI 基於訓練資料直接分析 | **$0 元**，完全免費，適合 Free Tier |
| `true` | 動態導入 Google 搜尋聯網檢證 | 超出免費額度後每 1,000 次搜尋約 $14 USD |

> **切換步驟**：直接修改 `const ENABLE_GROUNDING = true;`，再次部署最新版即可開啟。

### 🔒 封閉式白名單安全性

- **群組鎖定**：僅限列於 `ALLOWED_GROUP_IDS` 白名單中的專屬群組提供服務。
- **私訊防護**：對私訊者提供客氣的「家用私人專用」拒絕訊息，減少不必要的 API 消耗。
- **終端指令**：提供隱藏指令 `/get_group_id` 方便管理員快速獲取群組代碼。

---

## 3. AI 分析準則 (System Instruction)

本機器人遵從「穿透式查核」邏輯，產出結構如下：

1. **📌 核心摘要**：一句話指出影片內容的真實屬性與核心主張。
2. **⚖️ 觀點對照**：對比「影片內的主要論點」與「查證方的外部權威證據」。
3. **⚠️ 風險診斷**：識別標題黨、邏輯謬誤、去脈絡化或情緒勒索等風險。
4. **🔍 查證建議**：引導使用者進行二次複查的關鍵字與機構。

---

## 4. AI 生成參數說明 (Generation Config)

為了確保事實查核的品質，本專案對 AI 的生成參數進行了優化設定：

| 參數 | 設定值 | 為什麼要這樣設定？ |
| :--- | :--- | :--- |
| **Temperature** | `0.3` | **確保穩定性**：設定較低的值可降低 AI 隨機發揮的機率，確保對於同一個連結，AI 每次都能產出嚴謹、一致且基於事實的查證結果。 |
| **Max Output Tokens** | `2000` | **保留思考空間**：最新的 Gemini 2.x 模型具備「深度思考」機制。調高上限並非為了輸出長篇大論（我們會用指令控在 250 字內），而是**確保 AI 的背景推導過程不會因為額度不足而被強制截斷**導致當機。 |
| **Google Search** | `ENABLE_GROUNDING` 旗標控制 | **Free Tier（false）**：完全不使用，$0 元。**付費模式（true）**：動態觸發，超出免費配額後 $14/1000 次。 |

---

## 5. 費用與配額

| 模式 | 旗標設定 | Google Search | 模型費用 | GAS 環境 |
| :--- | :--- | :--- | :--- | :--- |
| **Free Tier（推薦）** | `ENABLE_GROUNDING = false` | $0（不使用） | 在免費配額內完全 $0 | 免費 |
| **Grounding 付費模式** | `ENABLE_GROUNDING = true` | 超額後 $14/1000 次 | Token 費用極低 | 免費 |

> 💡 **建議**：日常輕度使用請維持 `false`（Free Tier）。若遇到需要核對最新新聞、時事的影片，可手動改為 `true` 重新部署，用後再改回 `false`。

---

## 6. 部署與設定教學

### 第一步：基礎環境準備

1. 前往 [LINE Developers](https://developers.line.biz/) 建立 Channel，取得 `Channel Access Token`。
2. 前往 [Google AI Studio](https://aistudio.google.com/) 取得 `Gemini API Key`（建議開啟信用卡綁定以提升穩定性）。

### 第二步：GAS 部署與設定「指令碼屬性」 (關鍵安全設定)

為了確保金鑰安全，本專案建議將 API Key 存放在 GAS 的「指令碼屬性」中，而非直接寫在程式碼裡。

1. 在 GAS 編輯器左側選單點選 **「專案設定」** (齒輪圖示 ⚙️)。
2. 捲動至最下方找到 **「指令碼屬性」** 區塊。
3. 點選 **「編輯指令碼屬性」** ➔ **「新增指令碼屬性」**：
   - 屬性 (Property)：`LINE_ACCESS_TOKEN` / 值 (Value)：貼入您的 LINE Token。
   - 屬性 (Property)：`GEMINI_API_KEY` / 值 (Value)：貼入您的 Gemini API Key。
   - 屬性 (Property)：`ALLOWED_GROUP_IDS` / 值 (Value)：貼入允許的群組 ID (多個請用逗號 `,` 分隔)。
4. 點選 **「儲存指令碼屬性」**。
5. 點選 **「部署」➔「管理部署」➔「新版本」** 進行發布。
   - 執行身分：**我**
   - 誰可以存取：**所有人 (Anyone)**
6. 複製產出的 **Web App URL**，回到 LINE Developers 貼入 **Webhook URL** 並開啟 **Use webhook** 開關。

### 第三步：啟用群組白名單

1. 將機器人加入您要使用的群組。
2. 在群組輸入指令：`/get_group_id`。
3. 取得 `C` 開頭的編碼後，前往 GAS **「專案設定」** ➔ **「指令碼屬性」**，將其填入 `ALLOWED_GROUP_IDS` 屬性中。
4. 若已有其他群組，請使用半形逗號 `,` 分隔即可，不需重新部署程式碼。

---

## 7. 版本更新記錄

- **v2026.04.23.07**: 
  - 🛡️ **架構最終化**：統一採用 `PropertiesService` 管理所有敏感資訊（金鑰與白名單）。
- **v2026.04.23.05**: 
  - 🛡️ **安全性提升**：將金鑰存放方式改為「指令碼屬性 (Script Properties)」，避免金鑰硬編碼在程式碼中。
- **v2026.04.23.04**:
  - 🚀 初始 Free Tier 極致穩定版發布。
  - 支援 Gemini 3.1 / 2.5 / 1.5 Flash 系列模型自動降級。
  - 內建 oEmbed 標題抓取與 Google Search 動態檢索。
