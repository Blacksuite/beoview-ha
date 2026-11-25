/** Chrome 63+, Safari 11.1+ */
import {VideoRTC} from './beoview-video-rtc.js?v=1.9.9';
import {DigitalPTZ} from './digital-ptz.js?v=3.3.0';

// Labels follow the config's `language`, else the browser. Dutch ships with recorded quick replies; English has none by default.
const T = {
    nl: {idle: 'Niemand bij de deur', ringing: 'Er wordt aangebeld', connecting: 'Verbinden…', viewing: 'Live beeld', talking: 'In gesprek',
        hangup: 'Ophangen', unlock: 'Deur open', answer: 'Opnemen', again: 'Tik nogmaals', mute: 'Dempen', micOn: 'Mic aan', soundOn: 'Geluid aan'},
    en: {idle: 'Nobody at the door', ringing: 'Someone is ringing', connecting: 'Connecting…', viewing: 'Live view', talking: 'On call',
        hangup: 'Hang up', unlock: 'Open door', answer: 'Answer', again: 'Tap again', mute: 'Mute', micOn: 'Mic on', soundOn: 'Sound on'},
};
const DEFAULT_REPLIES = {nl: [{name: 'open', label: 'Deur is open'}, {name: 'duwen', label: 'Even duwen'}, {name: 'ik_kom', label: 'Ik kom eraan'},
    {name: 'hal', label: 'Pakket in de hal'}, {name: 'nee', label: 'Geen interesse'}], en: []};
const REPLIES_ENTITY = 'sensor.beoview_intercom_quick_replies';
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
// Zero-config: `type: custom:beoview-camera` alone works. The add-on fills in its own go2rtc address at install.
const DEFAULTS = {
    server: '__BEOVIEW_SERVER__', url: 'door', mode: 'webrtc,mse', media: 'video,audio,microphone', muted: true, ui: true,
    poster: '/api/camera_proxy/camera.beoview_intercom_door_snapshot',
    call_state_entity: 'sensor.beoview_intercom_call_state',
    call: {answer: 'button.beoview_intercom_answer', unlock: 'button.beoview_intercom_unlock_door', hangup: 'button.beoview_intercom_hang_up'},
};

class WebRTCCamera extends VideoRTC {
    /**
     * Step 1. Called by the Hass, when config changed.
     * @param {Object} config
     */
    setConfig(config) {
        const lang = config.language || ((navigator.language || 'en').toLowerCase().startsWith('nl') ? 'nl' : 'en');
        this.t = T[lang] || T.en;
        this.lang = lang;
        // No `replies` in the config: follow the add-on's quick-reply list (sensor attribute), so an uploaded clip just appears.
        this.autoReplies = !('replies' in config);
        config = {...DEFAULTS, replies: DEFAULT_REPLIES[lang] || [], ...config};
        if (config.server === '__BEOVIEW_SERVER__') delete config.server; // card used outside the add-on: fall back to the WebRTC integration's own server
        if (!config.url && !config.entity && !config.streams) throw new Error('Missing `url` or `entity` or `streams`');

        if (config.background) this.background = config.background;

        if (config.intersection === 0) this.visibilityThreshold = 0;
        else this.visibilityThreshold = config.intersection || 0.75;

        /**
         * @type {{
         *     url: string,
         *     entity: string,
         *     mode: string,
         *     media: string,
         *
         *     streams: Array<{
         *         name: string,
         *         url: string,
         *         entity: string,
         *         mode: string,
         *         media: string,
         *     }>,
         *
         *     title: string,
         *     poster: string,
         *     poster_remote: boolean,
         *     muted: boolean,
         *     intersection: number,
         *     ui: boolean,
         *     style: string,
         *     background: boolean,
         *
         *     server: string,
         *     cloud_entity: string,
         *
         *     mse: boolean,
         *     webrtc: boolean,
         *
         *     digital_ptz:{
         *         mouse_drag_pan: boolean,
         *         mouse_wheel_zoom: boolean,
         *         mouse_double_click_zoom: boolean,
         *         touch_pinch_zoom: boolean,
         *         touch_drag_pan: boolean,
         *         touch_tap_drag_zoom: boolean,
         *         persist: boolean|string,
         *     },
         *     ptz:{
         *         opacity: number|string,
         *         service: string,
         *         data_left, data_up, data_right, data_down, data_zoom_in, data_zoom_out, data_home
         *     },
         *     shortcuts:Array<{ name:string, icon:string }>,
         * }} config
         */
        this.config = Object.assign({
            mode: config.mse === false ? 'webrtc' : config.webrtc === false ? 'mse' : this.mode,
            media: this.media,
            streams: [{url: config.url, entity: config.entity}],
            poster_remote: config.poster && (config.poster.indexOf('://') > 0 || config.poster.charAt(0) === '/'),
        }, config);

        // Beoview: the mic track is negotiated once, at connect. The bridge only forwards mic audio while the
        // call is "talking", so an always-on mic track is safe; reconnecting on talking broke video (v4, rolled back).
        this.wasTalking = false;

        this.streamID = -1;
        this.nextStream(false);

        this.onhass = [];
    }

