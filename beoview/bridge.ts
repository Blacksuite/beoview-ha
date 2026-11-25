// src/bridge.ts — always-on Beoview doorbell bridge for Home Assistant.
// Holds the cert-pinned cloud gateway WebSocket (keepalive + auto-reconnect, from scripts/listen.ts),
// turns rings into MQTT-discovered HA entities, takes answer/hangup/unlock commands over MQTT, and
// serves the answered call's video as snapshot + MJPEG on the HA-internal network only.
// Protocol: docs/BUILD-JOURNAL.md (command map) and ISA.md decisions of 2026-11-24.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { X509Certificate, createHash, randomBytes } from "node:crypto";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import mqtt from "mqtt";
import jsQR from "jsqr";

const env = process.env;
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const CREDS_FILE = env.BEOVIEW_CREDS ?? (existsSync("/data") ? "/data/beoview.json" : here("./.beoview.local.json"));
const OPTIONS_FILE = env.BEOVIEW_OPTIONS ?? "/data/options.json"; // the add-on's settings (Supervisor writes it)
const PIN_FILE = env.BEOVIEW_PIN ?? here("./beoview-cloud-ca.pem");
const HTTP_PORT = Number(env.BEOVIEW_HTTP_PORT ?? 8766);
const MAX_CALL_MS = Number(env.BEOVIEW_MAX_CALL_MS ?? 180000); // ponytail: hard stop so a forgotten call never keeps the door camera on
const RING_MS = 60000; // fallback if CALL_INCOMING_OFF(55) never arrives
const AUTO_VIEW = env.BEOVIEW_AUTO_VIEW !== "0"; // a ring starts video at once (CALL without audio), like opening the app
const VIEW_MS = Number(env.BEOVIEW_VIEW_MS ?? 60000); // an unanswered view stops after this, so the door camera never stays on
const MIC_PORT = Number(env.BEOVIEW_MIC_PORT ?? 8767);
const IDLE_JPEG = readFileSync(env.BEOVIEW_IDLE_JPEG ?? here("./idle.jpg"));
const GO2RTC_CONFIG = env.GO2RTC_CONFIG; // set in the HA app image; go2rtc turns our MJPEG + PCM into WebRTC with a mic backchannel

