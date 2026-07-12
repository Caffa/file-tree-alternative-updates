# Plan: Highlight Recently Modified Files

## Overview
Add visual highlighting to files in the file pane based on how recently they were modified. Files get gradient highlights - the most recently modified file gets the brightest, with each subsequent file getting progressively less bright.

## Key Design Decisions

### Performance-First Approach
1. **No new stores or data structures** - Files already have `mtime` in their `stat` object (from `OZFile` interface)
2. **Computed at render time** - Use `useMemo` in `NavFile` component to compute recency class based on file's mtime relative to other files in the current folder
3. **CSS-only animations** - Use `color-mix()` for smooth gradients, no JavaScript animations
4. **Minimal overhead** - Only compute when `ozFileList` changes (already debounced)

### Why This Approach?
- The existing folder trail feature uses a complex incremental update system with `folderMtimes` Map, debounced updates, and localStorage persistence
- For files, we don't need that complexity because:
  - Files are already loaded in `ozFileList` with their mtime
  - The file list only updates when you navigate to a folder or on vault events
  - We can compute relative recency in O(n) where n = files in current folder (typically <50)

## Implementation Phases

### Phase 1: Add Settings (settings.ts)
Add two new settings to `FileTreeAlternativePluginSettings` interface and `DEFAULT_SETTINGS`:

```typescript
highlightRecentFiles: boolean;  // Toggle on/off
recentFilesCount: number;       // How many files to highlight (1-5, default 3)
```

Add corresponding settings UI in `getSettingDefinitions()` under a new "Recently Modified Files" group:
- Toggle for "Highlight Recently Modified Files"
- Dropdown for "Recent Files Count" (1, 2, 3, 4, 5)

### Phase 2: Add Recency Computation (FileComponent.tsx)
In the `NavFile` component, add a `useMemo` hook that:
1. Gets the current `ozFileList` from the store
2. Sorts files by mtime descending (most recent first)
3. Finds the index of the current file in that sorted list
4. If index < `recentFilesCount`, adds CSS class `oz-recent-file-{level}` where level is 0 (brightest) to recentFilesCount-1 (dimmest)
5. Passes a CSS custom property `--oz-recent-file-level` for gradient control

Key performance consideration:
- This runs per-file, but the sort is only done once per render (memoized at parent level)
- Actually, we should compute the sorted order once in the parent `FileComponent` and pass it down, or use a shared memo

Better approach: Compute a `Map<string, number>` of file paths to their recency rank in the parent `FileComponent`, then pass it to `NavFile` via props or context.

### Phase 3: Add CSS Styles (styles.css)
Add styles for file highlighting similar to the folder trail pattern:

```css
/* Recently Modified File - Level 0 (most recent) */
.oz-nav-file.oz-recent-file-0 {
    background-color: color-mix(in srgb, var(--oz-fta-recent-file-color, var(--interactive-accent)) 25%, transparent);
    border-radius: 3px;
}

/* Level 1 */
.oz-nav-file.oz-recent-file-1 {
    background-color: color-mix(in srgb, var(--oz-fta-recent-file-color, var(--interactive-accent)) 15%, transparent);
    border-radius: 3px;
}

/* Level 2 */
.oz-nav-file.oz-recent-file-2 {
    background-color: color-mix(in srgb, var(--oz-fta-recent-file-color, var(--interactive-accent)) 8%, transparent);
    border-radius: 3px;
}

/* Level 3 */
.oz-nav-file.oz-recent-file-3 {
    background-color: color-mix(in srgb, var(--oz-fta-recent-file-color, var(--interactive-accent)) 4%, transparent);
    border-radius: 3px;
}

/* Level 4 */
.oz-nav-file.oz-recent-file-4 {
    background-color: color-mix(in srgb, var(--oz-fta-recent-file-color, var(--interactive-accent)) 2%, transparent);
    border-radius: 3px;
}
```

Also add a Style Settings variable for the color:
```css
--oz-fta-recent-file-color: var(--interactive-accent);
```

### Phase 4: Build, Deploy, Test
1. Run `bash sendToNovelVault.sh` to build and deploy
2. Test in Obsidian:
   - Toggle setting on/off
   - Change count setting
   - Verify gradient looks good
   - Verify no performance lag
   - Test with large folders (100+ files)
   - Test on mobile if possible

## Files to Modify
1. `src/settings.ts` - Add settings interface, defaults, and UI
2. `src/components/FileView/FileComponent.tsx` - Add recency computation and CSS classes
3. `styles.css` - Add file highlight styles

## Testing Checklist
- [ ] Setting toggle works (on/off)
- [ ] Count setting works (1-5)
- [ ] Most recent file has brightest highlight
- [ ] Gradient decreases smoothly
- [ ] No lag when opening folders with many files
- [ ] Active file styling doesn't conflict
- [ ] Pinned files styling doesn't conflict
- [ ] Hover styling doesn't conflict
- [ ] Mobile rendering looks correct
- [ ] Style Settings variable works for color customization
