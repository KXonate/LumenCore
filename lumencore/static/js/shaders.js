export const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Pass 1B: Smooth Interpolated View-Space Normals + Per-Pixel Roughness G-Buffer
export const GBUFFER_VERT = /* glsl */ `
  varying vec3 vViewNormal;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mvPos = vec4(position, 1.0);
    vec3 objNormal = normal;
    #ifdef USE_INSTANCING
      mvPos = instanceMatrix * mvPos;
      objNormal = mat3(instanceMatrix) * objNormal;
    #endif
    vViewNormal = normalize(normalMatrix * objNormal);
    gl_Position = projectionMatrix * modelViewMatrix * mvPos;
  }
`;

export const GBUFFER_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vViewNormal;
  varying vec2 vUv;

  uniform float uRoughness;
  #ifdef USE_ROUGHNESSMAP
    uniform sampler2D uRoughnessMap;
  #endif
  #ifdef USE_ALPHAMAP
    uniform sampler2D uMap;
    uniform float uAlphaTest;
  #endif

  void main() {
    #ifdef USE_ALPHAMAP
      if (texture2D(uMap, vUv).a < uAlphaTest) discard;
    #endif

    vec3 n = normalize(vViewNormal);
    if (!gl_FrontFacing) n = -n;

    float rough = uRoughness;
    #ifdef USE_ROUGHNESSMAP
      rough *= texture2D(uRoughnessMap, vUv).g;
    #endif

    gl_FragColor = vec4(n, clamp(rough, 0.05, 1.0));
  }
