/* Better Terminal For Claude — défilement.
 * Défilement natif de #defile. Quand Eliot envoie un message, ce message monte en haut de la zone
 * visible (défilement doux, une seule fois) et la réponse de Claude s'écrit en dessous SANS que la vue
 * bouge : plus de petits sauts à chaque ligne. Un espace réservé sous le fil permet au message de
 * monter même quand la réponse est courte ; il se résorbe dès que le contenu le remplit ou qu'Eliot
 * remonte. Si la réponse dépasse l'écran, la pastille « Revenir en bas » / « Nouveaux messages » suffit.
 * Hors réponse en cours (historique, réouverture, détail ouvert…), le fil reste collé en bas comme avant.
 * Sauts entre les messages d'Eliot. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  var SEUIL = 56;        // px depuis le bas pour être « collé »
  var MARGE_ANCRE = 16;  // px entre le haut de la zone visible et le message épinglé
  var DUREE_DOUX = 1000; // ms au plus pour le défilement doux vers le message

  function mouvementReduit() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function Defilement(vue, pastille) {
    this.vue = vue;
    this.pastille = pastille;
    this.colle = true;
    this.nouveau = false;
    this.ancre = null;       // nœud épinglé en haut (message d'Eliot, ou début d'un tour lancé sans message)
    this._anim = null;       // défilement doux en cours vers l'ancre : { cible, jusqua }
    this._autoTop = null;    // scrollTop posé par le code : le prochain « scroll » à cette hauteur n'est pas d'Eliot
    this._ancreTache = false;
    this._hEspace = 0;
    var self = this;
    var se = document.getElementById('defile') || document.scrollingElement;
    this.se = se;

    // Espace réservé sous le fil (hors de #fil : la recherche et les sauts ne le voient pas).
    if (se && se.id === 'defile') {
      this.espace = document.createElement('div');
      this.espace.className = 'espace-ancre';
      this.espace.setAttribute('aria-hidden', 'true');
      se.appendChild(this.espace);
    } else {
      this.espace = null;
    }

    var dernierHaut = se.scrollTop;
    se.addEventListener('scroll', function () {
      var top = se.scrollTop, monte = top < dernierHaut - 0.5;
      dernierHaut = top;
      var auto = self._autoTop !== null && Math.abs(top - self._autoTop) < 2;
      self._autoTop = null;
      if (self._anim) {
        // Défilement doux vers l'ancre : ces événements viennent de nous.
        if (Math.abs(top - self._anim.cible) < 2 || Date.now() > self._anim.jusqua) self._anim = null;
        self._majEspace();
        self.majPastille();
        return;
      }
      // Tout mouvement qui ne vient pas du code (barre de défilement, recherche, saut…) libère l'ancre.
      if (self.ancre && !auto && Math.abs(top - self._cibleAncre()) > 2) self.ancre = null;
      var d = self.distanceBas();
      if (monte && d > 2) self.colle = false;                       // remonte : on lâche le bas
      else if (d < SEUIL && (!monte || d <= 2)) { self.colle = true; self.nouveau = false; }   // revenu en bas
      else if (!auto) self.colle = false;
      self._majEspace();   // remonter résorbe l'espace réservé devenu inutile
      self.majPastille();
    }, { passive: true });

    // Geste d'Eliot (molette, trackpad) : l'ancre est libérée ; vers le haut, on décroche aussi du bas.
    se.addEventListener('wheel', function (e) {
      self._liberer();
      if (e.deltaY < 0) self.decrocher(true);
      else if (e.deltaY > 0 && !self.colle && self.distanceBas() < SEUIL) { self.colle = true; self.nouveau = false; self.enBas(); self.majPastille(); }
    }, { passive: true });
    se.addEventListener('touchmove', function () { self._liberer(); }, { passive: true });
    window.addEventListener('keydown', function (e) {
      if (e.target && /^(TEXTAREA|INPUT)$/.test(e.target.nodeName)) return;
      if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown| )$/.test(e.key) && !e.metaKey) self._liberer();
      if (e.key === 'PageUp' || e.key === 'Home' || (e.key === 'ArrowUp' && !e.altKey && !e.metaKey)) self.decrocher();
    });

    // Le contenu change de taille (deltas, nouveaux blocs, détail ouvert) ou la fenêtre aussi.
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { self._contenuChange(); });
      ro.observe(vue.racine);
      ro.observe(se);
    }
    vue.on('ajout', function (it, n) { self._ajout(it, n); });
    vue.on('tour', function (carte, it) { self._nouveauTour(carte, it); });
    vue.on('rendu', function () { self._contenuChange(); });
    // Fin du tour : si Eliot est en bas, le fil s'y recolle (sans bouger : l'espace réservé reste).
    if (vue.s && vue.s.on) {
      vue.s.on('etat', function () {
        if (vue.s.travaille) return;
        if (self.distanceBas() < SEUIL) { self.colle = true; self.nouveau = false; }
        self._resorber();
        self.majPastille();
      });
    }

    pastille.addEventListener('click', function () { self.allerEnBas(); });
  }
  BT.Defilement = Defilement;


  /* Une réponse s'écrit : le fil ne suit pas le bas pendant ce temps. */
  Defilement.prototype._enDirect = function () { return !!(this.vue.s && this.vue.s.travaille); };

  /* Position verticale d'un nœud dans le contenu de #defile (sans les transformations d'animation). */
  Defilement.prototype._posY = function (n) {
    var se = this.se, y = 0, p = n;
    while (p && p !== se) {
      y += p.offsetTop;
      var op = p.offsetParent;
      if (!op || (op !== se && !se.contains(op))) { p = null; break; }
      p = op;
    }
    if (p === se) return y;
    return n.getBoundingClientRect().top - se.getBoundingClientRect().top + se.scrollTop;
  };

  /* Hauteur du contenu réel (fil), sans l'espace réservé. */
  Defilement.prototype._hauteurContenu = function () {
    return this.espace ? this._posY(this.espace) : this.se.scrollHeight;
  };

  Defilement.prototype.distanceBas = function () {
    return this._hauteurContenu() - this.se.scrollTop - this.se.clientHeight;
  };

  Defilement.prototype._cibleAncre = function () {
    return this.ancre ? Math.max(0, this._posY(this.ancre) - MARGE_ANCRE) : 0;
  };

  /* Espace réservé = juste ce qu'il faut pour garder la vue actuelle (pas de saut quand le contenu
   * rétrécit) et, s'il y a une ancre, pour qu'elle puisse rester en haut. Jamais plus. */
  Defilement.prototype._majEspace = function (aZero) {
    if (!this.espace || (this._resorbe && !this.ancre && !this._anim)) return;
    var se = this.se, ch = se.clientHeight, H = this._hauteurContenu();
    var besoin = aZero ? 0 : se.scrollTop + ch - H;
    if (this._anim) besoin = Math.max(besoin, this._anim.cible + ch - H);
    if (this.ancre) besoin = Math.max(besoin, this._cibleAncre() + ch - H);
    var h = Math.max(0, Math.ceil(besoin - 0.5));
    // Sans message épinglé, l'espace ne fait que fondre : un contenu qui rétrécit (outil replié, média
    // redimensionné, page rechargée) ne crée plus de vide sous la dernière ligne (12/11/2026).
    if (!this.ancre && !this._anim) h = Math.min(h, this._hEspace);
    if (h !== this._hEspace) { this._hEspace = h; this.espace.style.height = h ? h + 'px' : ''; }
  };

  Defilement.prototype._poser = function (top) {
    if (Math.abs(this.se.scrollTop - top) <= 1) return;
    this._autoTop = top;
    this.se.scrollTop = top;
  };

  /* Monte le nœud n en haut de la zone visible et l'y garde pendant que la réponse s'écrit dessous. */
  Defilement.prototype.ancrer = function (n) {
    if (!n || !n.isConnected) return;
    this.ancre = n;
    this._resorbe = null;
    this.colle = false;
    this.nouveau = false;
    var cible = this._cibleAncre();
    this._anim = null;
    this._majEspace();
    var doux = !mouvementReduit() && !document.hidden && Math.abs(this.se.scrollTop - cible) > 2;
    if (doux) {
      this._anim = { cible: cible, jusqua: Date.now() + DUREE_DOUX };
      this._majEspace();
      this.se.scrollTo({ top: cible, behavior: 'smooth' });
      var self = this, anim = this._anim;
      setTimeout(function () { if (self._anim === anim) { self._anim = null; self._contenuChange(); } }, DUREE_DOUX + 50);
    } else {
      this._poser(cible);
    }
    this.majPastille();
  };

  /* Garde l'ancre à sa place si le contenu au-dessus d'elle change (message ajouté pendant le travail). */
  Defilement.prototype._epingler = function () {
    if (!this.ancre.isConnected) { this.ancre = null; return; }
    this._majEspace();
    this._poser(this._cibleAncre());
  };

  Defilement.prototype._liberer = function () { this.ancre = null; this._anim = null; };

  /* Fin du tour (12/11/2026, Eliot : pas de vide sous la dernière ligne) : l'espace réservé pour garder son
   * message en haut fond en 0,3 s. Le navigateur recale le défilement, le fil glisse doucement vers le bas
   * et la dernière ligne finit juste au-dessus de la saisie. */
  Defilement.prototype._resorber = function () {
    if (!this.espace || !this._hEspace || this._anim) return;
    this.ancre = null;
    var self = this, h0 = this._hEspace, t0 = 0, duree = mouvementReduit() ? 0 : 300;
    var jeton = this._resorbe = {};
    function pas(t) {
      if (self._resorbe !== jeton || self.ancre || self._anim) return;   // nouveau message entre-temps
      if (!t0) t0 = t;
      var k = duree ? Math.min(1, (t - t0) / duree) : 1;
      var h = Math.round(h0 * (1 - (1 - Math.pow(1 - k, 3))));
      self._hEspace = h;
      self.espace.style.height = h ? h + 'px' : '';
      if (k < 1) { requestAnimationFrame(pas); return; }
      self._resorbe = null;
      self.colle = true; self.nouveau = false;
      self.majPastille();
    }
    requestAnimationFrame(pas);
  };

  Defilement.prototype._contenuChange = function () {
    this._majEspace();
    if (this.ancre && !this._anim) this._epingler();
    else if (!this.ancre && this.colle && !this._enDirect()) this.enBas();
    this.majPastille();
  };

  Defilement.prototype._ajout = function (it, n) {
    if (it.historique) return;
    if (it.genre === 'eliot' && n) {
      // Message d'Eliot : il monte en haut. Les appels à allerEnBas() qui suivent l'envoi, dans la même
      // tâche (interface.js, app.js), sont ignorés : c'est cette ancre qui compte.
      this.ancrer(n);
      var self = this;
      this._ancreTache = true;
      Promise.resolve().then(function () { self._ancreTache = false; });
      return;
    }
    // « Nouveaux messages » : un bloc arrive hors de l'écran (la ligne « Terminé » ne compte pas).
    if (n && it.genre !== 'fin' && (this.ancre || !this.colle || this._enDirect()) && this._sousLaVue(n)) this.nouveau = true;
    this.majPastille();
  };

  /* Tour de Claude lancé sans message d'Eliot (tâche de fond, reprise) : son début monte en haut si
   * Eliot était en bas, au lieu de suivre la réponse ligne à ligne. */
  Defilement.prototype._nouveauTour = function (carte, it) {
    if (!it || it.historique || this.ancre) return;
    if (this.colle || this.distanceBas() < SEUIL) this.ancrer(carte);
  };

  Defilement.prototype._sousLaVue = function (n) {
    if (!n.isConnected || n.hidden) return false;
    var pied = document.getElementById('pied');
    var bas = this.se.getBoundingClientRect().bottom - (pied ? pied.offsetHeight : 0);
    return n.getBoundingClientRect().top > bas;
  };

  /* force : geste explicite vers le haut (molette, trackpad) ; décroche même collé tout en bas,
     tant que le fil peut défiler. */
  Defilement.prototype.decrocher = function (force) {
    var defilable = this.se.scrollHeight - this.se.clientHeight > 2;
    if (this.distanceBas() > 2 || (force && defilable)) { this.colle = false; this.majPastille(); }
  };

  /* Amène le bas du contenu à l'écran. Ne remonte jamais : si l'espace réservé est visible,
   * le contenu est déjà entièrement à l'écran. */
  Defilement.prototype.enBas = function () {
    var max = this._hauteurContenu() - this.se.clientHeight;
    if (this.se.scrollTop < max - 1) { this._poser(max); this._majEspace(); }
  };

  Defilement.prototype.allerEnBas = function () {
    if (this._ancreTache) return;   // juste après l'envoi : le message d'Eliot vient d'être épinglé en haut
    this._liberer();
    this.colle = true;
    this.nouveau = false;
    this._majEspace(true);          // demande explicite : plus de vide sous le fil
    var max = Math.max(0, this._hauteurContenu() - this.se.clientHeight);
    this._poser(max);
    this.majPastille();
  };

  Defilement.prototype.majPastille = function () {
    var visible = (!this.colle || this._enDirect() || !!this.ancre) && this.distanceBas() > SEUIL;
    var nouveau = visible && this.nouveau;
    if (this.pastille.hidden === !visible && this._pastilleNouveau === nouveau) return;
    this._pastilleNouveau = nouveau;
    this.pastille.hidden = !visible;
    this.pastille.classList.toggle('nouveau', nouveau);
    this.pastille.querySelector('.pastille-texte').textContent = nouveau ? 'Nouveaux messages' : 'Revenir en bas';
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
    this._liberer();
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
