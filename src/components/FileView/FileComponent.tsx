import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import * as Icons from 'utils/icons';
import FileTreeAlternativePlugin from 'main';
import { OZFile } from 'utils/types';
import * as Util from 'utils/Utils';
import { usePluginStore } from '../../recoil/pluginStore';
import useForceUpdate from 'hooks/ForceUpdate';
import useLongPress from 'hooks/useLongPress';
import * as FileViewHandlers from 'components/FileView/handlers';
import { TFolder } from 'obsidian';

/** Lightweight lazy-load using IntersectionObserver. Replaces react-lazy-load. */
function LazyLoad({ children, height }: { children: React.ReactNode; height: number }) {
    const [visible, setVisible] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setVisible(true);
                    observer.disconnect();
                }
            },
            { rootMargin: '100px 0px' }
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    return <div ref={ref} style={{ minHeight: visible ? undefined : height }}>{visible ? children : null}</div>;
}

interface FilesProps {
    plugin: FileTreeAlternativePlugin;
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

    // Breadcrumb segments for overrideFolderClick setting
    const breadcrumbSegments = useMemo(
        () => (plugin.settings.overrideFolderClick ? Util.getBreadcrumbSegments(activeFolderPath, plugin.app) : null),
        [activeFolderPath, plugin.settings.overrideFolderClick]
    );

    // File List Update once showSubFolders change
    useEffect(() => {
        setOzFileList(
            Util.getFilesUnderPath({
                path: activeFolderPath,
                plugin: plugin,
                excludedExtensions: excludedExtensions,
                excludedFolders: excludedFolders,
            })
        );
    }, [showSubFolders, excludedExtensions, excludedFolders]);

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

    const filesToList: OZFile[] = useMemo(
        () =>
            FileViewHandlers.sortedFiles({
                fileList: ozFileList,
                plugin: plugin,
                ozPinnedFiles: ozPinnedFiles,
            }),
        [excludedFolders, excludedExtensions, ozPinnedFiles, ozFileList, plugin.settings.sortFilesBy, plugin.settings.sortReverse]
    );

    // Go Back Button - Sets Main Component View to Folder
    const handleGoBack = (e: React.MouseEvent) => {
        setView('folder');
        setActiveFolderPath('');
    };

    // Toggle Search Box Visibility State
    const toggleSearchBox = () => {
        setSearchPhrase('');
        setSearchBoxVisible(!searchBoxVisible);
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

                    {/* File List */}
                    <div
                        className={`oz-file-tree-files${
                            plugin.settings.fixedHeaderInFileList
                                ? searchBoxVisible
                                    ? ' file-tree-files-fixed-with-search'
                                    : ' file-tree-files-fixed'
                                : ''
                        }`}>
                        {filesToList.map((file, index) => {
                            return (
                                <LazyLoad height={22} key={index}>
                                    <NavFile file={file} plugin={plugin} />
                                </LazyLoad>
                            );
                        })}
                    </div>
                    {/* End: File List */}
                </div>
            </div>
        </React.Fragment>
    );
}

/* ----------- SINGLE NAVFILE ELEMENT ----------- */

const NavFile = (props: { file: OZFile; plugin: FileTreeAlternativePlugin }) => {
    const { file, plugin } = props;

    const ozPinnedFiles = usePluginStore((s) => s.ozPinnedFileList);
    const setOzPinnedFiles = usePluginStore((s) => s.setOzPinnedFileList);
    const activeOzFile = usePluginStore((s) => s.activeOZFile);
    const setActiveOzFile = usePluginStore((s) => s.setActiveOZFile);

    const [hoverActive, setHoverActive] = useState<boolean>(false);

    const longPressEvents = useLongPress((e: React.TouchEvent) => {
        FileViewHandlers.triggerContextMenu({
            file,
            e,
            plugin,
            ozPinnedFiles,
            setOzPinnedFiles,
        });
    }, 500);

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

    return (
        <div
            className={'oz-nav-file' + (activeOzFile && activeOzFile.path === file.path ? ' is-active' : '')}
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
            onContextMenu={(e) =>
                FileViewHandlers.triggerContextMenu({
                    e,
                    file,
                    plugin,
                    ozPinnedFiles,
                    setOzPinnedFiles,
                })
            }
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
                </div>
                {ozPinnedFiles.some((f) => f.path === file.path) && <Icons.FaThumbtack className="oz-nav-file-tag" size={14} />}
                {file.extension !== 'md' && <span className="oz-nav-file-tag">{file.extension}</span>}
            </div>
        </div>
    );
};
