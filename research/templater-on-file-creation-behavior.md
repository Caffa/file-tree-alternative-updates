# Research: Templater "Trigger on new file creation" — actual behavior & regression analysis

**Date:** 2026-08-11
**Scope:** `file-tree-alternative` plugin — regression after switching `createNewMarkdownFile` from `fileManager.createNewMarkdownFile` + `vault.modify` to a single atomic `vault.create(path, content)`.
**Verified against:** Templater `master` source (fetched 2026-08-11), `obsidian.d.ts` (master), plugin git history.

---

## TL;DR (answer first)

1. **Templater does NOT patch `app.fileManager.createNewMarkdownFile`.** It listens to `vault.on('create')` and, after a hard-coded `delay(300)`, reads the file and decides what to do. So both the old and new API fire Templater identically — the API choice is **not** the cause of Templater not applying.

2. **The regression is caused by the file already containing body content.** Templater's folder/regex template branch only runs when `content_size == 0`, where `content_size = file_content.length - frontmatter_info.contentStart`. **Frontmatter is excluded from the count, but body content (like your `# Header`) is not.** So:
   - File created **empty** → `content_size == 0` → folder/regex template applies → `tp.file.rename` runs → file renamed. ✅
   - File created with **frontmatter only** (`---\ncreated: ...\n---`) → `contentStart` points past the closing `---`, `content_size == 0` → template STILL applies. ✅
   - File created with **frontmatter + `# Header`** (your `fileNameIsHeader` setting) → `content_size > 0` → folder/regex template is **skipped**, falls through to `overwrite_file_commands(file)` which only processes `<% %>` commands already in the file → **no rename, file keeps original name.** ❌

   **This is exactly the reported symptom:** "the file keeps the original name instead of being renamed by the template."

3. **The crash** ("the moment they finish typing the name") is the **Templater race** documented in issue #1629 — not the API choice. It persists because Templater's `on_file_creation` runs async in the same window as your create, and if a folder template renames/moves the file, your stale `TFile` reference breaks. The `vault.create` change reduced but did not eliminate it.

4. **Recommended fix:** create the file **empty** (`vault.create(path, '')`) so Templater's folder template fires and renames, then add your optional content **only if no folder template will apply** (or after Templater finishes). Frontmatter-only content is safe to include at create time; a `# Header` is not.

5. **Mobile open:** `app.workspace.getLeaf(false).openFile(file)` is safe on mobile. `openLinkText` is the more robust choice only because it re-resolves by path (handles a file that Templater renamed). Your `openFile` helper already re-resolves via `getFileByPath` and no-ops if missing, so it is already safe.

---

## 1. How Templater hooks file creation (verified source)

**File:** `src/handlers/EventHandler.ts` (Templater master)

Templater registers a `vault.on('create')` listener — it does **not** patch `fileManager.createNewMarkdownFile`:

```ts
this.plugin.registerEvent(
  this.plugin.app.vault.on("create", (file: TAbstractFile) =>
    Templater.on_file_creation(this.templater, this.plugin.app, file),
  ),
);
```

This is gated on the local setting `trigger_on_file_creation` (the "Trigger Templater on new file creation" toggle). Because it hooks the vault `create` event, **it fires identically whether you use `fileManager.createNewMarkdownFile` or `vault.create`** — both emit a single `create` event. So the API swap is not why Templater stopped applying.

---

## 2. The exact condition that decides whether a template is applied (verified source)

**File:** `src/core/Templater.ts` → `static async on_file_creation(...)`

```ts
static async on_file_creation(templater, app, file) {
  if (!getLocalSettings(app).trigger_on_file_creation) return;
  if (!(file instanceof TFile) || file.extension !== "md") return;

  // skip template files & ignored folders ...

  // TODO: find a better way to do this
  // Currently, I have to wait for the note extractor plugin to add the file content before replacing
  await delay(300);                                   // <-- 300ms hard-coded delay
  if (templater.files_with_pending_templates.has(file.path)) return;

  const file_content = await app.vault.read(file);
  const frontmatter_info = getFrontMatterInfo(file_content);
  const content_size = file_content.length - frontmatter_info.contentStart;   // <-- KEY

  if (content_size == 0 && mode === "folder") {
    // apply folder template (may contain tp.file.rename / tp.file.move)
    await templater.write_template_to_file(template_file, file);
  } else if (content_size == 0 && mode === "regex") {
    // apply regex template
    await templater.write_template_to_file(template_file, file);
  } else {
    const SIZE_LIMIT = 100_000;
    if (file.stat.size <= SIZE_LIMIT) {
      await templater.overwrite_file_commands(file);   // only processes <% %> in the file itself
    }
  }
}
```

### The critical line

```ts
const content_size = file_content.length - frontmatter_info.contentStart;
```

`getFrontMatterInfo` (from `obsidian.d.ts`) returns:

