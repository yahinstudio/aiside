// AiSIDE 侧边栏：加载即自动总结；再次按快捷键/点图标时重新总结
// 仅支持 http/https/file 页面；B 站视频页走专用接口流程

const contentEl = document.getElementById("content");

// 正文字符上限（自定义 API 与账号模式统一 60000；预填充实测 ~2s，长文不再提前截断）
const API_MAX_CHARS = 60000;

// DeepSeek/Kimi 内联正文的字符上限（超出按 3/4 头 + 1/4 尾截断）
const DS_MAX_CHARS = 60000;


// 任务序号：新触发会取代旧任务（中断旧请求）
let seq = 0;
let activeCtrl = null;

// ---------------- 状态渲染 ----------------

function showEmpty(msg) {
  contentEl.innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`;
}

// 居中显示"总结中"状态
function showLoading(detail) {
  contentEl.innerHTML =
    `<div class="loading-center">` +
    `<div class="spinner"></div>` +
    `<div class="loading-title">总结中</div>` +
    `<div class="loading-detail">${escapeHtml(detail || "")}</div>` +
    `</div>`;
}

function showError(msg, action) {
  contentEl.innerHTML =
    `<div class="error"><div class="error-title">无法总结网页</div>` +
    `<div class="error-msg">${escapeHtml(msg)}</div>` +
    (action
      ? `<button class="error-action" id="error-action">${escapeHtml(action.label)}</button>`
      : "") +
    `</div>`;
  const btn = document.getElementById("error-action");
  if (btn) btn.addEventListener("click", () => chrome.tabs.create({ url: action.url }));
}

// ---------------- 材料组装 ----------------

function buildUserMessage(page) {
  if (page.mode === "bilibili") {
    return (
      "以下是从 B 站视频页提取的资料（标题/简介/自动字幕整理成的 Markdown），" +
      "请基于这份资料进行总结：\n\n" + page.text
    );
  }
  return `网页标题：${page.title || "(无标题)"}\n网页地址：${page.url}\n\n网页正文：\n${page.text}`;
}

function biliErrorText(d) {
  const code = d.error || "";
  if (code === "view--404") return "视频不存在或已设为私密/删除。";
  if (code === "view--352" || code === "view--412") return "B 站接口触发风控，请稍后再试。";
  if (code === "view--403") return "被 B 站拒绝访问（可能未登录），请先在浏览器中登录 B 站。";
  return "B 站接口异常：" + (d.message || code);
}

// ---------------- 总结流程 ----------------

async function summarize() {
  const mySeq = ++seq;
  if (activeCtrl) activeCtrl.abort();
  const ctrl = new AbortController();
  activeCtrl = ctrl;
  let tab = null;
  let provider = null;

  try {
    const settings = await getSettings();
    if (mySeq !== seq) return;
    if (!isReady(settings)) {
      showEmpty("尚未配置 AI 服务：请在扩展图标上右键 →「选项」，填写 API 并选择模型。");
      return;
    }
    provider = settings.providers[settings.activeProvider];
    const systemPrompt = (settings.prompt || "").trim() || DEFAULT_PROMPT;

    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (mySeq !== seq) return;
    if (!tab) {
      showError("找不到当前标签页，请切换到要总结的网页后重试。");
      return;
    }
    // 更新追踪：记住当前总结的标签页
    lastSummarizedTabId = tab.id;
    hasSummarizedOnce = true;
    if (!isAllowedProtocol(tab)) {
      showError("请在网页上使用：本扩展仅支持 http、https 和 file 页面，请切换到普通网页。");
      return;
    }
    if (isPdfTab(tab)) {
      showError("浏览器内建 PDF 查看器不支持总结，请打开对应视频/网页后重试。");
      return;
    }

    // 取页面材料：B 站视频页走专用接口，其余页面注入提取正文
    let page;
    if (isBilibiliVideoUrl(tab.url)) {
      showLoading("正在获取 B 站视频信息与字幕");
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: extractBilibili,
      });
      if (mySeq !== seq) return;
      const d = results && results[0] && results[0].result;
      if (!d) throw new Error("B 站接口无响应，请刷新页面后重试。");
      if (d.error) throw new Error(biliErrorText(d));
      // 字幕 JSON 在扩展上下文下载（免 CORS）；失败回退页面上下文（自动携带 Referer）
      let subtitle = [];
      let subtitleNote = d.subtitleNote || "";
      if (d.subtitleUrl) {
        console.info("[AiSIDE] 下载 B 站字幕:", d.subtitleUrl, "lan=", d.subtitleLan);
        const r = await fetchBilibiliSubtitle(d.subtitleUrl);
        if (mySeq !== seq) return;
        subtitle = r.subtitle;
        subtitleNote = r.note;
        if (!subtitle.length) {
          try {
            const r2 = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: "MAIN",
              func: (u) => fetch(u).then((res) => res.json()),
              args: [d.subtitleUrl],
            });
            if (mySeq !== seq) return;
            const body = r2 && r2[0] && r2[0].result;
            if (body && Array.isArray(body.body) && body.body.length) {
              subtitle = body.body;
              subtitleNote = "";
            }
          } catch (_) { /* 页面回退也失败，沿用首次失败原因 */ }
        }
        if (!subtitle.length && !subtitleNote) subtitleNote = "字幕内容为空";
        console.info(
          "[AiSIDE] B 站字幕结果:",
          subtitle.length ? subtitle.length + " 条" : subtitleNote || "无"
        );
      }
      const md = buildBilibiliMarkdown({ ...d, subtitle, subtitleNote });
      if (!md.trim()) throw new Error("未获取到可总结的 B 站资料。");
      page = { mode: "bilibili", title: d.title, url: tab.url, text: md };
    } else {
      showLoading("正在提取网页内容");
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPageText,
        args:
          provider.type === "kimi"
            ? [DS_MAX_CHARS, true] // Kimi 文件模式额外提取清洗后的 body HTML 作附件
            : [DS_MAX_CHARS],
      });
      if (mySeq !== seq) return;
      const p = results && results[0] && results[0].result;
      if (!p || !p.text || p.text.trim().length < 10) {
        showError("未提取到有效正文：页面内容可能为空、暂时无法访问，或需要登录后才能查看。");
        return;
      }
      page = { mode: "web", title: p.title, url: p.url, text: p.text, bodyHtml: p.bodyHtml };
    }

    const model = provider.defaultModel;

    // 账号模式：确认登录态后，提示词与正文合并为单条消息发送
    let messages;
    let kimiFileId = null;
    if (provider.type === "deepseek" || provider.type === "kimi") {
      showLoading(provider.type === "kimi" ? "正在连接 Kimi 账号" : "正在连接 DeepSeek 账号");
      if (provider.type === "kimi") await KIMI.ensureTokens();
      else await DEEPSEEK.ensureToken();
      if (mySeq !== seq) return;

      // Kimi 文件模式：上传页面 HTML（B 站页为整理后的 Markdown）作附件，失败降级为内联文本
      if (provider.type === "kimi") {
        const safeName = (page.title || "webpage").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
        const file = page.bodyHtml
          ? new File([page.bodyHtml], safeName + ".html", { type: "text/html" })
          : page.mode === "bilibili"
            ? new File([page.text], safeName + ".md", { type: "text/markdown" })
            : null;
        if (file) {
          try {
            showLoading("正在上传网页文件到 Kimi");
            kimiFileId = await KIMI.uploadFile(file, ctrl.signal);
            if (mySeq !== seq) return;
            showLoading("正在等待 Kimi 解析文件");
            const st = await KIMI.waitFileParsed(kimiFileId, ctrl.signal);
            if (mySeq !== seq) return;
            if (st !== "parsed") throw new Error("解析状态：" + st);
          } catch (e) {
            if (e && e.name === "AbortError") throw e;
            if (mySeq !== seq) return;
            kimiFileId = null;
            console.warn("[AiSIDE] Kimi 文件上传/解析失败，降级为内联文本:", e);
          }
        }
      }

      let userContent;
      if (provider.type === "kimi" && kimiFileId) {
        const fileKind = page.bodyHtml ? "网页完整 HTML 文件" : "整理后的页面资料";
        userContent =
          `网页标题：${page.title || "(无标题)"}\n网页地址：${page.url}\n\n` +
          `附件是${fileKind}，请先阅读附件内容再继续。`;
      } else {
        userContent = buildUserMessage(page);
      }
      messages = [{ role: "user", content: systemPrompt + "\n\n" + userContent }];
    } else {
      messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildUserMessage(page) },
      ];
    }
    showLoading(""); // 恢复纯"总结中"状态，等待首个输出

    let full = "";
    let firstChunk = true;
    let renderedBlocks = []; // 已在 DOM 中的顶层块（原始 markdown 字符串）
    let renderScheduled = false;
    let lastTailKey = ""; // 上次临时渲染内容指纹，无变化时跳过 DOM 写入
    // 渲染节流：SSE chunk 高频到达时只更新内存缓存，按屏幕帧批量调度一次 DOM 更新
    const flushRender = () => {
      renderScheduled = false;
      const plan = planStreamingRender(full);
      let common = 0;
      while (
        common < renderedBlocks.length &&
        common < plan.blocks.length &&
        renderedBlocks[common] === plan.blocks[common]
      ) {
        common++;
      }
      while (contentEl.childElementCount > common) contentEl.lastElementChild.remove();
      for (let bi = common; bi < plan.blocks.length; bi++) {
        contentEl.insertAdjacentHTML("beforeend", renderMarkdown(plan.blocks[bi]));
      }
      renderedBlocks = plan.blocks;

      let provEl = document.getElementById("stream-prov");
      if (!plan.tailText) {
        if (provEl) provEl.remove();
        lastTailKey = "";
        return;
      }
      const tailKey = plan.tailText + "\u0000" + plan.heldOut;
      if (tailKey === lastTailKey) return; // 尾巴无变化，跳过重建
      lastTailKey = tailKey;
      if (!provEl) {
        provEl = document.createElement("div");
        provEl.id = "stream-prov";
        contentEl.appendChild(provEl);
      }
      provEl.innerHTML = renderProvisionalTail(plan.tailText, plan.heldOut);
    };
    const scheduleRender = () => {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(flushRender);
    };
    for await (const chunk of streamChat(provider, model, messages, ctrl.signal, { kimiFileId })) {
      if (mySeq !== seq) return;
      full += chunk;
      if (firstChunk && full) {
        firstChunk = false;
        contentEl.innerHTML = ""; // 首个输出到达后让"总结中"消失
        lastTailKey = "";
      }
      scheduleRender();
    }
    if (mySeq !== seq) return;
    flushRender(); // 流结束：立即刷新最终状态，确保文字 100% 完整呈现

    if (!full.trim()) {
      showError("模型未返回内容，请换个模型或稍后重试。");
      return;
    }
    contentEl.innerHTML = renderMarkdown(full);
  } catch (err) {
    if (mySeq !== seq || (err && err.name === "AbortError")) return;
    let msg = friendlyError(err);
    if (tab && /^file:/i.test(tab.url) && /cannot access|permission|denied/i.test(msg)) {
      msg += "；请确认已在 chrome://extensions 中本扩展的详情页开启「允许访问文件网址」。";
    }
    // 账号模式登录态失效：在错误面板提供可点击的登录入口
    const action =
      provider && /登录/.test(msg)
        ? provider.type === "kimi"
          ? { label: "打开 www.kimi.com 登录", url: "https://www.kimi.com/" }
          : provider.type === "deepseek"
            ? { label: "打开 chat.deepseek.com 登录", url: "https://chat.deepseek.com/" }
            : null
        : null;
    showError(msg, action);
  } finally {
    if (mySeq === seq) {
      activeCtrl = null;
    }
  }
}

// ---------------- 初始化 ----------------

async function applyFontSize() {
  const settings = await getSettings();
  document.documentElement.style.setProperty("--sum-font-size", settings.fontSize + "px");
  // 自定义字体/字重：空值时移除变量，回退到默认
  if (settings.fontFamily) {
    document.documentElement.style.setProperty("--sum-font-family", settings.fontFamily);
  } else {
    document.documentElement.style.removeProperty("--sum-font-family");
  }
  if (settings.fontWeight) {
    document.documentElement.style.setProperty("--sum-font-weight", settings.fontWeight);
  } else {
    document.documentElement.style.removeProperty("--sum-font-weight");
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "TRIGGER_SUMMARIZE") summarize();
});

// 代码块"复制"按钮（事件委托：从 .ln-text 收集纯文本）
contentEl.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".md-code-copy");
  if (!btn) return;
  const codeEl = btn.closest(".md-code-wrap").querySelector(".md-pre code");
  if (!codeEl) return;
  const text = Array.from(codeEl.querySelectorAll(".ln"))
    .map((l) => l.querySelector(".ln-text").textContent)
    .join("\n");
  const done = (msg) => {
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = "复制"; }, 1200);
  };
  (navigator.clipboard && navigator.clipboard.writeText(text)
    ? navigator.clipboard.writeText(text)
    : Promise.reject(new Error("clipboard unavailable"))
  ).then(() => done("已复制"), () => done("复制失败"));
});

// 设置页修改字体大小后即时生效
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) applyFontSize();
});

// ---------------- 标签页切换检测 ----------------

// 记录上次总结的标签页；-1 表示尚未总结过（首次加载由 init 自动触发）
let lastSummarizedTabId = -1;
let hasSummarizedOnce = false;

// 居中显示"总结当前网页"按钮（切换标签页后出现）
function showSummarizeButton() {
  contentEl.innerHTML =
    `<div class="summarize-cta">` +
    `<button class="cta-btn" id="cta-summarize">总结当前网页</button>` +
    `</div>`;
  const btn = document.getElementById("cta-summarize");
  if (btn) btn.addEventListener("click", () => summarize());
}

// 监听标签页切换：非首次加载时，中止当前输出、显示"总结当前网页"按钮
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!hasSummarizedOnce) return; // 尚未做过任何总结（首次打开面板），由 init 自动触发
  if (tabId === lastSummarizedTabId) return; // 切回同一个标签页，保留已有内容
  // 切换了标签页：中止进行中的请求 + 显示"总结当前网页"按钮
  seq++;
  if (activeCtrl) {
    activeCtrl.abort();
    activeCtrl = null;
  }
  showSummarizeButton();
});

(async () => {
  await applyFontSize();
  const settings = await getSettings();
  if (!isReady(settings)) {
    showEmpty("尚未配置 AI 服务：请在扩展图标上右键 →「选项」，填写 API 并选择模型。");
    return;
  }
  hasSummarizedOnce = true;
  summarize();
})();
