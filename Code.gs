/**
 * YouTube 資訊事實查核 LINE Bot
 * 版別：v2026.04.23.04 (Free Tier 極致穩定版)
 * 部署環境: Google Apps Script (GAS)
 */

// 1. 金鑰讀取 (從 GAS 「指令碼屬性」中讀取，確保安全性)
const LINE_ACCESS_TOKEN = PropertiesService.getScriptProperties().getProperty('LINE_ACCESS_TOKEN');
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
// 2. 功能旗標設定
//    ENABLE_GROUNDING = true  → 開啟 Google Search 聯網檢索（需附上信用卡，對話次數超出免費額度後會收費）
//    ENABLE_GROUNDING = false → 純 AI 訓練資料模式，完全免費，適合 Free Tier
const ENABLE_GROUNDING = false;

/**
 * 處理 LINE Webhook
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const events = data.events;

    if (!events || events.length === 0) return;

    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        processMessage(event);
      }
    }
  } catch (error) {
    console.error('Error in doPost:', error);
  }
}

/**
 * 處理訊息邏輯
 */
function processMessage(event) {
  const userText = event.message.text;
  const replyToken = event.replyToken;

  // 1. 隱藏指令：查詢群組代號
  if (userText === '/get_group_id') {
    if (event.source.type === 'group') {
      replyToLine(replyToken, `本群組的 ID 是：\n${event.source.groupId}`);
    } else {
      replyToLine(replyToken, `這裡不是群組喔！\n您的專屬 User ID 是：\n${event.source.userId}`);
    }
    return;
  }

  // 2. 群組白名單鎖定 (支援多個群組，請將群組 ID 存於 GAS 指令碼屬性 ALLOWED_GROUP_IDS，以逗號分隔)
  const rawAllowedIds = PropertiesService.getScriptProperties().getProperty('ALLOWED_GROUP_IDS') || "";
  const ALLOWED_GROUP_IDS = rawAllowedIds ? rawAllowedIds.split(',').map(id => id.trim()) : [];

  if (ALLOWED_GROUP_IDS.length > 0) {
    // 如果不符合白名單群組，進行阻擋處理
    if (event.source.type !== 'group' || !ALLOWED_GROUP_IDS.includes(event.source.groupId)) {
      // 若是有人試圖私訊 (user)，給予客氣的拒絕回應
      if (event.source.type === 'user') {
        replyToLine(replyToken, "⛔ 抱歉，這是一個私人專用的事實查核機器人，僅限於特定的家用群組內提供服務，恕不開放一對一私訊功能喔！\n\n💡 若需使用，請洽管理員取得「群組代號」，經設定後才可使用。");
      }
      // 至於被亂加到其他不相干的群組，則維持完全靜默 (已讀不回)，避免洗版
      return; 
    }
  }

  if (!isYoutubeUrl(userText)) {
    return; // 靜默原則
  }

  // A. 抓取 YouTube 影片標題 (避免 AI 憑空亂猜)
  let videoContext = userText;
  try {
    // 找出文字中的第一個 YouTube 連結
    const ytRegex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+)/;
    const match = userText.match(ytRegex);
    
    if (match) {
      const videoUrl = match[1];
      const oembedUrl = 'https://www.youtube.com/oembed?url=' + encodeURIComponent(videoUrl) + '&format=json';
      const oembedRes = UrlFetchApp.fetch(oembedUrl, { muteHttpExceptions: true });
      
      if (oembedRes.getResponseCode() === 200) {
        const oembedData = JSON.parse(oembedRes.getContentText());
        // 幫 AI 補足缺乏的神奇上下文
        videoContext = `請分析這支影片。網址：${videoUrl}\n影片標題：${oembedData.title}\n頻道名稱：${oembedData.author_name}`;
      }
    }
  } catch (err) {
    console.error('Oembed 抓取失敗:', err);
  }

  const analysisReport = callGeminiAPI(videoContext);

  if (analysisReport) {
    replyToLine(replyToken, analysisReport);
  }
}

/**
 * 檢查是否包含 YouTube 連結
 */
function isYoutubeUrl(text) {
  const ytRegex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+)/;
  return ytRegex.test(text);
}

/**
 * 呼叫 Gemini AI (含自動降級備援機制與 Grounding)
 */
