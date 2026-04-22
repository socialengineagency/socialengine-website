# SocialEngine website

Static marketing site and deployed portal entrypoint for SocialEngine.

## Golden-path portal E2E

The repo includes a Playwright suite at `tests/e2e/golden-path.spec.js` that exercises the deployed client portal at `https://www.socialengine.agency/portal.html`.

### What it covers

- Signs in with real portal credentials from environment variables only
- Walks the full paying-customer portal journey
- Verifies each requested portal area:
  - Home
  - Engage
  - Create
  - Ads
  - Coach
  - Plan
  - Calendar
  - Content
  - Inbox
  - Grow
  - Settings
- For each area, asserts:
  - the page loads without JavaScript/runtime errors
  - backend-backed content renders
  - primary CTAs are visible, enabled, and trial-clickable

### Credential requirements

Do **not** hardcode or commit credentials. Export them in your shell before running the suite:

```bash
export PORTAL_EMAIL="your-test-email@example.com"
export PORTAL_PASSWORD="your-test-password"
```

### Install dependencies

```bash
npm install
npx playwright install chromium
```

### Run the golden-path suite

```bash
npm run test:e2e:golden-path
```

### Useful variants

Run all Playwright tests:

```bash
npm run test:e2e
```

Run headed for local debugging:

```bash
npm run test:e2e:headed -- tests/e2e/golden-path.spec.js
```

### Notes on requested tab mapping

The deployed portal's implemented navigation does not expose separate sidebar items for every requested label, so the suite documents and tests these mappings against the real UI:

- `Plan` -> the plan and subscription management section inside `Settings`
- `Calendar` -> the content calendar/state within `Content`
- `Inbox` -> the inbox/filter surface within `Engage`

## Native OAuth follow-up for analytics

The portal now treats social connection as a two-step flow:

1. **Upload-Post OAuth** connects publishing.
2. **Native OAuth** connects platform analytics tokens used by the Grow tab.

The backend endpoint stub for the second step lives at `api/native-oauth.js` and is intended to back:

- `GET /api/social/native-oauth/instagram`
- `GET /api/social/native-oauth/tiktok`
- `GET /api/social/native-oauth/facebook`

That endpoint should:

- authenticate the client via `email` + `hash`
- start the platform-native OAuth flow
- exchange the returned code for tokens
- write the resulting values into Airtable

Expected Airtable fields:

- Instagram: `instagram_user_id`
- TikTok: `tiktok_access_token`
- Facebook / Meta: `meta_page_id`, `meta_page_token`

If native OAuth fails, the portal keeps the publishing connection but warns the client that Grow analytics will be limited until the native step is completed.

### Required environment variables

Configure these env vars in the backend environment before implementing the live OAuth exchanges:

- `META_APP_ID`
- `META_APP_SECRET`
- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`

You will also need platform-specific redirect URIs that point back to your deployed backend callback handlers for the native OAuth flow.
