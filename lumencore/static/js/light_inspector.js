export class LightInspector {
  constructor(engine) {
    this.engine = engine;
    this.selectEl = document.getElementById('lightSelect');
    this.controlsWrap = document.getElementById('lightControls');
    this.spotWrap = document.getElementById('lightSpotWrap');

    this.elEnabled = document.getElementById('lightEnabled');
    this.elShadow = document.getElementById('lightShadow');
    this.elGizmo = document.getElementById('lightGizmo');
    this.elColor = document.getElementById('lightColor');
    this.elIntensity = document.getElementById('lightIntensity');
    this.valIntensity = document.getElementById('valLInt');

    this.elPos = [
      document.getElementById('lightPosX'),
      document.getElementById('lightPosY'),
      document.getElementById('lightPosZ'),
    ];
    this.elTgt = [
      document.getElementById('lightTgtX'),
      document.getElementById('lightTgtY'),
      document.getElementById('lightTgtZ'),
    ];

    this.elAngle = document.getElementById('lightAngle');
    this.valAngle = document.getElementById('valLAngle');
    this.elPenumbra = document.getElementById('lightPenumbra');
    this.valPenumbra = document.getElementById('valLPen');
    this.elRadius = document.getElementById('lightRadius');
    this.valRadius = document.getElementById('valLRad');
    this.elDistance = document.getElementById('lightDistance');
    this.valDistance = document.getElementById('valLDist');

    this._bindEvents();
    this.refreshList();
  }

  _bindEvents() {
    this.selectEl.addEventListener('change', () => {
      this._loadSelected(this.selectEl.value);
    });

    document.getElementById('btnAddSpot').addEventListener('click', () => {
      const id = this.engine.addCustomLight('SPOT');
      this.elGizmo.checked = true;
      this.refreshList(id);
    });

    document.getElementById('btnAddPoint').addEventListener('click', () => {
      const id = this.engine.addCustomLight('POINT');
      this.elGizmo.checked = true;
      this.refreshList(id);
    });

    const push = (props) => {
      const id = this.selectEl.value;
      if (id) this.engine.updateLightProps(id, props);
    };

    this.elEnabled.addEventListener('change', () => push({ enabled: this.elEnabled.checked }));
    this.elShadow.addEventListener('change', () => push({ castShadow: this.elShadow.checked }));
    this.elGizmo.addEventListener('change', () => {
      this.engine.selectLight(this.selectEl.value, this.elGizmo.checked);
    });
    this.elColor.addEventListener('input', () => push({ colorHex: this.elColor.value }));

    this.elIntensity.addEventListener('input', () => {
      const v = parseFloat(this.elIntensity.value);
      this.valIntensity.textContent = v.toFixed(1);
      push({ intensity: v });
    });

    this.elPos.forEach((inp) => {
      inp.addEventListener('input', () => {
        const vals = this.elPos.map((e) => parseFloat(e.value) || 0);
        push({ pos: vals });
      });
    });

    this.elTgt.forEach((inp) => {
      inp.addEventListener('input', () => {
        const vals = this.elTgt.map((e) => parseFloat(e.value) || 0);
        push({ target: vals });
      });
    });

    this.elAngle.addEventListener('input', () => {
      const v = parseFloat(this.elAngle.value);
      this.valAngle.textContent = `${v.toFixed(0)}°`;
      push({ angleDeg: v });
    });

    this.elPenumbra.addEventListener('input', () => {
      const v = parseFloat(this.elPenumbra.value);
      this.valPenumbra.textContent = v.toFixed(2);
      push({ penumbra: v });
    });

    this.elRadius.addEventListener('input', () => {
      const v = parseFloat(this.elRadius.value);
      this.valRadius.textContent = v.toFixed(2);
      push({ radius: v });
    });

    this.elDistance.addEventListener('input', () => {
      const v = parseFloat(this.elDistance.value);
      this.valDistance.textContent = v.toFixed(0);
      push({ distance: v });
    });
  }

  refreshList(selectId = null) {
    const lights = this.engine.getLightsList();
    this.selectEl.innerHTML = '';

    if (lights.length === 0) {
      this.controlsWrap.classList.add('hidden');
      const opt = document.createElement('option');
      opt.textContent = 'No Lights (Click + Spot)';
      this.selectEl.appendChild(opt);
      return;
    }

    this.controlsWrap.classList.remove('hidden');
    lights.forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name;
      this.selectEl.appendChild(opt);
    });

    const targetId = selectId && lights.some((l) => l.id === selectId) ? selectId : lights[0].id;
    this.selectEl.value = targetId;
    this._loadSelected(targetId);
  }

  _loadSelected(id) {
    const p = this.engine.getLightProps(id);
    if (!p) return;

    this.engine.selectLight(id, this.elGizmo.checked);

    this.elEnabled.checked = p.enabled;
    this.elShadow.checked = p.castShadow;
    this.elColor.value = p.colorHex;

    this.elIntensity.max = Math.max(100, Math.ceil(p.intensity * 2));
    this.elIntensity.value = p.intensity;
    this.valIntensity.textContent = p.intensity.toFixed(1);

    p.pos.forEach((v, i) => { this.elPos[i].value = v.toFixed(2); });

    const hasTarget = !!p.target;
    this.spotWrap.classList.toggle('hidden', !hasTarget);
    if (hasTarget) {
      p.target.forEach((v, i) => { this.elTgt[i].value = v.toFixed(2); });
      this.elAngle.value = p.angleDeg;
      this.valAngle.textContent = `${p.angleDeg}°`;
      this.elPenumbra.value = p.penumbra;
      this.valPenumbra.textContent = p.penumbra.toFixed(2);
    }

    this.elRadius.value = p.radius;
    this.valRadius.textContent = p.radius.toFixed(2);
    this.elDistance.value = Math.min(150, p.distance);
    this.valDistance.textContent = Math.round(p.distance);
  }
}