`;

// Pass 2: Smooth-Normal GTAO + Anti-Flood SSGI + Artifact-Free Validated SSR
export const SSGI_SSR_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tBeauty;
  uniform sampler2D tDepth;
  uniform sampler2D tGbuf;
  uniform vec2 uResolution;
  uniform mat4 uInvProj;
  uniform mat4 uProj;
  uniform float uFrame;
  uniform float uGiStrength;
  uniform float uContactStrength;
  uniform float uSsrStrength;

  float ign(vec2 p, float frame) {
    p += frame * vec2(5.588238, 7.123456);
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  vec3 getViewPos(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 view = uInvProj * clip;
    return view.xyz / view.w;
  }

  vec3 projectToScreen(vec3 viewPos) {
    vec4 clip = uProj * vec4(viewPos, 1.0);
    vec3 ndc = clip.xyz / clip.w;
    return ndc * 0.5 + 0.5;
  }

  void main() {
    vec4 beauty = texture2D(tBeauty, vUv);
    float rawDepth = texture2D(tDepth, vUv).r;

    if (rawDepth >= 0.9999) {
      gl_FragColor = beauty;
      return;
    }

    vec3 viewPos = getViewPos(vUv, rawDepth);
    float viewDist = length(viewPos);
    vec3 viewDir = viewPos / max(viewDist, 1e-4);

    // Geometric normal from depth validates G-buffer normal (stops windshield interior splatter)
    vec3 geoNormal = normalize(cross(dFdx(viewPos), dFdy(viewPos)));
    if (dot(geoNormal, viewDir) > 0.0) geoNormal = -geoNormal;

    vec4 gbuf = texture2D(tGbuf, vUv);
    bool hasGbuf = length(gbuf.xyz) > 0.05;
    vec3 normal = hasGbuf ? normalize(gbuf.xyz) : geoNormal;
    if (dot(normal, viewDir) > 0.0) normal = -normal;
    float normalMatch = smoothstep(0.20, 0.65, dot(normal, geoNormal));
    if (normalMatch < 0.05) normal = geoNormal;

    float roughness = hasGbuf ? clamp(gbuf.w, 0.05, 1.0) : 0.65;

    vec2 texel = 1.0 / uResolution;
    float n1 = ign(gl_FragCoord.xy, uFrame);
    float n2 = ign(gl_FragCoord.xy + vec2(37.0, 17.0), uFrame);
    float n3 = ign(gl_FragCoord.xy + vec2(73.0, 91.0), uFrame);

    // 1. Ground-Truth Contact Shadows (GTAO) + Clamped Indirect Bounce (SSGI)
    vec3 giBounce = vec3(0.0);
    float occlusion = 0.0;
    const int RAYS = 10;
    float goldenAngle = 2.39996323;

    for (int i = 0; i < RAYS; i++) {
      float fi = float(i);
      float angle = (fi + n1) * goldenAngle + uFrame * 0.6180339;
      vec2 dir = vec2(cos(angle), sin(angle));

      float cDist = mix(2.0, 22.0, fract(n2 + fi * 0.31));
      vec2 cUv = vUv + dir * texel * cDist;
      if (cUv.x > 0.0 && cUv.x < 1.0 && cUv.y > 0.0 && cUv.y < 1.0) {
        float cDepth = texture2D(tDepth, cUv).r;
        if (cDepth < 0.9999) {
          vec3 samplePos = getViewPos(cUv, cDepth);
          vec3 diff = samplePos - viewPos;
          float dist = length(diff);
          if (dist > 0.015 && dist < 1.25) {
            float ndotl = max(dot(normal, diff / dist) - 0.08, 0.0);
            float falloff = 1.0 - smoothstep(0.08, 1.25, dist);
            occlusion += ndotl * falloff;
          }
        }
      }

      if (uGiStrength > 0.01) {
        float giRadius = mix(18.0, 105.0, fract(n3 + fi / float(RAYS)));
        vec2 giUv = vUv + dir * texel * giRadius;
        if (giUv.x > 0.0 && giUv.x < 1.0 && giUv.y > 0.0 && giUv.y < 1.0) {
          float gDepth = texture2D(tDepth, giUv).r;
          if (gDepth < 0.9999) {
            vec3 gPos = getViewPos(giUv, gDepth);
            vec3 diff = gPos - viewPos;
            float dist = length(diff);
            if (dist > 0.18 && dist < 6.0) {
              float facing = max(dot(normal, diff / dist), 0.0);
              float atten = 1.0 / (1.0 + dist * dist * 0.5);
              vec3 sampleCol = min(texture2D(tBeauty, giUv).rgb, vec3(1.0));
              giBounce += sampleCol * facing * atten;
            }
          }
        }
      }
    }

    occlusion = clamp((occlusion / float(RAYS)) * 2.8 * uContactStrength, 0.0, 0.94);
    giBounce /= float(RAYS);

    float localLum = dot(beauty.rgb, vec3(0.2126, 0.7152, 0.0722));
    float albedoProxy = clamp(localLum * 1.4 + 0.10, 0.10, 0.85);
    float diffuseWeight = mix(0.25, 1.0, roughness);

    // 2. Self-Intersection-Free Roughness-Aware Stochastic SSR
    vec3 ssrColor = vec3(0.0);
    float ssrWeight = 0.0;

    if (uSsrStrength > 0.01 && roughness < 0.62 && normalMatch > 0.3) {
      vec3 reflDir = reflect(viewDir, normal);
      vec3 randVec = normalize(vec3(n1 * 2.0 - 1.0, n2 * 2.0 - 1.0, n3 * 2.0 - 1.0));
      float coneSpread = roughness * roughness * 0.40;
      vec3 rayDir = normalize(reflDir + randVec * coneSpread);

      // Avoid grazing self-hits on curved car panels
      if (dot(rayDir, normal) > 0.08 && dot(rayDir, geoNormal) > 0.05) {
        float stepLen = 0.14;
        float startBias = 0.045 + 0.014 * viewDist;
        vec3 rayPos = viewPos + geoNormal * startBias + rayDir * (stepLen * (0.5 + n1));
        vec3 prevPos = rayPos;

        for (int s = 0; s < 22; s++) {
          prevPos = rayPos;
          rayPos += rayDir * stepLen;
          stepLen *= 1.15;

          if (s < 2) continue; // Never self-intersect the origin surface

          vec3 scr = projectToScreen(rayPos);
          if (scr.x < 0.008 || scr.x > 0.992 || scr.y < 0.008 || scr.y > 0.992 || scr.z > 0.9999) break;

          float sceneD = texture2D(tDepth, scr.xy).r;
          if (sceneD < 0.9999) {
            vec3 hitPos = getViewPos(scr.xy, sceneD);
            float zDelta = hitPos.z - rayPos.z;
            if (zDelta > 0.01 && zDelta < max(stepLen * 1.6, 0.16)) {
              vec3 lo = prevPos;
              vec3 hi = rayPos;
              vec3 refinedScr = scr;
              for (int b = 0; b < 4; b++) {
                vec3 mid = 0.5 * (lo + hi);
                vec3 mScr = projectToScreen(mid);
                float mD = texture2D(tDepth, mScr.xy).r;
                vec3 mHit = getViewPos(mScr.xy, mD);
                if (mHit.z > mid.z) {
                  hi = mid;
                  refinedScr = mScr;
                } else {
                  lo = mid;
                }
              }
              float edgeFade = smoothstep(0.0, 0.14, min(min(refinedScr.x, 1.0 - refinedScr.x), min(refinedScr.y, 1.0 - refinedScr.y)));
              ssrColor = min(texture2D(tBeauty, refinedScr.xy).rgb, vec3(2.8));
              ssrWeight = edgeFade * normalMatch;
              break;
            }
          }
        }
      }
    }

    float ndotv = clamp(dot(normal, -viewDir), 0.0, 1.0);
    float fresnel = (0.04 + 0.62 * pow(1.0 - ndotv, 4.0)) * (1.0 - roughness * 1.18);
    fresnel = clamp(fresnel, 0.0, 0.72);

    vec3 finalHdr = beauty.rgb * (1.0 - occlusion * 0.85)
                  + giBounce * albedoProxy * diffuseWeight * uGiStrength * 0.42
                  + ssrColor * ssrWeight * fresnel * uSsrStrength;

    gl_FragColor = vec4(max(finalHdr, vec3(0.0)), beauty.a);
  }
`;

