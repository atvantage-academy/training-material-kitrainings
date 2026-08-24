#!/usr/bin/env ruby
# =============================================================================
# Prüft die Konfiguration und das Front Matter einer Academy-Site gegen die
# JSON-Schemas dieses Verzeichnisses.
#
#   ruby theme/jekyll/schema/validate.rb          # ganzes Repo
#   ruby validate.rb --root . --schemas /tmp/schema/1
#   ruby validate.rb --config _config.yml --config _config.ci.yml
#   ruby validate.rb --self-test                  # nur die Schemas prüfen
#
# WARUM RUBY OHNE GEMS: Das Skript läuft in drei Umgebungen – Doku-Pipeline,
# Schulungs-Pipeline und lokal im Container. Ruby ist überall da (Jekyll), YAML
# und JSON sind Standardbibliothek. Ein zusätzliches Gem (json_schemer) wäre eine
# vierte Sache, die installiert sein muss, damit eine Prüfung überhaupt läuft.
#
# WARUM EIN EIGENER, KLEINER VALIDATOR: Er deckt bewusst nur den Draft-07-Ausschnitt
# ab, den die Schemas verwenden (siehe SCHLUESSELWOERTER). Damit die IDE und diese
# Prüfung nie unterschiedlich urteilen, dürfen die Schemas diesen Ausschnitt NICHT
# verlassen – wer ein weiteres Schlüsselwort braucht, ergänzt es hier mit.
#
# EXIT-CODES:  0 = alles geprüft und in Ordnung
#              1 = Verstöße gefunden (Liste auf stderr)
#              2 = die Prüfung konnte nicht laufen (Schema fehlt, YAML kaputt,
#                  KEINE Seite gefunden). Eine Prüfung über die leere Menge ist
#                  kein Erfolg – sie ist ein Befund.
#
# Schema-Versionen: frontmatter.version.txt und config.version.txt neben dieser Datei.
# JE SCHEMA eine eigene Zaehlung – die beiden entwickeln sich unabhaengig, und eine
# gemeinsame Nummer haette bei jeder Aenderung des einen auch das andere „neu" gemacht.
# =============================================================================
require 'yaml'
require 'json'
require 'date'

SCHLUESSELWOERTER = %w[
  $ref type enum const required properties patternProperties additionalProperties
  items minItems uniqueItems minimum exclusiveMinimum maximum oneOf anyOf allOf
].freeze

