require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const USER_ID    = process.env.LINE_DESTINATION_USER_ID;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const IS_TEST    = process.argv.includes("--test");

const genAI = new GoogleGenerativeAI(GEMINI_KEY);
let fetch;

// ── 1. PubMed ─────────────────────────────────────────────────────────────────
async function fetchPubMed(topic, query, maxResults = 2) {
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  try {
    const searchRes = await fetch(
      `${base}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&sort=pub+date&retmode=json`
    );
    const searchData = await searchRes.json();
    const ids = searchData.esearchresult?.idlist || [];
    if (ids.length === 0) return [];

    const fetchRes = await fetch(
      `${base}/efetch.fcgi?db=pubmed&id=${ids.join(",")}&rettype=abstract&retmode=xml`
    );
    const xml = await fetchRes.text();

    const papers = [];
    for (const match of xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)) {
      const block  = match[1];
      const titleM = block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
      const absM   = block.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
      const pmidM  = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
      if (titleM && absM) {
        const pmid = pmidM?.[1] || "";
        papers.push({
          topic,
          pmid,
          url:      pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
          title:    titleM[1].replace(/<[^>]+>/g, "").trim(),
          abstract: absM[1].replace(/<[^>]+>/g, "").trim().slice(0, 600),
        });
      }
    }
    return papers;
  } catch (e) {
    console.error(`  ⚠️ ${topic} 抓取失敗: ${e.message}`);
    return [];
  }
}

async function fetchAllPapers() {
  const topics = [
    { label: "腸道菌相", query: "gut microbiome health humans" },
    { label: "睡眠",     query: "sleep quality metabolism health" },
    { label: "微循環",   query: "microcirculation metabolic syndrome" },
    { label: "減重代謝", query: "weight loss metabolic rate adipose" },
  ];

  const papers = [];
  for (const t of topics) {
    const result = await fetchPubMed(t.label, t.query, 2);
    console.log(`  ${t.label}: ${result.length} 篇`);
    papers.push(...result);
    await new Promise(r => setTimeout(r, 400)); // PubMed rate limit
  }
  return papers;
}

