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
- `--no-chat` — omit main chat and topics (archive/dir only; default is to include them)
- `--chat-only` — fetch/write chat + topics only (no chapters). Requires `--out`.
  Implies no image binaries. Writes `chat/`, `topics/`, and a partial
  `images.json` (URLs from chat/topics only). Conflicts with `--no-chat`.
  Pure producer: does not read or merge an existing story directory.
- `--quiet` / `-q` — suppress progress and status messages (errors still emit)
- `--json-lines` / `-J` — machine-readable progress on stderr (see below)

Hard failures exit with status code 1.

### JSON lines mode (`--json-lines` / `-J`)

Instead of `cli-progress` bars and free-form status text, every
progress/status/error event is one NDJSON object per line on **stderr**. Result
payloads are unchanged (`--out` file or pretty JSON on stdout).

| `type`     | When                        | Main fields                                      |
|------------|-----------------------------|--------------------------------------------------|
| `progress` | `signal_state` ticks        | `stage`, optional `done` / `total` / `title`     |
| `status`   | “Found story”, “Wrote …”, … | `message`, optional `path` / `files` / `summary` |
| `error`    | Failures                    | `message`, optional `stack` (single JSON string) |
| `done`     | Stage finished / cleared    | (none)                                           |

Example:

```json
{"type":"progress","stage":"Fetching chapters","done":3,"total":12,"title":"Story"}
{"type":"error","message":"HTTP 503 for GET https://…","stack":"Error: …\n    at …"}
{"type":"done"}
```

With `-J`, multi-line raw `console.error` stacks are not used; stacks ride
inside the `error` event. `-q` still suppresses `progress` / `status` but
**always** emits `error` (and exit codes stay the same).

### List stories

Dump the `/stories` board to JSON:

```
./index.js list-stories --out stories.json
./index.js list-stories --start-page 1 --end-page 5 --sort new --delay 2
```

Options: `--out`/`-o`, `--start-page`, `--end-page`, `--sort`
(`new|active|hot|chapter|replies|like`), `--board` (default `stories`),
`--filter-key` (`all` or axis partition `rating:…` / `length:…` /
`status:…`), `--delay`, `--user-agent`, `--quiet`/`-q`, `--json-lines`/`-J`.

Each story object is the raw API payload plus a derived `url`.

Exit codes for `list-stories`:

| Code | Meaning                                                                                                                                                                        |
|------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 0    | Success (including empty `stories` on HTTP 200). Multi-page runs that hit board past-end (**404** / **524**) after at least one good page still write partial JSON and exit 0. |
| 1    | Generic error (network, other HTTP, bugs, usage).                                                                                                                              |
| 2    | No more pages: the first page of this invocation returned board past-end (**404** / **524**). No JSON is written.                                                              |

Story download / `--chat-only` still use only 0 / 1.

### User / review / node helpers

Single-shot public GETs. JSON on stdout (or `--out`); exit 0 on success, 1 on
error. Shared options: `--delay`, `--user-agent`, `--quiet`/`-q`,
`--json-lines`/`-J`, `--out`/`-o`.

User list commands take **`--user`** (alias **`--user-id`**): a **username or
user id**. Resolution: `GET /api/user/{token}` first (case-sensitive). Non-empty
profile → use `_id`; empty body → treat the token as a raw user id. List APIs
only accept ids; usernames must be resolved this way.

```
./index.js list-user-stories --user iwanttosee
./index.js list-user-stories --user-id Z3GksMYLsx6hqAJPi
./index.js list-user-following --user USER
./index.js list-user-followers --user USER   # server cap ~500
./index.js list-user-collections --user USER
./index.js get-user --user USER              # profile only
./index.js list-story-reviews --story-id STORY_ID
./index.js get-node --id NODE_ID
```

| Command                 | API                                     | Notes                                                    |
|-------------------------|-----------------------------------------|----------------------------------------------------------|
| `list-user-stories`     | `GET /api/anonkun/userStories/{id}`     | Resolves `--user`; stories get a derived `url`           |
| `list-user-following`   | `GET /api/anonkun/following/{id}`       | Resolves `--user`                                        |
| `list-user-followers`   | `GET /api/anonkun/followers/{id}`       | Resolves `--user`; hard cap ~500; `truncated` if ≥ 500   |
| `list-user-collections` | `GET /api/anonkun/userCollections/{id}` | Resolves `--user`; full `collection` lists + `story_ids` |
| `get-user`              | `GET /api/user/{username\|id}`          | Profile lookup; `found` false on empty body              |
| `list-story-reviews`    | `GET /api/anonkun/review/{id}`          | Story id only; full list (no preview gate)               |
| `get-node`              | `GET /api/node/{id}`                    | Hydrate unknown ids; story nodes include `url`           |

User-list responses include `user_input`, resolved `user_id`, `resolved_from`
(`username` \| `id`), and `username` when known, plus `{ scraped_at, …counts…,
data }` (`data` = raw API body; normalized `stories` / `users` / `collections`
when applicable).

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
and chronological `messages` from the main story chat API. Fetches use
the site’s threading chat mode (300 messages per `POST /api/chat/page`
request). Reply-to links (`ra`) and chapter anchors (`r`) are already on
each message; no separate replies tree is stored. Topic rooms use the
same shape under `topics/{id}/chat.json`. With `--no-chat`, `chat/` and
`topics/` are omitted. `--chat-only` writes only those trees plus
`images.json` (no `metadata.json` / `chapters.*`).

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

The extension popup supports ePub and full data archive. For archive
downloads, an **Include chat** checkbox controls main chat and topics
(on by default; ePub locks it off). Story listing and metadata-only
mode are CLI-only.

Icon from icons8.com
