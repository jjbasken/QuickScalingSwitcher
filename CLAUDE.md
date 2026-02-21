# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

QuickScalingSwitcher is a GNOME Shell 48+ extension that adds a quick settings toggle for switching the display scaling factor on the active monitor. The extension UUID is `QuickScalingSwitcher@jjbasken.proton.me`.

## Development Workflow

GNOME Shell extensions require no build step — files are loaded directly by GNOME Shell. To test changes:

```bash
# Install the extension (symlink or copy to GNOME extensions dir)
ln -s /home/jeremy/src/QuickScalingSwitcher/QuickScalingSwitcher@jjbasken.proton.me \
  ~/.local/share/gnome-shell/extensions/QuickScalingSwitcher@jjbasken.proton.me

# Reload GNOME Shell (X11 only — press Alt+F2, type 'r', press Enter)
# On Wayland, log out and back in

# Enable the extension
gnome-extensions enable QuickScalingSwitcher@jjbasken.proton.me

# View extension logs
journalctl -f -o cat /usr/bin/gnome-shell
```

## Architecture

The extension lives entirely in `QuickScalingSwitcher@jjbasken.proton.me/extension.js` and follows the GNOME Shell quick settings pattern:

- **Main Extension class** (`QuickSettingsExampleExtension extends Extension`): Entry point. `enable()` instantiates and registers the indicator; `disable()` cleans up all resources.
- **SystemIndicator subclass** (`ExampleIndicator`): Manages the panel icon and owns the toggle widget. The indicator icon visibility is bound to the toggle's checked state.
- **QuickToggle subclass** (`ExampleToggle`): The widget shown in the quick settings panel. Currently a placeholder ("Smile"); this is where scaling logic should be implemented.

The indicator is registered via `Main.panel.statusArea.quickSettings.addExternalIndicator()`.

## GNOME Shell API References

Key GJS imports used:
- `gi://GObject` — GObject class registration (`GObject.registerClass`)
- `resource:///org/gnome/shell/ui/quickSettings.js` — `QuickToggle`, `SystemIndicator`
- `resource:///org/gnome/shell/extensions/extension.js` — `Extension` base class, `gettext`
- `resource:///org/gnome/shell/ui/main.js` — access to shell panel

Display scaling is controlled via `org.gnome.mutter experimental-features` (for fractional scaling) or `org.gnome.desktop.interface scaling-factor` (integer scaling), accessible through `Gio.Settings`.

## Current State

The extension is a scaffold/placeholder. The `ExampleToggle`/`ExampleIndicator` classes with the "Smile" icon are boilerplate from the GNOME quick settings template and need to be replaced with actual scaling-factor switching logic.
