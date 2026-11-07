/* Jarvis Terminal — barre latérale des sessions.
 * Swift → page : window.barreSessions.maj([{id, numero, projet, emoji, etat, resume, dernierMessage,
 *                dansTerminal, maj, actif, nonLu}])
 *                + en bas, les fermetures avec bilan en cours : {id, projet, emoji, fermeture: true, maj}
 * Page → Swift : {type:'pret'} {type:'choisir', id} {type:'fermer', id} {type:'nouvelle'} */
(function () {
  'use strict';

  var pont = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.barre;
  function envoyer(o) { if (pont) pont.postMessage(o); else console.log('[barre]', o); }

  var liste = document.getElementById('liste');
  var vide = document.getElementById('vide');
  var donnees = [];

  function el(tag, cls, texte) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texte != null) e.textContent = texte;
    return e;
  }

  function temps(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'à l’instant';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h';
    return Math.floor(s / 86400) + ' j';
  }

  function duree(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0');
  }

  function etatDe(d) {
    if (d.fermeture) return { cle: 'fermeture', texte: 'Fermeture · bilan en cours' };
    if (d.dansTerminal) return { cle: 'termine', texte: 'Dans le Terminal' };
    if (d.etat === 'attend') return { cle: 'attend', texte: 'Claude t’attend' };
    if (d.etat === 'travaille') return { cle: 'travaille', texte: 'Travaille…' };
    if (d.etat === 'termine') return { cle: 'termine', texte: 'Terminée' };
    if (d.nonLu) return { cle: 'nonlu', texte: 'Réponse prête' };
    return { cle: 'pret', texte: 'Prête' };
  }

  function nettoyer(t) {
    return String(t || '').replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim();
  }

  function croix() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M3 3l6 6M9 3l-6 6');
    svg.appendChild(p);
    return svg;
  }

  function rendre() {
    liste.textContent = '';
    vide.hidden = donnees.length > 0;
    var doublons = {};
    donnees.forEach(function (d) { doublons[d.projet] = (doublons[d.projet] || 0) + 1; });
    donnees.forEach(function (d) {
      var e = etatDe(d);
      var item = el('div', 'item e-' + e.cle);
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.dataset.id = d.id;
      if (d.actif) { item.classList.add('actif'); item.setAttribute('aria-current', 'true'); }
      if (e.cle === 'attend') item.classList.add('attend');

      var l1 = el('div', 'ligne1');
      if (d.emoji) l1.appendChild(el('span', 'emoji', d.emoji));
      var nom = el('span', 'projet', d.projet || 'Session');
      if (doublons[d.projet] > 1 && d.cwd) nom.appendChild(el('span', 'dossier', ' · ' + d.cwd.split('/').filter(Boolean).pop()));
      l1.appendChild(nom);
      if (d.fermeture) {
        item.removeAttribute('role'); item.tabIndex = -1;
        item.setAttribute('aria-label', (d.projet || 'Session') + ' : fermeture en cours');
        item.appendChild(l1);
        var ef = el('div', 'etat');
        ef.appendChild(el('span', 'spinner'));
        ef.appendChild(el('span', 'etat-texte', e.texte));
        var tf = el('span', 'temps', duree(d.maj)); tf.dataset.debut = d.maj; ef.appendChild(tf);
        item.appendChild(ef);
        liste.appendChild(item);
        return;
      }
      if (d.numero <= 9) l1.appendChild(el('span', 'raccourci', '⌘' + d.numero));
      var f = el('button', 'fermer');
      f.type = 'button';
      f.title = 'Fermer la session';
      f.setAttribute('aria-label', 'Fermer la session ' + (d.projet || ''));
      f.appendChild(croix());
      f.addEventListener('click', function (ev) { ev.stopPropagation(); envoyer({ type: 'fermer', id: d.id }); });
      l1.appendChild(f);
      item.appendChild(l1);

      var et = el('div', 'etat');
      et.appendChild(el('span', 'point'));
      et.appendChild(el('span', 'etat-texte', e.texte));
      if (d.maj) { var t = el('span', 'temps', temps(d.maj)); t.dataset.maj = d.maj; et.appendChild(t); }
      item.appendChild(et);

      var r = nettoyer(d.resume || d.dernierMessage);
      // un résumé qui ne fait que répéter l'état (« Prêt », « Travaille… ») n'apporte rien
      if (/^(prêt|prête|travaille|terminé|terminée|en attente)\W*$/i.test(r)) r = '';
      if (r) item.appendChild(el('div', 'resume', r));

      item.addEventListener('click', function () { envoyer({ type: 'choisir', id: d.id }); });
      item.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); envoyer({ type: 'choisir', id: d.id }); }
      });
      liste.appendChild(item);
    });
  }

  window.barreSessions = {
    maj: function (l) { donnees = Array.isArray(l) ? l : []; rendre(); }
  };

  // les durées « il y a » se rafraîchissent sans tout redessiner
  setInterval(function () {
    document.querySelectorAll('.temps').forEach(function (t) { t.textContent = temps(Number(t.dataset.maj)); });
  }, 30000);
  // chronomètre des fermetures en cours
  setInterval(function () {
    document.querySelectorAll('.temps[data-debut]').forEach(function (t) { t.textContent = duree(Number(t.dataset.debut)); });
  }, 1000);

  function nouvelle() { envoyer({ type: 'nouvelle' }); }
  document.getElementById('nouvelle').addEventListener('click', nouvelle);
  document.getElementById('nouvelle-vide').addEventListener('click', nouvelle);

  if (!pont) {
    // aperçu dans un navigateur : fausses données
    document.documentElement.classList.add('dev');
    var m = Date.now();
    window.barreSessions.maj([
      { id: 'a', numero: 1, emoji: '🖥️', projet: 'Better Terminal For Claude', etat: 'travaille', resume: 'Construit la barre latérale des sessions dans une seule fenêtre.', maj: m - 20000, actif: true },
      { id: 'b', numero: 2, emoji: '⚖️', projet: 'Roy', etat: 'attend', resume: 'Autoriser l’écriture de landing/index.html ?', maj: m - 90000 },
      { id: 'c', numero: 3, emoji: '🏓', projet: 'Ping Pong Edit', etat: 'pret', nonLu: true, resume: 'Le rendu des sous-titres est corrigé, trois fichiers modifiés.', maj: m - 600000 },
      { id: 'd', numero: 4, emoji: '🛰️', projet: 'Cockpit', etat: 'pret', resume: 'Les sessions en attente s’allument en orange.', maj: m - 7200000 },
      { id: 'e', numero: 5, emoji: '🤖', projet: 'Jarvis-Ultron-Telegram', etat: 'pret', dansTerminal: true, resume: '', maj: m - 90000000 },
      { id: 'f', numero: 99, emoji: '🏢', projet: 'QG', fermeture: true, maj: m - 14000 }
    ]);
  } else {
    envoyer({ type: 'pret' });
  }
})();
