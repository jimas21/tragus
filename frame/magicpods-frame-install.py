#!/usr/bin/env python3
"""Install, update or remove Tragus on a Steam Frame, for the current user. No root.

Downloads the Tragus core service and menu from the latest release of
  https://github.com/jimas21/tragus
checks each one's ed25519 signature against the public key pinned below, unpacks it
safely and runs its own install.sh. Your headphone settings are never overwritten.

Usually started by Install-Tragus.desktop (Desktop Mode), or by hand:
  python3 magicpods-frame-install.py              install or update both
  python3 magicpods-frame-install.py --uninstall  remove both (settings kept)
  python3 magicpods-frame-install.py --uninstall --purge   also delete the settings
The Tragus menu runs the copy kept in ~/.local/share/magicpodscore/ with --if-newer
--status-file for its "Check for updates" button and automatic updates.

Python standard library only. Licence: GPL-3.0, like MagicPodsCore.
"""

import argparse
import http.client
import base64
import hashlib
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

# The .desktop launchers replace the excepthook so a failed download prints one plain line.
# Once this file is running, errors are this file's own: show them normally.
sys.excepthook = sys.__excepthook__

USER_AGENT = "magicpods-frame-install"
MAX_DOWNLOAD = 64 * 1024 * 1024

REPO = "jimas21/tragus"
PUBKEY = "GOT1qW3jXgAMmr3pyoQece9CnIIrNlgiZysjnNC/Hdk="

COMPONENTS = [
    {
        "key": "core",
        "name": "Tragus core",
        "repo": REPO,
        "asset": "magicpodscore-linux-arm64.tar.gz",
        "top": "magicpodscore-linux-arm64",
        "pubkey": PUBKEY,
        "uninstall": "~/.local/share/magicpodscore/uninstall.sh",
    },
    {
        "key": "menu",
        "name": "Tragus menu",
        "repo": REPO,
        "asset": "magicpods-frame-menu.tar.gz",
        "top": "magicpods-frame-menu",
        "pubkey": PUBKEY,
        "uninstall": "~/.local/share/magicpods-app/frame/uninstall.sh",
    },
]

# --- ed25519 signature check -------------------------------------------------------
# Uses the `cryptography` package when it is installed; otherwise the reference
# verification from RFC 8032, section 6 (pure Python; slow, but it checks one
# signature per download).

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _recover_x(y, sign):
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _SQRT_M1 % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


_GY = 4 * pow(5, _P - 2, _P) % _P
_GX = _recover_x(_GY, 0)
_G = (_GX, _GY, 1, _GX * _GY % _P)


def _add(a, b):
    p1 = (a[1] - a[0]) * (b[1] - b[0]) % _P
    p2 = (a[1] + a[0]) * (b[1] + b[0]) % _P
    p3 = 2 * a[3] * b[3] * _D % _P
    p4 = 2 * a[2] * b[2] % _P
    e, f, g, h = p2 - p1, p4 - p3, p4 + p3, p2 + p1
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _mul(s, pt):
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            q = _add(q, pt)
        pt = _add(pt, pt)
        s >>= 1
    return q


def _equal(a, b):
    return (a[0] * b[2] - b[0] * a[2]) % _P == 0 and (a[1] * b[2] - b[1] * a[2]) % _P == 0


def _decompress(s):
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _P)


def _verify_pure(pub, msg, sig):
    if len(pub) != 32 or len(sig) != 64:
        return False
    a = _decompress(pub)
    r = _decompress(sig[:32])
    if a is None or r is None:
        return False
    s = int.from_bytes(sig[32:], "little")
    if s >= _L:
        return False
    h = int.from_bytes(hashlib.sha512(sig[:32] + pub + msg).digest(), "little") % _L
    return _equal(_mul(s, _G), _add(r, _mul(h, a)))


def verify_signature(pub, msg, sig, force_pure=False):
    """True when sig is a valid ed25519 signature of msg by the raw 32-byte key pub."""
    if not force_pure:
        try:
            from cryptography.exceptions import InvalidSignature
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        except ImportError:
            pass
        else:
            if len(pub) != 32 or len(sig) != 64:
                return False
            try:
                Ed25519PublicKey.from_public_bytes(pub).verify(sig, msg)
                return True
            except (InvalidSignature, ValueError):
                return False
    return _verify_pure(pub, msg, sig)


# --- download, check, unpack ---------------------------------------------------------


class InstallError(Exception):
    pass


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            expected = resp.headers.get("Content-Length")
            data = resp.read(MAX_DOWNLOAD + 1)
    except (OSError, http.client.HTTPException) as e:
        raise InstallError(f"could not download {url}: {e}; check the connection and try again") from None
    if len(data) > MAX_DOWNLOAD:
        raise InstallError(f"{url} is larger than expected; not using it")
    if expected is not None and expected.isdigit() and int(expected) != len(data):
        raise InstallError(f"the download of {url} was cut short; check the connection and try again")
    return data


