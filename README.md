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
3. Starten, **mit Docker**:
   ```bash
   docker compose up -d --build
   docker compose logs -f
   ```
   **oder ohne Docker** (Node.js 18+, geht auch unter Windows):
   ```bash
   npm install
   npm start
   ```
4. Im Log muss stehen: `✔ mit Relay verbunden` und `✔ Jellyfin "…" bereit`. Auf der Website steht dann „Heimserver online“ mit grünem Punkt.

> Läuft Jellyfin selbst in Docker: `JELLYFIN_URL=http://host.docker.internal:8096` (oder den Container-Namen, wenn beide im selben Docker-Netz sind).

### Bestimmte Bibliotheken ausschließen

Der Agent hat eine eigene **Admin-UI im LAN** (Standard-Port **8098**): `http://<IP-des-Agent-Rechners>:8098`. Dort stellst du pro Jellyfin-Bibliothek auf „aus“ — ausgeschlossene Bibliotheken sind für **alle** Zuschauer unsichtbar und nicht abspielbar (auch nicht über direkte Links), ohne Neustart. Damit die UI im LAN erreichbar ist, setze `ADMIN_TOKEN` in der `.env` des Agenten (die UI fragt dann nach diesem Token). Ohne `ADMIN_TOKEN` ist die UI nur vom Agent-Rechner selbst erreichbar. Die Auswahl überlebt Neustarts (Volume `agent-data`).

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

## Gut zu wissen

- **Upload beim Kumpel:** Der Film muss einmal in Echtzeit vom Heimnetz zu Hetzner. Für 1080p reichen ca. 10–20 Mbit/s Upload, bei weniger stellt ihr unter ⚙ eine kleinere Qualität ein. Ab dann verteilt Hetzner an beliebig viele (20 TB Traffic/Monat sind bei Hetzner inklusive).
- **Zurückspulen** ist sofort da, weil es schon im Cache liegt. Der Cache räumt automatisch die ältesten Stücke weg, sobald `CACHE_MAX_GB` erreicht ist.
- **Fällt der Heimserver kurz aus**, läuft alles weiter, was schon im Cache liegt, und alle sehen einen Hinweis. Der Agent verbindet sich automatisch neu.
- **Sicherheit:** Passwörter werden mit scrypt gehasht, es gibt Login-Bremsen gegen Durchprobieren, Sitzungs-Cookies sind HttpOnly/Secure, und die Website nutzt HTTPS über Caddy. Der Agent-Token ist der Schlüssel zum Tunnel, also geheim halten.
- **Konto-Daten** liegen im Docker-Volume `relay-data`. Räume sind bewusst flüchtig, nach einem Neustart macht ihr einfach einen neuen auf.
