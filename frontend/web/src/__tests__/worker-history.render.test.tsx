import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

import WorkerHistoryPage from "@/app/worker/history/page";

jest.setTimeout(15000);

jest.mock("@/components/loading-animation", () => ({
  __esModule: true,
  default: function Loading() {
    return <div data-testid="loading" />;
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

describe("/worker/history render", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    localStorage.setItem("access_token", "test-token");
    jest.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("loads a site plan and renders worker request data", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "worker", full_name: "Yoeli", id: 19 });

    apiFetch.mockImplementation((path: string) => {
      if (path === "/public/sites/worker-sites") {
        return Promise.resolve([{ id: 7, name: "Site A" }]);
      }
      if (path === "/public/sites/7/config") {
        return Promise.resolve({
          id: 7,
          name: "Site A",
          config: {
            stations: [
              {
                name: "Gate 1",
                uniformRoles: true,
                workers: 1,
                shifts: [{ name: "Morning", enabled: true, start: "06:00", end: "14:00" }],
              },
            ],
          },
        });
      }
      if (path === "/public/sites/7/worker-availability") {
        return Promise.resolve({
          id: 19,
          name: "Yoeli",
          max_shifts: 5,
          roles: ["Guard"],
          availability: { sun: ["Morning"], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
          answers: { general: {}, perDay: {} },
        });
      }
      if (String(path).startsWith("/public/sites/7/week-plan?week=")) {
        return Promise.resolve({
          assignments: {
            sun: { Morning: [["Yoeli"]] },
            mon: {},
            tue: {},
            wed: {},
            thu: {},
            fri: {},
            sat: {},
          },
          isManual: false,
          workers: [{ id: 19, name: "Yoeli", roles: ["Guard"] }],
          pulls: {},
        });
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerHistoryPage />);

    expect(await screen.findByText("היסטוריה")).toBeInTheDocument();
    expect(await screen.findByText("שיבוצים לשבוע הנוכחי")).toBeInTheDocument();
    expect(await screen.findByText("בקשות העובד")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByText("Yoeli").length).toBeGreaterThan(0);
    });

    expect(screen.getByText("Gate 1")).toBeInTheDocument();
    expect(screen.getByText("Guard")).toBeInTheDocument();
    expect(screen.getByText("Morning")).toBeInTheDocument();
  });
});

