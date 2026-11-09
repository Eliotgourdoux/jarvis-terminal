/* Better Terminal For Claude — barre du haut, zone de saisie, bannière d'attente,
 * liste « Mes messages » et raccourcis clavier. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var el = BT.el;

  var ALIAS = ['default', 'opus', 'fable', 'sonnet', 'haiku'];
  var TEXTES_ETAT = { travaille: 'Claude travaille', attend: 'Attend ta réponse', pret: 'Prêt', termine: 'Session terminée' };

  function $(id) { return document.getElementById(id); }

  function Interface(app) {
    this.app = app;
    this.s = app.session;
    this._minuteur = 0;
    this._initBarre();
    this._initSaisie();
    this._initBanniere();
    this._initMesMessages();
    this._initRaccourcis();
    this._majEtat(this.s.etat || 'pret');
  }
  BT.Interface = Interface;

  /* ================= Barre du haut ================= */

  Interface.prototype._initBarre = function () {
    var self = this, s = this.s;
    this.selModele = $('choix-modele');
    this.selEffort = $('choix-effort');
    this.selPermission = $('choix-permission');
    BT.PERMISSIONS.forEach(function (p) { var o = option(p.value, p.label); o.title = p.detail; self.selPermission.appendChild(o); });
    s.on('info', function (info) { self._majInfo(info); });
    s.on('jetons', function (j) { self._majJetons(j); });
    s.on('modeles', function () { self._majInfo(s.etatInfo()); });
    s.on('etat', function (etat) { self._majEtat(etat); });
    s.on('activite', function () { self._majStatut(); });
    s.on('vocal', function () { self._majPlaceholder(); });

    this.selModele.addEventListener('change', function () { ajusterLargeur(self.selModele); s.changerModele(self.selModele.value); });
    this.selEffort.addEventListener('change', function () { ajusterLargeur(self.selEffort); s.changerEffort(self.selEffort.value); });
    this.selPermission.addEventListener('change', function () { ajusterLargeur(self.selPermission); s.changerPermission(self.selPermission.value); });
    // Terminal : deux boutons. Ouvrir un shell dans le dossier (Claude continue ici), ou passer la session au terminal.
    $('bt-shell').addEventListener('click', function () { BT.pont.envoyer('ouvrirShell', {}); });
    $('bt-terminal').addEventListener('click', function () { BT.pont.envoyer('ouvrirTerminal', {}); });

    // Compacter (/compact) : deux clics, comme Fermer, pour qu'un clic égaré ne résume pas la conversation.
    var compacter = $('bt-compacter'), armeC = 0;
    function desarmerC() { clearTimeout(armeC); armeC = 0; compacter.classList.remove('arme'); compacter.querySelector('.libelle').textContent = 'Compacter'; }
    compacter.addEventListener('click', function () {
      if (compacter.disabled) return;
      if (!armeC) {
        compacter.classList.add('arme');
        compacter.querySelector('.libelle').textContent = 'Compacter maintenant ?';
        armeC = setTimeout(desarmerC, 3500);
        return;
      }
      desarmerC();
      if (s.envoyerMessage('/compact') && self.app.defilement) self.app.defilement.allerEnBas();
    });
    this._desarmerCompacter = desarmerC;

    var fermer = $('bt-fermer'), arme = 0;
    fermer.addEventListener('click', function () {
      if (s.travaille && !arme) {
        fermer.classList.add('arme');
        fermer.querySelector('.libelle').textContent = 'Claude travaille : confirmer';
        arme = setTimeout(function () { arme = 0; fermer.classList.remove('arme'); fermer.querySelector('.libelle').textContent = 'Fermer'; }, 3500);
        return;
      }
      clearTimeout(arme); arme = 0;
      BT.pont.envoyer('fermer', {});
    });
    this._majInfo(s.etatInfo());
    this._majJetons(s.jetons);
  };

  /* Total de jetons de la session : chiffre compact, détail au survol. */
  function compact(n) {
    if (n >= 1e6) return (n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: n >= 1e8 ? 0 : 1 }) + ' M';
    if (n >= 1e3) return Math.round(n / 1e3).toLocaleString('fr-FR') + ' k';
    return String(n);
  }
  function entier(n) { return Math.round(n).toLocaleString('fr-FR'); }
  Interface.prototype._majJetons = function (j) {
    var e = $('barre-jetons');
    if (!e || !j) return;
    var total = j.entree + j.sortie + j.cacheLu + j.cacheEcrit;
    e.hidden = !total;
    e.textContent = compact(total) + ' jetons';
    e.title = 'Total de la session : ' + entier(total) + ' jetons\n' +
      '· lus en cache : ' + entier(j.cacheLu) + '\n' +
      '· écrits en cache : ' + entier(j.cacheEcrit) + '\n' +
      '· entrée : ' + entier(j.entree) + '\n' +
      '· sortie (écrits par Claude) : ' + entier(j.sortie) +
      (j.cout ? '\nÉquivalent API depuis l’ouverture : ' + j.cout.toLocaleString('fr-FR', { style: 'currency', currency: 'USD' }) : '');
  };

  function cheminCourt(p) {
    return String(p || '').replace(/^\/Users\/[^/]+/, '~');
  }

  Interface.prototype._majInfo = function (info) {
    info = info || this.s.etatInfo();
    var nom = info.projet || BT.basename(info.cwd) || 'Claude';
    $('barre-emoji').textContent = info.emoji || '';
    $('barre-emoji').hidden = !info.emoji;
    $('barre-nom').textContent = nom;
    $('barre-cwd').textContent = cheminCourt(info.cwd);
    $('barre-cwd').title = info.cwd || '';
    document.title = (info.emoji ? info.emoji + ' ' : '') + nom;
    $('titre-fenetre').textContent = (cheminCourt(info.cwd) || nom) + (info.dansTerminal ? ' — dans le Terminal' : '');
    // Bande native de la coque : 28 px en haut pour déplacer la fenêtre, 78 px à gauche pour les feux.
    var bt = info.barreTitre || {};
    var racine = document.documentElement.style;
    if (bt.hauteur != null) racine.setProperty('--titre-h', bt.hauteur + 'px');
    if (bt.gauche != null) racine.setProperty('--feux-l', bt.gauche + 'px');

    // Modèles : alias d'abord, autres versions ensuite.
    var sel = this.selModele, val = this.s.valeurModele();
    var modeles = info.modeles || [];
    var principaux = [], autres = [];
    modeles.forEach(function (m) { (ALIAS.indexOf(m.value) >= 0 ? principaux : autres).push(m); });
    principaux.sort(function (a, b) { return ALIAS.indexOf(a.value) - ALIAS.indexOf(b.value); });
    var tout = principaux.concat(autres);
    if (val && !tout.some(function (m) { return m.value === val; })) principaux.push({ value: val, displayName: val });
    sel.replaceChildren();
    principaux.forEach(function (m) { sel.appendChild(option(m.value, libelleModele(m))); });
    if (autres.length) {
      var g = document.createElement('optgroup');
      g.label = 'Autres versions';
      autres.forEach(function (m) { g.appendChild(option(m.value, m.displayName || m.value)); });
      sel.appendChild(g);
    }
    sel.value = val;
    sel.title = info.modeleResolu ? 'Servi par ' + info.modeleResolu : '';

    // Effort : niveaux pris en charge par le modèle choisi.
    var m = tout.filter(function (x) { return x.value === val; })[0];
    var niveaux = m && m.supportedEffortLevels ? m.supportedEffortLevels : BT.EFFORTS.map(function (e) { return e.value; });
    var se = this.selEffort;
    se.replaceChildren();
    if (!info.effort) {
      var ref = BT.EFFORTS.filter(function (e) { return e.value === info.effortDefaut; })[0];
      se.appendChild(option('', ref ? 'Par défaut (' + ref.label + ')' : 'Par défaut'));
    }
    BT.EFFORTS.forEach(function (e) { if (niveaux.indexOf(e.value) >= 0) se.appendChild(option(e.value, e.label)); });
    se.value = info.effort || '';
    se.disabled = m && m.supportsEffort === false;
    // Permissions : le mode courant (init, initialize ou dernier choix).
    var sp = this.selPermission, pm = info.permissionMode || 'bypassPermissions';
    if (!BT.PERMISSIONS.some(function (p) { return p.value === pm; })) {
      if (!sp.querySelector('option[value="' + CSS.escape(pm) + '"]')) sp.appendChild(option(pm, pm));
    }
    sp.value = pm;
    var pInfo = BT.PERMISSIONS.filter(function (p) { return p.value === pm; })[0];
    $('choix-permission-boite').title = pInfo ? pInfo.detail : 'Ce que Claude peut faire sans te demander';
    $('choix-permission-boite').classList.toggle('permission-libre', pm === 'bypassPermissions');
    $('choix-permission-boite').classList.toggle('permission-plan', pm === 'plan');
    sp.disabled = !!info.dansTerminal;
    ajusterLargeur(sel);
    ajusterLargeur(se);
    ajusterLargeur(sp);
  };

  /* Un <select> natif prend la largeur de sa plus longue option : on l'ajuste au choix affiché. */
  var mesure = null;
  function ajusterLargeur(sel) {
    var o = sel.options[sel.selectedIndex];
    if (!o) return;
    if (!mesure) mesure = document.createElement('canvas').getContext('2d');
    var cs = getComputedStyle(sel);
    mesure.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    sel.style.width = Math.ceil(mesure.measureText(o.textContent).width + 36) + 'px';
  }
  BT.ajusterLargeurSelect = ajusterLargeur;

  function libelleModele(m) {
    if (m.value === 'default') return 'Par défaut' + (m.description && m.description.length < 24 ? ' (' + m.description + ')' : '');
    return m.displayName || m.value;
  }
  function option(v, t) { var o = document.createElement('option'); o.value = v; o.textContent = t; return o; }

  Interface.prototype._majEtat = function (etat) {
    var b = $('barre-etat');
    b.className = 'barre-etat etat-' + etat;
    $('barre-etat-texte').textContent = etat === 'termine' && this.s.dansTerminal ? 'Dans le Terminal' : (TEXTES_ETAT[etat] || etat);
    document.body.dataset.etat = etat;
    $('bt-arreter').hidden = etat !== 'travaille';
    var bc = $('bt-compacter');
    bc.disabled = etat === 'travaille' || etat === 'termine';
    bc.title = etat === 'travaille' ? 'Compacter : possible quand Claude a fini' : 'Résumer la conversation pour libérer du contexte (/compact)';
    if (bc.disabled && this._desarmerCompacter) this._desarmerCompacter();
    var self = this;
    clearInterval(this._minuteur);
    this._minuteur = 0;
    if (etat === 'travaille') this._minuteur = setInterval(function () { self._majStatut(); }, 1000);
    this._majStatut();
    this._majBanniere();
    this._majPlaceholder();
  };

  /* Ligne d'état dans la zone de saisie : « Claude travaille · 12 s · Bash ls -la ». */
  Interface.prototype._majStatut = function () {
    var s = this.s, t = '';
    if (s.etat === 'travaille') {
      t = 'Claude travaille';
      if (s.debutTravail) {
        var d = Date.now() - s.debutTravail;
        if (d >= 2000) t += ' · ' + BT.dureeLisible(d);
      }
      if (s.activite) t += ' · ' + s.activite;
      $('barre-etat-texte').textContent = 'Claude travaille';
    } else if (s.etat === 'attend') t = 'Claude attend ta réponse';
    else if (s.etat === 'termine') t = s.dansTerminal ? 'La session continue dans le Terminal : cette fenêtre est en lecture seule.' : 'Session terminée : rouvre-la dans le terminal pour continuer.';
    var st = $('saisie-statut');
    st.querySelector('.saisie-statut-texte').textContent = t;
    st.hidden = !t;
    st.className = 'saisie-statut etat-' + s.etat;
    var aide = $('saisie-aide'); if (aide) aide.hidden = !!t;
  };

  /* ================= Zone de saisie ================= */

  Interface.prototype._initSaisie = function () {
    var self = this, s = this.s;
    var ta = this.ta = $('saisie-texte');
    var envoyer = $('bt-envoyer');

    function ajuster() {
      ta.style.height = 'auto';
      var max = Math.round(window.innerHeight * 0.4);
      ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
      ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
      envoyer.disabled = !ta.value.trim() && !self.pieces.length;
    }
    this.ajusterSaisie = ajuster;
    this._initPieces();
    this._initCommandes();   // avant le gestionnaire d'Entrée : le menu « / » passe en premier
    if (this._initDictee) this._initDictee();   // Espace maintenu : dictée (js/dictee.js)
    ta.addEventListener('input', ajuster);
    this._initHistoriqueSaisie();
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        self.envoyer();
      }
    });
    envoyer.addEventListener('click', function () { self.envoyer(); });
    $('bt-arreter').addEventListener('click', function () { s.interrompre(); });

    // Hauteur du pied → marge basse du fil (le dernier message n'est jamais caché).
    var pied = $('pied');
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        document.documentElement.style.setProperty('--hauteur-pied', pied.offsetHeight + 'px');
        if (self.app.defilement && self.app.defilement.colle) self.app.defilement.enBas();
      }).observe(pied);
    }
    var barre = $('barre');
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        document.documentElement.style.setProperty('--hauteur-barre', barre.offsetHeight + 'px');
      }).observe(barre);
    }
    ajuster();
  };

  /* ================= Images jointes : coller (⌘V), glisser-déposer, ou bouton ================= */

  var TYPES_IMAGE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  var COTE_MAX = 2000;            // px, côté le plus long envoyé à Claude
  var POIDS_MAX = 3.6 * 1024 * 1024;   // octets ; l'API refuse au-delà de 5 Mo en base64
  var PIECES_MAX = 20;
  var COPIE_MAX = 40 * 1024 * 1024;   // fichier sans chemin (collé, glissé d'un navigateur) : copié par Swift

  function lireDataURL(blob) {
    return new Promise(function (ok, ko) {
      var r = new FileReader();
      r.onload = function () { ok(r.result); };
      r.onerror = function () { ko(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function chargerImage(url) {
    return new Promise(function (ok, ko) {
      var i = new Image();
      i.onload = function () { ok(i); };
      i.onerror = function () { ko(new Error('image illisible')); };
      i.src = url;
    });
  }
  /* Une image prête à envoyer : { type, donnees (base64), apercu (data URL) }. Réduite si trop grande. */
  function preparerImage(fichier) {
    return lireDataURL(fichier).then(function (url) {
      return chargerImage(url).then(function (img) {
        var w = img.naturalWidth, h = img.naturalHeight;
        var type = TYPES_IMAGE.indexOf(fichier.type) >= 0 ? fichier.type : 'image/png';
        if (TYPES_IMAGE.indexOf(fichier.type) >= 0 && fichier.size <= POIDS_MAX && Math.max(w, h) <= COTE_MAX) {
          return { type: type, apercu: url, donnees: url.slice(url.indexOf(',') + 1) };
        }
        var k = Math.min(1, COTE_MAX / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var sortie = c.toDataURL('image/png');
        if (sortie.length * 0.75 > POIDS_MAX) sortie = c.toDataURL('image/jpeg', 0.88);
        if (sortie.length * 0.75 > POIDS_MAX) sortie = c.toDataURL('image/jpeg', 0.7);
        return { type: sortie.slice(5, sortie.indexOf(';')), apercu: sortie, donnees: sortie.slice(sortie.indexOf(',') + 1) };
      });
    });
  }

  /* Taille lisible : 12 Ko, 3,4 Mo. */
  BT.tailleLisible = function (o) {
    if (typeof o !== 'number' || o < 0) return '';
    if (o < 1024) return o + ' o';
    var u = ['Ko', 'Mo', 'Go'], v = o / 1024, k = 0;
    while (v >= 1024 && k < u.length - 1) { v /= 1024; k++; }
    return (v < 10 ? v.toFixed(1).replace('.', ',') : Math.round(v)) + ' ' + u[k];
  };

  /* Pastille d'un fichier joint (saisie et bulles) : clic → le montrer dans le Finder. */
  BT.pastilleFichier = function (f, retirer) {
    var dossier = f.chemin.replace(/\/+$/, '').split('/').slice(0, -1).join('/').replace(/^\/Users\/[^/]+/, '~') || '/';
    var meta = [f.dossier ? 'Dossier' : (/\.([a-z0-9]{1,8})$/i.exec(f.nom) || [, 'Fichier'])[1].toUpperCase(), BT.tailleLisible(f.taille)]
      .filter(Boolean).join(' · ');
    var n = el('div', 'fichier' + (f.dossier ? ' fichier-dossier' : ''), [
      el('span', 'fichier-nom', f.nom),
      el('span', 'fichier-meta', meta + ' · ' + dossier)
    ]);
    n.title = f.chemin + '\nCliquer pour le montrer dans le Finder';
    n.addEventListener('click', function () { BT.pont.envoyer('montrerFichier', { chemin: f.chemin }); });
    if (retirer) {
      var x = BT.bouton('piece-retirer', '×', function (e) { e.stopPropagation(); retirer(); });
      x.title = 'Retirer le fichier'; x.setAttribute('aria-label', 'Retirer ' + f.nom);
      n.appendChild(x);
    }
    return n;
  };

  Interface.prototype._initPieces = function () {
    var self = this, ta = this.ta;
    this.pieces = [];
    var input = $('saisie-fichier');
    // Dans l'app : panneau natif (chemins réels, tout type de fichier, dossiers compris).
    $('bt-joindre').addEventListener('click', function () {
      if (ta.disabled) return;
      if (BT.pont.natif) BT.pont.envoyer('choisirFichiers'); else input.click();
    });
    input.addEventListener('change', function () {
      self.joindre(Array.prototype.slice.call(input.files || []));
      input.value = '';
    });
    ta.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      var fichiers = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) fichiers.push(f); }
      }
      if (!fichiers.length) return;
      e.preventDefault();
      // Fichiers copiés dans le Finder : Swift lit leurs vrais chemins ; sinon (capture d'écran…) on garde ceux de la page.
      if (BT.pont.natif) { self._collage = fichiers; BT.pont.envoyer('collerFichiers'); }
      else self.joindre(fichiers);
    });
    // Glisser-déposer n'importe où dans la page. Les fichiers du Finder sont pris par Swift (chemins réels) ;
    // ici n'arrivent que ceux sans chemin (image glissée depuis un navigateur…).
    var saisie = document.querySelector('.saisie'), profondeur = 0;
    this._finDepot = function () { profondeur = 0; saisie.classList.remove('depot'); };
    function aDesFichiers(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
    document.addEventListener('dragenter', function (e) {
      if (!aDesFichiers(e)) return;
      e.preventDefault(); profondeur++; saisie.classList.add('depot');
    });
    document.addEventListener('dragleave', function (e) {
      if (!aDesFichiers(e)) return;
      if (--profondeur <= 0) self._finDepot();
    });
    document.addEventListener('dragover', function (e) {
      if (!aDesFichiers(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', function (e) {
      if (!aDesFichiers(e)) return;
      e.preventDefault(); self._finDepot();
      self.joindre(Array.prototype.slice.call(e.dataTransfer.files || []));
    });
  };

  Interface.prototype._ajouterPiece = function (p) {
    if (this.pieces.length >= PIECES_MAX) { this.s._note('avert', 'Au plus ' + PIECES_MAX + ' pièces jointes par message.'); return false; }
    if (p.chemin && this.pieces.some(function (x) { return x.chemin === p.chemin; })) return false;
    this.pieces.push(p);
    return true;
  };

  /* Fichiers de la page (sans chemin) : images → envoyées telles quelles ; le reste → copié par Swift sur le disque. */
  Interface.prototype.joindre = function (fichiers) {
    var self = this;
    Promise.all(fichiers.map(function (f) {
      if (TYPES_IMAGE.indexOf(f.type) >= 0 || /^image\//.test(f.type)) {
        return preparerImage(f).then(function (p) { p.nom = f.name; return p; })
          .catch(function () { self.s._note('avert', 'Image illisible : ' + (f.name || 'sans nom') + '.'); return null; });
      }
      if (!BT.pont.natif) { self.s._note('avert', 'Hors de l’app, seules les images peuvent être jointes.'); return null; }
      if (f.size > COPIE_MAX) { self.s._note('avert', f.name + ' est trop lourd pour être copié (' + BT.tailleLisible(f.size) + ') : glisse-le depuis le Finder.'); return null; }
      return lireDataURL(f).then(function (url) {
        BT.pont.envoyer('enregistrerPiece', { nom: f.name || 'fichier', donnees: url.slice(url.indexOf(',') + 1) });
        return null;   // revient par bt.fichiers une fois écrit
      });
    })).then(function (l) {
      l.forEach(function (p) { if (p) self._ajouterPiece(p); });
      self._majPieces();
      self.ta.focus();
    });
  };

  /* Swift → page : fichiers choisis, déposés, collés ou copiés. { origine, liste: [{ chemin, nom, taille, dossier, mime, donnees? }] } */
  Interface.prototype.recevoirFichiers = function (d) {
    var self = this, liste = (d && d.liste) || [];
    if (this._finDepot) this._finDepot();
    if (d && d.origine === 'collage') {
      var page = this._collage || []; this._collage = null;
      if (!liste.length) { if (page.length) this.joindre(page); return; }
    }
    Promise.all(liste.map(function (f) {
      if (!f || !f.chemin) return null;
      // Une image lue par Swift passe en image (Claude la voit directement), le reste en chemin.
      if (f.donnees && TYPES_IMAGE.indexOf(f.mime) >= 0) {
        return fetch('data:' + f.mime + ';base64,' + f.donnees).then(function (r) { return r.blob(); })
          .then(function (b) { return preparerImage(new File([b], f.nom, { type: f.mime })); })
          .then(function (p) { p.nom = f.nom; p.chemin = f.chemin; return p; })
          .catch(function () { return { fichier: true, chemin: f.chemin, nom: f.nom, taille: f.taille, dossier: !!f.dossier }; });
      }
      return { fichier: true, chemin: f.chemin, nom: f.nom, taille: f.taille, dossier: !!f.dossier };
    })).then(function (l) {
      l.forEach(function (p) { if (p) self._ajouterPiece(p); });
      self._majPieces();
      self.ta.focus();
    });
  };

  Interface.prototype._majPieces = function () {
    var self = this, box = $('saisie-pieces');
    box.replaceChildren();
    this.pieces.forEach(function (p, i) {
      function retirer() { self.pieces.splice(i, 1); self._majPieces(); self.ta.focus(); }
      if (p.fichier) { box.appendChild(BT.pastilleFichier(p, retirer)); return; }
      var img = document.createElement('img');
      img.src = p.apercu; img.alt = p.nom || 'Image jointe ' + (i + 1);
      img.title = p.chemin || p.nom || '';
      img.addEventListener('click', function () { BT.agrandirImage(p.apercu); });
      var x = BT.bouton('piece-retirer', '×', retirer);
      x.title = 'Retirer l’image'; x.setAttribute('aria-label', 'Retirer l’image ' + (i + 1));
      box.appendChild(el('div', 'piece', [img, x]));
    });
    box.hidden = !this.pieces.length;
    this.ajusterSaisie();
  };

  /* Agrandir une image (bulle ou pièce jointe) : clic ou Échap pour fermer. */
  BT.agrandirImage = function (src) {
    var fond = el('div', 'visionneuse');
    var img = document.createElement('img');
    img.src = src; img.alt = '';
    fond.appendChild(img);
    function fermer() { fond.remove(); document.removeEventListener('keydown', echap, true); }
    function echap(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermer(); } }
    fond.addEventListener('click', fermer);
    document.addEventListener('keydown', echap, true);
    document.body.appendChild(fond);
  };

  Interface.prototype._majPlaceholder = function () {
    var s = this.s, q = s.questionsEnAttente()[0];
    var p = BT.pont.natif ? 'Écris à Claude, ou maintiens Espace pour dicter…' : 'Écris à Claude…';
    if (s.etat === 'termine') p = s.dansTerminal ? 'La session est dans le Terminal.' : 'La session est terminée.';
    else if (q) p = q.type === 'permission' ? 'Écris ici pour refuser en expliquant quoi faire à la place…' : 'Réponds ci-dessus, ou écris ici ta réponse…';
    else if (s.etat === 'travaille') p = 'Écris un message : Claude le prendra en compte pendant son travail…';
    else if (s.vocal && s.vocal.actif) p = 'Écris à Claude, ou parle-lui' + (s.vocal.raccourci ? ' en maintenant ' + s.vocal.raccourci : ' avec Jarvis') + '…';
    this.ta.placeholder = p;
    this.ta.disabled = s.etat === 'termine';
  };

  /* ↑ / ↓ dans la zone de saisie : rappelle les messages déjà envoyés, comme dans Claude Code.
     ↑ agit quand le curseur est sur la première ligne, ↓ sur la dernière ; sinon les flèches
     déplacent le curseur dans le texte. Le brouillon en cours est gardé et revient après le plus récent. */
  Interface.prototype._initHistoriqueSaisie = function () {
    var self = this, ta = this.ta;
    this._histoPos = -1;        // -1 : brouillon ; 0 : dernier message envoyé ; 1 : l'avant-dernier…
    this._histoBrouillon = '';
    this._histoCommandes = [];  // commandes de l'app (/model…) : jamais envoyées à Claude, donc absentes du fil

    var liste = this._listeHisto = function () {
      var l = self.s.messagesEliot().map(function (m) { return m.texte || ''; }).concat(self._histoCommandes);
      var r = [];
      for (var i = l.length - 1; i >= 0; i--) {   // du plus récent au plus ancien, sans doublon voisin ni vide
        var t = l[i];
        if (t.trim() && t !== r[r.length - 1]) r.push(t);
      }
      return r;
    };

    function montrer(texte, auDebut) {
      ta.value = texte;
      var p = auDebut && texte.indexOf('\n') >= 0 ? 0 : texte.length;
      ta.setSelectionRange(p, p);
      self.ajusterSaisie();
    }

    ta.addEventListener('input', function () { if (self._histoPos >= 0 && !ta.value) self._histoPos = -1; });

    ta.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || e.isComposing) return;
      var a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
      if (a !== b) return;
      var l = liste();
      if (e.key === 'ArrowUp') {
        if (v.lastIndexOf('\n', a - 1) >= 0) return;        // pas sur la première ligne
        if (self._histoPos + 1 >= l.length) return;
        if (self._histoPos < 0) self._histoBrouillon = v;
        self._histoPos++;
        e.preventDefault();
        montrer(l[self._histoPos], true);
      } else {
        if (self._histoPos < 0 || v.indexOf('\n', b) >= 0) return;   // pas en navigation, ou pas sur la dernière ligne
        self._histoPos--;
        e.preventDefault();
        montrer(self._histoPos < 0 ? self._histoBrouillon : l[self._histoPos], false);
      }
    });
  };

  /* « Modifier » sur un message : le texte revient dans la zone de saisie. Le brouillon en cours
     n'est pas perdu : on se place dans l'historique sur ce message, et ↓ redescend jusqu'au brouillon. */
  Interface.prototype.reprendreTexte = function (texte) {
    var ta = this.ta;
    if (ta.disabled) return;
    if (this._histoPos < 0) this._histoBrouillon = ta.value;
    var i = this._listeHisto ? this._listeHisto().indexOf(texte) : -1;
    this._histoPos = i;
    ta.value = texte;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(texte.length, texte.length);
    this.ajusterSaisie();
  };

  /* « Renvoyer » : le même texte repart tel quel, sans toucher au brouillon. */
  Interface.prototype.renvoyerTexte = function (texte) {
    if (this.ta.disabled || !texte.trim()) return;
    if (this.s.envoyerMessage(texte) && this.app.defilement) this.app.defilement.allerEnBas();
  };

  /* Envoi : si une question attend, le texte y répond (comme « préciser » dans Claude Code). */
  Interface.prototype.envoyer = function () {
    var texte = this.ta.value;
    var pieces = this.pieces || [];
    if (!texte.trim() && !pieces.length) return;
    var s = this.s, q = s.questionsEnAttente()[0];
    if (pieces.length) {
      // Avec des pièces jointes : toujours un message normal (une réponse de question n'en transporte pas).
      var images = pieces.filter(function (p) { return !p.fichier; }).map(function (p) { return { type: p.type, donnees: p.donnees }; });
      if (!s.envoyerMessage(texte, undefined, images, pieces.filter(function (p) { return p.fichier; }))) return;
      this.pieces = [];
      this._majPieces();
    } else if (q) {
      if (q.type === 'questions') {
        var i = q.questions.findIndex(function (x) { return !x.brouillon; });
        if (i < 0) i = 0;
        var reps = q.questions.map(function (x, k) { return k === i ? texte.trim() : x.brouillon; });
        if (reps.every(function (v) { return v; })) s.repondre(q.id, { reponses: reps }, 'mac');
        else s.brouillon(q.id, i, texte.trim(), 'mac');
      } else {
        s.repondre(q.id, { decision: 'refuser', message: texte.trim() }, 'mac');
      }
    } else if (this.commandeApp && this.commandeApp(texte)) {
      // /model, /effort, /permissions : pilotent les menus de la barre, rien n'est envoyé à Claude
      if (this._histoCommandes) this._histoCommandes.push(texte);
    } else if (!s.envoyerMessage(texte)) {
      return;
    }
    this._histoPos = -1;
    this._histoBrouillon = '';
    this.ta.value = '';
    this.ajusterSaisie();
    if (this.app.defilement) this.app.defilement.allerEnBas();
  };

  /* Utilisé par le faux pont (développement) pour rejouer les messages enregistrés. */
  Interface.prototype.simulerSaisie = function (texte) {
    this.ta.value = texte;
    this.ajusterSaisie();
    this.envoyer();
  };

  /* ================= Bannière « Claude attend ta réponse » ================= */

  Interface.prototype._initBanniere = function () {
    var self = this;
    this.s.on('ajout', function (it) { if (it.genre === 'question') self._majBanniere(); });
    this.s.on('maj', function (it) { if (it.genre === 'question') self._majBanniere(); });
  };

  Interface.prototype._majBanniere = function () {
    var s = this.s, b = $('banniere');
    var l = s.questionsEnAttente();
    var q = l[0];
    if (!q) { b.hidden = true; b._q = null; return; }
    if (b._q === q.id && !b.hidden) return;
    b._q = q.id;
    var app = this.app;
    var titre = q.type === 'permission' ? 'Autorisation demandée' : q.type === 'plan' ? 'Plan à valider' : 'Claude te pose une question';
    var actions = el('div', 'banniere-actions');
    function voir() {
      var n = app.vue.noeud(q.id);
      if (n) { app.defilement.allerA(n); setTimeout(function () { BT.focusQuestion(n); }, 350); }
    }
    if (q.type === 'permission') {
      actions.appendChild(BT.bouton('bouton-principal petit', 'Autoriser', function () { s.repondre(q.id, { decision: 'autoriser' }, 'mac'); }));
      actions.appendChild(BT.bouton('bouton-refus petit', 'Refuser', function () { s.repondre(q.id, { decision: 'refuser' }, 'mac'); }));
      actions.appendChild(BT.bouton('bouton-discret petit', 'Voir', voir));
    } else {
      actions.appendChild(BT.bouton('bouton-principal petit', q.type === 'plan' ? 'Voir le plan' : 'Répondre', voir));
    }
    b.replaceChildren(
      el('span', 'banniere-point'),
      el('div', 'banniere-texte', [el('div', 'banniere-titre', titre + (l.length > 1 ? ' · ' + l.length + ' en attente' : '')),
        el('div', 'banniere-question', s.texteQuestion(q))]),
      actions);
    b.hidden = false;
  };

  /* ================= « Mes messages » ================= */

  Interface.prototype._initMesMessages = function () {
    var self = this, s = this.s;
    var bouton = $('bt-mes-messages'), pop = $('mes-messages');
    function compter() { bouton.querySelector('.compte').textContent = String(s.messagesEliot().length); }
    s.on('ajout', function (it) { if (it.genre === 'eliot') compter(); });
    s.on('historique', compter);
    compter();
    bouton.addEventListener('click', function (e) { e.stopPropagation(); if (pop.hidden) self.ouvrirMesMessages(); else self.fermerMesMessages(); });
    document.addEventListener('click', function (e) { if (!pop.hidden && !pop.contains(e.target)) self.fermerMesMessages(); });
  };

  Interface.prototype.ouvrirMesMessages = function () {
    var s = this.s, app = this.app, self = this;
    var pop = $('mes-messages'), liste = pop.querySelector('.popover-liste');
    liste.replaceChildren();
    var msgs = s.messagesEliot();
    if (!msgs.length) liste.appendChild(el('li', 'popover-vide', 'Aucun message pour l’instant.'));
    msgs.forEach(function (m, i) {
      var b = BT.bouton('popover-ligne', [el('span', 'popover-heure', BT.heure(m.date)), el('span', 'popover-texte', BT.tronquer(m.texte.replace(/\s+/g, ' '), 140))], function () {
        self.fermerMesMessages();
        app.defilement.allerA(app.vue.noeud(m.id));
      });
      liste.appendChild(el('li', null, [b]));
    });
    var rb = $('bt-mes-messages').getBoundingClientRect();
    pop.style.right = Math.max(10, window.innerWidth - rb.right - 40) + 'px';
    pop.hidden = false;
    $('bt-mes-messages').classList.add('actif');
    var der = liste.lastElementChild;
    if (der) der.scrollIntoView({ block: 'end' });
    var dernierBouton = liste.querySelector('li:last-child button');
    if (dernierBouton) dernierBouton.focus({ preventScroll: true });
  };

  Interface.prototype.fermerMesMessages = function () {
    $('mes-messages').hidden = true;
    $('bt-mes-messages').classList.remove('actif');
  };

  /* ================= Raccourcis ================= */

  Interface.prototype._initRaccourcis = function () {
    var self = this, app = this.app, s = this.s;
    document.addEventListener('keydown', function (e) {
      var cible = e.target, dansChamp = cible && /^(TEXTAREA|INPUT|SELECT)$/.test(cible.nodeName);
      // Cmd seulement : Ctrl+F (et fn+Ctrl+F « Remplir » de macOS) doivent rester au système.
      var cmd = e.metaKey && !e.ctrlKey;
      var k = (e.key || '').toLowerCase();

      if (cmd && !e.altKey && k === 'f') { e.preventDefault(); app.recherche.ouvrir(); return; }
      if (cmd && !e.altKey && k === 'g') { e.preventDefault(); app.recherche.aller(e.shiftKey ? -1 : 1); return; }

      // ⌥↑ / ⌥↓ : message précédent / suivant d'Eliot
      if (e.altKey && !cmd && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && (!dansChamp || !cible.value)) {
        e.preventDefault();
        if (e.key === 'ArrowUp') app.defilement.eliotPrecedent(); else app.defilement.eliotSuivant();
        return;
      }

      if (e.key === 'Escape') {
        if (!$('mes-messages').hidden) { self.fermerMesMessages(); e.preventDefault(); return; }
        if (app.recherche.ouverte) { app.recherche.fermer(); e.preventDefault(); return; }
        if (s.etat === 'travaille' && (!dansChamp || cible === self.ta)) { s.interrompre(); e.preventDefault(); }
        return;
      }

      // 1-9 : choisir une option de la question en attente (hors champ de texte)
      if (!dansChamp && !cmd && !e.altKey && /^[1-9]$/.test(e.key)) {
        var q = s.questionsEnAttente()[0];
        if (q && q.type === 'questions' && BT.choisirOptionClavier(app.vue.noeud(q.id), parseInt(e.key, 10))) { e.preventDefault(); return; }
      }

      // Taper n'importe où écrit dans la zone de saisie.
      if (!dansChamp && !cmd && !e.altKey && e.key && e.key.length === 1 && !self.ta.disabled &&
          !(cible && cible.closest && cible.closest('button, a, summary, .popover'))) {
        self.ta.focus({ preventScroll: true });
      }
    });
  };
})();
