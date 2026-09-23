// AiSIDE 设置页：配置 AI 服务、拉取/测试模型、字体大小、快捷键说明

// 需填接口信息的 provider；DeepSeek / Kimi 账号模式只需登录态，单独处理
const API_KEYS = ["openai", "gemini"];
const PROVIDER_KEYS = ["deepseek", "kimi", ...API_KEYS];

const $ = (id) => document.getElementById(id);

let toastTimer = null;

function showToast(msg) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
}

// 从表单收集一个 provider 配置
function gatherProvider(key) {
  if (key === "deepseek") return { type: "deepseek" };
  if (key === "kimi") return { type: "kimi" };
  const effortEl = $(`${key}-reasoning-effort`);
  return {
    type: key,
    baseUrl: $(`${key}-base-url`).value.trim(),
    apiKey: $(`${key}-api-key`).value.trim(),
    defaultModel: $(`${key}-model`).value.trim(),
    // 思考模式（OpenAI 兼容/Gemini 各自的下拉；Gemini 映射为 thinkingBudget）
    reasoningEffort: effortEl ? effortEl.value : "",
  };
}

// 由两级选择推导实际使用的 provider（存储值仍是 deepseek/kimi/openai/gemini 四种）
function getSelectedProvider() {
  const mode = document.querySelector('input[name="api-mode"]:checked');
  if (!mode || mode.value === "web") {
    const r = document.querySelector('input[name="web-provider"]:checked');
    return r ? r.value : "deepseek";
  }
  const r = document.querySelector('input[name="custom-provider"]:checked');
  return r ? r.value : "openai";
}

// 按当前选择切换可见区域：自定义 API 只显示所选接口的字段
function applyModeVisibility() {
  const provider = getSelectedProvider();
  $("custom-openai-fields").style.display = provider === "openai" ? "" : "none";
  $("custom-gemini-fields").style.display = provider === "gemini" ? "" : "none";
}

// 自定义 API 的 origin 按需授权：host_permissions 不再预授权全站站点，
// 保存 Base URL 时就地申请该 origin 的访问权限（request 需在用户手势内调用）
async function ensureApiOriginPermission(provider) {
  let origin;
  try {
    origin = validateBaseUrl(provider.baseUrl).origin + "/*";
  } catch (_) {
    return false; // Base URL 非法，collectAndSave 已报告
  }
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      setStatus(provider.type, "✗ 未授予 " + origin + " 的访问权限，该接口暂时无法调用", "err");
    }
    return granted;
  } catch (_) {
    // 非用户手势路径（自动保存）会拒绝 request：不阻断保存，调用时会给出明确提示
    setStatus(provider.type, "提示：尚未授权 " + origin + "，修改 Base URL 后重新保存即可授权", "err");
    return false;
  }
}

// 收集全部设置并从表单即时保存
async function collectAndSave() {
  const providers = {};
  for (const key of PROVIDER_KEYS) providers[key] = gatherProvider(key);
  // Base URL 校验：非法（远端明文 HTTP、协议不符、主机名缺失）时拒绝保存，
  // 避免把不可用地址写入存储后继续发送请求
  for (const key of API_KEYS) {
    const raw = providers[key].baseUrl;
    if (!raw) continue;
    try {
      validateBaseUrl(raw);
    } catch (e) {
      setStatus(key, "✗ " + friendlyError(e), "err");
      showToast("保存失败：Base URL 不合法");
      return;
    }
  }
  // 静态 host_permissions 已收窄，自定义 API 域名需按 origin 显式授权
  for (const key of API_KEYS) {
    if (providers[key].baseUrl) await ensureApiOriginPermission(providers[key]);
  }
  const activeProvider = getSelectedProvider();
  const fontSize = Number($("font-size").value) || 15;
  const prompt = $("prompt").value;
  const settings = {
    providers,
    activeProvider,
    fontSize,
    fontFamily: $("font-family-select").value,
    fontWeight: $("font-weight-select").value,
    prompt: prompt.trim() ? prompt.trim() : DEFAULT_PROMPT,
    rememberApiKeys: $("remember-api-keys").checked,
  };
  await saveSettings(settings);
  $("prompt").value = settings.prompt;
  showToast("已保存");
}

function fillDatalist(key, models) {
  const dl = $(`models-${key}`);
  dl.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("");
  $(`${key}-model-count`).textContent = models.length ? `已加载 ${models.length} 个模型` : "";

  // 同步填充下拉框
  const sel = $(`${key}-model-select`);
  if (!sel) return;
  const current = $(`${key}-model`).value;
  sel.innerHTML = `<option value="">-- 请选择模型 --</option>` +
    models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
  // 当前值在列表中则选中；不在则保持空（用户可点"自定义"手动输入）
  sel.value = current;
}

