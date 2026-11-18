/* Jarvis Terminal — barre latérale des sessions.
 * Swift → page : window.barreSessions.maj([{id, numero, projet, emoji, etat, resume, dernierMessage,
 *                dansTerminal, maj, actif, nonLu}])
 *                + en bas, les fermetures avec bilan en cours : {id, projet, emoji, fermeture: true, maj}
 *                2e argument : la conversation Telegram avec Jarvis {apercu, maj, actif, nonLu, occupe} ou null
 *                3e argument (12/11/2026) : état des machines {victus: {configure, etat: 'connecte'|'connexion'|'injoignable'|'inactif', erreur}}
 *                Une session du Victus porte en plus {machine:'victus', ouverte, indisponible} : encadré « Ultron ».
 * Swift → page : barreSessions.dossiers({liste:[{cwd, nom, maj}], home, erreur?}), .erreur(texte), .ouverte(cwd)
 *                barreSessions.config({app, machine, choixMachine}) : app GTK du Victus (« Ultron Terminal »),
 *                appelée par victus/linux/app avec {app:'ultron-terminal', machine:'victus', choixMachine:false}.
 * Page → Swift : {type:'pret'} {type:'choisir', id} {type:'fermer', id} {type:'nouvelle'} {type:'jarvis'}
 *                {type:'dossiers'} {type:'nouvelle', machine:'victus', cwd} (cwd absolu ou « ~/… ») */