// ── 2. Gemini summarize ───────────────────────────────────────────────────────
async function summarizePapers(papers) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const results = [];

  for (const p of papers) {
    try {
      const prompt = `你是一位健康顧問，專攻代謝症候群與 CNFCD® 飲食法。
用繁體中文，把這篇期刊摘要用 2-3 句白話說給一般人聽，不要學術語言，要有實用健康觀念：

標題：${p.title}
摘要：${p.abstract}

只輸出 2-3 句，不要標題不要前言。`;

      const res = await model.generateContent(prompt);
      results.push({ topic: p.topic, title: p.title, url: p.url, summary: res.response.text().trim() });
    } catch (e) {
      console.error(`  ⚠️ 摘要失敗 (${p.topic}): ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 13000)); // 5 RPM free tier
  }
  return results;
}

// ── 3. LINE flex message ──────────────────────────────────────────────────────
function buildFlexMessage(summaries) {
  const today = new Date().toLocaleDateString("zh-TW", {
    month: "long", day: "numeric", weekday: "short",
  });

  const topicEmoji = { "腸道菌相":"🦠", "睡眠":"💤", "微循環":"🩸", "減重代謝":"⚖️" };
  const topicColor = { "腸道菌相":"#4CAF50", "睡眠":"#5C6BC0", "微循環":"#EF5350", "減重代謝":"#FF9800" };

  const grouped = {};
  summaries.forEach(s => {
    if (!grouped[s.topic]) grouped[s.topic] = [];
    grouped[s.topic].push(s);
  });

  const bodyContents = [];
  Object.entries(grouped).forEach(([topic, items], idx) => {
    if (idx > 0) bodyContents.push({ type: "separator", margin: "md" });
    bodyContents.push({
      type: "text",
      text: `${topicEmoji[topic] || "📄"} ${topic}`,
      weight: "bold",
      size: "sm",
      color: topicColor[topic] || "#333333",
      margin: idx === 0 ? "none" : "md",
    });
    items.forEach(item => {
      bodyContents.push({
        type: "text",
        text: item.summary,
        wrap: true,
        size: "sm",
        color: "#444444",
        margin: "sm",
      });
      // source link
      if (item.url) {
        // LINE button label max 40 chars; leave room for "📄 " prefix (2 chars)
        const shortTitle = item.title.length > 36 ? item.title.slice(0, 35) + "…" : item.title;
        bodyContents.push({
          type: "button",
          action: { type: "uri", label: `📄 ${shortTitle}`, uri: item.url },
          style: "link",
          height: "sm",
          margin: "xs",
          color: "#94a3b8",
        });
      }
    });
  });

  // Build share text with actual summaries so forwarded message contains real content
  const shareLines = [`📚 ${today} 健康知識日報\n（李歐叔叔 AI 助理整理・期刊精選）\n`];
  Object.entries(grouped).forEach(([topic, items]) => {
    shareLines.push(`${topicEmoji[topic] || "📄"} ${topic}`);
    items.forEach(item => {
      shareLines.push(item.summary);
      if (item.url) shareLines.push(`🔗 ${item.url}`);
    });
    shareLines.push("");
  });
  // LINE URI action limit is 1000 chars; base URL is 33 chars, leave rest for encoded text
  const BASE_URL = "https://line.me/R/share?text=";
  let shareText = shareLines.join("\n");
  while (BASE_URL.length + encodeURIComponent(shareText).length > 999) {
    shareText = shareText.slice(0, shareText.length - 10);
  }

  return {
    type: "flex",
    altText: `📚 ${today} 健康知識日報`,
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#2b7a4b",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "📚 健康知識日報", color: "#FFFFFF", weight: "bold", size: "lg" },
          { type: "text", text: `${today}・期刊精選`, color: "#AADDBB", size: "xs", margin: "sm" },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        spacing: "sm",
        contents: bodyContents.length > 0 ? bodyContents : [
          { type: "text", text: "今日暫無新資料，明天再看！", color: "#888888", size: "sm" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#f5f7fa",
        paddingAll: "12px",
        spacing: "sm",
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "📤 轉傳給朋友",
              uri: `https://line.me/R/share?text=${encodeURIComponent(shareText)}`,
            },
            style: "primary",
            color: "#2b7a4b",
            height: "sm",
          },
          {
            type: "text",
            text: "由李歐叔叔 AI 助理整理・僅供知識參考",
            color: "#94a3b8", size: "xxs", align: "center",
            margin: "sm",
          },
        ],
      },
    },
  };
}

// ── 4. Push LINE ──────────────────────────────────────────────────────────────
async function pushToLine(message) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({ to: USER_ID, messages: [message] }),
  });
  const data = await res.json();
  if (res.ok) {
    console.log("✅ LINE 推播成功");
  } else {
    console.error("❌ LINE 推播失敗:", JSON.stringify(data));
  }
  return res.ok;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  ({ default: fetch } = await import("node-fetch"));
  console.log(`🚀 ${new Date().toLocaleString("zh-TW")} 開始生成健康知識日報...`);

  console.log("📥 抓取 PubMed 論文...");
  const papers = await fetchAllPapers();
  console.log(`  共 ${papers.length} 篇`);

  if (papers.length === 0) {
    console.log("⚠️ 無論文資料，結束");
    return;
  }

  console.log("🤖 Gemini 生成中文摘要...");
  const summaries = await summarizePapers(papers);
  console.log(`  生成 ${summaries.length} 則`);

  const flexMsg = buildFlexMessage(summaries);

  if (IS_TEST) {
    console.log("\n📋 TEST MODE - 訊息預覽：\n");
    summaries.forEach(s => console.log(`[${s.topic}] ${s.summary}\n`));
    return;
  }

  console.log("📲 推播到 LINE...");
  await pushToLine(flexMsg);
  console.log("🎉 完成！");
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
