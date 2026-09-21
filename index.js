#!/usr/bin/env node
/* global require, process, Buffer */

let ficlivedl = require('./webextension/ficlivedl');
let progress = require('cli-progress');
let fs = require('node:fs/promises');
let path = require('node:path');
let http = require('http');
let https = require('https');

let current_stage = null;
let title_shown = false;
let bar = null;
let quiet = false;
let json_lines = false;
let out_path = null;
// let user_agent = 'ficlivedl/0.2 (+https://github.com/alethiophile/ficlivedl)';
let user_agent = '';
let download_failed = false;

// CLI exit codes (list-stories uses 2 for board past-end).
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NO_MORE_PAGES = 2;

function error_message(e) {
    if (e == null) {
        return String(e);
    }
    if (typeof e === 'string') {
        return e;
    }
    if (e.message) {
        return e.message;
    }
    if (typeof e.statusCode === 'number') {
        return 'HTTP ' + e.statusCode;
    }
    return String(e);
}

function error_stack(e) {
    if (e && typeof e.stack === 'string' && e.stack) {
        return e.stack;
    }
    return undefined;
}

function emit_json(obj) {
    console.error(JSON.stringify(obj));
}

function emit_error(message, stack) {
    download_failed = true;
    let msg = message == null ? '' : String(message);
    if (json_lines) {
        let ev = { type: 'error', message: msg };
        if (stack) {
            ev.stack = String(stack);
        }
        emit_json(ev);
        return;
    }
    // Human mode: prefer full stack when present (includes message).
    if (stack) {
        console.error(stack);
    }
    else {
        console.error(msg);
    }
}

function emit_error_from_exception(e) {
    emit_error(error_message(e), error_stack(e));
}

function emit_status(message, extra) {
    if (quiet) {
        return;
    }
    let msg = message == null ? '' : String(message);
    if (json_lines) {
        let ev = Object.assign({ type: 'status', message: msg }, extra || {});
        emit_json(ev);
        return;
    }
    console.error(msg);
}

function emit_done() {
    if (json_lines) {
        emit_json({ type: 'done' });
    }
    if (bar !== null) {
        bar.stop();
        bar = null;
    }
    current_stage = null;
}

function emit_progress_state(state) {
    if (json_lines) {
        if (quiet) {
            return;
        }
        let ev = { type: 'progress' };
        if (state.stage !== undefined) {
            ev.stage = state.stage;
        }
        if (state.done !== undefined) {
            ev.done = state.done;
        }
        if (state.total !== undefined) {
            ev.total = state.total;
        }
        if (state.title !== undefined) {
            ev.title = state.title;
        }
        emit_json(ev);
        return;
    }
    if (quiet) {
        return;
    }
    if (current_stage !== state.stage) {
        if (bar !== null) {
            bar.stop();
            bar = null;
        }
        console.error('\n' + state.stage);
        current_stage = state.stage;
        if (state.total) {
            bar = new progress.Bar({
                stream: process.stderr
            });
            bar.start(state.total, state.done || 0);
        }
    }
    if (bar !== null && state.done !== undefined) {
        bar.update(state.done);
    }
}

