"use client";

import { type MouseEvent, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import LoadingAnimation from "@/components/loading-animation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { getWeekKeyISO } from "./lib/week";

type OptionalMessage = {
  id: number;
  site_id: number;
  text: string;
  scope: "global" | "week";
  created_week_iso: string;
  stopped_week_iso?: string | null;
  origin_id?: number | null;
  created_at: number;
  updated_at: number;
};

function isoYMD(d: Date): string {
  return getWeekKeyISO(d);
}

function sortMessagesChronologically(list: OptionalMessage[]) {
  return [...list].sort((a, b) => {
    const createdAtDiff = Number(a?.created_at || 0) - Number(b?.created_at || 0);
    if (createdAtDiff !== 0) return createdAtDiff;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });
}

function isProbablyHtml(input: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(input || "");
}

function sanitizeMessageHtml(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["mark"],
    ADD_ATTR: ["style", "data-color"],
  });
}

function escapeHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function toEditorHtml(raw: string): string {
  const str = String(raw || "");
  if (isProbablyHtml(str)) return str;
  const escaped = escapeHtml(str).replace(/\n/g, "<br/>");
  return `<p>${escaped || "<br/>"}</p>`;
}

type PlanningV2OptionalMessagesProps = {
  siteId: string;
  weekStart: Date;
};

