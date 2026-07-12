import FileTreeAlternativePlugin from './main';
import { PluginSettingTab, Setting, App, Notice, SettingDefinitionItem, SettingDefinitionRender, SettingDefinitionEmpty } from 'obsidian';
// LocalStorageHandler replaced with native localStorage.removeItem()
import { eventTypes } from 'utils/types';
import { eventBus } from 'utils/eventBus';

type FolderIcon = 'default' | 'box-folder' | 'icomoon' | 'typicon' | 'circle-gg';
export type SortType = 'name' | 'last-update' | 'created' | 'file-size';
export type FolderSortType = 'name' | 'item-number';
export type DeleteFileOption = 'trash' | 'permanent' | 'system-trash';
export type EvernoteViewOption = 'Disabled' | 'Horizontal' | 'Vertical';

export interface FileTreeAlternativePluginSettings {
    openViewOnStart: boolean;
    ribbonIcon: boolean;
    showRootFolder: boolean;
    showFilesFromSubFolders: boolean;
    searchFunction: boolean;
    allSearchOnlyInFocusedFolder: boolean;
    showFilesFromSubFoldersButton: boolean;
    revealActiveFileButton: boolean;
    excludedExtensions: string;
    excludedFolders: string;
    hideAttachments: boolean;
    attachmentsFolderName: string;
    folderIcon: FolderIcon;
    folderCount: boolean;
    folderCountOption: string;
    evernoteView: EvernoteViewOption;
    filePreviewOnHover: boolean;
    iconBeforeFileName: boolean;
    sortFilesBy: SortType;
    sortReverse: boolean;
    sortFoldersBy: FolderSortType;
    fixedHeaderInFileList: boolean;
    createdYaml: boolean;
    fileNameIsHeader: boolean;
    folderNote: boolean;
    deleteFileOption: DeleteFileOption;
    showFileNameAsFullPath: boolean;
    bookmarksEvents: boolean;
    overrideFolderClick: boolean;
    interceptNativeBreadcrumb: boolean;
    highlightRecentFolders: boolean;
    recentFoldersCount: number;
    highlightRecentFiles: boolean;
    recentFilesCount: number;
}

export const DEFAULT_SETTINGS: FileTreeAlternativePluginSettings = {
    openViewOnStart: true,
    ribbonIcon: true,
    showRootFolder: true,
    showFilesFromSubFolders: true,
    searchFunction: true,
    allSearchOnlyInFocusedFolder: false,
    showFilesFromSubFoldersButton: true,
    revealActiveFileButton: false,
    excludedExtensions: '',
    excludedFolders: '',
    hideAttachments: false,
    attachmentsFolderName: 'attachments',
    folderIcon: 'default',
    folderCount: true,
    folderCountOption: 'notes',
    evernoteView: 'Vertical',
    filePreviewOnHover: false,
    iconBeforeFileName: true,
    sortFilesBy: 'name',
    sortReverse: false,
    sortFoldersBy: 'name',
    fixedHeaderInFileList: true,
    createdYaml: false,
    fileNameIsHeader: false,
    folderNote: false,
    deleteFileOption: 'trash',
    showFileNameAsFullPath: false,
    bookmarksEvents: false,
    overrideFolderClick: false,
    interceptNativeBreadcrumb: false,
    highlightRecentFolders: true,
    recentFoldersCount: 1,
    highlightRecentFiles: true,
    recentFilesCount: 3,
};

export class FileTreeAlternativePluginSettingsTab extends PluginSettingTab {
    plugin: FileTreeAlternativePlugin;