type Creds = { deviceId: string; authKey: string };
let creds: Creds = { deviceId: "", authKey: "" };
const leaf = readFileSync(PIN_FILE, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
if (!leaf) throw new Error("missing pinned leaf certificate");
const PIN = new X509Certificate(leaf).fingerprint256;

const C = { CALL: 33, CALL_ACK: 34, CALL_FAILED: 35, ENABLE_AUDIO: 37, CALL_STOP: 42, CALL_STOPPED: 43, CALL_INCOMING: 47, VIDEO_OUT: 49, VIDEO_ACK: 50, AUDIO_OUT: 51, AUDIO_OUT_ACK: 52, AUDIO_IN: 53, AUDIO_IN_ACK: 54, CALL_INCOMING_OFF: 55, UNLOCK: 65, UNLOCK_STATUS: 66, HELLO: 0x20, SYNC: 0x85 } as const;

// idle → ringing → connecting (CALL sent) → viewing (video, no audio) → talking (ENABLE_AUDIO, both ways) → idle
export type CallState = "idle" | "ringing" | "connecting" | "viewing" | "talking";
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- wire helpers (exported for the self-check) ----------
export function wsframe(payload: Buffer, opcode = 0x2): Buffer {
  const mask = randomBytes(4);
  const n = payload.length;
  const header = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : Buffer.from([0x80 | opcode, 0xfe, (n >> 8) & 0xff, n & 0xff]);
  if (n > 0xffff) throw new Error("frame too large");
  return Buffer.concat([header, mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))]);
}
/** Pull complete WebSocket frames off the front of buf. */
export function parseFrames(buf: Buffer): { frames: { op: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { op: number; payload: Buffer }[] = [];
  while (buf.length >= 2) {
    const op = buf[0] & 0x0f; const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f; let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const mk = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
    if (buf.length < off + len) break;
    let p = buf.subarray(off, off + len); if (mk) p = Buffer.from(p.map((b, i) => b ^ mk[i & 3]));
    frames.push({ op, payload: Buffer.from(p) });
    buf = buf.subarray(off + len);
  }
  return { frames, rest: Buffer.from(buf) };
}
/** Reassemble JPEGs wherever their SOI/EOI markers land inside VIDEO_OUT payloads. */
export function jpegAssembler(onFrame: (jpg: Buffer) => void) {
  let acc = Buffer.alloc(0);
  const soiMarker = Buffer.from([0xff, 0xd8]);
  const eoiMarker = Buffer.from([0xff, 0xd9]);
  return (chunk: Buffer) => {
    acc = Buffer.concat([acc, chunk]);
    while (acc.length) {
      const soi = acc.indexOf(soiMarker);
      if (soi < 0) {
        acc = acc[acc.length - 1] === 0xff ? acc.subarray(-1) : Buffer.alloc(0);
        return;
      }
      const eoi = acc.indexOf(eoiMarker, soi + 2);
      if (eoi < 0) {
        acc = acc.subarray(soi);
        if (acc.length > 2_000_000) acc = Buffer.alloc(0); // garbage guard
        return;
      }
      onFrame(Buffer.from(acc.subarray(soi, eoi + 2)));
      acc = acc.subarray(eoi + 2);
    }
  };
}
const int32le = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const withId = (cmd: number, id: Buffer, ...extra: Buffer[]) => Buffer.concat([Buffer.from([cmd]), id, ...extra]);
const str = (p: Buffer, at: number) => p.subarray(at + 1, at + 1 + (p[at] ?? 0)).toString("utf8");

/** Door audio jitter buffer: bounded to 400 ms so latency cannot grow; take() pads with silence. */
export class PcmQueue {
  private q = Buffer.alloc(0);
  push(b: Buffer) { this.q = Buffer.concat([this.q, b]); if (this.q.length > 12800) this.q = this.q.subarray(this.q.length - 12800); }
  take(n: number): Buffer { const out = Buffer.alloc(n); const k = Math.min(n, this.q.length); this.q.copy(out, 0, 0, k); this.q = this.q.subarray(k); return out; }
  clear() { this.q = Buffer.alloc(0); }
  get length() { return this.q.length; }
}
/** Mic PCM → AUDIO_IN frames with the gateway flow control. Odd trailing bytes wait for the next chunk. */
export class MicSender {
  private pending = Buffer.alloc(0); private inflight = 0; private active = true;
  enabled = false;
  constructor(private out: (frame: Buffer) => void) {}
  feed(pcm: Buffer) {
    if (!this.enabled) return;
    this.pending = Buffer.concat([this.pending, pcm]);
    if (this.pending.length > 32000) this.pending = this.pending.subarray(this.pending.length - 32000); // drop stale mic audio, keep it live
    while (this.active && this.pending.length >= 2) {
      const n = Math.min(this.pending.length & ~1, 2048);
      this.out(Buffer.concat([Buffer.from([53]), this.pending.subarray(0, n)]));
      this.pending = this.pending.subarray(n); this.inflight += n;
      if (this.inflight >= 64000) this.active = false;
    }
  }
  acked(n: number) { this.inflight = Math.max(0, this.inflight - n); if (!this.active && this.inflight <= 32000) { this.active = true; this.feed(Buffer.alloc(0)); } }
  reset() { this.pending = Buffer.alloc(0); this.inflight = 0; this.active = true; this.enabled = false; }
}

// ---------- bridge state ----------
let ws: Socket | null = null;
let cloudUp = false;
let state: CallState = "idle";
let callId: Buffer | null = null;
let source = "";
let pendingUnlock = false;
let lastJpeg: Buffer | null = null;
let ringTimer: ReturnType<typeof setTimeout> | undefined;
let callTimer: ReturnType<typeof setTimeout> | undefined;
let audioOn = false;
let pendingTalk = false;
const stats = { frames: 0, doorBytes: 0, micBytes: 0 };
let lastFrameAt = 0;
const mjpegClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const pcmClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const doorPcm = new PcmQueue();

const send = (p: Buffer) => { try { ws?.write(wsframe(p)); } catch (e) { log("send failed", (e as Error).message); } };

function setState(s: CallState) {
  if (s === state) return;
  state = s; log("state →", s);
  pub("beoview/call_state", s, true);
  pub("beoview/ringing", isRinging() ? "ON" : "OFF", true);
  if (s === "idle") {
    if (stats.frames || stats.doorBytes || stats.micBytes) log(`call stats: ${stats.frames} video msgs, ${stats.doorBytes} B door audio, ${stats.micBytes} B mic`);
    Object.assign(stats, { frames: 0, doorBytes: 0, micBytes: 0 });
    callId = null; source = ""; pendingUnlock = false; pendingTalk = false; audioOn = false; reply = null; pendingReply = null; mic.reset(); doorPcm.clear(); clearTimeout(ringTimer); clearTimeout(callTimer);
  }
}

const isRinging = () => state === "ringing" || state === "connecting" || state === "viewing";
const inCall = () => state === "connecting" || state === "viewing" || state === "talking";

/** Start video for the ringing call (CALL with the incoming id). No audio yet. */
export function view(): string {
  if (state !== "ringing" || !callId) return `nothing to view (state ${state})`;
  send(withId(C.CALL, callId)); setState("connecting");
  clearTimeout(callTimer);
  callTimer = setTimeout(() => { if (state !== "talking") { log("view timed out unanswered"); hangup(); } }, VIEW_MS);
  return "viewing";
}
function talk() {
  if (!callId) return;
  send(withId(C.ENABLE_AUDIO, callId, Buffer.from([1]))); audioOn = true; mic.enabled = true; setState("talking");
  if (pendingReply) { reply = pendingReply; replyPos = 0; pendingReply = null; }
  clearTimeout(callTimer); callTimer = setTimeout(() => { log("max call time reached"); hangup(); }, MAX_CALL_MS);
}
/** Pick up: audio both ways. Starts video first if it is not running yet. */
export function answer(): string {
  if (state === "viewing") { talk(); return "talking"; }
  if (state === "connecting") { pendingTalk = true; return "talk queued until video is up"; }
  if (state === "ringing") { pendingTalk = true; view(); return "connecting, then talk"; }
  return `nothing to answer (state ${state})`;
}
export function hangup(): string {
  if (!callId) return "no call";
  if (inCall()) send(withId(C.CALL_STOP, callId));
  setState("idle"); // ponytail: declining a ring only clears our side; the monitor keeps ringing until the unit times out
  return "hung up";
}
export function unlock(): string {
  if (!callId) return "no call to unlock from"; // UNLOCK_DOOR only works inside a call (app: enterExclusive)
  if (state === "viewing" || state === "talking") { send(withId(C.UNLOCK, callId)); return "unlock sent"; }
  pendingUnlock = true; // no pick-up needed: a video call is enough for UNLOCK_DOOR
  return state === "ringing" ? (view(), "connecting, then unlock") : "unlock queued until video is up";
}

const assemble = jpegAssembler((jpg) => { lastJpeg = jpg; lastFrameAt = Date.now(); });
const mjpegPart = (jpg: Buffer) => Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`), jpg, Buffer.from("\r\n")]);
const fanout = (set: Set<ReadableStreamDefaultController<Uint8Array>>, b: Buffer) => { for (const c of set) { try { c.enqueue(b); } catch { set.delete(c); } } };

// Media clocks. Both streams run at a fixed rate whether or not a call is up, so go2rtc/ffmpeg never stall:
// MJPEG at 10 fps (live frame during a call, a dark idle frame otherwise), PCM at real-time 16 kHz (door audio, else silence).
setInterval(() => {
  if (!mjpegClients.size) return;
  fanout(mjpegClients, mjpegPart((state === "viewing" || state === "talking") && lastJpeg && Date.now() - lastFrameAt < 3000 ? lastJpeg : IDLE_JPEG));
}, 100);
let pcmStart = Date.now(); let pcmSent = 0;
// Diagnostic: MQTT "beep" plays 3 s of 1 kHz through the door-audio path, to test browser playback without a call.
let beepUntil = 0; let beepPhase = 0;
const sine = (n: number) => { const b = Buffer.alloc(n); for (let i = 0; i + 1 < n; i += 2) b.writeInt16LE(Math.round(8000 * Math.sin((beepPhase++ * 2 * Math.PI * 1000) / 16000)), i); return b; };
setInterval(() => {
  const owed = Math.floor(((Date.now() - pcmStart) * 32) / 2) * 2 - pcmSent; // 16000 Hz * 2 bytes = 32 bytes/ms
  if (owed <= 0) return;
  pcmSent += owed;
  const chunk = Date.now() < beepUntil ? sine(owed) : doorPcm.take(owed);
  if (pcmClients.size) fanout(pcmClients, chunk);
}, 20);

// Mic → door. Same flow control as the app (Throttling.setup(64000, 32000)): stop at 64 kB unacked, resume at 32 kB.
const mic = new MicSender((p) => send(p));

// Quick replies: a pre-recorded 16 kHz s16le clip played to the door as if it came from the mic, for screens
// with no microphone (the Nest Hub's Cast runtime refuses getUserMedia). "say:<name>" answers the call first.
// The HA app copies bridge.ts into /app at start, so its clips live in the app's config folder, not next to the code.
const USER_REPLIES = env.BEOVIEW_REPLIES ?? "/config/replies/"; // addon_configs/<slug>/replies on the HA host
const BUILTIN_REPLIES = here("./replies/");
const slash = (d: string) => d.replace(/\/?$/, "/");
/** Only plain names map to a file inside a replies folder: no paths, no dots. User clips win over the built-in ones. */
export const replyFile = (name: string) => {
  if (!/^[a-z0-9_-]{1,40}$/.test(name)) return null;
  const user = `${slash(USER_REPLIES)}${name}.pcm`;
  return existsSync(user) || !existsSync(`${slash(BUILTIN_REPLIES)}${name}.pcm`) ? user : `${slash(BUILTIN_REPLIES)}${name}.pcm`;
};
const AUDIO = /\.(mp3|wav|ogg|m4a|flac|aac|opus|webm)$/i;
/** "Pakket in de hal!.mp3" → "pakket_in_de_hal": the reply's name (file name, MQTT payload). */
export const replyName = (file: string) => file.replace(AUDIO, "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
/** "Pakket in de hal!.mp3" → "Pakket in de hal!": the button label, as the file was named. */
export const replyLabel = (file: string) => { const s = file.replace(AUDIO, "").replace(/[_]+/g, " ").trim().slice(0, 40); return s.charAt(0).toUpperCase() + s.slice(1); };
const BUILTIN_LABELS: Record<string, string> = { open: "Deur is open", duwen: "Even duwen", ik_kom: "Ik kom eraan", hal: "Pakket in de hal", nee: "Geen interesse" };
const labelsFile = (dir: string) => `${slash(dir)}labels.json`;
const readLabels = (dir: string): Record<string, string> => { try { return JSON.parse(readFileSync(labelsFile(dir), "utf8")); } catch { return {}; } };

async function convertOne(src: string, out: string): Promise<boolean> {
  const p = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-af", "loudnorm=I=-16:TP=-1.5,apad=pad_dur=0.2", "-ac", "1", "-ar", "16000", "-f", "s16le", out]);
  return (await p.exited) === 0;
}
/** Turn any audio file in the user's replies folder into the 16 kHz mono PCM the door speaker takes, named after
 *  the file ("Ik kom eraan.mp3" → ik_kom_eraan, label "Ik kom eraan"). Runs at start and after an upload. */
export async function convertReplies(dir = USER_REPLIES) {
  if (!existsSync(dir)) return;
  const labels = readLabels(dir); let changed = false;
  for (const f of readdirSync(dir)) {
    if (!AUDIO.test(f)) continue;
    const name = replyName(f); if (!name) continue;
    if (!labels[name]) { labels[name] = replyLabel(f); changed = true; }
    const src = `${slash(dir)}${f}`; const out = `${slash(dir)}${name}.pcm`;
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) continue;
    log(`reply ${f} → ${name}.pcm: ${(await convertOne(src, out)) ? "ok" : "ffmpeg failed"}`);
  }
  if (changed) writeFileSync(labelsFile(dir), JSON.stringify(labels, null, 2));
}
/** The panel's "built-in Dutch replies" switch. Unset: on when Home Assistant itself is set to Dutch. */
const settingsFile = (dir: string) => `${slash(dir)}settings.json`;
let haDutch = false; // filled at start from HA's language
export const builtinsOn = (dir = USER_REPLIES): boolean => { try { const v = JSON.parse(readFileSync(settingsFile(dir), "utf8")).builtin; if (typeof v === "boolean") return v; } catch {} return haDutch; };
export function setBuiltins(on: boolean, dir = USER_REPLIES) {
  mkdirSync(dir, { recursive: true }); writeFileSync(settingsFile(dir), JSON.stringify({ builtin: on })); publishReplies();
}
/** Every reply the card should show: the user's own clips, then the built-in Dutch ones when switched on. */
export function listReplies(dir = USER_REPLIES, all = false): { name: string; label: string; builtin: boolean }[] {
  const pcms = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".pcm")).map((f) => f.slice(0, -4)).filter((n) => /^[a-z0-9_-]{1,40}$/.test(n)) : []);
  const labels = readLabels(dir); const user = pcms(dir).sort();
  return [
    ...user.map((name) => ({ name, label: labels[name] ?? BUILTIN_LABELS[name] ?? replyLabel(name), builtin: false })),
    ...(all || builtinsOn(dir) ? pcms(BUILTIN_REPLIES).filter((n) => !user.includes(n)).sort().map((name) => ({ name, label: BUILTIN_LABELS[name] ?? replyLabel(name), builtin: true })) : []),
  ];
}
async function readHaLanguage() {
  if (!env.SUPERVISOR_TOKEN) return;
  const r = await fetch("http://supervisor/core/api/config", { headers: { Authorization: `Bearer ${env.SUPERVISOR_TOKEN}` } });
  if (r.ok) haDutch = String((await r.json()).language ?? "").toLowerCase().startsWith("nl");
}
const publishReplies = () => pub("beoview/replies", JSON.stringify({ replies: listReplies() }), true);

/** Upload from the setup panel: save the original, convert it, announce the new list. */
export async function addReply(fileName: string, audio: Buffer, dir = USER_REPLIES): Promise<{ ok: boolean; name?: string; error?: string }> {
  const name = replyName(fileName); const ext = fileName.match(AUDIO)?.[0].toLowerCase();
  if (!name || !ext) return { ok: false, error: "bad_file" };
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (AUDIO.test(f) && replyName(f) === name) unlinkSync(`${slash(dir)}${f}`); // replace an older upload with the same name
  const src = `${slash(dir)}${name}${ext}`;
  writeFileSync(src, audio);
  if (!(await convertOne(src, `${slash(dir)}${name}.pcm`))) { unlinkSync(src); return { ok: false, error: "not_audio" }; }
  const labels = readLabels(dir); labels[name] = replyLabel(fileName); writeFileSync(labelsFile(dir), JSON.stringify(labels, null, 2));
  log(`reply uploaded: ${name}`); publishReplies();
  return { ok: true, name };
}
/** Remove a user reply (its audio, PCM and label). A built-in clip can't be removed, only replaced. */
export function removeReply(name: string, dir = USER_REPLIES): boolean {
  if (!/^[a-z0-9_-]{1,40}$/.test(name) || !existsSync(dir)) return false;
  let hit = false;
  for (const f of readdirSync(dir)) if ((AUDIO.test(f) && replyName(f) === name) || f === `${name}.pcm`) { unlinkSync(`${slash(dir)}${f}`); hit = true; }
  const labels = readLabels(dir); if (name in labels) { delete labels[name]; writeFileSync(labelsFile(dir), JSON.stringify(labels, null, 2)); }
  if (hit) { log(`reply removed: ${name}`); publishReplies(); }
  return hit;
}
let reply: Buffer | null = null; let replyPos = 0; let pendingReply: Buffer | null = null;
/** Real-time pacing: 20 ms = 640 bytes per tick, so the MicSender never drops the clip as stale audio. */
export function nextReplyChunk(clip: Buffer, pos: number, bytes = 640): Buffer | null { return pos < clip.length ? clip.subarray(pos, Math.min(clip.length, pos + bytes)) : null; }
setInterval(() => {
  if (!reply || state !== "talking") return;
  const c = nextReplyChunk(reply, replyPos);
  if (!c) { reply = null; return; }
  replyPos += c.length; stats.micBytes += c.length; mic.feed(c);
}, 20);
export function say(name: string): string {
  const f = replyFile(name);
  if (!f) return `bad reply name ${name}`;
  let clip: Buffer;
  try { clip = readFileSync(f); } catch { return `no reply clip ${name}`; }
  if (state === "talking") { reply = clip; replyPos = 0; return `saying ${name}`; }
  pendingReply = clip; // before answer(): from "viewing" it switches to talking synchronously and picks this up
  const r = answer();
  if (r.startsWith("nothing")) { pendingReply = null; return `no call to reply to (state ${state})`; }
  return `${r}; then saying ${name}`;
}
/** Bytes of the current clip already sent, or -1 when no clip is playing (for tests and logs). */
export const replyProgress = () => (reply ? replyPos : -1);
let lastSnapPub = 0;

export const callState = () => state;
export function onMessage(p: Buffer) {
  const cmd = p[0];
  switch (cmd) {
    case C.CALL_INCOMING: {
      if (state !== "idle") return;
      callId = Buffer.from(p.subarray(1, 17)); source = str(p, 17);
      log("DOORBELL from", JSON.stringify(source));
      setState("ringing");
      pub("beoview/doorbell", JSON.stringify({ event_type: "ring", source }));
      ringTimer = setTimeout(() => { if (state === "ringing") setState("idle"); }, RING_MS);
      if (AUTO_VIEW) log("auto-view:", view());
      return;
    }
    case C.CALL_INCOMING_OFF:
      if (callId?.equals(p.subarray(1, 17)) && state === "ringing") { log("ring ended unanswered"); setState("idle"); }
      else if (callId?.equals(p.subarray(1, 17))) log("CALL_INCOMING_OFF during", state); // keep our video call; it has its own timeout
      return;
    case C.CALL_ACK:
      if (state !== "connecting") return;
      setState("viewing");
      if (pendingUnlock && callId) { pendingUnlock = false; send(withId(C.UNLOCK, callId)); log("unlock sent"); }
      if (pendingTalk) { pendingTalk = false; talk(); log("audio enabled"); }
      return;
    case C.CALL_FAILED: log("CALL_FAILED:", str(p, 17)); setState("idle"); return;
    case C.CALL_STOPPED: if (callId?.equals(p.subarray(1, 17))) setState("idle"); return;
    case C.VIDEO_OUT: {
      send(Buffer.from([C.VIDEO_ACK, 1, 0, 0, 0]));
      stats.frames++; assemble(p.subarray(1));
      if (lastJpeg && Date.now() - lastSnapPub > 1000) { lastSnapPub = Date.now(); pub("beoview/snapshot", lastJpeg, true); }
      return;
    }
    case C.AUDIO_OUT: send(Buffer.concat([Buffer.from([C.AUDIO_OUT_ACK]), int32le(p.length - 1)])); stats.doorBytes += p.length - 1; if (audioOn) doorPcm.push(p.subarray(1)); return;
    case C.AUDIO_IN_ACK: mic.acked(p.readInt32LE(1)); return;
    case C.UNLOCK_STATUS: log("DOOR_UNLOCK_STATUS", p.subarray(1).toString("hex")); pub("beoview/unlock_status", p.subarray(1).toString("hex")); return;
    case 0x61: case C.SYNC: return; // gateway ack / sync replies
    default: log(`cmd ${cmd} len ${p.length}`);
  }
}

// ---------- cloud gateway session (one at a time, reconnect forever) ----------
function session(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; ws = null; if (cloudUp) { cloudUp = false; pub("beoview/cloud", "OFF", true); } if (state !== "idle") setState("idle"); resolve(); };
    const req = https.request({
      host: "client.api.beoview.com", port: 443, path: "/api/client/beoview-gateway-v2/conn", method: "GET",
      rejectUnauthorized: false, // the chain is a private CA Bun can't build; we pin the leaf below instead
      headers: { "User-Agent": "BeoviewApp-Android-v1.9.0.0074", "X-Auth-Device": creds.deviceId, "X-Auth-Key": creds.authKey, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), "Sec-WebSocket-Version": "13" },
    });
    req.setTimeout(15000, () => req.destroy(new Error("connect timeout")));
    req.on("socket", (s: Socket) => (s as TLSSocket).on("secureConnect", () => {
      if ((s as TLSSocket).getPeerCertificate()?.fingerprint256 !== PIN) { req.destroy(new Error("certificate pin mismatch")); return; }
      req.end(); // credentials leave only after the pin matched
    }));
    req.on("response", (res) => { log("no upgrade: HTTP", res.statusCode); res.resume(); res.on("end", done); });
    req.on("error", (e) => { log("cloud error:", (e as Error).message); done(); });
    req.on("upgrade", (_res, socket: Socket) => {
      ws = socket; socket.setTimeout(0);
      let buf = Buffer.alloc(0); let lastRx = Date.now();
      const ka = setInterval(() => {
        if (Date.now() - lastRx > 75000) { log("cloud silent 75s, reconnecting"); socket.destroy(); return; }
        send(Buffer.from([C.SYNC, 0, 0, 0]));
        try { socket.write(wsframe(Buffer.alloc(0), 0x9)); } catch {} // WS ping: the pong proves liveness (the gateway never answers SYNC)
      }, 20000);
      const close = () => { clearInterval(ka); socket.destroy(); done(); };
      socket.on("close", close); socket.on("error", close);
      socket.on("data", (d: Buffer) => {
        lastRx = Date.now();
        const r = parseFrames(Buffer.concat([buf, d])); buf = r.rest;
        for (const f of r.frames) {
          if (f.op === 0x8) return close();
          if (f.op === 0x9) { socket.write(wsframe(f.payload, 0xa)); continue; }
          if (f.op === 0x1 || f.op === 0x2) onMessage(f.payload);
        }
      });
      const hello = Buffer.alloc(64); hello[0] = C.HELLO; const nm = Buffer.from("bridge"); hello[1] = nm.length; nm.copy(hello, 2);
      socket.write(wsframe(hello));
      cloudUp = true; pub("beoview/cloud", "ON", true); log("cloud connected, waiting for rings");
    });
  });
}

// ---------- MQTT + Home Assistant discovery ----------
let mq: mqtt.MqttClient | null = null;
function pub(topic: string, payload: string | Buffer, retain = false) { mq?.publish(topic, payload, { retain }); }

async function mqttOptions(): Promise<{ url: string; username?: string; password?: string } | null> {
  if (env.MQTT_URL) return { url: env.MQTT_URL, username: env.MQTT_USER, password: env.MQTT_PASS };
  if (!env.SUPERVISOR_TOKEN) return null;
  // Inside the HA app: the Supervisor hands us the Mosquitto login (config.yaml services: mqtt:need).
  const r = await fetch("http://supervisor/services/mqtt", { headers: { Authorization: `Bearer ${env.SUPERVISOR_TOKEN}` } });
  if (!r.ok) throw new Error(`supervisor mqtt service: HTTP ${r.status}`);
  const d = (await r.json()).data as { host: string; port: number; ssl: boolean; username: string; password: string };
  return { url: `${d.ssl ? "mqtts" : "mqtt"}://${d.host}:${d.port}`, username: d.username, password: d.password };
}

