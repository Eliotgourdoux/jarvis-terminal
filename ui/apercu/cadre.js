/* Cadre d'aperçu : attend le document envoyé par la page (une seule fois), l'écrit, puis signale sa hauteur
 * et ses erreurs. Tout passe par postMessage ; le cadre n'a aucun autre lien avec l'app. */
(function () {
  'use strict';
  var BASE = ':root{color-scheme:dark}' +
    'body{margin:14px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:#ECECF1;background:#0C0D10}' +
    'a{color:#B3A1FF}';

  function rapport() {
    function hauteur() {
      var d = document.documentElement, b = document.body, v = d.getBoundingClientRect().height;
      if (b) v = Math.max(v, b.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(b).marginBottom) || 0) + window.scrollY);
      parent.postMessage({ type: 'bt-apercu-hauteur', h: Math.ceil(v) }, '*');
    }
    var ro = new ResizeObserver(hauteur);
    ro.observe(document.documentElement);
    document.addEventListener('DOMContentLoaded', function () { if (document.body) ro.observe(document.body); hauteur(); });
    addEventListener('load', hauteur);
    addEventListener('error', function (e) {
      var t = e.target, m = e.message;
      if (!m && t && (t.src || t.href)) m = 'chargement impossible : ' + (t.src || t.href);
      parent.postMessage({ type: 'bt-apercu-erreur', message: String(m || 'erreur') }, '*');
    }, true);
    addEventListener('unhandledrejection', function (e) {
      parent.postMessage({ type: 'bt-apercu-erreur', message: String((e.reason && e.reason.message) || e.reason || 'erreur') }, '*');
    });
  }

  /* API « jarvis » de l'aperçu (CONTRAT.md, « Animations au rythme de la voix » et « Scène ») :
   *   jarvis.etape(n => …)   appelée à l'étape 0 au chargement, puis à chaque repère [[n]] atteint par la voix
   *   jarvis.recevoir(d => …) données JSON des blocs ```jarvis scene=nom``` (un bloc JS est exécuté tel quel)
   * Un bloc jarvis (JS) qui appelle jarvis.etape remplace les étapes précédentes : la voix de son tour les pilote.
   * Injectée dans la tête du document écrit : document.open efface les écouteurs posés avant. */
  function jarvisApi(depart) {
    var cur = -1, fns = [], recs = [], recus = [], enCommande = false, remplacees = false;
    function erreur(e) { parent.postMessage({ type: 'bt-apercu-erreur', message: String((e && e.message) || e || 'erreur') }, '*'); }
    function lancer(f, v) { try { f(v); } catch (e) { erreur(e); } }
    function etape(n) {
      n = Math.floor(+n);
      if (!(n >= 0) || n === cur) return;
      cur = n;
      if (document.documentElement) document.documentElement.setAttribute('data-jarvis-etape', String(n));
      fns.slice().forEach(function (f) { lancer(f, n); });
      try { document.dispatchEvent(new CustomEvent('jarvis-etape', { detail: n })); } catch (e) {}
    }
    function commande(code) {
      var t = String(code == null ? '' : code).trim(), d;
      if (!t) return;
      try { d = JSON.parse(t); } catch (e) { d = undefined; }
      if (d !== undefined) { recus.push(d); recs.slice().forEach(function (f) { lancer(f, d); }); return false; }
      enCommande = true; remplacees = false;
      try { (0, eval)(t); } catch (e) { erreur(e); }
      enCommande = false;
      return remplacees;
    }
    window.jarvis = {
      etape: function (f) {
        if (typeof f !== 'function') { etape(f); return window.jarvis; }
        // Première étape déclarée par un bloc jarvis : elle remplace les anciennes, qui attendent la voix de ce tour.
        if (enCommande && !remplacees) { remplacees = true; fns = []; cur = -1; }
        fns.push(f);
        if (cur >= 0) lancer(f, cur);
        return window.jarvis;
      },
      recevoir: function (f) {
        if (typeof f !== 'function') return window.jarvis;
        recs.push(f); recus.forEach(function (d) { lancer(f, d); });
        return window.jarvis;
      },
      get n() { return cur; }
    };
    addEventListener('message', function (e) {
      if (e.source !== parent || !e.data) return;
      if (e.data.type === 'bt-etape') etape(e.data.n);
      else if (e.data.type === 'bt-jarvis') { if (commande(e.data.code) && typeof e.data.etape === 'number') etape(Math.max(0, e.data.etape)); }
    });
    var pret = false;
    function demarrer() {
      if (pret) return;
      pret = true;
      // Après les scripts du document : l'étape de départ (0 par défaut), puis les commandes de la scène rejouées,
      // chacune suivie de l'étape atteinte par son tour si elle a déclaré ses propres étapes.
      setTimeout(function () {
        etape(depart.etape >= 0 ? depart.etape : 0);
        (depart.commandes || []).forEach(function (c) {
          if (commande(c.code) && typeof c.etape === 'number') etape(Math.max(0, c.etape));
        });
        parent.postMessage({ type: 'bt-apercu-rendu' }, '*');
      }, 0);
    }
    document.addEventListener('DOMContentLoaded', demarrer);
    addEventListener('load', demarrer);
  }

  var fait = false;
  addEventListener('message', function (e) {
    if (fait || e.source !== parent) return;
    var d = e.data;
    if (!d || d.type !== 'bt-apercu' || typeof d.html !== 'string') return;
    fait = true;
    var tete = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>' + BASE + (d.plein ? 'html,body{min-height:100%}' : '') + '</style>' +
      '<script>(' + rapport.toString() + ')();(' + jarvisApi.toString() + ')(' + depart(d) + ')<\/script>';
    document.open();
    document.write(tete + d.html);
    document.close();
  });
  // Départ de l'API jarvis, sérialisé sans risque de fermer la balise <script>.
  function depart(d) {
    var o = {
      etape: typeof d.etape === 'number' ? d.etape : -1,
      commandes: Array.isArray(d.commandes) ? d.commandes.map(function (c) {
        return typeof c === 'string' ? { code: c } : { code: String(c && c.code || ''), etape: c && typeof c.etape === 'number' ? c.etape : undefined };
      }) : []
    };
    return JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }
  parent.postMessage({ type: 'bt-apercu-pret' }, '*');
})();
