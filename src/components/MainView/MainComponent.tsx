import { TAbstractFile, TFile, TFolder, Notice } from 'obsidian';
import React, { useEffect, useRef, useMemo } from 'react';
import { FileComponent } from 'components/FileView/FileComponent';
import { MainFolder } from 'components/FolderView/MainFolder';
import { SingleViewVertical, SingleViewHorizontal } from 'components/MainView/SingleView';
import { FileTreeView } from 'FileTreeView';
import FileTreeAlternativePlugin from 'main';
import * as FileTreeUtils from 'utils/Utils';
import { scrollVirtualFileListToFile } from 'utils/virtualListBridge';
import { usePluginStore } from '../../recoil/pluginStore';
import useForceUpdate from 'hooks/ForceUpdate';
import { VaultChange, eventTypes, OZFile } from 'utils/types';
import { eventBus } from 'utils/eventBus';

interface MainTreeComponentProps {
    fileTreeView: FileTreeView;
    plugin: FileTreeAlternativePlugin;
}

export default function MainTreeComponent(props: MainTreeComponentProps) {
    // --> Main Variables
    const { plugin } = props;

    // --> Force Update Hook
    const forceUpdate = useForceUpdate();

    // --> Plugin States (Zustand)
    const view = usePluginStore((s) => s.view);
    const setView = usePluginStore((s) => s.setView);
    const activeFolderPath = usePluginStore((s) => s.activeFolderPath);
    const setActiveFolderPath = usePluginStore((s) => s.setActiveFolderPath);
    const ozFileList = usePluginStore((s) => s.ozFileList);
    const setOzFileList = usePluginStore((s) => s.setOzFileList);
    const ozPinnedFiles = usePluginStore((s) => s.ozPinnedFileList);
    const setOzPinnedFiles = usePluginStore((s) => s.setOzPinnedFileList);
    const openFolders = usePluginStore((s) => s.openFolders);
    const setOpenFolders = usePluginStore((s) => s.setOpenFolders);
    const setFolderTree = usePluginStore((s) => s.setFolderTree);
    const excludedFolders = usePluginStore((s) => s.excludedFolders);
    const setExcludedFolders = usePluginStore((s) => s.setExcludedFolders);
    const setFolderFileCountMap = usePluginStore((s) => s.setFolderFileCountMap);
    const excludedExtensions = usePluginStore((s) => s.excludedExtensions);
    const setExcludedExtensions = usePluginStore((s) => s.setExcludedExtensions);
    const showSubFolders = usePluginStore((s) => s.showSubFolders);
    const setShowSubFolders = usePluginStore((s) => s.setShowSubFolders);
    const focusedFolder = usePluginStore((s) => s.focusedFolder);
    const setFocusedFolder = usePluginStore((s) => s.setFocusedFolder);
    const activeOZFile = usePluginStore((s) => s.activeOZFile);
    const setActiveOzFile = usePluginStore((s) => s.setActiveOZFile);

    // Ref to gate scroll-to-file: only true when user explicitly reveals a file
    const needsScrollRef = useRef(false);

    const setNewFileList = (folderPath?: string) => {
        let filesPath = folderPath ? folderPath : activeFolderPath;
        setOzFileList(
            FileTreeUtils.getFilesUnderPath({
                path: filesPath,
                plugin: plugin,
                excludedExtensions: excludedExtensions,
                excludedFolders: excludedFolders,
            })
        );
    };

    const setInitialActiveFolderPath = () => {
        if (['Horizontal', 'Vertical'].includes(plugin.settings.evernoteView)) {
            let previousActiveFolder = localStorage.getItem(plugin.keys.activeFolderPathKey);
            if (previousActiveFolder) {
                const folder = plugin.app.vault.getFolderByPath(previousActiveFolder);
                if (folder) {
                    setActiveFolderPath(folder.path);
                }
            }
        }
    };

    // --> Subscribe to plugin-internal event bus (replaces window.dispatchEvent pattern)
    useEffect(() => {
        const unsubVaultChange = eventBus.on(eventTypes.vaultChange, vaultChangeEvent);
        const unsubActiveFile = eventBus.on(eventTypes.activeFileChange, changeActiveFile);
        const unsubRefresh = eventBus.on(eventTypes.refreshView, handleRefreshView);
        const unsubRevealFile = eventBus.on(eventTypes.revealFile, handleRevealFileEvent);
        const unsubRevealFolder = eventBus.on(eventTypes.revealFolder, handleRevealFolderEvent);
        const unsubCreateNote = eventBus.on(eventTypes.createNewNote, handleCreateNewNoteEvent);
        return () => {
            unsubVaultChange();
            unsubActiveFile();
            unsubRefresh();
            unsubRevealFile();
            unsubRevealFolder();
            unsubCreateNote();
        };
    }, []);

    const handleCreateNewNoteEvent = () => {
        let currentActiveFolderPath = usePluginStore.getState().activeFolderPath || '/';
        FileTreeUtils.createNewFile(null, currentActiveFolderPath, plugin);
    };

    // Rebuild folder counts on view refresh so badges stay in sync with filter settings
    const handleRefreshView = () => {
        if (plugin.settings.folderCount) setFolderFileCountMap(FileTreeUtils.getFolderNoteCountMap(plugin));
        forceUpdate();
    };

    const vaultChangeEvent = (detail: { file: TFile; changeType: VaultChange; oldPath: string }) => {
        handleVaultChanges(detail.file, detail.changeType, detail.oldPath);
    };

    // --> Debounced 'modify' list patching.
    // Typing fires a vault modify event roughly every 2s; each event used to rebuild the
    // whole file list synchronously. Instead, accumulate the changed paths in a Set and
    // patch the list once per quiet second through the shared FileTreeUtils.debounce helper.
    const pendingModifiedPathsRef = useRef<Set<string>>(new Set());
    const flushModifiedFiles = useMemo(
        () =>
            FileTreeUtils.debounce(() => {
                const pending = pendingModifiedPathsRef.current;
                if (pending.size === 0) return;
                // Resolve each pending path against the vault NOW — skip paths that were
                // renamed/deleted while pending, and never patch from a stale captured TFile
                const resolved: OZFile[] = [];
                for (const path of pending) {
                    const tFile = plugin.app.vault.getFileByPath(path);
                    if (tFile) resolved.push(FileTreeUtils.TFile2OZFile(tFile));
                }
                pending.clear();
                if (resolved.length === 0) return;
                // Patch the CURRENT list in place (order preserved; the existing sortedFiles
                // memo re-sorts because the array identity changes)
                const currentFileList = usePluginStore.getState().ozFileList;
                const indexByPath = new Map(currentFileList.map((f, i) => [f.path, i] as const));
                let changed = false;
                const next = [...currentFileList];
                for (const ozFile of resolved) {
                    const idx = indexByPath.get(ozFile.path);
                    if (idx === undefined) continue; // exists in vault but not listed — nothing to patch
                    next[idx] = ozFile;
                    changed = true;
                }
                if (changed) usePluginStore.getState().setOzFileList(next);
            }, 1000),
        [plugin]
    );
    // Cancel pending patch on unmount — the list is rebuilt from scratch on mount anyway
    useEffect(() => () => flushModifiedFiles.cancel(), [flushModifiedFiles]);

    const changeActiveFile = (detail: { filePath: string }) => {
        let filePath: string = detail.filePath;
        const file = plugin.app.vault.getFileByPath(filePath);
        if (file) setActiveOzFile(FileTreeUtils.TFile2OZFile(file));
    };

    // Initial Load
    useEffect(() => {
        setInitialFocusedFolder();
        setExcludedFolders(getExcludedFolders());
        setExcludedExtensions(getExcludedExtensions());
        setOzPinnedFiles(getPinnedFilesFromSettings());
        setOpenFolders(getOpenFoldersFromSettings());
        setShowSubFolders(plugin.settings.showFilesFromSubFolders);
        setInitialActiveFolderPath();
        if (plugin.settings.folderCount) setFolderFileCountMap(FileTreeUtils.getFolderNoteCountMap(plugin));
    }, []);

    // Each Focused Folder Change triggers new folder tree build
    useEffect(() => {
        if (focusedFolder) {
            setFolderTree(
                FileTreeUtils.createFolderTree({
                    startFolder: focusedFolder,
                    plugin: plugin,
                    excludedFolders: excludedFolders,
                })
            );
            localStorage.setItem(plugin.keys.focusedFolder, focusedFolder.path);
        }
    }, [focusedFolder, excludedFolders]);

    // Rebuild folder count map when exclusion filters change so badges match listings
    useEffect(() => {
        if (plugin.settings.folderCount) setFolderFileCountMap(FileTreeUtils.getFolderNoteCountMap(plugin));
    }, [excludedExtensions, excludedFolders]);

    const setInitialFocusedFolder = () => {
        let localFocusedFolder = localStorage.getItem(plugin.keys.focusedFolder);
        if (localFocusedFolder) {
            const folder = plugin.app.vault.getFolderByPath(localFocusedFolder);
            if (folder) {
                setFocusedFolder(folder);
                return;
            }
        }
        setFocusedFolder(plugin.app.vault.getRoot());
    };

    // State Change Handlers
    useEffect(() => savePinnedFilesToSettings(), [ozPinnedFiles]);
    useEffect(() => saveOpenFoldersToSettings(), [openFolders]);
    useEffect(() => saveExcludedFoldersToSettings(), [excludedFolders]);

    // If activeFolderPath is set, it means it should go to 'file' view
    useEffect(() => {
        if (activeFolderPath !== '') {
            setNewFileList(activeFolderPath);
            setView('file');
        }
        localStorage.setItem(plugin.keys.activeFolderPathKey, activeFolderPath);
    }, [activeFolderPath, excludedExtensions, excludedFolders, showSubFolders]);

    // Load Excluded Extensions as State
    function getExcludedExtensions(): string[] {
        let extensionsString: string = plugin.settings.excludedExtensions;
        let excludedExtensions: string[] = [];
        for (let extension of extensionsString.split(',')) {
            excludedExtensions.push(extension.trim());
        }
        return excludedExtensions;
    }

    // Load Excluded Folders
    function getExcludedFolders(): string[] {
        let excludedString: string = plugin.settings.excludedFolders;
        let excludedFolders: string[] = [];
        if (excludedString) {
            for (let excludedFolder of excludedString.split(',')) {
                if (excludedFolder !== '') excludedFolders.push(excludedFolder.trim());
            }
        }
        return excludedFolders;
    }

    // Load The String List and Set Open Folders State
    function getOpenFoldersFromSettings(): string[] {
        let openFolders: string[] = [];
        let localStorageOpenFolders = localStorage.getItem(plugin.keys.openFoldersKey);
        if (localStorageOpenFolders) {
            localStorageOpenFolders = JSON.parse(localStorageOpenFolders);
            for (let folder of localStorageOpenFolders) {
                const openFolder = plugin.app.vault.getFolderByPath(folder);
                if (openFolder) openFolders.push(openFolder.path);
            }
        }
        return openFolders;
    }

    // Load The String List anad Set Pinned Files State
    function getPinnedFilesFromSettings(): OZFile[] {
        let pinnedFiles: OZFile[] = [];
        let localStoragePinnedFiles = localStorage.getItem(plugin.keys.pinnedFilesKey);
        if (localStoragePinnedFiles) {
            localStoragePinnedFiles = JSON.parse(localStoragePinnedFiles);
            for (let file of localStoragePinnedFiles) {
                const pinnedFile = plugin.app.vault.getFileByPath(file);
                if (pinnedFile) pinnedFiles.push(FileTreeUtils.TFile2OZFile(pinnedFile));
            }
        }
        return pinnedFiles;
    }

    // Get The Folders State and Save in Data as String Array
    function saveOpenFoldersToSettings() {
        let openFoldersToSave: string[] = [];
        for (let folder of openFolders) {
            openFoldersToSave.push(folder);
        }
        localStorage.setItem(plugin.keys.openFoldersKey, JSON.stringify(openFoldersToSave));
    }

    // Get The Pinned Files State and Save in Data as String Array
    function savePinnedFilesToSettings() {
        let pinnedFilesToSave: string[] = [];
        for (let file of ozPinnedFiles) {
            pinnedFilesToSave.push(file.path);
        }
        localStorage.setItem(plugin.keys.pinnedFilesKey, JSON.stringify(pinnedFilesToSave));
    }

    // Save Excluded Folders to Settings as String
    function saveExcludedFoldersToSettings() {
        plugin.settings.excludedFolders = excludedFolders.length > 1 ? excludedFolders.join(', ') : excludedFolders[0];
        plugin.debouncedSaveSettings();
    }

    // Function for Event Handlers
    function handleVaultChanges(file: TAbstractFile, changeType: VaultChange, oldPathBeforeRename?: string) {
        // Get Current States via Zustand
        let currentActiveFolderPath: string = usePluginStore.getState().activeFolderPath;

        // File Event Handlers
        if (file instanceof TFile) {
            // Update Pinned Files
            if (['rename', 'delete'].includes(changeType)) {
                let currentOzPinnedFiles: OZFile[] = usePluginStore.getState().ozPinnedFileList;
                const filteredPinnedFiles: OZFile[] = currentOzPinnedFiles.filter(
                    (f) => f.path !== (changeType === 'rename' ? oldPathBeforeRename : file.path)
                );
                if (filteredPinnedFiles.length !== currentOzPinnedFiles.length) {
                    setOzPinnedFiles([...filteredPinnedFiles, ...(changeType === 'rename' ? [FileTreeUtils.TFile2OZFile(file)] : [])]);
                }
            }
            // Update current View
            let currentView: string = usePluginStore.getState().view;
            if (currentView === 'file') {
                let currentFileList: OZFile[] = usePluginStore.getState().ozFileList;
                // Evaluate changes
                if (changeType === 'rename' || changeType === 'modify' || changeType === 'delete') {
                    // If the file is modified but sorting is not last-update to not component update unnecessarily, return
                    let sortFilesBy = plugin.settings.sortFilesBy;
                    if (changeType === 'modify') {
                        let sortFoldersBy = plugin.settings.sortFoldersBy;
                        if (!(sortFilesBy === 'last-update' || sortFilesBy === 'file-size' || sortFoldersBy === 'last-update')) {
                            return;
                        }
                    }
                    // If the file renamed or deleted or modified is in the current view, it will be updated
                    let parentFolderPath = file.path.substring(0, file.path.lastIndexOf('/'));
                    let fileInCurrentView = currentFileList.some((f) => {
                        return changeType === 'rename' ? f.path === oldPathBeforeRename : f.path === file.path;
                    });
                    let fileInCurrentFolder =
                        currentActiveFolderPath === parentFolderPath ||
                        (plugin.settings.showFilesFromSubFolders && parentFolderPath.startsWith(currentActiveFolderPath));
                    if (fileInCurrentView) {
                        if (changeType === 'delete') {
                            setOzFileList(
                                currentFileList.filter((f) => {
                                    return f.path !== file.path;
                                })
                            );
                        } else if (changeType === 'rename') {
                            // Rename stays synchronous — the active-file fixup below must run now
                            // Fix for Root Folder Path
                            if (currentActiveFolderPath === '/') currentActiveFolderPath = '';
                            // Set the file list
                            setOzFileList([
                                ...currentFileList.filter((f) => {
                                    return f.path !== oldPathBeforeRename;
                                }),
                                // Include any file that roles up to the current active folder, not only the direct ones
                                ...(file.parent.path.startsWith(currentActiveFolderPath) ? [FileTreeUtils.TFile2OZFile(file)] : []),
                            ]);
                            // If active file is renamed, change the active file
                            let currentActiveOZFile: OZFile | null = usePluginStore.getState().activeOZFile;
                            if (currentActiveOZFile && currentActiveOZFile.path === oldPathBeforeRename) {
                                setActiveOzFile(FileTreeUtils.TFile2OZFile(file));
                            }
                        } else if (changeType === 'modify' && (sortFilesBy === 'last-update' || sortFilesBy === 'file-size')) {
                            // Modify is debounced: queue the path, patch the list after a quiet second
                            pendingModifiedPathsRef.current.add(file.path);
                            flushModifiedFiles();
                        }
                    }
                    // File is no in current view but parent folder is and should be included
                    else if (fileInCurrentFolder && !fileInCurrentView) {
                        setOzFileList([...currentFileList, FileTreeUtils.TFile2OZFile(file)]);
                    }
                } else if (changeType === 'create') {
                    // Use startsWith instead of regex — faster and avoids regex-special-char bugs in folder names
                    let fileIsCreatedUnderActiveFolder =
                        currentActiveFolderPath === '/' || file.path.startsWith(currentActiveFolderPath + '/');
                    if (fileIsCreatedUnderActiveFolder) {
                        // If file is not already in the list, add into view
                        if (!currentFileList.some((f) => f.path === file.path)) {
                            setOzFileList([...currentFileList, FileTreeUtils.TFile2OZFile(file)]);
                        }
                    }
                }
            }
        }

        // Folder Event Handlers
        else if (file instanceof TFolder) {
            let currentFocusedFolder: TFolder | null = usePluginStore.getState().focusedFolder;
            setFolderTree(FileTreeUtils.createFolderTree({ startFolder: currentFocusedFolder, plugin: plugin, excludedFolders: excludedFolders }));
            // if active folder is renamed, activefolderpath needs to be refreshed
            if (changeType === 'rename' && oldPathBeforeRename && currentActiveFolderPath === oldPathBeforeRename) {
                setActiveFolderPath(file.path);
            }
        }

        // Update folder counts incrementally (avoids O(n) full rebuild on every event)
        if (plugin.settings.folderCount && changeType !== 'modify') {
            if (changeType === 'rename' || file instanceof TFolder) {
                // Full rebuild for renames (file path changes) and folder events
                setFolderFileCountMap(FileTreeUtils.getFolderNoteCountMap(plugin));
            } else if (file instanceof TFile) {
                // Incremental: +1 for create, -1 for delete
                const delta = changeType === 'create' ? 1 : -1;
                const currentMap = usePluginStore.getState().folderFileCountMap;
                // Use the same filters as the listing so badges match what clicking a folder shows
                const storeState = usePluginStore.getState();
                setFolderFileCountMap(
                    FileTreeUtils.incrementFolderCountMap(
                        { ...currentMap },
                        file,
                        delta,
                        {
                            excludedExtensions: storeState.excludedExtensions ?? [],
                            excludedFolders: storeState.excludedFolders ?? [],
                            hideAttachments: plugin.settings.hideAttachments,
                            attachmentsFolderName: plugin.settings.attachmentsFolderName,
                            folderCountOption: plugin.settings.folderCountOption,
                            excludeFolderNotes: plugin.settings.folderNote,
                        }
                    )
                );
            }
        }
    }

    // ******** REVEAL ACTIVE FILE FUNCTIONS ******** //
    // --> During file list change, scroll only when a user explicitly revealed a file
    useEffect(() => {
        if (needsScrollRef.current && activeOZFile && ozFileList.length > 0) {
            scrollToFile(activeOZFile);
            needsScrollRef.current = false;
        }
    }, [ozFileList]);

    // Custom Event Handler Function
    async function handleRevealFileEvent(detail: { file: TFile }) {
        const file: TFile = detail.file;
        if (file && file instanceof TFile) {
            await plugin.openFileTreeLeaf(true);
            revealFileInFileTree(FileTreeUtils.TFile2OZFile(file));
        } else {
            new Notice('File not found');
        }
    }

    function handleRevealFolderEvent(detail: { folder: TFolder }) {
        const folder: TFolder = detail.folder;
        if (folder && folder instanceof TFolder) {
            revealFolderInFileTree(folder);
        } else {
            new Notice('Folder not found');
        }
    }

    // Scrolling Functions
    function scrollToFile(fileToScroll: OZFile) {
        // The virtualized list scrolls by index (rows outside the window are not in the
        // DOM); fall back to the legacy DOM query when no virtual list is mounted.
        if (scrollVirtualFileListToFile(fileToScroll.path)) return;
        const selector = `div.oz-file-tree-files div.oz-nav-file-title[data-path="${fileToScroll.path}"]`;
        const fileTitleElement = document.querySelector(selector);
        if (fileTitleElement) fileTitleElement.scrollIntoView(false);
    }

    function scrollToFolder(folder: TFolder) {
        const selector = `div.oz-folder-contents div.oz-folder-element[data-path="${folder.path}"]`;
        const folderElement = document.querySelector(selector);
        if (folderElement) folderElement.scrollIntoView(false);
    }

    // Helper for Reveal Button: Obtain all folders that needs to be opened
    const getAllFoldersToOpen = (fileToReveal: TFile | TFolder) => {
        let foldersToOpen: string[] = [];
        const recursiveFx = (folder: TFolder) => {
            foldersToOpen.push(folder.path);
            if (folder.parent) recursiveFx(folder.parent);
        };
        recursiveFx(fileToReveal instanceof TFile ? fileToReveal.parent : fileToReveal);
        return foldersToOpen;
    };

    // --> Handle Reveal Folder Button
    function revealFolderInFileTree(folderToReveal: TFolder) {
        if (!folderToReveal) return;
        setActiveFolderPath(folderToReveal.path);
        const foldersToOpen = getAllFoldersToOpen(folderToReveal);
        let openFoldersSet = new Set([...openFolders, ...foldersToOpen]);
        setOpenFolders(Array.from(openFoldersSet));
        scrollToFolder(folderToReveal);
    }

    // --> Handle Reveal Active File Button
    function revealFileInFileTree(ozFileToReveal: OZFile) {
        const fileToReveal = plugin.app.vault.getFileByPath(ozFileToReveal.path);
        if (!fileToReveal) return;

        // Get parent folder
        const parentFolder = fileToReveal.parent;

        // Focused Folder needs to be root for the reveal
        if (focusedFolder && focusedFolder.path !== '/') setFocusedFolder(plugin.app.vault.getRoot());

        // Sanity check - Parent to be folder and set required component states
        if (parentFolder instanceof TFolder) {
            // Set Active Folder - It will trigger auto file list update
            setActiveFolderPath(parentFolder.path);

            // Set active file to show in the list
            setActiveOzFile(FileTreeUtils.TFile2OZFile(fileToReveal));

            // Set openfolders to expand in the folder list
            const foldersToOpen = getAllFoldersToOpen(fileToReveal);
            let openFoldersSet = new Set([...openFolders, ...foldersToOpen]);
            setOpenFolders(Array.from(openFoldersSet));

            // Flag that active scroll is needed — prevents layout thrashing on routine updates
            needsScrollRef.current = true;

            scrollToFile(FileTreeUtils.TFile2OZFile(fileToReveal));
            scrollToFolder(parentFolder);
        }
    }

    return (
        <React.Fragment>
            {view === 'folder' ? (
                <MainFolder plugin={plugin} />
            ) : plugin.settings.evernoteView === 'Horizontal' ? (
                <SingleViewHorizontal plugin={plugin} />
            ) : plugin.settings.evernoteView === 'Vertical' ? (
                <SingleViewVertical plugin={plugin} />
            ) : (
                <FileComponent plugin={plugin} />
            )}
        </React.Fragment>
    );
}
