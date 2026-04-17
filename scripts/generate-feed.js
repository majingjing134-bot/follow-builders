#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator (AI & Notion Enhanced)
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------
const POD2TXT_BASE = 'https://pod2txt.vercel.app/api';
const X_API_BASE = 'https://api.x.com/2';
const RSS_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 336; 
const BLOG_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;
const MAX_ARTICLES_PER_BLOG = 3;

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- AI & Notion Functions (新增的核心发动机) ----------------------------------

async function summarizeWithDeepSeek(content, apiKey) {
  if (!apiKey) return "未配置 DeepSeek Key，跳过摘要";
  console.error("正在调用 DeepSeek 生成摘要...");
  const prompt = `你是一个专业的科技情报官。请对以下内容进行深度总结，提取核心观点。使用中文，保持专业：\n\n${content.slice(0, 4000)}`; // 截取前4000字防止超长
  
  try {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await res.json();
    return data.choices[0].message.content;
  } catch (e) {
    return "摘要生成失败: " + e.message;
  }
}

async function pushToNotion(title, summary, url, notionToken, databaseId) {
  if (!notionToken || !databaseId) return;
  console.error(`正在推送到 Notion: ${title}`);
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${notionToken}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28"
    },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        "标题": { title: [{ text: { content: title || "无标题" } }] },
        "链接": { url: url || "" },
        "日期": { date: { start: new Date().toISOString().split('T')[0] } }
      },
      children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: summary } }] } }]
    })
  });
  if (!res.ok) console.error("Notion 推送失败:", await res.text());
}

// -- State Management --------------------------------------------------------

async function loadState() {
  if (!existsSync(STATE_PATH)) return { seenTweets: {}, seenVideos: {}, seenArticles: {} };
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    if (!state.seenArticles) state.seenArticles = {};
    return state;
  } catch { return { seenTweets: {}, seenVideos: {}, seenArticles: {} }; }
}

async function saveState(state) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) { if (ts < cutoff) delete state.seenTweets[id]; }
  for (const [id, ts] of Object.entries(state.seenVideos)) { if (ts < cutoff) delete state.seenVideos[id]; }
  for (const [id, ts] of Object.entries(state.seenArticles || {})) { if (ts < cutoff) delete state.seenArticles[id]; }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- Parsers (保留原作者的解析逻辑) -------------------------------------------

function parseRssFeed(xml) {
  const episodes = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];
    const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
    const guidMatch = block.match(/<guid[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/guid>/) || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const guid = guidMatch ? guidMatch[1].trim() : null;
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const publishedAt = pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString() : null;
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : null;
    if (guid) episodes.push({ title, guid, publishedAt, link });
  }
  return episodes;
}

async function fetchPod2txtTranscript(rssUrl, guid, apiKey) {
  const maxAttempts = 3; // 缩短尝试次数加快速度
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${POD2TXT_BASE}/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedurl: rssUrl, guid, apikey: apiKey })
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.status === 'ready' && data.url) {
      const txtRes = await fetch(data.url);
      return { transcript: await txtRes.text() };
    }
    if (data.status === 'processing' && attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 10000));
      continue;
    }
    return { error: data.status };
  }
  return { error: 'timeout' };
}

async function fetchPodcastContent(podcasts, apiKey, state, errors) {
  const results = [];
  for (const podcast of podcasts) {
    try {
      const rssRes = await fetch(podcast.rssUrl, { headers: { 'User-Agent': RSS_USER_AGENT } });
      const episodes = parseRssFeed(await rssRes.text());
      const selected = episodes.find(e => !state.seenVideos[e.guid]);
      if (selected) {
        const res = await fetchPod2txtTranscript(podcast.rssUrl, selected.guid, apiKey);
        state.seenVideos[selected.guid] = Date.now();
        if (res.transcript) {
          results.push({ source: 'podcast', title: selected.title, url: selected.link, transcript: res.transcript });
        }
      }
    } catch (e) { errors.push(e.message); }
  }
  return results;
}

// -- Main 执行逻辑 (全新的发动机) ----------------------------------------------

async function main() {
  console.error("🚀 开始运行 Follow Builders 脚本...");
  const state = await loadState();
  const sources = await loadSources();
  const errors = [];

  const podApiKey = process.env.POD2TXT_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const notionToken = process.env.NOTION_TOKEN;
  const notionDbId = process.env.NOTION_DATABASE_ID;

  // 1. 抓取内容 (目前先跑通播客，你可以后续开启推特/博客)
  let allItems = [];
  if (podApiKey) {
    console.error("正在检查新播客...");
    const pods = await fetchPodcastContent(sources.podcasts, podApiKey, state, errors);
    allItems = [...allItems, ...pods];
  }

  // 2. 循环处理每一条抓到的内容
  for (const item of allItems) {
    try {
      const summary = await summarizeWithDeepSeek(item.transcript || item.title, deepseekKey);
      await pushToNotion(item.title, summary, item.url, notionToken, notionDbId);
      console.error(`✅ 处理完成: ${item.title}`);
    } catch (e) {
      console.error(`❌ 处理失败: ${item.title}`, e.message);
    }
  }

  await saveState(state);
  console.error("🏁 运行结束。");
}

main().catch(err => {
  console.error("致命错误:", err);
  process.exit(1);
});
