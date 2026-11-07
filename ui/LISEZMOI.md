# ui/ — l'interface de Better Terminal For Claude

Page HTML/CSS/JS chargée en `file://` par la coque Swift (WKWebView). La coque transmet chaque ligne stream-json brute de `claude` via `bt.depuisClaude(ligne)` ; toute la lecture du protocole se fait ici. Contrat : `../CONTRAT.md`, protocole : `../moteur/PROTOCOLE.md`.

## Fichiers

Scripts classiques (`<script src>`, pas de modules), dans l'ordre de `index.html` :

| Fichier | Rôle |
|---|---|
| `js/commun.js` | Utilitaires sans DOM : nettoyage ANSI et bandeau du hook, résumés d'outils, durées, émetteur d'événements. |
| `js/session.js` | **Logique de session, sans aucun accès au DOM** (voir plus bas). |
| `js/markdown.js` | marked → DOMPurify → retouches (blocs de code + Copier, coloration, tableaux, liens, ligne ✅). |
| `js/vue-outils.js` | Détail des appels d'outils (Bash, Read, Write, Edit, Grep, Agent, TodoWrite, Web…, diff). |
| `js/vue-questions.js` | Blocs de question, de permission et de plan dans le fil. |
| `js/vue-fil.js` | Le fil : bulles d'Eliot, cartes de Claude, lignes d'outils repliées, réflexion, notes, fin de tour. |
| `js/defilement.js` | Défilement collé en bas, pastille « Nouveaux messages », navigation entre les messages d'Eliot. |
| `js/recherche.js` | Cmd+F maison (CSS Custom Highlight, sans casse ni accents). |
| `js/interface.js` | Barre du haut, sélecteurs modèle et effort, saisie, bannière d'attente, « Mes messages », raccourcis. |
| `js/pont.js` | Seul point de contact avec Swift : `window.bt` (entrée) et `BT.pont.envoyer` (sortie). |
| `js/faux-pont.js` | Développement seulement (inactif dès que `window.webkit` existe) : rejoue `../fixtures/`. |
| `js/app.js` | Câblage, délégation des clics (Copier, liens), blocage du glisser-déposer et de la navigation. |
| `css/app.css`, `css/code.css` | Style « néon / verre liquide » et thème de coloration. |

## Séparation session / rendu (pour le futur mode vocal)

`js/session.js` (`BT.Session`) contient tout l'état et toute la logique : lecture du stream-json, regroupement des messages, outils et sous-agents, questions et permissions, réponses (`repondre`, `reponseExterne`), envoi de messages, interruption, changement de modèle et d'effort, historique, messages `etat`, `question` et `questionClose` vers le pont. Il ne touche jamais au DOM et ne connaît que la fonction `envoyer(type, données)` qu'on lui passe.

Le rendu s'abonne à ses événements : `ajout`, `maj(item, quoi)`, `etat`, `activite`, `info`, `modeles`, `historique`. Tous les fichiers `vue-*`, `interface`, `defilement` et `recherche` sont des consommateurs. Un autre consommateur (une voix, par exemple) peut s'abonner aux mêmes événements et appeler les mêmes méthodes sans rien changer à la session. Le banc de test Node fait déjà tourner `session.js` sans navigateur.

## Bibliothèques (`vendor/`)

Copies locales, jamais chargées depuis le réseau (CSP `script-src 'self'`).

| Fichier | Version | Licence | SHA-256 |
|---|---|---|---|
| `marked-18.1.1.umd.js` | marked 18.1.1 | MIT (`LICENSE-marked.txt`) | `b82b9334406d8bdd16b6236c08de1cb65b2a859873ca9503d9cc0b292ca3c12a` |
| `purify-3.4.17.min.js` | DOMPurify 3.4.17 | Apache 2.0 ou MPL 2.0 (`LICENSE-dompurify.txt`) | `cd37898f9782adf54820c413191b5691803f0f137c799d6edcfd38523b4c2c31` |
| `highlight-11.12.0.min.js` | highlight.js 11.12.0, version commune (36 langages) | BSD-3-Clause (`LICENSE-highlightjs.txt`) | `8ab71eb09c51f501e5e25157d9cff100e46cc29bcbfc744d0b746d451fca7f53` |

