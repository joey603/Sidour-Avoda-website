import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";

import WorkerAvailabilityPage from "@/app/worker/availability/page";

jest.setTimeout(15000);

jest.mock("@/components/loading-animation", () => ({
  __esModule: true,
  default: function Loading() {
    return <div data-testid="loading" />;
  },
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
    info: jest.fn(),
  },
}));

const replaceMock = jest.fn();
const routerMock = { replace: replaceMock };
jest.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("/worker/availability loading", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    // localStorage access_token used by apiFetch headers in code
    localStorage.setItem("access_token", "test-token");
  });

  afterEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it("keeps the loading screen until site info + DB data are loaded", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "worker", full_name: "Yoeli" });

    const infoDef = deferred<{ id: number; name: string; shifts: string[]; questions?: any[] }>();
    const availDef = deferred<any>();

    apiFetch.mockImplementation((path: string) => {
      if (path === "/public/sites/worker-sites") {
        return Promise.resolve([{ id: 7, name: "Site A" }]);
      }
      if (path === "/public/sites/7/info") return infoDef.promise;
      if (String(path).startsWith("/public/sites/7/worker-availability?week_key=")) return availDef.promise;
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerAvailabilityPage />);

    // initial loading
    expect(screen.getByTestId("loading")).toBeInTheDocument();

    // Wait until the component requested site info (means: worker-sites loaded and auto-select happened)
    await waitFor(() => {
      const calls = (apiFetch as jest.Mock).mock.calls.map((c: any[]) => String(c[0]));
      expect(calls.includes("/public/sites/7/info")).toBe(true);
    });

    // still loading while info unresolved
    expect(screen.getByTestId("loading")).toBeInTheDocument();

    // Resolve info first
    await act(async () => {
      infoDef.resolve({ id: 7, name: "Site A", shifts: ["06-14"], questions: [] });
    });

    // Wait until the component requested worker availability from DB
    await waitFor(() => {
      const calls = (apiFetch as jest.Mock).mock.calls.map((c: any[]) => String(c[0]));
      expect(calls.some((p) => p.startsWith("/public/sites/7/worker-availability?week_key="))).toBe(true);
    });

    // Still loading until availability resolves
    expect(screen.getByTestId("loading")).toBeInTheDocument();

    // Resolve availability
    await act(async () => {
      availDef.resolve({
        id: 19,
        name: "Yoeli",
        max_shifts: 5,
        roles: [],
        availability: { sun: ["06-14"], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
        answers: { general: {}, perDay: {} },
      });
    });

    // loading should be gone and the page should render
    expect(await screen.findByText("רישום זמינות", {}, { timeout: 10000 })).toBeInTheDocument();
    expect(screen.queryByTestId("loading")).not.toBeInTheDocument();
  });
});

