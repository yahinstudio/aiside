// AiSIDE 后台 Service Worker (v5)
// 打开：openPanelOnActionClick（浏览器以正确手势打开）
// 切换标签页：面板保持打开（Chrome API 无法编程关闭面板），
//            由 sidepanel.js 的 tabs.onActivated 监听显示"总结当前网页"按钮
// 快捷键：打开侧边栏（若未开）并触发总结；面板刚打开时消息可能早于监听器注册，失败重试

console.log("[AiSIDE] build v5 已加载（快捷键开面板 + 消息重试投递）");

// 共享模块：仅用于 hardenStorageAccess / secretStore（common.js 顶层无副作用，SW 内可安全引入）
importScripts("common.js");

// 扩展初始化即收紧 storage.local 的访问级别（默认对内容脚本公开）
hardenStorageAccess();

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .then(() => console.log("[AiSIDE] openPanelOnActionClick 已启用"))
  .catch((e) => console.error("[AiSIDE] setPanelBehavior 失败:", e));

// webRequest：捕获 DeepSeek 页面请求头中的最新 token（写入 session，不落盘）
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details.requestHeaders) return;
    const auth = details.requestHeaders.find(
      (h) => h.name.toLowerCase() === "authorization"
    );
    if (auth && typeof auth.value === "string" && auth.value.startsWith("Bearer ")) {
      const token = auth.value.slice(7).trim();
      if (token.length > 20) {
        secretStore.set("ds_token", token).catch(() => {});
      }
    }
  },
  { urls: ["https://chat.deepseek.com/api/*"] },
  ["requestHeaders"]
);

// 快捷键：打开侧边栏并触发总结
chrome.commands.onCommand.addListener((command) => {
  if (command !== "summarize-page") return;
  (async () => {
    // 面板未开时主动打开（命令触发算用户手势，允许 sidePanel.open）
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab) await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (e) {
      console.warn("[AiSIDE] sidePanel.open 失败（面板可能已开）:", e);
    }
    // 面板刚打开时其消息监听器可能尚未注册：投递失败则短暂重试
    const send = async (tries = 0) => {
      try {
        await chrome.runtime.sendMessage({ type: "TRIGGER_SUMMARIZE" });
      } catch (e) {
        if (tries < 10) setTimeout(() => send(tries + 1), 150);
        else console.warn("[AiSIDE] TRIGGER_SUMMARIZE 投递失败:", e);
      }
    };
    send();
  })();
});
