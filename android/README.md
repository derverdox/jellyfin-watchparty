# 📺📱 Watchparty für Fire TV, Android TV, Handy und Tablet

## Wechsel zum dauerhaften Signierschlüssel

Die aktuellen APKs für Android und Fire TV verwenden den dauerhaften Keystore
aus den GitHub-Secrets. Installationen des bisherigen, mit einem temporären
Debug-Schlüssel signierten Releases müssen einmal deinstalliert und anschließend
neu installiert werden. Dabei gehen lokale App-Daten verloren. Danach sind
reguläre Updates möglich. Der Release prüft den festgelegten öffentlichen
Zertifikat-Fingerprint und verhindert weitere unbeabsichtigte Schlüsselwechsel.

Es gibt zwei Apps:

| App | Für | Kurzlink zum Eintippen |
|---|---|---|
| **Watchparty TV** (`android/tv`) | Fire TV Stick/Cube, Android TV, Google TV | `deine-domain/tv` |
| **Watchparty** (`android/app`) | Android-Handy und -Tablet | `deine-domain/app` |

## Watchparty TV: die App für den Fernseher

Eine eigene, native App, gebaut nur für die Fernbedienung. Sie ist keine Website im Rahmen.

- **Startseite wie bei Netflix:** Links die Navigation. Oben groß der Titel, auf dem du gerade stehst. Darunter Reihen für „Läuft gerade bei Freunden“, „Weiterschauen“, „Meine Liste“, „Neu in …“ und „★ Top bei euch“. Beim Scrollen bleibt die ausgewählte Kachel an ihrem Platz.
- **Bibliothek, Suche, Details und Serien** mit Staffeln und Folgen, Fortschritt, „Weiter mit S1E3“, Merkliste, „gesehen“, Vorschlagen und Warteschlange.
- **Player mit ExoPlayer:** spielt fast jede Datei direkt in Originalqualität ab, auch MKV und HEVC, wenn das Gerät es kann. Sonst schaltet er von selbst auf Transcoding. Tonspur, Untertitel und Qualität kann jeder für sich wählen.
- **Synchron mit allen:** dieselbe Sync-Logik wie Browser und Desktop. Kleine Abweichungen werden weich über die Geschwindigkeit ausgeglichen, größere durch einen Sprung.
- **Twitch live** über den Restream des Servers, auf das Bild genau synchron, mit Pause, Zurückspulen und „● LIVE“. **YouTube** sowie Twitch-Videos und -Clips laufen im eingebetteten Player.
- **Räume:** Freunde sehen und beitreten, Raum per Code öffnen, eigenen Raum erstellen. Wer im Raum ist, kann mit dem Handy den QR-Code scannen und dazukommen.
- **Chat und Reaktionen** im Bild, Schnellantworten, Abstimmung „Was schauen wir?“, Bewertungsrunde nach dem Film, **Empfehlungen am Filmende** (OK spielt für alle ab, Zurück schließt), Intro überspringen, nächste Folge.
- **Anmelden per QR-Code** mit dem Handy, ganz ohne Tippen. Benutzername und Passwort gehen auch.

### Fernbedienung im Player

| Taste | Was passiert |
|---|---|
| **OK** / ⏯ | Play/Pause für alle (während Intro/Abspann: überspringen) |
| ◀ / ▶ | Spulen mit Vorschau: jeder Druck ±10 s, gedrückt halten ±30 s. Nach kurzer Pause wird gesprungen, OK springt sofort |
| ⏪ / ⏩ | ±30 s |
| ▼ | Steuerleiste: Zeitleiste (fokussieren, mit ◀/▶ Stelle wählen, OK), Ton & Untertitel, Qualität, Chat, Leute, Warteschlange, Reaktionen |
| ▲ / ☰ | Chat (mit Reaktionen und Schnellantworten) |
| Zurück | schließt Schritt für Schritt: Leiste → Spulen → Fenster. Danach die Wahl „Weiterschauen / Zur Startseite (Raum bleibt offen) / Raum verlassen“ |

