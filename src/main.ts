import { Plugin, addIcon, TAbstractFile, TFile, TFolder, Notice } from 'obsidian';
import { FileTreeView } from './FileTreeView';
import { ZoomInIcon, ZoomOutIcon, ZoomOutDoubleIcon, LocationIcon, SpaceIcon } from './utils/icons';
import { FileTreeAlternativePluginSettings, FileTreeAlternativePluginSettingsTab, DEFAULT_SETTINGS } from './settings';
import { VaultChange, eventTypes } from 'utils/types';
import { eventBus } from 'utils/eventBus';
import { getBookmarkTitle, deriveRecentFolders, MOBILE_TUNING, loadScoped, saveScoped, removeScoped, isTreeHidden, invalidateOZFileCache, clearOZFileCache, getFolderNoteCountMap, debounce } from 'utils/Utils';
import { getFileTreeLeaves } from './utils/leafGuards';
import { usePluginStore } from './recoil/pluginStore';

export default class FileTreeAlternativePlugin extends Plugin {
    settings: FileTreeAlternativePluginSettings;
    ribbonIconEl: HTMLElement | undefined = undefined;
    /** Guard flag to prevent duplicate pane creation during layout initialization */
    private viewOpenedOnStart: boolean = false;
    /** Serialized promise queue for opening the file tree leaf (mobile restore races). */
    private openTreeQueue: Promise<void> | null = null;
    /** Re-entrancy guard for the dedup layout-change handler; load-bearing. */
    private dedupRunning = false;
    /** Debounced dedup so rapid layout-change storms collapse to one pass. */
    private debouncedDeduplicate = debounce(() => this.deduplicateFileTreeLeaves(), 250);

    keys = {
        activeFolderPathKey: 'fileTreePlugin-ActiveFolderPath',
        pinnedFilesKey: 'fileTreePlugin-PinnedFiles',
        openFoldersKey: 'fileTreePlugin-OpenFolders',
        customHeightKey: 'fileTreePlugin-CustomHeight',
        customWidthKey: 'fileTreePlugin-CustomWidth',
        focusedFolder: 'fileTreePlugin-FocusedFolder',
        recentFoldersCacheKey: 'fileTreePlugin-RecentFoldersCache',
    };

    // File Tree View Variables
    VIEW_TYPE = 'file-tree-view';
    VIEW_DISPLAY_TEXT = 'File Tree';
    ICON = 'sheets-in-box';

