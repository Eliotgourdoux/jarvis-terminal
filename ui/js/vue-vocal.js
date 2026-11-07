/* Better Terminal For Claude — mode vocal « Jarvis » dans la fenêtre de session :
 * bouton « Mode Jarvis » (marche / arrêt) et indicateur discret de l'état du micro et de la voix.
 * Mains libres (08/11/2026) : une fois le mode lancé, Eliot parle quand il veut ; c'est le seul retour visuel
 * (pas de panneau). Le témoin du bouton : vert = Jarvis écoute, violet = il t'entend, ambre = micro en panne.
 * Toute la logique est dans session.js (definirVocal, basculerVocal) ; ici, seulement le rendu. Les champs
 * que session.js ne garde pas (mainsLibres, ecouteOuverte, erreur) sont lus au passage de bt.vocalEtat. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var NS = 'http://www.w3.org/2000/svg';

  /* Icônes au trait, dessinées en SVG par le DOM (aucun innerHTML). */
  var DESSINS = {
    micro: ['M8 1.7a2.3 2.3 0 0 1 2.3 2.3v3.5a2.3 2.3 0 0 1-4.6 0V4A2.3 2.3 0 0 1 8 1.7z', 'M3.6 7.3a4.4 4.4 0 0 0 8.8 0', 'M8 11.8v2.5', 'M5.9 14.3h4.2'],
    voix: ['M2.3 6.1h2.4L7.9 3.4v9.2L4.7 9.9H2.3z', 'M10.4 5.7a3.1 3.1 0 0 1 0 4.6', 'M12.3 3.9a5.7 5.7 0 0 1 0 8.2'],
    copier: ['M7 6h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z', 'M3 10V4a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1'],
    modifier: ['M10.8 2.8l2.4 2.4-7.4 7.4-3.1.7.7-3.1z', 'M9.4 4.2l2.4 2.4'],
    renvoyer: ['M13 8a5 5 0 1 1-1.5-3.6', 'M11.8 1.9v2.7H9.1'],
    fait: ['M3.5 8.4l3 3 6-6.6']
  };
  BT.icone = function (nom, classe) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'icone' + (classe ? ' ' + classe : ''));
    (DESSINS[nom] || []).forEach(function (d) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  };

  function $(id) { return document.getElementById(id); }

  // [quand c'est cette session, quand Jarvis s'occupe d'une autre]
  var TEXTES = {
    parle: ['Jarvis parle', 'Jarvis parle · autre session'],
    ecoute: ['Jarvis t’écoute', 'Jarvis écoute · autre session'],
    transcription: ['Transcription…', 'Transcription · autre session'],
    pret: ['Jarvis · cette session', '']
  };

  function VueVocal(app) {
    var self = this;
    this.s = app.session;
    this.bouton = $('bt-jarvis');
    this.indic = $('barre-vocal');
    this.texte = $('barre-vocal-texte');
    this.icone = $('barre-vocal-icone');
    this.bouton.insertBefore(BT.icone('micro', 'icone-micro'), this.bouton.firstChild);
    this.bouton.addEventListener('click', function () { self.s.basculerVocal(); });
    this.extra = {};
    var definir = this.s.definirVocal;
    this.s.definirVocal = function (d) {
      d = d || {};
      self.extra = { mainsLibres: d.mainsLibres !== false, ecouteOuverte: !!d.ecouteOuverte, erreur: d.erreur || '' };
      return definir.apply(this, arguments);
    };
    this.s.on('vocal', function () { self.maj(); });
    this.maj();
  }
  BT.VueVocal = VueVocal;

  VueVocal.prototype.maj = function () {
    var v = this.s.vocal || {};
    var x = v.actif ? this.extra : {};
    var b = this.bouton;
    b.classList.toggle('vocal-actif', !!v.actif);
    b.setAttribute('aria-pressed', v.actif ? 'true' : 'false');
    b.dataset.etat = !v.actif ? 'inactif' : x.erreur ? 'erreur' : v.etat === 'ecoute' ? 'entend' : v.etat;
    b.title = !v.actif
      ? 'Mode Jarvis : tu parles, Jarvis te répond à la voix.'
      : x.erreur ? x.erreur + ' Clique pour couper le mode Jarvis.'
      : x.mainsLibres
        ? 'Mode Jarvis activé : parle quand tu veux, Jarvis te répond à la voix. Clique pour le couper.'
        : 'Mode Jarvis activé : maintiens ' + (v.raccourci || '⌥Espace') + ' pour parler. Clique pour le couper.';

    var t = v.actif ? TEXTES[v.etat] : null;
    var txt = t ? t[v.enLigne ? 0 : 1] : '';
    var erreur = !txt && x.erreur;
    if (erreur) txt = /^Micro refusé/.test(x.erreur) ? 'Micro refusé' : x.erreur.length > 48 ? x.erreur.slice(0, 47) + '…' : x.erreur;
    this.indic.hidden = !txt;
    document.body.dataset.vocal = v.actif ? v.etat + (v.enLigne ? '-ici' : '') : 'inactif';
    if (!txt) return;
    this.indic.className = 'barre-vocal etat-' + (erreur ? 'erreur' : v.etat) + (v.enLigne && !erreur ? ' en-ligne' : '');
    this.texte.textContent = txt;
    var nom = v.etat === 'parle' && !erreur ? 'voix' : 'micro';
    if (this.icone.dataset.nom !== nom) {
      this.icone.replaceChildren(BT.icone(nom));
      this.icone.dataset.nom = nom;
    }
    this.indic.title = erreur ? x.erreur
      : !v.enLigne ? 'Jarvis s’occupe d’une autre session.'
      : v.etat === 'parle' ? 'Jarvis lit ce que cette session a à te dire.'
      : 'Ta réponse dictée ira à cette session.';
  };
})();
