import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import WorkersList from "@/app/director/workers/page";

jest.setTimeout(15000);

jest.mock("@/components/loading-animation", () => ({
  __esModule: true,
  default: function Loading() {
    return <div data-testid="loading" />;
  },
}));

const toastSuccessMock = jest.fn();
const toastErrorMock = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    success: (...args: any[]) => toastSuccessMock(...args),
    error: (...args: any[]) => toastErrorMock(...args),
  },
}));

const replaceMock = jest.fn();
const pushMock = jest.fn();
const routerMock = { replace: replaceMock, push: pushMock };

jest.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
}));

describe("/director/workers", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    localStorage.setItem("access_token", "test-token");
    jest.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders workers, filters by site/name, and navigates to worker details", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/all-workers") {
        return Promise.resolve([
          { id: 11, site_id: 1, name: "Yoeli", max_shifts: 5, roles: ["Guard"], availability: {} },
          { id: 12, site_id: 2, name: "Moshe", max_shifts: 4, roles: [], availability: {} },
        ]);
      }
      if (path === "/director/sites/") {
        return Promise.resolve([
          { id: 1, name: "Alpha Site", workers_count: 1 },
          { id: 2, name: "Beta Site", workers_count: 1 },
        ]);
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkersList />);

    expect((await screen.findAllByText("רשימת עובדים")).length).toBeGreaterThan(0);
    expect(await screen.findByTitle("Yoeli")).toBeInTheDocument();
    expect(await screen.findByTitle("Moshe")).toBeInTheDocument();

    const searchInput = (await screen.findAllByLabelText("חיפוש עובד לפי שם, טלפון או אתר"))[0];
    const user = userEvent.setup();
    await user.type(searchInput, "Alpha");

    await waitFor(() => {
      expect(screen.getByTitle("Yoeli")).toBeInTheDocument();
      expect(screen.queryByTitle("Moshe")).not.toBeInTheDocument();
    });

    const editButtons = screen.getAllByRole("button", { name: "ערוך" });
    await user.click(editButtons[0]);

    expect(pushMock).toHaveBeenCalledWith("/director/workers/11");
  });

  it("adds a worker from the modal", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: any) => {
      if (path === "/director/sites/all-workers") {
        return Promise.resolve([{ id: 11, site_id: 1, name: "Yoeli", max_shifts: 5, roles: ["Guard"], availability: {} }]);
      }
      if (path === "/director/sites/" && !options?.method) {
        return Promise.resolve([{ id: 1, name: "Alpha Site", workers_count: 1 }]);
      }
      if (path === "/director/sites/1/create-worker-user" && options?.method === "POST") {
        return Promise.resolve({});
      }
      if (path === "/director/sites/1/workers" && options?.method === "POST") {
        return Promise.resolve({ id: 15 });
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<WorkersList />);

    expect((await screen.findAllByText("רשימת עובדים")).length).toBeGreaterThan(0);
    await screen.findByTitle("Yoeli");

    const user = userEvent.setup();
    const addButtons = screen.getAllByRole("button", { name: "הוסף עובד" });
    await user.click(addButtons[0]);

    expect(await screen.findByText("הוסף עובד חדש")).toBeInTheDocument();

    const siteSelect = screen.getByRole("combobox");
    await user.selectOptions(siteSelect, "1");

    await user.type(screen.getByPlaceholderText("הזן שם עובד"), "New Worker");
    await user.type(screen.getByPlaceholderText("הזן מספר טלפון"), "0585060398");

    await user.click(screen.getByRole("button", { name: "הוסף" }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        "/director/sites/1/create-worker-user",
        expect.objectContaining({ method: "POST" }),
      );
      expect(apiFetch).toHaveBeenCalledWith(
        "/director/sites/1/workers",
        expect.objectContaining({ method: "POST" }),
      );
    });

    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("redirects worker users away from director workers", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "worker", full_name: "Yoeli" });

    render(<WorkersList />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/worker");
    });
  });
});

