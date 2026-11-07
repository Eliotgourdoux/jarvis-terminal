#!/usr/bin/env node
/* Banc du traducteur vocal (ui/js/vocal-reponses.js), sans navigateur.
 *   node ui/tests/banc-vocal.js        (code de sortie 1 si un cas échoue)
 * Chaque cas : phrase dictée (ou tapée dans Telegram / Beeper), question, résultat attendu. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const UI = path.join(__dirname, '..');
const ctx = { console, Date, JSON, Math };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['js/commun.js', 'js/vocal-reponses.js']) vm.runInContext(fs.readFileSync(path.join(UI, f), 'utf8'), ctx, { filename: f });
const V = ctx.BT.vocal;

/* ---------- Questions ---------- */
const FRUITS = { type: 'choix', texte: 'Quel fruit préférez-vous ?', options: [{ label: 'Pomme' }, { label: 'Poire' }, { label: 'Kiwi' }], libre: true };
const COULEURS = { type: 'multi', texte: 'Quelles couleurs aimez-vous ?', options: [{ label: 'Rouge' }, { label: 'Vert' }, { label: 'Bleu' }], libre: true, rang: 1 };
const PERM = { type: 'permission', texte: 'd’écrire le fichier autorise.txt', options: [
  { label: 'Autoriser', decision: 'autoriser' }, { label: 'Toujours autoriser', decision: 'toujours' }, { label: 'Refuser', decision: 'refuser' }] };
const PERM2 = { type: 'permission', texte: 'de lancer la commande npm test', options: [
  { label: 'Autoriser', decision: 'autoriser' }, { label: 'Refuser', decision: 'refuser' }] };
const PLAN = { type: 'plan', options: [{ label: 'Approuver le plan', decision: 'autoriser' }, { label: 'Continuer à planifier', decision: 'refuser' }] };
const MODELES = { type: 'choix', texte: 'Quel modèle ?', options: [{ label: 'Opus (recommandé)' }, { label: 'Sonnet' }, { label: 'Haiku' }], libre: true };
const MODES = { type: 'choix', texte: 'Quel thème ?', options: [{ label: 'Mode clair' }, { label: 'Mode sombre' }], libre: true };
const DUREES = { type: 'choix', texte: 'Combien de temps ?', options: [{ label: 'Deux heures' }, { label: 'Une heure' }], libre: true };
const EFFORTS = { type: 'choix', texte: 'Quel effort ?', options: [{ label: 'Faible' }, { label: 'Moyen' }, { label: 'Élevé' }], libre: true };
const FERME = { type: 'choix', texte: 'Lequel ?', options: [{ label: 'Pomme' }, { label: 'Poire' }], libre: false };

