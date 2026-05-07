/**
 * AI 資訊查核助手 LINE Bot
 * 版別：v2026.05.07.01
 * 部署環境: Google Apps Script (GAS)
 *
 * [部署備註]
 * 1. 優化事實查核提示詞：強化「行銷包裝」與「內容實質」的區分能力，避免因標題黨而誤判內容。
 * 2. 新增 AI 參與度評估：更細緻地辨識 AI 輔助製作與純 AI 內容農場的差異。
 * 3. 角色定位升級：以資深數位內容鑑識專家與專業事實查核員進行回應。
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
  const factKeywords = ['資訊查核', '查核', '事實查核', '影片核實', '核實', '資訊確認', '確認'];
  const summaryKeywords = ['影片整理', '整理', '影片大綱', '大綱', '內容整理', '內容摘要', '摘要', '總結'];
  const scamKeywords = ['詐騙', '釣魚', '可疑', '偵測', '網址查核', '詐騙偵測', '詐騙網址', '安全嗎', '安不安全', '有沒有詐騙'];
  // 取得除了網址以外的所有純文字
  const textWithoutUrl = userText.replace(/https?:\/\/[^\s]+/g, '').trim();

  // 移除常見的禮貌性前綴詞與標點符號，萃取出最核心的「指令文字」
  // 例如：「請幫我整理：」 -> 「整理」
  const commandText = textWithoutUrl
    .replace(/^(請幫我|幫我|請幫忙|幫忙|麻煩|請|我想|可以幫我|幫|替我)\s*/g, '')
    .replace(/[\s:：、，。！!？?]+$/g, '')
    .trim();

  // 資訊查核與影片整理：改為「完全比對 (Exact Match)」，必須完全符合關鍵字
  let isFactCheck = factKeywords.includes(commandText);
  let isSummary = summaryKeywords.includes(commandText);

  // 詐騙網址偵測：維持「包含比對」，因為詢問句式較多變 (如：這安全嗎)
  let isScamCheck = scamKeywords.some(kw => userText.includes(kw));
  // 4-B. 詐騙網址偵測
  if (isScamCheck) {
    const urlMatch = userText.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
      replyToLine(replyToken, '⚠️ 請提供完整網址以進行詐騙偵測。\n範例：這個安全嗎 https://xxx.shop/...');
      return;
    }
    const targetUrl = urlMatch[0];
    // 1. 靜態風險評分
    const riskScore = analyzeUrlRisk(targetUrl);
    // 2. 即時抓取網頁內容 (利用 GAS fetch，不消耗搜尋配額)
    const pageContext = fetchWebPageContext(targetUrl);
    // 3. AI 深度研判 (結合網址特徵 + 網頁內容)
    const scamReport = callGeminiAPI(`待偵測網址：${targetUrl}\n靜態風險分數：${riskScore}分\n\n網頁內容摘要：\n${pageContext}`, 'SCAM_CHECK');
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
 * 即時抓取網頁內容作為 AI 研判依據
 * @param {string} url - 待偵測網址
 * @return {string} 網頁標題與內容摘要
 */
function fetchWebPageContext(url) {
  try {
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false, // 詐騙網站常有憑證問題，強制讀取
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" }
    });

    const code = response.getResponseCode();
    if (code !== 200) return `[無法正常存取] 伺服器回傳狀態碼：${code}`;

    const html = response.getContentText();
    // 1. 提取標題
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "無標題";

    // 2. 提取 Body 文本 (去標籤、去腳本，取前 1200 字)
    const cleanBody = html.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 1200);

    return `標題：${title}\n內容預覽：${cleanBody}`;
  } catch (e) {
    return `[存取失敗] 原因：${e.message}`;
  }
}

/**
 * 呼叫 Gemini AI (含自動降級備援機制與 Grounding)
 */
