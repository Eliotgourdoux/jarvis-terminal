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

  var fait = false;
  addEventListener('message', function (e) {
    if (fait || e.source !== parent) return;
    var d = e.data;
    if (!d || d.type !== 'bt-apercu' || typeof d.html !== 'string') return;
    fait = true;
    var tete = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>' + BASE + (d.plein ? 'html,body{min-height:100%}' : '') + '</style>' +
      '<script>(' + rapport.toString() + ')()<\/script>';
    document.open();
    document.write(tete + d.html);
    document.close();
  });
  parent.postMessage({ type: 'bt-apercu-pret' }, '*');
})();
