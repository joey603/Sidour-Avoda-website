import React from "react";
import { render, waitFor } from "@testing-library/react";

import WorkerHistoryPage from "@/app/worker/history/page";

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
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
}));

describe("/worker/history auth", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    jest.clearAllMocks();
  });

  it("redirects unauthenticated users to worker login", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue(null);

    render(<WorkerHistoryPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/login/worker");
    });
  });

  it("redirects directors away from worker history", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });

    render(<WorkerHistoryPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/director");
    });
  });
});

