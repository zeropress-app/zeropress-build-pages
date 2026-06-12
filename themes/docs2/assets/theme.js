(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var smoothScrollEnhanced = false;
  function enableSmoothScrollAfterInitialNavigation() {
    if (smoothScrollEnhanced) return;
    smoothScrollEnhanced = true;
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        document.documentElement.classList.add('is-scroll-enhanced');
      });
    });
  }

  var liveRegion = document.querySelector('[data-zp-status]');
  function announce(message) {
    if (!liveRegion) return;
    liveRegion.textContent = '';
    window.setTimeout(function () {
      liveRegion.textContent = message;
    }, 20);
  }

  function enableEnhancedControls() {
    document.querySelectorAll('[data-theme-toggle], [data-cmdk-open]').forEach(function (control) {
      control.disabled = false;
      control.removeAttribute('aria-disabled');
    });
  }

  enableEnhancedControls();

  // ===== Local date progressive enhancement =====
  function enhanceLocalDates() {
    if (!window.Intl || !Intl.DateTimeFormat) return;

    var formatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
    });

    document.querySelectorAll('time[data-zp-local-date]').forEach(function (time) {
      var value = time.getAttribute('datetime');
      var date = new Date(value);
      if (!value || Number.isNaN(date.getTime())) return;

      if (!time.getAttribute('title')) {
        time.setAttribute('title', value);
      }
      time.textContent = formatter.format(date);
    });
  }

  enhanceLocalDates();

  // ===== Theme toggle (initial system, then light / dark) =====
  function getStoredTheme() {
    try {
      var v = localStorage.getItem('zeropress-docs2-theme');
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) { return null; }
  }

  function getSystemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function getResolvedTheme() {
    return getStoredTheme() || getSystemTheme();
  }

  function updateThemeControls(resolved) {
    var currentLabel = resolved === 'dark' ? 'Dark theme' : 'Light theme';
    var nextLabel = resolved === 'dark' ? 'light theme' : 'dark theme';
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.setAttribute('aria-label', currentLabel + ' (click to switch to ' + nextLabel + ')');
      btn.setAttribute('title', 'Switch to ' + nextLabel);
    });
  }

  function setThemeAttributes(resolved) {
    var root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.themeResolved = resolved;
    updateThemeControls(resolved);
  }

  function applyTheme(theme) {
    var resolved = theme === 'dark' ? 'dark' : 'light';
    try {
      localStorage.setItem('zeropress-docs2-theme', resolved);
    } catch (e) {}
    setThemeAttributes(resolved);
  }

  setThemeAttributes(getResolvedTheme());

  document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var current = document.documentElement.dataset.themeResolved || getResolvedTheme();
      var next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });
  });
  // Re-resolve on system change only until the user chooses light or dark.
  if (window.matchMedia) {
    var mql = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      if (!getStoredTheme()) setThemeAttributes(getSystemTheme());
    };
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if (mql.addListener) mql.addListener(onChange);
  }

  // ===== Mobile nav close on link click =====
  var navToggle = document.getElementById('nav-toggle');
  var navTrigger = document.querySelector('[data-nav-trigger]');
  var sidebar = document.getElementById('site-sidebar');
  // Sidebar is off-canvas only at mobile widths; keep this in sync with the
  // `@media (max-width: 1023px)` breakpoint in style.css.
  var offCanvasQuery = window.matchMedia ? window.matchMedia('(max-width: 1023px)') : null;

  function syncNavState() {
    if (!navToggle || !navTrigger) return;
    navTrigger.setAttribute('aria-expanded', navToggle.checked ? 'true' : 'false');
    navTrigger.setAttribute('aria-label', navToggle.checked ? 'Close navigation' : 'Open navigation');
    syncSidebarInert();
  }
  function syncSidebarInert() {
    if (!sidebar) return;
    // Remove the closed off-canvas sidebar from the tab order and assistive
    // tech. On desktop the sidebar is always part of the page, so never inert.
    var isOffCanvas = offCanvasQuery ? offCanvasQuery.matches : false;
    var shouldDisable = isOffCanvas && !(navToggle && navToggle.checked);
    if (shouldDisable) {
      sidebar.setAttribute('inert', '');
      sidebar.setAttribute('aria-hidden', 'true');
    } else {
      sidebar.removeAttribute('inert');
      sidebar.removeAttribute('aria-hidden');
    }
  }
  if (offCanvasQuery) {
    var onOffCanvasChange = function () { syncSidebarInert(); };
    if (offCanvasQuery.addEventListener) offCanvasQuery.addEventListener('change', onOffCanvasChange);
    else if (offCanvasQuery.addListener) offCanvasQuery.addListener(onOffCanvasChange);
  }
  function setNavOpen(open) {
    if (!navToggle) return;
    navToggle.checked = open;
    navToggle.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (navToggle) {
    navToggle.addEventListener('change', syncNavState);
    syncNavState();
    if (navTrigger) {
      navTrigger.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        setNavOpen(!navToggle.checked);
      });
    }
    document.querySelectorAll('.sidebar__link').forEach(function (a) {
      a.addEventListener('click', function () {
        setNavOpen(false);
      });
    });
  }

  // ===== Sidebar collapsible group persistence =====
  var SIDEBAR_STATE_KEY = 'zeropress-docs2-sidebar';

  function normalizeSidebarState(value) {
    var state = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return state;
    Object.keys(value).forEach(function (groupId) {
      if (value[groupId] === 'open' || value[groupId] === 'closed') {
        state[groupId] = value[groupId];
      }
    });
    return state;
  }

  function readSidebarState() {
    try {
      var raw = localStorage.getItem(SIDEBAR_STATE_KEY);
      return normalizeSidebarState(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return normalizeSidebarState(null);
    }
  }

  function writeSidebarState(state) {
    try {
      localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  var sidebarState = readSidebarState();

  function setSidebarGroupState(groupId, value) {
    if (!groupId || (value !== 'open' && value !== 'closed')) return;
    sidebarState[groupId] = value;
    writeSidebarState(sidebarState);
  }

  document.querySelectorAll('.sidebar__group[data-group]').forEach(function (group) {
    var groupId = group.dataset.group;
    var stored = sidebarState[groupId];
    if (stored === 'closed') group.removeAttribute('open');
    else if (stored === 'open') group.setAttribute('open', '');

    if (!group.open && group.querySelector('[aria-current="page"], [data-current-parent="true"]')) {
      group.setAttribute('open', '');
      setSidebarGroupState(groupId, 'open');
    }

    group.addEventListener('toggle', function () {
      setSidebarGroupState(groupId, group.open ? 'open' : 'closed');
    });
  });
  document.documentElement.classList.add('sidebar-ready');
  var sidebarEarlyStyle = document.getElementById('zp-sidebar-state-style');
  if (sidebarEarlyStyle) sidebarEarlyStyle.remove();

  // ===== Heading anchor links =====
  var prose = document.querySelector('.prose');
  if (prose) {
    var anchorIcon = '<svg class="icon" width="14" height="14" aria-hidden="true"><use href="#icon-link"/></svg>';
    var anchorCheck = '<svg class="icon" width="14" height="14" aria-hidden="true"><use href="#icon-check"/></svg>';
    prose.querySelectorAll('h2[id], h3[id], h4[id]').forEach(function (heading) {
      if (heading.querySelector('.heading-anchor')) return;
      var a = document.createElement('a');
      a.className = 'heading-anchor';
      a.href = '#' + heading.id;
      a.setAttribute('aria-label', 'Copy link to ' + heading.textContent.trim());
      a.innerHTML = anchorIcon;
      a.addEventListener('click', function (e) {
        var url = window.location.origin + window.location.pathname + '#' + heading.id;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          e.preventDefault();
          navigator.clipboard.writeText(url).then(function () {
            a.classList.add('is-copied');
            a.innerHTML = anchorCheck;
            history.replaceState(null, '', '#' + heading.id);
            announce('Link copied.');
            setTimeout(function () {
              a.classList.remove('is-copied');
              a.innerHTML = anchorIcon;
            }, 1300);
          }).catch(function () {});
        }
      });
      heading.appendChild(a);
    });
  }

  // ===== Mermaid progressive enhancement =====
  var MERMAID_RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.min.js';
  var MERMAID_RUNTIME_INTEGRITY = 'sha384-yQ4mmBBT+vhTAwjFH0toJXNYJ6O4usWnt6EPIdWwrRvx2V/n5lXuDZQwQFeSFydF';
  var mermaidRuntimePromise = null;

  function mermaidTheme() {
    var resolved = document.documentElement.dataset.themeResolved;
    if (!resolved && window.matchMedia) {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return resolved === 'dark' ? 'dark' : 'default';
  }

  function getMermaidCodeBlocks() {
    return Array.prototype.slice.call(document.querySelectorAll('pre > code.language-mermaid, pre > code.lang-mermaid'));
  }

  function loadMermaidRuntime() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (mermaidRuntimePromise) return mermaidRuntimePromise;

    mermaidRuntimePromise = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-zp-mermaid-runtime]');
      if (existing) {
        existing.addEventListener('load', function () {
          if (window.mermaid) resolve(window.mermaid);
          else reject(new Error('Mermaid runtime loaded without exposing window.mermaid.'));
        }, { once: true });
        existing.addEventListener('error', function () {
          reject(new Error('Failed to load Mermaid runtime.'));
        }, { once: true });
        return;
      }

      var script = document.createElement('script');
      script.src = MERMAID_RUNTIME_URL;
      script.integrity = MERMAID_RUNTIME_INTEGRITY;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.dataset.zpMermaidRuntime = 'mermaid@11.15.0';
      script.addEventListener('load', function () {
        if (window.mermaid) resolve(window.mermaid);
        else reject(new Error('Mermaid runtime loaded without exposing window.mermaid.'));
      }, { once: true });
      script.addEventListener('error', function () {
        reject(new Error('Failed to load Mermaid runtime.'));
      }, { once: true });
      document.head.appendChild(script);
    });

    return mermaidRuntimePromise;
  }

  function prepareMermaidBlocks(blocks) {
    return blocks.map(function (code, index) {
      var pre = code.parentElement;
      var container = document.createElement('div');
      container.className = 'mermaid zp-mermaid';
      container.dataset.mermaidIndex = String(index + 1);
      container.textContent = code.textContent || '';
      pre.replaceWith(container);
      return { pre: pre, container: container };
    });
  }

  function renderMermaidBlocks() {
    var blocks = getMermaidCodeBlocks();
    if (!blocks.length) return;

    loadMermaidRuntime().then(function (mermaid) {
      var entries = prepareMermaidBlocks(blocks);
      if (!entries.length) return;

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: mermaidTheme(),
      });

      return Promise.resolve(mermaid.run({
        nodes: entries.map(function (entry) { return entry.container; }),
      })).catch(function (error) {
        entries.forEach(function (entry) {
          if (entry.container.isConnected) {
            entry.pre.classList.add('zp-mermaid-error');
            entry.container.replaceWith(entry.pre);
          }
        });
        console.warn('[zeropress] Mermaid rendering failed.', error);
      });
    }).catch(function (error) {
      console.warn('[zeropress] Mermaid runtime was not loaded; leaving code blocks unchanged.', error);
    });
  }

  renderMermaidBlocks();

  // ===== Code copy buttons + language labels =====
  var copyIcon = '<svg class="icon" width="14" height="14" aria-hidden="true"><use href="#icon-copy"/></svg>';

  document.querySelectorAll('pre > code').forEach(function (code) {
    var pre = code.closest('pre');
    if (!pre) return;

    // Language label: read first hljs-style language-* class on <code>
    if (!pre.dataset.language) {
      var match = (code.className || '').match(/(?:language|lang)-([\w-]+)/);
      if (match) {
        var lang = match[1].toLowerCase();
        pre.classList.add('language-' + lang);
        pre.dataset.language = lang;
      }
    }

    // Make horizontally scrollable code reachable by keyboard.
    if (!code.hasAttribute('tabindex')) {
      code.setAttribute('tabindex', '0');
      code.setAttribute('role', 'region');
      if (!code.hasAttribute('aria-label')) {
        code.setAttribute('aria-label', pre.dataset.language ? pre.dataset.language + ' code sample' : 'Code sample');
      }
    }

    if (pre.querySelector(':scope > .copy-btn')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.setAttribute('aria-label', 'Copy code');
    btn.innerHTML = copyIcon + '<span class="copy-btn__label">Copy</span>';
    var label = btn.querySelector('.copy-btn__label');
    var resetTimer;

    btn.addEventListener('click', function () {
      var text = code.innerText;
      if (!navigator.clipboard) {
        label.textContent = 'Unavailable';
        announce('Copy unavailable.');
        return;
      }
      navigator.clipboard.writeText(text).then(function () {
        window.clearTimeout(resetTimer);
        btn.classList.add('is-copied');
        btn.querySelector('.icon use').setAttribute('href', '#icon-check');
        label.textContent = 'Copied';
        announce('Code copied.');
        resetTimer = window.setTimeout(function () {
          btn.classList.remove('is-copied');
          btn.querySelector('.icon use').setAttribute('href', '#icon-copy');
          label.textContent = 'Copy';
        }, 1500);
      });
    });
    pre.appendChild(btn);
  });

  // ===== HTML document TOC progressive enhancement =====
  document.querySelectorAll('[data-enhance-toc]').forEach(function (toc) {
    var article = toc.closest('.article-grid') || document;
    var headings = Array.prototype.slice.call(article.querySelectorAll('.prose h2[id], .prose h3[id], .prose h4[id]'));
    if (!headings.length) return;

    var title = document.createElement('p');
    title.className = 'toc__title';
    title.textContent = 'On this page';

    var nav = document.createElement('nav');
    var listEl = document.createElement('ul');

    headings.forEach(function (heading) {
      var level = Number((heading.tagName || '').replace('H', '')) || 2;
      var item = document.createElement('li');
      var link = document.createElement('a');
      item.className = 'toc__item toc__item--level-' + level;
      link.href = '#' + heading.id;
      link.setAttribute('data-toc-link', '');
      link.textContent = heading.textContent.trim();
      item.appendChild(link);
      listEl.appendChild(item);
    });

    nav.appendChild(listEl);
    toc.appendChild(title);
    toc.appendChild(nav);
    toc.hidden = false;
  });

  // ===== TOC active section =====
  var tocLinks = document.querySelectorAll('[data-toc-link]');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var headings = [];
    tocLinks.forEach(function (link) {
      var id = (link.getAttribute('href') || '').replace('#', '');
      var el = id && document.getElementById(id);
      if (el) headings.push({ el: el, link: link });
    });
    var setActive = function (id) {
      tocLinks.forEach(function (l) {
        var li = l.parentElement;
        var match = (l.getAttribute('href') || '') === '#' + id;
        l.classList.toggle('is-active', match);
        if (li) li.classList.toggle('is-active', match);
      });
    };
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) setActive(entry.target.id);
      });
    }, { rootMargin: '0px 0px -70% 0px', threshold: 0 });
    headings.forEach(function (h) { observer.observe(h.el); });
  }

  // ===== Back to top / reading progress =====
  var backToTop = document.querySelector('[data-back-to-top]');
  if (backToTop) {
    var backToTopTicking = false;
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function updateBackToTop() {
      var doc = document.documentElement;
      var scrollTop = window.pageYOffset || doc.scrollTop || document.body.scrollTop || 0;
      var maxScroll = Math.max(1, doc.scrollHeight - window.innerHeight);
      var progress = Math.min(1, Math.max(0, scrollTop / maxScroll));
      var shouldShow = scrollTop > Math.min(420, window.innerHeight * 0.55) && maxScroll > 160;

      backToTop.style.setProperty('--scroll-progress-angle', (progress * 360).toFixed(1) + 'deg');
      backToTop.hidden = !shouldShow;
      backToTop.classList.toggle('is-visible', shouldShow);
      backToTopTicking = false;
    }

    function requestBackToTopUpdate() {
      if (backToTopTicking) return;
      backToTopTicking = true;
      window.requestAnimationFrame(updateBackToTop);
    }

    backToTop.addEventListener('click', function () {
      window.scrollTo({
        top: 0,
        behavior: reduceMotion ? 'auto' : 'smooth'
      });
    });
    window.addEventListener('scroll', requestBackToTopUpdate, { passive: true });
    window.addEventListener('resize', requestBackToTopUpdate);
    updateBackToTop();
  }

  // ===== Command palette =====
  var palette = document.querySelector('[data-cmdk]');
  if (!palette) {
    enableSmoothScrollAfterInitialNavigation();
    return;
  }
  var input = palette.querySelector('[data-cmdk-input]');
  var list = palette.querySelector('[data-cmdk-list]');
  var empty = palette.querySelector('[data-cmdk-empty]');
  var searchApiPromise;
  var renderTicket = 0;
  var previousFocus = null;

  function getPaletteFocusable() {
    return Array.prototype.slice.call(palette.querySelectorAll([
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(','))).filter(function (el) {
      return el.offsetParent !== null || el === input;
    });
  }

  function trapPaletteFocus(e) {
    var focusable = getPaletteFocusable();
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    var active = document.activeElement;

    if (e.shiftKey && (active === first || !palette.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function loadSearchApi() {
    if (!searchApiPromise) {
      searchApiPromise = import('/_zeropress/search.js');
    }
    return searchApiPromise;
  }

  function setEmpty(message) {
    empty.textContent = message;
    empty.hidden = false;
    if (input) {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
  }

  function clearActive() {
    list.querySelectorAll('a').forEach(function (item) {
      item.classList.remove('is-active');
      item.setAttribute('aria-selected', 'false');
    });
    if (input) input.removeAttribute('aria-activedescendant');
  }

  function setActiveOption(item) {
    clearActive();
    if (!item) return;
    item.classList.add('is-active');
    item.setAttribute('aria-selected', 'true');
    if (input && item.id) input.setAttribute('aria-activedescendant', item.id);
  }

  function toPlainText(value) {
    if (!value) return '';
    var template = document.createElement('template');
    template.innerHTML = String(value);
    return (template.content.textContent || '').trim();
  }

  function decodeHtmlEntities(value) {
    if (!value) return '';
    var textarea = document.createElement('textarea');
    textarea.innerHTML = String(value);
    return textarea.value.trim();
  }

  function getSearchExcerpt(row) {
    if (!row) return '';
    return decodeHtmlEntities(row.plain_excerpt) || toPlainText(row.excerpt) || '';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlightMatches(text, terms) {
    if (!text || !terms || !terms.length) return escapeHtml(text || '');
    var escaped = escapeHtml(text);
    // Sort longest first so "build-pages" matches before "build".
    var sorted = terms.slice().sort(function (a, b) { return b.length - a.length; });
    var pattern = sorted.map(escapeRegExp).join('|');
    var rx = new RegExp('(' + pattern + ')', 'gi');
    return escaped.replace(rx, '<mark>$1</mark>');
  }

  function tokenize(query) {
    return (query || '').toLowerCase()
      .split(/\s+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length >= 2; });
  }

  function buildSearchResultUrl(url, query) {
    if (!url || url === '#') return url || '#';
    try {
      var next = new URL(url, window.location.origin);
      if (next.origin !== window.location.origin) return url;
      next.searchParams.set('q', query);
      return next.pathname + next.search + next.hash;
    } catch (e) {
      return url;
    }
  }

  function uniqueTerms(terms) {
    var seen = {};
    return terms.filter(function (term) {
      if (seen[term]) return false;
      seen[term] = true;
      return true;
    });
  }

  function shouldSkipSearchHighlight(node) {
    var parent = node && node.parentElement;
    return !parent || Boolean(parent.closest([
      'script',
      'style',
      'textarea',
      'input',
      'button',
      'select',
      'pre',
      '.heading-anchor',
      '.copy-btn',
      '.cmdk',
      '.sidebar',
      '.top-bar',
      '.page-meta',
      '.pager',
      '.toc'
    ].join(',')));
  }

  var clearSearchButton = document.querySelector('[data-clear-search-highlights]');

  function clearSearchHighlights() {
    document.querySelectorAll('[data-search-hit]').forEach(function (mark) {
      var text = document.createTextNode(mark.textContent || '');
      var parent = mark.parentNode;
      mark.replaceWith(text);
      if (parent && parent.normalize) parent.normalize();
    });

    try {
      var url = new URL(window.location.href);
      url.searchParams.delete('q');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch (e) {
      // Ignore URL cleanup failures; the highlight removal has already happened.
    }

    if (clearSearchButton) clearSearchButton.hidden = true;

    var status = document.querySelector('[data-zp-status]');
    if (status) status.textContent = 'Search highlights cleared.';
  }

  function highlightSearchLanding() {
    var query;
    try {
      query = new URLSearchParams(window.location.search).get('q') || '';
    } catch (e) {
      query = '';
    }
    var terms = uniqueTerms(tokenize(query));
    if (!terms.length) return false;

    var root = document.querySelector('[data-pagefind-body]') || document.querySelector('.prose');
    if (!root) return false;

    var sorted = terms.slice().sort(function (a, b) { return b.length - a.length; });
    var rx = new RegExp('(' + sorted.map(escapeRegExp).join('|') + ')', 'gi');
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim() || shouldSkipSearchHighlight(node)) continue;
      if (rx.test(node.nodeValue)) nodes.push(node);
      rx.lastIndex = 0;
    }

    var firstHit = null;
    var hitCount = 0;
    var maxHits = 50;

    nodes.forEach(function (textNode) {
      if (hitCount >= maxHits) return;
      var text = textNode.nodeValue;
      var fragment = document.createDocumentFragment();
      var lastIndex = 0;
      var match;
      rx.lastIndex = 0;

      while ((match = rx.exec(text)) && hitCount < maxHits) {
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        var mark = document.createElement('mark');
        mark.className = 'search-hit';
        mark.dataset.searchHit = '';
        mark.textContent = match[0];
        fragment.appendChild(mark);
        if (!firstHit) firstHit = mark;
        hitCount += 1;
        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      textNode.parentNode.replaceChild(fragment, textNode);
    });

    if (firstHit) {
      firstHit.classList.add('is-current');
      if (clearSearchButton) clearSearchButton.hidden = false;
      window.setTimeout(function () {
        firstHit.scrollIntoView({
          block: 'center',
          behavior: 'auto'
        });
        enableSmoothScrollAfterInitialNavigation();
      }, 120);
      return true;
    }

    return false;
  }

  if (!highlightSearchLanding()) {
    enableSmoothScrollAfterInitialNavigation();
  }

  if (clearSearchButton) {
    clearSearchButton.addEventListener('click', clearSearchHighlights);
  }

  function renderResults(results, terms, query) {
    list.innerHTML = '';
    var first = null;

    results.forEach(function (entry, index) {
      var li = document.createElement('li');
      li.setAttribute('role', 'presentation');
      var a = document.createElement('a');
      a.href = buildSearchResultUrl(entry.url, query);
      a.className = 'cmdk__result';
      a.id = 'cmdk-option-' + index;
      a.setAttribute('role', 'option');
      a.setAttribute('aria-selected', 'false');
      var titleHtml = highlightMatches(entry.title, terms);
      var excerptHtml = entry.excerpt ? highlightMatches(entry.excerpt, terms) : '';
      a.innerHTML = '<span class="cmdk__result-title">' + titleHtml + '</span>' +
        (excerptHtml ? '<span class="cmdk__result-excerpt">' + excerptHtml + '</span>' : '');
      li.appendChild(a);
      list.appendChild(li);
      if (!first) first = a;
    });

    if (input) input.setAttribute('aria-expanded', results.length ? 'true' : 'false');
    if (first) setActiveOption(first);
  }

  function render(query) {
    var ticket = ++renderTicket;
    var q = (query || '').trim();
    list.innerHTML = '';

    if (!q) {
      setEmpty('Type to search.');
      return;
    }

    setEmpty('Searching...');
    var terms = tokenize(q);

    loadSearchApi()
      .then(function (api) {
        return api.search(q, { limit: 20 });
      })
      .then(function (searchResult) {
        if (ticket !== renderTicket) return;
        var rawResults = (searchResult && searchResult.results) || [];
        if (!rawResults.length) {
          list.innerHTML = '';
          setEmpty('No matches.');
          return;
        }
        return Promise.all(rawResults.map(function (r) { return r.data(); })).then(function (rows) {
          if (ticket !== renderTicket) return;
          var entries = rows.map(function (row) {
            var url = row.url || '#';
            var title = (row.meta && row.meta.title) || url;
            var excerpt = getSearchExcerpt(row);
            return {
              url: url,
              title: title,
              excerpt: excerpt
            };
          });
          empty.hidden = true;
          renderResults(entries, terms, q);
        });
      })
      .catch(function () {
        if (ticket !== renderTicket) return;
        list.innerHTML = '';
        setEmpty('Search index is unavailable.');
      });
  }

  function open(prefill) {
    if (palette.hidden) previousFocus = document.activeElement;
    palette.hidden = false;
    if (input) {
      input.value = prefill || '';
      setTimeout(function () { input.focus(); input.select(); }, 10);
    }
    render(prefill || '');
  }
  function close() {
    palette.hidden = true;
    if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
      try { previousFocus.focus({ preventScroll: true }); } catch (e) { previousFocus.focus(); }
    }
    previousFocus = null;
  }

  document.querySelectorAll('[data-cmdk-open]').forEach(function (btn) {
    btn.addEventListener('click', function () { open(); });
  });
  palette.querySelectorAll('[data-cmdk-close]').forEach(function (el) {
    el.addEventListener('click', close);
  });

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.hidden ? open() : close();
    } else if (!palette.hidden && e.key === 'Tab') {
      trapPaletteFocus(e);
    } else if (e.key === 'Escape' && !palette.hidden) {
      close();
    } else if (!palette.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      var items = Array.prototype.slice.call(list.querySelectorAll('a'));
      if (!items.length) return;
      var idx = items.findIndex(function (i) { return i.classList.contains('is-active'); });
      idx = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      setActiveOption(items[idx]);
      items[idx].scrollIntoView({ block: 'nearest' });
    } else if (!palette.hidden && e.key === 'Enter') {
      var active = list.querySelector('a.is-active');
      if (active) { e.preventDefault(); window.location.href = active.href; }
    } else if (palette.hidden && e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      var t = e.target;
      var inForm = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (!inForm) { e.preventDefault(); open(); }
    }
  });

  if (input) input.addEventListener('input', function () { render(input.value); });
})();