```ts
interface FrontMatterInfo {
  exists: boolean;
  frontmatter: string;
  from: number;   // start of frontmatter contents (excluding ---)
  to: number;     // end of frontmatter contents (excluding ---)
  contentStart: number;  // offset where the frontmatter block ends (INCLUDING the closing ---)
}
```

So `contentStart` is the byte offset just **after** the closing `---` of the frontmatter block. Therefore:

| File content at create time | `content_size` | Folder/regex template applies? |
|---|---|---|
| `""` (empty) | `0 - 0 = 0` | ✅ Yes |
| `---\ncreated: ...\n---` (frontmatter only) | `0` (contentStart = end of `---`) | ✅ Yes |
| `---\ncreated: ...\n---\n# Name` (frontmatter + header) | `> 0` | ❌ **No** — falls to `overwrite_file_commands` |

**This is the regression.** Your `getFileCreateString` (`src/utils/newFile.ts:29-42`) produces:
- `createdYaml` on → frontmatter block.
- `fileNameIsHeader` on → appends `# ${fileName}`.

When `fileNameIsHeader` is enabled, the created file has body content, so `content_size > 0`, and Templater **skips the folder/regex template entirely**. The template (which typically contains `tp.file.rename(...)` or renames the note) never runs → the file keeps the name you typed instead of the template's name.

### What `overwrite_file_commands` does (the fallback)

**File:** `src/core/Templater.ts` → `overwrite_file_commands(file, active_file=false)`

It parses the file's **own content** for `<% %>` commands and rewrites it via `vault.modify`. If your created file has no `<% %>` commands, it's a no-op — no rename, no template. So the file is created, opened, but never renamed.

---

## 3. The crash — why it persists (verified source + issue #1629)

The crash is the **Templater race**, not the API choice. Sequence:

1. Your `vault.create(path, content)` fires the `create` event.
2. Templater's `on_file_creation` is queued; it `await delay(300)`.
3. If a **folder template** matches the target folder and contains `tp.file.rename`/`tp.file.move`, Templater renames/moves the file out from under your `TFile` reference.
4. Your code then calls `openFile({ file: newFile })` → `getFileByPath(newFile.path)` returns `null` (file moved) → your helper no-ops safely. But if anything else touches the stale `TFile` (e.g. `vault.modify`), it throws on a detached file.

**Templater issue #1629 (open):** "Templater `app.vault.modify()` might cause race condition" — https://github.com/SilentVoid13/Templater/issues/1629. The maintainer confirms `vault.process()` can't be used (needs sync fn), so the race is unresolved upstream. A PR #1630 exists but is unmerged.

**Why the crash "sometimes still happens":** The `vault.create` change removed your second `vault.modify` write (good — that eliminated the lost-update half of the race), but the **rename/move** half remains: if a folder template renames the file during the 300ms window, your stale reference breaks. The crash is timing-dependent, hence intermittent.

**"The file is not created"** can also occur if `vault.create` throws because the parent folder doesn't exist. `vault.create` does **not** auto-create parent folders (it throws if the parent is missing). In your modal flow the target folder already exists, so this is only a risk if the folder was just created and not yet flushed — but the primary cause is the Templater race.

---

## 4. Recommended fix

The core tension: **Templater's folder template only fires on an empty (or frontmatter-only) file, but your plugin wants to inject a `# Header`.** You cannot have both at create time. Choose one:

### Option A (recommended) — create empty, let Templater own the content, add your content only when no folder template applies

```ts
export const createNewMarkdownFile = async (plugin, folder, newFileName, content?) => {
  const baseName = newFileName.replace(/\.md$/i, '');
  const dir = folder.isRoot() ? '' : folder.path + '/';
  const initialPath = normalizePath(`${dir}${baseName}.md`);

  // 1. Create EMPTY so Templater's folder/regex template fires (content_size == 0)
  //    and can rename the file. Frontmatter-only content is also safe, but a
  //    body header is NOT — it would suppress the template.
  const newFile = await plugin.app.vault.create(initialPath, '');

  // 2. Re-resolve by path — Templater may have renamed/moved it during the 300ms window.
  const resolved = plugin.app.vault.getFileByPath(newFile.path) ?? newFile;

  // 3. Add your optional content ONLY if no folder template will overwrite it.
  //    (Detect Templater folder-template match, or simply skip content when
  //    Templater is active and a folder template exists for `folder`.)
  //    If you must add a header, do it AFTER Templater finishes (see below).

  openFile({ file: resolved, app: plugin.app, newLeaf: false });
  eventBus.emit(eventTypes.activeFileChange, { filePath: resolved.path });
};
```

**Key rules:**
- **Frontmatter-only content is safe** to pass to `vault.create` — Templater still applies the folder template because `content_size == 0`.
- **A `# Header` (body content) suppresses the folder template.** If you need the header AND Templater's rename, you must add the header **after** Templater finishes, not at create time.

