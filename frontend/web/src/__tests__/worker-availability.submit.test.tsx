import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import WorkerAvailabilityPage from "@/app/worker/availability/page";

jest.setTimeout(15000);

jest.mock("@/components/loading-animation", () => ({
  __esModule: true,
  default: function Loading() {
    return <div data-testid="loading" />;
  },
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
    info: jest.fn(),
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

function getNextWeekIso() {
  const today = new Date();
  const currentDay = today.getDay();
  const daysUntilNextSunday = currentDay === 0 ? 7 : 7 - currentDay;
  const nextSunday = new Date(today);
  nextSunday.setDate(today.getDate() + daysUntilNextSunday);
  nextSunday.setHours(0, 0, 0, 0);
  return `${nextSunday.getFullYear()}-${String(nextSunday.getMonth() + 1).padStart(2, "0")}-${String(nextSunday.getDate()).padStart(2, "0")}`;
}

describe("/worker/availability submit", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    localStorage.setItem("access_token", "test-token");
    jest.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("submits weekly availability and question answers with week_key", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "worker", full_name: "Yoeli", id: 19 });

    const nextWeekIso = getNextWeekIso();
    const siteQuestions = [
      { id: "g1", label: "הערה כללית", type: "text", perDay: false },
      { id: "p1", label: "יכול בוקר?", type: "yesno", perDay: true },
    ];

    apiFetch.mockImplementation((path: string, options?: any) => {
      if (path === "/public/sites/worker-sites") return Promise.resolve([{ id: 7, name: "Site A" }]);
      if (path === "/public/sites/7/info") {
        return Promise.resolve({ id: 7, name: "Site A", shifts: ["06-14"], questions: siteQuestions });
      }
      if (path === `/public/sites/7/worker-availability?week_key=${encodeURIComponent(nextWeekIso)}`) {
        return Promise.resolve({
          id: 19,
          name: "Yoeli",
          max_shifts: 5,
          roles: [],
          availability: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
          answers: { general: {}, perDay: {} },
        });
      }
      if (path === `/public/sites/7/register?week_key=${encodeURIComponent(nextWeekIso)}`) {
        return Promise.resolve({});
      }
      throw new Error(`Unexpected apiFetch path: ${path} ${JSON.stringify(options || {})}`);
    });

    render(<WorkerAvailabilityPage />);

    await screen.findByText("רישום זמינות");

    const user = userEvent.setup();

    const editButton = await screen.findByRole("button", { name: "ערוך" });
    await user.click(editButton);

    // select one shift for Sunday
    const shiftButton = (await screen.findAllByRole("button", { name: "06-14" })).find((el) => !(el as HTMLButtonElement).disabled);
    expect(shiftButton).toBeTruthy();
    await user.click(shiftButton as HTMLElement);

    // fill general text question
    const generalInput = (await screen.findAllByRole("textbox")).find((el) => !(el as HTMLInputElement).disabled);
    expect(generalInput).toBeTruthy();
    await user.type(generalInput as HTMLElement, "בדיקה");

    // answer per-day yes/no question for Sunday
    const yesRadios = screen.getAllByRole("radio", { name: "כן" });
    for (const radio of yesRadios) {
      await user.click(radio);
    }

    await user.click(screen.getByRole("button", { name: /שמור זמינות|עדכן/ }));

    await waitFor(() => {
      const submitCall = (apiFetch as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === `/public/sites/7/register?week_key=${encodeURIComponent(nextWeekIso)}`,
      );
      expect(submitCall).toBeTruthy();

      const body = JSON.parse(String(submitCall[1].body));
      expect(body.answers.week_key).toBe(nextWeekIso);
      expect(body.answers.general.g1).toBe("בדיקה");
      expect(body.answers.perDay.p1.sun).toBe(true);
      expect(body.availability.sun).toContain("06-14");
    });
  });
});

