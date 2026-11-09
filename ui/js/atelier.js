/* Better Terminal For Claude — la mascotte et le récap des actions (demandes d'Eliot, 08/11/2026).
 *
 * 1. Le récap : chaque tour de Claude a UNE ligne discrète sous son en-tête (« Lu 3 fichiers, 2 commandes · 25 s »),
 *    dépliable pour voir le détail. Le texte de Claude n'est plus coupé par des panneaux d'outils.
 * 2. La mascotte : une seule, en bas du fil. Pendant le travail, elle tend une tentacule vers chaque chose qu'elle
 *    touche, l'une après l'autre (le vrai nom du fichier, de la commande, de la recherche est écrit dessous).
 *    Quand Claude a fini, elle se met à l'écoute. Elle suit les événements de la Session, comme toute autre vue.
 * Animations en boucle seulement pour elle, rien sous « réduire les animations ». */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var el = BT.el;
  var NS = 'http://www.w3.org/2000/svg';

  function svg(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  var LIT = { Read: 1, NotebookRead: 1 };
  var MODIFIE = { Edit: 1, MultiEdit: 1, Write: 1, NotebookEdit: 1 };
  var COMMANDE = { Bash: 1, PowerShell: 1 };
  var CHERCHE = { Grep: 1, Glob: 1, ToolSearch: 1 };
  var WEB = { WebFetch: 1, WebSearch: 1 };
  var AGENT = { Task: 1, Agent: 1 };

  function pluriel(n, mot, mots) { return n + ' ' + (n > 1 ? mots : mot); }
  function majuscule(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
  function entreeDe(it) { return it.entree || it.entreeApercu || {}; }

  /* ================= Récap d'un tour ================= */

  BT.atelierResume = function () {
    return el('summary', 'atelier', [
      el('span', 'atelier-texte', [el('span', 'atelier-phrase'), el('span', 'atelier-detail')]),
      el('span', 'chevron')
    ]);
  };

  function bilan(outils) {
    var lus = new Set(), modifies = new Set(), cmd = 0, rech = 0, web = 0, agents = 0, autres = 0;
    outils.forEach(function (o) {
      var e = o.entree || {}, f = e.file_path || e.notebook_path || e.path || o.id;
      if (LIT[o.nom]) lus.add(f);
      else if (MODIFIE[o.nom]) modifies.add(f);
      else if (COMMANDE[o.nom]) cmd++;
      else if (CHERCHE[o.nom]) rech++;
      else if (WEB[o.nom]) web++;
      else if (AGENT[o.nom]) agents++;
      else autres++;
    });
    var p = [];
    if (lus.size) p.push('lu ' + pluriel(lus.size, 'fichier', 'fichiers'));
    if (modifies.size) p.push('modifié ' + pluriel(modifies.size, 'fichier', 'fichiers'));
    if (cmd) p.push(pluriel(cmd, 'commande', 'commandes'));
    if (rech) p.push(pluriel(rech, 'recherche', 'recherches'));
    if (web) p.push(pluriel(web, 'page web', 'pages web'));
    if (agents) p.push(pluriel(agents, 'agent', 'agents'));
    if (autres) p.push(pluriel(autres, 'autre action', 'autres actions'));
    return majuscule(p.join(', '));
  }

  /* items : [{ it, etat: 'encours'|'ok'|'erreur'|'attend'|'interrompu' }] */
  BT.majAtelier = function (groupe, items) {
    var sum = groupe.firstElementChild;
    var phrase = sum.querySelector('.atelier-phrase'), detail = sum.querySelector('.atelier-detail');
    var outils = items.filter(function (x) { return x.it.genre === 'outil'; });
    var encours = false, erreurs = 0, debut = 0, fin = 0;
    items.forEach(function (x) {
      if (x.etat === 'encours' || x.etat === 'attend') encours = true;
      if (x.etat === 'erreur' && x.it.genre === 'outil') erreurs++;
      if (x.it.debut && (!debut || x.it.debut < debut)) debut = x.it.debut;
      if (x.it.fin && x.it.fin > fin) fin = x.it.fin;
    });
    groupe.className = 'activite' + (encours ? ' en-cours' : '') + (erreurs ? ' avec-erreur' : '');
    phrase.textContent = outils.length ? bilan(outils.map(function (x) { return x.it; })) : 'Réflexion';
    var d = [];
    if (!encours && fin && debut && fin - debut >= 1000) d.push(BT.dureeLisible(fin - debut));
    if (erreurs) d.push(pluriel(erreurs, 'erreur', 'erreurs'));
    detail.textContent = d.length ? ' · ' + d.join(' · ') : '';
    sum.title = 'Afficher le détail des actions';
  };

  /* ================= La mascotte (marge de gauche) ================= */
  /* Une colonne fixe entre la liste des sessions et le texte : la mascotte en bas, au-dessus d'elle la pile
   * des choses touchées pendant le tour (icône + vrai nom). Une tentacule part de son bras, longe le bord
   * et va se poser sur l'icône qu'elle touche. Les tracés sont calculés sur la mise en page réelle. */

  var NB = 6;

  /* Icônes des lignes (22 × 26), dessinées en traits. */
  var ICONES = {
    fichier: '<path d="M3 2 h11 l6 6 v16 h-17 z" class="mi-fond"/><path d="M14 2 v6 h6" class="mi-trait"/><path d="M7 13 h8 M7 17 h8 M7 21 h5" class="mi-trait"/>',
    commande: '<rect x="1" y="4" width="20" height="18" rx="3" class="mi-fond"/><path d="M5 10 l4 3 l-4 3 M11 17 h6" class="mi-trait"/>',
    recherche: '<circle cx="9.5" cy="11" r="6" class="mi-fond"/><path d="M14 15.5 l5.5 5.5" class="mi-trait epais"/>',
    web: '<circle cx="11" cy="13" r="9" class="mi-fond"/><path d="M2 13 h18 M11 4 c-5 5 -5 13 0 18 M11 4 c5 5 5 13 0 18" class="mi-trait"/>',
    agent: '<rect x="3" y="6" width="16" height="13" class="mi-fond"/><path d="M8 10 v4 M14 10 v4 M5 19 v3 M17 19 v3" class="mi-trait epais"/>',
    autre: '<rect x="3" y="5" width="16" height="16" rx="8" class="mi-fond"/><path d="M8 13 h6 M11 10 v6" class="mi-trait"/>'
  };

  function typeDe(it) {
    var n = it.nom;
    if (LIT[n] || MODIFIE[n]) return 'fichier';
    if (COMMANDE[n]) return 'commande';
    if (CHERCHE[n] || n === 'WebSearch') return 'recherche';
    if (n === 'WebFetch') return 'web';
    if (AGENT[n]) return 'agent';
    return 'autre';
  }

  /* Le nom écrit sous la case : le fichier, la commande, le motif cherché… */
  function nomDe(it) {
    var e = entreeDe(it), n = it.nom;
    if (LIT[n] || MODIFIE[n]) return BT.basename(e.file_path || e.notebook_path || e.path || '') || n;
    if (COMMANDE[n]) return BT.premiereLigne(e.command || '').replace(/^(\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, '').trim() || 'commande';
    if (n === 'Grep' || n === 'Glob') return e.pattern || n;
    if (n === 'WebSearch' || n === 'ToolSearch') return e.query || 'recherche';
    if (AGENT[n]) return e.description || e.subagent_type || 'agent';
    var r = BT.resumeOutil(n, e);
    return r.cible || r.nom;
  }

  /* ================= Le répertoire d'animations ================= */
  /* Chaque outil a son accessoire (clavier, loupe, feuille, globe…), chaque moment de la session a sa
   * posture (réfléchit, parle, attend, dort…), et quelques réactions brèves (« flashs ») marquent les
   * événements : erreur, fin de tour réussie, interruption, nouveau message d'Eliot. Tout est en CSS :
   * le JS ne fait que poser des classes sur la racine. */

  var VB = { x: -4, y: -16, l: 76, h: 60 };
  var COMMANDE_LONGUE = 8000;      // au-delà, la mascotte lâche le clavier et regarde le sablier
  var DODO = 3 * 60 * 1000;        // à l'écoute depuis 3 min : elle s'assoupit
  var CONCENTRE = 12000, CONCENTRE_FORT = 35000;   // réflexion longue : la tête gonfle, puis elle fume
  var LISTE = { TodoWrite: 1, TaskCreate: 1, TaskUpdate: 1, TaskList: 1, ExitPlanMode: 1 };

  function animDe(it) {
    var n = it.nom;
    if (LIT[n]) return 'lire';
    if (n === 'Write') return 'ecrire';
    if (MODIFIE[n]) return 'modifier';
    if (COMMANDE[n]) return 'clavier';
    if (n === 'Grep') return 'grep';
    if (n === 'Glob') return 'glob';
    if (n === 'WebSearch') return 'websearch';
    if (n === 'ToolSearch') return 'loupe';
    if (n === 'WebFetch') return 'globe';
    if (AGENT[n] || n === 'Workflow') return 'bebe';
    if (LISTE[n]) return 'liste';
    if (n === 'Skill') return 'livre';
    return 'cle';
  }

  function phraseDe(it) {
    var n = it.nom;
    if (LIT[n]) return 'Lit';
    if (n === 'Write') return 'Écrit';
    if (MODIFIE[n]) return 'Modifie';
    if (COMMANDE[n]) return 'Lance une commande';
    if (n === 'Grep' || n === 'Glob') return 'Cherche dans le projet';
    if (n === 'WebSearch') return 'Cherche sur le web';
    if (n === 'ToolSearch') return 'Cherche un outil';
    if (n === 'WebFetch') return 'Lit une page web';
    if (AGENT[n] || n === 'Workflow') return 'Confie une tâche à un agent';
    if (LISTE[n]) return 'Met à jour sa liste';
    if (n === 'Skill') return 'Ouvre un skill';
    var m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(n);
    if (m) return 'Utilise ' + m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ');
    return BT.resumeOutil(n, entreeDe(it)).nom;
  }

  /* Accessoires, en unités du dessin (corps de la mascotte : x 8→44, y 11→34 ; bras gauche à x 2). */
  function touches() {
    var t = '', i;
    for (i = 0; i < 8; i++) t += '<rect x="' + (15 + i * 5) + '" y="35" width="3.5" height="2.6" rx=".6" class="pr-touche k' + i + '"/>';
    t += '<rect x="17" y="39" width="3.5" height="2.6" rx=".6" class="pr-touche k8"/>';
    t += '<rect x="23" y="39" width="22" height="2.6" rx=".6" class="pr-touche k9"/>';
    t += '<rect x="47.5" y="39" width="3.5" height="2.6" rx=".6" class="pr-touche k10"/>';
    return t;
  }
  function lignes(x, y, n, pas, larg) {
    var t = '';
    for (var i = 0; i < n; i++) t += '<rect x="' + x + '" y="' + (y + i * pas) + '" width="' + larg[i % larg.length] + '" height="1.6" rx=".8" class="pr-ligne l' + i + '"/>';
    return t;
  }
  var ACCESSOIRES =
    '<g class="m-prop p-feuille"><rect x="47" y="4" width="17" height="22" rx="1.5" class="pr-papier"/>' + lignes(50, 8.5, 4, 4.2, [11, 9, 11, 7]) + '</g>' +
    '<g class="m-prop p-dossier"><path d="M46 27 h7 l2 2 h9 v12 h-18 z" class="pr-dossier"/><path d="M46 31 h18" class="pr-trait"/></g>' +
    '<g class="m-prop p-globe"><g class="pr-globe-g"><circle cx="56" cy="13" r="8" class="pr-globe"/>' +
      '<ellipse cx="56" cy="13" rx="4" ry="8" class="pr-meridien"/><path d="M48 13 h16 M49.5 8.5 h13 M49.5 17.5 h13" class="pr-trait"/></g></g>' +
    '<g class="m-prop p-telecharge"><path d="M56 -12 v8 M52.5 -7.5 l3.5 3.5 l3.5 -3.5" class="pr-fleche"/></g>' +
    '<g class="m-prop p-loupe"><g class="pr-loupe-g"><circle cx="55" cy="12" r="6" class="pr-verre"/><path d="M59.5 16.5 L65 22" class="pr-manche"/></g></g>' +
    '<g class="m-prop p-crayon"><g class="pr-crayon-g"><path d="M59 17 l7 -7 l2.4 2.4 l-7 7 l-3.4 1 z" class="pr-crayon"/><path d="M57.6 20.4 l1 -1" class="pr-trait"/></g></g>' +
    '<g class="m-prop p-liste"><rect x="47" y="3" width="17" height="23" rx="1.5" class="pr-papier"/><rect x="52" y="1.5" width="7" height="3" rx="1" class="pr-clip"/>' +
      [0, 1, 2].map(function (i) {
        var y = 8.5 + i * 5.5;
        return '<rect x="49.5" y="' + y + '" width="3.4" height="3.4" rx=".6" class="pr-case"/>' +
          '<rect x="55" y="' + (y + 1) + '" width="7" height="1.5" rx=".7" class="pr-ligne"/>' +
          '<path d="M50 ' + (y + 1.8) + ' l1.2 1.2 l2.6 -3" pathLength="1" class="pr-coche c' + i + '"/>';
      }).join('') + '</g>' +
    '<g class="m-prop p-livre"><path d="M44 18 l10 -3 v13 l-10 3 z" class="pr-papier"/><path d="M54 15 l10 3 v13 l-10 -3 z" class="pr-papier"/>' +
      '<path d="M54 15 l10 3 v13 l-10 -3 z" class="pr-page"/></g>' +
    '<g class="m-prop p-cle"><g class="pr-cle-g"><path d="M49 24 l9 -9" class="pr-manche"/><path d="M57 9.5 a4 4 0 1 0 5.5 5.5 l-2.5 -0.5 l-0.5 -2.5 z" class="pr-cle-tete"/></g></g>' +
    '<g class="m-prop p-bebe"><g class="pr-bebe-g">' +
      '<rect x="51" y="35.5" width="1.6" height="4" class="m-corps"/><rect x="54" y="35.5" width="1.6" height="4" class="m-corps"/>' +
      '<rect x="60" y="35.5" width="1.6" height="4" class="m-corps"/><rect x="63" y="35.5" width="1.6" height="4" class="m-corps"/>' +
      '<rect x="50" y="27" width="16" height="9" class="m-corps"/><rect x="48" y="30.5" width="3" height="3" class="m-corps"/>' +
      '<rect x="54.5" y="29" width="1.8" height="3.6" class="m-oeil"/><rect x="60" y="29" width="1.8" height="3.6" class="m-oeil"/></g></g>' +
    '<g class="m-prop p-clavier"><rect x="12" y="33" width="44" height="10.5" rx="2" class="pr-clavier"/>' + touches() + '</g>' +
    '<g class="m-prop p-sablier"><g class="pr-sablier-g"><path d="M51 -14 h10 M51 2 h10 M52 -14 c0 5 4 5 4 8 c0 3 -4 3 -4 8 M60 -14 c0 5 -4 5 -4 8 c0 3 4 3 4 8" class="pr-sablier"/>' +
      '<path d="M53.5 -12 h5 l-2.5 4 z" class="pr-sable"/><path d="M56 -2 l3 3 h-6 z" class="pr-sable"/></g></g>' +
    '<g class="m-prop p-pense"><circle cx="45.5" cy="7" r="1.3" class="pr-bulle"/><circle cx="49" cy="2" r="2" class="pr-bulle"/>' +
      '<ellipse cx="59" cy="-7" rx="10" ry="6.5" class="pr-bulle"/>' +
      '<circle cx="55" cy="-7" r="1.3" class="pr-point d0"/><circle cx="59" cy="-7" r="1.3" class="pr-point d1"/><circle cx="63" cy="-7" r="1.3" class="pr-point d2"/></g>' +
    '<g class="m-prop p-parle"><path d="M47 -15 h20 a2 2 0 0 1 2 2 v9 a2 2 0 0 1 -2 2 h-13 l-4 4 v-4 h-3 a2 2 0 0 1 -2 -2 v-9 a2 2 0 0 1 2 -2 z" class="pr-bulle"/>' +
      lignes(50, -11.5, 2, 4, [14, 9]) + '</g>' +
    '<g class="m-prop p-alerte"><rect x="24" y="-14" width="4" height="8" rx="1.2" class="pr-alerte"/><rect x="24" y="-4" width="4" height="3" rx="1.2" class="pr-alerte"/></g>' +
    '<g class="m-prop p-effort"><path d="M38 4 l3 3 M44 3 l-3 3 M38.5 10 l2.5 -2.5 M43.5 10 l-2.5 -2.5" class="pr-effort"/></g>' +
    '<g class="m-prop p-fumee"><circle cx="14" cy="4" r="2.2" class="pr-fumee f0"/><circle cx="26" cy="2" r="2.6" class="pr-fumee f1"/><circle cx="38" cy="4" r="2.2" class="pr-fumee f2"/></g>' +
    '<g class="m-prop p-presse"><path d="M14 -9 l4 4 l4 -4 M30 -9 l4 4 l4 -4" class="pr-presse"/></g>' +
    '<g class="m-prop p-poussiere"><circle cx="3" cy="38" r="2" class="pr-poussiere"/><circle cx="-1" cy="36" r="1.4" class="pr-poussiere"/><circle cx="49" cy="38" r="2" class="pr-poussiere"/><circle cx="53" cy="36" r="1.4" class="pr-poussiere"/></g>' +
    '<g class="m-prop p-zzz"><text x="46" y="5" class="pr-z z0">z</text><text x="52" y="-3" class="pr-z z1">z</text><text x="58" y="-11" class="pr-z z2">Z</text></g>' +
    '<g class="m-prop p-goutte"><path d="M47 3 c0 0 -3 4 -3 6.2 a3 3 0 0 0 6 0 c0 -2.2 -3 -6.2 -3 -6.2 z" class="pr-goutte"/></g>' +
    '<g class="m-prop p-etincelles">' + [[0, 2], [50, 0], [-2, 28], [56, 26]].map(function (p, i) {
      return '<path d="M' + p[0] + ' ' + (p[1] - 3) + ' v6 M' + (p[0] - 3) + ' ' + p[1] + ' h6" class="pr-etincelle e' + i + '"/>';
    }).join('') + '</g>';

  function dessinMascotte() {
    var d = svg('svg', { class: 'm-bete', viewBox: VB.x + ' ' + VB.y + ' ' + VB.l + ' ' + VB.h, width: 78, height: Math.round(78 * VB.h / VB.l) });
    var saut = svg('g', { class: 'm-saut' });
    var g = svg('g', { class: 'm-corps-g' });
    [[10, 33], [16, 33], [32, 33], [38, 33]].forEach(function (p) {
      g.appendChild(svg('rect', { x: p[0], y: p[1], width: 4, height: 8, class: 'm-corps' }));
    });
    g.appendChild(svg('rect', { x: 8, y: 11, width: 36, height: 23, class: 'm-corps' }));
    g.appendChild(svg('rect', { x: 2, y: 20, width: 7, height: 7, class: 'm-corps' }));
    g.appendChild(svg('rect', { x: 43, y: 20, width: 7, height: 7, class: 'm-corps m-bras-d' }));
    var yeux = svg('g', { class: 'm-yeux' });
    yeux.appendChild(svg('rect', { x: 17, y: 16, width: 4, height: 8, class: 'm-oeil' }));
    yeux.appendChild(svg('rect', { x: 31, y: 16, width: 4, height: 8, class: 'm-oeil' }));
    g.appendChild(yeux);
    saut.appendChild(g);
    var props = svg('g', { class: 'm-props' });
    props.innerHTML = ACCESSOIRES;
    saut.appendChild(props);
    d.appendChild(saut);
    return d;
  }

  function Mascotte(session) {
    this.s = session;
    this.cases = [];                   // NB places, la 0 juste au-dessus de la mascotte : { cle, id, it, touche, vu }
    this.parOutil = Object.create(null);
    this.actions = 0;
    this._raf = 0;
    this._flash = null;                // { nom, fin }
    this._depuisEcoute = Date.now();
    this._compaction = false;
    this._signales = Object.create(null);

    this.liens = svg('svg', { class: 'm-liens' });
    this.tentacules = [];
    for (var i = 0; i < NB; i++) {
      var p = svg('path', { pathLength: 1, class: 'm-tentacule' });
      this.liens.appendChild(p);
      this.tentacules.push(p);
    }
    var pile = el('div', 'm-pile');
    this.noeudsCases = [];
    for (i = 0; i < NB; i++) {
      var icone = svg('svg', { class: 'm-icone', viewBox: '0 0 22 26', width: 22, height: 26 });
      var nom = el('span', 'm-nom');
      var c = el('div', 'm-case', [icone, nom]);
      pile.appendChild(c);
      this.noeudsCases.push({ racine: c, icone: icone, nom: nom, type: '' });
    }
    this.bete = dessinMascotte();
    this.phrase = el('div', 'm-phrase');
    this.detail = el('div', 'm-detail');
    this.el = el('aside', 'mascotte etat-ecoute anim-ecoute', [
      this.liens, pile,
      el('div', 'm-bas', [this.bete, this.phrase, this.detail])
    ]);
    this.el.setAttribute('aria-hidden', 'true');

    var self = this;
    session.on('ajout', function (it) { self._evenement(it, true); });
    session.on('maj', function (it) { self._evenement(it, false); });
    session.on('etat', function (etat) {
      var avant = self._etatSession;
      self._etatSession = etat;
      // Nouveau tour : on efface la pile du tour précédent.
      if (etat === 'travaille' && avant !== 'travaille' && avant !== 'attend') {
        self.actions = 0; self.cases = []; self.parOutil = Object.create(null);
      }
      // Fin de tour sans erreur : petit saut de joie.
      if (etat === 'pret' && (avant === 'travaille' || avant === 'attend') && !(self._flash && self._flash.nom !== 'reveil')) self._flasher('succes', 1600);
      self._planifier();
    });
    if (window.ResizeObserver) new ResizeObserver(function () { self._tracer(); }).observe(this.el);
    this._planifier();
  }
  BT.Mascotte = Mascotte;

  Mascotte.prototype._flasher = function (nom, duree) {
    this._flash = { nom: nom, fin: Date.now() + duree };
    this._planifier();
  };

  Mascotte.prototype._evenement = function (it, nouveau) {
    if (it.historique) return;
    if (it.genre === 'eliot') { if (nouveau) this._flasher('reveil', 900); return; }
    if (it.genre === 'compaction') { this._compaction = it.etat === 'encours'; this._planifier(); return; }
    if (it.genre === 'outil') {
      var vivant = it.statut === 'prepare' || it.statut === 'encours';
      if ((it.statut === 'erreur' || it.statut === 'interrompu') && !this._signales[it.id]) {
        this._signales[it.id] = 1;
        if (it.statut === 'erreur') this._flasher('erreur', 1400); else this._flasher('sursaut', 900);
      }
      var c = this.parOutil[it.id];
      if (vivant && !c) {
        var cle = typeDe(it) + ':' + nomDe(it);
        c = this.cases.find(function (x) { return x.it && typeDe(x.it) + ':' + nomDe(x.it) === cle; });
        if (!c) {
          if (this.cases.length >= NB) {
            // place la plus ancienne qui n'est pas en train d'être touchée
            var libre = this.cases.filter(function (x) { return !x.touche; }).sort(function (a, b) { return a.vu - b.vu; })[0];
            c = libre || this.cases.slice().sort(function (a, b) { return a.vu - b.vu; })[0];
          } else { c = {}; this.cases.push(c); }
          c.cle = cle;
        }
        if (c.id && this.parOutil[c.id] === c) delete this.parOutil[c.id];
        c.id = it.id; c.it = it; c.touche = true; c.vu = Date.now();
        this.parOutil[it.id] = c;
        this.actions++;
      } else if (c) {
        c.it = it;
        c.touche = vivant;
        // Le nom arrive parfois après (entrée en flux) : si la chose est déjà dans la pile, on fusionne.
        var cle2 = typeDe(it) + ':' + nomDe(it);
        var meme = this.cases.find(function (x) { return x !== c && x.it && typeDe(x.it) + ':' + nomDe(x.it) === cle2; });
        if (meme) {
          meme.id = it.id; meme.it = it; meme.touche = c.touche; meme.vu = c.vu;
          this.cases.splice(this.cases.indexOf(c), 1);
          this.parOutil[it.id] = c = meme;
        }
        c.cle = cle2;
        if (!vivant) delete this.parOutil[it.id];
      }
    } else if (it.genre !== 'reflexion' && it.genre !== 'texte') return;
    this._planifier();
  };

  Mascotte.prototype._planifier = function () {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () { self._rendre(); });
    this._secours = setTimeout(function () { self._rendre(); }, 250);
  };

  Mascotte.prototype._derniers = function () {
    var reflechit = false, ecrit = false;
    var items = this.s.items || [];
    for (var k = items.length - 1, n = 0; k >= 0 && n < 6; k--, n++) {
      var it = items[k];
      if (it.genre === 'eliot') break;
      if (it.genre === 'reflexion' && it.enCours) reflechit = it;
      if (it.genre === 'texte' && it.enCours) ecrit = true;
    }
    return { reflechit: reflechit, ecrit: ecrit };
  };

  Mascotte.prototype._rendre = function () {
    if (this._raf) cancelAnimationFrame(this._raf);
    clearTimeout(this._secours);
    clearTimeout(this._minuteur);
    this._raf = 0;
    var maintenant = Date.now(), prochain = Infinity;
    var es = this.s.etat || 'pret';
    var touche = null, nbTouches = 0;
    this.cases.forEach(function (c) { if (c.touche) { nbTouches++; if (!touche || c.vu > touche.vu) touche = c; } });

    var etat, anim, phrase = '', detail = '', classes = '';
    if (es === 'termine') { etat = 'fin'; anim = 'dort'; phrase = 'Session terminée'; }
    else if (es === 'attend') { etat = 'attend'; anim = 'alerte'; phrase = 'Attend ta réponse'; }
    else if (es === 'travaille') {
      var d = this._derniers();
      if (this._compaction) { etat = 'travaille'; anim = 'tasse'; phrase = 'Compacte sa mémoire…'; }
      else if (touche) {
        etat = 'touche'; anim = animDe(touche.it); phrase = phraseDe(touche.it);
        if (anim === 'clavier' && touche.it.debut) {
          var ecoule = maintenant - touche.it.debut;
          if (ecoule >= COMMANDE_LONGUE) { classes += ' anim-sablier'; phrase = 'Attend la fin de la commande'; }
          else prochain = Math.min(prochain, COMMANDE_LONGUE - ecoule);
        }
        if (nbTouches > 1) { classes += ' plusieurs'; phrase = 'Fait ' + nbTouches + ' choses à la fois'; }
        // Un agent tourne en même temps (ou c'est lui qui agit) : son petit double reste à côté, quelle que soit
        // la pose principale (clavier, sablier, loupe…). Demande d'Eliot, 09/11/2026.
        if (anim !== 'bebe') {
          var agentActif = !!touche.it.parent || this.cases.some(function (c) { return c.touche && c.it && (AGENT[c.it.nom] || c.it.nom === 'Workflow'); });
          if (agentActif) classes += ' avec-bebe';
        }
      }
      else if (d.reflechit) {
        etat = 'reflechit'; anim = 'pense'; phrase = 'Réfléchit…';
        var pense = d.reflechit.debut ? maintenant - d.reflechit.debut : 0;
        if (pense >= CONCENTRE) {
          anim = 'concentre'; phrase = 'Se concentre…';
          if (pense >= CONCENTRE_FORT) { classes += ' fort'; phrase = 'Se concentre très fort…'; }
          else prochain = Math.min(prochain, CONCENTRE_FORT - pense);
        } else prochain = Math.min(prochain, CONCENTRE - pense);
      }
      else { etat = 'travaille'; anim = d.ecrit ? 'parle' : 'pense'; phrase = d.ecrit ? 'Écrit sa réponse…' : 'Travaille…'; }
    } else {
      etat = 'ecoute'; anim = 'ecoute'; phrase = 'À l’écoute';
      if (this._etatRendu !== 'ecoute') this._depuisEcoute = maintenant;
      var calme = maintenant - this._depuisEcoute;
      if (calme >= DODO) { anim = 'dort'; phrase = 'En veille'; }
      else prochain = Math.min(prochain, DODO - calme);
    }
    this._etatRendu = etat;

    if (this._flash && this._flash.fin > maintenant) {
      classes += ' flash-' + this._flash.nom;
      prochain = Math.min(prochain, this._flash.fin - maintenant);
      if (this._flash.nom === 'succes' && etat === 'ecoute') phrase = 'Terminé';
    } else this._flash = null;

    if (this.actions && etat !== 'fin' && etat !== 'ecoute') detail = pluriel(this.actions, 'action', 'actions');
    if (etat === 'ecoute' || etat === 'fin' || etat === 'attend') {
      this.cases.forEach(function (c) { c.touche = false; });
      this.parOutil = Object.create(null);
    }

    this.el.className = 'mascotte etat-' + etat + ' anim-' + anim + classes;
    this.phrase.textContent = phrase;
    this.detail.textContent = detail;
    if (prochain < Infinity) {
      var self = this;
      this._minuteur = setTimeout(function () { self._planifier(); }, prochain + 30);
    }

    for (var i = 0; i < NB; i++) {
      var n = this.noeudsCases[i], c = this.cases[i];
      var type = c && c.it ? typeDe(c.it) : '';
      if (type !== n.type) { n.type = type; n.icone.innerHTML = type ? ICONES[type] : ''; }
      var nom = c && c.it ? nomDe(c.it) : '';
      if (n.nom.textContent !== nom) n.nom.textContent = nom;
      n.racine.title = nom;
      n.racine.classList.toggle('pleine', !!nom);
      n.racine.classList.toggle('touchee', !!(c && c.touche));
      n.racine.classList.toggle('modif', !!(c && c.it && MODIFIE[c.it.nom]));
      n.racine.classList.toggle('erreur', !!(c && c.it && c.it.statut === 'erreur'));
    }
    this._tracer();
  };

  /* Tentacules : du bras gauche de la mascotte, le long du bord, jusqu'au bord gauche de l'icône touchée. */
  Mascotte.prototype._tracer = function () {
    var boite = this.el.getBoundingClientRect();
    if (!boite.width) return;
    var b = this.bete.getBoundingClientRect(), k = b.width / VB.l;
    var ax = b.left - boite.left + (3 - VB.x) * k, ay = b.top - boite.top + (23.5 - VB.y) * k;
    var voies = 0;
    for (var i = 0; i < NB; i++) {
      var t = this.tentacules[i], c = this.cases[i], n = this.noeudsCases[i];
      var tendue = !!(c && c.touche) && n.racine.offsetParent !== null;
      if (tendue) {
        var r = n.icone.getBoundingClientRect();
        var ix = r.left - boite.left - 2, iy = r.top - boite.top + r.height / 2;
        if (r.bottom < boite.top + 2) tendue = false;   // place coupée en haut (fenêtre trop basse)
        else {
          var x = 3 + (voies++ % 3) * 3, h = Math.min(18, Math.max(6, (ay - iy) / 3));
          t.setAttribute('d', 'M' + ax.toFixed(1) + ' ' + ay.toFixed(1) +
            ' C ' + x + ' ' + ay.toFixed(1) + ', ' + x + ' ' + ay.toFixed(1) + ', ' + x + ' ' + (ay - h).toFixed(1) +
            ' L ' + x + ' ' + (iy + h).toFixed(1) +
            ' C ' + x + ' ' + iy.toFixed(1) + ', ' + x + ' ' + iy.toFixed(1) + ', ' + ix.toFixed(1) + ' ' + iy.toFixed(1));
        }
      }
      t.classList.toggle('tendue', tendue);
    }
  };
})();
