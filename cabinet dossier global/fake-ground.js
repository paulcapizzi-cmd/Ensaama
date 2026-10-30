// fake-ground : une ouverture (plan) qui donne sur un sol infini qui s'étend jusqu'à l'horizon.
// Le sol est dans le prolongement du bord bas de l'ouverture (comme le sol de fake-room).
// Tout ce qui est au-dessus de l'horizon est transparent : on voit donc au travers les couches
// fake-sphere placées derrière (ciel, montagnes...).
//
// Ordre de dessin (renderOrder) : une fake-sphere de rayon R est dessinée à -R.
//  - le sol (layer: -100 par défaut) passe donc DEVANT les sphères de rayon > 100 (ciel lointain)
//    et DERRIÈRE celles de rayon < 100 (premier plan : arbres, rochers...).
//  - changez "layer" pour intercaler le sol ailleurs.
AFRAME.registerComponent('fake-ground', {
  schema: {
    src:      { type: 'map' },
    width:    { default: 2 },       // taille de l'ouverture
    height:   { default: 1.5 },
    floorY:   { default: 0 },       // décalage du sol par rapport au bord bas de l'ouverture (négatif = plus bas)
    tileSize: { default: 2 },       // taille (dans le repère de l'ouverture) d'une répétition de l'image
    offsetX:  { default: 0 },       // décalage de l'image sur le sol (pour la faire glisser)
    offsetZ:  { default: 0 },
    rotate:   { default: 0 },       // rotation de l'image sur le sol (degrés)
    tileShift: { default: 0.5 },    // décalage des tuiles vers la droite, en fraction de tuile (0.5 = la couture n'est plus au milieu ; 0 = ancien comportement)
    tileBlend: { default: 0 },      // fondu entre tuiles voisines, en fraction de tuile : 0 = aucun, 0.1 à 0.25 = couture peu visible (max 0.5)
    tileRotate: { type: 'string', default: '' },  // angles possibles, tirés au hasard pour chaque tuile, ex. "0 90 180 270" ou "0 45 90 180" (vide = aucune rotation)
    tileSeed:  { default: 0 },      // change le tirage au hasard des rotations

    // --- relief (visible seulement avec une lampe : lightEl) ---
    normalMap:   { type: 'map' },            // normal map (convention OpenGL : vert = haut)
    normalScale: { default: 1 },              // force du relief de la normal map
    normalFlipY: { default: false },          // true pour une normal map DirectX (vert inversé)
    bumpMap:     { type: 'map' },            // bump map : image en niveaux de gris, blanc = haut
    bumpScale:   { default: 0.05 },           // hauteur du blanc, en fraction de la taille de la tuile
    layer:    { default: -100 },    // ordre de dessin, voir plus haut

    // --- disparition à l'horizon (le sol devient transparent avec la distance) ---
    fadeNear: { default: 40 },      // distance (depuis l'oeil) où le sol commence à disparaître
    fadeFar:  { default: 250 },     // distance où il a complètement disparu

    // --- lampe (même système que fake-room / fake-sphere) ---
    lightEl:        { type: 'string' },
    lightColor:     { type: 'color', default: '#ffffff' },
    lightIntensity: { default: 1.5 },
    lightRange:     { default: 20 },
    lightSoftness:  { default: 1 },                      // bord de la lumière : 0 = net (cercle franc), 1 = dégradé jusqu'au centre (défaut)
    ambient:        { default: 0.3 },
    flicker:        { default: 0 },
    flickerMin:     { default: 0.5 },
    flickerMax:     { default: 4 },

    // --- perspective atmosphérique ---
    hazeAmount: { default: 0 },
    hazeColor:  { type: 'color', default: '#b4c8e6' },
    hazeNear:   { default: 0 },
    hazeFar:    { default: 100 }
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
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;      // l'image se répète sur le sol
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;    // évite le scintillement au loin
    tex.magFilter = THREE.LinearFilter;
    const r = this.el.sceneEl.renderer;
    tex.anisotropy = r ? r.capabilities.getMaxAnisotropy() : 8;   // sol net en rasant

    // textures de relief (optionnelles)
    const flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat);
    flat.needsUpdate = true;
    const loadMap = (src) => {
      if (!src) return null;
      let t;
      if (src instanceof HTMLImageElement || src instanceof HTMLCanvasElement) {
        t = new THREE.Texture(src); t.needsUpdate = true;
      } else {
        t = new THREE.TextureLoader().load(src, () => { if (this.material) this.updateUniforms(); });
      }
      t.wrapS = t.wrapT = THREE.RepeatWrapping;      // pas de colorSpace : ce sont des données, pas des couleurs
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = tex.anisotropy;
      return t;
    };
    this.normalTex = loadMap(d.normalMap);
    this.bumpTex = loadMap(d.bumpMap);

    this.t0 = performance.now();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map:     { value: tex },
        uFloor:  { value: new THREE.Vector4(0, 2, 0, 0) },   // y du sol, tileSize, offsetX, offsetZ
        uRot:    { value: new THREE.Vector2(1, 0) },         // cos, sin de la rotation
        uTile:   { value: new THREE.Vector3(0.5, 0, 0) },    // décalage, fondu, graine
        uTileRot: { value: [0, 0, 0, 0, 0, 0, 0, 0] },       // angles possibles (radians)
        uTileN:  { value: 0 },                               // nombre d'angles
        normalMap: { value: this.normalTex || flat },
        bumpMap:   { value: this.bumpTex || flat },
        uHasN:   { value: 0 },
        uNormal: { value: new THREE.Vector2(1, 1) },         // force, signe du vert
        uBump:   { value: new THREE.Vector3(0, 1 / 1024, 1 / 1024) },  // échelle, taille d'un texel
        uFade:   { value: new THREE.Vector2(40, 250) },
        uLight:     { value: new THREE.Vector3() },
        uLightCol:  { value: new THREE.Vector3(1, 1, 1) },
        uLightInfo: { value: new THREE.Vector3(20, 0.3, 0) },
        uLightSoft: { value: 1 },
        uHazeCol:   { value: new THREE.Vector3(0.7, 0.8, 0.9) },
        uHaze:      { value: new THREE.Vector3(0, 0, 100) }
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
        uniform sampler2D map;
        uniform vec4 uFloor;
        uniform vec2 uRot;
        uniform vec2 uFade;
        uniform vec3 uLight;
        uniform vec3 uLightCol;
        uniform vec3 uLightInfo;
        uniform float uLightSoft;
        uniform vec3 uHazeCol;
        uniform vec3 uHaze;
        uniform vec3 uTile;
        uniform float uTileRot[8];
        uniform float uTileN;
        uniform sampler2D normalMap;
        uniform sampler2D bumpMap;
        uniform float uHasN;
        uniform vec2 uNormal;
        uniform vec3 uBump;
        varying vec3 vPos;
        varying vec3 vCam;

        float h21(vec2 p) {                          // nombre au hasard stable pour une tuile
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        vec2 tri(vec2 x) { return 1.0 - abs(1.0 - mod(x, 2.0)); }   // prolonge l'image en miroir hors de la tuile

        // couleur (et normale) de la tuile "cell" au point uvc, avec sa rotation propre.
        // nrm : normale dans le repère de l'image du sol (x = sens u, y = sens v, z = vers le haut)
        vec4 tileSample(vec2 cell, vec2 uvc, vec2 gx, vec2 gy, out vec3 nrm) {
          vec2 l = uvc - cell;
          mat2 R = mat2(1.0, 0.0, 0.0, 1.0);
          if (uTileN > 0.5) {
            int i = min(int(floor(h21(cell + vec2(uTile.z * 17.0, uTile.z * 7.0)) * uTileN)), int(uTileN) - 1);
            float a = uTileRot[i];
            if (a != 0.0) {
              float c = cos(a), s = sin(a);
              R = mat2(c, s, -s, c);
              l = R * (l - 0.5) + 0.5; gx = R * gx; gy = R * gy;   // les dégradés tournent aussi (mipmaps corrects)
            }
          }
          vec2 sg = vec2(1.0);
          if (uTileN > 0.5 || uTile.y > 0.0) {
            sg = 1.0 - 2.0 * step(1.0, mod(l, 2.0));    // -1 là où l'image est retournée en miroir
            l = tri(l);
          }
          vec4 col = textureGrad(map, l, gx, gy);

          // relief dans le repère de la tuile
          vec2 nxy = vec2(0.0);
          float nz = 1.0;
          if (uHasN > 0.5) {
            vec3 t = textureGrad(normalMap, l, gx, gy).xyz * 2.0 - 1.0;
            if (dot(t, t) > 1e-3) { nxy = vec2(t.x, t.y * uNormal.y) * uNormal.x; nz = max(t.z, 0.05); }
          }
          if (uBump.x > 0.0) {
            vec2 e = uBump.yz;
            float hx = textureGrad(bumpMap, l + vec2(e.x, 0.0), gx, gy).r - textureGrad(bumpMap, l - vec2(e.x, 0.0), gx, gy).r;
            float hy = textureGrad(bumpMap, l + vec2(0.0, e.y), gx, gy).r - textureGrad(bumpMap, l - vec2(0.0, e.y), gx, gy).r;
            nxy -= vec2(hx / (2.0 * e.x), hy / (2.0 * e.y)) * uBump.x * nz;
          }
          // retour au repère du sol : miroir puis rotation inverse de la tuile
          nxy = transpose(R) * (nxy * sg);
          nrm = vec3(nxy, nz);
          return col;
        }

        void main() {
          vec3 p  = vPos;
          vec3 rd = normalize(p - vCam);

          // intersection du rayon avec le plan y = uFloor.x (on évite la division par 0)
          float dy = rd.y;
          if (abs(dy) < 1e-5) dy = -1e-5;
          float t = (uFloor.x - vCam.y) / dy;
          bool hitFloor = t > 0.0;
          vec3 hit = vCam + rd * max(t, 0.0);

          // coordonnées continues dans l'image (1 unité = 1 tuile)
          vec2 g = hit.xz;
          g = vec2(uRot.x * g.x - uRot.y * g.y, uRot.y * g.x + uRot.x * g.y);
          vec2 uvc = (g + uFloor.zw) / uFloor.y + vec2(uTile.x, 0.0);
          vec2 gx = dFdx(uvc), gy = dFdy(uvc);        // dégradés pour le mipmapping, calculés AVANT toute branche
          vec2 cell = floor(uvc);
          vec4 col;
          vec3 nT;                                    // normale (repère de l'image)
          if (uTile.y > 0.0) {
            // fondu : près d'un bord, on mélange avec la tuile voisine (poids 0.5 pile sur le bord)
            vec2 f = uvc - cell;
            vec2 sg = vec2(f.x < 0.5 ? -1.0 : 1.0, f.y < 0.5 ? -1.0 : 1.0);
            vec2 w = 0.5 * (1.0 - smoothstep(0.0, uTile.y, min(f, 1.0 - f)));
            vec3 n0, n1, n2, n3;
            vec4 a0 = tileSample(cell, uvc, gx, gy, n0);
            vec4 a1 = tileSample(cell + vec2(sg.x, 0.0), uvc, gx, gy, n1);
            vec4 a2 = tileSample(cell + vec2(0.0, sg.y), uvc, gx, gy, n2);
            vec4 a3 = tileSample(cell + sg, uvc, gx, gy, n3);
            float w0 = (1.0 - w.x) * (1.0 - w.y), w1 = w.x * (1.0 - w.y), w2 = (1.0 - w.x) * w.y, w3 = w.x * w.y;
            vec4 acc = vec4(a0.rgb * a0.a, a0.a) * w0 + vec4(a1.rgb * a1.a, a1.a) * w1
                     + vec4(a2.rgb * a2.a, a2.a) * w2 + vec4(a3.rgb * a3.a, a3.a) * w3;
            col = vec4(acc.rgb / max(acc.a, 1e-4), acc.a);
            nT = n0 * w0 + n1 * w1 + n2 * w2 + n3 * w3;
          } else {
            col = tileSample(cell, uvc, gx, gy, nT);
          }
          // normale dans le repère du plan : u -> x, v -> z, haut -> y (en annulant la rotation globale "rotate")
          vec2 nxz = transpose(mat2(uRot.x, uRot.y, -uRot.y, uRot.x)) * nT.xy;
          vec3 nW = normalize(vec3(nxz.x, nT.z, nxz.y));

          float dist = length(hit - vCam);
          float fade = 1.0 - smoothstep(uFade.x, max(uFade.y, uFade.x + 1e-3), dist);
          float alpha = col.a * fade;
          if (!hitFloor || alpha < 0.01) discard;     // au-dessus de l'horizon : transparent

          gl_FragColor = vec4(col.rgb, alpha);

          // éclairage depuis la lampe (le sol regarde vers le haut)
          if (uLightInfo.z > 0.5) {
            vec3 toL = uLight - hit;
            float ld = max(length(toL), 1e-4);
            float diff = max(dot(nW, toL / ld), 0.0);
            float fall = clamp((uLightInfo.x - ld) / max(uLightInfo.x * uLightSoft, 1e-4), 0.0, 1.0);
            gl_FragColor.rgb *= uLightInfo.y + uLightCol * diff * fall * fall;
          }

          // perspective atmosphérique
          float far = max(uHaze.z, uHaze.y + 1e-3);
          float haze = uHaze.x * smoothstep(uHaze.y, far, dist);
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
    u.uFloor.value.set(-d.height / 2 + d.floorY, Math.max(d.tileSize, 1e-3), d.offsetX, d.offsetZ);
    const a = THREE.MathUtils.degToRad(d.rotate);
    u.uRot.value.set(Math.cos(a), Math.sin(a));
    u.uFade.value.set(d.fadeNear, d.fadeFar);
    u.uHasN.value = this.normalTex ? 1 : 0;
    u.uNormal.value.set(d.normalScale, d.normalFlipY ? -1 : 1);
    const bi = this.bumpTex && this.bumpTex.image;
    const bw = (bi && (bi.naturalWidth || bi.width)) || 1024, bh = (bi && (bi.naturalHeight || bi.height)) || 1024;
    u.uBump.value.set(this.bumpTex ? d.bumpScale : 0, 1 / bw, 1 / bh);
    const angs = String(d.tileRotate || '').split(/[\s,;]+/).map(parseFloat).filter(x => !isNaN(x)).slice(0, 8);
    u.uTileN.value = angs.length;
    for (let i = 0; i < 8; i++) u.uTileRot.value[i] = THREE.MathUtils.degToRad(angs[i] || 0);
    u.uTile.value.set(d.tileShift, THREE.MathUtils.clamp(d.tileBlend, 0, 0.5), d.tileSeed);
    this.mesh.renderOrder = d.layer;

    const c = new THREE.Color(d.lightColor);
    u.uLightCol.value.set(c.r, c.g, c.b).multiplyScalar(d.lightIntensity);
    (this.baseCol || (this.baseCol = new THREE.Vector3())).copy(u.uLightCol.value);
    u.uLightInfo.value.x = d.lightRange;
    u.uLightInfo.value.y = d.ambient;
    u.uLightSoft.value = Math.min(Math.max(d.lightSoftness, 0), 1);

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

  tick: function (time) {
    if (window.TVFilter) TVFilter.update(this, time);
    const d = this.data, u = this.material.uniforms;
    const sel = d.lightEl;
    if (sel && (!this.lamp || !this.lamp.isConnected)) {
      let el = null;
      try { el = this.el.sceneEl.querySelector(sel); } catch (e) { /* sélecteur invalide */ }
      if (!el && !/^[#.\[]/.test(sel)) el = document.getElementById(sel);
      this.lamp = el;
      if (el) console.info('[fake-ground] lampe trouvée :', sel);
      else if (!this.warned && performance.now() - this.t0 > 1500) {
        console.warn('[fake-ground] lampe introuvable : "' + sel + '" (vérifiez l\'id de l\'entité)');
        this.warned = true;
      }
    }
    const lamp = sel ? this.lamp : null;
    if (lamp && lamp.object3D) {
      this.mesh.updateWorldMatrix(true, false);
      lamp.object3D.getWorldPosition(this.lampPos || (this.lampPos = new THREE.Vector3()));
      u.uLight.value.copy(this.mesh.worldToLocal(this.lampPos));
      u.uLightInfo.value.z = 1;

      // vacillement : même état partagé que fake-sphere (toutes les couches vacillent ensemble)
      const st = lamp.__flk || (lamp.__flk = { frame: -1, mult: 1, next: undefined, end: 0, base: null });
      if (d.flicker > 0 && st.frame !== time) {
        st.frame = time;
        const span = Math.max(0, d.flickerMax - d.flickerMin);
        if (st.next === undefined) st.next = time + 1000 * (d.flickerMin + Math.random() * span);
        if (time >= st.next) {
          st.end = time + 80 + Math.random() * 220;
          st.next = st.end + 1000 * (d.flickerMin + Math.random() * span);
        }
        st.mult = (time < st.end) ? 1 - Math.min(1, d.flicker) * (0.35 + 0.65 * Math.random()) : 1;
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
