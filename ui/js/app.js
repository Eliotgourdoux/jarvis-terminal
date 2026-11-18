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
  app.limite = BT.Limite ? new BT.Limite(app) : null;
  // Mode vocal : les mots d'Eliot apparaissent en direct pendant qu'il parle (bt.vocalDirect).
  app.vocalDirect = BT.VocalDirect ? new BT.VocalDirect(app) : null;
  // La mascotte vit dans la marge de gauche, hors du fil : une seule pour toute la session.
  // Scène persistante du mode vocal (```html apercu scene=nom```), figée en haut du fil (js/scene.js).
  app.scene = BT.Scene ? new BT.Scene(app) : null;
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
    // Démon du Victus : prompt de lancement ou ordre de Jarvis, à envoyer par cette page.
    texteAEnvoyer: function (d) {
      var it = d && session.envoyerMessage(String(d.texte || ''), d.source || 'externe');
      if (it) app.defilement.allerEnBas();
      return !!it;
    },
    // Message écrit sur une autre page de la même session (le Mac ou le Victus) : on l'affiche sans le renvoyer.
    utilisateurAilleurs: function (d) {
      var o; try { o = JSON.parse(d && d.ligne); } catch (e) { return false; }
      var c = o && o.message && o.message.content, texte = '', images = [];
      if (typeof c === 'string') texte = c;
      else if (Array.isArray(c)) c.forEach(function (p) {
        if (p && p.type === 'text') texte += (texte ? '\n' : '') + p.text;
        else if (p && p.type === 'image' && p.source && p.source.type === 'base64') images.push('data:' + p.source.media_type + ';base64,' + p.source.data);
      });
      if (BT.CONSIGNE_VOCALE) texte = texte.replace('\n\n' + BT.CONSIGNE_VOCALE, '');
      if (!texte.trim() && !images.length) return false;
      // déjà affiché (rejoué après un rechargement alors que le transcript le contient)
      if (o.uuid && session.items.some(function (i) { return i.genre === 'eliot' && i.uuid === o.uuid; })) return true;
      var src = d.source === 'mac' ? 'le Mac' : d.source === 'victus' ? 'le Victus' : d.source === 'limite' ? 'la reprise automatique' : (d.source || 'externe');
      var it = session._ajouter({ genre: 'eliot', texte: texte, enFile: session.travaille, source: src,
        commande: /^\/[^\s/]/.test(texte), images: images.length ? images : null });
      if (it && o.uuid) it.uuid = o.uuid;
      session._debutTravail();
      app.defilement.allerEnBas();
      return true;
    },
    vocalEtat: function (d) { session.definirVocal(d); },
    fichiers: function (d) { app.interface.recevoirFichiers(d); },
    dictee: function (d) { if (app.interface.recevoirDictee) app.interface.recevoirDictee(d); },
    todo: function (d) { if (BT.todo) BT.todo.recevoir(d); },
    agents: function (l) { if (app.agents) app.agents.recevoir(l); },
    limite: function (d) { session.definirLimite(d); },
    sousProjet: function (d) { if (BT.sousProjetReponse) BT.sousProjetReponse(d); },
    titre: function (t) { if (typeof t === 'string' && t) { session.info.projet = t; app.interface._majNom(t); } },
    vocalDirect: function (d) { if (app.vocalDirect) app.vocalDirect.recevoir(d); },
    vocalEtape: function (d) { if (BT.apercuEtape) BT.apercuEtape(d); },
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
