from __future__ import annotations

from offline_tool import OfflineTool, build

# Build step for Netlog (oe1ebg/tools/netlog/): precache.js and
# build-info.js. No single-file bundle (a file:// version is a follow-up);
# the callsign list it loads is precached (`just fetch-callsigns`). What the files are and how they are made:
# scripts/offline_tool.py.

NETLOG = OfflineTool(name="netlog", bundle=None, prefix="NETLOG", recipe="build-netlog")


if __name__ == "__main__":
    build(NETLOG)