    async onload() {
        console.log('Loading Alternative File Tree Plugin');

        addIcon('zoomInIcon', ZoomInIcon);
        addIcon('zoomOutIcon', ZoomOutIcon);
        addIcon('zoomOutDoubleIcon', ZoomOutDoubleIcon);
        addIcon('locationIcon', LocationIcon);
        addIcon('spaceIcon', SpaceIcon);

        // Load Settings
        this.addSettingTab(new FileTreeAlternativePluginSettingsTab(this.app, this));
        await this.loadSettings();

        // Clear stale OZFile conversion cache on plugin load
        clearOZFileCache();
        // Load recent folders from localStorage cache (no full vault scan)
        this.loadRecentFoldersCache();

        // Register File Tree View
        this.registerView(this.VIEW_TYPE, (leaf) => {
            return new FileTreeView(leaf, this);
        });

        // Event Listeners
        this.app.workspace.onLayoutReady(async () => {
            if (this.settings.openViewOnStart) {
                await this.openFileTreeLeaf(true);
                this.viewOpenedOnStart = true;
            }
            // Insurance in case restore produces no further layout-change.
            this.debouncedDeduplicate();
            // Lift the guard after layout stabilizes so the panel can be re-opened
            // later if the user closes it. Use a one-time listener with a small
            // delay to avoid racing with workspace restoration on mobile.
            const resetGuard = () => {
                this.viewOpenedOnStart = false;
                this.app.workspace.off('layout-change', resetGuard);
            };
            setTimeout(() => {
                // registerEvent so the listener is auto-cleaned on unload instead of leaking
                this.registerEvent(this.app.workspace.on('layout-change', resetGuard));
                // Also schedule a fallback in case no layout-change fires
                setTimeout(() => { this.viewOpenedOnStart = false; }, 2000);
            }, 500);

        });

        // Listen for layout changes to catch and clean up any duplicate panes
        // that may appear after workspace restoration (common on mobile restart)
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.debouncedDeduplicate();
            })
        );

        // Add Command to Open File Tree Leaf
        this.addCommand({
            id: 'open-file-tree-view',
            name: 'Open File Tree View',
            callback: async () => await this.openFileTreeLeaf(true),
        });

        this.app.workspace.onLayoutReady(() => {
            if (this.settings.bookmarksEvents) {
                this.bookmarksAddEventListener();
            }
        });

        this.app.workspace.onLayoutReady(() => {
            if (this.settings.interceptNativeBreadcrumb) {
                this.breadcrumbAddEventListener();
            }
        });

        // Add Command to Reveal Active File
        this.addCommand({
            id: 'reveal-active-file',
            name: 'Reveal Active File',
            callback: async () => {
                // Activate file tree pane
                let leafs = this.app.workspace.getLeavesOfType(this.VIEW_TYPE);
                if (leafs.length === 0) {
                    await this.openFileTreeLeaf(true);
                    leafs = this.app.workspace.getLeavesOfType(this.VIEW_TYPE);
                }
                if (leafs.length > 0) {
                    this.app.workspace.revealLeaf(leafs[0]);
                }
                // Run custom event
                eventBus.emit(eventTypes.revealFile, {
                    file: this.app.workspace.getActiveFile(),
                });
            },
        });

        // Add Command to create a new file under active folder path
        this.addCommand({
            id: ' create-new-note',
            name: 'Create a New Note',
            callback: () => {
                eventBus.emit(eventTypes.createNewNote);
            },
        });

        // Dev command: verify folder-count map (optional)
        this.addCommand({
            id: 'verify-folder-count-map',
            name: 'Verify Folder Count Map',
            callback: () => {
                try {
                    const recomputed = getFolderNoteCountMap(this);
                    const current = usePluginStore.getState().folderFileCountMap;
                    let same = Object.keys(recomputed).length === Object.keys(current).length;
                    if (same) {
                        const allKeys = new Set([...Object.keys(recomputed), ...Object.keys(current)]);
                        for (const key of allKeys) {
                            const r = recomputed[key];
                            const c = current[key];
                            if (!r || !c || r.open !== c.open || r.closed !== c.closed) {
                                same = false;
                                break;
                            }
                        }
                    }
                    if (same) {
                        new Notice('File Tree Alternative: folder count map matches');
                    } else {
                        console.warn('File Tree Alternative: folder count map mismatch', { recomputed, current });
                        new Notice('File Tree Alternative: folder count map mismatch (see console)');
                    }
                } catch (e) {
                    console.warn('File Tree Alternative: verify-folder-count-map failed', e);
                }
            },
        });

        // Add event listeners for vault changes (using registerEvent for proper cleanup)
        this.registerEvent(this.app.vault.on('create', this.onCreate));
        this.registerEvent(this.app.vault.on('delete', this.onDelete));
        this.registerEvent(this.app.vault.on('modify', this.onModify));
        this.registerEvent(this.app.vault.on('rename', this.onRename));

        // Subscribe to the store's visibility flag so IO-driven transitions
        // (IntersectionObserver in MainComponent) drain queued recent-folder work.
        // This is the single transition consumer; avoid adding other callers.
        usePluginStore.subscribe((state, prev) => {
            if (state.treeVisible && !prev.treeVisible) {
                this.onTreeBecameVisible();
            }
        });

        // Ribbon Icon For Opening
        this.refreshIconRibbon();

        // Expose a small public API for inter-plugin integration.
        // Other plugins (e.g. Current Folder Notes) can call
        //   window['file-tree-alternative'].revealFolder(path)
        //   window['file-tree-alternative'].openView()
        (window as any)['file-tree-alternative'] = {
            revealFolder: (folderPath: string) => {
                const folder = this.app.vault.getAbstractFileByPath(folderPath);
                if (folder && folder instanceof TFolder) {
                    this.revealFolderInTree(folder);
                } else {
                    new Notice(`File Tree Alternative: folder not found - ${folderPath}`);
                }
            },
            openView: () => this.openFileTreeLeaf(true),
        };
    }

    onunload() {
        console.log('Unloading Alternative File Tree Plugin');
        // Cancel any pending debounced dedup so its timer cannot fire after unload.
        this.debouncedDeduplicate.cancel();
        this.detachFileTreeLeafs();
        this.bookmarksRemoveEventListener();
        this.breadcrumbRemoveEventListener();
        delete (window as any)['file-tree-alternative'];
        // Drain queued recent-folder events into the map so they survive in the cache.
        this.drainRecentFolderUpdateQueue();
        if (this.recentFolderUpdateTimer) clearTimeout(this.recentFolderUpdateTimer);
        // Flush pending recent-folder cache before the timeouts/localStorage go away
        if (this.recentFoldersPersistTimer) {
            clearTimeout(this.recentFoldersPersistTimer);
            this.recentFoldersPersistTimer = null;
        }
        this.flushRecentFoldersCache(true);
    }

    async loadSettings() {
        const savedData = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, savedData);
        // Migrate recentFoldersCount from string (dropdown) to number
        if (typeof (this.settings as any).recentFoldersCount === 'string') {
            (this.settings as any).recentFoldersCount = parseInt((this.settings as any).recentFoldersCount, 10) || 1;
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /** Debounced version of saveSettings — batches rapid sequential setting changes into a single write. */
    debouncedSaveSettings = (() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        return () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                this.saveData(this.settings);
                timer = null;
            }, 100);
        };
    })();

    bookmarksEventHandler = (event: Event) => {
        // Find the tree-item that includes the bookmarks plugin title
        let treeItem: Element = (event.target as any).closest('.tree-item');
        if (!treeItem) return;
        // If it exists, get the title of the bookmark
        let dataPath: string = treeItem.getAttribute('data-path');
        if (!dataPath || dataPath === '') return;
        // Find the bookmark from the items
        let bookmarkItem = getBookmarkTitle(dataPath);
        // Create Custom Menu only if Shift is Used
        if ((event as any).shiftKey) {
            if (!bookmarkItem) return;
            event.stopImmediatePropagation();
            if (bookmarkItem.type === 'file') {
                eventBus.emit(eventTypes.revealFile, {
                    file: this.app.vault.getAbstractFileByPath(bookmarkItem.path),
                });
            } else if (bookmarkItem.type === 'folder') {
                event.stopImmediatePropagation();
                eventBus.emit(eventTypes.revealFolder, {
                    folder: this.app.vault.getAbstractFileByPath(bookmarkItem.path),
                });
            } else {
                new Notice('Not a file or folder');
            }
        }
    };

    getBookmarksLeafElement = (): Element => {
        return document.querySelector('.workspace-leaf-content[data-type="bookmarks"]');
    };

    bookmarksAddEventListener = () => {
        let bookmarkLeafElement = this.getBookmarksLeafElement();
        if (bookmarkLeafElement) {
            bookmarkLeafElement.addEventListener('click', this.bookmarksEventHandler, true);
        }
    };

    bookmarksRemoveEventListener = () => {
        let bookmarkLeafElement = this.getBookmarksLeafElement();
        if (bookmarkLeafElement) {
            bookmarkLeafElement.removeEventListener('click', this.bookmarksEventHandler, true);
        }
    };

    // --- Native breadcrumb folder-click interception ---
    // Redirects clicks on folder spans in Obsidian's native note breadcrumb
    // (the path bar at the top of a note) to reveal the folder in File Tree
    // Alternative instead of the native file explorer. Mirrors the bookmarks
    // capture-phase interception pattern above.
    private readonly BREADCRUMB_FOLDER_SELECTOR = '.view-header-breadcrumb';
    private readonly BREADCRUMB_CONTAINER_SELECTOR = '.view-header-title-parent';

    breadcrumbEventHandler = (event: Event) => {
        const evt = event as MouseEvent;
        // Only intercept plain left-clicks; let Ctrl/Cmd-click and middle-click
        // fall through to Obsidian's native "open in new pane" behavior.
        if (evt.button !== 0 || evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;

        const target = event.target as HTMLElement | null;
        if (!target) return;

        // Must be inside a native breadcrumb container.
        const container = target.closest(this.BREADCRUMB_CONTAINER_SELECTOR);
        if (!container) return;

        // Must be a breadcrumb folder span (Obsidian renders these as
        // <span class="view-header-breadcrumb">).
        const folderEl = target.closest(this.BREADCRUMB_FOLDER_SELECTOR) as HTMLElement | null;
        if (!folderEl) return;

        // Resolve the folder path by reconstructing from the active file's
        // parent path and the segment position within the breadcrumb.
        const folderPath = this.resolveBreadcrumbFolderPath(folderEl, container as HTMLElement);
        if (folderPath === null) return;

        // Handle root path — reveal vault root.
        if (folderPath === '') {
            event.stopImmediatePropagation();
            event.preventDefault();
            const root = this.app.vault.getRoot();
            if (root) this.revealFolderInTree(root);
            return;
        }

        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder || !(folder instanceof TFolder)) return;

        // Stop Obsidian's native reveal-in-file-explorer behavior.
        event.stopImmediatePropagation();
        event.preventDefault();

        // Reveal in File Tree Alternative.
        this.revealFolderInTree(folder);
    };

    /**
     * Best-effort extraction of the clicked folder's vault path from the
     * breadcrumb DOM. Obsidian's breadcrumb spans don't carry data attributes —
     * the folder path is only available via closure in Obsidian's own click
     * handler. We reconstruct it from the active file's parent path and the
     * segment position within the breadcrumb container.
     */
    private resolveBreadcrumbFolderPath(folderEl: HTMLElement, container: HTMLElement): string | null {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || !activeFile.parent) return null;

        const segments = Array.from(
            container.querySelectorAll(this.BREADCRUMB_FOLDER_SELECTOR)
        );
        const clickedIndex = segments.indexOf(folderEl);
        if (clickedIndex === -1) return null;

        const parentPath = activeFile.parent.path;
        // Root path (empty string or "/") is handled separately by the caller.
        if (!parentPath || parentPath === '/') return '';

        const parts = parentPath.split('/');
        // clickedIndex maps to the first (clickedIndex + 1) segments of parentPath.
        // Obsidian renders breadcrumbs from file.parent.path.split("/"), where
        // span[0] = parts[0], span[1] = parts[1], etc.
        return parts.slice(0, clickedIndex + 1).join('/');
    }

    breadcrumbAddEventListener = () => {
        document.addEventListener('click', this.breadcrumbEventHandler, true);
    };

    breadcrumbRemoveEventListener = () => {
        document.removeEventListener('click', this.breadcrumbEventHandler, true);
    };

    /** Opens the File Tree view (if needed) and emits the revealFolder event. */
    revealFolderInTree = async (folder: TFolder) => {
        await this.openFileTreeLeaf(true);
        eventBus.emit(eventTypes.revealFolder, { folder });
    };

    triggerVaultChangeEvent = (file: TAbstractFile, changeType: VaultChange, oldPath?: string) => {
        eventBus.emit(eventTypes.vaultChange, {
            file: file,
            changeType: changeType,
            oldPath: oldPath ? oldPath : '',
        });
    };

    onCreate = (file: TAbstractFile) => {
        try {
            this.triggerVaultChangeEvent(file, 'create', '');
            this.updateRecentFolderOnVaultEvent(file, 'create');
        } catch (e) {
            console.warn('File Tree Alternative: onCreate failed', e);
        }
    };
    onDelete = (file: TAbstractFile) => {
        try {
            invalidateOZFileCache(file.path);
            this.triggerVaultChangeEvent(file, 'delete', '');
            this.updateRecentFolderOnVaultEvent(file, 'delete');
        } catch (e) {
            console.warn('File Tree Alternative: onDelete failed', e);
        }
    };
    onModify = (file: TAbstractFile) => {
        try {
            this.triggerVaultChangeEvent(file, 'modify', '');
            this.updateRecentFolderOnVaultEvent(file, 'modify');
        } catch (e) {
            console.warn('File Tree Alternative: onModify failed', e);
        }
    };
    onRename = (file: TAbstractFile, oldPath: string) => {
        try {
            invalidateOZFileCache(oldPath);
            this.triggerVaultChangeEvent(file, 'rename', oldPath);
            this.updateRecentFolderOnVaultEvent(file, 'rename', oldPath);
        } catch (e) {
            console.warn('File Tree Alternative: onRename failed', e);
        }
    };

    refreshIconRibbon = () => {
        this.ribbonIconEl?.remove();
        if (this.settings.ribbonIcon) {
            this.ribbonIconEl = this.addRibbonIcon(this.ICON, 'File Tree Alternative Plugin', async () => {
                await this.openFileTreeLeaf(true);
            });
        }
    };

    /**
     * Clean up duplicate panes, keeping the preferred live FileTreeView leaf
     * (first leaf whose view is a FileTreeView, falling back to the first leaf)
     * and destroying/detaching the rest.
     * This prevents the accumulation of duplicate panes that occurs
     * on mobile when workspace restoration and plugin initialization race.
     */
    deduplicateFileTreeLeaves = () => {
        // Re-entrancy guard is load-bearing: detaching a leaf can fire layout-change,
        // which would otherwise call this method again and drop the surviving leaf.
        if (this.dedupRunning) return;
        this.dedupRunning = true;
        try {
            const leafs = getFileTreeLeaves(this.app, this.VIEW_TYPE);
            if (leafs.length < 2) return;
            const preferred = leafs.find((l) => l.view instanceof FileTreeView) ?? leafs[0];
            for (const leaf of leafs) {
                if (leaf === preferred) continue;
                if (leaf.view instanceof FileTreeView) leaf.view.destroy();
                leaf.detach();
            }
        } finally {
            this.dedupRunning = false;
        }
    };

    openFileTreeLeaf = (showAfterAttach: boolean): Promise<void> => {
        const run = () => this.doOpenFileTreeLeaf(showAfterAttach);
        const result = (this.openTreeQueue ?? Promise.resolve()).then(run, run);
        this.openTreeQueue = result.then((): void => undefined, (): void => undefined);
        return result;
    };

    doOpenFileTreeLeaf = async (showAfterAttach: boolean): Promise<void> => {
        let leafs = getFileTreeLeaves(this.app, this.VIEW_TYPE);

        // Deduplication: if there are multiple leaves, clean up extras
        if (leafs.length > 1) {
            this.deduplicateFileTreeLeaves();
            leafs = getFileTreeLeaves(this.app, this.VIEW_TYPE);
        }

        if (leafs.length == 0) {
            // Only create a new leaf if we haven't already done so during layout init
            // This prevents race conditions with workspace restoration on mobile restart
            if (this.viewOpenedOnStart) return;

            // Mobile restore can leave saved leaves invisible to getLeavesOfType for a
            // beat; callers are serialized, so wait once and recount before creating.
            await new Promise((r) => setTimeout(r, 50));
            leafs = getFileTreeLeaves(this.app, this.VIEW_TYPE);
            if (leafs.length > 0) {
                // Restored leaf appeared — reveal it instead of creating a duplicate.
                if (showAfterAttach) {
                    this.app.workspace.revealLeaf(leafs[0]);
                    usePluginStore.getState().setTreeVisible(true);
                }
                return;
            }

            // Needs to be mounted
            let leaf = this.app.workspace.getLeftLeaf(false);
            if (!leaf) {
                new Notice('Could not create File Tree pane');
                return;
            }
            await leaf.setViewState({ type: this.VIEW_TYPE });
            if (showAfterAttach) {
                this.app.workspace.revealLeaf(leaf);
                usePluginStore.getState().setTreeVisible(true);
            }
        } else {
            // Already mounted - show only the first leaf
            if (showAfterAttach) {
                this.app.workspace.revealLeaf(leafs[0]);
                usePluginStore.getState().setTreeVisible(true);
            }
        }
    };

    detachFileTreeLeafs = () => {
        const leafs = getFileTreeLeaves(this.app, this.VIEW_TYPE);
        for (const leaf of leafs) {
            if (leaf.view instanceof FileTreeView) {
                leaf.view.destroy();
            }
            leaf.detach();
        }
    };

    refreshTreeLeafs = () => {
        this.detachFileTreeLeafs();
        this.openFileTreeLeaf(true);
    };

    /**
     * Load recent folders cache from localStorage on startup.
     * Falls back to empty if cache is missing or corrupt.
     * Does NOT scan the vault — relies on vault events to fill in.
     */
    loadRecentFoldersCache = () => {
        if (!this.settings.highlightRecentFolders) {
            this.clearRecentFolders();
            return;
        }
        try {
            const cached = loadScoped(this.keys.recentFoldersCacheKey);
            if (cached) {
                const folderMtimes = new Map<string, number>(JSON.parse(cached));
                // Prune stale entries (folders that no longer exist)
                this.pruneRecentFoldersCache(folderMtimes);
                // Derive display maps from the raw cache
                const { recentFolders, folderDepth, folderTrailIndex } = deriveRecentFolders(folderMtimes, this.app, this.settings.recentFoldersCount);
                usePluginStore.getState().setRecentFolderState({
                    recentModifiedFolders: recentFolders,
                    recentFolderDepth: folderDepth,
                    recentFolderTrailIndex: folderTrailIndex,
                    recentFolderMtimes: folderMtimes,
                });
            }
        } catch (e) {
            console.warn('File Tree Alternative: Failed to load recent folders cache', e);
        }
    };

    /** Prune entries from folderMtimes for folders that no longer exist in the vault. */
    pruneRecentFoldersCache = (folderMtimes: Map<string, number>) => {
        for (const [folderPath] of folderMtimes) {
            if (folderPath !== '' && folderPath !== '/' && !this.app.vault.getAbstractFileByPath(folderPath)) {
                folderMtimes.delete(folderPath);
            }
        }
    };

    /**
     * Incremental update: O(d) per event instead of O(n×d) full scan.
     * On modify/create: update file.parent.path and all ancestors with file.stat.mtime
     * On delete: recompute parent folder's max mtime from remaining children, propagate up
     * On rename: delete old path entries + create new path entries
     */
    updateRecentFolderOnVaultEvent = (file: TAbstractFile, eventType: 'create' | 'delete' | 'modify' | 'rename', oldPath?: string) => {
        if (!this.settings.highlightRecentFolders) {
            this.clearRecentFolders();
            return;
        }
        // Debounce rapid successive events (common during sync / startup burst)
        this.debouncedRecentFolderUpdate(file, eventType, oldPath);
    };

    /** Clear all recent folders data from store and localStorage. */
    clearRecentFolders = () => {
        usePluginStore.getState().setRecentFolderState({
            recentModifiedFolders: new Map(),
            recentFolderDepth: new Map(),
            recentFolderMtimes: new Map(),
            recentFolderTrailIndex: new Map(),
        });
        // Drop any pending persist so the timer cannot resurrect an empty cache after removal
        this.recentFoldersPersistDirty = false;
        if (this.recentFoldersPersistTimer) {
            clearTimeout(this.recentFoldersPersistTimer);
            this.recentFoldersPersistTimer = null;
        }
        removeScoped(this.keys.recentFoldersCacheKey);
    };

    /**
     * Pure map mutation — updates the folderMtimes map in-place for a single vault event.
     * Does NOT call deriveRecentFolders, does NOT update store, does NOT persist.
     */
    private applyRecentFolderEvent = (folderMtimes: Map<string, number>, file: TAbstractFile, eventType: 'create' | 'delete' | 'modify' | 'rename', oldPath?: string) => {
        if (eventType === 'modify' || eventType === 'create') {
            if (file instanceof TFile) {
                const mtime = file.stat?.mtime ?? 0;
                let folder = file.parent;
                while (folder) {
                    const current = folderMtimes.get(folder.path);
                    if (current === undefined || mtime > current) {
                        folderMtimes.set(folder.path, mtime);
                    }
                    folder = folder.parent;
                }
            }
        } else if (eventType === 'delete') {
            if (file instanceof TFile && file.parent) {
                this.recomputeFolderMtime(folderMtimes, file.parent);
            }
        } else if (eventType === 'rename') {
            if (file instanceof TFile && oldPath) {
                const oldParentPath = oldPath.substring(0, oldPath.lastIndexOf('/'));
                if (oldParentPath) {
                    const oldFolder = this.app.vault.getAbstractFileByPath(oldParentPath);
                    if (oldFolder instanceof TFolder) {
                        this.recomputeFolderMtime(folderMtimes, oldFolder);
                    }
                }
                const mtime = file.stat?.mtime ?? 0;
                let folder = file.parent;
                while (folder) {
                    const current = folderMtimes.get(folder.path);
                    if (current === undefined || mtime > current) {
                        folderMtimes.set(folder.path, mtime);
                    }
                    folder = folder.parent;
                }
            }
        }
    };

    /**
     * Derive display maps from the folderMtimes, batch-update the Zustand store
     * in a single call. Persistence is deferred: the store update happens per flush,
     * but the localStorage write only happens after 5 quiet seconds (or on unload).
     */
    private finalizeRecentFolderUpdate = (folderMtimes: Map<string, number>) => {
        const { recentFolders, folderDepth, folderTrailIndex } = deriveRecentFolders(folderMtimes, this.app, this.settings.recentFoldersCount);
        usePluginStore.getState().setRecentFolderState({
            recentModifiedFolders: recentFolders,
            recentFolderDepth: folderDepth,
            recentFolderTrailIndex: folderTrailIndex,
            recentFolderMtimes: folderMtimes,
        });

        this.scheduleRecentFoldersPersist();
    };

    /** Dirty flag + trailing timer so recent-folder caching never blocks the 200ms flush path. */
    private recentFoldersPersistDirty = false;
    private recentFoldersPersistTimer: ReturnType<typeof setTimeout> | null = null;

    private scheduleRecentFoldersPersist = () => {
        this.recentFoldersPersistDirty = true;
        if (this.recentFoldersPersistTimer) clearTimeout(this.recentFoldersPersistTimer);
        this.recentFoldersPersistTimer = setTimeout(() => {
            this.recentFoldersPersistTimer = null;
            this.flushRecentFoldersCache();
        }, MOBILE_TUNING.persistDebounceMs);
    };

    /** Write the serialized map to localStorage only if it changed since the last write. */
    private flushRecentFoldersCache = (force: boolean = false) => {
        if (!force && isTreeHidden()) return;
        if (!this.recentFoldersPersistDirty) return;
        this.recentFoldersPersistDirty = false;
        try {
            // Read the freshest map from the store so overlapping updates collapse into one write
            const folderMtimes = usePluginStore.getState().recentFolderMtimes;
            saveScoped(this.keys.recentFoldersCacheKey, JSON.stringify(Array.from(folderMtimes.entries())));
        } catch (e) {
            console.warn('File Tree Alternative: Failed to persist recent folders cache', e);
        }
    };

    /**
     * Recompute a folder's max mtime by checking its remaining children's files.
     * Propagate the change up to ancestors.
     */
    private recomputeFolderMtime = (folderMtimes: Map<string, number>, folder: TFolder) => {
        // Find the max mtime among this folder's direct and nested file children
        let maxMtime = 0;
        const collectMaxMtime = (f: TFolder): number => {
            let max = 0;
            for (const child of f.children ?? []) {
                if (child instanceof TFile) {
                    if (child.stat.mtime > max) max = child.stat.mtime;
                } else if (child instanceof TFolder) {
                    const childMax = collectMaxMtime(child);
                    if (childMax > max) max = childMax;
                }
            }
            return max;
        };
        maxMtime = collectMaxMtime(folder);

        if (maxMtime === 0) {
            folderMtimes.delete(folder.path);
        } else {
            folderMtimes.set(folder.path, maxMtime);
        }

        // Propagate up to ancestors
        let parent = folder.parent;
        while (parent) {
            const current = folderMtimes.get(parent.path);
            if (current === undefined || maxMtime > current) {
                if (maxMtime > 0) {
                    folderMtimes.set(parent.path, maxMtime);
                }
            }
            // Also check if parent's max should be lowered — we'd need to recompute
            // parent too, but for simplicity just set if higher
            parent = parent.parent;
        }
    };

    /** Drain the queued recent-folder events into a single store update + persist schedule. */
    private drainRecentFolderUpdateQueue = () => {
        const queue = [...this.recentFolderUpdateQueue];
        this.recentFolderUpdateQueue = [];
        this.recentFolderUpdateTimer = null;
        if (queue.length === 0) return;

        // Single map copy for the entire batch
        const folderMtimes = new Map(usePluginStore.getState().recentFolderMtimes);

        try {
            // Process the last event for each unique file path, mutating the same map
            const seen = new Set<string>();
            for (let i = queue.length - 1; i >= 0; i--) {
                const item = queue[i];
                const key = item.file.path + item.eventType;
                if (seen.has(key)) continue;
                seen.add(key);
                this.applyRecentFolderEvent(folderMtimes, item.file, item.eventType as any, item.oldPath);
            }

            // Single derive + store update + localStorage persist
            this.finalizeRecentFolderUpdate(folderMtimes);
        } catch (e) {
            console.warn('File Tree Alternative: drainRecentFolderUpdateQueue failed', e);
        }
    };

    /** Deferred work that must run as soon as the file-tree pane becomes visible. */
    private onTreeBecameVisible = () => {
        if (this.recentFolderUpdateTimer) {
            clearTimeout(this.recentFolderUpdateTimer);
            this.recentFolderUpdateTimer = null;
        }
        if (this.recentFolderUpdateQueue.length > 0) {
            this.drainRecentFolderUpdateQueue();
        }
        if (this.recentFoldersPersistDirty) {
            this.flushRecentFoldersCache();
        }
    };

    /** Debounced wrapper for recent folder updates — batches rapid successive vault events. */
    private recentFolderUpdateQueue: { file: TAbstractFile; eventType: string; oldPath?: string }[] = [];
    private recentFolderUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    private debouncedRecentFolderUpdate = (file: TAbstractFile, eventType: 'create' | 'delete' | 'modify' | 'rename', oldPath?: string) => {
        this.recentFolderUpdateQueue.push({ file, eventType, oldPath });
        if (this.recentFolderUpdateTimer) clearTimeout(this.recentFolderUpdateTimer);
        this.recentFolderUpdateTimer = setTimeout(() => {
            if (isTreeHidden()) {
                this.recentFolderUpdateTimer = null;
                return;
            }
            this.drainRecentFolderUpdateQueue();
        }, MOBILE_TUNING.recentFolderQueueMs);
    };
}
