// 单元测试：mock fetch 验证 streamChat 的 SSE 解析（OpenAI 兼容 / Gemini）
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 失败汇总：任一用例打印 FAIL 即让进程以非零码退出（原实现只打印，CI 无法感知失败）
let failedCount = 0;
const rawLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.map((a) => String(a)).join(" ");
  if (line.includes("FAIL")) failedCount++;
  rawLog(...args);
};

const ROOT = path.resolve(__dirname, "..");

// 按 key 取子集：兼容字符串与数组入参，语义同 chrome.storage 各区的 get
function pick(obj, key) {
  if (typeof key === "string") return key in obj ? { [key]: obj[key] } : {};
  const out = {};
  for (const k of key) if (k in obj) out[k] = obj[k];
  return out;
}

function del(obj, key) {
  for (const k of Array.isArray(key) ? key : [key]) delete obj[k];
}

// chrome.storage 替身（local + session），行为与真实 API 一致；areas 可直接断言
function makeStorageMock(seed = {}) {
  const areas = { local: { ...(seed.local || {}) }, session: { ...(seed.session || {}) } };
  const area = (name) => ({
    get: async (k) => pick(areas[name], k),
    set: async (o) => Object.assign(areas[name], o),
    remove: async (k) => del(areas[name], k),
  });
  return { areas, local: area("local"), session: area("session") };
}

const ctx = {
  chrome: {
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
  },
  console,
  Math,
  JSON,
  TextDecoder,
  URL,
  Array,
  Set,
  Promise,
  String,
  Number,
  Error,
  Object,
  Uint8Array,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "common.js"), "utf8"), ctx);

function makeReader(chunks) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i < chunks.length) {
            const v = chunks[i++];
            return { done: false, value: new TextEncoder().encode(v) };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

async function testOpenAI() {
  const sse =
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n' +
    "data: [DONE]\n\n";
  ctx.fetch = async () => ({ ok: true, body: makeReader([sse]) });
  let out = "";
  const gen = ctx.streamChat(
    { type: "openai", baseUrl: "https://api.example.com/v1", apiKey: "k" },
    "gpt-x",
    [{ role: "user", content: "hi" }]
  );
  for await (const c of gen) out += c;
  console.log("OpenAI 解析:", out === "你好，世界" ? "PASS" : "FAIL: " + out);
}

async function testGemini() {
  const sse =
    'data: {"candidates":[{"content":{"parts":[{"text":"总结"}]}}]}\n\n' +
    'data: {"candidates":[{"content":{"parts":[{"text":"结果"}]}}]}\n\n';
  ctx.fetch = async () => ({ ok: true, body: makeReader([sse]) });
  let out = "";
  const gen = ctx.streamChat(
    { type: "gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k" },
    "gemini-2.5-flash",
    [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]
  );
  for await (const c of gen) out += c;
  console.log("Gemini 解析:", out === "总结结果" ? "PASS" : "FAIL: " + out);
}

// Gemini 思考模式：reasoningEffort 映射 generationConfig.thinkingConfig.thinkingBudget
async function testGeminiThinking() {
  let capBody = null;
  ctx.fetch = async (u, o) => {
    capBody = JSON.parse(o.body);
    return { ok: true, body: makeReader(["data: [DONE]\n\n"]) };
  };
  const run = (provider) =>
    Array.fromAsync(
      ctx.streamChat(provider, "gemini-x", [{ role: "user", content: "hi" }], null)
    );
  await run({ type: "gemini", baseUrl: "https://g", apiKey: "k", reasoningEffort: "low" });
  const okLow = !!(
    capBody.generationConfig &&
    capBody.generationConfig.thinkingConfig.thinkingBudget === 1024
  );
  await run({ type: "gemini", baseUrl: "https://g", apiKey: "k", reasoningEffort: "disabled" });
  const okOff = capBody.generationConfig.thinkingConfig.thinkingBudget === 0;
  await run({ type: "gemini", baseUrl: "https://g", apiKey: "k", reasoningEffort: "" });
  const okNone = !capBody.generationConfig;
  console.log(
    "Gemini 思考模式映射:",
    okLow && okOff && okNone ? "PASS" : "FAIL " + JSON.stringify(capBody).slice(0, 160)
  );
}

async function testError() {
  ctx.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: "invalid key" } }),
  });
  try {
    const gen = ctx.streamChat({ type: "openai", baseUrl: "https://a.com/v1", apiKey: "k" }, "m", [{ role: "user", content: "hi" }]);
    for await (const _ of gen) { /* noop */ }
    console.log("错误处理: FAIL 未抛出");
  } catch (e) {
    console.log("错误处理:", e.message.includes("API Key 无效") && e.message.includes("invalid key") ? "PASS" : "FAIL: " + e.message);
  }
}

function testModels() {
  ctx.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: "b-model" }, { id: "a-model" }] }) });
  const list = ctx.fetchModels({ type: "openai", baseUrl: "https://a.com/v1 ", apiKey: "k" });
  list.then((m) =>
    console.log("模型拉取:", m.join(",") === "a-model,b-model" ? "PASS" : "FAIL: " + m.join(","))
  );
}

