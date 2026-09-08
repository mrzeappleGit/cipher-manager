# cipher — Android app

A thin WebView wrapper around the cipherManager **web server** running on your
PC. All data and job execution live on the PC; the phone is just a client, so
the PC must be reachable (same LAN, or via Tailscale/VPN).

## One-time: start the server on the PC

Run the web server bound to the LAN (not just localhost) so the phone can reach it:

```
serve --host 0.0.0.0 --port 4600
```

Get the pairing URL from Settings → Remote access in the desktop app. It contains an access token: keep it private and paste the complete URL into the phone. Release builds do not print the token. `serve` embeds `dist/`, so use `npm run web` to rebuild when the frontend changes.

## Build the APK

Requires a JDK 17 and the Android SDK (platform 35, build-tools 35).

```
cd mobile/android
# JAVA_HOME must point at a real JDK (not the PATH shim):
#   set JAVA_HOME=C:\Program Files\Java\jdk-17
gradlew.bat :app:assembleRelease
```

Output: `app/build/outputs/apk/release/app-release.apk` (debug-signed, so it
installs without a keystore — swap in a real signingConfig for the Play Store).

## Install

Sideload: copy the APK to the phone and open it (allow "install unknown apps"),
or with the phone plugged in and USB debugging on:

```
adb install -r app/build/outputs/apk/release/app-release.apk
```

On first launch it asks for the server URL — paste the tokenized URL from above.
The **☰** button in the bottom-right corner opens the menu (change the URL,
reload, pair a widget, exit); the phone's Back button at the top level opens the
same thing.

## Remote access from anywhere

Use a private VPN and HTTPS for access away from home. Keep bearer-token authentication enabled for LAN or proxy access: bind the server to your private interface, then pair using Settings. Limit inbound access with the Windows firewall. The default loopback server rejects nonlocal Host headers, so forwarding a public hostname directly to that mode is unsupported.

HTTPS is also required for browser voice input. Consult your VPN or reverse proxy documentation for setup; do not expose this service directly to the internet.

## PC off? Cloud snapshot fallback

When the PC is unreachable, the app automatically loads the read-only cloud
snapshot URL you explicitly configure (for example https://example.invalid/cm/) and
asks for its basic-auth credentials once. When the app resumes and the PC
answers again, it switches back to the live server on its own. Both moves are
also in the ☰ menu ("Open cloud snapshot" / "Try live server"), and the
snapshot URL is editable there too.

## Home-screen widgets

Two widgets, both reading the PC's read-only G2 facade:

- **Next up** — countdown to the next meeting. It ticks locally, so it stays
  correct with no network once it has fetched.
- **Today** — the day's brief; tap the body to page through it, the header to
  refresh, and the buttons to jump into the app or run a skill.

One-time: open the app, tap the **☰** button (bottom-right, over the page — or
press Back at the top level, which opens the same menu), choose **Pair widget**,
and approve the 6-digit code in cipherManager Settings → Even G2. That card is
shared with the glasses, so pairing a widget does not pair G2 and vice versa;
each shows up as its own client, the widget as "Android widget".

Choose which skill the button runs with **Widget skill** in the same menu — that
menu entry is the only place it can be set; the widget's "Pick skill" label
opens the app's
Skills page, which lists skills but does not assign the widget's. The button
stays disabled while Acting mode is off, and a tap re-checks that setting on the
PC before it runs anything, so turning Acting mode off takes effect immediately
rather than at the next refresh. Revoke a paired widget from the same Settings
panel — the widgets notice on their next refresh and go back to asking to be
paired, rather than sitting on data they can no longer fetch.

Widgets refresh every 30 minutes (Android's floor), when you tap the header, and
whenever the app is opened. When the PC is unreachable they keep showing the
last values with an age stamp.

## Known limits

- **Desktop-width UI** until the responsive pass lands — usable but cramped on a phone.
- **Voice input** needs a secure context (HTTPS); it won't work over plain
  `http://` LAN. Everything else (deck, briefs, running skills) works.
