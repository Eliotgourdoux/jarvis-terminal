# Contrat commun — Better Terminal For Claude

Ce fichier est la référence partagée par les 5 agents. Plan général : voir `CLAUDE.md`.
Règle d'or : **chaque agent n'écrit que dans ses fichiers** (tableau ci-dessous). Il peut tout lire.
Si un agent a besoin d'un changement chez un autre, il le note dans son rapport final, il ne le fait pas lui-même.

## Répartition des fichiers

| Agent | Rôle | Écrit uniquement dans |
|---|---|---|
| A — Alerte | Hook d'alerte quand une session Terminal attend Eliot | `~/.claude/hooks/alerte-attente.sh` (nouveau), section `hooks` de `~/.claude/settings.json` (fusion, jamais écrasement) |
| B — Moteur | Test technique stream-json, protocole, enregistrements | `moteur/`, `fixtures/` |
| C — Interface | Toute l'interface HTML/CSS/JS | `ui/` |
| D — Coque | App Swift minimale (fenêtre, verre, processus claude, pont) | `app/` |
| E — Telegram | Boutons inline Telegram pour les questions | `~/Desktop/Projets/Jarvis-Ultron-Telegram/tg-question.sh` (nouveau), `tg-boutons.sh` (nouveau), `tg-router.sh` (modification par remplacement atomique, copie `tg-router.sh.bak-boutons` avant) |

Dossier d'exécution partagé (créé par qui en a besoin) : `~/.config/better-terminal/`
- `sessions/<sessionId>.json` : état de chaque session de l'app (pour Cockpit, plus tard).
- `questions/<id>.json`, `questions/<id>.reponse.json` : boîte aux lettres des questions Telegram.

## Principe d'architecture

- Le moteur est le vrai Claude Code : `claude` lancé sans interface texte, en stream-json (entrée et sortie).
- **Swift est un tuyau bête.** Il lance le processus, transmet chaque ligne de stdout à la page, écrit sur stdin ce que la page lui donne, et exécute quelques actions prédéfinies. Toute la logique (lecture du protocole, état, rendu) est dans la page JS.
- La page fonctionne aussi dans un navigateur, sans Swift, grâce à un faux pont qui rejoue les enregistrements de `fixtures/`.

## Pont page ↔ Swift

Page → Swift : `window.webkit.messageHandlers.bt.postMessage(obj)` ; `obj.type` parmi :
- `pret` : la page est chargée, Swift peut envoyer `info` puis démarrer la session.
- `versClaude` `{ligne}` : une ligne JSON complète à écrire sur le stdin de claude (la page construit le message).
- `relancer` `{modele?, effort?}` : arrêter proprement et relancer avec `--resume <sessionId>` et les nouvelles options (repli si le changement en cours de session n'est pas possible).
- `ouvrirTerminal` : ouvrir Terminal.app avec `cd <cwd> && claude --resume <sessionId>` (le filet de sécurité).
- `ouvrirShell` : ouvrir une fenêtre Terminal.app dans le dossier du projet (`open -a Terminal <cwd>`), la session continue dans l’app.
- `fermer` : arrêter le processus proprement et fermer la fenêtre.
- `copier` `{texte}` : presse-papiers.
- `ouvrirLien` `{url}` : ouvrir dans le navigateur par défaut, uniquement `http://` et `https://`. La vue web ne navigue jamais ailleurs que sur sa page.
- `etat` `{etat: "travaille"|"attend"|"pret"|"termine", resume}` : Swift l'écrit dans `~/.config/better-terminal/sessions/<sessionId>.json` ; sur `attend`, notification Mac (terminal-notifier), une seule fois par attente.
- `question` `{id, type, texte, options}` et `questionClose` `{id, reponse}` : pour l'étape Telegram (voir plus bas).

Swift → page : fonctions de `window.bt`, appelées via `evaluateJavaScript` :
- `bt.info({cwd, projet, emoji, sessionId, modele, effort})`
- `bt.depuisClaude(ligne)` : une ligne brute du stdout de claude (chaîne JSON).
- `bt.stderr(texte)`
- `bt.fin({code})` : le processus s'est arrêté.
- `bt.reponseExterne({id, reponse, source})` : réponse arrivée depuis Telegram.
- `bt.historique(lignes)` : à la reprise d'une session, les lignes du transcript `~/.claude/projects/<dossier>/<sessionId>.jsonl`, envoyées avant le démarrage du processus (le mode stream-json ne rejoue pas l'historique). L'agent B documente le format du transcript et la règle de nommage du dossier dans `moteur/PROTOCOLE.md`, avec un exemple dans `fixtures/transcript-exemple.jsonl`.