function discovery() {
  const device = { identifiers: ["beoview_bridge"], name: "Beoview intercom", manufacturer: "Golmar / Beoview", model: "BWCM.01 via cloud gateway" };
  const base = { device, availability_topic: "beoview/status", origin: { name: "beoview-bridge" } };
  const cfg: [string, string, Record<string, unknown>][] = [
    ["event", "doorbell", { name: "Doorbell", device_class: "doorbell", event_types: ["ring"], state_topic: "beoview/doorbell" }],
    ["binary_sensor", "ringing", { name: "Ringing", state_topic: "beoview/ringing", icon: "mdi:bell-ring" }],
    ["binary_sensor", "cloud", { name: "Cloud connection", device_class: "connectivity", state_topic: "beoview/cloud", entity_category: "diagnostic" }],
    ["sensor", "call_state", { name: "Call state", state_topic: "beoview/call_state", icon: "mdi:phone-in-talk" }],
    ["camera", "snapshot", { name: "Door snapshot", topic: "beoview/snapshot" }],
    // The card reads its quick-reply buttons from this sensor's `replies` attribute: upload a clip, it appears.
    ["sensor", "quick_replies", { name: "Quick replies", state_topic: "beoview/replies", value_template: "{{ value_json.replies | count }}", json_attributes_topic: "beoview/replies", icon: "mdi:message-reply-text", entity_category: "diagnostic" }],
    ["button", "answer", { name: "Answer", command_topic: "beoview/cmd", payload_press: "answer", icon: "mdi:phone" }],
    ["button", "hangup", { name: "Hang up", command_topic: "beoview/cmd", payload_press: "hangup", icon: "mdi:phone-hangup" }],
    ["button", "unlock", { name: "Unlock door", command_topic: "beoview/cmd", payload_press: "unlock", icon: "mdi:door-open" }],
  ];
  for (const [comp, id, c] of cfg) pub(`homeassistant/${comp}/beoview/${id}/config`, JSON.stringify({ ...base, ...c, unique_id: `beoview_${id}`, object_id: `beoview_${id}` }), true);
}

