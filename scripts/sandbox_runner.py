"""Start one uploaded service using a private configuration file."""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parent
os.chdir(root)
config = json.loads((root / "runtime.json").read_text())
os.environ.update(config["env"])
(root / "service.pid").write_text(str(os.getpid()))
deadline = time.monotonic() + int(config.get("run_hours", 12)) * 3600
child = None
stopping = False


def stop(*_):
    global stopping
    stopping = True
    if child and child.poll() is None:
        child.terminate()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while not stopping and time.monotonic() < deadline:
        with (root / "service.log").open("ab") as log:
            child = subprocess.Popen(config["command"], stdout=log, stderr=log)
            while child.poll() is None and not stopping and time.monotonic() < deadline:
                time.sleep(1)
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        if not stopping and time.monotonic() < deadline:
            time.sleep(3)
finally:
    (root / "service.pid").unlink(missing_ok=True)
