require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const USER_ID     = process.env.LINE_DESTINATION_USER_ID;
const GROUP_ID    = process.env.LINE_GROUP_ID;
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const GH_TOKEN    = process.env.GITHUB_TOKEN;
const GH_REPO     = "leouncle-health/leo-daily-digest";
const PAGES_URL   = "https://leouncle-health.github.io/leo-daily-digest/";
const IS_TEST     = process.argv.includes("--test");

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
    await new Promise(r => setTimeout(r, 400));
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
    await new Promise(r => setTimeout(r, 13000));
  }
  return results;
}

// ── 3. Build HTML page ────────────────────────────────────────────────────────
function buildHtmlPage(summaries) {
  const today = new Date().toLocaleDateString("zh-TW", {
    year: "numeric", month: "long", day: "numeric", weekday: "long",
  });

  const topicEmoji = { "腸道菌相":"🦠", "睡眠":"💤", "微循環":"🩸", "減重代謝":"⚖️" };
  const topicColor = { "腸道菌相":"#4CAF50", "睡眠":"#5C6BC0", "微循環":"#EF5350", "減重代謝":"#FF9800" };

  const grouped = {};
  summaries.forEach(s => {
    if (!grouped[s.topic]) grouped[s.topic] = [];
    grouped[s.topic].push(s);
  });

  const sections = Object.entries(grouped).map(([topic, items]) => {
    const color = topicColor[topic] || "#333";
    const emoji = topicEmoji[topic] || "📄";
    const cards = items.map(item => `
      <div class="card">
        <p class="summary">${item.summary}</p>
        ${item.url ? `<a class="source-link" href="${item.url}" target="_blank" rel="noopener">📄 查看原文：${item.title.length > 60 ? item.title.slice(0, 59) + "…" : item.title}</a>` : ""}
      </div>`).join("");

    return `
    <section class="topic-section">
      <h2 style="color:${color}">${emoji} ${topic}</h2>
      ${cards}
    </section>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>📚 健康知識日報・${today}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; background: #f5f7fa; color: #333; }
  header { background: #2b7a4b; color: #fff; padding: 20px 16px 16px; }
  header h1 { font-size: 1.2rem; font-weight: 700; }
  header p  { font-size: 0.8rem; color: #aaddbb; margin-top: 4px; }
  main { max-width: 680px; margin: 0 auto; padding: 16px; }
  .topic-section { margin-bottom: 24px; }
  .topic-section h2 { font-size: 1rem; font-weight: 700; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 2px solid currentColor; }
  .card { background: #fff; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .summary { font-size: 0.93rem; line-height: 1.7; color: #444; }
  .source-link { display: block; margin-top: 10px; font-size: 0.78rem; color: #2b7a4b; text-decoration: none; word-break: break-all; }
  .source-link:hover { text-decoration: underline; }
  footer { text-align: center; padding: 24px 16px; font-size: 0.75rem; color: #999; }
</style>
</head>
<body>
<header>
  <h1>📚 健康知識日報</h1>
  <p>${today}・期刊精選・由李歐叔叔 AI 助理整理</p>
</header>
<main>
  ${sections || '<p style="color:#888;padding:20px 0">今日暫無新資料，明天再看！</p>'}
</main>
<footer>僅供健康知識參考，不構成醫療建議</footer>
</body>
</html>`;
}

// ── 4. Publish HTML to GitHub ─────────────────────────────────────────────────
async function publishHtmlToGitHub(html) {
  if (!GH_TOKEN) {
    console.log("  ℹ️ 無 GITHUB_TOKEN，跳過 HTML 發布");
    return;
  }

  const apiUrl = `https://api.github.com/repos/${GH_REPO}/contents/index.html`;
  const headers = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  // Get current file SHA (needed for update)
  let sha;
  try {
    const getRes = await fetch(apiUrl, { headers });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }
  } catch (_) {}

  const body = {
    message: `chore: 更新健康知識日報 ${new Date().toLocaleDateString("zh-TW")}`,
    content: Buffer.from(html).toString("base64"),
    ...(sha ? { sha } : {}),
  };

  const putRes = await fetch(apiUrl, { method: "PUT", headers, body: JSON.stringify(body) });
  if (putRes.ok) {
    console.log(`  ✅ HTML 已發布 → ${PAGES_URL}`);
  } else {
    const err = await putRes.json();
    console.error("  ❌ HTML 發布失敗:", JSON.stringify(err));
  }
}

// ── 5. LINE flex message ──────────────────────────────────────────────────────
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
      if (item.url) {
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
              label: "🌐 完整日報（可分享）",
              uri: PAGES_URL,
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

// ── 6. Push LINE ──────────────────────────────────────────────────────────────
async function pushToOne(to, message) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [message] }),
  });
  const data = await res.json();
  if (!res.ok) console.error(`  ❌ 推播失敗 (${to.slice(0,8)}…): ${JSON.stringify(data)}`);
  return res.ok;
}

async function pushToLine(message) {
  const targets = [USER_ID, GROUP_ID].filter(Boolean);
  const results = await Promise.all(targets.map(id => pushToOne(id, message)));
  const ok = results.filter(Boolean).length;
  console.log(`✅ LINE 推播成功 (${ok}/${targets.length} 個收件人)`);
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

  console.log("🌐 發布 HTML 日報...");
  const html = buildHtmlPage(summaries);
  await publishHtmlToGitHub(html);

  const flexMsg = buildFlexMessage(summaries);

  if (IS_TEST) {
    console.log("\n📋 TEST MODE - 訊息預覽：\n");
    summaries.forEach(s => console.log(`[${s.topic}] ${s.summary}\n`));
    console.log(`分享網址：${PAGES_URL}`);
    return;
  }

  console.log("📲 推播到 LINE...");
  await pushToLine(flexMsg);
  console.log("🎉 完成！");
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
