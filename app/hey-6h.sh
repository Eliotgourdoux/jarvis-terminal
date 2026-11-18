#!/bin/zsh
# « Hey » de 6 h (demande d'Eliot, 18/11/2026) : un premier message à Claude chaque matin, pour que la
# fenêtre de 5 h de l'abonnement commence à 6 h (et se rouvre à 11 h) au lieu de commencer au premier vrai message.
# Lancé par launchd (~/Library/LaunchAgents/local.eliot.betterterminal.hey.plist), à 6 h ou au réveil du Mac
# s'il dormait. Une seule fois par jour. Modèle Haiku, sans hooks ni transcript : coût négligeable.
# Ce fichier est la source ; la copie exécutée est ~/.config/better-terminal/hey-6h.sh (launchd n'a pas accès
# au Bureau). Après une modification : cp app/hey-6h.sh ~/.config/better-terminal/hey-6h.sh
# Arrêter : launchctl bootout gui/$(id -u)/local.eliot.betterterminal.hey
JOURNAL="$HOME/Library/Logs/Better Terminal/hey.log"
DOSSIER="$HOME/.cache/jarvis-hey"
mkdir -p "$DOSSIER" "${JOURNAL:h}" && cd "$DOSSIER" || exit 1
JOUR=$(date +%F)
[[ -f dernier && "$(<dernier)" == "$JOUR" ]] && exit 0
# au réveil du Mac, le réseau met quelques secondes à revenir
for i in {1..12}; do /usr/bin/nc -z -G 3 api.anthropic.com 443 2>/dev/null && break; sleep 5; done
R=$("$HOME/.local/bin/claude" -p "Hey" --model haiku --no-session-persistence --setting-sources project --output-format json </dev/null 2>&1)
if [[ "$R" == *'"is_error":false'* ]]; then
  echo "$JOUR" > dernier
  echo "$(date '+%F %T') Hey envoyé" >> "$JOURNAL"
else
  echo "$(date '+%F %T') Hey en échec : ${R[1,300]}" >> "$JOURNAL"
fi
