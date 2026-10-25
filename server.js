#!/usr/bin/env node
"use strict";

/**
 * Mac -> TV movie streaming app.
 * - Browse the filesystem (no folder scan) and pick a video file.
 * - Serve it over HTTP with full Range support (seeking works, no 4 GB limit).
 * - Show the direct VLC URL + a QR code to grab on a phone.
 * - Detect & serve sidecar subtitle files next to the movie.
 * - Keep the Mac awake (caffeinate) while running.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const QRCode = require("qrcode");

const PORT = parseInt(process.env.PORT || "8090", 10);

// --- logging ------------------------------------------------------------
// Writes to logs/streamer.log (and console). Uses appendFileSync so lines are
// flushed immediately — important for diagnosing a stuck stop/crash, where a
// buffered async log would be lost when the process exits.
const LOG_DIR = path.join(__dirname, "logs");
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const LOG_FILE = path.join(LOG_DIR, "streamer.log");
function log(level, ...parts) {
  const msg = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  const line = `[${new Date().toISOString()}] [${String(level).padEnd(5)}] [pid ${process.pid}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
  (level === "ERROR" ? console.error : console.log)(line);
}
const logInfo = (...a) => log("INFO", ...a);
const logWarn = (...a) => log("WARN", ...a);
const logError = (...a) => log("ERROR", ...a);

process.on("uncaughtException", (e) => logError("uncaughtException:", e && (e.stack || e.message || String(e))));
process.on("unhandledRejection", (e) => logError("unhandledRejection:", e && (e.stack || String(e))));

const VIDEO_EXT = new Set([
  ".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm",
  ".ts", ".m2ts", ".mts", ".wmv", ".flv", ".mpg", ".mpeg",
]);
const SUB_EXT = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub"]);
// .ts/.mts are also TypeScript source — only count them as video when the
// file is large enough to actually be one (excludes .d.ts, .ts code, etc.).
const AMBIGUOUS_VIDEO_EXT = new Set([".ts", ".mts"]);
const MIN_AMBIGUOUS_VIDEO = 5 * 1024 * 1024; // 5 MB

// Large read chunks fill the TV's buffer much faster over the LAN than Node's
// 64 KB default — this is what makes a seek recover quickly instead of hanging.
const STREAM_CHUNK = 4 * 1024 * 1024; // 4 MB

const MIME = {
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".mts": "video/mp2t",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
};
const SUB_MIME = {
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".ass": "text/x-ssa",
  ".ssa": "text/x-ssa",
  ".sub": "text/plain",
};

// --- LAN IP detection ---------------------------------------------------
function lanIP() {
  const ifaces = os.networkInterfaces();
  // Prefer en0 (Wi-Fi/Ethernet on Mac), then any non-internal IPv4.
  const order = ["en0", "en1", "en2"];
  for (const name of order) {
    for (const i of ifaces[name] || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}
const IP = lanIP();

// --- numeric aliases ----------------------------------------------------
// Each file path gets a short numeric id (5–8 digits) so it's easy to type on
// a TV remote — streamed from /<id>.<ext> (e.g. /18765432.mp4). The id is
// DERIVED from the file path (sha1 → number), so a given file always keeps the
// same id; collisions resolve by stepping to the next free number. Persisted
// to aliases.json across restarts.
const ALIAS_FILE = path.join(__dirname, "aliases.json");
const tokenToPath = new Map();
const pathToToken = new Map();
let aliasDirty = false;

const ID_MIN = 10000;      // 5 digits
const ID_MAX = 99999999;   // 8 digits

function loadAliases() {
  try {
    const raw = JSON.parse(fs.readFileSync(ALIAS_FILE, "utf8"));
    for (const [tok, p] of Object.entries(raw)) {
      tokenToPath.set(tok, p);
      pathToToken.set(p, tok);
    }
  } catch { /* no file yet — fine */ }
}
function saveAliases() {
  if (!aliasDirty) return;
  try {
    fs.writeFileSync(ALIAS_FILE, JSON.stringify(Object.fromEntries(tokenToPath), null, 2));
    aliasDirty = false;
  } catch { /* non-fatal */ }
}

