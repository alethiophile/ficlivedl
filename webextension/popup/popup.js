let curTab = null;

function handleDownloadClick() {
    if (curTab === null || !('url' in curTab)) {
        return;
    }
    browser.runtime.sendMessage({
        action: 'download',
        url: curTab.url,
        // TODO make this an option
        download_special: true
    });
}

function renderDownloadState(state) {
    $('#download').hide();
    $('#dl_state').show();
    $('#dl_story_title').html(state.title);
    $('#dl_stage').html(state.stage);
    $('#dl_done').html(state.done);
    $('#dl_total').html(state.total);
}

function handleIconClick() {
    browser.runtime.sendMessage({
        action: 'query_dl_state'
    }).then(function (resp) {
        let dl_state = resp.state;
        if (dl_state === null) {
            $('#download').click(handleDownloadClick);
            browser.tabs.query({
                active: true,
                windowId: browser.windows.WINDOW_ID_CURRENT
            }).then(function (tabs) {
                let tab = tabs[0];
                curTab = tab;
                if (!('url' in tab)) {
                    // no URL on tab object, therefore it's not a fiction.live
                    // URL (this happens due to permissions: this addon has
                    // only fiction.live host permissions, so the only tabs it
                    // can see URLs for are those from fiction.live)
                    $('#download').prop('disabled', true);
                }
                else {
                    $('#download').prop('disabled', false);
                }
            });
        }
        else {
            renderDownloadState(dl_state);
        }
    })
}

window.onload = handleIconClick;
browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.action === 'dl_state') {
        renderDownloadState(message.data);
        sendResponse();
        return true;
    }
    return false;
});
