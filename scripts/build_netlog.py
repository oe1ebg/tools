from __future__ import annotations

from offline_tool import OfflineTool, build

# Build step for Netlog (oe1ebg/tools/netlog/): netlog-offline.html,
# precache.js and build-info.js. The callsign and repeater lists it loads
# are precached and inlined into the bundle (`just fetch-callsigns
# fetch-repeaters`). What the files are and how they are made:
# scripts/offline_tool.py.

NETLOG = OfflineTool(name="netlog", bundle="netlog-offline.html", prefix="NETLOG", recipe="build-netlog")


if __name__ == "__main__":
    build(NETLOG)