// Deterministic 5–8 digit id from the file path; step to the next free number
// on the rare collision with a different file.
function tokenFor(p) {
  const existing = pathToToken.get(p);
  if (existing) return existing;
  const span = BigInt(ID_MAX - ID_MIN + 1);
  const big = BigInt("0x" + crypto.createHash("sha1").update(p).digest("hex"));
  let n = ID_MIN + Number(big % span);
  let tok = String(n);
  let guard = 0;
  while (tokenToPath.has(tok) && tokenToPath.get(tok) !== p) {
    n = n >= ID_MAX ? ID_MIN : n + 1;
    tok = String(n);
    if (++guard > ID_MAX - ID_MIN) break; // pathological: space exhausted
  }
  tokenToPath.set(tok, p);
  pathToToken.set(p, tok);
  aliasDirty = true;
  return tok;
}
loadAliases();

// --- helpers ------------------------------------------------------------
function isVideo(name) { return VIDEO_EXT.has(path.extname(name).toLowerCase()); }
function isSub(name) { return SUB_EXT.has(path.extname(name).toLowerCase()); }

function findSubs(videoPath) {
  // Sidecar subtitles: any subtitle file in the same dir that shares the
  // video's base name (e.g. Movie.mkv -> Movie.srt, Movie.en.srt).
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !isSub(e.name)) continue;
    const subBase = path.basename(e.name, path.extname(e.name)).toLowerCase();
    if (subBase === base || subBase.startsWith(base + ".") || subBase.startsWith(base + "_")) {
      out.push({ name: e.name, path: path.join(dir, e.name) });
    }
  }
  return out;
}

// --- optimize (lossless remux to a seek-friendly MP4) -------------------
// VLC seeks/resumes unreliably over HTTP with MKV and falls back to reading
// the file linearly from the start. Remuxing to MP4 with the index at the
// front (faststart) — copying the video/audio bit-for-bit, NO re-encode, NO
// quality loss — makes VLC jump straight to the seek/resume offset.
const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((f) => { try { return fs.existsSync(f); } catch { return false; } }) || "ffmpeg";
const FFPROBE = ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"].find((f) => { try { return fs.existsSync(f); } catch { return false; } }) || "ffprobe";
let FFMPEG_OK = false;
try { require("child_process").execFileSync(FFMPEG, ["-version"], { stdio: "ignore" }); FFMPEG_OK = true; } catch { FFMPEG_OK = false; }

const OPT_SUFFIX = ".streamready.mp4";
const PARTIAL_SUFFIX = ".streamready.partial.mp4";
function isGeneratedFile(name) { const n = name.toLowerCase(); return n.endsWith(OPT_SUFFIX) || n.endsWith(PARTIAL_SUFFIX); }
function optimizedPathFor(videoPath) {
  return path.join(path.dirname(videoPath), path.basename(videoPath, path.extname(videoPath)) + OPT_SUFFIX);
}
function hasOptimized(videoPath) {
  try { return fs.statSync(optimizedPathFor(videoPath)).isFile(); } catch { return false; }
}

const optimizeJobs = new Map(); // token -> { state:'running'|'done'|'error', percent, error, startedAt, proc }
const generatedFiles = new Set(); // every .streamready/.partial path we create, for cleanup

function partialPathFor(src) {
  return path.join(path.dirname(src), path.basename(src, path.extname(src)) + PARTIAL_SUFFIX);
}
function probeDurationSec(file) {
  try {
    const out = require("child_process").execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" });
    const d = parseFloat(String(out).trim());
    return isFinite(d) && d > 0 ? d : 0;
  } catch { return 0; }
}
function probeVideoCodec(file) {
  try {
    const out = require("child_process").execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" });
    return String(out).trim().toLowerCase();
  } catch { return ""; }
}