Contraintes techniques de la page : scripts classiques (`<script src>`), pas de modules ES ni de `fetch` dans le chemin de production, pour fonctionner en `file://` dans WKWebView. Le faux pont (navigateur uniquement) peut utiliser `fetch` via un petit serveur local.

## Sécurité (non négociable)

- Tout texte venant de Claude est rendu en markdown **puis assaini** (DOMPurify ou équivalent). Aucun `innerHTML` de texte brut non assaini, aucun gestionnaire d'événement en ligne, aucun `eval`.
- La page a une CSP stricte (`script-src 'self'`). Bibliothèques copiées en local dans `ui/vendor/`, jamais de CDN à l'exécution.
- Aperçus (blocs ```html apercu, ```svg, ```mermaid ; `ui/js/apercu.js`, `app/Sources/Apercu.swift`) : rendus dans une iframe `sandbox="allow-scripts allow-popups"` sans `allow-same-origin`, servie par `btapercu://app/` (liste fermée de fichiers de `ui/apercu/`, CSP propre). WebKit expose quand même `window.webkit.messageHandlers` dans ce cadre : chaque gestionnaire de la fenêtre de session doit donc refuser tout message hors cadre principal (`bt` et `medias` le font). Claude en est informé par `--append-system-prompt` (`ClaudeArgs.consigneAffichage`).
- Swift n'exécute **jamais** une commande venant de la page : seulement les actions prédéfinies ci-dessus. `versClaude` écrit uniquement sur le stdin de claude.

## Variables d'environnement

- `BT_APP=1` : posée par la coque sur chaque processus claude de l'app.
- `BT_TEST=1` : posée par l'agent B sur ses processus de test.
- Le hook d'alerte (agent A) ne fait rien si `BT_APP`, `BT_TEST` ou `TG_BOT_NAME` est défini : l'app gère ses propres alertes, les tests ne doivent pas déranger Eliot, et les sessions Jarvis/Ultron sont déjà sur Telegram.

## Binaire claude

Dans le shell d'Eliot, `claude` est un alias de `claude --dangerously-skip-permissions`. Utiliser le vrai binaire (`~/.local/bin/claude`, ou `whence -p claude`). Version actuelle : 2.1.319.
Eliot travaille en bypass ; l'app doit garder ce comportement, et faire remonter les demandes qui passent quand même (questions de Claude, permissions particulières).

## Questions Telegram (étape 6)

1. La page détecte une question (permission ou question de Claude avec options) → `question` vers Swift.
2. Swift écrit `~/.config/better-terminal/questions/<id>.json` puis lance `tg-question.sh envoyer <fichier>`.
3. Le routeur Jarvis reçoit le clic (callback_query) → écrit `<id>.reponse.json`. Swift surveille le dossier → `bt.reponseExterne`.
4. Si Eliot répond d'abord sur le Mac : page → `questionClose` → Swift lance `tg-question.sh clore <id> "<texte>"`, qui met à jour le message Telegram.

Format de `<id>.json` : `{id, sessionId, projet, type: "permission"|"choix"|"multi"|"texte", texte, options: [{label, description}], cree}`.
Format de `<id>.reponse.json` : `{id, reponse: [labels] | "texte libre", source: "telegram"|"mac", date}`.
Identifiants courts (8 caractères) : `callback_data` est limité à 64 octets.

## Écarts validés après construction (07/11/2026)

Sources : `moteur/PROTOCOLE.md` (agent B) et `app/LISEZMOI.md` (agent D). Ils remplacent les sections ci-dessus là où elles diffèrent.
- Lancement de claude **sans `-p`** : `--output-format stream-json --input-format stream-json --verbose --include-partial-messages --permission-prompt-tool=stdio --dangerously-skip-permissions --thinking-display summarized [--model m] [--effort e] --session-id <uuid> | --resume <id>`. Environnement : shell de connexion, sans variables `CLAUDE*` ni `AI_AGENT`, avec `BT_APP=1`.
- Modèle et effort se changent à chaud (`set_model`, `apply_flag_settings {"effortLevel"}`) ; `relancer` n'est plus qu'un repli.
- `question` / `questionClose` : le type de question va dans `typeQuestion`, ou dans `{type:"question", question:{…}}`.
- Page : nouvelle fonction `bt.envoyerTexte(texte, {source})`, appelée pour le prompt de lancement et pour les messages du registre.
- `bt.fin({code, raison})` : `raison: "terminal"` quand la session part dans Terminal.app. Pendant un `relancer`, pas de `bt.fin`, puis un nouveau `bt.info`.
- `bt.info` contient en plus `reprise`, `dansTerminal`, `barreTitre {hauteur, gauche}` : zone de déplacement de la fenêtre, rien de cliquable dedans.
- `bt.historique` exclut les lignes `api-request*`.
- Liens `betterterminal://` (`session`, `focus`, `envoyer`) protégés par le jeton `~/.config/better-terminal/jeton` : sans jeton valide, un `prompt` demande confirmation et `envoyer` est refusé.
- Registre central des sessions : `app/Sources/Registre.swift` (`RegistreSessions.shared`), point d'accroche du futur mode vocal.
- Le hook `~/.claude/hooks/green-summary.sh` ne s'applique pas si `BT_APP` ou `BT_TEST` est défini.
- Questions Telegram (agent E) : `~/Desktop/Projets/Jarvis-Ultron-Telegram/tg-question.sh envoyer <fichier>` / `clore <id> "<texte>"` (jusqu'à environ 20 s). Dans `questions/`, seul `<id>.reponse.json` concerne l'app ; `*.tg.json`, `.msg-*`, `.preciser`, `.verrou-*`, `.tmp.*` appartiennent au routeur. Appeler `clore` avant de supprimer les fichiers d'une question. Réponse à une permission : `["Autoriser"]` ou `["Refuser"]` ; choix : liste de libellés ; « Préciser » et questions ouvertes : texte. Champs facultatifs `emoji` et `header`. Identifiants : 1 à 32 caractères `A-Za-z0-9_-`.
- Le routeur Jarvis qui tourne vraiment est `~/.claude/bin/tg-router.sh` (lancé par launchd). La copie du projet Jarvis sert de source pour le déploiement.
- **Une seule fenêtre** (demande d'Eliot, 07/11/2026) : `app/Sources/FenetrePrincipale.swift`. À gauche, la barre des sessions (`ui/sessions.html`, `ui/js/sessions.js`, `ui/css/sessions.css`, 248 px, les feux macOS au-dessus) ; à droite, la session choisie. Les vues des autres sessions restent chargées, empilées derrière (pas cachées : WebKit les fait tourner normalement). `bt.info.barreTitre.gauche` vaut 16. Le bouton rouge cache la fenêtre, ⌘W ferme la session affichée, ⌘1…9, ⌃Tab / ⌃⇧Tab et ⌘⇧] / ⌘⇧[ changent de session.
  - Swift → barre : `barreSessions.maj([{id, numero, projet, emoji, cwd, etat, resume, dernierMessage, modele, dansTerminal, maj (ms), actif, nonLu}])`. `nonLu` : la session a fini un tour pendant qu'Eliot regardait ailleurs.
  - Barre → Swift (gestionnaire `barre`) : `{type:"pret"}`, `{type:"choisir", id}`, `{type:"fermer", id}`, `{type:"nouvelle"}`.
- **Beeper fermé à l'envoi** (08/11/2026) : `app/Sources/BeeperDiscret.swift` le lance par `open -g -j -b com.automattic.beeper.desktop`, attend que l'API réponde (sonde toutes les 0,5 s, 30 s au plus), puis renvoie le message. Electron ignore parfois `-g -j` : pendant le lancement et jusqu'à 6 s après, l'app recache Beeper et rend le premier plan à l'app d'avant, dès l'événement d'activation (et toutes les 0,2 s en filet). Mesuré à froid : API prête (6 comptes) en 0,5 s, Beeper jamais au premier plan, fenêtre visible environ 0,05 s. Échec : message d'erreur dans la page, jamais de repli par le bot.

## Mode vocal « Jarvis » (étape 7, lancé le 07/11/2026)

Choix par défaut (validés par le « go » d'Eliot, modifiables) :
- **Parler, mains libres** (08/11/2026, demande d'Eliot : « je le lance et à partir de là, je parle et il me répond ») : tant que le mode est actif, le micro intégré reste ouvert (`EcouteContinue` + `DecoupeurEnonces`, AVCaptureSession, indicateur orange de macOS allumé). Environ 0,2 s de voix ouvre un énoncé (avec 0,3 s d'audio d'avant et les bribes de voix des 0,6 s précédentes, pour ne pas couper « Cockpit, … ») ; 1 s de silence le clôt ; il part alors dans la même transcription et le même routage que ⌥Espace. Les frappes de clavier (pic très au-dessus de la moyenne, espacées) n'ouvrent pas d'énoncé.
- **Pas d'écho** : l'écoute est suspendue (audio jeté, micro ouvert) pendant que Jarvis parle et reprend 0,5 s après sa voix (0,35 s après un simple son), pendant une transcription, pendant ⌥Espace et pendant la dictée de la saisie (là, le micro continu est rendu pour que la dictée l'ait).
- **Ce que dit Jarvis en fin de tour** (09/11/2026) : tant que le mode est actif, chaque message envoyé porte une consigne cachée `<mode-vocal>…</mode-vocal>` (`BT.CONSIGNE_VOCALE`, retirée de l'historique). Claude termine alors par un bloc `<vocal>…</vocal>` écrit pour l'oreille, jamais affiché ; c'est lui qui est lu. Sans bloc, repli sur la ligne ✅.
- **Réponse vocale pendant qu'Eliot parle** : elle attend la fin de son énoncé (la file ne démarre rien tant qu'un énoncé est en cours).
- **Filtres** : transcription vide, ou faite uniquement de mots de remplissage (« euh », « merci », « bon », « voilà »… : liste `remplissage` dans `Vocal.swift`), ignorée sans bruit. En mains libres, un seul mot est ignoré aussi, sauf juste après une question ou dans les 45 s qui suivent une réponse vocale (« oui », « deux ») : c'est le cas d'Eliot qui parle à quelqu'un d'autre.
- **⌥Espace reste là** : maintenir pour parler tout de suite (coupe la voix en cours), relâcher pour envoyer. « Écoute mains libres » se coupe dans le menu Vocal (réglage `BTMainsLibres`, vrai par défaut) : on revient alors au seul ⌥Espace.
- **Réglages des seuils**, sans recompiler (`defaults write local.eliot.betterterminal <clé> <valeur>`, pris en compte à la prochaine activation du mode) : `BTEcouteSeuilDb` (-48, niveau sous lequel ce n'est jamais de la voix), `BTEcouteMargeDb` (9, marge au-dessus du bruit de fond), `BTEcouteVoixMin` (0,2 s), `BTEcouteSilenceFin` (1 s). Valeurs par défaut et autres paramètres : `ParametresEcoute` dans `DecoupeurEnonces.swift`. Délais de reprise et fenêtre de réplique : constantes en tête de `MoteurVocal`.
- **File d'attente commune** à toutes les sessions : d'abord les questions et permissions, ensuite les fins de tâche, dans l'ordre d'arrivée. Une seule session parle à la fois.
- **Ce qui est dit** : pour une fin de tâche, la ligne « ✅ … » de la réponse (le CLAUDE.md d'Eliot l'impose à chaque réponse), sans l'emoji ; à défaut, la première ou les deux premières phrases du texte final, environ 200 caractères maximum. Pour une question : « <projet> te demande : <question>. Un : <option>. Deux : … ».
- **Voix** : une seule, celle de Jarvis (edge-tts `fr-FR-RemyMultilingualNeural`, comme `~/.claude/bin/tg-say.sh`), qui annonce le projet : « Cockpit : … ». Texte nettoyé par `~/Desktop/Projets/Jarvis-Ultron-Telegram/tts-clean.py`.
- **Transcription** : whisper.cpp en local (`whisper-cli`, modèles dans `~/.claude/models/`, comme `~/.claude/bin/voice.sh`).
- **À qui va la réponse dictée** : si elle commence par un nom de projet (« Cockpit, … »), à cette session ; sinon à la session qui vient de parler ; sinon à la fenêtre au premier plan.
- Mode coupé : rien ne parle, rien n'écoute.

Pont page de session ↔ Swift (en plus de ce qui précède) :
- Page → Swift : `vocal` `{texte, priorite: "question"|"fin", questionId?}` (la coque ajoute le projet et met en file) ; `vocalAnnule` `{questionId}` (question répondue ailleurs : retirer de la file) ; `modeVocal` `{actif}`.
- Swift → page : `bt.vocalEtat({actif, etat: "inactif"|"pret"|"ecoute"|"transcription"|"parle", enLigne: bool, mainsLibres: bool, ecouteOuverte: bool, erreur?: string})` (`ecoute` couvre aussi un énoncé mains libres en cours ; `erreur` : micro refusé, échec de démarrage) (`enLigne` = c'est cette session qui parle ou à qui Eliot répond) ; `bt.transcription({texte, questionId?})` : texte dicté pour cette session. Avec `questionId`, la page le convertit en réponse à la question (« deux », « Poire », « le deuxième », « Pomme et Kiwi », « oui » / « non » pour une permission) ; si c'est ambigu, la question reste ouverte et la page renvoie un `vocal` « Je n'ai pas compris, réponds par un numéro. ». Sans `questionId`, la page l'envoie comme message (`source: "vocal"`) et le marque d'un micro dans le fil.

Seul retour visuel en usage normal : le bouton « Mode Jarvis » de la page et son petit témoin (pastille fixe, sans animation : prêt, entend, transcrit, parle, erreur en ambre).

Panneau `ui/jarvis.html` : **diagnostic seulement** (08/11/2026). Il ne s'ouvre jamais tout seul, ni à l'activation du mode, ni au lancement ; on l'ouvre par le menu Vocal → « Afficher le panneau Jarvis (diagnostic) ». Plus de raccourci global ⌃⌥J.
- Swift → panneau : `jarvis.maj({actif, etat, niveau, mainsLibres, ecouteOuverte, enLigne: {sessionId, projet, emoji, texte} | null, file: [{sessionId, projet, emoji, texte, priorite}]})`. `niveau` (0 à 1) est le volume du micro pendant l'écoute.
- Panneau → Swift : `window.webkit.messageHandlers.bt.postMessage({type: "passer"|"rejouer"|"couper"|"modeVocal", actif?})`.

Tests du mode vocal : au plus une phrase audible pendant tout le test, le reste en sortie muette ; la transcription se teste avec des fichiers audio préparés. L'autorisation micro de macOS demandera un clic à Eliot : ne la déclenche pas en boucle.
