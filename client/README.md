# 🖥️ Watchparty Desktop (Windows)

Der Desktop-Client für die Watchparty. Statt im Browser läuft der Film in **mpv**, in **Originalqualität**, mit **KI-Zwischenbildern (RIFE)** und **RTX Video Super Resolution**. Trotzdem bist du ganz normal im Raum: Play, Pause, Spulen und Filmwechsel sind mit allen synchron, egal ob die anderen im Browser oder im Client schauen. Chat, Reaktionen und Mitgliederliste sind auch da.

Am Relay und am Agent muss dafür **nichts** geändert werden.

## Was der Client kann

Alles, was die Website kann: anmelden oder **per Einladungslink registrieren**, Räume erstellen und beitreten, Chat, Reaktionen, Vorschläge, **Merkliste und Zuletzt geschaut**, die neue **Suche**, **nächste Folge**, die **Serienansicht mit Gesehen-Markern**, **Bewertungen**, **Warteschlange**, **Abstimmung**, **Zufall**, **schwarzes Brett**, **Mein Jahr**, **Intro überspringen**, Host-Funktionen (Steuerung freigeben, Host weitergeben, rauswerfen), Freunde einladen, **Name und Passwort ändern**. Admins öffnen die **Verwaltung** direkt in einem eigenen Fenster und sehen den Client in Rot. Rechte aus den Gruppen gelten genauso wie im Browser.

## Startseite

Nach dem Anmelden landest du auf derselben Startseite wie auf der Website und in der Android-App: großes Titelbild, Reihen (Weiterschauen, Meine Liste, Top 10, Neu in …), Filme/Serien/Meine Liste, Suche und **Freunde**, also wer gerade was schaut, mit „Mitschauen“. **„▶ Abspielen“ startet alleine** in deinem eigenen Raum und öffnet gleich den Player. Freunde kommen per Link oder „Mitschauen“ dazu. Räume anlegen, mit Code beitreten, Einrichtung und Konto findest du unter **👥 Zusammen schauen**.

## Installieren

1. Unter **Releases** die neueste `Watchparty-Setup-x.y.z.exe` herunterladen und starten (oder die `.zip` entpacken).
2. Anmelden: Server-Adresse (deine Domain), Benutzername und Passwort, also dasselbe Konto wie auf der Website.
3. **Player einrichten** (einmalig):
   - **Player** (~70 MB): mpv, Python und VapourSynth. Reicht für Originalqualität und RTX Super Resolution.
   - **Framegen** (~2,6 GB): TensorRT und ein RIFE-Modell. Nur nötig für Zwischenbilder.

   Alles landet in `%APPDATA%\Watchparty\components`. An Windows wird nichts installiert, zum Entfernen den Ordner löschen.
4. Raum erstellen oder mit Code/Link beitreten, dann auf **Player öffnen**.

## Framegen (RIFE)

