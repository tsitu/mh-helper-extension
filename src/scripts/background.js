/** Persistent background script.
 * MAYBE: Migrate to non-persistent, event-based background script.
 * info: https://developer.chrome.com/extensions/background_migration
 */

// Update check
chrome.runtime.onUpdateAvailable.addListener(details => {
    console.log(`MHHH: updating to version ${details.version}`);
    chrome.runtime.reload();
});

// Refreshes MH pages when new version is installed, to inject the latest extension code.
chrome.runtime.onInstalled.addListener(() => chrome.tabs.query(
    {'url': ['*://www.mousehuntgame.com/*', '*://apps.facebook.com/mousehunt/*']},
    tabs => tabs.forEach(tab => chrome.tabs.reload(tab.id))
));

// Schedule an update of the badge text every second, using the latest settings.
setInterval(() => check_settings(icon_timer_find_open_mh_tab), 1000);


/**
 *
 * @param {Function} callback Some callable that needs the current extension settings
 */
function check_settings(callback) {
    chrome.storage.sync.get({
        success_messages: true, // defaults
        error_messages: true, // defaults
        icon_timer: true, // defaults
        horn_sound: false, // defaults
        custom_sound: '', // defaults
        horn_volume: 100, // defaults
        horn_alert: false, // defaults
        horn_webalert: false, // defaults
        track_crowns: true // defaults
    },
    settings => callback(settings));
}

/**
 * Update the badge text icon timer with info from the latest settings and current MH page.
 * @param {Object <string, any>} settings Extension settings
 */
function icon_timer_find_open_mh_tab(settings) {
    chrome.tabs.query({'url': ['*://www.mousehuntgame.com/*', '*://apps.facebook.com/mousehunt/*']},
    found_tabs => {
        const mhTab = found_tabs[0];
        if (mhTab && (!mhTab.status || mhTab.status === "complete")) {
            icon_timer_updateBadge(mhTab.id, settings);
        } else {
            // The tab was either not found, or is still loading.
            icon_timer_updateBadge(false, settings);
        }
    });
}

// Notifications
const default_sound = chrome.extension.getURL('sounds/bell.mp3');
let notification_done = false;
/**
 * Scheduled function that sets the badge color & text based on current settings.
 * Modifies the global `notification_done` as appropriate.
 * @param {number|boolean} tab_id The MH tab's ID, or `false` if no MH page is open & loaded.
 * @param {Object <string, any>} settings Extension settings
 */
function icon_timer_updateBadge(tab_id, settings) {
    if (tab_id === false) {
        chrome.browserAction.setBadgeText({text: ''});
        return;
    }

    // Query the MH page and update the badge based on the response.
    const request = {jacks_link: "huntTimer"};
    chrome.tabs.sendMessage(tab_id, request, response => {
        if (chrome.runtime.lastError || !response) {
            const logInfo = {tab_id, request, response, time: new Date(),
                message: "Error occurred while updating badge icon timer."
            };
            if (chrome.runtime.lastError) {
                logInfo.message += `\n${chrome.runtime.lastError.message}`;
            }
            console.log(logInfo);
            chrome.browserAction.setBadgeText({text: ''});
            notification_done = true;
        } else if (response === "Ready!") {
            if (settings.icon_timer) {
                chrome.browserAction.setBadgeBackgroundColor({color: '#9b7617'});
                chrome.browserAction.setBadgeText({text: '🎺'});
            }
            // If we haven't yet sent a notification about the horn, do so if warranted.
            if (!notification_done) {
                if (settings.horn_sound && settings.horn_volume > 0) {
                    const myAudio = new Audio(settings.custom_sound || default_sound);
                    myAudio.volume = (settings.horn_volume / 100).toFixed(2);
                    myAudio.play();
                }
                if (settings.horn_alert) {
                    chrome.notifications.create(
                        "Jacks MH Horn",
                        {
                            type: "basic",
                            iconUrl: "images/icon128.png",
                            title: "Jack's MH Tools",
                            message: "MouseHunt Horn is ready!!! Good luck!",
                        }
                    );
                }
                if (settings.horn_webalert) {
                    chrome.tabs.update(tab_id, {'active': true});
                    chrome.tabs.sendMessage(tab_id, {jacks_link: "show_horn_alert"});
                }
            }
            notification_done = true;
        } else if (["King's Reward", "Logged out"].includes(response)) {
            if (settings.icon_timer) {
                chrome.browserAction.setBadgeBackgroundColor({color: '#F00'});
                chrome.browserAction.setBadgeText({text: 'RRRRRRR'});
            }
            notification_done = true;
        } else {
            // The user is logged in, has no KR, and the horn isn't ready yet. Set
            // the badge text to the remaining time before the next horn.
            notification_done = false;
            if (settings.icon_timer) {
                chrome.browserAction.setBadgeBackgroundColor({color: '#222'});
                response = response.replace(':', '');
                const response_int = parseInt(response, 10);
                if (response.includes('min')) {
                    response = response_int + 'm';
                } else {
                    if (response_int > 59) {
                        let minutes = Math.floor(response_int / 100);
                        const seconds = response_int % 100;
                        if (seconds > 30) {
                            ++minutes;
                        }
                        response = minutes + 'm';
                    } else {
                        response = response_int + 's';
                    }
                }
            } else { // reset in case user turns icon_timer off
                response = "";
            }
            chrome.browserAction.setBadgeText({text: response});
        }
    });
}

// Handle messages sent by the extension to the runtime.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Check the message for something to log in the background's console.
    if (msg.log) {
        let fn = console.log;
        if (msg.is_error) {
            fn = console.error;
        } else if (msg.is_warning) {
            fn = console.warn;
        }
        fn({message: msg.log, sender});
    } else if (msg.settings && msg.settings.debug_logging) {
        console.log({msg, msg_sender: sender});
    }

    if (msg.jacks_crown_update === 1) {
        submitCrowns(msg.crowns).then(sendResponse);
        // Keep the response port open since we're responding asynchronously.
        return true;
    }
    // TODO: Handle other extension messages.
});

/**
 * Promise to submit the given crowns for external storage (e.g. for MHCC or others)
 * @param {Object <string, any>} crowns Crown counts for the given user
 * @returns {Promise <number>|Promise <boolean>} A promise that resolves with the submitted crowns, or `false` otherwise.
 */
function submitCrowns(crowns) {
    if (!crowns || !crowns.user || (crowns.bronze + crowns.silver + crowns.gold) === 0) {
        return Promise.resolve(false);
    }

    return new Promise(resolve => {
        const payload = new FormData();
        payload.set("main", JSON.stringify(crowns));
        fetch("https://script.google.com/macros/s/AKfycbxPI-eLyw-g6VG6s-3f_fbM6EZqOYp524TSAkGrKO23Ge2k38ir/exec", {
            mode: "cors",
            method: "POST",
            credentials: "omit",
            body: payload
        }).then(response => resolve(!response.ok ? false :
                crowns.bronze + crowns.silver + crowns.gold)
        ).catch(error => {
            window.console.error({
                "message": "Error submitting user crowns",
                "error": error,
                "crowns": crowns
            });
            resolve(false);
        });
    });
}
