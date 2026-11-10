// 背景页：保存进行中的订单，替 Steam 页面把结果回报给网站。
// 回报只含 appid / contextid / assetid / 状态 / 价格，绝不含 Steam cookie 或任何登入资料。
"use strict";
importScripts("i18n.js", "lib.js"); // globalThis.SCI18n、globalThis.SCLib

const STEAM = "https://steamcommunity.com";
const JOB_HOURS = 6; // 和网站的回报凭证有效期一样

// ---------- 自动更新 ----------
// Chrome 本来就会每几小时检查一次。客人打开我们网站或 Steam 时，最多每小时再请 Chrome 查一次；
// 有新版就马上套用，但正在上架或同步的订单（6 小时内）先不打断，按「完成」后再套用。
async function maybeCheckUpdate() {
  const { lastUpdateCheck = 0 } = await chrome.storage.local.get("lastUpdateCheck");
  if (Date.now() - lastUpdateCheck < 3600000) return;
  await chrome.storage.local.set({ lastUpdateCheck: Date.now() });
  try { await chrome.runtime.requestUpdateCheck(); } catch { /* 被 Chrome 限流就等下次 */ }
}
async function jobRunning() {
  const { job } = await chrome.storage.local.get("job");
  return !!(job && Date.now() - job.created < JOB_HOURS * 3600000);
}
chrome.runtime.onUpdateAvailable.addListener(async () => {
  if (await jobRunning()) await chrome.storage.local.set({ updatePending: true });
  else chrome.runtime.reload();
});
chrome.runtime.onStartup.addListener(() => { maybeCheckUpdate(); });
// 刚安装或更新后，已经开着的网站分页还没有新的插件脚本：重新整理一次，网站才侦测得到
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: "https://steam.2cstudio.app/*" });
    for (const t of tabs) if (t.id != null) chrome.tabs.reload(t.id);
  } catch { /* 没有开着的分页 */ }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg || {}, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

function originOf(sender) {
  if (sender.origin) return sender.origin;
  try { return new URL(sender.url).origin; } catch { return ""; }
}

async function handle(msg, sender) {
  if (sender.id !== chrome.runtime.id) return { ok: false, error: "bad sender" };
  const from = originOf(sender);
  maybeCheckUpdate();
  if (msg.type === "hello") return { ok: true };

  if (msg.type === "steamLogin") {
    if (!from || from === STEAM) return { ok: false, error: "bad sender" };
    return steamLoginState();
  }

  if (msg.type === "checkStatus") {
    if (!from || from === STEAM) return { ok: false, error: "bad sender" };
    return checkStatus(msg.plan || {}, from, msg.lang);
  }

  if (msg.type === "start") {
    // 只接受托管网站订单页发来的（manifest 只让 site.js 在网站上执行）
    if (!from || from === STEAM) return { ok: false, error: "bad sender" };
    const T = SCI18n.pick(msg.lang);
    const plan = msg.plan || {};
    let reportOrigin = "";
    try { reportOrigin = new URL(plan.report_url).origin; } catch { /* 下面会拒绝 */ }
    if (reportOrigin !== from) return { ok: false, error: T.badReportUrl };
    if (!/^[0-9a-f-]{36}$/i.test(plan.order_id || "") || !/^7656119\d{10}$/.test(plan.steamid || "") || !Array.isArray(plan.items)) {
      return { ok: false, error: T.badPlan };
    }
    const job = { mode: msg.mode === "sync" ? "sync" : "list", plan, site: from, created: Date.now(), lang: SCI18n.normalize(msg.lang) };
    await chrome.storage.local.set({ job, queue: [] });
    await chrome.tabs.create({ url: `${STEAM}/profiles/${plan.steamid}/inventory/` });
    return { ok: true };
  }

  // 以下只给 Steam 页面上的插件脚本用
  if (from !== STEAM) return { ok: false, error: "bad sender" };
  const { job } = await chrome.storage.local.get("job");
  const fresh = job && Date.now() - job.created < JOB_HOURS * 3600000 ? job : null;
  const T = SCI18n.pick(job && job.lang);

  if (msg.type === "getJob") return { ok: true, job: fresh };
  if (msg.type === "setMode") {
    if (!fresh) return { ok: false, error: T.noJob };
    fresh.mode = msg.mode === "sync" ? "sync" : "list";
    if (Array.isArray(msg.items)) fresh.plan.items = msg.items;
    await chrome.storage.local.set({ job: fresh });
    return { ok: true };
  }
  if (msg.type === "report") {
    if (!fresh) return { ok: false, error: T.jobExpired };
    return report(fresh, Array.isArray(msg.results) ? msg.results : []);
  }
  if (msg.type === "finish") {
    const { queue } = await chrome.storage.local.get("queue");
    if (fresh && queue && queue.length) await report(fresh, []);
    await chrome.storage.local.remove(["job", "queue"]);
    const { updatePending } = await chrome.storage.local.get("updatePending");
    if (updatePending) { await chrome.storage.local.remove("updatePending"); setTimeout(() => chrome.runtime.reload(), 500); }
    return { ok: true };
  }
  return { ok: false, error: "unknown message" };
}

