/* ---------- Mobile nav toggle ---------- */

const liveRegion = document.querySelector('[data-zp-status]');

const announce = (message) => {
  if (!liveRegion) return;
  liveRegion.textContent = '';
  window.setTimeout(() => {
    liveRegion.textContent = message;
  }, 20);
};

// Read the preference live so it tracks OS changes made after page load.
const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const scrollBehavior = () => (prefersReducedMotion() ? 'auto' : 'smooth');

let smoothScrollEnhanced = false;
const enableSmoothScrollAfterInitialNavigation = () => {
  if (smoothScrollEnhanced) return;
  smoothScrollEnhanced = true;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.documentElement.classList.add('is-scroll-enhanced');
    });
  });
};

const navToggle = document.querySelector('#nav-toggle');
const navTrigger = document.querySelector('[data-nav-trigger]');
const navPanel = document.querySelector('[data-nav-panel]');
const navOverlay = document.querySelector('[data-nav-overlay]');

if (navToggle && navTrigger) {
  const mobileNavQuery = window.matchMedia('(max-width: 980px)');

  // Remove the collapsed mobile panel from the tab order and assistive tech.
  // On desktop the panel is always visible, so it is never inert there.
  const syncPanelInert = () => {
    if (!navPanel) return;
    const shouldDisable = mobileNavQuery.matches && !navToggle.checked;
    if (shouldDisable) {
      navPanel.setAttribute('inert', '');
      navPanel.setAttribute('aria-hidden', 'true');
    } else {
      navPanel.removeAttribute('inert');
      navPanel.removeAttribute('aria-hidden');
    }
  };

  const setNavOpen = (open) => {
    navToggle.checked = open;
    navTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    navTrigger.setAttribute('aria-label', open ? 'Close navigation' : 'Toggle navigation');
    syncPanelInert();
  };

  // The label toggles the checkbox natively; sync ARIA on change.
  navToggle.addEventListener('change', () => {
    setNavOpen(navToggle.checked);
  });

  // Once JS is active, avoid the label's native checkbox focus behavior; on
  // mobile Safari it can scroll the page toward the hidden checkbox.
  navTrigger.addEventListener('click', (event) => {
    event.preventDefault();
    setNavOpen(!navToggle.checked);
  });

  // Support keyboard activation on the label (Enter / Space).
  navTrigger.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setNavOpen(!navToggle.checked);
  });

  navOverlay?.addEventListener('click', (event) => {
    event.preventDefault();
    setNavOpen(false);
  });

  // Close the panel after following an in-page link.
  if (navPanel) {
    navPanel.addEventListener('click', (event) => {
      if (event.target instanceof HTMLAnchorElement) {
        setNavOpen(false);
      }
    });
  }

  // Escape closes the open mobile panel.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && navToggle.checked && mobileNavQuery.matches) {
      setNavOpen(false);
      navTrigger.focus();
    }
  });

  // Reset state when leaving the mobile breakpoint, and keep inert state in
  // sync when crossing the breakpoint in either direction.
  const onBreakpointChange = () => {
    if (!mobileNavQuery.matches) setNavOpen(false);
    else syncPanelInert();
  };
  if (mobileNavQuery.addEventListener) mobileNavQuery.addEventListener('change', onBreakpointChange);
  else if (mobileNavQuery.addListener) mobileNavQuery.addListener(onBreakpointChange);

  setNavOpen(navToggle.checked);
}

document.querySelectorAll('[data-cmdk-open]').forEach((control) => {
  control.disabled = false;
  control.removeAttribute('aria-disabled');
});

/* ---------- Theme toggle (light/dark) ---------- */

const themeToggle = document.querySelector('[data-theme-toggle]');

