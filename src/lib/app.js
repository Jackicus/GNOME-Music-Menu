// MusicMenuApp: owns the library's button, the desktop surface, what is
// on it, and the transitions between them. Rendering happens on the wallpaper
// layer of the active workspace, so the surface is shown and hidden as
// workspaces change.
//
// The way in is one button beside Show Apps (libraryButton.js) and its
// shortcut, wherever the library opens, and the library is tabs between its
// sections over a grid of each (libraryView.js).
//
// Two settings decide where things open, and they are read independently of
// each other: `library-opens-in` for the library, `detail-opens-in` for the
// pane of a picked item. Both take the same four values, meaning the same
// four places:
//
//   desktop     on the wallpaper of the workspace you are on, brought up there
//               by the button and put away by it again
//   workspaces  on the wallpaper, on a workspace of its own, slid to
//   menu        in the overview's app-grid slot (mediaMenu.js) for the
//               library; popped up as an app folder is (detailDialog.js) for
//               a pane
//   modal       in the folder's panel over the desktop (libraryWindow.js for
//               the library, detailDialog.js for a pane), held until it is
//               closed
//
// Neither setting looks at the other. What follows from the pair rather than
// from either alone is one thing only, and it is named: `_detailInPlace()` —
// the grid and the pane landing on the same workspace, which is what makes a
// pick a hero flight in place of the grid rather than a move to somewhere else.
//
// The surface is built when either of them is `desktop` or `workspaces`. It
// holds the library's page — the tabs over the grids — and one detail page,
// each built once and kept, so moving between them is a matter of which is
// visible. The pane is shared: it sits in the detail page, or moves into the
// library's page when it is replacing the grid.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Duration, Ease, POP_SCALE, allocateNow, fadeTo, flyClone, rectIn} from './anim.js';
import {SECTIONS, loadLibrary, libraryPath, enabledSections} from './library.js';
import {createHeader, createIconButton} from './widgets.js';
import {setCornerRadius, PANE_INSET} from './shape.js';
import {setGridAlign} from './mediaGrid.js';
import {HEADER_ALLOWANCE, LibraryView} from './libraryView.js';
import {LibraryButton} from './libraryButton.js';
import {DetailView} from './detailView.js';
import {OverviewPreview} from './overviewPreview.js';
import {MediaMenu} from './mediaMenu.js';
import {LibraryWindow} from './libraryWindow.js';
import {DetailDialog} from './detailDialog.js';
import {MediaPanel} from './panel.js';
import {Controls, NAVIGATION_KEYS, handleBoundKey} from './controls.js';
import {Player} from './player.js';
import {PlayerBar} from './playerBar.js';
import {NowPlayingView} from './nowPlaying.js';
import {openItemMenu} from './itemMenu.js';
import {MusicSearchProvider} from './searchProvider.js';
import * as amctl from './amctl.js';

// The section a search result's kind maps onto, for the tab its detail is
// shown against. A song has no tab of its own; its detail opens as an album
// would.
const KIND_TO_SECTION = {
    album: 'albums', artist: 'artists', playlist: 'playlists', station: 'radio', song: 'albums',
};

// SECTIONS is a flat list now (no per-video-section registry to import), so
// the lookup a picked item's key needs is kept here.
function sectionByKey(key) {
    return SECTIONS.find(s => s.key === key) ?? SECTIONS[0];
}

// Gap between the surface and the work-area edges, in logical px.
const OUTER_MARGIN = 28;
// workspaceAnimation.js WINDOW_ANIMATION_TIME — exported only from 50, so restated.
const WORKSPACE_SLIDE_TIME = 250;
// The places a workspace of ours can show, as `_placeForWorkspace` names them:
// the library, or a picked item on a page of its own. There is one library,
// one pane and one pick, so there is only ever one of each.
const LIBRARY = 'library';
const DETAIL = 'detail';

// Now Playing, popped up the way an item's detail is (panel.js) when
// `detail-opens-in` is not a surface place — a plain host for the shared
// NowPlayingView, with no tile of its own to zoom out of or die with.
const NowPlayingPanel = GObject.registerClass(
class MusicMenuNowPlayingPanel extends MediaPanel {
    _init({view, size = 0.8}) {
        super._init({size, dieWithSource: false, inset: PANE_INSET, accessibleName: 'Now Playing'});
        this._view = view;
        view.actor.x_expand = true;
        view.actor.y_expand = true;
        this._panel.add_child(view.actor);
    }

    _sizePanel(budget) {
        this._panel.remove_all_transitions();
        this._panel.set_size(budget.width, budget.height);
        this._restSize = [budget.width, budget.height];
    }
});

// Is this workspace still one of the manager's? A claimed workspace is
// removed under us as what claimed it closes, and `Meta.Workspace.index()` on a
// removed one is a failed assertion — a libmutter CRITICAL in the journal —
// before it returns -1. There are only ever a handful of workspaces, so ask
// the manager for them instead.
function workspaceIsLive(workspace) {
    if (!workspace)
        return false;
    const wm = global.workspace_manager;
    for (let i = 0; i < wm.n_workspaces; i++) {
        if (wm.get_workspace_by_index(i) === workspace)
            return true;
    }
    return false;
}

