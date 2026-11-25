# Security

This add-on can open your front door, so security reports are very welcome.

**Report privately**: use GitHub's "Report a vulnerability" (Security tab) on this repository. Please don't open a
public issue for anything that could let someone else open a door, see a camera or take over an install.

## What the add-on does with your data

- **Beoview cloud**: the one-time QR token (once) and the resulting device credentials (on every connect) go to
  `client.api.beoview.com`, the same server the official app uses, only after its certificate matched the pin.
  Video and audio of calls come from there.
- **Stored**: device credentials in the add-on's private `/data/beoview.json` (mode 0600). Nothing else.
- **Never sent anywhere else**: no telemetry, no analytics, no third-party servers.
- **Exposed on your LAN**: only port 8555 (WebRTC media). Control goes over Home Assistant's authenticated MQTT and
  APIs; the setup panel is admin-only through Home Assistant ingress.
- **Door unlock** works only during a ring or call (a limit of the Beoview cloud), and only through Home
  Assistant entities, so your Home Assistant users and automations decide who can press it.
