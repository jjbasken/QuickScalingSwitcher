# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

QuickScalingSwitcher is a GNOME Shell extension (48–51) that adds a quick settings
toggle for switching the display scaling factor on the active monitor. The extension
UUID is `QuickScalingSwitcher@jjbasken.proton.me`.

## Development Workflow

GNOME Shell extensions require no build step — files are loaded directly by GNOME Shell.

```bash
# Install the extension (symlink the inner directory, not the repo root)
ln -s /home/jeremy/src/QuickScalingSwitcher/QuickScalingSwitcher@jjbasken.proton.me \
  ~/.local/share/gnome-shell/extensions/QuickScalingSwitcher@jjbasken.proton.me

gnome-extensions enable QuickScalingSwitcher@jjbasken.proton.me

# View extension logs (console.error from the extension lands here, not on stderr)
journalctl -f -o cat /usr/bin/gnome-shell
```

Reloading the shell to pick up changes only works on X11 (Alt+F2, `r`, Enter). On
Wayland you must log out and back in — and note that the shell caches both the
extension's JS modules *and* its `shell-version` check at session start, so
`gnome-extensions disable/enable`, touching `metadata.json`, and recreating the
symlink all leave a stale `OUT OF DATE` state until the session restarts.

To verify logic without a session restart, stub the `resource:///org/gnome/shell/*`
imports: compile a GResource containing stand-in `ui/main.js`, `ui/popupMenu.js`,
`ui/quickSettings.js` and `extensions/extension.js`, `Gio.resources_register()` it,
define a minimal `globalThis.global.display`, then import `extension.js` in `gjs -m`.
Drive `_refreshState()` / `_applyScale()` by assigning a fake `_proxy` whose
`GetCurrentStateRemote` hands back a canned state — `GLib.Variant.parse()` of a
`gdbus call` dump makes a faithful one, since `deepUnpack()` leaves `a{sv}` values as
variants exactly as the proxy wrapper does. Creating a real `Gio.DBusProxy` in such a
harness does not work: once resource modules are registered, its async init callback
is deferred until shutdown. That is a harness artifact, not an extension bug.

## Architecture

The extension lives entirely in `QuickScalingSwitcher@jjbasken.proton.me/extension.js`:

- **`QuickScalingSwitcherExtension extends Extension`** — entry point. `enable()`
  registers the indicator via `Main.panel.statusArea.quickSettings.addExternalIndicator()`;
  `disable()` destroys the quick settings items and the indicator.
- **`ScaleSwitcherIndicator extends SystemIndicator`** — owns the toggle, the
  `org.gnome.Mutter.DisplayConfig` proxy, and all display logic. It adds no panel
  status icon (deliberately removed).
- **`ScaleSwitcherToggle extends QuickMenuToggle`** — the quick settings widget. The
  menu is rebuilt only when the offered scales change, and repopulated on every menu
  open because the scales belong to whichever monitor the pointer is on, which changes
  without a `MonitorsChanged` signal.

## How scaling is actually applied

Scaling is **not** set through `Gio.Settings`. It goes through the
`org.gnome.Mutter.DisplayConfig` D-Bus interface: `GetCurrentState` to read monitors
and logical monitors, then `ApplyMonitorsConfig` with method `2` (persistent).

Constraints worth remembering before touching `_buildConfig`:

- Mutter rejects any scale it does not advertise for the monitor's *current* mode, so
  the menu offers exactly the advertised list rather than a fixed set.
- Scales are doubles (`1.7518248558044434`, not `1.75`) — never compare them exactly;
  use `SCALE_EPSILON`.
- `ApplyMonitorsConfig` takes a different monitor format than `GetCurrentState`
  returns: `a(ssa{sv})` = (connector, mode_id, properties).
- In logical layout mode, rescaling one monitor resizes it and would leave a gap or
  overlap, which mutter rejects outright ("Logical monitors not adjacent" /
  "Logical monitors overlap"). Every monitor past the rescaled one's right or bottom
  edge is shifted by the same delta. Physical layout mode needs no shifting.
- Monitor properties that `ApplyMonitorsConfig` accepts are otherwise reset, so
  `_monitorProps()` carries `color-mode` through to preserve HDR state. Mutter 51 also
  reports `rgb-range` and `is-underscanning`, which are *not* currently preserved.

## Fractional scaling across releases

Fractional scaling was gated behind `scale-monitor-framebuffer` in
`org.gnome.mutter experimental-features`, and the extension offers an "Enable
Fractional Scaling" menu item to set it. That changed twice:

- mutter 50 made VRR and fractional scaling non-experimental.
- GNOME 51 moved the remaining flags to a separate `org.gnome.mutter.experimental`
  schema, so `org.gnome.mutter` has no `experimental-features` key at all. Reading a
  key a schema does not define **throws**, so the key must never be read blindly.

The code therefore probes `settings_schema.has_key()` before holding the settings
object, and decides whether to offer the menu item from whether mutter advertises any
fractional scale — the authoritative signal — rather than from the shell version.
`experimental-features` is global and nothing here reverts it, so it is only ever
written on an explicit menu activation, never as a side effect of picking a scale.
