/** Noms de משמרות actives depuis la config stations (identique au planning director). */
export function collectShiftNamesFromSiteConfig(site: { config?: { stations?: unknown[] } } | null): string[] {
  return Array.from(
    new Set(
      ((site?.config?.stations || []) as { shifts?: Array<{ enabled?: boolean; name?: string }> }[])
        .flatMap((st) => (st?.shifts || []).filter((sh) => sh?.enabled).map((sh) => sh?.name))
        .filter(Boolean) as string[],
    ),
  );
}