// Pass 3: Firefly-Suppressing Progressive 32-bit Float Accumulation
export const ACCUM_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tCurrent;
  uniform sampler2D tPrevAccum;
  uniform vec2 uResolution;
  uniform float uSampleCount;

  void main() {
    vec4 cur = texture2D(tCurrent, vUv);
    vec2 texel = 1.0 / uResolution;

    // 5-tap isolated-firefly suppressor: preserves smooth headlights, kills 1px specular dots
    vec3 n = texture2D(tCurrent, vUv + vec2(0.0, texel.y)).rgb;
    vec3 s = texture2D(tCurrent, vUv - vec2(0.0, texel.y)).rgb;
    vec3 e = texture2D(tCurrent, vUv + vec2(texel.x, 0.0)).rgb;
    vec3 w = texture2D(tCurrent, vUv - vec2(texel.x, 0.0)).rgb;
    vec3 maxNeighbor = max(max(n, s), max(e, w));
    cur.rgb = min(cur.rgb, maxNeighbor * 1.45 + vec3(0.35));

    if (uSampleCount <= 1.0) {
      gl_FragColor = cur;
      return;
    }
    vec4 prev = texture2D(tPrevAccum, vUv);
    float weight = 1.0 / uSampleCount;
    gl_FragColor = mix(prev, cur, weight);
  }
`;

// Pass 4A: Quarter-Res HDR Bloom & Streak Threshold
export const BLOOM_PRE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tAccum;
  uniform float uExposure;

  void main() {
    vec3 c = min(texture2D(tAccum, vUv).rgb * uExposure, vec3(6.5));
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float knee = smoothstep(0.95, 2.3, lum);
    gl_FragColor = vec4(c * knee, 1.0);
  }
`;

