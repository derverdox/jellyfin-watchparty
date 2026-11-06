# Filmversionen: Bibliothek und synchroner Player

## Umgesetzt: Bibliothek

Der Relay gruppiert Filme in `/api/catalog`, `/api/items` und `/api/search`.
Web, Fire TV / Android (WebView), die native Fire-TV-App und Desktop zeigen auf den Filmkarten oben
rechts die verfügbaren Qualitäten. Die Suffixe `576p`, `1080p`, `2160p`
werden als SD, Full HD und 4K erkannt und aus dem Gruppentitel entfernt.
Ohne Qualitätssuffix liefern die Videomaße die Einstufung; HD wird bei
720p separat angezeigt. Bereits von Jellyfin zusammengefasste MediaSources
tragen ebenfalls zu den Badges bei. Es werden keine Dateipfade ausgegeben.

Gemeinsame IMDb-/TMDb-/TVDb-IDs verbinden auch abweichende Titel und Schnitte.
Widersprechende IDs desselben Anbieters verhindern eine Zusammenlegung.
Ohne verlässliche gemeinsame IDs werden nur gleicher Titel nach Entfernung
des Qualitätssuffixes und gleiches, vorhandenes Erscheinungsjahr verbunden,
sofern nicht beide Einträge eigene, nicht übereinstimmende Provider-IDs besitzen.
Unterschiedliche Schnitttitel ohne gemeinsame ID bleiben vorsichtshalber separat.
Titel plus Jahr ist eine Heuristik: falsche oder fehlende Metadaten müssen
in Jellyfin korrigiert werden. Episoden und Serien bleiben unverändert.

Zugriffsrechte werden VOR der Gruppierung angewendet: auch Badges und Versions-IDs
enthalten nur freigegebene Einträge. Bei `/api/items` werden alle Quellseiten
vor der Gruppierung und der angeforderten Pagination gelesen. Diese Rohlisten
werden 60 Sekunden gecacht, der A–Z-Katalog wie bisher zehn Minuten.
Die Suche gruppiert ihre gefundenen Treffer; Jellyfins bestehendes Limit von
60 Treffern pro Suchvariante bleibt erhalten. Badges einer begrenzten Suche
können daher weniger vollständig sein als im gesamten A–Z-Katalog.

`versions` erhält für jeden Jellyfin-Filmeintrag ID, ursprünglichen Namen,
Qualitäten und Laufzeit. Mehrere Blu-rays derselben Auflösung bleiben darin
separat erhalten. Die alphabetisch kleinste Jellyfin-ID ist innerhalb einer
Gruppe der Vertreter; bestehende Detail- und Wiedergabeaufrufe verwenden diese
reale ID. Beim Neustart eines Films wird die Wiedergabequelle inzwischen separat ausgewählt (siehe unten); die Kachel-ID bleibt stabil. Eine manuelle Versionsauswahl im Player gibt es noch nicht. Bereits in Jellyfin
kombinierte MediaSources erscheinen in diesem ersten Schritt als ein Filmeintrag.
Verlauf, Merkliste und Bewertungen bleiben an die bisherigen Item-IDs gebunden;
eine Zusammenführung dieser Daten ist Teil der nächsten Phase.

## Umgesetzt: Duplikatanalyse im Agent

Die geschützte Agent-Verwaltung (Port 8098) bietet „Duplikate analysieren“ an.
`POST /api/duplicates` startet einen Scan; ein weiterer Start während eines
laufenden Scans verwendet denselben Auftrag. `GET /api/duplicates` liefert
Status/Fortschritt und nach Abschluss das Ergebnis, seitenweise mit `start` und
`limit` (Standard 50, maximal 100 Gruppen). Die Daten werden nicht gecacht (`no-store`)
und bleiben im Agent-Arbeitsspeicher bis zum nächsten Scan oder Neustart.

