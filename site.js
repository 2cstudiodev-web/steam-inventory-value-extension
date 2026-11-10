// 在托管网站每一页执行（网站内换页不会重新载入，只挂订单页会侦测不到）：告诉页面插件已安装，按钮按下后读取上架计划，交给背景页。
(function () {
  "use strict";
  const VERSION = chrome.runtime.getManifest().version;
  // 网站目前的语言（<html lang>），插件面板跟着用
  const lang = globalThis.SCI18n.normalize(document.documentElement.lang);
  const T = globalThis.SCI18n.pick(lang);
  const say = (msg) => window.postMessage({ source: "sc-ext", ...msg }, location.origin);

  document.documentElement.dataset.scExtension = VERSION;
  say({ type: "ready", version: VERSION });
  // 顺便请背景页检查有没有新版本（最多每小时一次）
  chrome.runtime.sendMessage({ type: "hello" }).catch(() => {});
  // 网站显示已登入时，看 Steam 还有没有登入；Steam 登出了，网站会跟着登出（src/components/SteamSessionWatch.tsx）
  if (document.documentElement.dataset.signedIn) {
    chrome.runtime.sendMessage({ type: "steamLogin" }).then((r) => {
      if (!r || !r.ok) return;
      document.documentElement.dataset.steamLogin = r.signedIn ? "in" : "out";
      say({ type: "steamLogin", signedIn: r.signedIn });
    }).catch(() => {});
  }

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.source !== "sc-page") return;
    if (d.type === "ping") return say({ type: "ready", version: VERSION });
    if (d.type === "checkStatus") {
      // 在背景查卖出状态，不开分页
      const orderId = String(d.orderId || "");
      if (!/^[0-9a-f-]{36}$/i.test(orderId)) return;
      try {
        const r = await fetch(`/api/orders/${orderId}/listing-plan`, { credentials: "same-origin", cache: "no-store" });
        const plan = await r.json().catch(() => null);
        if (!r.ok || !plan) return say({ type: "status", ok: false });
        const res = await chrome.runtime.sendMessage({ type: "checkStatus", plan, lang });
        return say({ type: "status", ...(res || { ok: false }) });
      } catch { return say({ type: "status", ok: false }); }
    }
    if (d.type !== "start") return;
    const orderId = String(d.orderId || "");
    const mode = d.mode === "sync" ? "sync" : "list";
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) return say({ type: "error", message: T.badOrderId });
    try {
      const r = await fetch(`/api/orders/${orderId}/listing-plan`, { credentials: "same-origin", cache: "no-store" });
      const plan = await r.json().catch(() => null);
      if (!r.ok || !plan) return say({ type: "error", message: (plan && plan.error) || T.loadFailed(r.status) });
      const res = await chrome.runtime.sendMessage({ type: "start", mode, plan, lang });
      if (!res || !res.ok) return say({ type: "error", message: (res && res.error) || T.noResponse });
      say({ type: "started", mode });
    } catch (e) {
      say({ type: "error", message: String((e && e.message) || e) });
    }
  });
})();
