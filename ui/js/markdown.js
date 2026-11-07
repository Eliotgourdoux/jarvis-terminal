/* Better Terminal For Claude — rendu markdown.
 * marked (GFM) → DOMPurify (assainissement, obligatoire) → retouches DOM
 * (blocs de code avec bouton Copier, coloration highlight.js, tableaux défilants,
 * images remplacées par des liens, ligne ✅ mise en valeur). Un lien ou une image markdown
 * vers un média local garde son chemin dans data-media : js/medias.js en fait un lecteur.
 * Le HTML brut écrit par Claude est affiché comme du texte (jamais interprété). */
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

  var pret = !!(window.marked && window.DOMPurify);
  if (pret) {
    window.marked.use({
      gfm: true,
      breaks: true,
      renderer: {
        // HTML brut : affiché tel quel, comme dans le terminal.
        html: function (tok) { return echapper(tok.text || tok.raw || ''); }
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
    retoucher(frag, opts.enCours && fenceOuverte(md));
    return frag;
  };

  function retoucher(frag, dernierOuvert) {
    // Blocs de code
    var pres = frag.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      var code = pre.querySelector('code');
      if (!code) { code = document.createElement('code'); code.textContent = pre.textContent; pre.textContent = ''; pre.appendChild(code); }
      var m = /(?:^|\s)language-([\w+#.-]+)/.exec(code.className || '');
      var lang = m ? m[1] : '';
      code.textContent = code.textContent.replace(/\n$/, '');
      var bloc = BT.blocCode('', lang, { colorer: false });
      var nouveauCode = bloc.querySelector('code');
      nouveauCode.textContent = code.textContent;
      pre.parentNode.replaceChild(bloc, pre);
      var ouvert = dernierOuvert && i === pres.length - 1;
      if (lang && !ouvert) BT.colorerCode(nouveauCode, lang);
      if (ouvert) bloc.classList.add('en-cours');
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
      if (/^\s*✅/.test(ps[q].textContent)) ps[q].classList.add('resume-final');
    }
  }
})();
