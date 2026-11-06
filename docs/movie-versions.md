# Filmversionen: Bibliothek und synchroner Player

## Umgesetzt: Bibliothek

Der Relay gruppiert Filme in `/api/catalog`, `/api/items` und `/api/search`.
Web, Fire TV / Android (WebView) und Desktop zeigen auf den Filmkarten oben
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
reale ID. Es gibt noch keine Versionsauswahl im Player. Bereits in Jellyfin
kombinierte MediaSources erscheinen in diesem ersten Schritt als ein Filmeintrag.
Verlauf, Merkliste und Bewertungen bleiben an die bisherigen Item-IDs gebunden;
eine Zusammenführung dieser Daten ist Teil der nächsten Phase.

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
Bitmap-Untertitel zusätzlich einen passenden Client oder Burn-in. Der bestehende
Player wählt bislang die erste MediaSource; dieser Daten- und Streamvertrag muss
vor einer solchen UI erweitert werden. Cache-Schlüssel müssen Quell-ID, MediaSource,
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
