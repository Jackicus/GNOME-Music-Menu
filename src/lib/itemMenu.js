// The right-click / ••• menu for a library item or a single track row: Play,
// Shuffle, Play Next/Later, Love, Add to Library, Add to Playlist and Copy
// Link. Modelled on the app grid's own context menu — appDisplay.js builds
// one `AppMenu` (appMenu.js) per icon, parents it into Main.uiGroup and hands
// it to a PopupMenuManager so a click outside, Escape or the overview hiding
// all close it the way any shell menu does. This menu is opened fresh for
// every click instead (there is no long-lived icon to hang one off), so it
// destroys itself the moment it closes rather than being cached on a widget.
//
// Every action is a fire-and-forget `amctl.run()`: the menu doesn't wait
// around for Apple Music to answer, it just tells the user when the engine
// says no.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

import {run, AmError} from './amctl.js';

// A library id is the sync'd id of an album (l.), playlist (p.) or library
// song/track (i.); anything else is a bare catalog id, not yet in the
// library.
const LIBRARY_ID = /^[lpi]\./;

function friendlyMessage(e) {
    if (e instanceof AmError) {
        if (e.code === 'not-signed-in')
            return "Sign in to Apple Music in Music Menu's settings";
        if (e.code === 'engine-down')
            return "Apple Music isn't running right now";
        if (e.message)
            return e.message;
    }
    return 'Something went wrong talking to Apple Music';
}

function notifyFailure(e) {
    console.warn(`[Music Menu] item menu action failed: ${e?.code ?? e}`);
    Main.notify('Music Menu', friendlyMessage(e));
}

// The group (and the track's place in it) that `am.py play --start-with`
// needs to play a track in context, found by matching the track's own id
// against every group's entries. `item.groups` is only populated for the
// item the row came from (an album, a playlist, an artist's albums…), so a
// track handed to us without its item's groups — or one no group claims —
// falls back to playing just the song.
function findGroup(item, track) {
    for (const group of item.groups ?? []) {
        const entry = group.entries?.find(e => e.id === track.id);
        if (entry)
            return {group, entry};
    }
    return null;
}

export function openItemMenu({item, track = null, sourceActor}) {
    const menu = new PopupMenu.PopupMenu(sourceActor, 0.5, St.Side.TOP);
    menu.actor.add_style_class_name('mm-item-menu');
    Main.uiGroup.add_child(menu.actor);

    // A menu manager of its own: this menu doesn't outlive the click that
    // opened it, so there is nothing to share a manager with.
    const manager = new PopupMenu.PopupMenuManager(sourceActor);
    manager.addMenu(menu);

    // With a track, every action but Play targets the song itself; without
    // one, they target whatever the item itself plays (its `play` field, or
    // the item as its own kind/id if that's missing).
    const target = track
        ? {kind: 'song', id: track.catalogId || track.id}
        : item.play ?? {kind: item.kind, id: item.id};

    menu.addAction('Play', () => {
        if (track) {
            const found = findGroup(item, track);
            const promise = found
                ? run(['play', found.group.play.kind, found.group.play.id,
                    '--start-with', String(found.entry.index)])
                : run(['play', 'song', track.catalogId || track.id]);
            promise.catch(notifyFailure);
        } else {
            run(['play', target.kind, target.id]).catch(notifyFailure);
        }
    }, 'media-playback-start-symbolic');

    menu.addAction('Shuffle', () => {
        run(['play', target.kind, target.id, '--shuffle']).catch(notifyFailure);
    }, 'media-playlist-shuffle-symbolic');

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    menu.addAction('Play Next', () => {
        run(['play-next', target.kind, target.id]).catch(notifyFailure);
    }, 'media-skip-forward-symbolic');

    menu.addAction('Play Later', () => {
        run(['play-later', target.kind, target.id]).catch(notifyFailure);
    }, 'bookmark-new-symbolic');

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    menu.addAction('Love', () => {
        run(['love', target.kind, target.id]).catch(notifyFailure);
    }, 'emblem-favorite-symbolic');

    // "The item" here is whatever the target is: the track's own id when
    // there is one, else the item's. A track from a synced library always
    // has a library id already, so this only ever shows for a song found by
    // search, or for an album/playlist/artist not yet in the library.
    if (!LIBRARY_ID.test(target.id)) {
        menu.addAction('Add to Library', () => {
            run(['add-to-library', target.kind, target.id]).catch(notifyFailure);
        }, 'list-add-symbolic');
    }

    const playlistItem = new PopupMenu.PopupSubMenuMenuItem('Add to Playlist', true);
    playlistItem.icon.icon_name = 'view-list-symbolic';
    menu.addMenuItem(playlistItem);

    const loadingItem = new PopupMenu.PopupMenuItem('Loading…', {reactive: false, can_focus: false});
    loadingItem.add_style_class_name('mm-item-menu-hint');
    playlistItem.menu.addMenuItem(loadingItem);

    // Filled the first time the submenu is opened, not up front: most menus
    // are never expanded that far, and `playlists` is one more am.py spawn.
    let playlistsLoaded = false;
    playlistItem.menu.connect('open-state-changed', (submenu, isOpen) => {
        if (!isOpen || playlistsLoaded)
            return;
        playlistsLoaded = true;
        run(['playlists']).then(({items: playlists = []}) => {
            submenu.removeAll();
            if (playlists.length === 0) {
                const empty = new PopupMenu.PopupMenuItem('No playlists', {reactive: false, can_focus: false});
                empty.add_style_class_name('mm-item-menu-hint');
                submenu.addMenuItem(empty);
                return;
            }
            const songId = track ? (track.catalogId || track.id) : (item.catalogId || item.id);
            for (const playlist of playlists) {
                submenu.addAction(playlist.title, () => {
                    run(['add-to-playlist', playlist.id, songId]).catch(notifyFailure);
                });
            }
        }).catch(e => {
            submenu.removeAll();
            notifyFailure(e);
        });
    });

    if (item.url) {
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Copy Link', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.url);
        }, 'edit-copy-symbolic');
    }

    // The app grid's own AppMenu leaves itself to be reopened; this one has
    // no owner to hold it, so it destroys itself the moment it closes,
    // exactly like a one-shot GTK context menu would.
    menu.connect('open-state-changed', (_m, isOpen) => {
        if (!isOpen)
            menu.destroy();
    });

    menu.open(BoxPointer.PopupAnimation.FULL);
}
