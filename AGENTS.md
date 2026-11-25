# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, Copilot, ...) working on this repository.
Helping a user **install** the add-on instead? Read [docs/ai-setup.md](docs/ai-setup.md).

## What this is

A Home Assistant add-on that bridges Beoview / Golmar video intercoms (BWCM.01 Wi-Fi module) into Home Assistant
through the Beoview cloud, plus a dashboard card and blueprints. `bridge.ts` is one file with sections in this
order: wire helpers, call state machine, quick replies, cloud session, MQTT discovery, HTTP/media, first-run setup,
card install. Read the section you touch before changing it; the comments explain the non-obvious protocol facts.

## Layout

```
repository.yaml            add-on repository manifest
beoview/                   the add-on (Docker build context)
  config.yaml              add-on manifest: version, options, ingress, ports
  Dockerfile               go2rtc + Bun + ffmpeg
  bridge.ts                the bridge (single file, Bun/TypeScript)
  bridge.test.ts           tests (bun test)
  go2rtc.yaml              media pipeline
  setup.html               setup panel (ingress)
  card/                    dashboard card (fork of AlexxIT webrtc-camera)
  replies/                 built-in quick-reply clips (16 kHz mono s16le PCM)
  translations/            add-on option labels (en, nl)
  DOCS.md, CHANGELOG.md    shown inside Home Assistant
blueprints/automation/beoview/   ring → cast, ring → push
docs/                      user and contributor documentation
```

## Commands

```bash
cd beoview && bun install
bun test                                               # must pass before every commit
bun build bridge.ts --target=bun --outfile=/dev/null   # bundle/type check
```

Use Bun, not npm/node. The runtime is `oven/bun` on Alpine; ffmpeg is available there and in tests (tests that
need ffmpeg skip when it's missing).

## Hard rules

1. **Never print, log or commit credentials**: `/data/beoview.json`, QR/registration tokens, MQTT passwords,
   `SUPERVISOR_TOKEN`. Log that something happened, never the value.
2. **Never press unlock or send `unlock` on a real system without the human asking for it in that moment.** It
   opens a real front door.
3. **Quick replies must never unlock and never enable the microphone.**
4. **Every path that starts a call needs a timeout**, so the door camera never stays on.
5. **Zero config stays zero config**: a new feature gets a sensible default; `type: custom:beoview-camera` and a QR
   photo must remain all a new user needs.
6. **Setup endpoints answer only Home Assistant's ingress proxy** (`fromIngress`); keep that guard and its test.
7. **No personal data** (real IPs, names, entity ids from someone's home, voice ids) in code, docs, tests or commits.
8. **One bridge per module.** When testing against a real intercom, make sure no other bridge (another install of
   this add-on, or a similar project) runs for the same module, or rings will fail with `CALL_FAILED: spy_disabled`.

## Making changes

- Behaviour change in `bridge.ts` → add or update a test in `bridge.test.ts` that fails without your change.
- Card change → check it at phone width (375 px) and on a 1024×600 display layout; labels exist in `en` and `nl`.
- New user-visible option or entity → update `docs/card.md` or `docs/automations.md`, and `DOCS.md` if it affects setup.
- New log message a user might see → add it to `docs/troubleshooting.md` with what it means and the fix.
- Release → bump `version` in `beoview/config.yaml` and `package.json`, add a `beoview/CHANGELOG.md` entry.

## Testing on a real Home Assistant

See [CONTRIBUTING.md](CONTRIBUTING.md#testing-on-a-real-home-assistant). Useful read-only checks from a browser
console on a Home Assistant page (admin):

```js
const h = document.querySelector('home-assistant').hass;
await h.callWS({type:'supervisor/api', endpoint:'/addons/<slug>/info', method:'get'});      // state, version, ingress
await fetch('/api/hassio/addons/<slug>/logs', {headers:{Authorization:'Bearer '+h.auth.data.access_token}}).then(r=>r.text());
h.states['sensor.beoview_intercom_call_state'];
```

Useful log lines: `cloud connected, waiting for rings`, `DOORBELL from`, `state → viewing`, `unlock sent`,
`qr photo: ... decoded N chars`, `SETUP NEEDED`.

## Known gaps (good first contributions)

- Two installs on one module race for rings: an option to disable auto-view would let a second install coexist.
- aarch64 builds are untested on real hardware.
- English quick-reply clips (only Dutch ships).
- Talk has only been tested over HTTPS in the Home Assistant app and desktop browsers.
