/* global require, process, exports */

// This is the common scraper logic for ficlivedl. It's meant to work
// both in the browser and on the node command line, so the entry
// point accepts a `funcs` parameter with functions the code will use
// for HTTP downloads, progress updates, and providing the final file.

let nodepub = require('nodepub');
let sanitizeHtml = require('sanitize-html');
let JSZip = require('jszip');

// Site chat UI uses 30/page normally; threading mode returns 300/page.
// POST /api/chat/page honors threading:true at 300; other size knobs are ignored.
const CHAT_POSTS_PER_PAGE = 300;
const TOPIC_PAGE_SIZE = 30;
const API_BASE = 'https://fiction.live';

function is_node() {
    return (typeof process !== 'undefined') &&
        (typeof process.release !== 'undefined') &&
        (process.release.name === 'node');
}

let $;
if (is_node()) {
    let jsdom = require('jsdom');
    let dom = new jsdom.JSDOM();
    global.document = (new jsdom.JSDOM('')).window.document
    $ = require('jquery')(dom.window);
}
else {
    $ = require('jquery');
}

function url_basename(url) {
    try {
        let u = new URL(url);
        let basename = u.pathname.split('/').filter(Boolean).at(-1);
        return basename || '';
    }
    catch (e) {
        return '';
    }
}

function split_basename(basename) {
    let bn = basename || 'image';
    // strip query-like junk if any slipped through
    bn = bn.split('?')[0].split('#')[0];
    bn = bn.replace(/[/\\]/g, '_');
    if (!bn || bn === '.' || bn === '..') {
        bn = 'image';
    }
    let m = bn.match(/^(.*?)(\.[A-Za-z0-9]{1,8})?$/);
    let root = (m && m[1]) ? m[1] : bn;
    let ext = (m && m[2]) ? m[2] : '';
    if (!root) {
        root = 'image';
    }
    return { root: root, ext: ext };
}

// Per-story map: final image URL -> stable local filename.
// Basename first; collisions with a different URL get root.2.ext, root.3.ext, …
function ImageRegistry() {
    let url_to_name = new Map();
    let claimed_names = new Map(); // localName -> finalUrl
    let cover_url = null;

    function register(url) {
        if (!url || typeof url !== 'string') {
            return null;
        }
        let final_url = process_image_url(url);
        if (!final_url) {
            return null;
        }
        if (url_to_name.has(final_url)) {
            return url_to_name.get(final_url);
        }
        let base = url_basename(final_url) || 'image';
        let { root, ext } = split_basename(base);
        let n = 1;
        let name;
        for (;;) {
            name = (n === 1) ? (root + ext) : (root + '.' + n + ext);
            let owner = claimed_names.get(name);
            if (owner === undefined || owner === final_url) {
                break;
            }
            n = n + 1;
        }
        claimed_names.set(name, final_url);
        url_to_name.set(final_url, name);
        return name;
    }

    function register_cover(url) {
        let name = register(url);
        if (name) {
            cover_url = process_image_url(url);
        }
        return name;
    }

    function entries() {
        let out = [];
        for (let [url, name] of url_to_name) {
            out.push({ url: url, name: name });
        }
        return out;
    }

    function to_json() {
        let obj = {
            scraped_at: new Date().toISOString(),
            images: entries()
        };
        if (cover_url && url_to_name.has(cover_url)) {
            obj.cover = {
                url: cover_url,
                name: url_to_name.get(cover_url)
            };
        }
        return obj;
    }

    return {
        register: register,
        register_cover: register_cover,
        entries: entries,
        to_json: to_json,
        get_name: function (url) {
            let final_url = process_image_url(url);
            return url_to_name.get(final_url) || null;
        },
        get cover_url() {
            return cover_url;
        },
        get size() {
            return url_to_name.size;
        }
    };
}

function to_filename(str) {
    return str.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]+/g, '');
}

