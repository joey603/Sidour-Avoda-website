import React from "react";
import { render, screen } from "@testing-library/react";

import Home from "@/app/page";

jest.setTimeout(15000);

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: any) => (
    <a href={typeof href === "string" ? href : String(href)} {...props}>
      {children}
    </a>
  ),
}));

describe("/ home page", () => {
  it("renders the landing brand and login entry points", async () => {
    render(<Home />);

    expect((await screen.findAllByText(/סידור|Sidour|מוכן|להתחיל/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /כניסת מנהל/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /כניסת עובד/i }).length).toBeGreaterThan(0);
  });
});
