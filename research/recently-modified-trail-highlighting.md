# Recently Modified File Trail Highlighting Feature - Research Report

## Overview

This feature highlights folders containing recently modified files with a visual trail from the root folder to the modified folder. The implementation tracks file modification times incrementally and derives a trail of ancestor folders with depth-based CSS gradients for visual feedback.

## Key Files and Line Numbers

### 1. Core Algorithm: `deriveRecentFolders()` 
**File:** `src/utils/Utils.ts` (lines 261-325)

This function computes the trail from root to the most recently modified folder:

```typescript
export function deriveRecentFolders(
    folderMtimes: Map<string, number>,
    app: App,
    count = 1
): {
    recentFolders: Map<string, number>;
    folderDepth: Map<string, number>;
    folderTrailIndex: Map<string, number>;
}
```

**Algorithm:**
1. **Sort folders by mtime descending** (most recently modified first)
2. **Filter out root folder** (`/` or empty) and **active folder** (already highlighted as current)
3. **Take top N folders** (default 1, configurable up to 3)
4. **For each selected folder:**
   - Add to `recentFolders` map (primary highlight)
   - Assign trail index (0, 1, 2...) for color coding
   - **Walk up ancestor path** by splitting folder path into parts
   - For each ancestor:
     - Calculate depth (1 = root child, 2 = grandchild, etc.)
     - Update `folderDepth` map if this depth is greater than existing
     - Assign trail index if not already assigned (first trail wins)
5. **Return three maps:**
   - `recentFolders`: primary folders to highlight
   - `folderDepth`: ancestor trail with depth values for CSS gradient
   - `folderTrailIndex`: maps every folder (primary + ancestors) to trail index

### 2. State Management: Zustand Store
**File:** `src/recoil/pluginStore.ts` (lines 1-88)

Four key state maps:
```typescript
recentModifiedFolders: Map<string, number>      // Primary folders (top N by mtime)
recentFolderDepth: Map<string, number>          // Ancestor depth (1, 2, 3...)
recentFolderMtimes: Map<string, number>         // Raw mtime data for all folders
recentFolderTrailIndex: Map<string, number>     // Trail index (0, 1, 2...) for color coding
```

### 3. Vault Event Handling
**File:** `src/main.ts` (lines 459-599)

Incremental update strategy:
- **On modify/create:** Update `folder.path` and all ancestors with `file.stat.mtime`
- **On delete:** Recompute parent folder's max mtime from remaining children
- **On rename:** Delete old path entries + create new path entries
- **Debouncing:** 200ms debounce for rapid successive events (sync/startup bursts)

Key functions:
- `applyRecentFolderEvent()` (lines 483-508): Pure map mutation
- `finalizeRecentFolderUpdate()` (lines 514-528): Derive display maps + store update + localStorage persist
- `recomputeFolderMtime()` (lines 534-570): Recalculate folder's max mtime after deletion

### 4. UI Component: Tree Component
**File:** `src/components/FolderView/treeComponent/TreeComponent.tsx` (lines 22-276)

**CSS Class Logic** (lines 43-54):
```typescript
const recentClassName = useMemo(() => {
    if (!props.plugin.settings.highlightRecentFolders) return '';
    if (isFolderActive) return '';  // Active folder gets its own styling
    if (props.isRootFolder) {
        return recentFolderDepth.has(props.folder.path) ? 'oz-recent-folder-trail' : '';
    }
    if (recentModifiedFolders.has(props.folder.path)) return 'oz-recent-folder-primary';
    if (recentFolderDepth.has(props.folder.path)) return 'oz-recent-folder-trail';
    return '';
}, [...]);
```

**Inline Style Logic** (lines 57-92):
```typescript
const recentStyle = useMemo((): React.CSSProperties => {
    if (!props.plugin.settings.highlightRecentFolders) return {};
    if (isFolderActive) return {};
    
    const trailIndex = recentFolderTrailIndex.get(props.folder.path);
    if (trailIndex === undefined) return {};
    
    if (props.isRootFolder) {
        const depth = recentFolderDepth.get(props.folder.path);
        if (depth !== undefined) {
            return {
                '--oz-recent-trail-depth': depth,
                '--oz-recent-trail-index': trailIndex,
            } as React.CSSProperties;
        }
        return {};
    }
    
    if (recentModifiedFolders.has(props.folder.path)) {
        return {
            '--oz-recent-is-primary': 1,
            '--oz-recent-trail-index': trailIndex,
        } as React.CSSProperties;
    }
    
    const depth = recentFolderDepth.get(props.folder.path);
    if (depth !== undefined) {
        return {
            '--oz-recent-trail-depth': depth,
            '--oz-recent-trail-index': trailIndex,
        } as React.CSSProperties;
    }
    return {};
}, [...]);
```

**Applied to element** (lines 213-227):
```tsx
<div
    className={'oz-folder-element' + (highlight ? ' drag-entered' : '') + (recentClassName ? ' ' + recentClassName : '')}
    style={{ ...props.style, ...recentStyle }}
    data-path={props.folder.path}>
```

### 5. CSS Styles
**File:** `styles.css` (lines 579-641)