## Sécurité

- Tout texte de Claude passe par marked **puis** DOMPurify (liste blanche de balises et d'attributs). Le HTML brut écrit par Claude est affiché comme du texte.
- Les liens ne gardent leur `href` qu'en `http(s)`, `mailto` et `#`. Un clic ne navigue jamais : il appelle `ouvrirLien` (http(s) seulement).
- Les images ne sont jamais chargées ; elles deviennent un lien « Image : … ».
- La sortie de highlight.js est elle aussi assainie (seulement `span class`).
- Aucun gestionnaire d'événement en ligne, aucun `eval`, aucun `innerHTML` de texte non assaini.

## Développer sans la coque

```sh
cd ~/Desktop/Projets/Better-Terminal-For-Claude
python3 -m http.server 8765 --bind 127.0.0.1
# puis : http://127.0.0.1:8765/ui/index.html?fixture=markdown-riche
```

Paramètres du faux pont :

| Paramètre | Effet |
|---|---|
| `fixture=<nom>` | Rejoue `fixtures/<nom>.jsonl` ; les messages d'Eliot viennent de `<nom>.entree.jsonl`. |
| `historique=<nom>` | Charge un transcript comme `bt.historique`. |
| `vitesse=<x>` | Vitesse du rejeu (1 = temps réel, 0 = instantané). |
| `auto=0` | N'envoie pas les messages enregistrés : il faut taper (le texte est ignoré, le suivant est rejoué). |
| `telegram=1` | Simule une réponse venue de Telegram aux questions et permissions. |
| `ouvrir=1` | Déplie tous les appels d'outils. |
| `haut=1`, `eliot=<n>` | Remonte en haut, ou au n-ième message d'Eliot. |
| `recherche=<texte>` | Ouvre la recherche sur ce texte. |
| `fin=1` | Termine la session à la fin du rejeu. |
| `fond=clair` | Faux bureau clair, pour vérifier la lisibilité sur un fond clair. |
| `projet`, `emoji`, `modele`, `effort` | Valeurs de `bt.info`. |

## Corrections d'intégration (agent F, 07/11/2026)

Ces corrections viennent du test dans la vraie coque, sur de vraies sessions. Les preuves sont dans `../app/LISEZMOI.md` et dans `../app/captures/integration-*.png`. Toutes concernent `js/session.js`.

- **Question perdue après ⌘R.** La question en attente disparaissait après un rechargement : l'outil s'affichait « interrompu », l'état passait à « prêt » alors que Claude attendait encore. Deux causes, et deux corrections :
  - `initialize` n'était envoyé qu'avant la première écriture, donc jamais après un ⌘R. Il part maintenant dès la fin de `chargerHistorique`, c'est-à-dire à la reprise et à chaque ⌘R. Si claude n'est pas encore lancé, la coque garde la ligne.
  - `pending_permission_requests` arrive à côté de `response` dans le `control_response`, et pas dedans (vérifié sur 2.1.319, y compris pour un second `initialize` sur le même processus). `_reponseControle` passe désormais la réponse brute au rappel, et les requêtes en attente sont rejouées même si la réponse est une erreur.
- **Identifiants de pont stables.** Ils sont maintenant tirés du `request_id` (`q<16 caractères>-<index>`, ou `-p` pour une permission), au lieu d'être tirés au hasard. Après un ⌘R, la question réannoncée garde le même identifiant : `tg-question.sh` répond « déjà envoyée » sans envoyer de second message Telegram, et un clic sur le premier message reste valable. Le hasard (`idCourt`) ne sert plus que de repli, sans `request_id`.
- **Outil marqué à tort.** L'outil qu'un ⌘R avait marqué « interrompu » repasse « en cours » quand sa question est retrouvée.

## Captures (`captures/`)

Fenêtre WKWebView réelle (même moteur que la coque), capturée par le serveur de fenêtres de macOS, à partir des fixtures rejouées par le faux pont : fond de bureau factice, sombre sauf `17-fond-clair.png`. Fenêtre de 1280 × 900 points (700 × 860 pour `18-fenetre-etroite.png`), en Retina.
