# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## What this is

AiSIDE — a Manifest V3 Chrome extension (Chrome 114+) that summarizes the active page
in the side panel. Four providers: **DeepSeek** and **Kimi** account modes (reuse the
website login, no API key), plus **OpenAI-compatible** and **Gemini** APIs. Includes a
Bilibili video-page path (title/description/subtitles → Markdown).

## Commands

There is **no build, bundler, or lint step** — plain classic scripts loaded directly by
Chrome, and no `package.json`. This is a deliberate project choice, **not** an MV3 requirement:
MV3 forbids remotely-hosted code (so no CDN-loaded libraries), but bundling local source into
the package is permitted. Changing this changes the install flow, so treat it as an explicit
decision. See `AiSIDE_开发改进实施文档_v1.0.md` §11 for the proposed direction.

- **Run all tests:** `node tools/test_parse.js`
  - Pure Node, no framework. Outputs `PASS`/`FAIL` per case (~47 cases).
  - Exits non-zero if any case prints `FAIL` (or a case throws), so CI can gate on the exit code.
  - There is **no single-test filter.** Tests are flat functions invoked by an async IIFE
    at the bottom of the file; to run one, comment out the others in that IIFE.
  - The harness resolves source paths relative to the repo root (`path.resolve(__dirname, "..")`),
    so the repo can be moved or cloned anywhere.
- **CI:** `.github/workflows/ci.yml` runs syntax checks, a manifest parse, and the test harness on
  every push to `main` and every PR. There is no build step, so CI has nothing to package.
- **Regenerate icons:** `powershell -ExecutionPolicy Bypass -File tools/gen_icons.ps1`
  (Windows only; .NET System.Drawing produces `icons/icon{16,48,128}.png`). It reads `logo.png`
  from the repo root by default — the source art is not committed — and takes `-Source` / `-OutDir`
  to override. Paths resolve relative to the script, so any clone works.
- **Install/run:** `chrome://extensions` → enable Developer mode → "Load unpacked" → this directory.
  Reload the extension after any source change; the service worker restarts on its own.
  There is no watch mode.

## Architecture

Four HTML/JS surfaces plus shared modules, all loaded as classic scripts (globals, not modules):

| File | Role |
|---|---|
| `background.js` | Service worker: opens the panel on action click, handles the `Ctrl+Shift+U` command, tightens the `storage.local` access level, and via `webRequest` captures the latest DeepSeek `Authorization: Bearer` header into session storage (through `secretStore`). |
| `sidepanel.html/js` | The UI and the orchestration of one summarize run. |
| `options.html/js` | Settings page (`open_in_tab`). |
| `common.js` | Provider-agnostic core: settings, model list, `streamChat`, page extraction, Bilibili, Markdown rendering. |
| `deepseek.js` / `kimi.js` | Account-mode providers; each exposes a `window.DEEPSEEK` / `window.KIMI` object. |
| `pow-worker.js` | DeepSeek PoW solver, run inside a Web Worker. |

### Script load order is load-bearing
`sidepanel.html` loads `deepseek.js`, `kimi.js`, `common.js`, then `sidepanel.js`.
`common.js`'s `streamChat` dispatches to `window.DEEPSEEK` / `window.KIMI` and throws a
"模块未加载" error if they are absent. `options.html` loads the same provider + common scripts.
`background.js` additionally pulls `common.js` in via `importScripts` (it needs `secretStore`
and `hardenStorageAccess`); `common.js` has no top-level side effects, so this is safe.
If you add a shared file, wire it into every HTML that needs it.

### Provider dispatch
`settings.activeProvider` is one of `deepseek | kimi | openai | gemini`. `streamChat`
(in `common.js`) is the single choke point:
- **Account modes** merge all messages into one string and delegate to
  `DEEPSEEK/KIMI.sendMessage(sessionId, content, signal, kimiFileId)`.
- **API modes** speak SSE directly. Gemini maps `reasoningEffort` to
  `generationConfig.thinkingConfig.thinkingBudget`; OpenAI-compatible maps `disabled` →
  `thinking:{type:"disabled"}` and other values → `reasoning_effort`. Empty = send nothing
  (follow server default) — do not force a default, some providers reject unknown params.

