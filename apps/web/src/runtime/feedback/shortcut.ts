import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

const editableControl =
  'input, textarea, select, [role~="textbox"], [role~="searchbox"], [role~="combobox"]';

type ShortcutEvent = Pick<
  KeyboardEvent,
  | "key"
  | "ctrlKey"
  | "metaKey"
  | "altKey"
  | "shiftKey"
  | "repeat"
  | "isComposing"
  | "defaultPrevented"
> & {
  readonly target: unknown;
  readonly composedPath: () => ReadonlyArray<unknown>;
};

interface ShortcutDocument<Element> {
  readonly defaultView: {
    readonly Element: { readonly prototype: Element; new (): Element };
  } | null;
  readonly activeElement: unknown;
}

type EditableElement = { readonly closest: (selector: string) => unknown };

const isFeedbackShortcutImpl = <Element extends EditableElement>(
  event: ShortcutEvent,
  document: ShortcutDocument<Element>,
): boolean => {
  if (
    Str.toLowerCase(event.key) !== "k" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    event.repeat ||
    event.isComposing ||
    event.defaultPrevented
  ) {
    return false;
  }

  const ElementClass = document.defaultView?.Element;
  if (ElementClass === undefined) return false;
  const path = event.composedPath();
  const targets = path.length > 0 ? path : [event.target, document.activeElement];
  return !Arr.some(
    targets,
    (target) =>
      target instanceof ElementClass &&
      (target.closest(editableControl) !== null ||
        ("isContentEditable" in target && target.isContentEditable === true)),
  );
};

export const isFeedbackShortcut: {
  <Element extends EditableElement>(
    document: ShortcutDocument<Element>,
  ): (event: ShortcutEvent) => boolean;
  <Element extends EditableElement>(
    event: ShortcutEvent,
    document: ShortcutDocument<Element>,
  ): boolean;
} = Fn.dual(2, isFeedbackShortcutImpl);
