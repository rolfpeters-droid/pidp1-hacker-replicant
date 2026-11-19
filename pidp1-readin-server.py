#!/usr/bin/env python3
"""PiDP-1 READ IN + boot-sequence service.

Started out as a simple READ IN button simulator, then grew into full boot
procedures for MACRO and LISP, which this PDP-1 replica can't satisfy with a
plain mount+READ-IN -- see obsolescence.dev/pdp1-lisp-introduction and
obsolescence.dev/pdp1-programming-introduction for the source procedures.

How this works, for every action below: the hardware panel driver
(panel_pidp1) continuously overwrites the shared-memory segment
/tmp/pdp1_panel with the REAL physical switch positions. For a whole boot
sequence (several switch settings + CONTINUE presses in a row) panel_pidp1
is paused (SIGSTOP) for the FULL duration, not per step -- otherwise the
driver wins the race and any value you set disappears again within
~100-200ms.

Routes:
  GET/POST /readin       -> existing, simple READ IN pulse (demos, DDT)
  GET/POST /boot/macro   -> mount macro.rim, all switches to 0, READ IN
  GET/POST /boot/lisp    -> mount lisp.rim, EXTEND on, READ IN, then 2x
                             TW value + CONTINUE, then SS5 + CONTINUE
Listens on :8090. CORS open (the web console runs on :8080).
"""
import mmap
import os
import signal
import socket
import subprocess
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer

PANEL = "/tmp/pdp1_panel"
SW0_OFFSET, SW1_OFFSET, SW2_OFFSET = 0, 4, 8

SW_POWER = 0o200000
SW_EXTEND = 0o400000

KEY_READIN = 0o10
KEY_CONT = 0o100

# Sense switches live in sw2, bits 10-15 (6 switches, octal 00-77).
# Switch n -> bit (6-n) within that 6-bit field (source: PDP-1 instruction
# set documentation, Address 10 = SS1 through Address 60 = SS6).
# SS5 = bit 1 = 0o02.
SS_SHIFT = 10
SS5_ONLY = 0o02 << SS_SHIFT  # = 0o4000 in sw2

TAPE_DIR = "/opt/pidp1/tapes"
PULSE_S = 0.25


def panel_driver_pids():
    try:
        out = subprocess.run(["pgrep", "-x", "panel_pidp1"],
                             capture_output=True, text=True, timeout=5)
        return [int(p) for p in out.stdout.split()]
    except Exception:
        return []


@contextmanager
def panel_paused():
    """Pauses panel_pidp1 for the full duration of the with-block -- needed
    as soon as MULTIPLE switch actions in a row need to stay in place
    (as opposed to a single pulse like the simple READ IN)."""
    pids = panel_driver_pids()
    for pid in pids:
        os.kill(pid, signal.SIGSTOP)
    try:
        yield
    finally:
        for pid in pids:
            os.kill(pid, signal.SIGCONT)


def send_tcp_cmd(cmd, timeout=5):
    """Sends a command to the emulator's command port (:1040), the same
    port the web console uses via pdpsrv.go's 'cmd' messages."""
    s = socket.create_connection(("localhost", 1040), timeout=timeout)
    try:
        s.sendall((cmd + "\n").encode())
        try:
            return s.recv(200).decode(errors="replace").strip()
        except Exception:
            return "(no response)"
    finally:
        s.close()


def _read_panel(mm, offset):
    return int.from_bytes(mm[offset:offset + 4], "little")


def _write_panel(mm, offset, value):
    mm[offset:offset + 4] = (value & 0xFFFFFFFF).to_bytes(4, "little")


def pulse_bit(mm, offset, bit, hold_s=PULSE_S):
    """Sets a bit, holds it briefly, clears it again -- for edge-triggered
    buttons (READ IN, CONTINUE). The panel must already be paused."""
    cur = _read_panel(mm, offset)
    _write_panel(mm, offset, cur | bit)
    time.sleep(hold_s)
    cur = _read_panel(mm, offset)
    _write_panel(mm, offset, cur & ~bit)
    time.sleep(0.05)


