# Beoview Intercom

Doorbell, live video, two-way talk, quick replies and door unlock for Beoview / Golmar intercoms with the
BWCM.01 Wi-Fi module.

## Setup

1. **Before you start**: the Mosquitto broker add-on must run, and **WebRTC Camera** must be installed from HACS.
   New module? Connect it to Wi-Fi with the official Beoview app first, and give it a minute or two before it
   can show a QR code for a new device.
2. Start this add-on. **Beoview** appears in the sidebar.
3. On the BWCM.01's screen, add a new device so it shows a QR code. In the **Beoview** panel (use the Home
   Assistant app on your phone), tap **Take a photo of the QR code**. It connects right away.
4. Add the **WebRTC Camera** integration with URL `http://<hostname>:1984`. The hostname is on this add-on's
   Info tab.
5. Add a card to a dashboard:

   ```yaml
   type: custom:beoview-camera
   ```

## Configuration

| Option | |
|---|---|
| `registration_token` | Optional. The code from the QR code, if you'd rather paste it here than use the panel. Used once, then restart. |

**Your own quick replies:** open **Beoview** in the sidebar → **Quick replies** → **Add an audio file**. Name the
file what the button should say (`I'm coming.mp3`); it appears in the card by itself.

## More

Full documentation, troubleshooting and blueprints: https://github.com/Blacksuite/beoview-ha