### Option B — if you must keep the header, add it after Templater finishes

Since Templater's `on_file_creation` runs `delay(300)` + template processing, you can wait for Templater's completion event. Templater triggers `templater:all-templates-executed` on the workspace when all pending templates finish (see `end_templater_task` in `Templater.ts`). You could:

```ts
// create empty, then wait for Templater, then add header to the (possibly renamed) file
const newFile = await plugin.app.vault.create(initialPath, '');
// ... wait for 'templater:all-templates-executed' or a short delay ...
const resolved = plugin.app.vault.getFileByPath(newFile.path) ?? newFile;
if (resolved) await plugin.app.vault.process(resolved, (data) => data + `\n# ${baseName}`);
```

This is more complex and fragile (Templater timing). **Option A is cleaner:** don't fight Templater over the file body.

### Option C — detect Templater and skip your header when a folder template exists

Read Templater's settings (`app.plugins.plugins.templater-obsidian.settings.folder_templates`) and check if any matches `folder.path`. If so, create empty and let Templater own the content; otherwise add your content. This gives the best of both but couples you to Templater's internal settings shape.

---

## 5. Mobile: `getLeaf(false).openFile(file)` vs `openLinkText`

**Verified from `obsidian.d.ts`:**

```ts
getLeaf(newLeaf?: PaneType | boolean): WorkspaceLeaf;
openFile(file: TFile, openState?: OpenViewState): Promise<void>;
openLinkText(linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, openViewState?: OpenViewState): Promise<void>;
```

- `getLeaf(false)` returns the current leaf and **works on mobile** (it's the standard API; `getLeaf(true)` also works). `openFile(file)` on that leaf is safe on mobile.
- `openLinkText` is the **more robust** choice only because it **re-resolves by linktext/path** — so if Templater renamed the file, `openLinkText` can still find and open it, whereas `openFile` needs a valid `TFile` reference.

**Your current `openFile` helper (`src/utils/newFile.ts:6-16`) is already safe on mobile** because it re-resolves via `app.vault.getFileByPath(file.path)` and no-ops if the file is gone:

```ts
const fileToOpen = app.vault.getFileByPath(file.path);
if (!fileToOpen) return;   // safe: file renamed/moved/deleted → don't open
```

So the mobile crash is **not** caused by `openFile`. It's the Templater race (section 3). If you want to open the file even after Templater renamed it, switch to `openLinkText(file.path, '/', false)` — but note you'd need the **new** path, which Templater doesn't broadcast. In practice, letting Templater own the open (it already opens the note and sets the rename cursor) is the cleanest.

---

## 6. Summary of what to change next

| Symptom | Root cause (verified) | Fix |
|---|---|---|
| Templater no longer renames the file | File created with body content (`# Header`) → `content_size > 0` → folder/regex template skipped | Create file **empty** (or frontmatter-only); add header only after Templater finishes, or skip header when a folder template exists |
| Crash on create (intermittent) | Templater race #1629: folder template renames/moves file during 300ms window; stale `TFile` breaks | Re-resolve by path after create; never `vault.modify` a stale reference; wrap in try/catch (already done) |
| File not created | `vault.create` throws if parent folder missing, or Templater race | Ensure parent folder exists before `vault.create`; keep the dedupe loop |
| Mobile open | Not the cause — `getLeaf(false).openFile` is safe; your helper re-resolves | No change needed; optionally use `openLinkText` to survive renames |

---

## Sources

- Templater `src/handlers/EventHandler.ts` — `vault.on('create')` hook: https://github.com/SilentVoid13/Templater/blob/master/src/handlers/EventHandler.ts
- Templater `src/core/Templater.ts` — `on_file_creation`, `content_size` condition, `overwrite_file_commands`, `write_template_to_file`, `end_templater_task`: https://github.com/SilentVoid13/Templater/blob/master/src/core/Templater.ts
- Templater `src/utils/Utils.ts` — `delay(300)`, `get_frontmatter_and_content`: https://github.com/SilentVoid13/Templater/blob/master/src/utils/Utils.ts
- Obsidian `obsidian.d.ts` (master) — `FrontMatterInfo`, `Vault.create`, `Workspace.getLeaf`, `openFile`, `openLinkText`: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
- Templater issue #1629 (open, race condition): https://github.com/SilentVoid13/Templater/issues/1629
- Templater issue #873 (freeze on file creation, SIZE_LIMIT guard): https://github.com/SilentVoid13/Templater/issues/873
- file-tree-alternative issue #268 (mobile folder crash, Templater active): https://github.com/ozntel/file-tree-alternative/issues/268
- Plugin git history: commits `8bb3ff3`, `dc23438` in `src/utils/newFile.ts`
