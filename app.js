/* ============================================
   SocialEngine — App JavaScript
   ============================================ */

const API_BASE = 'https://app-production-55ba.up.railway.app';
const STRIPE_MONTHLY_LINK = 'https://buy.stripe.com/fZufZh5CH0vC6oocx1cQU03';

(function () {
  'use strict';

  // --- Dark Mode Toggle ---
  const themeToggle = document.querySelector('[data-theme-toggle]');
  const root = document.documentElement;
  let currentTheme = 'dark';
  root.setAttribute('data-theme', currentTheme);
  updateThemeIcon();

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', currentTheme);
      themeToggle.setAttribute('aria-label', `Switch to ${currentTheme === 'dark' ? 'light' : 'dark'} mode`);
      updateThemeIcon();
    });
  }

  function updateThemeIcon() {
    if (!themeToggle) return;
    if (currentTheme === 'dark') {
      themeToggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
    } else {
      themeToggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
  }

  // --- Header scroll detection ---
  const header = document.querySelector('.header');
  window.addEventListener('scroll', () => {
    if (window.scrollY > 20) header.classList.add('header--scrolled');
    else header.classList.remove('header--scrolled');
  }, { passive: true });

  // --- Scroll Reveal ---
  const revealElements = document.querySelectorAll('.reveal');
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('reveal--visible');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  revealElements.forEach((el) => revealObserver.observe(el));

  // --- Count-Up Animation ---
  const countElements = document.querySelectorAll('[data-count-to]');
  const countObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        animateCount(entry.target);
        countObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.3 });
  countElements.forEach((el) => countObserver.observe(el));

  function animateCount(el) {
    const target = parseInt(el.dataset.countTo, 10);
    const suffix = el.dataset.suffix || '';
    const duration = 1200;
    const startTime = performance.now();
    function step(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(target * eased).toLocaleString() + suffix;
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // --- Pricing Toggle ---
  const pricingToggle = document.querySelector('[data-pricing-toggle]');
  const monthlyLabel = document.querySelector('[data-billing="monthly"]');
  const annualLabel = document.querySelector('[data-billing="annual"]');
  const priceAmounts = document.querySelectorAll('[data-price-monthly]');
  let isAnnual = false;

  if (pricingToggle) {
    pricingToggle.addEventListener('click', () => {
      isAnnual = !isAnnual;
      pricingToggle.setAttribute('aria-checked', isAnnual.toString());
      monthlyLabel.classList.toggle('pricing-toggle__label--active', !isAnnual);
      annualLabel.classList.toggle('pricing-toggle__label--active', isAnnual);
      priceAmounts.forEach((el) => {
        el.textContent = '$' + (isAnnual ? el.dataset.priceAnnual : el.dataset.priceMonthly);
      });
    });
  }

  // --- FAQ Accordion ---
  document.querySelectorAll('.faq-item').forEach((item) => {
    item.querySelector('.faq-item__trigger').addEventListener('click', () => {
      const isOpen = item.dataset.open === 'true';
      document.querySelectorAll('.faq-item').forEach((other) => {
        if (other !== item) {
          other.dataset.open = 'false';
          other.querySelector('.faq-item__trigger').setAttribute('aria-expanded', 'false');
        }
      });
      item.dataset.open = isOpen ? 'false' : 'true';
      item.querySelector('.faq-item__trigger').setAttribute('aria-expanded', (!isOpen).toString());
    });
  });

  // --- Mobile Navigation ---
  const mobileNavToggle = document.querySelector('.mobile-nav-toggle');
  const mobileNav = document.getElementById('mobile-nav');
  const mobileNavClose = mobileNav ? mobileNav.querySelector('.mobile-nav__close') : null;

  function openMobileNav() {
    if (!mobileNav) return;
    mobileNav.classList.add('mobile-nav--open');
    mobileNavToggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function closeMobileNav() {
    if (!mobileNav) return;
    mobileNav.classList.remove('mobile-nav--open');
    mobileNavToggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  if (mobileNavToggle) mobileNavToggle.addEventListener('click', openMobileNav);
  if (mobileNavClose) mobileNavClose.addEventListener('click', closeMobileNav);
  if (mobileNav) mobileNav.querySelectorAll('a').forEach((l) => l.addEventListener('click', closeMobileNav));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mobileNav?.classList.contains('mobile-nav--open')) closeMobileNav();
  });

  // ====================================================
  //  AI AUDIT FORM — Calls backend, shows results on-screen
  // ====================================================
  const auditForm = document.getElementById('audit-form');
  const auditSubmit = document.getElementById('audit-submit');
  const auditSuccess = document.getElementById('audit-success');
  const auditError = document.getElementById('audit-error');
  const auditRetry = document.getElementById('audit-retry');
  const auditResults = document.getElementById('audit-results');

  function validateURL(str) {
    try {
      const url = new URL(str);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      try {
        const url = new URL('https://' + str);
        return url.hostname.includes('.');
      } catch { return false; }
    }
  }

  function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function normalizeURL(str) {
    try { new URL(str); return str; }
    catch { return 'https://' + str; }
  }

  function clearFieldError(id) {
    const input = document.getElementById(id);
    const err = document.getElementById(id + '-error');
    if (input) input.classList.remove('ai-audit__input--error');
    if (err) err.textContent = '';
  }

  function setFieldError(id, msg) {
    const input = document.getElementById(id);
    const err = document.getElementById(id + '-error');
    if (input) input.classList.add('ai-audit__input--error');
    if (err) err.textContent = msg;
  }

  // Animated processing steps
  const processingSteps = [
    'Connecting to your store...',
    'Reading product catalog...',
    'Analyzing brand positioning...',
    'Scoring content potential...',
    'Checking platform readiness...',
    'Generating sample posts...',
    'Building your audit report...',
  ];

  function showProcessingAnimation() {
    const submitText = auditSubmit.querySelector('.ai-audit__submit-text');
    const submitIcon = auditSubmit.querySelector('.ai-audit__submit-icon');
    if (submitIcon) submitIcon.style.display = 'none';
    auditSubmit.classList.add('ai-audit__submit--loading');
    auditSubmit.disabled = true;

    let step = 0;
    const interval = setInterval(() => {
      if (step < processingSteps.length) {
        if (submitText) submitText.textContent = processingSteps[step];
        step++;
      } else {
        if (submitText) submitText.textContent = 'Almost there...';
      }
    }, 2000);

    return () => {
      clearInterval(interval);
      auditSubmit.classList.remove('ai-audit__submit--loading');
      auditSubmit.disabled = false;
      if (submitText) submitText.textContent = 'Run My Free Audit';
      if (submitIcon) submitIcon.style.display = '';
    };
  }

  function renderAuditResults(data) {
    const audit = data.audit;
    const score = audit.overall_score || 0;
    // v7 palette: indigo for strong, orange for warn, red for weak
    const scoreColor = score >= 65 ? '#7C3AED' : score >= 40 ? '#FF6B35' : '#EF4444';
    const circumference = 2 * Math.PI * 54;
    const offset = circumference - (score / 100) * circumference;
    const portalEmail = data.portal_access?.email || '';
    const portalPassword = data.portal_access?.password || 'Welcome2026!';
    const postCount = (audit.sample_posts || []).length;
    const strength = (audit.strengths || [])[0] || '';
    const weakness = (audit.weaknesses || [])[0] || '';
    const scoreLabel = score >= 65 ? 'Strong foundation' : score >= 40 ? 'Room to grow' : 'Needs work';

    // TEASER VIEW — show score + 1 insight + push to portal
    const html = `
      <div class="audit-report" style="max-width:560px;margin:0 auto;">

        <!-- Score ring -->
        <div class="audit-report__header" style="margin-bottom:24px;">
          <div class="audit-report__score-ring">
            <svg viewBox="0 0 120 120" class="audit-ring-svg">
              <circle cx="60" cy="60" r="54" stroke="rgba(255,255,255,0.08)" stroke-width="8" fill="none"/>
              <circle cx="60" cy="60" r="54" stroke="${scoreColor}" stroke-width="8" fill="none"
                stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
                stroke-linecap="round" transform="rotate(-90 60 60)"
                class="audit-ring-progress"/>
            </svg>
            <div class="audit-ring-text">
              <span class="audit-report__score-num">${score}</span>
              <span class="audit-report__score-label">/ 100</span>
            </div>
          </div>
          <div>
            <h3 class="audit-report__title">Your Social Media Audit</h3>
            <p class="audit-report__subtitle">${data.shopify_detected ? `We found <strong>${data.product_count} products</strong> in your catalog.` : 'We analysed your web presence and social potential.'}</p>
            <div style="display:inline-block;margin-top:8px;padding:4px 12px;border-radius:20px;font-size:0.75rem;font-weight:600;background:${scoreColor}22;color:${scoreColor};border:1px solid ${scoreColor}44;">${scoreLabel}</div>
          </div>
        </div>

        <!-- One key insight -->
        ${strength || weakness ? `
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px 20px;margin-bottom:20px;">
          ${strength ? `<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:${weakness ? '12px' : '0'};">
            <div style="color:#00E5FF;font-size:14px;margin-top:1px;flex-shrink:0;">&#10003;</div>
            <p style="font-size:0.85rem;color:#94A3B8;margin:0;line-height:1.5;"><strong style="color:#F1F5F9;">Strength:</strong> ${strength}</p>
          </div>` : ''}
          ${weakness ? `<div style="display:flex;gap:10px;align-items:flex-start;">
            <div style="color:#FF6B35;font-size:14px;margin-top:1px;flex-shrink:0;">&#9888;</div>
            <p style="font-size:0.85rem;color:#94A3B8;margin:0;line-height:1.5;"><strong style="color:#F1F5F9;">Biggest gap:</strong> ${weakness}</p>
          </div>` : ''}
        </div>` : ''}

        <!-- What's waiting in portal -->
        <div style="background:linear-gradient(135deg,rgba(124,58,237,0.10),rgba(0,229,255,0.05));border:1px solid rgba(124,58,237,0.3);border-radius:14px;padding:20px 24px;margin-bottom:20px;">
          <p style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#8B5CF6;margin:0 0 14px;">YOUR FREE PORTAL IS READY</p>
          <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="width:28px;height:28px;background:rgba(0,229,255,0.12);border:1px solid rgba(0,229,255,0.25);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">&#128203;</div>
              <span style="font-size:0.85rem;color:#94A3B8;"><strong style="color:#F1F5F9;">${postCount} AI-generated posts</strong> drafted for your brand — ready to review &amp; approve</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="width:28px;height:28px;background:rgba(124,58,237,0.14);border:1px solid rgba(124,58,237,0.3);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">&#128200;</div>
              <span style="font-size:0.85rem;color:#94A3B8;">Full score breakdown across <strong style="color:#F1F5F9;">5 categories</strong> with specific action items</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="width:28px;height:28px;background:rgba(0,229,255,0.12);border:1px solid rgba(0,229,255,0.25);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">&#129302;</div>
              <span style="font-size:0.85rem;color:#94A3B8;">Your AI marketing coach <strong style="color:#F1F5F9;">knows your products</strong> — ask it anything</span>
            </div>
          </div>

          <a href="/portal.html" onclick="localStorage.setItem('se_prefill_email','${portalEmail}')" class="btn btn--primary" style="width:100%;text-align:center;display:block;padding:14px;border-radius:10px;font-size:0.95rem;font-weight:700;text-decoration:none;background:linear-gradient(135deg,#7C3AED,#6D28D9);color:#fff;border:1px solid #7C3AED;box-shadow:0 8px 24px -8px rgba(124,58,237,0.45);">
            Open Your Free Portal &#8594;
          </a>
          ${portalEmail ? `<p style="font-size:0.72rem;color:#64748B;text-align:center;margin:10px 0 0;">Login: <strong style="color:#94A3B8;">${portalEmail}</strong> &nbsp;&bull;&nbsp; Password: <strong style="color:#94A3B8;">${portalPassword}</strong></p>` : ''}
        </div>

        <!-- Upgrade CTA: below free portal, above revenue teaser -->
        <div style="background:linear-gradient(135deg,rgba(255,107,53,0.10),rgba(124,58,237,0.05));border:1px solid rgba(255,107,53,0.25);border-radius:14px;padding:20px 24px;margin-bottom:16px;">
          <p style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#FF6B35;margin:0 0 10px;">READY TO GO FULL THROTTLE?</p>
          <p style="font-size:0.85rem;color:#94A3B8;line-height:1.55;margin:0 0 16px;">Your free portal shows you the preview. Growth Plan unlocks <strong style="color:#F1F5F9;">45 posts/month, AI video reels, full analytics, competitor intel, and the AI marketing coach</strong> — all pre-trained on your brand.</p>
          <a href="https://buy.stripe.com/fZu4gz7KP4LSfYY40vcQU05" target="_blank" rel="noopener" class="btn btn--accent btn--lg" style="width:100%;text-align:center;display:block;padding:14px;border-radius:10px;font-size:0.95rem;font-weight:700;text-decoration:none;background:linear-gradient(135deg,#FF6B35,#FF8F65);color:#fff;border:none;box-shadow:0 10px 28px -8px rgba(255,107,53,0.45);">
            Start Growth Plan &mdash; $297/mo &#8594;
          </a>
          <p style="font-size:0.72rem;color:#64748B;text-align:center;margin:10px 0 0;">30-day money-back guarantee &nbsp;&bull;&nbsp; Cancel anytime</p>
        </div>

        <!-- Revenue opportunity teaser -->
        ${audit.revenue_opportunity ? `
        <div style="display:flex;align-items:center;gap:14px;padding:14px 18px;background:rgba(0,229,255,0.06);border:1px solid rgba(0,229,255,0.2);border-radius:10px;margin-bottom:16px;">
          <div style="font-size:22px;">&#128176;</div>
          <div>
            <div style="font-size:0.75rem;font-weight:600;color:#00E5FF;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px;">Revenue Opportunity</div>
            <p style="font-size:0.82rem;color:#94A3B8;margin:0;line-height:1.5;">${audit.revenue_opportunity}</p>
          </div>
        </div>` : ''}

        <!-- Social Profile Stats (if returned) -->
        ${(data.social_profiles && (data.social_profiles.instagram || data.social_profiles.tiktok)) ? `
        <div style="margin-bottom:16px;">
          <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#8B5CF6;margin-bottom:12px;">YOUR SOCIAL PRESENCE</div>
          <div style="display:grid;grid-template-columns:${data.social_profiles.instagram && data.social_profiles.tiktok ? '1fr 1fr' : '1fr'};gap:12px;">
            ${data.social_profiles.instagram ? `
            <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
                <div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#833AB4,#E1306C,#F77737);display:flex;align-items:center;justify-content:center;font-size:14px;">&#128248;</div>
                <div>
                  <div style="font-size:0.8rem;font-weight:600;color:#fff;">Instagram</div>
                  <div style="font-size:0.7rem;color:#888;">@${data.social_profiles.instagram.username || ''}</div>
                </div>
              </div>
              <div style="display:flex;gap:16px;margin-bottom:${data.social_profiles.instagram.biography ? '10px' : '0'};">
                <div>
                  <div style="font-size:1.1rem;font-weight:700;color:#fff;font-family:var(--font-display,sans-serif);">${data.social_profiles.instagram.followers_count != null ? Number(data.social_profiles.instagram.followers_count).toLocaleString() : '&#8212;'}</div>
                  <div style="font-size:0.68rem;color:#888;font-weight:500;">Followers</div>
                </div>
                <div>
                  <div style="font-size:1.1rem;font-weight:700;color:#fff;font-family:var(--font-display,sans-serif);">${data.social_profiles.instagram.media_count != null ? Number(data.social_profiles.instagram.media_count).toLocaleString() : '&#8212;'}</div>
                  <div style="font-size:0.68rem;color:#888;font-weight:500;">Posts</div>
                </div>
              </div>
              ${data.social_profiles.instagram.biography ? `<p style="font-size:0.75rem;color:#999;margin:0;line-height:1.5;">${data.social_profiles.instagram.biography.substring(0,100)}${data.social_profiles.instagram.biography.length > 100 ? '&hellip;' : ''}</p>` : ''}
            </div>` : ''}
            ${data.social_profiles.tiktok ? `
            <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
                <div style="width:32px;height:32px;border-radius:8px;background:#000;border:1px solid rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;font-size:14px;">&#127925;</div>
                <div>
                  <div style="font-size:0.8rem;font-weight:600;color:#fff;">TikTok</div>
                  <div style="font-size:0.7rem;color:#888;">@${data.social_profiles.tiktok.username || ''}</div>
                </div>
              </div>
              <div style="display:flex;gap:16px;margin-bottom:${data.social_profiles.tiktok.bio_description ? '10px' : '0'};">
                <div>
                  <div style="font-size:1.1rem;font-weight:700;color:#fff;font-family:var(--font-display,sans-serif);">${data.social_profiles.tiktok.follower_count != null ? Number(data.social_profiles.tiktok.follower_count).toLocaleString() : '&#8212;'}</div>
                  <div style="font-size:0.68rem;color:#888;font-weight:500;">Followers</div>
                </div>
                <div>
                  <div style="font-size:1.1rem;font-weight:700;color:#fff;font-family:var(--font-display,sans-serif);">${data.social_profiles.tiktok.video_count != null ? Number(data.social_profiles.tiktok.video_count).toLocaleString() : '&#8212;'}</div>
                  <div style="font-size:0.68rem;color:#888;font-weight:500;">Videos</div>
                </div>
              </div>
              ${data.social_profiles.tiktok.bio_description ? `<p style="font-size:0.75rem;color:#999;margin:0;line-height:1.5;">${data.social_profiles.tiktok.bio_description.substring(0,100)}${data.social_profiles.tiktok.bio_description.length > 100 ? '&hellip;' : ''}</p>` : ''}
            </div>` : ''}
          </div>
        </div>` : ''}

      </div>
    `;

    return html;
  }

  // LEGACY: full audit render kept below for internal/admin reference
  // renderAuditResultsFull_UNUSED removed — contained stale pricing

  if (auditForm) {
    const urlInput = document.getElementById('audit-url');
    const emailInput = document.getElementById('audit-email');
    if (urlInput) urlInput.addEventListener('input', () => clearFieldError('audit-url'));
    if (emailInput) emailInput.addEventListener('input', () => clearFieldError('audit-email'));

    auditForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = urlInput.value.trim();
      const email = emailInput.value.trim();
      const name = document.getElementById('audit-name')?.value.trim() || '';

      let valid = true;
      clearFieldError('audit-url');
      clearFieldError('audit-email');

      if (!url) { setFieldError('audit-url', 'Please enter your website URL.'); valid = false; }
      else if (!validateURL(url)) { setFieldError('audit-url', 'Enter a valid URL (e.g. yourstore.com).'); valid = false; }
      if (!email) { setFieldError('audit-email', 'Please enter your email.'); valid = false; }
      else if (!validateEmail(email)) { setFieldError('audit-email', 'Enter a valid email address.'); valid = false; }
      if (!valid) return;

      // Show processing animation
      const stopAnimation = showProcessingAnimation();

      try {
        const response = await fetch(`${API_BASE}/api/audit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ website: normalizeURL(url), email, name, instagram_handle: document.getElementById('audit-instagram')?.value || '', tiktok_handle: document.getElementById('audit-tiktok')?.value || '', facebook_handle: document.getElementById('audit-facebook')?.value || '' }),
        });

        if (!response.ok) throw new Error('Audit request failed');
        const data = await response.json();

        stopAnimation();

        if (data.success && data.audit) {
          // Show results on screen
          auditForm.hidden = true;
          if (auditSuccess) auditSuccess.hidden = true;
          if (auditError) auditError.hidden = true;

          // Create results container if it doesn't exist
          let resultsEl = document.getElementById('audit-results');
          if (!resultsEl) {
            resultsEl = document.createElement('div');
            resultsEl.id = 'audit-results';
            auditForm.parentNode.insertBefore(resultsEl, auditForm.nextSibling);
          }
          resultsEl.innerHTML = renderAuditResults(data);
          resultsEl.hidden = false;

          // Smooth scroll to results
          resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          throw new Error('Invalid response');
        }
      } catch (err) {
        console.error('Audit error:', err);
        stopAnimation();
        if (auditError) {
          auditError.hidden = false;
          auditForm.hidden = true;
        }
      }
    });
  }

  if (auditRetry) {
    auditRetry.addEventListener('click', () => {
      if (auditForm) auditForm.hidden = false;
      if (auditError) auditError.hidden = true;
      if (auditSuccess) auditSuccess.hidden = true;
      const resultsEl = document.getElementById('audit-results');
      if (resultsEl) resultsEl.hidden = true;
    });
  }

  // --- Initialize Lucide Icons ---
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  } else {
    window.addEventListener('load', () => {
      if (typeof lucide !== 'undefined') lucide.createIcons();
    });
  }

})();
