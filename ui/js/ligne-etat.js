/* Better Terminal For Claude — ligne d'état, tout en bas du pied.
 *
 * Une ligne fine et atténuée, toujours visible : contexte utilisé par la session, part du quota 5 h prise par la
 * dernière réponse (estimée, voir session.js « Consommation »), quota de l'abonnement sur 5 h et sur la semaine.
 * Couleurs : neutre, ambre au-delà de 80 %, rouge au-delà de 95 %. Le détail est dans les infobulles.
 * Écoute 'etatConso' de la session ; le quota étant celui du compte, un relevé reçu par une autre fenêtre de
 * l'app (événement storage) met aussi la ligne à jour. Créée ici, dans footer#pied, après la saisie. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var ESP = ' ';
  var JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

  function el(tag, cls, texte) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texte != null) e.textContent = texte;
    return e;
  }

  function niveau(pct) { return pct > 95 ? 'critique' : pct > 80 ? 'haut' : ''; }

  function entierPct(pct) { return Math.round(pct) + ESP + '%'; }

  /* 124 000 → « 124 k », 1 000 000 → « 1 M », 1 250 000 → « 1,25 M ». */
  function jetons(n) {
    if (n >= 1e6) return String(Math.round(n / 1e4) / 100).replace('.', ',') + ESP + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + ESP + 'k';
    return String(n);
  }

  function dollars(v) {
    return (v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)).replace('.', ',') + ESP + '$';
  }

  /* Heure de remise à zéro : « 14:00 » aujourd'hui, « demain à 02:00 », sinon « lundi à 14:00 ». */
  function remise(s) {
    if (!s) return '';
    var d = new Date(s * 1000), auj = new Date();
    var jours = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(auj.getFullYear(), auj.getMonth(), auj.getDate())) / 864e5);
    var h = BT.heure(d);
    if (jours <= 0) return 'à ' + h;
    if (jours === 1) return 'demain à ' + h;
    return JOURS[d.getDay()] + ' à ' + h;
  }

  function LigneEtat(app) {
    this.app = app;
    this.session = null;
    var e = this.el = el('div', 'pied-ligne-etat');
    e.id = 'ligne-etat';
    e.setAttribute('role', 'status');
    this.contexte = el('span', 'le-morceau le-contexte');
    this.droite = el('span', 'le-droite');
    this.derniere = el('span', 'le-morceau le-derniere');
    this.cinqH = el('span', 'le-morceau le-cinq');
    this.semaine = el('span', 'le-morceau le-semaine');
    this.sep1 = el('span', 'le-sep', '·');
    this.sep2 = el('span', 'le-sep', '·');
    this.droite.appendChild(this.derniere);
    this.droite.appendChild(this.sep1);
    this.droite.appendChild(this.cinqH);
    this.droite.appendChild(this.sep2);
    this.droite.appendChild(this.semaine);
    e.appendChild(this.contexte);
    e.appendChild(el('span', 'le-espace'));
    e.appendChild(this.droite);
    var pied = document.getElementById('pied');
    if (pied) pied.appendChild(e);

    var self = this;
    this._ecoute = function (etat) { self.afficher(etat); };
    this.brancher(app && app.session);
    // Relevé du quota reçu par une autre fenêtre de l'app : même compte, même quota.
    window.addEventListener('storage', function (ev) {
      if (ev.key === 'bt.quota.calibrage' || ev.key === null) self.rafraichir();
    });
    // Une remise à zéro passée doit disparaître même si rien ne bouge (pas une animation : une fois par minute).
    setInterval(function () { self.rafraichir(); }, 60000);
  }

  /* Abonnement à la session (rebranchable si l'app en change un jour). */
  LigneEtat.prototype.brancher = function (session) {
    if (session === this.session) return;
    if (this.session && this.session.off) this.session.off('etatConso', this._ecoute);
    this.session = session || null;
    if (this.session) this.session.on('etatConso', this._ecoute);
    this.rafraichir();
  };

  LigneEtat.prototype.rafraichir = function () {
    var s = BT.app && BT.app.session;
    if (s && s !== this.session) { this.brancher(s); return; }
    this.afficher(this.session && this.session.etatConso ? this.session.etatConso() : null);
  };

  function poser(span, texte, titre, pct) {
    span.hidden = !texte;
    span.textContent = texte || '';
    span.title = titre || '';
    span.classList.toggle('niveau-haut', niveau(pct) === 'haut');
    span.classList.toggle('niveau-critique', niveau(pct) === 'critique');
  }

  LigneEtat.prototype.afficher = function (etat) {
    etat = etat || {};
    var c = etat.contexte;
    if (c) {
      poser(this.contexte, 'Contexte ' + entierPct(c.pct),
        'Contexte utilisé : ' + jetons(c.jetons) + ' / ' + jetons(c.fenetre) + ' jetons (' + c.jetons.toLocaleString('fr-FR') + ')\n' +
        'Mesuré au dernier appel de Claude, sans les sous-agents.', c.pct);
    } else {
      poser(this.contexte, 'Contexte —', 'Contexte utilisé : connu après la première réponse de Claude.', 0);
    }

    // 5 h et semaine : déplacés en bas de la barre des sessions (limites.js, demande d'Eliot du 11/11/2026).
    var q5 = null, q7 = null;
    poser(this.cinqH, q5 ? '5 h ' + entierPct(q5.pct) : '',
      q5 ? 'Quota de l’abonnement sur 5 heures : ' + entierPct(q5.pct) + '\nRemise à zéro ' + remise(q5.resetsAt) : '', q5 ? q5.pct : 0);
    poser(this.semaine, q7 ? (q5 ? 'sem. ' : 'Semaine ') + entierPct(q7.pct) : '',
      q7 ? 'Quota de l’abonnement sur la semaine : ' + entierPct(q7.pct) + '\nRemise à zéro ' + remise(q7.resetsAt) : '', q7 ? q7.pct : 0);

    // Allégé (Eliot, 09/11/2026 : « trop chargé ») : le % par réponse n'est plus que sous chaque réponse.
    var d = null, cal = etat.calibrage || {}, texte = '', titre = '';
    if (d && typeof d.pct === 'number') {
      texte = 'Dernière réponse ≈ ' + BT.pctQuota(d.pct);
      titre = 'Part du quota sur 5 heures prise par la dernière réponse (estimation).\n' +
        'Coût du tour : ' + dollars(d.cout) + ' en équivalent API' +
        (cal.k ? ', et 1 point de quota ≈ ' + dollars(1 / cal.k) + ' (calibré sur ' + cal.releves + ' relevé' + (cal.releves > 1 ? 's' : '') + ').' : '.');
    } else if (d && !cal.pret) {
      texte = 'Dernière réponse : calibrage…';
      titre = 'Le quota n’est donné qu’au point près : l’app apprend combien coûte un point en observant ses hausses.\n' +
        'Estimation possible après ' + cal.min + ' points de hausse observés (' + String(Math.round((cal.points || 0) * 10) / 10).replace('.', ',') + ' pour l’instant).';
    }
    poser(this.derniere, texte, titre, 0);

    this.sep1.hidden = this.derniere.hidden || (this.cinqH.hidden && this.semaine.hidden);
    this.sep2.hidden = this.cinqH.hidden || this.semaine.hidden;
  };

  BT.LigneEtat = LigneEtat;

  function init() {
    if (!BT.app || BT.ligneEtat) return;
    BT.ligneEtat = new LigneEtat(BT.app);
  }
  // Chargé avant app.js : on attend que la page soit câblée (BT.app).
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
})();
