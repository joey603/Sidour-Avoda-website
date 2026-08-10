import "@testing-library/jest-dom";

// Some components rely on browser APIs that JSDOM doesn't implement.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {}, // deprecated
    removeListener: () => {}, // deprecated
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// next/font mock (prevents errors if layout is imported)
jest.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono" }),
}));

// ESM-only libs used in pages (mock to avoid Jest ESM parsing issues)
jest.mock("react-markdown", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require("react");
  return {
    __esModule: true,
    default: ({ children }: any) => React.createElement(React.Fragment, null, children),
  };
});
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("dompurify", () => ({ __esModule: true, default: { sanitize: (html: any) => html } }));

// lottie-react + canvas (évite erreurs JSDOM sur LoadingAnimation et pages qui l’importent)
jest.mock("lottie-react", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require("react");
  return {
    __esModule: true,
    default: () => React.createElement("div", { "data-testid": "lottie-mock" }),
  };
});

// ResizeObserver mock (used by some UI libs)
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverMock;

// IntersectionObserver (landing page / scroll reveals)
class IntersectionObserverMock {
  constructor(callback: IntersectionObserverCallback) {
    this._callback = callback;
  }
  _callback: IntersectionObserverCallback;
  observe() {
    this._callback(
      [{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = "";
  thresholds = [];
}
global.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver;

// Mock commun loading-animation (default + LoadingOverlay)
jest.mock("@/components/loading-animation", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require("react");
  const Loading = (props: any) => React.createElement("div", { "data-testid": "loading", ...props });
  const LoadingOverlay = (props: any) => React.createElement("div", { "data-testid": "loading-overlay", ...props });
  return { __esModule: true, default: Loading, LoadingOverlay };
});

let consoleLogSpy: jest.SpyInstance | undefined;

beforeEach(() => {
  consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy?.mockRestore();
  consoleLogSpy = undefined;
});

