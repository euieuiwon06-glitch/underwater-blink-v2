const canvas = document.querySelector("#water-canvas");
const video = document.querySelector("#camera-feed");
const retryButton = document.querySelector("#retry-button");
const statusText = document.querySelector("#status-text");

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const RIPPLE_SPEED = 0.55;
const RIPPLE_LIFE = 3.2;
const CAMERA_FADE_IN = 1400;
const BLINK_THRESHOLD = 0.54;
const BLINK_RELEASE = 0.28;
const MOUTH_THRESHOLD = 0.38;
const MOUTH_RELEASE = 0.16;
const HAND_CLOSED = 1.25;
const HAND_OPEN = 1.6;
const RIPPLE_COOLDOWN = 650;
const RIPPLE_SLOTS = 6;
const CAMERA_ZOOM_LIMIT = 0.86;
const CENTER = { x: 0.5, y: 0.5 };
// 손(또는 드래그)으로 수면 가르기
const TRAIL_POINTS = 32;
const TRAIL_LIFE = 2.2;
const TRAIL_MIN_GAP = 70;
// 빠르게 움직이는 손은 흐려져 손가락이 덜 펴진 것처럼 잡히므로 주먹만 아니면 받는다.
const CUT_OPENNESS = 1.15;
const CUT_SPEED_START = 0.55;
const CUT_SPEED_KEEP = 0.2;
// 빠른 손은 몇 프레임씩 감지가 끊긴다. 이 시간 안에 다시 잡히면 같은 획으로 잇는다.
const HAND_LOST_GRACE = 420;
const HAND_MATCH_DISTANCE = 0.7;

let renderer;
let landmarker;
let handLandmarker;
let stream;
let cameraLoopId;
let lastVideoTime = -1;
let lastDetectionAt = 0;
let eyesClosed = false;
let blinkOrigin = null;
let mouthOpen = false;
const handsClosed = new Map();
let handTracks = [];
let nextTrackId = 0;
let detectionTick = 0;
let activeCut = null;
let activeCutAt = 0;
const lastRippleAt = new Map();
let hasDetectedFace = false;

// 상태 안내는 화면에 띄우지 않고 스크린리더와 콘솔로만 남긴다.
function setStatus(message) {
  statusText.textContent = message;
  if (message) console.info(message);
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message || "셰이더를 준비하지 못했습니다.");
  }
  return shader;
}

