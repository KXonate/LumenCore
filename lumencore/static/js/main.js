import { LumenEngine } from './engine.js';
import { LightInspector } from './light_inspector.js';

const canvas = document.getElementById('glCanvas');
const engine = new LumenEngine(canvas);
const lightInspector = new LightInspector(engine);

const hudSamples = document.getElementById('hudSamples');
const hudPipeline = document.getElementById('hudPipeline');
const hudStatus = document.getElementById('hudStatus');
const progressWrap = document.getElementById('progressBarWrap');
const progressBar = document.getElementById('progressBar');

hudPipeline.textContent = engine.supportsFloat32
  ? 'Pipeline: WebGL2 32F Cinema'
  : 'Pipeline: WebGL2 16F Cinema';

let isOfflineRendering = false;

fetch('/api/status')
  .then((r) => r.json())
  .then((d) => {
    if (d.blender_path) document.getElementById('blenderPath').value = d.blender_path;
  });

const resizeViewport = () => {
  if (isOfflineRendering) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  engine.resize(rect.width, rect.height, false);
};
window.addEventListener('resize', resizeViewport);
resizeViewport();

function animate() {
  requestAnimationFrame(animate);
  if (isOfflineRendering) return;

  engine.controls.update();
  if (engine.sampleCount < engine.maxViewportSamples) {
    engine.stepSample();
    engine.renderDisplayPass(null, false);
    hudSamples.textContent = `Samples: ${engine.sampleCount} / ${engine.maxViewportSamples}`;
  }
}
animate();

// Shift + Click autofocus
canvas.addEventListener('pointerdown', (e) => {
  if (!e.shiftKey || isOfflineRendering) return;
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  const dist = engine.focusAtNormalizedCoords(ndcX, ndcY);
  if (dist !== null) {
    document.getElementById('focusDist').value = dist.toFixed(1);
    document.getElementById('valFocus').textContent = dist.toFixed(2);
    hudStatus.textContent = `Focused @ ${dist.toFixed(2)}m`;
  }
});

const dropZone = document.getElementById('dropZone');
const blendInput = document.getElementById('blendInput');
const dropText = document.getElementById('dropText');
const sceneInfo = document.getElementById('sceneInfo');
const cameraSelect = document.getElementById('cameraSelect');

async function loadSceneIntoEngine(glbUrl, meta, label) {
  hudStatus.textContent = 'Building G-Buffer & Baking 360° HDR Probe...';
  await engine.loadExtractedScene(glbUrl, meta);

  cameraSelect.innerHTML = '<option value="__free__">Free Orbit Camera</option>';
  (meta.cameras || []).forEach((cam) => {
    const opt = document.createElement('option');
    opt.value = cam.name;
    opt.textContent = `${cam.name} (${cam.lens_mm.toFixed(0)}mm)`;
    cameraSelect.appendChild(opt);
  });
  if (meta.active_camera) cameraSelect.value = meta.active_camera;

  if (meta.resolution) {
    document.getElementById('outWidth').value = meta.resolution[0];
    document.getElementById('outHeight').value = meta.resolution[1];
  }

  document.getElementById('focusDist').value = engine.settings.focusDistance.toFixed(1);
  document.getElementById('valFocus').textContent = engine.settings.focusDistance.toFixed(2);

  lightInspector.refreshList();

  sceneInfo.textContent = `${label} • ${meta.cameras.length} cam(s) • ${engine.getLightsList().length} light(s)`;
  dropText.innerHTML = `Loaded <strong>${label}</strong> (drop another to replace)`;
  hudStatus.textContent = 'Ready (Shift+Click to Focus)';
}

async function handleBlendFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.blend')) {
    alert('Please select a valid .blend file.');
    return;
  }
  hudStatus.textContent = 'Extracting .blend via Headless Blender...';
  dropText.textContent = `Extracting ${file.name}...`;

  const form = new FormData();
  form.append('file', file);
  form.append('blender_path', document.getElementById('blenderPath').value);

  try {
    const res = await fetch('/api/upload_blend', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.details || data.error);
    await loadSceneIntoEngine(data.glb_url, data.meta, file.name);
  } catch (err) {
    hudStatus.textContent = 'Extraction Failed';
    dropText.textContent = 'Drop .blend file here or click to browse';
    alert(`Blender Extraction Error:\n${err.message}`);
  }
}

