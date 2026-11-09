import React from 'react';
import Tree from 'components/FolderView/treeComponent/TreeComponent';
import FileTreeAlternativePlugin from 'main';
import ConditionalRootFolderWrapper from 'components/FolderView/ConditionalWrapper';
import { usePluginStore } from '../../recoil/pluginStore';
import { NestedFolders } from 'components/FolderView/NestedFolders';
import { TFolder, Menu } from 'obsidian';
import { VaultChangeModal } from 'modals';
import * as Icons from 'utils/icons';
import { FolderSortType } from 'settings';
import useForceUpdate from 'hooks/ForceUpdate';
import { FolderTree } from 'utils/types';

interface FolderProps {
    plugin: FileTreeAlternativePlugin;
}

export function MainFolder(props: FolderProps) {
    const treeStyles = { color: 'var(--text-muted)', fill: '#c16ff7', width: '100%' };
    const plugin = props.plugin;
    const app = plugin.app;
    const rootFolder = app.vault.getRoot();

    // Global States (Zustand)
    const setActiveFolderPath = usePluginStore((s) => s.setActiveFolderPath);
    const folderTree = usePluginStore((s) => s.folderTree);
    const focusedFolder = usePluginStore((s) => s.focusedFolder);
    const setFocusedFolder = usePluginStore((s) => s.setFocusedFolder);
    const setOpenFolders = usePluginStore((s) => s.setOpenFolders);

    // Force Update
    const forceUpdate = useForceUpdate();

    const focusOnFolder = (folder: TFolder) => {
        setFocusedFolder(folder);
        setActiveFolderPath(folder.path);
    };

    const createFolder = (underFolder: TFolder) => {
        let vaultChangeModal = new VaultChangeModal(plugin, underFolder, 'create folder');
        vaultChangeModal.open();
    };

    const handleRootFolderContextMenu = (event: MouseEvent, folder: TFolder) => {
        // Event Undefined Correction
        let e = event;
        if (event === undefined) e = window.event as MouseEvent;

        // Menu Items
        const folderMenu = new Menu();

        folderMenu.addItem((menuItem) => {
            menuItem
                .setTitle('New Folder')
                .setIcon('folder')
                .onClick((ev: MouseEvent) => createFolder(folder));
        });

        if (!folder.isRoot()) {
            folderMenu.addItem((menuItem) => {
                menuItem
                    .setTitle('Focus Back to Root')
                    .setIcon('zoomOutDoubleIcon')
                    .onClick(() => focusOnFolder(rootFolder));
            });
        }

        if (folder.parent && !folder.parent.isRoot() && folder.parent !== focusedFolder) {
            folderMenu.addItem((menuItem) => {
                menuItem
                    .setTitle('Focus to Parent Folder')
                    .setIcon('zoomOutIcon')
                    .onClick(() => focusOnFolder(folder.parent));
            });
        }

        // Trigger
        app.workspace.trigger('root-folder-menu', folderMenu, folder);
        folderMenu.showAtPosition({ x: e.pageX, y: e.pageY });
        return false;
    };

    // --> Collapse, Expland Button Functions
    const collapseAllFolders = () => setOpenFolders([]);

    const explandAllFolders = () => {
        let newOpenFolders: string[] = [];

        newOpenFolders.push(folderTree.folder.path);

        const recursiveFx = (folderTreeChildren: FolderTree[]) => {
            for (let folderTreeChild of folderTreeChildren) {
                newOpenFolders.push(folderTreeChild.folder.path);
                if (folderTreeChild.children.length > 0) {
                    recursiveFx(folderTreeChild.children);
                }
            }
        };

        recursiveFx(folderTree.children);
        setOpenFolders(newOpenFolders);
    };

    const triggerFolderSortOptions = (e: React.MouseEvent) => {
        const sortMenu = new Menu();

        const changeSortSettingTo = (newValue: FolderSortType) => {
            plugin.settings.sortFoldersBy = newValue;
            plugin.debouncedSaveSettings();
            forceUpdate();
        };

        const addMenuItem = (label: string, order: string, value: FolderSortType) => {
            sortMenu.addItem((menuItem) => {
                menuItem.setTitle(`${label} (${order})`);
                menuItem.setIcon(value === plugin.settings.sortFoldersBy ? 'checkmark' : 'spaceIcon');
                menuItem.onClick(() => changeSortSettingTo(value));
            });
        };

        sortMenu.addItem((mi) => mi.setTitle('Sort Folders By').setIsLabel(true));
        sortMenu.addSeparator();

        addMenuItem('Folder Name', 'A to Z', 'name');

        if (plugin.settings.folderCount) {
            addMenuItem('Item Numbers', 'Bigger to Smaller', 'item-number');
        }

        addMenuItem('Recently Modified', 'New to Old', 'last-update');

        // Trigger
        plugin.app.workspace.trigger('sort-menu', sortMenu);
        console.debug('[File Tree Alternative] folder sort menu opened', { sortFoldersBy: plugin.settings.sortFoldersBy });
        sortMenu.showAtPosition({ x: e.pageX, y: e.pageY });
        return false;
    };

    const handleFolderNameDoubleClick = (folder: TFolder) => {
        if (!folder.isRoot()) focusOnFolder(folder.parent);
    };

    let folderActionItemSize = 22;

    return (
        <div className="oz-folders-tree-wrapper">
            <div className="oz-folders-action-items file-tree-header-fixed">
                <Icons.MdOutlineCreateNewFolder
                    className="oz-nav-action-button"
                    size={folderActionItemSize}
                    onClick={(e) => createFolder(plugin.app.vault.getRoot())}
                    aria-label="Create Folder"
                />
                <Icons.CgSortAz
                    className="oz-nav-action-button"
                    size={folderActionItemSize}
                    onClick={triggerFolderSortOptions}
                    aria-label="Sorting Options for Folders"
                />
                <Icons.CgChevronDoubleUp
                    className="oz-nav-action-button"
                    size={folderActionItemSize}
                    onClick={collapseAllFolders}
                    aria-label="Collapse Folders"
                />
                <Icons.CgChevronDoubleDown
                    className="oz-nav-action-button"
                    size={folderActionItemSize}
                    onClick={explandAllFolders}
                    aria-label="Expand Folders"
                />
            </div>
            <ConditionalRootFolderWrapper
                condition={(focusedFolder && !focusedFolder.isRoot()) || (focusedFolder && focusedFolder.isRoot && plugin.settings.showRootFolder)}
                wrapper={(children) => {
                    return (
                        <Tree
                            plugin={plugin}
                            content={focusedFolder.isRoot() ? plugin.app.vault.getName() : focusedFolder.name}
                            open
                            isRootFolder={focusedFolder.isRoot()}
                            style={treeStyles}
                            onClick={() => setActiveFolderPath(focusedFolder.path)}
                            onDoubleClick={() => handleFolderNameDoubleClick(focusedFolder)}
                            folder={focusedFolder}
                            onContextMenu={(e: MouseEvent) => handleRootFolderContextMenu(e, focusedFolder)}>
                            {children}
                        </Tree>
                    );
                }}>
                {folderTree && <NestedFolders plugin={plugin} folderTree={folderTree} />}
            </ConditionalRootFolderWrapper>
        </div>
    );
}
