from __future__ import annotations

from offline_tool import OfflineTool, build

# Build step for the offline Notfunk-Meldebuch (oe1ebg/tools/notfunk/):
# notfunk-offline.html, precache.js and build-info.js. What they are and how
# they are made: scripts/offline_tool.py.

NOTFUNK = OfflineTool(name="notfunk", bundle="notfunk-offline.html", prefix="NOTFUNK", recipe="build-notfunk")


if __name__ == "__main__":
    build(NOTFUNK)
