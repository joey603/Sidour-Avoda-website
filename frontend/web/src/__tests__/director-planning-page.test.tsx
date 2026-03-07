import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import PlanningPage from "@/app/director/planning/[id]/page";

jest.setTimeout(20000);

jest.mock("@/components/loading-animation", () => ({
  __esModule: true,
  default: function Loading() {
    return <div data-testid="loading" />;
  },
}));

jest.mock("@/components/time-picker", () => ({
  __esModule: true,
  default: ({ value, onChange, ...props }: any) => (
    <input type="time" value={value} onChange={(e) => onChange(e.target.value)} {...props} />
  ),
}));

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock("@tiptap/react", () => {
  const React = require("react");

  return {
    __esModule: true,
    useEditor: (config?: any) => {
      let html = config?.content || "<p><br/></p>";
      const chainApi: any = {
        focus: () => chainApi,
        toggleBold: () => chainApi,
        toggleItalic: () => chainApi,
        toggleUnderline: () => chainApi,
        toggleHeading: () => chainApi,
        toggleBulletList: () => chainApi,
        toggleOrderedList: () => chainApi,
        extendMarkRange: () => chainApi,
        setLink: () => chainApi,
        toggleHighlight: () => chainApi,
        setColor: () => chainApi,
        run: () => true,
      };

      const editor: any = {
        commands: {
          setContent: (value: string, options?: any) => {
            html = value;
            if (options?.emitUpdate !== false) {
              config?.onUpdate?.({ editor });
            }
          },
        },
        getHTML: () => html,
        isActive: () => false,
        chain: () => chainApi,
      };

      return editor;
    },
    EditorContent: ({ editor }: any) => (
      <textarea
        data-testid="editor-content"
        value={editor?.getHTML?.() || ""}
        onChange={(e) => editor?.commands?.setContent?.(e.target.value)}
      />
    ),
  };
});

jest.mock("@tiptap/starter-kit", () => ({}));
jest.mock("@tiptap/extension-underline", () => ({}));
jest.mock("@tiptap/extension-link", () => ({ __esModule: true, default: { configure: () => ({}) } }));
jest.mock("@tiptap/extension-highlight", () => ({ __esModule: true, default: { configure: () => ({}) } }));
jest.mock("@tiptap/extension-text-style", () => ({ TextStyle: {} }));
jest.mock("@tiptap/extension-color", () => ({}));

const replaceMock = jest.fn();
const pushMock = jest.fn();
const backMock = jest.fn();
const routerMock = { replace: replaceMock, push: pushMock, back: backMock };

jest.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useParams: () => ({ id: "7" }),
}));

jest.mock("@/lib/auth", () => ({
  fetchMe: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
}));

