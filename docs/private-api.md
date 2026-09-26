# Private and deep GNOME Shell API

Music Menu puts its button beside Show Apps, borrows the app grid for its
album/artist/playlist tiles and the folder dialog for its pop-up album pane,
and makes both the overview and the workspace slide show its pages where
they would otherwise show empty wallpaper. None of that has a public API of
its own — it is the same mechanism Video Menu uses, inherited unchanged, so
most of this page is that document renamed rather than re-derived. See
Video Menu's own `docs/private-api.md`
(`/home/jackt/Projects/GNOME-Extensions/GNOME-Video-Menu/docs/private-api.md`)
for the full line-by-line walk-through and the exact confirmation history
against the GNOME 48.0/49.0/50.5 sources; this page restates the entries
that still apply under Music Menu's own names, drops what no longer applies
(there is no folder scanner and no "watched" tracking here), and adds what's
new (the search provider, and a note on what's *not* private API — the
Apple Music endpoints).

## At a glance

| Expression | File | If it changes in a future GNOME | Checked in code |
|---|---|---|---|
| `Main.layoutManager._backgroundGroup` | app.js | The surface is not drawn anywhere; the shell's own wallpaper carries on | Yes, falls back to `global.window_group` |
| `workspace._keepAliveId` (read and set) | app.js | A workspace held for the library or the pane is folded away by GNOME's dynamic-workspace code | No — no public equivalent that isn't duration-bound |
| `Main.wm._workspaceTracker._queueCheckWorkspaces()` | app.js | A released workspace is folded away late instead of promptly | Yes, optional-chained |
| `Dash.ShowAppsIcon`, its `_createIcon`/`_iconActor` | libraryButton.js | The subclass throws on `_init`; caught, so no button appears | Yes, the whole attach is try/caught |
| `Main.overview.dash._dashContainer`, `dash._hookUpLabel` | libraryButton.js | No button in the dash | Yes, checked before use |
| `global.dashToPanel`, `panels[0]`, `panels-created` | libraryButton.js | No button in Dash to Panel's panel; falls back to the dash | Yes, every field checked before use |
| `Main.overview._overview.controls`, `.appDisplay`, `._box` | mediaMenu.js | No overview menu; a warning once, if any tab is enabled | Yes, logs a warning |
| `Main.overview.dash.showAppsButton` (`.checked`) | mediaMenu.js | The view can no longer tell "is the app grid up" from "is it ours" | No |
| `controls._searchController`, `.searchActive` | mediaMenu.js | Workspaces do not reappear for a search while the menu is up | No, optional-chained |
| `Main.overview.searchController.addProvider(provider)` | searchProvider.js | Apple Music results simply never appear in the overview's search; nothing throws | No — a public getter and method, but not a documented extension API, see below |
| `controller._setSearchActive` and `controller._searchResults.setTerms` (wrapped), `Main.overview.searchEntry.clutter_text` (`text-changed`, `key-press-event`) | mediaMenu.js | Typing with the menu up runs the shell's own search over it, as before; no search page in the menu | Yes — a warning once, and the entry stays the shell's |
| `ProviderInfo.animateLaunch()` calling `Shell.AppSystem.lookup_app(appInfo.get_id())` | searchProvider.js | A click on the "Apple Music" heading over the results throws inside the shell's own handler | Yes — `get_id()` names `org.gnome.Shell.Extensions.desktop`, which the shell ships |
| `controls._stateAdjustment` | mediaMenu.js | The workspace row is not folded/unfolded in step with the overview's own transition | No, optional-chained |
| `controls.layout_manager._getAppDisplayBoxForState` (wrapped) | mediaMenu.js | The slot is never grown for the shelves/grid above the workspace row | Yes, guarded and chain-safe |
| `Object.getPrototypeOf(AppDisplay.AppDisplay)` (`BaseAppView`) | mediaGrid.js | `MediaView`'s `_init` throws; no grid anywhere (Albums/Artists/Playlists/Radio) | No — a straight top-level throw |
| `AppDisplay.AppViewItem`, `AppDisplay.AppGrid`, `IconGrid.BaseIcon`, `IconGrid.IconGridLayout` | mediaGrid.js | Depends on which field; see the grid section | Partial |
| `Main.overview._overview.controls._appDisplay._folderIcons`, `icon._dialog`, `dialog._viewBox` | panel.js `folderLook()` | The album pane always uses the shell's own shade and theme, even where Blur my Shell changes a folder's | Yes, fails soft to `null` |
| `Main.overview._overview.controls._workspacesDisplay._workspacesViews` | overviewPreview.js | No clones in the overview's workspace previews | Yes, optional-chained to `[]` |
| `controls._thumbnailsBox._thumbnails` | overviewPreview.js | No clone in the thumbnail strip | Yes, optional-chained |
| `Main.wm._workspaceAnimation`, override of `_prepareWorkspaceSwitch` | overviewPreview.js | No clones during a workspace slide; the library blinks back once it lands | Yes, `InjectionManager`, chain-safe |
| `Main.wm.addKeybinding` / `removeKeybinding` | app.js | Public, listed for completeness | N/A (public) |