// Pass 4B: Separable 9-Tap Gaussian Blur (used for both Fog Glow & Wide Anamorphic Streaks)
export const BLOOM_BLUR_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tInput;
  uniform vec2 uDirection;

  void main() {
    vec3 sum = texture2D(tInput, vUv).rgb * 0.227027;
    sum += texture2D(tInput, vUv + uDirection * 1.384615).rgb * 0.316216;
    sum += texture2D(tInput, vUv - uDirection * 1.384615).rgb * 0.316216;
    sum += texture2D(tInput, vUv + uDirection * 3.230769).rgb * 0.070270;
    sum += texture2D(tInput, vUv - uDirection * 3.230769).rgb * 0.070270;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

// Pass 5: Bounded CAS + Chromatic Aberration + Volumetric Haze + Anamorphic Streaks + Grading + AgX + Film Grain
export const POST_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tAccum;
  uniform sampler2D tBloom;
  uniform sampler2D tStreak;
  uniform sampler2D tDepth;
  uniform vec2 uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uExposure;
  uniform float uBloomStrength;
  uniform float uStreakStrength;
  uniform float uContrast;
  uniform float uColorTemp;
  uniform float uSaturation;
  uniform float uSharpness;
  uniform float uChromaticAberration;
  uniform float uFilmGrain;
  uniform float uFogDensity;
  uniform vec3 uFogColor;
  uniform bool uLinearOutput;

  float linearizeDepth(float d) {
    float z = d * 2.0 - 1.0;
    return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
  }

  // Reversible tone compression for halo-free FidelityFX-style bounded CAS
  vec3 compress(vec3 c) {
    float m = max(c.r, max(c.g, c.b));
    return c / (1.0 + m);
  }
  vec3 decompress(vec3 c) {
    float m = max(c.r, max(c.g, c.b));
    return c / max(1.0 - m, 0.015);
  }

  vec3 agxDefaultContrastApprox(vec3 x) {
    vec3 x2 = x * x;
    vec3 x4 = x2 * x2;
    return + 15.5     * x4 * x2
           - 40.14    * x4 * x
           + 31.96    * x4
           - 6.868    * x2 * x
           + 0.4298   * x2
           + 0.1191   * x
           - 0.00232;
  }

  vec3 agxToneMap(vec3 val) {
    const mat3 agx_mat = mat3(
      0.842479062253094,  0.0423282422610123, 0.0423756549057051,
      0.0784335999999992, 0.878468636469772,  0.0784336,
      0.0792237451477643, 0.0791661274605434, 0.879142973793104
    );
    const mat3 agx_mat_inv = mat3(
      1.19687900512017,   -0.0528968517574562, -0.0529716355144438,
     -0.0980208811401368,  1.15190312990417,   -0.0980434501171241,
     -0.0990297440797205, -0.0989611768448433,  1.15107367264116
    );
    val = max(val, vec3(1e-10));
    val = agx_mat * val;
    val = clamp(log2(val), -12.47393, 4.026069);
    val = (val - (-12.47393)) / (4.026069 - (-12.47393));
    val = agxDefaultContrastApprox(val);
    val = agx_mat_inv * val;
    return clamp(val, 0.0, 1.0);
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec2 texel = 1.0 / uResolution;
    vec2 centered = vUv - 0.5;
    float r2 = dot(centered, centered);

    // 1. Optional Cinema Lens Chromatic Aberration (stronger toward edges)
    vec4 hdr = texture2D(tAccum, vUv);
    vec3 col = hdr.rgb;
    if (uChromaticAberration > 0.001) {
      vec2 caOff = centered * r2 * uChromaticAberration * 0.012;
      col.r = texture2D(tAccum, vUv + caOff).r;
      col.b = texture2D(tAccum, vUv - caOff).b;
    }

    // 2. Bounded Neighborhood-Clamped CAS (zero dark diamond rings, crisp wood/metal detail)
    if (uSharpness > 0.001) {
      vec3 c0 = compress(max(col, vec3(0.0)));
      vec3 cn = compress(max(texture2D(tAccum, vUv + vec2(0.0, texel.y)).rgb, vec3(0.0)));
      vec3 cs = compress(max(texture2D(tAccum, vUv - vec2(0.0, texel.y)).rgb, vec3(0.0)));
      vec3 ce = compress(max(texture2D(tAccum, vUv + vec2(texel.x, 0.0)).rgb, vec3(0.0)));
      vec3 cw = compress(max(texture2D(tAccum, vUv - vec2(texel.x, 0.0)).rgb, vec3(0.0)));
      vec3 minC = min(c0, min(min(cn, cs), min(ce, cw)));
      vec3 maxC = max(c0, max(max(cn, cs), max(ce, cw)));
      vec3 avgC = 0.25 * (cn + cs + ce + cw);
      vec3 sharpened = clamp(c0 + (c0 - avgC) * (uSharpness * 0.9), minC, maxC);
      col = decompress(sharpened);
    }

    col *= uExposure;

    // 3. Analytical Volumetric Depth Haze
    if (uFogDensity > 0.001) {
      float rawD = texture2D(tDepth, vUv).r;
      float dist = rawD >= 0.9999 ? 45.0 : linearizeDepth(rawD);
      float fogFactor = 1.0 - exp(-dist * uFogDensity * 0.032);
      col = mix(col, uFogColor * uExposure, clamp(fogFactor, 0.0, 0.72));
    }

    // 4. Silky Fog Glow + Horizontal Anamorphic Cinema Streaks
    if (uBloomStrength > 0.001) {
      col += texture2D(tBloom, vUv).rgb * uBloomStrength * 0.65;
    }
    if (uStreakStrength > 0.001) {
      // Subtle cinema optical blue-warm tint on horizontal headlight streaks
      vec3 streakTint = mix(vec3(0.85, 0.93, 1.15), vec3(1.12, 0.96, 0.82), clamp(uColorTemp + 0.5, 0.0, 1.0));
      col += texture2D(tStreak, vUv).rgb * streakTint * uStreakStrength * 0.55;
    }

    // 5. Live Color Temperature (Cool <-> Warm)
    if (abs(uColorTemp) > 0.001) {
      vec3 tempMul = vec3(1.0 + uColorTemp * 0.32, 1.0 + uColorTemp * 0.05, 1.0 - uColorTemp * 0.34);
      col *= max(tempMul, vec3(0.2));
    }

    if (uLinearOutput) {
      gl_FragColor = vec4(col, hdr.a);
      return;
    }

    // Subtle cinema lens vignette
    col *= 1.0 - r2 * 0.36;

    // 6. AgX Filmic Tone Mapping + Contrast + Saturation
    col = agxToneMap(col);
    col = pow(max(col, vec3(0.0)), vec3(uContrast));

    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = clamp(mix(vec3(lum), col, uSaturation), 0.0, 1.0);

    // 7. Subtle Analog Film Grain + Anti-Banding Dither
    float grain = (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 19.3) - 1.0);
    float grainScale = (1.0 / 512.0) + uFilmGrain * 0.035;
    col = clamp(col + grain * grainScale, 0.0, 1.0);

    gl_FragColor = vec4(col, hdr.a);
  }
`;