# Automations

## Entities

All under the **Beoview intercom** device (MQTT).

| Entity | Type | What it is |
|---|---|---|
| `event.beoview_intercom_doorbell` | event | Fires `ring` on every ring. Attribute `source` is the door panel's name |
| `binary_sensor.beoview_intercom_ringing` | binary sensor | On from the ring until the call ends or times out |
| `sensor.beoview_intercom_call_state` | sensor | `idle`, `ringing`, `connecting`, `viewing` (video), `talking` (video + audio) |
| `camera.beoview_intercom_door_snapshot` | camera | Latest frame from the door camera, updated about once a second during a call |
| `button.beoview_intercom_answer` | button | Answer: two-way audio |
| `button.beoview_intercom_hang_up` | button | Hang up / stop video |
| `button.beoview_intercom_unlock_door` | button | Open the door. **Only works during a ring or call** |
| `binary_sensor.beoview_intercom_cloud_connection` | binary sensor | Diagnostic: connected to the Beoview cloud |
| `sensor.beoview_intercom_quick_replies` | sensor | Diagnostic: number of quick replies; attribute `replies` lists each `name` and `label` |

All entities show *unavailable* while the add-on is stopped or not set up yet.

## Blueprints

Import with Settings → Automations & scenes → Blueprints → Import blueprint, and paste the URL.

### Push to your phones: answer, decline, open door

`https://github.com/Blacksuite/beoview-ha/blob/main/blueprints/automation/beoview/ring-notify.yaml`

When someone rings, every phone you pick gets a push with the door snapshot and three buttons:

- **Answer** opens your door dashboard and picks up,
- **Decline** hangs up,
- **Open door** opens it (on iPhone it asks for Face ID or your passcode first; you can hide this button).

Pick **one phone or several** in the phone list (any phone with the Home Assistant app). On iPhone it can ring
through silent mode as a critical alert (on by default, with its own volume); iOS asks once to allow that.
When the ring ends, the push disappears from all phones.

Renamed a phone in the Home Assistant app? The blueprint finds a phone's notify action by its device name, so if
pushes stop, check that the phone's device name and its `notify.mobile_app_…` action still match.

### Cast to a Google display when someone rings

`https://github.com/Blacksuite/beoview-ha/blob/main/blueprints/automation/beoview/ring-cast.yaml`

Casts a dashboard view with the card to a Nest Hub (or any Google Cast display) at ring volume. When the call
has been over for a while (30 seconds by default), it puts the old volume back and turns the display off.

The blueprint doesn't create the view; it opens the one you name. **Make the view first**
([copy-paste config in the README](../README.md#-nest-hub-show-the-door-when-it-rings)), then fill in:

| Field | Meaning |
|---|---|
| Display | The Google Cast device to show it on |
| Dashboard path | The part of the view's address after the host: `lovelace` for the default dashboard, or e.g. `dashboard-home` |
| View path | The view's `path`, e.g. `door-hub` |
| Ring volume | Volume while the view is up; the old volume is put back afterwards |
| Turn off after the call | Seconds after the call ends before the display is switched off |

Needs Home Assistant reachable over HTTPS (Home Assistant Cloud or your own certificate): Google displays only
load HTTPS pages. Google displays can't use a microphone, so answer with quick replies there.
Test without ringing: the automation → ⋮ → **Run actions**.

## Examples

Open the door automatically for an expected delivery window, only while a helper is on:

```yaml
triggers:
  - trigger: state
    entity_id: event.beoview_intercom_doorbell
conditions:
  - condition: state
    entity_id: input_boolean.expecting_delivery
    state: "on"
actions:
  - action: button.press
    target: { entity_id: button.beoview_intercom_unlock_door }
```

⚠️ Think twice before opening your door automatically: anyone who rings gets in.

Play a quick reply from an automation (here: "Ik kom eraan" when someone rings at night):

```yaml
actions:
  - action: mqtt.publish
    data: { topic: beoview/cmd, payload: "say:ik_kom" }
```

## MQTT commands

Publish to `beoview/cmd`:

| Payload | Does |
|---|---|
| `view` | Start video for the current ring (happens automatically) |
| `answer` | Two-way audio |
| `hangup` | End the call |
| `unlock` | Open the door (during a ring or call; starts video first if needed) |
| `say:<name>` | Answer and play `replies/<name>.pcm` at the door |
| `beep` | Diagnostic: a 3-second tone on the door-audio stream |

State topics: `beoview/status` (online/offline), `beoview/cloud`, `beoview/call_state`, `beoview/ringing`,
`beoview/doorbell` (event JSON), `beoview/snapshot` (JPEG), `beoview/unlock_status`.
