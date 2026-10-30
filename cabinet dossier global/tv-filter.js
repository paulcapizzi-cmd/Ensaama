// tv-filter : un filtre "appareil photo ancien" (couleurs passées, vignettage, grain, vacillement...)
// appliqué à toutes les couches (fake-sphere, fake-room, fake-ground) d'une même télé.
//
// À mettre sur l'entité de la télé (le parent des couches) :
//   <a-entity gltf-model="#tele1" tv-filter="preset: vintage; grain: 0.2"> ...couches... </a-entity>
//
// Chaque couche cherche un tv-filter sur son entité ou sur ses parents. Sans tv-filter, rien ne change.
// Il faut charger ce fichier (<script src="tv-filter.js">) avant ou après les trois autres, peu importe.
(function () {
  const PRESETS = {
    //               saturation sepia contrast brightness fade  tint       tintAmount vignette vigSize grain grainSize flicker
    none:      { saturation: 1,    sepia: 0,    contrast: 1,    brightness: 1,    fade: 0,    tint: '#ffffff', tintAmount: 0,   vignette: 0,   vignetteSize: 0.4,  grain: 0,    grainSize: 1.5, flicker: 0 },
    vintage:   { saturation: 0.7,  sepia: 0.3,  contrast: 0.95, brightness: 1.18, fade: 0.06, tint: '#ffe2b0', tintAmount: 0.5, vignette: 0.6, vignetteSize: 0.35, grain: 0.1,  grainSize: 1.5, flicker: 0.15 },
    sepia:     { saturation: 0,    sepia: 1,    contrast: 1.0,  brightness: 1.0,  fade: 0.04, tint: '#ffffff', tintAmount: 0,   vignette: 0.5, vignetteSize: 0.4,  grain: 0.1,  grainSize: 1.5, flicker: 0.1 },
    noirblanc: { saturation: 0,    sepia: 0,    contrast: 1.1,  brightness: 1.0,  fade: 0.02, tint: '#ffffff', tintAmount: 0,   vignette: 0.5, vignetteSize: 0.4,  grain: 0.12, grainSize: 1.5, flicker: 0.1 },
    polaroid:  { saturation: 0.85, sepia: 0.1,  contrast: 0.9,  brightness: 1.05, fade: 0.1,  tint: '#ffd9c0', tintAmount: 0.35, vignette: 0.35, vignetteSize: 0.5, grain: 0.06, grainSize: 1.5, flicker: 0 }
  };

  // GLSL ajouté à la fin de chaque couche : transforme la couleur finale du pixel
  const GLSL = `
    uniform vec4 uFA;   // saturation, contraste, luminosité, sépia
    uniform vec4 uFB;   // teinte rgb, force de la teinte
    uniform vec4 uFC;   // voile (noirs relevés), vignettage, taille du vignettage, grain
    uniform vec4 uFD;   // temps, vacillement, taille du grain, intensité globale
    varying vec2 vFUv;
    float tvHash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    vec3 tvFilter(vec3 src, vec2 q, vec2 fc) {
      if (uFD.w <= 0.0) return src;
      vec3 c = pow(max(src, vec3(0.0)), vec3(1.0 / 2.2));          // on travaille en couleurs "perçues"
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, uFA.x);                                   // saturation
      c = mix(c, l * vec3(1.20, 0.97, 0.72), uFA.w);                // sépia
      c = (c - 0.5) * uFA.y + 0.5;                                  // contraste
      c *= uFA.z * uFD.y;                                           // luminosité x vacillement
      c = uFC.x + c * (1.0 - uFC.x);                                // noirs relevés (image passée)
      c = mix(c, c * uFB.rgb, uFB.a);                               // teinte
      float r = length((q - 0.5) * 2.0) / 1.41421;                  // 0 au centre, 1 dans les coins
      c *= 1.0 - uFC.y * smoothstep(uFC.z, 1.0, r);                 // vignettage
      float n = tvHash(floor(fc / max(uFD.z, 0.5)) + floor(uFD.x * 24.0) * 17.0);
      c += (n - 0.5) * uFC.w * 0.6;                                 // grain (change 24 fois par seconde)
      c = pow(max(c, vec3(0.0)), vec3(2.2));
      return mix(src, c, clamp(uFD.w, 0.0, 1.0));
    }
  `;

  function find(el) {
    for (let p = el; p; p = p.parentEl) {
      if (p.components && p.components['tv-filter']) return p.components['tv-filter'];
      if (p.isScene) break;
    }
    return null;
  }

  window.TVFilter = {
    // modifie les shaders d'une couche pour y ajouter le filtre
    install: function (mat) {
      mat.uniforms.uFA = { value: new THREE.Vector4(1, 1, 1, 0) };
      mat.uniforms.uFB = { value: new THREE.Vector4(1, 1, 1, 0) };
      mat.uniforms.uFC = { value: new THREE.Vector4(0, 0, 0.4, 0) };
      mat.uniforms.uFD = { value: new THREE.Vector4(0, 1, 1.5, 0) };
      mat.vertexShader = mat.vertexShader
        .replace('void main() {', 'varying vec2 vFUv;\n        void main() {\n          vFUv = uv;');
      mat.fragmentShader = mat.fragmentShader
        .replace('void main() {', GLSL.replace('varying vec2 vFUv;', 'varying vec2 vFUv;') + '\n        void main() {')
        .replace('#include <colorspace_fragment>',
                 'gl_FragColor.rgb = tvFilter(gl_FragColor.rgb, vFUv, gl_FragCoord.xy);\n          #include <colorspace_fragment>');
      mat.needsUpdate = true;
    },
    // appelé à chaque image par chaque couche : recopie les réglages du filtre de la télé
    update: function (layer, time) {
      const u = layer.material && layer.material.uniforms;
      if (!u || !u.uFD) return;
      const f = find(layer.el);
      if (!f || !f.vals) { u.uFD.value.w = 0; return; }
      u.uFA.value.copy(f.vals.A); u.uFB.value.copy(f.vals.B);
      u.uFC.value.copy(f.vals.C); u.uFD.value.copy(f.vals.D);
    }
  };

  AFRAME.registerComponent('tv-filter', {
    schema: {
      preset:       { default: 'vintage' },   // none, vintage, sepia, noirblanc, polaroid
      amount:       { default: 1 },           // intensité globale : 0 = pas de filtre, 1 = plein effet
      // les réglages ci-dessous remplacent ceux du preset (laissés à -1 / vide = valeur du preset)
      saturation:   { default: -1 },          // 1 = normal, 0 = noir et blanc
      sepia:        { default: -1 },          // 0 à 1
      contrast:     { default: -1 },          // 1 = normal
      brightness:   { default: -1 },          // 1 = normal
      fade:         { default: -1 },          // 0 à 1 : noirs relevés (image délavée)
      tint:         { type: 'string', default: '' },   // couleur de la teinte, ex. #ffe2b0
      tintAmount:   { default: -1 },          // 0 à 1
      vignette:     { default: -1 },          // 0 à 1 : assombrissement des coins
      vignetteSize: { default: -1 },          // 0 à 1 : où il commence (petit = couvre plus de surface)
      grain:        { default: -1 },          // 0 à 1
      grainSize:    { default: -1 },          // taille du grain en pixels
      flicker:      { default: -1 }           // 0 à 1 : petites variations de luminosité
    },

    init: function () {
      this.vals = { A: new THREE.Vector4(), B: new THREE.Vector4(), C: new THREE.Vector4(), D: new THREE.Vector4(0, 1, 1.5, 1) };
      this.flick = 1; this.nextFlick = 0;
      this.col = new THREE.Color();
    },

    pick: function (name, base) {
      const v = this.data[name];
      if (typeof v === 'string') return v === '' ? base[name] : v;
      return v < 0 ? base[name] : v;
    },

    tick: function (time) {
      const d = this.data;
      const base = PRESETS[d.preset] || PRESETS.vintage;
      const g = (n) => this.pick(n, base);
      this.col.set(g('tint'));
      const v = this.vals;
      v.A.set(g('saturation'), g('contrast'), g('brightness'), THREE.MathUtils.clamp(g('sepia'), 0, 1));
      v.B.set(this.col.r, this.col.g, this.col.b, g('tintAmount'));
      v.C.set(g('fade'), g('vignette'), g('vignetteSize'), g('grain'));
      // vacillement : nouvelle valeur au hasard environ 12 fois par seconde
      if (time >= this.nextFlick) {
        this.flick = 1 + (Math.random() - 0.5) * g('flicker') * 0.3;
        this.nextFlick = time + 80;
      }
      v.D.set(time / 1000, this.flick, g('grainSize'), d.amount);
    }
  });
})();