Textfelder öffnen die Bildschirmtastatur erst nach **OK**. Beim Drüberfahren bleiben die Pfeiltasten frei.

### Updates

Die TV-App schaut beim Start nach, ob es eine neue Version gibt, und bietet sie einmal an: **Jetzt installieren**, Später oder Überspringen. Unter **Einstellungen → Updates** geht das auch von Hand. Die App lädt das neue APK über `deine-domain/tv.apk`, prüft die Prüfsumme und übergibt es dem Android-Installer.

- **Beim ersten Update** fragt Android, ob „Watchparty TV“ Apps installieren darf. Auf dem Fire TV liegt das unter *Einstellungen → Mein Fire TV → Entwickleroptionen → Apps unbekannter Herkunft → Watchparty TV: an*.
- **Updates klappen nur mit festem Signierschlüssel** (GitHub-Secret `APP_KEYSTORE_B64`). Ohne Schlüssel signiert jeder Build anders, und Android lehnt das Update ab. Die App sagt das dann auch so.

### Installation auf dem Fire TV

Wie unten beschrieben (Downloader), nur mit **`deine-domain/tv`** statt `/app`. Die TV-App hat eine eigene App-ID und läuft neben der alten Watchparty-App, die du danach deinstallieren kannst.

---

## Fire TV Stick: Installation (einmalig, ca. 5 Minuten)

Apps außerhalb des Amazon-Appstores heißen beim Fire TV „Apps unbekannter Herkunft“. Das musst du einmal erlauben.

1. **Entwickleroptionen freischalten**
   *Einstellungen → Mein Fire TV → Info*. Dort **7-mal schnell auf „Fire TV Stick“** (den Gerätenamen ganz oben) drücken, bis „Du bist jetzt Entwickler“ erscheint.
2. **„Downloader“ installieren**
   Auf der Startseite auf die Lupe gehen, **Downloader** suchen (orangenes Symbol, von AFTVnews) und installieren. Die App ist kostenlos.
3. **Downloader erlauben, Apps zu installieren**
   *Einstellungen → Mein Fire TV → Entwickleroptionen → Apps unbekannter Herkunft installieren → Downloader: **AN***.
4. **Watchparty TV herunterladen**
   Downloader öffnen und ins Adressfeld deine Domain mit **`/tv`** eintippen, z. B.
   ```
   watchparty.example.com/tv
   ```
   → **Go**. Die App wird geladen, danach auf **Installieren** und dann auf **Fertig**. Die Frage, ob die Installationsdatei gelöscht werden soll, mit **Löschen** beantworten, die wird nicht mehr gebraucht.
5. **Starten**
   Die App steht unter *Apps* (das Symbol mit den drei Quadraten) ganz hinten. Mit der Menü-Taste (☰) → *Verschieben* kannst du sie nach vorne holen.
6. **Erster Start:** Server-Adresse eingeben (z. B. `watchparty.example.com`), dann **Verbinden**. Danach den QR-Code mit dem Handy scannen: Watchparty am Handy öffnen, dann **📷 Gerät anmelden**. Fertig.

> **Gleich anderer Server?** In der Lobby unten auf „Server ändern (App)“, oder wenn der Server nicht erreichbar ist, auf „Server ändern“.

### Handy-App auf dem Fernseher (alte Variante)

Die Handy-App läuft auch auf dem Fernseher, ist dort aber nur eine Website mit Fernbedienungs-Steuerung. Besser ist die TV-App oben.

| Taste | Was passiert |
|---|---|
| ◀ ▲ ▼ ▶ | Zum nächsten Knopf/Feld springen (gelber Rahmen) |
| OK | Knopf drücken, Feld öffnet die Bildschirmtastatur |
| **Im Video:** ◀ / ▶ | 10 s zurück / vor (für alle) |
| **Im Video:** OK, ⏯ | Play/Pause für alle |
| **Im Video:** ▼ | Steuerleiste (Qualität, Tonspur, Untertitel unter ⚙) |
| **Im Video:** ▲ | Leiste oben (Bibliothek, Einladen) |
| ⏪ / ⏩ | 30 s zurück / vor |
| ☰ (Menü) | Chat ein/aus |
| Zurück | Schließt Schritt für Schritt: Fenster → Steuerleiste → Vollbild. Im Raum zweimal: Raum verlassen. In der Lobby zweimal: App beenden |

