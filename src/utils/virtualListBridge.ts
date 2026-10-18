/**
 * Bridge between MainComponent (which knows WHEN a file must be revealed) and the
 * virtualized file list in FileComponent (which knows WHERE the row is).
 *
 * Rows outside the virtual window are not in the DOM, so the legacy
 * querySelector-based scroll cannot reach them. The mounted list registers a
 * scroller keyed by path; callers fall back to the legacy DOM scroll when no
 * virtual list is mounted.
 */
export type VirtualFileScroller = (path: string) => boolean;

let virtualFileScroller: VirtualFileScroller | null = null;

/** Called by the virtualized list on mount (and with null on unmount). */
export function registerVirtualFileScroller(scroller: VirtualFileScroller | null): void {
    virtualFileScroller = scroller;
}

/** Try to scroll the virtualized list to `path`. Returns false when no list is mounted. */
export function scrollVirtualFileListToFile(path: string): boolean {
    return virtualFileScroller ? virtualFileScroller(path) : false;
}
