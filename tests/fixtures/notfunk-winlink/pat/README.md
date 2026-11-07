# Winlink fixtures recorded with Pat

Made by a real Pat v1.0.0 (`pat http`, isolated sandbox, mycall `OE1XYZ`,
locator `JN88`, no connection) from the form pack in `tools/notfunk/winlink/`,
following Pat's web composer: `forminstance` cookie, input form
`/api/forms?template=OE1 Notfunk/OE1_Notfunk_Meldung.txt`, submit (POST
`/api/form`), GET `/api/form`, POST `/api/mailbox/out` (to, subject, body,
date). Fictitious operation and callsigns only.

Re-recorded for the exercise marker (`exercise: true`: `[ÜBUNG]` subject
prefix, `=== ACHTUNG ÜBUNG ===` as the first body line and around the
Inhalt).

- `W1-007.winlink.json`: the Meldebuch export loaded with „Aus Meldebuch
  laden“ (outgoing Anforderung W1-007, one revision, status history, one
  attempt, Bezug with `ref.source`; the text holds umlauts, `€`, `„“`, `≥`,
  `×`, emoji, `<b>`, `&`, quotes, a multi-line text with an indented
  line and the literal slots `{var nummer}` and `{MsgSender}`).
- `F7KZR3Z7S5VG.b2f`: the message Pat wrote to `out/` (body ISO-8859-1,
  characters outside Latin-1 as `?`; one attachment).
- `RMS_Express_Form_OE1_Notfunk_Meldung_Viewer.xml`: that attachment
  (UTF-8). `meldung` parses to exactly the object in `W1-007.winlink.json`.
- `manual-5MSFGUMHUD7T.b2f`, `manual-RMS_Express_Form_OE1_Notfunk_Meldung_Viewer.xml`:
  a message typed into the form by hand (K-001, Notfall, no `meldung`).
