# Coque Swift de Better Terminal (agent D)

La coque est un simple tuyau. Elle ouvre une fenêtre en verre avec une vue web transparente et lance un processus `claude` en stream-json par fenêtre. Elle relaie les lignes entre ce processus et la page (`ui/`), et n'exécute que les actions prédéfinies de `CONTRAT.md`.

## Compiler et lancer

```sh
app/build.sh               # swiftc → app/build/Jarvis Terminal.app, signature ad hoc, schéma betterterminal:// enregistré
app/build.sh --installer   # idem, puis copie dans ~/Applications (c'est alors cette copie qui reçoit les liens)
```

`build.sh` ne tue jamais l'app en cours, pour que ses sessions survivent. Relancez l'app pour prendre le nouveau binaire.

Il y a trois façons d'ouvrir une session :

- **Lien** : `open "betterterminal://session?cwd=<chemin>&resume=<id>&prompt=<texte>&modele=<m>&effort=<e>&jeton=<jeton>"`. Seul `cwd` est obligatoire.
- **Ligne de commande** : `"app/build/Jarvis Terminal.app/Contents/MacOS/BetterTerminal" --cwd <dossier> [--resume <id>] [--prompt <texte>] [--modele <m>] [--effort <e>]`. Si l'app tourne déjà, la demande lui est transmise par lien (avec le jeton), puis la commande s'arrête.
- **⌘N** : choix d'un dossier. C'est aussi ce qui s'affiche quand l'app est lancée sans rien.

Deux autres liens existent :

- `betterterminal://focus?session=<id>` met la fenêtre devant. La notification « attend » s'en sert.
- `betterterminal://envoyer?session=<id>&texte=<t>&jeton=<j>` envoie un message à une session ouverte, via le registre.

**Jeton** : `~/.config/better-terminal/jeton` (fichier 0600, créé au premier lancement). Un lien `betterterminal://` peut venir de n'importe quelle page web, et les sessions tournent sans demande de permission. Les appelants locaux (Cockpit, la ligne de commande) ajoutent donc `jeton=`. Sans jeton valide, un `prompt` affiche une confirmation qui montre le dossier et le message, et `envoyer` est refusé.

Les menus de l'app :

- ⌘R recharge la page. La conversation est alors reconstruite depuis le transcript, sans relancer claude.
- ⌘W ferme la session.
- ⌘Q ferme tout.
- Le menu Édition fait marcher ⌘C, ⌘V et ⌘A dans la vue web.
- Aucun élément « Rechercher » n'est déclaré, pour que ⌘F reste à la page.

## Quelle page est chargée

L'app prend la première page trouvée dans cet ordre :

1. `BT_UI_DIR/index.html`
2. `<projet>/ui/index.html`, lu en direct. Le chemin du projet est écrit dans l'Info.plist (`BTDossierProjet`).
3. `ui/` copié dans le bundle
4. La page de test `app/page-test/page-test.html`, utilisée tant que `ui/` n'existe pas

Pour forcer la page de test : `BT_PAGE=test`, ou `open -a … --args -BTPage test`.

La vue web n'a accès en lecture qu'au dossier de la page. Elle ne navigue jamais ailleurs. Un lien http(s) cliqué s'ouvre dans le navigateur, et toute autre navigation est bloquée et journalisée. Le clic droit propose « Inspecter l'élément » (`isInspectable`).

## Processus claude

