# Research: Obsidian mobile / large-vault plugin performance — cheap metadata, event cadence, iOS jetsam, virtualization

Scope: verification-only, no recommendations. Context is `file-tree-alternative` (FTA) v2.6.0, React 18, ~14,349 files / 3.7 GB vault on iOS.
Research date: 2026-10-18. Sources are official Obsidian docs (`docs.obsidian.md` / its source repo `obsidianmd/obsidian-developer-docs`), the `obsidianmd/obsidian-api` type definitions (`obsidian.d.ts`), Obsidian forum, GitHub, WebKit/Apple/MDN, and vendor blogs.

Legend: ✅ verified from a primary/official source · ⚠️ partially verified / inference / caveat · ❌ could not verify

---

## 1. Obsidian cheap-metadata paths (TFile.stat.mtime, MetadataCache)

**Answer: Yes — `TFile.stat` (with `mtime`/`ctime`/`size`) is a plain property on `TFile`, populated by Obsidian's vault index. `vault.getFiles()` and the `vault.on("modify", …)` callback hand you `TFile`/`TAbstractFile` objects that already carry `.stat`. You do NOT need to read file contents to get mtime.**

- ✅ `TFile.stat: FileStats`, and `FileStats` = `{ ctime: number; mtime: number; size: number }` (mtime "Time of last modification, represented as a unix timestamp, in milliseconds"). Type definitions, `obsidian.d.ts`:
  https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts (see `TFile`, `interface FileStats`)
- ✅ `vault.getFiles(): TFile[]` and `vault.getMarkdownFiles(): TFile[]` return the file objects directly (no read):
  https://docs.obsidian.md/Reference/TypeScript+API/Vault/getFiles
- ✅ The `vault.on('modify', callback)` payload is a `TAbstractFile` (so on a real file it is a `TFile` carrying `.stat`):
  https://docs.obsidian.md/Reference/TypeScript+API/Vault/on('modify')
- ✅ Real-world confirmation that `.stat` is usable without reading: an FTA-forum plugin request computes recent files as `app.vault.getFiles().filter(f => f.stat.mtime > LAST_UPDATED_TIME || f.stat.ctime > LAST_UPDATED_TIME)` — no content read:
  https://forum.obsidian.md/t/fr-maintain-a-registry-of-all-the-files-which-has-been-modified-when-obsidian-was-closed/110122
- ✅ Corroborating thread: "I just discovered `app.vault.getFiles()` which seems to solve my problem" (obtaining size/extension per file):
  https://forum.obsidian.md/t/get-file-extension-and-size-properties/69585
- ⚠️ Caveat: `file.stat` can be transiently **stale right after a write**. A forum thread documenting "vault cache truncation after `adapter.write()`" shows reconciliation using a stale `file.stat.size`; a workaround is to re-`stat` via `vault.adapter.stat(path)`:
  https://forum.obsidian.md/t/vault-cache-truncation-after-adapter-write/113139

**What `app.metadataCache` offers to avoid walking the vault**

- ✅ `resolvedLinks: Record<string, Record<string, number>>` — all resolved links (source path → {destination path: count}); `unresolvedLinks` likewise. Populated by the indexer, no file reads required:
  https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache
- ✅ `getFileCache(file: TFile): CachedMetadata | null` and `getCache(path)` — cached per-file metadata (headings, links, embeds, tags, blocks, frontmatter). Cached; no content read at call time:
  https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache (and `.../MetadataCache/getFileCache`)
- ✅ `getFirstLinkpathDest(linkpath, sourcePath): TFile | null` — resolves a link path to a `TFile` (the same resolver Obsidian uses internally):
  https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache
- ✅ Events on MetadataCache:
  - `on('changed', (file, data, cache))` — called when a file has been indexed and its (updated) cache is available. **Not** called on rename for performance reasons (hook `Vault.on('rename')` for that).
  - `on('resolve', (file))` — a file has been resolved for resolvedLinks/unresolvedLinks.
  - `on('resolved', ())` — all files resolved; **"fired each time files get modified after the initial load."**
  - `on('deleted', (file, prevCache))`.
  Source: obsidian.d.ts (MetadataCache) + https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache
