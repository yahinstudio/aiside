// AiSIDE 公共模块：设置存储、API 请求（OpenAI 兼容 / Gemini）、正文提取、渲染

// ---------------- 设置 ----------------

const DEFAULT_PROMPT = "请返回您反复阅读正文后精心写成的详尽笔记";

const DEFAULT_SETTINGS = {
  providers: {
    deepseek: { type: "deepseek" },
    kimi: { type: "kimi" },
    openai: {
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      defaultModel: "",
      reasoningEffort: "", // 思考模式：""=不传（跟随服务端默认）；disabled=关闭思考；low/high/max=思考强度
    },
    gemini: {
      type: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "",
      defaultModel: "",
      reasoningEffort: "",
    },
  },
  activeProvider: "deepseek",
  fontSize: 15,
  fontFamily: "", // 自定义字体：""=默认字体栈；否则为系统字体名
  fontWeight: "", // 字重：""=默认；300/400/500/600/700
  prompt: DEFAULT_PROMPT,
};

// 深合并：extra 覆盖 base（嵌套对象逐层合并）
function deepMerge(base, extra) {
  if (
    typeof base !== "object" || base === null ||
    typeof extra !== "object" || extra === null
  ) {
    return extra !== undefined ? extra : base;
  }
  const out = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(extra)])) {
    out[key] = deepMerge(base[key], extra[key]);
  }
  return out;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return deepMerge(DEFAULT_SETTINGS, settings || {});
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

// ---------------- 模型列表缓存 ----------------

async function getCachedModels(providerKey) {
  const { models } = await chrome.storage.local.get("models");
  return (models && models[providerKey]) || [];
}

async function saveCachedModels(providerKey, list) {
  const { models } = await chrome.storage.local.get("models");
  await chrome.storage.local.set({
    models: { ...(models || {}), [providerKey]: list },
  });
}

// ---------------- API 错误 ----------------

class ApiError extends Error {}

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, "") + path;
}

function openaiHeaders(p) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${p.apiKey}`,
  };
}

function geminiHeaders(p) {
  return {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": p.apiKey,
  };
}

async function parseApiError(res) {
  let detail = "";
  try {
    const j = await res.json();
    detail = (j.error && (j.error.message || j.error.status)) || j.message || "";
  } catch (_) { /* 非 JSON body，忽略 */ }
  const map = {
    401: "API Key 无效或无权限",
    403: "访问被拒绝，请检查 API 权限",
    404: "接口地址或模型不存在，请检查 Base URL 和模型名",
    429: "请求过于频繁或额度已用完",
  };
  let msg = map[res.status] || `请求失败（HTTP ${res.status}）`;
  if (detail) msg += `：${detail}`;
  return new ApiError(msg);
}

function isReady(settings) {
  const p = settings.providers[settings.activeProvider];
  if (!p) return false;
  // 账号模式复用网页登录态，无需 Key / 模型
  if (p.type === "deepseek" || p.type === "kimi") return true;
  return !!(p.apiKey && p.defaultModel);
}

// ---------------- 模型列表 ----------------

// 拉取模型列表，返回模型 id 数组
async function fetchModels(provider) {
  const baseUrl = String(provider.baseUrl || "").trim();
  if (!baseUrl) throw new ApiError("请先填写 Base URL");

  if (provider.type === "gemini") {
    const res = await fetch(joinUrl(baseUrl, "/v1beta/models?pageSize=100"), {
      headers: geminiHeaders(provider),
    });
    if (!res.ok) throw await parseApiError(res);
    const data = await res.json();
    const models = (data.models || [])
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean)
      .sort();
    if (!models.length) throw new ApiError("接口正常但未返回任何模型");
    return models;
  }

  // OpenAI 兼容
  const res = await fetch(joinUrl(baseUrl, "/models"), {
    headers: openaiHeaders(provider),
  });
  if (!res.ok) throw await parseApiError(res);
  const data = await res.json();
  const models = (data.data || [])
    .map((m) => String(m.id || ""))
    .filter(Boolean)
    .sort();
  if (!models.length) throw new ApiError("接口正常但未返回任何模型");
  return models;
}

// 最小请求验证模型确实可调用（max_tokens=1 的非流式请求）
async function testModel(provider, model) {
  if (!model) throw new ApiError("请先选择或输入模型名");

  const headers = provider.type === "gemini" ? geminiHeaders(provider) : openaiHeaders(provider);
  const url = provider.type === "gemini"
    ? joinUrl(provider.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`)
    : joinUrl(provider.baseUrl, "/chat/completions");
  const body = provider.type === "gemini"
    ? {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1 },
      }
    : {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      };

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw await parseApiError(res);
}

