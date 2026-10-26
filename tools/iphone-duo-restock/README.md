# iPhone Duo Restock-Bot (München)

Fragt alle ~90 Sekunden bei Apple ab, ob ein **iPhone Duo mit 256 oder 512 GB, egal welche Farbe** in einem Münchner Apple Store zur Abholung verfügbar ist. Sobald etwas frei wird, kommt **eine** Push-Nachricht aufs Handy (ntfy und/oder Telegram).

Der Bot bestellt **nicht** selbst. Wenn der Alarm kommt: Apple Store App öffnen → iPhone Duo → Variante wählen → „Abholen“ → Münchner Store → bezahlen. Das geht in unter einer Minute.

## Voraussetzungen

- Node.js 20 oder neuer (`node --version`)
- keine weiteren Pakete nötig

## Einrichten

```bash
cd tools/iphone-duo-restock
cp .env.example .env
```

In `.env` eine Benachrichtigung eintragen:

- **ntfy (am einfachsten):** App „ntfy“ installieren (iOS/Android), ein Thema mit langem, zufälligem Namen abonnieren (z. B. `duo-muc-k7f2q9x`) und denselben Namen bei `NTFY_TOPIC=` eintragen.
- **Telegram:** über `@BotFather` einen Bot anlegen, den Token bei `TELEGRAM_BOT_TOKEN=` eintragen, dem Bot einmal schreiben, die eigene Chat-ID (z. B. über `@userinfobot`) bei `TELEGRAM_CHAT_ID=` eintragen.

Dann testen:

```bash
node --env-file=.env restock.mjs --test   # Testnachricht aufs Handy
node --env-file=.env restock.mjs --once   # eine Abfrage, zeigt alle Varianten pro Store
```

`--once` sollte die gefundenen Teilenummern und eine Zeile pro Store und Variante zeigen (✅ / ❌). Falls „Keine Varianten gefunden“ kommt: die iPhone-Duo-Kaufseite im Browser öffnen und deren Adresse bei `PRODUCT_URL=` eintragen.

## Dauerhaft laufen lassen

**Auf dem Rechner:** einfach im Terminal starten und offen lassen (Rechner darf nicht schlafen):

```bash
node --env-file=.env restock.mjs
```

**Auf einem Server (systemd):** `/etc/systemd/system/duo-restock.service`

```ini
[Unit]
Description=iPhone Duo Restock-Bot
After=network-online.target

[Service]
WorkingDirectory=/pfad/zu/derpminer/tools/iphone-duo-restock
ExecStart=/usr/bin/node --env-file=.env restock.mjs
Restart=always
RestartSec=60

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now duo-restock
journalctl -u duo-restock -f   # Log ansehen
```

Ein Server in Deutschland ist besser als einer in einem Rechenzentrum im Ausland: Apple blockt Rechenzentrums-IPs eher. Wenn im Log ständig `HTTP 403` / `541` steht, lieber auf dem Rechner zu Hause laufen lassen.

**Ohne eigenen Rechner (GitHub Actions):** Der Workflow `.github/workflows/duo-restock.yml` startet den Bot alle 10 Minuten für jeweils ~9 Minuten. Einrichten geht komplett im Handy-Browser:

1. Repo → Settings → Secrets and variables → Actions → *New repository secret*: `NTFY_TOPIC` (und/oder `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
2. Optional unter *Variables*: `PRODUCT_URL`, falls die Kaufseite anders heißt.
3. Actions → „iPhone Duo Restock“ → *Run workflow* zum Testen, im Log sollten die Varianten auftauchen.

Zeitgesteuerte Workflows laufen nur auf dem Standard-Branch (`main`). Die Logs sind bei einem öffentlichen Repo für alle sichtbar, die Secrets nicht. GitHub startet geplante Läufe manchmal verspätet, und Apple blockt Rechenzentrums-IPs eher. Steht im Log dauerhaft `HTTP 403` oder `541`, hilft nur ein Rechner oder Server mit normaler Internetleitung.

## Verhalten

- Ein Alarm pro Restock: solange eine Variante verfügbar bleibt, kommt keine weitere Nachricht. Ist sie weg und kommt wieder, gibt es einen neuen Alarm.
- Bei Fehlern oder Drosselung durch Apple wartet der Bot schrittweise länger (2 bis 15 Minuten) statt weiter anzufragen.
- Alle 6 Stunden werden die Teilenummern neu von der Produktseite geholt.
- Neue Ware kommt oft über Nacht. Handy nachts also auf „Alarme durchlassen“ stellen, wenn du auch um 6 Uhr zuschlagen willst.

## Tests

```bash
node --test tools/iphone-duo-restock/lib.test.mjs
```
