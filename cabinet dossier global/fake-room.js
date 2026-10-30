  AFRAME.registerComponent('fake-room', {
  schema: {
    src:        { type: 'map' },
    width:      { default: 2 },     // ouverture dans le mur
    height:     { default: 2.5 },
    depth:      { default: 3 },     // distance jusqu'au mur du fond
    backWidth:  { default: 0 },     // 0 = identique à width
    backHeight: { default: 0 },     // 0 = identique à height
    backBottom: { default: 0 },   // hauteur du bas du fond, par rapport au bas de l'ouverture
    backX:      { default: 0 },   // décalage horizontal du centre du fond
    layout:     { default: 'cross', oneOf: ['cross', 'single'] },  // cross = croix 3x3, single = une seule image
    tile:       { default: false },  // true : murs, sol et plafond se répètent au lieu d'être étirés
    tileLength: { default: 0 },      // longueur d'une répétition le long du couloir (0 = automatique, sans déformation)
    depthFromWalls: { default: false }, // true : depth = longueur naturelle des murs gauche/droit (affichés une seule fois),
                                        //        le sol et le plafond se répètent pour remplir cette longueur
    lightEl:        { type: 'string' },                  // sélecteur de l'entité-lampe, ex. "#lampe" : sa position éclaire le couloir
    lightColor:     { type: 'color', default: '#ffffff' },
    lightIntensity: { default: 1.5 },
    lightRange:     { default: 6 },                      // portée de la lampe (dans le repère du plan)
    lightSoftness:  { default: 1 },                      // bord de la lumière : 0 = net (cercle franc), 1 = dégradé jusqu'au centre (défaut)
    ambient:        { default: 0.3 },                    // luminosité de base quand une lampe est utilisée
    realDepth:      { default: false },                  // true : les objets 3D peuvent se placer dans le couloir (le mur doit avoir un trou)
    flicker:        { default: 0 },                      // vacillement de la lampe : 0 = aucun, 0.3 = léger, 1 = très fort
    flickerMin:     { default: 0.5 },                    // délai minimum entre deux vacillements (secondes)
    flickerMax:     { default: 4 }                       // délai maximum entre deux vacillements (secondes)
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

    this.camPos = new THREE.Vector3();
    this.t0 = performance.now();
    console.info('[fake-room] version avec lampe, répétition, profondeur réelle chargée');
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map:   { value: tex },
        uCam:  { value: new THREE.Vector3() },
        uOpen: { value: new THREE.Vector3() },   // largeur, hauteur, profondeur
        uBack: { value: new THREE.Vector4() },   // centre x, centre y, largeur, hauteur du fond
        uSingle: { value: 0 },                   // 1 = image simple
        uTile:   { value: new THREE.Vector3() }, // répétition active, longueur murs, longueur sol/plafond
        uLight:     { value: new THREE.Vector3() },  // position de la lampe (repère du plan)
        uLightCol:  { value: new THREE.Vector3(1, 1, 1) },
        uLightInfo: { value: new THREE.Vector3(6, 0.3, 0) }, // portée, ambiance, lampe active
        uLightSoft: { value: 1 },
        uRealDepth: { value: 0 },
        uTexSize:   { value: new THREE.Vector2(3, 3) }   // taille de l'image en pixels
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        uniform sampler2D map;
        uniform vec3 uCam;
        uniform vec3 uOpen;
        uniform vec4 uBack;
        uniform float uSingle;
        uniform vec3 uTile;
        uniform vec3 uLight;
        uniform vec3 uLightCol;
        uniform vec3 uLightInfo;
        uniform float uLightSoft;
        uniform float uRealDepth;
        uniform vec2 uTexSize;
        uniform mat4 projectionMatrix;
        uniform mat4 modelViewMatrix;
        varying vec3 vPos;

        #define XL0 (-uOpen.x * 0.5)
        #define XL1 (uBack.x - uBack.z * 0.5)
        #define XR0 (uOpen.x * 0.5)
        #define XR1 (uBack.x + uBack.z * 0.5)
        #define YB0 (-uOpen.y * 0.5)
        #define YB1 (uBack.y - uBack.w * 0.5)
        #define YT0 (uOpen.y * 0.5)
        #define YT1 (uBack.y + uBack.w * 0.5)

        // Coordonnées continues (non répétées) vues depuis l'oeil à travers le point p de l'ouverture,
        // pour UNE face donnée : 0 fond, 1 gauche, 2 droit, 3 sol, 4 plafond.
        vec2 faceCoords(int face, vec3 p) {
          vec3 rd = normalize(p - uCam);
          float D = uOpen.z;
          float k = max(-rd.z, 1e-4) / D;
          float t;
          if (face == 0)      t = 1.0 / k;
          else if (face == 1) t = (XL0 - p.x) / min(rd.x - k * (XL1 - XL0), -1e-6);
          else if (face == 2) t = (XR0 - p.x) / max(rd.x - k * (XR1 - XR0),  1e-6);
          else if (face == 3) t = (YB0 - p.y) / min(rd.y - k * (YB1 - YB0), -1e-6);
          else                t = (YT0 - p.y) / max(rd.y - k * (YT1 - YT0),  1e-6);
          vec3 h = p + rd * t;
          float s = clamp(k * t, 0.0, 1.0);
          float xl = mix(XL0, XL1, s), xr = mix(XR0, XR1, s);
          float yb = mix(YB0, YB1, s), yt = mix(YT0, YT1, s);
          float nx = (h.x - xl) / (xr - xl);
          float ny = (h.y - yb) / (yt - yb);
          bool tiled = uTile.x > 0.5;
          float a = s * D;
          if (face == 0) return vec2((h.x - XL1) / (XR1 - XL1), (h.y - YB1) / (YT1 - YB1));
          if (face == 1) return tiled ? vec2( a / uTile.y, ny) : vec2(s, ny);
          if (face == 2) return tiled ? vec2(-a / uTile.y, ny) : vec2(1.0 - s, ny);
          if (face == 3) return tiled ? vec2(nx,  a / uTile.z) : vec2(nx, s);
          return              tiled ? vec2(nx, -a / uTile.z) : vec2(nx, 1.0 - s);
        }

        // ramène les coordonnées continues dans la case [0,1] (répétition)
        vec2 faceWrap(int face, vec2 c) {
          if (uTile.x < 0.5 || face == 0) return c;
          if (face == 1) return vec2(fract(c.x), c.y);
          if (face == 2) return vec2(1.0 - fract(-c.x), c.y);
          if (face == 3) return vec2(c.x, fract(c.y));
          return vec2(c.x, 1.0 - fract(-c.y));
        }

        void main() {
          vec3 p  = vPos;
          vec3 rd = normalize(p - uCam);
          float D = uOpen.z;
          float k = max(-rd.z, 1e-4) / D;          // avancement en profondeur (0..1) par unité de t

          // bords de l'ouverture (s = 0) et du fond (s = 1)
          float xl0 = -uOpen.x * 0.5,  xl1 = uBack.x - uBack.z * 0.5;
          float xr0 =  uOpen.x * 0.5,  xr1 = uBack.x + uBack.z * 0.5;
          float yb0 = -uOpen.y * 0.5,  yb1 = uBack.y - uBack.w * 0.5;
          float yt0 =  uOpen.y * 0.5,  yt1 = uBack.y + uBack.w * 0.5;

          const float INF = 1e9;
          float tB = 1.0 / k;                                         // mur du fond
          float sl = rd.x - k * (xl1 - xl0);
          float tL = sl < -1e-6 ? (xl0 - p.x) / sl : INF;             // mur gauche
          float sr = rd.x - k * (xr1 - xr0);
          float tR = sr >  1e-6 ? (xr0 - p.x) / sr : INF;             // mur droit
          float sb = rd.y - k * (yb1 - yb0);
          float tF = sb < -1e-6 ? (yb0 - p.y) / sb : INF;             // sol
          float st = rd.y - k * (yt1 - yt0);
          float tC = st >  1e-6 ? (yt0 - p.y) / st : INF;             // plafond

          float t = min(tB, min(min(tL, tR), min(tF, tC)));
          vec3 h = p + rd * t;
          float s = clamp(k * t, 0.0, 1.0);

          // bords à la profondeur du point touché
          float xl = mix(xl0, xl1, s), xr = mix(xr0, xr1, s);
          float yb = mix(yb0, yb1, s), yt = mix(yt0, yt1, s);
          float nx = (h.x - xl) / (xr - xl);
          float ny = (h.y - yb) / (yt - yb);

          int face = (tB <= t) ? 0 : (tL <= t) ? 1 : (tR <= t) ? 2 : (tF <= t) ? 3 : 4;

          if (uSingle > 0.5) {
            vec2 uv1 = (face == 0) ? vec2((h.x - xl1) / (xr1 - xl1), (h.y - yb1) / (yt1 - yb1))
                     : (face == 1) ? vec2(0.0, ny) : (face == 2) ? vec2(1.0, ny)
                     : (face == 3) ? vec2(nx, 0.0) : vec2(nx, 1.0);
            gl_FragColor = texture2D(map, clamp(uv1, 0.002, 0.998));
          } else {
            vec2 cell = (face == 0) ? vec2(1.0, 1.0) : (face == 1) ? vec2(0.0, 1.0) : (face == 2) ? vec2(2.0, 1.0)
                      : (face == 3) ? vec2(1.0, 0.0) : vec2(1.0, 2.0);
            // gradients calculés sur cette face seule : pas de saut de filtrage à la jonction des faces
            vec2 c0 = faceCoords(face, p);
            vec3 dpx = dFdx(p), dpy = dFdy(p);
            // différence avant ou arrière : on garde la plus petite (l'autre peut sortir de la face)
            vec2 fx = faceCoords(face, p + dpx) - c0, bx = c0 - faceCoords(face, p - dpx);
            vec2 fy = faceCoords(face, p + dpy) - c0, by = c0 - faceCoords(face, p - dpy);
            vec2 gx = (dot(fx, fx) < dot(bx, bx)) ? fx : bx;
            vec2 gy = (dot(fy, fy) < dot(by, by)) ? fy : by;
            // garde-fous : jamais de valeur non finie, et au plus un quart de case par pixel
            if (any(isnan(gx)) || any(isinf(gx))) gx = vec2(0.25, 0.0);
            if (any(isnan(gy)) || any(isinf(gy))) gy = vec2(0.0, 0.25);
            if (any(isnan(c0)) || any(isinf(c0))) c0 = vec2(0.5);
            gx *= min(1.0, 0.25 / max(length(gx), 1e-6));
            gy *= min(1.0, 0.25 / max(length(gy), 1e-6));
            // marge dans la case, proportionnelle au flou du filtrage : on ne lit jamais la case voisine
            vec2 cellPx = uTexSize / 3.0;
            float lod = log2(max(1.0, max(length(gx * cellPx), length(gy * cellPx))));
            vec2 inset = min((1.0 + exp2(lod)) / cellPx, vec2(0.5));
            vec2 uvw = clamp(faceWrap(face, c0), inset, 1.0 - inset);
            gl_FragColor = textureGrad(map, (cell + uvw) / 3.0, gx / 3.0, gy / 3.0);
          }
          // éclairage simple depuis la lampe (les normales sont celles du couloir)
          if (uLightInfo.z > 0.5) {
            vec3 nrm = (tB <= t) ? vec3(0.0, 0.0, 1.0)
                     : (tL <= t) ? vec3(1.0, 0.0, 0.0)
                     : (tR <= t) ? vec3(-1.0, 0.0, 0.0)
                     : (tF <= t) ? vec3(0.0, 1.0, 0.0) : vec3(0.0, -1.0, 0.0);
            vec3 toL = uLight - h;
            float dist = max(length(toL), 1e-4);
            float diff = max(dot(nrm, toL / dist), 0.0);
            float fall = clamp((uLightInfo.x - dist) / max(uLightInfo.x * uLightSoft, 1e-4), 0.0, 1.0);
            gl_FragColor.rgb *= uLightInfo.y + uLightCol * diff * fall * fall;
          }

          // profondeur réelle du point touché : les objets 3D peuvent passer devant ou derrière
          vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(h, 1.0);
          gl_FragDepth = uRealDepth > 0.5 ? clamp(clipPos.z / clipPos.w * 0.5 + 0.5, 0.0, 1.0) : gl_FragCoord.z;

          #include <colorspace_fragment>
        }`
    });

    if (window.TVFilter) TVFilter.install(this.material);   // filtre de la télé (tv-filter.js), facultatif
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.width, d.height), this.material);
    this.el.setObject3D('mesh', this.mesh);
    this.updateUniforms();
  },

  updateUniforms: function () {
    const d = this.data;
    const bw = d.backWidth  > 0 ? d.backWidth  : d.width;
    const bh = d.backHeight > 0 ? d.backHeight : d.height;
    const cy = -d.height / 2 + d.backBottom + bh / 2;
    this.material.uniforms.uBack.value.set(d.backX, cy, bw, bh);
    this.material.uniforms.uSingle.value = d.layout === 'single' ? 1 : 0;

    // longueur d'une répétition : par défaut, celle qui garde les pixels carrés
    const img = this.material.uniforms.map.value.image;
    const aspect = (img && img.width) ? img.width / img.height : 1;   // rapport largeur/hauteur d'une case
    const lwAuto = 0.5 * (d.height + bh) * aspect;                    // longueur naturelle d'un mur
    const lfAuto = 0.5 * (d.width + bw) / aspect;                     // longueur naturelle du sol / plafond
    const lw = d.tileLength > 0 ? d.tileLength : lwAuto;
    const lf = d.tileLength > 0 ? d.tileLength : lfAuto;

    let depth = d.depth, wallLen = lw, tile = d.tile;
    if (d.depthFromWalls) {
      depth = lwAuto;                 // la profondeur épouse exactement la longueur des murs
      wallLen = depth * 1.00001;      // murs affichés une seule fois, sans répétition
      tile = true;                    // sol et plafond se répètent
    }
    this.material.uniforms.uOpen.value.set(d.width, d.height, depth);
    this.material.uniforms.uTile.value.set(tile ? 1 : 0, wallLen, lf);
    const u = this.material.uniforms;
    const c = new THREE.Color(d.lightColor);
    u.uLightCol.value.set(c.r, c.g, c.b).multiplyScalar(d.lightIntensity);
    (this.baseCol || (this.baseCol = new THREE.Vector3())).copy(u.uLightCol.value);
    u.uLightInfo.value.x = d.lightRange;
    u.uLightInfo.value.y = d.ambient;
    u.uLightSoft.value = Math.min(Math.max(d.lightSoftness, 0), 1);
    u.uRealDepth.value = d.realDepth ? 1 : 0;
    if (img && img.width) u.uTexSize.value.set(img.width, img.height);
    this.aspectKnown = !!(img && img.width);
  },

  update: function (old) {
    if (!this.mesh) return;
    this.lamp = null; this.warned = false; this.baseReal = null;
    this.updateUniforms();
    const d = this.data;
    if (old.width !== d.width || old.height !== d.height) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = new THREE.PlaneGeometry(d.width, d.height);
    }
  },

  tick: function (time) {
    if (window.TVFilter) TVFilter.update(this, time);
    const cam = this.el.sceneEl.camera;
    if (!cam) return;
    if (!this.aspectKnown) this.updateUniforms();   // l'image vient peut-être de finir de charger
    cam.getWorldPosition(this.camPos);
    this.mesh.updateWorldMatrix(true, false);
    const sel = this.data.lightEl;
    if (sel && (!this.lamp || !this.lamp.isConnected)) {
      let el = null;
      try { el = this.el.sceneEl.querySelector(sel); } catch (e) { /* sélecteur invalide */ }
      if (!el && !/^[#.\[]/.test(sel)) el = document.getElementById(sel);   // "lampe" sans # accepté
      this.lamp = el; this.baseReal = null;
      if (el) console.info('[fake-room] lampe trouvée :', sel);
      else if (!this.warned && performance.now() - this.t0 > 1500) {
        console.warn('[fake-room] lampe introuvable : "' + sel + '" (vérifiez l\'id de l\'entité)');
        this.warned = true;
      }
    }
    const lamp = sel ? this.lamp : null;
    if (lamp && lamp.object3D) {
      lamp.object3D.getWorldPosition(this.lampPos || (this.lampPos = new THREE.Vector3()));
      this.material.uniforms.uLight.value.copy(this.mesh.worldToLocal(this.lampPos));
      this.material.uniforms.uLightInfo.value.z = 1;

      // vacillement par à-coups, à intervalles aléatoires
      const d = this.data;
      let mult = 1;
      if (d.flicker > 0) {
        if (this.nextFlicker === undefined) this.nextFlicker = time + 1000 * (d.flickerMin + Math.random() * Math.max(0, d.flickerMax - d.flickerMin));
        if (time >= this.nextFlicker) {
          this.flickerEnd = time + 80 + Math.random() * 220;                       // un vacillement dure 0,08 à 0,3 s
          this.nextFlicker = this.flickerEnd + 1000 * (d.flickerMin + Math.random() * Math.max(0, d.flickerMax - d.flickerMin));
        }
        if (this.flickerEnd && time < this.flickerEnd) mult = 1 - Math.min(1, d.flicker) * (0.35 + 0.65 * Math.random());
      }
      if (this.baseCol) this.material.uniforms.uLightCol.value.copy(this.baseCol).multiplyScalar(mult);

      // la vraie lumière de la lampe (si elle existe) vacille de la même façon
      const real = lamp.getObject3D && lamp.getObject3D('light');
      if (real) {
        if (this.baseReal == null) this.baseReal = real.intensity;
        real.intensity = this.baseReal * mult;
      }
    } else {
      this.material.uniforms.uLightInfo.value.z = 0;
    }
    this.material.uniforms.uCam.value.copy(this.mesh.worldToLocal(this.camPos));
  }
});
