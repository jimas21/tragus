# Running MagicPodsCore on an ARM64 SteamOS headset

This guide covers running the `linux-arm64` build of MagicPodsCore as a normal
user service on an ARM64 SteamOS device such as the Steam Frame. Nothing here
needs root.

MagicPodsCore is a separate program. Clients talk to it over a local WebSocket
(see [api-reference.md](../api-reference.md)).

## What it needs

- BlueZ on the **system** D-Bus, with the headphones **paired and connected**
  (pair them in the Steam Bluetooth settings or with `bluetoothctl`).
  MagicPodsCore never pairs on its own.
- The desktop user's session: `HOME`, `XDG_RUNTIME_DIR`, the session bus
  (used only to pause/resume media players on ear removal) and
  pipewire-pulse (optional audio features: if it is not reachable at start,
  a warning is logged and those features stay off until a restart; battery,
  noise control and ear detection are not affected).
- These system libraries: `libbluetooth.so.3`, `libpulse.so.0`,
  `libsystemd.so.0`, `libcrypto.so.3`, `libz.so.1`, `libstdc++.so.6`,
  `libgcc_s.so.1`, glibc 2.35 or newer. FFmpeg (`libavcodec.so.58`,
  `libavutil.so.56`, AAC decoder only) is bundled in `lib/`.

  On an Arch-based system these come from bluez-libs, libpulse, systemd-libs,
  openssl, zlib, gcc-libs (its libstdc++ must provide `GLIBCXX_3.4.30`, i.e.
  GCC 12 or newer) and glibc. If the root filesystem is read-only, a library
  that `ldd` reports as not found cannot simply be installed, so run the
  `ldd` check in step 5 first.

No root, no `setcap`, no capabilities: the only Bluetooth sockets it opens are
outbound L2CAP/RFCOMM connections, which an unprivileged user may make.

## 1. Get the build

The `Build linux-arm64` workflow on the `frame-arm64` branch uploads an
artifact named `magicpodscore-linux-arm64` (a zip holding
`magicpodscore-linux-arm64.tar.gz` and its `.sha256`). Copy both files into
`~/.local/share/magicpodscore/` on the device, then:

```bash
cd ~/.local/share/magicpodscore
sha256sum -c magicpodscore-linux-arm64.tar.gz.sha256
tar -xzf magicpodscore-linux-arm64.tar.gz --strip-components=1
./magicpodscore --version
```

The binary finds the bundled FFmpeg through its `$ORIGIN/lib` RUNPATH, so keep
`lib/` beside it. `SOURCE.txt` names the exact source commit (GPL-3.0) and the
FFmpeg source and configure flags (LGPL-2.1).

## 2. Seed the config before the first start

The config lives at `$XDG_CONFIG_HOME/magicpods/config.toml`, else
`~/.config/magicpods/config.toml`. MagicPodsCore adds missing defaults and
never overwrites keys that are already there, so write the headset-friendly
values first:

```bash
mkdir -p ~/.config/magicpods && chmod 700 ~/.config/magicpods
( umask 077 && printf '[magicpods]\nanimation = false\nlogLevel = 30\n' > ~/.config/magicpods/config.toml )
```

- `animation = false`: the case-open animation keeps BlueZ discovery (an
  active LE scan) running the whole time any AirPods are paired, which can disturb other Bluetooth
  devices, and an unexpected discovery error at startup stops the process.
  Battery, noise control and ear detection do not need it.
- `logLevel = 30` (warnings): at the default 20 every incoming WebSocket
  message is logged.
- Ear detection pauses and resumes media players by default: the per-device
  `ear_pause_media` key counts as true when absent, and is written only after
  a client changes it. To turn it off ahead of time, add a section named after
  the headphones' address with colons replaced by underscores:

  ```toml
  [AA_BB_CC_DD_EE_FF]
  ear_pause_media = false
  ```

  Or, at runtime, a client that handles pausing itself sends `SetCapabilities`
  (all three keys are required):

  ```json
  {"method":"SetCapabilities","arguments":{"address":"AA:BB:CC:DD:EE:FF",
   "capabilities":{"earDetection":{"selected":{"pauseMedia":false,"switchToSpeakers":false,"lowerVolume":0}}}}}
  ```

