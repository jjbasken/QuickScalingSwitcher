# QuickScalingSwitcher

A GNOME Shell extension that adds a **Display Scale** toggle to the quick settings
panel, so you can change the scaling factor of the monitor you are working on
without opening Settings.

Useful if you move between a HiDPI laptop panel and an external display, or if
you regularly drop the scale to fit more on screen and put it back afterwards.

## Features

- Sets the scale of the **active monitor** — the one the pointer is currently on —
  and leaves the others alone.
- Offers only the scales mutter actually supports for that monitor's current
  resolution, read live over D-Bus. No hardcoded list, so nothing in the menu
  silently fails.
- Keeps the rest of the display configuration intact: resolution, rotation,
  primary monitor, and HDR / colour mode.
- Repositions the other monitors so the layout stays contiguous when the
  rescaled monitor changes logical size.
- Changes are persistent — they survive a reboot, the same as changing the
  scale in Settings.

## Requirements

- GNOME Shell 48 or 49. Developed and tested against 48.7.
- Fractional scales additionally need mutter's `scale-monitor-framebuffer`
  experimental feature (see [Fractional scaling](#fractional-scaling) below).
  Integer scales work without it.

## Install

```bash
git clone https://github.com/jjbasken/QuickScalingSwitcher.git
cd QuickScalingSwitcher
ln -s "$PWD/QuickScalingSwitcher@jjbasken.proton.me" \
  ~/.local/share/gnome-shell/extensions/QuickScalingSwitcher@jjbasken.proton.me
```

Then restart GNOME Shell so it picks up the new extension:

- **Wayland** — log out and back in.
- **X11** — press <kbd>Alt</kbd>+<kbd>F2</kbd>, type `r`, press <kbd>Enter</kbd>.

And enable it:

```bash
gnome-extensions enable QuickScalingSwitcher@jjbasken.proton.me
```

## Usage

Open the quick settings menu (click the system area in the top-right) and find
the **Display Scale** tile. Its subtitle shows the current scale of the active
monitor. Click the tile or its arrow to open the menu, then pick a scale.

The menu lists what the active monitor supports at its current resolution, so
the entries differ between displays — and a monitor at a low resolution may only
offer 100%.

Note that the percentages are rounded labels. A monitor advertising
`1.7518248558044434` is shown as **175%**, because that is the value that
actually produces a whole number of pixels at that resolution.

### Fractional scaling

If fractional scaling is turned off, mutter only reports integer scales, so the
menu is limited to those (typically 100% and 200%). An **Enable Fractional
Scaling** entry appears at the bottom of the menu in that case; activating it adds
`scale-monitor-framebuffer` to mutter's experimental features.

This setting is global and the extension never changes it on its own — only when
you pick that entry. It is not undone when you uninstall the extension. To turn
it back off, check what is currently set and write back the list without
`scale-monitor-framebuffer` — resetting the key outright would also drop any
other experimental features you rely on, such as `xwayland-native-scaling`:

```bash
gsettings get org.gnome.mutter experimental-features
gsettings set org.gnome.mutter experimental-features "['xwayland-native-scaling']"
```

Some distributions (Debian among them) enable fractional scaling by default via a
vendor override, in which case the entry never appears.

## How it works

Everything lives in `QuickScalingSwitcher@jjbasken.proton.me/extension.js`.

The extension talks to mutter over the `org.gnome.Mutter.DisplayConfig` D-Bus
interface. `GetCurrentState` supplies the monitor list, each monitor's modes and
their supported scales, and the logical monitor layout; `ApplyMonitorsConfig`
writes a new configuration back.

Two details are worth knowing if you are reading the code:

- **Scales are doubles, not the round numbers in the labels.** Mutter rejects any
  scale it did not advertise, and the tolerance is a float epsilon — `1.75` is not
  accepted where `1.7518248558044434` is. Scales are therefore always taken from
  `supported-scales` and compared with a tolerance, never written as literals.
- **Rescaling a monitor resizes it.** Under the logical layout mode, a monitor's
  logical size is its resolution divided by its scale, so changing one monitor's
  scale leaves a gap or an overlap against its neighbours — which mutter refuses
  with *"Logical monitors not adjacent"* or *"Logical monitors overlap"*. Monitors
  sitting past the rescaled one's right or bottom edge are shifted by the same
  delta to keep the layout contiguous.

## Known limitations

- Underscanning is not carried across a scale change; a monitor with
  underscanning enabled will have it reset.
- The layout repair shifts monitors past the rescaled one's right and bottom
  edges. That covers the usual side-by-side and stacked arrangements, but an
  unusual layout can still produce an arrangement mutter rejects, in which case
  nothing is changed and a notification says so.
- No preferences UI, and no keyboard shortcut.

## Troubleshooting

Failures are reported as desktop notifications and written to the journal:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i quickscaling
```

**A scale I want is not in the menu.** Mutter only permits scales that divide the
monitor's current resolution into whole pixels. Changing resolution changes the
list. Fractional scales also require the experimental feature described above.

**Nothing happens when I pick a scale.** Check the journal. On a multi-monitor
setup a layout mutter considers invalid is the usual cause; setting the layout up
again in Settings and retrying normally clears it.

## Development

GNOME Shell extensions are loaded from source, so there is no build step. Symlink
the extension directory as shown above, edit `extension.js`, then restart the
shell to reload it.

To inspect what mutter is reporting — monitors, modes, supported scales and the
logical layout:

```bash
gdbus call --session --dest org.gnome.Mutter.DisplayConfig \
  --object-path /org/gnome/Mutter/DisplayConfig \
  --method org.gnome.Mutter.DisplayConfig.GetCurrentState
```

To check whether a configuration would be accepted without applying it, call
`ApplyMonitorsConfig` with `method=0` (VERIFY). It validates and changes nothing,
which makes it safe to experiment with. Pass the `serial` from `GetCurrentState`:

```bash
gdbus call --session --dest org.gnome.Mutter.DisplayConfig \
  --object-path /org/gnome/Mutter/DisplayConfig \
  --method org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig \
  <serial> 0 "[(0, 0, 1.5, uint32 0, true, [('eDP-1', '1920x1200@60.001', @a{sv} {})])]" "@a{sv} {}"
```

An unsupported scale fails here with a message such as
`Scale 1.75 not valid for resolution 1920x1200`.

## License

GPL-3.0-or-later. The full text is in [COPYING](COPYING), and the SPDX header in
`extension.js` declares it per-file.
