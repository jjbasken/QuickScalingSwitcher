/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const FRACTIONAL_SCALING_FEATURE = 'scale-monitor-framebuffer';

// MetaLogicalMonitorLayoutMode
const LAYOUT_MODE_LOGICAL = 1;

// MetaMonitorsConfigMethod
const CONFIG_METHOD_PERSISTENT = 2;

// Scales are doubles (1.7518248558044434, not 1.75); never compare them exactly.
const SCALE_EPSILON = 1e-6;

const DisplayConfigInterface = `<node>
  <interface name="org.gnome.Mutter.DisplayConfig">
    <method name="GetCurrentState">
      <arg name="serial" direction="out" type="u"/>
      <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})"/>
      <arg name="logical_monitors" direction="out" type="a(iiduba(ssss)a{sv})"/>
      <arg name="properties" direction="out" type="a{sv}"/>
    </method>
    <method name="ApplyMonitorsConfig">
      <arg name="serial" direction="in" type="u"/>
      <arg name="method" direction="in" type="u"/>
      <arg name="logical_monitors" direction="in" type="a(iiduba(ssa{sv}))"/>
      <arg name="properties" direction="in" type="a{sv}"/>
    </method>
    <signal name="MonitorsChanged"/>
  </interface>
</node>`;

const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigInterface);

// deepUnpack() recurses into containers but leaves a{sv} values as GLib.Variant.
function unpackValue(value) {
    return value?.deepUnpack?.() ?? value;
}

function formatScale(scale) {
    return `${Math.round(scale * 100)}%`;
}

function connectorOf(logicalMonitor) {
    const [monitorSpec] = logicalMonitor[5];
    return monitorSpec[0];
}

const ScaleSwitcherToggle = GObject.registerClass({
    GTypeName: 'ScaleSwitcherToggle',
},
class ScaleSwitcherToggle extends QuickMenuToggle {
    _init({onScaleSelected, onEnableFractional, onMenuOpened}) {
        super._init({
            title: _('Display Scale'),
            iconName: 'video-display-symbolic',
        });

        this._onScaleSelected = onScaleSelected;
        this._onEnableFractional = onEnableFractional;

        this._items = new Map();
        this._optionsKey = null;

        this.menu.setHeader('video-display-symbolic', _('Display Scale'));

        // QuickMenuToggle defaults to toggle-mode false, so without this the
        // whole primary button area is inert and only the arrow does anything.
        this.connect('clicked', () => this.menu.open());

        // The offered scales belong to whichever monitor the pointer is on, and
        // that changes without a MonitorsChanged signal.
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen)
                onMenuOpened();
        });
    }

    setOptions(scales, offerFractional) {
        const key = `${scales.join(',')}|${offerFractional}`;
        if (key === this._optionsKey)
            return;
        this._optionsKey = key;

        this.menu.removeAll();
        this._items.clear();

        const labels = new Set();
        for (const scale of scales) {
            const label = formatScale(scale);
            if (labels.has(label))
                continue;
            labels.add(label);

            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._onScaleSelected(scale));
            this.menu.addMenuItem(item);
            this._items.set(scale, item);
        }

        if (offerFractional) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const item = new PopupMenu.PopupMenuItem(_('Enable Fractional Scaling'));
            item.connect('activate', () => this._onEnableFractional());
            this.menu.addMenuItem(item);
        }
    }

    setCurrentScale(scale) {
        let current = null;
        if (scale !== null) {
            for (const offered of this._items.keys()) {
                if (Math.abs(offered - scale) < SCALE_EPSILON) {
                    current = offered;
                    break;
                }
            }
        }

        this.subtitle = scale !== null ? formatScale(scale) : '';

        for (const [offered, item] of this._items) {
            item.setOrnament(offered === current
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }
    }
});

