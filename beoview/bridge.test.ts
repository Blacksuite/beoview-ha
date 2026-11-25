import { expect, test } from "bun:test";
process.env.BEOVIEW_HTTP_PORT = "0";
process.env.BEOVIEW_REPLIES = Bun.fileURLToPath(new URL("./fixtures/replies/", import.meta.url));
const { replyName, replyLabel, addReply, listReplies, removeReply, setBuiltins, builtinsOn, qrTextFromImage, qrFromImage, fromIngress, parseToken, installCardFiles, convertReplies, wsframe, parseFrames, jpegAssembler, PcmQueue, MicSender, onMessage, callState, answer, unlock, hangup, startHttp, say, replyFile, nextReplyChunk, replyProgress } = await import("./bridge.ts");

test("quick reply: safe names only, real-time chunks, answers the call and plays the whole clip", async () => {
  expect(replyFile("../creds")).toBeNull(); expect(replyFile("a/b")).toBeNull(); expect(replyFile("ik_kom")).toMatch(/ik_kom\.pcm$/);
  const clip = Buffer.alloc(1500, 1);
  expect(nextReplyChunk(clip, 0)?.length).toBe(640); expect(nextReplyChunk(clip, 1280)?.length).toBe(220); expect(nextReplyChunk(clip, 1500)).toBeNull();
  expect(say("test")).toMatch(/^no call to reply to/); // idle: nothing to answer, nothing queued
  expect(say("missing")).toMatch(/^no reply clip/);
  const id = Buffer.alloc(16, 0xcd);
  onMessage(Buffer.concat([Buffer.from([47]), id, Buffer.from([6]), Buffer.from("Entree")]));
  onMessage(Buffer.concat([Buffer.from([34]), id])); expect(callState()).toBe("viewing");
  expect(say("test")).toMatch(/then saying test$/); // from viewing: answers synchronously, clip must still play
  expect(callState()).toBe("talking"); expect(replyProgress()).toBe(0);
  await Bun.sleep(400); // 6400 B at 640 B per 20 ms tick = 200 ms
  expect(replyProgress()).toBe(-1); // finished
  hangup();
});

test("masked client frames round-trip through the parser, split across reads", () => {
  const a = Buffer.from([47, ...Array(30).fill(7)]); const b = Buffer.alloc(300, 9);
  const wire = Buffer.concat([wsframe(a), wsframe(b)]);
  const first = parseFrames(wire.subarray(0, 40));
  expect(first.frames.map((f) => f.payload)).toEqual([a]);
  const second = parseFrames(Buffer.concat([first.rest, wire.subarray(40)]));
  expect(second.frames[0].payload).toEqual(b);
  expect(second.rest.length).toBe(0);
});

test("JPEG reassembly: chunked frame, single-message frame, and a new SOI resets junk", () => {
  const got: Buffer[] = [];
  const feed = jpegAssembler((j) => got.push(j));
  feed(Buffer.from([0xff, 0xd8, 1, 2])); feed(Buffer.from([3, 0xff, 0xd9]));
  feed(Buffer.from([9, 9, 9])); // stray bytes with no SOI
  feed(Buffer.from([0xff, 0xd8, 5, 0xff, 0xd9]));
  expect(got.map((g) => g.toString("hex"))).toEqual(["ffd8010203ffd9", "ffd805ffd9"]);
});

test("JPEG reassembly finds markers inside real VIDEO_OUT payloads", async () => {
  const jpg = Buffer.from(await Bun.file(new URL("./idle.jpg", import.meta.url)).arrayBuffer());
  const got: Buffer[] = [];
  const feed = jpegAssembler((j) => got.push(j));
  feed(Buffer.concat([Buffer.from([0, 0, 0, 0]), jpg.subarray(0, 317)]));
  feed(jpg.subarray(317));
  expect(got).toEqual([jpg]);
});

test("door audio queue pads with silence and caps latency at 400 ms", () => {
  const q = new PcmQueue();
  q.push(Buffer.from([1, 2, 3, 4]));
  expect(q.take(6).toString("hex")).toBe("010203040000");
  q.push(Buffer.alloc(20000, 7));
  expect(q.length).toBe(12800);
});

