// AI in Chrome: accessibility-tree snapshot with stable element refs (ref_N).
// Runs in the extension's isolated world; background.js calls window.__aichromeTree / __aichromeRef.
(() => {
  if (window.__aichromeAnnotate) return; // (checks the newest function, so a page holding an older copy gets this one)

  // Keep refs across a re-injection (an older copy of this script may already have handed some out).
  const refs = window.__aichromeRefs || new Map(); // ref -> WeakRef<Element>
  const reverse = window.__aichromeReverse || new WeakMap(); // Element -> ref
  window.__aichromeRefs = refs;
  window.__aichromeReverse = reverse;
  let counter = window.__aichromeCounter || 0;
  const MAX_CHARS = 50000;

  // Count DOM changes so a click can report whether the page reacted.
  let mutations = 0;
  try {
    new MutationObserver((list) => {
      for (const m of list) mutations += m.addedNodes.length + m.removedNodes.length + (m.type === 'attributes' ? 1 : 0);
    }).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['open', 'aria-expanded', 'aria-checked', 'aria-pressed', 'aria-hidden', 'hidden', 'disabled'],
    });
  } catch {}

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head']);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem',
  ]);
  const TAG_ROLES = {
    button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', nav: 'navigation',
    main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', form: 'form',
    dialog: 'dialog', ul: 'list', ol: 'list', li: 'listitem', table: 'table', tr: 'row',
    th: 'columnheader', td: 'cell', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
    h5: 'heading', h6: 'heading', p: 'paragraph', label: 'label', summary: 'button', article: 'article',
  };
  const INPUT_ROLES = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
    button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button',
  };

  function refFor(el) {
    const existing = reverse.get(el);
    if (existing && refs.get(existing)?.deref() === el) return existing;
    const ref = 'ref_' + ++counter;
    window.__aichromeCounter = counter;
    refs.set(ref, new WeakRef(el));
    reverse.set(el, ref);
    return ref;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'input') {
      if (el.type === 'hidden') return null;
      return INPUT_ROLES[el.type] || 'textbox';
    }
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
    return TAG_ROLES[tag] || null;
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' || tag === 'summary') return true;
    if (tag === 'a' && el.hasAttribute('href')) return true;
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    return tabindex !== null && Number(tabindex) >= 0;
  }

  function isVisible(el) {
    // `display: contents` wrappers have no box, so checkVisibility() reports them hidden; their children may be visible.
    if (getComputedStyle(el).display === 'contents') return true;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  const clean = (s) => String(s).replace(/\s+/g, ' ').trim().substring(0, 100).replace(/"/g, '\\"');

  function directText(el) {
    let text = '';
    for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    return text.trim();
  }

  function nameOf(el, role) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(' ').map((id) => document.getElementById(id)?.innerText || '').join(' ').trim();
      if (text) return text;
    }
    if (el.labels?.length) return el.labels[0].innerText;
    const alt = el.getAttribute('alt') || el.getAttribute('title');
    if (alt) return alt;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return '';
    if (['button', 'link', 'heading', 'tab', 'menuitem', 'option', 'label', 'checkbox', 'radio', 'switch', 'treeitem'].includes(role) || isInteractive(el, role)) {
      return el.innerText || el.textContent || '';
    }
    return directText(el);
  }

  function describe(el, role, depth) {
    const tag = el.tagName.toLowerCase();
    let line = '  '.repeat(depth) + (role || tag);
    const name = nameOf(el, role);
    if (name && name.trim()) line += ` "${clean(name)}"`;
    line += ` [${refFor(el)}]`;
    const href = el.getAttribute('href');
    if (href) line += ` href="${href.substring(0, 200)}"`;
    const type = el.getAttribute('type');
    if (type) line += ` type="${type}"`;
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) line += ` placeholder="${clean(placeholder)}"`;
    if ((tag === 'input' || tag === 'textarea') && el.type !== 'password' && el.value && !['checkbox', 'radio'].includes(el.type)) {
      line += ` value="${clean(el.value)}"`;
    }
    if (tag === 'input' && el.type === 'file') {
      line += ' (file input' + (el.accept ? ` accept="${clean(el.accept)}"` : '') + (isVisible(el) ? '' : ', hidden') + ': use with file_upload)';
    }
    if (el.checked) line += ' (checked)';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' (disabled)';
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) line += ` (expanded=${expanded})`;
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') line += ` (level ${tag[1]})`;
    // Flag elements outside the viewport so agents prefer the visible copy of duplicated widgets.
    const r = el.getBoundingClientRect();
    if (r.width && (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth)) line += ' (offscreen)';
    // Tables repeat the same short button ("Edit", "Delete") on every row: say which row this one is in.
    if ((role === 'button' || role === 'link') && (!name || name.trim().length <= 24)) {
      const row = el.closest('tr, [role="row"]');
      if (row) {
        // The row's data cells (not the ones holding the action buttons).
        const cells = [...row.querySelectorAll('td, th, [role="cell"], [role="gridcell"]')]
          .filter((c) => !c.querySelector('a[href], button, input, select, [role="button"]'))
          .map((c) => clean(c.innerText || '')).filter(Boolean);
        const text = (cells.length ? cells.join(' / ') : clean(row.innerText || '').replace(clean(name || ''), '').trim()).substring(0, 60);
        if (text) line += ` (row: "${text}")`;
      }
    }
    return line;
  }

  const LANDMARK_SKIP = new Set(['navigation', 'complementary']);
  function outsideMain(el, role) {
    if (LANDMARK_SKIP.has(role)) return true;
    const tag = el.tagName.toLowerCase();
    return (tag === 'header' || tag === 'footer' || role === 'banner' || role === 'contentinfo') && !el.closest('main, article, [role="main"], dialog, [role="dialog"]');
  }

  function walk(el, depth, maxDepth, filter, out) {
    if (depth > maxDepth || out.size > MAX_CHARS) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    // File inputs are usually hidden behind a styled button, but they are what file_upload needs.
    const fileInput = tag === 'input' && el.type === 'file';
    if (!fileInput && !isVisible(el)) return;
    if (out.scope === 'main' && el !== out.root && outsideMain(el, roleOf(el))) return;
    if (fileInput) out.files.add(el);

    const role = roleOf(el);
    const interactive = isInteractive(el, role);
    const include = filter === 'interactive'
      ? interactive
      : interactive || (role && role !== 'listitem' && role !== 'row' && role !== 'cell') || directText(el).length > 0;

    let childDepth = depth;
    if (include) {
      const line = describe(el, role, depth);
      out.lines.push(line);
      out.size += line.length + 1;
      childDepth = depth + 1;
      if (tag === 'select') {
        for (const opt of el.options) {
          let o = '  '.repeat(childDepth) + `option "${clean(opt.text)}"`;
          if (opt.selected) o += ' (selected)';
          if (opt.value && opt.value !== opt.text) o += ` value="${clean(opt.value)}"`;
          out.lines.push(o);
        }
        return;
      }
      // An interactive element's name already includes its text; only descend for nested controls.
      if (interactive && filter !== 'interactive' && !el.querySelector('a[href],button,input,select,textarea,[role],[tabindex],[onclick]')) return;
    }
    for (const child of el.children) walk(child, childDepth, maxDepth, filter, out);
    if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, childDepth, maxDepth, filter, out);
  }

  window.__aichromeRef = (ref) => refs.get(ref)?.deref() || null;

  // Workflows: describe the element behind a ref, so a replay can find the same element again on a fresh page.
  window.__aichromeDescribe = (ref) => {
    const el = window.__aichromeRef(ref);
    if (!el || !el.isConnected) return null;
    const role = roleOf(el) || el.tagName.toLowerCase();
    return {
      role,
      name: clean(nameOf(el, role) || ''),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      href: el.getAttribute('href') || '',
    };
  };

  // Best visible match for a description from __aichromeDescribe, as a fresh ref (or null).
  window.__aichromeLocate = (d) => {
    const want = String(d?.name || '').toLowerCase();
    let best = null;
    let bestScore = 0;
    const all = [...document.querySelectorAll(d?.tag || '*')];
    for (const el of all) {
      const role = roleOf(el) || el.tagName.toLowerCase();
      if (role !== d.role || !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const name = clean(nameOf(el, role) || '').toLowerCase();
      let score = 1;
      if (want && name === want) score += 4;
      else if (want && name && (name.includes(want) || want.includes(name))) score += 2;
      else if (want) score -= 1;
      if (d.id && el.id === d.id) score += 3;
      if (d.placeholder && el.getAttribute('placeholder') === d.placeholder) score += 2;
      if (d.href && el.getAttribute('href') === d.href) score += 2;
      if (r.bottom >= 0 && r.top <= innerHeight) score += 0.5; // prefer the copy on screen
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    // A bare role match isn't enough when the element had a name or id.
    if (!best || (bestScore < 2.5 && (want || d.id))) return null;
    return refFor(best);
  };

  window.__aichromeTree = (filter = 'all', maxDepth = 15, refId = null, scope = 'all') => {
    const viewport = { width: window.innerWidth, height: window.innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) };
    let root = document.body || document.documentElement;
    if (refId) {
      root = window.__aichromeRef(refId);
      if (!root || !root.isConnected) {
        return { error: `Element with ref_id '${refId}' not found. It may have been removed from the page. Use read_page without ref_id to get the current page state.`, pageContent: '', viewport };
      }
    }
    const out = { lines: [], size: 0, files: new Set(), scope, root };
    walk(root, 0, maxDepth, filter === 'interactive' ? 'interactive' : 'all', out);
    // File inputs inside hidden containers never got walked: list them anyway.
    if (!refId) {
      for (const el of document.querySelectorAll('input[type="file"]')) {
        if (out.files.has(el)) continue;
        const line = describe(el, 'button', 0);
        out.lines.push(line);
        out.size += line.length + 1;
      }
    }
    if (out.size > MAX_CHARS) {
      return {
        error: `Output exceeds ${MAX_CHARS} characters. Use filter "interactive", ${refId ? 'a smaller depth or a more specific child element' : 'ref_id or a smaller depth to focus'}.`,
        pageContent: out.lines.join('\n').substring(0, MAX_CHARS),
        viewport,
      };
    }
    return { pageContent: out.lines.join('\n'), viewport };
  };

  const onScreen = (r) => r.bottom >= 0 && r.top <= innerHeight && r.right >= 0 && r.left <= innerWidth;
  const short = (el) => {
    const role = roleOf(el) || el.tagName.toLowerCase();
    const name = clean(nameOf(el, role) || '');
    return `${role}${name ? ` "${name}"` : ''} [${refFor(el)}]`;
  };

  // Element by CSS selector and/or visible text / accessible name, so a click needs no find call first.
  // Returns { ref, desc } or { error, candidates }.
  window.__aichromeQuery = ({ selector, label } = {}) => {
    let pool;
    try {
      pool = selector ? [...document.querySelectorAll(selector)] : [...document.querySelectorAll('body *')];
    } catch (e) {
      return { error: `Bad selector: ${e.message}` };
    }
    const want = label ? String(label).replace(/\s+/g, ' ').trim().toLowerCase() : '';
    let best = null;
    let bestScore = 0;
    for (const el of pool) {
      if (SKIP.has(el.tagName.toLowerCase())) continue;
      const fileInput = el.tagName === 'INPUT' && el.type === 'file';
      if (!fileInput && !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (!fileInput && (!r.width || !r.height)) continue;
      const role = roleOf(el);
      let score = 1;
      if (want) {
        const name = String(nameOf(el, role) || el.getAttribute('placeholder') || el.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!name) continue;
        if (name === want) score += 6;
        else if (name.startsWith(want)) score += 3;
        else if (name.includes(want) && name.length <= want.length * 3) score += 2;
        else continue;
      }
      if (isInteractive(el, role) || (el.tagName === 'LABEL' && el.control)) score += 2;
      if (onScreen(r)) score += 1;
      // Prefer the innermost element when a wrapper has the same text.
      if (best && best.contains(el) && score >= bestScore) score += 0.5;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (!best) return { error: `No visible element matches ${selector ? `selector "${selector}"` : ''}${selector && label ? ' and ' : ''}${label ? `text "${label}"` : ''}.` };
    return { ref: refFor(best), desc: short(best) };
  };

  // The <input type="file"> that belongs to an element: itself, its label's control, one near it, or the page's only one.
  window.__aichromeFileInput = (ref) => {
    const el = window.__aichromeRef(ref);
    if (!el) return null;
    const isFile = (n) => n && n.tagName === 'INPUT' && n.type === 'file';
    if (isFile(el)) return ref;
    if (isFile(el.control)) return refFor(el.control);
    const label = el.closest('label');
    if (label && isFile(label.control)) return refFor(label.control);
    let node = el;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      const inputs = node.querySelectorAll('input[type="file"]');
      if (inputs.length === 1) return refFor(inputs[0]);
      if (inputs.length > 1) break;
    }
    const all = document.querySelectorAll('input[type="file"]');
    return all.length === 1 ? refFor(all[0]) : null;
  };

  // What a click can change: URL, dialogs, focus, the DOM, and the clicked control's own state.
  function controlState(el) {
    if (!el || !el.isConnected) return null;
    const box = el.matches('input[type=checkbox], input[type=radio]') ? el
      : el.closest('label')?.control || el.querySelector?.('input[type=checkbox], input[type=radio]') || el.control;
    const s = {};
    if (box && (box.type === 'checkbox' || box.type === 'radio')) s.checked = box.checked;
    for (const a of ['aria-checked', 'aria-pressed', 'aria-expanded', 'aria-selected']) {
      const v = el.getAttribute(a);
      if (v != null) s[a.slice(5)] = v;
    }
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') s.value = clean(el.value || '').substring(0, 60);
    if (el.disabled) s.disabled = true;
    return s;
  }

  window.__aichromeState = (x, y) => {
    let el = x == null ? null : document.elementFromPoint(x, y);
    // Report the control the user meant, not the inner <span> that got the event.
    const hit = el?.closest('a[href], button, input, select, textarea, label, summary, [role], [tabindex], [onclick]') || el;
    const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
      .filter((d) => isVisible(d) && d.getBoundingClientRect().height > 0)
      .map((d) => ({ ref: refFor(d), name: clean(nameOf(d, 'dialog') || d.querySelector('h1,h2,h3')?.innerText || '').substring(0, 60) }));
    const toasts = [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]')]
      .filter((d) => isVisible(d)).map((d) => clean(d.innerText || '')).filter(Boolean).slice(0, 3);
    const focus = document.activeElement && document.activeElement !== document.body ? short(document.activeElement) : null;
    return {
      url: location.href,
      title: document.title,
      mutations,
      dialogs,
      toasts,
      focus,
      target: hit ? short(hit) : null,
      targetRef: hit ? refFor(hit) : null,
      control: hit ? controlState(hit) : null,
    };
  };

  window.__aichromeControlState = (ref) => controlState(window.__aichromeRef(ref));

  // Put a temporary attribute on a ref's element so main-world code (CDP Runtime.evaluate) can find it.
  window.__aichromeMark = (ref, token) => {
    const el = window.__aichromeRef(ref);
    if (!el) return false;
    el.setAttribute('data-aichrome-pick', token);
    return true;
  };

  // Draw ref labels over the visible interactive elements (for an annotated screenshot); returns the legend.
  window.__aichromeAnnotate = (on) => {
    document.getElementById('__aichrome_marks')?.remove();
    if (!on) return [];
    const layer = document.createElement('div');
    layer.id = '__aichrome_marks';
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    const legend = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('a[href], button, input, select, textarea, summary, [role], [tabindex], [onclick], [contenteditable="true"]')) {
      const role = roleOf(el);
      if (!isInteractive(el, role) || el.closest('#__aichrome_marks')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || !onScreen(r) || !isVisible(el)) continue;
      const key = `${Math.round(r.left)},${Math.round(r.top)}`;
      if (seen.has(key)) continue; // nested controls on the same spot
      seen.add(key);
      const ref = refFor(el);
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid #e8590c;border-radius:2px;`;
      const tagEl = document.createElement('span');
      tagEl.textContent = ref.slice(4);
      tagEl.style.cssText = 'position:absolute;left:-2px;top:-14px;background:#e8590c;color:#fff;font:bold 11px/13px monospace;padding:0 3px;border-radius:2px;';
      box.appendChild(tagEl);
      layer.appendChild(box);
      const name = clean(nameOf(el, role) || el.getAttribute('placeholder') || '').substring(0, 40);
      legend.push(`${ref.slice(4)} ${role || el.tagName.toLowerCase()}${name ? ` "${name}"` : ''}`);
      if (legend.length >= 150) break;
    }
    document.documentElement.appendChild(layer);
    return legend;
  };
})();