// 切换下拉/自定义输入模式
function setupModelToggle(key) {
  const sel = $(`${key}-model-select`);
  const input = $(`${key}-model`);
  const btn = document.querySelector(`[data-custom-model="${key}"]`);
  if (!sel || !input || !btn) return;

  // 自定义按钮：显示输入框、隐藏下拉
  btn.addEventListener("click", () => {
    const isCustom = input.style.display !== "none";
    if (isCustom) {
      // 切回下拉模式
      input.style.display = "none";
      sel.style.display = "";
      btn.textContent = "自定义";
      // 把输入框的值同步回下拉
      fillDatalist(key, getCachedModelsSync(key));
    } else {
      // 切到自定义输入
      input.style.display = "";
      sel.style.display = "none";
      btn.textContent = "返回下拉";
      input.focus();
    }
  });

  // 下拉选择：写入隐藏 input 并保存
  sel.addEventListener("change", () => {
    input.value = sel.value;
    collectAndSave();
  });
}

// 同步获取缓存模型（fillDatalist 切回下拉时用）
function getCachedModelsSync(key) {
  // getCachedModels 是 async，但这里简单从 datalist 读
  const dl = $(`models-${key}`);
  return Array.from(dl.querySelectorAll("option")).map((o) => o.value);
}

function setStatus(key, msg, kind) {
  const el = $(`status-${key}`);
  el.textContent = msg;
  el.className = "status" + (kind === "ok" ? " status-ok" : kind === "err" ? " status-err" : "");
}

// ---------------- 获取模型 ----------------

async function onFetchModels(key) {
  const provider = gatherProvider(key);
  if (!provider.apiKey) {
    setStatus(key, "请先填写 API Key", "err");
    return;
  }
  setStatus(key, "正在获取模型列表…");
  try {
    const models = await fetchModels(provider);
    await saveCachedModels(key, models);
    fillDatalist(key, models);
    if (!provider.defaultModel && models.length) {
      $(`${key}-model`).value = models[0];
    }
    await collectAndSave();
    setStatus(key, `✓ 获取成功：共 ${models.length} 个模型`, "ok");
  } catch (e) {
    setStatus(key, "✗ 获取失败：" + friendlyError(e), "err");
  }
}

// ---------------- 检测可用性 ----------------

async function onTestConnection(key) {
  const provider = gatherProvider(key);
  if (!provider.apiKey) {
    setStatus(key, "请先填写 API Key", "err");
    return;
  }
  setStatus(key, "第 1 步：验证接口与 API Key…");
  let model = provider.defaultModel || "";
  let modelsNote = "";
  try {
    const models = await fetchModels(provider);
    await saveCachedModels(key, models);
    fillDatalist(key, models);
    if (!model && models.length) model = models[0];
    if (models.length) {
      setStatus(
        key,
        `✓ 接口验证通过（${models.length} 个模型）${model ? `；第 2 步：验证模型 ${model} 可调用…` : "…"}`
      );
    } else {
      modelsNote = "模型列表接口正常但未返回任何模型";
    }
  } catch (e) {
    // /models 接口失败不直接判死：已填模型名时跳过列表验证，直接测模型可调用性
    if (!model) {
      setStatus(
        key,
        "✗ 无法获取模型列表：" + friendlyError(e) + "；请在模型框手动输入模型名后再点击「测试连接」。",
        "err"
      );
      return;
    }
    modelsNote = "模型列表接口不可用（" + friendlyError(e) + "），已跳过";
  }
  if (!model) {
    setStatus(
      key,
      "✗ " + (modelsNote ? modelsNote + "；" : "") + "请在模型框手动输入模型名后再点击「测试连接」。",
      "err"
    );
    return;
  }
  if (!provider.defaultModel) {
    $(`${key}-model`).value = model;
    await collectAndSave();
  }
  setStatus(key, `第 2 步：验证模型 ${model} 可调用…${modelsNote ? "（" + modelsNote + "）" : ""}`);
  try {
    await testModel(provider, model);
  } catch (e) {
    setStatus(key, "✗ 模型 " + model + " 测试失败：" + friendlyError(e), "err");
    return;
  }
  setStatus(key, `✓ 测试通过：模型 ${model} 可用${modelsNote ? "（" + modelsNote + "）" : ""}`, "ok");
}

// ---------------- 自定义字体 ----------------

