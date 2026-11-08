/* Leviers à crans pour Modèle et Effort (08/11/2026), affichés dans le panneau des menus de la barre (menus.js).
 * Le <select> caché reste la source de vérité : le levier lit ses options et, au relâchement, passe par
 * `choisir(valeur)` de menus.js, qui change sel.value et déclenche « change ». interface.js appelle alors
 * session.changerModele (set_model) ou session.changerEffort (apply_flag_settings), comme avant.
 * Rien n'est appliqué pendant qu'on glisse : seulement au relâchement (souris) ou après les flèches (clavier). */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  // Du plus léger au plus capable. Les alias sont ceux de session.js / interface.js (pas les identifiants complets).
  var MODELES = [
    { value: 'haiku', libelle: 'Haiku 5.5' },
    { value: 'sonnet', libelle: 'Sonnet 5.5' },
    { value: 'opus', libelle: 'Opus 5.5' },
    { value: 'fable', libelle: 'Fable 5.1' }
  ];
  var DELAI_CLAVIER = 450;   // ms après la dernière flèche relâchée

  function info() { return BT.app && BT.app.session ? BT.app.session.etatInfo() : {}; }
  function optionDe(sel, v) {
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === v) return sel.options[i];
    return null;
  }
  function texteChoisi(sel) { var o = sel.options[sel.selectedIndex]; return o ? o.textContent : ''; }
  function div(cls, txt) { var d = document.createElement('div'); d.className = cls; if (txt != null) d.textContent = txt; return d; }

  /* Crans du levier : { value, libelle, dispo } + position « neutre » quand la valeur courante n'est pas un cran. */
  function cransModele(sel) {
    return MODELES.map(function (m) {
      var o = optionDe(sel, m.value);
      // Le nom renvoyé par claude (« Opus 5.5 ») si on l'a, sinon le nom connu.
      var t = o && /\d/.test(o.textContent) && o.textContent.length <= 14 ? o.textContent : m.libelle;
      return { value: m.value, libelle: t, dispo: !!o && !o.disabled };
    });
  }
  function cransEffort(sel) {
    return (BT.EFFORTS || []).map(function (e) {
      var o = optionDe(sel, e.value);
      return { value: e.value, libelle: e.label, dispo: !!o && !o.disabled };
    });
  }
  /* Où poser le pouce (en creux) quand la valeur n'est pas un cran : « Par défaut » ou une autre version. */
  function neutreModele(sel, crans) {
    var v = sel.value, inf = info(), ms = inf.modeles || [];
    var resolu = '';
    if (v === 'default') {
      var d = ms.filter(function (m) { return m.value === 'default'; })[0];
      resolu = (d && d.resolvedModel) || inf.modeleResolu || '';
    } else resolu = v;
    for (var i = 0; i < crans.length; i++) {
      var m = ms.filter(function (x) { return x.value === crans[i].value; })[0];
      if (m && m.resolvedModel && m.resolvedModel === resolu) return i;
    }
    for (var j = 0; j < crans.length; j++) if (resolu && resolu.indexOf(crans[j].value) >= 0) return j;
    return -1;
  }
  function neutreEffort(sel, crans) {
    var d = info().effortDefaut;
    for (var i = 0; i < crans.length; i++) if (crans[i].value === d) return i;
    return -1;
  }

  /* Panneau complet : en-tête, levier, puis les choix hors échelle (Par défaut, autres versions).
   * rappels : choisir(v) applique et ferme ; appliquer(v) applique sans fermer. */
  function creer(genre, sel, rappels) {
    var crans = genre === 'modele' ? cransModele(sel) : cransEffort(sel);
    var titre = genre === 'modele' ? 'Modèle' : 'Effort';
    var n = crans.length;
    var indexDe = function (v) { for (var i = 0; i < n; i++) if (crans[i].value === v) return i; return -1; };
    var courant = indexDe(sel.value);
    var neutre = courant >= 0 ? -1 : (genre === 'modele' ? neutreModele(sel, crans) : neutreEffort(sel, crans));
    var apercu = courant >= 0 ? courant : neutre;   // cran montré par le pouce
    var touche = false;                              // l'utilisateur a déplacé le pouce
    var enAttente = 0;

    var panneau = div('choix-menu levier-panneau');
    panneau.setAttribute('role', 'dialog');
    panneau.setAttribute('aria-label', titre);

    var tete = div('levier-tete');
    tete.appendChild(div('levier-titre', titre));
    var valeur = div('levier-valeur');
    tete.appendChild(valeur);
    panneau.appendChild(tete);

    var levier = div('levier');
    levier.tabIndex = 0;
    levier.setAttribute('role', 'slider');
    levier.setAttribute('aria-label', titre);
    levier.setAttribute('aria-valuemin', '0');
    levier.setAttribute('aria-valuemax', String(n - 1));
    levier.title = 'Glisse, ou ← → puis Entrée';
    var piste = div('levier-piste');
    var rempli = div('levier-rempli');
    piste.appendChild(rempli);
    var points = crans.map(function (c, i) {
      var p = div('levier-cran' + (c.dispo ? '' : ' indispo'));
      p.style.left = pourcent(i);
      piste.appendChild(p);
      return p;
    });
    var pouce = div('levier-pouce');
    piste.appendChild(pouce);
    levier.appendChild(piste);
    var libelles = div('levier-libelles');
    var textes = crans.map(function (c, i) {
      var l = document.createElement('span');
      l.className = 'levier-libelle' + (c.dispo ? '' : ' indispo') + (i === 0 ? ' premier' : i === n - 1 ? ' dernier' : '');
      l.textContent = c.libelle;
      if (!c.dispo) l.title = genre === 'effort' ? 'Pas pris en charge par ce modèle' : 'Pas proposé par Claude Code ici';
      l.style.left = pourcent(i);
      libelles.appendChild(l);
      return l;
    });
    levier.appendChild(libelles);
    panneau.appendChild(levier);

    // Choix hors échelle : « Par défaut » et, pour le modèle, les autres versions. Mêmes lignes que l'ancien menu.
    var hors = [];
    Array.prototype.forEach.call(sel.children, function (nd) {
      if (nd.tagName === 'OPTGROUP') {
        if (!nd.children.length) return;
        hors.push({ groupe: nd.label });
        Array.prototype.forEach.call(nd.children, function (o) { hors.push({ option: o }); });
      } else if (indexDe(nd.value) < 0) hors.push({ option: nd });
    });
    if (hors.length) {
      var bas = div('levier-hors');
      hors.forEach(function (h) {
        if (h.groupe) { bas.appendChild(div('choix-groupe', h.groupe)); return; }
        var o = h.option, it = document.createElement('button');
        it.type = 'button';
        it.className = 'choix-item' + (o.value === sel.value ? ' actif' : '');
        it.textContent = o.textContent;
        it.disabled = o.disabled;
        it.addEventListener('click', function () { annulerAttente(); rappels.choisir(o.value); });
        bas.appendChild(it);
      });
      panneau.appendChild(bas);
    }

    function pourcent(i) { return (n > 1 ? (i / (n - 1)) * 100 : 50) + '%'; }
    function dessiner() {
      var i = apercu, actif = i >= 0 && (touche || courant >= 0);
      levier.classList.toggle('neutre', !actif);
      levier.classList.toggle('vide', i < 0);
      pouce.style.left = i >= 0 ? pourcent(i) : '0%';
      rempli.style.width = actif ? pourcent(i) : '0%';
      points.forEach(function (p, k) { p.classList.toggle('atteint', actif && k <= i); p.classList.toggle('actif', actif && k === i); });
      textes.forEach(function (t, k) { t.classList.toggle('actif', actif && k === i); t.classList.toggle('repere', !actif && k === i); });
      levier.setAttribute('aria-valuenow', String(Math.max(0, i)));
      var t = actif ? crans[i].libelle : texteChoisi(sel);
      levier.setAttribute('aria-valuetext', t);
      valeur.textContent = t;
      valeur.classList.toggle('change', actif && crans[i].value !== sel.value);
    }
    function plusProche(i) {
      if (i >= 0 && i < n && crans[i].dispo) return i;
      for (var d = 1; d < n; d++) {
        if (i - d >= 0 && i - d < n && crans[i - d].dispo) return i - d;
        if (i + d >= 0 && i + d < n && crans[i + d].dispo) return i + d;
      }
      return -1;
    }
    function indexSouris(x) {
      var r = piste.getBoundingClientRect();
      var f = r.width ? (x - r.left) / r.width : 0;
      return plusProche(Math.round(Math.max(0, Math.min(1, f)) * (n - 1)));
    }
    function valeurApercu() { return apercu >= 0 && crans[apercu].dispo ? crans[apercu].value : null; }

    /* ---- Souris / trackpad : rien n'est appliqué avant le relâchement ---- */
    var glisse = null;
    levier.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      annulerAttente();
      levier.focus({ preventScroll: true });
      glisse = { id: e.pointerId, depart: apercu, surPouce: e.target === pouce, bouge: false };
      try { levier.setPointerCapture(e.pointerId); } catch (_) {}
      var i = indexSouris(e.clientX);
      if (i >= 0 && !glisse.surPouce) { apercu = i; touche = true; }
      levier.classList.add('glisse');
      dessiner();
    });
    levier.addEventListener('pointermove', function (e) {
      if (!glisse || e.pointerId !== glisse.id) return;
      var i = indexSouris(e.clientX);
      if (i >= 0 && i !== apercu) { apercu = i; touche = true; glisse.bouge = true; dessiner(); }
    });
    function finGlisse(e, valider) {
      if (!glisse || e.pointerId !== glisse.id) return;
      var g = glisse;
      glisse = null;
      levier.classList.remove('glisse');
      var v = valeurApercu();
      if (!valider) { apercu = g.depart; touche = courant >= 0 ? touche : false; dessiner(); return; }
      // Un simple clic sur le pouce, sans le bouger, ne change rien (évite de figer « Par défaut » par mégarde).
      if (g.surPouce && !g.bouge) { touche = courant >= 0; apercu = g.depart; dessiner(); return; }
      if (v && v !== sel.value) rappels.choisir(v);
    }
    levier.addEventListener('pointerup', function (e) { finGlisse(e, true); });
    levier.addEventListener('pointercancel', function (e) { finGlisse(e, false); });

    /* ---- Clavier : ← → (et ↑ ↓, Début, Fin) déplacent ; appliqué au relâchement des flèches, ou par Entrée ---- */
    function pas(sens) {
      var depart = apercu < 0 ? (sens > 0 ? -1 : n) : apercu;
      for (var i = depart + sens; i >= 0 && i < n; i += sens) if (crans[i].dispo) return i;
      return apercu;
    }
    levier.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key, i = null;
      if (k === 'ArrowRight' || k === 'ArrowUp') i = pas(1);
      else if (k === 'ArrowLeft' || k === 'ArrowDown') i = pas(-1);
      else if (k === 'Home') i = plusProche(0);
      else if (k === 'End') i = plusProche(n - 1);
      else if (k === 'Enter' || k === ' ') {
        e.preventDefault(); e.stopPropagation();
        annulerAttente();
        var v = valeurApercu();
        if (v && v !== sel.value && (touche || courant >= 0)) rappels.choisir(v); else rappels.fermer();
        return;
      }
      if (i === null) {
        // Une lettre tapée ici ne doit pas partir dans la zone de saisie (raccourci global d'interface.js).
        if (k && k.length === 1) e.stopPropagation();
        return;
      }
      e.preventDefault(); e.stopPropagation();
      annulerAttente();
      if (i >= 0 && (i !== apercu || !touche)) { apercu = i; touche = true; dessiner(); }
    });
    levier.addEventListener('keyup', function (e) {
      if (!/^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(e.key) || !touche) return;
      annulerAttente();
      enAttente = setTimeout(appliquerAttente, DELAI_CLAVIER);
    });
    function appliquerAttente() {
      enAttente = 0;
      var v = valeurApercu();
      if (v && v !== sel.value) {
        rappels.appliquer(v);
        courant = indexDe(sel.value);
        dessiner();
      }
    }
    function annulerAttente() { if (enAttente) { clearTimeout(enAttente); enAttente = 0; } }

    dessiner();
    return {
      noeud: panneau,
      focus: function () { levier.focus({ preventScroll: true }); },
      /* Fermeture par clic dehors ou perte de focus : un choix au clavier encore en attente est appliqué. */
      avantFermeture: function () { if (enAttente) { clearTimeout(enAttente); appliquerAttente(); } },
      /* Échap : on oublie ce qui n'a pas encore été appliqué. */
      annuler: function () { annulerAttente(); }
    };
  }

  BT.Leviers = { creer: creer, GENRES: { 'choix-modele': 'modele', 'choix-effort': 'effort' } };
})();
