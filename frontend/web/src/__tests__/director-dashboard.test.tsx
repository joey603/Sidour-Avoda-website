import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

import DirectorDashboard from "@/app/director/page";

jest.setTimeout(15000);

const replaceMock = jest.fn();
const routerMock = { replace: replaceMock };

jest.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
}));

describe("/director dashboard", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    jest.clearAllMocks();
  });

  it("redirects unauthenticated users to director login", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue(null);

    render(<DirectorDashboard />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/login/director");
    });
  });

  it("renders director name and code when session is valid", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({
      role: "director",
      full_name: "Boss",
      director_code: "346837536",
    });

    render(<DirectorDashboard />);

    await waitFor(() => {
      expect(screen.getByText("346837536")).toBeInTheDocument();
    });
    expect(screen.getByText("Boss")).toBeInTheDocument();
  });

  it("redirects worker users to /worker", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "worker", full_name: "Yoeli" });

    render(<DirectorDashboard />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/worker");
    });
  });
});

