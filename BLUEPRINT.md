<!--
Blueprint conventions:
- status is one of: active | paused | done | shelved
- Log entries are newest-first, one per work session.
- Agents edit this file; the gallery page is generated from it — never edit the HTML.

Optional icon frontmatter (the Blueprints gallery shows one generated icon per
project; without these keys the prompt is auto-built from title, one_liner, and
the bullets below):
- icon_prompt: full prompt override for the icon image (sanitized, capped at 700 chars)
- icon_seed:   integer; rerolls the icon without changing the prompt
Regenerate an icon with: ./scripts/generate-blueprint-icons.sh --slug <slug> --force
-->
---
title: File Tree Alternative Updates
one_liner: Obsidian plugin (maintained fork of ozntel/file-tree-alternative) that splits the file explorer into separate folder and file views; this fork keeps bug fixes and mobile improvements coming.
status: active
updated: 2026-11-21
discord_channel: https://discord.com/channels/1486966847810043924/1514919357652926527
---

## Where it stands

- Active maintenance fork of the file-tree-alternative Obsidian plugin (separate folder/file views), focused on bug fixes and iOS mobile behavior.
- Mobile performance work landed: chunked startup folder counts, chunked OZFile conversion, vault-scoped localStorage caches, and a single tuning gate for list/persist/overscan timers.
- Mobile duplicate-pane bug fixed via broad leaf detection, serialized pane opening, and hardened dedup.
- Newest fix: the folder tree keeps its scroll position across folder/file view switches (src/utils/folderScrollMemory.ts, WeakMap keyed per pane).
- Every code change is built and deployed to the Novel-Writing and ZettelPublish vaults via sendToNovelVault.sh.

## Log

### 2026-11-21 — Folder tree scroll position remembered

Fixed a UX bug where clicking a folder remounted the folder tree (MainFolder) and reset its scroll to the top. New src/utils/folderScrollMemory.ts keeps a WeakMap keyed by each pane root (`.file-tree-plugin-view`), captures scroll on the fly, and restores it in a useLayoutEffect when MainFolder mounts. Commits 34e9953 and 042552b pushed to main; deployed to the vaults via sendToNovelVault.sh.

https://discord.com/channels/1486966847810043924/1573617032216191058
