/**
 * Lightweight standards-aligned DOM/Element/Dialog/Event shim for Node `node --test`.
 */

function toDataAttr(camel) {
  return `data-${String(camel).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

function splitOuterSelectors(selector) {
  const parts = [];
  let depth = 0;
  let inBracket = false;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === '[') inBracket = true;
    else if (ch === ']') inBracket = false;
    else if (!inBracket) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        parts.push(selector.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  const tail = selector.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function splitDescendantParts(chain) {
  const tokens = [];
  let depth = 0;
  let inBracket = false;
  let current = '';
  for (let i = 0; i < chain.length; i += 1) {
    const ch = chain[i];
    if (ch === '[') inBracket = true;
    else if (ch === ']') inBracket = false;
    else if (!inBracket) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (/\s/.test(ch) && depth === 0) {
        if (current) {
          tokens.push(current);
          current = '';
        }
        continue;
      }
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function matchesSimpleSegment(el, segment) {
  if (!el || el.nodeType !== 1) return false;
  let rest = segment.trim();
  if (!rest) return true;

  // Handle :not(...) clauses
  while (true) {
    const notIdx = rest.indexOf(':not(');
    if (notIdx === -1) break;
    let depth = 0;
    let endIdx = -1;
    for (let i = notIdx + 5; i < rest.length; i += 1) {
      if (rest[i] === '(') depth += 1;
      else if (rest[i] === ')') {
        if (depth === 0) {
          endIdx = i;
          break;
        }
        depth -= 1;
      }
    }
    if (endIdx === -1) break;
    const innerSel = rest.slice(notIdx + 5, endIdx);
    if (el.matches(innerSel)) return false;
    rest = rest.slice(0, notIdx) + rest.slice(endIdx + 1);
  }

  // Handle [attr="val"] or [attr]
  let attrFailed = false;
  rest = rest.replace(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g, (_m, attr, q1, q2, q3) => {
    const val = q1 ?? q2 ?? q3;
    const actual = el.getAttribute(attr);
    if (val === undefined) {
      if (actual === null) attrFailed = true;
    } else if (actual !== val) {
      attrFailed = true;
    }
    return '';
  });
  if (attrFailed) return false;

  // Tag name if present at start
  const tagMatch = /^([a-zA-Z0-9_-]+)/.exec(rest);
  if (tagMatch) {
    if (el.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }

  // Remaining #id and .class tokens
  const idClassRe = /([#.])([a-zA-Z0-9_-]+)/g;
  let consumed = 0;
  for (const m of rest.matchAll(idClassRe)) {
    consumed += m[0].length;
    if (m[1] === '#') {
      if (el.id !== m[2]) return false;
    } else if (!el.classList.contains(m[2])) {
      return false;
    }
  }
  return consumed === rest.length;
}

class MockClassList {
  constructor(owner) {
    this._owner = owner;
  }

  _tokens() {
    return String(this._owner._className || '').split(/\s+/).filter(Boolean);
  }

  _write(tokens) {
    this._owner._className = [...new Set(tokens)].join(' ');
    this._owner._attrs.set('class', this._owner._className);
  }

  add(...names) {
    const set = new Set(this._tokens());
    for (const n of names) {
      for (const part of String(n || '').split(/\s+/).filter(Boolean)) set.add(part);
    }
    this._write([...set]);
  }

  remove(...names) {
    const removeSet = new Set(names.filter(Boolean));
    this._write(this._tokens().filter((t) => !removeSet.has(t)));
  }

  toggle(name, force) {
    const exists = this.contains(name);
    const shouldAdd = force === undefined ? !exists : Boolean(force);
    if (shouldAdd) this.add(name);
    else this.remove(name);
    return shouldAdd;
  }

  contains(name) {
    return this._tokens().includes(name);
  }
}

class MockStyle {
  constructor() {
    this._props = new Map();
  }

  setProperty(name, value) {
    this._props.set(name, String(value));
  }

  removeProperty(name) {
    this._props.delete(name);
  }

  getPropertyValue(name) {
    return this._props.get(name) || '';
  }
}

class MockDomEventTarget {
  constructor() {
    this._domListeners = new Map();
  }

  addEventListener(type, listener, options = false) {
    if (typeof listener !== 'function') return;
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const once = typeof options === 'object' && options !== null ? Boolean(options.once) : false;
    const signal = typeof options === 'object' && options !== null ? options.signal : null;
    if (signal?.aborted) return;

    const list = this._domListeners.get(type) || [];
    if (!list.some((item) => item.listener === listener && item.capture === capture)) {
      const entry = { listener, capture, once };
      list.push(entry);
      this._domListeners.set(type, list);
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => this.removeEventListener(type, listener, capture), { once: true });
      }
    }
  }

  removeEventListener(type, listener, options = false) {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const list = this._domListeners.get(type);
    if (!list) return;
    const next = list.filter((item) => !(item.listener === listener && item.capture === capture));
    if (next.length > 0) this._domListeners.set(type, next);
    else this._domListeners.delete(type);
  }

  _invokeListeners(event, currentTarget, matchCapture) {
    const list = this._domListeners.get(event.type);
    if (!list || list.length === 0) return false;
    let immediateStopped = false;
    const origStopImmediate = event.stopImmediatePropagation.bind(event);
    const prevStopImmediate = event.stopImmediatePropagation;
    Object.defineProperty(event, 'currentTarget', { value: currentTarget, configurable: true });
    event.stopImmediatePropagation = () => {
      immediateStopped = true;
      event.stopPropagation();
      origStopImmediate();
    };
    try {
      for (const entry of [...list]) {
        if (immediateStopped) break;
        if (matchCapture !== null && entry.capture !== matchCapture) continue;
        if (entry.once) {
          this.removeEventListener(event.type, entry.listener, entry.capture);
        }
        entry.listener.call(currentTarget, event);
      }
    } finally {
      event.stopImmediatePropagation = prevStopImmediate;
    }
    return immediateStopped;
  }

  dispatchEvent(event) {
    if (!event || !event.type) return true;
    const path = [];
    let cur = this;
    while (cur) {
      path.push(cur);
      if (cur.parentNode) {
        cur = cur.parentNode;
      } else if (cur.ownerDocument && cur !== cur.ownerDocument) {
        cur = cur.ownerDocument;
      } else {
        cur = null;
      }
    }

    let propagationStopped = false;
    const origStop = event.stopPropagation.bind(event);
    event.stopPropagation = () => {
      propagationStopped = true;
      origStop();
    };
    Object.defineProperty(event, 'target', { value: this, configurable: true });

    // Capture phase (document down to parent)
    for (let i = path.length - 1; i >= 1; i -= 1) {
      if (propagationStopped) break;
      path[i]._invokeListeners(event, path[i], true);
    }

    // At-target phase
    if (!propagationStopped) {
      this._invokeListeners(event, this, null);
    }

    // Bubble phase (parent up to document)
    if (event.bubbles) {
      for (let i = 1; i < path.length; i += 1) {
        if (propagationStopped) break;
        path[i]._invokeListeners(event, path[i], false);
      }
    }

    Object.defineProperty(event, 'currentTarget', { value: null, configurable: true });
    return !event.defaultPrevented;
  }
}

export class MockNode extends MockDomEventTarget {
  constructor(nodeType, ownerDocument) {
    super();
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes.filter((n) => n.nodeType === 1);
    const idx = siblings.indexOf(this);
    return idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') {
        this.appendChild(this.ownerDocument.createTextNode(n));
      } else if (n) {
        this.appendChild(n);
      }
    }
  }

  insertBefore(node, refNode) {
    if (!node) return node;
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) {
        this.insertBefore(child, refNode);
      }
      return node;
    }
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    node.parentNode = this;
    if (refNode && this.childNodes.includes(refNode)) {
      const idx = this.childNodes.indexOf(refNode);
      this.childNodes.splice(idx, 0, node);
    } else {
      this.childNodes.push(node);
    }
    return node;
  }

  replaceChild(newChild, oldChild) {
    const idx = this.childNodes.indexOf(oldChild);
    if (idx === -1) return oldChild;
    this.insertBefore(newChild, oldChild);
    this.removeChild(oldChild);
    return oldChild;
  }

  removeChild(node) {
    const idx = this.childNodes.indexOf(node);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      node.parentNode = null;
    }
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) {
      child.parentNode = null;
    }
    this.childNodes = [];
    for (const n of nodes) {
      if (typeof n === 'string') this.appendChild(this.ownerDocument.createTextNode(n));
      else if (n) this.appendChild(n);
    }
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }
}

export class MockTextNode extends MockNode {
  constructor(text, ownerDocument) {
    super(3, ownerDocument);
    this.nodeValue = String(text ?? '');
  }

  get textContent() {
    return this.nodeValue;
  }

  set textContent(v) {
    this.nodeValue = String(v ?? '');
  }
}

export class MockDocumentFragment extends MockNode {
  constructor(ownerDocument) {
    super(11, ownerDocument);
  }
}

export class MockElement extends MockNode {
  constructor(tagName, ownerDocument) {
    super(1, ownerDocument);
    this.tagName = String(tagName).toUpperCase();
    this._attrs = new Map();
    this._className = '';
    this._innerHtml = '';
    this.classList = new MockClassList(this);
    this.style = new MockStyle();
    this.value = '';
    this.checked = false;
    this._disabled = false;
    this.hidden = false;
    this.type = '';
    this.scrollTop = 0;
    this.scrollHeight = 100;

    this.dataset = new Proxy({}, {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        return this._attrs.get(toDataAttr(prop));
      },
      set: (_target, prop, value) => {
        if (typeof prop !== 'string') return false;
        this._attrs.set(toDataAttr(prop), String(value));
        return true;
      },
      deleteProperty: (_target, prop) => {
        if (typeof prop !== 'string') return true;
        this._attrs.delete(toDataAttr(prop));
        return true;
      },
    });
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get id() {
    return this._attrs.get('id') || '';
  }

  set id(val) {
    this._attrs.set('id', String(val));
  }

  get className() {
    return this._className;
  }

  set className(val) {
    this._className = String(val || '');
    this._attrs.set('class', this._className);
  }

  get href() {
    return this._attrs.get('href') || '';
  }

  set href(val) {
    this._attrs.set('href', String(val));
  }

  get src() {
    return this._attrs.get('src') || '';
  }

  set src(val) {
    this._attrs.set('src', String(val));
  }

  get alt() {
    return this._attrs.get('alt') || '';
  }

  set alt(val) {
    this._attrs.set('alt', String(val));
  }

  get disabled() {
    return Boolean(this._disabled);
  }

  set disabled(val) {
    this._disabled = Boolean(val);
    if (this._disabled) this._attrs.set('disabled', '');
    else this._attrs.delete('disabled');
  }

  get title() {
    return this._attrs.get('title') || '';
  }

  set title(val) {
    this._attrs.set('title', String(val));
  }

  get type() {
    return this._attrs.get('type') || '';
  }

  set type(val) {
    this._attrs.set('type', String(val));
  }

  get textContent() {
    if (this.childNodes.length === 0 && this._innerHtml) {
      return this._innerHtml.replace(/<[^>]*>/g, '');
    }
    return this.childNodes.map((c) => c.textContent || '').join('');
  }

  set textContent(val) {
    this._innerHtml = '';
    this.replaceChildren(this.ownerDocument.createTextNode(String(val ?? '')));
  }

  get innerHTML() {
    if (this.childNodes.length === 0) return this._innerHtml;
    return this.childNodes
      .map((c) => {
        if (c.nodeType === 3) return c.nodeValue;
        if (c.nodeType === 1) return c.outerHTML;
        return '';
      })
      .join('');
  }

  set innerHTML(html) {
    this._innerHtml = String(html || '');
    // Create simple child nodes for basic HTML tags if assigned cleanly
    this.replaceChildren();
    const doc = this.ownerDocument;
    if (!this._innerHtml) return;
    if (this._innerHtml.includes('<span class="primary-tab-label">')) {
      const m = /<span class="primary-tab-label">([^<]*)<\/span>/.exec(this._innerHtml);
      if (m) {
        const s = doc.createElement('span');
        s.className = 'primary-tab-label';
        s.textContent = m[1];
        this.appendChild(s);
      }
    }
  }

  get outerHTML() {
    const tag = this.tagName.toLowerCase();
    const attrStr = [...this._attrs.entries()].map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${tag}${attrStr}>${this.innerHTML}</${tag}>`;
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const val = String(value);
    this._attrs.set(key, val);
    if (key === 'class') this._className = val;
    if (key === 'href') this.href = val;
    if (key === 'src') this.src = val;
    if (key === 'alt') this.alt = val;
    if (key === 'hidden') this.hidden = true;
    if (key === 'disabled') this._disabled = true;
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    if (key === 'class') return this._className || null;
    return this._attrs.has(key) ? this._attrs.get(key) : null;
  }

  hasAttribute(name) {
    return this._attrs.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    const key = String(name).toLowerCase();
    this._attrs.delete(key);
    if (key === 'class') this._className = '';
    if (key === 'hidden') this.hidden = false;
    if (key === 'disabled') this._disabled = false;
  }

  matches(selector) {
    for (const option of splitOuterSelectors(selector)) {
      const chain = splitDescendantParts(option);
      if (chain.length === 0) continue;
      if (!matchesSimpleSegment(this, chain[chain.length - 1])) continue;
      let cur = this.parentElement;
      let idx = chain.length - 2;
      while (idx >= 0 && cur) {
        if (matchesSimpleSegment(cur, chain[idx])) {
          idx -= 1;
        }
        cur = cur.parentElement;
      }
      if (idx < 0) return true;
    }
    return false;
  }

  closest(selector) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (child.matches(selector)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  click() {
    const ev = new Event('click', { bubbles: true, cancelable: true });
    this.dispatchEvent(ev);
    if (!ev.defaultPrevented) {
      const summary = this.tagName === 'SUMMARY' ? this : this.closest('summary');
      const details = summary?.parentElement;
      if (details && details.tagName === 'DETAILS') {
        details.open = !details.open;
        details.dispatchEvent(new Event('toggle'));
      }
    }
  }

  focus() {
    if (!this.disabled && this.ownerDocument) {
      this.ownerDocument.activeElement = this;
    }
  }

  scrollTo(optsOrX, y) {
    if (optsOrX && typeof optsOrX === 'object') {
      if (typeof optsOrX.top === 'number') this.scrollTop = optsOrX.top;
    } else if (typeof y === 'number') {
      this.scrollTop = y;
    }
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 };
  }
}