def check_signature(component, data, sig_text):
    try:
        sig = base64.b64decode(sig_text.strip(), validate=True)
    except (ValueError, TypeError):
        raise InstallError(f"{component['asset']}.sig is not valid base64") from None
    pub = base64.b64decode(component["pubkey"])
    if not verify_signature(pub, data, sig):
        raise InstallError(
            f"the signature of {component['asset']} does not match the pinned key; "
            "the download was not used"
        )


def safe_extract(archive_path, dest, top):
    """Unpack only regular files and folders under top/; refuse anything else."""
    with tarfile.open(archive_path, "r:gz") as tar:
        members = tar.getmembers()
        if not members:
            raise InstallError("the release archive is empty")
        for m in members:
            name = m.name
            parts = name.split("/")
            if (
                name.startswith("/")
                or "\\" in name
                or ".." in parts
                or parts[0] != top
                or not (m.isfile() or m.isdir())
            ):
                raise InstallError(f"unexpected entry in the release archive: {name!r}")
        for m in members:
            target = os.path.join(dest, *m.name.split("/"))
            if m.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = tar.extractfile(m)
            with open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            os.chmod(target, 0o755 if m.mode & 0o111 else 0o644)
    root = os.path.join(dest, top)
    if not os.path.isfile(os.path.join(root, "install.sh")):
        raise InstallError(f"install.sh is missing from {top}")
    return root


VERSIONS_FILE = os.path.expanduser("~/.local/share/magicpods-app/versions.json")
_TAG_OK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_")


def latest_tag(component):
    """The tag of the repository's latest release (GitHub redirects /releases/latest
    to /releases/tag/<tag>)."""
    url = f"https://github.com/{component['repo']}/releases/latest"
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            final = resp.geturl()
    except (OSError, http.client.HTTPException) as e:
        raise InstallError(f"could not check {url}: {e}; check the connection and try again") from None
    marker = "/releases/tag/"
    tag = final.split(marker, 1)[1] if marker in final else ""
    if not tag or len(tag) > 64 or not set(tag) <= _TAG_OK:
        raise InstallError(f"could not find the latest release of {component['repo']}")
    return tag


def read_versions():
    try:
        with open(VERSIONS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_versions(versions):
    os.makedirs(os.path.dirname(VERSIONS_FILE), exist_ok=True)
    tmp = VERSIONS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(versions, f, indent=1, sort_keys=True)
    os.replace(tmp, VERSIONS_FILE)


class Status:
    """Progress for the MagicPods menu (its helper reads the file): a JSON object with
    state (checking, updating, uptodate, updated, failed), message and time."""

    def __init__(self, path):
        self.path = path

    def set(self, state, message):
        if not self.path:
            return
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"state": state, "message": message, "time": int(time.time())}, f)
            os.replace(tmp, self.path)
        except OSError:
            pass


def download_component(component, workdir, tag):
    base = f"https://github.com/{component['repo']}/releases/download/{tag}/{component['asset']}"
    print(f"Downloading {component['name']} {tag} ...", flush=True)
    data = fetch(base)
    sig_text = fetch(base + ".sig").decode("ascii", "replace")
    check_signature(component, data, sig_text)
    print(f"  signature OK ({len(data):,} bytes, sha256 {hashlib.sha256(data).hexdigest()[:16]}...)")
    archive = os.path.join(workdir, component["asset"])
    with open(archive, "wb") as f:
        f.write(data)
    return safe_extract(archive, workdir, component["top"])


def clean_env():
    env = dict(os.environ)
    for k in ("LD_LIBRARY_PATH", "LD_PRELOAD"):
        env.pop(k, None)
    return env


def version_key(tag):
    """Numbers in a tag, for ordering: 2.0.12-frame.7 -> (2, 0, 12, 7); frame-menu-3 -> (3,)."""
    out, num = [], ""
    for ch in tag + " ":
        if ch.isdigit():
            num += ch
        elif num:
            out.append(int(num))
            num = ""
    return tuple(out)


LOCK_FILE = os.path.join(
    os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "magicpods", "install.lock")


