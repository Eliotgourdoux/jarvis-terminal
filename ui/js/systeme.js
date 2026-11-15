/* Jarvis Terminal — la machine en direct, au pied de la barre des sessions (15/11/2026, demande d'Eliot : « un petit truc
 * sur le côté en mode btop pour l'espace disque et la conso de RAM »).
 *
 * Source : FenetrePrincipale.swift appelle window.systemeBarre.maj(relevé) toutes les 3 s quand la fenêtre est visible
 * (relevé : app/Sources/Systeme.swift). Trois lignes, nom · barre · valeur :
 *  - CPU : part non oisive depuis le relevé précédent ;
 *  - RAM : « Mémoire utilisée » du Moniteur d'activité (apps + câblée + compressée) ; le début de la barre, en or,
 *          est la part des processus claude ; la valeur passe en rouge si macOS signale une pression mémoire ;
 *  - Disque : la barre montre l'espace occupé, la valeur l'espace libre (celui du Finder).
 * Couleur de barre : même teinte continue vert → rouge que limites.js. Détail complet au survol. */
(function () {
  'use strict';
  var pied = document.getElementById('systeme');
  if (!pied) return;
  var PRESSION = { 1: 'normale', 2: 'élevée', 4: 'critique' };

  function el(tag, cls, texte) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texte != null) e.textContent = texte;
    return e;
  }
  function couleur(pct) { return 'hsl(' + Math.round(140 * (1 - Math.max(0, Math.min(100, pct)) / 100)) + ', 72%, 58%)'; }
  function virgule(x, dec) { return x.toFixed(dec).replace('.', ','); }
  /* Go à une décimale sous 100, sans au-delà ; To au-delà de 1000 Go (base 1000 pour le disque, comme le Finder). */
  function go(o, base) {
    var g = o / Math.pow(base || 1024, 3);
    if (g >= 1000) return virgule(g / 1000, 1) + ' To';
    return (g >= 100 ? Math.round(g) : virgule(g, 1)) + ' Go';
  }

  var lignes = {};
  function ligne(cle, nom) {
    var n = el('span', 'sys-nom', nom), b = el('div', 'sys-barre'), r = el('div', 'sys-rempli'), v = el('span', 'sys-val');
    b.appendChild(r);
    var c = null;
    if (cle === 'ram') { c = el('div', 'sys-claude'); c.hidden = true; b.appendChild(c); }
    [n, b, v].forEach(function (x) { pied.appendChild(x); });
    lignes[cle] = { n: n, b: b, r: r, v: v, c: c };
  }
  function titre(x, t) { x.n.title = x.b.title = x.v.title = t; }
  function remplir(x, pct) {
    var p = Math.max(0, Math.min(100, pct));
    x.r.style.width = Math.max(p, p > 0 ? 2 : 0) + '%';
    x.r.style.backgroundColor = couleur(p);
  }
  function valeur(x, fort, suite) {
    x.v.textContent = '';
    x.v.appendChild(el('b', null, fort));
    if (suite) x.v.appendChild(document.createTextNode(suite));
  }

  function maj(r) {
    if (!r || typeof r !== 'object') return;
    if (!lignes.cpu) { ligne('cpu', 'CPU'); ligne('ram', 'RAM'); ligne('disque', 'Disque'); }

    var x = lignes.cpu;
    if (typeof r.cpu === 'number') {
      remplir(x, r.cpu);
      valeur(x, Math.round(r.cpu) + ' %');
      titre(x, 'Processeur : ' + virgule(r.cpu, 1) + ' % utilisé (tous cœurs, sur les 3 dernières secondes)');
    } else if (!x.v.textContent) valeur(x, '—');

    var m = r.ram;
    x = lignes.ram;
    if (m && m.total > 0 && typeof m.utilisee === 'number') {
      var pct = m.utilisee / m.total * 100;
      remplir(x, pct);
      valeur(x, go(m.utilisee).replace(' Go', ''), ' / ' + go(m.total));
      var alerte = m.pression === 2 || m.pression === 4;
      x.v.classList.toggle('alerte', alerte);
      var cl = m.claude || {};
      x.c.hidden = !(cl.octets > 0);
      x.c.style.width = Math.min(100, cl.octets / m.total * 100) + '%';
      titre(x, 'Mémoire utilisée : ' + go(m.utilisee) + ' sur ' + go(m.total) + ' (' + Math.round(pct) + ' %)' +
        '\nApplications : ' + go(m.apps || 0) + ' · câblée : ' + go(m.cablee || 0) + ' · compressée : ' + go(m.compressee || 0) +
        (typeof m.swap === 'number' ? '\nSwap : ' + go(m.swap) : '') +
        (cl.nombre ? '\nProcessus claude (' + cl.nombre + ') : ' + go(cl.octets) + ' (en or dans la barre)' : '') +
        (PRESSION[m.pression] ? '\nPression mémoire : ' + PRESSION[m.pression] : ''));
    }

    var d = r.disque;
    x = lignes.disque;
    if (d && d.total > 0) {
      var occupe = (d.total - d.libre) / d.total * 100;
      remplir(x, occupe);
      valeur(x, go(d.libre, 1000), ' libres');
      x.v.classList.toggle('alerte', d.libre < 20e9);
      titre(x, 'Disque' + (d.nom ? ' « ' + d.nom + ' »' : '') + ' : ' + go(d.libre, 1000) + ' libres sur ' + go(d.total, 1000) +
        ' (' + Math.round(occupe) + ' % occupé)');
    }
  }

  window.systemeBarre = { maj: maj };

  if (!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.barre)) {
    // aperçu dans un navigateur : fausses données
    maj({ cpu: 23, ram: { total: 24 * 1073741824, utilisee: 15.8 * 1073741824, apps: 9e9, cablee: 3e9, compressee: 2e9, swap: 0,
          pression: 1, claude: { octets: 1.4 * 1073741824, nombre: 3 } }, disque: { total: 994e9, libre: 212e9, nom: 'Macintosh HD' } });
  }
})();
