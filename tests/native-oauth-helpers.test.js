const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNativeOAuthUrl,
  getPlatformConnectionState,
  getNativeOAuthFailureMessage,
  shouldStartNativeOAuth,
} = require('../portal-native-oauth.js');

test('buildNativeOAuthUrl encodes auth query params for the platform endpoint', () => {
  const url = buildNativeOAuthUrl(
    'https://api.socialengine.test',
    'instagram',
    'owner+brand@example.com',
    'hash/with spaces'
  );

  assert.equal(
    url,
    'https://api.socialengine.test/api/social/native-oauth/instagram?email=owner%2Bbrand%40example.com&hash=hash%2Fwith%20spaces'
  );
});

test('instagram publish-only connections are marked as analytics-limited', () => {
  const state = getPlatformConnectionState(
    'instagram',
    {
      social_connected_platforms: ['instagram'],
      instagram_user_id: '',
    },
    {
      accounts: [{ platform: 'instagram', name: 'brandname' }],
    }
  );

  assert.equal(state.publishConnected, true);
  assert.equal(state.nativeConnected, false);
  assert.equal(state.analyticsLimited, true);
  assert.equal(state.statusLabel, 'Publishing only');
});

test('facebook requires both native page id and token for full analytics status', () => {
  const state = getPlatformConnectionState(
    'facebook',
    {
      social_connected_platforms: ['facebook'],
      meta_page_id: '12345',
      meta_page_token: 'token-abc',
    },
    {
      accounts: [{ platform: 'facebook', name: 'Brand Page' }],
    }
  );

  assert.equal(state.publishConnected, true);
  assert.equal(state.nativeConnected, true);
  assert.equal(state.fullyConnected, true);
  assert.equal(state.statusLabel, 'Connected');
});

test('failure messaging explains that Grow analytics will be limited', () => {
  const message = getNativeOAuthFailureMessage('tiktok');

  assert.match(message, /TikTok/i);
  assert.match(message, /Grow/i);
  assert.match(message, /limited/i);
});

test('native OAuth follow-up starts only for publish-only connections', () => {
  assert.equal(
    shouldStartNativeOAuth(
      'instagram',
      { social_connected_platforms: ['instagram'], instagram_user_id: '' },
      { accounts: [{ platform: 'instagram' }] }
    ),
    true
  );

  assert.equal(
    shouldStartNativeOAuth(
      'instagram',
      { social_connected_platforms: ['instagram'], instagram_user_id: '1784' },
      { accounts: [{ platform: 'instagram' }] }
    ),
    false
  );
});