// Delete any generated files for a source path (used on Stop and shutdown).
function removeGeneratedFor(src) {
  for (const f of [optimizedPathFor(src), partialPathFor(src)]) {
    try { if (fs.existsSync(f)) { fs.unlinkSync(f); logInfo(`cleanup: removed ${path.basename(f)}`); } } catch (e) { logWarn(`cleanup: could not remove ${f}: ${e.message}`); }
    generatedFiles.delete(f);
  }
}
// Stop + clean everything tied to a token: kill a running remux, delete outputs.
function cleanupToken(token) {
  const job = optimizeJobs.get(token);
  if (job && job.proc) { try { job.proc.kill("SIGKILL"); } catch {} }
  optimizeJobs.delete(token);
  const src = tokenToPath.get(token);
  if (src) removeGeneratedFor(src);
}

// Build format-adaptive ffmpeg args for a lossless MP4 remux (stream copy).
function remuxArgs(src, partial, vcodec, withSubs) {
  // Tag HEVC/AV1 so players recognize them inside MP4; H.264 etc. need no tag.
  const vtag = vcodec === "hevc" ? ["-tag:v", "hvc1"] : vcodec === "av1" ? ["-tag:v", "av01"] : [];
  const maps = withSubs ? ["-map", "0:v:0", "-map", "0:a?", "-map", "0:s?"] : ["-map", "0:v:0", "-map", "0:a?"];
  const subs = withSubs ? ["-c:s", "mov_text"] : ["-sn"]; // image subs (PGS) can't -> drop on retry
  return [
    "-nostdin", "-loglevel", "error", "-y", "-i", src,
    ...maps, "-c:v", "copy", "-c:a", "copy", ...vtag, ...subs,
    "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", partial,
  ];
}

function startOptimize(token) {
  const src = tokenToPath.get(token);
  if (!src) return { state: "error", percent: 0, error: "unknown token" };
  if (hasOptimized(src)) return { state: "done", percent: 100 };
  const existing = optimizeJobs.get(token);
  if (existing && existing.state === "running") return existing;

  const out = optimizedPathFor(src);
  const partial = partialPathFor(src);
  const durSec = probeDurationSec(src);
  const vcodec = probeVideoCodec(src);
  const job = { state: "running", percent: 0, startedAt: Date.now(), error: null, proc: null };
  optimizeJobs.set(token, job);
  generatedFiles.add(partial); generatedFiles.add(out);
  logInfo(`optimize: start '${token}' codec=${vcodec || "?"} -> ${path.basename(out)} (duration ${durSec}s)`);

  // attempt 1 copies subtitles; on failure we retry once without them.
  function run(withSubs) {
    const args = remuxArgs(src, partial, vcodec, withSubs);
    const proc = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    job.proc = proc;
    let buf = "", errout = "";
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && durSec > 0) job.percent = Math.min(99, Math.round((parseInt(m[1], 10) / 1e6 / durSec) * 100));
      }
    });
    proc.stderr.on("data", (d) => { errout += d.toString(); });
    proc.on("error", (e) => { job.state = "error"; job.error = e.message; job.proc = null; logError(`optimize '${token}' spawn error: ${e.message}`); });
    proc.on("close", (code) => {
      job.proc = null;
      if (job.state === "error") return; // killed/cleaned up
      if (code === 0) {
        try { fs.renameSync(partial, out); job.state = "done"; job.percent = 100; generatedFiles.delete(partial); logInfo(`optimize: done '${token}'`); }
        catch (e) { job.state = "error"; job.error = "rename failed: " + e.message; logError(job.error); }
        return;
      }
      try { fs.unlinkSync(partial); } catch {}
      if (withSubs) { // retry without subtitles (likely image-based / incompatible)
        logWarn(`optimize '${token}' failed with subs (code ${code}) — retrying without subtitles`);
        job.percent = 0; run(false);
      } else {
        job.state = "error"; job.error = (errout.trim().split("\n").pop()) || `ffmpeg exited ${code}`;
        logError(`optimize '${token}' failed (code ${code}): ${job.error}`);
      }
    });
  }
  run(true);
  return job;
}
function jobView(j) { return { state: j.state, percent: j.percent, error: j.error || null }; }

