# Data sources and licences

Every dataset and third-party library the tools on this site use, grouped by
tool: who publishes it, what is taken from it, under which licence, where it
comes from, how often it is refreshed, and the attribution it requires.

**How refreshes work.** The site is rebuilt as a Docker image whenever
something under `oe1ebg/` changes (there is no scheduled rebuild). Each
build re-fetches the "weekly" datasets if the ISO week has changed since the
last cached build, and the "monthly" ones if the month has changed.
Datasets marked *snapshot* are committed to the repository and only updated
by hand; regular builds never contact their source. Datasets marked *live*
are fetched by your browser while you use the tool.

## Bestätigungsverkehr (confirmation log)

The [confirmation log](confirm/index.html) works fully offline: all of the
following data is built into the tool at build time, and the tool itself
never contacts any of these sources. The tool's footer lists the same
sources with the date of the data it contains.

When online, a resolved location can also be opened in Google Maps or
OpenStreetMap. These are plain links that you click; nothing is fetched
from either service by the tool.

### Austrian callsign list (Rufzeichenliste)

- **Publisher:** Fernmeldebüro (Austrian radio and telecommunications
  authority)
- **Used:** callsign, name and licence location (Standort) of every
  Austrian amateur radio station, about 7,200 OE calls. No street addresses,
  no licence class. Holders who opted out of publication appear as a bare
  callsign.
- **Licence:** official publication under § 150 TKG 2021; the list carries
  no licence statement.
