# Protocole stream-json de Claude Code (2.1.319) — référence pour l'app

Rédigé par l'agent B à partir du code du SDK officiel (`@anthropic-ai/claude-agent-sdk` 0.3.319, lu sans l'exécuter dans `moteur/lecture-sdk/`) et d'essais réels (`moteur/essai.py`, journaux bruts dans `moteur/journal/`). Tout ce qui est écrit ici a été observé, sauf mention **non vérifié**.

## 1. Lancement

Binaire : `~/.local/bin/claude` (lien vers `~/.local/share/claude/versions/2.1.319`). Ne pas passer par un shell : l'alias `claude` du zsh d'Eliot n'existe pas pour un processus lancé par Swift.

Arguments (tableau, un élément par case) — la base est celle que construit le SDK officiel :

```json
["--output-format", "stream-json",
 "--input-format", "stream-json",
 "--verbose",
 "--include-partial-messages",
 "--permission-prompt-tool=stdio",
 "--dangerously-skip-permissions",
 "--model", "<modele>",
 "--effort", "<low|medium|high|xhigh|max>",
 "--thinking-display", "summarized",
 "--session-id", "<uuid v4 neuf>"]
```

Reprise d'une session : remplacer `"--session-id", "<uuid>"` par `"--resume", "<sessionId>"`.

| Argument | Rôle | Vérifié |
|---|---|---|
| `--output-format stream-json` | une ligne JSON par message sur stdout | oui |
| `--input-format stream-json` | on écrit des lignes JSON sur stdin ; le processus reste vivant entre les tours | oui |
| `--verbose` | **obligatoire** avec stream-json (sinon : `Error: When using --print, --output-format=stream-json requires --verbose`, code 1) | oui |
| `--include-partial-messages` | deltas de texte au fil de l'eau (`stream_event`) | oui |
| `--permission-prompt-tool=stdio` | permissions et questions de Claude (AskUserQuestion) arrivent en `control_request` sur stdout, réponse sur stdin. **À garder même en bypass**, sinon les questions n'ont personne pour répondre | oui |
| `--dangerously-skip-permissions` | mode habituel d'Eliot (`permissionMode: "bypassPermissions"`) | oui |
| `--model` | alias (`haiku`, `sonnet`, `opus`, `fable`, `default`) ou nom complet. Sans lui : réglage d'Eliot (`fable`) | oui |
| `--effort` | low, medium, high, xhigh, max. Sans lui : réglage d'Eliot (`medium`) | oui (`$CLAUDE_EFFORT` = `low` avec `--effort low`) |
| `--thinking-display summarized` | rend le texte de réflexion lisible (résumé). Sans lui, les blocs `thinking` arrivent vides (`"thinking": ""`, seul `estimated_tokens` bouge) | oui |
| `--session-id <uuid>` | impose l'id : l'app le connaît avant le premier message | oui, `init.session_id` = l'uuid imposé |
| `--resume <id>` | reprend la conversation, **même id** (pas de nouvel id sans `--fork-session`) | oui |

- Pas de `-p` : le SDK ne le passe pas et tout marche sans.
- `--replay-user-messages` (facultatif) : renvoie sur stdout chaque message `user` écrit sur stdin, avec son `uuid`. Vérifié. Inutile si la page affiche elle-même ce qu'elle envoie.

Processus :
- `cwd` = dossier du projet. Il décide des CLAUDE.md projet chargés et du dossier du transcript.
- Environnement : ne PAS transmettre les variables `CLAUDE*` / `CLAUDECODE` / `AI_AGENT` d'une session Claude parente (une app lancée depuis le Finder n'en a pas). Poser `BT_APP=1`. Poser un `PATH` complet (au minimum `~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`) : les hooks d'Eliot appellent `jq`, `perl`, `terminal-notifier`.
- stdin, stdout, stderr en tubes. stdout : lignes JSON séparées par `\n` (une ligne peut dépasser 100 Ko : lire par ligne, sans limite de taille). stderr : texte libre (ex. `[claude-code:unrecognized_model] {...}`), à journaliser.
- **Rien ne sort avant le premier message** : 5 s d'attente après le lancement = 0 ligne (vérifié). `system/init` arrive après le premier envoi. Démarrage effectif ~1 à 2 s.

