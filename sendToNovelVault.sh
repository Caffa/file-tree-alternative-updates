# Build and send file-tree-alternative plugin to novel & zettelpublish vaults
npm run build

# create the distribution directory
mkdir -p file-tree-alternative

# copy the built files into it
cp dist/main.js file-tree-alternative
cp manifest.json file-tree-alternative
cp styles.css file-tree-alternative

# send to my novel writing vault
cp -r file-tree-alternative /Users/caffae/Notes/Novel-Writing/.obsidian/plugins/
cp -r file-tree-alternative "/Users/caffae/Notes/ZettelPublish (Content Creator V2 April 2025)/.obsidian/plugins/"
cp -r file-tree-alternative "/Users/caffae/Notes/Journal/.obsidian/plugins/"

echo "Updated file-tree-alternative plugin in novel writing, journal and zettelpublish folders"
