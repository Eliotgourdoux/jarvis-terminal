# Contrat Victus — « Ultron Terminal » (12/11/2026)

Demande d'Eliot : Jarvis Terminal sur son PC Linux, le Victus.
1. Quand elle tourne sur le Victus, c'est **Ultron** à la place de Jarvis, signalé par un petit encadré.
2. Eliot s'en sert **sur place, en direct** : il tape ses messages dans l'app sur le Victus.
3. **Tout se pilote aussi depuis le Mac** : l'app Mac voit les sessions du Victus, les ouvre, y écrit et en lance de nouvelles, en direct et en même temps que l'écran du Victus.

Référence commune du projet : `CONTRAT.md` (le pont page ↔ coque) et `CLAUDE.md`. Règle d'or : **chaque agent n'écrit que dans ses fichiers** (tableau plus bas). Il peut tout lire. S'il a besoin d'un changement chez un autre, il le note dans son rapport.

## Le Victus

- Accès : `ssh victus` (Tailscale, clé déjà en place, sans mot de passe). Utilisateur `eliotgrx`, home `/home/eliotgrx`. **Pas de sudo** : tout s'installe dans le compte utilisateur.
- Ubuntu 24.10, GNOME sous Wayland (`DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0` ; environnement graphique : `systemctl --user show-environment`). 16 cœurs, 14 Go.
- Python 3.12.7, PyGObject avec **GTK 4 + WebKitGTK 6.0** (`gi.require_version("Gtk","4.0"); gi.require_version("WebKit","6.0")`), déjà installés. Aussi ffmpeg, rsync. Pas de whisper ni d'edge-tts : **pas de mode vocal sur le Victus** pour cette version.
- `claude` : `/home/eliotgrx/.local/bin/claude` (2.1.322), connecté. Il n'est pas dans le PATH d'un shell ssh non interactif : toujours le chemin absolu.
- **Ultron**, le bot Telegram d'Eliot, tourne déjà sur le Victus (`~/ultron`, sessions `~/.claude/projects/-home-eliotgrx-ultron`). **N'y touchez pas** : ni ses fichiers, ni ses processus, ni ses `claude`.
- Les tests ne tuent que les processus qu'ils ont lancés eux-mêmes. Pas de `rm` sur un motif de fichiers : les fichiers de test vont dans un dossier neuf de `/tmp`.

## Architecture

```
 Victus                                                     Mac
 ┌────────────────────────────┐                             ┌──────────────────────────┐
 │ ultron-moteur (démon)      │◄── socket unix ──┐          │ Jarvis Terminal (Swift)  │
 │  sessions, processus       │                  │          │  sessions Mac (locales)  │
 │  claude, transcripts       │◄── socket ── ultron-terminal relais ◄── ssh -T victus ─┤  sessions Victus (relais)│
 └────────────────────────────┘                  │          └──────────────────────────┘
          ▲                                      │
          └── socket ── Ultron Terminal (GTK 4 + WebKitGTK, sur l'écran du Victus)
```

- **Le démon `ultron-moteur` possède les sessions.** C'est lui qui lance `claude` (mêmes arguments et même environnement que `app/Sources/ClaudeArgs.swift` et `Session.swift`, avec `BT_APP=1` et `BT_MACHINE=victus`). Les sessions survivent à la fermeture de l'app GTK et aux coupures du Mac.
- **Les clients sont des pages.** L'app GTK du Victus et l'app Mac affichent la même page `ui/index.html`, et la même barre `ui/sessions.html`. Plusieurs pages peuvent regarder la même session en même temps : tout ce que le démon envoie à une session part à toutes les pages attachées.
- Le démon reprend le rôle de `Session.swift` (Mac) pour ses sessions : file d'appels vers la page, `pret` → `info` (avec `direct` si le processus tourne) puis `historique`, `versClaude`, `relancer`, `etat`, `question`/`questionClose` (on les garde en mémoire et on les relaie entre pages, pas de Telegram dans cette version), `reprendreIci`, modèle et effort, `fin`. Porter le comportement, pas recopier le Swift ligne à ligne.

## Protocole du démon (lignes JSON, une par message, UTF-8)

