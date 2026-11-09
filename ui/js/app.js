/* Better Terminal For Claude — câblage de la page. Chargé en dernier. */
(function () {
  'use strict';
  var BT = window.BT;

  var session = new BT.Session({ envoyer: BT.pont.envoyer });
  var fil = document.getElementById('fil');
  var vue = new BT.VueFil(session, fil);
  var app = BT.app = { session: session, vue: vue };
  app.defilement = new BT.Defilement(vue, document.getElementById('pastille-bas'));
  app.recherche = new BT.Recherche(vue, document.getElementById('recherche'));
  app.interface = new BT.Interface(app);
  app.vocal = new BT.VueVocal(app);
  app.agents = new BT.Agents(app);
  // Mode vocal : les mots d'Eliot apparaissent en direct pendant qu'il parle (bt.vocalDirect).
  app.vocalDirect = BT.VocalDirect ? new BT.VocalDirect(app) : null;
  // La mascotte vit dans la marge de gauche, hors du fil : une seule pour toute la session.
  app.mascotte = new BT.Mascotte(session);
  document.body.appendChild(app.mascotte.el);

  /* Liens et boutons Copier : délégation sur toute la page. La vue ne navigue jamais. */
  document.addEventListener('click', function (e) {
    var copier = e.target.closest && e.target.closest('.bt-copier');
    if (copier) {
      e.preventDefault();
      var bloc = copier.closest('.bloc-code');
      var code = bloc && (bloc.codeComplet || (bloc.querySelector('code') || {}).textContent || '');
      BT.pont.copier(code || '');
      copier.textContent = 'Copié';
      copier.classList.add('fait');
      setTimeout(function () { copier.textContent = 'Copier'; copier.classList.remove('fait'); }, 1300);
      return;
    }
    var a = e.target.closest && e.target.closest('a');
    if (a) {
      e.preventDefault();
      var href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) BT.pont.ouvrirLien(href);
    }
  });
  // Un fichier glissé sur la fenêtre ne doit pas faire naviguer la vue.
  ['dragover', 'drop'].forEach(function (t) { window.addEventListener(t, function (e) { e.preventDefault(); }); });
  window.addEventListener('submit', function (e) { e.preventDefault(); }, true);

  BT.brancherPont({
    info: function (i) { session.definirInfo(i); },
    depuisClaude: function (l) { session.recevoirLigne(l); },
    stderr: function (t) { session.stderr(t); },
    fin: function (d) { session.fin(d); },
    reponseExterne: function (d) { session.reponseExterne(d); },
    historique: function (l) { session.chargerHistorique(l); vue.vider(); app.defilement.allerEnBas(); },
    envoyerTexte: function (texte, opts) {
      var it = session.envoyerMessage(texte, (opts && opts.source) || 'externe');
      if (it) app.defilement.allerEnBas();
      return !!it;
    },
    vocalEtat: function (d) { session.definirVocal(d); },
    fichiers: function (d) { app.interface.recevoirFichiers(d); },
    dictee: function (d) { if (app.interface.recevoirDictee) app.interface.recevoirDictee(d); },
    todo: function (d) { if (BT.todo) BT.todo.recevoir(d); },
    agents: function (l) { if (app.agents) app.agents.recevoir(l); },
    vocalDirect: function (d) { if (app.vocalDirect) app.vocalDirect.recevoir(d); },
    transcription: function (d) {
      // La bulle fantôme des mots en direct cède sa place à la vraie bulle, sans doublon ni saut.
      var direct = app.vocalDirect && app.vocalDirect.avantTranscription(d);
      var r = session.transcription(d);
      if (direct) app.vocalDirect.apresTranscription(direct, r);
      if (r && r.genre === 'eliot') app.defilement.allerEnBas();
      return !!r;
    }
  });

  // L'entrée de la page (une seule, après le premier rendu).
  // (minuteur de secours : fenêtre cachée au chargement, sans requestAnimationFrame)
  function montrer() { document.body.classList.add('pret'); }
  requestAnimationFrame(montrer);
  setTimeout(montrer, 400);
  document.getElementById('saisie-texte').focus({ preventScroll: true });
  BT.pont.envoyer('pret', {});
})();
