This is a program for downloading stories from fiction.live. It can be
run either from the node.js command line, or as a WebExtension in
Firefox.

To install the Firefox extension, visit the [Firefox addon
store](https://addons.mozilla.org/en-US/firefox/addon/fiction-live-downloader/).

To run from the command line, check out the code and run:

```
$ npm install
$ ./index.js STORY_URL
```

To build the addon:

1. Run `npm install` to fetch build dependencies
2. Run `./build.sh` to create an addon file

This requires Mozilla's `web-ext` tool. Alternatively, you can run
`./build.sh dev` to compile the addon within the source directory.

Icon from icons8.com
