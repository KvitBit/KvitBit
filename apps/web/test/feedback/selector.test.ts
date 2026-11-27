import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { elementPaths } from "../../src/runtime/feedback/selector";

const pathsFor = (
  element: Parameters<typeof elementPaths>[0],
  includeIdentifiers: boolean,
  maxLength: number,
) => {
  const paths = elementPaths(element, includeIdentifiers, maxLength);
  if (paths === undefined) throw new Error("Expected a unique selector for the fixture");
  return paths;
};

const fixture = () => {
  const window = new Window();
  // Use the emulated DOM at the browser API boundary.
  const document = window.document;
  const element = (
    tag: string,
    className = "",
    ...children: ReturnType<typeof document.createElement>[]
  ) => {
    const node = document.createElement(tag);
    node.className = className;
    node.append(...children);
    return node;
  };
  return { document, element };
};

describe("feedback selectors", () => {
  test("escapes a Kvitbit ID and records its structural ancestry", () => {
    const { document, element } = fixture();
    const button = element("button");
    button.id = "kb-confirm:primary";
    document.body.append(element("main", "", button));

    const { selector, domPath } = pathsFor(button, true, 1_000);
    expect(selector).toBe("#kb-confirm\\:primary");
    expect(domPath).toBe(
      "html > body:nth-of-type(1) > main:nth-of-type(1) > button:nth-of-type(1)",
    );
    expect(document.querySelector(selector)).toBe(button);
    expect(document.querySelector(domPath)).toBe(button);
  });

  test("qualifies repeated siblings with their position and a named ancestor", () => {
    const { document, element } = fixture();
    const button = element("button");
    document.body.append(
      element("section", "kb-primary-actions", element("button"), button),
      element("section", "", element("button"), element("button")),
    );

    const { selector } = pathsFor(button, true, 1_000);
    expect(selector).toBe("section.kb-primary-actions > button:nth-of-type(2)");
    expect(Array.from(document.querySelectorAll(selector))).toEqual([button]);
  });

  test("omits identifiers on sensitive pages and bounds long paths", () => {
    const { document, element } = fixture();
    const button = element("button");
    const container = element("div", "kb-secret", element("div", "", element("div", "", button)));
    container.id = "kb-secret";
    document.body.append(container, element("button"));

    const { selector, domPath } = pathsFor(button, false, 1_000);
    expect(selector).not.toContain("kb-secret");
    expect(document.querySelector(selector)).toBe(button);
    expect(document.querySelector(domPath)).toBe(button);
    const bounded = pathsFor(button, false, 48);
    expect(bounded.selector.length).toBeLessThanOrEqual(48);
    expect(bounded.domPath.length).toBeLessThanOrEqual(48);
  });

  test("declines a pin when its bounded path matches two branches", () => {
    const { document, element } = fixture();
    const first = element("button");
    const second = element("button");
    const branch = (leaf: ReturnType<typeof element>) => {
      let node = leaf;
      for (let level = 0; level < 70; level++) node = element("div", "", node);
      return node;
    };
    document.body.append(branch(first), branch(second));

    expect(elementPaths(second, true, 1_000)).toBeUndefined();
    const { selector } = pathsFor(second, true, 2_000);
    expect(Array.from(document.querySelectorAll(selector))).toEqual([second]);
  });
});