async function startMqtt() {
  const o = await mqttOptions();
  if (!o) { log("no MQTT configured (set MQTT_URL or run as HA app); HTTP only"); return; }
  mq = mqtt.connect(o.url, { username: o.username, password: o.password, clientId: "beoview-bridge", will: { topic: "beoview/status", payload: Buffer.from("offline"), retain: true, qos: 1 }, reconnectPeriod: 5000 });
  mq.on("connect", () => {
    log("mqtt connected");
    discovery(); publishReplies();
    pub("beoview/status", creds.deviceId ? "online" : "offline", true); pub("beoview/cloud", cloudUp ? "ON" : "OFF", true); // offline = not set up yet
    pub("beoview/call_state", state, true); pub("beoview/ringing", state === "ringing" ? "ON" : "OFF", true);
    mq!.subscribe(["beoview/cmd", "homeassistant/status"]);
  });
  mq.on("message", (topic, msg) => {
    const m = msg.toString().trim();
    if (topic === "homeassistant/status") { if (m === "online") { discovery(); pub("beoview/status", creds.deviceId ? "online" : "offline", true); } return; }
    const r = m === "beep" ? ((beepUntil = Date.now() + 3000), "beep 3 s") : m === "view" ? view() : m === "answer" ? answer() : m === "hangup" || m === "decline" ? hangup() : m === "unlock" ? unlock() : m.startsWith("say:") ? say(m.slice(4)) : `unknown command ${m}`;
    log(`cmd ${m}: ${r}`);
  });
  mq.on("error", (e) => log("mqtt error:", e.message));
}

