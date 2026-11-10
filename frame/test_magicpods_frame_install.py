"""Offline tests for magicpods-frame-install.py: python3 -m unittest discover -s frame -p 'test_*.py'"""

import importlib.util
import io
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("mpi", os.path.join(_HERE, "magicpods-frame-install.py"))
mpi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mpi)

# RFC 8032, section 7.1, tests 1 and 2.
VECTORS = [
    (
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        "",
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555"
        "fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    ),
    (
        "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
        "72",
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
        "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    ),
]


class SignatureTests(unittest.TestCase):
    def test_rfc8032_vectors_pure(self):
        for pub, msg, sig in VECTORS:
            pub, msg, sig = bytes.fromhex(pub), bytes.fromhex(msg), bytes.fromhex(sig)
            self.assertTrue(mpi.verify_signature(pub, msg, sig, force_pure=True))
            self.assertFalse(mpi.verify_signature(pub, msg + b"x", sig, force_pure=True))
            bad = bytearray(sig)
            bad[5] ^= 1
            self.assertFalse(mpi.verify_signature(pub, msg, bytes(bad), force_pure=True))
            bad = bytearray(sig)
            bad[40] ^= 1
            self.assertFalse(mpi.verify_signature(pub, msg, bytes(bad), force_pure=True))

    def test_rfc8032_vectors_default_path(self):
        for pub, msg, sig in VECTORS:
            pub, msg, sig = bytes.fromhex(pub), bytes.fromhex(msg), bytes.fromhex(sig)
            self.assertTrue(mpi.verify_signature(pub, msg, sig))
            self.assertFalse(mpi.verify_signature(pub, msg + b"x", sig))

    def test_wrong_lengths_and_big_s(self):
        pub, msg, sig = (bytes.fromhex(x) for x in VECTORS[0])
        for force in (True, False):
            self.assertFalse(mpi.verify_signature(pub[:31], msg, sig, force_pure=force))
            self.assertFalse(mpi.verify_signature(pub, msg, sig[:63], force_pure=force))
            big_s = sig[:32] + (mpi._L + int.from_bytes(sig[32:], "little")).to_bytes(32, "little")
            self.assertFalse(mpi.verify_signature(pub, msg, big_s, force_pure=force))

    def test_check_signature_rejects_garbage(self):
        c = mpi.COMPONENTS[0]
        with self.assertRaises(mpi.InstallError):
            mpi.check_signature(c, b"data", "not base64 !!")
        with self.assertRaises(mpi.InstallError):
            mpi.check_signature(c, b"data", "A" * 88)


def _tar(path, entries):
    with tarfile.open(path, "w:gz") as tar:
        for name, kind, data in entries:
            info = tarfile.TarInfo(name)
            if kind == "dir":
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            elif kind == "file":
                info.size = len(data)
                info.mode = 0o755 if name.endswith(".sh") else 0o644
                tar.addfile(info, io.BytesIO(data))
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = data
                tar.addfile(info)
            elif kind == "hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = data
                tar.addfile(info)


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.arc = os.path.join(self.dir, "a.tar.gz")
        self.out = os.path.join(self.dir, "out")
        os.makedirs(self.out)

    def tearDown(self):
        self.tmp.cleanup()

    def test_good_archive(self):
        _tar(self.arc, [("top", "dir", None), ("top/install.sh", "file", b"#!/bin/sh\n"),
                        ("top/lib/x.so", "file", b"elf")])
        root = mpi.safe_extract(self.arc, self.out, "top")
        self.assertTrue(os.path.isfile(os.path.join(root, "install.sh")))
        self.assertTrue(os.path.isfile(os.path.join(root, "lib", "x.so")))

    def test_rejects(self):
        cases = [
            [("top/install.sh", "file", b""), ("../evil", "file", b"")],
            [("top/install.sh", "file", b""), ("/etc/evil", "file", b"")],
            [("top/install.sh", "file", b""), ("top/../../evil", "file", b"")],
            [("top/install.sh", "file", b""), ("other/x", "file", b"")],
            [("top/install.sh", "file", b""), ("top/link", "symlink", "/etc/passwd")],
            [("top/install.sh", "file", b""), ("top/hard", "hardlink", "top/install.sh")],
            [("top/readme", "file", b"")],  # no install.sh
            [],
        ]
        for entries in cases:
            with self.subTest(entries=entries):
                _tar(self.arc, entries)
                with self.assertRaises(mpi.InstallError):
                    mpi.safe_extract(self.arc, self.out, "top")
                self.assertFalse(os.path.exists(os.path.join(self.dir, "evil")))


class VersionTests(unittest.TestCase):
    def test_order(self):
        k = mpi.version_key
        self.assertGreater(k("2.0.12-frame.10"), k("2.0.12-frame.9"))
        self.assertGreater(k("2.0.13-frame.1"), k("2.0.12-frame.9"))
        self.assertGreater(k("frame-menu-4"), k("frame-menu-3"))
        self.assertGreater(k("frame-menu-1"), k(""))
        self.assertLess(k("2.0.12-frame.6"), k("2.0.12-frame.7"))


class CliTests(unittest.TestCase):
    def test_purge_needs_uninstall(self):
        with self.assertRaises(SystemExit):
            mpi.main(["--purge"])


class FinishMessageTests(unittest.TestCase):
    def test_restart_is_the_headline_when_needed(self):
        lines = mpi.finish_message(restart_needed=True)
        self.assertIn("restart the headset to finish installing", lines[1])
        self.assertNotIn("No restart needed", "\n".join(lines))

    def test_no_restart_said_plainly(self):
        text = "\n".join(mpi.finish_message(restart_needed=False))
        self.assertIn("No restart needed", text)
        self.assertNotIn("restart the headset", text)

    def test_hook_check_offline_is_false(self):
        self.assertFalse(mpi.steam_menu_hook_on("http://127.0.0.1:9/json/list"))


def _launcher_code(name):
    """The python3 -c program and trailing arguments from a .desktop launcher's Exec line."""
    with open(os.path.join(_HERE, name), encoding="utf-8") as f:
        line = next(l for l in f.read().splitlines() if l.startswith("Exec="))
    head, code, tail = line.split('"')
    assert head == "Exec=konsole --hold -e python3 -I -c ", head
    return code, tail.split()


class LauncherTests(unittest.TestCase):
    URL = "https://github.com/jimas21/tragus/releases/latest/download/magicpods-frame-install.py"

    def _run(self, name, url, extra=()):
        code, args = _launcher_code(name)
        self.assertIn(self.URL, code)
        code = code.replace(self.URL, url)
        return subprocess.run([sys.executable, "-I", "-c", code, *args, *extra],
                              capture_output=True, text=True, timeout=60)

    def test_offline_prints_plain_message(self):
        for name in ("Install-Tragus.desktop", "Uninstall-Tragus.desktop"):
            with self.subTest(name=name):
                r = self._run(name, "http://127.0.0.1:9/magicpods-frame-install.py")
                self.assertIn("Could not download the Tragus installer", r.stdout)
                self.assertNotIn("Traceback", r.stderr)

    def test_installer_runs_and_restores_errors(self):
        url = pathlib.Path(_HERE, "magicpods-frame-install.py").as_uri()
        r = self._run("Install-Tragus.desktop", url, ["--help"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("--uninstall", r.stdout)
        # Arguments after the -c program reach the installer, and its own errors print normally
        # (a bad flag, so nothing is really uninstalled).
        r = self._run("Uninstall-Tragus.desktop", url, ["--no-such-flag"])
        self.assertEqual(r.returncode, 2)
        self.assertIn("--no-such-flag", r.stderr)
        self.assertNotIn("Could not download", r.stdout)
        self.assertIs(mpi.sys.excepthook, sys.__excepthook__)


if __name__ == "__main__":
    unittest.main()
