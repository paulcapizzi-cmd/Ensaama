// look-audio : un son se joue (avec fondu d'entrée et de sortie) quand on regarde cette entité.
// À mettre sur l'entité qui est au centre de l'écran (par exemple celle qui porte fake-sphere / fake-room),
// ou sur une entité vide placée au centre de l'écran.
//
//   <a-entity fake-sphere="..." look-audio="src: #bruit; angle: 20; fadeIn: 1.5; fadeOut: 2"></a-entity>
AFRAME.registerComponent('look-audio', {
  schema: {
    src:      { type: 'string' },        // "#id" d'un <audio> ou <a-asset-item> dans <a-assets>, ou une URL
    angle:    { default: 20 },           // demi-angle (degrés) du cône de regard : en dessous, on "regarde" l'écran
    distance: { default: 0 },            // distance max (0 = illimitée) : au-delà, le son ne se déclenche pas
    fadeIn:   { default: 1.5 },          // durée du fondu d'entrée (secondes)
    fadeOut:  { default: 1.5 },          // durée du fondu de sortie (secondes)
    volume:   { default: 1 },            // volume maximal (0 à 1)
    loop:     { default: true },
    restart:  { default: false },        // true : repart du début à chaque fois ; false : reprend où il s'était arrêté
    activeFrom:  { default: 0 },         // le son ne peut se déclencher qu'à partir de ce moment (millisecondes après le chargement de la scène)
    activeUntil: { default: 0 },         // et plus après ce moment (millisecondes, 0 = jamais) ; un son en cours s'éteint en fondu
    debug:    { default: false }         // affiche dans la console quand le son commence / s'arrête
  },

  init: function () {
    this.level = 0;                      // niveau actuel du fondu, de 0 à 1
    this.looking = false;
    this.wantPlay = false;
    this.blocked = false;
    this.audio = null;
    this.camPos = new THREE.Vector3();
    this.camDir = new THREE.Vector3();
    this.tPos = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.setupAudio();

    // les navigateurs bloquent le son avant un premier geste de l'utilisateur : on réessaie à chaque geste
    this.unlock = () => { if (this.blocked) this.tryPlay(); };
    ['pointerdown', 'keydown', 'touchstart', 'click'].forEach(e => window.addEventListener(e, this.unlock));
    this.el.sceneEl.addEventListener('enter-vr', this.unlock);
  },

  setupAudio: function () {
    const d = this.data;
    let url = d.src;
    if (!url) return;
    if (url.charAt(0) === '#') {
      const el = document.querySelector(url);
      if (!el) { console.warn('[look-audio] élément introuvable :', url); return; }
      url = el.getAttribute('src') || el.src;
    }
    // un lecteur par composant : plusieurs écrans peuvent utiliser le même fichier sans se gêner
    this.audio = new Audio(url);
    this.audio.preload = 'auto';
    this.audio.loop = d.loop;
    this.audio.volume = 0;
  },

  update: function (old) {
    if (!this.audio) return;
    this.audio.loop = this.data.loop;
    if (old.src !== undefined && old.src !== this.data.src) {
      this.audio.pause(); this.level = 0; this.wantPlay = false;
      this.setupAudio();
    }
  },

  tryPlay: function () {
    if (!this.audio) return;
    const p = this.audio.play();
    if (p && p.then) {
      p.then(() => { this.blocked = false; })
       .catch(() => { this.blocked = true; });   // pas encore de geste : on retentera
    }
  },

  tick: function (time, dt) {
    const cam = this.el.sceneEl.camera;
    if (!cam || !this.audio) return;
    dt = Math.min(dt || 16, 200) / 1000;
    const d = this.data;
    if (this.t0 === undefined) this.t0 = time;          // le temps compte à partir du premier affichage de la scène
    const elapsed = time - this.t0;
    const active = elapsed >= d.activeFrom && (d.activeUntil <= 0 || elapsed < d.activeUntil);

    // regarde-t-on l'écran ? angle entre la direction du regard et la direction de l'écran
    cam.getWorldPosition(this.camPos);
    cam.getWorldQuaternion(this.q);
    this.camDir.set(0, 0, -1).applyQuaternion(this.q);
    this.el.object3D.getWorldPosition(this.tPos).sub(this.camPos);
    const dist = this.tPos.length();
    const ang = THREE.MathUtils.radToDeg(this.camDir.angleTo(this.tPos.normalize()));
    // petite marge (hystérésis) pour que le son ne papillonne pas au bord du cône
    const limit = this.looking ? d.angle * 1.15 : d.angle;
    const near = d.distance <= 0 || dist <= d.distance;
    const looking = ang <= limit && near && active;
    if (looking !== this.looking) {
      this.looking = looking;
      if (d.debug) console.info('[look-audio] ' + (looking ? 'regard sur l\'écran' : 'regard détourné') + ' (angle ' + ang.toFixed(1) + '°)');
    }

    // fondu
    if (looking) {
      this.level = Math.min(1, this.level + dt / Math.max(d.fadeIn, 0.001));
    } else {
      this.level = Math.max(0, this.level - dt / Math.max(d.fadeOut, 0.001));
    }

    if (this.level > 0 && !this.wantPlay) {
      this.wantPlay = true;
      if (d.restart) this.audio.currentTime = 0;
      this.tryPlay();
    }
    // le volume suit le carré du niveau : le fondu paraît plus régulier à l'oreille
    this.audio.volume = THREE.MathUtils.clamp(this.level * this.level * d.volume, 0, 1);
    if (this.level === 0 && this.wantPlay) {
      this.wantPlay = false;
      this.audio.pause();
    }
  },

  remove: function () {
    ['pointerdown', 'keydown', 'touchstart', 'click'].forEach(e => window.removeEventListener(e, this.unlock));
    this.el.sceneEl.removeEventListener('enter-vr', this.unlock);
    if (this.audio) { this.audio.pause(); this.audio = null; }
  }
});