if (themeToggle) {
  const root = document.documentElement;
  const themeStorageKey = 'zeropress-docs1-theme';
  themeToggle.disabled = false;

  const getResolvedTheme = () => {
    const stored = root.dataset.theme;
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };

  themeToggle.addEventListener('click', () => {
    const next = getResolvedTheme() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem(themeStorageKey, next);
    } catch (e) {}
    window.dispatchEvent(new CustomEvent('zeropress:themechange', { detail: { theme: next } }));
  });
}

/* ---------- Local date progressive enhancement ---------- */

const enhanceLocalDates = () => {
  if (!window.Intl || !Intl.DateTimeFormat) return;

  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
  });

  document.querySelectorAll('time[data-zp-local-date]').forEach((time) => {
    const value = time.getAttribute('datetime');
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return;

    if (!time.getAttribute('title')) {
      time.setAttribute('title', value);
    }
    time.textContent = formatter.format(date);
  });
};

enhanceLocalDates();

/* ---------- Heading anchor links ---------- */

const proseForAnchors = document.querySelector('.prose');

if (proseForAnchors) {
  const anchorIcon = '<svg class="icon" width="14" height="14" aria-hidden="true"><use href="#icon-link"></use></svg>';
  const anchorCheckIcon = '<svg class="icon" width="14" height="14" aria-hidden="true"><use href="#icon-check"></use></svg>';

  proseForAnchors.querySelectorAll('h2[id], h3[id], h4[id]').forEach((heading) => {
    if (heading.querySelector('.heading-anchor')) return;

    const title = heading.textContent.trim();
    const link = document.createElement('a');
    link.className = 'heading-anchor';
    link.href = `#${heading.id}`;
    link.setAttribute('aria-label', `Copy link to section: ${title}`);
    link.innerHTML = anchorIcon;

    let resetTimer;
    link.addEventListener('click', (event) => {
      if (!navigator.clipboard?.writeText) return;
      event.preventDefault();
      const url = `${window.location.origin}${window.location.pathname}#${heading.id}`;
      navigator.clipboard.writeText(url).then(() => {
        window.history.replaceState(null, '', `#${heading.id}`);
        window.clearTimeout(resetTimer);
        link.classList.add('is-copied');
        link.innerHTML = anchorCheckIcon;
        announce('Link copied.');
        resetTimer = window.setTimeout(() => {
          link.classList.remove('is-copied');
          link.innerHTML = anchorIcon;
        }, 1300);
      }).catch(() => {});
    });

    heading.append(link);
  });
}

/* ---------- Table of contents scroll spy ---------- */

document.querySelectorAll('[data-enhance-toc]').forEach((toc) => {
  const layout = toc.closest('.doc-layout');
  const prose = layout?.querySelector('.prose');
  if (!layout || !prose) return;

  const headings = Array.from(prose.querySelectorAll('h2[id], h3[id], h4[id]'))
    .filter((heading) => heading.id && heading.textContent.trim());
  if (!headings.length) return;

  const title = document.createElement('p');
  title.className = 'doc-toc__title';
  title.textContent = 'On this page';

  const nav = document.createElement('nav');
  const list = document.createElement('ol');

  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1)) || 2;
    const item = document.createElement('li');
    const link = document.createElement('a');

    item.className = `doc-toc__item doc-toc__item--level-${level}`;
    link.href = `#${encodeURIComponent(heading.id)}`;
    link.dataset.docTocLink = '';
    link.textContent = heading.textContent.trim();

    item.append(link);
    list.append(item);
  }

  nav.append(list);
  toc.replaceChildren(title, nav);
  toc.hidden = false;
  layout.classList.add('doc-layout--with-toc');
});

const tocLinks = Array.from(document.querySelectorAll('[data-doc-toc-link]'));

