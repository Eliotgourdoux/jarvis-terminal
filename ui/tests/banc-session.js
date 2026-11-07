#!/usr/bin/env node
/* Banc de session.js sans navigateur.
 *   node ui/tests/banc-session.js       (code de sortie 1 si un contrôle échoue)
 * 1. Rejoue chaque enregistrement de fixtures/ et résume ce qu'il produit (non-régression).
 * 2. Scénarios du mode vocal : résumé de fin de tour, questions lues, réponses dictées,
 *    vocalAnnule, messages dictés, réponses tapées venues de Telegram ou de Beeper. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RACINE = path.join(__dirname, '..', '..');
const ctx = { console, setTimeout, clearTimeout, Date, JSON, Math };
ctx.window = ctx;
ctx.crypto = globalThis.crypto;
vm.createContext(ctx);
for (const f of ['ui/js/commun.js', 'ui/js/vocal-reponses.js', 'ui/js/session.js']) {
  vm.runInContext(fs.readFileSync(path.join(RACINE, f), 'utf8'), ctx, { filename: f });
}
const BT = ctx.BT;
const lire = (nom) => fs.readFileSync(path.join(RACINE, 'fixtures', nom), 'utf8').split('\n').filter((l) => l.trim());
const texteUser = (u) => u.message.content.map((c) => c.text).join('\n');

let ko = 0;
function controle(nom, vrai, detail) {
  if (!vrai) ko++;
  console.log(`${vrai ? ' ok ' : ' KO '} ${nom}${detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

function nouvelleSession(info) {
  const envoyes = [];
  const s = new BT.Session({ envoyer: (t, d) => envoyes.push({ t, d: JSON.parse(JSON.stringify(d)) }) });
  s.definirInfo(Object.assign({ projet: 'Test', cwd: '/tmp', sessionId: 'x', modele: 'sonnet' }, info || {}));
  return { s, envoyes };
}
const vocaux = (env) => env.filter((e) => /^vocal/.test(e.t));
const reponsesClaude = (env) => env.filter((e) => e.t === 'versClaude').map((e) => JSON.parse(e.d.ligne))
  .filter((o) => o.type === 'control_response' && o.response.response && o.response.response.behavior).map((o) => o.response.response);
const messagesUser = (env) => env.filter((e) => e.t === 'versClaude').map((e) => JSON.parse(e.d.ligne)).filter((o) => o.type === 'user');

/* Rejoue un enregistrement ; surQuestion(s) répond (ou pas) à chaque question.
 * Si surQuestion renvoie 'stop', le rejeu s'arrête là (sinon la suite enregistrée fermerait la question). */
function rejouer(nom, s, surQuestion) {
  const users = lire(nom + '.entree.jsonl').map((l) => JSON.parse(l)).filter((o) => o.type === 'user');
  let u = 0;
  if (users[u]) s.envoyerMessage(texteUser(users[u++]));
  const exceptions = [];
  for (const l of lire(nom + '.jsonl')) {
    try {
      s.recevoirLigne(l);
      const d = JSON.parse(l);
      if (d.type === 'result' && users[u]) s.envoyerMessage(texteUser(users[u++]));
      if (d.type === 'control_request' && d.request.subtype === 'can_use_tool' && surQuestion && surQuestion(s) === 'stop') break;
    } catch (e) { exceptions.push(e.message); }
  }
  return exceptions;
}

/* ================= 1. Non-régression : les enregistrements ================= */
console.log('1. Enregistrements rejoués (mode vocal coupé)');
for (const nom of fs.readdirSync(path.join(RACINE, 'fixtures')).filter((f) => f.endsWith('.jsonl') && !f.includes('.entree') && !f.startsWith('transcript'))) {
  const { s, envoyes } = nouvelleSession();
  const exc = rejouer(nom.replace('.jsonl', ''), s, (s2) => {
    const q = s2.questionsEnAttente()[0];
    if (q && q.type === 'questions') s2.repondre(q.id, { reponses: q.questions.map((x) => x.options[0].label) }, 'mac');
    else if (q) s2.repondre(q.id, { decision: 'autoriser' }, 'mac');
  });
  const genres = {};
  s.items.forEach((i) => { genres[i.genre] = (genres[i.genre] || 0) + 1; });
  const outils = s.items.filter((i) => i.genre === 'outil').map((o) => `${o.nom}:${o.statut}`);
  const ansi = s.items.filter((i) => i.genre === 'texte' && /\u001b|━━━/.test(BT.nettoyerTexteClaude(i.texte))).length;
  const etats = envoyes.filter((e) => e.t === 'etat').map((e) => e.d.etat).join('>');
  const reqs = envoyes.filter((e) => e.t === 'versClaude').map((e) => JSON.parse(e.d.ligne)).map((o) => o.type === 'control_request' ? o.request.subtype : o.type).join(',');
  const v = vocaux(envoyes).length;
  if (exc.length || ansi || v) ko++;
  console.log(`${nom.padEnd(28)} état final=${s.etat.padEnd(9)} ${JSON.stringify(genres)}\n   outils=${outils.join(' ')}\n   etats=${etats}\n   stdin=${reqs}${exc.length ? '\n   EXCEPTIONS ' + exc.join(' | ') : ''}${ansi ? '\n   ANSI RESTANT ' + ansi : ''}${v ? '\n   MESSAGES VOCAUX ALORS QUE LE MODE EST COUPÉ : ' + v : ''}`);
}
for (const t of ['transcript-exemple', 'transcript-multi-tours']) {
  const { s } = nouvelleSession();
  s.chargerHistorique(lire(t + '.jsonl'));
  const genres = {}; s.items.forEach((i) => { genres[i.genre] = (genres[i.genre] || 0) + 1; });
  console.log(`${t.padEnd(28)} état=${s.etat} ${JSON.stringify(genres)} eliot=${JSON.stringify(s.messagesEliot().map((m) => m.texte.slice(0, 30)))}`);
}

