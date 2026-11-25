# Runs argv under a new pseudo-terminal, as bb's terminal runs a command's wrapper, and copies what it
# prints to stdout until it exits or the terminal closes. The child's pid goes to stderr first, so a test
# can signal it. Used by app/bb-command.test.ts; `pty.spawn` is no good here, as on macOS it waits on its
# own stdin after the child exits.
import os
import select
import sys

pid, fd = os.forkpty()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
sys.stderr.write(f"{pid}\n")
sys.stderr.flush()
status = None
while True:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if data:
            sys.stdout.buffer.write(data)
            sys.stdout.flush()
        elif status is not None:
            break
        else:
            # The terminal closed (everything holding it is gone) before the child was reaped.
            _, status = os.waitpid(pid, 0)
            break
    if status is None:
        done, raw = os.waitpid(pid, os.WNOHANG)
        if done:
            status = raw
    elif not ready:
        break
