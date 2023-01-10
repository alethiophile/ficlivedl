#!/usr/bin/env node
/* global require, process, Buffer */

let ficlivedl = require('./webextension/ficlivedl');
let argv = require('yargs/yargs')(process.argv.slice(2))
    .usage('Usage: $0 [options] STORY_URL')
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
    .choices('file-type', ['archive', 'epub'])
    .default('file-type', 'epub')
    .demandCommand(1, "You must provide a story URL")
    .argv;
let progress = require('cli-progress');
let fs = require('node:fs/promises');
let http = require('http');
let https = require('https');

let current_stage = null;
let title_shown = false;
let bar = null;

function download_promise(url, json = false) {
    let mod;
    if (url.startsWith('https:')) {
        mod = https;
    }
    else if (url.startsWith('http:')) {
        mod = http;
    }
    else {
        throw new Error("invalid url: " + url)
    }

    return new Promise((resolve, reject) => {
        mod.get(url, (res) => {
            let all_data = null;
            if (json) {
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
                        body: all_data
                    });
                }
                else {
                    if (json) {
                        all_data = JSON.parse(all_data);
                    }
                    resolve(all_data);
                }
            });
        });
    });
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
            console.error(state.error);
            return;
        }
        if (!title_shown && state.title) {
            console.log(`Found story: ${state.title}\n`);
            title_shown = true;
        }
        if (current_stage !== state.stage) {
            console.log("\n" + state.stage);
            current_stage = state.stage;
            if (state.total) {
                if (bar !== null) {
                    bar.stop();
                }
                bar = new progress.Bar();
                bar.start(state.total, state.done);
            }
        }
        if (bar !== null && state.done !== undefined) {
            bar.update(state.done);
        }
    },
    save_file: async function (name, data) {
        await fs.writeFile(name, data, {
            mode: 0o644,
        });
    },
    get_url: async function (url, image = false) {
        return download_promise(url, !image);
    },
    wait: async function (seconds) {
        await new Promise(r => setTimeout(r, seconds * 1000));
    }
};

// console.log(argv, argv._);
let opts = {
    url: argv._[0],
    download_special: argv.appendices,
    download_type: argv.fileType,
    download_images: argv.images,
    reader_posts: argv.writeins
};


ficlivedl.downloadStory(opts, funcs);
