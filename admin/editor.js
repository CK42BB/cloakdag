// Click-to-edit layer for cloakdag.com. Loaded only on /admin, on top of the real page.
// Everything between the cms markers (nav, main, footer) is editable; Publish sends that HTML back.
(() => {
  'use strict';

  const CMS = window.CMS;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat().filter((k) => k != null && k !== false));
    return el;
  }

  // What can be typed into, and what can be moved / duplicated / deleted.
  const TEXT = [
    '.nav nav a', 'main h1:not(:has(img))', 'main h2', 'main h3', 'main p',
    'main li:not(:has(img, p, h3))', '.foot__small',
  ].join(',');
  const ITEMS = [
    ['.card__band > p', 'Line'], ['.cols > .col', 'Column'], ['.col > p', 'Paragraph'],
    ['.prose__body > p', 'Paragraph'], ['.team > li', 'Team member'], ['.vitals > li', 'List item'],
    ['.logos > li', 'Logo'], ['.sectors > .sector', 'Sector'],
  ];
  const ITEM_SEL = ITEMS.map(([s]) => s).join(',');
  // Enter splits these into a new item; elsewhere Enter adds a line break.
  const SPLIT = '.card__band > p, .col > p, .prose__body > p, .vitals > li';
  const GRIDS = '.cols, .team, .logos, .sectors';
  const RUNTIME_CLASSES = ['in', 'nav--solid'];

  const regions = () => [$('body > header.nav'), $('main'), $('body > footer')];
  const DRAFT_KEY = 'cd-cms-draft';

  // ---------------------------------------------------------------- state

  const meta = $('meta[name="description"]');
  const state = {
    title: document.title,
    desc: meta ? meta.content : '',
    publishedTitle: document.title,
    publishedDesc: meta ? meta.content : '',
    base: CMS.base,
    published: '',
    last: '',
    undo: [],
    redo: [],
    preview: false,
  };

  function arm() {
    $$(TEXT).forEach((el) => {
      if (el.closest('.cms-ui')) return;
      el.contentEditable = 'true';
      el.spellcheck = true;
    });
    $$('main .reveal').forEach((el) => el.classList.add('in'));
  }
  function disarm() {
    $$('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
  }

  // Hover outlines and scroll classes aren't edits, so keep them out of undo/dirty tracking.
  const TRANSIENT = ['cms-hover', 'cms-outline', ...RUNTIME_CLASSES.filter((c) => c !== 'in')];
  function snapshot() {
    return regions().map((r) => {
      const c = r.cloneNode(true);
      for (const el of [c, ...c.querySelectorAll(TRANSIENT.map((t) => `.${t}`).join(','))]) {
        el.classList.remove(...TRANSIENT);
        if (!el.classList.length) el.removeAttribute('class');
      }
      return c.outerHTML;
    }).join('\u0001');
  }
  function restoreSnap(s) {
    const parts = s.split('\u0001');
    regions().forEach((r, i) => { r.outerHTML = parts[i]; });
    state.last = s;
    arm();
    hideFloaters();
    renderSections();
    changed();
  }

  let typingTimer;
  function commit() {
    clearTimeout(typingTimer);
    const s = snapshot();
    if (s === state.last) return;
    state.undo.push(state.last);
    if (state.undo.length > 300) state.undo.shift();
    state.redo = [];
    state.last = s;
    changed();
  }
  function undo() {
    commit();
    if (!state.undo.length) return toast('Nothing to undo');
    state.redo.push(state.last);
    restoreSnap(state.undo.pop());
  }
  function redo() {
    if (!state.redo.length) return toast('Nothing to redo');
    state.undo.push(state.last);
    restoreSnap(state.redo.pop());
  }
  // Wrap a structural change so it lands as one undo step.
  function op(fn) {
    commit();
    fn();
    arm();
    commit();
    renderSections();
  }

  const dirty = () => state.last !== state.published || state.title !== state.publishedTitle || state.desc !== state.publishedDesc;

  let draftTimer;
  function changed() {
    const d = dirty();
    status.textContent = d ? 'Unpublished changes' : 'Up to date with the live site';
    status.classList.toggle('is-dirty', d);
    publishBtn.disabled = !d;
    undoBtn.disabled = !state.undo.length;
    redoBtn.disabled = !state.redo.length;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 300);
  }

  function saveDraft() {
    try {
      if (!dirty()) return localStorage.removeItem(DRAFT_KEY);
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        base: state.base, snap: state.last, title: state.title, desc: state.desc, at: Date.now(),
      }));
    } catch { /* private mode etc. */ }
  }
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; }
  }
  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- serialise

  const KEEP_TAGS = new Set('HEADER NAV MAIN FOOTER SECTION DIV ARTICLE ASIDE BLOCKQUOTE H1 H2 H3 H4 P UL OL LI A IMG SPAN B STRONG I EM U S MARK BR SMALL SUB SUP'.split(' '));
  const DROP_TAGS = new Set('SCRIPT STYLE IFRAME OBJECT EMBED LINK META FORM INPUT TEXTAREA BUTTON SELECT SVG BASE'.split(' '));
  const KEEP_ATTR = /^(class|id|href|src|alt|title|loading|width|height|role|target|rel|aria-[a-z]+|data-(hidden|cols|pad|align))$/;

  function clean(root) {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el !== root && !root.contains(el)) continue; // already dropped with its parent
      if (DROP_TAGS.has(el.tagName)) { el.remove(); continue; }
      if (!KEEP_TAGS.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) {
        if (!KEEP_ATTR.test(a.name)) el.removeAttribute(a.name);
        else if (a.name === 'href' && !/^(https?:|mailto:|tel:|#|\/)/i.test(a.value.trim())) el.removeAttribute(a.name);
        else if (a.name === 'src' && !/^(https?:|\/)/i.test(a.value.trim())) el.removeAttribute(a.name);
      }
      if (el.classList.length) {
        RUNTIME_CLASSES.forEach((c) => el.classList.remove(c));
        [...el.classList].filter((c) => c.startsWith('cms-')).forEach((c) => el.classList.remove(c));
        if (!el.classList.length) el.removeAttribute('class');
      }
    }
    return root;
  }

  const serialise = () => `\n${regions().map((r) => clean(r.cloneNode(true)).outerHTML).join('\n\n')}\n`;

  // ---------------------------------------------------------------- server

  async function api(name, body) {
    const r = await fetch(`/admin/api/${name}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-CMS': '1', ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(out.error || `Error ${r.status}`), { status: r.status });
    return out;
  }

  async function publish(note, force = false) {
    commit();
    publishBtn.disabled = true;
    status.textContent = 'Publishing…';
    try {
      const body = { region: serialise(), base: state.base, note, force };
      if (state.title !== state.publishedTitle) body.title = state.title;
      if (state.desc !== state.publishedDesc) body.description = state.desc;
      const out = await api('publish', body);
      state.base = out.base;
      state.published = state.last;
      state.publishedTitle = state.title;
      state.publishedDesc = state.desc;
      clearDraft();
      changed();
      toast(CMS.github ? 'Published. It’s live now.' : 'Saved (local only: GitHub is not connected).', 5000);
    } catch (err) {
      changed();
      if (err.status === 409) {
        const choice = await modal(
          'Someone else published first',
          'The live site changed after you opened the editor. Publishing now will replace their changes with yours.',
          [['cancel', 'Cancel'], ['force', 'Replace with my version', true]],
        );
        if (choice === 'force') return publish(note, true);
      } else {
        modal('Not published', err.message, [['ok', 'OK', true]]);
      }
    }
  }

  // ---------------------------------------------------------------- UI chrome

  const status = h('span', { class: 'cms-status' });
  const undoBtn = h('button', { type: 'button', title: 'Undo (⌘Z)', onclick: undo }, '↶ Undo');
  const redoBtn = h('button', { type: 'button', title: 'Redo (⇧⌘Z)', onclick: redo }, '↷ Redo');
  const publishBtn = h('button', { type: 'button', class: 'cms-primary', onclick: () => openPublish() }, 'Publish');
  const panelBtn = h('button', { type: 'button', onclick: () => togglePanel() }, 'Sections & settings');

  const topbar = h('div', { class: 'cms-ui cms-top' },
    h('div', { class: 'cms-top__left' },
      h('strong', {}, 'Editing cloakdag.com'),
      status),
    h('div', { class: 'cms-top__right' },
      undoBtn, redoBtn,
      h('button', { type: 'button', onclick: () => setPreview(true) }, 'Preview'),
      panelBtn,
      publishBtn,
      h('details', { class: 'cms-menu' },
        h('summary', { title: CMS.email }, '⋯'),
        h('div', { class: 'cms-menu__list' },
          h('span', { class: 'cms-muted' }, `Signed in as ${CMS.email}`),
          h('a', { href: '/', target: '_blank', rel: 'noopener' }, 'View live site ↗'),
          h('button', { type: 'button', onclick: () => discard() }, 'Discard unpublished changes'),
          h('button', { type: 'button', onclick: () => help() }, 'How to use the editor'),
          h('form', { method: 'post', action: '/admin/logout' }, h('button', { type: 'submit' }, 'Sign out'))))));

  const exitPreview = h('button', { type: 'button', class: 'cms-ui cms-exit-preview', onclick: () => setPreview(false) }, '← Back to editing');

  function setPreview(on) {
    commit();
    state.preview = on;
    document.body.classList.toggle('cms', !on);
    document.body.classList.toggle('cms-preview', on);
    hideFloaters();
    if (on) disarm(); else arm();
  }

  function toast(text, ms = 3000) {
    const t = h('div', { class: 'cms-ui cms-toast', role: 'status' }, text);
    document.body.append(t);
    requestAnimationFrame(() => t.classList.add('is-in'));
    setTimeout(() => { t.classList.remove('is-in'); setTimeout(() => t.remove(), 300); }, ms);
  }

  // Resolves with the clicked button's key. buttons: [key, label, primary?]
  function modal(title, body, buttons, extra) {
    return new Promise((resolve) => {
      const close = (v) => { wrap.remove(); resolve(v); };
      const wrap = h('div', { class: 'cms-ui cms-modal', onclick: (e) => { if (e.target === wrap) close(null); } },
        h('div', { class: 'cms-modal__box', role: 'dialog', 'aria-modal': 'true' },
          h('h2', {}, title),
          typeof body === 'string' ? h('p', {}, body) : body,
          extra || null,
          h('div', { class: 'cms-modal__btns' },
            buttons.map(([k, label, primary]) => h('button', { type: 'button', class: primary ? 'cms-primary' : '', onclick: () => close(k) }, label)))));
      document.body.append(wrap);
      const first = wrap.querySelector('input, textarea') || wrap.querySelector('.cms-primary');
      first && first.focus();
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter' && e.target.matches('input')) wrap.querySelector('.cms-primary')?.click();
      });
    });
  }

  async function openPublish() {
    const note = h('input', { type: 'text', placeholder: 'e.g. Updated the team bios', maxlength: '120' });
    const choice = await modal('Publish to cloakdag.com?', 'Your changes will be live for everyone within a few seconds. You can always restore an earlier version from History.',
      [['cancel', 'Cancel'], ['go', 'Publish now', true]],
      h('label', { class: 'cms-field' }, h('span', {}, 'What changed? (optional)'), note));
    if (choice === 'go') publish(note.value.trim());
  }

  async function discard() {
    if (!dirty()) return toast('No unpublished changes');
    const choice = await modal('Discard your changes?', 'This throws away everything you haven’t published and reloads the live version.', [['cancel', 'Keep editing'], ['go', 'Discard', true]]);
    if (choice !== 'go') return;
    clearDraft();
    removeEventListener('beforeunload', guard);
    location.reload();
  }

  function help() {
    modal('How to use the editor', h('ul', { class: 'cms-help' },
      h('li', {}, h('b', {}, 'Change text: '), 'click any words and type. Select text to make it bold, italic, highlighted or a link.'),
      h('li', {}, h('b', {}, 'Lines and paragraphs: '), 'Enter starts a new one where it makes sense; Shift+Enter adds a line break.'),
      h('li', {}, h('b', {}, 'Move, copy or delete: '), 'hover a column, team member, logo or line and use the small ↑ ↓ ⧉ ✕ buttons.'),
      h('li', {}, h('b', {}, 'Images: '), 'click a photo or logo to replace it or change its description.'),
      h('li', {}, h('b', {}, 'Sections: '), 'open “Sections & settings” to reorder, hide, restyle, copy or add whole sections.'),
      h('li', {}, h('b', {}, 'Nothing is live until you Publish. '), 'Your work is kept in this browser if you close the tab. Use Preview to see it exactly as visitors will.'),
      h('li', {}, h('b', {}, 'Made a mistake after publishing? '), 'Sections & settings → History → Restore.')),
    [['ok', 'Got it', true]]);
  }

  // ---------------------------------------------------------------- text formatting

  const linkInput = h('input', { type: 'text', placeholder: 'https://… or email address' });
  const linkRow = h('div', { class: 'cms-fmt__link' },
    linkInput,
    h('button', { type: 'button', onclick: () => applyLink() }, 'Apply'),
    h('button', { type: 'button', onclick: () => removeLink() }, 'Remove'));
  const fmtBtn = (label, title, fn) => h('button', { type: 'button', title, onmousedown: (e) => { e.preventDefault(); fn(); } }, label);
  const fmt = h('div', { class: 'cms-ui cms-fmt' },
    h('div', { class: 'cms-fmt__row' },
      fmtBtn(h('b', {}, 'B'), 'Bold (⌘B)', () => exec('bold')),
      fmtBtn(h('i', {}, 'I'), 'Italic (⌘I)', () => exec('italic')),
      fmtBtn(h('mark', {}, 'Highlight'), 'Highlight', toggleMark),
      fmtBtn('Link', 'Add or edit a link', openLink),
      fmtBtn('Clear', 'Remove formatting', clearFormat)),
    linkRow);

  let savedRange = null;
  const editableOf = (node) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el && !el.closest('.cms-ui') ? el.closest('[contenteditable="true"]') : null;
  };
  const closestIn = (node, sel, stop) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const hit = el && el.closest(sel);
    return hit && (hit === stop || stop.contains(hit)) ? hit : null;
  };

  function exec(cmd, value) {
    document.execCommand(cmd, false, value);
    commit();
  }

  function unwrap(el) { el.replaceWith(...el.childNodes); }

  // Insert on its own line with the same indentation as ref, so the published HTML stays readable.
  function placeAfter(ref, node) {
    const ws = ref.previousSibling;
    ref.after(ws && ws.nodeType === 3 && !ws.data.trim() ? ws.data : '\n', node);
  }

  function toggleMark() {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const ed = editableOf(r.commonAncestorContainer);
    const m = ed && closestIn(r.commonAncestorContainer, 'mark', ed);
    if (m) unwrap(m);
    else if (!r.collapsed) {
      const frag = r.extractContents();
      $$('mark', frag).forEach(unwrap);
      const mk = document.createElement('mark');
      mk.append(frag);
      r.insertNode(mk);
      sel.selectAllChildren(mk);
    }
    commit();
  }

  function clearFormat() {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    document.execCommand('removeFormat');
    const ed = editableOf(sel.anchorNode);
    if (ed) $$('mark', ed).filter((m) => sel.containsNode(m, true)).forEach(unwrap);
    commit();
  }

  function linkTarget() {
    const r = savedRange;
    if (!r) return {};
    const ed = editableOf(r.commonAncestorContainer);
    if (!ed) return {};
    // The editable itself may be the link (nav items, buttons)
    return { ed, a: ed.tagName === 'A' ? ed : closestIn(r.commonAncestorContainer, 'a', ed) };
  }

  function openLink() {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    savedRange = sel.getRangeAt(0).cloneRange();
    const { a } = linkTarget();
    linkInput.value = a ? (a.getAttribute('href') || '').replace(/^mailto:/, '') : '';
    fmt.classList.add('is-linking');
    linkInput.focus();
    linkInput.select();
  }

  function normaliseUrl(v) {
    v = v.trim();
    if (!v) return '';
    if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v)) return `mailto:${v}`;
    if (/^(https?:|mailto:|tel:|#|\/)/i.test(v)) return v;
    return `https://${v}`;
  }

  function applyLink() {
    const url = normaliseUrl(linkInput.value);
    const { ed, a } = linkTarget();
    if (!ed) return closeLink();
    if (!url) return removeLink();
    if (a) a.setAttribute('href', url);
    else {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
      if (savedRange.collapsed) return toast('Select some words first, then add the link');
      document.execCommand('createLink', false, url);
    }
    commit();
    closeLink();
  }

  function removeLink() {
    const { ed, a } = linkTarget();
    if (a && a === ed) toast('This is a button/menu link: change its address instead of removing it');
    else if (a) { unwrap(a); commit(); }
    closeLink();
  }

  function closeLink() {
    fmt.classList.remove('is-linking');
    savedRange = null;
    hideFmt();
  }
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
    if (e.key === 'Escape') closeLink();
  });

  function hideFmt() { if (!fmt.classList.contains('is-linking')) fmt.classList.remove('is-on'); }

  document.addEventListener('selectionchange', () => {
    if (state.preview || fmt.classList.contains('is-linking')) return;
    const sel = getSelection();
    if (!sel.rangeCount) return hideFmt();
    const r = sel.getRangeAt(0);
    const ed = editableOf(sel.anchorNode);
    const inLink = ed && (ed.tagName === 'A' || closestIn(sel.anchorNode, 'a', ed));
    if (!ed || ed !== editableOf(sel.focusNode) || (r.collapsed && !inLink)) return hideFmt();
    const rect = (r.collapsed ? ed : r).getBoundingClientRect();
    hideItem(); // the two bars would sit on top of each other
    fmt.classList.add('is-on');
    const w = fmt.offsetWidth;
    fmt.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + scrollX}px`;
    fmt.style.top = `${Math.max(60, rect.top - fmt.offsetHeight - 10) + scrollY}px`;
  });

  // ---------------------------------------------------------------- typing behaviour

  const caretAtStart = (ed, r) => {
    const pre = document.createRange();
    pre.setStart(ed, 0);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString() === '' && !pre.cloneContents().querySelector('img');
  };
  const fresh = (el) => {
    const n = el.cloneNode(false);
    n.removeAttribute('id');
    return n;
  };
  const placeCaret = (node, atEnd) => {
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(!atEnd);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  };

  function splitBlock(ed) {
    commit();
    const sel = getSelection();
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const tail = document.createRange();
    tail.setStart(r.endContainer, r.endOffset);
    tail.setEnd(ed, ed.childNodes.length);
    const n = fresh(ed);
    n.append(tail.extractContents());
    if (!n.textContent.trim()) n.innerHTML = '<br>';
    if (!ed.textContent.trim()) ed.innerHTML = '<br>';
    placeAfter(ed, n);
    n.focus();
    placeCaret(n, false);
    commit();
  }

  function mergeBack(ed, prev) {
    commit();
    if (!prev.textContent.trim()) prev.innerHTML = '';
    const r = document.createRange();
    r.selectNodeContents(prev);
    r.collapse(false);
    prev.append(...ed.childNodes);
    ed.remove();
    prev.focus();
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    commit();
  }

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.target.closest?.('.cms-ui input, .cms-ui textarea')) {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      commit();
      saveDraft();
      return toast('Draft saved in this browser. Click Publish to put it live.');
    }
    if (e.key === 'Escape' && state.preview) return setPreview(false);

    const ed = editableOf(e.target);
    if (!ed) return;
    const sel = getSelection();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey || !ed.matches(SPLIT)) {
        if (ed.tagName !== 'A') document.execCommand('insertLineBreak');
      } else splitBlock(ed);
    } else if (e.key === 'Backspace' && ed.matches(SPLIT) && sel.rangeCount && sel.getRangeAt(0).collapsed && caretAtStart(ed, sel.getRangeAt(0))) {
      const prev = ed.previousElementSibling;
      if (prev && prev.tagName === ed.tagName && prev.isContentEditable) {
        e.preventDefault();
        mergeBack(ed, prev);
      }
    }
  });

  document.addEventListener('input', (e) => {
    if (!editableOf(e.target)) return;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(commit, 500);
  });

  // Paste as plain text so nothing from Word / Google Docs / other sites sneaks in.
  document.addEventListener('paste', (e) => {
    if (!editableOf(e.target)) return;
    e.preventDefault();
    const lines = (e.clipboardData.getData('text/plain') || '').replace(/\r/g, '').split('\n');
    lines.forEach((line, i) => {
      if (i) document.execCommand('insertLineBreak');
      if (line) document.execCommand('insertText', false, line);
    });
  });

  for (const ev of ['drop', 'dragstart']) {
    document.addEventListener(ev, (e) => { if (!e.target.closest?.('.cms-ui')) e.preventDefault(); });
  }

  // Links don't navigate while editing.
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a');
    if (a && !a.closest('.cms-ui') && !state.preview) e.preventDefault();
  }, true);

  // ---------------------------------------------------------------- item controls (↑ ↓ ⧉ ✕)

  let hoverItem = null;
  const itemLabel = h('span', { class: 'cms-item__label' });
  const itemBar = h('div', { class: 'cms-ui cms-item' },
    itemLabel,
    h('button', { type: 'button', title: 'Move up / left', onclick: () => moveItem(-1) }, '↑'),
    h('button', { type: 'button', title: 'Move down / right', onclick: () => moveItem(1) }, '↓'),
    h('button', { type: 'button', title: 'Duplicate', onclick: () => dupItem() }, '⧉'),
    h('button', { type: 'button', title: 'Delete', onclick: () => delItem() }, '✕'));

  const siblingsOf = (it) => [...it.parentElement.children].filter((c) => c.matches(ITEM_SEL));

  function showItem(it) {
    if (hoverItem && hoverItem !== it) hoverItem.classList.remove('cms-hover');
    hoverItem = it;
    it.classList.add('cms-hover');
    itemLabel.textContent = (ITEMS.find(([s]) => it.matches(s)) || [, 'Item'])[1];
    const r = it.getBoundingClientRect();
    itemBar.classList.add('is-on');
    itemBar.style.top = `${r.top + scrollY - itemBar.offsetHeight + 2}px`;
    itemBar.style.left = `${Math.max(8, r.right + scrollX - itemBar.offsetWidth)}px`;
  }
  function hideItem() {
    if (hoverItem) hoverItem.classList.remove('cms-hover');
    hoverItem = null;
    itemBar.classList.remove('is-on');
  }

  document.addEventListener('mouseover', (e) => {
    if (state.preview || e.target.closest?.('.cms-ui') || fmt.classList.contains('is-on')) return;
    const it = e.target.closest?.(ITEM_SEL);
    if (it && $('main').contains(it)) showItem(it);
    else hideItem();
  });

  function moveItem(dir) {
    const it = hoverItem;
    if (!it) return;
    const sibs = siblingsOf(it);
    const other = sibs[sibs.indexOf(it) + dir];
    if (!other) return toast(dir < 0 ? 'Already first' : 'Already last');
    op(() => (dir < 0 ? other.before(it) : other.after(it)));
    showItem(it);
  }
  function dupItem() {
    const it = hoverItem;
    if (!it) return;
    const copy = it.cloneNode(true);
    copy.classList.remove('cms-hover');
    [copy, ...copy.querySelectorAll('[id]')].forEach((el) => el.removeAttribute('id'));
    op(() => placeAfter(it, copy));
    showItem(copy);
  }
  function delItem() {
    const it = hoverItem;
    if (!it) return;
    if (siblingsOf(it).length <= 1) return toast('That’s the last one. Hide the whole section instead (Sections & settings).', 4500);
    hideItem();
    op(() => it.remove());
    toast('Deleted. Undo with ⌘Z if that was a mistake.');
  }

  // ---------------------------------------------------------------- images

  let currentImg = null;
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
  const altInput = h('input', { type: 'text', placeholder: 'What the image shows' });
  const imgPop = h('div', { class: 'cms-ui cms-imgpop' },
    h('button', { type: 'button', class: 'cms-primary', onclick: () => fileInput.click() }, 'Replace image…'),
    h('label', { class: 'cms-field' }, h('span', {}, 'Description (for screen readers and Google)'), altInput),
    h('button', { type: 'button', onclick: () => hideImg() }, 'Done'),
    fileInput);

  document.addEventListener('click', (e) => {
    if (state.preview || e.target.closest?.('.cms-ui')) return;
    const img = e.target.closest?.('img');
    if (!img || !regions().some((r) => r.contains(img))) {
      if (!e.target.closest?.('.cms-imgpop')) hideImg();
      return;
    }
    e.preventDefault();
    currentImg = img;
    altInput.value = img.getAttribute('alt') || '';
    const r = img.getBoundingClientRect();
    imgPop.classList.add('is-on');
    imgPop.style.top = `${r.top + scrollY + Math.min(r.height, 40)}px`;
    imgPop.style.left = `${Math.max(8, Math.min(innerWidth - imgPop.offsetWidth - 8, r.left)) + scrollX}px`;
  });
  function hideImg() {
    imgPop.classList.remove('is-on');
    currentImg = null;
  }
  altInput.addEventListener('change', () => {
    if (!currentImg) return;
    currentImg.setAttribute('alt', altInput.value.trim());
    commit();
  });

  // Shrink to a sensible size and convert to WebP in the browser before uploading.
  async function prepareImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, no) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = () => no(new Error('That file could not be read as an image.'));
        i.src = url;
      });
      const s = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/webp', 0.86));
      const data = await new Promise((ok) => {
        const fr = new FileReader();
        fr.onload = () => ok(String(fr.result).split(',')[1]);
        fr.readAsDataURL(blob);
      });
      return { data, width: c.width, height: c.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    const img = currentImg;
    fileInput.value = '';
    if (!file || !img) return;
    toast('Uploading image…', 2500);
    try {
      const prepared = await prepareImage(file);
      const out = await api('upload', { data: prepared.data });
      op(() => {
        img.src = out.src;
        img.removeAttribute('srcset');
        if (img.hasAttribute('width')) {
          img.setAttribute('width', prepared.width);
          img.setAttribute('height', prepared.height);
        }
      });
      hideImg();
      toast('Image replaced');
    } catch (err) {
      modal('Image not uploaded', err.message, [['ok', 'OK', true]]);
    }
  });

  function hideFloaters() {
    hideItem();
    hideImg();
    closeLink();
  }
  addEventListener('resize', hideFloaters);

  // ---------------------------------------------------------------- sections panel

  const BGS = [['paper', 'Paper (textured beige)'], ['dark', 'Charcoal'], ['light', 'White'], ['light dial', 'White + faint directory page']];
  const PADS = [['', 'Normal'], ['compact', 'Compact'], ['roomy', 'Roomy']];
  const ALIGNS = [['', 'As designed'], ['left', 'Left'], ['center', 'Centre'], ['right', 'Right']];
  const COLS = [['', 'As designed'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']];

  const card = (heading, line2, sign) => `
    <div class="stack reveal"><div class="card">
      <h2 class="card__title type">${heading}</h2>
      <div class="card__band"><p>First line of the card.</p><p>${line2}</p></div>
      ${sign}
    </div></div>`;
  const TEMPLATES = [
    ['Index card', 'Typewritten card on charcoal, like the Synopsis',
      `<section class="brief dark">${card('Heading', 'A second line.', '<p class="card__sign type">Sign-off line.</p>')}</section>`],
    ['Headline + text', 'Big heading with a couple of paragraphs',
      `<section class="prose light">
    <h2 class="display display--xl">Headline</h2>
    <div class="prose__body"><p>Write a paragraph here.</p><p>And another one.</p></div>
  </section>`],
    ['Columns', 'Heading with three columns, like the Blueprint',
      `<section class="blueprint light dial">
    <div class="rule"></div>
    <h2 class="display display--xl">Heading</h2>
    <div class="cols" data-cols="3">${['One', 'Two', 'Three'].map((n) => `
      <article class="col reveal"><h3 class="type">Column ${n}</h3><p>A sentence or two about this.</p></article>`).join('')}
    </div>
  </section>`],
    ['Quote', 'One large line with an attribution',
      `<section class="quote dark">
    <blockquote class="quote__text"><p>“A line worth repeating.”</p></blockquote>
    <p class="quote__by type">Name, Title</p>
  </section>`],
    ['Call to action', 'Card with an email button, like Open a File',
      `<section class="contact paper">
    <div class="stack stack--file reveal"><div class="card card--file">
      <h2 class="card__title type">Get in touch</h2>
      <div class="card__band"><p>One line about why.</p></div>
      <a class="btn type" href="mailto:jb@cloakdag.com">jb@cloakdag.com</a>
    </div></div>
  </section>`],
  ];

  const panelBody = h('div', { class: 'cms-panel__body' });
  const tabs = h('div', { class: 'cms-tabs', role: 'tablist' });
  const panel = h('aside', { class: 'cms-ui cms-panel', 'aria-label': 'Sections and settings' },
    h('div', { class: 'cms-panel__head' },
      tabs,
      h('button', { type: 'button', class: 'cms-x', title: 'Close', onclick: () => togglePanel(false) }, '✕')),
    panelBody);
  let tab = 'sections';
  const TABS = [['sections', 'Sections'], ['page', 'Page'], ['history', 'History']];

  function togglePanel(force) {
    const on = force ?? !document.body.classList.contains('cms-panel-open');
    document.body.classList.toggle('cms-panel-open', on);
    hideFloaters();
    if (on) renderPanel();
  }

  function renderPanel() {
    tabs.replaceChildren(...TABS.map(([k, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(k === tab), class: k === tab ? 'is-on' : '',
      onclick: () => { tab = k; renderPanel(); },
    }, label)));
    if (tab === 'sections') renderSections();
    if (tab === 'page') renderPage();
    if (tab === 'history') renderHistory();
  }

  const sectionsEl = () => $$('main > section');
  function sectionName(sec) {
    const head = sec.querySelector('h1, h2, h3');
    const squash = (t) => t.replace(/\s+/g, ' ').trim();
    const text = head && squash(head.textContent);
    if (text) return text;
    if (sec.getAttribute('aria-label')) return sec.getAttribute('aria-label');
    const words = squash(sec.textContent);
    return words ? (words.length > 32 ? `${words.slice(0, 30)}…` : words) : 'Section';
  }
  const bgOf = (sec) => (sec.classList.contains('dark') ? 'dark' : sec.classList.contains('paper') ? 'paper' : sec.classList.contains('dial') ? 'light dial' : 'light');

  const openStyles = new WeakSet();

  function select(options, value, onchange) {
    return h('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  }

  function renderSections() {
    if (tab !== 'sections' || !document.body.classList.contains('cms-panel-open')) return;
    const list = sectionsEl();
    const rows = list.map((sec, i) => {
      const grid = sec.querySelector(GRIDS);
      const hidden = sec.hasAttribute('data-hidden');
      const styles = h('details', { class: 'cms-sec__style', open: openStyles.has(sec), ontoggle: (e) => (e.target.open ? openStyles.add(sec) : openStyles.delete(sec)) },
        h('summary', {}, 'Style & layout'),
        h('label', { class: 'cms-field' }, h('span', {}, 'Background'), select(BGS, bgOf(sec), (v) => op(() => {
          sec.classList.remove('paper', 'dark', 'light', 'dial');
          sec.classList.add(...v.split(' '));
        }))),
        h('label', { class: 'cms-field' }, h('span', {}, 'Spacing'), select(PADS, sec.dataset.pad || '', (v) => op(() => setData(sec, 'pad', v)))),
        h('label', { class: 'cms-field' }, h('span', {}, 'Text alignment'), select(ALIGNS, sec.dataset.align || '', (v) => op(() => setData(sec, 'align', v)))),
        grid && h('label', { class: 'cms-field' }, h('span', {}, 'Columns (on wide screens)'), select(COLS, grid.dataset.cols || '', (v) => op(() => setData(grid, 'cols', v)))));
      const adder = h('div', { class: 'cms-sec__add', hidden: true },
        h('p', { class: 'cms-muted' }, 'Add a new section below:'),
        TEMPLATES.map(([name, desc, tpl]) => h('button', { type: 'button', onclick: () => addSection(sec, tpl) }, h('b', {}, name), h('span', {}, desc))));
      return h('div', {
        class: `cms-sec${hidden ? ' is-hidden' : ''}`,
        onmouseenter: () => sec.classList.add('cms-outline'),
        onmouseleave: () => sec.classList.remove('cms-outline'),
      },
      h('div', { class: 'cms-sec__row' },
        h('button', { type: 'button', class: 'cms-sec__name', title: 'Scroll to this section', onclick: () => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
          sectionName(sec), hidden ? h('em', {}, ' (hidden)') : null),
        h('div', { class: 'cms-sec__btns' },
          h('button', { type: 'button', title: 'Move up', disabled: i === 0, onclick: () => op(() => list[i - 1].before(sec)) }, '↑'),
          h('button', { type: 'button', title: 'Move down', disabled: i === list.length - 1, onclick: () => op(() => list[i + 1].after(sec)) }, '↓'),
          h('button', { type: 'button', title: hidden ? 'Show on the live site' : 'Hide from the live site', onclick: () => op(() => sec.toggleAttribute('data-hidden')) }, hidden ? 'Show' : 'Hide'),
          h('button', { type: 'button', title: 'Duplicate', onclick: () => dupSection(sec) }, '⧉'),
          h('button', { type: 'button', title: 'Delete', onclick: () => delSection(sec) }, '✕'))),
      styles,
      h('button', { type: 'button', class: 'cms-sec__plus', onclick: (e) => { adder.hidden = !adder.hidden; e.target.textContent = adder.hidden ? '+ Add section below' : '– Cancel'; } }, '+ Add section below'),
      adder);
    });
    panelBody.replaceChildren(
      h('p', { class: 'cms-muted' }, 'Hover a row to find the section on the page. Hidden sections stay here (faded) so you can bring them back.'),
      ...rows);
  }

  function setData(el, key, v) {
    if (v) el.dataset[key] = v; else delete el.dataset[key];
  }

  function addSection(after, tpl) {
    const t = document.createElement('template');
    t.innerHTML = tpl.trim();
    const sec = t.content.firstElementChild;
    op(() => placeAfter(after, sec));
    sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('Section added. Click its text to edit it.');
  }

  function dupSection(sec) {
    const copy = sec.cloneNode(true);
    copy.classList.remove('cms-outline');
    $$('[id]', copy).forEach((el) => el.removeAttribute('id'));
    if (copy.id) copy.id = `${copy.id}-${Math.random().toString(36).slice(2, 6)}`;
    copy.removeAttribute('aria-labelledby');
    op(() => placeAfter(sec, copy));
    copy.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function delSection(sec) {
    const choice = await modal(`Delete “${sectionName(sec)}”?`, 'If you might want it back later, hide it instead.', [['cancel', 'Cancel'], ['hide', 'Hide instead'], ['del', 'Delete', true]]);
    if (choice === 'hide') op(() => sec.setAttribute('data-hidden', ''));
    if (choice === 'del') op(() => sec.remove());
  }

  function renderPage() {
    const title = h('input', { type: 'text', value: state.title, maxlength: '90' });
    const desc = h('textarea', { rows: '4', maxlength: '300' }, state.desc);
    title.addEventListener('input', () => { state.title = title.value; document.title = title.value; changed(); });
    desc.addEventListener('input', () => { state.desc = desc.value; changed(); });
    panelBody.replaceChildren(
      h('label', { class: 'cms-field' }, h('span', {}, 'Page title (browser tab, Google, link previews)'), title),
      h('label', { class: 'cms-field' }, h('span', {}, 'Description (the snippet under the title on Google and when the link is shared)'), desc),
      h('p', { class: 'cms-muted' }, 'Aim for under 60 characters for the title and about 155 for the description.'));
  }

  async function renderHistory() {
    panelBody.replaceChildren(h('p', { class: 'cms-muted' }, 'Loading…'));
    try {
      const out = await api('history');
      if (!out.github) return panelBody.replaceChildren(h('p', { class: 'cms-muted' }, 'History appears once the editor is connected to GitHub.'));
      const fmtDate = (d) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      panelBody.replaceChildren(
        h('p', { class: 'cms-muted' }, 'Every publish is saved. Restoring puts an older version live (and is itself undoable from here).'),
        ...out.commits.map((c, i) => h('div', { class: 'cms-hist' },
          h('div', {}, h('b', {}, c.message), h('span', { class: 'cms-muted' }, `${fmtDate(c.date)} · ${c.who}`)),
          i === 0 ? h('span', { class: 'cms-badge' }, 'Live') : h('button', { type: 'button', onclick: () => restoreVersion(c) }, 'Restore'))));
    } catch (err) {
      panelBody.replaceChildren(h('p', { class: 'cms-muted' }, err.message));
    }
  }

  async function restoreVersion(c) {
    const choice = await modal('Restore this version?', `“${c.message}” will go live again, replacing the current page.${dirty() ? ' Your unpublished changes will be discarded.' : ''}`, [['cancel', 'Cancel'], ['go', 'Restore', true]]);
    if (choice !== 'go') return;
    try {
      await api('restore', { sha: c.sha });
      clearDraft();
      removeEventListener('beforeunload', guard);
      location.reload();
    } catch (err) {
      modal('Not restored', err.message, [['ok', 'OK', true]]);
    }
  }

  // ---------------------------------------------------------------- boot

  function guard(e) {
    if (dirty()) { e.preventDefault(); e.returnValue = ''; }
  }

  document.body.classList.add('cms');
  document.body.append(topbar, exitPreview, fmt, itemBar, imgPop, panel);
  arm();
  state.last = state.published = snapshot();
  changed();
  addEventListener('beforeunload', guard);
  try { document.execCommand('styleWithCSS', false, false); } catch { /* ignore */ }

  if (!CMS.github) toast('Heads up: GitHub is not connected, so changes are only saved on this server.', 6000);

  const draft = loadDraft();
  if (draft && draft.snap && draft.snap !== state.last) {
    const when = new Date(draft.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const stale = draft.base !== state.base;
    modal('Pick up where you left off?',
      `You have unpublished changes from ${when}.${stale ? ' The live site has changed since then. If you continue and publish, your version will replace those changes.' : ''}`,
      [['discard', 'Discard them'], ['resume', 'Resume editing', true]]).then((choice) => {
      if (choice === 'discard') return clearDraft();
      if (choice !== 'resume') return;
      state.undo.push(state.last);
      restoreSnap(draft.snap);
      state.title = draft.title ?? state.title;
      state.desc = draft.desc ?? state.desc;
      document.title = state.title;
      changed();
    });
  }
})();