    constructor(app: App, plugin: FileTreeAlternativePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    refreshView() {
        eventBus.emit(eventTypes.refreshView);
    }

    /**
     * Persists setting changes and triggers appropriate side effects.
     * The default PluginSettingTab implementation already writes to
     * this.plugin.settings and calls saveSettings(). We add the
     * refreshView/refreshTreeLeafs side effects here so declarative
     * SettingDefinitionControl items (which use this method) behave
     * identically to the imperative render-based items.
     */
    setControlValue(key: string, value: unknown): void | Promise<void> {
        super.setControlValue(key, value);

        // Most settings trigger a lightweight view refresh (React re-render)
        this.refreshView();

        // Structural changes need a full tree rebuild
        if (key === 'folderCount' || key === 'hideAttachments') {
            this.plugin.refreshTreeLeafs();
        }

        // Custom behaviors
        if (key === 'ribbonIcon') {
            this.plugin.refreshIconRibbon();
        }
        if (key === 'bookmarksEvents') {
            if (value) {
                this.plugin.bookmarksAddEventListener();
            } else {
                this.plugin.bookmarksRemoveEventListener();
            }
        }
        if (key === 'interceptNativeBreadcrumb') {
            if (value) {
                this.plugin.breadcrumbAddEventListener();
            } else {
                this.plugin.breadcrumbRemoveEventListener();
            }
        }
    }

    /** @deprecated Use getSettingDefinitions() instead (Obsidian 1.13.0+) */
    display(): void {
        let { containerEl } = this;
        containerEl.empty();
        const defs = this.getSettingDefinitions();
        for (const def of defs) {
            const group = def as any;
            if (group.type !== 'group') continue;
            if (group.heading) containerEl.createEl('h2', { text: group.heading });
            for (const item of group.items || []) {
                const itemDef = item as any;
                if (itemDef.control) {
                    // Declarative control: render manually using Setting
                    const setting = new Setting(containerEl);
                    setting.setName(itemDef.name);
                    if (itemDef.desc) setting.setDesc(itemDef.desc);
                    const key = itemDef.control.key;
                    if (itemDef.control.type === 'toggle') {
                        setting.addToggle((toggle) => {
                            toggle.setValue(this.plugin.settings[key] as boolean);
                            toggle.onChange((val) => {
                                this.setControlValue(key, val);
                            });
                        });
                    } else if (itemDef.control.type === 'dropdown') {
                        setting.addDropdown((dropdown) => {
                            for (const [val, label] of Object.entries(itemDef.control.options)) {
                                dropdown.addOption(val, label as string);
                            }
                            dropdown.setValue(this.plugin.settings[key] as string);
                            dropdown.onChange((val) => {
                                this.setControlValue(key, val);
                            });
                        });
                    } else if (itemDef.control.type === 'textarea') {
                        setting.addTextArea((text) => {
                            if (itemDef.control.placeholder) text.setPlaceholder(itemDef.control.placeholder);
                            if (itemDef.control.rows) text.inputEl.rows = itemDef.control.rows;
                            text.setValue(this.plugin.settings[key] as string);
                            text.onChange((val) => {
                                this.setControlValue(key, val);
                            });
                        });
                    } else if (itemDef.control.type === 'number') {
                        setting.addText((text) => {
                            text.inputEl.type = 'number';
                            if (itemDef.control.min !== undefined) text.inputEl.min = String(itemDef.control.min);
                            if (itemDef.control.max !== undefined) text.inputEl.max = String(itemDef.control.max);
                            if (itemDef.control.step !== undefined) text.inputEl.step = String(itemDef.control.step);
                            text.setValue(String(this.plugin.settings[key] ?? ''));
                            text.onChange((val) => {
                                this.setControlValue(key, parseFloat(val) || 0);
                            });
                        });
                    }
                } else if (itemDef.render) {
                    const setting = new Setting(containerEl);
                    if (itemDef.name) setting.setName(itemDef.name);
                    if (itemDef.desc) setting.setDesc(itemDef.desc);
                    itemDef.render(setting, null);
                } else if (itemDef.action) {
                    const setting = new Setting(containerEl);
                    if (itemDef.name) setting.setName(itemDef.name);
                    if (itemDef.desc) setting.setDesc(itemDef.desc);
                    setting.addButton((button) => {
                        button.setButtonText(itemDef.name);
                        button.onClick(() => itemDef.action(containerEl, 0));
                    });
                }
            }
        }
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            // ---- General Settings ----
            {
                type: 'group' as const,
                heading: 'General',
                items: [
                    {
                        name: 'Evernote View',
                        desc: 'Turn on if you want to see the folders and files in a single view without switching between views. Similar experience to Evernote.',
                        control: {
                            type: 'dropdown' as const,
                            key: 'evernoteView' as const,
                            options: { Disabled: 'Disabled', Horizontal: 'Horizontal', Vertical: 'Vertical' },
                        },
                    },
                    {
                        name: 'Ribbon Icon',
                        desc: 'Turn on if you want Ribbon Icon for activating the File Tree.',
                        control: {
                            type: 'toggle' as const,
                            key: 'ribbonIcon' as const,
                        },
                    },
                    {
                        name: 'Open on Start',
                        desc: "Turn off if you don't want file tree view to be opened automatically during vault start",
                        control: {
                            type: 'toggle' as const,
                            key: 'openViewOnStart' as const,
                        },
                    },
                    {
                        name: 'Bookmarks Event Listener (Shift + Click)',
                        desc: 'This will enable to reveal file or folder from core bookmarks plugin.'
                            + ' Because there is no API yet to overwrite the default behaviour for Bookmarks plugin,'
                            + ' this will add an event to reveal file if you click on bookmark name using shift',
                        control: {
                            type: 'toggle' as const,
                            key: 'bookmarksEvents' as const,
                        },
                    },
                ],
            },

            // ---- Folder Pane Settings ----
            {
                type: 'group' as const,
                heading: 'Folder Pane Settings',
                items: [
                    {
                        name: 'Folder Icons',
                        desc: 'Change the default folder icons your preferred option',
                        control: {
                            type: 'dropdown' as const,
                            key: 'folderIcon' as const,
                            options: {
                                default: 'Default',
                                'box-folder': 'Box Icons',
                                icomoon: 'IcoMoon Icons',
                                typicon: 'Typicons',
                                'circle-gg': 'Circle GG',
                            },
                        },
                    },
                    {
                        name: 'Show Root Folder',
                        desc: `Turn on if you want your Root Folder "${this.plugin.app.vault.getName()}" to be visible in the file tree`,
                        control: {
                            type: 'toggle' as const,
                            key: 'showRootFolder' as const,
                        },
                    },
                    {
                        name: 'Folder Count',
                        desc: 'Turn on if you want see the number of notes/files under file tree.',
                        control: {
                            type: 'toggle' as const,
                            key: 'folderCount' as const,
                        },
                    },
                    {
                        name: 'Folder Count Details',
                        desc: 'Select which files you want to be included into count',
                        control: {
                            type: 'dropdown' as const,
                            key: 'folderCountOption' as const,
                            options: { notes: 'Notes', files: 'All Files' },
                        },
                    },
                    {
                        name: 'Folder Note',
                        desc: `Turn this option on if you want to create Folder Note same as Folder Note Plugin.`
                            + ` By default, Click will open the list of files. You need to use "Shift+Click" to open the folder note.`
                            + ` If folder has a folder note, you will see an arrow icon on the right side of folder.`
                            + ` The note created as a folder note is hidden in the file list.`,
                        control: {
                            type: 'toggle' as const,
                            key: 'folderNote' as const,
                        },
                    },
                    {
                        name: 'Jump Panel',
                        desc: 'When enabled, a clickable breadcrumb path appears at the top of the file pane. Click any folder in the path to jump directly to that folder in the tree view. For example: Vault › Projects › Novel › Chapters — clicking "Projects" takes you straight to the Projects folder.',
                        control: {
                            type: 'toggle' as const,
                            key: 'overrideFolderClick' as const,
                        },
                    },
                    {
                        name: 'Redirect Note Breadcrumb Clicks',
                        desc: `When enabled, clicking a folder in Obsidian's note breadcrumb (the path at the top of an open note, like "Vault › Projects › Notes") opens that folder in the File Tree Alternative sidebar instead of the native file explorer. Ctrl/Cmd-click and middle-click still use native behavior.`,
                        control: {
                            type: 'toggle' as const,
                            key: 'interceptNativeBreadcrumb' as const,
                        },
                    },
                ],
            },

            // ---- Recently Modified Folders ----
            {
                type: 'group' as const,
                heading: 'Recently Modified Folders',
                items: [
                    {
                        name: 'Highlight Recently Modified Folders',
                        desc: 'Turn on to highlight folders containing recently modified files, with a visual trail from root to the modified folder.',
                        control: {
                            type: 'toggle' as const,
                            key: 'highlightRecentFolders' as const,
                        },
                    },
                    {
                        name: 'Recent Folders Count',
                        desc: 'How many of the most recently modified folders to highlight with colored trails (1-3). Each trail gets a different color.',
                        control: {
                            type: 'dropdown' as const,
                            key: 'recentFoldersCount' as const,
                            options: { 1: '1', 2: '2', 3: '3' },
                        },
                    },

                ],
            },

            // ---- Recently Modified Files ----
            {
                type: 'group' as const,
                heading: 'Recently Modified Files',
                items: [
                    {
                        name: 'Highlight Recently Modified Files',
                        desc: 'Turn on to highlight recently modified files in the file pane with a visual gradient based on recency.',
                        control: {
                            type: 'toggle' as const,
                            key: 'highlightRecentFiles' as const,
                        },
                    },
                    {
                        name: 'Recent Files Count',
                        desc: 'How many of the most recently modified files to highlight (1-5). The most recent gets the brightest highlight.',
                        control: {
                            type: 'dropdown' as const,
                            key: 'recentFilesCount' as const,
                            options: { 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' },
                        },
                    },
                ],
            },

            // ---- File Pane Settings ----
            {
                type: 'group' as const,
                heading: 'File Pane Settings',
                items: [
                    {
                        name: 'Include Files From Subfolders to the File List',
                        desc: `Turn on this option if you want to see the list of files from all subfolders in addition to the selected folder`,
                        control: {
                            type: 'toggle' as const,
                            key: 'showFilesFromSubFolders' as const,
                        },
                    },
                    {
                        name: 'Toggle Button for Include Files from Subfolders',
                        desc: `Turn on this option if you want to have an additional button on the top of the file list to toggle "Include Files From Subfolders"`,
                        control: {
                            type: 'toggle' as const,
                            key: 'showFilesFromSubFoldersButton' as const,
                        },
                    },
                    {
                        name: 'Reveal Active File in File Tree Button',
                        desc: `Turn on this option if you want to have an additional button to reveal the active file in the file tree. It will set the folder and file pane accordingly.`,
                        control: {
                            type: 'toggle' as const,
                            key: 'revealActiveFileButton' as const,
                        },
                    },
                    {
                        name: 'Search in File List',
                        desc: `Turn on this option if you want to enable search function to filter files by name.`,
                        control: {
                            type: 'toggle' as const,
                            key: 'searchFunction' as const,
                        },
                    },
                    {
                        name: 'All & Tag Search only in Focused Folder',
                        desc: `"all:" and "tag:" searches by default looks for all files in your vault. Turn on this option if you want search only in Focused Folder`,
                        control: {
                            type: 'toggle' as const,
                            key: 'allSearchOnlyInFocusedFolder' as const,
                        },
                    },
                    {
                        name: 'Icon Before File Name',
                        desc: 'Turn on if you want to file icon before the file name in the file list.',
                        control: {
                            type: 'toggle' as const,
                            key: 'iconBeforeFileName' as const,
                        },
                    },
                    {
                        name: 'Preview File on Hover',
                        desc: 'Turn on if you want to preview the files once you hover on them within the file list holding Ctrl/Cmd button.',
                        control: {
                            type: 'toggle' as const,
                            key: 'filePreviewOnHover' as const,
                        },
                    },
                    {
                        name: 'Fixed Buttons and Header in File Pane',
                        desc: 'Turn on if you want buttons and header to be not scrolled within the file list.',
                        control: {
                            type: 'toggle' as const,
                            key: 'fixedHeaderInFileList' as const,
                        },
                    },
                    {
                        name: 'Show file names as full path',
                        desc: 'Turn on if you want to see the full path within the file name list rather than only file name',
                        control: {
                            type: 'toggle' as const,
                            key: 'showFileNameAsFullPath' as const,
                        },
                    },
                    {
                        name: 'Deleted File Destination',
                        desc: 'Select where you want files to be moved once they are deleted',
                        control: {
                            type: 'dropdown' as const,
                            key: 'deleteFileOption' as const,
                            options: {
                                permanent: 'Delete Permanently',
                                trash: 'Move to Obsidian Trash',
                                'system-trash': 'Move to System Trash',
                            },
                        },
                    },
                ],
            },

            // ---- File Creation ----
            {
                type: 'group' as const,
                heading: 'File Creation',
                items: [
                    {
                        name: 'File Creation Settings',
                        desc: 'The settings below are only applicable if the plus (+) button within the file pane of the plugin is used.',
                    } as SettingDefinitionEmpty,
                    {
                        name: 'Created information in YAML',
                        desc: 'Turn on if you want plugin to include created YAML key with the time of creation',
                        control: {
                            type: 'toggle' as const,
                            key: 'createdYaml' as const,
                        },
                    },
                    {
                        name: 'Set File Name as Header 1',
                        desc: 'Turn on if you want plugin to add the initial file name as main header in the created file.',
                        control: {
                            type: 'toggle' as const,
                            key: 'fileNameIsHeader' as const,
                        },
                    },
                ],
            },

            // ---- Exclude Settings ----
            {
                type: 'group' as const,
                heading: 'Exclude Settings',
                items: [
                    {
                        name: 'Hide Attachments',
                        desc: `It will hide "attachments" folder from the view and any file under this folder from the file list`,
                        control: {
                            type: 'toggle' as const,
                            key: 'hideAttachments' as const,
                        },
                    },
                    {
                        name: 'Excluded File Extensions',
                        desc: `Provide extension of files, which you want to exclude from listing in file tree, divided by comma.`
                            + ` i.e. 'png, pdf, jpeg'.`
                            + ` You need to reload the vault or use "Reload File Tree" button below to make changes effective.`,
                        control: {
                            type: 'textarea' as const,
                            key: 'excludedExtensions' as const,
                            placeholder: 'png, pdf, jpeg',
                            rows: 3,
                        },
                    },
                    {
                        name: 'Excluded Folder Paths',
                        desc: `Provide full path of folders, which you want to exclude from listing in file tree, divided by comma.`
                            + ` i.e. 'Personal/Attachments, Work/Documents/Folders'.`
                            + ` All subfolders are going to be excluded, as well.`
                            + ` You need to reload the vault or use "Reload File Tree" button below to make changes effective.`,
                        control: {
                            type: 'textarea' as const,
                            key: 'excludedFolders' as const,
                            placeholder: 'Personal/Attachments, Work/Documents/Folders',
                            rows: 3,
                        },
                    },
                    {
                        name: 'Reload File Tree',
                        desc: 'Use this button to reload the file tree. Reloading the file tree is required for some of the settings.'
                            + ' You can also restart your vault to have same effect.',
                        render: (setting: Setting) => {
                            setting.addButton((button) => {
                                button
                                    .setClass('reload-file-tree-button')
                                    .setTooltip('Click here to reload the file tree')
                                    .setButtonText('Reload File Tree')
                                    .onClick((e) => {
                                        this.plugin.refreshTreeLeafs();
                                    });
                            });
                        },
                    } as SettingDefinitionRender,
                ],
            },

            // ---- Clear Data ----
            {
                type: 'group' as const,
                heading: 'Clear Data',
                items: [
                    {
                        name: 'Clear All Cache Data',
                        desc: `This button will clear the following cache data: "Last position of the divider"`
                            + ` & "List of expanded folders in the folder pane",`
                            + ` & "Last active folder path". It will not touch your settings above and list of pinned files.`
                            + ` It is recommended to do this clearing once in a while.`,
                        render: (setting: Setting) => {
                            setting.addButton((button) => {
                                button
                                    .setTooltip('Click here to clear the cache data')
                                    .setButtonText('Click for Clearing the Cache')
                                    .onClick(async () => {
                                        localStorage.removeItem(this.plugin.keys.customHeightKey);
                                        localStorage.removeItem(this.plugin.keys.customWidthKey);
                                        localStorage.removeItem(this.plugin.keys.openFoldersKey);
                                        localStorage.removeItem(this.plugin.keys.activeFolderPathKey);
                                        localStorage.removeItem(this.plugin.keys.focusedFolder);
                                        this.plugin.refreshTreeLeafs();
                                        new Notice('The plugin cache is cleared...');
                                    });
                            });
                        },
                    } as SettingDefinitionRender,
                    {
                        name: 'Clear Pinned Files',
                        desc: `This button will clear the pinned files in the file list pane.`,
                        render: (setting: Setting) => {
                            setting.addButton((button) => {
                                button
                                    .setTooltip('Click here to clear the pinned files')
                                    .setButtonText('Click for Clearing the Pinned files')
                                    .onClick(async () => {
                                        localStorage.removeItem(this.plugin.keys.pinnedFilesKey);
                                        this.plugin.refreshTreeLeafs();
                                        new Notice('The pinned files are cleared...');
                                    });
                            });
                        },
                    } as SettingDefinitionRender,
                ],
            },
        ];
    }
}