def pulse_readin():
    """Existing behavior, unchanged: a single READ IN pulse for demos and
    DDT, which only need a plain mount+READ-IN."""
    with panel_paused():
        with open(PANEL, "r+b") as f:
            mm = mmap.mmap(f.fileno(), 60)
            try:
                pulse_bit(mm, SW2_OFFSET, KEY_READIN)
            finally:
                mm.close()


def boot_macro():
    """MACRO: all switches (TW, Address, Sense Switches) to 0 before
    booting -- they all have a meaning to MACRO once it's running, so
    non-zero leftovers from a previous boot (e.g. sense switch 1 from
    Blinky) produce unpredictable behavior."""
    with panel_paused():
        send_tcp_cmd(f"r {TAPE_DIR}/macro.rim")
        send_tcp_cmd("muldiv on")
        with open(PANEL, "r+b") as f:
            mm = mmap.mmap(f.fileno(), 60)
            try:
                # sw0: power on only, no extend, no address bits
                _write_panel(mm, SW0_OFFSET, SW_POWER)
                # sw1 (TW): all zero
                _write_panel(mm, SW1_OFFSET, 0)
                # sw2: sense switches zero, otherwise clean (READ IN follows)
                _write_panel(mm, SW2_OFFSET, 0)
                time.sleep(0.1)
                pulse_bit(mm, SW2_OFFSET, KEY_READIN)
            finally:
                mm.close()


def boot_lisp():
    """LISP: full procedure from obsolescence.dev/pdp1-lisp-introduction.
       1. EXTEND on
       2. mount lisp.rim + READ IN
       3. TW=7750 (LISP storage upper bound), CONTINUE
       4. TW=400 (push-down list length), CONTINUE
       5. Sense Switch 5 on (typewriter input), CONTINUE

    The sleep durations are educated guesses (the panel is paused the whole
    time, so there's no more race with the driver) -- first tested against
    a debug build of the simulator."""
    with panel_paused():
        send_tcp_cmd(f"r {TAPE_DIR}/lisp.rim")
        send_tcp_cmd("muldiv on")
        with open(PANEL, "r+b") as f:
            mm = mmap.mmap(f.fileno(), 60)
            try:
                # steps 1+2: extend on, otherwise clean, then READ IN
                _write_panel(mm, SW0_OFFSET, SW_POWER | SW_EXTEND)
                _write_panel(mm, SW1_OFFSET, 0)
                _write_panel(mm, SW2_OFFSET, 0)
                time.sleep(0.1)
                pulse_bit(mm, SW2_OFFSET, KEY_READIN)
                time.sleep(4.0)  # wait for tape read-in + first halt

                # step 3: TW=7750, CONTINUE
                _write_panel(mm, SW1_OFFSET, 0o7750)
                time.sleep(0.1)
                pulse_bit(mm, SW2_OFFSET, KEY_CONT)
                time.sleep(2.0)

                # step 4: TW=400, CONTINUE
                _write_panel(mm, SW1_OFFSET, 0o400)
                time.sleep(0.1)
                pulse_bit(mm, SW2_OFFSET, KEY_CONT)
                time.sleep(2.0)

                # step 5: Sense Switch 5 on, CONTINUE
                sw2 = _read_panel(mm, SW2_OFFSET)
                _write_panel(mm, SW2_OFFSET, sw2 | SS5_ONLY)
                time.sleep(0.1)
                pulse_bit(mm, SW2_OFFSET, KEY_CONT)
                time.sleep(2.0)
            finally:
                mm.close()


class Handler(BaseHTTPRequestHandler):
    def _respond(self, code, body):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(body.encode())

    def do_GET(self):
        try:
            if self.path == "/readin":
                pulse_readin()
                self._respond(200, "ok")
            elif self.path == "/boot/macro":
                boot_macro()
                self._respond(200, "ok")
            elif self.path == "/boot/lisp":
                boot_lisp()
                self._respond(200, "ok")
            else:
                self._respond(404, "not found")
        except Exception as e:
            self._respond(500, str(e))

    do_POST = do_GET

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
