/* Jarvis Terminal — limites de l'abonnement, en bas de la barre des sessions (11/11/2026, demande d'Eliot :
 * « toujours visible dans l'app », à la place de l'aide ⌘1 à ⌘9, couleurs qui varient vraiment sur toute l'échelle).
 *
 * Source : le dernier relevé du quota (rate_limit_event), écrit par session.js dans localStorage « bt.quota.calibrage »
 * (champ `dernier` : { cinqH: {pct, resetsAt}, semaine: {…}, t }). Même stockage pour toutes les pages de l'app :
 * l'événement « storage » arrive dès qu'une session reçoit un relevé.
 * Couleur : teinte continue, vert (0 %) → jaune (50 %) → orange → rouge (100 %). La barre est un dégradé du vert à la
 * couleur atteinte. Le trait fin montre où on en est dans le temps de la fenêtre (5 h ou 7 jours). */
(function () {
  'use strict';
  var CLE = 'bt.quota.calibrage';
  var FENETRES = [
    { cle: 'cinqH', nom: '5 h', duree: 5 * 3600 },
    { cle: 'semaine', nom: 'Semaine', duree: 7 * 86400 }
  ];
  var JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  var pied = document.getElementById('limites');
  var vide = document.getElementById('limites-vide');
  if (!pied) return;

  function el(tag, cls, texte) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texte != null) e.textContent = texte;
    return e;
  }

  /* 0 → 140 (vert), 50 → 70 (jaune), 100 → 0 (rouge). */
  function teinte(pct) { return Math.round(140 * (1 - Math.max(0, Math.min(100, pct)) / 100)); }
  function couleur(pct) { return 'hsl(' + teinte(pct) + ', 72%, 58%)'; }

  function heure(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

  /* « dans 2 h 14 », « dans 38 min », au-delà d'un jour « jeu. 03:00 ». */
  function remise(s) {
    if (!s) return '';
    var reste = s - Date.now() / 1000;
    if (reste <= 0) return '';
    if (reste < 3600) return 'dans ' + Math.max(1, Math.round(reste / 60)) + ' min';
    if (reste < 86400) {
      var h = Math.floor(reste / 3600), m = Math.round((reste % 3600) / 60);
      if (m === 60) { h++; m = 0; }
      return 'dans ' + h + ' h' + (m ? ' ' + String(m).padStart(2, '0') : '');
    }
    var d = new Date(s * 1000);
    return JOURS[d.getDay()] + ' ' + heure(d);
  }

  function lire() {
    try { var v = localStorage.getItem(CLE); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }

  var lignes = {};
  FENETRES.forEach(function (f) {
    var l = el('div', 'limite');
    var tete = el('div', 'limite-tete');
    var nom = el('span', 'limite-nom', f.nom);
    var pct = el('span', 'limite-pct');
    var rem = el('span', 'limite-remise');
    tete.appendChild(nom); tete.appendChild(pct); tete.appendChild(rem);
    var barre = el('div', 'limite-barre');
    var rempli = el('div', 'limite-rempli');
    var temps = el('div', 'limite-temps');
    barre.appendChild(rempli); barre.appendChild(temps);
    l.appendChild(tete); l.appendChild(barre);
    l.hidden = true;
    pied.appendChild(l);
    lignes[f.cle] = { l: l, pct: pct, rem: rem, rempli: rempli, temps: temps };
  });

  function afficher() {
    var c = lire(), d = c && c.dernier, maintenant = Date.now() / 1000, visibles = 0;
    FENETRES.forEach(function (f) {
      var q = d && d[f.cle], x = lignes[f.cle];
      var vivant = q && typeof q.pct === 'number' && (!q.resetsAt || q.resetsAt > maintenant);
      x.l.hidden = !vivant;
      if (!vivant) return;
      visibles++;
      var p = Math.max(0, Math.min(100, q.pct)), coul = couleur(p);
      x.pct.textContent = Math.round(p) + ' %';
      x.pct.style.color = coul;
      x.rem.textContent = remise(q.resetsAt);
      x.rempli.style.width = Math.max(p, p > 0 ? 2 : 0) + '%';
      // dégradé du vert à la couleur atteinte : on voit le chemin parcouru
      x.rempli.style.background = 'linear-gradient(90deg, ' + couleur(0) + ', ' + (p > 50 ? couleur(50) + ' ' + (5000 / p) + '%, ' : '') + coul + ')';
      x.rempli.style.boxShadow = '0 0 8px hsla(' + teinte(p) + ', 72%, 58%, .35)';
      var t = q.resetsAt ? 1 - (q.resetsAt - maintenant) / f.duree : null;
      x.temps.hidden = !(t > 0 && t < 1);
      if (t > 0 && t < 1) x.temps.style.left = (t * 100) + '%';
      var r = q.resetsAt ? new Date(q.resetsAt * 1000) : null;
      x.l.title = 'Limite ' + (f.cle === 'cinqH' ? 'sur 5 heures' : 'de la semaine') + ' : ' + (Math.round(p * 10) / 10).toString().replace('.', ',') + ' % utilisés' +
        (r ? '\nRemise à zéro : ' + JOURS[r.getDay()] + ' ' + heure(r) : '') +
        (t > 0 && t < 1 ? '\nTemps écoulé dans la fenêtre : ' + Math.round(t * 100) + ' % (trait blanc)' : '') +
        (d.t ? '\nRelevé à ' + heure(new Date(d.t)) : '');
    });
    vide.hidden = visibles > 0;
  }

  window.addEventListener('storage', function (ev) { if (ev.key === CLE || ev.key === null) afficher(); });
  setInterval(afficher, 30000);   // remise « dans … » et trait du temps ; pas une animation
  afficher();
  window.limitesBarre = { rafraichir: afficher };

  if (!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.barre) && !lire()) {
    // aperçu dans un navigateur : fausses données
    var n = Date.now() / 1000;
    localStorage.setItem(CLE, JSON.stringify({ dernier: { cinqH: { pct: 63, resetsAt: n + 4900 }, semaine: { pct: 28, resetsAt: n + 3.2 * 86400 }, t: Date.now() } }));
    afficher();
  }
})();
