/* Jarvis Terminal — la conversation Telegram avec Jarvis (08/11/2026).
 * Source : ~/.claude/channels/telegram/jarvis/transcript.md, écrit par le routeur dans les deux sens :
 *   ## 2026-11-08 12:47 — Eliot (vocal, msg 3214)
 *   ## 2026-11-08 12:47 — moi (msg 3215)
 * Swift → page : fil.tout(texte) · fil.ajout(texte) · fil.etat({reflechit, enAttente, routeur}) · fil.envoye(id, ok, raison) · fil.focus()
 * Page → Swift : {type:'pret'} {type:'envoyer', id, texte} {type:'copier', texte} {type:'lien', url} {type:'fichier', chemin} */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var pont = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tg;
  function poster(o) { if (pont) pont.postMessage(o); else console.log('[tg]', o); }

  var $ = function (id) { return document.getElementById(id); };
  var defile = $('defile'), fil = $('fil'), attente = $('attente'), statut = $('statut');
  var saisie = $('saisie'), bouton = $('envoyer'), plus = $('plus-ancien'), enBas = $('en-bas');

  var PAGE = 120;            // messages affichés d'un coup
  var brut = '';
  var entrees = [];          // toutes les entrées parsées
  var debut = 0;             // index de la première entrée affichée
  var rendus = [];           // brut des entrées affichées (même ordre que les nœuds .tg-entree)
  var parId = {};            // id de message Telegram → entrée (pour les citations)
  var attentes = [];         // messages tapés ici, pas encore vus dans le transcript
  var etatRouteur = { reflechit: false, enAttente: false, routeur: true };

  function el(tag, cls, enfants) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (enfants != null) {
      (Array.isArray(enfants) ? enfants : [enfants]).forEach(function (c) {
        if (c == null) return;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return e;
  }

  /* ---------------- Lecture du transcript ---------------- */

  var RE_TETE = /^## (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) — (.+)$/gm;

  function parser(t) {
    var res = [], m, tetes = [];
    RE_TETE.lastIndex = 0;
    while ((m = RE_TETE.exec(t))) tetes.push({ i: m.index, fin: RE_TETE.lastIndex, jour: m[1], heure: m[2], qui: m[3] });
    tetes.forEach(function (h, k) {
      var corps = t.slice(h.fin + 1, k + 1 < tetes.length ? tetes[k + 1].i : t.length).replace(/\s+$/, '');
      var e = decrire(h.qui);
      e.jour = h.jour; e.heure = h.heure; e.corps = corps;
      e.brut = h.qui + '\n' + corps;
      res.push(e);
    });
    return res;
  }

  /* « Eliot (vocal, msg 3214) » → {auteur, genre, ids, reponseA} */
  function decrire(qui) {
    var auteur = /^moi\b/.test(qui) ? 'jarvis' : 'eliot';
    var p = /\(([^)]*)\)\s*$/.exec(qui), d = p ? p[1] : '';
    var ids = [], m, re = /\b(?:msg|,)\s*(\d{2,})/g;
    var avant = d.split(/en réponse au/)[0];
    while ((m = re.exec(avant))) ids.push(m[1]);
    var r = /en réponse au msg (\d+)/.exec(d);
    var genre = 'texte';
    if (/^vocal\b|\bvocal\b/.test(d)) genre = 'vocal';
    if (/fichier/.test(d)) genre = 'fichier';
    if (/^reel\b/.test(d)) genre = 'reel';
    if (/^réaction/.test(d)) genre = 'reaction';
    if (/^app\b/.test(d)) genre = 'app';
    if (/^réponse à une question/.test(d)) genre = 'reponse-question';
    if (/^question\b/.test(d)) genre = 'question';
    if (/^recap reels/.test(d)) genre = 'recap';
    if (/^brief du matin/.test(d)) genre = 'brief-matin';
    if (/^brief du soir/.test(d)) genre = 'brief-soir';
    return { auteur: auteur, genre: genre, ids: ids, reponseA: r ? r[1] : null };
  }

  /* ---------------- Rendu ---------------- */

  var JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  function jourLisible(j) {
    var p = j.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]);
    var auj = new Date(); auj.setHours(0, 0, 0, 0);
    var ecart = Math.round((auj - d) / 86400000);
    if (ecart === 0) return 'Aujourd’hui';
    if (ecart === 1) return 'Hier';
    var t = JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()];
    if (d.getFullYear() !== auj.getFullYear()) t += ' ' + d.getFullYear();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function nomFichier(p) { return String(p).split('/').filter(Boolean).pop() || p; }

  function boutonFichier(chemin, legende) {
    var b = el('button', 'tg-fichier', [/\.(jpe?g|png|gif|webp|heic)$/i.test(chemin) ? '📷' : '📎', el('span', null, nomFichier(chemin))]);
    if (legende) b.appendChild(el('small', null, legende));
    b.type = 'button';
    b.title = 'Montrer dans le Finder : ' + chemin;
    b.setAttribute('data-media', chemin);   // image, vidéo ou son : lu en dessous (js/medias.js)
    b.addEventListener('click', function () { poster({ type: 'fichier', chemin: chemin }); });
    return b;
  }

  /* Markdown + marqueurs du routeur ([[fichier: chemin | légende]], [[photo: …]]). */
  function contenuJarvis(texte) {
    var frag = document.createDocumentFragment();
    var re = /\[\[(fichier|photo):\s*([^\]|]+?)\s*(?:\|\s*([^\]]*?)\s*)?\]\]/g, m, dernier = 0;
    function md(t) {
      if (!t.trim()) return;
      var d = el('div', 'md');
      d.appendChild(BT.rendreMarkdown(t));
      frag.appendChild(d);
    }
    while ((m = re.exec(texte))) {
      md(texte.slice(dernier, m.index));
      frag.appendChild(boutonFichier(m[2], m[3]));
      dernier = re.lastIndex;
    }
    md(texte.slice(dernier));
    return frag;
  }

  function corpsJarvis(e) {
    var box = el('div', 'tg-corps');
    // Segments [[vocal]] / [[texte]] : chacun part sur son canal, on le signale.
    var morceaux = e.corps.split(/\[\[(vocal|texte)\]\]/);
    var mode = e.genre === 'vocal' ? 'vocal' : 'texte';
    for (var i = 0; i < morceaux.length; i++) {
      if (i % 2 === 1) { mode = morceaux[i]; continue; }
      var t = morceaux[i];
      if (!t.trim()) continue;
      if (mode === 'vocal') {
        var seg = el('div', 'tg-segment-vocal', [el('div', 'tg-signal', ['🔊 ', el('b', null, 'Envoyé en vocal')])]);
        seg.appendChild(contenuJarvis(t));
        box.appendChild(seg);
      } else box.appendChild(contenuJarvis(t));
    }
    return box;
  }

  function citation(e) {
    var cible = e.reponseA && parId[e.reponseA];
    if (!cible) return null;
    var t = cible.corps.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim();
    return el('div', 'tg-citation', '↩︎ ' + (cible.auteur === 'jarvis' ? 'Jarvis : ' : 'Toi : ') + t.slice(0, 160));
  }

  var ETIQUETTES = { vocal: 'Vocal', recap: 'Recap reels', 'brief-matin': 'Brief du matin', 'brief-soir': 'Brief du soir', question: 'Question Better Terminal' };

  function rendreEntree(e, precedente) {
    var n = el('div', 'tg-entree');
    if (!precedente || precedente.jour !== e.jour) n.appendChild(el('div', 'tg-jour', jourLisible(e.jour)));

    if (e.auteur === 'jarvis') {
      var tete = el('div', 'tour-tete', [el('span', 'tour-nom', 'Jarvis'), el('span', null, e.heure)]);
      if (ETIQUETTES[e.genre]) tete.appendChild(el('span', 'tg-etiquette', ETIQUETTES[e.genre]));
      var corps = corpsJarvis(e);
      var lecJ = BT.medias && BT.medias.pour(corps);
      if (lecJ) corps.appendChild(lecJ);
      var j = el('div', 'tg-jarvis', [tete, citation(e), corps]);
      n.appendChild(j);
      return n;
    }

    if (e.genre === 'reel') {
      var u = /(https?:\/\/\S+)/.exec(e.corps);
      n.appendChild(el('div', 'tg-evenement', ['🎞️ Reel partagé · ' + e.heure + (u ? ' · ' : ''), u ? lienTexte(u[1]) : null]));
      return n;
    }
    if (e.genre === 'reaction') {
      n.appendChild(el('div', 'tg-evenement', 'Tu as réagi ' + e.corps.trim() + ' · ' + e.heure));
      return n;
    }

    var box = el('div', 'tg-eliot' + (e.genre === 'app' ? ' tg-app' : ''));
    var sig = { vocal: '🎙️ Vocal transcrit', fichier: '📎 Fichier envoyé', app: '💻 Depuis Jarvis Terminal', 'reponse-question': '✓ Réponse à une question Better Terminal' }[e.genre];
    if (sig) box.appendChild(el('div', 'tg-signal', sig));
    var q = citation(e); if (q) box.appendChild(q);
    var texte = e.corps, fichier = null;
    if (e.genre === 'fichier') {
      var f = /enregistré ici : (\/[^\n—]+?)(?:\s+—\s+mon message qui l'accompagne : ([\s\S]*))?$/.exec(texte);
      if (f) { fichier = f[1].trim(); texte = (f[2] || '').trim(); }
    }
    var bulle = el('div', 'bulle');
    if (texte) bulle.appendChild(el('div', 'bulle-texte', texte));
    if (fichier) bulle.appendChild(boutonFichier(fichier));
    box.appendChild(bulle);
    var lecE = BT.medias && BT.medias.pour(bulle);
    if (lecE) box.appendChild(lecE);
    box.appendChild(el('div', 'bulle-meta', e.heure));
    n.appendChild(box);
    return n;
  }

  function lienTexte(url) {
    var a = el('a', 'tg-lien', url.length > 60 ? url.slice(0, 57) + '…' : url);
    a.href = url;
    return a;
  }

  /* ---------------- Mise à jour du fil ---------------- */

  function presDuBas() { return defile.scrollHeight - defile.scrollTop - defile.clientHeight < 80; }
  function allerEnBas() { defile.scrollTop = defile.scrollHeight; enBas.hidden = true; }

  function indexer() {
    parId = {};
    entrees.forEach(function (e) { e.ids.forEach(function (id) { parId[id] = e; }); });
  }

  function toutRendre() {
    fil.textContent = '';
    rendus = [];
    debut = Math.max(0, Math.min(debut, entrees.length - PAGE));
    for (var i = debut; i < entrees.length; i++) {
      fil.appendChild(rendreEntree(entrees[i], entrees[i - 1]));
      rendus.push(entrees[i].brut);
    }
    plus.hidden = debut === 0;
  }

  function majFil(collerEnBas) {
    var bas = collerEnBas || presDuBas();
    var avant = entrees.length;
    entrees = parser(brut);
    indexer();
    // Rotation du transcript, ou fil plus court : on repart de zéro.
    var k = 0, noeuds = fil.children;
    if (!rendus.length || entrees.length < avant || !entrees[debut] || entrees[debut].brut !== rendus[0]) {
      debut = Math.max(0, entrees.length - PAGE);
      toutRendre();
    } else {
      while (k < rendus.length && entrees[debut + k] && entrees[debut + k].brut === rendus[k]) k++;
      while (noeuds.length > k) fil.removeChild(fil.lastChild);
      rendus.length = k;
      for (var i = debut + k; i < entrees.length; i++) {
        fil.appendChild(rendreEntree(entrees[i], entrees[i - 1]));
        rendus.push(entrees[i].brut);
      }
    }
    nettoyerAttentes();
    majStatut();
    if (bas) allerEnBas(); else if (entrees.length > avant) enBas.hidden = false;
  }

  plus.addEventListener('click', function () {
    var h = defile.scrollHeight, t = defile.scrollTop;
    debut = Math.max(0, debut - PAGE);
    toutRendre();
    defile.scrollTop = defile.scrollHeight - h + t;   // on garde le message lu sous les yeux
  });

  defile.addEventListener('scroll', function () { if (presDuBas()) enBas.hidden = true; });
  enBas.addEventListener('click', allerEnBas);

  /* ---------------- Envoi ---------------- */

  /* Un message envoyé par Beeper revient dans le transcript comme un message Telegram ordinaire d'Eliot :
     on retire la bulle en attente dès qu'un message d'Eliot au même texte arrive après l'envoi. */
  function nettoyerAttentes() {
    attentes = attentes.filter(function (a) {
      if (a.etat === 'echec') return true;
      for (var i = Math.max(a.apres, entrees.length - 40); i < entrees.length; i++) {
        var e = entrees[i];
        if (e.auteur === 'eliot' && !e.pris && e.corps.trim() === a.texte) { e.pris = true; return false; }
      }
      return true;
    });
    rendreAttentes();
  }

  function rendreAttentes() {
    attente.textContent = '';
    attente.hidden = !attentes.length;
    attentes.forEach(function (a) {
      var box = el('div', 'tg-eliot ' + (a.etat === 'echec' ? 'tg-echec' : 'tg-en-cours'));
      box.appendChild(el('div', 'bulle', el('div', 'bulle-texte', a.texte)));
      if (a.etat === 'echec') {
        var meta = el('div', 'bulle-meta', 'Pas parti : ' + (a.raison || 'erreur inconnue') + ' ');
        var re = el('button', 'tg-reprendre', 'Remettre dans la saisie');
        re.type = 'button';
        re.addEventListener('click', function () {
          attentes = attentes.filter(function (x) { return x !== a; });
          saisie.value = a.texte + (saisie.value ? '\n' + saisie.value : '');
          ajuster(); rendreAttentes(); majStatut(); saisie.focus();
        });
        meta.appendChild(re);
        box.appendChild(meta);
      } else {
        box.appendChild(el('div', 'bulle-meta', a.etat === 'depose' ? 'Envoyé, Jarvis va le lire…' : 'Envoi par Beeper…'));
      }
      attente.appendChild(box);
    });
  }

  function majStatut() {
    var t = '', alerte = false;
    if (!etatRouteur.routeur) { t = 'Le routeur Jarvis ne tourne pas : tes messages arrivent dans Telegram, Jarvis les lira à son redémarrage.'; alerte = true; }
    else if (etatRouteur.reflechit) t = 'Jarvis réfléchit…';
    else if (etatRouteur.enAttente || attentes.some(function (a) { return a.etat !== 'echec'; })) t = 'Envoi à Jarvis…';
    statut.hidden = !t;
    statut.className = 'tg-statut' + (alerte ? ' alerte' : '');
    statut.textContent = '';
    if (t) { statut.appendChild(el('span', 'tg-point')); statut.appendChild(el('span', null, t)); }
  }

  function ajuster() {
    saisie.style.height = 'auto';
    saisie.style.height = Math.min(saisie.scrollHeight, 260) + 'px';
    bouton.disabled = !saisie.value.trim();
  }

  function envoyer() {
    var t = saisie.value.trim();
    if (!t) return;
    var id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    attentes.push({ id: id, texte: t, etat: 'envoi', apres: entrees.length });
    saisie.value = '';
    ajuster();
    rendreAttentes();
    majStatut();
    allerEnBas();
    poster({ type: 'envoyer', id: id, texte: t });
  }

  saisie.addEventListener('input', ajuster);
  saisie.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); envoyer(); }
  });
  bouton.addEventListener('click', envoyer);

  /* Liens, fichiers, boutons Copier : la vue ne navigue jamais. */
  document.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('.bt-copier');
    if (c) {
      e.preventDefault();
      var bloc = c.closest('.bloc-code');
      poster({ type: 'copier', texte: (bloc && (bloc.codeComplet || (bloc.querySelector('code') || {}).textContent)) || '' });
      c.textContent = 'Copié'; c.classList.add('fait');
      setTimeout(function () { c.textContent = 'Copier'; c.classList.remove('fait'); }, 1300);
      return;
    }
    var a = e.target.closest && e.target.closest('a');
    if (a) {
      e.preventDefault();
      var href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) poster({ type: 'lien', url: href });
    }
  });
  ['dragover', 'drop'].forEach(function (t) { window.addEventListener(t, function (e) { e.preventDefault(); }); });

  /* ---------------- API pour Swift ---------------- */

  window.fil = {
    tout: function (t) { brut = String(t || ''); entrees = []; rendus = []; fil.textContent = ''; majFil(true); },
    ajout: function (t) { brut += String(t || ''); majFil(false); },
    etat: function (e) { etatRouteur = e || etatRouteur; majStatut(); },
    envoye: function (id, ok, raison) {
      attentes.forEach(function (a) { if (a.id === id) { a.etat = ok ? 'depose' : 'echec'; a.raison = raison || ''; } });
      nettoyerAttentes(); majStatut();
    },
    focus: function () { saisie.focus(); }
  };

  ajuster();
  if (pont) poster({ type: 'pret' });
  else {
    // Aperçu dans un navigateur : faux transcript.
    document.documentElement.classList.add('dev');
    var j = new Date(), z = function (n) { return String(n).padStart(2, '0'); };
    var auj = j.getFullYear() + '-' + z(j.getMonth() + 1) + '-' + z(j.getDate());
    window.fil.tout([
      '', '## 2026-11-07 13:19 — moi (recap reels, msg 3089, en réponse au msg 3087)',
      '👀 **Exhuma ?** Récit de cercueil maudit.', '',
      '## 2026-11-07 22:30 — moi (brief du soir auto, msg 3090)', 'Bilan : trois tâches cochées, `todo` à jour.', '',
      '## ' + auj + ' 12:47 — Eliot (vocal, msg 3214)', 'Frérot, les stories promo, tout a déjà été posté.', '',
      '## ' + auj + ' 12:47 — moi (msg 3215)', 'Le brief se construit à partir de la **todo**.\n\n- score virtuel coché\n- quatre stories cochées', '',
      '## ' + auj + ' 13:02 — Eliot (reel, msg 3216)', 'https://www.instagram.com/reel/abc123/', '',
      '## ' + auj + ' 13:16 — Eliot (fichier, msg 3217)', 'J\'ai reçu un fichier sur Telegram, il est enregistré ici : /Users/eliot/Desktop/telegram-1.jpg — mon message qui l\'accompagne : regarde ça', '',
      '## ' + auj + ' 13:18 — moi (msg 3222)', 'Voilà le rendu :\n[[fichier: /Users/eliot/Desktop/BreakingBad-ep04-v1.mp4 | Ép.4]]\n```bash\nsessions lancer qg\n```', '',
      '## ' + auj + ' 14:06 — Eliot (app, msg 3223)', 'fais en sorte que j\'ai aussi ma conv avec toi dans l\'ui', ''
    ].join('\n'));
    window.fil.etat({ reflechit: true, enAttente: false, routeur: true });
  }
})();
