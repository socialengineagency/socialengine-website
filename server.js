const express = require('express');
const cors = require('cors');
const Airtable = require('airtable');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || '';
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Clients';

let base;
if (AIRTABLE_API_KEY && AIRTABLE_BASE_ID) {
  base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
}

// In-memory set of processed idempotency tokens (production should use Redis/DB)
const processedTokens = new Map();
const TOKEN_TTL_MS = 15 * 60 * 1000;

function pruneExpiredTokens() {
  const now = Date.now();
  for (const [token, entry] of processedTokens) {
    if (now - entry.timestamp > TOKEN_TTL_MS) {
      processedTokens.delete(token);
    }
  }
}
setInterval(pruneExpiredTokens, 60 * 1000);

async function findExistingByEmail(email) {
  if (!base) return null;
  const normalizedEmail = email.trim().toLowerCase();
  const records = await base(AIRTABLE_TABLE_NAME)
    .select({
      filterByFormula: `LOWER({Email}) = "${normalizedEmail}"`,
      maxRecords: 1,
    })
    .firstPage();
  if (records && records.length > 0) {
    return {
      id: records[0].id,
      client_id: records[0].get('client_id') || records[0].id,
      email: records[0].get('Email'),
      name: records[0].get('Name'),
      website: records[0].get('Website'),
    };
  }
  return null;
}

async function createAirtableRecord(fields) {
  if (!base) {
    return { client_id: 'local_' + Date.now(), ...fields };
  }
  const record = await base(AIRTABLE_TABLE_NAME).create([
    {
      fields: {
        Email: fields.email,
        Name: fields.name || '',
        Website: fields.website || '',
        'Instagram Handle': fields.instagram_handle || '',
        'TikTok Handle': fields.tiktok_handle || '',
        'Facebook Handle': fields.facebook_handle || '',
        'Onboarding Date': new Date().toISOString(),
      },
    },
  ]);
  const created = record[0];
  return {
    id: created.id,
    client_id: created.get('client_id') || created.id,
    email: created.get('Email'),
  };
}

app.post('/api/onboard', async (req, res) => {
  try {
    const { email, name, website, instagram_handle, tiktok_handle, facebook_handle, idempotency_token } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Valid email is required.' });
    }

    // Check idempotency token — return cached response if already processed
    if (idempotency_token && processedTokens.has(idempotency_token)) {
      const cached = processedTokens.get(idempotency_token);
      return res.json(cached.response);
    }

    // Check Airtable for existing email before creating
    const existing = await findExistingByEmail(email);
    if (existing) {
      const response = {
        success: true,
        client_id: existing.client_id,
        existing: true,
        message: 'Account already exists.',
      };
      if (idempotency_token) {
        processedTokens.set(idempotency_token, { response, timestamp: Date.now() });
      }
      return res.json(response);
    }

    // Create new record
    const created = await createAirtableRecord({
      email: email.trim().toLowerCase(),
      name,
      website,
      instagram_handle,
      tiktok_handle,
      facebook_handle,
    });

    const response = {
      success: true,
      client_id: created.client_id,
      existing: false,
      message: 'Onboarding complete.',
    };

    if (idempotency_token) {
      processedTokens.set(idempotency_token, { response, timestamp: Date.now() });
    }

    return res.json(response);
  } catch (err) {
    console.error('Onboard error:', err);
    return res.status(500).json({
      success: false,
      error: 'Onboarding failed. Please try again.',
      retryable: true,
    });
  }
});

app.use(express.static('.', { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`SocialEngine server listening on port ${PORT}`);
});