/* ================= 2. Mode vocal ================= */
console.log('\n2. Mode vocal');

// 2.1 Permission lue, réponse « oui » puis refus dicté avec une consigne ; résumés de fin de tour
{
  const { s, envoyes } = nouvelleSession({ projet: 'Better Terminal For Claude' });
  s.definirVocal({ actif: true, etat: 'pret', enLigne: false });
  const dits = ['oui', 'Non, mets plutôt ça dans notes.md.'];
  rejouer('permission', s, (s2) => {
    const v = vocaux(envoyes).filter((e) => e.t === 'vocal' && e.d.priorite === 'question').pop();
    s2.transcription({ texte: dits.shift(), questionId: v.d.questionId });
  });
  const q = vocaux(envoyes).filter((e) => e.d.priorite === 'question');
  controle('permission lue avec son identifiant de pont', q.length === 2 && /^q[A-Za-z0-9]{1,16}-p$/.test(q[0].d.questionId), q[0] && q[0].d);
  controle('phrase de la permission', q[0] && q[0].d.texte === 'te demande l’autorisation d’écrire le fichier autorise.txt. Un : Autoriser. Deux : Toujours autoriser. Trois : Refuser.', q[0] && q[0].d.texte);
  const r = reponsesClaude(envoyes);
  controle('« oui » autorise', r[0] && r[0].behavior === 'allow' && !r[0].updatedPermissions, r[0] && r[0].behavior);
  controle('refus dicté avec consigne', r[1] && r[1].behavior === 'deny' && r[1].message === 'Mets plutôt ça dans notes.md', r[1]);
  const fins = vocaux(envoyes).filter((e) => e.d.priorite === 'fin').map((e) => e.d.texte);
  controle('résumé ✅ dit en fin de tour', fins[0] === 'Fichier autorise.txt créé avec le contenu « ok » dans le dossier courant.', fins[0]);
  controle('second résumé', fins[1] === 'La création de refuse.txt a été refusée, rien n’a été écrit.' || fins[1] === "La création de refuse.txt a été refusée, rien n'a été écrit.", fins[1]);
  const ann = vocaux(envoyes).filter((e) => e.t === 'vocalAnnule').map((e) => e.d.questionId);
  controle('vocalAnnule à la clôture de chaque permission', ann.length === 2 && ann[0] === q[0].d.questionId, ann);
  const qi = s.items.filter((i) => i.genre === 'question');
  controle('source « vocal » sur les questions répondues', qi.every((x) => x.source === 'vocal'), qi.map((x) => x.source));
}