function testRender() {
  const html = ctx.renderMarkdown("# 标题\n**粗体** 和 `code`\n\n- 要点一\n- 要点二\n\n> 引用");
  const ok =
    html.includes("md-h") && html.includes("md-para") && html.includes("<strong>") &&
    html.includes("<code>") && html.includes("md-li") && html.includes("md-quote");
  console.log("Markdown 渲染:", ok ? "PASS" : "FAIL: " + html);
  const xss = ctx.renderMarkdown("<script>alert(1)</script>");
  console.log("XSS 转义:", xss.includes("&lt;script&gt;") ? "PASS" : "FAIL: " + xss);
}

function testHeadingsAndHr() {
  const html = ctx.renderMarkdown("# 一级\n\n## 二级\n\n---\n\n正文");
  const ok =
    html.includes("md-h md-h1") &&
    html.includes("md-h md-h2") &&
    html.includes("md-hr") &&
    html.includes("一级");
  console.log("标题分级/分割线:", ok ? "PASS" : "FAIL: " + html);
}

function testCodeBlock() {
  const md = "说明文字\n```bash\nyutto <url> [options]\n```\n结尾";
  const html = ctx.renderMarkdown(md);
  const ok =
    html.includes("md-code-wrap") &&
    html.includes("md-code-head") &&
    html.includes("bash") &&
    html.includes("md-pre") &&
    html.includes("<em>1</em>") &&
    html.includes("yutto &lt;url&gt; [options]") &&
    !html.includes("```") &&
    html.includes("说明文字");
  console.log("代码块:", ok ? "PASS" : "FAIL: " + html);
  // 块外的行内代码不受影响
  const inline = ctx.renderMarkdown("用 `cmd` 试试");
  console.log("行内代码仍正常:", inline.includes("<code>cmd</code>") ? "PASS" : "FAIL: " + inline);
}

function testTrimStreaming() {
  const ok1 = ctx.trimStreamingMarkdown("完整一行\n未完成的最后") === "完整一行";
  const ok2 = ctx.trimStreamingMarkdown("前文\n```bash\ncode-line") === "前文";
  const ok3 = ctx.trimStreamingMarkdown("前文\n```bash\ncode\n```\n完") === "前文\n```bash\ncode\n```";
  const ok4 = ctx.trimStreamingMarkdown("没有换行") === "";
  console.log("流式裁剪:", ok1 && ok2 && ok3 && ok4 ? "PASS" : "FAIL");
  const ok5 = ctx.streamingSafeLength("完整一行\n未完成") === "完整一行".length;
  const ok6 = ctx.streamingSafeLength("a\n```bash\ncode") === "a".length;
  const ok7 = ctx.streamingSafeLength("a\nb\n") === 3;
  console.log("流式安全长度:", ok5 && ok6 && ok7 ? "PASS" : "FAIL");
}

function testTruncate() {
  const t = ctx.truncateText("x".repeat(1000), 200);
  const ok =
    t.length < 1000 &&
    t.includes("已省略") &&
    t.startsWith("x".repeat(150)) &&
    ctx.truncateText("short", 100) === "short";
  console.log("长文本截断:", ok ? "PASS" : "FAIL len=" + t.length);
}

function testSplitBlocks() {
  const blocks = ctx.splitMarkdownBlocks(
    "para line1\nline2\n\n## 标题\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- 列表项\n\n```bash\ncmd\n```\n\n结尾"
  );
  const ok =
    blocks.length === 6 &&
    blocks[0] === "para line1\nline2" &&
    blocks[1] === "## 标题" &&
    blocks[2].includes("| a | b |") && blocks[2].includes("| --- | --- |") && blocks[2].includes("| 1 | 2 |") &&
    blocks[3] === "- 列表项" &&
    blocks[4].includes("```bash") &&
    blocks[5] === "结尾";
  console.log("块切分:", ok ? "PASS" : "FAIL " + JSON.stringify(blocks));
}

// extractPageText 表格转换：innerText 的制表符表格行 → Markdown 表格（vm 桩 DOM）
function testExtractTableMarkdown() {
  const sctx = {
    document: {
      title: "测试页面",
      querySelector: () => null,
      body: {
        innerText:
          "姓名\t年龄\t城市\n张三\t30\t北京\n\n这是一段普通介绍文字。\n单列\t行\n尾部内容",
      },
    },
    location: { href: "https://example.com/page" },
    console,
    Math,
    JSON,
    String,
    Number,
    Array,
    Set,
    Error,
    Promise,
  };
  vm.createContext(sctx);
  const r = vm.runInContext(
    "(" + ctx.extractPageText.toString() + ")(60000, false)",
    sctx
  );
  const ok =
    r &&
    r.text.includes("| 姓名 | 年龄 | 城市 |\n| 张三 | 30 | 北京 |") &&
    r.text.includes("| 单列 | 行 |") &&
    r.text.includes("这是一段普通介绍文字。") &&
    r.text.includes("尾部内容");
  console.log(
    "表格转 Markdown:",
    ok ? "PASS" : "FAIL " + JSON.stringify(r && r.text).slice(0, 240)
  );
}

