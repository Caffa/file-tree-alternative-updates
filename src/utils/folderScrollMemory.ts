/**
 * Remembers the folder tree's scroll position per plugin view pane.
 *
 * The store is a WeakMap keyed by the pane's root element
 * (`.file-tree-plugin-view`, the same scoping root rendered by FileTreeView),
 * so:
 * - each pane (leaf) keeps its own independent scroll memory,
 * - memory is garbage-collected automatically when a leaf closes,
 * - a freshly opened pane simply has no entry and starts at the top.
 */

const scrollByPane = new WeakMap<HTMLElement, number>();

/** Resolves the pane root element that keys the scroll memory. */
function resolvePaneRoot(node: HTMLElement | null): HTMLElement | null {
    return node?.closest<HTMLElement>('.file-tree-plugin-view') ?? null;
}

/** Captures the folder tree wrapper's current scrollTop for its pane. */
export function captureFolderTreeScroll(el: HTMLElement | null): void {
    const paneRoot = resolvePaneRoot(el);
    if (paneRoot) scrollByPane.set(paneRoot, el!.scrollTop);
}

/** Restores the saved scrollTop onto the folder tree wrapper, if one exists. */
export function restoreFolderTreeScroll(el: HTMLElement | null): void {
    const paneRoot = resolvePaneRoot(el);
    if (!paneRoot || !el) return;
    const saved = scrollByPane.get(paneRoot);
    if (saved !== undefined) el.scrollTop = saved;
}