const ScaleSwitcherIndicator = GObject.registerClass({
    GTypeName: 'ScaleSwitcherIndicator',
},
class ScaleSwitcherIndicator extends SystemIndicator {
    _init() {
        super._init();

        this._destroyed = false;
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
        this._monitorsChangedId = 0;

        this._settings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._settingsChangedId = this._settings.connect(
            'changed::experimental-features', () => this._refreshState());

        this._toggle = new ScaleSwitcherToggle({
            onScaleSelected: scale => this._applyScale(scale),
            onEnableFractional: () => this._enableFractionalScaling(),
            onMenuOpened: () => this._refreshState(),
        });
        this.quickSettingsItems.push(this._toggle);

        this._initProxy();
    }

    _initProxy() {
        new DisplayConfigProxy(
            Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            (proxy, error) => {
                // This lands after disable() if the extension is toggled off
                // while the proxy is still initialising.
                if (this._destroyed)
                    return;

                if (error) {
                    console.error(`[QuickScalingSwitcher] Proxy init failed: ${error.message}`);
                    return;
                }

                this._proxy = proxy;
                this._monitorsChangedId = this._proxy.connectSignal(
                    'MonitorsChanged', () => this._refreshState());
                this._refreshState();
            },
            this._cancellable
        );
    }

    _refreshState() {
        if (this._destroyed || !this._proxy)
            return;

        this._proxy.GetCurrentStateRemote(this._cancellable, (result, error) => {
            if (this._destroyed)
                return;

            if (error) {
                console.error(`[QuickScalingSwitcher] GetCurrentState: ${error.message}`);
                return;
            }

            const [, monitors, logicalMonitors] = result;
            const modes = this._currentModes(monitors);
            const active = this._findActiveLogicalMonitor(logicalMonitors);

            // Mutter rejects any scale it does not advertise for the monitor's
            // current mode, so offer exactly those rather than a fixed list.
            const scales = active
                ? modes.get(connectorOf(active))?.[5] ?? []
                : [];

            this._toggle.setOptions(scales, !this._hasFractionalScaling());
            this._toggle.setCurrentScale(active ? active[2] : null);
        });
    }

    _applyScale(newScale) {
        if (this._destroyed || !this._proxy)
            return;

        this._proxy.GetCurrentStateRemote(this._cancellable, (result, error) => {
            if (this._destroyed)
                return;

            if (error) {
                this._reportError(_('Could not read the display configuration'), error);
                return;
            }

            const [serial, monitors, logicalMonitors, properties] = result;

            const active = this._findActiveLogicalMonitor(logicalMonitors);
            if (!active) {
                this._reportError(_('Could not identify the active monitor'), null);
                return;
            }

            const layoutMode =
                unpackValue(properties['layout-mode']) ?? LAYOUT_MODE_LOGICAL;
            const config = this._buildConfig(
                monitors, logicalMonitors, active, newScale, layoutMode);
            if (!config) {
                this._reportError(_('Could not build a display configuration'), null);
                return;
            }

            this._proxy.ApplyMonitorsConfigRemote(
                serial, CONFIG_METHOD_PERSISTENT, config, {},
                this._cancellable,
                (applyResult, applyError) => {
                    if (this._destroyed || !applyError)
                        return;

                    this._reportError(
                        `${_('Could not set the display scale to')} ${formatScale(newScale)}`,
                        applyError);
                }
            );
        });
    }

    /*
     * ApplyMonitorsConfig takes a different monitor format than GetCurrentState
     * returns: a(ssa{sv}) = (connector, mode_id, properties).
     *
     * In logical layout mode a monitor's logical size is its resolution divided
     * by its scale, so rescaling one monitor resizes it and leaves a gap or an
     * overlap against its neighbours -- which mutter rejects outright with
     * "Logical monitors not adjacent" / "Logical monitors overlap". Shift every
     * monitor sitting past the rescaled one's right or bottom edge by the same
     * delta so the layout stays contiguous. Physical layout mode positions
     * monitors in physical pixels, which scaling does not affect.
     */
    _buildConfig(monitors, logicalMonitors, active, newScale, layoutMode) {
        const modes = this._currentModes(monitors);
        const props = this._monitorProps(monitors);

        for (const logicalMonitor of logicalMonitors) {
            for (const [connector] of logicalMonitor[5]) {
                if (!modes.has(connector))
                    return null;
            }
        }

        let shift = null;
        if (layoutMode === LAYOUT_MODE_LOGICAL) {
            const [x, y, oldScale] = active;
            const oldSize = this._logicalSize(modes, active, oldScale);
            const newSize = this._logicalSize(modes, active, newScale);
            if (!oldSize || !newSize)
                return null;

            shift = {
                right: x + oldSize[0],
                bottom: y + oldSize[1],
                dx: newSize[0] - oldSize[0],
                dy: newSize[1] - oldSize[1],
            };
        }

        return logicalMonitors.map(logicalMonitor => {
            const [x, y, scale, transform, isPrimary, lmMonitors] = logicalMonitor;
            const isActive = logicalMonitor === active;

            let newX = x;
            let newY = y;
            if (shift && !isActive) {
                if (x >= shift.right)
                    newX += shift.dx;
                if (y >= shift.bottom)
                    newY += shift.dy;
            }

            const inputMonitors = lmMonitors.map(([connector]) =>
                [connector, modes.get(connector)[0], props.get(connector)]);

            return [
                newX, newY,
                isActive ? newScale : scale,
                transform, isPrimary, inputMonitors,
            ];
        });
    }

    _currentModes(monitors) {
        const modes = new Map();
        for (const [spec, monitorModes] of monitors) {
            const current = monitorModes.find(
                mode => unpackValue(mode[6]['is-current']) === true);
            if (current)
                modes.set(spec[0], current);
        }
        return modes;
    }

    // Display properties that ApplyMonitorsConfig accepts and would otherwise reset.
    _monitorProps(monitors) {
        const props = new Map();
        for (const [spec, , monitorProps] of monitors) {
            const preserved = {};
            if (monitorProps['color-mode'] !== undefined)
                preserved['color-mode'] = monitorProps['color-mode'];
            props.set(spec[0], preserved);
        }
        return props;
    }

    _logicalSize(modes, logicalMonitor, scale) {
        const mode = modes.get(connectorOf(logicalMonitor));
        if (!mode)
            return null;

        let [, width, height] = mode;
        if (logicalMonitor[3] % 2 === 1)  // odd transforms are 90/270 rotations
            [width, height] = [height, width];

        return [Math.round(width / scale), Math.round(height / scale)];
    }

    _findActiveLogicalMonitor(logicalMonitors) {
        const idx = global.display.get_current_monitor();
        const geo = global.display.get_monitor_geometry(idx);
        return logicalMonitors.find(([x, y]) => x === geo.x && y === geo.y) ?? null;
    }

    _hasFractionalScaling() {
        return this._settings.get_strv('experimental-features')
            .includes(FRACTIONAL_SCALING_FEATURE);
    }

    /*
     * experimental-features is global and nothing here ever reverts it, so it
     * only gets touched on an explicit menu activation -- never as a silent
     * side effect of picking a scale.
     */
    _enableFractionalScaling() {
        const features = this._settings.get_strv('experimental-features');
        if (features.includes(FRACTIONAL_SCALING_FEATURE))
            return;

        features.push(FRACTIONAL_SCALING_FEATURE);
        this._settings.set_strv('experimental-features', features);

        Main.notify(_('Fractional scaling enabled'),
            _('Fractional scales are now available. On X11, log out and back in first.'));
    }

    _reportError(message, error) {
        Main.notifyError(message, error ? error.message : null);
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();

        if (this._proxy && this._monitorsChangedId) {
            this._proxy.disconnectSignal(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        this._proxy = null;

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._settings = null;
        this._toggle = null;

        super.destroy();
    }
});

export default class QuickScalingSwitcherExtension extends Extension {
    enable() {
        this._indicator = new ScaleSwitcherIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