function testTable() {
  const md =
    "| 输入框 | 功能 |\n" +
    "| :--- | :--- |\n" +
    "| 快捷键 | 唤起插件 |\n" +
    "| 图标 | 打开侧边栏 |\n" +
    "\n下一段";
  const html = ctx.renderMarkdown(md);
  const ok =
    html.includes("md-table") &&
    html.includes("<th>输入框</th>") &&
    html.includes("<td>快捷键</td>") &&
    !html.includes(":---") &&
    html.includes("下一段");
  console.log("Markdown 表格:", ok ? "PASS" : "FAIL: " + html);
  // 无分隔线时全部当作数据行
  const noSep = ctx.renderMarkdown("| A | B |\n| 1 | 2 |");
  console.log("Markdown 表格无表头:", noSep.includes("md-table") ? "PASS" : "FAIL: " + noSep);
  // 单元格内注入被转义
  const xss = ctx.renderMarkdown("| A |\n|---|\n| <img src=x> |");
  console.log("Markdown 表格 XSS:", xss.includes("&lt;img") ? "PASS" : "FAIL: " + xss);
}

function testBilibili() {
  const url1 = "https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.999";
  const url2 = "https://www.bilibili.com/video/av12345";
  const url3 = "https://www.bilibili.com/video/other";
  const okUrl = ctx.isBilibiliVideoUrl(url1) && ctx.isBilibiliVideoUrl(url2) && !ctx.isBilibiliVideoUrl(url3);
  console.log("B 站 URL 识别:", okUrl ? "PASS" : "FAIL");

  const md = ctx.buildBilibiliMarkdown({
    title: "测试视频",
    desc: "这是简介",
    owner: "UP主A",
    tname: "动画",
    bvid: "BV1xx411c7mD",
    subtitleNote: "",
    subtitle: [
      { from: 0.4, to: 2.1, content: "开场白" },
      { from: 2.4, to: 4.0, content: "第二句" },
      { from: 60, to: 62, content: "一分钟处" },
    ],
  });
  const okMd =
    md.includes("# 测试视频") &&
    md.includes("UP 主：UP主A") &&
    md.includes("## 简介") &&
    md.includes("[00:00] 开场白第二句") &&
    md.includes("[01:00] 一分钟处");
  console.log("B 站 Markdown:", okMd ? "PASS" : "FAIL:\n" + md);

  const mdNoSub = ctx.buildBilibiliMarkdown({
    title: "无字幕视频",
    desc: "",
    subtitle: [],
    subtitleNote: "未获取到自动字幕",
  });
  console.log("B 站无字幕降级:", mdNoSub.includes("未获取到自动字幕") ? "PASS" : "FAIL");

  const fmt = ctx.formatTime(61.7) === "01:01" && ctx.formatTime(3661) === "1:01:01";
  console.log("时间格式化:", fmt ? "PASS" : "FAIL");
}

