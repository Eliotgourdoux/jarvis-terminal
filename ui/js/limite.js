/* File « limite » (18/11/2026) : quand la limite d'usage de l'abonnement est atteinte, les messages d'Eliot
 * attendent dans la coque (app/Sources/LimiteUsage.swift) et partent tous à la minute de la reprise.
 * Ici : la bande au-dessus de la saisie, qui dit l'heure de reprise et ce qui attend. */
(function () {
  'use strict';
  var BT = window.BT;

  function Limite(app) {
    var self = this;
    this.app = app;
    this.el = document.getElementById('saisie-limite');
    this.texte = this.el.querySelector('.saisie-limite-texte');
    this.btEnvoyer = document.getElementById('bt-limite-envoyer');
    this.btVider = document.getElementById('bt-limite-vider');
    this.btEnvoyer.addEventListener('click', function () { BT.pont.envoyer('limite', { action: 'envoyer' }); });
    this.btVider.addEventListener('click', function () { app.session.viderLimite(); });
    app.session.on('limite', function () { self.rendre(); });
    // le compte à rebours avance tout seul, une fois par demi-minute (pas d'animation)
    setInterval(function () { if (!self.el.hidden) self.rendre(); }, 30000);
    this.rendre();
  }

  function dans(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 1) return 'dans moins d’une minute';
    if (m < 60) return 'dans ' + m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return 'dans ' + h + ' h' + (r ? ' ' + (r < 10 ? '0' : '') + r : '');
  }

  Limite.prototype.rendre = function () {
    var l = this.app.session.limite;
    if (!l || !l.retient) { this.el.hidden = true; return; }
    var n = (l.attente || []).length, reprend = l.coupee && l.auto;
    var quand = '';
    if (l.reprise) {
      var q = new Date(l.reprise);
      var jour = q.toDateString() === new Date().toDateString() ? '' : ' ' + q.toLocaleDateString('fr-FR', { weekday: 'long' });
      quand = l.reprise > Date.now() ? ' Reprise à ' + BT.heure(q) + jour + ' (' + dans(l.reprise - Date.now()) + ').' : ' Reprise dans un instant.';
    } else quand = ' Reprise dans un instant.';
    var suite;
    if (n && reprend) suite = 'Claude reprendra tout seul, puis recevra ' + (n > 1 ? 'tes ' + n + ' messages' : 'ton message') + '.';
    else if (n) suite = (n > 1 ? 'Tes ' + n + ' messages partiront' : 'Ton message partira') + ' à ce moment-là.';
    else if (reprend) suite = 'Claude reprendra tout seul. Ce que tu écris d’ici là partira en même temps.';
    else if (l.coupee) suite = 'Trop de refus d’affilée : Claude ne reprendra pas tout seul. Ce que tu écris partira à ce moment-là.';
    else suite = 'Ce que tu écris ici partira à ce moment-là.';
    this.texte.replaceChildren(
      BT.el('b', '', 'Limite d’usage atteinte.'),
      document.createTextNode(quand + ' ' + suite));
    this.btEnvoyer.hidden = !(n || l.coupee);
    this.btVider.hidden = !(n || l.coupee);
    this.btVider.textContent = n ? 'Vider' : 'Ne pas reprendre';
    this.el.hidden = false;
  };

  BT.Limite = Limite;
})();