// 常见系统字体候选（canvas 测宽探测，无需用户授权）
const COMMON_FONTS = [
  "微软雅黑", "Microsoft YaHei", "微软雅黑 Light", "宋体", "SimSun", "新宋体", "NSimSun",
  "黑体", "SimHei", "楷体", "KaiTi", "仿宋", "FangSong", "等线", "DengXian",
  "华文楷体", "STKaiti", "思源黑体 CN", "思源宋体 CN", "Noto Sans SC", "MiSans",
  "HarmonyOS Sans SC", "阿里巴巴普惠体", "OPPO Sans", "Segoe UI", "Arial", "Verdana",
  "Tahoma", "Calibri", "Cambria", "Georgia", "Times New Roman", "Consolas", "Courier New",
];

// canvas 测宽探测本机可用字体：候选字体与回退字体宽度不同即视为已安装
function detectCommonFonts() {
  try {
    const canvas = document.createElement("canvas");
    const c = canvas.getContext("2d");
    const text = "测试字体 AgQq1@号";
    const width = (font) => {
      c.font = `16px ${font}`;
      return c.measureText(text).width;
    };
    const baseMono = width("monospace");
    const baseSerif = width("serif");
    return COMMON_FONTS.filter(
      (f) => width(`'${f}', monospace`) !== baseMono || width(`'${f}', serif`) !== baseSerif
    );
  } catch (_) {
    return [];
  }
}

function fillFontSelect(fonts, current) {
  const sel = $("font-family-select");
  const cur = current !== undefined ? current : sel.value;
  const seen = new Set();
  const opts = ['<option value="">默认字体（系统栈）</option>'];
  for (const f of fonts || []) {
    if (f && !seen.has(f)) {
      seen.add(f);
      opts.push(`<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`);
    }
  }
  if (cur && !seen.has(cur)) {
    opts.push(`<option value="${escapeHtml(cur)}">${escapeHtml(cur)}</option>`);
  }
  sel.innerHTML = opts.join("");
  sel.value = cur;
}

