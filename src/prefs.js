import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {ACTIONS as BASE_ACTIONS, NATIVE_KEYS, padLabel} from './lib/actions.js';

// In actions.js, 'watched' was renamed to 'play-pause' for Music Menu.
// We map it here so controls work whether actions.js has landed yet or not.
const ACTIONS = BASE_ACTIONS.map(action => {
    if (action.key === 'watched')
        return {key: 'play-pause', title: 'Play / Pause', subtitle: 'Plays or pauses playback'};
    return action;
});

// The one shortcut: the library's button, pressed from the keyboard.
const SHORTCUT_KEY = 'library-shortcut';

// Where the system's own shortcuts are kept, for a new one to be checked
// against: the window manager's, the shell's, mutter's and the media keys,
// whose `custom-keybindings` also lists the ones made in GNOME Settings.
const SYSTEM_KEYBINDINGS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];
const MEDIA_KEYS = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_KEYBINDING = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';

// Libadwaita's from 1.8 (GNOME 49); GTK's, deprecated since, before that.
const ShortcutLabel = Adw.ShortcutLabel ?? Gtk.ShortcutLabel;

// What a remote's keys are called. GTK's table predates the keys xkbcommon
// gives a remote's evdev codes (0x10081xxx) and shows those as numbers.
const REMOTE_KEYS = {
    0x10081160: 'OK',
    0x1008ffa0: 'Select',
    0x100810ae: 'Exit',
    0x1008ff18: 'Home',
    0x10081166: 'Info',
    0x10081192: 'Channel Up',
    0x10081193: 'Channel Down',
    0x100811b6: 'Context Menu',
};