function live(set: Set<ReadableStreamDefaultController<Uint8Array>>) {
  let ctl: ReadableStreamDefaultController<Uint8Array>;
  return new ReadableStream<Uint8Array>({ start(c) { ctl = c; set.add(c); }, cancel() { set.delete(ctl); } });
}

// Mic in: go2rtc's backchannel ffmpeg connects here and streams s16le 16 kHz mono (localhost only).
let micSeen = 0;
function startMic() {
  Bun.listen({ hostname: "127.0.0.1", port: MIC_PORT, socket: {
    open() { log("mic stream connected"); },
    data(_s, d) { micSeen += d.length; if (replyProgress() >= 0) return; /* a quick reply owns the door speaker */ if (mic.enabled) stats.micBytes += d.length; mic.feed(Buffer.from(d)); },
    close() { log(`mic stream closed (${micSeen} B received)`); micSeen = 0; },
  } });
}

// go2rtc as a supervised child: restarted if it ever exits.
function startGo2rtc(ip: string) {
  if (!GO2RTC_CONFIG) return;
  log(ip ? `WebRTC candidate ${ip}:8555` : "no host IP found: WebRTC relies on STUN only");
  const run = () => {
    const p = Bun.spawn(["go2rtc", "-config", GO2RTC_CONFIG], { stdout: "inherit", stderr: "inherit", env: { ...env, HOST_IP: ip || "127.0.0.1" } });
    p.exited.then((code) => { log(`go2rtc exited (${code}), restarting in 3 s`); setTimeout(run, 3000); });
  };
  run();
}

