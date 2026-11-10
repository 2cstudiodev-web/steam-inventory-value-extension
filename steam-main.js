// 在 Steam 页面本身的环境执行（world: MAIN），只为了读页面变量 g_sessionID / g_steamID / g_rgWalletInfo，
// 交给同一页面里的插件脚本。不会送到任何其他网站。
(function () {
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.sc !== "ask") return;
    const w = typeof g_rgWalletInfo === "object" && g_rgWalletInfo ? g_rgWalletInfo : null;
    window.postMessage({
      sc: "info",
      sessionid: typeof g_sessionID === "string" ? g_sessionID : null,
      steamid: typeof g_steamID === "string" ? g_steamID : null,
      wallet_currency: w && w.wallet_currency != null ? Number(w.wallet_currency) : null,
    }, window.location.origin);
  });
})();