// extractBilibili 注入函数端到端：mock 全部接口，w_rid 用 node crypto 独立校验
async function testBilibiliWbi() {
  const crypto = require("node:crypto");
  const calls = [];
  const imgKey = "7cd084941338484aae1ad9425b84077c";
  const subKey = "4932caff0ff74606a649331b8d5c3706";
  const tab = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
  const raw = imgKey + subKey;
  const mixinKey = tab.map((i) => raw[i]).join("").slice(0, 32);
  const sbox = {
    location: { href: "https://www.bilibili.com/video/BV1GJ411x7h7/" },
    Date,
    URL,
    JSON,
    Promise,
    Math,
    String,
    Array,
    Object,
    Error,
    encodeURIComponent,
    console,
    fetch: async (url) => {
      url = String(url);
      calls.push(url);
      const j = (obj) => ({ json: async () => obj });
      if (url.includes("/x/web-interface/view?")) {
        return j({ code: 0, data: { title: "测试视频", desc: "简介", owner: { name: "UP" }, tname: "动画", bvid: "BV1GJ411x7h7", aid: 80433022, cid: 137649199 } });
      }
      if (url.includes("/x/web-interface/nav")) {
        return j({ code: 0, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${imgKey}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${subKey}.png` } } });
      }
      if (url.includes("/x/player/wbi/v2")) {
        const u = new URL(url);
        const params = { aid: 80433022, cid: 137649199, wts: Number(u.searchParams.get("wts")) };
        const q = Object.keys(params).sort()
          .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k]).replace(/[!'()*]/g, "")))
          .join("&");
        const expected = crypto.createHash("md5").update(q + mixinKey).digest("hex");
        if (u.searchParams.get("w_rid") !== expected) return j({ code: -403, message: "签名错误" });
        return j({
          code: 0,
          data: {
            subtitle: {
              subtitles: [
                { lan: "en", subtitle_url: "//aisubtitle.hdslb.com/en.json" },
                { lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/ai.json" },
              ],
            },
          },
        });
      }
      return j({ code: -404, message: "unexpected: " + url });
    },
  };
  vm.createContext(sbox);
  const fn = vm.runInContext("(" + ctx.extractBilibili.toString() + ")", sbox);
  const d = await fn();
  const ok =
    d && !d.error && d.title === "测试视频" &&
    d.subtitleUrl === "https://aisubtitle.hdslb.com/ai.json" && d.subtitleLan === "ai-zh" &&
    calls.some((u) => u.includes("/x/player/wbi/v2")) &&
    !calls.some((u) => u.includes("/x/player/v2?")) && // wbi 成功时不应回退旧接口
    !calls.some((u) => u.includes("aisubtitle")); // 页面内不再下载字幕 JSON
  console.log("B 站 wbi 签名字幕:", ok ? "PASS" : "FAIL " + JSON.stringify(d).slice(0, 200));
}

async function testFetchBilibiliSubtitle() {
  ctx.fetch = async () => ({ ok: true, json: async () => ({ body: [{ from: 1, to: 2, content: "你好" }] }) });
  const ok = await ctx.fetchBilibiliSubtitle("https://x/y.json");
  ctx.fetch = async () => ({ ok: false, status: 403 });
  const forbidden = await ctx.fetchBilibiliSubtitle("https://x/y.json");
  ctx.fetch = async () => ({ ok: true, json: async () => ({ foo: 1 }) });
  const malformed = await ctx.fetchBilibiliSubtitle("https://x/y.json");
  ctx.fetch = async () => ({ ok: true, json: async () => ({ body: [] }) });
  const empty = await ctx.fetchBilibiliSubtitle("https://x/y.json");
  const noUrl = await ctx.fetchBilibiliSubtitle("");
  const pass =
    ok.subtitle.length === 1 && !ok.note &&
    forbidden.note.includes("403") &&
    malformed.note.includes("缺少") &&
    empty.note.includes("为空") &&
    !noUrl.note && noUrl.subtitle.length === 0;
  console.log(
    "B 站字幕扩展下载:",
    pass ? "PASS" : "FAIL " + JSON.stringify({ ok, forbidden, malformed, empty, noUrl }).slice(0, 240)
  );
}

function testProvisionalRender() {
  // 表格：完成行 + 未写完行在同一张表（扣留 + 空单元格补齐）
  const p1 = ctx.planStreamingRender("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3");
  const h1 = ctx.renderProvisionalTail(p1.tailText, p1.heldOut);
  const ok1 =
    p1.heldOut === "| a | b |\n| --- | --- |\n| 1 | 2 |" &&
    p1.blocks.length === 0 &&
    h1.includes("md-table") &&
    h1.includes(">a<") &&
    h1.includes(">1<") &&
    h1.includes(">3<");

  // 段落续行：与上一块合并为同一段落（<br> 连接），与成品一致
  const p2 = ctx.planStreamingRender("第一行\n第二");
  const h2 = ctx.renderProvisionalTail(p2.tailText, p2.heldOut);
  const ok2 = p2.heldOut === "第一行" && h2.includes("第一行<br>第二");

  // 未闭合代码块：整体走临时渲染，结构与成品代码块一致
  const p3 = ctx.planStreamingRender("文字\n\n```bash\nls -la");
  const h3 = ctx.renderProvisionalTail(p3.tailText, p3.heldOut);
  const ok3 =
    p3.heldOut === "" &&
    h3.includes("md-code-wrap") &&
    h3.includes("bash") &&
    h3.includes("ls -la");

  // 新起的列表项：不扣留上一块，单行渲染
  const p4 = ctx.planStreamingRender("- 项一\n- 项");
  const h4 = ctx.renderProvisionalTail(p4.tailText, p4.heldOut);
  const ok4 = p4.heldOut === "" && h4.includes("md-li") && h4.includes("项");

  // 空行边界：空行后的新段落不与上一段合并
  const p5 = ctx.planStreamingRender("第一段\n\n新段");
  const ok5 = p5.heldOut === "" && p5.blocks.length === 1;

  console.log(
    "流式临时渲染:",
    ok1 && ok2 && ok3 && ok4 && ok5 ? "PASS" : "FAIL " + JSON.stringify({ ok1, ok2, ok3, ok4, ok5 })
  );
}

function testProtoWhitelist() {
  const ok = ctx.isAllowedProtocol({ url: "https://example.com" }) &&
    ctx.isAllowedProtocol({ url: "http://example.com" }) &&
    ctx.isAllowedProtocol({ url: "file:///C:/a.html" }) &&
    !ctx.isAllowedProtocol({ url: "chrome://extensions" }) &&
    !ctx.isAllowedProtocol({ url: "about:blank" }) &&
    !ctx.isAllowedProtocol({ url: "chrome-extension://abc" });
  console.log("协议白名单:", ok ? "PASS" : "FAIL");
  const pdf = ctx.isPdfTab({ url: "https://x.com/a.pdf" }) && ctx.isPdfTab({ mimeType: "application/pdf", url: "https://x.com/a" });
  console.log("PDF 识别:", pdf ? "PASS" : "FAIL");
}

// ---------------- Kimi ----------------

// 加载 pow-worker.js：验证 DeepSeekHashV1 官方向量与 PoW 求解
function testPowWorker() {
  const kctx = {
    self: { postMessage() {} },
    console, JSON, Promise, String, Array, Object, Error, Math,
    Uint8Array, Uint32Array, TextEncoder,
  };
  vm.createContext(kctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "pow-worker.js"), "utf8"), kctx);

  const enc = new TextEncoder();
  // 官方向量来自 DeepSeek 官方 WASM（ds2api pow 测试引用）
  const v1 = kctx.dsHashV1Hex(enc.encode(""));
  const v2 = kctx.dsHashV1Hex(enc.encode("testsalt_1700000000_42"));
  const v3 = kctx.dsHashV1Hex(enc.encode("abc123salt_1700000000_12345"));
  const okV =
    v1 === "e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3" &&
    v2 === "d4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09" &&
    v3 === "74b3b7452745b70e85eb32ee7f0a9ec0381d42dd5137b695da915e104fc390e1";
  console.log("PoW 官方哈希向量:", okV ? "PASS" : "FAIL " + v1 + " / " + v2 + " / " + v3);

  // 官方向量对应的求解：challenge = hash("testsalt_1700000000_42")，难度 1000 内必命中 42
  const nonce = kctx.solveChallenge(v2, "testsalt", 1700000000, 1000);
  const miss = kctx.solveChallenge("ff".repeat(32), "testsalt", 1700000000, 50); // 无解场景
  // 分片并行语义：范围含解命中、不含解返回 -1（start/end 与 deepseek.js 派发一致）
  const nonceRange = kctx.solveChallenge(v2, "testsalt", 1700000000, 1000, 40, 60);
  const missRange = kctx.solveChallenge(v2, "testsalt", 1700000000, 1000, 0, 40);
  console.log(
    "PoW 求解:",
    nonce === 42 && miss === -1 && nonceRange === 42 && missRange === -1
      ? "PASS (nonce=42, 无解=-1, 分片命中/脱靶)"
      : "FAIL " + nonce + "/" + miss + "/" + nonceRange + "/" + missRange
  );
}

function testDeepSeekIsReady() {
  const ok = ctx.isReady({
    providers: { deepseek: { type: "deepseek" }, openai: { type: "openai", apiKey: "", defaultModel: "" } },
    activeProvider: "deepseek",
  });
  const no = !ctx.isReady({
    providers: { openai: { type: "openai", apiKey: "", defaultModel: "" } },
    activeProvider: "openai",
  });
  console.log("DeepSeek isReady:", ok && no ? "PASS" : "FAIL");
}

async function testDeepSeekStream() {
  // 未加载 deepseek.js 时应报错
  try {
    const gen = ctx.streamChat({ type: "deepseek" }, "", [{ role: "user", content: "x" }], null);
    for await (const _ of gen) { /* noop */ }
    console.log("DeepSeek 模块未加载: FAIL 未抛出");
  } catch (e) {
    console.log("DeepSeek 模块未加载:", e.message.includes("未加载") ? "PASS" : "FAIL: " + e.message);
  }

  // mock DEEPSEEK：验证消息合并与会话 id 透传
  ctx.window = {
    DEEPSEEK: {
      createSession: async () => "s1",
      sendMessage: async function* (_sessionId, content, _signal) {
        yield content;
        yield "|end";
      },
    },
  };
  let out = "";
  const gen = ctx.streamChat({ type: "deepseek" }, "", [{ role: "system", content: "系统" }, { role: "user", content: "正文" }], null);
  for await (const c of gen) out += c;
  console.log("DeepSeek streamChat:", out === "系统\n\n正文|end" ? "PASS" : "FAIL: " + out);
  delete ctx.window;
}

// PoW Worker 替身：收到任务立即回一个合法 nonce，使 buildStreamHeaders 能走完
class FakeWorker {
  constructor() { this.listeners = {}; }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners[type];
    if (l) this.listeners[type] = l.filter((x) => x !== fn);
  }
  postMessage() {
    for (const fn of this.listeners.message || []) fn({ data: { answer: 1 } });
  }
  terminate() {}
}

// 构造 deepseek.js 的上下文；tokens 为初始会话凭据，freshToken 模拟刷新后 webRequest 捕获的新值
function makeDeepSeekCtx(fetchHandler, { tokens, freshToken } = {}) {
  const storage = makeStorageMock(tokens ? { session: { ds_token: tokens } } : {});
  const dctx = {
    window: {},
    chrome: {
      storage,
      tabs: {
        create: async () => {
          if (freshToken) storage.areas.session.ds_token = freshToken;
          return { id: 1 };
        },
        remove: async () => {},
        onUpdated: {
          addListener: (l) => setTimeout(() => l(1, { status: "complete" }), 0),
          removeListener() {},
        },
      },
      scripting: { executeScript: async () => [{ result: null }] },
      runtime: { getURL: (p) => "chrome-extension://test/" + p },
    },
    console,
    fetch: fetchHandler,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    URL,
    navigator: { hardwareConcurrency: 2 },
    Worker: FakeWorker,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout,
    clearTimeout,
    Promise, JSON, Error, Object, String, Number, Math, Array, Set,
  };
  vm.createContext(dctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "common.js"), "utf8"), dctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "deepseek.js"), "utf8"), dctx);
  return dctx;
}