describe("/director/planning/[id]", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    backMock.mockReset();
    localStorage.setItem("access_token", "test-token");
    jest.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("redirects unauthenticated users to director login", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue(null);

    render(<PlanningPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/login/director");
    });
  });

  it("redirects worker users to /worker", async () => {
    const { fetchMe } = require("@/lib/auth");
    fetchMe.mockResolvedValue({ role: "worker", full_name: "Yoeli" });

    render(<PlanningPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/worker");
    });
  });

  it("renders site header and empty workers table", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    expect(await screen.findByText("יצירת תכנון משמרות")).toBeInTheDocument();
    expect(await screen.findByText("Alpha Site")).toBeInTheDocument();
    expect(await screen.findByText("רשימת עובדים")).toBeInTheDocument();
    expect(await screen.findByText("אין עובדים")).toBeInTheDocument();
    expect(screen.getByText("אין הודעות")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "סינון תשובות" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "מחק" })).toBeDisabled();
  });

  it("shows site-not-found error when site lookup fails everywhere", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") return Promise.reject(new Error("404"));
      if (path === "/director/sites/") return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    expect(await screen.findByText("אתר לא נמצא")).toBeInTheDocument();
  });

  it("navigates back and opens site settings", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "חזור" }));
    expect(backMock).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "עדכן הגדרות" }));
    expect(pushMock).toHaveBeenCalledWith("/director/sites/7/edit");
  });

  it("opens filter modal when the site has optional questions", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({
          id: 7,
          name: "Alpha Site",
          config: { stations: [], questions: [{ id: "q1", label: "Need car?", type: "yesno" }] },
        });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "סינון תשובות" }));

    expect(await screen.findByText("סינון תשובות לשאלות")).toBeInTheDocument();
  });

  it("opens add-worker modal from the planning page", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "הוסף עובד" }));

    expect(await screen.findByPlaceholderText("הזן שם")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("הזן מספר טלפון")).toBeInTheDocument();
  });

  it("opens the calendar modal from the planning page", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "בחר שבוע מלוח שנה" })[0]);

    expect(await screen.findByText("בחר שבוע")).toBeInTheDocument();
  });

  it("closes the calendar modal from the planning page", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "בחר שבוע מלוח שנה" })[0]);
    expect(await screen.findByText("בחר שבוע")).toBeInTheDocument();

    const calendarTitle = await screen.findByText("בחר שבוע");
    const calendarModal = calendarTitle.closest("div")?.parentElement;
    expect(calendarModal).toBeTruthy();
    const calendarButtons = within(calendarModal as HTMLElement).getAllByRole("button");
    await user.click(calendarButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText("בחר שבוע")).not.toBeInTheDocument();
    });
  });

  it("closes the filter modal and resets its state", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({
          id: 7,
          name: "Alpha Site",
          config: { stations: [], questions: [{ id: "q1", label: "Need car?", type: "yesno" }] },
        });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "סינון תשובות" }));
    expect(await screen.findByText("סינון תשובות לשאלות")).toBeInTheDocument();

    const filterTitle = await screen.findByText("סינון תשובות לשאלות");
    const filterModal = filterTitle.closest("div")?.parentElement;
    expect(filterModal).toBeTruthy();
    const filterButtons = within(filterModal as HTMLElement).getAllByRole("button");
    await user.click(filterButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText("סינון תשובות לשאלות")).not.toBeInTheDocument();
    });
  });

  it("requests fresh week data when moving to the next week", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const before = (apiFetch as jest.Mock).mock.calls.filter((call: any[]) =>
      String(call[0]).includes("/director/sites/7/week-plan?week="),
    ).length;

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "שבוע הבא" })[0]);

    await waitFor(() => {
      const after = (apiFetch as jest.Mock).mock.calls.filter((call: any[]) =>
        String(call[0]).includes("/director/sites/7/week-plan?week="),
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("shows an error when saving without any active plan", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");
    const { toast } = require("sonner");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "שמור" }));

    expect(toast.error).toHaveBeenCalledWith(
      "אין מה לשמור",
      expect.objectContaining({ description: "לא נמצא תכנון קיים לשמירה" }),
    );
  });

  it("opens add-message modal", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "הוסף הודעה" }));

    expect(await screen.findByTestId("editor-content")).toBeInTheDocument();
  });

  it("deletes a saved plan after confirmation", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");
    const { toast } = require("sonner");
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    const savedPlan = { assignments: { sun: {} }, isManual: false, workers: [] };

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).includes("/director/sites/7/week-plan?") && String(path).includes("scope=director")) {
        if (options?.method === "DELETE") return Promise.resolve({});
        return Promise.resolve({});
      }
      if (String(path).includes("/director/sites/7/week-plan?") && String(path).includes("scope=shared")) {
        return Promise.resolve(savedPlan);
      }
      if (path === "/director/sites/7/week-plan" && options?.method === "PUT") return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");
    await screen.findByRole("button", { name: "ערוך" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "מחק" }));

    expect(confirmSpy).toHaveBeenCalled();

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("התכנון נמחק בהצלחה");
      expect(screen.getByRole("button", { name: "מחק" })).toBeDisabled();
    });

    const putCall = (apiFetch as jest.Mock).mock.calls.find(
      ([url, opts]: any[]) => url === "/director/sites/7/week-plan" && opts?.method === "PUT",
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall[1].body as string)).toEqual(
      expect.objectContaining({
        scope: "shared",
        data: expect.objectContaining({ assignments: null, workers: [] }),
      }),
    );

    confirmSpy.mockRestore();
  });

  it("does not delete a saved plan when confirmation is cancelled", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");
    const { toast } = require("sonner");
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).includes("/director/sites/7/week-plan?") && String(path).includes("scope=director")) {
        return Promise.resolve({});
      }
      if (String(path).includes("/director/sites/7/week-plan?") && String(path).includes("scope=shared")) {
        return Promise.resolve({ assignments: { sun: {} }, isManual: false, workers: [] });
      }
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");
    await screen.findByRole("button", { name: "ערוך" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "מחק" }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalledWith("התכנון נמחק בהצלחה");
    expect((apiFetch as jest.Mock).mock.calls.some(([, opts]: any[]) => opts?.method === "PUT")).toBe(false);
    expect((apiFetch as jest.Mock).mock.calls.some(([, opts]: any[]) => opts?.method === "DELETE")).toBe(false);

    confirmSpy.mockRestore();
  });

  it("enters saved-plan edit mode and restores read-only mode on cancel", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");
    const { toast } = require("sonner");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).includes("/director/sites/7/week-plan?") && String(path).includes("scope=director")) {
        return Promise.resolve({});
      }
      if (String(path).includes("/director/sites/7/week-plan?") && String(path).includes("scope=shared")) {
        return Promise.resolve({ assignments: { sun: {} }, isManual: false, workers: [] });
      }
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");
    const addMessageButton = await screen.findByRole("button", { name: "הוסף הודעה" });
    expect(addMessageButton).toBeDisabled();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ערוך" }));

    expect(await screen.findByRole("button", { name: "ביטול" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "הוסף הודעה" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "ביטול" }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("השינויים בוטלו");
      expect(screen.queryByRole("button", { name: "ביטול" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "הוסף הודעה" })).toBeDisabled();
    });
  });

  it("edits an existing optional message", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    let messages = [{ id: 5, text: "Old message", scope: "week", site_id: 7, created_week_iso: "2026-03-08", created_at: 1, updated_at: 1 }];

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve(messages);
      if (path === "/director/sites/7/messages/5" && options?.method === "PATCH") {
        messages = [{ ...messages[0], text: "Updated message", scope: "week", updated_at: 2 }];
        return Promise.resolve(messages);
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");
    const oldMessage = await screen.findByText("Old message");
    const messageCard = oldMessage.closest("div")?.parentElement?.parentElement as HTMLElement;

    const user = userEvent.setup();
    await user.click(within(messageCard).getByRole("button", { name: "ערוך" }));

    expect(await screen.findByText("עריכת הודעה")).toBeInTheDocument();
    const messageModal = screen.getByText("עריכת הודעה").closest("div")?.parentElement?.parentElement as HTMLElement;
    await user.click(within(messageModal).getByRole("button", { name: "שמור" }));

    await waitFor(() => {
      expect((apiFetch as jest.Mock).mock.calls.some(([url, opts]: any[]) =>
        url === "/director/sites/7/messages/5" && opts?.method === "PATCH",
      )).toBe(true);
    });
    expect(await screen.findByText("Updated message")).toBeInTheDocument();
  });

  it("deletes an optional message and refreshes the list", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    let messages = [{ id: 5, text: "Delete me", scope: "week", site_id: 7, created_week_iso: "2026-03-08", created_at: 1, updated_at: 1 }];

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve(messages);
      if (String(path).startsWith("/director/sites/7/messages/5?week=") && options?.method === "DELETE") {
        messages = [];
        return Promise.resolve("");
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Delete me");

    const messageText = screen.getByText("Delete me");
    const messageCard = messageText.closest("div")?.parentElement?.parentElement as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(messageCard).getByRole("button", { name: "מחק" }));

    await waitFor(() => {
      expect((apiFetch as jest.Mock).mock.calls.some(([url, opts]: any[]) =>
        String(url).startsWith("/director/sites/7/messages/5?week=") && opts?.method === "DELETE",
      )).toBe(true);
    });
    expect(await screen.findByText("אין הודעות")).toBeInTheDocument();
  });

  it("updates message scope when toggling permanent mode", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    let messages = [{ id: 5, text: "Scoped message", scope: "week", site_id: 7, created_week_iso: "2026-03-08", created_at: 1, updated_at: 1 }];

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve(messages);
      if (path === "/director/sites/7/messages/5" && options?.method === "PATCH") {
        messages = [{ ...messages[0], scope: "global", updated_at: 2 }];
        return Promise.resolve(messages);
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Scoped message");

    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox"));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        "/director/sites/7/messages/5",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"scope":"global"'),
        }),
      );
    });
    expect(await screen.findByText("לכל השבועות הבאים")).toBeInTheDocument();
  });

  it("saves and publishes an existing saved plan", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");
    const { toast } = require("sonner");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).includes("/director/sites/7/week-plan?") && String(path).includes("scope=director")) {
        return Promise.resolve({});
      }
      if (String(path).includes("/director/sites/7/week-plan?") && String(path).includes("scope=shared")) {
        return Promise.resolve({ assignments: { sun: {} }, isManual: false, workers: [] });
      }
      if (path === "/director/sites/7/week-plan" && options?.method === "PUT") {
        return Promise.resolve({});
      }
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");
    await screen.findByRole("button", { name: "ערוך" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "שמור ואשלח" }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        "/director/sites/7/week-plan",
        expect.objectContaining({
          method: "PUT",
        }),
      );
      expect(toast.success).toHaveBeenCalledWith("התכנון נשמר ונשלח");
    });

    const saveCall = (apiFetch as jest.Mock).mock.calls.find(
      ([url, opts]: any[]) => url === "/director/sites/7/week-plan" && opts?.method === "PUT",
    );
    expect(JSON.parse(saveCall[1].body as string)).toEqual(
      expect.objectContaining({
        scope: "shared",
        data: expect.objectContaining({ assignments: { sun: {} } }),
      }),
    );
  });

  it("creates a new optional message and refreshes the list", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    let messages: any[] = [];

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve(messages);
      if (path === "/director/sites/7/messages" && options?.method === "POST") {
        messages = [{ id: 9, text: "<p><br/></p>", scope: "global", site_id: 7, created_week_iso: "2026-03-08", created_at: 1, updated_at: 1 }];
        return Promise.resolve(messages[0]);
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "הוסף הודעה" }));
    const editor = await screen.findByTestId("editor-content");

    const addModal = editor.closest("div")?.parentElement?.parentElement as HTMLElement;
    await user.click(within(addModal).getByRole("button", { name: "הוסף" }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        "/director/sites/7/messages",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"scope":"global"'),
        }),
      );
    });
    expect(await screen.findByText("לכל השבועות הבאים")).toBeInTheDocument();
  });

  it("closes add-message modal with the close button", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "הוסף הודעה" }));
    const editor = await screen.findByTestId("editor-content");

    const addModal = editor.closest("div")?.parentElement?.parentElement as HTMLElement;
    await user.click(within(addModal).getByRole("button", { name: "סגור" }));

    await waitFor(() => {
      expect(screen.queryByTestId("editor-content")).not.toBeInTheDocument();
    });
  });

  it("saves an existing plan as director-only draft", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");
    const { toast } = require("sonner");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).includes("/director/sites/7/week-plan?") && String(path).includes("scope=director")) {
        return Promise.resolve({});
      }
      if (String(path).includes("/director/sites/7/week-plan?") && String(path).includes("scope=shared")) {
        return Promise.resolve({ assignments: { sun: {} }, isManual: false, workers: [] });
      }
      if (path === "/director/sites/7/week-plan" && options?.method === "PUT") {
        return Promise.resolve({});
      }
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");
    await screen.findByRole("button", { name: "ערוך" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "שמור" }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("התכנון נשמר (למנהל בלבד)");
    });

    const saveCall = (apiFetch as jest.Mock).mock.calls.find(
      ([url, opts]: any[]) => url === "/director/sites/7/week-plan" && opts?.method === "PUT",
    );
    expect(saveCall).toBeTruthy();
    expect(JSON.parse(saveCall[1].body as string)).toEqual(
      expect.objectContaining({
        scope: "director",
        data: expect.objectContaining({ assignments: { sun: {} } }),
      }),
    );
  });

  it("creates a week-only optional message when permanent is unchecked", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    let messages: any[] = [];

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve(messages);
      if (path === "/director/sites/7/messages" && options?.method === "POST") {
        messages = [{ id: 10, text: "<p><br/></p>", scope: "week", site_id: 7, created_week_iso: "2026-03-08", created_at: 1, updated_at: 1 }];
        return Promise.resolve(messages[0]);
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "הוסף הודעה" }));
    const editor = await screen.findByTestId("editor-content");
    const addModal = editor.closest("div")?.parentElement?.parentElement as HTMLElement;

    await user.click(within(addModal).getByRole("checkbox"));
    expect(screen.getByText("לשבוע זה בלבד")).toBeInTheDocument();
    await user.click(within(addModal).getByRole("button", { name: "הוסף" }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        "/director/sites/7/messages",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"scope":"week"'),
        }),
      );
    });
    expect(await screen.findByText("לשבוע זה בלבד")).toBeInTheDocument();
  });

  it("closes add-message modal with the cancel button", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "הוסף הודעה" }));
    const editor = await screen.findByTestId("editor-content");
    const modalCard = editor.closest("div")?.parentElement?.parentElement as HTMLElement;

    await user.click(within(modalCard).getByRole("button", { name: "ביטול" }));

    await waitFor(() => {
      expect(screen.queryByTestId("editor-content")).not.toBeInTheDocument();
    });
  });

  it("closes add-message modal cleanly when message creation fails", async () => {
    const { fetchMe } = require("@/lib/auth");
    const { apiFetch } = require("@/lib/api");

    fetchMe.mockResolvedValue({ role: "director", full_name: "Boss" });
    apiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/director/sites/7") {
        return Promise.resolve({ id: 7, name: "Alpha Site", config: { stations: [], questions: [] } });
      }
      if (path === "/director/sites/7/workers") return Promise.resolve([]);
      if (String(path).startsWith("/director/sites/7/weekly-availability")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/week-plan")) return Promise.resolve({});
      if (String(path).startsWith("/director/sites/7/messages?week=")) return Promise.resolve([]);
      if (path === "/director/sites/7/messages" && options?.method === "POST") {
        return Promise.reject(new Error("post failed"));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    render(<PlanningPage />);

    await screen.findByText("Alpha Site");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "הוסף הודעה" }));
    const editor = await screen.findByTestId("editor-content");
    const addModal = editor.closest("div")?.parentElement?.parentElement as HTMLElement;

    await user.click(within(addModal).getByRole("button", { name: "הוסף" }));

    await waitFor(() => {
      expect(screen.queryByTestId("editor-content")).not.toBeInTheDocument();
      expect(screen.getByText("אין הודעות")).toBeInTheDocument();
    });
  });
});

