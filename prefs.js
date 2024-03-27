/* prefs.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const {
    Adw,
    Gio,
    GObject,
    Gtk
} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();


const _ = ExtensionUtils.gettext;


class KeyringAutolockPreferencesPage extends Adw.PreferencesPage {

    static {
        GObject.registerClass(this);
    }


    #check_spin;
    #hide_switch;
    #lock_spin;
    #settings;


    constructor(ext)
    {
        super({
            title: _('General settings')
        });

        this.#settings = ext.getSettings();


        let general_group = new Adw.PreferencesGroup({
            title: _('General options')
        });
        this.add(general_group);


        let hide_row = new Adw.ActionRow({
            title: _('Hide while locked'),
            tooltip_text: _('Keep the indicator icon hidden while the keyring is locked.')
        });
        general_group.add(hide_row);

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


function fillPreferencesWindow(window)
{
    window.add(new KeyringAutolockPreferencesPage(ExtensionUtils));
}


function init(meta)
{
    ExtensionUtils.initTranslations();
}