// 2.2 Deux sous-questions (choix et cases à cocher), une réponse incomprise puis comprise
{
  const { s, envoyes } = nouvelleSession();
  s.definirVocal({ actif: true });
  let ids = [];
  rejouer('question', s, () => {
    ids = vocaux(envoyes).filter((e) => e.d.priorite === 'question').map((e) => e.d.questionId);
    s.transcription({ texte: 'cinq', questionId: ids[0] });
    s.transcription({ texte: 'Un kiwi.', questionId: ids[0] });
    s.transcription({ texte: 'Rouge et vert', questionId: ids[1] });
  });
  const q = vocaux(envoyes).filter((e) => e.d.priorite === 'question');
  controle('deux sous-questions lues', ids.length === 2 && q[0].d.texte === 'te demande : Quel fruit préférez-vous ? Un : Pomme. Deux : Poire. Trois : Kiwi.' &&
    q[1].d.texte === 'te demande aussi : Quelles couleurs aimez-vous ? Plusieurs choix possibles. Un : Rouge. Deux : Vert. Trois : Bleu.', q.slice(0, 2).map((x) => x.d.texte));
  controle('« cinq » : redemande', q[2] && q[2].d.questionId === ids[0] && q[2].d.texte.startsWith("Je n'ai pas compris, réponds par un numéro.") , q[2] && q[2].d.texte);
  const r = reponsesClaude(envoyes)[0];
  const a = r && r.updatedInput && r.updatedInput.answers;
  controle('réponses envoyées à Claude', a && a['Quel fruit préférez-vous ?'] === 'Kiwi' && a['Quelles couleurs aimez-vous ?'] === 'Rouge, Vert', a);
  controle('toolUseID présent', r && !!r.toolUseID, r && r.toolUseID);
  const ann = vocaux(envoyes).filter((e) => e.t === 'vocalAnnule').map((e) => e.d.questionId);
  controle('vocalAnnule pour les deux sous-questions', ann.length === 2 && ann.indexOf(ids[0]) >= 0 && ann.indexOf(ids[1]) >= 0, ann);
}

// 2.3 Réponse par un clic sur le Mac : la question sort de la file vocale
{
  const { s, envoyes } = nouvelleSession();
  s.definirVocal({ actif: true });
  let id = null, annAvant = 0;
  rejouer('question-variantes', s, (s2) => {
    const q = s2.questionsEnAttente()[0];
    if (!id) {
      id = vocaux(envoyes).filter((e) => e.d.priorite === 'question').pop().d.questionId;
      annAvant = vocaux(envoyes).filter((e) => e.t === 'vocalAnnule').length;
    }
    if (q.type === 'questions') s2.repondre(q.id, { reponses: [q.questions[0].options[1].label] }, 'mac');
    else s2.repondre(q.id, { decision: 'autoriser' }, 'mac');
  });
  const ann = vocaux(envoyes).filter((e) => e.t === 'vocalAnnule');
  controle('clic sur le Mac → vocalAnnule', annAvant === 0 && ann.length >= 1 && ann[0].d.questionId === id, ann.map((e) => e.d.questionId));
}

// 2.4 Message dicté sans question : envoyé à Claude avec la source « vocal » ; parasites ignorés
{
  const { s, envoyes } = nouvelleSession({ projet: 'Cockpit' });
  s.definirVocal({ actif: true });
  const it = s.transcription({ texte: 'Cockpit, lance les tests.' });
  const rien = s.transcription({ texte: 'Sous-titres réalisés par la communauté d’Amara.org' });
  const u = messagesUser(envoyes);
  controle('message dicté envoyé (nom du projet retiré)', it && it.source === 'vocal' && u.length === 1 && u[0].message.content[0].text === 'lance les tests.', u.map((x) => x.message.content[0].text));
  controle('hallucination de whisper ignorée', rien === false && u.length === 1);
}

// 2.5 Mode coupé : aucun message vocal ; activation avec une question ouverte : elle est lue
{
  const { s, envoyes } = nouvelleSession();
  rejouer('question', s, () => 'stop');
  controle('mode coupé : rien n’est envoyé à la voix', vocaux(envoyes).length === 0);
  s.definirVocal({ actif: true });
  const q = vocaux(envoyes).filter((e) => e.d.priorite === 'question');
  controle('activation : la question ouverte est lue', q.length === 2, q.map((e) => e.d.questionId));
  s.definirVocal({ actif: true, etat: 'parle', enLigne: true });
  controle('pas de seconde annonce tant que le mode reste actif', vocaux(envoyes).filter((e) => e.d.priorite === 'question').length === 2);
}

// 2.6 Trois réponses incomprises : Jarvis abandonne, la question reste ouverte
{
  const { s, envoyes } = nouvelleSession();
  s.definirVocal({ actif: true });
  rejouer('question', s, () => {
    const id = vocaux(envoyes).filter((e) => e.d.priorite === 'question')[0].d.questionId;
    ['euh', 'les deux', 'cinq'].forEach((t) => s.transcription({ texte: t, questionId: id }));
    return 'stop';
  });
  const v = vocaux(envoyes).filter((e) => e.t === 'vocal');
  const der = v[v.length - 1].d;
  controle('3e échec : abandon dit à la voix', der.priorite === 'fin' && /toujours pas compris/.test(der.texte), der.texte);
  controle('la question reste ouverte', s.questionsEnAttente().length === 1 && s.etat === 'attend', s.etat);
}

