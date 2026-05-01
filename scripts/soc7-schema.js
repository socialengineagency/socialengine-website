#!/usr/bin/env node
/**
 * SOC-7 / BIS v1.1 — Create BRAND_DNA_VERSIONS via Airtable Meta API.
 *
 * Env: AIRTABLE_BASE_ID | AIRTABLE_BASE, AIRTABLE_PAT | AIRTABLE_SECRET_API_TOKEN
 * Optional: AIRTABLE_BRAND_DNA_TABLE (default BRAND_DNA_VERSIONS)
 *
 * Usage: node scripts/soc7-schema.js
 */

const BASE_ID = process.env.AIRTABLE_BASE_ID || process.env.AIRTABLE_BASE;
const TOKEN =
  process.env.AIRTABLE_PAT ||
  process.env.AIRTABLE_SECRET_API_TOKEN ||
  process.env.AIRTABLE_API_KEY;

const DEFAULT_TABLE = 'BRAND_DNA_VERSIONS';
const TABLE_NAME = process.env.AIRTABLE_BRAND_DNA_TABLE || DEFAULT_TABLE;
const META = 'https://api.airtable.com/v0/meta/bases';

function getBrandDnaVersionsTableDefinition(tableName = TABLE_NAME) {
  const LT = 'multilineText';
  return {
    name: tableName || DEFAULT_TABLE,
    description:
      'Brand Intelligence System v1.1 — full 10-dimension Brand Vector (BIS). Phase 2 dimensions may be Mode B.',
    fields: [
      { name: 'client_id', type: 'singleLineText' },
      { name: 'version', type: 'number', options: { precision: 0 } },
      { name: 'triggered_by', type: 'singleLineText' },
      {
        name: 'created_at',
        type: 'dateTime',
        options: { timeZone: 'utc', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } },
      },
      { name: 'dim1_voice', type: LT },
      { name: 'dim2_aesthetic', type: LT },
      { name: 'dim3_buyer_motivation', type: LT },
      { name: 'dim4_cultural_position', type: LT },
      { name: 'dim5_customer_relationship', type: LT },
      { name: 'dim6_stakes_model', type: LT },
      { name: 'dim7_product_relationship', type: LT },
      { name: 'dim8_tribal_markers', type: LT },
      { name: 'dim9_trust_architecture', type: LT },
      { name: 'dim10_evolution_vector', type: LT },
      { name: 'hero_product', type: LT },
      {
        name: 'price_positioning',
        type: 'singleSelect',
        options: {
          choices: [
            { name: 'budget', color: 'greenBright' },
            { name: 'mid', color: 'yellowBright' },
            { name: 'premium', color: 'purpleBright' },
          ],
        },
      },
      { name: 'brand_vocabulary', type: LT },
      { name: 'banned_phrases', type: LT },
      { name: 'competitor_gaps', type: LT },
      { name: 'confidence_summary', type: LT },
      { name: 'mode_b_unlocks', type: LT },
      { name: 'sources_used', type: LT },
      { name: 'event_bus_log', type: LT },
    ],
  };
}

async function main() {
  if (!BASE_ID || !TOKEN) {
    console.error(
      'Missing AIRTABLE_BASE_ID (or AIRTABLE_BASE) and AIRTABLE_PAT (or AIRTABLE_SECRET_API_TOKEN).',
    );
    process.exit(1);
  }

  const listUrl = `${META}/${encodeURIComponent(BASE_ID)}/tables`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const listJson = await listRes.json().catch(() => ({}));
  if (!listRes.ok) {
    console.error('List tables failed', listRes.status, listJson);
    process.exit(1);
  }
  if ((listJson.tables || []).some((t) => t.name === TABLE_NAME)) {
    console.log(`Table "${TABLE_NAME}" already exists.`);
    process.exit(0);
  }

  const body = getBrandDnaVersionsTableDefinition(TABLE_NAME);
  const createRes = await fetch(listUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const createJson = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    console.error('Create table failed', createRes.status, createJson);
    process.exit(1);
  }
  console.log('Created', createJson.name || TABLE_NAME, 'id:', createJson.id);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  TABLE_NAME,
  getBrandDnaVersionsTableDefinition,
};
