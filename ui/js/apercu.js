/* Better Terminal For Claude — aperçus dans le fil.
 * Blocs ```html, ```svg et ```mermaid : onglets Aperçu / Code, et Agrandir.
 *   - mermaid et svg s'ouvrent sur l'aperçu ; html seulement si Claude l'a demandé (```html apercu),
 *     sinon sur le code (un extrait html dans une session de développement n'est pas à exécuter d'office).
 *   - Le rendu se fait dans une iframe sandbox="allow-scripts allow-popups" SANS allow-same-origin :
 *     origine opaque, aucun accès à la page, au pont (Swift refuse les messages hors cadre principal),
 *     ni aux fichiers locaux. Le cadre est servi par btapercu:// (Apercu.swift), avec sa propre CSP.
 *   - Chart.js et mermaid sont servis en local par ce même schéma (chart.js, mermaid.js).
 *   - L'iframe n'est créée qu'à l'approche de l'écran, et jamais pendant que le message arrive encore.
 *   - Mode vocal : chaque cadre porte la clé de son tour (cadre._cle, posée par vue-fil.js). Les étapes atteintes
 *     par la voix (BT.apercuEtape { n, cle }) vont aux cadres de ce tour ; le premier rendu d'un cadre du tour
 *     libère la voix qui l'attendait (session.apercuPret). La scène (scene.js) passe par BT.monterCadre. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var DANS_APP = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bt);
  var URL_CADRE = DANS_APP ? 'btapercu://app/apercu.html' : 'apercu/apercu.html';
  var GENRES = { html: 'html', htm: 'html', xhtml: 'html', svg: 'svg', mermaid: 'mermaid', mmd: 'mermaid' };
  var H_MIN = 40, H_MAX = 900;
  var cadres = [];   // { iframe, cadre, doc, plein, cle, rendu, commandes(), surRendu(), surHauteur(h), hMax }
  var etapes = {};   // clé de tour → dernière étape atteinte par la voix
  var derniereCle = null;

  BT.genreApercu = function (lang) { return GENRES[String(lang || '').toLowerCase()] || null; };

  function documentPour(code, genre) {
    if (genre === 'mermaid') {
      var src = JSON.stringify(code).replace(/</g, '\\u003c');
      return '<style>#d{text-align:center}#d svg{max-width:100%;height:auto}</style><div id="d"></div>' +
        '<script src="mermaid.js"><\/script><script>' +
        'mermaid.initialize({startOnLoad:false,theme:"dark",securityLevel:"strict",fontFamily:"-apple-system,system-ui,sans-serif"});' +
        'mermaid.render("bt-m",' + src + ').then(function(r){document.getElementById("d").innerHTML=r.svg})' +
        '.catch(function(e){var d=document.getElementById("d");d.style.color="#F0A79E";d.textContent="Diagramme invalide : "+((e&&e.message)||e)});' +
        '<\/script>';
    }
    if (genre === 'svg') return '<style>body{display:flex;justify-content:center}svg{max-width:100%;height:auto}</style>' + code;
    return code;
  }

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  /* ---------- Montage des iframes ---------- */

  function monter(cadre, opts) {
    if (cadre._monte) return cadre._rec || null;
    cadre._monte = true;
    opts = opts || {};
    var f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts allow-popups');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.title = 'Aperçu';
    f.src = URL_CADRE;
    cadre.appendChild(f);
    cadres = cadres.filter(function (r) { return r.iframe.isConnected; });
    var r = {
      iframe: f, cadre: cadre, doc: opts.doc != null ? opts.doc : cadre._doc, plein: !!(opts.plein || cadre._plein),
      cle: opts.cle || cadre._cle || null, rendu: false, commandes: opts.commandes || null,
      surRendu: opts.surRendu || null, surHauteur: opts.surHauteur || null, hMax: opts.hMax || H_MAX, etapeDepart: opts.etapeDepart || null
    };
    cadre._rec = r;
    cadres.push(r);
    return r;
  }

  /* Montage direct d'un cadre hors bloc de code (scène du mode vocal).
   * opts : { doc, cle (tour dont la voix pilote les étapes), commandes() → [{ code, etape }], etapeDepart(),
   *          surRendu(r), surHauteur(h, r), hMax }. */
  BT.monterCadre = function (cadre, opts) { return monter(cadre, opts); };
  BT.documentApercu = function (code, lang) { var g = BT.genreApercu(lang) || 'html'; return documentPour(String(code || ''), g); };
  BT.posterCadre = function (r, msg) { if (r && r.rendu && r.iframe.contentWindow) r.iframe.contentWindow.postMessage(msg, '*'); };

  /* Cadres du fil d'un tour vocal : montés tout de suite (la voix les attend), sans attendre le défilement. */
  BT.monterApercus = function (racine, cle) {
    if (!racine) return;
    racine.querySelectorAll('.bloc-code.vue-apercu > .apercu-cadre').forEach(function (c) {
      if (cle && !c._cle) c._cle = cle;
      if (!c._monte) { if (obs) obs.unobserve(c); monter(c); }
    });
  };

  /* La voix atteint le repère [[n]] du tour cle (bt.vocalEtape) : l'étape part à tous les cadres rendus de ce tour. */
  BT.apercuEtape = function (d) {
    if (!d) return;
    var n = Math.floor(+d.n);
    if (!(n >= 0)) return;
    var cle = d.cle || derniereCle;
    if (!cle) return;
    etapes[cle] = n;
    cadres.forEach(function (r) { if (r.cle === cle) BT.posterCadre(r, { type: 'bt-etape', n: n }); });
  };
  /* Étape de départ d'un cadre : la dernière atteinte par la voix ; sinon 0 si la voix de ce tour n'a pas encore
   * parlé (tour en cours, voix en attente) ; sinon (historique, voix déjà passée) le dernier repère du tour. */
  BT.etapeApercu = function (cle) {
    if (!cle) return -1;
    if (cle in etapes) return etapes[cle];
    var s = BT.app && BT.app.session;
    if (!s || s._vocalAttente === cle || (s.travaille && s._cleDuTour && s._cleDuTour() === cle)) return -1;
    var max = -1;
    s.items.forEach(function (it) {
      if (it.genre !== 'texte' || it.cleTour !== cle) return;
      (BT.texteVocal(it.texte).match(/\[\[\s*\d{1,3}\s*\]\]/g) || []).forEach(function (m) { max = Math.max(max, +m.replace(/\D/g, '')); });
    });
    return max;
  };

  var obs = window.IntersectionObserver ? new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { obs.unobserve(e.target); monter(e.target); } });
  }, { rootMargin: '600px 0px' }) : null;
  function surveiller(cadre) { if (cadre._monte) return; if (obs) obs.observe(cadre); else monter(cadre); }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string' || d.type.indexOf('bt-apercu-') !== 0) return;
    var r = null;
    for (var i = 0; i < cadres.length; i++) if (cadres[i].iframe.contentWindow === e.source) { r = cadres[i]; break; }
    if (!r) return;
    if (d.type === 'bt-apercu-pret') {
      e.source.postMessage({
        type: 'bt-apercu', html: r.doc, plein: r.plein,
        etape: r.etapeDepart ? r.etapeDepart() : r.cle ? BT.etapeApercu(r.cle) : -1, commandes: r.commandes ? r.commandes() : []
      }, '*');
    } else if (d.type === 'bt-apercu-rendu') {
      r.rendu = true;
      if (r.cle) {
        derniereCle = r.cle;
        // Étape arrivée entre l'envoi du document et la fin du rendu : le cadre l'ignore si c'est déjà la sienne.
        if (r.cle in etapes) BT.posterCadre(r, { type: 'bt-etape', n: etapes[r.cle] });
        if (BT.app && BT.app.session && BT.app.session.apercuPret) BT.app.session.apercuPret(r.cle);
      }
      if (r.surRendu) r.surRendu(r);
    } else if (d.type === 'bt-apercu-hauteur') {
      if (r.plein) return;
      var h = Math.max(H_MIN, Math.min(r.hMax, Math.ceil(+d.h || 0)));
      if (r.surHauteur) r.surHauteur(h, r); else r.cadre.style.height = h + 'px';
    } else if (d.type === 'bt-apercu-erreur') {
      var bloc = r.cadre.closest('.bloc-code, .apercu-plein-boite');
      var z = bloc && bloc.querySelector('.apercu-erreur');
      if (z && z.hidden) { z.textContent = 'Erreur dans l’aperçu : ' + String(d.message).slice(0, 300); z.hidden = false; }
    }
  });

  /* ---------- Agrandir ---------- */

  function agrandir(doc, titre, cle) {
    var voile = el('div', 'apercu-plein');
    voile.setAttribute('role', 'dialog');
    voile.setAttribute('aria-modal', 'true');
    voile.setAttribute('aria-label', 'Aperçu agrandi');
    var boite = el('div', 'apercu-plein-boite');
    var tete = el('div', 'apercu-plein-tete');
    var fermer = el('button', 'bt-plus', 'Fermer');
    fermer.type = 'button';
    fermer.title = 'Fermer (Échap)';
    tete.appendChild(el('span', 'apercu-plein-titre', titre));
    tete.appendChild(fermer);
    var cadre = el('div', 'apercu-plein-cadre');
    cadre._doc = doc; cadre._plein = true; cadre._cle = cle || null;
    var err = el('div', 'apercu-erreur'); err.hidden = true;
    boite.appendChild(tete); boite.appendChild(cadre); boite.appendChild(err);
    voile.appendChild(boite);
    document.body.appendChild(voile);
    monter(cadre);
    function clavier(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fin(); } }
    function fin() { document.removeEventListener('keydown', clavier, true); voile.remove(); }
    document.addEventListener('keydown', clavier, true);
    fermer.addEventListener('click', fin);
    voile.addEventListener('mousedown', function (e) { if (e.target === voile) fin(); });
    fermer.focus();
  }

  /* ---------- Équipement d'un bloc de code ---------- */

  /* bloc : un .bloc-code de BT.blocCode ; code : texte complet ; auto : ouvrir sur l'aperçu. */
  BT.agrandirApercu = agrandir;
  BT.equiperApercu = function (bloc, code, lang, auto) {
    var genre = BT.genreApercu(lang);
    code = String(code == null ? '' : code);
    if (!genre || !code.trim() || !bloc || bloc.classList.contains('avec-apercu')) return;
    if (genre !== 'html') auto = true;
    var doc = documentPour(code, genre);
    var tete = bloc.querySelector('.bloc-code-tete');
    var copier = tete && tete.querySelector('.bt-copier');
    if (!tete) return;
    var onglets = el('div', 'apercu-onglets');
    onglets.setAttribute('role', 'group');
    var bA = el('button', 'apercu-onglet', 'Aperçu'), bC = el('button', 'apercu-onglet', 'Code');
    bA.type = bC.type = 'button';
    onglets.appendChild(bA); onglets.appendChild(bC);
    var bG = el('button', 'apercu-agrandir', 'Agrandir');
    bG.type = 'button';
    bG.title = 'Afficher l’aperçu en grand';
    tete.insertBefore(onglets, copier || null);
    tete.insertBefore(bG, copier || null);
    var cadre = el('div', 'apercu-cadre');
    cadre._doc = doc;
    cadre.style.height = (genre === 'html' ? 320 : 220) + 'px';
    var err = el('div', 'apercu-erreur'); err.hidden = true;
    var apres = tete.nextSibling;
    bloc.insertBefore(cadre, apres);
    bloc.insertBefore(err, apres);
    bloc.classList.add('avec-apercu');
    function montrer(oui) {
      bloc.classList.toggle('vue-apercu', oui);
      bA.classList.toggle('actif', oui); bA.setAttribute('aria-pressed', String(oui));
      bC.classList.toggle('actif', !oui); bC.setAttribute('aria-pressed', String(!oui));
      bG.hidden = !oui;
      if (oui) surveiller(cadre);
    }
    bA.addEventListener('click', function () { montrer(true); });
    bC.addEventListener('click', function () { montrer(false); });
    bG.addEventListener('click', function () { agrandir(doc, genre === 'mermaid' ? 'Diagramme' : genre === 'svg' ? 'Image SVG' : 'Aperçu HTML', cadre._cle); });
    montrer(!!auto);
  };
})();
