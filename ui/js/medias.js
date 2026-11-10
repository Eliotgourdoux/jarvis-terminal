/* Jarvis Terminal — lecteur intégré pour les images, vidéos et sons locaux cités dans un message.
 * Détection : chemins absolus (/Users/…, ~/…) ou file:// finissant par une extension média, dans le texte,
 * le code en ligne, les liens et images markdown (data-media posé par markdown.js) et les pièces jointes.
 * Lecture : par le schéma btmedia:// de la coque (app/Sources/Medias.swift), seul moyen de lire un fichier
 * hors de ui/. Jamais de lecture automatique, jamais de boucle ; les GIF restent figés tant qu'on ne clique pas.
 * Les vocaux ogg / opus sont convertis par l'app et se lisent ici ; ce qui reste illisible devient un bouton « Ouvrir ». */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  var GENRES = {
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', heic: 'image',
    mp4: 'video', m4v: 'video', mov: 'video', webm: 'video',
    mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio'
  };
  var TYPES = {
    mp4: ['video/mp4'], m4v: ['video/x-m4v', 'video/mp4'], mov: ['video/quicktime'], webm: ['video/webm'],
    mp3: ['audio/mpeg'], m4a: ['audio/mp4', 'audio/x-m4a'], aac: ['audio/aac', 'audio/mp4'], wav: ['audio/wav'],
    flac: ['audio/flac', 'audio/x-flac'], ogg: ['audio/ogg; codecs="opus"', 'audio/ogg; codecs="vorbis"', 'audio/ogg'],
    oga: ['audio/ogg; codecs="opus"', 'audio/ogg; codecs="vorbis"', 'audio/ogg'], opus: ['audio/ogg; codecs="opus"', 'audio/opus']
  };
  var EXT = Object.keys(GENRES).join('|').replace('jpg|jpeg', 'jpe?g');
  var MAX = 12;  // lecteurs par message, au plus

  // Un chemin commence en début de texte ou après une espace / ponctuation ouvrante, jamais au milieu d'une URL.
  var RE_TEXTE = new RegExp('(^|[\\s(\\[{"\'«:=])((?:file:\\/\\/(?:localhost)?)?(?:~\\/|\\/(?!\\/))(?:\\\\ |[^\\s"\'`<>|*?\\[\\](){}\\\\])*?\\.(?:' + EXT + '))' +
    '(?=$|[\\s"\'`<>|)\\]},;:!?»]|\\.(?:\\s|$))', 'gi');
  var RE_ENTIER = new RegExp('^(?:file:\\/\\/(?:localhost)?)?(?:~\\/|\\/(?!\\/))[^\\n\\r<>|*?"`]*\\.(?:' + EXT + ')$', 'i');

  function extension(c) { var m = /\.([a-z0-9]+)$/i.exec(c || ''); return m ? m[1].toLowerCase() : ''; }
  function genre(c) { return GENRES[extension(c)] || null; }
  function nom(c) { return String(c).split('/').filter(Boolean).pop() || c; }

  /* « file:///Users/a%20b/x.png », « /Users/a\ b/x.png », « ~/x.png » → chemin propre, ou null. */
  function normaliser(brut) {
    var c = String(brut || '').trim();
    if (/^file:/i.test(c)) {
      c = c.replace(/^file:\/\/(?:localhost)?/i, '');
      try { c = decodeURIComponent(c); } catch (e) { return null; }
    }
    c = c.replace(/\\ /g, ' ');
    if (!/^(\/(?!\/)|~\/)/.test(c) || /[\0\n\r]/.test(c) || c.length > 4096) return null;
    if (/(^|\/)\.\.(\/|$)/.test(c)) return null;   // pas de remontée
    return genre(c) ? c : null;
  }

  function url(c) {
    var maison = /^~\//.test(c);
    var segs = (maison ? c.slice(2) : c.slice(1)).split('/').map(encodeURIComponent).join('/');
    return 'btmedia://' + (maison ? 'maison/' : 'fichier/') + segs;
  }

  function dansTexte(t) {
    var res = [], m;
    RE_TEXTE.lastIndex = 0;
    while ((m = RE_TEXTE.exec(String(t || '')))) {
      var c = normaliser(m[2]);
      if (c) res.push(c);
    }
    return res;
  }

  /* Parcourt un rendu (texte, code en ligne, data-media) dans l'ordre du document. Ignore les blocs de code. */
  function dansDom(racine) {
    var res = [];
    if (!racine) return res;
    var w = document.createTreeWalker(racine, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (n.nodeName === 'PRE' || n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' ||
            (n.classList && (n.classList.contains('bloc-code') || n.classList.contains('medias')))) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) {
        var p = n.parentNode;
        if (p && p.nodeName === 'CODE') continue;     // traité avec son <code>
        res.push.apply(res, dansTexte(n.nodeValue));
        continue;
      }
      if (n.dataset && n.dataset.media) { var d = normaliser(n.dataset.media); if (d) res.push(d); }
      if (n.nodeName === 'CODE') {
        var t = n.textContent.trim();
        if (RE_ENTIER.test(t)) { var e = normaliser(t); if (e) { res.push(e); continue; } }
        res.push.apply(res, dansTexte(t));
      }
    }
    return res;
  }

  /* ---------- Lecteurs ---------- */

  function el(tag, cls, texte) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texte != null) e.textContent = texte;
    return e;
  }

  function ouvrir(c) {
    var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.medias;
    if (h) h.postMessage({ type: 'ouvrir', chemin: c }); else console.log('[medias] ouvrir', c);
  }

  function boutonOuvrir(c) {
    var b = el('button', 'media-ouvrir', 'Ouvrir');
    b.type = 'button';
    b.title = 'Ouvrir dans l’app du Mac : ' + c;
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); ouvrir(c); });
    return b;
  }

  function legende(c, g) {
    var l = el('div', 'media-legende');
    l.appendChild(el('span', 'media-type', { image: 'Image', video: 'Vidéo', audio: 'Son' }[g]));
    var n = el('span', 'media-nom', nom(c));
    n.title = c;
    l.appendChild(n);
    l.appendChild(boutonOuvrir(c));
    return l;
  }

  /* Média illisible ici (format, fichier absent) : on le dit et on propose « Ouvrir ». */
  function repli(boite, c, raison) {
    boite.className = 'media media-repli';
    boite.replaceChildren(el('span', 'media-repli-texte', raison), el('span', 'media-nom', nom(c)), boutonOuvrir(c));
    boite.lastChild.previousSibling.title = c;
  }

  function lisible(c) {
    if (/^(ogg|oga|opus)$/.test(extension(c))) return true;   // l'app les convertit en m4a (Medias.swift, 10/11/2026)
    var types = TYPES[extension(c)];
    if (!types) return true;
    var m = document.createElement(genre(c) === 'video' ? 'video' : 'audio');
    if (!m.canPlayType) return true;
    return types.some(function (t) { return m.canPlayType(t) !== ''; });
  }

  function agrandir(src) {
    if (BT.agrandirImage) { BT.agrandirImage(src); return; }
    var fond = el('div', 'visionneuse');
    var img = document.createElement('img');
    img.src = src; img.alt = '';
    fond.appendChild(img);
    function fermer() { fond.remove(); document.removeEventListener('keydown', echap, true); }
    function echap(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermer(); } }
    fond.addEventListener('click', fermer);
    document.addEventListener('keydown', echap, true);
    document.body.appendChild(fond);
  }

  function lecteurImage(boite, c) {
    var src = url(c);
    var cadre = el('div', 'media-cadre');
    var img = document.createElement('img');
    img.alt = nom(c);
    img.decoding = 'async';
    img.loading = 'lazy';
    img.title = 'Cliquer pour agrandir';
    img.addEventListener('error', function () { repli(boite, c, 'Image illisible ici'); });
    img.addEventListener('click', function () { agrandir(src); });
    if (extension(c) === 'gif') {
      // GIF : figé sur sa première image (pas d'animation en boucle) ; un clic l'anime.
      var toile = document.createElement('canvas');
      toile.className = 'media-gif-fige';
      var source = new Image();
      source.addEventListener('load', function () {
        toile.width = source.naturalWidth; toile.height = source.naturalHeight;
        try { toile.getContext('2d').drawImage(source, 0, 0); } catch (e) { /* toile vide : le bouton reste */ }
      });
      source.addEventListener('error', function () { repli(boite, c, 'Image illisible ici'); });
      source.src = src;
      var jouer = el('button', 'media-gif-jouer', 'GIF · animer');
      jouer.type = 'button';
      jouer.addEventListener('click', function () { img.src = src; cadre.replaceChildren(img); });
      cadre.appendChild(toile);
      cadre.appendChild(jouer);
    } else {
      img.src = src;
      cadre.appendChild(img);
    }
    boite.appendChild(cadre);
  }

  function lecteurAV(boite, c, g) {
    if (!lisible(c)) { repli(boite, c, g === 'video' ? 'Vidéo non lisible ici' : 'Son non lisible ici'); return; }
    var m = document.createElement(g);
    m.controls = true;
    m.preload = 'metadata';
    m.autoplay = false;
    m.loop = false;
    if (g === 'video') { m.playsInline = true; m.setAttribute('playsinline', ''); }
    m.setAttribute('controlslist', 'nodownload');
    m.addEventListener('error', function () { repli(boite, c, g === 'video' ? 'Vidéo non lisible ici' : 'Son non lisible ici'); });
    // Vidéo : « #t=0.001 » fait afficher la première image au lieu d'un cadre noir (rien n'est lu pour autant).
    m.src = url(c) + (g === 'video' && extension(c) !== 'webm' ? '#t=0.001' : '');   // webm : le saut casse la lecture
    boite.appendChild(m);
  }

  /* ---------- Mur de vidéos ----------
   * Les vidéos d'un message forment un « mur » centré : rangées justifiées où chaque vidéo garde son format.
   * Le découpage en rangées est choisi parmi tous les possibles pour que le mur tienne à l'écran avec la plus
   * grande surface d'image, sans case trop étroite pour ses commandes. Une seule vidéo = un mur d'une case.
   * Taille commune à tous les murs, mémorisée : Petit, Colonne, Grand (largeur de la fenêtre) ou largeur tirée
   * à la poignée (double-clic : retour à Colonne). Rien ne démarre seul : « Tout lire » ne part que sur un clic. */
  var CLE_TAILLE = 'bt.medias.taille';
  var TAILLES = [['petit', 'Petit'], ['colonne', 'Colonne'], ['grand', 'Grand']];
  var ECART = 8, LEGENDE = 31, BARRE = 38, MIN_MUR = 320, MARGE = 24, PETIT = 480;

  function lireTaille() {
    try { var v = localStorage.getItem(CLE_TAILLE) || 'colonne'; return /^\d+$/.test(v) ? +v : v; } catch (e) { return 'colonne'; }
  }
  function ecrireTaille(v) { try { localStorage.setItem(CLE_TAILLE, String(v)); } catch (e) { /* stockage indisponible */ } }
  var taille = lireTaille();

  /* Disposition du mur. Règles validées par Eliot le 08/11/2026 :
   * - 2 horizontales au plus par rangée, 3 verticales (au-delà, illisibles ; à 2, les verticales laissent trop de vide) ;
   * - verticales d'un côté, horizontales (et carrées) de l'autre : jamais une verticale à côté d'une horizontale,
   *   où elle serait écrasée. L'ordre est gardé dans chaque groupe ; le groupe de la première vidéo passe en premier ;
   * - le mur peut être plus haut que l'écran (on fait défiler), mais chaque vidéo tient entière à l'écran.
   * ratios : largeur/hauteur de chaque vidéo ; W : largeur du mur ; H : hauteur d'écran utile ; leg : hauteur d'une légende.
   * Renvoie { rangs: [[indices]], hauteurs: [hauteur vidéo par rang], echelle: 1 }. */
  var PAR_RANG = { h: 2, v: 3 }, VERTICALE = 0.9;

  function disposer(ratios, W, H, leg) {
    var groupes = [], parSorte = {};
    ratios.forEach(function (r, i) {
      var sorte = r < VERTICALE ? 'v' : 'h';
      if (!parSorte[sorte]) { parSorte[sorte] = []; groupes.push(parSorte[sorte]); }
      parSorte[sorte].push(i);
    });
    var rangs = [], hauteurs = [];
    groupes.forEach(function (g) {
      var d = disposerGroupe(g.map(function (i) { return ratios[i]; }), W, H, leg, ratios[g[0]] < VERTICALE ? PAR_RANG.v : PAR_RANG.h);
      d.rangs.forEach(function (r, k) {
        rangs.push(r.map(function (j) { return g[j]; }));
        hauteurs.push(d.hauteurs[k]);
      });
    });
    return { rangs: rangs, hauteurs: hauteurs, echelle: 1 };
  }

  /* Un groupe de même sorte : tous les découpages en rangées d'au plus parRang vidéos (dans l'ordre), le meilleur gagne. */
  function disposerGroupe(ratios, W, H, leg, parRang) {
    var n = ratios.length, meilleur = null, plafond = Math.max(80, H - leg);
    for (var masque = 0; masque < (1 << (n - 1)); masque++) {
      var rangs = [[0]];
      for (var i = 1; i < n; i++) {
        if (masque & (1 << (i - 1))) rangs.push([i]); else rangs[rangs.length - 1].push(i);
      }
      if (rangs.some(function (r) { return r.length > parRang; })) continue;
      // Rangée justifiée sur toute la largeur ; plus haute que l'écran, elle se resserre au centre.
      var hs = rangs.map(function (r) {
        var somme = r.reduce(function (s, j) { return s + ratios[j]; }, 0);
        return Math.min((W - ECART * (r.length - 1)) / somme, plafond);
      });
      var surface = 0, remplie = 0;
      rangs.forEach(function (r, k) {
        var lr = ECART * (r.length - 1);
        r.forEach(function (j) { var l = hs[k] * ratios[j]; lr += l; surface += l * hs[k]; });
        remplie += lr / W / rangs.length;
      });
      var total = hs.reduce(function (s, h) { return s + h + leg; }, 0) + ECART * (rangs.length - 1);
      // Surface d'image, pondérée par la largeur occupée (pas une vidéo étroite au milieu du vide), la part du mur
      // visible d'un coup (au carré : sinon tout part en une vidéo par rangée, une liste et plus un mur)
      // et la régularité des rangées.
      var regularite = Math.sqrt(Math.min.apply(null, hs) / Math.max.apply(null, hs));
      var visible = Math.min(1, H / total);
      var score = surface * remplie * visible * visible * regularite;
      if (!meilleur || score > meilleur.score) meilleur = { rangs: rangs, hauteurs: hs, score: score };
    }
    return meilleur;
  }

  function hauteurDispo(mur) {
    var d = mur.closest('.defile');
    if (!d) return Math.max(240, window.innerHeight * 0.8 - BARRE);
    var pied = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hauteur-pied')) || 0;
    return Math.max(240, (d.clientHeight - pied) * 0.92 - BARRE - ECART);   // hauteur d'écran utile, sans la barre du mur
  }

  function largeurMur(mur) {
    var col = mur.parentNode ? mur.parentNode.clientWidth : 0;
    if (!col) return 0;
    if (mur.closest('.tour-eliot, .tg-eliot')) return col;
    var fen = Math.max(col, document.documentElement.clientWidth - 2 * MARGE);
    var w = taille === 'petit' ? PETIT : taille === 'colonne' ? col : taille === 'grand' ? fen : +taille || col;
    return Math.round(Math.max(Math.min(MIN_MUR, col), Math.min(w, fen)));
  }

  function disposerMur(mur) {
    var W = largeurMur(mur);
    if (!W || !mur._cases) return;
    var cases = mur._cases.filter(function (b) { return !b.classList.contains('media-repli'); });
    var replis = mur._cases.filter(function (b) { return b.classList.contains('media-repli'); });
    mur.classList.toggle('mur-vide', !cases.length);
    mur.querySelectorAll('.mur-tailles button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.taille === String(taille)));
    });
    var grille = mur.querySelector('.mur-grille');
    if (!cases.length) { mur.style.width = ''; mur.classList.remove('media-deborde'); grille.replaceChildren(); mur.querySelector('.mur-replis').replaceChildren.apply(mur.querySelector('.mur-replis'), replis); return; }
    var ratios = cases.map(function (b) {
      var v = b.querySelector('video');
      return v && v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    });
    var d = disposer(ratios, W, hauteurDispo(mur), cases.length > 1 ? LEGENDE : 0);
    var cle = d.rangs.map(function (r) { return r.join(','); }).join('|') + '#' + cases.length;
    if (mur._cle !== cle) {   // ne déplacer les vidéos que si le découpage change (une vidéo en cours ne doit pas sauter)
      mur._cle = cle;
      grille.replaceChildren.apply(grille, d.rangs.map(function (r) {
        var rang = el('div', 'mur-rang');
        r.forEach(function (j) { rang.appendChild(cases[j]); });
        return rang;
      }));
      var zr = mur.querySelector('.mur-replis');
      zr.replaceChildren.apply(zr, replis);
    }
    var contenu = 0;
    d.rangs.forEach(function (r, k) {
      var h = Math.floor(d.hauteurs[k] * d.echelle);
      contenu = Math.max(contenu, r.reduce(function (s, j) { return s + Math.floor(h * ratios[j]); }, ECART * (r.length - 1)));
      r.forEach(function (j) {
        cases[j].style.width = Math.floor(h * ratios[j]) + 'px';
        cases[j].classList.toggle('case-etroite', h * ratios[j] < 170);   // trop étroite pour le nom : « Ouvrir » seul
        var v = cases[j].querySelector('video');
        if (v) v.style.height = h + 'px';
      });
    });
    // Le mur épouse ses vidéos (une vidéo verticale seule n'étire pas sa barre sur toute la colonne).
    var col = mur.parentNode.clientWidth, larg = Math.max(contenu, Math.min(MIN_MUR, col));
    mur.style.width = larg + 'px';
    mur.classList.toggle('media-deborde', larg > col + 1);
  }

  var attente = 0;
  function disposerTout() {
    if (attente) return;
    attente = requestAnimationFrame(function () {
      attente = 0;
      document.querySelectorAll('.media-mur').forEach(disposerMur);
    });
  }
  if (window.addEventListener) window.addEventListener('resize', disposerTout);
  var observateur = window.ResizeObserver ? new ResizeObserver(function (es) {
    es.forEach(function (e) { disposerMur(e.target); });
  }) : null;

  function choisirTaille(t) { taille = t; ecrireTaille(t); disposerTout(); }

  function videosDe(mur) {
    return mur._cases.filter(function (b) { return !b.classList.contains('media-repli'); })
      .map(function (b) { return b.querySelector('video'); }).filter(Boolean);
  }

  /* Tout lire : chaque vidéo démarre ; le son reste sur une seule (la première non coupée), les autres sont coupées. */
  function toutLire(mur) {
    var vs = videosDe(mur);
    if (vs.some(function (v) { return !v.paused && !v.ended; })) { vs.forEach(function (v) { v.pause(); }); return; }
    var son = vs.filter(function (v) { return !v.muted; })[0] || vs[0];
    vs.forEach(function (v) {
      v.muted = v !== son;
      if (v.ended) v.currentTime = 0;
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* lecture refusée : la vidéo reste en pause */ });
    });
  }

  function majToutLire(mur) {
    var b = mur.querySelector('.mur-tout');
    if (!b) return;
    var vs = videosDe(mur);
    b.textContent = vs.some(function (v) { return !v.paused && !v.ended; }) ? 'Tout arrêter' : 'Tout lire';
  }

  function poignee(mur) {
    var p = el('div', 'mur-poignee');
    p.title = 'Glisser pour redimensionner · double-clic : largeur de la colonne';
    p.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      try { p.setPointerCapture(e.pointerId); } catch (x) { /* pointeur déjà relâché */ }
      mur.classList.add('mur-tire');
      var x0 = e.clientX, w0 = mur.offsetWidth;
      function bouge(ev) {
        // Le mur est centré : il grandit des deux côtés, donc deux fois le déplacement.
        taille = Math.max(MIN_MUR, Math.round(w0 + 2 * (ev.clientX - x0)));
        disposerTout();
      }
      function lache() {
        p.removeEventListener('pointermove', bouge);
        p.removeEventListener('pointerup', lache);
        p.removeEventListener('pointercancel', lache);
        mur.classList.remove('mur-tire');
        var fen = document.documentElement.clientWidth - 2 * MARGE;
        choisirTaille(taille >= fen ? 'grand' : taille);
      }
      p.addEventListener('pointermove', bouge);
      p.addEventListener('pointerup', lache);
      p.addEventListener('pointercancel', lache);
    });
    p.addEventListener('dblclick', function () { choisirTaille('colonne'); });
    return p;
  }

  function legendeCase(c) {
    var l = el('div', 'media-legende');
    var n = el('span', 'media-nom', nom(c));
    n.title = c;
    l.appendChild(n);
    l.appendChild(boutonOuvrir(c));
    return l;
  }

  function murVideos(chemins) {
    var mur = el('div', 'media-mur');
    var grille = el('div', 'mur-grille');
    mur._cases = chemins.map(function (c) {
      var boite = el('div', 'media media-video');
      boite.dataset.chemin = c;
      lecteurAV(boite, c, 'video');
      var v = boite.querySelector('video');
      if (v) {
        v.addEventListener('loadedmetadata', function () { mur._cle = null; disposerMur(mur); });
        v.addEventListener('error', function () { mur._cle = null; disposerMur(mur); });
        ['play', 'pause', 'ended'].forEach(function (t) { v.addEventListener(t, function () { majToutLire(mur); }); });
      }
      if (chemins.length > 1 && !boite.classList.contains('media-repli')) boite.appendChild(legendeCase(c));
      return boite;
    });
    mur._cases.forEach(function (b) { grille.appendChild(b); });

    var barre = el('div', 'media-legende mur-barre');
    if (chemins.length > 1) barre.appendChild(el('span', 'media-type', chemins.length + ' vidéos'));
    else {
      barre.appendChild(el('span', 'media-type', 'Vidéo'));
      var n = el('span', 'media-nom', nom(chemins[0]));
      n.title = chemins[0];
      barre.appendChild(n);
    }
    var tailles = el('div', 'mur-tailles');
    tailles.setAttribute('role', 'group');
    tailles.setAttribute('aria-label', 'Taille des vidéos');
    TAILLES.forEach(function (t) {
      var b = el('button', null, t[1]);
      b.type = 'button';
      b.dataset.taille = t[0];
      b.title = { petit: 'Petit', colonne: 'Largeur de la colonne', grand: 'Largeur de la fenêtre' }[t[0]];
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); choisirTaille(t[0]); });
      tailles.appendChild(b);
    });
    barre.appendChild(tailles);
    if (chemins.length > 1) {
      var tout = el('button', 'media-ouvrir mur-tout', 'Tout lire');
      tout.type = 'button';
      tout.title = 'Lire toutes les vidéos ensemble ; le son reste sur une seule';
      tout.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toutLire(mur); });
      barre.appendChild(tout);
    } else {
      barre.appendChild(boutonOuvrir(chemins[0]));
    }

    mur.appendChild(grille);
    mur.appendChild(el('div', 'mur-replis'));
    mur.appendChild(barre);
    mur.appendChild(poignee(mur));
    if (observateur) observateur.observe(mur);   // première mise en page dès que le mur est dans le fil
    return mur;
  }

  /* Lecteurs pour une liste de chemins (doublons retirés), ou null s'il n'y en a aucun.
   * Images et sons l'un sous l'autre ; toutes les vidéos ensemble dans un mur, à la place de la première. */
  function lecteurs(chemins) {
    var vus = Object.create(null), liste = [];
    (chemins || []).forEach(function (c) { c = normaliser(c); if (c && !vus[c] && liste.length < MAX) { vus[c] = 1; liste.push(c); } });
    if (!liste.length) return null;
    var box = el('div', 'medias');
    var videos = liste.filter(function (c) { return genre(c) === 'video'; }), murPose = false;
    liste.forEach(function (c) {
      var g = genre(c);
      if (g === 'video') {
        if (!murPose) { box.appendChild(murVideos(videos)); murPose = true; }
        return;
      }
      var boite = el('div', 'media media-' + g);
      boite.dataset.chemin = c;
      if (g === 'image') lecteurImage(boite, c); else lecteurAV(boite, c, g);
      if (!boite.classList.contains('media-repli')) boite.appendChild(legende(c, g));
      box.appendChild(boite);
    });
    return box;
  }

  /* Raccourci : lecteurs pour tout ce qu'un rendu cite (+ chemins en plus, pièces jointes par exemple). */
  function pour(racine, autres) {
    return lecteurs(dansDom(racine).concat(autres || []));
  }

  BT.medias = { genre: genre, normaliser: normaliser, url: url, dansTexte: dansTexte, dansDom: dansDom,
    lecteurs: lecteurs, pour: pour, ouvrir: ouvrir, disposer: disposer, disposerTout: disposerTout };
})();
