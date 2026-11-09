/* Better Terminal For Claude — mode vocal « Jarvis » : ce que Jarvis dit, et ce qu'Eliot lui répond.
 *
 * AUCUN accès au DOM : fonctions pures, testées sous Node (ui/tests/banc-vocal.js).
 * Dépend seulement de commun.js (BT.nettoyerTexteClaude, BT.resumeOutil, BT.tronquer).
 *
 *   BT.vocal.resumeFin(texte)            fin de tour : la ligne « ✅ … » sans l'emoji ; à défaut, la première
 *                                        ou les deux premières phrases, sans markdown, environ 200 caractères
 *   BT.vocal.phraseQuestion(spec)        « te demande : <question> Un : <option>. Deux : … » (la coque ajoute le projet)
 *   BT.vocal.listeOptions(spec)          « Un : Pomme. Deux : Poire. »
 *   BT.vocal.textePermission(outil, entree, description)   « d’écrire le fichier notes.md »
 *   BT.vocal.interpreter(phrase, spec)   phrase dictée → réponse à la question, ou échec
 *   BT.vocal.parasite(texte)             transcription vide, ou hallucination connue de whisper
 *
 * spec = { type: 'choix' | 'multi' | 'permission' | 'plan', texte, options: [{ label, decision? }],
 *          libre (texte libre accepté, vrai par défaut), rang (0 = première sous-question) }
 *   decision (permission et plan) : 'autoriser' | 'toujours' | 'refuser'
 *
 * interpreter renvoie :
 *   { ok: true, genre: 'choix', indices: [0, 2], labels: ['Pomme', 'Kiwi'] }
 *   { ok: true, genre: 'libre', texte: 'Je préfère la mangue' }
 *   { ok: true, genre: 'decision', decision: 'refuser', message: 'Mets plutôt ça dans notes.md' }
 *   { ok: false, raison: 'vide' | 'ambigu' | 'hors-limite' | 'incompris' }
 */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var V = BT.vocal = {};

  V.PAS_COMPRIS = "Je n'ai pas compris, réponds par un numéro.";
  V.MAX_RESUME = 200;

  function ens(s) {
    var o = Object.create(null);
    s.split(/\s+/).forEach(function (m) { if (m) o[m] = true; });
    return o;
  }
  function echec(raison) { return { ok: false, raison: raison }; }

  /* ================= Normalisation ================= */

  /* « L’option n°2, s’il te plaît ! » → « l option n 2 s il te plait » */
  V.normaliser = function (t) {
    return String(t == null ? '' : t).toLowerCase()
      .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  };
  function jetons(t) { var n = V.normaliser(t); return n ? n.split(' ') : []; }

  /* Phrase dictée telle qu'on la garde (texte libre, message de refus) : sans le point final de whisper. */
  function propre(t) {
    return String(t == null ? '' : t).replace(/\s+/g, ' ').trim()
      .replace(/^[«"“\s]+|[»"”\s]+$/g, '')
      .replace(/([^.])\.$/, '$1')
      .trim();
  }

  /* ================= Vocabulaire ================= */

  var CARD = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };
  var ORD = { premier: 1, premiere: 1, second: 2, seconde: 2, deuxieme: 2, troisieme: 3, quatrieme: 4, cinquieme: 5,
    sixieme: 6, septieme: 7, huitieme: 8, neuvieme: 9, dixieme: 10 };
  var MOTS_NOMBRES = ['un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix'];

  /* « 2 », « 2e », « deuxième », « deux » → 2 ; sinon null. */
  function nombre(t) {
    if (t == null) return null;
    if (/^\d{1,2}$/.test(t)) return +t;
    var m = /^(\d{1,2})(?:er|re|ere|e|eme|ieme|nd|nde)$/.exec(t);
    if (m) return +m[1];
    if (CARD[t]) return CARD[t];
    if (ORD[t]) return ORD[t];
    return null;
  }
  function chiffre(t) { return CARD[t] ? String(CARD[t]) : t; } // « dix minutes » = « 10 minutes »

  var VIDES = ens('euh heu hum hmm hm mmh mh bah ben beh bon ah oh eh hein alors donc voila voici bref');
  var POLITESSE = ens('merci stp svp s il te vous plait steuplait please');
  var STOP = ens('le la les l de du des d un une et ou a au aux en pour par sur avec dans the of to and or an');
  var CONTEXTE = ens('le la l numero num no n option options choix reponse proposition element item');
  var LIAISON = ens('et ou puis plus avec aussi ainsi ni a');
  var OUINON = ens('oui ouais non nan ok okay yes no');
  var CONNUS = ens('je j veux voudrais prends prend prendre prendrais choisis choisit choisi choisir choisirais opte ' +
    'mets met mettre garde prefere preferee aime c est ce ca cela celui celle ceux celles ci ici moi pour qui que quoi y ' +
    'seulement juste uniquement simplement plutot mais bien tres vraiment mieux beaucoup parce alors vais va on nous ' +
    'les pas enfin pardon finalement fait dire');
  /* Mots courants jamais rapprochés d'un libellé par approximation (« comme » n'est pas « Pomme »). */
  var COURANTS = ens('comme voire faire notre votre quand avant apres entre toute toutes cette celle celles autre autres ' +
    'encore juste merci alors sinon parce pour dans sans avec mais donc elle elles nous vous leur leurs tres bien deja ' +
    'aussi plus moins veux voudrais prends choisis mets garde option choix reponse numero premier premiere dernier ' +
    'derniere deux trois quatre quoi rien tous tout aucun aucune sauf toujours jamais');

  function connu(t) {
    return VIDES[t] || POLITESSE[t] || STOP[t] || CONTEXTE[t] || LIAISON[t] || OUINON[t] || CONNUS[t] || nombre(t) !== null;
  }

  /* ================= Rapprochement des mots ================= */

  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    var p = [], i, j;
    for (j = 0; j <= b.length; j++) p[j] = j;
    for (i = 1; i <= a.length; i++) {
      var c = [i];
      for (j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      p = c;
    }
    return p[b.length];
  }
  function racine(t) { return t.length > 3 ? t.replace(/[sx]$/, '') : t; }

  /* Même mot, au pluriel près, ou à une faute de transcription près pour un mot assez long. */
  function memeMot(a, b) {
    if (a === b) return true;
    if (chiffre(a) === chiffre(b)) return true;
    var ra = racine(a), rb = racine(b);
    if (ra === rb) return true;
    if (/\d/.test(a) || /\d/.test(b)) return false;
    if (COURANTS[a] || COURANTS[b]) return false;
    if (ra.charAt(0) !== rb.charAt(0)) return false;
    var l = Math.min(ra.length, rb.length);
    if (l < 5) return false;
    return lev(ra, rb) <= (l >= 8 ? 2 : 1);
  }

  function preparer(options) {
    return (options || []).map(function (o, i) {
      var label = typeof o === 'string' ? o : (o && o.label) || '';
      var tous = jetons(label);
      var sig = tous.filter(function (t) { return !STOP[t]; });
      if (!sig.length) sig = tous;
      return { index: i, label: label, decision: o && typeof o === 'object' ? o.decision : undefined, sig: sig };
    });
  }

  /* Libellés présents dans la phrase. Un libellé complet l'emporte ; un libellé partiel ne compte que sur
   * un mot qui n'appartient qu'à lui, et jamais sur un nombre (« deux » désigne alors le numéro deux).
   * Un libellé inclus dans un autre trouvé (« Autoriser » dans « Toujours autoriser ») s'efface. */
  function chercherLibelles(js, libres, opts, etat) {
    var cands = [];
    opts.forEach(function (o) {
      if (!o.sig.length) return;
      var pris = [], vus = [];
      o.sig.forEach(function (t, k) {
        for (var i = 0; i < js.length; i++) {
          if (!libres[i] || pris.indexOf(i) >= 0) continue;
          if (memeMot(t, js[i])) { pris.push(i); vus.push(k); return; }
        }
      });
      if (!pris.length) return;
      var complet = pris.length === o.sig.length;
      if (!complet) {
        var propreA = vus.some(function (k) {
          var t = o.sig[k];
          if (nombre(t) !== null) return false;
          return opts.every(function (p) { return p === o || !p.sig.some(function (u) { return memeMot(u, t); }); });
        });
        // mot commun à plusieurs options (« mode » pour « Mode clair » et « Mode sombre ») : on ne devine pas
        if (!propreA) { if (vus.some(function (k) { return nombre(o.sig[k]) === null; })) etat.touche = true; return; }
      }
      cands.push({ o: o, pris: pris, complet: complet });
    });
    var gardes = cands.filter(function (c) {
      return !cands.some(function (d) {
        return d !== c && d.pris.length > c.pris.length && c.pris.every(function (i) { return d.pris.indexOf(i) >= 0; });
      });
    });
    gardes.forEach(function (c) { c.pris.forEach(function (i) { libres[i] = false; }); });
    return gardes.map(function (c) { return c.o.index; });
  }

  /* ================= Sélection (numéros, libellés, tournures) ================= */

  var EXCLUSION = ens('sauf excepte hormis sans');
  var TEMPS = /^(seconde|secondes|sec|minute|minutes|min|instant|moment)$/;

  /* Analyse une suite de jetons : ce qu'elle désigne parmi les options. */
  function analyser(js, opts) {
    var n = opts.length;
    var libres = js.map(function () { return true; });
    var r = { indices: [], tous: false, lesN: 0, ambigu: false, horsLimite: false, nombres: 0, libelles: 0, inconnus: 0, touche: false };
    function prendre(i) { libres[i] = false; }
    function ajouter(v) { if (v >= 1 && v <= n) r.indices.push(v - 1); else r.horsLimite = true; }
    var i;

    // « une seconde », « un instant » : du temps, pas un choix ; « attends » : pas une réponse
    for (i = 0; i < js.length; i++) {
      if (TEMPS.test(js[i + 1] || '') && (nombre(js[i]) !== null || js[i] === 'quelques')) { prendre(i); prendre(i + 1); i++; }
      else if (/^(attends|attend|patiente)$/.test(js[i])) prendre(i);
    }

    // Tournures : les N premiers, les N derniers, l'avant-dernier, le dernier, celui du milieu, tous, les N
    for (i = 0; i < js.length; i++) {
      if (!libres[i]) continue;
      var t = js[i], suiv = js[i + 1], v = nombre(t);
      if (v !== null && v >= 2 && /^premier(e)?s?$/.test(suiv || '')) {
        for (var a = 1; a <= v; a++) ajouter(a);
        r.nombres++; prendre(i); prendre(i + 1); i++; continue;
      }
      if (v !== null && v >= 2 && /^dernier(e)?s?$/.test(suiv || '')) {
        if (v > n) r.horsLimite = true; else for (var b = n - v + 1; b <= n; b++) ajouter(b);
        r.nombres++; prendre(i); prendre(i + 1); i++; continue;
      }
      if (t === 'avant' && /^dernier(e)?$/.test(suiv || '')) { ajouter(n - 1); r.nombres++; prendre(i); prendre(i + 1); i++; continue; }
      if (/^dernier(e)?$/.test(t)) { ajouter(n); r.nombres++; prendre(i); continue; }
      if (t === 'milieu') { if (n % 2) ajouter((n + 1) / 2); else r.ambigu = true; r.nombres++; prendre(i); continue; }
      if (t === 'tous' || t === 'toutes' || t === 'ensemble' || (t === 'tout' && !/^(du|pas|en|rien)$/.test(js[i - 1] || ''))) {
        r.tous = true; prendre(i); continue;
      }
      if (t === 'les' && /^(deux|trois|quatre|cinq|[2-9])$/.test(suiv || '') && !/^(premier|dernier)/.test(js[i + 2] || '')) {
        r.lesN = nombre(suiv); prendre(i); prendre(i + 1); i++; continue;
      }
    }

    // Libellés
    var l = chercherLibelles(js, libres, opts, r);
    r.libelles = l.length;
    r.indices = r.indices.concat(l);

    // Numéros (« un » / « une » ne sont des numéros que seuls, ou après « la », « le », « numéro », « option »…)
    for (i = 0; i < js.length; i++) {
      if (!libres[i]) continue;
      var w = nombre(js[i]);
      if (w === null) continue;
      if (js[i] === 'un' || js[i] === 'une') {
        var apres = js[i + 1], avant = js[i - 1];
        var numero = apres === undefined || LIAISON[apres] || POLITESSE[apres] || nombre(apres) !== null || (avant && CONTEXTE[avant]);
        if (!numero) continue; // article : « une pomme »
      }
      // intervalle : « de un à trois », « du premier au troisième », « 1 jusqu'à 3 »
      var k = i + 1;
      if (js[k] === 'jusqu') k++;
      if ((js[k] === 'a' || js[k] === 'au') && nombre(js[k + 1]) !== null) {
        var fin = nombre(js[k + 1]);
        if (fin > w) {
          for (var c = w; c <= fin; c++) ajouter(c);
          r.nombres++;
          for (var p = i; p <= k + 1; p++) prendre(p);
          i = k + 1;
          continue;
        }
      }
      ajouter(w); r.nombres++; prendre(i);
    }

    for (i = 0; i < js.length; i++) if (libres[i] && !connu(js[i]) && !EXCLUSION[js[i]] && js[i].length > 1) r.inconnus++;
    return r;
  }

  function unique(l) { var o = []; l.forEach(function (x) { if (o.indexOf(x) < 0) o.push(x); }); return o.sort(function (a, b) { return a - b; }); }

  /* Une phrase (jetons) → { ok, indices } pour un choix unique ou multiple. */
  function selection(js, opts, multi) {
    var n = opts.length;
    var k = -1;
    for (var i = 0; i < js.length; i++) {
      if (EXCLUSION[js[i]] || (js[i] === 'part' && js[i - 1] === 'a')) { k = i; break; }
    }
    var avant = k >= 0 ? js.slice(0, js[k] === 'part' ? k - 1 : k) : js;
    var r = analyser(avant, opts);
    var exclus = k >= 0 ? unique(analyser(js.slice(k + 1), opts).indices) : [];
    if (r.horsLimite) return echec('hors-limite');
    if (r.ambigu) return echec('ambigu');
    var sel = unique(r.indices);
    var tout = opts.map(function (o, j) { return j; });
    if (multi) {
      if (r.tous) sel = tout;
      if (r.lesN) {
        if (r.lesN === n) sel = tout;
        else if (sel.length !== r.lesN) return echec('ambigu');
      }
      if (k >= 0) {
        if (!exclus.length) return echec('ambigu');
        if (!sel.length) sel = tout;
        sel = sel.filter(function (j) { return exclus.indexOf(j) < 0; });
        if (!sel.length) return echec('ambigu');
      }
    } else {
      if (r.tous || r.lesN || k >= 0) return echec('ambigu');
      if (sel.length > 1) return echec('ambigu');
    }
    if (!sel.length) return echec(r.touche ? 'ambigu' : 'vide');
    // Un numéro noyé dans une phrase libre (« j'en mange deux par jour ») : on ne devine pas.
    if (!r.libelles && r.inconnus >= 2) return echec('ambigu');
    return { ok: true, genre: 'choix', indices: sel, labels: sel.map(function (j) { return opts[j].label; }) };
  }

  /* Dernier mot de correction : « la deux… non, la trois », « Poire, enfin plutôt Kiwi ». */
  function derniereCorrection(js, avecNon) {
    var k = -1;
    for (var i = 1; i < js.length; i++) {
      var t = js[i];
      if (t === 'plutot' || t === 'enfin' || t === 'pardon' || t === 'finalement' || t === 'correction' ||
          (t === 'fait' && js[i - 1] === 'en') || (t === 'dire' && js[i - 1] === 'veux') || (avecNon && t === 'non')) k = i;
    }
    return k;
  }

  function texteLibreAcceptable(js) {
    var sig = js.filter(function (t) { return !VIDES[t] && !POLITESSE[t] && !STOP[t] && !CONTEXTE[t] && !OUINON[t] && nombre(t) === null; });
    return sig.some(function (t) { return t.length >= 3; });
  }

  function interpreterChoix(phrase, spec, opts) {
    var multi = spec.type === 'multi';
    var libre = spec.libre !== false;
    var orig = propre(phrase);
    // « Autre réponse : la mangue » : texte libre explicite (sauf si une option commence elle-même par « Autre »)
    var expl = /^\s*(?:autre(?:\s+r[ée]ponse)?|r[ée]ponse\s+libre|texte\s+libre)\s*[:,.\-–—]?\s*([\s\S]*)$/i.exec(orig);
    var optionAutre = opts.some(function (o) { return o.sig[0] === 'autre' || o.sig[0] === 'autres'; });
    if (expl && libre && !optionAutre) return expl[1].trim() ? { ok: true, genre: 'libre', texte: expl[1].trim() } : echec('incompris');
    var js = jetons(orig);
    var k = derniereCorrection(js, true);
    if (k > 0 && k < js.length - 1) {
      var r2 = selection(js.slice(k + 1), opts, multi);
      if (r2.ok) return r2;
    }
    var r = selection(js, opts, multi);
    if (r.ok) return r;
    if (r.raison !== 'vide') return r;
    if (libre && texteLibreAcceptable(js)) return { ok: true, genre: 'libre', texte: orig };
    return echec('incompris');
  }

  /* ================= Oui / non (permission, plan) ================= */

  var RE_INCERTAIN = /\b(?:je ne sais pas|je sais pas|sais pas|chais pas|aucune idee|j hesite|je ne suis pas sur)\b/;
  var RE_NEG = /\b(?:pas question|hors de question|surtout pas|certainement pas|absolument pas|pas du tout|toujours pas|pas maintenant|pas d accord|pas ca|laisse tomber|n(?:e)?(?: [a-z0-9]+){1,3}? pas)\b|\b(?:non|nan|nope|no|nein|deny|jamais|stop)\b|\b(?:refus|annul|arret|interdi)[a-z]*/g;
  var RE_POS = /\b(?:oui|ouais|ouai|ouaip|ouep|yes|yep|yeah|ok|okay|okey|oki|dac|go|carrement|absolument|parfait|banco|evidemment|volontiers|exactement|fonce|vazy|vasy|lance|lances|execute|autoris[a-z]*|accept[a-z]*|valid[a-z]*|confirm[a-z]*|approuv[a-z]*)\b|\b(?:d accord|vas y|va y|allez y|allez|fais le|fais ca|fait le|c est bon|c est ok|bien sur|ca marche|tout a fait|je valide|on y va|ca me va)\b/;
  var RE_TOUJOURS = /\b(?:toujours|tout le temps|a chaque fois|chaque fois|pour toute la session|pour la session|definitivement|desormais|a l avenir|pour de bon)\b/;
  var RE_DEBUT_REFUS = /^\s*(?:non|nan|nope|no|je refuse|refuse[rz]?|pas question|surtout pas|jamais|annule[rz]?|stop|arr[eê]te|ne fais pas [cç]a|ne fais pas|n['’]autorise pas|merci)\b[\s,.;:!…–—-]*/i;

  /* Refus avec une consigne : « Non, mets plutôt ça dans notes.md » → « Mets plutôt ça dans notes.md ». */
  function messageRefus(orig, opts) {
    var s = orig, garde = 0;
    while (RE_DEBUT_REFUS.test(s) && garde++ < 6) s = s.replace(RE_DEBUT_REFUS, '');
    s = s.trim();
    // ce qui reste, sans les tournures de refus (« toujours pas », « surtout pas ») : une vraie consigne ?
    var js = V.normaliser(s).replace(RE_NEG, ' ').split(' ').filter(Boolean);
    var sig = js.filter(function (t) { return !VIDES[t] && !POLITESSE[t] && !OUINON[t]; });
    if (sig.length < 2) return '';
    // le reste n'est qu'un libellé (« Refuser », « Continuer à planifier ») : pas une consigne
    var n = V.normaliser(s);
    if (opts.some(function (o) { return V.normaliser(o.label) === n; })) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function decisionBrute(n, orig, opts) {
    if (RE_INCERTAIN.test(n)) return echec('incompris');
    var pos = /\bpourquoi pas\b/.test(n);
    var reste = n.replace(/\bpourquoi pas\b/g, ' ');
    var neg = false;
    reste = reste.replace(RE_NEG, function () { neg = true; return ' '; }).replace(/\s+/g, ' ').trim();
    if (RE_POS.test(reste)) pos = true;
    var toujours = RE_TOUJOURS.test(reste);
    var d = Object.create(null);
    if (pos) d.autoriser = true;
    if (toujours) d.toujours = true;
    if (neg) d.refuser = true;
    var js = reste ? reste.split(' ') : [];
    var s = js.length ? selection(js, opts, true) : echec('vide');
    if (!s.ok && s.raison === 'hors-limite') return s;
    if (s.ok) s.indices.forEach(function (i) { if (opts[i].decision) d[opts[i].decision] = true; });
    var oui = d.autoriser || d.toujours;
    if (d.refuser && oui) return echec('ambigu');
    if (oui) {
      var peutToujours = opts.some(function (o) { return o.decision === 'toujours'; });
      return { ok: true, genre: 'decision', decision: d.toujours && peutToujours ? 'toujours' : 'autoriser', message: '' };
    }
    if (d.refuser) return { ok: true, genre: 'decision', decision: 'refuser', message: neg ? messageRefus(orig, opts) : '' };
    return echec('incompris');
  }

  function interpreterDecision(phrase, spec, opts) {
    var orig = propre(phrase);
    var n = V.normaliser(orig);
    var js = n ? n.split(' ') : [];
    // « Oui… enfin non » : ce qui suit la correction
    var k = derniereCorrection(js, false);
    if (k > 0 && k < js.length - 1) {
      var r2 = decisionBrute(js.slice(k + 1).join(' '), orig, opts);
      if (r2.ok) return r2;
    }
    return decisionBrute(n, orig, opts);
  }

  /* ================= Point d'entrée ================= */

  var RE_PARASITE = /sous titr|amara|abonnez vous|merci d avoir regarde|regarde cette video|merci de votre attention|^(?:musique|applaudissements|rires|silence|bruit|generique)(?: [a-z]+)?$/;

  V.parasite = function (t) {
    var n = V.normaliser(t);
    if (!n) return true;
    if (RE_PARASITE.test(n)) return true;
    return n.split(' ').every(function (j) { return VIDES[j]; });
  };

  V.interpreter = function (phrase, spec) {
    spec = spec || {};
    if (V.parasite(phrase)) return echec('vide');
    var opts = preparer(spec.options);
    if (spec.type === 'permission' || spec.type === 'plan') return interpreterDecision(phrase, spec, opts);
    if (!opts.length) {
      var t = propre(phrase);
      return spec.libre !== false && texteLibreAcceptable(jetons(t)) ? { ok: true, genre: 'libre', texte: t } : echec('incompris');
    }
    return interpreterChoix(phrase, spec, opts);
  };

  /* ================= Ce que Jarvis dit ================= */

  function aplatir(t) {
    return String(t == null ? '' : t)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`+([^`]*)`+/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/\*\*|__/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function couper(t, max) {
    if (t.length <= max) return t;
    var c = t.slice(0, max - 1);
    var e = c.lastIndexOf(' ');
    if (e > max * 0.6) c = c.slice(0, e);
    return c.replace(/[\s,;:.–—-]+$/, '') + '…';
  }

  /* Découpe en phrases : un . ! ? ou … suivi d'un blanc (pas « notes.md » ni « v2.1 »). */
  function phrases(t) {
    var res = [], debut = 0;
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      if (c === '.' || c === '!' || c === '?' || c === '…') {
        var j = i + 1;
        while (j < t.length && /[.!?…»"')\]]/.test(t.charAt(j))) j++;
        if (j >= t.length || /\s/.test(t.charAt(j))) {
          var p = t.slice(debut, j).trim();
          if (p) res.push(p);
          debut = j; i = j - 1;
        }
      }
    }
    var fin = t.slice(debut).trim();
    if (fin) res.push(fin);
    return res;
  }

  /* Markdown → texte à dire : sans code, sans tableau, sans titre (sauf s'il n'y a que ça). */
  function texteParle(md) {
    var out = [], para = [], titres = [], dansCode = false;
    function finPara() { if (para.length) { out.push(para.join(' ')); para = []; } }
    md.split('\n').forEach(function (l) {
      if (/^\s*(```|~~~)/.test(l)) { dansCode = !dansCode; finPara(); return; }
      if (dansCode) return;
      if (!l.trim() || /^\s*\|/.test(l) || /^\s*([-*_]\s*){3,}$/.test(l)) { finPara(); return; }
      var h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(l);
      if (h) { finPara(); titres.push(aplatir(h[1])); return; }
      var li = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/.exec(l);
      if (li) { finPara(); out.push(aplatir(li[1])); return; }
      para.push(aplatir(l.replace(/^\s*>\s?/, '')));
    });
    finPara();
    if (!out.length) out = titres;
    return out.filter(Boolean).map(function (p, i, l) { return i < l.length - 1 && !/[.!?…:;]$/.test(p) ? p + '.' : p; }).join(' ');
  }

  var RE_RESUME = /^\s*(?:[-*+>]\s+)?(?:\*\*|__)?\s*✅️?\s*(.*\S)\s*$/;

  V.resumeFin = function (texte, max) {
    // Mode vocal : Claude a écrit lui-même ce qu'il faut dire (bloc <vocal>), on le lit tel quel.
    var dit = BT.texteVocal ? BT.texteVocal(BT.sansAnsi ? BT.sansAnsi(texte) : texte) : '';
    if (dit) return couper(aplatir(dit), 1200);
    max = max || V.MAX_RESUME;
    var s = BT.nettoyerTexteClaude ? BT.nettoyerTexteClaude(texte) : String(texte == null ? '' : texte);
    if (!s.trim()) return '';
    // La ligne ✅ finale (CLAUDE.md d'Eliot) : seulement parmi les deux dernières lignes non vides.
    var lignes = s.split('\n').filter(function (l) { return l.trim(); });
    for (var i = lignes.length - 1; i >= 0 && i >= lignes.length - 2; i--) {
      var m = RE_RESUME.exec(lignes[i]);
      if (m) { var r = aplatir(m[1]); if (r) return couper(r, max); }
    }
    var ph = phrases(texteParle(s));
    if (!ph.length) return '';
    var t = ph[0];
    if (ph[1] && t.length < 90 && (t + ' ' + ph[1]).length <= max) t += ' ' + ph[1];
    return couper(t, max);
  };

  function nombreParle(i) { return i < MOTS_NOMBRES.length ? MOTS_NOMBRES[i] : String(i + 1); }
  function majuscule(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
  function ponctuer(t) {
    t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    return !t || /[.!?…]$/.test(t) ? t : t + '.';
  }

  V.listeOptions = function (spec) {
    return ((spec && spec.options) || []).map(function (o, i) {
      var l = aplatir(typeof o === 'string' ? o : (o && o.label) || '').replace(/[.:;,]+$/, '');
      return majuscule(nombreParle(i)) + ' : ' + l + '.';
    }).join(' ');
  };

  V.phraseQuestion = function (spec) {
    spec = spec || {};
    var t;
    if (spec.type === 'permission') t = 'te demande l’autorisation ' + ponctuer(spec.texte || 'd’utiliser un outil');
    else if (spec.type === 'plan') t = 'te demande de valider son plan.';
    else {
      var q = aplatir(spec.texte || '');
      t = (spec.rang > 0 ? 'te demande aussi : ' : 'te demande : ') + ponctuer(BT.tronquer ? BT.tronquer(q, 240) : q);
      if (spec.type === 'multi') t += ' Plusieurs choix possibles.';
    }
    var o = V.listeOptions(spec);
    return o ? t + ' ' + o : t;
  };

  /* Ce que Claude veut faire, en français parlé (« de lancer la commande npm test »). */
  V.textePermission = function (outil, entree, description) {
    var r = BT.resumeOutil ? BT.resumeOutil(outil, entree) : { nom: outil, cible: '' };
    var tr = BT.tronquer || function (x) { return x; };
    var cible = tr(String(r.cible || '').replace(/\s+/g, ' ').trim(), 70);
    var nom = String(r.nom || outil || 'un outil').replace(/\s+·\s+/g, ' ');
    switch (outil) {
      case 'Bash': case 'PowerShell': return cible ? 'de lancer la commande ' + cible : 'de lancer une commande';
      case 'Write': return cible ? 'd’écrire le fichier ' + cible : 'd’écrire un fichier';
      case 'Edit': case 'MultiEdit': case 'NotebookEdit': return cible ? 'de modifier le fichier ' + cible : 'de modifier un fichier';
      case 'Read': return cible ? 'de lire le fichier ' + cible : 'de lire un fichier';
      case 'WebFetch': return cible ? 'd’ouvrir la page ' + cible : 'd’ouvrir une page web';
      case 'WebSearch': return cible ? 'de chercher sur le web : ' + cible : 'de chercher sur le web';
      default:
        if (!cible && description) cible = tr(String(description).replace(/\s+/g, ' ').trim(), 70);
        return 'd’utiliser ' + nom + (cible ? ' : ' + cible : '');
    }
  };
})();
