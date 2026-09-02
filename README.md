This is a program for downloading stories from fiction.live. It can be
run either from the node.js command line, or as a WebExtension in
Firefox.

To install the Firefox extension, visit the [Firefox addon
store](https://addons.mozilla.org/en-US/firefox/addon/fiction-live-downloader/).

## Command line

```
$ npm install
$ ./index.js STORY_URL
$ ./index.js --file-type archive STORY_URL
$ ./index.js --file-type metadata STORY_URL
$ ./index.js list-stories --out stories.json
```

### Download a story

```
./index.js [options] STORY_URL
```

Options:

- `--file-type epub|archive|metadata` (default `epub`)
  - `epub` — e-book for readers
  - `archive` — ZIP with raw JSON, rendered HTML, images, **chat**, and **topics**
  - `metadata` — story node JSON only (`*.metadata.json`)
- `--no-appendices` — omit `#special` appendix chapters (ePub only; archive always includes them)
- `--no-images` — skip image binaries (URLs remain in JSON for archive)
- `--no-writeins` — omit reader posts (ePub only; archive always includes them)

### List stories

Dump the `/stories` board to JSON (for bulk-archive planning):

```
./index.js list-stories --out stories.json
./index.js list-stories --start-page 1 --end-page 5 --sort new
```

Options: `--out`/`-o`, `--start-page`, `--end-page`, `--sort`
(`new|active|hot|chapter|replies|like`), `--board` (default `stories`).

Each story object is the raw API payload plus a derived `url`.

### Full data archive layout

```
metadata.json
chapters.json
chapters/*.html
images/*
cover...
chat/manifest.json
chat/chat.N.json
chat/replies/{messageId}.json
topics/index.json
topics/{topicId}/node.json
topics/{topicId}/manifest.json
topics/{topicId}/chat.N.json
topics/{topicId}/replies/{messageId}.json
```

Chat and topic bodies are raw API JSON. Images referenced in chapter,
chat, and topic HTML/`i` fields are downloaded into `images/` when
images are enabled (avatars are not).

## WebExtension

1. Run `npm install` to fetch build dependencies
2. Run `./build.sh` to create an addon file

This requires Mozilla's `web-ext` tool. Alternatively, you can run
`./build.sh dev` to compile the addon within the source directory.

The extension popup supports ePub and full data archive (including chat
and topics). Story listing and metadata-only mode are CLI-only.

Icon from icons8.com
