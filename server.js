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
 */

const http = require('http');
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

const ERR_FIELD_MESSAGE = process.env.SOC10_ERROR_LOG_FIELD_MESSAGE || 'message';
const ERR_FIELD_DETAILS = process.env.SOC10_ERROR_LOG_FIELD_DETAILS || 'details';
const ERR_FIELD_SOURCE = process.env.SOC10_ERROR_LOG_FIELD_SOURCE || 'source';
const ERR_FIELD_CREATED = process.env.SOC10_ERROR_LOG_FIELD_CREATED_AT || 'created_at';

const AIRTABLE_API = 'https://api.airtable.com/v0';
const AIRTABLE_META = 'https://api.airtable.com/v0/meta/bases';

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

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'POST' && path === '/api/approve-post') {
        return await handleApprovePost(req, res);
      }
      if (req.method === 'GET' && path.startsWith('/api/publish/jobs/')) {
        const parts = path.split('/').filter(Boolean);
        const id = parts[parts.length - 1];
        return await handleGetPublishJobHttp(req, res, id);
      }
      if (req.method === 'GET' && path === '/health') {
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
  } else {
    const port = Number(process.env.PORT || 8787);
    createServer().listen(port, () => {
      console.log(`SOC-10 server listening on :${port}`);
    });
  }
}