- **Source:** "Rufzeichenliste österreichischer Amateurfunkstellen" (PDF),
  linked from
  [fb.gv.at – Amateurfunkdienst](https://www.fb.gv.at/Funk/amateurfunkdienst.html)
- **Refresh:** weekly build (7-day cache); the authority republishes the
  list roughly monthly.
- **Attribution:** "Rufzeichenliste (Fernmeldebüro), Stand ‹date›"

### ÖVSV repeater database

- **Publisher:** ÖVSV (Österreichischer Versuchssenderverband)
- **Used:** all Austrian voice repeaters (active, planned, inactive; about
  230): callsign, output/input frequency, modes, CTCSS, site name,
  coordinates, locator and altitude.
- **Licence:** no data licence is stated. The database software is
  [Apache-2.0](https://github.com/oevsv/repeater-db/blob/main/LICENSE).
- **Source:** [repeater.oevsv.at](https://repeater.oevsv.at/) (PostgREST API
  `/api/trx` and `/api/site`; code at
  [github.com/oevsv/repeater-db](https://github.com/oevsv/repeater-db))
- **Refresh:** weekly build (7-day cache).
- **Attribution:** "ÖVSV Repeater-Datenbank, Stand ‹date›"

### Stadt Wien – Adressen Standorte Wien

- **Publisher:** Stadt Wien – data.wien.gv.at
- **Used:** about 181,000 Vienna addresses (street, house number, PLZ,
  district, coordinates) for the location lookup.
- **Licence:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.de)
- **Source:** WFS layer `ogdwien:ADRESSENOGD`, catalogue entry on
  [data.gv.at](https://www.data.gv.at/katalog/dataset/1d5c2411-9719-4c8f-b99d-57a5f4a4ae41)
- **Refresh:** monthly build (30-day cache).
- **Attribution:** "Adressdaten: Stadt Wien – data.wien.gv.at, CC BY 4.0"

### Stadt Wien – Bezirksgrenzen

- **Publisher:** Stadt Wien – data.wien.gv.at
- **Used:** the 23 district boundaries, simplified, for the offline map.
- **Licence:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.de)
- **Source:** WFS layer `ogdwien:BEZIRKSGRENZEOGD`, catalogue entry on
  [data.gv.at](https://www.data.gv.at/katalog/dataset/2ee6b8bf-6292-413c-bb8b-bd22dbb2ad4b)
- **Refresh:** monthly build (30-day cache).
- **Attribution:** "Stadt Wien – data.wien.gv.at, Bezirksgrenzen Wien, CC BY 4.0"

### OpenStreetMap: Vienna landmarks and map outlines

- **Publisher:** OpenStreetMap contributors
- **Used:** about 6,500 named landmarks inside Vienna (places, peaks,
  stations, hospitals, parks, …; one point each) for the location lookup,
  and main roads and larger waters (Donau, Neue Donau, Donaukanal,
  Alte Donau, …) for the offline map.
- **Licence:** [ODbL](https://opendatacommons.org/licenses/odbl/)
- **Source:** [OpenStreetMap](https://www.openstreetmap.org/copyright), queried
  via the Overpass API
- **Refresh:** *snapshot* (committed `location-pois.json` and
  `map-osm.json`, current snapshots from October 2026), updated by hand.
- **Attribution:** "© OpenStreetMap-Mitwirkende" (© OpenStreetMap
  contributors), ODbL

### BEV – Österreichisches Adressregister

- **Publisher:** BEV – Bundesamt für Eich- und Vermessungswesen
- **Used:** all ~2.5 million Austrian addresses, aggregated per PLZ and
  political Bezirk into a centre point and the Maidenhead locators the area
  covers (2,232 PLZ, 117 Bezirke). No individual addresses are shipped.
- **Licence:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.de)
- **Source:** "Adresse Relationale Tabellen – Stichtagsdaten",
  [BEV Adressregister](https://www.bev.gv.at/Services/Produkte/Adressregister/Oesterreichisches-Adressregister.html)
- **Refresh:** *snapshot* (committed `austria-areas.json`, Stichtag
  01.04.2026), updated by hand; the BEV republishes the register twice a
  year.
- **Attribution:** "© Österreichisches Adressregister, Stichtagsdatum ‹date›"

### Statistik Austria – Politische Bezirke

- **Publisher:** Statistik Austria
- **Used:** names and codes of the political Bezirke (`polbezirke.csv`).
- **Licence:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.de)
- **Source:** [Statistik Austria – Regionale Gliederungen](https://www.statistik.at/services/tools/regionale-internationale-daten/regionale-daten-und-gliederungen/regionale-gliederungen)
- **Refresh:** *snapshot*, together with the BEV data above.
- **Attribution:** "Bezirke: Statistik Austria, CC BY 4.0"

### Own data

District names, landmarks missing from OpenStreetMap and common shorthand
(e.g. "Steffl", "Hbf", "DI") are maintained in this repository
(`location-aliases.toml`).

## SOTA Alerts Map

The [SOTA Alerts Map](sota-alerts/index.html) is an online tool: alerts, map
tiles and summit searches are loaded live.

### SOTA summit database

- **Publisher:** Summits On The Air (SOTA)
- **Used:** code, name, coordinates, altitude and points of every summit,
  for the "all summits" overlay and to place alerted summits without an API
  call.
- **Licence:** no licence is stated; the data belongs to the SOTA programme.
- **Source:** [storage.sota.org.uk/summitslist.csv](https://storage.sota.org.uk/summitslist.csv)
- **Refresh:** weekly build (7-day cache), matching SOTA's own weekly
  update.
- **Attribution:** "alert & summit data via SOTA (unofficial)"

### SOTA API (alerts, summit lookup and search)

- **Publisher:** Summits On The Air (SOTA)
- **Used:** upcoming activation alerts, details of single summits, and
  summit search by name or code.
- **Licence:** subject to SOTA's API terms of use (no commercial use;
  developers are asked to coordinate with the SOTA Management Team).
- **Source:** `api2.sota.org.uk` (`/api/alerts`, `/api/summits/…`)
- **Refresh:** *live*.
- **Attribution:** "alert & summit data via SOTA (unofficial)"

### Map tiles

You choose one of three base layers; tiles are loaded *live*.

| Layer | Publisher | Licence | Attribution |
|---|---|---|---|
| Outdoor | [OpenTopoMap](https://opentopomap.org/copyright) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) (map), data © OpenStreetMap contributors, SRTM | "Map: © OpenTopoMap (CC-BY-SA)" |
| Streets | [OpenStreetMap](https://www.openstreetmap.org/copyright) | data [ODbL](https://opendatacommons.org/licenses/odbl/), tiles under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) | "© OpenStreetMap contributors" |
| Austria | [basemap.at](https://basemap.at/) (Austrian provinces and partners) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | "Grundkarte: basemap.at" |

### OpenStreetMap SOTA tags (area search)

- **Publisher:** OpenStreetMap contributors
- **Used:** peaks tagged with `communication:amateur_radio:sota` inside the
  visible map area, as a complement to the summit search.
- **Licence:** [ODbL](https://opendatacommons.org/licenses/odbl/)
- **Source:** [Overpass API](https://overpass-api.de/) (`overpass-api.de`)
- **Refresh:** *live*, on request.
- **Attribution:** "© OpenStreetMap contributors"

Summit popups also link to [sotl.as](https://sotl.as/) and
[sotadata.org.uk](https://www.sotadata.org.uk/); these are links only.

## ADIF Editor

The [ADIF Editor](adif/index.html) contains no external datasets. Its field
picker and help texts are derived from the field list of the
[ADIF 3.1.7 specification](https://www.adif.org/317/ADIF_317.htm)
(published by the ADIF Developers Group, freely available).

## Notebooks

The [notebooks](notebooks.md) page includes notebooks fetched from another
repository at build time.

- **Moxon antenna calculator and theory** – from
  [ebirn/Moxon_OE1EBG](https://github.com/ebirn/Moxon_OE1EBG) (OE1EBG),
  licence
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/),
  fetched from the `main` branch at each weekly build (list in
  `external-notebooks.txt`).

## Software libraries

- **Leaflet 1.9.4** – map library, vendored (an identical copy each in the
  confirmation log and the SOTA Alerts Map, with its licence file).
  © 2010–2023 Volodymyr Agafonkin, © 2010–2011 CloudMade.
  [BSD 2-Clause](https://github.com/Leaflet/Leaflet/blob/main/LICENSE),
  [leafletjs.com](https://leafletjs.com/).
- The notebooks run in [JupyterLite](https://jupyterlite.readthedocs.io/)
  (Pyodide kernel); packages such as pandas or matplotlib are installed into
  your browser from the Pyodide package index when a notebook needs them.
