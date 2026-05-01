#!/usr/bin/env node
/**
 * Add onboarding fields to the existing CLIENTS table (Airtable Meta API).
 *
 * Env: AIRTABLE_BASE_ID | AIRTABLE_BASE, AIRTABLE_PAT | AIRTABLE_SECRET_API_TOKEN
 * Optional: AIRTABLE_CLIENTS_TABLE (default CLIENTS)
 *
 * Usage: node scripts/onboarding-schema.js
 *
 * https://airtable.com/developers/web/api/update-table
 */

const BASE_ID = process.env.AIRTABLE_BASE_ID || process.env.AIRTABLE_BASE;
const TOKEN =
  process.env.AIRTABLE_PAT ||
  process.env.AIRTABLE_SECRET_API_TOKEN ||
  process.env.AIRTABLE_API_KEY;
const CLIENTS_NAME = process.env.AIRTABLE_CLIENTS_TABLE || 'CLIENTS';
const META = 'https://api.airtable.com/v0/meta/bases';

const NEW_FIELDS = [
  { name: 'onboarding_step', type: 'number', options: { precision: 0 } },
  { name: 'onboarding_completed', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
  {
    name: 'first_video_generated_at',
    type: 'dateTime',
    options: { timeZone: 'utc', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } },
  },
  {
    name: 'first_video_published_at',
    type: 'dateTime',
    options: { timeZone: 'utc', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } },
  },
  { name: 'onboarding_emails_sent', type: 'multilineText' },
];

async function main() {
  if (!BASE_ID || !TOKEN) {
    console.error('Missing AIRTABLE_BASE_ID and AIRTABLE_PAT.');
    process.exit(1);
  }
  const listUrl = `${META}/${encodeURIComponent(BASE_ID)}/tables`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const listJson = await listRes.json().catch(() => ({}));
  if (!listRes.ok) {
    console.error('List tables failed', listRes.status, listJson);
    process.exit(1);
  }
  const table = (listJson.tables || []).find((t) => t.name === CLIENTS_NAME);
  if (!table || !table.id) {
    console.error('Table not found:', CLIENTS_NAME);
    process.exit(1);
  }
  const existing = new Set((table.fields || []).map((f) => f.name));
  const toAdd = NEW_FIELDS.filter((f) => !existing.has(f.name));
  if (!toAdd.length) {
    console.log('All onboarding fields already exist on', CLIENTS_NAME);
    process.exit(0);
  }
  const patchUrl = `${META}/${encodeURIComponent(BASE_ID)}/tables/${encodeURIComponent(table.id)}`;
  const patchRes = await fetch(patchUrl, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: toAdd }),
  });
  const patchJson = await patchRes.json().catch(() => ({}));
  if (!patchRes.ok) {
    console.error('Patch table failed', patchRes.status, patchJson);
    process.exit(1);
  }
  console.log('Added fields:', toAdd.map((f) => f.name).join(', '));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { NEW_FIELDS, CLIENTS_NAME };
