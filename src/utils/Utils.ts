import { TFile, TFolder, App, Keymap, Platform } from 'obsidian';
import FileTreeAlternativePlugin from 'main';
import { FolderFileCountMap, FolderTree, OZFile, BookmarksPluginItem } from 'utils/types';
import { VaultChangeModal } from 'modals';
import { usePluginStore } from '../recoil/pluginStore';

export interface FileVisibilityOptions {
    excludedExtensions: string[];
    excludedFolders: string[];
    hideAttachments: boolean;
    attachmentsFolderName: string;
    /** 'notes' counts only markdown files; undefined/'files' counts everything */
    folderCountOption?: string;
    /** exclude folder notes (basename === parent folder name) from counts */
    excludeFolderNotes?: boolean;
}

// Single source of truth for whether a file is visible in listings AND counted in folder badges,
// so the badge number can never disagree with what clicking the folder shows.
export const isFileVisibleInList = (file: TFile, opts: FileVisibilityOptions): boolean => {
    if (opts.excludedExtensions.includes(file.extension)) return false;
    if (opts.hideAttachments && file.path.toLowerCase().includes(opts.attachmentsFolderName.toLowerCase())) return false;
    if (file.parent && opts.excludedFolders.includes(file.parent.path)) return false;
    if (opts.folderCountOption === 'notes' && file.extension !== 'md') return false;
    if (opts.excludeFolderNotes && file.extension === 'md' && file.basename === file.parent?.name) return false;
    return true;
};

// Helper Function To Get List of Files
export const getFilesUnderPath = (params: {
    path: string;
    plugin: FileTreeAlternativePlugin;
    excludedExtensions: string[];
    excludedFolders: string[];
    getAllFiles?: boolean;
}): OZFile[] => {
    const { path, plugin, getAllFiles, excludedExtensions, excludedFolders } = params;
    const filesUnderPath: OZFile[] = [];
    const showFilesFromSubFolders = getAllFiles ? true : plugin.settings.showFilesFromSubFolders;
    const folderObj = plugin.app.vault.getFolderByPath(path);
    if (!folderObj) return filesUnderPath;
    recursiveFx(folderObj, plugin.app);
    function recursiveFx(folderObj: TFolder, app: App) {
        if (folderObj instanceof TFolder && folderObj.children) {
            for (let child of folderObj.children) {
                if (child instanceof TFile) {
                    if (
                        !isFileVisibleInList(child, {
                            excludedExtensions,
                            excludedFolders,
                            hideAttachments: plugin.settings.hideAttachments,
                            attachmentsFolderName: plugin.settings.attachmentsFolderName,
                        })
                    )
                        continue;
                    filesUnderPath.push(TFile2OZFile(child));
                }
                if (child instanceof TFolder && showFilesFromSubFolders) recursiveFx(child, app);
            }
        }
    }
    return filesUnderPath;
};

// Converted from TFile to OZFile
export const TFile2OZFile = (t: TFile): OZFile => {
    return {
        path: t.path,
        basename: t.basename,
        extension: t.extension,
        stat: {
            mtime: t.stat.mtime,
            ctime: t.stat.ctime,
            size: t.stat.size,
        },
        parent: {
            path: t.parent.path,
        },
        isFolderNote: isFolderNote(t),
    };
};

// Check if the file is a folder note
export const isFolderNote = (t: TFile) => {
    return t.extension === 'md' && t.basename === t.parent.name;
};

// Helper Function to Create Folder Tree
export const createFolderTree = (params: { startFolder: TFolder; excludedFolders: string[]; plugin: FileTreeAlternativePlugin }): FolderTree => {
    const { startFolder, excludedFolders, plugin } = params;
    let fileTree: { folder: TFolder; children: any } = { folder: startFolder, children: [] };
    function recursive(folder: TFolder, object: { folder: TFolder; children: any }) {
        if (!(folder && folder.children)) return;
        for (let child of folder.children) {
            if (child instanceof TFolder) {
                let childFolder: TFolder = child as TFolder;
                if (
                    (plugin.settings.hideAttachments && childFolder.name === plugin.settings.attachmentsFolderName) ||
                    (excludedFolders.length > 0 && excludedFolders.includes(child.path))
                ) {
                    continue;
                }
                let newObj: { folder: TFolder; children: any } = { folder: childFolder, children: [] };
                object.children.push(newObj);
                if (childFolder.children) recursive(childFolder, newObj);
            }
        }
    }
    recursive(startFolder, fileTree);
    return fileTree;
};