function slugify_title(str) {
    if (!str) {
        return 'story';
    }
    return String(str)
        .replace(/['’]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-') || 'story';
}

function story_page_url(title, id) {
    return `${API_BASE}/stories/${slugify_title(title)}/${id}`;
}

function count_words(html) {
    // Counts the words in an HTML string. First strips out all HTML tags, then
    // counts remaining whitespace-delimited words.
    let s = html.replace(/<[^>]+>/g, ' ');
    let a = s.split(/\s+/);
    return a.length;
}

// it turns out Apple Books is fucking autistic about having tags closed even
// when it's completely semantically meaningless
// lrn2html
function fix_html_tags(html) {
    html = html.replace(/<img([^>]+[^>/])?>/g, "<img$1 />");
    html = html.replace(/<hr([^>]*[^/>])?>/g, "<hr$1 />");
    html = html.replace(/<br([^>]*[^/>])?>/g, "<br$1 />");
    return html
}

function escape_html(txt) {
    return txt
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

// Serialize { ...meta, [array_key]: array } without JSON.stringify on the whole
// value. Megachat rooms exceed V8's max string length; per-element stringify
// + Blob/Buffer parts stays under that limit. Same shape on disk either way.
function json_with_array_content(meta, array_key, array) {
    let head = '{';
    let first = true;
    for (let k of Object.keys(meta)) {
        first = false;
        head += JSON.stringify(k) + ':' + JSON.stringify(meta[k]) + ',';
    }
    head += JSON.stringify(array_key) + ':[';

    let parts = [head];
    for (let i = 0; i < array.length; i++) {
        if (i > 0) {
            parts.push(',');
        }
        parts.push(JSON.stringify(array[i]));
    }
    parts.push(']}');

    if (typeof Blob !== 'undefined') {
        return new Blob(parts, { type: 'application/json' });
    }
    return Buffer.concat(parts.map(p => Buffer.from(p, 'utf8')));
}

// the fiction.live frontend script does a bunch of manual transforms
// on the image URLs the API ships out before actually fetching them;
// this is incredibly stupid but there you go
// Mirrors ty.imageURLParser full-size path (and FanFicFare's img_url_trans):
// cloudfront / filepicker / cdn3|cdn4 -> cdn6; already-final cdn6 URLs stay put.
function process_image_url(url) {
    if (!url || typeof url !== 'string') {
        return url;
    }
    if (url.startsWith('//')) {
        url = 'https:' + url;
    }
    url = url.replace(/(\w+)\.cloudfront\.net/g, 'cdn6.fiction.live/file/fictionlive');
    url = url.replace(/www\.filepicker\.io\/api\/file\/(\w+)/g, 'cdn4.fiction.live/fp/$1');
    url = url.replace(/cdn[34]\.fiction\.live\/(.+)/g, 'cdn6.fiction.live/file/fictionlive/$1');
    return url;
}

// 1x1 PNG used when cover download fails (nodepub requires a cover image)
function placeholder_cover_blob() {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(b64, 'base64');
    }
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        arr[i] = bin.charCodeAt(i);
    }
    return new Blob([arr], { type: 'image/png' });
}

function encode_form(fields) {
    let parts = [];
    for (let key of Object.keys(fields)) {
        let val = fields[key];
        if (val === undefined || val === null) {
            continue;
        }
        if (Array.isArray(val)) {
            for (let item of val) {
                parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(item));
            }
        }
        else if (typeof val === 'boolean') {
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(val ? 'true' : 'false'));
        }
        else {
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(val)));
        }
    }
    return parts.join('&');
}

function add_image_url(into_set, url) {
    if (!url || typeof url !== 'string') {
        return;
    }
    let u = process_image_url(url);
    if (u) {
        into_set.add(u);
    }
}

function collect_images_from_html(html, into_set) {
    if (!html || typeof html !== 'string' || html.indexOf('<img') === -1) {
        return;
    }
    let $dom = $(`<div>${html}</div>`);
    $dom.find('img').each(function () {
        let src = $(this).attr('src');
        add_image_url(into_set, src);
    });
}

function collect_images_from_node(node, into_set) {
    if (!node || typeof node !== 'object') {
        return;
    }
    if (typeof node.b === 'string') {
        collect_images_from_html(node.b, into_set);
    }
    if (node.i) {
        if (Array.isArray(node.i)) {
            for (let u of node.i) {
                add_image_url(into_set, u);
            }
        }
        else if (typeof node.i === 'string') {
            add_image_url(into_set, node.i);
        }
    }
    if (node.lr) {
        collect_images_from_node(node.lr, into_set);
    }
    if (node.ra && typeof node.ra === 'object') {
        if (typeof node.ra.b === 'string') {
            collect_images_from_html(node.ra.b, into_set);
        }
    }
}

function collect_images_from_nodes(nodes, into_set) {
    if (!nodes) {
        return;
    }
    for (let n of nodes) {
        collect_images_from_node(n, into_set);
    }
}

function dedupe_by_id(items) {
    let seen = new Set();
    let out = [];
    for (let item of items) {
        if (!item || typeof item !== 'object') {
            out.push(item);
            continue;
        }
        let id = item._id;
        if (!id) {
            out.push(item);
            continue;
        }
        if (seen.has(id)) {
            continue;
        }
        seen.add(id);
        out.push(item);
    }
    return out;
}

