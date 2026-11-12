/* Better Terminal For Claude — rendu markdown.
 * marked (GFM) → DOMPurify (assainissement, obligatoire) → retouches DOM
 * (blocs de code avec bouton Copier, coloration highlight.js, tableaux défilants,
 * images remplacées par des liens, ligne ✅ mise en valeur). Un lien ou une image markdown
 * vers un média local garde son chemin dans data-media : js/medias.js en fait un lecteur.
 * Le HTML brut écrit par Claude est affiché comme du texte (jamais interprété) ; les blocs ```html, ```svg et
 * ```mermaid ont un aperçu isolé (js/apercu.js), créé seulement une fois le message complet. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  function echapper(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  BT.echapperHtml = echapper;

  /* Chemin local d'une image, d'une vidéo ou d'un son (href ou src markdown), ou null. */
  function cheminMedia(h) {
    if (!BT.medias || !h) return null;
    var d = h;
    if (!/^file:/i.test(h)) { try { d = decodeURI(h); } catch (e) { d = h; } }
    return BT.medias.normaliser(d);
  }

  /* Chaîne d'info d'une fence (« html apercu scene=archi ») → { genre, apercu, scene, jarvis }. */
  function infoFence(lang) {
    var s = String(lang || '').trim(), g = (/^\S+/.exec(s) || [''])[0];
    var sc = /(?:^|\s)sc[eè]ne\s*=\s*["']?([\w-]{1,40})/i.exec(s);
    return {
      genre: g, jarvis: /^jarvis$/i.test(g), scene: sc ? sc[1].toLowerCase() : null,
      apercu: /^\S+\s+.*\b(apercu|aperçu|preview|rendu|render)\b/i.test(s)
    };
  }
  BT.infoFence = infoFence;

  var pret = !!(window.marked && window.DOMPurify);
  if (pret) {
    window.marked.use({
      gfm: true,
      breaks: true,
      renderer: {
        // HTML brut : affiché tel quel, comme dans le terminal.
        html: function (tok) { return echapper(tok.text || tok.raw || ''); }
      },
      // « ```html apercu » (ou aperçu, preview) : Claude demande l'aperçu d'office (js/apercu.js).
      // « scene=nom » : aperçu nommé, la scène persistante du mode vocal (js/scene.js) → « html-apercu--scene--nom ».
      // « ```jarvis scene=nom » : commande pour une scène existante → « jarvis--scene--nom », replié.
      walkTokens: function (t) {
        if (t.type !== 'code' || !t.lang) return;
        var info = infoFence(t.lang);
        if (info.jarvis) { t.lang = 'jarvis' + (info.scene ? '--scene--' + info.scene : ''); return; }
        if (info.apercu || info.scene) t.lang = info.genre + '-apercu' + (info.scene ? '--scene--' + info.scene : '');
      }
    });

    // Liens : seulement http(s), mailto et ancres ; tout le reste perd son href.
    window.DOMPurify.addHook('afterSanitizeAttributes', function (n) {
      if (n.nodeName === 'A') {
        var h = n.getAttribute('href') || '';
        if (!/^(https?:|mailto:|#)/i.test(h)) {
          var media = cheminMedia(h);   // lien vers un média local : lu par le lecteur intégré (js/medias.js)
          if (media) n.setAttribute('data-media', media);
          n.removeAttribute('href');
        }
        n.removeAttribute('target');
      }
    });
  }

  var CONFIG_PURIFY = {
    ALLOWED_TAGS: ['a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
      'input', 'kbd', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'align', 'type', 'checked', 'disabled', 'start', 'alt', 'src'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true
  };

  /* ---------- Coloration (avec cache) ---------- */

  var cache = new Map();
  function colorerHtml(code, lang) {
    if (!window.hljs || !lang || !window.hljs.getLanguage(lang)) return null;
    var cle = lang + '\u0000' + code;
    var v = cache.get(cle);
    if (v !== undefined) return v;
    try { v = window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch (e) { v = null; }
    if (v !== null) v = window.DOMPurify.sanitize(v, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    cache.set(cle, v);
    return v;
  }

  var ALIAS = { sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', js: 'javascript', ts: 'typescript', py: 'python',
    yml: 'yaml', html: 'xml', objc: 'objectivec', 'objective-c': 'objectivec', rb: 'ruby', rs: 'rust', kt: 'kotlin',
    jsonc: 'json', json5: 'json', md: 'markdown', text: 'plaintext', txt: 'plaintext', plist: 'xml', svg: 'xml', toml: 'ini' };
  function langNormale(l) {
    l = String(l || '').trim().toLowerCase().split(/\s+/)[0];
    return ALIAS[l] || l;
  }

  /* Colore un élément <code> (son texte reste la source de vérité pour Copier). */
  BT.colorerCode = function (codeEl, lang) {
    var l = langNormale(lang);
    var h = colorerHtml(codeEl.textContent, l);
    if (h !== null) { codeEl.innerHTML = h; codeEl.classList.add('hljs'); }
  };

  /* Bloc de code autonome (en-tête avec langage + Copier). */
  BT.blocCode = function (code, lang, opts) {
    opts = opts || {};
    var bloc = document.createElement('div');
    bloc.className = 'bloc-code' + (opts.classe ? ' ' + opts.classe : '');
    var tete = document.createElement('div');
    tete.className = 'bloc-code-tete';
    var nom = document.createElement('span');
    nom.className = 'bloc-code-lang';
    nom.textContent = opts.titre || (lang ? String(lang).toLowerCase() : 'texte');
    var copier = document.createElement('button');
    copier.type = 'button';
    copier.className = 'bt-copier';
    copier.textContent = 'Copier';
    tete.appendChild(nom); tete.appendChild(copier);
    var pre = document.createElement('pre');
    var c = document.createElement('code');
    c.textContent = code;
    pre.appendChild(c);
    bloc.appendChild(tete); bloc.appendChild(pre);
    if (lang && opts.colorer !== false) BT.colorerCode(c, lang);
    return bloc;
  };

  /* ---------- Rendu ---------- */

  function fenceOuverte(md) {
    var n = 0, re = /^ {0,3}(```|~~~)/gm;
    while (re.exec(md)) n++;
    return n % 2 === 1;
  }

  /* md → DocumentFragment assaini. opts.enCours : le texte arrive encore (bloc de code ouvert non coloré). */
  BT.rendreMarkdown = function (md, opts) {
    opts = opts || {};
    var frag;
    if (!pret) {
      frag = document.createDocumentFragment();
      var p = document.createElement('p');
      p.style.whiteSpace = 'pre-wrap';
      p.textContent = md;
      frag.appendChild(p);
      return frag;
    }
    var html = window.marked.parse(String(md || ''));
    frag = window.DOMPurify.sanitize(html, CONFIG_PURIFY);
    retoucher(frag, opts.enCours && fenceOuverte(md), !!opts.enCours);
    return frag;
  };

  /* ---------- Mode vocal : seulement les éléments visuels ----------
   * Dans un tour vocal, la voix porte la réponse ; l'écran ne montre que ce qui l'illustre : blocs de code
   * (aperçus html, mermaid, svg, commandes à copier), tableaux, liens, images et vidéos locales citées.
   * La prose (et la ligne ✅) n'est pas affichée. Pendant l'écriture, un élément n'apparaît qu'une fois
   * reconnu (bloc ouvert, tableau avec sa ligne de séparation, lien complet). */
  function fenceFermee(raw) {
    var l = String(raw || '').replace(/\s+$/, '').split('\n');
    if (l.length < 2) return false;
    var o = /^\s*(`{3,}|~{3,})/.exec(l[0]), f = /^\s*(`{3,}|~{3,})\s*$/.exec(l[l.length - 1]);
    return !!(o && f && f[1].charAt(0) === o[1].charAt(0) && f[1].length >= o[1].length);
  }

  BT.fenceFermee = fenceFermee;

  function morceauxVisuels(md, enCours) {
    if (!pret || !window.marked.lexer) return [];
    var toks;
    try { toks = window.marked.lexer(String(md || '')); } catch (e) { return []; }
    var res = [], liens = [], vus = Object.create(null);
    function lien(texte, href) {
      if (!href || vus[href]) return;
      vus[href] = 1;
      liens.push('[' + String(texte || href).replace(/[\[\]]/g, '') + '](' + href.replace(/[()\s]/g, encodeURIComponent) + ')');
    }
    function chemin(c) {
      if (vus[c]) return;
      vus[c] = 1;
      liens.push('`' + c + '`');
    }
    function enLigne(l) {
      (l || []).forEach(function (t) {
        if (!t) return;
        if (t.type === 'link') lien(t.text, t.href);
        else if (t.type === 'image') { var m = BT.medias && BT.medias.normaliser(t.href); if (m) chemin(m); }
        else if (t.type === 'codespan' && BT.medias) { var c = BT.medias.normaliser(t.text); if (c) chemin(c); }
        if (t.tokens) enLigne(t.tokens);
      });
    }
    function bloc(t, dernier) {
      if (!t) return;
      if (t.type === 'code') {
        var ouvert = t.codeBlockStyle !== 'indented' && !fenceFermee(t.raw);
        if (t.codeBlockStyle === 'indented') { res.push(t.raw.replace(/\s+$/, '')); return; }
        // Scène nommée : affichée en haut du fil (js/scene.js) ; ici, un simple renvoi. Commande jarvis : jamais affichée.
        var inf = infoFence(t.lang);
        if (inf.jarvis) return;
        if (inf.scene && BT.genreApercu && BT.genreApercu(inf.genre)) {
          if (!ouvert) res.push('```scene-ici--scene--' + inf.scene + '\n' + t.text + '\n```');
          return;
        }
        res.push('```' + (t.lang || '') + '\n' + t.text + (ouvert ? '' : '\n```'));
        return;
      }
      if (t.type === 'table') {
        var lignes = t.raw.replace(/\s+$/, '').split('\n').map(function (x) { return x.replace(/^\s+/, ''); });
        if (dernier && enCours && lignes.length > 2) lignes.pop(); // dernière ligne encore en cours d'écriture
        res.push(lignes.join('\n'));
        return;
      }
      if (t.type === 'list') { (t.items || []).forEach(function (i) { (i.tokens || []).forEach(function (x) { bloc(x, false); }); }); return; }
      if (t.type === 'blockquote') { (t.tokens || []).forEach(function (x) { bloc(x, false); }); return; }
      if (t.type === 'paragraph' || t.type === 'text' || t.type === 'heading') {
        // Dernier paragraphe encore en cours d'écriture : son lien ou son chemin peut être incomplet.
        if (dernier && enCours) return;
        enLigne(t.tokens);
        if (BT.medias) BT.medias.dansTexte(t.raw).forEach(chemin);
      }
    }
    var n = toks.length;
    while (n > 0 && toks[n - 1].type === 'space') n--;
    for (var i = 0; i < n; i++) bloc(toks[i], i === n - 1);
    // Liens et médias cités dans la prose : regroupés en une liste sous les visuels.
    if (liens.length) res.push(liens.map(function (x) { return '- ' + x; }).join('\n'));
    return res;
  }

  /* md (déjà nettoyé, sans bloc <vocal>) → source markdown des seuls éléments visuels ('' s'il n'y en a pas). */
  BT.sourceVisuelle = function (md, enCours) { return morceauxVisuels(md, enCours).join('\n\n'); };
  BT.aDesVisuels = function (md) { return !!BT.sourceVisuelle(md, false).trim(); };
  BT.rendreVisuels = function (md, opts) {
    opts = opts || {};
    var frag = BT.rendreMarkdown(BT.sourceVisuelle(md, !!opts.enCours), opts);
    var l = frag.querySelector && frag.lastElementChild;
    if (l && l.tagName === 'UL' && !l.querySelector('.bloc-code, .tableau')) l.classList.add('liens-visuels');
    return frag;
  };

  /* Bloc ```jarvis scene=nom``` hors mode vocal : replié derrière une ligne (il ne sert qu'à la scène). */
  function replierJarvis(bloc, scene) {
    var d = document.createElement('details');
    d.className = 'bloc-jarvis';
    var s = document.createElement('summary');
    s.textContent = 'Commande pour la scène' + (scene ? ' « ' + scene + ' »' : '');
    bloc.parentNode.replaceChild(d, bloc);
    d.appendChild(s);
    d.appendChild(bloc);
  }

  /* Tour vocal : la scène s'affiche en haut du fil ; à sa place, une ligne qui permet de revoir cette version. */
  function renvoiScene(nom, code) {
    var d = document.createElement('div');
    d.className = 'scene-renvoi';
    var t = document.createElement('span');
    t.textContent = 'Scène « ' + (nom || 'sans nom') + ' » affichée en haut';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'scene-renvoi-voir';
    b.textContent = 'Voir cette version';
    b.addEventListener('click', function () {
      if (BT.agrandirApercu && BT.documentApercu) BT.agrandirApercu(BT.documentApercu(code, 'html'), 'Scène « ' + (nom || '') + ' »');
    });
    d.appendChild(t);
    d.appendChild(b);
    return d;
  }

  function retoucher(frag, dernierOuvert, enCours) {
    // Blocs de code
    var pres = frag.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      var code = pre.querySelector('code');
      if (!code) { code = document.createElement('code'); code.textContent = pre.textContent; pre.textContent = ''; pre.appendChild(code); }
      var m = /(?:^|\s)language-([\w+#.-]+)/.exec(code.className || '');
      var lang = m ? m[1] : '';
      var scene = null, ms = /--scene--([\w-]+)$/.exec(lang);
      if (ms) { scene = ms[1]; lang = lang.slice(0, ms.index); }
      var demande = /-apercu$/.test(lang);
      if (demande) lang = lang.replace(/-apercu$/, '');
      code.textContent = code.textContent.replace(/\n$/, '');
      if (lang === 'scene-ici') { pre.parentNode.replaceChild(renvoiScene(scene, code.textContent), pre); continue; }
      var bloc = BT.blocCode('', lang, { colorer: false });
      var nouveauCode = bloc.querySelector('code');
      nouveauCode.textContent = code.textContent;
      pre.parentNode.replaceChild(bloc, pre);
      var ouvert = dernierOuvert && i === pres.length - 1;
      if (lang && !ouvert) BT.colorerCode(nouveauCode, lang);
      if (ouvert) bloc.classList.add('en-cours');
      else if (lang === 'jarvis') replierJarvis(bloc, scene);
      else if (!enCours && BT.equiperApercu) BT.equiperApercu(bloc, nouveauCode.textContent, lang, demande);
      if (scene) bloc.setAttribute('data-scene', scene);
    }
    // Tableaux : conteneur défilant horizontalement
    var tables = frag.querySelectorAll('table');
    for (var t = 0; t < tables.length; t++) {
      var tab = tables[t];
      var enveloppe = document.createElement('div');
      enveloppe.className = 'tableau';
      tab.parentNode.replaceChild(enveloppe, tab);
      enveloppe.appendChild(tab);
    }
    // Images distantes : jamais chargées (CSP) ; on garde un lien.
    var imgs = frag.querySelectorAll('img');
    for (var k = 0; k < imgs.length; k++) {
      var img = imgs[k];
      var src = img.getAttribute('src') || '';
      var a = document.createElement('a');
      if (/^https?:/i.test(src)) a.setAttribute('href', src);
      a.className = 'lien-image';
      var local = cheminMedia(src);
      if (local) a.setAttribute('data-media', local);
      a.textContent = 'Image : ' + (img.getAttribute('alt') || BT.basename(src) || 'sans titre');
      img.parentNode.replaceChild(a, img);
    }
    // Liens
    var liens = frag.querySelectorAll('a[href]');
    for (var l = 0; l < liens.length; l++) {
      liens[l].classList.add('lien');
      if (!liens[l].getAttribute('title')) liens[l].setAttribute('title', liens[l].getAttribute('href'));
    }
    // Seules les cases à cocher des listes de tâches sont gardées, en lecture seule
    var entrees = frag.querySelectorAll('input:not([type="checkbox"])');
    for (var x = 0; x < entrees.length; x++) entrees[x].parentNode.removeChild(entrees[x]);
    var cases = frag.querySelectorAll('input[type="checkbox"]');
    for (var c = 0; c < cases.length; c++) {
      cases[c].setAttribute('disabled', '');
      var li = cases[c].closest('li');
      if (li) li.classList.add('tache');
    }
    // Code en ligne court : jamais coupé en fin de ligne (« lisez- / moi.txt »)
    var codes = frag.querySelectorAll('code');
    for (var z = 0; z < codes.length; z++) {
      if (!codes[z].closest('pre') && codes[z].textContent.length <= 32) codes[z].classList.add('court');
    }
    // Ligne de résumé ✅ (habitude d'Eliot : chaque réponse finit par elle)
    var ps = frag.querySelectorAll('p');
    for (var q = 0; q < ps.length; q++) {
      if (/^\s*✅/.test(ps[q].textContent)) {
        ps[q].classList.add('resume-final');
        // l'emoji vert jure avec le marbre : on l'ôte, la coche or vient du CSS
        var w = document.createTreeWalker(ps[q], NodeFilter.SHOW_TEXT), t = w.nextNode();
        if (t) t.nodeValue = t.nodeValue.replace(/^\s*✅\uFE0F?\s*/, '');
      }
    }
  }
})();