async function onScanFonts() {
  const btn = $("scan-fonts");
  btn.disabled = true;
  try {
    if (typeof window.queryLocalFonts !== "function") {
      throw new Error("当前 Chrome 版本不支持枚举系统字体");
    }
    const accessed = await window.queryLocalFonts(); // 首次调用会请求用户授权
    const seen = new Set();
    const fonts = [];
    for (const f of accessed) {
      if (f.family && !seen.has(f.family)) {
        seen.add(f.family);
        fonts.push(f.family);
      }
    }
    fonts.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    await chrome.storage.local.set({ fontList: fonts });
    fillFontSelect(fonts);
    showToast(`已加载 ${fonts.length} 个系统字体`);
  } catch (e) {
    // 授权被拒/不支持：回退到常见字体探测
    const probed = detectCommonFonts();
    await chrome.storage.local.set({ fontList: probed });
    fillFontSelect(probed);
    showToast(probed.length ? `无法完整枚举，已探测到 ${probed.length} 个常见字体` : "未能获取系统字体");
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 网页模式登录检测 ----------------

// 检测当前所选网页服务的登录态；未登录/过期时自动打开对应官网（autoOpen=false 时仅提示）
async function onCheckWebLogin(autoOpen = true) {
  const provider = getSelectedProvider();
  if (provider !== "deepseek" && provider !== "kimi") return;
  const site = provider === "kimi" ? "www.kimi.com" : "chat.deepseek.com";
  setStatus("web", `正在检测 ${site} 登录态…`);
  try {
    // 两个模块的方法名不同：DeepSeek 是 ensureToken（单数），Kimi 是 ensureTokens
    if (provider === "kimi") await KIMI.ensureTokens();
    else await DEEPSEEK.ensureToken();
    $("web-login-status").textContent = "已登录 ✓";
    setStatus(
      "web",
      `✓ 登录态有效，可直接用 ${provider === "kimi" ? "Kimi" : "DeepSeek"} 总结网页`,
      "ok"
    );
  } catch (e) {
    const msg = friendlyError(e);
    $("web-login-status").textContent = "未登录 ✗";
    setStatus("web", "✗ " + msg, "err");
    // 未登录/登录过期：自动打开对应官网，登录后回来再点一次检测
    if (autoOpen && /未在|登录态|登录已过期/.test(msg)) {
      await chrome.tabs.create({
        url: provider === "kimi" ? "https://www.kimi.com/" : "https://chat.deepseek.com/",
      });
    }
  }
}

// ---------------- 快捷键 ----------------

async function onOpenShortcuts() {
  try {
    await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  } catch (_) {
    showToast("请在地址栏手动访问 chrome://extensions/shortcuts");
  }
}

// ---------------- 初始化 ----------------

async function init() {
  const settings = await getSettings();

  // 初始化模型下拉/自定义切换
  for (const key of API_KEYS) {
    setupModelToggle(key);
  }

  // 填充表单
  for (const key of API_KEYS) {
    const p = settings.providers[key];
    $(`${key}-base-url`).value = p.baseUrl;
    $(`${key}-api-key`).value = p.apiKey;
    $(`${key}-model`).value = p.defaultModel;
    const effortEl = $(`${key}-reasoning-effort`);
    if (effortEl) effortEl.value = p.reasoningEffort || "";
    const models = await getCachedModels(key);
    fillDatalist(key, models);
    // 存量 Base URL 校验未通过：明确提示，重新保存且校验通过后自动恢复
    if (p.disabled) {
      setStatus(key, "✗ " + (p.disabledReason || "Base URL 不可用") + "；请修改后重新保存", "err");
    }
  }
  // 由存储的 activeProvider 反推两级选择（网页模式 / 自定义 API + 子选择）
  const webMode = settings.activeProvider === "deepseek" || settings.activeProvider === "kimi";
  const modeRadio = document.querySelector(
    `input[name="api-mode"][value="${webMode ? "web" : "custom"}"]`
  );
  if (modeRadio) modeRadio.checked = true;
  const subRadio = document.querySelector(
    `input[name="${webMode ? "web-provider" : "custom-provider"}"][value="${settings.activeProvider}"]`
  );
  if (subRadio) subRadio.checked = true;
  applyModeVisibility();

  // 网页模式登录态：当前所选服务有本地凭据则静默自动检测（不自动打开官网）
  const webProvider = getSelectedProvider();
  if (webProvider === "deepseek" || webProvider === "kimi") {
    const tokens = await (webProvider === "kimi" ? KIMI.getToken() : DEEPSEEK.getToken());
    if (tokens) {
      onCheckWebLogin(false);
    } else {
      $("web-login-status").textContent =
        webProvider === "kimi" ? "未检测，请先登录 www.kimi.com" : "未检测，请先登录 chat.deepseek.com";
    }
  }

  $("font-size").value = settings.fontSize;
  $("font-size-label").textContent = settings.fontSize + "px";
  // 字体下拉：优先用上次扫描缓存的完整列表，否则探测常见字体
  const { fontList } = await chrome.storage.local.get("fontList");
  fillFontSelect(fontList && fontList.length ? fontList : detectCommonFonts(), settings.fontFamily);
  $("font-weight-select").value = settings.fontWeight || "";
  $("prompt").value = settings.prompt || DEFAULT_PROMPT;
  $("remember-api-keys").checked = settings.rememberApiKeys !== false;

  // 事件绑定：表单变化即时保存
  for (const key of API_KEYS) {
    for (const id of [`${key}-base-url`, `${key}-api-key`, `${key}-model`]) {
      $(id).addEventListener("change", collectAndSave);
    }
    const effortEl = $(`${key}-reasoning-effort`);
    if (effortEl) effortEl.addEventListener("change", collectAndSave);
    $("fetch-" + key).addEventListener("click", () => onFetchModels(key));
    $("test-" + key).addEventListener("click", () => onTestConnection(key));
  }
  $("check-web-login").addEventListener("click", () => onCheckWebLogin(true));
  document.querySelectorAll('input[name="api-mode"]').forEach((r) => {
    r.addEventListener("change", () => {
      applyModeVisibility();
      collectAndSave();
    });
  });
  document.querySelectorAll('input[name="web-provider"]').forEach((r) => {
    r.addEventListener("change", () => {
      // 切换网页服务：重置登录状态显示，重新静默检测
      $("web-login-status").textContent = "未检测";
      setStatus("web", "");
      onCheckWebLogin(false);
      collectAndSave();
    });
  });
  document.querySelectorAll('input[name="custom-provider"]').forEach((r) => {
    r.addEventListener("change", () => {
      applyModeVisibility();
      collectAndSave();
    });
  });
  $("font-size").addEventListener("input", () => {
    $("font-size-label").textContent = $("font-size").value + "px";
  });
  $("font-size").addEventListener("change", collectAndSave);
  $("font-family-select").addEventListener("change", collectAndSave);
  $("font-weight-select").addEventListener("change", collectAndSave);
  $("remember-api-keys").addEventListener("change", collectAndSave);
  $("scan-fonts").addEventListener("click", onScanFonts);
  $("prompt").addEventListener("change", collectAndSave);
  $("open-shortcuts").addEventListener("click", onOpenShortcuts);

  document.querySelectorAll("[data-toggle-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(`${btn.dataset.toggleKey}-api-key`);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "隐藏" : "显示";
    });
  });
}

init();