Socket : `$XDG_RUNTIME_DIR/ultron-terminal.sock`, droits 0600. Commande relais : `~/.local/bin/ultron-terminal relais` relie stdin/stdout au socket, ce qui permet au Mac de faire `ssh -T victus ~/.local/bin/ultron-terminal relais` et de parler le même protocole. Si le démon ne tourne pas, `relais` le démarre (`systemctl --user start ultron-moteur`) et attend le socket jusqu'à 5 s.

Client → démon (`op`) :
- `{"op":"bonjour","client":"gtk"|"mac","version":1}` → `{"ev":"bonjour","machine":"victus","version":1,"home":"/home/eliotgrx"}`
- `{"op":"abonner"}` : le client reçoit `{"ev":"liste","sessions":[…]}` tout de suite, puis à chaque changement (au plus toutes les 0,3 s). Une session : `{id, projet, emoji, cwd, etat, resume, dernierMessage, modele, effort, dansTerminal, maj (ms), machine:"victus"}`, les mêmes champs que la barre du Mac (`barreSessions.maj`).
- `{"op":"ouvrir","cwd":"/home/eliotgrx/…","resume":id|null,"prompt":texte|null,"modele":…,"effort":…,"req":"r1"}` → `{"ev":"ouverte","req":"r1","sessionId":…}` ou `{"ev":"erreur","req":"r1","message":…}`. Si `resume` est donné et que la session existe déjà dans le démon, il renvoie la même.
- `{"op":"attacher","sessionId":…,"canal":"c1"}` : `canal` est choisi par le client et unique par connexion. Le démon répond `{"ev":"attache","canal":"c1"}`. La page du client enverra ensuite son `pret`.
- `{"op":"page","canal":"c1","message":{…}}` : un message de la page, tel que la page l'envoie (`pret`, `versClaude`, `relancer`, `etat`, `question`, `questionClose`, `reprendreIci`, `fermer`…). Le démon traite ceux qui concernent la session. **Les actions locales restent chez le client** et ne sont jamais envoyées : `copier`, `ouvrirLien`, `ouvrirShell`, fichiers joints et choix de fichiers.
- `{"op":"ceder","sessionId":…}` : « Continuer dans un terminal ». Le démon arrête le processus, marque `dansTerminal` et envoie `fin {raison:"terminal"}`. C'est le client qui ouvre le terminal : `gnome-terminal` sur le Victus, Terminal.app avec `ssh -t victus 'cd … && ~/.local/bin/claude --resume …'` sur le Mac.
- `{"op":"detacher","canal":"c1"}`, `{"op":"fermer","sessionId":…}` : arrête le processus proprement (interruption, fin de stdin, SIGTERM 2 s, SIGKILL 5 s) et retire la session.
- `{"op":"dossiers","req":"r2"}` → `{"ev":"dossiers","req":"r2","liste":[{cwd, nom, maj}]}` : dossiers récents du Victus pour lancer une session, tirés de `~/.claude/projects/*` (le nom du dossier y est encodé avec des `-`, d'où la vérification de chaque dossier sur le disque) et des sessions récentes, triés du plus récent au plus ancien.
- `{"op":"ping"}` → `{"ev":"pong"}`.

Démon → client :
- `{"ev":"page","canal":"c1","appels":[["info",{…}],["depuisClaude","<ligne>"],…]}` : appels `bt.<fonction>(argument)` à exécuter dans l'ordre sur la page de ce canal. Mêmes fonctions et mêmes arguments que le Mac (`info`, `depuisClaude`, `stderr`, `fin`, `historique`, `envoyerTexte`, `reponseExterne`…). On regroupe ce qui arrive dans un intervalle d'environ 16 ms.
- `info` porte en plus `machine:"victus"`, `app:"ultron-terminal"`, `vocal:false`.
- Quand une page répond à une question, le démon envoie `reponseExterne` aux autres pages de la session, avec `source:"mac"` ou `source:"victus"`. C'est ainsi que la question se ferme partout.
- Limites : une ligne fait 20 Mo au plus. Si un client ne lit plus (tampon de plus de 64 Mo), on le déconnecte sans bloquer les autres.

Sécurité : le démon n'exécute jamais une commande venue d'un client. `versClaude` écrit seulement sur le stdin de claude. `cwd` doit être un dossier existant sous le home. Les identifiants de session sont des UUID validés.

## Médias

La page cite des chemins absolus du Victus (`/home/eliotgrx/…`).
- App GTK : schéma `btmedia://` servi en local, avec les mêmes règles que `app/Sources/Medias.swift` (fichiers sous le home, types image, vidéo et audio, et les requêtes Range pour les vidéos).
- App Mac, pour une session du Victus : son gestionnaire `btmedia` va chercher le fichier par `ssh victus cat -- <chemin>`, avec un cache dans `~/Library/Caches/JarvisTerminal/victus/`. Mêmes règles de chemin, appliquées au home du Victus.

## Marque Ultron

Quand `info.machine === "victus"`, la page pose `body.machine-victus` :
- un **petit encadré « Ultron »** dans la barre du haut, à la place du bouton « Mode Jarvis », qui est caché parce que le vocal est absent ;
- les textes de la page qui disent « Jarvis » deviennent « Ultron » quand ils parlent de la machine ou de l'assistant ;
- une teinte d'accent distincte du Mac, sobre, dans la charte marbre actuelle. Pas de néon ni de verre (mémoire `design-opaque-lecture.md`).

Dans la barre des sessions du Mac, une session du Victus porte le même petit encadré « Ultron ». Le bouton « Nouvelle session » permet de choisir Mac ou Victus. Sur le Victus, l'app s'appelle **Ultron Terminal**, avec la même barre des sessions à gauche, où toutes les sessions sont celles du Victus.

## Installation sur le Victus

- Code : `~/.local/share/ultron-terminal/` (`moteur/`, `app/`, copie de `ui/`).
- Commande : `~/.local/bin/ultron-terminal` avec les sous-commandes `app` (ouvrir la fenêtre), `relais`, `moteur` (lancer le démon au premier plan), `etat`.
- Démon : `~/.config/systemd/user/ultron-moteur.service`, activé et redémarré en cas d'échec.
- Lanceur GNOME : `~/.local/share/applications/ultron-terminal.desktop`, avec une icône.
- Déploiement depuis le Mac : `victus/deployer.sh`, qui fait un rsync de `victus/linux/` et de `ui/`, installe, recharge le démon **sans tuer les sessions en cours si possible**, et affiche « ok ».

## Répartition des fichiers

| Agent | Rôle | Écrit uniquement dans |
|---|---|---|
| A — Démon | `ultron-moteur` + `ultron-terminal relais/moteur/etat` + service systemd | `victus/linux/moteur/`, `victus/linux/bin/`, `victus/linux/systemd/` |
| B — App Linux | Fenêtre GTK 4 + WebKitGTK (barre des sessions + pages), `btmedia`, terminal, presse-papiers, lanceur, déploiement ; marque Ultron dans la page | `victus/linux/app/`, `victus/linux/applications/`, `victus/deployer.sh`, `ui/js/machine.js` (nouveau), `ui/css/machine.css` (nouveau), et les deux lignes qui les incluent dans `ui/index.html` |
| C — Mac | Sessions Victus dans l'app Mac : connexion ssh relais, fenêtres de session relayées, barre, choix Mac / Victus, médias distants, terminal par ssh | `app/Sources/Victus*.swift` (nouveaux) ; modifications ciblées de `FenetrePrincipale.swift`, `FenetreSession.swift`, `Entrees.swift`, `Medias.swift`, `main.swift` ; `ui/js/sessions.js`, `ui/css/sessions.css`, `ui/sessions.html` |

Personne d'autre ne touche à `app/Sources/Session.swift` ni à `ui/js/interface.js` / `session.js`. Ce qui manque de ce côté va dans le rapport.

Fin de chantier : l'app Mac est compilée avec `./app/build.sh`, mais **pas relancée par les agents** (le fil principal s'en charge). Sur le Victus, pas de fenêtre ouverte sur l'écran d'Eliot en dehors des tests courts, qu'on referme ensuite.
