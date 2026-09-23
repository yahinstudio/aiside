# AiSIDE — Chrome 侧边栏 AI 网页总结

在浏览器右侧侧边栏中一键用 AI 总结当前网页内容，支持 DeepSeek 账号模式（复用 chat.deepseek.com 登录态，无需 API Key）、Kimi 网页版账号模式（复用 www.kimi.com 登录态）、OpenAI 兼容 API 与 Google Gemini API，流式输出结果。支持 B 站视频页专用总结（标题/简介/自动字幕）。

## 功能

- 点击扩展图标 或 按快捷键（默认 `Ctrl+Shift+U`）→ 打开侧边栏并自动总结当前网页
- **DeepSeek 账号模式**：直接复用浏览器中已登录的 chat.deepseek.com 账号，无需填写 API Key；正文以内联文本发送（超出 6 万字符自动截断），登录过期时错误面板提供一键打开 chat.deepseek.com 登录
- **Kimi 网页版账号模式**：复用浏览器中已登录的 www.kimi.com 账号，无需 API Key；对齐 Kimi Copilot 的文件模式——把网页完整 HTML（B 站页为整理后的 Markdown）作为附件上传给 Kimi 阅读，正文中附带网页地址，上传/解析失败时自动降级为内联文本（6 万字符上限）；登录过期时错误面板提供一键打开 www.kimi.com 登录；总结会话保留在 Kimi 历史记录中
- OpenAI 兼容 API（官方 OpenAI、DeepSeek、通义等）与 Gemini API 两种配置
- 一键获取模型列表（也支持手动输入模型名）、检测模型可用性
- 自定义总结提示词（默认"请返回您反复阅读正文后精心写成的详尽笔记"）
- 总结文字字号可调（12–20px）
- 仅对 `http://`、`https://`、`file://` 页面生效；其他页面侧边栏提示"请在网页上使用"
- **B 站视频页**（`www.bilibili.com/video/BV…`）：通过接口获取标题、简介、自动字幕（wbi 签名调用 `x/player/wbi/v2`，含 AI 字幕），整理成带时间轴的 Markdown 后总结
- 长页面自动截断，流式展示总结结果（总结期间侧边栏居中显示"总结中"）

## 安装

1. 克隆或下载本仓库到本地任意目录（如 `git clone https://github.com/yahinstudio/aiside.git`）
2. 打开 Chrome，访问 `chrome://extensions`
3. 打开右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择克隆或解压后的 AiSIDE 文件夹

> 如需总结 `file://` 本地页面：在扩展详情页打开「允许访问文件网址」开关。

## 配置

右键点击工具栏的扩展图标 → 选「选项」，在设置页中：

- **网页模式（推荐，无需 API Key）**：选择 DeepSeek 或 Kimi；先在浏览器登录对应网站，再到设置页点「检测登录」确认"已登录"——未登录时点检测会自动打开对应官网
- **自定义 API**：选择 OpenAI 兼容 或 Google Gemini，然后：
  1. 填写 Base URL 与 API Key
  2. 点击「获取模型」自动拉取列表并选择默认模型（拉取失败可手动输入模型名）
  3. 点击「测试连接」验证接口与模型是否可用
  4. 「思考模式」控制思考开销（默认不发送参数，跟随服务端默认）：OpenAI 兼容按服务商语义传参（如智谱 GLM-5.3 强制思考只能选 low）；Gemini 映射为思考预算：关闭=0、low=1024、high=16384、max=24576 tokens
- 按需调整总结提示词、字体（可扫描系统字体）与文字大小

> API Key 仅保存在本机浏览器的 `chrome.storage.local` 中，不会上传到任何服务器。
> DeepSeek 账号模式复用 chat.deepseek.com 网页版登录态（仅读取本机 localStorage 的 userToken，不接触密码），对话前会完成一次网页版同款 PoW 挑战（纯 JS 求解，约 1 秒，不影响使用）；接口属个人自动化用法，可能随网页版改版而失效（含风控），请勿用于高并发或上传至 Chrome 商店。

## 使用

- 方式一：点击扩展图标，侧边栏打开并自动总结当前网页
- 方式二：按 `Ctrl+Shift+U`——侧边栏未开时会自动打开并总结当前页，已开时重新总结当前页
- B 站视频页：打开视频页后触发总结，扩展会通过接口获取标题/简介/自动字幕（**自动字幕需要登录 B 站**；未获取到字幕时会提示，并用标题/简介继续总结）
- DeepSeek 模式首次使用：扩展会自动打开一个隐藏标签页读取登录态（很快关闭），之后直接复用本地保存的凭据

## 修改快捷键

扩展无法直接设置快捷键，请：

1. 在设置页点击「设置快捷键」，或手动访问 `chrome://extensions/shortcuts`
2. 找到「总结当前网页」，点击后输入新的组合键

## 常见问题

- **弹出"请在网页上使用"**：扩展仅支持 http、https、file 页面，chrome:// 内建页面、扩展商店等不支持。
- **DeepSeek 提示"未在 chat.deepseek.com 检测到登录态"**：先在浏览器中打开并登录 DeepSeek；设置页点「检测登录」未登录时会自动打开官网；侧边栏登录过期时错误面板也有「打开 chat.deepseek.com 登录」按钮。
- **Kimi 提示"未在 www.kimi.com 检测到登录态"**：先在浏览器中打开并登录 www.kimi.com（新版 Kimi 域名）；设置页点「检测登录」未登录时会自动打开官网；侧边栏登录过期时错误面板也有「打开 www.kimi.com 登录」按钮。
- **"未获取到自动字幕"（B 站）**：字幕接口需要 B 站登录态，请先在浏览器登录 B 站后重试；部分视频本身没有自动字幕。
- **"字幕下载失败"（B 站）**：字幕 JSON 下载已自动在扩展上下文与页面上下文间双重尝试，仍失败通常是接口临时异常，请稍后重试；详情见扩展的 Service Worker / 侧边栏控制台日志（[AiSIDE] 前缀）。
- **"无法提取正文"**：浏览器内建 PDF 查看器、需登录的页面等无法注入，请切换到普通网页。
- **B 站接口风控报错**：正常使用频率不会触发；若偶尔出现请稍后再试。
- **file:// 页面提示权限错误**：在扩展详情页开启「允许访问文件网址」。
- **获取模型失败**：部分第三方 API 不提供 `/models` 接口，直接在模型输入框手动输入模型名即可。
- **测试连接 401/403**：多为 API Key 无效或未开启对应模型权限。

## 目录结构

```
manifest.json       扩展清单（MV3）
background.js       后台 Service Worker（图标点击、快捷键）
common.js           公共逻辑（设置、API 请求、正文提取、B 站数据、渲染）
deepseek.js         DeepSeek 账号模式（登录态、PoW 编排、会话、SSE 对话）
kimi.js             Kimi 网页版账号模式（www.kimi.com 登录态、token 刷新、会话、SSE 对话）
pow-worker.js       PoW 求解器（纯 JS SHA3-256，Web Worker 内运行）
sidepanel.html/css/js 侧边栏
options.html/css/js 设置页
icons/              扩展图标
tools/gen_icons.ps1 图标生成脚本（powershell -ExecutionPolicy Bypass -File tools\gen_icons.ps1）
tools/test_parse.js 单元测试（node tools/test_parse.js）
```
