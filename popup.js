// 插件图示的小窗口：介绍服务，连到网站（语言跟着 Chrome 的介面语言）
(function () {
  "use strict";
  const SITE = "https://steam.2cstudio.app";
  const zh = chrome.i18n.getUILanguage().toLowerCase().startsWith("zh");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
  document.getElementById("ver").textContent = `${zh ? "版本" : "Version"} ${chrome.runtime.getManifest().version}`;
  for (const a of document.querySelectorAll("a[data-path]")) {
    const p = a.dataset.path;
    // 公开页面有中文版（/zh/...），「我的订单」用网站自己的语言设定
    a.href = p === "my" ? `${SITE}/my` : `${SITE}${zh ? "/zh" : ""}${p ? `/${p}` : (zh ? "" : "/")}`;
  }
})();
