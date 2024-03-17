/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


/* exported init */

const {
    Gio,
    GLib,
    GObject,
    Secret,
    St
} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;


const _ = ExtensionUtils.gettext;


Gio._promisify(Secret.Collection, 'for_alias', 'for_alias_finish');
Gio._promisify(Secret.Service, 'get', 'get_finish');
Gio._promisify(Secret.Service.prototype, 'lock', 'lock_finish');


class Indicator extends PanelMenu.Button {

    static {
        GObject.registerClass(this);
    }


    constructor(uuid)
    {
        super();

        // TODO: have these set by the preferences
        this._lock_delay = 60;
        this._check_interval = 30;


        this._icon = new St.Icon({
            icon_name: 'security-medium-symbolic',
            style_class: 'system-status-icon',
        });

        this.add_child(this._icon);

        this.changeLevel('medium');

        this.menu.addAction(_('Settings...'),
                            this.editSettings.bind(this),
                            'document-edit-symbolic');

        this.menu.addAction(_('Lock keyring'),
                            this.lockKeyring.bind(this),
                            'channel-secure-symbolic');

        Main.panel.addToStatusArea(uuid, this);


        GLib.idle_add(300, () => { this.checkKeyring(); return false; });
        this._check_source = GLib.timeout_add(300,
                                              this._check_interval * 1000,
                                              this.checkKeyring.bind(this));

        this._lock_source = 0;
    }


    _init()
    {
        super._init(0.5, 'Keyring Autolock');
    }


    destroy()
    {
        if (this._check_source) {
            GLib.Source.remove(this._check_source);
            this._check_source = 0;
        }

        this.cancelLock();

        this._icon.destroy();
        this._icon = null;

        super.destroy();
    }


    changeLevel(level)
    {
        if (level == this._current_level)
            return;
        this._current_level = level;
        const level_to_icon = {
            'high': 'security-high-symbolic',
            'medium': 'security-medium-symbolic',
            'low': 'security-low-symbolic'
        };
        this._icon.set_icon_name(level_to_icon[level]);
    }


    async _onOpenStateChanged(menu, is_open)
    {
        super._onOpenStateChanged(menu, is_open);
        try {

        }
        catch (e) {
            logError(e, 'onOpenStateChanged()');
        }
    }


    editSettings()
    {
        ExtensionUtils.openPrefs();
    }


    async lockKeyring()
    {
        try {

            let [service, collections] = await this.getCollections();

            let [n, locked] = await service.lock(collections, null);
            console.log(`Locked ${n} collections in the keyring.`);

            await this.checkKeyring();
        }
        catch (e) {
            logError(e, 'lockKeyring()');
        }
    }


    async checkKeyring()
    {
        try {
            const [service, collections] = await this.getCollections();

            //collections.forEach(c => log(`${c.get_object_path()}.locked = ${c.get_locked()}`));

            const locked = collections.reduce((total, c) => total + c.locked, 0);

            /*
             * BUG: libsecret does not always report the updated locked state on
             * password-less collections. But if we disonnect the service, it will work
             * correctly.
             */
            Secret.Service.disconnect();

            if (locked == collections.length)
                this.changeLevel('high');
            else {
                if (locked == 0)
                    this.changeLevel('low');
                else
                    this.changeLevel('medium');

                if (!this.hasPendingLock())
                    this.scheduleLock();
            }
        }
        catch (e) {
            logError(e, 'checkKeyring()');
        }
        return true; // continuous invocation
    }


    // return true if there's already a locking task scheduled
    hasPendingLock()
    {
        return this._lock_source != 0;
    }


    scheduleLock()
    {
        this.cancelLock();
        this._lock_source = GLib.timeout_add(0,
                                             this._lock_delay * 1000,
                                             this.lockCallback.bind(this));
    }


    cancelLock()
    {
        if (!this.hasPendingLock())
            return;
        GLib.Source.remove(this._lock_source);
        this._lock_source = 0;
    }


    lockCallback()
    {
        this.cancelLock();
        this.lockKeyring();
        return false;
    }


    // return all collections we want to lock, exclude 'session'.
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


class Extension {

    constructor(uuid)
    {
        this._uuid = uuid;
    }


    enable()
    {
        this._indicator = new Indicator(this._uuid);
    }


    disable()
    {
        this._indicator?.destroy();
        this._indicator = null;
    }

};


function init(meta)
{
    ExtensionUtils.initTranslations();
    return new Extension(meta.uuid);
}
