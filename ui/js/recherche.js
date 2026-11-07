/* Better Terminal For Claude — recherche Cmd+F.
 * Surlignage par l'API CSS Custom Highlight (le DOM du fil n'est jamais modifié),
 * insensible à la casse et aux accents. Entrée / Maj+Entrée, Cmd+G / Maj+Cmd+G, Échap.
 * Repli sans l'API : sélection de la correspondance courante. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  var API = !!(window.CSS && CSS.highlights && window.Highlight);

  function normaliserCar(c) {
    var n = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    return n.length === 1 ? n : (c.toLowerCase().length === 1 ? c.toLowerCase() : c);
  }
  function normaliser(s) {
    var o = '';
    for (var i = 0; i < s.length; i++) o += normaliserCar(s[i]);
    return o;
  }

  function Recherche(vue, barre) {
    this.vue = vue;
    this.barre = barre;
    this.champ = barre.querySelector('input');
    this.compteur = barre.querySelector('.recherche-compte');
    this.resultats = [];
    this.index = -1;
    this.ouverte = false;
    var self = this;
    var minuteur = 0;
    this.champ.addEventListener('input', function () {
      clearTimeout(minuteur);
      minuteur = setTimeout(function () { self.chercher(true); }, 110);
    });
    this.champ.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); self.aller(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); self.fermer(); }
    });
    barre.querySelector('.recherche-prec').addEventListener('click', function () { self.aller(-1); });
    barre.querySelector('.recherche-suiv').addEventListener('click', function () { self.aller(1); });
    barre.querySelector('.recherche-fermer').addEventListener('click', function () { self.fermer(); });
    // Le fil change pendant que la barre est ouverte : on relance (sans bouger la vue).
    var relance = 0;
    vue.on('rendu', function () {
      if (!self.ouverte || !self.champ.value) return;
      clearTimeout(relance);
      relance = setTimeout(function () { self.chercher(false); }, 400);
    });
  }
  BT.Recherche = Recherche;

  Recherche.prototype.ouvrir = function (texte) {
    this.ouverte = true;
    this.barre.hidden = false;
    document.body.classList.add('recherche-ouverte');
    if (typeof texte === 'string') this.champ.value = texte;
    else {
      var sel = window.getSelection && String(window.getSelection() || '').trim();
      if (sel && sel.length < 80 && sel.indexOf('\n') < 0) this.champ.value = sel;
    }
    this.champ.focus();
    this.champ.select();
    if (this.champ.value) this.chercher(true);
  };

  Recherche.prototype.fermer = function () {
    this.ouverte = false;
    this.barre.hidden = true;
    document.body.classList.remove('recherche-ouverte');
    this.resultats = [];
    this.index = -1;
    if (API) { CSS.highlights.delete('bt-recherche'); CSS.highlights.delete('bt-recherche-actif'); }
    this.compteur.textContent = '';
    var s = document.getElementById('saisie-texte');
    if (s) s.focus({ preventScroll: true });
  };

  /* Construit la liste des correspondances (Range) dans tout le fil. */
  Recherche.prototype.chercher = function (allerAuPremier) {
    this.vue.vider();
    var q = normaliser(this.champ.value.trim());
    var ancien = this.resultats[this.index];
    this.resultats = [];
    if (!q) { this._peindre(); this.compteur.textContent = ''; this.barre.classList.remove('aucun'); return; }

    var noeuds = [], textes = [], total = 0, offsets = [];
    var w = document.createTreeWalker(this.vue.racine, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!p || p.closest('button, .chevron, .pastille, [hidden], .q-raccourci')) return NodeFilter.FILTER_REJECT;
        return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    var n;
    while ((n = w.nextNode())) {
      noeuds.push(n);
      offsets.push(total);
      var t = normaliser(n.nodeValue);
      textes.push(t);
      total += t.length;
    }
    var plein = textes.join('');
    var pos = 0, max = 2000;
    while ((pos = plein.indexOf(q, pos)) >= 0 && this.resultats.length < max) {
      var r = document.createRange();
      var a = localiser(offsets, pos), b = localiser(offsets, pos + q.length - 1);
      r.setStart(noeuds[a], pos - offsets[a]);
      r.setEnd(noeuds[b], pos + q.length - offsets[b]);
      this.resultats.push(r);
      pos += q.length;
    }
    this.barre.classList.toggle('aucun', !this.resultats.length);
    if (!this.resultats.length) { this.index = -1; this._peindre(); this._majCompteur(); return; }
    if (allerAuPremier || this.index < 0) {
      // Premier résultat visible à partir du haut de l'écran, sinon le dernier (le plus récent).
      this.index = this.resultats.length - 1;
      var hautZone = document.getElementById('defile').getBoundingClientRect().top;
      for (var i = 0; i < this.resultats.length; i++) {
        var rect = this.resultats[i].getBoundingClientRect();
        if (rect.height && rect.top > hautZone) { this.index = i; break; }
      }
      this._peindre();
      this._montrer();
    } else {
      // Garder la position actuelle au mieux.
      var garde = Math.min(this.index, this.resultats.length - 1);
      if (ancien) {
        for (var j = 0; j < this.resultats.length; j++) {
          if (this.resultats[j].compareBoundaryPoints(Range.START_TO_START, ancien) >= 0) { garde = j; break; }
        }
      }
      this.index = garde;
      this._peindre();
    }
    this._majCompteur();
  };

  function localiser(offsets, p) {
    var lo = 0, hi = offsets.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= p) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  Recherche.prototype.aller = function (sens) {
    if (!this.ouverte) { this.ouvrir(); return; }
    if (!this.resultats.length) { this.chercher(true); return; }
    this.index = (this.index + sens + this.resultats.length) % this.resultats.length;
    this._peindre();
    this._montrer();
    this._majCompteur();
  };

  Recherche.prototype._majCompteur = function () {
    if (!this.champ.value.trim()) { this.compteur.textContent = ''; return; }
    this.compteur.textContent = this.resultats.length ? (this.index + 1) + ' sur ' + this.resultats.length : 'Aucun résultat';
  };

  Recherche.prototype._peindre = function () {
    if (!API) return;
    if (!this.resultats.length) { CSS.highlights.delete('bt-recherche'); CSS.highlights.delete('bt-recherche-actif'); return; }
    var tous = new Highlight();
    for (var i = 0; i < this.resultats.length; i++) if (i !== this.index) tous.add(this.resultats[i]);
    CSS.highlights.set('bt-recherche', tous);
    var actif = new Highlight();
    if (this.resultats[this.index]) actif.add(this.resultats[this.index]);
    CSS.highlights.set('bt-recherche-actif', actif);
  };

  Recherche.prototype._montrer = function () {
    var r = this.resultats[this.index];
    if (!r) return;
    // Déplier les détails repliés qui contiennent la correspondance.
    var p = r.startContainer.parentElement;
    while (p && p !== this.vue.racine) {
      if (p.nodeName === 'DETAILS' && !p.open) p.open = true;
      if (p.classList && p.classList.contains('longue') && !p.classList.contains('ouverte')) p.classList.add('ouverte');
      p = p.parentElement;
    }
    var zone = document.getElementById('defile');
    var rect = r.getBoundingClientRect();
    if (!rect.height) {
      // Contenu pas encore peint (content-visibility) : on amène d'abord son message à l'écran.
      var tour = r.startContainer.parentElement && r.startContainer.parentElement.closest('.tour-claude, .tour-eliot');
      if (tour) tour.scrollIntoView({ block: 'center' });
      rect = r.getBoundingClientRect();
    }
    var zr = zone.getBoundingClientRect();
    var haut = zr.top + 60, bas = window.innerHeight - (document.getElementById('pied').offsetHeight + 40);
    if (!rect.height || rect.top < haut || rect.bottom > bas) {
      var y = rect.top - zr.top + zone.scrollTop - zone.clientHeight * 0.35;
      if (BT.app && BT.app.defilement) BT.app.defilement.colle = false;
      zone.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
    }
    if (!API) {
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
  };
})();
