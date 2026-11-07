/* Menus déroulants maison pour Modèle et Effort (07/11/2026) : le menu natif de macOS ne colle pas au style.
 * Le <select> reste la source de vérité (interface.js le remplit et écoute « change ») ; il est caché,
 * et un bouton + une liste le remplacent à l'écran. */
(function () {
  'use strict';
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
    var menu = null;

    function sync() { var t = texteChoisi(sel); if (v.textContent !== t) v.textContent = t; b.disabled = sel.disabled; }
    function fermer() {
      if (!menu) return;
      menu.remove(); menu = null; cadre.classList.remove('ouvert');
      document.removeEventListener('mousedown', dehors, true);
      document.removeEventListener('keydown', clavier, true);
      window.removeEventListener('blur', fermer);
    }
    function dehors(e) { if (menu && !menu.contains(e.target) && !b.contains(e.target)) fermer(); }
    function choisir(val) {
      fermer();
      if (sel.value !== val) { sel.value = val; sel.dispatchEvent(new Event('change')); }
      sync(); b.focus();
    }
    function clavier(e) {
      if (!menu) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermer(); b.focus(); return; }
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
      document.body.appendChild(menu);
      var r = b.getBoundingClientRect();
      menu.style.top = Math.round(r.bottom + 6) + 'px';
      var gauche = Math.min(r.left - 8, window.innerWidth - menu.offsetWidth - 8);
      menu.style.left = Math.max(8, Math.round(gauche)) + 'px';
      cadre.classList.add('ouvert');
      document.addEventListener('mousedown', dehors, true);
      document.addEventListener('keydown', clavier, true);
      window.addEventListener('blur', fermer);
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