// ---------------- 流式对话 ----------------

// streamChat 生成器：逐段 yield 文本增量
// provider: 当前 provider 配置; model: 模型名; messages: [{role:'system'|'user'|'assistant', content}]
// kimiOpts: 仅 Kimi 模式使用；{ fileId, chatId }（chatId 需先创建会话；兼容传纯字符串作为 fileId）
// kimiOpts 参数已废弃，保留签名兼容
// opts: 可选，{ kimiFileId } —— Kimi 文件模式引用的附件 id
async function* streamChat(provider, model, messages, signal, opts) {
  // 账号模式（DeepSeek / Kimi 网页版）：system 与 user 合并为单条消息，正文内联发送
  if (provider.type === "deepseek" || provider.type === "kimi") {
    const isKimi = provider.type === "kimi";
    const mod = isKimi ? "KIMI" : "DEEPSEEK";
    if (typeof window === "undefined" || !window[mod]) {
      throw new ApiError(
        `${isKimi ? "Kimi" : "DeepSeek"} 模块未加载（${isKimi ? "kimi.js" : "deepseek.js"}）`
      );
    }
    const content = messages
      .map((m) => m.content)
      .filter(Boolean)
      .join("\n\n");
    const sessionId = await window[mod].createSession();
    yield* window[mod].sendMessage(sessionId, content, signal, opts && opts.kimiFileId);
    return;
  }

  let url, headers, body, extract;
  if (provider.type === "gemini") {
    const systemText = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    // 思考模式映射为 Gemini 的 thinkingBudget（关闭=0；low/high/max 递增）
    const THINKING_BUDGET = { disabled: 0, low: 1024, high: 16384, max: 24576 };
    const generationConfig = {};
    if (provider.reasoningEffort && THINKING_BUDGET[provider.reasoningEffort] !== undefined) {
      generationConfig.thinkingConfig = { thinkingBudget: THINKING_BUDGET[provider.reasoningEffort] };
    }
    url = joinUrl(
      provider.baseUrl,
      `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    );
    headers = geminiHeaders(provider);
    body = JSON.stringify({
      contents,
      systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
      generationConfig: Object.keys(generationConfig).length ? generationConfig : undefined,
    });
    extract = (obj) => extractDelta(obj, "gemini");
  } else {
    url = joinUrl(provider.baseUrl, "/chat/completions");
    headers = openaiHeaders(provider);
    // 思考模式：disabled=关闭思考（GLM-4.5/4.6/5.0~5.2 支持）；low/high/max=思考强度（GLM-5.2+，
    // 其中 5.3 强制思考无法关闭）；留空不传，避免不支持的服务报参数错误
    const payload = { model, messages, stream: true };
    if (provider.reasoningEffort === "disabled") payload.thinking = { type: "disabled" };
    else if (provider.reasoningEffort) payload.reasoning_effort = provider.reasoningEffort;
    body = JSON.stringify(payload);
    extract = (obj) => extractDelta(obj, "openai");
  }

  const res = await fetch(url, { method: "POST", headers, body, signal });
  if (!res.ok) throw await parseApiError(res);
  if (!res.body) throw new ApiError("响应不支持流式读取");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(":")) continue;
      const data = line.startsWith("data:") ? line.slice(5).trim() : line;
      if (data === "[DONE]") return;
      let obj;
      try {
        obj = JSON.parse(data);
      } catch (_) {
        continue;
      }
      const text = extract(obj);
      if (text) yield text;
    }
  }
}

function extractDelta(obj, type) {
  if (obj.error) {
    const msg = obj.error.message || obj.error.status || JSON.stringify(obj.error);
    throw new ApiError(`接口返回错误：${msg}`);
  }
  if (type === "gemini") {
    const parts =
      obj.candidates && obj.candidates[0] && obj.candidates[0].content && obj.candidates[0].content.parts;
    return parts ? parts.map((p) => p.text || "").join("") : "";
  }
  const delta =
    obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content;
  return typeof delta === "string" ? delta : "";
}

// 把错误转为友好中文提示
function friendlyError(err) {
  if (err instanceof ApiError) return err.message;
  if (err && err.name === "AbortError") return "请求已中断";
  if (err instanceof TypeError) {
    // TypeError 通常是代码级异常（如方法名不存在），附带原始信息便于定位
    return "网络请求失败：请检查网络连接或 Base URL 是否可访问（" + (err && err.message) + "）";
  }
  return (err && err.message) || String(err);
}

// ---------------- 正文提取（注入到标签页执行的自包含纯函数） ----------------

// 注入到标签页执行的自包含纯函数；maxChars 由调用方决定（账号模式可传更大值）；
// includeHtml 为 true 时额外返回 body.outerHTML（Kimi 文件模式上传附件用）
function extractPageText(maxChars, includeHtml) {
  const MAX = typeof maxChars === "number" && maxChars > 0 ? maxChars : 24000;
  const get = (sel) => {
    try {
      return document.querySelector(sel);
    } catch (_) {
      return null;
    }
  };
  const ordered = [
    get("article"),
    get("main"),
    get('[role="main"]'),
    get("#content"),
    get("#main"),
    document.body,
  ].filter((el) => el && el.innerText);

  let chosen = null;
  for (const el of ordered) {
    if (el.innerText.length >= 500) {
      chosen = el;
      break;
    }
  }
  if (!chosen) chosen = ordered[ordered.length - 1];

  const raw = (chosen && chosen.innerText) || (document.body && document.body.innerText) || "";

  const seen = new Set();
  const lines = [];
  // innerText 中表格行以 \t 分隔单元格：连续的制表符行合并为一张 Markdown 表格
  //（模型读取 Markdown 表格比制表符文本更稳），普通行照旧处理
  let table = null;
  const flushTable = () => {
    if (table && table.length) {
      const cols = Math.max(...table.map((r) => r.length));
      for (const r of table) while (r.length < cols) r.push("");
      lines.push("| " + table.map((r) => r.join(" | ")).join(" |\n| ") + " |");
    }
    table = null;
  };
  for (let line of raw.split("\n")) {
    if (line.includes("\t")) {
      const cells = line
        .split("\t")
        .map((c) => c.replace(/\s+/g, " ").trim());
      while (cells.length && !cells[0]) cells.shift();
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length >= 2) {
        const key = "\t" + cells.join("\u0001");
        if (!seen.has(key)) {
          seen.add(key);
          if (!table) table = [];
          table.push(cells);
        }
        continue;
      }
      flushTable();
      line = cells[0] || "";
    } else {
      flushTable();
    }
    line = line.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (line.length < 2) continue;
    // 排除导航中常见的短链接行
    if (/^(https?:\/\/|\/\/)[^\s]+$/i.test(line) && line.length < 120) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  flushTable();

  let text = lines.join("\n");

  // 长文截断：保留开头 3/4 与结尾 1/4
  if (text.length > MAX) {
    const head = Math.floor(MAX * 0.75);
    text =
      text.slice(0, head) +
      "\n\n……（页面内容过长，中间部分已省略）……\n\n" +
      text.slice(text.length - (MAX - head));
  }

  // Kimi 文件模式用：克隆 body 并清洗——黑名单移除脚本/样式/媒体等噪声标签，
  // 剥离全部属性（仅保留 href/colspan/rowspan），再清掉无文字的空壳元素；
  // 不做白名单过滤，正文文本节点一个不丢。清洗后体积通常缩减 60%~80%，
  // 上传与 Kimi 服务端解析显著提速。必须内嵌于注入函数（自包含，无外部依赖）。
  function cleanBodyHtml() {
    const root = document.body.cloneNode(true);
    root
      .querySelectorAll(
        "script,style,svg,canvas,noscript,iframe,frame,object,embed,form,button,input,select,textarea,video,audio,source,track,map,area,img,picture,link,meta,template"
      )
      .forEach((el) => el.remove());
    const keepAttrs = new Set(["href", "colspan", "rowspan"]);
    root.querySelectorAll("*").forEach((el) => {
      for (const attr of [...el.attributes]) {
        if (!keepAttrs.has(attr.name.toLowerCase())) el.removeAttribute(attr.name);
      }
    });
    // 清除无文字的空壳元素（表格结构与换行除外），两轮处理嵌套空壳
    const protect = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "br", "hr"]);
    for (let pass = 0; pass < 2; pass++) {
      root.querySelectorAll("*").forEach((el) => {
        if (protect.has(el.tagName.toLowerCase())) return;
        if (!el.textContent.trim() && !el.querySelector("br")) el.remove();
      });
    }
    return root.outerHTML;
  }

  return {
    title: document.title || "",
    url: location.href,
    text,
    bodyHtml: includeHtml && document.body ? cleanBodyHtml() : undefined,
  };
}

// 长文本截断：保留开头 3/4 与结尾 1/4（与 extractPageText 内的截断逻辑一致）
function truncateText(text, maxChars) {
  const MAX = typeof maxChars === "number" && maxChars > 0 ? maxChars : 24000;
  if (text.length <= MAX) return text;
  const head = Math.floor(MAX * 0.75);
  return (
    text.slice(0, head) +
    "\n\n……（页面内容过长，中间部分已省略）……\n\n" +
    text.slice(text.length - (MAX - head))
  );
}

// 仅允许 http(s)/file 页面注入提取
function isAllowedProtocol(tab) {
  return /^(https?|file):/i.test((tab && tab.url) || "");
}

// 浏览器内建 PDF 查看器页面无法注入
function isPdfTab(tab) {
  return !!(
    tab &&
    (tab.mimeType === "application/pdf" || /\.pdf(\?|#|$)/i.test(tab.url || ""))
  );
}

// ---------------- B 站（bilibili）支持 ----------------

// 识别视频页并提取 bvid/aid：www.bilibili.com/video/BVxxx 或 /video/av123
function isBilibiliVideoUrl(url) {
  return /bilibili\.com\/video\/(BV[\w]+|av\d+)/i.test(url || "");
}

// 注入到页面 MAIN world 执行（自包含，不引用外部变量）：
// 1) view 接口（credentials:"include" 携带 B 站 cookie）取标题/简介/cid；
// 2) nav 接口取 wbi 密钥 → 本地 MD5 计算 w_rid → x/player/wbi/v2 取字幕列表
//    （AI 字幕仅 wbi/v2 返回，旧 /x/player/v2 已基本不返回字幕；失败时仍回退旧接口）；
// 3) 下载字幕 JSON。wbi 签名算法见 SocialSisterYi/bilibili-API-collect。
function extractBilibili() {
  try {
    // ---- 自包含 MD5（hex 输出，输入按 UTF-8 编码；RFC 1321 实现）----
    function md5hex(str) {
      // K 表按 RFC 公式生成；s 为各轮循环左移位数
      const K = [];
      for (let i = 0; i < 64; i++) {
        K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
      }
      const s = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
      ];
      // UTF-8 字节
      const bytes = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 0x80) bytes.push(c);
        else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
          const c2 = str.charCodeAt(++i);
          const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
          bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      // 消息填充：0x80 + 0* + 64 位小端长度
      // 注意：取长度字节必须用算术而非 >>> 移位——JS 移位计数会 mod 32，i≥4 时会错误地重复低 32 位
      const bitLen = bytes.length * 8;
      const msg = bytes.slice();
      msg.push(0x80);
      while (msg.length % 64 !== 56) msg.push(0);
      for (let i = 0; i < 8; i++) msg.push(Math.floor(bitLen / 2 ** (8 * i)) % 256);
      let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
      for (let off = 0; off < msg.length; off += 64) {
        const M = [];
        for (let j = 0; j < 16; j++) {
          M[j] =
            msg[off + j * 4] |
            (msg[off + j * 4 + 1] << 8) |
            (msg[off + j * 4 + 2] << 16) |
            (msg[off + j * 4 + 3] << 24);
        }
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
          let F, g;
          if (i < 16) { F = (B & C) | (~B & D); g = i; }
          else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
          else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
          else { F = C ^ (B | ~D); g = (7 * i) % 16; }
          F = (F + A + K[i] + M[g]) | 0;
          A = D; D = C; C = B;
          B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) | 0;
        }
        a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
      }
      const hex = (n) => {
        let out = "";
        for (let i = 0; i < 4; i++) {
          out += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
        }
        return out;
      };
      return hex(a0) + hex(b0) + hex(c0) + hex(d0);
    }
    // ---- wbi 混淆密钥表 ----
    function getMixinKey(imgKey, subKey) {
      const tab = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
      const raw = imgKey + subKey;
      return tab.map((i) => raw[i]).join("").slice(0, 32);
    }

    const m =
      location.href.match(/bilibili\.com\/video\/(BV[\w]+)/i) ||
      location.href.match(/bilibili\.com\/video\/av(\d+)/i);
    if (!m) return { error: "not-bilibili", message: "页面不是 B 站视频页" };

    const bvid = m[1] || "";
    const aid = m[2] || "";
    const viewUrl = bvid
      ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
      : `https://api.bilibili.com/x/web-interface/view?aid=${aid}`;

    const fetchJson = (url, opts) =>
      fetch(url, opts).then((r) => r.json());

    // nav（WBI 密钥）只依赖 Cookie，与 view 接口零依赖——并行请求省一次完整 RTT；
    // 失败静默置 null，下方 wbi 路径自动跳过并回退旧接口
    const navPromise = fetchJson("https://api.bilibili.com/x/web-interface/nav", {
      credentials: "include",
    }).catch(() => null);

    return fetchJson(viewUrl, { credentials: "include" }).then(
      async (view) => {
        if (view.code !== 0) {
          return { error: "view-" + view.code, message: view.message || "获取视频信息失败" };
        }
        const d = view.data || {};
        const cid = d.cid || 0;
        const realAid = d.aid || aid;

        // 字幕列表：wbi/v2 优先（AI 字幕仅此接口返回），失败或为空时回退旧接口
        let subs = [];
        try {
          const nav = await navPromise;
          const wbiImg = (nav && nav.data && nav.data.wbi_img) || {};
          const imgKey = String(wbiImg.img_url || "").split("/").pop().split(".")[0];
          const subKey = String(wbiImg.sub_url || "").split("/").pop().split(".")[0];
          if (imgKey && subKey) {
            const params = { aid: realAid, cid, wts: Math.floor(Date.now() / 1000) };
            const query = Object.keys(params)
              .sort()
              .map(
                (k) =>
                  encodeURIComponent(k) +
                  "=" +
                  encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ""))
              )
              .join("&");
            const wRid = md5hex(query + getMixinKey(imgKey, subKey));
            const wbiRes = await fetchJson(
              `https://api.bilibili.com/x/player/wbi/v2?${query}&w_rid=${wRid}`,
              { credentials: "include" }
            );
            if (
              wbiRes.code === 0 &&
              wbiRes.data &&
              wbiRes.data.subtitle &&
              Array.isArray(wbiRes.data.subtitle.subtitles)
            ) {
              subs = wbiRes.data.subtitle.subtitles;
            }
          }
        } catch (_) { /* wbi 路径失败，走旧接口回退 */ }
        if (!subs.length) {
          const playerUrl = `https://api.bilibili.com/x/player/v2?${
            bvid ? "bvid=" + bvid : "aid=" + aid
          }&cid=${cid}`;
          const player = await fetchJson(playerUrl, { credentials: "include" });
          if (
            player.code === 0 &&
            player.data &&
            player.data.subtitle &&
            player.data.subtitle.subtitles
          ) {
            subs = player.data.subtitle.subtitles;
          }
        }
        // 字幕选择：优先 CC 中文字幕，其次 AI 等含 zh 的字幕（lan 形如 ai-zh），最后第一条
        const sub =
          subs.find((s) => /^zh/i.test(String(s.lan || ""))) ||
          subs.find((s) => /zh/i.test(String(s.lan || ""))) ||
          subs[0];
        let subtitleUrl = "";
        let subtitleNote = "";
        if (sub && sub.subtitle_url) {
          const url0 = String(sub.subtitle_url);
          subtitleUrl = url0.startsWith("//") ? "https:" + url0 : url0;
        } else {
          subtitleNote = "未获取到自动字幕（可能需登录 B 站，或该视频未提供字幕）";
        }
        // 字幕 JSON 不在页面内下载：页面上下文跨域请求 aisubtitle.hdslb.com 会被 CORS 拦截，
        // 仅返回 URL，由侧边栏在扩展上下文下载（fetchBilibiliSubtitle，host_permissions 免 CORS）
        return {
          title: d.title || "",
          desc: d.desc || "",
          owner: (d.owner && d.owner.name) || "",
          tname: d.tname || "",
          bvid: d.bvid || bvid,
          cid,
          subtitleLan: (sub && sub.lan) || "",
          subtitleUrl,
          subtitleNote,
        };
      }
    );
  } catch (e) {
    return { error: "exception", message: String((e && e.message) || e) };
  }
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// 在扩展上下文下载 B 站字幕 JSON（host_permissions 免 CORS；页面上下文会被 CORS 拦截）
// 返回 { subtitle, note }：note 非空表示未拿到字幕及具体原因
async function fetchBilibiliSubtitle(subtitleUrl) {
  if (!subtitleUrl) return { subtitle: [], note: "" };
  try {
    const res = await fetch(subtitleUrl);
    if (!res.ok) {
      return { subtitle: [], note: "字幕下载失败（HTTP " + res.status + "）" };
    }
    const body = await res.json();
    if (!Array.isArray(body.body)) {
      return { subtitle: [], note: "字幕下载失败（响应缺少字幕内容）" };
    }
    return { subtitle: body.body, note: body.body.length ? "" : "字幕内容为空" };
  } catch (e) {
    return { subtitle: [], note: "字幕下载失败（" + ((e && e.message) || e) + "）" };
  }
}

