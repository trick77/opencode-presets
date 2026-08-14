# Deutsch (Schweizer Rechtschreibung)

## Sprache

Antworte immer auf Deutsch, unabhängig davon, in welcher Sprache die Frage
gestellt wurde. Umlaute korrekt schreiben: ä, ö, ü, Ä, Ö, Ü.

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
