// Steam 库存页左下角的小按钮：打开我们的网站，帮这个库存估值（网址预先填好）
(function () {
  "use strict";
  if (document.getElementById("sc-value-cta")) return;
  const SITE = "https://steam.2cstudio.app";
  const zh = chrome.i18n.getUILanguage().toLowerCase().startsWith("zh");
  const profile = location.origin + location.pathname.replace(/\/inventory.*$/, "/");
  const a = document.createElement("a");
  a.id = "sc-value-cta";
  // src=ext：网站据此把这笔估值算作「从插件来的」（2C 总控台按渠道统计）
  a.href = `${SITE}${zh ? "/zh" : "/"}?q=${encodeURIComponent(profile)}&src=ext`;
  a.target = "_blank";
  a.rel = "noopener";
  a.title = chrome.i18n.getMessage("ctaTitle");
  a.textContent = "💰 " + chrome.i18n.getMessage("ctaButton");
  Object.assign(a.style, {
    position: "fixed", left: "16px", bottom: "16px", zIndex: 9999, padding: "10px 14px", borderRadius: "8px",
    background: "#4fa3e8", color: "#06121f", font: "600 14px Arial, sans-serif", textDecoration: "none",
    boxShadow: "0 4px 14px rgba(0,0,0,.35)",
  });
  document.body.appendChild(a);
})();
