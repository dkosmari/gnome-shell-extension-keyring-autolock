#!/bin/bash -xe

REF_POT=(po/*.pot)

xgettext \
     --from-code=UTF-8 \
     --copyright-holder='Daniel K. O.' \
     --package-name='Keyring Autolock' \
     --msgid-bugs='https://github.com/dkosmari/gnome-shell-extension-keyring-autolock' \
     --output="$REF_POT" \
     *.js


for f in po/*.po
do
    msgmerge --update "$f" "$REF_POT"
done

exit 0
