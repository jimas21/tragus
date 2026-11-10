#!/usr/bin/env python3
"""Puts the Tragus menu into Steam's VR UI (ARM64 SteamOS, e.g. Steam Frame).

Every few seconds this lists Steam's UI pages through Steam's local Chrome DevTools
endpoint (127.0.0.1:8080, present because Steam runs with -cef-enable-debugging; the
same mechanism Decky Loader uses) and makes sure the VR bottom bar and the quick-access
popup run the current magicpods-menu.js. The script itself then lives in those pages:
it talks to MagicPodsCore directly and keeps its elements in place.

Only the fixed contents of magicpods-menu.js are ever sent to Steam. Nothing listens
on any port. If a Steam update changes these pages, the menu just does not
appear and this keeps retrying quietly.

Python 3 standard library only. License: GPL-3.0 (part of MagicPods for Linux).
"""

import base64
import ctypes
import hashlib
import json
import os
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

CDP_LIST = "http://127.0.0.1:8080/json/list"
PAGE_MARKS = ("vrOverlayKey=valve.steam.gamepadui.bar",)  # matches the bar and barpopup.* pages
MENU_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "magicpods-menu.js")
POLL_SECONDS = 3       # while something changed recently
IDLE_POLL_SECONDS = 8  # once every page runs the current menu
# Loopback only: never route these requests through a proxy from the environment.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


