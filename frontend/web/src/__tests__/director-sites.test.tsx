import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SitesList from "@/app/director/sites/page";

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

describe("/director/sites", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    localStorage.setItem("access_token", "test-token");
    window.confirm = jest.fn(() => true);
    jest.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders sites, filters by search, and navigates to add page", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockResolvedValue([
      { id: 1, name: "Alpha Site", workers_count: 3 },
      { id: 2, name: "Beta Site", workers_count: 5 },
    ]);

    render(<SitesList />);

    expect((await screen.findAllByText("רשימת אתרים")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Alpha Site")).toBeInTheDocument();
    expect(await screen.findByText("Beta Site")).toBeInTheDocument();

    const searchInput = (await screen.findAllByLabelText("חיפוש אתר"))[0];
    const user = userEvent.setup();
    await user.type(searchInput, "Alpha");

    await waitFor(() => {
      expect(screen.getAllByText("Alpha Site").length).toBeGreaterThan(0);
      expect(screen.queryByText("Beta Site")).not.toBeInTheDocument();
    });

    const addButtons = screen.getAllByRole("button", { name: "הוסף אתר" });
    await user.click(addButtons[0]);

    expect(pushMock).toHaveBeenCalledWith("/director/sites/new");
  });

  it("deletes a site after confirmation", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: any) => {
      if (path === "/director/sites/" && !options?.method) {
        return Promise.resolve([{ id: 1, name: "Alpha Site", workers_count: 3 }]);
      }
      if (path === "/director/sites/1" && options?.method === "DELETE") {
        return Promise.resolve({});
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<SitesList />);

    expect(await screen.findByText("Alpha Site")).toBeInTheDocument();

    const user = userEvent.setup();
    const deleteButtons = screen.getAllByRole("button", { name: "מחק" });
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        "/director/sites/1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("redirects worker users away from director sites", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "worker", full_name: "Yoeli" });

    render(<SitesList />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/worker");
    });
  });
});

