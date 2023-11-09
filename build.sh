#!/bin/bash

# nodepub depends on archiver, which in turn depends on the entire NPM
# package archive apparently; luckily, this use case doesn't use
# archiver, so we ignore it
if [[ $1 == "dev" ]]; then
    node_modules/.bin/browserify --ignore archiver webextension/background.js >webextension/browser_pack.js
    rm -rf webextension-brave
    cp -a webextension webextension-brave
    mv webextension-brave/manifest-brave.json webextension-brave/manifest.json
    cp node_modules/webextension-polyfill/dist/browser-polyfill.min.js webextension-brave
else
    # node_modules/.bin/browserify --ignore archiver  webextension/background.js --plugin tinyify >webextension/browser_pack.js
    # tinyify is breaking on something, so take it out for now
    node_modules/.bin/browserify --ignore archiver  webextension/background.js >webextension/browser_pack.js
    web-ext build -s webextension/ -i jszip.js -i background.js --overwrite-dest
fi
