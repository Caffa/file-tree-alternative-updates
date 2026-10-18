import React, { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from 'react';
import * as Icons from 'utils/icons';
import FileTreeAlternativePlugin from 'main';
import { OZFile } from 'utils/types';
import * as Util from 'utils/Utils';
import { usePluginStore } from '../../recoil/pluginStore';
import useForceUpdate from 'hooks/ForceUpdate';
import useLongPress from 'hooks/useLongPress';
import * as FileViewHandlers from 'components/FileView/handlers';
import { TFolder } from 'obsidian';
import { useVirtualizer } from '@tanstack/react-virtual';
import { registerVirtualFileScroller, unregisterVirtualFileScroller } from 'utils/virtualListBridge';

// Row height before a row is measured (styles.css: 19px line-height + title
// padding/borders + 1px row border-bottom). Rows are measured dynamically, so
// this only shapes the first paint and the estimate for not-yet-measured rows.
// Both constants come from the single mobile-tuning gate — desktop values
// unchanged (23 / 5); mobile rows measure ~25px and get a smaller overscan.
const ROW_HEIGHT_ESTIMATE = Util.MOBILE_TUNING.rowHeightEstimate;
const ROW_OVERSCAN = Util.MOBILE_TUNING.rowOverscan;

// Insert into a descending-mtime array, keeping equal-mtime items in their original (stable) order.
// The mtime is passed in (already normalized with `?? 0`) so missing stats behave exactly
// like the full-sort implementation this replaces.
function insertIntoTopK(arr: OZFile[], file: OZFile, mtime: number) {
    let i = arr.length;
    while (i > 0 && (arr[i - 1].stat?.mtime ?? 0) < mtime) {
        i--;
    }
    arr.splice(i, 0, file);
}

interface FilesProps {
    plugin: FileTreeAlternativePlugin;
}

interface SubfolderIndicatorInfo {
    visible: boolean;
    colorIndexByPath?: Map<string, number>;
}

export function FileComponent(props: FilesProps) {
    let searchInput = React.useRef<HTMLInputElement>(null);
    const plugin = props.plugin;

    // States Coming From Main Component (Zustand)
    const setView = usePluginStore((s) => s.setView);
    const ozFileList = usePluginStore((s) => s.ozFileList);
    const setOzFileList = usePluginStore((s) => s.setOzFileList);
    const ozPinnedFiles = usePluginStore((s) => s.ozPinnedFileList);
    const activeFolderPath = usePluginStore((s) => s.activeFolderPath);
    const setActiveFolderPath = usePluginStore((s) => s.setActiveFolderPath);
    const excludedExtensions = usePluginStore((s) => s.excludedExtensions);
    const excludedFolders = usePluginStore((s) => s.excludedFolders);
    const showSubFolders = usePluginStore((s) => s.showSubFolders);
    const setShowSubFolders = usePluginStore((s) => s.setShowSubFolders);
    const focusedFolder = usePluginStore((s) => s.focusedFolder);

    // Local States
    const [highlight, setHighlight] = useState<boolean>(false);
    const [searchPhrase, setSearchPhrase] = useState<string>('');
    const [searchBoxVisible, setSearchBoxVisible] = useState<boolean>(false);
    const [treeHeader, setTreeHeader] = useState<string>(Util.getFolderName(activeFolderPath, plugin.app));

    // Force Update
    const forceUpdate = useForceUpdate();

    // Folder Name Update once Active Folder Path Change
    useEffect(() => setTreeHeader(Util.getFolderName(activeFolderPath, plugin.app)), [activeFolderPath]);

    // Jump Panel: clickable breadcrumb path for navigating folders
    const breadcrumbSegments = useMemo(
        () => (plugin.settings.overrideFolderClick ? Util.getBreadcrumbSegments(activeFolderPath, plugin.app) : null),
        [activeFolderPath, plugin.settings.overrideFolderClick]
    );

    // To focus on Search box if visible set
    useEffect(() => {
        if (searchBoxVisible) searchInput.current.focus();
    }, [searchBoxVisible]);

    // --- Debounced Search ---
    // Mutable ref holding latest search params (avoids stale closures in debounced callback)
    const searchParamsRef = useRef({
        activeFolderPath,
        setSearchPhrase,
        setTreeHeader,
        setOzFileList,
        excludedExtensions,
        excludedFolders,
        plugin,
        focusedFolder: focusedFolder as TFolder | null,
    });
    searchParamsRef.current = {
        activeFolderPath,
        setSearchPhrase,
        setTreeHeader,
        setOzFileList,
        excludedExtensions,
        excludedFolders,
        plugin,
        focusedFolder,
    };

    // Stable debounced search — fires 300ms after the user stops typing
    const debouncedSearch = useMemo(
        () =>
            Util.debounce((value: string) => {
                const p = searchParamsRef.current;
                // Only call handleSearch if there's a focusedFolder — guard against null
                if (!p.focusedFolder) return;
                FileViewHandlers.handleSearch({
                    e: { target: { value } } as React.ChangeEvent<HTMLInputElement>,
                    activeFolderPath: p.activeFolderPath,
                    setSearchPhrase: p.setSearchPhrase,
                    setTreeHeader: p.setTreeHeader,
                    setOzFileList: p.setOzFileList,
                    excludedExtensions: p.excludedExtensions,
                    excludedFolders: p.excludedFolders,
                    plugin: p.plugin,
                    focusedFolder: p.focusedFolder,
                });
            }, 300),
        []
    );

    // Cancel pending debounce on unmount
    useEffect(() => () => debouncedSearch.cancel(), [debouncedSearch]);

    // One Set per list render instead of a store subscription per row: NavFile receives
    // `isPinned` as a plain prop, so only the rows whose pin state changed re-render.
    const ozPinnedPaths = useMemo(() => new Set(ozPinnedFiles.map((f) => f.path)), [ozPinnedFiles]);

    const filesToList: OZFile[] = useMemo(
        () =>
            FileViewHandlers.sortedFiles({
                fileList: ozFileList,
                plugin: plugin,
                ozPinnedFiles: ozPinnedFiles,
            }),
        [excludedFolders, excludedExtensions, ozPinnedFiles, ozFileList, plugin.settings.sortFilesBy, plugin.settings.sortReverse]
    );

    // Compute recency ranks: map file path → rank (0 = most recent, undefined = not highlighted)
    const recentFileRanks = useMemo(() => {
        const ranks = new Map<string, number>();
        if (!plugin.settings.highlightRecentFiles) return ranks;
        const count = plugin.settings.recentFilesCount;
        if (!count || count <= 0) return ranks;
        // O(n) top-K pass, preserving the same tie ordering as the previous stable full sort
        const topK: OZFile[] = [];
        for (const file of ozFileList) {
            const mtime = file.stat?.mtime ?? 0;
            if (topK.length < count) {
                insertIntoTopK(topK, file, mtime);
            } else if (mtime > (topK[count - 1].stat?.mtime ?? 0)) {
                insertIntoTopK(topK, file, mtime);
                topK.pop();
            }
        }
        for (let i = 0; i < topK.length; i++) {
            ranks.set(topK[i].path, i);
        }
        return ranks;
    }, [ozFileList, plugin.settings.highlightRecentFiles, plugin.settings.recentFilesCount]);

    // Compute subfolder indicator map for files shown from subfolders.
    // Only visible when style is not 'off' and files from ≥2 distinct subfolders are displayed.
    const subfolderIndicatorInfo = useMemo(() => {
        if (plugin.settings.subfolderIndicatorStyle === 'off') return { visible: false } as SubfolderIndicatorInfo;
        const subfolders = new Set<string>();
        for (const file of filesToList) {
            if (file.parent.path !== activeFolderPath) {
                subfolders.add(file.parent.path);
            }
        }
        if (subfolders.size < 2) return { visible: false } as SubfolderIndicatorInfo;
        const sorted = Array.from(subfolders).sort();
        const colorIndexByPath = new Map<string, number>();
        sorted.forEach((path, index) => {
            colorIndexByPath.set(path, index % 6);
        });
        return { visible: true, colorIndexByPath } as SubfolderIndicatorInfo;
    }, [filesToList, activeFolderPath, plugin.settings.subfolderIndicatorStyle]);

    // --- Virtualization ---
    // The scroll container is the pane around this component (Vertical/Horizontal
    // single view wrap FileComponent in .oz-file-list-pane*); the classic (Disabled)
    // view falls back to Obsidian's view content.
    const fileListRef = useRef<HTMLDivElement>(null);
    const fileListInnerRef = useRef<HTMLDivElement>(null);
    const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);

    useLayoutEffect(() => {
        setScrollElement(
            fileListRef.current?.closest<HTMLElement>('.oz-file-list-pane, .oz-file-list-pane-horizontal') ??
                fileListRef.current?.closest<HTMLElement>('.view-content') ??
                null
        );
    }, []);

    // Distance between the scroll container's content start and the first row (the
    // header + padding above the list). Keeps the virtual window aligned with what is
    // actually on screen — including with the sticky fixed header or the search box.
    // TanStack includes scrollMargin in virtualRow.start but excludes it from
    // getTotalSize(), so row transforms must subtract it (scrollMargin contract).
    const measureScrollMargin = useCallback(() => {
        const inner = fileListInnerRef.current;
        if (!inner || !scrollElement) return;
        setScrollMargin(inner.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop);
    }, [scrollElement]);

    useLayoutEffect(() => {
        measureScrollMargin();
    }, [scrollElement, searchBoxVisible, measureScrollMargin]);

    // The margin is defined by the header wrapper's height — re-measure when that
    // height changes after mount (font/theme changes, width re-wrap on divider drag),
    // otherwise the scrollMargin goes stale and the virtual window drifts.
    useEffect(() => {
        const header = fileListRef.current?.previousElementSibling;
        if (!header || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => measureScrollMargin());
        observer.observe(header);
        return () => observer.disconnect();
    }, [measureScrollMargin]);

    const virtualizer = useVirtualizer({
        count: filesToList.length,
        getScrollElement: () => scrollElement,
        estimateSize: () => ROW_HEIGHT_ESTIMATE,
        overscan: ROW_OVERSCAN,
        getItemKey: (index) => filesToList[index].path,
        scrollMargin,
    });

    // O(1) path → row index for the reveal/scroll wiring (rebuilt with the list, cheap O(n))
    const listIndexByPath = useMemo(() => {
        const map = new Map<string, number>();
        for (let i = 0; i < filesToList.length; i++) map.set(filesToList[i].path, i);
        return map;
    }, [filesToList]);

    // Reveal bridge: MainComponent asks this list to scroll to a path. Rows outside the
    // virtual window don't exist in the DOM, so the old querySelector scroll can miss
    // them — the virtualizer scrolls to unmounted rows by index instead. Reads go
    // through a ref so the registered callback never closes over stale list state.
    const revealStateRef = useRef({ listIndexByPath, virtualizer });
    revealStateRef.current = { listIndexByPath, virtualizer };
    useEffect(() => {
        const scrollerId = registerVirtualFileScroller((path) => {
            const { listIndexByPath: indexByPath, virtualizer: v } = revealStateRef.current;
            const index = indexByPath.get(path);
            if (index === undefined) return false;
            v.scrollToIndex(index, { align: 'center' });
            return true;
        });
        // Reference-counted: a second file-tree leaf's unmount must not kill the
        // bridge for this leaf (see virtualListBridge)
        return () => unregisterVirtualFileScroller(scrollerId);
    }, []);

    // Go Back Button - Sets Main Component View to Folder
    const handleGoBack = (e: React.MouseEvent) => {
        setView('folder');
        setActiveFolderPath('');
    };

    // Toggle Search Box Visibility State
    const toggleSearchBox = () => {
        setSearchPhrase('');
        setSearchBoxVisible(!searchBoxVisible);
        // C2: this list write must not be clobbered by an in-flight chunked build
        Util.cancelChunkedFileListBuild();
        setOzFileList(
            Util.getFilesUnderPath({
                path: activeFolderPath,
                plugin: plugin,
                excludedExtensions: excludedExtensions,
                excludedFolders: excludedFolders,
            })
        );
    };

    const toggleShowSubFolders = () => {
        plugin.settings.showFilesFromSubFolders = !showSubFolders;
        plugin.debouncedSaveSettings();
        setShowSubFolders(!showSubFolders);
    };

    const topIconSize = 19;

    // Drag counter for native dragEnter/dragLeave coordination (avoids flicker from child elements)
    const dragCounter = useRef(0);

    const handleDragEnter = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current++;
        setHighlight(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current--;
        if (dragCounter.current === 0) {
            setHighlight(false);
        }
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter.current = 0;
            setHighlight(false);
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length > 0) {
                FileViewHandlers.handleOnDropFiles({
                    files,
                    activeFolderPath,
                    plugin,
                });
            }
        },
        [activeFolderPath, plugin]
    );

    return (
        <React.Fragment>
            <div
                className={highlight ? 'drag-entered' : ''}
                style={{ width: '100%', height: '100%', position: 'relative' }}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}>
                <div className="oz-explorer-container">
                    {/* Header */}
                    <div className={`oz-file-tree-header-wrapper${plugin.settings.fixedHeaderInFileList ? ' file-tree-header-fixed' : ''}`}>
                        <div className="oz-flex-container">
                            <div className="oz-nav-action-button" style={{ marginLeft: '0px' }}>
                                {['Horizontal', 'Vertical'].includes(plugin.settings.evernoteView) ? (
                                    <Icons.IoIosCloseCircleOutline
                                        onClick={(e) => handleGoBack(e)}
                                        size={topIconSize}
                                        aria-label="Close File Pane"
                                    />
                                ) : (
                                    <Icons.IoIosArrowBack
                                        onClick={(e) => handleGoBack(e)}
                                        size={topIconSize}
                                        aria-label="Go Back to Folder View"
                                    />
                                )}
                            </div>
                            <div className="oz-nav-buttons-right-block">
                                {plugin.settings.revealActiveFileButton && (
                                    <div className="oz-nav-action-button">
                                        <Icons.BiCurrentLocation
                                            onClick={() => FileViewHandlers.handleRevealActiveFileButton({ plugin })}
                                            size={topIconSize}
                                            aria-label="Reveal Active File"
                                        />
                                    </div>
                                )}
                                {plugin.settings.showFilesFromSubFoldersButton && (
                                    <div className="oz-nav-action-button">
                                        {showSubFolders ? (
                                            <Icons.IoIosEyeOff
                                                onClick={toggleShowSubFolders}
                                                size={topIconSize}
                                                aria-label="Hide Files from Sub-Folders"
                                            />
                                        ) : (
                                            <Icons.IoIosEye
                                                onClick={toggleShowSubFolders}
                                                size={topIconSize}
                                                aria-label="Show Files from Sub-Folders"
                                            />
                                        )}
                                    </div>
                                )}
                                {plugin.settings.searchFunction && (
                                    <div className="oz-nav-action-button">
                                        <Icons.IoIosSearch onClick={toggleSearchBox} size={topIconSize} aria-label="Search File by Name or Tag" />
                                    </div>
                                )}
                                <div className="oz-nav-action-button">
                                    <Icons.CgSortAz
                                        size={topIconSize + 2}
                                        onClick={(e) => {
                                            FileViewHandlers.sortFileListClickHandle({ e, plugin, forceUpdate });
                                        }}
                                        aria-label="Sorting Options"
                                    />
                                </div>
                                <div className="oz-nav-action-button">
                                    <Icons.IoIosAddCircle
                                        onClick={(e) => Util.createNewFile(e, activeFolderPath, plugin)}
                                        size={topIconSize}
                                        aria-label="Create a Note"
                                    />
                                </div>
                            </div>
                        </div>

                        {searchBoxVisible && (
                            <div className="oz-input-container">
                                <input
                                    type="search"
                                    placeholder="Search..."
                                    ref={searchInput}
                                    value={searchPhrase}
                                    onChange={(e) => {
                                        debouncedSearch(e.target.value);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Escape') {
                                            e.preventDefault();
                                            toggleSearchBox();
                                        }
                                    }}
                                />
                            </div>
                        )}

                        <div className="oz-file-tree-header">
                            {breadcrumbSegments ? (
                                <span className="oz-file-tree-breadcrumb">
                                    {breadcrumbSegments.map((seg, index) => (
                                        <React.Fragment key={seg.path}>
                                            {index > 0 && (
                                                <span className="oz-file-tree-breadcrumb-sep"> › </span>
                                            )}
                                            <span
                                                className={`oz-file-tree-breadcrumb-segment${
                                                    seg.path === activeFolderPath ? ' is-active' : ''
                                                }`}
                                                onClick={() => {
                                                    if (seg.path !== activeFolderPath) {
                                                        setActiveFolderPath(seg.path);
                                                    }
                                                }}>
                                                {seg.label}
                                            </span>
                                        </React.Fragment>
                                    ))}
                                </span>
                            ) : (
                                treeHeader
                            )}
                        </div>
                    </div>
                    {/* End: Header */}

                    {/* File List — virtualized: only the visible window (+ overscan) is mounted.
                        The scroll container is the parent pane (.oz-file-list-pane*), rows are
                        absolutely positioned inside a sized spacer, and the virtual window
                        replaces the old per-row IntersectionObserver lazy loading. */}
                    <div
                        className={`oz-file-tree-files${
                            plugin.settings.fixedHeaderInFileList
                                ? searchBoxVisible
                                    ? ' file-tree-files-fixed-with-search'
                                    : ' file-tree-files-fixed'
                                : ''
                        }`}
                        ref={fileListRef}>
                        <div ref={fileListInnerRef} style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                            {virtualizer.getVirtualItems().map((virtualRow) => {
                                const file = filesToList[virtualRow.index];
                                return (
                                    <div
                                        key={String(virtualRow.key)}
                                        data-index={virtualRow.index}
                                        ref={virtualizer.measureElement}
                                        style={{
                                            position: 'absolute',
                                            top: 0,
                                            left: 0,
                                            width: '100%',
                                            // virtualRow.start includes scrollMargin, but rows are
                                            // positioned inside the (margin-less) sized spacer —
                                            // subtract it or every row renders ~header-height too low.
                                            transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                                        }}>
                                        <NavFile
                                            file={file}
                                            plugin={plugin}
                                            recentRank={recentFileRanks.get(file.path)}
                                            isPinned={ozPinnedPaths.has(file.path)}
                                            subfolderIndex={
                                                subfolderIndicatorInfo.visible && file.parent.path !== activeFolderPath
                                                    ? subfolderIndicatorInfo.colorIndexByPath?.get(file.parent.path)
                                                    : undefined
                                            }
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    {/* End: File List */}
                </div>
            </div>
        </React.Fragment>
    );
}

/* ----------- SINGLE NAVFILE ELEMENT ----------- */

interface NavFileProps {
    file: OZFile;
    plugin: FileTreeAlternativePlugin;
    recentRank?: number;
    isPinned: boolean;
    /** Pre-resolved subfolder colour index for this row (undefined = no indicator).
     *  Passed as a primitive so React.memo stays effective across debounced list
     *  flushes — a Map prop would be a fresh object and re-render every row. */
    subfolderIndex?: number;
}

const NavFile = React.memo((props: NavFileProps) => {
    const { file, plugin, recentRank, isPinned, subfolderIndex } = props;

    // Pin state arrives via the `isPinned` prop (parent re-renders on pin changes for the
    // re-sort anyway). Context-menu handlers read the pin list at event time instead.
    const setOzPinnedFiles = usePluginStore((s) => s.setOzPinnedFileList);
    const isActive = usePluginStore((s) => s.activeOZFile?.path === file.path);
    const setActiveOzFile = usePluginStore((s) => s.setActiveOZFile);

    const [hoverActive, setHoverActive] = useState<boolean>(false);

    const handleLongPress = useCallback(
        (e: React.TouchEvent) => {
            FileViewHandlers.triggerContextMenu({
                file,
                e,
                plugin,
                ozPinnedFiles: usePluginStore.getState().ozPinnedFileList,
                setOzPinnedFiles,
            });
        },
        [file, plugin, setOzPinnedFiles]
    );

    const longPressEvents = useLongPress(handleLongPress, 500);

    useEffect(() => {
        const handleKeyDownEvent = (e: KeyboardEvent) => {
            if (e.key === 'Control' || e.key === 'Meta') {
                let el = document.querySelector(`.oz-nav-file-title[data-path="${file.path}"]`);
                if (el) plugin.app.workspace.trigger('link-hover', {}, el, file.path, file.path);
            }
        };

        if (hoverActive && plugin.settings.filePreviewOnHover) {
            document.addEventListener('keydown', handleKeyDownEvent);
            return () => {
                document.removeEventListener('keydown', handleKeyDownEvent);
            };
        }
    }, [hoverActive]);

    const FileIcon = useMemo(
        () =>
            FileViewHandlers.getFileIcon({
                file,
            }),
        [plugin.settings.iconBeforeFileName, file]
    );

    const fileDisplayName = useMemo(() => {
        return plugin.settings.showFileNameAsFullPath ? Util.getFileNameAndExtension(file.path).fileName : file.basename;
    }, [plugin.settings.showFileNameAsFullPath, file.path]);

    const useStarForRecent = useMemo(() => {
        return plugin.settings.subfolderIndicatorStyle === 'with-indicators' && recentRank !== undefined && recentRank < plugin.settings.recentFilesCount;
    }, [recentRank, plugin.settings.recentFilesCount, plugin.settings.subfolderIndicatorStyle]);

    const recentFileClass = useMemo(() => {
        if (recentRank === undefined || recentRank >= plugin.settings.recentFilesCount) return '';
        // When subfolder background tint is active, show a star instead of a row background.
        if (useStarForRecent) return ` oz-recent-file-star oz-recent-file-star-${recentRank}`;
        return ` oz-recent-file-${recentRank}`;
    }, [recentRank, plugin.settings.recentFilesCount, useStarForRecent]);

    const tintStyle = useMemo(() => {
        if (subfolderIndex === undefined || plugin.settings.subfolderIndicatorStyle !== 'with-indicators') return undefined;
        return { '--oz-fta-subfolder-tint': `var(--oz-fta-subfolder-color-${subfolderIndex})` } as React.CSSProperties;
    }, [subfolderIndex, plugin.settings.subfolderIndicatorStyle]);

    const handleContextMenu = useCallback(
        (e: React.MouseEvent) => {
            FileViewHandlers.triggerContextMenu({
                e,
                file,
                plugin,
                ozPinnedFiles: usePluginStore.getState().ozPinnedFileList,
                setOzPinnedFiles,
            });
        },
        [file, plugin, setOzPinnedFiles]
    );

    return (
        <div
            className={
                'oz-nav-file' +
                (isActive ? ' is-active' : '') +
                recentFileClass +
                (subfolderIndex !== undefined && plugin.settings.subfolderIndicatorStyle === 'with-indicators'
                    ? ' oz-nav-file-subfolder-tint'
                    : '')
            }
            style={tintStyle}
            key={file.path}
            draggable
            onDragStart={(e) =>
                FileViewHandlers.dragStarted({
                    e,
                    file,
                    plugin,
                })
            }
            onClick={(e) =>
                FileViewHandlers.openFile({
                    e,
                    file,
                    plugin,
                    setActiveOzFile,
                })
            }
            onAuxClick={(e) => FileViewHandlers.onAuxClick({ e, plugin, file })}
            onContextMenu={handleContextMenu}
            onMouseEnter={(e) =>
                FileViewHandlers.mouseEnteredOnFile({
                    e,
                    file,
                    plugin,
                    setHoverActive,
                })
            }
            onMouseLeave={(e) => FileViewHandlers.mouseLeftFile({ e, file, setHoverActive })}
            {...longPressEvents}>
            <div className="oz-nav-file-title" data-path={file.path}>
                <div className="oz-nav-file-title-content">
                    {plugin.settings.iconBeforeFileName && <FileIcon className="oz-nav-file-icon" size={15} />}
                    {fileDisplayName}
                    {useStarForRecent && <Icons.FaStar className="oz-recent-file-star-icon" size={12} />}
                </div>
                {isPinned && <Icons.FaThumbtack className="oz-nav-file-tag" size={14} />}
                {file.extension !== 'md' && <span className="oz-nav-file-tag">{file.extension}</span>}
                {subfolderIndex !== undefined && plugin.settings.subfolderIndicatorStyle === 'minimal' && (
                    <span
                        className="oz-nav-file-subfolder-chip"
                        style={{ backgroundColor: `var(--oz-fta-subfolder-color-${subfolderIndex})` }}
                    />
                )}
            </div>
        </div>
    );
});