- ✅ Third-party confirmation of ordering nuance: "vault `modify` fires before Obsidian has re-read the file's metadata" → if you need fresh metadata, listen to `metadataCache` `changed` rather than `vault` `modify`. Source (Local REST API maintainer):
  https://github.com/coddingtonbear/obsidian-local-rest-api/issues/327

**Recommended pattern for incremental "recent files by mtime"** (as documented/used, not an official Obsidian recipe)

- ✅ Incremental pattern: keep a stored `LAST_UPDATED_TIME`, then on load/at will: `app.vault.getFiles().filter(f => f.stat.mtime > LAST_UPDATED_TIME)`. No full content walk. (Forum thread above.)
- ⚠️ No single official Obsidian doc titled "recent files by mtime" was found; the pattern is community-established and consistent with the API surface.

---

## 2. `Vault.on("modify")` cadence, `editor-change`, and debounce

**Events that exist on `Vault`** (v1: create, modify, delete, rename only). ✅

- ✅ `create(file: TAbstractFile)` — also fires for each existing file at vault load unless you register inside `Workspace.onLayoutReady`.
- ✅ `modify(file: TAbstractFile)`
- ✅ `delete(file: TAbstractFile)`
- ✅ `rename(file: TAbstractFile, oldPath: string)`
  Source: obsidian.d.ts `class Vault` + https://docs.obsidian.md/Reference/TypeScript+API/Vault

**There is no `Vault.on("modified")` event.** ❌ (Only `modify`.) If any code references `"modified"`, it is not an Obsidian `Vault` event.

**Cadence**

- ✅ Obsidian writes to disk on autosave while typing: "By default, Obsidian saves every ~2 seconds while you type." → the `modify` event fires on those writes (per autosave), not per keystroke. Source: Autosave Control plugin (community, but explicit about default behavior):
  https://github.com/mihasm/obsidian-autosave-control and
  https://community.obsidian.md/plugins/autosave-control
- ✅ Official-ish confirmation that `modify` fires repeatedly during editing: the Obsidian "Shell commands" docs (published via publish.obsidian.md) for the "File content modified" event state: "While a user writes to — or otherwise edits — files in Obsidian, Obsidian saves the changes very often to the file system. This may cause shell commands using this event to be executed multiple times during a short time." and "To prevent redundant executions, it's recommended to use **debouncing** with this event."
  https://publish.obsidian.md/shellcommands/Events/File+content+modified
- ✅ `workspace.on('editor-change', (editor, info))` is the editor-level event: "Triggered when changes to an editor have been applied, either programmatically or from a user event." This is the per-document-change (per-keystroke-ish) signal. Source: obsidian.d.ts `class Workspace`, and the official `Vault` vs `Editor` distinction in:
  https://forum.obsidian.md/t/workspace-on-editor-change/68617
- ✅ Documented `debounce` utility exists in the public API: `export function debounce<T,V>(cb, timeout?, resetTimer?): Debouncer<T,V>`. Source:
  https://docs.obsidian.md/Reference/TypeScript+API/debounce
- ✅ Real-world debounce-on-modify pattern (Obsidian Git): `this.registerEvent(this.app.vault.on("modify", () => { this.debRefresh(); this.autoCommitDebouncer?.(); }));`
  https://github.com/Vinzent03/obsidian-git/issues/1088
- ⚠️ The official developer docs' `Events.md` covers `registerEvent`/`registerInterval` but does **not** contain an explicit "debounce vault modify" recipe; the debounce guidance lives in the Shell commands docs and community plugins. The `debounce()` utility itself is official.

---

## 3. Obsidian mobile specifics (Platform gate, requestIdleCallback, localStorage, saveData)

**Platform gate**

- ✅ `Platform.isMobile` ("The UI is in mobile mode.") and `Platform.isMobileApp` ("We're running the Capacitor mobile app."), plus `isIosApp`, `isAndroidApp`, `isPhone`, `isTablet`, `isSafari`. Official docs use `Platform.isIosApp` / `Platform.isAndroidApp` in the mobile guide.
  https://docs.obsidian.md/Reference/TypeScript+API/Platform and
  https://docs.obsidian.md/Plugins/Getting+started/Mobile+development