function request_promise(url, options = {}) {
    let method = options.method || 'GET';
    let body = options.body || null;
    let json = options.json !== false;
    let image = options.image || false;

    let mod;
    if (url.startsWith('https:')) {
        mod = https;
    }
    else if (url.startsWith('http:')) {
        mod = http;
    }
    else {
        throw new Error("invalid url: " + url);
    }

    let u = new URL(url);
    let headers = Object.assign({}, options.headers || {});
    if (!headers['user-agent'] && !headers['User-Agent'] && user_agent !== '') {
        headers['user-agent'] = user_agent;
    }
    let req_opts = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: method,
        headers: headers
    };
    if (body !== null) {
        req_opts.headers['content-type'] = req_opts.headers['content-type'] ||
            'application/x-www-form-urlencoded; charset=UTF-8';
        req_opts.headers['content-length'] = Buffer.byteLength(body);
    }

    return new Promise((resolve, reject) => {
        let req = mod.request(req_opts, (res) => {
            let all_data = null;
            if (json && !image) {
                res.setEncoding('utf8');
            }
            res.on('data', (chunk) => {
                if (all_data === null) {
                    all_data = chunk;
                }
                else {
                    if (Buffer.isBuffer(all_data)) {
                        all_data = Buffer.concat([all_data, chunk]);
                    }
                    else {
                        all_data = all_data + chunk;
                    }
                }
            });
            res.on('end', () => {
                if (!res.statusCode.toString().startsWith('2')) {
                    reject({
                        statusCode: res.statusCode,
                        body: all_data,
                        message: `HTTP ${res.statusCode} for ${method} ${url}`
                    });
                }
                else {
                    if (json && !image) {
                        if (all_data === null || all_data === '') {
                            all_data = null;
                        }
                        else {
                            all_data = JSON.parse(all_data);
                        }
                    }
                    resolve(all_data);
                }
            });
        });
        req.on('error', reject);
        if (body !== null) {
            req.write(body);
        }
        req.end();
    });
}

async function ensure_parent_dir(file_path) {
    let dir = path.dirname(file_path);
    if (dir && dir !== '.') {
        await fs.mkdir(dir, { recursive: true });
    }
}

let funcs = {
    signal_state: function (state) {
        if (state === null) {
            emit_done();
            return;
        }
        if (state.error) {
            emit_error(state.error, state.stack);
            return;
        }
        if (!json_lines && !quiet && !title_shown && state.title) {
            // Human "Found story" is separate from progress ticks.
            title_shown = true;
            console.error(`Found story: ${state.title}\n`);
        }
        else if (json_lines && !quiet && !title_shown && state.title) {
            title_shown = true;
            emit_status('Found story: ' + state.title, { title: state.title });
        }
        emit_progress_state(state);
    },
    save_file: async function (name, data) {
        let dest = out_path || name;
        await ensure_parent_dir(dest);
        await fs.writeFile(dest, data, {
            mode: 0o644,
        });
        emit_status('Wrote ' + dest, { path: dest });
    },
    save_dir: async function (name, files) {
        let dest = out_path || name;
        await fs.mkdir(dest, { recursive: true });
        for (let f of files) {
            let full = path.join(dest, f.name);
            await ensure_parent_dir(full);
            let content = f.content;
            if (typeof content === 'string' || Buffer.isBuffer(content)) {
                await fs.writeFile(full, content, { mode: 0o644 });
            }
            else if (content && typeof content.arrayBuffer === 'function') {
                let buf = Buffer.from(await content.arrayBuffer());
                await fs.writeFile(full, buf, { mode: 0o644 });
            }
            else {
                await fs.writeFile(full, Buffer.from(content), { mode: 0o644 });
            }
        }
        emit_status(
            'Wrote directory ' + dest + ' (' + files.length + ' files)',
            { path: dest, files: files.length }
        );
    },
    get_url: async function (url, image = false) {
        return request_promise(url, { method: 'GET', json: !image, image: image });
    },
    post_url: async function (url, fields) {
        let body = ficlivedl.encode_form(fields || {});
        return request_promise(url, {
            method: 'POST',
            body: body,
            json: true,
            headers: {
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'x-requested-with': 'XMLHttpRequest'
            }
        });
    },
    wait: async function (seconds) {
        await new Promise(r => setTimeout(r, seconds * 1000));
    }
};

function common_options(y) {
    return y
        .option('delay', {
            type: 'number',
            default: 0.5,
            describe: 'Seconds to wait between API requests'
        })
        .option('user-agent', {
            type: 'string',
            describe: 'HTTP User-Agent header'
        });
}

function user_list_options(y) {
    return common_options(y)
        .option('user', {
            alias: 'user-id',
            describe: 'User id or username (case-sensitive)',
            type: 'string',
            demandOption: true
        })
        .option('out', {
            alias: 'o',
            describe: 'Output JSON file (default: stdout)',
            type: 'string'
        });
}

