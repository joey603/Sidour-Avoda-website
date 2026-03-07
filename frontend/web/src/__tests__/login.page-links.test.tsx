import React from "react";
import { render, screen } from "@testing-library/react";

import LoginPage from "@/app/login/page";

let returnUrlMock: string | null = null;

jest.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === "returnUrl" ? returnUrlMock : null),
  }),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: any) => (
    <a href={typeof href === "string" ? href : String(href)} {...props}>
      {children}
    </a>
  ),
}));

describe("/login page links", () => {
  beforeEach(() => {
    returnUrlMock = null;
  });

  it("renders worker and director links with returnUrl preserved", () => {
    returnUrlMock = "/worker/history";

    render(<LoginPage />);

    const links = screen.getAllByRole("link");
    const directorLink = links.find((link) => link.getAttribute("href")?.startsWith("/login/director"));
    const workerLink = links.find((link) => link.getAttribute("href")?.startsWith("/login/worker"));

    expect(directorLink).toHaveAttribute("href", "/login/director?returnUrl=%2Fworker%2Fhistory");
    expect(workerLink).toHaveAttribute("href", "/login/worker?returnUrl=%2Fworker%2Fhistory");
  });
});

