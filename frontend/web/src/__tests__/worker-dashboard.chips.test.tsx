import React from "react";
import { render, screen } from "@testing-library/react";

import WorkerDashboard from "@/app/worker/page";

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

describe("/worker dashboard planning table chips", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    localStorage.setItem("access_token", "test-token");
  });

  afterEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it("shows role-colored placeholders when a required slot is empty", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "worker", full_name: "Yoeli" });

    const config = {
      stations: [
        {
          name: "עמדה 1",
          uniformRoles: false,
          shifts: [
            {
              name: "06-14",
              enabled: true,
              workers: 1,
              roles: [{ name: "חמוש", count: 1 }],
            },
          ],
        },
      ],
    };

    const emptyAssignments = {
      sun: { "06-14": [[]] },
      mon: { "06-14": [[]] },
      tue: { "06-14": [[]] },
      wed: { "06-14": [[]] },
      thu: { "06-14": [[]] },
      fri: { "06-14": [[]] },
      sat: { "06-14": [[]] },
    };

    const weekPlan = {
      assignments: emptyAssignments,
      workers: [{ name: "Yoeli", roles: ["חמוש"] }],
      pulls: {},
    };

    apiFetch.mockImplementation((path: string) => {
      if (path === "/public/sites/worker-sites") return Promise.resolve([{ id: 7, name: "Site A" }]);
      if (path === "/public/sites/7/config") return Promise.resolve({ id: 7, name: "Site A", config });
      if (String(path).startsWith("/public/sites/7/week-plan?week=")) return Promise.resolve(weekPlan);
      if (String(path).startsWith("/public/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerDashboard />);

    // When loaded, role placeholder should appear in the empty slot
    expect(await screen.findAllByText("חמוש")).not.toHaveLength(0);
  });
});

