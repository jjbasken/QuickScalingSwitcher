/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
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
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const SCALE_OPTIONS = [1.0, 1.25, 1.5, 1.75, 2.0];

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

const ScaleSwitcherToggle = GObject.registerClass({
    GTypeName: 'ScaleSwitcherToggle',
},
class ScaleSwitcherToggle extends QuickMenuToggle {
    _init(onScaleSelected) {
        super._init({
            title: _('Display Scale'),
            iconName: 'display-symbolic',
        });

        this._items = new Map();
        for (const scale of SCALE_OPTIONS) {
            const label = `${Math.round(scale * 100)}%`;
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => onScaleSelected(scale));
            this.menu.addMenuItem(item);
            this._items.set(scale, item);
        }
    }

    setCurrentScale(scale) {
        const closest = SCALE_OPTIONS.reduce((prev, curr) =>
            Math.abs(curr - scale) < Math.abs(prev - scale) ? curr : prev);
        this.subtitle = `${Math.round(closest * 100)}%`;
        for (const [s, item] of this._items) {
            item.setOrnament(s === closest
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

        this._indicator = this._addIndicator();
        this._indicator.iconName = 'display-symbolic';
        this._indicator.visible = true;

        this._toggle = new ScaleSwitcherToggle(scale => this._applyScale(scale));
        this.quickSettingsItems.push(this._toggle);

        this._proxy = null;
        this._monitorChangedId = null;
        this._initProxy();
    }

    _initProxy() {
        new DisplayConfigProxy(
            Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            (proxy, error) => {
                if (error) {
                    console.error(`[QuickScalingSwitcher] Proxy init failed: ${error.message}`);
                    return;
                }
                this._proxy = proxy;
                this._monitorChangedId = this._proxy.connectSignal(
                    'MonitorsChanged', () => this._refreshCurrentScale());
                this._refreshCurrentScale();
            }
        );
    }

    _refreshCurrentScale() {
        if (!this._proxy) return;
        this._proxy.GetCurrentStateRemote((result, error) => {
            if (error) {
                console.error(`[QuickScalingSwitcher] GetCurrentState: ${error.message}`);
                return;
            }
            const [, , logicalMonitors] = result;
            const scale = this._getActiveMonitorScale(logicalMonitors);
            this._toggle.setCurrentScale(scale);
        });
    }

    _getActiveMonitorScale(logicalMonitors) {
        const idx = global.display.get_current_monitor();
        const geo = global.display.get_monitor_geometry(idx);
        for (const lm of logicalMonitors) {
            const [x, y, scale] = lm;
            if (x === geo.x && y === geo.y)
                return scale;
        }
        return 1.0;
    }

    _applyScale(newScale) {
        if (!this._proxy) return;
        this._ensureFractionalScaling();
        this._proxy.GetCurrentStateRemote((result, error) => {
            if (error) {
                console.error(`[QuickScalingSwitcher] GetCurrentState: ${error.message}`);
                return;
            }
            const [serial, monitors, logicalMonitors] = result;

            // Build connector → current mode_id map from physical monitors
            const connectorMode = new Map();
            for (const physMonitor of monitors) {
                const [spec, modes] = physMonitor;
                const [connector] = spec;
                for (const mode of modes) {
                    const [modeId, , , , , , modeProps] = mode;
                    const isCurrent = modeProps['is-current'];
                    const active = typeof isCurrent === 'boolean'
                        ? isCurrent
                        : (isCurrent?.get_boolean?.() ?? false);
                    if (active) {
                        connectorMode.set(connector, modeId);
                        break;
                    }
                }
            }

            const idx = global.display.get_current_monitor();
            const geo = global.display.get_monitor_geometry(idx);

            // Build new logical monitors for ApplyMonitorsConfig.
            // Input monitor format differs from output: a(ssa{sv}) = (connector, mode_id, props)
            const newLogicalMonitors = logicalMonitors.map(lm => {
                const [x, y, scale, transform, isPrimary, lmMonitors] = lm;
                const isActiveMonitor = (x === geo.x && y === geo.y);
                const inputMonitors = lmMonitors.map(([connector]) =>
                    [connector, connectorMode.get(connector) ?? '', {}]);
                return [x, y, isActiveMonitor ? newScale : scale, transform, isPrimary, inputMonitors];
            });

            this._proxy.ApplyMonitorsConfigRemote(
                serial, 2, newLogicalMonitors, {},
                (_, applyError) => {
                    if (applyError)
                        console.error(`[QuickScalingSwitcher] ApplyMonitorsConfig: ${applyError.message}`);
                }
            );
        });
    }

    _ensureFractionalScaling() {
        const settings = new Gio.Settings({schema: 'org.gnome.mutter'});
        const features = settings.get_strv('experimental-features');
        if (!features.includes('scale-monitor-framebuffer')) {
            features.push('scale-monitor-framebuffer');
            settings.set_strv('experimental-features', features);
        }
    }

    destroy() {
        if (this._monitorChangedId && this._proxy) {
            this._proxy.disconnectSignal(this._monitorChangedId);
            this._monitorChangedId = null;
        }
        this._proxy = null;
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
