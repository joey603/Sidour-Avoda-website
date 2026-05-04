import React from "react";
import { render, waitFor } from "@testing-library/react";

import WorkerLoginPage from "@/app/login/worker/page";
import DirectorLoginPage from "@/app/login/director/page";

jest.setTimeout(15000);

jest.mock("@/components/loading-animation", () => ({
  __esModule: true,
  default: function Loading() {
    return <div data-testid="loading" />;
  },
}));

const replaceMock = jest.fn();
const routerMock = { replace: replaceMock };

jest.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => ({
    get: () => null,
  }),
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
  logout: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  apiFetchWithRetry: jest.fn(),
}));

describe("login auto-redirect", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    jest.clearAllMocks();
  });

  it("redirects worker login to /worker when session is valid", async () => {
    const auth = require("@/lib/auth");
    auth.fetchMe.mockResolvedValue({ role: "worker" });

    render(<WorkerLoginPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/worker");
    });
  });

  it("redirects director login to /director when session is valid", async () => {
    const auth = require("@/lib/auth");
    auth.fetchMe.mockResolvedValue({ role: "director" });

    render(<DirectorLoginPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/director");
    });
  });
});

