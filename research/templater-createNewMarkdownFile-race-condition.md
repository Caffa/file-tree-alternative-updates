# Research: Crash when creating a new file while Templater is active

**Date:** 2026-08-11
**Scope:** `file-tree-alternative` plugin — "New File → Create Note" crash, suspected Templater interaction.
**Code path:** `NestedFolders.tsx:142` → `VaultChangeModal` (`modals.ts:153-159`) → `createNewMarkdownFile` (`utils/newFile.ts:44-49`).

---

## TL;DR (answer first)

The crash is a **race condition between your plugin and Templater**, not a bug in your `createNewMarkdownFile` logic per se. When Templater's **"Trigger Templater on new file creation"** setting is on, Templater registers a `vault.on('create')` listener that fires **asynchronously** (after a hard-coded `delay(300)`), reads the file, applies a template, and then calls `vault.modify()` / `fileManager.renameFile()` on it. Your plugin's `createNewMarkdownFile` does the same thing on the same file **without any synchronization**:

1. `fileManager.createNewMarkdownFile(folder, name)` creates the file (fires `create`).
2. Templater's listener wakes up ~300ms later, reads the file, applies a template, and calls `vault.modify()`.
3. Meanwhile your code calls `vault.modify(newFile, content)` and `openFile(newFile)` on the **stale `TFile` reference**.
4. If Templater **renamed/moved** the file (via `tp.file.rename`/`tp.file.move` in the template, or a folder template), your stale `newFile.path` no longer exists → `openFile`'s `getFileByPath` returns `null` and silently returns, or `vault.modify` throws on a detached file → crash.

This is a **known, documented class of bug** in the Obsidian ecosystem. See the evidence section below.

---

## 1. How Templater interacts with `createNewMarkdownFile`

Templater does **not** patch `app.fileManager.createNewMarkdownFile`. It works purely by **listening to the vault `create` event** and then **asynchronously** rewriting the file.

### Evidence from Templater source

**`src/handlers/EventHandler.ts`** — registers the listener (only when the setting is enabled):
```ts
this.plugin.registerEvent(
  this.plugin.app.vault.on("create", (file: TAbstractFile) =>
    Templater.on_file_creation(this.templater, this.plugin.app, file),
  ),
);
```

**`src/core/Templater.ts` → `on_file_creation`** — the key race window:
```ts
static async on_file_creation(templater, app, file) {
  if (!getLocalSettings(app).trigger_on_file_creation) return;
  if (!(file instanceof TFile) || file.extension !== "md") return;
  // ... template-folder and ignore-folder checks ...
  // TODO: find a better way to do this
  // Currently, I have to wait for the note extractor plugin to add the file content before replacing
  await delay(300);   // <-- 300ms hard-coded delay
  if (templater.files_with_pending_templates.has(file.path)) return;
  const file_content = await app.vault.read(file);
  // ... if empty, apply folder template / regex template / overwrite_file_commands ...
  await templater.write_template_to_file(template_file, file);  // calls vault.modify / vault.process
}
```

So the sequence is: **your `create` fires → Templater's handler is queued → 300ms later it reads + rewrites the file.** Your plugin's `createNewMarkdownFile` runs in the same ~300ms window with no coordination.

### `tp.file.rename` / `tp.file.move` (the crash amplifier)

From **`src/core/functions/internal_functions/file/InternalModuleFile.ts`**:
```ts
generate_rename() {
  return async (new_title) => {
    const new_path = normalizePath(`${parent.path}/${new_title}.${target_file.extension}`);
    await this.plugin.app.fileManager.renameFile(this.config.target_file, new_path);  // renames the file
    return "";
  };
}
generate_move() {
  return async (path) => {
    const new_path = normalizePath(`${path}.${file.extension}`);
    // ... creates target dirs ...
    await this.plugin.app.fileManager.renameFile(file, new_path);  // moves the file
    return "";
  };
}
```

If the user's template (or a **folder template** applied to the folder you created the note in) contains `tp.file.rename(...)` or `tp.file.move(...)`, Templater will **rename/move the file out from under your stale `TFile` reference** during the 300ms window.

---

## 2. Known race conditions / crashes with this exact pattern

### Primary reference — Templater issue #1629 (open)
**"Templater `app.vault.modify()` might cause race condition"**
https://github.com/SilentVoid13/Templater/issues/1629