export class MusicMenuApp {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._container = null;
        this._stack = null;
        this._overlay = null;
        // The library's page on the surface, when the library opens there.
        this._library = null;
        // The pane's own page — a header over the pane, no grid — built the
        // first time a pick needs one that is not taking the grid's place.
        this._detailPage = null;
        // The pane on the surface, for picks that open there; null when they
        // pop up instead.
        this._detail = null;
        // The popup of the "menu" and "modal" detail modes; null when picks
        // open on the surface.
        this._dialog = null;
        this._sections = {};
        // The tab the library is on, wherever it is browsed. It outlives a
        // rebuild, so the library comes back on the tab it was left on.
        this._sectionKey = null;
        // Whether the library's page shows its grid or, in its place, a pick.
        this._mode = 'library';
        // The page actually on the stack. A rebuild empties the stack without
        // changing what the workspace is set to show, which is exactly when
        // the page has to be put back — so this, not the place, is what
        // `_onWorkspaceChanged` compares against.
        this._shown = null;
        this._busy = false;
        this._reloadWanted = false;
        // Workspaces given up and still being slid away from, and what each
        // was showing: the slide still wants a picture of them.
        this._leaving = new Map();
        this._heroFrom = null;
        this._monitor = null;
        this._previews = null;
        // The one way in, wherever the library opens. It lives as long as the
        // extension does rather than per build, so a rescan does not take it
        // out of the dash and put it back.
        this._button = new LibraryButton({
            path: extension.path,
            onActivate: () => this._toggleLibrary(),
        });
        // Where the library is browsed when not on the surface: the menu view
        // or the window view. Null when it is drawn on the surface.
        this._browser = null;
        // The pick on show on the surface, and the workspace the library was
        // opened from or the pick was made on — which is where Back and the
        // way out return to.
        this._picked = null;
        this._origin = null;
        this._builtBounds = null;
        this._rebuildTimer = 0;
        this._closeTimer = 0;
        this._keptAlive = [];
        // The workspace the library is up on: the one it was brought up on in
        // 'desktop', the one it claimed in 'workspaces', null while it is put
        // away. Held as a workspace, not an index, since indices shift as
        // others close.
        this._libraryWorkspace = null;
        // And the one the pane was given, when a pick opens in 'workspaces'.
        this._detailWorkspace = null;
        // Follows the engine's MPRIS player; one for the whole extension.
        this._player = null;
        // The player bar built into whichever LibraryView's footer is
        // showing, when the 'player-bar' setting is on.
        this._playerBar = null;
        // The full now-playing view, and the popup it opens in when the
        // library's detail pane is not on the surface.
        this._nowPlayingView = null;
        this._nowPlayingPanel = null;
        // The overview's search entry, backed by am.py search.
        this._searchProvider = null;
        this._syncTimer = 0;
        // Remotes, controllers and keys of the user's own (controls.js).
        this._controls = new Controls(this._settings, {
            isActive: () => this._controlsActive(),
            onHome: () => this._closeLibrary(),
            onOpen: () => this._controlsOpen(),
            onPlayPause: () => this._player?.playPause(),
            currentView: () => this._browser?.currentView ??
                (this._mode === 'library' ? this._library?.currentView : null),
        });
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------
    enable() {
        // lib/ runs from a staged copy (extension.js), so amctl cannot find
        // backend/am.py relative to itself: it needs the extension's own
        // directory, not the stage.
        amctl.setExtensionPath(this._extension.path);
        this._controls.enable();
        this._player = new Player();
        this._player.connectObject('changed', () => this._syncNowPlayingTrack(), this);
        this._syncPlayerBar();
        this._searchProvider = new MusicSearchProvider({
            onActivate: item => this._activateSearchResult(item),
        });
        this._searchProvider.register();
        this._sections = loadLibrary();
        this._build();
        this._scheduleSync();

        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._onWorkspaceChanged(),
            'workspace-removed', () => this._onWorkspaceRemoved(),
            this);
        // Panels and docks register their struts after we are enabled at
        // login, so the work area we sized against can change under us.
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._onGeometryChanged(),
            'startup-complete', () => this._onGeometryChanged(),
            this);
        global.display.connectObject('workareas-changed',
            () => this._onGeometryChanged(), this);
        // Every size in JS is physical pixels, worked out from the scale
        // factor as it was; a change of it is a change of everything.
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor',
            () => this._scheduleRebuild(), this);
        // Whatever had the keyboard is forever being hidden or destroyed under
        // us — a tile as its grid recedes, a list as the detail pane is filled
        // — and Clutter drops key focus to the stage when that happens. The
        // overview takes it too, while it is up. So the surface watches for
        // the keyboard going nowhere and takes it back.
        global.stage.connectObject('notify::key-focus',
            () => this._onStageFocusChanged(), this);
        Main.overview.connectObject('hidden',
            () => this._syncKeyFocus(this._onTarget()), this);

        const rebuildKeys = ['columns', 'rows', 'grid-align', 'corner-radius', 'detail-size',
            ...SECTIONS.map(s => `${s.prefix}-enabled`)];
        for (const key of rebuildKeys)
            this._settings.connectObject(`changed::${key}`, () => this._scheduleRebuild(), this);
        // The player bar is built fresh into whichever LibraryView is footer
        // shows; toggling it rebuilds so every place picks it up or drops it.
        this._settings.connectObject('changed::player-bar', () => {
            this._syncPlayerBar();
            this._scheduleRebuild();
        }, this);
        this._settings.connectObject('changed::sync-interval', () => this._scheduleSync(), this);
        // What a claimed workspace means differs between the places, so none
        // is carried from one to the other; nor is a pick, which may have
        // been opened somewhere the new setting has no room for.
        for (const key of ['library-opens-in', 'detail-opens-in']) {
            this._settings.connectObject(`changed::${key}`, () => {
                this._libraryWorkspace = this._detailWorkspace = null;
                this._picked = this._origin = null;
                this._scheduleRebuild();
            }, this);
        }

        // The library's shortcut, grabbed the way the shell grabs its own:
        // the setting holds the accelerators, and mutter follows it as it
        // changes, so a shortcut set in the preferences works at once. In the
        // overview as well as on the desktop, as Super+A is — and over a
        // popup, which is only so the modal library's own panel can be closed
        // with it; see `_onShortcut`.
        Main.wm.addKeybinding('library-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._onShortcut());

        // The scanner writes library.json atomically; refresh when it lands so
        // a rescan from the preferences shows up without touching the shell.
        try {
            const file = Gio.File.new_for_path(libraryPath());
            this._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', (_m, _f, _o, event) => {
                if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                    event === Gio.FileMonitorEvent.CREATED ||
                    event === Gio.FileMonitorEvent.RENAMED ||
                    event === Gio.FileMonitorEvent.MOVED_IN) {
                    this._scheduleRebuild({reload: true, delay: 400});
                }
            });
        } catch (e) {
            console.warn(`[Music Menu] Could not watch library.json: ${e}`);
        }

        this._syncVisibility(false);
    }

    disable() {
        Main.wm.removeKeybinding('library-shortcut');
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.stage.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this._settings.disconnectObject(this);
        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }
        for (const id of [this._rebuildTimer, this._closeTimer, this._syncTimer]) {
            if (id)
                GLib.source_remove(id);
        }
        this._rebuildTimer = this._closeTimer = this._syncTimer = 0;
        this._leaving.clear();
        this._teardown();
        this._button.detach();
        this._libraryWorkspace = this._detailWorkspace = null;
        this._picked = this._origin = null;
        this._keepOnly(new Set());
        this._sections = {};
        this._searchProvider?.unregister();
        this._searchProvider = null;
        this._nowPlayingPanel?.destroy();
        this._nowPlayingPanel = null;
        this._nowPlayingView?.destroy();
        this._nowPlayingView = null;
        this._playerBar?.destroy();
        this._playerBar = null;
        this._player?.disconnectObject(this);
        this._player?.destroy();
        this._player = null;
        this._controls.disable();
    }

    _teardown() {
        this._previews?.destroy();
        this._previews = null;
        // Closes whatever it had open, too.
        this._browser?.disable();
        this._browser = null;
        // The pages are the container's children, and go with it; the pane
        // and the popup host themselves. The now-playing view is shared with
        // the pop-up panel, though, and outlives a rebuild — detached rather
        // than destroyed along with the page that was hosting it.
        if (this._nowPlayingView && this._detailPage?.stack.contains(this._nowPlayingView.actor))
            this._detailPage.stack.remove_child(this._nowPlayingView.actor);
        this._nowPlayingPanel?.popdown();
        this._library = null;
        this._detailPage = null;
        this._detail?.destroy();
        // Let go of the keyboard and the tile it came out of before it goes.
        this._dialog?.popdown();
        this._dialog?.destroy();
        // Forgotten before it is destroyed: destroying what holds the
        // keyboard drops key focus to the stage, and the watcher would hand
        // it straight back to the actor on its way out — which leaves the
        // stage holding a disposed one.
        const container = this._container;
        const stack = this._stack;
        this._detail = this._dialog = null;
        this._container = this._stack = this._overlay = null;
        if (stack)
            global.focus_manager.remove_group(stack);
        container?.destroy();
        this._busy = false;
        this._mode = 'library';
        this._shown = null;
    }

    // 'workareas-changed' is a claim that some work area may have changed: the
    // shell makes it whenever a workspace is added or removed, which opening
    // and closing the library on one of its own both do. A rebuild tears the
    // surface down and puts it back, so it waits for the box we actually draw
    // in to move.
    _onGeometryChanged() {
        const now = this._bounds();
        const was = this._builtBounds;
        if (!was || ['x', 'y', 'width', 'height'].some(k => now[k] !== was[k]))
            this._scheduleRebuild();
    }

    // Settings and geometry changes arrive in bursts (a slider dragged, every
    // monitor reporting in), and a rescan writes the library more than once;
    // `reload` rides the same timer so a burst of either is one rebuild.
    _scheduleRebuild({reload = false, delay = 150} = {}) {
        this._reloadWanted ||= reload;
        if (this._rebuildTimer)
            GLib.source_remove(this._rebuildTimer);
        this._rebuildTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._rebuildTimer = 0;
            if (this._reloadWanted)
                this._sections = loadLibrary();
            this._reloadWanted = false;
            // A browser being looked at is put back on the same tab once
            // rebuilt, so the change that caused the rebuild shows where it
            // is being looked for rather than on the next press.
            const browsing = this._browser?.state ?? null;
            this._teardown();
            this._build();
            this._syncVisibility(false);
            this._browser?.restore(browsing);
            console.log('[Music Menu] Rebuilt');
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------------
    // Settings helpers
    // ------------------------------------------------------------------
    _enabledSections() {
        return enabledSections(this._settings);
    }

    // The items behind a tab. Listen Now has no items of its own — library.js
    // always answers it with an empty array — its content is the shelves,
    // kept alongside the sections rather than as one of them.
    _itemsFor(key) {
        return key === 'listen-now' ? this._sections.shelves ?? [] : this._sections[key] ?? [];
    }

    // The two independent choices. Both are one of 'desktop', 'workspaces',
    // 'menu' or 'modal'; see the note at the top of this file.
    _libraryMode() {
        return this._settings.get_string('library-opens-in');
    }

    _detailMode() {
        return this._settings.get_string('detail-opens-in');
    }

    // Drawn on the wallpaper, as against browsed somewhere of the shell's.
    // The two surface places differ only in which workspace they land on, so
    // everything about *building* either is this question and not which.
    _libraryOnSurface() {
        const mode = this._libraryMode();
        return mode === 'desktop' || mode === 'workspaces';
    }

    _detailOnSurface() {
        const mode = this._detailMode();
        return mode === 'desktop' || mode === 'workspaces';
    }

    // The surface exists for either of them; with neither, nothing of ours is
    // drawn on the wallpaper at all.
    _surfaceWanted() {
        return this._libraryOnSurface() || this._detailOnSurface();
    }

    // A pick pops up in the folder's panel rather than landing on the surface.
    _detailPopsUp() {
        return !this._detailOnSurface();
    }

    // The one thing that follows from the pair rather than from either alone:
    // the pane lands on the very workspace the grid is on, so it takes the
    // grid's place there — the hero flies, the grid recedes — instead of being
    // somewhere to go to. Anything else gives the pane a page of its own.
    _detailInPlace() {
        return this._libraryOnSurface() && this._detailMode() === 'desktop';
    }

    // Who claims a workspace of their own, and so needs one held open.
    _libraryClaimsWorkspace() {
        return this._libraryMode() === 'workspaces';
    }

    _detailClaimsWorkspace() {
        return this._detailMode() === 'workspaces';
    }

    // The grid shape, for every grid in every view.
    _columns() {
        return this._settings.get_int('columns');
    }

    _rows() {
        return this._settings.get_int('rows');
    }

    // ------------------------------------------------------------------
    // Workspaces
    //
    // A workspace is claimed by whoever is set to open on one of their own:
    // the library, when it opens in 'workspaces'; the pane, when a pick does.
    // Either can be true without the other. In 'desktop' the library is only
    // ever on a workspace that was already there.
    //
    // GNOME's dynamic workspaces collapse any empty workspace that is not the
    // active or the last one, which would fold ours away the moment we slid
    // off one — and with it the way back, since an empty desktop left for the
    // library is just such a workspace. The workspace tracker spares one whose
    // _keepAliveId is set (the hook it uses itself while a window is being
    // dragged to a new workspace), so ours carry a long-lived timeout source
    // there until they are given up or the extension is disabled.
    // ------------------------------------------------------------------

    // What a workspace shows: LIBRARY, DETAIL for the pane on a page of its
    // own, or null when it is not one of ours. Workspaces are compared as
    // objects, never by index — see `workspaceIsLive`.
    _placeForWorkspace(workspace) {
        if (!workspace)
            return null;
        // The pane on a workspace of its own is that workspace's whole point.
        if (this._detailClaimsWorkspace() && this._picked &&
            workspace === this._detailWorkspace)
            return DETAIL;
        // With the library browsed elsewhere, a pane on the surface is on the
        // workspace the pick was made on, and is the only thing we draw.
        if (!this._libraryOnSurface()) {
            return this._detailOnSurface() && this._picked && workspace === this._origin
                ? DETAIL : null;
        }
        return workspace === this._libraryWorkspace ? LIBRARY : null;
    }

    // What is held open: the workspace the library is up on, the pane's, any
    // being slid away from, and — while something of ours is up somewhere
    // else — the way back to where it was opened from. What has gone with its
    // workspace, or with its section's setting, is forgotten. Called after
    // anything that changes one of them, and before the slide that follows.
    _holdWorkspaces() {
        if (!workspaceIsLive(this._libraryWorkspace))
            this._libraryWorkspace = null;
        if (!workspaceIsLive(this._detailWorkspace))
            this._detailWorkspace = null;
        if (!workspaceIsLive(this._origin))
            this._origin = null;
        if (this._picked && !this._enabledSections().some(s => s.key === this._picked.key))
            this._picked = null;

        const wanted = new Set(this._leaving.keys());
        for (const workspace of [this._libraryWorkspace, this._detailWorkspace]) {
            if (workspace)
                wanted.add(workspace);
        }
        const away = (this._libraryClaimsWorkspace() && this._libraryWorkspace) ||
            this._detailWorkspace || (!this._libraryOnSurface() && this._picked);
        if (away && this._origin)
            wanted.add(this._origin);
        this._keepOnly(wanted);
    }

    // Hold exactly `wanted` open, releasing whatever else we were holding.
    _keepOnly(wanted) {
        let released = false;
        this._keptAlive = this._keptAlive.filter(ws => {
            if (wanted.has(ws))
                return true;
            if (ws._keepAliveId) {
                GLib.source_remove(ws._keepAliveId);
                ws._keepAliveId = 0;
            }
            released = true;
            return false;
        });
        for (const ws of wanted) {
            // Set by someone else: the shell's own, mid drag-and-drop.
            if (!ws || ws._keepAliveId)
                continue;
            ws._keepAliveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GLib.MAXUINT32, () => GLib.SOURCE_CONTINUE);
            GLib.Source.set_name_by_id(ws._keepAliveId, '[music-menu] keep workspace');
            this._keptAlive.push(ws);
        }
        // Let the shell fold the now-empty workspaces back up.
        if (released)
            Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
    }

    // A free workspace, for the library, the pane or a player: nothing of ours
    // on it and no windows of its own. Dynamic workspaces always end in an
    // empty one, which is exactly what is wanted; holding it makes the shell
    // add the next. With a fixed number, the last one nothing is using.
    _claimWorkspace() {
        const wm = global.workspace_manager;
        const taken = new Set([this._libraryWorkspace, this._detailWorkspace]);
        const free = ws => ws && !taken.has(ws) && !ws._keepAliveId &&
            !ws.list_windows().some(w => !w.is_on_all_workspaces());
        if (Meta.prefs_get_dynamic_workspaces()) {
            const last = wm.get_workspace_by_index(wm.n_workspaces - 1);
            return free(last) ? last : wm.append_new_workspace(false, global.get_current_time());
        }
        for (let i = wm.n_workspaces - 1; i >= 0; i--) {
            const ws = wm.get_workspace_by_index(i);
            if (free(ws))
                return ws;
        }
        return null;
    }

    // Claim one and hold it open, or say why not. The caller activates it.
    _takeWorkspace(what) {
        const workspace = this._claimWorkspace();
        if (!workspace) {
            console.warn(`[Music Menu] No free workspace to open ${what} on ` +
                '(Settings → Multitasking, or open it on the desktop instead).');
            return null;
        }
        this._keepOnly(new Set([...this._keptAlive, workspace]));
        Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
        return workspace;
    }

    // Let claimed workspaces go, once the slide away from them is over — the
    // shell must not be removing a workspace it is still animating from, and
    // that slide still wants a picture of what it is leaving (`_pictureFor`).
    // `given` maps each to the place it was showing.
    _releaseWorkspaces(given) {
        for (const [workspace, place] of given)
            this._leaving.set(workspace, place);
        if (this._closeTimer)
            GLib.source_remove(this._closeTimer);
        // The slide honours the animations toggle and slow-down factor, so
        // the wait for it does too.
        this._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            adjustAnimationTime(WORKSPACE_SLIDE_TIME) + 50, () => {
                this._closeTimer = 0;
                this._leaving.clear();
                this._holdWorkspaces();
                this._previews?.invalidate();
                return GLib.SOURCE_REMOVE;
            });
    }

    // Somewhere to land that is not ours, when where we came from has gone:
    // the nearest workspace before the ones being given up, or failing that
    // any other.
    _landing(given) {
        const wm = global.workspace_manager;
        const first = Math.min(...given.map(ws => ws.index()));
        for (let i = first - 1; i >= 0; i--) {
            const ws = wm.get_workspace_by_index(i);
            if (!given.includes(ws))
                return ws;
        }
        for (let i = 0; i < wm.n_workspaces; i++) {
            const ws = wm.get_workspace_by_index(i);
            if (!given.includes(ws))
                return ws;
        }
        return null;
    }

    // ------------------------------------------------------------------
    // In and out
    // ------------------------------------------------------------------

    // The button, or the shortcut: the library, wherever it opens, or — when
    // it is what is up — the way back out. A browser is pressed as its own
    // button would be. On the surface the overview goes, and the library
    // comes up on this workspace or on its own; pressed where the library is
    // already up, it is put away again.
    _toggleLibrary() {
        if (this._browser) {
            if (!this._browser.isShowing)
                this._maybeAutostartEngine();
            this._browser.toggle(this._sectionKey);
            return;
        }
        if (!this._libraryOnSurface() || this._busy)
            return;
        const overview = Main.overview.visible;
        const here = this._placeForWorkspace(global.workspace_manager.get_active_workspace());
        if (here && !overview) {
            this._closeLibrary();
            return;
        }
        this._maybeAutostartEngine();
        Main.overview.hide();
        this._openLibrary({reveal: !overview});
    }

    // The library up. In 'desktop' it is on the wallpaper of the workspace
    // you are on, and moves here if it was up on another. In 'workspaces' it
    // is on its own, claimed on the way if it is not held already, and slid
    // to; `_onWorkspaceChanged` puts the page up as the slide begins, and
    // the slide is the only transition. Either way, one already up where it
    // is going is left as it was — a pick open in it included.
    _openLibrary({reveal = true} = {}) {
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace();
        if (!this._libraryClaimsWorkspace()) {
            if (this._libraryWorkspace !== active || this._shown !== LIBRARY) {
                this._libraryWorkspace = active;
                this._holdWorkspaces();
                this._showLibraryNow({reveal});
            }
            this._syncVisibility(true);
            this._previews?.invalidate();
            return;
        }
        let workspace = this._libraryWorkspace;
        if (!workspaceIsLive(workspace)) {
            workspace = this._takeWorkspace('the library');
            if (!workspace)
                return;
            this._libraryWorkspace = workspace;
        }
        if (workspace === active) {
            if (this._shown !== LIBRARY)
                this._showLibraryNow({reveal});
            this._syncVisibility(true);
            return;
        }
        this._origin = active;
        this._holdWorkspaces();
        workspace.activate(global.get_current_time());
    }

    // The library put away, and whatever of it was up with it: the popup,
    // the browser, a pick on a page or a workspace of its own. Whatever was
    // claimed is given up behind the slide back to where it was opened from.
    _closeLibrary() {
        if (this._busy)
            return;
        this._dialog?.popdown();
        this._nowPlayingPanel?.popdown();
        this._browser?.close();
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace();
        const given = new Map();
        if (this._libraryClaimsWorkspace() && workspaceIsLive(this._libraryWorkspace))
            given.set(this._libraryWorkspace, LIBRARY);
        if (workspaceIsLive(this._detailWorkspace))
            given.set(this._detailWorkspace, DETAIL);
        // In 'desktop' the library holds no workspace of its own, so a pick
        // on one goes back to the workspace the library was brought up on.
        const home = this._libraryOnSurface() && !this._libraryClaimsWorkspace()
            ? this._libraryWorkspace : this._origin;

        this._picked = null;
        this._libraryWorkspace = this._detailWorkspace = null;

        if (given.has(active)) {
            const claimed = [...given.keys()];
            const to = workspaceIsLive(home) && !given.has(home) ? home : this._landing(claimed);
            to?.activate(global.get_current_time());
        }
        this._syncVisibility(true);
        if (given.size)
            this._releaseWorkspaces(given);
        this._holdWorkspaces();
        this._previews?.invalidate();
    }

    // The shortcut is the button's press, wherever the library opens.
    _onShortcut() {
        // A popup holds the keyboard for itself — a menu in the top bar, the
        // detail pop-up — unless it is the modal library's panel, which the
        // shortcut closes as the button does.
        if (Main.actionMode === Shell.ActionMode.POPUP &&
            !(this._browser instanceof LibraryWindow && this._browser.isShowing))
            return;
        this._toggleLibrary();
    }

    // Is the library what has the keyboard — a pop-up of ours, a browser on
    // show, or the surface on a workspace no window has the focus of? A
    // controller is only acted on while it is.
    _controlsActive() {
        if (this._dialog?.isOpen || this._browser?.isShowing)
            return true;
        return !!this._container?.visible && this._onTarget() && !Main.overview.visible &&
            !global.display.focus_window && Main.modalCount === 0;
    }

    // Home on a controller with nothing of ours up: the library, opened, when
    // nothing else has the keyboard — never over a window, where it would
    // be a game's Start button too.
    _controlsOpen() {
        if (global.display.focus_window || Main.modalCount > 0)
            return;
        this._maybeAutostartEngine();
        if (this._browser) {
            this._browser.open(this._sectionKey);
            return;
        }
        if (this._libraryOnSurface())
            this._openLibrary();
    }

    // Everything that goes to the preferences goes out of the library first,
    // or the overview or a panel of ours would be over the window.
    _openSettings() {
        this._dialog?.popdown();
        this._nowPlayingPanel?.popdown();
        this._browser?.close();
        this._extension.openPreferences();
    }

    // A workspace going can take the library or a pick with it, and shifts the
    // index of everything after it — so what the active one shows is asked
    // again. Nothing on the surface needs building for that.
    _onWorkspaceRemoved() {
        this._holdWorkspaces();
        this._previews?.invalidate();
        this._onWorkspaceChanged();
    }

    _onWorkspaceChanged() {
        const place = this._placeForWorkspace(global.workspace_manager.get_active_workspace());
        // Against `_shown`: after a rebuild nothing is on the stack, which is
        // exactly when the page must be put back. A workspace that is not
        // ours leaves what is there alone — the surface is hidden on it
        // either way.
        if (place && place !== this._shown) {
            if (place === DETAIL)
                this._showDetailNow();
            else
                this._showLibraryNow();
        }
        this._syncVisibility(true);
    }

    // A browser -> an item: the library is somewhere of the shell's, so there
    // is no grid of ours for the pane to take the place of. It pops up, or it
    // goes on the surface — on the workspace the pick was made from, or on one
    // of its own, which is claimed before the slide that brings it in.
    //
    // A "modal" pane wants the desktop to itself, so the browser goes first
    // (the popup hides the overview itself).
    _openPicked(key, item, tile) {
        if (this._dialog) {
            if (this._detailMode() === 'modal')
                this._browser.close();
            this._dialog.popup(tile, item, sectionByKey(key));
            return;
        }
        this._browser.close();
        const active = global.workspace_manager.get_active_workspace();
        if (this._placeForWorkspace(active) === null)
            this._origin = active;
        this._showDetail(key, item);
    }

    // The pane onto the surface, wherever this pick is set to open it. Shared
    // by a pick made in a browser and one made on the grid of ours when that
    // is not in the pane's way (`_detailInPlace` is when it is).
    _showDetail(key, item) {
        this._picked = {key, item};
        if (!this._detailClaimsWorkspace()) {
            this._holdWorkspaces();
            this._showDetailNow({reveal: true});
            this._syncVisibility(true);
            this._previews?.invalidate();
            return;
        }
        let workspace = this._detailWorkspace;
        if (!workspaceIsLive(workspace)) {
            workspace = this._takeWorkspace('a picked item');
            if (!workspace) {
                // Nowhere to put it: show it where we already are rather than
                // swallowing the press.
                this._detailWorkspace = null;
                this._showDetailNow({reveal: true});
                this._syncVisibility(true);
                return;
            }
            this._detailWorkspace = workspace;
        }
        this._holdWorkspaces();
        // In place before the slide that brings it in.
        this._showDetailNow();
        workspace.activate(global.get_current_time());
        this._syncVisibility(true);
    }

    // The library's page back to its grid, whatever was in flight on it.
    _resetViews() {
        if (!this._container)
            return;
        this._overlay.destroy_all_children();
        this._detail?.actor.remove_all_transitions();
        this._detail?.actor.hide();
        this._nowPlayingView?.actor.hide();
        const grid = this._library?.currentView;
        if (grid) {
            grid.remove_all_transitions();
            grid.set_scale(1, 1);
            grid.opacity = 255;
            grid.show();
        }
        this._library?.header.setLibraryMode(false);
        this._busy = false;
    }

    // Straight to the library, abandoning any pick open in it. The shell's
    // slide is the transition when the workspace changes, so the page is
    // simply there when it lands; `reveal` staggers it in, for a move that no
    // slide carries.
    _showLibraryNow({reveal = false} = {}) {
        if (!this._container || !this._library)
            return;
        this._resetViews();
        this._mode = 'library';
        this._detailPage?.actor.hide();
        this._library.actor.show();
        this._library.show(this._sectionKey, {reveal});
        this._shown = LIBRARY;
    }

    // The pane on a page of its own, which is what it gets whenever it is not
    // taking the place of the grid: put there outright, since the shell's
    // slide — or the reveal, when there is no slide — is what brings it in.
    _showDetailNow({reveal = false} = {}) {
        if (!this._container || !this._picked)
            return;
        this._resetViews();
        this._mode = 'detail';
        const {key, item} = this._picked;
        const section = sectionByKey(key);
        const page = this._detailPageFor(section);
        this._library?.actor.hide();
        page.actor.show();
        this._attachDetail(page.stack);
        this._detail.populate(item, section);
        const actor = this._detail.actor;
        actor.remove_all_transitions();
        actor.opacity = 255;
        actor.translation_y = 0;
        actor.show();
        // Landing without a workspace change, so no slide brings it in: the
        // same rise the in-place flight gives it, and no curve of its own.
        if (reveal) {
            actor.opacity = 0;
            actor.translation_y = 24;
            actor.ease({
                opacity: 255,
                translation_y: 0,
                duration: Duration.SLOW,
                mode: Ease.OUT_EXPO,
            });
        }
        this._shown = DETAIL;
    }

    // The detail pane is shared, and moves into whichever page wants it: its
    // own, or the library's when it is replacing the grid.
    _attachDetail(stack) {
        const actor = this._detail?.actor;
        if (!actor || actor.get_parent() === stack)
            return;
        actor.get_parent()?.remove_child(actor);
        stack.add_child(actor);
    }

    // ------------------------------------------------------------------
    // Player, sync and search
    // ------------------------------------------------------------------

    // Built (or torn down) to match the 'player-bar' setting. Persists across
    // a rebuild — a new LibraryView's footer just gets it reattached
    // (libraryView.js `setFooter` detaches rather than destroying it) — so
    // there is one bar and one Player for the whole session.
    _syncPlayerBar() {
        const wanted = this._settings.get_boolean('player-bar');
        if (wanted && !this._playerBar && this._player) {
            this._playerBar = new PlayerBar({
                player: this._player,
                onOpenNowPlaying: () => this._openNowPlaying(),
            });
        } else if (!wanted && this._playerBar) {
            this._playerBar.destroy();
            this._playerBar = null;
        }
    }

    // The now-playing view, opened in whichever detail place is in use: the
    // shared pop-up host (panel.js) in "menu"/"modal", or the pane's own page
    // on the surface. There is one of each, built the first time it is wanted.
    _openNowPlaying() {
        if (!this._player)
            return;
        if (!this._nowPlayingView) {
            this._nowPlayingView = new NowPlayingView({player: this._player});
            this._syncNowPlayingTrack();
        }
        // A workspace of its own for the pane (`detail-opens-in: workspaces`)
        // is not worth tracking for now-playing too — a pane that is not a
        // library pick has no `_placeForWorkspace` place of its own — so that
        // case, like the pop-up ones, uses the shared popup host instead.
        if (this._detailPopsUp() || this._detailClaimsWorkspace()) {
            if (!this._nowPlayingPanel) {
                this._nowPlayingPanel = new NowPlayingPanel({
                    view: this._nowPlayingView,
                    size: this._settings.get_int('detail-size') / 100,
                });
            }
            this._nowPlayingPanel.popup();
            return;
        }
        if (!this._surfaceWanted())
            return;
        this._resetViews();
        this._mode = 'now-playing';
        this._library?.actor.hide();
        const page = this._detailPageFor({title: 'Now Playing'});
        const actor = this._nowPlayingView.actor;
        if (actor.get_parent() !== page.stack) {
            actor.get_parent()?.remove_child(actor);
            page.stack.add_child(actor);
        }
        this._detail?.actor.hide();
        page.actor.show();
        actor.show();
        this._shown = DETAIL;
    }

    // The currently-playing track, for the pane's rows to highlight — read off
    // the Player's own state rather than tracked here, so it is right however
    // playback started (the library, MPRIS from elsewhere, another machine).
    _syncNowPlayingTrack() {
        const track = this._player?.state?.track ?? null;
        const id = track?.catalogId ?? track?.id ?? null;
        this._detail?.setNowPlayingTrack(id);
        this._dialog?.setNowPlayingTrack(id);
    }

    // Automatic sync: every 'sync-interval' minutes (0 = off), and once on
    // enable if 'last-sync' is already older than that.
    _scheduleSync() {
        if (this._syncTimer) {
            GLib.source_remove(this._syncTimer);
            this._syncTimer = 0;
        }
        const minutes = this._settings.get_int('sync-interval');
        if (!minutes)
            return;
        const intervalMs = minutes * 60 * 1000;
        const last = Date.parse(this._settings.get_string('last-sync') || '');
        const overdue = !last || Date.now() - last >= intervalMs;
        if (overdue)
            this._runSync();
        this._syncTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this._runSync();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _runSync() {
        try {
            await amctl.run(['sync']);
            this._settings.set_string('last-sync', new Date().toISOString());
        } catch (e) {
            console.warn(`[Music Menu] Automatic sync failed: ${e.message}`);
        }
    }

    // Started headlessly the moment the library is opened, so it is ready by
    // the time anything on screen wants to play or search.
    _maybeAutostartEngine() {
        if (this._settings.get_boolean('engine-autostart'))
            amctl.fire(['engine', 'start']);
    }

    // A result picked in the overview's search: a groupless item (no track
    // list yet) is filled in first, then shown as any other pick — popped up,
    // or on the surface's pane, whichever `detail-opens-in` says.
    async _activateSearchResult(item) {
        let full = item;
        if (!item.groups) {
            try {
                full = await amctl.run(['item', item.kind, item.id]);
            } catch (e) {
                console.warn(`[Music Menu] Could not load ${item.kind} ${item.id}: ${e.message}`);
            }
        }
        const key = KIND_TO_SECTION[full.kind] ?? 'albums';
        const section = sectionByKey(key);
        Main.overview.hide();
        if (this._dialog) {
            this._dialog.popup(null, full, section);
            return;
        }
        if (this._detailOnSurface())
            this._showDetail(key, full);
    }

    // ------------------------------------------------------------------
    // Building
    // ------------------------------------------------------------------
    _build() {
        // Every rounded surface reads its radius as it is constructed, so the
        // setting has to be in place before anything below is built.
        setCornerRadius(this._settings.get_int('corner-radius'));
        setGridAlign(this._settings.get_string('grid-align'));

        // Recorded first, whatever is built below: a geometry change compares
        // against it, and without it every 'workareas-changed' would rebuild.
        const bounds = this._builtBounds = this._bounds();

        // With no section switched on there is no library to open, and no
        // button to open it with.
        const sections = this._enabledSections();
        this._holdWorkspaces();
        if (!sections.length) {
            this._button.detach();
            this._libraryWorkspace = this._detailWorkspace = null;
            this._picked = null;
            this._holdWorkspaces();
            return;
        }
        // The tab it was left on, or the first with anything in it.
        if (!sections.some(s => s.key === this._sectionKey))
            this._sectionKey = (sections.find(s => this._itemsFor(s.key)?.length) ?? sections[0]).key;
        this._button.attach();

        // A pick that pops up has a pane of its own, in the folder's panel;
        // it hosts itself over whatever it is opened from.
        if (this._detailPopsUp()) {
            this._dialog = new DetailDialog({
                onMenu: ({item, track, sourceActor}) => openItemMenu({item, track, sourceActor}),
                size: this._settings.get_int('detail-size') / 100,
                mode: this._detailMode(),
            });
            this._syncNowPlayingTrack();
        }

        // One way of browsing at a time: a browser of its own — the library
        // as a second application menu in the overview, or in a panel popped
        // out of its button — or a page here.
        if (!this._libraryOnSurface()) {
            const Browser = this._libraryMode() === 'modal' ? LibraryWindow : MediaMenu;
            this._browser = new Browser({
                sections,
                itemsFor: key => this._itemsFor(key),
                onActivate: (key, item, tile) => this._openPicked(key, item, tile),
                onContextMenu: (item, tile) => openItemMenu({item, sourceActor: tile}),
                columns: this._columns(),
                rows: this._rows(),
                button: this._button,
                onSwitch: key => (this._sectionKey = key),
                onOpenSettings: () => this._openSettings(),
                footer: this._playerBar?.actor ?? null,
            });
            this._browser.enable();
        }

        // The library browsed elsewhere and the pane popping up: nothing of
        // ours is drawn on the wallpaper at all, so there is no surface.
        if (!this._surfaceWanted())
            return;

        this._container = new St.Widget({
            name: 'MusicMenuContainer',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: true,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        });

        // Escape is ours: it is the way back out, one level at a time. It
        // reaches the surface by bubbling up from whatever holds the keyboard.
        this._container.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        // The surface takes the clicks the wallpaper would have had, its menu
        // included. Handing it back with the shell's own addBackgroundMenu
        // (backgroundMenu.js) was tried and dropped: its long-press gesture
        // on the surface wins over a tile's click, so holding a poster opened
        // the wallpaper menu rather than the item.

        // Pages share the surface, one visible at a time.
        this._stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._container.add_child(this._stack);

        // Tab and the arrow keys move between tabs, tiles, rows and buttons
        // because what holds them is a focus group, as the shell's own
        // dialogs and menus are — St does the walking. The group is the stack
        // and not the surface around it: a focus group that can take the
        // keyboard itself yields the focus rather than passing it on
        // (st_widget_real_navigate_focus), and the surface is focusable
        // because it is what holds the keyboard while nothing else does.
        global.focus_manager.add_group(this._stack);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (this._detailOnSurface()) {
            this._detail = new DetailView({
                onMenu: ({item, track, sourceActor}) => openItemMenu({item, track, sourceActor}),
            });
            this._detail.setSize(bounds.width, bounds.height - HEADER_ALLOWANCE * scale);
            this._detail.actor.hide();
            this._syncNowPlayingTrack();
        }

        const onSurface = this._libraryOnSurface();
        if (onSurface)
            this._buildLibrary(bounds, sections);

        // Clones in flight between the two views live above both.
        this._overlay = new Clutter.Actor({x_expand: true, y_expand: true});
        this._container.add_child(this._overlay);

        const group = Main.layoutManager._backgroundGroup;
        if (group)
            group.add_child(this._container);
        else
            global.window_group.insert_child_at_index(this._container, 0);

        // What the active workspace shows, or — on a workspace that is not
        // ours — the page it would be, so that sliding onto one of ours finds
        // it built rather than a blank surface.
        const place = this._placeForWorkspace(global.workspace_manager.get_active_workspace());
        if (place === DETAIL || (!place && !onSurface && this._picked))
            this._showDetailNow({reveal: !!place});
        else if (onSurface)
            this._showLibraryNow({reveal: !!place});

        // The overview never shows this surface — it builds its own wallpaper
        // for every workspace preview — so each gets a clone of its page.
        this._previews = new OverviewPreview({
            placeForWorkspace: workspace => this._pictureFor(workspace),
            sourceFor: where => this._actorForPlace(where),
            bounds,
        });
        this._previews.enable();

        // The pane's page is a header and nothing else until something is
        // picked, so only the library's tabs are worth building ahead.
        if (onSurface)
            this._library.prebuild();
    }

    // The library's page: the tabs over the grids, with the way to the
    // preferences and the way out at the header's far end.
    _buildLibrary(bounds, sections) {
        const {width, height} = bounds;
        const settings = createIconButton('preferences-system-symbolic', {accessibleName: 'Settings'});
        settings.connect('clicked', () => this._openSettings());
        const close = createIconButton('window-close-symbolic', {accessibleName: 'Close'});
        close.connect('clicked', () => this._closeLibrary());
        this._library = new LibraryView({
            sections,
            itemsFor: key => this._itemsFor(key),
            active: this._sectionKey,
            width,
            height,
            columns: this._columns(),
            rows: this._rows(),
            onActivate: (key, item, tile) => this._openItem(key, item, tile),
            onContextMenu: (item, tile) => openItemMenu({item, sourceActor: tile}),
            onSwitch: key => (this._sectionKey = key),
            onBack: () => this._goBack(),
            end: [settings, close],
            onOpenSettings: () => this._openSettings(),
        });
        this._library.setFooter(this._playerBar?.actor ?? null);
        // Sized outright: a clone lays a hidden source out at the size it asks
        // for, and the overview's pictures of the workspace are clones of it.
        this._library.actor.set_size(width, height);
        this._library.actor.hide();
        // In the stack: that is the focus group.
        this._stack.add_child(this._library.actor);
    }

    // The pane's own page: a header over the shared pane, and no grid. One
    // serves every section, since there is one pane and one pick — its header
    // is retitled to whichever section the pick came from.
    _detailPageFor(section) {
        if (!this._detailPage) {
            const {width, height} = this._builtBounds;
            const actor = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                width, height, visible: false,
            });
            // Shared between a picked item's pane and the now-playing page;
            // which one Back leads out of follows the mode on show.
            const header = createHeader({
                sections: [],
                onBack: () => (this._mode === 'now-playing' ? this._closeNowPlaying() : this._goBack()),
            });
            actor.add_child(header.actor);
            const stack = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: true, y_expand: true,
            });
            actor.add_child(stack);
            this._stack.add_child(actor);
            this._detailPage = {actor, header, stack};
        }
        this._detailPage.header.setDetailMode(section.title);
        return this._detailPage;
    }

    // The actor the overview should clone for a place.
    _actorForPlace(place) {
        return place === DETAIL ? this._detailPage?.actor : this._library?.actor;
    }

    // What the shell's picture of a workspace shows. A workspace on its way
    // out is no longer ours, but the slide it leaves by still draws it.
    _pictureFor(workspace) {
        if (!workspace)
            return null;
        return this._leaving.get(workspace) ?? this._placeForWorkspace(workspace);
    }

    // The surface fills the monitor's work area (so docks and panels from
    // other extensions are respected), inset by a margin.
    _bounds() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const margin = OUTER_MARGIN * scale;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return {x: margin, y: margin, width: 1920 - 2 * margin, height: 1080 - 2 * margin};
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        return {
            x: area.x + margin,
            y: area.y + margin,
            width: area.width - 2 * margin,
            height: area.height - 2 * margin,
        };
    }

    // ------------------------------------------------------------------
    // Navigation
    // ------------------------------------------------------------------
    // The grid of ours -> an item. The flight below is what a pick looks like
    // only when the pane lands on this very workspace, in the grid's place:
    // the artwork flies to the hero slot while the grid recedes and the pane
    // rises. A pick that pops up zooms the panel out of the tile and leaves
    // the page as it is; one that opens somewhere else goes there instead.
    async _openItem(key, item, tile) {
        if (this._busy || this._mode !== 'library')
            return;
        const section = sectionByKey(key);
        if (this._dialog) {
            this._dialog.popup(tile, item, section);
            return;
        }
        if (!this._detailInPlace()) {
            this._showDetail(key, item);
            return;
        }
        this._busy = true;
        this._mode = 'detail';

        const library = this._library;
        this._attachDetail(library.stack);
        // A grid tile's artwork is a child actor the hero flies from; a
        // shelf's tile (listen-now) may simply be its own artwork.
        const art = tile.artwork ?? tile;
        const from = rectIn(art, this._container);
        this._heroFrom = {item, from};

        this._detail.populate(item, section);
        const detailActor = this._detail.actor;
        detailActor.opacity = 0;
        detailActor.translation_y = 0;
        detailActor.show();
        allocateNow(detailActor);
        const hero = this._detail.hero;
        hero.opacity = 0;
        const to = rectIn(hero, this._container);

        library.header.setDetailMode(section.title, true);

        const grid = library.currentView;
        grid.set_pivot_point(0.5, 0.5);
        grid.ease({
            opacity: 0,
            scale_x: POP_SCALE,
            scale_y: POP_SCALE,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
            onComplete: () => {
                grid.hide();
                grid.set_scale(1, 1);
                grid.opacity = 255;
            },
        });

        detailActor.translation_y = 24;
        detailActor.ease({
            opacity: 255,
            translation_y: 0,
            duration: Duration.SLOW,
            mode: Ease.OUT_EXPO,
        });

        art.opacity = 0;
        await flyClone(this._overlay, art, from, to);
        hero.opacity = 255;
        art.opacity = 255;
        this._busy = false;
    }

    // Detail -> library. In place, it is the flight mirrored: the hero flies
    // back to its tile while the grid comes forward again. From a pane that
    // is somewhere of its own, it is a move back to wherever the library is:
    // its workspace, or — browsed elsewhere — the workspace the pick was made
    // on, with the browser open again on the pick's tab.
    async _goBack() {
        if (!this._detailInPlace()) {
            if (this._busy)
                return;
            const wm = global.workspace_manager;
            const key = this._picked?.key ?? this._sectionKey;
            const detailWorkspace = workspaceIsLive(this._detailWorkspace) ? this._detailWorkspace : null;
            this._picked = null;
            this._detailWorkspace = null;
            this._sectionKey = key;

            // Where the library is, or was brought up from; one that has gone
            // since is found again from where we land.
            let to = this._libraryOnSurface() ? this._libraryWorkspace : this._origin;
            if (!workspaceIsLive(to) || to === detailWorkspace)
                to = workspaceIsLive(this._origin) && this._origin !== detailWorkspace ? this._origin : null;
            if (!to && detailWorkspace)
                to = this._landing([detailWorkspace]);
            to ??= wm.get_active_workspace();

            if (!this._libraryOnSurface()) {
                this._browser?.open(key);
            } else if (this._libraryClaimsWorkspace() && !workspaceIsLive(this._libraryWorkspace)) {
                // Its workspace has gone: claimed again, from where we land.
                to.activate(global.get_current_time());
                this._openLibrary();
                if (detailWorkspace)
                    this._releaseWorkspaces(new Map([[detailWorkspace, DETAIL]]));
                return;
            } else {
                this._libraryWorkspace = to;
                this._showLibraryNow({reveal: to === wm.get_active_workspace()});
            }
            to.activate(global.get_current_time());
            this._syncVisibility(true);
            if (detailWorkspace)
                this._releaseWorkspaces(new Map([[detailWorkspace, DETAIL]]));
            else
                this._previews?.invalidate();
            this._holdWorkspaces();
            return;
        }
        if (this._busy || this._mode !== 'detail')
            return;
        this._busy = true;
        this._mode = 'library';

        const detailActor = this._detail.actor;
        const hero = this._detail.hero;
        const library = this._library;
        const grid = library.currentView;
        const remembered = this._heroFrom;
        // A shelf (listen-now) has no `tileFor`: nothing to fly the hero back
        // onto, so it simply fades away with the pane.
        const tile = remembered ? grid?.tileFor?.(remembered.item.id) ?? null : null;

        library.header.setLibraryMode(true);

        grid.set_pivot_point(0.5, 0.5);
        grid.set_scale(POP_SCALE, POP_SCALE);
        grid.opacity = 0;
        grid.show();
        grid.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: Duration.SLOW,
            mode: Ease.OUT_EXPO,
        });

        detailActor.ease({
            opacity: 0,
            translation_y: 24,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
            onComplete: () => {
                detailActor.hide();
                detailActor.translation_y = 0;
            },
        });

        if (tile && hero) {
            const from = rectIn(hero, this._container);
            hero.opacity = 0;
            tile.artwork.opacity = 0;
            await flyClone(this._overlay, hero, from, remembered.from);
            tile.artwork.opacity = 255;
        }
        this._busy = false;
    }

    // ------------------------------------------------------------------
    // Keyboard
    // ------------------------------------------------------------------
    // Escape backs out a level, as it does everywhere in the shell: out of an
    // item to the library, out of the library altogether. Everything else —
    // Tab, the arrows, Enter on a tile — is St's own focus handling, and the
    // step between the tabs and the grid is the library view's.
    _onKeyPress(event) {
        // A key a remote or a binding of the user's makes something else.
        if (handleBoundKey(event))
            return Clutter.EVENT_STOP;
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            if (this._mode === 'now-playing')
                this._closeNowPlaying();
            else if (this._mode === 'detail')
                this._goBack();
            else
                this._closeLibrary();
            return Clutter.EVENT_STOP;
        }
        // Nothing is focused until a navigation key asks for it — as the app
        // grid has it, where the first Tab lands on the first icon. From there
        // the focus manager walks the group on its own.
        if (NAVIGATION_KEYS.includes(symbol) &&
            global.stage.get_key_focus() === this._container) {
            // The library says where its keyboard starts; the pane hands the
            // first key to St, which finds the first thing that can take it.
            if (this._mode === 'now-playing'
                ? this._nowPlayingView?.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false)
                : this._mode === 'detail'
                    ? this._detail?.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false)
                    : this._library?.focusFirst())
                return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Back out of the now-playing page, to the library — a plain switch
    // rather than `_goBack`'s hero-flight bookkeeping, which is for a picked
    // item and not for this.
    _closeNowPlaying() {
        if (this._mode !== 'now-playing')
            return;
        this._nowPlayingView?.actor.hide();
        this._showLibraryNow({reveal: true});
    }

    // Is the active workspace one of ours?
    _onTarget() {
        return this._placeForWorkspace(global.workspace_manager.get_active_workspace()) !== null;
    }

    // Key focus has gone somewhere: if it went nowhere at all, and the surface
    // is what the workspace shows, it is ours to take back. Focus that has
    // gone to another actor — a menu, the panel — is left where it is, and
    // so is the keyboard while anything holds a grab: our popup, or another
    // extension's panel over the surface (Games Menu's), whose own focus can
    // drop to the stage as what had it inside is destroyed.
    _onStageFocusChanged() {
        if (!this._container)
            return;
        if (Main.overview.visible || Main.modalCount > 0 || global.stage.get_key_focus())
            return;
        this._syncKeyFocus(this._onTarget());
    }

    // The surface takes the keyboard while it is what the workspace shows, and
    // gives it back when it is not. A window on the workspace keeps it either
    // way: its keys never reach the stage.
    _syncKeyFocus(onTarget) {
        if (!this._container)
            return;
        const focus = global.stage.get_key_focus();
        const ours = focus && this._container.contains(focus);
        if (onTarget && !ours)
            global.stage.set_key_focus(this._container);
        else if (!onTarget && ours)
            global.stage.set_key_focus(null);
    }

    // ------------------------------------------------------------------
    // Visibility
    // ------------------------------------------------------------------
    _syncVisibility(animate) {
        const onTarget = this._onTarget();
        // A browser lights the button itself; on the surface it is lit while
        // the library, or a pick of it, is what this workspace shows.
        if (this._libraryOnSurface())
            this._button.sync(onTarget);
        if (!this._container)
            return;
        this._syncKeyFocus(onTarget);
        if (!animate) {
            this._container.visible = onTarget;
            this._container.opacity = onTarget ? 255 : 0;
            return;
        }
        // Already there, as it is on every move between two of our own.
        if (this._container.visible === onTarget && this._container.opacity === (onTarget ? 255 : 0))
            return;
        // Fade in step with the shell's own workspace switch.
        fadeTo(this._container, onTarget ? 255 : 0, {duration: Duration.NORMAL});
    }
}
