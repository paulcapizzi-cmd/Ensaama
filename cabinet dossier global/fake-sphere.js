// fake-sphere : une ouverture (plan) qui donne sur un panorama sphérique situé derrière.
// Plusieurs entités fake-sphere au même endroit forment des couches : la sphère au plus petit
// rayon est dessinée devant, et ses zones transparentes (PNG) laissent voir les sphères derrière.
//
// Options en plus du panorama :
//  - une lampe (lightEl, lightColor, lightIntensity, lightRange, ambient, flicker...) qui éclaire la sphère,
//  - une brume atmosphérique (hazeAmount, hazeColor, hazeNear, hazeFar) qui teinte l'image avec la distance.
AFRAME.registerComponent('fake-sphere', {
  schema: {
    src:     { type: 'map' },
    width:   { default: 2 },      // taille de l'ouverture
    height:  { default: 1.5 },
    radius:  { default: 30 },     // rayon de la sphère (grand = paysage lointain, peu de parallaxe)
    depth:   { default: 0 },      // distance du centre de la sphère derrière l'ouverture (négatif = devant)
    offsetY: { default: 0 },      // décalage vertical du centre de la sphère (déplace l'horizon)
    hfov:    { default: 360 },    // largeur angulaire couverte par l'image (360 = panorama complet)
    vfov:    { default: 180 },    // hauteur angulaire couverte par l'image (180 = panorama complet)
    yaw:     { default: 0 },      // rotation du panorama en degrés

    // --- lampe (même système que fake-room) ---
    lightEl:        { type: 'string' },                  // sélecteur de l'entité-lampe, ex. "#lampe" : sa position éclaire la sphère
    lightColor:     { type: 'color', default: '#ffffff' },
    lightIntensity: { default: 1.5 },
    lightRange:     { default: 20 },                     // portée de la lampe (dans le repère du plan)
    lightSoftness:  { default: 1 },                      // bord de la lumière : 0 = net (cercle franc), 1 = dégradé jusqu'au centre (défaut)
    ambient:        { default: 0.3 },                    // luminosité de base quand une lampe est utilisée
    flicker:        { default: 0 },                      // vacillement : 0 = aucun, 0.3 = léger, 1 = très fort
    flickerMin:     { default: 0.5 },                    // délai minimum entre deux vacillements (secondes)
    flickerMax:     { default: 4 },                      // délai maximum entre deux vacillements (secondes)

    // --- perspective atmosphérique ---
    hazeAmount:     { default: 0 },                      // 0 = aucune brume, 1 = au loin l'image est remplacée par la couleur de brume
    hazeColor:      { type: 'color', default: '#b4c8e6' },
    hazeNear:       { default: 0 },                      // distance (depuis l'oeil) où la brume commence
    hazeFar:        { default: 100 },                    // distance où elle atteint hazeAmount

    // --- zones transparentes de l'image ---
    backColor:      { type: 'string', default: 'none' }  // 'none' (défaut) : transparent, on voit ce qu'il y a derrière ; 'black' ou une couleur (ex. '#101030') : les zones transparentes de CETTE couche sont remplies ;
                                                         // 'auto' : seule la couche la plus lointaine de la télé est remplie en noir (les couches de devant laissent voir celles de derrière)
  },

  init: function () {
    const d = this.data;
    let tex;
    if (d.src instanceof HTMLImageElement || d.src instanceof HTMLCanvasElement) {
      tex = new THREE.Texture(d.src);
      tex.needsUpdate = true;
    } else {
      tex = new THREE.TextureLoader().load(d.src);
    }
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;               // évite un trait à la couture du panorama
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;

    this.camPos = new THREE.Vector3();
    this.t0 = performance.now();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map:     { value: tex },
        uCam:    { value: new THREE.Vector3() },
        uCenter: { value: new THREE.Vector3() },  // centre de la sphère (repère du plan)
        uRadius: { value: 30 },
        uAng:    { value: new THREE.Vector3() },  // hfov, vfov, yaw (radians)
        uLight:     { value: new THREE.Vector3() },               // position de la lampe (repère du plan)
        uLightCol:  { value: new THREE.Vector3(1, 1, 1) },        // couleur x intensité
        uLightInfo: { value: new THREE.Vector3(20, 0.3, 0) },     // portée, ambiance, lampe active
        uLightSoft: { value: 1 },
        uHazeCol:   { value: new THREE.Vector3(0.7, 0.8, 0.9) },
        uHaze:      { value: new THREE.Vector3(0, 0, 100) },      // quantité, début, fin
        uBack:      { value: new THREE.Vector4(0, 0, 0, 0) }      // couleur de fond rgb, actif
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      fragmentShader: `
        precision highp float;
        uniform sampler2D map;
        uniform vec3 uCam;
        uniform vec3 uCenter;
        uniform float uRadius;
        uniform vec3 uAng;
        uniform vec3 uLight;
        uniform vec3 uLightCol;
        uniform vec3 uLightInfo;
        uniform float uLightSoft;
        uniform vec3 uHazeCol;
        uniform vec3 uHaze;
        uniform vec4 uBack;
        varying vec3 vPos;
        const float PI = 3.14159265359;

        void main() {
          vec3 p  = vPos;                         // point sur l'ouverture
          vec3 rd = normalize(p - uCam);          // rayon de l'oeil vers ce point
          vec3 oc = p - uCenter;
          float b = dot(oc, rd);
          float c = dot(oc, oc) - uRadius * uRadius;
          float disc = b * b - c;
          if (disc < 0.0) discard;
          float t = -b + sqrt(disc);              // sortie de la sphère, vers l'avant
          vec3 hit = p + rd * t;                  // point touché sur la sphère (repère du plan)
          vec3 dir = normalize(oc + rd * t);

          float lon = atan(dir.x, -dir.z) - uAng.z;
          lon = mod(lon + PI, 2.0 * PI) - PI;     // ramène dans [-PI, PI]
          float lat = asin(clamp(dir.y, -1.0, 1.0));
          vec2 uv = vec2(0.5 + lon / uAng.x, 0.5 + lat / uAng.y);

          vec4 col = texture2D(map, clamp(uv, 0.001, 0.999));
          if (uBack.a > 0.5) col = vec4(mix(uBack.rgb, col.rgb, col.a), 1.0);   // couche du fond : le transparent devient la couleur de fond
          else if (col.a < 0.02) discard;           // zone transparente : on voit la couche derrière
          gl_FragColor = col;

          // éclairage depuis la lampe : la surface de la sphère regarde vers son centre
          if (uLightInfo.z > 0.5) {
            vec3 nrm = -dir;
            vec3 toL = uLight - hit;
            float dist = max(length(toL), 1e-4);
            float diff = max(dot(nrm, toL / dist), 0.0);
            float fall = clamp((uLightInfo.x - dist) / max(uLightInfo.x * uLightSoft, 1e-4), 0.0, 1.0);
            gl_FragColor.rgb *= uLightInfo.y + uLightCol * diff * fall * fall;
          }

          // perspective atmosphérique : plus c'est loin (depuis l'oeil), plus on tend vers la couleur de brume
          float far = max(uHaze.z, uHaze.y + 1e-3);
          float depthFromEye = length(p - uCam) + t;
          float haze = uHaze.x * smoothstep(uHaze.y, far, depthFromEye);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uHazeCol, haze);

          #include <colorspace_fragment>
        }`
    });

    if (window.TVFilter) TVFilter.install(this.material);   // filtre de la télé (tv-filter.js), facultatif
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.width, d.height), this.material);
    this.el.setObject3D('mesh', this.mesh);
    this.updateUniforms();
  },

  updateUniforms: function () {
    const d = this.data, u = this.material.uniforms;
    u.uCenter.value.set(0, d.offsetY, -d.depth);
    u.uRadius.value = d.radius;
    this.mesh.renderOrder = -d.radius;          // grandes sphères dessinées en premier
    u.uAng.value.set(THREE.MathUtils.degToRad(d.hfov),
                     THREE.MathUtils.degToRad(d.vfov),
                     THREE.MathUtils.degToRad(d.yaw));

    const c = new THREE.Color(d.lightColor);
    u.uLightCol.value.set(c.r, c.g, c.b).multiplyScalar(d.lightIntensity);
    (this.baseCol || (this.baseCol = new THREE.Vector3())).copy(u.uLightCol.value);
    u.uLightInfo.value.x = d.lightRange;
    u.uLightInfo.value.y = d.ambient;
    u.uLightSoft.value = Math.min(Math.max(d.lightSoftness, 0), 1);

    const bc = String(d.backColor || 'none').trim().toLowerCase();
    this.backMode = (bc === 'none' || bc === 'off' || bc === 'false' || bc === '') ? 'none' : (bc === 'auto') ? 'auto' : 'color';
    this.backCol = this.backMode === 'color' ? new THREE.Color(d.backColor) : new THREE.Color(0, 0, 0);
    this.backCheck = 0;
    const h = new THREE.Color(d.hazeColor);
    u.uHazeCol.value.set(h.r, h.g, h.b);
    u.uHaze.value.set(d.hazeAmount, d.hazeNear, d.hazeFar);
  },

  update: function (old) {
    if (!this.mesh) return;
    if (this.lamp) this.lamp.__flk = null;
    this.lamp = null; this.warned = false;
    this.updateUniforms();
    const d = this.data;
    if (old.width !== d.width || old.height !== d.height) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = new THREE.PlaneGeometry(d.width, d.height);
    }
  },

  // la couche la plus lointaine de la télé (plus grand rayon ; à égalité, la première dans le HTML)
  isBackmost: function () {
    const p = this.el.parentEl;
    if (!p || p.isScene) return true;
    const mine = this.data.radius;
    const all = p.querySelectorAll('[fake-sphere]');
    for (let i = 0; i < all.length; i++) {
      const o = all[i];
      if (o === this.el) continue;
      const c = o.components && o.components['fake-sphere'];
      if (!c) continue;
      const r = c.data.radius;
      if (r > mine) return false;
      if (r === mine && (o.compareDocumentPosition(this.el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    }
    return true;
  },

  updateBack: function () {
    if (this.backCheck-- <= 0) {                 // on revérifie 2 fois par seconde environ
      this.backCheck = 30;
      this.backOn = this.backMode === 'color' || (this.backMode === 'auto' && this.isBackmost());
    }
    const c = this.backCol;
    this.material.uniforms.uBack.value.set(c.r, c.g, c.b, this.backOn ? 1 : 0);
  },

  tick: function (time) {
    if (window.TVFilter) TVFilter.update(this, time);
    this.updateBack();
    const cam = this.el.sceneEl.camera;
    if (!cam) return;
    cam.getWorldPosition(this.camPos);
    this.mesh.updateWorldMatrix(true, false);
    this.material.uniforms.uCam.value.copy(this.mesh.worldToLocal(this.camPos));

    // recherche de la lampe (à chaque image jusqu'à ce qu'elle soit trouvée)
    const d = this.data, u = this.material.uniforms;
    const sel = d.lightEl;
    if (sel && (!this.lamp || !this.lamp.isConnected)) {
      let el = null;
      try { el = this.el.sceneEl.querySelector(sel); } catch (e) { /* sélecteur invalide */ }
      if (!el && !/^[#.\[]/.test(sel)) el = document.getElementById(sel);   // "lampe" sans # accepté
      this.lamp = el;
      if (el) console.info('[fake-sphere] lampe trouvée :', sel);
      else if (!this.warned && performance.now() - this.t0 > 1500) {
        console.warn('[fake-sphere] lampe introuvable : "' + sel + '" (vérifiez l\'id de l\'entité)');
        this.warned = true;
      }
    }
    const lamp = sel ? this.lamp : null;
    if (lamp && lamp.object3D) {
      lamp.object3D.getWorldPosition(this.lampPos || (this.lampPos = new THREE.Vector3()));
      u.uLight.value.copy(this.mesh.worldToLocal(this.lampPos));
      u.uLightInfo.value.z = 1;

      // vacillement par à-coups, à intervalles aléatoires.
      // L'état est mémorisé sur la lampe : toutes les couches qui l'utilisent vacillent ensemble.
      const st = lamp.__flk || (lamp.__flk = { frame: -1, mult: 1, next: undefined, end: 0, base: null });
      if (d.flicker > 0 && st.frame !== time) {            // une seule couche calcule par image
        st.frame = time;
        const span = Math.max(0, d.flickerMax - d.flickerMin);
        if (st.next === undefined) st.next = time + 1000 * (d.flickerMin + Math.random() * span);
        if (time >= st.next) {
          st.end = time + 80 + Math.random() * 220;        // un vacillement dure 0,08 à 0,3 s
          st.next = st.end + 1000 * (d.flickerMin + Math.random() * span);
        }
        st.mult = (time < st.end) ? 1 - Math.min(1, d.flicker) * (0.35 + 0.65 * Math.random()) : 1;

        // la vraie lumière de la lampe (si elle existe) vacille de la même façon
        const real = lamp.getObject3D && lamp.getObject3D('light');
        if (real) {
          if (st.base == null) st.base = real.intensity;
          real.intensity = st.base * st.mult;
        }
      }
      if (this.baseCol) u.uLightCol.value.copy(this.baseCol).multiplyScalar(st.mult);
    } else {
      u.uLightInfo.value.z = 0;
    }
  }
});
