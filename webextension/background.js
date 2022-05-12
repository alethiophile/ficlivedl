/* A download state describes the current download status for purposes
   of progress display in the popup. It may be either null (signaling
   no download in progress), or an object as follows: 

   {
     title: story title as string
     stage: either 'chapters' or 'images', as appropriate
     done: number of chapters/images already downloaded
     total: number of chapters/images overall
   }
*/
let nodepub = require('nodepub');

let downloadState = null;

HtmlSanitizer.AllowedTags['FIGURE'] = true;

function Story(node_id) {
    function chapter_url(story_id, start, end) {
        return `https://fiction.live/api/anonkun/chapters/${story_id}/${start}/${end}`;
    }
    // This takes a chapter object that has been downloaded (i.e. has
    // a data member), processes the HTML of all entries, and creates
    // html and images members on the object. Also responsible for
    // rendering votes, user prompts, etc as HTML.
    function process_html(chapter) {
        let images = [];
        let chapter_html = "";
        for (let e of chapter.data) {
            // sometimes a request will include extraneous entries
            // from different chapters
            if ('t' in e && e.t !== chapter.metadata.title) {
                continue;
            }
            if (e.nt === 'chapter') {
                let html = HtmlSanitizer.SanitizeHtml(e.b);
                html = `<div class="chapter">${html}</div>`;
                let $dom = $(html);
                $dom.find('img').each(function () {
                    let $this = $(this);
                    let src = $this.attr('src');
                    images.push(src);
                    let u = new URL(src);
                    let basename = u.pathname.split('/').at(-1);
                    $this.attr('src', basename);
                });
                chapter_html += $dom.prop('outerHTML');
            }
            else if (e.nt === 'readerPost') {
                let title = 'b' in e ? e.b : 'Reader Posts';
                let html = `<h3>${title}</h3>`;
                let votes = 'votes' in e ? Object.getOwnPropertyNames(e.votes) : [];
                let dice = {};
                if ('dice' in e) {
                    Object.assign(dice, e.dice);
                }
                let entries = [];
                for (let k of votes) {
                    let ent_html = `<p>${e.votes[k]}</p>`;
                    if (k in dice) {
                        ent_html = `<div class="dice">${dice[k]}</div>` + ent_html;
                        delete dice[k];
                    }
                    entries.push(ent_html);
                }
                for (let k in dice) {
                    entries.push(`<div class="dice">${dice[k]}</div>`);
                }
                html += entries.join('<hr>');
                chapter_html += `<div class="readerVote">${html}</div>`;
            }
            else if (e.nt === 'choice') {
                let title = 'b' in e ? e.b : 'Choices';
                let html = `<h3>${title}</h3>`;
                let votes = e.choices.map(x => { return { vote: x, count: 0 }; });
                for (let k in e.votes) {
                    if (Array.isArray(e.votes[k])) {
                        for (let v in e.votes[k]) {
                            votes[v].count += 1;
                        }
                    }
                    else {
                        votes[e.votes[k]].count += 1;
                    }
                }
                votes.sort((a, b) => b.count - a.count);
                for (let v of votes) {
                    html += `<div class="vote">${v.vote}<span class="voteCount">${v.count}</span></div>`;
                }
                chapter_html += `<div class="vote">${html}</div>`;
            }
        }
        chapter.html = chapter_html;
        chapter.images = images;
    }
    return {
        node_id: node_id,
        download_delay: 2.0,
        node_metadata: null,
        // This method returns this story's node URL in the API
        node_url: function () {
            return `https://fiction.live/api/node/${this.node_id}`;
        },
        // This method downloads the node info, returning a promise
        download_node: function () {
            let url = this.node_url();
            downloadState = { 'stage': 'metadata' };
            return $.get(url).then((data) => {
                this.node_metadata = data;
                this.set_chapter_urls();
                return data;
            });
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
        /* this function is a mess of callback spaghetti that is only structured
           that way because async programming fills me with the misguided urge
           to overoptimize

           specifically, it would be much simpler as an async function that just
           did the process_html calls between downloads, but this would mean
           leaving the CPU idle during the network wait time, which offends my
           aesthetic sense

           therefore, I instead construct the promise chain manually, such that
           the promise for each chapter download chains into both the next
           chapter download, and the HTML processing function

           then I return a promise that chains off the final processing
           function, so the promise for the function as a whole resolves once
           the final chapter processing is done
        */
        download_chapters: function (with_special) {
            // let urls = this.chapter_urls();
            // let chapters = [];
            let num_downloaded = 0;
            let total_to_download = this.chapters.filter(x => (with_special || !x.special)).length;
            let fulfill_func;
            let chapter_promise = new Promise((resolve, reject) => { fulfill_func = resolve; });
            let node_md = this.node_metadata;
            let done_processing;
            for (let c of this.chapters) {
                if (!with_special && c.special) {
                    continue;
                }
                let p = chapter_promise.then(function () {
                    downloadState = {
                        'title': node_md.t,
                        'stage': 'chapters',
                        'done': num_downloaded,
                        'total': total_to_download
                    };
                    // this will error out in the promise if the popup
                    // doesn't exist, but we don't care
                    browser.runtime.sendMessage({
                        'action': 'dl_state',
                        'data': downloadState
                    }).catch(() => 0);
                    let u = c.url;
                    return $.get(u);
                });
                done_processing = p.then(function (data) {
                    c.data = data;
                    num_downloaded += 1;
                    process_html(c);
                    console.log(c);
                });
                chapter_promise = p.then(() => new Promise(r => setTimeout(r, this.download_delay * 1000)));
            }
            // resolve the initial promise to kick off the chain
            fulfill_func();
            // the promise returned from this function chains off the final
            // done_processing promise, which fires when the final chapter has
            // been downloaded and processed -- the final chapter_promise is
            // just a hanging delay that doesn't have anything chained off it
            return done_processing.then(() => {
                downloadState = null;
            });
        }
    };
}

function downloadStory({url, download_special}) {
    const storyUrlRe = new RegExp('^https://fiction.live/stories/[^/]+/(\\w+)/?');
    let res = url.match(storyUrlRe);
    if (res === null) {
        return;
    }
    let nodeId = res[1];
    let story = Story(nodeId);
    story.download_node().then(() => {
        console.log(story.node_metadata);
        return story.download_chapters(download_special);
    }).then(() => {
        // console.log(story.chapters);
    });
}

browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.action === "download") {
        if (downloadState === null) {
            downloadStory(message);
        }
        sendResponse();
        return true;
    }
    else if (message.action === "query_dl_state") {
        sendResponse({
            response: 'good',
            state: downloadState
        });
        return true;
    }
    return false;
});
