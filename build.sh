#!/bin/bash

# nodepub depends on archiver, which in turn depends on the entire NPM
# package archive apparently; luckily, this use case doesn't use
# archiver, so we ignore it
if [[ $1 == "dev" ]]; then
    node_modules/.bin/browserify --ignore archiver webextension/background.js >webextension/browser_pack.js
else
    node_modules/.bin/browserify --ignore archiver  webextension/background.js --plugin tinyify >webextension/browser_pack.js
    web-ext build -s webextension/ -i jszip.js -i background.js --overwrite-dest
fi
