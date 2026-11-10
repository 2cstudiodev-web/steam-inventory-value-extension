// 在 steamcommunity.com 执行：显示上架面板、在你自己的登入状态下送出上架请求、读取挂单和交易记录。
// 所有 Steam 请求都从这一页直接送到 Steam，网站收不到你的 Steam cookie 或 sessionid。
(function () {
  "use strict";
  if (window.top !== window) return;
  const L = globalThis.SCLib;
  const I = globalThis.SCI18n;
  let lang = "en";      // 跟着网站的语言，进入点读到订单后设定
  let T = I.pick(lang);
  const STEAM = "https://steamcommunity.com";
  const GAP_MS = 2000;       // 每件之间间隔
  const MAX_TRIES = 3;       // 每件最多试几次
  const MAX_FAIL_STREAK = 3; // 连续几件失败就暂停
  const PRICE_GAP_MS = 1500; // 查价请求之间至少隔多久
  const PRICE_MAX_GAP_MS = 6000; // 被限流后最多拉长到多久
  const PRICE_TRIES = 4; // 查价被限流最多试几次
  const PRICE_TTL_MS = 10 * 60000; // 同一个物品名 10 分钟内不重复查
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e.message || e) }));

  // ---------- 读页面变量（经 steam-main.js） ----------
  function pageInfo() {
    return new Promise((resolve) => {
      const done = (v) => { window.removeEventListener("message", onMsg); clearTimeout(t); resolve(v); };
      const onMsg = (ev) => { if (ev.source === window && ev.data && ev.data.sc === "info") done(ev.data); };
      window.addEventListener("message", onMsg);
      const t = setTimeout(() => done({}), 3000);
      window.postMessage({ sc: "ask" }, location.origin);
    });
  }
  function cookieSession() {
    const m = document.cookie.match(/(?:^|;\s*)sessionid=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ---------- 面板 ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (v != null) el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) el.append(typeof c === "string" || typeof c === "number" ? String(c) : c);
    return el;
  }

  const CSS = `
    :host { all: initial; }
    .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: min(460px, calc(100vw - 32px));
      max-height: calc(100vh - 32px); display: flex; flex-direction: column; background: #172231; color: #e6edf5;
      border: 1px solid #4fa3e8; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.5);
      font: 14px/1.5 "Microsoft YaHei", "PingFang SC", Arial, sans-serif; }
    header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid #2b3d55; font-weight: 700; }
    .body { padding: 12px 14px; overflow-y: auto; }
    .list { max-height: 260px; overflow-y: auto; border: 1px solid #2b3d55; border-radius: 6px; margin: 8px 0; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    td, th { padding: 4px 6px; border-bottom: 1px solid #2b3d55; text-align: left; }
    th { color: #8fa3bb; font-weight: 600; position: sticky; top: 0; background: #172231; }
    .num { text-align: right; white-space: nowrap; }
    .nowrap { white-space: nowrap; }
    .muted { color: #8fa3bb; font-size: 12px; }
    .note { background: #1e2c3f; border-left: 3px solid #f0b44c; padding: 8px 10px; border-radius: 4px; margin: 8px 0; }
    .err { border-left-color: #f07a6a; }
    .note ul { margin: 6px 0; padding-left: 18px; max-height: 160px; overflow-y: auto; }
    .good { color: #5cc98a; } .bad { color: #f07a6a; } .warn { color: #f0b44c; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    button { font: inherit; cursor: pointer; border-radius: 6px; padding: 7px 12px; border: 1px solid #2b3d55; background: #1e2c3f; color: #e6edf5; }
    button.primary { background: #4fa3e8; border-color: #4fa3e8; color: #06121f; font-weight: 700; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .x { background: none; border: none; color: #8fa3bb; font-size: 18px; padding: 0 4px; }
    .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; background: #4fa3e8; color: #06121f; border: none;
      border-radius: 999px; padding: 10px 16px; font: 600 14px Arial, sans-serif; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
    a { color: #4fa3e8; }
  `;

  // 面板：按 × 只是收起来，变成右下角一个小按钮，按一下再打开（打开时会重新查一次进度）
  function makePanel(title) {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    const body = h("div", { class: "body" });
    const ui = {
      onReopen: null,
      set(...kids) { body.replaceChildren(...kids.flat().filter(Boolean)); },
      error(msg) { body.replaceChildren(h("div", { class: "note err" }, msg)); },
      close() { host.remove(); },
    };
    const box = h("div", { class: "box" },
      h("header", {}, title, h("button", { class: "x", title: T.close, on: { click: () => { box.style.display = "none"; pill.style.display = ""; } } }, "×")),
      body);
    const pill = h("button", { class: "pill", on: { click: () => {
      pill.style.display = "none"; box.style.display = "";
      if (ui.onReopen) ui.onReopen();
    } } }, title);
    pill.style.display = "none";
    root.append(h("style", {}, CSS), box, pill);
    document.body.append(host);
    return ui;
  }

  // ---------- 即时查价 ----------
  // 直接向 Steam 查（公开资料），结果只用在这一页，不会送到网站。
  const priceThrottle = L.createThrottle(PRICE_GAP_MS, PRICE_MAX_GAP_MS);
  const priceCache = new Map(); // appid|market_hash_name → { live, at }

  /** 查一个物品名的即时最低价。回传 classifyPriceOverview 的结果；限流试完了 rateLimited = true。 */
  async function livePrice(item, currency, onWait) {
    const k = `${item.appid}|${item.market_hash_name}`;
    const hit = priceCache.get(k);
    if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.live;
    let live = null;
    for (let attempt = 0; attempt < PRICE_TRIES; attempt++) {
      await priceThrottle.wait();
      let status = 0, json = null;
      try {
        const r = await fetch(L.priceOverviewUrl(item.appid, currency, item.market_hash_name), { credentials: "same-origin" });
        status = r.status;
        json = await r.json().catch(() => null);
      } catch {
        status = 0;
      }
      live = L.classifyPriceOverview(status, json, lang);
      if (!live.rateLimited) break;
      priceThrottle.slowDown();
      if (attempt < PRICE_TRIES - 1) {
        const ms = L.backoffMs(attempt, true);
        if (onWait) onWait(ms);
        await sleep(ms);
      }
    }
    if (live.ok) priceCache.set(k, { live, at: Date.now() });
    return live;
  }

  // ---------- 上架 ----------
  async function sellOne(item, sellerCents, sessionid) {
    let last = { message: "" };
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      let status = 0, json = null;
      try {
        const r = await fetch(`${STEAM}/market/sellitem/`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: new URLSearchParams({
            sessionid, appid: String(item.appid), contextid: String(item.contextid), assetid: String(item.assetid),
            amount: "1", price: String(sellerCents),
          }),
        });
        status = r.status;
        json = await r.json().catch(() => null);
      } catch (e) {
        status = 0;
        json = { success: false, message: String(e.message || e) };
      }
      last = L.classifySell(status, json, lang);
      if (last.ok || last.stop) return last;
      if (attempt < MAX_TRIES - 1) await sleep(L.backoffMs(attempt, last.rateLimited));
    }
    return last;
  }

  function runList(job, info, ui) {
    const plan = job.plan;
    const todo = plan.items.filter((it) => it.status === "pending");
    const state = new Map(todo.map((it) => [it.id, it.skip ? { cls: "muted", text: it.skip } : { cls: "muted", text: T.waiting }]));
    const sentIds = new Set();      // 这次已送出的
    const decided = new Map();      // id → decideLivePrice 的结果（显示即时价用）
    const waiting = new Map();      // id → 需要客户确认价格的
    const confirmed = new Map();    // id → 客户确认可以接受的买家价
    const skippedNow = new Set();   // 客户选择这次先不上架的
    let running = false, paused = false, sent = 0, failed = 0;

    const liveCell = (it) => {
      const d = decided.get(it.id);
      if (!d) return h("td", { class: "num muted" }, "-");
      if (d.live_buyer_cents == null) return h("td", { class: "num muted" }, d.action === "fail" ? T.notFound : T.noListings);
      return h("td", { class: "num" + (d.drop_pct != null ? " bad" : "") }, L.rm(d.live_buyer_cents), d.drop_pct != null ? ` (−${d.drop_pct}%)` : "");
    };
    const ready = () => todo.filter((it) => !it.skip && !sentIds.has(it.id) && !skippedNow.has(it.id));

    function confirmBox() {
      if (running || waiting.size === 0) return null;
      const list = todo.filter((it) => waiting.has(it.id));
      return h("div", { class: "note err" },
        h("b", {}, T.confirmTitle(list.length)),
        h("ul", {}, list.map((it) => {
          const d = waiting.get(it.id);
          return h("li", {}, T.confirmLine(it.name, L.rm(it.buyer_cents), L.rm(d.buyer_cents), L.rm(d.seller_cents), d.reason));
        })),
        h("div", { class: "row" },
          h("button", { class: "primary", on: { click: confirmAll } }, T.confirmAll(list.length)),
          h("button", { on: { click: skipAll } }, T.skipAll)));
    }

    function render(extra) {
      const rows = todo.map((it) => {
        const s = state.get(it.id);
        const d = decided.get(it.id);
        return h("tr", {}, h("td", {}, it.name),
          h("td", { class: "num" }, L.rm(it.buyer_cents)), liveCell(it),
          h("td", { class: "num" }, L.rm(d && d.seller_cents != null ? d.seller_cents : it.seller_cents)),
          h("td", { class: s.cls + (s.cls === "good" ? " nowrap" : "") }, s.text));
      });
      const fresh = ready().filter((it) => !waiting.has(it.id));
      ui.set(
        h("div", {}, T.intro(plan.order_no, todo.length)),
        todo.length === 0 ? h("div", { class: "note" }, T.nothingToList) : null,
        todo.length ? h("div", { class: "list" }, h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, T.thItem), h("th", { class: "num" }, T.thSite), h("th", { class: "num" }, T.thLive),
            h("th", { class: "num" }, T.thYouGet), h("th", {}, T.thStatus))),
          h("tbody", {}, rows))) : null,
        h("div", { class: "muted" }, T.priceHelp(Math.round(L.DROP_LIMIT * 100))),
        h("div", { class: "note" }, T.confirmReminder),
        confirmBox(),
        extra || null,
        h("div", { class: "row" },
          !running && fresh.length ? h("button", { class: "primary", on: { click: start } }, sent || failed ? T.continueList(fresh.length) : T.startList(fresh.length)) : null,
          running ? h("button", { on: { click: () => { paused = true; render(); } } }, paused ? T.pausing : T.pause) : null,
          !running ? h("button", { on: { click: () => switchToSync(job, info, ui) } }, T.sync) : null,
          !running ? h("button", { on: { click: finish } }, T.done) : null),
        h("p", { class: "muted" }, T.privacy));
    }

    function confirmAll() {
      for (const [id, d] of waiting) confirmed.set(id, d.buyer_cents);
      waiting.clear();
      start();
    }
    function skipAll() {
      for (const id of waiting.keys()) { skippedNow.add(id); state.set(id, { cls: "muted", text: T.skippedNow }); }
      waiting.clear();
      render();
    }

    async function flush(batch) {
      if (!batch.length) return;
      const res = await send({ type: "report", results: batch.splice(0) });
      // 记住哪些已送出，重新整理页面也不会重复上架
      await send({ type: "setMode", mode: "list", items: job.plan.items });
      if (!res.ok) render(h("div", { class: "note err" }, T.reportFailed(res.error)));
    }

    async function start() {
      if (running) return;
      running = true; paused = false;
      const batch = [];
      let streak = 0, pauseMsg = null;
      for (const it of ready()) {
        if (waiting.has(it.id)) continue;
        if (paused) break;
        state.set(it.id, { cls: "warn", text: T.checking }); render();
        const live = await livePrice(it, plan.currency, (ms) => {
          state.set(it.id, { cls: "warn", text: T.rateWait(Math.round(ms / 1000)) }); render();
        });
        if (live.rateLimited) {
          state.set(it.id, { cls: "bad", text: T.rateStop });
          pauseMsg = T.ratePaused;
          break;
        }
        const d = L.decideLivePrice(it, live, confirmed.has(it.id) ? confirmed.get(it.id) : null, lang);
        decided.set(it.id, d);
        if (d.action === "confirm") {
          waiting.set(it.id, d);
          state.set(it.id, { cls: "warn", text: T.needConfirm });
          render();
          continue;
        }
        if (d.action === "fail") {
          state.set(it.id, { cls: "bad", text: d.reason });
          failed++; streak++;
          if (streak >= MAX_FAIL_STREAK) { pauseMsg = T.streakPaused(streak, d.reason); break; }
          render();
          continue;
        }
        state.set(it.id, { cls: "warn", text: T.listing }); render();
        const r = await sellOne(it, d.seller_cents, info.sessionid);
        if (r.ok) {
          state.set(it.id, { cls: "good", text: T.sent });
          sentIds.add(it.id);
          it.status = "listed";
          sent++; streak = 0;
          batch.push({ appid: it.appid, contextid: it.contextid, assetid: it.assetid, status: "listed", seller_cents: d.seller_cents });
          if (batch.length >= 5) await flush(batch);
        } else {
          state.set(it.id, { cls: "bad", text: T.failed(r.message) });
          failed++; streak++;
          if (r.stop) { pauseMsg = r.message; break; }
          if (streak >= MAX_FAIL_STREAK) {
            pauseMsg = T.streakPausedConfirm(streak, r.message);
            break;
          }
        }
        render();
        await sleep(GAP_MS);
      }
      await flush(batch);
      running = false;
      const listedNow = sentIds.size;
      const summary = (extra) => h("div", {},
        pauseMsg ? h("div", { class: "note err" }, pauseMsg) : null,
        listedNow ? h("div", { class: "note" }, h("b", {}, T.sentSummary(listedNow))) : null,
        extra || null);
      render(summary());
      if (listedNow) watchConfirm(todo.filter((it) => sentIds.has(it.id)), (note) => render(summary(note)));
    }

    // 送出后等客户在 Steam 手机 app 确认：每 15 秒读一次自己的挂单，出现在市场上的就回报网站
    async function watchConfirm(items, show) {
      const done = new Set();
      const seenWaiting = new Set(); // 看过在「待确认」里的，之后不见又不在市场 = 在手机拒绝了
      let declined = 0;
      for (let round = 0; round < 40 && done.size < items.length; round++) {
        await sleep(round === 0 ? 5000 : 15000);
        try {
          const pages = [];
          for (let start = 0, total = Infinity; start < total && pages.length < 5; start += 100) {
            const p = await getJson(`${STEAM}/market/mylistings?start=${start}&count=100&norender=1`);
            pages.push(p); total = Number(p.total_count || 0);
            if (start + 100 < total) await sleep(1500);
          }
          const m = L.matchMarketState(items.filter((it) => !done.has(it.id)), plan.steamid, pages, []);
          for (const a of m.waiting) seenWaiting.add(a);
          const gone = m.notOnMarket.filter((r) => seenWaiting.has(r.assetid));
          const fresh = m.confirmedResults.concat(gone);
          if (fresh.length) {
            const res = await send({ type: "report", results: fresh });
            if (res.ok) {
              for (const r of fresh) done.add(items.find((it) => it.assetid === r.assetid).id);
              declined += gone.length;
            }
          }
        } catch { /* 读不到就下一轮再试 */ }
        if (running) return; // 客户又按了继续上架，交给新的一轮
        const onMarket = done.size - declined;
        show(h("div", {},
          h("div", { class: "note" }, done.size >= items.length && !declined ? T.allConfirmed(items.length) : T.watching(onMarket, items.length - declined)),
          declined ? h("div", { class: "note" }, T.declined(declined)) : null));
      }
      if (done.size < items.length && !running) show(h("div", { class: "note" }, T.watchStopped));
    }

    async function finish() { await send({ type: "finish" }); ui.close(); }
    render();
  }

  // ---------- 同步状态 ----------
  async function getJson(url) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(url, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (r.status === 429) { await sleep(L.backoffMs(attempt, true)); continue; }
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.success === false) throw new Error(T.steamStatus(r.status));
      return j;
    }
    throw new Error(T.steamRate);
  }

  async function runSync(job, info, ui) {
    const plan = job.plan;
    const listed = plan.items.filter((it) => it.status === "listed");
    if (listed.length === 0) {
      ui.set(h("div", { class: "note" }, T.noListed),
        h("div", { class: "row" }, h("button", { on: { click: async () => { await send({ type: "finish" }); ui.close(); } } }, T.done)));
      return;
    }
    ui.set(h("div", {}, T.reading(listed.length)));
    try {
      const listingPages = [];
      for (let start = 0, total = Infinity; start < total && listingPages.length < 10; start += 100) {
        const p = await getJson(`${STEAM}/market/mylistings?start=${start}&count=100&norender=1`);
        listingPages.push(p); total = Number(p.total_count || 0);
        await sleep(1500);
      }
      // 交易记录从新到旧，读到订单开始上架之前就停
      const since = plan.listing_started_at ? new Date(plan.listing_started_at).getTime() / 1000 - 86400 : 0;
      const historyPages = [];
      for (let start = 0, total = Infinity; start < total && historyPages.length < 20; start += 100) {
        const p = await getJson(`${STEAM}/market/myhistory?start=${start}&count=100&norender=1`);
        historyPages.push(p); total = Number(p.total_count || 0);
        const times = (p.events || []).map((e) => Number(e.time_event));
        if (times.length === 0 || Math.min(...times) < since) break;
        await sleep(2000);
      }
      const m = L.matchMarketState(listed, plan.steamid, listingPages, historyPages);
      const sold = m.results.filter((r) => r.status === "sold").length;
      const cancelled = m.results.length - sold;
      let reportNote = null;
      const report = m.results.concat(m.confirmedResults, m.notOnMarket);
      if (report.length) {
        const res = await send({ type: "report", results: report });
        reportNote = res.ok
          ? h("div", { class: "note" }, T.reported(res.saved) + (res.skipped && res.skipped.length ? T.reportedSkipped(res.skipped.length) : ""))
          : h("div", { class: "note err" }, T.reportFailed(res.error));
      }
      ui.set(
        h("table", {}, h("tbody", {},
          h("tr", {}, h("td", {}, T.rowActive), h("td", { class: "num" }, m.active)),
          h("tr", {}, h("td", { class: m.toConfirm ? "warn" : "" }, T.rowToConfirm), h("td", { class: "num" }, m.toConfirm)),
          h("tr", {}, h("td", {}, T.rowSold), h("td", { class: "num" }, sold)),
          h("tr", {}, h("td", {}, T.rowCancelled), h("td", { class: "num" }, cancelled)),
          h("tr", {}, h("td", {}, T.rowUnknown), h("td", { class: "num" }, m.unknown)))),
        m.toConfirm ? h("div", { class: "note" }, T.toConfirmNote(m.toConfirm)) : null,
        reportNote,
        h("p", { class: "muted" }, T.syncRule(plan.refund_days)),
        h("div", { class: "row" }, h("button", { on: { click: async () => { await send({ type: "finish" }); ui.close(); } } }, T.done)));
    } catch (e) {
      ui.error(T.syncFailed(e.message || e));
    }
  }

  async function switchToSync(job, info, ui) {
    job.mode = "sync";
    await send({ type: "setMode", mode: "sync", items: job.plan.items });
    runSync(job, info, ui);
  }

  // ---------- 进入点 ----------
  (async () => {
    const res = await send({ type: "getJob" });
    const job = res && res.job;
    if (!job) return;
    lang = I.normalize(job.lang);
    T = I.pick(lang);
    const ui = makePanel(T.panelTitle(job.plan.order_no));
    const info = await pageInfo();
    info.sessionid = info.sessionid || cookieSession();
    const inv = `${STEAM}/profiles/${job.plan.steamid}/inventory/`;
    if (!info.steamid) return ui.error(T.signInSteam);
    if (info.steamid !== job.plan.steamid) {
      return ui.error(T.wrongAccount(info.steamid, job.plan.steamid));
    }
    if (!info.sessionid) return ui.error(T.noSession);
    // 收起后再打开：同步模式重新查一次；上架模式保持原来的画面
    ui.onReopen = () => { if (job.mode === "sync") runSync(job, info, ui); };
    if (job.mode === "sync") return runSync(job, info, ui);
    // 上架要在自己的库存页做（和 Steam 自己的「出售」按钮一样的来源页面）
    if (!/^\/(profiles|id)\/[^/]+\/inventory/.test(location.pathname)) {
      return ui.set(h("div", { class: "note" }, T.useInventory), h("a", { href: inv }, T.openInventory));
    }
    if (info.wallet_currency !== job.plan.currency) {
      return ui.set(h("div", { class: "note err" }, info.wallet_currency == null
        ? T.noCurrency
        : T.wrongCurrency),
      info.wallet_currency == null ? h("a", { href: inv }, T.openInventory) : null);
    }
    runList(job, info, ui);
  })();
})();
