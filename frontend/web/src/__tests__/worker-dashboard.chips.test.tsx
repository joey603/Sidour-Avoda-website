import React from "react";
import { render, screen } from "@testing-library/react";

import WorkerDashboard from "@/app/worker/page";

jest.setTimeout(15000);

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

  peekCachedMe: jest.fn(() => null),
  AUTH_SESSION_CHANGED_EVENT: "auth-session-changed",
  notifyAuthSessionChanged: jest.fn(),
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
              roles: [{ name: "חמוש", count: 1, enabled: true }],
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
      if (String(path).startsWith("/public/sites/worker-home")) {
        return Promise.resolve({
          sites: [
            {
              id: 7,
              name: "Site A",
              config,
              current_week_plan: weekPlan,
              next_week_plan: weekPlan,
              messages_current: [],
              messages_next: [],
            },
          ],
        });
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerDashboard />);

    // When loaded, role placeholder should appear in the empty slot
    expect(await screen.findAllByText("חמוש")).not.toHaveLength(0);
  });
});

