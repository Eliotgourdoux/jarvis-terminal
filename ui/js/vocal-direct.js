/* Better Terminal For Claude — mode vocal : les mots d'Eliot en direct (09/11/2026).
 * « Pour l'apparition des mots, je veux quelque chose de plus smooth, là j'ai du mal à savoir s'il a bien compris. »
 *
 * La coque envoie bt.vocalDirect({id, etat, texte?, source?, raison?, questionId?}) à la page de la session visée
 * pendant un énoncé (mains libres ou ⌥Espace) :
 *   debut         une bulle « Eliot » fantôme apparaît en bas du fil, avec le témoin « Jarvis écoute » ;
 *   partiel       tout le texte entendu jusqu'ici (whisper-server, retranscrit en boucle) ;
 *   transcription l'énoncé est fini, whisper-cli fait le texte définitif ;
 *   fini          le texte retenu, juste avant bt.transcription : la bulle fantôme devient celle du message ;
 *   annule        bruit, remplissage, autre session : la bulle s'efface en fondu.
 * Rendu : les mots nouveaux arrivent un par un en fondu ; un mot déjà affiché ne bouge pas ; un mot corrigé par
 * whisper se fond dans sa nouvelle forme (alignement mot à mot, plus longue sous-suite commune).
 * Aucun accès à session.js ni à vue-fil.js : la bulle vit dans #fil (toujours en dernier) et l'échange avec la vraie
 * bulle se fait autour de bt.transcription (app.js appelle avantTranscription / apresTranscription). */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  var ETATS = { ecoute: 'Jarvis écoute', transcription: 'Jarvis transcrit', fini: 'Compris' };
  var DUREE_ENTREE = 260, DUREE_SORTIE = 220;

  function reduit() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function el(tag, cls, texte) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (texte != null) n.textContent = texte;
    return n;
  }

  /* Mot → clé de comparaison : la casse et la ponctuation ne comptent pas (« peut » ≠ « Peux », « parle, » = « parle »). */
  function cle(m) {
    return String(m).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function mots(t) {
    return String(t || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  }

  /* Alignement de deux suites de mots : liste d'opérations {o: '=', a, b} | {o: '-', a} | {o: '+', b}. */
  function aligner(A, B) {
    var n = A.length, m = B.length, i, j;
    var L = [];
    for (i = 0; i <= n; i++) { L.push(new Uint16Array(m + 1)); }
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        L[i][j] = A[i] && A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    var ops = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (A[i] && A[i] === B[j]) { ops.push({ o: '=', a: i, b: j }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { ops.push({ o: '-', a: i }); i++; }
      else { ops.push({ o: '+', b: j }); j++; }
    }
    while (i < n) ops.push({ o: '-', a: i++ });
    while (j < m) ops.push({ o: '+', b: j++ });
    return ops;
  }

  function VocalDirect(app) {
    this.app = app;
    this.racine = app.vue.racine;
    this.g = null;          // bulle fantôme en cours
    var self = this;
    // La bulle fantôme reste la dernière du fil, même si Claude ajoute un tour pendant qu'Eliot parle.
    if (window.MutationObserver) {
      new MutationObserver(function () { self._garderEnBas(); }).observe(this.racine, { childList: true });
    }
    // Eliot remonte le fil à la main : la bulle ne le ramène plus en bas.
    var se = app.defilement && app.defilement.se;
    if (se) se.addEventListener('wheel', function (e) { if (e.deltaY < 0 && self.g) self.g.suivre = false; }, { passive: true });
    // Mode vocal coupé : plus rien à montrer.
    app.session.on('vocal', function (v) { if (!v || !v.actif) self._retirer(self.g); });
  }
  BT.VocalDirect = VocalDirect;

  VocalDirect.prototype._garderEnBas = function () {
    var g = this.g;
    if (!g || g.detache || g.sortie) return;
    if (g.n.parentNode !== this.racine || this.racine.lastElementChild !== g.n) this.racine.appendChild(g.n);
  };

  /* ---------- Réception (bt.vocalDirect) ---------- */

  VocalDirect.prototype.recevoir = function (d) {
    d = d || {};
    var id = d.id == null ? 0 : d.id, g = this.g;
    if (g && g.id !== id) {
      if (d.etat === 'debut' || d.etat === 'partiel' || id > g.id) { this._retirer(g); g = null; }
      else return; // message d'un énoncé déjà remplacé
    }
    switch (d.etat) {
      case 'debut':
        if (!g) g = this._creer(id, d.source);
        break;
      case 'partiel':
        if (!g) g = this._creer(id, d.source);
        if (g.etat === 'ecoute') this._texte(g, d.texte, false);
        break;
      case 'transcription':
        if (!g) return;
        this._etat(g, 'transcription');
        break;
      case 'fini':
        if (!g) g = this._creer(id, d.source);
        g.questionId = d.questionId || null;
        this._texte(g, d.texte, true);
        this._etat(g, 'fini');
        break;
      case 'annule':
        if (g) this._retirer(g);
        return;
      default:
        return;
    }
    this._garde(g);
  };

  /* Filet de sécurité : une bulle qui n'entend plus rien de la coque finit par s'effacer. */
  VocalDirect.prototype._garde = function (g) {
    var self = this;
    clearTimeout(g.minuteur);
    var ms = g.etat === 'fini' ? 5000 : g.etat === 'transcription' ? 45000 : 75000;
    g.minuteur = setTimeout(function () { if (self.g === g) self._retirer(g); }, ms);
  };

  /* ---------- Bulle fantôme ---------- */

  VocalDirect.prototype._creer = function (id, source) {
    var n = el('section', 'tour-eliot vd-fantome');
    n.setAttribute('aria-live', 'polite');
    n.setAttribute('aria-label', 'Ce que Jarvis entend');
    var texte = el('div', 'bulle-texte vd-texte');
    var attente = el('span', 'vd-attente', '…');
    texte.appendChild(attente);
    var bulle = el('div', 'bulle dictee vd-bulle');
    bulle.appendChild(texte);
    var point = el('span', 'vd-point');
    point.setAttribute('aria-hidden', 'true');
    var libelle = el('span', 'vd-etat', ETATS.ecoute);
    var meta = el('div', 'bulle-meta vd-meta');
    meta.appendChild(point);
    meta.appendChild(libelle);
    var pied = el('div', 'eliot-pied vd-pied');
    pied.appendChild(meta);
    n.appendChild(bulle);
    n.appendChild(pied);
    if (!reduit() && !document.hidden) n.classList.add('vd-entre-bulle');
    var g = {
      id: id, source: source || '', n: n, bulle: bulle, texte: texte, attente: attente, libelle: libelle,
      mots: [], file: [], tic: 0, etat: 'ecoute', detache: false, sortie: false, minuteur: 0, questionId: null
    };
    var d = this.app.defilement;
    // Suivre la bulle si Eliot regardait le bas du fil (ou son dernier message épinglé), pas s'il lisait plus haut.
    g.suivre = !d || !!d.ancre || !!d.colle || d.distanceBas() < 80;
    this.g = g;
    this.racine.appendChild(n);
    this._montrer(g, true);
    return g;
  };

  VocalDirect.prototype._etat = function (g, etat) {
    g.etat = etat;
    g.n.classList.toggle('vd-transcrit', etat === 'transcription');
    g.n.classList.toggle('vd-fini', etat === 'fini');
    g.libelle.textContent = ETATS[etat] || '';
  };

  /* Nouveau texte entendu. Les mots déjà là restent ; ceux qui changent se fondent ; les nouveaux de la fin
   * arrivent un par un (final : vite, tous). */
  VocalDirect.prototype._texte = function (g, t, final) {
    var B = mots(t);
    if (!B.length && !final) return;
    var A = g.mots.map(function (m) { return m.cle; });
    var Bc = B.map(cle);
    var ops = aligner(A, Bc);
    var avant = g.bulle.offsetHeight;
    var garde = [];              // nouvelle liste des mots affichés
    var file = [];               // mots de la fin, en attente d'apparition
    var k = 0;
    var self = this;
    // Regroupe chaque écart entre deux mots communs : les retraits et les ajouts face à face sont des corrections.
    while (k < ops.length) {
      var op = ops[k];
      if (op.o === '=') {
        var m = g.mots[op.a];
        if (m.texte !== B[op.b]) { m.texte = B[op.b]; m.sale = true; }   // ponctuation, majuscule : sans effet
        garde.push(m);
        k++;
        continue;
      }
      var moins = [], plus = [];
      while (k < ops.length && ops[k].o !== '=') {
        if (ops[k].o === '-') moins.push(g.mots[ops[k].a]); else plus.push(ops[k].b);
        k++;
      }
      var finale = k >= ops.length;
      var p = Math.min(moins.length, plus.length);
      for (var x = 0; x < p; x++) {
        var c = moins[x];
        c.texte = B[plus[x]]; c.cle = Bc[plus[x]]; c.sale = true;
        this._fondre(c.el);
        garde.push(c);
      }
      for (x = p; x < moins.length; x++) this._effacer(moins[x].el);
      for (x = p; x < plus.length; x++) {
        var nouveau = { texte: B[plus[x]], cle: Bc[plus[x]], el: null, sale: true };
        if (finale && !final) file.push(nouveau);
        else { garde.push(nouveau); nouveau.inserer = true; }
      }
    }
    // Pose dans le DOM, dans l'ordre : les mots existants ne sont jamais recréés.
    var ref = null, poses = [];
    for (var i = garde.length - 1; i >= 0; i--) {
      var w = garde[i];
      if (w.inserer) {
        w.inserer = false;
        w.el = el('span', 'vd-mot');
        if (ref) g.texte.insertBefore(w.el, ref); else g.texte.appendChild(w.el);
        poses.unshift(w.el);
      }
      ref = w.el;
    }
    g.mots = garde;
    this._ecrire(g);
    // texte final d'un coup : un léger décalage de mot en mot plutôt qu'un bloc
    poses.forEach(function (n, r) { self._apparaitre(n, final ? Math.min(r, 12) * 28 : 0); });
    // Mots de la fin : un par un, au rythme des partiels (whisper rend un texte toutes les ~0,4 s).
    clearInterval(g.tic);
    g.file = file;
    if (final) {
      // tout le texte est là : on ne laisse rien en attente
    } else if (file.length) {
      var pas = Math.max(45, Math.min(130, Math.round(420 / file.length)));
      if (reduit()) pas = 0;
      var poser = function () {
        var w2 = g.file.shift();
        if (!w2) { clearInterval(g.tic); return; }
        var h = g.bulle.offsetHeight;
        w2.el = el('span', 'vd-mot');
        g.texte.appendChild(w2.el);
        g.mots.push(w2);
        self._ecrire(g);
        self._apparaitre(w2.el, 0);
        self._hauteur(g, h);
        self._montrer(g);
        if (!g.file.length) clearInterval(g.tic);
      };
      if (pas === 0) { while (g.file.length) poser(); }
      else { poser(); if (g.file.length) g.tic = setInterval(poser, pas); }
    }
    this._hauteur(g, avant);
    this._montrer(g);
  };

  /* La bulle reste à l'écran pendant qu'Eliot parle : le fil descend juste assez pour la montrer en entier
   * (en douceur à l'apparition, puis ligne à ligne). L'ancre du dernier message est libérée pour cela. */
  VocalDirect.prototype._montrer = function (g, entree) {
    var d = this.app.defilement, se = d && d.se;
    if (!se || !g.suivre || g.detache || g.sortie || !g.n.isConnected) return;
    var reste = g.animH && g.hCible ? Math.max(0, g.hCible - g.bulle.offsetHeight) : 0;
    var bas = d._posY(g.n) + g.n.offsetHeight + reste + 14;
    var cible = Math.ceil(bas - se.clientHeight);
    if (cible <= se.scrollTop + 1) return;
    d._liberer();
    d.colle = true;
    d.nouveau = false;
    if (entree && cible - se.scrollTop > 48 && !reduit() && !document.hidden) se.scrollTo({ top: cible, behavior: 'smooth' });
    else d._poser(cible);
    d.majPastille();
  };

  /* Texte de chaque mot (espace devant, sauf le premier), sans toucher à ceux qui n'ont pas changé. */
  VocalDirect.prototype._ecrire = function (g) {
    // « … » d'attente (posé en absolu : les premiers mots prennent sa place sans le pousser)
    var vide = !g.mots.length;
    if (vide && g.attente.classList.contains('vd-sortant')) {
      g.attente.getAnimations && g.attente.getAnimations().forEach(function (a) { a.cancel(); });
      g.attente.classList.remove('vd-sortant');
    }
    if (vide && !g.attente.isConnected) g.texte.insertBefore(g.attente, g.texte.firstChild);
    else if (!vide && g.attente.isConnected && !g.attente.classList.contains('vd-sortant')) this._effacer(g.attente);
    g.mots.forEach(function (m, i) {
      var t = (i ? ' ' : '') + m.texte;
      if (m.el && (m.sale || m.el.textContent !== t)) { m.el.textContent = t; m.sale = false; }
    });
  };

  VocalDirect.prototype._apparaitre = function (n, retard) {
    if (reduit() || document.hidden || !n.animate) return;
    n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUREE_ENTREE, delay: retard || 0, easing: 'ease-out', fill: 'backwards' });
  };

  /* Correction de whisper : le mot prend sa nouvelle forme en fondu (un instant estompé, sans saut). */
  VocalDirect.prototype._fondre = function (n) {
    if (!n || reduit() || document.hidden || !n.animate) return;
    n.animate([{ opacity: 0.25, color: 'var(--accent)' }, { opacity: 1 }], { duration: 340, easing: 'ease-out' });
  };

  /* Mot retiré : il s'efface sur place, puis quitte le DOM. */
  VocalDirect.prototype._effacer = function (n) {
    if (!n || !n.isConnected) return;
    var fin = function () { n.remove(); n.classList.remove('vd-sortant'); };
    if (reduit() || document.hidden || !n.animate) { fin(); return; }
    n.classList.add('vd-sortant');
    n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in', fill: 'forwards' }).onfinish = fin;
  };

  /* Retour à la ligne : la bulle grandit en douceur au lieu de sauter d'une ligne. */
  VocalDirect.prototype._hauteur = function (g, avant) {
    var apres = g.bulle.offsetHeight;
    g.hCible = apres;
    if (!avant || Math.abs(apres - avant) < 2 || reduit() || document.hidden || !g.bulle.animate) return;
    if (g.animH) g.animH.cancel();
    g.bulle.classList.add('vd-anim-h');
    var a = g.animH = g.bulle.animate([{ height: avant + 'px' }, { height: apres + 'px' }], { duration: 160, easing: 'ease-out' });
    a.onfinish = a.oncancel = function () { if (g.animH === a) { g.animH = null; g.bulle.classList.remove('vd-anim-h'); } };
  };

  /* Efface la bulle fantôme en fondu (abandon, autre session, mode coupé). */
  VocalDirect.prototype._retirer = function (g) {
    if (!g) return;
    if (this.g === g) this.g = null;
    clearInterval(g.tic); clearTimeout(g.minuteur);
    if (g.sortie) return;
    g.sortie = true;
    var n = g.n;
    if (!n.isConnected) return;
    if (reduit() || document.hidden || !n.animate) { n.remove(); return; }
    n.classList.add('vd-sortant');
    n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUREE_SORTIE, easing: 'ease-in', fill: 'forwards' })
      .onfinish = function () { n.remove(); };
  };

  /* ---------- La bulle fantôme devient la vraie bulle (autour de bt.transcription) ---------- */

  /* Avant session.transcription : la bulle fantôme quitte le fil (même tâche, aucun rendu entre les deux), pour que
   * la vraie bulle prenne exactement sa place et que le défilement calcule sans elle. */
  VocalDirect.prototype.avantTranscription = function () {
    var g = this.g;
    if (!g || g.sortie || g.etat === 'ecoute' || !g.n.isConnected) return null;
    clearInterval(g.tic); clearTimeout(g.minuteur);
    var r = g.bulle.getBoundingClientRect();
    var ctx = { g: g, rect: r, texte: g.texte.textContent };
    g.detache = true;
    this.g = null;
    g.n.remove();
    return ctx;
  };

  /* Après : `r` est ce qu'a rendu session.transcription (un message d'Eliot, ou une réponse à une question). */
  VocalDirect.prototype.apresTranscription = function (ctx, r) {
    if (!ctx) return;
    var g = ctx.g;
    var n = r && r.genre === 'eliot' && r.id != null && this.app.vue.noeud ? this.app.vue.noeud(r.id) : null;
    var bulle = n && n.querySelector('.bulle');
    if (!bulle) {
      // Réponse à une question (pas de bulle) ou texte écarté : la bulle fantôme s'efface sur place.
      g.detache = false;
      this.racine.appendChild(g.n);
      this._retirer(g);
      return;
    }
    n.classList.remove('ng-enter');   // pas de seconde entrée : elle est déjà là
    if (reduit() || document.hidden || !bulle.animate) return;
    var a = ctx.rect, b = bulle.getBoundingClientRect();
    var dx = a.right - b.right, dy = a.top - b.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      bulle.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: 220, easing: 'ease-out' });
    }
    // Texte retouché par la page (nom de projet retiré…) : l'ancien se fond dans le nouveau.
    var vrai = n.querySelector('.bulle-texte');
    if (vrai && vrai.textContent !== ctx.texte) {
      vrai.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
    }
    var pied = n.querySelector('.eliot-pied');
    if (pied) pied.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  };

  /* Tests : état de la bulle fantôme. */
  VocalDirect.prototype.etatTest = function () {
    var g = this.g;
    return g ? { id: g.id, etat: g.etat, texte: g.texte.textContent, mots: g.mots.length, file: g.file.length } : null;
  };
})();
