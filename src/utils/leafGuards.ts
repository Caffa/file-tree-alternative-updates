import { App, WorkspaceLeaf } from 'obsidian';

/** Returns every leaf associated with `viewType`, including deferred/ghost
 *  leaves that `getLeavesOfType()` misses because the live view reports "empty"
 *  (EmptyView-blanked leaves mid-restore, "Plugin no longer active" panes). */
export function getFileTreeLeaves(app: App, viewType: string): WorkspaceLeaf[] {
    const leaves = new Set<WorkspaceLeaf>(app.workspace.getLeavesOfType(viewType));
    app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.getViewState()?.type === viewType) leaves.add(leaf);
    });
    return Array.from(leaves);
}