## 3. Run it as a `systemd --user` service

`~/.config/systemd/user/magicpodscore.service`:

```ini
[Unit]
Description=MagicPodsCore (headphone control, local WebSocket on port 2020)
After=pipewire-pulse.socket
Wants=pipewire-pulse.socket
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
# BlueZ is on the system bus, which a user unit cannot order after; wait for it briefly.
ExecStartPre=/bin/sh -c 'for i in $(seq 1 30); do busctl --system status org.bluez >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0'
ExecStart=%h/.local/share/magicpodscore/magicpodscore
UnsetEnvironment=LD_LIBRARY_PATH LD_PRELOAD
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
SyslogIdentifier=magicpodscore

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now magicpodscore.service
journalctl --user -u magicpodscore -f
```

Do not add `PrivateNetwork=`: Bluetooth sockets live in the host network
namespace. Only one instance can run (the port is exclusive; a second one
exits), so a client that might also start it should first check whether the
port is already served and attach instead. If something else held port 2020
at start, the unit stops retrying after five attempts; free the port, then run
`systemctl --user reset-failed magicpodscore && systemctl --user start magicpodscore`.

The unit starts with the user's systemd manager, i.e. when that user's session
starts. On a device that logs the desktop user in automatically nothing more is
needed. For the service to run before or without a login session, run
`loginctl enable-linger "$USER"` once.

## 4. Security notes

- The WebSocket server listens on the loopback addresses only
  (`127.0.0.1:2020`, and `[::1]:2020` when IPv6 is available). It has no
  authentication, so any program running on the device can use it.
- `GetSettingsAll` returns the whole config, and `GetSettings` /
  `GetSetting` return any section or key on request; all three expose each
  AirPods' `irk` and `enc` keys. Do not forward or proxy port 2020 off the
  device.
- `config.toml` holds those keys. It is written to a temporary file and
  renamed into place with mode `0600`; a new config directory is created
  `0700`.

## 5. Verify on the device

Run these as the desktop user, with the headphones connected:

```bash
# Libraries and loader
readelf -d ~/.local/share/magicpodscore/magicpodscore | grep -E 'NEEDED|RUNPATH'
ldd ~/.local/share/magicpodscore/magicpodscore | grep 'not found'    # expect no output
ldd --version | head -n1                                              # expect 2.35 or newer

# BlueZ reachable on the system bus, and the policy allows this user
busctl --system call org.bluez / org.freedesktop.DBus.ObjectManager GetManagedObjects | head -c 300; echo
grep -A3 'context="default"' /usr/share/dbus-1/system.d/bluetooth.conf

# Headphones recognised (Apple vendor 004C); replace the address
busctl --system get-property org.bluez /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF org.bluez.Device1 Modalias

# Audio server and session
pactl info | grep -i 'server name'; pactl list cards short
echo "$XDG_RUNTIME_DIR"; id -u

# Service, listener and config
systemctl --user status magicpodscore --no-pager
ss -ltn 'sport = :2020'     # expect 127.0.0.1:2020 and, with IPv6, [::1]:2020; never 0.0.0.0 or [::]
stat -c '%a %n' ~/.config/magicpods ~/.config/magicpods/config.toml   # expect 700 and 600
```

Then connect a WebSocket client to `ws://127.0.0.1:2020/`. It receives an
`init` message; send `{"method":"GetAll"}` and check that the headphones'
`battery`, `anc` and `earDetectionState` capabilities appear. Take one earbud
out and check that `earDetectionState` changes.

If `Modalias` is missing, is not `bluetooth:v004Cp...`, or names a product id
MagicPodsCore does not know, the headphones are treated as a generic headset
(battery only, and only if they expose the Handsfree profile); otherwise they
do not appear in `GetDevices`.
