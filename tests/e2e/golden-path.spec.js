const { test, expect } = require('@playwright/test');

// The product language in the request does not map 1:1 to the deployed nav.
// This suite covers the requested surfaces using the nearest live UI equivalents:
// - Plan -> Settings plan/billing surface
// - Calendar -> scheduled-content controls within Content
// - Inbox -> inbox filters and actions within Engage

const PORTAL_URL = 'https://www.socialengine.agency/portal.html';
const REQUIRED_ENV_VARS = ['PORTAL_EMAIL', 'PORTAL_PASSWORD'];
const LOGIN_TIMEOUT_MS = 45000;
const TAB_TIMEOUT_MS = 30000;

const TAB_DEFINITIONS = [
  {
    requestedName: 'Home',
    actualName: 'Home',
    nav: 'dashboard',
    data: async (page, context) => {
      const client = context.clientData.client || {};
      const expectedName = client.business_name || client.contact_name;

      if (expectedName) {
        await expect(page.locator('#dash-user-name')).toHaveText(expectedName, { timeout: TAB_TIMEOUT_MS });
      }

      if (client.contact_email) {
        await expect(page.locator('#dash-user-email')).toHaveText(client.contact_email, { timeout: TAB_TIMEOUT_MS });
      }

      await expect(page.locator('#dash-content').getByText(/Content Queue|Attributed Revenue|AI Intelligence|Competitive Snipe/))
        .toBeVisible({ timeout: TAB_TIMEOUT_MS });
    },
    ctas: [
      { name: 'Review Posts', locator: (page) => page.locator('.dash-quick-action').filter({ hasText: 'Review Posts' }) },
      { name: 'AI Coach', locator: (page) => page.locator('.dash-quick-action').filter({ hasText: 'AI Coach' }) },
      { name: 'Analytics', locator: (page) => page.locator('.dash-quick-action').filter({ hasText: 'Analytics' }) },
      { name: 'Competitors', locator: (page) => page.locator('.dash-quick-action').filter({ hasText: 'Competitors' }) },
      { name: 'Competitor snipe', locator: (page) => page.locator('#competitor-snipe-btn') },
    ],
  },
  {
    requestedName: 'Engage',
    actualName: 'Engage',
    nav: 'inbox',
    data: async (page) => {
      const body = page.locator('#inbox-body');
      await expect(body).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(body.getByText(/Total Messages/i)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(body.getByText(/Needs Reply/i)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(body.locator('.inbox-filter').first()).toBeVisible({ timeout: TAB_TIMEOUT_MS });
    },
    ctas: [
      { name: 'Refresh', locator: (page) => page.locator('#inbox-refresh-btn') },
      { name: 'Auto-Reply Settings', locator: (page) => page.locator('#inbox-settings-btn') },
      {
        name: 'Inbox primary action',
        locator: async (page) =>
          resolveFirstVisible(
            page.locator('#inbox-body').getByRole('link', { name: /Upgrade to Pro/i }),
            page.locator('#inbox-body').getByRole('button', { name: /Connect Instagram/i }),
            page.locator('#inbox-body').getByRole('button', { name: /Refresh inbox connection/i }),
            page.locator('#inbox-body').locator('.inbox-filter').first()
          ),
      },
    ],
  },
  {
    requestedName: 'Create',
    actualName: 'Create',
    nav: 'video-studio',
    data: async (page) => {
      await expect(page.getByText(/Marketing Studio/i)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(page.locator('#ms-credits-display')).toHaveText(/^\d+\s+credits$/, { timeout: TAB_TIMEOUT_MS });
      await expect(page.locator('#dash-content').getByText(/Templates|AI Models|Recent Generations/i))
        .toBeVisible({ timeout: TAB_TIMEOUT_MS });
    },
    ctas: [
      { name: 'Create Video', locator: (page) => page.getByRole('button', { name: /^Create Video$/ }).first() },
      { name: 'Generate Video', locator: (page) => page.locator('#vs-generate-btn') },
      { name: 'Template card', locator: (page) => page.locator('.vs-template-card').first() },
    ],
  },
  {
    requestedName: 'Ads',
    actualName: 'Ads',
    nav: 'ad-studio',
    data: async (page) => {
      await expect(page.getByText(/Ad Creative Studio/i)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(page.locator('#dash-content').getByText(/Select Product|Platform & Format|Copy Direction/i))
        .toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect
        .poll(async () => await page.locator('#ad-product-selector .ad-product-pick').count(), { timeout: TAB_TIMEOUT_MS })
        .toBeGreaterThan(0);
      await page.locator('#ad-product-selector .ad-product-pick').first().click();
      await expect(page.locator('#ad-generate-btn')).toBeEnabled({ timeout: TAB_TIMEOUT_MS });
    },
    ctas: [
      { name: 'Product picker', locator: (page) => page.locator('#ad-product-selector').locator('.ad-product-pick').first() },
      { name: 'Platform chip', locator: (page) => page.locator('.ad-platform-chip[data-platform]').first() },
      { name: 'Generate Ad Creative', locator: (page) => page.locator('#ad-generate-btn') },
    ],
  },
  {
    requestedName: 'Coach',
    actualName: 'Coach',
    nav: 'ai-coach',
    data: async (page, context) => {
      const client = context.clientData.client || {};
      const expectedBusinessName = client.business_name || 'your business';

      await expect(page.getByText(/AI Marketing Coach/i)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(page.locator('#chat-welcome')).toContainText(expectedBusinessName, { timeout: TAB_TIMEOUT_MS });
      await expect(page.locator('#chat-welcome').getByText(/Brand Fingerprint|Ask me anything|pending posts/i))
        .toBeVisible({ timeout: TAB_TIMEOUT_MS });
    },
    ctas: [
      { name: 'Suggestion chip', locator: (page) => page.locator('.chat-chip').first() },
      { name: 'Attach product', locator: (page) => page.locator('#chat-attach-product') },
      { name: 'Send message', locator: (page) => page.locator('#chat-send') },
    ],
  },
  {
    requestedName: 'Plan',
    actualName: 'Settings > plan management',
    nav: 'settings',
    data: async (page, context) => {
      const client = context.clientData.client || {};
      const tierName = client.tier || 'Pro';

      await expect(page.getByText(/^Settings$/)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(page.getByText(/Current Plan/i)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(page.locator('#dash-content').getByText(new RegExp(`${escapeRegExp(tierName)}\\s+Plan`, 'i')))
        .toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(page.locator('#dash-content').getByText(/Subscription & Support|Request Cancellation/i))
        .toBeVisible({ timeout: TAB_TIMEOUT_MS });
    },
    ctas: [
      { name: 'Contact Support', locator: (page) => page.getByRole('button', { name: /Contact Support/i }) },
      { name: 'Request Cancellation', locator: (page) => page.locator('#settings-cancel-btn') },
      {
        name: 'Plan helper',
        locator: async (page) =>
          resolveFirstVisible(
            page.getByRole('button', { name: /Connect Store/i }),
            page.getByRole('button', { name: /Connect Instagram/i }),
            page.getByRole('button', { name: /Later/i })
          ),
      },
    ],
  },
  {
    requestedName: 'Calendar',
    actualName: 'Content calendar within Content',
    nav: 'content',
    data: async (page, context) => {
      const posts = context.clientData.content || [];
      const headerSummary = page.locator('.studio-header__left p');

      await expect(page.getByText(/Content Studio/i)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(headerSummary).toContainText(`${posts.length} pieces`, { timeout: TAB_TIMEOUT_MS });
      await expect(page.locator('#dash-content').getByText(/Newest First|Oldest First|Pending|Approved/i).first())
        .toBeVisible({ timeout: TAB_TIMEOUT_MS });
    },
    ctas: [
      { name: 'Grid view', locator: (page) => page.locator('.studio-view-btn').filter({ hasText: 'Grid' }) },
      { name: 'List view', locator: (page) => page.locator('.studio-view-btn').filter({ hasText: 'List' }) },
      { name: 'Type filter', locator: (page) => page.locator('#studio-type-filter') },
    ],
  },
  {
    requestedName: 'Content',
    actualName: 'Content',
    nav: 'content',
    data: async (page, context) => {
      const posts = context.clientData.content || [];

      await expect(page.getByText(/Content Studio/i)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(page.locator('.studio-header__left p')).toContainText(`${posts.length} pieces`, {
        timeout: TAB_TIMEOUT_MS,
      });
      if (posts.length > 0) {
        await expect
          .poll(async () => await page.locator('.studio-card, .studio-list-item').count(), { timeout: TAB_TIMEOUT_MS })
          .toBeGreaterThan(0);
      }
    },
    ctas: [
      { name: 'Create Video', locator: (page) => page.getByRole('button', { name: /Create Video/i }).first() },
      { name: 'All filter', locator: (page) => page.locator('.studio-filter[data-filter="all"]') },
      {
        name: 'Primary content action',
        locator: async (page) =>
          resolveFirstVisible(
            page.locator('#bulk-approve-btn'),
            page.locator('.studio-card__approve-btn').first(),
            page.locator('.studio-card__view-btn').first(),
            page.locator('.studio-list-item').first()
          ),
      },
    ],
  },
  {
    requestedName: 'Inbox',
    actualName: 'Inbox filters inside Engage',
    nav: 'inbox',
    data: async (page) => {
      const body = page.locator('#inbox-body');
      await expect(body).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(body.locator('.inbox-filter').first()).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(body.getByText(/Comments|DMs|Mentions/i)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
    },
    ctas: [
      {
        name: 'Inbox CTA',
        locator: async (page) =>
          resolveFirstVisible(
            page.locator('.inbox-filter').first(),
            page.getByRole('button', { name: /Connect Instagram/i }),
            page.getByRole('link', { name: /Upgrade to Pro/i })
          ),
      },
      { name: 'Auto-Reply Settings', locator: (page) => page.locator('#inbox-settings-btn') },
      { name: 'Refresh', locator: (page) => page.locator('#inbox-refresh-btn') },
    ],
  },
  {
    requestedName: 'Grow',
    actualName: 'Grow',
    nav: 'analytics',
    data: async (page, context) => {
      const client = context.clientData.client || {};
      const expectedBusinessName = client.business_name || client.contact_name;

      await expect(page.getByText(/^Analytics$/)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      if (expectedBusinessName) {
        await expect(page.locator('#dash-content')).toContainText(expectedBusinessName, { timeout: TAB_TIMEOUT_MS });
      }
      await expect(page.locator('#analytics-body').getByText(/Total Content Created|Approval Rate|Posts Published/i))
        .toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(page.locator('.analytics-kpi-card__value').first()).not.toHaveText(/^$/, { timeout: TAB_TIMEOUT_MS });
    },
    ctas: [
      {
        name: 'Analytics primary action',
        locator: async (page) =>
          resolveFirstVisible(
            page.locator('#analytics-download-pdf'),
            page.locator('#analytics-refresh'),
            page.getByRole('link', { name: /Upgrade to Pro/i })
          ),
      },
      {
        name: 'Secondary analytics action',
        locator: async (page) =>
          resolveFirstVisible(page.locator('#analytics-refresh'), page.locator('#analytics-download-pdf')),
      },
    ],
  },
  {
    requestedName: 'Settings',
    actualName: 'Settings',
    nav: 'settings',
    data: async (page, context) => {
      const client = context.clientData.client || {};

      await expect(page.getByText(/^Settings$/)).toBeVisible({ timeout: TAB_TIMEOUT_MS });
      await expect(page.locator('#dash-content').getByText(/Manage your account|Account|Security|Shopify Store/i))
        .toBeVisible({ timeout: TAB_TIMEOUT_MS });
      if (client.business_name) {
        await expect(page.locator('#dash-content')).toContainText(client.business_name, { timeout: TAB_TIMEOUT_MS });
      }
      if (client.contact_email) {
        await expect(page.locator('#dash-content')).toContainText(client.contact_email, { timeout: TAB_TIMEOUT_MS });
      }
    },
    ctas: [
      {
        name: 'Settings primary action',
        locator: async (page) =>
          resolveFirstVisible(
            page.getByRole('button', { name: /Update Password/i }),
            page.getByRole('button', { name: /Connect Store/i }),
            page.getByRole('button', { name: /Connect Instagram/i })
          ),
      },
      { name: 'Contact Support', locator: (page) => page.getByRole('button', { name: /Contact Support/i }) },
      { name: 'Request Cancellation', locator: (page) => page.locator('#settings-cancel-btn') },
    ],
  },
];

test.describe('SocialEngine portal golden path', () => {
  test.beforeEach(async ({ page }) => {
    const jsErrors = [];
    const pageErrors = [];
    const failedRequests = [];

    page.on('console', (message) => {
      if (message.type() === 'error') jsErrors.push(message.text());
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
    page.on('requestfailed', (request) => {
      if (!['document', 'script', 'stylesheet'].includes(request.resourceType())) return;
      failedRequests.push({
        url: request.url(),
        method: request.method(),
        failure: request.failure()?.errorText || 'unknown',
      });
    });

    page.__goldenPathState = { jsErrors, pageErrors, failedRequests };
  });

  test('covers the deployed paying-customer portal journey', async ({ page }) => {
    assertRequiredEnv();
    const context = {
      clientData: null,
    };

    await test.step('sign in with env credentials', async () => {
      const loginCheckpoint = captureErrorSnapshot(page);
      const clientDataResponsePromise = page.waitForResponse(
        (response) => response.url().includes('/api/client-data') && response.ok(),
        { timeout: LOGIN_TIMEOUT_MS }
      );

      await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' });

      await expect(page.locator('#login-form')).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
      await page.locator('#login-email').fill(process.env.PORTAL_EMAIL);
      await page.locator('#login-password').fill(process.env.PORTAL_PASSWORD);
      await page.locator('#login-btn').click();

      const clientDataResponse = await clientDataResponsePromise;
      context.clientData = await clientDataResponse.json();
      await expect(page.locator('#dashboard-view')).toHaveClass(/active/, { timeout: LOGIN_TIMEOUT_MS });
      await expect(page.locator('#portal-login-view')).toHaveClass(/hidden/, { timeout: LOGIN_TIMEOUT_MS });
      await expect(page.locator('#dash-user-email')).not.toHaveText(/^$/, { timeout: LOGIN_TIMEOUT_MS });
      await waitForInitialPortalData(page);
      assertNoJavaScriptErrors(page, 'after login', loginCheckpoint);
    });

    for (const tab of TAB_DEFINITIONS) {
      await test.step(`verify ${tab.requestedName}`, async () => {
        const checkpoint = captureErrorSnapshot(page);
        await navigateToTab(page, tab.nav);
        await tab.data(page, context);

        for (const cta of tab.ctas) {
          const locator = await cta.locator(page);
          await expect(locator, `${tab.requestedName}: ${cta.name} should be visible`).toBeVisible({
            timeout: TAB_TIMEOUT_MS,
          });
          await expect(locator, `${tab.requestedName}: ${cta.name} should be enabled`).toBeEnabled({
            timeout: TAB_TIMEOUT_MS,
          });
          await expect(locator, `${tab.requestedName}: ${cta.name} should accept clicks`).toBeInViewport();
          await locator.click({ trial: true });
        }

        assertNoJavaScriptErrors(page, tab.requestedName, checkpoint);
      });
    }
  });
});

function assertRequiredEnv() {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  test.skip(missing.length > 0, `Missing required env vars: ${missing.join(', ')}`);
}

async function navigateToTab(page, nav) {
  const navButton = page.locator(`.dash-nav-item[data-nav="${nav}"]`);
  await expect(navButton).toBeVisible({ timeout: TAB_TIMEOUT_MS });
  await navButton.click();
  await expect(navButton).toHaveClass(/active/, { timeout: TAB_TIMEOUT_MS });
  await page.waitForTimeout(350);
}

async function waitForInitialPortalData(page) {
  await expect
    .poll(async () => {
      const content = await page.locator('#dash-content').textContent();
      return /Content Queue|Competitive Snipe|No posts yet|Loading/i.test(content || '');
    }, { timeout: LOGIN_TIMEOUT_MS })
    .toBe(true);
}

function assertNoJavaScriptErrors(page, scope, checkpoint = { jsErrors: 0, pageErrors: 0, failedRequests: 0 }) {
  const state = page.__goldenPathState;
  const ignoredPatterns = [
    /Failed to load resource:.*favicon/i,
  ];

  const jsErrors = state.jsErrors
    .slice(checkpoint.jsErrors)
    .filter((message) => !ignoredPatterns.some((pattern) => pattern.test(message)));
  const pageErrors = state.pageErrors
    .slice(checkpoint.pageErrors)
    .filter((message) => !ignoredPatterns.some((pattern) => pattern.test(message)));
  const failedRequests = state.failedRequests.slice(checkpoint.failedRequests).filter((entry) => {
    if (/favicon/i.test(entry.url)) return false;
    return true;
  });

  expect(
    {
      consoleErrors: jsErrors,
      pageErrors,
      failedRequests,
    },
    `${scope} should not produce JavaScript/runtime errors`
  ).toEqual({
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  });
}

function captureErrorSnapshot(page) {
  const state = page.__goldenPathState;
  return {
    jsErrors: state.jsErrors.length,
    pageErrors: state.pageErrors.length,
    failedRequests: state.failedRequests.length,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveFirstVisible(...locators) {
  for (const locator of locators) {
    if ((await locator.count()) > 0 && await locator.first().isVisible()) {
      return locator.first();
    }
  }

  return locators[0].first();
}
