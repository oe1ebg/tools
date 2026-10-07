from __future__ import annotations

from offline_tool import OfflineTool, build

# Build step for the offline confirmation log (oe1ebg/tools/confirm/):
# confirm-offline.html, precache.js and build-info.js. What they are and how
# they are made: scripts/offline_tool.py.

CONFIRM = OfflineTool(name="confirm", bundle="confirm-offline.html", prefix="CONFIRM", recipe="build-confirm")


if __name__ == "__main__":
    build(CONFIRM)