/* Attendu : liste de libellés (choix), { libre }, { decision, message? }, ou { echec } */
const CAS = [
  // Numéros, en lettres et en chiffres
  ['un', FRUITS, ['Pomme']],
  ['Une.', FRUITS, ['Pomme']],
  ['1', FRUITS, ['Pomme']],
  ['Le premier.', FRUITS, ['Pomme']],
  ['La deux', FRUITS, ['Poire']],
  ['Deuxième.', FRUITS, ['Poire']],
  ['3', FRUITS, ['Kiwi']],
  ['La 3e.', FRUITS, ['Kiwi']],
  ['La troisième option, s’il te plaît.', FRUITS, ['Kiwi']],
  ['Numéro deux', FRUITS, ['Poire']],
  ['Le dernier', FRUITS, ['Kiwi']],
  ['Je préfère la deuxième parce que c’est mieux.', FRUITS, ['Poire']],
  // Libellés exacts ou approchés
  ['Poire', FRUITS, ['Poire']],
  ['poires', FRUITS, ['Poire']],
  ['Je veux la poire.', FRUITS, ['Poire']],
  ['Une pomme.', FRUITS, ['Pomme']],                 // « une » article, pas le numéro 1
  ['Un kiwi', FRUITS, ['Kiwi']],                     // « un » article, sinon ce serait Pomme
  ['élevé', EFFORTS, ['Élevé']],
  ['Élever', EFFORTS, ['Élevé']],                    // faute de transcription
  ['Moyen.', EFFORTS, ['Moyen']],
  ['Opus', MODELES, ['Opus (recommandé)']],          // libellé partiel, mot propre à l'option
  ['sombre', MODES, ['Mode sombre']],
  ['deux', DUREES, ['Une heure']],                   // le numéro deux, pas « Deux heures »
  ['deux heures', DUREES, ['Deux heures']],
  // Ambigu, hors limite, vide
  ['cinq', FRUITS, { echec: 'hors-limite' }],
  ['les deux', FRUITS, { echec: 'ambigu' }],
  ['Pomme ou poire', FRUITS, { echec: 'ambigu' }],
  ['mode', MODES, { echec: 'ambigu' }],
  ['J’en mange deux par jour', FRUITS, { echec: 'ambigu' }],
  ['Euh…', FRUITS, { echec: 'vide' }],
  ['Sous-titres réalisés par la communauté d’Amara.org', FRUITS, { echec: 'vide' }],
  ['Oui.', FRUITS, { echec: 'incompris' }],
  ['Je préfère la mangue', FERME, { echec: 'incompris' }],
  // Correction en cours de phrase
  ['La deux… non, la trois.', FRUITS, ['Kiwi']],
  ['Poire, enfin plutôt kiwi', FRUITS, ['Kiwi']],
  // Texte libre accepté
  ['Je préfère la mangue', FRUITS, { libre: 'Je préfère la mangue' }],
  ['Autre réponse : la mangue.', FRUITS, { libre: 'la mangue' }],
  ['Comme tu veux.', FRUITS, { libre: 'Comme tu veux' }],   // « comme » n'est pas « Pomme »
  // Cases à cocher
  ['Rouge et vert', COULEURS, ['Rouge', 'Vert']],
  ['rouge et bleu', COULEURS, ['Rouge', 'Bleu']],
  ['Les deux premiers', COULEURS, ['Rouge', 'Vert']],
  ['les deux derniers', COULEURS, ['Vert', 'Bleu']],
  ['Un et trois', COULEURS, ['Rouge', 'Bleu']],
  ['1, 3', COULEURS, ['Rouge', 'Bleu']],
  ['Tous', COULEURS, ['Rouge', 'Vert', 'Bleu']],
  ['Toutes sauf le bleu', COULEURS, ['Rouge', 'Vert']],
  ['De un à trois', COULEURS, ['Rouge', 'Vert', 'Bleu']],
  ['Le premier et le dernier', COULEURS, ['Rouge', 'Bleu']],
  ['Rouge, vert, non, juste vert', COULEURS, ['Vert']],
  ['les deux', COULEURS, { echec: 'ambigu' }],
  ['Aucune', COULEURS, { libre: 'Aucune' }],
  // Permission : oui / non, numéros, libellés
  ['oui', PERM, { decision: 'autoriser' }],
  ['Vas-y.', PERM, { decision: 'autoriser' }],
  ['Ouais, autorise.', PERM, { decision: 'autoriser' }],
  ['D’accord', PERM, { decision: 'autoriser' }],
  ['Pourquoi pas', PERM, { decision: 'autoriser' }],
  ['un', PERM, { decision: 'autoriser' }],
  ['Non.', PERM, { decision: 'refuser', message: '' }],
  ['Refuse', PERM, { decision: 'refuser', message: '' }],
  ['Non merci', PERM, { decision: 'refuser', message: '' }],
  ['N’autorise pas', PERM, { decision: 'refuser' }],
  ['Ne fais pas ça', PERM, { decision: 'refuser' }],
  ['Non, mets plutôt ça dans notes.md.', PERM, { decision: 'refuser', message: 'Mets plutôt ça dans notes.md' }],
  ['Toujours', PERM, { decision: 'toujours' }],
  ['Oui, toujours autoriser', PERM, { decision: 'toujours' }],
  ['Deux', PERM, { decision: 'toujours' }],
  ['trois', PERM, { decision: 'refuser' }],
  ['Toujours pas.', PERM, { decision: 'refuser', message: '' }],
  ['Oui, enfin non', PERM, { decision: 'refuser' }],
  ['Oui non', PERM, { echec: 'ambigu' }],
  ['Je ne sais pas', PERM, { echec: 'incompris' }],
  ['Attends une seconde', PERM, { echec: 'incompris' }],
  ['deux', PERM2, { decision: 'refuser' }],
  ['toujours', PERM2, { decision: 'autoriser' }],    // « toujours » impossible ici : une seule fois
  ['quatre', PERM2, { echec: 'hors-limite' }],
  // Plan
  ['Approuve le plan', PLAN, { decision: 'autoriser' }],
  ['Continue à planifier', PLAN, { decision: 'refuser', message: '' }],
  ['Non, ajoute une étape de tests', PLAN, { decision: 'refuser', message: 'Ajoute une étape de tests' }],
  // Réponses tapées dans Telegram ou Beeper (même traducteur)
  ['2', FRUITS, ['Poire']],
  ['Kiwi', FRUITS, ['Kiwi']],
  ['OK', PERM2, { decision: 'autoriser' }],
];

function decrire(r) {
  if (!r) return String(r);
  if (!r.ok) return 'échec ' + r.raison;
  if (r.genre === 'choix') return JSON.stringify(r.labels);
  if (r.genre === 'libre') return 'libre « ' + r.texte + ' »';
  return r.decision + (r.message ? ' « ' + r.message + ' »' : '');
}
function conforme(r, att) {
  if (Array.isArray(att)) return r.ok && r.genre === 'choix' && JSON.stringify(r.labels) === JSON.stringify(att);
  if (att.echec) return !r.ok && r.raison === att.echec;
  if (att.libre !== undefined) return r.ok && r.genre === 'libre' && r.texte === att.libre;
  if (att.decision) return r.ok && r.genre === 'decision' && r.decision === att.decision && (att.message === undefined || r.message === att.message);
  return false;
}

