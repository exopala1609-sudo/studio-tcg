# CLAUDE.md — Studio TCGBP (créer et collectionner des cartes entre amis)

Application web installable (PWA). **Tout le code est dans un seul fichier : `index.html`**
(environ 3 600 lignes, 195 fonctions). Autres fichiers : `sw.js` (mode hors ligne),
`manifest.json` (installation sur téléphone), `icons/`.

## Qui est l'utilisateur
Hadrien, **pas développeur**. Explique simplement, avec des images de la vie courante.
Indique l'endroit exact du fichier modifié (nom de la fonction ou numéro de ligne).

## Les 4 vues de l'application
Studio (créer une carte), Collection, Decks, Arène (table de jeu). Le changement de vue
passe par `setMainView()` et l'attribut `data-view` du `<body>`.

## Supabase (base de données, images, temps réel)
- Projet « Studio TCG ». Tables : `cards` (cartes) et `studio_settings` (réglages partagés).
- Images : bucket public `card-images` (5 Mo maximum, JPEG/PNG/WebP).
- La clé dans le code est la clé **publique** : normal. **Ne jamais y mettre la clé
  `service_role`** (elle donne tous les droits).
- La sécurité repose sur les règles d'accès (RLS) : tout membre connecté voit toutes les
  cartes, mais ne modifie ou ne supprime que les siennes. Toute nouvelle table doit
  naître avec RLS activé et ses règles écrites.

## Règles du projet
- Les bibliothèques externes (html2canvas, jszip, lucide, supabase-js) sont chargées
  depuis internet avec une **version fixe**. Ne pas changer de version sans test.
- `sw.js` : à chaque modification importante, augmenter le numéro dans
  `const CACHE = 'studio-tcgbp-vN'`, sinon d'anciens fichiers peuvent rester en cache.
- Supabase n'est jamais mis en cache (toujours en direct).
- Interface en français, adaptée téléphone **et** ordinateur (3 colonnes au-delà de 1200 px).

## Avant de dire « c'est fini »
Pas de test automatique pour l'instant. Ouvrir la page dans un navigateur, vérifier
la console (aucune erreur rouge) et essayer : créer une carte, l'enregistrer, la retrouver
dans la Collection, l'ajouter à un deck.

## Dette connue
- Fichier unique de 458 Ko : difficile à modifier sans casser autre chose. Un découpage
  en plusieurs fichiers est souhaitable, mais à décider ensemble avant de commencer.
- Un seul enregistrement dans l'historique Git (« Add files via upload »).
- Les dépôts publics exposent le code : pas de secret dans ce fichier.