// ---------- HTTP: health, snapshot, MJPEG (HA-internal network only; door control stays on authenticated MQTT) ----------
export function startHttp() {
  const server = Bun.serve({
    port: HTTP_PORT,
    idleTimeout: 0, // MJPEG/PCM are endless streams; Bun's default 10 s idle timeout killed them mid-call
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      // Setup panel (HA sidebar, via ingress). Only HA's ingress proxy may reach it: other add-ons share this network.
      if (path === "/" || path.startsWith("/setup/")) {
        if (!fromIngress(srv.requestIP(req)?.address)) return new Response("forbidden", { status: 403 });
        if (path === "/") return new Response(SETUP_HTML.replace("__STATE__", JSON.stringify({ setUp: !!creds.deviceId, cloud: cloudUp })), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
        if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
        if (path === "/setup/code") return req.text().then((t) => finishSetup(parseToken(t)));
        if (path === "/setup/photo") return req.arrayBuffer().then(async (b) => finishSetup(b.byteLength > 15_000_000 ? null : await qrFromImage(Buffer.from(b))));
        if (path === "/setup/replies/list") return Response.json({ replies: listReplies(USER_REPLIES, true), builtin: builtinsOn() });
        if (path === "/setup/replies/builtin") return req.text().then((v) => { setBuiltins(v.trim() === "on"); return Response.json({ ok: true, builtin: builtinsOn() }); });
        if (path === "/setup/replies/add") {
          const file = new URL(req.url).searchParams.get("file") ?? "";
          return req.arrayBuffer().then(async (b) => (b.byteLength > 15_000_000 ? Response.json({ ok: false, error: "too_big" }, { status: 413 }) : Response.json(await addReply(file, Buffer.from(b)))));
        }
        if (path === "/setup/replies/remove") return req.text().then((n) => Response.json({ ok: removeReply(n.trim()) }));
        return new Response("not found", { status: 404 });
      }
      if (path === "/health") return Response.json({ cloud: cloudUp, mqtt: mq?.connected ?? false, state, source, hasFrame: !!lastJpeg }, { status: cloudUp ? 200 : 503 });
      if (path === "/snapshot.jpg") return lastJpeg ? new Response(lastJpeg, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } }) : new Response("no frame yet", { status: 404 });
      if (path === "/mjpeg") {
        return new Response(live(mjpegClients), { headers: { "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-store" } });
      }
      if (path === "/audio.pcm") return new Response(live(pcmClients), { headers: { "Content-Type": "audio/L16; rate=16000; channels=1", "Cache-Control": "no-store" } }); // s16le, for go2rtc
      return new Response("not found", { status: 404 });
    },
  });
  log(`http on :${HTTP_PORT} (/health /snapshot.jpg /mjpeg /audio.pcm)`);
  return server;
}

