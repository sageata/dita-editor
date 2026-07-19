export type TestListener = (event: Record<string, unknown>) => void;

export interface TestEvent extends Record<string, unknown> {
  key?: string;
  prevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export class TestClassList {
  private readonly values = new Set<string>();

  add(...values: string[]): void {
    for (const value of values) this.values.add(value);
  }

  remove(...values: string[]): void {
    for (const value of values) this.values.delete(value);
  }

  contains(value: string): boolean {
    return this.values.has(value);
  }

  has(value: string): boolean {
    return this.contains(value);
  }

  entries(): string[] {
    return [...this.values];
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.values[Symbol.iterator]();
  }

  toString(): string {
    return this.entries().join(' ');
  }
}

export type TestNode = TestElement | TestText;

export class TestText {
  readonly nodeType = 3;
  parentElement: TestElement | null = null;
  parentNode: TestElement | null = null;

  constructor(readonly nodeValue: string) {}

  get textContent(): string {
    return this.nodeValue;
  }
}

export class TestElement {
  readonly nodeType = 1;
  readonly childNodes: TestNode[] = [];
  readonly children: TestElement[] = [];
  readonly classList = new TestClassList();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, TestListener[]>();
  readonly style: Record<string, string> = {};
  parentElement: TestElement | null = null;
  parentNode: TestElement | null = null;
  private ownTextContent = '';
  innerHTML = '';
  id = '';
  className = '';
  title = '';
  disabled = false;
  tabIndex = -1;
  offsetHeight = 20;
  isConnected = true;
  private readonly attrs = new Map<string, string>();

  constructor(
    readonly tagName: string,
    private readonly ownerDocument?: TestDocument,
    attrs: Record<string, string> = {},
  ) {
    for (const [name, value] of Object.entries(attrs)) {
      this.attrs.set(name, value);
      if (name === 'id') this.id = value;
    }
  }

  append(...children: TestNode[]): void {
    for (const child of children) this.appendNode(child);
  }

  appendChild(child: TestElement): TestElement {
    this.appendNode(child);
    return child;
  }

  insertBefore(child: TestElement, reference: TestElement): TestElement {
    const childIndex = this.childNodes.indexOf(reference);
    const elementIndex = this.children.indexOf(reference);
    if (childIndex === -1 || elementIndex === -1) throw new Error('Reference node is not a child');
    child.parentElement = this;
    child.parentNode = this;
    this.childNodes.splice(childIndex, 0, child);
    this.children.splice(elementIndex, 0, child);
    return child;
  }

  removeChild(child: TestElement): TestElement {
    const childIndex = this.childNodes.indexOf(child);
    if (childIndex !== -1) this.childNodes.splice(childIndex, 1);
    const elementIndex = this.children.indexOf(child);
    if (elementIndex !== -1) this.children.splice(elementIndex, 1);
    child.parentElement = null;
    child.parentNode = null;
    return child;
  }

  remove(): void {
    if (this.parentElement) this.parentElement.removeChild(this);
  }

  private appendNode(child: TestNode): void {
    child.parentElement = this;
    child.parentNode = this;
    this.childNodes.push(child);
    if (child instanceof TestElement) this.children.push(child);
  }

  get textContent(): string {
    return this.ownTextContent !== ''
      ? this.ownTextContent
      : this.childNodes.length
        ? this.childNodes.map((child) => child.textContent).join('')
        : this.ownTextContent;
  }

