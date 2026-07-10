import { TFolder } from 'obsidian';
import { create } from 'zustand';
import { FolderTree, FolderFileCountMap, OZFile } from 'utils/types';

export interface PluginStoreState {
    view: string;
    activeFolderPath: string;
    activeOZFile: OZFile | null;
    excludedFolders: string[];
    excludedExtensions: string[];
    folderFileCountMap: FolderFileCountMap;
    folderTree: FolderTree | null;
    ozFileList: OZFile[];
    ozPinnedFileList: OZFile[];
    openFolders: string[];
    showSubFolders: boolean;
    focusedFolder: TFolder | null;
    recentModifiedFolders: Map<string, number>;
    recentFolderDepth: Map<string, number>;
    recentFolderMtimes: Map<string, number>;
    recentFolderTrailIndex: Map<string, number>;
}

interface PluginStoreActions {
    setView: (view: string) => void;
    setActiveFolderPath: (path: string) => void;
    setActiveOZFile: (file: OZFile | null) => void;
    setExcludedFolders: (folders: string[]) => void;
    setExcludedExtensions: (extensions: string[]) => void;
    setFolderFileCountMap: (map: FolderFileCountMap) => void;
    setFolderTree: (tree: FolderTree | null) => void;
    setOzFileList: (list: OZFile[]) => void;
    setOzPinnedFileList: (list: OZFile[]) => void;
    setOpenFolders: (folders: string[]) => void;
    setShowSubFolders: (show: boolean) => void;
    setFocusedFolder: (folder: TFolder | null) => void;
    setRecentModifiedFolders: (folders: Map<string, number>) => void;
    setRecentFolderDepth: (depth: Map<string, number>) => void;
    setRecentFolderMtimes: (mtimes: Map<string, number>) => void;
    setRecentFolderTrailIndex: (index: Map<string, number>) => void;
}

export type PluginStore = PluginStoreState & PluginStoreActions;

export const usePluginStore = create<PluginStore>()((set) => ({
    // State
    view: 'folder',
    activeFolderPath: '',
    activeOZFile: null,
    excludedFolders: [] as string[],
    excludedExtensions: [] as string[],
    folderFileCountMap: {} as FolderFileCountMap,
    folderTree: null as FolderTree | null,
    ozFileList: [] as OZFile[],
    ozPinnedFileList: [] as OZFile[],
    openFolders: [] as string[],
    showSubFolders: false,
    focusedFolder: null as TFolder | null,
    recentModifiedFolders: new Map<string, number>(),
    recentFolderDepth: new Map<string, number>(),
    recentFolderMtimes: new Map<string, number>(),
    recentFolderTrailIndex: new Map<string, number>(),

    // Actions
    setView: (view) => set({ view }),
    setActiveFolderPath: (activeFolderPath) => set({ activeFolderPath }),
    setActiveOZFile: (activeOZFile) => set({ activeOZFile }),
    setExcludedFolders: (excludedFolders) => set({ excludedFolders }),
    setExcludedExtensions: (excludedExtensions) => set({ excludedExtensions }),
    setFolderFileCountMap: (folderFileCountMap) => set({ folderFileCountMap }),
    setFolderTree: (folderTree) => set({ folderTree }),
    setOzFileList: (ozFileList) => set({ ozFileList }),
    setOzPinnedFileList: (ozPinnedFileList) => set({ ozPinnedFileList }),
    setOpenFolders: (openFolders) => set({ openFolders }),
    setShowSubFolders: (showSubFolders) => set({ showSubFolders }),
    setFocusedFolder: (focusedFolder) => set({ focusedFolder }),
    setRecentModifiedFolders: (recentModifiedFolders) => set({ recentModifiedFolders }),
    setRecentFolderDepth: (recentFolderDepth) => set({ recentFolderDepth }),
    setRecentFolderMtimes: (recentFolderMtimes) => set({ recentFolderMtimes }),
    setRecentFolderTrailIndex: (recentFolderTrailIndex) => set({ recentFolderTrailIndex }),
}));
