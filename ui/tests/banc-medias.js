#!/usr/bin/env node
/* Banc de détection du lecteur intégré (js/medias.js), sans navigateur : node ui/tests/banc-medias.js
 * Le rendu réel (schéma btmedia://, plages, lecture) se vérifie dans une WKWebView avec medias-test.html. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ctx = { console };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'medias.js'), 'utf8'), ctx);
const M = ctx.BT.medias;
let ko = 0;
function egal(nom, obtenu, attendu) {
  const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
  if (!ok) ko++;
  console.log(`${ok ? ' ok ' : ' KO '} ${nom}${ok ? '' : '  obtenu ' + JSON.stringify(obtenu) + ' attendu ' + JSON.stringify(attendu)}`);
}
egal('chemin simple', M.dansTexte('Voici /Users/e/Desktop/a.png.'), ['/Users/e/Desktop/a.png']);
egal('plusieurs, ponctuation', M.dansTexte('(/tmp/a.mp4), « /tmp/b.MOV » et ~/c.m4a;'), ['/tmp/a.mp4', '/tmp/b.MOV', '~/c.m4a']);
egal('file://', M.dansTexte('file:///Users/e/a%20b.wav'), ['/Users/e/a b.wav']);
egal('espace échappée', M.dansTexte('/Users/e/mon\\ clip.mp4'), ['/Users/e/mon clip.mp4']);
egal('URL ignorée', M.dansTexte('https://x.fr/a.png //cdn/b.png'), []);
egal('extension non média', M.dansTexte('/tmp/a.svg /tmp/b.pdf /tmp/c.png.txt'), []);
egal('remontée refusée', M.dansTexte('/tmp/../etc/a.png'), []);
egal('milieu de mot', M.dansTexte('abc/tmp/a.png'), []);
egal('normaliser relatif', M.normaliser('captures/a.png'), null);
egal('url fichier', M.url('/Users/e/a b#1.png'), 'btmedia://fichier/Users/e/a%20b%231.png');
egal('url maison', M.url('~/Desktop/é.mp3'), 'btmedia://maison/Desktop/%C3%A9.mp3');
egal('genre', ['a.JPG', 'b.webm', 'c.opus', 'd.txt'].map(M.genre), ['image', 'video', 'audio', null]);
console.log(ko ? `\n${ko} échec(s).` : '\nTout passe.');
process.exit(ko ? 1 : 0);