  set textContent(value: string) {
    this.ownTextContent = value;
    this.childNodes.length = 0;
    this.children.length = 0;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === 'id') this.id = value;
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === 'id') this.id = '';
  }

  addEventListener(type: string, listener: TestListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  click(): void {
    this.dispatch('click', {
      target: this,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
  }

  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  closest(selector: string): TestElement | null {
    let cur: TestElement | null = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  contains(other: unknown): boolean {
    let cur: TestElement | TestText | null = other instanceof TestElement || other instanceof TestText ? other : null;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  matches(selector: string): boolean {
    return selector.split(',').some((part) => this.matchesOne(part.trim()));
  }

  querySelectorAll(selector: string): TestElement[] {
    const out: TestElement[] = [];
    const visit = (node: TestElement): void => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  cloneNode(deep: boolean): TestElement {
    const clone = new TestElement(this.tagName, this.ownerDocument);
    clone.textContent = this.textContent;
    clone.innerHTML = this.innerHTML;
    clone.id = this.id;
    clone.className = this.className;
    clone.title = this.title;
    clone.tabIndex = this.tabIndex;
    for (const [name, value] of this.attrs) clone.attrs.set(name, value);
    for (const value of this.classList.entries()) clone.classList.add(value);
    Object.assign(clone.style, this.style);
    Object.assign(clone.dataset, this.dataset);
    if (deep) {
      for (const child of this.childNodes) {
        clone.append(child instanceof TestText ? new TestText(child.nodeValue) : child.cloneNode(true));
      }
    }
    return clone;
  }

  getBoundingClientRect(): { left: number; top: number; bottom: number } {
    return { left: 120, top: 40, bottom: 60 };
  }

  get outerHTML(): string {
    const tag = this.tagName.toLowerCase();
    const attrs: string[] = [];
    const classValue = this.classList.toString() || this.className;
    if (classValue) attrs.push(`class="${escapeAttr(classValue)}"`);
    for (const [name, value] of this.attrs) attrs.push(`${name}="${escapeAttr(value)}"`);
    const body =
      this.innerHTML !== ''
        ? this.innerHTML
        : this.childNodes.length
          ? this.childNodes.map((child) => (child instanceof TestText ? escapeHtml(child.nodeValue) : child.outerHTML)).join('')
          : escapeHtml(this.textContent);
    return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${body}</${tag}>`;
  }

  private matchesOne(selector: string): boolean {
    if (!selector) return false;
    if (selector.startsWith('.') && /^[.][a-z0-9_-]+$/i.test(selector)) {
      return this.classList.contains(selector.slice(1));
    }
    if (/^[a-z][a-z0-9-]*$/i.test(selector)) return this.tagName.toLowerCase() === selector.toLowerCase();

    const tagWithAttrs = /^([a-z][a-z0-9-]*)(\[.+\])$/i.exec(selector);
    if (tagWithAttrs) {
      return this.tagName.toLowerCase() === tagWithAttrs[1].toLowerCase() && this.matchesOne(tagWithAttrs[2]);
    }

    const attrParts = [...selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
    if (attrParts.length > 0 && attrParts.map((match) => match[0]).join('') === selector) {
      return attrParts.every((match) => {
        const value = this.getAttribute(match[1]);
        return match[2] === undefined ? value !== null : value === match[2];
      });
    }

    return false;
  }
}

export class TestDocument {
  readonly body: TestElement;
  readonly main: TestElement;
  readonly listeners = new Map<string, TestListener[]>();
  activeElement: TestElement | null = null;

  constructor() {
    this.body = new TestElement('body', this);
    this.main = new TestElement('main', this);
    this.body.appendChild(this.main);
  }

  createElement(tag: string): TestElement {
    return new TestElement(tag, this);
  }

  createTextNode(text: string): TestText {
    return new TestText(text);
  }

  querySelector(selector: string): TestElement | null {
    if (selector === 'body') return this.body;
    if (selector === 'main') return this.main;
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector: string): TestElement[] {
    if (selector === 'body') return [this.body];
    if (selector === 'main') return [this.main];
    return this.body.querySelectorAll(selector);
  }

  getElementById(id: string): TestElement | null {
    if (this.body.id === id) return this.body;
    return this.findById(this.body, id);
  }

  private findById(root: TestElement, id: string): TestElement | null {
    for (const child of root.children) {
      if (child.id === id || child.getAttribute('id') === id) return child;
      const nested = this.findById(child, id);
      if (nested) return nested;
    }
    return null;
  }

  addEventListener(type: string, listener: TestListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
}

export function keyEvent(key: string): TestEvent {
  return {
    key,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}
