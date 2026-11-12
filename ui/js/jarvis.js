/* Better Terminal For Claude — panneau du mode vocal « Jarvis » (jarvis.html). Depuis le 08/11/2026, c'est un
 * panneau de diagnostic : il ne s'ouvre que par le menu Vocal → Afficher le panneau Jarvis.
 *
 * Swift → panneau : jarvis.maj({ actif, etat: 'inactif'|'pret'|'ecoute'|'transcription'|'parle', niveau (0 à 1),
 *                                enLigne: { sessionId, projet, emoji, texte } | null,
 *                                file: [{ sessionId, projet, emoji, texte, priorite: 'question'|'fin' }], raccourci?, mainsLibres? })
 *   (aussi joignable en bt.maj, pour la même mécanique d'appel que la fenêtre de session)
 *   Un appel peut ne contenir qu'une partie des champs (par exemple { niveau } pendant l'écoute).
 * Panneau → Swift : window.webkit.messageHandlers.bt.postMessage({ type: 'passer'|'rejouer'|'couper'|'modeVocal', actif? })
 *   et { type: 'pret' } une fois chargé.
 * Tout texte passe par textContent. Aucune animation en boucle : la jauge suit seulement les valeurs reçues. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var NS = 'http://www.w3.org/2000/svg';
  var N_SEGMENTS = 24;

  var DESSINS = {
    micro: ['M8 1.7a2.3 2.3 0 0 1 2.3 2.3v3.5a2.3 2.3 0 0 1-4.6 0V4A2.3 2.3 0 0 1 8 1.7z', 'M3.6 7.3a4.4 4.4 0 0 0 8.8 0', 'M8 11.8v2.5', 'M5.9 14.3h4.2'],
    microCoupe: ['M8 1.7a2.3 2.3 0 0 1 2.3 2.3v3.5a2.3 2.3 0 0 1-4.6 0V4A2.3 2.3 0 0 1 8 1.7z', 'M3.6 7.3a4.4 4.4 0 0 0 8.8 0', 'M8 11.8v2.5', 'M2.6 2.6l10.8 10.8'],
    voix: ['M2.3 6.1h2.4L7.9 3.4v9.2L4.7 9.9H2.3z', 'M10.4 5.7a3.1 3.1 0 0 1 0 4.6', 'M12.3 3.9a5.7 5.7 0 0 1 0 8.2'],
    texte: ['M3 4h10', 'M3 8h10', 'M3 12h6'],
    passer: ['M3 3.5l6 4.5-6 4.5z', 'M12.5 3.5v9'],
    rejouer: ['M3.2 8a4.8 4.8 0 1 0 1.5-3.5', 'M3 2.6v3h3'],
    couper: ['M4.2 4.2h7.6v7.6H4.2z']
  };
  function icone(nom) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'icone');
    (DESSINS[nom] || []).forEach(function (d) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }
  function $(id) { return document.getElementById(id); }
  function el(tag, classe, texte) {
    var n = document.createElement(tag);
    if (classe) n.className = classe;
    if (texte != null) n.textContent = String(texte);
    return n;
  }

  function natif() { return window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bt; }
  function envoyer(type, extra) {
    var m = { type: type };
    if (extra) for (var k in extra) m[k] = extra[k];
    var h = natif();
    if (h) { try { h.postMessage(m); } catch (e) { console.error('[Jarvis] pont', e); } return; }
    if (BT.fauxJarvis) { setTimeout(function () { BT.fauxJarvis.recevoir(m); }, 0); return; }
    console.log('[Jarvis] → Swift', m);
  }

  var etat = { actif: false, etat: 'inactif', niveau: 0, enLigne: null, file: [], raccourci: '', mainsLibres: true };
  var cleEnLigne = null, cleFile = null;

  /* ---------- Jauge : 24 segments, dégradé or (charte marbre) ---------- */
  var segments = [];
  (function () {
    var j = $('pj-jauge');
    var A = [142, 110, 51], B = [201, 164, 92], C = [227, 200, 135];   // charte marbre : or foncé → or → or clair
    for (var i = 0; i < N_SEGMENTS; i++) {
      var t = i / (N_SEGMENTS - 1), c;
      if (t < 0.5) c = A.map(function (a, k) { return Math.round(a + (B[k] - a) * t * 2); });
      else c = B.map(function (b, k) { return Math.round(b + (C[k] - b) * (t - 0.5) * 2); });
      var s = el('i');
      s.style.setProperty('--c', 'rgb(' + c.join(',') + ')');
      j.appendChild(s);
      segments.push(s);
    }
  })();
  var allumes = -1;
  function majJauge() {
    var n = etat.actif && etat.etat === 'ecoute' ? Math.round(Math.max(0, Math.min(1, +etat.niveau || 0)) * N_SEGMENTS) : 0;
    if (n === allumes) return;
    allumes = n;
    for (var i = 0; i < N_SEGMENTS; i++) segments[i].classList.toggle('on', i < n);
  }

  /* ---------- Rendu ---------- */
  var ETATS = {
    inactif: ['Mode Jarvis coupé', 'microCoupe'],
    pret: ['Prêt', 'micro'],
    ecoute: ['Je t’écoute', 'micro'],
    transcription: ['Transcription…', 'texte'],
    parle: ['Je parle', 'voix']
  };

  function nomSession(s) { return (s && (s.projet || s.sessionId)) || 'Session'; }

  /* Texte affiché : sans le nom du projet ni « te demande : », déjà montrés à côté. */
  function texteAffiche(x) {
    var t = String((x && x.texte) || '').trim();
    var p = x && x.projet ? String(x.projet) : '';
    if (p && t.toLowerCase().indexOf(p.toLowerCase()) === 0) t = t.slice(p.length).replace(/^\s*[:,]?\s*/, '');
    t = t.replace(/^te demande (?:aussi )?:\s*/i, '').replace(/^te demande l[’']autorisation\s+/i, 'Autorisation ');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function rendre() {
    var e = etat.actif ? (ETATS[etat.etat] ? etat.etat : 'pret') : 'inactif';
    var p = $('panneau');
    p.className = 'panneau etat-' + e;

    var mode = $('pj-mode');
    mode.classList.toggle('on', etat.actif);
    mode.setAttribute('aria-pressed', etat.actif ? 'true' : 'false');
    $('pj-mode-libelle').textContent = etat.actif ? 'Activé' : 'Coupé';
    mode.title = etat.actif ? 'Couper le mode Jarvis : rien ne parle, rien n’écoute' : 'Activer le mode Jarvis';

    var past = $('pj-pastille');
    if (past.dataset.icone !== ETATS[e][1]) { past.replaceChildren(icone(ETATS[e][1])); past.dataset.icone = ETATS[e][1]; }
    $('pj-etat').textContent = ETATS[e][0];
    var l = etat.enLigne;
    var aide;
    if (e === 'inactif') aide = 'Rien ne parle, rien n’écoute.';
    else if (e === 'pret') aide = etat.mainsLibres ? 'Parle quand tu veux.' : etat.raccourci ? 'Maintiens ' + etat.raccourci + ' pour parler.' : 'En attente de ta voix ou d’une session.';
    else if (e === 'ecoute') aide = etat.mainsLibres ? 'Je t’écoute : une seconde de silence et j’envoie.' : 'Relâche pour envoyer.';
    else if (e === 'transcription') aide = 'Je transcris ta phrase.';
    else aide = etat.raccourci ? 'Maintiens ' + etat.raccourci + ' pour me couper.' : (l ? nomSession(l) : '');
    $('pj-aide').textContent = aide;
    majJauge();

    // Qui parle (ou à qui ira la réponse)
    var cle = JSON.stringify([e, l]);
    if (cle !== cleEnLigne) {
      cleEnLigne = cle;
      var c = $('pj-enligne');
      c.className = 'pj-enligne' + (l ? ' etat-' + e : ' vide');
      $('pj-enligne-titre').textContent = !l ? 'En ce moment'
        : e === 'parle' ? 'En ce moment'
        : e === 'ecoute' || e === 'transcription' ? 'Ta réponse ira à'
        : 'Dernier message';
      $('pj-enligne-emoji').textContent = l && l.emoji ? l.emoji : '';
      $('pj-enligne-emoji').hidden = !(l && l.emoji);
      $('pj-enligne-nom').textContent = l ? nomSession(l) : 'Personne ne parle.';
      $('pj-enligne-texte').textContent = l ? texteAffiche(l) : '';
      $('pj-enligne-texte').hidden = !(l && l.texte);
    }

    // File : les questions d'abord, puis les fins de tâche, dans l'ordre d'arrivée
    var file = (etat.file || []).filter(Boolean);
    file = file.filter(function (x) { return x.priorite === 'question'; }).concat(file.filter(function (x) { return x.priorite !== 'question'; }));
    var cf = JSON.stringify(file);
    if (cf !== cleFile) {
      cleFile = cf;
      $('pj-file-compte').textContent = String(file.length);
      $('pj-file-compte').classList.toggle('zero', !file.length);
      var liste = $('pj-file-liste');
      liste.replaceChildren();
      if (!file.length) liste.appendChild(el('li', 'pj-vide', etat.actif ? 'Rien en attente.' : 'File vide.'));
      file.forEach(function (x) {
        var q = x.priorite === 'question';
        var li = el('li', 'pj-item' + (q ? ' question' : ' fin'));
        li.appendChild(el('span', 'pj-prio', q ? 'Question' : 'Fin'));
        if (x.emoji) li.appendChild(el('span', 'pj-emoji', x.emoji));
        li.appendChild(el('span', 'pj-projet', nomSession(x)));
        li.appendChild(el('span', 'pj-texte', BT.tronquer ? BT.tronquer(texteAffiche(x), 160) : texteAffiche(x)));
        li.title = nomSession(x) + ' : ' + (x.texte || '');
        liste.appendChild(li);
      });
      ajusterFile();
    }

    $('pj-passer').disabled = !etat.actif || (e !== 'parle' && !file.length);
    $('pj-rejouer').disabled = !etat.actif;
    $('pj-couper').disabled = !etat.actif || e !== 'parle';
  }

  /* N'afficher que des lignes entières ; le reste devient « + N autres ». */
  function ajusterFile() {
    var liste = $('pj-file-liste');
    var items = liste.querySelectorAll('.pj-item');
    var plus = liste.querySelector('.pj-plus');
    if (plus) plus.remove();
    for (var i = 0; i < items.length; i++) items[i].hidden = false;
    if (!items.length) return;
    var h = liste.clientHeight;
    if (liste.scrollHeight <= h + 1) return;
    var ligne = items[0].offsetHeight + 4;
    var visibles = Math.max(1, Math.floor((h - ligne) / ligne));
    for (var k = visibles; k < items.length; k++) items[k].hidden = true;
    liste.appendChild(el('li', 'pj-plus', '+ ' + (items.length - visibles) + (items.length - visibles > 1 ? ' autres' : ' autre')));
  }
  if (window.ResizeObserver) new ResizeObserver(function () { ajusterFile(); }).observe($('pj-file-liste'));

  function maj(d) {
    d = d || {};
    ['actif', 'etat', 'niveau', 'enLigne', 'file', 'raccourci', 'mainsLibres'].forEach(function (k) { if (d[k] !== undefined) etat[k] = d[k]; });
    etat.actif = !!etat.actif;
    if (!Array.isArray(etat.file)) etat.file = [];
    // Pendant l'écoute, seule la jauge bouge : pas de rendu complet à chaque valeur du micro.
    var seulNiveau = Object.keys(d).length === 1 && d.niveau !== undefined;
    if (seulNiveau) majJauge(); else rendre();
  }

  window.jarvis = { maj: maj, etat: function () { return JSON.parse(JSON.stringify(etat)); } };
  window.bt = window.bt || {};
  if (!window.bt.maj) window.bt.maj = maj;

  // Boutons (les icônes sont dessinées ici)
  var boutons = document.querySelectorAll('.pj-bouton-icone');
  for (var i = 0; i < boutons.length; i++) boutons[i].appendChild(icone(boutons[i].dataset.icone));
  $('pj-passer').addEventListener('click', function () { envoyer('passer'); });
  $('pj-rejouer').addEventListener('click', function () { envoyer('rejouer'); });
  $('pj-couper').addEventListener('click', function () { envoyer('couper'); });
  $('pj-mode').addEventListener('click', function () {
    var actif = !etat.actif;
    envoyer('modeVocal', { actif: actif });
    // affichage immédiat, la coque confirme par jarvis.maj (mode coupé : elle vide sa file)
    maj(actif ? { actif: true, etat: 'pret' } : { actif: false, etat: 'inactif', enLigne: null, file: [] });
  });
  // Le panneau ne navigue jamais et ne reçoit pas de fichiers.
  ['dragover', 'drop'].forEach(function (t) { window.addEventListener(t, function (ev) { ev.preventDefault(); }); });

  rendre();
  requestAnimationFrame(function () { document.body.classList.add('pret'); });
  setTimeout(function () { document.body.classList.add('pret'); }, 400);
  envoyer('pret');
})();

/* Taille du panneau : la coque ajuste sa fenêtre à la hauteur réelle du contenu (07/11/2026). */
(function () {
  var p = document.getElementById('panneau');
  if (!p || !window.ResizeObserver) return;
  var derniere = 0;
  new ResizeObserver(function () {
    var h = Math.ceil(p.scrollHeight);
    if (Math.abs(h - derniere) < 2) return;
    derniere = h;
    var bt = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bt;
    if (bt) { try { bt.postMessage({ type: 'taille', largeur: 340, hauteur: Math.max(60, Math.min(900, h)) }); } catch (e) {} }
  }).observe(p);
})();
