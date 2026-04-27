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
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("/worker/availability loading", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    localStorage.setItem("access_token", "test-token");
  });

  afterEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it("keeps the loading screen until worker-context is loaded", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "worker", full_name: "Yoeli", id: 19 });

    const ctxDef = deferred<{
      worker_name: string;
      sites: Array<{ id: number; name: string }>;
      shifts: string[];
      questions: unknown[];
      max_shifts: number;
      roles: string[];
      availability: Record<string, string[]>;
      answers: { general: Record<string, unknown>; perDay: Record<string, unknown> };
    }>();

    apiFetch.mockImplementation((path: string) => {
      if (String(path).startsWith("/public/sites/worker-context?week_key=")) return ctxDef.promise;
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerAvailabilityPage />);

    expect(screen.getByTestId("loading")).toBeInTheDocument();

    await waitFor(() => {
      const calls = (apiFetch as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calls.some((p) => p.startsWith("/public/sites/worker-context?week_key="))).toBe(true);
    });

    expect(screen.getByTestId("loading")).toBeInTheDocument();

    await act(async () => {
      ctxDef.resolve({
        worker_name: "Yoeli",
        sites: [{ id: 7, name: "Site A" }],
        shifts: ["06-14"],
        questions: [],
        max_shifts: 5,
        roles: [],
        availability: { sun: ["06-14"], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
        answers: { general: {}, perDay: {} },
      });
    });

    expect(await screen.findByText("רישום זמינות", {}, { timeout: 10000 })).toBeInTheDocument();
    expect(screen.queryByTestId("loading")).not.toBeInTheDocument();
  });
});
