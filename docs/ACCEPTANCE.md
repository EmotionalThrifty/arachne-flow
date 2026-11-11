# Arachne Flow — lokale Abnahme

Die folgenden lokalen Daten-/UI-Tests benötigen keine externen Modell- oder Provideraufrufe und ändern keine Hermes-Konfiguration. Die beiden lokalen Vorlagen gehören zu den 12 mitgelieferten Vorlagen. Persönliche Demo-Flows sind keine Voraussetzung. Externe Modellaufrufe und echter Nachrichtenversand sind nicht Teil dieser Offline-Abnahme und müssen vom jeweiligen Nutzer bewusst freigegeben werden.

## 1. Listen-Pipeline (30 Sekunden)

In **Flows → Local list cleanup** eine neue Kopie öffnen und **Run** drücken.

Erwartung: Der Result-Node zeigt `alpha | 雪 | false | 0`. Leere Einträge und Duplikate verschwinden; `false` und `0` bleiben erhalten. Im Palette-Katalog stehen JSON, Build object, Set field, Split text, Join list, Filter list und Deduplicate bereit.

## 2. JSON-Editor (60 Sekunden)

Den JSON-Input auswählen. Im Inspector erst `{"broken":}` eingeben: Es erscheint eine Fehlermeldung; **Format JSON** ist deaktiviert. Dann `{"id":9007199254740993,"decimal":1.000000000000000000001,"text":"雪"}` eingeben und **Format JSON** drücken.

Erwartung: Beide Zahlentexte bleiben unverändert; ausschließlich Leerraum wird formatiert. Vor dem erneuten Ausführen der Listen-Vorlage wieder deren JSON-Liste einsetzen oder eine neue Vorlagenkopie öffnen. Backend-JSON akzeptiert Objekte, Listen, null, false, Zahlen und Strings; die Formatierung ist keine Zusage, dass jede spätere JSON-Bibliothek Dezimallexeme erhält.

## 3. Sichere Markdown-Vorschau (60 Sekunden)

Einen Text-Node hinzufügen und im Inspector Text mit einer `# Überschrift`, Listeneinträgen und einem Codeblock eingeben. **Preview Markdown** und danach **Edit** wählen.

Erwartung: Überschriften, Listen und Code werden dargestellt; der Quelltext bleibt erhalten. HTML wird als Text behandelt. Bilder werden nicht geladen. Nur explizite http/https-Links sind anklickbar. Die Vorschau ist ein begrenzter Markdown-Teilumfang, kein vollständiger CommonMark-Renderer; ab 256 Ki Zeichen oder 5.000 Zeilen wird die Kürzung angezeigt.

## 4. Tatsächliche Eingänge und Schleifen (90 Sekunden)

**Flows → JSON objects through a loop** öffnen. Beim Node **Build object** im Inspector **Record wired inputs (may contain sensitive data)** einschalten, speichern lassen und ausführen. Danach **View recorded inputs** öffnen und `item 1` bzw. `item 2` wählen.

Erwartung: Die Eingänge stammen aus diesem Run, in numerischer Item-Reihenfolge. `item 1` enthält `title: One` und `url: https://example.test/1`; Item 2 entsprechend Two/2. Der Result-Node enthält beide typisierten Objekte in einer Liste. Alte Runs werden niemals aus den heutigen Node-Einstellungen rekonstruiert; ohne Aufzeichnung steht ausdrücklich „Inputs were not recorded“.

**Datenschutz:** Aufzeichnung ist standardmäßig aus und gilt pro Node. Erfasst werden die tatsächlich verdrahteten Eingänge nach Typumwandlung, nicht rekonstruierte Parameter oder ein komplettes Provider-Request-Envelope. Auch Cache-Hits und fehlgeschlagene ausgeführte Nodes können eine zuvor aktivierte Eingangshistorie besitzen. Die Redaktion vertraulicher Namen, Bearer-Tokens und bekannter URL-Parameter ist nur best effort, keine allgemeine Secret-Erkennung. Keine Secrets für diese Abnahme verwenden. Bereits vorhandene Flow-Parameter und Outputs werden durch diese Funktion nicht nachträglich bereinigt. Historie ist auf 1 MiB pro Node, Tiefe 32, 10.000 Werte je Snapshot und die bestehende Iterationsgrenze begrenzt; ausgelassene/partielle Historie ist gekennzeichnet und bricht den eigentlichen Run nicht ab.

