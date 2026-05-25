/* ---------- Sticky header scrolled state ---------- */

const siteHeader = document.querySelector('.site-header');

if (siteHeader) {
  let lastScrolled = false;
  const updateHeader = () => {
    const scrolled = window.scrollY > 4;
    if (scrolled !== lastScrolled) {
      siteHeader.classList.toggle('is-scrolled', scrolled);
      lastScrolled = scrolled;
    }
  };
  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });
}

/* ---------- Mobile nav toggle ---------- */

const navToggle = document.querySelector('[data-nav-toggle]');
const navPanel = document.querySelector('[data-nav-panel]');

if (navToggle && navPanel) {
  const closeNav = () => {
    navPanel.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
  };

  navToggle.addEventListener('click', () => {
    const open = !navPanel.classList.contains('is-open');
    navPanel.classList.toggle('is-open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  navPanel.addEventListener('click', (event) => {
    if (event.target instanceof HTMLAnchorElement) {
      closeNav();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 820) {
      closeNav();
    }
  });
}

/* ---------- Theme toggle (light/dark) ---------- */

const themeToggle = document.querySelector('[data-theme-toggle]');

if (themeToggle) {
  const root = document.documentElement;

  const getResolvedTheme = () => {
    const stored = root.dataset.theme;
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };

  themeToggle.addEventListener('click', () => {
    const next = getResolvedTheme() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('zp-theme', next);
    } catch (e) {}
  });
}

/* ---------- Highlight active primary nav link ---------- */

const primaryLinks = Array.from(document.querySelectorAll('.site-nav a'));

if (primaryLinks.length) {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  let bestMatch = null;
  let bestScore = -1;

  for (const link of primaryLinks) {
    let href;
    try {
      href = new URL(link.href, window.location.origin).pathname.replace(/\/+$/, '') || '/';
    } catch {
      continue;
    }

    if (href === '/' && path !== '/') continue;
    if (path === href || path.startsWith(href + '/')) {
      if (href.length > bestScore) {
        bestScore = href.length;
        bestMatch = link;
      }
    }
  }

  if (bestMatch) {
    bestMatch.setAttribute('aria-current', 'page');
  }
}

/* ---------- Table of contents scroll spy ---------- */

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

    const anchorLine = () => (window.matchMedia('(max-width: 860px)').matches ? 160 : 120);

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

/* ---------- Search ---------- */

const searchRoot = document.querySelector('[data-site-search]');

if (searchRoot) {
  const form = searchRoot.querySelector('[data-site-search-form]');
  const input = searchRoot.querySelector('[data-site-search-input]');
  const submit = searchRoot.querySelector('[data-site-search-submit]');
  const panel = searchRoot.querySelector('[data-site-search-panel]');
  const status = searchRoot.querySelector('[data-site-search-status]');
  const resultsList = searchRoot.querySelector('[data-site-search-results]');
  let searchApiPromise;
  let debounceTimer;
  let requestId = 0;

  const loadSearchApi = () => {
    searchApiPromise ||= import('/_zeropress/search.js');
    return searchApiPromise;
  };

  const clearResults = () => {
    resultsList.replaceChildren();
  };

  const showPanel = () => {
    panel.hidden = false;
  };

  const hidePanel = () => {
    panel.hidden = true;
  };

  const setStatus = (message) => {
    status.textContent = message;
  };

  input.disabled = false;
  if (submit) submit.disabled = false;
  setStatus('Type at least two characters.');

  const renderResults = async (items) => {
    clearResults();
    if (!items.length) {
      setStatus('No results found.');
      return;
    }

    setStatus(`${items.length} result${items.length === 1 ? '' : 's'} found.`);
    const fragment = document.createDocumentFragment();

    for (const item of items) {
      const data = await item.data();
      const title = data.meta?.title || data.url;
      const excerpt = data.plain_excerpt || data.excerpt || '';
      const listItem = document.createElement('li');
      const link = document.createElement('a');
      const meta = document.createElement('span');
      const summary = document.createElement('p');

      link.href = data.url;
      link.textContent = title;
      meta.textContent = data.meta?.type || 'page';
      summary.textContent = excerpt;

      listItem.append(link, meta, summary);
      fragment.append(listItem);
    }

    resultsList.append(fragment);
  };

  const runSearch = async () => {
    const query = input.value.trim();
    const currentRequest = ++requestId;
    showPanel();

    if (query.length < 2) {
      clearResults();
      setStatus('Type at least two characters.');
      return;
    }

    setStatus('Searching...');
    clearResults();

    try {
      const searchApi = await loadSearchApi();
      const response = await searchApi.search(query, { limit: 8 });
      if (currentRequest === requestId) {
        await renderResults(response.results || []);
      }
    } catch {
      if (currentRequest === requestId) {
        clearResults();
        setStatus('Search is not available for this build.');
      }
    }
  };

  input.addEventListener('input', () => {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(runSearch, 160);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim()) {
      showPanel();
    }
  });

  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      runSearch();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hidePanel();
      input.blur();
      return;
    }

    // Slash to focus search (when not in another input)
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const target = event.target;
      const isFormField = target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (!isFormField) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    }
  });

  document.addEventListener('click', (event) => {
    if (!searchRoot.contains(event.target)) {
      hidePanel();
    }
  });
}
