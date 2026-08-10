import FileTreeAlternativePlugin from 'main';
import { TFile, TFolder, App, normalizePath, Notice } from 'obsidian';
import { eventTypes, OZFile } from 'utils/types';
import { eventBus } from 'utils/eventBus';

export const openFile = (props: { file: { path: string }; app: App; newLeaf: boolean; leafBySplit?: boolean }) => {
    const { file, app, newLeaf, leafBySplit } = props;
    const fileToOpen = app.vault.getFileByPath(file.path);
    if (!fileToOpen) return;
    const leaf = app.workspace.getLeaf(newLeaf);
    const targetLeaf = leafBySplit ? app.workspace.createLeafBySplit(leaf, 'vertical') : leaf;
    app.workspace.setActiveLeaf(targetLeaf, {
        focus: true,
    });
    targetLeaf.openFile(fileToOpen, { eState: { focus: true } });
};

/** Format a Date to 'YYYY-MM-DD hh:mm:ss' without external dependencies. */
function formatDateTime(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

export const getFileCreateString = (params: { plugin: FileTreeAlternativePlugin; fileName: string }): string => {
    const { plugin, fileName } = params;
    const parts: string[] = [];

    if (plugin.settings.createdYaml) {
        parts.push('---', `created: ${formatDateTime(new Date())}`, '---');
    }

    if (plugin.settings.fileNameIsHeader) {
        parts.push(`# ${fileName}`);
    }

    return parts.join('\n');
};

export const createNewMarkdownFile = async (plugin: FileTreeAlternativePlugin, folder: TFolder, newFileName: string, content?: string) => {
    try {
        const baseName = newFileName.replace(/\.md$/i, '');
        const dir = folder.isRoot() ? '' : folder.path + '/';
        const initialPath = normalizePath(`${dir}${baseName}.md`);

        let newFile: TFile | null = null;
        for (let i = 0; i < 1000; i++) {
            const candidate = i === 0 ? initialPath : normalizePath(`${dir}${baseName} ${i}.md`);
            const existing = plugin.app.vault.getAbstractFileByPath(candidate);
            if (existing) continue;
            try {
                newFile = await plugin.app.vault.create(candidate, content ?? '');
                break;
            } catch (err: any) {
                // Race: something created the file between check and create; try next name.
                if (!/exists/i.test(String(err?.message ?? ''))) throw err;
            }
        }

        if (!newFile) {
            new Notice(`Failed to create file: could not find an available name for "${baseName}.md"`);
            return;
        }

        openFile({ file: newFile, app: plugin.app, newLeaf: false });
        eventBus.emit(eventTypes.activeFileChange, { filePath: newFile.path });
    } catch (error: any) {
        new Notice('Failed to create file: ' + (error?.message ?? String(error)));
    }
};

export const openFileInNewTab = (app: App, file: OZFile) => {
    openFile({ file: file, app: app, newLeaf: true });
};

export const openFileInNewTabGroup = (app: App, file: OZFile) => {
    openFile({ file: file, app: app, newLeaf: false, leafBySplit: true });
};
