/* Better Terminal For Claude — panneau « To-do » à droite (demande d'Eliot, 08/11/2026).
 *
 * Deux sections :
 *   - « Plan de Claude » : la dernière liste de tâches de Claude dans la session (TodoWrite, ou
 *     TaskCreate / TaskUpdate), reconstruite à partir des éléments de la Session (lecture seule) ;
 *   - « To-do du projet » : les tâches Apple Rappels du projet de la session, via la coque
 *     (app/Sources/Todo.swift, CLI ~/.claude/bin/todo). Le projet vient du cwd, côté Swift.
 *
 * Page → Swift : BT.pont.envoyer('todo', { action: 'lister' | 'cocher' | 'ajouter', titre?, demande })
 * Swift → page : window.bt.todo(objet) → BT.todo.recevoir(objet)
 * Ouverture : bouton « To-do » de la barre, ou ⌘T. État mémorisé (localStorage).
 *
 * Liste fixe au-dessus de la saisie (demande d'Eliot, 09/11/2026), toujours visible, façon checklist de Claude Code :
 *   - « Plan de Claude » : ses étapes, cochées en direct ; repliable, disparaît une fois tout fait et le tour fini ;
 *   - « À toi » : les tâches du projet, cochables d'un clic. Elle se replie sur une ligne mais ne se ferme jamais,
 *     et se rouvre à chaque fin de tour de Claude et à chaque nouvelle tâche : elle doit déranger.
 * Hors de l'app (navigateur), une liste factice remplace Rappels.
 */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  var CLE = 'bt.todo.ouvert';
  var PERIODE = 60000;
  var TITRE_MAX = 300;

  // « À toi » plié ou déplié : choix d'Eliot, gardé d'une session et d'un lancement à l'autre.
  function lireReplie() { try { return localStorage.getItem('bt.todo.toiReplie') === '1'; } catch (_) { return false; } }
  function ecrireReplie(v) { try { localStorage.setItem('bt.todo.toiReplie', v ? '1' : '0'); } catch (_) {} }

  var etat = {
    pret: false, ouvert: false,
    projet: undefined,          // undefined : pas encore lu ; null : aucun projet ; { id, nom, emoji }
    taches: [], erreur: '', erreurAction: '', charge: false,
    seq: 0, listeEnCours: 0, listeDepuis: 0, derniereLecture: 0, minuteur: null,
    attente: Object.create(null),     // demande -> { action, titre }
    enCochage: Object.create(null),   // titre -> true
    enSuppression: Object.create(null),   // titre -> { id, minuterie, envoye }
    deplies: Object.create(null),     // titre -> notes dépliées
    plan: null,                       // { taches: [{ texte, statut }] }
    planReplie: false, planSignature: '',
    toiReplie: lireReplie(), toiCompteVu: 0,
    travaille: false
  };
  var n = {};   // nœuds du DOM

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, texte) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texte != null) e.textContent = texte;
    return e;
  }
  function natif() { return !!(BT.pont && BT.pont.natif); }
  function lireMemoire() { try { return localStorage.getItem(CLE) === '1'; } catch (e) { return false; } }
  function ecrireMemoire(v) { try { localStorage.setItem(CLE, v ? '1' : '0'); } catch (e) { /* stockage indisponible */ } }

  /* ================= Échanges avec la coque ================= */

  function demander(action, titre, id) {
    var d = ++etat.seq;
    etat.attente[d] = { action: action, titre: titre || '' };
    var msg = { action: action, demande: d };
    if (titre != null) msg.titre = titre;
    if (id) msg.id = id;
    if (natif()) BT.pont.envoyer('todo', msg);
    else setTimeout(function () { simuler(msg); }, action === 'lister' ? 120 : 250);
    return d;
  }

  /* Une lecture à la fois ; `forcer` en relance une (la réponse de l'ancienne sera ignorée). */
  function lister(forcer) {
    if (etat.listeEnCours && !forcer && Date.now() - etat.listeDepuis < 90000) return;
    etat.listeDepuis = Date.now();
    etat.listeEnCours = demander('lister');
    if (!etat.charge) rendreProjet();
  }

  function recevoir(r) {
    if (!r || typeof r !== 'object') return;
    var a = r.demande != null ? etat.attente[r.demande] : null;
    if (r.demande != null) delete etat.attente[r.demande];
    var action = r.action || (a && a.action);

    if (action === 'lister') {
      if (r.demande != null && r.demande !== etat.listeEnCours) return;   // réponse périmée
      etat.listeEnCours = 0;
      etat.derniereLecture = Date.now();
      etat.charge = true;
      etat.projet = r.projet || null;
      etat.erreur = r.erreur || '';
      if (!r.erreur || (r.taches && r.taches.length)) etat.taches = Array.isArray(r.taches) ? r.taches : [];
      rendreProjet();
      return;
    }

    var titre = r.titre != null ? r.titre : (a && a.titre) || '';
    if (action === 'cocher') {
      if (r.ok) {
        etat.taches = etat.taches.filter(function (t) { return t.titre !== titre; });
        delete etat.enCochage[titre];
        delete etat.deplies[titre];
        etat.erreurAction = '';
      } else {
        delete etat.enCochage[titre];
        etat.erreurAction = r.erreur || 'Impossible de cocher la tâche.';
      }
      rendreProjet();
      lister(true);
      return;
    }
    if (action === 'supprimer') {
      delete etat.enSuppression[titre];
      if (r.ok) etat.taches = etat.taches.filter(function (t) { return t.titre !== titre; });
      etat.erreurAction = r.ok ? '' : (r.erreur || 'Impossible de supprimer la tâche.');
      rendreProjet();
      lister(true);
      return;
    }
    if (action === 'ajouter') {
      if (!etat.pret) return;
      n.champ.disabled = false;
      if (r.ok) {
        if (n.champ.value.trim() === titre) n.champ.value = '';
        etat.erreurAction = '';
      } else {
        etat.erreurAction = r.erreur || 'Impossible d’ajouter la tâche.';
      }
      rendreProjet();
      lister(true);
      if (etat.ouvert) n.champ.focus({ preventScroll: true });
      return;
    }
    if (r.erreur) { etat.erreur = r.erreur; rendreProjet(); }
  }

  /* Hors de l'app : une liste factice, modifiée en mémoire. */
  var factices = [
    { titre: 'Relire le panneau To-do', notes: 'Liste factice : hors de l’app, Rappels n’est pas lu.', echeance: null, priorite: 'haute' },
    { titre: 'Vérifier le raccourci ⌘T', notes: '', echeance: '2026-11-10', priorite: null },
    { titre: 'Tester une tâche avec des notes longues', notes: 'Ces notes sont longues exprès, pour voir comment le panneau les coupe au bout de deux lignes, puis les montre en entier quand on clique sur la tâche.', echeance: null, priorite: null }
  ];
  function simuler(m) {
    var r = { action: m.action, demande: m.demande };
    if (m.action === 'lister') {
      r.projet = { id: 'demo', nom: 'Projet de démonstration', emoji: '🧪' };
      r.taches = factices.slice();
    } else if (m.action === 'cocher') {
      var avant = factices.length;
      factices = factices.filter(function (t) { return t.titre !== m.titre; });
      r.titre = m.titre; r.ok = factices.length < avant;
      if (!r.ok) r.erreur = 'Aucune tâche ouverte ne correspond à « ' + m.titre + ' ».';
    } else if (m.action === 'supprimer') {
      factices = factices.filter(function (t) { return t.titre !== m.titre; });
      r.titre = m.titre; r.ok = true;
    } else if (m.action === 'ajouter') {
      r.titre = m.titre;
      r.ok = !factices.some(function (t) { return t.titre.toLowerCase() === m.titre.toLowerCase(); });
      if (r.ok) factices.push({ titre: m.titre, notes: '', echeance: null, priorite: null });
      else r.erreur = 'Doublon : « ' + m.titre + ' » est déjà ouverte.';
    }
    recevoir(r);
  }

  /* ================= Ouverture et fermeture ================= */

  function ouvrir(v, focus) {
    v = !!v;
    if (!etat.pret || v === etat.ouvert) { if (v && focus) n.champ.focus({ preventScroll: true }); return; }
    etat.ouvert = v;
    ecrireMemoire(v);
    n.panneau.hidden = !v;
    document.body.classList.toggle('todo-ouvert', v);
    n.bouton.classList.toggle('actif', v);
    n.bouton.setAttribute('aria-pressed', v ? 'true' : 'false');
    if (v) {
      lister();
      if (focus) n.champ.focus({ preventScroll: true });
    } else if (n.panneau.contains(document.activeElement)) {
      var ta = $('saisie-texte');
      if (ta && !ta.disabled) ta.focus({ preventScroll: true });
    }
  }
  function basculer() { ouvrir(!etat.ouvert); }

  /* ================= Rendu : to-do du projet ================= */

  var MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  function texteEcheance(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    var auj = new Date(); auj.setHours(0, 0, 0, 0);
    var jours = Math.round((d - auj) / 86400000);
    var t = jours === 0 ? 'aujourd’hui' : jours === 1 ? 'demain' : jours === -1 ? 'hier'
      : (+m[3]) + ' ' + MOIS[+m[2] - 1] + (d.getFullYear() !== auj.getFullYear() ? ' ' + m[1] : '');
    return { texte: 'pour ' + t, retard: jours < 0, proche: jours >= 0 && jours <= 1 };
  }

  function ligneTache(t, i) {
    var titre = t.titre || '';
    if (etat.enSuppression[titre]) return ligneSupprimee(t, i, 'tp-tache');
    var enCours = !!etat.enCochage[titre];
    var li = el('li', 'tp-tache' + (enCours ? ' en-cours' : ''));
    var c = el('button', 'tp-case');
    c.type = 'button';
    c.disabled = enCours;
    c.title = 'Cocher : c’est fait';
    c.setAttribute('aria-label', 'Cocher « ' + titre + ' »');
    c.addEventListener('click', function () { cocher(titre); });
    li.appendChild(numero(i));
    li.appendChild(c);

    var corps = el('div', 'tp-corps-tache');
    corps.appendChild(el('div', 'tp-titre-tache', titre));
    var meta = [];
    if (t.priorite === 'haute') meta.push(['tp-prio', 'priorité haute']);
    var ech = texteEcheance(t.echeance);
    if (ech) meta.push(['tp-echeance' + (ech.retard ? ' retard' : ech.proche ? ' proche' : ''), ech.texte]);
    if (meta.length) {
      var m = el('div', 'tp-meta');
      meta.forEach(function (x) { m.appendChild(el('span', x[0], x[1])); });
      corps.appendChild(m);
    }
    if (t.notes) {
      var notes = el('div', 'tp-notes' + (etat.deplies[titre] ? ' deplie' : ''), t.notes);
      corps.appendChild(notes);
      corps.classList.add('a-notes');
      corps.title = etat.deplies[titre] ? '' : 'Clique pour lire les notes en entier';
      corps.addEventListener('click', function () {
        if (window.getSelection && String(window.getSelection())) return;   // sélection de texte : on ne replie pas
        etat.deplies[titre] = !etat.deplies[titre];
        notes.classList.toggle('deplie', !!etat.deplies[titre]);
        corps.title = etat.deplies[titre] ? '' : 'Clique pour lire les notes en entier';
      });
    }
    li.appendChild(corps);
    if (!enCours) li.appendChild(boutonSuppr(t));
    return li;
  }

  function rendreProjet() {
    if (!etat.pret) return;
    var p = etat.projet;
    n.nomProjet.textContent = p ? ((p.emoji ? p.emoji + ' ' : '') + (p.nom || p.id)) : '';
    n.nomProjet.hidden = !p;
    n.ajout.hidden = p === null;
    n.liste.textContent = '';
    n.message.className = 'tp-message';
    n.message.hidden = true;

    var erreur = etat.erreurAction || etat.erreur;
    if (erreur) {
      n.erreur.textContent = erreur;
      n.erreur.hidden = false;
    } else {
      n.erreur.hidden = true;
    }

    if (!etat.charge) {
      n.message.textContent = 'Lecture de la to-do…';
      n.message.hidden = false;
    } else if (p === null) {
      var info = BT.app && BT.app.session && BT.app.session.etatInfo ? BT.app.session.etatInfo() : {};
      n.message.textContent = 'Ce dossier n’est rattaché à aucun projet du registre : pas de to-do à afficher.';
      if (info.cwd) n.message.appendChild(el('span', 'tp-chemin', info.cwd));
      n.message.hidden = false;
    } else if (!etat.taches.length && !etat.erreur) {
      n.message.textContent = 'Aucune tâche ouverte.';
      n.message.hidden = false;
    } else {
      etat.taches.forEach(function (t, i) { n.liste.appendChild(ligneTache(t, i)); });
    }
    n.compte.textContent = String(etat.taches.length);
    n.compte.hidden = !etat.charge || !p || !etat.taches.length;
    rendreToi();
  }

  function cocher(titre) {
    if (!titre || etat.enCochage[titre]) return;
    etat.enCochage[titre] = true;
    etat.erreurAction = '';
    rendreProjet();
    demander('cocher', titre);
  }

  /* Supprimer (09/11/2026) : la tâche disparaît tout de suite, « Annuler » pendant 5 s, puis suppression
   * définitive dans Rappels (`todo suppr`, par id). Une tâche supprimée ne compte pas comme faite. */
  var DELAI_ANNULER = 5000;
  function supprimer(t) {
    var titre = t.titre || '';
    if (!titre || etat.enSuppression[titre] || etat.enCochage[titre]) return;
    var x = etat.enSuppression[titre] = { id: t.id || '', envoye: false };
    x.minuterie = setTimeout(function () { x.envoye = true; demander('supprimer', titre, x.id); rendreProjet(); }, DELAI_ANNULER);
    etat.erreurAction = '';
    rendreProjet();
  }
  function annulerSuppression(titre) {
    var x = etat.enSuppression[titre];
    if (!x || x.envoye) return;
    clearTimeout(x.minuterie);
    delete etat.enSuppression[titre];
    rendreProjet();
  }
  function boutonSuppr(t) {
    var b = el('button', 'td-suppr');
    b.type = 'button';
    b.title = 'Supprimer la tâche (sans la compter comme faite)';
    b.setAttribute('aria-label', 'Supprimer « ' + (t.titre || '') + ' »');
    b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
    b.addEventListener('click', function (e) { e.stopPropagation(); supprimer(t); });
    return b;
  }
  /* Ligne « supprimée · Annuler » à la place de la tâche. */
  function ligneSupprimee(t, i, classe) {
    var titre = t.titre || '';
    var x = etat.enSuppression[titre];
    var li = el('li', classe + ' supprimee');
    li.appendChild(numero(i));
    li.appendChild(el('span', 'td-suppr-texte', x.envoye ? 'Suppression…' : 'Supprimée : ' + titre));
    if (!x.envoye) {
      var a = el('button', 'td-annuler', 'Annuler');
      a.type = 'button';
      a.addEventListener('click', function (e) { e.stopPropagation(); annulerSuppression(titre); });
      li.appendChild(a);
    }
    return li;
  }

  function ajouter() {
    var t = n.champ.value.replace(/\s+/g, ' ').trim();
    if (!t || n.champ.disabled) return;
    if (t.length > TITRE_MAX) { etat.erreurAction = 'Titre trop long (' + TITRE_MAX + ' caractères au plus).'; rendreProjet(); return; }
    if (/^--/.test(t)) { etat.erreurAction = 'Le titre ne peut pas commencer par « -- ».'; rendreProjet(); return; }
    n.champ.value = t;
    n.champ.disabled = true;
    etat.erreurAction = '';
    rendreProjet();
    demander('ajouter', t);
  }

  /* ================= Plan de Claude (TodoWrite, TaskCreate / TaskUpdate) ================= */

  var OUTILS_PLAN = { TodoWrite: 1, TaskCreate: 1, TaskUpdate: 1 };
  var planPrevu = null;

  function idTache(o) {
    var s = o.resultat && o.resultat.structure;
    if (s && typeof s === 'object') {
      var t = s.task || s;
      if (t && t.id != null && (typeof t.id === 'string' || typeof t.id === 'number')) return String(t.id);
    }
    var m = /#\s*([\w-]+)/.exec((o.resultat && o.resultat.texte) || '');
    return m ? m[1] : null;
  }

  function calculerPlan(items) {
    var todo = null, iTodo = -1, taches = [], parId = Object.create(null), iTask = -1;
    for (var i = 0; i < items.length; i++) {
      var o = items[i];
      if (!o || o.genre !== 'outil' || o.parent || !OUTILS_PLAN[o.nom] || o.statut === 'erreur') continue;
      var e = o.entree;
      if (!e || typeof e !== 'object') continue;
      if (o.nom === 'TodoWrite') {
        if (!Array.isArray(e.todos)) continue;
        todo = e.todos.map(function (t) {
          t = t || {};
          var st = t.status || 'pending';
          return { texte: st === 'in_progress' && t.activeForm ? t.activeForm : (t.content || t.activeForm || ''), statut: st };
        });
        iTodo = i;
      } else if (o.nom === 'TaskCreate') {
        var x = { id: idTache(o), sujet: e.subject || e.title || '', actif: e.activeForm || '', statut: 'pending' };
        if (!x.sujet) continue;
        taches.push(x);
        if (x.id) parId[x.id] = x;
        iTask = i;
      } else if (o.nom === 'TaskUpdate') {
        var id = e.taskId != null ? String(e.taskId) : (e.id != null ? String(e.id) : '');
        var t = parId[id];
        if (!t) continue;
        if (e.status === 'deleted') { taches.splice(taches.indexOf(t), 1); delete parId[id]; }
        else {
          if (e.status) t.statut = e.status;
          if (e.subject) t.sujet = e.subject;
          if (e.activeForm) t.actif = e.activeForm;
        }
        iTask = i;
      }
    }
    if (iTodo < 0 && iTask < 0) return null;
    if (iTodo > iTask) return todo.length ? { taches: todo } : null;
    if (!taches.length) return null;
    return { taches: taches.map(function (t) {
      return { texte: t.statut === 'in_progress' && t.actif ? t.actif : t.sujet, statut: t.statut };
    }) };
  }

  function planifierPlan() {
    if (planPrevu) return;
    planPrevu = setTimeout(function () {
      planPrevu = null;
      var s = BT.app && BT.app.session;
      if (!s) return;
      etat.plan = calculerPlan(s.items || []);
      rendrePlan();
      rendreDockPlan();
    }, 60);
  }

  function rendrePlan() {
    if (!etat.pret) return;
    var p = etat.plan;
    n.plan.hidden = !p;
    if (!p) return;
    var faites = p.taches.filter(function (t) { return t.statut === 'completed'; }).length;
    n.planCompte.textContent = faites + ' sur ' + p.taches.length;
    n.planListe.textContent = '';
    p.taches.forEach(function (t, i) {
      var st = t.statut === 'completed' ? 'fait' : t.statut === 'in_progress' ? 'en-cours' : 'a-faire';
      var li = el('li', 'tp-etape ' + st);
      li.appendChild(numero(i));
      li.appendChild(el('span', 'tp-marque'));
      li.appendChild(el('span', 'tp-etape-texte', t.texte));
      li.title = st === 'fait' ? 'Fait' : st === 'en-cours' ? 'En cours' : 'À faire';
      n.planListe.appendChild(li);
    });
  }

  /* ================= Liste fixe au-dessus de la saisie ================= */

  // Numéro de ligne : même ordre que `todo list`, pour pouvoir dire « la 3 » à Claude.
  function numero(i) {
    var s = el('span', 'td-num', (i + 1) + '.');
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  function marque(st) {
    var m = el('span', 'td-case');
    m.setAttribute('aria-hidden', 'true');
    return m;
  }

  function teteDock(bloc, titre, replier) {
    var t = el('button', 'td-tete');
    t.type = 'button';
    t.appendChild(el('span', 'td-chevron'));
    t.appendChild(el('span', 'td-titre', titre));
    var compte = el('span', 'td-compte');
    t.appendChild(compte);
    var resume = el('span', 'td-resume');
    t.appendChild(resume);
    t.addEventListener('click', replier);
    bloc.appendChild(t);
    return { tete: t, compte: compte, resume: resume };
  }

  function replie(bloc, tete, oui, quoi) {
    bloc.classList.toggle('replie', oui);
    tete.setAttribute('aria-expanded', oui ? 'false' : 'true');
    tete.title = oui ? 'Déplier ' + quoi : 'Replier ' + quoi;
  }

  function rendreDockPlan() {
    if (!etat.pret) return;
    var p = etat.plan, b = n.dPlan;
    var restantes = p ? p.taches.filter(function (t) { return t.statut !== 'completed'; }).length : 0;
    var visible = !!p && (restantes > 0 || etat.travaille);
    b.hidden = !visible;
    if (!visible) return;
    var sig = p.taches.map(function (t) { return t.texte; }).join('\n');
    if (sig !== etat.planSignature) { etat.planSignature = sig; etat.planReplie = false; }   // nouveau plan : déplié
    var faites = p.taches.length - restantes;
    n.dPlanTete.compte.textContent = faites + '/' + p.taches.length;
    var iCour = p.taches.findIndex(function (t) { return t.statut === 'in_progress'; });
    if (iCour < 0) iCour = p.taches.findIndex(function (t) { return t.statut !== 'completed'; });
    n.dPlanTete.resume.textContent = iCour >= 0 ? (iCour + 1) + '. ' + p.taches[iCour].texte : 'Tout est fait';
    replie(b, n.dPlanTete.tete, etat.planReplie, 'le plan');
    n.dPlanListe.textContent = '';
    p.taches.forEach(function (t, i) {
      var st = t.statut === 'completed' ? 'fait' : t.statut === 'in_progress' ? 'en-cours' : 'a-faire';
      var li = el('li', 'td-ligne ' + st);
      li.appendChild(numero(i));
      li.appendChild(marque(st));
      li.appendChild(el('span', 'td-texte', t.texte));
      n.dPlanListe.appendChild(li);
    });
  }

  function rendreToi() {
    if (!etat.pret) return;
    var b = n.dToi;
    var taches = etat.projet ? etat.taches : [];
    b.hidden = !etat.charge || !taches.length;
    if (b.hidden) { etat.toiCompteVu = taches.length; return; }
    // Plus de dépliage automatique (demande d'Eliot, 09/11/2026 : « relou ») : seul son clic plie ou déplie.
    etat.toiCompteVu = taches.length;
    var ouvertes = taches.filter(function (t) { return !etat.enCochage[t.titre] && !etat.enSuppression[t.titre]; });
    n.dToiTete.compte.textContent = String(ouvertes.length);
    var iPrem = taches.findIndex(function (t) { return !etat.enCochage[t.titre]; });
    n.dToiTete.resume.textContent = iPrem >= 0 ? (iPrem + 1) + '. ' + taches[iPrem].titre : '';
    replie(b, n.dToiTete.tete, etat.toiReplie, 'tes tâches');
    n.dToiListe.textContent = '';
    taches.forEach(function (t, i) {
      var titre = t.titre || '';
      if (etat.enSuppression[titre]) { n.dToiListe.appendChild(ligneSupprimee(t, i, 'td-ligne a-toi')); return; }
      var coche = !!etat.enCochage[titre];
      var li = el('li', 'td-ligne a-toi' + (coche ? ' fait' : ''));
      li.appendChild(numero(i));
      var c = el('button', 'td-case');
      c.type = 'button';
      c.disabled = coche;
      c.title = 'Cocher : c’est fait';
      c.setAttribute('aria-label', 'Cocher « ' + titre + ' »');
      c.addEventListener('click', function () { cocher(titre); });
      li.appendChild(c);
      var tx = el('span', 'td-texte', titre);
      if (t.notes) tx.title = t.notes;
      li.appendChild(tx);
      var ech = texteEcheance(t.echeance);
      if (ech) li.appendChild(el('span', 'td-echeance' + (ech.retard ? ' retard' : ech.proche ? ' proche' : ''), ech.texte));
      if (!coche) li.appendChild(boutonSuppr(t));
      n.dToiListe.appendChild(li);
    });
  }

  function construireDock() {
    var d = n.dock = el('div', 'td-dock');
    d.id = 'todo-dock';
    d.setAttribute('aria-label', 'Plan de Claude et tâches à faire');

    var bp = n.dPlan = el('section', 'td-bloc td-plan'); bp.hidden = true;
    n.dPlanTete = teteDock(bp, 'Plan de Claude', function () { etat.planReplie = !etat.planReplie; rendreDockPlan(); });
    n.dPlanListe = el('ol', 'td-liste');
    bp.appendChild(n.dPlanListe);

    var bt = n.dToi = el('section', 'td-bloc td-toi'); bt.hidden = true;
    n.dToiTete = teteDock(bt, 'À toi', function () { etat.toiReplie = !etat.toiReplie; ecrireReplie(etat.toiReplie); rendreToi(); });
    n.dToiListe = el('ul', 'td-liste');
    bt.appendChild(n.dToiListe);

    d.appendChild(bp);
    d.appendChild(bt);
    var saisie = document.querySelector('#pied > .saisie');
    if (saisie) saisie.parentNode.insertBefore(d, saisie);
    else document.body.appendChild(d);
  }

  /* ================= Construction ================= */

  function construire() {
    // Bouton dans la barre, juste avant « Mes messages ».
    var b = n.bouton = el('button', 'barre-bouton bouton-todo');
    b.type = 'button'; b.id = 'bt-todo';
    b.title = 'To-do du projet (⌘T)';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-controls', 'todo-panneau');
    b.appendChild(el('span', 'libelle', 'To-do'));
    b.insertAdjacentHTML('beforeend', '<svg class="icone-court" viewBox="0 0 16 16" aria-hidden="true">' +
      '<circle cx="4" cy="4.5" r="1.8"/><circle cx="4" cy="11.5" r="1.8"/><path d="M8 4.5h6M8 11.5h6"/></svg>');
    n.compte = el('span', 'compte'); n.compte.hidden = true;
    b.appendChild(n.compte);
    b.addEventListener('click', basculer);
    var avant = $('bt-mes-messages'), barre = $('barre');
    if (avant && avant.parentNode) avant.parentNode.insertBefore(b, avant);
    else if (barre) barre.insertBefore(b, document.querySelector('.barre-session'));

    // Panneau
    var pa = n.panneau = el('aside', 'todo-panneau');
    pa.id = 'todo-panneau'; pa.hidden = true;
    pa.setAttribute('aria-label', 'To-do');

    var tete = el('div', 'tp-tete');
    tete.appendChild(el('span', 'tp-titre', 'To-do'));
    n.nomProjet = el('span', 'tp-projet'); n.nomProjet.hidden = true;
    tete.appendChild(n.nomProjet);
    tete.appendChild(el('span', 'tp-espace'));
    var maj = el('button', 'tp-icone'); maj.type = 'button';
    maj.title = 'Rafraîchir'; maj.setAttribute('aria-label', 'Rafraîchir');
    maj.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/></svg>';
    maj.addEventListener('click', function () { lister(true); });
    tete.appendChild(maj);
    var fermer = el('button', 'tp-icone'); fermer.type = 'button';
    fermer.title = 'Fermer (⌘T)'; fermer.setAttribute('aria-label', 'Fermer');
    fermer.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    fermer.addEventListener('click', function () { ouvrir(false); });
    tete.appendChild(fermer);
    pa.appendChild(tete);

    var ajout = n.ajout = el('div', 'tp-ajout');
    var champ = n.champ = el('input', 'tp-champ');
    champ.type = 'text';
    champ.placeholder = 'Ajouter une tâche…';
    champ.maxLength = TITRE_MAX;
    champ.spellcheck = true;
    champ.autocomplete = 'off';
    champ.setAttribute('aria-label', 'Ajouter une tâche à la to-do du projet');
    champ.addEventListener('input', function () {
      if (etat.erreurAction) { etat.erreurAction = ''; rendreProjet(); }
    });
    champ.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); ajouter(); }
    });
    ajout.appendChild(champ);
    pa.appendChild(ajout);

    var corps = el('div', 'tp-corps');
    var plan = n.plan = el('section', 'tp-section tp-plan'); plan.hidden = true;
    var tp = el('div', 'tp-section-tete');
    tp.appendChild(el('span', 'tp-section-titre', 'Plan de Claude'));
    n.planCompte = el('span', 'tp-section-compte');
    tp.appendChild(n.planCompte);
    plan.appendChild(tp);
    n.planListe = el('ol', 'tp-etapes');
    plan.appendChild(n.planListe);
    corps.appendChild(plan);

    var projet = el('section', 'tp-section');
    var tpj = el('div', 'tp-section-tete');
    tpj.appendChild(el('span', 'tp-section-titre', 'To-do du projet'));
    projet.appendChild(tpj);
    n.erreur = el('div', 'tp-erreur'); n.erreur.hidden = true; n.erreur.setAttribute('role', 'alert');
    projet.appendChild(n.erreur);
    n.message = el('div', 'tp-message'); n.message.hidden = true;
    projet.appendChild(n.message);
    n.liste = el('ul', 'tp-liste');
    projet.appendChild(n.liste);
    corps.appendChild(projet);
    pa.appendChild(corps);

    // Échap dans le panneau : le ferme, sans interrompre Claude (gestionnaire global d'interface.js).
    pa.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ouvrir(false); }
    });

    var pied = $('pied');
    if (pied && pied.parentNode) pied.parentNode.insertBefore(pa, pied.nextSibling);
    else document.body.appendChild(pa);
  }

  function init() {
    if (etat.pret) return;
    construire();
    construireDock();
    etat.pret = true;

    // ⌘T : ouvrir / fermer (⌘J est pris par le panneau Jarvis du menu Vocal).
    document.addEventListener('keydown', function (e) {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
      var k = (e.key || '').toLowerCase();
      if (k === 't') { e.preventDefault(); basculer(); }
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - etat.derniereLecture > PERIODE) lister();
    });

    var s = BT.app && BT.app.session;
    if (s && s.on) {
      s.on('ajout', function (it) { if (it && it.genre === 'outil' && OUTILS_PLAN[it.nom]) planifierPlan(); });
      s.on('maj', function (it) { if (it && it.genre === 'outil' && OUTILS_PLAN[it.nom]) planifierPlan(); });
      s.on('historique', planifierPlan);
      // Fin de tour : Claude a pu cocher ou ajouter une tâche avec `todo`, et la liste « À toi » se rouvre (elle doit déranger).
      var avant = s.etat;
      etat.travaille = avant === 'travaille';
      s.on('etat', function (e) {
        etat.travaille = e === 'travaille';
        if (avant === 'travaille' && e !== 'travaille') lister(true);
        avant = e;
        rendreDockPlan();
      });
      planifierPlan();
    }

    rendreProjet();
    if (lireMemoire()) ouvrir(true);
    else lister();
    // La liste « À toi » est toujours affichée : relecture régulière, panneau ouvert ou non.
    etat.minuteur = setInterval(function () { if (!document.hidden) lister(); }, PERIODE);
  }

  BT.todo = {
    recevoir: function (d) { try { recevoir(d); } catch (e) { console.error('[BT] todo', e); } },
    ouvrir: function (focus) { ouvrir(true, focus); },
    fermer: function () { ouvrir(false); },
    basculer: basculer,
    _calculerPlan: calculerPlan   // tests
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
})();