function Story(opts, funcs) {
    let signal_state = funcs.signal_state;
    let get_url = funcs.get_url;
    let post_url = funcs.post_url;
    let image_registry = ImageRegistry();
    function chapter_url(story_id, start, end) {
        return `${API_BASE}/api/anonkun/chapters/${story_id}/${start}/${end}`;
    }

    function sanitize_chapter_html(html) {
        return sanitizeHtml(html, {
            allowedTags: sanitizeHtml.defaults.allowedTags.concat([ 'img' ])
        });
    }

    function process_chapter_title(t) {
        let ctitle = t;
        if (ctitle.startsWith('#special ')) {
            ctitle = ctitle.replace('#special ', 'Appendix: ');
        }
        return ctitle;
    }

    // This takes a chapter object that has been downloaded (i.e. has
    // a data member), processes the HTML of all entries, and creates
    // html and images members on the object. Also responsible for
    // rendering votes, user prompts, etc as HTML.
    function process_html(chapter) {
        let images = [];
        let all_html = [];
        for (let e of chapter.data) {
            // sometimes a request will include extraneous entries
            // from different chapters
            if ('t' in e && e.t !== "" && e.t !== chapter.metadata.title) {
                continue;
            }
            if (e.nt === 'chapter') {
                let html = sanitize_chapter_html(e.b);
                html = `<div class="chapter">${html}</div>`;
                let $dom = $(html);
                $dom.find('img').each(function () {
                    let $this = $(this);
                    let src = $this.attr('src');
                    if (src === undefined) {
                        return;
                    }
                    let name = image_registry.register(src);
                    if (!name) {
                        return;
                    }
                    let final_url = process_image_url(src);
                    images.push(final_url);
                    $this.attr('src', '../images/' + name);
                });
                if (opts.download_images) {
                    $dom.find('figure').find('img').unwrap();
                    $dom.find('img').wrap(`<div class="imgwrap"></div>`);
                } else {
                    // Strip images from rendered HTML (ePub and archive
                    // chapter HTML). Original placement remains in
                    // chapters.json; images.json holds url↔name for fill-in.
                    $dom.find('figure').remove();
                    $dom.find('img').remove();
                }
                html = $dom.prop('outerHTML');

                all_html.push(fix_html_tags(html));
            }
            else if (e.nt === 'readerPost') {
                if (!opts.reader_posts) {
                    continue;
                }
                let title = 'b' in e ? e.b : 'Reader Posts';
                let html = `<h3>${escape_html(title)}</h3>`;
                let votes = 'votes' in e ? Object.getOwnPropertyNames(e.votes) : [];
                let dice = {};
                if ('dice' in e) {
                    Object.assign(dice, e.dice);
                }
                let entries = [];
                for (let k of votes) {
                    let vote = e.votes[k];
                    if (typeof vote !== 'string') {
                        continue;
                    }
                    let ent_html = `<p>${escape_html(vote)}</p>`;
                    if (k in dice) {
                        ent_html = `<div class="dice">${dice[k]}</div>` + ent_html;
                        delete dice[k];
                    }
                    entries.push(ent_html);
                }
                for (let k in dice) {
                    entries.push(`<div class="dice">${dice[k]}</div>`);
                }
                html += entries.join('<hr />');
                html = `<div class="readerVote">${html}</div>`;
                all_html.push(fix_html_tags(html));
            }
            else if (e.nt === 'choice') {
                let title = 'b' in e ? e.b : 'Choices';
                let html = `<h3>${title}</h3>`;
                let votes = e.choices.map(x => { return { vote: x, count: 0, xout: false }; });
                let xout = 'xOut' in e ? e.xOut : [];
                let reasons = 'xOutReasons' in e ? e.xOutReasons : {};
                for (let k in e.votes) {
                    if (Array.isArray(e.votes[k])) {
                        for (let v of e.votes[k]) {
                            if (votes[v] !== undefined) {
                                votes[v].count += 1;
                            }
                        }
                    }
                    else {
                        if (votes[e.votes[k]] !== undefined) {
                            votes[e.votes[k]].count += 1;
                        }
                    }
                }
                for (let i of xout) {
                    votes[i].xout = true;
                }
                for (let i in reasons) {
                    votes[i].reason = reasons[i];
                }
                votes.sort((a, b) => b.count - a.count);
                votes.sort((a, b) => a.xout - b.xout);
                for (let v of votes) {
                    if (!v.xout) {
                        html += `<div class="vote"><div class="voteText">${escape_html(v.vote)}</div><span class="voteCount">${v.count}</span></div>`;
                    } else {
                        html += `<div class="vote"><div class="voteText"><s>${escape_html(v.vote)}</s>`;
                        if ('reason' in v) {
                            html += `<br />${escape_html(v.reason)}`;
                        }
                        html += '</div></div>';
                    }
                }
                html = `<div class="voteChapter">${html}</div>`;
                all_html.push(fix_html_tags(html));
            }
        }
        let ctitle = process_chapter_title(chapter.metadata.title);
        chapter.html = `<h2>${escape_html(ctitle)}</h2>` + all_html.join('<hr />');
        chapter.images = images;
        chapter.words = count_words(chapter.html);
    }

    function get_node_id(url) {
        const storyUrlRe = new RegExp('^https://fiction.live/stories/[^/]+/(\\w+)/?');
        let res = url.match(storyUrlRe);
        if (res === null) {
            return;
        }
        let nodeId = res[1];
        return nodeId;
    }

    function format_date(d) {
        return new Intl.DateTimeFormat('en-US', {
            dateStyle: 'medium', timeStyle: 'long',
            timeZone: 'UTC', hour12: false
        }).format(d);
    }

    async function fetch_with_retry(do_fetch, delay) {
        let tries = 3;
        while (tries > 0) {
            try {
                return await do_fetch();
            }
            catch (e) {
                tries -= 1;
                if (tries <= 0) {
                    throw e;
                }
                await funcs.wait(delay * 4);
            }
        }
    }

    return {
        node_id: get_node_id(opts.url),
        download_delay: (opts.download_delay != null) ? opts.download_delay : 0.5,
        node_metadata: null,
        chat_archive: null,
        topics_archive: null,
        image_registry: image_registry,
        cover_name: null,
        // This method returns this story's node URL in the API
        node_url: function () {
            return `${API_BASE}/api/node/${this.node_id}`;
        },
        // This method downloads the node info, returning a promise
        download_node: function () {
            let url = this.node_url();
            signal_state({ 'stage': 'Getting metadata' });
            return get_url(url).then((data) => {
                if (!data || typeof data !== 'object' || !data._id) {
                    throw new Error('Story node not found or empty response');
                }
                this.node_metadata = data;
                if (opts.download_type !== 'metadata') {
                    this.set_chapter_urls();
                }
                return data;
            });
        },
        story_url: function () {
            let re = /^https:\/\/fiction.live\/stories\/[^/]+\/[^/]+\/?/;
            let match = opts.url.match(re);
            if (match) {
                return match[0];
            }
            return story_page_url(this.title(), this.node_id);
        },
        title: function () {
            return this.node_metadata.t;
        },
        author: function () {
            return this.node_metadata.u[0].n;
        },
        tags: function () {
            let ta = this.node_metadata.ta || [];
            let spoiler = this.node_metadata.spoilerTags || [];
            return [...new Set(ta.concat(spoiler))];
        },
        words: function () {
            return this.chapters.map(c => c.words).reduce((a, b) => a + b, 0);
        },
        date_published: function () {
            return new Date(this.node_metadata.ct);
        },
        date_updated: function () {
            return new Date(this.node_metadata.cht);
        },
        set_chapter_urls: function () {
            if (this.node_metadata === null) {
                return false;
            }
            let chapters = [];
            // this must be a string because it's too big for the JS
            // numeric type
            let final_number = '9999999999999998';
            let bm = this.node_metadata.bm || [];
            let num_chapters = bm.length;
            // Stories with no bookmarks still have chapter content; fetch the
            // full range as a single synthetic chapter.
            if (num_chapters === 0) {
                chapters.push({
                    metadata: {
                        title: this.node_metadata.t || 'Story',
                        id: this.node_id,
                        ct: this.node_metadata.ct || 0
                    },
                    special: false,
                    url: chapter_url(this.node_id, 0, final_number)
                });
                this.chapters = chapters;
                return true;
            }
            let first = 1;
            // what is even up with this overly complicated URL algo
            for (let i = 0; i < num_chapters; i++) {
                let item = {};
                item.metadata = bm[i];
                let start = item.metadata.ct;
                if (first) {
                    start = 0;
                    first = 0;
                }
                item.special = item.metadata.title.startsWith('#special');
                let end;
                if (item.special) {
                    end = start + 1;
                }
                else if (i + 1 >= num_chapters || bm[i + 1].title.startsWith('#special')) {
                    end = final_number;
                }
                else {
                    end = bm[i + 1].ct - 1;
                }
                item.url = chapter_url(this.node_id, start, end);
                chapters.push(item);
            }
            this.chapters = chapters;
            return true;
        },
        download_chapters: async function () {
            let num_downloaded = 0;
            let total_to_download = this.chapters.filter(x => (opts.download_special || !x.special)).length;
            let node_md = this.node_metadata;
            for (let c of this.chapters) {
                if (!opts.download_special && c.special) {
                    continue;
                }
                signal_state({
                    'title': node_md.t,
                    'stage': 'Fetching chapters',
                    'done': num_downloaded,
                    'total': total_to_download
                });
                let u = c.url;
                let data = await fetch_with_retry(() => get_url(u), this.download_delay);
                let wait_until = Date.now() + this.download_delay * 1000;
                c.data = data;
                num_downloaded += 1;
                process_html(c);
                let wait_time = Math.max(wait_until - Date.now(), 0);
                await funcs.wait(wait_time / 1000)
            }
            return;
        },
        // Download full chat history for a room id (story or topic).
        // Main chat/page already includes reply-to links (ra) and chapter
        // anchors (r); no per-message light/page fetches.
        // Uses site threading mode (300 msgs/page) via threading:true.
        // Seed CT window from /latest (not /threading) — seeding from the
        // threading endpoint with cpr=final returns empty pages.
        // Returns { messages, count, pages, message_count }.
        download_chat_room: async function (room_id, stage_label, title) {
            let delay = this.download_delay;
            // signal_state({
            //     'title': title,
            //     'stage': stage_label
            // });
            let latest = await fetch_with_retry(
                () => get_url(`${API_BASE}/api/chat/${room_id}/latest`),
                delay
            );
            if (!Array.isArray(latest) || latest.length === 0) {
                return {
                    messages: [],
                    count: 0,
                    pages: 0,
                    message_count: 0
                };
            }

            let pages_info = await fetch_with_retry(
                () => post_url(`${API_BASE}/api/chat/pages`, { r: room_id }),
                delay
            );
            let total_posts = (pages_info && pages_info.count) ? pages_info.count : latest.length;
            let final_page = Math.max(1, Math.ceil(total_posts / CHAT_POSTS_PER_PAGE));

            // Seed CT window from latest (site pager does this when leaving live view).
            let sorted_latest = latest.slice().sort((a, b) => (a.ct || 0) - (b.ct || 0));
            let page_post_data = {
                r: room_id,
                lastCT: sorted_latest[sorted_latest.length - 1].ct,
                firstCT: sorted_latest[0].ct,
                cpr: final_page,
                threading: true
            };

            let chat = [];
            for (let page_index = 1; page_index <= final_page; page_index++) {
                signal_state({
                    'title': title,
                    'stage': stage_label,
                    'done': page_index - 1,
                    'total': final_page
                });
                page_post_data.page = page_index;
                let posts;
                try {
                    posts = await fetch_with_retry(
                        () => post_url(`${API_BASE}/api/chat/page`, page_post_data),
                        delay
                    );
                }
                catch (e) {
                    chat.push({
                        failedToRetrieveChatPage: true,
                        postsPerPage: CHAT_POSTS_PER_PAGE,
                        pageIndex: page_index,
                        error: e && e.message ? e.message : String(e)
                    });
                    await funcs.wait(delay);
                    continue;
                }
                if (!Array.isArray(posts)) {
                    posts = [];
                }
                chat.push(...posts);
                if (posts.length) {
                    let ordered = posts.slice().sort((a, b) => (a.ct || 0) - (b.ct || 0));
                    page_post_data.lastCT = ordered[ordered.length - 1].ct;
                    page_post_data.firstCT = ordered[0].ct;
                    page_post_data.cpr = page_index;
                }
                await funcs.wait(delay);
            }

            // Latest window may not be fully covered by page walk; merge it in.
            chat.push(...latest);
            chat = dedupe_by_id(chat);
            chat.sort((a, b) => (a.ct || 0) - (b.ct || 0));

            signal_state({
                'title': title,
                'stage': stage_label,
                'done': final_page,
                'total': final_page
            });

            return {
                messages: chat,
                count: total_posts,
                pages: final_page,
                message_count: chat.filter(m => m && m._id).length
            };
        },
        download_chat: async function () {
            let title = this.title();
            this.chat_archive = await this.download_chat_room(
                this.node_id,
                'Fetching chat',
                title
            );
        },
        download_topics: async function () {
            let title = this.title();
            let delay = this.download_delay;
            let story_id = this.node_id;

            signal_state({
                'title': title,
                'stage': 'Fetching topics'
            });

            let pages_info = await fetch_with_retry(
                () => get_url(`${API_BASE}/api/thread/${story_id}/pages`),
                delay
            );
            let topic_count = (pages_info && pages_info.count) ? pages_info.count : 0;
            let page_count = Math.max(1, Math.ceil(topic_count / TOPIC_PAGE_SIZE));
            if (topic_count === 0) {
                page_count = 1;
            }

            let index = [];
            for (let page = 1; page <= page_count; page++) {
                signal_state({
                    'title': title,
                    'stage': 'Fetching topics',
                    'done': page - 1,
                    'total': page_count
                });
                let batch = await fetch_with_retry(
                    () => get_url(`${API_BASE}/api/thread/${story_id}/${page}/${TOPIC_PAGE_SIZE}`),
                    delay
                );
                if (!Array.isArray(batch) || batch.length === 0) {
                    if (page === 1) {
                        break;
                    }
                    break;
                }
                index.push(...batch);
                if (batch.length < TOPIC_PAGE_SIZE) {
                    break;
                }
                await funcs.wait(delay);
            }
            index = dedupe_by_id(index);

            let topics = [];
            let ti = 0;
            for (let topic of index) {
                ti += 1;
                signal_state({
                    'title': title,
                    'stage': 'Fetching topics',
                    'done': ti - 1,
                    'total': index.length
                });
                let topic_id = topic._id;
                let node = topic;
                try {
                    node = await fetch_with_retry(
                        () => get_url(`${API_BASE}/api/node/${topic_id}`),
                        delay
                    );
                }
                catch (e) {
                    // keep list stub
                }
                await funcs.wait(delay);

                let chat = await this.download_chat_room(
                    topic_id,
                    `Fetching topics`,
                    title
                );

                topics.push({
                    id: topic_id,
                    list_entry: topic,
                    node: node,
                    chat: chat
                });
            }

            this.topics_archive = {
                count: topic_count,
                index: index,
                topics: topics
            };
        },
        collect_extra_images: function () {
            let urls = new Set();
            if (this.chat_archive) {
                collect_images_from_nodes(this.chat_archive.messages, urls);
            }
            if (this.topics_archive) {
                for (let t of this.topics_archive.topics || []) {
                    collect_images_from_node(t.node, urls);
                    collect_images_from_node(t.list_entry, urls);
                    if (t.chat) {
                        collect_images_from_nodes(t.chat.messages, urls);
                    }
                }
            }
            for (let u of urls) {
                this.image_registry.register(u);
            }
            if (this.node_metadata && this.node_metadata.i && this.node_metadata.i[0]) {
                this.image_registry.register_cover(this.node_metadata.i[0]);
            }
        },
        ensure_cover_registered: function () {
            if (this.node_metadata && this.node_metadata.i && this.node_metadata.i[0]) {
                this.cover_name = this.image_registry.register_cover(this.node_metadata.i[0]);
            }
        },
        download_images: async function () {
            // This function relies on all the images being under domains that
            // ficlivedl has permissions for. Currently the images are hosted at
            // cdn*.fiction.live, and the extension has permissions for
            // *.fiction.live. However, this has been different in the past, so
            // if the image hosting changes again then the extension may break.
            this.story_images = [];
            let entries = this.image_registry.entries();
            // Cover is fetched in download_cover; skip duplicate binary fetch
            // here when it will be stored as the root cover file only for ePub
            // path — for archive we also put cover under images/ via story_images
            // if it's in the registry. Always download all registry entries.
            this.total_story_images = entries.length;
            let num_downloaded = 0;
            all_images: for (let entry of entries) {
                signal_state({
                    'title': this.title(),
                    'stage': 'Fetching images',
                    'done': num_downloaded,
                    'total': entries.length + 1
                });
                let tries = 3;
                let data;
                while (tries > 0) {
                    try {
                        data = await get_url(entry.url, true);
                    }
                    catch (e) {
                        console.log(e, tries);
                        tries -= 1;
                        if (tries <= 0) {
                            num_downloaded += 1;
                            continue all_images;
                        }
                        await funcs.wait(this.download_delay * 4);
                        continue;
                    }
                    break;
                }
                num_downloaded += 1;
                this.story_images.push({
                    name: entry.name,
                    content: data,
                    url: entry.url
                });
            }
            return;
        },
        download_cover: async function () {
            this.ensure_cover_registered();
            let is_archive = opts.download_type === 'archive' || opts.download_type === 'dir';
            signal_state({
                'title': this.title(),
                'stage': 'Fetching images',
                'done': this.total_story_images || 0,
                'total': (this.total_story_images || 0) + 1
            });

            // Archive/dir with --no-images: skip CDN cover fetch; images.json
            // still records the cover URL for a later fill-in.
            if (is_archive && !opts.download_images) {
                this.cover = null;
                return;
            }

            if (this.cover_name && this.image_registry.cover_url) {
                // Reuse binary if download_images already fetched this URL
                let existing = (this.story_images || []).find(
                    i => i.url === this.image_registry.cover_url || i.name === this.cover_name
                );
                if (existing && existing.content) {
                    this.cover = {
                        name: this.cover_name,
                        content: existing.content
                    };
                    return;
                }
                try {
                    let data = await get_url(this.image_registry.cover_url, true);
                    this.cover = {
                        name: this.cover_name,
                        content: data
                    };
                    return;
                }
                catch (e) {
                    // fall through to embedded placeholder for ePub
                }
            }
            // nodepub requires a cover; use embedded 1x1 PNG if missing/failed
            this.cover = {
                name: 'cover.png',
                content: placeholder_cover_blob()
            };
        },
        make_title_page: function () {
            let desc = `<p>${this.node_metadata.d}</p><p>${this.node_metadata.b || ''}</p>`
            let res = `<h1>${this.title()}</h1>

<h2>by ${this.author()}</h2>

<b>Published:</b> ${format_date(this.date_published())}<br />
<b>Updated:</b> ${format_date(this.date_updated())}<br />
<b>Words:</b> ${Intl.NumberFormat('en-US').format(this.words())}<br />
<b>Tags:</b> ${this.tags().join(', ')}<br />
<b>Source:</b> <a href="${this.story_url()}">${this.story_url()}</a><br />
<b>Description:</b><br />
${desc}
`;
            return res;
        },
        save_metadata_only: async function () {
            signal_state({
                'title': this.title(),
                'stage': 'Saving metadata'
            });
            let fn = to_filename(this.title()) + '.metadata.json';
            let content = JSON.stringify(this.node_metadata, null, 2);
            if (is_node()) {
                return funcs.save_file(fn, content);
            }
            return funcs.save_file(fn, new Blob([content], { type: 'application/json' }));
        },
        build_archive_files: function () {
            let chapter_html = [ { 'name': 'Title page', content: this.make_title_page() } ];
            for (let c of this.chapters) {
                chapter_html.push({
                    name: process_chapter_title(c.metadata.title),
                    content: c.html
                });
            }
            let chapter_data = this.chapters.map(c => { return { metadata: c.metadata, data: c.data }; });
            let files = [
                {
                    name: 'metadata.json',
                    content: JSON.stringify(this.node_metadata)
                },
                {
                    name: 'chapters.json',
                    content: JSON.stringify(chapter_data)
                },
            ];
            for (let c of chapter_html) {
                files.push({
                    name: `chapters/${to_filename(c.name)}.html`,
                    content: c.content
                });
            }

            this.push_chat_files(files, 'chat', this.chat_archive);

            if (this.topics_archive) {
                files.push({
                    name: 'topics/index.json',
                    content: JSON.stringify({
                        count: this.topics_archive.count,
                        index: this.topics_archive.index
                    })
                });
                for (let t of this.topics_archive.topics || []) {
                    let base = `topics/${t.id}`;
                    files.push({
                        name: `${base}/node.json`,
                        content: JSON.stringify(t.node)
                    });
                    this.push_chat_files(files, base, t.chat);
                }
            }

            files.push({
                name: 'images.json',
                content: JSON.stringify(this.image_registry.to_json(), null, 2)
            });

            let images = 'story_images' in this ? this.story_images : [];
            for (let i of images) {
                files.push({
                    name: `images/${i.name}`,
                    content: i.content
                });
            }
            // Cover binary at archive root when fetched (skipped for --no-images)
            if (this.cover && this.cover.content) {
                files.push(this.cover);
            }
            return files;
        },
        generate_epub: async function () {
            signal_state({
                'title': this.title(),
                'stage': 'Generating ePUB file',
            });
            let metadata = {
                id: `anonkun:${this.node_id}`,
                cover: this.cover,
                title: escape_html(this.title()),
                author: escape_html(this.author()),
                tags: escape_html(this.tags().join(',')),
                description: this.node_metadata.d,
                source: this.story_url(),
                images: this.story_images,
                published: this.date_published().toISOString(),
            };
            let epub = nodepub.document(metadata);
            epub.addSection('Title Page', this.make_title_page());
            for (let c of this.chapters) {
                if (!opts.download_special && c.special) {
                    continue;
                }
                epub.addSection(process_chapter_title(c.metadata.title),
                                c.html);
            }

            epub.addCSS(`.vote {
  display: flex;
  width: 100%;
  margin-bottom: 0.4em;
}

.voteCount {
  margin-right: 1em;
  margin-left: auto;
  text-align: right;
  align-self: center;
}

.voteText {
  max-width: 90%;
}

.imgwrap {
  display: flex;
  justify-content: center;
  max-width: 100%;
}

img {
  max-width: 100%;
}
`);

            let files = await epub.getFilesForEPUB();
            let zip = new JSZip();
            for (let f of files) {
                let path = f.folder !== '' ? `${f.folder}/${f.name}` : f.name;
                let zopts = {};
                // we don't bother compressing image files, they're usually
                // already compressed by the format
                if (!f.compress || f.folder.indexOf('images') !== -1) {
                    zopts.compression = 'STORE';
                }
                zip.file(path, f.content, zopts);
            }
            let type = is_node() ? 'nodebuffer' : 'blob';
            let blob = await zip.generateAsync({
                compression: 'DEFLATE',
                type: type
            }, md => {
                signal_state({
                    'title': this.title(),
                    'stage': 'Generating ePUB file',
                    'done': Math.floor(md.percent),
                    'total': 100
                });
            });

            let fn = to_filename(this.title()) + '.epub';

            return funcs.save_file(fn, blob);
        },
        push_chat_files: function (files, prefix, chat) {
            if (!chat) {
                return;
            }
            let messages = chat.messages || [];
            let message_count = chat.message_count != null
                ? chat.message_count
                : messages.filter(m => m && m._id).length;
            files.push({
                name: `${prefix}/chat.json`,
                content: json_with_array_content(
                    {
                        count: chat.count,
                        pages: chat.pages,
                        message_count: message_count
                    },
                    'messages',
                    messages
                )
            });
        },
        generate_archive: async function () {
            signal_state({
                'title': this.title(),
                'stage': 'Generating archive',
            });
            let files = this.build_archive_files();
            let zip = new JSZip();
            for (let f of files) {
                let zopts = {};
                // we don't bother compressing image files, they're usually
                // already compressed by the format
                if (f.name.startsWith('images/')) {
                    zopts.compression = 'STORE';
                }
                zip.file(f.name, f.content, zopts);
            }

            let type = is_node() ? 'nodebuffer' : 'blob';
            let blob = await zip.generateAsync({
                compression: 'DEFLATE',
                type: type
            }, md => {
                signal_state({
                    'title': this.title(),
                    'stage': 'Generating archive',
                    'done': Math.floor(md.percent),
                    'total': 100
                });
            });

            let fn = to_filename(this.title()) + '.zip';
            return funcs.save_file(fn, blob);
        },
        generate_archive_dir: async function () {
            signal_state({
                'title': this.title(),
                'stage': 'Writing archive directory',
            });
            let files = this.build_archive_files();
            let dirname = to_filename(this.title());
            if (!funcs.save_dir) {
                throw new Error('Directory archive requires funcs.save_dir');
            }
            return funcs.save_dir(dirname, files);
        }
    };
}

