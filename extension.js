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
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

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


    #collection_items = [];
    #ext;
    #icon;
    #lock_item;
    #status_item;


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
                            () => this.#ext.openPreferences(),
                            'preferences-other-symbolic');

        this.#lock_item = this.menu.addAction(_('Lock the keyring now'),
                                              () => this.#ext.lockAll(),
                                              'channel-secure-symbolic');

        this.#status_item = new PopupMenu.PopupSeparatorMenuItem('-');
        this.menu.addMenuItem(this.#status_item);

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

        this.#status_item.destroy();
        this.#status_item = null;

        super.destroy();
    }


    updateIcon(name)
    {
        this.#icon.set_icon_name(name);
    }


    _onOpenStateChanged(menu, is_open)
    {
        super._onOpenStateChanged(menu, is_open);
        if (is_open)
            this.updateLockedStatus();
    }


    async updateLockedStatus()
    {
        try {
            const [locked, total, level, collections] = await this.#ext.refreshLevel();
            this.#status_item.label.text = _('Locked:') + ` ${locked} / ${total}`;
            this.#lock_item.visible = level != 'high';

            this.#collection_items.forEach(item => item.destroy());
            this.#collection_items = [];
            collections.forEach(col => {
                const item = this.menu.addAction(col.label,
                                                 () => this.#ext.lockCollection(col),
                                                 col.locked
                                                 ? 'changes-prevent-symbolic'
                                                 : 'changes-allow-symbolic');
                if (col.locked)
                    item.sensitive = false;
                this.#collection_items.push(item);
            });
        }
        catch (e) {
            logError(e, 'updatedLockedStatus()');
        }
    }

};


export default
class KeyringAutolockExtension extends Extension {

    #check_interval = 30;
    #check_interval_signal = 0;
    #delayed_lock_source = 0;
    #hide_locked = false;
    #hide_locked_signal = 0;
    #ignored = [];
    #ignored_signal = 0;
    #indicator;
    #level = 'medium';
    #lock_delay = 60;
    #lock_delay_signal = 0;
    #periodic_check_source = 0;
    #settings;


    enable()
    {
        this.#indicator = new Indicator(this);


        this.#settings = this.getSettings();

        this.#check_interval_signal =
            this.#settings.connect('changed::check-interval',
                                   (settings, key) => {
                                       this.check_interval = settings.get_uint(key);
                                   });

