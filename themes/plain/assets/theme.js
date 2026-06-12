(function () {
  'use strict';

  var prose = document.querySelector('.prose');

  var liveRegion = null;

  function announce(message) {
    if (!liveRegion) {
      liveRegion = document.createElement('div');
      liveRegion.className = 'visually-hidden';
      liveRegion.setAttribute('role', 'status');
      liveRegion.setAttribute('aria-live', 'polite');
      document.body.appendChild(liveRegion);
    }
    liveRegion.textContent = '';
    window.setTimeout(function () {
      liveRegion.textContent = message;
    }, 20);
  }

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

  function addHeadingAnchors() {
    if (!prose) return;

    prose.querySelectorAll('h2[id], h3[id], h4[id]').forEach(function (heading) {
      if (heading.querySelector('.heading-anchor')) return;

      var anchor = document.createElement('a');
      anchor.className = 'heading-anchor';
      anchor.href = '#' + heading.id;
      anchor.setAttribute('aria-label', 'Link to ' + heading.textContent.trim());
      anchor.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>';
      heading.appendChild(anchor);
    });
  }

  var COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  var CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  function writeClipboardText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }

    return new Promise(function (resolve, reject) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '0';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        var copied = document.execCommand('copy');
        textarea.remove();
        copied ? resolve() : reject(new Error('Copy command was not accepted.'));
      } catch (error) {
        textarea.remove();
        reject(error);
      }
    });
  }

  function isMermaidCode(code) {
    return /(?:^|\s)(?:language|lang)-mermaid(?:\s|$)/.test(code.className || '');
  }

  function enhanceCodeBlocks() {
    if (!prose) return;

    prose.querySelectorAll('pre > code').forEach(function (code) {
      var pre = code.parentElement;
      if (!pre || isMermaidCode(code)) return;

      if (!code.hasAttribute('tabindex')) {
        var match = (code.className || '').match(/(?:language|lang)-([\w-]+)/);
        var label = match ? match[1].toLowerCase() + ' code sample' : 'Code sample';
        code.setAttribute('tabindex', '0');
        code.setAttribute('role', 'region');
        code.setAttribute('aria-label', label);
      }

      if (pre.querySelector(':scope > .copy-btn')) return;

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-btn';
      button.setAttribute('aria-label', 'Copy code');
      button.innerHTML = COPY_ICON + '<span class="copy-btn__label">Copy</span>';

      var resetTimer;
      button.addEventListener('click', function () {
        var labelEl = button.querySelector('.copy-btn__label');
        writeClipboardText(code.textContent || '').then(function () {
          window.clearTimeout(resetTimer);
          button.classList.add('is-copied');
          button.innerHTML = CHECK_ICON + '<span class="copy-btn__label">Copied</span>';
          announce('Code copied.');
          resetTimer = window.setTimeout(function () {
            button.classList.remove('is-copied');
            button.innerHTML = COPY_ICON + '<span class="copy-btn__label">Copy</span>';
          }, 1500);
        }).catch(function () {
          if (labelEl) labelEl.textContent = 'Copy failed';
          announce('Copy failed.');
        });
      });

      pre.appendChild(button);
    });
  }

  var MERMAID_RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.min.js';
  var MERMAID_RUNTIME_INTEGRITY = 'sha384-yQ4mmBBT+vhTAwjFH0toJXNYJ6O4usWnt6EPIdWwrRvx2V/n5lXuDZQwQFeSFydF';
  var mermaidRuntimePromise = null;

  function getMermaidCodeBlocks() {
    return Array.prototype.slice.call(document.querySelectorAll('pre > code.language-mermaid, pre > code.lang-mermaid'));
  }

  function getMermaidRuntime() {
    return window.mermaid &&
      typeof window.mermaid.initialize === 'function' &&
      typeof window.mermaid.run === 'function'
      ? window.mermaid
      : null;
  }

  function loadMermaidRuntime() {
    var runtime = getMermaidRuntime();
    if (runtime) return Promise.resolve(runtime);
    if (mermaidRuntimePromise) return mermaidRuntimePromise;

    mermaidRuntimePromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = MERMAID_RUNTIME_URL;
      script.integrity = MERMAID_RUNTIME_INTEGRITY;
      script.crossOrigin = 'anonymous';
      script.async = true;
      script.dataset.zpMermaidRuntime = 'mermaid@11.15.0';
      script.addEventListener('load', function () {
        var loadedRuntime = getMermaidRuntime();
        if (loadedRuntime) resolve(loadedRuntime);
        else reject(new Error('Mermaid runtime loaded without exposing window.mermaid.'));
      }, { once: true });
      script.addEventListener('error', function () {
        reject(new Error('Failed to load Mermaid runtime.'));
      }, { once: true });
      document.head.appendChild(script);
    });

    return mermaidRuntimePromise;
  }

  function mermaidTheme() {
    if (!window.matchMedia) return 'default';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';
  }

  function watchColorSchemeChanges(handler) {
    if (!window.matchMedia) return;
    var query = window.matchMedia('(prefers-color-scheme: dark)');
    if (query.addEventListener) query.addEventListener('change', handler);
    else if (query.addListener) query.addListener(handler);
  }

  function renderMermaidBlocks() {
    var blocks = getMermaidCodeBlocks();
    if (!blocks.length) return;

    loadMermaidRuntime().then(function (mermaid) {
      var containers = blocks.map(function (code, index) {
        var pre = code.parentElement;
        var source = code.textContent || '';
        var container = document.createElement('div');
        container.className = 'mermaid zp-mermaid';
        container.dataset.mermaidIndex = String(index + 1);
        container.dataset.mermaidSource = source;
        container.textContent = source;
        pre.replaceWith(container);
        return { pre: pre, container: container };
      });

      function runMermaid() {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: mermaidTheme(),
        });

        return Promise.resolve(mermaid.run({
          nodes: containers
            .filter(function (entry) { return entry.container.isConnected; })
            .map(function (entry) { return entry.container; }),
        }));
      }

      var rerenderScheduled = false;
      function rerenderForColorScheme() {
        if (rerenderScheduled) return;
        rerenderScheduled = true;
        window.setTimeout(function () {
          rerenderScheduled = false;
          containers.forEach(function (entry) {
            if (!entry.container.isConnected) return;
            entry.container.removeAttribute('data-processed');
            entry.container.textContent = entry.container.dataset.mermaidSource || '';
          });
          runMermaid().catch(function (error) {
            console.warn('[zeropress] Mermaid re-render after color scheme change failed.', error);
          });
        }, 0);
      }

      return runMermaid().then(function () {
        watchColorSchemeChanges(rerenderForColorScheme);
      }).catch(function (error) {
        containers.forEach(function (entry) {
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

  enhanceLocalDates();
  addHeadingAnchors();
  enhanceCodeBlocks();
  renderMermaidBlocks();
}());