/*
options accepted:

{
    url,
    download_special, // whether to include appendices
    download_type, // file type to download: epub | archive | dir | metadata | none
    download_images, // whether to include images
    reader_posts, // whether to include write-ins
    download_delay // seconds between API requests (default 0.5)
}

funcs members:
- signal_state: used to set the current state of the download, for display to the user
- save_file: used to save the final file
- save_dir: (optional) write archive file list to a directory (Node CLI)
- get_url: used to download from URLs (GET)
- post_url: used to POST form-encoded data and parse JSON
- wait: delay helper
*/
async function downloadStory(opts, funcs) {
    // Full archive (zip or dir) always includes appendices and reader posts.
    if (opts.download_type === 'archive' || opts.download_type === 'dir') {
        opts = Object.assign({}, opts, {
            download_special: true,
            reader_posts: true
        });
    }

    let story = Story(opts, funcs);
    try {
        await story.download_node();

        if (opts.download_type === 'metadata') {
            await story.save_metadata_only();
            funcs.signal_state(null);
            return;
        }

        await story.download_chapters();

        if (opts.download_type === 'archive' || opts.download_type === 'dir') {
            await story.download_chat();
            await story.download_topics();
            story.collect_extra_images();
        }
        else {
            // ePub: still register cover for naming; chapter imgs already
            // registered during process_html.
            story.ensure_cover_registered();
        }

        if (opts.download_images) {
            await story.download_images();
        }
        else {
            story.total_story_images = story.image_registry.size;
            story.story_images = [];
        }

        await story.download_cover();

        if (opts.download_type === 'epub') {
            await story.generate_epub();
        }
        else if (opts.download_type === 'archive') {
            await story.generate_archive();
        }
        else if (opts.download_type === 'dir') {
            await story.generate_archive_dir();
        }

        funcs.signal_state(null);
    }
    catch (e) {
        console.error(e);
        funcs.signal_state({ 'error': e && e.message ? e.message : String(e) });
        throw e;
    }
}

