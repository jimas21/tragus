# MagicPods for Steam Frame

**AirPods and other wireless earbuds, fully working on the Valve Steam Frame:** battery
for each earbud and the case, noise control, ear detection (pause when you take one out,
switch to the headset speakers when both are out) and the headphones' own settings, all
from a menu inside the Frame's VR interface.

This repository is **MagicPodsCore for Steam Frame**, the background service that talks
to the headphones. It is a fork of [MagicPodsCore](https://github.com/steam3d/MagicPodsCore)
by **[Aleksandr Maslov](https://github.com/steam3d) and
[Andrey Litvintsev](https://github.com/andreylitvintsev)**, the authors of
[MagicPods](https://magicpods.app). All the headphone support is their work; this fork
adds what the Frame needs. The menu lives in its sister repository,
[jimas21/MagicPodsLinux](https://github.com/jimas21/MagicPodsLinux), and the one-click
installer below sets up both.

Licence: GPL-3.0, the same as the original.

## Install

On the Steam Frame:

1. Pair your headphones in the Frame's Bluetooth settings.
2. Open a web browser on the headset, go to this page and press the button:

   <a href="https://github.com/jimas21/MagicPodsCore/releases/latest/download/Install-MagicPods.desktop"><img src="docs/images/install-button.svg" alt="Install MagicPods" width="240" /></a>

3. Open the file it downloads (`Install-MagicPods.desktop`). If you are asked whether to
   trust it, say yes. A window opens and installs everything; it checks each download
   before installing it.
4. Restart the headset once. The earbuds battery then shows in the bottom bar, next to
   the headset battery.

**Update:** run the installer again; your settings are kept.
**Remove:** open
[`Uninstall-MagicPods.desktop`](https://github.com/jimas21/MagicPodsCore/releases/latest/download/Uninstall-MagicPods.desktop)
the same way. Your headphone settings stay in `~/.config/magicpods`; delete that folder to
remove them too.

## Works with Laterna

[Laterna](https://github.com/jimas21/laterna), the VR video player for the Steam Frame,
is adding MagicPods support: your video pauses when you take an earbud out, and Laterna
will be able to install earbud support for you from **Settings › Earbuds › Install
earbud support**. Until that is in a Laterna release, install with the button above.

## What you get

- **Battery in the bottom bar** of the Frame's VR interface: one bar per earbud and the
  percentage. Clicking it opens the MagicPods menu.
- **A MagicPods tab** in the quick menu, with the same menus as the
  [MagicPods Decky plugin](https://github.com/steam3d/MagicPodsDecky) on the Steam Deck:
  battery for each earbud and the case, noise control, ear detection, conversation
  awareness, equalizer, press-and-hold controls, Bluetooth devices and settings.
- **Low-battery notifications** that name the part, for example "Left earbud 18%".
- **Automatic speaker switching**: audio moves to the headset speakers when both earbuds
  are out, and back when you put them in.

Supported headphones: AirPods, Beats, Samsung Galaxy Buds and Google Pixel Buds; the
full list is in the [original README](docs/UPSTREAM-README.md#supported-headphones).
Features depend on the model.

## Safe and private

- It runs as your normal user and changes nothing outside your user account.
- Nothing leaves the headset: MagicPodsCore only talks to your headphones and to the
  menu on the headset itself.
- Every download is checked before it is installed: the installer only accepts releases
  signed by this project, and refuses anything else.
- Your headphones' settings are kept private to your user account.
- If a Steam update changes Steam's menus, the battery icon or the MagicPods tab may
  disappear until this project is updated. Your earbuds keep working, including ear
  detection and switching to the speakers.

## For developers

### What this fork changes

- **ARM64 builds** for the Frame, made by GitHub Actions and published as signed
  releases (`.sha256` and an ed25519 `.sig` beside each download).
- **Installers**: `install.sh` sets MagicPodsCore up as a user service; the one-click
  `Install-MagicPods.desktop` and `magicpods-frame-install.py` install it together with
  the menu.
- **Private by default**: the control connection only listens on the headset, and the
  settings file is written privately and atomically.
- **Fixes found on the Frame**:
  - "Switch to speaker when fully removed" and the volume lowering did nothing with the
    Frame's audio system (PipeWire's `a2dp-auto` profiles); they work now.
  - After the earbuds reconnected, audio could stay on the speakers; it now switches
    back to the earbuds.
  - The service no longer hangs at startup if the audio system is not up yet.

The changes are on the `frame-arm64` branch. The original project's README is kept in
[docs/UPSTREAM-README.md](docs/UPSTREAM-README.md) and its WebSocket API in
[api-reference.md](api-reference.md). Technical notes, checks and troubleshooting:
[docs/FRAME.md](docs/FRAME.md).

### Building

GitHub Actions builds every push that changes the code or the installer
(`.github/workflows/build-arm64.yml`, on GitHub's ARM64 runners) and tests the
installer. Pushing a tag like `2.0.12-frame.6` creates a draft release with the build,
its signature, the complete corresponding source and the installer.

## Credits and licence

- **[MagicPods](https://magicpods.app)** by [Aleksandr Maslov](https://github.com/steam3d)
  and [Andrey Litvintsev](https://github.com/andreylitvintsev):
  [MagicPodsCore](https://github.com/steam3d/MagicPodsCore) (forked here),
  [MagicPods for Linux](https://github.com/steam3d/MagicPodsLinux) (forked for the menu)
  and [MagicPods for Decky](https://github.com/steam3d/MagicPodsDecky) (the menu's
  design, behaviour and noise-mode icons follow it). If MagicPods is useful to you,
  consider [supporting the original project](https://magicpods.app/donate/).
- This fork and its changes: GPL-3.0, like the original (see [LICENSE](LICENSE)). The
  bundled FFmpeg libraries are LGPL-2.1-or-later; `SOURCE.txt` in each release says where
  the corresponding source is, and every release includes it.
- AirPods is a trademark of Apple Inc.; Beats, Galaxy Buds, Pixel Buds and Steam Frame
  belong to their owners. They are named only to say what this works with.