Zwischenbilder werden mit [RIFE](https://github.com/hzwer/ECCV2022-RIFE) über [vs-mlrt](https://github.com/AmusementClub/vs-mlrt) und TensorRT direkt in mpv berechnet.

- **Ziel „Monitor-Hz (auto)“** rechnet genau auf die Bildwiederholrate deines Monitors hoch (z. B. 23,976 → 143,86 fps bei 144 Hz). Alternativ fester Faktor 2× bis 6×.
- **Modelle:** *4.26* für die beste Qualität, die *Lite*-Modelle sind schneller.
- **Beim ersten Film einer neuen Auflösung** baut TensorRT eine Engine für deine Karte. Das dauert einmalig 1–10 Minuten und läuft im Hintergrund. Der Film läuft solange ohne Framegen weiter und schaltet dann automatisch um.
- Szenenwechsel werden erkannt, damit keine Zwischenbilder über harte Schnitte gerechnet werden.

**Richtwerte:**

| Karte | Empfehlung |
|---|---|
| RTX 5090 / 4090 | RIFE 4.26, Monitor-Hz, VSR an |
| RTX 3080 / 3090 | RIFE 4.25 Lite, 2×–3× |
| RTX 20er / Titan RTX | RIFE 4.22 Lite, 2× bei 1080p, VSR eher aus |

4K mit hohem Faktor ist auch für schnelle Karten viel Arbeit. Wenn es ruckelt: kleineren Faktor oder ein Lite-Modell nehmen. Mit **i** im Player siehst du die Statistik.

## RTX Video Super Resolution

Skaliert das Video in mpv mit NVIDIAs KI-Upscaler auf deine Bildschirmauflösung hoch (`d3d11vpp` mit `scaling-mode=nvidia`). Optional mit **RTX Video HDR**, das macht aus SDR-Material HDR (nur mit HDR-Monitor sinnvoll).

Voraussetzung: im NVIDIA-Treiber unter *RTX Video Enhancement* ist Super Resolution aktiviert (in der NVIDIA App unter System → Video). VSR greift nur, wenn das Video kleiner als der Bildschirm ist.

Framegen und VSR lassen sich kombinieren: erst die Zwischenbilder, dann das Hochskalieren.

## Bedienleiste

Die Leiste im Player kommt von [uosc](https://github.com/tomasklaen/uosc) (5.9.2, liegt unter `mpv-ui/` bei, LGPL-2.1) und ist in den Watchparty-Farben gehalten. Unten links sind Menü, Untertitel, Tonspur und Kapitel, unten rechts die Knöpfe für **Framegen** und **Upscaling (RTX VSR)**. Ist ein Knopf aktiv, leuchtet er. Beim Drüberfahren steht da, was gerade passiert (z. B. „23,98 → 143,86 fps“), und am Framegen-Knopf hängt der Faktor. Geschwindigkeit, Playlist und Vor/Zurück fehlen absichtlich, die würden am Raum vorbei steuern.

**Untertitel** sind standardmäßig aus, auch wenn die Datei eine Spur als „Standard“ markiert. Wer einmal eine Sprache auswählt (im Fenster oder im uosc-Menü), bekommt sie ab dann automatisch.

## Tasten im Player

| Taste | Aktion |
|---|---|
| Leertaste / Rechtsklick | Play/Pause für alle |
| ← / → | 5 s zurück / vor (mit Shift: 1 s) |
| ↑ / ↓ | 1 min vor / zurück |
| F / Doppelklick | Vollbild |
| F1 | Framegen an/aus |
| F2 | RTX Super Resolution an/aus |
| S | Intro/Rückblick überspringen, im Abspann zur nächsten Folge |
| C | Chat im Bild an/aus |
| I | Statistik |
| Q | Player schließen (du bleibst im Raum) |
| Menü-Taste | uosc-Menü |

Auch Klicks und Ziehen in der Leiste werden an alle weitergegeben. Wenn nur der Host steuern darf, springt mpv zurück.

## Wie die Synchronisation funktioniert

Der Client spricht dasselbe Protokoll wie die Website: Login über `/api/login`, dann der WebSocket `/ws?room=…`. Er gleicht die Uhrzeit mit dem Server ab (mehrere Pings, die schnellsten zählen) und berechnet daraus, wo der Film gerade sein müsste.

- Kleine Abweichungen holt er weich auf, indem mpv um bis zu 6 % schneller oder langsamer läuft (mit Tonhöhenkorrektur).
- Ab 1,5 s Abweichung (mit Framegen 2,5 s) springt er direkt an die richtige Stelle.
- Alle 2 s meldet er seinen Status. Die anderen sehen dich deshalb in der Mitgliederliste mit „spielt“ und der Abweichung.

Gestreamt wird im Original über `/stream/<id>/direct`, mit allen Tonspuren und eingebetteten Untertiteln. Externe Untertitel aus Jellyfin werden dazugeladen. Wer wenig Upload hat, kann unter *Qualität* auf einen Transcode (40–6 Mbit/s) wechseln.

## Selbst bauen

```bash
cd client
npm install
npm start        # Entwicklungsmodus (unter Linux/macOS mit mpv aus dem System)
npm test         # Ende-zu-Ende-Test: Relay + Agent + Fake-Jellyfin + simuliertes mpv
npm run dist     # Windows-Installer nach client/dist/
```

Für die Tests müssen vorher `npm install` in `relay/` und `agent/` gelaufen und `ffmpeg` installiert sein. GitHub Actions baut bei jedem Tag `client-v*` automatisch ein Release.

## Fehlersuche

- **Logs:** `%APPDATA%\Watchparty\logs\mpv.log`
- **Framegen startet nicht:** In der Lobby unter *Einrichtung* prüfen, ob Framegen und das Modell installiert sind. Treiber aktuell halten, TensorRT 10 braucht einen neuen NVIDIA-Treiber.
- **Engine-Bau schlägt fehl:** Meistens zu wenig Grafikspeicher oder ein alter Treiber. Ein Lite-Modell probieren.
- **Bild hängt nach einem Sprung kurz:** Normal mit Framegen. mpv lädt das VapourSynth-Skript bei jedem Sprung neu, das dauert ein bis zwei Sekunden.

## Twitch & YouTube

Im Raum auf **📺 Twitch/YouTube** klicken und einen Link einfügen. Beides läuft in mpv, inklusive Framegen und RTX VSR.

- **Twitch:** mpv spielt den Restream vom Relay. Der Client rechnet die Zeit von mpv (roher Zeitstempel des Streams) über die Zuordnung vom Relay (`/api/twitch/<kanal>/map`) auf die gemeinsame Zeitachse um, also genauso wie der Browser. Pause, Spulen im DVR-Fenster und **● LIVE** gelten für alle.
- **YouTube** läuft über yt-dlp. Das Setup lädt `yt-dlp.exe` mit herunter (fehlt es, wird es beim ersten YouTube-Video nachgeholt) und aktualisiert es einmal am Tag. Unter Linux/macOS muss `yt-dlp` im PATH liegen.
- Die Qualität merkt sich der Client getrennt für Jellyfin, Twitch und YouTube.