if (tocLinks.length) {
  const decodeHashId = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const getHashId = (value) => {
    const hash = value || '';
    return hash.startsWith('#') ? decodeHashId(hash.slice(1)) : '';
  };

  const tocItems = tocLinks
    .map((link) => {
      const heading = document.getElementById(getHashId(link.getAttribute('href')));
      return heading ? { heading, link } : null;
    })
    .filter(Boolean);

  if (tocItems.length) {
    let activeId = '';
    let frameRequested = false;

    const anchorLine = () => (window.matchMedia('(max-width: 980px)').matches ? 160 : 120);

    const setActive = (id) => {
      if (!id || id === activeId) return;
      activeId = id;

      for (const item of tocItems) {
        const match = item.heading.id === id;
        item.link.classList.toggle('is-active', match);

        if (match) {
          item.link.setAttribute('aria-current', 'true');
          const toc = item.link.closest('.doc-toc');
          if (toc && toc.scrollHeight > toc.clientHeight) {
            item.link.scrollIntoView({ block: 'nearest' });
          }
        } else {
          item.link.removeAttribute('aria-current');
        }
      }
    };

    const updateActive = () => {
      frameRequested = false;
      let current = tocItems[0];
      const line = anchorLine();
      for (const item of tocItems) {
        if (item.heading.getBoundingClientRect().top <= line) {
          current = item;
        } else {
          break;
        }
      }
      setActive(current.heading.id);
    };

    const requestUpdate = () => {
      if (frameRequested) return;
      frameRequested = true;
      window.requestAnimationFrame(updateActive);
    };

    const setHashActive = () => {
      const hashId = getHashId(window.location.hash);
      const item = tocItems.find((entry) => entry.heading.id === hashId);
      if (item) setActive(item.heading.id);
    };

    setHashActive();
    requestUpdate();
    window.setTimeout(requestUpdate, 80);

    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);
    window.addEventListener('hashchange', () => {
      setHashActive();
      requestUpdate();
    });
  }
}

/* ---------- Mermaid progressive enhancement ---------- */

const mermaidRuntimeUrl = 'https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.min.js';
const mermaidRuntimeIntegrity = 'sha384-yQ4mmBBT+vhTAwjFH0toJXNYJ6O4usWnt6EPIdWwrRvx2V/n5lXuDZQwQFeSFydF';
let mermaidRuntimePromise = null;

const getMermaidCodeBlocks = () =>
  Array.from(document.querySelectorAll('pre > code.language-mermaid, pre > code.lang-mermaid'));

const getMermaidTheme = () => {
  const explicitTheme = document.documentElement.dataset.theme;
  if (explicitTheme === 'dark') return 'dark';
  if (explicitTheme === 'light') return 'default';
  if (!window.matchMedia) return 'default';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';
};

const loadMermaidRuntime = () => {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidRuntimePromise) return mermaidRuntimePromise;

  mermaidRuntimePromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-zp-mermaid-runtime]');
    if (existing) {
      existing.addEventListener('load', () => {
        if (window.mermaid) resolve(window.mermaid);
        else reject(new Error('Mermaid runtime loaded without exposing window.mermaid.'));
      }, { once: true });
      existing.addEventListener('error', () => {
        reject(new Error('Failed to load Mermaid runtime.'));
      }, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = mermaidRuntimeUrl;
    script.integrity = mermaidRuntimeIntegrity;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.dataset.zpMermaidRuntime = 'mermaid@11.15.0';
    script.addEventListener('load', () => {
      if (window.mermaid) resolve(window.mermaid);
      else reject(new Error('Mermaid runtime loaded without exposing window.mermaid.'));
    }, { once: true });
    script.addEventListener('error', () => {
      reject(new Error('Failed to load Mermaid runtime.'));
    }, { once: true });
    document.head.append(script);
  });

  return mermaidRuntimePromise;
};

const prepareMermaidBlocks = (blocks) =>
  blocks.map((code, index) => {
    const pre = code.parentElement;
    const source = code.textContent || '';
    const container = document.createElement('div');
    container.className = 'mermaid zp-mermaid';
    container.dataset.mermaidIndex = String(index + 1);
    container.dataset.mermaidSource = source;
    container.textContent = source;
    pre.replaceWith(container);
    return { pre, container };
  });