### Alternative: vom PC aus installieren (adb)

Wenn auf dem PC die [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools) installiert sind:

1. Fire TV: *Entwickleroptionen → ADB-Debugging: AN*. Die IP steht unter *Mein Fire TV → Info → Netzwerk*.
2. Am PC:
   ```bash
   adb connect 192.168.1.50
   adb install -r watchparty-tv.apk
   ```
   Beim ersten Mal auf dem Fernseher „Erlauben“ drücken.

---

## Handy und Tablet

1. Auf dem Handy im Browser `watchparty.example.com/app` öffnen. Die Datei `watchparty.apk` wird heruntergeladen.
2. Antippen → Android fragt, ob der Browser Apps installieren darf → **Zulassen** → **Installieren**.
3. Öffnen, Server-Adresse eingeben, anmelden.

---

## Updates

Jede Änderung an `android/` auf `main` baut automatisch ein neues APK und legt es im Release **„android-latest“** ab. `/app` zeigt immer auf das neueste. Zum Aktualisieren einfach die Installation wiederholen (Downloader → `/app`). Anmeldung und Server bleiben erhalten.

> ⚠️ Das klappt nur, solange jede Version **mit demselben Schlüssel** signiert ist (siehe unten). Release-Builds ohne eingerichteten Keystore werden abgebrochen. Bisherige Test-Versionen mit Debug-Schlüssel benötigen einmalig eine Neuinstallation.

### Eigenen Signierschlüssel einrichten (einmalig, empfohlen)

Der Schlüssel gehört **nicht ins Repo**: Jeder, der ihn hat, könnte gefälschte Updates deiner App bauen. Er kommt als verschlüsseltes Secret zu GitHub.

1. Am PC (braucht Java, z. B. das aus Android Studio):
   ```bash
   keytool -genkeypair -keystore watchparty.jks -storetype PKCS12 -alias watchparty \
     -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=Watchparty"
   ```
   Ein langes Passwort ausdenken und eintippen.
2. Datei in Base64 umwandeln:
   - Windows (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes("watchparty.jks")) | Set-Clipboard`
   - Linux/macOS: `base64 -w0 watchparty.jks` (macOS: `base64 -i watchparty.jks`)
3. GitHub → Repo → *Settings → Secrets and variables → Actions → New repository secret*:
   - `APP_KEYSTORE_B64` = der Base64-Text
   - `APP_KEYSTORE_PASSWORD` = das Passwort
4. `watchparty.jks` und das Passwort gut aufheben (Passwortmanager). Geht der Schlüssel verloren, muss die App auf allen Geräten einmal neu installiert werden.

Ab dem nächsten Build ist jedes APK mit diesem Schlüssel signiert. Die **erste** Installation danach muss die alte (Test-)Version ersetzen, also einmal deinstallieren.

---

## Gut zu wissen

- **Videoformate:** Die App spielt das Video über dieselbe Logik ab wie der Browser. Original-Dateien laufen direkt, wenn sie MP4/WebM mit H.264/VP9/AV1 und AAC/Opus sind. Alles andere (z. B. MKV mit HEVC und DTS) wird von Jellyfin umgewandelt. Die Qualität stellst du im Player unter ⚙ ein.
- **Externe Links** (z. B. GitHub) öffnet die App nicht, sie bleibt auf deinem Server.
- **Selbst bauen:** Ordner `android/` in Android Studio öffnen oder `./gradlew assembleRelease`. Ohne `APP_KEYSTORE` wird mit dem Debug-Schlüssel signiert.
- **Anderer Download-Link:** Wer das APK woanders hostet, setzt am Relay `APP_APK_URL`.
