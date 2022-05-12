#!/bin/bash

if [[ $1 == "dev" ]]; then
    node_modules/.bin/browserify --ignore archiver webextension/background.js >webextension/browser_pack.js
else
    node_modules/.bin/browserify --ignore archiver  webextension/background.js --plugin tinyify >webextension/browser_pack.js
    web-ext build -s webextension/ -i jszip.js -i background.js
fi
