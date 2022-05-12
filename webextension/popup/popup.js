let curTab = null;

function handleDownloadClick() {
    if (curTab === null || !('url' in curTab)) {
        return;
    }
    let message = {
        action: 'download',
        url: curTab.url,
        download_special: true,
        run_download: true,
        download_images: true,
        reader_posts: true
    };
    for (let i of ['download_special', 'run_download', 'download_images', 'reader_posts']) {
        message[i] = $('#' + i).prop('checked');
    }
    console.log(message);
    browser.runtime.sendMessage(message);
}

function renderDownloadState(state) {
    if (state === null) {
        $('#new_dl').show();
        $('#dl_state').hide();
        setup_popup();
    } else {
        $('#new_dl').hide();
        $('#dl_state').show();
        $('#dl_story_title').html(state.title);
        $('#dl_stage').html(state.stage);
        if ('done' in state) {
            $('#dl_progress').show();
            $('#dl_done').html(state.done + 1);
            $('#dl_total').html(state.total);
        } else {
            $('#dl_progress').hide();
        }
    }
}

let adv_shown = false;

function adv_toggle() {
    if (adv_shown) {
        $('#adv').hide();
        $('#adv_arrow').html('⯈');
        adv_shown = false;
    } else {
        $('#adv').show();
        $('#adv_arrow').html('⯆');
        adv_shown = true;
    }
}

function setup_popup() {
    $('#download').click(handleDownloadClick);
    $('#adv_toggle').click(adv_toggle);
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

function handleIconClick() {
    browser.runtime.sendMessage({
        action: 'query_dl_state'
    }).then(function (resp) {
        let dl_state = resp.state;
        if (dl_state === null) {
            setup_popup();
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
