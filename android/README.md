# 📺📱 Watchparty für Fire TV, Android TV, Handy und Tablet

Eine App für alles. Sie öffnet deine Watchparty-Seite in einem eigenen Vollbild-Fenster und merkt sich die Anmeldung.

- **Auf dem Fernseher** (Fire TV Stick, Fire TV Cube, Android/Google TV) bedienst du alles mit der **Fernbedienung**: Pfeiltasten, OK, Zurück. Das Video läuft im Vollbild, und der Bildschirmschoner bleibt aus, solange etwas läuft.
- **Auf Handy und Tablet** ist es die normale Touch-Oberfläche. Mit der Zurück-Taste schließt du Fenster, Videos im Vollbild drehen sich ins Querformat.

Am Relay ist dafür nichts einzustellen. Die App ist dieselbe Website, die nur erkennt, dass sie in der App läuft.

---

## Fire TV Stick: Installation (einmalig, ca. 5 Minuten)

Apps außerhalb des Amazon-Appstores heißen beim Fire TV „Apps unbekannter Herkunft“. Das musst du einmal erlauben.

1. **Entwickleroptionen freischalten**
   *Einstellungen → Mein Fire TV → Info*. Dort **7-mal schnell auf „Fire TV Stick“** (den Gerätenamen ganz oben) drücken, bis „Du bist jetzt Entwickler“ erscheint.
2. **„Downloader“ installieren**
   Auf der Startseite auf die Lupe gehen, **Downloader** suchen (orangenes Symbol, von AFTVnews) und installieren. Die App ist kostenlos.
3. **Downloader erlauben, Apps zu installieren**
   *Einstellungen → Mein Fire TV → Entwickleroptionen → Apps unbekannter Herkunft installieren → Downloader: **AN***.
4. **Watchparty herunterladen**
   Downloader öffnen und ins Adressfeld deine Domain mit **`/app`** eintippen, z. B.
   ```
   watchparty.example.com/app
   ```
   → **Go**. Die App wird geladen, danach auf **Installieren** und dann auf **Fertig**. Die Frage, ob die Installationsdatei gelöscht werden soll, mit **Löschen** beantworten, die wird nicht mehr gebraucht.
5. **Starten**
   Die App steht unter *Apps* (das Symbol mit den drei Quadraten) ganz hinten. Mit der Menü-Taste (☰) → *Verschieben* kannst du sie nach vorne holen.
6. **Erster Start:** Server-Adresse eingeben (z. B. `watchparty.example.com`), dann **Verbinden**. Anmelden wie im Browser, fertig.

> **Gleich anderer Server?** In der Lobby unten auf „Server ändern (App)“, oder wenn der Server nicht erreichbar ist, auf „Server ändern“.

### Bedienung mit der Fernbedienung

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
   adb install -r watchparty.apk
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

> ⚠️ Das klappt nur, solange jede Version **mit demselben Schlüssel** signiert ist (siehe unten). Ohne eigenen Schlüssel signiert GitHub jedes Mal mit einem zufälligen Test-Schlüssel. Dann meldet Android beim Update „App nicht installiert“, und die alte Version muss vorher deinstalliert werden.

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
