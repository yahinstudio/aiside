// deepseek.js —— DeepSeek 账号模式（复用 chat.deepseek.com 登录态，无需 API Key）
// 无隐藏刷新接口：userToken 长效，隐藏标签页读取一次即可；正文以内联文本发送（不上传文件）。
// 对话请求需通过 PoW 挑战（DeepSeekHashV1，pow-worker.js 求解）；会话用完即删。

window.DEEPSEEK = (() => {
  const BASE = "https://chat.deepseek.com";
  const COMPLETION_PATH = "/api/v0/chat/completion";
  const CLIENT_HEADERS = {
    "x-client-platform": "web",
    "x-client-version": "2.0.0",
    "x-app-version": "20241129.1",
    "x-client-locale": "zh_CN",
    "x-client-timezone-offset": "28800",
  };

  // ---------------- token ----------------

  async function getToken() {
    const { ds_token } = await chrome.storage.local.get("ds_token");
    return ds_token || null;
  }

  async function saveToken(token) {
    await chrome.storage.local.set({ ds_token: token });
  }

  function waitTabComplete(tabId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("等待 chat.deepseek.com 页面加载超时"));
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

  async function readTokenFromTab(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: async () => {
        // 1) 同源 API 优先：带 cookie 请求，服务端返回当前登录会话的最新 token（最可靠）
        try {
          const res = await fetch("/api/v0/users/current", {
            method: "GET",
            headers: { Accept: "application/json" },
          });
          if (res.ok) {
            const json = await res.json();
            const t =
              json &&
              json.data &&
              json.data.biz_data &&
              json.data.biz_data.token;
            if (typeof t === "string" && t) return t;
          }
        } catch (_) { /* 忽略 */ }
        // 2) cookie 扫描
        try {
          const names = ["userToken", "user_token", "__ds_token", "ds_token", "Authorization"];
          for (const part of document.cookie.split(";")) {
            const eq = part.indexOf("=");
            if (eq === -1) continue;
            const key = part.slice(0, eq).trim();
            if (names.includes(key)) {
              const v = part.slice(eq + 1).trim();
              if (v) return decodeURIComponent(v);
            }
          }
        } catch (_) { /* 忽略 */ }
        // 3) localStorage 兜底（历史版本；注意其中可能残留旧 token，优先级最低）
        try {
          const v = localStorage.getItem("userToken");
          if (v) return v;
        } catch (_) { /* 忽略 */ }
        return null;
      },
    });
    const v = results && results[0] && results[0].result;
    return typeof v === "string" && v ? v : null;
  }

  async function fetchFreshToken() {
    const before = await getToken();
    const tab = await chrome.tabs.create({ url: `${BASE}/`, active: false });
    try {
      await waitTabComplete(tab.id, 15000);
      // 等页面启动时的 API 请求发出，webRequest 已捕获最新授权头
      await new Promise((r) => setTimeout(r, 800));
      const captured = await getToken();
      if (captured && captured !== before) {
        return captured;
      }
      const token = await readTokenFromTab(tab.id);
      if (!token) {
        throw new Error("未在 chat.deepseek.com 检测到登录态，请先在 Chrome 打开并登录 DeepSeek");
      }
      await saveToken(token);
      return token;
    } finally {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }

  async function ensureToken() {
    const token = await getToken();
    if (token) return token;
    return fetchFreshToken();
  }

  // ---------------- 请求封装 ----------------

  // 业务码 40001/40002/40003 = token 失效（HTTP 200 但 data 为 null）
  function isInvalidTokenEnvelope(data) {
    const bad = (c) => c === 40001 || c === 40002 || c === 40003;
    if (data && bad(data.code)) return true;
    if (data && data.data) {
      const inner = data.data;
      if (inner && bad(inner.code)) return true;
    }
    return false;
  }

  async function apiJSON(token, path, { method = "POST", body } = {}) {
    let attemptToken = token;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch(BASE + path, {
          method,
          headers: {
            ...CLIENT_HEADERS,
            "Content-Type": "application/json",
            Authorization: `Bearer ${attemptToken}`,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        // fetch 在网络/CORS/拦截层面拒绝时统一给出带 URL 的诊断
        throw new Error(
          "DeepSeek 网络请求失败（" + BASE + path + "）：" + ((e && e.message) || e)
        );
      }
      const badHttp = !res.ok && (res.status === 401 || res.status === 403);
      let data = null;
      if (res.ok) {
        data = await res.json().catch(() => ({}));
      } else if (!badHttp) {
        const text = await res.text().catch(() => "");
        throw new Error(`DeepSeek 接口请求失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
      }
      // token 有效则直接返回
      if (res.ok && !isInvalidTokenEnvelope(data)) return data;
      // 401/403 或 40001/2/3：重取最新 token 后重试一次
      if (attempt === 0) {
        attemptToken = await fetchFreshToken();
        if (!attemptToken) {
          throw new Error("未在 chat.deepseek.com 检测到登录态，请先在 Chrome 打开并登录 DeepSeek");
        }
        continue;
      }
      throw new Error("DeepSeek 登录已过期，请重新登录 chat.deepseek.com");
    }
    throw new Error("DeepSeek 登录已过期，请重新登录 chat.deepseek.com");
  }

  // hif 令牌：网页客户端会附带，缺失时不影响（尽力获取）
  async function fetchHifToken(url) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) return null;
      const json = await res.json();
      return (json && json.data && json.data.biz_data && json.data.biz_data.value) || null;
    } catch (_) {
      return null;
    }
  }

  // ---------------- PoW（Worker 池并行求解） ----------------

  // 池化复用：nonce 空间按核心数切片并行派发，任一 Worker 命中即结束
  let workerPool = null;
  function getWorkerPool() {
    if (!workerPool) {
      const n = Math.min(navigator.hardwareConcurrency || 4, 4);
      const pool = [];
      for (let i = 0; i < n; i++) {
        try {
          pool.push(new Worker(chrome.runtime.getURL("pow-worker.js")));
        } catch (e) {
          console.warn("[AiSIDE] PoW Worker 创建失败:", e);
        }
      }
      workerPool = pool.length ? pool : null;
    }
    return workerPool || [];
  }

  // 并行求解：把 [0, difficulty) 均分切片；任一命中立即 resolve，
  // 并 terminate 全部 Worker（避免空转烧 CPU），下次调用重建池
  function solvePoW(ch, signal) {
    const workers = getWorkerPool();
    if (!workers.length) {
      return Promise.reject(new Error("PoW 求解失败：无法创建 Worker"));
    }
    const difficulty = ch.difficulty || 144000;
    const slice = Math.ceil(difficulty / workers.length);
    return new Promise((resolve, reject) => {
      let settled = false;
      let finished = 0;
      const stop = () => {
        for (const w of workers) {
          w.removeEventListener("message", onMsg);
          w.removeEventListener("error", onErr);
          w.terminate();
        }
        workerPool = null;
      };
      const onMsg = (e) => {
        if (settled) return;
        const d = e.data || {};
        if (!d.error && d.answer >= 0) {
          settled = true;
          stop();
          resolve(d.answer);
          return;
        }
        finished++;
        if (finished >= workers.length) {
          settled = true;
          stop();
          reject(new Error("PoW 求解失败：无解"));
        }
      };
      const onErr = (e) => {
        if (settled) return;
        settled = true;
        stop();
        reject(new Error("PoW 求解失败：" + ((e && e.message) || "Worker 异常")));
      };
      workers.forEach((w, i) => {
        w.addEventListener("message", onMsg);
        w.addEventListener("error", onErr);
        w.postMessage({
          challengeHex: ch.challenge,
          salt: ch.salt,
          expireAt: ch.expire_at,
          difficulty,
          start: i * slice,
          end: Math.min((i + 1) * slice, difficulty),
        });
      });
      // 外部中断（用户取消总结 / 切换任务）
      if (signal) {
        const abort = () => {
          if (settled) return;
          settled = true;
          stop();
          const err = new Error("请求已中断");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
    });
  }

  // 获取挑战 → 求解 → 组装 x-ds-pow-response（与 hif 令牌并行）
  async function buildStreamHeaders(token, signal) {
    const challengeRes = await apiJSON(token, "/api/v0/chat/create_pow_challenge", {
      body: { target_path: COMPLETION_PATH },
    });
    const ch = challengeRes.data.biz_data.challenge;
    const [hifLeim, hifDliq] = await Promise.all([
      fetchHifToken("https://hif-leim.deepseek.com/query"),
      fetchHifToken("https://hif-dliq.deepseek.com/query"),
    ]);
    const answer = await solvePoW(ch, signal);
    const payload = JSON.stringify({
      algorithm: ch.algorithm,
      challenge: ch.challenge,
      salt: ch.salt,
      answer,
      signature: ch.signature,
      target_path: ch.target_path,
    });
    const headers = { "x-ds-pow-response": btoa(payload) };
    if (hifLeim) headers["x-hif-leim"] = hifLeim;
    if (hifDliq) headers["x-hif-dliq"] = hifDliq;
    return headers;
  }

  // ---------------- 会话与流式 ----------------

  async function createSession() {
    const token = await ensureToken();
    const res = await apiJSON(token, "/api/v0/chat_session/create", { body: {} });
    const raw = res && res.data;
    const biz = raw && raw.biz_data;
    // 兼容多种返回形态：对象 {id} / 字符串 id / chat_session_id 字段（含 biz_data 顶层）
    const cs = (biz && biz.chat_session) || (raw && raw.chat_session) || null;
    let id = null;
    if (typeof cs === "string") {
      id = cs;
    } else if (cs && typeof cs === "object") {
      id = cs.id || cs.chat_session_id || cs.session_id;
    }
    if (!id && biz) id = biz.chat_session_id || biz.session_id || biz.id;
    if (!id) {
      // 应用层拒绝（HTTP 200 + data null）时，原因一般在顶层 code/msg 里
      const detail =
        (res && typeof res.message === "string" && res.message) ||
        (res && typeof res.msg === "string" && res.msg) ||
        (res && typeof res.code !== "undefined" && "code=" + res.code) ||
        (raw && typeof raw.message === "string" && raw.message) ||
        JSON.stringify(res === undefined ? raw : res).slice(0, 200);
      throw new Error("DeepSeek 创建会话失败（响应缺少 id）：" + detail);
    }
    return id;
  }

  // 从 JSON-Patch 流提取正文增量（当前网页版格式）：
  // { p:"response/fragments", o:"APPEND", v:[完整片段] } / { p:"response/content", v:"文本" } /
  // 初始快照 { v:{ response:{ fragments:[...] } } } / 批量补丁 { v:[{p,o,v}...] } / 裸字符串增量
  function* extractDeltas(parsed) {
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.error) {
      throw new Error((parsed.error && parsed.error.message) || "DeepSeek 对话出错");
    }
    const path = typeof parsed.p === "string" ? parsed.p : "";
    const op = typeof parsed.o === "string" ? parsed.o.toUpperCase() : "";
    const val = parsed.v;
    // 过滤噪音路径（前后缀状态/用量等）
    if (
      path &&
      /quasi_status|elapsed_secs|token_usage|pending_fragment|conversation_mode|search_status|fragments\/-\d+\/status/.test(path)
    ) {
      return;
    }
    const yieldFrag = function* (frag) {
      if (frag && typeof frag === "object") {
        const t = String(frag.type || "RESPONSE").toUpperCase();
        if (t !== "THINK" && t !== "THINKING" && typeof frag.content === "string" && frag.content) {
          yield frag.content;
        }
      }
    };
    // 初始快照：{ v: { response: { fragments: [...] } } }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const resp = val.response && typeof val.response === "object" ? val.response : val;
      if (resp && Array.isArray(resp.fragments)) {
        for (const frag of resp.fragments) yield* yieldFrag(frag);
        return;
      }
    }
    // 数组
    if (Array.isArray(val)) {
      // { p:"response/fragments", o:"APPEND", v:[完整片段...] }
      if (path === "response/fragments" && op === "APPEND") {
        for (const frag of val) yield* yieldFrag(frag);
        return;
      }
      // 批量补丁：{ v:[{p,o,v}...] } 或 { p:"response", v:[...] }
      for (const sub of val) {
        if (sub && typeof sub === "object") yield* extractDeltas(sub);
      }
      return;
    }
    // 字符串值
    if (typeof val === "string" && val) {
      // 裸字符串 = 正文增量；内容类路径同样直接输出（首消息场景无历史去重需求）
      if (!path) {
        yield val;
        return;
      }
      if (path === "response/content" || path.endsWith("/content")) {
        yield val;
        return;
      }
      // status 等其他路径（如 "FINISHED"）：忽略
      return;
    }
  }

  // SSE 流式对话：yield 正文文本增量
  async function* sendMessage(sessionId, content, signal) {
    const token = await ensureToken();
    let res = null;
    // 401 时换新 token 重试一次（PoW 头与 token 绑定，需重新求解）
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      const headers = await buildStreamHeaders(token, signal);
      const tryRes = await fetch(BASE + COMPLETION_PATH, {
        method: "POST",
        headers: {
          ...CLIENT_HEADERS,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...headers,
        },
        body: JSON.stringify({
          chat_session_id: sessionId,
          parent_message_id: null,
          model_type: null,
          prompt: content,
          ref_file_ids: [],
          thinking_enabled: false,
          search_enabled: false,
          preempt: false,
        }),
        signal,
      });
      if (tryRes.status === 401 && attempt === 0) {
        await fetchFreshToken();
        continue;
      }
      if (!tryRes.ok) {
        const text = await tryRes.text().catch(() => "");
        if (tryRes.status === 401) {
          throw new Error("DeepSeek 登录已过期，请重新登录 chat.deepseek.com");
        }
        throw new Error(`DeepSeek 接口请求失败（HTTP ${tryRes.status}）：${text.slice(0, 200)}`);
      }
      res = tryRes;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (_) {
            continue;
          }
          yield* extractDeltas(parsed);
        }
      }
    } finally {
      // 会话用完即删，避免留在 DeepSeek 历史记录
      apiJSON(token, "/api/v0/chat_session/delete", {
        body: { chat_session_id: sessionId },
      }).catch(() => {});
    }
  }

  return { getToken, ensureToken, createSession, sendMessage };
})();
