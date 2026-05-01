#!/usr/bin/env node
/**
 * SOC-10: Create the PUBLISH_JOBS Airtable table via the Meta API.
 *
 * Prerequisites:
 *   - AIRTABLE_PAT or AIRTABLE_SECRET_API_TOKEN — personal access token with
 *     schema.bases:write (and data.records:read on the base).
 *   - AIRTABLE_BASE_ID — target base id.
 *
 * Usage:
 *   node scripts/soc10-schema.js
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE_ID=app... node scripts/soc10-schema.js
 *
 * Docs: https://airtable.com/developers/web/api/create-table
 */

const BASE_ID = process.env.AIRTABLE_BASE_ID || process.env.AIRTABLE_BASE;
const TOKEN =
  process.env.AIRTABLE_PAT ||
  process.env.AIRTABLE_SECRET_API_TOKEN ||
  process.env.AIRTABLE_API_KEY;

const META = 'https://api.airtable.com/v0/meta/bases';

async function main() {
  if (!BASE_ID || !TOKEN) {
    console.error(
      'Missing AIRTABLE_BASE_ID (or AIRTABLE_BASE) and AIRTABLE_PAT (or AIRTABLE_SECRET_API_TOKEN).',
    );
    process.exit(1);
  }

  const body = {
    name: process.env.AIRTABLE_PUBLISH_JOBS_TABLE || 'PUBLISH_JOBS',
    description:
      'Tracks Upload-Post publish attempts after merchant approval (SOC-10).',
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
      { name: 'created_at', type: 'dateTime', options: { timeZone: 'utc', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } } },
      { name: 'published_at', type: 'dateTime', options: { timeZone: 'utc', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } } },
      { name: 'error', type: 'multilineText' },
    ],
  };

  const url = `${META}/${encodeURIComponent(BASE_ID)}/tables`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    console.error('Airtable Meta API error', res.status, json);
    process.exit(1);
  }

  console.log('Created table:', json.name || body.name, 'id:', json.id);
  console.log(JSON.stringify(json, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
