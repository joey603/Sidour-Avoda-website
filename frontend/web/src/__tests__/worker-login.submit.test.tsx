import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import WorkerLoginPage from "@/app/login/worker/page";

jest.setTimeout(15000);

jest.mock("@/components/loading-animation", () => ({
  __esModule: true,
  default: function Loading() {
    return <div data-testid="loading" />;
  },
}));

const replaceMock = jest.fn();
let returnUrlMock: string | null = null;
let inviteTokenMock: string | null = null;
let phoneMock: string | null = null;

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => ({
    get: (key: string) => {
      if (key === "returnUrl") return returnUrlMock;
      if (key === "inviteToken") return inviteTokenMock;
      if (key === "phone") return phoneMock;
      return null;
    },
  }),
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
  getRoleFromToken: jest.fn(),
  isTokenExpired: jest.fn(),
  setToken: jest.fn(),
  getToken: jest.fn(),
  clearToken: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  apiFetchWithRetry: jest.fn(),
}));

describe("worker login submit", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    returnUrlMock = null;
    inviteTokenMock = null;
    phoneMock = null;
    jest.clearAllMocks();
  });

  it("submits credentials and redirects to the safe worker returnUrl", async () => {
    const auth = require("@/lib/auth");
    const api = require("@/lib/api");

    auth.getToken.mockReturnValue(null);
    auth.isTokenExpired.mockReturnValue(false);
    auth.getRoleFromToken.mockReturnValue("worker");
    auth.fetchMe.mockResolvedValue(null);
    api.apiFetch.mockResolvedValue({ site_id: 1, site_name: "Site A", director_name: "Boss", director_code: "346837536" });
    api.apiFetchWithRetry.mockResolvedValue({ access_token: "worker-token" });
    returnUrlMock = "/worker/history";

    render(<WorkerLoginPage />);

    const user = userEvent.setup();
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[0], "346837536");
    await user.type(inputs[1], "0585060398");
    await user.click(screen.getByRole("button", { name: "התחבר" }));

    await waitFor(() => {
      expect(api.apiFetchWithRetry).toHaveBeenCalledWith(
        "/auth/worker-login",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ code: "346837536", phone: "0585060398" }),
        }),
        expect.any(Object),
      );
    });

    expect(auth.setToken).toHaveBeenCalledWith("worker-token");
    expect(replaceMock).toHaveBeenCalledWith("/worker/history");
  });

  it("shows an error and restores previous token when API returns a director token", async () => {
    const auth = require("@/lib/auth");
    const api = require("@/lib/api");

    auth.getToken.mockReturnValue("prev-token");
    auth.isTokenExpired.mockReturnValue(false);
    auth.getRoleFromToken.mockReturnValue("director");
    auth.fetchMe.mockResolvedValue(null);
    api.apiFetch.mockResolvedValue({ site_id: 1, site_name: "Site A", director_name: "Boss", director_code: "346837536" });
    api.apiFetchWithRetry.mockResolvedValue({ access_token: "director-token" });

    render(<WorkerLoginPage />);

    const user = userEvent.setup();
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[0], "346837536");
    await user.type(inputs[1], "0585060398");
    await user.click(screen.getByRole("button", { name: "התחבר" }));

    expect(await screen.findByText("חשבון זה אינו לעובד. נא להתחבר כעובד.")).toBeInTheDocument();
    expect(auth.setToken).toHaveBeenCalledWith("director-token");
    expect(auth.setToken).toHaveBeenCalledWith("prev-token");
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("includes invite token in worker login and redirects to availability", async () => {
    const auth = require("@/lib/auth");
    const api = require("@/lib/api");

    auth.getToken.mockReturnValue(null);
    auth.isTokenExpired.mockReturnValue(false);
    auth.getRoleFromToken.mockReturnValue("worker");
    auth.fetchMe.mockResolvedValue(null);
    api.apiFetch.mockResolvedValue({ site_id: 1, site_name: "Site A", director_name: "Boss", director_code: "998877" });
    api.apiFetchWithRetry.mockResolvedValue({ access_token: "worker-token" });
    inviteTokenMock = "secure-token";
    returnUrlMock = "/worker/availability";

    render(<WorkerLoginPage />);

    const user = userEvent.setup();
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[1], "0585060398");
    await user.click(screen.getByRole("button", { name: "התחבר" }));

    await waitFor(() => {
      expect(api.apiFetchWithRetry).toHaveBeenCalledWith(
        "/auth/worker-login",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ code: "998877", phone: "0585060398", invite_token: "secure-token" }),
        }),
        expect.any(Object),
      );
    });

    expect(replaceMock).toHaveBeenCalledWith("/worker/availability");
  });
});

