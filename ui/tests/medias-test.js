/* Banc du lecteur intégré. Paramètre ?dossier=<dossier de médias de test> (fichiers générés par le banc Swift).
 * Rend des messages markdown qui citent ces fichiers, puis window.bilanMedias() renvoie l'état de chaque lecteur. */
(function () {
  'use strict';
  var BT = window.BT;
  var d = new URLSearchParams(location.search).get('dossier') || '/tmp/btm';
  var messages = [
    'Voici le rendu : ' + d + '/image.png et la vidéo `' + d + '/video.mp4`.',
    'Le son : ' + d + '/son.mp3, puis [la version m4a](' + d + '/son.m4a) et file://' + d + '/son.wav.',
    'Avec espace : `' + d + '/clip avec espace.mov` · GIF figé : ' + d + '/anim.gif · ' + d + '/clip.webm',
    'Formats rares : ' + d + '/vocal.ogg ' + d + '/vocal.opus ' + d + '/son.flac',
    'Refusés : ' + d + '/piege.png ' + d + '/dossier.png ' + d + '/absent.png ' + d + '/tube.mp3 et ~/.btm-test-maison.png',
    '```\n' + d + '/image.png (dans un bloc de code : ignoré)\n```\nhttps://exemple.fr/x.png (URL : ignorée)'
  ];
  var fil = document.getElementById('fil');
  messages.forEach(function (m) {
    var n = document.createElement('div');
    n.className = 'bloc-texte md';
    var frag = BT.rendreMarkdown(m);
    var lec = BT.medias.pour(frag);
    if (lec) frag.appendChild(lec);
    n.appendChild(frag);
    fil.appendChild(n);
  });
  window.bilanMedias = function () {
    return Array.prototype.map.call(document.querySelectorAll('.media'), function (b) {
      var r = { chemin: (b.dataset.chemin || '').replace(d, '…'), classe: b.className };
      var img = b.querySelector('img'), v = b.querySelector('video, audio'), c = b.querySelector('canvas');
      if (img) r.image = img.complete ? img.naturalWidth + 'x' + img.naturalHeight : 'en cours';
      if (c) r.gifFige = c.width + 'x' + c.height;
      if (v) r.media = { pret: v.readyState, duree: Math.round(v.duration * 10) / 10, l: v.videoWidth || 0, auto: v.autoplay, boucle: v.loop, pause: v.paused, erreur: v.error && v.error.code };
      if (b.classList.contains('media-repli')) r.repli = b.textContent;
      return r;
    });
  };
})();
