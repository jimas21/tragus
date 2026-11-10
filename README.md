# MagicPodsCore for Steam Frame

This is a fork of [MagicPodsCore](https://github.com/steam3d/MagicPodsCore) by
Aleksandr Maslov and Andrei Litvintsev, adapted to run on the **Steam Frame** (ARM64
SteamOS). All credit for the headphone support goes to the original project; this fork
only adds what the Frame needs. Licence: GPL-3.0, the same as the original.

MagicPodsCore is the background service that talks to your headphones over Bluetooth:
battery levels, noise control, ear detection and the headphones' own settings. It works
with AirPods, Beats, Galaxy Buds and Pixel Buds (see the
[supported headphones](docs/UPSTREAM-README.md#supported-headphones)).

On the Frame you use it through the **MagicPods menu** in Steam's VR interface, from
[jimas21/MagicPodsLinux](https://github.com/jimas21/MagicPodsLinux): a battery
indicator next to the headset battery, a MagicPods tab in the quick menu and low-battery
notifications.

## Install

### With frameplex

In frameplex, open **Settings › Earbuds** and choose **Install earbud support**. It
installs MagicPodsCore and the MagicPods menu and keeps them up to date. (Coming in the
next frameplex beta.)

### Manually

1. Pair your headphones in the Frame's Bluetooth settings.
2. Open a terminal on the Frame (Konsole, in Desktop Mode).
3. Download `magicpodscore-linux-arm64.tar.gz` from the
   [latest release](https://github.com/jimas21/MagicPodsCore/releases/latest), then:

   ```sh
   tar -xzf magicpodscore-linux-arm64.tar.gz
   ./magicpodscore-linux-arm64/install.sh
   ```

4. Install the menu the same way from
   [jimas21/MagicPodsLinux releases](https://github.com/jimas21/MagicPodsLinux/releases/latest)
   (`magicpods-frame-menu.tar.gz`, then `./magicpods-frame-menu/install.sh`).
5. Restart the headset once.

To update, repeat step 3 with the new release; your settings are kept.
To remove: `~/.local/share/magicpodscore/uninstall.sh` (add `--purge` to also delete the
settings, which include the headphones' pairing keys).

Everything runs as your normal user; nothing needs root.

## What this fork changes

- **ARM64 builds** for the Frame, made by GitHub Actions and published as signed
  releases (`.sha256` and an ed25519 `.sig` next to each download).
- **An installer** (`install.sh`) that sets MagicPodsCore up as a user service.
- **Private by default:** the control connection only listens on the headset itself
  (127.0.0.1 and ::1, port 2020), and the settings file, which holds the headphones'
  pairing keys, is written privately and safely.
- **Fixes found on the Frame:**
  - "Switch to speaker when fully removed" and the volume lowering did nothing with the
    Frame's audio system (PipeWire's `a2dp-auto` profiles); they work now.
  - After the earbuds reconnected, audio could stay on the speakers; it now switches
    back to the earbuds.
  - The service no longer hangs at startup if the audio system is not up yet.

The changes are on the `frame-arm64` branch; the original project's README is kept in
[docs/UPSTREAM-README.md](docs/UPSTREAM-README.md), and its WebSocket API in
[api-reference.md](api-reference.md). Technical notes for the Frame:
[docs/FRAME.md](docs/FRAME.md).

## Building

GitHub Actions builds every push that changes the code or the installer
(`.github/workflows/build-arm64.yml`, on GitHub's ARM64 runners). Pushing a tag like `2.0.12-frame.5` creates a draft release with the build, its
signature and the complete corresponding source.

## Credits and licence

- [MagicPodsCore](https://github.com/steam3d/MagicPodsCore),
  [MagicPods for Linux](https://github.com/steam3d/MagicPodsLinux) and
  [MagicPods for Decky](https://github.com/steam3d/MagicPodsDecky) by Aleksandr Maslov
  (<https://magicpods.app>) and Andrei Litvintsev.
- This fork and its changes: GPL-3.0, like the original. The bundled FFmpeg libraries
  are LGPL-2.1; see `SOURCE.txt` in each release.