"Checked in code" of **No** does not mean unguarded outright — most of these
are behind `?.` or an `if`; it means there is no console message, so the only
sign is the symptom in the "if it changes" column.

## The button beside Show Apps (libraryButton.js)

`MusicMenuLibraryIcon extends Dash.ShowAppsIcon`, exactly the same shape as
Video Menu's `MediaLibrariesLibraryIcon` — subclassing `ShowAppsIcon` rather
than hand-building a `DashItemContainer` is what gives the button the same
hover, focus ring, tooltip and dash sizing every other dash icon has.
`_attach()` tries Dash to Panel's panel internals
(`global.dashToPanel.panels[0].showAppsIconWrapper`,
`panel._updateGroupedElements`) first, and falls back to the plain dash
(`Main.overview.dash._dashContainer`, `dash._hookUpLabel`) — see Video Menu's
document for why each field is reached and what a missing one degrades to;
nothing about that reasoning changed for Music Menu.

## The overview's app-grid slot (mediaMenu.js)

Same reach as Video Menu's `mediaMenu.js`: `Main.overview._overview.controls`,
`.appDisplay`, `._box` for the slot the menu's tabs and grid are added into
as a second child, `dash.showAppsButton.checked` for "is the app grid
actually showing" (never `appDisplay.visible` — see the Gotcha in Video
Menu's `CLAUDE.md`, "Is the app grid up?"), and the wrapped
`controls.layout_manager._getAppDisplayBoxForState` to grow the slot over the
folded workspace row. The one addition here is **Listen Now**: its tab holds
`shelfView.js`'s vertical list of shelves instead of a grid, but it sits in
the same slot and behind the same fold/unfold logic as every other tab — no
new private reach, just a different child view shown for that tab.

## The overview search provider (searchProvider.js) — new

```js
Main.overview.searchController.addProvider(this);    // registered on enable
Main.overview.searchController.removeProvider(this); // unregistered on disable
```

**What for.** `addProvider`/`removeProvider` on `SearchController` is how an
extension puts its own `SearchProvider`-shaped object (`getInitialResultSet`,
`getResultMetas`, `activateResult`, an `appInfo`/`id`) into GNOME's own
overview search, so typing in the overview answers with Apple Music results
(via `am.py --no-start search`, so a search never starts Chrome) alongside
apps and files. `Main.overview.searchController` is a public getter (it
reaches `_overview.controls._searchController` for us).

**The heading's own click.** A provider with an `appInfo` gets a labelled
heading over its results, and the shell's `ProviderInfo.animateLaunch()`
(search.js) answers a click on it with
`Shell.AppSystem.get_default().lookup_app(appInfo.get_id())` and reads
`.state` off the result without a null check. There is no installed app for
this extension, so `get_id()` names `org.gnome.Shell.Extensions.desktop`,
the hidden launcher gnome-shell installs alongside itself: it always
resolves, and the click animates nothing rather than throwing.