## 2. Envoyer un message (page → stdin)

Une ligne JSON terminée par `\n` (format exact du SDK) :

```json
{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"Bonjour"}]},"parent_tool_use_id":null}
```

- `content` peut aussi être une simple chaîne. Images : bloc API Messages `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}` (**non vérifié**).
- Message envoyé **pendant** que Claude travaille : accepté, mis en file et intégré au tour en cours (Claude l'a lu après l'outil et y a répondu dans le même message ; un seul `result`). Voir `fixtures/multi-tours.jsonl`. Dans le transcript il apparaît comme `attachment` de type `queued_command`, pas comme ligne `user`.
- Commandes slash : envoyées comme texte (`"/context"`, `"/cost"`), elles marchent. Sortie : une ligne `assistant` (markdown) + un `result`, sans `stream_event`.

## 3. Ce qui sort (stdout → page)

Toutes les lignes ont `type`, et presque toutes `session_id` et `uuid`.

| type / subtype | Quand | Usage UI |
|---|---|---|
| `system` / `init` | au début de **chaque tour** (y compris un tour lancé tout seul, voir §7) | `session_id`, `model`, `permissionMode`, `cwd`, `tools`, `slash_commands`, `skills`, `agents`, `mcp_servers` (`status`: connected / pending / needs-auth / failed), `plugins`, `apiKeySource`, `claude_code_version`, `output_style`. Ne pas vider l'écran à chaque `init`. |
| `system` / `status` | `{"status":"requesting"}` avant chaque appel au modèle | indicateur « travaille » |
| `system` / `thinking_tokens` | pendant la réflexion | `estimated_tokens` (compteur) |
| `system` / `task_started`, `task_progress`, `task_updated`, `task_notification`, `background_tasks_changed` | commandes Bash et sous-agents suivis comme tâches | `tool_use_id`, `description`, `status`, `is_backgrounded` |
| `stream_event` | deltas (avec `--include-partial-messages`) | `event` = événement SSE de l'API : `message_start` (`message.model`, `message.id`), `content_block_start` (`content_block.type` = `text` / `thinking` / `tool_use` avec `name`), `content_block_delta` (`text_delta.text`, `thinking_delta.thinking`, `input_json_delta.partial_json`, `signature_delta`), `content_block_stop`, `message_delta` (`delta.stop_reason`), `message_stop` |
| `assistant` | **un bloc** de contenu terminé | `message.id`, `message.model`, `message.content` = **un seul bloc** (`text`, `tool_use`, `thinking`). Plusieurs lignes `assistant` successives peuvent partager le même `message.id` (thinking, puis tool_use…) : regrouper par `message.id`. |
| `user` | résultat d'outil (ou marqueur d'interruption) | `message.content[0]` = `{"type":"tool_result","tool_use_id","content","is_error"?}` ; `tool_use_result` = sortie structurée de l'outil (voir §3.2) ; `tool_result_meta[].permission_decision` |
| `control_request` | Claude demande quelque chose (permission, question) | §4 |
| `control_response` | réponse à une requête envoyée par la page | `response.request_id` = l'id choisi par la page |
| `rate_limit_event` | après une réponse | quota de l'abonnement : `rate_limit_info.unifiedWindows.five_hour.utilization`, `.seven_day.utilization`, `resetsAt` (epoch s) |
| `result` | fin d'un tour | `subtype`, `is_error`, `result` (texte final), `num_turns`, `duration_ms`, `usage`, `modelUsage`, `permission_denials`, `terminal_reason`, `api_error_status`, `total_cost_usd` (estimation au prix public, **pas une facture** : `costBasis: "list"`) |

