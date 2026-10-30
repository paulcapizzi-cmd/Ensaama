// fake-sea : une ouverture (plan) qui donne sur une mer animée qui s'étend jusqu'à l'horizon.
// Même principe que fake-ground (le regard est lancé vers un plan infini, dans le prolongement du bord bas
// de l'ouverture), mais la surface est faite de vagues calculées dans le shader (pas d'image à fournir) :
//  - vagues animées (somme de 6 ondes de longueurs et de directions différentes),
//  - reflet du ciel (l'image de votre fake-sphere, via skySrc) : de plus en plus miroir vers l'horizon,
//  - reflet brillant de la lampe (lightEl) = le soleil ou la lune sur l'eau,
//  - au-dessus de l'horizon c'est transparent : on voit les fake-sphere derrière.
//
//   <a-entity fake-sea="width: 2.6; height: 1.5; skySrc: #ciel; lightEl: #soleil" position="0 0 0.015"></a-entity>
//
// Ordre de dessin (layer) : comme fake-ground, -100 par défaut (devant le ciel lointain, derrière le premier plan).
AFRAME.registerComponent('fake-sea', {
  schema: {
    width:  { default: 2 },
    height: { default: 1.5 },
    floorY: { default: 0 },            // niveau de l'eau par rapport au bord bas de l'ouverture (négatif = plus bas)
    tilt:   { default: 0 },            // inclinaison de la mer en degrés : elle descend en s'éloignant, l'horizon est plus bas (0 = à plat).
                                       // La mer commence toujours au même endroit, au bord bas de l'ouverture.
    layer:  { default: -100 },

    // --- vagues ---
    waveSteepness: { default: 0.18 },  // force des vagues (pente) : 0.05 = mer d'huile, 0.18 = légère houle, 0.4 = agitée
    waveLength:    { default: 6 },     // longueur de la plus grande vague (unités de la télé)
    waveSpeed:     { default: 1 },     // vitesse d'animation (0 = mer figée)
    windAngle:     { default: 0 },     // direction des vagues en degrés : 0 = vers la droite, 90 = vers vous

    // --- couleurs ---
    // waterColor:   { type: 'color', default: '#06304a' },   // eau profonde
    // crestColor:   { type: 'color', default: '#2d7a8a' },   // dessus des vagues, plus clair
    waterColor:   { type: 'color', default: '#0B0D31' },   // eau profonde
    crestColor:   { type: 'color', default: '#2d7a8a' },   // dessus des vagues, plus clair
    horizonColor: { type: 'color', default: '#a9c3d6' },   // ciel à l'horizon (si pas de skySrc)
    skyColor:     { type: 'color', default: '#4a78b8' },   // ciel en haut (si pas de skySrc)
    reflectivity: { default: 1 },      // force du reflet du ciel (1 = réaliste, 0 = aucun)

    // --- reflet du ciel : l'image de votre ciel (la même que dans votre fake-sphere) ---
    skySrc:     { type: 'map' },
    skyHfov:    { default: 360 },
    skyVfov:    { default: 180 },
    skyYaw:     { default: 0 },

    // --- reflet de la lampe (soleil / lune surgb(54 41 8)) ---
    lightEl:        { type: 'string' },
    lightColor:     { type: 'color', default: '#FFF8E3' },
    lightIntensity: { default: 1.5 },
    shininess:      { default: 250 },  // finesse du reflet : grand = petit point brillant, petit = large nappe

    // --- disparition à l'horizon ---
    fadeNear: { default: 60 },
    fadeFar:  { default: 400 }
  },

  init: function () {
    const d = this.data;
    const r = this.el.sceneEl.renderer;

    // texture du ciel (facultative)
    this.skyTex = null;
    if (d.skySrc) {
      const s = d.skySrc;
      let t;
      if (s instanceof HTMLImageElement || s instanceof HTMLCanvasElement) { t = new THREE.Texture(s); t.needsUpdate = true; }
      else t = new THREE.TextureLoader().load(s);
      if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
      t.generateMipmaps = false;                 // pas de trait à la couture, pas de scintillement des dérivées
      t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
      this.skyTex = t;
    }
    const flat = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
    flat.needsUpdate = true;

    this.t0 = performance.now();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        skyMap:   { value: this.skyTex || flat },
        uHasSky:  { value: this.skyTex ? 1 : 0 },
        uSky:     { value: new THREE.Vector3(Math.PI * 2, Math.PI, 0) },   // hfov, vfov, yaw
        uSea:     { value: new THREE.Vector4(0, 0, 0.18, 0) },             // y de l'eau, temps, pente, angle du vent
        uTilt:    { value: new THREE.Vector2(1, 0) },                      // cos, sin de l'inclinaison
        uWave:    { value: new THREE.Vector2(6, 1) },                      // longueur d'onde, vitesse
        uDeep:    { value: new THREE.Vector3() },
        uCrest:   { value: new THREE.Vector3() },
        uHorizon: { value: new THREE.Vector3() },
        uTop:     { value: new THREE.Vector3() },
        uRefl:    { value: 1 },
        uLight:     { value: new THREE.Vector3() },
        uLightCol:  { value: new THREE.Vector3(1, 1, 1) },
        uLightOn:   { value: 0 },
        uSpec:      { value: 250 },
        uFade:      { value: new THREE.Vector2(60, 400) }
      },
      vertexShader: `
        varying vec3 vPos;
        varying vec3 vCam;
        void main() {
          vPos = position;
          // position de l'oeil (de CET oeil en VR) dans le repère de l'ouverture
          vCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      fragmentShader: `
        precision highp float;
        uniform sampler2D skyMap;
        uniform float uHasSky;
        uniform vec3 uSky;
        uniform vec4 uSea;
        uniform vec2 uWave;
        uniform vec2 uTilt;
        uniform vec3 uDeep, uCrest, uHorizon, uTop;
        uniform float uRefl;
        uniform vec3 uLight, uLightCol;
        uniform float uLightOn, uSpec;
        uniform vec2 uFade;
        varying vec3 vPos;
        varying vec3 vCam;
        const float PI = 3.14159265359;

        // ciel vu dans la direction dir (image du ciel si fournie, sinon dégradé simple)
        vec3 skyColor(vec3 dir) {
          vec3 fallback = mix(uHorizon, uTop, pow(clamp(dir.y, 0.0, 1.0), 0.45));
          if (uHasSky < 0.5) return fallback;
          float lon = atan(dir.x, -dir.z) - uSky.z;
          lon = mod(lon + PI, 2.0 * PI) - PI;
          float lat = asin(clamp(dir.y, -1.0, 1.0));
          vec2 uv = vec2(0.5 + lon / uSky.x, 0.5 + lat / uSky.y);
          vec4 t = texture2D(skyMap, clamp(uv, 0.001, 0.999));
          return mix(fallback, t.rgb, t.a);
        }

        void main() {
          vec3 p  = vPos;
          vec3 rd = normalize(p - vCam);

          // plan de l'eau : passe par le bord bas de l'ouverture (0, y, 0) et s'incline vers le bas en s'éloignant
          vec3 N0 = vec3(0.0, uTilt.x, -uTilt.y);          // normale du plan
          vec3 Bd = vec3(0.0, uTilt.y, uTilt.x);           // direction "vers vous" le long de la surface
          vec3 P0 = vec3(0.0, uSea.x, 0.0);
          float dn = dot(rd, N0);
          if (abs(dn) < 1e-5) dn = -1e-5;
          float t = dot(P0 - vCam, N0) / dn;
          bool hitWater = t > 0.0;
          vec3 hit = vCam + rd * max(t, 0.0);
          vec2 x = vec2(hit.x, dot(hit - P0, Bd));         // coordonnées sur la surface de l'eau

          // taille d'un pixel sur l'eau : les petites vagues disparaissent quand elles deviennent plus fines que ça
          // (calculé avant toute branche : dérivées valables)
          float fp = length(fwidth(x));

          // somme de 6 ondes : direction, longueur, poids
          vec2 grad = vec2(0.0);
          float hgt = 0.0, hsum = 0.0;
          float steep = uSea.z;
          float time = uSea.y;
          float wsum = 0.0;
          for (int i = 0; i < 6; i++) wsum += pow(0.78, float(i));
          for (int i = 0; i < 6; i++) {
            float fi = float(i);
            float ang = uSea.w + (fi < 0.5 ? 0.0 : (mod(fi, 2.0) < 0.5 ? 1.0 : -1.0) * (0.25 + 0.17 * fi));
            vec2 dir = vec2(cos(ang), sin(ang));
            float lam = uWave.x * pow(0.62, fi);
            float k = 2.0 * PI / lam;
            float w = sqrt(9.81 * k) * uWave.y;
            float slope = steep * pow(0.78, fi) / wsum * 2.2;
            slope *= 1.0 - smoothstep(0.12, 0.45, fp / lam);           // anti-scintillement au loin
            float ph = k * dot(dir, x) - w * time + fi * 1.7;
            grad += slope * cos(ph) * dir;
            hgt  += slope / k * sin(ph);
            hsum += slope / k;
          }
          vec3 n = normalize(vec3(-grad.x, 0.0, 0.0) + N0 - grad.y * Bd);

          // fresnel : de plus en plus miroir quand on regarde l'eau de biais (vers l'horizon)
          vec3 v = -rd;
          float cosT = clamp(dot(n, v), 0.0, 1.0);
          float F = (0.02 + 0.98 * pow(1.0 - cosT, 5.0)) * uRefl;
          F = clamp(F, 0.0, 1.0);

          // reflet du ciel
          vec3 rf = reflect(rd, n);
          rf.y = abs(rf.y) + 0.01;                                     // pas de reflet "sous" l'horizon
          vec3 refl = skyColor(normalize(rf));

          // corps de l'eau : plus clair sur le dessus des vagues
          float crest = clamp(0.5 + 0.5 * hgt / max(hsum, 1e-4), 0.0, 1.0);
          vec3 body = mix(uDeep, uCrest, crest * crest * 0.7);

          vec3 col = mix(body, refl, F);

          // reflet brillant de la lampe
          if (uLightOn > 0.5) {
            vec3 L = normalize(uLight - hit);
            vec3 H = normalize(L + v);
            float sp = pow(max(dot(n, H), 0.0), uSpec) * step(0.0, L.y);
            col += uLightCol * sp;
          }

          float dist = length(hit - vCam);
          float alpha = 1.0 - smoothstep(uFade.x, max(uFade.y, uFade.x + 1e-3), dist);
          if (!hitWater || alpha < 0.01) discard;                      // au-dessus de l'horizon : transparent

          gl_FragColor = vec4(col, alpha);
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
    u.uSea.value.x = -d.height / 2 + d.floorY;
    u.uSea.value.z = d.waveSteepness;
    u.uSea.value.w = THREE.MathUtils.degToRad(d.windAngle);
    u.uWave.value.set(Math.max(d.waveLength, 0.05), d.waveSpeed);
    const tl = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(d.tilt, -60, 80));
    u.uTilt.value.set(Math.cos(tl), Math.sin(tl));
    const c = new THREE.Color();
    c.set(d.waterColor);   u.uDeep.value.set(c.r, c.g, c.b);
    c.set(d.crestColor);   u.uCrest.value.set(c.r, c.g, c.b);
    c.set(d.horizonColor); u.uHorizon.value.set(c.r, c.g, c.b);
    c.set(d.skyColor);     u.uTop.value.set(c.r, c.g, c.b);
    u.uRefl.value = d.reflectivity;
    u.uSky.value.set(THREE.MathUtils.degToRad(d.skyHfov), THREE.MathUtils.degToRad(d.skyVfov), THREE.MathUtils.degToRad(d.skyYaw));
    c.set(d.lightColor);
    u.uLightCol.value.set(c.r, c.g, c.b).multiplyScalar(d.lightIntensity);
    u.uSpec.value = Math.max(d.shininess, 1);
    u.uFade.value.set(d.fadeNear, d.fadeFar);
    this.mesh.renderOrder = d.layer;
  },

  update: function (old) {
    if (!this.mesh) return;
    this.lamp = null; this.warned = false;
    this.updateUniforms();
    const d = this.data;
    if (old.width !== d.width || old.height !== d.height) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = new THREE.PlaneGeometry(d.width, d.height);
    }
  },

  tick: function (time) {
    if (window.TVFilter) TVFilter.update(this, time);
    const d = this.data, u = this.material.uniforms;
    u.uSea.value.y = time / 1000;

    const sel = d.lightEl;
    if (sel && (!this.lamp || !this.lamp.isConnected)) {
      let el = null;
      try { el = this.el.sceneEl.querySelector(sel); } catch (e) { /* sélecteur invalide */ }
      if (!el && !/^[#.\[]/.test(sel)) el = document.getElementById(sel);
      this.lamp = el;
      if (el) console.info('[fake-sea] lampe trouvée :', sel);
      else if (!this.warned && performance.now() - this.t0 > 1500) {
        console.warn('[fake-sea] lampe introuvable : "' + sel + '" (vérifiez l\'id de l\'entité)');
        this.warned = true;
      }
    }
    const lamp = sel ? this.lamp : null;
    if (lamp && lamp.object3D) {
      this.mesh.updateWorldMatrix(true, false);
      lamp.object3D.getWorldPosition(this.lampPos || (this.lampPos = new THREE.Vector3()));
      u.uLight.value.copy(this.mesh.worldToLocal(this.lampPos));
      u.uLightOn.value = 1;
    } else {
      u.uLightOn.value = 0;
    }
  }
});