const watchMermaidThemeChanges = (handler) => {
  window.addEventListener('zeropress:themechange', handler);

  if (!window.matchMedia) return;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  if (query.addEventListener) query.addEventListener('change', handler);
  else if (query.addListener) query.addListener(handler);
};

const renderMermaidBlocks = () => {
  const blocks = getMermaidCodeBlocks();
  if (!blocks.length) return;

  loadMermaidRuntime().then((mermaid) => {
    const entries = prepareMermaidBlocks(blocks);
    if (!entries.length) return;

    const runMermaid = () => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: getMermaidTheme(),
      });

      return Promise.resolve(mermaid.run({
        nodes: entries
          .filter((entry) => entry.container.isConnected)
          .map((entry) => entry.container),
      }));
    };

    let rerenderScheduled = false;
    const rerenderForTheme = () => {
      if (rerenderScheduled) return;
      rerenderScheduled = true;

      window.setTimeout(() => {
        rerenderScheduled = false;
        entries.forEach((entry) => {
          if (!entry.container.isConnected) return;
          entry.container.removeAttribute('data-processed');
          entry.container.textContent = entry.container.dataset.mermaidSource || '';
        });
        runMermaid().catch((error) => {
          console.warn('[zeropress] Mermaid re-render after theme change failed.', error);
        });
      }, 0);
    };

    return runMermaid().then(() => {
      watchMermaidThemeChanges(rerenderForTheme);
    }).catch((error) => {
      entries.forEach((entry) => {
        if (entry.container.isConnected) {
          entry.pre.classList.add('zp-mermaid-error');
          entry.container.replaceWith(entry.pre);
        }
      });
      console.warn('[zeropress] Mermaid rendering failed.', error);
    });
  }).catch((error) => {
    console.warn('[zeropress] Mermaid runtime was not loaded; leaving code blocks unchanged.', error);
  });
};

renderMermaidBlocks();

/* ---------- Code copy buttons + language labels ---------- */

const codeCopyIcon = '<svg class="icon" width="14" height="14" aria-hidden="true"><use href="#icon-copy"></use></svg>';

const writeClipboardText = (text) => {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.inset = '0 auto auto 0';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();

    try {
      const copied = document.execCommand('copy');
      textarea.remove();
      copied ? resolve() : reject(new Error('Copy command was not accepted.'));
    } catch (error) {
      textarea.remove();
      reject(error);
    }
  });
};

const isMermaidCodeBlock = (code) =>
  code.classList.contains('language-mermaid') || code.classList.contains('lang-mermaid');

document.querySelectorAll('pre > code').forEach((code) => {
  const pre = code.closest('pre');
  if (!pre || isMermaidCodeBlock(code)) return;

  const match = (code.className || '').match(/(?:language|lang)-([\w-]+)/);
  if (match && !pre.dataset.language) {
    pre.dataset.language = match[1].toLowerCase();
  }

  pre.classList.add('has-code-tools');

  if (!code.hasAttribute('tabindex')) {
    code.setAttribute('tabindex', '0');
    code.setAttribute('role', 'region');
    code.setAttribute('aria-label', pre.dataset.language ? `${pre.dataset.language} code sample` : 'Code sample');
  }

  if (pre.querySelector(':scope > .copy-btn')) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-btn';
  button.setAttribute('aria-label', 'Copy code');
  button.innerHTML = `${codeCopyIcon}<span class="copy-btn__label">Copy</span>`;

  let resetTimer;
  button.addEventListener('click', () => {
    const label = button.querySelector('.copy-btn__label');
    writeClipboardText(code.textContent || '').then(() => {
      window.clearTimeout(resetTimer);
      button.classList.add('is-copied');
      button.querySelector('.icon use').setAttribute('href', '#icon-check');
      if (label) label.textContent = 'Copied';
      announce('Code copied.');
      resetTimer = window.setTimeout(() => {
        button.classList.remove('is-copied');
        button.querySelector('.icon use').setAttribute('href', '#icon-copy');
        if (label) label.textContent = 'Copy';
      }, 1500);
    }).catch(() => {
      if (label) label.textContent = 'Unavailable';
      announce('Copy unavailable.');
    });
  });

  pre.append(button);
});