export function PlanningV2OptionalMessages({ siteId, weekStart }: PlanningV2OptionalMessagesProps) {
  const [messages, setMessages] = useState<OptionalMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isAddMessageOpen, setIsAddMessageOpen] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [newMessageText, setNewMessageText] = useState("");
  const [newMessagePermanent, setNewMessagePermanent] = useState(true);
  const [messageEditorInitialHtml, setMessageEditorInitialHtml] = useState<string>("");
  const [messageTextColor, setMessageTextColor] = useState<string>("#111827");
  const [messageHighlightColor, setMessageHighlightColor] = useState<string>("#fde047");

  const visibleMessages = useMemo(() => messages, [messages]);

  const refreshMessages = useCallback(async () => {
    const id = Number(siteId);
    if (!id) return;
    const wk = isoYMD(weekStart);
    try {
      setMessagesLoading(true);
      const res = await apiFetch<OptionalMessage[]>(
        `/director/sites/${siteId}/messages?week=${encodeURIComponent(wk)}`,
        { headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` } },
      );
      setMessages(Array.isArray(res) ? sortMessagesChronologically(res) : []);
    } catch {
      setMessages([]);
      toast.error("לא ניתן לטעון הודעות");
    } finally {
      setMessagesLoading(false);
    }
  }, [siteId, weekStart]);

  useEffect(() => {
    void refreshMessages();
  }, [refreshMessages]);

  function closeMessageModal() {
    setIsAddMessageOpen(false);
    setEditingMessageId(null);
    setNewMessageText("");
    setNewMessagePermanent(true);
    setMessageEditorInitialHtml("");
  }

  const messageEditor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      TextStyle,
      Color,
      Underline,
      Link.configure({ openOnClick: true }),
      Highlight.configure({ multicolor: true }),
    ],
    content: messageEditorInitialHtml || "<p><br/></p>",
    editorProps: {
      attributes: {
        class:
          "tiptap-editor min-h-32 rounded-b-md bg-white px-3 py-2 text-sm outline-none dark:bg-zinc-900",
        dir: "rtl",
      },
    },
    onUpdate: ({ editor }) => {
      setNewMessageText(editor.getHTML());
    },
  });

  useEffect(() => {
    if (!isAddMessageOpen) return;
    if (!messageEditor) return;
    try {
      messageEditor.commands.setContent(messageEditorInitialHtml || "<p><br/></p>", { emitUpdate: false });
    } catch {
      /* ignore */
    }
  }, [isAddMessageOpen, messageEditorInitialHtml, messageEditor]);

  const idNum = Number(siteId);
  if (!Number.isFinite(idNum) || idNum <= 0) return null;

  return (
    <>
      <div className="mt-4 rounded-xl border p-3 dark:border-zinc-800">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm text-zinc-600 dark:text-zinc-300">הודעה אופציונלית</div>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md border border-green-600 px-3 py-2 text-sm text-green-600 hover:bg-green-50 dark:border-green-500 dark:text-green-400 dark:hover:bg-green-900/30"
            onClick={() => {
              setEditingMessageId(null);
              const initial = "<p><br/></p>";
              setMessageEditorInitialHtml(initial);
              setNewMessageText(initial);
              setNewMessagePermanent(true);
              setIsAddMessageOpen(true);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M19 11H13V5h-2v6H5v2h6v6h2v-6h6v-2z" />
            </svg>
            הוסף הודעה
          </button>
        </div>

        {messagesLoading ? (
          <LoadingAnimation className="py-4" size={60} />
        ) : visibleMessages.length === 0 ? (
          <div className="text-sm text-zinc-500">אין הודעות</div>
        ) : (
          <div className="space-y-2">
            {visibleMessages.map((m) => (
              <div key={m.id} className="rounded-md border p-3 dark:border-zinc-700">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-sm text-zinc-800 dark:text-zinc-100" dir="rtl">
                    {(() => {
                      const raw = String(m.text || "");
                      if (isProbablyHtml(raw)) {
                        const clean = sanitizeMessageHtml(raw);
                        return (
                          <div
                            className="prose prose-sm max-w-none dark:prose-invert"
                            dangerouslySetInnerHTML={{ __html: clean }}
                          />
                        );
                      }
                      return (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                            ul: ({ children }) => <ul className="mb-2 list-disc pr-5">{children}</ul>,
                            ol: ({ children }) => <ol className="mb-2 list-decimal pr-5">{children}</ol>,
                            li: ({ children }) => <li className="mb-1 last:mb-0">{children}</li>,
                            a: ({ children, href }) => (
                              <a className="underline decoration-dotted" href={href} target="_blank" rel="noreferrer">
                                {children}
                              </a>
                            ),
                            table: ({ children }) => (
                              <div className="overflow-x-auto">
                                <table className="w-full border-collapse text-sm">{children}</table>
                              </div>
                            ),
                            th: ({ children }) => (
                              <th className="border bg-zinc-50 px-2 py-1 text-right dark:bg-zinc-800">{children}</th>
                            ),
                            td: ({ children }) => <td className="border px-2 py-1 text-right align-top">{children}</td>,
                          }}
                        >
                          {raw}
                        </ReactMarkdown>
                      );
                    })()}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      onClick={() => {
                        setEditingMessageId(m.id);
                        const initial = toEditorHtml(String(m.text || ""));
                        setMessageEditorInitialHtml(initial);
                        setNewMessageText(initial);
                        setNewMessagePermanent(m.scope === "global");
                        setIsAddMessageOpen(true);
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
                        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75Z" />
                      </svg>
                      ערוך
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md border border-red-600 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/40"
                      onClick={async () => {
                        const wk = isoYMD(weekStart);
                        const previousMessages = messages;
                        setMessages((prev) => prev.filter((msg) => Number(msg.id) !== Number(m.id)));
                        try {
                          await apiFetch<string>(
                            `/director/sites/${siteId}/messages/${m.id}?week=${encodeURIComponent(wk)}`,
                            {
                              method: "DELETE",
                              headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                            },
                          );
                        } catch {
                          setMessages(previousMessages);
                          toast.error("מחיקת ההודעה נכשלה");
                        }
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
                        <path d="M6 7h12v2H6Zm2 4h8l-1 9H9ZM9 4h6v2H9Z" />
                      </svg>
                      מחק
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <label className="inline-flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
                    <input
                      type="checkbox"
                      checked={m.scope === "global"}
                      onChange={async (e) => {
                        const wk = isoYMD(weekStart);
                        const scope = e.target.checked ? "global" : "week";
                        try {
                          const res = await apiFetch<OptionalMessage[]>(`/director/sites/${siteId}/messages/${m.id}`, {
                            method: "PATCH",
                            headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                            body: JSON.stringify({ scope, week_iso: wk }),
                          });
                          setMessages(Array.isArray(res) ? sortMessagesChronologically(res) : []);
                        } catch {
                          toast.error("עדכון ההיקף נכשל");
                        }
                      }}
                    />
                    קבוע
                  </label>
                  <span className="text-xs text-zinc-500">
                    {m.scope === "global" ? "לכל השבועות הבאים" : "לשבוע זה בלבד"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isAddMessageOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={closeMessageModal}>
          <div
            className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold">{editingMessageId ? "עריכת הודעה" : "הוסף הודעה"}</div>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={closeMessageModal}
                aria-label="סגור"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
            <div className="rounded-md border dark:border-zinc-700">
              <div className="flex flex-wrap items-center gap-2 border-b p-2 dark:border-zinc-700">
                {(() => {
                  const btn = (active: boolean) =>
                    "rounded-md border px-2 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800 " +
                    (active ? "border-2 font-bold text-zinc-900 dark:text-zinc-100" : "text-zinc-700 dark:text-zinc-200");
                  const md = (fn: () => void) => (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    fn();
                  };
                  const isBold = !!messageEditor?.isActive("bold");
                  const isItalic = !!messageEditor?.isActive("italic");
                  const isUnderline = !!messageEditor?.isActive("underline");
                  const isH2 = !!messageEditor?.isActive("heading", { level: 2 });
                  const isBullet = !!messageEditor?.isActive("bulletList");
                  const isOrdered = !!messageEditor?.isActive("orderedList");
                  const isLink = !!messageEditor?.isActive("link");
                  const isHighlight = !!messageEditor?.isActive("highlight");
                  return (
                    <>
                      <button type="button" className={btn(isBold)} onMouseDown={md(() => messageEditor?.chain().focus().toggleBold().run())}>
                        B
                      </button>
                      <button
                        type="button"
                        className={btn(isItalic) + " italic"}
                        onMouseDown={md(() => messageEditor?.chain().focus().toggleItalic().run())}
                      >
                        I
                      </button>
                      <button
                        type="button"
                        className={btn(isUnderline) + " underline"}
                        onMouseDown={md(() => messageEditor?.chain().focus().toggleUnderline().run())}
                      >
                        U
                      </button>
                      <button
                        type="button"
                        className={btn(isH2)}
                        onMouseDown={md(() => messageEditor?.chain().focus().toggleHeading({ level: 2 }).run())}
                      >
                        H2
                      </button>
                      <button
                        type="button"
                        className={btn(isBullet)}
                        onMouseDown={md(() => messageEditor?.chain().focus().toggleBulletList().run())}
                      >
                        •
                      </button>
                      <button
                        type="button"
                        className={btn(isOrdered)}
                        onMouseDown={md(() => messageEditor?.chain().focus().toggleOrderedList().run())}
                      >
                        1.
                      </button>
                      <div className="mx-1 h-6 w-px bg-zinc-200 dark:bg-zinc-700" />
                      <button
                        type="button"
                        className={btn(isLink)}
                        onMouseDown={md(() => {
                          const url = window.prompt("כתובת קישור (URL):", "https://");
                          if (!url) return;
                          messageEditor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
                        })}
                      >
                        🔗
                      </button>
                      <div className="mx-1 h-6 w-px bg-zinc-200 dark:bg-zinc-700" />
                      <button
                        type="button"
                        className={btn(isHighlight)}
                        style={{ borderColor: messageHighlightColor, color: messageHighlightColor }}
                        onMouseDown={md(() =>
                          messageEditor?.chain().focus().toggleHighlight({ color: messageHighlightColor }).run(),
                        )}
                      >
                        HL
                      </button>
                      <input
                        type="color"
                        value={messageHighlightColor}
                        onChange={(e) => setMessageHighlightColor(e.target.value)}
                        className="h-8 w-10 cursor-pointer rounded-md border dark:border-zinc-700"
                        title="צבע סימון"
                      />
                      <button
                        type="button"
                        className={btn(false)}
                        style={{ borderColor: messageTextColor, color: messageTextColor }}
                        onMouseDown={md(() => messageEditor?.chain().focus().setColor(messageTextColor).run())}
                      >
                        A
                      </button>
                      <input
                        type="color"
                        value={messageTextColor}
                        onChange={(e) => setMessageTextColor(e.target.value)}
                        className="h-8 w-10 cursor-pointer rounded-md border dark:border-zinc-700"
                        title="צבע טקסט"
                      />
                    </>
                  );
                })()}
              </div>
              {messageEditor ? (
                <EditorContent editor={messageEditor} />
              ) : (
                <div className="flex min-h-32 items-center justify-center bg-white px-3 py-2 dark:bg-zinc-900">
                  <LoadingAnimation size={60} />
                </div>
              )}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
                <input
                  type="checkbox"
                  checked={newMessagePermanent}
                  onChange={(e) => setNewMessagePermanent(e.target.checked)}
                />
                קבוע (לכל השבועות הבאים)
              </label>
              <span className="text-xs text-zinc-500">{newMessagePermanent ? "קבוע" : "לשבוע זה בלבד"}</span>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={closeMessageModal}
              >
                ביטול
              </button>
              <button
                type="button"
                className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm text-white hover:bg-[#0092c6]"
                onClick={async () => {
                  const txt = newMessageText.trim();
                  if (!txt) return;
                  const wk = isoYMD(weekStart);
                  const targetScope: OptionalMessage["scope"] = newMessagePermanent ? "global" : "week";
                  try {
                    if (editingMessageId) {
                      const res = await apiFetch<OptionalMessage[]>(`/director/sites/${siteId}/messages/${editingMessageId}`, {
                        method: "PATCH",
                        headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                        body: JSON.stringify({ text: txt, scope: targetScope, week_iso: wk }),
                      });
                      setMessages(Array.isArray(res) ? sortMessagesChronologically(res) : []);
                      closeMessageModal();
                      return;
                    }
                    const created = await apiFetch<OptionalMessage>(`/director/sites/${siteId}/messages`, {
                      method: "POST",
                      headers: { Authorization: `Bearer ${localStorage.getItem("access_token")}` },
                      body: JSON.stringify({ text: txt, scope: targetScope, week_iso: wk }),
                    });
                    setMessages((prev) => sortMessagesChronologically([...prev, created]));
                  } catch {
                    toast.error("שמירת ההודעה נכשלה");
                  }
                  closeMessageModal();
                }}
              >
                {editingMessageId ? "שמור" : "הוסף"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