export default class MusicMenuPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(720, 640);
        window.set_search_enabled(true);

        const state = {
            window,
            settings,
        };

        window.add(this._generalPage(state));
        window.add(this._appleMusicPage(state));
        window.add(this._controlsPage(state));
    }

    // ------------------------------------------------------------------
    // General
    // ------------------------------------------------------------------
    _generalPage(state) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        // --------------------------------------------------------------
        // Sections group
        // --------------------------------------------------------------
        const sectionsGroup = new Adw.PreferencesGroup({
            title: 'Sections',
            description: 'Tabs shown in the library',
        });
        page.add(sectionsGroup);

        const TABS = [
            {key: 'listen-now-enabled', title: 'Listen Now', subtitle: 'Heavy rotation, recently added and recommendations'},
            {key: 'albums-enabled', title: 'Albums', subtitle: 'Albums in your library'},
            {key: 'artists-enabled', title: 'Artists', subtitle: 'Artists in your library'},
            {key: 'playlists-enabled', title: 'Playlists', subtitle: 'Playlists in your library and Apple Music playlists'},
            {key: 'radio-enabled', title: 'Radio', subtitle: 'Apple Music radio stations'},
        ];

        for (const tab of TABS) {
            const row = new Adw.SwitchRow({
                title: tab.title,
                subtitle: tab.subtitle,
            });
            bindSetting(settings, tab.key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            sectionsGroup.add(row);
        }

        // --------------------------------------------------------------
        // View group
        // --------------------------------------------------------------
        const view = new Adw.PreferencesGroup({title: 'View'});
        page.add(view);

        const PLACES = [
            ['menu', 'Menu'],
            ['desktop', 'Desktop'],
            ['workspaces', 'Workspaces'],
            ['modal', 'Modal'],
        ];
        const toggles = () => {
            const group = new Adw.ToggleGroup({valign: Gtk.Align.CENTER, homogeneous: true, can_shrink: false});
            for (const [name, label] of PLACES)
                group.add(new Adw.Toggle({name, label}));
            return group;
        };

        const modes = toggles();
        const viewRow = new Adw.ActionRow({title: 'Library opens in'});
        viewRow.add_suffix(modes);
        view.add(viewRow);

        const details = toggles();
        const detailRow = new Adw.ActionRow({title: 'Items open in'});
        detailRow.add_suffix(details);
        view.add(detailRow);

        const playerBarRow = new Adw.SwitchRow({
            title: 'Player bar',
            subtitle: 'Show the playback control bar at the bottom of the library view',
        });
        bindSetting(settings, 'player-bar', playerBarRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        view.add(playerBarRow);

        const playRow = new Adw.SwitchRow({
            title: 'Play on a new workspace',
            subtitle: 'The player opens on an empty workspace of its own, leaving the one you picked from as it was',
        });
        bindSetting(settings, 'play-on-new-workspace', playRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        view.add(playRow);

        const workspaces = new Adw.ActionRow({
            title: 'Workspaces Music Menu is using stay open',
            subtitle: 'A workspace opened for the library or for a picked item is held until you close it or go back from it, so GNOME does not fold it away. With a fixed number of workspaces, set enough in Settings → Multitasking.',
            sensitive: false,
        });
        view.add(workspaces);

        // --------------------------------------------------------------
        // Keyboard Shortcut group
        // --------------------------------------------------------------
        page.add(this._shortcutsGroup(state));

        // --------------------------------------------------------------
        // Appearance group
        // --------------------------------------------------------------
        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        page.add(appearance);

        const slider = (key, min, max) => {
            const scale = new Gtk.Scale({
                orientation: Gtk.Orientation.HORIZONTAL,
                adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1}),
                digits: 0,
                draw_value: true,
                value_pos: Gtk.PositionType.RIGHT,
                hexpand: true,
                width_request: 220,
                valign: Gtk.Align.CENTER,
            });
            if (settings.settings_schema?.has_key(key)) {
                scale.add_mark(settings.get_default_value(key).deep_unpack(), Gtk.PositionType.BOTTOM, null);
                scale.set_value(settings.get_int(key));
                scale.connect('value-changed', () => settings.set_int(key, Math.round(scale.get_value())));
                settings.connect(`changed::${key}`, () => {
                    if (Math.round(scale.get_value()) !== settings.get_int(key))
                        scale.set_value(settings.get_int(key));
                });
            } else {
                scale.set_value(min);
            }
            return scale;
        };

        const rowsRow = new Adw.ActionRow({
            title: 'Rows',
            subtitle: 'Covers down a page. Fewer means larger covers.',
        });
        rowsRow.add_suffix(slider('rows', 1, 3));
        appearance.add(rowsRow);

        const columnsRow = new Adw.ActionRow({
            title: 'Columns',
            subtitle: 'Covers across a page. Fewer means larger covers. A small space — the grid in the overview, a small screen — fits fewer of either.',
        });
        columnsRow.add_suffix(slider('columns', 4, 10));
        appearance.add(columnsRow);

        const align = new Adw.ToggleGroup({valign: Gtk.Align.CENTER, homogeneous: true, can_shrink: false});
        align.add(new Adw.Toggle({name: 'center', label: 'Centre'}));
        align.add(new Adw.Toggle({name: 'start', label: 'Left'}));
        if (settings.settings_schema?.has_key('grid-align')) {
            align.set_active_name(settings.get_string('grid-align'));
            align.connect('notify::active-name', () => settings.set_string('grid-align', align.get_active_name()));
            settings.connect('changed::grid-align', () => {
                if (align.get_active_name() !== settings.get_string('grid-align'))
                    align.set_active_name(settings.get_string('grid-align'));
            });
        }
        const alignRow = new Adw.ActionRow({
            title: 'Align covers',
            subtitle: 'Where a row that is not full sits',
        });
        alignRow.add_suffix(align);
        appearance.add(alignRow);

        const radiusRow = new Adw.ActionRow({
            title: 'Corner radius',
            subtitle: 'How rounded covers, tiles and the detail pane are, in pixels. 0 is square.',
        });
        radiusRow.add_suffix(slider('corner-radius', 0, 40));
        appearance.add(radiusRow);

        const detailSizeRow = new Adw.ActionRow({
            title: 'Detail pop-up size',
            subtitle: 'How much of the available room the pop-up fills, as a percentage',
        });
        detailSizeRow.add_suffix(slider('detail-size', 80, 120));
        appearance.add(detailSizeRow);

        const accent = new Adw.ActionRow({
            title: 'Accent colour',
            subtitle: 'Follows Settings → Appearance → Accent Color',
            activatable: true,
        });
        accent.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
        accent.connect('activated', () => {
            try {
                Gio.Subprocess.new(['gnome-control-center', 'background'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                console.warn(`[Music Menu] Could not open Settings: ${e.message}`);
            }
        });
        appearance.add(accent);

        // --------------------------------------------------------------
        // Wire up view mode descriptions and visibility
        // --------------------------------------------------------------
        const VIEWS = {
            desktop: 'Drawn straight onto the wallpaper of the workspace you are on, brought up by the button next to Show Apps and put away by it, Escape or its close button.',
            workspaces: 'Drawn straight onto the wallpaper of a workspace of its own, slid to by the button next to Show Apps and given up again when you close it.',
            menu: 'In the overview, beside your applications, opened from the button next to Show Apps.',
            modal: 'A panel over the desktop, opened from the button next to Show Apps. Escape, a click away, or the button again closes it.',
        };
        const DETAILS = {
            desktop: 'What you pick opens on the workspace you are already on.',
            workspaces: 'What you pick opens on a workspace of its own.',
            menu: 'What you pick pops up where you picked it, the way an app folder opens.',
            modal: 'What you pick opens in a panel over the desktop and stays up until Escape or a click away closes it.',
        };
        const chosen = key => settings.settings_schema?.has_key(key) ? settings.get_string(key) : 'menu';
        const syncView = () => {
            const mode = chosen('library-opens-in');
            const detail = chosen('detail-opens-in');
            if (modes.active_name !== mode)
                modes.active_name = mode;
            if (details.active_name !== detail)
                details.active_name = detail;
            view.description = `${VIEWS[mode] ?? ''} ${DETAILS[detail] ?? ''}`.trim();
            workspaces.visible = mode === 'workspaces' || detail === 'workspaces';
            detailSizeRow.sensitive = detail === 'menu' || detail === 'modal';
        };
        for (const [group, key] of [[modes, 'library-opens-in'], [details, 'detail-opens-in']]) {
            group.connect('notify::active-name', () => {
                if (group.active_name && settings.settings_schema?.has_key(key) && group.active_name !== settings.get_string(key))
                    settings.set_string(key, group.active_name);
            });
            if (settings.settings_schema?.has_key(key))
                settings.connect(`changed::${key}`, syncView);
        }
        syncView();

        return page;
    }

    // ------------------------------------------------------------------
    // Shortcuts
    // ------------------------------------------------------------------
    _shortcutsGroup(state) {
        const {settings} = state;
        const group = new Adw.PreferencesGroup({title: 'Keyboard Shortcut'});
        const row = new Adw.ActionRow({
            title: 'Open the library',
            subtitle: 'From anywhere, wherever the library opens; the same shortcut again closes it. None is set to begin with.',
            activatable: true,
        });
        const label = new ShortcutLabel({disabled_text: 'Disabled', valign: Gtk.Align.CENTER});
        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Remove this shortcut', css_classes: ['flat'],
        });
        clear.connect('clicked', () => {
            if (settings.settings_schema?.has_key(SHORTCUT_KEY))
                settings.set_strv(SHORTCUT_KEY, []);
        });
        row.add_suffix(label);
        row.add_suffix(clear);
        const sync = () => {
            const accel = (settings.settings_schema?.has_key(SHORTCUT_KEY) ? settings.get_strv(SHORTCUT_KEY)[0] : '') ?? '';
            label.accelerator = accel;
            clear.visible = accel !== '';
        };
        if (settings.settings_schema?.has_key(SHORTCUT_KEY))
            settings.connect(`changed::${SHORTCUT_KEY}`, sync);
        sync();
        row.connect('activated', () => this._captureShortcut(state));
        group.add(row);
        return group;
    }

    _captureShortcut(state) {
        const {settings} = state;
        this._keyDialog(state, {
            title: 'Open the Library',
            description: 'Press the new shortcut. Esc cancels, Backspace removes it.',
            onKey: (keyval, mods) => {
                if (!mods && keyval === Gdk.KEY_Escape)
                    return true;
                if (!mods && keyval === Gdk.KEY_BackSpace) {
                    if (settings.settings_schema?.has_key(SHORTCUT_KEY))
                        settings.set_strv(SHORTCUT_KEY, []);
                    return true;
                }
                const shown = keyLabel(keyval, mods);
                const typing = !(mods & ~Gdk.ModifierType.SHIFT_MASK) &&
                    !(keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35) && keyval < 0x1008ff00;
                if (typing)
                    return `${shown} types a character. Add Ctrl, Alt or Super to it, or use a function or media key.`;
                const accel = Gtk.accelerator_name(keyval, mods);
                const clash = shortcutClash(settings, accel, SHORTCUT_KEY);
                if (clash)
                    return `${shown} is already taken — ${clash}. Try another, or Esc to cancel.`;
                if (settings.settings_schema?.has_key(SHORTCUT_KEY))
                    settings.set_strv(SHORTCUT_KEY, [accel]);
                return true;
            },
        });
    }

    _keyDialog(state, {heading = 'Set Shortcut', title, description, onKey, anyKey = false}) {
        const {window} = state;
        const status = new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title,
            description,
        });
        const toolbar = new Adw.ToolbarView({content: status});
        toolbar.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Dialog({title: heading, content_width: 440, child: toolbar});

        const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        keys.connect('key-pressed', (_controller, keyval, _keycode, modifiers) => {
            let mods = modifiers & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            let lower = Gdk.keyval_to_lower(keyval);
            if (lower === Gdk.KEY_ISO_Left_Tab)
                lower = Gdk.KEY_Tab;
            if (lower !== keyval)
                mods |= Gdk.ModifierType.SHIFT_MASK;
            if (!Gtk.accelerator_valid(lower, anyKey ? mods | Gdk.ModifierType.CONTROL_MASK : mods))
                return Gdk.EVENT_STOP;
            const answer = onKey(lower, mods);
            if (answer === true)
                dialog.close();
            else if (answer)
                status.description = answer;
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keys);

        const surface = window.get_surface();
        surface?.inhibit_system_shortcuts?.(null);
        dialog.connect('closed', () => surface?.restore_system_shortcuts?.());
        dialog.present(window);
        return dialog;
    }

    // ------------------------------------------------------------------
    // Apple Music page
    // ------------------------------------------------------------------
    _appleMusicPage(state) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: 'Apple Music', icon_name: 'audio-x-generic-symbolic'});

        // --------------------------------------------------------------
        // Status & Account
        // --------------------------------------------------------------
        const statusGroup = new Adw.PreferencesGroup({
            title: 'Status & Account',
        });
        page.add(statusGroup);

        const statusRow = new Adw.ActionRow({
            title: 'Engine status',
            subtitle: 'Checking…',
        });
        const refreshContent = new Adw.ButtonContent({icon_name: 'view-refresh-symbolic'});
        const refreshBtn = new Gtk.Button({
            child: refreshContent,
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Refresh status',
            css_classes: ['flat'],
        });
        statusRow.add_suffix(refreshBtn);
        statusGroup.add(statusRow);

        const refreshStatus = async () => {
            refreshBtn.set_sensitive(false);
            statusRow.set_subtitle('Checking…');
            try {
                const res = await this._runAm(['status']);
                const isRunning = typeof res.engine === 'object' ? !!res.engine?.running : !!res.engine;
                if (!isRunning) {
                    statusRow.set_subtitle('Engine stopped');
                } else if (res.authorized) {
                    const sf = res.storefront ? ` (Storefront: ${res.storefront.toUpperCase()})` : '';
                    statusRow.set_subtitle(`Running · Signed in${sf}`);
                } else {
                    statusRow.set_subtitle('Running · Not signed in');
                }
            } catch (err) {
                if (err.code === 'engine-down')
                    statusRow.set_subtitle('Engine stopped');
                else if (err.code === 'not-signed-in')
                    statusRow.set_subtitle('Running · Not signed in');
                else
                    statusRow.set_subtitle('Engine stopped');
            } finally {
                refreshBtn.set_sensitive(true);
            }
        };
        refreshBtn.connect('clicked', () => refreshStatus());

        const signInRow = new Adw.ActionRow({
            title: 'Sign in to Apple Music',
            subtitle: 'Opens Chrome in a visible window to authorize with your Apple ID',
        });
        const signInBtn = new Gtk.Button({
            label: 'Sign In',
            valign: Gtk.Align.CENTER,
        });
        signInRow.add_suffix(signInBtn);
        signInBtn.connect('clicked', async () => {
            signInBtn.set_sensitive(false);
            signInRow.set_subtitle('Waiting for sign in…');
            try {
                const res = await this._runAm(['signin']);
                if (res?.authorized)
                    signInRow.set_subtitle('Signed in successfully');
                else
                    signInRow.set_subtitle('Sign in completed');
            } catch (err) {
                console.warn(`[Music Menu] Sign in error: ${err.message}`);
                signInRow.set_subtitle(`Sign in failed: ${err.message}`);
            } finally {
                signInBtn.set_sensitive(true);
                refreshStatus();
            }
        });
        statusGroup.add(signInRow);

        // --------------------------------------------------------------
        // Library & Sync
        // --------------------------------------------------------------
        const syncGroup = new Adw.PreferencesGroup({
            title: 'Library & Sync',
        });
        page.add(syncGroup);

        const currentSync = (settings.settings_schema?.has_key('last-sync') ? settings.get_string('last-sync') : '') || lastSyncFromCache();
        const syncRow = new Adw.ActionRow({
            title: 'Sync library',
            subtitle: formatSyncSubtitle(currentSync),
        });
        const syncContent = new Adw.ButtonContent({
            label: 'Sync Now',
            icon_name: 'view-refresh-symbolic',
        });
        const syncBtn = new Gtk.Button({
            child: syncContent,
            valign: Gtk.Align.CENTER,
        });
        syncRow.add_suffix(syncBtn);
        syncGroup.add(syncRow);

        syncBtn.connect('clicked', async () => {
            syncBtn.set_sensitive(false);
            syncContent.set_icon_name('content-loading-symbolic');
            syncContent.set_label('Syncing…');
            syncRow.set_subtitle('Syncing library from Apple Music…');

            try {
                const res = await this._runAm(['sync']);
                const nowIso = res?.generated || new Date().toISOString();
                if (settings.settings_schema?.has_key('last-sync'))
                    settings.set_string('last-sync', nowIso);
                syncRow.set_subtitle(formatSyncSubtitle(nowIso, res?.counts));
                syncContent.set_icon_name('emblem-ok-symbolic');
                syncContent.set_label('Synced');
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                    syncContent.set_icon_name('view-refresh-symbolic');
                    syncContent.set_label('Sync Now');
                    return GLib.SOURCE_REMOVE;
                });
            } catch (err) {
                console.error(`[Music Menu] Sync failed: ${err.message}`);
                syncRow.set_subtitle(`Sync failed: ${err.message}`);
                syncContent.set_icon_name('dialog-warning-symbolic');
                syncContent.set_label('Failed');
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                    syncContent.set_icon_name('view-refresh-symbolic');
                    syncContent.set_label('Sync Now');
                    return GLib.SOURCE_REMOVE;
                });
            } finally {
                syncBtn.set_sensitive(true);
            }
        });

        if (settings.settings_schema?.has_key('last-sync')) {
            settings.connect('changed::last-sync', () => {
                syncRow.set_subtitle(formatSyncSubtitle(settings.get_string('last-sync')));
            });
        }

        const intervalAdjustment = new Gtk.Adjustment({
            lower: 0,
            upper: 1440,
            step_increment: 5,
            page_increment: 60,
        });
        let syncIntervalWidget;
        if (Adw.SpinRow) {
            const spinRow = new Adw.SpinRow({
                title: 'Sync interval',
                subtitle: 'Minutes between automatic syncs (0 to disable)',
                adjustment: intervalAdjustment,
            });
            if (settings.settings_schema?.has_key('sync-interval'))
                settings.bind('sync-interval', spinRow, 'value', Gio.SettingsBindFlags.DEFAULT);
            else
                spinRow.set_value(60);
            syncIntervalWidget = spinRow;
        } else {
            const row = new Adw.ActionRow({
                title: 'Sync interval',
                subtitle: 'Minutes between automatic syncs (0 to disable)',
            });
            const spin = new Gtk.SpinButton({
                adjustment: intervalAdjustment,
                valign: Gtk.Align.CENTER,
            });
            if (settings.settings_schema?.has_key('sync-interval'))
                settings.bind('sync-interval', spin, 'value', Gio.SettingsBindFlags.DEFAULT);
            else
                spin.set_value(60);
            row.add_suffix(spin);
            syncIntervalWidget = row;
        }
        syncGroup.add(syncIntervalWidget);

        // --------------------------------------------------------------
        // Engine Settings
        // --------------------------------------------------------------
        const engineGroup = new Adw.PreferencesGroup({
            title: 'Engine Settings',
            description: 'Google Chrome running music.apple.com with the DevTools protocol',
        });
        page.add(engineGroup);

        const browserRow = new Adw.EntryRow({
            title: 'Browser command',
            show_apply_button: true,
            tooltip_text: 'Google Chrome executable (google-chrome-stable)',
        });
        if (settings.settings_schema?.has_key('browser-command')) {
            browserRow.set_text(settings.get_string('browser-command'));
            browserRow.connect('apply', () => {
                settings.set_string('browser-command', browserRow.get_text().trim());
            });
            settings.connect('changed::browser-command', () => {
                const val = settings.get_string('browser-command');
                if (browserRow.get_text().trim() !== val)
                    browserRow.set_text(val);
            });
        } else {
            browserRow.set_text('google-chrome-stable');
        }
        engineGroup.add(browserRow);

        const browserDescRow = new Adw.ActionRow({
            title: 'Google Chrome executable (google-chrome-stable)',
            subtitle: 'Must support Widevine and the DevTools protocol (CDP)',
            sensitive: false,
        });
        engineGroup.add(browserDescRow);

        const portAdjustment = new Gtk.Adjustment({
            lower: 1024,
            upper: 65535,
            step_increment: 1,
            page_increment: 100,
        });
        let portWidget;
        if (Adw.SpinRow) {
            const portRow = new Adw.SpinRow({
                title: 'Port',
                subtitle: 'Remote debugging port bound to 127.0.0.1',
                adjustment: portAdjustment,
            });
            if (settings.settings_schema?.has_key('engine-port'))
                settings.bind('engine-port', portRow, 'value', Gio.SettingsBindFlags.DEFAULT);
            else
                portRow.set_value(9227);
            portWidget = portRow;
        } else {
            const row = new Adw.ActionRow({
                title: 'Port',
                subtitle: 'Remote debugging port bound to 127.0.0.1',
            });
            const spin = new Gtk.SpinButton({
                adjustment: portAdjustment,
                valign: Gtk.Align.CENTER,
            });
            if (settings.settings_schema?.has_key('engine-port'))
                settings.bind('engine-port', spin, 'value', Gio.SettingsBindFlags.DEFAULT);
            else
                spin.set_value(9227);
            row.add_suffix(spin);
            portWidget = row;
        }
        engineGroup.add(portWidget);

        const headlessRow = new Adw.SwitchRow({
            title: 'Run headless',
            subtitle: 'Run Chrome in the background without a window',
        });
        if (settings.settings_schema?.has_key('engine-headless'))
            settings.bind('engine-headless', headlessRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        else
            headlessRow.set_active(true);
        engineGroup.add(headlessRow);

        const autostartRow = new Adw.SwitchRow({
            title: 'Start engine automatically',
            subtitle: 'Start the engine when the library opens',
        });
        if (settings.settings_schema?.has_key('engine-autostart'))
            settings.bind('engine-autostart', autostartRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        else
            autostartRow.set_active(true);
        engineGroup.add(autostartRow);

        // Check engine status when preferences open
        refreshStatus();

        return page;
    }

    // ------------------------------------------------------------------
    // Controls
    // ------------------------------------------------------------------
    _controlsPage(state) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: 'Controls', icon_name: 'input-gaming-symbolic'});

        const keys = new Adw.PreferencesGroup({
            title: 'Remote and Keyboard',
            description: 'The arrow keys, Enter and Escape always work. Add the keys a remote, a Pico or anything else that acts as a keyboard sends: they do these things while a library is on screen, and what they always did everywhere else.',
        });
        page.add(keys);
        const pairs = action => {
            const key = schemaKey(settings, 'keys', action.key);
            return settings.settings_schema?.has_key(key) ? settings.get_value(key).deep_unpack() : [];
        };
        for (const action of ACTIONS) {
            const key = schemaKey(settings, 'keys', action.key);
            keys.add(this._bindingRow(settings, action, {
                key,
                labels: () => pairs(action).map(([keyval, mods]) => keyLabel(keyval, mods)),
                add: () => this._captureNavKey(state, action),
                addTip: 'Add a key',
            }));
        }
        keys.add(this._resetRow(settings, ACTIONS.map(a => schemaKey(settings, 'keys', a.key))));

        const pads = new Adw.PreferencesGroup({
            title: 'Game Controller',
            description: 'Read only while a library is on screen, so games are left alone — except Home, which also opens the library when no window has the keyboard. Xbox, PlayStation and most other pads are ready as they are; anything else, a Pico running as a gamepad included, is set up by pressing its buttons here.',
        });
        page.add(pads);
        const use = new Adw.SwitchRow({title: 'Use game controllers'});
        bindSetting(settings, 'gamepad-enabled', use, 'active', Gio.SettingsBindFlags.DEFAULT);
        pads.add(use);
        const connected = new Adw.ActionRow({title: 'Connected', subtitle: 'Looking…'});
        pads.add(connected);
        const padRows = [connected];
        for (const action of ACTIONS) {
            const key = schemaKey(settings, 'pad', action.key);
            padRows.push(this._bindingRow(settings, action, {
                key,
                labels: () => settings.settings_schema?.has_key(key)
                    ? [...new Set(settings.get_strv(key).map(padLabel))]
                    : [],
                subtitle: action.subtitle ?? null,
                add: () => this._capturePad(state, action),
                addTip: 'Add a button',
            }));
        }
        padRows.push(this._resetRow(settings, ACTIONS.map(a => schemaKey(settings, 'pad', a.key))));
        for (const row of padRows) {
            bindSetting(settings, 'gamepad-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            if (row !== connected)
                pads.add(row);
        }
        this._watchPads(state, connected);

        return page;
    }

    _bindingRow(settings, action, {key, labels, add, addTip, subtitle = action.subtitle ?? 'Besides the arrow key'}) {
        const row = new Adw.ActionRow({title: action.title});
        if (subtitle)
            row.subtitle = subtitle;
        const shown = new Gtk.Label({
            css_classes: ['dim-label'],
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 22,
            valign: Gtk.Align.CENTER,
        });
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: addTip, css_classes: ['flat'],
        });
        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Remove them all', css_classes: ['flat'],
        });
        addButton.connect('clicked', add);
        clear.connect('clicked', () => {
            if (settings.settings_schema?.has_key(key)) {
                settings.set_value(key,
                    new GLib.Variant(settings.get_value(key).get_type_string(), []));
            }
        });
        row.add_suffix(shown);
        row.add_suffix(addButton);
        row.add_suffix(clear);
        row.activatable_widget = addButton;
        const sync = () => {
            const names = labels();
            shown.label = names.length ? names.join(', ') : 'None';
            shown.tooltip_text = names.join(', ');
            clear.sensitive = names.length > 0;
        };
        if (settings.settings_schema?.has_key(key))
            settings.connect(`changed::${key}`, sync);
        sync();
        return row;
    }

    _resetRow(settings, keys) {
        const row = new Adw.ActionRow({title: 'Put back the defaults'});
        const button = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        button.connect('clicked', () => {
            keys.forEach(key => {
                if (settings.settings_schema?.has_key(key))
                    settings.reset(key);
            });
        });
        row.add_suffix(button);
        return row;
    }

    _captureNavKey(state, action) {
        const {settings} = state;
        const key = schemaKey(settings, 'keys', action.key);
        const matches = (keyval, mods) => ([k, m]) => k === keyval && m === mods;
        this._keyDialog(state, {
            heading: 'Add a Key',
            title: action.title,
            description: 'Press the key on the remote or keyboard. Esc cancels.',
            anyKey: true,
            onKey: (keyval, mods) => {
                if (!mods && keyval === Gdk.KEY_Escape)
                    return true;
                const shown = keyLabel(keyval, mods);
                if (!mods && NATIVE_KEYS.some(name => Gdk[`KEY_${name}`] === keyval))
                    return `${shown} already works in every library. Press another key, or Esc to cancel.`;
                const bound = settings.settings_schema?.has_key(key)
                    ? settings.get_value(key).deep_unpack()
                    : [];
                if (bound.some(matches(keyval, mods)))
                    return true;
                const owner = ACTIONS.find(other => {
                    if (other === action)
                        return false;
                    const otherKey = schemaKey(settings, 'keys', other.key);
                    return settings.settings_schema?.has_key(otherKey) &&
                        settings.get_value(otherKey).deep_unpack().some(matches(keyval, mods));
                });
                if (owner)
                    return `${shown} is already ${owner.title}. Press another key, or Esc to cancel.`;
                const clash = shortcutClash(settings, Gtk.accelerator_name(keyval, mods), null);
                if (clash)
                    return `${shown} is taken by the system — ${clash} — and would never reach the library.`;
                if (settings.settings_schema?.has_key(key))
                    settings.set_value(key, new GLib.Variant('a(uu)', [...bound, [keyval, mods]]));
                return true;
            },
        });
    }

    async _capturePad(state, action) {
        const {settings, window} = state;
        const key = schemaKey(settings, 'pad', action.key);
        const status = new Adw.StatusPage({
            icon_name: 'input-gaming-symbolic',
            title: action.title,
            description: 'Press the button, or push the stick or D-pad, on the controller. Esc cancels.',
        });
        const toolbar = new Adw.ToolbarView({content: status});
        toolbar.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Dialog({title: 'Set Controller Input', content_width: 440, child: toolbar});
        dialog.present(window);

        const Manette = await loadManette();
        if (!Manette) {
            status.description = 'libmanette is not installed, so controllers cannot be read.';
            return;
        }
        const monitor = new Manette.Monitor();
        const handlers = [];
        const listen = (object, signal, handler) => handlers.push([object, object.connect(signal, handler)]);
        const rest = new Map();
        const take = input => {
            const bound = settings.settings_schema?.has_key(key) ? settings.get_strv(key) : [];
            if (bound.includes(input)) {
                dialog.close();
                return;
            }
            const owner = ACTIONS.find(other => {
                if (other === action)
                    return false;
                const otherKey = schemaKey(settings, 'pad', other.key);
                return settings.settings_schema?.has_key(otherKey) &&
                    settings.get_strv(otherKey).includes(input);
            });
            if (owner) {
                status.description = `${padLabel(input)} is already ${owner.title}. Press another, or Esc to cancel.`;
                return;
            }
            if (settings.settings_schema?.has_key(key))
                settings.set_strv(key, [...bound, input]);
            dialog.close();
        };
        const axis = (device, code, value, hat) => {
            const id = `${device.get_guid()}/${code}`;
            const was = rest.get(id) ?? (hat ? 0 : undefined);
            rest.set(id, Math.abs(value));
            if (Math.abs(value) >= 0.7 && was !== undefined && was < 0.3)
                take(`axis:${code}${value < 0 ? '-' : '+'}`);
        };
        const watch = device => {
            listen(device, 'button-press-event', (_d, event) => {
                const [ok, button] = event.get_button();
                take(`button:${ok ? button : event.get_hardware_code()}`);
            });
            listen(device, 'absolute-axis-event', (_d, event) => {
                const [ok, code, value] = event.get_absolute();
                if (ok)
                    axis(device, code, value, false);
            });
            listen(device, 'hat-axis-event', (_d, event) => {
                const [ok, code, value] = event.get_hat();
                if (ok)
                    axis(device, code, value, true);
            });
        };
        listen(monitor, 'device-connected', (_m, device) => watch(device));
        const devices = monitor.iterate();
        let device, count = 0;
        while (([, device] = devices.next()) && device) {
            watch(device);
            count++;
        }
        if (!count)
            status.description = 'No controller is connected. Connect one and press a button on it, or Esc to cancel.';
        dialog.connect('closed', () => {
            for (const [object, id] of handlers)
                object.disconnect(id);
            handlers.length = 0;
        });
    }

    async _watchPads(state, row) {
        const Manette = await loadManette();
        if (!Manette) {
            row.subtitle = 'libmanette is not installed, so controllers cannot be read.';
            return;
        }
        const monitor = state.padMonitor = new Manette.Monitor();
        const names = new Map();
        const sync = () => {
            row.subtitle = names.size ? [...names.values()].join(', ') : 'None';
        };
        const add = device => {
            names.set(device, device.get_name());
            device.connect('disconnected', () => {
                names.delete(device);
                sync();
            });
            sync();
        };
        monitor.connect('device-connected', (_m, device) => add(device));
        const devices = monitor.iterate();
        let device;
        while (([, device] = devices.next()) && device)
            add(device);
        sync();
    }

    // ------------------------------------------------------------------
    // Backend am.py runner
    // ------------------------------------------------------------------
    async _runAm(args) {
        const script = GLib.build_filenamev([this.path, 'backend', 'am.py']);
        if (!GLib.file_test(script, GLib.FileTest.EXISTS))
            throw new Error(`am.py not found at ${script}`);

        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = Gio.Subprocess.new(
                    ['python3', script, ...args.map(String)],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
            } catch (e) {
                reject(new Error(`Failed to run am.py: ${e.message}`));
                return;
            }

            proc.communicate_utf8_async(null, null, (p, res) => {
                let stdout, stderr;
                try {
                    [, stdout, stderr] = p.communicate_utf8_finish(res);
                } catch (e) {
                    reject(new Error(`communicate error: ${e.message}`));
                    return;
                }

                let json = null;
                const outStr = (stdout ?? '').trim();
                if (outStr) {
                    const lastLine = outStr.split('\n').pop();
                    try {
                        json = JSON.parse(lastLine);
                    } catch {
                        // Not JSON
                    }
                }

                if (p.get_successful() && json && !json.error) {
                    resolve(json);
                    return;
                }

                const errCode = json?.error ?? (p.get_successful() ? 'parse-error' : 'crash');
                const errMsg = json?.message ?? (stderr ?? '').trim().split('\n').pop() ?? 'am.py failed';
                const err = new Error(errMsg);
                err.code = errCode;
                reject(err);
            });
        });
    }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function bindSetting(settings, key, object, property, flags = Gio.SettingsBindFlags.DEFAULT) {
    if (settings.settings_schema?.has_key(key)) {
        settings.bind(key, object, property, flags);
    } else {
        if (property === 'active')
            object.active = true;
    }
}

