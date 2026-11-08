/* Jarvis Terminal — « Agents au travail » (08/11/2026, Eliot : « pourquoi je vois pas tes agents qui travaillent ? »).
 * Avant, un sous-agent n'existait qu'en appel d'outil replié dans le fil. Désormais, tant qu'un agent tourne,
 * un bandeau au-dessus de la saisie montre une ligne par agent : sa mission, ce qu'il fait à l'instant,
 * le nombre d'étapes et depuis combien de temps. Un clic déplie ses dernières étapes, en direct.
 * À la fin, la ligne passe en vert « terminé » quelques secondes, puis disparaît.
 * Page → Swift : agents {ids: [toolUseId…]} (les appels Agent en cours, renvoyé à chaque changement).
 * Swift → page : bt.agents([{id, etapes:[{n, e, t}], nb, texte?, fini, deja?}]) (SuiviAgents.swift). */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var el = BT.el;
  var GARDER_FINI = 6000;
  var VERBES = {
    Read: 'Lit', Write: 'Écrit', Edit: 'Modifie', MultiEdit: 'Modifie', NotebookEdit: 'Modifie',
    Bash: 'Lance', Grep: 'Cherche', Glob: 'Liste', WebFetch: 'Lit la page', WebSearch: 'Recherche',
    Agent: 'Lance un agent', Task: 'Lance un agent', TodoWrite: 'Met à jour sa liste', ToolSearch: 'Charge un outil',
    Skill: 'Utilise', SendMessage: 'Écrit à', AskUserQuestion: 'Pose une question'
  };

  function action(nom, entree) {
    var r = BT.resumeOutil(nom, entree);
    var v = VERBES[nom] || r.nom;
    return { verbe: v, cible: r.cible || '', mono: r.mono };
  }

  function duree(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0');
  }

  function Agents(app) {
    this.app = app;
    this.session = app.session;
    this.suivis = Object.create(null);   // toolUseId → {o, etapes, nb, texte, fini, finA, ouvert, ligne}
    this.ignores = Object.create(null);  // déjà finis à la découverte (historique) : jamais affichés
    this.envoyes = '';
    this.bandeau = el('div', 'agents');
    this.bandeau.setAttribute('aria-live', 'polite');
    this.bandeau.hidden = true;
    var saisie = document.querySelector('.pied > .saisie');
    saisie.parentNode.insertBefore(this.bandeau, saisie);
    var self = this;
    this.bandeau.addEventListener('click', function (e) {
      var l = e.target.closest('.agent-tete');
      if (!l) return;
      var a = self.suivis[l.parentNode.dataset.id];
      if (a) { a.ouvert = !a.ouvert; self.rendre(); }
    });
    setInterval(function () { self.tic(); }, 1000);
    this.session.on('maj', function (it) { if (it && (it.nom === 'Agent' || it.nom === 'Task')) self.tic(); });
  }

  /* Appels Agent qui tournent peut-être encore. Pour un agent de fond rechargé depuis l'historique,
   * la page ne sait pas s'il a fini : la coque tranche (meta.json → fini, deja). */
  Agents.prototype.candidats = function () {
    var out = [], outils = this.session._outils || {};
    for (var id in outils) {
      var o = outils[id];
      if (!o || (o.nom !== 'Agent' && o.nom !== 'Task') || this.ignores[id]) continue;
      var enCours;
      if (o.tache) enCours = !/^(completed|failed|killed|stopped|cancel)/.test(o.tache.statut || '');
      else if (o.statut === 'prepare' || o.statut === 'encours') enCours = true;
      else enCours = o.statut === 'ok' && !!(o.entree && o.entree.run_in_background) &&
        /async agent launched|launched successfully|running in the background/i.test((o.resultat && o.resultat.texte) || '');
      if (enCours) out.push(id);
    }
    return out;
  };

  Agents.prototype.tic = function () {
    var ids = this.candidats(), self = this;
    ids.forEach(function (id) {
      if (self.suivis[id]) return;
      var o = self.session._outils[id];
      // Rechargé depuis l'historique : affiché seulement quand la coque confirme qu'il tourne encore.
      self.suivis[id] = { o: o, etapes: [], nb: 0, texte: '', fini: false, finA: 0, ouvert: false, confirme: !(o && o.historique) };
    });
    // Les agents finis restent affichés quelques secondes, puis s'en vont.
    var maintenant = Date.now();
    for (var id in this.suivis) {
      var a = this.suivis[id];
      if (a.fini && maintenant - a.finA > GARDER_FINI) delete this.suivis[id];
      else if (!a.fini && ids.indexOf(id) < 0) { a.fini = true; a.finA = maintenant; this.ignores[id] = true; }
    }
    var cle = ids.slice().sort().join(',');
    if (cle !== this.envoyes) {
      this.envoyes = cle;
      if (BT.pont && BT.pont.natif) BT.pont.envoyer('agents', { ids: ids });
    }
    this.rendre();
  };

  Agents.prototype.recevoir = function (lot) {
    var self = this;
    (lot || []).forEach(function (r) {
      var a = self.suivis[r.id];
      if (r.deja || r.fini) self.ignores[r.id] = true;
      if (r.deja) { delete self.suivis[r.id]; return; }
      if (!a) return;
      a.confirme = true;
      (r.etapes || []).forEach(function (e) { a.etapes.push(e); });
      if (a.etapes.length > 60) a.etapes.splice(0, a.etapes.length - 60);
      if (r.nb) a.nb = r.nb;
      if (r.texte) a.texte = r.texte;
      if (r.fini && !a.fini) { a.fini = true; a.finA = Date.now(); }
    });
    this.tic();
  };

  Agents.prototype.rendre = function () {
    var self = this;
    var ids = Object.keys(this.suivis).filter(function (id) { return self.suivis[id].confirme; });
    this.bandeau.hidden = !ids.length;
    if (!ids.length) { this.bandeau.textContent = ''; return; }
    var actifs = ids.filter(function (id) { return !self.suivis[id].fini; }).length;
    var titre = this.bandeau.querySelector('.agents-titre');
    if (!titre) { titre = el('div', 'agents-titre'); this.bandeau.appendChild(titre); }
    titre.textContent = actifs ? (actifs === 1 ? '1 agent au travail' : actifs + ' agents au travail') : 'Agents terminés';

    var vus = {};
    ids.forEach(function (id) {
      vus[id] = true;
      var a = self.suivis[id], o = a.o || {}, e = o.entree || {};
      var l = a.ligne;
      if (!l) {
        l = a.ligne = el('div', 'agent', [
          el('button', 'agent-tete', [
            el('span', 'agent-point'),
            el('span', 'agent-mission'),
            el('span', 'agent-action'),
            el('span', 'agent-meta')
          ]),
          el('ol', 'agent-etapes')
        ]);
        l.dataset.id = id;
        l.querySelector('.agent-tete').type = 'button';
        self.bandeau.appendChild(l);
      }
      l.classList.toggle('fini', a.fini);
      l.classList.toggle('ouvert', a.ouvert);
      l.querySelector('.agent-mission').textContent = e.description || e.subagent_type || 'Sous-agent';
      var der = a.etapes[a.etapes.length - 1];
      var txt;
      if (a.fini) txt = 'terminé';
      else if (der) { var x = action(der.n, der.e); txt = x.verbe + (x.cible ? ' ' + x.cible : ''); }
      else txt = 'démarre…';
      l.querySelector('.agent-action').textContent = txt;
      var debut = o.debut || Date.now(), fin = a.fini ? (a.finA || Date.now()) : Date.now();
      l.querySelector('.agent-meta').textContent = (a.nb ? a.nb + (a.nb > 1 ? ' étapes · ' : ' étape · ') : '') + duree(fin - debut);
      l.querySelector('.agent-tete').title = a.ouvert ? 'Replier' : 'Voir ce qu’il fait';

      var ol = l.querySelector('.agent-etapes');
      ol.hidden = !a.ouvert;
      if (a.ouvert) {
        var dernieres = a.etapes.slice(-10);
        var sig = a.etapes.length + '|' + (a.texte || '').length;
        if (ol.dataset.sig !== sig) {
          ol.dataset.sig = sig;
          ol.textContent = '';
          if (!dernieres.length) ol.appendChild(el('li', 'agent-vide', 'Pas encore d’étape visible.'));
          dernieres.forEach(function (et) {
            var x = action(et.n, et.e);
            ol.appendChild(el('li', '', [el('span', 'agent-verbe', x.verbe), el('span', x.mono ? 'agent-cible mono' : 'agent-cible', x.cible)]));
          });
          if (a.texte) ol.appendChild(el('li', 'agent-dit', BT.texteResume ? BT.texteResume(a.texte, 220) : a.texte.slice(0, 220)));
        }
      }
    });
    Array.prototype.slice.call(this.bandeau.querySelectorAll('.agent')).forEach(function (n) {
      if (!vus[n.dataset.id]) n.remove();
    });
  };

  BT.Agents = Agents;
})();
