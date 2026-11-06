# 🎬 Jellyfin Watchparty – Relay-Edition

Filme & Serien vom Jellyfin deines Kumpels **synchron zusammen schauen**, mit Livechat, Emoji-Reaktionen, Benutzerkonten und beliebig vielen Leuten. Alles läuft öffentlich auf deiner eigenen Domain (z. B. `https://example.com`).

```
  Browser 1 ─┐                        ┌──────────── Heimnetz deines Kumpels ─────────────┐
  Browser 2 ─┼── HTTPS ──▶  RELAY  ◀══╪══ WSS-Tunnel (vom Agent aufgebaut) ══ AGENT ──▶ Jellyfin
  Browser 3 ─┘          (Hetzner)     └──────────────────────────────────────────────────┘
                     Web, Konten, Chat,
                     Sync, Video-Cache
```

- **Relay** (Hetzner): Web-Oberfläche, Konten & Einladungen, Räume, Chat und Sync. Videos werden in 4-MB-Stücken bzw. HLS-Segmenten **zwischengespeichert und an alle verteilt**. Jedes Stück kommt also nur **einmal** vom Heimanschluss, egal wie viele zuschauen.
- **Agent** (beim Jellyfin-Rechner): baut die Verbindung **von innen nach außen** auf. Es braucht **keine Portfreigabe und keine Router-Einstellungen**, und Jellyfin bleibt komplett unsichtbar im Internet. Der Jellyfin-API-Key verlässt das Heimnetz nie, und der Agent beantwortet nur eine feste Liste harmloser Anfragen (Bibliothek, Bilder, Streams), selbst wenn jemand das Relay übernehmen würde.
- **Desktop-Client** (optional, Windows): schaut im selben Raum mit, aber in mpv, in Originalqualität, mit **RIFE-Zwischenbildern** und **RTX Video Super Resolution**. Siehe [`client/README.md`](client/README.md).
- **TV-App** (optional, Fire TV / Android TV): eigene, native App für den Fernseher. Sie ist komplett auf die Fernbedienung ausgelegt, mit flüssigem Scrollen und einem Player mit ExoPlayer, und schaut genauso synchron mit wie Browser und Desktop. Installation über `https://deine-domain/tv`, siehe [`android/README.md`](android/README.md).
- **Handy-App** (optional, Android-Handy/Tablet): die Watchparty als App. Installation über `https://deine-domain/app`.

---

## Teil 1: Relay auf dem Hetzner-Server

**Voraussetzung:** ein Hetzner Cloud Server (CX22 reicht völlig) mit Ubuntu/Debian und deine Domain.

1. **DNS:** Beim Domain-Anbieter einen **A-Eintrag** `example.com → <IP des Hetzner-Servers>` anlegen (optional zusätzlich `www`).
2. **Firewall** (Hetzner Cloud Console oder `ufw`): Ports **22, 80, 443** offen.
3. **Docker installieren:**
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
4. **Dateien hochladen** (Ordner `relay/`), z. B.
   ```bash
   scp -r relay root@<server-ip>:/opt/watchparty
   ```
5. **Konfigurieren:**
   ```bash
   cd /opt/watchparty
   cp .env.example .env
   openssl rand -hex 32        # → Ergebnis als AGENT_TOKEN in .env eintragen
   nano .env                   # DOMAIN, AGENT_TOKEN, ADMIN_USER, ADMIN_PASSWORD
   ```
6. **Starten:**
   ```bash
   docker compose up -d --build
   docker compose logs -f relay
   ```
   Caddy holt automatisch das HTTPS-Zertifikat. Nach ca. 30 s ist `https://example.com` erreichbar und du kannst dich mit deinem Admin-Konto anmelden.

## Teil 2: Agent beim Jellyfin-Rechner deines Kumpels

1. In Jellyfin: **Dashboard → API-Schlüssel → +** (Name „Watchparty“) und den Schlüssel kopieren.
2. Ordner `agent/` auf den Rechner kopieren und konfigurieren:
   ```bash
   cp .env.example .env
   nano .env    # RELAY_URL, AGENT_TOKEN (gleicher wie auf Hetzner!), JELLYFIN_API_KEY
   ```
   Optional: `MAX_UPLOAD_MBPS=15` drosselt den Upload des Agenten zum Relay (siehe „Gut zu wissen“).
