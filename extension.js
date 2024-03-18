/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Secret from 'gi://Secret';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {
    Extension,
    gettext as _
} from 'resource:///org/gnome/shell/extensions/extension.js';


Gio._promisify(Secret.Collection, 'for_alias', 'for_alias_finish');
Gio._promisify(Secret.Service, 'get', 'get_finish');
Gio._promisify(Secret.Service.prototype, 'lock', 'lock_finish');


class Indicator extends PanelMenu.Button {

    static {
        GObject.registerClass(this);
    }


    #ext;
    #icon;
    #lock_item;


    constructor(ext)
    {
        super();

        this.#ext = ext;

        this.#icon = new St.Icon({
            icon_name: 'security-medium-symbolic',
            style_class: 'system-status-icon',
        });

        this.add_child(this.#icon);

        this.menu.addAction(_('Settings...'),
                            this.#ext.openPreferences.bind(this.#ext),
                            'preferences-other-symbolic');

        this.#lock_item = this.menu.addAction(_('Lock the keyring now.'),
                                              this.#ext.lockTask.bind(this.#ext),
                                              'channel-secure-symbolic');

        Main.panel.addToStatusArea(this.#ext.metadata.uuid, this);
    }


    _init()
    {
        super._init(0.5, 'Keyring Autolock');
    }


    destroy()
    {
        this.#ext = null;

        this.#icon.destroy();
        this.#icon = null;

        this.#lock_item.destroy();
        this.#lock_item = null;

        super.destroy();
    }


    updateIcon(name)
    {
        this.#icon.set_icon_name(name);
    }


    async _onOpenStateChanged(menu, is_open)
    {
        super._onOpenStateChanged(menu, is_open);
        try {
            await this.#ext.refreshLevel();
            this.#lock_item.visible = this.#ext.level != 'high';
        }
        catch (e) {
            logError(e, 'onOpenStateChanged()');
        }
    }

};


export default
class KeyringAutolockExtension extends Extension {

    #indicator;
    #check_interval = 30;
    #lock_delay = 60;
    #check_source = 0;
    #lock_source = 0;
    #level = 'medium';
    #settings;


    enable()
    {
        this.#indicator = new Indicator(this);


        this.#settings = this.getSettings();

        this.#settings.connect('changed::check-interval',
                               (settings, key) => this.check_interval = settings.get_uint(key));

        this.#settings.connect('changed::lock-delay',
                               (settings, key) => this.lock_interval = settings.get_uint(key));

        this.check_interval = this.#settings.get_uint('check-interval');
        this.lock_delay = this.#settings.get_uint('lock-delay');

        // do a one-time check right away
        GLib.idle_add(300, () => { this.checkTask(); return false; });

    }


    disable()
    {
        this.cancelCheckTask();
        this.cancelLockTask();

        this.#settings = null;

        this.#indicator?.destroy();
        this.#indicator = null;
    }


    set level(val)
    {
        if (val == this.#level)
            return;
        this.#level = val;
        const level_to_icon = {
            'high': 'security-high-symbolic',
            'medium': 'security-medium-symbolic',
            'low': 'security-low-symbolic'
        };
        this.#indicator.updateIcon(level_to_icon[this.#level]);
    }


    get level()
    {
        return this.#level;
    }


    async refreshLevel()
    {
        try {
            const [service, collections] = await this.getCollections();

            const locked = collections.reduce((total, c) => total + c.locked, 0);

            /*
             * BUG: libsecret does not always report the updated locked state on
             * password-less collections. But if we disonnect the service, it will work
             * correctly next time.
             */
            Secret.Service.disconnect();

            if (locked == collections.length)
                this.level = 'high';
            else if (locked == 0)
                this.level = 'low';
            else
                this.level = 'medium';
        }
        catch (e) {
            logError(e, 'getLevel()');
        }
    }


    set check_interval(val)
    {
        this.#check_interval = val;
        this.scheduleCheckTask();
    }


    get check_interval()
    {
        return this.#check_interval;
    }


    scheduleCheckTask()
    {
        this.cancelCheckTask();
        this.#check_source = GLib.timeout_add(300,
                                              this.check_interval * 1000,
                                              this.checkTask.bind(this));
    }


    cancelCheckTask()
    {
        if (this.#check_source) {
            GLib.Source.remove(this.#check_source);
            this.#check_source = 0;
        }
    }


    async checkTask()
    {
        try {
            await this.refreshLevel();

            // always schedule a lock if we're below 'high' and there isn't a lock scheduled
            if (this.level != 'high')
                if (!this.hasPendingLockTask())
                    this.scheduleLockTask();
        }
        catch (e) {
            logError(e, 'checkTask()');
        }
        return true; // continuous invocation
    }


    set lock_delay(val)
    {
        this.#lock_delay = val;
        if (this.hasPendingLockTask()) {
            this.cancelLockTask();
            this.scheduleLockTask();
        }
    }


    get lock_delay()
    {
        return this.#lock_delay;
    }


    // return true if there's already a locking task scheduled
    hasPendingLockTask()
    {
        return this.#lock_source != 0;
    }


    scheduleLockTask()
    {
        this.cancelLockTask();
        this.#lock_source = GLib.timeout_add(0,
                                             this.lock_delay * 1000,
                                             this.lockTask.bind(this));
    }


    cancelLockTask()
    {
        if (!this.hasPendingLockTask())
            return;
        GLib.Source.remove(this.#lock_source);
        this.#lock_source = 0;
    }


    async lockTask()
    {
        this.cancelLockTask();
        try {
            let [service, collections] = await this.getCollections();

            let [n, locked] = await service.lock(collections, null);
            // console.log(`Locked ${n} collections in the keyring.`);

            await this.checkTask();
        }
        catch (e) {
            logError(e, 'lockTask()');
        }
        return false; // means "don't call again"
    }


    // return all collections we want to lock, except 'session'.
    async getCollections()
    {
        let service = await Secret.Service.get(Secret.ServiceFlags.LOAD_COLLECTIONS, null);
        let collections = service.get_collections();

        const session = await Secret.Collection.for_alias(service,
                                                          'session',
                                                          Secret.CollectionFlags.NONE,
                                                          null);
        const session_path = session.get_object_path();
        collections = collections.filter(c => c.get_object_path() != session_path);

        return [service, collections];
    }

};
