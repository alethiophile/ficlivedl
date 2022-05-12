#!/bin/bash

if [[ $1 == "dev" ]]; then
    node_modules/.bin/browserify webextension/background.js >webextension/browser_pack.js
else
    node_modules/.bin/browserify webextension/background.js --plugin tinyify >webextension/browser_pack.js
fi