/* ---------- Back to top / reading progress ---------- */

const backToTop = document.querySelector('[data-back-to-top]');

if (backToTop) {
  let backToTopTicking = false;

  const updateBackToTop = () => {
    const doc = document.documentElement;
    const scrollTop = window.pageYOffset || doc.scrollTop || document.body.scrollTop || 0;
    const maxScroll = Math.max(1, doc.scrollHeight - window.innerHeight);
    const progress = Math.min(1, Math.max(0, scrollTop / maxScroll));
    const shouldShow = scrollTop > Math.min(420, window.innerHeight * 0.55) && maxScroll > 160;

    backToTop.style.setProperty('--scroll-progress-angle', `${(progress * 360).toFixed(1)}deg`);
    backToTop.hidden = !shouldShow;
    backToTop.classList.toggle('is-visible', shouldShow);
    backToTopTicking = false;
  };

  const requestBackToTopUpdate = () => {
    if (backToTopTicking) return;
    backToTopTicking = true;
    window.requestAnimationFrame(updateBackToTop);
  };

  backToTop.addEventListener('click', () => {
    window.scrollTo({
      top: 0,
      behavior: scrollBehavior(),
    });
  });
  window.addEventListener('scroll', requestBackToTopUpdate, { passive: true });
  window.addEventListener('resize', requestBackToTopUpdate);
  updateBackToTop();
}

/* ---------- Command palette search ---------- */

