#!/bin/zsh
# Relance Jarvis Terminal pour qu'Eliot voie les changements (demande d'Eliot, 07/11/2026 : à la fin de chaque message).
# Usage : app/relancer.sh [id-de-session] [jarvis]   (« jarvis » : rouvre en mode vocal Jarvis, demande d'Eliot 09/11/2026)   (lancé détaché par Claude, depuis une session qui tourne dans l'app)
# 1. attend que le transcript de la session ne bouge plus (la réponse de Claude est écrite) ;
# 2. quitte l'app proprement (les sessions sont mémorisées) ; 3. la rouvre : les sessions reprennent.
ID=local.eliot.betterterminal
APP="$(cd "$(dirname "$0")" && pwd)/build/Jarvis Terminal.app"
JOURNAL=/tmp/jarvis-terminal-relance.log
exec >>"$JOURNAL" 2>&1
echo "--- $(date '+%H:%M:%S') relance demandée (session ${1:-?})"

T=""
[[ -n "$1" ]] && T=$(ls -t ~/.claude/projects/*/"$1".jsonl 2>/dev/null | head -1)
sleep 6
if [[ -n "$T" ]]; then
  for i in {1..90}; do
    age=$(( $(date +%s) - $(stat -f %m "$T") ))
    (( age >= 5 )) && break
    sleep 1
  done
fi

osascript -e "tell application id \"$ID\" to quit" || true
for i in {1..30}; do pgrep -qf "Jarvis Terminal.app/Contents/MacOS" || break; sleep 0.5; done
pgrep -qf "Jarvis Terminal.app/Contents/MacOS" && { echo "l'app ne s'est pas fermée, relance abandonnée"; exit 1; }
[[ "$2" == jarvis ]] && defaults write $ID BTModeVocal -bool true
open "$APP"
echo "$(date '+%H:%M:%S') relancée"
