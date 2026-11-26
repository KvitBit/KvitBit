import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

const bunFetchGlobals = {
  AbortController,
  AbortSignal,
  Headers,
  Request,
  Response,
  fetch,
};

let domRegistered = false;
let happyDomFetchGlobals: typeof bunFetchGlobals | null = null;

const ensureDom = () => {
  if (!domRegistered) {
    GlobalRegistrator.register();
    domRegistered = true;
    happyDomFetchGlobals = {
      AbortController: globalThis.AbortController,
      AbortSignal: globalThis.AbortSignal,
      Headers: globalThis.Headers,
      Request: globalThis.Request,
      Response: globalThis.Response,
      fetch: globalThis.fetch,
    };
  }
};

/**
 * A React client root for one test file, so rendered components run their
 * effects. Happy DOM is registered once per process so `react-dom/client` keeps
 * a live `window`/`MessageChannel` scheduler across test files; each file gets
 * a fresh root container that is unmounted in `afterAll`.
 * `keepFetch` keeps Bun's fetch, its Request, Response and Headers, and its
 * abort signals in place of the DOM's, for components that talk to a fake
 * server: the DOM's drop forbidden headers such as Cookie.
 */
export const clientRoot = ({ keepFetch = false }: { readonly keepFetch?: boolean } = {}) => {
  let root: Root;
  let container: HTMLElement;
  beforeAll(async () => {
    ensureDom();
    if (keepFetch) {
      Object.assign(globalThis, bunFetchGlobals);
    } else if (happyDomFetchGlobals !== null) {
      Object.assign(globalThis, happyDomFetchGlobals);
    }
    // React reads the act environment flag only once a DOM exists.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { createRoot } = await import("react-dom/client");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterAll(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return {
    render: (element: Parameters<Root["render"]>[0]) => act(async () => root.render(element)),
    /** The element the root renders into. */
    container: () => container,
  };
};
