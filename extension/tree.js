// AI in Chrome: accessibility-tree snapshot with stable element refs (ref_N).
// Runs in the extension's isolated world; background.js calls window.__pilotTree / __pilotRef.
(() => {
  if (window.__pilotTree) return;

  const refs = new Map(); // ref -> WeakRef<Element>
  const reverse = new WeakMap(); // Element -> ref
  let counter = 0;
  const MAX_CHARS = 50000;

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
    if (el.checked) line += ' (checked)';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' (disabled)';
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) line += ` (expanded=${expanded})`;
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') line += ` (level ${tag[1]})`;
    // Flag elements outside the viewport so agents prefer the visible copy of duplicated widgets.
    const r = el.getBoundingClientRect();
    if (r.width && (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth)) line += ' (offscreen)';
    return line;
  }

  function walk(el, depth, maxDepth, filter, out) {
    if (depth > maxDepth || out.size > MAX_CHARS) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag) || !isVisible(el)) return;

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

  window.__pilotRef = (ref) => refs.get(ref)?.deref() || null;

  window.__pilotTree = (filter = 'all', maxDepth = 15, refId = null) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) };
    let root = document.body || document.documentElement;
    if (refId) {
      root = window.__pilotRef(refId);
      if (!root || !root.isConnected) {
        return { error: `Element with ref_id '${refId}' not found. It may have been removed from the page. Use read_page without ref_id to get the current page state.`, pageContent: '', viewport };
      }
    }
    const out = { lines: [], size: 0 };
    walk(root, 0, maxDepth, filter === 'interactive' ? 'interactive' : 'all', out);
    if (out.size > MAX_CHARS) {
      return {
        error: `Output exceeds ${MAX_CHARS} characters. Use filter "interactive", ${refId ? 'a smaller depth or a more specific child element' : 'ref_id or a smaller depth to focus'}.`,
        pageContent: out.lines.join('\n').substring(0, MAX_CHARS),
        viewport,
      };
    }
    return { pageContent: out.lines.join('\n'), viewport };
  };
})();