- **Binaire** : `~/.local/bin/claude`. Repli : `zsh -lc 'whence -p claude'`.
- **Environnement** : celui d'un `zsh -lic` (le PATH d'Eliot est dans `~/.zshrc`), chargé une seule fois. Les variables `CLAUDE*` (sauf `CLAUDE_CONFIG_DIR`), `AI_AGENT`, `TG_BOT_NAME`, `BT_TEST`, `PWD` et `SHLVL` sont retirées. La coque pose ensuite `BT_APP=1` et `PWD=<cwd>`.
- **Lancement** : `posix_spawn` dans un groupe de processus à part. Seuls 0, 1 et 2 sont hérités, et les signaux sont remis par défaut (l'app, elle, ignore SIGPIPE).
- **Arguments** : un seul endroit, `Sources/ClaudeArgs.swift`. Source : `moteur/PROTOCOLE.md` §1.

```
--output-format stream-json --input-format stream-json --verbose --include-partial-messages
--permission-prompt-tool=stdio --dangerously-skip-permissions --thinking-display summarized
[--model <m>] [--effort <e>] --session-id <uuid neuf> | --resume <id>
```

  Pas de `-p`.
- **Flux** :
  - stdout est lu ligne par ligne, puis passé à `bt.depuisClaude(ligne)`. Les appels sont groupés par lots d'environ 8 ms, avec `callAsyncJavaScript` et des arguments : aucune chaîne JavaScript n'est fabriquée, et l'ordre est garanti.
  - stderr va vers `bt.stderr` et vers le journal.
  - La fin du processus donne `bt.fin({code})`.
- **Arrêt** (fermeture, ⌘Q, relance, terminal) :
  1. `interrupt` (PROTOCOLE §5), puis fermeture de stdin. Claude sort alors seul, en code 0, en moins d'une seconde.
  2. SIGTERM au groupe après 2 s, si nécessaire.
  3. SIGKILL après 5 s.

## Pont

`recevoir` (`Sources/Session.swift`) valide strictement chaque message : type, champs et tailles. Les messages ne sont acceptés que s'ils viennent du cadre principal et de notre page. Voici ce qui diffère du contrat ou s'y ajoute :

- **`versClaude` avant le lancement** : tant que claude n'est pas encore lancé (environnement en cours de chargement, transcript en cours de lecture) ou pendant un `relancer`, la ligne est gardée, puis écrite dès que le processus est lancé, dans l'ordre. Elle n'est refusée que si le processus est arrêté pour de bon (fermeture, terminal, fin).
- **`question`** : le champ `type` nomme déjà le message. Le type de question arrive donc dans `typeQuestion`, ou sous la forme imbriquée `{type: "question", question: {id, type, texte, options}}`. Le fichier écrit contient aussi `emoji` (accepté par `tg-question.sh`).
- **`questionClose`** : la coque crée `<id>.reponse.json` (`source: "mac"`) de façon exclusive. La première réponse l'emporte, et `tg-boutons.sh` fait de même de son côté. Elle lance ensuite `tg-question.sh clore <id> <texte>`, sauf si Telegram a répondu en premier.
- **`bt.envoyerTexte(texte, {source})`** : fonction facultative de la page, appelée pour le `prompt` de lancement et pour le registre. La page construit et affiche le message. Si elle n'existe pas, la coque écrit elle-même le message stream-json standard.
- **`bt.info`** : la coque ajoute `reprise`, `dansTerminal`, `barreTitre: {hauteur: 28, gauche: 78}`, `app` et `version`. Les 28 px du haut de la fenêtre servent à la déplacer (une bande native capte les clics) : n'y mettez rien de cliquable.
- **`relancer`** : pas de `bt.fin` pour l'arrêt voulu, puis un nouveau `bt.info`. Sans transcript, la relance utilise `--session-id` au lieu de `--resume`.
- **`ouvrirTerminal`** : arrête d'abord le processus de l'app, puis exécute `osascript` avec la commande en argv. Il n'y a donc aucun échappement AppleScript à faire. L'échappement shell est fait par `shq`. La page reçoit ensuite `bt.info({…, dansTerminal: true})` et `bt.fin({code, raison: "terminal"})`, et le titre de la fenêtre prend « — dans le Terminal ».
- **`etat`** : écrit `~/.config/better-terminal/sessions/<id>.json` de façon atomique, et supprime ce fichier à la fermeture. Au lancement, la coque retire les fichiers dont le pid est mort. Sur `attend`, elle envoie une notification `terminal-notifier`, une seule fois par attente, et pas si la fenêtre est déjà au premier plan.
- **`bt.historique`** : les lignes du transcript, sauf les lignes techniques `api-request*` (environ un tiers du poids, inutiles à l'affichage). Si le chemin direct n'existe pas, la coque cherche dans tous les dossiers de `~/.claude/projects`.

## Registre central

Il se trouve dans `Sources/Registre.swift` (`RegistreSessions.shared`). C'est le seul objet qui connaît toutes les sessions ouvertes. Pour chacune, il garde :

- l'id, le dossier et le projet ;
- l'état et le résumé donnés par la page ;
- le dernier message de Claude, nettoyé de l'ANSI ;
- le pid et le modèle.

Ses fonctions : `apercus()`, `session(id)`, `envoyer(texte, a: id, source:)` et `toutArreter`. Il publie deux notifications :

- `bt.registre.changement` à chaque changement ;
- `bt.registre.tourTermine` (avec `texte`) à chaque fin de tour.

C'est le point d'accroche prévu pour Cockpit, Jarvis et le futur mode vocal. Rien de vocal n'est implémenté.

## Fichiers

| Fichier | Rôle |
|---|---|
| `Sources/main.swift` | délégué de l'app, menus, instance unique, quitter |
| `Sources/Entrees.swift` | liens, ligne de commande, ⌘N, jeton, confirmations |
| `Sources/Registre.swift` | registre central des sessions |
| `Sources/Session.swift` | une session : pont, démarrage, reprise, relance, terminal, état, questions |
| `Sources/FenetreSession.swift` | fenêtre, verre, vue web, navigation, appels vers la page |
| `Sources/ProcessusClaude.swift` | posix_spawn, tubes, lecture par ligne, arrêt progressif |
| `Sources/ClaudeArgs.swift` | arguments, commande Terminal, messages écrits par la coque, validation |
| `Sources/Questions.swift` | boîte aux lettres Telegram et surveillance des réponses |
| `Sources/Terminal.swift` | AppleScript Terminal (commande en argv) |
| `Sources/Outils.swift` | journal, shq, écriture atomique, environnement, registre des projets, transcripts, jeton |
| `Sources/PiloteDev.swift` | pilote de test, inactif sans `BT_DEV_PILOTE` (voir « Intégration ») |
| `page-test/` | page de test du pont (même CSP stricte que la vraie page) |

Le journal de la coque est dans `~/Library/Logs/Better Terminal/app.log`. Il garde les commandes lancées, les pid, les codes de sortie, les refus et les actions, mais jamais le contenu des conversations.

## Vérifié le 07/11/2026 (haiku, dans `app/bac-a-sable/`)

- **Aller-retour réel** : la page reçoit le prompt de lancement, l'écrit sur stdin, et Claude répond « tuyau ok, 42 ». La page a reçu 122 lignes et a renvoyé son `etat`, que l'on retrouve dans le fichier de session.
- **Second tour** : Eliot a tapé un message dans la fenêtre, et Claude y a répondu.
- **Instance unique** : un second lancement par la ligne de commande a ouvert une nouvelle fenêtre dans l'app déjà lancée (« instance ok »).
- **Registre** : `betterterminal://envoyer` avec jeton a obtenu « registre ok ». Avec un faux jeton, le message a été refusé.
- **Reprise par lien** (`resume=`) : `bt.historique` a envoyé 40 lignes, la session a été relancée avec `--resume`, et la continuité est prouvée (« Tu m'as demandé le résultat de 6 fois 7 »).
- **⌘Q avec deux sessions** : les deux processus sont sortis en code 0 en 0,6 s, sans SIGTERM. Il ne reste aucun claude et aucun fichier d'état.
- **Échappement** : un dossier piégé (`a b'c $(touch PWNED) "d" \e; rm`) donne bien un `cd` dans ce dossier, sans aucune injection, et osascript reçoit la commande à l'identique.
- **CSP** : `script-src 'self'` laisse bien passer les scripts locaux en `file://` dans WKWebView.
- **Captures** : `captures/session-haiku.png`, `captures/instance-unique-et-registre.png`, `captures/reprise-historique.png` et `captures/essai-final.png`.

Le tout premier chargement de page a pris 6,4 s : c'est le premier lancement de WebKit pour ce bundle. Les chargements suivants prennent de 0,15 à 0,36 s.

## Intégration avec la vraie interface (agent F, 07/11/2026)

La page `ui/` a été testée dans cette coque, sur de vraies sessions haiku dans `bac-a-sable/`. Les captures sont dans `captures/integration-*.png`.

Corrections apportées à la coque :

- **Message tapé avant le lancement de claude** (`Session.swift`) : il était refusé, alors que la page l'affichait comme envoyé et restait bloquée sur « Claude travaille ». Il est désormais gardé puis écrit au lancement (voir « Pont »). Avant la correction : `captures/integration-s2-avant-correction-message-perdu.png`.
- **`header` des questions** (`Session.swift`) : la page l'envoie (« Fruit », « Couleurs »), mais il n'arrivait pas dans `<id>.json`. Il y est maintenant transmis, comme le prévoit le contrat.
- **`build.sh`** : `codesign` échouait parfois (« detritus »), car le File Provider d'iCloud remet ses attributs entre `xattr` et `codesign`. Le script fait jusqu'à 3 essais.

### Pilote de test (`Sources/PiloteDev.swift`)

Le pilote sert aux tests d'intégration. Il est **inactif** tant que l'app n'est pas lancée avec `BT_DEV_PILOTE=<dossier>` dans son environnement. Le dossier doit appartenir à l'utilisateur et être en 0700. Le Finder, le Dock et les liens ne posent jamais cette variable.

```sh
mkdir -p /chemin/pilote && chmod 700 /chemin/pilote
cd app/bac-a-sable && TG_DRY=1 TG_API_BASE=http://127.0.0.1:9 BT_DEV_PILOTE=/chemin/pilote \
  "app/build/Jarvis Terminal.app/Contents/MacOS/BetterTerminal" --cwd "$PWD" --modele haiku
```

- Une commande `<nom>.cmd.json` déposée dans le dossier est exécutée, puis son résultat est écrit dans `<nom>.res.json`. Les actions disponibles :
  - `fenetres` ;
  - `js` `{fenetre, code}` : un corps de fonction exécuté dans la page ;
  - `touche` `{fenetre, touche, mods}` : un NSEvent fabriqué et remis à l'app elle-même par `NSApp.sendEvent`. Rien ne passe par le système, rien ne peut atterrir dans une autre application ;
  - `recharger` : comme ⌘R ;
  - `quitter` : un ⌘Q fabriqué.
- `injecte.js`, s'il existe dans le dossier quand une fenêtre est créée, est ajouté à la page en fin de document. Il sert à taper un message avant même le lancement de claude.
- En mode pilote, les choses changent ainsi :
  - aucune notification Mac n'est envoyée (elles sont seulement journalisées) ;
  - les fenêtres s'ouvrent derrière les autres, sans activer l'app ni voler le focus ;
  - la détection d'occultation de WebKit est coupée, sans quoi la page se croirait cachée, et le rendu, les animations et le défilement doux seraient suspendus.
- `TG_DRY=1` et `TG_API_BASE` passent à `tg-question.sh` par le même environnement que claude (`Environnement.charger`) : on le vérifie avec `ps eww <pid de claude>`.
- Piège évité : ne jamais appeler `NSApp.terminate` depuis un bloc de la file principale. Pendant `terminateLater`, la boucle imbriquée ne peut plus vider cette file, et l'app reste bloquée. Le vrai ⌘Q n'a pas ce problème.

Le fichier `bac-a-sable/CLAUDE.md` interdit aux sessions de test d'appeler `prevenir.sh`, `todo`, Beeper ou Telegram. Une session lancée par l'app est attribuée à Better Terminal par macOS, et un `todo list` y déclencherait une demande d'autorisation Rappels.

### Vérifié dans la vraie fenêtre

- Le markdown du prompt de lancement s'affiche : titres, code avec « Copier », tableau, gras, code en ligne. Sur 24 lignes brutes de stdout, aucune ne contient de code ANSI ni de bandeau : le hook `green-summary` se tait avec `BT_APP`.
- Les messages partent depuis la page, y compris par une vraie touche Entrée.
- Un message tapé avant le lancement est gardé puis envoyé (« 2 ligne(s) gardée(s) avant le lancement »).
- AskUserQuestion fonctionne avec un choix unique et un choix multiple. Claude reçoit « FRUIT=Kiwi ; COULEURS=Rouge, Vert », les fichiers `<id>.json` et `<id>.reponse.json` sont écrits, et `tg-question.sh envoyer` et `clore` tournent en mode sec (`message_id` 1000).
- Une réponse arrivée de Telegram, simulée par un fichier `reponse.json`, va jusqu'à Claude (« ANIMAL=Lapin »).
- Le modèle et l'effort se changent par les menus : le tour suivant est servi par `claude-sonnet-5-5`, avec `CLAUDE_EFFORT=low`.
- Le bouton Arrêter donne `aborted_streaming`, puis la session répond normalement.
- ⌘F (vraie touche), la navigation par Entrée et Échap fonctionnent.
- Après ⌘R, la question en attente est retrouvée et la réponse aboutit.
- Le défilement, la pastille « Nouveaux messages » et « Revenir en bas » fonctionnent.
- La reprise fonctionne : fermeture par le bouton Fermer, puis réouverture avec `resume` par lien transmis à l'instance lancée. L'historique s'affiche et Claude se souvient.
- Avec deux sessions ouvertes, ⌘Q arrête les deux processus en code 0, en moins d'une seconde, sans SIGTERM. Il ne reste aucun claude et aucun fichier d'état.
- Les fichiers d'état orphelins sont retirés au lancement suivant.

## Non vérifié

Les points suivants n'ont pas été vérifiés :

- `ouvrirTerminal`, faute d'avoir accepté l'autorisation Automatisation → Terminal. À la lecture du code, le processus de l'app est bien arrêté avant (interruption, fin de stdin, puis SIGTERM au bout de 2 s et SIGKILL au bout de 5 s), et Terminal ne s'ouvre qu'une fois le processus mort.
- La notification « attend », coupée en mode pilote.
- Les vrais boutons Telegram : Jarvis n'a pas encore été redémarré avec `tg-boutons.sh`.
- ⌘R par le menu : ce raccourci vise `NSApp.keyWindow`, qui reste vide tant que l'app n'est pas au premier plan. Il a été testé par le pilote avec la même fonction (`recharger`).
- ⌘N.
- `relancer`, puisque le changement à chaud a suffi.
- `copier` et `ouvrirLien`.
- Le déplacement par la bande du haut.
- La reprise après la mort du processus WebKit.

Les captures `screencapture -l` montrent la fenêtre seule, sans le bureau derrière : le verre y apparaît gris uni.
