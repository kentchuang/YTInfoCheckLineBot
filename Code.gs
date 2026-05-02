/**
 * AI 資訊查核助手 LINE Bot
 * 版別：v2026.05.02.04
 * 部署環境: Google Apps Script (GAS)
 *
 * [部署備註]
 * 1. 新增「詐騙網址偵測」功能：靜態風險評分 + Gemini AI 深度研判。
 * 2. 新增 AI 意圖識別機制：以 Gemini 判別使用者意圖，取代單純前綴比對。
 * 3. 整合三模式運作：資訊查核、影片整理、詐騙網址偵測。
 * 4. 全面採用 Gemini 3.1/3 系列模型並優化備援。
 * 5. 統一 LINE 回覆介面，嚴禁 Markdown 確保行動端閱讀體驗。
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
  const userText = event.message.text.trim();
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

  // 2. 指令查詢
  if (userText === '指令查詢' || userText === '幫助' || userText === '/help') {
    const helpMsg = `🤖 AI 資訊查核助手 指令表：

▫️ 資訊查核 [YouTube連結]
   關鍵字：查核、核實、確認

▫️ 影片整理 [YouTube連結]
   關鍵字：大綱、摘要、整理

🔍 詐騙網址偵測 [任意連結]
   關鍵字：詐騙、釣魚、可疑、偵測、網址查核

📋 指令查詢 / 幫助 / /help

💡 範例：
影片大綱 https://youtu.be/...
這個網址有詐騙嗎 https://xxx.shop/...`;
    replyToLine(replyToken, helpMsg);
    return;
  }

  // 3. 群組白名單鎖定 (支援多個群組，請將群組 ID 存於 GAS 指令碼屬性 ALLOWED_GROUP_IDS，以逗號分隔)
  const rawAllowedIds = PropertiesService.getScriptProperties().getProperty('ALLOWED_GROUP_IDS') || "";
  const ALLOWED_GROUP_IDS = rawAllowedIds ? rawAllowedIds.split(',').map(id => id.trim()) : [];

  if (ALLOWED_GROUP_IDS.length > 0) {
    if (event.source.type !== 'group' || !ALLOWED_GROUP_IDS.includes(event.source.groupId)) {
      if (event.source.type === 'user') {
        replyToLine(replyToken, "⛔ 抱歉，這是一個私人專用的事實查核機器人，僅限於特定的家用群組內提供服務，恕不開放一對一私訊功能喔！\n\n💡 若需使用，請洽管理員取得「群組代號」，經設定後才可使用。");
      }
      return;
    }
  }

  // 4. 關鍵字觸發：先做靜態比對，再用 AI 意圖識別作為補強
  const factKeywords    = ['資訊查核', '查核', '事實查核', '影片核實', '核實', '資訊確認', '確認'];
  const summaryKeywords = ['影片整理', '整理', '影片大綱', '大綱', '內容整理', '內容摘要', '摘要', '總結'];
  const scamKeywords    = ['詐騙', '釣魚', '可疑', '偵測', '網址查核', '詐騙偵測', '詐騙網址', '安全嗎', '安不安全', '有沒有詐騙'];

  let isFactCheck = factKeywords.some(kw => userText.startsWith(kw));
  let isSummary   = summaryKeywords.some(kw => userText.startsWith(kw));
  let isScamCheck = scamKeywords.some(kw => userText.includes(kw));

  // 4-A. 若靜態比對未命中，但訊息含有連結且包含「描述文字」，則呼叫 AI 意圖識別
  // 避免使用者只丟網址就觸發（必須有關鍵字或指令描述）
  const hasAnyUrl = /https?:\/\/[^\s]+/.test(userText);
  const textWithoutUrl = userText.replace(/https?:\/\/[^\s]+/g, '').trim();
  const hasDescription = textWithoutUrl.length > 0;

  if (!isFactCheck && !isSummary && !isScamCheck && hasAnyUrl && hasDescription) {
    const intent = detectIntentWithAI(userText);
    if (intent === 'FACT_CHECK')  isFactCheck = true;
    if (intent === 'SUMMARY')     isSummary   = true;
    if (intent === 'SCAM_CHECK')  isScamCheck = true;
  }

  // 4-B. 詐騙網址偵測
  if (isScamCheck) {
    const urlMatch = userText.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
      replyToLine(replyToken, '⚠️ 請提供完整網址以進行詐騙偵測。\n範例：這個安全嗎 https://xxx.shop/...');
      return;
    }
    const targetUrl = urlMatch[0];
    // 靜態風險評分
    const riskScore = analyzeUrlRisk(targetUrl);
    // AI 深度研判
    const scamReport = callGeminiAPI(`待偵測網址：${targetUrl}\n靜態風險分數：${riskScore}分 (70分以上為高風險)`, 'SCAM_CHECK');
    if (scamReport) replyToLine(replyToken, scamReport);
    return;
  }

  // 4-C. 資訊查核 或 影片整理
  if (isFactCheck || isSummary) {
    if (!isYoutubeUrl(userText)) {
      const modeName = isFactCheck ? '資訊查核' : '影片整理';
      replyToLine(replyToken, `⚠️ 請提供有效的 YouTube 連結。例如：\n${modeName} https://youtu.be/...`);
      return;
    }

    // 抓取 YouTube 影片資訊 (oEmbed)
    let videoContext = userText;
    try {
      const ytRegex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+)/;
      const match = userText.match(ytRegex);
      if (match) {
        const videoUrl = match[1];
        const oembedUrl = 'https://www.youtube.com/oembed?url=' + encodeURIComponent(videoUrl) + '&format=json';
        const oembedRes = UrlFetchApp.fetch(oembedUrl, { muteHttpExceptions: true });
        if (oembedRes.getResponseCode() === 200) {
          const oembedData = JSON.parse(oembedRes.getContentText());
          videoContext = `
# 📥 影片基礎資訊
- 標題：${oembedData.title}
- 頻道：${oembedData.author_name}
- 網址：${videoUrl}
- 請求模式：${isFactCheck ? '事實查核' : '內容整理'}
`;
        }
      }
    } catch (err) {
      console.error('Oembed 抓取失敗:', err);
    }

    const analysisReport = callGeminiAPI(videoContext, isFactCheck ? 'FACT_CHECK' : 'SUMMARY');
    if (analysisReport) replyToLine(replyToken, analysisReport);
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
 * 以 Gemini AI 判別使用者意圖 (靜態比對未命中時的輔助識別)
 * @param {string} userText - 使用者訊息
 * @return {string} 'FACT_CHECK' | 'SUMMARY' | 'SCAM_CHECK' | 'NONE'
 */