test("mic sender: even-length AUDIO_IN frames, stops at 64 kB unacked, resumes at 32 kB", () => {
  const sent: Buffer[] = [];
  const m = new MicSender((f) => sent.push(f));
  m.feed(Buffer.alloc(100)); expect(sent.length).toBe(0); // not in a call yet
  m.enabled = true;
  m.feed(Buffer.alloc(3)); expect(sent[0].toString("hex")).toBe("350000"); // AUDIO_IN=53=0x35, 2 bytes sent, 1 held back
  sent.length = 0;
  for (let i = 0; i < 40; i++) m.feed(Buffer.alloc(2048));
  const bytes = () => sent.reduce((n, f) => n + f.length - 1, 0);
  expect(sent.every((f) => f[0] === 53 && (f.length - 1) % 2 === 0)).toBe(true);
  expect(bytes()).toBeLessThanOrEqual(64000 + 2048); // throttled
  const before = bytes(); m.acked(40000); expect(bytes()).toBeGreaterThan(before); // resumed
});

test("call flow: ring auto-views, unlock needs no pick-up, answer turns on audio, hang up resets", () => {
  const id = Buffer.alloc(16, 0xab);
  const ring = Buffer.concat([Buffer.from([47]), id, Buffer.from([6]), Buffer.from("Entree")]);
  onMessage(ring); expect(callState()).toBe("connecting"); // CALL sent at once
  onMessage(Buffer.concat([Buffer.from([34]), id])); expect(callState()).toBe("viewing");
  expect(unlock()).toBe("unlock sent"); expect(callState()).toBe("viewing");
  expect(answer()).toBe("talking"); expect(callState()).toBe("talking");
  expect(hangup()).toBe("hung up"); expect(callState()).toBe("idle");
  onMessage(ring); expect(answer()).toBe("talk queued until video is up"); // pick up before video arrives
  onMessage(Buffer.concat([Buffer.from([34]), id])); expect(callState()).toBe("talking");
  hangup();
});

test("MJPEG and PCM streams stay connected beyond the former 10 s idle timeout", async () => {
  const server = startHttp();
  const base = `http://127.0.0.1:${server.port}`;
  const readFor = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const until = Date.now() + 11_500;
    let chunks = 0;
    while (Date.now() < until) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      expect(next.value?.byteLength).toBeGreaterThan(0);
      chunks++;
    }
    await reader.cancel();
    return chunks;
  };
  try {
    const [mjpegChunks, pcmChunks] = await Promise.all([readFor("/mjpeg"), readFor("/audio.pcm")]);
    expect(mjpegChunks).toBeGreaterThan(100);
    expect(pcmChunks).toBeGreaterThan(500);
  } finally {
    server.stop(true);
  }
}, 20_000);

test("setup: the QR token is found in pasted text, junk is refused", () => {
  const u = "1234abcd-12ab-34cd-56ef-1234567890ab";
  expect(parseToken(u)).toBe(u);
  expect(parseToken(` https://x.example/reg?t=${u}\n`)).toBe(u);
  expect(parseToken("not-a-token")).toBeNull(); expect(parseToken("")).toBeNull(); expect(parseToken(undefined)).toBeNull();
});

test("card install: server placeholder filled in, version changes with the server", () => {
  const dir = `${require("node:os").tmpdir()}/beoview-card-${Date.now()}/`;
  const v1 = installCardFiles("http://abc-beoview:1984", dir);
  const js = require("node:fs").readFileSync(`${dir}beoview-camera.js`, "utf8");
  expect(js).toContain("'http://abc-beoview:1984'"); expect(js).not.toContain("__BEOVIEW_SERVER__");
  expect(require("node:fs").existsSync(`${dir}digital-ptz.js`)).toBe(true);
  expect(installCardFiles("http://abc-beoview:1984", dir)).toBe(v1);
  expect(installCardFiles("http://other:1984", dir)).not.toBe(v1);
});

test("replies: a user mp3 becomes 16 kHz mono PCM", async () => {
  const dir = `${require("node:os").tmpdir()}/beoview-replies-${Date.now()}/`;
  require("node:fs").mkdirSync(dir);
  const g = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", `${dir}Hallo.mp3`]);
  if (g.exitCode !== 0) return; // no ffmpeg on this machine; the add-on image has it
  await convertReplies(dir);
  const pcm = require("node:fs").readFileSync(`${dir}hallo.pcm`);
  expect(pcm.length).toBeGreaterThan(30000); expect(pcm.length).toBeLessThan(42000); // ~1.2 s × 32000 B/s
});

test("setup panel: only the HA ingress proxy gets in", async () => {
  expect(fromIngress("172.30.32.2")).toBe(true); expect(fromIngress("::ffff:172.30.32.2")).toBe(true);
  expect(fromIngress("172.30.33.5")).toBe(false); expect(fromIngress(undefined)).toBe(false);
  const s = startHttp();
  for (const [m, p] of [["GET", "/"], ["POST", "/setup/code"], ["POST", "/setup/photo"]]) {
    const r = await fetch(`http://127.0.0.1:${s.port}${p}`, { method: m, body: m === "POST" ? "1234abcd-12ab-34cd-56ef-1234567890ab" : undefined });
    expect(r.status).toBe(403); // a request from any other address never reaches register()
  }
  s.stop(true);
});