> "When you have some other file creation event handler that modifies the note, Templater can cause race condition.
> 1. File is created with content A.
> 2. `Trigger Templater on new file creation` caused Templater to read content A.
> 3. Another handler works and changed the content to B.
> 4. Templater calls `await app.vault.modify(file, 'A');` and the change B is lost."

This is **exactly** your scenario: your plugin writes content (frontmatter/header) and Templater overwrites it, or vice-versa. The issue is still **open** (Templater has not fixed it; a PR #1630 exists but is unmerged). The maintainer notes `vault.process()` can't be used because Templater needs async, so the race is unresolved upstream.

### Related — Templater issue #873 (closed)
**"Obsidian freezes when a large file is received via sync or dropped to the file explorer"**
https://github.com/SilentVoid13/Templater/issues/873

Shows Templater's `on_file_creation` can freeze/crash Obsidian when it processes files created by other means. The fix added a `SIZE_LIMIT = 100_000` guard (visible in the source above), confirming this handler is a known crash source.

### Related — Templater issue #1737 (open)
**"Templater fails to execute scripts on files created by Obsidian Web Clipper"**
https://github.com/SilentVoid13/Templater/issues/1737

Documents the same "native collision with Templater's `vault.on('create')` event hook" and the overwrite/wipeout race when another tool writes content to a newly created file.

### Community reports of the same class of bug
- **Reddit r/ObsidianMD — "Templater plugin conflicting with file move action - Possible race condition"**
  https://www.reddit.com/r/ObsidianMD/comments/1bmpjx2/templater_plugin_conflicting_with_file_move/
  User has "Trigger Templater on new file creation" + a template that renames/moves the file → conflicts with other plugins' create handlers.
- **Obsidian Forum — "Templater: Trigger Templater on new file creation"**
  https://forum.obsidian.md/t/templater-trigger-templater-on-new-file-creation/54425
  Explains the setting semantics: Templater listens for the create event and replaces commands in the new file's content.

### Your own repo — issue #268 (open)
**"Bug: Creating a new folder on mobile can cause the vault to crash."**
https://github.com/ozntel/file-tree-alternative/issues/268

The reporter's active plugin list includes **Templater**. This is the same crash class (create action + Templater + large vault). Worth cross-referencing when you fix this.

---

## 3. Recommended defensive pattern for creating a markdown file

The core problem: **you hold a `TFile` reference and call `vault.modify` + `openFile` on it, but another plugin may rename/move/delete it in between.** The fix is to make the create flow **re-resolve the file by path** and **tolerate the file having moved**, and to **not fight Templater over content**.

### Recommended implementation (for `utils/newFile.ts`)

```ts
export const createNewMarkdownFile = async (
  plugin: FileTreeAlternativePlugin,
  folder: TFolder,
  newFileName: string,
  content?: string,
) => {
  // 1. Compute the exact path we intend to create (mirror what createNewMarkdownFile does).
  const basePath = normalizePath(`${folder.path}/${newFileName}`);
  const path = plugin.app.vault.getAvailablePath(basePath, 'md');

  // 2. Create the file with our content in ONE atomic call.
  //    vault.create() fires a single 'create' event and returns the TFile.
  const newFile = await plugin.app.vault.create(path, content ?? '');

  // 3. Re-resolve by path before any subsequent operation.
  //    If Templater (or anything else) renamed/moved it, getFileByPath returns null.
  const resolved = plugin.app.vault.getFileByPath(newFile.path) ?? newFile;

  // 4. Open the file — openFile already re-resolves via getFileByPath and
  //    safely no-ops if the file is gone.
  openFile({ file: resolved, app: plugin.app, newLeaf: false });
  eventBus.emit(eventTypes.activeFileChange, { filePath: resolved.path });
};
```

**Why this is safer than the current code:**

| Current code | Problem | Fix |
|---|---|---|
| `(app.fileManager as any).createNewMarkdownFile(...)` | Undocumented/legacy API; not in current `obsidian.d.ts`; returns a `TFile` you then mutate | Use `vault.create(path, content)` — documented, atomic, single `create` event |
| `vault.modify(newFile, content)` after create | Second write in the race window; Templater may have already written → lost update or throw on detached file | Pass content directly to `vault.create()` — one write, no second `modify` |
| `openFile({ file: newFile })` | Stale reference if Templater renamed/moved it | `openFile` already re-resolves via `getFileByPath` and no-ops if missing (see `newFile.ts:8-9`) |

**Key insight:** By passing content to `vault.create()` directly, you eliminate the `vault.modify()` second write entirely. This removes your plugin from the "lost update" race in issue #1629 — you write once, and if Templater later overwrites, that's Templater's documented behavior, not a crash.

### If you must keep `fileManager.createNewMarkdownFile` (e.g. to respect "new file location" settings)

Then at minimum:
- **Re-resolve** the returned file by path before `modify`/`openFile`.
- **Guard `vault.modify`** with a `getFileByPath` check and try/catch.
- **Do not** call `vault.modify` if you can pass content to `create` instead.

---

## 4. Known issues with `vault.modify()` immediately after `createNewMarkdownFile`

**Yes — this is the documented race.** See issue #1629 (section 2). The specific failure modes:

1. **Lost update:** Templater reads content A, your `modify` writes content B, then Templater's `modify` writes A back → your frontmatter/header is silently lost.
2. **Throw on detached file:** If Templater renamed/moved the file between your `create` and your `modify`, the `TFile` you hold points to a path that no longer exists. `vault.modify` on a stale/detached `TFile` can throw, and since `createNewMarkdownFile` has **no try/catch**, the exception propagates up through `onClickAction` → unhandled → Obsidian shows the crash / the modal's promise rejects.

**The fix is to not call `vault.modify` at all** — pass content to `vault.create()` (or `createNewMarkdownFile`'s content param if you keep it). One write, no race window for a second write.

---

## 5. Safest way to recover if the file was renamed/moved by Templater

Your `openFile` helper (`newFile.ts:6-16`) is **already the right recovery pattern** — it re-resolves by path and no-ops safely:

```ts
const fileToOpen = app.vault.getFileByPath(file.path);
if (!fileToOpen) return;   // <-- safe: file was renamed/moved/deleted → just don't open
```

So the recovery strategy is:

1. **Never trust the `TFile` returned by create.** Always re-resolve via `app.vault.getFileByPath(path)` before `modify`/`openFile`.
2. **If you want to open the file even after Templater moved it**, you can't know the new path from your side (Templater doesn't broadcast it). Options:
   - **Best:** Let Templater own the open. Templater's `create_new_note_from_template` already opens the file and sets the rename cursor. If you detect the file is gone, just **don't open it** — Templater will.
   - **Alternative:** Listen for the `rename` event and track old→new path, then open the new path. Overkill for this case.
3. **Wrap the whole create in try/catch** and show a `Notice` on failure instead of letting the exception crash the app. This is the single most important defensive change — it converts a hard crash into a recoverable no-op.

---

## Appendix: Obsidian API facts (verified against `obsidian.d.ts`)

- **`Vault.create(path, data, options?): Promise<TFile>`** — documented, atomic, fires one `create` event. (since 0.9.7)
- **`Vault.getFileByPath(path): TFile | null`** — returns `null` if the file does not exist. (since 1.5.7)
- **`Vault.modify(file, data, options?): Promise`** — writes content; throws if the file is invalid/detached.
- **`Vault.process(file, fn, options?): Promise`** — atomic read-modify-write, but `fn` must be **synchronous** (this is why Templater can't use it — see #1629).
- **`FileManager.renameFile(file, newPath): Promise<void>`** — renames/moves and updates links. (since 0.11.0)
- **`FileManager.createNewMarkdownFile`** — **NOT present in the current `obsidian.d.ts`.** It is a legacy/undocumented method. Using it with `(app.fileManager as any)` is a code smell and a sign the code predates the documented `Vault.create` API.

---

## Sources

- Templater source: `src/handlers/EventHandler.ts`, `src/core/Templater.ts`, `src/core/functions/internal_functions/file/InternalModuleFile.ts` (github.com/SilentVoid13/Templater)
- Templater issue #1629 (open, race condition): https://github.com/SilentVoid13/Templater/issues/1629
- Templater issue #873 (freeze on file creation): https://github.com/SilentVoid13/Templater/issues/873
- Templater issue #1737 (Web Clipper collision): https://github.com/SilentVoid13/Templater/issues/1737
- Reddit (file move conflict): https://www.reddit.com/r/ObsidianMD/comments/1bmpjx2/templater_plugin_conflicting_with_file_move/
- Obsidian Forum (setting semantics): https://forum.obsidian.md/t/templater-trigger-templater-on-new-file-creation/54425
- file-tree-alternative issue #268 (mobile folder crash, Templater active): https://github.com/ozntel/file-tree-alternative/issues/268
- Obsidian API: `obsidian.d.ts` (github.com/obsidianmd/obsidian-api)
