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
let out_path = null;
// let user_agent = 'ficlivedl/0.2 (+https://github.com/alethiophile/ficlivedl)';
let user_agent = '';
let download_failed = false;

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
            if (bar !== null) {
                bar.stop();
                bar = null;
            }
            return;
        }
        if (state.error) {
            download_failed = true;
            console.error(state.error);
            return;
        }
        if (quiet) {
            return;
        }
        if (!title_shown && state.title) {
            console.error(`Found story: ${state.title}\n`);
            title_shown = true;
        }
        if (current_stage !== state.stage) {
            if (bar !== null) {
                bar.stop();
                bar = null;
            }
            console.error("\n" + state.stage);
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
    },
    save_file: async function (name, data) {
        let dest = out_path || name;
        await ensure_parent_dir(dest);
        await fs.writeFile(dest, data, {
            mode: 0o644,
        });
        if (!quiet) {
            console.error(`\nWrote ${dest}`);
        }
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
        if (!quiet) {
            console.error(`\nWrote directory ${dest} (${files.length} files)`);
        }
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

function build_parser() {
    return require('yargs/yargs')(process.argv.slice(2))
        .scriptName('ficlivedl')
        .usage('Usage: $0 <command> [options]\n       $0 [options] STORY_URL')
        .option('quiet', {
            alias: 'q',
            type: 'boolean',
            default: false,
            describe: 'Suppress progress and status messages (JSON on stdout still printed)'
        })
        .middleware((argv) => {
            quiet = !!argv.quiet;
            if (argv.userAgent) {
                user_agent = argv.userAgent;
            }
            download_failed = false;
            title_shown = false;
            current_stage = null;
            out_path = argv.out || null;
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
                .describe('file-type', "What type of file to write")
                .choices('file-type', ['archive', 'dir', 'epub', 'metadata'])
                .default('file-type', 'epub'),
            async (argv) => {
                let url = argv.url || (argv._ && argv._[0]);
                if (!url || typeof url !== 'string' || !url.startsWith('http')) {
                    console.error('You must provide a story URL');
                    process.exit(1);
                }
                let opts = {
                    url: url,
                    download_special: argv.appendices,
                    download_type: argv.fileType,
                    download_images: argv.images,
                    reader_posts: argv.writeins,
                    download_delay: argv.delay
                };
                try {
                    await ficlivedl.downloadStory(opts, funcs);
                }
                catch (e) {
                    download_failed = true;
                }
                if (download_failed) {
                    process.exit(1);
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
                }),
            async (argv) => {
                let result;
                try {
                    result = await ficlivedl.listStories({
                        board: argv.board,
                        start_page: argv.startPage,
                        end_page: argv.endPage,
                        sort: argv.sort,
                        download_delay: argv.delay
                    }, funcs);
                }
                catch (e) {
                    process.exit(1);
                }
                let text = JSON.stringify(result, null, 2);
                if (argv.out) {
                    await ensure_parent_dir(argv.out);
                    await fs.writeFile(argv.out, text, { mode: 0o644 });
                    if (!quiet) {
                        console.error(`\nWrote ${argv.out} (${result.story_count} stories)`);
                    }
                }
                else {
                    if (bar !== null) {
                        bar.stop();
                        bar = null;
                    }
                    process.stdout.write(text + '\n');
                }
            }
        )
        .help()
        .strict();
}

async function main() {
    let parser = build_parser();
    await parser.parse();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
