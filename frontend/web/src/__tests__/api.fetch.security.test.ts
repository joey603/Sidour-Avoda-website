/**
 * Comportement client de apiFetch (erreurs, 401, en-têtes) — sans importer la page planning.
 */

describe("apiFetch — sécurité et erreurs HTTP", () => {
  const originalFetch = global.fetch;
  const originalLocation = window.location;

  beforeEach(() => {
    localStorage.clear();
    jest.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation, writable: true });
    jest.resetModules();
  });

  it("ajoute Content-Type application/json pour un corps JSON", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    });
    global.fetch = fetchMock;

    const { apiFetch } = await import("@/lib/api");
    await apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ email: "a@b.co", password: "x" }) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const h = new Headers(init.headers);
    expect(h.get("Content-Type")).toBe("application/json");
  });

  it("sur 401 hors /auth/, efface access_token et redirige hors page login", async () => {
    localStorage.setItem("access_token", "stale-token");
    const hrefSpy = jest.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        pathname: "/director/sites",
        search: "",
        href: "http://localhost/director/sites",
        set href(v: string) {
          hrefSpy(v);
        },
        assign: jest.fn(),
        replace: jest.fn(),
        reload: jest.fn(),
      },
      writable: true,
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => "application/json" },
      json: async () => ({ detail: "Non authentifié" }),
    });

    const { apiFetch } = await import("@/lib/api");
    await expect(apiFetch("/director/sites/")).rejects.toThrow();
    expect(localStorage.getItem("access_token")).toBeNull();
    expect(hrefSpy).toHaveBeenCalled();
    const target = hrefSpy.mock.calls[0][0] as string;
    expect(target).toContain("/login/director");
    expect(target).toContain("returnUrl=");
  });

  it("sur 401 pour /auth/login, n’applique pas la redirection globale (pas de href)", async () => {
    localStorage.setItem("access_token", "x");
    const hrefSpy = jest.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        pathname: "/login/director",
        search: "",
        href: "http://localhost/login/director",
        set href(v: string) {
          hrefSpy(v);
        },
        assign: jest.fn(),
        replace: jest.fn(),
        reload: jest.fn(),
      },
      writable: true,
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => "application/json" },
      json: async () => ({ detail: "Identifiants invalides" }),
    });

    const { apiFetch } = await import("@/lib/api");
    await expect(apiFetch("/auth/login", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(hrefSpy).not.toHaveBeenCalled();
  });

  it("sur 403, ne vide pas le token par défaut", async () => {
    localStorage.setItem("access_token", "tok");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        pathname: "/director",
        search: "",
        href: "http://localhost/director",
        set href(_v: string) {
          throw new Error("unexpected redirect");
        },
        assign: jest.fn(),
        replace: jest.fn(),
        reload: jest.fn(),
      },
      writable: true,
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => "application/json" },
      json: async () => ({ detail: "Accès refusé" }),
    });

    const { apiFetch } = await import("@/lib/api");
    await expect(apiFetch("/director/sites/")).rejects.toThrow();
    expect(localStorage.getItem("access_token")).toBe("tok");
  });
});
