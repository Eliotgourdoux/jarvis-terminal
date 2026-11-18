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
- **Parler, mains libres** (08/11/2026, demande d'Eliot : « je le lance et à partir de là, je parle et il me répond ») : tant que le mode est actif, le micro intégré reste ouvert (`EcouteContinue` + `DecoupeurEnonces`, AVCaptureSession, indicateur orange de macOS allumé). Environ 0,2 s de voix ouvre un énoncé (avec 0,3 s d'audio d'avant et les bribes de voix des 0,6 s précédentes, pour ne pas couper « Cockpit, … ») ; fin d'énoncé intelligente (09/11/2026, Eliot marque des blancs de 2 s pour réfléchir) : après 1,2 s de silence, le texte frais de whisper-server est jugé (`FinPhrase.inachevee`, `Routage.swift`) ; phrase qui a l'air finie : l'énoncé se clôt à 2 s de silence ; inachevée (mot de liaison en fin : et, mais, parce que, de, le, que, pour, euh…, virgule, pas de ponctuation finale, bribe très courte) : attente jusqu'à 4 s, la bulle fantôme affiche « … j'attends la suite » ; pas de texte à temps : 2,5 s. Les réponses brèves (« non », « d'accord », « le premier ») comptent comme finies. Si Eliot reprend pendant la transcription, c'est le même énoncé : les morceaux partent en un seul message. S'il reprend moins de 3 s après l'envoi, `bt.transcription` porte `suite: true` et la page fusionne (interruption du tour et renvoi du message complet) tant que Claude n'a rien écrit ; sinon c'est le message suivant. Puis même transcription et même routage que ⌥Espace. Les frappes de clavier (pic très au-dessus de la moyenne, espacées) n'ouvrent pas d'énoncé.
- **Couper la parole** (09/11/2026) : l'écoute reste ouverte pendant la voix de Jarvis et pendant la transcription. Quand Eliot parle vraiment, la voix s'arrête net, le reste de ce message est abandonné, son énoncé part normalement (en message suivant si Claude travaille encore). Anti-écho sur haut-parleurs (tout sauf casque Bluetooth ou prise casque) : seuil relevé au niveau joué (`Synthese.niveauSortie`) + couplage appris + 8 dB, et 0,35 s de voix nette exigées ; testé hors micro (écho simulé) : Jarvis ne se coupe jamais lui-même, mais Eliot doit parler nettement plus fort que l'écho (environ 10 dB au-dessus). Au casque : coupure réactive (0,2 s). Réglage `BTCouperParole` (vrai par défaut ; faux : écoute suspendue pendant la voix comme avant). L'écoute reste suspendue 0,5 s après la voix (0,35 s après un son), pendant ⌥Espace et pendant la dictée de la saisie (le micro continu est rendu).
- **Micro** (menu Vocal) : « Micro : Mac » (par défaut, micro intégré) ou « Micro : celui qui est branché » (micro par défaut de macOS, AirPods compris), bascule à chaud (`ChoixMicro`, `Micro.swift`), repli sur le Mac si le micro choisi ne rend que des zéros. Les AirPods en micro passent en mode appel (HFP, 24 kHz) : la voix de Jarvis y devient nettement moins bonne ; sur macOS 15 pas de micro AirPods sans HFP (macOS 26 annonce un enregistrement « studio » pour AirPods Pro 2 / AirPods 4, non vérifié pour les apps Mac).
- **Réponse vocale, écran graphique** (09/11/2026, demande d'Eliot : « en audio il me parle, l'affichage est une illustration ») : tant que le mode est actif, chaque message envoyé porte une consigne cachée `<mode-vocal>…</mode-vocal>` (`BT.CONSIGNE_VOCALE`, retirée de l'historique mais repérée pour marquer le tour). La réponse finale de Claude commence par un seul bloc `<vocal>…</vocal>` écrit pour l'oreille ; dès que `</vocal>` est fermé dans le flux, la page envoie le `vocal` (priorité `fin`) sans attendre la fin du tour, une seule fois par tour. Sans bloc, repli au `result` sur la ligne ✅. Affichage d'un tour vocal (message porteur de la consigne, ou réponse contenant `<vocal>`, en direct comme dans l'historique) : seulement les visuels (blocs de code dont aperçus html, mermaid, svg et commandes à copier, tableaux, liens, médias locaux cités) ; la prose et la ligne ✅ sont masquées, remplacées par une ligne repliée « Jarvis a dit » (la phrase dite, puis « Texte complet » pour toute la réponse écrite du tour). Pendant l'écriture, un élément n'apparaît qu'une fois reconnu comme visuel. Tour vocal fini sans aucun bloc `<vocal>` : affiché en texte normal.
- **Réponse vocale pendant qu'Eliot parle** : elle attend la fin de son énoncé (la file ne démarre rien tant qu'un énoncé est en cours).
- **Filtres** : transcription vide, ou faite uniquement de mots de remplissage (« euh », « merci », « bon », « voilà »… : liste `remplissage` dans `Vocal.swift`), ignorée sans bruit. En mains libres, un seul mot est ignoré aussi, sauf juste après une question ou dans les 45 s qui suivent une réponse vocale (« oui », « deux ») : c'est le cas d'Eliot qui parle à quelqu'un d'autre.
- **⌥Espace reste là** : maintenir pour parler tout de suite (coupe la voix en cours), relâcher pour envoyer. « Écoute mains libres » se coupe dans le menu Vocal (réglage `BTMainsLibres`, vrai par défaut) : on revient alors au seul ⌥Espace.
- **Réglages des seuils**, sans recompiler (`defaults write local.eliot.betterterminal <clé> <valeur>`, pris en compte à la prochaine activation du mode) : `BTEcouteSeuilDb` (-48, niveau sous lequel ce n'est jamais de la voix), `BTEcouteMargeDb` (9, marge au-dessus du bruit de fond), `BTEcouteVoixMin` (0,2 s), `BTEcoutePause` (1,2 s, silence qui déclenche le jugement), `BTEcouteSilenceComplet` (2 s, phrase finie), `BTEcouteSilenceInacheve` (4 s, phrase inachevée), `BTEcouteSilenceFin` (2,5 s, sans jugement ; ramené entre les deux précédents), `BTEcouteMargeEcho` (8 dB), `BTEcouteVoixCoupure` (0,35 s de voix pour couper Jarvis sur haut-parleurs), `BTCouperParole` (vrai). Valeurs par défaut et autres paramètres : `ParametresEcoute` dans `DecoupeurEnonces.swift`. Délais de reprise et fenêtre de réplique : constantes en tête de `MoteurVocal`.
- **File d'attente commune** à toutes les sessions : d'abord les questions et permissions, ensuite les fins de tâche, dans l'ordre d'arrivée. Une seule session parle à la fois.
- **Ce qui est dit** : pour une fin de tâche, la ligne « ✅ … » de la réponse (le CLAUDE.md d'Eliot l'impose à chaque réponse), sans l'emoji ; à défaut, la première ou les deux premières phrases du texte final, environ 200 caractères maximum. Pour une question : « <projet> te demande : <question>. Un : <option>. Deux : … ».
- **Voix** : une seule, celle de Jarvis (edge-tts `fr-FR-RemyMultilingualNeural`, comme `~/.claude/bin/tg-say.sh`, débit `BTDebitVoix`, -8 % par défaut). Texte nettoyé par `~/Desktop/Projets/Jarvis-Ultron-Telegram/tts-clean.py`.
  - **Jamais deux voix dans un message** (09/11/2026, voix robotique entendue : edge-tts tué par notre délai de 12 s, puis `say` pour la suite). Le service Microsoft répond en 1,5 à 10 s pour le même texte, sans lien avec la longueur : `Synthese` lance donc des essais décalés en parallèle (premier morceau : 0 s et 3,5 s, 10 s chacun ; morceaux suivants : 0, 5 et 13 s, jusqu'à 25 s), le premier mp3 valide gagne. Les morceaux suivants se préparent à 3 en parallèle. `say` ne sert que si edge-tts échoue dès le premier morceau (hors ligne), pour tout le message, avec la meilleure voix française installée (Premium, puis Enhanced, sinon Thomas ; réglage `BTVoixSay`) ; edge-tts est réessayé 60 s plus tard. Un morceau suivant qui échoue est sauté, jamais lu par `say`. Pour une meilleure voix de secours : System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.
  - **Nom du projet** (09/11/2026) : aucun préfixe quand la session qui parle est celle à qui Eliot vient de parler (moins de 5 min) ou la fenêtre devant (« Je te demande : … »). Sinon un nom court : « Cockpit », « le terminal » (projet qui contient « terminal »), « ton autre discussion » pour une discussion ; jamais « Discussion » ni « Better Terminal For Claude » en entier (`MoteurVocal.nomCourt`, `prefixer`).
- **Transcription** : whisper.cpp en local (`whisper-cli`, modèles dans `~/.claude/models/`, comme `~/.claude/bin/voice.sh`).
- **À qui va la réponse dictée** : si elle commence par un nom de projet (« Cockpit, … »), à cette session ; sinon à la session qui vient de parler ; sinon à la fenêtre au premier plan. Plusieurs sessions du même projet (les discussions partagent toutes `~/Claude-Discussions`, nom « Discussion ») : la fenêtre au premier plan l'emporte si elle a été activée après la dernière réplique. « Claude » en tête n'est qu'une apostrophe, pas un nom de projet.
- Mode coupé : rien ne parle, rien n'écoute.

Pont page de session ↔ Swift (en plus de ce qui précède) :
- Page → Swift : `vocal` `{texte, priorite: "question"|"fin", questionId?, cle?, attendre?}` (la coque ajoute le projet si besoin et met en file ; `cle`/`attendre` : voir « Animations au rythme de la voix ») ; `vocalPret` `{cle}` (l'aperçu ou la scène de ce tour est rendu, la voix retenue peut partir) ; `vocalAnnule` `{questionId}` (question répondue ailleurs : retirer de la file) ; `modeVocal` `{actif}`.
- Swift → page : `bt.vocalEtat({actif, etat: "inactif"|"pret"|"ecoute"|"transcription"|"parle", enLigne: bool, mainsLibres: bool, ecouteOuverte: bool, erreur?: string})` (`ecoute` couvre aussi un énoncé mains libres en cours ; `erreur` : micro refusé, échec de démarrage) (`enLigne` = c'est cette session qui parle ou à qui Eliot répond) ; `bt.transcription({texte, questionId?, suite?})` : texte dicté pour cette session (`suite` : repris moins de 3 s après l'envoi précédent, voir « Parler, mains libres »). Avec `questionId`, la page le convertit en réponse à la question (« deux », « Poire », « le deuxième », « Pomme et Kiwi », « oui » / « non » pour une permission) ; si c'est ambigu, la question reste ouverte et la page renvoie un `vocal` « Je n'ai pas compris, réponds par un numéro. ». Sans `questionId`, la page l'envoie comme message (`source: "vocal"`) et le marque d'un micro dans le fil.
- Swift → page, mots en direct (09/11/2026) : `bt.vocalDirect({id, etat: "debut"|"partiel"|"attente"|"reprise"|"transcription"|"fini"|"annule", texte?, source?: "mainsLibres"|"raccourci", suite?, raison?, questionId?})` (`attente` : phrase jugée inachevée, « … j'attends la suite » ; `reprise` : Eliot reparle, même `id`, aussi après `transcription`, les partiels suivants portent tout le texte ; `debut` avec `suite` : voir `bt.transcription`), envoyé à la session cible présumée (sinon la fenêtre devant). Les partiels viennent de `DicteeDirecte` (whisper-server, modèle small, gardé chargé tant que le mode mains libres est actif) ; la page affiche une bulle « Eliot » fantôme en bas du fil (`ui/js/vocal-direct.js`), mot par mot. `fini` part juste avant `bt.transcription` de la même session : la bulle fantôme devient la vraie bulle, sans doublon ; `annule` (remplissage, bruit, autre session, mode coupé) l'efface en fondu.

- Swift → page, étapes (09/11/2026) : `bt.vocalEtape({n, cle?})` quand la voix atteint le repère `[[n]]` (0 au début du message ; à la fin, coupée ou passée, l'étape finale est renvoyée pour que l'animation finisse sur son dernier état).

### Animations au rythme de la voix et scène persistante (09/11/2026)

- **Repères** : dans le bloc `<vocal>`, Claude place `[[1]]`, `[[2]]`… (jamais dits ni affichés : `Synthese.segments`, `BT.sansReperes`). Chaque segment est découpé à part ; le premier morceau de chaque segment porte son étape, déclenchée quand il commence à jouer.
- **Attente** : avec des repères, la page envoie `vocal` avec `cle` (tour : `'t' + id` du dernier message d'Eliot) et `attendre: true`. La coque prépare l'audio mais ne lance pas ce message (les suivants passent) tant que `vocalPret {cle}` n'est pas arrivé, 20 s au plus. Sans repères, la voix part tout de suite comme avant. Tour fini sans aucun bloc visuel, ou interrompu : `vocalPret` part aussitôt.
- **Aperçu** (`apercu.html` / `cadre.js`, API injectée dans le document écrit) : `jarvis.etape(n => …)` est appelée à l'étape 0 au chargement puis à chaque repère (même n ignoré) ; `jarvis.recevoir(d => …)` reçoit les données JSON des blocs jarvis. Messages page → cadre : `bt-apercu {html, plein, etape, commandes: [{code, etape?}]}`, `bt-etape {n}`, `bt-jarvis {code, etape?}` ; cadre → page : `bt-apercu-rendu` (après le rendu et le rejeu). Les cadres d'un tour vocal portent sa clé et sont montés tout de suite ; le premier rendu libère la voix. Étape de départ : la dernière reçue ; sinon 0 si la voix du tour n'a pas encore parlé ; sinon (historique) le dernier repère du tour.
- **Scène** (`ui/js/scene.js`, `ui/css/scene.css`) : `` ```html apercu scene=nom `` (ou `scene=nom` seul). En mode vocal (ou si le dernier tour est vocal), la scène la plus récente est figée sous la barre (`--hauteur-scene` décale le fil), repliable, fermable (elle revient au prochain bloc de scène). Même nom renvoyé : remplacement sur place en fondu, hauteur stable. `` ```jarvis scene=nom `` (nom facultatif : scène courante) : JSON → `jarvis.recevoir`, sinon JS exécuté dans le cadre. Un bloc JS qui appelle `jarvis.etape` remplace les étapes précédentes et c'est la voix de son tour qui les pilote ; sinon les étapes restent à la voix du tour qui a défini la scène. Tout est déduit des textes de la session (blocs fermés) : l'historique rechargé reconstruit la scène (dernière définition, puis ses commandes rejouées, chacune avec l'étape finale de son tour). Dans le fil d'un tour vocal, le bloc de scène devient « Scène « nom » affichée en haut » (« Voir cette version ») et le bloc jarvis n'est pas affiché ; hors mode vocal, l'aperçu nommé s'affiche normalement et le bloc jarvis est replié.
- **Faux pont** : `attendreVoix=1` attend la fin de la voix avant le message suivant ; étapes simulées à ~60 ms par caractère (`BT.fauxPont.etapes`, `passer()`, `rejouer()`). Fixture : `fixtures/vocal-scene` (3 tours : repères + scène, commande jarvis, redéfinition).

Seul retour visuel en usage normal : le bouton « Mode Jarvis » de la page et son petit témoin (pastille fixe, sans animation : prêt, entend, transcrit, parle, erreur en ambre).

Panneau `ui/jarvis.html` : **diagnostic seulement** (08/11/2026). Il ne s'ouvre jamais tout seul, ni à l'activation du mode, ni au lancement ; on l'ouvre par le menu Vocal → « Afficher le panneau Jarvis (diagnostic) ». Plus de raccourci global ⌃⌥J.
- Swift → panneau : `jarvis.maj({actif, etat, niveau, mainsLibres, ecouteOuverte, enLigne: {sessionId, projet, emoji, texte} | null, file: [{sessionId, projet, emoji, texte, priorite}]})`. `niveau` (0 à 1) est le volume du micro pendant l'écoute.
- Panneau → Swift : `window.webkit.messageHandlers.bt.postMessage({type: "passer"|"rejouer"|"couper"|"modeVocal", actif?})`.

Tests du mode vocal : au plus une phrase audible pendant tout le test, le reste en sortie muette ; la transcription se teste avec des fichiers audio préparés. L'autorisation micro de macOS demandera un clic à Eliot : ne la déclenche pas en boucle.

## File « limite » (18/11/2026)

Quand Claude refuse un tour parce que la limite d'usage de l'abonnement est atteinte, la coque (`app/Sources/LimiteUsage.swift`) retient ce qui doit partir à la reprise :

- la session refusée est « coupée » : à son heure de reprise (`resetsAt` + 20 s), la coque lui écrit « Reprends » ;
- les messages d'Eliot écrits en attendant (`versClaude` de type `user`, ou envoi direct de la coque) ne vont pas sur stdin : ils sont gardés, puis écrits dans l'ordre à la reprise, après le « Reprends » ;
- limite de tout l'abonnement (`five_hour`, `seven_day`, type absent) : toutes les sessions retiennent jusqu'à sa fin ; limite d'un seul modèle (`seven_day_opus`…) : seules les sessions refusées retiennent, chacune jusqu'à sa propre heure, et changer de modèle lève la coupure ;
- un message refusé reste dans la conversation de Claude : il n'est jamais réécrit, « Reprends » demande d'y répondre.

Ce que Session lit dans les lignes de Claude (`suivreLimite`) :

- refus confirmé : ligne `assistant` du fil principal avec `api_error: "usage_limit_reached"` (relevé dans `api_error_params.rate_limit_info`, champs lus dans le binaire 2.1.325), ou `rate_limit_event` « rejected » (sans `isUsingOverage`) suivi d'un message fabriqué (`model: "<synthetic>"`) ou d'un `result` en erreur ;
- une vraie réponse du fil principal annule la coupure de sa session (le refus venait d'un sous-agent) ; si sa requête est partie après le dernier refus, la limite de l'abonnement est levée avant l'heure et tout part ;
- refusée juste après une reprise : nouvel essai dans 5, 15 puis 60 min, puis plus de « Reprends » automatique.

Autres règles : rien ne part dans les 12 s qui suivent le lancement de l'app, ni dans une session dont la page n'a pas encore reçu son historique ; une session fermée par Eliot perd sa reprise automatique, mais ses messages préparés la rouvrent à la reprise ; si claude est arrêté dans la session (Terminal, session terminée), les messages ne partent pas et la page le dit. L'état est dans `~/.config/better-terminal/limite.json` (survit à une relance). Tant que quelque chose attend, l'app n'est pas mise en sommeil et, sur secteur, le Mac ne s'endort pas tout seul ; la reprise est vérifiée toutes les 15 s et au réveil du Mac.

Pont :

- coque → page : `bt.limite({ reprise: ms | null, retient, coupee, auto, attente: [{ uuid, texte }], perdus?: [uuid], total })`, à chaque changement et après l'historique. La coque décide seule : la page retient un message dès que `retient` est vrai. Une bulle dont l'`uuid` est dans `attente` est marquée « partira à la reprise » ; quand elle en sort, elle vient de partir (ou, si elle est dans `perdus`, elle n'a pas pu partir).
- page → coque : `limite { action: "envoyer" }` (ce qui attend dans cette session part tout de suite), `limite { action: "vider" }` (retire les messages et la reprise automatique de cette session).
- le « Reprends » est montré par `bt.utilisateurAilleurs({ ligne, source: "limite" })` (dédoublonné par `uuid`).
- barre des sessions : champ `limite: { reprise, messages } | null` par session (« Reprend à 11:00 · 2 messages »).

« Hey » de 6 h : `app/hey-6h.sh` (copie exécutée : `~/.config/better-terminal/hey-6h.sh`), lancé par launchd (`~/Library/LaunchAgents/local.eliot.betterterminal.hey.plist`) à 6 h ou au réveil du Mac, une fois par jour. Il envoie « Hey » à Haiku, sans hooks ni transcript, pour que la fenêtre de 5 h commence à 6 h. Journal : `~/Library/Logs/Better Terminal/hey.log`.