3. Starten, **mit Docker**:
   ```bash
   docker compose up -d --build
   docker compose logs -f
   ```
   **oder als fertige EXE ohne Docker/Node** (z. B. Windows-PC): unter
   [Releases](../../releases) `watchparty-agent-win.exe` (bzw. `-linux`) herunterladen,
   zusammen mit einer `.env` in einen Ordner legen und per Doppelklick starten.
   Die EXE wird bei jedem Tag (`git tag v2.3.0 && git push --tags`) automatisch von GitHub gebaut.
   **oder ohne Docker** selbst (Node.js 18+, geht auch unter Windows):
   ```bash
   npm install
   npm start
   ```
4. Im Log muss stehen: `✔ mit Relay verbunden` und `✔ Jellyfin "…" bereit`. Auf der Website steht dann „Heimserver online“ mit grünem Punkt.

> Läuft Jellyfin selbst in Docker: `JELLYFIN_URL=http://host.docker.internal:8096` (oder den Container-Namen, wenn beide im selben Docker-Netz sind).

### Bestimmte Bibliotheken ausschließen

Der Agent hat eine eigene **Admin-UI im LAN** (Standard-Port **8098**): `http://<IP-des-Agent-Rechners>:8098`. Dort stellst du pro Jellyfin-Bibliothek auf „aus“ — ausgeschlossene Bibliotheken sind für **alle** Zuschauer unsichtbar und nicht abspielbar (auch nicht über direkte Links), ohne Neustart. Damit die UI im LAN erreichbar ist, setze `ADMIN_TOKEN` in der `.env` des Agenten (die UI fragt dann nach diesem Token). Ohne `ADMIN_TOKEN` ist die UI nur vom Agent-Rechner selbst erreichbar. Die Auswahl überlebt Neustarts (Volume `agent-data`).

In derselben Agent-Verwaltung gibt es **„Duplikate analysieren“ → „Analyse starten“**.
Die Analyse liest die Jellyfin-Metadaten aller für den Agent-Benutzer sichtbaren
Bibliotheken, einschließlich ausgeschlossener Bibliotheken. Sie zeigt mehrfach
vorhandene Filme und Episoden mit DVD-/Blu-ray-/UHD-Qualitäten, Quelldateipfaden,
Laufzeiten sowie Audio- und Untertitelspuren. Zwei Blu-rays derselben Qualität
bleiben als getrennte Quellen sichtbar. Auch bereits von Jellyfin kombinierte
Versionen werden berücksichtigt. Episoden werden anhand der Serie, Staffel und
Folgenummer zugeordnet, nicht nur anhand ihres Titels.

Die Analyse läuft auf Anforderung im Hintergrund und zeigt ihren Fortschritt.
Sie verändert keine Dateien oder Jellyfin-Einträge; das Ergebnis bleibt bis zum
nächsten Scan bzw. Agent-Neustart im Arbeitsspeicher. Fehlende oder widersprüchliche
Metadaten können dazu führen, dass Varianten nicht erkannt werden. Eine gefundene
Gruppe ist **kein Nachweis gleicher Schnittfassung oder synchroner Zeitachsen**.
Weitere Details: [Filmversionen und synchroner Player](docs/movie-versions.md).


---

## Benutzung

- **Leute einladen:** Als Admin in der Lobby auf **„Freund einladen“** klicken. Das gibt einen Einmal-Link (72 h gültig), mit dem sich der Freund Benutzername und Passwort selbst aussucht.
- **Raum aufmachen:** „Neuen Raum erstellen“ und dann oben **„Einladen“**. Der Raumlink geht an alle, die schon ein Konto haben.
- **Steuerung:** Standardmäßig darf jeder pausieren und springen. Der Host kann das unter „Leute“ sperren, die Host-Rolle weitergeben oder jemanden rauswerfen.
- **Pro Person einstellbar** (⚙): Qualität, Tonspur, Untertitel. „Automatisch“ nimmt die Originaldatei, wenn der Browser sie abspielen kann, sonst transkodiert Jellyfin. Wer dieselben Einstellungen hat, teilt sich **einen** Transcode.
- **Tastatur:** `Leertaste` Play/Pause · `←/→` ±10 s · `F` Vollbild · `M` Ton · `C` Chat · `Enter` Chat schreiben

## Verwaltung (`/admin`)

