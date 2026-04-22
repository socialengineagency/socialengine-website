# SocialEngine Website

Static marketing site and client portal for SocialEngine.

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

## Required environment variables

Configure these env vars in the backend environment before implementing the live OAuth exchanges:

- `META_APP_ID`
- `META_APP_SECRET`
- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`

You will also need platform-specific redirect URIs that point back to your deployed backend callback handlers for the native OAuth flow.
