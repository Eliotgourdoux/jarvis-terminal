# 🖥️ Better Terminal For Claude

C'est dans le nom, on va faire un message terminal mais uniquement pour lancer les claude code avec cockpit, car les terminaux sont dégueulasse actuellemt c'est quand meme dommage

To-do du projet : `todo list better-terminal-for-claude` (liste Rappels « 🖥️ Better Terminal For Claude »).

## Plan (validé avec Eliot le 07/11/2026)

**Ce n'est pas un terminal.** C'est une app Mac qui affiche les sessions Claude Code comme une vraie conversation, belle et fluide. Un terminal reste une grille de caractères de même taille : il ne peut pas régler les vrais problèmes.

Problèmes à régler, par priorité : 1. lecture (pas de hiérarchie, messages qui se confondent) ; 2. historique et défilement (`/resume` buggé) ; 3. Cmd+F moche ; 4. commandes à taper au lieu de boutons (modèle, effort, fermer) ; 5. permissions vues trop tard.
Pas des problèmes : lancement, pilotage à distance, passage d'une session à l'autre (Cockpit et Jarvis le font déjà).

Architecture :
- Moteur : `claude` lancé en mode stream-json. Même Claude Code, mêmes CLAUDE.md, hooks, skills et compte.
- Interface : 100 % HTML/CSS (`ui/css/app.css`), design marbre par défaut (DA Cockpit), zone de lecture contrastée, jamais de verre ni de néon. Rendu riche : titres, blocs de code copiables, tableaux, appels d'outils repliés.
- Coque Swift minimale : fenêtre, effet verre macOS, lancement des processus `claude`. Pas d'Electron.
- Filet de sécurité : bouton « ouvrir dans le terminal » qui reprend la même session avec `claude --resume <id>`.
- App séparée de Cockpit : Cockpit reste le navigateur de sessions, et le reconstruire ne doit pas tuer les sessions.

Étapes :
0. Hook `Notification` → alerte forte pour les permissions (indépendant de l'app).
1. Script de test stream-json : go/no-go technique (permission, modèle, effort, reprise, consommation sur l'abonnement).
2. Maquette HTML de l'écran de conversation (elle deviendra l'app).
3. Coque Swift + une session de bout en bout.
4. Rendu riche, historique, Cmd+F, boutons modèle / effort / fermer, bannière permission.
5. Branchement Cockpit (lancer dans l'app, voir ses sessions), puis Jarvis (`Remote.swift`). À concevoir le moment venu : ces sessions n'ont plus de tty.
6. Questions de Claude sur Telegram : chaque permission ou question (oui/non, choix, cases à cocher, « préciser ») arrive aussi chez Jarvis avec des boutons Telegram. On répond depuis le Mac ou depuis Telegram, la première réponse l'emporte et l'autre côté se met à jour. Côté Jarvis : `tg-router.sh` (~/Desktop/Projets/Jarvis-Ultron-Telegram) est le seul à lire getUpdates du bot, c'est donc lui qui gère les boutons ; échange avec l'app par fichiers, comme `Remote.swift`. À ne pas bricoler sur les sessions Terminal actuelles : seule l'app reçoit les questions sous forme structurée.
7. Mode vocal « Jarvis » (idée d'Eliot du 07/11/2026, lancé le même jour avec les choix par défaut décrits dans CONTRAT.md, section « Mode vocal ») : Eliot parle à ses sessions et elles lui répondent en vocal, une par une, via une file d'attente commune (questions et fins de tâche). Chaque session dit un résumé court, pas sa réponse entière. Briques déjà existantes chez Eliot : whisper.cpp en local (`~/.claude/bin/voice.sh`, modèle large-v3-turbo), voix edge-tts de Jarvis (`tg-say.sh`), `tts-clean.py`, convention `[[vocal]]` / `[[texte]]` du routeur Jarvis.

## Définition de « fait » (18/11/2026, après audit)

- Changement visible : vu dans la vraie fenêtre, à la vraie taille (barre des sessions : 248 px), avec de vraies données, capture montrée dans la réponse. Comportement : exécuté pour de bon. Sinon la réponse commence par « Non vérifié : ».
- Vérifier dans une instance de dev (`app/Sources/PiloteDev.swift`, `BT_DEV_PILOTE`, `app/bac-a-sable/`), pas dans l'app où tournent les sessions d'Eliot.
- Ne jamais afficher un contrôle qui n'est pas encore branché.
- Une fonctionnalité à la fois, un commit par fonctionnalité (le projet est sous git : plus de fichiers `.bak-*`).
- Relancer l'app seulement pour une mise à jour importante, finie et vérifiée.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
