import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

import Home from "@/app/page";

jest.setTimeout(15000);

const replaceMock = jest.fn();
const routerMock = { replace: replaceMock };

jest.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
  getToken: jest.fn(),
}));

describe("/ home page", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    jest.clearAllMocks();
  });

  it("redirects to /login when there is no token", async () => {
    const auth = require("@/lib/auth");
    auth.getToken.mockReturnValue(null);
    auth.fetchMe.mockResolvedValue(null);

    render(<Home />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/login?returnUrl=%2F");
    });
  });

  it("renders worker/director info when session is valid", async () => {
    const auth = require("@/lib/auth");
    auth.getToken.mockReturnValue("token");
    auth.fetchMe.mockResolvedValue({
      full_name: "Yoeli",
      role: "director",
      director_code: "346837536",
    });

    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText("346837536")).toBeInTheDocument();
    });
    expect(screen.getByText("Yoeli")).toBeInTheDocument();
  });
});