(function () {
  'use strict';

  var pont = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.barre;
  function envoyer(o) { if (pont) pont.postMessage(o); else console.log('[barre]', o); }

  var liste = document.getElementById('liste');
  var vide = document.getElementById('vide');
  var donnees = [];
  var jarvis = null;
  var machines = null;
  // Barre du Mac par défaut ; l'app du Victus appelle barreSessions.config({app:'ultron-terminal', machine:'victus', choixMachine:false}).
  var conf = { app: 'jarvis-terminal', machine: 'mac', choixMachine: true };
  function surVictus() { return conf.machine === 'victus'; }

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
    if (d.indisponible) return { cle: 'indispo', texte: 'Victus injoignable' };
    if (d.dansTerminal) return { cle: 'termine', texte: 'Dans le Terminal' };
    if (d.etat === 'attend') return { cle: 'attend', texte: 'Claude t’attend' };
    if (d.etat === 'travaille') return { cle: 'travaille', texte: 'Travaille…' };
    if (d.etat === 'termine') return { cle: 'termine', texte: 'Terminée' };
    // coupée par la limite d'usage, ou messages gardés : elle repart toute seule à l'heure dite
    if (d.limite && d.limite.reprise) {
      var hr = new Date(d.limite.reprise), nm = d.limite.messages || 0;
      return { cle: 'nonlu', texte: 'Reprend à ' + (hr.getHours() < 10 ? '0' : '') + hr.getHours() + ':' + (hr.getMinutes() < 10 ? '0' : '') + hr.getMinutes() +
        (nm ? ' · ' + nm + (nm > 1 ? ' messages' : ' message') : '') };
    }
    // tour fini mais agents de fond encore au travail : la session n'est pas vraiment « prête »
    if (d.agents > 0) return { cle: 'travaille', texte: d.agents > 1 ? d.agents + ' agents au travail…' : 'Un agent au travail…' };
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

  /* Conversation Telegram avec Jarvis : épinglée en haut, au-dessus des sessions. */
  function rendreJarvis() {
    var item = el('div', 'item item-jarvis');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    if (jarvis.actif) { item.classList.add('actif'); item.setAttribute('aria-current', 'true'); }
    var l1 = el('div', 'ligne1');
    l1.appendChild(el('span', 'emoji', '🤖'));
    l1.appendChild(el('span', 'projet', 'Jarvis'));
    l1.appendChild(el('span', 'canal', 'Telegram'));
    item.appendChild(l1);
    var et = el('div', 'etat');
    var cle = jarvis.occupe ? 'travaille' : jarvis.nonLu ? 'nonlu' : 'pret';
    item.classList.add('e-' + cle);
    et.appendChild(el('span', 'point'));
    et.appendChild(el('span', 'etat-texte', jarvis.occupe ? 'Jarvis réfléchit…' : jarvis.nonLu ? 'Nouveau message' : 'Conversation'));
    if (jarvis.maj) { var t = el('span', 'temps', temps(jarvis.maj)); t.dataset.maj = jarvis.maj; et.appendChild(t); }
    item.appendChild(et);
    var r = nettoyer(jarvis.apercu);
    if (r) item.appendChild(el('div', 'resume', r));
    function ouvrir() { envoyer({ type: 'jarvis' }); }
    item.addEventListener('click', ouvrir);
    item.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ouvrir(); } });
    liste.appendChild(item);
    liste.appendChild(el('div', 'separateur-jarvis'));
  }

  // Fermetures déjà affichées : l'animation d'entrée ne se joue qu'une fois (la liste est redessinée à chaque mise à jour).
  var fermeturesVues = Object.create(null);

  function etatLien() {
    var v = machines && machines.victus;
    if (!v || !v.configure) return '';
    if (v.etat === 'connexion') return 'connexion…';
    if (v.etat === 'injoignable') return 'injoignable';
    return '';
  }

  function rendre() {
    liste.textContent = '';
    if (jarvis) rendreJarvis();
    vide.hidden = donnees.length > 0;
    var separateurMis = false;
    var doublons = {};
    donnees.forEach(function (d) { doublons[d.projet] = (doublons[d.projet] || 0) + 1; });
    donnees.forEach(function (d) {
      var e = etatDe(d);
      var victus = d.machine === 'victus' && !surVictus();
      // Victus injoignable : un filet « Victus · injoignable » avant ses sessions (grisées)
      if (victus && !separateurMis && !d.fermeture) {
        separateurMis = true;
        var et0 = etatLien();
        if (et0) {
          var sep = el('div', 'separateur-machine', 'Victus');
          sep.appendChild(el('span', 'lien-etat', '· ' + et0));
          liste.appendChild(sep);
        }
      }
      var item = el('div', 'item e-' + e.cle);
      if (d.machine === 'victus') item.classList.add('victus');
      if (d.machine === 'victus' && d.ouverte === false) item.classList.add('non-ouverte');
      if (d.indisponible) item.classList.add('indispo');
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.dataset.id = d.id;
      if (d.actif) { item.classList.add('actif'); item.setAttribute('aria-current', 'true'); }
      if (e.cle === 'attend') item.classList.add('attend');

      // Sous-projet : le nom du projet parent au-dessus, et un retrait quand le parent est juste avant dans la liste.
      if (d.parent) {
        item.classList.add('sous-projet');
        item.appendChild(el('div', 'parent', String(d.parent) + ' ›'));
      }
      var l1 = el('div', 'ligne1');
      if (d.emoji) l1.appendChild(el('span', 'emoji', d.emoji));
      var nom = el('span', 'projet', d.projet || 'Session');
      if (doublons[d.projet] > 1 && d.cwd) nom.appendChild(el('span', 'dossier', ' · ' + d.cwd.split('/').filter(Boolean).pop()));
      l1.appendChild(nom);
      if (victus) {
        var tag = el('span', 'encadre-machine', 'Ultron');
        tag.title = 'Session du Victus';
        l1.appendChild(tag);
      }
      if (d.fermeture) {
        item.removeAttribute('role'); item.tabIndex = -1;
        item.setAttribute('aria-label', (d.projet || 'Session') + ' : fermeture en cours');
        if (!fermeturesVues[d.id]) { fermeturesVues[d.id] = 1; item.classList.add('arrive'); }
        item.appendChild(l1);
        var ef = el('div', 'etat');
        ef.appendChild(el('span', 'spinner'));
        ef.appendChild(el('span', 'etat-texte', e.texte));
        var tf = el('span', 'temps', duree(d.maj)); tf.dataset.debut = d.maj; ef.appendChild(tf);
        item.appendChild(ef);
        liste.appendChild(item);
        return;
      }
      if (d.numero <= 9) l1.appendChild(el('span', 'raccourci', (surVictus() ? 'Ctrl+' : '⌘') + d.numero));
      var f = el('button', 'fermer');
      f.type = 'button';
      f.title = d.machine === 'victus' && !surVictus() ? 'Arrêter la session sur le Victus' : 'Fermer la session';
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

  /* ---------- Nouvelle session : Mac ou Victus ---------- */

  var menu = document.getElementById('menu-machine');
  var panneau = document.getElementById('panneau-victus');
  var chemin = document.getElementById('panneau-chemin');
  var message = document.getElementById('panneau-message');
  var dossiersEl = document.getElementById('panneau-dossiers');
  var boutonOuvrir = panneau.querySelector('.panneau-ouvrir');
  var home = '/home/eliotgrx';
  var alerte = el('div', 'alerte-barre');
  alerte.hidden = true;
  alerte.setAttribute('role', 'alert');
  alerte.addEventListener('click', function () { alerte.hidden = true; });
  liste.parentNode.insertBefore(alerte, liste);
  var minuteurAlerte = 0;

  function victusDispo() {
    if (surVictus()) return true;
    var v = machines && machines.victus;
    return !!(v && v.etat === 'connecte');
  }

  function montrerMessage(t, erreur) {
    message.hidden = !t;
    message.textContent = t || '';
    message.classList.toggle('erreur', !!erreur);
  }

  function fermerMenu() { menu.hidden = true; }

  function ouvrirMenu() {
    var bv = menu.querySelector('[data-machine="victus"]');
    bv.disabled = !victusDispo();
    var et = etatLien();
    bv.title = bv.disabled ? 'Victus ' + (et || 'injoignable') : '';
    menu.hidden = false;
    (bv.disabled ? menu.querySelector('[data-machine="mac"]') : bv).focus();
  }

  function nouvelle() {
    if (surVictus()) { ouvrirPanneau(); return; }
    var v = machines && machines.victus;
    if (!v || !v.configure || conf.choixMachine === false) { envoyer({ type: 'nouvelle' }); return; }
    if (menu.hidden) ouvrirMenu(); else fermerMenu();
  }

  function ouvrirPanneau() {
    fermerMenu();
    alerte.hidden = true;
    panneau.hidden = false;
    chemin.value = '';
    boutonOuvrir.disabled = false;
    dossiersEl.textContent = '';
    montrerMessage('Dossiers récents du Victus…', false);
    envoyer({ type: 'dossiers' });
    chemin.focus();
  }

  function fermerPanneau() { panneau.hidden = true; montrerMessage('', false); }

  function lancer(cwd) {
    cwd = String(cwd || '').trim();
    if (!cwd) { chemin.focus(); return; }
    if (cwd.charAt(0) !== '/' && cwd.charAt(0) !== '~') cwd = home.replace(/\/$/, '') + '/' + cwd;
    boutonOuvrir.disabled = true;
    montrerMessage('Ouverture sur le Victus…', false);
    envoyer({ type: 'nouvelle', machine: 'victus', cwd: cwd });
  }

  function rendreDossiers(r) {
    r = r || {};
    if (typeof r.home === 'string' && r.home.charAt(0) === '/') home = r.home;
    chemin.placeholder = '~/projets/…';
    var l = Array.isArray(r.liste) ? r.liste : [];
    dossiersEl.textContent = '';
    if (r.erreur) montrerMessage(String(r.erreur), true);
    else montrerMessage(l.length ? '' : 'Aucun dossier récent : tapez un chemin.', false);
    l.forEach(function (d) {
      if (!d || typeof d.cwd !== 'string') return;
      var b = el('button', 'dossier-victus');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.appendChild(el('span', 'dossier-nom', d.nom || d.cwd.split('/').filter(Boolean).pop() || d.cwd));
      var court = d.cwd.indexOf(home + '/') === 0 ? '~' + d.cwd.slice(home.length) : d.cwd;
      b.appendChild(el('span', 'dossier-chemin', '\u200E' + court + (d.maj ? ' · ' + temps(Number(d.maj)) : '')));
      b.title = d.cwd;
      b.addEventListener('click', function () { lancer(d.cwd); });
      dossiersEl.appendChild(b);
    });
  }

  function montrerErreur(t) {
    t = String(t || 'Erreur');
    if (!panneau.hidden) { boutonOuvrir.disabled = false; montrerMessage(t, true); return; }
    alerte.textContent = t;
    alerte.hidden = false;
    clearTimeout(minuteurAlerte);
    minuteurAlerte = setTimeout(function () { alerte.hidden = true; }, 8000);
  }

  menu.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-machine]');
    if (!b || b.disabled) return;
    fermerMenu();
    if (b.dataset.machine === 'victus') ouvrirPanneau(); else envoyer({ type: 'nouvelle' });
  });
  document.getElementById('panneau-fermer').addEventListener('click', fermerPanneau);
  document.getElementById('panneau-saisie').addEventListener('submit', function (ev) { ev.preventDefault(); lancer(chemin.value); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (!menu.hidden) { fermerMenu(); ev.preventDefault(); }
    else if (!panneau.hidden) { fermerPanneau(); ev.preventDefault(); }
    else if (!pDisc.hidden) { fermerDiscussions(); ev.preventDefault(); }
  });
  document.addEventListener('mousedown', function (ev) {
    if (!menu.hidden && !menu.contains(ev.target) && !ev.target.closest('#nouvelle, #nouvelle-vide')) fermerMenu();
  });

  // « Quitter » : arrêter les claude ou les laisser tourner en fond (réglage tenu par la coque).
  var choixFond = document.querySelectorAll('#fond [data-fond]'), fondActif = false;
  function rendreFond() {
    Array.prototype.forEach.call(choixFond, function (b) {
      b.setAttribute('aria-checked', (b.dataset.fond === '1') === fondActif ? 'true' : 'false');
    });
  }
  Array.prototype.forEach.call(choixFond, function (b) {
    b.addEventListener('click', function () {
      var v = b.dataset.fond === '1';
      if (v === fondActif) return;
      fondActif = v; rendreFond();
      envoyer({ type: 'garderEnFond', actif: fondActif });
    });
  });

  window.barreSessions = {
    fond: function (d) { fondActif = !!(d && d.actif); rendreFond(); },
    maj: function (l, j, m) {
      donnees = Array.isArray(l) ? l : [];
      jarvis = j && typeof j === 'object' ? j : null;
      if (m && typeof m === 'object') machines = m;
      rendre();
    },
    dossiers: rendreDossiers,
    erreur: montrerErreur,
    ouverte: function () { fermerPanneau(); },
    discussions: function (r) {
      discussions = (r && Array.isArray(r.liste) ? r.liste : []).filter(function (d) { return d && typeof d.id === 'string'; })
        .map(function (d) { return { id: d.id, titre: String(d.titre || 'Discussion'), titreAuto: !!d.titreAuto, premier: String(d.premier || ''),
                                     texte: String(d.texte || ''), maj: Number(d.maj) || 0, messages: Number(d.messages) || 0, ouverte: !!d.ouverte }; });
      if (!pDisc.hidden) rendreDiscussions();
    },
    config: function (c) {
      c = c || {};
      if (typeof c.app === 'string') conf.app = c.app;
      if (typeof c.machine === 'string') conf.machine = c.machine;
      if (typeof c.choixMachine === 'boolean') conf.choixMachine = c.choixMachine;
      var ultron = conf.app === 'ultron-terminal';
      document.documentElement.classList.toggle('app-ultron', ultron);
      document.querySelector('.tete-titre').textContent = ultron ? 'Ultron Terminal' : 'Sessions';
      document.title = ultron ? 'Ultron Terminal' : 'Sessions';
      var n = document.getElementById('nouvelle');
      n.title = surVictus() ? 'Nouvelle session sur le Victus (Ctrl+N)' : 'Nouvelle session (⌘N)';
      rendre();
    }
  };

  // les durées « il y a » se rafraîchissent sans tout redessiner
  setInterval(function () {
    document.querySelectorAll('.temps').forEach(function (t) { t.textContent = temps(Number(t.dataset.maj)); });
  }, 30000);
  // chronomètre des fermetures en cours
  setInterval(function () {
    document.querySelectorAll('.temps[data-debut]').forEach(function (t) { t.textContent = duree(Number(t.dataset.debut)); });
  }, 1000);

  document.getElementById('nouvelle').addEventListener('click', nouvelle);
  /* ---------- Discussions passées (17/11/2026) ---------- */

  var pDisc = document.getElementById('panneau-discussions');
  var rechDisc = document.getElementById('discussions-recherche');
  var listeDisc = document.getElementById('discussions-liste');
  var msgDisc = document.getElementById('discussions-message');
  var boutonDisc = document.getElementById('discussion');
  var discussions = null;      // dernière liste reçue (gardée entre deux ouvertures)
  var choixDisc = -1;

  function sansAccents(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }

  function messageDisc(t) { msgDisc.hidden = !t; msgDisc.textContent = t || ''; }

  function groupeDe(ms) {
    var d = new Date(ms), h = new Date(); h.setHours(0, 0, 0, 0);
    var j = (h - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
    if (j <= 0) return 'Aujourd’hui';
    if (j === 1) return 'Hier';
    if (j < 7) return 'Cette semaine';
    if (j < 31) return 'Ce mois-ci';
    return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  }

  // extrait du texte autour du premier mot cherché, mot surligné
  function extraitTrouve(texte, mots) {
    var brut = String(texte || '').replace(/ ¶ /g, ' · ');
    var plat = sansAccents(brut);
    var i = -1, mot = '';
    for (var k = 0; k < mots.length && i < 0; k++) { i = plat.indexOf(mots[k]); mot = mots[k]; }
    if (i < 0) return null;
    var debut = Math.max(0, i - 40);
    var f = document.createDocumentFragment();
    f.appendChild(document.createTextNode((debut > 0 ? '…' : '') + brut.slice(debut, i)));
    f.appendChild(el('mark', null, brut.slice(i, i + mot.length)));
    f.appendChild(document.createTextNode(brut.slice(i + mot.length, i + mot.length + 120)));
    return f;
  }

  function rendreDiscussions() {
    listeDisc.textContent = '';
    choixDisc = -1;
    if (!discussions) { messageDisc('Chargement…'); return; }
    var q = sansAccents(rechDisc.value).trim();
    var mots = q ? q.split(/\s+/) : [];
    var l = discussions.filter(function (d) {
      if (!mots.length) return true;
      var h = d._h || (d._h = sansAccents(d.titre + ' ' + d.texte));
      return mots.every(function (m) { return h.indexOf(m) >= 0; });
    }).slice(0, 150);
    messageDisc(!discussions.length ? 'Aucune discussion pour l’instant.' : !l.length ? 'Aucune discussion ne contient « ' + rechDisc.value.trim() + ' ».' : '');
    var groupe = '';
    l.forEach(function (d) {
      var g = groupeDe(d.maj);
      if (g !== groupe) { groupe = g; listeDisc.appendChild(el('div', 'groupe-date', g)); }
      var b = el('button', 'discussion-passee' + (d.titreAuto ? '' : ' sans-titre'));
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.dataset.id = d.id;
      b.title = d.premier || d.titre;
      b.appendChild(el('span', 'discussion-titre', d.titre));
      var inf = el('span', 'discussion-infos');
      inf.appendChild(el('span', null, temps(d.maj)));
      inf.appendChild(el('span', null, '· ' + d.messages + ' message' + (d.messages > 1 ? 's' : '')));
      if (d.ouverte) inf.appendChild(el('span', 'ouverte', '· ouverte'));
      b.appendChild(inf);
      if (mots.length && sansAccents(d.titre).indexOf(mots[0]) < 0) {
        var x = extraitTrouve(d.texte, mots);
        if (x) { var e = el('span', 'discussion-extrait'); e.appendChild(x); b.appendChild(e); }
      }
      b.addEventListener('click', function () { reprendre(d.id); });
      listeDisc.appendChild(b);
    });
  }

  function reprendre(id) { fermerDiscussions(); envoyer({ type: 'reprendreDiscussion', id: id }); }

  function ouvrirDiscussions() {
    fermerMenu(); fermerPanneau();
    pDisc.hidden = false;
    boutonDisc.setAttribute('aria-expanded', 'true');
    rechDisc.value = '';
    rendreDiscussions();
    envoyer({ type: 'discussions' });
    rechDisc.focus();
  }

  function fermerDiscussions() { pDisc.hidden = true; boutonDisc.setAttribute('aria-expanded', 'false'); }

  function choisirDisc(pas) {
    var b = listeDisc.querySelectorAll('.discussion-passee');
    if (!b.length) return;
    if (choixDisc >= 0 && b[choixDisc]) b[choixDisc].classList.remove('choisie');
    choixDisc = Math.max(0, Math.min(b.length - 1, choixDisc + pas));
    b[choixDisc].classList.add('choisie');
    b[choixDisc].scrollIntoView({ block: 'nearest' });
  }

  boutonDisc.addEventListener('click', function () { if (pDisc.hidden) ouvrirDiscussions(); else fermerDiscussions(); });
  // Double clic sur l'icône : nouvelle discussion directement (Eliot, 18/11/2026).
  boutonDisc.addEventListener('dblclick', function (e) { e.preventDefault(); fermerDiscussions(); envoyer({ type: 'discussion' }); });
  document.getElementById('discussions-fermer').addEventListener('click', fermerDiscussions);
  document.getElementById('discussion-neuve').addEventListener('click', function () { fermerDiscussions(); envoyer({ type: 'discussion' }); });
  rechDisc.addEventListener('input', rendreDiscussions);
  rechDisc.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); choisirDisc(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); choisirDisc(-1); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      var b = listeDisc.querySelectorAll('.discussion-passee');
      var c = b[choixDisc >= 0 ? choixDisc : 0];
      if (c && (choixDisc >= 0 || rechDisc.value.trim())) reprendre(c.dataset.id);
      else if (!rechDisc.value.trim()) { fermerDiscussions(); envoyer({ type: 'discussion' }); }
    } else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); fermerDiscussions(); }
  });
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
      { id: 'v1', numero: 6, emoji: '🧪', projet: 'Labo Victus', machine: 'victus', ouverte: true, etat: 'travaille', resume: 'Compile le module de rendu sur le GPU du Victus.', maj: m - 40000 },
      { id: 'v2', numero: 7, emoji: '📦', projet: 'Scraper', machine: 'victus', ouverte: false, etat: 'pret', nonLu: true, resume: 'Les 3 200 pages sont récupérées, export CSV prêt.', maj: m - 900000 },
      { id: 'f', numero: 99, emoji: '🏢', projet: 'QG', fermeture: true, maj: m - 14000 }
    ], { apercu: 'La session QG est reprise dans Jarvis Terminal, avec sa conversation d’avant.', maj: m - 300000, nonLu: true, occupe: false },
    { victus: { configure: true, etat: 'connecte' } });
    // aperçu : le panneau du Victus reçoit de faux dossiers
    var envoyerVrai = envoyer;
    envoyer = function (o) {
      envoyerVrai(o);
      if (o.type === 'discussions') setTimeout(function () {
        window.barreSessions.discussions({ liste: [
          { id: 'x1', titre: 'Baisse de qualité d’Opus', titreAuto: true, premier: 'va souder internet avec 20 agents', texte: 'va souder internet avec 20 agents pour voir pourquoi opus parait moins bon', maj: m - 600000, messages: 14, ouverte: true },
          { id: 'x2', titre: 'Épisodes fillers de Black Clover', titreAuto: true, premier: 'dans black clover apres lepisode 100', texte: 'dans black clover apres lepisode 100 lesquels sont des fillers ¶ pourtant 123 a 125 c’est la fin du proces', maj: m - 86400000 * 2, messages: 22 },
          { id: 'x3', titre: 'salut bro, tu peux anlayser une conv revolut', titreAuto: false, premier: 'salut bro, tu peux anlayser une conv revolut', texte: 'salut bro, tu peux anlayser une conv revolut', maj: m - 86400000 * 9, messages: 6 }
        ] });
      }, 50);
      if (o.type === 'dossiers') setTimeout(function () {
        rendreDossiers({ home: '/home/eliotgrx', liste: [
          { cwd: '/home/eliotgrx/projets/labo-victus', nom: 'labo-victus', maj: m - 40000 },
          { cwd: '/home/eliotgrx/projets/scraper', nom: 'scraper', maj: m - 900000 },
          { cwd: '/home/eliotgrx/Documents/notes', nom: 'notes', maj: m - 86400000 * 3 }
        ] });
      }, 50);
    };
  } else {
    envoyer({ type: 'pret' });
  }
})();