// DeepSeek 401 回归：首次 401 后刷新 token，重试的 Authorization、PoW 挑战请求
// 以及 finally 中的会话删除都必须使用新 token（旧实现在这三处全部沿用旧 token）
async function testDeepSeekAuthRetry() {
  const calls = [];
  const json = (obj) => ({ status: 200, ok: true, json: async () => obj });
  const challenge = {
    data: {
      biz_data: {
        challenge: {
          algorithm: "DeepSeekHashV1",
          challenge: "ab".repeat(32),
          salt: "salt",
          signature: "sig",
          target_path: "/api/v0/chat/completion",
          expire_at: 1700000000,
          difficulty: 10,
        },
      },
    },
  };
  let completion = 0;
  const d = makeDeepSeekCtx(
    async (url, o) => {
      url = String(url);
      const auth = (o && o.headers && o.headers.Authorization) || "";
      calls.push({ url, auth });
      if (url.includes("hif-")) return { status: 500, ok: false };
      if (url.includes("/api/v0/chat/create_pow_challenge")) return json(challenge);
      if (url.includes("/api/v0/chat/completion")) {
        completion++;
        if (completion === 1) return { status: 401, ok: false, text: async () => "" };
        return {
          status: 200,
          ok: true,
          body: makeReader(['data: {"p":"response/content","v":"你好"}\n']),
        };
      }
      return json({});
    },
    { tokens: "OLD_TOKEN", freshToken: "NEW_TOKEN" }
  );

  let out = "";
  for await (const c of d.window.DEEPSEEK.sendMessage("s1", "正文", null)) out += c;
  await new Promise((r) => setTimeout(r, 20)); // 等 finally 中的删除请求发出

  const comps = calls.filter((c) => c.url.includes("/api/v0/chat/completion"));
  const pows = calls.filter((c) => c.url.includes("create_pow_challenge"));
  const dels = calls.filter((c) => c.url.includes("chat_session/delete"));
  const ok =
    out === "你好" &&
    comps.length === 2 &&
    comps[0].auth === "Bearer OLD_TOKEN" &&
    comps[1].auth === "Bearer NEW_TOKEN" &&
    pows.length === 2 &&
    pows[1].auth === "Bearer NEW_TOKEN" &&
    dels.length === 1 &&
    dels[0].auth === "Bearer NEW_TOKEN";
  console.log(
    "DeepSeek 401 刷新重试:",
    ok
      ? "PASS"
      : "FAIL " +
          JSON.stringify({
            out,
            comps: comps.map((c) => c.auth),
            pows: pows.map((c) => c.auth),
            dels: dels.map((c) => c.auth),
          })
  );
}

