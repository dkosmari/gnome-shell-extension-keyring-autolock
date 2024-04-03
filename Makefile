JQ := jq

ifeq (, $(shell which $(JQ)))
$(error "$(JQ)" executable not found)
endif


GETTEXT_DOMAIN := $(shell $(JQ) -r '.["gettext-domain"]' metadata.json)
PACKAGE := $(shell $(JQ) -r ".name" metadata.json)
SETTINGS_SCHEMA := $(shell $(JQ) -r '.["settings-schema"]' metadata.json)
URL	:= $(shell $(JQ) -r '.url' metadata.json)
UUID	:= $(shell $(JQ) -r ".uuid" metadata.json)


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
	$(RM) schemas/*.compiled


install: $(ZIP_FILE)
	gnome-extensions install --force $(ZIP_FILE)


$(ZIP_FILE):	metadata.json \
		$(SOURCES) \
		$(EXTRA_SOURCES) \
		$(EXTRA_DIST) \
		$(GSCHEMA_XML_FILE) \
		$(PO_FILES)
	gnome-extensions pack --force \
		$(patsubst %,--extra-source=%,$(EXTRA_DIST))


$(POT_FILE): $(SOURCES) $(EXTRA_SOURCES)
	xgettext --from-code=UTF-8 \
		--copyright-holder="Daniel K. O." \
		--package-name="$(PACKAGE)" \
		--msgid-bugs-address="$(URL)" \
		--output=$@ \
		$^


update-po: $(PO_FILES)


%.po: $(POT_FILE)
	msgmerge --update $@ $^
	touch $@