`parent_tool_use_id` : `null` pour la conversation principale ; non nul (= `tool_use_id` de l'appel `Agent`) pour les lignes d'un sous-agent. Voir `fixtures/sous-agent.jsonl`.

### 3.1 Exemple raccourci d'un tour texte

```json
{"type":"system","subtype":"init","session_id":"e193…","model":"claude-haiku-5-5","permissionMode":"bypassPermissions","apiKeySource":"none","tools":["Task","AskUserQuestion","Bash",…],"slash_commands":[…],"skills":[…],"mcp_servers":[{"name":"beeper","status":"connected","source":"user"},…],…}
{"type":"system","subtype":"status","status":"requesting",…}
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-haiku-5-5","id":"msg_011…",…}},"parent_tool_use_id":null,…}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},…}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Bonjour"}},…}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\nHello\nHola"}},…}
{"type":"assistant","message":{"id":"msg_011…","model":"claude-haiku-5-5","content":[{"type":"text","text":"…Bonjour\nHello\nHola"}],…},"parent_tool_use_id":null,…}
{"type":"stream_event","event":{"type":"content_block_stop","index":0},…}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},…},…}
{"type":"stream_event","event":{"type":"message_stop"},…}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.34,…},"seven_day":{"utilization":0.66,…}}},…}
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"…Bonjour\nHello\nHola","duration_ms":1159,"total_cost_usd":0.0041,…}
```

Ordre observé : la ligne `assistant` d'un bloc arrive **avant** son `content_block_stop`. Afficher les deltas au fil de l'eau, puis remplacer par la version définitive de la ligne `assistant` (après nettoyage ANSI, §3.3).

### 3.2 Appels d'outils (voir `fixtures/outils.jsonl`)

1. `stream_event` `content_block_start` avec `content_block: {"type":"tool_use","id":"toolu_…","name":"Read","input":{}}`, puis des `input_json_delta` (JSON partiel de l'argument).
2. Ligne `assistant` avec le bloc complet : `{"type":"tool_use","id":"toolu_…","name":"Bash","input":{"command":"ls -la && echo fini","description":"List files…"}}`.
3. Ligne `user` avec le résultat :

| Outil | `message.content[0].content` (texte vu par Claude) | `tool_use_result` (structuré, pour l'UI) |
|---|---|---|
| Read | `"1\tFichier de test…\n2\t…"` | `{"type":"text","file":{"filePath","content","numLines","startLine","totalLines"}}` |
| Bash | sortie brute | `{"stdout","stderr","interrupted","isImage","noOutputExpected"}` |
| Write | `"File created successfully at: …"` | `{"type":"create","filePath","content","structuredPatch":[],"originalFile":null}` |
| Edit | `"The file … has been updated successfully."` | `{"filePath","oldString","newString","originalFile","structuredPatch":[{"oldStart","oldLines","newStart","newLines","lines":[" # Notes"," "," - un","+- deux"]}],"replaceAll"}` → diff prêt à afficher |
| AskUserQuestion | `Your questions have been answered: "Q"="R", …` | `{"questions":[…],"answers":{…}}` |
| erreur / refus | texte d'erreur, `is_error: true` | chaîne `"Error: …"` |

### 3.3 ATTENTION : codes ANSI ajoutés par le hook MessageDisplay d'Eliot

Le hook `~/.claude/hooks/green-summary.sh` (événement `MessageDisplay`) réécrit le texte affiché : bandeau `━━━ Claude 12:06 ━━━━…`, titres et gras colorés, ligne ✅ précédée d'un filet, avec des codes ANSI (`\u001b[1;38;5;166m`…). Ce texte réécrit se retrouve dans les lignes `assistant` et dans `result.result`, **mais pas dans les deltas `stream_event`** (propres) **ni dans le transcript** (propre).

- La page doit retirer les séquences ANSI (`/\u001b\[[0-9;]*m/g`), puis la ligne de bandeau `━━━ Claude HH:MM ━━━…` et le filet `──────…` qui précède la ligne ✅, avant le rendu markdown. Les codes sont parfois **à l'intérieur** du markdown (`**\u001b[38;5;136mgras\u001b[39m**`, `# \u001b[38;5;32mTitre\u001b[39m`).
- Correction propre (hors périmètre de B) : en tête du hook, `[ -n "${BT_APP:-}${BT_TEST:-}" ] && exit 0`, comme pour `TG_BOT_NAME`.
- `fixtures/markdown-riche.jsonl` contient ces codes (état réel d'aujourd'hui) ; `fixtures/markdown-riche-propre.jsonl` est le même genre de réponse sans hook (état visé).

## 4. Permissions et questions de Claude

### 4.1 Demande de permission (hors bypass)

Reçu sur stdout (le `tool_use` correspondant est déjà arrivé en ligne `assistant`, même `tool_use_id`) :

```json
{"type":"control_request","request_id":"0119909a-5ff2-…","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/…/bac-a-sable/autorise.txt","content":"ok"},"description":"autorise.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_011gnWez…"}}
```

Autoriser — écrire sur stdin, **même `request_id`** :

```json
{"type":"control_response","response":{"subtype":"success","request_id":"0119909a-5ff2-…","response":{"behavior":"allow","updatedInput":{"file_path":"/…/bac-a-sable/autorise.txt","content":"ok"},"toolUseID":"toolu_011gnWez…"}}}
```

Refuser :

```json
{"type":"control_response","response":{"subtype":"success","request_id":"37553aea-…","response":{"behavior":"deny","message":"Eliot a refusé la création de ce fichier.","toolUseID":"toolu_01LtnuaL…"}}}
```

- `allow` : `updatedInput` obligatoire (renvoyer `input` tel quel). Facultatif : `updatedPermissions` (ex. une des `permission_suggestions` pour « toujours autoriser »).
- `deny` : `message` est lu par Claude ; `"interrupt": true` arrête en plus le tour.
- Vérifié : fichier autorisé créé ; fichier refusé absent, Claude dit qu'il a été refusé et n'insiste pas ; `result.permission_denials` liste le refus.
- Champs utiles parfois présents : `title`, `description`, `decision_reason`, `blocked_path`, `requires_user_interaction`.

### 4.2 Avec `--dangerously-skip-permissions`

Write et Bash ne demandent plus rien : **zéro `can_use_tool`** (vérifié). Ce qui remonte encore : **AskUserQuestion** (vérifié). Probablement aussi ExitPlanMode et les cas que le bypass ne couvre pas (**non vérifié**). La page doit donc traiter tout `can_use_tool` de façon générique (bannière permission) et AskUserQuestion à part.

### 4.3 AskUserQuestion

Arrive comme une permission, `tool_name: "AskUserQuestion"`, `requires_user_interaction: true`. 1 à 4 questions, 2 à 4 options chacune (la page ajoute elle-même « Autre »).

```json
{"type":"control_request","request_id":"c816dffe-…","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Quel fruit préférez-vous ?","header":"Fruit","options":[{"label":"Pomme","description":"Pomme"},{"label":"Poire","description":"Poire"},{"label":"Kiwi","description":"Kiwi"}],"multiSelect":false},{"question":"Quelles couleurs aimez-vous ?","header":"Couleurs","options":[{"label":"Rouge","description":"Rouge"},{"label":"Vert","description":"Vert"},{"label":"Bleu","description":"Bleu"}],"multiSelect":true}]},"tool_use_id":"toolu_01V2xt6n…","requires_user_interaction":true}}
```

Répondre : `allow`, `updatedInput` = les `questions` d'origine + `answers`, dictionnaire **texte exact de la question → réponse (chaîne)**. Choix multiple : labels joints par `", "`. Texte libre : n'importe quelle chaîne.

```json
{"type":"control_response","response":{"subtype":"success","request_id":"c816dffe-…","response":{"behavior":"allow","updatedInput":{"questions":[…identiques…],"answers":{"Quel fruit préférez-vous ?":"Kiwi","Quelles couleurs aimez-vous ?":"Rouge, Vert"}},"toolUseID":"toolu_01V2xt6n…"}}}
```

Vérifié avec et sans bypass : Claude reçoit `Your questions have been answered: "Quel fruit préférez-vous ?"="Kiwi", "Quelles couleurs aimez-vous ?"="Rouge, Vert"…` et répète `FRUIT=Kiwi ; COULEURS=Rouge, Vert`. Texte libre vérifié (`"Aucun : je préfère la mangue"` recopié mot pour mot). Fermer la question sans répondre : `deny` avec un `message` (vérifié : Claude s'arrête). Voir `fixtures/question.jsonl` et `fixtures/question-variantes.jsonl`.

Facultatif (capacité `ask_user_question_unanswered_v1` annoncée dans `init.capabilities`) : `updatedInput.annotations = {"<question>": {"notes": "…"}}`.

Délai : une question laissée 150 s sans réponse reste en attente (le processus vit, aucune annulation) ; la réponse envoyée ensuite est bien reçue. Le réglage `askUserQuestionTimeout` vaut `never` par défaut. Au-delà de 150 s : non mesuré.

## 5. Requêtes de contrôle envoyées par la page

Forme : `{"type":"control_request","request_id":"<id unique choisi par la page>","request":{"subtype":"…",…}}`.
Réponse : `{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{…}}}` ou `{"subtype":"error","request_id":"…","error":"…","error_code":"…"}`.

| Action | `request` | Résultat observé |
|---|---|---|
| Changer de modèle | `{"subtype":"set_model","model":"sonnet"}` | réponse `{"model":"claude-sonnet-5-5"}` ; le message suivant est servi par sonnet (`message.model`, `modelUsage`) |
| Changer l'effort | `{"subtype":"apply_flag_settings","settings":{"effortLevel":"high"}}` (`null` = revenir au défaut du modèle ; `"max"` accepté) | succès ; `$CLAUDE_EFFORT` passe de `low` à `high` au tour suivant |
| Budget de réflexion | `{"subtype":"set_max_thinking_tokens","max_thinking_tokens":2048}` (`null` = défaut) | succès (effet non mesuré) |
| Interrompre | `{"subtype":"interrupt"}` | réponse `{"still_queued":[]}`, puis ligne `user` `"[Request interrupted by user]"`, puis `result` `subtype:"error_during_execution"`, `is_error:true`, `terminal_reason:"aborted_streaming"`. La session reste utilisable (message suivant répondu normalement). |
| Mode de permission | `{"subtype":"set_permission_mode","mode":"default"\|"acceptEdits"\|"plan"\|"bypassPermissions"}` | vers `bypassPermissions` : **refusé** si le processus n'a pas été lancé avec `--dangerously-skip-permissions` ou `--allow-dangerously-skip-permissions` (`error_code: "bypass_not_launched"`) ; accepté sinon |
| Infos (menus) | `{"subtype":"initialize"}` | facultatif (tout marche sans). Réponse : `commands` (91, avec description), `agents`, `models` (value, resolvedModel, displayName, supportedEffortLevels), `account` (email, subscriptionType, apiProvider), `current_permission_mode`, `available_output_styles`, `pid`. Envoyable avant le premier message. |

Le SDK expose d'autres sous-types (`get_context_usage`, `get_usage`, `rename_session`, `rewind_files`, `stop_task`, `background_tasks`…) : **non essayés**.

## 6. Terminer

- Fermer stdin : claude **termine le tour en cours** puis sort avec le code 0 (vérifié : stdin fermé pendant un `sleep 4`, le `result` arrive quand même, sortie 6,4 s plus tard). S'il reste une tâche de fond (sous-agent), il l'attend et peut même jouer un tour de plus avant de sortir (vérifié).
- Pour couper net : `interrupt`, puis fermer stdin. Filet : SIGTERM au bout de ~10 s.
- Code de sortie 1 après une erreur fatale (ex. modèle inconnu, voir §8).

## 7. Tours lancés sans message de l'utilisateur

Quand une tâche de fond se termine (sous-agent lancé en arrière-plan, commande Bash en fond), claude enchaîne **tout seul** un nouveau tour : `system/task_notification` → `system/init` → réponse → `result`. Vérifié dans `fixtures/sous-agent.jsonl` (deux `result` pour un seul message envoyé). La page ne doit donc jamais supposer « un message envoyé = un `result` » ; l'état « travaille » se déduit de `system/status` / `stream_event`, l'état « prêt » de `result`.

## 8. Erreurs

Modèle inconnu (`fixtures/erreur.jsonl`) : `init` normal (avec le nom demandé), puis une ligne `assistant` synthétique (`message.model: "<synthetic>"`, champ `error: "model_not_found"`, texte « There's an issue with the selected model… »), puis `result` avec `subtype: "success"` **mais** `is_error: true`, `api_error_status: 404`, `terminal_reason: "api_error"` ; le processus sort avec le code 1. → Se fier à `is_error`, pas à `subtype`.

Outil en échec : ligne `user` avec `tool_result.is_error: true` et le message d'erreur ; le tour continue.

## 9. Reprise et transcript

### 9.1 Reprise

- Session créée en stream-json avec `--session-id X` → `claude -p --resume X "…"` dans un terminal : continuité prouvée (Claude a redonné le code `ZEBRE-42` retenu dans la session stream-json).
- Inverse : session créée par `claude -p --session-id Y` → reprise en stream-json avec `--resume Y` : continuité prouvée (`HIBOU-7`), `init.session_id` = Y.
- La reprise **ne rejoue rien** sur stdout (0 ligne avant le premier message) : l'historique doit venir du transcript (`bt.historique`).
- **Non vérifié** : la reprise en TUI interactif (`claude --resume <id>` dans Terminal.app) ; même fichier, devrait marcher. Éviter que deux processus écrivent la même session en même temps : arrêter le processus de l'app avant d'ouvrir le terminal (recommandation, non testé).

### 9.2 Emplacement

`~/.claude/projects/<dossier>/<sessionId>.jsonl`, où `<dossier>` = le `cwd` absolu dont **chaque caractère qui n'est pas une lettre ASCII ou un chiffre est remplacé par `-`** (un pour un, pas de fusion ; `é` donne un seul `-` ; un emoji donnerait probablement deux `-`, non vérifié). Regex équivalente : `cwd.replace(/[^a-zA-Z0-9]/g, "-")`. Vérifié :

| cwd | dossier |
|---|---|
| `/Users/eliotgourdoux/Desktop/Projets/Better-Terminal-For-Claude/moteur/bac-a-sable` | `-Users-eliotgourdoux-Desktop-Projets-Better-Terminal-For-Claude-moteur-bac-a-sable` |
| `…/bac-a-sable/Dossier test_é.v2 (x)` | `…-bac-a-sable-Dossier-test---v2--x-` |

Chemins très longs (plus de 200 caractères) : troncature + empreinte probable, **non vérifié**. Le plus sûr côté Swift : chercher `~/.claude/projects/*/<sessionId>.jsonl` (l'id est unique), et n'utiliser la règle qu'en premier essai.

Le fichier est écrit au fil de l'eau (fichier `0600`). Taille : ~300 Ko pour un tour très court, à cause des lignes techniques ci-dessous ; lire ligne par ligne.

### 9.3 Format (voir `fixtures/transcript-exemple.jsonl` et `fixtures/transcript-multi-tours.jsonl`, nettoyés)

Une ligne JSON par entrée. Les entrées de conversation sont chaînées par `parentUuid` → `uuid` et portent `timestamp`, `sessionId`, `cwd`, `version`, `entrypoint` (`sdk-cli` pour stream-json et `-p`), `isSidechain`.

| `type` | Contenu | Afficher ? |
|---|---|---|
| `user` | `message.content` : texte de l'utilisateur (tableau de blocs `text`, ou chaîne), ou `tool_result` ; `toolUseResult` = même chose que `tool_use_result` du flux ; `permissionDecision` | oui (texte) / avec l'outil (tool_result). `"[Request interrupted by user]"` = marqueur d'interruption. `isMeta: true` = contexte injecté, à masquer |
| `assistant` | `message` complet de l'API (un bloc par ligne, même `message.id` possible sur plusieurs lignes), texte **sans ANSI** | oui |
| `system` | `subtype` : `stop_hook_summary`, etc. | non (ou discret) |
| `attachment` | contexte injecté : `instructions` (les CLAUDE.md chargés), `skill_listing`, `environment`, `date`, `model`, `queued_command` (message envoyé pendant le travail : `attachment.prompt[0].text`), `prompt_snapshot`… | seulement `queued_command` |
| `queue-operation`, `last-prompt`, `session-owner`, `tools-used`, `cost-state`, `atis-latch`, `api-request`, `api-request-blob`, `api-request-shape` | technique | non |

Reconstruction de l'historique pour l'UI : garder `user` (sans `isMeta`), `assistant`, `attachment/queued_command`, dans l'ordre du fichier ; regrouper les blocs `assistant` par `message.id` ; relier `tool_result` à `tool_use` par `tool_use_id`.

## 10. Ce qui est chargé, et la facturation

Dans une session stream-json lancée normalement (sans `--setting-sources`) :
- **CLAUDE.md** : chargés (transcript, `attachment/instructions` : `~/.claude/CLAUDE.md` type User et `<projet>/CLAUDE.md` type Project).
- **Hooks** : chargés (le hook MessageDisplay colore les réponses ; `system/stop_hook_summary` montre `long-task-notify.sh stop` exécuté).
- **Skills et commandes** : `init.skills` et `init.slash_commands` listent les skills d'Eliot (todo, neon-glass-ui…).
- **MCP** : `init.mcp_servers` (beeper, playwright connectés ; connecteurs claude.ai en `pending`/`needs-auth`).
- **Compte** : `init.apiKeySource: "none"` (pas de clé API : connexion claude.ai), `initialize.account.subscriptionType: "Claude Team"`, `apiProvider: "firstParty"`, `rate_limit_event` sur les fenêtres 5 h / 7 jours de l'abonnement, et `/cost` répond « You are currently using your subscription to power your Claude Code usage ». → consommation sur l'abonnement, pas de facturation API. `total_cost_usd` n'est qu'une estimation au prix public.

## 11. Enregistrements disponibles (`fixtures/`)

Chaque `<nom>.jsonl` = lignes brutes du stdout ; `<nom>.entree.jsonl` = ce qui a été écrit sur stdin.

| Fichier | Contenu |
|---|---|
| `markdown-riche` | sonnet, réponse markdown (h1-h3, gras, italique, listes, bash, swift, tableau, code en ligne, citation, lien), **avec** codes ANSI du hook |
| `markdown-riche-propre` | même demande, hooks désactivés : texte propre |
| `outils` | Read, Bash, Write, Edit avec résultats, blocs `thinking` vides, deltas `input_json_delta` |
| `permission` | sans bypass : Write autorisé, puis Write refusé |
| `question` | AskUserQuestion, choix unique + choix multiple, réponse, Claude répète |
| `question-variantes` | AskUserQuestion fermée (deny), puis réponse en texte libre |
| `multi-tours` | 2 tours, message envoyé pendant un outil, interruption, tour après interruption |
| `sous-agent` | sous-agent en arrière-plan : lignes avec `parent_tool_use_id`, `task_*`, second tour lancé tout seul |
| `erreur` | modèle inconnu : assistant synthétique, `is_error: true`, code de sortie 1 |
| `transcript-exemple` | transcript réel de la session `permission`, nettoyé (CLAUDE.md, prompt système, e-mail et identifiants de compte retirés ; structure conservée) |
| `transcript-multi-tours` | transcript réel de `multi-tours`, nettoyé (montre `queued_command` et l'interruption) |

Outil de nettoyage : `moteur/outils/nettoyer_transcript.py <source> <destination>`.