- ✅ Obsidian mobile is a **Capacitor** app (so iOS = WKWebView) — per the `isMobileApp` doc comment in obsidian.d.ts.
- ⚠️ "Standard gate": community guidance commonly uses `isDesktopOnly` in the manifest to block desktop-only plugins, and `Platform.isMobile`/`isIosApp` for feature gating. Example community guidance: https://github.com/kepano/obsidian-minimal-settings/blob/main/AGENTS.md

**requestIdleCallback in iOS WebKit / Capacitor WKWebView**

- ✅ **Not available by default, as of mid-2026.** WebKit implements `requestIdleCallback` only behind a flag; Safari/Safari TP still have it **disabled by default**.
  - MDN browser-compat-data issue #24573 (Safari): tester found `window.requestIdleCallback` `undefined` on Safari 18.1; status = "supported only behind a browser flag/preference": https://github.com/mdn/browser-compat-data/issues/24573
  - Follow-up PR #30001, merged **2026-07-08**, summary: "Safari TP supports `requestIdleCallback` **behind flag**"; the author re-checked "the flag is still disabled by default in TP": https://github.com/mdn/browser-compat-data/pull/30001
  - MDN itself labels the feature "Limited availability — not Baseline because it does not work in some of the most widely-used browsers": https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback
  - caniuse: Safari 18 = "Not supported": https://caniuse.com/requestidlecallback
- ✅ Consequently, plugins on Obsidian iOS should not rely on `requestIdleCallback`; use `requestAnimationFrame` (`window.nextFrame()` / `requestAnimationFrame` are available) or `setTimeout`. Obsidian exposes `nextFrame(): Promise<void>` and `window.nextFrame()` (obsidian.d.ts), and MDN `requestAnimationFrame`/`setTimeout` are standard.
- ⚠️ Exact availability on the newest shipping Safari (26.x/27.x) at your target iOS version was **not** directly tested here; the latest primary data (Jul 2026) says the flag is still off by default.

**localStorage on mobile**

- ✅ Obsidian added vault-scoped helpers `app.loadLocalStorage(key)` / `app.saveLocalStorage(key, data)` in **v1.8.7** — i.e., the official, vault-scoped way to use localStorage:
  https://docs.obsidian.md/Reference/TypeScript+API/App/loadLocalStorage and
  https://docs.obsidian.md/Reference/TypeScript+API/App/saveLocalStorage
- ✅ Community report of mobile unreliability: "iOS wipes the localStorage when your device is low on storage space, so localStorage shouldn't be used for long-term persistent data":
  https://forum.obsidian.md/t/bug-localstorage-not-writing-reading/17542
- ✅ Separately flagged as unsuitable for sensitive data because it is shared across plugins in a vault ("some evil plugin could dump `Object.entries(localStorage)`"):
  https://forum.obsidian.md/t/cross-platform-secure-storage-for-secrets-and-tokens-that-can-be-syncd/100716
- ⚠️ **No official developer-doc page explicitly "deprecating" localStorage** was found. The evidence for "discouraged on mobile" is: (a) Obsidian adding vault-scoped helpers, (b) iOS storage-pressure eviction behavior, (c) community guidance. Flag as not an explicit official deprecation statement.

**`plugin.saveData` vs localStorage**

- ✅ `saveData(data: any): Promise<void>` — async; writes `data.json` in the plugin folder (via the vault adapter). `loadData(): Promise<any>`.
  https://docs.obsidian.md/Reference/TypeScript+API/Plugin/saveData
- ⚠️ "Less blocking than localStorage": **not directly stated by Obsidian**, but the API signature is async (returns a Promise) and it goes through the async vault adapter (`DataAdapter.write`), whereas `localStorage.setItem` is synchronous and blocks the thread. Treat "less blocking" as an inference from sync-vs-async, not an official claim.

---

## 4. iOS WebKit renderer/jetsam memory limits and React OOM patterns

**Approximate WKWebView heap limits (2025–2026)**

