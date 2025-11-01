#!/usr/bin/env python3
"""
Script pour supprimer les doublons de travailleurs dans un même site.
Garde le premier worker trouvé (le plus ancien par ID) et supprime les autres.

Usage:
    python scripts/remove_duplicate_workers.py [--site-id SITE_ID] [--dry-run]
    
Options:
    --site-id SITE_ID    : Nettoyer uniquement un site spécifique (par ID)
    --dry-run            : Afficher les doublons sans les supprimer
"""

import sys
import os
from collections import defaultdict
from sqlalchemy import func

# Ajouter le répertoire parent au path pour importer les modules
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.database import SessionLocal
from app.models import SiteWorker, Site


def find_duplicates(session, site_id=None):
    """Trouve les doublons de workers par site (nom insensible à la casse)."""
    query = session.query(SiteWorker)
    
    if site_id:
        query = query.filter(SiteWorker.site_id == site_id)
    
    all_workers = query.order_by(SiteWorker.site_id, SiteWorker.id).all()
    
    # Grouper par (site_id, nom_lowercase)
    groups = defaultdict(list)
    for worker in all_workers:
        key = (worker.site_id, worker.name.lower().strip())
        groups[key].append(worker)
    
    # Filtrer pour ne garder que les groupes avec doublons (plus d'un worker)
    duplicates = {k: v for k, v in groups.items() if len(v) > 1}
    
    return duplicates


def remove_duplicates(session, duplicates, dry_run=False):
    """Supprime les doublons en gardant le premier (le plus ancien)."""
    total_removed = 0
    total_groups = len(duplicates)
    
    print(f"\n{'[DRY-RUN] ' if dry_run else ''}Traitement de {total_groups} groupe(s) de doublons...\n")
    
    for (site_id, name_lower), workers in sorted(duplicates.items()):
        # Trier par ID pour garder le plus ancien
        workers_sorted = sorted(workers, key=lambda w: w.id)
        keeper = workers_sorted[0]
        duplicates_to_remove = workers_sorted[1:]
        
        # Obtenir le nom du site
        site = session.get(Site, site_id)
        site_name = site.name if site else f"Site ID {site_id}"
        
        print(f"Site: {site_name} (ID: {site_id})")
        print(f"  Nom: '{keeper.name}'")
        print(f"  Doublons trouvés: {len(duplicates_to_remove)}")
        print(f"  Garde: Worker ID {keeper.id} (nom: '{keeper.name}', max_shifts: {keeper.max_shifts}, roles: {keeper.roles})")
        
        for dup in duplicates_to_remove:
            print(f"  {'[DRY-RUN] Supprimerait' if dry_run else 'Supprime'} Worker ID {dup.id} (nom: '{dup.name}', max_shifts: {dup.max_shifts}, roles: {dup.roles})")
            if not dry_run:
                session.delete(dup)
                total_removed += 1
        print()
    
    if not dry_run and total_removed > 0:
        session.commit()
        print(f"✓ {total_removed} doublon(s) supprimé(s) avec succès!")
    elif dry_run:
        print(f"[DRY-RUN] {len([w for group in duplicates.values() for w in group[1:]])} doublon(s) seraient supprimés")
    
    return total_removed


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='Supprimer les doublons de travailleurs par site')
    parser.add_argument('--site-id', type=int, help='Nettoyer uniquement un site spécifique (par ID)')
    parser.add_argument('--dry-run', action='store_true', help='Afficher les doublons sans les supprimer')
    
    args = parser.parse_args()
    
    session = SessionLocal()
    try:
        # Trouver les doublons
        duplicates = find_duplicates(session, args.site_id)
        
        if not duplicates:
            print("Aucun doublon trouvé!")
            return
        
        # Afficher le résumé
        print(f"\n{'[DRY-RUN] ' if args.dry_run else ''}Résumé:")
        print(f"  Nombre de groupes de doublons: {len(duplicates)}")
        total_duplicates = sum(len(workers) - 1 for workers in duplicates.values())
        print(f"  Nombre total de doublons à supprimer: {total_duplicates}")
        
        # Demander confirmation si pas en dry-run
        if not args.dry_run:
            response = input("\nVoulez-vous continuer et supprimer ces doublons? (oui/non): ")
            if response.lower() not in ['oui', 'o', 'yes', 'y']:
                print("Opération annulée.")
                return
        
        # Supprimer les doublons
        removed = remove_duplicates(session, duplicates, dry_run=args.dry_run)
        
        if args.dry_run:
            print("\nPour vraiment supprimer les doublons, relancez le script sans --dry-run")
        
    except Exception as e:
        session.rollback()
        print(f"\n✗ Erreur: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        session.close()


if __name__ == "__main__":
    main()