let ko = 0;
console.log('Traducteur de réponses (' + CAS.length + ' phrases)');
CAS.forEach(([phrase, spec, att], i) => {
  const r = V.interpreter(phrase, spec);
  const bon = conforme(r, att);
  if (!bon) ko++;
  const q = spec === FRUITS ? 'fruits' : spec === COULEURS ? 'couleurs×' : spec === PERM ? 'permission' : spec === PERM2 ? 'permission2' :
    spec === PLAN ? 'plan' : spec === MODELES ? 'modèles' : spec === MODES ? 'thèmes' : spec === DUREES ? 'durées' : spec === EFFORTS ? 'efforts' : 'fermée';
  console.log(`${bon ? ' ok ' : ' KO '} ${String(i + 1).padStart(2)}  ${('« ' + phrase + ' »').padEnd(56)} ${q.padEnd(12)} → ${decrire(r)}${bon ? '' : '   (attendu ' + JSON.stringify(att) + ')'}`);
});

/* ---------- Résumé de fin de tour ---------- */
const ESC = '\u001b';
const RESUMES = [
  [`${ESC}[1;38;5;166m━━━ Claude ${ESC}[38;5;244m12:07${ESC}[1;38;5;166m ━━━━━━━━${ESC}[0m\n\nLe fichier est créé.\n\n${ESC}[38;5;244m──────────────────────────────${ESC}[39m\n\n${ESC}[1;38;5;29m✅ Fichier autorise.txt créé avec le contenu « ok » dans le dossier courant.${ESC}[0m`,
    'Fichier autorise.txt créé avec le contenu « ok » dans le dossier courant.'],
  ['Tout est en place.\n\n**✅ Fait** : tests `npm test` verts.', 'Fait : tests npm test verts.'],
  ['# Fiche\n\nPour lancer un script Python, ouvre le Terminal. Ensuite tape `python3 script.py`. Enfin, lis la sortie.\n\n```sh\npython3 script.py\n```',
    'Pour lancer un script Python, ouvre le Terminal. Ensuite tape python3 script.py.'],
  ['noté', 'noté'],
  ['Fichier notes.md créé. Rien d’autre à signaler.', 'Fichier notes.md créé. Rien d’autre à signaler.'],
  ['| a | b |\n|---|---|\n| 1 | 2 |\n\nTableau des résultats prêt. Les deux colonnes sont remplies.', 'Tableau des résultats prêt. Les deux colonnes sont remplies.'],
  ['- **Read** du fichier\n- Écriture de [notes.md](https://example.com)', 'Read du fichier. Écriture de notes.md'],
  ['```js\nconsole.log(1)\n```', ''],
  ['', ''],
  ['J’ai relu les quarante-deux fichiers du dossier source, corrigé les imports cassés dans chacun d’eux, relancé la suite complète des tests unitaires et des tests d’intégration, puis vérifié à la main que la page de connexion fonctionnait toujours correctement après tout ça.', null],
];
console.log('\nRésumé de fin de tour');
RESUMES.forEach(([texte, att], i) => {
  const r = V.resumeFin(texte);
  const bon = att === null ? (r.length <= 200 && r.endsWith('…')) : r === att;
  if (!bon) ko++;
  console.log(`${bon ? ' ok ' : ' KO '} ${String(i + 1).padStart(2)}  → « ${r} » (${r.length} car.)${bon ? '' : '   attendu « ' + att + ' »'}`);
});

/* ---------- Phrases de question ---------- */
const PHRASES = [
  [FRUITS, 'te demande : Quel fruit préférez-vous ? Un : Pomme. Deux : Poire. Trois : Kiwi.'],
  [COULEURS, 'te demande aussi : Quelles couleurs aimez-vous ? Plusieurs choix possibles. Un : Rouge. Deux : Vert. Trois : Bleu.'],
  [PERM, 'te demande l’autorisation d’écrire le fichier autorise.txt. Un : Autoriser. Deux : Toujours autoriser. Trois : Refuser.'],
  [PLAN, 'te demande de valider son plan. Un : Approuver le plan. Deux : Continuer à planifier.'],
];
console.log('\nPhrases dites par Jarvis');
PHRASES.forEach(([spec, att], i) => {
  const r = V.phraseQuestion(spec);
  const bon = r === att;
  if (!bon) ko++;
  console.log(`${bon ? ' ok ' : ' KO '} ${String(i + 1).padStart(2)}  « ${r} »${bon ? '' : '\n        attendu « ' + att + ' »'}`);
});
const perm = V.textePermission('Bash', { command: 'npm test -- --watch=false' });
const bonPerm = perm === 'de lancer la commande npm test -- --watch=false';
if (!bonPerm) ko++;
console.log(`${bonPerm ? ' ok ' : ' KO '}  5  textePermission Bash → « ${perm} »`);

const total = CAS.length + RESUMES.length + PHRASES.length + 1;
console.log(`\n${total - ko} sur ${total} cas passent${ko ? ` : ${ko} ÉCHEC(S)` : '.'}`);
process.exit(ko ? 1 : 0);
