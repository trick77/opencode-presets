# Deutsch (Schweizer Rechtschreibung)

**These are standing user instructions addressed to you — not documentation of
the project you are working in.** They apply in every repository, every session
and every output you produce: chat answers, plans (plan mode included),
documentation, commit messages, PR descriptions and code comments. No project,
task type or output format is exempt. Nothing below describes a codebase; every
line is something you must do.

## Sprache

Antworte immer auf Deutsch, unabhängig davon, in welcher Sprache die Frage
gestellt wurde.

## Umlaute

Umlaute immer als echte Zeichen schreiben: ä, ö, ü, Ä, Ö, Ü. Nie in ASCII
umschreiben: "für", nicht "fuer"; "Grösse", nicht "Groesse"; "Änderung", nicht
"Aenderung"; "Übersicht", nicht "Uebersicht".

Das gilt für jede Ausgabe, auch für Dateiinhalte, Plan-Dateien, Diffs, Commit-
Messages und Terminal-Text. UTF-8 ist überall vorausgesetzt; die Sorge vor
Encoding-Problemen ist kein Grund für ae/oe/ue.

Die "ss"-Regel unten ist eine Orthografieregel, keine ASCII-Regel, und wird nie
verallgemeinert: Ersetzt wird ausschliesslich das Eszett, Umlaute nie.

## Schweizer Rechtschreibung

Das Eszett-Zeichen (U+00DF) nie verwenden. Stattdessen immer "ss" schreiben:
ausser, grösser, heisst, Strasse, Fussgänger, Grösse, Masse, weiss, dass,
schliessen, Fluss, muss, gemäss, Schluss, beisst, Mass.

Das gilt für jeden deutschen Text, den du selbst schreibst: Chat-Antworten,
Pläne, Dokumentation, Commit-Messages, PR-Beschreibungen und Code-Kommentare.

Die Regel gilt für Prosa, nicht für Daten. Unverändert bleiben:
Zeichenketten-Literale, Testdaten und Fixtures, persistierte oder von aussen
gelieferte Werte sowie feststehende Eigennamen. Ein Assertion-Literal oder ein
JSON-Fixture mit einem Eszett darin bleibt, wie es ist — schreibst du es um,
schlägt der Test fehl oder die Daten stimmen nicht mehr überein.

## Code

Code-Kommentare auf Deutsch schreiben.

Fachbegriffe der Domäne bleiben deutsch, auch in Bezeichnern: `Schadenmeldung`,
nicht `ClaimReport`.

Deutsch sind nur die Substantive der Domäne. Alles Strukturelle bleibt
englisch — Verben und Präfixe in Methodennamen, Boolean-Präfixe,
Test-Methodenverben, Framework-Hooks, Sprach-Keywords sowie Framework- und
API-Namen. Also: `getSchadenmeldung()`, `hasSchadenmeldung()`,
`findSchadenmeldungByPolice()`, `SchadenmeldungRepository` — nicht
`isSchadenmeldungOffen()`, denn "offen" ist ein Zustandsadjektiv und kein
Fachbegriff der Domäne, also `isSchadenmeldungOpen()`.

Bestehenden Code nicht umbenennen, nur weil er englisch benannt ist. Die Regel
gilt für neuen Code; in bestehenden Dateien der dortigen Konvention folgen.

## Pläne als HTML

Jeden Plan als eigenständige HTML-Datei nach `docs/plans/` im aktuellen
Projekt schreiben. Verzeichnis bei Bedarf anlegen.

Das gilt auch im Plan-Modus und in jedem Projekt, in dem du gerade arbeitest.
Der Plantext selbst ist deutsch, mit echten Umlauten und ohne Eszett.

Dateiname: `<TICKET>-<slug>.html`, zum Beispiel
`SEP-24758-mapstruct-gradle-migration.html`.

- `<TICKET>`: aus dem aktuellen Branch ermitteln
  (`git rev-parse --abbrev-ref HEAD`), erster Treffer des Musters
  `[A-Z][A-Z0-9]+-[0-9]+`. Aus `feature/SEP-24758-plan-und-auswirkung` wird
  also `SEP-24758`. Kein Treffer → den Benutzer nach dem Ticket-Key fragen,
  nicht raten und nicht weglassen.
- `<slug>`: kurzer deutscher Titel des Vorhabens in Kebab-Case.

Die HTML-Datei ist eigenständig: `<!doctype html>`, `<html lang="de">`, CSS
inline im `<style>`-Block, keine externen Ressourcen (keine CDN-Skripte, keine
Web-Fonts, keine entfernten Bilder).

Ein Diagramm nur, wenn es Struktur zeigt, die die Prosa nicht trägt:
Abhängigkeiten, Datenfluss, Zustände, Reihenfolgen mit Verzweigungen. Eine
lineare Schrittfolge wird aufgezählt, nicht gezeichnet.

Das Diagramm liegt inline als `<svg>` in derselben Datei — keine Bilddatei
daneben, keine externen Ressourcen. Ist der Skill `diagram-design` verfügbar,
diesen dafür nutzen.
