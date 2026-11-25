# The card

```yaml
type: custom:beoview-camera
```

The card shows the door camera with a status pill (*Nobody at the door*, *Someone is ringing*, *Live view*,
*On call* with a timer) and three buttons:

| Button | Does |
|---|---|
| **Hang up** | Ends the call or stops the video |
| **Open door** | Tap twice to confirm. Works while it rings or during a call |
| **Answer** | Starts two-way audio. During a call it becomes **Mute** / **Mic on** |

When nobody rings, the buttons are greyed out. Video starts by itself when someone rings, so you see who it is
before you answer.

## Options

All optional. The defaults match the add-on, so most people never set any.

| Option | Default | What it does |
|---|---|---|
| `language` | browser language | `en` or `nl` for the labels |
| `replies` | your own replies + built-in ones when switched on | Quick-reply buttons, see below |
| `ring_sound` | `false` | Plays a soft chime once per ring. Meant for a view you cast to a display on a ring |
| `cloud_entity` | none | A camera entity used to get Home Assistant Cloud's relay servers, for watching outside your home |
| `cloud_relay_only` | `false` | Always use the relay. Set it with `cloud_entity` if video fails on 4G |
| `muted` | `true` | Start with sound off until you tap Answer (browsers require a tap before playing sound) |
| `debug` | `false` | Shows connection details above the video |
| `call_state_entity`, `call` | the add-on's entities | Only needed if you renamed the Beoview entities |

The card is built on AlexxIT's WebRTC Camera card, so its options (`mode`, `media`, `poster`, `ptz`, `shortcuts`,
...) work too.

## Quick replies

Quick replies play a recorded message at the door with one tap. Tapping one answers the call if needed, plays the
clip, and **never opens the door or turns your microphone on**. You hear the visitor; they hear the clip.

**Built-in Dutch replies**: Deur is open, Even duwen, Ik kom eraan, Pakket in de hal, Geen interesse. Turn them
on or off with the switch in **Beoview** (sidebar) → **Quick replies**. Until you choose, they're on when Home
Assistant's language is Dutch and off otherwise.

**Add your own in three steps:**

1. Make an audio file and **name it what the button should say**, for example `I'm coming.mp3` or
   `Leave it at the door.m4a`. A voice recording on your phone works, and so does any text-to-speech website or
   app (Home Assistant's own text-to-speech too). mp3, m4a, wav, ogg, flac and aac all work.
2. Open **Beoview** in the sidebar → **Quick replies** → **Add an audio file**, and pick one or more files.
3. That's it. The add-on converts each file for the door speaker, and the button appears in every Beoview card
   within a second or two, labelled with the file name.

Remove a reply with **Remove** in the same list. A file named like a built-in clip replaces it (for example
`Even duwen.mp3`).

You can also drop files into the add-on's config folder (`/addon_configs/<id>_beoview/replies/`, reachable with
the Samba or File editor add-on) and restart the add-on; they're converted and named the same way.

**Choosing the buttons yourself:** by default the card shows your own replies plus the built-in ones when
they're switched on. To pick which ones, and their order, set `replies` in the card. The `name` is the file name in lowercase
with `_` for spaces; the **Quick replies** sensor (`sensor.beoview_intercom_quick_replies`) lists every name:

```yaml
type: custom:beoview-camera
replies:
  - name: im_coming
    label: Coming!
  - name: open        # a built-in Dutch clip with your own label
    label: Door's open
```

## Watching from outside your home

At home over Wi-Fi, video connects straight to the add-on (port 8555 on your Home Assistant machine). On 4G
or another network it needs a relay server.

> [!CAUTION]
> **With Home Assistant Cloud (Nabu Casa) this only works when set up exactly like below.** Without the Generic
> Camera and the two card lines, video works at home but stays black on 4G.

**With Home Assistant Cloud (Nabu Casa):**

1. Settings → Devices & services → Add integration → **Generic Camera**. Stream source:
   `rtsp://<add-on hostname>:8554/door` (hostname on the add-on's Info tab). Leave the still image empty.
2. Use that camera in the card:

   ```yaml
   type: custom:beoview-camera
   cloud_entity: camera.your_generic_camera
   cloud_relay_only: true
   ```

**Without Home Assistant Cloud** you need your own TURN server or a VPN (Tailscale, WireGuard) to your home.
On a VPN the card works as if you were home.

## A display that shows the door when it rings

Make a dashboard view with only the card, as a **panel** view (full screen), with `ring_sound: true`, and cast it
on a ring with the [cast blueprint](automations.md#cast-to-a-google-display-when-someone-rings). On a 1024×600
display such as the Nest Hub the card switches to a landscape layout with large buttons.