(() => {
  const palette = document.querySelector('[data-cmdk]');
  if (!palette) {
    enableSmoothScrollAfterInitialNavigation();
    return;
  }

  const input = palette.querySelector('[data-cmdk-input]');
  const list = palette.querySelector('[data-cmdk-list]');
  const empty = palette.querySelector('[data-cmdk-empty]');
  const clearSearchButton = document.querySelector('[data-clear-search-highlights]');
  let searchApiPromise;
  let renderTicket = 0;
  let previousFocus = null;

  const getPaletteFocusable = () =>
    Array.from(palette.querySelectorAll([
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(','))).filter((element) => element.offsetParent !== null || element === input);

  const trapPaletteFocus = (event) => {
    const focusable = getPaletteFocusable();
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !palette.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const loadSearchApi = () => {
    searchApiPromise ||= import('/_zeropress/search.js');
    return searchApiPromise;
  };

  const setEmpty = (message) => {
    empty.textContent = message;
    empty.hidden = false;
    if (input) {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
  };

  const clearActive = () => {
    list.querySelectorAll('a').forEach((item) => {
      item.classList.remove('is-active');
      item.setAttribute('aria-selected', 'false');
    });
    input?.removeAttribute('aria-activedescendant');
  };

  const setActiveOption = (item) => {
    clearActive();
    if (!item) return;
    item.classList.add('is-active');
    item.setAttribute('aria-selected', 'true');
    if (input && item.id) input.setAttribute('aria-activedescendant', item.id);
  };

  const toPlainText = (value) => {
    if (!value) return '';
    const template = document.createElement('template');
    template.innerHTML = String(value);
    return (template.content.textContent || '').trim();
  };

  const decodeHtmlEntities = (value) => {
    if (!value) return '';
    const textarea = document.createElement('textarea');
    textarea.innerHTML = String(value);
    return textarea.value.trim();
  };

  const getSearchExcerpt = (row) => {
    if (!row) return '';
    return decodeHtmlEntities(row.plain_excerpt) || toPlainText(row.excerpt) || '';
  };

  const escapeHtml = (value) =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const tokenize = (query) =>
    (query || '')
      .toLowerCase()
      .split(/\s+/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length >= 2);

  const uniqueTerms = (terms) => {
    const seen = new Set();
    return terms.filter((term) => {
      if (seen.has(term)) return false;
      seen.add(term);
      return true;
    });
  };

  const highlightMatches = (text, terms) => {
    if (!text || !terms?.length) return escapeHtml(text || '');
    const escaped = escapeHtml(text);
    const sorted = terms.slice().sort((a, b) => b.length - a.length);
    const pattern = sorted.map(escapeRegExp).join('|');
    const rx = new RegExp(`(${pattern})`, 'gi');
    return escaped.replace(rx, '<mark>$1</mark>');
  };

  const buildSearchResultUrl = (url, query) => {
    if (!url || url === '#') return url || '#';
    try {
      const next = new URL(url, window.location.origin);
      if (next.origin !== window.location.origin) return url;
      next.searchParams.set('q', query);
      return `${next.pathname}${next.search}${next.hash}`;
    } catch {
      return url;
    }
  };

  const shouldSkipSearchHighlight = (node) => {
    const parent = node?.parentElement;
    return !parent || Boolean(parent.closest([
      'script',
      'style',
      'textarea',
      'input',
      'button',
      'select',
      'pre',
      '.copy-btn',
      '.heading-anchor',
      '.cmdk',
      '.site-header',
      '.site-footer',
      '.doc-toc',
      '.doc-meta',
      '.pager',
    ].join(',')));
  };

  const clearSearchHighlights = () => {
    document.querySelectorAll('[data-search-hit]').forEach((mark) => {
      const text = document.createTextNode(mark.textContent || '');
      const parent = mark.parentNode;
      mark.replaceWith(text);
      if (parent?.normalize) parent.normalize();
    });

    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('q');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // Highlight removal already succeeded.
    }

    if (clearSearchButton) clearSearchButton.hidden = true;
    announce('Search highlights cleared.');
  };

  const highlightSearchLanding = () => {
    let query = '';
    try {
      query = new URLSearchParams(window.location.search).get('q') || '';
    } catch {
      query = '';
    }

    const terms = uniqueTerms(tokenize(query));
    if (!terms.length) return false;

    const root = document.querySelector('[data-pagefind-body]') || document.querySelector('.prose');
    if (!root) return false;

    const sorted = terms.slice().sort((a, b) => b.length - a.length);
    const rx = new RegExp(`(${sorted.map(escapeRegExp).join('|')})`, 'gi');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;

    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim() || shouldSkipSearchHighlight(node)) continue;
      if (rx.test(node.nodeValue)) nodes.push(node);
      rx.lastIndex = 0;
    }

    let firstHit = null;
    let hitCount = 0;
    const maxHits = 50;

    nodes.forEach((textNode) => {
      if (hitCount >= maxHits) return;
      const text = textNode.nodeValue;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match;
      rx.lastIndex = 0;

      while ((match = rx.exec(text)) && hitCount < maxHits) {
        if (match.index > lastIndex) {
          fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const mark = document.createElement('mark');
        mark.className = 'search-hit';
        mark.dataset.searchHit = '';
        mark.textContent = match[0];
        fragment.append(mark);
        if (!firstHit) firstHit = mark;
        hitCount += 1;
        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < text.length) {
        fragment.append(document.createTextNode(text.slice(lastIndex)));
      }

      textNode.parentNode.replaceChild(fragment, textNode);
    });

    if (firstHit) {
      firstHit.classList.add('is-current');
      if (clearSearchButton) clearSearchButton.hidden = false;
      window.setTimeout(() => {
        firstHit.scrollIntoView({
          block: 'center',
          behavior: 'auto',
        });
        enableSmoothScrollAfterInitialNavigation();
      }, 120);
      return true;
    }

    return false;
  };

  const renderResults = (results, terms, query) => {
    list.innerHTML = '';
    let first = null;

    results.forEach((entry, index) => {
      const li = document.createElement('li');
      const link = document.createElement('a');
      const titleHtml = highlightMatches(entry.title, terms);
      const excerptHtml = entry.excerpt ? highlightMatches(entry.excerpt, terms) : '';

      li.setAttribute('role', 'presentation');
      link.href = buildSearchResultUrl(entry.url, query);
      link.className = 'cmdk__result';
      link.id = `cmdk-option-${index}`;
      link.setAttribute('role', 'option');
      link.setAttribute('aria-selected', 'false');
      link.innerHTML = `<span class="cmdk__result-title">${titleHtml}</span>` +
        (excerptHtml ? `<span class="cmdk__result-excerpt">${excerptHtml}</span>` : '');

      li.append(link);
      list.append(li);
      if (!first) first = link;
    });

    input?.setAttribute('aria-expanded', results.length ? 'true' : 'false');
    if (first) setActiveOption(first);
  };

  const render = (query) => {
    const ticket = ++renderTicket;
    const q = (query || '').trim();
    list.innerHTML = '';

    if (!q) {
      setEmpty('Type to search.');
      return;
    }

    setEmpty('Searching...');
    const terms = tokenize(q);

    loadSearchApi()
      .then((api) => api.search(q, { limit: 20 }))
      .then((searchResult) => {
        if (ticket !== renderTicket) return null;
        const rawResults = searchResult?.results || [];
        if (!rawResults.length) {
          list.innerHTML = '';
          setEmpty('No matches.');
          return null;
        }
        return Promise.all(rawResults.map((result) => result.data())).then((rows) => {
          if (ticket !== renderTicket) return;
          const entries = rows.map((row) => {
            const url = row.url || '#';
            return {
              url,
              title: row.meta?.title || url,
              excerpt: getSearchExcerpt(row),
            };
          });
          empty.hidden = true;
          renderResults(entries, terms, q);
        });
      })
      .catch(() => {
        if (ticket !== renderTicket) return;
        list.innerHTML = '';
        setEmpty('Search index is unavailable.');
      });
  };

  const open = (prefill = '') => {
    if (palette.hidden) previousFocus = document.activeElement;
    if (navToggle?.checked) {
      navToggle.checked = false;
      navToggle.dispatchEvent(new Event('change', { bubbles: true }));
    }
    palette.hidden = false;
    if (input) {
      input.value = prefill;
      window.setTimeout(() => {
        input.focus();
        input.select();
      }, 10);
    }
    render(prefill);
  };

  const close = () => {
    palette.hidden = true;
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {
        previousFocus.focus();
      }
    }
    previousFocus = null;
  };

  if (!highlightSearchLanding()) {
    enableSmoothScrollAfterInitialNavigation();
  }

  clearSearchButton?.addEventListener('click', clearSearchHighlights);

  document.querySelectorAll('[data-cmdk-open]').forEach((button) => {
    button.addEventListener('click', () => open());
  });

  palette.querySelectorAll('[data-cmdk-close]').forEach((element) => {
    element.addEventListener('click', close);
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      palette.hidden ? open() : close();
    } else if (!palette.hidden && event.key === 'Tab') {
      trapPaletteFocus(event);
    } else if (event.key === 'Escape' && !palette.hidden) {
      close();
    } else if (!palette.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const items = Array.from(list.querySelectorAll('a'));
      if (!items.length) return;
      let index = items.findIndex((item) => item.classList.contains('is-active'));
      index = event.key === 'ArrowDown'
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
      setActiveOption(items[index]);
      items[index].scrollIntoView({ block: 'nearest' });
    } else if (!palette.hidden && event.key === 'Enter') {
      const active = list.querySelector('a.is-active');
      if (active) {
        event.preventDefault();
        window.location.href = active.href;
      }
    } else if (palette.hidden && event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const target = event.target;
      const inForm = target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (!inForm) {
        event.preventDefault();
        open();
      }
    }
  });

  input?.addEventListener('input', () => {
    render(input.value);
  });
})();
