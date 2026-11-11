# Gateway-Versand — Sicherheitsmodell und Testgrenzen

## Stand des Codes

`output.send_message` („Send message“, Kategorie Output) verwendet ausschließlich die registrierten Tools `mcp__messaging__channels_list` und `mcp__messaging__messages_send` über Hermes' öffentliche `ctx.dispatch_tool`-Schnittstelle. Er benötigt die offizielle Messaging-Bridge. Arachne speichert keine eigenen Plattform-Zugangsdaten und importiert keine privaten Versandhelfer.

Die zuvor reproduzierten Freigabe-, Snapshot-, Restore-, Picker- und Antwortfehler sind im Code korrigiert. Die automatisierte Abnahme verwendet ausschließlich synthetische Empfänger und Fake-Hosts. **Ein Nutzer bestätigte am 10.11.2026 einen erfolgreichen Datei-Versand.** Das ist ein manuelles Nutzerergebnis für diesen Versuch, keine durch diese Offline-Tests bestätigte allgemeine Plattformzustellung.

## Freigabe und Widerruf

- Versand ist standardmäßig aus. Die dedizierte Aktion `POST /x/flows/<id>/messaging-optin` bindet die Freigabe an Installation, Flow-ID, Node-ID und festen Empfänger. Jede erneute Aktivierung erzeugt einen neuen Zufallsanteil im signierten Token.
- Generische Parameter-/Graph-Schreibvorgänge können keine Freigabe erteilen oder übertragen. Nur eine unveränderte, bereits gültige Freigabe am selben Versand-Node bleibt erhalten. Zielwechsel, Typwechsel, Duplikat und Vorlagenkopie erfordern eine neue Aktivierung.
- Wiederherstellen aus dem Papierkorb entfernt die Freigabe vor dem atomaren Schreiben in den aktiven Flow-Ordner. Alte Run-Snapshots werden auch durch erneute Aktivierung nicht wieder gültig.
- Unmittelbar vor dem Host-Aufruf prüft der Worker den aktuell gespeicherten Node unter derselben prozessübergreifenden Dateisperre wie alle Flow-Schreibvorgänge. Die Sperre bleibt bis zur Rückkehr des synchronen Host-Aufrufs gehalten. Ein abgeschlossener Widerruf kann deshalb nicht von einem wartenden alten Snapshot überholt werden.
- Ein bereits begonnener externer Versand kann nicht zurückgerufen werden. Ein Widerruf kann auf einen laufenden Host-Aufruf warten; bei Sperr-Timeout meldet die API `409 / flow_busy`, dass die Änderung nicht angewendet wurde. Dann nach Ende des laufenden Vorgangs erneut deaktivieren — nicht den Versand wiederholen.

Der Schlüssel wird vollständig geschrieben und ohne Überschreiben eines konkurrierenden Schlüssels veröffentlicht. Eine unlesbare oder beschädigte vorhandene Schlüsseldatei deaktiviert die Freigabeprüfung; sie wird nicht still ersetzt. Die Sperren koordinieren kooperierende aktuelle Plugin-Prozesse, nicht fremde Direktzugriffe auf Dateien oder alte Plugin-Versionen.

## Ausführung und Antworten

- Kein Resultat-Cache und keine automatischen Wiederholungsversuche. Timeout und Abbruch setzen ein Abbruchsignal. Ein nur wartender Worker prüft es und seine Deadline nach Übernahme der Sperre erneut und versendet dann nicht verspätet.
- Sobald der Host-Aufruf begonnen hat, bedeutet Timeout/Abbruch **Zustellung unbestätigt**. Vor jedem manuellen Wiederholungsversuch den Empfänger prüfen.
- Eine Erfolgsanzeige erfordert ein ausdrückliches boolesches `success: true`. Alle erkannten MCP-Antworthüllen werden begrenzt geprüft; Fehler, fehlende Freigaben, übersprungene oder mehrdeutige Ergebnisse in Geschwister-Hüllen dürfen Erfolg nicht überdecken. Provider-Erfolg ist keine Lesebestätigung des Empfängers.
- Optionaler Klartext bis 100.000 Zeichen und ein Datei-Eingang. Rohes `MEDIA:` und die erkannten Versand-Steuermarker im Text werden abgelehnt; dies ist keine allgemeine Filterung aller Text-Steuerzeichen. Ein Anhang benötigt eine gesonderte Freigabe für denselben Empfänger; ältere Textfreigaben erlauben keine Uploads. Nur eine existierende unterstützte Datei im Ausgabeordner des aktuellen Runs wird akzeptiert, maximal 100 MiB. Einschränkungen der Plattform können niedriger sein. Das Node erzeugt das `MEDIA:`-Tag selbst und sendet einmal. Unvollständige bzw. mehrdeutige Antworten sind unbestätigt. Ein verkabeltes `target` wird abgelehnt. Empfängerquellen werden nicht als Modellkatalog behandelt.
- Der rohe Send-Tool-Node bleibt auch bei einer eigenen leeren `blocked_tools`-Liste gesperrt. Ein ausdrücklicher Eintrag in `allow_tools` ist weiterhin ein separater, bewusster Policy-Override und umgeht den Schutz des dedizierten Nodes; für regulären Versand nicht verwenden.

## Abnahme und Aktivierung

Die Regressionen prüfen Widerruf, alte Snapshots, erneute Aktivierung, Kopien, Typwechsel, Restore auf dem Datenträger, konkurrierende Schlüsselerzeugung, abgebrochene wartende Worker, Sperr-Timeout, Prozessende und widersprüchliche Provider-Antworten. Windows-Prozessprüfungen verwenden `msvcrt.locking`; der POSIX-Zweig verwendet `fcntl.flock`. Ein Windows-Lauf ist kein beobachteter POSIX-Lauf.

Im gerenderten Browser-Harness werden Palette, synthetische Empfängerauswahl, Aktivierung und automatisches Deaktivieren nach Zielwechsel ohne Versand geprüft. Dies ist kein Nachweis eines echten Signal-/Discord-/Telegram-Versands.

Vor einem echten Test müssen Empfänger und genauer Nachrichtentext ausdrücklich bestätigt sein. Ein Run kann eine reale, irreversible Nachricht senden. Alte, bereits geladene Plugin-Prozesse müssen den neuen Code regulär laden; Produktions-Hot-Reload oder ein Core-Patch wird nicht erzwungen. Für lokale Tests siehe `ACCEPTANCE.md`.