function build_board_query(opts) {
    let page = opts.page || 1;
    let sort = opts.sort || 'new';
    let params = new URLSearchParams();
    params.set('page', String(page));
    params.set('sort', sort);
    params.set('length', opts.length || 'Any');

    let ratings = opts.contentRating || {
        teen: true, mature: true, nsfw: true, unrated: true
    };
    for (let k of Object.keys(ratings)) {
        if (ratings[k]) {
            params.set(`contentRating[${k}]`, 'true');
        }
    }
    let statuses = opts.storyStatus || {
        active: true, finished: true, hiatus: true
    };
    for (let k of Object.keys(statuses)) {
        if (statuses[k]) {
            params.set(`storyStatus[${k}]`, 'true');
        }
    }
    let interact = opts.rInteract || {
        none: true, light: true, medium: true, heavy: true
    };
    for (let k of Object.keys(interact)) {
        if (interact[k]) {
            params.set(`rInteract[${k}]`, 'true');
        }
    }
    return params.toString();
}

/*
listStories options:
{
  board: 'stories' (default),
  start_page: 1,
  end_page: null (until empty),
  sort: 'new'|'active'|'hot'|'chapter'|'replies'|'like',
  contentRating / storyStatus / rInteract optional overrides
}
*/
async function listStories(opts, funcs) {
    let board = opts.board || 'stories';
    let start = opts.start_page || 1;
    let end = opts.end_page || null;
    let sort = opts.sort || 'new';
    let delay = opts.download_delay || 0.5;
    let all = [];
    let page = start;
    let pages_fetched = 0;

    try {
        while (true) {
            if (end !== null && page > end) {
                break;
            }
            funcs.signal_state({
                stage: `Listing stories`,
                done: pages_fetched,
                total: end ? (end - start + 1) : undefined
            });
            let qs = build_board_query(Object.assign({}, opts, { page, sort }));
            let url = `${API_BASE}/api/anonkun/board/${board}?${qs}`;
            let data = await funcs.get_url(url);
            let stories = (data && data.stories) ? data.stories : [];
            pages_fetched += 1;
            if (!stories.length) {
                break;
            }
            for (let s of stories) {
                let entry = Object.assign({}, s);
                entry.url = story_page_url(s.t, s._id);
                all.push(entry);
            }
            page += 1;
            await funcs.wait(delay);
        }

        let result = {
            scraped_at: new Date().toISOString(),
            board: board,
            sort: sort,
            start_page: start,
            end_page: end,
            pages_fetched: pages_fetched,
            story_count: all.length,
            stories: all
        };
        funcs.signal_state(null);
        return result;
    }
    catch (e) {
        console.error(e);
        funcs.signal_state({
            'error': e && e.message ? e.message : String(e)
        });
        throw e;
    }
}

exports.downloadStory = downloadStory;
exports.listStories = listStories;
exports.encode_form = encode_form;
exports.process_image_url = process_image_url;
exports.story_page_url = story_page_url;