**Why nothing fully public.** GNOME does have a *supported*, D-Bus-based
search-provider mechanism for standalone applications
(`org.gnome.Shell.SearchProvider2`, a `.ini` file under
`~/.local/share/gnome-shell/search-providers/`), but that's for a separate
installed app with its own `.desktop` file — not for adding a provider from
inside a running shell extension. `SearchController.addProvider` is the
in-process method extensions actually use for this (the same pattern as
several well-known extensions), but it is not part of the shell's exported,
version-stable API surface — it's reached the same way `_searchController`
already is elsewhere in `mediaMenu.js`.

**If it changes.** `addProvider` missing or renamed: `register()` throws
inside `enable()`'s try, and the extension carries on without search results.
If gnome-shell ever stops shipping `org.gnome.Shell.Extensions.desktop`, the
heading's click throws in the shell's handler once per click; the results
themselves are unaffected.

## The overview's search entry, taken over (mediaMenu.js) — new

```js
const controller = this._controls._searchController;      // SearchController
wrapMethod(controller, '_setSearchActive', …);             // instance, chain-safe
wrapMethod(controller._searchResults, 'setTerms', …);      // SearchResultsView
Main.overview.searchEntry.clutter_text.connectObject('text-changed', …, 'key-press-event', …, this);
```

**What for.** While the menu is what the overview shows, the shell's
"Type to search" entry is Apple Music's: the entry's own `text-changed`
feeds `LibraryView.search()` (searchView.js), and two of the search
controller's methods are wrapped on the instances so the shell's own
search stays out of the way. `_setSearchActive(true)` is what
`overviewControls.js` answers by fading the app display — the menu's slot —
out under the shell's results view (`_onSearchChanged`,
`_updateAppDisplayVisibility`); suppressed, the menu stays put and
`searchActive` never flips. `SearchResultsView.setTerms(terms)` is what
starts every provider's search (`_doSearch`), the extension's own
`searchProvider.js` included, for a results view nothing would show;
suppressed, nothing is asked twice. Both wraps call straight through
whenever the menu is not showing (`isShowing`), and always for
`_setSearchActive(false)` and `setTerms([])`, so the entry's reset, clear
icon and focus handling are untouched. Both are `this.method(...)` calls
inside the controller, so an own-property override on the instance is
what takes effect; `_onTextChanged` and `_onStageKeyPress` are bound at
connect time and are not touched.

**Keys.** `SearchController._onKeyPress` on the entry takes Tab, Down and
Enter only while its own search is active, so with ours up they reach the
menu's handler connected after it, which sends them into the results.
Escape and Up off the top row are seen in the stage's capture phase
(`captured-event::key`), ahead of the shell's own Escape (bubbling on the
stage: it would uncheck Show Apps) and of St's focus manager.

**Chain-safe.** `wrapMethod` keeps what was there, tracks whether the wrap is
still the outermost, and on disable restores the previous only if it is —
the same pattern as `_getAppDisplayBoxForState` below — and a wrap left in
someone else's chain calls straight through.

**If it changes.** Any of the four fields missing (`_searchController`,
`_setSearchActive`, `_searchResults.setTerms`, `searchEntry`) logs one warning
and leaves the entry the shell's: typing with the menu up runs the shell's
search over it, as it did before this. A shell that stops routing
`_onTextChanged` through `_setSearchActive`/`setTerms` would show its own
results beside ours rather than break anything.

## The app grid (mediaGrid.js)

Identical mechanism to Video Menu's `mediaGrid.js`, tiles renamed from
posters to album/artist/playlist/radio art: `BaseAppView` reached via
`Object.getPrototypeOf(AppDisplay.AppDisplay)` (the single point of failure
the whole grid stands on — no fallback shape exists), `_parentalControlsManager`/
`_appFavorites` disconnected (neither applies to media), `_pageIndicators`/
`_box`/`_adjustment` read for paging, and `_addItem`/`_loadApps`/
`_compareItems`/`_createGrid` overridden or called directly so a library of
thousands of items doesn't cost a full diff-and-append on every tab switch.
`MusicMenuPosterGridLayout extends IconGrid.IconGridLayout` overrides
`vfunc_allocate` entirely (no `super` call) because the shell's own layout
takes the larger of an item's width/height as one square cell side, which an
album cover is, but a round artist lockup and Video Menu's own posters are
not — the same override, just with an added round-lockup case for the
Artists tab (`shape.js`).

