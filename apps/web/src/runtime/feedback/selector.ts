const codeIdentifier = /^(?:main$|root$|kb-[a-zA-Z][a-zA-Z0-9_:-]{0,43}$)/;

const position = (element: Element): number => {
  let index = 1;
  for (
    let sibling = element.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.localName === element.localName) index++;
  }
  return index;
};

/** Prefer short, unique code identifiers. Fall back to a structural selector for repeated items. */
export const elementPaths = (element: Element, includeIdentifiers: boolean, maxLength: number) => {
  const document = element.ownerDocument;
  const escapeIdentifier = document.defaultView?.CSS.escape ?? CSS.escape;
  const unique = (selector: string) => {
    if (selector.length > maxLength) return false;
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  };

  let domPath = "";
  let selector = "";
  let uniqueSelector: string | undefined;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const tag = escapeIdentifier(node.localName);
    const ordinal = node.parentElement === null ? tag : `${tag}:nth-of-type(${position(node)})`;
    const path = domPath === "" ? ordinal : `${ordinal} > ${domPath}`;
    if (path.length > maxLength) break;
    domPath = path;

    if (uniqueSelector !== undefined) continue;
    const id =
      includeIdentifiers && codeIdentifier.test(node.id) ? `#${escapeIdentifier(node.id)}` : "";
    const classes = includeIdentifiers
      ? Array.from(node.classList)
          .filter((name) => codeIdentifier.test(name))
          .slice(0, 2)
      : [];
    const qualify = (part: string) => (selector === "" ? part : `${part} > ${selector}`);
    const candidates = [
      id,
      ...classes.map((name) => `${tag}.${escapeIdentifier(name)}`),
      tag,
    ].filter(Boolean);
    uniqueSelector = candidates.map(qualify).find(unique);
    const siblings = node.parentElement?.children;
    const distinctive = candidates.find((part) => {
      if (siblings === undefined) return true;
      return Array.from(siblings).filter((sibling) => sibling.matches(part)).length === 1;
    });
    selector = qualify(distinctive ?? ordinal);
    uniqueSelector ??= unique(selector) ? selector : undefined;
  }
  return { selector: uniqueSelector ?? domPath, domPath };
};