// Create Folder File Count Map
export const getFolderNoteCountMap = (plugin: FileTreeAlternativePlugin, filters?: { excludedExtensions?: string[]; excludedFolders?: string[] }): FolderFileCountMap => {
    // Fall back to the same store state the file listing uses, so badges match listings
    const storeState = usePluginStore.getState();
    const excludedExtensions = filters?.excludedExtensions ?? storeState.excludedExtensions ?? [];
    const excludedFolders = filters?.excludedFolders ?? storeState.excludedFolders ?? [];
    const counts: FolderFileCountMap = {};
    let files: TFile[];
    if (plugin.settings.folderCountOption === 'notes') {
        files = plugin.app.vault.getMarkdownFiles();
    } else {
        files = plugin.app.vault.getFiles();
    }

    files = files.filter((f) =>
        isFileVisibleInList(f, {
            excludedExtensions,
            excludedFolders,
            hideAttachments: plugin.settings.hideAttachments,
            attachmentsFolderName: plugin.settings.attachmentsFolderName,
            folderCountOption: plugin.settings.folderCountOption,
            excludeFolderNotes: plugin.settings.folderNote,
        })
    );

    files.forEach((file) => {
        for (let folder = file.parent; folder != null; folder = folder.parent) {
            // -> Create object if doesn't exist
            if (!counts[folder.path]) counts[folder.path] = { open: 0, closed: 0 };
            // -> Create number for open state
            if (folder == file.parent) counts[folder.path].open = 1 + counts[folder.path].open;
            // -> Create number for closed state
            counts[folder.path].closed = 1 + counts[folder.path].closed;
        }
    });
    return counts;
};

/** Incremental folder count update: add or remove a single file from the count map without rebuilding everything.
 *  @param map - existing count map (will be mutated and returned)
 *  @param file - the file being created or deleted
 *  @param delta - +1 for create, -1 for delete
 *  @param visibilityOptions - same visibility rules the listing uses (see isFileVisibleInList)
 */
export const incrementFolderCountMap = (map: FolderFileCountMap, file: TFile, delta: 1 | -1, visibilityOptions: FileVisibilityOptions): FolderFileCountMap => {
    // Skip files that are not visible in listings so badges stay in sync
    if (!isFileVisibleInList(file, visibilityOptions)) return map;

    for (let folder = file.parent; folder != null; folder = folder.parent) {
        if (!map[folder.path]) map[folder.path] = { open: 0, closed: 0 };
        // Open count: only direct parent
        if (folder == file.parent) map[folder.path].open += delta;
        // Closed count: all ancestors
        map[folder.path].closed += delta;
    }
    return map;
};

// Check if folder has child folder
export const hasChildFolder = (folder: TFolder): boolean => {
    let children = folder.children;
    for (let child of children) {
        if (child instanceof TFolder) return true;
    }
    return false;
};

// Files out of Md should be listed with extension badge - Md without extension
export const getFileNameAndExtension = (fullName: string) => {
    const index = fullName.lastIndexOf('.');
    return {
        fileName: fullName.substring(0, index),
        extension: fullName.substring(index + 1),
    };
};

// Returns all parent folder paths
export const getParentFolderPaths = (file: TFile): string[] => {
    let folderPaths: string[] = ['/'];
    let parts: string[] = file.parent.path.split('/');
    let current: string = '';
    for (let i = 0; i < parts.length; i++) {
        current += `${i === 0 ? '' : '/'}` + parts[i];
        folderPaths.push(current);
    }
    return folderPaths;
};

// Extracts the Folder Name from the Full Folder Path
export const getFolderName = (folderPath: string, app: App) => {
    if (folderPath === '/' || folderPath === '') return app.vault.getName();
    let index = folderPath.lastIndexOf('/');
    if (index !== -1) return folderPath.substring(index + 1);
    return folderPath;
};

/** Returns breadcrumb segments for a folder path.
 *  Each segment has a label (folder name) and the full path to that folder. */
export const getBreadcrumbSegments = (folderPath: string, app: App): { label: string; path: string }[] => {
    const vaultName = app.vault.getName();
    if (folderPath === '/' || folderPath === '') {
        return [{ label: vaultName, path: '/' }];
    }
    const segments: { label: string; path: string }[] = [{ label: vaultName, path: '/' }];
    const parts = folderPath.split('/');
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        segments.push({ label: part, path: current });
    }
    return segments;
};

export const internalPluginLoaded = (pluginName: string, app: App) => {
    return (app as any).internalPlugins.plugins[pluginName]?._loaded;
};

export const openInternalLink = (event: React.MouseEvent<Element, MouseEvent>, link: string, app: App) => {
    app.workspace.openLinkText(link, '/', Keymap.isModifier(event as unknown as MouseEvent, 'Mod') || 1 === event.button);
};

export const pluginIsLoaded = (app: App, pluginId: string) => {
    return (app as any).plugins.getPlugin(pluginId);
};

/** Simple debounce: returns a function that delays invoking `fn` until `delay` ms have elapsed since the last call. */
export function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T & { cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = (...args: any[]) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            fn(...args);
            timer = null;
        }, delay);
    };
    debounced.cancel = () => {
        if (timer) clearTimeout(timer);
        timer = null;
    };
    return debounced as T & { cancel: () => void };
}

export const platformIsMobile = () => {
    return Platform.isMobile;
};