// 把 B 站数据组装成 Markdown 材料（标题/UP主/简介/字幕时间轴段落）
function buildBilibiliMarkdown(d) {
  const lines = [];
  lines.push(`# ${d.title || "(无标题)"}`);
  const meta = [];
  if (d.tname) meta.push(`分区：${d.tname}`);
  if (d.owner) meta.push(`UP 主：${d.owner}`);
  if (d.bvid) meta.push(`BV 号：${d.bvid}`);
  if (meta.length) lines.push(`- ${meta.join("　|　")}`);
  lines.push("");
  if (d.desc && d.desc.trim()) {
    lines.push("## 简介");
    lines.push("");
    lines.push(d.desc.trim());
    lines.push("");
  }
  if (d.subtitleNote) {
    lines.push(`> ${d.subtitleNote}`);
    lines.push("");
  }
  if (Array.isArray(d.subtitle) && d.subtitle.length) {
    lines.push("## 视频字幕（按内容合并，含时间点）");
    lines.push("");
    // 合并时间接近的短字幕为一组
    const paras = [];
    let cur = null;
    for (const s of d.subtitle) {
      const text = String(s.content || "").trim();
      if (!text) continue;
      if (cur && s.from - cur.end <= 1.5) {
        cur.end = s.to;
        cur.text += text;
      } else {
        cur = { from: s.from, end: s.to, text };
        paras.push(cur);
      }
    }
    for (const p of paras) lines.push(`[${formatTime(p.from)}] ${p.text}`);
  }
  return lines.join("\n");
}

