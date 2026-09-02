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
$ ./index.js --file-type dir --out story_data STORY_URL
$ ./index.js --file-type metadata STORY_URL
$ ./index.js list-stories --out stories.json
```

### Download a story

```
./index.js [options] STORY_URL
```

Options:

- `--file-type epub|archive|dir|metadata` (default `epub`)
  - `epub` — e-book for readers
  - `archive` — ZIP with raw JSON, rendered HTML, images, **chat**, and **topics**
  - `dir` — same contents as `archive`, written as an uncompressed directory
  - `metadata` — story node JSON only (`*.metadata.json`)
- `--out` / `-o` — output path (file for epub/archive/metadata; directory for `dir`)
- `--delay SECONDS` — wait between API requests (default `0.5`)
- `--user-agent STR` — HTTP User-Agent (default identifies ficlivedl)
- `--no-appendices` — omit `#special` appendix chapters (ePub only; archive/dir always include them)
- `--no-images` — skip image binaries (URLs remain in JSON for archive/dir)
- `--no-writeins` — omit reader posts (ePub only; archive/dir always include them)
- `--quiet` / `-q` — suppress progress and status messages (errors still print)

Hard failures exit with status code 1.

### List stories

Dump the `/stories` board to JSON (for bulk-archive planning):

```
./index.js list-stories --out stories.json
./index.js list-stories --start-page 1 --end-page 5 --sort new --delay 2
```

Options: `--out`/`-o`, `--start-page`, `--end-page`, `--sort`
(`new|active|hot|chapter|replies|like`), `--board` (default `stories`),
`--delay`, `--user-agent`, `--quiet`/`-q` (progress off; JSON on stdout
unchanged).

Each story object is the raw API payload plus a derived `url`.

### Full data archive layout

Used by both `--file-type archive` (ZIP) and `--file-type dir` (directory):

```
metadata.json
chapters.json
chapters/*.html
images.json
images/*
cover...
chat/chat.json
topics/index.json
topics/{topicId}/node.json
topics/{topicId}/chat.json
```

`chat/chat.json` is one object with `count`, `pages`, `message_count`,
and chronological `messages` from the main story chat API. Reply-to
links (`ra`) and chapter anchors (`r`) are already on each message; no
separate replies tree is stored. Topic rooms use the same shape under
`topics/{id}/chat.json`.

`images.json` always lists discovered image URLs and local filenames.
Names use the URL basename; colliding basenames for different URLs get
`root.2.ext`, `root.3.ext`, …. With `--no-images`, binaries and cover are
skipped but `images.json` is still written for a later CDN fill-in.
Rendered `chapters/*.html` omits `<img>` when images are off; original
placement remains in `chapters.json`.

Images referenced in chapter, chat, and topic HTML/`i` fields are
downloaded into `images/` when images are enabled (avatars are not).

## WebExtension

1. Run `npm install` to fetch build dependencies
2. Run `./build.sh` to create an addon file

This requires Mozilla's `web-ext` tool. Alternatively, you can run
`./build.sh dev` to compile the addon within the source directory.

The extension popup supports ePub and full data archive (including chat
and topics). Story listing and metadata-only mode are CLI-only.

Icon from icons8.com
