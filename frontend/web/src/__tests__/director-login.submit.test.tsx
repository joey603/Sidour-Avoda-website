import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import DirectorLoginPage from "@/app/login/director/page";

jest.setTimeout(15000);

jest.mock("@/components/loading-animation", () => ({
  __esModule: true,
  default: function Loading() {
    return <div data-testid="loading" />;
  },
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: any) => (
    <a href={typeof href === "string" ? href : String(href)} {...props}>
      {children}
    </a>
  ),
}));

const replaceMock = jest.fn();
let returnUrlMock: string | null = null;

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => ({
    get: (key: string) => (key === "returnUrl" ? returnUrlMock : null),
  }),
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
  logout: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  apiFetchWithRetry: jest.fn(),
}));

describe("director login submit", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    returnUrlMock = null;
    jest.clearAllMocks();
  });

  it("redirects to /director when submitted credentials return a director token", async () => {
    const auth = require("@/lib/auth");
    const api = require("@/lib/api");

    auth.fetchMe.mockResolvedValueOnce(null).mockResolvedValueOnce({ role: "director" });
    api.apiFetchWithRetry.mockResolvedValue({ access_token: "director-token" });

    const { container } = render(<DirectorLoginPage />);

    const user = userEvent.setup();
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(emailInput).toBeTruthy();
    expect(passwordInput).toBeTruthy();
    await user.type(emailInput as HTMLInputElement, "boss@example.com");
    await user.type(passwordInput as HTMLInputElement, "password123");
    await user.click(screen.getByRole("button", { name: "התחבר" }));

    await waitFor(() => {
      expect(api.apiFetchWithRetry).toHaveBeenCalledWith(
        "/auth/login",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ email: "boss@example.com", password: "password123" }),
        }),
        expect.any(Object),
      );
    });

    expect(replaceMock).toHaveBeenCalledWith("/director");
  });

  it("shows timeout error when backend stays unavailable", async () => {
    const auth = require("@/lib/auth");
    const api = require("@/lib/api");

    auth.fetchMe.mockResolvedValue(null);
    api.apiFetchWithRetry.mockRejectedValue(new Error("timeout after retries"));

    const { container } = render(<DirectorLoginPage />);

    const user = userEvent.setup();
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(emailInput).toBeTruthy();
    expect(passwordInput).toBeTruthy();
    await user.type(emailInput as HTMLInputElement, "boss@example.com");
    await user.type(passwordInput as HTMLInputElement, "password123");
    await user.click(screen.getByRole("button", { name: "התחבר" }));

    expect(await screen.findByText("השרת לא זמין כרגע. נסו שוב בעוד רגע.")).toBeInTheDocument();
  });
});