// ---------------- 轻量 Markdown 渲染（安全：先转义再替换） ----------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function inlineHtml(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

// 极简 Markdown：标题/列表/引用/表格/粗体/行内代码/换行
function renderMarkdown(text) {
  const lines = escapeHtml(text).split("\n");
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push(`<div class="md-para">${para.join("<br>")}</div>`);
      para = [];
    }
  };
  const tableCells = (row) =>
    row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const isSeparator = (row) => /^[\s:\-|]+$/.test(row) && row.includes("-");
  for (let li = 0; li < lines.length; li++) {
    const t = inlineHtml(lines[li].trim());
    if (!t) {
      flush();
      continue;
    }
    if (/^(#{1,6})\s+/.test(t)) {
      flush();
      const level = Math.min(t.match(/^(#{1,6})\s+/)[1].length, 6);
      out.push(`<div class="md-h md-h${level}">${t.replace(/^#{1,6}\s*/, "")}</div>`);
      continue;
    }
    // 单独一行的 --- / *** / ___ 渲染为块间隔（不画横线）
    if (/^(---|\*\*\*|___)$/.test(t)) {
      flush();
      out.push(`<div class="md-hr"></div>`);
      continue;
    }
    // 围栏代码块：``` 或 ```bash 开头，到结束 ``` 为止，块内不做行内解析
    if (/^```/.test(t)) {
      flush();
      const lang = t.replace(/^```/, "").trim();
      const codeLines = [];
      li++;
      while (li < lines.length && !/^```/.test(lines[li].trim())) {
        codeLines.push(lines[li]);
        li++;
      }
      // 注意：行间不能带 "\n"——pre 会保留该空白，叠加在 display:block 行上形成空行
      const numbered = codeLines
        .map((l, i) => `<span class="ln"><em>${i + 1}</em><span class="ln-text">${l}</span></span>`)
        .join("");
      out.push(
        `<div class="md-code-wrap">` +
          `<div class="md-code-head">` +
          `<span class="md-code-lang">${lang}</span>` +
          `<button type="button" class="md-code-copy">复制</button>` +
          `</div>` +
          `<pre class="md-pre"><code>${numbered}</code></pre>` +
          `</div>`
      );
      continue;
    }
    // 表格：连续以 | 包裹的行；第 2 行为分隔线时用第一行当表头
    if (/^\|/.test(t) && /\|$/.test(t)) {
      flush();
      const rows = [t];
      while (
        li + 1 < lines.length &&
        /^\|/.test(lines[li + 1].trim()) &&
        /\|$/.test(lines[li + 1].trim())
      ) {
        rows.push(inlineHtml(lines[++li].trim()));
      }
      const sep = rows.length > 1 && isSeparator(rows[1]);
      const head = tableCells(rows[0]);
      const cols = head.length;
      const bodyRows = sep ? rows.slice(2) : rows.slice(1);
      const mkRow = (cells, tag) => {
        const cs = cells.slice(0, cols);
        while (cs.length < cols) cs.push("");
        return `<tr>${cs.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
      };
      out.push(
        `<div class="md-table-wrap"><table class="md-table">` +
          (sep
            ? `<thead>${mkRow(head, "th")}</thead><tbody>${bodyRows
                .map((r) => mkRow(tableCells(r), "td"))
                .join("")}</tbody>`
            : `<tbody>${mkRow(head, "td")}${bodyRows
                .map((r) => mkRow(tableCells(r), "td"))
                .join("")}</tbody>`) +
          `</table></div>`
      );
      continue;
    }
    if (/^[-*]\s+/.test(t)) {
      flush();
      out.push(`<div class="md-li">• ${t.replace(/^[-*]\s+/, "")}</div>`);
      continue;
    }
    if (/^\d+\.\s+/.test(t)) {
      flush();
      out.push(`<div class="md-li">${t}</div>`);
      continue;
    }
    if (/^&gt;\s+/.test(t)) {
      flush();
      out.push(`<div class="md-quote">${t.replace(/^&gt;\s*/, "")}</div>`);
      continue;
    }
    para.push(t);
  }
  flush();
  return out.join("");
}

// 流式渲染裁剪：丢弃未完成的最后一行与未闭合的代码块，避免半截 markdown 闪现
function trimStreamingMarkdown(text) {
  let t = String(text || "");
  const nl = t.lastIndexOf("\n");
  if (nl < 0) return "";
  t = t.slice(0, nl); // 去掉未完成的最后一行
  const fences = (t.match(/^```/gm) || []).length;
  if (fences % 2 === 1) {
    // 代码块未闭合：从最后一个 ``` 处裁剪
    const idx = t.lastIndexOf("```");
    if (idx >= 0) t = t.slice(0, idx).replace(/\n+$/, "");
  }
  return t;
}

// 行安全前缀长度：trimStreamingMarkdown 只截尾部，因此返回长度即原文前缀长度
function streamingSafeLength(text) {
  return trimStreamingMarkdown(text).length;
}

// 裸文本（未转义）行是否是块起始行（标题/列表/引用/表格/围栏/分隔线）
function isRawBlockStartLine(line) {
  return /^(#{1,6}\s|[-*]\s+|\d+\.\s+|>|```|\||---|\*\*\*|___)/.test(
    String(line || "").trimStart()
  );
}

// 把未写完的表格行右侧补空单元格到表头列数，使其可作为合法 Markdown 行渲染
function padTableRow(partialLine, tableMd) {
  const raw = String(partialLine || "").trim();
  const cells = raw
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
  let cols = 0;
  if (tableMd) {
    const head = String(tableMd).split("\n")[0].replace(/^\|/, "").replace(/\|$/, "");
    cols = head.split("|").length;
  }
  while (cells.length < cols) cells.push("");
  return "| " + cells.join(" | ") + " |";
}

// 流式渲染计划：把全文拆成"安全块 + 未完成尾巴"，并决定是否把安全前缀的最后一个
// 同类块（表格/段落）扣留出来与尾巴拼成同一块，避免流式期间出现上下两个分离的框。
// 返回 { blocks, heldOut, tailText }：
//   blocks   — 交给常规 renderMarkdown 的块数组（不含扣留块）
//   heldOut  — 扣留的块（原始文本，可为空）
//   tailText — 安全前缀之后的未完成文本（可为空）
function planStreamingRender(full) {
  const safeLen = streamingSafeLength(full);
  const safe = full.slice(0, safeLen);
  const tailText = full.slice(safeLen);
  const blocks = splitMarkdownBlocks(safe);
  let heldOut = "";
  // 扣留条件：尾巴存在、不含围栏（围栏内容整体走临时渲染）、无空行边界、
  // 且尾巴末行与最后一个安全块同类（表格续行 / 段落续行）
  if (tailText && !tailText.includes("```") && blocks.length && !safe.endsWith("\n")) {
    const lines = tailText.slice(1).split("\n");
    const lastLine = lines[lines.length - 1] || "";
    const lastBlock = blocks[blocks.length - 1];
    const firstLine = lastBlock.split("\n")[0];
    const sameTable = /^\s*\|/.test(lastLine) && /^\s*\|/.test(firstLine);
    const samePara = !isRawBlockStartLine(lastLine) && !isRawBlockStartLine(firstLine);
    if (sameTable || samePara) heldOut = lastBlock;
  }
  return { blocks: heldOut ? blocks.slice(0, -1) : blocks, heldOut, tailText };
}

// 流式期间的"临时成品渲染"：未完成内容直接以最终 Markdown 形态显示，
// 复用 renderMarkdown，保证临时态与完成态结构/样式一致、无跳变。
// tailText：安全前缀之后的未完成文本；heldOut：planStreamingRender 扣留的同类块。
function renderProvisionalTail(tailText, heldOut) {
  const tail = String(tailText || "");
  if (!tail) return "";
  const body = tail.replace(/^\n+/, "");
  const lines = body.split("\n");
  // 未闭合代码块：围栏分支天然支持未闭合，结构与成品代码块一致
  if (lines[0] && /^```/.test(lines[0].trim())) {
    return renderMarkdown(body);
  }
  const partial = lines[lines.length - 1] || "";
  // 未写完的表格行：补齐空单元格到表头列数，与扣留的表格块呈现在同一张表里
  if (/^\s*\|/.test(partial)) {
    return renderMarkdown((heldOut ? heldOut + "\n" : "") + padTableRow(partial, heldOut));
  }
  // 段落续行：与扣留的段落块拼成同一段落（<br> 连接），与成品结构一致
  if (heldOut && !isRawBlockStartLine(partial)) {
    return renderMarkdown(heldOut + "\n" + partial);
  }
  // 刚开始写的标题/列表项/引用行或独立段落行
  return renderMarkdown(partial);
}

// 把 markdown 切成顶层块数组（与 renderMarkdown 的分组规则一致）：
// 段落按空行/块起始行分隔；表格连续 | 行为一块；围栏代码块为一块；标题/列表项/引用行各自为块
function splitMarkdownBlocks(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  const push = (arr) => {
    if (arr.length) blocks.push(arr.join("\n"));
  };
  const isBlockStart = (l) =>
    /^(#{1,6}\s|[-*]\s+|\d+\.\s+|&gt;\s+|\||```|^---|^\*\*\*|^___)/.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    if (line.startsWith("|")) {
      const arr = [lines[i]];
      i++;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        arr.push(lines[i]);
        i++;
      }
      push(arr);
    } else if (line.startsWith("```")) {
      const arr = [lines[i]];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        arr.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        arr.push(lines[i]);
        i++;
      }
      push(arr);
    } else if (/^(#{1,6}\s|[-*]\s+|\d+\.\s+|&gt;\s+|---|\*\*\*|___)/.test(line)) {
      push([lines[i]]);
      i++;
    } else {
      const arr = [lines[i]];
      i++;
      while (i < lines.length) {
        const l = lines[i].trim();
        if (!l || isBlockStart(l)) break;
        arr.push(lines[i]);
        i++;
      }
      push(arr);
    }
  }
  return blocks;
}
