/* Better Terminal For Claude — scène persistante du mode vocal (« lock-in » sur un schéma).
 * Claude écrit ```html apercu scene=nom``` : en mode vocal, la scène la plus récente reste figée en haut du fil,
 * d'un message à l'autre. Un nouveau bloc du même nom la remplace sur place (fondu, hauteur stable) ;
 * un bloc ```jarvis scene=nom``` (JS exécuté, ou JSON reçu par jarvis.recevoir) la modifie sans la recharger.
 * Tout est déduit des textes de la session (blocs fermés seulement) : l'historique rechargé reconstruit la scène
 * dans son dernier état (dernière définition, puis ses commandes rejouées). Les étapes de la voix (repères [[n]])
 * vont à la scène quand c'est le tour en cours qui la pilote (sa clé de tour, js/apercu.js).
 * Hors mode vocal (et si le dernier tour n'est pas vocal), la zone est cachée : les aperçus restent dans le fil. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var H_MAX = function () { return Math.max(160, Math.min(440, Math.round(window.innerHeight * 0.42))); };

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  /* Blocs de scène d'un texte (mis en cache sur l'élément tant que son texte ne change pas). */
  function blocsDe(it) {
    if (it._scene && it._scene.texte === it.texte) return it._scene.blocs;
    var blocs = [];
    if (/```|~~~/.test(it.texte || '') && /sc[eè]ne\s*=|```\s*jarvis/i.test(it.texte) && window.marked && window.marked.lexer) {
      var toks = [];
      try { toks = window.marked.lexer(BT.nettoyerTexteClaude(it.texte)); } catch (e) { toks = []; }
      (function parcourir(l) {
        (l || []).forEach(function (t) {
          if (!t) return;
          if (t.type === 'code' && t.codeBlockStyle !== 'indented' && BT.fenceFermee(t.raw)) {
            var inf = BT.infoFence(t.lang);
            if (inf.jarvis) blocs.push({ genre: 'jarvis', scene: inf.scene, code: t.text });
            else if (inf.scene && BT.genreApercu(inf.genre)) blocs.push({ genre: inf.genre, scene: inf.scene, code: t.text });
          } else if (t.type === 'list') (t.items || []).forEach(function (i) { parcourir(i.tokens); });
          else if (t.type === 'blockquote') parcourir(t.tokens);
        });
      })(toks);
    }
    it._scene = { texte: it.texte, blocs: blocs };
    return blocs;
  }

  function Scene(app) {
    var self = this;
    this.app = app;
    this.session = app.session;
    this.racine = document.getElementById('scene');
    this.ferme = null;      // version fermée par Eliot (une nouvelle version ou commande rouvre)
    this.replie = false;
    this.front = null;      // { rec, cadre, version }
    this.etat = null;       // { nom, version, doc, commandes[], cle, rev }
    this._minuteur = 0;
    if (!this.racine) return;
    this.tete = el('div', 'scene-tete');
    this.nom = el('span', 'scene-nom');
    this.bRepli = el('button', 'scene-bouton', 'Replier');
    this.bFermer = el('button', 'scene-bouton', 'Fermer');
    this.bRepli.type = this.bFermer.type = 'button';
    this.bFermer.title = 'Fermer la scène (elle revient au prochain bloc de scène)';
    var gauche = el('span', 'scene-titre');
    gauche.appendChild(el('span', 'scene-libelle', 'Scène'));
    gauche.appendChild(this.nom);
    this.tete.appendChild(gauche);
    this.tete.appendChild(this.bRepli);
    this.tete.appendChild(this.bFermer);
    this.corps = el('div', 'scene-corps');
    this.err = el('div', 'apercu-erreur scene-erreur'); this.err.hidden = true;
    var boite = el('div', 'scene-boite');
    boite.appendChild(this.tete); boite.appendChild(this.corps); boite.appendChild(this.err);
    this.racine.appendChild(boite);
    this.bRepli.addEventListener('click', function () { self.replie = !self.replie; self._afficher(); });
    this.bFermer.addEventListener('click', function () { if (self.etat) self.ferme = self.etat.version + '#' + self.etat.commandes.length; self._afficher(); });
    if (window.ResizeObserver) new ResizeObserver(function () { self._hauteur(); }).observe(this.racine);
    var plus = function (it) { if (!it || it.genre === 'texte' || it.genre === 'eliot') self.planifier(); };
    this.session.on('ajout', plus);
    this.session.on('maj', plus);
    this.session.on('coupe', function () { self.planifier(); });
    this.session.on('historique', function () { self.planifier(); });
    this.session.on('vocal', function () { self.planifier(); });
  }

  Scene.prototype.planifier = function () {
    var self = this;
    if (this._minuteur) return;
    this._minuteur = setTimeout(function () { self._minuteur = 0; self.calculer(); }, 50);
  };

  /* Relit les textes : dernière scène nommée, sa dernière définition et les commandes qui la suivent. */
  Scene.prototype.calculer = function () {
    if (!this.racine) return;
    var scenes = Object.create(null), courante = null, dernierVocal = false;
    this.session.items.forEach(function (it) {
      if (it.genre === 'eliot') { dernierVocal = !!it.vocal; return; }
      if (it.genre !== 'texte' || it.parent) return;
      if (it.vocal) dernierVocal = true;
      blocsDe(it).forEach(function (b, k) {
        if (b.genre === 'jarvis') {
          var nom = b.scene || courante, sc = nom && scenes[nom];
          if (!sc) return;
          // Un bloc JS qui déclare ses étapes (jarvis.etape) passe la main à la voix de son tour.
          var etapes = /\bjarvis\s*\.\s*etape\s*\(/.test(b.code);
          sc.commandes.push({ code: b.code, cle: it.cleTour || null, etapes: etapes });
          if (it.cleTour) { sc.dernierCle = it.cleTour; if (etapes) sc.cleEtapes = it.cleTour; }
          courante = nom;
          return;
        }
        var cle = it.cleTour || null;
        scenes[b.scene] = { nom: b.scene, version: it.id + ':' + k, doc: BT.documentApercu(b.code, b.genre), commandes: [], defCle: cle, cleEtapes: cle, dernierCle: cle };
        courante = b.scene;
      });
    });
    var sc = courante ? scenes[courante] : null;
    this.etat = sc;
    this.visible = !!sc && (!!(this.session.vocal && this.session.vocal.actif) || dernierVocal);
    this._afficher();
  };

  Scene.prototype._afficher = function () {
    var sc = this.etat;
    var montrer = this.visible && sc && this.ferme !== sc.version + '#' + sc.commandes.length;
    if (montrer && this.ferme) this.ferme = null;
    if (!montrer) {
      this._vider();
      this.racine.hidden = true;
      this._hauteur();
      return;
    }
    this.racine.hidden = false;
    this.nom.textContent = sc.nom;
    this.racine.classList.toggle('repliee', this.replie);
    this.bRepli.textContent = this.replie ? 'Déplier' : 'Replier';
    this.bRepli.setAttribute('aria-expanded', String(!this.replie));
    if (!this.front || this.front.version !== sc.version) this._monter(sc);
    else this._pousser();
    this._hauteur();
  };

  /* Nouvelle version : un cadre neuf par-dessus l'ancien, échangé en fondu une fois rendu. */
  Scene.prototype._monter = function (sc) {
    var self = this;
    var ancien = this.front;
    var cadre = el('div', 'scene-cadre arrivee');
    if (!ancien) this._taille(120);
    this.corps.appendChild(cadre);
    var entree = { cadre: cadre, version: sc.version, envoyees: 0, hauteur: 0, rec: null };
    this.front = entree;
    this.err.hidden = true;
    entree.rec = BT.monterCadre(cadre, {
      doc: sc.doc, cle: sc.cleEtapes, hMax: H_MAX(),
      etapeDepart: function () { return BT.etapeApercu(sc.defCle); },
      commandes: function () {
        var l = self.etat && self.etat.version === entree.version ? self.etat.commandes : [];
        entree.envoyees = l.length;
        return l.map(function (c) { return { code: c.code, etape: c.etapes ? BT.etapeApercu(c.cle) : undefined }; });
      },
      surHauteur: function (h) { entree.hauteur = h; if (self.front === entree && !cadre.classList.contains('arrivee')) self._taille(h); },
      surRendu: function () {
        if (self.front !== entree) { cadre.remove(); return; }
        if (entree.hauteur) self._taille(entree.hauteur);
        cadre.classList.remove('arrivee');
        if (ancien) setTimeout(function () { ancien.cadre.remove(); }, 260);
        self._pousser();
      }
    });
    if (ancien && ancien.cadre.classList.contains('arrivee')) ancien.cadre.remove(); // jamais rendue : inutile d'attendre
  };

  /* Commandes arrivées après le rendu, et clé du tour qui pilote la scène (étapes de la voix). */
  Scene.prototype._pousser = function () {
    var f = this.front, sc = this.etat;
    if (!f || !f.rec || !f.rec.rendu || !sc || sc.version !== f.version) return;
    var l = sc.commandes;
    for (var i = f.envoyees; i < l.length; i++) {
      BT.posterCadre(f.rec, { type: 'bt-jarvis', code: l[i].code, etape: l[i].etapes ? BT.etapeApercu(l[i].cle) : undefined });
    }
    f.envoyees = l.length;
    f.rec.cle = sc.cleEtapes;
    var n = BT.etapeApercu(sc.cleEtapes);
    if (n >= 0) BT.posterCadre(f.rec, { type: 'bt-etape', n: n });
    // La voix du dernier tour qui a touché la scène l'attendait : elle est à jour, elle peut partir.
    if (sc.dernierCle && this.session.apercuPret) this.session.apercuPret(sc.dernierCle);
  };

  Scene.prototype._taille = function (h) {
    this.corps.style.height = Math.min(h, H_MAX()) + 'px';
  };

  Scene.prototype._vider = function () {
    if (!this.front) return;
    this.corps.replaceChildren();
    this.corps.style.height = '';
    this.front = null;
  };

  Scene.prototype._hauteur = function () {
    var h = this.racine && !this.racine.hidden ? this.racine.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--hauteur-scene', Math.round(h) + 'px');
  };

  BT.Scene = Scene;
})();
