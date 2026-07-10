import { Plugin, addIcon, TAbstractFile, TFolder, Notice } from 'obsidian';
import { FileTreeView } from './FileTreeView';
import { ZoomInIcon, ZoomOutIcon, ZoomOutDoubleIcon, LocationIcon, SpaceIcon } from './utils/icons';
import { FileTreeAlternativePluginSettings, FileTreeAlternativePluginSettingsTab, DEFAULT_SETTINGS } from './settings';
import { VaultChange, eventTypes } from 'utils/types';
import { eventBus } from 'utils/eventBus';
import { getBookmarkTitle, computeRecentFolders } from 'utils/Utils';
import { usePluginStore } from './recoil/pluginStore';

export default class FileTreeAlternativePlugin extends Plugin {
    settings: FileTreeAlternativePluginSettings;
    ribbonIconEl: HTMLElement | undefined = undefined;
    /** Guard flag to prevent duplicate pane creation during layout initialization */
    private viewOpenedOnStart: boolean = false;

    keys = {
        activeFolderPathKey: 'fileTreePlugin-ActiveFolderPath',
        pinnedFilesKey: 'fileTreePlugin-PinnedFiles',
        openFoldersKey: 'fileTreePlugin-OpenFolders',
        customHeightKey: 'fileTreePlugin-CustomHeight',
        customWidthKey: 'fileTreePlugin-CustomWidth',
        focusedFolder: 'fileTreePlugin-FocusedFolder',
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
        });

        // Listen for layout changes to catch and clean up any duplicate panes
        // that may appear after workspace restoration (common on mobile restart)
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.deduplicateFileTreeLeaves();
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

        // Add event listeners for vault changes (using registerEvent for proper cleanup)
        this.registerEvent(this.app.vault.on('create', this.onCreate));
        this.registerEvent(this.app.vault.on('delete', this.onDelete));
        this.registerEvent(this.app.vault.on('modify', this.onModify));
        this.registerEvent(this.app.vault.on('rename', this.onRename));

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
        this.detachFileTreeLeafs();
        this.bookmarksRemoveEventListener();
        this.breadcrumbRemoveEventListener();
        delete (window as any)['file-tree-alternative'];
    }

    async loadSettings() {
        const savedData = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, savedData);
        // Migrate: recentFoldersCount may be stored as a string; ensure it's a number
        if (typeof (this.settings as any).recentFoldersCount === 'string') {
            (this.settings as any).recentFoldersCount = parseInt((this.settings as any).recentFoldersCount, 10) || 2;
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
    // Redirects clicks on folder segments in Obsidian's native note breadcrumb
    // (the path bar at the top of a note) to reveal the folder in File Tree
    // Alternative instead of the native file explorer. Mirrors the bookmarks
    // capture-phase interception pattern above.
    private readonly BREADCRUMB_FOLDER_SELECTOR = '.view-header-breadcrumb-folder';
    private readonly BREADCRUMB_CONTAINER_SELECTOR = '.view-header-breadcrumb';
    private readonly BREADCRUMB_FILE_SELECTOR = '.view-header-breadcrumb-file';

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

        // Must be a folder segment (not the trailing file-name segment).
        const folderEl = target.closest(this.BREADCRUMB_FOLDER_SELECTOR) as HTMLElement | null;
        if (!folderEl || folderEl.classList.contains('view-header-breadcrumb-file')) return;

        // Resolve the folder path. Prefer explicit attributes, then reconstruct
        // from the active file's path + the clicked segment's position.
        const folderPath = this.resolveBreadcrumbFolderPath(folderEl, container as HTMLElement);
        if (!folderPath) return;

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
     * breadcrumb DOM. Falls back to reconstructing from the active file path.
     */
    private resolveBreadcrumbFolderPath(folderEl: HTMLElement, container: HTMLElement): string | null {
        // Strategy 1: explicit data/aria attributes.
        const dataPath = folderEl.getAttribute('data-path');
        if (dataPath) return dataPath === '/' || dataPath === '' ? '' : dataPath;
        const ariaLabel = folderEl.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim() !== '') return ariaLabel;

        // Strategy 2: reconstruct from active file path + segment index.
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return null;

        const segments = Array.from(
            container.querySelectorAll(`${this.BREADCRUMB_FOLDER_SELECTOR}, ${this.BREADCRUMB_FILE_SELECTOR}`)
        );
        const clickedIndex = segments.indexOf(folderEl);
        if (clickedIndex === -1) {
            // Folder not in the segment list (e.g. vault-root link); reveal root.
            return '';
        }

        // activeFile.parent.path is the folder containing the file. The file is
        // the last segment; folders precede it. Count folder segments up to and
        // including the clicked one to determine how deep the clicked folder is.
        const fileIndex = segments.length - 1; // file is last
        if (clickedIndex >= fileIndex) return activeFile.parent?.path ?? '';

        // Depth from the clicked folder to the file's parent.
        const depthBelowClicked = fileIndex - 1 - clickedIndex;
        let folder = activeFile.parent;
        for (let i = 0; i < depthBelowClicked && folder; i++) {
            folder = folder.parent;
        }
        return folder ? folder.path : '';
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

    onCreate = (file: TAbstractFile) => { this.triggerVaultChangeEvent(file, 'create', ''); this.refreshRecentFolders(); };
    onDelete = (file: TAbstractFile) => { this.triggerVaultChangeEvent(file, 'delete', ''); this.refreshRecentFolders(); };
    onModify = (file: TAbstractFile) => { this.triggerVaultChangeEvent(file, 'modify', ''); this.refreshRecentFolders(); };
    onRename = (file: TAbstractFile, oldPath: string) => { this.triggerVaultChangeEvent(file, 'rename', oldPath); this.refreshRecentFolders(); };

    refreshIconRibbon = () => {
        this.ribbonIconEl?.remove();
        if (this.settings.ribbonIcon) {
            this.ribbonIconEl = this.addRibbonIcon(this.ICON, 'File Tree Alternative Plugin', async () => {
                await this.openFileTreeLeaf(true);
            });
        }
    };

    /**
     * Clean up duplicate panes, keeping only the first one.
     * This prevents the accumulation of duplicate panes that occurs
     * on mobile when workspace restoration and plugin initialization race.
     */
    deduplicateFileTreeLeaves = () => {
        const leafs = this.app.workspace.getLeavesOfType(this.VIEW_TYPE);
        if (leafs.length > 1) {
            // Keep the first leaf, destroy and detach extras
            for (let i = 1; i < leafs.length; i++) {
                const leaf = leafs[i];
                if (leaf.view instanceof FileTreeView) {
                    leaf.view.destroy();
                }
                leaf.detach();
            }
        }
    };

    openFileTreeLeaf = async (showAfterAttach: boolean) => {
        let leafs = this.app.workspace.getLeavesOfType(this.VIEW_TYPE);

        // Deduplication: if there are multiple leaves, clean up extras
        if (leafs.length > 1) {
            this.deduplicateFileTreeLeaves();
            leafs = this.app.workspace.getLeavesOfType(this.VIEW_TYPE);
        }

        if (leafs.length == 0) {
            // Only create a new leaf if we haven't already done so during layout init
            // This prevents race conditions with workspace restoration on mobile restart
            if (this.viewOpenedOnStart) return;

            // Needs to be mounted
            let leaf = this.app.workspace.getLeftLeaf(false);
            if (!leaf) {
                new Notice('Could not create File Tree pane');
                return;
            }
            await leaf.setViewState({ type: this.VIEW_TYPE });
            if (showAfterAttach) this.app.workspace.revealLeaf(leaf);
        } else {
            // Already mounted - show only the first leaf
            if (showAfterAttach) {
                this.app.workspace.revealLeaf(leafs[0]);
            }
        }
    };

    detachFileTreeLeafs = () => {
        const leafs = this.app.workspace.getLeavesOfType(this.VIEW_TYPE);
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

    /** Recompute recently modified folders and update the Zustand store. */
    refreshRecentFolders = () => {
        if (!this.settings.highlightRecentFolders) {
            usePluginStore.getState().setRecentModifiedFolders(new Map());
            usePluginStore.getState().setRecentFolderDepth(new Map());
            return;
        }
        try {
            const { recentFolders, folderDepth } = computeRecentFolders(this);
            usePluginStore.getState().setRecentModifiedFolders(recentFolders);
            usePluginStore.getState().setRecentFolderDepth(folderDepth);
        } catch (e) {
            console.warn('File Tree Alternative: Failed to refresh recent folders', e);
        }
    };
}