function callGeminiAPI(userInput) {
  const systemInstruction = `
### 角色
你是一位精通「穿透點擊誘餌（Clickbait）」與「實質內容解析」的 LINE 事實查核專家。你擅長辨識影片標題與內容是否有落差，並將影片真實的論點與外部證據進行對比。

### 任務
分析使用者提供的影片內容（請務必根據影片的實質主張、內部敘述與邏輯進行分析）。**注意：你的所有評論應針對影片的「實質論點」，而非僅對影片標題進行字面上的分析。**
在 **250 字內**執行以下流程：
1. **秒懂結論**：一句話指出影片內容的「核心真實屬性」。
2. **正反擊點（VS）**：對比「影片內的主要主張」與你所知的相關背景知識與權威立場。
3. **警示燈號**：識別邏輯謬誤（如：標題與內容不符、去脈絡化、關鍵資訊隱瞞）。
4. **查證路徑**：提供一個可信的關鍵字或機構，引導使用者自行輸入搜尋引擎複查最新事實。

### 重要聲明
本分析基於 AI 訓練資料，**不包含即時聯網搜尋**。請務必透過「查證建議」的關鍵字向信任機構自行核實最新資訊。

### LINE 專屬格式規範（嚴格執行）
- **標題使用粗體**，並適度加入 Emoji。
- **字數控制**：總長度介於 150-200 字，禁止廢話。

### 輸出架構範例
📌 **核心摘要**：[一句話破題]

⚖️ **觀點對照**：
- 影片方：[內容中的核心主張]
- 查證方：[實證反論/證據]

⚠️ **風險診斷**：[偵測到的邏輯漏洞或標題誤導類型]

🔍 **查證建議**：請搜尋「[關鍵字]」或參考 [機構/資料來源] 核實最新資訊。
  `;

  // JSON payload
  const payload = {
    "contents": [{ "parts": [{ "text": userInput }] }],
    "systemInstruction": { "parts": [{ "text": systemInstruction }] },
    "generationConfig": {
      "temperature": 0.3,
      "maxOutputTokens": ENABLE_GROUNDING ? 2000 : 1024
    }
  };
  // 旗標為 true時，動態加入聯網檢索工具
  if (ENABLE_GROUNDING) {
    payload["tools"] = [{
      "google_search_retrieval": {
        "dynamic_retrieval_config": {
          "mode": "MODE_DYNAMIC",
          "dynamic_threshold": 0.8
        }
      }
    }];
  }

  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  // 定義備援模型清單 (針對 2026.04 最新 Free Tier 配額優化)
  const FALLBACK_MODELS = [
    'gemini-3.1-flash-lite-preview', // 新世代首選：速度極快且免費額度高
    'gemini-2.5-flash-lite',         // 2.5 系列穩定版首選
    'gemini-2.5-flash',              // 2.5 系列功能較強的備援
    'gemini-1.5-flash-8b',           // 最終保底：雖然是舊世代，但 RPM 限制最鬆
    'gemini-flash-lite-latest'       // 動態節點保險
  ];

  let lastErrorDetail = "📌 **所有模型均無法連線**";

  // 遍歷所有備用模型
  for (const model of FALLBACK_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      const responseText = response.getContentText();
      
      let json;
      try {
        json = JSON.parse(responseText);
      } catch (parseErr) {
        lastErrorDetail = `📌 [${model}] 回應解析失敗 (Code: ${code})`;
        continue; // 若有問題則直接測試下一個模型
      }

      // 如果成功分析
      if (code === 200 && json.candidates && json.candidates[0].content && json.candidates[0].content.parts[0].text) {
        let finalReply = json.candidates[0].content.parts[0].text;
        finalReply += `\n\n🤖 (Powered by ${model})`;
        return finalReply;
      } else {
        // 如果遇到 503 高負載或 429 請求限制，紀錄後繼續跳下一個
        if (code === 503 || code === 429) {
          console.log(`[${model}] 負載過高 (${code})，冷卻 4 秒後切換下一順位...`);
          lastErrorDetail = `📌 [${model}] 目前高負載 (${code})`;
          Utilities.sleep(4000); // 停頓 4 秒，避免瞬間連續請求觸發 429 頻率限制
          continue; 
        } else {
          // 若是其它語法或欄位錯誤，不需換模型，直接回傳錯誤
          console.error(`Gemini API Error [${model}]:`, responseText);
          let errDetail = `📌 **分析失敗 [${model}]** (Code: ${code})`;
          if (json.error) errDetail += "\n原因: " + json.error.message;
          return errDetail;
        }
      }
    } catch (err) {
      console.error(`Fetch Error [${model}]:`, err);
      lastErrorDetail = `📌 [${model}] 連線錯誤`;
      continue;
    }
  }

  // 如果所有模型都走完都失敗 (通常是 503 巔峰)，回傳最後的錯誤原因
  return lastErrorDetail + "\n請稍後再試，或聯絡開發人員。";
}

/**
 * 回覆訊息給 LINE
 */
function replyToLine(replyToken, text) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = {
    "replyToken": replyToken,
    "messages": [{ "type": "text", "text": text }]
  };

  const options = {
    "method": "post",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + LINE_ACCESS_TOKEN
    },
    "payload": JSON.stringify(payload)
  };

  UrlFetchApp.fetch(url, options);
}