## 5. Automatisierte Prüfung

Python über das Hermes-Runtime-Skript, JavaScript über den Projekt-Loader ausführen:

```bash
bash scripts/check.sh
node tests/js/run.mjs
bash scripts/hpy dev/probe.py
```

`dev/probe.py` ist sequenziell auszuführen und setzt seine eigenen Harness-Testdaten zurück. **Nur in einer isolierten Kopie ohne persönliche Runs verwenden.** Der Checkout wird mit `bash scripts/check.sh` geprüft. Private Export-Werkzeuge sind absichtlich nicht enthalten. Ein erfolgreiches lokales Gate ist weder eine Katalogzulassung noch ein vollständiger Live-Desktop-/Providernachweis.

### Datei-Anhang ohne Versand prüfen (60 Sekunden)

Im **Send message**-Node einen synthetischen Empfänger wählen und den separaten Button **Enable text and file sending** betätigen. Der Inspector muss ausdrücklich Text **und Dateien** nennen. Im isolierten Harness wurde geprüft, dass der Attachment-Port eine Datei erhält und der Fake-Host exakt einen `MEDIA:`-Aufruf sieht; die automatisierte Abnahme ist kein Plattformnachweis. Ein Nutzer bestätigte am 10.11.2026 separat den erfolgreichen Datei-Versand. Für einen realen Flow muss der Nutzer die zusätzliche Dateifreigabe selbst setzen. Nur Dateien aus dem Ausgabeordner des aktuellen Runs und unterstützte Dateiendungen sind zulässig; die Plattform kann zusätzlich einschränken. `Message` ist eine optionale Textbeschreibung, **Attachment** trägt die Datei. **Für diesen UI-Test nicht Run drücken.**

### Send message ohne Versand prüfen (60 Sekunden)

In einem neuen, nicht laufenden Flow nach **Send message** suchen und den Node auswählen. Ohne Aktivierung darf er nicht senden. Die Empfängerauswahl darf keine Modell-Fehlermeldung anzeigen; interne Token-/Autorisierungsfelder dürfen nicht im Inspector stehen. Für eine Aktivierung muss der Benutzer selbst ein echtes Ziel ausdrücklich wählen. Eine Änderung dieses Ziels muss die Freigabe ausschalten. **Für diesen UI-Test nicht Run drücken.** Bereits laufende externe Aufrufe lassen sich durch Deaktivieren nicht zurückrufen. Bei Timeout nicht automatisch neu ausführen.

Wird noch alter Plugin-Code angezeigt, Hermes regulär neu starten und Arachne Flow erneut öffnen. Es werden keine Core-Änderungen oder Änderungen an der Hermes-Konfiguration benötigt.

## Grenzen

- `Send message`: Freigabe-, Restore-, Widerrufs- und Antwortfehler sind korrigiert und mit synthetischen Hosts geprüft. Ein Nutzer bestätigte separat den erfolgreichen Datei-Versand. Jede weitere reale Sendung braucht eine konkrete Freigabe; dies ist kein Nachweis für alle Plattformen und Fehlerfälle. Siehe `GATEWAY-SEND-BLOCKER.md`.
- Raw im Viewer erhält die Serverantwort. Bei expandierten Spill-Markern kann bereits der Server JSON-Zahlen und Formatierung normalisiert haben; die UI weist darauf hin. Tree/Formatted können zusätzlich durch JavaScript-Zahlen runden.
- Screenshots und Browserinteraktionen wurden gegen die echte Plugin-Oberfläche im isolierten Desktop-Shell-Harness geprüft, nicht gegen persönliche Flows in der laufenden Hermes-Installation.
- Kein Commit, Push, Release, Installer-Aufruf oder Neustart ist Bestandteil dieser Abnahme.
