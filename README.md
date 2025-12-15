# Webapp - Taux des livrets réglementés

## Déploiement GitHub Pages
1. Crée un repo GitHub (ex: `taux-livrets-webapp`)
2. Uploade **index.html** + **rates.json** (ce dossier)
3. GitHub → Settings → Pages → Source : branch `main`, folder `/root`
4. Ouvre l’URL GitHub Pages

## Mise à jour (update auto)
- Modifie `rates.json` (taux, dates, historique) puis commit/push
- La webapp est à jour automatiquement

## Historique (format)
`history` = liste des **dates de changement** (ISO) + taux (décimal).
Ex : { "date": "2025-08-01", "rate": 0.017 }

Le graphe est en **escalier** (paliers + sauts verticaux).
