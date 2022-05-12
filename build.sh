#!/bin/bash

node_modules/.bin/browserify webextension/background.js >webextension/browser_pack.js
