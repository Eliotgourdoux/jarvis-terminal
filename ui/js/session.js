/* Better Terminal For Claude — logique de session.
 *
 * AUCUN accès au DOM dans ce fichier. La Session lit le protocole stream-json de
 * Claude Code (voir moteur/PROTOCOLE.md), tient la liste des éléments de la
 * conversation, l'état (travaille / attend / prêt / terminé) et les questions en
 * attente, et construit les lignes à écrire sur le stdin de claude.
 * Toute vue (le fil de conversation, plus tard le mode vocal) s'abonne à ses
 * événements et appelle ses méthodes.
 *
 * Événements émis (session.on(nom, fn)) :
 *   'ajout'      (item)            nouvel élément
 *   'maj'        (item, quoi)      élément modifié ('texte', 'entree', 'resultat', 'statut', 'fin', ...)
 *   'etat'       (etat, resume)    changement d'état
 *   'activite'   (texte)           étape en cours (« Bash ls -la »…)
 *   'info'       (info)            projet, modèle, effort, sessionId…
 *   'modeles'    (liste)           liste des modèles reçue par initialize
 *   'historique' (nombre)          historique chargé
 *   'vocal'      (etat)            mode vocal « Jarvis » : { actif, etat, enLigne, questionId, raccourci }
 *
 * Mode vocal (CONTRAT.md, « Mode vocal ») : la Session envoie au pont `vocal` (résumé de fin de tour,
 * question à lire), `vocalAnnule` et `modeVocal` ; elle reçoit `definirVocal` (bt.vocalEtat) et
 * `transcription` (bt.transcription). La traduction des phrases est dans vocal-reponses.js (BT.vocal).
 *
 * Genres d'éléments (item.genre) :
 *   eliot      { texte, enFile, commande }
 *   texte      { texte, enCours, final, erreur, interrompu }
 *   reflexion  { texte, jetons, enCours, debut, fin, masque }
 *   outil      { nom, toolUseId, entree, entreeJson, entreeApercu, statut, resultat, enfants, debut, fin, tache, questionId }
 *              statut : 'prepare' | 'encours' | 'ok' | 'erreur' | 'interrompu'
 *   question   { type: 'questions'|'permission'|'plan', requestId, toolUseId, outil, entree, questions, plan,
 *                suggestions, description, raison, statut: 'attente'|'repondue'|'annulee', reponseTexte, source }
 *   note       { niveau: 'info'|'avert'|'erreur', texte, detail }
 *   fin        { duree, erreur, interrompu }
 *   separateur { texte }
 * Tous : { id, date, parent (tool_use_id du sous-agent ou null), historique }
 */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  BT.EFFORTS = [
    { value: 'low', label: 'Faible' },
    { value: 'medium', label: 'Moyen' },
    { value: 'high', label: 'Élevé' },
    { value: 'xhigh', label: 'Très élevé' },
    { value: 'max', label: 'Maximum' }
  ];

  // Modes de permission acceptés par set_permission_mode en cours de session (vérifié, tous les sept).
  BT.PERMISSIONS = [
    { value: 'bypassPermissions', label: 'Bypass', detail: 'Claude fait tout sans rien demander.' },
    { value: 'auto', label: 'Auto', detail: 'Claude décide seul de ce qui mérite une confirmation.' },
    { value: 'acceptEdits', label: 'Modifs auto', detail: 'Les modifications de fichiers passent, le reste demande.' },
    { value: 'default', label: 'Demander', detail: 'Chaque action sensible te demande ton accord.' },
    { value: 'plan', label: 'Plan', detail: 'Claude lit et propose un plan, sans rien modifier.' },
    { value: 'dontAsk', label: 'Refus auto', detail: 'Ce qui demanderait ton accord est refusé sans question.' }
  ];

  var MODELES_DEFAUT = [
    { value: 'default', displayName: 'Par défaut' },
    { value: 'opus', displayName: 'Opus' },
    { value: 'fable', displayName: 'Fable' },
    { value: 'sonnet', displayName: 'Sonnet' },
    { value: 'haiku', displayName: 'Haiku' }
  ];

  var LIBELLES_PERMISSION = { autoriser: 'Autoriser', toujours: 'Toujours autoriser', refuser: 'Refuser' };
  var LIBELLES_PLAN = { autoriser: 'Approuver le plan', refuser: 'Continuer à planifier' };

  function Session(options) {
    BT.Emetteur.call(this);
    options = options || {};
    this._envoyer = options.envoyer || function () {};
    this.items = [];
    this._parId = Object.create(null);
    this._seq = 0;
    this.info = {};
    this.init = null;
    this.sessionId = null;
    this.modeles = MODELES_DEFAUT.slice();
    this.compte = null;
    this.modele = null;        // valeur choisie (alias ou nom complet)
    this.modeleResolu = null;  // nom complet réellement servi (init / message.model)
    this.effort = null;
    this.travaille = false;
    this.termine = false;
    this.debutTravail = null;
    this.activite = '';
    this.etat = null;
    this.resume = '';
    this._flux = Object.create(null);          // parent ('' = fil principal) -> { msgId, blocs: {index: item} }
    this._blocsParMsg = Object.create(null);   // message.id -> [items créés par le flux]
    this._histoParMsg = Object.create(null);   // message.id -> [textes et réflexions venus du transcript] (doublons après ⌘R)
    this._repriseTour = false;                 // ⌘R pendant un tour : claude travaille encore (info.direct)
    this._repriseEnAttente = null;             // ⌘R : can_use_tool encore en attente dans le processus (lignes brutes)
    this._outils = Object.create(null);        // tool_use_id -> item outil
    this._questions = Object.create(null);     // request_id -> item question
    this._pont = Object.create(null);          // id court -> { q, index, externe }
    this._requetes = Object.create(null);      // request_id -> rappel
    this._compteurReq = 0;
    this.jetons = { entree: 0, sortie: 0, cacheLu: 0, cacheEcrit: 0, cout: 0 };
    this._stderr = [];
    this._noteRetry = null;
    this._initialise = false;
    this.vocal = { actif: false, etat: 'inactif', enLigne: false, questionId: null, raccourci: '' };
    this._vocalAnnonces = Object.create(null); // id de pont -> annoncé à la coque (pas encore retiré)
    this._vocalEchecs = Object.create(null);   // id de pont -> réponses vocales incomprises d'affilée
  }
  Session.prototype = Object.create(BT.Emetteur.prototype);
  Session.prototype.constructor = Session;
  BT.Session = Session;

  /* ================= Éléments ================= */

  Session.prototype._ajouter = function (item) {
    item.id = item.id || ('i' + (++this._seq));
    if (!item.date) item.date = Date.now();
    if (item.parent === undefined) item.parent = null;
    this.items.push(item);
    this._parId[item.id] = item;
    if (item.parent) {
      var p = this._outils[item.parent];
      if (p) { p.enfants.push(item.id); this.emit('maj', p, 'enfants'); }
    }
    this.emit('ajout', item);
    return item;
  };

  Session.prototype._maj = function (item, quoi) { this.emit('maj', item, quoi || ''); };

  Session.prototype.item = function (id) { return this._parId[id] || null; };

  Session.prototype._note = function (niveau, texte, detail, histo) {
    return this._ajouter({ genre: 'note', niveau: niveau, texte: texte, detail: detail || '', historique: !!histo });
  };

  Session.prototype.messagesEliot = function () {
    return this.items.filter(function (i) { return i.genre === 'eliot'; });
  };

  Session.prototype.questionsEnAttente = function () {
    var l = [];
    for (var k in this._questions) if (this._questions[k].statut === 'attente') l.push(this._questions[k]);
    return l;
  };

  /* ================= Entrées venant de Swift ================= */

  /* bt.info : au lancement, puis de nouveau après une relance (nouveau processus) ou un ⌘R. */
  Session.prototype.definirInfo = function (info) {
    info = BT.etendre({}, info || {});
    // ⌘R : la coque dit où en est le processus, qui n'a rien vu du rechargement (tour, initialize, questions).
    var direct = info.direct && typeof info.direct === 'object' ? info.direct : null;
    delete info.direct;
    if (this._infoRecue && !info.dansTerminal) {
      // Nouveau processus : ce qui était en cours dans l'ancien ne finira jamais.
      this._fermerOuverts('interrompu');
      this.travaille = false;
      this.debutTravail = null;
      this._definirActivite('');
    }
    this._infoRecue = true;
    this.info = BT.etendre({}, this.info, info);
    if (info.sessionId) this.sessionId = info.sessionId;
    if (info.modele) this.modele = info.modele;
    if (info.effort) this.effort = info.effort;
    this.dansTerminal = !!info.dansTerminal;
    this.termine = this.dansTerminal;
    this.emit('info', this.etatInfo());
    // Liste des modèles (initialize) : demandée juste avant la première ligne écrite à ce
    // processus, car la coque refuse toute ligne tant que claude n'est pas lancé.
    this._initDemande = false;
    if (direct && !this.dansTerminal) this._reprendreProcessus(direct);
    this._calculerEtat();
  };

  /* ⌘R pendant que claude tourne : rien n'est écrit à claude. La réponse d'initialize gardée par la coque remplace
   * un nouvel initialize ; le tour en cours et les questions en attente sont repris tels quels. */
  Session.prototype._reprendreProcessus = function (direct) {
    if (direct.initialise && typeof direct.initialise === 'object') {
      this._appliquerInitialize(direct.initialise);
      this._initDemande = true;
    }
    this._repriseEnAttente = Array.isArray(direct.enAttente) && direct.enAttente.length ? direct.enAttente.slice() : null;
    this._repriseTour = !!direct.tourEnCours;
    if (this._repriseTour && !this.termine) {
      this.travaille = true;
      this.debutTravail = typeof direct.debutTour === 'number' ? direct.debutTour : Date.now();
    }
  };

  Session.prototype._appliquerInitialize = function (rep) {
    this._initialise = true;
    if (Array.isArray(rep.models) && rep.models.length) { this.modeles = rep.models; this.emit('modeles', this.modeles); }
    if (rep.account) this.compte = rep.account;
    if (rep.current_permission_mode) this.permission = rep.current_permission_mode;
    if (Array.isArray(rep.commands) && rep.commands.length) { this.commandes = rep.commands; this.emit('commandes', this.commandes); }
    this.emit('info', this.etatInfo());
  };

  Session.prototype._demanderInitialize = function () {
    var self = this;
    this.requete({ subtype: 'initialize', hooks: null }, function (ok, rep, err, brut) {
      // Questions et permissions encore en attente dans ce processus (page rechargée par ⌘R) :
      // claude les met à côté de `response`, pas dedans (vérifié, 2.1.319), y compris sur une erreur.
      var enAttente = (brut && brut.pending_permission_requests) || (rep && rep.pending_permission_requests) || [];
      if (ok && rep) self._appliquerInitialize(rep);
      enAttente.forEach(function (r) { self.recevoirLigne(r); });
      self.emit('info', self.etatInfo());
    });
  };

  Session.prototype.stderr = function (texte) {
    var l = String(texte == null ? '' : texte).split('\n');
    for (var i = 0; i < l.length; i++) if (l[i].trim()) this._stderr.push(BT.sansAnsi(l[i]));
    if (this._stderr.length > 80) this._stderr.splice(0, this._stderr.length - 80);
  };

  /* bt.fin({code, raison}) : raison « terminal » = la session continue dans Terminal.app. */
  Session.prototype.fin = function (d) {
    d = d || {};
    var code = d.code != null ? d.code : null;
    if (this.termine && this._finNotee) { this._calculerEtat(); return; }
    this.termine = true;
    this._finNotee = true;
    this.travaille = false;
    this._fermerOuverts('interrompu');
    if (d.raison === 'terminal') this.dansTerminal = true;
    var self = this;
    this.questionsEnAttente().forEach(function (q) { self._annulerQuestion(q, d.raison === 'terminal' ? 'Partie dans le Terminal' : 'Session terminée'); });
    if (d.raison === 'terminal') this._note('info', 'La session continue dans le Terminal. Cette fenêtre reste lisible mais n’envoie plus rien.');
    else if (code === 0 || code === null) this._note('info', 'Session terminée.');
    else this._note('erreur', 'Claude s’est arrêté (code ' + code + ').', this._stderr.slice(-12).join('\n'));
    this._calculerEtat();
  };

  /* Une ligne brute du stdout de claude (chaîne JSON ou objet déjà lu). */
  Session.prototype.recevoirLigne = function (ligne) {
    var d = ligne;
    if (typeof ligne === 'string') {
      if (!ligne.trim()) return;
      try { d = JSON.parse(ligne); } catch (e) {
        this._note('avert', 'Ligne illisible reçue de Claude.', ligne.slice(0, 400));
        return;
      }
    }
    if (!d || typeof d !== 'object') return;
    switch (d.type) {
      case 'system': return this._systeme(d, false);
      case 'stream_event': return this._evenementFlux(d);
      case 'assistant': return this._assistant(d, false);
      case 'user': return this._utilisateur(d, false);
      case 'result': return this._resultat(d);
      case 'control_request': return this._requeteControle(d);
      case 'control_response': return this._reponseControle(d);
      case 'control_cancel_request': return this._annulationControle(d);
      case 'rate_limit_event': return this._limite(d);
      default: return;
    }
  };

  /* ================= Lecture du protocole ================= */

  Session.prototype._debutTravail = function () {
    if (this.termine) return;
    if (!this.travaille) { this.travaille = true; this.debutTravail = Date.now(); }
    this._calculerEtat();
  };

  Session.prototype._definirActivite = function (t) {
    if (t === this.activite) return;
    this.activite = t;
    this.emit('activite', t);
  };

  /* Compaction (/compact ou automatique) : un seul élément dans le fil, avec sa barre de progression.
   * encours → fini (jetons avant/après, durée) ou echec. */
  Session.prototype._compaction = function (champs, histo) {
    if (histo) {
      // historique : seule la fin (compact_boundary) compte, un élément déjà terminé
      if (champs.etat === 'encours') return null;
      return this._ajouter(BT.etendre({ genre: 'compaction', debut: 0, historique: true }, champs));
    }
    var it = this._compactItem;
    if (it && it.etat === 'encours') {
      BT.etendre(it, champs);
      if (champs.etat !== 'encours') it.fin = Date.now();
      this._maj(it, 'etat');
      return it;
    }
    // échec rapporté juste après une fin (ou l'inverse) : on met à jour le même élément
    if (it && champs.etat !== 'encours' && Date.now() - (it.fin || 0) < 3000) {
      BT.etendre(it, champs); this._maj(it, 'etat'); return it;
    }
    it = this._compactItem = this._ajouter(BT.etendre({ genre: 'compaction', etat: 'encours', debut: Date.now() }, champs));
    if (champs.etat !== 'encours') it.fin = Date.now();
    return it;
  };

  Session.prototype._systeme = function (d, histo) {
    var o;
    switch (d.subtype) {
      case 'init':
        this.init = d;
        if (d.session_id) this.sessionId = d.session_id;
        if (d.model) this.modeleResolu = d.model;
        if (d.effort) this.effort = d.effort;
        if (d.permissionMode) this.permission = d.permissionMode;
        this.emit('info', this.etatInfo());
        break;
      case 'status':
        if (d.status === 'requesting') this._debutTravail();
        else if (d.status === 'compacting') this._compaction({ etat: 'encours' }, histo);
        if (d.compact_result === 'failed') this._compaction({ etat: 'echec', erreur: d.compact_error || '' }, histo);
        break;
      case 'compact_boundary':
        var cm = d.compact_metadata || d.compactMetadata || {};
        this._compaction({
          etat: 'fini', auto: cm.trigger === 'auto',
          avant: cm.pre_tokens || cm.preTokens || 0, apres: cm.post_tokens || cm.postTokens || 0,
          duree: cm.duration_ms || cm.durationMs || 0
        }, histo);
        break;
      case 'thinking_tokens':
        o = this._reflexionOuverte(d.parent_tool_use_id || '');
        if (o) { o.jetons = d.estimated_tokens; this._maj(o, 'jetons'); }
        break;
      case 'api_retry':
        var t = 'Nouvelle tentative de connexion' + (d.attempt ? ' (' + d.attempt + (d.max_retries ? ' sur ' + d.max_retries : '') + ')' : '') + '…';
        if (this._noteRetry && this.items[this.items.length - 1] === this._noteRetry) {
          this._noteRetry.texte = t; this._maj(this._noteRetry, 'texte');
        } else {
          this._noteRetry = this._note('avert', t, d.error_status ? 'Erreur ' + d.error_status : '');
        }
        break;
      case 'session_state_changed':
        if (d.state === 'running') this._debutTravail();
        break;
      case 'task_started':
        o = d.tool_use_id && this._outils[d.tool_use_id];
        if (o) {
          o.tache = { id: d.task_id, fond: !!d.is_backgrounded, statut: 'encours', progres: '', resume: '' };
          this._taches = this._taches || Object.create(null);
          this._taches[d.task_id] = o;
          this._maj(o, 'tache');
        }
        break;
      case 'task_progress':
        o = (d.tool_use_id && this._outils[d.tool_use_id]) || (this._taches && this._taches[d.task_id]);
        if (o && o.tache) { o.tache.progres = d.description || ''; this._maj(o, 'tache'); }
        break;
      case 'task_updated':
        o = this._taches && this._taches[d.task_id];
        if (o && o.tache && d.patch && d.patch.status) { o.tache.statut = d.patch.status; this._maj(o, 'tache'); }
        break;
      case 'task_notification':
        o = (d.tool_use_id && this._outils[d.tool_use_id]) || (this._taches && this._taches[d.task_id]);
        if (o && o.tache) {
          o.tache.statut = d.status || 'completed';
          o.tache.resume = d.summary || '';
          o.tache.progres = '';
          this._maj(o, 'tache');
        }
        if (o && o.tache && o.tache.fond) {
          var r = BT.resumeOutil(o.nom, o.entree);
          this._note('info', (d.status === 'completed' ? 'Tâche de fond terminée' : 'Tâche de fond : ' + (d.status || 'mise à jour')) + (r.cible ? ' : ' + r.cible : '') + '.');
        }
        break;
      case 'informational': case 'notification': case 'local_command_output':
        var c = d.content || d.message || d.text || d.title;
        if (c) this._note('info', BT.sansAnsi(typeof c === 'string' ? c : JSON.stringify(c)));
        break;
      default:
        break; // hook_*, files_persisted, stop_hook_summary… : rien à afficher
    }
  };

  Session.prototype._reflexionOuverte = function (cle) {
    var f = this._flux[cle];
    if (!f) return null;
    var derniere = null;
    for (var k in f.blocs) if (f.blocs[k].genre === 'reflexion') derniere = f.blocs[k];
    return derniere;
  };

  Session.prototype._evenementFlux = function (d) {
    var e = d.event || {};
    var cle = d.parent_tool_use_id || '';
    var f = this._flux[cle];
    var it, dl;
    switch (e.type) {
      case 'message_start':
        this._debutTravail();
        this._flux[cle] = { msgId: (e.message && e.message.id) || d.api_message_id || ('m' + (++this._seq)), blocs: {} };
        break;
      case 'content_block_start':
        if (!f) f = this._flux[cle] = { msgId: d.api_message_id || ('m' + (++this._seq)), blocs: {} };
        it = this._creerBloc(e.content_block || {}, f.msgId, d.parent_tool_use_id || null, true, false, null);
        if (it) f.blocs[e.index] = it;
        break;
      case 'content_block_delta':
        dl = e.delta || {};
        if (!f || !f.blocs[e.index]) {
          // ⌘R au milieu d'un bloc : son début est perdu, on montre la suite ; la ligne `assistant` du bloc
          // (même message.id) remplacera ce texte par le texte complet.
          if (dl.type !== 'text_delta' && dl.type !== 'thinking_delta') return;
          if (!f) f = this._flux[cle] = { msgId: d.api_message_id || ('m' + (++this._seq)), blocs: {} };
          it = this._creerBloc(dl.type === 'text_delta' ? { type: 'text', text: '… ' } : { type: 'thinking', thinking: '… ' },
            f.msgId, d.parent_tool_use_id || null, true, false, null);
          if (!it) return;
          f.blocs[e.index] = it;
          this._debutTravail();
        }
        it = f.blocs[e.index];
        if (dl.type === 'text_delta' && it.genre === 'texte') {
          it.texte += dl.text || ''; this._maj(it, 'texte');
        } else if (dl.type === 'thinking_delta' && it.genre === 'reflexion') {
          it.texte += dl.thinking || ''; this._maj(it, 'texte');
        } else if (dl.type === 'input_json_delta' && it.genre === 'outil') {
          it.entreeJson += dl.partial_json || '';
          it.entreeApercu = BT.apercuJsonPartiel(it.entreeJson);
          if (!it.parent) this._definirActivite(this._texteActivite(it));
          this._maj(it, 'entree');
        }
        break;
      case 'content_block_stop':
        if (!f) return;
        it = f.blocs[e.index]; if (!it) return;
        this._finBloc(it);
        break;
      default:
        break;
    }
  };

  Session.prototype._texteActivite = function (o) {
    var r = BT.resumeOutil(o.nom, o.entree || o.entreeApercu);
    return r.nom + (r.cible ? ' ' + r.cible : '');
  };

  /* Crée l'élément correspondant à un bloc de contenu (flux ou message complet). */
  Session.prototype._creerBloc = function (b, msgId, parent, enFlux, histo, date) {
    var base = { msgId: msgId, parent: parent || null, enCours: !!enFlux, historique: !!histo };
    if (date) base.date = date;
    var it = null;
    if (b.type === 'text') {
      it = BT.etendre(base, { genre: 'texte', texte: b.text || '' });
    } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      it = BT.etendre(base, { genre: 'reflexion', texte: b.thinking || '', masque: b.type === 'redacted_thinking', jetons: null, debut: date || Date.now(), fin: enFlux ? null : (date || Date.now()) });
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
      if (b.id && this._outils[b.id]) return this._outils[b.id];
      var entree = b.input && typeof b.input === 'object' && Object.keys(b.input).length ? b.input : null;
      it = BT.etendre(base, {
        genre: 'outil', toolUseId: b.id || null, nom: b.name || 'Outil', entree: entree, entreeJson: '', entreeApercu: null,
        statut: enFlux ? 'prepare' : 'encours', resultat: null, enfants: [], debut: date || Date.now(), fin: null, tache: null, questionId: null
      });
      if (b.id) this._outils[b.id] = it;
    } else if (/_tool_result$/.test(b.type || '') && b.tool_use_id) {
      this._resultatOutil(b.tool_use_id, b, null, histo, date);
      return null;
    } else {
      return null;
    }
    if (enFlux) (this._blocsParMsg[msgId] = this._blocsParMsg[msgId] || []).push(it);
    if (histo && it.genre !== 'outil' && msgId) (this._histoParMsg[msgId] = this._histoParMsg[msgId] || []).push(it);
    this._ajouter(it);
    if (it.genre === 'outil' && !it.parent && !histo) this._definirActivite(this._texteActivite(it));
    return it;
  };

  Session.prototype._finBloc = function (it) {
    if (it.genre === 'outil') {
      if (!it.entree && it.entreeJson) { try { it.entree = JSON.parse(it.entreeJson); } catch (e) { /* attendre la ligne assistant */ } }
      if (it.statut === 'prepare') it.statut = 'encours';
    } else {
      it.enCours = false;
      if (it.genre === 'reflexion' && !it.fin) it.fin = Date.now();
    }
    this._maj(it, 'fin');
  };

  Session.prototype._blocNonFinal = function (msgId, genre) {
    var l = this._blocsParMsg[msgId];
    if (!l) return null;
    for (var i = 0; i < l.length; i++) if (l[i].genre === genre && !l[i].final) return l[i];
    return null;
  };

  Session.prototype._dejaDansHistorique = function (msgId, genre, t) {
    var l = this._histoParMsg[msgId];
    if (!l) return false;
    for (var i = 0; i < l.length; i++) {
      if (l[i].genre === genre && (l[i].texte || '') === (t || '')) { l.splice(i, 1); return true; }
    }
    return false;
  };

  Session.prototype._assistant = function (d, histo) {
    var m = d.message || {};
    var contenu = Array.isArray(m.content) ? m.content : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);
    var msgId = m.id || d.uuid || ('m' + (++this._seq));
    var parent = d.parent_tool_use_id || null;
    var date = histo && d.timestamp ? Date.parse(d.timestamp) : null;
    if (!histo) this._debutTravail();
    if (!parent && m.model && m.model !== '<synthetic>') this.modeleResolu = m.model;
    for (var i = 0; i < contenu.length; i++) {
      var c = contenu[i] || {};
      var it = null;
      if (c.type === 'tool_use' || c.type === 'server_tool_use' || c.type === 'mcp_tool_use') {
        it = c.id && this._outils[c.id];
        if (it) {
          if (c.input) it.entree = c.input;
          if (c.name) it.nom = c.name;
          if (it.statut === 'prepare') it.statut = 'encours';
          this._maj(it, 'entree');
        } else {
          it = this._creerBloc(c, msgId, parent, false, histo, date);
        }
        if (it && !it.parent && !histo) this._definirActivite(this._texteActivite(it));
      } else if (c.type === 'text' || c.type === 'thinking' || c.type === 'redacted_thinking') {
        var genre = c.type === 'text' ? 'texte' : 'reflexion';
        var t = c.type === 'text' ? (c.text || '') : (c.thinking || '');
        it = histo ? null : this._blocNonFinal(msgId, genre);
        // Bloc déjà affiché par l'historique (⌘R : la ligne arrive aussi en direct) : pas de doublon.
        if (!it && !histo && this._dejaDansHistorique(msgId, genre, t)) continue;
        if (it) {
          if (genre === 'texte') it.texte = t || it.texte;
          else if (t) it.texte = t;
          it.enCours = false;
          if (genre === 'reflexion' && !it.fin) it.fin = Date.now();
          it.final = true;
          this._maj(it, 'texte');
        } else {
          it = this._creerBloc(c, msgId, parent, false, histo, date);
          if (it) it.final = true;
        }
        if (it && genre === 'texte' && (d.error || m.model === '<synthetic>' && /issue|error|erreur/i.test(t))) {
          it.erreur = d.error || 'erreur'; this._maj(it, 'erreur');
        }
        if (it && d.aborted) { it.interrompu = true; this._maj(it, 'interrompu'); }
      } else if (/_tool_result$/.test(c.type || '') && c.tool_use_id) {
        this._resultatOutil(c.tool_use_id, c, null, histo, date);
      }
    }
  };

  Session.prototype._utilisateur = function (d, histo) {
    var m = d.message || {};
    var c = m.content;
    var parent = d.parent_tool_use_id || null;
    var date = histo && d.timestamp ? Date.parse(d.timestamp) : null;
    if (typeof c === 'string') c = [{ type: 'text', text: c }];
    if (!Array.isArray(c)) return;
    var resultats = c.filter(function (b) { return b && b.type === 'tool_result'; });
    var struct = d.tool_use_result !== undefined ? d.tool_use_result : d.toolUseResult;
    var self = this;
    resultats.forEach(function (b) {
      self._resultatOutil(b.tool_use_id, b, resultats.length === 1 ? struct : null, histo, date);
    });
    var textes = [], images = [];
    c.forEach(function (b) {
      if (!b) return;
      if (b.type === 'text') textes.push(b.text || '');
      else if (b.type === 'image') {
        var src = b.source || {};
        if (src.type === 'base64' && /^image\/(png|jpeg|gif|webp)$/.test(src.media_type || '') && typeof src.data === 'string') {
          images.push('data:' + src.media_type + ';base64,' + src.data);
        } else textes.push('[image]');
      }
    });
    if (!textes.length && !images.length) return;
    if (parent) return; // consigne envoyée à un sous-agent : visible dans l'outil Agent
    // Claude Code écrit « [Image #1] » dans le texte quand l'image est collée dans le terminal : l'image suffit.
    var texte = textes.join('\n\n');
    if (images.length) texte = texte.replace(/\[Image #\d+\]\s*/g, '').trim();
    if (/^\s*\[Request interrupted by user/.test(texte)) {
      this._note('info', 'Interrompu par Eliot.', '', histo);
      if (!histo) { this._fermerOuverts('interrompu'); this._interrompu = true; }
      return;
    }
    if (!histo) return; // en direct, les messages d'Eliot sont affichés au moment de l'envoi
    if (d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) return;
    var cmd = /<command-name>([^<]*)<\/command-name>/.exec(texte);
    if (cmd) {
      var args = /<command-args>([\s\S]*?)<\/command-args>/.exec(texte);
      var ligne = cmd[1].trim() + (args && args[1].trim() ? ' ' + args[1].trim() : '');
      if (/^\/compact$/.test(cmd[1].trim())) return;   // la compaction a son propre élément (compact_boundary)
      this._ajouter({ genre: 'eliot', texte: ligne, commande: true, historique: true, date: date });
      return;
    }
    var sortie = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(texte);
    if (sortie) {
      var s = BT.sansAnsi(sortie[1]).trim();
      if (/^Compacted\b/.test(s)) return;
      if (s) this._ajouter({ genre: 'texte', texte: s, final: true, enCours: false, historique: true, date: date });
      return;
    }
    if (/^\s*<(local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr|task-notification|user-prompt-submit-hook)/.test(texte)) return;
    var fj = BT.extraireFichiers(texte);
    this._ajouter({ genre: 'eliot', texte: fj.texte, images: images.length ? images : null, fichiers: fj.fichiers, historique: true, date: date });
  };

  /* Fichiers joints : leurs chemins partent dans le texte, dans un bloc que Claude lit (outil Read)
   * et que l'historique sait retrouver pour réafficher les pastilles. */
  var BALISE_FICHIERS = /\n*<fichiers-joints>\n([\s\S]*?)\n?<\/fichiers-joints>\s*$/;
  BT.blocFichiers = function (fichiers) {
    return '<fichiers-joints>\n' + fichiers.map(function (f) { return f.chemin; }).join('\n') + '\n</fichiers-joints>';
  };
  BT.extraireFichiers = function (texte) {
    var m = BALISE_FICHIERS.exec(texte);
    if (!m) return { texte: texte, fichiers: null };
    var l = m[1].split('\n').map(function (c) { return c.trim(); }).filter(Boolean).map(function (c) {
      return { chemin: c, nom: c.replace(/\/+$/, '').split('/').pop() || c };
    });
    return { texte: texte.slice(0, m.index).trim(), fichiers: l.length ? l : null };
  };

  Session.prototype._resultatOutil = function (id, bloc, struct, histo, date) {
    var o = id && this._outils[id];
    if (!o) return;
    var contenu = bloc.content, texte = '', images = [];
    if (typeof contenu === 'string') texte = contenu;
    else if (Array.isArray(contenu)) {
      contenu.forEach(function (p) {
        if (!p) return;
        if (p.type === 'text') texte += (texte ? '\n' : '') + (p.text || '');
        else if (p.type === 'image' && p.source && p.source.type === 'base64') images.push({ type: p.source.media_type, data: p.source.data });
      });
    }
    texte = BT.sansAnsi(texte).replace(/^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/, '$1');
    o.resultat = { texte: texte, images: images, structure: struct === undefined ? null : struct };
    o.statut = bloc.is_error ? 'erreur' : 'ok';
    o.fin = date || Date.now();
    this._maj(o, 'resultat');
    if (!o.parent && !histo) this._definirActivite('');
    // Question répondue ailleurs (ou fermée par claude) : on la clôt ici aussi.
    var q = o.questionId && this._parId[o.questionId];
    if (q && q.statut === 'attente') this._annulerQuestion(q, 'Question close');
  };

  Session.prototype._fermerOuverts = function (statutOutil) {
    for (var k in this._outils) {
      var o = this._outils[k];
      if ((o.statut === 'prepare' || o.statut === 'encours') && !(o.tache && o.tache.fond)) {
        o.statut = statutOutil; o.fin = o.fin || Date.now(); this._maj(o, 'statut');
      }
    }
    for (var i = this.items.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
      var it = this.items[i];
      if ((it.genre === 'texte' || it.genre === 'reflexion') && it.enCours) {
        it.enCours = false; if (it.genre === 'reflexion' && !it.fin) it.fin = Date.now(); this._maj(it, 'fin');
      }
    }
    this._flux = Object.create(null);
  };

  Session.prototype._resultat = function (d) {
    var interrompu = this._interrompu || /^aborted/.test(d.terminal_reason || '');
    this._interrompu = false;
    this._fermerOuverts('interrompu');
    var erreur = !!d.is_error && !interrompu;
    if (erreur) {
      var dejaVisible = false;
      for (var i = this.items.length - 1; i >= 0 && i > this.items.length - 6; i--) {
        if (this.items[i].genre === 'texte' && this.items[i].erreur) { dejaVisible = true; break; }
      }
      var libelles = {
        error_max_turns: 'Nombre maximal d’étapes atteint.',
        error_during_execution: 'Erreur pendant l’exécution.',
        error_max_budget_usd: 'Budget maximal atteint.',
        error_max_structured_output_retries: 'Sortie structurée impossible.'
      };
      if (!dejaVisible) {
        var detail = (Array.isArray(d.errors) && d.errors.join('\n')) || (typeof d.result === 'string' ? BT.nettoyerTexteClaude(d.result) : '');
        this._note('erreur', libelles[d.subtype] || 'Le tour s’est terminé sur une erreur.', detail);
      }
    }
    this._compterJetons(d.usage, d.total_cost_usd);
    this._ajouter({ genre: 'fin', duree: d.duration_ms, erreur: erreur, interrompu: interrompu });
    this.travaille = false;
    this.debutTravail = null;
    this._definirActivite('');
    var self = this;
    this.items.forEach(function (it) { if (it.genre === 'eliot' && it.enFile) { it.enFile = false; self._maj(it, 'enFile'); } });
    this._calculerEtat();
    // Jarvis dit le résumé du tour (pas après une interruption : c'est Eliot qui l'a demandée).
    if (this.vocal.actif && !interrompu) this._vocalFin(d, erreur);
  };

  Session.prototype._limite = function (d) {
    var r = d.rate_limit_info || {};
    this.quota = r;
    if (r.status && r.status !== 'allowed' && r.status !== 'allowed_warning') {
      var quand = r.resetsAt ? ' Reprise vers ' + BT.heure(new Date(r.resetsAt * 1000)) + '.' : '';
      this._note('avert', 'Limite d’usage de l’abonnement atteinte.' + quand);
    }
  };

  /* ================= Requêtes de contrôle ================= */

  Session.prototype._ecrire = function (obj) {
    if (!this._initDemande && !this.dansTerminal && !(obj.type === 'control_request' && obj.request && obj.request.subtype === 'initialize')) {
      this._initDemande = true;
      this._demanderInitialize();
    }
    this._envoyer('versClaude', { ligne: JSON.stringify(obj) });
  };

  Session.prototype.requete = function (req, rappel) {
    var id = 'bt-' + (++this._compteurReq) + '-' + BT.idCourt().slice(0, 6);
    if (rappel) this._requetes[id] = rappel;
    this._ecrire({ type: 'control_request', request_id: id, request: req });
    return id;
  };

  Session.prototype._reponseControle = function (d) {
    var r = d.response || {};
    var rappel = this._requetes[r.request_id];
    if (!rappel) return;
    delete this._requetes[r.request_id];
    rappel(r.subtype === 'success', r.response || {}, r.error || '', r);
  };

  Session.prototype._requeteControle = function (d) {
    var r = d.request || {};
    if (r.subtype === 'can_use_tool') return this._demandeOutil(d.request_id, r);
    // Jamais déclaré par la page : le protocole interdit d'y répondre.
    if (r.subtype === 'request_user_dialog') return;
    // Autre requête (hook, MCP, elicitation…) : on décline pour ne pas bloquer claude.
    this._ecrire({ type: 'control_response', response: { subtype: 'error', request_id: d.request_id, error: 'Requête « ' + r.subtype + ' » non prise en charge par Better Terminal.' } });
  };

  Session.prototype._annulationControle = function (d) {
    var q = this._questions[d.request_id];
    if (q && q.statut === 'attente') this._annulerQuestion(q, 'Question retirée par Claude');
  };

  /* ================= Questions et permissions ================= */

  Session.prototype._demandeOutil = function (rid, r) {
    if (this._questions[rid]) return;
    var entree = r.input || {};
    var q = {
      genre: 'question', requestId: rid, toolUseId: r.tool_use_id || null, outil: r.tool_name || 'Outil',
      nomAffiche: r.display_name || r.tool_name || 'Outil', entree: entree, statut: 'attente',
      suggestions: Array.isArray(r.permission_suggestions) && r.permission_suggestions.length ? r.permission_suggestions : null,
      description: BT.sansAnsi(r.description || ''), titre: BT.sansAnsi(r.title || ''), raison: BT.sansAnsi(r.decision_reason || ''),
      parDefautNon: !!r.default_to_no, pontIds: [], reponseTexte: '', source: ''
    };
    if (q.outil === 'AskUserQuestion') {
      q.type = 'questions';
      q.questions = (entree.questions || []).map(function (x) {
        return {
          texte: x.question || '', entete: x.header || '', multi: !!x.multiSelect, reponse: null, brouillon: null, sourceBrouillon: '',
          options: (x.options || []).map(function (o) { return { label: o.label || '', description: o.description || '', apercu: o.preview || '' }; })
        };
      });
    } else if (q.outil === 'ExitPlanMode') {
      q.type = 'plan'; q.plan = entree.plan || '';
    } else {
      q.type = 'permission';
    }
    this._questions[rid] = q;
    this._ajouter(q);
    var o = q.toolUseId && this._outils[q.toolUseId];
    if (o) {
      o.questionId = q.id;
      // marqué « interrompu » par l'historique (⌘R) alors que la question attend toujours
      if (o.statut === 'interrompu') { o.statut = 'encours'; o.fin = null; }
      this._maj(o, 'question');
    }
    this._annoncerAuPont(q);
    this._calculerEtat();
  };

  Session.prototype.texteQuestion = function (q) {
    if (q.type === 'questions') return (q.questions[0] && q.questions[0].texte) || 'Claude te pose une question.';
    if (q.type === 'plan') return 'Claude propose un plan et attend ton accord.';
    var r = BT.resumeOutil(q.outil, q.entree);
    return 'Claude veut utiliser ' + r.nom + (r.cible ? ' : ' + r.cible : (q.description ? ' : ' + q.description : '')) + '.';
  };

  Session.prototype.optionsPermission = function (q) {
    var lib = q.type === 'plan' ? LIBELLES_PLAN : LIBELLES_PERMISSION;
    var l = [{ label: lib.autoriser, description: '' }];
    if (q.type === 'permission' && q.suggestions) l.push({ label: LIBELLES_PERMISSION.toujours, description: 'Pour le reste de la session' });
    l.push({ label: lib.refuser, description: '' });
    return l;
  };

  /* Identifiant de pont stable, tiré du request_id : après un ⌘R, la question réannoncée garde le même id
   * (pas de second message Telegram, et un clic sur le premier reste valable). 1 à 32 caractères A-Za-z0-9_-. */
  function idPont(q, suffixe) {
    var base = String(q.requestId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    return base ? 'q' + base + '-' + suffixe : BT.idCourt();
  }

  Session.prototype._annoncerAuPont = function (q) {
    var self = this;
    if (q.type === 'questions') {
      q.questions.forEach(function (x, i) {
        var id = idPont(q, i);
        self._pont[id] = { q: q, index: i, externe: false };
        q.pontIds.push(id);
        // « type » nomme déjà le message côté coque : le type de question va dans typeQuestion.
        self._envoyer('question', {
          id: id, typeQuestion: x.multi ? 'multi' : 'choix', texte: x.texte, header: x.entete || undefined,
          options: x.options.map(function (o) { return { label: o.label, description: o.description }; })
        });
      });
    } else {
      var id = idPont(q, 'p');
      this._pont[id] = { q: q, index: -1, externe: false };
      q.pontIds.push(id);
      this._envoyer('question', { id: id, typeQuestion: 'permission', texte: this.texteQuestion(q), options: this.optionsPermission(q) });
    }
    if (this.vocal.actif) this._annoncerVocal(q);
  };

  /* Chaque id du pont reçoit sa propre réponse (sous-question d'AskUserQuestion), sinon le texte global. */
  Session.prototype._fermerAuPont = function (q, texte) {
    var self = this;
    q.pontIds.forEach(function (id) {
      var e = self._pont[id];
      if (!e || e.externe) return;
      var x = q.type === 'questions' && e.index >= 0 ? q.questions[e.index] : null;
      self._envoyer('questionClose', { id: id, reponse: x && x.reponse && q.statut === 'repondue' ? x.reponse : texte });
    });
    this._retirerVocal(q);
  };

  Session.prototype._annulerQuestion = function (q, texte) {
    q.statut = 'annulee';
    q.reponseTexte = texte;
    this._maj(q, 'statut');
    this._fermerAuPont(q, texte);
    this._calculerEtat();
  };

  /* Brouillon d'une réponse à une sous-question (choix en cours, pas encore envoyé). */
  Session.prototype.brouillon = function (itemId, index, valeur, source) {
    var q = this._parId[itemId];
    if (!q || q.type !== 'questions' || q.statut !== 'attente' || !q.questions[index]) return;
    q.questions[index].brouillon = valeur;
    q.questions[index].sourceBrouillon = source || 'mac';
    // Eliot répond ailleurs (clic, saisie, Telegram) : Jarvis ne lit plus cette question.
    if (source !== 'vocal') this._retirerVocal(q);
    this._maj(q, 'brouillon');
  };

  /* Réponse à une question ou permission.
   *   questions  : { reponses: [chaîne par question] }   (choix multiple : labels joints par ", ")
   *   permission : { decision: 'autoriser' | 'toujours' | 'refuser', message? }
   *   plan       : { decision: 'autoriser' | 'refuser', message? } */
  Session.prototype.repondre = function (itemId, rep, source) {
    var q = this._parId[itemId];
    if (!q || q.genre !== 'question' || q.statut !== 'attente') return false;
    rep = rep || {};
    var res, texte;
    if (q.type === 'questions') {
      var answers = {};
      q.questions.forEach(function (x, i) {
        var v = rep.reponses && rep.reponses[i] != null ? String(rep.reponses[i]) : '';
        x.reponse = v; x.brouillon = v;
        answers[x.texte] = v;
      });
      res = { behavior: 'allow', updatedInput: BT.etendre({}, q.entree, { answers: answers }) };
      texte = q.questions.map(function (x) { return x.reponse; }).join(' · ');
    } else if (rep.decision === 'autoriser' || rep.decision === 'toujours') {
      res = { behavior: 'allow', updatedInput: q.entree };
      if (rep.decision === 'toujours' && q.suggestions) res.updatedPermissions = q.suggestions;
      texte = q.type === 'plan' ? LIBELLES_PLAN.autoriser : LIBELLES_PERMISSION[rep.decision];
    } else {
      var msg = rep.message && String(rep.message).trim();
      res = { behavior: 'deny', message: msg || (q.type === 'plan' ? 'Eliot veut continuer à planifier.' : 'Eliot a refusé.') };
      texte = (q.type === 'plan' ? LIBELLES_PLAN.refuser : 'Refusé') + (msg ? ' : ' + msg : '');
    }
    if (q.toolUseId) res.toolUseID = q.toolUseId;
    this._ecrire({ type: 'control_response', response: { subtype: 'success', request_id: q.requestId, response: res } });
    q.statut = 'repondue';
    q.reponseTexte = texte;
    q.source = source || 'mac';
    this._maj(q, 'statut');
    this._fermerAuPont(q, texte);
    this._calculerEtat();
    return true;
  };

  /* Fermer une question sans répondre (Claude s'arrête, vérifié par B). */
  Session.prototype.ignorerQuestion = function (itemId) {
    var q = this._parId[itemId];
    if (!q || q.statut !== 'attente') return false;
    if (q.type === 'questions') {
      this._ecrire({ type: 'control_response', response: { subtype: 'success', request_id: q.requestId, response: { behavior: 'deny', message: 'Eliot a fermé la question sans répondre.', toolUseID: q.toolUseId || undefined } } });
      q.statut = 'repondue'; q.reponseTexte = 'Fermée sans réponse'; q.source = 'mac';
      this._maj(q, 'statut');
      this._fermerAuPont(q, q.reponseTexte);
      this._calculerEtat();
      return true;
    }
    return this.repondre(itemId, { decision: 'refuser' }, 'mac');
  };

  /* Réponse arrivée de Telegram via Swift : { id, reponse: [labels] | "texte libre", source }.
   * Le texte libre (Beeper, où les boutons ne sont pas cliquables, ou « Préciser » de Telegram) passe par
   * le même traducteur que la voix : « 2 », « Poire », « rouge et bleu », « oui » deviennent la bonne réponse. */
  Session.prototype.reponseExterne = function (d) {
    d = d || {};
    var e = this._pont[d.id];
    if (!e) return;
    var q = e.q;
    if (q.statut !== 'attente') return;
    var src = d.source || 'telegram';
    var libre = !Array.isArray(d.reponse);
    var texte = libre ? String(d.reponse == null ? '' : d.reponse).trim() : '';
    var trad = libre && texte && BT.vocal ? BT.vocal.interpreter(texte, this._specVocale(e)) : null;
    if (q.type === 'questions') {
      var v;
      if (!libre) v = d.reponse.join(', ');
      else if (trad && trad.ok && trad.genre === 'choix') v = trad.labels.join(', ');
      else v = texte; // texte libre, ou ambigu : AskUserQuestion accepte le texte libre, on le garde tel quel
      if (!v) return;  // rien à lire : la question reste ouverte
      e.externe = true;
      this.brouillon(q.id, e.index, v, src);
      var complet = q.questions.every(function (y) { return y.brouillon != null && y.brouillon !== ''; });
      if (complet) this.repondre(q.id, { reponses: q.questions.map(function (y) { return y.brouillon; }) }, src);
      return;
    }
    var rep;
    if (!libre) {
      var lab = String(d.reponse[0] || '');
      if (lab === LIBELLES_PERMISSION.autoriser || lab === LIBELLES_PLAN.autoriser) rep = { decision: 'autoriser' };
      else if (lab === LIBELLES_PERMISSION.toujours) rep = { decision: 'toujours' };
      else if (lab === LIBELLES_PERMISSION.refuser || lab === LIBELLES_PLAN.refuser) rep = { decision: 'refuser' };
      else rep = { decision: 'refuser', message: d.reponse.join(', ') };
    } else if (trad && trad.ok && trad.genre === 'decision') {
      rep = { decision: trad.decision, message: trad.message };
    } else if (texte && (!trad || trad.raison === 'incompris')) {
      rep = { decision: 'refuser', message: texte }; // « Préciser » : refus avec une consigne pour Claude
    } else {
      // « 4 » pour deux options, « oui non » : on ne devine pas, la question reste ouverte.
      if (texte) this._note('avert', 'Réponse ' + (src === 'telegram' ? 'de Telegram' : 'externe') + ' non comprise : « ' + BT.tronquer(texte, 80) + ' ». La question reste ouverte.');
      return;
    }
    e.externe = true;
    this.repondre(q.id, rep, src);
  };

  /* ================= Mode vocal « Jarvis » ================= */

  var DECISIONS = {};
  DECISIONS[LIBELLES_PERMISSION.autoriser] = 'autoriser';
  DECISIONS[LIBELLES_PERMISSION.toujours] = 'toujours';
  DECISIONS[LIBELLES_PERMISSION.refuser] = 'refuser';
  DECISIONS[LIBELLES_PLAN.autoriser] = 'autoriser';
  DECISIONS[LIBELLES_PLAN.refuser] = 'refuser';

  /* La question du pont (une sous-question d'AskUserQuestion, ou une permission) vue par BT.vocal. */
  Session.prototype._specVocale = function (e) {
    var q = e.q;
    if (q.type === 'questions') {
      var x = q.questions[e.index] || { texte: '', options: [], multi: false };
      return { type: x.multi ? 'multi' : 'choix', texte: x.texte, libre: true, rang: e.index, total: q.questions.length,
        options: x.options.map(function (o) { return { label: o.label }; }) };
    }
    return {
      type: q.type === 'plan' ? 'plan' : 'permission',
      texte: q.type === 'plan' ? '' : BT.vocal.textePermission(q.outil, q.entree, q.description),
      options: this.optionsPermission(q).map(function (o) { return { label: o.label, decision: DECISIONS[o.label] }; })
    };
  };

  /* bt.vocalEtat({actif, etat, enLigne, questionId?, raccourci?}) : état commun à toutes les fenêtres. */
  Session.prototype.definirVocal = function (d) {
    d = d || {};
    var avant = this.vocal.actif;
    var actif = !!d.actif;
    this.vocal = {
      actif: actif, etat: actif ? (d.etat || 'pret') : 'inactif', enLigne: actif && !!d.enLigne,
      questionId: d.questionId || null, raccourci: d.raccourci || this.vocal.raccourci || ''
    };
    // Mode coupé : la coque vide sa file ; au retour, les questions encore ouvertes sont relues.
    if (!actif) { this._vocalAnnonces = Object.create(null); this._vocalEchecs = Object.create(null); }
    this.emit('vocal', this.vocal);
    if (actif && !avant) {
      var self = this;
      this.questionsEnAttente().forEach(function (q) { self._annoncerVocal(q); });
    }
  };

  /* Bouton « Mode Jarvis » : la coque confirme par bt.vocalEtat, mais l'affichage suit tout de suite. */
  Session.prototype.basculerVocal = function (actif) {
    actif = actif == null ? !this.vocal.actif : !!actif;
    this._envoyer('modeVocal', { actif: actif });
    this.definirVocal({ actif: actif, etat: actif ? 'pret' : 'inactif', enLigne: false });
  };

  Session.prototype._annoncerVocal = function (q) {
    if (!BT.vocal || q.statut !== 'attente') return;
    var self = this;
    q.pontIds.forEach(function (id) {
      var e = self._pont[id];
      if (!e || e.externe || self._vocalAnnonces[id]) return;
      if (q.type === 'questions' && q.questions[e.index] && q.questions[e.index].brouillon) return; // déjà répondue
      self._vocalAnnonces[id] = true;
      self._envoyer('vocal', { texte: BT.vocal.phraseQuestion(self._specVocale(e)), priorite: 'question', questionId: id });
    });
  };

  /* Question close ou répondue ailleurs : la coque la retire de la file (et se tait si elle la lisait). */
  Session.prototype._retirerVocal = function (q) {
    var self = this;
    (q.pontIds || []).forEach(function (id) {
      if (!self._vocalAnnonces[id]) return;
      delete self._vocalAnnonces[id];
      self._envoyer('vocalAnnule', { questionId: id });
    });
  };

  Session.prototype._vocalFin = function (d, erreur) {
    if (!BT.vocal) return;
    var brut = typeof d.result === 'string' && d.result.trim() ? d.result : this._dernierTexte();
    var t = BT.vocal.resumeFin(brut);
    if (erreur) t = 'Erreur : ' + (t || 'le tour s’est terminé sur une erreur.');
    this._envoyer('vocal', { texte: t || 'Tâche terminée.', priorite: 'fin' });
  };

  /* « Cockpit, lance les tests » : la coque route sur le nom du projet ; s'il reste devant, on l'enlève. */
  Session.prototype._sansNomProjet = function (t) {
    var p = this.info.projet;
    var m = p && /^\s*([^,:;.!?]{1,60})\s*[,:;.!?]\s*([\s\S]+)$/.exec(t);
    return m && BT.vocal.normaliser(m[1]) === BT.vocal.normaliser(p) ? m[2].trim() : t;
  };

  /* bt.transcription({texte, questionId?}) : texte dicté pour cette session.
   * Avec questionId : réponse à la question ; sinon : message pour Claude (source « vocal »).
   * Renvoie l'élément créé (message), true (réponse acceptée) ou false (rien fait). */
  Session.prototype.transcription = function (d) {
    d = d || {};
    var texte = this._sansNomProjet(String(d.texte == null ? '' : d.texte).trim());
    var id = d.questionId;
    if (!id) {
      if (!BT.vocal || BT.vocal.parasite(texte)) return false; // silence ou « Sous-titres réalisés par… »
      return this.envoyerMessage(texte, 'vocal') || false;
    }
    var e = this._pont[id];
    if (!e || e.q.statut !== 'attente') {
      this._envoyer('vocal', { texte: 'Cette question n’attend plus de réponse.', priorite: 'fin' });
      return false;
    }
    var q = e.q, spec = this._specVocale(e);
    var r = BT.vocal.interpreter(texte, spec);
    q.vocalEntendu = texte;
    q.vocalCompris = r.ok;
    if (!r.ok) {
      var n = this._vocalEchecs[id] = (this._vocalEchecs[id] || 0) + 1;
      this._maj(q, 'vocal');
      if (n >= 3) {
        this._envoyer('vocal', { texte: 'Je n’ai toujours pas compris. La question reste ouverte dans la fenêtre.', priorite: 'fin' });
        return false;
      }
      this._vocalAnnonces[id] = true;
      this._envoyer('vocal', { texte: BT.vocal.PAS_COMPRIS + ' ' + BT.vocal.listeOptions(spec), priorite: 'question', questionId: id });
      return false;
    }
    delete this._vocalEchecs[id];
    if (q.type === 'questions') {
      var v = r.genre === 'choix' ? r.labels.join(', ') : r.texte;
      if (q.questions.length === 1) return this.repondre(q.id, { reponses: [v] }, 'vocal');
      this.brouillon(q.id, e.index, v, 'vocal');
      if (q.questions.every(function (y) { return y.brouillon; })) {
        return this.repondre(q.id, { reponses: q.questions.map(function (y) { return y.brouillon; }) }, 'vocal');
      }
      return true;
    }
    return this.repondre(q.id, { decision: r.decision, message: r.message }, 'vocal');
  };

  /* ================= Actions d'Eliot ================= */

  /* source : absent (tapé dans la fenêtre), 'lancement', 'registre', … (bt.envoyerTexte). */
  /* images : [{ type: 'image/png', donnees: '<base64>' }] (jointes dans la fenêtre), placées avant le texte.
   * fichiers : [{ chemin, nom, taille, dossier }] (tout autre fichier) : chemins ajoutés au texte, Claude les lit. */
  Session.prototype.envoyerMessage = function (texte, source, images, fichiers) {
    texte = String(texte == null ? '' : texte);
    images = (Array.isArray(images) ? images : []).filter(function (i) {
      return i && /^image\/(png|jpeg|gif|webp)$/.test(i.type) && typeof i.donnees === 'string' && i.donnees;
    });
    fichiers = (Array.isArray(fichiers) ? fichiers : []).filter(function (f) { return f && /^\//.test(f.chemin || '') && !/[\n\r]/.test(f.chemin); });
    if ((!texte.trim() && !images.length && !fichiers.length) || this.termine) return null;
    // /compact : pas de bulle, l'élément « Compaction de la conversation » (barre de progression) la remplace.
    var compact = /^\/compact(\s+([\s\S]*))?$/.exec(texte.trim());
    var it = compact && !images.length && !fichiers.length
      ? this._compaction({ etat: 'encours', consigne: (compact[2] || '').trim() })
      : this._ajouter({
      fichiers: fichiers.length ? fichiers.map(function (f) { return { chemin: f.chemin, nom: f.nom, taille: f.taille, dossier: f.dossier }; }) : null,
      genre: 'eliot', texte: texte, enFile: this.travaille, source: source || '', commande: /^\/[^\s/]/.test(texte),
      images: images.length ? images.map(function (i) { return 'data:' + i.type + ';base64,' + i.donnees; }) : null
    });
    var contenu = images.map(function (i) { return { type: 'image', source: { type: 'base64', media_type: i.type, data: i.donnees } }; });
    var envoi = texte.trim();
    if (fichiers.length) envoi = (envoi ? envoi + '\n\n' : '') + BT.blocFichiers(fichiers);
    if (envoi) contenu.push({ type: 'text', text: envoi });
    this._ecrire({ type: 'user', session_id: '', message: { role: 'user', content: contenu }, parent_tool_use_id: null });
    this._debutTravail();
    return it;
  };

  Session.prototype.interrompre = function () {
    if (!this.travaille || this.termine) return false;
    this._interrompu = true;
    this.requete({ subtype: 'interrupt' });
    return true;
  };

  Session.prototype.nomModele = function (valeur) {
    var v = valeur || this.modele;
    for (var i = 0; i < this.modeles.length; i++) {
      var m = this.modeles[i];
      if (m.value === v || (m.resolvedModel && m.resolvedModel === v)) return m.displayName || m.value;
    }
    return v || '';
  };

  /* Valeur du menu correspondant au modèle courant. */
  Session.prototype.valeurModele = function () {
    var self = this;
    if (this.modele && this.modeles.some(function (m) { return m.value === self.modele; })) return this.modele;
    var r = this.modeleResolu;
    if (r) {
      for (var i = 0; i < this.modeles.length; i++) {
        if (this.modeles[i].value !== 'default' && this.modeles[i].resolvedModel === r) return this.modeles[i].value;
      }
      for (var j = 0; j < this.modeles.length; j++) {
        if (this.modeles[j].value !== 'default' && r.indexOf(this.modeles[j].value) >= 0) return this.modeles[j].value;
      }
    }
    return this.modele || 'default';
  };

  Session.prototype.changerModele = function (valeur) {
    var self = this;
    this.modele = valeur;
    this.emit('info', this.etatInfo());
    this.requete({ subtype: 'set_model', model: valeur === 'default' ? null : valeur }, function (ok, rep, err) {
      if (ok) {
        if (rep && rep.model) self.modeleResolu = rep.model;
        self._note('info', 'Modèle : ' + self.nomModele(valeur) + '.');
        self.emit('info', self.etatInfo());
      } else {
        self._note('avert', 'Changement de modèle refusé en cours de session : relance avec ' + self.nomModele(valeur) + '.', err);
        self._envoyer('relancer', { modele: valeur });
      }
    });
  };

  Session.prototype.changerEffort = function (niveau) {
    var self = this;
    this.effort = niveau;
    this.emit('info', this.etatInfo());
    var lib = (BT.EFFORTS.filter(function (e) { return e.value === niveau; })[0] || { label: niveau }).label;
    this.requete({ subtype: 'apply_flag_settings', settings: { effortLevel: niveau } }, function (ok, rep, err) {
      if (ok) {
        self._note('info', 'Effort : ' + lib.toLowerCase() + ' (à partir du prochain message).');
      } else {
        self._note('avert', 'Changement d’effort refusé en cours de session : relance.', err);
        self._envoyer('relancer', { effort: niveau });
      }
    });
  };

  Session.prototype.changerPermission = function (mode) {
    var self = this, avant = this.permission;
    this.permission = mode;
    this.emit('info', this.etatInfo());
    var p = BT.PERMISSIONS.filter(function (x) { return x.value === mode; })[0] || { label: mode, detail: '' };
    this.requete({ subtype: 'set_permission_mode', mode: mode }, function (ok, rep, err) {
      if (ok) {
        if (rep && rep.mode) self.permission = rep.mode;
        self._note('info', 'Permissions : ' + p.label + '. ' + p.detail);
      } else {
        self.permission = avant;
        self._note('avert', 'Changement de permissions refusé.', err);
      }
      self.emit('info', self.etatInfo());
    });
  };

  /* Cumul des jetons de la session. `u` = usage d'un tour (result) ou d'un appel (historique). */
  Session.prototype._compterJetons = function (u, cout) {
    if (!u || typeof u !== 'object') return;
    var j = this.jetons;
    j.entree += u.input_tokens || 0;
    j.sortie += u.output_tokens || 0;
    j.cacheLu += u.cache_read_input_tokens || 0;
    j.cacheEcrit += u.cache_creation_input_tokens || 0;
    if (typeof cout === 'number') j.cout += cout;
    this.emit('jetons', j);
  };

  Session.prototype.etatInfo = function () {
    return {
      projet: this.info.projet || '', emoji: this.info.emoji || '', cwd: this.info.cwd || (this.init && this.init.cwd) || '',
      sessionId: this.sessionId || this.info.sessionId || '', modele: this.valeurModele(), modeleResolu: this.modeleResolu || '',
      effort: this.effort || '', effortDefaut: this.info.effortDefaut || '', modeles: this.modeles, permissionMode: this.permission || (this.init ? this.init.permissionMode : '') || '',
      dansTerminal: !!this.dansTerminal, barreTitre: this.info.barreTitre || null, reprise: !!this.info.reprise
    };
  };

  /* ================= Historique (transcript ~/.claude/projects/…/<id>.jsonl) ================= */

  Session.prototype.chargerHistorique = function (lignes) {
    if (typeof lignes === 'string') lignes = lignes.split('\n');
    if (!Array.isArray(lignes)) return;
    var n = 0, self = this, usages = Object.create(null), sansId = [], dernierMsg = null;
    lignes.forEach(function (l) {
      var d = l;
      if (typeof l === 'string') {
        if (!l.trim()) return;
        try { d = JSON.parse(l); } catch (e) { return; }
      }
      if (!d || typeof d !== 'object') return;
      // Jetons : sous-agents compris (ils consomment aussi). Un même message est répété par bloc de contenu.
      if (d.type === 'assistant' && d.message && d.message.usage) {
        if (d.message.id) usages[d.message.id] = d.message.usage; else sansId.push(d.message.usage);
      }
      if (d.isSidechain) return;
      if (d.type === 'assistant' && !d.parent_tool_use_id) dernierMsg = (d.message && d.message.id) || d.uuid || dernierMsg;
      try {
        if (d.type === 'assistant') { self._assistant(d, true); n++; }
        else if (d.type === 'user') { self._utilisateur(d, true); n++; }
        else if (d.type === 'attachment' && d.attachment && d.attachment.type === 'queued_command') {
          var p = d.attachment.prompt;
          var t = typeof p === 'string' ? p : (Array.isArray(p) ? p.map(function (x) { return x && x.text || ''; }).join('\n') : '');
          if (t.trim()) { self._ajouter({ genre: 'eliot', texte: t, enFile: false, historique: true, date: d.timestamp ? Date.parse(d.timestamp) : null }); n++; }
        } else if (d.type === 'system' && d.subtype === 'compact_boundary') self._systeme(d, true);
      } catch (e) { console.error('[BT] historique', e); }
    });
    // Outils restés ouverts : interrompus, sauf ceux du dernier message quand claude travaille encore (⌘R pendant
    // un tour) : ceux-là tournent toujours, leur résultat arrivera en direct.
    var actif = null;
    for (var k in this._outils) {
      var o = this._outils[k];
      if (o.statut !== 'prepare' && o.statut !== 'encours') continue;
      if (this._repriseTour && !o.parent && o.msgId === dernierMsg) {
        o.statut = 'encours'; actif = o; this._maj(o, 'statut');
      } else { o.statut = 'interrompu'; this._maj(o, 'statut'); }
    }
    if (actif) this._definirActivite(this._texteActivite(actif));
    this._flux = Object.create(null);
    this.jetons = { entree: 0, sortie: 0, cacheLu: 0, cacheEcrit: 0, cout: 0 };
    for (var id in usages) this._compterJetons(usages[id]);
    sansId.forEach(function (u) { self._compterJetons(u); });
    if (n) this._ajouter({ genre: 'separateur', texte: this._repriseTour ? 'Page rechargée, Claude continue' : 'Reprise de la session', historique: true });
    this.emit('historique', n);
    // Questions et permissions encore en attente dans le processus (⌘R), après l'historique pour retrouver leur outil.
    var attente = this._repriseEnAttente;
    this._repriseEnAttente = null;
    this._repriseTour = false;
    if (attente) attente.forEach(function (l) { self.recevoirLigne(l); });
    this._calculerEtat();
    // Après l'historique (reprise ou ⌘R) : initialize tout de suite, pour retrouver une question restée
    // en attente dans le processus (la coque garde la ligne si claude n'est pas encore lancé).
    if (!this._initDemande && !this.dansTerminal) { this._initDemande = true; this._demanderInitialize(); }
  };

  /* ================= État ================= */

  Session.prototype._dernierTexte = function () {
    for (var i = this.items.length - 1; i >= 0; i--) {
      var it = this.items[i];
      if (it.genre === 'texte' && !it.parent && it.texte && it.texte.trim()) return it.texte;
      if (it.genre === 'eliot') return '';
    }
    return '';
  };

  Session.prototype._calculerEtat = function () {
    var etat, resume;
    var attente = this.questionsEnAttente();
    if (this.termine) { etat = 'termine'; resume = this.dansTerminal ? 'Partie dans le Terminal' : 'Session terminée'; }
    else if (attente.length) { etat = 'attend'; resume = this.texteQuestion(attente[0]); }
    else if (this.travaille) { etat = 'travaille'; resume = this.activite || 'Claude travaille'; }
    else { etat = 'pret'; resume = BT.texteResume(this._dernierTexte(), 160) || 'Prêt'; }
    var change = etat !== this.etat;
    this.etat = etat;
    this.resume = resume;
    if (change) {
      this.emit('etat', etat, resume);
      this._envoyer('etat', { etat: etat, resume: BT.tronquer(resume, 200) });
    }
  };
})();