## The album pane, borrowed (panel.js, detailDialog.js, libraryWindow.js)

`MediaPanel` (panel.js) is a hand-built copy of the shell's own
`AppFolderDialog` shape (shade, zoom out of a tile, `GrabHelper`,
click-away, settle) — not a subclass of it, since `AppFolderDialog` bakes in
a name-entry field and a folder's own grid that would have to be torn back
out. `folderLook()` reaches
`Main.overview._overview.controls._appDisplay._folderIcons`, a folder icon's
`_dialog`, and that dialog's `_viewBox`, purely so the pop-up album pane
matches whatever Blur my Shell has done to a real app folder's look (shade
dropped, panel translucent) — it fails soft to `null` (the shell's own
`DIALOG_SHADE_NORMAL` and theme) on a desktop with no folders ever opened, or
with Blur my Shell off. See Video Menu's document for the full reasoning;
nothing about the mechanism changed, only what's inside the pane (art,
title, artist, genre, year, Play/Shuffle, the track list, instead of a
poster and an episode list).

## Workspaces held open (app.js)

Unchanged from Video Menu: `workspace._keepAliveId` is set and cleared
directly (`_keepOnly()`) rather than through the public, duration-bound
`Main.wm.keepWorkspaceAlive`, because a workspace holding the library or an
open album pane needs to stay held for as long as that's true, not for a
fixed timeout; `Main.wm._workspaceTracker._queueCheckWorkspaces()` nudges the
shell to fold a released workspace away promptly rather than waiting on its
own next check.

## The overview previews and the workspace slide (overviewPreview.js)

Same idea, same fields, as Video Menu's own `overviewPreview.js` (and, before
that, Wallpaper Engine's): neither the overview's workspace previews nor the
workspace-slide strip shows `Main.layoutManager._backgroundGroup` — each
builds its own wallpaper actor — so a `Clutter.Clone` of the library's
current page is inserted into each by hand
(`controls._workspacesDisplay._workspacesViews`, `workspace._background`/
`_backgroundGroup`/`_monitorIndex`, `controls._thumbnailsBox._thumbnails`,
`Main.wm._workspaceAnimation`'s `_prepareWorkspaceSwitch`, wrapped
chain-safely via `InjectionManager`). Music Menu only draws on the primary
monitor, the same restriction Video Menu's copy has, so neither unwraps
`SecondaryMonitorDisplay`'s multi-monitor wrapper.

## Chain-safe wraps, for coexisting with Video Menu and Games Menu

`panel._updateGroupedElements` (libraryButton.js) and
`layout._getAppDisplayBoxForState` (mediaMenu.js) are wrapped the same
chain-safe way as Video Menu's own copies, so that up to three extensions —
Music Menu, Video Menu, Games Menu — can each wrap the same private method
without one's disable breaking another's: call through to whatever was there
first unconditionally, track whether this wrap is still the outermost one,
and on the way out restore what was there only if it still is. See Video
Menu's document ("Chain-safe wraps, for coexisting with Games Menu") for the
full four-step pattern — it's identical here, just with a third participant.

## What is *not* private API: the Apple Music endpoints

Everything `am.py` calls — `/v1/catalog/{storefront}/...`, `/v1/me/library/...`,
`/v1/me/ratings/...`, `/v1/catalog/{storefront}/songs/{id}/lyrics` — is
Apple's own MusicKit web API, reached the same way the music.apple.com page
itself reaches it (`MusicKit.getInstance().api.music(...)`, run inside the
page over CDP, not called directly from Python). None of it is documented,
versioned, or guaranteed by Apple; it can change or start requiring
something new at any time, same as the page it's borrowed from. That risk is
disjoint from everything else on this page — it has nothing to do with the
GNOME Shell version, and nothing here mitigates it beyond `am.py` reporting
a plain `api` error when a call fails. The **ratings** endpoint
(`love`/`unlove`) and the **lyrics** endpoint in particular are exactly the
web player's own features, not a documented public API Apple offers
third parties — see `README.md`'s "How it actually works" for the
user-facing version of this caveat.
