from __future__ import annotations

import sys
import zipfile
from pathlib import Path

# The Winlink form pack of the Notfunk-Meldebuch (tools/notfunk/winlink/,
# issue #179) as a download for operators: oe1-notfunk-meldung-winlink.zip
# with the folder "OE1 Notfunk/" (template, input form, viewer) to copy into
# the Winlink client's templates/forms folder, and README.txt next to it
# (not inside: Winlink Express would list every .txt there as a template).
# Deterministic: fixed timestamps, sorted entries, fixed permissions.
# Called by scripts/build_site.py; stdlib only.

ROOT_DIR = Path(__file__).resolve().parent.parent
PACK_DIR = ROOT_DIR / "tools" / "notfunk" / "winlink"
ZIP_NAME = "oe1-notfunk-meldung-winlink.zip"
FOLDER = "OE1 Notfunk"
FORM_FILES = ["OE1_Notfunk_Meldung.txt", "OE1_Notfunk_Meldung_Initial.html", "OE1_Notfunk_Meldung_Viewer.html"]
README = "README.txt"
EPOCH = (1980, 1, 1, 0, 0, 0)


def entries() -> list[tuple[str, bytes]]:
    """(name in the zip, bytes), sorted by name."""
    items = [(f"{FOLDER}/{name}", (PACK_DIR / name).read_bytes()) for name in FORM_FILES]
    # Windows editors: CRLF and a BOM, so the umlauts show in Notepad
    text = (PACK_DIR / README).read_text(encoding="utf-8").replace("\r\n", "\n").replace("\n", "\r\n")
    items.append((README, "﻿".encode() + text.encode("utf-8")))
    return sorted(items)


def build_zip(out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        dir_info = zipfile.ZipInfo(f"{FOLDER}/", EPOCH)
        dir_info.external_attr = (0o40755 << 16) | 0x10
        dir_info.create_system = 3
        z.writestr(dir_info, b"")
        for name, data in entries():
            info = zipfile.ZipInfo(name, EPOCH)
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            z.writestr(info, data)


if __name__ == "__main__":
    build_zip(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT_DIR / "build" / ZIP_NAME)
