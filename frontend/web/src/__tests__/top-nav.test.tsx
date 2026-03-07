import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import TopNav from "@/components/top-nav";

jest.setTimeout(15000);

const replaceMock = jest.fn();
const clearTokenMock = jest.fn();

let pathnameMock = "/";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => pathnameMock,
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: any) => (
    <a href={typeof href === "string" ? href : String(href)} {...props}>
      {children}
    </a>
  ),
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
  clearToken: () => clearTokenMock(),
  getToken: jest.fn(),
  isTokenExpired: jest.fn(),
}));

describe("TopNav", () => {
  beforeEach(() => {
    pathnameMock = "/";
    replaceMock.mockReset();
    clearTokenMock.mockReset();
    jest.clearAllMocks();
    window.history.replaceState({}, "", "http://localhost/");
  });

  it("redirects unauthenticated worker pages to worker login with returnUrl", async () => {
    pathnameMock = "/worker";
    window.history.replaceState({}, "", "http://localhost/worker");

    const auth = require("@/lib/auth");
    auth.fetchMe.mockResolvedValue(null);
    auth.getToken.mockReturnValue(null);
    auth.isTokenExpired.mockReturnValue(true);

    render(<TopNav />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/login/worker?returnUrl=%2Fworker");
    });
  });

  it("shows worker navigation links when authenticated as worker", async () => {
    pathnameMock = "/worker/history";
    window.history.replaceState({}, "", "http://localhost/worker/history");

    const auth = require("@/lib/auth");
    auth.fetchMe.mockResolvedValue({ role: "worker" });
    auth.getToken.mockReturnValue("token");
    auth.isTokenExpired.mockReturnValue(false);

    render(<TopNav />);

    await waitFor(() => {
      expect(screen.getAllByText("זמינות").length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText("היסטוריה").length).toBeGreaterThan(0);
    expect(screen.getAllByText("התנתק").length).toBeGreaterThan(0);
  });

  it("clears token and redirects on logout", async () => {
    pathnameMock = "/worker";
    window.history.replaceState({}, "", "http://localhost/worker");

    const auth = require("@/lib/auth");
    auth.fetchMe.mockResolvedValue({ role: "worker" });
    auth.getToken.mockReturnValue("token");
    auth.isTokenExpired.mockReturnValue(false);

    render(<TopNav />);

    const user = userEvent.setup();
    const logoutButtons = await screen.findAllByRole("button", { name: "התנתק" });
    await user.click(logoutButtons[0]);

    expect(clearTokenMock).toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalledWith("/login/worker");
  });
});

