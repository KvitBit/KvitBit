import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";

const codeIdentifier = /^(?:main$|root$|kb-[a-zA-Z][a-zA-Z0-9_:-]{0,43}$)/;

interface SelectorElement {
  readonly id: string;
  readonly localName: string;
  readonly previousElementSibling: SelectorElement | null;
  readonly parentElement: SelectorElement | null;
  readonly children: ArrayLike<SelectorElement>;
  readonly classList: Iterable<string>;
  readonly matches: (selector: string) => boolean;
  readonly ownerDocument: {
    readonly defaultView: { readonly CSS: { readonly escape: (text: string) => string } } | null;
    readonly querySelectorAll: (selector: string) => ArrayLike<SelectorElement>;
  };
}

const position = (element: SelectorElement): number => {
  let index = 1;
  for (
    let sibling = element.previousElementSibling;
    sibling !== null;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.localName === element.localName) index++;
  }
  return index;
};

/** Prefer short, unique code identifiers. Fall back to a structural selector for repeated items. */
const elementPathsImpl = (
  element: SelectorElement,
  includeIdentifiers: boolean,
  maxLength: number,
) => {
  const document = element.ownerDocument;
  const escapeIdentifier = document.defaultView?.CSS.escape ?? CSS.escape;
  const unique = (currentSelector: string) => {
    if (currentSelector.length > maxLength) return false;
    const matches = document.querySelectorAll(currentSelector);
    return matches.length === 1 && matches[0] === element;
  };

  let domPath = "";
  let selector = "";
  let uniqueSelector: string | undefined;
  for (let node: SelectorElement | null = element; node !== null; node = node.parentElement) {
    const tag = escapeIdentifier(node.localName);
    const ordinal = node.parentElement === null ? tag : `${tag}:nth-of-type(${position(node)})`;
    const path = domPath === "" ? ordinal : `${ordinal} > ${domPath}`;
    if (path.length > maxLength) break;
    domPath = path;

    if (uniqueSelector !== undefined) continue;
    const id =
      includeIdentifiers && codeIdentifier.test(node.id) ? `#${escapeIdentifier(node.id)}` : "";
    const classes = includeIdentifiers
      ? Arr.filter(Array.from(node.classList), (name) => codeIdentifier.test(name)).slice(0, 2)
      : [];
    const suffix = selector;
    const qualify = (part: string) => (suffix === "" ? part : `${part} > ${suffix}`);
    const candidates = Arr.filter(
      [id, ...Arr.map(classes, (name) => `${tag}.${escapeIdentifier(name)}`), tag],
      Boolean,
    );
    uniqueSelector = Arr.findFirst(Arr.map(candidates, qualify), unique).pipe(
      Option.getOrUndefined,
    );
    const siblings = node.parentElement?.children;
    const distinctive = Arr.findFirst(candidates, (part) => {
      if (siblings === undefined) return true;
      return Arr.filter(Array.from(siblings), (sibling) => sibling.matches(part)).length === 1;
    }).pipe(Option.getOrUndefined);
    selector = qualify(distinctive ?? ordinal);
    uniqueSelector ??= unique(selector) ? selector : undefined;
  }
  if (uniqueSelector !== undefined) return { selector: uniqueSelector, domPath };
  return domPath !== "" && unique(domPath) ? { selector: domPath, domPath } : undefined;
};

export const elementPaths: {
  (
    includeIdentifiers: boolean,
    maxLength: number,
  ): (element: SelectorElement) => ReturnType<typeof elementPathsImpl>;
  (
    element: SelectorElement,
    includeIdentifiers: boolean,
    maxLength: number,
  ): ReturnType<typeof elementPathsImpl>;
} = Fn.dual(3, elementPathsImpl);