class CdpPage:
    """One short-lived DevTools connection to a page (minimal RFC 6455 client)."""

    def __init__(self, ws_url, timeout=4.0):
        url = urllib.parse.urlparse(ws_url)
        if url.hostname not in ("127.0.0.1", "localhost") or not url.port:
            raise ValueError("refusing a non-local DevTools URL")
        self.sock = socket.create_connection((url.hostname, url.port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            (f"GET {url.path} HTTP/1.1\r\nHost: {url.hostname}:{url.port}\r\nUpgrade: websocket\r\n"
             f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(1)
            if not chunk or len(head) > 16384:
                raise ConnectionError("DevTools handshake failed")
            head += chunk
        if b" 101 " not in head.split(b"\r\n", 1)[0] + b" ":
            raise ConnectionError("DevTools refused the connection")
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
        if expected not in head:
            raise ConnectionError("DevTools handshake: bad accept key")
        self.buffer = b""
        self.next_id = 1

    def _send(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        header = bytes([0x80 | opcode])
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack("!Q", n)
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _read_message(self, deadline):
        fragments = []
        while True:
            while True:
                frame = self._parse()
                if frame:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("DevTools reply timed out")
                ready, _, _ = select.select([self.sock], [], [], remaining)
                if ready:
                    chunk = self.sock.recv(65536)
                    if not chunk:
                        raise ConnectionError("DevTools connection closed")
                    self.buffer += chunk
            opcode, fin, payload = frame
            if opcode == 0x9:
                self._send(0xA, payload)
            elif opcode == 0x8:
                raise ConnectionError("DevTools connection closed")
            elif opcode in (0x0, 0x1):
                fragments.append(payload)
                if fin:
                    return b"".join(fragments).decode("utf-8", "replace")

    def _parse(self):
        if len(self.buffer) < 2:
            return None
        b0, b1 = self.buffer[0], self.buffer[1]
        n, offset = b1 & 0x7F, 2
        if n == 126:
            if len(self.buffer) < 4:
                return None
            n, offset = struct.unpack("!H", self.buffer[2:4])[0], 4
        elif n == 127:
            if len(self.buffer) < 10:
                return None
            n, offset = struct.unpack("!Q", self.buffer[2:10])[0], 10
        if b1 & 0x80:
            offset += 4
        if len(self.buffer) < offset + n:
            return None
        payload = self.buffer[offset:offset + n]
        self.buffer = self.buffer[offset + n:]
        return b0 & 0x0F, b0 & 0x80, payload

    def evaluate(self, expression, timeout=5.0):
        msg_id = self.next_id
        self.next_id += 1
        self._send(0x1, json.dumps({"id": msg_id, "method": "Runtime.evaluate",
                                    "params": {"expression": expression, "returnByValue": True}}).encode())
        deadline = time.monotonic() + timeout
        while True:
            msg = json.loads(self._read_message(deadline))
            if msg.get("id") == msg_id:
                result = msg.get("result", {})
                if "exceptionDetails" in result:
                    raise RuntimeError(result["exceptionDetails"].get("text", "script error"))
                return result.get("result", {}).get("value")

    def close(self):
        try:
            self._send(0x8, b"")
        except OSError:
            pass
        self.sock.close()


CORE_URL = "ws://127.0.0.1:2020/"
FRAME_SETTINGS = "magicpodsframe"  # MagicPodsCore settings container used by the menu
STANDBY_KEY = "standby_fix"
LOW_BATTERY_KEY = "low_battery"  # percent; 0 turns the notification off
LOW_BATTERY_DEFAULT = 30          # same default as the MagicPods Decky plugin
VRCMD = "/opt/steamvr/bin/linuxarm64/vrcmd"

# Updates ("Check for updates" and "Update automatically" in the menu's Settings).
# The update itself is the signed installer MagicPodsCore keeps beside its binary; it
# runs in its own transient user unit, because it restarts this service.
AUTO_UPDATE_KEY = "auto_update"        # bool, default on
UPDATE_REQUEST_KEY = "update_request"  # int, Unix time of the menu's "Check for updates" press
UPDATE_STATUS_KEY = "update_status"    # JSON text written here, shown by the menu
UPDATER = os.path.expanduser("~/.local/share/magicpodscore/magicpods-frame-install.py")
UPDATE_STATUS_FILE = os.path.join(
    os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "magicpods", "update.json")
UPDATE_UNIT = "magicpods-update"
AUTO_UPDATE_FIRST = 10 * 60      # first automatic check, seconds after start
AUTO_UPDATE_EVERY = 6 * 60 * 60  # then this often
PART_NAMES = {"single": "", "left": "Left earbud", "right": "right earbud", "case": "Charging case"}


def low_battery_message(parts):
    """parts: list of (key, percent). Names each part, e.g.
    'MagicPods: Left earbud 18%, right earbud 20% remaining. Charge your headphones.'"""
    buds = [(k, p) for k, p in parts if k != "case"]
    case = [p for k, p in parts if k == "case"]
    if not buds:
        return f"Tragus: Charging case {case[0]}% remaining. Charge the case."
    items = []
    for k, p in buds:
        name = PART_NAMES[k]
        items.append(f"{name} {p}%" if name else f"{p}%")
    if case:
        items.append(f"charging case {case[0]}%")
    text = ", ".join(items)
    return f"Tragus: {text[0].upper()}{text[1:]} remaining. Charge your headphones."


class StandbyFix(threading.Thread):
    """"Disable headphone standby mode": while enabled and the active headphones'
    A2DP output exists, stream digital silence to it so the Bluetooth link never goes
    idle (idle A2DP links make some AirPods drop and reconnect in a loop). Same idea
    as the MagicPods Decky plugin, which loops a silent file through ffplay.

    The stream is pinned to the headphones' sink (node.dont-reconnect), so
    MagicPodsCore's "switch to speakers" cannot move it to the speakers.
    """

    def __init__(self, stopping):
        super().__init__(name="standby-fix", daemon=True)
        self.stopping = stopping
        self.enabled = False
        self.address = None
        self.proc = None
        self.proc_sink = None
        self.backoff = 1.0
        self.next_start = 0.0
        self.started_at = 0.0
        self.sink = None
        self.next_sink_check = 0.0
        self.player = shutil.which("pw-cat")
        self.low_threshold = LOW_BATTERY_DEFAULT
        self.last_info = {}
        self.low_armed = {k: True for k in PART_NAMES}
        self.last_notify = 0.0
        self.auto_update = True
        self.update_request = None   # last value seen
        self.started_wall = time.time()  # presses from before this start are old news
        self.status_sent = None      # last update status text sent to the core
        self.next_auto_update = time.monotonic() + AUTO_UPDATE_FIRST
        self.next_stale_check = 0.0

    def run(self):
        if not self.player:
            log("standby fix unavailable: pw-cat not found")
        while not self.stopping["flag"]:
            try:
                self.session()
            except Exception as error:  # core restarting, socket errors
                log("standby fix: core connection:", f"{type(error).__name__}: {error}")
            self.address = None
            self.reconcile()
            self.wait(5)
        self.stop_player()

    def wait(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end and not self.stopping["flag"]:
            time.sleep(0.2)

    def session(self):
        ws = CdpPage(CORE_URL)
        try:
            ready = False
            while not self.stopping["flag"]:
                try:
                    raw = ws._read_message(time.monotonic() + 1.0)
                except TimeoutError:
                    self.reconcile()
                    if ready:
                        self.tick_update(ws)
                    continue
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if "init" in msg and not ready:
                    ready = True
                    for request in (
                        {"method": "GetActiveDeviceInfo"},
                        {"method": "GetSetting", "arguments": {"container": FRAME_SETTINGS, "setting": STANDBY_KEY}},
                        {"method": "GetSetting", "arguments": {"container": FRAME_SETTINGS, "setting": LOW_BATTERY_KEY}},
                        {"method": "GetSetting", "arguments": {"container": FRAME_SETTINGS, "setting": AUTO_UPDATE_KEY}},
                        {"method": "GetSetting", "arguments": {"container": FRAME_SETTINGS, "setting": UPDATE_REQUEST_KEY}},
                    ):
                        ws._send(0x1, json.dumps(request).encode())
                    continue
                if not ready:
                    continue
                if "info" in msg:
                    info = msg.get("info") or {}
                    self.address = info.get("address") if isinstance(info, dict) and info.get("connected", True) else None
                    self.last_info = info if isinstance(info, dict) else {}
                    self.check_low_battery(self.last_info)
                settings = msg.get("settings")
                if isinstance(settings, dict) and isinstance(settings.get(FRAME_SETTINGS), dict):
                    level = settings[FRAME_SETTINGS].get(LOW_BATTERY_KEY)
                    if isinstance(level, int) and not isinstance(level, bool) and 0 <= level <= 100 and level != self.low_threshold:
                        self.low_threshold = level
                        self.check_low_battery(self.last_info)  # the setting can arrive after the device info
                    value = settings[FRAME_SETTINGS].get(STANDBY_KEY)
                    if isinstance(value, bool) and value != self.enabled:
                        self.enabled = value
                        log("standby fix", "enabled" if value else "disabled")
                    auto = settings[FRAME_SETTINGS].get(AUTO_UPDATE_KEY)
                    if isinstance(auto, bool) and auto != self.auto_update:
                        self.auto_update = auto
                        log("automatic updates", "on" if auto else "off")
                    request = settings[FRAME_SETTINGS].get(UPDATE_REQUEST_KEY)
                    if isinstance(request, int) and not isinstance(request, bool) and request != self.update_request:
                        self.update_request = request
                        if request > self.started_wall - 5:
                            log("update check requested from the menu")
                            self.start_update()
                self.reconcile()
                self.tick_update(ws)
        finally:
            ws.close()

    def tick_update(self, ws):
        """Run the automatic check when due, and pass the updater's progress on to the
        menu (through the core, so every Steam page sees it)."""
        if self.auto_update and time.monotonic() >= self.next_auto_update:
            self.next_auto_update = time.monotonic() + AUTO_UPDATE_EVERY
            log("automatic update check")
            self.start_update()
        try:
            with open(UPDATE_STATUS_FILE, encoding="utf-8") as f:
                text = f.read(4096)
            st = json.loads(text)
        except (OSError, ValueError):
            return
        if (isinstance(st, dict) and st.get("state") in ("checking", "updating")
                and isinstance(st.get("time"), int) and time.time() - st["time"] > 60
                and time.monotonic() >= self.next_stale_check):
            self.next_stale_check = time.monotonic() + 30
            if not self.update_running():
                self.write_update_status("failed", "The last update check did not finish. Try again.")
                return  # sent on the next tick
        if text != self.status_sent:
            ws._send(0x1, json.dumps({"method": "SetSetting", "arguments": {
                "container": FRAME_SETTINGS, "setting": UPDATE_STATUS_KEY, "value": text}}).encode())
            self.status_sent = text

    def write_update_status(self, state, message):
        try:
            os.makedirs(os.path.dirname(UPDATE_STATUS_FILE), exist_ok=True)
            tmp = UPDATE_STATUS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"state": state, "message": message, "time": int(time.time())}, f)
            os.replace(tmp, UPDATE_STATUS_FILE)
        except OSError as error:
            log("update status:", error)

    def update_running(self):
        try:
            state = subprocess.run(["systemctl", "--user", "is-active", UPDATE_UNIT],
                                   capture_output=True, text=True, timeout=10).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return False
        return state in ("active", "activating", "deactivating")

    def start_update(self):
        """Start the signed installer with --if-newer in its own user unit (it restarts
        this service, which would otherwise end it halfway)."""
        if not os.path.isfile(UPDATER):
            self.write_update_status("failed", "Updates need a newer Tragus: install it once more from the install button.")
            return
        if self.update_running():
            log("an update is already running")
            return
        python = shutil.which("python3") or "/usr/bin/python3"
        self.write_update_status("checking", "Checking for updates...")
        try:
            subprocess.run(["systemctl", "--user", "reset-failed", UPDATE_UNIT],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            r = subprocess.run(
                ["systemd-run", "--user", "--quiet", "--collect", f"--unit={UPDATE_UNIT}",
                 "--property=UnsetEnvironment=LD_LIBRARY_PATH LD_PRELOAD",
                 python, "-I", UPDATER, "--if-newer", "--status-file", UPDATE_STATUS_FILE],
                capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError) as error:
            self.write_update_status("failed", f"Update failed: {error}")
            return
        if r.returncode != 0:
            self.write_update_status("failed", "Update failed: " + (r.stderr.strip() or f"systemd-run exited {r.returncode}")[:200])

    def check_low_battery(self, info):
        """Once per connection per part, like the Decky plugin (which only says the
        lowest percent): a part at or below the threshold, connected (status 2), not
        charging and not reporting 0. Re-armed when the headphones disconnect."""
        if not info:
            self.low_armed = {k: True for k in PART_NAMES}
            return
        battery = (info.get("capabilities") or {}).get("battery")
        if not isinstance(battery, dict) or self.low_threshold <= 0:
            return
        due = []
        for key in ("single", "left", "right", "case"):
            cell = battery.get(key)
            if not isinstance(cell, dict) or cell.get("status") != 2 or cell.get("charging"):
                continue
            pct = cell.get("battery")
            if not isinstance(pct, int) or pct == 0:
                continue
            if pct <= self.low_threshold and self.low_armed.get(key):
                due.append((key, pct))
        if not due:
            return
        if self.notify(low_battery_message(due)):  # only mark shown once actually sent
            for key, _ in due:
                self.low_armed[key] = False

    def notify(self, text):
        """Show a SteamVR notification (SteamVR's own vrcmd tool, IVRNotifications)."""
        if not os.path.exists(VRCMD):
            log("low battery:", text, "(vrcmd not found, not shown)")
            return True  # nothing will change; don't retry on every update
        if time.monotonic() - self.last_notify < 30:  # never spam; retried on the next update
            return False
        self.last_notify = time.monotonic()
        log("notify:", text)
        try:
            subprocess.run([VRCMD, "--notify", text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        except (OSError, subprocess.SubprocessError) as error:
            log("notification failed:", error)
        return True

    def find_sink(self):
        """The active headphones' A2DP output, e.g. bluez_output.AA_BB_CC_DD_EE_FF.1."""
        if not self.address:
            return None
        mac = self.address.upper().replace(":", "_")
        try:
            out = subprocess.run(["pactl", "list", "sinks", "short"], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        for line in out.splitlines():
            fields = line.split("\t")
            if len(fields) > 1 and fields[1].startswith(f"bluez_output.{mac}"):
                return fields[1]
        return None

    def reconcile(self):
        now = time.monotonic()
        if self.enabled and self.address:
            if now >= self.next_sink_check or self.sink is None:
                self.sink = self.find_sink()
                self.next_sink_check = now + 5
        else:
            self.sink = None
        want = self.sink if (self.enabled and self.address and self.player) else None
        if self.proc and (self.proc.poll() is not None or self.proc_sink != want):
            exited = self.proc.poll() is not None
            self.stop_player()
            if exited and want:
                self.backoff = 1.0 if now - self.started_at > 60 else min(self.backoff * 2, 30.0)
                self.next_start = now + self.backoff
        if want and not self.proc and now >= self.next_start:
            self.start_player(want)

    def start_player(self, sink):
        def child_setup():  # end the player if this service dies
            try:
                ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
            except Exception:
                pass
        zero = open("/dev/zero", "rb")
        try:
            self.proc = subprocess.Popen(
                [self.player, "--playback", "--raw", "--rate", "48000", "--channels", "2", "--format", "s16",
                 "--target", sink, "--latency", "500ms",
                 "-P", "node.dont-reconnect=true", "-P", "node.dont-fallback=true",
                 "-P", "media.name=Tragus standby fix", "-P", "node.name=magicpods-standby-fix", "-"],
                stdin=zero, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=child_setup)
        finally:
            zero.close()
        self.proc_sink = sink
        self.started_at = time.monotonic()
        log("standby fix: keeping", sink, "awake")

    def stop_player(self):
        if not self.proc:
            return
        proc, self.proc, self.proc_sink = self.proc, None, None
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        log("standby fix: stopped")


def load_menu():
    with open(MENU_FILE, "r", encoding="utf-8") as f:
        source = f.read()
    version = hashlib.sha256(source.encode()).hexdigest()[:12]
    return version, source.replace("__VERSION__", version)


def sync_page(target, version, script):
    page = CdpPage(target["webSocketDebuggerUrl"])
    try:
        current = page.evaluate("window.__magicpodsMenu ? window.__magicpodsMenu.version : null")
        if current == version:
            return None
        return page.evaluate(script)
    finally:
        page.close()


def list_pages():
    with OPENER.open(CDP_LIST, timeout=3) as response:
        targets = json.load(response)
    if not isinstance(targets, list):
        raise ValueError("unexpected DevTools target list")
    # The VR bar and quick-access pages, plus Steam's shared context (notifications).
    return [t for t in targets if isinstance(t, dict) and isinstance(t.get("url"), str)
            and (any(m in t["url"] for m in PAGE_MARKS) or t.get("title") == "SharedJSContext")
            and t.get("webSocketDebuggerUrl")]


def main():
    stopping = {"flag": False}

    def stop(signum, frame):
        stopping["flag"] = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    standby = StandbyFix(stopping)
    standby.start()
    version, script = load_menu()
    log("menu version", version)
    last_status = None
    page_results = {}  # page id -> last result, so each outcome is logged once
    while not stopping["flag"]:
        changed = False
        try:
            pages = list_pages()
            status = f"{len(pages)} Steam VR page(s)"
            for target in pages:
                title = str(target.get("title") or "?")[:60]
                try:
                    result = sync_page(target, version, script)
                except Exception as error:  # one bad page must not stop the others
                    result = f"error: {type(error).__name__}: {error}"
                if result is not None:
                    changed = True
                if result is not None and page_results.get(target.get("id")) != result:
                    log(title, "->", result)
                page_results[target.get("id")] = result
        except Exception as error:  # Steam restarting, endpoint missing, odd replies
            status = f"waiting for Steam's DevTools endpoint ({type(error).__name__}: {error})"
            changed = True
        if status != last_status:
            log(status)
            last_status = status
        delay = POLL_SECONDS if changed else IDLE_POLL_SECONDS
        for _ in range(delay * 10):
            if stopping["flag"]:
                break
            time.sleep(0.1)
    teardown_all()
    standby.join(5)
    log("stopped")
    return 0


def teardown_all():
    """Remove the menu from Steam's pages (also run by uninstall.sh via --teardown)."""
    try:
        pages = list_pages()
    except Exception:
        return
    for target in pages:
        try:
            page = CdpPage(target["webSocketDebuggerUrl"])
            try:
                page.evaluate("window.__magicpodsMenu && window.__magicpodsMenu.teardown()")
            finally:
                page.close()
        except Exception:
            pass


if __name__ == "__main__":
    if sys.argv[1:] == ["--teardown"]:
        teardown_all()
        sys.exit(0)
    sys.exit(main())
