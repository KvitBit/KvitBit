const editableControl =
  'input, textarea, select, [role~="textbox"], [role~="searchbox"], [role~="combobox"]';

export const isFeedbackShortcut = (event: KeyboardEvent, document: Document): boolean => {
  if (
    event.key.toLowerCase() !== "k" ||
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

  const Element = document.defaultView?.Element;
  if (Element === undefined) return false;
  const path = event.composedPath?.() ?? [];
  const targets = path.length > 0 ? path : [event.target, document.activeElement];
  return !targets.some(
    (target) =>
      target instanceof Element &&
      (target.closest(editableControl) !== null ||
        ("isContentEditable" in target && target.isContentEditable === true)),
  );
};
