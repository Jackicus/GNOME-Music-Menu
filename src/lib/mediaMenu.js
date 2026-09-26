// A second application menu, of media. The "menu" library.
//
// The view is the library from libraryView.js — tabs over the shell's own app
// grid with posters in it — put inside the app grid's slot, a child of the
// AppDisplay shown in place of the grid's own box, so the overview allocates
// it, slides it up and hides it for search exactly as it does the apps.
//
// The library's button beside Show Apps (libraryButton.js) is the only way
// in: it opens the overview straight onto the library, and pressed again it
// closes what it opened. That is the rule the docks' Show Apps follows (Dash
// to Panel and Dash to Dock both keep a `forcedOverview` flag): a button
// pressed on the desktop opened the overview itself, so a second press — or
// Escape — takes the overview down and lands back on the desktop; pressed with
// the overview already up, it only goes back to the window picker, as the
// shell's own Show Apps does. And whatever way out of such an overview is
// taken goes all the way down: Show Apps unchecked with the view up closes it
// (a dock only keeps its own `forcedOverview`, so left standing it would
// settle on the window picker, and every Show Apps press after that came back
// there rather than to the desktop). Show Apps itself is left alone: it leaves
// the grid as it always has, and what the grid shows when it is next opened
// is the apps, because the view only lives as long as the grid is up.
//
// Another extension can put a view of its own into the same slot the same
// way — Games Menu does — and the button pressed while that one is up closes
// the overview and opens it again onto ours: two of the shell's own
// transitions, rather than two views drawn over each other.
//
// What is ours here: the workspaces row above the grid is folded away while
// the view is up, so the posters get its room. And the shell's own search,
// begun with the view up, is put to Apple Music's providers and to no
// other: typing runs the search exactly as it runs over the app grid — the
// view fades out under the results and comes back as the search ends —
// but only Apple Music answers, laid out as its own search box lays its
// answers out (searchProvider.js). Before anything is typed, the keyboard
// in the empty entry puts Apple Music's own search page in the view's
// place (landingView.js): recent picks and categories to browse, a
// category opening as a page of shelves in the tabs' place. Everywhere
// else in the overview the search is the shell's own, Apple Music one
// provider among the rest.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {Duration, Ease} from './anim.js';
import {LandingView} from './landingView.js';
import {LibraryView} from './libraryView.js';

// The overview gives the dash no more than this share of its height, and
// leaves this much of it between its rows (DASH_MAX_HEIGHT_RATIO and
// VERTICAL_SPACING_RATIO, overviewControls.js:22-23, which it does not export).
const DASH_MAX_SHARE = 0.16;
const VERTICAL_SPACING_SHARE = 0.02;

// `object[name]` wrapped around whatever is there — the prototype's method,
// or another extension's wrap of it — chain-safely, as `_foldWorkspaces`
// wraps the layout's: `make(through, live)` builds the wrap, with `through`
// the call on to what was there and `live()` whether ours is still wanted.
// Answers with what puts it back: what was there before, if ours is still
// the outermost — taking ours out from under someone else's wrap would take
// theirs with it — and after that ours, left in their chain, calls straight
// through.
function wrapMethod(object, name, make) {
    const stock = object[name];
    const own = Object.hasOwn(object, name) ? stock : null;
    let live = true;
    const wrapped = make((self, args) => stock.apply(self, args), () => live);
    object[name] = wrapped;
    return () => {
        live = false;
        if (object[name] !== wrapped)
            return;
        if (own)
            object[name] = own;
        else
            delete object[name];
    };
}

