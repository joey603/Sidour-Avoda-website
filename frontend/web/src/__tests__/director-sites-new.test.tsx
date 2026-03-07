import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import NewSitePage from "@/app/director/sites/new/page";

jest.setTimeout(15000);

const replaceMock = jest.fn();
const backMock = jest.fn();
const routerMock = { replace: replaceMock, back: backMock };

jest.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
}));

jest.mock("@/components/number-picker", () => ({
  __esModule: true,
  default: ({ value, onChange, ...props }: any) => (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      {...props}
    />
  ),
}));

jest.mock("@/components/time-picker", () => ({
  __esModule: true,
  default: ({ value, onChange, ...props }: any) => (
    <input
      type="time"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...props}
    />
  ),
}));

describe("/director/sites/new", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    backMock.mockReset();
    localStorage.setItem("access_token", "test-token");
    jest.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("submits the new site and redirects to planning", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: any) => {
      if (path === "/director/sites/" && options?.method === "POST") {
        return Promise.resolve({ id: 77 });
      }
      if (path === "/director/sites/77" && !options?.method) {
        return Promise.resolve({ id: 77, name: "New Site" });
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<NewSitePage />);

    const user = userEvent.setup();
    const nameInput = screen.getAllByRole("textbox")[0];
    await user.type(nameInput, "New Site");
    await user.click(screen.getByRole("button", { name: "שמור" }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        "/director/sites/",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"name":"New Site"'),
        }),
      );
    });

    expect(replaceMock).toHaveBeenCalledWith("/director/planning/77");
  });

  it("goes back when pressing the back button", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });

    render(<NewSitePage />);

    const user = userEvent.setup();
    const backButtons = screen.getAllByRole("button", { name: "חזרה" });
    await user.click(backButtons[0]);

    expect(backMock).toHaveBeenCalled();
  });

  it("shows an error when site creation fails", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockRejectedValue(new Error("boom"));

    render(<NewSitePage />);

    const user = userEvent.setup();
    await user.type(screen.getAllByRole("textbox")[0], "Broken Site");
    await user.click(screen.getByRole("button", { name: "שמור" }));

    expect(await screen.findByText("שגיאה ביצירת אתר")).toBeInTheDocument();
  });

  it("adds another station when number of stations increases", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });

    render(<NewSitePage />);

    const user = userEvent.setup();
    const numberInputs = screen.getAllByRole("spinbutton");
    await user.clear(numberInputs[0]);
    await user.type(numberInputs[0], "2");

    expect(await screen.findByText("שם עמדה #2")).toBeInTheDocument();
  });

  it("opens preview modal with the typed site name", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });

    render(<NewSitePage />);

    const user = userEvent.setup();
    await user.type(screen.getAllByRole("textbox")[0], "Preview Site");
    await user.click(screen.getByRole("button", { name: "תצוגה" }));

    expect(await screen.findByText("תצוגה: Preview Site")).toBeInTheDocument();
  });

  it("adds a custom role from prompt", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    window.prompt = jest.fn(() => "Supervisor");

    render(<NewSitePage />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "הוסף תפקיד" }));

    expect(await screen.findByText("Supervisor")).toBeInTheDocument();
  });

  it("closes preview modal", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });

    render(<NewSitePage />);

    const user = userEvent.setup();
    await user.type(screen.getAllByRole("textbox")[0], "Preview Site");
    await user.click(screen.getByRole("button", { name: "תצוגה" }));
    expect(await screen.findByText("תצוגה: Preview Site")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "✕" }));

    await waitFor(() => {
      expect(screen.queryByText("תצוגה: Preview Site")).not.toBeInTheDocument();
    });
  });

  it("redirects worker users away from new site page", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "worker", full_name: "Yoeli" });

    render(<NewSitePage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/worker");
    });
  });

  it("redirects unauthenticated users away from new site page", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue(null);

    render(<NewSitePage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/login/director");
    });
  });
});

