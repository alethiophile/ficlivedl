/* global require, process, exports */

// This is the common scraper logic for ficlivedl. It's meant to work
// both in the browser and on the node command line, so the entry
// point accepts a `funcs` parameter with functions the code will use
// for HTTP downloads, progress updates, and providing the final file.

let nodepub = require('nodepub');
let sanitizeHtml = require('sanitize-html');
let JSZip = require('jszip');

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
    let u = new URL(url);
    let basename = u.pathname.split('/').at(-1);
    return basename;
}

function to_filename(str) {
    return str.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]+/g, '');
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

// the fiction.live frontend script does a bunch of manual transforms
// on the image URLs the API ships out before actually fetching them;
// this is incredibly stupid but there you go
let image_cdn = 'cdn6.fiction.live';
function process_image_url(url) {
    let u = new URL(url);
    if (u.hostname.endsWith("fiction.live") || u.hostname.endsWith("cloudfront.net")) {
        let real_url = `https://${image_cdn}/file/fictionlive${u.pathname}`;
        return real_url;
    }
    else {
        return url;
    }
}

function Story(opts, funcs) {
    let signal_state = funcs.signal_state;
    let get_url = funcs.get_url;
    function chapter_url(story_id, start, end) {
        return `https://fiction.live/api/anonkun/chapters/${story_id}/${start}/${end}`;
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
                    images.push(src);
                    $this.attr('src', '../images/' + url_basename(src));
                });
                if (opts.download_images) {
                    $dom.find('figure').find('img').unwrap();
                    $dom.find('img').wrap(`<div class="imgwrap"></div>`);
                } else {
                    // if no images, then all these elements are just removed
                    $dom.find('figure').remove();
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
                    let ent_html = `<p>${escape_html(e.votes[k])}</p>`;
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
                            votes[v].count += 1;
                        }
                    }
                    else {
                        votes[e.votes[k]].count += 1;
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

    return {
        node_id: get_node_id(opts.url),
        download_delay: 0.5,
        node_metadata: null,
        // This method returns this story's node URL in the API
        node_url: function () {
            return `https://fiction.live/api/node/${this.node_id}`;
        },
        // This method downloads the node info, returning a promise
        download_node: function () {
            let url = this.node_url();
            signal_state({ 'stage': 'Getting metadata' });
            return get_url(url).then((data) => {
                this.node_metadata = data;
                this.set_chapter_urls();
                return data;
            });
        },
        story_url: function () {
            let re = /^https:\/\/fiction.live\/stories\/[^/]+\/[^/]+\/?/;
            let match = opts.url.match(re);
            return match[0];
        },
        title: function () {
            return this.node_metadata.t;
        },
        author: function () {
            return this.node_metadata.u[0].n;
        },
        tags: function () {
            return [...new Set(this.node_metadata.ta.concat(this.node_metadata.spoilerTags))];
        },
        words: function () {
            return this.chapters.map(c => c.words).reduce((a, b) => a + b);
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
            let num_chapters = this.node_metadata.bm.length;
            let first = 1;
            // what is even up with this overly complicated URL algo
            for (let i = 0; i < num_chapters; i++) {
                let item = {};
                item.metadata = this.node_metadata.bm[i];
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
                else if (i + 1 >= num_chapters || this.node_metadata.bm[i + 1].title.startsWith('#special')) {
                    end = final_number;
                }
                else {
                    end = this.node_metadata.bm[i + 1].ct - 1;
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
                let tries = 3;
                let data;
                while (tries > 0) {
                    try {
                        data = await get_url(u);
                    } catch (e) {
                        // any fetch error is typically a 400 that seems to be a
                        // "server overloaded" or similar back-off message; wait
                        // 4x the typical delay, then try again
                        tries -= 1;
                        if (tries <= 0) {
                            throw e;
                        }
                        await funcs.wait(this.download_delay * 4)
                        continue;
                    }
                    break;
                }
                let wait_until = Date.now() + this.download_delay * 1000;
                c.data = data;
                num_downloaded += 1;
                process_html(c);
                // console.log(`chapter ${num_downloaded}`, c.images);
                let wait_time = Math.max(wait_until - Date.now(), 0);
                await funcs.wait(wait_time / 1000)
            }
            return;
        },
        download_images: async function () {
            // This function relies on all the images being under domains that
            // ficlivedl has permissions for. Currently the images are hosted at
            // cdn*.fiction.live, and the extension has permissions for
            // *.fiction.live. However, this has been different in the past, so
            // if the image hosting changes again then the extension may break.
            this.story_images = [];
            let image_urls = new Set();
            for (let c of this.chapters) {
                let il = 'images' in c ? c.images : [];
                for (let i of il) {
                    let u = process_image_url(i);
                    image_urls.add(u);
                }
            }
            this.total_story_images = image_urls.size;
            let num_downloaded = 0;
            all_images: for (let i of image_urls) {
                signal_state({
                    'title': this.title(),
                    'stage': 'Fetching images',
                    'done': num_downloaded,
                    'total': image_urls.size + 1
                });
                let tries = 3;
                let data;
                while (tries > 0) {
                    try {
                        data = await get_url(i, true);
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
                    name: url_basename(i),
                    content: data
                });
            }
            return;
        },
        download_cover: async function () {
            signal_state({
                'title': this.title(),
                'stage': 'Fetching images',
                'done': this.total_story_images,
                'total': this.total_story_images + 1
            });
            let cover_url, cover_name;
            if ('i' in this.node_metadata) {
                cover_url = this.node_metadata.i[0];
                cover_name = url_basename(cover_url);
            } else {
                cover_url = "https://placekitten.com/g/800/600";
                cover_name = "cover.jpg";
            }
            let u = process_image_url(cover_url);
            try {
                return await get_url(u, true).then((data) => {
                    this.cover = {
                        name: cover_name,
                        content: data
                    };
                });
            }
            // we do need a cover, so in case of download error fall
            // back on the kitten
            catch (e) {
                cover_url = "https://placekitten.com/g/800/600";
                cover_name = "cover.jpg";
                return await get_url(cover_url, true).then((data) => {
                    this.cover = {
                        name: cover_name,
                        content: data
                    };
                });
            }
        },
        make_title_page: function () {
            let desc = `<p>${this.node_metadata.d}</p><p>${this.node_metadata.b}</p>`
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
                let opts = {};
                // we don't bother compressing image files, they're usually
                // already compressed by the format
                if (!f.compress || f.folder.indexOf('images') !== -1) {
                    opts.compression = 'STORE';
                }
                zip.file(path, f.content, opts);
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
        generate_archive: async function () {
            signal_state({
                'title': this.title(),
                'stage': 'Generating archive',
            });
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
            let images = 'story_images' in this ? this.story_images : [];
            for (let i of images) {
                files.push({
                    name: `images/${i.name}`,
                    content: i.content
                });
            }
            files.push(this.cover);
            let zip = new JSZip();
            for (let f of files) {
                // let path = f.folder !== '' ? `${f.folder}/${f.name}` : f.name;
                let opts = {};
                // we don't bother compressing image files, they're usually
                // already compressed by the format
                if (f.name.startsWith('images/')) {
                    opts.compression = 'STORE';
                }
                zip.file(f.name, f.content, opts);
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
        }
    };
}

/*
options accepted:

{
    url,
    download_special, // whether to include appendices
    download_type, // file type to download
    download_images, // whether to include images
    reader_posts // whether to include write-ins
}

funcs has three members:
- signal_state: used to set the current state of the download, for display to the user
- save_file: used to save the final file
- get_url: used to download from URLs
*/
function downloadStory(opts, funcs) {
    let story = Story(opts, funcs);
    story.download_node().then(() => {
        return story.download_chapters();
    }).then(() => {
        if (opts.download_images) {
            return story.download_images();
        }
        return;
    }).then(() => {
        return story.download_cover();
    }
    ).then(() => {
        if (opts.download_type === 'epub') {
            return story.generate_epub();
        } else if (opts.download_type === 'archive') {
            return story.generate_archive();
        }
        return;
    }).then(() => {
        funcs.signal_state(null);
    }).catch((e) => {
        console.error(e);
        funcs.signal_state({ 'error': e.message });
    });
}

exports.downloadStory = downloadStory;