export const createNewFile = async (e: React.MouseEvent | null, folderPath: string, plugin: FileTreeAlternativePlugin) => {
    const targetFolder = plugin.app.vault.getFolderByPath(folderPath);
    if (!targetFolder) return;
    const modal = new VaultChangeModal(plugin, targetFolder, 'create note');
    modal.open();
};

// Global 'app' is provided by Obsidian at runtime (not imported)
declare const app: App;

export const getBookmarksPluginItems = (): BookmarksPluginItem[] => {
    return (app as any).internalPlugins.plugins['bookmarks'].instance.items as BookmarksPluginItem[];
};

export const getBookmarkTitle = (title: string): BookmarksPluginItem => {
    let bookmarkItems = getBookmarksPluginItems();
    let titleParts = title.split('/');
    let currentItem: BookmarksPluginItem = bookmarkItems.find((b) => b.title === titleParts[0]);
    for (let i = 1; i < titleParts.length; i++) {
        currentItem = currentItem.items.find((b) => b.title === titleParts[i]);
    }
    return currentItem;
};

/**
 * Derive recentModifiedFolders, recentFolderDepth, and folderTrailIndex from a pre-built folderMtimes map.
 * This is O(k) where k = number of folders in the map, NOT O(n×d) full vault scan.
 *
 * - recentModifiedFolders: top N folders by mtime (excluding root and active folder)
 * - recentFolderDepth: ancestor trail with depth values for CSS gradient
 * - folderTrailIndex: maps every folder (primary + ancestors) to a trail index (0, 1, 2, etc.) for color coding
 *
 * @param folderMtimes - Map<folderPath, mtime> maintained incrementally by the plugin
 * @param app - Obsidian App instance (used to get active folder path from store)
 * @param count - how many top folders to highlight (default 1)
 */
export function deriveRecentFolders(
    folderMtimes: Map<string, number>,
    app: App,
    count = 1
): {
    recentFolders: Map<string, number>;
    folderDepth: Map<string, number>;
    folderTrailIndex: Map<string, number>;
} {
    const recentFolders = new Map<string, number>();
    const folderDepth = new Map<string, number>();
    const folderTrailIndex = new Map<string, number>();

    if (folderMtimes.size === 0) {
        return { recentFolders, folderDepth, folderTrailIndex };
    }

    // Get the active folder path to exclude from primary highlight
    const activeFolderPath = usePluginStore.getState().activeFolderPath;

    // Sort folders by mtime descending, exclude root and active folder, take top N
    const sortedFolders = Array.from(folderMtimes.entries())
        .filter(([folderPath]) => folderPath !== '/' && folderPath !== '')
        .filter(([folderPath]) => folderPath !== activeFolderPath)
        .sort((a, b) => b[1] - a[1])
        .slice(0, count);

    // Build recentFolders map and compute ancestor trail with depth and trail index
    sortedFolders.forEach((entry, trailIndex) => {
        const [folderPath, mtime] = entry;
        recentFolders.set(folderPath, mtime);

        // Assign trail index to the primary folder itself
        folderTrailIndex.set(folderPath, trailIndex);

        // Split path and filter empty strings from leading slash.
        // Reconstruct paths WITHOUT a leading '/' so they match Obsidian's
        // TFolder.path format (e.g. "Projects/Novel/Scenes"). Root is the
        // only path that should keep the leading slash.
        const parts = folderPath.split('/').filter(Boolean);
        if (parts.length === 0) {
            // Root folder "/" — keep leading slash
            if (!folderDepth.has('/')) {
                folderDepth.set('/', 0);
            }
            if (!folderTrailIndex.has('/')) {
                folderTrailIndex.set('/', trailIndex);
            }
        } else {
            for (let i = 0; i < parts.length; i++) {
                const ancestorPath = parts.slice(0, i + 1).join('/');
                const depth = i + 1;
                const existing = folderDepth.get(ancestorPath);
                if (existing === undefined || depth > existing) {
                    folderDepth.set(ancestorPath, depth);
                }
                // Assign trail index to ancestor if not already assigned (first trail wins)
                if (!folderTrailIndex.has(ancestorPath)) {
                    folderTrailIndex.set(ancestorPath, trailIndex);
                }
            }
        }
    });

    return { recentFolders, folderDepth, folderTrailIndex };
}

/** Parse excluded extensions from settings string into an array */
function getExcludedExtensionsList(plugin: FileTreeAlternativePlugin): string[] {
    const result: string[] = [];
    for (const ext of plugin.settings.excludedExtensions.split(',')) {
        const trimmed = ext.trim();
        if (trimmed) result.push(trimmed);
    }
    return result;
}

/** Parse excluded folders from settings string into an array */
function getExcludedFoldersList(plugin: FileTreeAlternativePlugin): string[] {
    const result: string[] = [];
    if (plugin.settings.excludedFolders) {
        for (const folder of plugin.settings.excludedFolders.split(',')) {
            const trimmed = folder.trim();
            if (trimmed) result.push(trimmed);
        }
    }
    return result;
}
