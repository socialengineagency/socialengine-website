/**
 * SOC-10 — Approve → Publish (Upload-Post) for the API repo.
 *
 * Ported from socialengine-website PR #35. Merge into the main Express `server.js`:
 *
 *   const soc10 = require('./server'); // or ./lib/soc10-publish.js after move
 *   soc10.mountSoc10PublishRoutes(app, { verifyClient, logAdminError });
 *
 * Inside your existing POST /api/approve-post (or /api/content/approve), after
 * you persist "Approved" and have `clientRecord` + `contentRecord` Airtable shapes
 * `{ id, fields }`, call:
 *
 *   const kick = await soc10.soc10KickoffPublishAfterApprove({
 *     clientRecord,
 *     contentRecord,
 *     editedCaption,
 *   });
 *   return res.json({ ...yourPayload, ...kick });
 *
 * Environment (same as reference PR #35):
 *   AIRTABLE_BASE_ID | AIRTABLE_BASE, AIRTABLE_PAT | AIRTABLE_SECRET_API_TOKEN
 *   AIRTABLE_CLIENTS_TABLE (default CLIENTS), AIRTABLE_CONTENT_TABLE (CONTENT),
 *   AIRTABLE_PUBLISH_JOBS_TABLE (PUBLISH_JOBS), AIRTABLE_ERROR_LOG_TABLE (ERROR_LOG)
 *   UPLOAD_POST_API_KEY
 *
 * ERROR_LOG field names default to message, details, source, created_at (PR #35).
 * If your base uses different names, set:
 *   SOC10_ERROR_LOG_FIELD_MESSAGE, SOC10_ERROR_LOG_FIELD_DETAILS,
 *   SOC10_ERROR_LOG_FIELD_SOURCE, SOC10_ERROR_LOG_FIELD_CREATED_AT
 *
 * BIS v1.1 (SOC-7):
 *   AIRTABLE_BRAND_DNA_TABLE (default BRAND_DNA_VERSIONS) — create via node scripts/soc7-schema.js
 *   PERPLEXITY_API_KEY — brand synthesis (pplxChatJson)
 *   PERPLEXITY_MODEL (optional, default sonar)
 *   SHOPIFY_ADMIN_TOKEN (optional) — live Shopify catalog when client has shopify_domain
 *   SOC7_ENSURE_BRAND_DNA_TABLE=1 — auto-create table on boot (ensureBrandDnaTableExists)
 *
 * QA Gate 2 (anatomy):
 *   GATE2_MODE=auto|mediapipe|ffmpeg_proxy — auto probes MediaPipe once at boot
 *   GATE2_SMOKE_VIDEO_URL=https://... — optional; logs one runGate2AnatomyCheck at startup
 *   Railway / Nixpacks: install ffmpeg + ffprobe; optional canvas native deps for Gate 2 proxy
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID || process.env.AIRTABLE_BASE;
const AIRTABLE_TOKEN =
  process.env.AIRTABLE_PAT ||
  process.env.AIRTABLE_SECRET_API_TOKEN ||
  process.env.AIRTABLE_API_KEY;
const UPLOAD_POST_KEY = process.env.UPLOAD_POST_API_KEY || process.env.UPLOADPOST_API_KEY;

const TBL_CLIENTS = process.env.AIRTABLE_CLIENTS_TABLE || 'CLIENTS';
const TBL_CONTENT = process.env.AIRTABLE_CONTENT_TABLE || 'CONTENT';
const TBL_JOBS = process.env.AIRTABLE_PUBLISH_JOBS_TABLE || 'PUBLISH_JOBS';
const TBL_ERRORS = process.env.AIRTABLE_ERROR_LOG_TABLE || 'ERROR_LOG';
const TBL_BRAND_DNA = process.env.AIRTABLE_BRAND_DNA_TABLE || 'BRAND_DNA_VERSIONS';
const TBL_GENERATIONS = process.env.AIRTABLE_GENERATIONS_TABLE || 'GENERATIONS';

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY;
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || 'sonar';

const ERR_FIELD_MESSAGE = process.env.SOC10_ERROR_LOG_FIELD_MESSAGE || 'message';
const ERR_FIELD_DETAILS = process.env.SOC10_ERROR_LOG_FIELD_DETAILS || 'details';
const ERR_FIELD_SOURCE = process.env.SOC10_ERROR_LOG_FIELD_SOURCE || 'source';
const ERR_FIELD_CREATED = process.env.SOC10_ERROR_LOG_FIELD_CREATED_AT || 'created_at';

const AIRTABLE_API = 'https://api.airtable.com/v0';
const AIRTABLE_META = 'https://api.airtable.com/v0/meta/bases';

const PORTAL_BASE_URL = (process.env.PORTAL_BASE_URL || 'https://www.socialengine.agency/portal.html').replace(/\/+$/, '');
const ONBOARDING_SAMPLE_IMAGE_URL =
  process.env.ONBOARDING_SAMPLE_IMAGE_URL ||
  'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=800&q=80';

/** In-process cron heartbeats (reference server). Production: merge with your CRON_HEARTBEAT. */
const CRON_CADENCE_MS = { onboarding_lifecycle: 30 * 60 * 1000 };
const CRON_HEARTBEAT = {
  onboarding_lifecycle: { lastRun: 0, lastDurationMs: 0, status: 'never', postsGenerated: 0 },
};

/** In-memory studio job stubs for portal onboarding (reference server). */
const __studioJobs = new Map();

/** QA Gate 2 — anatomy check. See GATE2_MODE (mediapipe | ffmpeg_proxy | auto). */
const HAND_LANDMARKER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

let _gate2CapabilityCache = null;
let _gate2SmokeDone = false;

function getFfmpegBin() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function getFfprobeBin() {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.stdout = stdout;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ensureHandLandmarkerModelFile(destPath) {
  if (fs.existsSync(destPath)) return destPath;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const https = await import('https');
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(HAND_LANDMARKER_MODEL_URL, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error('model download HTTP ' + res.statusCode));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', reject);
  });
  return destPath;
}

async function probeMediaPipeHandLandmarker() {
  try {
    const { FilesetResolver, HandLandmarker } = require('@mediapipe/tasks-vision');
    const wasmDir = path.join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
    const modelPath = await ensureHandLandmarkerModelFile(
      path.join(__dirname, 'scripts', 'mediapipe-models', 'hand_landmarker.task'),
    );
    const vision = await FilesetResolver.forVisionTasks('file:' + path.resolve(wasmDir) + path.sep);
    const lm = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' },
      numHands: 2,
      runningMode: 'IMAGE',
    });
    lm.close();
    return true;
  } catch {
    return false;
  }
}

async function resolveGate2Mode() {
  if (_gate2CapabilityCache) return _gate2CapabilityCache;
  const forced = String(process.env.GATE2_MODE || '').trim().toLowerCase();
  if (forced === 'ffmpeg_proxy') {
    _gate2CapabilityCache = { mode: 'ffmpeg_proxy', mediapipeOk: false };
    return _gate2CapabilityCache;
  }
  if (forced === 'mediapipe') {
    const ok = await probeMediaPipeHandLandmarker();
    _gate2CapabilityCache = { mode: ok ? 'mediapipe' : 'ffmpeg_proxy', mediapipeOk: ok };
    if (!ok) {
      console.warn('[GATE2] GATE2_MODE=mediapipe but MediaPipe init failed — using ffmpeg_proxy');
    }
    return _gate2CapabilityCache;
  }
  const ok = await probeMediaPipeHandLandmarker();
  _gate2CapabilityCache = { mode: ok ? 'mediapipe' : 'ffmpeg_proxy', mediapipeOk: ok };
  return _gate2CapabilityCache;
}

function getGate2ModeForHealth() {
  if (!_gate2CapabilityCache) return { gate2Mode: 'skipped', gate2MediaPipeProbe: null };
  return {
    gate2Mode: _gate2CapabilityCache.mode,
    gate2MediaPipeProbe: _gate2CapabilityCache.mediapipeOk,
  };
}

async function ffprobeDurationSeconds(videoUrl) {
  const { stdout } = await execFileP(getFfprobeBin(), [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoUrl,
  ]);
  const d = parseFloat(String(stdout).trim());
  return Number.isFinite(d) && d > 0 ? d : 5;
}

async function extractVideoFrameToFile(videoUrl, outPath, timeSec) {
  await execFileP(getFfmpegBin(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(timeSec),
    '-i',
    videoUrl,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    outPath,
  ]);
}

function isSkinPixelRgb(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx < 60) return false;
  if (r < 95 || g < 40 || b < 20) return false;
  if (mx - mn < 15) return false;
  if (Math.abs(r - g) > 15 || r - b <= 45) return false;
  return true;
}