Der Agent liest die für seinen Jellyfin-Benutzer sichtbaren Bibliotheken direkt,
einschließlich in Watchparty ausgeschlossener Bibliotheken. Ausgeschlossene
Quellen sind im Ergebnis markiert. Pro Bibliothek werden alle Seiten à 500
Einträge gelesen. Wiederholte Seiten, Netzwerkfehler (30 Sekunden Timeout pro
Anfrage) und mehr als 100.000 gelesene Einträge brechen den Scan mit Fehler ab;
ein Teilergebnis wird nicht als vollständige Analyse ausgegeben.

Filme verwenden dieselben Regeln wie der Relay; die identische Hilfsdatei wird
für die getrennten Docker-/Executable-Builds in beiden Komponenten mitgeführt
und per Test verglichen. Serien werden ebenso über Provider-IDs oder Titel/Jahr
zugeordnet. Episoden benötigen eine passende Serienzuordnung, Staffel, Folgenummer
und denselben Folgenbereich. Ohne ausreichende Metadaten erfolgt kein Vergleich
über Seriengrenzen. Staffel 0 ist gültig; Mehrfachfolgen werden von Einzelfolgen
getrennt gehalten. Bereits vorhandene Jellyfin-MediaSources werden einzeln
aufgelistet, wiederholte Source-IDs innerhalb eines Items entfernt.

Das Ergebnis zeigt Quelldateipfade ausschließlich in der geschützten
Agent-Verwaltung, dazu Qualität, Laufzeit, Bibliothek, Audio-/Untertitelspuren
mit ihren jeweiligen Indizes und `syncStatus: unverified`. Es handelt sich um
eine Metadatenanalyse ohne Lesen oder Verändern der Mediendateien. Gleiche
Qualität bedeutet nicht gleiche Datei oder gleiche Zeitachse.

## Umgesetzt: hochwertige Quelle und begrenzte Übertragung

Die bisherige feste Gruppen-ID bleibt für Kacheln, Bilder, Merkliste und Details
erhalten. Beim Start bei Position 0 sucht der Relay innerhalb dieser Filmgruppe
die höchste verfügbare Auflösung für denselben Titel ohne Qualitätssuffix.
Ein anders benannter Schnitt (z. B. Extended) wird dabei nicht automatisch
gewählt. Es werden nur Kandidaten berücksichtigt, die der auswählende Benutzer
und alle aktuell verbundenen Raumteilnehmer sehen dürfen. Scheitert diese
zusätzliche Suche, bleibt der ausdrücklich gewählte Titel der Rückfall.
Die Suche nutzt die vorhandenen Bibliotheks-Caches; die vollständigen Quelldetails
werden separat 60 Sekunden gecacht.

Innerhalb eines Jellyfin-Items wird ebenfalls die höchste MediaSource-Auflösung
gewählt; bei gleicher Auflösung die niedrigere bekannte Bitrate, danach die ID.
Die echten Videomaße haben Vorrang vor Qualitätsnamen, mit Berücksichtigung von
beschnittenem Breitbild (1920 × 800 bleibt Full HD). Bei fehlenden Maßen helfen
die vorhandenen Qualitätssuffixe. Audio-/Untertitelindizes, Laufzeit, Codec und
Direct-Play-Eignung stammen aus dieser konkreten Quelle.

Der Raum veröffentlicht die gewählte Item-ID UND MediaSource-ID. Web, Desktop
und native Fire-TV-App fordern die Details dieser Quelle an und behalten sie
auch bei einer Änderung der Übertragungsqualität. Der Relay validiert, dass eine
angeforderte Quelle zum Item gehört. Ein erneuter Ladeauftrag verdrängt eine
ältere, noch laufende Quellensuche. Bei einer alternativen MediaSource werden
keine ungeprüften Intro-/Abspannmarker der ersten Quelle übernommen.

Beim Fortsetzen ab einer Position größer 0 wird KEINE andere Datei gewählt.
Neue Verlaufseinträge speichern die MediaSource-ID; ohne diese Information wird
die früher verwendete erste MediaSource beibehalten. Das vermeidet die Übernahme
eines Zeitstempels auf einen anderen Schnitt, beweist aber keine Gleichheit von
Dateien. Auch innerhalb eines Items können Schnitte verschieden sein: Die neue
Quelle wird deshalb nur beim Start für den gesamten Raum festgelegt.