// ---------- first-run setup: QR token → device credentials ----------
/** The QR code on the BWCM.01 screen holds a one-time UUID; accept the bare UUID or any text that contains one. */
export const parseToken = (raw: unknown) => (typeof raw === "string" ? raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null : null);

/** Trade the one-time QR token for a device id + auth key (what the official app does when you scan the code). */
function register(token: string): Promise<Creds> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ token, fcmToken: `ha-bridge-${crypto.randomUUID()}`, name: "HomeAssistant", os: "ANDROID" });
    const req = https.request({
      host: "client.api.beoview.com", port: 443, path: "/api/client/beoview-gateway-v2/register", method: "POST", rejectUnauthorized: false,
      headers: { "Content-Type": "application/json", "User-Agent": "BeoviewApp-Android-v1.9.0.0074", "Content-Length": String(Buffer.byteLength(body)) },
    });
    req.setTimeout(15000, () => req.destroy(new Error("register timeout")));
    req.on("socket", (s: Socket) => (s as TLSSocket).on("secureConnect", () => {
      if ((s as TLSSocket).getPeerCertificate()?.fingerprint256 !== PIN) { req.destroy(new Error("certificate pin mismatch")); return; }
      req.end(body); // the token leaves only after the pin matched
    }));
    req.on("response", (res) => {
      let b = ""; res.on("data", (d) => (b += d));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`register refused (HTTP ${res.statusCode}): the QR code is probably used or expired, make a new one on the module`));
        try { const j = JSON.parse(b); if (j.id && j.authKey) return resolve({ deviceId: j.id, authKey: j.authKey }); } catch {}
        reject(new Error("register: unexpected answer from the Beoview cloud"));
      });
    });
    req.on("error", reject);
  });
}

/** Saved credentials, or register with the token from the add-on settings. Never logs a secret. */
// ---------- setup panel: photo of the QR code (or the pasted code) → register, no restart ----------
const INGRESS_IP = env.BEOVIEW_INGRESS_IP ?? "172.30.32.2"; // the Supervisor's ingress proxy
export const fromIngress = (ip?: string) => !!ip && ip.replace(/^::ffff:/, "") === INGRESS_IP;
const SETUP_HTML = readFileSync(env.BEOVIEW_SETUP_HTML ?? here("./setup.html"), "utf8");
let setupDone: (c: Creds) => void = () => {};
const credsFromPanel = new Promise<Creds>((r) => (setupDone = r));
let registering = false;

/** Raw QR text from a photo: ffmpeg decodes any image (JPEG, PNG, WebP) to RGBA pixels at a fixed size, jsQR reads them.
 *  Tries a small then a larger size: small is fast and forgiving of blur, large catches a QR that fills little of the frame. */
export async function qrTextFromImage(img: Buffer): Promise<string | null> {
  const f = `/tmp/qr-${randomBytes(6).toString("hex")}`;
  writeFileSync(f, img);
  try {
    for (const s of [800, 1600]) {
      const p = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", f, "-vf", `scale=${s}:${s}:force_original_aspect_ratio=decrease,pad=${s}:${s}:-1:-1:white`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdout: "pipe", stderr: "pipe" });
      const px = Buffer.from(await new Response(p.stdout).arrayBuffer());
      if ((await p.exited) !== 0 || px.length !== s * s * 4) { log(`qr photo: ${img.length} B, not an image ffmpeg can read (${(await new Response(p.stderr).text()).trim().split("\n")[0]?.slice(0, 120)})`); return null; }
      const hit = jsQR(new Uint8ClampedArray(px.buffer, px.byteOffset, px.length), s, s);
      if (hit) { log(`qr photo: ${img.length} B, decoded ${hit.data.length} chars at ${s}px`); return hit.data; }
    }
    log(`qr photo: ${img.length} B, no QR code found`);
    return null;
  } catch (e) { log("qr photo: decoder failed:", (e as Error).message); return null; } finally { try { unlinkSync(f); } catch {} }
}
export const qrFromImage = async (img: Buffer) => parseToken(await qrTextFromImage(img));