test("setup panel: a phone-like photo of a QR code is decoded; a photo without one is not", async () => {
  if (Bun.spawnSync(["ffmpeg", "-version"]).exitCode !== 0) return; // the add-on image has ffmpeg
  const dir = `${require("node:os").tmpdir()}/beoview-qr-${Date.now()}/`; require("node:fs").mkdirSync(dir);
  const u = "1234abcd-12ab-34cd-56ef-1234567890ab";
  await require("qrcode").toFile(`${dir}qr.png`, u, { width: 360, margin: 4 });
  // a "photo": the QR small in a big grey JPEG frame, slightly blurred, like a phone shot of a screen
  Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-i", `${dir}qr.png`, "-vf", "pad=2400:1800:(ow-iw)/2:(oh-ih)/2:color=0x7a7a7a,gblur=sigma=1.2", "-q:v", "5", `${dir}photo.jpg`]);
  expect(await qrFromImage(require("node:fs").readFileSync(`${dir}photo.jpg`))).toBe(u);
  Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=640x480", "-frames:v", "1", `${dir}blank.png`]);
  expect(await qrTextFromImage(require("node:fs").readFileSync(`${dir}blank.png`))).toBeNull();
  expect(await qrTextFromImage(Buffer.from("not an image"))).toBeNull();
}, 20000);

test("quick replies: names and labels come from the file name", () => {
  expect(replyName("Pakket in de hal!.mp3")).toBe("pakket_in_de_hal");
  expect(replyName("Café — even geduld.M4A")).toBe("cafe_even_geduld");
  expect(replyName("../../etc/passwd.mp3")).toBe("etc_passwd"); // no paths survive
  expect(replyName(".mp3")).toBe("");
  expect(replyLabel("ik_kom eraan.mp3")).toBe("Ik kom eraan");
  expect(replyLabel("I'm coming.wav")).toBe("I'm coming");
});

test("quick replies: upload converts and lists it, a same-name upload replaces it, remove deletes it", async () => {
  if (Bun.spawnSync(["ffmpeg", "-version"]).exitCode !== 0) return;
  const fs = require("node:fs"); const dir = `${require("node:os").tmpdir()}/beoview-up-${Date.now()}/`;
  const mp3 = `${dir}src.mp3`; fs.mkdirSync(dir);
  Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=500:duration=1", mp3]);
  const audio = fs.readFileSync(mp3); fs.unlinkSync(mp3);
  expect(await addReply("Ik kom eraan.mp3", audio, dir)).toEqual({ ok: true, name: "ik_kom_eraan" });
  expect(fs.statSync(`${dir}ik_kom_eraan.pcm`).size).toBeGreaterThan(30000);
  const mine = listReplies(dir).filter((r: any) => !r.builtin);
  expect(mine).toEqual([{ name: "ik_kom_eraan", label: "Ik kom eraan", builtin: false }]);
  expect(builtinsOn(dir)).toBe(false); // HA not Dutch, no choice made: built-ins hidden
  expect(listReplies(dir).some((r: any) => r.builtin)).toBe(false);
  setBuiltins(true, dir);
  expect(listReplies(dir).some((r: any) => r.builtin && r.name === "duwen" && r.label === "Even duwen")).toBe(true);
  setBuiltins(false, dir);
  expect(listReplies(dir, true).some((r: any) => r.builtin)).toBe(true); // the panel still lists them, greyed out
  expect(await addReply("ik kom ERAAN.wav", audio, dir)).toEqual({ ok: true, name: "ik_kom_eraan" }); // replaces, no duplicate
  expect(fs.readdirSync(dir).filter((f: string) => f.startsWith("ik_kom_eraan.")).sort()).toEqual(["ik_kom_eraan.pcm", "ik_kom_eraan.wav"]);
  expect((await addReply("not audio.mp3", Buffer.from("hello"), dir)).ok).toBe(false);
  expect(fs.existsSync(`${dir}not_audio.mp3`)).toBe(false); // a failed upload leaves nothing behind
  expect(await addReply("no-extension", audio, dir)).toEqual({ ok: false, error: "bad_file" });
  expect(removeReply("ik_kom_eraan", dir)).toBe(true);
  expect(listReplies(dir).filter((r: any) => !r.builtin)).toEqual([]);
  expect(removeReply("../x", dir)).toBe(false);
}, 20000);
