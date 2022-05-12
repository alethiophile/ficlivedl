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
let downloadState = null;

function Story(node_id) {
    function chapter_url(story_id, start, end) {
        return `https://fiction.live/api/anonkun/chapters/${story_id}/${start}/${end}`;
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
                return data;
            });
        },
        chapter_urls: function () {
            if (this.node_metadata === null) {
                return [];
            }
            let chapter_starts = this.node_metadata.bm.map(i => i.ct);
            chapter_starts[0] = 0;
            let sorted = Array.from(chapter_starts).sort();
            // this must be a string because it's too big for the JS
            // numeric type
            let final_number = '9999999999999998';
            let urls = chapter_starts.map(x => {
                let sind = sorted.indexOf(x);
                let end = (sind + 1 < chapter_starts.length) ?
                    (sorted[sind + 1] - 1) : final_number;
                return chapter_url(this.node_id, x, end);
            });
            return urls;
        },
        download_chapters: async function () {
            let urls = this.chapter_urls();
            let chapters = [];
            let num_downloaded = 0;
            for (let u of urls) {
                downloadState = {
                    'title': this.node_metadata.t,
                    'stage': 'chapters',
                    'done': num_downloaded,
                    'total': urls.length
                };
                browser.runtime.sendMessage({
                    'action': 'dl_state',
                    'data': downloadState
                });
                let data = await $.get(u);
                chapters.push(data);
                num_downloaded += 1;
                await new Promise(r => setTimeout(r, this.download_delay * 1000));
            }
            this.chapters = chapters;
            downloadState = null;
        }
    };
}

function downloadStory(url) {
    const storyUrlRe = new RegExp('^https://fiction.live/stories/[^/]+/(\\w+)/?');
    let res = url.match(storyUrlRe);
    if (res === null) {
        return;
    }
    let nodeId = res[1];
    let story = Story(nodeId);
    story.download_node().then(() => {
        console.log(story.node_metadata);
        return story.download_chapters();
    }).then(() => {
        console.log(story.chapters);
    });
}

browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.action === "download") {
        if (downloadState === null) {
            downloadStory(message.url);
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
})
