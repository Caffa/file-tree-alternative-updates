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
// Reference-counted registrations: with two file-tree leaves the second
// register overwrites the slot, but either leaf's unmount must not null the
// bridge for the survivor (that silently degraded reveals to the legacy DOM
// scroll). The latest live registration wins; the slot clears only when the
// last registration unregisters.
const liveRegistrationIds = new Set<number>();
let nextRegistrationId = 0;

/** Register a scroller. Returns an id — pass it to unregisterVirtualFileScroller. */
export function registerVirtualFileScroller(scroller: VirtualFileScroller): number {
    const id = ++nextRegistrationId;
    liveRegistrationIds.add(id);
    virtualFileScroller = scroller;
    return id;
}

/** Unregister a scroller by id. Clears the bridge only when the count hits zero. */
export function unregisterVirtualFileScroller(id: number): void {
    if (!liveRegistrationIds.delete(id)) return;
    if (liveRegistrationIds.size === 0) virtualFileScroller = null;
}

/** Try to scroll the virtualized list to `path`. Returns false when no list is mounted. */
export function scrollVirtualFileListToFile(path: string): boolean {
    return virtualFileScroller ? virtualFileScroller(path) : false;
}
