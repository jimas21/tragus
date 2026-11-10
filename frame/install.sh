#!/bin/sh
# Install (or update) MagicPodsCore on an ARM64 SteamOS headset (Steam Frame) for the
# current user, as a systemd --user service. No root. Run from the unpacked release:
#   ./magicpodscore-linux-arm64/install.sh
# Settings (config.toml) are never overwritten; they hold the headphones' pairing keys.
set -eu
src="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/.local/share/magicpodscore"
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
conf_dir="${XDG_CONFIG_HOME:-$HOME/.config}/magicpods"

for f in magicpodscore lib/libavcodec.so.58 lib/libavutil.so.56 magicpodscore.service; do
    [ -f "$src/$f" ] || { echo "error: $f is missing from $src" >&2; exit 1; }
done

# Copy into a fresh directory, then swap it in, so a failed copy leaves the old install.
mkdir -p "$(dirname "$dest")" "$units"
rm -rf "$dest.new"
mkdir -p "$dest.new/lib"
cp -f "$src/magicpodscore" "$dest.new/"
cp -f "$src/lib/"* "$dest.new/lib/"
for f in LICENSE SOURCE.txt install.sh uninstall.sh magicpodscore.service magicpods-frame-install.py; do
    if [ -f "$src/$f" ]; then cp -f "$src/$f" "$dest.new/"; fi
done
chmod 755 "$dest.new/magicpodscore"
"$dest.new/magicpodscore" --version >/dev/null

# Headset-friendly defaults, only on a first install.
if [ ! -e "$conf_dir/config.toml" ]; then
    mkdir -p "$conf_dir"
    chmod 700 "$conf_dir"
    ( umask 077 && printf '[magicpods]\nanimation = false\nlogLevel = 30\n' > "$conf_dir/config.toml" )
fi

systemctl --user stop magicpodscore.service 2>/dev/null || true
rm -rf "$dest.old"
if [ -d "$dest" ]; then mv "$dest" "$dest.old"; fi
mv "$dest.new" "$dest"
rm -rf "$dest.old"

cp -f "$dest/magicpodscore.service" "$units/magicpodscore.service"
systemctl --user daemon-reload
systemctl --user enable magicpodscore.service
systemctl --user restart --no-block magicpodscore.service
# The unit waits up to 30 s for Bluetooth before it starts; wait for it.
state=unknown
for i in $(seq 1 40); do
    state="$(systemctl --user is-active magicpodscore.service 2>/dev/null || true)"
    case "$state" in
        active|failed|inactive) break ;;
    esac
    sleep 1
done
if [ "$state" = active ]; then
    echo "Tragus core installed and running."
else
    echo "error: magicpodscore.service did not start; see: journalctl --user -u magicpodscore" >&2
    exit 1
fi
