# Installation

About 15 minutes, most of it waiting for installs. You need to be able to stand at your intercom module once.

## Before you start

| You need | Why | Where |
|---|---|---|
| A **BWCM.01 Wi-Fi module** connected to your Beoview intercom (or a monitor with built-in Wi-Fi: may work, untested) | It's the bridge to the Beoview cloud | See [Getting the module](#getting-the-module) |
| **Home Assistant OS** or Supervised | Add-ons only run there (not in a plain Docker/Core install) | Settings → About shows your installation type |
| **Mosquitto broker** add-on, started | The add-on creates its entities over MQTT | Settings → Add-ons → Add-on store → Mosquitto broker |
| **MQTT** integration | Home Assistant's side of MQTT | Usually offered automatically once Mosquitto runs |
| **HACS** | To install WebRTC Camera | [hacs.xyz](https://hacs.xyz/docs/use/) |
| **WebRTC Camera** (by AlexxIT) from HACS | The card streams video through it | HACS → search "WebRTC Camera" → Download, then restart Home Assistant |

### First time with the module: connect it to Wi-Fi with the Beoview app

A brand-new module isn't on your network yet, and only the official app can put it there:

1. Install the **Beoview** app on your phone (App Store / Google Play).
2. Follow the app to connect the module to your Wi-Fi.
3. **Wait a minute or two.** Right after connecting, the module usually can't register devices yet.
4. On the module's screen, open the menu to add a device. Once it shows a **QR code**, it's ready, and you
   continue with this guide. (You can keep using the app afterwards; the app and this add-on work side by side.)

Already using the app with your intercom? Then your module is on Wi-Fi and you can skip this.

### Getting the module

The BWCM.01 is officially sold through installers. In the Netherlands, Beoview Benelux has sold single
modules to individuals: email their sales address and ask for a one-off purchase. If your monitor's firmware is
older than the module needs (the module docs ask for 3.50 or newer), ask them to update it. Some users had it
done at the Beoview office while picking up the module. The monitor slides off its wall plate with the release
button at the bottom; unplug the PoE cable (and the green power adapter if yours has one) to take it with you.

## 1. Add the repository

[![Add repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FBlacksuite%2Fbeoview-ha)

Or by hand: Settings → Add-ons → Add-on store → ⋮ (top right) → Repositories → add
`https://github.com/Blacksuite/beoview-ha` → Close.

## 2. Install and start the add-on

Find **Beoview Intercom** in the store (refresh the page if it doesn't show), Install, then Start.
The first install builds the image on your machine and takes a few minutes.

On first start the add-on:

- copies the dashboard card into `/config/www/beoview/` and registers it as a dashboard resource,
- creates the **Beoview intercom** device under MQTT (its entities stay *unavailable* until step 3),
- puts **Beoview** in your sidebar, ready for setup.

## 3. Connect your intercom (QR code)

1. Open the Home Assistant **app on your phone** and tap **Beoview** in the sidebar.
2. At the BWCM.01 module screen, open its menu and **add a new device**. A QR code appears.
3. In the panel, tap **Take a photo of the QR code** and photograph the screen, straight on and sharp.
4. You see **✓ Connected**. The entities come alive within a few seconds.

The code in the QR works once. If it says the code was refused, make a new QR code on the module and try again.

No camera at hand? Scan the QR code with any QR scanner app, copy the text, and paste it under
**Or paste the code** in the panel. (You can also put it in the add-on's Configuration tab as
`registration_token` and restart, which is handy for automated setups.)

## 4. Set up WebRTC Camera

Settings → Devices & services → Add integration → **WebRTC Camera**. It asks for a go2rtc URL: enter
`http://<add-on hostname>:1984`. The hostname is on the add-on's **Info** tab, something like
`a1b2c3d4-beoview`, so the URL becomes `http://a1b2c3d4-beoview:1984`.

## 5. Add the card

Edit a dashboard → Add card → Manual, and paste:

```yaml
type: custom:beoview-camera
```

No other settings are needed. Ring your doorbell: the card should switch to **Live view** within a second or
two. Options are in [The card](card.md).

## 6. Optional extras

- **Phone push with a snapshot** and **cast to a Nest Hub**: [Automations](automations.md#blueprints)
- **Your own quick replies**: [The card → Quick replies](card.md#quick-replies)
- **Watch from outside your home** (4G): [The card → Outside your home](card.md#watching-from-outside-your-home)

## Updating

Updates show up like any add-on update. The card updates with the add-on; reload the dashboard once
afterwards (or clear the app cache) if it still looks old.

## Uninstalling

Uninstall the add-on, remove the **Beoview intercom** device under MQTT, and delete `/config/www/beoview/` and the
`/local/beoview/beoview-camera.js` dashboard resource. On the module, remove the "HomeAssistant" device.