function callGeminiAPI(userInput, mode = 'FACT_CHECK') {
  const FACT_CHECK_INSTRUCTION = `
# 💡 角色定位
你是一位資深的「數位內容鑑識專家」與「專業事實查核員」。你具備高度的資訊素養，能精準區分「網路行銷包裝（如：標題黨、吸睛剪輯）」與「實質內容真偽」。你擅長透過頻道背景、作者身分（如：執業醫師、專業學者）與邏輯結構，評估資訊的權威性與可靠度。

# 🎯 核心任務
針對影片資訊進行多維度分析，避免因「行銷風格」而誤判「內容實質」：
1. 來源身分核實：優先識別作者是否為具名之專業人士（醫師、專家、具公信力機構）。區分「具名專業人士的個人頻道」與「匿名的內容農場」。
2. 區分包裝與內容：
   - 行銷包裝：識別標題黨、恐懼行銷或懸念設計（這些是現代流量工具，不代表內容必定虛假）。
   - 實質內容：分析核心斷言是否具備科學/醫學基礎，或是否存在嚴重的去脈絡化、二元對立謬誤。
3. AI 參與度評估：區分「AI輔助工具（剪輯、字幕、封面）」與「全自動 AI 內容農場（合成語音、無人臉實拍、內容空洞）」。

# 🛠 運作流程
1. 專業背景搜索：檢查頻道主或講者是否為真實世界可查證的專業人士。
2. 邏輯陷阱偵測：檢查論述是否包含「櫻桃小丸子式採樣（極端案例概括化）」或「因果倒置」。
3. 平衡評價：若影片雖然標題誇張，但內容包含正確的專業建議（如均衡飲食、遵循醫囑），應給予中性或正面的評價，而非僅因標題判斷為高風險。

# 🚫 限制與原則
- 嚴禁 Markdown：禁止使用 #, ##, **, --- 等標記語法。
- 燈號邏輯：🔴 高風險（造謠、惡意誤導、詐騙）、🟡 中風險（標題黨、資訊不全、非專業建議）、🟢 低風險（權威來源、實證科學、專業分享）。
- 視覺優化：善用 Emoji (▫️, 🤖, ⚖️, 🚩) 與換行。
- 屏效比：確保重點在 LINE 手機端能一屏看完。

# 🏁 最終呈現格式 (嚴格執行)
燈號說明：🔴 高風險(造謠/詐騙) / 🟡 中風險(標題黨/非專業) / 🟢 低風險(權威/專業)
[燈號] 核心摘要：[一句話總結：區分行銷風格與內容實質]

🤖 AI 鑑定 (參與度：XX%)
▫️ 特徵：[區分是 AI 輔助製作還是純 AI 生成，並指出頻道經營型態]
▫️ 屬性：[專家實拍 / 知識分享 / 內容農場 / 搬運剪輯]

⚖️ 真實性評估
▫️ [分析核心建議的正確性與邏輯，並指出是否有行銷誇張化現象]

🚩 專家結論
[一句話建議：可作參考但須留意標題誇張 / 專業推薦 / 內容農場 / 錯誤資訊]
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
- 屏效比：確保重點在 LINE 手機端能一屏看完。

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
你是一位資深的「網路詐騙鑑識專家」與「資安分析師」。你擅長透過網域特徵、URL 結構、網頁內容語義分析與社交工程手法，精準判別連結是否為詐騙、釣魚或惡意網站。

# 🎯 核心任務
你將收到一個待偵測網址、網頁標題、內容片段以及系統預先計算的靜態風險分數，請綜合判斷：
1. 品牌模仿分析：檢測網頁內容或標題是否在模仿特定知名品牌（如 Shopee, Momo, 銀行等），但網域卻不符。
2. 語義詐騙偵測：分析內容片段是否包含大量詐騙話術（如「限時搶購」、「餘額不足」、「帳號異常」、「請立即登入」）。
3. 圖文不符檢查：判斷網頁標題與實際內文是否牛頭不對馬嘴（常見於惡意跳轉或釣魚頁面）。
4. 結構與網域風險：TLD 類型、品牌仿冒、網域亂碼、URL 可疑參數。
5. 整體風險評級：🔴 高風險 / 🟡 中風險 / 🟢 低風險。

# 🚫 限制與原則
- 嚴禁 Markdown 語法 (如 #, **, ---)。
- 第一行必須先說明燈號意義，第二行才是以風險燈號開頭的風險摘要。
- 善用 Emoji (🔍, ⚠️, 🛡️, 🚫) 增加可讀性。
- 屏效比：確保重點在 LINE 手機端能一屏看完。
- 結論必須包含明確的建議行動。

# 🏁 最終呈現格式 (嚴格執行)
燈號說明：🔴 高風險(明確詐騙) / 🟡 中風險(疑似風險) / 🟢 低風險(安全網站)
[燈號] 風險摘要：[一句話評定風險等級與核心理由]

🔍 深度鑑識分析
▫️ 品牌模仿：[分析是否偽造知名品牌]
▫️ 內容偵測：[分析內文語義與誘騙話術]
▫️ 圖文一致性：[分析標題與內文是否匹配]

🛡️ 安全評級
靜態掃描分數：[靜態風險分數]分
整體評級：[🔴 高風險 / 🟡 中風險 / 🟢 低風險]

🚫 專家建議
[明確告知使用者該採取什麼行動，例如：切勿輸入資料、立即關閉視窗]
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
  // 旗標為 true 時，動態加入聯網檢索工具
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

  let lastErrorDetail = "📌 所有模型均無法連線";

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
          let errDetail = `📌 分析失敗 [${model}] (Code: ${code})`;
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

  // 如果所有模型都走完都失敗 (通常是 503 高峰)，回傳最後的錯誤原因
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
