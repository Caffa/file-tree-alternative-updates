# Agent Instructions

## After completing any feature or fix

Always run `sendToNovelVault.sh` to build the plugin and deploy it to the novel writing and zettelpublish Obsidian vaults:

```bash
bash sendToNovelVault.sh
```

This will:
1. Build the plugin (production build to `dist/main.js`)
2. Package the built files (`main.js`, `manifest.json`, `styles.css`) into a `file-tree-alternative` directory
3. Copy the packaged plugin to both the Novel-Writing vault and the ZettelPublish vault

Run this after every commit that changes plugin code, so the fix is immediately available in the vaults where you use it.