Admins finden in der Lobby **„⚙ Verwaltung öffnen“**, oder direkt unter `https://example.com/admin`.

- **Übersicht:** Zuschauer live, aktive Räume, Heimserver-Status, Traffic zu den Zuschauern und vom Heimnetz, wie viel Heim-Upload der Cache spart, Cache-Füllstand und Trefferquote, CPU, RAM und Event-Loop des Servers. Dazu Verläufe der letzten Stunde und Woche und ein Aktivitäts-Feed.
- **Räume:** Was läuft wo, mit Position und Status jedes Mitglieds (Browser, Desktop-Client oder Handy, Abweichung). Ansage an einen Raum oder an alle, Leute entfernen, Steuerung freigeben, Raum schließen.
- **Benutzer:** Konten anlegen (optional mit Zufallspasswort), Gruppen zuweisen, sperren, Ablaufdatum, Notiz, Passwort zurücksetzen, aktive Sitzungen einzeln beenden, löschen. Sperren und Löschen trennt sofort alle Verbindungen.
- **Gruppen:** Rechte (Räume erstellen, steuern, Filme auswählen, vorschlagen, chatten, einladen, Originalqualität), höchste Bitrate und **Inhaltszugriff**: alles, *nur* bestimmte Bibliotheken/Ordner/Serien oder *alles außer* bestimmten. Gilt überall: Bibliothek, Suche, Bilder, Streams und direkte Links. Wer im Raum keinen Zugriff auf den laufenden Titel hat, sieht einen Hinweis, und der Host bekommt Bescheid.
- **Einladungen:** mit Zielgruppe, Gültigkeit (1–30 Tage) und Anzahl Nutzungen. Offene Einladungen lassen sich widerrufen.
- **Statistik:** Watchtime gesamt und pro Konto, meistgeschaute Titel, Tageswerte der letzten 30 Tage, Rekord an gleichzeitigen Zuschauern.
- **Protokoll:** Anmeldungen, Fehlversuche und alle Admin-Aktionen (`data/audit.jsonl`).
- **Einstellungen:** Standardgruppe für neue Konten, Einladungen an/aus, maximale Räume pro Konto, Begrüßungstext in der Lobby, **Wartungsmodus** (nur Admins kommen rein).

- **Sicherheit:** Fehlversuche bei der Anmeldung pro IP und pro Konto, automatisch gebremste und gesperrte IPs, manuelles Sperren und Entsperren.

Wer mit einem Admin-Konto angemeldet ist, sieht die Website (und den Desktop-Client) in **Rot**, damit man nicht aus Versehen als Admin unterwegs ist.

**Haupt-Admin:** Das erste Admin-Konto (`ADMIN_USER`) ist der Haupt-Admin. Es kann nicht gelöscht, gesperrt oder herabgestuft werden. Nur der Haupt-Admin darf andere zu Admins machen und andere Admins bearbeiten.

> Die Bibliotheks-Ausschlüsse im Agent (siehe oben) gelten zusätzlich und für alle, auch für Admins. Die Gruppen regeln dann, wer innerhalb des Rests was sieht.

### Konten per Kommandozeile (auf Hetzner)
```bash
docker compose exec relay node server.js user list
docker compose exec relay node server.js user add lisa
docker compose exec relay node server.js user add lisa --admin
docker compose exec relay node server.js user passwd lisa
docker compose exec relay node server.js user del lisa
docker compose exec -e DOMAIN=example.com relay node server.js invite 48   # Einladungslink, 48 h
```

## Bibliothek, Merkliste & Qualität

- **Suche** über Filme, Serien und Folgen, nach Relevanz sortiert und gruppiert. Sie ist tolerant bei Umlauten, ß und Tippfehlern, versteht Wörter in beliebiger Reihenfolge und auf Wunsch ein Jahr („ritter 1999“, nur „2012“).
- **Sortieren** in jeder Bibliothek: A–Z, neu hinzugefügt, neueste, beste Bewertung.
- **Merkliste** (☆ auf jedem Titel) und **Zuletzt geschaut** mit Fortschritt. Die Startseite der Bibliothek zeigt „Weiterschauen“ und die Merkliste.
- **Qualität:** Zur Auswahl steht nur, was die Datei hergibt. Ein 1080p-Film mit 8 Mbit/s bietet „Original · Full HD · 8 Mbit/s“, „HD · 6 Mbit/s“, „SD · 3 Mbit/s“ und „Mobil“. Stufen über dem Original gibt es nicht, und die Bitrate-Grenze der Gruppe gilt zusätzlich.

