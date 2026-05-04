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
  logout: jest.fn(),
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

    auth.fetchMe.mockResolvedValueOnce(null).mockResolvedValueOnce({ role: "worker" });
    api.apiFetchWithRetry.mockResolvedValue({ access_token: "worker-token" });
    returnUrlMock = "/worker/history";

    const { container } = render(<WorkerLoginPage />);

    const user = userEvent.setup();
    const phoneInput = container.querySelector('input[type="tel"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(phoneInput).toBeTruthy();
    expect(passwordInput).toBeTruthy();
    await user.type(phoneInput as HTMLInputElement, "0585060398");
    await user.type(passwordInput as HTMLInputElement, "workerpass123");
    await user.click(screen.getByRole("button", { name: "התחבר" }));

    await waitFor(() => {
      expect(api.apiFetchWithRetry).toHaveBeenCalledWith(
        "/auth/worker-login",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ phone: "0585060398", password: "workerpass123" }),
        }),
        expect.any(Object),
      );
    });

    expect(replaceMock).toHaveBeenCalledWith("/worker/history");
  });

  it("shows an error and logs out when backend authenticates a director", async () => {
    const auth = require("@/lib/auth");
    const api = require("@/lib/api");

    auth.fetchMe.mockResolvedValueOnce(null).mockResolvedValueOnce({ role: "director" });
    auth.logout.mockResolvedValue(undefined);
    api.apiFetchWithRetry.mockResolvedValue({ access_token: "director-token" });

    const { container } = render(<WorkerLoginPage />);

    const user = userEvent.setup();
    const phoneInput = container.querySelector('input[type="tel"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(phoneInput).toBeTruthy();
    expect(passwordInput).toBeTruthy();
    await user.type(phoneInput as HTMLInputElement, "0585060398");
    await user.type(passwordInput as HTMLInputElement, "workerpass123");
    await user.click(screen.getByRole("button", { name: "התחבר" }));

    expect(await screen.findByText("חשבון זה אינו לעובד. נא להתחבר כעובד.")).toBeInTheDocument();
    expect(auth.logout).toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("loads invite metadata and still logs in with phone/password", async () => {
    const auth = require("@/lib/auth");
    const api = require("@/lib/api");

    auth.fetchMe.mockResolvedValueOnce(null).mockResolvedValueOnce({ role: "worker" });
    api.apiFetch.mockResolvedValue({ site_id: 1, site_name: "Site A", director_name: "Boss" });
    api.apiFetchWithRetry.mockResolvedValue({ access_token: "worker-token" });
    inviteTokenMock = "secure-token";
    returnUrlMock = "/worker/availability";

    const { container } = render(<WorkerLoginPage />);
    expect(await screen.findByText("הפעלת חשבון והגדרת סיסמה")).toBeInTheDocument();

    const user = userEvent.setup();
    const phoneInput = container.querySelector('input[type="tel"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(phoneInput).toBeTruthy();
    expect(passwordInput).toBeTruthy();
    await user.type(phoneInput as HTMLInputElement, "0585060398");
    await user.type(passwordInput as HTMLInputElement, "workerpass123");
    await user.click(screen.getByRole("button", { name: "התחבר" }));

    await waitFor(() => {
      expect(api.apiFetchWithRetry).toHaveBeenCalledWith(
        "/auth/worker-login",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ phone: "0585060398", password: "workerpass123" }),
        }),
        expect.any(Object),
      );
    });

    expect(replaceMock).toHaveBeenCalledWith("/worker/availability");
  });
});

