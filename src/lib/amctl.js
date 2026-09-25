// The one door between the shell and Apple Music. Everything that needs the
// engine — a play, a sync, a search — runs `backend/am.py <command>` as a
// child process and reads the single JSON object it prints. Nothing here
// touches the network or blocks: the shell is the compositor, and a slow
// Chrome must never become a frozen desktop.
//
//   const r = await amctl.run(['play', 'album', 'l.abc', '--start-with', '3']);
//   // r is am.py's JSON; a failure rejects with an AmError {code, message}
//
// `setExtensionPath()` is called once from app.js (and prefs.js) with the
// extension's own directory, since lib/ runs from a staging copy and cannot
// find the backend relative to itself.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

let _extensionPath = null;

export function setExtensionPath(path) {
    _extensionPath = path;
}

export class AmError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

function scriptPath() {
    if (!_extensionPath)
        throw new AmError('usage', 'amctl: setExtensionPath() was never called');
    return GLib.build_filenamev([_extensionPath, 'backend', 'am.py']);
}

// Run one am.py command. Resolves with its parsed JSON, rejects with AmError.
// `cancellable` (a Gio.Cancellable) kills the child if the caller gives up,
// e.g. a search superseded by the next keystroke.
export function run(args, {cancellable = null} = {}) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(['python3', scriptPath(), ...args.map(String)],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            reject(e instanceof AmError ? e : new AmError('spawn', String(e)));
            return;
        }
        const cancelId = cancellable?.connect(() => proc.force_exit()) ?? 0;
        proc.communicate_utf8_async(null, null, (p, res) => {
            if (cancelId)
                cancellable.disconnect(cancelId);
            let stdout, stderr;
            try {
                [, stdout, stderr] = p.communicate_utf8_finish(res);
            } catch (e) {
                reject(new AmError('spawn', String(e)));
                return;
            }
            let json = null;
            try {
                json = JSON.parse((stdout ?? '').trim().split('\n').pop() || 'null');
            } catch {
                // fall through: reported below with stderr for context
            }
            if (json && !json.error && p.get_successful()) {
                resolve(json);
                return;
            }
            const code = json?.error ?? (cancellable?.is_cancelled() ? 'cancelled' : 'crash');
            const message = json?.message ?? (stderr || '').trim().split('\n').pop() ?? '';
            if (code !== 'cancelled')
                console.warn(`[Music Menu] am.py ${args[0]} failed: ${code} ${message}`);
            reject(new AmError(code, message));
        });
    });
}

// Fire-and-forget for UI actions whose failure is only worth a log line.
export function fire(args) {
    run(args).catch(() => {});
}
