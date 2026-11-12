/* Marque de la machine (victus/CONTRAT-VICTUS.md, « Marque Ultron »).
 * Quand bt.info porte machine:"victus", la page pose body.machine-victus :
 *  - petit encadré « Ultron » dans la barre du haut ;
 *  - bouton « Mode Jarvis » et témoin vocal cachés (pas de vocal sur le Victus) ;
 *  - textes d'interface qui parlent de l'assistant : « Jarvis » → « Ultron » (jamais le texte de Claude) ;
 *  - accent argent au lieu de l'or (css/machine.css).
 * Sans machine (sessions du Mac), rien ne change. Chargé juste après pont.js : enveloppe window.bt.info,
 * sans toucher session.js ni interface.js. Marche aussi dans l'app Mac quand elle affiche une session du Victus. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var NOMS = { victus: 'Ultron' };
  // Seuls ces éléments d'interface sont réécrits ; le fil de Claude n'est jamais modifié.
  var ZONES = '.jarvis-dit-nom, .bulle-meta, .q-vocal-texte, #barre-vocal-texte, .vd-etat, .vd-fantome > .vd-etat';
  var ATTRIBUTS = ['placeholder', 'title', 'aria-label'];
  var machine = null;
  var observateur = null;

  function renommer(s) {
    if (!s || s.indexOf('Jarvis') < 0 || !machine) return s;
    return s.replace(/\bJarvis\b/g, NOMS[machine]);
  }

  function texteDe(n) {
    if (n.nodeType === 3) { var t = renommer(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; return; }
    if (n.nodeType !== 1) return;
    var w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT, null);
    var x;
    while ((x = w.nextNode())) { var v = renommer(x.nodeValue); if (v !== x.nodeValue) x.nodeValue = v; }
  }

  function attributsDe(e) {
    if (!e || e.nodeType !== 1 || e.closest('#fil .tour-claude, #fil .md')) return;
    ATTRIBUTS.forEach(function (a) {
      var v = e.getAttribute(a);
      if (v && v.indexOf('Jarvis') >= 0) e.setAttribute(a, renommer(v));
    });
  }

  function balayer(racine) {
    if (!racine || racine.nodeType !== 1) return;
    if (racine.matches && racine.matches(ZONES)) texteDe(racine);
    racine.querySelectorAll(ZONES).forEach(texteDe);
    attributsDe(racine);
    racine.querySelectorAll('[placeholder], [title], [aria-label]').forEach(attributsDe);
  }

  function observer() {
    if (observateur || !window.MutationObserver) return;
    observateur = new MutationObserver(function (liste) {
      for (var i = 0; i < liste.length; i++) {
        var m = liste[i];
        if (m.type === 'attributes') { attributsDe(m.target); continue; }
        if (m.type === 'characterData') {
          var p = m.target.parentElement;
          if (p && p.closest(ZONES)) texteDe(m.target);
          continue;
        }
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType === 3) { if (n.parentElement && n.parentElement.closest(ZONES)) texteDe(n); }
          else if (n.nodeType === 1) {
            if (n.parentElement && n.parentElement.closest(ZONES)) texteDe(n);
            balayer(n);
          }
        }
      }
    });
    observateur.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTS
    });
  }

  function encadre() {
    var e = document.getElementById('marque-machine');
    if (e) return e;
    var projet = document.querySelector('#barre .barre-projet');
    if (!projet) return null;
    e = document.createElement('span');
    e.id = 'marque-machine';
    e.className = 'marque-machine';
    var nom = document.getElementById('barre-nom');
    projet.insertBefore(e, nom ? nom.nextSibling : null);
    return e;
  }

  function appliquer(info) {
    if (!info || typeof info !== 'object' || !('machine' in info)) return;
    var m = typeof info.machine === 'string' && NOMS[info.machine] ? info.machine : null;
    if (m === machine) return;
    if (machine) document.body.classList.remove('machine-' + machine);
    machine = m;
    BT.machine = m;
    var e = encadre();
    if (!m) { if (e) e.hidden = true; return; }
    document.body.classList.add('machine-' + m);
    if (e) {
      e.hidden = false;
      e.textContent = NOMS[m];
      e.title = 'Session du Victus : Ultron s’en occupe';
    }
    if (/Jarvis/.test(document.title)) document.title = renommer(document.title);
    balayer(document.body);
    observer();
  }

  var bt = window.bt;
  if (bt && typeof bt.info === 'function' && !bt.info.__machine) {
    var origine = bt.info;
    var enveloppe = function (i) {
      try { appliquer(i); } catch (e) { console.error('[BT] machine', e); }
      return origine.apply(this, arguments);
    };
    enveloppe.__machine = true;
    bt.info = enveloppe;
  }
  BT.appliquerMachine = appliquer;
})();