// 2.7 Interruption : pas de résumé ; erreur : « Erreur : … »
{
  const { s, envoyes } = nouvelleSession();
  s.definirVocal({ actif: true });
  rejouer('erreur', s);
  const f = vocaux(envoyes).filter((e) => e.d.priorite === 'fin').map((e) => e.d.texte);
  controle('tour en erreur : « Erreur : … »', f.length === 1 && /^Erreur : There's an issue with the selected model/.test(f[0]), f[0]);
  const b = nouvelleSession();
  b.s.definirVocal({ actif: true });
  b.s.envoyerMessage('test');
  b.s.interrompre();
  b.s.recevoirLigne({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null });
  b.s.recevoirLigne({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '' });
  controle('interruption : rien n’est dit', vocaux(b.envoyes).filter((e) => e.d.priorite === 'fin').length === 0);
}

/* ================= 3. Réponses tapées venues de l'extérieur (Telegram, Beeper) ================= */
console.log('\n3. Texte libre venu de Telegram ou de Beeper (même traducteur que la voix)');
{
  const { s, envoyes } = nouvelleSession();
  rejouer('question', s, (s2) => {
    const ids = envoyes.filter((e) => e.t === 'question').map((e) => e.d.id);
    s2.reponseExterne({ id: ids[0], reponse: '3', source: 'telegram' });
    s2.reponseExterne({ id: ids[1], reponse: 'rouge et bleu', source: 'telegram' });
  });
  const a = reponsesClaude(envoyes)[0].updatedInput.answers;
  controle('« 3 » et « rouge et bleu » → Kiwi ; Rouge, Bleu', a['Quel fruit préférez-vous ?'] === 'Kiwi' && a['Quelles couleurs aimez-vous ?'] === 'Rouge, Bleu', a);
}
{
  const { s, envoyes } = nouvelleSession();
  let n = 0;
  rejouer('question-variantes', s, (s2) => {
    const id = envoyes.filter((e) => e.t === 'question').pop().d.id;
    s2.reponseExterne({ id, reponse: n++ === 0 ? 'Poire' : 'les deux', source: 'telegram' });
  });
  const r = reponsesClaude(envoyes).map((x) => x.updatedInput && x.updatedInput.answers && Object.values(x.updatedInput.answers)[0]);
  controle('« Poire » → Poire ; « les deux » (ambigu) gardé tel quel', r[0] === 'Poire' && r[1] === 'les deux', r);
}
{
  const { s, envoyes } = nouvelleSession();
  const tapes = ['oui', 'non, pas ce fichier'];
  rejouer('permission', s, (s2) => {
    const id = envoyes.filter((e) => e.t === 'question').pop().d.id;
    s2.reponseExterne({ id, reponse: tapes.shift(), source: 'telegram' });
  });
  const r = reponsesClaude(envoyes);
  controle('permission : « oui » → autoriser', r[0] && r[0].behavior === 'allow', r[0] && r[0].behavior);
  controle('permission : « non, pas ce fichier » → refus avec consigne', r[1] && r[1].behavior === 'deny' && r[1].message === 'Pas ce fichier', r[1]);
}
{
  const { s, envoyes } = nouvelleSession();
  let etapes = [];
  rejouer('permission', s, (s2) => {
    const id = envoyes.filter((e) => e.t === 'question').pop().d.id;
    if (etapes.length) return s2.reponseExterne({ id, reponse: ['Autoriser'], source: 'telegram' });
    s2.reponseExterne({ id, reponse: '4', source: 'telegram' });
    etapes.push(s2.questionsEnAttente().length);
    s2.reponseExterne({ id, reponse: 'deux', source: 'telegram' });
    etapes.push(reponsesClaude(envoyes)[0]);
  });
  controle('« 4 » pour trois options : la question reste ouverte', etapes[0] === 1 && s.items.some((i) => i.genre === 'note' && /non comprise/.test(i.texte)), etapes[0]);
  controle('« deux » → Toujours autoriser', etapes[1] && etapes[1].behavior === 'allow' && Array.isArray(etapes[1].updatedPermissions), etapes[1] && etapes[1].behavior);
  controle('préciser (texte sans oui ni non) → refus avec ce texte', (() => {
    const b = nouvelleSession();
    let ok = false;
    rejouer('permission', b.s, (s2) => {
      const id = b.envoyes.filter((e) => e.t === 'question').pop().d.id;
      s2.reponseExterne({ id, reponse: 'Écris-le plutôt dans /tmp', source: 'telegram' });
      const r = reponsesClaude(b.envoyes).pop();
      ok = ok || (r.behavior === 'deny' && r.message === 'Écris-le plutôt dans /tmp');
    });
    return ok;
  })());
}

console.log(ko ? `\n${ko} contrôle(s) en échec.` : '\nTout passe.');
process.exit(ko ? 1 : 0);
