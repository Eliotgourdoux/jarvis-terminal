/* Better Terminal For Claude — le fil de conversation (rendu DOM de la Session).
 * Une bulle par message d'Eliot ; une carte de verre par tour de Claude, qui contient
 * son texte, ses lignes d'outils et de réflexion repliées, ses questions et la fin du tour.
 * Les mises à jour (deltas) sont regroupées et appliquées une fois par image. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var el = BT.el;

  function VueFil(session, racine) {
    BT.Emetteur.call(this);
    this.s = session;
    this.racine = racine;
    this.noeuds = Object.create(null);
    this.tour = null;
    this.groupe = null;
    this.sales = new Set();
    this._raf = 0;
    this.eliots = [];
    this.ecritures = new Set();   // blocs de texte en train de s'écrire (animation lissée + curseur)
    this._rafEcr = 0;
    var self = this;
    session.on('ajout', function (it) { self.ajouter(it); });
    session.on('maj', function (it) { self.salir(it); });
    session.on('coupe', function (it, retires) { self.couper(it, retires); });
    // Mode vocal : les questions ouvertes disent si Jarvis les lit ou écoute la réponse.
    session.on('vocal', function () { session.questionsEnAttente().forEach(function (q) { self.salir(q); }); });
    // Détail des outils construit à la première ouverture seulement (léger pour les longues sessions).
    racine.addEventListener('toggle', function (ev) {
      var n = ev.target;
      if (n.nodeName !== 'DETAILS' || !n.dataset.id || !n.open) return;
      var it = self.s.item(n.dataset.id);
      if (it) self._remplirDetail(it, n);
    }, true);
  }
  VueFil.prototype = Object.create(BT.Emetteur.prototype);
  BT.VueFil = VueFil;

  /* ---------- Ajout ---------- */

  VueFil.prototype.ajouter = function (it) {
    if (it.parent) { this._salirParent(it.parent); return; }
    var n;
    switch (it.genre) {
      case 'eliot':
        this._fermerTour();
        n = this._noeudEliot(it);
        this.racine.appendChild(n);
        this.eliots.push(n);
        break;
      case 'compaction':
        this._fermerTour();
        n = el('div', 'compaction');
        this.racine.appendChild(n);
        break;
      case 'separateur':
        this._fermerTour();
        n = el('div', 'separateur', [el('span', null, it.texte)]);
        this.racine.appendChild(n);
        break;
      case 'outil': case 'reflexion':
        this._assurerGroupe(it);
        n = this._noeudLigne(it);
        this.groupe.appendChild(n);
        break;
      case 'note':
        if (this.tour) { this.groupe = null; n = el('div', 'note'); this.tour.corps.appendChild(n); }
        else { n = el('div', 'note note-libre'); this.racine.appendChild(n); }
        break;
      case 'fin':
        n = el('div', 'fin-tour');
        if (this.tour) this.tour.corps.appendChild(n); else n.hidden = true;
        this._fermerTour();
        break;
      case 'question':
        this._assurerTour(it);
        this.groupe = null;
        n = el('div', 'question');
        this.tour.corps.appendChild(n);
        break;
      default: // texte
        this._assurerTour(it);
        this.groupe = null;
        n = el('div', 'bloc-texte md');
        this.tour.corps.appendChild(n);
        // Réponse en direct : le texte s'écrit progressivement (pas l'historique, déjà tout là).
        if (!it.historique && it.enCours && !mouvementReduit()) n._ecr = { src: '', aff: 0, k: -1, debit: 0, recu: 0, t: 0 };
    }
    n.dataset.id = it.id;
    this.noeuds[it.id] = n;
    this._rendre(it, n);
    this.emit('ajout', it, n);
  };

  /* Animation d'entrée : seulement pour un message vivant, fenêtre visible
   * (fenêtre cachée : l'animation resterait figée à opacité 0 jusqu'au retour). */
  function entree(it) { return !it.historique && !document.hidden; }

  VueFil.prototype.noeud = function (id) { return this.noeuds[id] || null; };

  /* Reprise depuis un message : le nœud de ce message d'Eliot et tout ce qui le suit dans le fil disparaissent. */
  VueFil.prototype.couper = function (it, retires) {
    var self = this, n = this.noeuds[it.id];
    if (n && n.parentNode === this.racine) {
      while (n) { var suivant = n.nextSibling; this.racine.removeChild(n); n = suivant; }
    }
    (retires || []).forEach(function (x) { delete self.noeuds[x.id]; self.sales.delete(x.id); });
    this.eliots = this.eliots.filter(function (e) { return e.isConnected; });
    this._fermerTour();
    this.emit('rendu');
  };

  /* Pendant qu'Eliot prépare une reprise : ce qui sera oublié est estompé (annulable). */
  VueFil.prototype.marquerReprise = function (it) {
    this.racine.querySelectorAll('.a-oublier').forEach(function (x) { x.classList.remove('a-oublier'); });
    var n = it && this.noeuds[it.id];
    if (!n || n.parentNode !== this.racine) return;
    for (; n; n = n.nextElementSibling) n.classList.add('a-oublier');
  };

  VueFil.prototype._assurerTour = function (it) {
    if (this.tour) return;
    var carte = el('section', 'tour-claude' + (entree(it) ? ' ng-enter' : ''));
    var tete = el('header', 'tour-tete', [el('span', 'tour-nom', 'Claude'), el('span', 'tour-heure', BT.heure(it.date))]);
    var corps = el('div', 'tour-corps');
    carte.appendChild(tete);
    carte.appendChild(corps);
    this.racine.appendChild(carte);
    this.tour = { carte: carte, corps: corps };
    this.emit('tour', carte, it);   // js/defilement.js : un tour lancé sans message d'Eliot monte en haut
  };

  VueFil.prototype._assurerGroupe = function (it) {
    this._assurerTour(it);
    // Un seul récap par tour, entre l'en-tête et le texte : le texte de Claude n'est plus coupé par les actions.
    if (!this.tour.liste) {
      this.tour.liste = el('div', 'activite-liste');
      this.tour.carte.insertBefore(el('details', 'activite', [BT.atelierResume(), this.tour.liste]), this.tour.corps);
    }
    this.groupe = this.tour.liste;
  };

  VueFil.prototype._fermerTour = function () { this.tour = null; this.groupe = null; };

  VueFil.prototype._noeudEliot = function (it) {
    var n = el('section', 'tour-eliot' + (entree(it) ? ' ng-enter' : ''));
    var texte = el('div', 'bulle-texte' + (it.commande ? ' commande' : ''));
    texte.textContent = it.texte;
    texte.hidden = !it.texte.trim();
    var enfants = [texte];
    if (it.images && it.images.length) {
      var galerie = el('div', 'bulle-images');
      it.images.forEach(function (src) {
        var img = document.createElement('img');
        img.src = src; img.alt = 'Image envoyée'; img.loading = 'lazy'; img.decoding = 'async';
        img.addEventListener('click', function () { BT.agrandirImage && BT.agrandirImage(src); });
        galerie.appendChild(img);
      });
      enfants.unshift(galerie);
    }
    if (it.fichiers && it.fichiers.length) {
      enfants.push(el('div', 'bulle-fichiers', it.fichiers.map(function (f) { return BT.pastilleFichier(f); })));
    }
    var bulle = el('div', 'bulle' + (it.source === 'vocal' ? ' dictee' : '') + (it.images && it.images.length ? ' avec-images' : ''), enfants);
    var lignes = it.texte.split('\n').length;
    if (lignes > 14 || it.texte.length > 1500) {
      bulle.classList.add('longue');
      bulle.appendChild(BT.bouton('bt-plus bulle-plus', 'Afficher tout (' + lignes + ' lignes)', function (ev) {
        var ouverte = bulle.classList.toggle('ouverte');
        ev.currentTarget.textContent = ouverte ? 'Réduire' : 'Afficher tout (' + lignes + ' lignes)';
      }));
    }
    n.appendChild(bulle);
    // Images, vidéos et sons cités ou joints : lecteur sous la bulle (js/medias.js).
    var lec = BT.medias && BT.medias.lecteurs(BT.medias.dansTexte(it.texte)
      .concat((it.fichiers || []).filter(function (f) { return !f.dossier; }).map(function (f) { return f.chemin; })));
    if (lec) n.appendChild(lec);
    n.appendChild(el('div', 'eliot-pied', [this._actionsEliot(it), el('div', 'bulle-meta')]));
    return n;
  };

  /* Au survol d'un message d'Eliot : Copier, Modifier (reprend le texte dans la zone de saisie), Renvoyer. Icônes seules, libellé en infobulle. */
  VueFil.prototype._actionsEliot = function (it) {
    function ui() { return BT.app && BT.app.interface; }
    function action(icone, libelle, faire) {
      var b = BT.bouton('eliot-action', null, faire);
      b.title = libelle;
      b.setAttribute('aria-label', libelle);
      b.appendChild(BT.icone(icone));
      return b;
    }
    var l = [];
    if (it.texte.trim()) {
      var copier = action('copier', 'Copier', function () {
        BT.pont.copier(it.texte);
        copier.replaceChildren(BT.icone('fait')); copier.classList.add('fait'); copier.title = 'Copié';
        setTimeout(function () { copier.replaceChildren(BT.icone('copier')); copier.classList.remove('fait'); copier.title = 'Copier'; }, 1300);
      });
      l.push(copier);
    }
    l.push(action('modifier', 'Modifier et repartir d’ici', function () { if (ui()) ui().modifierDepuis(it); }));
    var joints = (it.images && it.images.length) || (it.fichiers && it.fichiers.length);
    if (!joints && !it.commande) l.push(action('renvoyer', 'Renvoyer', function () { if (ui()) ui().renvoyerTexte(it.texte); }));
    return el('div', 'eliot-actions', l);
  };

  VueFil.prototype._noeudLigne = function (it) {
    var d = el('details', 'ligne ' + (it.genre === 'outil' ? 'outil' : 'reflexion'));
    var sum = el('summary', 'ligne-resume', [el('span', 'pastille'), el('span', 'ligne-nom'), el('span', 'ligne-cible'), el('span', 'ligne-etat'), el('span', 'chevron')]);
    d.appendChild(sum);
    d.appendChild(el('div', 'ligne-detail'));
    return d;
  };

  /* ---------- Mises à jour regroupées ---------- */

  VueFil.prototype.salir = function (it) {
    if (it.parent) { this._salirParent(it.parent); return; }
    this.sales.add(it.id);
    this._planifier();
  };

  VueFil.prototype._salirParent = function (pid) {
    var p = this.s._outils[pid], garde = 0;
    while (p && p.parent && garde++ < 10) p = this.s._outils[p.parent];
    if (p) { this.sales.add(p.id); this._planifier(); }
  };

  /* Regroupe les mises à jour à la prochaine image ; minuteur de secours si la fenêtre
   * est cachée (WebKit n'y appelle plus requestAnimationFrame). */
  VueFil.prototype._planifier = function () {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () { self._vider(); });
    this._secours = setTimeout(function () { self._vider(); }, 250);
  };

  VueFil.prototype._vider = function () {
    if (this._raf) cancelAnimationFrame(this._raf);
    clearTimeout(this._secours);
    this._raf = 0;
    var ids = Array.from(this.sales);
    this.sales.clear();
    for (var i = 0; i < ids.length; i++) {
      var it = this.s.item(ids[i]), n = this.noeuds[ids[i]];
      if (it && n) this._rendre(it, n);
    }
    this.emit('rendu');
  };

  /* Rendu immédiat de tout ce qui attend (avant une capture, une recherche…). */
  VueFil.prototype.vider = function () { this._vider(); };

  /* ---------- Rendu par genre ---------- */

  VueFil.prototype._rendre = function (it, n) {
    switch (it.genre) {
      case 'eliot': return this._rendreEliot(it, n);
      case 'texte': return this._rendreTexte(it, n);
      case 'reflexion': return this._rendreReflexion(it, n);
      case 'outil': return this._rendreOutil(it, n);
      case 'question': return BT.rendreQuestion(it, n, this.s);
      case 'note': return this._rendreNote(it, n);
      case 'fin': return this._rendreFin(it, n);
      case 'compaction': return this._rendreCompaction(it, n);
    }
  };

  /* Compaction : une ligne et une barre. La durée réelle est inconnue d'avance : la barre approche
   * de la fin sans l'atteindre (1 − e^(−t/25 s), 95 % au plus) et se remplit d'un coup quand c'est fini. */
  function jetonsK(n) { return n >= 1000 ? Math.round(n / 1000) + ' k' : String(n); }
  VueFil.prototype._rendreCompaction = function (it, n) {
    if (!n.firstChild) {
      n.appendChild(el('div', 'compaction-tete', [el('span', 'compaction-titre'), el('span', 'compaction-detail')]));
      n.appendChild(el('div', 'compaction-rail', [el('div', 'compaction-barre')]));
    }
    var titre = n.querySelector('.compaction-titre'), detail = n.querySelector('.compaction-detail');
    var barre = n.querySelector('.compaction-barre');
    n.className = 'compaction etat-' + it.etat;
    clearInterval(n._minuteur);
    if (it.etat === 'encours') {
      titre.textContent = 'Compaction de la conversation…';
      var tic = function () {
        var t = (Date.now() - it.debut) / 1000;
        barre.style.width = (Math.min(0.95, 1 - Math.exp(-t / 25)) * 100).toFixed(1) + '%';
        detail.textContent = (it.consigne ? it.consigne + ' · ' : '') + Math.floor(t) + ' s';
        if (!n.isConnected && t > 2) clearInterval(n._minuteur);
      };
      tic();
      n._minuteur = setInterval(tic, 250);
    } else if (it.etat === 'echec') {
      titre.textContent = 'La compaction a échoué';
      detail.textContent = it.erreur || '';
      barre.style.width = '100%';
    } else {
      titre.textContent = it.auto ? 'Conversation compactée automatiquement' : 'Conversation compactée';
      var d = [];
      if (it.avant) d.push(jetonsK(it.avant) + ' → ' + jetonsK(it.apres) + ' jetons');
      if (it.duree) d.push(Math.round(it.duree / 1000) + ' s');
      detail.textContent = d.join(' · ');
      barre.style.width = '100%';
    }
  };

  VueFil.prototype._rendreEliot = function (it, n) {
    var meta = n.querySelector('.bulle-meta');
    var t = [BT.heure(it.date)];
    if (it.commande) t.unshift('commande');
    if (it.source === 'lancement') t.unshift('message de lancement');
    else if (it.source === 'vocal') t.unshift('dicté à Jarvis');
    else if (it.source && it.source !== 'mac') t.unshift('envoyé par ' + it.source);
    if (it.enFile) t.push('ajouté pendant le travail');
    var texte = t.filter(Boolean).join(' · ');
    if (it.source === 'vocal' && BT.icone) meta.replaceChildren(BT.icone('micro', 'icone-meta'), document.createTextNode(texte));
    else meta.textContent = texte;
  };

  VueFil.prototype._rendreTexte = function (it, n) {
    var src = BT.nettoyerTexteClaude(it.texte);
    var vocal = !!it.vocal, dit = vocal ? BT.sansReperes(BT.texteVocalFerme(it.texte) || (it.enCours ? '' : BT.texteVocal(it.texte))) : '';
    // Tour vocal : visible tant qu'il s'écrit (curseur), puis seulement s'il y a la voix ou un visuel.
    var vide = vocal ? (!it.enCours && !dit && !BT.aDesVisuels(src)) : !src.trim();
    if (vide) { n.hidden = true; if (n._ecr) this._finirEcriture(n); n._src = null; return; }
    n.hidden = false;
    n.classList.toggle('est-erreur', !!it.erreur);
    n.classList.toggle('en-cours', !!it.enCours);
    n.classList.toggle('texte-vocal', vocal);
    if (n._ecr) {
      // Interruption, erreur, fenêtre cachée ou mouvement réduit : tout le texte d'un coup.
      if (it.interrompu || it.erreur || document.hidden || mouvementReduit()) this._finirEcriture(n);
      else { if (n._dit !== dit) { n._dit = dit; n._ecr.k = -1; } this._cibleEcriture(n, src); return; }
    }
    if (n._src === src && n._enCours === !!it.enCours && n._interrompu === !!it.interrompu && n._vocal === vocal && n._dit === dit) return;
    n._src = src; n._enCours = !!it.enCours; n._interrompu = !!it.interrompu; n._vocal = vocal; n._dit = dit;
    // Écriture en direct sans animation (mouvement réduit) : un curseur fixe tant que le bloc s'écrit.
    var frag = this._fragTexte(it, n, src, !!it.enCours, it.enCours && !it.historique, !it.enCours);
    // Texte coupé net : des points de suspension suffisent (la note « Interrompu par Eliot » et la fin du tour le disent déjà).
    if (it.interrompu && !vocal) {
      var dernier = frag.lastElementChild;
      if (dernier && dernier.tagName === 'P') dernier.appendChild(document.createTextNode(' …'));
    }
    n.replaceChildren(frag);
    // Tour vocal en direct : ses aperçus sont montés tout de suite, la voix attend leur rendu.
    if (vocal && !it.enCours && !it.historique && BT.monterApercus) BT.monterApercus(n, it.cleTour);
  };

  /* Contenu d'un bloc de texte. Normal : le markdown rendu. Tour vocal : la ligne repliée « Jarvis a dit »
   * (une fois le bloc <vocal> fermé), puis les seuls éléments visuels (markdown.js, BT.rendreVisuels).
   * curseur : curseur d'écriture au bout ; medias : lecteurs des images et vidéos citées (texte complet seulement). */
  VueFil.prototype._fragTexte = function (it, n, src, enCours, curseur, medias) {
    var vis = it.vocal ? BT.rendreVisuels(src, { enCours: enCours }) : BT.rendreMarkdown(src, { enCours: enCours });
    // Clé du tour sur chaque aperçu : les étapes de la voix (repères [[n]]) lui arrivent (js/apercu.js).
    if (it.cleTour) vis.querySelectorAll('.apercu-cadre').forEach(function (c) { c._cle = it.cleTour; });
    if (curseur) ajouterCurseur(vis);
    // Lecteur intégré (images, vidéos, sons locaux cités), une fois le texte complet : pas de rechargement à chaque delta.
    if (medias && BT.medias) {
      var lec = BT.medias.pour(vis);
      if (lec) vis.appendChild(lec);
    }
    if (!it.vocal) return vis;
    var frag = document.createDocumentFragment();
    var dit = BT.sansReperes(BT.texteVocalFerme(it.texte) || (it.enCours ? '' : BT.texteVocal(it.texte)));
    if (dit) frag.appendChild(this._ligneJarvis(it, n, dit));
    frag.appendChild(vis);
    return frag;
  };

  /* « Jarvis a dit » : discret et replié ; dedans, la phrase dite et « Texte complet » (la réponse écrite du tour,
   * nettoyée). L'état ouvert est gardé sur le nœud : le bloc est reconstruit à chaque image pendant l'écriture. */
  VueFil.prototype._ligneJarvis = function (it, n, dit) {
    var self = this;
    var d = el('details', 'jarvis-dit');
    d.open = !!n._jarvisOuvert;
    d.appendChild(el('summary', 'jarvis-dit-resume', [el('span', 'jarvis-dit-nom', 'Jarvis a dit')]));
    var complet = el('div', 'jarvis-complet md');
    var bouton = BT.bouton('jarvis-complet-bouton', n._completOuvert ? 'Masquer le texte complet' : 'Texte complet', function (ev) {
      n._completOuvert = !n._completOuvert;
      ev.currentTarget.textContent = n._completOuvert ? 'Masquer le texte complet' : 'Texte complet';
      remplir();
    });
    function remplir() {
      complet.hidden = !n._completOuvert;
      if (n._completOuvert) complet.replaceChildren(BT.rendreMarkdown(self._texteCompletTour(n), {}));
      else complet.replaceChildren();
    }
    d.appendChild(el('div', 'jarvis-dit-corps', [el('p', 'jarvis-dit-texte', dit), bouton, complet]));
    remplir();
    d.addEventListener('toggle', function (ev) { ev.stopPropagation(); n._jarvisOuvert = d.open; });
    return d;
  };

  /* Toute la réponse écrite du tour (tous ses blocs de texte), sans le bloc <vocal>. */
  VueFil.prototype._texteCompletTour = function (n) {
    var carte = n.closest('.tour-claude') || n.parentNode, self = this;
    var l = carte ? carte.querySelectorAll('.bloc-texte[data-id]') : [n];
    return Array.prototype.map.call(l, function (b) {
      var it = self.s.item(b.dataset.id);
      return it ? BT.nettoyerTexteClaude(it.texte) : '';
    }).filter(function (t) { return t.trim(); }).join('\n\n');
  };

  /* ---------- Écriture progressive de la réponse ----------
   * Les deltas arrivent par paquets irréguliers ; le texte affiché les rattrape en douceur (vitesse
   * proportionnelle au retard, temps de réponse ≈ TAU), avec un curseur au bout. Le retard ne dépasse
   * jamais ~1 s de texte : au-delà, on saute directement. L'historique ne passe jamais par ici. */
  var TAU = 0.28, TAU_FIN = 0.12;  // s : constante de rattrapage (pendant le flux / une fois le bloc complet)
  var VITESSE_MIN = 45;           // caractères par seconde, pour finir les derniers caractères
  var RETARD_MAX_S = 1;           // s de texte en retard au plus

  function mouvementReduit() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* Curseur à la fin du dernier texte visible du fragment (pas dans un bouton « Copier »). */
  function ajouterCurseur(frag) {
    var curseur = el('span', 'curseur-ecriture');
    curseur.setAttribute('aria-hidden', 'true');
    var w = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT, {
      acceptNode: function (t) {
        if (!t.nodeValue.trim()) return NodeFilter.FILTER_SKIP;
        var p = t.parentNode;
        return p && p.closest && p.closest('button, .bloc-code-tete') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var dernier = null, t;
    while ((t = w.nextNode())) dernier = t;
    if (dernier) dernier.parentNode.insertBefore(curseur, dernier.nextSibling);
    else frag.appendChild(curseur);
  }

  /* Nouveau texte reçu pour un bloc qui s'écrit : met à jour la cible et le débit estimé. */
  VueFil.prototype._cibleEcriture = function (n, src) {
    var e = n._ecr, maintenant = performance.now();
    if (src !== e.src) {
      // Texte remplacé (message complet arrivé après un ⌘R…) : on repart du préfixe commun.
      if (src.lastIndexOf(e.src.slice(0, Math.floor(e.aff)), 0) !== 0) {
        var k = 0, lim = Math.min(src.length, Math.floor(e.aff));
        while (k < lim && src.charCodeAt(k) === e.src.charCodeAt(k)) k++;
        e.aff = k; e.k = -1;
      }
      var ajout = src.length - e.src.length;
      if (ajout > 0) {
        var dt = e.recu ? Math.min(1, Math.max(0.016, (maintenant - e.recu) / 1000)) : 0.25;
        e.debit = e.debit ? e.debit * 0.8 + (ajout / dt) * 0.2 : ajout / dt;
        e.recu = maintenant;
      }
      e.src = src;
    }
    this.ecritures.add(n);
    this._planifierEcriture();
  };

  VueFil.prototype._planifierEcriture = function () {
    if (this._rafEcr) return;
    var self = this;
    if (document.hidden) { setTimeout(function () { self._ecrire(); }, 0); this._rafEcr = -1; return; }
    this._rafEcr = requestAnimationFrame(function () { self._ecrire(); });
  };

  /* Une image : chaque bloc avance vers son texte reçu. */
  VueFil.prototype._ecrire = function () {
    this._rafEcr = 0;
    var self = this, maintenant = performance.now(), rendu = false, actif = false;
    this.ecritures.forEach(function (n) {
      var e = n._ecr, it = n.dataset.id && self.s.item(n.dataset.id);
      if (!e || !it || !n.isConnected) { self.ecritures.delete(n); return; }
      if (document.hidden || it.interrompu || it.erreur) { self._finirEcriture(n); self._rendreTexte(it, n); rendu = true; return; }
      var dt = e.t ? Math.min(0.1, (maintenant - e.t) / 1000) : 1 / 60;
      e.t = maintenant;
      var len = e.src.length, fini = !it.enCours;
      var retard = len - e.aff;
      var limite = Math.max(90, e.debit * RETARD_MAX_S);
      if (retard > limite) { e.aff = len - limite; retard = limite; }   // trop de retard : on rattrape
      e.aff = Math.min(len, e.aff + Math.max(VITESSE_MIN, retard / (fini ? TAU_FIN : TAU)) * dt);
      var k = Math.floor(e.aff);
      var c = e.src.charCodeAt(k - 1);
      if (k < len && c >= 0xD800 && c <= 0xDBFF) k++;   // ne pas couper un emoji en deux
      if (k >= len && fini) { self._finirEcriture(n); self._rendreTexte(it, n); rendu = true; return; }
      if (k !== e.k) {
        e.k = k;
        n.replaceChildren(self._fragTexte(it, n, e.src.slice(0, k), true, true, false));
        rendu = true;
      }
      if (k < len || fini) actif = true;
    });
    if (rendu) this.emit('rendu');
    if (actif) this._planifierEcriture();
  };

  /* Fin de l'écriture : le prochain rendu affiche le texte complet, sans curseur. */
  VueFil.prototype._finirEcriture = function (n) {
    n._ecr = null;
    n._src = null;
    this.ecritures.delete(n);
  };

  function remplirResume(n, nom, cible, mono, etat, titre) {
    var s = n.firstElementChild;
    s.children[1].textContent = nom;
    s.children[2].textContent = cible || '';
    s.children[2].className = 'ligne-cible' + (mono ? ' mono' : '');
    s.children[3].textContent = etat || '';
    s.title = titre || '';
  }

  VueFil.prototype._rendreReflexion = function (it, n) {
    var etat = it.enCours ? 'en cours' : (it.fin && it.debut && it.fin - it.debut >= 1000 ? BT.dureeLisible(it.fin - it.debut) : '');
    var cible = it.jetons ? 'environ ' + it.jetons + ' jetons' : '';
    remplirResume(n, 'Réflexion', cible, false, etat, '');
    n.className = 'ligne reflexion' + (it.enCours ? ' statut-encours' : ' statut-ok') + (it.texte ? '' : ' vide');
    // Réflexion finie dont Claude Code n'a pas transmis le texte : rien à lire, on ne l'affiche pas.
    n.hidden = !it.enCours && !(it.texte && it.texte.trim());
    if (n.open) this._remplirDetail(it, n);
    this._majAtelier(n);
  };

  function etatOutil(o, q) {
    if (q && q.statut === 'attente') return { cls: 'attend', txt: 'attend ta réponse' };
    if (o.tache && o.tache.fond && o.statut !== 'erreur') {
      if (o.tache.statut === 'completed') return { cls: 'ok', txt: 'terminé en arrière-plan' };
      if (o.tache.statut === 'failed' || o.tache.statut === 'killed') return { cls: 'erreur', txt: 'échec en arrière-plan' };
      return { cls: 'encours', txt: o.tache.progres ? BT.tronquer(o.tache.progres, 48) : 'en arrière-plan' };
    }
    switch (o.statut) {
      case 'prepare': return { cls: 'encours', txt: 'préparation' };
      case 'encours': return { cls: 'encours', txt: 'en cours' };
      case 'erreur': return { cls: 'erreur', txt: 'erreur' };
      case 'interrompu': return { cls: 'interrompu', txt: 'interrompu' };
      default:
        var d = o.fin && o.debut ? o.fin - o.debut : 0;
        return { cls: 'ok', txt: d >= 1000 ? BT.dureeLisible(d) : '' };
    }
  }

  VueFil.prototype._rendreOutil = function (o, n) {
    var r = BT.resumeOutil(o.nom, o.entree || o.entreeApercu);
    var q = o.questionId ? this.s.item(o.questionId) : null;
    var e = etatOutil(o, q);
    var etat = e.txt;
    var nEtapes = (o.enfants || []).filter(function (id) { var c = this.s.item(id); return c && c.genre === 'outil'; }, this).length;
    if (nEtapes) etat = (etat ? etat + ' · ' : '') + nEtapes + (nEtapes > 1 ? ' étapes' : ' étape');
    var titre = (o.entree && (o.entree.file_path || o.entree.command || o.entree.url)) || '';
    remplirResume(n, r.nom, r.cible, r.mono, etat, titre);
    n.className = 'ligne outil statut-' + e.cls;
    if (n.open) this._remplirDetail(o, n);
    this._majAtelier(n);
  };

  /* Met à jour l'atelier (mascotte + phrase) du groupe qui contient la ligne n. */
  VueFil.prototype._majAtelier = function (n) {
    var liste = n.parentElement, groupe = liste && liste.parentElement;
    if (!groupe || !groupe.classList.contains('activite')) return;
    var items = [];
    for (var c = liste.firstElementChild; c; c = c.nextElementSibling) {
      var it = c.dataset.id && this.s.item(c.dataset.id);
      if (!it || c.hidden) continue;
      var etat = it.genre === 'outil' ? etatOutil(it, it.questionId ? this.s.item(it.questionId) : null).cls
        : (it.enCours ? 'encours' : 'ok');
      items.push({ it: it, etat: etat });
    }
    BT.majAtelier(groupe, items);
  };

  VueFil.prototype._remplirDetail = function (it, n) {
    var det = n.querySelector('.ligne-detail');
    if (!det) return;
    if (it.genre === 'reflexion') {
      if (it.texte) {
        var md = el('div', 'md md-petit reflexion-texte');
        md.appendChild(BT.rendreMarkdown(BT.nettoyerTexteClaude(it.texte), { enCours: it.enCours }));
        det.replaceChildren(md);
      } else {
        det.replaceChildren(el('div', 'od-note', 'Claude Code ne transmet pas le texte de la réflexion, seulement sa durée et sa taille.'));
      }
      return;
    }
    det.replaceChildren(BT.detailOutil(it, this.s));
  };

  VueFil.prototype._rendreNote = function (it, n) {
    n.className = (n.classList.contains('note-libre') ? 'note note-libre' : 'note') + ' niveau-' + it.niveau;
    var enfants = [el('span', 'note-texte', it.texte)];
    if (it.detail) {
      var d = el('details', 'note-detail', [el('summary', null, 'Détails'), BT.preLimite(it.detail, '', 20)]);
      enfants.push(d);
    }
    n.replaceChildren.apply(n, enfants);
  };

  /* Part du quota 5 h consommée par le tour : « ≈ 0,42 % du quota 5 h » (2 décimales sous 1 %, 1 au-delà). */
  function texteQuota(q) {
    if (!q || typeof q.pct !== 'number' || !isFinite(q.pct)) return '';
    var v = q.pct.toFixed(q.pct < 1 ? 2 : 1).replace('.', ',');
    return (q.approx ? '≈ ' : '') + v + ' % quota';
  }

  VueFil.prototype._rendreFin = function (it, n) {
    var t = it.interrompu ? 'Interrompu' : it.erreur ? 'Terminé sur une erreur' : 'Terminé';
    if (it.duree && !it.interrompu) t += ' en ' + BT.dureeLisible(it.duree);
    var q = texteQuota(it.quota);
    if (q) n.replaceChildren(document.createTextNode(t), el('span', 'fin-quota', ' · ' + q));
    else n.textContent = t;
    n.classList.toggle('est-erreur', !!it.erreur);
    // Pas de curseur à gérer ici : à la fin du tour, Claude Code a fermé tous les blocs ; chacun finit
    // d'afficher ses derniers caractères (≈ 0,1 s) puis retire son curseur.
  };

  /* Tout ouvrir / fermer (outils et réflexions) — utile pour les captures et le raccourci. */
  VueFil.prototype.toutDeplier = function (ouvrir) {
    var l = this.racine.querySelectorAll('details.ligne, details.activite');
    for (var i = 0; i < l.length; i++) l[i].open = ouvrir;
  };
})();
