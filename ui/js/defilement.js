/* Better Terminal For Claude — défilement.
 * Défilement natif du document. Collé en bas tant qu'Eliot ne remonte pas ;
 * pastille « Nouveaux messages » sinon ; sauts entre les messages d'Eliot. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  var SEUIL = 56; // px depuis le bas pour être « collé »

  function Defilement(vue, pastille) {
    this.vue = vue;
    this.pastille = pastille;
    this.colle = true;
    this.nouveau = false;
    var self = this;
    var se = document.getElementById('defile') || document.scrollingElement;
    this.se = se;

    // Pendant que la réponse s'écrit, le fil suit le bas. Le moindre mouvement vers le haut (trackpad compris)
    // le décroche : avant, un petit pas restait sous le seuil et le fil ramenait Eliot en bas à chaque ligne.
    // Le défilement automatique va toujours vers le bas : un mouvement vers le haut vient donc d'Eliot.
    var dernierHaut = se.scrollTop;
    se.addEventListener('scroll', function () {
      var top = se.scrollTop, monte = top < dernierHaut - 0.5;
      dernierHaut = top;
      var d = self.distanceBas();
      if (monte && d > 2) self.colle = false;                       // remonte : on lâche le bas
      else if (d < SEUIL && (!monte || d <= 2)) { self.colle = true; self.nouveau = false; }   // revenu en bas
      else if (!self._auto) self.colle = false;
      self._auto = false;
      self.majPastille();
    }, { passive: true });

    // Intention de remonter : on décroche tout de suite, même si le contenu grandit.
    se.addEventListener('wheel', function (e) {
      if (e.deltaY < 0) self.decrocher(true);
      else if (e.deltaY > 0 && !self.colle && self.distanceBas() < SEUIL) { self.colle = true; self.nouveau = false; self.enBas(); self.majPastille(); }
    }, { passive: true });
    window.addEventListener('keydown', function (e) {
      if (e.target && /^(TEXTAREA|INPUT)$/.test(e.target.nodeName)) return;
      if (e.key === 'PageUp' || e.key === 'Home' || (e.key === 'ArrowUp' && !e.altKey && !e.metaKey)) self.decrocher();
    });

    // Le contenu grandit (deltas, nouveaux blocs, détail ouvert) → on suit si collé.
    if (window.ResizeObserver) {
      new ResizeObserver(function () { if (self.colle) self.enBas(); }).observe(vue.racine);
    }
    vue.on('ajout', function (it) {
      if (!self.colle && !it.historique) { self.nouveau = true; self.majPastille(); }
    });
    vue.on('rendu', function () { if (self.colle) self.enBas(); });

    pastille.addEventListener('click', function () { self.allerEnBas(); });
  }
  BT.Defilement = Defilement;

  Defilement.prototype.distanceBas = function () {
    return this.se.scrollHeight - this.se.scrollTop - this.se.clientHeight;
  };

  /* force : geste explicite vers le haut (molette, trackpad) ; décroche même collé tout en bas,
     tant que le fil peut défiler. */
  Defilement.prototype.decrocher = function (force) {
    var defilable = this.se.scrollHeight - this.se.clientHeight > 2;
    if (this.distanceBas() > 2 || (force && defilable)) { this.colle = false; this.majPastille(); }
  };

  Defilement.prototype.enBas = function () {
    var max = this.se.scrollHeight - this.se.clientHeight;
    if (Math.abs(this.se.scrollTop - max) > 1) { this._auto = true; this.se.scrollTop = max; }
  };

  Defilement.prototype.allerEnBas = function () {
    this.colle = true;
    this.nouveau = false;
    this.enBas();
    this.majPastille();
  };

  Defilement.prototype.majPastille = function () {
    var visible = !this.colle && this.distanceBas() > SEUIL;
    this.pastille.hidden = !visible;
    this.pastille.classList.toggle('nouveau', visible && this.nouveau);
    this.pastille.querySelector('.pastille-texte').textContent = this.nouveau ? 'Nouveaux messages' : 'Revenir en bas';
  };

  /* Haut visible de la zone de défilement (sous la barre). */
  function margeHaut() {
    var d = document.getElementById('defile');
    return (d ? d.getBoundingClientRect().top : 0) + 12;
  }

  Defilement.prototype.allerA = function (n, opts) {
    if (!n) return;
    opts = opts || {};
    var y = n.getBoundingClientRect().top - this.se.getBoundingClientRect().top + this.se.scrollTop - 24;   // 24 : le cadre « repère » (8 px hors du bloc) reste entier
    this.colle = false;
    this.se.scrollTo({ top: Math.max(0, y), behavior: opts.instantane ? 'auto' : 'smooth' });
    if (opts.marquer !== false) {
      n.classList.remove('repere');
      void n.offsetWidth;
      n.classList.add('repere');
      setTimeout(function () { n.classList.remove('repere'); }, 1400);
    }
  };

  /* Message d'Eliot précédent / suivant par rapport au haut de l'écran. */
  Defilement.prototype.eliotPrecedent = function () {
    var ref = margeHaut() - 6, l = this.vue.eliots, cible = null;
    for (var i = l.length - 1; i >= 0; i--) {
      if (l[i].getBoundingClientRect().top < ref) { cible = l[i]; break; }
    }
    if (cible) this.allerA(cible);
    return !!cible;
  };

  Defilement.prototype.eliotSuivant = function () {
    var ref = margeHaut() + 6, l = this.vue.eliots, cible = null;
    for (var i = 0; i < l.length; i++) {
      if (l[i].getBoundingClientRect().top > ref) { cible = l[i]; break; }
    }
    if (cible) this.allerA(cible);
    else this.allerEnBas();
    return !!cible;
  };
})();
