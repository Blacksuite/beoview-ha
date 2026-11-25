# Beoview Intercom for Home Assistant

Answer your **Beoview video intercom** from Home Assistant: see who's at the door, talk to them, open the door,
or tap a recorded reply. Works with the **BWCM.01 Wi-Fi module**.

> Unofficial. Not affiliated with Beoview, Vercoma or Golmar. Use at your own risk.

## How it works, in short

Your BWCM.01 module already talks to the Beoview cloud; that's how the official Beoview app gets rings. This
add-on signs in to that same cloud as one more "phone", so Home Assistant gets every ring too. It turns the
door's video and audio into a normal live stream, and gives you a ready-made dashboard card, a doorbell
event for automations, and buttons to answer, hang up and open the door.

```
 Door panel → BWCM.01 → Beoview cloud → this add-on → Home Assistant (card, phone push, automations)
```

## What works and what doesn't

| | |
|---|---|
| ✅ **Doorbell in Home Assistant** | A ring event, a "ringing" sensor and a snapshot of who's there |
| ✅ **Live video** | Starts by itself when someone rings, on phone, tablet and desktop |
| ✅ **Two-way talk** | Tap Answer. Needs HTTPS or the Home Assistant app (browsers block the mic on plain http) |
| ✅ **Open the door** | From the card (tap twice), the phone push, or an automation, **while it rings** |
| ✅ **Quick replies** | One tap plays a recorded message at the door. Upload your own mp3s; Dutch ones built in |
| ✅ **Phone push** | To one or more phones, with Answer / Decline / Open door buttons |
| ✅ **Nest Hub / Google display** | Shows the card when it rings. Video, door, quick replies; no talking (Google blocks the mic) |
| ✅ **Watching away from home** | With Home Assistant Cloud, set up exactly as described in [Away from home](#-away-from-home-read-this-if-you-use-home-assistant-cloud) |
| ❌ **Opening the door when nobody rang** | The Beoview cloud only allows it during a ring |
| ❌ **Two copies of this add-on** for one module | They fight over every ring and both lose. Run one |
| ❓ **Monitors with built-in Wi-Fi** | Probably, since they use the same cloud, but untested. Tell us! |

Tested on Home Assistant OS 17 / Core 2026.10 (amd64) with a BEOVIEW7 Lite-S. Raspberry Pi (aarch64) builds but
is untested.

## Setup

Takes about 15 minutes. You'll need to walk to your intercom once.

### 1. Get the module on Wi-Fi (new modules only)

1. Install the official **Beoview** app on your phone and use it to connect the module to your Wi-Fi.
2. **Wait a minute or two.** A freshly connected module can't add new devices straight away.
3. Check: on the module's screen, open the menu and choose to add a device. When it shows a **QR code**, you're
   ready. (Leave it for now; you'll scan it in step 4.)

Already using the Beoview app? Skip this step.

### 2. Install what the add-on needs

In Home Assistant:

- **Mosquitto broker**: Settings → Add-ons → Add-on store → Mosquitto broker → Install → Start.
  Then accept the **MQTT** integration Home Assistant offers.
- **WebRTC Camera** by AlexxIT: install [HACS](https://hacs.xyz) if you don't have it, then HACS → search
  "WebRTC Camera" → Download → restart Home Assistant.

### 3. Install the add-on

[![Add repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FBlacksuite%2Fbeoview-ha)

Click the button (or Settings → Add-ons → Add-on store → ⋮ → Repositories → add
`https://github.com/Blacksuite/beoview-ha`). Then open **Beoview Intercom** → **Install** → **Start**.
The first install takes a few minutes.

### 4. Scan the QR code

1. On your phone, open the **Home Assistant app** and tap **Beoview** in the sidebar.
2. At the module, add a new device so it shows the QR code.
3. In the app, tap **Take a photo of the QR code** and photograph the screen.
4. You see **✓ Connected**. Done.

"Code refused"? Each QR code works once; make a new one on the module.

### 5. Connect WebRTC Camera

Settings → Devices & services → Add integration → **WebRTC Camera**. For the URL, enter
`http://<hostname>:1984`, where `<hostname>` is shown on the add-on's **Info** tab (it looks like
`a1b2c3d4-beoview`).

### 6. Add the card

Edit a dashboard → Add card → Manual → paste:

```yaml
type: custom:beoview-camera
```

Now ring your own doorbell. The card should show **Live view** within a second or two. 🎉

### 7. Optional extras

- **Phone push**: import the [push blueprint](docs/automations.md#push-to-your-phones-answer-decline-open-door) and pick your phones.
- **Nest Hub**: import the [cast blueprint](docs/automations.md#cast-to-a-google-display-when-someone-rings).
- **Quick replies**: see below.

## Quick replies

Buttons in the card that play a recorded message at the door, like *"I'm coming"* or *"Leave it in the hall"*.
They never open the door and never turn your microphone on.

- **Your own:** record or generate an audio file and name it what the button should say (`I'm coming.mp3`).
  Open **Beoview** in the sidebar → **Quick replies** → **Add an audio file**. It shows up in the card by itself.
- **Built-in Dutch replies** (*Deur is open, Even duwen, Ik kom eraan, Pakket in de hal, Geen interesse*):
  switch them on or off in the same **Quick replies** screen. They're on by default when Home Assistant is set
  to Dutch.

## 🌍 Away from home (read this if you use Home Assistant Cloud)

At home on Wi-Fi the video just works. On 4G or another network it has to go through a relay.

> [!CAUTION]
> **With Home Assistant Cloud (Nabu Casa), video away from home only works when you set it up exactly like this.**
> Without these two steps the card stays black on 4G, even though it works fine at home.
>
> 1. Settings → Devices & services → Add integration → **Generic Camera**, with stream source
>    `rtsp://<hostname>:8554/door` (hostname from the add-on's Info tab). Leave the still image empty.
> 2. Add these two lines to the card:
>
>    ```yaml
>    type: custom:beoview-camera
>    cloud_entity: camera.your_generic_camera   # the camera from step 1
>    cloud_relay_only: true
>    ```

No Home Assistant Cloud? Use a VPN to your home (Tailscale, WireGuard) and it works as if you were home.

## More documentation

| | |
|---|---|
| 📦 [Installation in detail](docs/installation.md) | Every step with more background, updating, uninstalling |
| 🖼️ [The card](docs/card.md) | All card options |
| ⚙️ [Automations](docs/automations.md) | Entities, blueprints, MQTT commands, examples |
| 🩺 [Troubleshooting](docs/troubleshooting.md) | What each message means and how to fix it |
| 🤖 [Set it up with an AI assistant](docs/ai-setup.md) | A ready-made prompt and checklist |
| 🤝 [Contributing](CONTRIBUTING.md) | For developers (and their AI agents: [AGENTS.md](AGENTS.md)) |

## License

MIT, see [LICENSE](LICENSE). Includes code from [WebRTC Camera](https://github.com/AlexxIT/WebRTC) (MIT) and
[pan-zoom-controller](https://github.com/dbuezas/pan-zoom-controller) (MIT), and uses
[jsQR](https://github.com/cozmo/jsQR) (Apache 2.0). See [NOTICE](NOTICE).