export class MockDialogElement extends MockElement {
  constructor(ownerDocument) {
    super('dialog', ownerDocument);
    this.open = false;
    this.returnValue = '';
  }

  showModal() {
    this.open = true;
    this.setAttribute('open', '');
  }

  show() {
    this.open = true;
    this.setAttribute('open', '');
  }

  close(returnVal = '') {
    if (returnVal !== undefined) this.returnValue = String(returnVal);
    this.open = false;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  }
}

export class MockDetailsElement extends MockElement {
  constructor(ownerDocument) {
    super('details', ownerDocument);
  }

  get open() {
    return this.hasAttribute('open');
  }

  set open(val) {
    if (val) this.setAttribute('open', '');
    else this.removeAttribute('open');
  }
}

export class MockDocument extends MockDomEventTarget {
  constructor() {
    super();
    this.title = 'Sanctuary';
    this.documentElement = new MockElement('html', this);
    this.body = new MockElement('body', this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    const lower = String(tagName).toLowerCase();
    if (lower === 'dialog') {
      return new MockDialogElement(this);
    }
    if (lower === 'details') {
      return new MockDetailsElement(this);
    }
    return new MockElement(tagName, this);
  }

  createTextNode(text) {
    return new MockTextNode(text, this);
  }

  createDocumentFragment() {
    return new MockDocumentFragment(this);
  }

  getElementById(id) {
    return this.documentElement.querySelector(`#${id}`);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
}

/**
 * Install MockDocument + Element globals cleanly and return a teardown function.
 */
export function installMockDom() {
  const prev = {
    document: globalThis.document,
    Node: globalThis.Node,
    Element: globalThis.Element,
    HTMLDialogElement: globalThis.HTMLDialogElement,
    window: globalThis.window,
    __SANCTUARY_NO_AUTOBOOT: globalThis.__SANCTUARY_NO_AUTOBOOT,
  };

  const doc = new MockDocument();
  globalThis.__SANCTUARY_NO_AUTOBOOT = true;
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 };
  globalThis.Element = MockElement;
  globalThis.HTMLDialogElement = MockDialogElement;

  return {
    document: doc,
    restore() {
      globalThis.document = prev.document;
      globalThis.Node = prev.Node;
      globalThis.Element = prev.Element;
      globalThis.HTMLDialogElement = prev.HTMLDialogElement;
      globalThis.window = prev.window;
      globalThis.__SANCTUARY_NO_AUTOBOOT = prev.__SANCTUARY_NO_AUTOBOOT;
    },
  };
}
