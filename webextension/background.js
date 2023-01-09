/* global browser, require */

let $ = require('jquery');
let ficlivedl = require('./ficlivedl');

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

function download_running() {
    return downloadState !== null && 'stage' in downloadState;
}

// Sends the current download state as a browser message. This will be picked up
// by the popup code if the popup is currently displayed.
function signal_state(state_msg) {
    downloadState = state_msg;
    // this will error out in the promise if the popup
    // doesn't exist, but we don't care
    browser.runtime.sendMessage({
        'action': 'dl_state',
        'data': downloadState
    }).catch(() => 0);
}

let funcs = {
    signal_state: signal_state,
    // when running in the browser, "data" must be a blob
    save_file: async function (name, data) {
        let blobURL = URL.createObjectURL(data);
        // we sinkhole download errors here because the most common case (I
        // found in testing) was just when the user canceled the download, which
        // we don't want to flag

        // unfortunately there doesn't seem to be a robust way to distinguish
        // between types of errors
        return browser.downloads.download({
                filename: name,
                saveAs: true,
                url: blobURL
        }).catch(() => 0);
    },
    get_url: async function (url, image = false) {
        let xhrFields = {};
        if (image) {
            xhrFields.responseType = 'blob';
        }
        return $.ajax({
            url: url,
            xhrFields: xhrFields
        });
    }
};

browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.action === "download") {
        if (!download_running()) {
            ficlivedl.downloadStory(message, funcs);
        }
        sendResponse();
        return true;
    }
    else if (message.action === "query_dl_state") {
        let resp = {
            response: 'good',
            state: downloadState
        };
        sendResponse(resp);
        return true;
    }
    return false;
});