function testValidateBaseUrl() {
  const cases = [
    ["https://api.example.com/v1", true],
    ["http://localhost:11434/v1", true],
    ["http://127.0.0.1:8080", true],
    ["http://[::1]:8080/v1", true],
    ["http://api.example.com/v1", false],
    ["ftp://api.example.com", false],
    ["不是 URL", false],
    ["", false],
  ];
  const bad = [];
  for (const [input, want] of cases) {
    let got = false;
    try {
      ctx.validateBaseUrl(input);
      got = true;
    } catch (_) {
      got = false;
    }
    if (got !== want) bad.push({ input, want, got });
  }
  console.log("Base URL 校验:", bad.length ? "FAIL " + JSON.stringify(bad) : "PASS");
}

// 存量非法 Base URL：读取设置时标记 disabled，isReady 视为未配置；合法项不受影响
async function testDisabledLegacyBaseUrl() {
  const storage = makeStorageMock({
    local: {
      settings: {
        activeProvider: "openai",
        providers: {
          openai: { type: "openai", baseUrl: "http://api.example.com/v1", apiKey: "k", defaultModel: "m" },
          gemini: { type: "gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k", defaultModel: "m" },
        },
      },
    },
  });
  const sctx = {
    chrome: { storage },
    console, URL, Promise, JSON, Error, Object, String, Number, Math, Array, Set,
  };
  vm.createContext(sctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "common.js"), "utf8"), sctx);

  const settings = await sctx.getSettings();
  const bad = settings.providers.openai;
  const good = settings.providers.gemini;
  const ok =
    bad.disabled === true &&
    String(bad.disabledReason || "").includes("HTTPS") &&
    sctx.isReady(settings) === false &&
    good.disabled === undefined &&
    sctx.isReady({ ...settings, activeProvider: "gemini" }) === true;
  console.log(
    "存量非法 Base URL 标记:",
    ok
      ? "PASS"
      : "FAIL " +
          JSON.stringify({
            badDisabled: bad.disabled,
            reason: bad.disabledReason,
            goodDisabled: good.disabled,
          })
  );
}

