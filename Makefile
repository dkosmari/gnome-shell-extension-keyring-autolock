NAME := "Keyring Autolock"
UUID := keyring-autolock@dkosmari.github.com
URL := https://github.com/dkosmari/gnome-shell-extension-keyring-autolock


ZIP_FILE := $(UUID).shell-extension.zip

POT_FILE := po/$(UUID).pot
PO_FILES := $(wildcard po/*.po)

SOURCES := extension.js prefs.js

EXTRA_DIST := \
	AUTHORS \
	COPYING \
	README.md


.PHONY: all clean install update-po


all: $(ZIP_FILE)


clean:
	$(RM) $(ZIP_FILE)


install: $(ZIP_FILE)
	gnome-extensions install --force $(ZIP_FILE)


$(ZIP_FILE): $(SOURCES) $(EXTRA_SOURCES) $(EXTRA_DIST) $(PO_FILES)
	gnome-extensions pack \
		--force \
		--podir=po \
		$(patsubst %,--extra-source=%,$(EXTRA_DIST))


$(POT_FILE): $(SOURCES) $(EXTRA_SOURCES)
	xgettext \
		--from-code=UTF-8 \
		--copyright-holder="Daniel K. O." \
		--package-name="$(NAME)" \
		--msgid-bugs="$(URL)" \
		--output=$@ \
		$^


update-po: $(PO_FILES)


%.po: $(POT_FILE)
	msgmerge --update $@ $^
	touch $@