## Serien, Bewertungen & Gemeinsam aussuchen

- **Detailansicht** für jeden Titel: Hintergrundbild (abgedunkelt), Poster, Genres, Jellyfin-Wertung und unsere eigene Wertung, Beschreibung. Dort spielst du ab, setzt fort, schlägst vor, merkst dir den Titel oder markierst ihn als gesehen.
- **Serien:** Staffel-Tabs mit Fortschritt („2/10“), Folgenliste mit Vorschaubild, Laufzeit, Beschreibung und Fortschrittsbalken. Oben steht **„Weiter mit S1E3“**. Folgen, Staffeln oder **„alles bis hier“** lassen sich als gesehen markieren, ab 90 % passiert das automatisch. Im Raum zeigen kleine Avatare, wer die Folge schon kennt.
- **Bewertungen 1–10 ★**, anonym: Alle sehen nur Schnitt und Anzahl, nie wer was vergeben hat. „★ Top“ in der Bibliothek zeigt, was bei euch am besten ankommt. Nach einem Film kommt automatisch eine **Bewertungsrunde** (Ergebnis im Chat).
- **Warteschlange** („Liste“ im Raum): Titel oder ganze Staffeln einreihen, sortieren, entfernen. Nach dem Ende geht es nach 8 s automatisch mit dem nächsten weiter.
- **Empfehlungen am Filmende** („Das könnte euch auch gefallen“): Ist ein Film zu Ende und die Warteschlange leer, zeigen Browser, Handy-App, Desktop-Client (zusätzlich als Menü direkt in mpv) und TV-App ähnliche Titel aus eurer Bibliothek. Mit einem Klick für alle abspielen, in die Liste legen, vorschlagen oder die ersten drei zur Abstimmung stellen. Dasselbe gibt es als „Ähnliche Titel“ in der Detailansicht.
  - **So wird ausgewählt:** Jeder Titel wird über Genres, Regie, Drehbuch, Hauptrollen, Studios, Schlagwörter und die Filmreihe beschrieben. Seltene Gemeinsamkeiten zählen mehr als häufige (dieselbe Regisseurin sagt mehr als „Drama“). Dazu kommen Erscheinungsjahr, Jellyfin-Wertung und eure eigenen Sterne sowie der Geschmack der Leute im Raum. Was alle im Raum schon gesehen haben, rutscht nach hinten, ein deutlich höheres Freigabealter ebenso. Die nächste Fortsetzung einer Reihe kommt nach vorn, und die Auswahl wird gestreut, damit nicht nur Teile derselben Reihe erscheinen. Jede Empfehlung zeigt, warum sie kommt („Regie: …“, „Mit …“, „Fortsetzung der Reihe“).
  - Es erscheint nur, was **alle** im Raum sehen dürfen. Alles läuft auf dem Relay mit den Jellyfin-Daten, die der Agent ohnehin freigibt, **ohne Agent-Update** und ohne externe Dienste. Der Katalog wird 30 Minuten im Relay gehalten.
  - Auch nach der letzten Folge einer Serie. Wer zurückspult, blendet die Empfehlungen aus, am Ende kommen sie wieder.
- **Abstimmung „Was schauen wir?“:** 2–4 Titel auswählen, 60 s abstimmen, der Gewinner startet sofort.
- **🎲 Zufall** mit Filtern: Film/Serie/Folge, Höchstlänge, Mindestwertung, nur Ungesehenes, nur im aktuellen Ordner.
- **Intro, Rückblick und Abspann überspringen**, wenn Jellyfin die Marker kennt (Media Segments ab 10.10 oder das Intro-Skipper-Plugin). Beim Abspann springt der Knopf zur nächsten Folge. Dafür braucht der Agent Version 2.2.
- **📌 Schwarzes Brett:** Wunschliste für neue Medien. Jeder trägt Titel ein (mit Jahr, Notiz, Tags), stimmt ab und taggt. Beim Eintippen prüft es, ob der Titel schon da oder schon gewünscht ist. Admins setzen den Status (offen, in Arbeit, verfügbar, abgelehnt). Taucht ein Wunsch in Jellyfin auf, wird er von selbst „verfügbar“ und der Wünschende sieht es in der Lobby. Wer wünschen darf, steuert das Recht „Wünsche“ in den Gruppen.
- **📊 Mein Jahr:** persönliche Statistik mit geschauten Stunden, aktiven Tagen, längster Serie am Stück, Top-Titeln, Lieblings-Genres und Wochentagen.

