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

let consoleLogSpy: jest.SpyInstance | undefined;

beforeEach(() => {
  consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy?.mockRestore();
  consoleLogSpy = undefined;
});

