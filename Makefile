JQ := jq

ifeq (, $(shell which $(JQ)))
$(error "$(JQ)" executable not found)
endif


UUID := $(shell $(JQ) -r ".uuid" metadata.json)
GETTEXT_DOMAIN := $(shell $(JQ) -r '.["gettext-domain"]' metadata.json)
SETTINGS_SCHEMA := $(shell $(JQ) -r '.["settings-schema"]' metadata.json)


ZIP_FILE := $(UUID).shell-extension.zip

POT_FILE := po/$(GETTEXT_DOMAIN).pot
PO_FILES := $(wildcard po/*.po)

SOURCES := extension.js prefs.js

EXTRA_DIST := \
	AUTHORS \
	COPYING \
	README.md

GSCHEMA_XML_FILE := schemas/$(SETTINGS_SCHEMA).gschema.xml


.PHONY: all clean install update-po


all: $(ZIP_FILE)


clean:
	$(RM) $(ZIP_FILE)
	$(RM) po/*.mo


install: $(ZIP_FILE)
	gnome-extensions install --force $(ZIP_FILE)


$(ZIP_FILE): $(SOURCES) $(EXTRA_SOURCES) $(EXTRA_DIST) $(GSCHEMA_XML_FILE) $(PO_FILES)
	gnome-extensions pack \
		--force \
		--podir=po \
		$(patsubst %,--extra-source=%,$(EXTRA_DIST))


$(POT_FILE): $(SOURCES) $(EXTRA_SOURCES)
	xgettext --from-code=UTF-8 --output=$@ $^


update-po: $(PO_FILES)


%.po: $(POT_FILE)
	msgmerge --update $@ $^
	touch $@

