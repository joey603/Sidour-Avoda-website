import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import WorkerDetailsPage from "@/app/director/workers/[id]/page";

jest.setTimeout(15000);

jest.mock("@/components/loading-animation", () => ({
  __esModule: true,
  default: function Loading() {
    return <div data-testid="loading" />;
  },
}));

const replaceMock = jest.fn();
const backMock = jest.fn();
const pushMock = jest.fn();
const routerMock = { replace: replaceMock, back: backMock, push: pushMock };

jest.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useParams: () => ({ id: "11" }),
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
}));

describe("/director/workers/[id]", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    backMock.mockReset();
    pushMock.mockReset();
    localStorage.setItem("access_token", "test-token");
    jest.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders worker details and empty week-plan fallback", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/all-workers") {
        return Promise.resolve([
          { id: 11, site_id: 1, name: "Yoeli", phone: "0585060398", max_shifts: 5, roles: ["Guard"], availability: {} },
        ]);
      }
      if (path === "/director/sites/") {
        return Promise.resolve([{ id: 1, name: "Alpha Site", workers_count: 1 }]);
      }
      if (path === "/director/sites/1") {
        return Promise.resolve({ id: 1, name: "Alpha Site", config: { stations: [] } });
      }
      if (String(path).startsWith("/public/sites/1/week-plan?week=")) {
        return Promise.resolve({});
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerDetailsPage />);

    expect(await screen.findByText("עריכת עובד")).toBeInTheDocument();
    expect(await screen.findByText("Alpha Site")).toBeInTheDocument();
    expect(await screen.findByText("0585060398")).toBeInTheDocument();
    expect(await screen.findByText("אין נתוני תכנון שמורים לשבוע זה.")).toBeInTheDocument();
  });

  it("updates worker phone from the identity editor", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: any) => {
      if (path === "/director/sites/all-workers") {
        return Promise.resolve([
          { id: 11, site_id: 1, name: "Yoeli", phone: "0585060398", max_shifts: 5, roles: ["Guard"], availability: {} },
        ]);
      }
      if (path === "/director/sites/") {
        return Promise.resolve([{ id: 1, name: "Alpha Site", workers_count: 1 }]);
      }
      if (path === "/director/sites/1" && !options?.method) {
        return Promise.resolve({ id: 1, name: "Alpha Site", config: { stations: [] } });
      }
      if (String(path).startsWith("/public/sites/1/week-plan?week=")) {
        return Promise.resolve({});
      }
      if (path === "/director/sites/1/workers/11" && options?.method === "PUT") {
        return Promise.resolve({
          id: 11,
          site_id: 1,
          name: "Yoeli",
          phone: "0500000000",
          max_shifts: 5,
          roles: ["Guard"],
          availability: {},
        });
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerDetailsPage />);

    expect(await screen.findByText("0585060398")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ערוך מספר טלפון" }));

    const phoneInput = screen.getByDisplayValue("0585060398");
    await user.clear(phoneInput);
    await user.type(phoneInput, "0500000000");
    await user.click(screen.getByRole("button", { name: "שמור" }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        "/director/sites/1/workers/11",
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"phone":"0500000000"'),
        }),
      );
    });

    expect(await screen.findByText("0500000000")).toBeInTheDocument();
  });

  it("shows worker-not-found error when the id is missing from the worker list", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/all-workers") return Promise.resolve([]);
      if (path === "/director/sites/") return Promise.resolve([{ id: 1, name: "Alpha Site", workers_count: 1 }]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerDetailsPage />);

    expect(await screen.findByText("עובד לא נמצא")).toBeInTheDocument();
  });

  it("redirects unauthenticated users to director login", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue(null);

    render(<WorkerDetailsPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/login/director");
    });
  });

  it("redirects worker users away from worker details page", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "worker", full_name: "Yoeli" });

    render(<WorkerDetailsPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/worker");
    });
  });

  it("reloads week plan when moving to the next week", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: any) => {
      if (path === "/director/sites/all-workers") {
        return Promise.resolve([
          { id: 11, site_id: 1, name: "Yoeli", phone: "0585060398", max_shifts: 5, roles: ["Guard"], availability: {} },
        ]);
      }
      if (path === "/director/sites/") {
        return Promise.resolve([{ id: 1, name: "Alpha Site", workers_count: 1 }]);
      }
      if (path === "/director/sites/1" && !options?.method) {
        return Promise.resolve({ id: 1, name: "Alpha Site", config: { stations: [] } });
      }
      if (String(path).startsWith("/public/sites/1/week-plan?week=")) {
        return Promise.resolve({});
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerDetailsPage />);

    await screen.findByText("Alpha Site");

    const before = (apiFetch as jest.Mock).mock.calls.filter((call: any[]) =>
      String(call[0]).startsWith("/public/sites/1/week-plan?week="),
    ).length;

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "שבוע הבא" }));

    await waitFor(() => {
      const after = (apiFetch as jest.Mock).mock.calls.filter((call: any[]) =>
        String(call[0]).startsWith("/public/sites/1/week-plan?week="),
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("navigates back and to the site edit page", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/all-workers") {
        return Promise.resolve([
          { id: 11, site_id: 1, name: "Yoeli", phone: "0585060398", max_shifts: 5, roles: ["Guard"], availability: {} },
        ]);
      }
      if (path === "/director/sites/") {
        return Promise.resolve([{ id: 1, name: "Alpha Site", workers_count: 1 }]);
      }
      if (path === "/director/sites/1") {
        return Promise.resolve({ id: 1, name: "Alpha Site", config: { stations: [] } });
      }
      if (String(path).startsWith("/public/sites/1/week-plan?week=")) {
        return Promise.resolve({});
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerDetailsPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "חזרה" }));
    expect(backMock).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "ערוך באתר" }));
    expect(pushMock).toHaveBeenCalledWith("/director/sites/1/edit");
  });

  it("loads week plan from localStorage fallback and keeps worker identity from DB", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = today.getDay();
    const startThisWeek = new Date(today);
    startThisWeek.setDate(today.getDate() - day);
    const nextWeek = new Date(startThisWeek);
    nextWeek.setDate(startThisWeek.getDate() + 7);
    const iso = `${nextWeek.getFullYear()}-${String(nextWeek.getMonth() + 1).padStart(2, "0")}-${String(nextWeek.getDate()).padStart(2, "0")}`;

    localStorage.setItem(
      `plan_1_${iso}`,
      JSON.stringify({
        assignments: { sun: { "06-14": [["Yoeli"]] } },
        isManual: false,
        workers: [
          {
            id: 11,
            name: "Yoeli",
            phone: "0000000000",
            max_shifts: 8,
            roles: ["Lead"],
            availability: { sun: ["06-14"] },
          },
        ],
      }),
    );

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/all-workers") {
        return Promise.resolve([
          {
            id: 11,
            site_id: 1,
            name: "Yoeli",
            phone: "0585060398",
            max_shifts: 5,
            roles: ["Guard"],
            availability: {},
          },
        ]);
      }
      if (path === "/director/sites/") {
        return Promise.resolve([{ id: 1, name: "Alpha Site", workers_count: 1 }]);
      }
      if (path === "/director/sites/1") {
        return Promise.resolve({
          id: 1,
          name: "Alpha Site",
          config: {
            stations: [
              {
                name: "Gate",
                shifts: [{ name: "06-14", enabled: true, workers: 1, start: "06:00", end: "14:00" }],
              },
            ],
          },
        });
      }
      if (String(path).startsWith("/public/sites/1/week-plan?week=")) {
        return Promise.resolve({});
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerDetailsPage />);

    expect(await screen.findByText("Gate")).toBeInTheDocument();
    expect((await screen.findAllByText("06:00-14:00")).length).toBeGreaterThan(0);
    expect(screen.getByText("0585060398")).toBeInTheDocument();
    expect(screen.getAllByText("Lead").length).toBeGreaterThan(0);
  });

  it("shows an update error when identity save fails", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: any) => {
      if (path === "/director/sites/all-workers") {
        return Promise.resolve([
          { id: 11, site_id: 1, name: "Yoeli", phone: "0585060398", max_shifts: 5, roles: ["Guard"], availability: {} },
        ]);
      }
      if (path === "/director/sites/") {
        return Promise.resolve([{ id: 1, name: "Alpha Site", workers_count: 1 }]);
      }
      if (path === "/director/sites/1" && !options?.method) {
        return Promise.resolve({ id: 1, name: "Alpha Site", config: { stations: [] } });
      }
      if (String(path).startsWith("/public/sites/1/week-plan?week=")) {
        return Promise.resolve({});
      }
      if (path === "/director/sites/1/workers/11" && options?.method === "PUT") {
        return Promise.reject(new Error("save failed"));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkerDetailsPage />);

    await screen.findByText("0585060398");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ערוך מספר טלפון" }));

    const phoneInput = screen.getByDisplayValue("0585060398");
    await user.clear(phoneInput);
    await user.type(phoneInput, "0500000000");
    await user.click(screen.getByRole("button", { name: "שמור" }));

    expect(await screen.findByText("save failed")).toBeInTheDocument();
    expect(screen.getByDisplayValue("0500000000")).toBeInTheDocument();
  });
});

