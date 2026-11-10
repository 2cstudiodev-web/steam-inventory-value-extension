// 插件共用的纯函数（不碰网络、不碰 chrome API），测试在 tests/extension.test.ts。
// 内容脚本不能用 import，所以挂在 globalThis.SCLib。
(function () {
  "use strict";

  // Steam 市场交易记录的事件种类
  const EVENT_CREATED = 1;
  const EVENT_CANCELLED = 2;
  const EVENT_SOLD = 3;

  // 给客户看的讯息（lang = "zh" 时中文，其他英文）
  const MSG = {
    en: {
      loggedOut: "Your Steam sign-in has expired. Please refresh the page and sign in",
      rate: "Steam is rate limiting price checks",
      priceStatus: (s) => `Steam price check replied ${s || "network error"}`,
      badPrice: (p) => `Couldn't read Steam's price: ${p}`,
      noLive: (m) => `Couldn't get the live price${m ? ` (${m})` : ""}, so this item wasn't listed`,
      noMarketNoPlan: "There are no listings on the market and no site price, so this item wasn't listed",
      noMarketConfirm: "Nobody is selling this on the market right now. List it at the site price?",
      tooLow: "The live price is too low for Steam to list",
      drop: (pct) => `The live price is ${pct}% below the site price. List it at the live price?`,
    },
    zh: {
      loggedOut: "Steam 登入已失效，请重新整理页面并登入",
      rate: "Steam 查价限流",
      priceStatus: (s) => `Steam 查价回应 ${s || "网络错误"}`,
      badPrice: (p) => `看不懂 Steam 的价格：${p}`,
      noLive: (m) => "查不到即时价格" + (m ? `（${m}）` : "") + "，这件没有上架",
      noMarketNoPlan: "市场上现在没有挂单，也没有网站价，这件没有上架",
      noMarketConfirm: "市场上现在没有人挂单，要按网站价上架吗？",
      tooLow: "即时价太低，Steam 不能上架",
      drop: (pct) => `即时价比网站价低 ${pct}%，要按即时价上架吗？`,
    },
  };
  const M = (lang) => (lang === "zh" ? MSG.zh : MSG.en);

  /** 第 n 次重试前等多久（毫秒）：2s、4s、8s…，最多 60s。被限流（429）从 30s 起跳。 */
  function backoffMs(attempt, rateLimited) {
    const base = rateLimited ? 30000 : 2000;
    return Math.min(60000, base * Math.pow(2, attempt));
  }

  /**
   * 判断 sellitem 的回应。
   * 回传 { ok, needsConfirmation, retry, stop, message }（lang = "zh" 时讯息中文）：
   * stop = 登入失效之类，整批都不要再试；retry = 可以等一下再试同一件。
   */
  function classifySell(httpStatus, json, lang) {
    if (json && json.success === true) {
      return {
        ok: true, retry: false, stop: false, message: "",
        needsConfirmation: !!(json.requires_confirmation || json.needs_mobile_confirmation || json.needs_email_confirmation),
      };
    }
    const message = (json && typeof json.message === "string" && json.message) || `HTTP ${httpStatus}`;
    if (httpStatus === 401 || httpStatus === 403 || (httpStatus === 200 && !json)) {
      return { ok: false, needsConfirmation: false, retry: false, stop: true, message: M(lang).loggedOut };
    }
    // Steam 的错误讯息会按用户语言翻译，没办法可靠地区分。一律当作可以再试，由调用者限制次数。
    return { ok: false, needsConfirmation: false, retry: true, stop: false, message, rateLimited: httpStatus === 429 };
  }

  function key(appid, contextid, assetid) { return `${appid}|${contextid}|${assetid}`; }

  /** 一个市场 asset 可能对应的原库存 assetid（挂单后 Steam 会换 id，原 id 放在 unowned_id）。 */
  function assetKeys(asset, assets) {
    if (!asset) return [];
    const appid = Number(asset.appid);
    const ctx = String(asset.contextid);
    const full = (assets && assets[appid] && assets[appid][ctx] && assets[appid][ctx][asset.id]) || {};
    const ids = [asset.id, asset.unowned_id, full.id, full.unowned_id].filter(Boolean).map(String);
    const ctxs = [ctx, asset.unowned_contextid, full.unowned_contextid].filter(Boolean).map(String);
    const out = new Set();
    for (const id of ids) for (const c of ctxs) out.add(key(appid, c, id));
    return [...out];
  }

  /**
   * 对照「我的挂单」和「交易记录」，找出订单里挂单中物品的最新状态。
   * listed：订单里 status=listed 的物品；pages：mylistings 和 myhistory 的 JSON（norender=1）。
   * 回传 { results, active, toConfirm, unknown }，results 可以直接送去 listing-report。
   */
  function matchMarketState(listed, steamid, listingPages, historyPages) {
    const active = new Set();
    const toConfirm = new Set();
    for (const p of listingPages) {
      for (const l of [...(p.listings || []), ...(p.listings_on_hold || [])]) for (const k of assetKeys(l.asset, p.assets)) active.add(k);
      for (const l of p.listings_to_confirm || []) for (const k of assetKeys(l.asset, p.assets)) toConfirm.add(k);
    }

    // 每件物品最后一个事件
    const last = new Map();
    for (const p of historyPages) {
      const listings = p.listings || {};
      for (const e of p.events || []) {
        const l = listings[e.listingid];
        if (!l) continue;
        const t = Number(e.time_event) * 1000;
        for (const k of assetKeys(l.asset, p.assets)) {
          const prev = last.get(k);
          if (!prev || t >= prev.t) last.set(k, { t, e });
        }
      }
    }

    const results = [];
    const confirmedResults = []; // 挂单已在 Steam 手机 app 确认、出现在市场上
    const notOnMarket = [];      // 不在市场、不在待确认、也没有卖出/取消记录（例如在手机拒绝了确认）
    const waiting = [];          // 还在等手机确认的 assetid
    let activeN = 0, confirmN = 0, unknown = 0;
    for (const it of listed) {
      const k = key(it.appid, it.contextid, it.assetid);
      if (active.has(k)) {
        activeN++;
        confirmedResults.push({ appid: it.appid, contextid: it.contextid, assetid: it.assetid, status: "active" });
        continue;
      }
      if (toConfirm.has(k)) { confirmN++; waiting.push(it.assetid); continue; }
      const hit = last.get(k);
      const e = hit && hit.e;
      if (e && e.event_type === EVENT_SOLD && e.purchaseid) {
        results.push({ appid: it.appid, contextid: it.contextid, assetid: it.assetid, status: "sold", at: hit.t });
      } else if (e && e.event_type === EVENT_CANCELLED && !e.purchaseid && String(e.steamid_actor) === String(steamid)) {
        // 只算客户自己取消的；Steam 系统取消的留给后台判断
        results.push({ appid: it.appid, contextid: it.contextid, assetid: it.assetid, status: "user_cancelled", at: hit.t });
      } else {
        unknown++;
        notOnMarket.push({ appid: it.appid, contextid: it.contextid, assetid: it.assetid, status: "not_on_market" });
      }
    }
    return { results, confirmedResults, notOnMarket, waiting, active: activeN, toConfirm: confirmN, unknown };
  }

  // Steam 钱包货币（ECurrencyCode）→ 符号。网站有一份一样的表（src/lib/currencies.ts），改这里也要改那边。
  const CURRENCIES = {
    1: "US$", 2: "£", 3: "€", 4: "CHF ", 5: "₽", 6: "zł", 7: "R$", 8: "¥", 9: "kr ", 10: "Rp", 11: "RM", 12: "₱", 13: "S$",
    14: "฿", 15: "₫", 16: "₩", 17: "₺", 18: "₴", 19: "MX$", 20: "CA$", 21: "A$", 22: "NZ$", 23: "¥", 24: "₹", 25: "CLP$",
    26: "S/", 27: "COL$", 28: "R", 29: "HK$", 30: "NT$", 31: "SR", 32: "AED ", 34: "ARS$", 35: "₪", 37: "₸", 38: "KD",
    39: "QR", 40: "₡", 41: "$U",
  };
  /** 金额（分）按订单的钱包货币显示，例如 money(1234, 1) → "US$12.34"。不认识的代码显示代码本身。 */
  function money(cents, currency) {
    if (cents == null) return "-";
    return (CURRENCIES[currency] || ("#" + currency + " ")) + (cents / 100).toFixed(2);
  }
  function rm(cents) { return money(cents, 11); }

  // ---------- 上架前即时查价 ----------

  /** 和 src/lib/steam/parse.ts 的 parsePriceText 一样："RM1,234.56" / "RM 0.12" / "1.234,56€" → 分。 */
  function parsePriceText(text) {
    if (!text) return null;
    let t = String(text).replace(/[^\d.,]/g, "");
    if (!t) return null;
    const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
    if (lastComma > lastDot) t = t.replace(/\./g, "").replace(",", "."); // 1.234,56
    else t = t.replace(/,/g, ""); // 1,234.56
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }

  /** 和 src/lib/fees.ts 的 sellerReceives 一样：买家付 buyer，Steam 扣 5%（至少 1 分）+ 游戏方 10%（至少 1 分）。 */
  function sellerReceives(buyerCents) {
    const fee = (s) => s + Math.max(1, Math.floor(s * 0.05)) + Math.max(1, Math.floor(s * 0.1));
    if (buyerCents < 3) return 0;
    let s = Math.max(1, buyerCents - 2);
    while (s > 1 && fee(s) > buyerCents) s--;
    while (fee(s + 1) <= buyerCents) s++;
    return s;
  }

  /** 和 src/lib/listing.ts 的 listPrice 一样：最低挂单价再低约 1%（至少 1 分、最多 100 分），换成卖家实收。太便宜回传 null。 */
  function listPrice(lowestCents) {
    if (!lowestCents || lowestCents < 1) return null;
    const buyer = lowestCents - Math.min(100, Math.max(1, Math.round(lowestCents / 100)));
    const seller = sellerReceives(buyer);
    return seller >= 1 ? { buyer_cents: buyer, seller_cents: seller } : null;
  }

  function priceOverviewUrl(appid, currency, marketHashName) {
    return `https://steamcommunity.com/market/priceoverview/?appid=${encodeURIComponent(appid)}&currency=${encodeURIComponent(currency)}&market_hash_name=${encodeURIComponent(marketHashName)}`;
  }

  /**
   * 判断 priceoverview 的回应。回传 { ok, lowest_cents, rateLimited, message }。
   * ok 且 lowest_cents = null 表示市场上现在没有人挂单。
   */
  function classifyPriceOverview(httpStatus, json, lang) {
    if (httpStatus === 429) return { ok: false, lowest_cents: null, rateLimited: true, message: M(lang).rate };
    if (httpStatus < 200 || httpStatus >= 300 || !json || json.success !== true) {
      return { ok: false, lowest_cents: null, rateLimited: false, message: M(lang).priceStatus(httpStatus) };
    }
    if (json.lowest_price == null || json.lowest_price === "") return { ok: true, lowest_cents: null, rateLimited: false, message: "" };
    const cents = parsePriceText(json.lowest_price);
    if (cents == null || cents < 1) {
      return { ok: false, lowest_cents: null, rateLimited: false, message: M(lang).badPrice(String(json.lowest_price).slice(0, 30)) };
    }
    return { ok: true, lowest_cents: cents, rateLimited: false, message: "" };
  }

  const DROP_LIMIT = 0.2; // 即时价比网站价低超过 20% 就要客户确认

  /**
   * 用即时最低价决定这件怎么上架。
   * item：上架计划里的物品（buyer_cents / seller_cents 是网站缓存价算的）。
   * live：classifyPriceOverview 的结果。
   * confirmedBuyer：客户已确认可以接受的买家价（分），没有就 null。
   * 回传 { action: "list" | "confirm" | "fail", buyer_cents, seller_cents, live_buyer_cents, drop_pct, reason }。
   */
  function decideLivePrice(item, live, confirmedBuyer, lang) {
    const T = M(lang);
    const planBuyer = item.buyer_cents;
    const out = (action, price, extra) => Object.assign({
      action, buyer_cents: price ? price.buyer_cents : null, seller_cents: price ? price.seller_cents : null,
      live_buyer_cents: null, drop_pct: null, reason: "",
    }, extra);
    if (!live || !live.ok) return out("fail", null, { reason: T.noLive(live && live.message) });
    const ok = (buyer) => confirmedBuyer != null && buyer >= confirmedBuyer;

    if (live.lowest_cents == null) {
      // 市场上没人挂单：没有「市场价」可以低于，只能请客户确认是否用网站价
      if (planBuyer == null || item.seller_cents == null) return out("fail", null, { reason: T.noMarketNoPlan });
      const plan = { buyer_cents: planBuyer, seller_cents: item.seller_cents };
      return ok(planBuyer) ? out("list", plan) : out("confirm", plan, { reason: T.noMarketConfirm });
    }

    const p = listPrice(live.lowest_cents);
    if (!p) return out("fail", null, { live_buyer_cents: live.lowest_cents - 1, reason: T.tooLow });
    const extra = { live_buyer_cents: p.buyer_cents };
    if (planBuyer != null && planBuyer > 0 && p.buyer_cents < planBuyer * (1 - DROP_LIMIT)) {
      extra.drop_pct = Math.round((1 - p.buyer_cents / planBuyer) * 100);
      if (ok(p.buyer_cents)) return out("list", p, extra);
      extra.reason = T.drop(extra.drop_pct);
      return out("confirm", p, extra);
    }
    return out("list", p, extra);
  }

  /**
   * 请求节流：每次 wait() 至少和上一次隔 gapMs。被限流后 slowDown() 把间隔加倍（最多 maxGapMs）。
   * clock 可以换成假的方便测试：{ now(), sleep(ms) }。
   */
  function createThrottle(gapMs, maxGapMs, clock) {
    const now = (clock && clock.now) || (() => Date.now());
    const sleep = (clock && clock.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms)));
    let last = -Infinity, gap = gapMs;
    return {
      async wait() {
        const d = last + gap - now();
        if (d > 0) await sleep(d);
        last = now();
      },
      slowDown() { gap = Math.min(maxGapMs, gap * 2); },
      get gap() { return gap; },
    };
  }

  const api = {
    EVENT_CREATED, EVENT_CANCELLED, EVENT_SOLD, backoffMs, classifySell, assetKeys, matchMarketState, rm, money, CURRENCIES,
    parsePriceText, sellerReceives, listPrice, priceOverviewUrl, classifyPriceOverview, decideLivePrice, createThrottle, DROP_LIMIT,
  };
  globalThis.SCLib = api;
})();