# ---------------------------------------------------------------------------
# Validator – Draft-07-Ausschnitt
# ---------------------------------------------------------------------------
class Validator
  def initialize
    @dokumente = {}
  end

  # Schluessel ist der ABSOLUTE Pfad. Damit loest `$ref` relativ zur Datei auf, in
  # der er steht – und der Pruefer versteht beide Ablagen: die flache im Paket
  # (`frontmatter.schema.json` neben `config.schema.json`) und die veroeffentlichte
  # (`schemas/config/1/schema.json` verweist auf `../../frontmatter/1/schema.json`).
  def dokument(datei)
    pfad = File.expand_path(datei)
    @dokumente[pfad] ||= JSON.parse(File.read(pfad))
  end

  # Liefert eine Liste von Meldungen [{zeiger:, text:}].
  def pruefen(wert, schema, datei, zeiger = '')
    return [] if schema == true
    return [{ zeiger: zeiger, text: 'hier ist kein Wert erlaubt' }] if schema == false

    unbekannt = schema.keys - SCHLUESSELWOERTER - %w[$schema $id title description examples definitions default]
    unless unbekannt.empty?
      # Nicht abfangen, sondern melden: ein stillschweigend ignoriertes Schlüsselwort
      # wäre eine Prüfung, die aussieht, als täte sie etwas.
      return [{ zeiger: zeiger, text: "Schema nutzt Schlüsselwörter, die dieser Validator nicht kennt: #{unbekannt.join(', ')} (in #{datei})" }]
    end

    if (ref = schema['$ref'])
      ziel_datei, fragment = ref.split('#', 2)
      ziel_datei = if ziel_datei.nil? || ziel_datei.empty?
                     datei
                   else
                     File.expand_path(ziel_datei, File.dirname(datei))
                   end
      unter = dokument(ziel_datei)
      (fragment || '').split('/').reject(&:empty?).each do |teil|
        unter = unter[teil.gsub('~1', '/').gsub('~0', '~')]
        return [{ zeiger: zeiger, text: "Schema-Referenz #{ref} ist nicht auflösbar" }] if unter.nil?
      end
      rest = schema.reject { |k, _| k == '$ref' }
      return pruefen(wert, unter, ziel_datei, zeiger) + (rest.empty? ? [] : pruefen(wert, rest, datei, zeiger))
    end

    fehler = []

    if (typ = schema['type'])
      erlaubt = Array(typ)
      fehler << { zeiger: zeiger, text: "muss #{erlaubt.map { |t| typname(t) }.join(' oder ')} sein, ist #{typname(typ_von(wert))}" } unless erlaubt.any? { |t| typ_passt?(wert, t) }
      return fehler unless fehler.empty?
    end

    if schema.key?('enum') && !schema['enum'].include?(wert)
      fehler << { zeiger: zeiger, text: "muss einer dieser Werte sein: #{schema['enum'].map(&:inspect).join(', ')} (ist #{wert.inspect})" }
    end
    if schema.key?('const') && schema['const'] != wert
      fehler << { zeiger: zeiger, text: "muss #{schema['const'].inspect} sein (ist #{wert.inspect})" }
    end

    if wert.is_a?(Numeric)
      fehler << { zeiger: zeiger, text: "muss mindestens #{schema['minimum']} sein" } if schema['minimum'] && wert < schema['minimum']
      fehler << { zeiger: zeiger, text: "muss höchstens #{schema['maximum']} sein" } if schema['maximum'] && wert > schema['maximum']
      fehler << { zeiger: zeiger, text: "muss größer als #{schema['exclusiveMinimum']} sein" } if schema['exclusiveMinimum'] && wert <= schema['exclusiveMinimum']
    end

    if wert.is_a?(Hash)
      Array(schema['required']).each do |feld|
        fehler << { zeiger: zeiger, text: "das Feld `#{feld}` fehlt" } unless wert.key?(feld)
      end
      eigenschaften = schema['properties'] || {}
      muster = schema['patternProperties'] || {}
      wert.each do |k, v|
        unter = zeiger + '/' + k.to_s
        if eigenschaften.key?(k)
          fehler += pruefen(v, eigenschaften[k], datei, unter)
          next
        end
        treffer = muster.keys.select { |m| Regexp.new(m).match?(k.to_s) }
        unless treffer.empty?
          treffer.each { |m| fehler += pruefen(v, muster[m], datei, unter) }
          next
        end
        zusatz = schema['additionalProperties']
        next if zusatz.nil? || zusatz == true
        if zusatz == false
          erlaubte = (eigenschaften.keys + muster.keys.map { |m| "Muster #{m}" }).sort
          fehler << { zeiger: unter, text: "unbekanntes Feld `#{k}`#{erlaubte.empty? ? '' : " – erlaubt sind: #{erlaubte.join(', ')}"}" }
        else
          fehler += pruefen(v, zusatz, datei, unter)
        end
      end
    end

    if wert.is_a?(Array)
      fehler << { zeiger: zeiger, text: "braucht mindestens #{schema['minItems']} Eintrag/Einträge" } if schema['minItems'] && wert.size < schema['minItems']
      fehler << { zeiger: zeiger, text: 'enthält doppelte Einträge' } if schema['uniqueItems'] && wert.uniq.size != wert.size
      if (items = schema['items'])
        wert.each_with_index { |v, i| fehler += pruefen(v, items, datei, "#{zeiger}/#{i}") }
      end
    end

    if (liste = schema['oneOf'])
      treffer = liste.count { |s| pruefen(wert, s, datei, zeiger).empty? }
      fehler << { zeiger: zeiger, text: "passt auf keine der erlaubten Formen (#{beschreibungen(liste)})" } if treffer.zero?
      fehler << { zeiger: zeiger, text: 'passt auf mehrere erlaubte Formen – das Schema ist mehrdeutig' } if treffer > 1
    end
    if (liste = schema['anyOf'])
      unless liste.any? { |s| pruefen(wert, s, datei, zeiger).empty? }
        fehler << { zeiger: zeiger, text: "passt auf keine der erlaubten Formen (#{beschreibungen(liste)})" }
      end
    end
    Array(schema['allOf']).each { |s| fehler += pruefen(wert, s, datei, zeiger) }

    fehler
  end

  private

  def beschreibungen(liste)
    liste.map { |s| s['description'] || s['type'] || (s['required'] && "mit #{s['required'].join(', ')}") || s['const'].inspect }.compact.join(' | ')
  end

  def typ_von(wert)
    case wert
    when nil then 'null'
    when true, false then 'boolean'
    when Integer then 'integer'
    when Numeric then 'number'
    when String, Date, Time then 'string'
    when Array then 'array'
    when Hash then 'object'
    else wert.class.to_s
    end
  end

  def typ_passt?(wert, typ)
    case typ
    when 'string'  then wert.is_a?(String) || wert.is_a?(Date) || wert.is_a?(Time)
    when 'integer' then wert.is_a?(Integer)
    when 'number'  then wert.is_a?(Numeric) && !(wert == true || wert == false)
    when 'boolean' then wert == true || wert == false
    when 'array'   then wert.is_a?(Array)
    when 'object'  then wert.is_a?(Hash) || wert.is_a?(Date) || wert.is_a?(Time)
    when 'null'    then wert.nil?
    else true
    end
  end

  def typname(typ)
    { 'string' => 'Text', 'integer' => 'ganze Zahl', 'number' => 'Zahl', 'boolean' => 'Ja/Nein',
      'array' => 'Liste', 'object' => 'Abschnitt', 'null' => 'leer' }[typ] || typ
  end
end

# ---------------------------------------------------------------------------
# Dateien sammeln
# ---------------------------------------------------------------------------
# Immer übersprungen – unabhängig von `exclude`: Build-Ausgaben, Abhängigkeiten
# und das eingebundene Theme selbst (dessen Markdown gehört nicht zur Site).
#
# NUR AUF OBERSTER EBENE, und das ist wesentlich: `theme` als beliebiges Segment
# hätte auch `docs/theme/academy.md` verschluckt – eine Seite, die es zu prüfen
# gibt. Eine Auswahl, die stillschweigend Seiten auslässt, sieht aus wie eine
# bestandene Prüfung und ist keine.
IMMER_AUS = %w[theme dist vendor _site].freeze

def uebersprungen?(rel, ausschluss)
  teile = rel.split('/')
  return true if teile.any? { |t| t.start_with?('.') }
  return true if teile.include?('node_modules')
  return true if IMMER_AUS.include?(teile.first) || teile.first.start_with?('_site')
  # Jekyll rendert `_`-Verzeichnisse nicht (Collections ausgenommen – die gibt es
  # in Academy-Repos nicht; käme eine hinzu, gehört sie hier ergänzt).
  return true if teile[0..-2].any? { |t| t.start_with?('_') }
  # Jekylls `exclude`-Semantik: Pfade RELATIV zur Quelle. `README.md` schließt also
  # nur die im Wurzelverzeichnis aus, `**/README.md` alle. Deshalb KEIN Rückfall auf
  # den Dateinamen – der schlösse zu viel aus.
  ausschluss.any? do |muster|
    m = muster.chomp('/')
    rel == m || rel.start_with?(m + '/') || File.fnmatch?(m, rel, File::FNM_PATHNAME)
  end
end

def front_matter(pfad)
  zeilen = File.readlines(pfad, encoding: 'utf-8')
  return [nil, nil] unless zeilen.first && zeilen.first.chomp == '---'
  ende = zeilen[1..].index { |z| %w[--- ...].include?(z.chomp) }
  return [nil, 'Front Matter ist nicht abgeschlossen (es fehlt die zweite `---`-Zeile)'] if ende.nil?
  roh = zeilen[1, ende].join
  daten = YAML.safe_load(roh, permitted_classes: [Date, Time], aliases: true)
  return [nil, nil] if daten.nil?
  return [nil, 'Front Matter ist kein Abschnitt aus Feldern'] unless daten.is_a?(Hash)
  [daten, nil]
rescue Psych::SyntaxError => e
  [nil, "Front Matter ist kein gültiges YAML: #{e.message}"]
end

# Zeilennummer des obersten Feldes eines Zeigers – macht die Meldung anklickbar.
def zeile_von(pfad, zeiger, versatz)
  feld = zeiger.split('/').reject(&:empty?).first
  return nil unless feld
  File.readlines(pfad, encoding: 'utf-8').each_with_index do |z, i|
    return i + 1 if i >= versatz && z =~ /\A#{Regexp.escape(feld)}\s*:/
  end
  nil
end

# ---------------------------------------------------------------------------
# Zielgruppen: deklarierte Werte gegen benutzte Werte
# ---------------------------------------------------------------------------
# WARUM DAS HIER STEHT UND NICHT IM SCHEMA: Welche Zielgruppen es gibt, ist keine
# Festlegung des Themes, sondern des Werkzeugs, das die Site baut. Ein `enum` im Schema
# waere der falsche Ort – wer eine dritte Zielgruppe braucht, muesste das THEME aendern.
#
# Ein blosses `type: string` wuerde die Pruefung aber verlieren: `audience: lerner`
# (Tippfehler) faellt dann nirgends auf, und die Seite landet stillschweigend in JEDEM
# Build. Deshalb deklariert die Site ihre Zielgruppen in `audiences`, und hier wird
# dagegen geprueft. Die Werte kommen aus der Site, die Pruefung bleibt.
#
# WER `audience` OHNE `audiences` BENUTZT, bekommt einen Fehler – nicht ein Achselzucken.
# Das ist der ganze Zweck: Eine Angabe ohne pruefbare Menge ist eine Vermutung.
def zielgruppen_pruefen(daten, deklariert, quelle, pfad = [])
  meldungen = []
  case daten
  when Hash
    daten.each do |k, v|
      # `audiences` auf der WURZEL einer Konfiguration ist die Deklaration selbst, keine
      # Verwendung – sonst pruefte sie sich gegen sich.
      deklaration = k == 'audiences' && pfad.empty?
      benutzt = !deklaration && (k == 'audiences' || (k == 'audience' && v.is_a?(String)))
      if benutzt
        voll = (pfad + [k.to_s]).join('.')
        Array(v).each do |wert|
          next unless wert.is_a?(String)
          if deklariert.nil? || deklariert.empty?
            meldungen << [voll, "Zielgruppe `#{wert}` benutzt, aber die Site deklariert keine " \
                                '`audiences`. Ohne Deklaration ist der Wert nicht prüfbar – ' \
                                'ein Tippfehler fiele nirgends auf.']
          elsif !deklariert.include?(wert)
            meldungen << [voll, "`#{wert}` ist keine deklarierte Zielgruppe. Deklariert sind: " \
                                "#{deklariert.join(', ')} (Schlüssel `audiences` in der _config.yml)."]
          end
        end
      else
        meldungen += zielgruppen_pruefen(v, deklariert, quelle, pfad + [k.to_s])
      end
    end
  when Array
    daten.each_with_index { |v, i| meldungen += zielgruppen_pruefen(v, deklariert, quelle, pfad + [i.to_s]) }
  end
  meldungen
end

# ---------------------------------------------------------------------------
# Selbsttest der Schemas
# ---------------------------------------------------------------------------
# Prüft die Schemas selbst, nicht die Site: gültiges JSON, KEIN Schlüsselwort
# außerhalb von SCHLUESSELWOERTER, und jede `$ref` auflösbar.
#
# Warum das eine eigene Prüfung ist: Ein Schlüsselwort, das dieser Validator nicht
# kennt (etwa `pattern`), fällt sonst erst auf, wenn eine Seite den betroffenen
# Zweig überhaupt erreicht – bis dahin urteilen IDE und Pipeline verschieden.
def selbsttest(pfade)
  fehler = []
  bekannt = SCHLUESSELWOERTER + %w[$schema $id title description examples definitions default]

  # Schluessel ist der Dateiname, wie ihn ein `$ref` schreibt – so bleibt die
  # Referenzpruefung unabhaengig davon, wo die Dateien liegen.
  dokumente = {}
  namen = {}
  pfade.each do |rolle, pfad|
    name = File.basename(pfad)
    namen[rolle] = name
    begin
      dokumente[name] = JSON.parse(File.read(pfad))
    rescue JSON::ParserError => e
      fehler << "#{name}: kein gültiges JSON – #{e.message}"
    end
  end
  return fehler unless fehler.empty?
  dateien = namen.values

  # Rekursiv durch alle Schema-Knoten. Ein Knoten ist ein Schema, wenn er als
  # Wert an einer Schema-Stelle steht – deshalb wird über die bekannten
  # Container-Schlüssel navigiert statt blind über alle Hashes.
  pruefe = lambda do |knoten, datei, pfad|
    return unless knoten.is_a?(Hash)
    (knoten.keys - bekannt).each do |k|
      fehler << "#{datei}#{pfad}: Schlüsselwort `#{k}` kennt validate.rb nicht – " \
                'entweder aus dem Schema entfernen oder in SCHLUESSELWOERTER ergänzen ' \
                '(sonst urteilen IDE und Pipeline unterschiedlich).'
    end
    if (ref = knoten['$ref'])
      ziel, fragment = ref.split('#', 2)
      ziel = datei if ziel.nil? || ziel.empty?
      doc = dokumente[File.basename(ziel)]
      if doc.nil?
        fehler << "#{datei}#{pfad}: `$ref` zeigt auf #{ziel} – diese Datei gehört nicht zum Schema-Satz."
      else
        unter = doc
        (fragment || '').split('/').reject(&:empty?).each { |t| unter = unter.is_a?(Hash) ? unter[t] : nil }
        fehler << "#{datei}#{pfad}: `$ref` #{ref} ist nicht auflösbar." if unter.nil?
      end
    end
    %w[properties patternProperties definitions].each do |c|
      (knoten[c] || {}).each { |k, v| pruefe.call(v, datei, "#{pfad}/#{c}/#{k}") }
    end
    %w[items additionalProperties].each do |c|
      pruefe.call(knoten[c], datei, "#{pfad}/#{c}") if knoten[c].is_a?(Hash)
    end
    %w[oneOf anyOf allOf].each do |c|
      Array(knoten[c]).each_with_index { |v, i| pruefe.call(v, datei, "#{pfad}/#{c}/#{i}") }
    end
  end
  dateien.each { |datei| pruefe.call(dokumente[datei], datei, '') }

  # KEIN PFLICHTFELD IM FRONT MATTER. Eine Seite ohne Front Matter muss bauen, und
  # zwar richtig – wer eine .md anlegt, soll schreiben koennen, ohne vorher eine
  # Feldliste zu lesen. Ein `required` auf oberster Ebene waere genau das Gegenteil
  # und faellt sonst niemandem auf, bis ein bestehendes Repo rot wird.
  # `required` INNERHALB einer Unterstruktur bleibt erlaubt: Ein resources-Eintrag
  # ohne `url` ist kein Standardfall, sondern ein halber Eintrag.
  wurzel_required = dokumente[namen[:frontmatter]]['required']
  unless wurzel_required.nil?
    fehler << 'frontmatter.schema.json: `required` auf oberster Ebene ist nicht erlaubt ' \
              "(#{Array(wurzel_required).join(', ')}). Jedes Front-Matter-Feld ist optional – " \
              'das Theme darf kein Feld verlangen. Stattdessen einen Standardwert vorsehen.'
  end
  fehler
end

# ---------------------------------------------------------------------------
# Hauptprogramm
# ---------------------------------------------------------------------------
wurzel = Dir.pwd
schema_dir = __dir__
configs = []
fm_schema = nil
cfg_schema = nil
selbsttest_nur = false
argv = ARGV.dup
until argv.empty?
  case (arg = argv.shift)
  when '--root'  then wurzel = argv.shift
  when '--schemas' then schema_dir = argv.shift
  when '--frontmatter-schema' then fm_schema = argv.shift
  when '--config-schema'      then cfg_schema = argv.shift
  when '--config'  then configs << argv.shift
  when '--self-test' then selbsttest_nur = true
  when '--help', '-h'
    puts File.read(__FILE__).lines[2..24].map { |z| z.sub(/\A# ?/, '') }.join
    exit 0
  else
    warn "Unbekannte Option: #{arg}"
    exit 2
  end
end

# Die beiden Schemas: entweder ueber --schemas (flache Ablage im Paket) oder
# einzeln ueber --frontmatter-schema/--config-schema (veroeffentlichte Ablage,
# `schemas/«name»/«version»/schema.json`). Ohne Angabe gilt das Verzeichnis dieser Datei.
pfade = {
  frontmatter: fm_schema || File.join(schema_dir, 'frontmatter.schema.json'),
  config: cfg_schema || File.join(schema_dir, 'config.schema.json')
}
pfade.each do |rolle, pfad|
  next if File.exist?(pfad)
  warn "FEHLER: Das #{rolle == :config ? 'Konfigurations' : 'Front-Matter'}-Schema fehlt: #{pfad}"
  warn '       Das Theme liefert die Schemas unter theme/jekyll/schema/ aus, die Doku-Site'
  warn '       unter /schemas/«name»/«version»/schema.json. Ohne sie gibt es keine Prüfung –'
  warn '       und eine Prüfung, die nichts prüft, ist kein Erfolg.'
  exit 2
end

if selbsttest_nur
  fehler = selbsttest(pfade)
  if fehler.empty?
    puts "Schema-Selbsttest bestanden (#{pfade.values.map { |p| File.basename(File.dirname(p)) + '/' + File.basename(p) }.join(', ')})."
    exit 0
  end
  warn "FEHLER: #{fehler.size} Problem(e) in den Schemas selbst:"
  warn ''
  fehler.each { |f| warn "  #{f}" }
  exit 1
end

validator = Validator.new
def schema_version(dir, name)
  datei = File.join(dir, "#{name}.version.txt")
  File.exist?(datei) ? File.read(datei).strip : '?'
end
# Version: die Datei neben dem Schema (veroeffentlichte Ablage: schemas/«name»/version.txt,
# Paket: «name».version.txt). Fehlt sie, steht dort ein Fragezeichen statt einer Erfindung.
def version_von(pfad, name)
  kandidaten = [
    File.join(File.dirname(pfad), "#{name}.version.txt"),
    File.join(File.dirname(pfad), '..', 'version.txt')
  ]
  kandidaten.each { |k| return File.read(k).strip if File.exist?(k) }
  '?'
end
version = "Front Matter #{version_von(pfade[:frontmatter], 'frontmatter')} / Config #{version_von(pfade[:config], 'config')}"
configs = [File.join(wurzel, '_config.yml')] if configs.empty?

meldungen = []

# --- _config.yml ---------------------------------------------------------
ausschluss = []
zielgruppen = []
konfigurationen_daten = []
configs.each do |cfg|
  unless File.exist?(cfg)
    warn "FEHLER: #{cfg} gibt es nicht."
    exit 2
  end
  begin
    daten = YAML.safe_load(File.read(cfg), permitted_classes: [Date, Time], aliases: true) || {}
  rescue Psych::SyntaxError => e
    meldungen << "#{cfg}: kein gültiges YAML – #{e.message}"
    next
  end
  ausschluss += Array(daten['exclude'])
  zielgruppen += Array(daten['audiences'])
  anzeige = cfg.sub(/\A#{Regexp.escape(wurzel)}\/?/, '')
  konfigurationen_daten << [anzeige, cfg, daten]
  validator.pruefen(daten, validator.dokument(pfade[:config]), pfade[:config]).each do |f|
    zeile = zeile_von(cfg, f[:zeiger], 0)
    meldungen << "#{anzeige}#{zeile ? ":#{zeile}" : ''}: #{f[:zeiger].empty? ? '' : "`#{f[:zeiger].sub(%r{\A/}, '').gsub('/', '.')}` "}#{f[:text]}"
  end
end

# --- Zielgruppen in den Konfigurationen (nav, audience des Builds) -------
# Erst NACH allen Konfigurationen, denn `audiences` kann im Overlay stehen.
konfigurationen_daten.each do |anzeige, cfg, daten|
  zielgruppen_pruefen(daten, zielgruppen.uniq, anzeige).each do |feld, text|
    zeile = zeile_von(cfg, '/' + feld.split('.').first, 0)
    meldungen << "#{anzeige}#{zeile ? ":#{zeile}" : ''}: `#{feld}` #{text}"
  end
end

# --- Front Matter aller Seiten ------------------------------------------
seiten = 0
Dir.glob(File.join(wurzel, '**', '*.{md,markdown,html}')).sort.each do |pfad|
  rel = pfad.sub(/\A#{Regexp.escape(wurzel)}\/?/, '')
  next if uebersprungen?(rel, ausschluss)
  daten, fehler = front_matter(pfad)
  if fehler
    meldungen << "#{rel}: #{fehler}"
    next
  end
  seiten += 1
  next if daten.nil?
  validator.pruefen(daten, validator.dokument(pfade[:frontmatter]), pfade[:frontmatter]).each do |f|
    zeile = zeile_von(pfad, f[:zeiger], 1)
    meldungen << "#{rel}#{zeile ? ":#{zeile}" : ''}: #{f[:zeiger].empty? ? '' : "`#{f[:zeiger].sub(%r{\A/}, '').gsub('/', '.')}` "}#{f[:text]}"
  end
  zielgruppen_pruefen(daten, zielgruppen.uniq, rel).each do |feld, text|
    zeile = zeile_von(pfad, '/' + feld.split('.').first, 1)
    meldungen << "#{rel}#{zeile ? ":#{zeile}" : ''}: `#{feld}` #{text}"
  end
end

# Eine Prüfung über die leere Menge ist kein Erfolg.
if seiten.zero?
  warn "FEHLER: Unter #{wurzel} wurde KEINE Seite gefunden."
  warn '       Damit hat die Prüfung nichts geprüft – das ist ein Befund, kein Erfolg.'
  warn '       Stimmt --root? Schließt `exclude` versehentlich alles aus?'
  exit 2
end

if meldungen.empty?
  zg = zielgruppen.uniq.empty? ? 'keine Zielgruppen deklariert' : "Zielgruppen: #{zielgruppen.uniq.join(', ')}"
  puts "Schema #{version}: #{configs.size} Konfiguration(en) und #{seiten} Seite(n) geprüft, #{zg} – keine Verstöße."
  exit 0
end

warn "FEHLER: #{meldungen.size} Verstoß/Verstöße gegen die Academy-Schemas (#{version}):"
warn ''
meldungen.each { |m| warn "  #{m}" }
warn ''
warn 'Was jetzt zu tun ist:'
warn '  * Tippfehler im Feldnamen? Die erlaubten Felder stehen in der Meldung.'
warn '  * Feld ABSICHTLICH neu? Dann gehört es ins Schema UND in die Theme-Doku'
warn '    (docs/theme/schemas.md) – ein Feld ohne Doku findet niemand wieder.'
warn '  * Repo-eigenes Feld, das das Theme nicht liest? Präfix `x_` verwenden.'
exit 1