## Twitch & YouTube im Raum

Im Raum oben auf **📺 Twitch/YouTube** klicken und einen Link einfügen (`twitch.tv/kanal`, `youtube.com/watch?v=…`, `youtu.be/…`, auch mit `?t=90`).

- **Twitch läuft über das Relay:** Der Server holt den Kanal **einmal** über einen einzigen Zugang und verteilt dieselben Segmente an alle im Raum. Er nimmt nur Segmente in seine Playlist auf, die schon komplett auf dem Server liegen. Damit bekommen alle exakt dieselben Daten zur selben Zeit.
- **Feste Timeline auch für Livestreams:** Jedes Twitch-Segment hat einen Zeitstempel (`#EXT-X-PROGRAM-DATE-TIME`). Die Raum-Position ist dieser Zeitstempel, und jeder Browser rechnet ihn in seine lokale Videozeit um. Danach greift derselbe Sync wie bei Filmen: weiche Korrektur über die Abspielgeschwindigkeit, ab 80 ms Abweichung.
- **Pausieren, Zurückspulen und „● LIVE“:** Das Relay hält ein DVR-Fenster vor (Standard 15 min). Pause und Spulen gelten für alle. „● LIVE“ springt den ganzen Raum zurück an die Kante. Hängt der Stream beim Streamer, setzt das Relay alle gemeinsam neu an.
- **Qualität pro Person** (⚙): Alle Twitch-Qualitäten haben dieselben Zeitstempel, deshalb bleibt der Sync auch bei unterschiedlicher Qualität erhalten. Jede Qualität wird nur geholt, solange sie jemand schaut.
- **Werbefrei/eigener Zugang:** `TWITCH_OAUTH` in der `relay/.env` (siehe `.env.example`). Ohne Token schaut das Relay anonym, Werbesegmente werden dann übersprungen.
- **YouTube** läuft im offiziellen YouTube-Player und synchronisiert über dieselbe Raum-Position. YouTube kennt nur feste Geschwindigkeitsstufen, deshalb liegt die Genauigkeit hier etwa bei 0,1 s statt im Bild-Bereich.
- **Desktop-Client:** Twitch und YouTube laufen auch in mpv (mit Framegen/VSR), synchron mit Browser und TV-App. YouTube braucht dort yt-dlp, das richtet der Client selbst ein.
- **Grenzen:** Twitch-VODs/Clips gehen noch nicht, nur Live-Kanäle.

> Twitch-Streams weiterzuverteilen ist nach den Twitch-Nutzungsbedingungen nicht erlaubt. Das ist für einen kleinen privaten Kreis gedacht, nicht für öffentliche Räume.

## Sicherheit

- **Brute-Force-Schutz:** Nach 5 Fehlversuchen pro IP wächst die Wartezeit (2 s, 4 s, 8 s … bis 15 min). Ab 30 Fehlversuchen pro Stunde wird die IP für 1 h gesperrt, ab 100 am Tag für 24 h. Pro Konto werden Versuche ab 20 Fehlern gebremst, aber nicht hart gesperrt, damit niemand fremde Konten aussperren kann. Sperren überleben Neustarts und sind in der Verwaltung unter **Sicherheit** einsehbar.
- **Passwörter** mit scrypt gehasht. Bekannte Passwörter und solche, die den Benutzernamen enthalten, werden abgelehnt.
- **Sitzungen:** HttpOnly- und SameSite-Cookies (über HTTPS mit `Secure` und HSTS). Auf der Platte liegen nur Hashes der Tokens.
- **CSRF:** Ändernde Anfragen von fremden Seiten werden abgelehnt.
- **Header:** CSP, `frame-ancestors`, `Permissions-Policy` und COOP/CORP.
- **Bremsen** für Anfragen pro IP, WebSocket-Verbindungen pro Sitzung, Raum-Suchen, Einladungscodes und Statusmeldungen.
- **Client-IP:** Hinter Caddy wird nur der letzte `X-Forwarded-For`-Eintrag vertraut, den der Proxy selbst setzt.
- **Agent-Admin:** Durchprobieren des `ADMIN_TOKEN` wird gebremst (10 Fehlversuche, dann 10 min Pause).