### Automatisch und manuell

Die angebotene Auflösung hängt von den Bildmaßen ab, unabhängig davon, ob ein
1080p-Encode 4, 8 oder 30 Mbit/s benötigt. Die angebotenen Transcode-Stufen sind
Obergrenzen der Ausgabe; eine niedrige Quellbitrate blendet Full HD nicht mehr aus.
Es wird nicht über die tatsächlichen Quellmaße hochskaliert. Gruppen- und
Serverlimits können die Ausgabeauflösung weiterhin begrenzen.

„Automatisch“ ist die Voreinstellung für neue Clients und startet mit höchstens
`AUTO_MAX_MBPS` (Relay, Standard 10 Mbit/s). Eine kompatible Originaldatei innerhalb
dieses Budgets benötigt kein Video-Transcoding. Sonst fordert der Client eine
passende HLS-Stufe an; passende H.264-Dateien dürfen unterhalb der Grenze auch
nur umgepackt werden. Eine höhere Auflösung, ein anderes Codec-Profil, HDR oder
Bilduntertitel können Video-Transcoding in Jellyfin erfordern. Bei ursprünglichen
Direct-Play-Fehlern fällt der native TV-Client auf die begrenzte Transcode-Stufe
zurück. Bestehende manuelle Qualitätseinstellungen bleiben erhalten.

Nach mindestens zwölf Sekunden fortlaufendem Puffern in einem laufenden Film
senkt „Automatisch“ die Übertragungsstufe ab, frühestens 30 Sekunden nach der
letzten Absenkung. Pausen lösen keine Absenkung aus; die JS-Clients berücksichtigen
auch Such-/Spulvorgänge. Der Client lädt dieselbe Quelle neu und folgt danach
wieder der aktuellen Raumposition. Es gibt keine automatische Höherstufung
während desselben Films und keine Garantie eines unterbrechungsfreien Wechsels.
Eine manuell gewählte Stufe wird nicht automatisch geändert.

Das harte Budget ist das Minimum aus Gruppenlimit, optionalem `STREAM_MAX_MBPS`
(Relay, 0 = kein zusätzliches Limit) und 80 % des gemeldeten `MAX_UPLOAD_MBPS`
eines aktualisierten Agents. Originaldateien oberhalb dieses Budgets werden
nicht angeboten und bei direkten HTTP-Anfragen abgewiesen; unbekannte Bitrate
nutzt eine begrenzte HLS-Ausgabe. Auch nachgelagerte HLS-Playlist-Anfragen werden
begrenzt. Unter 0,5 Mbit/s verfügbarem Budget wird ein ausdrücklicher Fehler
zurückgegeben. Die zusätzlichen 20 % lassen Luft für Schwankungen und andere
Anfragen; sie sind keine Messung der tatsächlichen Client-Verbindung.

Beispiel: Ein 60-Mbit/s-UHD-Film bleibt die gemeinsame Quelle. Bei Auto-Budget
10 Mbit/s wird daraus Full HD mit begrenzter Bitrate, mit kleinerem Budget eine
entsprechend niedrigere Stufe. Ein 8-Mbit/s-Full-HD-MP4 kann dagegen direkt laufen.
Bei 15 Mbit/s Agent-Upload beträgt die zusätzliche Obergrenze 12 Mbit/s.
Für die automatische 4K-Stufe muss das Auto-Budget mindestens 40 Mbit/s sein und
das Gruppen-/Server-/Agentbudget dies erlauben.

Jellyfin übernimmt das eigentliche Transcoding auf dem Heimserver. Insbesondere
UHD/HDR nach H.264 benötigt geeignete Hardwarebeschleunigung und gegebenenfalls
Tone Mapping in Jellyfin. Der Agent führt kein eigenes Re-Encoding aus; seine
bestehende Token-Drossel regelt den Gesamt-Upload. Gleiche Ausgabevarianten teilen
wie bisher einen Relay-Cache. Mehrere verschiedene Filme/Spuren/Qualitäten teilen
sich die Gesamtleitung und können zusammen das verfügbare Budget überschreiten;
die automatische Absenkung reagiert dann auf die jeweiligen Pufferprobleme.
Es gibt noch keine zentrale Aufteilung des Gesamtbudgets über alle aktiven Varianten.

