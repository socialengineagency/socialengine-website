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

