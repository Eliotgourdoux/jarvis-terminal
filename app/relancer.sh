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

# Seule l'interface a changé depuis le dernier lancement (même empreinte du code Swift) : pas besoin de quitter.
# Les pages se rechargent sur place et aucune session n'est coupée, même en plein travail (18/11/2026).
BUILD="$(cd "$(dirname "$0")" && pwd)/.build"
if [[ -s "$BUILD/sources.sha" && -s "$BUILD/lancee.sha" ]] && cmp -s "$BUILD/sources.sha" "$BUILD/lancee.sha" \
   && pgrep -qf "Jarvis Terminal.app/Contents/MacOS"; then
  open -g "betterterminal://recharger"
  echo "$(date '+%H:%M:%S') interface seule : pages rechargées, app non quittée"
  exit 0
fi

# Jamais pendant qu'une autre session travaille (16/11/2026 : la relance a coupé une demande en cours
# dans Stories Reels FR, restée ensuite 44 min à l'arrêt). On attend qu'elles soient toutes prêtes,
# 30 min au plus ; au-delà, on abandonne la relance plutôt que de les interrompre.
occupees() {
  local f etat sid pid agents n=0
  for f in ~/.config/better-terminal/sessions/*.json(N); do
    etat=$(/usr/bin/plutil -extract etat raw -o - "$f" 2>/dev/null)
    sid=$(/usr/bin/plutil -extract sessionId raw -o - "$f" 2>/dev/null)
    pid=$(/usr/bin/plutil -extract pid raw -o - "$f" 2>/dev/null)
    agents=$(/usr/bin/plutil -extract agents raw -o - "$f" 2>/dev/null)
    [[ "$agents" == <-> ]] || agents=0   # champ absent (ancienne version de l'app) : plutil écrit son erreur sur stdout
    # agents de fond (17/11/2026) : la relance les tuerait, y compris ceux de la session qui la demande
    { [[ "$etat" == travaille && "$sid" != "$1" ]] || (( ${agents:-0} > 0 )) } && kill -0 "$pid" 2>/dev/null \
      && { echo "  occupée : $(/usr/bin/plutil -extract projet raw -o - "$f" 2>/dev/null) (${etat}, ${agents:-0} agent(s))"; n=$((n+1)); }
  done
  return $(( n == 0 ))
}
# L'app en marche sait laisser ses claude tourner pendant qu'elle redémarre (18/11/2026, marqueur écrit plus bas
# au premier lancement d'une version qui le sait) : rien n'est coupé, donc on n'attend personne.
GARDE=""
[[ -f "$BUILD/garde-ok" ]] && GARDE=1
for i in {1..360}; do
  [[ -n "$GARDE" ]] && break
  occupees "$1" >/tmp/jarvis-relance-occupees.txt || break
  (( i == 1 )) && { echo "$(date '+%H:%M:%S') attente de sessions qui travaillent :"; cat /tmp/jarvis-relance-occupees.txt; }
  (( i == 360 )) && { echo "$(date '+%H:%M:%S') sessions toujours au travail après 30 min : relance abandonnée"; exit 1; }
  sleep 5
done

[[ -n "$1" ]] && defaults write $ID BTRelanceDemandeur "$1"   # pas de reprise automatique pour elle
[[ -n "$GARDE" ]] && { defaults write $ID BTGarderUneFois -bool true; echo "$(date '+%H:%M:%S') les claude restent en fond pendant la relance"; }
osascript -e "tell application id \"$ID\" to quit" || true
for i in {1..30}; do pgrep -qf "Jarvis Terminal.app/Contents/MacOS" || break; sleep 0.5; done
pgrep -qf "Jarvis Terminal.app/Contents/MacOS" && { echo "l'app ne s'est pas fermée, relance abandonnée"; exit 1; }
[[ "$2" == jarvis ]] && defaults write $ID BTModeVocal -bool true
open "$APP"
[[ -s "$BUILD/sources.sha" ]] && cp "$BUILD/sources.sha" "$BUILD/lancee.sha"
touch "$BUILD/garde-ok"
echo "$(date '+%H:%M:%S') relancée"
