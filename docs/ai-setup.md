# Set it up with an AI assistant

You can hand most of this setup to an AI assistant (Claude, ChatGPT, Gemini, ...). There are two ways:

- **Guided**: the assistant walks you through it and you click. Works with any chat assistant.
- **Hands-on**: the assistant does the Home Assistant steps itself. Needs an assistant that can reach your
  Home Assistant, for example through Home Assistant's **Model Context Protocol Server** integration or an
  MCP server like ha-mcp.

Either way, **two steps are always yours**: standing at the intercom module to make a QR code, and photographing
it in the Beoview panel. And an assistant should never press "unlock door" unless you ask it to right then.

## The prompt

Copy this into your assistant:

```text
Help me install the "Beoview Intercom" Home Assistant add-on from
https://github.com/Blacksuite/beoview-ha. Read the README and docs/installation.md there first
(raw files: https://raw.githubusercontent.com/Blacksuite/beoview-ha/main/docs/installation.md).

Go one step at a time and confirm each step worked before the next, using the checklist in
docs/ai-setup.md. If you can reach my Home Assistant, do the steps yourself and tell me what you did;
otherwise tell me exactly what to click. Stop and tell me when it's my turn at the intercom module.

Rules: never ask me for passwords or tokens in chat, never press the unlock button or publish
"unlock" unless I ask for it in that moment, and don't change other add-ons or integrations
without asking.
```

## Checklist for the assistant

Each step has a check that proves it worked. Don't move on until it passes.

| # | Step | Who | Proof it worked |
|---|---|---|---|
| 0 | Module on Wi-Fi through the official Beoview app (new modules only), then wait a minute or two | **human** | The module's screen can show a QR code when adding a new device |
| 1 | Home Assistant is OS or Supervised | assistant | Settings → About shows *Home Assistant OS* or *Supervised* |
| 2 | Mosquitto broker add-on installed and started | assistant | Add-on state `started` |
| 3 | MQTT integration set up | assistant | An `mqtt` config entry is loaded |
| 4 | HACS installed, **WebRTC Camera** downloaded, Home Assistant restarted | assistant | `webrtc` integration available |
| 5 | Repository `https://github.com/Blacksuite/beoview-ha` added | assistant | **Beoview Intercom** appears in the add-on store |
| 6 | Add-on installed and started | assistant | Log shows `SETUP NEEDED` and `added Beoview to the sidebar for setup`; entities `*.beoview_intercom_*` exist (unavailable) |
| 7 | QR code on the module, photographed in the **Beoview** panel | **human** | Panel shows **✓ Connected**; log shows `registered from the setup panel` then `cloud connected, waiting for rings` |
| 8 | WebRTC Camera integration added with URL `http://<add-on hostname>:1984` | assistant | Config entry `WebRTC Camera` loaded. Hostname is on the add-on Info tab (`<id>-beoview`) |
| 9 | Card resource present | assistant | Dashboard resources include `/local/beoview/beoview-camera.js?v=…` (the add-on adds it) |
| 10 | Card on a dashboard: `type: custom:beoview-camera` | assistant | Card shows *Nobody at the door* with grey buttons |
| 11 | Test ring | **human** rings | `sensor.beoview_intercom_call_state` goes `ringing` → `viewing`; card shows *Live view* |
| 12 | Optional: push blueprint (pick the human's phones), cast blueprint, outside-home access | either | See [automations.md](automations.md) and [card.md](card.md) |
| 13 | Optional: own quick replies. The human (or a text-to-speech service) makes audio files named like the button text | either | Files uploaded in the Beoview panel → **Quick replies**; `sensor.beoview_intercom_quick_replies` counts them and the card shows them |

If a step fails, look up the log line in [troubleshooting.md](troubleshooting.md).

## Facts an assistant needs

- Add-on slug: `<repository id>_beoview`; hostname `<repository id>-beoview`; go2rtc on port 1984 (internal),
  WebRTC on 8555 (LAN).
- Entity ids: `event.beoview_intercom_doorbell`, `binary_sensor.beoview_intercom_ringing`,
  `sensor.beoview_intercom_call_state`, `camera.beoview_intercom_door_snapshot`,
  `button.beoview_intercom_answer`, `button.beoview_intercom_hang_up`, `button.beoview_intercom_unlock_door`,
  `binary_sensor.beoview_intercom_cloud_connection`, `sensor.beoview_intercom_quick_replies`.
- A brand-new module needs the official Beoview app once to join Wi-Fi, and a minute or two before it can register devices.
- MQTT commands on `beoview/cmd`: `view`, `answer`, `hangup`, `unlock`, `say:<name>`, `beep`.
- The registration code is a one-time UUID; a spent code is refused. The human makes a new one on the module.
- Talking needs HTTPS; on plain http the card still shows video and can unlock.
- Only one install per intercom module.
