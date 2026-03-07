import React from "react";
import { render, screen } from "@testing-library/react";

import PlanningIndex from "@/app/director/planning/page";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: any) => (
    <a href={typeof href === "string" ? href : String(href)} {...props}>
      {children}
    </a>
  ),
}));

describe("/director/planning index", () => {
  it("renders fallback message and link back to dashboard", () => {
    render(<PlanningIndex />);

    expect(screen.getByText("יצירת תכנון משמרות")).toBeInTheDocument();
    const backLink = screen.getByRole("link", { name: "חזרה לדף המנהל" });
    expect(backLink).toHaveAttribute("href", "/director");
  });
});