// API Key 存储策略：关闭"记住"时不落盘、只进 session，读取时还原；重新开启后回到 local 并清会话副本
async function testApiKeyStoragePolicy() {
  const storage = makeStorageMock();
  const sctx = {
    chrome: { storage },
    console, URL, Promise, JSON, Error, Object, String, Number, Math, Array, Set,
  };
  vm.createContext(sctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "common.js"), "utf8"), sctx);

  const base = {
    activeProvider: "openai",
    providers: {
      openai: {
        type: "openai",
        baseUrl: "https://api.example.com/v1",
        apiKey: "SK-SECRET",
        defaultModel: "m",
      },
      gemini: {
        type: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "",
        defaultModel: "",
      },
    },
  };

  // 关闭"记住"：Key 不落盘（local 中不留明文），只写 session
  await sctx.saveSettings({ ...base, rememberApiKeys: false });
  const storedOff = storage.areas.local.settings;
  const sessionKeys = storage.areas.session.api_keys;
  const offOk =
    storedOff.providers.openai.apiKey === "" &&
    !JSON.stringify(storedOff).includes("SK-SECRET") &&
    sessionKeys &&
    sessionKeys.openai === "SK-SECRET";

  // 读取时从 session 还原，调用方无需感知
  const back = await sctx.getSettings();
  const hydrateOk = back.providers.openai.apiKey === "SK-SECRET";

  // 重新开启"记住"：Key 回到 local，会话副本清除
  await sctx.saveSettings({ ...base, rememberApiKeys: true });
  const storedOn = storage.areas.local.settings;
  const onOk =
    storedOn.providers.openai.apiKey === "SK-SECRET" &&
    storage.areas.session.api_keys === undefined;

  const ok = offOk && hydrateOk && onOk;
  console.log(
    "API Key 存储策略:",
    ok
      ? "PASS"
      : "FAIL " +
          JSON.stringify({
            offApiKey: storedOff.providers.openai.apiKey,
            sessionKeys,
            hydrate: back.providers.openai.apiKey,
            onApiKey: storedOn.providers.openai.apiKey,
            sessionAfterOn: storage.areas.session.api_keys,
          })
  );
}

// 凭据迁移：旧版本存在 storage.local 的 ds_token 在首次读取时搬到 session 并删除旧字段
async function testSecretMigration() {
  const storage = makeStorageMock({ local: { ds_token: "LEGACY" } });
  const sctx = {
    chrome: { storage },
    console, URL, Promise, JSON, Error, Object, String, Number, Math, Array, Set,
  };
  vm.createContext(sctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "common.js"), "utf8"), sctx);

  // secretStore 是 const 声明，只存在于脚本全局词法环境，须从上下文内部取引用
  const store = vm.runInContext("secretStore", sctx);
  const v1 = await store.get("ds_token");
  const v2 = await store.get("ds_token"); // 第二次应直接命中 session
  const ok =
    v1 === "LEGACY" &&
    v2 === "LEGACY" &&
    storage.areas.session.ds_token === "LEGACY" &&
    !("ds_token" in storage.areas.local);
  console.log("凭据迁移 local→session:", ok ? "PASS" : "FAIL " + JSON.stringify(storage.areas));
}

function testKimiIsReady() {
  const ok = ctx.isReady({
    providers: { kimi: { type: "kimi" } },
    activeProvider: "kimi",
  });
  console.log("Kimi isReady:", ok ? "PASS" : "FAIL");
}

// 构造 kimi.js 的 vm 上下文：mock chrome/storage，fetch 由传入的 handler 决定
// （kimi.js 通过 common.js 的 secretStore 读写凭据，故两个脚本都要加载）
function makeKimiCtx(fetchHandler) {
  const kctx = {
    window: {},
    chrome: {
      storage: makeStorageMock({
        session: { kimi_tokens: { accessToken: "acc", refreshToken: "ref" } },
      }),
      tabs: {
        create: async () => ({ id: 1 }),
        remove: async () => {},
        onUpdated: { addListener() {}, removeListener() {} },
      },
      scripting: { executeScript: async () => [{ result: null }] },
    },
    console,
    fetch: fetchHandler,
    TextDecoder,
    URL,
    Promise,
    JSON,
    Error,
    Object,
    String,
    Number,
    Math,
    Array,
    Set,
  };
  vm.createContext(kctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "common.js"), "utf8"), kctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "kimi.js"), "utf8"), kctx);
  return kctx;
}

