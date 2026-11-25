# Troubleshooting

Start with the add-on's **Log** tab. Most problems name themselves there.

## Setup

| You see | Meaning | Fix |
|---|---|---|
| `SETUP NEEDED: not set up yet` | No credentials yet | Open **Beoview** in the sidebar and photograph the QR code ([Installation](installation.md#3-connect-your-intercom-qr-code)) |
| Panel says **No QR code found** | The photo wasn't sharp enough or the QR was too small | Photograph straight on, fill more of the frame, avoid glare. Or paste the code instead |
| Panel says **Beoview refused the code** | The code was already used or expired | Add a new device on the module for a fresh QR code |
| No **Beoview** in the sidebar | The page wasn't reloaded, or the sidebar entry was switched off | Reload the page. Or turn on Add-on → Info → **Show in sidebar**. Only admins see it |
| `card install failed: dashboards are in YAML mode` | Your dashboards are YAML-managed | Add the resource yourself: `url: /local/beoview/beoview-camera.js`, `type: module` |
| `mqtt setup failed` | Mosquitto isn't running | Install and start the Mosquitto broker add-on, then restart this add-on |

## The card

| You see | Meaning | Fix |
|---|---|---|
| **Custom element doesn't exist: beoview-camera** | The resource didn't load | Reload the page / clear the app cache. Check Settings → Dashboards → ⋮ → Resources has `/local/beoview/beoview-camera.js` |
| Error about the WebRTC integration, or a black card that never connects | WebRTC Camera isn't installed or set up | [Installation step 4](installation.md#4-set-up-webrtc-camera) |
| Video works at home, not on 4G | No relay | [Outside your home](card.md#watching-from-outside-your-home) |
| **mic denied** (with `debug: true`), visitor can't hear you | Browsers only allow the microphone on HTTPS | Use the Home Assistant app or an `https://` address. Quick replies work without a mic |
| No sound until you tap | Browsers block autoplay with sound | Tap **Answer**; that tap allows sound |
| Buttons stay grey during a ring | The card didn't get the call state | Check `sensor.beoview_intercom_call_state` changes on a ring; if not, see the next section |

## Rings

| Log shows | Meaning | Fix |
|---|---|---|
| Nothing on a ring | Not connected to the Beoview cloud | Check `cloud connected, waiting for rings`. Does the official app still get rings? |
| `cloud error: connect timeout`, then `cloud connected` | A short network hiccup | Nothing; it reconnects by itself |
| `CALL_FAILED: spy_disabled` right after `DOORBELL` | Another client took the ring first | Make sure only **one** copy of this add-on (or similar bridge) runs for your module. The phone app is fine |
| `unlock: no call to unlock from` | Unlock outside a ring | The Beoview cloud only opens the door during a ring or call |
| `view timed out unanswered` | Video stops 60 s after a ring nobody answered | By design, so the door camera never stays on |

## Quick replies

| Log shows | Fix |
|---|---|
| Panel says **That file could not be converted** | The file isn't readable audio (or is DRM-protected); export it again as mp3 or wav |
| An uploaded reply doesn't show in the card | Reload the dashboard. If you set `replies` in the card yourself, the card only shows those; add the new `name` there |
| `no reply clip <name>` | The card asks for a reply that doesn't exist (anymore). Check the names in `sensor.beoview_intercom_quick_replies` |
| `reply x.mp3 → x.pcm: ffmpeg failed` | A file dropped in the folder isn't readable audio; export it again as mp3 or wav |
| `bad reply name` | A `name` in the card config has capitals, spaces or dots; use the name as the sensor lists it |

## Still stuck?

Open an issue with the add-on version, your Home Assistant version, and the log lines around the problem.
The log never contains your credentials, but check for anything personal before you paste it.