    set hass(hass) {
        this._hass = hass;
        const qr = this.autoReplies && hass.states[REPLIES_ENTITY];
        if (qr && Array.isArray(qr.attributes.replies)) {
            // The add-on decides: your own uploads, plus the built-in Dutch ones when switched on in the Beoview panel.
            const list = qr.attributes.replies.map(r => ({name: r.name, label: r.label}));
            const key = JSON.stringify(list);
            if (key !== this.repliesKey) { this.repliesKey = key; this.config.replies = list; if (this.callUI) this.renderReplies(); }
        }
        if (this.config.call_state_entity) {
            const state = hass.states[this.config.call_state_entity];
            this.syncCallAudio(state ? state.state : 'idle');
            if (this.callUI) this.updateCall(state);
        }
        this.onhass.forEach(fn => fn());
        // if card in vertical stack - `hass` property assign after `onconnect`
        // this.onconnect();
    }

    syncCallAudio(state) {
        if (this.config.call) return; // call screen unmutes inside the Opnemen tap; this retry would undo a manual mute
        const talking = state === 'talking';
        if (talking && !this.wasTalking) {
            // Pick-up: unmute. The user's tap on "Opnemen" grants the browser's audio permission, but the
            // audio track / video element may not be ready that instant, so retry for ~3 s until it sticks.
            this.wasTalking = true;
            let tries = 0;
            const unmute = () => {
                if (!this.wasTalking) return;
                if (this.video) {
                    this.video.muted = false;
                    this.video.volume = 1;
                    this.video.play().catch(() => {});
                }
                if (++tries < 12) setTimeout(unmute, 250);
            };
            unmute();
        } else if (!talking) {
            this.wasTalking = false;
        }
    }

    get hass() {
        return this._hass;
    }

    /**
     * Called by the Hass to calculate default card height.
     */
    getCardSize() {
        return 5; // x 50px
    }

    /**
     * Called by the Hass to get defaul card config
     * @return {{url: string}}
     */
    static getStubConfig() {
        return {};
    }

    setStatus(mode, status) {
        const divMode = this.querySelector('.mode').innerText;
        if (mode === 'error' && divMode !== 'Loading..' && divMode !== 'Loading...') return;

        const detail = status || this.cloudIceSummary || '';
        this.querySelector('.mode').innerText = mode;
        this.querySelector('.status').innerText = detail + (this.cloudRtcError ? ' · ' + this.cloudRtcError : '');
    }

    /** @param reload {boolean} */
    nextStream(reload) {
        this.streamID = (this.streamID + 1) % this.config.streams.length;

        const stream = this.config.streams[this.streamID];
        this.config.url = stream.url;
        this.config.entity = stream.entity;
        this.mode = stream.mode || this.config.mode;
        this.media = stream.media || this.config.media;

        if (reload) {
            this.ondisconnect();
            setTimeout(() => this.onconnect(), 100); // wait ws.close event
        }
    }

    /** @return {string} */
    get streamName() {
        return this.config.streams[this.streamID].name || `S${this.streamID}`;
    }

    oninit() {
        super.oninit();
        this.renderMain();
        this.renderDigitalPTZ();
        this.renderPTZ();
        this.renderCustomUI();
        this.renderShortcuts();
        this.renderCall();
        this.renderStyle();
    }

