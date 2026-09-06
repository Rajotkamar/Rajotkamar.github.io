# AR INOVATION HUB — FULL LIVE Energy Monitoring

This version is **live-data only**. It does not generate fake sensor readings. It contains a real browser-to-Firebase data path and an ESP32 + PZEM-004T v3.0 publisher.

## 1) What is live

The website listens to Firebase Realtime Database and displays the newest PZEM values for:

- Voltage
- Current
- Active Power
- Total Energy (kWh)
- Frequency
- Power Factor
- Live history charts
- Billing from the configured ₹/kWh tariff
- Threshold-based overload/current/voltage alerts
- CSV exports based on the Firebase data actually received

Until Firebase is configured and a reading exists, the dashboard intentionally shows **—** rather than invented values.

## 2) Firebase setup

Create a Firebase project and a Realtime Database.

Enable:
`Authentication -> Sign-in method -> Anonymous`

Deploy the included `database.rules.json` or tighten the rules for your own production authorization model.

The browser Settings page accepts:

- Firebase Web API Key
- Realtime Database URL
- Latest reading path (default `/pzem/readings/latest`)
- History path (default `/pzem/readings/history`)

The website then signs in anonymously and subscribes to those paths.

## 3) ESP32 + PZEM

Open `hardware/esp32_pzem_example.ino` in Arduino IDE, install:

- `PZEM004Tv30`
- `Firebase Arduino Client Library for ESP8266 and ESP32 (Mobizt)`

Fill in Wi-Fi credentials, Firebase Web API Key, and Database URL.

The sketch publishes every 2 seconds to:

`/pzem/readings/latest`

and appends history records to:

`/pzem/readings/history/<firebase-push-id>`

The timestamp is generated from NTP epoch time so the website can group real readings by date.

## 4) Real overload email

The included Firebase Cloud Function watches:

`/pzem/readings/latest`

When power is above the configured overload threshold, it sends an email through your SMTP provider, subject to the configured cooldown.

In `functions/`, install dependencies and deploy the function with Firebase CLI.

Configure these function environment variables/secrets on the server side:

- `SMTP_HOST`
- `SMTP_PORT` (example: 587)
- `SMTP_SECURE` (`true` or `false`)
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM` (optional)

Do **not** put SMTP credentials into the website. The website only writes the alert recipient/threshold settings to Firebase; the cloud function owns the mail credentials.

The browser settings page writes:

`/settings/alerts`

with recipient, email-enabled flag, subject, cooldown, and thresholds.

## 5) Deploy the website

This is a static site, so it can be hosted on Firebase Hosting, GitHub Pages, Netlify, Cloudflare Pages, Vercel static hosting, or another static host.

For Firebase Hosting:

```bash
firebase login
firebase init hosting
firebase deploy
```

Choose the folder containing `index.html` as the public directory.

## 6) Security

The supplied database rules are a simple authenticated baseline. For production, use Firebase Authentication and rules scoped to the users/devices that should read or write each path. Do not place SMTP passwords, service-account keys, or other privileged credentials in the browser.

## 7) Change the website logo

Open **Settings -> Website Configuration -> Change Logo**.

The supplied AR INOVATION HUB logo is included as the default hosted logo. You can replace it from Settings -> Website Configuration -> Change Logo. The selected image is automatically resized to a web-friendly PNG and saved in the browser for this site. It is used for the desktop sidebar, mobile header, settings preview, and browser favicon and PWA icons use the supplied AR INOVATION HUB logo by default.

Supported uploads: PNG, JPG/JPEG, WEBP, SVG.

## 8) Hosting checklist

This folder is ready for static hosting. Upload the contents of this folder to a static host, then configure Firebase from **Settings** on the live site. For Firebase Hosting, the included `firebase.json` points Hosting at the project root and excludes the Cloud Functions source from public hosting.


## Host setup checklist

1. Open `firebase-config.js` and paste the Firebase Web App configuration into `firebase-config.js` (including `authDomain`, `apiKey`, and `databaseURL`), or enter them in Settings.
2. In Firebase Authentication, enable Anonymous sign-in (or change the auth flow to your preferred provider).
3. Create/enable Realtime Database and use `database.rules.json` as a starting point; tighten the rules for production.
4. Upload/deploy the folder with Firebase Hosting, Netlify, Vercel static hosting, or another static host.
5. Flash `hardware/esp32_pzem_example.ino` to the ESP32 after adding Wi-Fi and Firebase settings.
6. Confirm that the ESP32 writes `/pzem/readings/latest` and `/pzem/readings/history`.
7. For email alerts, deploy the included `functions` package and configure SMTP environment variables server-side.

### Firebase latest reading

The dashboard accepts:

```json
{
  "voltage": 229.4,
  "current": 0.18,
  "power": 41.2,
  "energy": 0.48,
  "frequency": 50.0,
  "powerFactor": 0.98,
  "timestamp": 1730000000000
}
```

### Important

The browser never invents measurements. Until valid Firebase telemetry is available, values remain `—`.