## Gut zu wissen

- **Upload beim Kumpel:** Der Film muss einmal in Echtzeit vom Heimnetz zu Hetzner. Für 1080p reichen ca. 10–20 Mbit/s Upload, bei weniger stellt ihr unter ⚙ eine kleinere Qualität ein. Ab dann verteilt Hetzner an beliebig viele (20 TB Traffic/Monat sind bei Hetzner inklusive).
- **Upload-Grenze setzen:** `MAX_UPLOAD_MBPS=15` in der `agent/.env` deckelt die gesamte Upload-Bandbreite, die der Agent zum Relay schickt (unabhängig von wie vielen Streams gleichzeitig). So bleibt der Heimanschluss für andere Dinge frei – z. B. TrueNAS-Syncs, Backups oder andere Mitbewohner. Die Drossel sitzt im Agent selbst und funktioniert deshalb überall gleich, auch im Docker-Container unter TrueNAS SCALE (nach Änderung: `docker compose up -d`). Wert weglassen oder `0` = ungedrosselt.
- **Zurückspulen** ist sofort da, weil es schon im Cache liegt. Der Cache räumt automatisch die ältesten Stücke weg, sobald `CACHE_MAX_GB` erreicht ist.
- **Fällt der Heimserver kurz aus**, läuft alles weiter, was schon im Cache liegt, und alle sehen einen Hinweis. Der Agent verbindet sich automatisch neu.
- **Sicherheit:** Passwörter werden mit scrypt gehasht, es gibt Login-Bremsen gegen Durchprobieren, Sitzungs-Cookies sind HttpOnly/Secure, und die Website nutzt HTTPS über Caddy. Der Agent-Token ist der Schlüssel zum Tunnel, also geheim halten.
- **Mit dem PC hochskalieren und auf den Fernseher streamen?** Ist nicht eingebaut. Wer das will, installiert am PC [Sunshine](https://github.com/LizardByte/Sunshine) (oder die Abspaltung [Apollo](https://github.com/ClassicOldSong/Apollo) mit virtuellem Bildschirm) und auf dem Fernseher/Fire TV [Moonlight](https://moonlight-stream.org/). Dann den Desktop-Client mit Framegen/VSR im Vollbild auf dem gestreamten Bildschirm laufen lassen. Die Pfeiltasten und OK der Fernbedienung kommen am PC als Tasten an und steuern mpv.
- **Konto-Daten** liegen im Docker-Volume `relay-data`. Räume sind bewusst flüchtig, nach einem Neustart macht ihr einfach einen neuen auf.

### Filmquellen und Übertragungsqualität

Beim Neustart eines Films wählt der Relay die beste für alle aktuellen Zuschauer
freigegebene Quelle desselben Titels. Sie bleibt für den Raum festgelegt; eine
niedrigere Übertragungsstufe wechselt nicht zu einer anderen Datei. Beim Fortsetzen
wird die ursprüngliche Quelle verwendet. Full HD bleibt bei jeder 1080p-Quelle
im Rahmen der Freigaben auswählbar, unabhängig von ihrer Quellbitrate.

**Automatisch** beginnt mit bis zu `AUTO_MAX_MBPS=10` Mbit/s und senkt bei anhaltendem
Puffern die Übertragungsqualität. Neue Desktop-/TV-Clients verwenden dies standardmäßig;
bestehende manuelle Einstellungen lassen sich im Qualitätsmenü auf Automatisch stellen.
Eine passende Originaldatei kann direkt laufen, andernfalls transcodiert Jellyfin.
`STREAM_MAX_MBPS=0` setzt kein zusätzliches Relay-Limit; Gruppenlimits und 80 % einer
vom aktualisierten Agent gemeldeten `MAX_UPLOAD_MBPS`-Grenze gelten zusätzlich,
auch für Originaldateien. Relay und Agent für die Upload-Budgetmeldung gemeinsam
aktualisieren. Mehrere unterschiedliche Streams teilen weiterhin die Gesamtleitung.
Details und Grenzen: [Filmversionen](docs/movie-versions.md#umgesetzt-hochwertige-quelle-und-begrenzte-übertragung).
