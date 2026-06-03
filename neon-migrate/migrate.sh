#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUMP="${DIR}/neon-backup.dump"

# pg_dump doit être >= version serveur Neon (souvent PG 17). Préfère les clients Homebrew @17.
pick_pg17_tools() {
  if [[ -n "${PG_DUMP:-}" ]] && [[ -n "${PG_RESTORE:-}" ]] && [[ -x "${PG_DUMP}" ]] && [[ -x "${PG_RESTORE}" ]]; then
    echo "==> Utilisation explicite : PG_DUMP=${PG_DUMP} PG_RESTORE=${PG_RESTORE}"
    return 0
  fi

  local candidates=(
    "${PG17_HOME:+${PG17_HOME}/bin}"
    "/opt/homebrew/opt/postgresql@17/bin"
    "/usr/local/opt/postgresql@17/bin"
  )

  local c d r
  for c in "${candidates[@]}"; do
    [[ -z "${c}" ]] && continue
    d="${c}/pg_dump"
    r="${c}/pg_restore"
    if [[ -x "${d}" ]] && "${d}" --version 2>/dev/null | grep -qE '\(PostgreSQL\) 17\.'; then
      PG_DUMP="${d}"
      PG_RESTORE="${r}"
      echo "==> Clients PostgreSQL 17 trouvés : ${c}"
      return 0
    fi
  done

  # Déjà sur le PATH et en version 17 ?
  if command -v pg_dump >/dev/null 2>&1 && pg_dump --version 2>/dev/null | grep -qE '\(PostgreSQL\) 17\.'; then
    PG_DUMP="$(command -v pg_dump)"
    PG_RESTORE="$(command -v pg_restore)"
    echo "==> pg_dump / pg_restore 17 trouvés dans le PATH."
    return 0
  fi

  echo "Erreur : aucun pg_dump PostgreSQL 17 trouvé." >&2
  echo "Installe les clients : brew install postgresql@17" >&2
  echo "Puis ajoute au PATH, ou définis PG17_HOME, par ex. :" >&2
  echo "  export PATH=\"/opt/homebrew/opt/postgresql@17/bin:\$PATH\"   # Apple Silicon" >&2
  echo "  export PATH=\"/usr/local/opt/postgresql@17/bin:\$PATH\"    # Intel" >&2
  return 1
}

if [[ ! -f "${DIR}/local.env" ]]; then
  echo "Crée le fichier neon-migrate/local.env (copie local.env.example)."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "${DIR}/local.env"
set +a

if [[ -z "${DATABASE_URL_OLD:-}" ]] || [[ -z "${DATABASE_URL_NEW:-}" ]]; then
  echo "DATABASE_URL_OLD et DATABASE_URL_NEW doivent être définis dans local.env"
  exit 1
fi

pick_pg17_tools

echo "==> Export depuis l’ancienne instance Neon..."
"${PG_DUMP}" "${DATABASE_URL_OLD}" --format=custom --file="${DUMP}"

echo "==> Import vers la nouvelle instance Neon..."
"${PG_RESTORE}" --dbname="${DATABASE_URL_NEW}" --no-owner --no-acl --verbose "${DUMP}"

echo "==> Terminé. Pense à supprimer ou déplacer ${DUMP} hors du repo si tu n’en as plus besoin."
echo "==> Mets à jour DATABASE_URL sur ton serveur Oracle puis régénère les mots de passe Neon si besoin."