// --- active stream state ------------------------------------------------
// "Streaming" is an explicit on/off per file, driven by Start/Stop in the UI.
// An alias only serves bytes while its token is active; stats are tracked live.
const activeStreams = new Map(); // token -> { path, name, startedAt, bytesSent, requests, conns:Set, lastActivity }

function statusPayload() {
  const now = Date.now();
  const active = [...activeStreams.entries()].map(([token, A]) => {
    const src = A.path;
    let size = 0; try { size = fs.statSync(src).size; } catch {}
    const optimized = hasOptimized(src);
    const ext = path.extname(src).slice(1);
    const subs = findSubs(src).map((s) => ({ name: s.name, path: s.path, token: tokenFor(s.path), ext: path.extname(s.path).slice(1) }));
    return {
      token, name: A.name, path: src, size, ext,
      streamExt: optimized ? "mp4" : ext, optimized, subs,
      startedAt: A.startedAt, uptimeMs: now - A.startedAt,
      bytesSent: A.bytesSent, requests: A.requests,
      connections: A.conns.size, live: A.conns.size > 0,
      idleMs: A.lastActivity ? now - A.lastActivity : null,
    };
  });
  return { active, count: active.length };
}

// --- app ----------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/info", (req, res) => {
  res.json({ ip: IP, port: PORT, home: os.homedir(), root: "/", ffmpeg: FFMPEG_OK });
});

// Browse a directory. Returns folders + video files (with sidecar subs).
app.get("/api/browse", (req, res) => {
  let dir = req.query.path ? String(req.query.path) : os.homedir();
  dir = path.resolve(dir);
  let st;
  try { st = fs.statSync(dir); } catch { return res.status(404).json({ error: "Not found: " + dir }); }
  if (!st.isDirectory()) return res.status(400).json({ error: "Not a directory" });

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return res.status(403).json({ error: "Cannot read: " + e.message }); }

  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // hide dotfiles
    const full = path.join(dir, e.name);
    let dirent = e;
    // Resolve symlinks for type.
    if (e.isSymbolicLink()) {
      try { dirent = { isDirectory: () => fs.statSync(full).isDirectory() }; } catch { continue; }
    }
    if (dirent.isDirectory()) {
      dirs.push({ name: e.name, path: full });
    } else if (isVideo(e.name)) {
      if (isGeneratedFile(e.name)) {
        // Hide our generated files; delete orphans (not produced/served this session).
        if (!generatedFiles.has(full)) {
          try { fs.unlinkSync(full); logInfo(`cleanup: removed orphaned ${e.name}`); } catch {}
        }
        continue;
      }
      let size = 0;
      try { size = fs.statSync(full).size; } catch {}
      const ext = path.extname(e.name).toLowerCase();
      // Skip TypeScript/text files that merely share the .ts extension.
      if (AMBIGUOUS_VIDEO_EXT.has(ext) && size < MIN_AMBIGUOUS_VIDEO) continue;
      const subs = findSubs(full).map((s) => ({ ...s, token: tokenFor(s.path), ext: path.extname(s.path).slice(1) }));
      const optimized = hasOptimized(full);
      files.push({
        name: e.name, path: full, size, token: tokenFor(full),
        ext: path.extname(full).slice(1),
        streamExt: optimized ? "mp4" : path.extname(full).slice(1), // served container
        optimized, subs,
      });
    }
  }
  saveAliases();
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const parent = path.dirname(dir);
  res.json({
    path: dir,
    parent: parent === dir ? null : parent,
    dirs,
    files,
  });
});

// QR code as PNG for an arbitrary string.
app.get("/api/qr", async (req, res) => {
  const text = String(req.query.text || "");
  if (!text) return res.status(400).end("missing text");
  try {
    const buf = await QRCode.toBuffer(text, { type: "png", width: 320, margin: 2 });
    res.set("Content-Type", "image/png");
    res.send(buf);
  } catch (e) { res.status(500).end(String(e)); }
});

