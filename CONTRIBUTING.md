# Contributing

Thanks for helping! Bug reports with logs, docs fixes and pull requests are all welcome.

## Dev setup

You need [Bun](https://bun.sh) and ffmpeg.

```bash
cd beoview
bun install
bun test        # unit tests: wire format, call states, quick replies, QR decode, setup guard
bun build bridge.ts --target=bun --outfile=/dev/null   # type/bundle check
```


## Testing on a real Home Assistant

Unit tests don't reach the Beoview cloud. For real changes, test on a **spare** Home Assistant OS install
(a VM is fine), never next to your everyday install on the same module: two bridges race for every ring.

The add-on store needs a git URL. To test a local branch without pushing, serve the repo over smart HTTP on your
LAN (`git http-backend`; Home Assistant clones with `--depth=1`, which plain static file serving can't do), add
`http://<your-ip>:<port>/<repo>.git` as a repository, and install. After each change: commit, bump `version` in
`beoview/config.yaml`, then in Home Assistant reload the store and update the add-on.

What to check on a change that touches calls: a real ring shows video in the card, Answer gives audio both ways
(over HTTPS), Open door opens it, a quick reply is heard at the door, and the add-on log shows no errors.

## Rules of the road

- **Keep it zero-config.** `type: custom:beoview-camera` and a QR photo must stay all a new user needs.
- **Quick replies never open the door and never turn the microphone on.**
- **Never log or print credentials** (`/data/beoview.json`, the QR token, MQTT passwords).
- **No personal data in the repo**: no real IPs, names, entity ids from your own home, or voice ids.
- Keep the door camera from staying on: every new path into a call needs a timeout.
- Small, focused pull requests with a line on how you tested.

## Releasing

1. Bump `version` in `beoview/config.yaml` (and `package.json`).
2. Add an entry to `beoview/CHANGELOG.md`; Home Assistant shows it in the update dialog.
3. Merge to `main`. Users get the update through the add-on store.
