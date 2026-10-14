/**
 * Partage un blob image via l’API Web Share (fichiers), avec repli téléchargement.
 * Retourne le résultat pour l’UI (toast).
 */
export type SharePlanningPhotoResult =
  | { status: "shared" }
  | { status: "aborted" }
  | { status: "downloaded_fallback" }
  | { status: "error"; message: string };

export type SharePlanningPhotoDeps = {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  download: (filename: string, blob: Blob) => void;
};

export async function sharePlanningPhoto(opts: {
  blob: Blob;
  filename: string;
  title: string;
  text?: string;
  deps: SharePlanningPhotoDeps;
}): Promise<SharePlanningPhotoResult> {
  const { blob, filename, title, text, deps } = opts;
  const mime = blob.type || "image/png";
  const file = new File([blob], filename, { type: mime });
  const shareData: ShareData = {
    files: [file],
    title,
    text: text || title,
  };

  const shareFn = deps.share;
  if (typeof shareFn === "function") {
    const canShareFiles =
      typeof deps.canShare !== "function" || deps.canShare({ files: [file] });
    if (canShareFiles) {
      try {
        await shareFn(shareData);
        return { status: "shared" };
      } catch (e: unknown) {
        const name =
          e && typeof e === "object" && "name" in e ? String((e as { name?: unknown }).name) : "";
        if (name === "AbortError") return { status: "aborted" };
        const message = e instanceof Error ? e.message : "נסה שוב.";
        return { status: "error", message };
      }
    }
  }

  deps.download(filename, blob);
  return { status: "downloaded_fallback" };
}
