import { useRef, useEffect, useCallback, memo } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import noiseDeepUrl from '../assets/noise_deep.png'
import starsUrl from '../assets/stars.png'

/**
 * BlackHoleOrb - Complete faithful recreation of MisterPrada/singularity
 * https://github.com/MisterPrada/singularity
 * 
 * Now includes ALL missing elements:
 * 1. Stars/nebula environment texture for background blending
 * 2. Bloom post-processing (strength 0.217, threshold 0)
 * 3. ACES Filmic tone mapping with exposure 1.2
 * 4. Proper camera setup (FOV 50, position 1, 0.5, 3)
 * 5. Background intensity multiplier (2.0)
 * 6. Complete color ramp with B-spline interpolation
 */

export type OrbState = 'idle' | 'listening' | 'processing' | 'playing' | 'paused' | 'success'

interface BlackHoleOrbProps {
  state: OrbState
  audioLevel: number
  size?: number
  onTap?: () => void
  onLongPress?: () => void
  className?: string
}

const LONG_PRESS_DURATION = 500
const DRAG_THRESHOLD = 10  // Increased from 5 to make taps more forgiving

const vertexShader = `
  varying vec3 vPosition;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying vec3 vViewDirection;
  
  void main() {
    vPosition = position;
    vNormal = normal;
    
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
    
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Complete shader matching Singularity's BlackHole.js with ALL features
const fragmentShader = `
  precision highp float;
  
  varying vec3 vPosition;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying vec3 vViewDirection;
  
  uniform float uTime;
  uniform float uAudioLevel;
  uniform vec3 uRampCol1;
  uniform vec3 uRampCol2;
  uniform vec3 uRampCol3;
  uniform float uRampPos1;
  uniform float uRampPos2;
  uniform float uRampPos3;
  uniform float uEmission;
  uniform vec3 uEmissionColor;
  uniform sampler2D uNoiseTexture;
  uniform sampler2D uStarsTexture;
  uniform vec3 uCameraPos;
  uniform float uBackgroundIntensity;
  uniform mat4 modelWorldMatrix;
  
  // Singularity parameters (from BlackHole.js uniforms)
  const float ITERATIONS = 128.0;
  const float STEP_SIZE = 0.0071;
  const float NOISE_FACTOR = 0.01;
  const float POWER = 0.3;
  const float ORIGIN_RADIUS = 0.13;
  const float BAND_WIDTH = 0.03;
  
  #define PI 3.14159265359
  #define PI2 6.28318530718
  
  // White noise for jitter (matching whiteNoise2D)
  float whiteNoise2D(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }
  
  // Length function (matching Singularity's lengthSqrt - manual sqrt for consistency)
  float len(vec3 v) {
    return sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  }
  
  // Rotation matrix around axis (matching rotateAxis from TSL-utils.js)
  mat3 rotateAxis(vec3 axis, float angle) {
    float s = sin(angle);
    float c = cos(angle);
    float oc = 1.0 - c;
    return mat3(
      oc * axis.x * axis.x + c,           oc * axis.x * axis.y - axis.z * s,  oc * axis.z * axis.x + axis.y * s,
      oc * axis.x * axis.y + axis.z * s,  oc * axis.y * axis.y + c,           oc * axis.y * axis.z - axis.x * s,
      oc * axis.z * axis.x - axis.y * s,  oc * axis.y * axis.z + axis.x * s,  oc * axis.z * axis.z + c
    );
  }
  
  // Smooth range (matching smoothRange from TSL-utils.js)
  float smoothRange(float value, float inMin, float inMax, float outMin, float outMax) {
    float t = clamp((value - inMin) / (inMax - inMin + 0.0001), 0.0, 1.0);
    float smoothT = t * t * (3.0 - 2.0 * t);
    return mix(outMin, outMax, smoothT);
  }
  
  // Catmull-Rom spline (matching CatmulRom from TSL-utils.js)
  vec3 catmullRom(float t, vec3 p0, vec3 p1, vec3 p2, vec3 p3) {
    return 0.5 * (
      (2.0 * p1) +
      (-p0 + p2) * t +
      (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t +
      (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t * t
    );
  }
  
  // Color ramp B-spline (matching ColorRamp3_BSpline from TSL-utils.js)
  vec3 colorRamp3BSpline(float T, vec3 colA, float posA, vec3 colB, float posB, vec3 colC, float posC) {
    float AB = posB - posA;
    float BC = posC - posB;
    
    float iAB = clamp((T - posA) / (AB + 0.0001), 0.0, 1.0);
    float iBC = clamp((T - posB) / (BC + 0.0001), 0.0, 1.0);
    
    vec3 cA = catmullRom(1.0 - iAB, colA, colA, colB, colC);
    vec3 cB = catmullRom(iAB - iBC, colA, colB, colC, colC);
    
    if (T < posB) return cA;
    if (T < posC) return cB;
    return colC;
  }
  
  // vec3 to grayscale factor (matching vecToFac from TSL-utils.js)
  float vecToFac(vec3 v) {
    return v.r * 0.2126 + v.g * 0.7152 + v.b * 0.0722;
  }
  
  // sRGB to Linear (matching srgbToLinear from TSL-utils.js)
  vec3 srgbToLinear(vec3 rgb) {
    return mix(rgb / 12.92, pow((rgb + 0.055) / 1.055, vec3(2.4)), step(0.04045, rgb));
  }
  
  // Linear to sRGB (matching linearToSrgb from TSL-utils.js)
  vec3 linearToSrgb(vec3 lin) {
    vec3 low = lin * 12.92;
    vec3 high = pow(lin, vec3(1.0 / 2.4)) * 1.055 - 0.055;
    return mix(low, high, step(0.0031308, lin));
  }
  
  // Equirectangular UV (matching equirectUV from three/tsl)
  vec2 equirectUV(vec3 dir) {
    float u = atan(dir.z, dir.x) / PI2 + 0.5;
    float v = asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5;
    return vec2(u, v);
  }
  
  // Remap with clamp (matching remapClamp from three/tsl)
  float remapClamp(float value, float inMin, float inMax, float outMin, float outMax) {
    float t = clamp((value - inMin) / (inMax - inMin + 0.0001), 0.0, 1.0);
    return mix(outMin, outMax, t);
  }
  
  void main() {
    // === Geometry and view setup (matching BlackHole.js exactly) ===
    
    // Transform geometry coords: flip Z then swizzle to XZY
    vec3 objCoords = vPosition * vec3(1.0, 1.0, -1.0);
    objCoords = objCoords.xzy;
    
    // Determine if backface
    float isBackface = gl_FrontFacing ? 0.0 : 1.0;
    
    // Camera in object space with same transform
    vec3 camPointObj = uCameraPos * vec3(1.0, 1.0, -1.0);
    camPointObj = camPointObj.xzy;
    
    // Pick starting coords based on face
    vec3 startCoords = mix(objCoords, camPointObj, isBackface);
    
    // View direction with transform
    vec3 viewInWorld = normalize(uCameraPos - vWorldPosition);
    viewInWorld = viewInWorld * vec3(1.0, 1.0, -1.0);
    viewInWorld = viewInWorld.xzy;
    vec3 rayDir = -viewInWorld;
    
    // White noise jitter
    float noiseWhite = whiteNoise2D(objCoords.xy) * NOISE_FACTOR;
    vec3 jitter = rayDir * noiseWhite;
    
    // Initial ray position
    vec3 rayPos = startCoords - jitter;
    
    // Accumulators
    vec3 colorAcc = vec3(0.0);
    float alphaAcc = 0.0;
    
    // === Main raymarch loop (exactly matching BlackHole.js) ===
    for (float i = 0.0; i < ITERATIONS; i += 1.0) {
      // Early exit if nearly opaque
      if (alphaAcc > 0.99) break;
      
      // Steering toward center (gravitational lensing)
      vec3 rNorm = normalize(rayPos);
      float rLen = len(rayPos);
      float steerMag = STEP_SIZE * POWER / (rLen * rLen + 0.0001);
      float rangeVal = remapClamp(rLen, 1.0, 0.5, 0.0, 1.0);
      vec3 steer = rNorm * steerMag * rangeVal;
      vec3 steeredDir = normalize(rayDir - steer);
      
      // Advance ray
      vec3 advance = rayDir * STEP_SIZE;
      rayPos += advance;
      
      // XY plane distance and rotating UVs (Keplerian orbits)
      // Audio reactivity: direct rotation offset for immediate response (subtle)
      float xyLen = len(rayPos * vec3(1.0, 1.0, 0.0));
      float rotPhase = xyLen * 4.27 - uTime * 0.1 - uAudioLevel * 0.25;
      mat3 rotMat = rotateAxis(vec3(0.0, 0.0, 1.0), rotPhase);
      vec3 uvRot = rotMat * rayPos;
      vec2 uvSample = uvRot.xy * 2.0;
      
      // Sample noise texture (noiseDeepTexture)
      vec4 noiseDeep = texture2D(uNoiseTexture, uvSample);
      
      // Z band shaping (thin accretion disk)
      float bandMin = -BAND_WIDTH;
      vec3 bandEnds = vec3(bandMin, 0.0, BAND_WIDTH);
      vec3 dz = bandEnds - vec3(rayPos.z);
      vec3 zQuad = dz * dz / BAND_WIDTH;
      vec3 zBand = max((vec3(BAND_WIDTH) - zQuad) / BAND_WIDTH, vec3(0.0));
      
      // Modulated noise amplitude
      vec3 noiseAmp3 = noiseDeep.rgb * zBand;
      float noiseAmpLen = len(noiseAmp3);
      
      // Pseudo normal via offset noise sample
      vec2 uvForNormal = uvSample * 1.002;
      vec4 noiseNormal = texture2D(uNoiseTexture, uvForNormal);
      vec3 noiseNormalScaled = noiseNormal.rgb * zBand;
      float noiseNormalLen = len(noiseNormalScaled);
      
      // Color ramp input (matching BlackHole.js exactly)
      float rampInput = xyLen 
        + (noiseAmpLen - 0.78) * 1.5
        + (noiseAmpLen - noiseNormalLen) * 19.75;
      
      // Evaluate color ramp
      vec3 baseCol = colorRamp3BSpline(rampInput, uRampCol1, uRampPos1, uRampCol2, uRampPos2, uRampCol3, uRampPos3);
      // Audio reactivity: emission pulses subtly brighter when speaking
      vec3 emissiveCol = baseCol * uEmission * (1.0 + uAudioLevel * 0.35) + uEmissionColor;
      
      // Core suppression (black hole center)
      float rLenNow = len(rayPos);
      float insideCore = step(rLenNow, ORIGIN_RADIUS);
      vec3 shadedCol = mix(emissiveCol, vec3(0.0), insideCore);
      
      // Alpha shaping (matching BlackHole.js)
      float zAbs = abs(rayPos.z);
      float aNoise = (noiseAmpLen - 0.75) * -0.6;
      float aPre = zAbs + aNoise;
      float aRadial = smoothRange(xyLen, 1.0, 0.0, 0.0, 1.0);
      float aBand = smoothRange(aPre, BAND_WIDTH, 0.0, 0.0, aRadial);
      float alphaLocal = mix(aBand, 1.0, insideCore);
      
      // Front-to-back compositing
      float oneMinusA = 1.0 - alphaAcc;
      float weight = oneMinusA * vecToFac(vec3(alphaLocal));
      vec3 newColor = mix(colorAcc, shadedCol, weight);
      float newAlpha = mix(alphaAcc, 1.0, vecToFac(vec3(alphaLocal)));
      
      // Second advance and steering update
      rayPos += advance;
      rayDir = steeredDir;
      colorAcc = newColor;
      alphaAcc = newAlpha;
    }
    
    // === Environment blend on remaining transparency (matching BlackHole.js) ===
    vec3 dirForEnv = rayDir * vec3(1.0, -1.0, 1.0);
    dirForEnv = dirForEnv.xzy;
    
    // Sample stars texture with equirectangular mapping
    vec2 envUV = equirectUV(dirForEnv);
    vec3 envColor = texture2D(uStarsTexture, envUV).rgb;
    vec3 env = linearToSrgb(envColor * uBackgroundIntensity);
    
    // Blend environment with accumulated color
    float trans = 1.0 - alphaAcc;
    vec3 finalRGB = mix(colorAcc, env, trans);
    
    // Convert back to linear for proper rendering
    finalRGB = srgbToLinear(finalRGB);
    
    // Audio reactivity - gentle brightness boost for elegance
    finalRGB *= 1.0 + uAudioLevel * 0.12;
    
    // Final alpha - smooth fade to fully transparent at edges
    // Use a wider fade range (0.7 to 1.0) for softer edge
    float edgeDist = length(vPosition.xy);
    float edgeFade = 1.0 - smoothstep(0.6, 1.0, edgeDist);
    // No minimum alpha - let edges fade to complete transparency
    float finalAlpha = alphaAcc * edgeFade;
    
    gl_FragColor = vec4(finalRGB, finalAlpha);
  }
`

// State color palettes (matching Singularity's defaults with state variations)
const STATE_COLORS: Record<OrbState, { 
  rampCol1: THREE.Color;
  rampCol2: THREE.Color;
  rampCol3: THREE.Color;
  rampPos1: number;
  rampPos2: number;
  rampPos3: number;
  emission: number;
  emissionColor: THREE.Color;
}> = {
  idle: {
    rampCol1: new THREE.Color(0.95, 0.71, 0.44),  // Cream/gold (original Singularity)
    rampCol2: new THREE.Color(0.14, 0.05, 0.03),  // Dark red (original Singularity)
    rampCol3: new THREE.Color(0, 0, 0),            // Black
    rampPos1: 0.05,
    rampPos2: 0.425,
    rampPos3: 1.0,
    emission: 2.0,
    emissionColor: new THREE.Color(0.14, 0.129, 0.09),
  },
  listening: {
    rampCol1: new THREE.Color(1.0, 0.65, 0.35),   // Brighter orange
    rampCol2: new THREE.Color(0.22, 0.06, 0.02),  // Deeper red
    rampCol3: new THREE.Color(0, 0, 0),
    rampPos1: 0.04,
    rampPos2: 0.4,
    rampPos3: 1.0,
    emission: 2.8,
    emissionColor: new THREE.Color(0.18, 0.12, 0.06),
  },
  processing: {
    rampCol1: new THREE.Color(0.85, 0.55, 0.98),  // Purple-pink
    rampCol2: new THREE.Color(0.18, 0.04, 0.14),  // Dark purple
    rampCol3: new THREE.Color(0, 0, 0),
    rampPos1: 0.05,
    rampPos2: 0.45,
    rampPos3: 1.0,
    emission: 2.4,
    emissionColor: new THREE.Color(0.12, 0.08, 0.14),
  },
  playing: {
    rampCol1: new THREE.Color(1.0, 0.85, 0.55),   // Bright gold
    rampCol2: new THREE.Color(0.2, 0.1, 0.02),    // Deep amber
    rampCol3: new THREE.Color(0, 0, 0),
    rampPos1: 0.045,
    rampPos2: 0.42,
    rampPos3: 1.0,
    emission: 2.6,
    emissionColor: new THREE.Color(0.16, 0.14, 0.08),
  },
  success: {
    rampCol1: new THREE.Color(0.55, 0.98, 0.65),  // Bright green
    rampCol2: new THREE.Color(0.04, 0.14, 0.06),  // Dark green
    rampCol3: new THREE.Color(0, 0, 0),
    rampPos1: 0.05,
    rampPos2: 0.44,
    rampPos3: 1.0,
    emission: 2.2,
    emissionColor: new THREE.Color(0.08, 0.14, 0.09),
  },
  paused: {
    rampCol1: new THREE.Color(0.65, 0.75, 0.95),  // Cool blue-gray
    rampCol2: new THREE.Color(0.08, 0.12, 0.18),  // Dark blue
    rampCol3: new THREE.Color(0, 0, 0),
    rampPos1: 0.05,
    rampPos2: 0.45,
    rampPos3: 1.0,
    emission: 1.5,  // Lower emission when paused
    emissionColor: new THREE.Color(0.08, 0.10, 0.14),
  },
}

export const BlackHoleOrb = memo(function BlackHoleOrb({
  state,
  audioLevel,
  size = 180,
  onTap,
  onLongPress,
  className = '',
}: BlackHoleOrbProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const composerRef = useRef<EffectComposer | null>(null)
  const materialRef = useRef<THREE.ShaderMaterial | null>(null)
  const animationRef = useRef<number>(0)
  const startTimeRef = useRef<number>(Date.now())
  
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isPressedRef = useRef(false)
  const isDraggingRef = useRef(false)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const hasDraggedRef = useRef(false)
  // Using module-level DRAG_THRESHOLD = 10
  
  const currentColorsRef = useRef({
    rampCol1: STATE_COLORS.idle.rampCol1.clone(),
    rampCol2: STATE_COLORS.idle.rampCol2.clone(),
    rampCol3: STATE_COLORS.idle.rampCol3.clone(),
    emissionColor: STATE_COLORS.idle.emissionColor.clone(),
    rampPos1: STATE_COLORS.idle.rampPos1,
    rampPos2: STATE_COLORS.idle.rampPos2,
    rampPos3: STATE_COLORS.idle.rampPos3,
    emission: STATE_COLORS.idle.emission,
  })
  const smoothAudioRef = useRef(0)
  const stateRef = useRef(state)
  const audioLevelRef = useRef(audioLevel)
  
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { audioLevelRef.current = audioLevel }, [audioLevel])
  
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    
    // === Renderer setup (matching Singularity's Renderer.js) ===
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
    })
    renderer.setSize(size, size)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    
    // ACES Filmic tone mapping with exposure 1.2 (matching Singularity)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.2
    renderer.outputColorSpace = THREE.SRGBColorSpace
    
    container.appendChild(renderer.domElement)
    rendererRef.current = renderer
    
    const scene = new THREE.Scene()
    
    // Camera setup (matching Singularity's Camera.js: FOV 50, position 1, 0.5, 3)
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000)
    camera.position.set(1, 0.5, 3)
    camera.lookAt(0, 0, 0)
    
    // Load textures
    const textureLoader = new THREE.TextureLoader()
    
    // Noise texture (noiseDeepTexture)
    const noiseTexture = textureLoader.load(noiseDeepUrl)
    noiseTexture.wrapS = THREE.RepeatWrapping
    noiseTexture.wrapT = THREE.RepeatWrapping
    noiseTexture.needsUpdate = true
    
    // Stars/environment texture (starsTexture)
    const starsTexture = textureLoader.load(starsUrl)
    starsTexture.mapping = THREE.EquirectangularReflectionMapping
    starsTexture.colorSpace = THREE.SRGBColorSpace
    starsTexture.needsUpdate = true
    
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uAudioLevel: { value: 0 },
        uRampCol1: { value: STATE_COLORS.idle.rampCol1.clone() },
        uRampCol2: { value: STATE_COLORS.idle.rampCol2.clone() },
        uRampCol3: { value: STATE_COLORS.idle.rampCol3.clone() },
        uRampPos1: { value: STATE_COLORS.idle.rampPos1 },
        uRampPos2: { value: STATE_COLORS.idle.rampPos2 },
        uRampPos3: { value: STATE_COLORS.idle.rampPos3 },
        uEmission: { value: STATE_COLORS.idle.emission },
        uEmissionColor: { value: STATE_COLORS.idle.emissionColor.clone() },
        uNoiseTexture: { value: noiseTexture },
        uStarsTexture: { value: starsTexture },
        uCameraPos: { value: camera.position.clone() },
        uBackgroundIntensity: { value: 2.0 }, // Matching Singularity's backgroundIntensity
        modelWorldMatrix: { value: new THREE.Matrix4() },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    materialRef.current = material
    
    // Sphere geometry (matching Singularity: SphereGeometry(1, 16, 16))
    const geometry = new THREE.SphereGeometry(1, 16, 16)
    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)
    
    // === Post-processing setup (matching Singularity's PostProcess.js) ===
    const composer = new EffectComposer(renderer)
    composerRef.current = composer
    
    // Render pass
    const renderPass = new RenderPass(scene, camera)
    renderPass.clearAlpha = 0
    composer.addPass(renderPass)
    
    // Bloom pass (matching Singularity: strength 0.217, radius 0, threshold 0)
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size, size),
      0.217,  // strength (matching Singularity)
      0.0,    // radius
      0.0     // threshold (matching Singularity - bloom everything)
    )
    composer.addPass(bloomPass)
    
    // Output pass for proper color space handling
    const outputPass = new OutputPass()
    composer.addPass(outputPass)
    
    const animate = () => {
      animationRef.current = requestAnimationFrame(animate)
      if (document.hidden) return
      
      const time = (Date.now() - startTimeRef.current) / 1000
      
      // Snappier audio response (0.25 = ~4 frame lag instead of ~7)
      smoothAudioRef.current += (audioLevelRef.current - smoothAudioRef.current) * 0.25
      
      const target = STATE_COLORS[stateRef.current] || STATE_COLORS.idle
      currentColorsRef.current.rampCol1.lerp(target.rampCol1, 0.08)
      currentColorsRef.current.rampCol2.lerp(target.rampCol2, 0.08)
      currentColorsRef.current.rampCol3.lerp(target.rampCol3, 0.08)
      currentColorsRef.current.emissionColor.lerp(target.emissionColor, 0.08)
      currentColorsRef.current.rampPos1 += (target.rampPos1 - currentColorsRef.current.rampPos1) * 0.08
      currentColorsRef.current.rampPos2 += (target.rampPos2 - currentColorsRef.current.rampPos2) * 0.08
      currentColorsRef.current.rampPos3 += (target.rampPos3 - currentColorsRef.current.rampPos3) * 0.08
      currentColorsRef.current.emission += (target.emission - currentColorsRef.current.emission) * 0.08
      
      material.uniforms.uTime.value = time
      material.uniforms.uAudioLevel.value = smoothAudioRef.current
      material.uniforms.uRampCol1.value.copy(currentColorsRef.current.rampCol1)
      material.uniforms.uRampCol2.value.copy(currentColorsRef.current.rampCol2)
      material.uniforms.uRampCol3.value.copy(currentColorsRef.current.rampCol3)
      material.uniforms.uRampPos1.value = currentColorsRef.current.rampPos1
      material.uniforms.uRampPos2.value = currentColorsRef.current.rampPos2
      material.uniforms.uRampPos3.value = currentColorsRef.current.rampPos3
      material.uniforms.uEmission.value = currentColorsRef.current.emission
      material.uniforms.uEmissionColor.value.copy(currentColorsRef.current.emissionColor)
      material.uniforms.modelWorldMatrix.value.copy(mesh.matrixWorld)
      
      // Update camera position uniform
      material.uniforms.uCameraPos.value.copy(camera.position)
      
      // Render with post-processing
      composer.render()
    }
    
    animate()
    
    return () => {
      cancelAnimationFrame(animationRef.current)
      noiseTexture.dispose()
      starsTexture.dispose()
      renderer.dispose()
      geometry.dispose()
      material.dispose()
      composer.dispose()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [size])
  
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    isPressedRef.current = true
    hasDraggedRef.current = false
    dragStartRef.current = { x: e.screenX, y: e.screenY }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    
    longPressTimerRef.current = setTimeout(() => {
      if (isPressedRef.current && !hasDraggedRef.current && onLongPress) {
        onLongPress()
        isPressedRef.current = false
      }
    }, LONG_PRESS_DURATION)
  }, [onLongPress])
  
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPressedRef.current || !dragStartRef.current) return
    const deltaX = e.screenX - dragStartRef.current.x
    const deltaY = e.screenY - dragStartRef.current.y
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY)
    
    if (distance > DRAG_THRESHOLD && !isDraggingRef.current) {
      isDraggingRef.current = true
      hasDraggedRef.current = true
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
    }
    
    if (isDraggingRef.current) {
      window.outloud?.window?.dragMove?.(Math.round(deltaX), Math.round(deltaY))
      dragStartRef.current = { x: e.screenX, y: e.screenY }
    }
  }, [])
  
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'BlackHoleOrb.tsx:pointerUp',message:'Pointer up detected',data:{isPressed:isPressedRef.current,hasDragged:hasDraggedRef.current,willCallOnTap:isPressedRef.current && !hasDraggedRef.current && !!onTap},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'TAP'})}).catch(()=>{});
    // #endregion
    if (isPressedRef.current && !hasDraggedRef.current && onTap) onTap()
    isPressedRef.current = false
    isDraggingRef.current = false
    dragStartRef.current = null
  }, [onTap])
  
  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    isPressedRef.current = false
    isDraggingRef.current = false
    dragStartRef.current = null
  }, [])
  
  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: size,
        height: size,
        cursor: isDraggingRef.current ? 'grabbing' : 'pointer',
        touchAction: 'none',
        WebkitAppRegion: 'no-drag',
        position: 'relative',
      } as React.CSSProperties}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerCancel}
    />
  )
})

export default BlackHoleOrb
