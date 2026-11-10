# Tragus menu for Steam's VR interface (Steam Frame)

The files in this folder make up the Tragus menu on the Steam Frame. For what it does
and how to install it, see the [project README](../README.md).

| File | What it is |
|---|---|
| `magicpods-menu.js` | The menu itself. Runs inside Steam's VR bottom bar and quick menu, and talks to MagicPodsCore on `ws://127.0.0.1:2020`. |
| `magicpods-steamui.py` | A small background service (Python 3, standard library only). Keeps the current menu in Steam's pages, shows low-battery notifications and runs the standby fix. |
| `magicpods-steamui.service` | Its systemd user unit. |
| `install.sh`, `uninstall.sh` | Set it up or remove it for the current user (no root). |

## What the installer does

- Copies these files to `~/.local/share/magicpods-app/frame/` and enables
  `magicpods-steamui.service`.
- Creates `~/.steam/steam/.cef-enable-remote-debugging` if it is not there. That file
  tells Steam to open its local DevTools connection (on the headset only, 127.0.0.1:8080)
  when it starts; it is the same switch Decky Loader uses, and it is why the headset needs
  one restart after the first install. `uninstall.sh` removes it again if `install.sh`
  created it.

Updating is the same as installing: run the new release's `install.sh`. Within a few
seconds the service replaces the menu in Steam's pages; Steam does not need a restart.
`uninstall.sh` stops the service, removes the menu from Steam's pages and deletes the
files. MagicPodsCore and its settings are not touched.

## How each part works

- **The menu** is added to Steam's pages through that local DevTools connection, the
  mechanism Decky Loader uses. The service only ever sends the contents of
  `magicpods-menu.js`, and removes it when stopped. Elements are found defensively; if a
  Steam update changes the pages, that part simply does not appear.
- **Low-battery notifications** are SteamVR notifications, sent with SteamVR's own
  `vrcmd --notify` (part of SteamVR). Each earbud and the case notify once per connection when they are at
  or below the threshold (Settings, default 30%, 0 turns it off), and again after the
  headphones reconnect.
- **"Disable headphone standby mode"** (off by default) streams digital silence to the
  headphones with PipeWire's `pw-cat` while it is on, so the Bluetooth link never goes
  idle; some AirPods otherwise drop and reconnect in a loop. The stream is pinned to the
  headphones, so switching audio to the speakers does not move it. It uses a little more
  battery while on.
- **Settings:** the menu's own display choices are kept in Steam's browser storage; the
  notification threshold and the standby fix are kept in MagicPodsCore's settings file
  under `[magicpodsframe]`, so the background service can read them.

## Troubleshooting

```sh
systemctl --user status magicpods-steamui --no-pager
journalctl --user -u magicpods-steamui -n 30 --no-pager
```

The log shows a line like `-> installed <version> (bar)` for each Steam page the menu is
in. If it keeps saying it is waiting for Steam, restart the headset once.

## Security note

Steam's DevTools connection has no password. It only listens on the headset, but any
program running on the headset could use it to control Steam's interface, the same as
with Decky Loader.

## Updates

The menu's **Settings › Updates** has **Check for updates** and **Update automatically**
(on by default: first check 10 minutes after the helper starts, then every 6 hours).
The helper runs `~/.local/share/magicpodscore/magicpods-frame-install.py --if-newer`
in its own user unit, `magicpods-update` (it restarts the helper while it works). The
installer checks each download's signature, installs only the parts that have a newer
release, records what is installed in `~/.local/share/magicpods-app/versions.json`, and
writes its progress to `~/.local/state/magicpods/update.json`, which the helper passes on
to the menu. Log: `journalctl --user -u magicpods-update`.
