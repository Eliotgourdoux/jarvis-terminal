#!/bin/zsh
# Compile « Better Terminal.app » avec swiftc (sans Xcode) dans app/build/.
# Usage : ./build.sh              compile + bundle + signature + enregistrement du schéma betterterminal://
#         ./build.sh --installer  idem, puis copie dans ~/Applications (et c'est cette copie qui est enregistrée)
# Ne tue jamais l'app en cours : ses sessions continuent ; relancez-la pour prendre le nouveau binaire.
set -e
cd "$(dirname "$0")"
ICI="$PWD"
PROJET="${ICI:h}"
VERSION=0.1
NOM="Jarvis Terminal"
EXE=BetterTerminal
ID=local.eliot.betterterminal
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

mkdir -p .build
swiftc -O -swift-version 5 -target arm64-apple-macos14 \
  -framework AppKit -framework WebKit -framework Security -framework AVFoundation -framework CoreMedia -framework Carbon \
  -o .build/$EXE Sources/*.swift

# empreinte du code Swift : relancer.sh ne quitte l'app que si elle a changé depuis le dernier lancement
cat Sources/*.swift | shasum | cut -d' ' -f1 > .build/sources.sha

APP="build/$NOM.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/$EXE "$APP/Contents/MacOS/"

# la page : ui/ du projet (agent C) si elle existe, et toujours la page de test du pont
if [[ -f "$PROJET/ui/index.html" ]]; then
  rsync -a --delete --exclude '.DS_Store' --exclude 'Icon?' "$PROJET/ui/" "$APP/Contents/Resources/ui/"
  echo "ui/ copiée dans le bundle"
else
  echo "ui/index.html absent : l'app utilisera la page de test"
fi
mkdir -p "$APP/Contents/Resources/page-test"
cp page-test/page-test.html page-test/page-test.js page-test/page-test.css \
   page-test/jarvis-test.html page-test/jarvis-test.js page-test/jarvis-test.css "$APP/Contents/Resources/page-test/"

# icône de l'app (app/icone/AppIcon.icns, source : icone/icone.html)
[[ -f icone/AppIcon.icns ]] && cp icone/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NOM</string>
  <key>CFBundleDisplayName</key><string>$NOM</string>
  <key>CFBundleIdentifier</key><string>$ID</string>
  <key>CFBundleExecutable</key><string>$EXE</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSSupportsSuddenTermination</key><false/>
  <key>NSAppleEventsUsageDescription</key><string>Better Terminal ouvre Terminal pour reprendre une session Claude avec claude --resume.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSMicrophoneUsageDescription</key><string>Better Terminal écoute le micro uniquement pendant que vous maintenez le raccourci du mode vocal, pour transcrire sur ce Mac ce que vous dites à vos sessions Claude.</string>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>$ID.session</string>
    <key>CFBundleURLSchemes</key><array><string>betterterminal</string></array>
  </dict></array>
  <key>BTDossierProjet</key><string>$PROJET</string>
</dict></plist>
PLIST

# signature ad hoc « identifier-only » : les autorisations Automatisation (→ Terminal) et Micro survivent
# aux rebuilds (macOS les attache à cette exigence, identique à chaque build, et non au hachage du binaire)
# iCloud/Finder posent des attributs étendus sur le bundle → codesign refuse (« detritus »).
# Le File Provider d'iCloud peut les remettre entre xattr et codesign : jusqu'à 3 essais.
for essai in 1 2 3; do
  xattr -cr "$APP"
  if codesign --force --sign - -r="designated => identifier \"$ID\"" "$APP" 2>/dev/null; then break; fi
  [[ $essai == 3 ]] && { echo "codesign impossible après 3 essais (attributs iCloud)" >&2; exit 1; }
  sleep 0.5
done

if [[ "$1" == "--installer" ]]; then
  DEST=~/Applications/"$NOM.app"
  mkdir -p ~/Applications
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  $LSREGISTER -u "$ICI/$APP" 2>/dev/null || true
  $LSREGISTER -f "$DEST" || true
  echo "OK -> $DEST"
else
  $LSREGISTER -f "$ICI/$APP" || true
  echo "OK -> $ICI/$APP"
fi
