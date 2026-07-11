/**
 * Comportement client de apiFetch (erreurs, 401, cookie auth) — sans importer la page planning.
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

  it("ajoute Content-Type application/json et credentials include", async () => {
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
    expect(init.credentials).toBe("include");
  });

  it("supprime un Authorization Bearer null/undefined avant l’envoi", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    });
    global.fetch = fetchMock;

    const { apiFetch } = await import("@/lib/api");
    await apiFetch("/director/sites/", {
      headers: { Authorization: "Bearer null" },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const h = new Headers(init.headers);
    expect(h.get("Authorization")).toBeNull();
  });

  it("sur 401, efface le reste localStorage access_token sans redirection globale", async () => {
    localStorage.setItem("access_token", "stale-token");
    const hrefSpy = jest.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        pathname: "/director/sites",
        search: "",
        get href() {
          return "http://localhost/director/sites";
        },
        set href(v: string) {
          hrefSpy(v);
        },
        assign: jest.fn(),
        replace: jest.fn(),
        reload: jest.fn(),
      },
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
    // La redirection login est laissée aux pages / gardes — pas dans apiFetch.
    expect(hrefSpy).not.toHaveBeenCalled();
  });

  it("sur 401 pour /auth/login, n’applique pas de redirection", async () => {
    localStorage.setItem("access_token", "x");
    const hrefSpy = jest.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        pathname: "/login/director",
        search: "",
        get href() {
          return "http://localhost/login/director";
        },
        set href(v: string) {
          hrefSpy(v);
        },
        assign: jest.fn(),
        replace: jest.fn(),
        reload: jest.fn(),
      },
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

  it("sur 403, ne vide pas le reste localStorage par défaut", async () => {
    localStorage.setItem("access_token", "tok");
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        pathname: "/director",
        search: "",
        get href() {
          return "http://localhost/director";
        },
        set href(_v: string) {
          throw new Error("unexpected redirect");
        },
        assign: jest.fn(),
        replace: jest.fn(),
        reload: jest.fn(),
      },
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