        this.#hide_locked_signal =
            this.#settings.connect('changed::hide-locked',
                                   (settings, key) => {
                                       this.hide_locked = settings.get_boolean(key);
                                   });

        this.#lock_delay_signal =
            this.#settings.connect('changed::lock-delay',
                                   (settings, key) => {
                                       this.lock_delay = settings.get_uint(key);
                                   });

        this.#ignored_signal =
            this.#settings.connect('changed::ignored-collections',
                                   (settings, key) => {
                                       this.ignored = settings.get_value(key).get_objv();
                                   });


        this.check_interval = this.#settings.get_uint('check-interval');
        this.hide_locked    = this.#settings.get_boolean('hide-locked');
        this.lock_delay     = this.#settings.get_uint('lock-delay');
        this.ignored        = this.#settings.get_value('ignored-collections').get_objv();

    }


    disable()
    {
        this.cancelPeriodicCheck();
        this.cancelDelayedLock();

        if (this.#check_interval_signal) {
            this.#settings?.disconnect(this.#check_interval_signal);
            this.#check_interval_signal = 0;
        }

        if (this.#hide_locked_signal) {
            this.#settings?.disconnect(this.#hide_locked_signal);
            this.#hide_locked_signal = 0;
        }

        if (this.#lock_delay_signal) {
            this.#settings?.disconnect(this.#lock_delay_signal);
            this.#lock_delay_signal = 0;
        }

        if (this.#ignored_signal) {
            this.#settings?.disconnect(this.#ignored_signal);
            this.#ignored_signal = 0;
        }

        this.#settings = null;

        this.#indicator?.destroy();
        this.#indicator = null;
    }


    set level(val)
    {
        this.#level = val;
        if (this.hide_locked) {
            if (this.#level == 'high')
                this.#indicator?.hide();
            else
                this.#indicator?.show();
        }

        const level_to_icon = {
            'high'   : 'security-high-symbolic',
            'medium' : 'security-medium-symbolic',
            'low'    : 'security-low-symbolic'
        };
        this.#indicator?.updateIcon(level_to_icon[this.#level]);
    }


    get level()
    {
        return this.#level;
    }


    async refreshLevel()
    {
        try {
            /*
             * WORKAROUND: libsecret does not always report the updated locked state on
             * password-less collections. But if we disonnect the service, it will work
             * correctly next time.
             */
            Secret.Service.disconnect();

            const [service, collections] = await this.getCollections();

            const locked = collections.reduce((total, c) => total + c.locked, 0);

            if (locked == collections.length)
                this.level = 'high';
            else if (locked == 0)
                this.level = 'low';
            else
                this.level = 'medium';

            return [locked, collections.length, this.level, collections];
        }
        catch (e) {
            logError(e, 'getLevel()');
            return [0, 0, 'medium', []];
        }
    }


    set check_interval(val)
    {
        this.#check_interval = val;
        // set it up again, so it uses the new value
        this.cancelPeriodicCheck();
        this.schedulePeriodicCheck();

        this.checkTask(); // no waiting
    }


    get check_interval()
    {
        return this.#check_interval;
    }


    schedulePeriodicCheck()
    {
        if (this.#periodic_check_source)
            return;

        this.#periodic_check_source = GLib.timeout_add(GLib.PRIORITY_LOW,
                                                       this.check_interval * 1000,
                                                       this.checkTask.bind(this));
    }


    cancelPeriodicCheck()
    {
        if (this.#periodic_check_source) {
            GLib.Source.remove(this.#periodic_check_source);
            this.#periodic_check_source = 0;
        }
    }


    async checkTask()
    {
        try {
            let [locked, total, level, collections] = await this.refreshLevel();

            // always schedule a lock if we're below 'high' and there isn't a lock scheduled
            if (level != 'high')
                if (!this.hasPendingLock())
                    this.scheduleDelayedLock();
        }
        catch (e) {
            logError(e, 'checkTask()');
        }
        return GLib.SOURCE_CONTINUE;
    }


    set hide_locked(val)
    {
        this.#hide_locked = val;
        if (this.#hide_locked) {
            if (this.level == 'high')
                this.#indicator?.hide();
            else
                this.#indicator?.show();
        } else
            this.#indicator?.show();

        this.checkTask(); // no waiting
    }


    get hide_locked()
    {
        return this.#hide_locked;
    }


    set lock_delay(val)
    {
        this.#lock_delay = val;
        // if a lock is scheduled, make sure it uses the new delay
        if (this.hasPendingLock()) {
            this.cancelDelayedLock();
            this.scheduleDelayedLock();
        } else
            this.checkTask(); // no waiting
    }


    get lock_delay()
    {
        return this.#lock_delay;
    }


    // return true if there's already a locking task scheduled
    hasPendingLock()
    {
        return this.#delayed_lock_source != 0;
    }


    scheduleDelayedLock()
    {
        if (this.hasPendingLock())
            return;

        this.#delayed_lock_source =
            GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                             this.lock_delay * 1000,
                             this.lockAll.bind(this));
    }


    cancelDelayedLock()
    {
        if (this.hasPendingLock()) {
            GLib.Source.remove(this.#delayed_lock_source);
            this.#delayed_lock_source = 0;
        }
    }


    async lockAll()
    {
        try {
            let [service, collections] = await this.getCollections();
            await service.lock(collections, null);
        }
        catch (e) {
            logError(e, 'lockAll()');
        }
        this.cancelDelayedLock();
        this.checkTask(); // no waiting
        return GLib.SOURCE_REMOVE;
    }


    async lockCollection(col)
    {
        try {
            await col.service.lock([col], null);
        }
        catch (e) {
            logError(e, 'lockCollection()');
        }
        this.checkTask(); // no waiting
    }


    set ignored(val)
    {
        this.#ignored = val;
        this.checkTask(); // no waiting
    }


    get ignored()
    {
        return this.#ignored;
    }


    // return all non-ignored collections, except 'session'.
    async getCollections()
    {
        const service = await Secret.Service.get(Secret.ServiceFlags.LOAD_COLLECTIONS, null);
        let collections = service.get_collections();

        const session = await Secret.Collection.for_alias(service,
                                                          'session',
                                                          Secret.CollectionFlags.NONE,
                                                          null);
        const session_path = session?.get_object_path();

        let ignored = this.ignored.slice(); // make a copy
        ignored.push(session_path);

        collections = collections.filter(c => !ignored.includes(c.get_object_path()));

        collections.sort((a, b) => a.label.localeCompare(b.label));

        return [service, collections];
    }

};