function grayAt(data, w, x, y) {
  const i = (y * w + x) * 4;
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

function edgeMeanInRect(data, w, h, x0, y0, x1, y1, step) {
  let sum = 0;
  let n = 0;
  const xStart = Math.max(1, x0);
  const yStart = Math.max(1, y0);
  const xEnd = Math.min(w - 2, x1);
  const yEnd = Math.min(h - 2, y1);
  for (let y = yStart; y <= yEnd; y += step) {
    for (let x = xStart; x <= xEnd; x += step) {
      const gx = grayAt(data, w, x + 1, y) - grayAt(data, w, x - 1, y);
      const gy = grayAt(data, w, x, y + 1) - grayAt(data, w, x, y - 1);
      sum += Math.sqrt(gx * gx + gy * gy);
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * FFmpeg-proxy anatomy heuristics on a single RGBA frame (canvas ImageData.data).
 */
function analyzeFrameAnatomyProxy(data, w, h) {
  const cropH = Math.max(8, Math.floor(h * 0.25));
  const cropY = h - cropH;
  const extEdgeMean = edgeMeanInRect(data, w, h, 0, cropY, w - 1, h - 1, 2);
  const fullEdgeMean = edgeMeanInRect(data, w, h, 0, 0, w - 1, h - 1, 4);
  const skinXs = [];
  const skinYs = [];
  for (let y = cropY; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (isSkinPixelRgb(data[i], data[i + 1], data[i + 2])) {
        skinXs.push(x);
        skinYs.push(y - cropY);
      }
    }
  }
  let fragmented = false;
  if (skinXs.length >= 40) {
    const mx = skinXs.reduce((a, b) => a + b, 0) / skinXs.length;
    const my = skinYs.reduce((a, b) => a + b, 0) / skinYs.length;
    const vx = skinXs.reduce((acc, x) => acc + (x - mx) * (x - mx), 0) / skinXs.length;
    const vy = skinYs.reduce((acc, y) => acc + (y - my) * (y - my), 0) / skinYs.length;
    const std = Math.sqrt(vx + vy);
    const thresh = 0.4 * Math.max(w, cropH);
    fragmented = std > thresh;
  }
  const edgeDistortion = extEdgeMean > 180 && fullEdgeMean < 60;
  return { edgeDistortion, fragmented, extEdgeMean, fullEdgeMean };
}

async function runGate2FfmpegProxy(videoUrl, humanDetected) {
  if (!humanDetected) {
    return {
      score: 1,
      pass: true,
      skipped: true,
      reason: 'no_human_detected',
      detail: { frames_checked: 0, frames_flagged: 0, flags: [] },
    };
  }
  console.warn('[GATE2] Using ffmpeg-proxy (MediaPipe unavailable in this environment)');
  const { createCanvas, loadImage } = require('canvas');
  const dur = await ffprobeDurationSeconds(videoUrl);
  const times = [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => Math.min(dur * p, Math.max(0, dur - 0.05)));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-'));
  const flags = [];
  let flagged = 0;
  try {
    for (let fi = 0; fi < times.length; fi++) {
      const t = times[fi];
      const pngPath = path.join(tmpDir, `f${fi}.png`);
      await extractVideoFrameToFile(videoUrl, pngPath, t);
      const img = await loadImage(pngPath);
      const w = img.width;
      const h = img.height;
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);
      const a = analyzeFrameAnatomyProxy(imageData.data, w, h);
      const reasons = [];
      if (a.edgeDistortion) reasons.push('extremity_edge_distortion');
      if (a.fragmented) reasons.push('skin_region_fragmentation');
      if (reasons.length) {
        flagged++;
        flags.push({ frame: fi, time: t, reasons, metrics: { extEdgeMean: a.extEdgeMean, fullEdgeMean: a.fullEdgeMean } });
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
  const total = times.length;
  const score = Math.max(0, 1 - flagged / total);
  const pass = score >= 0.6;
  return {
    score,
    pass,
    skipped: false,
    detail: { frames_checked: total, frames_flagged: flagged, flags },
  };
}

function handLandmarksCollapsed(landmarks, frameW, frameH) {
  if (!landmarks || landmarks.length < 21) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const lm of landmarks) {
    const x = lm.x * frameW;
    const y = lm.y * frameH;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const r = Math.max(maxX - minX, maxY - minY) / 2;
  return r <= 15;
}

const POSE_CRITICAL_IDX = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26];

function poseLandmarksImplausible(poseLandmarks) {
  if (!poseLandmarks || poseLandmarks.length < 27) return false;
  let low = 0;
  for (const idx of POSE_CRITICAL_IDX) {
    const lm = poseLandmarks[idx];
    if (lm && typeof lm.visibility === 'number' && lm.visibility < 0.35) low++;
  }
  return low > 4;
}

async function runGate2MediaPipe(videoUrl, humanDetected) {
  if (!humanDetected) {
    return {
      score: 1,
      pass: true,
      skipped: true,
      reason: 'no_human_detected',
      detail: { frames_checked: 0, frames_flagged: 0, flags: [] },
    };
  }
  const { FilesetResolver, HandLandmarker, PoseLandmarker } = require('@mediapipe/tasks-vision');
  const wasmDir = path.join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
  const handModel = await ensureHandLandmarkerModelFile(
    path.join(__dirname, 'scripts', 'mediapipe-models', 'hand_landmarker.task'),
  );
  const poseModel = await ensurePoseLandmarkerModelFile(
    path.join(__dirname, 'scripts', 'mediapipe-models', 'pose_landmarker_lite.task'),
  );
  const vision = await FilesetResolver.forVisionTasks('file:' + path.resolve(wasmDir) + path.sep);
  const handLm = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: handModel, delegate: 'CPU' },
    numHands: 2,
    runningMode: 'IMAGE',
  });
  const poseLm = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: poseModel, delegate: 'CPU' },
    runningMode: 'IMAGE',
    numPoses: 1,
  });
  const { createCanvas, loadImage } = require('canvas');
  const dur = await ffprobeDurationSeconds(videoUrl);
  const times = [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => Math.min(dur * p, Math.max(0, dur - 0.05)));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2mp-'));
  const flags = [];
  let flagged = 0;
  try {
    for (let fi = 0; fi < times.length; fi++) {
      const t = times[fi];
      const pngPath = path.join(tmpDir, `f${fi}.png`);
      await extractVideoFrameToFile(videoUrl, pngPath, t);
      const img = await loadImage(pngPath);
      const w = img.width;
      const h = img.height;
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);
      const reasons = [];
      const handRes = handLm.detect(imageData);
      const hands = handRes?.landmarks || [];
      for (let hi = 0; hi < hands.length; hi++) {
        if (handLandmarksCollapsed(hands[hi], w, h)) {
          reasons.push(`hand_melted:${hi}`);
        }
      }
      const poseRes = poseLm.detect(imageData);
      const pl = poseRes?.landmarks?.[0];
      if (poseLandmarksImplausible(pl)) {
        reasons.push('pose_low_visibility');
      }
      if (reasons.length) {
        flagged++;
        flags.push({ frame: fi, time: t, reasons });
      }
    }
  } finally {
    try {
      handLm.close();
      poseLm.close();
    } catch (_) {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
  const total = times.length;
  const score = Math.max(0, 1 - flagged / total);
  const pass = score >= 0.6;
  return {
    score,
    pass,
    skipped: false,
    detail: { frames_checked: total, frames_flagged: flagged, flags },
  };
}

const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

async function ensurePoseLandmarkerModelFile(destPath) {
  if (fs.existsSync(destPath)) return destPath;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const https = await import('https');
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(POSE_MODEL_URL, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error('pose model HTTP ' + res.statusCode));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', reject);
  });
  return destPath;
}

/**
 * Gate 2 — anatomy / limb integrity. Uses MediaPipe when available, else ffmpeg+canvas proxy.
 * @param {string} videoUrl
 * @param {boolean} humanDetected
 */
async function runGate2AnatomyCheck(videoUrl, humanDetected) {
  await resolveGate2Mode();
  const mode = _gate2CapabilityCache.mode;
  if (mode === 'mediapipe') {
    try {
      await ensurePoseLandmarkerModelFile(
        path.join(__dirname, 'scripts', 'mediapipe-models', 'pose_landmarker_lite.task'),
      );
      return await runGate2MediaPipe(videoUrl, humanDetected);
    } catch (e) {
      console.warn('[GATE2] MediaPipe path failed at runtime, falling back to ffmpeg-proxy:', e.message);
      return await runGate2FfmpegProxy(videoUrl, humanDetected);
    }
  }
  return await runGate2FfmpegProxy(videoUrl, humanDetected);
}

/**
 * Multi-gate QA pipeline (reference). Gate 2 is always scored when humanDetected is true.
 */
async function runQAGatePipeline({ videoUrl, humanDetected = true } = {}) {
  const gate1 = { name: 'gate1', skipped: true, note: 'stub — implement pHash/SSIM on API host' };
  const gate2 = await runGate2AnatomyCheck(videoUrl, !!humanDetected);
  const gate3 = { name: 'gate3', skipped: true, note: 'stub — implement ffmpeg analysis on API host' };
  const weights = { gate1: 0.35, gate2: 0.35, gate3: 0.3 };
  let score = 0;
  let denom = 0;
  if (!gate1.skipped && typeof gate1.score === 'number') {
    score += gate1.score * weights.gate1;
    denom += weights.gate1;
  }
  if (!gate2.skipped && typeof gate2.score === 'number') {
    score += gate2.score * weights.gate2;
    denom += weights.gate2;
  } else if (gate2.skipped) {
    score += 1 * weights.gate2;
    denom += weights.gate2;
  }
  if (!gate3.skipped && typeof gate3.score === 'number') {
    score += gate3.score * weights.gate3;
    denom += weights.gate3;
  }
  const combined = denom > 0 ? score / denom : 1;
  const passed = combined >= 0.6 && gate2.pass !== false;
  return { combined, passed, gates: { gate1, gate2, gate3 } };
}

