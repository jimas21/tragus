#!/bin/sh
# Install (or update) the MagicPods menu for Steam's VR UI for the current user. No root.
# Run from the unpacked release directory: ./install.sh
set -eu
src="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/.local/share/magicpods-app/frame"
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

command -v python3 >/dev/null 2>&1 || { echo "error: python3 is required" >&2; exit 1; }
if ! systemctl --user cat magicpodscore.service >/dev/null 2>&1; then
    echo "warning: magicpodscore.service not found; install the Tragus core first" >&2
fi

mkdir -p "$dest" "$units"
if [ "$src" != "$dest" ]; then
    for f in magicpods-menu.js magicpods-steamui.py magicpods-steamui.service install.sh uninstall.sh README.md; do
        if ! cp -f "$src/$f" "$dest/$f.new"; then
            rm -f "$dest/$f.new"
            echo "error: could not copy $f from $src" >&2
            exit 1
        fi
    done
    for f in magicpods-menu.js magicpods-steamui.py magicpods-steamui.service install.sh uninstall.sh README.md; do
        mv -f "$dest/$f.new" "$dest/$f"
    done
    for f in LICENSE SOURCE.txt; do
        if [ -f "$src/$f" ]; then cp -f "$src/$f" "$dest/$f"; fi
    done
fi
chmod 755 "$dest/magicpods-steamui.py" "$dest/install.sh" "$dest/uninstall.sh"

# Ask Steam to open its local DevTools endpoint (127.0.0.1:8080) when it starts; the
# menu is added to Steam's pages through it. Same marker file Decky Loader uses.
# Takes effect the next time Steam starts.
marker="$HOME/.steam/steam/.cef-enable-remote-debugging"
if [ -d "$HOME/.steam/steam" ] && [ ! -e "$marker" ]; then
    touch "$marker" && touch "$dest/.created-cef-marker"
fi
cp -f "$dest/magicpods-steamui.service" "$units/magicpods-steamui.service"
systemctl --user daemon-reload
systemctl --user enable magicpods-steamui.service
systemctl --user restart magicpods-steamui.service
sleep 1
if systemctl --user is-active --quiet magicpods-steamui.service; then
    echo "Tragus menu installed and running."
else
    echo "error: magicpods-steamui.service did not start; see: journalctl --user -u magicpods-steamui" >&2
    exit 1
fi
