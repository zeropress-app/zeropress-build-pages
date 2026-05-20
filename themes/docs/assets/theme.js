const searchRoot = document.querySelector('[data-site-search]');

if (searchRoot) {
  const form = searchRoot.querySelector('[data-site-search-form]');
  const input = searchRoot.querySelector('[data-site-search-input]');
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

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hidePanel();
      input.blur();
    }
  });

  document.addEventListener('click', (event) => {
    if (!searchRoot.contains(event.target)) {
      hidePanel();
    }
  });
}