async function maybeSmokeTestGate2() {
  if (_gate2SmokeDone) return;
  const url = String(process.env.GATE2_SMOKE_VIDEO_URL || '').trim();
  if (!url || !/^https?:\/\//.test(url)) return;
  _gate2SmokeDone = true;
  try {
    const r = await runGate2AnatomyCheck(url, true);
    console.log('[GATE2] smoke test result:', JSON.stringify({ score: r.score, pass: r.pass, skipped: r.skipped }));
  } catch (e) {
    console.warn('[GATE2] smoke test failed:', e.message);
  }
}

async function getGate2HealthPayload() {
  await resolveGate2Mode();
  return {
    ...getGate2ModeForHealth(),
    gate2EnvHint:
      'Set GATE2_MODE=ffmpeg_proxy to skip MediaPipe probe on boot, or GATE2_MODE=mediapipe to prefer MediaPipe (falls back to ffmpeg_proxy if init fails).',
  };
}

async function handleAdminHealthHttp(req, res) {
  const g2 = await getGate2HealthPayload();
  const payload = {
    ok: true,
    ...g2,
    airtable: { ok: !!(AIRTABLE_BASE && AIRTABLE_TOKEN), status: AIRTABLE_BASE ? 'configured' : 'missing' },
    fingerprint: process.env.RAILWAY_DEPLOYMENT_ID || process.env.HOSTNAME || 'local',
    crons: { ...CRON_HEARTBEAT },
    queueDepth: { pending: 0, processing: 0, failed24h: 0 },
    errorCount24h: 0,
  };
  return json(res, 200, payload);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function airtableFetch(path, init = {}) {
  const url = path.startsWith('http') ? path : `${AIRTABLE_API}/${AIRTABLE_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${AIRTABLE_TOKEN}`,
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text };
  }
  if (!res.ok) {
    const err = new Error(json.error?.message || res.statusText || 'Airtable error');
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function escapeFormulaString(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function resolveUploadPostSnapshot(clientFields) {
  const raw =
    clientFields?.upload_post_accounts_json ||
    clientFields?.upload_post_connection_json ||
    clientFields?.upload_post_accounts;
  if (raw && typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.accounts)) return { accounts: parsed.accounts };
      if (Array.isArray(parsed)) return { accounts: parsed };
    } catch {
      /* fall through */
    }
  }
  const username = String(clientFields?.upload_post_username || '').trim();
  const platforms = Array.isArray(clientFields?.social_connected_platforms)
    ? clientFields.social_connected_platforms
    : String(clientFields?.social_connected_platforms || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
  const accounts = [];
  if (username) {
    for (const p of platforms.length ? platforms : ['instagram']) {
      accounts.push({ platform: String(p).toLowerCase(), username });
    }
  }
  return { accounts };
}

function pickPrimaryPublishPlatform(clientFields, snapshot) {
  const accounts = snapshot?.accounts || [];
  const order = ['instagram', 'tiktok', 'facebook'];
  for (const plat of order) {
    if (accounts.some((a) => String(a?.platform || '').toLowerCase() === plat)) return plat;
  }
  const connected = Array.isArray(clientFields?.social_connected_platforms)
    ? clientFields.social_connected_platforms
    : String(clientFields?.social_connected_platforms || '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
  for (const plat of order) {
    if (connected.includes(plat)) return plat;
  }
  return 'instagram';
}

// ---------------------------------------------------------------------------
// BIS v1.1 — Brand Intelligence (SOC-7)
// ---------------------------------------------------------------------------

const BIS_DEBOUNCE_MS = 60 * 60 * 1000;
const BIS_FETCH_TIMEOUT_MS = 8000;

const BIS_DIM_KEYS = [
  'dim1_voice',
  'dim2_aesthetic',
  'dim3_buyer_motivation',
  'dim4_cultural_position',
  'dim5_customer_relationship',
  'dim6_stakes_model',
  'dim7_product_relationship',
  'dim8_tribal_markers',
  'dim9_trust_architecture',
  'dim10_evolution_vector',
];

function applyConfidenceGate(dimension, value, confidence) {
  const c = typeof confidence === 'number' && !Number.isNaN(confidence) ? confidence : 0;
  const phase2 = new Set([
    'dim6_stakes_model',
    'dim8_tribal_markers',
    'dim9_trust_architecture',
    'dim10_evolution_vector',
  ]);
  if (phase2.has(dimension)) {
    return { mode: 'B', value: null, confidence: c, threshold: null };
  }
  let threshold = 0.8;
  if (dimension === 'hero_product') threshold = 0.8;
  if (dimension === 'dim3_buyer_motivation' || dimension === 'dim4_cultural_position') threshold = 0.8;
  if (
    dimension === 'dim1_voice' ||
    dimension === 'dim2_aesthetic' ||
    dimension === 'dim5_customer_relationship' ||
    dimension === 'dim7_product_relationship'
  ) {
    threshold = 0.8;
  }
  const hasValue = value !== undefined && value !== null;
  const modeA = hasValue && c >= threshold;
  return {
    mode: modeA ? 'A' : 'B',
    value: modeA ? value : null,
    confidence: c,
    threshold,
  };
}

function getModeBUnlockCondition(dimension) {
  const map = {
    dim6_stakes_model: 'Your primary buying trigger will populate after 10 published videos',
    dim8_tribal_markers: 'Your brand vocabulary fingerprint will emerge after 20 published videos',
    dim9_trust_architecture:
      'Your trust signals will be identified after your Brand tab content is reviewed',
    dim10_evolution_vector: 'Your brand trajectory will be visible after 90 days of activity',
  };
  return map[dimension] || 'This signal unlocks as we gather more brand activity';
}

function stripHtmlToText(html) {
  const s = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = BIS_FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/** Lightweight color/font heuristics from image URLs (detectBackgroundType-style). */
function detectImageAssetSignals(imageUrls) {
  const urls = (imageUrls || []).filter((u) => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 12);
  let dark = 0;
  let light = 0;
  for (const u of urls) {
    const lower = u.toLowerCase();
    if (/black|charcoal|navy|midnight|#0{3,6}|rgb\(0/.test(lower)) dark++;
    if (/white|cream|ivory|#f[f0-9]{5}|pastel|soft/i.test(lower)) light++;
  }
  return {
    sources: urls.slice(0, 5),
    summary:
      dark > light + 2
        ? 'dark-dominant product imagery'
        : light > dark + 2
          ? 'light-bright product imagery'
          : 'mixed product imagery palette',
  };
}

async function getClientCatalog(clientFields) {
  const domain = String(clientFields?.shopify_domain || clientFields?.shop_domain || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;
  const products = [];
  if (!domain || !token) {
    return { products, shopifyDomain: domain, source: 'stub' };
  }
  try {
    const url = `https://${domain}/admin/api/2024-01/products.json?limit=50&fields=id,title,body_html,handle,product_type,images,variants`;
    const res = await fetchWithTimeout(url, {
      headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' },
    });
    if (!res.ok) return { products, shopifyDomain: domain, source: 'shopify_error' };
    const data = await res.json();
    const rows = data.products || [];
    rows.forEach((p, idx) => {
      const v0 = (p.variants && p.variants[0]) || {};
      const price = parseFloat(v0.price) || 0;
      const imgs = Array.isArray(p.images) ? p.images.map((i) => i.src).filter(Boolean) : [];
      products.push({
        id: String(p.id),
        name: p.title,
        title: p.title,
        handle: p.handle ? String(p.handle) : '',
        product_type: p.product_type ? String(p.product_type) : '',
        description: stripHtmlToText(p.body_html || ''),
        price,
        reviewCount: 0,
        listingPosition: idx + 1,
        imageUrls: imgs,
        sku: v0.sku ? String(v0.sku) : '',
      });
    });
    return { products, shopifyDomain: domain, source: 'shopify' };
  } catch {
    return { products, shopifyDomain: domain, source: 'shopify_exception' };
  }
}

function scoreHeroProduct(products) {
  if (!products.length) return { hero: null, confidence: 0 };
  const prices = products.map((p) => p.price || 0).filter((n) => n > 0);
  const maxP = prices.length ? Math.max(...prices) : 1;
  let best = null;
  let bestScore = -1;
  for (const p of products) {
    const rc = p.reviewCount || 0;
    const pos = p.listingPosition || 999;
    const invPos = 1 / Math.max(1, pos);
    const priceNorm = maxP > 0 ? (p.price || 0) / maxP : 0;
    const score = rc * 0.4 + invPos * 0.3 + priceNorm * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  const rc = best.reviewCount || 0;
  const conf = Math.min(0.8, rc > 10 ? 0.8 : rc * 0.08);
  return { hero: best, confidence: conf };
}

function pricePositioningFromCatalog(products) {
  const prices = products.map((p) => p.price || 0).filter((n) => n > 0);
  if (!prices.length) return { band: 'mid', confidence: 0.5 };
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  let band = 'mid';
  if (mid < 30) band = 'budget';
  else if (mid > 150) band = 'premium';
  return { band, confidence: 0.9 };
}

async function pplxChatJson(systemPrompt, userContent) {
  if (!PERPLEXITY_API_KEY) {
    throw new Error('PERPLEXITY_API_KEY is not configured');
  }
  const body = {
    model: PERPLEXITY_MODEL,
    max_tokens: 4096,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data.error?.message || `Perplexity HTTP ${res.status}`);
    err.body = data;
    throw err;
  }
  const raw = data.choices?.[0]?.message?.content || '';
  const cleaned = String(raw)
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    return {};
  }
}

function buildBisSynthesisPrompt(ingestionBundle) {
  return `You are a brand strategist. Return ONLY valid JSON. No markdown. No hedging language.

If insufficient evidence for a dimension, set confidence below 0.70 for that dimension. Do not guess.

Required JSON shape:
{
  "dim1_voice": {
    "authority_approachability": { "value": 0.0-1.0, "confidence": 0.0-1.0 },
    "polished_raw": { "value": 0.0-1.0, "confidence": 0.0-1.0 },
    "earnest_ironic": { "value": 0.0-1.0, "confidence": 0.0-1.0 },
    "warm_cool": { "value": 0.0-1.0, "confidence": 0.0-1.0 }
  },
  "dim2_aesthetic": {
    "maximalist_minimalist": { "value": 0.0-1.0, "confidence": 0.0-1.0 },
    "saturated_muted": { "value": 0.0-1.0, "confidence": 0.0-1.0 },
    "vintage_futuristic": { "value": 0.0-1.0, "confidence": 0.0-1.0 }
  },
  "dim3_buyer_motivation": {
    "primary": { "label": "string", "weight": 0.0-1.0, "confidence": 0.0-1.0 },
    "secondary": { "label": "string", "weight": 0.0-1.0, "confidence": 0.0-1.0 }
  },
  "dim4_cultural_position": { "value": "Leader|Adopter|Refiner|Resistor|Niche", "confidence": 0.0-1.0 },
  "dim5_customer_relationship": {
    "value": "Authority→Pupil|Friend→Friend|Insider→Insider|Performer→Audience|Servant→Customer",
    "confidence": 0.0-1.0
  },
  "dim7_product_relationship": {
    "value": "Hero|Tool|Symbol|Companion|Statement|Trophy|one of the seven",
    "confidence": 0.0-1.0
  },
  "brand_vocabulary": ["up to 10 strings"],
  "banned_phrases": ["strings"],
  "competitor_gaps": ["strings"],
  "confidence_scores": {
    "dim1_voice": 0.0-1.0,
    "dim2_aesthetic": 0.0-1.0,
    "dim3_buyer_motivation": 0.0-1.0,
    "dim4_cultural_position": 0.0-1.0,
    "dim5_customer_relationship": 0.0-1.0,
    "dim7_product_relationship": 0.0-1.0
  }
}

INGESTED DATA (truncated):\n${JSON.stringify(ingestionBundle).slice(0, 90000)}`;
}

function wrapDimPayload(gate, rawValue, sources) {
  const base = { value: gate.mode === 'A' ? rawValue : null, confidence: gate.confidence, sources: sources || [], mode: gate.mode };
  return base;
}

function emptyModeBUnlocks() {
  const o = {};
  for (const d of BIS_DIM_KEYS) o[d] = getModeBUnlockCondition(d);
  return o;
}

async function listBrandDnaVersionsForClient(clientRecordId) {
  const esc = escapeFormulaString(clientRecordId);
  const formula = `{client_id}='${esc}'`;
  const q = new URLSearchParams({
    filterByFormula: formula,
    pageSize: '100',
    'sort[0][field]': 'version',
    'sort[0][direction]': 'desc',
  });
  const json = await airtableFetch(`/${encodeURIComponent(TBL_BRAND_DNA)}?${q}`);
  return json.records || [];
}

async function getLatestBrandDnaRecord(clientRecordId) {
  const recs = await listBrandDnaVersionsForClient(clientRecordId);
  return recs[0] || null;
}

async function runBrandDnaIngestion(clientId, options = {}) {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
    throw new Error('Airtable is not configured');
  }
  const clientRec = await airtableFetch(`/${encodeURIComponent(TBL_CLIENTS)}/${encodeURIComponent(clientId)}`);
  const clientFields = clientRec.fields || {};
  const triggeredBy = String(options.triggeredBy || 'manual_refresh').slice(0, 80);

  const existing = await getLatestBrandDnaRecord(clientId);
  if (existing?.fields?.created_at) {
    const t = new Date(existing.fields.created_at).getTime();
    if (!Number.isNaN(t) && Date.now() - t < BIS_DEBOUNCE_MS) {
      const dna = brandDnaRecordToClientObject(existing);
      return { ok: true, debounced: true, version: dna.version, dna, modeBDimensions: dna.modeBDimensions || [] };
    }
  }

  const catalogPromise = getClientCatalog(clientFields);
  const shopDomain = String(clientFields.shopify_domain || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const siteUrl = shopDomain ? `https://${shopDomain}` : '';
  const sitePromise = siteUrl
    ? fetchWithTimeout(siteUrl, { headers: { Accept: 'text/html' } }).catch(() => null)
    : Promise.resolve(null);

  const competitorUrls = (Array.isArray(options.competitorUrls) ? options.competitorUrls : [])
    .map((u) => String(u || '').trim())
    .filter((u) => /^https:\/\//.test(u))
    .slice(0, 3);
  const compPromises = competitorUrls.map((u) =>
    fetchWithTimeout(u, { headers: { Accept: 'text/html' } }).catch(() => null),
  );

  const settled = await Promise.allSettled([catalogPromise, sitePromise, ...compPromises]);
  const catalogResult = settled[0].status === 'fulfilled' ? settled[0].value : { products: [], shopifyDomain: '', source: 'error' };
  const products = catalogResult.products || [];
  const imageUrls = products.flatMap((p) => p.imageUrls || []).slice(0, 30);
  const assetSignals = detectImageAssetSignals(imageUrls);

  let siteText = '';
  if (settled[1].status === 'fulfilled' && settled[1].value && settled[1].value.ok) {
    const html = await settled[1].value.text().catch(() => '');
    siteText = stripHtmlToText(html).slice(0, 12000);
  }

  const sourcesUsed = [];
  if (siteUrl) sourcesUsed.push(siteUrl);
  competitorUrls.forEach((u, i) => {
    const r = settled[2 + i];
    if (r && r.status === 'fulfilled' && r.value && r.value.ok) sourcesUsed.push(u);
  });

  const competitorSnippets = [];
  for (let i = 0; i < competitorUrls.length; i++) {
    const r = settled[2 + i];
    if (r && r.status === 'fulfilled' && r.value && r.value.ok) {
      const txt = await r.value.text().catch(() => '');
      competitorSnippets.push({ url: competitorUrls[i], text: stripHtmlToText(txt).slice(0, 8000) });
    }
  }

  const { hero, confidence: heroConfRaw } = scoreHeroProduct(products);
  const { band: priceBand, confidence: priceConf } = pricePositioningFromCatalog(products);

  const heroGate = applyConfidenceGate('hero_product', hero ? { name: hero.name || hero.title, sku: hero.sku || '' } : null, heroConfRaw);
  const heroProductJson = wrapDimPayload(
    heroGate,
    heroGate.mode === 'A' ? { name: hero.name, sku: hero.sku || '', confidence: heroConfRaw, sources: hero.imageUrls?.slice(0, 3) || [] } : null,
    hero?.imageUrls || [],
  );

  const ingestionBundle = {
    catalog: products.slice(0, 40).map((p) => ({
      name: p.name,
      price: p.price,
      description: (p.description || '').slice(0, 500),
      listingPosition: p.listingPosition,
    })),
    storefrontText: siteText.slice(0, 12000),
    competitorSnippets,
    assetSignals,
    price_positioning_guess: priceBand,
  };

  let synth = {};
  try {
    synth = await pplxChatJson(
      'Return only valid JSON. No hedging language. If insufficient evidence for a dimension, set confidence below 0.70. Do not guess.',
      buildBisSynthesisPrompt(ingestionBundle),
    );
  } catch (e) {
    synth = {};
  }

  const confScores = synth.confidence_scores || {};
  const dimGates = {};
  const modeBDimensions = [];
  const modeAKeys = [];

  const d1 = dimGates.dim1_voice = applyConfidenceGate('dim1_voice', synth.dim1_voice, confScores.dim1_voice ?? 0.5);
  const d2 = dimGates.dim2_aesthetic = applyConfidenceGate('dim2_aesthetic', synth.dim2_aesthetic, confScores.dim2_aesthetic ?? 0.5);
  const d3 = dimGates.dim3_buyer_motivation = applyConfidenceGate(
    'dim3_buyer_motivation',
    synth.dim3_buyer_motivation,
    confScores.dim3_buyer_motivation ?? 0.5,
  );
  const d4 = dimGates.dim4_cultural_position = applyConfidenceGate(
    'dim4_cultural_position',
    synth.dim4_cultural_position,
    confScores.dim4_cultural_position ?? 0.5,
  );
  const d5 = dimGates.dim5_customer_relationship = applyConfidenceGate(
    'dim5_customer_relationship',
    synth.dim5_customer_relationship,
    confScores.dim5_customer_relationship ?? 0.5,
  );
  const d7 = dimGates.dim7_product_relationship = applyConfidenceGate(
    'dim7_product_relationship',
    synth.dim7_product_relationship,
    confScores.dim7_product_relationship ?? 0.5,
  );

  if (d1.mode === 'B') modeBDimensions.push('dim1_voice');
  else modeAKeys.push('dim1_voice');
  if (d2.mode === 'B') modeBDimensions.push('dim2_aesthetic');
  else modeAKeys.push('dim2_aesthetic');
  if (d3.mode === 'B') modeBDimensions.push('dim3_buyer_motivation');
  else modeAKeys.push('dim3_buyer_motivation');
  if (d4.mode === 'B') modeBDimensions.push('dim4_cultural_position');
  else modeAKeys.push('dim4_cultural_position');
  if (d5.mode === 'B') modeBDimensions.push('dim5_customer_relationship');
  else modeAKeys.push('dim5_customer_relationship');
  if (d7.mode === 'B') modeBDimensions.push('dim7_product_relationship');
  else modeAKeys.push('dim7_product_relationship');

  const phase2Keys = ['dim6_stakes_model', 'dim8_tribal_markers', 'dim9_trust_architecture', 'dim10_evolution_vector'];
  for (const pk of phase2Keys) {
    modeBDimensions.push(pk);
    dimGates[pk] = applyConfidenceGate(pk, null, 0);
  }
  const g6 = dimGates.dim6_stakes_model;
  const g8 = dimGates.dim8_tribal_markers;
  const g9 = dimGates.dim9_trust_architecture;
  const g10 = dimGates.dim10_evolution_vector;

  const confidenceSummary = {};
  for (const k of BIS_DIM_KEYS) {
    confidenceSummary[k] = dimGates[k] ? dimGates[k].confidence : 0;
  }
  confidenceSummary.hero_product = heroGate.confidence;
  confidenceSummary.price_positioning = priceConf;

  const modeBUnlocks = emptyModeBUnlocks();
  for (const k of BIS_DIM_KEYS) {
    const g = dimGates[k] || applyConfidenceGate(k, null, 0);
    if (g.mode === 'B') {
      /* keep default unlock string */
    } else {
      delete modeBUnlocks[k];
    }
  }
  if (heroGate.mode === 'B') modeBUnlocks.hero_product = 'Connect Shopify reviews or run another analysis to sharpen hero detection';

  const prevMax = existing?.fields?.version != null ? Number(existing.fields.version) : 0;
  const version = (Number.isFinite(prevMax) ? prevMax : 0) + 1;

  const eventEntry = {
    type: 'brand_dna_ingested',
    version,
    dimensions_mode_a: modeAKeys.filter((k) => !phase2Keys.includes(k)),
    dimensions_mode_b: [...new Set(modeBDimensions)],
    triggered_by: triggeredBy,
    timestamp: new Date().toISOString(),
  };
  const eventLog = JSON.stringify([eventEntry]);

  const fields = {
    client_id: clientId,
    version,
    triggered_by: triggeredBy,
    created_at: new Date().toISOString(),
    dim1_voice: JSON.stringify(wrapDimPayload(d1, synth.dim1_voice, sourcesUsed)),
    dim2_aesthetic: JSON.stringify(wrapDimPayload(d2, synth.dim2_aesthetic, sourcesUsed)),
    dim3_buyer_motivation: JSON.stringify(wrapDimPayload(d3, synth.dim3_buyer_motivation, sourcesUsed)),
    dim4_cultural_position: JSON.stringify(wrapDimPayload(d4, synth.dim4_cultural_position, sourcesUsed)),
    dim5_customer_relationship: JSON.stringify(wrapDimPayload(d5, synth.dim5_customer_relationship, sourcesUsed)),
    dim6_stakes_model: JSON.stringify(wrapDimPayload(g6, null, [])),
    dim7_product_relationship: JSON.stringify(wrapDimPayload(d7, synth.dim7_product_relationship, sourcesUsed)),
    dim8_tribal_markers: JSON.stringify(wrapDimPayload(g8, null, [])),
    dim9_trust_architecture: JSON.stringify(wrapDimPayload(g9, null, [])),
    dim10_evolution_vector: JSON.stringify(wrapDimPayload(g10, null, [])),
    hero_product: JSON.stringify(heroProductJson),
    price_positioning: priceBand,
    brand_vocabulary: JSON.stringify(Array.isArray(synth.brand_vocabulary) ? synth.brand_vocabulary.slice(0, 20) : []),
    banned_phrases: JSON.stringify(Array.isArray(synth.banned_phrases) ? synth.banned_phrases : []),
    competitor_gaps: JSON.stringify(Array.isArray(synth.competitor_gaps) ? synth.competitor_gaps : []),
    confidence_summary: JSON.stringify(confidenceSummary),
    mode_b_unlocks: JSON.stringify(modeBUnlocks),
    sources_used: JSON.stringify([...sourcesUsed, ...assetSignals.sources.map((u) => `image:${u}`)]),
    event_bus_log: eventLog,
  };

  const created = await airtableFetch(`/${encodeURIComponent(TBL_BRAND_DNA)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });

  const dna = brandDnaRecordToClientObject({ id: created.id, fields: { ...fields } });
  const changes = [];
  if (existing?.fields) {
    const prev = existing.fields;
    if (String(prev.price_positioning) !== String(fields.price_positioning)) {
      changes.push({ field: 'price_positioning', from: prev.price_positioning, to: fields.price_positioning });
    }
    if (String(prev.hero_product || '') !== String(fields.hero_product || '')) {
      changes.push({ field: 'hero_product', from: 'previous', to: 'updated' });
    }
  }
  return { ok: true, version, dna, modeBDimensions: [...new Set(modeBDimensions)], changes };
}

function parseJsonField(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function brandDnaRecordToClientObject(rec) {
  if (!rec) return null;
  const f = rec.fields || {};
  const modeBDimensions = [];
  const dims = {};
  for (const key of BIS_DIM_KEYS) {
    const parsed = parseJsonField(f[key], { mode: 'B', value: null, confidence: 0, sources: [] });
    dims[key] = parsed;
    if (parsed.mode === 'B') modeBDimensions.push(key);
  }
  const hero = parseJsonField(f.hero_product, { mode: 'B', value: null, confidence: 0, sources: [] });
  if (hero.mode === 'B') modeBDimensions.push('hero_product');

  return {
    id: rec.id,
    version: f.version,
    triggered_by: f.triggered_by,
    created_at: f.created_at,
    dims,
    hero_product: hero,
    price_positioning: f.price_positioning || null,
    brand_vocabulary: parseJsonField(f.brand_vocabulary, []),
    banned_phrases: parseJsonField(f.banned_phrases, []),
    competitor_gaps: parseJsonField(f.competitor_gaps, []),
    confidence_summary: parseJsonField(f.confidence_summary, {}),
    mode_b_unlocks: parseJsonField(f.mode_b_unlocks, {}),
    sources_used: parseJsonField(f.sources_used, []),
    event_bus_log: parseJsonField(f.event_bus_log, []),
    modeBDimensions: [...new Set(modeBDimensions)],
  };
}

/** Latest row: Mode A slices for prompt wiring (generation). */
async function getBrandDnaForClient(clientRecordId) {
  const rec = await getLatestBrandDnaRecord(clientRecordId);
  if (!rec) return null;
  const full = brandDnaRecordToClientObject(rec);
  const modeA = {};
  for (const k of BIS_DIM_KEYS) {
    if (full.dims[k]?.mode === 'A') modeA[k] = full.dims[k].value;
  }
  if (full.hero_product?.mode === 'A') modeA.hero_product = full.hero_product.value;
  modeA.price_positioning = full.price_positioning;
  modeA.brand_vocabulary = Array.isArray(full.brand_vocabulary) ? full.brand_vocabulary : [];
  modeA.banned_phrases = Array.isArray(full.banned_phrases) ? full.banned_phrases : [];
  modeA.competitor_gaps = Array.isArray(full.competitor_gaps) ? full.competitor_gaps : [];
  modeA.version = full.version;
  return modeA;
}

function buildStopScrollHookPrompt(basePrompt, brandDnaModeA) {
  const d = brandDnaModeA || {};
  const parts = [String(basePrompt || '').trim()];
  if (!parts[0]) parts[0] = 'Create a high-retention short-form hook.';

  if (d.dim1_voice) {
    parts.push(
      `Caption tone (voice spectrum JSON): align pacing and diction with this voice profile: ${JSON.stringify(d.dim1_voice).slice(0, 1200)}`,
    );
  }
  if (d.dim3_buyer_motivation) {
    parts.push(
      `Hook angle & CTA structure: lead with motivations and weighting: ${JSON.stringify(d.dim3_buyer_motivation).slice(0, 800)}`,
    );
  }
  if (d.dim5_customer_relationship) {
    parts.push(
      `POV / address style (customer relationship): ${JSON.stringify(d.dim5_customer_relationship).slice(0, 400)}`,
    );
  }
  if (d.dim7_product_relationship) {
    parts.push(`Product framing: ${JSON.stringify(d.dim7_product_relationship).slice(0, 400)}`);
  }
  if (Array.isArray(d.brand_vocabulary) && d.brand_vocabulary.length) {
    parts.push(`Prefer these brand vocabulary terms where natural: ${d.brand_vocabulary.slice(0, 12).join(', ')}`);
  }
  if (Array.isArray(d.banned_phrases) && d.banned_phrases.length) {
    parts.push(`Avoid these phrases entirely: ${d.banned_phrases.slice(0, 20).join(', ')}`);
  }
  if (d.hero_product && (d.hero_product.name || d.hero_product.title)) {
    const hn = d.hero_product.name || d.hero_product.title;
    parts.push(`Hero product focus when relevant: ${hn}`);
  }
  if (d.price_positioning) {
    parts.push(`Price band context: ${d.price_positioning}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Ensure BRAND_DNA_VERSIONS table exists (idempotent).
 */
async function ensureBrandDnaTableExists() {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) return false;
  const listUrl = `${AIRTABLE_META}/${encodeURIComponent(AIRTABLE_BASE)}/tables`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  const listJson = await listRes.json().catch(() => ({}));
  if (!listRes.ok) return false;
  if ((listJson.tables || []).some((t) => t.name === TBL_BRAND_DNA)) {
    console.log(`[soc7-schema] Table "${TBL_BRAND_DNA}" already exists.`);
    return true;
  }
  const schemaPath = path.join(__dirname, 'scripts', 'soc7-schema.js');
  const { getBrandDnaVersionsTableDefinition } = require(schemaPath);
  const body = getBrandDnaVersionsTableDefinition(TBL_BRAND_DNA);
  const createRes = await fetch(listUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const createJson = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    console.error('[soc7-schema] create failed', createRes.status, createJson);
    return false;
  }
  console.log('[soc7-schema] Created', createJson.name, createJson.id);
  return true;
}

function mountBrandDnaRoutes(app, options = {}) {
  const vc = options.verifyClient || verifyClient();
  app.post('/api/brand-dna/run', vc, async (req, res, next) => {
    try {
      const clientRec = req.soc10Client;
      const competitorUrls = req.body?.competitorUrls;
      const out = await runBrandDnaIngestion(clientRec.id, {
        competitorUrls,
        triggeredBy: req.body?.triggeredBy || 'manual_refresh',
      });
      res.json({ ok: true, ...out });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/brand-dna/latest', vc, async (req, res, next) => {
    try {
      const rec = await getLatestBrandDnaRecord(req.soc10Client.id);
      if (!rec) return res.json({ exists: false });
      res.json({ exists: true, dna: brandDnaRecordToClientObject(rec) });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/brand-dna/versions', vc, async (req, res, next) => {
    try {
      const recs = await listBrandDnaVersionsForClient(req.soc10Client.id);
      const list = recs.map((r) => ({
        version: r.fields?.version,
        created_at: r.fields?.created_at,
        triggered_by: r.fields?.triggered_by,
        id: r.id,
      }));
      res.json({ versions: list });
    } catch (e) {
      next(e);
    }
  });
}

async function getOnboardingStatePayload(clientRec) {
  const f = clientRec.fields || {};
  const step = Number(f.onboarding_step ?? 0) || 0;
  const completed = f.onboarding_completed === true;
  let generationCount = 0;
  try {
    generationCount = await countGenerationsForClient(clientRec.id);
  } catch {
    generationCount = 0;
  }
  let hasBrandDna = false;
  try {
    const dna = await getLatestBrandDnaRecord(clientRec.id);
    hasBrandDna = !!dna;
  } catch {
    hasBrandDna = false;
  }
  return {
    step,
    completed,
    firstVideoGeneratedAt: f.first_video_generated_at || null,
    firstVideoPublishedAt: f.first_video_published_at || null,
    generationCount,
    hasBrandDna,
  };
}

function mountOnboardingRoutes(app, options = {}) {
  const vc = options.verifyClient || verifyClient();
  app.post('/api/onboarding/step', vc, async (req, res, next) => {
    try {
      const step = Number(req.body?.step);
      if (!Number.isFinite(step) || step < 0 || step > 5) {
        return res.status(400).json({ error: 'step must be 0–5' });
      }
      const patch = { onboarding_step: step };
      if (step >= 5) patch.onboarding_completed = true;
      await patchClientRecord(req.soc10Client.id, patch);
      res.json({ ok: true, step });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/onboarding/state', vc, async (req, res, next) => {
    try {
      const fresh = await airtableFetch(
        `/${encodeURIComponent(TBL_CLIENTS)}/${encodeURIComponent(req.soc10Client.id)}`,
      );
      const payload = await getOnboardingStatePayload(fresh);
      res.json(payload);
    } catch (e) {
      next(e);
    }
  });
}

async function publishPostViaUploadPost({ videoUrl, caption, user, platform = 'instagram' }) {
  if (!UPLOAD_POST_KEY) {
    const err = new Error('UPLOAD_POST_API_KEY is not configured');
    err.status = 500;
    throw err;
  }
  const fd = new FormData();
  fd.set('user', user);
  fd.append('platform[]', platform);
  fd.set('video', videoUrl);
  const cap = String(caption || '').trim();
  if (cap) {
    fd.set('title', cap);
    if (platform === 'instagram') fd.set('instagram_title', cap);
  }

  const res = await fetch('https://api.upload-post.com/api/upload', {
    method: 'POST',
    headers: { Authorization: `Apikey ${UPLOAD_POST_KEY}` },
    body: fd,
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  const postId =
    body.post_id ||
    body.postId ||
    body.id ||
    body?.data?.post_id ||
    body?.instagram?.id ||
    body?.instagram?.media_id ||
    null;
  return { ok: res.ok, status: res.status, body, postId: postId != null ? String(postId) : null };
}

/** Override by passing `logAdminError` into `mountSoc10PublishRoutes`. */
function createDefaultLogAdminError() {
  return async function logAdminError(payload) {
    if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) return;
    try {
      const fields = {
        [ERR_FIELD_MESSAGE]: String(payload.message || payload.error || 'Publish error').slice(0, 8000),
        [ERR_FIELD_DETAILS]:
          typeof payload.details === 'string' ? payload.details : JSON.stringify(payload.details || {}),
        [ERR_FIELD_SOURCE]: String(payload.source || 'publish'),
        [ERR_FIELD_CREATED]: new Date().toISOString(),
      };
      await airtableFetch(`/${encodeURIComponent(TBL_ERRORS)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
    } catch (e) {
      console.error('[ERROR_LOG]', e.message);
    }
  };
}

let _injectedLogAdminError = null;

function logAdminError(payload) {
  const fn = _injectedLogAdminError || createDefaultLogAdminError();
  return fn(payload);
}

async function findClientByAuth(email, hash) {
  const emailEsc = escapeFormulaString(String(email || '').trim().toLowerCase());
  const hashEsc = escapeFormulaString(String(hash || '').trim());
  const formula = `AND(LOWER({contact_email})='${emailEsc}',{hash}='${hashEsc}')`;
  const q = new URLSearchParams({
    filterByFormula: formula,
    maxRecords: '1',
  });
  const json = await airtableFetch(`/${encodeURIComponent(TBL_CLIENTS)}?${q}`);
  const rec = json.records?.[0];
  return rec || null;
}

async function findClientByEmail(email) {
  const emailEsc = escapeFormulaString(String(email || '').trim().toLowerCase());
  const formula = `LOWER({contact_email})='${emailEsc}'`;
  const q = new URLSearchParams({ filterByFormula: formula, maxRecords: '1' });
  const json = await airtableFetch(`/${encodeURIComponent(TBL_CLIENTS)}?${q}`);
  return json.records?.[0] || null;
}

async function patchClientRecord(recordId, fields) {
  return airtableFetch(`/${encodeURIComponent(TBL_CLIENTS)}/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}

function parseOnboardingEmailsSent(raw) {
  try {
    if (raw == null || raw === '') return [];
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function onboardingSignupTime(fields) {
  const d = fields?.onboarding_date || fields?.created_at || fields?.signup_date;
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
}

async function sendTransactionalEmail({ to, subject, html, text }) {
  const fn = globalThis.__SE_SEND_EMAIL__;
  if (typeof fn === 'function') {
    await fn({ to, subject, html, text });
    return;
  }
  const url = process.env.EMAIL_WEBHOOK_URL || process.env.SENDGRID_WEBHOOK_URL;
  if (url) {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, html, text }),
    });
    return;
  }
  console.log('[onboarding-email]', { to, subject, text: text || subject });
}

async function appendOnboardingEmailSent(clientRecordId, type) {
  const rec = await airtableFetch(`/${encodeURIComponent(TBL_CLIENTS)}/${encodeURIComponent(clientRecordId)}`);
  const prev = parseOnboardingEmailsSent(rec.fields?.onboarding_emails_sent);
  if (prev.includes(type)) return;
  prev.push(type);
  await patchClientRecord(clientRecordId, { onboarding_emails_sent: JSON.stringify(prev) });
}

/**
 * Call from POST /api/studio/generate-video-v2 when a generation completes for a client.
 * Sets first_video_generated_at and onboarding_step = 5 when first video.
 */
async function logGeneration(clientRecordId) {
  if (!clientRecordId || !AIRTABLE_BASE || !AIRTABLE_TOKEN) return;
  try {
    const rec = await airtableFetch(`/${encodeURIComponent(TBL_CLIENTS)}/${encodeURIComponent(clientRecordId)}`);
    const f = rec.fields || {};
    if (f.first_video_generated_at) return;
    const now = new Date().toISOString();
    await patchClientRecord(clientRecordId, {
      first_video_generated_at: now,
      onboarding_step: 5,
    });
  } catch (e) {
    console.warn('[onboarding] logGeneration failed', e.message);
  }
}

async function recordFirstVideoPublishedIfNeeded(clientRecordId) {
  if (!clientRecordId || !AIRTABLE_BASE || !AIRTABLE_TOKEN) return;
  try {
    const rec = await airtableFetch(`/${encodeURIComponent(TBL_CLIENTS)}/${encodeURIComponent(clientRecordId)}`);
    const f = rec.fields || {};
    if (f.first_video_published_at) return;
    await patchClientRecord(clientRecordId, {
      first_video_published_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[onboarding] recordFirstVideoPublishedIfNeeded failed', e.message);
  }
}

async function countGenerationsForClient(clientRecordId) {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) return 0;
  const esc = escapeFormulaString(clientRecordId);
  const formulas = [
    `{client}='${esc}'`,
    `{Client}='${esc}'`,
    `FIND('${esc}', ARRAYJOIN({clients}))`,
  ];
  for (const formula of formulas) {
    try {
      let total = 0;
      let nextOffset = '';
      for (;;) {
        const q = new URLSearchParams({
          filterByFormula: formula,
          pageSize: '100',
        });
        if (nextOffset) q.set('offset', nextOffset);
        const json = await airtableFetch(`/${encodeURIComponent(TBL_GENERATIONS)}?${q}`);
        const recs = json.records || [];
        total += recs.length;
        if (!json.offset) break;
        nextOffset = String(json.offset);
      }
      return total;
    } catch {
      /* try next formula */
    }
  }
  return 0;
}

async function handleStripeCheckoutCompleted(session) {
  const meta = session?.metadata || {};
  let clientId = meta.airtable_client_id || meta.client_id || session.client_reference_id;
  let clientRec = null;
  if (clientId && /^rec[a-z0-9]{14,}$/i.test(String(clientId).trim())) {
    try {
      clientRec = await airtableFetch(
        `/${encodeURIComponent(TBL_CLIENTS)}/${encodeURIComponent(String(clientId).trim())}`,
      );
    } catch {
      clientRec = null;
    }
  }
  const custEmail = session.customer_email || session.customer_details?.email;
  if (!clientRec && custEmail) {
    clientRec = await findClientByEmail(custEmail);
  }
  if (!clientRec) return;
  const cur = Number(clientRec.fields?.onboarding_step ?? 0) || 0;
  if (cur < 1) {
    await patchClientRecord(clientRec.id, { onboarding_step: 1 });
  }
}

async function handleStripeWebhookHttp(req, res) {
  let raw = '';
  try {
    raw = await new Promise((resolve, reject) => {
      let buf = '';
      req.on('data', (c) => {
        buf += c;
        if (buf.length > 5e6) {
          reject(new Error('payload too large'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(buf));
      req.on('error', reject);
    });
  } catch {
    return json(res, 400, { error: 'invalid body' });
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: 'invalid json' });
  }
  if (event.type === 'checkout.session.completed') {
    await handleStripeCheckoutCompleted(event.data?.object || {});
  }
  return json(res, 200, { received: true });
}

async function runOnboardingLifecycleCron() {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) return;
  const start = Date.now();
  const formula = 'OR({onboarding_completed}=BLANK(),{onboarding_completed}=FALSE())';
  let offset = 0;
  const processed = [];
  for (;;) {
    const q = new URLSearchParams({
      filterByFormula: formula,
      pageSize: '50',
      offset: String(offset),
    });
    let json;
    try {
      json = await airtableFetch(`/${encodeURIComponent(TBL_CLIENTS)}?${q}`);
    } catch (e) {
      console.warn('[onboarding_lifecycle] list clients failed', e.message);
      break;
    }
    const recs = json.records || [];
    for (const rec of recs) {
      processed.push(rec.id);
      const f = rec.fields || {};
      const sent = new Set(parseOnboardingEmailsSent(f.onboarding_emails_sent));
      const signup = onboardingSignupTime(f);
      const now = Date.now();
      const email = String(f.contact_email || '').trim();
      const shop = String(f.shopify_domain || '').trim();
      const firstGen = f.first_video_generated_at;
      const firstPub = f.first_video_published_at;
      const shopConnected = !!shop;
      const hoursSince = signup ? (now - signup) / (1000 * 60 * 60) : 9999;

      if (!sent.has('shopify_connected') && shopConnected && !firstGen && hoursSince > 1 && email) {
        const cat = await getClientCatalog(f);
        const top = (cat.products || [])
          .slice()
          .sort((a, b) => (b.price || 0) - (a.price || 0))
          .slice(0, 3)
          .map((p) => p.name || p.title)
          .filter(Boolean);
        const lines = top.length ? top.map((n) => `<li>${String(n).replace(/</g, '')}</li>`).join('') : '<li>Your catalog</li>';
        const html = `<p>Your store is connected — here's what we found:</p><ul>${lines}</ul><p>SocialEngine turns these products into scroll-stopping short videos automatically.</p><p><a href="${PORTAL_BASE_URL}?tab=create">Generate your first video →</a></p>`;
        await sendTransactionalEmail({
          to: email,
          subject: 'Your store is connected — here\'s what we found',
          html,
          text: `Top products: ${top.join(', ')}. Open Create: ${PORTAL_BASE_URL}?tab=create`,
        });
        await appendOnboardingEmailSent(rec.id, 'shopify_connected');
        continue;
      }

      if (!sent.has('nudge_24h') && !firstGen && signup && now - signup > 24 * 60 * 60 * 1000 && email) {
        const html = `<p>You're minutes away from your first AI video.</p><p>Pick a product and we handle the rest — no templates to configure.</p><p><img src="${ONBOARDING_SAMPLE_IMAGE_URL}" alt="Sample" width="560" style="max-width:100%;border-radius:8px"/></p><p><a href="${PORTAL_BASE_URL}?tab=create">Generate now →</a></p>`;
        await sendTransactionalEmail({
          to: email,
          subject: 'Ready to make your first video?',
          html,
          text: `Generate now: ${PORTAL_BASE_URL}?tab=create`,
        });
        await appendOnboardingEmailSent(rec.id, 'nudge_24h');
        continue;
      }

      if (!sent.has('nudge_publish') && firstGen && !firstPub && email) {
        const genAt = new Date(firstGen).getTime();
        if (!Number.isNaN(genAt) && now - genAt > 48 * 60 * 60 * 1000) {
          const html = `<p>Your video is ready — approve and publish to Instagram in one tap.</p><p><a href="${PORTAL_BASE_URL}?tab=content">Publish to Instagram →</a></p>`;
          await sendTransactionalEmail({
            to: email,
            subject: 'Your video is waiting to be published',
            html,
            text: `Publish: ${PORTAL_BASE_URL}?tab=content`,
          });
          await appendOnboardingEmailSent(rec.id, 'nudge_publish');
          continue;
        }
      }

      if (!sent.has('reengagement_7d') && !firstGen && signup && now - signup > 7 * 24 * 60 * 60 * 1000 && email) {
        const cat = await getClientCatalog(f);
        const niche =
          (cat.products || [])
            .map((p) => p.product_type || p.type || '')
            .find((x) => String(x).trim()) || 'your category';
        const shopName = f.business_name || shop || 'your brand';
        const html = `<p>Here's what AI-powered brands are generating this week in <strong>${String(niche).replace(/</g, '')}</strong>.</p><p>Your catalog is ready — let SocialEngine ship your first reel.</p><p><a href="${PORTAL_BASE_URL}?tab=create">See what SocialEngine can do for ${String(shopName).replace(/</g, '')} →</a></p>`;
        await sendTransactionalEmail({
          to: email,
          subject: 'Here\'s what AI-powered brands are generating this week',
          html,
          text: `Open SocialEngine: ${PORTAL_BASE_URL}?tab=create`,
        });
        await appendOnboardingEmailSent(rec.id, 'reengagement_7d');
      }
    }
    if (!json.offset) break;
    offset = json.offset;
  }
  CRON_HEARTBEAT.onboarding_lifecycle.lastRun = Date.now();
  CRON_HEARTBEAT.onboarding_lifecycle.lastDurationMs = Date.now() - start;
  CRON_HEARTBEAT.onboarding_lifecycle.status = 'ok';
  CRON_HEARTBEAT.onboarding_lifecycle.postsGenerated = processed.length;
}

function startOnboardingLifecycleScheduler() {
  setInterval(() => {
    runOnboardingLifecycleCron().catch((e) => {
      CRON_HEARTBEAT.onboarding_lifecycle.status = 'error';
      console.warn('[onboarding_lifecycle]', e.message);
    });
  }, CRON_CADENCE_MS.onboarding_lifecycle);
}

async function getContentRecordFixed(postId) {
  const id = String(postId || '').trim();
  if (!id) return null;
  if (/^rec[a-z0-9]{14,}$/i.test(id)) {
    try {
      return await airtableFetch(`/${encodeURIComponent(TBL_CONTENT)}/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
  const esc = escapeFormulaString(id);
  const formula = `OR(RECORD_ID()='${esc}',{id}='${esc}')`;
  const q = new URLSearchParams({ filterByFormula: formula, maxRecords: '1' });
  const json = await airtableFetch(`/${encodeURIComponent(TBL_CONTENT)}?${q}`);
  const rec = json.records?.[0];
  return rec ? { id: rec.id, fields: rec.fields } : null;
}

function linkedClientRecordIds(contentFields) {
  const keys = ['client', 'Client', 'clients', 'Clients', 'client_ref', 'Client_ref'];
  const out = [];
  for (const k of keys) {
    const v = contentFields?.[k];
    if (!v) continue;
    if (Array.isArray(v)) {
      for (const x of v) if (x) out.push(String(x));
    } else if (typeof v === 'string' && v.trim()) {
      out.push(v.trim());
    }
  }
  return out;
}

function contentBelongsToClient(clientRecordId, contentFields) {
  const links = linkedClientRecordIds(contentFields || {});
  if (!links.length) return true;
  return links.includes(clientRecordId);
}

function contentVideoUrl(fields) {
  return (
    fields?.video_url ||
    fields?.Video_URL ||
    fields?.video_mp4_url ||
    fields?.mp4_url ||
    ''
  );
}

function contentCaption(fields, editedCaption) {
  if (editedCaption != null && String(editedCaption).trim()) return String(editedCaption).trim();
  return (
    fields?.caption ||
    fields?.Caption ||
    fields?.post_caption ||
    fields?.full_caption ||
    ''
  );
}

async function createPublishJob(fields) {
  return airtableFetch(`/${encodeURIComponent(TBL_JOBS)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}

async function patchPublishJob(recordId, fields) {
  return airtableFetch(`/${encodeURIComponent(TBL_JOBS)}/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}

async function patchContentRecord(recordId, fields) {
  return airtableFetch(`/${encodeURIComponent(TBL_CONTENT)}/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}

async function findLatestJobForContent(clientRecordId, contentRecordId) {
  const escClient = escapeFormulaString(clientRecordId);
  const escContent = escapeFormulaString(contentRecordId);
  const formula = `AND({client_id}='${escClient}',{content_id}='${escContent}')`;
  const q = new URLSearchParams({
    filterByFormula: formula,
    maxRecords: '1',
  });
  q.append('sort[0][field]', 'created_at');
  q.append('sort[0][direction]', 'desc');
  const json = await airtableFetch(`/${encodeURIComponent(TBL_JOBS)}?${q}`);
  return json.records?.[0] || null;
}

async function runPublishJob(
  {
    jobRecordId,
    jobId,
    clientRecordId,
    contentRecordId,
    videoUrl,
    caption,
    uploadUser,
    platform,
  },
  logErr = logAdminError,
) {
  const delays = [1000, 2000, 4000];
  let lastResponse = null;
  let lastErr = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    await patchPublishJob(jobRecordId, {
      status: 'publishing',
      attempt_number: attempt,
    });
    try {
      const result = await publishPostViaUploadPost({
        videoUrl,
        caption,
        user: uploadUser,
        platform,
      });
      lastResponse = result.body;
      if (result.ok) {
        await patchPublishJob(jobRecordId, {
          status: 'published',
          upload_post_response: JSON.stringify(result.body).slice(0, 95000),
          post_id: result.postId || '',
          published_at: new Date().toISOString(),
          error: '',
        });
        await patchContentRecord(contentRecordId, { status: 'Published' });
        await recordFirstVideoPublishedIfNeeded(clientRecordId);
        return { ok: true, postId: result.postId };
      }
      const is5xx = result.status >= 500 && result.status < 600;
      if (is5xx && attempt < 3) {
        await patchPublishJob(jobRecordId, {
          upload_post_response: JSON.stringify(result.body).slice(0, 95000),
          error: `HTTP ${result.status} attempt ${attempt}`,
        });
        await sleep(delays[attempt - 1]);
        continue;
      }
      lastErr = new Error(`Upload-Post HTTP ${result.status}`);
      lastErr.body = result.body;
      break;
    } catch (e) {
      lastErr = e;
      break;
    }
  }

  const errText = lastErr ? lastErr.message : 'Upload-Post failed';
  await patchPublishJob(jobRecordId, {
    status: 'failed',
    error: errText.slice(0, 8000),
    upload_post_response: lastResponse
      ? JSON.stringify(lastResponse).slice(0, 95000)
      : '',
  });
  await logErr({
    message: `Publish job failed: ${jobId}`,
    details: { contentRecordId, clientRecordId, error: errText, response: lastResponse },
    source: 'publish_upload_post',
  });
  return { ok: false };
}

/**
 * After approve is persisted: optionally enqueue Upload-Post publish.
 * @param {{ clientRecord: { id: string, fields: object }, contentRecord: { id: string, fields: object }, editedCaption?: string }} params
 * @returns {Promise<{ publishStarted: boolean, publish?: { job_id: string, content_id: string, platform: string } }>}
 */
async function soc10KickoffPublishAfterApprove({ clientRecord, contentRecord, editedCaption } = {}) {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
    return { publishStarted: false };
  }
  const clientFields = clientRecord?.fields || {};
  const clientRecordId = clientRecord?.id;
  const contentFields = contentRecord?.fields || {};
  const contentRecordId = contentRecord?.id;
  if (!clientRecordId || !contentRecordId) return { publishStarted: false };

  const uploadUsername = String(clientFields.upload_post_username || '').trim();
  const snapshot = resolveUploadPostSnapshot(clientFields);
  const platform = pickPrimaryPublishPlatform(clientFields, snapshot);
  const videoUrl = String(contentVideoUrl(contentFields)).trim();
  const caption = contentCaption(
    { ...contentFields, ...(editedCaption != null ? { caption: editedCaption } : {}) },
    editedCaption,
  );

  const canPublish =
    uploadUsername &&
    videoUrl.startsWith('https://') &&
    ['instagram', 'tiktok', 'facebook'].includes(platform);

  if (!canPublish) {
    return { publishStarted: false };
  }

  const jobId = randomUUID();
  const now = new Date().toISOString();
  const jobCreate = await createPublishJob({
    job_id: jobId,
    client_id: clientRecordId,
    content_id: contentRecordId,
    platform,
    status: 'queued',
    attempt_number: 0,
    created_at: now,
    upload_post_response: '',
    post_id: '',
    published_at: '',
    error: '',
  });
  const jobRecordId = jobCreate.id;
  const logErr = _injectedLogAdminError || createDefaultLogAdminError();

  runPublishJob(
    {
      jobRecordId,
      jobId,
      clientRecordId,
      contentRecordId,
      videoUrl,
      caption,
      uploadUser: uploadUsername,
      platform,
    },
    logErr,
  ).catch((e) => console.error('[publish async]', e));

  return {
    publishStarted: true,
    publish: {
      job_id: jobId,
      content_id: contentRecordId,
      platform,
    },
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 2e6) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Default verifyClient: x-client-email + x-client-hash → `req.soc10Client` */
function verifyClient() {
  return async function verifyClientMiddleware(req, res, next) {
    try {
      if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
        return res.status(503).json({ error: 'Airtable is not configured' });
      }
      const email = String(req.headers['x-client-email'] || '').trim();
      const hash = String(req.headers['x-client-hash'] || '').trim();
      if (!email || !hash) {
        return res.status(401).json({ error: 'Missing x-client-email or x-client-hash' });
      }
      const clientRec = await findClientByAuth(email, hash);
      if (!clientRec) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      req.soc10Client = clientRec;
      next();
    } catch (e) {
      next(e);
    }
  };
}

function jobRowToJson(job) {
  if (!job) return null;
  const f = job.fields || {};
  return {
    id: job.id,
    ...f,
    upload_post_response: f.upload_post_response ?? null,
  };
}

/**
 * @param {object} app — Express app (`app.get(...)`)
 * @param {{ verifyClient?: function, logAdminError?: function }} [options]
 */
function mountSoc10PublishRoutes(app, options = {}) {
  const vc = options.verifyClient || verifyClient();
  const logErr = options.logAdminError || null;
  if (logErr) _injectedLogAdminError = logErr;

  mountBrandDnaRoutes(app, options);
  mountOnboardingRoutes(app, options);

  app.get('/api/publish/jobs/:contentId', vc, async (req, res, next) => {
    try {
      const contentId = String(req.params.contentId || '').trim();
      const clientRec = req.soc10Client;
      const resolved = await getContentRecordFixed(contentId);
      if (!resolved) return res.status(404).json({ error: 'Content not found' });
      if (!contentBelongsToClient(clientRec.id, resolved.fields || {})) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const job = await findLatestJobForContent(clientRec.id, resolved.id);
      return res.json({ job: jobRowToJson(job) });
    } catch (e) {
      next(e);
    }
  });
}

/** Standalone approve (reference) — production should use `soc10KickoffPublishAfterApprove` inside your route. */
async function handleApprovePost(req, res) {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
    return json(res, 503, { error: 'Airtable is not configured' });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const postId = body.postId;
  const clientEmail = String(body.clientEmail || '').trim();
  const clientHash = String(body.clientHash || '').trim();
  const editedCaption = body.editedCaption;

  if (!postId || !clientEmail || !clientHash) {
    return json(res, 400, { error: 'postId, clientEmail, and clientHash are required' });
  }

  const clientRec = await findClientByAuth(clientEmail, clientHash);
  if (!clientRec) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  const contentRec = await getContentRecordFixed(postId);
  if (!contentRec) {
    return json(res, 404, { error: 'Content not found' });
  }
  if (!contentBelongsToClient(clientRec.id, contentRec.fields || {})) {
    return json(res, 403, { error: 'Forbidden' });
  }

  const contentFields = contentRec.fields || {};
  const approvedStatus = contentFields.status === 'Scheduled' ? 'Scheduled' : 'Approved';
  await patchContentRecord(contentRec.id, {
    status: approvedStatus,
    ...(editedCaption != null && String(editedCaption).trim()
      ? { caption: String(editedCaption).trim() }
      : {}),
  });

  const kick = await soc10KickoffPublishAfterApprove({
    clientRecord: clientRec,
    contentRecord: contentRec,
    editedCaption,
  });

  return json(res, 200, {
    success: true,
    status: approvedStatus,
    ...kick,
  });
}

async function handleGetPublishJobHttp(req, res, contentId) {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
    return json(res, 503, { error: 'Airtable is not configured' });
  }
  const email = String(req.headers['x-client-email'] || '').trim();
  const hash = String(req.headers['x-client-hash'] || '').trim();
  if (!email || !hash) {
    return json(res, 401, { error: 'Missing x-client-email or x-client-hash' });
  }
  const clientRec = await findClientByAuth(email, hash);
  if (!clientRec) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  const resolved = await getContentRecordFixed(contentId);
  if (!resolved) return json(res, 404, { error: 'Content not found' });
  if (!contentBelongsToClient(clientRec.id, resolved.fields || {})) {
    return json(res, 403, { error: 'Forbidden' });
  }
  const job = await findLatestJobForContent(clientRec.id, resolved.id);
  return json(res, 200, { job: jobRowToJson(job) });
}

async function authClientFromHeaders(req) {
  const email = String(req.headers['x-client-email'] || '').trim();
  const hash = String(req.headers['x-client-hash'] || '').trim();
  if (!email || !hash) return null;
  return findClientByAuth(email, hash);
}

async function handleBrandDnaRunHttp(req, res) {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
    return json(res, 503, { error: 'Airtable is not configured' });
  }
  const clientRec = await authClientFromHeaders(req);
  if (!clientRec) return json(res, 401, { error: 'Unauthorized' });
  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  try {
    const out = await runBrandDnaIngestion(clientRec.id, {
      competitorUrls: body.competitorUrls,
      triggeredBy: body.triggeredBy || 'manual_refresh',
    });
    return json(res, 200, out);
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || 'ingestion_failed' });
  }
}

async function handleBrandDnaLatestHttp(req, res) {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
    return json(res, 503, { error: 'Airtable is not configured' });
  }
  const clientRec = await authClientFromHeaders(req);
  if (!clientRec) return json(res, 401, { error: 'Unauthorized' });
  const rec = await getLatestBrandDnaRecord(clientRec.id);
  if (!rec) return json(res, 200, { exists: false });
  return json(res, 200, { exists: true, dna: brandDnaRecordToClientObject(rec) });
}

async function handleBrandDnaVersionsHttp(req, res) {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
    return json(res, 503, { error: 'Airtable is not configured' });
  }
  const clientRec = await authClientFromHeaders(req);
  if (!clientRec) return json(res, 401, { error: 'Unauthorized' });
  const recs = await listBrandDnaVersionsForClient(clientRec.id);
  const list = recs.map((r) => ({
    version: r.fields?.version,
    created_at: r.fields?.created_at,
    triggered_by: r.fields?.triggered_by,
    id: r.id,
  }));
  return json(res, 200, { versions: list });
}

const DEMO_VIDEO_URL =
  'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4';

async function handleStudioProductsHttp(req, res) {
  const clientRec = await authClientFromHeaders(req);
  if (!clientRec) return json(res, 401, { error: 'Unauthorized' });
  const cat = await getClientCatalog(clientRec.fields || {});
  let products = (cat.products || []).slice();
  products.sort((a, b) => {
    const la = String(a.imageUrls?.[0] || '').length;
    const lb = String(b.imageUrls?.[0] || '').length;
    return lb - la;
  });
  const mapped = products.slice(0, 50).map((p) => ({
    id: p.id,
    title: p.name || p.title,
    price: p.price,
    primary_image: (p.imageUrls && p.imageUrls[0]) || '',
    product_url: p.product_url || '',
    handle: p.handle || '',
    product_type: p.product_type || '',
  }));
  return json(res, 200, { products: mapped, catalog_source: cat.source || 'stub' });
}

async function handleStudioGenerateV2Http(req, res) {
  const clientRec = await authClientFromHeaders(req);
  if (!clientRec) return json(res, 401, { error: 'Unauthorized' });
  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  const jobId = randomUUID();
  const started = Date.now();
  __studioJobs.set(jobId, {
    status: 'queued',
    attempt_number: 0,
    max_attempts: 2,
    clientRecordId: clientRec.id,
    productTitle: body.productTitle || '',
    template: body.template || 'stop_scroll_hook',
  });
  setTimeout(() => {
    const j = __studioJobs.get(jobId);
    if (j) j.status = 'qa_running';
  }, 800);
  setTimeout(async () => {
    const j = __studioJobs.get(jobId);
    if (!j) return;
    j.status = 'qa_passed';
    j.output_video_url = DEMO_VIDEO_URL;
    j.elapsed_ms = Date.now() - started;
    try {
      await logGeneration(j.clientRecordId);
    } catch (_) {}
  }, 4200);
  return json(res, 200, { ok: true, jobId });
}

async function handleStudioJobHttp(req, res, jobId) {
  const clientRec = await authClientFromHeaders(req);
  if (!clientRec) return json(res, 401, { error: 'Unauthorized' });
  const job = __studioJobs.get(jobId);
  if (!job || job.clientRecordId !== clientRec.id) {
    return json(res, 404, { error: 'Job not found' });
  }
  return json(res, 200, { job });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'POST' && pathname === '/api/approve-post') {
        return await handleApprovePost(req, res);
      }
      if (req.method === 'GET' && pathname.startsWith('/api/publish/jobs/')) {
        const parts = pathname.split('/').filter(Boolean);
        const id = parts[parts.length - 1];
        return await handleGetPublishJobHttp(req, res, id);
      }
      if (req.method === 'POST' && pathname === '/api/brand-dna/run') {
        return await handleBrandDnaRunHttp(req, res);
      }
      if (req.method === 'GET' && pathname === '/api/brand-dna/latest') {
        return await handleBrandDnaLatestHttp(req, res);
      }
      if (req.method === 'GET' && pathname === '/api/brand-dna/versions') {
        return await handleBrandDnaVersionsHttp(req, res);
      }
      if (req.method === 'GET' && pathname === '/admin/api/health') {
        return await handleAdminHealthHttp(req, res);
      }
      if (req.method === 'POST' && pathname === '/api/webhooks/stripe') {
        return await handleStripeWebhookHttp(req, res);
      }
      if (req.method === 'GET' && pathname === '/api/studio/products') {
        return await handleStudioProductsHttp(req, res);
      }
      if (req.method === 'POST' && pathname === '/api/studio/generate-video-v2') {
        return await handleStudioGenerateV2Http(req, res);
      }
      if (req.method === 'GET' && pathname.startsWith('/api/studio/job/')) {
        const jid = pathname.split('/').filter(Boolean).pop();
        return await handleStudioJobHttp(req, res, jid);
      }
      if (req.method === 'POST' && pathname === '/api/onboarding/step') {
        const clientRec = await authClientFromHeaders(req);
        if (!clientRec) return json(res, 401, { error: 'Unauthorized' });
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const step = Number(body.step);
        if (!Number.isFinite(step) || step < 0 || step > 5) {
          return json(res, 400, { error: 'step must be 0–5' });
        }
        const patch = { onboarding_step: step };
        if (step >= 5) patch.onboarding_completed = true;
        await patchClientRecord(clientRec.id, patch);
        return json(res, 200, { ok: true, step });
      }
      if (req.method === 'GET' && pathname === '/api/onboarding/state') {
        const clientRec = await authClientFromHeaders(req);
        if (!clientRec) return json(res, 401, { error: 'Unauthorized' });
        const fresh = await airtableFetch(
          `/${encodeURIComponent(TBL_CLIENTS)}/${encodeURIComponent(clientRec.id)}`,
        );
        const payload = await getOnboardingStatePayload(fresh);
        return json(res, 200, payload);
      }
      if (req.method === 'GET' && pathname === '/health') {
        return json(res, 200, { ok: true });
      }
      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      console.error(e);
      json(res, 500, { error: e.message || 'Server error' });
    }
  });
}

/**
 * Ensure PUBLISH_JOBS exists (Meta API). Requires schema.bases:write on the token.
 * Idempotent: if the table name is already taken, logs and returns false.
 */
async function ensurePublishJobsTableExists() {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
    console.error('[soc10-schema] Missing AIRTABLE_BASE_ID and AIRTABLE_PAT');
    return false;
  }
  const listUrl = `${AIRTABLE_META}/${encodeURIComponent(AIRTABLE_BASE)}/tables`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
  const listJson = await listRes.json().catch(() => ({}));
  if (!listRes.ok) {
    console.error('[soc10-schema] list tables failed', listRes.status, listJson);
    return false;
  }
  const wantName = TBL_JOBS;
  if ((listJson.tables || []).some((t) => t.name === wantName)) {
    console.log(`[soc10-schema] Table "${wantName}" already exists.`);
    return true;
  }

  const body = {
    name: wantName,
    description: 'Tracks Upload-Post publish attempts after merchant approval (SOC-10).',
    fields: [
      { name: 'job_id', type: 'singleLineText' },
      { name: 'client_id', type: 'singleLineText' },
      { name: 'content_id', type: 'singleLineText' },
      {
        name: 'platform',
        type: 'singleSelect',
        options: {
          choices: [
            { name: 'instagram', color: 'purpleBright' },
            { name: 'tiktok', color: 'cyanBright' },
            { name: 'facebook', color: 'blueBright' },
          ],
        },
      },
      {
        name: 'status',
        type: 'singleSelect',
        options: {
          choices: [
            { name: 'queued', color: 'grayBright' },
            { name: 'publishing', color: 'yellowBright' },
            { name: 'published', color: 'greenBright' },
            { name: 'failed', color: 'redBright' },
          ],
        },
      },
      { name: 'upload_post_response', type: 'multilineText' },
      { name: 'post_id', type: 'singleLineText' },
      { name: 'attempt_number', type: 'number', options: { precision: 0 } },
      {
        name: 'created_at',
        type: 'dateTime',
        options: { timeZone: 'utc', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } },
      },
      {
        name: 'published_at',
        type: 'dateTime',
        options: { timeZone: 'utc', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } },
      },
      { name: 'error', type: 'multilineText' },
    ],
  };

  const createRes = await fetch(listUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const createJson = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    console.error('[soc10-schema] create table failed', createRes.status, createJson);
    return false;
  }
  console.log('[soc10-schema] Created table', createJson.name || wantName, 'id:', createJson.id);
  return true;
}

module.exports = {
  createServer,
  mountSoc10PublishRoutes,
  mountBrandDnaRoutes,
  mountOnboardingRoutes,
  logGeneration,
  CRON_CADENCE_MS,
  CRON_HEARTBEAT,
  runOnboardingLifecycleCron,
  runGate2AnatomyCheck,
  runQAGatePipeline,
  resolveGate2Mode,
  getGate2HealthPayload,
  verifyClient,
  soc10KickoffPublishAfterApprove,
  resolveUploadPostSnapshot,
  publishPostViaUploadPost,
  runPublishJob,
  findClientByAuth,
  getContentRecordFixed,
  contentBelongsToClient,
  findLatestJobForContent,
  ensurePublishJobsTableExists,
  /** Call from API startup if you want auto-create without shell script */
  maybeEnsurePublishJobsTable: async () => {
    if (process.env.SOC10_ENSURE_PUBLISH_JOBS_TABLE === '1') {
      await ensurePublishJobsTableExists();
    }
  },
  applyConfidenceGate,
  getModeBUnlockCondition,
  runBrandDnaIngestion,
  getBrandDnaForClient,
  buildStopScrollHookPrompt,
  ensureBrandDnaTableExists,
  maybeEnsureBrandDnaTable: async () => {
    if (process.env.SOC7_ENSURE_BRAND_DNA_TABLE === '1') {
      await ensureBrandDnaTableExists();
    }
  },
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'ensure-table') {
    ensurePublishJobsTableExists()
      .then((ok) => process.exit(ok ? 0 : 1))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else if (argv[0] === 'ensure-soc7-table') {
    ensureBrandDnaTableExists()
      .then((ok) => process.exit(ok ? 0 : 1))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else {
    const port = Number(process.env.PORT || 8787);
    createServer().listen(port, () => {
      console.log(`SOC-10 server listening on :${port}`);
      startOnboardingLifecycleScheduler();
      setImmediate(() => {
        runOnboardingLifecycleCron().catch(() => {});
        resolveGate2Mode()
          .then(() => maybeSmokeTestGate2())
          .catch(() => {});
      });
    });
  }
}
