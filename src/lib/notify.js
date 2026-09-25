// What the user is told when Apple Music says no: one line in the shell's own
// notification, worded for the two failures they can do something about. The
// same door for a tile's menu, the pane's Play, a row, the queue and a sync,
// so an engine that is down reads the same wherever it was asked from.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AmError} from './amctl.js';

export function friendlyMessage(e) {
    if (e instanceof AmError) {
        if (e.code === 'not-signed-in')
            return 'Sign in to Apple Music in Music Menu’s settings';
        if (e.code === 'engine-down')
            return 'Apple Music isn’t running right now';
        if (e.message)
            return e.message;
    }
    return 'Something went wrong talking to Apple Music';
}

// For a `.catch()`: logs the failure and tells the user in a notification.
// `what` is the action that failed, for the log line.
export function notifyFailure(e, what = 'action') {
    console.warn(`[Music Menu] ${what} failed: ${e?.code ?? e}`);
    Main.notify('Music Menu', friendlyMessage(e));
}