// Range-capable streaming of a video or subtitle file.
// `explicitPath` (from a resolved short alias) takes precedence over ?path=.
// `token` (optional) ties this response to an active stream for live stats
// and for Stop to be able to tear the connection down.
function serveFile(req, res, defaultCType, explicitPath, token) {
  const raw = explicitPath != null ? explicitPath : (req.query.path ? String(req.query.path) : null);
  const p = raw ? path.resolve(raw) : null;
  if (!p) return res.status(400).end("missing path");
  let st;
  try { st = fs.statSync(p); } catch { return res.status(404).end("not found"); }
  if (!st.isFile()) return res.status(400).end("not a file");

  const size = st.size;
  const ext = path.extname(p).toLowerCase();
  const ctype = defaultCType || MIME[ext] || "application/octet-stream";

  // Validators so clients (VLC) trust a resumed byte offset. Without these,
  // some players refuse to seek on a fresh connection and just sit buffering.
  const lastModified = st.mtime.toUTCString();
  const etag = `"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", ctype);
  res.setHeader("Last-Modified", lastModified);
  res.setHeader("ETag", etag);

  // If the client sends If-Range and it no longer matches (file changed),
  // ignore the Range and send the whole file so it can re-sync cleanly.
  let range = req.headers.range;
  const ifRange = req.headers["if-range"];
  if (range && ifRange && ifRange !== etag && ifRange !== lastModified) {
    logWarn(`stream If-Range mismatch (${ifRange}) — serving full file`);
    range = null;
  }
  let start = 0, end = size - 1, status = 200;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1]) {
        start = parseInt(m[1], 10);
        end = m[2] ? parseInt(m[2], 10) : size - 1;
      } else if (m[2]) { // suffix: bytes=-N
        start = Math.max(0, size - parseInt(m[2], 10));
        end = size - 1;
      }
      status = 206;
    }
  }
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) {
    res.status(416).setHeader("Content-Range", `bytes */${size}`);
    return res.end();
  }
  const length = end - start + 1;
  if (status === 206) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.setHeader("Content-Length", String(length));
  res.status(status);

  const A = token ? activeStreams.get(token) : null;
  if (A) { A.requests++; A.lastActivity = Date.now(); }

  // Access log: exactly what the client (VLC) asked for and how we answered.
  const label = `${req.method} ${req.originalUrl || req.url}`;
  const clientIP = (req.socket && req.socket.remoteAddress) || "?";
  logInfo(`stream ${label} from ${clientIP} Range="${req.headers.range || "(none)"}" -> ${status} bytes ${start}-${end}/${size} len ${length}`);

  // Low-latency delivery: disable Nagle so bytes aren't held back, and push the
  // response headers out immediately so VLC can start reading without a stall.
  if (req.socket) { try { req.socket.setNoDelay(true); } catch {} }
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  if (req.method === "HEAD") { logInfo(`stream ${label} HEAD done`); return res.end(); }

  const t0 = Date.now();
  let sent = 0;
  const stream = fs.createReadStream(p, { start, end, highWaterMark: STREAM_CHUNK });
  let conn = null;
  if (A) { conn = { res, stream }; A.conns.add(conn); }
  stream.on("data", (c) => { sent += c.length; if (A) { A.bytesSent += c.length; A.lastActivity = Date.now(); } });
  stream.on("error", (e) => { logWarn(`stream ${label} read error: ${e.message}`); try { res.end(); } catch {} });
  res.on("close", () => {
    stream.destroy();
    if (A && conn) A.conns.delete(conn);
    const complete = sent >= length;
    logInfo(`stream ${label} closed: sent ${sent}/${length} in ${Date.now() - t0}ms ${complete ? "(complete)" : "(aborted — seek/close)"}`);
  });
  stream.pipe(res);
}

app.get("/stream", (req, res) => serveFile(req, res, null));
app.head("/stream", (req, res) => serveFile(req, res, null));
app.get("/subs", (req, res) => {
  const p = req.query.path ? path.resolve(String(req.query.path)) : "";
  const ext = path.extname(p).toLowerCase();
  serveFile(req, res, SUB_MIME[ext] || "text/plain");
});

// Numeric root route: /<id>(.ext)?  — e.g. /18765432.mp4 (easy to type on a TV
// remote). One handler serves both videos (gated: must be Started) and
// subtitles (always available), picked by the mapped file's extension. The
// trailing extension is cosmetic; the id (digits) is what resolves.
const NUMERIC_ROUTE = /^\/(\d{4,9})(?:\.[A-Za-z0-9]+)?$/;
function serveByNumber(req, res) {
  const tok = req.params[0];               // the digits captured by the regex
  const src = tokenToPath.get(tok);
  if (!src) return res.status(404).end("unknown link");
  const ext = path.extname(src).toLowerCase();
  if (SUB_EXT.has(ext)) {                   // subtitle — always available
    return serveFile(req, res, SUB_MIME[ext] || "text/plain", src);
  }
  if (!activeStreams.has(tok)) {            // video — only while streaming is on
    return res.status(409).end("stream not started — press Start in the control app");
  }
  const served = hasOptimized(src) ? optimizedPathFor(src) : src; // prefer seek-friendly MP4
  serveFile(req, res, null, served, tok);
}
app.get(NUMERIC_ROUTE, serveByNumber);
app.head(NUMERIC_ROUTE, serveByNumber);

// --- start / stop / status ---------------------------------------------
app.post("/api/stream/start", (req, res) => {
  const tok = req.body && req.body.token;
  const p = tok && tokenToPath.get(tok);
  if (!p) { logWarn(`start: unknown token ${JSON.stringify(tok)}`); return res.status(400).json({ error: "unknown token" }); }
  if (!fs.existsSync(p)) { logWarn(`start: file missing for '${tok}': ${p}`); return res.status(404).json({ error: "file no longer exists" }); }
  if (!activeStreams.has(tok)) {
    activeStreams.set(tok, {
      path: p, name: path.basename(p), startedAt: Date.now(),
      bytesSent: 0, requests: 0, conns: new Set(), lastActivity: 0,
    });
    logInfo(`start: '${tok}' -> ${path.basename(p)}`);
  } else {
    logInfo(`start: '${tok}' already active (no-op)`);
  }
  res.json(statusPayload());
});

app.post("/api/stream/stop", (req, res) => {
  const tok = req.body && req.body.token;
  const toStop = tok ? [tok] : [...activeStreams.keys()]; // no token => stop all
  logInfo(`stop: request for ${tok ? `'${tok}'` : "ALL"} (${toStop.length} stream(s))`);
  for (const t of toStop) {
    const A = activeStreams.get(t);
    if (!A) { logInfo(`stop: '${t}' was not active`); continue; }
    let n = 0;
    for (const c of A.conns) { // drop the TV's live connection so playback stops
      try { c.stream.destroy(); } catch {}
      try { c.res.destroy(); } catch {}
      n++;
    }
    logInfo(`stop: '${t}' deactivated (dropped ${n} conn, ${A.bytesSent} bytes sent)`);
    activeStreams.delete(t);
    cleanupToken(t); // remove the generated .mp4 so only the original remains at rest
  }
  res.json(statusPayload());
});

app.get("/api/stream/status", (req, res) => res.json(statusPayload()));

// --- optimize endpoints -------------------------------------------------
app.post("/api/optimize", (req, res) => {
  const tok = req.body && req.body.token;
  if (!tok || !tokenToPath.has(tok)) return res.status(400).json({ error: "unknown token" });
  if (!FFMPEG_OK) return res.status(501).json({ error: "ffmpeg not installed (run: brew install ffmpeg)" });
  const job = startOptimize(tok);
  logInfo(`optimize: POST for '${tok}' -> state ${job.state}`);
  res.json({ token: tok, available: true, ...jobView(job) });
});

app.get("/api/optimize/status", (req, res) => {
  const tok = req.query.token ? String(req.query.token) : null;
  const src = tok && tokenToPath.get(tok);
  const done = src ? hasOptimized(src) : false;
  const job = tok && optimizeJobs.get(tok);
  res.json({
    token: tok,
    available: FFMPEG_OK,
    optimized: done,
    ...(job ? jobView(job) : { state: done ? "done" : "none", percent: done ? 100 : 0, error: null }),
  });
});

// --- keep awake ---------------------------------------------------------
let caffeinate = null;
function startCaffeinate() {
  try {
    // -w <pid>: caffeinate exits by itself when this server process exits,
    // even if we are SIGKILLed and never run the handlers below. No orphans.
    caffeinate = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { stdio: "ignore" });
    caffeinate.on("error", (e) => { logWarn("caffeinate error:", e.message); caffeinate = null; });
    logInfo(`caffeinate started (pid ${caffeinate.pid}) — Mac will stay awake`);
  } catch (e) { logWarn("caffeinate failed to start:", e.message); caffeinate = null; }
}
function stopCaffeinate() {
  if (caffeinate) { try { caffeinate.kill(); } catch {} caffeinate = null; }
}
process.on("exit", stopCaffeinate);

// --- start --------------------------------------------------------------
const server = app.listen(PORT, "0.0.0.0", () => {
  startCaffeinate();
  logInfo(`===== Streamer started on 0.0.0.0:${PORT} (LAN http://${IP}:${PORT}/) =====`);
  logInfo(`ffmpeg ${FFMPEG_OK ? "available at " + FFMPEG : "NOT found — optimize disabled"}`);
  console.log(`\n  🎬  Streamer running`);
  console.log(`  Control page:  http://localhost:${PORT}/`);
  console.log(`  On your LAN:   http://${IP}:${PORT}/`);
  console.log(`  Logs:          ${LOG_FILE}`);
  console.log(`  (Mac will stay awake while this runs. Ctrl+C to stop.)\n`);
});

