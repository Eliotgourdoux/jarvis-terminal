/* Jarvis Terminal — menu des commandes « / » (08/11/2026).
 * Taper « / » au début de la saisie ouvre la liste des commandes de Claude Code (initialize → commands :
 * skills, commandes du projet, commandes intégrées), filtrée au fil de la frappe.
 * ↑↓ pour choisir, Entrée ou Tab pour valider, Échap pour fermer.
 * /model, /effort et /permissions ouvrent les menus de la barre du haut au lieu de partir chez Claude. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var el = BT.el;

  // Commandes de l'app : elles pilotent les menus de la barre (pas de texte envoyé à Claude).
  var COMMANDES_APP = [
    { name: 'model', description: 'Choisir le modèle de Claude', app: 'choix-modele' },
    { name: 'effort', description: 'Choisir l’effort de réflexion', app: 'choix-effort' },
    { name: 'permissions', description: 'Choisir ce que Claude peut faire sans te demander', app: 'choix-permission' }
  ];
  // Repli avant la réponse d'initialize (quelques secondes au lancement).
  var REPLI = [
    { name: 'compact', argumentHint: '<instructions facultatives>', description: 'Résumer la conversation pour libérer du contexte' },
    { name: 'clear', description: 'Repartir d’un contexte vide' },
    { name: 'context', description: 'Voir l’occupation du contexte' },
    { name: 'usage', description: 'Coût de la session et usage de l’abonnement' }
  ];

  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  /* Commandes visibles : sans les internes, ni celles retirées ou renommées. */
  function liste(s) {
    var brut = (s.commandes && s.commandes.length) ? s.commandes : REPLI;
    var vues = Object.create(null);
    var l = [];
    COMMANDES_APP.forEach(function (c) { vues[c.name] = true; l.push(c); });
    brut.forEach(function (c) {
      if (!c || !c.name || vues[c.name]) return;
      if (/^_/.test(c.name) || c.name === 'workflow-launch-exec') return;
      if (/^\((removed|deprecated)\)|^Renamed to/i.test(c.description || '')) return;
      vues[c.name] = true;
      l.push(c);
    });
    return l;
  }

  /* Score : début du nom > dans le nom > alias > description. -1 = écartée. */
  function score(c, q) {
    if (!q) return 0;
    var n = norm(c.name);
    if (n === q) return 100;
    if (n.indexOf(q) === 0) return 80 - n.length / 100;
    if (n.indexOf(q) > 0) return 60 - n.indexOf(q);
    if ((c.aliases || []).some(function (a) { return norm(a).indexOf(q) === 0; })) return 50;
    if (norm(c.description).indexOf(q) >= 0) return 10;
    return -1;
  }

  BT.Interface.prototype._initCommandes = function () {
    var self = this, ta = this.ta, s = this.s;
    var saisie = ta.closest('.saisie');
    var menu = el('div', 'menu-commandes');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Commandes');
    menu.hidden = true;
    saisie.appendChild(menu);
    var items = [], choix = 0, ferme = false;

    function requete() {
      // seulement « /mot » en tout début de saisie, curseur encore dans le mot
      var m = /^\/([^\s/]*)$/.exec(ta.value.slice(0, ta.selectionStart));
      return m ? norm(m[1]) : null;
    }

    function fermer() { menu.hidden = true; items = []; ta.removeAttribute('aria-activedescendant'); }

    function rendre() {
      var q = requete();
      if (q === null || ferme || ta.disabled) { fermer(); return; }
      items = liste(s)
        .map(function (c, i) { return { c: c, sc: score(c, q), i: i }; })
        .filter(function (x) { return x.sc >= 0; })
        .sort(function (a, b) { return b.sc - a.sc || a.i - b.i; })
        .map(function (x) { return x.c; });
      if (!items.length) { fermer(); return; }
      choix = Math.min(choix, items.length - 1);
      menu.replaceChildren();
      items.forEach(function (c, i) {
        var ligne = el('div', 'commande' + (i === choix ? ' actif' : '') + (c.app ? ' commande-app' : ''));
        ligne.id = 'commande-' + i;
        ligne.setAttribute('role', 'option');
        var tete = el('div', 'commande-tete', [el('span', 'commande-nom', '/' + c.name)]);
        if (c.argumentHint) tete.appendChild(el('span', 'commande-args', c.argumentHint));
        if (c.app) tete.appendChild(el('span', 'commande-tag', 'menu'));
        ligne.appendChild(tete);
        if (c.description) ligne.appendChild(el('div', 'commande-desc', c.description));
        ligne.addEventListener('mousedown', function (e) { e.preventDefault(); });   // garde le focus dans la saisie
        ligne.addEventListener('click', function () { choix = i; valider(false); });
        ligne.addEventListener('mousemove', function () { if (choix !== i) { choix = i; marquer(); } });
        menu.appendChild(ligne);
      });
      menu.hidden = false;
      marquer();
    }

    function marquer() {
      Array.prototype.forEach.call(menu.children, function (n, i) { n.classList.toggle('actif', i === choix); });
      var a = menu.children[choix];
      if (a) { a.scrollIntoView({ block: 'nearest' }); ta.setAttribute('aria-activedescendant', a.id); }
    }

    function ouvrirMenuBarre(id) {
      var b = document.getElementById(id);
      var bouton = b && b.closest('.barre-choix') && b.closest('.barre-choix').querySelector('.choix-bouton');
      if (bouton && !bouton.disabled) setTimeout(function () { bouton.click(); }, 0);
    }

    /* Tab : complète. Entrée/clic : lance si la commande se suffit, sinon complète pour taper l'argument. */
    function valider(completerSeulement) {
      var c = items[choix];
      if (!c) return;
      fermer();
      if (c.app) {
        ta.value = '';
        self.ajusterSaisie();
        ouvrirMenuBarre(c.app);
        return;
      }
      // remplace seulement le premier mot : un argument déjà tapé derrière est gardé
      var reste = ta.value.replace(/^\/\S*\s*/, '');
      ta.value = '/' + c.name + ' ' + reste;
      var pos = c.name.length + 2;
      ta.setSelectionRange(pos, pos);
      self.ajusterSaisie();
      ferme = true;   // ne pas rouvrir sur l'espace qu'on vient d'ajouter
      if (!completerSeulement && !c.argumentHint) self.envoyer();
      ta.focus();
    }

    ta.addEventListener('input', function () { ferme = false; choix = 0; rendre(); });
    ta.addEventListener('click', rendre);
    ta.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== ta) fermer(); }, 120); });
    s.on('commandes', function () { if (!menu.hidden) rendre(); });

    // Enregistré avant le gestionnaire d'envoi : Entrée choisit la commande au lieu d'envoyer.
    ta.addEventListener('keydown', function (e) {
      if (menu.hidden || !items.length || e.isComposing) return;
      var k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault(); e.stopImmediatePropagation();
        choix = (choix + (k === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        marquer();
      } else if (k === 'Tab' || (k === 'Enter' && !e.shiftKey && !e.altKey)) {
        e.preventDefault(); e.stopImmediatePropagation();
        valider(k === 'Tab');
      } else if (k === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        ferme = true; fermer();
      }
    });

    /* Envoi d'une commande de l'app tapée à la main (« /model opus », « /effort high », « /permissions plan »). */
    this.commandeApp = function (texte) {
      var m = /^\/(model|effort|permissions)(?:\s+(\S+))?\s*$/i.exec(texte.trim());
      if (!m) return false;
      var nom = m[1].toLowerCase(), arg = m[2] || '';
      var sel = document.getElementById(nom === 'model' ? 'choix-modele' : nom === 'effort' ? 'choix-effort' : 'choix-permission');
      if (!arg) { ouvrirMenuBarre(sel.id); return true; }
      var a = norm(arg);
      var opt = Array.prototype.filter.call(sel.options, function (o) {
        return norm(o.value) === a || norm(o.textContent) === a || norm(o.textContent).indexOf(a) === 0;
      })[0];
      if (!opt) { s._note('avert', 'Valeur inconnue pour /' + nom + ' : ' + arg + '.'); return true; }
      if (sel.value !== opt.value) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); }
      return true;
    };
  };
})();
