# Scripts de maintenance

## remove_duplicate_workers.py

Script pour supprimer les doublons de travailleurs dans un même site.

### Usage

Depuis le répertoire `backend/` :

```bash
# Mode dry-run (affiche les doublons sans les supprimer)
python scripts/remove_duplicate_workers.py --dry-run

# Supprimer tous les doublons de tous les sites
python scripts/remove_duplicate_workers.py

# Supprimer les doublons d'un site spécifique
python scripts/remove_duplicate_workers.py --site-id 1

# Mode dry-run pour un site spécifique
python scripts/remove_duplicate_workers.py --site-id 1 --dry-run
```

### Fonctionnement

Le script :
1. Trouve les doublons en comparant les noms (insensible à la casse et aux espaces)
2. Pour chaque groupe de doublons, garde le worker avec le plus petit ID (le plus ancien)
3. Supprime les autres doublons
4. Affiche un résumé des actions effectuées

**Note importante :** Toujours faire un `--dry-run` d'abord pour vérifier les doublons avant de les supprimer définitivement!

### Options

- `--site-id SITE_ID` : Nettoyer uniquement un site spécifique
- `--dry-run` : Mode simulation, affiche les doublons sans les supprimer


## import_sqlite_to_postgres.py (bootstrap prod depuis SQLite local)

Ce script sert à **copier ta base SQLite locale** (dev) vers **Postgres (Neon/Render)**.

### Pré-requis

- Avoir le fichier SQLite local (souvent `backend/dev.db` en local).
- Avoir l’URL Neon (Postgres) prête.

### Usage recommandé (bootstrap)

Depuis le répertoire `backend/` :

```bash
# IMPORTANT: remplace DATABASE_URL par l'URL Neon (sans guillemets)
export DATABASE_URL="postgresql://USER:PASSWORD@HOST/DB?sslmode=require"

# Si ton fichier SQLite est bien backend/dev.db:
python scripts/import_sqlite_to_postgres.py --truncate

# Si ton SQLite est ailleurs:
python scripts/import_sqlite_to_postgres.py --sqlite-path "/chemin/vers/ton/dev.db" --truncate
```

### Notes

- `--truncate` : vide les tables cibles avant import (recommandé si la base Neon est vide ou si tu veux la remplacer).
- Le script copie les IDs pour conserver les relations entre tables.