    /**
     * Beoview call screen: status pill over the video, round call buttons in a dark bar below it.
     * Opnemen unmutes inside its own tap, because iOS only allows unmuted playback during a user gesture;
     * unmuting later from a hass state update is silently refused (v6 bug).
     */
    renderCall() {
        const c = this.config.call;
        if (!c || !this.config.call_state_entity) return;

        const card = this.querySelector('.card');
        if (!this.config.debug) this.querySelector('.header').style.display = 'none';
        card.insertAdjacentHTML('beforebegin', `
            <style>
                .card { background: #0c0c0e; font-family: 'Quicksand', ui-rounded, -apple-system, sans-serif; }
                .player { aspect-ratio: 4 / 3; height: auto; }
                .player video { width: 100%; height: 100%; object-fit: cover; }
                .pill {
                    position: absolute; top: 12px; left: 12px;
                    display: flex; align-items: center; gap: 8px;
                    padding: 6px 12px 6px 10px; border-radius: 999px;
                    background: rgba(0,0,0,.45); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
                    color: #fff; font-size: 14px; font-weight: 600; pointer-events: none;
                }
                .dot { width: 8px; height: 8px; border-radius: 50%; background: #8e8e93; }
                .s-ringing .dot, .s-connecting .dot { background: #ff9f0a; animation: blink 1s infinite; }
                .s-viewing .dot { background: #ff453a; }
                .s-talking .dot { background: #30d158; }
                .timer { font-variant-numeric: tabular-nums; opacity: .8; font-weight: 500; }
                .bar {
                    display: flex; justify-content: space-around; align-items: flex-start;
                    padding: 18px 12px 20px; background: #0c0c0e;
                }
                .btn {
                    display: flex; flex-direction: column; align-items: center; gap: 8px;
                    background: none; border: 0; padding: 0; color: #f2f2f7; cursor: pointer;
                    font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1.2; min-width: 84px;
                    -webkit-tap-highlight-color: transparent; transition: opacity .2s;
                }
                .btn:disabled { opacity: .35; cursor: default; }
                .disc {
                    width: 64px; height: 64px; border-radius: 50%;
                    display: grid; place-items: center; transition: transform .12s, background .2s;
                }
                .btn:not(:disabled):active .disc { transform: scale(.92); }
                .disc ha-icon { --mdc-icon-size: 30px; color: #fff; pointer-events: none; }
                .hangup .disc { background: #ff3b30; }
                .unlock .disc { background: rgba(255,255,255,.16); }
                .unlock.armed .disc { background: #ff9f0a; }
                .answer .disc { background: #34c759; }
                .answer.sound .disc { background: rgba(255,255,255,.16); }
                .answer.sound.muted .disc { background: #fff; }
                .answer.sound.muted .disc ha-icon { color: #0c0c0e; }
                .s-ringing .answer .disc, .answer.sound.muted .disc { animation: ring 1.4s infinite; }
                @keyframes blink { 50% { opacity: .3; } }
                @keyframes ring {
                    0% { box-shadow: 0 0 0 0 rgba(52,199,89,.6); }
                    100% { box-shadow: 0 0 0 16px rgba(52,199,89,0); }
                }
                .replies { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; padding: 14px 12px 0; background: #0c0c0e; }
                .chip {
                    flex: none; padding: 9px 14px; border-radius: 999px; border: 0; cursor: pointer;
                    background: rgba(255,255,255,.12); color: #f2f2f7;
                    font-family: inherit; font-size: 14px; font-weight: 600; line-height: 1;
                    -webkit-tap-highlight-color: transparent; transition: background .2s, opacity .2s;
                }
                .chip:disabled { opacity: .35; cursor: default; }
                .chip:not(:disabled):active { background: rgba(255,255,255,.24); }
                .chip.armed { background: #ff9f0a; }
                .chip.sent { background: #34c759; }
                /* Short landscape screens (Nest Hub 1024x600): a 4:3 video at full width would push every control
                   below the screen, so the video takes the left and the controls stack in a column on the right. */
                @media (orientation: landscape) and (max-height: 720px) {
                    :host { display: block; height: 100%; }
                    .card { display: grid; grid-template-columns: minmax(0, 1fr) 280px; grid-template-rows: 1fr auto; height: 100%; min-height: 0; }
                    .player { grid-row: 1 / 3; aspect-ratio: auto; height: 100%; }
                    .player video { object-fit: contain; }
                    /* Reply chips share the column's full height; call buttons get bigger touch targets. */
                    .replies { flex-direction: column; flex-wrap: nowrap; align-items: stretch; justify-content: stretch; padding: 14px 14px 4px; min-height: 0; }
                    .chip { flex: 1 1 0; min-height: 48px; border-radius: 18px; font-size: 20px; }
                    .bar { padding: 10px 6px 16px; }
                    .btn { min-width: 0; flex: 1; font-size: 14px; }
                    .disc { width: 76px; height: 76px; }
                    .disc ha-icon { --mdc-icon-size: 36px; }
                }
                @media (prefers-reduced-motion: reduce) { .dot, .disc { animation: none !important; } }
            </style>
        `);
        card.querySelector('.player').insertAdjacentHTML('beforeend', `
            <div class="pill"><span class="dot"></span><span class="label">${this.t.idle}</span><span class="timer"></span></div>
        `);
        card.insertAdjacentHTML('beforeend', `
            <div class="bar">
                <button class="btn hangup" disabled><span class="disc"><ha-icon icon="mdi:phone-hangup"></ha-icon></span><span class="txt">${this.t.hangup}</span></button>
                <button class="btn unlock" disabled><span class="disc"><ha-icon icon="mdi:door-open"></ha-icon></span><span class="txt">${this.t.unlock}</span></button>
                <button class="btn answer" disabled><span class="disc"><ha-icon icon="mdi:phone"></ha-icon></span><span class="txt">${this.t.answer}</span></button>
            </div>
        `);

        const stockUI = card.querySelector('.ui');
        if (stockUI) {
            card.querySelector('.player').appendChild(stockUI); // fullscreen/spinner stay on the video, not over the bar
            stockUI.querySelectorAll('.screenshot, .pictureinpicture').forEach(e => e.remove());
        }
        const q = s => this.querySelector(s);
        this.callUI = {pill: q('.pill'), label: q('.pill .label'), timer: q('.pill .timer'),
            hangup: q('.hangup'), unlock: q('.unlock'), answer: q('.answer'), bar: q('.bar')};
        const press = entity => this.hass.callService('button', 'press', {entity_id: entity});
        // Mic on/off without renegotiating: a disabled track sends silence, so video and the call stay up.
        const setMic = this.setMic = on => {
            this.micOn = on;
            if (this.pc) this.pc.getSenders().forEach(s => { if (s.track && s.track.kind === 'audio') s.track.enabled = on; });
        };
        this.micOn = true;
        const unmute = () => {
            this.video.muted = false;
            setMic(true);
            this.video.play().catch(() => {});
        };

        this.callUI.answer.addEventListener('click', () => {
            if (this.callState === 'talking') {
                // Talking: mic on = "Dempen" (sound and mic off together); mic off = turn both on.
                // After a quick reply the mic is off while sound is on, so this is how you start talking.
                if (this.micOn && !this.video.muted) { this.video.muted = true; setMic(false); }
                else unmute();
                this.updateCall();
                return;
            }
            unmute(); // synchronous, inside the tap: this is the iOS fix
            press(c.answer);
        });
        this.callUI.hangup.addEventListener('click', () => press(c.hangup));
        this.callUI.unlock.addEventListener('click', () => {
            const b = this.callUI.unlock;
            if (!b.classList.contains('armed')) {
                // ponytail: tap-twice confirm instead of a dialog; a dialog would cover the visitor's face
                b.classList.add('armed');
                b.querySelector('.txt').textContent = this.t.again;
                clearTimeout(this.armTimer);
                this.armTimer = setTimeout(() => this.disarmUnlock(), 3000);
                return;
            }
            this.disarmUnlock();
            press(c.unlock);
        });
        this.querySelectorAll = s => this.shadowRoot.querySelectorAll(s);
        this.renderReplies();
        this.video.addEventListener('volumechange', () => this.updateCall());
        // Opened from the push mid-ring: show the live state now, not at the next hass update.
        if (this.hass) this.updateCall(this.hass.states[this.config.call_state_entity]);
    }

