/* global $, browser */

let curTab = null;

let story_url_re = /^https:\/\/fiction.live\/stories\/[^/]+\/[^/]+\//;

function handleDownloadClick() {
    if (curTab === null || !('url' in curTab)) {
        return;
    }
    let message = {
        action: 'download',
        url: curTab.url,
        download_special: true,
        download_type: 'epub',
        download_images: true,
        reader_posts: true
    };
    for (let i of ['download_special', 'download_images', 'reader_posts']) {
        message[i] = $('#' + i).prop('checked');
    }
    message['download_type'] = dl_type_value();
    console.log(message);
    browser.runtime.sendMessage(message);
}

function renderDownloadState(state) {
    if (state === null) {
        $('#new_dl').show();
        $('#dl_state').hide();
        setup_form();
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

function dl_type_value() {
    let rv = $('input[name="download_type"]:checked').val();
    return rv;
}

function form_consistency_check() {
    let dl_type = dl_type_value();
    if (dl_type === 'archive') {
        $('#download_special').prop('disabled', true).prop('checked', true);
        $('#reader_posts').prop('disabled', true).prop('checked', true);
    } else {
        $('#download_special').prop('disabled', false);
        $('#reader_posts').prop('disabled', false);
    }
}

function setup_form() {
    $('#download').click(handleDownloadClick);
    $('#adv_toggle').click(adv_toggle);
    $('#new_dl').find('input').change(form_consistency_check);
    browser.tabs.query({
        active: true,
        windowId: browser.windows.WINDOW_ID_CURRENT
    }).then(function (tabs) {
        let tab = tabs[0];
        curTab = tab;
        if (!('url' in tab) || tab.url.match(story_url_re) === null) {
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
            setup_form();
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