- ✅ Vendor deep-dive (Catch Metrics, **Jan 5 2026**), citing WebKit source:
  - iPhone 6s/SE1 ≈ 200–250 MB
  - iPhone 8/X ≈ 300–350 MB
  - iPhone 11/12 ≈ 350–400 MB
  - iPhone 13/14 ≈ 400–450 MB
  - iPhone 15+ ≈ 1 GB+
  - "for web pages on iOS, this typically lands in the 300–450 MB range for most devices currently in use."
  - WebKit pressure tiers: Conservative (50% of limit), Strict (65%, deletes JIT-compiled JS), Kill (100%, synchronous cleanup then page reload).
  https://www.catchmetrics.io/blog/deep-dive-ram-internals-webkit
- ✅ Apple's jetsam event-report doc (identifying high-memory use):
  https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports

**Obsidian-specific iOS jetsam evidence**

- ✅ Obsidian forum thread, post #6 (2026-09-06, iPhone 14 Pro, **iOS 26.6.1**, Obsidian **1.13.7**, 2,427 md files/168 MB vault): raw console shows repeated
  `kernel memorystatus: killing_highwater_process pid … [com.apple.WebKit.WebContent] (highwater 100 …) 1738194KB` — i.e., the WebKit renderer killed at its high-water mark, after which Obsidian reloads the web view.
  ⚠️ **Caveat:** the poster explicitly labels this reply "All text below is AI generated, but helpful." The raw log lines are presented as captured evidence, but the surrounding analysis is AI-written — treat with caution.
  https://forum.obsidian.md/t/crashing-when-theres-a-large-markdown/113527
- ✅ Remotely Save issue #1188: "iOS: Obsidian silently killed (jetsam) during parallel downloads":
  https://github.com/remotely-save/remotely-save/issues/1188
- ✅ Obsidian LiveSync issue #680 (maintainer): "heavy tasks and large memory usage may cause the mobile Obsidian to restart":
  https://github.com/vrtmrz/obsidian-livesync/issues/680
- ✅ Reddit r/ObsidianMD "Constant Reloads on iOS" (~28k notes): https://www.reddit.com/r/ObsidianMD/comments/1kciyqy/constant_reloads_on_ios
- ✅ Obsidian forum "Obsidian crash at startup and restart (loop) — likely indexing parser OOM" (iPhone SE2, iOS 18.5):
  https://forum.obsidian.md/t/obsidian-crash-at-startup-and-restart-loop-likely-indexing-parser-oom/104351
- ⚠️ Note: the thread titled "Crashing when there's a large markdown" is chiefly a **desktop** renderer OOM (macOS, Obsidian 1.12.7/1.13.4) caused by a single huge markdown file; the iOS jetsam reply was appended by a different user. Don't attribute the desktop crash to iOS.

**React OOM patterns (thousands of DOM nodes + large state arrays)**

- ✅ Constant DOM size via virtualization is the recommended mitigation; unbounded append-only lists cause memory to grow linearly; "keep memory usage roughly constant" (Catch Metrics):
  https://www.catchmetrics.io/blog/deep-dive-ram-internals-webkit
- ✅ web.dev canonical guide on list virtualization (react-window): rendering only the visible window improves rendering + scrolling and caps DOM nodes:
  https://web.dev/articles/virtualize-long-lists-react-window
- ✅ React/virtualization references: patterns.dev "List Virtualization": https://www.patterns.dev/vanilla/virtual-lists
- ⚠️ No single source titled "React OOM pattern" beyond the above; the established cause→effect is: many mounted components/DOM nodes + a large retained JS array in state → heap growth → WebKit pressure tier / jetsam.

---

## 5. List virtualization for Obsidian plugins

**FTA's React version**

- ✅ `file-tree-alternative` v2.6.0 `package.json`: `react` and `react-dom` **18.2.0** (also uses `recoil` 0.7.7, `react-lazy-load` 4.0.1, and `million` 2.6.4 as a devDependency; `obsidian` API ^1.4.11):
  https://github.com/ozntel/file-tree-alternative/blob/master/package.json