    /** Quick-reply chips above the call bar; rebuilt when the add-on's reply list changes. */
    renderReplies() {
        const bar = this.callUI && this.callUI.bar;
        if (!bar) return;
        const old = bar.parentNode.querySelector('.replies');
        if (old) old.remove();
        const replies = this.config.replies || [];
        if (!replies.length) return;
        bar.insertAdjacentHTML('beforebegin', `<div class="replies">${replies.map((r, i) =>
            `<button class="chip" data-i="${i}" disabled>${esc(r.label)}</button>`).join('')}</div>`);
        // A reply never opens the door (by design) and never turns the mic on: you hear the visitor,
        // the door hears only the clip. The mic stays off until you turn it on with the call button.
        bar.parentNode.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
            const r = replies[chip.dataset.i];
            this.video.muted = false; this.video.play().catch(() => {}); // inside the tap: autoplay rule
            this.setMic(false);
            this.hass.callService('mqtt', 'publish', {topic: 'beoview/cmd', payload: 'say:' + r.name});
            chip.classList.add('sent'); setTimeout(() => chip.classList.remove('sent'), 1500);
            this.updateCall();
        }));
        this.updateCall();
    }

    chime() {
        try {
            const ctx = new AudioContext();
            [[660, 0], [523, 0.38], [660, 1.1], [523, 1.48]].forEach(([hz, at]) => {
                const o = ctx.createOscillator(), g = ctx.createGain();
                o.frequency.value = hz; o.connect(g); g.connect(ctx.destination);
                const t = ctx.currentTime + at;
                g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
                o.start(t); o.stop(t + 0.65);
            });
            setTimeout(() => ctx.close(), 2500);
        } catch (e) { console.warn('chime', e); }
    }

    disarmUnlock() {
        clearTimeout(this.armTimer);
        this.callUI.unlock.classList.remove('armed');
        this.callUI.unlock.querySelector('.txt').textContent = this.t.unlock;
    }

    updateCall(stateObj) {
        const ui = this.callUI;
        if (stateObj) {
            this.callState = stateObj.state;
            this.callSince = new Date(stateObj.last_changed).getTime();
        }
        const s = ['ringing', 'connecting', 'viewing', 'talking'].includes(this.callState) ? this.callState : 'idle'; // unavailable/unknown (not set up, add-on down) = idle
        const labels = this.t;
        this.querySelector('.card').className = 'card s-' + s;
        ui.label.textContent = (s !== 'idle' && labels[s]) || labels.idle;

        const active = s !== 'idle';
        // ring_sound (Hub view): a soft two-tone chime once per call. The view is cast after the ring, by when the
        // bridge has already auto-started video, so "first active state seen" counts as the ring, not just "ringing".
        // The Hub view is only cast because of a ring, so its first load chimes too (also makes the ring testable
        // by running the cast automation); after that, every idle -> active change chimes again.
        if (this.config.ring_sound) {
            if (!this.rang || (active && this.wasIdle)) this.chime();
            this.rang = true; this.wasIdle = !active;
        }
        ui.hangup.disabled = !active;
        ui.unlock.disabled = !active;
        ui.answer.disabled = !(s === 'ringing' || s === 'viewing' || s === 'talking');
        if (!active) this.disarmUnlock();
        this.shadowRoot.querySelectorAll('.chip').forEach(ch => { ch.disabled = !active; });

        const talking = s === 'talking';
        const muted = this.video.muted || this.micOn === false; // "off" means: you are not talking to the door
        const offLabel = this.video.muted ? this.t.soundOn : this.t.micOn;
        ui.answer.classList.toggle('sound', talking);
        ui.answer.classList.toggle('muted', talking && muted);
        ui.answer.querySelector('ha-icon').icon = talking ? (muted ? 'mdi:microphone-off' : 'mdi:microphone') : 'mdi:phone';
        ui.answer.querySelector('.txt').textContent = talking ? (muted ? offLabel : this.t.mute) : this.t.answer;

        clearInterval(this.callTick);
        ui.timer.textContent = '';
        if (talking) {
            const tick = () => {
                const t = Math.max(0, Math.floor((Date.now() - this.callSince) / 1000));
                ui.timer.textContent = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
            };
            tick();
            this.callTick = setInterval(tick, 1000);
        }
    }

    onconnect() {
        if (!this.config || !this.hass) return false;
        if (!this.isConnected || this.ws || this.pc) return false;

        const divMode = this.querySelector('.mode').innerText;
        if (divMode === 'Loading..') return;

        this.setStatus('Loading..');

        const cloudConfig = this.config.cloud_entity ? this.hass.callWS({
            type: 'camera/webrtc/get_client_config', entity_id: this.config.cloud_entity
        }).then(data => {
            this.pcConfig = Object.assign({}, this.pcConfig, data.configuration);
            this.cloudIceSummary = (data.configuration.iceServers || [])
                .flatMap(server => server.urls).map(url => url.split(':')[0]).join(',') || 'no ICE';
            this.cloudRtcError = '';
            if (this.config.cloud_relay_only) this.pcConfig.iceTransportPolicy = 'relay';
            this.cloudWebRTC = true;
        }) : Promise.resolve();

        cloudConfig.then(() => this.hass.callWS({
            type: 'auth/sign_path', path: '/api/webrtc/ws'
        })).then(data => {
            if (this.config.poster && !this.config.poster_remote) {
                this.video.poster = this.hass.hassUrl(data.path) + '&poster=' + encodeURIComponent(this.config.poster);
            }

            this.wsURL = 'ws' + this.hass.hassUrl(data.path).substring(4);

            if (this.config.entity) {
                this.wsURL += '&entity=' + this.config.entity;
            } else if (this.config.url) {
                this.wsURL += '&url=' + encodeURIComponent(this.config.url);
            } else {
                this.setStatus('IMG');
                return;
            }

            if (this.config.server) {
                this.wsURL += '&server=' + encodeURIComponent(this.config.server);
            }

            if (super.onconnect()) {
                this.setStatus('Loading...');
            } else {
                this.setStatus('error', 'unable to connect');
            }
        }).catch(er => {
            this.setStatus('error', er);
        });
    }

    onopen() {
        const result = super.onopen();

        this.onmessage['stream'] = msg => {
            switch (msg.type) {
                case 'error':
                    this.setStatus('error', msg.value);
                    break;
                case 'mse':
                case 'hls':
                case 'mp4':
                case 'mjpeg':
                    this.setStatus(msg.type.toUpperCase(), this.config.title || '');
                    break;
            }
        };

        return result;
    }

    onpcvideo(ev) {
        super.onpcvideo(ev);

        if (this.pcState !== WebSocket.CLOSED) {
            this.setStatus('RTC', this.config.title || '');
        }
    }

    renderMain() {
        const shadow = this.attachShadow({mode: 'open'});
        shadow.innerHTML = `
        <style>
            ha-card {
                width: 100%;
                height: 100%;
                margin: auto;
                overflow: hidden;
                position: relative;
            }
            ha-icon {
                color: white;
                cursor: pointer;
            }
            .player {
                background-color: black;
                height: 100%;
                position: relative; /* important for Safari */
            }
            .player:active {
                cursor: move; /* important for zoom-controller */
            }
            .player .ptz-transform {
                height: 100%;
            }
            .header {
                position: absolute;
                top: 6px;
                left: 10px;
                right: 10px;
                color: white;
                display: flex;
                justify-content: space-between;
                pointer-events: none;
            }
            .mode {
                cursor: pointer;
                opacity: 0.6;
                pointer-events: auto;
            }
        </style>
        <ha-card class="card">
            <div class="player">
                <div class="ptz-transform"></div>
            </div>
            <div class="header">
                <div class="status"></div>
                <div class="mode"></div>
            </div>
        </ha-card>
        `;

        this.querySelector = selectors => this.shadowRoot.querySelector(selectors);
        this.querySelector('.ptz-transform').appendChild(this.video);

        const mode = this.querySelector('.mode');
        mode.addEventListener('click', () => this.nextStream(true));

        if (this.config.muted) this.video.muted = true;
        if (this.config.poster_remote) this.video.poster = this.config.poster;
    }

    renderDigitalPTZ() {
        if (this.config.digital_ptz === false) return;
        new DigitalPTZ(
            this.querySelector('.player'),
            this.querySelector('.player .ptz-transform'),
            this.video,
            Object.assign({}, this.config.digital_ptz, {persist_key: this.config.url})
        );
    }

    renderPTZ() {
        if (!this.config.ptz || !this.config.ptz.service) return;

        let hasMove = false;
        let hasZoom = false;
        let hasHome = false;
        for (const prefix of ['', '_start', '_end', '_long']) {
            hasMove = hasMove || this.config.ptz['data' + prefix + '_right'];
            hasMove = hasMove || this.config.ptz['data' + prefix + '_left'];
            hasMove = hasMove || this.config.ptz['data' + prefix + '_up'];
            hasMove = hasMove || this.config.ptz['data' + prefix + '_down'];

            hasZoom = hasZoom || this.config.ptz['data' + prefix + '_zoom_in'];
            hasZoom = hasZoom || this.config.ptz['data' + prefix + '_zoom_out'];

            hasHome = hasHome || this.config.ptz['data' + prefix + '_home'];
        }

        const card = this.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
            <style>
                .ptz {
                    position: absolute;
                    top: 50%;
                    right: 10px;
                    transform: translateY(-50%);
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    transition: opacity .3s ease-in-out;
                    opacity: ${parseFloat(this.config.ptz.opacity) || 0.4};
                }
                .ptz:hover {
                    opacity: 1 !important;
                }
                .ptz-move {
                    position: relative;
                    background-color: rgba(0, 0, 0, 0.3);
                    border-radius: 50%;
                    width: 80px;
                    height: 80px;
                    display: ${hasMove ? 'block' : 'none'};
                }
                .ptz-zoom {
                    position: relative;
                    width: 80px;
                    height: 40px;
                    background-color: rgba(0, 0, 0, 0.3);
                    border-radius: 4px;
                    display: ${hasZoom ? 'block' : 'none'};
                }
                .ptz-home {
                    position: relative;
                    width: 40px;
                    height: 40px;
                    background-color: rgba(0, 0, 0, 0.3);
                    border-radius: 4px;
                    align-self: center;
                    display: ${hasHome ? 'block' : 'none'};
                }
                .up {
                    position: absolute;
                    top: 5px;
                    left: 50%;
                    transform: translateX(-50%);
                }
                .down {
                    position: absolute;
                    bottom: 5px;
                    left: 50%;
                    transform: translateX(-50%);
                }
                .left {
                    position: absolute;
                    left: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .right {
                    position: absolute;
                    right: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .zoom_out {
                    position: absolute;
                    left: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .zoom_in {
                    position: absolute;
                    right: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .home {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                }
            </style>
        `);
        card.insertAdjacentHTML('beforeend', `
            <div class="ptz">
                <div class="ptz-move">
                    <ha-icon class="right" icon="mdi:arrow-right"></ha-icon>
                    <ha-icon class="left" icon="mdi:arrow-left"></ha-icon>
                    <ha-icon class="up" icon="mdi:arrow-up"></ha-icon>
                    <ha-icon class="down" icon="mdi:arrow-down"></ha-icon>
                </div>
                <div class="ptz-zoom">
                    <ha-icon class="zoom_in" icon="mdi:plus"></ha-icon>
                    <ha-icon class="zoom_out" icon="mdi:minus"></ha-icon>
                </div>
                <div class="ptz-home">
                    <ha-icon class="home" icon="mdi:home"></ha-icon>
                </div>
            </div>
        `);

        const template = JSON.stringify(this.config.ptz);
        const handle = path => {
            if (!this.config.ptz['data_' + path]) return;
            const config = template.indexOf('${') < 0 ? this.config.ptz : JSON.parse(eval('`' + template + '`'));
            const [domain, service] = config.service.split('.', 2);
            const data = config['data_' + path];
            this.hass.callService(domain, service, data);
        };
        const ptz = this.querySelector('.ptz');
        for (const [start, end] of [['touchstart', 'touchend'], ['mousedown', 'mouseup']]) {
            ptz.addEventListener(start, startEvt => {
                const {className} = startEvt.target;
                startEvt.preventDefault();
                handle('start_' + className);
                window.addEventListener(end, endEvt => {
                    endEvt.preventDefault();
                    handle('end_' + className);
                    if (endEvt.timeStamp - startEvt.timeStamp > 400) {
                        handle('long_' + className);
                    } else {
                        handle(className);
                    }
                }, {once: true});
            });
        }
    }

    saveScreenshot() {
        const a = document.createElement('a');

        if (this.video.videoWidth && this.video.videoHeight) {
            const canvas = document.createElement('canvas');
            canvas.width = this.video.videoWidth;
            canvas.height = this.video.videoHeight;
            canvas.getContext('2d').drawImage(this.video, 0, 0, canvas.width, canvas.height);
            a.href = canvas.toDataURL('image/jpeg');
        } else if (this.video.poster && this.video.poster.startsWith('data:image/jpeg')) {
            a.href = this.video.poster;
        } else {
            return;
        }

        const ts = new Date().toISOString().substring(0, 19).replaceAll('-', '').replaceAll(':', '');
        a.download = `snapshot_${ts}.jpeg`;
        a.click();
    }

    renderCustomUI() {
        if (!this.config.ui) return;

        this.video.controls = false;
        this.video.style.pointerEvents = 'none';

        const card = this.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
            <style>
                .spinner {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                }
                .controls {
                    position: absolute;
                    left: 5px;
                    right: 5px;
                    bottom: 5px;
                    display: flex;
                }
                .space {
                    width: 100%;
                }
                .volume {
                    display: none;
                }
                .stream {
                    padding-top: 2px;
                    margin-left: 2px;
                    font-weight: 400;
                    font-size: 20px;
                    color: white;
                    display: none;
                    cursor: pointer;
                }
            </style>
        `);
        card.insertAdjacentHTML('beforeend', `
            <div class="ui">
                <ha-circular-progress class="spinner"></ha-circular-progress>
                <div class="controls">
                    <ha-icon class="fullscreen" icon="mdi:fullscreen"></ha-icon>
                    <ha-icon class="screenshot" icon="mdi:floppy"></ha-icon>
                    <ha-icon class="pictureinpicture" icon="mdi:picture-in-picture-bottom-right"></ha-icon>
                    <span class="stream">${this.streamName}</span>
                    <span class="space"></span>
                    <ha-icon class="play" icon="mdi:play"></ha-icon>
                    <ha-icon class="volume" icon="mdi:volume-high"></ha-icon>
                </div>
            </div>
        `);

        const video = this.video;

        const fullscreen = this.querySelector('.fullscreen');
        if (this.requestFullscreen) {
            this.addEventListener('fullscreenchange', () => {
                fullscreen.icon = document.fullscreenElement ? 'mdi:fullscreen-exit' : 'mdi:fullscreen';
            });
        } else if (video.webkitEnterFullscreen) {
            this.requestFullscreen = () => new Promise((resolve, reject) => {
                try {
                    video.webkitEnterFullscreen();
                } catch (e) {
                    reject(e);
                }
            });
            video.addEventListener('webkitendfullscreen', () => {
                setTimeout(() => this.play(), 1000); // fix bug in iOS
            });
        } else {
            fullscreen.style.display = 'none';
        }

        const pip = this.querySelector('.pictureinpicture');
        if (video.requestPictureInPicture) {
            video.addEventListener('enterpictureinpicture', () => {
                pip.icon = 'mdi:rectangle';
                this.background = true;
            });
            video.addEventListener('leavepictureinpicture', () => {
                pip.icon = 'mdi:picture-in-picture-bottom-right';
                this.background = this.config.background;
                this.play();
            });
        } else {
            pip.style.display = 'none';
        }

        const ui = this.querySelector('.ui');
        ui.addEventListener('click', ev => {
            const icon = ev.target.icon;
            if (icon === 'mdi:play') {
                this.play();
            } else if (icon === 'mdi:volume-mute') {
                video.muted = false;
            } else if (icon === 'mdi:volume-high') {
                video.muted = true;
            } else if (icon === 'mdi:fullscreen') {
                this.requestFullscreen().catch(console.warn);
            } else if (icon === 'mdi:fullscreen-exit') {
                document.exitFullscreen().catch(console.warn);
            } else if (icon === 'mdi:floppy') {
                this.saveScreenshot();
            } else if (icon === 'mdi:picture-in-picture-bottom-right') {
                video.requestPictureInPicture().catch(console.warn);
            } else if (icon === 'mdi:rectangle') {
                document.exitPictureInPicture().catch(console.warn);
            } else if (ev.target.className === 'stream') {
                this.nextStream(true);
                ev.target.innerText = this.streamName;
            }
        });

        const spinner = this.querySelector('.spinner');
        video.addEventListener('waiting', () => {
            spinner.style.display = 'block';
        });
        video.addEventListener('playing', () => {
            spinner.style.display = 'none';
        });

        const play = this.querySelector('.play');
        video.addEventListener('play', () => {
            play.style.display = 'none';
        });
        video.addEventListener('pause', () => {
            play.style.display = 'block';
        });

        const volume = this.querySelector('.volume');
        video.addEventListener('loadeddata', () => {
            volume.style.display = this.hasAudio ? 'block' : 'none';
        });
        video.addEventListener('volumechange', () => {
            volume.icon = video.muted ? 'mdi:volume-mute' : 'mdi:volume-high';
            this.cloudRtcError = (this.trackKinds || '') + ' · ' + (video.muted ? 'muted' : 'unmuted') + ' · mic ' + (this.micState || 'off');
            this.setStatus(this.querySelector('.mode').innerText, '');
        });

        const stream = this.querySelector('.stream');
        stream.style.display = this.config.streams.length > 1 ? 'block' : 'none';
    }

    renderShortcuts() {
        if (!this.config.shortcuts) return;

        const card = this.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
            <style>
                .shortcuts {
                    position: absolute;
                    top: 5px;
                    left: 5px;
                }
            </style>
        `);
        card.insertAdjacentHTML('beforeend', '<div class="shortcuts"></div>');

        const shortcuts = this.querySelector('.shortcuts');
        shortcuts.addEventListener('click', ev => {
            const value = this.config.shortcuts[ev.target.dataset.index];
            if (value.more_info !== undefined) {
                const event = new Event('hass-more-info', {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                });
                event.detail = {entityId: value.more_info};
                ev.target.dispatchEvent(event);
            }
            if (value.service !== undefined) {
                const [domain, name] = value.service.split('.');
                this.hass.callService(domain, name, value.service_data || {});
            }
        });

        this.renderTemplate('shortcuts', () => {
            shortcuts.innerHTML = this.config.shortcuts.map((value, index) => `
                <ha-icon data-index="${index}" icon="${value.icon}" title="${value.name}"></ha-icon>
            `).join('');
        });
    }

    renderStyle() {
        if (!this.config.style) return;

        const style = document.createElement('style');
        const card = this.querySelector('.card');
        card.insertAdjacentElement('beforebegin', style);

        this.renderTemplate('style', () => {
            style.innerText = this.config.style;
        });
    }

    renderTemplate(name, renderHTML) {
        const config = this.config[name];
        // support config param as string or as object
        const template = typeof config === 'string' ? config : JSON.stringify(config);
        // check if config param has template
        if (template.indexOf('${') >= 0) {
            const render = () => {
                try {
                    const states = this.hass ? this.hass.states : undefined;
                    this.config[name] = JSON.parse(eval('`' + template + '`'));
                    renderHTML();
                } catch (e) {
                    console.debug(e);
                }
            };
            this.onhass.push(render);
            render();
        } else {
            renderHTML();
        }
    }

    get hasAudio() {
        return (
            (this.video.srcObject && this.video.srcObject.getAudioTracks && this.video.srcObject.getAudioTracks().length) ||
            (this.video.mozHasAudio || this.video.webkitAudioDecodedByteCount) ||
            (this.video.audioTracks && this.video.audioTracks.length)
        );
    }
}

// Own tag: the stock WebRTC integration also registers `webrtc-camera`, and whichever module loaded first won,
// so the patched card silently ran as the stock one on some loads (found 2026-11-25).
customElements.define('beoview-camera', WebRTCCamera);

const card = {
    type: 'beoview-camera',
    name: 'Beoview Camera',
    preview: false,
    description: 'WebRTC camera allows you to view the stream of almost any camera without delay',
};
// Apple iOS 12 doesn't support `||=`
if (window.customCards) window.customCards.push(card);
else window.customCards = [card];

