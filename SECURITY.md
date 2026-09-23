# 安全说明

## 报告漏洞

请通过 GitHub 私有漏洞报告提交，不要开公开 Issue：

<https://github.com/yahinstudio/aiside/security/advisories/new>

报告中请附：受影响版本（`manifest.json` 的 `version`）、复现步骤、以及你判断的影响范围。

## 凭据如何存放

- **不要提交**任何真实 API Key、DeepSeek/Kimi 登录态、B 站 Cookie 或抓取到的签名 URL。
- 运行期产生的凭据只存在本机浏览器，不会发往第三方，只会发往你自己选择的 AI 服务：
  - DeepSeek bearer token、Kimi access/refresh token → `chrome.storage.session`（关闭浏览器即清除，
    下次使用会重新从对应网站读取）；
  - OpenAI / Gemini API Key → 默认存 `chrome.storage.local`；在设置页关闭「记住 API Key」后改为
    只存会话，关闭浏览器即失效；
  - `chrome.storage.local` 已通过 `setAccessLevel` 限制为仅扩展自身上下文可读，网页脚本无法读取。

## 需要了解的风险（设计取舍，非漏洞）

1. **网页模式依赖非公开接口。** DeepSeek 与 Kimi 账号模式复用网页版登录态并调用其网页端接口
   （含 DeepSeek 的 PoW 挑战）。这些接口没有稳定性承诺，可能随服务方改版或风控而失效，也不属于
   官方支持的用法。请勿用于高频、批量或商业场景，也不要据此期望长期可用。
2. **扩展会把网页内容发往 AI 服务。** 触发总结即表示你同意把当前页面发送给所选 Provider：
   - Kimi 文件模式下发送的是**清洗后的页面 HTML 附件**（已剔除隐藏节点、链接的 query/hash，
     并有 2MB 上限，超限退回正文文本）；上传目标由 Kimi 服务端签发，若被拒会退回内联文本。
   - 其他模式发送提取后的正文文本。
3. **`file://` 本地文件同样会被外发。** 需要在扩展详情页手动开启「允许访问文件网址」，开启后该
   页面内容会按上述路径发送给 AI 服务。请勿对含敏感信息的本地文件使用。
4. **DeepSeek 临时会话会被尝试删除**，但删除请求失败时不保证服务端没有记录；Kimi 无已知的会话
   删除端点，总结会话会保留在你的 Kimi 历史记录中。
5. **网页内容被视为不可信数据。** 扩展会在提示词中显式声明这一点、并在生成 Kimi 附件时过滤隐藏
   DOM，但 prompt injection 无法被完全消除，模型仍可能被恶意页面影响。

## 权限范围

`host_permissions` 只包含固定服务域名（DeepSeek、Kimi、B 站接口与字幕域名）。其他网页的读取
依赖 `activeTab`（由点击扩展图标或快捷键授予），自定义 API 域名在保存时按 origin 单独申请。

## 支持的版本

仅维护最新版本。请先升级到最新版再报告问题。