// Reload already-extracted workspace scene instantly without waiting for Blender
document.getElementById('btnReloadLast').addEventListener('click', async () => {
  try {
    const res = await fetch(`/workspace/scene_meta.json?t=${Date.now()}`);
    if (!res.ok) throw new Error('No extracted scene found in workspace yet.');
    const meta = await res.json();
    await loadSceneIntoEngine('/workspace/scene.glb', meta, meta.scene_name || 'Last Scene');
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('viewportScale').addEventListener('change', (e) => {
  engine.setViewportScale(parseFloat(e.target.value));
});

dropZone.addEventListener('click', () => blendInput.click());
blendInput.addEventListener('change', (e) => handleBlendFile(e.target.files[0]));
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleBlendFile(e.dataTransfer.files[0]);
});

cameraSelect.addEventListener('change', (e) => engine.setActiveCamera(e.target.value));
document.getElementById('btnResetAccum').addEventListener('click', () => engine.resetAccumulation());
document.getElementById('btnFitScene').addEventListener('click', () => {
  cameraSelect.value = '__free__';
  engine.setActiveCamera('__free__');
  engine.fitFreeCameraToScene();
});
document.getElementById('btnRebakeProbe').addEventListener('click', () => {
  hudStatus.textContent = 'Re-baking 360° HDR Probe...';
  engine.bakeEnvironmentProbe();
  hudStatus.textContent = 'HDR Probe Updated';
});

const bindSlider = (id, labelId, key) => {
  const el = document.getElementById(id);
  const lbl = document.getElementById(labelId);
  el.addEventListener('input', () => {
    const val = parseFloat(el.value);
    lbl.textContent = val.toFixed(2);
    engine.updateSettings({ [key]: val });
  });
};

bindSlider('exposure', 'valExposure', 'exposure');
bindSlider('lightScale', 'valLightScale', 'lightScale');
bindSlider('envIntensity', 'valEnv', 'envIntensity');
bindSlider('ssrStrength', 'valSsr', 'ssrStrength');
bindSlider('giStrength', 'valGi', 'giStrength');
bindSlider('contactStrength', 'valContact', 'contactStrength');
bindSlider('shadowSoftness', 'valSoftness', 'shadowSoftness');
bindSlider('fogDensity', 'valFog', 'fogDensity');
bindSlider('dofAperture', 'valDof', 'dofAperture');
bindSlider('focusDist', 'valFocus', 'focusDistance');
bindSlider('bloomStrength', 'valBloom', 'bloomStrength');
bindSlider('streakStrength', 'valStreak', 'streakStrength');
bindSlider('agxContrast', 'valContrast', 'agxContrast');
bindSlider('colorTemp', 'valTemp', 'colorTemp');
bindSlider('saturation', 'valSat', 'saturation');
bindSlider('sharpness', 'valSharp', 'sharpness');
bindSlider('chromaticAberration', 'valCa', 'chromaticAberration');
bindSlider('filmGrain', 'valGrain', 'filmGrain');

const btnRender = document.getElementById('btnRender');
btnRender.addEventListener('click', async () => {
  if (isOfflineRendering) return;
  isOfflineRendering = true;
  btnRender.disabled = true;
  progressWrap.classList.remove('hidden');

  const w = parseInt(document.getElementById('outWidth').value, 10);
  const h = parseInt(document.getElementById('outHeight').value, 10);
  const samples = parseInt(document.getElementById('outSamples').value, 10);
  const delayMs = parseInt(document.getElementById('thermalGuard').value, 10);
  const fmt = document.getElementById('outFormat').value;
  const depth = parseInt(document.getElementById('outDepth').value, 10);

  try {
    hudStatus.textContent = `Rendering ${w}x${h} (${samples} spp)...`;
    const job = await engine.renderOfflineFloatBuffer(w, h, samples, delayMs, (cur, total) => {
      progressBar.style.width = `${(cur / total) * 100}%`;
      hudSamples.textContent = `Render: ${cur} / ${total}`;
    });

    hudStatus.textContent = `Encoding ${depth}-bit ${fmt.toUpperCase()}...`;
    const linear = fmt === 'exr' || depth === 32;
    const floatPixels = job.extractBuffer(linear);

    const res = await fetch('/api/export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Width': String(w),
        'X-Height': String(h),
        'X-Format': fmt,
        'X-Depth': String(depth),
      },
      body: floatPixels.buffer,
    });

    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lumencore_${w}x${h}_${depth}bit.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);

    hudStatus.textContent = 'Export Complete';
  } catch (err) {
    hudStatus.textContent = 'Render Error';
    alert(`Export failed:\n${err.message}`);
  } finally {
    isOfflineRendering = false;
    btnRender.disabled = false;
    progressWrap.classList.add('hidden');
    progressBar.style.width = '0%';
  }
});