### Permissions — least privilege, and what it costs
`host_permissions` covers only the fixed provider hosts (DeepSeek chat + its two `hif-*` token
hosts, Kimi, `api.bilibili.com`, `aisubtitle.hdslb.com`). Everything else is reached through
`activeTab` or `optional_host_permissions` (`https://*/*`, `http://localhost/*`,
`http://127.0.0.1/*`). Three consequences are deliberate, not accidents:

- **Page access needs `activeTab`.** Clicking the action or the keyboard command grants it; a click
  *inside* the side panel does **not**. So "总结当前网页" after a tab switch is denied — the panel
  detects the permission error and offers a one-click grant (`showPermissionError`).
- **Custom API origins are granted at runtime**, per origin, when the Base URL is saved in the
  options page (`ensureApiOriginPermission`). A save without a user gesture cannot prompt.
- **Kimi attachment upload targets a server-signed URL**, whose origin cannot be declared ahead of
  time; when that PUT is refused the run degrades to inline text and says so in the panel
  (`panel-note`) rather than failing silently.

Do not widen `host_permissions` back to `http(s)://*/*` — `testManifestPermissions` fails if you do.

### SSE reading and timeouts (shared by every streaming path)
`sseEvents` in `common.js` is the single SSE reader for the OpenAI/Gemini path, both DeepSeek and
Kimi chat streams, and Kimi's file-parse wait. It normalises CRLF, handles line splits across
chunks and `event:` lines, and **flushes the buffer at EOF** so a final record without a trailing
newline is not lost (the three original copies all dropped it).

`makeStreamAbort(externalSignal)` pairs the caller's cancellation with an idle timeout
(`SSE_IDLE_TIMEOUT_MS`, 120s without data). Checking a deadline only between `reader.read()` calls
cannot fire while a read is pending, so the timer aborts the controller instead — that is what
actually unblocks a stalled connection. Kimi's 3-minute parse wait uses the same pattern.

### Provider contract (informal)
Each provider module is a plain global exposing `getToken`, `ensureToken(s)`, `createSession` and
`sendMessage`; Kimi adds `uploadFile` / `waitFileParsed`. `streamChat` dispatches on
`settings.activeProvider`. This is intentionally *not* an ES-module interface — introducing modules
or a bundler would break "load unpacked from the repo root" and the `executeScript` self-containment
rule above, so it is out of scope until that trade-off is revisited.