async function testKimiStream() {
  // 未加载 kimi.js 时 streamChat 应报错
  try {
    const gen = ctx.streamChat({ type: "kimi" }, "", [{ role: "user", content: "x" }], null);
    for await (const _ of gen) { /* noop */ }
    console.log("Kimi 模块未加载: FAIL 未抛出");
  } catch (e) {
    console.log("Kimi 模块未加载:", e.message.includes("未加载") ? "PASS" : "FAIL: " + e.message);
  }

  // mock KIMI：验证消息合并与会话 id 透传（common.js 分支）
  ctx.window = {
    KIMI: {
      createSession: async () => "c1",
      sendMessage: async function* (_sessionId, content, _signal) {
        yield content;
        yield "|end";
      },
    },
  };
  let out = "";
  const gen = ctx.streamChat(
    { type: "kimi" },
    "",
    [{ role: "system", content: "系统" }, { role: "user", content: "正文" }],
    null
  );
  for await (const c of gen) out += c;
  console.log("Kimi streamChat:", out === "系统\n\n正文|end" ? "PASS" : "FAIL: " + out);
  delete ctx.window;

  // kimi.js SSE 解析：cmpl 增量拼接 + all_done 结束 + 注释行忽略 + event: 行回退
  const sse =
    ": keep-alive\n\n" +
    'data: {"event":"cmpl","text":"你好"}\n\n' +
    'data: {"event":"cmpl","text":"，世界"}\n\n' +
    "event:all_done\n" +
    'data: {"event":"all_done"}\n\n';
  const k1 = makeKimiCtx(async () => ({
    status: 200,
    ok: true,
    body: makeReader([sse]),
  }));
  let out2 = "";
  for await (const c of k1.window.KIMI.sendMessage("c1", "hi", null)) out2 += c;
  console.log("Kimi SSE 解析:", out2 === "你好，世界" ? "PASS" : "FAIL: " + out2);

  // error 事件应抛出
  const k2 = makeKimiCtx(async () => ({
    status: 200,
    ok: true,
    body: makeReader(['data: {"event":"error","error":{"message":"限流了"}}\n\n']),
  }));
  try {
    for await (const _ of k2.window.KIMI.sendMessage("c1", "hi", null)) { /* noop */ }
    console.log("Kimi SSE 错误事件: FAIL 未抛出");
  } catch (e) {
    console.log("Kimi SSE 错误事件:", e.message.includes("限流") ? "PASS" : "FAIL: " + e.message);
  }
}

async function testKimiUploadAndRefs() {
  const calls = [];
  const json = (obj) => ({ status: 200, ok: true, json: async () => obj });
  const sse = (chunks) => ({ status: 200, ok: true, body: makeReader(chunks) });
  const k = makeKimiCtx(async (url, o) => {
    url = String(url);
    calls.push({ url, body: o && o.body });
    if (url.includes("/api/pre-sign-url")) {
      return json({ url: "https://tos.example/presigned", object_name: "obj1" });
    }
    if (url.startsWith("https://tos.example/")) return { status: 200, ok: true };
    if (url.includes("/api/file/parse_process")) {
      return sse(['data: {"status":"parsing"}\n\n', 'data: {"status":"parsed"}\n\n']);
    }
    if (url.includes("/api/file")) return json({ id: "f1" });
    if (url.includes("completion/stream")) {
      return sse(['data: {"event":"cmpl","text":"ok"}\n\n', 'data: {"event":"all_done"}\n\n']);
    }
    return json({});
  });
  const fakeFile = { name: "页面.html" };
  const fid = await k.window.KIMI.uploadFile(fakeFile, null);
  const st = await k.window.KIMI.waitFileParsed(fid, null);
  let out = "";
  for await (const c of k.window.KIMI.sendMessage("c1", "hi", null, fid)) out += c;
  const comp = calls.find((c) => c.url.includes("completion/stream"));
  const refs = comp && typeof comp.body === "string" ? JSON.parse(comp.body).refs : null;
  const ok =
    fid === "f1" && st === "parsed" && out === "ok" && Array.isArray(refs) && refs[0] === "f1";
  console.log("Kimi 文件上传/解析/引用:", ok ? "PASS" : "FAIL");
}

(async () => {
  await testOpenAI();
  await testGemini();
  await testGeminiThinking();
  await testError();
  testModels();
  testRender();
  testHeadingsAndHr();
  testCodeBlock();
  testTrimStreaming();
  testSplitBlocks();
  testProvisionalRender();
  testTruncate();
  testExtractTableMarkdown();
  testTable();
  testBilibili();
  await testBilibiliWbi();
  await testFetchBilibiliSubtitle();
  testProtoWhitelist();
  testPowWorker();
  testDeepSeekIsReady();
  await testDeepSeekStream();
  testKimiIsReady();
  await testKimiStream();
  await testKimiUploadAndRefs();
  // Phase 1（正确性与安全）新增回归
  testValidateBaseUrl();
  await testDisabledLegacyBaseUrl();
  await testSecretMigration();
  await testApiKeyStoragePolicy();
  await testDeepSeekAuthRetry();

  // 任一 FAIL → 非零退出码，CI 依据退出码判定
  if (failedCount) {
    rawLog(`\n${failedCount} 项失败`);
    process.exitCode = 1;
  } else {
    rawLog("\n全部通过");
  }
})().catch((e) => {
  // 用例抛异常同样视为失败，避免异常被吞掉后仍以 0 退出
  rawLog("用例异常中止:", e);
  process.exitCode = 1;
});