export class MediaMenu {
    // `button` is the library's button beside Show Apps, which the app holds
    // and hands to whichever place the library opens in; `onSwitch` hears of
    // a tab chosen here. `search` is Apple Music in the shell's search
    // (searchProvider.js MusicSearch), whose providers a search begun with
    // the view up is put to and no other; `recents` (recents.js) is what
    // was picked out of searches, for the search page; `onSearchPick(item)`
    // is one of those picked again, and `onCategory(category)` a category
    // picked, answered with its page `{title, shelves}` or null.
    constructor({sections, itemsFor, onActivate, onContextMenu, columns, rows, button, onSwitch, onOpenSettings, playerBar = null,
        search = null, recents = null, onSearchPick = null, onCategory = null}) {
        this._sections = sections;
        this._itemsFor = itemsFor;
        this._onActivate = onActivate;
        this._onContextMenu = onContextMenu;
        this._columns = columns;
        this._rows = rows;
        this._button = button;
        this._onSwitch = onSwitch;
        this._onOpenSettings = onOpenSettings;
        this._search = search;
        this._recents = recents;
        this._onSearchPick = onSearchPick;
        this._onCategory = onCategory;
        // The search page before anything is typed (landingView.js), and
        // whether it is what the slot shows in the library's place.
        this._landing = null;
        this._landingUp = false;
        this._landingIdle = 0;
        // The player bar (app.js), reattached to every LibraryView this menu
        // builds — a resize drops and rebuilds the view, but the bar itself
        // is a singleton for the whole extension.
        this._playerBar = playerBar;
        this._library = null;
        // Whether the view is what the app grid shows, and which tab it is on.
        this._showing = false;
        this._key = sections[0]?.key ?? null;
        // The slot the shell's own layout last measured for the view, and the
        // box the view standing was actually built for.
        this._slot = null;
        this._box = null;
        // How far the workspaces were last left folded, 0 to 1.
        this._fold = 0;
        // Whether the overview that is up is one our button opened.
        this._forced = false;
        this._keyId = 0;
        // Whether the search up is Apple Music's alone (see _takeSearch),
        // and what puts the shell's results view back.
        this._exclusive = false;
        this._restoreSearch = null;
        // The tab to open onto once the overview has gone down, when another
        // extension's view was up in the slot (see the top of this file).
        this._next = null;
        this._reopenId = 0;
    }

