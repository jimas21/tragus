#!/bin/sh
# Remove MagicPodsCore and its service. Settings stay in ~/.config/magicpods unless
# --purge is given (they hold the headphones' pairing keys).
set -u
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
systemctl --user disable --now magicpodscore.service 2>/dev/null
rm -f "$units/magicpodscore.service"
systemctl --user daemon-reload
rm -rf "$HOME/.local/share/magicpodscore"
if [ "${1:-}" = "--purge" ]; then
    rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/magicpods"
    echo "Tragus core and its settings removed."
else
    echo "Tragus core removed (settings kept)."
fi
