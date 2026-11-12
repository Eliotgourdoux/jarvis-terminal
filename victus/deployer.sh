#!/usr/bin/env bash
# Déploie Ultron Terminal sur le Victus, depuis le Mac (victus/CONTRAT-VICTUS.md).
#   victus/linux/  → victus:~/.local/share/ultron-terminal/
#   ui/            → victus:~/.local/share/ultron-terminal/ui/
# puis lien ~/.local/bin/ultron-terminal, service systemd ultron-moteur (redémarré seulement si son code a
# changé : les sessions vivent dans leurs porteurs et survivent de toute façon), lanceur GNOME.
# Les morceaux absents (moteur, bin, systemd…) sont sautés avec un avertissement, sans casser le reste.
# Usage : victus/deployer.sh [hôte ssh, défaut : victus]
set -euo pipefail

HOTE="${1:-victus}"
ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJET="$(dirname "$ICI")"
LINUX="$ICI/linux"
UI="$PROJET/ui"
DEST='.local/share/ultron-terminal'

avertir() { printf 'deployer : %s\n' "$*" >&2; }

[ -d "$LINUX" ] || { avertir "dossier absent : $LINUX"; exit 1; }
[ -f "$UI/index.html" ] || { avertir "ui absente : $UI"; exit 1; }
ssh -o ConnectTimeout=8 "$HOTE" true || { avertir "$HOTE injoignable"; exit 1; }

# Empreinte du code du moteur avant la copie (vide s'il n'existe pas encore).
empreinte_moteur() {
  ssh "$HOTE" "cd ~/$DEST 2>/dev/null && [ -d moteur ] && find moteur -type f -name '*.py' -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1" || true
}
AVANT="$(empreinte_moteur)"

ssh "$HOTE" "mkdir -p ~/$DEST/ui ~/.local/bin ~/.local/share/applications ~/.config/systemd/user"
EXCLURE=(--exclude '*.bak*' --exclude '__pycache__/' --exclude '*.pyc' --exclude '.DS_Store')
rsync -a --delete "${EXCLURE[@]}" --exclude '/ui/' "$LINUX/" "$HOTE:$DEST/"
rsync -a --delete "${EXCLURE[@]}" "$UI/" "$HOTE:$DEST/ui/"

APRES="$(empreinte_moteur)"

ssh "$HOTE" bash -s -- "$DEST" "$AVANT" "$APRES" <<'DISTANT'
set -uo pipefail
DEST="$HOME/$1"; AVANT="$2"; APRES="$3"
avertir() { printf 'deployer (victus) : %s\n' "$*" >&2; }

# Commande ultron-terminal
if [ -f "$DEST/bin/ultron-terminal" ]; then
  chmod +x "$DEST/bin/ultron-terminal"
  ln -sfn "$DEST/bin/ultron-terminal" "$HOME/.local/bin/ultron-terminal"
else
  avertir "bin/ultron-terminal absent : lien non créé"
fi
[ -f "$DEST/app/ultron_app.py" ] && chmod +x "$DEST/app/ultron_app.py"

# Service du moteur
UNITE="$DEST/systemd/ultron-moteur.service"
if [ -f "$UNITE" ] && [ -f "$DEST/moteur/ultron_moteur.py" ]; then
  CIBLE="$HOME/.config/systemd/user/ultron-moteur.service"
  UNITE_CHANGEE=0
  cmp -s "$UNITE" "$CIBLE" || { cp "$UNITE" "$CIBLE"; UNITE_CHANGEE=1; }
  systemctl --user daemon-reload
  if systemctl --user is-active --quiet ultron-moteur; then
    if [ "$AVANT" != "$APRES" ] || [ "$UNITE_CHANGEE" = 1 ]; then
      systemctl --user enable ultron-moteur >/dev/null 2>&1
      systemctl --user restart ultron-moteur && echo "moteur redémarré (code changé)"
    else
      systemctl --user enable ultron-moteur >/dev/null 2>&1
      echo "moteur inchangé : pas de redémarrage"
    fi
  else
    systemctl --user enable --now ultron-moteur && echo "moteur démarré"
  fi
  systemctl --user is-active --quiet ultron-moteur || avertir "ultron-moteur ne tourne pas : journalctl --user -u ultron-moteur"
else
  avertir "moteur ou unité systemd absents : service non installé"
fi

# Lanceur GNOME
DESKTOP="$DEST/applications/ultron-terminal.desktop"
if [ -f "$DESKTOP" ]; then
  cp "$DESKTOP" "$HOME/.local/share/applications/ultron-terminal.desktop"
  command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null
  command -v desktop-file-validate >/dev/null && desktop-file-validate "$HOME/.local/share/applications/ultron-terminal.desktop"
else
  avertir "lanceur absent"
fi
exit 0
DISTANT

echo ok