    enable() {
        this._controls = Main.overview._overview?.controls ?? null;
        this._appDisplay = this._controls?.appDisplay ?? null;
        // The app grid's own content; ours take turns with it.
        this._appsBox = this._appDisplay?._box ?? null;
        if (!this._appDisplay || !this._appsBox || !this._sections.length) {
            if (this._sections.length)
                console.warn('[Music Menu] The overview is not laid out as expected; no media menu.');
            this._appsBox = null;
            return;
        }

        // Gone from view is back to apps, so Show Apps always shows apps.
        //
        // Show Apps' own checked state says whether the grid is up: the shell
        // checks it as the grid opens and unchecks it on every way out —
        // Escape, a swipe, a search, leaving the overview — so that is what
        // our view follows. (The app display's visibility does not: it is held
        // on for the whole slide down to the window picker, which used to
        // leave a view up with nothing showing it and Show Apps still ours,
        // so the next click on it went nowhere.)
        //
        // Unchecked with the view up in an overview our button opened, that
        // is Show Apps pressed — or the app grid stepped down from — and the
        // overview goes down whole, as it does for Escape.
        // Not while a swipe is landing (the shell unchecks before it eases,
        // and the gesture is the shell's), and not for a search, which
        // unchecks as it starts and puts the grid back as it ends.
        this._showAppsButton = Main.overview.dash.showAppsButton;
        this._showAppsButton.connectObject('notify::checked', button => {
            if (button.checked)
                return;
            const leaving = this._showing && this._forced &&
                Main.overview.visible && !Main.overview.animationInProgress &&
                !this._adjustment?.gestureInProgress &&
                !this._controls._searchController?.searchActive;
            this._show(false);
            if (leaving)
                Main.overview.hide();
        }, this);

        // A search begun with the view up is Apple Music's alone, until it
        // ends (_takeSearch). And the end of one shows the workspaces again,
        // whatever is up, and settles whether the search page or the tab
        // comes back (_syncLanding).
        this._controls._searchController?.connectObject('notify::search-active', controller => {
            this._setExclusive(controller.searchActive && this.isShowing);
            if (!controller.searchActive && this._showing)
                this._syncWorkspaces(true);
            this._queueLandingSync();
        }, this);

        // The search page follows the keyboard into the empty entry
        // (_syncLanding), and goes at a press outside it (_onCapturedPress).
        global.stage.connectObject(
            'notify::key-focus', () => this._queueLandingSync(),
            'captured-event::button', (_stage, event) => this._onCapturedPress(event),
            'captured-event::touch', (_stage, event) => this._onCapturedPress(event),
            this);

        this._adjustment = this._controls._stateAdjustment ?? null;
        this._adjustment?.connectObject('notify::value', () => this._syncWorkspaces(), this);

        // Keys seen ahead of everyone — see _onCapturedKey. Keyed on the
        // event type, as the date menu keys its own captures
        // (dateMenu.js:923-931), so the pointer crossing the overview never
        // reaches JS. The `key` detail is wider than a key press — releases
        // and the input method's own events carry it too — and asking one
        // of those for a key symbol is a Clutter assertion, so the type is
        // checked first, exactly as the date menu's handler does
        // (calendar.js:860).
        this._keyId = global.stage.connect('captured-event::key',
            (_stage, event) => this._onCapturedKey(event));

        this._takeSearch();

        // However the overview goes, it is nobody's forced one any more —
        // and if it went down to make way for ours, it comes back up onto
        // the library, off the idle so the shell's own hide has finished
        // with it first.
        Main.overview.connectObject('hidden', () => {
            this._unforce();
            const next = this._next;
            this._next = null;
            if (next && !this._reopenId) {
                this._reopenId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._reopenId = 0;
                    this.open(next);
                    return GLib.SOURCE_REMOVE;
                });
            }
        }, this);

        this._foldWorkspaces();
    }

    disable() {
        if (!this._appsBox)
            return;
        this._show(false);
        // Only if it is still ours: someone may have wrapped it since, and
        // taking ours out from under theirs would take theirs with it. Left
        // in, ours does nothing once the view is gone.
        const layout = this._controls.layout_manager;
        if (this._foldedBox && layout._getAppDisplayBoxForState === this._foldedBox) {
            if (this._stockBox)
                layout._getAppDisplayBoxForState = this._stockBox;
            else
                delete layout._getAppDisplayBoxForState;
        }
        this._foldedBox = this._stockBox = null;
        this._controls.queue_relayout();
        this._showAppsButton?.disconnectObject(this);
        this._showAppsButton = null;
        Main.overview.disconnectObject(this);
        this._unforce();
        if (this._keyId)
            global.stage.disconnect(this._keyId);
        this._keyId = 0;
        global.stage.disconnectObject(this);
        if (this._landingIdle)
            GLib.source_remove(this._landingIdle);
        this._landingIdle = 0;
        this._restoreSearch?.();
        this._restoreSearch = null;
        this._setExclusive(false);
        if (this._reopenId)
            GLib.source_remove(this._reopenId);
        this._reopenId = 0;
        this._next = null;
        this._controls._searchController?.disconnectObject(this);
        this._adjustment?.disconnectObject(this);
        this._adjustment = null;
        this._dropView();
        this._slot = null;
        this._controls = this._appDisplay = this._appsBox = null;
    }

    // In the app grid state the overview keeps a row of small workspaces above
    // the grid and gives the grid what is left. While the view is up the
    // grid's box is grown over that row instead, and the row faded out (see
    // _syncWorkspaces) — the workspaces keep their box, because the shell
    // divides by its height.
    _foldWorkspaces() {
        const layout = this._controls.layout_manager;
        const stock = layout._getAppDisplayBoxForState;
        if (typeof stock !== 'function')
            return;
        const menu = this;
        // Put back as it was on the way out: another extension's own wrap,
        // when it was there first, or nothing, for the prototype's.
        this._stockBox = Object.hasOwn(layout, '_getAppDisplayBoxForState') ? stock : null;
        // Six arguments since GNOME 47; five before.
        const folded = function (state, box, searchHeight, dashHeight, workspacesBox, spacing) {
            const slot = stock.call(this, state, box, searchHeight, dashHeight, workspacesBox, spacing);
            // Left in someone else's chain after a disable, it does nothing.
            if (menu._foldedBox !== folded)
                return slot;
            // The folded slot, for the next time the view has to be built
            // before it is ever allocated — measured by the shell's own
            // method rather than taken from `stock`, which can be another
            // extension's wrap that has already grown the slot for a view of
            // its own (Games Menu folds the same row).
            const own = Object.getPrototypeOf(this)._getAppDisplayBoxForState;
            const shell = own && own !== stock
                ? own.call(this, state, box, searchHeight, dashHeight, workspacesBox, spacing) : slot;
            menu._slot = [shell.get_width(), shell.get_height() + workspacesBox.get_height() + spacing];
            if (!menu._showing)
                return slot;
            // The same size in every state, as the shell has it, so the slide
            // up from the window picker moves the slot without stretching it.
            const extra = workspacesBox.get_height() + spacing;
            const [x, y] = slot.get_origin();
            const [width, height] = slot.get_size();
            slot.set_origin(x, state === ControlsState.APP_GRID ? y - extra : y);
            slot.set_size(width, height + extra);
            return slot;
        };
        this._foldedBox = layout._getAppDisplayBoxForState = folded;
    }

    // How far the row of workspaces is folded away follows the overview's own
    // state: not at all up to the window picker, wholly in the app grid. So
    // the workspace shrinks towards its row and fades on the way in, and grows
    // back out of it on the way out, in step with whatever is moving the
    // overview — Show Apps, Super, a swipe — rather than on a clock of ours.
    // Only a change of view, when the overview is standing still, is eased.
    _syncWorkspaces(animate = false) {
        // An ease of ours can outlast the menu.
        const workspaces = this._controls?._workspacesDisplay;
        // A search has them hidden, and brings them back itself.
        if (!workspaces || this._controls._searchController?.searchActive)
            return;
        const state = this._adjustment?.value ?? ControlsState.WINDOW_PICKER;
        const fold = this._showing
            ? Math.clamp(state - ControlsState.WINDOW_PICKER, 0, 1) : 0;
        // Nothing of ours to undo, which is every frame the overview moves
        // with the apps up: the workspaces are the shell's to animate.
        if (!fold && !this._fold)
            return;
        const opacity = Math.round(255 * (1 - fold));

        // As the shell hides them for a search: out of sight, and then out
        // of picking. The row lies over the top of the grown slot, and a
        // workspace that is only transparent still takes a poster's click.
        if (fold < 1) {
            workspaces.reactive = true;
            workspaces.setPrimaryWorkspaceVisible?.(true);
        }
        workspaces.remove_transition('opacity');
        if (animate && workspaces.mapped && workspaces.opacity !== opacity) {
            workspaces.ease({
                opacity,
                duration: Duration.NORMAL,
                mode: Ease.OUT,
                onComplete: () => this._syncWorkspaces(),
            });
            return;
        }
        this._fold = fold;
        workspaces.opacity = opacity;
        if (fold === 1) {
            workspaces.reactive = false;
            workspaces.setPrimaryWorkspaceVisible?.(false);
        }
    }

    // The button, or the shortcut: the library, opening the overview onto it
    // if need be; or, when that is what is up, the way back out — to the
    // desktop if this is an overview our button opened, else unchecked, which
    // the shell takes back to the window picker.
    toggle(key = null) {
        if (this.isShowing) {
            if (this._forced)
                Main.overview.hide();
            else
                this._showAppsButton.checked = false;
            return;
        }
        this.open(key);
    }

    // The way out, whatever is up: the view only exists while the overview
    // does, so taking the overview down closes it.
    close() {
        Main.overview.hide();
    }

    // The view is what the overview is showing.
    get isShowing() {
        return Main.overview.visible && !!this._showAppsButton?.checked && this._showing;
    }

    // Its grid on show, for a page turn with the keyboard not yet in it.
    get currentView() {
        return this.isShowing ? this._library?.currentView ?? null : null;
    }

    // Whether something is up that a rebuild would take out from under the
    // user — a search, its page, a room — for app.js to hold a fresh
    // library.json back until it is not.
    get busy() {
        if (!this.isShowing)
            return false;
        return this._landingUp || !!this._library?.room ||
            !!this._controls?._searchController?.searchActive;
    }

    // What is up, for a rebuild to put back: the tab showing, and whether the
    // overview it is in is one our button opened. A rebuild tears this menu
    // down and makes another (a change of `columns`, a rescan landing), and
    // without this the overview was left on the app grid, with the library
    // gone and the new column count nowhere to be seen until the button was
    // pressed again.
    get state() {
        return {key: this._showing ? this._key : null, forced: this._forced};
    }

    // The tab `state` names back into the overview, if that is still up —
    // otherwise there is nothing to restore into, and the next press builds
    // the view fresh anyway.
    restore(state) {
        if (!state?.key || !this._appsBox || !Main.overview.visible)
            return;
        if (state.forced)
            this._force();
        this.open(state.key);
    }

    // The overview, on the library: opened onto it, or brought up to the grid
    // if it is already showing. `key` is the tab, or the one last shown.
    open(key = null) {
        this._next = null;
        if (!this._appsBox)
            return;
        if (this._sections.some(s => s.key === key))
            this._key = key;
        // Another extension's view in the slot: the overview goes down and
        // comes back up onto ours (`hidden`, above).
        if (Main.overview.visible && this._showAppsButton.checked &&
            !this._showing && !this._appsBox.visible) {
            this._next = this._key;
            Main.overview.hide();
            return;
        }
        this._show(true);
        if (Main.overview.visible) {
            this._showAppsButton.checked = true;
            return;
        }
        this._force();
        Main.overview.show(ControlsState.APP_GRID);
    }

    // An overview of our own opening: Escape on the view closes it whole
    // (_onCapturedKey).
    _force() {
        this._forced = true;
    }

    _unforce() {
        this._forced = false;
    }

    // Keys on the view, seen in the stage's capture phase — ahead of the
    // shell's own Escape handler, which is on the stage's bubbling phase,
    // and of St's focus manager, which takes the arrows in the capture
    // phase before any view of ours. Only with the view up, and never over
    // a popup (an item's menu) or the shell's own search, which keep their
    // own keys. Escape steps back one thing at a time, where the shell's
    // would step the app grid down (and take a forced overview with it):
    // the search page, if that is up, with the keyboard let out of the
    // entry as the shell's own Escape there lets it; then a room; and in an
    // overview our button opened, Escape closes it whole — the desktop is
    // where it was opened from — where the shell's would only step down to
    // the window picker. Not with the keyboard in an empty entry, whose
    // Escape is the shell's and only lets the keyboard go.
    _onCapturedKey(event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS ||
            !this._showing || !this._showAppsButton?.checked ||
            Main.modalCount > 1 || this._controls?._searchController?.searchActive)
            return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        if (symbol !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        if (this._landingUp) {
            this._hideLanding();
            this._controls._searchController?.reset?.();
            return Clutter.EVENT_STOP;
        }
        if (this._library?.room) {
            this._library.closeRoom();
            return Clutter.EVENT_STOP;
        }
        const text = Main.overview.searchEntry?.clutter_text ?? null;
        if (this._forced && !text?.has_key_focus()) {
            Main.overview.hide();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ------------------------------------------------------------------
    // The search page before anything is typed
    // ------------------------------------------------------------------
    // Apple Music's own search page opens on what it offers before a
    // letter is typed — recent picks, categories to browse — and so does
    // ours: the keyboard in the empty entry, by a click or a Tab, puts the
    // page (landingView.js) in the library's place in the slot, where the
    // shell's results would go. Up, it stays up for the keyboard leaving
    // the entry for nowhere — the shell's own click-away lets the keyboard
    // go on any press outside the entry (searchController.js
    // `_maybeCancelSearch`), a press on the page's own tiles included —
    // and for a search typed and cleared again, as Apple's does; it goes
    // for the keyboard moving to anything but the page itself, for a press
    // outside the page and the entry (_onCapturedPress), for Escape
    // (_onCapturedKey), and with the view. Judged off an idle rather than
    // on the focus change itself: a letter typed from the desktop focuses
    // the entry and fills it in one go, and by the idle both have settled.
    // With a search up nothing changes: the shell has the slot faded out,
    // and whether the page or the tab comes back is settled as the search
    // ends (`search-active`, enable).
    _queueLandingSync() {
        if (this._landingIdle || !this._appsBox)
            return;
        this._landingIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._landingIdle = 0;
            this._syncLanding();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncLanding() {
        if (this._controls?._searchController?.searchActive)
            return;
        const text = Main.overview.searchEntry?.clutter_text ?? null;
        const focus = global.stage.get_key_focus();
        const onPage = this._landingUp && (!focus || this._landing.actor.contains(focus));
        const wanted = this.isShowing && !!this._library && !!text && !text.text &&
            (focus === text || onPage);
        if (wanted)
            this._showLanding();
        else
            this._hideLanding();
    }

    // A press outside the page and the entry, seen ahead of everything:
    // the page goes, as a popover would, where the shell's own click-away
    // only lets the keyboard go. The press itself goes on to whatever it
    // was for.
    _onCapturedPress(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (!this._landingUp || Main.modalCount > 1)
            return Clutter.EVENT_PROPAGATE;
        const target = global.stage.get_event_actor(event);
        if (target && (this._landing.actor.contains(target) || Main.overview.searchEntry?.contains(target)))
            return Clutter.EVENT_PROPAGATE;
        this._hideLanding();
        return Clutter.EVENT_PROPAGATE;
    }

    _showLanding() {
        if (this._landingUp || !this._library)
            return;
        if (!this._landing) {
            const [width, height] = this._box ?? this._slotSize();
            this._landing = new LandingView({
                width,
                height,
                recents: this._recents,
                onActivate: item => this._onSearchPick?.(item),
                onCategory: category => this._openCategory(category),
                onOpenSettings: this._onOpenSettings,
            });
            this._landing.actor.hide();
            this._appDisplay.add_child(this._landing.actor);
        }
        this._landingUp = true;
        this._library.actor.hide();
        this._landing.refresh();
        this._landing.actor.show();
    }

    _hideLanding() {
        if (!this._landingUp)
            return;
        this._landingUp = false;
        this._landing?.actor.hide();
        this._library?.actor.show();
    }

    // A category picked on the page: its shelves, once the engine has
    // answered for them (the app asks), as a room in the tabs' place. The
    // keyboard is let go of first, or the page would come straight back
    // for it (_syncLanding).
    async _openCategory(category) {
        const page = await this._onCategory?.(category);
        if (!page || !this._library || !this.isShowing)
            return;
        global.stage.set_key_focus(null);
        this._hideLanding();
        this._library.openRoom(page);
    }

    // ------------------------------------------------------------------
    // The shell's search, Apple Music's alone while the view is up
    // ------------------------------------------------------------------
    // Typing with the view up runs the shell's own search, as it runs over
    // the app grid: the entry, its clear icon, its keys, the spinner and
    // the results are all the shell's, and the view fades out under them
    // and back in as the search ends (overviewControls.js
    // `_onSearchChanged`). What is ours is who answers. The results view
    // puts a search to each of its providers in turn (search.js
    // `_doProviderSearch`), and that is wrapped, on the instance and
    // chain-safely (wrapMethod): a search that is Apple Music's goes to its
    // own provider (searchProvider.js) and to no other, whose displays are
    // cleared rather than asked — results of theirs from an earlier search
    // would otherwise stand over Apple's. Whether a search is Apple Music's
    // is settled as it begins, by the view being what the overview shows,
    // and holds until it ends (`search-active`, enable), so no keystroke
    // puts one search to two sets of providers; the provider is told too,
    // and answers such a search from its first letter, with word of an
    // engine that is down where it would otherwise keep quiet.
    _takeSearch() {
        if (!this._search)
            return;
        const results = this._controls._searchController?._searchResults ?? null;
        if (typeof results?._doProviderSearch !== 'function') {
            console.warn('[Music Menu] The overview search is not laid out as expected; a search with the library up asks every provider.');
            return;
        }
        const menu = this;
        this._restoreSearch = wrapMethod(results, '_doProviderSearch', (through, live) => function (provider, previousResults) {
            if (live() && menu._exclusive && !menu._search.owns(provider)) {
                // As the shell's own `_reset` leaves a provider's display:
                // its rows gone, hidden, and any metas still coming let go.
                provider.display?.clear();
                return Promise.resolve();
            }
            return through(this, [provider, previousResults]);
        });
    }

    _setExclusive(exclusive) {
        if (exclusive === this._exclusive)
            return;
        this._exclusive = exclusive;
        if (this._search)
            this._search.exclusive = exclusive;
    }

    // ------------------------------------------------------------------
    // The view
    // ------------------------------------------------------------------
    // The library in the app grid's slot, or the apps again.
    _show(showing) {
        if (!this._appsBox)
            return;
        if (!showing)
            this._hideLanding();
        if (showing !== this._showing) {
            // Built against the slot as it stands, before the fold moves it.
            const library = showing ? this._view() : null;
            if (!showing)
                this._library?.actor.hide();
            this._showing = showing;
            this._appsBox.visible = !showing;
            if (library) {
                library.show(this._key);
                library.actor.show();
                library.currentView?.goToPage?.(0, false);
            }
            this._syncWorkspaces(true);
            this._controls.queue_relayout();
        } else if (showing) {
            this._library?.show(this._key);
        }
        // A toggle button unchecks itself when it is clicked while up.
        this._button.sync(this._showing);
    }

    // The slot as the overview will lay it out under the view: the one
    // the shell's own layout last handed us, or — for a button pressed
    // before the overview has ever been shown — worked out as that layout
    // does, since what the slot was last given says nothing of which of the
    // two sizes that was.
    //
    // Step for step the shell's `vfunc_allocate` (overviewControls.js:155-183),
    // the dash included whether or not it is visible: the shell measures it
    // either way, and Dash to Panel hides it. Reading the visibility instead
    // left this estimate a dash-height taller than the slot the shell went on
    // to hand out.
    _slotSize() {
        if (this._slot)
            return this._slot;
        const monitor = Main.layoutManager.primaryMonitor;
        // The overview is laid out in the work area, not on the monitor: the
        // shell's `box` here is already inset by the top bar and by whatever
        // else is reserved (Dash to Panel's panel, 48px of it). Measuring the
        // monitor instead left this a panel's height too tall.
        const {width, height} = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const spacing = Math.round(height * VERTICAL_SPACING_SHARE);
        const maxDash = Math.round(height * DASH_MAX_SHARE);
        const search = Main.overview.searchEntry?.get_parent();
        const searchHeight = search ? search.get_preferred_height(width)[0] : 0;
        const dash = Main.overview.dash;
        dash.setMaxSize(width, maxDash);
        const dashHeight = Math.min(dash.get_preferred_height(width)[1], maxDash);
        // What the apps get, plus the row of workspaces folded away above them.
        return [width, height - searchHeight - dashHeight - 2 * spacing];
    }

    // Built the first time it is wanted. The first press can come before the
    // overview has ever laid the slot out, and what that press gets is
    // `_slotSize`'s estimate; the shell's own measurement lands a moment later
    // and need not agree with it to the pixel. So the box the view standing
    // was built for is kept, and when it moves the view goes and is built
    // again against the new one — every tab at once, or `columns` would mean
    // one cover size in one section and another in the next.
    _view() {
        const [width, height] = this._slotSize();
        if (this._box && (this._box[0] !== width || this._box[1] !== height))
            this._dropView();
        this._box = [width, height];
        if (this._library)
            return this._library;

        this._library = new LibraryView({
            sections: this._sections,
            itemsFor: this._itemsFor,
            active: this._key,
            width,
            height,
            columns: this._columns,
            rows: this._rows,
            onActivate: this._onActivate,
            onContextMenu: this._onContextMenu,
            onSwitch: key => {
                this._key = key;
                this._onSwitch?.(key);
            },
            onOpenSettings: this._onOpenSettings,
        });
        this._library.setBar(this._playerBar);
        this._library.actor.visible = false;
        this._appDisplay.add_child(this._library.actor);
        return this._library;
    }

    _dropView() {
        this._landingUp = false;
        this._landing?.destroy();
        this._landing = null;
        this._library?.destroy();
        this._library = null;
        this._box = null;
    }
}