// Keep idle keep-alive sockets open long enough that VLC can read the file
// header, pause to parse the index, then request the next range on the SAME
// connection. Node's 5 s default drops that socket mid-seek and VLC hangs
// "buffering" on resume. headersTimeout must stay above keepAliveTimeout.
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
server.requestTimeout = 0;   // never time out a long media transfer
server.timeout = 0;          // no socket inactivity cap

// --- graceful, logged shutdown -----------------------------------------
// server.close() alone HANGS while any HTTP connection is still open (e.g. the
// TV mid-stream, or a half-dead socket) — that is the "stop/restart gets stuck".
// We tear down tracked streams, force-close all sockets, and hard-exit after a
// short fallback so a stop can never hang. Every step is logged.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) { logWarn(`shutdown: received ${signal} again — forcing immediate exit`); return process.exit(1); }
  shuttingDown = true;
  const totalConns = [...activeStreams.values()].reduce((n, A) => n + A.conns.size, 0);
  logInfo(`shutdown: received ${signal}. activeStreams=${activeStreams.size}, trackedStreamConns=${totalConns}`);

  for (const [tok, A] of activeStreams) {
    let n = 0;
    for (const c of A.conns) { try { c.stream.destroy(); } catch {} try { c.res.destroy(); } catch {} n++; }
    logInfo(`shutdown: tore down stream '${tok}' (${n} conn, ${A.bytesSent} bytes sent, ${A.requests} reqs)`);
  }
  // Clean up every generated .streamready/.partial file so only originals remain.
  for (const job of optimizeJobs.values()) { if (job.proc) { try { job.proc.kill("SIGKILL"); } catch {} } }
  let removed = 0;
  for (const f of [...generatedFiles]) { try { if (fs.existsSync(f)) { fs.unlinkSync(f); removed++; } } catch {} generatedFiles.delete(f); }
  if (removed) logInfo(`shutdown: removed ${removed} generated file(s)`);

  stopCaffeinate();
  logInfo("shutdown: caffeinate stopped");

  if (typeof server.closeAllConnections === "function") {
    try { server.closeAllConnections(); logInfo("shutdown: closeAllConnections() called"); }
    catch (e) { logError("shutdown: closeAllConnections failed:", e.message); }
  }
  const force = setTimeout(() => { logWarn("shutdown: server.close() still pending after 2s — forcing exit"); process.exit(0); }, 2000);
  force.unref();
  server.close((err) => {
    clearTimeout(force);
    if (err) logError("shutdown: server.close error:", err.message);
    else logInfo("shutdown: server closed cleanly");
    logInfo("shutdown: exiting now");
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