**react-virtuoso vs react-window (variable-height, bundle, React 17/18 compat)**

- ✅ `react-virtuoso` (current 4.18.19) — peer deps: `react: ">=16 || >=17 || >= 18 || >= 19"`, `react-dom` likewise. Handles variable item heights automatically via ResizeObserver; no itemSize needed; supports sticky headers, infinite scroll, grouped lists:
  https://registry.npmjs.org/react-virtuoso/latest and https://virtuoso.dev/react-virtuoso
- ✅ `react-window` (current 2.3.4) — peer deps `react: "^18.0.0 || ^19.0.0"` (v2 is a rewrite). Historically assumes fixed/known sizes; variable/dynamic heights are supported but flagged as less efficient:
  https://registry.npmjs.org/react-window/latest and https://github.com/bvaughn/react-window
- ✅ Bundle size (independently reported): react-window ≈ 6.2 KB vs react-virtuoso ≈ 15.7 KB:
  https://dev.to/sanamumtaz/react-virtualization-react-window-vs-react-virtuoso-8g
  And a 2026 comparison: ~5 KB vs ~17 KB for the virtualization logic itself:
  https://www.pkgpulse.com/guides/tanstack-virtual-vs-react-window-vs-react-virtuoso-2026
- ⚠️ "Best choice" for variable-height: react-virtuoso is very commonly recommended for automatic variable heights, but see §7 for its iOS caveats, and note TanStack Virtual is a third popular option.

**Obsidian plugins that actually virtualize large vault lists**

- ✅ **Notebook Navigator** (a FTA competitor, community plugin) — replaces the file explorer; "highly optimized, supporting vaults with over 100,000 notes through virtualized rendering and IndexedDB caching… notably mobile-friendly… on iOS and Android." Docs describe "Rendering Architecture — React component hierarchy, **virtual scrolling with TanStack Virtual**" and a "Storage Architecture" using IndexedDB / Local Storage / Memory Cache. So the strongest precedent uses **@tanstack/react-virtual**, not react-virtuoso/react-window.
  https://community.obsidian.md/plugins/notebook-navigator ·
  https://notebooknavigator.com/docs.html ·
  https://forum.obsidian.md/t/set-default-file-explorer-internal-or-plugin-like-notebook-navigator/108593?page=2
