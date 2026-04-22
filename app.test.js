const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function createClassList() {
  const values = new Set();

  return {
    add(...tokens) {
      tokens.forEach((token) => values.add(token));
    },
    remove(...tokens) {
      tokens.forEach((token) => values.delete(token));
    },
    toggle(token, force) {
      if (force === true) {
        values.add(token);
        return true;
      }
      if (force === false) {
        values.delete(token);
        return false;
      }
      if (values.has(token)) {
        values.delete(token);
        return false;
      }
      values.add(token);
      return true;
    },
    contains(token) {
      return values.has(token);
    },
  };
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.hidden = false;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.children = [];
    this.classList = createClassList();
    this.parentNode = {
      insertBefore: () => {},
    };
    this._query = {};
    this._queryAll = {};
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  async trigger(type, event = {}) {
    for (const handler of this.listeners[type] || []) {
      await handler(event);
    }
  }

  querySelector(selector) {
    return this._query[selector] || null;
  }

  querySelectorAll(selector) {
    return this._queryAll[selector] || [];
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  remove() {
    this.removed = true;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  scrollIntoView() {
    this.scrolledIntoView = true;
  }
}

function loadApp(fetchImpl) {
  const elements = new Map();
  const body = new FakeElement('body');
  const consoleErrors = [];

  const addElement = (id) => {
    const element = new FakeElement(id);
    elements.set(id, element);
    return element;
  };

  const themeToggle = new FakeElement('theme-toggle');
  const header = new FakeElement('header');
  const mobileNavToggle = new FakeElement('mobile-nav-toggle');
  const mobileNav = addElement('mobile-nav');
  const mobileNavClose = new FakeElement('mobile-nav-close');
  mobileNav._query['.mobile-nav__close'] = mobileNavClose;
  mobileNav._queryAll.a = [];

  const auditForm = addElement('audit-form');
  const auditSubmit = addElement('audit-submit');
  const auditSuccess = addElement('audit-success');
  const auditError = addElement('audit-error');
  const auditRetry = addElement('audit-retry');
  const auditResults = addElement('audit-results');
  const auditUrl = addElement('audit-url');
  const auditEmail = addElement('audit-email');
  const auditName = addElement('audit-name');
  const auditInstagram = addElement('audit-instagram');
  const auditTiktok = addElement('audit-tiktok');
  const auditFacebook = addElement('audit-facebook');
  const auditUrlError = addElement('audit-url-error');
  const auditEmailError = addElement('audit-email-error');

  const submitText = new FakeElement('submit-text');
  const submitIcon = new FakeElement('submit-icon');
  auditSubmit._query['.ai-audit__submit-text'] = submitText;
  auditSubmit._query['.ai-audit__submit-icon'] = submitIcon;

  auditForm.parentNode = {
    insertBefore: () => {},
  };

  const document = {
    body,
    documentElement: new FakeElement('document-element'),
    querySelector(selector) {
      switch (selector) {
        case '[data-theme-toggle]':
          return themeToggle;
        case '.header':
          return header;
        case '.mobile-nav-toggle':
          return mobileNavToggle;
        default:
          return null;
      }
    },
    querySelectorAll(selector) {
      if (selector === '.reveal' || selector === '[data-count-to]' || selector === '.faq-item') {
        return [];
      }
      return [];
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    addEventListener() {},
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };

  const sandbox = {
    URL,
    document,
    console: {
      error: (...args) => consoleErrors.push(args),
      log() {},
      warn() {},
    },
    fetch: fetchImpl,
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
    },
    localStorage: {
      setItem() {},
    },
    lucide: undefined,
    performance: {
      now: () => 0,
    },
    requestAnimationFrame: (callback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame() {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  };

  const windowObject = {
    ...sandbox,
    addEventListener() {},
    scrollY: 0,
    __SOCIALENGINE_ENABLE_TEST_HOOKS__: true,
  };

  sandbox.window = windowObject;
  sandbox.globalThis = windowObject;
  windowObject.window = windowObject;
  windowObject.document = document;
  windowObject.globalThis = windowObject;

  vm.createContext(sandbox);
  vm.runInContext(APP_SOURCE, sandbox, { filename: 'app.js' });

  return {
    body,
    consoleErrors,
    elements,
    window: windowObject,
  };
}

function latestToastText(app) {
  const toastContainer = app.body.children.at(-1);
  if (!toastContainer) return '';

  const toast = toastContainer.children.at(-1);
  return toast ? toast.textContent : '';
}

test('app exposes safe write hooks when test mode is enabled', () => {
  const app = loadApp(async () => ({ ok: true, json: async () => ({ success: true }) }));

  assert.ok(app.window.__SOCIALENGINE_TEST_HOOKS__);
  assert.equal(typeof app.window.__SOCIALENGINE_TEST_HOOKS__.safeWrite, 'function');
  assert.equal(typeof app.window.__SOCIALENGINE_TEST_HOOKS__.SafeWriteError, 'function');
});

test('safeWrite resolves successful mutation payloads', async () => {
  const app = loadApp(async () => ({
    ok: true,
    json: async () => ({ success: true, audit: { overall_score: 88 } }),
  }));

  const data = await app.window.__SOCIALENGINE_TEST_HOOKS__.safeWrite('/api/audit', { website: 'https://example.com' });

  assert.equal(data.success, true);
  assert.equal(data.audit.overall_score, 88);
});

test('safeWrite throws a typed error for failed HTTP responses', async () => {
  const app = loadApp(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Backend unavailable' }),
  }));

  await assert.rejects(
    app.window.__SOCIALENGINE_TEST_HOOKS__.safeWrite('/api/audit', { website: 'https://example.com' }),
    (error) => {
      assert.equal(error.name, 'SafeWriteError');
      assert.equal(error.userMessage, 'Backend unavailable');
      assert.equal(error.status, 500);
      return true;
    }
  );
});

test('safeWrite rejects payloads that do not acknowledge success', async () => {
  const app = loadApp(async () => ({
    ok: true,
    json: async () => ({ message: 'missing success marker' }),
  }));

  await assert.rejects(
    app.window.__SOCIALENGINE_TEST_HOOKS__.safeWrite('/api/audit', { website: 'https://example.com' }),
    (error) => {
      assert.equal(error.name, 'SafeWriteError');
      assert.match(error.userMessage, /unexpected/i);
      return true;
    }
  );
});

test('safeWrite rejects audit payloads without success or data acknowledgement', async () => {
  const app = loadApp(async () => ({
    ok: true,
    json: async () => ({ audit: { overall_score: 91 } }),
  }));

  await assert.rejects(
    app.window.__SOCIALENGINE_TEST_HOOKS__.safeWrite('/api/audit', { website: 'https://example.com' }),
    (error) => {
      assert.equal(error.name, 'SafeWriteError');
      assert.equal(error.code, 'INVALID_RESPONSE');
      return true;
    }
  );
});

test('safeWrite normalizes 204 mutation responses into success data', async () => {
  const app = loadApp(async () => ({
    ok: true,
    status: 204,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  }));

  const data = await app.window.__SOCIALENGINE_TEST_HOOKS__.safeWrite('/api/resource', undefined, {
    method: 'DELETE',
  });

  assert.equal(data.success, true);
  assert.equal(data.data, null);
});

test('audit submit surfaces mutation failures to a toast', async () => {
  const app = loadApp(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'Service temporarily unavailable' }),
  }));

  app.elements.get('audit-url').value = 'example.com';
  app.elements.get('audit-email').value = 'owner@example.com';

  await app.elements.get('audit-form').trigger('submit', {
    preventDefault() {},
  });

  assert.equal(latestToastText(app), 'Service temporarily unavailable');
  assert.equal(app.elements.get('audit-error').hidden, false);
});

test('global error handlers log and show user-friendly toasts', () => {
  const app = loadApp(async () => ({ ok: true, json: async () => ({ success: true }) }));

  app.window.onerror('Boom', 'app.js', 10, 20, new Error('Boom'));

  assert.match(latestToastText(app), /something went wrong/i);

  const SafeWriteError = app.window.__SOCIALENGINE_TEST_HOOKS__.SafeWriteError;
  app.window.onunhandledrejection({
    reason: new SafeWriteError('Request failed', {
      userMessage: 'Unable to save your changes right now.',
    }),
  });

  assert.equal(latestToastText(app), 'Unable to save your changes right now.');
  assert.equal(app.consoleErrors.length, 2);
});
