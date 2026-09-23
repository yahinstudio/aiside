// kimi.js —— Kimi 网页版账号模式（复用 www.kimi.com 登录态，无需 API Key）
// 协议对齐 Kimi Copilot 扩展的网页客户端用法：
//   refresh_token 存于 www.kimi.com 页面 localStorage（隐藏标签页读取一次）；
//   GET /api/auth/token/refresh（Bearer refresh_token）换取 access_token/refresh_token 对；
//   POST /api/chat 建会话 → POST /api/chat/{id}/completion/stream 流式对话。
//   文件模式：POST /api/pre-sign-url 取对象存储直传地址 → PUT 上传 → POST /api/file 注册 →
//   POST /api/file/parse_process 等待解析完成，会话消息用 refs:[文件id] 引用。
// 无已知会话删除端点，总结会话会保留在 Kimi 历史记录（命名为"AiSIDE 网页总结"）。

window.KIMI = (() => {
  const BASE = "https://www.kimi.com";

  // ---------------- token ----------------

  async function getToken() {
    const { kimi_tokens } = await chrome.storage.local.get("kimi_tokens");
    return kimi_tokens || null;
  }

  async function saveTokens(tokens) {
    await chrome.storage.local.set({ kimi_tokens: tokens });
  }

  function waitTabComplete(tabId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("等待 www.kimi.com 页面加载超时"));
      }, timeoutMs);
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // 从 kimi.com 页面读 localStorage.refresh_token（登录后由网页写入）
  async function readTokenFromTab(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          return localStorage.getItem("refresh_token");
        } catch (_) {
          return null;
        }
      },
    });
    const v = results && results[0] && results[0].result;
    return typeof v === "string" && v ? v : null;
  }

  async function fetchFreshToken() {
    const tab = await chrome.tabs.create({ url: `${BASE}/`, active: false });
    try {
      await waitTabComplete(tab.id, 15000);
      const token = await readTokenFromTab(tab.id);
      if (!token) {
        throw new Error("未在 www.kimi.com 检测到登录态，请先在 Chrome 打开并登录 Kimi");
      }
      const tokens = { refreshToken: token };
      await saveTokens(tokens);
      return tokens;
    } finally {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }

  // 用 refresh_token 换取新的 token 对；无 refresh_token 时先走隐藏标签页读取
  async function ensureTokens() {
    let tokens = await getToken();
    if (!tokens || !tokens.refreshToken) tokens = await fetchFreshToken();
    if (!tokens.accessToken) return refreshAccessToken(tokens.refreshToken);
    return tokens;
  }

  async function refreshAccessToken(refreshToken) {
    if (!refreshToken) {
      throw new Error("未在 www.kimi.com 检测到登录态，请先在 Chrome 打开并登录 Kimi");
    }
    let res;
    try {
      res = await fetch(`${BASE}/api/auth/token/refresh`, {
        headers: { Authorization: `Bearer ${refreshToken}`, Referer: `${BASE}/` },
      });
    } catch (e) {
      throw new Error(
        "Kimi 网络请求失败（" + BASE + "/api/auth/token/refresh）：" + ((e && e.message) || e)
      );
    }
    if (!res.ok) {
      throw new Error(`Kimi 登录已过期（HTTP ${res.status}），请打开 www.kimi.com 重新登录`);
    }
    const data = await res.json().catch(() => ({}));
    if (!data.access_token || !data.refresh_token) {
      throw new Error("Kimi 登录已过期，请打开 www.kimi.com 重新登录");
    }
    const tokens = { accessToken: data.access_token, refreshToken: data.refresh_token };
    await saveTokens(tokens);
    return tokens;
  }

  // ---------------- 请求封装 ----------------

  async function apiJSON(tokens, path, { method = "POST", body } = {}) {
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokens.accessToken}`,
          Referer: `${BASE}/`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error("Kimi 网络请求失败（" + BASE + path + "）：" + ((e && e.message) || e));
    }
    if (res.status === 401) {
      // access_token 过期：刷新后由调用方重试
      const err = new Error("Kimi 登录已过期");
      err.name = "TokenExpired";
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kimi 接口请求失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    return res.json().catch(() => ({}));
  }

  // apiJSON 的 401 自动重试封装：token 过期时刷新一次后重发
  async function apiCall(tokens, path, opts) {
    try {
      return await apiJSON(tokens, path, opts);
    } catch (e) {
      if (e.name !== "TokenExpired") throw e;
      const fresh = await refreshAccessToken(tokens.refreshToken);
      return apiJSON(fresh, path, opts);
    }
  }

  // ---------------- 会话与流式 ----------------

  async function createSession() {
    const tokens = await ensureTokens();
    const data = await apiCall(tokens, "/api/chat", {
      body: { is_example: false, name: "AiSIDE 网页总结" },
    });
    if (!data || !data.id) {
      throw new Error(
        "Kimi 创建会话失败（响应缺少 id）：" + JSON.stringify(data || null).slice(0, 200)
      );
    }
    return data.id;
  }

  // 上传文件（对齐 Kimi Copilot：预签名直传 + 注册），返回文件 id
  // file: File/Blob（需带 name，如 new File([html], "page.html", {type:"text/html"})）
  async function uploadFile(file, signal) {
    const tokens = await ensureTokens();
    const pre = await apiCall(tokens, "/api/pre-sign-url", {
      body: { action: "file", name: file.name },
      signal,
    });
    if (!pre || !pre.url || !pre.object_name) {
      throw new Error(
        "Kimi 获取上传地址失败：" + JSON.stringify(pre || null).slice(0, 200)
      );
    }
    const put = await fetch(pre.url, { method: "PUT", body: file, signal });
    if (!put.ok) {
      throw new Error(`Kimi 文件上传失败（HTTP ${put.status}）`);
    }
    const reg = await apiCall(tokens, "/api/file", {
      body: { type: "file", name: file.name, object_name: pre.object_name },
      signal,
    });
    if (!reg || !reg.id) {
      throw new Error(
        "Kimi 文件注册失败（响应缺少 id）：" + JSON.stringify(reg || null).slice(0, 200)
      );
    }
    return reg.id;
  }

  // 等待文件解析完成：流式返回 {status:"parsing"}…，状态变化（如 "parsed"）时返回该状态
  async function waitFileParsed(fileId, signal) {
    const tokens = await ensureTokens();
    const deadline = Date.now() + 180000; // 解析最长等 3 分钟
    const doPost = (t) =>
      fetch(`${BASE}/api/file/parse_process`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t.accessToken}`,
          Referer: `${BASE}/`,
        },
        body: JSON.stringify({ ids: [fileId] }),
        signal,
      });
    let res = await doPost(tokens);
    if (res.status === 401) {
      res = await doPost(await refreshAccessToken(tokens.refreshToken));
    }
    if (!res.ok) {
      throw new Error(`Kimi 文件解析接口请求失败（HTTP ${res.status}）`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      if (Date.now() > deadline) throw new Error("Kimi 文件解析超时，请重试或改用其他 API");
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "").trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let obj;
        try {
          obj = JSON.parse(data);
        } catch (_) {
          continue;
        }
        if (obj && obj.status && obj.status !== "parsing") return obj.status;
      }
    }
    throw new Error("Kimi 文件解析未完成（响应流提前结束）");
  }

  // SSE 流式对话：yield 正文文本增量；fileId 传入时以 refs 引用已上传的附件
  // data JSON 形如 {event:"cmpl", text:"增量"} / {event:"error", error:{message}} / {event:"all_done"}
  async function* sendMessage(sessionId, content, signal, fileId) {
    const tokens = await ensureTokens();
    const url = `${BASE}/api/chat/${sessionId}/completion/stream`;
    const doPost = (t) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t.accessToken}`,
          Referer: `${BASE}/`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content }],
          refs: fileId ? [fileId] : [],
          use_search: false,
        }),
        signal,
      });
    let res = await doPost(tokens);
    if (res.status === 401) {
      const fresh = await refreshAccessToken(tokens.refreshToken);
      res = await doPost(fresh);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kimi 接口请求失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sseEvent = ""; // data JSON 未带 event 字段时回退用 SSE 的 event: 行
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line) {
            sseEvent = ""; // 空行 = 事件边界
            continue;
          }
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) {
            sseEvent = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          let obj;
          try {
            obj = JSON.parse(data);
          } catch (_) {
            continue;
          }
          const ev = (obj && obj.event) || sseEvent;
          if (ev === "cmpl") {
            if (obj && typeof obj.text === "string" && obj.text) yield obj.text;
          } else if (ev === "error") {
            throw new Error((obj.error && obj.error.message) || "Kimi 对话出错");
          } else if (ev === "all_done") {
            return;
          }
        }
      }
    } finally {
      // 连接结束后清空缓冲（无会话删除端点，会话保留在 Kimi 历史）
      buf = "";
    }
  }

  return { getToken, ensureTokens, createSession, uploadFile, waitFileParsed, sendMessage };
})();