- ✅ **Obsidian core File Explorer uses a virtual list.** Strongly indicated by community plugins that integrate with it:
  - "Folder Limit … Keep accurate scrollbars and fast performance via **native virtual-list integration** without DOM mutation observers" / "Deeply integrated into Obsidian's virtual list rendering": https://community.obsidian.md/plugins/folder-limit
  - "File Explorer Filter … switching folders also invalidates **Obsidian's virtual-scroll layout** so the visible rows are recalculated immediately … does not patch `getSortedFolderItems()`": https://community.obsidian.md/plugins/file-explorer-filter
  - ⚠️ This is inferred from plugin docs/integration notes, **not** from an official API doc (Obsidian's virtual list is an internal, non-public class).
- ✅ **Core Search does not cap results by default.** A feature request documents it rendering all results and freezing (30 s, ~3 GB observed on a large vault for a single-letter query), and asks for an optional limit / "load more":
  https://forum.obsidian.md/t/search-core-plugin-limit-number-of-results/116849
- ⚠️ **Dataview does not appear to virtualize.** It is widely reported as a memory/perf cost on large vaults (~300 MB in one measurement; unscoped queries past ~4,000 notes degrade; results render as tables/lists without documented virtualization):
  https://forum.johnnydecimal.com/t/obsidian-version-of-las-causes-big-memory-load-edit-omnisearch-is-a-memory-hog/2810 ·
  https://www.dsebastien.net/the-complete-guide-to-dataview-in-obsidian
- ⚠️ **Omnisearch** is reported as a memory hog (~1.76 GB in one measurement) — no evidence of virtualization:
  https://forum.johnnydecimal.com/t/obsidian-version-of-las-causes-big-memory-load-edit-omnisearch-is-a-memory-hog/2810
- ⚠️ **Core "Recents": could not verify.** Obsidian core has no plugin literally named "Recents"; the well-known recent-files feature is the community **Recent Files** plugin (tgrosinger, 1.2M downloads). Its cap behavior was not verified from source:
  https://community.obsidian.md/plugins/recent-files-obsidian
- ❌ **Smart Connections** virtualization status: not verified.

---

## 6. Upstream status — `ozntel/file-tree-alternative` issue #268 and repo activity

- ✅ Issue **#268 "Bug: Creating a new folder on mobile can cause the vault to crash."** — **OPEN**, **0 comments**, **no labels, no assignees, no linked PRs/branches**, created **2025-10-20**, last updated **2025-10-20** (untouched since):
  https://github.com/ozntel/file-tree-alternative/issues/268 (GitHub API: `state: open`, `comments: 0`, empty timeline)
- ✅ Repo activity: default branch **main**; **`pushed_at` = 2024-06-22**; newest commit = "v.2.6.0 Release", **2024-06-22** → **no code commits since June 2024**. Repo not archived; ~608 stars; ~120 open issues; 53 forks. `package.json` still reads version 2.6.0.
  https://api.github.com/repos/ozntel/file-tree-alternative · https://github.com/ozntel/file-tree-alternative/commits
- ✅ Other **open** mobile-related issues (no fix yet): #261 "Folder Notes on Mobile iOS" (2025-08-20), #258 "[FR] Optimize vertical layout for Mobile" (2025-08-02). Newer open issues exist (#270 hover, 2026-03-11; #269 resizing & sorting, 2026). Issue search for "mobile crash" returns only #268.
  https://github.com/ozntel/file-tree-alternative/issues?q=is%3Aissue+mobile
- ✅ **No linked PR or fix found** for the mobile-crash issue.

---

## 7. react-virtuoso / react-window iOS + Capacitor; IntersectionObserver chunked rendering

**react-virtuoso known iOS issues**

- ✅ Issue **#1094 "[BUG] element disappearing when reverse scrolling in the ios"** (opened 2024-05-29; iOS 16.7.8/17.5.1, Safari + Chrome on iOS). Maintainer: "This is an **inherent problem of the current virtuoso implementation. It is solved in the MessageList** [commercial component] — give it a try." Closed as *completed* (2024-06-02). Maintainer later: "It is solved in Virtuoso — in the MessageList component." A commenter (2025-04-19) asks the docs to state "iOS is not supported by Virtuoso." **The main `Virtuoso` component is fixed only via the commercial MessageList.**
  https://github.com/petyosi/react-virtuoso/issues/1094
- ✅ Issue **#945 "[BUG] iOS Safari glitch on scroll up to items of unknown height"**:
  https://github.com/petyosi/react-virtuoso/issues/945
- ✅ Virtuoso's own troubleshooting docs acknowledge measurement difficulty with reverse-scrolling/dynamic content:
  https://virtuoso.dev/react-virtuoso/troubleshooting
- ⚠️ **Capacitor-specific** issues: none found for react-virtuoso/react-window (Capacitor on iOS uses WKWebView, so the iOS/Safari issues above are the relevant ones). Ionic's own docs demonstrate react-virtuoso inside Ionic (Capacitor) apps and warn about zero-height items:
  https://ionicframework.com/docs/react/virtual-scroll
- ⚠️ react-window v2 (2.3.4) is a recent rewrite; peer deps require React 18/19 (fine for FTA's React 18.2). No iOS-specific bug reports surfaced in this pass.

**IntersectionObserver chunked rendering (no-dependency alternative)**

- ✅ Canonical technique: put a sentinel element at a chunk boundary; an `IntersectionObserver` fires when it enters the (root) viewport, then you append/reveal the next chunk and recycle the sentinel. Google's official sample implements it with sentinel recycling:
  https://googlechrome.github.io/samples/intersectionobserver/index.html ·
  https://web.dev/articles/intersectionobserver
- ✅ SitePoint walkthrough of the sentinel/recycle pattern; MDN reference:
  https://www.sitepoint.com/intersectionobserver-api · https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
- ✅ The "chunk" variant (break N items into chunks of size K, render chunk-by-chunk as each chunk's sentinel becomes visible) is described in a worked example:
  https://www.youtube.com/watch?v=AkI90RGs4bw ("List Virtualisation with intersection observer")
- ⚠️ Performance note: prefer **one shared observer** over one observer per element:
  https://www.bennadel.com/blog/3954-intersectionobserver-api-performance-many-vs-shared-in-angular-11-0-5.htm
- ❌ **No Obsidian-plugin precedent** for IntersectionObserver chunked rendering of the file list was found. (Notebook Navigator instead uses TanStack Virtual.)

---

## Quick fact table

| Claim | Status | Key source |
|---|---|---|
| `TFile.stat.mtime` available without reading contents | ✅ | obsidian.d.ts; forum/110122 |
| `stat` can be briefly stale right after a write | ⚠️ | forum/113139 |
| MetadataCache cached paths (getFileCache/resolvedLinks/getFirstLinkpathDest) avoid vault walks | ✅ | docs MetadataCache |
| Only Vault events: create/modify/delete/rename (no `modified`) | ✅ | obsidian.d.ts |
| `modify` fires per save (~2 s autosave), not per keystroke | ✅ | autosave-control; shellcommands docs |
| `editor-change` = per editor change | ✅ | obsidian.d.ts; forum/68617 |
| Official `debounce()` utility; debounce recommended for modify | ✅ / ⚠️ | docs/debounce; shellcommands docs |
| `Platform.isMobile` standard gate; mobile = Capacitor/WKWebView | ✅ | docs Platform; Mobile development |
| `requestIdleCallback` unavailable by default in Safari/WKWebView (still flag-gated, Jul 2026) | ✅ | MDN BCD #24573 / PR #30001; caniuse |
| localStorage unreliable on iOS (storage-pressure eviction); vault-scoped helpers since 1.8.7 | ✅ | forum/17542; docs loadLocalStorage |
| `saveData` async (Promise), writes data.json via adapter | ✅ | docs Plugin/saveData |
| iOS WKWebView heap ~300–450 MB typical; 1 GB+ on iPhone 15+ | ✅ | catchmetrics (Jan 2026) |
| Obsidian iOS jetsam kills documented | ✅ | forum/113527 (⚠️ AI-labeled); remotely-save #1188; livesync #680 |
| FTA uses React 18.2.0 | ✅ | FTA package.json |
| react-virtuoso React 18 OK, ~16–17 KB | ✅ | npm; dev.to; pkgpulse |
| Notebook Navigator virtualizes 100k+ notes with TanStack Virtual + IndexedDB | ✅ | community/notebook-navigator; notebooknavigator.com/docs |
| Obsidian core File Explorer uses a virtual list | ⚠️ inferred | folder-limit; file-explorer-filter |
| Core Search does not cap results | ✅ | forum/116849 |
| Dataview / Omnisearch do not virtualize (high memory) | ⚠️ | johnnydecimal forum |
| FTA issue #268 open, no comments/PR; repo dormant since 2024-06-22 | ✅ | GitHub API; commits |
| react-virtuoso iOS reverse-scroll bug; fixed only in commercial MessageList | ✅ | react-virtuoso #1094, #945 |
| IntersectionObserver chunked/sentinel rendering is a no-dependency pattern | ✅ (no Obsidian precedent) | Google sample; web.dev; MDN |

## Could not verify

- ❌ An official Obsidian docs page explicitly **deprecating/discouraging localStorage** (only vault-scoped helpers + community guidance found).
- ❌ Core "Recents" plugin existence/cap (the well-known one is the community **Recent Files** plugin; its cap not verified from source).
- ❌ Smart Connections virtualization status.
- ❌ Direct test of `requestIdleCallback` on the newest shipping Safari 26.x/27.x (latest primary data, Jul 2026, says flag still off by default).
- ❌ An official API entry confirming the file explorer's internal virtual list (inferred from plugin integrations only).
- ⚠️ The single clearest Obsidian-iOS jetsam console log (forum thread 113527, post #6) is in a reply the author labels AI-generated; the raw log lines are quoted but the framing is unverified.
