# Obsidian mobile duplicate-leaf / duplicate-pane accumulation — root cause research

**Scope:** why a plugin's registered view (e.g. `file-tree-view`) ends up as N duplicate panes/tabs over
time on Obsidian mobile, apparently one per app re-foreground, and what the correct single-instance
pattern is. Researched Nov 2026. Sources: GitHub issues, forum.obsidian.md, docs.obsidian.md, and
**direct inspection of the shipped Obsidian bundle** (`/Applications/Obsidian.app/Contents/Resources/obsidian.asar`
→ `app.js`, Obsidian 1.9.x desktop build, minified but readable). Bundle evidence is marked `[BUNDLE]`
and is stronger than any doc/forum claim because it is the actual implementation.

---

## 0. TL;DR — the ranked answer

| # | Cause | Confidence |
|---|-------|-----------|
| 1 | **`plugin.registerView()` called after the workspace already has leaves of that type** (late registration: lazy loading, or an `await` before `registerView` inside `onload`). Obsidian reacts to the `view-registered` event by **re-opening every existing leaf of that type as an `EmptyView`** (`getViewType() === "empty"`), then re-applying the saved state *asynchronously*. Inside that window `workspace.getLeavesOfType(type)` returns `[]`, so an auto-open in `onLayoutReady` creates a second leaf. Next start → 2 saved leaves → same window → 3, etc. | **High** (bundle code + matching issue reports) |
| 2 | **`workspace.getLeftLeaf(false)` is a leaf *creator*, not a getter.** It never returns an existing leaf of your type; every call inserts a brand-new `WorkspaceLeaf` (a new tab in the sidebar's tab group, or a new child of the mobile drawer). Calling it when your leaf exists but is momentarily invisible to `getLeavesOfType()` = guaranteed duplicate. | **Very high** (bundle code, unambiguous) |
| 3 | Naive dedupe is blind during the window in (1) because `getLeavesOfType` filters on `leaf.view.getViewType()` and the blanked leaf reports `"empty"`. Dedupe that also runs on `layout-change` therefore cannot prevent creation, only clean up later — and it may keep the wrong leaf. | **High** |
| 4 | Amplifiers: Lazy Plugin Loader ("delayed"/"short delay" loading), plugin auto-update/Hot-Reload re-runs `onload` after layout is already restored, and mobile OS process kills (every re-foreground = a full cold start). | **High** |

Not the cause (myths to drop):

- **Deferred views are NOT invisible to `getLeavesOfType`.** `DeferredView.getViewType()` returns the
  real saved type `[BUNDLE]`, so `getLeavesOfType()` finds them. What breaks is
  `leaf.view instanceof MyView` (false while deferred) — that is a different trap.
- **`onload` is not re-run on resume.** Plugins load once per process start `[BUNDLE]`; the mobile
  `resume` event is used internally *only* to check for plugin updates.

---

## 1. Mobile lifecycle: what actually happens on background / re-foreground

### 1.1 Plugin `onload` is not re-run on resume
`[BUNDLE]` In the community-plugin manager's `initialize()`:

```js
S.isMobileApp && ei.addListener("resume", () => {
  !this.autoCheckForUpdates || !this.isEnabled() || Date.now() > this.lastUpdateCheck + 4320*60*1e3 && this.checkForUpdates(!0)
});
```

`ei = Zn("App")` (Capacitor `App` plugin) — so the *only* thing Obsidian does on mobile `resume` is a
throttled update check. No plugin reload, no layout re-deserialisation, no view recreation.

⇒ If the process survived backgrounding, **nothing is recreated and no duplicate can appear**.
Duplicates track *cold starts*, not foregrounds.

### 1.2 Why mobile "re-foreground" usually equals a cold start
Mobile OSes kill Obsidian under memory pressure, so returning to the app is a full launch: plugin
`onload` → `onLayoutReady` → workspace deserialise from `workspace-mobile.json`.

- Forum bug report (Android, reproducible): <https://forum.obsidian.md/t/mobile-application-reloads-after-switching-to-a-different-app-and-then-immediately-back-to-obsidian/74484> — "Expected result: Obsidian does not reload. Actual result: Obsidian reloads." Moderator reply: "This is due to the OS killing what it perceives as memory intensive applications."
- Same class on iOS: <https://forum.obsidian.md/t/frequent-reloads-on-ios-with-official-sync-request-to-optimize-memory-usage-in-obsidian-for-ios/88015>, <https://forum.obsidian.md/t/constant-reloads-on-mobile-ios/81780>.

Practical consequence: **reproduction rate = cold-start rate.** A bug that is "once per launch" *looks*
like "once per re-foreground" on a phone.

### 1.3 Boot order (why "onLayoutReady is too early" is usually false, and when it is true)
`[BUNDLE]` App boot:

```js
await a.initialize()                 // ← community plugins are enabled here (awaited, sequential)
…
await this.metadataCache.initialize()
pn.instance.setMessage(...loadingWorkspace())
await r.loadLayout()                 // ← workspace deserialise happens AFTER plugins load
```

`[BUNDLE]` `Workspace.setLayout()` ends with:

```js
let b=[];
this.iterateAllLeaves(v => { v.isVisible() && b.push(loadIfDeferred(v).catch(...)) });
await Promise.all(b);
this.layoutReady = true;
this.onLayoutChange();
this.requestActiveLeafEvents();
```

`[BUNDLE]` `onLayoutReady(cb)`:

```js
onLayoutReady(e){ this.onLayoutReadyCallbacks === null ? e() : this.onLayoutReadyCallbacks.push({pluginId, callback:e}) }
```

and the callbacks are flushed (with `await sleep(0)` between them) when `layout-ready` fires, i.e. after
`setLayout()` completed.

So in the **normal** (non-lazy) case: `registerView` happens before any leaf exists, `onLayoutReady`
happens after restore → `getLeavesOfType` is correct → no duplicate. A plugin only hits the race if its
`registerView` lands **after** leaves of its type already exist, which happens when:

- Lazy Plugin Loader defers the plugin (community-documented trigger for exactly this bug, see §4);
- the plugin is (re)enabled / updated / hot-reloaded while its pane is open;
- `onload` awaits something slow **before** `registerView` (our fork awaits `loadSettings()` and runs
  `clearOZFileCache()` before `registerView` — see §7).

### 1.4 Is there a real "`getLeavesOfType` returns [] while a saved leaf exists" race?
**Yes**, but the mechanism is *not* deferred views and *not* "restore hasn't run yet". It is the
`view-registered` handler described in §2. Forum confirmation from an Obsidian dev (`the_tree`):

> "You should register `VIEW_TYPE_TASKBOARD` directly in `plugin.onload` instead of in
> `workspace.onLayoutReady`. **`plugin.registerView` will replace all existing Views of this type with
> EmptyView**"
> — <https://forum.obsidian.md/t/bug-custom-views-are-not-detected-while-opening-obsidian-in-onlayoutready-callback/112337>

That sentence is literally true, and the implementation is in the next section.

---

## 2. The smoking gun: `view-registered` blanks existing leaves to `EmptyView`

`[BUNDLE]` The workspace subscribes to the view registry:

```js
let r = l => {                                  // l = view type
  let c = this.getLeavesOfType(l);
  for (let d of c) {
    if (d.view instanceof Cl) continue;          // skip DeferredView
    let h = d.getViewState();                    // capture {type,state,icon,title}
    (async () => { await d.open(new Jr(d)); await d.setViewState(h); })();
  }
};
this.app.viewRegistry.on("view-registered", r);
this.app.viewRegistry.on("view-unregistered", r);
```

`Cl` = `DeferredView`, `Jr` = `EmptyView`. And `[BUNDLE]`:

```js
var Jr = class extends Ot {  // EmptyView
  getViewType(){ return "empty" }            // ← NOT the plugin's type
  getDisplayText(){ return y.interface.labelNewTab() }
```

`[BUNDLE]` `WorkspaceLeaf.open(view)` swaps `this.view` **synchronously** before its first `await`:

```js
async open(e){ let {view:i}=this; if(e===i) return e;
  if(i){ const n=i.close(); i instanceof Cl || i instanceof Jr || await n }   // close NOT awaited for deferred/empty
  this.containerEl.setChildrenInPlace([this.resizeHandleEl]);
  this.view = e;                             // ← view is now EmptyView, synchronously
  try { await e.open(this.containerEl) } catch …
}
```

`[BUNDLE]` And `getLeavesOfType` filters on the *view*:

```js
getLeavesOfType(e){ let i=[]; return this.iterateAllLeaves(r=>{ r.view.getViewType()===e && i.push(r) }), i }
```

### Consequences (all bundle-verified)

1. Calling `plugin.registerView(type, factory)` when leaves of `type` already exist **synchronously**
   turns each of them into an `EmptyView` whose `getViewType()` is `"empty"`, and only *later*
   (next microtask/async continuation) restores them via `setViewState(savedState)`.
2. During that window `workspace.getLeavesOfType(type) === []` **even though the leaves exist**.
   Any `if (leaves.length === 0) createLeaf()` executed in that window creates a duplicate.
3. `leaf.getViewState()` during the window also reports `{type:"empty"}` — so even the "read the saved
   state instead of `getViewType()`" workaround fails *inside* the window. Only `leaf.view instanceof
   FileTreeView` still works (but is false for legitimately deferred leaves).
4. Nothing reconciles afterwards: Obsidian does not merge the extra leaf. The workspace is saved
   (debounced 1 s, `requestSaveLayout`) with **both** leaves → next start restores both → the same
   window re-runs on 2 leaves → 3, 4, 5 … Monotonic accumulation, exactly the reported symptom.
5. `WorkspaceLeaf.setViewState` is guarded by a re-entrancy flag:
   `async setViewState(e,i){ if(!this.working){ … } }` → if a plugin calls `setViewState` on a leaf
   while Obsidian's own restore IIFE is mid-flight on it, the plugin's call is **silently dropped**
   (no error, no view). This is a second, quieter symptom of the same race ("pane doesn't open").

Related `[BUNDLE]` behaviour of `Plugin.registerView` on unload:

```js
registerView(e,i){ this.app.viewRegistry.registerView(e,i);
  this.register(() => { this.app.viewRegistry.unregisterView(e);
                        this._userDisabled && this.app.workspace.detachLeavesOfType(e) }) }
```
→ leaves are only detached on **user disable**, not on update/reload. This is the correct behaviour and
matches liamcain's guidance (§3). Do not add your own `detachLeavesOfType` in `onunload`.

---

## 3. `getLeftLeaf(false)` on mobile — a creator, never a getter

`[BUNDLE]` (identifiers resolved against the class table: `Or` = MobileDrawer, `Mr` = WorkspaceSplit,
`Je` = WorkspaceTabs, `Mo` = WorkspaceSidedock, `Tt` = WorkspaceLeaf):

```js
getLeftLeaf(e){ return this.getSideLeaf(this.leftSplit, e) }
getRightLeaf(e){ return this.getSideLeaf(this.rightSplit, e) }

getSideLeaf(e,i){                       // e = sidebar, i = "split" flag
  if (e instanceof Or) {                 // mobile drawer
    let n = new Tt(this.app); e.insertChild(-1, n); return n;      // ← new leaf, every call
  }
  if (i) {                               // split === true → new tab group + leaf
    let n = new Je(this); e.insertChild(-1,n);
    let a = new Tt(this.app); n.insertChild(-1,a); return a;
  }
  e.children.length === 0 && e.insertChild(0, new Je(this));
  let r = e.children[0];
  if (r instanceof Mr) {                 // existing tabs group / split / drawer
    let n = new Tt(this.app); r.insertChild(-1, n); return n;      // ← new tab/child, every call
  }
  return null;
}
```

Answers to the specific questions:

- **Does it return an existing leaf?** No. `getLeftLeaf(false)` means "don't create a *new tab group*",
  not "reuse the current leaf". It always inserts a fresh `WorkspaceLeaf`.
- **Can calling it during restore create a stray leaf that later coexists with the restored leaf?** Yes —
  that is precisely what happens when it is called while `getLeavesOfType` is momentarily empty (§2).
- **Mobile specifics:** `workspace.leftSplit` is a sidedock whose first child is normally a
  `WorkspaceTabs`, so the new leaf becomes an extra **tab in the left drawer**. If the drawer itself is
  the split (`Or`), the new leaf is appended as a **sibling child of the drawer** — on mobile that reads
  as an extra pane in the drawer, which is the visual in the reports. Either way it is a *new* pane,
  not a reuse.
- Also note `getSideLeaf` returns `null` if `children[0]` is neither a split nor tabs — hence the
  `if (!leaf) { new Notice(...) }` guards people write.

**Preferred API:** `workspace.ensureSideLeaf(type, side, {active, reveal, split, state})` (public since
1.7.2) does the right thing — `[BUNDLE]`:

```js
async ensureSideLeaf(e,i,r){ let {active:n,split:a,reveal:s=!0,state:l}=r||{};
  let c=this.getLeavesOfType(e), d;
  c.length===0 ? (d = i==="left" ? this.getLeftLeaf(a) : this.getRightLeaf(a)) : d=c[0];
  (n||s) && await d.loadIfDeferred();
  (l || d.view.getViewType()!==e) && await d.setViewState({type:e,state:l});
  s && await this.revealLeaf(d);
  n && this.setActiveLeaf(d,{focus:!0});
  return d }
```

But it shares the same blind spot: it trusts `getLeavesOfType`, so during the §2 window it also creates
a second leaf. `ensureSideLeaf` is a convenience, not a guard against the race.

---

## 4. Known issues: `file-tree-alternative` and siblings

### Upstream FTA (ozntel/file-tree-alternative — note: repo is **not** `obsidian-file-tree-alternative`)
- **#253 "File Tree Alternative icon keeps reappearing"** (open→closed, 2025-05/06):
  <https://github.com/ozntel/file-tree-alternative/issues/253>
  The reporter pastes `workspace-mobile.json` showing **five+** leaves with
  `"type": "file-tree-view"`, `"state": {}`, `"title": "Plugin no longer active"` — i.e. the ghost
  panes from §2 persisted in the mobile layout file. Root-causing by commenters:
  - `huyz`: "Same as https://github.com/delashum/obsidian-checklist-plugin/issues/199"
  - `jankoweb`: "I am using Lazy Plugin Loader. I will try to set File Tree as Instant." → "It seems
    that it solved the problem :)"
  Closed without an upstream code fix; the resolution was the lazy-loader workaround.
- **No upstream fix exists.** `master` `src/main.ts` (254 lines, checked 2026-11) still has the naive
  pattern: `getLeavesOfType` → if empty `getLeftLeaf(false)` → `setViewState`, with **no dedupe and no
  `Platform` handling**. Upstream is active (2.6.2/2.6.3/2.6.4 shipped Oct 28 – Nov 1 2026) but the
  view-lifecycle code is untouched.
- Adjacent mobile issues (context, not this bug): #268 (new folder on mobile crashes vault),
  #222 (hold menu flashes), #258 (vertical layout).

### Sibling plugins with the identical bug (same shape, different view)
- **obsidian-checklist-plugin #199** "Plugin no longer active added to sidebar with every restart"
  <https://github.com/delashum/obsidian-checklist-plugin/issues/199> — "Each time I restart the Obsidian
  Android app, the right sidebar has a new 'Plugin no longer active'… I've had more than 30 of these…
  at which point startup has slowed down by several seconds." Directly cross-linked with FTA #253.
  Comment `huyz` (2025-10): "the plugin's `onload()`: the code checks that there is no pane already
  open before deciding to open one. This would also explain why this issue affects several other plugins."
  Maintainer (2026-09): PR #216 "preserves registered leaves across plugin reloads, avoids activating new
  panes during startup, and safely handles deferred views… The Android/Lazy Plugin Loader duplication
  scenario has not been reproduced."
  PR #216: <https://github.com/delashum/obsidian-checklist-plugin/pull/216> — the actual diff is the
  canonical fix (§5).
- **obsidian-lazy-plugins #12** "Plugin no longer active in menu"
  <https://github.com/alangrainger/obsidian-lazy-plugins/issues/12> — explicitly names File Tree:
  "I think it is File Tree where I get Plugin no longer active entries… It seems I get a new entry
  saying the same thing so this list keeps getting longer and longer." Author's answer: set the plugin
  to "Instant".
- **Forum (mobile, generic):** "Add a way to close all inactive plugin views / Phone — Plugin no longer
  active fills up the right side panel"
  <https://forum.obsidian.md/t/add-a-way-to-close-all-inactive-plugin-views-phone-plugin-no-longer-active-fills-up-the-right-side-panel/96233>
  (Obsidian 1.7.7, iOS/Android). Also <https://forum.obsidian.md/t/erroneous-plugin-no-longer-active-message/94936>.
- Searched and found **nothing**: `obsidianmd/obsidian-releases` issues (that repo is for plugin
  submissions/releases, not bug reports — bugs live on the forum), obsidian-tracker, calendar,
  recent-files-omniseek (`kelszo/recent-files-omniseek` is not publicly accessible for issue search).

---

## 5. Canonical fix pattern (and the official sample)

### 5.1 The official sample — liamcain (Obsidian core dev)
<https://github.com/liamcain/obsidian-example-custom-view/blob/main/src/main.ts>

```ts
onunload(): void {
  // Important: Do not detach leaves with your custom view in onunload. ... (update flow)
}
async onload(): Promise<void> {
  this.registerView(EXAMPLE_VIEW_TYPE, (leaf) => new ExampleView(leaf, this)); // FIRST, no awaits before it
  …
  this.app.workspace.onLayoutReady(() => {
    // Note: don't make the leaf active onload.
    this.ensureLeafExists(false);
  });
}
ensureLeafExists(active = false) {
  let leaf: WorkspaceLeaf;
  const existing = workspace.getLeavesOfType(EXAMPLE_VIEW_TYPE);
  if (existing.length > 0) { leaf = existing[0]; }
  else {
    leaf = preferredSidebar === 'left' ? workspace.getLeftLeaf(false) : workspace.getRightLeaf(false);
    workspace.revealLeaf(leaf);
    leaf.setViewState({ type: EXAMPLE_VIEW_TYPE });
  }
  if (active) workspace.setActiveLeaf(leaf);
}
```
Derived rules (also in <https://docs.obsidian.md/Plugins/User+interface/Views> and
<https://docs.obsidian.md/Plugins/User+interface/Workspace>):
1. `registerView` as the **first statement** of `onload`, never inside `onLayoutReady`, never after an
   `await`.
2. Create the leaf only from `onLayoutReady`, with `active: false`.
3. Never `detachLeavesOfType` in `onunload`.
4. Never cache `view` instances; re-fetch with `getLeavesOfType` + `instanceof`.

### 5.2 The fix that also survives the §2 window (what I'd ship in this fork)
The sample is still vulnerable because it trusts a single `getLeavesOfType` call. Three changes:

**(a) Register first, synchronously.**
Move `this.registerView(...)` to the top of `onload()` — before `await this.loadSettings()`,
`clearOZFileCache()`, `loadRecentFoldersCache()`. This alone removes the trigger for our fork in the
normal path (it currently registers *after* two awaits — see §7).

**(b) Detect via three signals, not one, and wait a beat before creating.**
```ts
private findMyLeaves(): WorkspaceLeaf[] {
  const ws = this.app.workspace;
  const found = new Set<WorkspaceLeaf>(ws.getLeavesOfType(this.VIEW_TYPE));
  ws.iterateAllLeaves((leaf) => {
    // catches ghost/unknown panes (Rp: keeps original type) and any leaf mid-restore
    if (leaf.getViewState()?.type === this.VIEW_TYPE) found.add(leaf);
    if (leaf.view instanceof FileTreeView) found.add(leaf);
  });
  // last resort: leaves we know we created and Obsidian is currently blanking to EmptyView
  for (const l of this.knownLeaves) if (l.view?.getViewType?.() === 'empty') found.add(l);
  return [...found];
}
```

**(c) Defer creation until the layout settles, and never create twice in a row.**
```ts
private pendingOpen = false;

private ensureLeaf(active: boolean) {
  if (this.findMyLeaves().length > 0) { this.revealFirst(active); return; }

  // The layout can be mid-rebuild (layout-change / view-registered window).
  // Give Obsidian one animation frame + one task to finish, then re-check before creating.
  if (!this.pendingOpen) {
    this.pendingOpen = true;
    window.requestAnimationFrame(() => setTimeout(() => {
      this.pendingOpen = false;
      if (this.findMyLeaves().length > 0) { this.revealFirst(active); return; }
      this.createLeaf(active);            // only here, once
    }, 0));
  }
}

private async createLeaf(active: boolean) {
  const leaf = this.app.workspace.getLeftLeaf(false);   // creator: call at most once per ensure
  if (!leaf) return;
  this.knownLeaves.add(leaf);
  this.register(() => this.knownLeaves.delete(leaf));
  await leaf.setViewState({ type: this.VIEW_TYPE });    // no `active: true` at startup
  await this.app.workspace.revealLeaf(leaf);            // revealLeaf uncollapses the mobile drawer + awaits loadIfDeferred
}
```

**(d) Make dedupe type-aware and quiet.** Current `deduplicateFileTreeLeaves()` keeps `leafs[0]` and
detaches the rest on **every** `layout-change`. Two problems: it cannot see leaves inside the §2 window
(`getLeavesOfType` is empty then), and it runs on a hot event. Better: run it only after
`layoutReady` and with a debounce, and prefer detaching leaves that are **not** the user's visible one:

```ts
this.registerEvent(this.app.workspace.on('layout-change', () => {
  clearTimeout(this.dedupeTimer);
  this.dedupeTimer = window.setTimeout(() => {
    if (!this.app.workspace.layoutReady) return;
    const leaves = this.findMyLeaves();
    if (leaves.length < 2) return;
    const keep = leaves.find(l => l.view instanceof FileTreeView && l.view.containerEl.isShown()) ?? leaves[0];
    for (const l of leaves) if (l !== keep) l.detach();
  }, 250);
}));
```

**Bonus:** `Workspace.getViewState()` / `leaf.getViewState()` also records a `title`, which is what ends
up as `"Plugin no longer active"` in `workspace-mobile.json`. Ghost panes (`Rp`) keep the original type,
so `getViewState().type` is the reliable identifier once the window has closed; inside the window only
`knownLeaves` + `instanceof` help.

### 5.3 Migration/cleanup for users already affected
Ship a one-shot migration: on load, if `findMyLeaves().length > 1`, detach all but one (guarded to run
once per version, after `layoutReady` + 1 s). Also worth documenting the manual escape hatch that
Obsidian now provides: the ghost pane's own "Close all N tabs" button
`[BUNDLE]` `Rp.onOpen()` → button text `emptyState.closeAll({id,count})` → `for (const n of getLeavesOfType(viewType)) n.detach()`, and the forum workaround of long-pressing the sidebar icon to dismiss.

---

## 6. `leaf.detach()` during `layout-change` — recursion? 

**No public bug report found**, and the bundle suggests synchronous recursion is impossible:

- `[BUNDLE]` `layout-change` is emitted through a debounced gateway:
  `this.requestLayoutChangeEvents = $(() => this.layoutReady && this.trigger("layout-change"), 10)`
  → coalesced at 10 ms **and suppressed entirely while `layoutReady === false`**, so a handler cannot
  fire in the middle of deserialisation.
- `[BUNDLE]` `WorkspaceLeaf.detach()`:
  ```js
  detach(){ let e=this.parent?.id, i=this.getRoot().id;
    super.detach();                                  // parent.removeChild(this) — DOM + tree surgery, sync
    … n && (this.workspace.pushUndoHistory(this,e,i), n.close(), this.view=this._empty); … }
  ```
  `WorkspaceTabs.removeChild` calls `this.workspace.onLayoutChange(this)`, which schedules another
  (debounced) `layout-change` → your handler runs again ~10 ms later, sees 1 leaf, no-ops. So it
  *re-enters* but converges; it does not stack-overflow.
- Real, lower-probability risks (mark as **unverified**, no report found):
  - `view.close()` is called but not awaited inside `detach()`; calling `destroy()` yourself first (as
    the current fork does) means `close()` runs against an already-destroyed view.
  - detaching while Obsidian still holds the leaf in a deserialisation/restore queue (e.g. detaching
    from `onLayoutReady` or from `openFileTreeLeaf`, not from `layout-change`) can lose a pane the user
    expected, or produce `Cannot read properties of null` style errors.
  - Detaching the leaf that Obsidian is about to re-open (`view-registered` IIFE) can resurrect a leaf
    after you killed it, or leave `leaf.working === true`.
  Recommendation: **do not detach inside the handler.** Debounce ~250 ms, check `layoutReady`, and keep
  the visible leaf. That is also cheap (no work on every resize/scroll-driven layout change).

---

## 7. This fork's code vs. the pattern (concrete)

`src/main.ts` (2.6.1 fork, current branch `main`):

| Line | Code | Problem |
|------|------|---------|
| 42–47 | `await this.loadSettings(); clearOZFileCache(); this.loadRecentFoldersCache();` | **before** `registerView` → if the plugin ever loads late (lazy loader, reload, sync-triggered reload) `registerView` fires `view-registered` on existing leaves → §2 window → `getLeavesOfType()` empty → duplicate |
| 50 | `this.registerView(this.VIEW_TYPE, …)` | should be the first statement of `onload` |
| 55–74 | `onLayoutReady(() => openFileTreeLeaf(true))` | creates with `active`/reveal on startup; canonical sample says `active: false` at startup |
| 78–82 | `on('layout-change', () => this.deduplicateFileTreeLeaves())` | un-debounced, unguarded; cannot see leaves during the window; keeps `leafs[0]` blindly |
| 438–450 | `deduplicateFileTreeLeaves()` | `getLeavesOfType` only → blind to EmptyView window; `view.destroy()` then `leaf.detach()` (double close) |
| 452–484 | `openFileTreeLeaf()` | `if (leafs.length === 0) getLeftLeaf(false)` → the exact create-on-empty race |
| 467 | `getLeftLeaf(false)` | creator; also, on mobile, appends a new tab/child to the drawer |
| 486–494 | `detachFileTreeLeafs()` used by `refreshTreeLeafs()` | a full detach+recreate cycle on refresh is what "resurrects" panes in the wrong place and can race restore; prefer reusing the existing leaf |

Minimal-diff fix order: (1) move `registerView` to line ~1 of `onload`; (2) replace the `getLeavesOfType`
check with `findMyLeaves()` (§5.2b); (3) route all creations through `ensureLeaf()` with the rAF+timeout
re-check; (4) debounce dedupe to 250 ms and prefer the visible leaf; (5) add a one-shot cleanup for users
with N>1 already saved.

---

## 8. Public API surface for "resume"/lifecycle (question 6)

- **There is no `workspace.on('resume')` and no app-state event in the public API.** `obsidian.d.ts`
  (11,539 lines, master) contains no `resume`, `visibilitychange`, `appState` symbols. Workspace events
  are exactly: `quick-preview`, `resize`, `active-leaf-change`, `file-open`, `layout-change`,
  `window-open`, `window-close`, `css-change`, `file-menu`, `files-menu`, `url-menu`, `editor-menu`,
  `editor-change`, `editor-paste`, `editor-drop`, `quit`.
- `Workspace.onLayoutReady(cb)` / `workspace.layoutReady` is the only official "startup finished" hook
  (<https://docs.obsidian.md/Reference/TypeScript+API/Workspace/onLayoutReady>,
  <https://docs.obsidian.md/Reference/TypeScript+API/Workspace/layoutReady>).
- `Platform.isMobile / isMobileApp / isIosApp / isAndroidApp` are public and fine for capability gating
  (<https://docs.obsidian.md/Reference/TypeScript+API/Platform>).
- **Unofficial but available:** Obsidian mobile is Capacitor-based and Obsidian itself uses
  `Capacitor.Plugins.App.addListener('resume', …)` `[BUNDLE]`. Plugins can do
  `(window as any).Capacitor?.Plugins?.App?.addListener('resume', cb)` or
  `this.registerDomEvent(document, 'visibilitychange', …)`. Both are **undocumented and unsupported**;
  do not build the fix on them. For this bug they are unnecessary — duplicate creation is tied to cold
  starts, and every cold start already goes through `onLayoutReady`.
- `revealLeaf` is `Promise<void>` since **1.7.2** and is documented to "uncollapse" a sidebar and to
  "`await` this function to ensure your view has been fully loaded and is not deferred". Prefer
  `await workspace.revealLeaf(leaf)` over `setViewState({active:true})`: `[BUNDLE]` revealLeaf handles
  `Mo.collapsed → expand()`, `Or` (mobile drawer) → `openLeaf + expand + collapse the opposite drawer`,
  `Je.selectTab`, and `await leaf.loadIfDeferred()`.

---

## 9. Confidence & gaps

| Claim | Confidence | Basis |
|---|---|---|
| `getLeavesOfType` filters on `leaf.view.getViewType()` | Certain | bundle source |
| `registerView` after leaves exist blanks them to `EmptyView` (`"empty"`) then restores async | Certain | bundle source + dev forum post |
| `getLeftLeaf(false)` always creates a new leaf/tab | Certain | bundle source + official docs wording |
| `DeferredView` keeps the real view type → visible to `getLeavesOfType` | Certain | bundle source; note it *contradicts* a widespread forum assumption |
| `onload` not re-run on mobile resume | High | bundle: resume handler only checks updates |
| Duplicates persist via debounced 1 s `requestSaveLayout` into `workspace-mobile.json` | High | bundle + FTA #253 JSON |
| No synchronous recursion from detach-in-`layout-change` | Medium-high | bundle debounce + no reports; no instrumented test run |
| Exact per-device trigger (why *this* phone, *this* plugin) | Medium | inferred; Lazy Plugin Loader is confirmed by two reporters, but the maintainer of checklist could not reproduce the Android case |
| Whether Obsidian mobile ever defers `loadLayout()` past `onLayoutReady` | **Unverified** | boot code shows plugins→layout order, but I did not test mobile build |

**Not verified / could not test:** I could not run an actual Obsidian mobile build (no device/emulator
here), so the mechanism is proven from the shipped desktop bundle of the same version line plus
cross-plugin issue reports. Before shipping, the cheap confirmation is a log line —
`console.log(this.app.workspace.getLeavesOfType(VIEW_TYPE).length, leaf.getViewState())` inside
`onLayoutReady` and inside a `view-registered` listener — on a device with Lazy Plugin Loader set to
"Short delay": expect `0` followed by the restored leaf.

---

## 10. Source list

- docs.obsidian.md — Workspace (leaf lifecycle, "plugins are responsible for removing leaves"):
  <https://docs.obsidian.md/Plugins/User+interface/Workspace>
- docs.obsidian.md — Views (`activateView` pattern, "never manage references to views"):
  <https://docs.obsidian.md/Plugins/User+interface/Views>
- docs.obsidian.md — Defer views (1.7.2 `DeferredView`, `instanceof` requirement, `revealLeaf`/`loadIfDeferred`):
  <https://docs.obsidian.md/plugins/guides/defer-views>
- docs.obsidian.md — `getLeftLeaf`: <https://docs.obsidian.md/Reference/TypeScript+API/Workspace/getLeftLeaf>
- docs.obsidian.md — `revealLeaf`: <https://docs.obsidian.md/Reference/TypeScript+API/Workspace/revealLeaf>
- docs.obsidian.md — `onLayoutReady` / `layoutReady`:
  <https://docs.obsidian.md/Reference/TypeScript+API/Workspace/onLayoutReady>
- forum.obsidian.md — "Custom views are not detected … in onLayoutReady callback" (dev answer):
  <https://forum.obsidian.md/t/bug-custom-views-are-not-detected-while-opening-obsidian-in-onlayoutready-callback/112337>
- forum.obsidian.md — "Plugin no longer active fills up the right side panel" (mobile):
  <https://forum.obsidian.md/t/add-a-way-to-close-all-inactive-plugin-views-phone-plugin-no-longer-active-fills-up-the-right-side-panel/96233>
- forum.obsidian.md — "Mobile application reloads after switching to a different app":
  <https://forum.obsidian.md/t/mobile-application-reloads-after-switching-to-a-different-app-and-then-immediately-back-to-obsidian/74484>
- GitHub — FTA #253: <https://github.com/ozntel/file-tree-alternative/issues/253>
- GitHub — checklist #199: <https://github.com/delashum/obsidian-checklist-plugin/issues/199>; PR #216:
  <https://github.com/delashum/obsidian-checklist-plugin/pull/216>; issue #166 (canonical-view best practices request):
  <https://github.com/delashum/obsidian-checklist-plugin/issues/166>
- GitHub — lazy-plugins #12: <https://github.com/alangrainger/obsidian-lazy-plugins/issues/12>
- GitHub — liamcain canonical sample: <https://github.com/liamcain/obsidian-example-custom-view/blob/main/src/main.ts>
- Local: `obsidian.d.ts` (obsidianmd/obsidian-api master, 11,539 lines) and
  `/Applications/Obsidian.app/Contents/Resources/obsidian.asar` → `app.js` (1.9.x bundle).
