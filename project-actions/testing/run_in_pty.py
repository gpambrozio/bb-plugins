"""Runs a command in a real pseudo-terminal, as bb's terminal does, for `server/command.test.ts`.

Node has no pty of its own, and an interactive shell behaves differently without one: it turns job
control on only with a terminal, and that is what the wrapper must survive.

Usage: python3 -I run_in_pty.py '<json>' where the JSON is
  {"argv": [...], "env": {...}, "interrupt_after": "<text>" | null}

It starts argv in a new pty (its session leader, with the pty as its controlling terminal), sends
Ctrl+C once `interrupt_after` has been printed, waits for the wrapper's finished marker, checks that
the wrapper is still there waiting for Enter, presses Enter, and prints one JSON line:
  {"output": "...", "finished": bool, "waited_for_enter": bool, "exit_code": int | null}
"""

import json
import os
import pty
import select
import signal
import sys
import time

MARKER = b"\x1b]5253;bb-project-actions;finished\x07"

request = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execve(request["argv"][0], request["argv"], request["env"])

output = b""


def pump(seconds):
    """Reads whatever the terminal prints for this long."""
    global output
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                output += os.read(fd, 4096)
            except OSError:
                return


def pump_until(needle, seconds):
    end = time.time() + seconds
    while needle not in output and time.time() < end:
        pump(0.05)


if request.get("interrupt_after"):
    pump_until(request["interrupt_after"].encode(), 10)
    pump(0.3)  # let the next program start
    os.write(fd, b"\x03")

pump_until(MARKER, 15)
finished = MARKER in output

# A wrapper that lost the terminal cannot read from it: its `read` fails and it exits at once.
pump(0.5)
done, status = os.waitpid(pid, os.WNOHANG)
waited = done == 0
if waited:
    try:
        os.write(fd, b"\n")
    except OSError:
        pass
    end = time.time() + 5
    while time.time() < end:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
        pump(0.05)
    else:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        done = 0

print(json.dumps({
    "output": output.decode(errors="replace"),
    "finished": finished,
    "waited_for_enter": waited,
    "exit_code": os.waitstatus_to_exitcode(status) if done else None,
}))