// ---------- Steam 还有没有登入 ----------
// 打开 steamcommunity.com/my/：登入了会转到自己的个人资料，没登入会转到登入页。
// 只记住「有登入」10 分钟；「没登入」每次都重查（客人刚重新登入时不能还用旧答案）。
async function steamLoginState() {
  const { steamLogin } = await chrome.storage.local.get("steamLogin");
  if (steamLogin && steamLogin.signedIn && Date.now() - steamLogin.at < 600000) return { ok: true, signedIn: true };
  try {
    const r = await fetch(`${STEAM}/my/`, { credentials: "include" });
    const u = r.url || "";
    const signedIn = /\/login\b/.test(u) ? false : /\/(id|profiles)\//.test(u) ? true : null;
    if (signedIn === null) return { ok: false };
    await chrome.storage.local.set({ steamLogin: { signedIn, at: Date.now() } });
    return { ok: true, signedIn };
  } catch {
    return { ok: false };
  }
}

// ---------- 在背景查卖出状态（不开分页） ----------
// 用你自己浏览器里的 Steam 登入，读「我的挂单」和交易记录，把确认 / 卖出 / 撤下回报网站。
// 同一张订单 2 分钟内只查一次，免得 Steam 限流。
async function steamJson(url) {
  const r = await fetch(url, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.success === false) throw new Error(r.status === 429 ? "rate" : "steam");
  return j;
}

async function checkStatus(plan, from, lang) {
  let reportOrigin = "";
  try { reportOrigin = new URL(plan.report_url).origin; } catch { /* 下面拒绝 */ }
  if (reportOrigin !== from || !/^[0-9a-f-]{36}$/i.test(plan.order_id || "") || !/^7656119\d{10}$/.test(plan.steamid || "") || !Array.isArray(plan.items)) {
    return { ok: false, error: "bad plan" };
  }
  const listed = plan.items.filter((it) => it.status === "listed");
  if (!listed.length) return { ok: true, saved: 0 };
  const key = `checked:${plan.order_id}`;
  const { [key]: last = 0 } = await chrome.storage.local.get(key);
  if (Date.now() - last < 120000) return { ok: true, saved: 0, throttled: true };
  await chrome.storage.local.set({ [key]: Date.now() });
  try {
    const listingPages = [];
    for (let start = 0, total = Infinity; start < total && listingPages.length < 10; start += 100) {
      const p = await steamJson(`${STEAM}/market/mylistings?start=${start}&count=100&norender=1`);
      listingPages.push(p); total = Number(p.total_count || 0);
    }
    const since = plan.listing_started_at ? new Date(plan.listing_started_at).getTime() / 1000 - 86400 : 0;
    const historyPages = [];
    for (let start = 0, total = Infinity; start < total && historyPages.length < 20; start += 100) {
      const p = await steamJson(`${STEAM}/market/myhistory?start=${start}&count=100&norender=1`);
      historyPages.push(p); total = Number(p.total_count || 0);
      const times = (p.events || []).map((e) => Number(e.time_event));
      if (!times.length || Math.min(...times) < since) break;
    }
    const m = SCLib.matchMarketState(listed, plan.steamid, listingPages, historyPages);
    const results = m.results.concat(m.confirmedResults, m.notOnMarket);
    if (!results.length) return { ok: true, saved: 0 };
    const u = new URL(plan.report_url);
    u.searchParams.set("lang", SCI18n.normalize(lang));
    const r = await fetch(u.toString(), {
      method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plan.report_token}` },
      body: JSON.stringify({ results }),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, saved: j.saved || 0 } : { ok: false, error: j.error || String(r.status) };
  } catch (e) {
    // 读不到 Steam（多半是没登入 Steam），下次可以马上再试
    await chrome.storage.local.remove(key);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 把结果（加上之前没送成功的）送去网站。网络或服务器出错就留着下次再送。 */
async function report(job, results) {
  const T = SCI18n.pick(job.lang);
  const { queue = [] } = await chrome.storage.local.get("queue");
  const all = queue.concat(results.map((r) => ({
    appid: r.appid, contextid: r.contextid, assetid: r.assetid, status: r.status, at: r.at, seller_cents: r.seller_cents,
  })));
  if (all.length === 0) return { ok: true, saved: 0, skipped: [] };
  let saved = 0;
  const skipped = [];
  for (let k = 0; k < all.length; k += 200) {
    const chunk = all.slice(k, k + 200);
    let r, j;
    try {
      r = await fetch(reportUrl(job), {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${job.plan.report_token}` },
        body: JSON.stringify({ results: chunk }),
      });
      j = await r.json().catch(() => null);
    } catch {
      await chrome.storage.local.set({ queue: all.slice(k) });
      return { ok: false, queued: all.length - k, error: T.offline };
    }
    if (!r.ok) {
      const retry = r.status === 429 || r.status >= 500;
      await chrome.storage.local.set({ queue: retry ? all.slice(k) : [] });
      return { ok: false, queued: retry ? all.length - k : 0, error: (j && j.error) || T.siteStatus(r.status) };
    }
    saved += j.saved || 0;
    skipped.push(...(j.skipped || []));
  }
  await chrome.storage.local.set({ queue: [] });
  return { ok: true, saved, skipped };
}

/** 回报网址加上语言，网站的错误讯息才会和面板同一种语言（回报不带 cookie）。 */
function reportUrl(job) {
  const u = new URL(job.plan.report_url);
  u.searchParams.set("lang", SCI18n.normalize(job.lang));
  return u.toString();
}
