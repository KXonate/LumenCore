import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  FULLSCREEN_VERT,
  GBUFFER_VERT,
  GBUFFER_FRAG,
  SSGI_SSR_FRAG,
  ACCUM_FRAG,
  BLOOM_PRE_FRAG,
  BLOOM_BLUR_FRAG,
  POST_FRAG,
} from './shaders.js';

function halton(index, base) {
  let f = 1, r = 0;
  while (index > 0) {
    f /= base;
    r += f * (index % base);
    index = Math.floor(index / base);
  }
  return r;
}

export class LumenEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    const gl = this.renderer.getContext();
    this.supportsFloat32 = !!gl.getExtension('EXT_color_buffer_float');
    this.rtType = this.supportsFloat32 ? THREE.FloatType : THREE.HalfFloatType;
    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileCubemapShader();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030304);
    this.envRenderTarget = this.pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envRenderTarget.texture;
    this.scene.environmentIntensity = 0.55;

    this.freeCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 1000);
    this.freeCamera.position.set(4.5, 2.4, 5.2);
    this.activeCamera = this.freeCamera;

    this.controls = new OrbitControls(this.freeCamera, canvas);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => {
      if (this.activeCamera === this.freeCamera) this.resetAccumulation();
    });

    this.blenderCameras = new Map();
    this.sceneLights = [];
    this.gbufPairs = [];
    this.sampleCount = 0;
    this.maxViewportSamples = 64;
    this.viewportScale = 0.75;
    this.displayW = 1280;
    this.displayH = 720;
    this.width = 960;
    this.height = 540;

    this.selectedLightId = null;
    this.showLightGizmo = false;
    this._initLightGizmo();

    this.settings = {
      exposure: 1.0,
      lightScale: 0.60,
      envIntensity: 0.55,
      ssrStrength: 0.95,
      giStrength: 0.50,
      contactStrength: 1.05,
      shadowSoftness: 1.0,
      fogDensity: 0.18,
      fogColor: new THREE.Color(0x160e08),
      dofAperture: 0.0,
      focusDistance: 6.0,
      bloomStrength: 0.32,
      streakStrength: 0.35,
      agxContrast: 1.12,
      colorTemp: 0.05,
      saturation: 1.08,
      sharpness: 0.45,
      chromaticAberration: 0.20,
      filmGrain: 0.12,
    };

    this._initPostPipeline();
    this._buildDefaultDarkStudio();
    this._prepareGBufferMaterials();
    this.bakeEnvironmentProbe();
    this.resize(canvas.clientWidth || 1280, canvas.clientHeight || 720);
  }

  _initLightGizmo() {
    this.gizmoGroup = new THREE.Group();
    this.gizmoGroup.visible = false;

    this.gizmoBulb = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.18, 1),
      new THREE.MeshBasicMaterial({ color: 0xffd166, wireframe: true })
    );
    this.gizmoGroup.add(this.gizmoBulb);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -2, 0),
    ]);
    this.gizmoLine = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0x4f8cff })
    );
    this.gizmoGroup.add(this.gizmoLine);
    this.scene.add(this.gizmoGroup);
  }

  _updateLightGizmo() {
    const item = this.sceneLights.find((l) => l.id === this.selectedLightId);
    if (!item || !this.showLightGizmo) {
      this.gizmoGroup.visible = false;
      return;
    }
    this.gizmoGroup.visible = true;
    const worldPos = new THREE.Vector3();
    item.light.getWorldPosition(worldPos);
    this.gizmoBulb.position.copy(worldPos);
    this.gizmoBulb.material.color.copy(item.light.color);

    if (item.light.target) {
      const tgtPos = new THREE.Vector3();
      item.light.target.getWorldPosition(tgtPos);
      this.gizmoLine.visible = true;
      this.gizmoLine.geometry.setFromPoints([worldPos, tgtPos]);
    } else {
      this.gizmoLine.visible = false;
    }
  }

  _initPostPipeline() {
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadGeo = new THREE.PlaneGeometry(2, 2);

    this.ssgiMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SSGI_SSR_FRAG,
      uniforms: {
        tBeauty: { value: null },
        tDepth: { value: null },
        tGbuf: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uInvProj: { value: new THREE.Matrix4() },
        uProj: { value: new THREE.Matrix4() },
        uFrame: { value: 0 },
        uGiStrength: { value: this.settings.giStrength },
        uContactStrength: { value: this.settings.contactStrength },
        uSsrStrength: { value: this.settings.ssrStrength },
      },
    });

    this.accumMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: ACCUM_FRAG,
      uniforms: {
        tCurrent: { value: null },
        tPrevAccum: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uSampleCount: { value: 1 },
      },
    });

    this.bloomPreMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLOOM_PRE_FRAG,
      uniforms: {
        tAccum: { value: null },
        uExposure: { value: this.settings.exposure },
      },
    });

    this.bloomBlurMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLOOM_BLUR_FRAG,
      uniforms: {
        tInput: { value: null },
        uDirection: { value: new THREE.Vector2(1, 0) },
      },
    });

    this.postMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: POST_FRAG,
      uniforms: {
        tAccum: { value: null },
        tBloom: { value: null },
        tStreak: { value: null },
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 100.0 },
        uExposure: { value: this.settings.exposure },
        uBloomStrength: { value: this.settings.bloomStrength },
        uStreakStrength: { value: this.settings.streakStrength },
        uContrast: { value: this.settings.agxContrast },
        uColorTemp: { value: this.settings.colorTemp },
        uSaturation: { value: this.settings.saturation },
        uSharpness: { value: this.settings.sharpness },
        uChromaticAberration: { value: this.settings.chromaticAberration },
        uFilmGrain: { value: this.settings.filmGrain },
        uFogDensity: { value: this.settings.fogDensity },
        uFogColor: { value: this.settings.fogColor.clone() },
        uLinearOutput: { value: false },
      },
    });

    this.quadMesh = new THREE.Mesh(quadGeo, this.postMat);
    this.quadScene.add(this.quadMesh);
  }

  _createRenderTargets(w, h) {
    const dispose = (rt) => { if (rt) rt.dispose(); };
    dispose(this.sceneRT);
    dispose(this.gbufRT);
    dispose(this.ssgiRT);
    dispose(this.accumA);
    dispose(this.accumB);
    dispose(this.bloomA);
    dispose(this.bloomB);
    dispose(this.streakA);
    dispose(this.streakB);

    const linearOpts = {
      type: this.rtType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };

    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      ...linearOpts,
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType),
    });

    this.gbufRT = new THREE.WebGLRenderTarget(w, h, {
      type: this.rtType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    this.ssgiRT = new THREE.WebGLRenderTarget(w, h, linearOpts);
    this.accumA = new THREE.WebGLRenderTarget(w, h, linearOpts);
    this.accumB = new THREE.WebGLRenderTarget(w, h, linearOpts);
    this.accumIndex = 0;

    this.bloomW = Math.max(64, Math.floor(w / 4));
    this.bloomH = Math.max(64, Math.floor(h / 4));
    this.bloomA = new THREE.WebGLRenderTarget(this.bloomW, this.bloomH, linearOpts);
    this.bloomB = new THREE.WebGLRenderTarget(this.bloomW, this.bloomH, linearOpts);
    this.streakA = new THREE.WebGLRenderTarget(this.bloomW, this.bloomH, linearOpts);
    this.streakB = new THREE.WebGLRenderTarget(this.bloomW, this.bloomH, linearOpts);

    this.ssgiMat.uniforms.uResolution.value.set(w, h);
    this.accumMat.uniforms.uResolution.value.set(w, h);
    this.postMat.uniforms.uResolution.value.set(w, h);
  }

  _buildSingleGBufMat(origMat) {
    if (!origMat) {
      return new THREE.ShaderMaterial({
        vertexShader: GBUFFER_VERT,
        fragmentShader: GBUFFER_FRAG,
        uniforms: { uRoughness: { value: 0.65 } },
      });
    }
    const isGlass = origMat.transparent && origMat.opacity < 0.72;
    const defines = {};
    const uniforms = {
      uRoughness: { value: origMat.roughness !== undefined ? origMat.roughness : 0.7 },
    };
    if (origMat.roughnessMap) {
      defines.USE_ROUGHNESSMAP = '';
      uniforms.uRoughnessMap = { value: origMat.roughnessMap };
    }
    if (origMat.map && origMat.alphaTest > 0.01) {
      defines.USE_ALPHAMAP = '';
      uniforms.uMap = { value: origMat.map };
      uniforms.uAlphaTest = { value: origMat.alphaTest };
    }
    return new THREE.ShaderMaterial({
      vertexShader: GBUFFER_VERT,
      fragmentShader: GBUFFER_FRAG,
      defines,
      uniforms,
      side: origMat.side,
      depthWrite: isGlass ? false : origMat.depthWrite,
      colorWrite: !isGlass,
    });
  }

  _prepareGBufferMaterials() {
    this.gbufPairs.forEach((p) => {
      if (Array.isArray(p.gbufMat)) p.gbufMat.forEach((m) => m.dispose());
      else if (p.gbufMat) p.gbufMat.dispose();
    });
    this.gbufPairs = [];

    if (!this.loadedRoot) return;
    this.loadedRoot.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      const orig = obj.material;
      const gbufMat = Array.isArray(orig)
        ? orig.map((m) => this._buildSingleGBufMat(m))
        : this._buildSingleGBufMat(orig);
      this.gbufPairs.push({ mesh: obj, origMat: orig, gbufMat });
    });
  }

  bakeEnvironmentProbe() {
    if (!this.loadedRoot) return;
    const box = new THREE.Box3().setFromObject(this.loadedRoot);
    if (box.isEmpty()) return;

    const prevGizmo = this.gizmoGroup.visible;
    this.gizmoGroup.visible = false;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const diag = size.length();

    const probeNear = Math.min(Math.max(diag * 0.08, 0.3), 2.4);
    const cubeRT = new THREE.WebGLCubeRenderTarget(256, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    const cubeCam = new THREE.CubeCamera(probeNear, Math.max(diag * 3, 120), cubeRT);
    cubeCam.position.set(center.x, box.min.y + Math.min(size.y * 0.35, 2.1), center.z);

    const prevEnv = this.scene.environment;
    this.scene.environment = null;
    this.scene.updateMatrixWorld(true);
    cubeCam.update(this.renderer, this.scene);

    const nextEnvRT = this.pmrem.fromCubemap(cubeRT.texture);
    if (this.envRenderTarget) this.envRenderTarget.dispose();
    this.envRenderTarget = nextEnvRT;
    this.scene.environment = nextEnvRT.texture;
    this.scene.environmentIntensity = this.settings.envIntensity;

    cubeRT.dispose();
    if (!this.scene.environment && prevEnv) this.scene.environment = prevEnv;
    this.gizmoGroup.visible = prevGizmo;
    this.resetAccumulation();
  }

  setViewportScale(scale) {
    this.viewportScale = Math.max(0.35, Math.min(1.0, scale));
    this.resize(this.displayW, this.displayH);
  }

  resize(cssW, cssH, exactPixelSize = false) {
    if (!exactPixelSize) {
      this.displayW = Math.max(64, Math.floor(cssW));
      this.displayH = Math.max(64, Math.floor(cssH));
    }
    const scale = exactPixelSize ? 1.0 : this.viewportScale;
    this.width = Math.max(64, Math.floor(cssW * scale));
    this.height = Math.max(64, Math.floor(cssH * scale));
    this.renderer.setSize(this.width, this.height, false);
    this._updateCameraAspect(this.activeCamera, this.width / this.height);
    this._createRenderTargets(this.width, this.height);
    this.resetAccumulation();
  }

  _updateCameraAspect(cam, aspect) {
    if (cam && cam.isPerspectiveCamera) {
      cam.aspect = aspect;
      cam.near = Math.max(cam.near || 0.1, 0.05);
      cam.far = Math.min(cam.far || 1000, 1500);
      cam.updateProjectionMatrix();
    }
  }

  _buildDefaultDarkStudio() {
    this.loadedRoot = new THREE.Group();
    this.scene.add(this.loadedRoot);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.MeshStandardMaterial({ color: 0x16181f, roughness: 0.28, metalness: 0.15 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.loadedRoot.add(floor);

    const backWall = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 9),
      new THREE.MeshStandardMaterial({ color: 0x2b1608, emissive: 0x4a2408, emissiveIntensity: 0.85, roughness: 0.85 })
    );
    backWall.position.set(0, 4.5, -5.5);
    this.loadedRoot.add(backWall);

    const torus = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.85, 0.28, 160, 32),
      new THREE.MeshStandardMaterial({ color: 0xd9a05b, roughness: 0.15, metalness: 0.9 })
    );
    torus.position.set(0, 1.25, 0);
    torus.castShadow = true;
    torus.receiveShadow = true;
    this.loadedRoot.add(torus);

    const keyLight = new THREE.SpotLight(0xffe0b8, 28, 35, Math.PI / 4, 0.65, 2);
    keyLight.position.set(3.5, 5.2, 3.2);
    keyLight.target.position.set(0, 1, 0);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.bias = -0.0003;
    keyLight.shadow.normalBias = 0.02;
    this.loadedRoot.add(keyLight);
    this.loadedRoot.add(keyLight.target);

    this.sceneLights = [
      {
        id: 'light_0',
        name: 'Studio Key Spot',
        type: 'SPOT',
        light: keyLight,
        baseIntensity: 28,
        basePos: keyLight.position.clone(),
        radius: 0.45,
        energy: 28,
      },
    ];
  }

  async loadExtractedScene(glbUrl, meta) {
    if (this.loadedRoot) this.scene.remove(this.loadedRoot);
    this.blenderCameras.clear();
    this.sceneLights = [];
    let lightIdx = 0;

    if (meta?.world) {
      const [r, g, b] = meta.world.color;
      const s = (meta.world.strength ?? 0.05) * 0.25;
      this.scene.background = new THREE.Color(r * s, g * s, b * s);
    }

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(`${glbUrl}?t=${Date.now()}`);
    this.loadedRoot = gltf.scene;
    this.scene.add(this.loadedRoot);

    const metaLightMap = new Map((meta?.lights || []).map((l) => [l.name, l]));
    let warmestLightCol = new THREE.Color(0x1a1008);
    let maxWarmScore = -1;

    this.loadedRoot.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          if (!m) return;
          ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'].forEach((k) => {
            if (m[k]) {
              m[k].anisotropy = this.maxAnisotropy;
              m[k].needsUpdate = true;
            }
          });
        });
      }
      if (obj.isLight) {
        obj.castShadow = false;
        let baseInt = 5.0;
        let lType = 'POINT';
        if (obj.isSpotLight) {
          lType = 'SPOT';
          baseInt = Math.min(obj.intensity * 0.0022, 12.0);
          obj.distance = obj.distance || 50;
        } else if (obj.isPointLight) {
          lType = 'POINT';
          baseInt = Math.min(obj.intensity * 0.0022, 10.0);
          obj.distance = obj.distance || 40;
        } else if (obj.isDirectionalLight) {
          lType = 'DIRECTIONAL';
          baseInt = Math.min(obj.intensity * 0.12, 2.5);
        }
        obj.intensity = baseInt * this.settings.lightScale;

        const m = metaLightMap.get(obj.name);
        const niceName = obj.name || (obj.parent && obj.parent.name) || `${lType} ${lightIdx + 1}`;
        this.sceneLights.push({
          id: `light_${lightIdx++}`,
          name: `${niceName} (${lType})`,
          type: lType,
          light: obj,
          baseIntensity: baseInt,
          basePos: obj.position.clone(),
          radius: m ? Math.min(m.radius, 1.0) : 0.2,
          energy: m ? m.energy : baseInt,
        });
      }
      if (obj.isCamera) {
        this.blenderCameras.set(obj.name, obj);
        if (obj.parent && obj.parent.name) {
          this.blenderCameras.set(obj.parent.name, obj);
        }
      }
    });

    for (const l of meta?.lights || []) {
      if (l.type === 'AREA') {
        const color = new THREE.Color(l.color[0], l.color[1], l.color[2]);
        const area = Math.max((l.size_x || 1.0) * (l.size_y || 1.0), 0.5);
        const baseInt = Math.min(Math.max((l.energy / Math.sqrt(area)) * 0.014, 1.2), 26.0);
        const angle = Math.min(Math.max((l.spread || 1.8) * 0.52, 0.45), Math.PI * 0.45);

        const spot = new THREE.SpotLight(color, baseInt * this.settings.lightScale, 55, angle, 0.85, 2);
        spot.position.set(l.position[0], l.position[1], l.position[2]);
        const dir = l.direction || [0, -1, 0];
        spot.target.position.set(
          l.position[0] + dir[0] * 6,
          l.position[1] + dir[1] * 6,
          l.position[2] + dir[2] * 6
        );
        spot.castShadow = false;
        this.loadedRoot.add(spot);
        this.loadedRoot.add(spot.target);

        this.sceneLights.push({
          id: `light_${lightIdx++}`,
          name: `${l.name || 'Area'} (AREA→Spot)`,
          type: 'SPOT',
          light: spot,
          baseIntensity: baseInt,
          basePos: spot.position.clone(),
          radius: Math.min(Math.max(l.radius, 0.3), 1.1),
          energy: l.energy,
        });

        const warmScore = (l.color[0] + l.color[1] * 0.5) * l.energy;
        if (warmScore > maxWarmScore) {
          maxWarmScore = warmScore;
          warmestLightCol.copy(color).multiplyScalar(0.14);
        }
      }
    }

    const sorted = [...this.sceneLights].sort((a, b) => (b.energy || 0) - (a.energy || 0));
    let shadowCount = 0;
    for (const item of sorted) {
      if (shadowCount >= 4) break;
      if (item.light.isSpotLight || item.light.isDirectionalLight) {
        item.light.castShadow = true;
        const mapRes = shadowCount === 0 ? 2048 : 1024;
        item.light.shadow.mapSize.set(mapRes, mapRes);
        item.light.shadow.bias = -0.0003;
        item.light.shadow.normalBias = 0.02;
        shadowCount++;
      }
    }

    if (meta?.volume) {
      this.settings.fogColor.setRGB(
        warmestLightCol.r * meta.volume.color[0],
        warmestLightCol.g * meta.volume.color[1],
        warmestLightCol.b * meta.volume.color[2]
      );
    } else {
      this.settings.fogColor.copy(warmestLightCol);
    }
    this.postMat.uniforms.uFogColor.value.copy(this.settings.fogColor);

    this.loadedRoot.updateMatrixWorld(true);
    this._prepareGBufferMaterials();
    this.bakeEnvironmentProbe();

    if (meta?.active_camera && this.blenderCameras.has(meta.active_camera)) {
      this.setActiveCamera(meta.active_camera);
      const camMeta = (meta.cameras || []).find((c) => c.name === meta.active_camera);
      if (camMeta && camMeta.focus_distance) {
        this.settings.focusDistance = camMeta.focus_distance;
      }
    } else {
      this.setActiveCamera('__free__');
      this.fitFreeCameraToScene();
    }
    this.resetAccumulation();
  }

  // --- Modular Light Inspector API ---
  getLightsList() {
    return this.sceneLights.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      enabled: item.light.visible,
    }));
  }

  getLightProps(id) {
    const item = this.sceneLights.find((l) => l.id === id);
    if (!item) return null;
    const l = item.light;
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      enabled: l.visible,
      castShadow: !!l.castShadow,
      colorHex: `#${l.color.getHexString()}`,
      intensity: item.baseIntensity,
      pos: [item.basePos.x, item.basePos.y, item.basePos.z],
      target: l.target ? [l.target.position.x, l.target.position.y, l.target.position.z] : null,
      angleDeg: l.isSpotLight ? Math.round(THREE.MathUtils.radToDeg(l.angle)) : 45,
      penumbra: l.isSpotLight ? l.penumbra : 0.5,
      radius: item.radius,
      distance: l.distance || 50,
    };
  }

  selectLight(id, showGizmo = this.showLightGizmo) {
    this.selectedLightId = id;
    this.showLightGizmo = showGizmo;
    this._updateLightGizmo();
    this.resetAccumulation();
  }

  updateLightProps(id, props) {
    const item = this.sceneLights.find((l) => l.id === id);
    if (!item) return;
    const l = item.light;

    if ('enabled' in props) l.visible = !!props.enabled;
    if ('colorHex' in props) l.color.set(props.colorHex);
    if ('intensity' in props) {
      item.baseIntensity = props.intensity;
      l.intensity = item.baseIntensity * this.settings.lightScale;
    }
    if ('pos' in props) {
      item.basePos.set(props.pos[0], props.pos[1], props.pos[2]);
      l.position.copy(item.basePos);
    }
    if ('target' in props && l.target) {
      l.target.position.set(props.target[0], props.target[1], props.target[2]);
      l.target.updateMatrixWorld();
    }
    if ('angleDeg' in props && l.isSpotLight) {
      l.angle = THREE.MathUtils.degToRad(Math.max(5, Math.min(85, props.angleDeg)));
    }
    if ('penumbra' in props && l.isSpotLight) {
      l.penumbra = Math.max(0, Math.min(1, props.penumbra));
    }
    if ('radius' in props) item.radius = Math.max(0, props.radius);
    if ('distance' in props && 'distance' in l) l.distance = Math.max(1, props.distance);
    if ('castShadow' in props) {
      l.castShadow = !!props.castShadow;
      if (l.castShadow && l.shadow) {
        l.shadow.mapSize.set(1024, 1024);
        l.shadow.bias = -0.0003;
        l.shadow.normalBias = 0.02;
      }
    }

    this._updateLightGizmo();
    this.resetAccumulation();
  }

  addCustomLight(type = 'SPOT') {
    const id = `light_custom_${Date.now()}`;
    const count = this.sceneLights.length + 1;
    let light;

    const box = new THREE.Box3().setFromObject(this.loadedRoot);
    const center = box.isEmpty() ? new THREE.Vector3(0, 1, 0) : box.getCenter(new THREE.Vector3());

    if (type === 'SPOT') {
      light = new THREE.SpotLight(0xffdcb8, 16 * this.settings.lightScale, 55, Math.PI / 4, 0.8, 2);
      light.position.set(center.x + 3.5, center.y + 4.0, center.z + 3.5);
      light.target.position.copy(center);
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.bias = -0.0003;
      light.shadow.normalBias = 0.02;
      this.loadedRoot.add(light);
      this.loadedRoot.add(light.target);
    } else {
      light = new THREE.PointLight(0x88b8ff, 12 * this.settings.lightScale, 40, 2);
      light.position.set(center.x - 3.0, center.y + 2.5, center.z - 2.0);
      light.castShadow = false;
      this.loadedRoot.add(light);
    }

    const item = {
      id,
      name: `Custom ${type} #${count}`,
      type,
      light,
      baseIntensity: type === 'SPOT' ? 16 : 12,
      basePos: light.position.clone(),
      radius: 0.4,
      energy: 16,
    };
    this.sceneLights.push(item);
    this.selectLight(id, true);
    return id;
  }

  setActiveCamera(name) {
    if (name === '__free__' || !this.blenderCameras.has(name)) {
      this.activeCamera = this.freeCamera;
      this.controls.enabled = true;
    } else {
      this.activeCamera = this.blenderCameras.get(name);
      this.controls.enabled = false;
    }
    this._updateCameraAspect(this.activeCamera, this.width / this.height);
    this.resetAccumulation();
  }

  fitFreeCameraToScene() {
    if (!this.loadedRoot) return;
    const box = new THREE.Box3().setFromObject(this.loadedRoot);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(center);
    this.freeCamera.position.copy(center).add(new THREE.Vector3(size * 0.55, size * 0.3, size * 0.65));
    this.controls.update();
    this.resetAccumulation();
  }

  focusAtNormalizedCoords(ndcX, ndcY) {
    if (!this.loadedRoot) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.activeCamera);
    const hits = raycaster.intersectObject(this.loadedRoot, true);
    if (hits.length > 0) {
      const dist = Math.max(0.5, Math.min(40.0, hits[0].distance));
      this.updateSettings({ focusDistance: dist });
      return dist;
    }
    return null;
  }

  updateSettings(partial) {
    Object.assign(this.settings, partial);

    if ('lightScale' in partial) {
      for (const item of this.sceneLights) {
        item.light.intensity = item.baseIntensity * this.settings.lightScale;
      }
    }
    if ('envIntensity' in partial) {
      this.scene.environmentIntensity = this.settings.envIntensity;
    }

    this.ssgiMat.uniforms.uGiStrength.value = this.settings.giStrength;
    this.ssgiMat.uniforms.uContactStrength.value = this.settings.contactStrength;
    this.ssgiMat.uniforms.uSsrStrength.value = this.settings.ssrStrength;

    this.bloomPreMat.uniforms.uExposure.value = this.settings.exposure;
    this.postMat.uniforms.uExposure.value = this.settings.exposure;
    this.postMat.uniforms.uBloomStrength.value = this.settings.bloomStrength;
    this.postMat.uniforms.uStreakStrength.value = this.settings.streakStrength;
    this.postMat.uniforms.uContrast.value = this.settings.agxContrast;
    this.postMat.uniforms.uColorTemp.value = this.settings.colorTemp;
    this.postMat.uniforms.uSaturation.value = this.settings.saturation;
    this.postMat.uniforms.uSharpness.value = this.settings.sharpness;
    this.postMat.uniforms.uChromaticAberration.value = this.settings.chromaticAberration;
    this.postMat.uniforms.uFilmGrain.value = this.settings.filmGrain;
    this.postMat.uniforms.uFogDensity.value = this.settings.fogDensity;

    const needsReaccum =
      'lightScale' in partial ||
      'envIntensity' in partial ||
      'giStrength' in partial ||
      'ssrStrength' in partial ||
      'contactStrength' in partial ||
      'shadowSoftness' in partial ||
      'dofAperture' in partial ||
      'focusDistance' in partial;

    if (needsReaccum) {
      this.resetAccumulation();
    } else {
      this.renderDisplayPass(null, false);
    }
  }

  resetAccumulation() {
    this.sampleCount = 0;
  }

  stepSample() {
    this.sampleCount += 1;
    const n = this.sampleCount;

    const soft = this.settings.shadowSoftness;
    for (let i = 0; i < this.sceneLights.length; i++) {
      const item = this.sceneLights[i];
      if (soft > 0 && item.radius > 0 && !item.light.isDirectionalLight) {
        const rx = (halton(n + i * 17, 5) - 0.5) * 2.0 * item.radius * soft;
        const ry = (halton(n + i * 29, 7) - 0.5) * 2.0 * item.radius * soft;
        const rz = (halton(n + i * 43, 11) - 0.5) * 2.0 * item.radius * soft;
        item.light.position.set(item.basePos.x + rx, item.basePos.y + ry, item.basePos.z + rz);
      } else {
        item.light.position.copy(item.basePos);
      }
    }

    this.scene.updateMatrixWorld(true);

    const cam = this.activeCamera;
    cam.updateProjectionMatrix();
    const origMatrixWorld = cam.matrixWorld.clone();

    const jx = (halton(n, 2) - 0.5) * (2.0 / this.width);
    const jy = (halton(n, 3) - 0.5) * (2.0 / this.height);
    cam.projectionMatrix.elements[8] += jx;
    cam.projectionMatrix.elements[9] += jy;

    const aperture = this.settings.dofAperture;
    if (aperture > 0.0005 && cam.isPerspectiveCamera) {
      const r = Math.sqrt(halton(n, 5)) * aperture;
      const theta = halton(n, 7) * Math.PI * 2.0;
      const ox = r * Math.cos(theta);
      const oy = r * Math.sin(theta);

      const right = new THREE.Vector3().setFromMatrixColumn(origMatrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(origMatrixWorld, 1).normalize();
      cam.matrixWorld.elements[12] += right.x * ox + up.x * oy;
      cam.matrixWorld.elements[13] += right.y * ox + up.y * oy;
      cam.matrixWorld.elements[14] += right.z * ox + up.z * oy;
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

      const fDist = Math.max(this.settings.focusDistance, 0.5);
      cam.projectionMatrix.elements[8] -= (cam.projectionMatrix.elements[0] * ox) / fDist;
      cam.projectionMatrix.elements[9] -= (cam.projectionMatrix.elements[5] * oy) / fDist;
    }

    this.scene.matrixWorldAutoUpdate = false;

    // Pass 1A: Linear HDR Beauty + Depth
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.render(this.scene, cam);

    // Pass 1B: Smooth View-Space Normals + Roughness G-Buffer (hide gizmo)
    const prevBg = this.scene.background;
    const prevGizmo = this.gizmoGroup.visible;
    this.scene.background = null;
    this.gizmoGroup.visible = false;
    for (let i = 0; i < this.gbufPairs.length; i++) {
      this.gbufPairs[i].mesh.material = this.gbufPairs[i].gbufMat;
    }
    this.renderer.setRenderTarget(this.gbufRT);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    for (let i = 0; i < this.gbufPairs.length; i++) {
      this.gbufPairs[i].mesh.material = this.gbufPairs[i].origMat;
    }
    this.scene.background = prevBg;
    this.gizmoGroup.visible = prevGizmo;

    cam.matrixWorld.copy(origMatrixWorld);
    cam.matrixWorldInverse.copy(origMatrixWorld).invert();
    cam.updateProjectionMatrix();
    this.scene.matrixWorldAutoUpdate = true;

    // Pass 2: GTAO + SSGI + Validated SSR
    this.ssgiMat.uniforms.tBeauty.value = this.sceneRT.texture;
    this.ssgiMat.uniforms.tDepth.value = this.sceneRT.depthTexture;
    this.ssgiMat.uniforms.tGbuf.value = this.gbufRT.texture;
    this.ssgiMat.uniforms.uInvProj.value.copy(cam.projectionMatrixInverse);
    this.ssgiMat.uniforms.uProj.value.copy(cam.projectionMatrix);
    this.ssgiMat.uniforms.uFrame.value = n;
    this.quadMesh.material = this.ssgiMat;
    this.renderer.setRenderTarget(this.ssgiRT);
    this.renderer.render(this.quadScene, this.quadCam);

    // Pass 3: Firefly-Suppressing 32F Accumulation
    const readRT = this.accumIndex === 0 ? this.accumA : this.accumB;
    const writeRT = this.accumIndex === 0 ? this.accumB : this.accumA;
    this.accumMat.uniforms.tCurrent.value = this.ssgiRT.texture;
    this.accumMat.uniforms.tPrevAccum.value = readRT.texture;
    this.accumMat.uniforms.uSampleCount.value = n;
    this.quadMesh.material = this.accumMat;
    this.renderer.setRenderTarget(writeRT);
    this.renderer.render(this.quadScene, this.quadCam);

    this.accumIndex = 1 - this.accumIndex;
  }

  getLatestAccumRT() {
    return this.accumIndex === 0 ? this.accumA : this.accumB;
  }

  renderDisplayPass(targetRT = null, linearOutput = false) {
    const accumTex = this.getLatestAccumRT().texture;
    const needGlow = this.settings.bloomStrength > 0.001 || this.settings.streakStrength > 0.001;

    if (needGlow) {
      // Extract HDR highlights once at quarter-res
      this.bloomPreMat.uniforms.tAccum.value = accumTex;
      this.bloomPreMat.uniforms.uExposure.value = this.settings.exposure;
      this.quadMesh.material = this.bloomPreMat;
      this.renderer.setRenderTarget(this.bloomA);
      this.renderer.render(this.quadScene, this.quadCam);

      // Copy into streak buffer and stretch horizontally for authentic cinema anamorphic lens streaks
      if (this.settings.streakStrength > 0.001) {
        this.bloomBlurMat.uniforms.tInput.value = this.bloomA.texture;
        this.bloomBlurMat.uniforms.uDirection.value.set(2.5 / this.bloomW, 0);
        this.quadMesh.material = this.bloomBlurMat;
        this.renderer.setRenderTarget(this.streakB);
        this.renderer.render(this.quadScene, this.quadCam);

        const steps = [5.0, 9.0, 14.0];
        let readTex = this.streakB.texture;
        let writeRT = this.streakA;
        let altRT = this.streakB;
        for (const s of steps) {
          this.bloomBlurMat.uniforms.tInput.value = readTex;
          this.bloomBlurMat.uniforms.uDirection.value.set(s / this.bloomW, 0);
          this.renderer.setRenderTarget(writeRT);
          this.renderer.render(this.quadScene, this.quadCam);
          readTex = writeRT.texture;
          [writeRT, altRT] = [altRT, writeRT];
        }
        // Ensure final horizontal streak sits in streakA
        if (readTex !== this.streakA.texture) {
          this.bloomBlurMat.uniforms.tInput.value = readTex;
          this.bloomBlurMat.uniforms.uDirection.value.set(0, 0.5 / this.bloomH);
          this.renderer.setRenderTarget(this.streakA);
          this.renderer.render(this.quadScene, this.quadCam);
        }
      }

      // Separable Gaussian Fog Glow
      if (this.settings.bloomStrength > 0.001) {
        for (let i = 0; i < 2; i++) {
          const scale = i === 0 ? 1.0 : 2.0;
          this.bloomBlurMat.uniforms.tInput.value = this.bloomA.texture;
          this.bloomBlurMat.uniforms.uDirection.value.set(scale / this.bloomW, 0);
          this.quadMesh.material = this.bloomBlurMat;
          this.renderer.setRenderTarget(this.bloomB);
          this.renderer.render(this.quadScene, this.quadCam);

          this.bloomBlurMat.uniforms.tInput.value = this.bloomB.texture;
          this.bloomBlurMat.uniforms.uDirection.value.set(0, scale / this.bloomH);
          this.renderer.setRenderTarget(this.bloomA);
          this.renderer.render(this.quadScene, this.quadCam);
        }
      }
    }

    // Final Cinema Composite
    const cam = this.activeCamera;
    this.postMat.uniforms.tAccum.value = accumTex;
    this.postMat.uniforms.tBloom.value = this.bloomA.texture;
    this.postMat.uniforms.tStreak.value = this.streakA.texture;
    this.postMat.uniforms.tDepth.value = this.sceneRT.depthTexture;
    this.postMat.uniforms.uCameraNear.value = cam.near || 0.1;
    this.postMat.uniforms.uCameraFar.value = cam.far || 1000.0;
    this.postMat.uniforms.uLinearOutput.value = linearOutput;
    this.quadMesh.material = this.postMat;
    this.renderer.setRenderTarget(targetRT);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  async renderOfflineFloatBuffer(targetW, targetH, samples, thermalDelayMs, onProgress) {
    const prevGizmo = this.gizmoGroup.visible;
    this.gizmoGroup.visible = false;

    this.resize(targetW, targetH, true);

    for (let i = 1; i <= samples; i++) {
      this.stepSample();
      if (onProgress) onProgress(i, samples);
      await new Promise((r) => setTimeout(r, thermalDelayMs));
    }

    const exportRT = new THREE.WebGLRenderTarget(targetW, targetH, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
    });
    return {
      extractBuffer: (linear) => {
        this.renderDisplayPass(exportRT, linear);
        const pixels = new Float32Array(targetW * targetH * 4);
        this.renderer.readRenderTargetPixels(exportRT, 0, 0, targetW, targetH, pixels);
        exportRT.dispose();
        this.gizmoGroup.visible = prevGizmo;
        this.resize(this.displayW, this.displayH, false);
        return pixels;
      },
    };
  }
}