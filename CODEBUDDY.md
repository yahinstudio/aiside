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
  - Pure Node, no framework. Outputs `PASS`/`FAIL` per case (~37 cases).
  - There is **no single-test filter.** Tests are flat functions invoked by an async IIFE
    at the bottom of the file; to run one, comment out the others in that IIFE.
  - The harness resolves source paths relative to the repo root (`path.resolve(__dirname, "..")`),
    so the repo can be moved or cloned anywhere.
- **Regenerate icons:** `powershell -ExecutionPolicy Bypass -File tools/gen_icons.ps1`
  (uses .NET System.Drawing to produce `icons/icon{16,48,128}.png`).
- **Install/run:** `chrome://extensions` → enable Developer mode → "Load unpacked" → this directory.
  Reload the extension after any source change; the service worker restarts on its own.
  There is no watch mode.

## Architecture

Four HTML/JS surfaces plus shared modules, all loaded as classic scripts (globals, not modules):

| File | Role |
|---|---|
| `background.js` | Service worker: opens the panel on action click, handles the `Ctrl+Shift+U` command, and via `webRequest` captures the latest DeepSeek `Authorization: Bearer` header into `storage.local.ds_token`. |
| `sidepanel.html/js` | The UI and the orchestration of one summarize run. |
| `options.html/js` | Settings page (`open_in_tab`). |
| `common.js` | Provider-agnostic core: settings, model list, `streamChat`, page extraction, Bilibili, Markdown rendering. |
| `deepseek.js` / `kimi.js` | Account-mode providers; each exposes a `window.DEEPSEEK` / `window.KIMI` object. |
| `pow-worker.js` | DeepSeek PoW solver, run inside a Web Worker. |

### Script load order is load-bearing
`sidepanel.html` loads `deepseek.js`, `kimi.js`, `common.js`, then `sidepanel.js`.
`common.js`'s `streamChat` dispatches to `window.DEEPSEEK` / `window.KIMI` and throws a
"模块未加载" error if they are absent. `options.html` loads the same provider + common scripts.
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

### One summarize run (the `summarize()` function in `sidepanel.js`)
Fetches settings → validates protocol/PDF → extracts material → builds messages → streams.
A monotonically increasing `seq` cancels stale runs (new triggers and tab switches abort the
previous `AbortController`). Any async step re-checks `mySeq !== seq` before touching the DOM.

### Content extraction — injected functions must stay self-contained
`extractPageText` and `extractBilibili` (both in `common.js`) are serialized by
`chrome.scripting.executeScript`. They may only reference their own arguments and page globals —
**no outer-scope variables or helper imports**, or injection fails at runtime. Nested helpers
(`cleanBodyHtml`, `md5hex`, `getMixinKey`) are inlined deliberately; do not hoist them out.
- Normal pages inject `extractPageText` (isolated world), size-limited by provider:
  `API_MAX_CHARS` and `DS_MAX_CHARS` in `sidepanel.js` (both currently 60000).
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

### Storage (`chrome.storage.local`)
- `settings` — deep-merged over `DEFAULT_SETTINGS`, so adding a field needs no migration.
- `models` — per-provider cached model lists.
- `ds_token` — DeepSeek bearer token (written by `background.js` webRequest and `deepseek.js`).
- `kimi_tokens` — `{ accessToken, refreshToken }`.
- `fontList` — scanned system fonts for the options page.

API keys never leave the machine; they are stored only here. Note that `chrome.storage.local`
is exposed to content scripts (untrusted contexts) **by default**; the extension does not call
`setAccessLevel` yet, so every injected world in every page can read this data. See the
hardening doc §4 before adding new secrets here.

## Conventions

- UI strings and code comments are **Chinese**; match that style.
- Console diagnostics use the `[AiSIDE]` prefix.
- User-facing errors go through `friendlyError` in `common.js` for consistent Chinese text.
- `streamChat`'s `kimiOpts` parameter is a deprecated positional signature kept for
  compatibility — new options go in the trailing `opts` object (`{ kimiFileId }`).
- `需求分析.md` holds the original requirements/design rationale. It is partially historical
  (e.g. it lists custom prompts as out-of-scope, but they were later added in its §9 V2 changelog);
  treat the code as current and the doc as background.
