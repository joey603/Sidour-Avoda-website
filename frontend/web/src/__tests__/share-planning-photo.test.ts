import { sharePlanningPhoto } from "@/components/planning-v2/lib/share-planning-photo";

describe("sharePlanningPhoto", () => {
  const blob = new Blob(["png-bytes"], { type: "image/png" });
  const filename = "site-2026-10-12-planning.png";

  it("partage via navigator.share quand les fichiers sont supportés", async () => {
    const shared: ShareData[] = [];
    const share = async (data: ShareData) => {
      shared.push(data);
    };
    const canShare = () => true;
    const download = jest.fn();

    const result = await sharePlanningPhoto({
      blob,
      filename,
      title: "תצוגה מקדימה · צילום שבוע",
      text: "שבוע מתאריך 12/10/2026",
      deps: { share, canShare, download },
    });

    expect(result).toEqual({ status: "shared" });
    expect(shared).toHaveLength(1);
    expect(shared[0].title).toBe("תצוגה מקדימה · צילום שבוע");
    expect(shared[0].files).toHaveLength(1);
    expect(shared[0].files?.[0].name).toBe(filename);
    expect(download).not.toHaveBeenCalled();
  });

  it("télécharge en fallback si canShare refuse les fichiers", async () => {
    const share = jest.fn(async () => undefined);
    const canShare = jest.fn(() => false);
    const download = jest.fn();

    const result = await sharePlanningPhoto({
      blob,
      filename,
      title: "תצוגה מקדימה · צילום שבוע",
      deps: { share, canShare, download },
    });

    expect(result).toEqual({ status: "downloaded_fallback" });
    expect(share).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledWith(filename, blob);
  });

  it("télécharge en fallback si share est indisponible", async () => {
    const download = jest.fn();
    const result = await sharePlanningPhoto({
      blob,
      filename,
      title: "תצוגה מקדימה · צילום חודש",
      deps: { download },
    });
    expect(result).toEqual({ status: "downloaded_fallback" });
    expect(download).toHaveBeenCalledWith(filename, blob);
  });

  it("ignore AbortError (annulation utilisateur)", async () => {
    const err = new Error("Share canceled");
    err.name = "AbortError";
    const share = jest.fn(async () => {
      throw err;
    });
    const download = jest.fn();

    const result = await sharePlanningPhoto({
      blob,
      filename,
      title: "preview",
      deps: { share, canShare: () => true, download },
    });

    expect(result).toEqual({ status: "aborted" });
    expect(download).not.toHaveBeenCalled();
  });

  it("retourne error pour les autres échecs de share", async () => {
    const share = jest.fn(async () => {
      throw new Error("network down");
    });
    const download = jest.fn();

    const result = await sharePlanningPhoto({
      blob,
      filename,
      title: "preview",
      deps: { share, canShare: () => true, download },
    });

    expect(result).toEqual({ status: "error", message: "network down" });
    expect(download).not.toHaveBeenCalled();
  });
});