function schemaKey(settings, prefix, actionKey) {
    const key = `${prefix}-${actionKey}`;
    if (settings.settings_schema?.has_key(key))
        return key;
    if (actionKey === 'play-pause') {
        const legacy = `${prefix}-watched`;
        if (settings.settings_schema?.has_key(legacy))
            return legacy;
    }
    return key;
}

function formatSyncSubtitle(lastSyncStr, counts = null) {
    let dateStr = '';
    if (lastSyncStr) {
        try {
            const dt = GLib.DateTime.new_from_iso8601(lastSyncStr, null);
            if (dt) {
                const local = dt.to_local();
                dateStr = `Last synced ${local.format('%-d %b %H:%M')}`;
            }
        } catch {
            dateStr = `Last synced: ${lastSyncStr}`;
        }
    }
    if (counts && typeof counts === 'object') {
        const parts = [];
        for (const [k, v] of Object.entries(counts)) {
            if (typeof v === 'number')
                parts.push(`${v} ${k}`);
        }
        if (parts.length > 0) {
            const countsSummary = parts.join(', ');
            return dateStr ? `${dateStr} (${countsSummary})` : countsSummary;
        }
    }
    return dateStr || 'The library has not been synced yet';
}

function lastSyncFromCache() {
    try {
        const path = GLib.build_filenamev([GLib.get_user_cache_dir(), 'music-menu', 'library.json']);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (ok) {
                const data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
                return data?.generated ?? '';
            }
        }
    } catch {
        // ignore
    }
    return '';
}