function detectIntentWithAI(userText) {
  const prompt = `你是一個意圖分類器，請判斷以下使用者訊息屬於哪一種操作意圖，只需回覆對應的英文代碼，不要有其他文字：

可用代碼：
- FACT_CHECK：使用者想查核 YouTube 影片的真實性、是否為 AI 生成或內容農場。
- SUMMARY：使用者想取得 YouTube 影片的摘要、大綱或重點整理。
- SCAM_CHECK：使用者想確認某個網址是否為詐騙、釣魚或惡意連結。
- NONE：以上皆非。

使用者訊息：${userText}

請僅回覆代碼（FACT_CHECK / SUMMARY / SCAM_CHECK / NONE）：`;

  try {
    const payload = {
      'contents': [{ 'parts': [{ 'text': prompt }] }],
      'generationConfig': { 'temperature': 0, 'maxOutputTokens': 20 }
    };
    const options = {
      'method': 'post',
      'contentType': 'application/json',
      'payload': JSON.stringify(payload),
      'muteHttpExceptions': true
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${GEMINI_API_KEY}`;
    const res = UrlFetchApp.fetch(url, options);
    if (res.getResponseCode() === 200) {
      const json = JSON.parse(res.getContentText());
      const intent = (json.candidates?.[0]?.content?.parts?.[0]?.text || 'NONE').trim().toUpperCase();
      console.log(`[AI 意圖識別] 判別結果：${intent}`);
      return ['FACT_CHECK', 'SUMMARY', 'SCAM_CHECK'].includes(intent) ? intent : 'NONE';
    }
  } catch (err) {
    console.error('AI 意圖識別失敗:', err);
  }
  return 'NONE';
}

/**
 * 詐騙網址靜態風險評分
 * @param {string} url - 待檢測網址
 * @return {number} riskScore - 風險點數 (70 分以上為高風險)
 */
function analyzeUrlRisk(url) {
  let riskScore = 0;
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const searchParams = urlObj.search.toLowerCase();

    // 1. 高風險 TLD (+40)
    const riskyTlds = ['.shop', '.top', '.xyz', '.vip', '.site', '.cc', '.fun', '.online', '.buzz', '.click', '.link'];
    if (riskyTlds.some(tld => hostname.endsWith(tld))) riskScore += 40;

    // 2. 詐騙系統常用 URL 參數 (2 個以上 +50)
    const scamParams = ['m=order', 'tpl=detail', 'id=', 'lang=zh-tw', 'utm_source=line'];
    const matchCount = scamParams.filter(p => searchParams.includes(p)).length;
    if (matchCount >= 2) riskScore += 50;

    // 3. 亂碼網域判斷 (+30)
    const domainParts = hostname.split('.');
    const domainMain = domainParts.length >= 2 ? domainParts[domainParts.length - 2] : '';
    if (domainMain.length > 8) {
      const digitCount = (domainMain.match(/\d/g) || []).length;
      if (digitCount > 2 || !/[aeiouy]/i.test(domainMain)) riskScore += 30;
    }

    // 4. 山寨知名品牌比對 (+60)
    const fakeBrands = ['shopeee', 'shopee-', 'tw-momo', 'm0m0', 'momoo', 'pchoome', 'p-chome', 'yahoo-', 'line-', '7-11-'];
    if (fakeBrands.some(fb => hostname.includes(fb))) riskScore += 60;

  } catch (e) {
    console.log('URL 解析錯誤: ' + url);
  }
  return riskScore;
}

/**
 * 呼叫 Gemini AI (含自動降級備援機制與 Grounding)
 */
function callGeminiAPI(userInput, mode = 'FACT_CHECK') {
  const FACT_CHECK_INSTRUCTION = `
# 💡 角色定位
你是一位資深的「數位內容鑑識專家」與「事實查核調查員」。你擅長透過語言邏輯與頻道特徵，精準判別 YouTube 內容是否由 AI 生成（GenAI）或屬於內容農場，並結合事實查核邏輯評估資訊真實性。

# 🎯 核心任務
針對使用者提供的影片資訊進行多維度分析：
1. 宣稱 (Claim) 識別：精確提取影片中的核心事實斷言，區分事實與觀點。
2. AI 生成判定：識別標題黨、批量化命名與 AI 腳本痕跡。
3. 事實性評估：依據來源品質層級（政府/學術 > 權威媒體 > 一般報導 > 社群傳聞）與邏輯謬誤（如：去脈絡化、假等價）給出評價。

# 🛠 運作流程
1. 防呆檢查：資訊不足或無法解析時回覆：'⚠️ 無法讀取影片資訊，請確認網址是否正確。'。
2. 邏輯掃描：檢驗論據是否包含「櫻桃小丸子式採樣」或「統計誤導」。
3. 簡化封裝：將複雜分析轉化為行動裝置友善的燈號與短句。

# 🚫 限制與原則
- 嚴禁 Markdown：禁止使用 #, ##, **, --- 等標記語法。
- 第一行必須先說明燈號意義，第二行才是燈號開頭的核心摘要。
- 視覺優化：善用 Emoji (▫️, 🤖, ⚖️, 🚩) 與換行。
- 屏效比：確保重點在 LINE 手機端能一屏看完。


# 🏁 最終呈現格式 (嚴格執行)
燈號說明：🔴 高風險 / 🟡 中風險 / 🟢 低風險
[燈號] 核心摘要：[一句話總結真偽與 AI 程度]

🤖 AI 鑑定 (參與度：XX%)
▫️ 特徵：[分析標題/頻道命名/邏輯感]
▫️ 屬性：[原創實拍 / AI 農場 / 搬運剪輯]

⚖️ 真實性評估
▫️ [指出事實正確性或邏輯漏洞]

🚩 專家結論
[一句話建議：值得訂閱 / 娛樂參考 / 內容農場 / 謹慎查證]
  `;

  const SUMMARY_INSTRUCTION = `
# 💡 角色定位
你是一位專業的「影片內容筆記精靈」。你擅長將長篇影片轉化為結構化、易讀的精華筆記。

# 🎯 核心任務
1. 重點摘要：提取影片的核心價值與主要論點。
2. 結構化大綱：將內容分為 3-5 個主要章節或主題。
3. 金句/結論：總結影片最值得記住的一句話。

# 🚫 限制與原則
- 嚴禁 Markdown 語法 (如 #, **, ---)。
- 視覺優化：善用 Emoji (📝, 📌, 💡)。

# 🏁 最終呈現格式
📝 影片內容精華筆記

📌 核心大綱：
▫️ [大綱 1]
▫️ [大綱 2]
▫️ [大綱 3]

💡 適合誰看？
[分析受眾]

🚩 快速總結
[一句話精華]
  `;

  const SCAM_CHECK_INSTRUCTION = `
# 💡 角色定位
你是一位資深的「網路詐騙鑑識專家」與「資安分析師」。你擅長透過網域特徵、URL 結構與社交工程手法，精準判別連結是否為詐騙、釣魚或惡意網站。

# 🎯 核心任務
你將收到一個待偵測網址以及系統預先計算的靜態風險分數，請綜合判斷：
1. 網域風險：TLD 類型、品牌仿冒、網域亂碼程度。
2. 結構風險：URL 路徑是否有典型詐騙參數組合。
3. 社交工程特徵：是否模仿知名電商、物流、政府或金融機構。
4. 整體風險評級：🔴 高風險 / 🟡 中風險 / 🟢 低風險。

# 🚫 限制與原則
- 嚴禁 Markdown 語法 (如 #, **, ---)。
- 第一行必須先說明燈號意義，第二行才是以風險燈號開頭的風險摘要。
- 善用 Emoji (🔍, ⚠️, 🛡️, 🚫) 增加可讀性。
- 結論必須包含明確的建議行動。

# 🏁 最終呈現格式 (嚴格執行)
燈號說明：🔴 高風險 / 🟡 中風險 / 🟢 低風險
[燈號] 風險摘要：[一句話評定]

🔍 網域分析
▫️ TLD 類型：[評估]
▫️ 品牌仿冒：[有 / 無 / 疑似]
▫️ 網域特徵：[說明]

⚠️ URL 結構風險
▫️ [指出可疑的路徑或參數]

🛡️ 風險評級
靜態掃描分數：[靜態風險分數]分
整體評級：[🔴 高風險 / 🟡 中風險 / 🟢 低風險]

🚫 建議行動
[明確告知使用者該怎麼做]
  `;

  const systemInstruction = mode === 'SUMMARY' ? SUMMARY_INSTRUCTION
                          : mode === 'SCAM_CHECK' ? SCAM_CHECK_INSTRUCTION
                          : FACT_CHECK_INSTRUCTION;

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

  // 定義備援模型清單 (針對 2026.05 最新配額優化)
  const FALLBACK_MODELS = [
    'gemini-3.1-flash-lite-preview', // 首選：速度極快且配額高
    'gemini-3-flash-preview',        // 備選：3 系列平衡版
    'gemini-2.5-flash',              // 高性能備援
    'gemini-2.5-flash-lite',         // 穩定省錢備援
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
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      console.error('LINE Reply Error:', response.getContentText());
    }
  } catch (e) {
    console.error('LINE API Connection Error:', e.message);
  }
}