/** Put the setup panel in HA's sidebar (Supervisor leaves it off for new add-ons), so the user finds it. */
async function showInSidebar() {
  if (!env.SUPERVISOR_TOKEN) return;
  if ((await supervisor("/addons/self/info")).data.ingress_panel) return;
  const r = await fetch("http://supervisor/addons/self/options", { method: "POST", headers: { Authorization: `Bearer ${env.SUPERVISOR_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ ingress_panel: true }) });
  log(r.ok ? "added Beoview to the sidebar for setup" : `sidebar: HTTP ${r.status}`);
}

async function finishSetup(token: string | null): Promise<Response> {
  if (creds.deviceId) return Response.json({ ok: true, message: "already set up" });
  if (!token) return Response.json({ ok: false, error: "no_code" }, { status: 400 });
  if (registering) return Response.json({ ok: false, error: "busy" }, { status: 409 });
  registering = true;
  try {
    log("registering with the Beoview cloud (setup panel)...");
    const c = await register(token);
    writeFileSync(CREDS_FILE, JSON.stringify(c), { mode: 0o600 });
    log("registered from the setup panel; credentials saved");
    setupDone(c);
    return Response.json({ ok: true });
  } catch (e) {
    log("setup panel register failed:", (e as Error).message);
    return Response.json({ ok: false, error: "refused" }, { status: 502 });
  } finally { registering = false; }
}

async function loadCreds(): Promise<Creds> {
  if (existsSync(CREDS_FILE)) {
    const c = JSON.parse(readFileSync(CREDS_FILE, "utf8"));
    if (c.deviceId && c.authKey) return c;
  }
  let opts: Record<string, unknown> = {};
  try { opts = JSON.parse(readFileSync(OPTIONS_FILE, "utf8")); } catch {}
  const token = parseToken(opts.registration_token ?? env.BEOVIEW_REG_TOKEN);
  if (!token) throw new Error("not set up yet: open Beoview in the Home Assistant sidebar and scan the QR code from the BWCM.01 screen");
  log("registering with the Beoview cloud (one time)...");
  const c = await register(token);
  writeFileSync(CREDS_FILE, JSON.stringify(c), { mode: 0o600 });
  log("registered; credentials saved. The token is spent, you can clear it from the settings.");
  return c;
}

// ---------- Home Assistant side: host IP for WebRTC, card install ----------
const supervisor = (path: string) => fetch(`http://supervisor${path}`, { headers: { Authorization: `Bearer ${env.SUPERVISOR_TOKEN}` } }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`supervisor ${path}: HTTP ${r.status}`))));

/** The HA host's LAN IPv4, so phones on Wi-Fi can reach go2rtc's WebRTC port directly. */
async function hostIp(): Promise<string | null> {
  if (env.BEOVIEW_HOST_IP) return env.BEOVIEW_HOST_IP;
  if (!env.SUPERVISOR_TOKEN) return null;
  const d = (await supervisor("/network/info")).data as { interfaces: { primary: boolean; ipv4?: { address?: string[] } }[] };
  const i = d.interfaces.find((x) => x.primary) ?? d.interfaces[0];
  return i?.ipv4?.address?.[0]?.split("/")[0] ?? null;
}

const CARD_SRC = here("./card/");
const WWW = env.BEOVIEW_WWW ?? "/homeassistant/www/beoview/";
/** Copy the card into HA's www folder with this add-on's go2rtc address filled in; returns the cache-busting version. */
export function installCardFiles(server: string, dest = WWW): string {
  mkdirSync(dest, { recursive: true });
  const h = createHash("sha1").update(server);
  for (const f of readdirSync(CARD_SRC).filter((x) => x.endsWith(".js")).sort()) {
    const js = readFileSync(`${CARD_SRC}${f}`, "utf8").replaceAll("__BEOVIEW_SERVER__", server);
    h.update(js); writeFileSync(`${slash(dest)}${f}`, js);
  }
  return h.digest("hex").slice(0, 8);
}

/** Register (or bump) the card as a dashboard resource over HA's WebSocket API. */
function registerResource(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket("ws://supervisor/core/websocket");
    const timer = setTimeout(() => { sock.close(); reject(new Error("HA websocket timeout")); }, 15000);
    let id = 0; const wait = new Map<number, (m: any) => void>();
    const call = (msg: Record<string, unknown>) => new Promise<any>((r) => { wait.set(++id, r); sock.send(JSON.stringify({ id, ...msg })); });
    const done = (fn: () => void) => { clearTimeout(timer); sock.close(); fn(); };
    sock.onmessage = async (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "auth_required") return sock.send(JSON.stringify({ type: "auth", access_token: env.SUPERVISOR_TOKEN }));
      if (m.type === "auth_invalid") return done(() => reject(new Error("HA refused the add-on token")));
      if (m.id && wait.has(m.id)) { wait.get(m.id)!(m); wait.delete(m.id); return; }
      if (m.type !== "auth_ok") return;
      try {
        const list = await call({ type: "lovelace/resources" });
        if (!list.success) return done(() => reject(new Error("dashboards are in YAML mode: add the card resource by hand (see the docs)")));
        const base = url.split("?")[0];
        const old = (list.result as { id: string; url: string }[]).find((r) => r.url.split("?")[0] === base);
        if (old?.url === url) return done(() => resolve("card resource up to date"));
        const r = await call(old ? { type: "lovelace/resources/update", resource_id: old.id, res_type: "module", url } : { type: "lovelace/resources/create", res_type: "module", url });
        done(() => (r.success ? resolve(old ? "card resource updated" : "card resource added") : reject(new Error(`resource: ${r.error?.message ?? "failed"}`))));
      } catch (err) { done(() => reject(err)); }
    };
    sock.onerror = () => done(() => reject(new Error("HA websocket error")));
  });
}

async function installCard() {
  if (!env.SUPERVISOR_TOKEN || !existsSync("/homeassistant")) return;
  const server = `http://${env.HOSTNAME}:1984`; // this add-on's go2rtc, reachable from HA core on the internal network
  const v = installCardFiles(server);
  log(await registerResource(`/local/beoview/beoview-camera.js?v=${v}`));
}

if (import.meta.main) {
  // Clean stop for HA (otherwise the Supervisor SIGKILLs us after 10 s): mark entities unavailable, then exit.
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { log(sig, "stopping"); pub("beoview/status", "offline", true); mq?.end(false, {}, () => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
  startHttp(); startMic();
  startGo2rtc((await hostIp().catch((e) => (log("host ip:", (e as Error).message), null))) ?? "");
  await installCard().catch((e) => log("card install failed:", (e as Error).message));
  await readHaLanguage().catch((e) => log("ha language:", (e as Error).message));
  await convertReplies().catch((e) => log("replies:", (e as Error).message));
  await startMqtt().catch((e) => log("mqtt setup failed:", (e as Error).message));
  try { creds = await loadCreds(); } catch (e) {
    log("SETUP NEEDED:", (e as Error).message); pub("beoview/status", "offline", true);
    await showInSidebar().catch((err) => log("sidebar:", (err as Error).message));
    creds = await credsFromPanel; // stay up (no restart loop) until the setup panel registers
  }
  pub("beoview/status", "online", true);
  for (let backoff = 1000; ; ) {
    const t = Date.now();
    await session();
    backoff = Date.now() - t > 60000 ? 1000 : Math.min(backoff * 2, 60000); // reset after a healthy session
    await Bun.sleep(backoff);
  }
}