function user_arg(argv) {
    // yargs: --user and alias --user-id both land on argv.user
    return argv.user || argv.userId;
}

function build_parser() {
    return require('yargs/yargs')(process.argv.slice(2))
        .scriptName('ficlivedl')
        .usage('Usage: $0 <command> [options]\n       $0 [options] STORY_URL')
        .option('quiet', {
            alias: 'q',
            type: 'boolean',
            default: false,
            describe:
                'Suppress progress and status messages (errors still emitted; '
                + 'JSON on stdout still printed)'
        })
        .option('json-lines', {
            alias: 'J',
            type: 'boolean',
            default: false,
            describe:
                'Emit progress/status/error as NDJSON on stderr (no progress bars; '
                + 'for machine consumers such as ficlive-archive)'
        })
        .middleware((argv) => {
            quiet = !!argv.quiet;
            json_lines = !!argv.jsonLines;
            if (argv.userAgent) {
                user_agent = argv.userAgent;
            }
            download_failed = false;
            title_shown = false;
            current_stage = null;
            out_path = argv.out || null;
            if (bar !== null) {
                bar.stop();
                bar = null;
            }
        })
        .command(
            '$0 [url]',
            'Download a story',
            (y) => common_options(y)
                .positional('url', {
                    describe: 'Story URL',
                    type: 'string'
                })
                .option('out', {
                    alias: 'o',
                    type: 'string',
                    describe: 'Output path (file for epub/archive/metadata; directory for dir)'
                })
                .boolean('no-appendices')
                .describe('no-appendices', "Omit appendix chapters")
                .default('appendices', true)
                .boolean('no-images')
                .describe('no-images', "Don't download images")
                .default('images', true)
                .boolean('no-writeins')
                .describe('no-writeins', "Don't include reader posts")
                .default('writeins', true)
                .boolean('no-chat')
                .describe('no-chat', 'Omit main chat and topics (archive/dir only)')
                .default('chat', true)
                .boolean('chat-only')
                .describe(
                    'chat-only',
                    'Write chat/topics (+ partial images.json) only; requires --out; implies no image binaries'
                )
                .describe('file-type', "What type of file to write")
                .choices('file-type', ['archive', 'dir', 'epub', 'metadata'])
                .default('file-type', 'epub'),
            async (argv) => {
                let url = argv.url || (argv._ && argv._[0]);
                if (!url || typeof url !== 'string' || !url.startsWith('http')) {
                    emit_error('You must provide a story URL');
                    process.exit(EXIT_ERROR);
                }
                if (argv.chatOnly) {
                    if (!argv.out) {
                        emit_error('--chat-only requires --out (directory)');
                        process.exit(EXIT_ERROR);
                    }
                    if (argv.chat === false) {
                        emit_error('--chat-only conflicts with --no-chat');
                        process.exit(EXIT_ERROR);
                    }
                    let opts = {
                        url: url,
                        download_images: false,
                        download_delay: argv.delay
                    };
                    try {
                        let story = ficlivedl.Story(opts, funcs);
                        await story.download_node();
                        await story.download_chat();
                        await story.download_topics();
                        story.collect_extra_images();
                        await story.generate_chat_archive_dir();
                        funcs.signal_state(null);
                    }
                    catch (e) {
                        // downloadStory path signals error itself; chat-only may not.
                        if (!download_failed) {
                            emit_error_from_exception(e);
                        }
                    }
                }
                else {
                    let opts = {
                        url: url,
                        download_special: argv.appendices,
                        download_type: argv.fileType,
                        download_images: argv.images,
                        download_chat: argv.chat !== false,
                        reader_posts: argv.writeins,
                        download_delay: argv.delay
                    };
                    try {
                        await ficlivedl.downloadStory(opts, funcs);
                    }
                    catch (e) {
                        // Library usually signal_state({error}); ensure we never stay silent.
                        if (!download_failed) {
                            emit_error_from_exception(e);
                        }
                    }
                }
                if (download_failed) {
                    process.exit(EXIT_ERROR);
                }
            }
        )
        .command(
            'list-stories',
            'List stories from the /stories board as JSON',
            (y) => common_options(y)
                .option('out', {
                    alias: 'o',
                    describe: 'Output JSON file (default: stdout)',
                    type: 'string'
                })
                .option('start-page', {
                    describe: 'First board page to fetch',
                    type: 'number',
                    default: 1
                })
                .option('end-page', {
                    describe: 'Last board page to fetch (omit to fetch until empty)',
                    type: 'number'
                })
                .option('sort', {
                    describe: 'Board sort order',
                    choices: ['new', 'active', 'hot', 'chapter', 'replies', 'like'],
                    default: 'new'
                })
                .option('board', {
                    describe: 'Board name',
                    type: 'string',
                    default: 'stories'
                })
                .option('filter-key', {
                    describe:
                        'Board filter partition: all | rating:teen|mature|nsfw|unrated | '
                        + 'length:Any|Short|Medium|Long|Epic | status:active|finished|hiatus',
                    type: 'string',
                    default: 'all'
                }),
            async (argv) => {
                let result;
                try {
                    result = await ficlivedl.listStories({
                        board: argv.board,
                        start_page: argv.startPage,
                        end_page: argv.endPage,
                        sort: argv.sort,
                        filter_key: argv.filterKey,
                        download_delay: argv.delay
                    }, funcs);
                }
                catch (e) {
                    // listStories already signal_state({error}); emit only if not.
                    if (!download_failed) {
                        emit_error_from_exception(e);
                    }
                    if (ficlivedl.is_board_eof_error(e)) {
                        // First page of this invocation was past end; no JSON.
                        process.exit(EXIT_NO_MORE_PAGES);
                    }
                    process.exit(EXIT_ERROR);
                }
                await write_json_result(argv, result, result.story_count + ' stories');
            }
        )
        .command(
            'list-user-stories',
            'List stories authored by a user as JSON (GET userStories)',
            (y) => user_list_options(y),
            async (argv) => {
                let result = await run_list_command(() =>
                    ficlivedl.listUserStories({
                        user: user_arg(argv),
                        download_delay: argv.delay
                    }, funcs)
                );
                await write_json_result(argv, result, result.story_count + ' stories');
            }
        )
        .command(
            'list-user-following',
            'List users followed by a user as JSON (GET following)',
            (y) => user_list_options(y),
            async (argv) => {
                let result = await run_list_command(() =>
                    ficlivedl.listUserFollowing({
                        user: user_arg(argv),
                        download_delay: argv.delay
                    }, funcs)
                );
                await write_json_result(argv, result, result.user_count + ' users');
            }
        )
        .command(
            'list-user-followers',
            'List followers of a user as JSON (GET followers; server cap ~500)',
            (y) => user_list_options(y),
            async (argv) => {
                let result = await run_list_command(() =>
                    ficlivedl.listUserFollowers({
                        user: user_arg(argv),
                        download_delay: argv.delay
                    }, funcs)
                );
                let summary = result.user_count + ' users'
                    + (result.truncated ? ' (truncated)' : '');
                await write_json_result(argv, result, summary);
            }
        )
        .command(
            'list-user-collections',
            'List a user\'s collections + story id lists as JSON (GET userCollections)',
            (y) => user_list_options(y),
            async (argv) => {
                let result = await run_list_command(() =>
                    ficlivedl.listUserCollections({
                        user: user_arg(argv),
                        download_delay: argv.delay
                    }, funcs)
                );
                await write_json_result(
                    argv,
                    result,
                    result.collection_count + ' collections, '
                        + result.story_id_count + ' story ids'
                );
            }
        )
        .command(
            'get-user',
            'Look up a user profile by username or id (GET /api/user/…)',
            (y) => user_list_options(y),
            async (argv) => {
                let result = await run_list_command(() =>
                    ficlivedl.getUserProfile({ user: user_arg(argv) }, funcs)
                );
                let summary = result.found
                    ? (result.username || result.user_id)
                    : 'not found';
                await write_json_result(argv, result, summary);
            }
        )
        .command(
            'list-user-achievements',
            'List a user\'s achievements, all pages, as JSON '
                + '(GET profile/achievements/{id}/{page})',
            (y) => user_list_options(y),
            async (argv) => {
                let result = await run_list_command(() =>
                    ficlivedl.listUserAchievements({
                        user: user_arg(argv),
                        download_delay: argv.delay
                    }, funcs)
                );
                let summary = result.entry_count + ' entries / '
                    + result.page_count + ' pages';
                if (result.page_errors && result.page_errors.length) {
                    summary += ' (skipped: '
                        + result.page_errors
                            .map((pe) => 'page ' + pe.page)
                            .join(', ')
                        + ')';
                }
                await write_json_result(argv, result, summary);
            }
        )
        .command(
            'list-story-reviews',
            'List reviews for a story as JSON (GET review/{storyId})',
            (y) => common_options(y)
                .option('story-id', {
                    describe: 'Story id',
                    type: 'string',
                    demandOption: true
                })
                .option('out', {
                    alias: 'o',
                    describe: 'Output JSON file (default: stdout)',
                    type: 'string'
                }),
            async (argv) => {
                let result = await run_list_command(() =>
                    ficlivedl.listStoryReviews({ story_id: argv.storyId }, funcs)
                );
                await write_json_result(argv, result, result.review_count + ' reviews');
            }
        )
        .command(
            'list-reviews',
            'List main site reviews feed as JSON (POST filteredReviews)',
            (y) => common_options(y)
                .option('last-ct', {
                    describe:
                        'Cursor: reviews with ut <= this ms timestamp '
                        + '(omit for newest page; inclusive)',
                    type: 'number'
                })
                .option('out', {
                    alias: 'o',
                    describe: 'Output JSON file (default: stdout)',
                    type: 'string'
                }),
            async (argv) => {
                let result = await run_list_command(() =>
                    ficlivedl.listReviews(
                        { last_ct: argv.lastCt },
                        funcs
                    )
                );
                await write_json_result(
                    argv,
                    result,
                    result.review_count + ' reviews / ' + result.story_count + ' stories'
                );
            }
        )
        .command(
            'get-node',
            'Fetch a node by id as JSON (GET /api/node/{id})',
            (y) => common_options(y)
                .option('id', {
                    describe: 'Node id',
                    type: 'string',
                    demandOption: true
                })
                .option('out', {
                    alias: 'o',
                    describe: 'Output JSON file (default: stdout)',
                    type: 'string'
                }),
            async (argv) => {
                let result = await run_list_command(() =>
                    ficlivedl.getNode({ node_id: argv.id }, funcs)
                );
                let summary = result.nt ? ('nt=' + result.nt) : 'node';
                await write_json_result(argv, result, summary);
            }
        )
        .help()
        .strict();
}

async function run_list_command(fn) {
    try {
        return await fn();
    }
    catch (e) {
        // Library may already have signal_state({error}); avoid duplicate emit.
        if (!download_failed) {
            emit_error_from_exception(e);
        }
        process.exit(EXIT_ERROR);
    }
}

async function write_json_result(argv, result, summary) {
    let text = JSON.stringify(result, null, 2);
    if (argv.out) {
        await ensure_parent_dir(argv.out);
        await fs.writeFile(argv.out, text, { mode: 0o644 });
        emit_status('Wrote ' + argv.out + ' (' + summary + ')', {
            path: argv.out,
            summary: summary
        });
    }
    else {
        if (bar !== null) {
            bar.stop();
            bar = null;
        }
        process.stdout.write(text + '\n');
    }
}

async function main() {
    let parser = build_parser();
    await parser.parse();
}

main().catch((e) => {
    emit_error_from_exception(e);
    process.exit(EXIT_ERROR);
});
