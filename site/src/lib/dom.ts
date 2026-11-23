// Small safe element builder: strings become text nodes, never HTML.
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function replaceChildren(target: HTMLElement, ...children: Child[]): void {
  target.replaceChildren();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    target.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}