**Primary folder** (most recently modified):
```css
.oz-folder-element.oz-recent-folder-primary {
    background-color: color-mix(in srgb, var(--oz-recent-trail-color, var(--oz-fta-recent-trail-0-color)) 50%, transparent) !important;
    animation: oz-recent-pulse 2s ease-in-out infinite;
}
```

**Trail folder** (ancestors):
```css
.oz-folder-element.oz-recent-folder-trail {
    border-radius: 4px;
}

/* Depth-based opacity gradient */
.oz-folder-element.oz-recent-folder-trail[style*="--oz-recent-trail-depth: 1"] {
    background-color: color-mix(in srgb, var(--oz-recent-trail-color) 6%, transparent) !important;
}
.oz-folder-element.oz-recent-folder-trail[style*="--oz-recent-trail-depth: 2"] {
    background-color: color-mix(in srgb, var(--oz-recent-trail-color) 12%, transparent) !important;
}
/* ... up to depth 9+ at 40% */
```

**Color resolution by trail index:**
```css
.oz-folder-element[style*="--oz-recent-trail-index: 0"] {
    --oz-recent-trail-color: var(--oz-fta-recent-trail-0-color);  /* Accent color */
}
.oz-folder-element[style*="--oz-recent-trail-index: 1"] {
    --oz-recent-trail-color: var(--oz-fta-recent-trail-1-color);  /* Orange */
}
.oz-folder-element[style*="--oz-recent-trail-index: 2"] {
    --oz-recent-trail-color: var(--oz-fta-recent-trail-2-color);  /* Green */
}
```

### 6. Settings
**File:** `src/settings.ts` (lines 44-85, 330-355)

```typescript
highlightRecentFolders: boolean;  // Default: true
recentFoldersCount: number;       // Default: 1, Range: 1-3
```

## Critical Finding: Why Only Top Few Folders Are Highlighted

### The "First Trail Wins" Rule
In `deriveRecentFolders()` (line 317-320):
```typescript
// Assign trail index to ancestor if not already assigned (first trail wins)
if (!folderTrailIndex.has(current)) {
    folderTrailIndex.set(current, trailIndex);
}
```

**This is the key algorithm behavior:**
1. When `recentFoldersCount = 1` (default), only ONE primary folder is selected
2. The algorithm walks up ALL ancestors from that folder to root
3. **Every ancestor gets a trail index** (0 in this case)
4. **All ancestors are included in `folderTrailIndex`** map

**Example:** If most recently modified folder is `Projects/Novel/Chapters/Scene1`:
- `Scene1` → primary (index 0)
- `Chapters` → trail (index 0, depth 3)
- `Novel` → trail (index 0, depth 2)
- `Projects` → trail (index 0, depth 1)
- Root `/` → excluded from primary, but gets trail if it has entry in `folderDepth`

### Why Root Might Not Appear Highlighted
1. **Root filtering:** `filter(([folderPath]) => folderPath !== '/' && folderPath !== '')` (line 295)
2. **Root CSS:** `if (props.isRootFolder) { return recentFolderDepth.has(props.folder.path) ? 'oz-recent-folder-trail' : ''; }` (lines 48-50)
3. **Root only gets trail class** if it exists in `folderDepth` map
4. **Root must have mtime entry** in `folderMtimes` to be included

### Depth Limits in CSS
The CSS only defines explicit styles for depths 1-9 (lines 617-637):
- Depth 1: 6% opacity
- Depth 2: 12% opacity
- Depth 3: 18% opacity
- Depth 4: 25% opacity
- Depth 5: 32% opacity
- Depth 6-9: 40% opacity (max)

**Deeper folders (>9) still get highlighted** because the CSS selector `[style*="--oz-recent-trail-depth: X"]` matches any depth value, but the visual gradient plateaus at 40% opacity for depth 6+.

### Active Folder Exclusion
**Critical:** The active/current folder is always excluded from recent highlighting (line 296):
```typescript
.filter(([folderPath]) => folderPath !== activeFolderPath)
```

And in UI (line 46):
```typescript
if (isFolderActive) return '';  // Active folder gets its own styling
```

## Summary: Complete Trail Computation Algorithm

1. **Input:** `folderMtimes` map (folder path → mtime), maintained incrementally
2. **Filter:** Remove root (`/`), empty path, and active folder
3. **Sort:** By mtime descending (most recent first)
4. **Select:** Top N folders (configurable, default 1)
5. **For each selected folder:**
   - Mark as primary (add to `recentFolders`)
   - Assign trail index (0, 1, 2...)
   - Walk ancestor path: split by `/`, build path incrementally
   - For each ancestor:
     - Calculate depth (1-indexed from root)
     - Update `folderDepth` if deeper than existing
     - Assign trail index if not already assigned
6. **Output:** Three maps used for CSS class and inline style assignment

## No Depth Limits in Algorithm

**There are NO depth limits in the algorithm itself.** The full path from root to the modified folder is always computed. The only visual limitation is:
- CSS opacity plateaus at 40% for depth 6+
- Active folder is excluded (gets its own styling)
- Root folder must have mtime entry to appear in trail

**Potential Issue:** If `folderMtimes` doesn't contain entries for all ancestors (e.g., due to incremental updates not propagating correctly), the trail could be truncated. But the algorithm itself supports full path traversal.
