/**
 * Native analytics OAuth endpoint stub.
 *
 * Expected route shape:
 *   GET /api/social/native-oauth/:platform
 *
 * Query params:
 *   - email: client email used by the portal
 *   - hash:  client auth hash used by the portal
 *
 * Intended responsibilities:
 *   1. Validate the authenticated client from email/hash.
 *   2. Redirect to the platform-native OAuth flow:
 *      - instagram -> Instagram Basic Display / Meta login
 *      - facebook  -> Meta Graph page OAuth
 *      - tiktok    -> TikTok Business OAuth
 *   3. Exchange the callback code for access tokens.
 *   4. Persist the returned identifiers/tokens to Airtable:
 *      - instagram_user_id
 *      - tiktok_access_token
 *      - meta_page_id
 *      - meta_page_token
 *   5. Redirect back to portal.html with a success/failure signal that the
 *      popup can postMessage back to the opener.
 */

const REQUIRED_ENVS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
];

function getMissingEnvVars(env = process.env) {
  return REQUIRED_ENVS.filter((key) => !env[key]);
}

function nativeOAuthStub(req, res) {
  const platform = String(req?.params?.platform || '').trim().toLowerCase();
  const missing = getMissingEnvVars();

  res.status(501).json({
    success: false,
    platform,
    error: 'Native OAuth endpoint stub not implemented in this repository.',
    required_env: REQUIRED_ENVS,
    missing_env: missing,
    notes: [
      'Implement platform-specific redirect + callback handling on the API server.',
      'Persist returned native analytics tokens back into Airtable client fields.',
      'Return a popup-safe success/failure page that notifies portal.html via postMessage.',
    ],
  });
}

module.exports = {
  REQUIRED_ENVS,
  getMissingEnvVars,
  nativeOAuthStub,
};