### One summarize run (the `summarize()` function in `sidepanel.js`)
Fetches settings → validates protocol/PDF → extracts material → builds messages → streams.
A monotonically increasing `seq` cancels stale runs (new triggers, tab switches, and same-tab
navigation abort the previous `AbortController`). Any async step re-checks `mySeq !== seq` before
touching the DOM. `tabs.onUpdated` marks a summary stale when the summarized tab navigates in place
(it does *not* re-summarize on its own — that would spend the user's quota while they browse).

### Content extraction — injected functions must stay self-contained
`extractPageText` and `extractBilibili` (both in `common.js`) are serialized by
`chrome.scripting.executeScript`. They may only reference their own arguments and page globals —
**no outer-scope variables or helper imports**, or injection fails at runtime. Nested helpers
(`cleanBodyHtml`, `md5hex`, `getMixinKey`) are inlined deliberately; do not hoist them out.
- Normal pages inject `extractPageText` (isolated world), size-limited by provider:
  `API_MAX_CHARS` and `DS_MAX_CHARS` in `sidepanel.js` (both currently 60000).
- Kimi file mode also asks for `bodyHtml`. `cleanBodyHtml` rebuilds a **visible-only** tree from the
  original DOM (drops `hidden`, `aria-hidden`, and computed `display:none`) instead of cloning and
  stripping attributes — stripping erases the hidden markers and would upload hidden text.
  `href` keeps only http/https with query+hash removed; attachments over 2 MB fall back to text and
  explain why through `htmlNote`. Both are asserted by the Kimi sanitizer tests.
- Bilibili injects `extractBilibili` into the **MAIN world** because the `api.bilibili.com`
  calls need the page's `.bilibili.com` cookies (`credentials:"include"`). Subtitle JSON is
  *not* fetched there (CORS to `aisubtitle.hdslb.com`); it returns a URL that the side panel
  downloads via `fetchBilibiliSubtitle` (extension context, host_permissions bypass CORS),
  falling back to a MAIN-world fetch with the page Referer.

### DeepSeek PoW — algorithm is exact, do not "correct" it
`pow-worker.js` implements `DeepSeekHashV1`, a SHA3-256 **variant** whose `keccakF` skips
round 0 (runs rounds 1..23) to match the official WASM. `test_parse.js` pins this against
official hash vectors. Requests need the solved nonce in `x-ds-pow-response` (base64 JSON);
PoW is re-solved whenever the token is refreshed because the header is token-bound
(`buildStreamHeaders` in `deepseek.js`). Cleanup deletes the chat session after the stream.

### Kimi account mode
`refresh_token` lives in `www.kimi.com` `localStorage` (read once via a hidden tab);
`refreshAccessToken` trades it for an `access_token` pair. Kimi prefers **file mode**: the
page's `body.outerHTML` is uploaded as an attachment and referenced by `refs:[fileId]`; any
upload/parse failure silently degrades to inline text (the Kimi branch of `summarize()` in
`sidepanel.js`). There is no
known session-delete endpoint, so Kimi summaries persist in the user's history.

### Streaming Markdown rendering (security + no-jump invariants)
Rendering is hand-rolled in `common.js` (no library):
- **Always `escapeHtml` before any Markdown substitution** (`escapeHtml` / `inlineHtml`).
  XSS escaping is covered by tests — keep escaping upstream of tag insertion.
- `planStreamingRender` / `renderProvisionalTail` / `splitMarkdownBlocks` render completed
  blocks normally and render the in-flight tail "as if finished" (growing table cells, code
  lines) so there is no layout jump when the stream completes. `flushRender` in `sidepanel.js`
  diffs `renderedBlocks` against the DOM to replace only changed blocks.

### Storage

`chrome.storage.local` — access level is tightened to `TRUSTED_CONTEXTS` by
`hardenStorageAccess()` on every service-worker start (the default exposes it to content scripts):
- `settings` — deep-merged over `DEFAULT_SETTINGS`, so adding a field needs no migration. A
  provider whose `baseUrl` fails `validateBaseUrl` is flagged `disabled` on read by `getSettings`
  (covers legacy remote-HTTP values); `isReady` then treats it as unconfigured until the user
  re-saves a valid URL.
- `models` — per-provider cached model lists.
- `fontList` — scanned system fonts for the options page.
- API keys — only while `settings.rememberApiKeys` is true (the default, preserving prior
  behaviour). When it is false, `saveSettings` blanks the keys in `settings` and parks them in
  `storage.session.api_keys`, and `getSettings` rehydrates them on read. Callers never need to
  know which side a key came from.

`chrome.storage.session` — credentials, always through `secretStore` in `common.js`:
- `ds_token` — DeepSeek bearer token.
- `kimi_tokens` — `{ accessToken, refreshToken }`.

Session storage is cleared on browser restart, so the first summarize afterwards re-captures the
token via a hidden tab. `secretStore.get` lazily migrates any legacy value still sitting in
`storage.local` and deletes the old field. **Route new credentials through `secretStore`**, never
straight to `storage.local`.

## Conventions

- UI strings and code comments are **Chinese**; match that style.
- Console diagnostics use the `[AiSIDE]` prefix.
- User-facing errors go through `friendlyError` in `common.js` for consistent Chinese text.
- `streamChat`'s `kimiOpts` parameter is a deprecated positional signature kept for
  compatibility — new options go in the trailing `opts` object (`{ kimiFileId }`).
- `需求分析.md` holds the original requirements/design rationale. It is partially historical
  (e.g. it lists custom prompts as out-of-scope, but they were later added in its §9 V2 changelog);
  treat the code as current and the doc as background.
