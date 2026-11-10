# Tragus core on the Steam Frame: technical notes

For installing, see the [README](../README.md). This page is for people who want to know
what the installer does, check an install, or debug one.

## What `install.sh` does

- Copies the release into `~/.local/share/magicpodscore/`: the `magicpodscore` binary
  and `lib/` with the two bundled FFmpeg libraries (`libavcodec.so.58`,
  `libavutil.so.56`, AAC decoder only, used by the AirPods HD microphone). The binary
  finds them through its `$ORIGIN/lib` RUNPATH. A new copy is prepared beside the old
  one and swapped in, so a failed update leaves the old install.
- On a first install only, writes `~/.config/magicpods/config.toml` (folder `0700`, file
  `0600`) with `animation = false` and `logLevel = 30`:
  - `animation` would keep a Bluetooth scan running the whole time, which can disturb
    other Bluetooth devices; nothing on the Frame needs it.
  - `logLevel = 30` (warnings) keeps the log quiet; at 20 every request is logged.

  An existing config is never touched: it holds the headphones' pairing keys and your
  settings.
- Installs `magicpodscore.service` as a **systemd user service** and starts it. It waits
  up to 30 s for Bluetooth at startup and restarts on failure.

No root, no special permissions: the Tragus core talks to BlueZ and PipeWire as your user
and uses no raw sockets.

## Requirements (all present on SteamOS for the Frame)

`libbluetooth.so.3`, `libpulse.so.0`, `libsystemd.so.0`, `libcrypto.so.3`, `libz.so.1`,
`libstdc++` with `GLIBCXX_3.4.30` or newer, glibc 2.35 or newer, BlueZ on the system
bus, and PipeWire with its PulseAudio layer. Checked on SteamOS VR 0.5.8 (glibc 2.43).

## Privacy and security

- The control connection (a WebSocket, see [api-reference.md](../api-reference.md))
  listens on the headset only: `127.0.0.1:2020`, and `[::1]:2020` when IPv6 is on. It
  has no password, so any program on the headset can use it.
- `GetSettingsAll`, `GetSettings` and `GetSetting` can return the headphones' pairing
  keys (`irk`, `enc`). Never forward port 2020 off the headset.
- `config.toml` is written to a temporary file and renamed into place, mode `0600`.

## Settings worth knowing

- Ear detection pauses media when an earbud comes out (`ear_pause_media`, on by
  default) and can move audio to the Frame's speakers when both are out
  (`ear_switch_to_speakers`). Both are in the Tragus menu.
- The Tragus menu keeps its own settings in the same file, under `[magicpodsframe]`:
  `low_battery` (notification threshold in %, 0 = off, default 30) and `standby_fix`
  ("Disable headphone standby mode", default off).

## Checking an install

```sh
systemctl --user status magicpodscore --no-pager
journalctl --user -u magicpodscore -n 50 --no-pager
ss -ltn 'sport = :2020'        # 127.0.0.1:2020 and [::1]:2020 only
ldd ~/.local/share/magicpodscore/magicpodscore | grep 'not found'   # no output
bluetoothctl info AA:BB:CC:DD:EE:FF | grep -E 'Connected|Trusted'
pactl get-default-sink; pactl list sinks short
```

If your headphones are listed but show no noise control or ear detection, check that
BlueZ reports an Apple `Modalias` for them (`bluetooth:v004C...`):
`busctl --system get-property org.bluez /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF org.bluez.Device1 Modalias`.
Models the core does not know are handled as a generic headset, with fewer features.

Only one copy of the Tragus core can run at a time (the port is exclusive); a second copy exits.
