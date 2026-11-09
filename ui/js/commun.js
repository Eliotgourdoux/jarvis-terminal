/* Better Terminal For Claude — utilitaires partagés.
 * Aucun accès au DOM ici : ces fonctions servent aussi à la logique de session
 * (et plus tard au mode vocal). */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  /* ---------- Texte venant de Claude ---------- */

  var RE_ANSI = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
  var RE_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
  // Bandeau ajouté par le hook MessageDisplay d'Eliot : « ━━━ Claude 12:07 ━━━━… »
  var RE_BANDEAU = /^\s*━{2,}[ \t]*Claude\b[^\n]*(?:\n|$)/;
  // Filet « ────── » ajouté par le même hook juste avant la ligne ✅
  var RE_FILET_RESUME = /\n[ \t]*─{6,}[ \t]*\n+(?=[ \t]*✅)/g;

  BT.sansAnsi = function (t) {
    return String(t == null ? '' : t).replace(RE_OSC, '').replace(RE_ANSI, '').replace(/\u001b/g, '');
  };

  /* Mode vocal : la réponse finale de Claude commence par <vocal>…</vocal> (ce que Jarvis dit à voix haute),
   * suivi des seuls éléments visuels (aperçus, schémas, code à copier, liens, médias, tableaux).
   * Le bloc n'est jamais affiché dans le texte ; pendant l'écriture, une balise ouverte masque la suite. */
  var RE_VOCAL = /<vocal>([\s\S]*?)(?:<\/vocal>|$)/i;
  var RE_VOCAL_FERME = /<vocal>([\s\S]*?)<\/vocal>/i;
  var RE_VOCAL_TOUS = /\n*[ \t]*<vocal>[\s\S]*?(?:<\/vocal>[ \t]*|$)/gi;
  var RE_VOCAL_DEBUT = /\n*[ \t]*<v(?:o(?:c(?:a(?:l)?)?)?)?$/i; // balise en cours d'écriture
  BT.texteVocal = function (t) {
    var m = RE_VOCAL.exec(String(t == null ? '' : t));
    return m ? m[1].trim() : '';
  };
  /* Texte du bloc <vocal> seulement s'il est fermé (pendant l'écriture : '' tant que </vocal> n'est pas là). */
  BT.texteVocalFerme = function (t) {
    var m = RE_VOCAL_FERME.exec(String(t == null ? '' : t));
    return m ? m[1].trim() : '';
  };
  /* Repères d'animation [[n]] dans le bloc <vocal> : jamais dits ni affichés ; la coque déclenche l'étape n
   * de l'aperçu du tour quand la voix arrive au segment n (CONTRAT.md, « Animations au rythme de la voix »). */
  var RE_REPERE = /\[\[\s*\d{1,3}\s*\]\]/;
  var RE_REPERES = /[ \t]*\[\[\s*\d{1,3}\s*\]\][ \t]*/g;
  BT.aReperes = function (t) { return RE_REPERE.test(String(t == null ? '' : t)); };
  BT.sansReperes = function (t) {
    return String(t == null ? '' : t).replace(RE_REPERES, ' ').replace(/ {2,}/g, ' ').replace(/ ([.,;:!?])/g, '$1').trim();
  };
  BT.aBlocVocal = function (t) { return /<vocal>/i.test(String(t == null ? '' : t)); };
  BT.sansVocal = function (t) {
    return String(t == null ? '' : t).replace(RE_VOCAL_TOUS, '').replace(RE_VOCAL_DEBUT, '');
  };

  /* Consigne ajoutée aux messages envoyés quand le mode vocal est actif (invisible dans le fil).
   * Elle part avec chaque message : elle doit rester courte. */
  var RE_CONSIGNE_VOCALE = /\n*<mode-vocal>[\s\S]*?<\/mode-vocal>\s*/g;
  BT.CONSIGNE_VOCALE = '<mode-vocal>Mode vocal Jarvis : Eliot t’écoute, ta voix est ta réponse et l’écran ne fait que l’illustrer. '
    + 'Fais le travail normalement. Ta réponse finale commence par un seul bloc <vocal>…</vocal>, lu à voix haute dès sa fermeture : '
    + 'ce que tu lui dis à l’oral, une à trois phrases courtes qui se comprennent seules (le sujet, le résultat, la question à trancher), '
    + 'tutoiement, français parlé, sans markdown, chemin, code ni emoji. '
    + 'Ensuite, uniquement ce qui aide à l’écran : bloc ```html apercu (animation ou schéma léger, autonome, rapide à écrire), '
    + 'mermaid ou svg, commande ou code à copier dans un bloc de code, lien, chemin d’image ou de vidéo, tableau si c’est vraiment plus clair. '
    + 'Aucune prose qui répète la voix : le texte hors de ces éléments n’est pas affiché. Si rien de visuel n’aide, n’écris rien d’autre. '
    + 'La voix peut renvoyer à l’écran (« je te mets la commande »). '
    + 'Pour animer au rythme de ta voix, place des repères [[1]], [[2]]… dans le bloc vocal (jamais dits) et, dans l’aperçu, '
    + '<script>jarvis.etape(n => document.body.dataset.etape = n)</script> : l’étape n arrive quand ta voix atteint [[n]], l’étape 0 au départ, et chaque étape montre l’état complet. '
    + 'Pour un schéma qui reste affiché d’un message à l’autre, écris ```html apercu scene=nom``` ; ensuite, renvoie le même nom pour le remplacer, '
    + 'ou un bloc ```jarvis scene=nom``` (JS ou JSON reçu par jarvis.recevoir(d => …)) pour le modifier sur place. '
    + 'Animations légères en CSS, rapides à écrire, sans boucle. Termine quand même par la ligne ✅, elle sera masquée.</mode-vocal>';
  BT.aConsigneVocale = function (t) { return /<mode-vocal>[\s\S]*?<\/mode-vocal>/.test(String(t == null ? '' : t)); };
  BT.sansConsigneVocale = function (t) {
    return String(t == null ? '' : t).replace(RE_CONSIGNE_VOCALE, '\n').trim();
  };

  BT.nettoyerTexteClaude = function (t) {
    var s = BT.sansVocal(BT.sansAnsi(t));
    s = s.replace(RE_BANDEAU, '');
    s = s.replace(RE_FILET_RESUME, '\n\n');
    return s.replace(/^\s*\n/, '').replace(/\s+$/, '');
  };

  /* Texte brut court tiré d'un markdown (résumés, bannières, état). */
  BT.texteResume = function (md, n) {
    var s = BT.nettoyerTexteClaude(md)
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
      .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
      .replace(/\|/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return BT.tronquer(s, n || 160);
  };

  BT.tronquer = function (t, n) {
    t = String(t == null ? '' : t);
    return t.length > n ? t.slice(0, Math.max(0, n - 1)).replace(/\s+$/, '') + '…' : t;
  };

  BT.premiereLigne = function (t) {
    t = String(t == null ? '' : t).replace(/^\s+/, '');
    var i = t.indexOf('\n');
    return i >= 0 ? t.slice(0, i) : t;
  };

  BT.basename = function (p) {
    p = String(p == null ? '' : p).replace(/\/+$/, '');
    var i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
  };

  BT.extension = function (p) {
    var b = BT.basename(p);
    var i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i + 1).toLowerCase() : b.toLowerCase();
  };

  /* Langage highlight.js déduit d'un nom de fichier. */
  var LANGAGES = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', swift: 'swift',
    sh: 'bash', zsh: 'bash', bash: 'bash', command: 'bash', json: 'json', jsonl: 'json',
    md: 'markdown', markdown: 'markdown', html: 'xml', htm: 'xml', xml: 'xml', plist: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', less: 'less', yml: 'yaml', yaml: 'yaml', rs: 'rust', go: 'go',
    rb: 'ruby', java: 'java', kt: 'kotlin', kts: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
    hpp: 'cpp', m: 'objectivec', mm: 'objectivec', sql: 'sql', php: 'php', lua: 'lua',
    toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', diff: 'diff', patch: 'diff',
    makefile: 'makefile', mk: 'makefile', r: 'r', pl: 'perl', cs: 'csharp', graphql: 'graphql',
    qss: 'css'
  };
  BT.langageFichier = function (p) { return LANGAGES[BT.extension(p)] || ''; };

  /* ---------- Dates et durées ---------- */

  function deux(n) { return (n < 10 ? '0' : '') + n; }

  BT.heure = function (d) {
    d = d instanceof Date ? d : new Date(d);
    if (isNaN(d.getTime())) return '';
    return deux(d.getHours()) + ':' + deux(d.getMinutes());
  };

  BT.dureeLisible = function (ms) {
    if (ms == null || isNaN(ms) || ms < 0) return '';
    var s = Math.round(ms / 1000);
    if (s < 1) return 'moins d’1 s';
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return m + ' min' + (s ? ' ' + deux(s) : '');
    var h = Math.floor(m / 60);
    return h + ' h ' + deux(m % 60);
  };

  /* ---------- Identifiants ---------- */

  var ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
  BT.idCourt = function () {
    var s = '', r = new Uint32Array(8);
    (window.crypto || window.msCrypto).getRandomValues(r);
    for (var i = 0; i < 8; i++) s += ALPHABET[r[i] % ALPHABET.length];
    return s;
  };

  /* uuid v4 : identifiant des messages d'Eliot, écrit sur la ligne stdin (claude le garde dans le transcript,
   * et rewind_conversation le reconnaît). */
  BT.uuid = function () {
    var c = window.crypto || window.msCrypto;
    if (c.randomUUID) return c.randomUUID();
    var b = new Uint8Array(16); c.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  };

  /* ---------- Résumé d'un appel d'outil (ligne compacte) ---------- */

  function premiereChaine(o) {
    if (!o || typeof o !== 'object') return '';
    for (var k in o) {
      if (typeof o[k] === 'string' && o[k].trim()) return o[k];
    }
    return '';
  }

  function hote(url) {
    var m = /^[a-z]+:\/\/([^/?#]+)([^?#]*)/i.exec(String(url || ''));
    return m ? m[1] + (m[2] && m[2] !== '/' ? m[2] : '') : String(url || '');
  }

  /* Renvoie { nom, cible, mono } : « Read » + « Data.swift », « Bash » + « ls -la »… */
  BT.resumeOutil = function (nom, entree) {
    var e = entree || {};
    var n = String(nom || 'Outil');
    var cible = '', mono = false, affiche = n;
    var mcp = /^mcp__(.+?)__(.+)$/.exec(n);
    if (mcp) {
      affiche = mcp[1].replace(/[_-]+/g, ' ') + ' · ' + mcp[2].replace(/_/g, ' ');
      cible = premiereChaine(e);
      return { nom: affiche, cible: BT.tronquer(BT.premiereLigne(cible), 90), mono: false };
    }
    switch (n) {
      case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': case 'NotebookRead':
        cible = BT.basename(e.file_path || e.notebook_path || e.path || '');
        if (n === 'Read' && (e.offset || e.limit)) {
          var a = e.offset || 1;
          cible += ' · lignes ' + a + (e.limit ? '–' + (a + e.limit - 1) : '+');
        }
        mono = true; break;
      case 'Bash': case 'PowerShell':
        cible = BT.premiereLigne(e.command || ''); mono = true; break;
      case 'Glob':
        cible = e.pattern || ''; mono = true; break;
      case 'Grep':
        cible = (e.pattern ? '« ' + e.pattern + ' »' : '') + (e.path ? ' dans ' + BT.basename(e.path) : ''); break;
      case 'WebFetch':
        cible = hote(e.url); break;
      case 'WebSearch':
        cible = e.query || ''; break;
      case 'Task': case 'Agent':
        cible = e.description || e.subagent_type || ''; break;
      case 'TodoWrite':
        var t = Array.isArray(e.todos) ? e.todos : [];
        var faites = t.filter(function (x) { return x && x.status === 'completed'; }).length;
        cible = t.length ? faites + ' sur ' + t.length + ' faites' : ''; break;
      case 'TaskCreate': case 'TaskUpdate': case 'TaskGet':
        cible = e.subject || e.title || e.taskId || e.id || ''; break;
      case 'Skill':
        cible = e.skill || e.command || e.name || ''; break;
      case 'AskUserQuestion':
        affiche = 'Question';
        cible = (e.questions && e.questions[0] && e.questions[0].question) || ''; break;
      case 'ExitPlanMode':
        affiche = 'Plan'; cible = BT.texteResume(e.plan || '', 80); break;
      case 'ToolSearch':
        cible = e.query || ''; break;
      default:
        cible = premiereChaine(e);
    }
    return { nom: affiche, cible: BT.tronquer(BT.premiereLigne(cible), 90), mono: mono };
  };

  /* Aperçu d'un JSON partiel (input_json_delta) : on extrait les champs utiles au résumé. */
  BT.apercuJsonPartiel = function (s) {
    var o = {};
    var re = /"(file_path|notebook_path|path|command|pattern|url|query|description|skill|subject)"\s*:\s*"((?:[^"\\]|\\.)*)/g, m;
    while ((m = re.exec(s))) {
      if (o[m[1]] !== undefined) continue;
      try { o[m[1]] = JSON.parse('"' + m[2].replace(/\\$/, '') + '"'); } catch (e) { o[m[1]] = m[2]; }
    }
    return o;
  };

  /* ---------- Petit émetteur d'événements ---------- */

  BT.Emetteur = function () { this._ecouteurs = {}; };
  BT.Emetteur.prototype.on = function (nom, fn) {
    (this._ecouteurs[nom] = this._ecouteurs[nom] || []).push(fn);
    return this;
  };
  BT.Emetteur.prototype.off = function (nom, fn) {
    var l = this._ecouteurs[nom]; if (!l) return this;
    var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    return this;
  };
  BT.Emetteur.prototype.emit = function (nom) {
    var l = this._ecouteurs[nom]; if (!l) return;
    var args = Array.prototype.slice.call(arguments, 1);
    l.slice().forEach(function (fn) {
      try { fn.apply(null, args); } catch (e) { console.error('[BT]', nom, e); }
    });
  };

  BT.etendre = function (cible) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i]; if (!s) continue;
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) cible[k] = s[k];
    }
    return cible;
  };
})();
