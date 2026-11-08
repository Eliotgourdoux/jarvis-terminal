/* Menus déroulants maison pour Modèle et Effort (07/11/2026) : le menu natif de macOS ne colle pas au style.
 * Le <select> reste la source de vérité (interface.js le remplit et écoute « change ») ; il est caché,
 * et un bouton + une liste le remplacent à l'écran.
 * Modèle et Effort (08/11/2026) : le panneau contient un levier à crans (leviers.js) au lieu de la liste. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  function texteChoisi(sel) { var o = sel.options[sel.selectedIndex]; return o ? o.textContent : ''; }

  function ameliorer(sel) {
    var cadre = sel.closest('.barre-choix');
    if (!cadre) return;
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    sel.classList.add('select-cache');
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'choix-bouton';
    b.setAttribute('aria-haspopup', 'listbox');
    b.setAttribute('aria-label', sel.getAttribute('aria-label') || '');
    var v = document.createElement('span'); v.className = 'choix-valeur'; b.appendChild(v);
    cadre.appendChild(b);
    var menu = null, levier = null;
    var genre = BT.Leviers && BT.Leviers.GENRES[sel.id];

    function sync() { var t = texteChoisi(sel); if (v.textContent !== t) v.textContent = t; b.disabled = sel.disabled; }
    function fermer() {
      if (!menu) return;
      if (levier) { var l = levier; levier = null; l.avantFermeture(); }
      menu.remove(); menu = null; cadre.classList.remove('ouvert');
      document.removeEventListener('mousedown', dehors, true);
      document.removeEventListener('keydown', clavier, true);
      window.removeEventListener('blur', fermer);
    }
    function dehors(e) { if (menu && !menu.contains(e.target) && !b.contains(e.target)) fermer(); }
    function appliquer(val) {
      if (sel.value !== val) { sel.value = val; sel.dispatchEvent(new Event('change')); }
      sync();
    }
    function choisir(val) {
      fermer();
      appliquer(val);
      b.focus();
    }
    function clavier(e) {
      if (!menu) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (levier) levier.annuler(); fermer(); b.focus(); return; }
      if (levier) return;   // le levier gère ses flèches lui-même
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var items = Array.prototype.slice.call(menu.querySelectorAll('.choix-item:not([disabled])'));
        var i = items.indexOf(document.activeElement);
        i = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
        if (items[i]) items[i].focus();
      }
    }
    function ouvrir() {
      if (menu) { fermer(); return; }
      sync();
      if (genre) {
        levier = BT.Leviers.creer(genre, sel, { choisir: choisir, appliquer: appliquer, fermer: function () { fermer(); b.focus(); } });
        menu = levier.noeud;
      } else {
      menu = document.createElement('div');
      menu.className = 'choix-menu';
      menu.setAttribute('role', 'listbox');
      function ajout(o) {
        var it = document.createElement('button');
        it.type = 'button';
        it.className = 'choix-item' + (o.value === sel.value ? ' actif' : '');
        it.setAttribute('role', 'option');
        it.textContent = o.textContent;
        if (o.title) it.title = o.title;
        it.disabled = o.disabled;
        it.addEventListener('click', function () { choisir(o.value); });
        menu.appendChild(it);
      }
      Array.prototype.forEach.call(sel.children, function (n) {
        if (n.tagName === 'OPTGROUP') {
          var t = document.createElement('div'); t.className = 'choix-groupe'; t.textContent = n.label; menu.appendChild(t);
          Array.prototype.forEach.call(n.children, ajout);
        } else ajout(n);
      });
      }
      document.body.appendChild(menu);
      var r = b.getBoundingClientRect();
      menu.style.top = Math.round(r.bottom + 6) + 'px';
      var gauche = Math.min(r.left - 8, window.innerWidth - menu.offsetWidth - 8);
      menu.style.left = Math.max(8, Math.round(gauche)) + 'px';
      cadre.classList.add('ouvert');
      document.addEventListener('mousedown', dehors, true);
      document.addEventListener('keydown', clavier, true);
      window.addEventListener('blur', fermer);
      if (levier) { levier.focus(); return; }
      var a = menu.querySelector('.choix-item.actif') || menu.querySelector('.choix-item');
      if (a) a.focus();
    }
    b.addEventListener('click', ouvrir);
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true });
    sel.addEventListener('change', sync);
    setInterval(sync, 400);   // interface.js peut changer sel.value sans événement
    sync();
  }

  function init() { document.querySelectorAll('.barre-choix select').forEach(ameliorer); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
