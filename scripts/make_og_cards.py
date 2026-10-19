"""Open Graph / Twitter cards (1200x630 PNG) for each tool: tools/<tool>/og-card.png.

Static, committed output (like the icons); run `just og-cards` after changing a
title, tagline or icon here, then commit the PNGs. Needs `rsvg-convert`
(librsvg). Icons are read from tools/<tool>/icon.svg; the ADIF editor and the
SOTA Alerts Map have none, so a glyph is drawn here.
"""
from __future__ import annotations

import html
import re
import shutil
import subprocess
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"

# tool -> (title, tagline lines, badge text)
CARDS = {
    "confirm": ("Bestätigungsverkehr", ["Offline-Logbuch für Bestätigungs-", "und Check-in-Runden"], "funktioniert offline"),
    "notfunk": ("Notfunk-Meldebuch", ["Offline-Meldebuch für den Notfunk", "mit Ausdruck und Karte"], "funktioniert offline"),
    "netlog": ("Netlog", ["Notizen für Funkrunden:", "Stationen, Live-Notizen, Rundenleitung"], "funktioniert offline"),
    "adif": ("ADIF-Editor", ["ADIF-Logs (.adi) ansehen,", "prüfen und bearbeiten"], "im Browser, ohne Upload"),
    "sota-alerts": ("SOTA Alerts Map", ["SOTA alerts on a map", "inoffiziell, braucht Internet"], "online only"),
}

GLYPHS = {
    "adif": '<g fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">'
            '<path d="M170 170l-70 86 70 86M342 170l70 86-70 86M290 150l-68 212"/></g>',
    "sota-alerts": '<g fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">'
                   '<path d="M72 400l120-200 70 110 50-70 128 160z"/><path d="M360 120a60 60 0 0 1 40 40" opacity=".7"/></g>',
}


def icon_inner(tool: str) -> str:
    """The icon's shapes (without its rounded square), drawn on a 512 box."""
    if tool in GLYPHS:
        return GLYPHS[tool]
    svg = (TOOLS_DIR / tool / "icon.svg").read_text(encoding="utf-8")
    inner = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)
    return re.sub(r"<rect[^>]*/>", "", inner)


def card(tool: str) -> str:
    title, lines, badge = CARDS[tool]
    tag = "".join(
        f'<text x="80" y="{380 + i * 52}" font-size="40" fill="#dfe5ff">{html.escape(t)}</text>'
        for i, t in enumerate(lines))
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"
  font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#3b4fd6"/><stop offset="1" stop-color="#1c2670"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <g transform="translate(920 50) scale(.45)"><rect width="512" height="512" rx="96" fill="#526cfe"/>
    <rect width="512" height="512" rx="96" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="6"/>{icon_inner(tool)}</g>
  <text x="80" y="140" font-size="30" font-weight="700" letter-spacing="3" fill="#aab6ff">OE1EBG · TOOLS</text>
  <text x="80" y="290" font-size="84" font-weight="700" fill="#fff">{html.escape(title)}</text>
  {tag}
  <rect x="80" y="520" rx="26" width="{40 + 17 * len(badge)}" height="52" fill="#fff" fill-opacity=".16"/>
  <text x="100" y="556" font-size="28" fill="#fff">{html.escape(badge)}</text>
</svg>
"""


def main() -> None:
    if not shutil.which("rsvg-convert"):
        raise SystemExit("error: rsvg-convert (librsvg) not found; brew install librsvg")
    for tool in CARDS:
        out = TOOLS_DIR / tool / "og-card.png"
        subprocess.run(["rsvg-convert", "-w", "1200", "-h", "630", "-o", str(out)],
                       input=card(tool).encode(), check=True)
        print(f"wrote {out.relative_to(TOOLS_DIR.parent)}")


if __name__ == "__main__":
    main()