function createWaterRenderer(target) {
  const gl = target.getContext("webgl", {
    alpha: false,
    antialias: false,
    powerPreference: "high-performance",
  });

  if (!gl) {
    throw new Error("이 브라우저에서는 수면 효과를 표시할 수 없습니다.");
  }

  const vertexSource = `
    attribute vec2 a_position;
    varying vec2 v_uv;

    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // 좌표 단위: 화면의 짧은 변 = 1.0. 데스크톱과 모바일에서 왜곡 크기가 같게 보인다.
  const fragmentSource = `
    precision highp float;

    varying vec2 v_uv;
    uniform sampler2D u_waterTexture;
    uniform sampler2D u_cameraTexture;
    uniform vec2 u_resolution;
    uniform vec2 u_waterSize;
    uniform vec2 u_videoSize;
    uniform float u_time;
    uniform float u_cameraMix;
    uniform float u_motion;
    uniform float u_impact;
    uniform float u_rippleAges[${RIPPLE_SLOTS}];
    uniform vec2 u_rippleOrigins[${RIPPLE_SLOTS}];
    uniform vec4 u_trail[${TRAIL_POINTS}];

    const vec3 LUMA = vec3(0.299, 0.587, 0.114);
    const vec3 UNDERWATER = vec3(0.68, 0.90, 0.96);
    const vec3 SHADOW_TINT = vec3(0.10, 0.27, 0.33);
    const vec2 LIGHT = vec2(-0.6, 0.8);
    const float RIPPLE_SPEED = ${RIPPLE_SPEED.toFixed(3)};
    const float RIPPLE_LIFE = ${RIPPLE_LIFE.toFixed(3)};
    const float RIPPLE_AMP = 0.00055;
    const float CAMERA_REFRACTION = 1.55;
    const float WATER_REFRACTION = 0.8;
    const float CAMERA_ZOOM_LIMIT = ${CAMERA_ZOOM_LIMIT.toFixed(3)};
    const float TRAIL_LIFE = ${TRAIL_LIFE.toFixed(3)};
    const float PART_WIDTH = 0.16;
    const float PART_OPEN_TIME = 0.55;
    const float SIDE_WAVE_SPEED = 0.32;
    const float SIDE_WAVE_AMP = 0.0008;
    const float CUT_BLEND = 45.0;
    const vec3 DEEP_WATER = vec3(0.50, 0.76, 0.85);

    vec2 coverUv(vec2 uv) {
      float screenAspect = u_resolution.x / u_resolution.y;
      float imageAspect = u_waterSize.x / u_waterSize.y;

      if (screenAspect > imageAspect) {
        float visibleHeight = imageAspect / screenAspect;
        uv.y = uv.y * visibleHeight + (1.0 - visibleHeight) * 0.5;
      } else {
        float visibleWidth = screenAspect / imageAspect;
        uv.x = uv.x * visibleWidth + (1.0 - visibleWidth) * 0.5;
      }

      return uv;
    }

    // cover에 가깝게 채우되 얼굴이 너무 커지지 않도록 확대 배율을 제한한다.
    // 영상이 닿지 않는 가장자리는 inside로 부드럽게 수면에 녹인다.
    vec2 mirroredCoverUv(vec2 uv, out float inside) {
      vec2 video = max(u_videoSize, vec2(1.0));
      vec2 fit = u_resolution / video;
      float scale = max(min(fit.x, fit.y), max(fit.x, fit.y) * CAMERA_ZOOM_LIMIT);
      vec2 cameraUv = (uv - 0.5) * u_resolution / (scale * video) + 0.5;
      cameraUv.x = 1.0 - cameraUv.x;

      vec2 edge = smoothstep(vec2(0.0), vec2(0.07), cameraUv)
        * smoothstep(vec2(0.0), vec2(0.07), 1.0 - cameraUv);
      inside = edge.x * edge.y;
      return clamp(cameraUv, vec2(0.001), vec2(0.999));
    }

    // 크고 느린 물결 2개 + 작고 약한 물결 1개의 기울기.
    // 진행 방향과 주기를 서로 어긋나게 두고, 좌표를 살짝 휘어 격자처럼 맞물리지 않게 한다.
    vec2 ambientSlope(vec2 p, float t) {
      vec2 q = p + 0.07 * vec2(
        sin(p.y * 1.7 + t * 0.11),
        cos(p.x * 1.9 - t * 0.087)
      );

      vec2 dirA = vec2(0.82, 0.57);
      vec2 dirB = vec2(-0.39, 0.92);
      vec2 dirC = vec2(0.97, -0.24);

      float a = cos(dot(q, dirA) * 5.3 + t * 0.43);
      float b = cos(dot(q, dirB) * 7.1 - t * 0.31 + 1.7);
      float c = cos(dot(q, dirC) * 17.3 + t * 0.71 + sin(q.y * 3.1));

      float swell = 0.85 + 0.15 * sin(t * 0.13 + p.x * 1.3);
      return (dirA * a * 0.0055 + dirB * b * 0.0038) * swell + dirC * c * 0.0014;
    }

    // 한 번의 깜빡임으로 생긴 수면 높이.
    // 중앙이 잠깐 눌렸다가 되튀고, 고리가 퍼지며, 그 뒤로 짧은 잔물결이 따라온다.
    float rippleHeight(float r, float age) {
      if (age < 0.0 || age > RIPPLE_LIFE) return 0.0;

      float front = age * RIPPLE_SPEED;
      float x = r - front;
      float spread = inversesqrt(1.0 + r * 6.0);
      float decay = exp(-age * 0.8) * (1.0 - smoothstep(RIPPLE_LIFE * 0.55, RIPPLE_LIFE, age));

      float ring = exp(-x * x / 0.0022) * cos(x * 62.0);
      float behind = max(-x, 0.0);
      float wake = 0.5 * sin(behind * 96.0) * exp(-behind * 6.5) * smoothstep(0.0, 0.03, behind);
      float travelling = (ring + wake) * spread * decay * smoothstep(0.0, 0.07, age);

      float core = exp(-r * r / 0.0035);
      float press = -2.6 * (1.0 - exp(-age * 38.0)) * exp(-age * 7.5);
      float settle = 0.8 * sin(age * 13.0) * exp(-age * 2.4) * smoothstep(0.08, 0.25, age);

      return RIPPLE_AMP * ((press + settle) * core + travelling);
    }

    // 가른 자리의 벌어진 반폭: 손이 지나간 뒤 점점 넓게 벌어지고, 버티다가, 출렁이며 다시 메워진다.
    // 손 바로 뒤는 좁고 지나간 지 오래된 곳일수록 넓어서 배가 지나간 자국처럼 V자로 벌어진다.
    float partWidth(float age) {
      float k = clamp(age / PART_OPEN_TIME, 0.0, 1.0);
      float open = 1.0 - pow(1.0 - k, 3.0);
      float close = 1.0 - smoothstep(0.5, 1.0, age / TRAIL_LIFE);
      float wobble = 1.0 + 0.08 * sin(age * 9.0) * exp(-age * 2.0);
      return PART_WIDTH * open * close * wobble;
    }

    // 갈라진 가장자리에서 바깥쪽으로 밀려 퍼져 나가는 물결
    float sideWave(float d, float width, float age) {
      float x = d - (width + 0.02 + age * SIDE_WAVE_SPEED);
      float behind = max(-x, 0.0);
      float packet = exp(-x * x / 0.006) * cos(x * 48.0);
      float trailing = 0.4 * sin(behind * 70.0) * exp(-behind * 9.0) * smoothstep(0.0, 0.02, behind);
      float fade = exp(-age * 1.1) * smoothstep(0.0, 0.12, age)
        * (1.0 - smoothstep(0.6, 1.0, age / TRAIL_LIFE));
      float outside = smoothstep(width * 0.8, width * 1.1 + 0.005, d);
      return SIDE_WAVE_AMP * (packet + trailing) * fade * outside;
    }

    // 손이 지나간 궤적까지의 거리, 궤적에서 멀어지는 방향, 벌어진 반폭, 경과 시간.
    // 가장 가까운 구간 하나만 고르면 구간이 바뀌는 곳에 이음새가 생기므로 가까운 구간들을 부드럽게 섞는다.
    // u_trail = (x, y, 경과초, 세기). 세기가 음수인 점은 새 획의 시작이라 앞 점과 잇지 않는다.
    void nearestCut(vec2 p, vec2 toUnits, out float dist, out vec2 away, out float width, out float age) {
      float total = 0.0;
      float sumDist = 0.0;
      vec2 sumAway = vec2(0.0);
      float sumWidth = 0.0;
      float sumAge = 0.0;
      float closest = 1000.0;

      for (int i = 0; i < ${TRAIL_POINTS - 1}; i++) {
        vec4 a = u_trail[i];
        vec4 b = u_trail[i + 1];
        if (a.z < 0.0 || b.z < 0.0 || b.w < 0.0) continue;

        vec2 start = (a.xy - 0.5) * toUnits;
        vec2 segment = (b.xy - 0.5) * toUnits - start;
        float t = clamp(dot(p - start, segment) / max(dot(segment, segment), 1e-6), 0.0, 1.0);
        vec2 delta = p - (start + segment * t);
        float len = length(delta);
        float segmentAge = mix(a.z, b.z, t);
        float w = partWidth(segmentAge) * mix(abs(a.w), b.w, t);
        float score = len - w;

        // 지금까지 가장 가까운 구간을 기준으로 상대 가중치를 매겨, 먼 픽셀에서도 값이 0으로 사라지지 않게 한다.
        if (score < closest) {
          float rescale = exp(-CUT_BLEND * (closest - score));
          total *= rescale;
          sumDist *= rescale;
          sumAway *= rescale;
          sumWidth *= rescale;
          sumAge *= rescale;
          closest = score;
        }
        float weight = exp(-CUT_BLEND * (score - closest));
        total += weight;
        sumDist += len * weight;
        sumAway += (len > 1e-4 ? delta / len : vec2(0.0)) * weight;
        sumWidth += w * weight;
        sumAge += segmentAge * weight;
      }

      if (total <= 0.0) {
        dist = 1000.0;
        away = vec2(0.0);
        width = 0.0;
        age = -1.0;
        return;
      }
      dist = sumDist / total;
      float awayLength = length(sumAway);
      away = awayLength > 1e-4 ? sumAway / awayLength : vec2(0.0);
      width = sumWidth / total;
      age = sumAge / total;
    }

    void main() {
      float shortSide = min(u_resolution.x, u_resolution.y);
      vec2 toUnits = u_resolution / shortSide;
      vec2 p = (v_uv - 0.5) * toUnits;

      float cutDist;
      vec2 cutAway;
      float cutWidth;
      float cutAge;
      nearestCut(p, toUnits, cutDist, cutAway, cutWidth, cutAge);

      // gap: 물이 걷혀 바닥이 드러난 곳, rim: 양옆으로 밀려나 쌓인 물 둔덕
      float gap = 0.0;
      float rim = 0.0;
      vec2 partShift = vec2(0.0);
      // 궤적 한가운데서는 밀어내는 방향이 좌우로 뒤집힌다. 중심에서 0으로 줄여야 선 모양 이음새가 안 생긴다.
      float centerFade = smoothstep(0.0, max(cutWidth * 0.7, 0.02), cutDist);
      if (cutWidth > 0.0005) {
        // 좁아진 틈과 둔덕은 가는 선으로 남지 않도록 폭이 줄어드는 만큼 같이 옅어진다.
        float openness = smoothstep(0.0, PART_WIDTH * 0.6, cutWidth);
        gap = (1.0 - smoothstep(cutWidth * 0.25, cutWidth * 1.05, cutDist)) * openness;
        rim = exp(-pow((cutDist - cutWidth) / (0.012 + cutWidth * 0.22), 2.0)) * centerFade * openness;
        // 바깥 물을 넓은 범위까지 밀어낸다. 가장자리일수록 많이 밀려 물이 쌓여 보인다.
        float push = cutWidth * exp(-max(cutDist - cutWidth, 0.0) / (cutWidth * 2.2 + 0.04));
        partShift = -cutAway * push * centerFade;
      }

      vec2 ambient = ambientSlope(p, u_time) * u_motion * (1.0 + u_impact * 0.9) * (1.0 - gap);

      const float E = 0.0025;
      float height = 0.0;
      vec2 ripple = vec2(0.0);
      for (int i = 0; i < ${RIPPLE_SLOTS}; i++) {
        float age = u_rippleAges[i];
        if (age < 0.0) continue;
        // 파장은 동작이 감지된 화면 위치에서 시작한다.
        vec2 fromOrigin = p - (u_rippleOrigins[i] - 0.5) * toUnits;
        float r = length(fromOrigin);
        vec2 dir = r > 0.0001 ? fromOrigin / r : vec2(0.0);
        height += rippleHeight(r, age);
        ripple += dir * (rippleHeight(r + E, age) - rippleHeight(max(r - E, 0.0), age)) / (2.0 * E);
      }
      if (cutAge >= 0.0) {
        height += sideWave(cutDist, cutWidth, cutAge);
        ripple += cutAway * centerFade * (
          sideWave(cutDist + E, cutWidth, cutAge) - sideWave(max(cutDist - E, 0.0), cutWidth, cutAge)
        ) / (2.0 * E);
      }
      ripple *= u_motion;
      height *= u_motion;

      vec2 slope = ambient + ripple;
      vec2 offset = slope / toUnits;

      // 수면 이미지: 같은 수면 기울기로 함께 흔들린다.
      // 갈라진 바깥쪽 물결은 궤적 쪽에서 끌어와 양옆으로 밀려난 것처럼 보이게 한다.
      vec3 water = texture2D(
        u_waterTexture,
        coverUv(v_uv + offset * WATER_REFRACTION + partShift / toUnits)
      ).rgb;
      float waterLuma = dot(water, LUMA);
      vec3 color = water;
      vec3 floorColor = DEEP_WATER;

      if (u_cameraMix > 0.001) {
        float inside;
        vec2 rimBend = cutAway * rim * 0.012 * u_motion / toUnits;
        vec2 cameraUv = mirroredCoverUv(v_uv + offset * CAMERA_REFRACTION + rimBend, inside);

        // 물 너머처럼 살짝 무르게: 5탭 블러
        vec2 texel = 1.6 / max(u_videoSize, vec2(1.0));
        vec3 camera = texture2D(u_cameraTexture, cameraUv).rgb * 0.4;
        camera += texture2D(u_cameraTexture, cameraUv + vec2(texel.x, 0.0)).rgb * 0.15;
        camera += texture2D(u_cameraTexture, cameraUv - vec2(texel.x, 0.0)).rgb * 0.15;
        camera += texture2D(u_cameraTexture, cameraUv + vec2(0.0, texel.y)).rgb * 0.15;
        camera += texture2D(u_cameraTexture, cameraUv - vec2(0.0, texel.y)).rgb * 0.15;

        // 물이 걷힌 틈으로는 얼굴이 덜 물든 채 더 또렷하게 보인다.
        vec3 clearCamera = mix(vec3(dot(camera, LUMA)), camera, 0.82);
        clearCamera = mix(clearCamera, UNDERWATER, 0.2);
        clearCamera = SHADOW_TINT * 0.6 + clearCamera * (1.0 - SHADOW_TINT * 0.6);

        // 하늘색으로 중화하되 명암은 남긴다.
        camera = mix(vec3(dot(camera, LUMA)), camera, 0.74);
        camera = mix(camera, UNDERWATER, 0.24);
        camera = SHADOW_TINT + camera * (1.0 - SHADOW_TINT);

        float focus = 1.0 - 0.32 * smoothstep(0.32, 0.95, length(p * vec2(0.82, 1.0)));
        float visibility = u_cameraMix * inside * focus;

        // 수면의 어두운 결에서는 얼굴이 더 비치고, 밝은 반사광은 얼굴 위에 남는다.
        float waterWeight = mix(0.36, 0.64, smoothstep(0.62, 0.95, waterLuma));
        vec3 base = mix(water, mix(camera, water, waterWeight), visibility);
        vec3 screened = 1.0 - (1.0 - base) * (1.0 - water * 0.32);
        vec3 composite = mix(base, screened, 0.5);
        float glint = smoothstep(0.84, 1.0, waterLuma);
        composite = mix(composite, max(composite, water), glint * 0.6);
        composite = (composite - 0.6) * 1.07 + 0.6;
        color = mix(color, composite, visibility);
        floorColor = mix(DEEP_WATER, clearCamera, u_cameraMix * inside);
      }

      if (gap > 0.0) {
        // 완전히 비우지 않고 얇은 물막과 물결 반사를 조금 남긴다.
        float innerShadow = smoothstep(cutWidth * 0.1, cutWidth * 0.9, cutDist) * 0.08;
        vec3 thinWater = mix(floorColor, water, 0.22) - innerShadow;
        color = mix(color, thinWater, gap * 0.82);
      }

      // 수면 기울기로 생기는 명암: 파장 마루는 밝게, 골은 어둡게, 눌린 중앙은 살짝 가라앉게.
      vec2 light = normalize(LIGHT);
      float shade = dot(ambient, light) * 3.0 + dot(ripple, light) * 7.0;
      color += shade * vec3(0.92, 0.98, 1.0);
      color += height * 110.0 * vec3(0.85, 0.95, 1.0);
      color += rim * (0.14 + 0.1 * dot(cutAway, light)) * vec3(0.95, 1.0, 1.0);

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `;

  const program = gl.createProgram();
  gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "수면 효과를 연결하지 못했습니다.");
  }

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );

  const position = gl.getAttribLocation(program, "a_position");
  const uniforms = {};
  [
    "u_waterTexture",
    "u_cameraTexture",
    "u_resolution",
    "u_waterSize",
    "u_videoSize",
    "u_time",
    "u_cameraMix",
    "u_motion",
    "u_impact",
    "u_rippleAges[0]",
    "u_rippleOrigins[0]",
    "u_trail[0]",
  ].forEach((name) => {
    uniforms[name] = gl.getUniformLocation(program, name);
  });

  function createTexture() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([191, 238, 255, 255]),
    );
    return texture;
  }

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const waterTexture = createTexture();
  const cameraTexture = createTexture();

  const image = new Image();
  image.decoding = "async";
  image.src = "./assets/water-surface.png";

  let textureReady = false;
  let cameraVideo = null;
  let cameraShownAt = -Infinity;
  let frameId;
  const rippleStarts = new Array(RIPPLE_SLOTS).fill(-Infinity);
  const rippleAges = new Float32Array(RIPPLE_SLOTS);
  const rippleOrigins = new Float32Array(RIPPLE_SLOTS * 2).fill(0.5);
  const trail = [];
  const trailData = new Float32Array(TRAIL_POINTS * 4);

  image.addEventListener("load", () => {
    gl.bindTexture(gl.TEXTURE_2D, waterTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    textureReady = true;
  });

  image.addEventListener("error", () => {
    setStatus("수면 이미지를 불러오지 못했습니다.");
  });

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.round(target.clientWidth * ratio));
    const height = Math.max(1, Math.round(target.clientHeight * ratio));
    if (target.width !== width || target.height !== height) {
      target.width = width;
      target.height = height;
      gl.viewport(0, 0, width, height);
    }
  }

  function updateCamera(now) {
    if (!cameraVideo || cameraVideo.readyState < 2 || !cameraVideo.videoWidth) return 0;

    gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cameraVideo);

    if (cameraShownAt === -Infinity) cameraShownAt = now;
    const progress = Math.min(1, (now - cameraShownAt) / CAMERA_FADE_IN);
    return 1 - Math.pow(1 - progress, 3);
  }

  function updateRipples(now) {
    let impact = 0;
    for (let i = 0; i < rippleStarts.length; i += 1) {
      const age = (now - rippleStarts[i]) / 1000;
      const active = age >= 0 && age <= RIPPLE_LIFE;
      rippleAges[i] = active ? age : -1;
      if (active) {
        impact += Math.min(1, age / 0.35) * Math.exp(-age * 0.9);
      }
    }
    return Math.min(impact, 1.4);
  }

  function updateTrail(now) {
    while (trail.length && (now - trail[0].time) / 1000 > TRAIL_LIFE) trail.shift();
    for (let i = 0; i < TRAIL_POINTS; i += 1) {
      const point = trail[i];
      trailData[i * 4] = point ? point.x : 0;
      trailData[i * 4 + 1] = point ? point.y : 0;
      trailData[i * 4 + 2] = point ? (now - point.time) / 1000 : -1;
      trailData[i * 4 + 3] = point ? (point.start ? -point.strength : point.strength) : 0;
    }
  }

  function render(now) {
    resize();

    if (!textureReady) {
      gl.clearColor(0.75, 0.93, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      frameId = requestAnimationFrame(render);
      return;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE1);
    const cameraMix = updateCamera(now);
    gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
    gl.uniform1i(uniforms.u_cameraTexture, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, waterTexture);
    gl.uniform1i(uniforms.u_waterTexture, 0);

    const impact = updateRipples(now);

    gl.uniform2f(uniforms.u_resolution, target.width, target.height);
    gl.uniform2f(uniforms.u_waterSize, image.naturalWidth || 1, image.naturalHeight || 1);
    gl.uniform2f(
      uniforms.u_videoSize,
      cameraVideo?.videoWidth || 1,
      cameraVideo?.videoHeight || 1,
    );
    gl.uniform1f(uniforms.u_time, now * 0.001);
    gl.uniform1f(uniforms.u_cameraMix, cameraMix);
    gl.uniform1f(uniforms.u_motion, reduceMotion ? 0.3 : 1);
    gl.uniform1f(uniforms.u_impact, impact);
    gl.uniform1fv(uniforms["u_rippleAges[0]"], rippleAges);
    gl.uniform2fv(uniforms["u_rippleOrigins[0]"], rippleOrigins);
    updateTrail(now);
    gl.uniform4fv(uniforms["u_trail[0]"], trailData);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    frameId = requestAnimationFrame(render);
  }

  frameId = requestAnimationFrame(render);

  return {
    // origin: 화면 좌표(0~1, 왼쪽 아래가 원점)
    ripple(origin = CENTER) {
      let oldest = 0;
      for (let i = 1; i < rippleStarts.length; i += 1) {
        if (rippleStarts[i] < rippleStarts[oldest]) oldest = i;
      }
      rippleStarts[oldest] = performance.now();
      rippleOrigins[oldest * 2] = origin.x;
      rippleOrigins[oldest * 2 + 1] = origin.y;
    },
    // 가르기 궤적에 점 추가. start면 앞 점과 잇지 않고 새 획을 시작한다.
    cut(point, strength = 1, start = false) {
      const now = performance.now();
      const last = trail[trail.length - 1];
      if (!start && last && now - last.time < TRAIL_MIN_GAP) return;
      trail.push({ x: point.x, y: point.y, time: now, strength, start });
      if (trail.length > TRAIL_POINTS) trail.shift();
    },
    // MediaPipe 좌표(영상 기준, 왼쪽 위가 원점)를 셰이더와 같은 반전·cover 규칙으로 화면 좌표로 바꾼다.
    videoToScreen(point) {
      const videoWidth = cameraVideo?.videoWidth;
      const videoHeight = cameraVideo?.videoHeight;
      if (!videoWidth || !videoHeight) return CENTER;
      const fitX = target.width / videoWidth;
      const fitY = target.height / videoHeight;
      const scale = Math.max(Math.min(fitX, fitY), Math.max(fitX, fitY) * CAMERA_ZOOM_LIMIT);
      return {
        x: (0.5 - point.x) * (scale * videoWidth) / target.width + 0.5,
        y: (0.5 - point.y) * (scale * videoHeight) / target.height + 0.5,
      };
    },
    attachCamera(source) {
      cameraVideo = source;
      cameraShownAt = -Infinity;
    },
    detachCamera() {
      cameraVideo = null;
    },
    destroy() {
      cancelAnimationFrame(frameId);
    },
  };
}

// source마다 쿨다운을 따로 두어 눈·입·손이 동시에 움직여도 각자 파장을 만든다.
function triggerRipple(source, origin = CENTER) {
  const now = performance.now();
  if (now - (lastRippleAt.get(source) ?? -Infinity) < RIPPLE_COOLDOWN) return;
  lastRippleAt.set(source, now);
  renderer?.ripple(origin);
}

function averagePoint(landmarks, indices) {
  const sum = indices.reduce(
    (total, index) => ({ x: total.x + landmarks[index].x, y: total.y + landmarks[index].y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / indices.length, y: sum.y / indices.length };
}

function videoPointToScreen(point) {
  return renderer?.videoToScreen(point) ?? CENTER;
}

// 눈꺼풀 사이 거리 / 눈 가로 길이. 작을수록 감긴 눈.
function eyeOpenness(landmarks, [outer, inner, upper, lower]) {
  const width = Math.hypot(landmarks[outer].x - landmarks[inner].x, landmarks[outer].y - landmarks[inner].y);
  const gap = Math.hypot(landmarks[upper].x - landmarks[lower].x, landmarks[upper].y - landmarks[lower].y);
  return gap / (width || 1);
}

const RIGHT_EYE = [33, 133, 159, 145];
const LEFT_EYE = [362, 263, 386, 374];

// 감긴 쪽 눈 위치. 양쪽이 비슷하게 감겼으면 두 눈 사이.
function closedEyePoint(landmarks) {
  const rightPoint = averagePoint(landmarks, [RIGHT_EYE[0], RIGHT_EYE[1]]);
  const leftPoint = averagePoint(landmarks, [LEFT_EYE[0], LEFT_EYE[1]]);
  const right = eyeOpenness(landmarks, RIGHT_EYE);
  const left = eyeOpenness(landmarks, LEFT_EYE);
  if (right < left * 0.7) return rightPoint;
  if (left < right * 0.7) return leftPoint;
  return { x: (rightPoint.x + leftPoint.x) / 2, y: (rightPoint.y + leftPoint.y) / 2 };
}

function findBlendshape(categories, name) {
  return categories.find((item) => item.categoryName === name)?.score ?? 0;
}

function showGestureHint() {
  setStatus("윙크 · 입 뻐끔 · 손 쥐었다 펴기");
}

function processFace(result) {
  const categories = result.faceBlendshapes?.[0]?.categories;
  const landmarks = result.faceLandmarks?.[0];

  if (!categories?.length || !landmarks?.length) {
    if (hasDetectedFace) {
      hasDetectedFace = false;
      setStatus("얼굴을 화면 안에 맞춰주세요.");
    }
    return;
  }

  if (!hasDetectedFace) {
    hasDetectedFace = true;
    showGestureHint();
  }

  // 윙크도 잡히도록 더 많이 감긴 쪽 눈을 기준으로 본다. 감았다 뜨는 순간 파장.
  const blink = Math.max(
    findBlendshape(categories, "eyeBlinkLeft"),
    findBlendshape(categories, "eyeBlinkRight"),
  );

  // 감는 순간 어느 눈이 감겼는지 기억해 두고, 뜨는 순간 그 눈 위치에서 파장.
  if (!eyesClosed && blink > BLINK_THRESHOLD) {
    eyesClosed = true;
    blinkOrigin = closedEyePoint(landmarks);
  }

  if (eyesClosed && blink < BLINK_RELEASE) {
    eyesClosed = false;
    triggerRipple("eye", videoPointToScreen(blinkOrigin ?? closedEyePoint(landmarks)));
  }

  // 입 뻐끔: 입이 벌어지는 순간 파장, 다시 다물어야 다음 뻐끔을 받는다.
  const mouth = Math.max(
    findBlendshape(categories, "jawOpen"),
    findBlendshape(categories, "mouthFunnel") * 0.9,
  );

  if (!mouthOpen && mouth > MOUTH_THRESHOLD) {
    mouthOpen = true;
    triggerRipple("mouth", videoPointToScreen(averagePoint(landmarks, [13, 14, 78, 308])));
  }

  if (mouthOpen && mouth < MOUTH_RELEASE) {
    mouthOpen = false;
  }
}

// 손가락 끝(검지~새끼)이 손목에서 얼마나 멀리 있는지를 손바닥 길이로 나눈 값.
// 펼친 손은 약 1.8 이상, 주먹은 1.2 이하로 나온다.
function handOpenness(landmarks) {
  const width = video.videoWidth || 1;
  const height = video.videoHeight || 1;
  const distance = (a, b) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
  const wrist = landmarks[0];
  const palm = distance(wrist, landmarks[9]) || 1;
  const tips = [8, 12, 16, 20];
  return tips.reduce((sum, index) => sum + distance(wrist, landmarks[index]), 0)
    / tips.length / palm;
}

// 화면 좌표 두 점 사이 거리(짧은 변 = 1)
function screenDistance(a, b) {
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;
  const short = Math.min(width, height);
  return Math.hypot((a.x - b.x) * width / short, (a.y - b.y) * height / short);
}

function cutStrength(speed) {
  return Math.min(1.3, Math.max(0.7, 0.6 + speed * 0.18));
}

// 손 라벨(왼손/오른손)은 빠르게 움직일 때 자주 뒤바뀌므로, 직전 위치와 가까운 손끼리 이어 붙인다.
function matchHandTrack(point, now, taken) {
  let best = null;
  let bestDistance = HAND_MATCH_DISTANCE;
  for (const track of handTracks) {
    if (taken.has(track) || now - track.time > HAND_LOST_GRACE) continue;
    const distance = screenDistance(track, point);
    if (distance < bestDistance) {
      best = track;
      bestDistance = distance;
    }
  }
  if (!best) {
    best = { id: `hand-${(nextTrackId += 1)}`, x: point.x, y: point.y, time: now, fresh: true };
    handTracks.push(best);
  }
  taken.add(best);
  return best;
}

// 손바닥이 빠르게 지나가면 그 궤적을 따라 수면이 갈라진다.
function trackHandCut(point, openness, now, taken) {
  const track = matchHandTrack(point, now, taken);
  const previous = track.fresh ? null : { x: track.x, y: track.y, time: track.time };
  Object.assign(track, { x: point.x, y: point.y, time: now, fresh: false });
  if (!previous) return;

  // 감지가 끊겼다 다시 잡힌 경우도 그 사이를 곧게 지나간 것으로 보고 속도를 잰다.
  const speed = screenDistance(previous, point) / Math.max((now - previous.time) / 1000, 0.016);
  const cutting = activeCut === track.id;
  const fastEnough = speed > (cutting ? CUT_SPEED_KEEP : CUT_SPEED_START);

  if (openness > CUT_OPENNESS && fastEnough && (!activeCut || cutting)) {
    if (!cutting) renderer?.cut(previous, cutStrength(speed), true);
    renderer?.cut(point, cutStrength(speed));
    activeCut = track.id;
    activeCutAt = now;
  } else if (cutting && now - activeCutAt > 220) {
    activeCut = null;
  }
}

function processHands(result) {
  const seen = new Set();
  const now = performance.now();
  const taken = new Set();

  (result.landmarks ?? []).forEach((landmarks, index) => {
    const key = result.handedness?.[index]?.[0]?.categoryName ?? String(index);
    seen.add(key);
    const openness = handOpenness(landmarks);
    const closed = handsClosed.get(key) ?? false;
    trackHandCut(videoPointToScreen(averagePoint(landmarks, [0, 5, 9, 13, 17])), openness, now, taken);

    // 손 깜빡: 주먹을 쥐었다가 다시 펴는 순간 파장.
    if (!closed && openness < HAND_CLOSED) {
      handsClosed.set(key, true);
    } else if (closed && openness > HAND_OPEN) {
      handsClosed.set(key, false);
      triggerRipple(`hand-${key}`, videoPointToScreen(averagePoint(landmarks, [0, 5, 9, 13, 17])));
    } else if (!handsClosed.has(key)) {
      handsClosed.set(key, closed);
    }
  });

  for (const key of handsClosed.keys()) {
    if (!seen.has(key)) handsClosed.delete(key);
  }
  handTracks = handTracks.filter((track) => now - track.time <= HAND_LOST_GRACE);
  if (activeCut?.startsWith("hand-") && now - activeCutAt > HAND_LOST_GRACE) activeCut = null;
}

async function initializeLandmarkers() {
  const visionModule = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs"
  );
  const { FaceLandmarker, HandLandmarker, FilesetResolver } = visionModule;
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
  );

  const face = FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
  });

  // 손 감지기는 실패해도 눈·입 반응은 계속 동작하게 둔다.
  const hand = HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.35,
    minHandPresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
  }).catch((error) => {
    console.error(error);
    return null;
  });

  return { face: await face, hand: await hand };
}

function runCameraLoop(now) {
  cameraLoopId = requestAnimationFrame(runCameraLoop);

  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  if (now - lastDetectionAt < 30) return;

  lastDetectionAt = now;
  lastVideoTime = video.currentTime;
  detectionTick += 1;

  // 손은 빠르게 움직이므로 새 영상 프레임마다, 얼굴은 한 프레임 걸러 감지한다.
  if (handLandmarker) {
    try {
      processHands(handLandmarker.detectForVideo(video, now));
    } catch (error) {
      console.error(error);
    }
  }

  if (handLandmarker && detectionTick % 2 === 1) return;
  try {
    processFace(landmarker.detectForVideo(video, now));
  } catch (error) {
    console.error(error);
  }
}

async function startCamera() {
  retryButton.hidden = true;
  setStatus("카메라를 켜는 중");

  try {
    // 감지 모델은 받는 데 시간이 걸리므로 카메라 영상부터 먼저 띄운다.
    const detectorsReady = landmarker ? null : initializeLandmarkers();
    detectorsReady?.catch(() => {});

    if (!stream?.active) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 960 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    }
    video.srcObject = stream;
    await video.play();
    renderer?.attachCamera(video);

    if (detectorsReady) {
      setStatus("얼굴 감지기를 준비하는 중");
      const detectors = await detectorsReady;
      landmarker = detectors.face;
      handLandmarker = detectors.hand;
    }

    setStatus("얼굴을 화면 안에 맞춰주세요.");
    if (cameraLoopId) cancelAnimationFrame(cameraLoopId);
    cameraLoopId = requestAnimationFrame(runCameraLoop);
  } catch (error) {
    console.error(error);
    const messages = {
      NotAllowedError: "카메라 권한을 허용해 주세요.",
      NotReadableError: "다른 탭이나 프로그램이 카메라를 쓰고 있어요.",
      NotFoundError: "연결된 카메라를 찾지 못했습니다.",
    };
    const cameraOn = Boolean(stream?.active);
    setStatus(
      cameraOn
        ? "얼굴 감지기를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요."
        : messages[error?.name]
        ?? `카메라를 시작하지 못했습니다. (${error?.name || error?.message || "알 수 없는 오류"})`,
    );
    retryButton.hidden = false;
  }
}

function stopCamera() {
  if (cameraLoopId) cancelAnimationFrame(cameraLoopId);
  renderer?.detachCamera();
  stream?.getTracks().forEach((track) => track.stop());
  landmarker?.close?.();
  handLandmarker?.close?.();
}

try {
  renderer = createWaterRenderer(canvas);
} catch (error) {
  console.error(error);
  document.body.style.backgroundImage = "url('./assets/water-surface.png')";
  document.body.style.backgroundSize = "cover";
  setStatus(error.message || "수면 효과를 준비하지 못했습니다.");
}

startCamera();
retryButton.addEventListener("click", startCamera);

function pointerToScreen(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: 1 - (event.clientY - rect.top) / rect.height,
  };
}

// 드래그하면 손으로 가르는 것과 같은 효과. 원형 파장은 눈·입·손 깜빡임으로만 생긴다.
let pointerStroke = null;

window.addEventListener("pointerdown", (event) => {
  if (retryButton.contains(event.target)) return;
  const point = pointerToScreen(event);
  pointerStroke = { start: point, last: point, time: performance.now(), dragged: false };
});

window.addEventListener("pointermove", (event) => {
  if (!pointerStroke) return;
  const point = pointerToScreen(event);
  const now = performance.now();
  const moved = screenDistance(pointerStroke.last, point);
  if (moved < 0.004) return;
  const speed = moved / Math.max((now - pointerStroke.time) / 1000, 0.001);
  if (!pointerStroke.dragged) {
    pointerStroke.dragged = true;
    activeCut = "pointer";
    renderer?.cut(pointerStroke.start, cutStrength(speed), true);
  }
  renderer?.cut(point, cutStrength(speed));
  pointerStroke.last = point;
  pointerStroke.time = now;
});

function endPointerStroke() {
  if (!pointerStroke) return;
  if (activeCut === "pointer") activeCut = null;
  pointerStroke = null;
}

window.addEventListener("pointerup", endPointerStroke);
window.addEventListener("pointercancel", endPointerStroke);

window.addEventListener("pagehide", stopCamera, { once: true });
