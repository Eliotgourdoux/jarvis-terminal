# Rapport go/no-go — moteur stream-json (agent B)

Date : 07/11/2026. Claude Code 2.1.319, binaire `~/.local/bin/claude`. Essais : `moteur/essai.py` (python3, bibliothèque standard), un scénario par fonction, tous avec `BT_TEST=1`, `cwd = moteur/bac-a-sable/`, environnement purgé des variables `CLAUDE*` de la session parente. Journaux bruts : `moteur/journal/run-<scénario>.log` (résumé lisible) et `moteur/journal/<nom>.jsonl` (stdout brut). Protocole détaillé : `moteur/PROTOCOLE.md`.

## Verdict : GO

Tout ce dont l'app a besoin passe en stream-json, sans bricolage : flux en direct, plusieurs tours dans un même processus, permissions et questions structurées (y compris en bypass pour les questions), changement de modèle et d'effort à chaud, interruption, reprise croisée terminal ↔ app, transcript lisible, consommation sur l'abonnement. Un seul défaut gênant, côté configuration d'Eliot et pas côté Claude Code : le hook MessageDisplay injecte des codes ANSI dans le texte final.

## Point par point

| # | Point | Verdict | Preuve |
|---|---|---|---|
| 1 | Envoi d'un message, deltas partiels, résultat final | GO | `run-flux.log` : `text_delta` « Bonjour » puis « \nHello\nHola », ligne `assistant`, `result/success` en 1,4 s. 67 deltas sur `fixtures/markdown-riche.jsonl`. |
| 2a | Plusieurs tours, même processus | GO | `run-multi_tours.log` : « CITRON » retenu au tour 1, redonné au tour 2. |
| 2b | Message envoyé pendant que Claude travaille | GO | Envoyé pendant `sleep 6` ; Claude répond « premier fini / deuxième reçu » dans le même tour (un seul `result`). Transcript : `attachment/queued_command`. |
| 2c | Interruption | GO | `interrupt` → `{"still_queued":[]}`, ligne `user` « [Request interrupted by user] », `result` `error_during_execution` (`terminal_reason: aborted_streaming`) ; le message suivant reçoit « toujours là ». Réserve : interruption faite pendant la génération ; une interruption pendant un Bash long n'a pas été mesurée (Claude Code a bloqué le `sleep 30` de lui-même). |
| 3a | Permission sans bypass : autoriser | GO | `can_use_tool` Write reçu, `allow` → `autorise.txt` créé (vérifié sur disque). |
| 3b | Permission sans bypass : refuser | GO | `deny` → `refuse.txt` absent, Claude : « Eliot a refusé la création de `refuse.txt`. Je n'insiste pas » ; `result.permission_denials` le liste. |
| 3c | Avec `--dangerously-skip-permissions` | GO | `run-permission_bypass.log` : Write + Bash sans aucun `can_use_tool` ; `permissionMode: bypassPermissions`. Seul AskUserQuestion remonte encore (point 4). ExitPlanMode et autres cas particuliers non testés. |
| 4 | AskUserQuestion, choix unique + multiple | GO | Arrive en `can_use_tool` (`tool_name: AskUserQuestion`, `requires_user_interaction: true`), avec ou sans bypass. Réponse `allow` + `updatedInput.answers` ; Claude répète « FRUIT=Kiwi ; COULEURS=Rouge, Vert ». Texte libre et refus vérifiés (`run-question_variantes.log`). |
| 5 | Changer de modèle en cours de session | GO | `set_model` sonnet → `{"model":"claude-sonnet-5-5"}` ; tour suivant : `message.model = claude-sonnet-5-5`, `modelUsage` contient haiku puis sonnet. |
| 6 | Changer l'effort en cours de session | GO | `apply_flag_settings {"effortLevel":"high"}` : `$CLAUDE_EFFORT` = `low` puis `high` au tour suivant (`run-effort.log`). `set_max_thinking_tokens` accepté (effet non mesuré). Le repli « relancer avec `--resume` » n'est pas nécessaire, mais il marche aussi (point 7). |
| 7a | `--session-id` imposé | GO | `init.session_id` = l'uuid imposé. |
| 7b | stream-json → `claude -p --resume <id>` au terminal | GO | Le terminal redonne « ZEBRE-42 » retenu dans la session stream-json. |
| 7c | `-p` (terminal) → reprise en stream-json | GO | Session créée par `claude -p --session-id`, reprise en stream-json : « HIBOU-7 », même id. La reprise ne rejoue aucun historique sur stdout (0 ligne). |
| 7d | Reprise en TUI interactif (`claude --resume` dans Terminal.app) | NON VÉRIFIÉ | Impossible à piloter ici. Même fichier transcript que `-p`, donc très probable. À tester à la main une fois. |
| 8 | Transcript : emplacement, nommage, format | GO | `~/.claude/projects/<cwd avec [^a-zA-Z0-9] → ->/<id>.jsonl`, vérifié avec `Dossier test_é.v2 (x)` → `Dossier-test---v2--x-`. Texte propre (sans ANSI). Chemins > 200 caractères non vérifiés. Exemple nettoyé : `fixtures/transcript-exemple.jsonl`. |
| 9 | Init : outils, commandes, skills, MCP, modèle, mode, clé | GO | `init` liste 64 outils, les skills d'Eliot, beeper et playwright connectés. CLAUDE.md global + projet chargés (transcript `attachment/instructions`). Hooks chargés (MessageDisplay actif, `stop_hook_summary` de `long-task-notify.sh`). |
| 9b | Abonnement, pas de facturation API | GO | `apiKeySource: "none"`, `subscriptionType: "Claude Team"`, `rate_limit_event` sur les fenêtres 5 h / 7 j, `/cost` : « You are currently using your subscription to power your Claude Code usage ». `total_cost_usd` = estimation au prix public, pas une facture. |
| 10 | Commande slash envoyée comme texte | GO | `/context` (tableau markdown de l'usage du contexte) et `/cost` répondent : une ligne `assistant` + `result`, sans `stream_event`. |

Autres faits vérifiés :
- Rien ne sort avant le premier message (5 s, 0 ligne) ; `system/init` est répété à chaque tour.
- `--verbose` obligatoire (sinon code 1 et message d'erreur).
- Fermer stdin pendant un outil : le tour se termine (`result/success`), sortie code 0 en 6,4 s.
- Sous-agent en arrière-plan : lignes avec `parent_tool_use_id` ; à sa fin, claude joue **seul** un second tour (deuxième `result` sans nouveau message). Même stdin fermé, il attend la tâche avant de sortir.
- `--thinking-display summarized` rend le texte de réflexion lisible (sinon blocs `thinking` vides).
- Modèle inconnu : `result.subtype = "success"` mais `is_error: true`, `api_error_status: 404`, code de sortie 1. Il faut se fier à `is_error`.
- `set_permission_mode` vers bypass refusé si le processus n'a pas été lancé avec `--dangerously-skip-permissions` ou `--allow-dangerously-skip-permissions`.

## Ce qui ne marche pas ou reste à surveiller

1. **Codes ANSI dans le texte final** (le vrai problème). `~/.claude/hooks/green-summary.sh` (MessageDisplay) ajoute bandeau, couleurs et filet dans les lignes `assistant` et `result`. Les deltas et le transcript restent propres. Correction recommandée (hors périmètre de B, fichier non attribué dans le contrat) : ajouter `[ -n "${BT_APP:-}${BT_TEST:-}" ] && exit 0` en tête du hook, comme pour `TG_BOT_NAME`. En attendant, la page doit nettoyer (regex dans PROTOCOLE §3.3).
2. **Délai d'une question sans réponse** : aucun délai à 150 s (voir « Attente longue » ci-dessous). Au-delà, rien n'a été mesuré.
3. **Deux processus sur la même session** (app + Terminal via « ouvrir dans le terminal ») : non testé. Recommandation : arrêter le processus de l'app (fermer stdin, attendre la sortie) avant de lancer `claude --resume` dans Terminal.
4. **Interface texte interactive** (`claude --resume` en TUI) : non vérifié (point 7d).
5. **Images** dans les messages envoyés : format documenté par le SDK, non essayé.
6. Le transcript est lourd (~300 Ko pour un tour très court : prompt système, liste des skills, CLAUDE.md copiés dedans). Lire ligne par ligne et ne garder que `user` / `assistant` / `attachment.queued_command`.

## Attente longue (question laissée sans réponse)

GO. `run-attente_longue.log` : AskUserQuestion reçue (en bypass), aucune réponse pendant 150 s. Pendant l'attente, seules les 3 lignes de fin du message en cours arrivent (`message_delta`, `message_stop`, `rate_limit_event`), puis plus rien. Aucun délai, aucune annulation, le processus reste vivant. La réponse « Café » envoyée à 151 s est bien reçue (« Vous avez répondu : Café »). Une réponse tardive depuis Telegram fonctionne donc, au moins jusqu'à 2 min 30. Au-delà, pas de mesure, mais le réglage `askUserQuestionTimeout` vaut `never` par défaut. Une permission (et pas une question) laissée en attente n'a pas été mesurée ; c'est le même mécanisme `can_use_tool`.

## Ce que C (interface) et D (coque) doivent absolument savoir

1. Arguments : `--output-format stream-json --input-format stream-json --verbose --include-partial-messages --permission-prompt-tool=stdio --dangerously-skip-permissions --model <m> --effort <e> --thinking-display summarized` + `--session-id <uuid neuf>` ou `--resume <id>`. Pas de `-p`. `cwd` = projet, `BT_APP=1`, `PATH` complet, aucune variable `CLAUDE*` héritée.
2. Envoi : `{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"…"}]},"parent_tool_use_id":null}` + `\n`. Possible même pendant que Claude travaille.
3. Permission et question : `control_request` `can_use_tool` → répondre `{"type":"control_response","response":{"subtype":"success","request_id":<le même>,"response":{"behavior":"allow","updatedInput":<input>}}}` ou `"behavior":"deny","message":"…"`. Pour AskUserQuestion : `updatedInput = {questions: <les mêmes>, answers: {"<texte de la question>": "<label>" | "<l1>, <l2>" | "<texte libre>"}}`.
4. Contrôles : `set_model`, `apply_flag_settings {effortLevel}`, `interrupt`, `set_permission_mode` ; terminer = fermer stdin. Pas besoin de relancer pour changer modèle ou effort.
5. Pièges : texte des lignes `assistant` / `result` pollué par l'ANSI du hook (nettoyer) ; `system/init` à chaque tour ; une ligne `assistant` = un seul bloc (regrouper par `message.id`) ; des tours peuvent démarrer sans message (tâches de fond) ; se fier à `is_error` ; la reprise ne rejoue rien, l'historique vient du transcript.