Jellyfin-Dokumentation zu [Transcoding](https://jellyfin.org/docs/general/post-install/transcoding/)
und [Hardwarebeschleunigung](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/).

## Vorschlag: Film → Schnitt/Zeitachse → Quelldatei → Spuren

Ein Film ist die Einheit für Poster, Merkliste und Bewertung. Ein Schnitt hat
eine eigene Zeitachse. Eine Quelldatei hat eine Jellyfin-Item-ID UND MediaSource-ID,
Qualität, Codec, HDR, Bildrate, Laufzeit und eigene Audio-/Untertitelspuren.
Qualität allein identifiziert eine Quelle nicht: zwei 1080p-Blu-rays können
unterschiedliche Sprachen, Untertitel oder Schnittfassungen enthalten.

Jellyfin unterstützt selbst mehrere Versionen über Dateinamen innerhalb eines
Filmordners. Diese Gruppierung hilft bei der Identität, belegt aber keine
Synchronität: https://jellyfin.org/docs/general/server/media/movies/

### Synchronitätsklassen

1. **Verifiziert gleiche Zeitachse:** dieselbe Szene liegt zu jedem Zeitpunkt
   an derselben Position. Auflösungen und Encodings können verschieden sein.
   Quellenwechsel darf die kanonische Position übernehmen.
2. **Verifizierter fester Versatz:** z. B. zusätzliches Studio-Logo am Anfang.
   Pro Quelle gilt `Quellzeit = Raumzeit + Offset`; auch gemeldete Positionen,
   Kapitel und Untertitel müssen zurückgerechnet werden. Bereiche außerhalb
   der gemeinsamen Zeitachse sind nicht austauschbar.
3. **Unterschiedliche Geschwindigkeit:** etwa mögliche 25-fps-DVD-Beschleunigung.
   Gleiche Frame-Nummer ist dann nicht gleiche Zeit. Für gemischte Wiedergabe
   wären verifizierte affine Zeitabbildung UND passende Playback-Geschwindigkeit
   inklusive Ton nötig. In der ersten Player-Version sperren.
4. **Andere Schnitte oder unbekannte Zuordnung:** Extended, Director's Cut,
   entfernte Szenen oder nur vermeintlich gleiche Blu-rays. Keine lokale
   Umschaltung während synchroner Wiedergabe. Ein bewusster Schnittwechsel
   lädt für den gesamten Raum neu; standardmäßig am Anfang des neuen Schnitts.

Weder gleiche Laufzeit noch gleiche Bildrate, Titel, Provider-ID oder die
Bezeichnung „Blu-ray“ beweisen eine gleiche Zeitachse. Erst eine explizite
Prüfung darf Quellen freischalten: zunächst manuelle Bestätigung mit mehreren
Kontrollpunkten über den gesamten Film, später Analyse mit Bild-/Audio-Fingerprints
und Erkennung von Versatz, Geschwindigkeitsänderungen und fehlenden Szenen.
Einige übereinstimmende Kontrollpunkte allein sind noch kein Beweis für den
gesamten Film. Nicht verifizierte Quellen bleiben im selben Film sichtbar,
aber für gemischte synchrone Wiedergabe gesperrt.

### Quellenwechsel im laufenden Raum

Der Raum enthält Film-ID, Zeitachsen-ID, kanonische Position, Play/Pause,
Serverzeitanker und eine steigende Revision. Jeder Client hat seine gewählte
Quelle und die dazu geprüfte Zeitabbildung. Der erste Ausbau erlaubt ausschließlich
verifiziert identische Zeitachsen; Offsets folgen als separater Schritt.

Beim Wechsel prüft der Relay Zugriff und Zeitachsen-Kompatibilität erneut.
Der Client bereitet die Zielquelle vor, wählt die gewünschten Sprachen anhand
von Sprachcode, Codec, Kanalzahl, Forced-/SDH-Kennzeichnung (nicht anhand alter
Stream-Indizes), sucht die aktuelle Zielposition und meldet erst nach dem
Decoder-Start Bereitschaft und tatsächliche Position. Während des Ladens
veraltete Wechsel-/Seek-Antworten werden über Revision und lokale Lade-ID verworfen.
Bei Fehlern bleibt die alte Quelle aktiv bzw. wird kontrolliert wiederhergestellt.
Ein Timeout verhindert einen dauerhaft blockierten Raum.

Auf dem jetzigen Browser-/WebView-/mpv-Aufbau bedeutet eine andere Quelldatei
gewöhnlich einen neuen Stream und Decoderstart. Deshalb zunächst eine kurze,
koordinierte Pause mit anschließendem gemeinsamen Start vorsehen. Den Wiedereinstieg
an der dann aktuellen Raumposition berechnen, nicht an der Position beim ersten
Klick. Einen garantiert unterbrechungsfreien Wechsel erst zusagen, wenn dies mit
vorbereiteten Streams auf realen Fire-TV-Geräten und den Desktop-Playern nachgewiesen
ist. Bandbreitenstufen derselben Quelle und Wechsel der Quelldatei sind getrennte
Funktionen im UI und Protokoll.

### Sprachen und Untertitel aus anderen Dateien

Im ersten Ausbau ausschließlich Spuren der gewählten Quelle anbieten. Fehlt die
gewünschte Sprache, eine kompatible Quelldatei auswählen. Audio aus Datei B einfach
mit Video aus Datei A zu kombinieren kann zu Versatz oder Drift führen.

Eine dateiübergreifende Spurauswahl erfordert später einen serverseitigen Remux-/
Transcodingpfad mit geprüfter Zeitabbildung, gemeinsamem Zeitstempelursprung und
korrektem Seek-Verhalten. Untertitel brauchen ebenfalls Offset-/Zeitabbildung;
Bitmap-Untertitel zusätzlich einen passenden Client oder Burn-in. Die Raumquelle ist inzwischen über Item- und MediaSource-ID festgelegt. Für
eine solche UI braucht es zusätzlich den beschriebenen serverseitigen Spurenpfad. Cache-Schlüssel müssen Quell-ID, MediaSource,
Audio-/Untertitelwahl und gegebenenfalls Zeitabbildungsrevision enthalten.

## Reihenfolge und Abnahme für den Player-Ausbau

1. Persistente Filmgruppen, manuelle Korrektur und Quellenübersicht mit Schnitt,
   Qualität, Sprachen und Verifizierungsstatus. Verlauf/Bewertungen/Merkliste
   bewusst auf Filmgruppen migrieren; Wiedergabefortschritt pro Zeitachse erhalten.
2. Explizite Quellenauswahl vor Start; Source-ID durch Details, Stream-Endpunkte,
   Autorisierung, Cache und Clients durchreichen. Ungültige Source-/Item-Paare ablehnen.
3. Verifiziert identische Quellen lokal wechseln, Lade-/Seek-Revisionen, Timeout,
   Rückfall und synchronen Neustart umsetzen. Andere Schnitte sperren.
4. Erst danach Offsets und dateiübergreifende Spuren untersuchen.

Pflichttests: SD/1080p/UHD gleicher Zeitachse, zwei 1080p-Dateien mit anderen
Sprachen/Indizes, Extended Cut, Studio-Logo-Versatz, DVD-Geschwindigkeitsunterschied,
verlorene Verbindung, langsames Laden, rasche Wechsel plus gleichzeitiger Seek,
fehlende Quellen und entzogenes Zugriffsrecht. Auf Fire TV und Desktop Anfang,
Mitte und Ende mit tatsächlichen Bild-/Tonpositionen prüfen; Positionsmeldungen
allein belegen keine wahrgenommene Synchronität.
