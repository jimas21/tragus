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

**Updates:** MagicPods keeps itself up to date. In the MagicPods menu, **Settings ›
Updates** has **Check for updates** and an **Update automatically** switch (on by
default). Your settings are kept.
**Remove:** open
[`Uninstall-MagicPods.desktop`](https://github.com/jimas21/MagicPodsCore/releases/latest/download/Uninstall-MagicPods.desktop)
the same way.

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

## For developers

This fork keeps the original code and adds what the Frame needs:

- Builds for the Frame, made on GitHub for every release.
- The install button and the script it runs (in `frame/`).
- Audio fixes for the Frame: switching to the speakers when you take the earbuds out,
  and back when you put them in.

Everything is on the `frame-arm64` branch. Pushing a tag like `2.0.12-frame.8` builds a
release. How the install works: [docs/FRAME.md](docs/FRAME.md). The original README is in
[docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).

## Credits and licence

- **[MagicPods](https://magicpods.app)** by [Aleksandr Maslov](https://github.com/steam3d)
  and [Andrey Litvintsev](https://github.com/andreylitvintsev):
  [MagicPodsCore](https://github.com/steam3d/MagicPodsCore) (forked here),
  [MagicPods for Linux](https://github.com/steam3d/MagicPodsLinux) (forked for the menu)
  and [MagicPods for Decky](https://github.com/steam3d/MagicPodsDecky) (the menu's
  design, behaviour and noise-mode icons follow it). If MagicPods is useful to you,
  consider [supporting the original project](https://magicpods.app/donate/).
- This fork: GPL-3.0, like the original (see [LICENSE](LICENSE)). It includes parts of
  FFmpeg (LGPL-2.1); each release comes with the full source.
