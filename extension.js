/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const {
    Gio,
    GLib,
    GObject,
    Secret,
    St
} = imports.gi;

const Main      = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const _ = ExtensionUtils.gettext;


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
                            this.#ext.openPreferences.bind(this.#ext),
                            'preferences-other-symbolic');

        this.#status_item = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this.#status_item);

        this.#lock_item = this.menu.addAction(_('Lock the keyring now'),
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

        this.#status_item.destroy();
        this.#status_item = null;

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
            const [locked, total, level] = await this.#ext.refreshLevel();
            this.#status_item.label.text = _('Locked:') + ` ${locked} / ${total}`;
            this.#lock_item.visible = level != 'high';
        }
        catch (e) {
            logError(e, 'onOpenStateChanged()');
        }
    }

};


class Extension {

    #indicator;
    #check_interval = 30;
    #lock_delay = 60;
    #check_source = 0;
    #lock_source = 0;
    #level = 'medium';
    #settings;


    constructor(meta)
    {
        this.metadata = meta;
    }


    enable()
    {
        this.#indicator = new Indicator(this);


        this.#settings = ExtensionUtils.getSettings();

        this.#settings.connect('changed::check-interval',
                               (settings, key) => this.check_interval = settings.get_uint(key));

        this.#settings.connect('changed::lock-delay',
                               (settings, key) => this.lock_interval = settings.get_uint(key));

        this.check_interval = this.#settings.get_uint('check-interval');
        this.lock_delay = this.#settings.get_uint('lock-delay');

        // do a one-time check right away
        GLib.idle_add(GLib.PRIORITY_DEFAULT,
                      () => {
                          this.checkTask();
                          return GLib.SOURCE_REMOVE;
                      });

    }


    disable()
    {
        this.cancelCheckTask();
        this.cancelLockTask();

        this.#settings = null;

        this.#indicator?.destroy();
        this.#indicator = null;
    }


    openPreferences()
    {
        ExtensionUtils.openPrefs();
    }


    set level(val)
    {
        this.#level = val;
        const level_to_icon = {
            'high'   : 'security-high-symbolic',
            'medium' : 'security-medium-symbolic',
            'low'    : 'security-low-symbolic'
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

            return [locked, collections.length, this.level];
        }
        catch (e) {
            logError(e, 'getLevel()');
            return [0, 0, 'medium'];
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
        this.#check_source = GLib.timeout_add(GLib.PRIORITY_LOW,
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
        return GLib.SOURCE_CONTINUE;
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
        this.#lock_source = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
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
        return GLib.SOURCE_REMOVE;
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


function init(meta)
{
    ExtensionUtils.initTranslations();
    return new Extension(meta);
}
