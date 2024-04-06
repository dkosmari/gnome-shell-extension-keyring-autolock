/* prefs.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


import Adw     from 'gi://Adw';
import Gio     from 'gi://Gio';
import GLib    from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk     from 'gi://Gtk';
import Secret  from 'gi://Secret';

import {
    ExtensionPreferences,
    gettext as _
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';


Gio._promisify(Secret.Collection, 'for_alias', 'for_alias_finish');
Gio._promisify(Secret.Service, 'get', 'get_finish');


function adwCheckVersion(req_major, req_minor)
{
    const major = Adw.get_major_version();
    if (major < req_major)
        return false;
    if (major > req_major)
        return true;
    return Adw.get_minor_version() >= req_minor;
}


class CollectionRow extends Adw.ActionRow {

    static {
        GObject.registerClass(this);
    }


    #switch;
    #path;


    constructor(collection, active, aliases = [])
    {
        super({
            title: collection.label,
            title_lines: 1,
            title_selectable: true,
            subtitle: collection.get_object_path(),
            subtitle_lines: 1,
        });
        if (adwCheckVersion(1, 3))
            this.subtitle_selectable = true;

        this.#path = collection.get_object_path();

        if (aliases)
            this.title += aliases.map(x => `<sup>[${x}]</sup>`).join(' ');

        this.#switch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            action_name: 'kal.collection.update-ignored',
            active: active
        });
        this.add_suffix(this.#switch);
    }


    set active(val)
    {
        this.#switch.active = val;
    }


    get active()
    {
        return this.#switch.active;
    }


    get path()
    {
        return this.#path;
    }

};


class IgnoredPage extends Adw.PreferencesPage {

    static {
        GObject.registerClass(this);

        this.install_action('kal.collection.update-ignored', null,
                            obj => obj.updateIgnored());
    }


    #col_group;
    #settings;
    #rows = [];


    constructor(settings)
    {
        super({
            title: _('Ignored collections'),
            icon_name: 'view-list-symbolic'
        });

        this.#settings = settings;

        this.#col_group =
            new Adw.PreferencesGroup({
                title: _('Ignored collections'),
                description: _('Ignored collections will never be locked by this extensions.')
            });

        this.add(this.#col_group);

        this.refreshCollections();
    }


    async refreshCollections()
    {
        try {
            this.#rows.forEach(r => this.remove(r));
            this.#rows = [];

            const service =
                  await Secret.Service.get(Secret.ServiceFlags.LOAD_COLLECTIONS, null);
            const collections = service.get_collections();

            const known_aliases = [ 'default', 'login', 'session' ];
            const path_to_aliases = {};
            for (let i = 0; i < known_aliases.length; ++i) {
                const alias = known_aliases[i];
                try {
                    const col = await Secret.Collection.for_alias(service,
                                                                  alias,
                                                                  Secret.CollectionFlags.NONE,
                                                                  null);
                    if (col) {
                        const path = col.get_object_path();
                        if (path_to_aliases[path])
                            path_to_aliases[path].push(alias);
                        else
                            path_to_aliases[path] = [alias];
                    }
                }
                catch (e) {
                    logError(e);
                }
            }

            const ignored_collections =
                  this.#settings.get_value('ignored-collections').get_objv();

            for (let i = 0; i < collections.length; ++i) {
                const col = collections[i];
                const path = col.get_object_path();

                // never allow locking the 'session' collection, GNOME Keyring doesn't like it
                const is_session = path_to_aliases[path]?.includes('session');
                if (is_session)
                    continue;

                const ignored = ignored_collections.includes(path);
                const row = new CollectionRow(col, ignored, path_to_aliases[path]);
                this.#col_group.add(row);
                this.#rows.push(row);
            }
        }
        catch (e) {
            logError(e);
        }
    }


    updateIgnored()
    {
        const ignored = this.#rows.filter(r => r.active).map(r => r.path);
        this.#settings.set_value('ignored-collections',
                                 GLib.Variant.new_objv(ignored));
    }

};


class GeneralPage extends Adw.PreferencesPage {

    static {
        GObject.registerClass(this);
    }


    #check_spin;
    #hide_switch;
    #lock_spin;
    #settings;


    constructor(settings)
    {
        super({
            title: _('General settings'),
            icon_name: 'preferences-other-symbolic'
        });

        this.#settings = settings;


        let indicator_group = new Adw.PreferencesGroup({
            title: _('Indicator')
        });
        this.add(indicator_group);


        let hide_row = new Adw.ActionRow({
            title: _('Hide indicator if locked'),
            tooltip_text: _('Keep the indicator icon hidden while the keyring is locked.')
        });
        indicator_group.add(hide_row);

        this.#hide_switch = new Gtk.Switch({
            valign: Gtk.Align.CENTER
        });
        hide_row.add_suffix(this.#hide_switch);
        this.#settings.bind('hide-locked',
                            this.#hide_switch, 'active',
                            Gio.SettingsBindFlags.DEFAULT);


        let timer_group = new Adw.PreferencesGroup({
            title: _('Timers')
        });
        this.add(timer_group);


        let check_row = new Adw.ActionRow({
            title: _('Check interval (seconds)'),
            tooltip_text: _('The keyring is checked periodically, to detect if it is unlocked.'),
        });
        timer_group.add(check_row);

        this.#check_spin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 3600,
                page_increment: 120,
                step_increment: 30,
            }),
            width_chars: 6,
            valign: Gtk.Align.CENTER
        });
        check_row.add_suffix(this.#check_spin);
        this.#settings.bind('check-interval',
                            this.#check_spin, 'value',
                            Gio.SettingsBindFlags.DEFAULT);


        let lock_row = new Adw.ActionRow({
            title: _('Lock delay (seconds)'),
            tooltip_text: _('How long the keyring is allowed to stay unlocked.'),
        });
        timer_group.add(lock_row);

        this.#lock_spin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 86400,
                page_increment: 300,
                step_increment: 60,
            }),
            width_chars: 6,
            valign: Gtk.Align.CENTER
        });
        lock_row.add_suffix(this.#lock_spin);
        this.#settings.bind('lock-delay',
                            this.#lock_spin, 'value',
                            Gio.SettingsBindFlags.DEFAULT);

    }

};


export default
class KeyringAutolockPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window)
    {
        const settings = this.getSettings();
        window.add(new GeneralPage(settings));
        window.add(new IgnoredPage(settings));
    }

};