function shortcutClash(settings, accel, ownKey) {
    const normal = text => {
        const [ok, keyval, mods] = Gtk.accelerator_parse(text);
        return ok && keyval ? Gtk.accelerator_name(Gdk.keyval_to_lower(keyval), mods) : null;
    };
    const wanted = normal(accel);
    const source = Gio.SettingsSchemaSource.get_default();

    if (SHORTCUT_KEY !== ownKey && settings.settings_schema?.has_key(SHORTCUT_KEY) && settings.get_strv(SHORTCUT_KEY).some(a => normal(a) === wanted))
        return 'Open the library';

    for (const action of ACTIONS) {
        const key = schemaKey(settings, 'keys', action.key);
        if (!settings.settings_schema?.has_key(key))
            continue;
        const pairs = settings.get_value(key).deep_unpack();
        if (pairs.some(([keyval, mods]) => normal(Gtk.accelerator_name(keyval, mods)) === wanted))
            return `${action.title}, on the Controls page`;
    }
    for (const id of SYSTEM_KEYBINDINGS) {
        const schema = source.lookup(id, true);
        if (!schema)
            continue;
        const system = new Gio.Settings({settings_schema: schema});
        for (const name of schema.list_keys()) {
            const key = schema.get_key(name);
            if (key.get_value_type().dup_string() !== 'as')
                continue;
            if (system.get_strv(name).some(a => normal(a) === wanted))
                return key.get_summary() || name;
        }
    }
    const custom = source.lookup(CUSTOM_KEYBINDING, true);
    if (custom && source.lookup(MEDIA_KEYS, true)) {
        for (const path of new Gio.Settings({schema_id: MEDIA_KEYS}).get_strv('custom-keybindings')) {
            const entry = new Gio.Settings({settings_schema: custom, path});
            if (normal(entry.get_string('binding')) === wanted)
                return entry.get_string('name') || 'a custom shortcut';
        }
    }
    return null;
}

function keyLabel(keyval, mods) {
    const named = REMOTE_KEYS[keyval];
    if (!named)
        return Gtk.accelerator_get_label(keyval, mods);
    return mods ? Gtk.accelerator_get_label(Gdk.KEY_a, mods).slice(0, -1) + named : named;
}

let manette = null;
function loadManette() {
    manette ??= import('gi://Manette').then(module => module.default, () => null);
    return manette;
}