def take_lock():
    """One install at a time (the button and the menu's updater use the same script)."""
    try:
        import fcntl
    except ImportError:  # not Linux (tests, --download-only on a PC)
        return None
    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True)
    f = open(LOCK_FILE, "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        raise InstallError("another Tragus install or update is running; try again in a minute") from None
    return f


def install(args, status):
    if platform.machine() not in ("aarch64", "arm64") and not args.download_only:
        raise InstallError(
            f"this is for the Steam Frame (ARM64); this computer is {platform.machine()}"
        )
    if not args.download_only and shutil.which("systemctl") is None:
        raise InstallError("systemctl was not found; this installer needs SteamOS")
    lock = None if args.download_only else take_lock()
    status.set("checking", "Checking for updates...")
    tag = latest_tag(COMPONENTS[0])  # one release holds both parts
    tags = {c["key"]: tag for c in COMPONENTS}
    installed = read_versions()
    todo = COMPONENTS
    if args.if_newer:
        # Only what changed, and never an older release than the one installed.
        todo = [c for c in COMPONENTS
                if installed.get(c["key"]) != tags[c["key"]]
                and version_key(tags[c["key"]]) > version_key(installed.get(c["key"]) or "")]
        if not todo:
            print("Tragus is up to date.")
            status.set("uptodate", "Up to date")
            return
    parent = args.download_only or None
    if parent:
        os.makedirs(parent, exist_ok=True)
    status.set("updating", "Updating...")
    with tempfile.TemporaryDirectory(prefix="magicpods-install-", dir=parent) as work:
        roots = [download_component(c, work, tags[c["key"]]) for c in todo]
        if args.download_only:
            for c, root in zip(todo, roots):
                keep = os.path.join(args.download_only, c["top"])
                shutil.rmtree(keep, ignore_errors=True)
                shutil.move(root, keep)
                print(f"  unpacked to {keep}")
            return
        for c, root in zip(todo, roots):
            print(f"Installing {c['name']} ...", flush=True)
            r = subprocess.run(["sh", os.path.join(root, "install.sh")], env=clean_env())
            if r.returncode != 0:
                raise InstallError(f"{c['name']} did not install (install.sh exited {r.returncode})")
            installed[c["key"]] = tags[c["key"]]
            write_versions(installed)
    status.set("updated", f"Updated to {tag}")
    if lock:
        lock.close()
    print()
    print("\n".join(finish_message(restart_needed=not steam_menu_hook_on())))


# Steam's local DevTools endpoint. The menu is added to Steam's pages through it, and Steam
# only opens it when it starts with the marker file menu/install.sh creates. So: endpoint up
# = the menu shows now; endpoint down = Steam needs one restart (first install only).
STEAM_DEVTOOLS = "http://127.0.0.1:8080/json/list"


def steam_menu_hook_on(url=STEAM_DEVTOOLS):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=3) as r:
            return r.status == 200
    except (OSError, http.client.HTTPException):
        return False


def finish_message(restart_needed):
    if restart_needed:
        lines = ["=" * 58,
                 "  Almost done: restart the headset to finish installing.",
                 "=" * 58,
                 "After the restart, your earbuds' battery shows in the bar at the",
                 "bottom, and Tragus has its own tab in the quick menu."]
    else:
        lines = ["Tragus is installed and running. No restart needed.",
                 "Your earbuds' battery shows in the bar at the bottom, and Tragus",
                 "has its own tab in the quick menu."]
    return lines + ["",
                    "Pair your headphones in Steam Settings > Bluetooth if you have not yet.",
                    "Tragus keeps itself up to date (Tragus tab > Settings > Updates)."]


def uninstall(args):
    for c in reversed(COMPONENTS):
        script = os.path.expanduser(c["uninstall"])
        if not os.path.isfile(script):
            print(f"{c['name']} is not installed.")
            if args.purge and c["name"] == "MagicPodsCore":
                conf = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "magicpods")
                if os.path.isdir(conf):
                    shutil.rmtree(conf)
                    print("Tragus settings deleted.")
            continue
        cmd = ["sh", script]
        if args.purge and c["name"] == "MagicPodsCore":
            cmd.append("--purge")
        r = subprocess.run(cmd, env=clean_env())
        if r.returncode != 0:
            raise InstallError(f"removing {c['name']} failed (exit {r.returncode})")
    print("Done.")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Install, update or remove Tragus on a Steam Frame.")
    ap.add_argument("--uninstall", action="store_true", help="remove Tragus")
    ap.add_argument("--purge", action="store_true",
                    help="with --uninstall: also delete the settings (they hold the headphones' pairing keys)")
    ap.add_argument("--download-only", metavar="DIR",
                    help="download, check and unpack the releases into DIR without installing")
    ap.add_argument("--if-newer", action="store_true",
                    help="only install when a newer release exists (used by the menu's updater)")
    ap.add_argument("--status-file", metavar="PATH",
                    help="write progress as JSON to PATH (used by the menu's updater)")
    args = ap.parse_args(argv)
    if args.purge and not args.uninstall:
        ap.error("--purge only goes with --uninstall")
    status = Status(None if (args.uninstall or args.download_only) else args.status_file)

    def on_term(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, on_term)
    try:
        if args.uninstall:
            uninstall(args)
        else:
            install(args, status)
    except (InstallError, OSError, tarfile.TarError) as e:
        print(f"\nerror: {e}", file=sys.stderr)
        status.set("failed", f"Update failed: {e}")
        return 1
    except KeyboardInterrupt:
        print("\ncancelled", file=sys.stderr)
        status.set("failed", "Update cancelled")
        return 130
    except Exception as e:  # never leave the menu showing "Updating..."
        print(f"\nerror: {type(e).__name__}: {e}", file=sys.stderr)
        status.set("failed", f"Update failed: {type(e).__name__}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
