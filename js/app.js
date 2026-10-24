
"use strict";
(async () => {
  // Older cached HTML can request the new app before it knows about this small
  // dependency. Load it once so an update cannot strand an existing player.
  if(!globalThis.PhiPerformance)await new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='./js/performance-policy.js?v=4.0.1.2-input-8';
    script.onload=resolve;script.onerror=()=>reject(Error('性能组件加载失败，请刷新页面'));document.head.appendChild(script);
  });
  let phiExportViewport=null;
  const $ = (s) => document.querySelector(s)||phiExportViewport?.document?.querySelector(s)||null;
  const gameplayDocument = () => phiExportViewport?.document||document;
  const enc = new TextEncoder(),
    dec = new TextDecoder("utf-8");
  const DB_NAME = "phi-offline-db",
    DB_VERSION = 3,
    LIBRARY_BACKUP_FORMAT = "phi-offline-library-backup",
    LIBRARY_BACKUP_VERSION = 2;
  let activeOfficialFontFace = null,
    activeOfficialFontURL = "",
    officialFontLoaded = true,
    officialFontSource = "Embedded Saira Regular (OFL-1.1)";

  /**
   * Phi Offline Next 的集中版本与安全限制。
   * Builder 与独立游戏均从同一份 Runtime 模板生成，避免版本漂移。
   */
  const PHI_VERSIONS = Object.freeze({
    runtime: "4.0.1.2-input-8",
    parser: "9.0-native-sus",
    renderEngine: "38.3-safari-caption-baseline",
    buildTimestamp: "2026-10-24T04:14:45Z",
    coreSha256: "dcae237af6ee34b393b4ceea31605c87aaf0d0b737c95da89cc12e9cd5dbe677",
  });
  const PHI_SECURITY_LIMITS = Object.freeze({
    maxArchiveDepth: 4,
    maxArchiveCount: 128,
    maxEntryCount: 20000,
    maxSingleUncompressedBytes: 256 * 1024 * 1024,
    maxTotalUncompressedBytes: 1024 * 1024 * 1024,
    maxCompressedInputBytes: 512 * 1024 * 1024,
    maxCompressionRatio: 200,
  });
  const PHI_MODULES = Object.create(null);
  const registerModule = (name, value) => (PHI_MODULES[name] = value);

  class DiagnosticsHub {
    constructor(limit = 800) {
      this.limit = limit;
      this.items = [];
      this.sequence = 0;
      this.overlay = null;
      this.visible = false;
    }
    push(level, stage, message, context = null) {
      const item = {
        id: ++this.sequence,
        at: new Date().toISOString(),
        level,
        stage: String(stage || "runtime"),
        message: String(message || "未知信息"),
        context: context && typeof context === "object" ? context : null,
      };
      this.items.push(item);
      if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
      if (level === "error") console.error(`[Phi/${item.stage}] ${item.message}`, context || "");
      else if (level === "warn") console.warn(`[Phi/${item.stage}] ${item.message}`, context || "");
      this.refresh();
      return item;
    }
    info(stage, message, context) { return this.push("info", stage, message, context); }
    warn(stage, message, context) { return this.push("warn", stage, message, context); }
    error(stage, error, context) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error || "未知错误");
      const data = { ...(context || {}) };
      if (error instanceof Error && error.stack) data.stack = error.stack;
      return this.push("error", stage, message, data);
    }
    report() {
      const caps = CapabilityDetector.detect();
      const head = [
        `Phi Offline Next 诊断报告`,
        `Runtime: ${PHI_VERSIONS.runtime}`,
        `Parser: ${PHI_VERSIONS.parser}`,
        `Render: ${PHI_VERSIONS.renderEngine}`,
        `Build: ${PHI_VERSIONS.buildTimestamp}`,
        `Core SHA-256: ${PHI_VERSIONS.coreSha256}`,
        `Storage: ${typeof storageMode === "string" ? storageMode : "initializing"}`,
        `Capabilities: ${JSON.stringify(caps)}`,
        `Performance: ${typeof performanceMonitor === "object" ? JSON.stringify(performanceMonitor.snapshot()) : "initializing"}`,
        `Input: ${typeof engine === "object" && engine ? JSON.stringify(engine.inputStats) : "idle"}`,
        `Network audit: ${JSON.stringify(globalThis.__phiNetworkAudit || {})}`,
        "",
      ];
      return head.concat(this.items.map((x) => {
        const context = x.context ? `\n  ${JSON.stringify(x.context)}` : "";
        return `${x.at} [${x.level.toUpperCase()}] ${x.stage}: ${x.message}${context}`;
      })).join("\n");
    }
    ensureOverlay() {
      if (this.overlay) return this.overlay;
      const el = document.createElement("section");
      el.id = "phiDiagnosticsOverlay";
      el.className = "phiDevOverlay hidden";
      el.innerHTML = `<div class="phiDevHead"><strong>诊断 / F1</strong><span class="phiDevSpacer"></span><button data-act="copy">复制</button><button data-act="download">下载</button><button data-act="close">关闭</button></div><pre></pre>`;
      document.body.appendChild(el);
      el.addEventListener("click", async (event) => {
        const act = event.target?.dataset?.act;
        if (act === "close") this.toggle(false);
        if (act === "copy") {
          try { await navigator.clipboard.writeText(this.report()); toast("诊断日志已复制"); }
          catch (error) { this.error("Diagnostics.copy", error); toast("无法访问剪贴板，请使用下载", true); }
        }
        if (act === "download") {
          const blob = new Blob([this.report()], { type: "text/plain;charset=utf-8" });
          const url = URL.createObjectURL(blob), a = document.createElement("a");
          a.href = url; a.download = `Phi_Offline_Next_Diagnostics_${Date.now()}.txt`; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      });
      this.overlay = el;
      this.refresh();
      return el;
    }
    refresh() {
      if (!this.overlay || !this.visible) return;
      const pre = this.overlay.querySelector("pre");
      if (pre) pre.textContent = this.report();
    }
    toggle(force) {
      const el = this.ensureOverlay();
      this.visible = force == null ? !this.visible : !!force;
      el.classList.toggle("hidden", !this.visible);
      this.refresh();
    }
  }
  const Diagnostics = new DiagnosticsHub();

  class CapabilityDetector {
    static detect() {
      let webgl2 = false;
      try {
        const probe = document.createElement("canvas"), gl = probe.getContext("webgl2");
        webgl2 = !!gl;
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        probe.width = probe.height = 1;
      } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      return Object.freeze({
        webAudio: !!(window.AudioContext || window.webkitAudioContext),
        webgl2,
        pointerEvents: "PointerEvent" in window,
        pointerRawUpdate: "onpointerrawupdate" in window,
        offscreenCanvas: "OffscreenCanvas" in window,
        imageBitmap: "createImageBitmap" in window,
        decompressionStream: "DecompressionStream" in window,
        indexedDB: "indexedDB" in window,
        fileSystemAccess: "showSaveFilePicker" in window,
        devicePixelRatio: Number(window.devicePixelRatio || 1),
      });
    }
  }

  function reportRecoverable(stage, error, context = null) {
    Diagnostics.error(stage, error, context);
    return error;
  }
  window.addEventListener("error", (event) => Diagnostics.error("ErrorBoundary.window", event.error || event.message, { filename: event.filename, line: event.lineno, column: event.colno }));
  window.addEventListener("unhandledrejection", (event) => Diagnostics.error("ErrorBoundary.promise", event.reason));
  // Tap/Hold retain the established Phigros-like windows. Drag/Flick stay
  // Perfect-or-Miss, but continuous touch and swipe recognition receive their
  // own wider acquisition windows so a 120-Hz scheduling hitch cannot erase a
  // gesture that was visibly on the judgement line.
  const PERFECT = 0.08,
    GOOD = 0.16,
    BAD = 0.18,
    NOTE_FADEOUT_TIME = 0.16,
    BAD_GHOST_TIME = 0.5,
    HOLD_GRACE = 0.16,
    HOLD_CANCEL_GHOST = 0,
    HOLD_TAIL_EARLY = BAD,
    HOLD_TAIL_FADE = 0.28,
    HOLD_MISS_ALPHA = 0.58,
    HOLD_HIT_FX_INTERVAL = 0.2,
    PACK_HOLD_OPACITY_BOOST = 0,
    SPECIAL_TAP_PROTECT_GAP = 0.22,
    SPECIAL_TAP_SAME_TIME_EPS = 0.003,
    DRAG_PREARM_EARLY = 0.20,
    DRAG_LATE_WINDOW = 0.18,
    DRAG_ARM_GRACE = 0.13;
  const JUDGE_GAIN = 1,
    DRAG_JUDGE_WIDTH_GAIN = 1.42,
    FLICK_JUDGE_WIDTH_GAIN = 1.20,
    FLICK_SPEED = 138,
    FLICK_TRAVEL = 5.5,
    FLICK_ARM_EARLY = 0.18,
    FLICK_ARM_LATE = 0.18,
    FLICK_REARM_MS = 58,
    FLICK_REARM_TRAVEL_GAIN = 0.42,
    MULTITOUCH_CANCEL_GRACE = 0.38,
    POINTER_DUPLICATE_EPS_MS = 0.08,
    POINTER_DUPLICATE_EPS_PX = 0.04,
    INPUT_DISPATCH_GRACE_MS = 48,
    COVER_EPS = 0.018;
  // Official-like global Note depth: Hold < Drag < Tap < Flick.
  // All judgement lines are rendered before these Note layers.
  const NOTE_RENDER_ORDER = Object.freeze([3, 2, 1, 4]);
  const JUDGE_NAMES = Object.freeze(["perfect", "good", "bad", "miss"]);
  const SYNC_SNAP = 0.035,
    SYNC_GAIN = 0.68,
    SYNC_MAX_RATE = 0.95,
    SYNC_STALL_GUARD = 0.09,
    AUTO_AUDIO_LOOKAHEAD = 0.42,
    AUDIO_START_GUARD = 0.045;
  const AUDIO_PUMP_MS = 64,
    HUD_PUMP_MS = 1000 / 60,
    // Progress is a compositor transform, but mutating two DOM trees at 120 Hz
    // still forces WebKit style work. 30 Hz is visually continuous for a thin
    // progress bar and removes up to 360 property writes per second.
    PROGRESS_PUMP_MS = 1000 / 30,
    // A full-screen 1.5× DPR supersample pushed iPad Pro to roughly 12.6
    // million backing pixels before effects. Render at the panel's physical
    // pixel density instead: on Retina iPad this is DPR 2 and preserves a
    // one-to-one final pixel resolve while cutting fill work by over half.
    // 120 Hz prioritizes frame-time consistency over invisible supersampling.
    // 12 MP keeps 1920×1080 at DPR 2 intact while preventing tablet-class
    // panels from allocating 16–20 MP backing stores every frame.
    MAX_CANVAS_PIXELS = 16000000,
    APPLE_120_CANVAS_PIXELS = 12000000,
    APPLE_HEAVY_CANVAS_PIXELS = APPLE_120_CANVAS_PIXELS,
    APPLE_120_START_QUALITY = 1.0,
    APPLE_HEAVY_CHART_START_QUALITY = 1.0,
    FROSTED_RASTER_MAX_SIDE = 1536,
    APPLE_EFFECT_RASTER_SCALE = 1,
    MAX_RENDER_DPR = 8,
    MIN_RENDER_DPR = 1.0,
    HIGH_QUALITY_DPR_SCALE = 1,
    HIGH_QUALITY_DPR_MIN = 1.0,
    RENDER_BUCKET_STEP = 0.25,
    RENDER_SCAN_BACK = 40,
    RENDER_SCAN_STEP = 1 / 120;
  const MAX_RENDER_FPS = 120,
    FRAME_TARGET_MS = 1000 / MAX_RENDER_FPS,
    HIGH_REFRESH_PROBE_MS = 4200,
    HIGH_REFRESH_TARGET_HZ = 120,
    FPS_MINI_PAINT_MS = 750,
    PERF_DPR_FLOOR = 1,
    PERF_QUALITY_MIN = 1,
    PERF_QUALITY_LEVELS = Object.freeze([1]),
    PERF_ADJUST_INTERVAL = 500,
    PERF_RESIZE_COOLDOWN_MS = 5000,
    PERF_RECOVERY_INTERVAL = 90000,
    PERF_OVERLOAD_STREAK = 28,
    PERF_SEVERE_STREAK = 10,
    PERF_HEADROOM_STREAK = 2400,
    APPLE_FIXED_120_QUALITY = true,
    // Visual fidelity is fixed for the whole song. Performance monitoring stays
    // active for diagnostics, but it never trades away authored effects or pixels.
    PERF_ALLOW_MIDSONG_RECOVERY = false,
    PERF_SAMPLE_EVERY = 4,
    FPS_SNAP_120_MIN = 116,
    FPS_SNAP_120_MAX = 123.5,
    FPS_MISSED_VBLANK_MS = 11.6,
    CHROMATIC_RENDER_SCALE = 1,
    LOW_RES_DPR_SCALE = 0.58,
    LOW_RES_DPR_CAP = 0.66,
    LOW_RES_DPR_FLOOR = 0.32,
    // Prewarm enough exact visual records for dense streams. The pools reduce
    // allocation only; they never limit how many active effects are displayed.
    HIT_PARTICLE_POOL_LIMIT = 192,
    HIT_EFFECT_POOL_LIMIT = 192,
    HIT_AUDIO_VOICE_LIMIT = 1024,
    HYPER120_SPATIAL_MARGIN = 0.12,
    HYPER120_MAX_NOTE_SKINS = 96,
    HYPER120_PREWARM_NOTE_SKINS = 64,
    HYPER120_PREWARM_HOLD_SKINS = 28,
    VIGNETTE_CACHE_LIMIT = 24,
    LIBRARY_SEARCH_DEBOUNCE_MS = 140,
    LIBRARY_STREAM_YIELD_EVERY = 4;
  const HYPER120_SPEED_BANDS = Object.freeze([
    1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64, 128, 256,
  ]);
  const DEFAULT_LINE_COLOR = [255, 255, 255];
  // sim-phi (lchzh3473) uses these authored hit-effect tints and alpha values:
  // Perfect rgba(255,236,160,.8823529), Good rgba(180,225,255,.9215686).
  // Judge-line FC remains #a2eeff; it is intentionally not reused for Good FX.
  const PHI_COLORS = Object.freeze({
    ap: "#fcffb2",
    fc: "#a2eeff",
    hitFxPerfect: "rgba(252,255,178,0.8823529)",
    hitFxGood: "rgba(180,225,255,0.9215686)",
    apRgb: "rgb(252,255,178)",
    fcRgb: "rgb(180,225,255)",
  });
  const PHI_NOTE_COLORS = Object.freeze({
    tap: "#58bfff",
    tapGlow: "#69c9ff",
    drag: "#ffe375",
    dragGlow: "#ffe48e",
    flick: "#ff6387",
    flickGlow: "#ff6f93",
    outline: "rgba(255,255,255,.82)",
  });
  const PGR_LINE_OFFICIAL_ASPECT = 16 / 9,
    PGR_LINE_DEFAULT_HALF_LENGTH = 6,
    PGR_LINE_REFERENCE_WIDTH = 1350,
    // Community renderers treat lineLength as an authored half-length setting,
    // not as a screen-height unit.  The default line texture is calibrated to
    // 4374 reference pixels across a 1350-wide authored field (3.24 fields).
    PGR_LINE_REFERENCE_TEXTURE_WIDTH = 4374,
    PGR_LINE_REFERENCE_THICKNESS = 4;
  const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|aac|flac|opus|webm|mka|aif|aiff|caf|kgg|kgm|kgma|vpr)$/i,
    IMG_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i,
    SHADER_EXT = /\.(glsl|frag|vert|fs|vs)$/i,
    IMPORT_ZIP_EXT = /\.(zip|pez)$/i,
    IMPORT_MAX_DEPTH = PHI_SECURITY_LIMITS.maxArchiveDepth,
    IMPORT_MAX_ARCHIVES = PHI_SECURITY_LIMITS.maxArchiveCount;

  // -------------------------------------------------------------------------
  // Audio compatibility bridge (derived from the user-provided Diamond Master
  // v1.5 pipeline): identify audio by file signature instead of trusting the
  // filename suffix, normalize MIME, and support its offline Kugou byte-unlock
  // stage before Web Audio decoding. This is deliberately import-time work so
  // gameplay itself does not pay conversion/decryption cost during 120 Hz play.
  // -------------------------------------------------------------------------
  const PHI_AUDIO_KGM_MAGIC = new Uint8Array([0x7c,0xd5,0x32,0xeb,0x86,0x02,0x7f,0x4b,0xa8,0xaf,0xa6,0x8e,0x0f,0xff,0x99,0x14]),
    PHI_AUDIO_VPR_MAGIC = new Uint8Array([0x05,0x28,0xbc,0x96,0xe9,0xe4,0x5a,0x43,0x91,0xaa,0xbd,0xd0,0x7a,0xf5,0x36,0x31]);
  let phiKgmModulePromise = null;
  const hostedScriptPromises=new Map();
  function loadHostedScript(path){
    const href=PhiHostedMedia.url(path);
    if(!hostedScriptPromises.has(href)){
      const pending=new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src=href;script.async=true;
        script.onload=()=>resolve();script.onerror=()=>{script.remove();reject(Error('组件加载失败：'+path));};
        document.head.appendChild(script);
      });
      hostedScriptPromises.set(href,pending);pending.catch(()=>hostedScriptPromises.delete(href));
    }
    return hostedScriptPromises.get(href);
  }
  const phiKggKeyCache = new WeakMap();
  function phiAudioHasMagic(bytes, magic, off = 0) {
    if (!bytes || off < 0 || off + magic.length > bytes.length) return false;
    for (let i = 0; i < magic.length; i++) if (bytes[off + i] !== magic[i]) return false;
    return true;
  }
  function phiAudioReadLE32(bytes, off) {
    if (!bytes || off < 0 || off + 4 > bytes.length) return 0;
    return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
  }
  function phiAudioExt(name) {
    const m = String(name || "").toLowerCase().match(/\.([^.\\/]+)$/);
    return m ? m[1] : "";
  }
  function phiAudioMime(ext) {
    return ({
      mp3:"audio/mpeg", ogg:"audio/ogg", opus:"audio/ogg", wav:"audio/wav",
      flac:"audio/flac", m4a:"audio/mp4", mp4:"audio/mp4", aac:"audio/aac",
      webm:"audio/webm", mka:"audio/webm", aif:"audio/aiff", aiff:"audio/aiff",
      caf:"audio/x-caf"
    })[String(ext || "").toLowerCase()] || "application/octet-stream";
  }
  function phiEncryptedAudioKind(bytes, fileName = "") {
    const ext = phiAudioExt(fileName);
    if (phiAudioHasMagic(bytes, PHI_AUDIO_VPR_MAGIC)) return "vpr";
    if (phiAudioHasMagic(bytes, PHI_AUDIO_KGM_MAGIC)) {
      const headerLen = phiAudioReadLE32(bytes, 0x10),
        cryptoVersion = phiAudioReadLE32(bytes, 0x14),
        hashLen = phiAudioReadLE32(bytes, 0x44),
        looksLikeKgg = cryptoVersion === 5 && headerLen > 0 && headerLen < Math.max(bytes.length, headerLen + 1) && hashLen > 0 && hashLen <= 256;
      if (looksLikeKgg || ext === "kgg") return "kgg";
      return ext === "kgma" ? "kgma" : "kgm";
    }
    return /^(kgg|kgm|kgma|vpr)$/.test(ext) ? ext : "";
  }
  function phiDetectAudioBytes(bytes, fileName = "", declaredMime = "") {
    let core = null;
    try { core = phiEnsureAudioHeaderCore(); } catch {}
    if (core?.detectAudio) {
      try {
        const detected = core.detectAudio(bytes);
        if (detected?.ext && detected.ext !== "bin") return detected;
      } catch (error) { Diagnostics?.warn?.("AudioCompat.detect", error?.message || String(error)); }
    }
    // Extra signatures not covered by the reference converter's small detector.
    if (bytes?.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
      return { ext: "webm", mime: "audio/webm" };
    if (bytes?.length >= 12 && String.fromCharCode(...bytes.subarray(0,4)) === "FORM") {
      const kind = String.fromCharCode(...bytes.subarray(8,12));
      if (kind === "AIFF" || kind === "AIFC") return { ext: "aiff", mime: "audio/aiff" };
    }
    if (bytes?.length >= 4 && String.fromCharCode(...bytes.subarray(0,4)) === "caff")
      return { ext: "caf", mime: "audio/x-caf" };
    const ext = phiAudioExt(fileName), mime = declaredMime || phiAudioMime(ext);
    return { ext: ext || "bin", mime: mime || "application/octet-stream" };
  }
  async function phiAudioHead(entry, size = 512) {
    const blob = entry?.blob || entry;
    if (!(blob instanceof Blob)) return new Uint8Array();
    return new Uint8Array(await blob.slice(0, Math.min(size, blob.size)).arrayBuffer());
  }
  function phiEnsureAudioHeaderCore() {
    if (!window.KugouCore?.detectAudio) throw new Error("内嵌音频识别核心初始化失败");
    return window.KugouCore;
  }
  async function phiGetKgmModule() {
    if(typeof window.KgmCryptoModule!=='function')await loadHostedScript('./js/vendor/kgm-core.js');
    if (typeof window.KgmCryptoModule !== "function") throw new Error("内嵌 KGM/KGMA/VPR 离线 WASM 模块未加载");
    if (!phiKgmModulePromise)
      phiKgmModulePromise = window.KgmCryptoModule().catch((error) => { phiKgmModulePromise = null; throw error; });
    return phiKgmModulePromise;
  }
  async function phiDecryptKgmFamily(bytes, ext) {
    const expected = ext === "vpr" ? PHI_AUDIO_VPR_MAGIC : PHI_AUDIO_KGM_MAGIC;
    if (bytes.length < 64 || !phiAudioHasMagic(bytes, expected)) throw new Error(`${ext.toUpperCase()} 文件头不匹配`);
    const module = await phiGetKgmModule(), CHUNK = 2 * 1024 * 1024, ptr = module._malloc(CHUNK);
    if (!ptr) throw new Error("KGM WASM 内存申请失败");
    try {
      const preSize = Math.min(CHUNK, bytes.length);
      module.writeArrayToMemory(bytes.subarray(0, preSize), ptr);
      const headerSize = module.preDec(ptr, preSize, ext);
      if (!Number.isInteger(headerSize) || headerSize <= 0 || headerSize >= bytes.length)
        throw new Error("KGM/KGMA/VPR 版本暂不受支持或文件头损坏");
      const out = new Uint8Array(bytes.length - headerSize);
      for (let offset = 0; offset < out.length; offset += CHUNK) {
        const blockSize = Math.min(CHUNK, out.length - offset);
        module.writeArrayToMemory(bytes.subarray(headerSize + offset, headerSize + offset + blockSize), ptr);
        module.decBlob(ptr, blockSize, offset);
        out.set(module.HEAPU8.subarray(ptr, ptr + blockSize), offset);
        if ((offset & 0x7fffff) === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return out;
    } finally { module._free(ptr); }
  }
  async function phiKggKeyMapFromArchive(files) {
    if (!Array.isArray(files)) return new Map();
    const cached = phiKggKeyCache.get(files);
    if (cached) return cached;
    const promise = (async () => {
      const core = phiEnsureAudioHeaderCore(), map = new Map();
      // Small text sidecars first: hash$ekey (kgg.key / ekey*.txt / *.key).
      for (const f of files) {
        const name = basename(f.name).toLowerCase();
        if (!(name === "kgg.key" || /ekey.*\.txt$/i.test(name) || /kgg.*\.txt$/i.test(name) || /\.key$/i.test(name))) continue;
        if ((Number(f.size) || f.blob?.size || 0) > 8 * 1024 * 1024) continue;
        try {
          const parsed = core.parseKggKeyText(await f.blob.text());
          for (const [k,v] of parsed) map.set(k,v);
        } catch (error) { Diagnostics.warn("AudioCompat.kggKey", error?.message || String(error)); }
      }
      // Also accept the same KGMusicV3.db that the reference converter understands.
      const dbFile = files.find((f) => basename(f.name).toLowerCase() === "kgmusicv3.db");
      if (dbFile) {
        try {
          const raw = new Uint8Array(await dbFile.blob.arrayBuffer()),
            sqlite = await core.decryptKugouDatabase(raw),
            parsed = core.extractKggKeyMap(sqlite);
          for (const [k,v] of parsed) map.set(k,v);
        } catch (error) { Diagnostics.warn("AudioCompat.kggDb", error?.message || String(error)); }
      }
      return map;
    })();
    phiKggKeyCache.set(files, promise);
    return promise;
  }
  async function phiNormalizeAudioEntry(entry, files = []) {
    if (!entry?.blob) throw new Error("音乐文件条目无效");
    if(!window.KugouCore?.detectAudio)await loadHostedScript('./js/vendor/kgg-core.js');
    let bytes = new Uint8Array(await withTimeout(entry.blob.arrayBuffer(), 20000, "读取音乐文件超时"));
    const encryptedKind = phiEncryptedAudioKind(bytes, entry.name);
    if (encryptedKind === "kgg") {
      const core = phiEnsureAudioHeaderCore();
      if (!core?.decryptKgg) throw new Error("KGG 离线兼容核心未加载");
      const keyMap = await phiKggKeyMapFromArchive(files);
      if (!keyMap.size) throw new Error("KGG 需要同一谱面包内的 kgg.key / ekey 文本或 KGMusicV3.db");
      bytes = await core.decryptKgg(bytes, keyMap);
    } else if (encryptedKind === "kgm" || encryptedKind === "kgma" || encryptedKind === "vpr") {
      bytes = await phiDecryptKgmFamily(bytes, encryptedKind);
    }
    const detected = phiDetectAudioBytes(bytes, entry.name, entry.blob.type),
      mime = detected.mime && detected.mime !== "application/octet-stream" ? detected.mime : (entry.blob.type || phiAudioMime(detected.ext)),
      normalizedBlob = new Blob([bytes], { type: mime || "application/octet-stream" });
    let normalizedName = String(entry.name || "music");
    if (detected.ext && detected.ext !== "bin") {
      const slash = Math.max(normalizedName.lastIndexOf("/"), normalizedName.lastIndexOf("\\")),
        dot = normalizedName.lastIndexOf(".");
      normalizedName = dot > slash ? normalizedName.slice(0, dot) + "." + detected.ext : normalizedName + "." + detected.ext;
    }
    // Mutate in place so existing primaryFiles identity and archive bookkeeping stay intact.
    entry.originalAudioName ||= entry.name;
    entry.name = normalizedName;
    entry.blob = normalizedBlob;
    entry.size = normalizedBlob.size;
    entry.detectedAudio = detected;
    entry.encryptedAudioKind = encryptedKind;
    return entry;
  }
  function phiAudioObviousNonAudio(entry) {
    const name = String(entry?.name || ""), base = basename(name).toLowerCase();
    if (IMG_EXT.test(name) || SHADER_EXT.test(name)) return true;
    if (/\.(json|pec|txt|ya?ml|zip|pez|png|jpe?g|webp|bmp|gif|glsl|frag|vert|fs|vs)$/i.test(name)) return true;
    if (/^(info|extra)\./i.test(base) || /^(kgmusicv3\.db|kgg\.key)$/i.test(base)) return true;
    return false;
  }
  function phiAssetStem(value) {
    return basename(String(value || ""))
      .replace(/\.[^.]+$/, "")
      .replace(/(?:^|[_ .-])(?:ez|hd|in|at|sp|chart|谱面)(?:lv\.?\s*\d+)?(?=$|[_ .-])/gi, " ")
      .replace(/[_ .-]+/g, " ")
      .trim()
      .toLowerCase();
  }
  function phiAssetAffinity(entry, hint) {
    const a = phiAssetStem(entry?.name), b = phiAssetStem(hint);
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.includes(b) || b.includes(a)) return 60;
    const words = new Set(b.split(/\s+/).filter((word) => word.length > 1));
    let common = 0;
    for (const word of a.split(/\s+/)) if (words.has(word)) common++;
    return common * 10;
  }
  async function phiFindAudioEntry(files, meta = {}) {
    const exact = byName(files, meta.music);
    if (exact) return exact;
    const order = (a, b) =>
      phiAssetAffinity(b, meta.chartHint) - phiAssetAffinity(a, meta.chartHint) ||
      (b.size || b.blob?.size || 0) - (a.size || a.blob?.size || 0),
      hinted = files.filter((f) => AUDIO_EXT.test(f.name) && !phiAudioObviousNonAudio(f)).sort(order);
    if (hinted.length === 1) return hinted[0];
    if (hinted.length > 1) {
      const first = phiAssetAffinity(hinted[0], meta.chartHint), second = phiAssetAffinity(hinted[1], meta.chartHint);
      if (first > 0 && first > second) return hinted[0];
      throw new Error("谱面包中存在多个候选音乐文件；请在 info.yml / info.json 中为该谱面明确指定 music");
    }
    // Suffix is not trusted: inspect file headers so .bin/.dat/no-extension audio
    // is still found. Only the first 512 bytes are read during this discovery pass.
    const candidates = files.filter((f) => !phiAudioObviousNonAudio(f)).sort(order);
    for (const f of candidates) {
      try {
        const head = await phiAudioHead(f, 512), encrypted = phiEncryptedAudioKind(head, f.name), detected = phiDetectAudioBytes(head, f.name, f.blob?.type || "");
        if (encrypted || (detected.ext && detected.ext !== "bin" && detected.mime.startsWith("audio/"))) return f;
      } catch (error) { Diagnostics.warn("AudioCompat.sniff", error?.message || String(error)); }
    }
    return null;
  }
  let db = null,
    storageReady = false,
    storageMode = "persistent",
    storageFallbackReason = "",
    temporaryModeAnnounced = false;
  const sessionStore = { charts: new Map(), settings: new Map(), scores: new Map() };
  const REFERENCE_THUMBNAILS = {"LeaveAllBehind.rider":"./assets/ui/thumbs/94886c5c89d6efa3.webp","AboutTheUniverse.SOTUIMIssionary":"./assets/ui/thumbs/06c1796aa7809bc8.webp","Implexrough.Silentroommommy":"./assets/ui/thumbs/f4edd3a74ae1d30d.webp","Evanescent.LeaF":"./assets/ui/thumbs/f255104e12bed11b.webp","EntrancetotheChaos.\u6253\u6253\u3060\u3044\u305avssiromaru":"./assets/ui/thumbs/02aab3c8c252fc7a.webp","ExoplanetaryMirage.\u304b\u3081\u308a\u3042":"./assets/ui/thumbs/4260f762819da351.webp","Ametrine.GRYSCLMIssionary":"./assets/ui/thumbs/cfd39cf2fe8fbbb7.webp","Petrichor.voidMournfinale":"./assets/ui/thumbs/ee6312fa19d9b2be.webp","\u30cf\u30c6.rNFrums":"./assets/ui/thumbs/7a0339b1103a86e3.webp","DesultorySignals.technoplanet":"./assets/ui/thumbs/fcd9f33850fec81b.webp","Message.\u304f\u308b\u3076\u3063\u3053\u3061\u3083\u3093":"./assets/ui/thumbs/bae363d1a144ac79.webp","WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft\u5b89\u6708\u540d\u8389\u5b50\u5927\u702c\u826f\u3042\u3044":"./assets/ui/thumbs/237d8960ef52ac9b.webp","WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft\u5b89\u6708\u540d\u8389\u5b50\u5927\u702c\u826f\u3042\u3044-EZ":"./assets/ui/thumbs/dcb3611093fc3033.webp","WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft\u5b89\u6708\u540d\u8389\u5b50\u5927\u702c\u826f\u3042\u3044-HD":"./assets/ui/thumbs/e94c2100ba47cc6f.webp","WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft\u5b89\u6708\u540d\u8389\u5b50\u5927\u702c\u826f\u3042\u3044-IN":"./assets/ui/thumbs/237d8960ef52ac9b.webp","WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft\u5b89\u6708\u540d\u8389\u5b50\u5927\u702c\u826f\u3042\u3044-AT":"./assets/ui/thumbs/7c2c0574804413f4.webp"};
  const BUILTIN_PACKS = [{"id":"leave-all-behind-ez","name":"Leave All Behind","sourceName":"Leave All Behind EZ","parser":"pgr","audioHash":"reference-song:LeaveAllBehind.rider","meta":{"name":"Leave All Behind","composer":"rider","illustrator":"笔记RE","charter":"亚树见希子 & 百九十八","difficultyClass":"EZ","difficulty":3,"level":"EZ Lv.3","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"单曲精选集"},"thumbnailKey":"LeaveAllBehind.rider","notes":210,"lines":1,"scoreIdentity":"builtin-reference:leave-all-behind-ez","files":[{"name":"chart.json","asset":"ch9_0_ez"},{"name":"music.ogg","asset":"ch9_0_music"},{"name":"illustration.png","asset":"ch9_0_art"},{"name":"info.yml","asset":"ch9_0_ez_info"}]},{"id":"leave-all-behind-hd","name":"Leave All Behind","sourceName":"Leave All Behind HD","parser":"pgr","audioHash":"reference-song:LeaveAllBehind.rider","meta":{"name":"Leave All Behind","composer":"rider","illustrator":"笔记RE","charter":"亚树见希子 & 百九十八","difficultyClass":"HD","difficulty":8.9,"level":"HD Lv.8","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"单曲精选集"},"thumbnailKey":"LeaveAllBehind.rider","notes":394,"lines":4,"scoreIdentity":"builtin-reference:leave-all-behind-hd","files":[{"name":"chart.json","asset":"ch9_0_hd"},{"name":"music.ogg","asset":"ch9_0_music"},{"name":"illustration.png","asset":"ch9_0_art"},{"name":"info.yml","asset":"ch9_0_hd_info"}]},{"id":"leave-all-behind-in","name":"Leave All Behind","sourceName":"Leave All Behind IN","parser":"pgr","audioHash":"reference-song:LeaveAllBehind.rider","meta":{"name":"Leave All Behind","composer":"rider","illustrator":"笔记RE","charter":"亚树见希子 & 百九十八","difficultyClass":"IN","difficulty":12.7,"level":"IN Lv.12","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"单曲精选集"},"thumbnailKey":"LeaveAllBehind.rider","notes":523,"lines":8,"scoreIdentity":"builtin-reference:leave-all-behind-in","files":[{"name":"chart.json","asset":"ch9_0_in"},{"name":"music.ogg","asset":"ch9_0_music"},{"name":"illustration.png","asset":"ch9_0_art"},{"name":"info.yml","asset":"ch9_0_in_info"}]},{"id":"leave-all-behind-at","name":"Leave All Behind","sourceName":"Leave All Behind AT","parser":"pgr","audioHash":"reference-song:LeaveAllBehind.rider","meta":{"name":"Leave All Behind","composer":"rider","illustrator":"笔记RE","charter":"WinterPT & Rikko","difficultyClass":"AT","difficulty":15,"level":"AT Lv.15","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"单曲精选集"},"thumbnailKey":"LeaveAllBehind.rider","notes":808,"lines":24,"scoreIdentity":"builtin-reference:leave-all-behind-at","files":[{"name":"chart.json","asset":"ch9_0_at"},{"name":"music.ogg","asset":"ch9_0_music"},{"name":"illustration.png","asset":"ch9_0_art"},{"name":"info.yml","asset":"ch9_0_at_info"}]},{"id":"chapter9-AboutTheUniverse.SOTUIMIssionary-ez","name":"About The Universe","sourceName":"About The Universe EZ","parser":"pgr","audioHash":"reference-song:AboutTheUniverse.SOTUIMIssionary","meta":{"name":"About The Universe","composer":"SOTUI & MIssionary","illustrator":"MC大神knife美工刀","charter":"普朗克波长","difficultyClass":"EZ","difficulty":4.5,"level":"EZ Lv.4","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"AboutTheUniverse.SOTUIMIssionary","notes":261,"lines":8,"scoreIdentity":"builtin-reference:chapter9-AboutTheUniverse.SOTUIMIssionary-ez","files":[{"name":"chart.json","asset":"ch9_1_ez"},{"name":"music.ogg","asset":"ch9_1_music"},{"name":"illustration.png","asset":"ch9_1_art"},{"name":"info.yml","asset":"ch9_1_ez_info"}]},{"id":"chapter9-AboutTheUniverse.SOTUIMIssionary-hd","name":"About The Universe","sourceName":"About The Universe HD","parser":"pgr","audioHash":"reference-song:AboutTheUniverse.SOTUIMIssionary","meta":{"name":"About The Universe","composer":"SOTUI & MIssionary","illustrator":"MC大神knife美工刀","charter":"普朗克波长","difficultyClass":"HD","difficulty":9.7,"level":"HD Lv.9","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"AboutTheUniverse.SOTUIMIssionary","notes":434,"lines":11,"scoreIdentity":"builtin-reference:chapter9-AboutTheUniverse.SOTUIMIssionary-hd","files":[{"name":"chart.json","asset":"ch9_1_hd"},{"name":"music.ogg","asset":"ch9_1_music"},{"name":"illustration.png","asset":"ch9_1_art"},{"name":"info.yml","asset":"ch9_1_hd_info"}]},{"id":"chapter9-AboutTheUniverse.SOTUIMIssionary-in","name":"About The Universe","sourceName":"About The Universe IN","parser":"pgr","audioHash":"reference-song:AboutTheUniverse.SOTUIMIssionary","meta":{"name":"About The Universe","composer":"SOTUI & MIssionary","illustrator":"MC大神knife美工刀","charter":"波硫二象性","difficultyClass":"IN","difficulty":14.4,"level":"IN Lv.14","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"AboutTheUniverse.SOTUIMIssionary","notes":595,"lines":24,"scoreIdentity":"builtin-reference:chapter9-AboutTheUniverse.SOTUIMIssionary-in","files":[{"name":"chart.json","asset":"ch9_1_in"},{"name":"music.ogg","asset":"ch9_1_music"},{"name":"illustration.png","asset":"ch9_1_art"},{"name":"info.yml","asset":"ch9_1_in_info"}]},{"id":"chapter9-Implexrough.Silentroommommy-ez","name":"Implexrough","sourceName":"Implexrough EZ","parser":"pgr","audioHash":"reference-song:Implexrough.Silentroommommy","meta":{"name":"Implexrough","composer":"Silentroom × mommy","illustrator":"Nate","charter":"Fractwist  - Helabot","difficultyClass":"EZ","difficulty":5.5,"level":"EZ Lv.5","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Implexrough.Silentroommommy","notes":226,"lines":16,"scoreIdentity":"builtin-reference:chapter9-Implexrough.Silentroommommy-ez","files":[{"name":"chart.json","asset":"ch9_2_ez"},{"name":"music.ogg","asset":"ch9_2_music"},{"name":"illustration.png","asset":"ch9_2_art"},{"name":"info.yml","asset":"ch9_2_ez_info"}]},{"id":"chapter9-Implexrough.Silentroommommy-hd","name":"Implexrough","sourceName":"Implexrough HD","parser":"pgr","audioHash":"reference-song:Implexrough.Silentroommommy","meta":{"name":"Implexrough","composer":"Silentroom × mommy","illustrator":"Nate","charter":"Fractwist  - Helabot","difficultyClass":"HD","difficulty":10.2,"level":"HD Lv.10","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Implexrough.Silentroommommy","notes":517,"lines":20,"scoreIdentity":"builtin-reference:chapter9-Implexrough.Silentroommommy-hd","files":[{"name":"chart.json","asset":"ch9_2_hd"},{"name":"music.ogg","asset":"ch9_2_music"},{"name":"illustration.png","asset":"ch9_2_art"},{"name":"info.yml","asset":"ch9_2_hd_info"}]},{"id":"chapter9-Implexrough.Silentroommommy-in","name":"Implexrough","sourceName":"Implexrough IN","parser":"pgr","audioHash":"reference-song:Implexrough.Silentroommommy","meta":{"name":"Implexrough","composer":"Silentroom × mommy","illustrator":"Nate","charter":"Turbulax - Simon_Axis & Stray_Cat","difficultyClass":"IN","difficulty":15.3,"level":"IN Lv.15","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Implexrough.Silentroommommy","notes":1006,"lines":24,"scoreIdentity":"builtin-reference:chapter9-Implexrough.Silentroommommy-in","files":[{"name":"chart.json","asset":"ch9_2_in"},{"name":"music.ogg","asset":"ch9_2_music"},{"name":"illustration.png","asset":"ch9_2_art"},{"name":"info.yml","asset":"ch9_2_in_info"}]},{"id":"chapter9-Evanescent.LeaF-ez","name":"Evanescent","sourceName":"Evanescent EZ","parser":"pgr","audioHash":"reference-song:Evanescent.LeaF","meta":{"name":"Evanescent","composer":"LeaF","illustrator":"海产 feat. 佑木いずみ","charter":"Salt -a remaining dream-","difficultyClass":"EZ","difficulty":6.5,"level":"EZ Lv.6","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Evanescent.LeaF","notes":358,"lines":24,"scoreIdentity":"builtin-reference:chapter9-Evanescent.LeaF-ez","files":[{"name":"chart.json","asset":"ch9_3_ez"},{"name":"music.ogg","asset":"ch9_3_music"},{"name":"illustration.png","asset":"ch9_3_art"},{"name":"info.yml","asset":"ch9_3_ez_info"}]},{"id":"chapter9-Evanescent.LeaF-hd","name":"Evanescent","sourceName":"Evanescent HD","parser":"pgr","audioHash":"reference-song:Evanescent.LeaF","meta":{"name":"Evanescent","composer":"LeaF","illustrator":"海产 feat. 佑木いずみ","charter":"Salt -a fading boundary-","difficultyClass":"HD","difficulty":12.6,"level":"HD Lv.12","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Evanescent.LeaF","notes":720,"lines":24,"scoreIdentity":"builtin-reference:chapter9-Evanescent.LeaF-hd","files":[{"name":"chart.json","asset":"ch9_3_hd"},{"name":"music.ogg","asset":"ch9_3_music"},{"name":"illustration.png","asset":"ch9_3_art"},{"name":"info.yml","asset":"ch9_3_hd_info"}]},{"id":"chapter9-Evanescent.LeaF-in","name":"Evanescent","sourceName":"Evanescent IN","parser":"pgr","audioHash":"reference-song:Evanescent.LeaF","meta":{"name":"Evanescent","composer":"LeaF","illustrator":"海产 feat. 佑木いずみ","charter":"Salt feat. Ner -an evanescent reality-","difficultyClass":"IN","difficulty":15.7,"level":"IN Lv.15","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Evanescent.LeaF","notes":933,"lines":24,"scoreIdentity":"builtin-reference:chapter9-Evanescent.LeaF-in","files":[{"name":"chart.json","asset":"ch9_3_in"},{"name":"music.ogg","asset":"ch9_3_music"},{"name":"illustration.png","asset":"ch9_3_art"},{"name":"info.yml","asset":"ch9_3_in_info"}]},{"id":"chapter9-EntrancetotheChaos.打打だいずvssiromaru-ez","name":"Entrance to the Chaos","sourceName":"Entrance to the Chaos EZ","parser":"pgr","audioHash":"reference-song:EntrancetotheChaos.打打だいずvssiromaru","meta":{"name":"Entrance to the Chaos","composer":"打打だいず vs. siromaru","illustrator":"群青kurara","charter":"Approaching the Gates","difficultyClass":"EZ","difficulty":8.8,"level":"EZ Lv.8","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"EntrancetotheChaos.打打だいずvssiromaru","notes":495,"lines":24,"scoreIdentity":"builtin-reference:chapter9-EntrancetotheChaos.打打だいずvssiromaru-ez","files":[{"name":"chart.json","asset":"ch9_4_ez"},{"name":"music.ogg","asset":"ch9_4_music"},{"name":"illustration.png","asset":"ch9_4_art"},{"name":"info.yml","asset":"ch9_4_ez_info"}]},{"id":"chapter9-EntrancetotheChaos.打打だいずvssiromaru-hd","name":"Entrance to the Chaos","sourceName":"Entrance to the Chaos HD","parser":"pgr","audioHash":"reference-song:EntrancetotheChaos.打打だいずvssiromaru","meta":{"name":"Entrance to the Chaos","composer":"打打だいず vs. siromaru","illustrator":"群青kurara","charter":"Crossing the Threshold","difficultyClass":"HD","difficulty":13.7,"level":"HD Lv.13","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"EntrancetotheChaos.打打だいずvssiromaru","notes":800,"lines":24,"scoreIdentity":"builtin-reference:chapter9-EntrancetotheChaos.打打だいずvssiromaru-hd","files":[{"name":"chart.json","asset":"ch9_4_hd"},{"name":"music.ogg","asset":"ch9_4_music"},{"name":"illustration.png","asset":"ch9_4_art"},{"name":"info.yml","asset":"ch9_4_hd_info"}]},{"id":"chapter9-EntrancetotheChaos.打打だいずvssiromaru-in","name":"Entrance to the Chaos","sourceName":"Entrance to the Chaos IN","parser":"pgr","audioHash":"reference-song:EntrancetotheChaos.打打だいずvssiromaru","meta":{"name":"Entrance to the Chaos","composer":"打打だいず vs. siromaru","illustrator":"群青kurara","charter":"Descending the Abyss","difficultyClass":"IN","difficulty":16.8,"level":"IN Lv.16","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"EntrancetotheChaos.打打だいずvssiromaru","notes":1334,"lines":24,"scoreIdentity":"builtin-reference:chapter9-EntrancetotheChaos.打打だいずvssiromaru-in","files":[{"name":"chart.json","asset":"ch9_4_in"},{"name":"music.ogg","asset":"ch9_4_music"},{"name":"illustration.png","asset":"ch9_4_art"},{"name":"info.yml","asset":"ch9_4_in_info"}]},{"id":"chapter9-EntrancetotheChaos.打打だいずvssiromaru-at","name":"Entrance to the Chaos","sourceName":"Entrance to the Chaos AT","parser":"pgr","audioHash":"reference-song:EntrancetotheChaos.打打だいずvssiromaru","meta":{"name":"Entrance to the Chaos","composer":"打打だいず vs. siromaru","illustrator":"群青kurara","charter":"Embracing the Madness","difficultyClass":"AT","difficulty":17.6,"level":"AT Lv.17","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"EntrancetotheChaos.打打だいずvssiromaru","notes":1249,"lines":40,"scoreIdentity":"builtin-reference:chapter9-EntrancetotheChaos.打打だいずvssiromaru-at","files":[{"name":"chart.json","asset":"ch9_4_at"},{"name":"music.ogg","asset":"ch9_4_music"},{"name":"illustration.png","asset":"ch9_4_art"},{"name":"info.yml","asset":"ch9_4_at_info"}]},{"id":"chapter9-ExoplanetaryMirage.かめりあ-ez","name":"Exoplanetary Mirage","sourceName":"Exoplanetary Mirage EZ","parser":"pgr","audioHash":"reference-song:ExoplanetaryMirage.かめりあ","meta":{"name":"Exoplanetary Mirage","composer":"Camellia","illustrator":"神居冰绘 feat. 祈莲","charter":"Orbital Velocity: 7.900 km/s","difficultyClass":"EZ","difficulty":8.7,"level":"EZ Lv.8","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"ExoplanetaryMirage.かめりあ","notes":670,"lines":24,"scoreIdentity":"builtin-reference:chapter9-ExoplanetaryMirage.かめりあ-ez","files":[{"name":"chart.json","asset":"ch9_5_ez"},{"name":"music.ogg","asset":"ch9_5_music"},{"name":"illustration.png","asset":"ch9_5_art"},{"name":"info.yml","asset":"ch9_5_ez_info"}]},{"id":"chapter9-ExoplanetaryMirage.かめりあ-hd","name":"Exoplanetary Mirage","sourceName":"Exoplanetary Mirage HD","parser":"pgr","audioHash":"reference-song:ExoplanetaryMirage.かめりあ","meta":{"name":"Exoplanetary Mirage","composer":"Camellia","illustrator":"神居冰绘 feat. 祈莲","charter":"Orbital Velocity: 11.200 km/s","difficultyClass":"HD","difficulty":13.4,"level":"HD Lv.13","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"ExoplanetaryMirage.かめりあ","notes":941,"lines":23,"scoreIdentity":"builtin-reference:chapter9-ExoplanetaryMirage.かめりあ-hd","files":[{"name":"chart.json","asset":"ch9_5_hd"},{"name":"music.ogg","asset":"ch9_5_music"},{"name":"illustration.png","asset":"ch9_5_art"},{"name":"info.yml","asset":"ch9_5_hd_info"}]},{"id":"chapter9-ExoplanetaryMirage.かめりあ-in","name":"Exoplanetary Mirage","sourceName":"Exoplanetary Mirage IN","parser":"pgr","audioHash":"reference-song:ExoplanetaryMirage.かめりあ","meta":{"name":"Exoplanetary Mirage","composer":"Camellia","illustrator":"神居冰绘 feat. 祈莲","charter":"Orbital Velocity: 16.700 km/s","difficultyClass":"IN","difficulty":16.8,"level":"IN Lv.16","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"ExoplanetaryMirage.かめりあ","notes":2055,"lines":24,"scoreIdentity":"builtin-reference:chapter9-ExoplanetaryMirage.かめりあ-in","files":[{"name":"chart.json","asset":"ch9_5_in"},{"name":"music.ogg","asset":"ch9_5_music"},{"name":"illustration.png","asset":"ch9_5_art"},{"name":"info.yml","asset":"ch9_5_in_info"}]},{"id":"chapter9-ExoplanetaryMirage.かめりあ-at","name":"Exoplanetary Mirage","sourceName":"Exoplanetary Mirage AT","parser":"pgr","audioHash":"reference-song:ExoplanetaryMirage.かめりあ","meta":{"name":"Exoplanetary Mirage","composer":"Camellia","illustrator":"神居冰绘 feat. 祈莲","charter":"Orbital Velocity:  ■■■ km/s","difficultyClass":"AT","difficulty":17.9,"level":"AT Lv.17","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"ExoplanetaryMirage.かめりあ","notes":2077,"lines":47,"scoreIdentity":"builtin-reference:chapter9-ExoplanetaryMirage.かめりあ-at","files":[{"name":"chart.json","asset":"ch9_5_at"},{"name":"music.ogg","asset":"ch9_5_music"},{"name":"illustration.png","asset":"ch9_5_art"},{"name":"info.yml","asset":"ch9_5_at_info"}]},{"id":"chapter9-Ametrine.GRYSCLMIssionary-ez","name":"Ametrine","sourceName":"Ametrine EZ","parser":"pgr","audioHash":"reference-song:Ametrine.GRYSCLMIssionary","meta":{"name":"Ametrine","composer":"GRYSCL & MIssionary","illustrator":"子狼","charter":"Enstatite","difficultyClass":"EZ","difficulty":6,"level":"EZ Lv.6","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Ametrine.GRYSCLMIssionary","notes":302,"lines":12,"scoreIdentity":"builtin-reference:chapter9-Ametrine.GRYSCLMIssionary-ez","files":[{"name":"chart.json","asset":"ch9_7_ez"},{"name":"music.ogg","asset":"ch9_7_music"},{"name":"illustration.png","asset":"ch9_7_art"},{"name":"info.yml","asset":"ch9_7_ez_info"}]},{"id":"chapter9-Ametrine.GRYSCLMIssionary-hd","name":"Ametrine","sourceName":"Ametrine HD","parser":"pgr","audioHash":"reference-song:Ametrine.GRYSCLMIssionary","meta":{"name":"Ametrine","composer":"GRYSCL & MIssionary","illustrator":"子狼","charter":"Heliodor","difficultyClass":"HD","difficulty":12.2,"level":"HD Lv.12","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Ametrine.GRYSCLMIssionary","notes":838,"lines":10,"scoreIdentity":"builtin-reference:chapter9-Ametrine.GRYSCLMIssionary-hd","files":[{"name":"chart.json","asset":"ch9_7_hd"},{"name":"music.ogg","asset":"ch9_7_music"},{"name":"illustration.png","asset":"ch9_7_art"},{"name":"info.yml","asset":"ch9_7_hd_info"}]},{"id":"chapter9-Ametrine.GRYSCLMIssionary-in","name":"Ametrine","sourceName":"Ametrine IN","parser":"pgr","audioHash":"reference-song:Ametrine.GRYSCLMIssionary","meta":{"name":"Ametrine","composer":"GRYSCL & MIssionary","illustrator":"子狼","charter":"Indigolite","difficultyClass":"IN","difficulty":15,"level":"IN Lv.15","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Ametrine.GRYSCLMIssionary","notes":769,"lines":24,"scoreIdentity":"builtin-reference:chapter9-Ametrine.GRYSCLMIssionary-in","files":[{"name":"chart.json","asset":"ch9_7_in"},{"name":"music.ogg","asset":"ch9_7_music"},{"name":"illustration.png","asset":"ch9_7_art"},{"name":"info.yml","asset":"ch9_7_in_info"}]},{"id":"chapter9-Ametrine.GRYSCLMIssionary-at","name":"Ametrine","sourceName":"Ametrine AT","parser":"pgr","audioHash":"reference-song:Ametrine.GRYSCLMIssionary","meta":{"name":"Ametrine","composer":"GRYSCL & MIssionary","illustrator":"子狼","charter":"Ametrine","difficultyClass":"AT","difficulty":16.2,"level":"AT Lv.16","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Ametrine.GRYSCLMIssionary","notes":784,"lines":24,"scoreIdentity":"builtin-reference:chapter9-Ametrine.GRYSCLMIssionary-at","files":[{"name":"chart.json","asset":"ch9_7_at"},{"name":"music.ogg","asset":"ch9_7_music"},{"name":"illustration.png","asset":"ch9_7_art"},{"name":"info.yml","asset":"ch9_7_at_info"}]},{"id":"chapter9-Petrichor.voidMournfinale-ez","name":"Petrichor","sourceName":"Petrichor EZ","parser":"pgr","audioHash":"reference-song:Petrichor.voidMournfinale","meta":{"name":"Petrichor","composer":"void (Mournfinale)","illustrator":"青鸟 feat. 祈莲","charter":"Seed | Promise","difficultyClass":"EZ","difficulty":7.5,"level":"EZ Lv.7","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Petrichor.voidMournfinale","notes":420,"lines":11,"scoreIdentity":"builtin-reference:chapter9-Petrichor.voidMournfinale-ez","files":[{"name":"chart.json","asset":"ch9_8_ez"},{"name":"music.ogg","asset":"ch9_8_music"},{"name":"illustration.png","asset":"ch9_8_art"},{"name":"info.yml","asset":"ch9_8_ez_info"}]},{"id":"chapter9-Petrichor.voidMournfinale-hd","name":"Petrichor","sourceName":"Petrichor HD","parser":"pgr","audioHash":"reference-song:Petrichor.voidMournfinale","meta":{"name":"Petrichor","composer":"void (Mournfinale)","illustrator":"青鸟 feat. 祈莲","charter":"Rain | Rewrites","difficultyClass":"HD","difficulty":13.8,"level":"HD Lv.13","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Petrichor.voidMournfinale","notes":779,"lines":24,"scoreIdentity":"builtin-reference:chapter9-Petrichor.voidMournfinale-hd","files":[{"name":"chart.json","asset":"ch9_8_hd"},{"name":"music.ogg","asset":"ch9_8_music"},{"name":"illustration.png","asset":"ch9_8_art"},{"name":"info.yml","asset":"ch9_8_hd_info"}]},{"id":"chapter9-Petrichor.voidMournfinale-in","name":"Petrichor","sourceName":"Petrichor IN","parser":"pgr","audioHash":"reference-song:Petrichor.voidMournfinale","meta":{"name":"Petrichor","composer":"void (Mournfinale)","illustrator":"青鸟 feat. 祈莲","charter":"Silence | Us","difficultyClass":"IN","difficulty":16.5,"level":"IN Lv.16","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Petrichor.voidMournfinale","notes":1242,"lines":22,"scoreIdentity":"builtin-reference:chapter9-Petrichor.voidMournfinale-in","files":[{"name":"chart.json","asset":"ch9_8_in"},{"name":"music.ogg","asset":"ch9_8_music"},{"name":"illustration.png","asset":"ch9_8_art"},{"name":"info.yml","asset":"ch9_8_in_info"}]},{"id":"chapter9-Petrichor.voidMournfinale-at","name":"Petrichor","sourceName":"Petrichor AT","parser":"pgr","audioHash":"reference-song:Petrichor.voidMournfinale","meta":{"name":"Petrichor","composer":"void (Mournfinale)","illustrator":"青鸟 feat. 祈莲","charter":"Return | Petrichor","difficultyClass":"AT","difficulty":17.5,"level":"AT Lv.17","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Petrichor.voidMournfinale","notes":1436,"lines":24,"scoreIdentity":"builtin-reference:chapter9-Petrichor.voidMournfinale-at","files":[{"name":"chart.json","asset":"ch9_8_at"},{"name":"music.ogg","asset":"ch9_8_music"},{"name":"illustration.png","asset":"ch9_8_art"},{"name":"info.yml","asset":"ch9_8_at_info"}]},{"id":"chapter9-ハテ.rNFrums-ez","name":"ハテ","sourceName":"ハテ EZ","parser":"pgr","audioHash":"reference-song:ハテ.rNFrums","meta":{"name":"ハテ","composer":"rN || Frums","illustrator":"宙風みけ || rN","charter":"the end of hope.","difficultyClass":"EZ","difficulty":9,"level":"EZ Lv.9","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"ハテ.rNFrums","notes":1049,"lines":12,"scoreIdentity":"builtin-reference:chapter9-ハテ.rNFrums-ez","files":[{"name":"chart.json","asset":"ch9_9_ez"},{"name":"music.ogg","asset":"ch9_9_music"},{"name":"illustration.png","asset":"ch9_9_art"},{"name":"info.yml","asset":"ch9_9_ez_info"}]},{"id":"chapter9-ハテ.rNFrums-hd","name":"ハテ","sourceName":"ハテ HD","parser":"pgr","audioHash":"reference-song:ハテ.rNFrums","meta":{"name":"ハテ","composer":"rN || Frums","illustrator":"宙風みけ || rN","charter":"the end of ache.","difficultyClass":"HD","difficulty":13.9,"level":"HD Lv.13","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"ハテ.rNFrums","notes":1000,"lines":8,"scoreIdentity":"builtin-reference:chapter9-ハテ.rNFrums-hd","files":[{"name":"chart.json","asset":"ch9_9_hd"},{"name":"music.ogg","asset":"ch9_9_music"},{"name":"illustration.png","asset":"ch9_9_art"},{"name":"info.yml","asset":"ch9_9_hd_info"}]},{"id":"chapter9-ハテ.rNFrums-in","name":"ハテ","sourceName":"ハテ IN","parser":"pgr","audioHash":"reference-song:ハテ.rNFrums","meta":{"name":"ハテ","composer":"rN || Frums","illustrator":"宙風みけ || rN","charter":"the end of this.","difficultyClass":"IN","difficulty":16.7,"level":"IN Lv.16","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"ハテ.rNFrums","notes":1014,"lines":24,"scoreIdentity":"builtin-reference:chapter9-ハテ.rNFrums-in","files":[{"name":"chart.json","asset":"ch9_9_in"},{"name":"music.ogg","asset":"ch9_9_music"},{"name":"illustration.png","asset":"ch9_9_art"},{"name":"info.yml","asset":"ch9_9_in_info"}]},{"id":"chapter9-ハテ.rNFrums-at","name":"ハテ","sourceName":"ハテ AT","parser":"pgr","audioHash":"reference-song:ハテ.rNFrums","meta":{"name":"ハテ","composer":"rN || Frums","illustrator":"宙風みけ || rN","charter":"the end of ever.","difficultyClass":"AT","difficulty":17.9,"level":"AT Lv.17","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"ハテ.rNFrums","notes":1397,"lines":66,"scoreIdentity":"builtin-reference:chapter9-ハテ.rNFrums-at","files":[{"name":"chart.json","asset":"ch9_9_at"},{"name":"music.ogg","asset":"ch9_9_music"},{"name":"illustration.png","asset":"ch9_9_art"},{"name":"info.yml","asset":"ch9_9_at_info"}]},{"id":"chapter9-DesultorySignals.technoplanet-ez","name":"Desultory Signals","sourceName":"Desultory Signals EZ","parser":"pgr","audioHash":"reference-song:DesultorySignals.technoplanet","meta":{"name":"Desultory Signals","composer":"technoplanet","illustrator":"月光大刺剑","charter":"Hesitating Trepidation \"踌躇的惶恐\"","difficultyClass":"EZ","difficulty":10,"level":"EZ Lv.10","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"DesultorySignals.technoplanet","notes":831,"lines":22,"scoreIdentity":"builtin-reference:chapter9-DesultorySignals.technoplanet-ez","files":[{"name":"chart.json","asset":"ch9_10_ez"},{"name":"music.ogg","asset":"ch9_10_music"},{"name":"illustration.png","asset":"ch9_10_art"},{"name":"info.yml","asset":"ch9_10_ez_info"}]},{"id":"chapter9-DesultorySignals.technoplanet-hd","name":"Desultory Signals","sourceName":"Desultory Signals HD","parser":"pgr","audioHash":"reference-song:DesultorySignals.technoplanet","meta":{"name":"Desultory Signals","composer":"technoplanet","illustrator":"月光大刺剑","charter":"Denying Pseudomorph \"否认的伪形\"","difficultyClass":"HD","difficulty":14,"level":"HD Lv.14","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"DesultorySignals.technoplanet","notes":1002,"lines":20,"scoreIdentity":"builtin-reference:chapter9-DesultorySignals.technoplanet-hd","files":[{"name":"chart.json","asset":"ch9_10_hd"},{"name":"music.ogg","asset":"ch9_10_music"},{"name":"illustration.png","asset":"ch9_10_art"},{"name":"info.yml","asset":"ch9_10_hd_info"}]},{"id":"chapter9-DesultorySignals.technoplanet-in","name":"Desultory Signals","sourceName":"Desultory Signals IN","parser":"pgr","audioHash":"reference-song:DesultorySignals.technoplanet","meta":{"name":"Desultory Signals","composer":"technoplanet","illustrator":"月光大刺剑","charter":"Retaliating Resolve \"反击的决意\"","difficultyClass":"IN","difficulty":17,"level":"IN Lv.17","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"DesultorySignals.technoplanet","notes":2019,"lines":44,"scoreIdentity":"builtin-reference:chapter9-DesultorySignals.technoplanet-in","files":[{"name":"chart.json","asset":"ch9_10_in"},{"name":"music.ogg","asset":"ch9_10_music"},{"name":"illustration.png","asset":"ch9_10_art"},{"name":"info.yml","asset":"ch9_10_in_info"}]},{"id":"chapter9-DesultorySignals.technoplanet-at","name":"Desultory Signals","sourceName":"Desultory Signals AT","parser":"pgr","audioHash":"reference-song:DesultorySignals.technoplanet","meta":{"name":"Desultory Signals","composer":"technoplanet","illustrator":"月光大刺剑","charter":"Ceaseless Signal \"不息的信号\"","difficultyClass":"AT","difficulty":18,"level":"AT Lv.18","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"DesultorySignals.technoplanet","notes":2026,"lines":24,"scoreIdentity":"builtin-reference:chapter9-DesultorySignals.technoplanet-at","files":[{"name":"chart.json","asset":"ch9_10_at"},{"name":"music.ogg","asset":"ch9_10_music"},{"name":"illustration.png","asset":"ch9_10_art"},{"name":"info.yml","asset":"ch9_10_at_info"}]},{"id":"chapter9-Message.くるぶっこちゃん-ez","name":"Message","sourceName":"Message EZ","parser":"pgr","audioHash":"reference-song:Message.くるぶっこちゃん","meta":{"name":"Message","composer":"くるぶっこちゃん","illustrator":"神居冰绘 feat. 祈莲","charter":"■■■p■l■a","difficultyClass":"EZ","difficulty":3,"level":"EZ Lv.3","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Message.くるぶっこちゃん","notes":100,"lines":16,"scoreIdentity":"builtin-reference:chapter9-Message.くるぶっこちゃん-ez","files":[{"name":"chart.json","asset":"ch9_11_ez"},{"name":"music.ogg","asset":"ch9_11_music"},{"name":"illustration.png","asset":"ch9_11_art"},{"name":"info.yml","asset":"ch9_11_ez_info"}]},{"id":"chapter9-Message.くるぶっこちゃん-hd","name":"Message","sourceName":"Message HD","parser":"pgr","audioHash":"reference-song:Message.くるぶっこちゃん","meta":{"name":"Message","composer":"くるぶっこちゃん","illustrator":"神居冰绘 feat. 祈莲","charter":"■■o■elia's l","difficultyClass":"HD","difficulty":13.2,"level":"HD Lv.13","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Message.くるぶっこちゃん","notes":544,"lines":22,"scoreIdentity":"builtin-reference:chapter9-Message.くるぶっこちゃん-hd","files":[{"name":"chart.json","asset":"ch9_11_hd"},{"name":"music.ogg","asset":"ch9_11_music"},{"name":"illustration.png","asset":"ch9_11_art"},{"name":"info.yml","asset":"ch9_11_hd_info"}]},{"id":"chapter9-Message.くるぶっこちゃん-in","name":"Message","sourceName":"Message IN","parser":"pgr","audioHash":"reference-song:Message.くるぶっこちゃん","meta":{"name":"Message","composer":"くるぶっこちゃん","illustrator":"神居冰绘 feat. 祈莲","charter":"Geo■elia's lov","difficultyClass":"IN","difficulty":15.6,"level":"IN Lv.15","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Message.くるぶっこちゃん","notes":886,"lines":24,"scoreIdentity":"builtin-reference:chapter9-Message.くるぶっこちゃん-in","files":[{"name":"chart.json","asset":"ch9_11_in"},{"name":"music.ogg","asset":"ch9_11_music"},{"name":"illustration.png","asset":"ch9_11_art"},{"name":"info.yml","asset":"ch9_11_in_info"}]},{"id":"chapter9-Message.くるぶっこちゃん-at","name":"Message","sourceName":"Message AT","parser":"pgr","audioHash":"reference-song:Message.くるぶっこちゃん","meta":{"name":"Message","composer":"くるぶっこちゃん","illustrator":"神居冰绘 feat. 祈莲","charter":"Geopelia's love 2u","difficultyClass":"AT","difficulty":16.5,"level":"AT Lv.16","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Message.くるぶっこちゃん","notes":777,"lines":24,"scoreIdentity":"builtin-reference:chapter9-Message.くるぶっこちゃん-at","files":[{"name":"chart.json","asset":"ch9_11_at"},{"name":"music.ogg","asset":"ch9_11_music"},{"name":"illustration.png","asset":"ch9_11_art"},{"name":"info.yml","asset":"ch9_11_at_info"}]},{"id":"chapter9-Message.くるぶっこちゃん-sp","name":"Message","sourceName":"Message SP","parser":"pgr","audioHash":"reference-song:Message.くるぶっこちゃん","meta":{"name":"Message","composer":"くるぶっこちゃん","illustrator":"神居冰绘 feat. 祈莲","charter":"","difficultyClass":"SP","difficulty":0,"level":"SP","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"Message.くるぶっこちゃん","notes":600,"lines":24,"scoreIdentity":"builtin-reference:chapter9-Message.くるぶっこちゃん-sp","files":[{"name":"chart.json","asset":"ch9_11_sp"},{"name":"music.ogg","asset":"ch9_11_music"},{"name":"illustration.png","asset":"ch9_11_art"},{"name":"info.yml","asset":"ch9_11_sp_info"}]},{"id":"chapter9-WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-ez","name":"What do you want more than a Happy ending?","sourceName":"What do you want more than a Happy ending? EZ","parser":"pgr","audioHash":"reference-song:WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい","meta":{"name":"What do you want more than a Happy ending?","composer":"Apo11o\"HALO\"program ft. 安月名 莉子×大瀬良あい","illustrator":"Amor fati","charter":"欢迎回到 Phigros！","difficultyClass":"EZ","difficulty":0.5,"level":"EZ Lv.0","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-EZ","notes":4,"lines":20,"scoreIdentity":"builtin-reference:chapter9-WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-ez","files":[{"name":"chart.json","asset":"ch9_12_ez"},{"name":"music.ogg","asset":"ch9_12_music"},{"name":"illustration.png","asset":"ch9_12_artEZ"},{"name":"info.yml","asset":"ch9_12_ez_info"}]},{"id":"chapter9-WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-hd","name":"What do you want more than a Happy ending?","sourceName":"What do you want more than a Happy ending? HD","parser":"pgr","audioHash":"reference-song:WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい","meta":{"name":"What do you want more than a Happy ending?","composer":"Apo11o\"HALO\"program ft. 安月名 莉子×大瀬良あい","illustrator":"Amor fati","charter":"欢迎回到 Phigros！","difficultyClass":"HD","difficulty":11.5,"level":"HD Lv.11","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-HD","notes":818,"lines":18,"scoreIdentity":"builtin-reference:chapter9-WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-hd","files":[{"name":"chart.json","asset":"ch9_12_hd"},{"name":"music.ogg","asset":"ch9_12_music"},{"name":"illustration.png","asset":"ch9_12_artHD"},{"name":"info.yml","asset":"ch9_12_hd_info"}]},{"id":"chapter9-WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-in","name":"What do you want more than a Happy ending?","sourceName":"What do you want more than a Happy ending? IN","parser":"pgr","audioHash":"reference-song:WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい","meta":{"name":"What do you want more than a Happy ending?","composer":"Apo11o\"HALO\"program ft. 安月名 莉子×大瀬良あい","illustrator":"Amor fati","charter":"欢迎回到 Phigros！","difficultyClass":"IN","difficulty":16.1,"level":"IN Lv.16","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-IN","notes":1217,"lines":24,"scoreIdentity":"builtin-reference:chapter9-WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-in","files":[{"name":"chart.json","asset":"ch9_12_in"},{"name":"music.ogg","asset":"ch9_12_music"},{"name":"illustration.png","asset":"ch9_12_artIN"},{"name":"info.yml","asset":"ch9_12_in_info"}]},{"id":"chapter9-WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-at","name":"What do you want more than a Happy ending?","sourceName":"What do you want more than a Happy ending? AT","parser":"pgr","audioHash":"reference-song:WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい","meta":{"name":"What do you want more than a Happy ending?","composer":"Apo11o\"HALO\"program ft. 安月名 莉子×大瀬良あい","illustrator":"Amor fati","charter":"欢迎回到 Phigros！","difficultyClass":"AT","difficulty":17.1,"level":"AT Lv.17","chart":"chart.json","music":"music.ogg","illustration":"illustration.png","chapter":"Chapter 9 · 不息的信号"},"thumbnailKey":"WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-AT","notes":1568,"lines":24,"scoreIdentity":"builtin-reference:chapter9-WhatdoyouwantmorethanaHappyending.Apo11oHALOprogramft安月名莉子大瀬良あい-at","files":[{"name":"chart.json","asset":"ch9_12_at"},{"name":"music.ogg","asset":"ch9_12_music"},{"name":"illustration.png","asset":"ch9_12_artAT"},{"name":"info.yml","asset":"ch9_12_at_info"}]}];
  for (const entry of BUILTIN_PACKS) if (entry.thumbnailKey) entry.thumbnailData=REFERENCE_THUMBNAILS[entry.thumbnailKey];
  const BUILTIN_ASSETS = [{"id":"ch9_0_music","method":0,"usize":1922807,"sha256":"79c7599de8be06aeab13175d5f3f02b3b3b7e62f6d957fba80388cc1fbb705ab","gitBlobSha":"2e5a47fadcf9f73e0fac27d9249b506ee4df8753","duration":127.235193,"channels":2,"sampleRate":44100,"codec":"vorbis","url":"./assets/audio/ch9_0_music.ogg","byteLength":1922807,"packedSha256":"79c7599de8be06aeab13175d5f3f02b3b3b7e62f6d957fba80388cc1fbb705ab"},{"id":"ch9_0_art","method":0,"usize":2082062,"sha256":"ccf62cb5a66bf7e7f16c7cb145307760430a5622f435dafcaade9cf719312b1a","gitBlobSha":"20699bcd1c5b4d1d9e6a2a7dd3fafaa434b718ea","width":2048,"height":1080,"url":"./assets/images/ch9_0_art.png","byteLength":2082062,"packedSha256":"ccf62cb5a66bf7e7f16c7cb145307760430a5622f435dafcaade9cf719312b1a"},{"id":"ch9_0_ez","method":9,"usize":69254,"sha256":"a42c44cabf74ba16d99ce953a72943df106791aae24a02c3b9ccf402fb7cbdfa","format":"original-json","url":"./assets/charts/individual/ch9_0_ez.bin","byteLength":9317,"packedSha256":"9eaae4eb84bd7bfaae3e30838b94b1bc3004e46b98a08cfc3bb313cdef9fd4db"},{"id":"ch9_0_ez_info","method":9,"usize":266,"url":"./assets/charts/individual/ch9_0_ez_info.bin","byteLength":226,"packedSha256":"a6ed36d086af4c99841571fad3f52dc37c37e3145f213e36ce6096aa1b192002"},{"id":"ch9_0_hd","method":9,"usize":197979,"sha256":"736388e75776332ce45095771cc49126f5f62c28d6191e23ab958203dbc4d6a9","format":"original-json","url":"./assets/charts/individual/ch9_0_hd.bin","byteLength":26193,"packedSha256":"f499143badb1ab49603bbc4bd96e4a14e467b92802fa7dfe6c831b8dc8a094d8"},{"id":"ch9_0_hd_info","method":9,"usize":266,"url":"./assets/charts/individual/ch9_0_hd_info.bin","byteLength":226,"packedSha256":"0f491c197244d81283f7dd4a0ae56f88df3dbd415f544452d7057343c091a8b8"},{"id":"ch9_0_in","method":9,"usize":723252,"sha256":"923a654d5f48c9e74722fe01bd57298a23dcf89e52c7ac8c08ac1e6b2e9c943a","format":"original-json","url":"./assets/charts/individual/ch9_0_in.bin","byteLength":97733,"packedSha256":"2b586f8768860b99f05c4f31c69f3b47b731b37997cf974f75d271574cd4b416"},{"id":"ch9_0_in_info","method":9,"usize":268,"url":"./assets/charts/individual/ch9_0_in_info.bin","byteLength":228,"packedSha256":"fd88d5d07f6a1c4190546ab6ad3f6f4feb786fef1f20ce0e6e744f1375610dac"},{"id":"ch9_0_at","method":9,"usize":3798389,"sha256":"5a67cef9e448d16e0ac5fcdffa00bbc30bc5ff5cf8423a447dc3e0abcb37057f","format":"original-json","url":"./assets/charts/individual/ch9_0_at.bin","byteLength":569306,"packedSha256":"4a78b14e6a176d1dedd7259fcbd3426f6de904b78b0fd812d7a23bf3ae089e4f"},{"id":"ch9_0_at_info","method":9,"usize":254,"url":"./assets/charts/individual/ch9_0_at_info.bin","byteLength":210,"packedSha256":"54ac2d1a5681a0e8a43f8802e749ee1c860af9cac1d2ada81754853b32ff1a8f"},{"id":"ch9_1_music","method":0,"usize":1991566,"sha256":"9ab35fdff6b349233c0f2988148e093bf99491a261e9d1949ed7e6fe9c364e6e","gitBlobSha":"9660a3e126327e4a3f43759ee3d0efcc3da86193","duration":139.675283,"channels":2,"sampleRate":44100,"codec":"vorbis","url":"./assets/audio/ch9_1_music.ogg","byteLength":1991566,"packedSha256":"9ab35fdff6b349233c0f2988148e093bf99491a261e9d1949ed7e6fe9c364e6e"},{"id":"ch9_1_art","method":0,"usize":2513799,"sha256":"ba1a956eadeb6f97c54aa8e346bed5a335339c68cfff3453f0301fc0f219927c","gitBlobSha":"dcfcb288437aa36a8b043d52dd1d966430f2efb9","width":2048,"height":1080,"url":"./assets/images/ch9_1_art.png","byteLength":2513799,"packedSha256":"ba1a956eadeb6f97c54aa8e346bed5a335339c68cfff3453f0301fc0f219927c"},{"id":"ch9_1_ez","method":14,"usize":198508,"url":"./assets/charts/individual/ch9_1_ez.bin","byteLength":25034,"packedSha256":"b1e23afd2d14448ae42acc06f3872ad67669a571bf3be34425058ff56e7b1e95"},{"id":"ch9_1_ez_info","method":9,"usize":293,"url":"./assets/charts/individual/ch9_1_ez_info.bin","byteLength":248,"packedSha256":"cc7deb09431dd1feb8d4c379f3f6d4bbacd6f87e453f6865d0f9aa0a80d70bd3"},{"id":"ch9_1_hd","method":14,"usize":449978,"url":"./assets/charts/individual/ch9_1_hd.bin","byteLength":37659,"packedSha256":"8f8bda06ce7e858afb9e1b1432a93e29b205abae5b9766110598d27feeaaea6c"},{"id":"ch9_1_hd_info","method":9,"usize":293,"url":"./assets/charts/individual/ch9_1_hd_info.bin","byteLength":248,"packedSha256":"57333db34400076743e6d583999a51303de50af08b29430774aa83575a028e17"},{"id":"ch9_1_in","method":14,"usize":1087325,"url":"./assets/charts/individual/ch9_1_in.bin","byteLength":136160,"packedSha256":"77b0566cd596957ae592d1e12e522344cf8b2349ed1c71e6d26693694368813d"},{"id":"ch9_1_in_info","method":9,"usize":295,"url":"./assets/charts/individual/ch9_1_in_info.bin","byteLength":250,"packedSha256":"418ff269d5850c7737de94520e352083f8e8268a855ce646713d07c942eddfee"},{"id":"ch9_2_music","method":0,"usize":2025877,"sha256":"4742c4002ad0929b726cc43c0295620f8efc8882ce0c764e14949abc83223f81","gitBlobSha":"bfe5029f037e002d880507e9e8dfc39418ef080e","duration":137.022404,"channels":2,"sampleRate":44100,"codec":"vorbis","url":"./assets/audio/ch9_2_music.ogg","byteLength":2025877,"packedSha256":"4742c4002ad0929b726cc43c0295620f8efc8882ce0c764e14949abc83223f81"},{"id":"ch9_2_art","method":0,"usize":2399698,"sha256":"c74d87395d59e55761c8a8d6b3d5069a97863ce27e94fc786db163f163c4295a","gitBlobSha":"1b79ab905486df35b16e27bd6db44ffcfa4fa87c","width":2048,"height":1080,"url":"./assets/images/ch9_2_art.png","byteLength":2399698,"packedSha256":"c74d87395d59e55761c8a8d6b3d5069a97863ce27e94fc786db163f163c4295a"},{"id":"ch9_2_ez","method":14,"usize":130949,"url":"./assets/charts/individual/ch9_2_ez.bin","byteLength":20983,"packedSha256":"d5283e58ff1990fd27148689c2fd8042fd335df8a785bcb9225eccffaa75e0ae"},{"id":"ch9_2_ez_info","method":9,"usize":274,"url":"./assets/charts/individual/ch9_2_ez_info.bin","byteLength":222,"packedSha256":"22bb9fb969cbe1a2e69bcbb61e36f28ab065d46827f438442a1b4f521c2a75bf"},{"id":"ch9_2_hd","method":14,"usize":194753,"url":"./assets/charts/individual/ch9_2_hd.bin","byteLength":35152,"packedSha256":"4198c5e8bea0bafc60592889c96e0d0ae806de6a422b99a1e95a32e58d818339"},{"id":"ch9_2_hd_info","method":9,"usize":276,"url":"./assets/charts/individual/ch9_2_hd_info.bin","byteLength":225,"packedSha256":"5fddf3bd5c059380c59ad4bed911b489fb9c8736b2ba0efcf4df0c4c02abe7da"},{"id":"ch9_2_in","method":14,"usize":484481,"url":"./assets/charts/individual/ch9_2_in.bin","byteLength":88572,"packedSha256":"779a6a6ef6eafbbf0fcd551f61ea3365b58fba8164af9bb4a4f68d2403154465"},{"id":"ch9_2_in_info","method":9,"usize":289,"url":"./assets/charts/individual/ch9_2_in_info.bin","byteLength":237,"packedSha256":"371290192aaf54c413c0defbc5ae57254a15f189f35cd4916d3a433a88bf01b1"},{"id":"ch9_3_music","method":0,"usize":1936333,"sha256":"a0cf6424c6c76735da9c8ddf95674d648103ad0a0828115d4281b1974f88b27f","gitBlobSha":"46f00a31d891e380c2081d64720e06aa5274243a","duration":130.041905,"channels":2,"sampleRate":44100,"codec":"vorbis","url":"./assets/audio/ch9_3_music.ogg","byteLength":1936333,"packedSha256":"a0cf6424c6c76735da9c8ddf95674d648103ad0a0828115d4281b1974f88b27f"},{"id":"ch9_3_art","method":0,"usize":2359966,"sha256":"5a518bcbf96069bb28d08bc5fd4368fd1cf8a9ffc10410eb69be9a5818954b6a","gitBlobSha":"5c563620afc1b1c93c80bc6682fb407e3d7c1058","width":2048,"height":1080,"url":"./assets/images/ch9_3_art.png","byteLength":2359966,"packedSha256":"5a518bcbf96069bb28d08bc5fd4368fd1cf8a9ffc10410eb69be9a5818954b6a"},{"id":"ch9_3_ez","method":14,"usize":536811,"url":"./assets/charts/individual/ch9_3_ez.bin","byteLength":64412,"packedSha256":"0af1ad3fa85115a31edb4130ccd5e7aee98d61130c11cf44da45f8265b3179cc"},{"id":"ch9_3_ez_info","method":9,"usize":286,"url":"./assets/charts/individual/ch9_3_ez_info.bin","byteLength":236,"packedSha256":"3ac5a7ec9d8680d29772741c349238b41f802495653570861ae612da7e2cdf40"},{"id":"ch9_3_hd","method":14,"usize":485514,"url":"./assets/charts/individual/ch9_3_hd.bin","byteLength":73282,"packedSha256":"4949478f1099f80eab57a27ec2b64e107f2f5d76b555b6991d9d8b757e2b6f5f"},{"id":"ch9_3_hd_info","method":9,"usize":288,"url":"./assets/charts/individual/ch9_3_hd_info.bin","byteLength":241,"packedSha256":"c25f35c30552748ffb886a0a1cadfe0944673fa349437b25037188ea084bceb9"},{"id":"ch9_3_in","method":14,"usize":1313866,"url":"./assets/charts/individual/ch9_3_in.bin","byteLength":230534,"packedSha256":"d242d382f4e0b3f7d62f329e1695e47c3fc40ae0023a9f6c8a29228c8f03cd4b"},{"id":"ch9_3_in_info","method":9,"usize":302,"url":"./assets/charts/individual/ch9_3_in_info.bin","byteLength":244,"packedSha256":"c2162dbea6654174336d044037ca5555a9d9ae282006ddb70af8f85816fea2fe"},{"id":"ch9_4_music","method":0,"usize":2123174,"sha256":"a7cc24091b4f304416fc26262951306adcf29a664d614375d36680575cc7f7c6","gitBlobSha":"a0c4f82af1afdfd4ffded2cd2308053101c78476","duration":144.356,"channels":2,"sampleRate":48000,"codec":"vorbis","url":"./assets/audio/ch9_4_music.ogg","byteLength":2123174,"packedSha256":"a7cc24091b4f304416fc26262951306adcf29a664d614375d36680575cc7f7c6"},{"id":"ch9_4_art","method":0,"usize":2965370,"sha256":"bac016e69d35c95efe64d1cb8661fee74523920d1b744c633e0d8283c2f3c82b","gitBlobSha":"442277e0d04f2bf0e5db2cfd231ab9beeca0ce9b","width":2048,"height":1080,"url":"./assets/images/ch9_4_art.png","byteLength":2965370,"packedSha256":"bac016e69d35c95efe64d1cb8661fee74523920d1b744c633e0d8283c2f3c82b"},{"id":"ch9_4_ez","method":14,"usize":490273,"url":"./assets/charts/individual/ch9_4_ez.bin","byteLength":62650,"packedSha256":"e3a0e0336572fc46d550d8c931728d1c038f32cf7b46f2bd36d837627fe504ff"},{"id":"ch9_4_ez_info","method":9,"usize":302,"url":"./assets/charts/individual/ch9_4_ez_info.bin","byteLength":244,"packedSha256":"670fce25f93f9877847fd239b2804365ba013d384eb9c31d3b9409dd5cf5f9eb"},{"id":"ch9_4_hd","method":14,"usize":1079671,"url":"./assets/charts/individual/ch9_4_hd.bin","byteLength":86597,"packedSha256":"eaba4cd98739ea11fd9d06557e9ac7ea541a005bc4d2b7a5899874e89a42aad6"},{"id":"ch9_4_hd_info","method":9,"usize":305,"url":"./assets/charts/individual/ch9_4_hd_info.bin","byteLength":249,"packedSha256":"9324e773ebd6fea548e98b3cdb38fb3a212f4f339fc0084309f531bc90cb2368"},{"id":"ch9_4_in","method":14,"usize":1056365,"url":"./assets/charts/individual/ch9_4_in.bin","byteLength":166670,"packedSha256":"0cec79a36cafde7135637b2c83002a6efa25172f5ce1ad27e4bfbd35737c8e12"},{"id":"ch9_4_in_info","method":9,"usize":303,"url":"./assets/charts/individual/ch9_4_in_info.bin","byteLength":249,"packedSha256":"8540038caa27631d4d94a3764d7e8135998e674f35cefb768ee603ff4f279563"},{"id":"ch9_4_at","method":14,"usize":941819,"url":"./assets/charts/individual/ch9_4_at.bin","byteLength":130444,"packedSha256":"bc936745dd263da4c157390d7c2a026f0f8766a7ad53b5a7ca52eabc8459a56e"},{"id":"ch9_4_at_info","method":9,"usize":304,"url":"./assets/charts/individual/ch9_4_at_info.bin","byteLength":249,"packedSha256":"4913bddd705e84857f1feb7796c14e65d9edb6176842adc043e9685d41fd373e"},{"id":"ch9_5_music","method":0,"usize":2602309,"sha256":"88c76d9da269f1fab4f8ccba3b486d4c644784aab67f17fd4b92a355fd08df3f","gitBlobSha":"74ed94ff907c2d84bc4b0e823fe2ff9e0756ef57","duration":178.754467,"channels":2,"sampleRate":44100,"codec":"vorbis","url":"./assets/audio/ch9_5_music.ogg","byteLength":2602309,"packedSha256":"88c76d9da269f1fab4f8ccba3b486d4c644784aab67f17fd4b92a355fd08df3f"},{"id":"ch9_5_art","method":0,"usize":3760343,"sha256":"02e0e6c98242ab4ba34d631f84d4ad8d1c39d4efa14561bc6d2bd97cc4bdc692","gitBlobSha":"3d0719c042d40cb2acb4ae872159beb6b82bca3f","width":2048,"height":1080,"url":"./assets/images/ch9_5_art.png","byteLength":3760343,"packedSha256":"02e0e6c98242ab4ba34d631f84d4ad8d1c39d4efa14561bc6d2bd97cc4bdc692"},{"id":"ch9_5_ez","method":14,"usize":761462,"url":"./assets/charts/individual/ch9_5_ez.bin","byteLength":153504,"packedSha256":"3e19adacbe5379b9e17ada3c7050b64381ff8e733cb0f7f472440c5172f536a8"},{"id":"ch9_5_ez_info","method":9,"usize":300,"url":"./assets/charts/individual/ch9_5_ez_info.bin","byteLength":249,"packedSha256":"7c31874ffeebf5ee96a6a125f3fae5894e829656d0fe2d2c634a808d0ef9c0f3"},{"id":"ch9_5_hd","method":14,"usize":782689,"url":"./assets/charts/individual/ch9_5_hd.bin","byteLength":91171,"packedSha256":"6d1ae77dd9608e8906fbaa407a7b72161e08665e1e63c5b40934bd991106e4c5"},{"id":"ch9_5_hd_info","method":9,"usize":303,"url":"./assets/charts/individual/ch9_5_hd_info.bin","byteLength":254,"packedSha256":"87457767603c49debf3e68ae6d3319762e8cf3fefea35a48f0fc102531e4d72d"},{"id":"ch9_5_in","method":14,"usize":1719064,"url":"./assets/charts/individual/ch9_5_in.bin","byteLength":231879,"packedSha256":"176773ed938a40c6ecca7438c174bf4d47f790f5fce964daf487b827ae598ead"},{"id":"ch9_5_in_info","method":9,"usize":303,"url":"./assets/charts/individual/ch9_5_in_info.bin","byteLength":253,"packedSha256":"528fb709a585914acfed5afb08ac78d3f18c4a83aabcf2088669ad4d95debbe0"},{"id":"ch9_5_at","method":14,"usize":1741622,"url":"./assets/charts/individual/ch9_5_at.bin","byteLength":283894,"packedSha256":"be98335afb457f269c6760d9601478f907abd288d10ff4bd9fdc040c0e50a4bb"},{"id":"ch9_5_at_info","method":9,"usize":307,"url":"./assets/charts/individual/ch9_5_at_info.bin","byteLength":256,"packedSha256":"055ced16996b72500ab41a151a4fa83f142d47ad077889ef7c2dbf494d8df93c"},{"id":"ch9_7_music","method":0,"usize":2644690,"sha256":"46833a3b19e1157884bb1cc42582207930d1d6a5126d072cf127cfcb9ffe9ebe","gitBlobSha":"c60ac163ded01d4eefde80c390da460ab66534cb","duration":172.00907,"channels":2,"sampleRate":44100,"codec":"vorbis","url":"./assets/audio/ch9_7_music.ogg","byteLength":2644690,"packedSha256":"46833a3b19e1157884bb1cc42582207930d1d6a5126d072cf127cfcb9ffe9ebe"},{"id":"ch9_7_art","method":0,"usize":3320385,"sha256":"2484c0247872057b0a7f94db4cddf27aa76b7aa0b1e1f5afd975b0f91ed696d2","gitBlobSha":"a78cd87305d53ec4980d657b5692b1afa8e0d855","width":2048,"height":1080,"url":"./assets/images/ch9_7_art.png","byteLength":3320385,"packedSha256":"2484c0247872057b0a7f94db4cddf27aa76b7aa0b1e1f5afd975b0f91ed696d2"},{"id":"ch9_7_ez","method":14,"usize":167534,"url":"./assets/charts/individual/ch9_7_ez.bin","byteLength":43681,"packedSha256":"a287e139fedd0920712619a60f3b9e4912b7a9b9bb6da5e54d207bcc77f665be"},{"id":"ch9_7_ez_info","method":9,"usize":262,"url":"./assets/charts/individual/ch9_7_ez_info.bin","byteLength":212,"packedSha256":"0bf7235a827e13c27abaee20e7c4ac68dd128e3bbec8800398f348e2cb1a430c"},{"id":"ch9_7_hd","method":14,"usize":278246,"url":"./assets/charts/individual/ch9_7_hd.bin","byteLength":46671,"packedSha256":"39f02a9e5d63c7e5b1325311d15c2bd96676faacdf9b974fe987d7e34278153a"},{"id":"ch9_7_hd_info","method":9,"usize":263,"url":"./assets/charts/individual/ch9_7_hd_info.bin","byteLength":214,"packedSha256":"0e73a42635f801792b9792064a90edc4b36745f90bc25fb165813d7cbcffa993"},{"id":"ch9_7_in","method":14,"usize":709782,"url":"./assets/charts/individual/ch9_7_in.bin","byteLength":86063,"packedSha256":"42cc720b9d5695f2209b2cae713a95c0108d64176e8c09e34ca1e365ba4341fe"},{"id":"ch9_7_in_info","method":9,"usize":265,"url":"./assets/charts/individual/ch9_7_in_info.bin","byteLength":215,"packedSha256":"ebf0f885d5a247726729960647f4b9a0d3bf47c7e67bf07d3e64a06083bdf2ce"},{"id":"ch9_7_at","method":14,"usize":1239027,"url":"./assets/charts/individual/ch9_7_at.bin","byteLength":153441,"packedSha256":"9818b545fa47afd6aacb9fecccecbded0d884f2264ca887e81d69f5f074856ea"},{"id":"ch9_7_at_info","method":9,"usize":263,"url":"./assets/charts/individual/ch9_7_at_info.bin","byteLength":206,"packedSha256":"0d149388e35edfc15dafb0cb6ea7d16d87e6c933d3c7e391be25cdae702c04c1"},{"id":"ch9_8_music","method":0,"usize":2534724,"sha256":"94d928f505aa200592dff1e4089e0a3a4921aac70dcaeba2808338424a69a69b","gitBlobSha":"da2c9acfa0663fb13f4071b0b098a417a83a712b","duration":165.313333,"channels":2,"sampleRate":48000,"codec":"vorbis","url":"./assets/audio/ch9_8_music.ogg","byteLength":2534724,"packedSha256":"94d928f505aa200592dff1e4089e0a3a4921aac70dcaeba2808338424a69a69b"},{"id":"ch9_8_art","method":0,"usize":4902281,"sha256":"44f09091b4ec888a8af9a51a977b21fa0b09ea7c19cd30e9b321049ba8ae2fb2","gitBlobSha":"72fc9e92d6f8cd9a955e0fbbe9a983638e5da503","width":2048,"height":1080,"url":"./assets/images/ch9_8_art.png","byteLength":4902281,"packedSha256":"44f09091b4ec888a8af9a51a977b21fa0b09ea7c19cd30e9b321049ba8ae2fb2"},{"id":"ch9_8_ez","method":14,"usize":189388,"url":"./assets/charts/individual/ch9_8_ez.bin","byteLength":41397,"packedSha256":"092f32dabd333600c5769549a48100764976fa3b6c685647f923f45ca85cd19d"},{"id":"ch9_8_ez_info","method":9,"usize":280,"url":"./assets/charts/individual/ch9_8_ez_info.bin","byteLength":234,"packedSha256":"ea12921736b402af87c46157756c4b932a8751f25e7797bb32e6933315fe0fe5"},{"id":"ch9_8_hd","method":14,"usize":636888,"url":"./assets/charts/individual/ch9_8_hd.bin","byteLength":79619,"packedSha256":"a52ac44b9670789749ae6e2eddd0c2e63b2a83f062087a3ca6c34b4ea85ddfaa"},{"id":"ch9_8_hd_info","method":9,"usize":283,"url":"./assets/charts/individual/ch9_8_hd_info.bin","byteLength":237,"packedSha256":"c8c25727ccc9766c6a02f81b535ca3d11882753154ad975d273c6c010d600b61"},{"id":"ch9_8_in","method":14,"usize":539496,"url":"./assets/charts/individual/ch9_8_in.bin","byteLength":99659,"packedSha256":"fcf3b9e7fa66b407b2cb577dd4438c79965bb0524d1a960bd4f41b008dffb396"},{"id":"ch9_8_in_info","method":9,"usize":280,"url":"./assets/charts/individual/ch9_8_in_info.bin","byteLength":234,"packedSha256":"cef8a7548fae0784cbeceab0d914ee9b377b926b962d127ecc0060b08283f09f"},{"id":"ch9_8_at","method":14,"usize":1416316,"url":"./assets/charts/individual/ch9_8_at.bin","byteLength":223131,"packedSha256":"65a1ac75a84367ee558d4b449b02a32be650041f19145b69d0d7ee2feaf9d6d6"},{"id":"ch9_8_at_info","method":9,"usize":286,"url":"./assets/charts/individual/ch9_8_at_info.bin","byteLength":230,"packedSha256":"bda6a0b2e3a2ca71f5511e5a6212f7fd3a3ca2c493de9c1352eaaa10b805b3ea"},{"id":"ch9_9_music","method":0,"usize":2486239,"sha256":"4dc62036ccfc1989205a6aa95619f80927a2bc359ec791db01c2473a7e382e19","gitBlobSha":"96a92fe0596aaeb59d4f7feb1eb5185394ae0093","duration":174.966667,"channels":2,"sampleRate":48000,"codec":"vorbis","url":"./assets/audio/ch9_9_music.ogg","byteLength":2486239,"packedSha256":"4dc62036ccfc1989205a6aa95619f80927a2bc359ec791db01c2473a7e382e19"},{"id":"ch9_9_art","method":0,"usize":2329681,"sha256":"8459fbea476f63caa6160cf11af9ad3fef9092306ce15f809c1bbed624a0751d","gitBlobSha":"ced7c3f2bcd4048a078694a5be35ebeb644ba2b9","width":2048,"height":1080,"url":"./assets/images/ch9_9_art.png","byteLength":2329681,"packedSha256":"8459fbea476f63caa6160cf11af9ad3fef9092306ce15f809c1bbed624a0751d"},{"id":"ch9_9_ez","method":14,"usize":61501,"url":"./assets/charts/individual/ch9_9_ez.bin","byteLength":14303,"packedSha256":"64be91cbe84489461d58f21aff251828e32244009e64bfd537e36cdca0dee17e"},{"id":"ch9_9_ez_info","method":9,"usize":271,"url":"./assets/charts/individual/ch9_9_ez_info.bin","byteLength":223,"packedSha256":"88304fa7798e260fe9ad97d66f80c8a458df518269e9cef04a201d242a456f0c"},{"id":"ch9_9_hd","method":14,"usize":153536,"url":"./assets/charts/individual/ch9_9_hd.bin","byteLength":29782,"packedSha256":"3bfa7fbb627e0039f3b028b8507d2d84aff5a7106f3eb9fbfbc7d26e31918066"},{"id":"ch9_9_hd_info","method":9,"usize":273,"url":"./assets/charts/individual/ch9_9_hd_info.bin","byteLength":225,"packedSha256":"f1e3f93b2d90062f02573f527d4b73700728e21ad11d8994672c331e84c4a9a9"},{"id":"ch9_9_in","method":14,"usize":430021,"url":"./assets/charts/individual/ch9_9_in.bin","byteLength":96666,"packedSha256":"0484a9efc10670b281812852086b74b59fd2e196173eccdecf3b702b65f92dac"},{"id":"ch9_9_in_info","method":9,"usize":273,"url":"./assets/charts/individual/ch9_9_in_info.bin","byteLength":225,"packedSha256":"5b6acdb44c66e71624a1c02bc99bfb942813e668b8d65d52a4e07fd75a7f2892"},{"id":"ch9_9_at","method":14,"usize":2718047,"url":"./assets/charts/individual/ch9_9_at.bin","byteLength":185360,"packedSha256":"be4989acf5a9b172004c1f02b7660d1ae220e9200f8d5c763ade1ae8d332046b"},{"id":"ch9_9_at_info","method":9,"usize":273,"url":"./assets/charts/individual/ch9_9_at_info.bin","byteLength":224,"packedSha256":"90bab68fb871e0633ab363a7a250107cbb92e189202d359764fe8272e71c3df7"},{"id":"ch9_10_music","method":0,"usize":2352757,"sha256":"a25a54588559237cd8ca114e505f677f57e4cb695595146efd30171cbc22bdba","gitBlobSha":"313a436bfc1a0bbaa59ff6b0fbcba8543b84d357","duration":150.750667,"channels":2,"sampleRate":48000,"codec":"vorbis","url":"./assets/audio/ch9_10_music.ogg","byteLength":2352757,"packedSha256":"a25a54588559237cd8ca114e505f677f57e4cb695595146efd30171cbc22bdba"},{"id":"ch9_10_art","method":0,"usize":3352089,"sha256":"1122e5c2f7223e60a887cb3f498ad9e129764b95a247a032c49bbb4a997792a0","gitBlobSha":"832168a5d509577835c398c181afa3ba11683eeb","width":2048,"height":1080,"url":"./assets/images/ch9_10_art.png","byteLength":3352089,"packedSha256":"1122e5c2f7223e60a887cb3f498ad9e129764b95a247a032c49bbb4a997792a0"},{"id":"ch9_10_ez","method":14,"usize":297083,"url":"./assets/charts/individual/ch9_10_ez.bin","byteLength":60941,"packedSha256":"db6eea44b7104bd3924fdd9c0b61df37f8eaf0b4ce390585d7d6fafcd0cab71c"},{"id":"ch9_10_ez_info","method":9,"usize":308,"url":"./assets/charts/individual/ch9_10_ez_info.bin","byteLength":257,"packedSha256":"08488bb4c98b6424a94eb7f0b3f2d369bcb08216d01e5a4295c5e277d8d639f8"},{"id":"ch9_10_hd","method":14,"usize":589138,"url":"./assets/charts/individual/ch9_10_hd.bin","byteLength":95258,"packedSha256":"651a440f90b568cd5d38fc95b1bd14dbd0415e4cefb11c439956791424def8d4"},{"id":"ch9_10_hd_info","method":9,"usize":305,"url":"./assets/charts/individual/ch9_10_hd_info.bin","byteLength":254,"packedSha256":"471623e8a7c94181bda801c08e20793182b1a084c49be40a16b39fa8d6cd5598"},{"id":"ch9_10_in","method":14,"usize":915167,"url":"./assets/charts/individual/ch9_10_in.bin","byteLength":174982,"packedSha256":"3f40b5485d85281a1041fe14a361a6985ac2eaafbba8d740d9366f1e171f772d"},{"id":"ch9_10_in_info","method":9,"usize":305,"url":"./assets/charts/individual/ch9_10_in_info.bin","byteLength":254,"packedSha256":"5268f783762736e5f620c3c3007ea12ddff9cb7001a027b6664da11e81253922"},{"id":"ch9_10_at","method":14,"usize":1585071,"url":"./assets/charts/individual/ch9_10_at.bin","byteLength":306848,"packedSha256":"3157854563e493910a428e160e3274127a80b7e706c98686b795127ba75c0a70"},{"id":"ch9_10_at_info","method":9,"usize":302,"url":"./assets/charts/individual/ch9_10_at_info.bin","byteLength":235,"packedSha256":"efc687149e0f9b77419ab17b1806cae67c08fcd3c3b326489fd2057b4ed11bce"},{"id":"ch9_11_music","method":0,"usize":2435927,"sha256":"0414bec5b7de47d9c3e23837abaa9e476009fb68b4059f2f8c5535401cd32832","gitBlobSha":"d7ba5692e6362f83de5cb3d64c855cd681132df4","duration":168.006667,"channels":2,"sampleRate":48000,"codec":"vorbis","url":"./assets/audio/ch9_11_music.ogg","byteLength":2435927,"packedSha256":"0414bec5b7de47d9c3e23837abaa9e476009fb68b4059f2f8c5535401cd32832"},{"id":"ch9_11_art","method":0,"usize":2622574,"sha256":"25fcd2cb877e0a2d309d12ef2385467bd7fa19843be1087a350d35d212c77f15","gitBlobSha":"948955be80dbf2bda8533058297ce4346642ef7d","width":2048,"height":1080,"url":"./assets/images/ch9_11_art.png","byteLength":2622574,"packedSha256":"25fcd2cb877e0a2d309d12ef2385467bd7fa19843be1087a350d35d212c77f15"},{"id":"ch9_11_ez","method":14,"usize":183641,"url":"./assets/charts/individual/ch9_11_ez.bin","byteLength":39673,"packedSha256":"13d1692bbfaaa3f30399dd5f7fcb129103702bc010fd316d3e9e2a5718dec1f7"},{"id":"ch9_11_ez_info","method":9,"usize":294,"url":"./assets/charts/individual/ch9_11_ez_info.bin","byteLength":243,"packedSha256":"93ba3cd650abff3907f6bb9771f845733383c99a0bb0bd86ec3b180f77a458c8"},{"id":"ch9_11_hd","method":14,"usize":616824,"url":"./assets/charts/individual/ch9_11_hd.bin","byteLength":88212,"packedSha256":"69b2916c65d35a0933be130f0970fdc1a76fe68160f57e787beb1a51c296574a"},{"id":"ch9_11_hd_info","method":9,"usize":296,"url":"./assets/charts/individual/ch9_11_hd_info.bin","byteLength":249,"packedSha256":"bf8739430dab8b5f75ca356644f1a6e3e9ff94a694f50eaf96b9c49e68e5f8cb"},{"id":"ch9_11_in","method":14,"usize":646274,"url":"./assets/charts/individual/ch9_11_in.bin","byteLength":120789,"packedSha256":"adb5a98728a5f4b09c13b8facd42d88b6dd357256d35540e93e5e184ba141c5d"},{"id":"ch9_11_in_info","method":9,"usize":294,"url":"./assets/charts/individual/ch9_11_in_info.bin","byteLength":250,"packedSha256":"5e2513bfa7b8e9e4b8c073fa2a61ce5a6af5ad8f731445508b4af7c0201aff0c"},{"id":"ch9_11_at","method":14,"usize":985173,"url":"./assets/charts/individual/ch9_11_at.bin","byteLength":161990,"packedSha256":"11fb1b836c1ab9d3750a43d85fd9ba06e5a2296fc9d18d25ba75dcaee124e599"},{"id":"ch9_11_at_info","method":9,"usize":296,"url":"./assets/charts/individual/ch9_11_at_info.bin","byteLength":252,"packedSha256":"07edbe4503313a5e773566f0f9fda3316dddd3768dd248c4f4cc74e5acfa125e"},{"id":"ch9_11_sp","method":14,"usize":1616626,"url":"./assets/charts/individual/ch9_11_sp.bin","byteLength":171095,"packedSha256":"93cb1c5e15b255fe09fd01c1088671dcd005ede344160b6d3a805263e81ce744"},{"id":"ch9_11_sp_info","method":9,"usize":271,"url":"./assets/charts/individual/ch9_11_sp_info.bin","byteLength":227,"packedSha256":"ebb9580840b046709876793a616ef2e1fe42d009b1e58799abbb34e1775006b0"},{"id":"ch9_12_music","method":0,"usize":2521479,"sha256":"66206715c7f2e4b44939435c5fb89151db72a2f70a200fd0bfdadcdc9ca6a55b","gitBlobSha":"851c0ffea5fd97d3f9cfa8e76d4eafe9f264f846","duration":162.198639,"channels":2,"sampleRate":44100,"codec":"vorbis","url":"./assets/audio/ch9_12_music.ogg","byteLength":2521479,"packedSha256":"66206715c7f2e4b44939435c5fb89151db72a2f70a200fd0bfdadcdc9ca6a55b"},{"id":"ch9_12_artEZ","method":0,"usize":2243954,"sha256":"7163f838c62536ac7716f148e73ac0bf618dc1fa13dadfe3382e5530f37e13ec","gitBlobSha":"240d534ea41420ef81e7c7a406b62109fb4d3780","width":2048,"height":1080,"url":"./assets/images/ch9_12_artEZ.png","byteLength":2243954,"packedSha256":"7163f838c62536ac7716f148e73ac0bf618dc1fa13dadfe3382e5530f37e13ec"},{"id":"ch9_12_artHD","method":0,"usize":2318536,"sha256":"e8422d9696a18df46574dcb2b2a080f956df4d3b2cf37e3f13d44fcd86b2bd2f","gitBlobSha":"e2a8548ca9d9331287c4d8382f75815ac681d919","width":2048,"height":1080,"url":"./assets/images/ch9_12_artHD.png","byteLength":2318536,"packedSha256":"e8422d9696a18df46574dcb2b2a080f956df4d3b2cf37e3f13d44fcd86b2bd2f"},{"id":"ch9_12_artIN","method":0,"usize":2235220,"sha256":"06d1b50365de03fd27647b623a3101cfe1011330d8508c63ab6fb6736371a16a","gitBlobSha":"5ba20997e1a0ea63c4136142ced7bf6514303e39","width":2048,"height":1080,"url":"./assets/images/ch9_12_artIN.png","byteLength":2235220,"packedSha256":"06d1b50365de03fd27647b623a3101cfe1011330d8508c63ab6fb6736371a16a"},{"id":"ch9_12_artAT","method":0,"usize":2317589,"sha256":"43226b33f15384334ffc0315afc48f4a6391d5634864958b6c6b77cf168659e9","gitBlobSha":"22937ca53d6e59eb0f65757f73a770588c311056","width":2048,"height":1080,"url":"./assets/images/ch9_12_artAT.png","byteLength":2317589,"packedSha256":"43226b33f15384334ffc0315afc48f4a6391d5634864958b6c6b77cf168659e9"},{"id":"ch9_12_ez","method":14,"usize":567293,"url":"./assets/charts/individual/ch9_12_ez.bin","byteLength":85682,"packedSha256":"58cc337a3cb34f6fb52626d6281f632dafc210a7c661af6a886b689043b3fdba"},{"id":"ch9_12_ez_info","method":9,"usize":353,"url":"./assets/charts/individual/ch9_12_ez_info.bin","byteLength":302,"packedSha256":"1791c088dfa3e21429427e690294bf2b83960dee3100aa5d9b1d60d46825d230"},{"id":"ch9_12_hd","method":14,"usize":293090,"url":"./assets/charts/individual/ch9_12_hd.bin","byteLength":39213,"packedSha256":"9be105a1b889a08ad202a8b3770c46bede32d24afada1f171b841056002f7a16"},{"id":"ch9_12_hd_info","method":9,"usize":355,"url":"./assets/charts/individual/ch9_12_hd_info.bin","byteLength":302,"packedSha256":"ad4b0a18c3c8d44fe9911f185c8b1b107824505fdd14e6bf319415ffed243b5e"},{"id":"ch9_12_in","method":14,"usize":1566896,"url":"./assets/charts/individual/ch9_12_in.bin","byteLength":188575,"packedSha256":"d277aac11e366161519135425bf151b91efb421e61b6815a311ca5d0faeaa367"},{"id":"ch9_12_in_info","method":9,"usize":355,"url":"./assets/charts/individual/ch9_12_in_info.bin","byteLength":303,"packedSha256":"c3b0ff707a9146bd8ba1909a71a2fd8be45aa922cffcd6c895dff4e7c4bca11f"},{"id":"ch9_12_at","method":14,"usize":828570,"url":"./assets/charts/individual/ch9_12_at.bin","byteLength":159499,"packedSha256":"7c39a933df61c7657fbbf9a52e3c650424ee267507fcf8c082d0c39a8c3bdadd"},{"id":"ch9_12_at_info","method":9,"usize":355,"url":"./assets/charts/individual/ch9_12_at_info.bin","byteLength":302,"packedSha256":"4e4f3d84e19131f88f0a2124a2a3f3cd9f0db4b3b21fee22f314aa80b4a810f9"}];
  const BUILTIN_RESOURCE_PACK = Object.freeze({"name":"Phigros 原始材质 3.10.0","sourceName":"Phigros_3.10.0_original_skin.zip","author":"Pigeon Games","byteSize":2969183,"sha256":"2aa0e14d6741fecf7707579b42def2da9d54a6ccca63338ca8847c289d83fa0f","provenance":{"source":"https://github.com/SteveZMTstudios/Phigros-history/releases/tag/v3.10.0","apk":"Phigros_3.10.0.apk","version":"3.10.0","sprites":{"Tap":{"file":"sharedassets10.assets","pathId":64,"name":"Tap2","pixelsPerUnit":100.0,"rectangle":[0,0,989,100],"pivot":[0.5,0.5],"sha256":"ce063abf5a669ecd3e74afa4b8519540215eb190a9fc08ba79d82e10670aaa56","prefabReference":{"file":"sharedassets12.assets","componentPathId":83,"fileID":8,"pathID":64,"byteOffset":132}},"TapHL":{"pathId":30,"name":"Tap2HL","pixelsPerUnit":100.0,"rectangle":[0,0,1089,200],"sha256":"0547d02ec809d515ddb218c492204c3a0dd9b93e53876d592407aee61d071610","pivot":[0.5,0.5]},"Drag":{"pathId":33,"name":"Drag (1)","pixelsPerUnit":100.0,"rectangle":[0,0,989,60],"sha256":"6160f7ab94c7dea7c53c8630a75123407d4712363ed7e58425f92909e364dd25","pivot":[0.5,0.5]},"DragHL":{"pathId":28,"name":"DragHL","pixelsPerUnit":100.0,"rectangle":[0,0,1089,160],"sha256":"0ddb5344c9605c419ff9121f93cca7b995fa62bc40e310e48b9f857425cb5002","pivot":[0.5,0.5]},"Flick":{"pathId":29,"name":"Flick2","pixelsPerUnit":100.0,"rectangle":[0,0,989,200],"sha256":"177af0a6a0d3f8cd72c810e30ec404678ff1f477f0b523f1718a8ecbd65e9410","pivot":[0.5,0.5]},"FlickHL":{"pathId":31,"name":"Flick2HL","pixelsPerUnit":100.0,"rectangle":[0,0,1089,300],"sha256":"c7b4d8e3da35d63e5635a2f9cde98c92e47445a0ff8a9eea17eecd139bc0b745","pivot":[0.5,0.5]},"Hold":{"pathId":32,"name":"Hold","pixelsPerUnit":100.0,"rectangle":[0,50,989,1900],"sha256":"75443356e19a65dd27f66f67438a1c619fe17dc67d45993cc81e48b065b6d5e8","pivot":[0.5,0.0]},"HoldHead":{"pathId":40,"name":"Hold_Head","pixelsPerUnit":100.0,"rectangle":[0,0,989,50],"sha256":"0d87710ca022c239aa206a2b873bf6398a3b859fa35a6a5d4e210c02557f2563","pivot":[0.5,1.0]},"HoldEnd":{"pathId":38,"name":"Hold_End","pixelsPerUnit":100.0,"rectangle":[0,1950,989,50],"sha256":"9364757ecea95bd9de898a80a3e0b3d09b61c5cfb6c77ba80a7b85cf694080ea","pivot":[0.5,0.0]},"HoldHeadHL":{"pathId":27,"name":"Hold2HL_0","pixelsPerUnit":97.52066040039062,"rectangle":[0,0,1062,98],"sha256":"d74b84ff2ba1ad6ac04768dda0a81ce6151cca8793e65f9b5bd11f2fa33068b0","pivot":[0.5,1.0]},"HoldHL":{"pathId":45,"name":"Hold2HL_1","pixelsPerUnit":97.52066040039062,"rectangle":[0,98,1062,1853],"sha256":"1941cf1f65749491f5ac8df45127aea8ec2b27dd50974948e1cd5fea6250d8cf","pivot":[0.5,0.0]},"JudgeLine":{"pathId":44,"name":"JudgeLine","pixelsPerUnit":100.0,"rectangle":[0,267,1920,3],"sha256":"008448a666ebd28cd20f7684919c92741c603da0f3a77a9bef72707ecddf664f","pivot":[0.5,0.5]},"ProgressBar":{"pathId":36,"name":"Prograss bar打歌界面与暂停 素材_0","pixelsPerUnit":100.0,"rectangle":[1,1069,1919,11],"sha256":"5a9da99a9b216f3030c51b6771bc98f8c1b9757fe405afb47501b4fdcbfc977d","pivot":[1.0,1.0]},"Pause":{"pathId":39,"name":"Pause","pixelsPerUnit":100.0,"rectangle":[37,1001,37,41],"sha256":"8b7acff66c0a899a50df4c1edc8434ce2b40659836bf158dcb8b7e0d3192700c","pivot":[0.5,0.5]},"Retry":{"pathId":42,"name":"Retry","pixelsPerUnit":100.0,"rectangle":[922,533,76,76],"sha256":"66c10fd579164c7d08a24765a7272324cfc11d8e8eba6ee7da6edf4c2afad3f9","pivot":[0.5,0.5]},"Resume":{"pathId":43,"name":"Resume","pixelsPerUnit":100.0,"rectangle":[1218,533,76,76],"sha256":"18488b296b9ffeddcf6173b8fc5072ff8e0206309fdf9640e873cedb940c3a81","pivot":[0.5,0.5]},"Back":{"pathId":41,"name":"Back","pixelsPerUnit":100.0,"rectangle":[670,532,76,76],"sha256":"94b76cb9f93c81c0f26ac8902744c75b0b49b5ff4dd39044621c37f24d8ab977","pivot":[0.5,0.5]},"NoteRing":{"pathId":35,"name":"NoteRing","pixelsPerUnit":100.0,"rectangle":[0,0,512,512],"sha256":"f88ad3f4a0be00dea4cf5972eb7a27c375022b5ef6b418c83f3d240e9878ea2f","pivot":[0.5,0.5]}},"hitSounds":{"HitSong0":{"source":"sharedassets0.assets / sharedassets0.resource","sha256":"d0df93f0f5a281894a26889f81f3bce51aa6a03dfe7235bc51344df11a4de557","bytes":17320},"HitSong1":{"source":"sharedassets0.assets / sharedassets0.resource","sha256":"258247f3d052e06c337596e1b6ca2b914e73075a104c3937ea7f2b39b409d794","bytes":78528},"HitSong2":{"source":"sharedassets0.assets / sharedassets0.resource","sha256":"42c0244fbd35ccb1aae2ec787a09b6c1ba697d723f7cb0c4e3acded095761268","bytes":68792}},"hitAnimation":{"file":"sharedassets10.assets","texturePathId":6,"animationPathId":16,"name":"NewHitFx","frames":30,"fps":60,"duration":0.5,"sha256":"1ac6356ac66f0429abb88b1a0e42a1d5a7937a73d4304639224ccef57d42d762","originalFrameOrderVerified":true}}});
  const BUILTIN_DEFAULT_SETTINGS = {"noteScale":1,"noteSpeedScale":1.7647058823529411,"specialJudgeDelay":0,"judgeTimingLead":0,"touchSensitivity":1,"hitFxSizeScale":1.18,"hitSoundVolume":0.72,"autoplay":false,"invincibleMode":false,"lowResolution":false,"showFpsCounter":false};
  const KEYBOARD_RESERVED_CODES = new Set(["Escape", "Enter", "F1", "F2", "F3", "F11"]),
    KEYBOARD_MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);
  const FACTORY_DEFAULT_SETTINGS = Object.freeze({
    noteScale: 1,
    // sim-phi maps official floor distance to 60% of the viewport height.
    // This renderer's base unit is 34%, therefore the exact equivalent is
    // 0.60 / 0.34 = 1.7647058823529411 (176.47%).
    noteSpeedScale: 1.7647058823529411,
    specialJudgeDelay: 0,
    judgeTimingLead: 0,
    touchSensitivity: 1,
    hitFxSizeScale: 1.18,
    hitSoundVolume: 1,
    autoplay: false,
    invincibleMode: false,
    lowResolution: false,
    showFpsCounter: false,
  });
  function builtinDefault(key) {
    return Object.prototype.hasOwnProperty.call(
      BUILTIN_DEFAULT_SETTINGS || {},
      key,
    )
      ? BUILTIN_DEFAULT_SETTINGS[key]
      : FACTORY_DEFAULT_SETTINGS[key];
  }
  const builtinRecordCache = new Map();
  let builtinResourcePackCache = null,
    builtinResourcePackPromise = null,
    bootResourcePackPromise = null;
  let librarySearchQuery = "",
    libraryRenderToken = 0,
    librarySearchTimer = 0,
    libraryLoadedOnce = false,
    libraryDirty = true,
    libraryLastRenderedQuery = "";
  const librarySummaryCache = new Map(), scoreCache = new Map();
  const RULESET_VERSION = "phi-ruleset-55.0";
  let currentRecord = null,
    engine = null,
    firstPlayAudioPrime = null,
    activePack = null,
    lastToastTimer = 0,
    noteSizeScale = builtinDefault("noteScale"),
    noteSpeedScale = builtinDefault("noteSpeedScale"),
    noteSpeedExactPercent = "176.47058823529411764706",
    specialJudgeDelay = builtinDefault("specialJudgeDelay"),
    judgeTimingLead = builtinDefault("judgeTimingLead"),
    touchSensitivity = builtinDefault("touchSensitivity"),
    hitFxSizeScale = builtinDefault("hitFxSizeScale"),
    hitSoundVolume = builtinDefault("hitSoundVolume"),
    autoplayEnabled = !!builtinDefault("autoplay"),
    invincibleEnabled = !!builtinDefault("invincibleMode"),
    lowResolutionMode = !!builtinDefault("lowResolution"),
    fpsCounterEnabled = !!builtinDefault("showFpsCounter");
  const CHART_REVEAL_SCALE_MIN = 0.28,
    CHART_REVEAL_SCALE_MAX = 1,
    CHART_REVEAL_SCALE_DEFAULT = 0.62;
  let chartRevealEnabled = false,
    chartRevealScale = CHART_REVEAL_SCALE_DEFAULT,
    chartRevealEnabledSaveTimer = 0,
    chartRevealScaleSaveTimer = 0;

  function toast(msg, error = false, ms = 3400) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = error ? "show error" : "show";
    clearTimeout(lastToastTimer);
    lastToastTimer = setTimeout(() => (t.className = ""), ms);
  }
  let dialogReturnFocus = null;
  function showDialog(title, content, plain = false) {
    dialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    $("#dialogTitle").textContent = title;
    $("#dialogBody").innerHTML = plain ? '<div class="report"></div>' : content;
    if (plain) $("#dialogBody .report").textContent = content;
    $("#dialog").classList.remove("hidden");
    queueMicrotask(() => $("#dialog").querySelector("button,input,select,textarea,[tabindex]:not([tabindex='-1'])")?.focus());
  }
  function closeDialog() { $("#dialog").classList.add("hidden"); dialogReturnFocus?.focus?.(); dialogReturnFocus = null; }
  $("#dialogClose").onclick = closeDialog;
  const NOTE_SCALE_MIN = 0.25,
    NOTE_SCALE_MAX = 3.5,
    NOTE_SPEED_MIN = 0,
    NOTE_SPEED_MAX = 100,
    SPECIAL_JUDGE_MAX = 0.12,
    JUDGE_LEAD_MIN = -0.12,
    JUDGE_LEAD_MAX = 0.16,
    TOUCH_SENS_MIN = 0.8,
    TOUCH_SENS_MAX = 2.2,
    HIT_FX_SIZE_MIN = 0.8,
    HIT_FX_SIZE_MAX = 2.6,
    HIT_SOUND_MAX = 1.5,
    HIT_SOUND_OUTPUT_TRIM = 0.65,
    NOTE_THICKNESS_RATIO = 0.135,
    HOLD_WIDTH_RATIO = 1.1,
    FLICK_THICKNESS_GAIN = 1.18;
  let noteScaleSaveTimer = 0,
    speedScaleSaveTimer = 0,
    specialJudgeSaveTimer = 0,
    judgeTimingSaveTimer = 0,
    touchSensitivitySaveTimer = 0,
    hitFxSizeSaveTimer = 0,
    hitSoundSaveTimer = 0,
    lowResolutionSaveTimer = 0,
    fpsCounterSaveTimer = 0,
    previewRAF = 0,
    previewEpoch = 0,
    previewImpactCycle = -1,
    previewEffectAt = -Infinity,
    previewParticles = null;
  let latencyCal = null;
  function normalizedNoteScale(v) {
    return clamp(Number(v) || 1, NOTE_SCALE_MIN, NOTE_SCALE_MAX);
  }
  function normalizedNoteSpeed(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, n) : builtinDefault("noteSpeedScale");
  }
  const OFFICIAL_SPEED_PERCENT_EXACT = "176.47058823529411764706";
  function canonicalDecimalInput(value) {
    let source = String(value ?? "").trim().replace(/％|%|×/g, "");
    if (!/^\d+(?:\.\d*)?$/.test(source)) throw new Error("只能输入非负十进制数字");
    let [integer, fraction = ""] = source.split(".");
    integer = integer.replace(/^0+(?=\d)/, "") || "0";
    fraction = fraction.replace(/0+$/, "");
    return fraction ? `${integer}.${fraction}` : integer;
  }
  function skippedNoteJudgement(autoplay, invincible) {
    return autoplay || invincible ? 0 : 3;
  }
  function parseExactSpeedPercent(value) {
    let source;
    try { source = canonicalDecimalInput(value); }
    catch { throw new Error("流速只能包含非负十进制数字"); }
    let [integer, fraction = ""] = source.split(".");
    if (integer.length > 309 || fraction.length > 340)
      throw new Error("流速超出 Double 可提交范围");
    const exactInteger = BigInt(integer || "0"),
      exactFraction = BigInt(fraction || "0"),
      denominator = 10n ** BigInt(fraction.length),
      numerator = exactInteger * denominator + exactFraction,
      canonical = source,
      display = source,
      renderNumber = Number(canonical) / 100;
    if (!Number.isFinite(renderNumber)) throw new Error("流速超出 Canvas Double 范围");
    return { numerator, denominator, canonical, display, renderNumber };
  }
  function applyExactNoteSpeedPercent(value, save = true) {
    try {
      const exact = parseExactSpeedPercent(value);
      noteSpeedExactPercent = exact.display;
      applyNoteSpeed(exact.renderNumber, save, exact);
      return true;
    } catch (error) {
      toast(error.message || "流速格式无效");
      const out = $("#speedScaleValue");
      if (out) out.value = noteSpeedExactPercent;
      return false;
    }
  }
  function applyOfficialNoteSpeed() {
    return applyExactNoteSpeedPercent(OFFICIAL_SPEED_PERCENT_EXACT);
  }
  function normalizedSpecialJudgeDelay(v) {
    return clamp(Number(v) || 0, 0, SPECIAL_JUDGE_MAX);
  }
  function normalizedJudgeTimingLead(v) {
    const n = Number(v);
    return clamp(Number.isFinite(n) ? n : 0, JUDGE_LEAD_MIN, JUDGE_LEAD_MAX);
  }
  function normalizedTouchSensitivity(v) {
    const n = Number(v);
    return clamp(Number.isFinite(n) ? n : 1, TOUCH_SENS_MIN, TOUCH_SENS_MAX);
  }
  function normalizedHitFxSize(v) {
    const n = Number(v);
    return clamp(
      Number.isFinite(n) ? n : 1.18,
      HIT_FX_SIZE_MIN,
      HIT_FX_SIZE_MAX,
    );
  }
  function normalizedHitSoundVolume(v) {
    const n = Number(v);
    return clamp(Number.isFinite(n) ? n : 1, 0, HIT_SOUND_MAX);
  }
  function drawPreviewTap(c, x, y, nw, nh) {
    const img = activePack?.images?.tap,
      b = activePack?.imageBounds?.tap;
    c.save();
    c.translate(x, y);
    if (img) {
      const dh = normalizedTextureHeight(activePack, "tap", "tap", nh, nw);
      if (b) c.drawImage(img, b.sx, b.sy, b.sw, b.sh, -nw / 2, -dh / 2, nw, dh);
      else c.drawImage(img, -nw / 2, -dh / 2, nw, dh);
    } else drawDefaultBar(c, nw, nh, PHI_NOTE_COLORS.tap, PHI_NOTE_COLORS.tapGlow);
    c.restore();
  }
  function renderNotePreview(now = performance.now()) {
    const cv = $("#notePreview");
    if (!cv) return;
    const r = cv.getBoundingClientRect(),
      dpr = Math.min(4, devicePixelRatio || 1),
      w = Math.max(220, r.width || 300),
      h = Math.max(230, r.height || 270);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const c = cv.getContext("2d");
    c.imageSmoothingEnabled = true;
    try { c.imageSmoothingQuality = "high"; } catch {}
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const bg = c.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#12243a");
    bg.addColorStop(1, "#050a11");
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    if (!previewEpoch) previewEpoch = now;
    if (isPjskPreview()) { renderPjskPreview(c,w,h,now); return; }
    const lineY = h * 0.78;
    c.strokeStyle = "rgba(255,255,255,.90)";
    c.lineWidth = 3;
    c.shadowBlur = 10;
    c.shadowColor = "rgba(255,255,255,.35)";
    c.beginPath();
    c.moveTo(12, lineY);
    c.lineTo(w - 12, lineY);
    c.stroke();
    c.shadowBlur = 0;
    if (!previewEpoch) previewEpoch = now;
    const cycleMs = 1650,
      fallMs = 1050,
      total = now - previewEpoch,
      cycle = Math.max(0, Math.floor(total / cycleMs)),
      local = ((total % cycleMs) + cycleMs) % cycleMs;
    const previewPjsk = engine?.chart?.kind === "pjsk",
      previewLanes = Math.max(2, Number(engine?.chart?.pjskLaneCount) || PJSK_DEFAULT_LANES),
      base = Math.min(w * 0.34, h * 0.31),
      nw = previewPjsk ? Math.max(18, Math.min(w * 0.82 / previewLanes * 0.90, h * 0.18)) : Math.max(24, base * noteSizeScale),
      nh = Math.max(4, nw * NOTE_THICKNESS_RATIO),
      startY = Math.max(32, -nh),
      impactY = lineY;
    if (local >= fallMs && previewImpactCycle !== cycle) {
      previewImpactCycle = cycle;
      previewEffectAt = now;
      const fxSize = nw * hitFxSizeScale;
      previewParticles = createHitParticles(fxSize, false, null);
      playPackHitSound(activePack, "click", hitSoundVolume);
    }
    if (local < fallMs) {
      let u = clamp(local / fallMs, 0, 1);
      u = 1 - Math.pow(1 - u, 2.1);
      const y = startY + (impactY - startY) * u;
      drawPreviewTap(c, w / 2, y, nw, nh);
    }
    const fxAge = (now - previewEffectAt) / 1000;
    if (fxAge >= 0 && fxAge < hitFxDuration(activePack)) {
      const fxSize = nw * hitFxSizeScale;
      drawHitFxFrame(c, activePack, w / 2, impactY, fxSize, fxAge, false);
      drawHitParticles(
        c,
        {
          x: w / 2,
          y: impactY,
          size: fxSize,
          good: false,
          particles: previewParticles || [],
        },
        fxAge,
      );
    }
    c.fillStyle = "rgba(255,255,255,.84)";
    c.font = `12px "PhiEmbeddedSaira","PingFang SC","PhiCJK","Noto Sans CJK SC","Microsoft YaHei",sans-serif`;
    c.textAlign = "center";
    c.fillText(
      previewPjsk ? `PJSK Note AUTO · ${previewLanes}K · 流速 ${(noteSpeedScale * 100).toFixed(2).replace(/\.00$/, "")}%` : `Note ${Math.round(noteSizeScale * 100)}% · 流速 ${(noteSpeedScale * 100).toFixed(2).replace(/\.00$/, "")}%`,
      w / 2,
      18,
    );
    c.fillStyle = "rgba(255,227,117,.92)";
    c.fillText(
      `判定 ${judgeTimingLead >= 0 ? "+" : ""}${Math.round(judgeTimingLead * 1000)} ms · 灵敏 ${Math.round(touchSensitivity * 100)}%`,
      w / 2,
      h - 28,
    );
    c.fillText(
      `特效 ${Math.round(hitFxSizeScale * 100)}% · 音效 ${Math.round(hitSoundVolume * 100)}%`,
      w / 2,
      h - 12,
    );
  }
  function previewLoop(now) {
    renderNotePreview(now);
    if (!$("#settingsPanel")?.classList.contains("hidden"))
      previewRAF = requestAnimationFrame(previewLoop);
    else previewRAF = 0;
  }
  function startNotePreview() {
    if (previewRAF) cancelAnimationFrame(previewRAF);
    previewEpoch = performance.now();
    previewImpactCycle = -1;
    previewEffectAt = -Infinity;
    previewParticles = null;
    try {
      Engine.sharedAudioContext().resume();
    } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
    previewRAF = requestAnimationFrame(previewLoop);
  }
  function stopNotePreview() {
    if (previewRAF) cancelAnimationFrame(previewRAF);
    previewRAF = 0;
  }
  function drawNotePreview() {
    renderNotePreview(performance.now());
  }
  function syncPjskAutoNoteSizeUI() {
    const slider = $("#noteSizeRange"), out = $("#noteScaleValue"),
      active = isPjskPreview(), lanes = Math.max(2, Number(engine?.chart?.kind === "pjsk" ? engine.chart.pjskLaneCount : 12) || PJSK_DEFAULT_LANES);
    if (slider) {
      slider.disabled = !!active;
      slider.setAttribute("aria-disabled", active ? "true" : "false");
      slider.title = active ? "PJSK 模式按轨宽自动适配 Note 大小" : "";
    }
    if (out) out.textContent = active ? `AUTO · ${lanes}K` : `${Math.round(noteSizeScale * 100)}%`;
  }
  function applyNoteScale(v, save = true) {
    noteSizeScale = normalizedNoteScale(v);
    const slider = $("#noteSizeRange"),
      out = $("#noteScaleValue");
    if (slider) slider.value = String(Math.round(noteSizeScale * 100));
    if (out) out.textContent = `${Math.round(noteSizeScale * 100)}%`;
    syncPjskAutoNoteSizeUI();
    drawNotePreview();
    if (engine) {
      engine.prepareNoteGeometry?.();
      engine.scheduleRenderIndexRebuild?.();
      if (engine.running) engine.draw(engine.time);
    }
    if (save && storageReady) {
      clearTimeout(noteScaleSaveTimer);
      noteScaleSaveTimer = setTimeout(
        () =>
          dbPutSetting({ key: "noteScale", value: noteSizeScale }).catch(
            () => {},
          ),
        120,
      );
    }
  }
  function applyNoteSpeed(v, save = true, exactValue = null) {
    noteSpeedScale = normalizedNoteSpeed(v);
    const slider = $("#speedScaleRange"),
      out = $("#speedScaleValue");
    const percent = noteSpeedScale * 100;
    if (slider) slider.value = String(clamp(Number(percent), 0, 300));
    if (exactValue) noteSpeedExactPercent = exactValue.display;
    else noteSpeedExactPercent = parseExactSpeedPercent(String(percent)).display;
    if (out) out.value = noteSpeedExactPercent;
    drawNotePreview();
    if (engine) {
      engine.scheduleRenderIndexRebuild?.();
      if (engine.running) engine.draw(engine.time);
    }
    if (save && storageReady) {
      clearTimeout(speedScaleSaveTimer);
      speedScaleSaveTimer = setTimeout(
        () => dbPutSetting({ key: "noteSpeedExactPercent", value: noteSpeedExactPercent }).catch(() => {}),
        120,
      );
    }
  }
  function applySpecialJudgeDelay(v, save = true) {
    specialJudgeDelay = normalizedSpecialJudgeDelay(v);
    const slider = $("#specialJudgeRange"),
      out = $("#specialJudgeValue");
    if (slider) slider.value = String(Math.round(specialJudgeDelay * 1000));
    if (out) out.textContent = `${Math.round(specialJudgeDelay * 1000)} ms`;
    drawNotePreview();
    if (save && storageReady) {
      clearTimeout(specialJudgeSaveTimer);
      specialJudgeSaveTimer = setTimeout(
        () =>
          dbPutSetting({
            key: "specialJudgeDelay",
            value: specialJudgeDelay,
          }).catch(() => {}),
        120,
      );
    }
  }
  function applyJudgeTimingLead(v, save = true) {
    judgeTimingLead = normalizedJudgeTimingLead(v);
    const slider = $("#judgeTimingRange"),
      out = $("#judgeTimingValue"),
      ms = Math.round(judgeTimingLead * 1000);
    if (slider) slider.value = String(ms);
    if (out) out.textContent = `${ms >= 0 ? "+" : ""}${ms} ms`;
    drawNotePreview();
    if (save && storageReady) {
      clearTimeout(judgeTimingSaveTimer);
      judgeTimingSaveTimer = setTimeout(
        () =>
          dbPutSetting({
            key: "judgeTimingLead",
            value: judgeTimingLead,
          }).catch(() => {}),
        120,
      );
    }
  }
  function applyTouchSensitivity(v, save = true) {
    touchSensitivity = normalizedTouchSensitivity(v);
    const slider = $("#touchSensitivityRange"),
      out = $("#touchSensitivityValue");
    if (slider) slider.value = String(Math.round(touchSensitivity * 100));
    if (out) out.textContent = `${Math.round(touchSensitivity * 100)}%`;
    drawNotePreview();
    if (save && storageReady) {
      clearTimeout(touchSensitivitySaveTimer);
      touchSensitivitySaveTimer = setTimeout(
        () =>
          dbPutSetting({
            key: "touchSensitivity",
            value: touchSensitivity,
          }).catch(() => {}),
        120,
      );
    }
  }
  function applyHitFxSize(v, save = true) {
    hitFxSizeScale = normalizedHitFxSize(v);
    const slider = $("#hitFxSizeRange"),
      out = $("#hitFxSizeValue");
    if (slider) slider.value = String(Math.round(hitFxSizeScale * 100));
    if (out) out.textContent = `${Math.round(hitFxSizeScale * 100)}%`;
    drawNotePreview();
    if (save && storageReady) {
      clearTimeout(hitFxSizeSaveTimer);
      hitFxSizeSaveTimer = setTimeout(
        () =>
          dbPutSetting({ key: "hitFxSizeScale", value: hitFxSizeScale }).catch(
            () => {},
          ),
        120,
      );
    }
  }
  function applyHitSoundVolume(v, save = true) {
    hitSoundVolume = normalizedHitSoundVolume(v);
    const slider = $("#hitSoundVolumeRange"),
      out = $("#hitSoundVolumeValue");
    if (slider) slider.value = String(Math.round(hitSoundVolume * 100));
    if (out) out.textContent = `${Math.round(hitSoundVolume * 100)}%`;
    drawNotePreview();
    if (save && storageReady) {
      clearTimeout(hitSoundSaveTimer);
      hitSoundSaveTimer = setTimeout(
        () =>
          dbPutSetting({ key: "hitSoundVolume", value: hitSoundVolume }).catch(
            () => {},
          ),
        120,
      );
    }
  }
  function applyLowResolutionMode(v, save = true) {
    lowResolutionMode = !!v;
    const toggle = $("#lowResolutionToggle"),
      state = $("#lowResolutionState");
    if (toggle) toggle.checked = lowResolutionMode;
    if (state) state.textContent = lowResolutionMode ? "开启" : "关闭";
    if (engine) {
      engine.renderQuality = engine.isAppleTouch ? engine.appleQualityCeiling : 1;
      engine.pendingResolution = false;
      engine.applyCanvasResolution();
      if (engine.running) engine.draw(engine.time);
    }
    if (save && storageReady) {
      clearTimeout(lowResolutionSaveTimer);
      lowResolutionSaveTimer = setTimeout(
        () =>
          dbPutSetting({
            key: "lowResolution",
            value: lowResolutionMode,
          }).catch(() => {}),
        120,
      );
    }
  }
  function applyFpsCounterEnabled(v, save = true) {
    fpsCounterEnabled = !!v;
    const toggle = $("#fpsCounterToggle"),
      state = $("#fpsCounterState");
    if (toggle) toggle.checked = fpsCounterEnabled;
    if (state) state.textContent = fpsCounterEnabled ? "开启" : "关闭";
    performanceMonitor.setMiniEnabled(fpsCounterEnabled);
    if (save && storageReady) {
      clearTimeout(fpsCounterSaveTimer);
      fpsCounterSaveTimer = setTimeout(
        () => dbPutSetting({ key: "showFpsCounter", value: fpsCounterEnabled }).catch(() => {}),
        120,
      );
    }
  }

  function audioContextToPerf(ac, ctxTime) {
    try {
      const ts = ac.getOutputTimestamp?.();
      if (
        ts &&
        Number.isFinite(ts.contextTime) &&
        Number.isFinite(ts.performanceTime)
      )
        return ts.performanceTime + (ctxTime - ts.contextTime) * 1000;
    } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
    return performance.now() + (ctxTime - ac.currentTime) * 1000;
  }
  function setLatencyBeatVisual(beat = -1, down = false) {
    document.querySelectorAll(".beatDot").forEach((el, i) => {
      el.classList.toggle("on", i === beat);
      el.classList.toggle("down", i === beat && down);
    });
  }
  function setLatencyResult(index, value) {
    const el = $(`#latencyR${index}`);
    if (el)
      el.textContent = Number.isFinite(value)
        ? `${value >= 0 ? "+" : ""}${Math.round(value)} ms`
        : "—";
  }
  function resetLatencyUI() {
    for (let i = 0; i < 4; i++) setLatencyResult(i, NaN);
    setLatencyBeatVisual(-1);
    const tap = $("#latencyTapBtn");
    if (tap) {
      tap.disabled = true;
      tap.classList.remove("ready");
      tap.textContent = "每小节第一拍按这里";
    }
    const st = $("#latencyState");
    if (st) st.textContent = "未开始";
    const avg = $("#latencyAverage");
    if (avg)
      avg.innerHTML =
        "固定为 100 BPM、4/4 拍。开始后先播放一个预备小节，随后连续四个测试小节；听到每个小节的第一拍时立即按下右侧按钮。四次偏差的算术平均值会自动写入“全局判定校准”。";
  }
  function stopLatencyCalibration(resumePreview = true) {
    const c = latencyCal;
    if (c) {
      c.cancelled = true;
      for (const n of c.nodes || [])
        try {
          n.stop();
        } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      for (const id of c.timers || []) clearTimeout(id);
      if (c.raf) cancelAnimationFrame(c.raf);
    }
    latencyCal = null;
    const start = $("#latencyStartBtn"),
      tap = $("#latencyTapBtn");
    if (start) start.textContent = "开始四小节测试";
    if (tap) {
      tap.disabled = true;
      tap.classList.remove("ready");
    }
    setLatencyBeatVisual(-1);
    if (resumePreview && !$("#settingsPanel")?.classList.contains("hidden"))
      startNotePreview();
  }
  function scheduleMetronomeClick(ac, when, accent, nodes) {
    const osc = ac.createOscillator(),
      gain = ac.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(accent ? 1120 : 760, when);
    gain.gain.setValueAtTime(0.0001, Math.max(ac.currentTime, when - 0.005));
    gain.gain.exponentialRampToValueAtTime(accent ? 0.2 : 0.095, when + 0.003);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      when + (accent ? 0.085 : 0.055),
    );
    osc.connect(gain).connect(ac.destination);
    osc.start(when);
    osc.stop(when + 0.11);
    nodes.push(osc);
  }
  async function startLatencyCalibration() {
    stopLatencyCalibration(false);
    stopNotePreview();
    resetLatencyUI();
    const ac = Engine.sharedAudioContext();
    try {
      await ac.resume();
    } catch (e) {
      toast("无法启动 Web Audio：" + e.message, true);
      startNotePreview();
      return;
    }
    const bpm = 100,
      beatDur = 60 / bpm,
      startCtx = ac.currentTime + 0.55,
      leadMeasures = 1,
      testMeasures = 4,
      totalBeats = (leadMeasures + testMeasures) * 4,
      nodes = [],
      timers = [];
    const targets = Array.from(
      { length: testMeasures },
      (_, i) => startCtx + (leadMeasures * 4 + i * 4) * beatDur,
    );
    const c = (latencyCal = {
      ac,
      bpm,
      beatDur,
      startCtx,
      targets,
      results: [],
      nodes,
      timers,
      raf: 0,
      cancelled: false,
      nextTarget: 0,
    });
    const start = $("#latencyStartBtn"),
      tap = $("#latencyTapBtn"),
      st = $("#latencyState"),
      avg = $("#latencyAverage");
    if (start) start.textContent = "重新开始";
    if (tap) {
      tap.disabled = false;
      tap.classList.add("ready");
      tap.textContent = "第一拍到了就按下";
    }
    if (st) st.textContent = "预备 4 拍";
    if (avg)
      avg.innerHTML =
        "请只听节拍器，预备小节之后，每逢<strong>第一拍</strong>按一次。按钮使用 pointerdown 记录，避免 click 事件额外延迟。";
    for (let i = 0; i < totalBeats; i++) {
      const when = startCtx + i * beatDur,
        beat = i % 4,
        measure = Math.floor(i / 4),
        accent = beat === 0;
      scheduleMetronomeClick(ac, when, accent, nodes);
      const perf = audioContextToPerf(ac, when),
        id = setTimeout(
          () => {
            if (!latencyCal || latencyCal !== c || c.cancelled) return;
            setLatencyBeatVisual(beat, accent);
            if (st) {
              if (measure < leadMeasures) st.textContent = `预备 ${beat + 1}/4`;
              else
                st.textContent = `测试 ${Math.min(testMeasures, measure - leadMeasures + 1)}/4 · 第 ${beat + 1} 拍`;
            }
            setTimeout(() => {
              if (latencyCal === c) setLatencyBeatVisual(-1);
            }, 120);
          },
          Math.max(0, perf - performance.now()),
        );
      timers.push(id);
    }
    const endPerf =
      audioContextToPerf(ac, startCtx + totalBeats * beatDur) + 700;
    timers.push(
      setTimeout(
        () => {
          if (latencyCal !== c) return;
          if (c.results.length < 4) {
            if (st) st.textContent = `仅记录 ${c.results.length}/4`;
            if (avg)
              avg.innerHTML = `有 ${4 - c.results.length} 次没有记录到，请点击“重新开始”再测一次。`;
            if (tap) {
              tap.disabled = true;
              tap.classList.remove("ready");
            }
          }
        },
        Math.max(0, endPerf - performance.now()),
      ),
    );
  }
  function recordLatencyTap(e) {
    e?.preventDefault?.();
    const c = latencyCal;
    if (!c || c.cancelled || c.nextTarget >= 4) return;
    const perf = performance.now(),
      targetCtx = c.targets[c.nextTarget],
      targetPerf = audioContextToPerf(c.ac, targetCtx),
      offset = perf - targetPerf;
    if (offset < -320) {
      const st = $("#latencyState");
      if (st) st.textContent = "还没到第一拍";
      return;
    }
    if (offset > 700) {
      const st = $("#latencyState");
      if (st) st.textContent = "这次太晚，请在下一小节第一拍按";
      return;
    }
    const idx = c.nextTarget;
    c.results.push(offset);
    c.nextTarget++;
    setLatencyResult(idx, offset);
    const st = $("#latencyState");
    if (st) st.textContent = `已记录 ${c.results.length}/4`;
    const tap = $("#latencyTapBtn");
    if (tap) {
      tap.animate?.(
        [
          { transform: "scale(1)" },
          { transform: "scale(.96)" },
          { transform: "scale(1)" },
        ],
        { duration: 120 },
      );
      tap.textContent =
        c.results.length < 4 ? "等待下一小节第一拍" : "计算完成";
    }
    if (c.results.length === 4) {
      const mean = c.results.reduce((a, b) => a + b, 0) / 4,
        applied = clamp(mean, JUDGE_LEAD_MIN * 1000, JUDGE_LEAD_MAX * 1000);
      applyJudgeTimingLead(applied / 1000, true);
      if (st) st.textContent = "校准完成";
      const avg = $("#latencyAverage");
      if (avg)
        avg.innerHTML = `四次平均偏差：<b>${mean >= 0 ? "+" : ""}${Math.round(mean)} ms</b>。已写入全局判定校准：<b>${applied >= 0 ? "+" : ""}${Math.round(applied)} ms</b>${Math.abs(applied - mean) > 0.5 ? "（受滑块范围限制）" : ""}。`;
      if (tap) {
        tap.disabled = true;
        tap.classList.remove("ready");
      }
      for (const id of c.timers) clearTimeout(id);
      c.timers = [];
      setTimeout(() => {
        if (latencyCal === c) stopLatencyCalibration(true);
      }, 700);
    }
  }
  function openSettingsPanel() {
    const p = $("#settingsPanel");
    p.classList.remove("hidden");
    applyNoteScale(noteSizeScale, false);
    syncPjskAutoNoteSizeUI();
    applyExactNoteSpeedPercent(noteSpeedExactPercent);
    applySpecialJudgeDelay(specialJudgeDelay, false);
    applyJudgeTimingLead(judgeTimingLead, false);
    applyTouchSensitivity(touchSensitivity, false);
    applyHitFxSize(hitFxSizeScale, false);
    applyHitSoundVolume(hitSoundVolume, false);
    applyLowResolutionMode(lowResolutionMode, false);
    applyFpsCounterEnabled(fpsCounterEnabled, false);
    refreshInvincibleUI();
    resetLatencyUI();
    startNotePreview();
  }
  function closeSettingsPanel() {
    stopLatencyCalibration(false);
    $("#settingsPanel").classList.add("hidden");
    stopNotePreview();
  }
  function syncAutoplayHud(on) {
    const invincibleHidden = !!engine?.invincibleMode &&
        Number(engine?.invincibleFeedbackKind || 0) === 2 &&
        performance.now() < Number(engine?.invincibleFeedbackUntil || 0),
      visible = Number(engine?.combo) > 2 && !invincibleHidden;
    for (const id of ["#comboHud", "#innerComboHud"]) {
      const hud = $(id);
      if (!hud) continue;
      hud.classList.toggle("autoplay", !!on);
      hud.style.opacity = visible ? "1" : "0";
      const number = hud.querySelector(".comboNumber"),
        label = hud.querySelector(".comboLabel");
      if (number) number.style.display = "block";
      if (label) {
        label.style.display = "block";
        label.textContent = on ? "AUTOPLAY" : "COMBO";
      }
    }
  }
  function refreshAutoplayUI() {
    const on = !!autoplayEnabled,
      pb = $("#pauseAutoBtn");
    if (pb) {
      pb.textContent = `Autoplay：${on ? "开启" : "关闭"}`;
      pb.classList.toggle("active", on);
      pb.setAttribute("aria-pressed", String(on));
    }
    syncAutoplayHud(on);
  }
  function setAutoplayEnabled(value, save = true, notify = true) {
    autoplayEnabled = !!value;
    engine?.setAutoplay(autoplayEnabled);
    refreshAutoplayUI();
    syncAssistIndicators(engine);
    if (save && storageReady)
      dbPutSetting({ key: "autoplay", value: autoplayEnabled }).catch(() => {});
    if (notify)
      toast(
        autoplayEnabled
          ? "Autoplay 已开启：所有真实 Note 将自动 Perfect"
          : "Autoplay 已关闭：恢复手动判定",
      );
  }
  function toggleAutoplay() {
    setAutoplayEnabled(!autoplayEnabled);
  }

  function refreshInvincibleUI() {
    const on = !!invincibleEnabled,
      pb = $("#pauseInvincibleBtn"),
      toggle = $("#invincibleToggle"),
      state = $("#invincibleState");
    if (pb) {
      pb.textContent = `无敌模式：${on ? "开启" : "关闭"}`;
      pb.classList.toggle("active", on);
      pb.setAttribute("aria-pressed", String(on));
    }
    if (toggle) toggle.checked = on;
    if (state) state.textContent = on ? "开启" : "关闭";
  }
  function setInvincibleEnabled(value, save = true, notify = true) {
    invincibleEnabled = !!value;
    engine?.setInvincible(invincibleEnabled);
    refreshInvincibleUI();
    syncAssistIndicators(engine);
    if (save && storageReady)
      dbPutSetting({ key: "invincibleMode", value: invincibleEnabled }).catch(() => {});
    if (notify)
      toast(invincibleEnabled
        ? "无敌模式已开启：默认金线；Good 蓝线一秒，断连白线并隐藏 Combo 一秒；结算固定满分"
        : "无敌模式已关闭：恢复真实计分与 Combo");
  }
  function toggleInvincible() {
    setInvincibleEnabled(!invincibleEnabled);
  }

  function uid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  function basename(p) {
    return p.replace(/\\/g, "/").split("/").pop();
  }
  function ext(p) {
    const m = p.match(/\.([^.\/]+)$/);
    return m ? m[1].toLowerCase() : "";
  }
  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }
  function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  function safeCanvasDimension(value, fallback = 1, max = 16384) {
    const number = finiteNumber(value, fallback);
    return Math.max(1, Math.min(max, Math.round(number > 0 ? number : fallback)));
  }
  function normalizedChartRevealScale(v) {
    const n = Number(v);
    return clamp(
      Number.isFinite(n) ? n : CHART_REVEAL_SCALE_DEFAULT,
      CHART_REVEAL_SCALE_MIN,
      CHART_REVEAL_SCALE_MAX,
    );
  }
  function syncChartRevealUI() {
    const btn = $("#pauseRevealBtn"),
      box = $("#revealScaleBox"),
      range = $("#revealScaleRange"),
      out = $("#revealScaleValue"),
      panel = $("#pausePanel");
    if (btn) {
      btn.textContent = chartRevealEnabled
        ? "谱面揭秘：开启"
        : "谱面揭秘：关闭";
      btn.classList.toggle("active", chartRevealEnabled);
    }
    box?.classList.toggle("hidden", !chartRevealEnabled);
    panel?.classList.toggle("revealPreview", chartRevealEnabled);
    if (range) range.value = String(Math.round(chartRevealScale * 100));
    if (out) out.textContent = `${Math.round(chartRevealScale * 100)}%`;
  }
  function refreshChartRevealView(rebuild = false) {
    if (!engine) return;
    engine.updateViewport();
    if (rebuild) engine.scheduleRenderIndexRebuild?.();
    if (engine.running || engine.paused) engine.draw(engine.time);
  }
  function applyChartRevealEnabled(value, save = true) {
    chartRevealEnabled = !!value;
    if (engine && chartRevealEnabled) engine.usedReveal = true;
    syncAssistIndicators(engine);
    syncChartRevealUI();
    if (engine?.layoutLocked) {
      try {
        engine.reflowLayout();
        if (engine.running || engine.paused) engine.draw(engine.time);
      }
      catch (error) {
        Diagnostics.warn("RenderEngine.reveal", error?.message || String(error));
        refreshChartRevealView(true);
      }
    } else refreshChartRevealView(true);
    if (save && storageReady) {
      clearTimeout(chartRevealEnabledSaveTimer);
      chartRevealEnabledSaveTimer = setTimeout(
        () =>
          dbPutSetting({
            key: "chartRevealEnabled",
            value: chartRevealEnabled,
          }).catch(() => {}),
        100,
      );
    }
  }
  function applyChartRevealScale(value, save = true) {
    chartRevealScale = normalizedChartRevealScale(value);
    syncChartRevealUI();
    refreshChartRevealView(true);
    if (save && storageReady) {
      clearTimeout(chartRevealScaleSaveTimer);
      chartRevealScaleSaveTimer = setTimeout(
        () =>
          dbPutSetting({
            key: "chartRevealScale",
            value: chartRevealScale,
          }).catch(() => {}),
        120,
      );
    }
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function fmtScore(n) {
    return String(Math.max(0, Math.round(n))).padStart(7, "0");
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function isPortraitLayout() {
    const vv = window.visualViewport,
      w = Number(vv?.width) || window.innerWidth || 0,
      h = Number(vv?.height) || window.innerHeight || 0;
    return window.matchMedia?.("(orientation: portrait)")?.matches || h > w;
  }

  let audioCrcTable = null;
  function crc32Table() {
    if (audioCrcTable) return audioCrcTable;
    audioCrcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      audioCrcTable[i] = c >>> 0;
    }
    return audioCrcTable;
  }

  function crc32Bytes(bytes) {
    const table = crc32Table();
    let crc = 0xffffffff;
    for (let i=0;i<bytes.length;i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  function safeArchivePath(name) {
    const source = String(name || "").normalize("NFC").replace(/\\/g, "/");
    if (!source || source.length > 1024 || source.startsWith("/") || source.startsWith("//") || /^[A-Za-z]:/.test(source) || /[\0-\x1f\x7f]/.test(source)) return null;
    const parts = [];
    for (const part of source.split("/")) {
      if (!part || part === "." || part === ".." || part.length > 255 || /[. ]$/.test(part) || WINDOWS_RESERVED_NAME.test(part)) return null;
      parts.push(part);
    }
    const clean = parts.join("/");
    if (!clean || clean.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/i.test(clean)) return null;
    return clean;
  }

  async function sha256Blob(blob) {
    if (!(blob instanceof Blob)) throw new Error("SHA-256 输入不是 Blob");
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  async function sha256Text(text) {
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(String(text)));
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  function canonicalJSONString(value) {
    if (Array.isArray(value)) return "[" + value.map(canonicalJSONString).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJSONString(value[key])).join(",") + "}";
    return JSON.stringify(value);
  }
  function canonicalChartText(text) {
    const normalized = String(text || "").replace(/\r\n?/g, "\n").trim();
    try { return canonicalJSONString(JSON.parse(normalized)); } catch { return normalized; }
  }
  async function audioContentSignature(blob) {
    if (!blob) return "";
    return `sha256:${await sha256Blob(blob)}:${blob.size}`;
  }

  async function crc32Blob(blob, progress) {
    const source = blob instanceof Blob ? blob : new Blob([blob]),
      table = crc32Table(),
      chunkSize = 1024 * 1024;
    let crc = 0xffffffff, done = 0;
    for (let off = 0; off < source.size; off += chunkSize) {
      const bytes = new Uint8Array(await source.slice(off, Math.min(source.size, off + chunkSize)).arrayBuffer());
      for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
      done += bytes.length;
      progress?.(done, source.size);
      if (((off / chunkSize) & 3) === 3) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function zipDosDateTime(value) {
    const d = value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date(),
      year = clamp(d.getFullYear(), 1980, 2107),
      date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    return { date, time };
  }
  function zipHeader(size) {
    return new Uint8Array(size);
  }
  function safeExportStem(value, fallback = "Phigros_Chart") {
    let source = String(value || "");
    try { source = source.normalize("NFKC"); } catch {}
    const cleaned = source
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
    return (cleaned || fallback).slice(0, 120);
  }
  function uniqueArchiveName(name, used) {
    const safe = safeArchivePath(name) || safeExportStem(basename(String(name || "file.bin")), "file.bin"),
      lower = safe.toLowerCase();
    if (!used.has(lower)) { used.add(lower); return safe; }
    const slash = safe.lastIndexOf("/"), dir = slash >= 0 ? safe.slice(0, slash + 1) : "",
      file = slash >= 0 ? safe.slice(slash + 1) : safe,
      dot = file.lastIndexOf("."), stem = dot > 0 ? file.slice(0, dot) : file,
      suffix = dot > 0 ? file.slice(dot) : "";
    let n = 2, candidate;
    do candidate = `${dir}${stem}_${n++}${suffix}`; while (used.has(candidate.toLowerCase()));
    used.add(candidate.toLowerCase());
    return candidate;
  }
  async function buildStoredZip(entries, onProgress) {
    const files = [], used = new Set();
    let totalData = 0;
    for (const entry of entries || []) {
      if (!entry?.blob) continue;
      const blob = entry.blob instanceof Blob ? entry.blob : new Blob([entry.blob]),
        name = uniqueArchiveName(entry.name || "file.bin", used);
      if (blob.size > 0xffffffff) throw new Error(`单个导出文件超过 ZIP32 上限：${name}`);
      totalData += blob.size;
      if (totalData > 0xffffffff) throw new Error("导出谱面包超过 ZIP32 的 4 GiB 上限");
      files.push({ name, blob, date: entry.date || new Date() });
    }
    if (!files.length) throw new Error("没有可导出的谱面文件");
    const locals = [], centrals = [];
    let offset = 0, centralSize = 0, completed = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i], nameBytes = enc.encode(file.name), dt = zipDosDateTime(file.date),
        crc = await crc32Blob(file.blob), size = file.blob.size,
        local = zipHeader(30 + nameBytes.length), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true); lv.setUint16(10, dt.time, true); lv.setUint16(12, dt.date, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true); local.set(nameBytes, 30);
      const central = zipHeader(46 + nameBytes.length), cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, dt.time, true); cv.setUint16(14, dt.date, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      locals.push(local, file.blob); centrals.push(central);
      offset += local.byteLength + size; centralSize += central.byteLength; completed += size;
      onProgress?.(i + 1, files.length, completed, totalData, file.name);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (files.length > 0xffff) throw new Error("导出文件数量超过 ZIP32 上限");
    const eocd = zipHeader(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
    return new Blob([...locals, ...centrals, eocd], { type: "application/zip" });
  }
  function yamlQuoted(value) { return JSON.stringify(String(value ?? "")); }
  function exportInfoYAML(record, chartName, audioName, bgName) {
    const meta = record?.meta || {}, lines = [
      `name: ${yamlQuoted(record?.name || meta.name || "未命名曲目")}`,
      `composer: ${yamlQuoted(meta.composer || "")}`,
      `charter: ${yamlQuoted(meta.charter || "")}`,
      `illustrator: ${yamlQuoted(meta.illustrator || "")}`,
      `level: ${yamlQuoted(meta.level ?? "")}`,
      `difficultyClass: ${yamlQuoted(meta.difficultyClass || "")}`,
      `chart: ${yamlQuoted(chartName)}`,
      `music: ${yamlQuoted(audioName)}`,
      `illustration: ${yamlQuoted(bgName || "")}`,
      `format: ${yamlQuoted(record?.parser || meta.format || "")}`,
      `aspectRatio: ${Number(meta.aspectRatio) || 16 / 9}`,
      `backgroundDim: ${Number.isFinite(Number(meta.backgroundDim)) ? Number(meta.backgroundDim) : 0.55}`,
      `lineLength: ${Number(meta.lineLength) || 6}`,
      `holdPartialCover: ${meta.holdPartialCover ? "true" : "false"}`,
    ];
    return `${lines.join("\n")}\n`;
  }
  function exportPackageEntries(record) {
    if (!record?.chartText || !record?.audioBlob) throw new Error("谱面记录缺少谱面文本或音乐，无法导出");
    const used = new Set(), entries = [], add = (name, blob) => {
      if (!blob) return "";
      const finalName = uniqueArchiveName(name, used);
      entries.push({ name: finalName, blob });
      return finalName;
    },
      parserExt = record.parser === "pec" ? ".pec" : ".json",
      chartName = add(record.chartFileName || `chart${parserExt}`, new Blob([record.chartText], { type: "application/json;charset=utf-8" })),
      audioName = add(record.audioName || "music.ogg", record.audioBlob),
      bgName = record.bgBlob ? add(record.bgName || "illustration.png", record.bgBlob) : "";
    if (record.extraText) add("extra.json", new Blob([record.extraText], { type: "application/json;charset=utf-8" }));
    for (const asset of record.assets || []) {
      const normalized = safeArchivePath(asset?.name || "");
      if (!normalized || used.has(normalized.toLowerCase())) continue;
      add(normalized, asset.blob);
    }
    // Supplemental input files are intentionally excluded. Export is a strict
    // per-chart whitelist to prevent other songs, keys, or databases leaking.
    entries.unshift({ name: "info.yml", blob: new Blob([exportInfoYAML(record, chartName, audioName, bgName)], { type: "text/yaml;charset=utf-8" }) });
    return entries;
  }
  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function resolveExportRecord(item) {
    const c = libraryPayload(item);
    if(c?.builtinEntryId)return materializeBuiltinPack(BUILTIN_PACKS.find(entry=>entry.id===c.builtinEntryId));
    return item?.builtin ? await materializeBuiltinPack(c) : await resolvePlayableRecord(c);
  }
  async function exportChartDifficulty(item, button) {
    const c = libraryPayload(item), original = button?.textContent || "导出 ZIP";
    try {
      if (button) { button.disabled = true; button.textContent = "准备…"; }
      const record = await resolveExportRecord(item), entries = exportPackageEntries(record),
        zip = await buildStoredZip(entries, (done, total) => {
          if (button) button.textContent = `打包 ${done}/${total}`;
        }),
        filename = `${safeExportStem(record.name)}_${safeExportStem(difficultyInfoFor(record).caption, "Lv")}.zip`;
      triggerBlobDownload(zip, filename);
      toast(`已导出：${filename}\n${entries.length} 个文件 · ${(zip.size / 1024 / 1024).toFixed(1)} MiB`, false, 6500);
    } catch (error) {
      Diagnostics.error("Library.export", error, { id: c.id || c.sourceName });
      toast(`导出失败：${error.message || error}`, true, 8000);
    } finally {
      if (button) { button.disabled = false; button.textContent = original; }
    }
  }

  function normalizedSongName(v) {
    return (
      String(v || "")
        .normalize?.("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase() ||
      String(v || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase()
    );
  }
  function archivePathParts(value) {
    return String(value || "")
      .replace(/\\/g, "/")
      .split(/\s*(?:›|→|⇒|⟶|->)\s*/u)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  function stripArchiveExtension(value) {
    return basename(String(value || "").replace(/\\/g, "/"))
      .replace(/\.[^./]+$/, "")
      .trim();
  }
  function innermostArchiveSongName(sourceName, chartFileName = "") {
    const parts = archivePathParts(sourceName),
      leaf = stripArchiveExtension(parts[parts.length - 1] || sourceName);
    if (leaf && !/^(?:uploaded|loose-files|archive|谱面包)$/i.test(leaf)) return leaf;
    const chartStem = basename(String(chartFileName || ""))
      .replace(/\.(?:json|pec|txt)$/i, "")
      .trim();
    return chartStem || leaf || "未命名曲目";
  }
  function legacyArchiveFallbackName(sourceName) {
    return basename(String(sourceName || "")).replace(/\.[^.]+$/, "").trim();
  }
  function repairedImportedSongName(record) {
    const current = String(record?.name || "").trim(),
      sourceName = String(record?.sourceName || ""),
      legacy = legacyArchiveFallbackName(sourceName),
      hasArchiveChain = archivePathParts(sourceName).length > 1;
    if (!current || (hasArchiveChain && current === legacy))
      return innermostArchiveSongName(sourceName, record?.chartFileName);
    return current;
  }
  async function repairLegacyArchiveRecordNames(records) {
    let changed = 0;
    for (const record of records || []) {
      const fixed = repairedImportedSongName(record);
      if (!fixed || fixed === record.name) continue;
      record.name = fixed;
      await dbPutChart(record);
      changed++;
    }
    if (changed) Diagnostics.info("Library.nameMigration", `已修复 ${changed} 个递归 ZIP 曲名`, { changed });
    return changed;
  }
  function applyLibraryCardTitle(title, value) {
    const name = String(value || "未命名曲目").trim() || "未命名曲目",
      length = [...name].length;
    title.textContent = name;
    title.title = name;
    title.classList.toggle("titleLong", length > 32 && length <= 56);
    title.classList.toggle("titleVeryLong", length > 56 && length <= 92);
    title.classList.toggle("titleExtreme", length > 92);
  }
  function libraryPayload(item) {
    return item?.record || item?.entry || item || {};
  }
  function difficultyInfoFor(item) {
    const c = libraryPayload(item);
    if(c.parser==='sus'&&c.meta?.difficultyClass){const tier=c.meta.difficultyClass.toUpperCase(),level=Number(c.meta.level)||-1;return {caption:tier+' Lv.'+(level>0?level:'?'),tier,level,order:({EASY:0,NORMAL:1,HARD:2,EXPERT:3,MASTER:4,APPEND:5})[tier]??6};}
    const caption = difficultyCaptionFor(c),
      m = caption.match(/\b(EZ|HD|IN|AT|SP)\b/i),
      lm = caption.match(/Lv\.?\s*([0-9]+(?:\.[0-9]+)?|\?)/i),
      tier = m ? m[1].toUpperCase() : "",
      level = lm && lm[1] !== "?" ? Number(lm[1]) : -1,
      order = { EZ: 0, HD: 1, IN: 2, AT: 3, SP: 4 }[tier] ?? 5;
    return { caption: caption || "Lv.?", tier, level, order };
  }
  function groupLibraryItems(items) {
    const n = items.length,
      parent = Array.from({ length: n }, (_, i) => i),
      find = (x) => {
        while (parent[x] !== x) {
          parent[x] = parent[parent[x]];
          x = parent[x];
        }
        return x;
      },
      join = (a, b) => {
        a = find(a);
        b = find(b);
        if (a !== b) parent[b] = a;
      },
      names = new Map(),
      hashes = new Map();
    for (let i = 0; i < n; i++) {
      const c = libraryPayload(items[i]),
        nk = normalizedSongName(c.name),
        hk = String(c.audioHash || "");
      if (nk) {
        if (names.has(nk)) join(i, names.get(nk));
        else names.set(nk, i);
      }
      if (hk) {
        if (hashes.has(hk)) join(i, hashes.get(hk));
        else hashes.set(hk, i);
      }
    }
    const map = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!map.has(r)) map.set(r, []);
      map.get(r).push(items[i]);
    }
    const groups = [];
    for (const members of map.values()) {
      members.sort((a, b) => {
        const A = difficultyInfoFor(a),
          B = difficultyInfoFor(b);
        return (
          A.order - B.order ||
          A.level - B.level ||
          String(libraryPayload(a).sourceName || "").localeCompare(
            String(libraryPayload(b).sourceName || ""),
          )
        );
      });
      const counts = new Map();
      for (const it of members) {
        const name =
            String(libraryPayload(it).name || "未命名曲目").trim() ||
            "未命名曲目",
          key = normalizedSongName(name);
        const x = counts.get(key) || { name, count: 0 };
        x.count++;
        counts.set(key, x);
      }
      const name =
          [...counts.values()].sort(
            (a, b) => b.count - a.count || a.name.length - b.name.length,
          )[0]?.name || "未命名曲目",
        audioHash =
          members.map((x) => libraryPayload(x).audioHash).find(Boolean) || "",
        key = audioHash ? `a:${audioHash}` : `n:${normalizedSongName(name)}`;
      groups.push({
        key,
        name,
        items: members,
        latest: Math.max(
          ...members.map((x) => Number(libraryPayload(x).importedAt) || 0),
        ),
      });
    }
    groups.sort((a, b) => b.latest - a.latest || a.name.localeCompare(b.name));
    return groups;
  }
  function uniqueDifficultyLabels(items) {
    const used = new Map();
    return items.map((item) => {
      const base = difficultyInfoFor(item).caption || "Lv.?",
        n = (used.get(base) || 0) + 1;
      used.set(base, n);
      return n === 1 ? base : `${base} · ${n}`;
    });
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error("当前页面环境不允许使用 IndexedDB"));
        return;
      }
      let settled = false;
      const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        },
        timer = setTimeout(
          () => finish(reject, new Error("打开本机数据库超时")),
          20000,
        );
      let r;
      try {
        r = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        finish(reject, e);
        return;
      }
      r.onupgradeneeded = () => {
        const d = r.result, upgradeTx = r.transaction;
        const charts = d.objectStoreNames.contains("charts")
          ? upgradeTx.objectStore("charts")
          : d.createObjectStore("charts", { keyPath: "id" });
        if (!charts.indexNames.contains("importedAt"))
          charts.createIndex("importedAt", "importedAt", { unique: false });
        if (!d.objectStoreNames.contains("settings"))
          d.createObjectStore("settings", { keyPath: "key" });
        if (!d.objectStoreNames.contains("scores")) d.createObjectStore("scores", { keyPath: "key" });
        const chartIndex = d.objectStoreNames.contains("chartIndex")
          ? upgradeTx.objectStore("chartIndex")
          : d.createObjectStore("chartIndex", { keyPath: "id" });
        if (!chartIndex.indexNames.contains("importedAt"))
          chartIndex.createIndex("importedAt", "importedAt", { unique: false });
      };
      r.onsuccess = () => {
        if (settled) {
          try {
            r.result.close();
          } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
          return;
        }
        finish(resolve, r.result);
      };
      r.onerror = () =>
        finish(reject, r.error || new Error("无法打开本机数据库"));
      r.onblocked = () => finish(reject, new Error("本机数据库被其他页面占用"));
    });
  }
  function openNamedDatabase(name) {
    return new Promise((resolve, reject) => {
      let request;
      try { request = indexedDB.open(name); }
      catch (error) { reject(error); return; }
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(`无法打开旧数据库：${name}`));
      request.onblocked = () => reject(new Error(`旧数据库被占用：${name}`));
    });
  }
  function foreignStoreGetAll(database, storeName) {
    return new Promise((resolve, reject) => {
      try {
        const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error(`读取旧存储失败：${storeName}`));
      } catch (error) { reject(error); }
    });
  }
  function looksLikePhiChartRecord(value) {
    return !!(value && typeof value === "object" && value.id != null &&
      (value.chartText != null || value.chartBlob != null || value.audioBlob != null ||
       value.sourceName != null || value.parser != null));
  }
  async function migrateLegacyDatabases() {
    if (!db || typeof indexedDB.databases !== "function") return { charts: 0, settings: 0, databases: 0 };
    let infos;
    try { infos = await indexedDB.databases(); }
    catch (error) { Diagnostics.warn("StorageManager.legacy.list", error?.message || String(error)); return { charts: 0, settings: 0, databases: 0 }; }
    const names = [...new Set((infos || []).map((x) => String(x?.name || "").trim()).filter(Boolean))]
      .filter((name) => name !== DB_NAME);
    if (!names.length) return { charts: 0, settings: 0, databases: 0 };
    const currentChartKeys = new Set(await idbReq(tx("charts").getAllKeys())),
      currentSettingKeys = new Set(await idbReq(tx("settings").getAllKeys()));
    let chartCount = 0, settingCount = 0, databaseCount = 0;
    for (const name of names) {
      let legacy = null;
      try {
        legacy = await openNamedDatabase(name);
        const hasCharts = legacy.objectStoreNames.contains("charts"),
          hasSettings = legacy.objectStoreNames.contains("settings");
        if (!hasCharts && !hasSettings) continue;
        let accepted = false;
        if (hasCharts) {
          const records = await foreignStoreGetAll(legacy, "charts");
          for (const record of records) {
            if (!looksLikePhiChartRecord(record) || currentChartKeys.has(record.id)) continue;
            await idbWrite("charts", (store) => store.put(record));
            currentChartKeys.add(record.id);
            chartCount++;
            accepted = true;
          }
        }
        if (hasSettings) {
          const records = await foreignStoreGetAll(legacy, "settings");
          for (const record of records) {
            if (!record || typeof record !== "object" || record.key == null || currentSettingKeys.has(record.key)) continue;
            await idbWrite("settings", (store) => store.put(record));
            currentSettingKeys.add(record.key);
            settingCount++;
            accepted = true;
          }
        }
        if (accepted) databaseCount++;
      } catch (error) {
        Diagnostics.warn("StorageManager.legacy.migrate", error?.message || String(error), { database: name });
      } finally {
        try { legacy?.close?.(); } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      }
    }
    if (chartCount || settingCount)
      Diagnostics.info("StorageManager.legacy.migrate", `已兼容迁移旧本机存储：${chartCount} 个谱面，${settingCount} 项设置`, { databaseCount });
    return { charts: chartCount, settings: settingCount, databases: databaseCount };
  }

  let legacyMigrationScheduled = false;
  function scheduleLegacyStorageMigration() {
    if (legacyMigrationScheduled || isTemporaryStorage() || !db) return;
    legacyMigrationScheduled = true;
    setTimeout(async () => {
      try {
        const migrated = await migrateLegacyDatabases();
        if (migrated.charts || migrated.settings) {
          toast(`已恢复旧版本本机数据：${migrated.charts} 个谱面，${migrated.settings} 项设置`, false, 6500);
          libraryDirty = true;
          await renderLibrary();
        }
      } catch (error) {
        Diagnostics.warn("StorageManager.legacy.schedule", error?.message || String(error));
      }
    }, 700);
  }

  function tx(store, mode = "readonly") {
    if (storageMode !== "persistent" || !db) throw new Error("永久存储不可用");
    return db.transaction(store, mode).objectStore(store);
  }
  function idbReq(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error("数据库操作失败"));
    });
  }
  // A write request may report success before its transaction is committed.
  // Always wait for transaction.oncomplete so an immediate refresh cannot abort
  // a newly imported chart or material pack.
  function idbWrite(storeName, operation) {
    return new Promise((resolve, reject) => {
      let transaction, request, result;
      try {
        transaction = db.transaction(storeName, "readwrite");
        request = operation(transaction.objectStore(storeName));
      } catch (error) {
        reject(error);
        return;
      }
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => {
        try { transaction.abort(); } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || request?.error || new Error("数据库写入失败"));
      transaction.onabort = () => reject(transaction.error || request?.error || new Error("数据库写入已中止"));
    });
  }
  async function retryPersistentOperation(operation, stage) {
    try {
      return await operation();
    } catch (firstError) {
      if (storageMode !== "persistent") throw firstError;
      Diagnostics.warn(stage, firstError?.message || String(firstError), { retry: true });
      try { db?.close?.(); } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      db = await openDB();
      storageReady = true;
      return await operation();
    }
  }
  async function requestDurableStorage() {
    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
    } catch (error) {
      Diagnostics.warn("StorageManager.persist", error?.message || String(error));
    }
  }
  function isTemporaryStorage() {
    return storageMode === "temporary";
  }
  function shouldUseTemporaryUrlMode() {
    // IndexedDB is persistent on normal file/http/https origins. Only fall back
    // after an actual open failure; never discard an existing library merely
    // because the page was opened from a URL or an in-app browser.
    return false;
  }
  function setStorageModeUI() {
    const temporary = isTemporaryStorage(),
      importCharts = $("#importCharts"),
      importPack = $("#importPack"),
      brandNote = document.querySelector(".brand>div>small");
    if (importCharts)
      importCharts.textContent = temporary ? "＋ 导入临时谱面" : "＋ 导入谱面";
    if (importPack)
      importPack.textContent = temporary ? "临时材质包" : "材质包";
    if (brandNote)
      brandNote.textContent = temporary
        ? "临时谱面库 · 当前页面有效 · 内置皮肤首次打开即生效"
        : "本地谱面库 · 所有文件仅在设备内处理";
    updatePackStatus();
  }
  function announceTemporaryStorage() {
    if (temporaryModeAnnounced) return;
    temporaryModeAnnounced = true;
    const el = $("#libraryStatus");
    if (el) el.textContent = "临时谱面库 · 当前 URL 环境无法持久化；可在本机工具中使用库迁移";
    Diagnostics.warn("Storage.temporary", "当前 URL 环境使用临时谱面库");
  }
  function activateTemporaryStorage(error, notify = true) {
    if (storageMode !== "temporary") {
      storageMode = "temporary";
      storageFallbackReason = String(
        error?.message || error || "当前环境不支持永久存储",
      );
      try {
        db?.close?.();
      } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      db = null;
      storageReady = true;
      setStorageModeUI();
    }
    if (notify) announceTemporaryStorage();
  }
  function chartSummaryFromRecord(record) {
    const r = record || {};
    return {
      id: r.id,
      name: r.name,
      sourceName: r.sourceName,
      parser: r.parser,
      meta: r.meta || {},
      lines: Number(r.lines) || 0,
      notes: Number(r.notes) || 0,
      importedAt: Number(r.importedAt) || 0,
      audioHash: r.audioHash || "",
      audioName: r.audioName || "",
      chartFileName: r.chartFileName || "",
      hasBackground: !!r.bgBlob,
      adminPublished: !!r.adminPublished,
      publishedAt: Number(r.publishedAt) || 0,
      publisher: r.publisher || "",
      _summary: true,
    };
  }
  function idbWriteMany(storeNames, operation) {
    return new Promise((resolve, reject) => {
      let transaction, result;
      try {
        transaction = db.transaction(storeNames, "readwrite");
        result = operation(transaction);
      } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error("数据库写入失败"));
      transaction.onabort = () => reject(transaction.error || new Error("数据库写入已中止"));
    });
  }
  async function dbGetChart(id) {
    if (isTemporaryStorage()) return sessionStore.charts.get(id) || null;
    return await retryPersistentOperation(
      () => idbReq(tx("charts").get(id)),
      "StorageManager.chart.read",
    ) || null;
  }
  async function dbGetChartSummary(id) {
    if (librarySummaryCache.has(id)) return librarySummaryCache.get(id);
    if (isTemporaryStorage()) {
      const record = sessionStore.charts.get(id);
      const summary = record ? chartSummaryFromRecord(record) : null;
      if (summary) librarySummaryCache.set(id, summary);
      return summary;
    }
    const summary = await retryPersistentOperation(
      () => idbReq(tx("chartIndex").get(id)),
      "StorageManager.chartIndex.read",
    ) || null;
    if (summary) librarySummaryCache.set(id, summary);
    return summary;
  }
  async function dbGetChartKeysNewest() {
    if (isTemporaryStorage())
      return [...sessionStore.charts.values()]
        .sort((a, b) => (Number(b.importedAt) || 0) - (Number(a.importedAt) || 0))
        .map((x) => x.id);
    return await retryPersistentOperation(() => {
      const store = tx("charts"), source = store.indexNames.contains("importedAt") ? store.index("importedAt") : store;
      return idbReq(source.getAllKeys()).then((keys) => (keys || []).reverse());
    }, "StorageManager.chartKeys.read");
  }
  async function dbPutChartSummary(summary) {
    if (!summary?.id) return summary?.id;
    librarySummaryCache.set(summary.id, summary);
    if (isTemporaryStorage()) return summary?.id;
    return await retryPersistentOperation(
      () => idbWrite("chartIndex", (store) => store.put(summary)),
      "StorageManager.chartIndex.write",
    );
  }
  async function dbPutChart(v) {
    libraryDirty = true;
    if (isTemporaryStorage()) {
      sessionStore.charts.set(v.id, v);
      librarySummaryCache.set(v.id, chartSummaryFromRecord(v));
      return v.id;
    }
    const summary = chartSummaryFromRecord(v);
    librarySummaryCache.set(v.id, summary);
    return await retryPersistentOperation(
      () => idbWriteMany(["charts", "chartIndex"], (transaction) => {
        transaction.objectStore("charts").put(v);
        transaction.objectStore("chartIndex").put(summary);
        return v.id;
      }),
      "StorageManager.charts.write",
    );
  }
  async function dbPutChartsAtomically(records) {
    const unique = [...new Map((records || []).filter((record) => record?.id).map((record) => [record.id, record])).values()];
    if (!unique.length) return 0;
    libraryDirty = true;
    if (isTemporaryStorage()) {
      for (const record of unique) { sessionStore.charts.set(record.id, record); librarySummaryCache.set(record.id, chartSummaryFromRecord(record)); }
      return unique.length;
    }
    await retryPersistentOperation(() => idbWriteMany(["charts", "chartIndex"], (transaction) => {
      const charts = transaction.objectStore("charts"), index = transaction.objectStore("chartIndex");
      for (const record of unique) { charts.put(record); index.put(chartSummaryFromRecord(record)); }
    }), "StorageManager.charts.atomicWrite");
    for (const record of unique) librarySummaryCache.set(record.id, chartSummaryFromRecord(record));
    return unique.length;
  }
  async function dbDeleteChart(id) {
    sessionStore.charts.delete(id);
    librarySummaryCache.delete(id);
    libraryDirty = true;
    if (isTemporaryStorage()) return;
    return await retryPersistentOperation(
      () => idbWriteMany(["charts", "chartIndex"], (transaction) => {
        transaction.objectStore("charts").delete(id);
        transaction.objectStore("chartIndex").delete(id);
      }),
      "StorageManager.charts.delete",
    );
  }
  async function dbGetSetting(k) {
    if (isTemporaryStorage()) return sessionStore.settings.get(k);
    const v = await retryPersistentOperation(
      () => idbReq(tx("settings").get(k)),
      "StorageManager.settings.read",
    );
    if (v !== undefined) sessionStore.settings.set(k, v);
    return v;
  }
  async function dbPutSetting(v) {
    sessionStore.settings.set(v.key, v);
    if (isTemporaryStorage()) return v.key;
    return await retryPersistentOperation(
      () => idbWrite("settings", (store) => store.put(v)),
      "StorageManager.settings.write",
    );
  }
  async function dbGetAllSettings() {
    if (isTemporaryStorage()) return [...sessionStore.settings.values()];
    return await retryPersistentOperation(
      () => idbReq(tx("settings").getAll()),
      "StorageManager.settings.readAll",
    ) || [];
  }

  async function dbGetAllScores() {
    if (isTemporaryStorage()) return [...sessionStore.scores.values()];
    return await retryPersistentOperation(() => idbReq(tx("scores").getAll()), "StorageManager.scores.readAll") || [];
  }
  async function dbPutScore(value) {
    if (!value?.key) return;
    scoreCache.set(value.key, value); sessionStore.scores.set(value.key, value);
    if (!isTemporaryStorage()) await retryPersistentOperation(() => idbWrite("scores", (store) => store.put(value)), "StorageManager.scores.write");
  }
  async function loadScoreCache() {
    scoreCache.clear();
    for (const value of await dbGetAllScores()) if (value?.key) scoreCache.set(value.key, value);
  }

  function updateOfficialFontButton() {
    const button = $("#importOfficialFont");
    if (!button) return;
    button.innerHTML = `字体 <span class="fontSourceBadge">内置 Saira</span>`;
    button.title = "当前字体：内置 Saira Regular；HTML、HUD 与 Canvas 文字均使用同一字体入口";
    button.setAttribute("aria-label", "当前字体：内置 Saira Regular");
  }
  async function applyOfficialFontBlob() {
    throw new Error("本版本已内置并锁定 Saira Regular，无需再次导入字体");
  }
  async function loadSavedOrAdjacentOfficialFont() {
    officialFontLoaded = true;
    officialFontSource = "Embedded Saira Regular (OFL-1.1)";
    const root = document.documentElement;
    const exact = '"PhiEmbeddedSaira","PingFang SC","Hiragino Sans GB","PhiCJK","Noto Sans CJK SC","Microsoft YaHei",sans-serif';
    root.style.setProperty("--phi-ui-font", exact);
    root.style.setProperty("--phi-narrow-font", exact);
    root.style.setProperty("--phi-song-font", exact);
    root.style.setProperty("--phi-library-font", exact);
    root.style.setProperty("--phi-global-font", exact);
    root.classList.add("phiExactFontLoaded", "phiEmbeddedSairaLoaded");
    try {
      if (document.fonts?.load) await withTimeout(document.fonts.load('16px "PhiEmbeddedSaira"', "0123456789 SCORE COMBO PHIGROS"), 4000, "内置 Saira 字体加载超时");
      if (document.fonts?.ready) await withTimeout(document.fonts.ready, 4000, "字体集合准备超时");
    } catch (error) {
      Diagnostics.warn("UI.font.embedded", error?.message || String(error));
    }
    updateOfficialFontButton();
    return true;
  }
  function portableSettingRecord(record) {
    if (!record || record.key == null || record.key === "activePack" || record.key === "officialFontBlob") return null;
    try {
      const json = JSON.stringify(record);
      return json ? JSON.parse(json) : null;
    } catch { return null; }
  }
  async function exportLibraryMigrationPackage(button = null) {
    if (isTemporaryStorage()) throw new Error("当前环境是临时存储，无法导出永久库");
    const original = button?.textContent || "导出迁移包";
    try {
      if (button) { button.disabled = true; button.textContent = "读取本机库…"; }
      const keys = await dbGetChartKeysNewest(), entries = [], chartManifest = [];
      let index = 0;
      for (const id of keys) {
        const record = await dbGetChart(id);
        if (!record) continue;
        if (button) button.textContent = `打包 ${++index}/${keys.length}`;
        const chartZip = await buildStoredZip(exportPackageEntries(record));
        const name = `charts/${String(index).padStart(5,"0")}_${safeExportStem(record.name)}_${safeExportStem(difficultyInfoFor(record).caption,"Lv")}.zip`;
        entries.push({ name, blob: chartZip });
        chartManifest.push({ id: record.id, name: record.name, difficulty: difficultyInfoFor(record).caption, file: name });
        if ((index & 3) === 0) await new Promise((r) => setTimeout(r, 0));
      }
      const settings = (await dbGetAllSettings()).map(portableSettingRecord).filter(Boolean),
        manifest = { format: LIBRARY_BACKUP_FORMAT, version: LIBRARY_BACKUP_VERSION, createdAt: new Date().toISOString(), sourceOrigin: location.origin || "file://", database: DB_NAME, charts: chartManifest, settings, scores: [...scoreCache.values()] };
      entries.unshift({ name: "phi-library-backup.json", blob: new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json;charset=utf-8" }) });
      const output = await buildStoredZip(entries, (done, total) => { if (button) button.textContent = `封装 ${done}/${total}`; });
      const filename = `Phi_Offline_Library_Migration_${new Date().toISOString().slice(0,10)}.zip`;
      triggerBlobDownload(output, filename);
      toast(`已生成迁移包：${chartManifest.length} 个谱面。请在 URL 版本点击“库迁移 → 导入迁移包”。`, false, 8000);
    } finally { if (button) { button.disabled = false; button.textContent = original; } }
  }
  async function importLibraryMigrationPackage(file, button = null) {
    if (!file) return;
    const original = button?.textContent || "导入迁移包";
    try {
      if (button) { button.disabled = true; button.textContent = "读取迁移包…"; }
      const entries = await unpackFile(file), byName = new Map(entries.map((x) => [String(x.name).toLowerCase(), x])),
        manifestEntry = byName.get("phi-library-backup.json");
      if (!manifestEntry) throw new Error("不是 Phi Offline 本机库迁移包");
      const manifest = JSON.parse(await manifestEntry.blob.text());
      if (manifest?.format !== LIBRARY_BACKUP_FORMAT) throw new Error("迁移包格式不匹配");
      for (const setting of manifest.settings || []) if (setting?.key != null) await dbPutSetting(setting);
      for (const score of manifest.scores || []) if (score?.key && score?.ranked) await dbPutScore(score);
      const nested = entries.filter((x) => /(^|\/)charts\/.*\.zip$/i.test(x.name)).map((x) => makeNamedBlob(x.blob, basename(x.name)));
      if (!nested.length) throw new Error("迁移包中没有谱面 ZIP");
      if (button) button.textContent = `导入 0/${nested.length}`;
      await importChartFiles(nested);
      toast(`迁移完成：已处理 ${nested.length} 个谱面 ZIP。固定 URL 同源后会长期保存在 ${location.origin || "file://"}。`, false, 9000);
    } finally { if (button) { button.disabled = false; button.textContent = original; } }
  }
  function htmlEscape(value) { return String(value ?? "").replace(/[&<>"]/g, (ch) => ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"); }
  async function storagePersistenceSummary() {
    let persisted = false, estimate = null;
    try { persisted = !!(await navigator.storage?.persisted?.()); } catch {}
    try { estimate = await navigator.storage?.estimate?.(); } catch {}
    const used = Number(estimate?.usage) || 0, quota = Number(estimate?.quota) || 0;
    return { persisted, used, quota, origin: location.origin || "file://" };
  }
  async function openLibraryTransferDialog() {
    const info = await storagePersistenceSummary(), pct = info.quota ? `${(info.used/info.quota*100).toFixed(1)}%` : "未知";
    showDialog("本机谱面库迁移", `<div class="transferPanel"><p>浏览器存储按来源隔离。固定的 HTTPS URL 在同一域名和端口下会继续使用同一个 <code>${DB_NAME}</code>；但 <code>file://</code> 与 HTTPS 不能直接互读。使用迁移包可把旧文件版谱面一次搬到 URL 版。</p><div class="transferStatus">当前来源：<code>${htmlEscape(info.origin)}</code><br>持久存储：${info.persisted ? "已授予" : "浏览器管理"} · 空间使用：${pct}</div><div class="transferActions"><button class="btn primary" id="exportLibraryMigration">导出旧本机库</button><button class="btn" id="importLibraryMigration">导入迁移包</button></div><p>以后只要 URL 的域名、协议和端口不变，即使 HTML 文件更新或路径改变，谱面库仍会保留。清除网站数据或使用隐私/无痕窗口仍会删除或隔离存储。</p></div>`);
    $("#exportLibraryMigration").onclick = async (e) => { try { await exportLibraryMigrationPackage(e.currentTarget); } catch (error) { toast(`迁移包导出失败：${error.message}`, true, 8000); } };
    $("#importLibraryMigration").onclick = () => $("#libraryTransferInput").click();
  }


  // Portable raw-Deflate/GZIP fallback. Some iPad URL containers expose
  // DecompressionStream but reject ZIP raw Deflate; embedded charts and skins
  // must still open without a refresh or a browser-specific decoder.
function withTimeout(promise, ms, message = "操作超时") {
    let timer = 0;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms));
      }),
    ]).finally(() => clearTimeout(timer));
  }
  function inflateRawPortable(input, expectedSize = 0) {
    const src = input instanceof Uint8Array ? input : new Uint8Array(input);
    let ip = 0,
      bitbuf = 0,
      bitcnt = 0,
      op = 0,
      out = new Uint8Array(
        expectedSize > 0 ? expectedSize : Math.max(1024, src.length * 3),
      );
    const need = (n) => {
      while (bitcnt < n && ip < src.length) {
        bitbuf |= src[ip++] << bitcnt;
        bitcnt += 8;
      }
    };
    const readBits = (n) => {
      need(n);
      if (bitcnt < n) throw new Error("Deflate 数据提前结束");
      const mask = n === 32 ? 0xffffffff : (1 << n) - 1,
        v = bitbuf & mask;
      bitbuf >>>= n;
      bitcnt -= n;
      return v >>> 0;
    };
    const ensure = (n) => {
      if (op + n <= out.length) return;
      let size = out.length || 1024;
      while (size < op + n) size = Math.max(size * 2, op + n);
      const grown = new Uint8Array(size);
      grown.set(out);
      out = grown;
    };
    const reverseBits = (code, len) => {
      let r = 0;
      for (let i = 0; i < len; i++) {
        r = (r << 1) | (code & 1);
        code >>>= 1;
      }
      return r;
    };
    const buildHuffman = (lengths) => {
      let max = 0;
      const counts = new Uint16Array(16);
      for (let i = 0; i < lengths.length; i++) {
        const len = lengths[i] | 0;
        if (len < 0 || len > 15) throw new Error("Deflate Huffman 位长无效");
        if (len) {
          counts[len]++;
          if (len > max) max = len;
        }
      }
      if (!max) throw new Error("Deflate Huffman 表为空");
      const next = new Uint32Array(16);
      let code = 0;
      for (let len = 1; len <= 15; len++) {
        code = (code + counts[len - 1]) << 1;
        next[len] = code;
      }
      const table = new Int32Array(1 << max), byLen = Array(max + 1).fill(null);
      for (let sym = 0; sym < lengths.length; sym++) {
        const len = lengths[sym] | 0;
        if (!len) continue;
        const rev = reverseBits(next[len]++, len),
          fill = 1 << (max - len),
          packed = (len << 16) | sym;
        for (let i = 0; i < fill; i++) table[rev | (i << len)] = packed;
        let m = byLen[len];
        if (!m) byLen[len] = m = new Map();
        m.set(rev, sym);
      }
      return { table, max, mask: (1 << max) - 1, byLen };
    };
    const decodeSymbol = (h) => {
      need(h.max);
      const packed = h.table[bitbuf & h.mask],
        len = packed >>> 16;
      if (len && len <= bitcnt) {
        bitbuf >>>= len;
        bitcnt -= len;
        return packed & 0xffff;
      }
      // Valid Deflate streams may end with fewer buffered bits than the
      // tree's maximum width. Decode incrementally instead of rejecting a
      // shorter code merely because no further source byte exists.
      let code = 0;
      for (let n = 1; n <= h.max; n++) {
        code |= readBits(1) << (n - 1);
        const m = h.byLen[n];
        if (m && m.has(code)) return m.get(code);
      }
      throw new Error("Deflate Huffman 码损坏");
    };
    const fixedLitLengths = new Uint8Array(288),
      fixedDistLengths = new Uint8Array(32);
    fixedLitLengths.fill(8, 0, 144);
    fixedLitLengths.fill(9, 144, 256);
    fixedLitLengths.fill(7, 256, 280);
    fixedLitLengths.fill(8, 280, 288);
    fixedDistLengths.fill(5);
    const fixedLit = buildHuffman(fixedLitLengths),
      fixedDist = buildHuffman(fixedDistLengths),
      lengthBase = new Uint16Array([
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43,
        51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
      ]),
      lengthExtra = new Uint8Array([
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4,
        4, 4, 4, 5, 5, 5, 5, 0,
      ]),
      distBase = new Uint32Array([
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385,
        513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385,
        24577,
      ]),
      distExtra = new Uint8Array([
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9,
        10, 10, 11, 11, 12, 12, 13, 13,
      ]),
      codeLengthOrder = new Uint8Array([
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
      ]);
    let final = 0;
    do {
      final = readBits(1);
      const type = readBits(2);
      if (type === 0) {
        const drop = bitcnt & 7;
        bitbuf >>>= drop;
        bitcnt -= drop;
        const len = readBits(16),
          nlen = readBits(16);
        if (((len ^ 0xffff) & 0xffff) !== nlen)
          throw new Error("Deflate 存储块长度校验失败");
        ensure(len);
        for (let i = 0; i < len; i++) out[op++] = readBits(8);
        continue;
      }
      if (type === 3) throw new Error("Deflate 使用了保留块类型");
      let litTree,
        distTree;
      if (type === 1) {
        litTree = fixedLit;
        distTree = fixedDist;
      } else {
        const hlit = readBits(5) + 257,
          hdist = readBits(5) + 1,
          hclen = readBits(4) + 4,
          cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[codeLengthOrder[i]] = readBits(3);
        const clTree = buildHuffman(cl),
          all = new Uint8Array(hlit + hdist);
        let p = 0,
          prev = 0;
        while (p < all.length) {
          const sym = decodeSymbol(clTree);
          if (sym <= 15) {
            all[p++] = prev = sym;
          } else if (sym === 16) {
            if (!p) throw new Error("Deflate 重复位长缺少前值");
            const count = readBits(2) + 3;
            if (p + count > all.length) throw new Error("Deflate 位长重复越界");
            all.fill(prev, p, p + count);
            p += count;
          } else if (sym === 17) {
            const count = readBits(3) + 3;
            if (p + count > all.length) throw new Error("Deflate 零位长重复越界");
            all.fill(0, p, p + count);
            p += count;
            prev = 0;
          } else if (sym === 18) {
            const count = readBits(7) + 11;
            if (p + count > all.length) throw new Error("Deflate 长零位重复越界");
            all.fill(0, p, p + count);
            p += count;
            prev = 0;
          } else throw new Error("Deflate 位长符号无效");
        }
        litTree = buildHuffman(all.subarray(0, hlit));
        distTree = buildHuffman(all.subarray(hlit));
      }
      for (;;) {
        const sym = decodeSymbol(litTree);
        if (sym < 256) {
          ensure(1);
          out[op++] = sym;
          continue;
        }
        if (sym === 256) break;
        if (sym < 257 || sym > 285) throw new Error("Deflate 长度符号无效");
        const li = sym - 257,
          len = lengthBase[li] + readBits(lengthExtra[li]),
          ds = decodeSymbol(distTree);
        if (ds > 29) throw new Error("Deflate 距离符号无效");
        const distance = distBase[ds] + readBits(distExtra[ds]);
        if (distance <= 0 || distance > op)
          throw new Error("Deflate 回溯距离越界");
        ensure(len);
        for (let i = 0; i < len; i++) {
          out[op] = out[op - distance];
          op++;
        }
      }
    } while (!final);
    if (expectedSize > 0 && op !== expectedSize)
      console.warn?.("Deflate 解压尺寸不一致", op, expectedSize);
    return out.subarray(0, op);
  }
  function gunzipPortable(input, expectedSize = 0) {
    const src = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (src.length < 18 || src[0] !== 31 || src[1] !== 139 || src[2] !== 8)
      throw new Error("GZIP 文件头无效");
    const flags = src[3];
    let p = 10;
    if (flags & 4) {
      if (p + 2 > src.length) throw new Error("GZIP 扩展字段损坏");
      const n = src[p] | (src[p + 1] << 8);
      p += 2 + n;
    }
    if (flags & 8) while (p < src.length && src[p++]);
    if (flags & 16) while (p < src.length && src[p++]);
    if (flags & 2) p += 2;
    if (p > src.length - 8) throw new Error("GZIP 数据不完整");
    const trailer = src.length - 8,
      isize =
        src[trailer + 4] |
        (src[trailer + 5] << 8) |
        (src[trailer + 6] << 16) |
        (src[trailer + 7] << 24);
    return inflateRawPortable(
      src.subarray(p, trailer),
      expectedSize || (isize >>> 0),
    );
  }
  async function decompressPortable(input, method, expectedSize = 0, label = "资源") {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (Number(method) === 0) return bytes;
    if (Number(method) !== 8 && Number(method) !== 9)
      throw new Error(`不支持的压缩方式 ${method}：${label}`);
    let last;
    if (typeof DecompressionStream === "function") {
      const formats = Number(method) === 8 ? ["deflate-raw", "deflate"] : ["gzip"];
      for (const format of formats)
        try {
          const ab = await withTimeout(
            new Response(
              new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)),
            ).arrayBuffer(),
            12000,
            `${label} 原生解压超时`,
          );
          const out = new Uint8Array(ab);
          if (!expectedSize || out.length === Number(expectedSize)) return out;
          last = new Error(`原生解压尺寸 ${out.length} 与预期 ${expectedSize} 不一致`);
        } catch (e) {
          last = e;
        }
    }
    try {
      return Number(method) === 8
        ? inflateRawPortable(bytes, Number(expectedSize) || 0)
        : gunzipPortable(bytes, Number(expectedSize) || 0);
    } catch (e) {
      throw new Error(`${label} 离线解压失败：${e.message || last?.message || "未知错误"}`);
    }
  }

  async function mapLimit(items, limit, worker) {
    const list = Array.from(items || []);
    let next = 0;
    const run = async () => {
      for (;;) {
        const index = next++;
        if (index >= list.length) return;
        await worker(list[index], index);
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(Number(limit) || 1, list.length || 1)) }, run),
    );
  }

  class ZipArchive {
    constructor(buffer, budget = null) {
      this.buffer = buffer;
      this.budget = budget;
      this.seenPaths = new Set();
      this.view = new DataView(buffer);
      this.entries = [];
      this.totalUncompressed = 0;
      this._parse();
    }
    _parse() {
      const v = this.view;
      let eocd = -1;
      for (let i = v.byteLength - 22; i >= Math.max(0, v.byteLength - 65557); i--) {
        if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error("ZIP 中央目录不存在或文件不完整");
      const count = v.getUint16(eocd + 10, true), offset = v.getUint32(eocd + 16, true);
      if (count > PHI_SECURITY_LIMITS.maxEntryCount) throw new Error(`ZIP 文件数 ${count} 超过安全上限`);
      if (this.budget && (this.budget.entries += count) > PHI_SECURITY_LIMITS.maxEntryCount) throw new Error("嵌套 ZIP 文件总数超过安全上限");
      let p = offset;
      for (let i = 0; i < count; i++) {
        if (p + 46 > v.byteLength || v.getUint32(p, true) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
        const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true),
          csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true), nlen = v.getUint16(p + 28, true),
          xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
        if (p + 46 + nlen + xlen + clen > v.byteLength) throw new Error("ZIP 中央目录越界");
        const rawName = dec.decode(new Uint8Array(this.buffer, p + 46, nlen)), name = safeArchivePath(rawName);
        if (name && !rawName.endsWith("/")) {
          const identity = name.normalize("NFC").toLocaleLowerCase("en-US");
          if (this.seenPaths.has(identity)) throw new Error(`ZIP 含重复或规范化冲突路径：${name}`);
          this.seenPaths.add(identity);
          if (usize > PHI_SECURITY_LIMITS.maxSingleUncompressedBytes) throw new Error(`ZIP 项过大：${name}`);
          if (csize > 0 && usize / csize > PHI_SECURITY_LIMITS.maxCompressionRatio) throw new Error(`ZIP 压缩比异常：${name}`);
          this.totalUncompressed += usize;
          if (this.budget && (this.budget.declared += usize) > PHI_SECURITY_LIMITS.maxTotalUncompressedBytes) throw new Error("嵌套 ZIP 声明解压总体积超过安全上限");
          if (this.totalUncompressed > PHI_SECURITY_LIMITS.maxTotalUncompressedBytes) throw new Error("ZIP 解压总体积超过安全上限");
          this.entries.push({ name, method, flags, crc, csize, usize, local });
        } else if (!name && rawName && !rawName.endsWith("/")) {
          if (!(rawName.startsWith("__MACOSX/") || /(^|[\\/])\.DS_Store$/i.test(rawName)))
            throw new Error(`ZIP 含不安全路径：${rawName}`);
        }
        p += 46 + nlen + xlen + clen;
      }
    }
    async read(entry) {
      const v = this.view, p = entry.local;
      if ((entry.flags & 1) !== 0) throw new Error(`不支持加密 ZIP：${entry.name}`);
      if (entry.method !== 0 && entry.method !== 8) throw new Error(`不支持 ZIP 压缩方法 ${entry.method}：${entry.name}`);
      if (p < 0 || p + 30 > v.byteLength || v.getUint32(p, true) !== 0x04034b50) throw new Error(`ZIP 本地文件头损坏：${entry.name}`);
      const nlen = v.getUint16(p + 26, true), xlen = v.getUint16(p + 28, true), start = p + 30 + nlen + xlen;
      if (start < 0 || start + entry.csize > this.buffer.byteLength) throw new Error(`ZIP 数据越界：${entry.name}`);
      const raw = new Uint8Array(this.buffer, start, entry.csize), out = await decompressPortable(raw, entry.method, entry.usize, entry.name);
      if (this.budget && (this.budget.materialized += out.byteLength) > PHI_SECURITY_LIMITS.maxTotalUncompressedBytes) throw new Error("嵌套 ZIP 实际解压总体积超过安全上限");
      if (out.byteLength !== entry.usize) throw new Error(`ZIP 长度校验失败：${entry.name}，期望 ${entry.usize}，实际 ${out.byteLength}`);
      const actual = crc32Bytes(out);
      if (actual !== entry.crc) throw new Error(`ZIP CRC 校验失败：${entry.name}，期望 ${entry.crc.toString(16).padStart(8,"0")}，实际 ${actual.toString(16).padStart(8,"0")}`);
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }
  }
  function isZipBuffer(b) {
    if (b.byteLength < 4) return false;
    const v = new DataView(b);
    const s = v.getUint32(0, true);
    return s === 0x04034b50 || s === 0x06054b50 || s === 0x08074b50;
  }
  async function unpackFile(file, budget = null) {
    if (!(file instanceof Blob)) throw new Error("导入对象不是文件");
    if (file.size > PHI_SECURITY_LIMITS.maxCompressedInputBytes) throw new Error("压缩包体积超过安全上限");
    if (budget && (budget.compressed += file.size) > PHI_SECURITY_LIMITS.maxCompressedInputBytes) throw new Error("嵌套压缩包总体积超过安全上限");
    const b = await file.arrayBuffer();
    if (isZipBuffer(b)) {
      const z = new ZipArchive(b, budget), files = [];
      for (const e of z.entries) {
        try { files.push({ name: e.name, blob: new Blob([await z.read(e)]), size: e.usize }); }
        catch (err) { throw new Error(`解压失败：${e.name}\n${err.message}`); }
      }
      return files;
    }
    return [{ name: file.name || "uploaded.bin", blob: file, size: b.byteLength }];
  }
  async function blobLooksLikeZip(blob) {
    if (!blob || blob.size < 4) return false;
    try {
      return isZipBuffer(await blob.slice(0, 4).arrayBuffer());
    } catch {
      return false;
    }
  }
  function makeNamedBlob(blob, name) {
    try {
      return new File([blob], name, { type: "application/zip" });
    } catch {
      blob.name = name;
      return blob;
    }
  }
  async function blobText(blob) {
    let b = await blob.arrayBuffer();
    let u = new Uint8Array(b);
    if (u[0] === 0xef && u[1] === 0xbb && u[2] === 0xbf) u = u.slice(3);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(u);
    } catch {
      return new TextDecoder("gb18030").decode(u);
    }
  }
  function byName(files, name) {
    if (!name) return null;
    const n = name.replace(/\\/g, "/").toLowerCase();
    return (
      files.find((f) => f.name.replace(/\\/g, "/").toLowerCase() === n) ||
      files.find(
        (f) => basename(f.name).toLowerCase() === basename(n).toLowerCase(),
      )
    );
  }
  function archivePathKey(value) {
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/")
      .toLowerCase();
  }
  function archiveDirname(value) {
    const p = String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
      at = p.lastIndexOf("/");
    return at < 0 ? "" : p.slice(0, at);
  }
  function joinArchivePath(base, value) {
    const raw = String(value || "").replace(/\\/g, "/");
    if (!raw) return "";
    const parts = `${base ? String(base).replace(/\\/g, "/") + "/" : ""}${raw}`.split("/"),
      safe = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") safe.pop();
      else safe.push(part);
    }
    return safe.join("/");
  }
  function byNameFrom(files, name, baseDir = "") {
    if (!name) return null;
    const relative = archivePathKey(joinArchivePath(baseDir, name)),
      direct = files.find((f) => archivePathKey(f.name) === relative);
    if (direct) return direct;
    const absolute = files.find((f) => archivePathKey(f.name) === archivePathKey(name));
    if (absolute) return absolute;
    const leaf = basename(String(name)).toLowerCase(),
      sameDir = files.filter(
        (f) => basename(f.name).toLowerCase() === leaf && archivePathKey(archiveDirname(f.name)) === archivePathKey(baseDir),
      );
    if (sameDir.length === 1) return sameDir[0];
    const matches = files.filter((f) => basename(f.name).toLowerCase() === leaf);
    return matches.length === 1 ? matches[0] : matches[0] || null;
  }
  function parseScalar(v) {
    v = v.trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      return v.slice(1, -1);
    if (v.startsWith("[") && v.endsWith("]"))
      return v
        .slice(1, -1)
        .split(",")
        .map((x) => parseScalar(x));
    if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
    if (/^[-+]?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  }
  function parseSimpleYAML(text) {
    const o = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+#.*$/, "").trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) o[m[1].trim()] = parseScalar(m[2]);
    }
    return o;
  }
  function parseInfoText(text) {
    const o = {};
    for (const raw of text.split(/\r?\n/)) {
      const m = raw.match(/^\s*([^:=]+)\s*[:=]\s*(.*?)\s*$/);
      if (m) o[m[1].trim()] = m[2];
    }
    return o;
  }
  function parseCSVRows(text) {
    const rows = [], row = [];
    let cell = "", quoted = false;
    const source = String(text || "").replace(/^\uFEFF/, "");
    const finishCell = () => { row.push(cell); cell = ""; };
    const finishRow = () => {
      finishCell();
      if (row.some((value) => String(value).trim() !== "")) rows.push(row.slice());
      row.length = 0;
    };
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") finishCell();
      else if (ch === "\n") finishRow();
      else if (ch !== "\r") cell += ch;
    }
    if (cell || row.length) finishRow();
    return rows;
  }
  function csvObjects(text, requiredHeader = "chart") {
    const rows = parseCSVRows(text);
    const headerIndex = rows.findIndex((row) =>
      row.some((cell) => String(cell).trim().toLowerCase() === requiredHeader),
    );
    if (headerIndex < 0) return [];
    const headers = rows[headerIndex].map((value) => String(value || "").trim());
    return rows.slice(headerIndex + 1).map((row) => {
      const object = {};
      for (let i = 0; i < headers.length; i++) if (headers[i]) object[headers[i]] = String(row[i] ?? "").trim();
      return object;
    });
  }
  function rawMetaValue(object, key) {
    const wanted = String(key).replace(/[\s_-]+/g, "").toLowerCase();
    for (const [name, value] of Object.entries(object || {}))
      if (String(name).replace(/[\s_-]+/g, "").toLowerCase() === wanted) return value;
    return undefined;
  }
  function parseInfoCSV(text) {
    return csvObjects(text, "chart").filter((row) => {
      const chart = String(rawMetaValue(row, "chart") || "").trim();
      return chart && !/^(?:谱面|chart)$/i.test(chart);
    });
  }
  function parseLineCSV(text) {
    return csvObjects(text, "chart").map((row) => ({
      chart: String(rawMetaValue(row, "chart") || "").trim(),
      lineId: Math.trunc(Number(rawMetaValue(row, "lineid"))),
      image: String(rawMetaValue(row, "image") || "").trim(),
      scale: Number(rawMetaValue(row, "scale") ?? rawMetaValue(row, "vert") ?? 1) || 1,
      aspect: Number(rawMetaValue(row, "aspect") ?? rawMetaValue(row, "horz") ?? 1) || 1,
      useBackgroundDim: /^(?:1|true|yes|on)$/i.test(String(rawMetaValue(row, "usebackgrounddim") ?? rawMetaValue(row, "isdark") ?? 0)),
      useLineColor: /^(?:1|true|yes|on)$/i.test(String(rawMetaValue(row, "uselinecolor") ?? 0)),
      useLineScale: !/^(?:0|false|no|off)$/i.test(String(rawMetaValue(row, "uselinescale") ?? 1)),
    })).filter((row) => row.chart && row.image && Number.isInteger(row.lineId) && row.lineId >= 0 && !/^(?:谱面|chart)$/i.test(row.chart));
  }
  function metaBoolean(value, fallback = false) {
    if (value == null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    if (/^(?:1|true|yes|on)$/i.test(String(value).trim())) return true;
    if (/^(?:0|false|no|off)$/i.test(String(value).trim())) return false;
    return fallback;
  }
  function metaRatio(value, fallback = 16 / 9) {
    if (typeof value === "string" && /^\s*[-+]?\d+(?:\.\d+)?\s*[:/]\s*[-+]?\d+(?:\.\d+)?\s*$/.test(value)) {
      const [a, b] = value.split(/[:/]/).map(Number);
      if (a > 0 && b > 0) return a / b;
    }
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }
  function normalizeMeta(o) {
    const low = {};
    for (const [k, v] of Object.entries(o || {}))
      low[String(k).replace(/[\s_-]+/g, "").toLowerCase()] = v;
    const backgroundRaw = low.backgrounddim ?? low.globalalpha,
      noteScaleRaw = low.notescale ?? low.scaleratio ?? low.noteuniformscale,
      lineLengthRaw = low.linelength,
      offsetRaw = low.offset;
    return {
      name: low.name || low.title || low.song || low.musicname,
      composer: low.composer || low.artist || low.musician,
      charter: low.charter || low.chartdesigner || low.designer || low.author,
      illustrator: low.illustrator || low.drawer,
      level: low.level || low.chartlevel || low.ranking,
      difficulty: low.difficulty,
      difficultyClass:
        low.difficultyclass || low.category || low.rank || low.chartclass,
      chart: low.chart || low.chartfile || low.chartpath,
      music: low.music || low.songfile || low.audio || (low.name ? low.song : undefined),
      illustration: low.illustration || low.image || low.background || low.picture,
      format: low.format,
      aspectRatio: metaRatio(low.aspectratio, 16 / 9),
      backgroundDim: clamp(Number(backgroundRaw == null || backgroundRaw === "" ? 0.6 : backgroundRaw), 0, 1),
      lineLength: Number.isFinite(Number(lineLengthRaw)) && Number(lineLengthRaw) > 0 ? Number(lineLengthRaw) : 6,
      noteScale: clamp(Number(noteScaleRaw == null || noteScaleRaw === "" ? 1 : noteScaleRaw) || 1, 0.05, 8),
      offset: Number.isFinite(Number(offsetRaw)) ? Number(offsetRaw) : 0,
      holdPartialCover: metaBoolean(low.holdpartialcover, false),
      forceAspectRatio: metaBoolean(low.forceaspectratio, false),
      noteUniformScale: metaBoolean(low.noteuniformscale, false),
      useRpe170Speed: low.userpe170speed == null ? null : metaBoolean(low.userpe170speed, false),
      useAttachUiFix: low.useattachuifix == null ? null : metaBoolean(low.useattachuifix, false),
      previewStart: Number(low.previewstart) || 0,
      previewEnd: Number(low.previewend) || 0,
      intro: low.intro || "",
      tip: low.tip || "",
      tags: Array.isArray(low.tags) ? low.tags : String(low.tags || "").split(",").map((x) => x.trim()).filter(Boolean),
    };
  }
  const OFFICIAL_DIFFICULTY_HINTS = {
    "der schneid": {
      457: ["EZ", "7"],
      710: ["HD", "11"],
      1426: ["IN", "16"],
      1555: ["AT", "17"],
    },
  };
  function songKey(v) {
    return String(v || "")
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
  function inferDifficultyFromNames(meta, chartFileName, sourceName) {
    const out = { ...meta },
      raw = [chartFileName, sourceName].filter(Boolean).join(" ");
    if (!out.difficultyClass) {
      const m = raw.match(/(?:^|[^A-Z])(EZ|HD|IN|AT|SP)(?=$|[^A-Z])/i);
      if (m) out.difficultyClass = m[1].toUpperCase();
    }
    if (out.level == null || String(out.level).trim() === "") {
      const m = raw.match(/\bLv\.?\s*([0-9]+(?:\.[0-9]+)?|\?)/i);
      if (m) out.level = m[1];
    }
    return out;
  }
  function officialDifficultyHint(record) {
    const key = songKey(
        record?.name || record?.meta?.name || record?.sourceName,
      ),
      table = OFFICIAL_DIFFICULTY_HINTS[key];
    if (!table) return null;
    const hit = table[Number(record?.notes)];
    return hit ? { tier: hit[0], level: hit[1] } : null;
  }
  function difficultyCaptionFor(record) {
    if(record?.parser==='sus'&&record.meta?.difficultyClass)return record.meta.difficultyClass.toUpperCase()+' Lv.'+(record.meta.level||'?');
    const m = record?.meta || {},
      raw = [
        m.level,
        m.difficultyClass,
        m.category,
        record?.chartFileName,
        record?.sourceName,
        record?.name,
      ]
        .filter((v) => v !== undefined && v !== null && String(v).trim())
        .join(" ");
    const tierMatch = raw.match(/(?:^|[^A-Z])(EZ|HD|IN|AT|SP)(?=$|[^A-Z])/i),
      hint = officialDifficultyHint(record);
    let tier = tierMatch ? tierMatch[1].toUpperCase() : hint?.tier || "";
    let lv = "";
    const lvMatch = raw.match(/\bLv\.?\s*([0-9]+(?:\.[0-9]+)?|\?)/i);
    if (lvMatch) lv = lvMatch[1];
    if (!lv && tier) {
      const after = raw.match(
        new RegExp(
          "\\b" + tier + "\\b\\s*[-:]?\\s*([0-9]+(?:\\.[0-9]+)?|\\?)",
          "i",
        ),
      );
      if (after) lv = after[1];
    }
    if (!lv) {
      const d = Number(m.difficulty ?? m.level);
      if (Number.isFinite(d) && d > 0) lv = String(Math.trunc(d));
    }
    if (!lv && hint && (!tier || tier === hint.tier)) {
      tier = tier || hint.tier;
      lv = hint.level;
    }
    if (tier === "SP" && !lv) return "SP";
    if (tier) return `${tier} Lv.${lv || "?"}`;
    if (lv) return `Lv.${lv}`;
    const fallback = String(m.level ?? "").trim();
    return fallback && !/^\d+(?:\.\d+)?$/.test(fallback) ? fallback : "Lv.?";
  }
  function phiWeightedTextLength(value) {
    let total = 0;
    for (const ch of String(value || "")) total += /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(ch) ? 1.72 : /[MW@#%&]/.test(ch) ? 1.25 : 1;
    return total;
  }
  function phiLengthClass(value) {
    const n = phiWeightedTextLength(value);
    return n <= 18 ? "phiNameShort" : n <= 28 ? "phiNameMedium" : n <= 42 ? "phiNameLong" : "phiNameExtreme";
  }
  function applyLengthClass(el, value) {
    if (!el) return;
    el.classList.remove("phiNameShort", "phiNameMedium", "phiNameLong", "phiNameExtreme");
    el.classList.add(phiLengthClass(value));
  }
  function triggerGameplayIntro() {
    const gv = $("#gameView");
    if (!gv) return;
    gv.classList.remove("phiStageIntro");
    void gv.offsetWidth;
    gv.classList.add("phiStageIntro");
    clearTimeout(triggerGameplayIntro.timer);
    triggerGameplayIntro.timer = setTimeout(() => {
      gv.classList.remove("phiStageIntro");
      if(engine){engine.nativeNoiseHudCache=null;engine.pjskExportHudCache=null;}
    },1250);
  }
  function applyGameMetadata(record) {
    const name = cleanGameplaySongName(record?.name || record?.meta?.name || ""),
      difficulty = difficultyCaptionFor(record);
    for (const id of ["#gameSongName", "#innerGameSongName"]) {
      const n = $(id);
      if (n) {
        n.textContent = name;
        n.title = name;
        applyLengthClass(n, name);
      }
    }
    for (const id of ["#gameDifficulty", "#innerGameDifficulty"]) {
      const d = $(id);
      if (d) {
        d.textContent = difficulty;
        d.style.display = difficulty ? "block" : "none";
      }
    }
    if(engine){engine.nativeNoiseHudCache=null;engine.pjskExportHudCache=null;}
    const loadingTitle = $("#loadingSongTitle");
    if (loadingTitle) applyLengthClass(loadingTitle, name);
  }
  function fullscreenActive() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function syncGameViewportCSS() {
    const gv = $("#gameView"),
      vv = phiExportViewport ? {width:phiExportViewport.width,height:phiExportViewport.height} : window.visualViewport;
    if (!gv) return;
    const w = Math.max(
        1,
        Math.round(
          vv?.width ||
            window.innerWidth ||
            document.documentElement.clientWidth ||
            1,
        ),
      ),
      h = Math.max(
        1,
        Math.round(
          vv?.height ||
            window.innerHeight ||
            document.documentElement.clientHeight ||
            1,
        ),
      );
    gv.style.setProperty("--game-vw", `${w}px`);
    gv.style.setProperty("--game-vh", `${h}px`);
    gv.style.setProperty("--hud-unit", `${w/682}px`);
    gv.style.setProperty("--hud-y", `${h/512}px`);
    syncReferenceViewport();
  }

  function readSusMetadata(text) {
    const m={};for(const raw of String(text).split(/\r?\n/)){const p=/^\s*#(TITLE|ARTIST|DESIGNER|WAVE|JACKET|PLAYLEVEL|DIFFICULTY)\s+(.*)/i.exec(raw);if(p)m[p[1].toUpperCase()]=p[2].trim().replace(/^"|"$/g,'');}
    return {name:m.TITLE,composer:m.ARTIST,charter:m.DESIGNER,music:m.WAVE,illustration:m.JACKET,
      level:m.PLAYLEVEL,difficultyClass:({1:'EASY',2:'NORMAL',3:'HARD',4:'EXPERT',5:'MASTER',6:'APPEND'})[m.DIFFICULTY]};
  }
  function sniffChart(text) {
    const t = text.trim();
    if (!t) return null;
    if (t[0] === "{" || t[0] === "[") {
      try {
        const j = JSON.parse(t);
        if (j?.formatVersion != null && Array.isArray(j.judgeLineList))
          return { kind: "pgr", json: j };
        if (
          Array.isArray(j?.BPMList) ||
          j?.META?.RPEVersion != null ||
          (j?.META?.offset != null && Array.isArray(j?.judgeLineList))
        )
          return { kind: "rpe", json: j };
      } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
    }
    const lines = t.split(/\r?\n/).filter((x) => x.trim());
    if (lines.some(x => /^\s*#(?:\d{3}[1359][0-9a-z]{1,2}|BPM[0-9a-z]{2})\s*:/i.test(x)))
      return { kind: "sus" };
    if (
      lines.length > 1 &&
      /^[-+]?\d+(\.\d+)?$/.test(lines[0].trim()) &&
      lines.slice(1).some((x) => /^\s*(bp|n[1-4]|c[vpd amrf]|#|&)\b/.test(x))
    )
      return { kind: "pec" };
    return null;
  }
  async function validateAudio(blob) {
    let webAudioError = null;
    try {
      const data = await withTimeout(blob.arrayBuffer(), 16000, "读取音频信息超时"),
        ac = Engine.sharedAudioContext(),
        decoded = await withTimeout(ac.decodeAudioData(data.slice(0)), 18000, "Web Audio 解码超时");
      if (decoded && Number.isFinite(decoded.duration)) return decoded.duration;
    } catch (error) { webAudioError = error; }
    const url = URL.createObjectURL(blob);
    try {
      const a = new Audio();
      a.preload = "metadata";
      a.src = url;
      await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error("读取音频信息超时")), 8000);
        a.onloadedmetadata = () => { clearTimeout(timer); res(); };
        a.onerror = () => { clearTimeout(timer); rej(webAudioError || new Error("浏览器无法解码此音频编码")); };
      });
      return Number.isFinite(a.duration) ? a.duration : 0;
    } finally { URL.revokeObjectURL(url); }
  }
  function chartDurationEstimate(chart) {
    let end = 1;
    const inspectEvents = (events) => {
      for (const event of events || []) {
        const value = Number(event.et ?? event.endTime ?? event.st ?? 0);
        if (Number.isFinite(value) && value < 1e7) end = Math.max(end, value);
      }
    };
    for (const line of chart?.lines || []) {
      for (const note of line.notes || []) end = Math.max(end, Number(note.end ?? note.time) || 0);
      for (const key of ["alpha", "rotate", "moveX", "moveY", "scaleX", "scaleY", "incline", "color", "text", "lineLengthEvents"])
        inspectEvents(line[key]);
      for (const key of ["alphaLayers", "rotateLayers", "moveXLayers", "moveYLayers", "speedLayers"])
        for (const layer of line[key] || []) inspectEvents(layer);
    }
    return clamp(end + 1.5, 2, 3600);
  }
  function packageScope(files, chartFile, baseDir = "") {
    const chartDir = archivePathKey(archiveDirname(chartFile?.name)),
      metaDir = archivePathKey(baseDir),
      score = (file) => {
        const dir = archivePathKey(archiveDirname(file.name));
        if (dir === chartDir) return 0;
        if (metaDir && dir === metaDir) return 1;
        if (chartDir && (chartDir.startsWith(dir + "/") || dir.startsWith(chartDir + "/"))) return 2;
        return 3;
      };
    return files.map((file, index) => ({ file, index, score: score(file) }))
      .sort((a, b) => a.score - b.score || a.index - b.index).map((item) => item.file);
  }
  function chartMatchesReference(files, chartFile, reference, baseDir = "") {
    return !!reference && byNameFrom(files, reference, baseDir) === chartFile;
  }
  async function collectPackageSidecars(files) {
    const metadata = [], lineRows = [], sourceFiles = [], warnings = [];
    for (const file of files) {
      const name = basename(file.name).toLowerCase(), baseDir = archiveDirname(file.name);
      try {
        if (name === "info.csv") {
          sourceFiles.push(file);
          for (const raw of parseInfoCSV(await blobText(file.blob))) metadata.push({ raw, baseDir, file, priority: 10, kind: "info.csv" });
        } else if (name === "info.txt") {
          sourceFiles.push(file);
          metadata.push({ raw: parseInfoText(await blobText(file.blob)), baseDir, file, priority: 20, kind: "info.txt" });
        } else if (name === "info.json") {
          sourceFiles.push(file);
          metadata.push({ raw: JSON.parse(await blobText(file.blob)), baseDir, file, priority: 30, kind: "info.json" });
        } else if (name === "info.yml" || name === "info.yaml") {
          sourceFiles.push(file);
          metadata.push({ raw: parseSimpleYAML(await blobText(file.blob)), baseDir, file, priority: 40, kind: name });
        } else if (name === "line.csv") {
          sourceFiles.push(file);
          for (const row of parseLineCSV(await blobText(file.blob))) lineRows.push({ ...row, baseDir, file });
        }
      } catch (error) {
        const message = `${file.name}：${error.message || error}`;
        warnings.push(message);
        Diagnostics.warn("ChartImporter.sidecar", message);
      }
    }
    return { metadata, lineRows, sourceFiles, warnings };
  }
  function metadataForChart(sidecars, files, chartFile) {
    const explicit = [], implicit = [], chartDir = archivePathKey(archiveDirname(chartFile.name));
    for (const hint of sidecars.metadata) {
      const reference = rawMetaValue(hint.raw, "chart") || rawMetaValue(hint.raw, "chartfile") || rawMetaValue(hint.raw, "chartpath");
      if (reference) {
        if (chartMatchesReference(files, chartFile, reference, hint.baseDir)) explicit.push(hint);
      } else if (archivePathKey(hint.baseDir) === chartDir) implicit.push(hint);
    }
    const matches = implicit.concat(explicit);
    matches.sort((a, b) => a.priority - b.priority);
    const raw = {};
    for (const hint of matches) Object.assign(raw, hint.raw || {});
    return {
      raw,
      baseDir: matches.length ? matches[matches.length - 1].baseDir : archiveDirname(chartFile.name),
      files: matches.map((hint) => hint.file),
      kinds: matches.map((hint) => hint.kind),
    };
  }
  function lineRowsForChart(sidecars, files, chartFile) {
    return sidecars.lineRows.filter((row) => chartMatchesReference(files, chartFile, row.chart, row.baseDir)).map((row) => {
      const image = byNameFrom(files, row.image, row.baseDir);
      return {
        chart: row.chart,
        lineId: row.lineId,
        image: image?.name || joinArchivePath(row.baseDir, row.image),
        scale: row.scale,
        aspect: row.aspect,
        useBackgroundDim: row.useBackgroundDim,
        useLineColor: row.useLineColor,
        useLineScale: row.useLineScale,
      };
    });
  }
  async function discoverChartFiles(files, metadataHints) {
    const seen = new Set(), candidates = [];
    const add = (file) => { if (file && !seen.has(file)) { seen.add(file); candidates.push(file); } };
    for (const hint of metadataHints || []) {
      const reference = rawMetaValue(hint.raw, "chart") || rawMetaValue(hint.raw, "chartfile") || rawMetaValue(hint.raw, "chartpath");
      if (reference) add(byNameFrom(files, reference, hint.baseDir));
    }
    for (const file of files) {
      const base = basename(file.name).toLowerCase();
      if (/^(?:info|extra)\.(?:json|txt|ya?ml|csv)$/i.test(base) || base === "line.csv") continue;
      if (/\.(?:json|pec|txt|sus)$/i.test(file.name)) add(file);
    }
    const charts = [], errors = [];
    for (const file of candidates) {
      try {
        const text = await blobText(file.blob), sniff = sniffChart(text);
        if (sniff) charts.push({ file, text, sniff });
        else if ((metadataHints || []).some((hint) => chartMatchesReference(files, file, rawMetaValue(hint.raw, "chart"), hint.baseDir)))
          errors.push(`${file.name}：元数据指向了该文件，但内容不是可识别的 PGR／RPE／PEC／SUS 谱面`);
      } catch (error) {
        errors.push(`${file.name}：读取谱面失败：${error.message || error}`);
      }
    }
    return { charts, errors };
  }
  async function buildChartRecords(files, sourceName) {
    const records = [], errors = [], sidecars = await collectPackageSidecars(files),
      discovered = await discoverChartFiles(files, sidecars.metadata),
      audioCache = new Map();
    errors.push(...sidecars.warnings, ...discovered.errors);
    for (const item of discovered.charts) {
      const chartFile = item.file,
        metadata = metadataForChart(sidecars, files, chartFile),
        embeddedMeta = item.sniff.kind === "rpe" ? (item.sniff.json?.META || item.sniff.json?.meta || {}) : item.sniff.kind === "sus" ? readSusMetadata(item.text) : {},
        meta = inferDifficultyFromNames(normalizeMeta({ ...embeddedMeta, ...metadata.raw }), chartFile.name, sourceName),
        scope = packageScope(files, chartFile, metadata.baseDir);
      // RPE's own META.offset is already consumed by parseRPE. Only an external
      // package sidecar offset is applied again at play time.
      meta.offset = Number(rawMetaValue(metadata.raw, "offset")) || 0;
      try {
        const parsed = parseChart(item.sniff.kind, item.text, item.sniff.json, meta),
          estimatedDuration = chartDurationEstimate(parsed);
        let audio = byNameFrom(files, meta.music, metadata.baseDir), duration = 0, audioHash = "";
        if (!audio) audio = await phiFindAudioEntry(scope, { ...meta, music: "", chartHint: chartFile.name });
        if (audio) {
          let cached = audioCache.get(audio);
          if (!cached) {
            const normalized = await phiNormalizeAudioEntry(audio, files),
              validatedDuration = await validateAudio(normalized.blob),
              hash = await audioContentSignature(normalized.blob);
            cached = { audio: normalized, duration: validatedDuration, hash };
            audioCache.set(audio, cached);
          }
          audio = cached.audio; duration = cached.duration; audioHash = cached.hash;
        } else {
          throw new Error("谱面包缺少可识别的音乐文件；导入已拒绝，未生成替代音轨");
        }
        let bg = byNameFrom(files, meta.illustration, metadata.baseDir);
        const backgroundCandidates = scope.filter((f) => IMG_EXT.test(f.name) && !/(?:click|drag|flick|hold|hit[_-]?fx|line)/i.test(basename(f.name)))
          .sort((a, b) => phiAssetAffinity(b, chartFile.name) - phiAssetAffinity(a, chartFile.name) || (b.size || b.blob?.size || 0) - (a.size || a.blob?.size || 0));
        if (!bg && (backgroundCandidates.length === 1 || phiAssetAffinity(backgroundCandidates[0], chartFile.name) > phiAssetAffinity(backgroundCandidates[1], chartFile.name)))
          bg = backgroundCandidates[0] || null;
        if (!bg && backgroundCandidates.length > 1)
          throw new Error("谱面包中存在多个候选曲绘；请在 info.yml / info.json 中为该谱面明确指定 illustration");
        const name = String(meta.name || innermostArchiveSongName(sourceName, chartFile.name)),
          probe = { name, sourceName, chartFileName: chartFile.name, meta, notes: parsed.noteCount },
          hint = officialDifficultyHint(probe);
        if (hint) {
          if (!meta.difficultyClass) meta.difficultyClass = hint.tier;
          if (meta.level == null || String(meta.level).trim() === "") meta.level = hint.level;
        }
        const sensitiveAuxiliary = (value) => /(^|[\/])(?:kgg\.key|ekey(?:\.[^\/]*)?|kgmusicv3\.db|[^\/]*\.(?:db|sqlite3?))$/i.test(String(value || "")),
          extraFile = byNameFrom(scope, "extra.json", archiveDirname(chartFile.name)) || byNameFrom(scope, "extra.json", metadata.baseDir),
          lineTextureSpecs = lineRowsForChart(sidecars, scope, chartFile);
        let extraText = "";
        if (extraFile) try { extraText = await blobText(extraFile.blob); }
        catch (error) { Diagnostics.warn("ChartImporter.extra", error?.message || String(error)); }
        const referencedAssets = new Set(), referencedNames = [
          meta.illustration, bg?.name,
          ...parsed.lines.flatMap((line) => [line?.texture, line?.textureName]),
          ...lineTextureSpecs.map((spec) => spec.image),
        ].filter(Boolean);
        for (const value of referencedNames) {
          referencedAssets.add(archivePathKey(value));
          referencedAssets.add(basename(String(value)).toLowerCase());
        }
        const assets = scope.filter((file) => {
            if (sensitiveAuxiliary(file.name) || (!IMG_EXT.test(file.name) && !SHADER_EXT.test(file.name))) return false;
            if (file === bg) return true;
            const key = archivePathKey(file.name), leaf = basename(file.name).toLowerCase();
            if (referencedAssets.has(key) || referencedAssets.has(leaf)) return true;
            return SHADER_EXT.test(file.name) && extraText.toLowerCase().includes(leaf);
          }).map((file) => ({ name: file.name, blob: file.blob })),
          supplementalFiles = [],
          chartContentId = `chart:${await sha256Text(item.sniff.kind + "\0" + canonicalChartText(item.text) + "\0" + audioHash)}`;
        records.push({
          id: chartContentId, chartContentId, name, sourceName, chartFileName: chartFile.name, parser: item.sniff.kind,
          chartText: item.text, extraText, audioBlob: audio.blob, audioName: audio.name, audioHash,
          bgBlob: bg?.blob || null, bgName: bg?.name || "", assets, supplementalFiles, meta,
          assetBaseDir: archiveDirname(chartFile.name),
          lineTextureSpecs,
          metadataKinds: metadata.kinds,
          duration: duration || estimatedDuration, notes: parsed.noteCount, lines: parsed.lines.length, importedAt: Date.now(),
        });
      } catch (error) {
        errors.push(`${chartFile.name}：${error.message || error}`);
      }
    }
    if (!discovered.charts.length && !errors.length)
      errors.push("没有找到可识别的 PGR／RPE／PEC／SUS 谱面文本");
    return { records, errors };
  }
  async function buildChartRecord(files, sourceName) {
    const result = await buildChartRecords(files, sourceName);
    if (!result.records.length) throw new Error(result.errors.join("\n") || "谱面包中没有可导入的谱面");
    return result.records[0];
  }

  function tripleBeat(x) {
    if (Array.isArray(x))
      return (
        Number(x[0] || 0) + Number(x[1] || 0) / Math.max(1, Number(x[2] || 1))
      );
    if (typeof x === "number") return x;
    return 0;
  }
  class BPMMap {
    constructor(items) {
      this.items = (items?.length ? items : [[0, 120]])
        .map((x) =>
          Array.isArray(x)
            ? { beat: Number(x[0]), bpm: Number(x[1]) }
            : { beat: tripleBeat(x.startTime), bpm: Number(x.bpm) },
        )
        .sort((a, b) => a.beat - b.beat);
      if (this.items[0].beat !== 0)
        this.items.unshift({ beat: 0, bpm: this.items[0].bpm });
      let t = 0;
      for (let i = 0; i < this.items.length; i++) {
        if (i)
          t +=
            ((this.items[i].beat - this.items[i - 1].beat) * 60) /
            this.items[i - 1].bpm;
        this.items[i].time = t;
      }
    }
    time(beat) {
      let i = 0;
      while (i + 1 < this.items.length && this.items[i + 1].beat <= beat) i++;
      const x = this.items[i];
      return x.time + ((beat - x.beat) * 60) / x.bpm;
    }
    bpmAt(beat) {
      let i = 0;
      while (i + 1 < this.items.length && this.items[i + 1].beat <= beat) i++;
      return Math.max(1, Number(this.items[i]?.bpm) || 120);
    }
  }
  function ease(id, t) {
    t = clamp(t, 0, 1);
    const n = Number(id) || 1;
    switch (n) {
      case 1:
        return t;
      case 2:
        return Math.sin((t * Math.PI) / 2);
      case 3:
        return 1 - Math.cos((t * Math.PI) / 2);
      case 4:
        return 1 - (1 - t) * (1 - t);
      case 5:
        return t * t;
      case 6:
        return -(Math.cos(Math.PI * t) - 1) / 2;
      case 7:
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      case 8:
        return 1 - Math.pow(1 - t, 3);
      case 9:
        return t * t * t;
      case 10:
        return 1 - Math.pow(1 - t, 4);
      case 11:
        return Math.pow(t, 4);
      case 12:
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      case 13:
        return t < 0.5 ? 8 * Math.pow(t, 4) : 1 - Math.pow(-2 * t + 2, 4) / 2;
      case 14:
        return 1 - Math.pow(1 - t, 5);
      case 15:
        return Math.pow(t, 5);
      case 16:
        return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      case 17:
        return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
      case 18:
        return Math.sqrt(1 - Math.pow(t - 1, 2));
      case 19:
        return 1 - Math.sqrt(1 - t * t);
      case 20:
        return 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
      case 21:
        return 2.70158 * t * t * t - 1.70158 * t * t;
      case 22:
        return t < 0.5
          ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2
          : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2;
      case 23:
        return t < 0.5
          ? (Math.pow(2 * t, 2) * ((2.59491 + 1) * 2 * t - 2.59491)) / 2
          : (Math.pow(2 * t - 2, 2) * ((2.59491 + 1) * (t * 2 - 2) + 2.59491) +
              2) /
              2;
      case 24:
        return t === 0
          ? 0
          : t === 1
            ? 1
            : Math.pow(2, -10 * t) *
                Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) +
              1;
      case 25:
        return t === 0
          ? 0
          : t === 1
            ? 1
            : -Math.pow(2, 10 * t - 10) *
              Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3));
      case 26:
        return t < 1 / 2.75
          ? 7.5625 * t * t
          : t < 2 / 2.75
            ? 7.5625 * (t -= 1.5 / 2.75) * t + 0.75
            : t < 2.5 / 2.75
              ? 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375
              : 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
      case 27:
        return 1 - ease(26, 1 - t);
      case 28:
        return t < 0.5
          ? (1 - ease(26, 1 - 2 * t)) / 2
          : (1 + ease(26, 2 * t - 1)) / 2;
      default:
        return t;
    }
  }
  function cubicBezierProgress(points, x) {
    if (!Array.isArray(points) || points.length < 4) return x;
    const x1 = Number(points[0]),
      y1 = Number(points[1]),
      x2 = Number(points[2]),
      y2 = Number(points[3]);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return x;
    const sample = (a, b, s) => {
      const q = 1 - s;
      return 3 * q * q * s * a + 3 * q * s * s * b + s * s * s;
    };
    const slope = (a, b, s) =>
      3 * (1 - s) * (1 - s) * a +
      6 * (1 - s) * s * (b - a) +
      3 * s * s * (1 - b);
    let s = x;
    for (let i = 0; i < 5; i++) {
      const dx = sample(x1, x2, s) - x,
        d = slope(x1, x2, s);
      if (Math.abs(dx) < 1e-6) break;
      if (Math.abs(d) < 1e-6) {
        s = -1;
        break;
      }
      s -= dx / d;
      if (s < 0 || s > 1) {
        s = -1;
        break;
      }
    }
    if (s < 0) {
      let lo = 0,
        hi = 1;
      s = x;
      for (let i = 0; i < 12; i++) {
        const v = sample(x1, x2, s);
        if (v < x) lo = s;
        else hi = s;
        s = (lo + hi) / 2;
      }
    }
    return sample(y1, y2, clamp(s, 0, 1));
  }
  function compileEventFastFields(e) {
    if (!e || e._phiFastCompiled) return e;
    const st = Number(e.st ?? e.startTime ?? 0),
      et = Number(e.et ?? e.endTime ?? st),
      av = Number(e.a ?? e.start ?? 0),
      bv0 = e.b ?? e.end,
      bv = Number(bv0 == null ? av : bv0),
      left = clamp(Number(e.easingLeft ?? 0), 0, 1),
      right = clamp(Number(e.easingRight ?? 1), 0, 1);
    e._stN = Number.isFinite(st) ? st : 0;
    e._etN = Number.isFinite(et) ? et : e._stN;
    e._aN = Number.isFinite(av) ? av : 0;
    e._bN = Number.isFinite(bv) ? bv : e._aN;
    e._easeIdN = Number(e.ease ?? e.easingType ?? 1) || 1;
    e._easeLeftN = left;
    e._easeRightN = right;
    e._bezierEnabledN = Number(e.bezier) === 1 && Array.isArray(e.bezierPoints);
    e._phiFastCompiled = 1;
    return e;
  }
  function eventEaseValue(e, u) {
    u = clamp(u, 0, 1);
    if (!e?._phiFastCompiled) compileEventFastFields(e);
    if (e?._bezierEnabledN) return cubicBezierProgress(e.bezierPoints, u);
    const id = e?._easeIdN || 1,
      left = Number.isFinite(e?._easeLeftN) ? e._easeLeftN : 0,
      right = Number.isFinite(e?._easeRightN) ? e._easeRightN : 1;
    if (!(right > left)) return ease(id, u);
    const a = ease(id, left),
      b = ease(id, right),
      v = ease(id, left + (right - left) * u),
      d = b - a;
    return Math.abs(d) < 1e-9 ? u : (v - a) / d;
  }
  function prepareEvents(events) {
    if (!events?.length) return events;
    if (events._starts && events._starts.length === events.length)
      return events;
    for (let i = 0; i < events.length; i++) compileEventFastFields(events[i]);
    events.sort((a, b) => a._stN - b._stN);
    Object.defineProperty(events, "_starts", {
      value: Float64Array.from(events, (e) => e._stN),
      configurable: true,
    });
    return events;
  }
  function eventValue(events, time, def = 0, transform = null, add = false) {
    if (!events?.length) return def;
    prepareEvents(events);
    if (add) {
      let out = 0;
      for (const e of events) {
        const st = Number(e.st ?? e.startTime ?? 0),
          en = Number(e.et ?? e.endTime ?? st);
        if (time < st) continue;
        const a = Number(e.a ?? e.start ?? 0),
          b = Number(e.b ?? e.end ?? a),
          u = time >= en ? 1 : en === st ? 1 : (time - st) / (en - st);
        let val = lerp(a, b, eventEaseValue(e, u));
        if (transform) val = transform(val);
        out += val;
      }
      return out;
    }
    const a = events._starts;
    let lo = 0,
      hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= time) lo = mid + 1;
      else hi = mid;
    }
    const i = lo - 1;
    if (i < 0) return def;
    const e = events[i],
      st = Number(e.st ?? e.startTime ?? 0),
      en = Number(e.et ?? e.endTime ?? st),
      va = Number(e.a ?? e.start ?? 0),
      vb = Number(e.b ?? e.end ?? va);
    let val;
    if (time >= en) val = vb;
    else {
      const u = en === st ? 1 : (time - st) / (en - st);
      val = lerp(va, vb, eventEaseValue(e, u));
    }
    return transform ? transform(val) : val;
  }
  function lowerBoundNumeric(a, x) {
    let lo = 0,
      hi = a.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (a[m] < x) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
  function eventValueFast(events, time, def = 0) {
    if (!events?.length) return def;
    prepareEvents(events);
    const starts = events._starts;
    let i = Number(events._fastIndex),
      last = Number(events._fastTime);
    if (
      !Number.isInteger(i) ||
      !Number.isFinite(last) ||
      time < last ||
      time - last > 1.25
    ) {
      let lo = 0,
        hi = starts.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (starts[m] <= time) lo = m + 1;
        else hi = m;
      }
      i = lo - 1;
    } else {
      while (i + 1 < starts.length && starts[i + 1] <= time) i++;
    }
    events._fastIndex = i;
    events._fastTime = time;
    if (i < 0) return def;
    const e = events[i],
      st = e._stN,
      en = e._etN,
      a = e._aN,
      b = e._bN;
    if (time >= en) return b;
    const u = en === st ? 1 : (time - st) / (en - st);
    return a + (b - a) * eventEaseValue(e, u);
  }

  function rpeLayerValueFast(layers, time, def = 0) {
    if (!layers?.length) return def;
    let sum = 0,
      used = false;
    for (const events of layers) {
      if (!events?.length) continue;
      sum += eventValueFast(events, time, 0);
      used = true;
    }
    return used ? sum : def;
  }
  function rpeEventIndexFast(events, time) {
    if (!events?.length) return -1;
    prepareEvents(events);
    const starts = events._starts;
    let i = Number(events._genericFastIndex),
      last = Number(events._genericFastTime);
    if (
      !Number.isInteger(i) ||
      !Number.isFinite(last) ||
      time < last ||
      time - last > 1.25
    ) {
      let lo = 0,
        hi = starts.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (starts[m] <= time) lo = m + 1;
        else hi = m;
      }
      i = lo - 1;
    } else while (i + 1 < starts.length && starts[i + 1] <= time) i++;
    events._genericFastIndex = i;
    events._genericFastTime = time;
    return i;
  }
  function rpeTextValueFast(events, time, def = "") {
    const i = rpeEventIndexFast(events, time);
    if (i < 0) return def;
    const e = events[i],
      en = Number.isFinite(e._etN) ? e._etN : Number(e.et ?? e.endTime ?? e.st ?? 0);
    return String(
      time >= en ? (e.b ?? e.end ?? e.a ?? "") : (e.a ?? e.start ?? ""),
    );
  }
  function rpeColorValueFast(
    events,
    time,
    def = DEFAULT_LINE_COLOR,
    out = null,
  ) {
    const dst = out || [255, 255, 255],
      i = rpeEventIndexFast(events, time);
    if (i < 0) {
      dst[0] = Number(def[0] ?? 255);
      dst[1] = Number(def[1] ?? 255);
      dst[2] = Number(def[2] ?? 255);
      return dst;
    }
    const e = events[i],
      st = Number.isFinite(e._stN) ? e._stN : Number(e.st ?? 0),
      en = Number.isFinite(e._etN) ? e._etN : Number(e.et ?? st),
      a = Array.isArray(e.a) ? e.a : def,
      b = Array.isArray(e.b) ? e.b : a,
      u = time >= en ? 1 : en === st ? 1 : (time - st) / (en - st),
      q = eventEaseValue(e, u);
    dst[0] = lerp(Number(a[0] ?? 255), Number(b[0] ?? 255), q);
    dst[1] = lerp(Number(a[1] ?? 255), Number(b[1] ?? 255), q);
    dst[2] = lerp(Number(a[2] ?? 255), Number(b[2] ?? 255), q);
    return dst;
  }
  function rpeMapNumericEvents(raw, bm, scale = 1) {
    return (raw || [])
      .map((e) => ({
        st: bm.time(tripleBeat(e.startTime)),
        et: bm.time(tripleBeat(e.endTime)),
        a: Number(e.start || 0) * scale,
        b: Number(e.end ?? e.start ?? 0) * scale,
        ease: Number(e.easingType || 1),
        easingLeft: Number(e.easingLeft ?? 0),
        easingRight: Number(e.easingRight ?? 1),
        bezier: Number(e.bezier || 0),
        bezierPoints: Array.isArray(e.bezierPoints)
          ? e.bezierPoints.slice(0, 4).map(Number)
          : null,
      }))
      .sort((a, b) => a.st - b.st);
  }
  function rpeMapVectorEvents(raw, bm, size = 2) {
    return (raw || [])
      .map((e) => {
        const vec = (v, fallback = 0) => {
          const a = Array.isArray(v) ? v : [];
          const out = new Float32Array(size);
          for (let i = 0; i < size; i++) out[i] = Number(a[i] ?? fallback) || 0;
          return out;
        };
        return {
          st: bm.time(tripleBeat(e.startTime)),
          et: bm.time(tripleBeat(e.endTime)),
          a: vec(e.start),
          b: vec(e.end ?? e.start),
          ease: Number(e.easingType || 1),
          easingLeft: Number(e.easingLeft ?? 0),
          easingRight: Number(e.easingRight ?? 1),
          bezier: Number(e.bezier || 0),
          bezierPoints: Array.isArray(e.bezierPoints)
            ? e.bezierPoints.slice(0, 4).map(Number)
            : null,
        };
      })
      .sort((a, b) => a.st - b.st);
  }
  function rpeVectorValueFast(events, time, def = null, out = null) {
    const fallback = def || [0, 0],
      dst = out || new Float32Array(fallback.length || 2),
      i = rpeEventIndexFast(events, time);
    if (i < 0) {
      for (let k = 0; k < dst.length; k++) dst[k] = Number(fallback[k] ?? 0) || 0;
      return dst;
    }
    const e = events[i],
      st = Number(e.st ?? 0),
      en = Number(e.et ?? st),
      a = e.a || fallback,
      b = e.b || a,
      u = time >= en ? 1 : en === st ? 1 : (time - st) / (en - st),
      q = eventEaseValue(e, u);
    for (let k = 0; k < dst.length; k++)
      dst[k] = lerp(Number(a[k] ?? 0), Number(b[k] ?? a[k] ?? 0), q);
    return dst;
  }

  function rpeMapTextEvents(raw, bm) {
    return (raw || [])
      .map((e) => ({
        st: bm.time(tripleBeat(e.startTime)),
        et: bm.time(tripleBeat(e.endTime)),
        a: String(e.start ?? ""),
        b: String(e.end ?? e.start ?? ""),
        ease: Number(e.easingType || 1),
        easingLeft: Number(e.easingLeft ?? 0),
        easingRight: Number(e.easingRight ?? 1),
        bezier: Number(e.bezier || 0),
        bezierPoints: Array.isArray(e.bezierPoints)
          ? e.bezierPoints.slice(0, 4).map(Number)
          : null,
      }))
      .sort((a, b) => a.st - b.st);
  }
  function rpeMapColorEvents(raw, bm) {
    const c = (v) => (Array.isArray(v) ? v.map(Number) : [255, 255, 255]);
    return (raw || [])
      .map((e) => ({
        st: bm.time(tripleBeat(e.startTime)),
        et: bm.time(tripleBeat(e.endTime)),
        a: c(e.start),
        b: c(e.end ?? e.start),
        ease: Number(e.easingType || 1),
        easingLeft: Number(e.easingLeft ?? 0),
        easingRight: Number(e.easingRight ?? 1),
        bezier: Number(e.bezier || 0),
        bezierPoints: Array.isArray(e.bezierPoints)
          ? e.bezierPoints.slice(0, 4).map(Number)
          : null,
      }))
      .sort((a, b) => a.st - b.st);
  }
  function rpeBuildSpeedLayer(raw, bm, useModernSpeed = true) {
    const src = (raw || [])
      .map((e) => ({
        st: bm.time(tripleBeat(e.startTime)),
        et: bm.time(tripleBeat(e.endTime)),
        a: (Number(e.start || 0) * 10) / 45,
        b: (Number(e.end ?? e.start ?? 0) * 10) / 45,
        ease: Number(e.easingType || 1),
        easingLeft: Number(e.easingLeft ?? 0),
        easingRight: Number(e.easingRight ?? 1),
        bezier: Number(e.bezier || 0),
        bezierPoints: Array.isArray(e.bezierPoints)
          ? e.bezierPoints.slice(0, 4).map(Number)
          : null,
      }))
      .sort((x, y) => x.st - y.st);
    if (!src.length) return [];
    const segs = [],
      push = (st, et, a, b, easeEvent = null) => {
        if (et <= st) return;
        const N = 32,
          lut = new Float32Array(N + 1);
        let area = 0,
          prev = a;
        for (let i = 1; i <= N; i++) {
          const u = i / N,
            v = lerp(a, b, easeEvent ? eventEaseValue(easeEvent, u) : u);
          area += ((prev + v) * 0.5) / N;
          lut[i] = area;
          prev = v;
        }
        segs.push({ st, et, a, b, lut, area: area * (et - st), base: 0 });
      };
    let cursor = 0,
      last = 0;
    for (const e of src) {
      const st = Math.max(cursor, e.st),
        et = Math.max(st, e.et);
      if (st > cursor) push(cursor, st, last, last, null);
      push(st, et, e.a, e.b, useModernSpeed ? e : null);
      cursor = et;
      last = e.b;
    }
    push(cursor, 1e9, last, last, null);
    let base = 0;
    for (const e of segs) {
      e.base = base;
      base += e.area;
    }
    Object.defineProperty(segs, "_rpeStarts", {
      value: Float64Array.from(segs, (e) => e.st),
      configurable: true,
    });
    return segs;
  }
  function rpeSpeedPosition(segs, t) {
    if (!segs?.length || t <= 0) return 0;
    const a =
      segs._rpeStarts ||
      (segs._rpeStarts = Float64Array.from(segs, (e) => e.st));
    let idx = Number(segs._speedFastIndex),
      last = Number(segs._speedFastTime);
    if (
      !Number.isInteger(idx) ||
      !Number.isFinite(last) ||
      t < last ||
      t - last > 1.25
    ) {
      let lo = 0,
        hi = a.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (a[m] <= t) lo = m + 1;
        else hi = m;
      }
      idx = Math.max(0, lo - 1);
    } else while (idx + 1 < a.length && a[idx + 1] <= t) idx++;
    segs._speedFastIndex = idx;
    segs._speedFastTime = t;
    const e = segs[idx],
      dt = e.et - e.st,
      u = clamp((t - e.st) / Math.max(1e-9, dt), 0, 1),
      N = e.lut.length - 1,
      q = u * N,
      i = Math.min(N - 1, Math.floor(q)),
      f = q - i,
      part = lerp(e.lut[i], e.lut[i + 1], f) * dt;
    return e.base + part;
  }
  function rpeParseExtra(text) {
    if (!text) return [];
    try {
      const j = JSON.parse(text),
        bm = new BPMMap(j.bpm || j.BPMList || []),
        out = [];
      let id = 0;
      for (const e of j.effects || []) {
        const vars = {};
        for (const [k, v] of Object.entries(e.vars || {})) {
          const first = Array.isArray(v) ? v.find(Boolean) : null,
            vector = Array.isArray(first?.start) || Array.isArray(first?.end);
          vars[k] = vector
            ? rpeMapVectorEvents(v || [], bm, Math.max(2, first?.start?.length || first?.end?.length || 2))
            : rpeMapNumericEvents(v || [], bm);
        }
        const shader = String(e.shader || ""),
          kind = basename(shader).replace(/\.(glsl|frag|fs)$/i, "").toLowerCase();
        out.push({
          id: id++,
          shader,
          kind,
          st: bm.time(tripleBeat(e.start)),
          et: bm.time(tripleBeat(e.end)),
          global: e.global !== false,
          line: Number.isInteger(Number(e.line)) ? Number(e.line) : -1,
          order: Number(e.order || 0),
          vars,
        });
      }
      return out.sort((a, b) => a.st - b.st || a.order - b.order || a.id - b.id);
    } catch {
      return [];
    }
  }
  function rpeExtraValue(effect, name, time, def = 0) {
    const events = effect?.vars?.[name];
    return events?.length ? eventValueFast(events, time, def) : def;
  }
  function rpeExtraVector(effect, name, time, def = [0, 0], out = null) {
    const events = effect?.vars?.[name];
    return events?.length ? rpeVectorValueFast(events, time, def, out) : rpeVectorValueFast(null, time, def, out);
  }
  function detectRpeScaleUnit(meta, sourceLines) {
    const vals = [];
    for (const L of sourceLines || [])
      for (const key of ["scaleXEvents", "scaleYEvents"])
        for (const e of L?.extended?.[key] || []) {
          const a = Math.abs(Number(e.start)),
            b = Math.abs(Number(e.end));
          if (Number.isFinite(a) && a > 0) vals.push(a);
          if (Number.isFinite(b) && b > 0) vals.push(b);
        }
    if (!vals.length) return 1;
    vals.sort((a, b) => a - b);
    const median = vals[Math.floor(vals.length * 0.5)],
      q25 = vals[Math.floor(vals.length * 0.25)],
      percentLike = vals.reduce((n, v) => n + (v >= 10), 0),
      unitLike = vals.reduce((n, v) => n + (v <= 4), 0);
    return median >= 10 &&
      q25 > 2 &&
      percentLike >= vals.length * 0.6 &&
      unitLike <= vals.length * 0.2
      ? 0.01
      : 1;
  }
  function prepareSpeeds(events) {
    if (!events?.length) return events;
    if (events._speedStarts && events._speedStarts.length === events.length)
      return events;
    events.sort((a, b) => a.st - b.st);
    const starts = new Float64Array(events.length),
      base = new Float64Array(events.length),
      endPos = new Float64Array(events.length);
    let pos = 0,
      last = 0,
      val = Number(events[0]?.value ?? 1);
    for (let i = 0; i < events.length; i++) {
      const e = events[i],
        st = Number(e.st) || 0,
        en = Math.max(st, Number(e.et) || st),
        v = Number(e.value) || 0;
      if (st > last) pos += (st - last) * val;
      starts[i] = st;
      base[i] = pos;
      pos += (en - st) * v;
      endPos[i] = pos;
      last = en;
      val = v;
    }
    Object.defineProperties(events, {
      _speedStarts: { value: starts, configurable: true },
      _speedBase: { value: base, configurable: true },
      _speedEnd: { value: endPos, configurable: true },
    });
    return events;
  }
  function speedPosition(events, t) {
    if (!events?.length || t <= 0) return 0;
    prepareSpeeds(events);
    const a = events._speedStarts;
    if (t < a[0]) return t * Number(events[0].value || 0);
    let i = Number(events._speedFastIndex),
      last = Number(events._speedFastTime);
    if (
      !Number.isInteger(i) ||
      !Number.isFinite(last) ||
      t < last ||
      t - last > 1.25
    ) {
      let lo = 0,
        hi = a.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid] <= t) lo = mid + 1;
        else hi = mid;
      }
      i = Math.max(0, lo - 1);
    } else while (i + 1 < a.length && a[i + 1] <= t) i++;
    events._speedFastIndex = i;
    events._speedFastTime = t;
    const e = events[i],
      st = Number(e.st) || 0,
      en = Math.max(st, Number(e.et) || st),
      v = Number(e.value) || 0;
    if (t <= en) return events._speedBase[i] + (t - st) * v;
    return events._speedEnd[i] + (t - en) * v;
  }
  function buildPgrHeightTrack(rawEvents, ratio) {
    const events = (rawEvents || [])
      .filter((e) => Number(e.endTime) >= Number(e.startTime))
      .map((e) => ({
        st: Number(e.startTime) * ratio,
        et: Number(e.endTime) * ratio,
        value: Number(e.value) || 0,
      }))
      .sort((a, b) => a.st - b.st);
    if (!events.length) events.push({ st: 0, et: 1e9, value: 1 });
    events[0].st = 0;
    const starts = new Float64Array(events.length),
      positions = new Float64Array(events.length);
    let pos = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      starts[i] = e.st;
      positions[i] = pos;
      if (i + 1 < events.length) pos += (e.et - e.st) * e.value;
    }
    const at = (t) => {
      t = Math.max(0, Number(t) || 0);
      let lo = 0,
        hi = starts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= t) lo = mid + 1;
        else hi = mid;
      }
      const i = Math.max(0, lo - 1);
      if (i >= events.length - 1)
        return positions[i] + (t - starts[i]) * events[i].value;
      const span = starts[i + 1] - starts[i];
      if (span <= 1e-12) return positions[i + 1];
      const u = clamp((t - starts[i]) / span, 0, 1);
      return lerp(positions[i], positions[i + 1], u);
    };
    return { events, starts, positions, at };
  }
  function normalizeOffset(x) {
    x = Number(x) || 0;
    return Math.abs(x) > 10 ? x / 1000 : x;
  }
  function countMulti(notes) {
    const m = new Map();
    for (const n of notes) {
      const k = n.time.toFixed(6);
      m.set(k, (m.get(k) || 0) + 1);
    }
    for (const n of notes) n.multi = (m.get(n.time.toFixed(6)) || 0) > 1;
  }
  function markMultipleHints(chart) {
    const all = [];
    for (const L of chart.lines || [])
      for (const n of L.notes || []) {
        n.multi = false;
        if (!n.fake) all.push(n);
      }
    const m = new Map();
    for (const n of all) {
      const k = n.time.toFixed(6);
      m.set(k, (m.get(k) || 0) + 1);
    }
    for (const n of all) n.multi = (m.get(n.time.toFixed(6)) || 0) > 1;
    return chart;
  }

  function parsePGR(j) {
    const fv = Number(j.formatVersion);
    if (![1, 3, 3473].includes(fv))
      throw new Error(`暂不支持官方谱面 formatVersion=${j.formatVersion}`);
    const chart = {
      kind: "pgr",
      blockAreas: prepareNativeBlocks(j.blockAreaList),
      formatVersion: fv,
      offset: normalizeOffset(j.offset),
      lines: [],
      noteCount: 0,
      eventCount: 0,
    };
    for (const [li, L] of (j.judgeLineList || []).entries()) {
      const bpm = Number(L.bpm || 120);
      if (!(bpm > 0)) throw new Error(`第 ${li + 1} 条判定线 BPM 无效`);
      const ratio = 60 / 32 / bpm;
      const convE = (arr, map = (x) => x) =>
        prepareEvents(
          (arr || [])
            .filter((e) => Number(e.endTime) >= Number(e.startTime))
            .map((e) => ({
              st: Number(e.startTime) * ratio,
              et: Number(e.endTime) * ratio,
              a: map(Number(e.start)),
              b: map(Number(e.end)),
              ease: 1,
            })),
        );
      let moveX, moveY;
      if (fv === 1) {
        moveX = prepareEvents(
          (L.judgeLineMoveEvents || []).map((e) => ({
            st: Number(e.startTime) * ratio,
            et: Number(e.endTime) * ratio,
            a:
              (((Number(e.start) - (Number(e.start) % 1000)) / 1000) * 2 -
                880) /
              880,
            b:
              (((Number(e.end) - (Number(e.end) % 1000)) / 1000) * 2 - 880) /
              880,
            ease: 1,
          })),
        );
        moveY = prepareEvents(
          (L.judgeLineMoveEvents || []).map((e) => ({
            st: Number(e.startTime) * ratio,
            et: Number(e.endTime) * ratio,
            a: ((Number(e.start) % 1000) * 2 - 520) / 520,
            b: ((Number(e.end) % 1000) * 2 - 520) / 520,
            ease: 1,
          })),
        );
      } else {
        moveX = prepareEvents(
          (L.judgeLineMoveEvents || []).map((e) => ({
            st: Number(e.startTime) * ratio,
            et: Number(e.endTime) * ratio,
            a: -1 + Number(e.start) * 2,
            b: -1 + Number(e.end) * 2,
            ease: 1,
          })),
        );
        moveY = prepareEvents(
          (L.judgeLineMoveEvents || []).map((e) => ({
            st: Number(e.startTime) * ratio,
            et: Number(e.endTime) * ratio,
            a: -1 + Number(e.start2 || 0) * 2,
            b: -1 + Number(e.end2 || 0) * 2,
            ease: 1,
          })),
        );
      }
      const heightTrack = buildPgrHeightTrack(L.speedEvents || [], ratio),
        speeds = heightTrack.events;
      const floorAt = (t) => heightTrack.at(t);
      const notes = [];
      for (const [above, arr] of [
        [true, L.notesAbove || []],
        [false, L.notesBelow || []],
      ]) {
        for (const n of arr) {
          const type = Number(n.type),
            time = Number(n.time) * ratio,
            end = time + Number(n.holdTime || 0) * ratio,
            rawAlpha = Number(n.alpha ?? 1);
          // PGR compatibility rollback: Hold position and body length follow
          // the judge-line floor timeline. The per-note speed value is retained as
          // metadata only; multiplying 0 / 2.25 / 999 into Hold geometry caused
          // hidden/visible roles to swap, short Holds to stretch, and speedups.
          const noteSpeed = type === 3 ? 1 : Number(n.speed ?? 1),
            // Official PGR stores the Note's authored floorPosition. sim-phi
            // uses it directly; recomputing it from speed events introduces
            // float-rounding drift and changes charts that intentionally carry
            // corrected floor positions.
            floor = Number.isFinite(Number(n.floorPosition)) ? Number(n.floorPosition) : floorAt(time);
          const sourceSpeed = Number(n.speed ?? 1),
            nativeHoldHidden = type === 3 && Math.abs(sourceSpeed) < 1e-7;
          notes.push({
            id: `${li}-${notes.length}`,
            type,
            time,
            end,
            x: Number(n.positionX || 0) / 9,
            rawX: Number(n.positionX || 0),
            above,
            speed: noteSpeed,
            size: clamp(Number(n.size ?? 1) || 1, 0.05, 8),
            alpha: clamp(rawAlpha > 1 ? rawAlpha / 255 : rawAlpha, 0, 1),
            sourceSpeed,
            nativeHoldHidden,
            floor,
            // sim-phi renders Hold length from holdSeconds * note.speed, not
            // from the judge line's future speed-event integral.
            endFloor: type === 3 ? floor + (end - time) : floor,
            fake: Number(n.isFake ?? n.fake ?? 0) !== 0,
            visualCritical:
              type === 3 && (Math.abs(sourceSpeed) >= 6 || end - time < 0.03),
            // Community-observed official behavior permits a short Hold release
            // approximately equal to an eighth note in its timing group.
            holdGrace: clamp(30 / bpm, 0.04, 0.5),
            state: 0,
            judgeArea: Math.max(0.01, Number(n.judgeArea ?? 1) || 1),
            hitsound: n.hitsound || null,
            visibleTime: Number(n.visibleTime ?? 999999),
            yOffset: Number(n.yOffset || 0),
            tint: Array.isArray(n.tint) ? n.tint.slice(0, 3).map(Number) : null,
            fxTint: Array.isArray(n.tintHitEffects) ? n.tintHitEffects.slice(0, 3).map(Number) : null,
          });
        }
      }
      notes.sort((a, b) => a.time - b.time);
      countMulti(notes);
      const alpha = convE(L.judgeLineDisappearEvents || []),
        rotate = convE(L.judgeLineRotateEvents || []);
      chart.noteCount += notes.filter((note) => !note.fake).length;
      chart.eventCount +=
        moveX.length +
        moveY.length +
        rotate.length +
        alpha.length +
        speeds.length;
      const texture = String(L.Texture || L.texture || "").trim();
      chart.lines.push({
        id: li,
        notes,
        speeds,
        floorAt,
        _heightTrack: heightTrack,
        alpha,
        rotate,
        moveX,
        moveY,
        parent: Number.isInteger(L.father) && L.father >= 0 ? L.father : null,
        rotateWithParent: !!L.rotateWithFather,
        texture: texture && texture.toLowerCase() !== "line.png" ? texture : null,
        lineKind: texture && texture.toLowerCase() !== "line.png" ? "texture" : "normal",
        z: li,
      });
    }
    return chart;
  }
  function integrateSpeed(events, t) {
    return speedPosition(events, t);
  }

  function parsePEC(text) {
    const lines = text.split(/\r?\n/);
    let offset = null,
      bpmPairs = [],
      bpmMap = null,
      rawLines = [],
      lastNote = null;
    const getLine = (i) =>
      rawLines[i] ||
      (rawLines[i] = {
        notes: [],
        speed: [],
        alpha: [],
        rot: [],
        mx: [],
        my: [],
      });
    const ensureBpm = () =>
      bpmMap || (bpmMap = new BPMMap(bpmPairs.length ? bpmPairs : [[0, 120]]));
    for (let ln = 0; ln < lines.length; ln++) {
      const s = lines[ln].trim();
      if (!s) continue;
      const a = s.split(/\s+/);
      if (offset == null) {
        offset = Number(a[0]) / 1000 - 0.15;
        continue;
      }
      const cmd = a.shift();
      try {
        if (cmd === "bp") {
          if (bpmMap) throw new Error("bp 必须位于 Note/事件之前");
          bpmPairs.push([Number(a[0]), Number(a[1])]);
          continue;
        }
        if (/^n[1-4]$/.test(cmd)) {
          const bm = ensureBpm(),
            id = Number(a.shift()),
            L = getLine(id),
            time = bm.time(Number(a.shift()));
          let type = Number(cmd[1]),
            end = time;
          if (type === 2) end = bm.time(Number(a.shift()));
          const x = Number(a.shift()) / 1024,
            above = Number(a.shift()) === 1,
            fake = Number(a.shift()) === 1;
          const n = {
            id: `${id}-${L.notes.length}`,
            type: type === 2 ? 3 : type === 3 ? 4 : type === 4 ? 2 : 1,
            time,
            end,
            x,
            above,
            speed: 1,
            fake,
            visualCritical: fake,
            state: 0,
          };
          L.notes.push(n);
          lastNote = n;
          while (a.length) {
            const z = a.shift();
            if (z === "#") n.speed = Number(a.shift()) || 1;
            else if (z === "&") n.size = Number(a.shift()) || 1;
          }
          continue;
        }
        if (cmd === "#") {
          if (lastNote) lastNote.speed = Number(a[0]) || 1;
          continue;
        }
        if (cmd === "&") {
          if (lastNote) lastNote.size = Number(a[0]) || 1;
          continue;
        }
        if (
          /^c[vpd amrf]$/.test(cmd.replace(/\s/g, "")) ||
          /^c[vpdarmf]$/.test(cmd)
        ) {
          const bm = ensureBpm(),
            id = Number(a.shift()),
            L = getLine(id),
            st = bm.time(Number(a.shift()));
          const sub = cmd[1];
          if (sub === "v") {
            L.speed.push({ st, et: 1e9, value: Number(a.shift()) / 5.85 });
            continue;
          }
          if (sub === "p") {
            L.mx.push({
              st,
              et: st,
              a: (Number(a.shift()) / 2048) * 2 - 1,
              b: 0,
              ease: 1,
            });
            L.mx[L.mx.length - 1].b = L.mx[L.mx.length - 1].a;
            L.my.push({
              st,
              et: st,
              a: (Number(a.shift()) / 1400) * 2 - 1,
              b: 0,
              ease: 1,
            });
            L.my[L.my.length - 1].b = L.my[L.my.length - 1].a;
            continue;
          }
          if (sub === "d") {
            const v = -Number(a.shift());
            L.rot.push({ st, et: st, a: v, b: v, ease: 1 });
            continue;
          }
          if (sub === "a") {
            let v = Number(a.shift());
            if (v >= 0) v /= 255;
            L.alpha.push({ st, et: st, a: v, b: v, ease: 1 });
            continue;
          }
          if (sub === "m") {
            const et = bm.time(Number(a.shift())),
              x = (Number(a.shift()) / 2048) * 2 - 1,
              y = (Number(a.shift()) / 1400) * 2 - 1,
              easeId = Number(a.shift()) || 1;
            L.mx.push({ st, et, a: null, b: x, ease: easeId });
            L.my.push({ st, et, a: null, b: y, ease: easeId });
            continue;
          }
          if (sub === "r") {
            const et = bm.time(Number(a.shift())),
              v = -Number(a.shift()),
              easeId = Number(a.shift()) || 1;
            L.rot.push({ st, et, a: null, b: v, ease: easeId });
            continue;
          }
          if (sub === "f") {
            const et = bm.time(Number(a.shift())),
              v = Number(a.shift()) / 255;
            L.alpha.push({ st, et, a: null, b: v, ease: 1 });
            continue;
          }
        }
        throw new Error(`未知命令 ${cmd}`);
      } catch (e) {
        throw new Error(`PEC 第 ${ln + 1} 行：${e.message}`);
      }
    }
    const chart = { kind: "pec", offset: offset || 0, lines: [], noteCount: 0 };
    for (let i = 0; i < rawLines.length; i++) {
      const R = rawLines[i] || {
        notes: [],
        speed: [],
        alpha: [],
        rot: [],
        mx: [],
        my: [],
      };
      fixEventStarts(R.alpha, 1);
      fixEventStarts(R.rot, 0);
      fixEventStarts(R.mx, 0);
      fixEventStarts(R.my, 0);
      R.speed.sort((a, b) => a.st - b.st);
      if (!R.speed.length) R.speed = [{ st: 0, et: 1e9, value: 1 }];
      for (let k = 0; k < R.speed.length; k++)
        R.speed[k].et = R.speed[k + 1]?.st ?? 1e9;
      const floorAt = (t) => integrateSpeed(R.speed, t);
      for (const n of R.notes) {
        n.floor = floorAt(n.time);
        n.endFloor = floorAt(n.end);
      }
      countMulti(R.notes);
      chart.noteCount += R.notes.filter((note) => !note.fake).length;
      chart.lines.push({
        id: i,
        notes: R.notes,
        speeds: R.speed,
        floorAt,
        alpha: R.alpha,
        rotate: R.rot,
        moveX: R.mx,
        moveY: R.my,
        parent: null,
        texture: null,
      });
    }
    return chart;
  }
  function fixEventStarts(arr, def) {
    arr.sort((a, b) => a.st - b.st);
    let v = def;
    for (const e of arr) {
      if (e.a == null) e.a = v;
      v = e.b;
    }
  }


  /**
   * RPE 的 above 是枚举而不是布尔值：0=线下、1=线上、2=反向/特殊线下。
   * 运行时同时保存原始枚举、运动符号与贴图朝向，避免在渲染/判定中反复补负号。
   */
  function normalizeRpeAbove(raw) {
    let mode = Number(raw);
    if (mode !== 0 && mode !== 1 && mode !== 2) mode = 1;
    const directionSign = mode === 1 ? -1 : 1;
    return { mode, directionSign, faceFlip: mode !== 1 };
  }
  function normalizeNoteDirection(note, chartKind) {
    if (chartKind === "rpe") {
      const info = normalizeRpeAbove(note.aboveMode ?? note.above);
      note.aboveMode = info.mode;
      note.directionSign = info.directionSign;
      note.faceFlip = info.faceFlip;
      note.above = info.directionSign < 0;
    } else {
      const above = !!note.above;
      note.aboveMode = above ? 1 : 0;
      note.directionSign = above ? -1 : 1;
      note.faceFlip = !above;
    }
    return note;
  }
  function normalizeParentGraph(chart) {
    const lines = chart?.lines || [], state = new Uint8Array(lines.length), stack = [];
    const visit = (index) => {
      const line = lines[index];
      if (!line) return;
      if (state[index] === 2) return;
      if (state[index] === 1) {
        const at = stack.indexOf(index), cycle = (at >= 0 ? stack.slice(at) : stack.slice()).concat(index);
        for (const id of cycle) if (lines[id]) lines[id].parent = null;
        Diagnostics.warn("ChartParser.parent", "检测到父子判定线循环，已将循环成员降级为根判定线", { cycle });
        return;
      }
      state[index] = 1; stack.push(index);
      const parent = line.parent;
      if (parent != null) {
        if (!Number.isInteger(parent) || parent < 0 || parent >= lines.length || parent === index) {
          Diagnostics.warn("ChartParser.parent", "父判定线不存在或为自身，已按无父线模式继续", { lineIndex:index, parent });
          line.parent = null;
        } else visit(parent);
      }
      stack.pop(); state[index] = 2;
    };
    for (let i=0;i<lines.length;i++) visit(i);
    return chart;
  }
  function compatibilityNormalizeChart(chart) {
    chart.rawKind = chart.kind;
    chart.modelVersion = 2;
    let fakeCount = 0, parentCount = 0;
    const aboveDistribution = {0:0,1:0,2:0};
    for (const line of chart.lines || []) {
      if (line.parent != null) parentCount++;
      line.lineLength = Math.max(0.01, Number(line.lineLength || 6));
      for (const note of line.notes || []) {
        normalizeNoteDirection(note, chart.kind);
        if (note.fake) fakeCount++;
        if (Object.prototype.hasOwnProperty.call(aboveDistribution,note.aboveMode)) aboveDistribution[note.aboveMode]++;
      }
    }
    normalizeParentGraph(chart);
    chart.compatibilityReport = {
      format: chart.kind,
      notes: (chart.lines || []).reduce((sum,line)=>sum+(line.notes?.length||0),0),
      judgeLines: chart.lines?.length || 0,
      parentLines: parentCount,
      fakeNotes: fakeCount,
      aboveDistribution,
      parserVersion: PHI_VERSIONS.parser,
    };
    Diagnostics.info("ChartParser.normalizer", "谱面已转换为统一内部模型", chart.compatibilityReport);
    return chart;
  }
  function pgrLineHalfToWorld(lineLength, referenceWidth) {
    // lineLength scales the authored half-line. Default 6 maps to half of the
    // 4374 px reference texture; it does not grow with ultrawide viewport width.
    return (
      (Math.max(0.01, Number(lineLength) || PGR_LINE_DEFAULT_HALF_LENGTH) /
        PGR_LINE_DEFAULT_HALF_LENGTH) *
      Math.max(1, referenceWidth) *
      (PGR_LINE_REFERENCE_TEXTURE_WIDTH / PGR_LINE_REFERENCE_WIDTH) *
      0.5
    );
  }
  function chartLineLengthToWorld(lineLength, referenceWidth) {
    // RPE 自身的 lineLength 事件继续沿用现有比例，避免把 PGR 包信息
    // 的半长单位错误套入 RPE 动态线长事件。
    return (
      (Math.max(0.01, Number(lineLength) || 6) / 6) *
      Math.max(1, referenceWidth) *
      3
    );
  }
  function resolveLineEndpoints(lineState, lineLength, viewportWidth, scaleX = 1, out = null) {
    const target = out || {x1:0,y1:0,x2:0,y2:0,half:0};
    const half = chartLineLengthToWorld(lineLength, viewportWidth) * 0.5 * Math.abs(Number(scaleX) || 0);
    target.half = half;
    target.x1 = lineState.cx - lineState.ux * half; target.y1 = lineState.cy - lineState.uy * half;
    target.x2 = lineState.cx + lineState.ux * half; target.y2 = lineState.cy + lineState.uy * half;
    return target;
  }

  function parseRPE(j, settings = {}) {
    const meta = j.META || j.meta || {},
      bm = new BPMMap(j.BPMList || j.bpmList || []),
      rpeVersion = Number(meta.RPEVersion ?? meta.rpeVersion ?? 160) || 160,
      useModernSpeed = settings.useRpe170Speed === false ? false : (settings.useRpe170Speed === true || rpeVersion >= 170),
      chart = {
        kind: "rpe",
        rpeVersion,
        useModernSpeed,
        offset: normalizeOffset(meta.offset || j.offset || 0),
        lines: [],
        noteCount: 0,
        rpeMeta: meta,
      };
    const sourceLines = j.judgeLineList || [],
      scaleUnit = detectRpeScaleUnit(meta, sourceLines);
    for (const [li, L] of sourceLines.entries()) {
      const layers = (L.eventLayers || []).filter(Boolean),
        extended = L.extended || {};
      const layerEvents = (key, scale = 1) =>
        layers
          .map((x) => rpeMapNumericEvents(x?.[key] || [], bm, scale))
          .filter((x) => x.length);
      const speedLayers = layers
        .map((x) => rpeBuildSpeedLayer(x?.speedEvents || [], bm, useModernSpeed))
        .filter((x) => x.length);
      const floorAt = (t) => {
        let v = 0;
        for (const sp of speedLayers) v += rpeSpeedPosition(sp, t);
        return v;
      };
      const notes = [];
      for (const n of L.notes || []) {
        const startBeat = tripleBeat(n.startTime),
          endBeat = tripleBeat(n.endTime),
          time = bm.time(startBeat),
          end = bm.time(endBeat),
          fake = Number(n.isFake || 0) !== 0,
          aboveInfo = normalizeRpeAbove(n.above);
        notes.push({
          id: `${li}-${notes.length}`,
          type: { 1: 1, 2: 3, 3: 4, 4: 2 }[Number(n.type)] || Number(n.type),
          time,
          end,
          x: Number(n.positionX || 0) / 675,
          above: aboveInfo.directionSign < 0,
          aboveMode: aboveInfo.mode,
          directionSign: aboveInfo.directionSign,
          faceFlip: aboveInfo.faceFlip,
          speed: Number(n.speed || 1),
          size: Number(n.size || 1),
          alpha: clamp(Number(n.alpha ?? 255) / 255, 0, 1),
          fake,
          visualCritical: fake,
          holdGrace: clamp(30 / bm.bpmAt(startBeat), 0.04, 0.5),
          state: 0,
          floor: floorAt(time),
          endFloor: floorAt(end),
          hitsound: n.hitsound || null,
          visibleTime: Number(n.visibleTime ?? 999999),
          yOffset: Number(n.yOffset || 0),
          judgeArea: Number(n.judgeArea ?? 1),
          tint: Array.isArray(n.tint) ? n.tint : null,
          fxTint: Array.isArray(n.tintHitEffects) ? n.tintHitEffects : null,
        });
      }
      countMulti(notes);
      chart.noteCount += notes.filter((n) => !n.fake).length;
      const texture = String(L.Texture || L.texture || "line.png"),
        textEvents = rpeMapTextEvents(extended.textEvents || [], bm),
        attachUI = L.attachUI ? String(L.attachUI) : null;
      const lineKind =
        texture === "line.png"
          ? textEvents.length
            ? "text"
            : "normal"
          : "texture";
      chart.lines.push({
        id: li,
        notes,
        speeds: speedLayers.flat(),
        speedLayers,
        floorAt,
        alphaLayers: layerEvents("alphaEvents", 1 / 255),
        rotateLayers: layerEvents("rotateEvents", -1),
        moveXLayers: layerEvents("moveXEvents", 1 / 675),
        moveYLayers: layerEvents("moveYEvents", 1 / 450),
        alpha: [],
        rotate: [],
        moveX: [],
        moveY: [],
        scaleX: rpeMapNumericEvents(extended.scaleXEvents || [], bm, scaleUnit),
        scaleY: rpeMapNumericEvents(extended.scaleYEvents || [], bm, scaleUnit),
        lineLength: Math.max(0.01, Number(L.lineLength ?? meta.lineLength ?? 6) || 6),
        lineLengthEvents: rpeMapNumericEvents(extended.lineLengthEvents || [], bm, 1),
        incline: rpeMapNumericEvents(extended.inclineEvents || [], bm),
        color: rpeMapColorEvents(extended.colorEvents || [], bm),
        text: textEvents,
        parent: Number.isInteger(Number(L.father)) && Number(L.father) >= 0 ? Number(L.father) : null,
        rotateWithParent: !!L.rotateWithFather,
        texture: lineKind === "texture" ? texture : null,
        lineKind,
        attachUI,
        showBelow: Number(L.isCover) !== 1,
        // PhiZone-compatible explicit zIndex takes precedence when present;
        // otherwise preserve the standard RPE zOrder.
        z: Number.isFinite(Number(L.zIndex)) ? Number(L.zIndex) : Number(L.zOrder || 0),
        name: String(L.Name || L.name || ""),
        paint: rpeMapNumericEvents(extended.paintEvents || [], bm),
        gif: rpeMapNumericEvents(extended.gifEvents || [], bm),
        posControl: Array.isArray(L.posControl) ? L.posControl : [],
        sizeControl: Array.isArray(L.sizeControl) ? L.sizeControl : [],
        alphaControl: Array.isArray(L.alphaControl) ? L.alphaControl : [],
        yControl: Array.isArray(L.yControl) ? L.yControl : [],
        isRPE: true,
      });
    }
    return chart;
  }
  // Native SUS reader. The channel and two-digit token supply actual lane and
  // width; no position or width is synthesized. Supports BPM maps, time signatures,
  // taps, flicks, traces, directional overlaps and slide relay paths. Other SUS
  // extensions remain outside the supported subset and are described in Help.
  // Independent SUS reader. Semantics checked against Next-SEKAI's MIT
  // analyze/convert modules; credits and license are embedded in this document.
  function makePjskChart(notes, properties = {}) {
    notes.sort((a,b)=>a.time-b.time || a._pjskLane-b._pjskLane);
    const fixed = v => prepareEvents([{st:0,et:1e9,a:v,b:v,ease:1}]);
    for (const n of notes) {
      n.x=((n._pjskLane+.5)/12*2-1)*.84;
      n.above=true; n.speed=1; n.sourceSpeed=1; n.alpha=1; n.size=1;
      n.state=0; n.floor=n.time*PJSK_FLOOR_RATE;
      n.endFloor=n.end*PJSK_FLOOR_RATE;
      n.fake=!!n._pjskGuide;
    }
    countMulti(notes.filter(n=>!n.fake));
    return {kind:'pjsk',pjskLaneCount:12,offset:0,eventCount:4,
      noteCount:notes.reduce((sum,n)=>sum+(n.fake?0:n.type===3?
        (n._pjskHeadHidden?0:1)+(n._pjskTicks?.length||0)+(n._pjskTailHidden?0:1):1),0),
      lines:[{id:0,notes,speeds:prepareSpeeds([{st:0,et:1e9,value:PJSK_FLOOR_RATE}]),
        floorAt:t=>t*PJSK_FLOOR_RATE,alpha:fixed(1),rotate:fixed(0),
        moveX:fixed(0),moveY:fixed(-.7),parent:null,rotateWithParent:false,
        texture:null,lineKind:'normal',z:0}],...properties};
  }
  function parseSUS(text) {
    const bpmDefs=new Map(),bars=new Map([[0,4]]),rows=[],tils=new Map(),meta={},warnings=new Set();
    let measureBase=0,ticksPerBeat=480,selectedTil='',serial=0,maxMeasure=0;
    const unquote=s=>s.replace(/^"|"$/g,'');
    for (const [lineNumber,raw] of String(text).replace(/^\uFEFF/,'').split(/\r?\n/).entries()) {
      const line=raw.trim(); if(!line.startsWith('#'))continue;
      let m=/^#MEASUREBS\s+(-?\d+)/i.exec(line);
      if(m){measureBase=Number(m[1]);continue;}
      m=/^#REQUEST\s+"ticks_per_beat\s+(\d+)"/i.exec(line);
      if(m){ticksPerBeat=Math.max(1,Number(m[1]));continue;}
      m=/^#BPM([\da-z]{2})\s*:\s*(\S+)/i.exec(line);
      if(m){const bpm=Number(m[2]);if(!(bpm>0))throw new Error(`SUS 第 ${lineNumber+1} 行 BPM 无效`);bpmDefs.set(m[1].toUpperCase(),bpm);continue;}
      m=/^#TIL([\da-z]{2})\s*:\s*"(.*)"/i.exec(line);
      if(m){tils.set(m[1].toUpperCase(),{data:m[2],base:measureBase});continue;}
      m=/^#HISPEED\s+([\da-z]{2})/i.exec(line);
      if(m){selectedTil=m[1].toUpperCase();continue;}
      m=/^#(\d{3})([\da-z]{2,3})\s*:\s*([^;]*)/i.exec(line);
      if(m){
        const measure=Number(m[1])+measureBase,channel=m[2].toLowerCase(),data=m[3].trim().toLowerCase();
        if(measure<0||measure>100000)throw new Error('SUS 小节编号超出可用范围');
        maxMeasure=Math.max(maxMeasure,measure);
        if(channel==='02'){const beats=Number(data);if(!(beats>0))throw new Error('SUS 小节长度无效');bars.set(measure,beats);continue;}
        if(data.length%2||!/^[\da-z]+$/.test(data)){warnings.add(`第 ${lineNumber+1} 行数据无效，已跳过`);continue;}
        for(let i=0;i<data.length;i+=2)if(data.slice(i,i+2)!=='00')rows.push({measure,channel,token:data.slice(i,i+2),part:i/data.length});
        continue;
      }
      m=/^#(\w+)\s+(.*)/.exec(line);if(m)meta[m[1].toUpperCase()]=unquote(m[2]);
    }
    const chosen=tils.get(selectedTil)||tils.values().next().value;
    const rawScroll=[];
    if(chosen)for(const part of chosen.data.split(',')){
      const m=/^\s*(\d+)'([\d.]+)\s*:\s*(-?[\d.]+)\s*$/.exec(part);
      if(!m){warnings.add('存在无法解析的变速项');continue;}
      const measure=Number(m[1])+chosen.base;
      if(measure<0||measure>100000)throw new Error('SUS 变速小节无效');
      maxMeasure=Math.max(maxMeasure,measure);rawScroll.push({measure,tick:Number(m[2]),value:Number(m[3])});
    }
    const starts=new Float64Array(maxMeasure+2);let beats=4;
    for(let m=0;m<=maxMeasure;m++){if(bars.has(m))beats=bars.get(m);starts[m+1]=starts[m]+beats;}
    for(const r of rows)r.beat=starts[r.measure]+r.part*(starts[r.measure+1]-starts[r.measure]);
    const bpmChanges=[];
    for(const r of rows)if(r.channel==='08'){
      const bpm=bpmDefs.get(r.token.toUpperCase());if(!bpm)throw new Error(`SUS BPM${r.token.toUpperCase()} 未定义`);
      bpmChanges.push([r.beat,bpm]);
    }
    const tempo=new BPMMap([[0,bpmChanges.find(x=>x[0]===0)?.[1]||bpmDefs.get('01')||Number(meta.BPM)||120],...bpmChanges]);
    const key=p=>`${Math.round(p.beat*ticksPerBeat*1000)}:${p.left}`;
    const taps=[],mods=new Map(),streams=new Map();
    for(const r of rows){
      if(!/^[1359]/.test(r.channel)||r.channel.length<2)continue;
      const family=r.channel[0],left=parseInt(r.channel[1],36)-2,span=parseInt(r.token[1],36),type=parseInt(r.token[0],36);
      // Standard SEKAI stage is SUS lanes 2..13. Skill/fever lanes 0,1,14,15 do not affect the origin.
      if(left<0||left>=12)continue;
      if(!(span>0)||left+span>12){warnings.add('存在超出舞台的音符宽度，已跳过');continue;}
      const p={beat:r.beat,time:tempo.time(r.beat),left,lane:left+(span-1)/2,span,type};
      if(family==='1'){
        taps.push(p);const mod=mods.get(key(p))||{};
        if(type===2||type===6||type===8)mod.critical=true;
        if(type===5||type===6)mod.trace=true;
        if(type===3)mod.removeTick=true;
        if(type===7||type===8)mod.hideEndpoint=true;
        mods.set(key(p),mod);
      }else if(family==='5'){
        const mod=mods.get(key(p))||{};
        if([1,3,4].includes(type))mod.direction=type===3?'left':type===4?'right':'up';
        if([2,5,6].includes(type))mod.ease=type===2?'in':'out';
        mods.set(key(p),mod);
      }else if(r.channel.length===3){
        const id=family+':'+r.channel[2];if(!streams.has(id))streams.set(id,[]);streams.get(id).push(p);
      }
    }
    const notes=[],prevent=new Set(),seen=new Set();
    for(const [id,points] of streams){
      points.sort((a,b)=>a.beat-b.beat);let path=[];
      for(const p of points){
        if(p.type===1)path=[p];else if(path.length)path.push(p);
        if(p.type!==2||path.length<2)continue;
        const head=path[0],tail=p,guide=id[0]==='9',duration=tail.time-head.time;
        if(duration<=0){warnings.add('存在零长度滑键，已跳过');path=[];continue;}
        const startMod=mods.get(key(head))||{},endMod=mods.get(key(tail))||{};
        const anchors=path.filter(q=>[1,2,3,5].includes(q.type)).map(q=>({u:(q.time-head.time)/duration,lane:q.lane,span:q.span,ease:mods.get(key(q))?.ease||'linear',time:q.time,beat:q.beat,type:q.type}));
        const ticks=[];
        if(!guide){
          for(const q of path)if([1,2,3,5].includes(q.type))prevent.add(key(q));
          for(const q of path)if(q.type===3&&!mods.get(key(q))?.removeTick)ticks.push({time:q.time,u:(q.time-head.time)/duration,visible:true});
          for(let beat=Math.ceil((head.beat+1e-7)*2)/2;beat<tail.beat-1e-7;beat+=.5){
            const time=tempo.time(beat);
            if(!ticks.some(t=>Math.abs(t.time-time)<1e-6))ticks.push({time,u:(time-head.time)/duration,visible:false});
          }
          ticks.sort((a,b)=>a.time-b.time);
        }
        notes.push({id:`sus-slide-${serial++}`,type:3,time:head.time,end:tail.time,
          _pjskLane:head.lane,_pjskSpan:head.span,_pjskPath:anchors,
          _pjskTailLane:tail.lane,_pjskTicks:ticks,_pjskGuide:guide,
          _pjskHeadHidden:!!startMod.hideEndpoint,_pjskHeadTrace:!!startMod.trace,
          _pjskTailHidden:!!endMod.hideEndpoint,_pjskTailDirection:endMod.direction||null,
          visualCritical:!!startMod.critical,holdGrace:.083333});
        path=[];
      }
      if(path.length)warnings.add('存在未闭合滑键，已跳过');
    }
    for(const p of taps){
      if(![1,2,5,6].includes(p.type)||prevent.has(key(p))||seen.has(key(p)))continue;
      seen.add(key(p));const mod=mods.get(key(p))||{};
      notes.push({id:`sus-${serial++}`,type:mod.direction?4:mod.trace?2:1,
        time:p.time,end:p.time,_pjskLane:p.lane,_pjskSpan:p.span,
        _pjskDirection:mod.direction||null,visualCritical:!!mod.critical});
    }
    if(!notes.some(n=>!n._pjskGuide))throw new Error('SUS 没有可游玩的音符');
    const scrollEvents=[{time:0,value:1},...rawScroll.map(r=>({time:tempo.time(starts[r.measure]+r.tick/ticksPerBeat),value:r.value}))].sort((a,b)=>a.time-b.time);
    const scroll=[];let position=0;
    for(const e of scrollEvents){const prev=scroll[scroll.length-1];if(prev)position=prev.position+(e.time-prev.time)*prev.value;
      if(prev&&Math.abs(prev.time-e.time)<1e-9)scroll.pop();scroll.push({...e,position});}
    const scrollAt=t=>{let lo=0,hi=scroll.length;while(lo<hi){const mid=(lo+hi)>>1;if(scroll[mid].time<=t)lo=mid+1;else hi=mid;}const e=scroll[Math.max(0,lo-1)];return e.position+(t-e.time)*e.value;};
    const waveOffset=Number(meta.WAVEOFFSET)||0;
    return makePjskChart(notes,{sourceKind:'sus',nativePjsk:true,
      // This engine uses chartTime=musicTime-offset, the inverse convention of USC.offset.
      offset:waveOffset,scrollAt,scrollEvents:scroll,scrollVariable:scroll.length>1,
      susMeta:meta,compatibilityReport:{format:'sus-native',notes:notes.length,lanes:12,ticksPerBeat,
        warnings:[...warnings],parserVersion:PHI_VERSIONS.parser}});
  }

  function parseChart(kind, text, j, settings = {}) {
    let chart;
    if (kind === "pgr") chart = parsePGR(j || JSON.parse(text));
    else if (kind === "rpe") chart = parseRPE(j || JSON.parse(text), settings);
    else if (kind === "pec") chart = parsePEC(text);
    else if (kind === "sus") return parseSUS(text);
    else throw new Error("不支持的谱面类型");
    return markMultipleHints(compatibilityNormalizeChart(chart));
  }
  function applyRecordChartMetadata(chart, record) {
    if (!chart || !record) return chart;
    const packageOffset = normalizeOffset(record.meta?.offset || 0);
    if (packageOffset) chart.offset = (Number(chart.offset) || 0) + packageOffset;
    const baseDir = record.assetBaseDir || archiveDirname(record.chartFileName || ""),
      resources = [...(record.assets || []), ...(record.supplementalFiles || [])];
    for (const line of chart.lines || []) {
      if (line.texture) {
        const resource = byNameFrom(resources, line.texture, baseDir);
        if (resource) line.texture = resource.name;
      }
      for (const note of line.notes || []) if (note.hitsound) {
        const resource = byNameFrom(resources, note.hitsound, baseDir);
        if (resource) note.hitsound = resource.name;
      }
    }
    let applied = 0;
    for (const spec of record.lineTextureSpecs || []) {
      const line = chart.lines?.[Math.trunc(Number(spec.lineId))];
      if (!line || !spec.image) continue;
      line.texture = String(spec.image);
      line.lineKind = "texture";
      line.lineCsv = {
        scale: Number(spec.scale) || 1,
        aspect: Number(spec.aspect) || 1,
        useBackgroundDim: !!spec.useBackgroundDim,
        useLineColor: !!spec.useLineColor,
        useLineScale: spec.useLineScale !== false,
      };
      applied++;
    }
    chart.packageMeta = record.meta || {};
    chart.compatibilityReport ||= {};
    chart.compatibilityReport.lineCsvOverrides = applied;
    chart.compatibilityReport.packageOffset = packageOffset;
    return chart;
  }


  // PJSK fixed-lane mode. Perspective/approach behavior follows the public MIT
  // Next-SEKAI Sonolus engine model (APPROACH_SCALE = 1.06^-45 and widening
  // stage geometry). Visual sprites/effects below are dedicated embedded recreations.
  // 51.1: lane-relative AUTO Note sizing, persistent Hold ribbons, cached stage,
  // and a lightweight PJSK-specific hit burst designed for 120-Hz-capable displays.
  const PJSK_APPROACH_SCALE = 1.06 ** -45,
    PJSK_FLOOR_RATE = 0.70,
    PJSK_DEFAULT_LANES = 12,
    PJSK_MIN_LANES = 2,
    PJSK_MAX_LANES = 24,
    PJSK_HIT_FX_DURATION = 0.36,
    PJSK_HOLD_FX_INTERVAL = 0.30;
  function pjskLinePose(chart, L, t, cache = new Map(), busy = new Set()) {
    if (cache.has(L.id)) return cache.get(L.id);
    if (busy.has(L.id)) return { x:0, rot:0 };
    busy.add(L.id);
    let x = L.moveXLayers ? rpeLayerValueFast(L.moveXLayers, t, 0) : eventValueFast(L.moveX, t, 0),
      rot = L.rotateLayers ? rpeLayerValueFast(L.rotateLayers, t, 0) : eventValueFast(L.rotate, t, 0);
    if (L.parent != null && chart.lines[L.parent]) {
      const p = pjskLinePose(chart, chart.lines[L.parent], t, cache, busy);
      x += p.x;
      if (L.rotateWithParent) rot += p.rot;
    }
    const out = { x, rot };
    cache.set(L.id, out); busy.delete(L.id); return out;
  }
  function pjskSourceX(chart, L, n, time = n.time) {
    const pose = pjskLinePose(chart, L, time), r = (-pose.rot * Math.PI) / 180,
      local = Number(n.x || 0) * 1.0125;
    return clamp(pose.x + Math.cos(r) * local, -1.25, 1.25);
  }
  function pjskPathValue(n,progress,property) {
    const path=n._pjskPath,u=clamp(progress,0,1);if(!path?.length)return null;
    for(let i=1;i<path.length;i++)if(u<=path[i].u){
      const a=path[i-1],b=path[i];let v=clamp((u-a.u)/Math.max(1e-8,b.u-a.u),0,1);
      if(a.ease==='in')v=v*v;else if(a.ease==='out')v=1-(1-v)**2;
      return lerp(a[property],b[property],v);
    }
    return path[path.length-1][property];
  }

  function pjskSlideSpan(n,progress){return pjskPathValue(n,progress,'span')??(Number(n._pjskSpan)||1);}
  function pjskSlideLane(n, progress) {
    const authored=pjskPathValue(n,progress,'lane');if(authored!==null)return authored;
    const u = clamp(progress, 0, 1), v = 1 - u,
      start = Number(n._pjskLane) || 0,
      end = Number.isFinite(n._pjskTailLane) ? n._pjskTailLane : start,
      mid = Number.isFinite(n._pjskMidLane) ? n._pjskMidLane : (start + end) * 0.5;
    return v * v * start + 2 * v * u * mid + u * u * end;
  }
  function convertChartToPjsk(sourceChart, requestedLanes = PJSK_DEFAULT_LANES) {
    if(sourceChart.kind==='pjsk')return sourceChart;
    const lanes=clamp(Math.round(Number(requestedLanes)||12),2,24),span=lanes>=8?2:1;
    const source=[],warnings=[],reservations=[];
    for(const L of sourceChart.lines||[])for(const n of L.notes||[]){
      if(n.fake)continue;
      const sx=pjskSourceX(sourceChart,L,n),target=clamp((sx+1)*lanes/2-.5,(span-1)/2,lanes-1-(span-1)/2);
      source.push({n,target,seed:source.length});
    }
    source.sort((a,b)=>a.n.time-b.n.time||a.target-b.target||a.seed-b.seed);
    const notes=[];
    for(let i=0;i<source.length;){
      let j=i+1;while(j<source.length&&Math.abs(source[j].n.time-source[i].n.time)<.001)j++;
      const group=source.slice(i,j).sort((a,b)=>a.target-b.target||a.seed-b.seed),time=group[0].n.time;
      for(let r=reservations.length-1;r>=0;r--)if(reservations[r].end<=time+.03)reservations.splice(r,1);
      const slots=[];for(let left=0;left<=lanes-span;left+=span)slots.push(left+(span-1)/2);
      const free=slots.filter(lane=>!reservations.some(r=>Math.abs(r.lane-lane)<span));
      const candidates=free.length>=group.length?free:slots;
      // Monotone minimum-cost matching preserves left/right ordering of a chord.
      const dp=Array.from({length:group.length+1},()=>Array(candidates.length+1).fill(Infinity)),take=dp.map(row=>row.map(()=>false));
      dp[0].fill(0);
      for(let a=1;a<=group.length;a++)for(let b=1;b<=candidates.length;b++){
        dp[a][b]=dp[a][b-1];const cost=dp[a-1][b-1]+(group[a-1].target-candidates[b-1])**2;
        if(cost<dp[a][b]){dp[a][b]=cost;take[a][b]=true;}
      }
      const assigned=[];let a=group.length,b=candidates.length;
      if(Number.isFinite(dp[a][b]))while(a>0&&b>0){if(take[a][b]){assigned[a-1]=candidates[b-1];a--;}b--;}
      else warnings.push(`在 ${time.toFixed(3)} 秒有超过可用轨道数量的和弦`);
      if(free.length<group.length&&reservations.length)warnings.push(`在 ${time.toFixed(3)} 秒有长按与和弦重叠`);
      for(let k=0;k<group.length;k++){
        const item=group[k],n=item.n,lane=assigned[k]??slots[Math.min(slots.length-1,Math.round(item.target/span))];
        const end=Math.max(n.time,Number(n.end)||n.time),ticks=[];
        if(n.type===3)for(let t=n.time+.25;t<end-.04;t+=.25)ticks.push({time:t,u:(t-n.time)/(end-n.time),visible:false});
        notes.push({...n,id:`pjsk-${n.id}`,time:n.time,end,type:n.type,
          _pjskLane:lane,_pjskSpan:span,_pjskTailLane:lane,_pjskMidLane:lane,
          _pjskTicks:ticks,visualCritical:false,nativeHoldHidden:false,
          directionSign:-1,speed:1,sourceSpeed:1,holdGrace:1/12});
        if(n.type===3)reservations.push({lane,end});
      }
      i=j;
    }
    const chart=makePjskChart(notes,{sourceKind:sourceChart.kind,pjskLaneCount:lanes,
      offset:Number(sourceChart.offset)||0,packageMeta:sourceChart.packageMeta||{},
      compatibilityReport:{format:'pjsk-arrangement',sourceFormat:sourceChart.kind,
        lanes,width:span,warnings:[...new Set(warnings)],parserVersion:PHI_VERSIONS.parser}});
    for(const n of notes)n.x=((n._pjskLane+.5)/lanes*2-1)*.84;
    return chart;
  }

  function pjskRoundRect(g,x,y,w,h,r){
    if (typeof g.roundRect === "function") { g.roundRect(x,y,w,h,r); return; }
    const q=Math.min(r,w*.5,h*.5); g.moveTo(x+q,y); g.lineTo(x+w-q,y); g.quadraticCurveTo(x+w,y,x+w,y+q); g.lineTo(x+w,y+h-q); g.quadraticCurveTo(x+w,y+h,x+w-q,y+h); g.lineTo(x+q,y+h); g.quadraticCurveTo(x,y+h,x,y+h-q); g.lineTo(x,y+q); g.quadraticCurveTo(x,y,x+q,y);
  }
  function makePjskNoteTexture(kind) {
    const cv=document.createElement('canvas');cv.width=384;cv.height=64;
    const g=cv.getContext('2d');
    const palette=kind==='critical'?['#b88e28','#ffe48a','#fff8db','#d6a847']:kind==='flick'?['#bc6b9b','#ffe0f5','#fff3fc','#ef91c8']:kind==='slide'||kind==='trace'?['#439f88','#c6ffdf','#effff4','#72ebc1']:['#9781b9','#e6dafa','#faf5ff','#6cdcec'];
    g.fillStyle=palette[0];g.beginPath();pjskRoundRect(g,0,1,384,62,5);g.fill();
    g.fillStyle=palette[1];g.beginPath();pjskRoundRect(g,4,4,376,55,3);g.fill();
    const fill=g.createLinearGradient(0,8,0,52);fill.addColorStop(0,palette[2]);fill.addColorStop(1,palette[1]);
    g.fillStyle=fill;g.fillRect(9,8,366,43);
    g.fillStyle=palette[0];g.fillRect(11,16,17,24);g.fillRect(356,16,17,24);
    g.fillStyle=palette[3];g.fillRect(6,53,372,7);
    g.fillStyle='#fff9';g.fillRect(31,9,322,3);
    if(kind==='trace'){g.fillStyle='#faffff';g.strokeStyle=palette[0];g.lineWidth=2;g.beginPath();g.moveTo(192,14);g.lineTo(211,32);g.lineTo(192,50);g.lineTo(173,32);g.closePath();g.fill();g.stroke();}
    return cv;
  }

  // Preserve end-cap width when authored SUS notes span several subdivisions.
  function drawPjskBar(c,tex,x,y,width,height){
    const edge=Math.min(width*.22,height*.58),src=34,mid=Math.max(0,width-edge*2);
    if(mid>0)c.drawImage(tex,src,0,tex.width-src*2,tex.height,x+edge,y,mid,height);
    c.drawImage(tex,0,0,src,tex.height,x,y,edge,height);
    c.drawImage(tex,tex.width-src,0,src,tex.height,x+width-edge,y,edge,height);
  }

  function makePjskHitTexture(good=false){
    const cv=document.createElement('canvas');cv.width=cv.height=256;
    const c=cv.getContext('2d'),rgb=good?'126,232,255':'255,237,124';
    const haze=c.createRadialGradient(128,206,8,128,166,128);haze.addColorStop(0,`rgba(${rgb},.8)`);haze.addColorStop(.5,`rgba(${rgb},.18)`);haze.addColorStop(1,`rgba(${rgb},0)`);c.fillStyle=haze;c.fillRect(0,0,256,256);
    const pillar=c.createLinearGradient(0,28,0,224);pillar.addColorStop(0,`rgba(${rgb},0)`);pillar.addColorStop(.25,`rgba(${rgb},.12)`);pillar.addColorStop(.72,`rgba(${rgb},.58)`);pillar.addColorStop(1,'rgba(255,255,235,.95)');c.fillStyle=pillar;c.beginPath();c.moveTo(57,28);c.lineTo(201,40);c.lineTo(215,226);c.lineTo(42,226);c.closePath();c.fill();
    c.strokeStyle=`rgba(${rgb},.78)`;c.lineWidth=2;c.stroke();
    c.fillStyle='rgba(255,255,245,.82)';for(let i=0;i<5;i++){const x=48+i*38,top=20+(i%3)*22;c.beginPath();c.moveTo(113,226);c.lineTo(x,top);c.lineTo(x+4,top+7);c.lineTo(145,226);c.closePath();c.fill();}
    c.strokeStyle='rgba(255,255,245,.95)';c.lineWidth=3;c.beginPath();c.moveTo(30,226);c.lineTo(226,226);c.moveTo(50,237);c.lineTo(213,237);c.stroke();
    for(const[x,y,r]of[[59,102,8],[199,82,5],[166,150,7],[79,169,6],[128,48,4]]){c.fillStyle='#fff8d5';c.beginPath();c.moveTo(x-r,y);c.lineTo(x,y-r);c.lineTo(x+r,y);c.lineTo(x,y+r);c.closePath();c.fill();}
    return cv;
  }

  function buildPjskStageCache(engine,s) {
    const scale=engine.pjskLiteMode?.stageScale||1,cv=document.createElement('canvas');
    cv.width=Math.max(2,Math.round(engine.w*scale));cv.height=Math.max(2,Math.round(engine.h*scale));
    const c=cv.getContext('2d');c.scale(scale,scale);
    const g=c.createLinearGradient(0,0,0,s.judgeY);g.addColorStop(0,'rgba(27,27,43,.48)');g.addColorStop(1,'rgba(24,22,40,.77)');
    c.fillStyle=g;c.beginPath();c.moveTo(s.cx-s.topHalf,0);c.lineTo(s.cx+s.topHalf,0);c.lineTo(s.cx+s.bottomHalf,s.judgeY);c.lineTo(s.cx-s.bottomHalf,s.judgeY);c.closePath();c.fill();
    const columns=s.lanes===12?6:s.lanes;
    for(let i=0;i<=columns;i++){
      const f=i/columns*2-1;c.beginPath();c.moveTo(s.cx+s.topHalf*f,0);c.lineTo(s.cx+s.bottomHalf*f,s.judgeY);
      c.strokeStyle=i===0||i===columns?'rgba(217,185,249,.65)':'rgba(214,201,237,.16)';c.lineWidth=i===0||i===columns?2:1;c.stroke();
    }
    const lip=s.height*.044,extend=1+lip/(s.judgeY-s.vanishY),outer=s.bottomHalf*extend;
    c.fillStyle='rgba(122,78,174,.18)';c.beginPath();c.moveTo(s.cx-s.bottomHalf,s.judgeY);c.lineTo(s.cx+s.bottomHalf,s.judgeY);c.lineTo(s.cx+outer,s.judgeY+lip);c.lineTo(s.cx-outer,s.judgeY+lip);c.closePath();c.fill();
    c.fillStyle='#d9b4f6';c.fillRect(s.cx-s.bottomHalf,s.judgeY-1,s.bottomHalf*2,3);
    c.fillStyle='rgba(210,149,247,.64)';c.fillRect(s.cx-outer,s.judgeY+lip-2,outer*2,3);
    for(let i=0;i<=columns;i++){
      const f=i/columns*2-1;c.beginPath();c.moveTo(s.cx+s.bottomHalf*f,s.judgeY);c.lineTo(s.cx+outer*f,s.judgeY+lip);c.strokeStyle='rgba(202,166,237,.3)';c.lineWidth=1;c.stroke();
    }
    c.fillStyle='#f7e5ff';c.fillRect(s.cx-s.bottomHalf-3,s.judgeY-6,3,12);c.fillRect(s.cx+s.bottomHalf,s.judgeY-6,3,12);
    return cv;
  }

  function drawPjskArrow(c,m,direction,critical) {
    const {p,width,height}=m,k=Math.min(width*.28,height*1.7),dir=direction==='left'?-1:direction==='right'?1:0;
    c.save();c.translate(p.x,p.y-height*.7);if(dir)c.rotate(dir*Math.PI/4);
    c.fillStyle=critical?'#fff0af':'#ffd6ef';c.strokeStyle=critical?'#d1a443':'#ce6ca2';c.lineWidth=Math.max(.7,height*.05);
    for(let i=0;i<2;i++){const y=-i*k*.42;c.beginPath();c.moveTo(-k,y+k*.26);c.lineTo(0,y-k*.4);c.lineTo(k,y+k*.26);c.lineTo(k*.65,y+k*.42);c.lineTo(0,y);c.lineTo(-k*.65,y+k*.42);c.closePath();c.fill();c.stroke();}
    c.restore();
  }

  async function createPjskBackgroundBlob(image,viewportW,viewportH,dim){
    const ratio=Math.min(2,devicePixelRatio||1,2048/Math.max(viewportW,viewportH));
    const cv=document.createElement('canvas');cv.width=Math.max(2,Math.round(viewportW*ratio));cv.height=Math.max(2,Math.round(viewportH*ratio));
    const c=cv.getContext('2d',{alpha:false}),iw=image.naturalWidth||image.width,ih=image.naturalHeight||image.height;
    c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';c.fillStyle='#201c2f';c.fillRect(0,0,cv.width,cv.height);
    const cover=Math.max(cv.width/iw,cv.height/ih),w=iw*cover,h=ih*cover;
    c.drawImage(image,(cv.width-w)/2,(cv.height-h)/2,w,h);
    c.fillStyle=`rgba(17,14,30,${clamp(Number(dim)||0,0,.85)})`;c.fillRect(0,0,cv.width,cv.height);
    return new Promise((resolve,reject)=>cv.toBlob(b=>b?resolve(b):reject(new Error('背景生成失败')),'image/jpeg',.9));
  }

  function isPjskPreview(){return !$('#gameView').classList.contains('hidden')?engine?.chart?.kind==='pjsk':dualMenuMode==='pjsk';}
  function renderPjskPreview(c,w,h,now){
    const lanes=engine?.chart?.kind==='pjsk'?engine.chart.pjskLaneCount||12:12;
    let fake=renderPjskPreview.cache;
    if(!fake||fake.w!==w||fake.h!==h||fake.chart.pjskLaneCount!==lanes){fake={w,h,chart:{pjskLaneCount:lanes},metricsDrawnNotes:0};fake.previewStage=buildPjskStageCache(fake,pjskStageGeometry(fake));renderPjskPreview.cache=fake;}
    const stage=pjskStageGeometry(fake),skin=ensurePjskSkin(fake),cycleMs=1650,total=now-previewEpoch,cycle=Math.max(0,Math.floor(total/cycleMs)),local=((total%cycleMs)+cycleMs)%cycleMs;
    c.drawImage(fake.previewStage,0,0,w,h);
    if(local<1050){const u=local/1050,v=.33*Math.pow(1/.33,u),m=pjskAutoNoteMetrics(stage,(lanes-1)/2,2,v);drawPjskBar(c,skin.tap,m.p.x-m.width/2,m.p.y-m.height/2,m.width,m.height);}
    if(local>=1050&&previewImpactCycle!==cycle){previewImpactCycle=cycle;previewEffectAt=now;playPackHitSound(activePack,'click',hitSoundVolume);}
    const age=(now-previewEffectAt)/1000;if(age>=0&&age<PJSK_HIT_FX_DURATION)drawPjskHitFx(c,{x:w/2,y:stage.judgeY,size:w*.12,particles:[]},age,fake);
    c.fillStyle='#eee6fa';c.textAlign='center';c.font='11px system-ui';c.fillText(`PJSK · ${lanes}K`,w/2,18);
  }

  function ensurePjskSkin(engine) {
    if (engine.pjskSkin) return engine.pjskSkin;
    return engine.pjskSkin = {
      tap:makePjskNoteTexture("tap"), slide:makePjskNoteTexture("slide"), trace:makePjskNoteTexture("trace"), flick:makePjskNoteTexture("flick"), critical:makePjskNoteTexture("critical"),
      hitPerfect:makePjskHitTexture(false), hitGood:makePjskHitTexture(true),
    };
  }
  function pjskStageGeometry(engine) {
    const cached=engine._pjskStageGeometry,lanes=engine.chart.pjskLaneCount||12;
    if(cached&&cached.width===engine.w&&cached.height===engine.h&&cached.lanes===lanes)return cached;
    const w=engine.w,h=engine.h,bottomHalf=Math.min(w*.42,h*.94),judgeY=h*.84,vanishY=-h*.42;
    return engine._pjskStageGeometry={width:w,height:h,cx:w/2,bottomHalf,
      topHalf:bottomHalf*(-vanishY)/(judgeY-vanishY),judgeY,vanishY,lanes};
  }

  function pjskTravel(targetTime,now,chart=null) {
    const speedFactor=Math.max(.15,(Number(noteSpeedScale)||1.7647058823529411)/1.7647058823529411),preempt=2.4/speedFactor;
    const distance=chart?.scrollAt?chart.scrollAt(targetTime)-chart.scrollAt(now):targetTime-now;
    const progress=1-distance/preempt;
    if(progress<-.01)return -1;
    return Math.min(1.7,PJSK_APPROACH_SCALE**(1-progress));
  }

  function pjskPoint(stage,lane,travel) {
    const half=stage.bottomHalf*travel,y=stage.vanishY+(stage.judgeY-stage.vanishY)*travel;
    const laneW=half*2/stage.lanes;
    return {x:stage.cx-half+laneW*(lane+.5),y,half,laneW};
  }

  function pjskAutoNoteMetrics(stage,lane,span,travel) {
    const p=pjskPoint(stage,lane,travel),safeSpan=clamp(Number(span)||1,1,stage.lanes);
    // Height follows depth alone. Authored width no longer changes note thickness.
    return {p,width:Math.max(1,p.laneW*safeSpan*.96),height:Math.max(1,stage.height*.030*travel),span:safeSpan};
  }

  function drawPjskStage(engine,c) {
    const s=pjskStageGeometry(engine),key=`${engine.w}:${engine.h}:${s.lanes}:${engine.pjskLiteMode?.stageScale||1}`;
    if(engine.pjskStageCacheKey!==key){engine.pjskStageCache=buildPjskStageCache(engine,s);engine.pjskStageCacheKey=key;}
    c.drawImage(engine.pjskStageCache,0,0,engine.w,engine.h);return s;
  }

  function pjskRibbonSamples(n,first){
    let cache=n._pjskRibbon;
    if(!cache){
      const knots=[0];for(const p of n._pjskPath||[])if(p.u>0&&p.u<1)knots.push(p.u);
      knots.push(1);knots.sort((a,b)=>a-b);
      cache=n._pjskRibbon={knots:Float64Array.from(knots),values:new Float64Array((knots.length*4+1)*3),count:0};
    }
    const knots=cache.knots,values=cache.values;let start=first,count=0;
    for(let k=1;k<knots.length;k++){
      const end=knots[k];if(end<=first)continue;
      for(let i=0;i<4;i++){const u=lerp(start,end,i/4),at=count++*3;values[at]=u;values[at+1]=pjskSlideLane(n,u);values[at+2]=pjskSlideSpan(n,u);}
      start=end;
    }
    let at=count++*3;values[at]=1;values[at+1]=pjskSlideLane(n,1);values[at+2]=pjskSlideSpan(n,1);cache.count=count;return cache;
  }
  function drawPjskNote(engine,c,n,t,stage,skin) {
    const hold=n.type===3,end=n.end??n.time;
    if((!hold&&n.state===1)||hold&&t>end+.12||!hold&&t>n.time+.15)return;
    let travel=pjskTravel(n.time,t,engine.chart);if(!hold&&travel<0)return;
    if(hold&&t>=n.time)travel=1;
    if(hold&&travel<0)return;
    const u=hold?clamp((t-n.time)/Math.max(1e-6,end-n.time),0,1):0;
    const lane=hold&&t>=n.time?pjskSlideLane(n,u):n._pjskLane;
    const span=hold?pjskSlideSpan(n,u):n._pjskSpan,m=pjskAutoNoteMetrics(stage,lane,span,travel);
    c.globalAlpha=n.holdMiss?.45:1;
    const cap=(at,lane,width,type,critical,direction=null)=>{
      const v=pjskTravel(at,t,engine.chart);if(v<0||v>1.4)return;
      const q=pjskAutoNoteMetrics(stage,lane,width,v),tex=critical?skin.critical:type===4?skin.flick:type===2?skin.trace:skin.slide;
      drawPjskBar(c,tex,q.p.x-q.width/2,q.p.y-q.height/2,q.width,q.height);
      if(direction)drawPjskArrow(c,q,direction,critical);
    };
    if(hold&&end>n.time){
      // Exact authored knots plus subdivisions retain short bends and easing.
      const samples=pjskRibbonSamples(n,Math.max(0,u)),values=samples.values,count=samples.count;
      c.beginPath();
      for(let edge=-1;edge<=1;edge+=2)for(let i=0;i<count;i++){
        const index=(edge<0?i:count-1-i)*3,a=values[index],at=n.time+(end-n.time)*a,
          v=at<=t?1:Math.max(PJSK_APPROACH_SCALE,pjskTravel(at,t,engine.chart)),
          half=stage.bottomHalf*v,laneW=half*2/stage.lanes,
          x=stage.cx-half+laneW*(values[index+1]+.5+edge*values[index+2]*.47),
          y=stage.vanishY+(stage.judgeY-stage.vanishY)*v;
        if(edge<0&&i===0)c.moveTo(x,y);else c.lineTo(x,y);
      }
      c.closePath();c.fillStyle=n._pjskGuide?'rgba(101,223,255,.18)':n.visualCritical?'rgba(255,224,115,.52)':'rgba(91,250,184,.48)';c.fill();
      c.lineWidth=1.1;c.strokeStyle=n.visualCritical?'#fff6b9':'rgba(197,255,226,.8)';c.stroke();
      if(!n._pjskTailHidden&&!n._pjskGuide)cap(end,pjskSlideLane(n,1),pjskSlideSpan(n,1),n._pjskTailDirection?4:3,n.visualCritical,n._pjskTailDirection);
      for(const tick of n._pjskTicks||[])if(tick.visible&&tick.time>t){
        const v=pjskTravel(tick.time,t,engine.chart);if(v<0)continue;
        const q=pjskPoint(stage,pjskSlideLane(n,tick.u),v),r=Math.max(1,stage.height*.008*v);
        c.fillStyle=n.visualCritical?'#fff9ca':'#f1fff8';c.beginPath();c.moveTo(q.x,q.y-r);c.lineTo(q.x+r,q.y);c.lineTo(q.x,q.y+r);c.lineTo(q.x-r,q.y);c.closePath();c.fill();
      }
    }
    if(!n._pjskGuide&&(!hold||!n._pjskHeadHidden)){
      const tex=n.visualCritical?skin.critical:n.type===4?skin.flick:n.type===2?skin.trace:hold?skin.slide:skin.tap;
      drawPjskBar(c,tex,m.p.x-m.width/2,m.p.y-m.height/2,m.width,m.height);
      if(n.type===4)drawPjskArrow(c,m,n._pjskDirection||'up',n.visualCritical);
    }
    c.globalAlpha=1;engine.metricsDrawnNotes++;
  }

  function drawPjskHitFx(c,e,age,engine) {
    if(!(age>=0&&age<PJSK_HIT_FX_DURATION)) return;
    const u=age/PJSK_HIT_FX_DURATION, skin=ensurePjskSkin(engine), tex=e.good?skin.hitGood:skin.hitPerfect,
      grow=.62+u*.72, fade=(1-u)*(1-u), size=Math.max(26,(Number(e.size)||64)*grow);
    c.globalAlpha=clamp(fade*.96,0,1); c.drawImage(tex,e.x-size,e.y-size*1.78,size*2,size*2);
    // Four lightweight travelling diamonds give the burst motion without an
    // atlas decode, shadowBlur, or per-frame trigonometry.
    const particles=e.particles||[], limit=Math.min(4,particles.length), dist=(Number(e.size)||64)*(0.18+u*1.18);
    c.fillStyle=e.good?"rgba(137,232,255,.95)":"rgba(255,238,130,.96)"; c.globalAlpha=clamp((1-u)*.9,0,1);
    for(let i=0;i<limit;i++){ const q=Math.max(2,(Number(e.size)||64)*.045*(1-u*.35)), px=e.x+particles[i].dx*dist, py=e.y+particles[i].dy*dist; c.beginPath(); c.moveTo(px,py-q); c.lineTo(px+q,py); c.lineTo(px,py+q); c.lineTo(px-q,py); c.closePath(); c.fill(); }
    c.globalAlpha=1;
  }
  function drawPjskScene(engine,c,t,bucket) {
    const stage=drawPjskStage(engine,c),skin=ensurePjskSkin(engine);
    const preempt=2.4/Math.max(.15,(Number(noteSpeedScale)||1.7647)/1.7647);
    let lo=lowerBoundNumeric(engine.noteTimes,t-.16),hi=lowerBoundNumeric(engine.noteTimes,t+preempt+.04);
    if(engine.chart.scrollVariable){lo=0;hi=engine.noteItems.length;}
    if(!engine.chart.scrollVariable){
      const active=engine._pjskVisualHolds||(engine._pjskVisualHolds=new Set()),holds=engine._pjskHolds||[];
      if(t<engine._pjskVisualTime){active.clear();engine._pjskVisualHoldFeed=0;}
      while(engine._pjskVisualHoldFeed<holds.length&&holds[engine._pjskVisualHoldFeed].n.time<t-.16){
        const item=holds[engine._pjskVisualHoldFeed++];if(item.n.end>t)active.add(item);
      }
      for(const item of active){if(item.n.end<=t)active.delete(item);else drawPjskNote(engine,c,item.n,t,stage,skin);}
      engine._pjskVisualTime=t;
    }
    for(const type of [3,2,1,4])for(let i=lo;i<hi;i++){const n=engine.noteItems[i].n;if(n.type===type)drawPjskNote(engine,c,n,t,stage,skin);}
    if(engine.pjskLastJudge&&(engine._offlineExport?engine.frameNow:performance.now())-engine.pjskLastJudge.at<420){
      const age=((engine._offlineExport?engine.frameNow:performance.now())-engine.pjskLastJudge.at)/420;c.globalAlpha=Math.min(1,(1-age)*2.4);
      c.textAlign='center';c.font=`800 ${stage.height*.043}px system-ui`;
      c.lineWidth=Math.max(1,stage.height*.003);c.strokeStyle='rgba(83,50,111,.7)';
      c.fillStyle=['#fff2fb','#ffc9f7','#81e1ff','#9b9aff','#a5a0ba'][engine.pjskLastJudge.grade];
      const label=['PERFECT','GREAT','GOOD','BAD','MISS'][engine.pjskLastJudge.grade],labelY=stage.judgeY-stage.height*.105;
      if(engine.pjskLastJudge.grade===0){let hue=engine._pjskJudgeGradient;if(!hue||engine._pjskJudgeGradientWidth!==stage.width){hue=c.createLinearGradient(stage.cx-100,0,stage.cx+100,0);hue.addColorStop(0,'#93f8e0');hue.addColorStop(.45,'#f1d8ff');hue.addColorStop(1,'#a5f6ff');engine._pjskJudgeGradient=hue;engine._pjskJudgeGradientWidth=stage.width;}c.fillStyle=hue;}
      c.strokeText(label,stage.cx,labelY);c.fillText(label,stage.cx,labelY);c.globalAlpha=1;
    }
  }

  const SEKAI_KEYS=['KeyS','KeyD','KeyF','KeyJ','KeyK','KeyL'];
  const SEKAI_FLICK_KEYS=['KeyW','KeyE','KeyR','KeyU','KeyI','KeyO'];
  const PJSK_WINDOWS=Object.freeze({
    trace:Object.freeze({perfect:5/60,great:5/60,good:5/60,bad:5/60}),
    tail:Object.freeze({perfect:4/60,perfectEarly:3.5/60,great:8/60,greatEarly:6.5/60,good:8.5/60,goodEarly:7.5/60,bad:8.5/60,badEarly:7.5/60}),
    flick:Object.freeze({perfect:2.5/60,great:7.5/60,greatEarly:6.5/60,good:8/60,goodEarly:7/60,bad:8.5/60,badEarly:7.5/60}),
    criticalFlick:Object.freeze({perfect:3.5/60,great:7.5/60,greatEarly:6.5/60,good:8/60,goodEarly:7/60,bad:8.5/60,badEarly:7.5/60}),
    tap:Object.freeze({perfect:2.5/60,great:5/60,good:6.5/60,bad:7.5/60}),
    criticalTap:Object.freeze({perfect:3.3/60,great:4.5/60,good:6.5/60,bad:7.5/60})
  });
  function pjskWindow(n,tail=false){
    return tail?PJSK_WINDOWS.tail:n.type===2?PJSK_WINDOWS.trace:n.type===4?
      (n.visualCritical?PJSK_WINDOWS.criticalFlick:PJSK_WINDOWS.flick):
      n.visualCritical?PJSK_WINDOWS.criticalTap:PJSK_WINDOWS.tap;
  }
  function pjskGrade(n,diff,tail=false){const w=pjskWindow(n,tail),d=Math.abs(diff),early=diff<0;
    return d<=(early?w.perfectEarly??w.perfect:w.perfect)+1e-9?0:
      d<=(early?w.greatEarly??w.great:w.great)+1e-9?1:
      d<=(early?w.goodEarly??w.good:w.good)+1e-9?2:
      d<=(early?w.badEarly??w.bad:w.bad)+1e-9?3:4;
  }
  function resetPjskState(e,seek=-Infinity){
    if(e.chart.kind!=='pjsk')return;
    e.pjskCounts=[0,0,0,0,0];e.pjskLife=1000;e.pjskLastJudge=null;
    e._pjskPending=new Set();e._pjskActive=new Set();e._pjskFeed=0;
    e._pjskHolds=e.noteItems.filter(item=>item.n.type===3);
    e._pjskVisualHolds=new Set();e._pjskVisualHoldFeed=0;e._pjskVisualTime=-Infinity;
    for(const item of e._pjskHolds)pjskRibbonSamples(item.n,0);
    e.counts=[0,0,0,0];e.actualCounts=[0,0,0,0];e.combo=e.maxCombo=e.actualCombo=e.actualMaxCombo=0;
    for(const item of e.noteItems){const n=item.n;n._sekaiFlickArmed=false;n._sekaiFlickCapturedPerf=-Infinity;n._sekaiTraceTime=-Infinity;n._sekaiHeadDone=false;n._sekaiTickIndex=0;n._sekaiTailDone=false;n._sekaiTailFlick=null;n._sekaiNextFx=0;n._sekaiLastContact=-Infinity;
      if(n.fake)continue;
      n.state=0;
      if(n.time<seek){
        n._sekaiHeadDone=true;
        if(!n._pjskHeadHidden)recordPjskJudge(e,n,e.autoplay||e.invincibleMode?0:4,0,item.L,false);
        if(n.type===3){
          for(const tick of n._pjskTicks||[])if(tick.time<seek){n._sekaiTickIndex++;recordPjskJudge(e,n,e.autoplay||e.invincibleMode?0:4,0,item.L,false);}
          if(n.end<seek){n._sekaiTailDone=true;if(!n._pjskTailHidden)recordPjskJudge(e,n,e.autoplay||e.invincibleMode?0:4,0,item.L,false);n.state=1;}
          else {n.state=2;e._pjskActive.add(item);}
        }else n.state=1;
      }
    }
    e._pjskFeed=lowerBoundNumeric(e.noteTimes,seek);
  }
  function pjskContact(e,n,t,lane=null,span=null){
    const stage=pjskStageGeometry(e),u=clamp((t-n.time)/Math.max(1e-7,n.end-n.time),0,1);
    lane=lane??(n.type===3?pjskSlideLane(n,u):n._pjskLane);
    span=span??(n.type===3?pjskSlideSpan(n,u):n._pjskSpan);
    const target=stage.cx-stage.bottomHalf+(lane+.5)*stage.bottomHalf*2/stage.lanes,radius=stage.bottomHalf*2/stage.lanes*(span*.5+.12)*clamp(touchSensitivity,.8,1.25);
    for(const p of e.pointer.values())if((p.active!==false||p.cancelled&&p.ghostUntil>performance.now()/1000)&&Math.abs(p.x-target)<=radius)return p;
    for(let k=0;k<SEKAI_KEYS.length;k++)if(keyboardInput?.down.has(SEKAI_KEYS[k])||keyboardInput?.down.has(SEKAI_FLICK_KEYS[k])){
      const x=stage.cx-stage.bottomHalf+(k+.5)*stage.bottomHalf*2/6;
      if(Math.abs(x-target)<=radius)return {id:'keyboard:'+k,x,y:stage.judgeY,active:true};
    }
    return null;
  }
  function recordPjskJudge(e,n,grade,diff,L,feedback=true){
    if(!e.pjskCounts)e.pjskCounts=[0,0,0,0,0];
    e.pjskCounts[grade]++;
    const mapped=grade===0?0:grade===1?1:grade===4?3:2;
    e.counts[mapped]++;e.actualCounts[mapped]++;
    if(grade<=1){e.combo++;e.maxCombo=Math.max(e.maxCombo,e.combo);}else e.combo=0;
    e.actualCombo=e.combo;e.actualMaxCombo=e.maxCombo;
    if(grade>0&&grade<4)e.earlyLate[diff<0?0:1]++;
    e.pjskLife=clamp((e.pjskLife??1000)-(grade===4?80:grade===3?60:grade===2?40:0),0,1000);
    n.judge=['perfect','great','good','bad','miss'][grade];
    if(feedback){
      e.pjskLastJudge={grade,at:e._offlineExport?e.frameNow:performance.now()};
      if(grade<3){e.hitEffect(L,n,grade>0?1:0);if(!e.autoplay||!n.autoSoundScheduled)e.playSound(n.type===4?'flick':n.type===2?'drag':'click',null,n);}
    }
  }
  function startPjskHold(e,item,diff,automatic=false){
    const n=item.n;if(n._sekaiHeadDone)return;
    n._sekaiHeadDone=true;n.state=2;n.holdMiss=false;e._pjskActive.add(item);e._pjskPending.delete(item);
    if(!n._pjskHeadHidden)recordPjskJudge(e,n,automatic?0:pjskGrade(n,diff),diff,item.L);
  }
  function pjskWrongFlick(direction,x,y,fromX,fromY){
    if(direction!=='left'&&direction!=='right')return false;
    const angle=Math.atan2(Number.isFinite(fromY)?fromY-y:0,x-fromX),
      target=Math.PI/2+(direction==='left'?1:-1),
      delta=((angle-target+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
    return Math.abs(delta)>Math.PI/2;
  }
  function pjskInput(e,kind,x,y,at,fromX=NaN,fromY=NaN,pid=null){
    if(e.autoplay)return false;
    const t=(Number.isFinite(at)?at:e.time)+judgeTimingLead,lo=lowerBoundNumeric(e.noteTimes,t-.15),hi=lowerBoundNumeric(e.noteTimes,t+.15);
    const stage=pjskStageGeometry(e);let best=null,bestScore=Infinity;
    for(let i=lo;i<hi;i++){
      const item=e.noteItems[i],n=item.n;if(n.fake||n.state!==0||n._sekaiHeadDone)continue;
      if(kind==='tap'&&(n.type===2||n._pjskHeadTrace||n._pjskHeadHidden||n.type===4&&n._sekaiFlickArmed))continue;
      if(kind==='flick'&&(n.type!==4||!n._sekaiFlickArmed||pid!=null&&(e.pointer.get(pid)?.startT??-Infinity)<n._sekaiFlickCapturedPerf))continue;
      const diff=t-n.time,w=pjskWindow(n);if(Math.abs(diff)>(diff<0?w.badEarly??w.bad:w.bad))continue;
      const q=pjskPoint(stage,n._pjskLane,1),radius=q.laneW*(n._pjskSpan*.5+.12)*clamp(touchSensitivity,.8,1.25),dx=Math.abs(x-q.x);
      if(dx>radius)continue;const score=Math.abs(diff)+dx/stage.width*.1;
      if(score<bestScore){best=item;bestScore=score;}
    }
    if(best){const n=best.n,diff=t-n.time;
      if(kind==='tap'&&n.type===4){n._sekaiFlickArmed=true;n._sekaiFlickCapturedPerf=e.pointer.get(pid)?.startT??-Infinity;return true;}
      let grade=pjskGrade(n,diff);
      if(kind==='flick'&&n._pjskDirection&&Number.isFinite(fromX)){
        const wrong=pjskWrongFlick(n._pjskDirection,x,y,fromX,fromY);
        if(wrong&&grade===0)grade=1;
      }
      if(n.type===3)startPjskHold(e,best,diff);else{n.state=1;n._sekaiHeadDone=true;recordPjskJudge(e,n,grade,diff,best.L);}
      return true;
    }
    if(kind==='flick')for(const item of e._pjskActive||[]){
      const n=item.n;if(!n._pjskTailDirection||n._sekaiTailDone||Math.abs(t-n.end)>8.5/60)continue;
      const q=pjskPoint(stage,pjskSlideLane(n,1),1),radius=q.laneW*(pjskSlideSpan(n,1)/2+.12);
      if(Math.abs(x-q.x)<=radius){const direction=n._pjskTailDirection;
        const wrong=Number.isFinite(fromX)&&pjskWrongFlick(direction,x,y,fromX,fromY);
        n._sekaiTailFlick={time:t,wrong};return true;}
    }
    return false;
  }
  function updatePjskJudgement(e,t,frameNow){
    if(!e._pjskPending)resetPjskState(e);
    const jt=t+judgeTimingLead;
    while(e._pjskFeed<e.noteItems.length&&e.noteItems[e._pjskFeed].n.time<=jt+.15){const item=e.noteItems[e._pjskFeed++];if(!item.n.fake&&!item.n._sekaiHeadDone)e._pjskPending.add(item);}
    if(e.autoplay)e.usedAutoplay=true;if(e.invincibleMode)e.usedInvincible=true;
    for(const item of e._pjskPending){const n=item.n;if(n._sekaiHeadDone){e._pjskPending.delete(item);continue;}
      const diff=jt-n.time,contact=e.autoplay?null:pjskContact(e,n,t);
      if(contact&&Math.abs(diff)<=5/60&&(n.type===2||n._pjskHeadTrace))n._sekaiTraceTime=jt;
      const traceReady=diff>=0&&n._sekaiTraceTime>=n.time-5/60,
        automatic=e.autoplay&&diff>=0;
      if(n.type===3){
        if(automatic||n._pjskHeadHidden&&diff>=0||n._pjskHeadTrace&&traceReady)startPjskHold(e,item,diff,true);
        else if(diff>pjskWindow(n).bad){n._sekaiHeadDone=true;n.state=2;n.holdMiss=true;e._pjskActive.add(item);e._pjskPending.delete(item);if(!n._pjskHeadHidden)recordPjskJudge(e,n,4,0,item.L);}
      }else if(automatic||n.type===2&&traceReady){n.state=1;n._sekaiHeadDone=true;recordPjskJudge(e,n,0,diff,item.L);e._pjskPending.delete(item);}
      else if(diff>pjskWindow(n).bad){n.state=1;n._sekaiHeadDone=true;recordPjskJudge(e,n,4,0,item.L);e._pjskPending.delete(item);}
    }
    for(const item of e._pjskActive){const n=item.n,ticks=n._pjskTicks||[],contact=e.autoplay||pjskContact(e,n,t);
      if(contact)n._sekaiLastContact=jt;
      n.holdMiss=!contact;
      while(n._sekaiTickIndex<ticks.length&&ticks[n._sekaiTickIndex].time<=jt){
        const tick=ticks[n._sekaiTickIndex],valid=e.autoplay||pjskContact(e,n,tick.time)||n._sekaiLastContact>=tick.time-5/60;
        if(!valid&&jt<tick.time+5/60)break;
        n._sekaiTickIndex++;recordPjskJudge(e,n,valid?0:4,0,item.L,false);
      }
      if(contact&&frameNow>n._sekaiNextFx&&jt<n.end){e.hitEffect(item.L,n,0,t);n._sekaiNextFx=frameNow+180;}
      if(!n._sekaiTailDone&&jt>=n.end){
        if(n._pjskTailDirection&&!e.autoplay&&!n._sekaiTailFlick&&jt<n.end+8.5/60)continue;
        const tailContact=contact||n._sekaiLastContact>=n.end-3.5/60;
        if(!n._pjskTailDirection&&!tailContact&&!e.autoplay&&!n._pjskTailHidden&&jt<n.end+8.5/60)continue;
        const flick=n._sekaiTailFlick;
        let grade=e.autoplay||n._pjskTailHidden?0:n._pjskTailDirection?flick?pjskGrade(n,flick.time-n.end,true):4:tailContact?0:4;
        if(flick?.wrong&&grade===0)grade=1;
        if(!n._pjskTailHidden)recordPjskJudge(e,n,grade,flick?flick.time-n.end:0,item.L);
        n._sekaiTailDone=true;n.state=1;e._pjskActive.delete(item);
      }
    }
  }

  async function importChartFiles(fileList, options = null) {
    const publishOptions = options && typeof options === "object" ? options : null,
      roots = [...fileList].filter(Boolean);
    if (!roots.length) return;
    const added = [],
      staged = [],
      errors = [],
      seen = new Set(),
      archiveBudget = { entries: 0, compressed: 0, declared: 0, materialized: 0 };
    let discovered = 0;

    const saveRecord = async (rec) => { staged.push(rec); };
    const scanArchive = async (file, displayPath, depth = 0) => {
      if (depth > IMPORT_MAX_DEPTH) {
        errors.push(`${displayPath}\n  嵌套 ZIP 超过 ${IMPORT_MAX_DEPTH} 层`);
        return;
      }
      if (++discovered > IMPORT_MAX_ARCHIVES)
        throw new Error(`发现的 ZIP／PEZ 超过 ${IMPORT_MAX_ARCHIVES} 个，已停止以避免异常压缩包耗尽内存`);
      const sig = `${displayPath}|${file.size}|${depth}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      let unpacked;
      try {
        unpacked = await unpackFile(file, archiveBudget);
      } catch (e) {
        errors.push(`${displayPath}\n  ${e.message}`);
        return;
      }
      try {
        const result = await buildChartRecords(unpacked, displayPath), nested = [];
        for (const rec of result.records) {
          rec.sourceName = displayPath;
          await saveRecord(rec);
        }
        for (const entry of unpacked) {
          if (!IMPORT_ZIP_EXT.test(entry.name) && !(await blobLooksLikeZip(entry.blob))) continue;
          nested.push(entry);
        }
        const meaningfulErrors = result.errors.filter((message) =>
          result.records.length || !nested.length || !/^没有找到可识别的/.test(message),
        );
        for (const message of meaningfulErrors) errors.push(`${displayPath}\n  ${message}`);
        for (const entry of nested) {
          const childPath = `${displayPath} › ${entry.name}`;
          await scanArchive(
            makeNamedBlob(entry.blob, basename(entry.name) || `nested-${depth + 1}.zip`),
            childPath,
            depth + 1,
          );
          if ((discovered & 7) === 0) await new Promise((r) => setTimeout(r, 0));
        }
      } catch (chartError) {
        errors.push(`${displayPath}\n  ${chartError.message || chartError}`);
      } finally {
        unpacked = null;
      }
    };

    const loose = [];
    for (const f of roots) {
      const displayName = f.webkitRelativePath || f.name || "uploaded.bin";
      if (await blobLooksLikeZip(f)) await scanArchive(f, displayName, 0);
      else loose.push({ name: displayName, blob: f, size: f.size });
    }
    if (loose.length) {
      try {
        const rootLabel = roots.some((file) => file.webkitRelativePath) ? "本地文件夹" : loose[0].name || "loose-files",
          result = await buildChartRecords(loose, rootLabel);
        for (const rec of result.records) await saveRecord(rec);
        for (const message of result.errors) errors.push(`散装文件／文件夹\n  ${message}`);
      } catch (e) {
        errors.push(`散装文件组合\n  ${e.message}`);
      }
    }

    if (errors.length) {
      staged.length = 0;
    } else {
      if (publishOptions) {
        const forcedName = String(publishOptions.nameOverride || "").trim(),
          publishedAt = Date.now();
        for (const record of staged) {
          if (forcedName) record.name = forcedName;
          if (publishOptions.adminPublished) {
            record.adminPublished = true;
            record.publisher = "admin";
            record.publishedAt = publishedAt;
            record.importedAt = publishedAt;
          }
        }
      }
      await dbPutChartsAtomically(staged);
      added.push(...new Map(staged.map((record) => [record.id, record])).values());
    }
    await renderLibrary();
    const temporary = isTemporaryStorage(),
      modeNote = temporary
        ? "\n存储方式：临时谱面库（刷新或关闭页面后清空）"
        : "\n存储方式：本机永久谱面库";
    let report =
      `成功导入：${added.length}\n失败：${errors.length}${errors.length ? "（本批次未写入，原库保持不变）" : ""}\n递归发现压缩包：${discovered}${modeNote}\n\n` +
      added
        .map(
          (x) =>
            `✓ ${x.name}\n  ${x.parser.toUpperCase()} · ${x.lines} 条判定线 · ${x.notes} Notes · ${x.lineTextureSpecs?.length || 0} 条 line.csv 覆盖 · 音频 ${x.audioName}\n  来源：${x.sourceName}\n  谱面：${x.chartFileName}`,
        )
        .join("\n\n");
    if (errors.length)
      report += `\n\n失败明细：\n${errors.map((x) => "✗ " + x).join("\n\n")}`;
    if (!publishOptions?.suppressReport) showDialog("谱面导入报告", report, true);
    toast(
      added.length
        ? temporary
          ? `已递归加入 ${added.length} 个临时谱面`
          : `已递归加入 ${added.length} 个谱面，不会覆盖原有谱面`
        : "没有成功导入谱面",
      !added.length,
    );
    return { added, errors, discovered };
  }

  async function buildResourcePack(files, sourceName) {
    let infoFile = files.find((f) => {
        const n = basename(f.name).toLowerCase();
        return n === "info.yml" || n === "info.yaml";
      }),
      metaFile = files.find(
        (f) => basename(f.name).toLowerCase() === "_meta.json",
      ),
      info = {};
    if (infoFile) info = parseSimpleYAML(await blobText(infoFile.blob));
    else if (metaFile) info = JSON.parse(await blobText(metaFile.blob));
    else throw new Error("材质包中缺少 Phira 的 info.yml 或 _META.json");
    const out = {
      key: "activePack",
      sourceName,
      name: String(info.name || sourceName),
      author: String(info.author || ""),
      info,
      files: files.map((f) => ({ name: f.name, blob: f.blob })),
      importedAt: Date.now(),
    };
    const needed = infoFile
      ? ["click.png", "hold.png", "flick.png", "drag.png"]
      : [];
    for (const n of needed)
      if (!byName(files, n)) throw new Error(`Phira 材质包缺少 ${n}`);
    return out;
  }
  async function importResourcePack(file) {
    try {
      const files = await unpackFile(file),
        pack = await buildResourcePack(files, file.name);
      await dbPutSetting(pack);
      if (!isTemporaryStorage()) {
        const savedPack = await dbGetSetting("activePack");
        if (!savedPack || savedPack.importedAt !== pack.importedAt)
          throw new Error("材质包没有完成本机持久化写入");
      }
      activePack = await loadResourcePack(pack);
      updatePackStatus();
      toast(
        isTemporaryStorage()
          ? `已即时启用临时材质包：${pack.name}`
          : `已启用材质包：${pack.name}`,
      );
    } catch (e) {
      toast(`材质包导入失败：${e.message}`, true, 6000);
    }
  }
  function imageFromBlob(blob, timeoutMs = 12000) {
    return new Promise((res, rej) => {
      const u = URL.createObjectURL(blob),
        im = new Image();
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        im.onload = null;
        im.onerror = null;
        URL.revokeObjectURL(u);
        if (error) rej(error);
        else res(im);
      };
      const timer = setTimeout(
        () => finish(new Error("图片解码超时，已跳过该素材")),
        Math.max(1000, Number(timeoutMs) || 12000),
      );
      im.decoding = "async";
      im.onload = () => finish();
      im.onerror = () => finish(new Error("图片解码失败"));
      im.src = u;
      if (typeof im.decode === "function")
        im.decode().then(() => finish()).catch(() => {});
    });
  }
  function imageFromPersistentURL(url, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        if (error) reject(error);
        else resolve(image);
      };
      const timer = setTimeout(
        () => finish(new Error("持久曲绘图片解码超时")),
        Math.max(1000, Number(timeoutMs) || 12000),
      );
      image.decoding = "async";
      image.onload = () => finish();
      image.onerror = () => finish(new Error("持久曲绘图片解码失败"));
      image.src = String(url || "");
      if (typeof image.decode === "function")
        image.decode().then(() => finish()).catch(() => {});
    });
  }
  function canvasToBlobWithTimeout(canvas, type = "image/jpeg", quality = 0.84, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const dataUrlFallback = () => {
        try {
          const dataUrl = canvas.toDataURL(type, quality),
            split = dataUrl.indexOf(","),
            header = dataUrl.slice(0, split),
            raw = atob(dataUrl.slice(split + 1)),
            bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          finish(new Blob([bytes], { type: /data:([^;]+)/.exec(header)?.[1] || type }));
        } catch (error) {
          finish(null, error);
        }
      };
      const timer = setTimeout(dataUrlFallback, Math.max(1000, Number(timeoutMs) || 8000));
      try {
        if (typeof canvas.toBlob !== "function") {
          dataUrlFallback();
          return;
        }
        canvas.toBlob((blob) => blob ? finish(blob) : dataUrlFallback(), type, quality);
      } catch (error) {
        dataUrlFallback();
      }
    });
  }
  function imageLumaMetrics(image) {
    try {
      const canvas = document.createElement("canvas"), size = 28;
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      if (!context) return { mean: 0, spread: 0 };
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, size, size);
      const pixels = context.getImageData(0, 0, size, size).data;
      let total = 0, low = 255, high = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const value = pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722;
        total += value;
        if (value < low) low = value;
        if (value > high) high = value;
      }
      return { mean: total / (pixels.length / 4), spread: high - low };
    } catch (_) {
      return { mean: 0, spread: 0 };
    }
  }
  function drawImageCover(context, image, x, y, width, height) {
    const iw = Number(image?.naturalWidth || image?.videoWidth || image?.width || 0),
      ih = Number(image?.naturalHeight || image?.videoHeight || image?.height || 0);
    if (!(iw > 0 && ih > 0 && width > 0 && height > 0)) return false;
    const scale = Math.max(width / iw, height / ih),
      sw = width / scale,
      sh = height / scale,
      sx = Math.max(0, (iw - sw) * 0.5),
      sy = Math.max(0, (ih - sh) * 0.5);
    context.drawImage(image, sx, sy, Math.min(iw, sw), Math.min(ih, sh), x, y, width, height);
    return true;
  }
  async function createFrostedBackgroundBlob(image, dim = 0) {
    const iw = Math.max(1, image.naturalWidth || image.width || 1),
      ih = Math.max(1, image.naturalHeight || image.height || 1),
      longSide = Math.max(iw, ih),
      outputScale = Math.min(1, 720 / longSide),
      ow = Math.max(2, Math.round(iw * outputScale)),
      oh = Math.max(2, Math.round(ih * outputScale)),
      // No ctx.filter: multi-stage downsampling is stable on Safari, Edge iOS and file://.
      tinyScale = Math.min(1, 54 / longSide),
      tw = Math.max(2, Math.round(iw * tinyScale)),
      th = Math.max(2, Math.round(ih * tinyScale)),
      tiny = document.createElement("canvas"),
      middle = document.createElement("canvas"),
      output = document.createElement("canvas");
    tiny.width = tw;
    tiny.height = th;
    middle.width = Math.max(4, Math.round(tw * 2));
    middle.height = Math.max(4, Math.round(th * 2));
    output.width = ow;
    output.height = oh;
    const tc = tiny.getContext("2d", { alpha: false }),
      mc = middle.getContext("2d", { alpha: false }),
      oc = output.getContext("2d", { alpha: false });
    if (!tc || !mc || !oc) throw new Error("浏览器无法创建磨砂背景画布");
    for (const context of [tc, mc, oc]) {
      context.imageSmoothingEnabled = true;
      try { context.imageSmoothingQuality = "high"; } catch {}
    }
    tc.drawImage(image, 0, 0, tw, th);
    mc.drawImage(tiny, 0, 0, middle.width, middle.height);
    // First paint a full-opacity base. The previous version started from an opaque
    // black Canvas and only added partial-alpha samples, which could make dark art
    // nearly black even when encoding technically succeeded.
    oc.globalAlpha = 1;
    oc.drawImage(middle, 0, 0, ow, oh);
    oc.globalAlpha = .18;
    oc.drawImage(middle, -10, -7, ow + 20, oh + 14);
    oc.drawImage(middle, 10, 7, Math.max(2, ow - 20), Math.max(2, oh - 14));
    oc.drawImage(middle, -5, 8, ow + 10, Math.max(2, oh - 16));
    oc.drawImage(middle, 6, -8, Math.max(2, ow - 12), oh + 16);
    oc.globalAlpha = 1;
    const bakedDim = clamp(Number(dim) || 0, 0, .42);
    if (bakedDim > 0) {
      oc.fillStyle = `rgba(3,7,12,${bakedDim})`;
      oc.fillRect(0, 0, ow, oh);
    }
    const blob = await canvasToBlobWithTimeout(output, "image/jpeg", 0.88, 8000);
    if (!blob || blob.size < 128) throw new Error("磨砂背景编码为空");
    return blob;
  }
  function imageAlphaMetrics(im) {
    try {
      const iw = im.naturalWidth || im.width,
        ih = im.naturalHeight || im.height,
        max = 512,
        sc = Math.min(1, max / Math.max(iw, ih)),
        w = Math.max(1, Math.round(iw * sc)),
        h = Math.max(1, Math.round(ih * sc)),
        cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      cx.clearRect(0, 0, w, h);
      cx.drawImage(im, 0, 0, w, h);
      const d = cx.getImageData(0, 0, w, h).data;
      const scan = (threshold) => {
        let x0 = w,
          y0 = h,
          x1 = -1,
          y1 = -1;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++)
            if (d[(y * w + x) * 4 + 3] > threshold) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
        if (x1 < 0) return null;
        return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
      };
      const outer = scan(8),
        core = scan(160) || scan(96) || outer;
      if (!outer) return null;
      const inv = 1 / sc,
        // Keep one authored source pixel around the detected alpha edge, but
        // make every crop edge an integer source pixel. Never sample a texture
        // from half pixels: that permanently blurs thin highlights.
        x0 = Math.max(0, Math.floor(outer.x0 * inv) - 1),
        y0 = Math.max(0, Math.floor(outer.y0 * inv) - 1),
        x1 = Math.min(iw, Math.ceil((outer.x1 + 1) * inv) + 1),
        y1 = Math.min(ih, Math.ceil((outer.y1 + 1) * inv) + 1),
        bounds = { sx: x0, sy: y0, sw: Math.max(1, x1 - x0), sh: Math.max(1, y1 - y0) };
      return {
        bounds,
        coreFraction: clamp(core.h / outer.h, 0.05, 1),
        outerAspect: bounds.sw / Math.max(1, bounds.sh),
      };
    } catch {
      return null;
    }
  }
  async function audioBufferFromBlob(blob) {
    const ac = Engine.sharedAudioContext(),
      data = await withTimeout(
        blob.arrayBuffer(),
        12000,
        "音频数据读取超时",
      );
    return withTimeout(
      ac.decodeAudioData(data),
      12000,
      "音频解码超时",
    );
  }
  async function loadResourcePack(pack) {
    if (!pack) return null;
    const files = pack.files || [],
      i = pack.info || {},
      fxRaw = Array.isArray(i.hitFx)
        ? i.hitFx
        : Array.isArray(i.hitfx)
          ? i.hitfx
          : [1, 1],
      fxCols = Math.max(1, Math.round(Number(fxRaw[0]) || 1)),
      fxRows = Math.max(1, Math.round(Number(fxRaw[1]) || 1)),
      fxScale = clamp(Number(i.hitFxScale ?? i.hitfxscale ?? 1) || 1, 0.1, 4),
      atlasPair = (v) => {
        const a = Array.isArray(v) ? v : [0, 0];
        return [
          Math.max(0, Math.round(Number(a[0]) || 0)),
          Math.max(0, Math.round(Number(a[1]) || 0)),
        ];
      },
      holdAtlas = atlasPair(i.holdAtlas ?? i.holdatlas),
      holdAtlasMH = atlasPair(
        i.holdAtlasMH ?? i.holdatlasmh ?? i.holdAtlas ?? i.holdatlas,
      ),
      r = {
        name: pack.name,
        originalPhigros: !!i.originalPhigros,
        images: {},
        imageBounds: {},
        imageMetrics: {},
        sounds: {},
        info: i,
        holdAtlas: { hold: holdAtlas, holdMH: holdAtlasMH },
        holdCompact: !!(i.holdCompact ?? i.holdcompact),
        holdKeepHead: !!(i.holdKeepHead ?? i.holdkeephead),
        holdRepeat: !!(i.holdRepeat ?? i.holdrepeat),
        hitFx: {
          cols: fxCols,
          rows: fxRows,
          scale: fxScale,
          duration: clamp(Number(i.hitFxDuration ?? i.hitfxduration ?? 0.5) || 0.5, 0.2, 1.2),
          particle: {
            countPerfect: clamp(Math.round(Number(i.hitFxParticleCount ?? i.hitfxparticlecount ?? 4) || 4), 0, 24),
            countGood: clamp(Math.round(Number(i.hitFxGoodParticleCount ?? i.hitfxgoodparticlecount ?? 3) || 3), 0, 24),
            style: String(i.hitFxParticleStyle ?? i.hitfxparticlestyle ?? "square").toLowerCase(),
            sizeMin: clamp(Number(i.hitFxParticleSizeMin ?? i.hitfxparticlesizemin ?? 0.055) || 0.055, 0.012, 0.12),
            sizeMax: clamp(Number(i.hitFxParticleSizeMax ?? i.hitfxparticlesizemax ?? 0.077) || 0.077, 0.016, 0.16),
            travelMin: clamp(Number(i.hitFxParticleTravelMin ?? i.hitfxparticletravelmin ?? 1.29) || 1.29, 0.15, 2.2),
            travelMax: clamp(Number(i.hitFxParticleTravelMax ?? i.hitfxparticletravelmax ?? 1.43) || 1.43, 0.2, 2.8),
          },
        },
      };
    const addImg = async (k, n) => {
      const f = byName(files, n);
      if (f)
        try {
          const im = await imageFromBlob(f.blob),
            m = i.preserveTextureRect ? null : imageAlphaMetrics(im);
          r.images[k] = im;
          if(k==='pause'||k==='progress')r[k==='pause'?'pauseIconURL':'progressIconURL']=await new Promise((resolve,reject)=>{
            const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(new Blob([f.blob],{type:'image/png'}));
          });
          r.imageBounds[k] = i.preserveTextureRect ? null : m?.bounds || null;
          r.imageMetrics[k] = i.preserveTextureRect ? null : m;
        } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
    };
    const phiraInfoFile =
      byName(files, "info.yml") || byName(files, "info.yaml");
    if (phiraInfoFile) {
      await Promise.allSettled([
        addImg("tap", "click.png"),
        addImg("tapMH", "click_mh.png"),
        addImg("hold", "hold.png"),
        addImg("holdMH", "hold_mh.png"),
        addImg("flick", "flick.png"),
        addImg("flickMH", "flick_mh.png"),
        addImg("drag", "drag.png"),
        addImg("dragMH", "drag_mh.png"),
        addImg("hitfx", "hit_fx.png"),
        addImg("holdHead", "hold_head.png"),
        addImg("holdHeadMH", "hold_head_mh.png"),
        addImg("holdTail", "hold_tail.png"),
        addImg("pause", "pause.png"),
        addImg("progress", "progress.png"),
      ]);
      await Promise.allSettled(
        ["click", "drag", "flick"].map(async (k) => {
          const f = files.find((x) =>
            new RegExp(`(^|/)${k}\.(ogg|wav|mp3)$`, "i").test(x.name),
          );
          if (f) r.sounds[k] = await audioBufferFromBlob(f.blob);
        }),
      );
    } else {
      for (const ns of i.noteSkins || []) {
        const raw = String(ns.name),
          map = {
            Tap: "tap",
            TapHL: "tapMH",
            Flick: "flick",
            FlickHL: "flickMH",
            Drag: "drag",
            DragHL: "dragMH",
            HoldHead: "hold",
            HoldHeadHL: "holdMH",
            HoldBody: "holdBody",
            HoldBodyHL: "holdBodyMH",
            HoldTail: "holdTail",
            HoldTailHL: "holdTailMH",
          };
        await addImg(map[raw] || raw.toLowerCase(), ns.file);
      }
      for (const hs of i.hitSounds || []) {
        const f = byName(files, hs.file);
        if (f)
          try {
            r.sounds[String(hs.name).toLowerCase()] = await audioBufferFromBlob(
              f.blob,
            );
          } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      }
    }
    return r;
  }
  function updatePackStatus() {
    const progressURL=activePack?.progressIconURL;
    document.documentElement.classList.toggle('phiOriginalProgress',!!progressURL);
    document.documentElement.style.setProperty('--phi-progress-image',progressURL?`url("${progressURL}")`:'none');
    const pauseURL=activePack?.pauseIconURL;
    document.documentElement.classList.toggle('phiOriginalPause',!!pauseURL);
    document.documentElement.style.setProperty('--phi-pause-image',pauseURL?`url("${pauseURL}")`:'none');
    const s = $("#packStatus");
    if (!s) return;
    const temporary = isTemporaryStorage(), builtin = !!activePack?.builtin,
      label = builtin ? "皮肤" : temporary ? "临时材质包" : "材质包",
      temporaryHint = temporary && !builtin ? "当前页面即时生效" : "";
    const strong = document.createElement("strong");
    strong.textContent = String(activePack?.name || "默认");
    s.replaceChildren(document.createTextNode(label + "："), strong);
    if (temporaryHint) { const small = document.createElement("small"); small.style.marginLeft = "6px"; small.style.color = "var(--muted)"; small.textContent = temporaryHint; s.appendChild(small); }
  }

  function decodeEmbeddedBase64Blob(elementId, mime = "application/zip") {
    const el = document.getElementById(elementId);
    if (!el) throw new Error(`内置资源标签不存在：${elementId}`);
    const source = String(el.textContent || "").replace(/\s+/g, "");
    if (!source) throw new Error(`内置资源为空：${elementId}`);
    // 51.0: old builds split 8+ MB base64 into ~100k tiny Uint8Arrays. That caused
    // huge allocation/GC spikes in HTML viewers and was the main source of blank
    // cards / intermittent material failures. Decode in 1 MiB-aligned chunks.
    const CHUNK = 1024 * 1024, parts = [];
    for (let start = 0; start < source.length; start += CHUNK) {
      const end = Math.min(source.length, start + CHUNK),
        bin = atob(source.slice(start, end)),
        bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      parts.push(bytes);
    }
    return new Blob(parts, { type: mime });
  }
  async function waitForEmbeddedTag(elementId, timeoutMs = 15000) {
    if (document.getElementById(elementId)) return document.getElementById(elementId);
    const started = performance.now();
    return new Promise((resolve, reject) => {
      let timer = 0, observer = null;
      const finish = (value, error = null) => {
        if (timer) clearTimeout(timer);
        observer?.disconnect?.();
        document.removeEventListener("DOMContentLoaded", check);
        error ? reject(error) : resolve(value);
      };
      const check = () => {
        if (timer) { clearTimeout(timer); timer = 0; }
        const el = document.getElementById(elementId);
        if (el) return finish(el);
        if (performance.now() - started >= timeoutMs)
          return finish(null, new Error(`内置资源标签等待超时：${elementId}`));
        timer = setTimeout(check, 40);
      };
      if (typeof MutationObserver === "function") {
        observer = new MutationObserver(check);
        observer.observe(document.documentElement, { childList:true, subtree:true });
      }
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check, { once:true });
      check();
    });
  }
  const BASE91_ALPHABET =
    "!\"#$%'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
  const BASE91_TABLE = (() => {
    const t = new Int16Array(128);
    t.fill(-1);
    for (let i = 0; i < BASE91_ALPHABET.length; i++)
      t[BASE91_ALPHABET.charCodeAt(i)] = i;
    return t;
  })();
  const BUILTIN_ASSET_MAP = new Map(
    (BUILTIN_ASSETS || []).map((x) => [String(x.id), x]),
  );
  const builtinAssetBlobCache = new PhiPerformance.ResourceCache(24*1024*1024,32);
  // Static hosting: load only resources from this site's own origin.
  const phiHostedBundleCache = new PhiPerformance.ResourceCache(12*1024*1024,32);
  async function phiHostedBytes(relativePath) {
    const url = new URL(relativePath, document.baseURI);
    if (url.origin !== location.origin || !/^https?:$/.test(url.protocol))
      throw new Error('请通过 GitHub Pages 或本地 HTTP 服务打开项目。');
    let pending = phiHostedBundleCache.get(url.href);
    if (!pending) {
      pending = (async () => {
        if (globalThis.PhiHostedMedia) return PhiHostedMedia.bytes(relativePath, {onProgress:(done,total)=>{
          if (!$('#loadingView')?.classList.contains('hidden')) setLoadingStatus(total ? `谱面 ${Math.min(100,Math.round(done/total*100))}%` : `已读取 ${Math.ceil(done/1024)} KB`);
        }});
        const response = await fetch(url.href, { credentials:'same-origin' });
        if (!response.ok) throw new Error('资源加载失败：' + relativePath + '（HTTP ' + response.status + '）');
        return new Uint8Array(await response.arrayBuffer());
      })();
      phiHostedBundleCache.set(url.href, pending);
      pending.then(bytes=>phiHostedBundleCache.setWeight(url.href,bytes.byteLength),()=>{});
      pending.catch(() => phiHostedBundleCache.delete(url.href));
    }
    return pending;
  }
  async function phiHostedAssetBytes(spec) {
    const bytes = await phiHostedBytes(spec.url), start = Number(spec.offset) || 0;
    const end = start + Number(spec.byteLength);
    if (end > bytes.byteLength) throw new Error('资源不完整：' + spec.id);
    return bytes.subarray(start, end);
  }

  function mimeForEmbeddedName(name) {
    const e = String(name || "")
      .split(".")
      .pop()
      .toLowerCase();
    return (
      {
        mp3: "audio/mpeg",
        ogg: "audio/ogg",
        wav: "audio/wav",
        m4a: "audio/mp4",
        aac: "audio/aac",
        flac: "audio/flac",
        opus: "audio/ogg",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        json: "application/json",
        pec: "text/plain",
        txt: "text/plain",
        yml: "text/yaml",
        yaml: "text/yaml",
        glsl: "text/plain",
        frag: "text/plain",
        vert: "text/plain",
        fs: "text/plain",
        vs: "text/plain",
      }[e] || "application/octet-stream"
    );
  }
  function decodeBase91Text(text) {
    let v = -1,
      b = 0,
      n = 0,
      p = 0;
    const out = new Uint8Array(Math.ceil(String(text || "").length * 0.875) + 16);
    for (let i = 0; i < text.length; i++) {
      const cc = text.charCodeAt(i),
        c = cc < 128 ? BASE91_TABLE[cc] : -1;
      if (c < 0) continue;
      if (v < 0) v = c;
      else {
        v += c * 91;
        b |= v << n;
        n += (v & 8191) > 88 ? 13 : 14;
        while (n >= 8) {
          out[p++] = b & 255;
          b >>>= 8;
          n -= 8;
        }
        v = -1;
      }
    }
    if (v >= 0) out[p++] = (b | (v << n)) & 255;
    return out.subarray(0, p);
  }

  async function waitForBuiltinAssetTags() {
    const required = [...(BUILTIN_RESOURCE_PACK?.files || []), ...BUILTIN_PACKS.flatMap(pack => pack.files || [])];
    const missing = required.filter(file => file.asset != null && !BUILTIN_ASSET_MAP.has(String(file.asset)));
    if (missing.length) throw new Error('资源清单缺失：' + missing[0].asset);
  }
  async function materializeBuiltinAsset(assetId, name = "", {signal} = {}) {
    const key = String(assetId);
    if (builtinAssetBlobCache.has(key)) return builtinAssetBlobCache.get(key);
    const pending = (async () => {
      const spec = BUILTIN_ASSET_MAP.get(key);
      if (!spec) throw new Error(`内置去重资源索引不存在：${key}`);
      let workerUnavailable=false;
      if(Number(spec.method)===14&&typeof Worker==='function'&&globalThis.PhiHostedMedia?.loadChart){
        try{
          const bytes=await PhiHostedMedia.loadChart(spec,{signal,onProgress:(done,total,stage)=>{
            if(!$('#loadingView')?.classList.contains('hidden'))setLoadingStatus(stage==='decode'?'谱面处理中…':total?`谱面 ${Math.min(100,Math.round(done/total*100))}%`:`谱面已读取 ${Math.ceil(done/1024)} KB`);
          }});
          return new Blob([bytes],{type:mimeForEmbeddedName(name)});
        }catch(error){if(error.name!=='WorkerUnavailableError')throw error;workerUnavailable=true;Diagnostics.warn('Chart.worker',error.message);}
      }
      const packed = await phiHostedAssetBytes(spec);
      if(!workerUnavailable&&Number(spec.method)===14&&typeof Worker==='function'&&globalThis.PhiHostedMedia?.decodeChart){
        try{
          const bytes=await PhiHostedMedia.decodeChart(packed,Number(spec.usize)||0);
          return new Blob([bytes],{type:mimeForEmbeddedName(name)});
        }catch(error){
          if(error.name!=='WorkerUnavailableError')throw error;
          Diagnostics.warn('Chart.worker',error.message,{fallback:'portable-main-thread'});
        }
      }
      const unpacked = Number(spec.method)===14 ? await decompressNativeChartLzma(packed,Number(spec.usize)||0) : await decompressPortable(
          packed,
          Number(spec.method),
          Number(spec.usize) || 0,
          name || `内置资源 ${key}`,
        ),
        chartPacked = unpacked[0]===80&&unpacked[1]===57&&unpacked[2]===67&&unpacked[3]===49,
        blob = new Blob([chartPacked?JSON.stringify(decodePackedNativeChart(unpacked)):unpacked], { type: mimeForEmbeddedName(name) });
      if (!chartPacked && Number(spec.usize) >= 0 && blob.size !== Number(spec.usize))
        console.warn("内置资源尺寸校验不一致", key, blob.size, spec.usize);
      if (spec.offset == null) phiHostedBundleCache.delete(new URL(spec.url, document.baseURI).href);
      return blob;
    })();
    builtinAssetBlobCache.set(key, pending);
    try {
      const blob=await pending;builtinAssetBlobCache.setWeight(key,blob.size);return blob;
    } catch (e) {
      builtinAssetBlobCache.delete(key);
      throw e;
    }
  }
  async function materializePackedFiles(list) {
    const out = [];
    for (const f of list || [])
      out.push({
        name: f.name,
        blob: await materializeBuiltinAsset(f.asset, f.name),
      });
    return out;
  }
  async function loadBuiltinResourcePack() {
    if (!BUILTIN_RESOURCE_PACK) return null;
    if (builtinResourcePackCache) return builtinResourcePackCache;
    if (builtinResourcePackPromise) return builtinResourcePackPromise;
    builtinResourcePackPromise = (async () => {
      await waitForBuiltinAssetTags();
      const sourceName =
        BUILTIN_RESOURCE_PACK.sourceName || "builtin-material.zip";
      let files, embeddedSourceTag = null;
      if (Array.isArray(BUILTIN_RESOURCE_PACK.files))
        files = await materializePackedFiles(BUILTIN_RESOURCE_PACK.files);
      else if (globalThis.PhiHostedMedia?.manifest.skin) {
        const specs = Object.entries(PhiHostedMedia.manifest.skin);
        files = new Array(specs.length);
        await mapLimit(specs, 3, async ([name, spec],index) => {files[index]={name,
          blob:new Blob([await PhiHostedMedia.bytes(spec.url,{priority:'low'})], {type:name.endsWith('.png')?'image/webp':mimeForEmbeddedName(name)})};});
      } else {
        const blob = new Blob([await phiHostedBytes("./assets/packs/original-skin.zip")], { type: "application/zip" });
        if (Number(BUILTIN_RESOURCE_PACK.byteSize) > 0 && blob.size !== Number(BUILTIN_RESOURCE_PACK.byteSize))
          throw new Error(`内置皮肤数据尺寸校验失败：${blob.size}/${BUILTIN_RESOURCE_PACK.byteSize}`);
        const file = new File([blob], sourceName, { type: "application/zip" });
        files = await unpackFile(file);
      }
      const record = await buildResourcePack(files, sourceName);
      record.name = String(BUILTIN_RESOURCE_PACK.name || record.name || "官方皮肤");
      const loaded = await loadResourcePack(record),
        missingCore = ["tap", "hold", "flick", "drag"].filter((key) => !loaded?.images?.[key]);
      if (missingCore.length)
        throw new Error(`内置皮肤贴图解码不完整：${missingCore.join(", ")}`);
      loaded.name = record.name;
      loaded.builtin = true;
      loaded.author = record.author || BUILTIN_RESOURCE_PACK.author || "";
      builtinResourcePackCache = loaded;
      embeddedSourceTag?.remove();
      return loaded;
    })();
    try {
      return await builtinResourcePackPromise;
    } catch (e) {
      builtinResourcePackPromise = null;
      throw e;
    }
  }
  async function ensureBuiltinMaterialForPlay() {
    if (activePack || !BUILTIN_RESOURCE_PACK) return activePack;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !activePack; attempt++) {
      try {
        const pending = bootResourcePackPromise || loadBuiltinResourcePack();
        const loaded = await withTimeout(pending, 20000, "内嵌材质加载超时");
        if (loaded) activePack = loaded;
        else bootResourcePackPromise = null;
      } catch (e) {
        lastError = e;
        bootResourcePackPromise = null;
        builtinResourcePackPromise = null;
        if (attempt === 0) await sleep(80);
      }
    }
    updatePackStatus();
    if (!activePack && lastError) throw lastError;
    return activePack;
  }
  async function decodeBuiltinPackBlob(entry) {
    await waitForEmbeddedTag(`phiBuiltin_${entry.id}`, 20000);
    return decodeEmbeddedBase64Blob(`phiBuiltin_${entry.id}`);
  }
  const builtinLoadPromises = new Map();
  const builtinStreamingRecords = new PhiPerformance.ResourceCache(8*1024*1024,6);
  async function materializeStreamingBuiltinPack(entry, {signal} = {}) {
    if (builtinStreamingRecords.has(entry.id)) return builtinStreamingRecords.get(entry.id);
    const pending = (async () => {
      const chartFile=entry.files.find(file=>file.name===entry.meta?.chart),
        audioFile=entry.files.find(file=>file.name===entry.meta?.music),
        artFile=entry.files.find(file=>file.name===entry.meta?.illustration),
        stream=PhiHostedMedia.manifest.audio[audioFile?.asset];
      if (!chartFile || !stream) throw Error('内置曲目清单不完整');
      // The selected cover is already available from the library. A slow,
      // optional thumbnail request must never hold the playable chart hostage.
      const chartBlob=await materializeBuiltinAsset(chartFile.asset,chartFile.name,{signal}),bgBlob=null;
      return {id:`builtin:${entry.id}`,builtinEntryId:entry.id,builtin:true,name:entry.name,sourceName:entry.sourceName,
        parser:entry.parser,chartText:await blobText(chartBlob),chartFileName:chartFile.name,
        meta:normalizeMeta({...entry.meta}),audioHash:entry.audioHash,scoreIdentity:entry.scoreIdentity,
        audioBlob:null,audioName:audioFile.name,streamAudioURL:stream.url,streamSpec:stream,
        bgBlob,bgName:artFile?.name||'',artworkAsset:artFile?.asset,assets:[],supplementalFiles:[],
        lineTextureSpecs:[],extraText:'',duration:stream.duration,notes:entry.notes,lines:entry.lines,importedAt:0};
    })();
    builtinStreamingRecords.set(entry.id,pending);
    try { const record=await pending;builtinStreamingRecords.setWeight(entry.id,record.chartText.length*2+(record.bgBlob?.size||0));return record; } catch(error) { builtinStreamingRecords.delete(entry.id); throw error; }
  }
  async function materializeBuiltinPack(entry, options = null) {
    if(options?.streaming && globalThis.PhiHostedMedia && Array.isArray(entry.files))return materializeStreamingBuiltinPack(entry,options);
    if (builtinRecordCache.has(entry.id)) return builtinRecordCache.get(entry.id);
    if (builtinLoadPromises.has(entry.id)) return builtinLoadPromises.get(entry.id);
    const pending = materializeBuiltinPackOnce(entry);
    builtinLoadPromises.set(entry.id, pending);
    try { return await pending; }
    finally { builtinLoadPromises.delete(entry.id); }
  }
  async function materializeBuiltinPackOnce(entry) {
    let unpacked;
    if (Array.isArray(entry.files))
      unpacked = await materializePackedFiles(entry.files);
    else {
      const blob = await decodeBuiltinPackBlob(entry),
        file = new File([blob], entry.sourceName || `${entry.name}.zip`, {
          type: "application/zip",
        });
      unpacked = await unpackFile(file);
    }
    const rec = await buildChartRecord(
      unpacked,
      entry.sourceName || `${entry.name}.zip`,
    );
    rec.id = `builtin:${entry.id}`;
    rec.name = entry.name || rec.name;
    rec.meta = {...rec.meta,...entry.meta};
    rec.scoreIdentity=entry.scoreIdentity || rec.scoreIdentity;
    rec.builtin = true;
    rec.audioHash = entry.audioHash || rec.audioHash;
    rec.importedAt = 0;
    builtinRecordCache.set(entry.id, rec);
    if (!Array.isArray(entry.files)) document.getElementById(`phiBuiltin_${entry.id}`)?.remove();
    return rec;
  }
  async function startBuiltinPack(entry, playOptions = null) {
    const token = ++songLoadToken;
    let stream=null,streamReady=null;
    try {
      const audioFile=entry.files?.find(file=>file.name===entry.meta?.music),spec=globalThis.PhiHostedMedia?.manifest.audio[audioFile?.asset];
      if(spec&&!playOptions?.offlineExport){
        const audio=Engine._primedMusicElement||new Audio();Engine._primedMusicElement=null;
        stream=new PhiHostedMedia.Stream(audio,spec,state=>setLoadingStatus(`音乐已缓冲 ${state.ahead.toFixed(1)} 秒 · 目标 ${Math.ceil(state.target)} 秒`));
        songLoadStream=stream;
        streamReady=stream.wait();streamReady.catch(()=>{});
      }
      const preparation=Promise.all([ensureBuiltinMaterialForPlay(),loadSavedOrAdjacentOfficialFont()]);
      preparation.catch(()=>{});
      const [record] = await Promise.all([materializeBuiltinPack(entry,{streaming:!playOptions?.offlineExport,signal:stream?.controller.signal}),beginLoadingPresentation(entry, libraryFocusBgBlob)]);
      const rec = {...record,bgBlob:record.bgBlob||libraryFocusBgBlob,_preparedStream:stream,_streamReady:streamReady};
      assertSongLoad(token);
      updateLoadingPresentation(rec, libraryFocusBgBlob);
      await startChart(rec, true, {...playOptions,loadToken:token,preparation});
    } catch (e) {
      stream?.destroy();
      if(stream){stream.audio.pause();stream.audio.removeAttribute('src');stream.audio.load();}
      if(e.name==='AbortError'||token!==songLoadToken)return;
      cancelLoadingPresentation();
      toast(`内置谱面无法开始：${e.message}`, true, 8000);
    }
  }
  function builtinSearchText(e) {
    return [
      e.name,
      e.sourceName,
      e.parser,
      e.meta?.composer,
      e.meta?.charter,
      e.meta?.level,
      e.meta?.difficultyClass,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }
  function cleanGameplaySongName(value) {
    return String(value || "")
      .replace(/_(?:EZ|HD|IN|AT|SP)(?:\s*Lv\.?\s*[0-9.]+)?$/i, "")
      .replace(/\s+\[(?:EZ|HD|IN|AT|SP)\]$/i, "")
      .trim();
  }
  let loadingArtworkURL = "", referenceLoadingAt=0, songLoadToken=0, songLoadStream=null;
  function assertSongLoad(token){if(token!==songLoadToken)throw new DOMException('已返回选歌','AbortError');}
  function setLoadingStatus(text){const node=$('#loadingProgress');if(node)node.textContent=text;}
  function clearLoadingArtwork() {
    if (loadingArtworkURL) { try { URL.revokeObjectURL(loadingArtworkURL); } catch {} }
    loadingArtworkURL = "";
    for (const id of ["#loadingBackdrop", "#loadingArtwork"]) { const el=$(id); if (el) el.style.backgroundImage=""; }
  }
  function setLoadingArtwork(blob) {
    clearLoadingArtwork();
    if (!(blob instanceof Blob)) return;
    loadingArtworkURL = URL.createObjectURL(blob);
    const image = `url("${loadingArtworkURL}")`;
    $("#loadingBackdrop").style.backgroundImage = image;
    $("#loadingArtwork").style.backgroundImage = image;
  }
  function updateLoadingPresentation(record, fallbackBlob = null) {
    const info = difficultyInfoFor(record), m = record?.meta || {};
    const loadingName = cleanGameplaySongName(record?.name || m.name || "未命名曲目");
    $("#loadingSongTitle").textContent = loadingName;
    applyLengthClass($("#loadingSongTitle"), loadingName);
    $("#loadingLevel").textContent = info.level >= 0 ? String(info.level) : "?";
    $("#loadingLevel").dataset.tier=info.tier;
    $("#loadingTitleComposer").textContent=String(m.composer||m.artist||"");
    $("#loadingIllustrator").textContent=String(m.illustrator||"");
    $("#loadingComposer").textContent = String(m.composer || m.artist || "");
    $("#loadingCharter").textContent = String(m.charter || m.chartDesigner || "");
    const blob = record?.bgBlob instanceof Blob ? record.bgBlob : fallbackBlob;
    if (blob instanceof Blob) setLoadingArtwork(blob);
  }
  async function beginLoadingPresentation(record, fallbackBlob = null) {
    const view = $("#loadingView"), library = $("#libraryView");
    clearTimeout(focusedArtworkTimer);focusedArtworkAbort?.abort();focusedArtworkGeneration++;
    referenceLoadingAt=performance.now();
    updateLoadingPresentation(record, fallbackBlob);
    view.classList.remove("hidden", "loadingExit");
    view.classList.add("loadingEnter");
    library?.classList.add("libraryLeavingForLoad");
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    setLoadingStatus('正在准备谱面…');
  }
  async function finishLoadingPresentation(token=songLoadToken) {
    const view = $("#loadingView");
    if (!view || view.classList.contains("hidden")) return;
    await sleep(Math.max(0,850-(performance.now()-referenceLoadingAt)));
    assertSongLoad(token);
    view.classList.remove("loadingEnter");
    view.classList.add("loadingExit");
    // Reference keeps the blurred loading background briefly after the card has left.
    await sleep(matchMedia('(prefers-reduced-motion: reduce)').matches?20:300);
    assertSongLoad(token);
    view.classList.add("hidden");
    view.classList.remove("loadingExit");
    $("#libraryView")?.classList.remove("libraryLeavingForLoad");
    clearLoadingArtwork();
  }
  function cancelLoadingPresentation() {
    Engine._primedMusicElement?.pause();Engine._primedMusicElement=null;
    const view=$("#loadingView");
    view?.classList.add("hidden");
    view?.classList.remove("loadingEnter","loadingExit");
    $("#libraryView")?.classList.remove("libraryLeavingForLoad");
    clearLoadingArtwork();
  }

  let libraryFocusCard = null,
    libraryFocusBgUrl = "",
    libraryFocusBgBlob = null;
  function releaseLibraryFocusBackground() {
    if (libraryFocusBgUrl) {
      try { URL.revokeObjectURL(libraryFocusBgUrl); } catch {}
    }
    libraryFocusBgUrl = "";
    libraryFocusBgBlob = null;
    const back = $("#libraryBackdropImage"), art = $("#libraryFocusArt"), profile = $("#libraryOfficialProfileArt");
    if (back) back.style.backgroundImage = "";
    if (art) art.style.backgroundImage = "";
    if (profile) profile.style.backgroundImage = "";
  }
  function setLibraryFocusBackground(blob) {
    if (blob instanceof Blob && blob === libraryFocusBgBlob) return;
    releaseLibraryFocusBackground();
    if (!(blob instanceof Blob)) return;
    libraryFocusBgBlob = blob;
    libraryFocusBgUrl = URL.createObjectURL(blob);
    const image = `url("${libraryFocusBgUrl}")`, back = $("#libraryBackdropImage"), art = $("#libraryFocusArt"), profile = $("#libraryOfficialProfileArt");
    if (back) back.style.backgroundImage = image;
    if (art) art.style.backgroundImage = image;
    if (profile) { if(dualMenuMode==="pjsk")profile.style.backgroundImage=image;else profile.style.removeProperty("background-image"); }
  }
  let libraryVisualsSuspended = false;
  function suspendLibraryVisuals() {
    clearTimeout(focusedArtworkTimer);focusedArtworkAbort?.abort();focusedArtworkGeneration++;
    if (libraryVisualsSuspended) return;
    libraryVisualsSuspended = true;
    document.body.classList.add("phiGameplayActive");
    releaseLibraryFocusBackground();
    const list = $("#chartList");
    if (list) {
      for (const card of list.querySelectorAll(".card")) {
        libraryBackgroundObserver?.unobserve(card);libraryThumbnailObserver?.unobserve(card);
        if (card._bgUrl && /^blob:/.test(card._bgUrl)) {
          try { URL.revokeObjectURL(card._bgUrl); } catch {}
          card._bgUrl = "";
        }
        card._bgBlob = null;card._fullArtworkAsset=null;
        const bg = card.querySelector(".cardBg");
        if (bg) bg.style.backgroundImage = "";
      }
    }
    // Force WebKit to commit the removal before the gameplay Canvas allocates.
    void document.body.offsetHeight;
  }
  function resumeLibraryVisuals() {
    if (!libraryVisualsSuspended) return;
    libraryVisualsSuspended = false;
    document.body.classList.remove("phiGameplayActive", "phiResultActive", "pjskModeActive");
    const list = $("#chartList");
    if (list) {
      for (const card of list.querySelectorAll(".card")) {
        if (card._bgUrl && !/^blob:/.test(card._bgUrl)) observeCardThumbnail(card);
        const id = card._bgRecordId;
        if (!id) continue;
        if (libraryBackgroundObserver) libraryBackgroundObserver.observe(card);
        else dbGetChart(id).then((record) => {
          if (record?.bgBlob && card.isConnected && card._bgRecordId === id)
            setGroupedCardBackground(card, record);
        }).catch(() => {});
      }
    }
    const focus = libraryFocusCard;
    const focusId = focus?._bgRecordId;
    if (focusId) dbGetChart(focusId).then((record) => {
      if (!libraryVisualsSuspended && focus === libraryFocusCard && record?.bgBlob)
        setGroupedCardBackground(focus, record);
    }).catch(() => {});
  }
  function nextVisualCommit() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  function resetLibraryFocusShell() {
    libraryFocusCard?.classList.remove("librarySelected");
    libraryFocusCard = null;
    releaseLibraryFocusBackground();
    const title = $("#libraryFocusTitle"), meta = $("#libraryFocusMeta"), pills = $("#libraryFocusPills"), diffs = $("#libraryFocusDifficulty");
    if (title) title.textContent = "曲目";
    if (meta) meta.textContent = "LOCAL CHART LIBRARY";
    if (pills) pills.textContent = "";
    if (diffs) diffs.replaceChildren();
    const levelBox = $("#libraryFocusLevelBox"); if (levelBox) { levelBox.querySelector("b").textContent = "?"; levelBox.querySelector("span").textContent = "LV"; }
    const recScore=$("#libraryFocusRecordScore"), recGrade=$("#libraryFocusRecordGrade"); if(recScore)recScore.textContent="0000000"; if(recGrade)recGrade.textContent="—";
    for (const id of ["#libraryFocusPlay", "#libraryFocusPjsk", "#libraryFocusExport", "#libraryFocusDelete"]) {
      const button = $(id); if (button) button.disabled = true;
    }
  }
  function syncLibraryFocus(card = libraryFocusCard) {
    if (!card?.isConnected) return;
    const selected = Math.max(0, Number(card._selectedDifficulty) || 0),
      title = $("#libraryFocusTitle"), meta = $("#libraryFocusMeta"), pills = $("#libraryFocusPills"), diffHost = $("#libraryFocusDifficulty"),
      play = $("#libraryFocusPlay"), exportBtn = $("#libraryFocusExport"), deleteBtn = $("#libraryFocusDelete"),
      sourceDiffs = [...card.querySelectorAll(".difficultyOption")], sourceUnits = [...card.querySelectorAll(".difficultyUnit")];
    if (title) title.textContent = card.querySelector("h3")?.textContent || "未命名曲目";
    if (meta) meta.textContent = card.querySelector(".meta")?.textContent || "UNKNOWN ARTIST";
    if (pills) pills.textContent = [...card.querySelectorAll(".pill")].map((x) => x.textContent).join("  ·  ");
    card.setAttribute("tabindex","0");card.setAttribute("role","button");card.setAttribute("aria-label",title?.textContent || "选择曲目");
    if (diffHost) {
      diffHost.replaceChildren();
      sourceDiffs.forEach((source, index) => {
        const button = document.createElement("button"), item = card._groupItems?.[index], info = difficultyInfoFor(item || {meta:{level:source.textContent}});
        button.type = "button";
        button.dataset.tier = info.tier || "";
        button.textContent = info.level >= 0 ? String(info.level) : (source.textContent.match(/[0-9]+(?:\.[0-9]+)?/)?.[0] || "?");
        button.classList.toggle("active", index === selected);
        button.setAttribute("aria-label",info.caption);button.setAttribute("aria-pressed",String(index===selected));
        button.onclick = () => source.click();
        diffHost.appendChild(button);
      });
    }
    const selectedItem = card._groupItems?.[selected], selectedRecord = selectedItem ? libraryPayload(selectedItem) : null,
      selectedInfo = difficultyInfoFor(selectedRecord || selectedItem || {meta:{level:sourceDiffs[selected]?.textContent || ""}}), levelBox = $("#libraryFocusLevelBox");
    if (levelBox) { levelBox.querySelector("b").textContent = selectedInfo.level >= 0 ? String(selectedInfo.level) : "?"; levelBox.querySelector("span").textContent = selectedInfo.tier || "LV"; }
    const recScore = $("#libraryFocusRecordScore"), recGrade = $("#libraryFocusRecordGrade"),
      bestScore = selectedRecord ? loadStoredBestScore(selectedRecord) : 0,
      bestGrade = selectedRecord ? loadStoredBestGrade(selectedRecord, bestScore) : "—";
    if (recScore) recScore.textContent = fmtScore(bestScore);
    if (recGrade) recGrade.textContent = bestGrade;
    card.dataset.videoRank = bestGrade || "—";
    if (play) {
      play.disabled = !card.querySelector(".play") || card.querySelector(".play").disabled;
      play.textContent = dualMenuMode === "pjsk" ? "Select" : `START · ${sourceDiffs[selected]?.textContent || "PLAY"}`;
      play.onclick = () => card.querySelector(".play")?.click();
    }
    const pjskButton = $("#libraryFocusPjsk");
    if (pjskButton) {
      pjskButton.disabled = !selectedItem;
      pjskButton.textContent = selectedItem.parser === "sus" ? "PJSK · 原生 12K" : `PJSK · 改编 ${PJSK_DEFAULT_LANES}K`;
      pjskButton.onclick = (event) => {
        if (selectedItem.parser === "sus") { card.querySelector(".play")?.click(); setLibraryMoreOpen(false); return; }
        event?.preventDefault?.();
        event?.stopPropagation?.();
        openPjskConvertPanel(selectedItem, card);
        setLibraryMoreOpen(false);
      };
    }
    if (exportBtn) {
      const target = sourceUnits[selected]?.querySelector(".difficultyExport");
      exportBtn.disabled = !target;
      exportBtn.onclick = () => target?.click();
    }
    if (deleteBtn) {
      const target = card.querySelector(".delete");
      deleteBtn.disabled = !target || target.classList.contains("hidden");
      deleteBtn.onclick = () => target?.click();
    }
    scheduleFocusedArtwork(card);
    if (card._bgBlob) setLibraryFocusBackground(card._bgBlob);
    else if (card._bgUrl && !/^blob:/.test(card._bgUrl)) {
      releaseLibraryFocusBackground();
      libraryFocusBgUrl = card._bgUrl;
      const image = `url("${libraryFocusBgUrl}")`, back = $("#libraryBackdropImage"), art = $("#libraryFocusArt"), profile = $("#libraryOfficialProfileArt");
      if (back) back.style.backgroundImage = image;
      if (art) art.style.backgroundImage = image;
      if (profile) { if(dualMenuMode==="pjsk")profile.style.backgroundImage=image;else profile.style.removeProperty("background-image"); }
    } else setLibraryFocusBackground(null);
  }
  let focusedArtworkTimer=0,focusedArtworkGeneration=0,focusedArtworkAbort=null;
  function scheduleFocusedArtwork(card){
    const item=card?._groupItems?.[card._selectedDifficulty||0],entry=item&&libraryPayload(item);
    if(!item?.builtin||libraryVisualsSuspended)return;
    const file=entry.files?.find(f=>f.name===entry.meta?.illustration);if(!file||card._fullArtworkAsset===file.asset)return;
    if(card._artworkLoadingAsset===file.asset&&card._artworkGeneration===focusedArtworkGeneration)return;
    clearTimeout(focusedArtworkTimer);focusedArtworkAbort?.abort();const generation=++focusedArtworkGeneration;
    card._artworkLoadingAsset=file.asset;card._artworkGeneration=generation;
    focusedArtworkTimer=setTimeout(async()=>{if(generation!==focusedArtworkGeneration||libraryVisualsSuspended||libraryFocusCard!==card||!$('#loadingView')?.classList.contains('hidden'))return;
      const controller=new AbortController();focusedArtworkAbort=controller;
      const active=()=>!controller.signal.aborted&&generation===focusedArtworkGeneration&&!libraryVisualsSuspended&&libraryFocusCard===card&&card.isConnected;
      try{if(globalThis.PhiHostedMedia?.manifest.artwork[file.asset]){
        await PhiHostedMedia.artwork(file.asset,{active,signal:controller.signal,onStage:(blob,stage)=>{if(!active())return;if(stage===2)card._fullArtworkAsset=file.asset;card.dataset.artworkStage=String(stage);setGroupedCardBackground(card,{bgBlob:blob});}});
      }else{const blob=await materializeBuiltinAsset(file.asset,file.name);if(!active())return;card._fullArtworkAsset=file.asset;setGroupedCardBackground(card,{bgBlob:blob});}}
      catch(error){Diagnostics.warn('Library.artwork',error?.message||String(error));}
      finally{if(card._artworkGeneration===generation)card._artworkLoadingAsset=null;}
    },180);
  }
  function focusLibraryCard(card) {
    if (!card || libraryFocusCard === card) { if (card) syncLibraryFocus(card); return; }
    libraryFocusCard?.classList.remove("librarySelected");
    libraryFocusCard = card;
    card.classList.add("librarySelected");
    syncLibraryFocus(card);
    requestAnimationFrame(()=>centerReferenceSelection(card,true));
  }

  function setGroupedCardBackground(card, c) {
    const bg = card.querySelector(".cardBg");
    if (card._bgUrl) {
      URL.revokeObjectURL(card._bgUrl);
      card._bgUrl = "";
    }
    card._bgBlob = c?.bgBlob instanceof Blob ? c.bgBlob : null;
    if (card._bgBlob && c?.id) card._bgRecordId = c.id;
    if (card._bgBlob) {
      card._bgUrl = URL.createObjectURL(card._bgBlob);
      bg.style.backgroundImage = `url("${card._bgUrl}")`;
    } else bg.style.backgroundImage = "";
    if (libraryFocusCard === card) syncLibraryFocus(card);
  }
  const libraryBackgroundObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        if (libraryVisualsSuspended) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const card = entry.target, id = card._bgRecordId;
          libraryBackgroundObserver.unobserve(card);
          if (!id || card._bgLoading) continue;
          card._bgLoading = true;
          dbGetChart(id).then((record) => {
            if (!record?.bgBlob || !card.isConnected || card._bgRecordId !== id) return;
            setGroupedCardBackground(card, record);
          }).catch((error) => Diagnostics.warn("Library.background", error?.message || String(error), { id }))
            .finally(() => { card._bgLoading = false; });
        }
      }, { root: $("#chartList"), rootMargin: "420px 0px" })
    : null;
  function mountCardThumbnail(card){
    if(libraryVisualsSuspended||!card?._bgUrl||card._bgBlob)return;
    const bg=card.querySelector('.cardBg');if(bg)bg.style.backgroundImage=`url("${card._bgUrl}")`;
  }
  const libraryThumbnailObserver=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
    for(const entry of entries)if(entry.isIntersecting){mountCardThumbnail(entry.target);libraryThumbnailObserver.unobserve(entry.target);}
  },{root:$('#chartList'),rootMargin:'160px 0px'}):null;
  function observeCardThumbnail(card){
    if(libraryThumbnailObserver)libraryThumbnailObserver.observe(card);else mountCardThumbnail(card);
  }
  function scheduleLibraryCardBackground(card, record) {
    libraryBackgroundObserver?.unobserve(card);
    card._bgRecordId = record?._summary && record?.hasBackground ? record.id : "";
    if (!card._bgRecordId) return;
    if (libraryBackgroundObserver) libraryBackgroundObserver.observe(card);
    else dbGetChart(card._bgRecordId).then((full) => {
      if (full?.bgBlob && card.isConnected && card._bgRecordId === full.id) setGroupedCardBackground(card, full);
    }).catch(() => {});
  }
  async function resolvePlayableRecord(record) {
    if (!record?._summary) return record;
    const full = await dbGetChart(record.id);
    if (!full) throw new Error("本机谱面记录不存在或已被删除");
    return full;
  }

  function makeGroupedLibraryCard(group, temporary) {
    const card = document.createElement("article");
    card._groupItems = group.items;
    card.dataset.videoRank = "—";
    card.className = `card${group.items.some((x) => x.builtin) ? " builtinCard" : ""}${group.items.length > 1 ? " multiDifficulty" : ""}${group.items.some((x) => libraryPayload(x).adminPublished) ? " adminPublished" : ""}`;
    card.innerHTML =
      '<div class="cardBg"></div><div class="cardShade"></div><button class="delete" title="删除当前难度">×</button><div class="cardBody"><div><h3></h3><div class="meta"></div><div class="difficultySelect"></div><div class="pillrow"></div></div><div class="cardActions"><button class="play">PLAY</button></div></div>';
    applyLibraryCardTitle(card.querySelector("h3"), group.name);
    const labels = uniqueDifficultyLabels(group.items),
      diffRow = card.querySelector(".difficultySelect"),
      buttons = [];
    let selected = Math.max(0, group.items.length - 1);
    for (const [i, item] of group.items.entries()) {
      const unit = document.createElement("span"),
        b = document.createElement("button"),
        exportButton = document.createElement("button");
      unit.className = "difficultyUnit";
      b.type = "button";
      b.className = "difficultyOption";
      b.textContent = labels[i];
      b.title = libraryPayload(item).sourceName || labels[i];
      b.onclick = (e) => {
        e.stopPropagation();
        select(i);
      };
      exportButton.type = "button";
      exportButton.className = "difficultyExport";
      exportButton.textContent = "导出 ZIP";
      exportButton.title = `导出 ${labels[i]} 的完整谱面包`;
      exportButton.onclick = async (e) => {
        e.stopPropagation();
        select(i);
        await exportChartDifficulty(item, exportButton);
      };
      unit.append(b, exportButton);
      diffRow.appendChild(unit);
      buttons.push(b);
    }
    const meta = card.querySelector(".meta"),
      pills = card.querySelector(".pillrow"),
      play = card.querySelector(".play"),
      del = card.querySelector(".delete");
    function select(i) {
      selected = i;
      card._selectedDifficulty = i;
      const item = group.items[i],
        c = libraryPayload(item),
        builtin = !!item.builtin,
        videoDiff = difficultyInfoFor(c);
      card.dataset.videoLevel = videoDiff.level >= 0 ? String(videoDiff.level) : "?";
      card.dataset.videoTier = videoDiff.tier || "";
      card.dataset.videoComposer = c.meta?.composer || "";
      const localBest = loadStoredBestScore(c);
      card.dataset.videoRank = loadStoredBestGrade(c, localBest);
      buttons.forEach((b, j) => b.classList.toggle("active", j === i));
      meta.textContent =
        [c.meta?.composer]
          .filter(Boolean)
          .join(" · ") ||
        c.sourceName ||
        "";
      const lines = Number(c.lines) || 0,
        notes = Number(c.notes) || 0;
      pills.innerHTML = `<span class="pill">${String(c.parser || "ZIP").toUpperCase()}</span>${lines ? `<span class="pill">${lines} LINES</span>` : ""}${notes ? `<span class="pill">${notes} NOTES</span>` : ""}${group.items.length > 1 ? `<span class="pill difficultyCount">${group.items.length} DIFF</span>` : ""}<span class="pill">${builtin ? "BUILTIN" : c.adminPublished ? "PUBLISHED" : temporary ? "TEMP" : "LOCAL"}</span>`;
      play.textContent = `PLAY · ${difficultyInfoFor(c).caption}`;
      del.classList.toggle("hidden", builtin);
      if (builtin && c.thumbnailData && !card._bgBlob) {
        const bg = card.querySelector(".cardBg");
        card._bgBlob = null;
        card._bgUrl = String(c.thumbnailData);
        observeCardThumbnail(card);
      } else if(!builtin)setGroupedCardBackground(card,c);
      if (!builtin) scheduleLibraryCardBackground(card, c);
      if (libraryFocusCard === card) syncLibraryFocus(card);
    }
    play.onclick = async () => {
      if (play.disabled) return;
      firstPlayAudioPrime = Engine.primeAudioFromGesture();
      const item = group.items[selected], c = libraryPayload(item);
      play.disabled = true;
      play.textContent = "LOADING…";
      if (item.builtin) {
        try { await startBuiltinPack(c); }
        finally { play.disabled = false; if (card.isConnected) select(selected); }
        return;
      }
      const loadToken=++songLoadToken;
      try {
        play.textContent = "LOADING…";
        await beginLoadingPresentation(c, card._bgBlob || libraryFocusBgBlob);
        const full = await resolvePlayableRecord(c);
        assertSongLoad(loadToken);
        updateLoadingPresentation(full, card._bgBlob || libraryFocusBgBlob);
        return await startChart(full, true,{loadToken});
      } catch (error) {
        if(error.name==='AbortError'||loadToken!==songLoadToken)return;
        cancelLoadingPresentation();
        toast(`无法读取本机谱面：${error.message}`, true, 7000);
      } finally {
        play.disabled = false;
        if (card.isConnected) select(selected);
      }
    };
    del.onclick = async (e) => {
      e.stopPropagation();
      const item = group.items[selected];
      if (item.builtin) return;
      const c = libraryPayload(item),
        wording = temporary ? "从本次临时谱面库移除" : "从本机谱面库删除",
        diff = difficultyInfoFor(c).caption;
      if (confirm(`${wording}“${group.name}”的 ${diff} 难度？`)) {
        await dbDeleteChart(c.id);
        if (card._bgUrl) URL.revokeObjectURL(card._bgUrl);
        renderLibrary();
      }
    };
    card.tabIndex=0;card.setAttribute("role","button");card.setAttribute("aria-label",group.name);
    card.addEventListener("keydown",event=>{if(event.target===card&&(event.key==="Enter"||event.key===" ")){event.preventDefault();focusLibraryCard(card);}});
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      focusLibraryCard(card);
    });
    select(selected);
    return card;
  }

  function disposeLibraryCard(card) {
    if (!card) return;
    libraryThumbnailObserver?.unobserve(card);
    libraryBackgroundObserver?.unobserve(card);
    card._bgRecordId = "";
    card._bgBlob = null;card._fullArtworkAsset=null;
    if (!card._bgUrl) return;
    if (/^blob:/.test(card._bgUrl)) { try { URL.revokeObjectURL(card._bgUrl); } catch {} }
    card._bgUrl = "";
  }
  function disposeLibraryCards(list) {
    if (!list) return;
    if (list.classList?.contains("card")) disposeLibraryCard(list);
    for (const card of list.querySelectorAll?.(".card") || []) disposeLibraryCard(card);
  }

  function libraryGroupMatches(group, query) {
    if (!query) return true;
    return group.items.some((item) => builtinSearchText(libraryPayload(item)).includes(query));
  }
  function normalizedProgressiveGroup(group) {
    const normalized = groupLibraryItems(group.items)[0];
    if (!normalized) return group;
    group.name = normalized.name;
    group.latest = normalized.latest;
    group.items = normalized.items;
    return group;
  }
  const libraryActiveTouches = new Set();
  let libraryTouchInFlight = false, libraryFlushTimer = 0;
  const libraryDeferredGroups = new Set();
  $("#chartList").addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    clearTimeout(libraryFlushTimer);
    libraryActiveTouches.add(event.pointerId);
    libraryTouchInFlight = true;
  }, {passive:true, capture:true});
  for (const name of ["pointerup", "pointercancel"]) document.addEventListener(name, (event) => {
    if (!libraryActiveTouches.delete(event.pointerId) || libraryActiveTouches.size) return;
    libraryFlushTimer = setTimeout(() => {
      libraryTouchInFlight = false;
      for (const flush of libraryDeferredGroups) flush();
      libraryDeferredGroups.clear();
    }, 140);
  }, {passive:true});
  async function renderLibrary() {
    const token = ++libraryRenderToken,
      list = $("#chartList"),
      temporary = isTemporaryStorage(),
      q = librarySearchQuery.trim().toLowerCase(),
      groups = new Set(),
      nameGroups = new Map(),
      hashGroups = new Map();
    libraryLastRenderedQuery = q;
    setStorageModeUI();
    resetLibraryFocusShell();
    disposeLibraryCards(list);
    list.replaceChildren();

    const loadState = document.createElement("div");
    loadState.className = "libraryLoadState";
    loadState.hidden=true;
    list.appendChild(loadState);
    let loaded = 0, total = 0, visibleGroups = 0;

    function status(done = false) {
      const statusEl=$("#libraryStatus");if(statusEl)statusEl.textContent=visibleGroups?`${visibleGroups} 首曲目`:"曲目";
    }
    function groupForItem(item) {
      const c = libraryPayload(item), nk = normalizedSongName(c.name), hk = String(c.audioHash || ""),
        byName = nk ? nameGroups.get(nk) : null, byHash = hk ? hashGroups.get(hk) : null;
      let group = byHash || byName || null;
      if (byName && byHash && byName !== byHash) {
        const keep = byName.card?.isConnected ? byName : byHash, drop = keep === byName ? byHash : byName;
        keep.items.push(...drop.items);
        drop.card && disposeLibraryCard(drop.card);
        drop.card?.remove();
        groups.delete(drop);
        for (const [key, value] of nameGroups) if (value === drop) nameGroups.set(key, keep);
        for (const [key, value] of hashGroups) if (value === drop) hashGroups.set(key, keep);
        group = keep;
      }
      if (!group) {
        group = { key: hk ? `a:${hk}` : `n:${nk}`, name: c.name || "未命名曲目", items: [], latest: Number(c.importedAt) || 0, card: null, rendered: false };
        groups.add(group);
      }
      group.items.push(item);
      normalizedProgressiveGroup(group);
      if (nk) nameGroups.set(nk, group);
      if (hk) hashGroups.set(hk, group);
      return group;
    }
    function renderGroup(group, local = false) {
      if (libraryTouchInFlight && group.card?.isConnected) {
        libraryDeferredGroups.add(() => { if (token === libraryRenderToken) renderGroup(group, local); });
        return;
      }
      const matches = libraryGroupMatches(group, q);
      if (!matches) {
        if (group.card) { disposeLibraryCard(group.card); group.card.remove(); group.card = null; }
        if (group.rendered) { group.rendered = false; visibleGroups--; }
        return;
      }
      const wasFocused = libraryFocusCard === group.card,
        next = makeGroupedLibraryCard(group, temporary);
      if (group.card?.isConnected) {
        disposeLibraryCard(group.card);
        group.card.replaceWith(next);
      } else if (local) list.insertBefore(next, loadState);
      else list.appendChild(next);
      group.card = next;
      if (wasFocused || !libraryFocusCard) focusLibraryCard(next);
      if (!group.rendered) { group.rendered = true; visibleGroups++; }
    }

    // Built-ins remain available immediately and stay after the progressive local section.
    for (const entry of BUILTIN_PACKS) {
      const group = groupForItem({ builtin: true, entry });
      renderGroup(group, false);
    }

    let keys = [];
    try { keys = await dbGetChartKeysNewest(); }
    catch (error) {
      Diagnostics.error("Library.keys", error);
      if (token === libraryRenderToken) {
        toast(`无法打开曲目：${error.message||error}`,true);
      }
      return;
    }
    if (token !== libraryRenderToken) return;
    total = keys.length;
    status(false);
    for (let i = 0; i < keys.length; i++) {
      if (token !== libraryRenderToken) return;
      const id = keys[i];
      try {
        let summary = await dbGetChartSummary(id);
        if (!summary) {
          const record = await dbGetChart(id);
          if (!record) { loaded++; status(false); continue; }
          const fixed = repairedImportedSongName(record);
          if (fixed && fixed !== record.name) { record.name = fixed; await dbPutChart(record); }
          summary = chartSummaryFromRecord(record);
          await dbPutChartSummary(summary);
        }
        const group = groupForItem({ builtin: false, record: summary });
        renderGroup(group, true);
      } catch (error) {
        Diagnostics.warn("Library.streamRecord", error?.message || String(error), { id });
      }
      loaded++;
      status(false);
      if ((loaded % LIBRARY_STREAM_YIELD_EVERY) === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (token !== libraryRenderToken) return;
    status(true);
    loadState.classList.add("complete");
    setTimeout(() => { if (token === libraryRenderToken && loadState.isConnected) loadState.remove(); }, 900);
    libraryLoadedOnce = true;
    libraryDirty = false;
    referenceSelectInitialTrack();
  }

  function drawDefaultBar(c, w, h, color, glow) {
    c.save();
    c.shadowBlur = Math.max(4, w * 0.07);
    c.shadowColor = glow;
    c.fillStyle = color;
    c.beginPath();
    c.roundRect(-w / 2, -h / 2, w, h, h / 2);
    c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = PHI_NOTE_COLORS.outline;
    c.lineWidth = Math.max(0.75, Math.min(1.35, w * 0.011));
    c.stroke();
    c.restore();
  }
  function drawDefaultFlick(c, w, h, color, glow) {
    c.save();
    c.shadowBlur = Math.max(4, w * 0.07);
    c.shadowColor = glow;
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(-w * 0.48, 0);
    c.lineTo(-w * 0.22, -h * 0.5);
    c.lineTo(w * 0.48, -h * 0.5);
    c.lineTo(w * 0.22, 0);
    c.lineTo(w * 0.48, h * 0.5);
    c.lineTo(-w * 0.22, h * 0.5);
    c.closePath();
    c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = PHI_NOTE_COLORS.outline;
    c.lineWidth = Math.max(0.75, Math.min(1.35, w * 0.011));
    c.stroke();
    c.restore();
  }
  function drawMultiGoldCoat(c, type, w, h) {
    // Double-note hint: preserve the original key colour and add only a
    // gold shell outside it.  This avoids turning blue Tap and yellow Drag
    // into the same solid-gold key while keeping the hint unmistakable.
    const coatW = w * 1.075,
      coatH = Math.max(h + 3.2, h * 1.62),
      line = Math.max(0.9, Math.min(2.2, w * 0.015));
    c.save();
    c.shadowBlur = Math.max(5, w * 0.075);
    c.shadowColor = "rgba(255,205,49,.72)";
    c.fillStyle = "#ffd447";
    c.strokeStyle = "rgba(255,244,190,.98)";
    c.lineWidth = line;
    c.beginPath();
    if (type === 4) {
      c.moveTo(-coatW * 0.49, 0);
      c.lineTo(-coatW * 0.23, -coatH * 0.5);
      c.lineTo(coatW * 0.49, -coatH * 0.5);
      c.lineTo(coatW * 0.23, 0);
      c.lineTo(coatW * 0.49, coatH * 0.5);
      c.lineTo(-coatW * 0.23, coatH * 0.5);
      c.closePath();
    } else {
      c.roundRect(-coatW / 2, -coatH / 2, coatW, coatH, coatH / 2);
    }
    c.fill();
    c.shadowBlur = 0;
    c.stroke();
    c.restore();
  }
  function defaultNoteSkin(cache, type, multi, width, height) {
    const safeWidth = clamp(finiteNumber(width, 48), 4, 4096),
      safeHeight = clamp(finiteNumber(height, Math.max(3, safeWidth * NOTE_THICKNESS_RATIO)), 1, 2048),
      logicalW = Math.max(16, Math.round(safeWidth / 4) * 4),
      bodyH = Math.max(3, type === 4 ? safeHeight * FLICK_THICKNESS_GAIN : safeHeight),
      key = `${type}:${multi ? 1 : 0}:${logicalW}:${Math.round(bodyH * 2)}`;
    let skin = cache.get(key);
    if (skin) return skin;
    const pad = Math.max(7, logicalW * 0.13),
      texW = logicalW + pad * 2,
      texH = bodyH + pad * 2,
      raster = clamp(256 / Math.max(texW, texH), 1, 2.5),
      cv = makeHoldSurface(
        Math.max(8, Math.ceil(texW * raster)),
        Math.max(8, Math.ceil(texH * raster)),
      ),
      g = cv.getContext("2d", { alpha: true, colorSpace: "srgb" });
    g.imageSmoothingEnabled = true;
    try { g.imageSmoothingQuality = "high"; } catch {}
    g.setTransform(
      raster,
      0,
      0,
      raster,
      (texW * raster) / 2,
      (texH * raster) / 2,
    );
    const baseColor =
        type === 4 ? PHI_NOTE_COLORS.flick : type === 2 ? PHI_NOTE_COLORS.drag : PHI_NOTE_COLORS.tap,
      glowColor =
        type === 4 ? PHI_NOTE_COLORS.flickGlow : type === 2 ? PHI_NOTE_COLORS.dragGlow : PHI_NOTE_COLORS.tapGlow;
    if (multi) drawMultiGoldCoat(g, type, logicalW, bodyH);
    if (type === 4) drawDefaultFlick(g, logicalW, bodyH, baseColor, glowColor);
    else drawDefaultBar(g, logicalW, safeHeight, baseColor, glowColor);
    skin = { canvas: cv, w: texW, h: texH };
    // Never clear the whole cache on a variable-size chart: that creates a
    // saw-tooth allocation/GC hitch exactly as new Notes enter the screen.
    if (cache.size >= HYPER120_MAX_NOTE_SKINS)
      cache.delete(cache.keys().next().value);
    cache.set(key, skin);
    return skin;
  }
  function normalizedTextureHeight(pack, imgKey, baseKey, targetHeight, targetWidth = 0) {
    const metrics = pack?.imageMetrics?.[imgKey],
      bounds = pack?.imageBounds?.[imgKey],
      image = pack?.images?.[imgKey],
      aspect = Number(metrics?.outerAspect) > 0
        ? Number(metrics.outerAspect)
        : Number(bounds?.sw) > 0 && Number(bounds?.sh) > 0
          ? Number(bounds.sw) / Number(bounds.sh)
          : image
            ? Number(image.naturalWidth || image.width || 0) / Math.max(1, Number(image.naturalHeight || image.height || 1))
            : 0;
    // Every custom texture keeps its own authored proportions. Single tap,
    // multi-hit tap, drag and flick are never normalized against one another.
    if (targetWidth > 0 && Number.isFinite(aspect) && aspect > 0)
      return Math.max(1, targetWidth / aspect);
    return targetHeight * (baseKey === "flick" ? FLICK_THICKNESS_GAIN : 1);
  }
  function hitFxDuration(pack) {
    return clamp(Number(pack?.hitFx?.duration) || 0.5, 0.2, 1.2);
  }
  function playPackHitSound(pack, k, volume = hitSoundVolume, when = null) {
    const b = pack?.sounds?.[k] || pack?.sounds?.[k === "click" ? "tap" : k];
    if (!b || volume <= 0) return null;
    try {
      const ac = Engine.sharedAudioContext(),
        output = Engine.hitSoundOutput(),
        targetVolume = clamp(Number(volume) || 0, 0, HIT_SOUND_MAX) * HIT_SOUND_OUTPUT_TRIM,
        startAt = Number.isFinite(when)
          ? Math.max(ac.currentTime, Number(when))
          : ac.currentTime;
      // The previous implementation allocated and connected a GainNode for every
      // single judgement. WebKit may perform graph maintenance synchronously,
      // causing a visible hitch exactly when the Note is hit. The shared hit bus
      // already is a GainNode, so update it only when the setting changes.
      if (Engine._hitVolume !== targetVolume) {
        output.gain.value = targetVolume;
        Engine._hitVolume = targetVolume;
      }
      if (Engine._hitMixer?.context === ac)
        return Engine._hitMixer.play(b, startAt);
      const s = ac.createBufferSource();
      s.buffer = b;
      s.connect(output);
      s.start(startAt);
      return s;
    } catch {
      return null;
    }
  }
  function buildTintedHitFxAtlas(img,color) {
    const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height,
      cv=makeHoldSurface(w,h),g=cv.getContext("2d",{alpha:true,colorSpace:"srgb"});
    g.drawImage(img,0,0,w,h);
    const rgba=String(color).match(/[0-9.]+/g)?.map(Number)||[255,255,255,1],
      pixels=g.getImageData(0,0,w,h),data=pixels.data,alpha=rgba[3]??1;
    for(let i=0;i<data.length;i+=4){
      data[i]=Math.round(data[i]*rgba[0]/255);data[i+1]=Math.round(data[i+1]*rgba[1]/255);
      data[i+2]=Math.round(data[i+2]*rgba[2]/255);data[i+3]=Math.round(data[i+3]*alpha);
    }
    g.putImageData(pixels,0,0);return cv;
  }
  // Measured from all eight bursts in the supplied 60 fps reference video:
  // particles remain visible for about 26 frames (0.433 s), keep a constant
  // axis-aligned square size, and follow an exponential ease-out trajectory.
  const HIT_PARTICLE_DURATION = 0.43;
  const HIT_PARTICLE_EASE_K = 2.66;
  const DEFAULT_HIT_PARTICLE = Object.freeze({
    countPerfect: 4,
    // sim-phi's default pack emits four Perfect squares but only three Good
    // squares. Preserve explicit resource-pack overrides.
    countGood: 3,
    style: "square",
    // Values are half-edge ratios. Full side = 11.0%–15.4% of the hit atlas.
    sizeMin: 0.055,
    sizeMax: 0.077,
    // Asymptotic radial distance measured against the hit-atlas footprint.
    travelMin: 1.29,
    travelMax: 1.43,
  });
  const DEFAULT_HIT_FX = {
    cols: 5,
    rows: 6,
    scale: 1,
    duration: 0.5,
    particle: DEFAULT_HIT_PARTICLE,
    tintCache: Object.create(null),
  };
  function buildDefaultHitFxAtlas(good) {
    const frameSize = 112,
      cols = DEFAULT_HIT_FX.cols,
      rows = DEFAULT_HIT_FX.rows,
      frames = cols * rows,
      cv = makeHoldSurface(frameSize * cols, frameSize * rows),
      g = cv.getContext("2d", { alpha: true }),
      color = good ? PHI_COLORS.hitFxGood : PHI_COLORS.hitFxPerfect;
    g.imageSmoothingEnabled = true;
    try { g.imageSmoothingQuality = "medium"; } catch {}
    for (let frame = 0; frame < frames; frame++) {
      const u = (frame + 0.5) / frames,
        fade = Math.pow(1 - u, 1.32),
        burst = 1 - Math.pow(1 - Math.min(1, u * 1.35), 2.25),
        cx = (frame % cols) * frameSize + frameSize / 2,
        cy = Math.floor(frame / cols) * frameSize + frameSize / 2,
        radius = frameSize * (0.07 + 0.37 * burst),
        inner = frameSize * (0.025 + 0.07 * (1 - u));
      g.save();
      g.translate(cx, cy);
      g.globalCompositeOperation = "lighter";
      g.fillStyle = color;
      g.globalAlpha = Math.min(1, fade * 1.12);
      // Eight tapered diamonds reproduce the official-like 30-frame flash but
      // are rasterized once, so gameplay only performs one drawImage per hit.
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4,
          ca = Math.cos(a), sa = Math.sin(a),
          r0 = inner * (i & 1 ? 0.7 : 1),
          r1 = radius * (i & 1 ? 0.72 : 1),
          side = frameSize * (0.018 + 0.022 * (1 - u));
        g.beginPath();
        g.moveTo(ca * r0 - sa * side, sa * r0 + ca * side);
        g.lineTo(ca * r1, sa * r1);
        g.lineTo(ca * r0 + sa * side, sa * r0 - ca * side);
        g.lineTo(ca * inner * 0.22, sa * inner * 0.22);
        g.closePath();
        g.fill();
      }
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, radius * 0.72);
      rg.addColorStop(0, "rgba(255,255,255,0.98)");
      rg.addColorStop(0.18, color);
      rg.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = rg;
      g.globalAlpha = fade;
      g.beginPath();
      g.arc(0, 0, radius * 0.72, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    return cv;
  }
  function hitFxAtlas(pack, good) {
    const img = pack?.images?.hitfx,
      spec = pack?.hitFx || DEFAULT_HIT_FX;
    if (!img) {
      const key = good ? "good" : "perfect";
      return DEFAULT_HIT_FX.tintCache[key] ||
        (DEFAULT_HIT_FX.tintCache[key] = buildDefaultHitFxAtlas(good));
    }
    if (!spec.tintCache) spec.tintCache = {};
    const key = good ? "good" : "perfect";
    if (!spec.tintCache[key])
      spec.tintCache[key] = buildTintedHitFxAtlas(
        img,
        good ? PHI_COLORS.hitFxGood : PHI_COLORS.hitFxPerfect,
      );
    return spec.tintCache[key];
  }
  function drawHitFxFrame(c, pack, x, y, noteWidth, age, good = false) {
    const spec = pack?.hitFx || DEFAULT_HIT_FX,
      duration = hitFxDuration(pack),
      u = age / duration;
    if (!(u >= 0 && u < 1)) return false;
    const img = hitFxAtlas(pack, good),
      cols = Math.max(1, spec.cols | 0),
      rows = Math.max(1, spec.rows | 0),
      frames = cols * rows,
      frame = Math.min(frames - 1, Math.floor(u * frames)),
      col = frame % cols,
      row = Math.floor(frame / cols),
      sw = (img.width || img.naturalWidth) / cols,
      sh = (img.height || img.naturalHeight) / rows,
      size = Math.max(8, noteWidth * clamp(Number(spec.scale) || 1, 0.1, 4));
    const previousAlpha = c.globalAlpha;
    c.globalAlpha = previousAlpha * (good ? 0.94 : 1);
    c.drawImage(img, col * sw, row * sh, sw, sh, x - size / 2, y - size / 2, size, size);
    c.globalAlpha = previousAlpha;
    return true;
  }

  // Hit-effect particles are independent from the animated atlas. The supplied
  // recording contains eight separate bursts. Every burst has exactly four
  // axis-aligned squares; their angles are sampled independently, so two squares
  // may cluster or overlap. There is no four-quadrant/even-spacing constraint.
  function seededRandom(seed) {
    let x = seed | 0 || 1;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return ((x >>> 0) % 1000000) / 1000000;
    };
  }
  const runtimeHitRandom = (() => {
    let seed = ((Date.now() ^ Math.floor(performance.now() * 1000)) | 0) || 1;
    try {
      const values = new Uint32Array(1);
      crypto.getRandomValues(values);
      seed ^= values[0] | 0;
    } catch {}
    return seededRandom(seed);
  })();
  function normalizedHitParticleSpec(pack, good = false) {
    const raw = pack?.hitFx?.particle || DEFAULT_HIT_PARTICLE,
      count = clamp(
        Math.round(Number(good ? raw.countGood : raw.countPerfect) || (good ? 3 : 4)),
        0,
        24,
      ),
      sizeMin = clamp(Number(raw.sizeMin) || DEFAULT_HIT_PARTICLE.sizeMin, 0.012, 0.12),
      sizeMax = Math.max(sizeMin, clamp(Number(raw.sizeMax) || DEFAULT_HIT_PARTICLE.sizeMax, 0.016, 0.16)),
      travelMin = clamp(Number(raw.travelMin) || DEFAULT_HIT_PARTICLE.travelMin, 0.15, 2.2),
      travelMax = Math.max(travelMin, clamp(Number(raw.travelMax) || DEFAULT_HIT_PARTICLE.travelMax, 0.2, 2.8));
    return {
      count,
      style: /^(circle|square|polygon)$/.test(String(raw.style || "square")) ? String(raw.style || "square") : "square",
      sizeMin,
      sizeMax,
      travelMin,
      travelMax,
    };
  }
  function createHitParticles(noteWidth, good = false, seed = null, pack = null, recycle = null) {
    // Explicit seeds are reserved for self-tests. Gameplay uses a continuously
    // advancing runtime PRNG, therefore restarting or replaying the same Note does
    // not reproduce the same four directions. Gameplay may recycle the array and
    // particle records to remove burst-GC during dense streams.
    const rnd = Number.isFinite(seed)
        ? seededRandom((Number(seed) * 2654435761) | 0)
        : runtimeHitRandom,
      spec = normalizedHitParticleSpec(pack, good),
      out = Array.isArray(recycle) ? recycle : [],
      count = spec.count;
    out.length = count;
    for (let i = 0; i < count; i++) {
      const angle = rnd() * Math.PI * 2,
        speed = spec.travelMin + rnd() * (spec.travelMax - spec.travelMin),
        size = spec.sizeMin + rnd() * (spec.sizeMax - spec.sizeMin),
        authoredSquare = spec.style === "square",
        rotation = authoredSquare ? 0 : rnd() * Math.PI * 2,
        spin = authoredSquare ? 0 : (rnd() - 0.5) * 1.35,
        p = out[i] || (out[i] = {});
      p.dx = Math.cos(angle);
      p.dy = Math.sin(angle);
      p.speed = speed;
      p.size = size;
      p.delay = 0;
      p.rotation = rotation;
      p.spin = spin;
      p.style = spec.style;
    }
    return out;
  }
  function drawHitParticles(c, e, age, quality = 1) {
    const duration = Math.min(HIT_PARTICLE_DURATION, Math.max(0.24, e.duration || 0.5)),
      particles = e.particles || [],
      limit = Math.min(particles.length, Number(e.particleCount) || particles.length),
      local = age / duration;
    if (!(local >= 0 && local < 1) || !limit) return;
    // These values are identical for all particles in one burst. Computing the
    // exponential and power once instead of once per particle removes repeated
    // transcendental work from every 120 Hz effect frame.
    const ease = 1 - Math.exp(-HIT_PARTICLE_EASE_K * local),
      fade = Math.pow(Math.max(0, 1 - local * local), 0.65);
    const previousAlpha = c.globalAlpha, previousFill = c.fillStyle;
    c.fillStyle = e.good ? PHI_COLORS.fcRgb : PHI_COLORS.apRgb;
    c.globalAlpha = fade * (e.good ? 0.82 : 0.9);
    for (let i = 0; i < limit; i++) {
      const p = particles[i],
        dist = e.size * p.speed * ease,
        x = e.x + p.dx * dist,
        y = e.y + p.dy * dist,
        // The reference squares do not pop, shrink, rotate or follow the line.
        q = Math.max(1.25, e.size * p.size);
      if (p.style === "circle") {
        c.beginPath();
        c.arc(x, y, q, 0, Math.PI * 2);
        c.fill();
      } else if (p.style === "polygon") {
        const rot = p.rotation + p.spin * local,
          rx = Math.cos(rot),
          ry = Math.sin(rot),
          px = -ry,
          py = rx;
        c.beginPath();
        c.moveTo(x + rx * q, y + ry * q);
        c.lineTo(x + px * q, y + py * q);
        c.lineTo(x - rx * q, y - ry * q);
        c.lineTo(x - px * q, y - py * q);
        c.closePath();
        c.fill();
      } else {
        c.fillRect(x - q, y - q, q * 2, q * 2);
      }
    }
    c.globalAlpha = previousAlpha;
    c.fillStyle = previousFill;
  }

  // 5.0: Phigros-style three-slice Hold.  The head and tail have a fixed size;
  // only the middle panel changes length.  The local origin is the Hold head,
  // local +Y points toward the tail, and local X follows the judgement line.
  function drawDefaultHoldRibbon(c, width, length, multi = false) {
    if (!(length > 0.35) || !(width > 1)) return;
    const w = width,
      L = length,
      baseCap = clamp(w * 0.115, 6, 24),
      cap = Math.min(baseCap, L * 0.48),
      panelW = w * 0.8,
      innerW = w * 0.68;
    const rail = Math.max(2, w * 0.047),
      dark = Math.max(1.3, w * 0.025),
      shine = Math.max(1, w * 0.018);
    c.save();
    c.shadowBlur = Math.max(5, w * 0.075);
    c.shadowColor = multi ? "rgba(255,205,65,.54)" : "rgba(76,216,255,.42)";
    const body = c.createLinearGradient(0, 0, 0, L);
    if (multi) {
      body.addColorStop(0, "rgba(255,216,76,.98)");
      body.addColorStop(0.18, "rgba(245,213,95,.91)");
      body.addColorStop(0.43, "rgba(139,215,225,.82)");
      body.addColorStop(0.78, "rgba(171,187,198,.72)");
      body.addColorStop(1, "rgba(137,141,151,.78)");
    } else {
      body.addColorStop(0, "rgba(103,232,255,.98)");
      body.addColorStop(0.3, "rgba(119,220,241,.90)");
      body.addColorStop(0.7, "rgba(171,191,202,.76)");
      body.addColorStop(1, "rgba(137,141,151,.80)");
    }
    c.fillStyle = body;
    c.beginPath();
    c.moveTo(-panelW / 2, cap * 0.28);
    c.lineTo(panelW / 2, cap * 0.28);
    c.lineTo(panelW / 2, L - cap * 0.28);
    c.lineTo(-panelW / 2, L - cap * 0.28);
    c.closePath();
    c.fill();
    c.shadowBlur = 0;

    // Side glass columns and inner shadows reproduce the layered cyan/grey body.
    const side = c.createLinearGradient(-panelW / 2, 0, panelW / 2, 0);
    side.addColorStop(0, "rgba(255,255,255,.22)");
    side.addColorStop(0.14, "rgba(116,225,246,.34)");
    side.addColorStop(0.36, "rgba(255,255,255,.055)");
    side.addColorStop(0.64, "rgba(255,255,255,.055)");
    side.addColorStop(0.86, "rgba(116,225,246,.34)");
    side.addColorStop(1, "rgba(255,255,255,.22)");
    c.fillStyle = side;
    c.fillRect(-panelW / 2, cap * 0.32, panelW, L - cap * 0.64);
    c.fillStyle = "rgba(7,15,24,.50)";
    c.fillRect(-panelW / 2, cap * 0.32, dark, L - cap * 0.64);
    c.fillRect(panelW / 2 - dark, cap * 0.32, dark, L - cap * 0.64);
    c.fillStyle = "rgba(255,255,255,.25)";
    c.fillRect(-innerW / 2, cap * 0.38, shine, L - cap * 0.76);
    c.fillRect(innerW / 2 - shine, cap * 0.38, shine, L - cap * 0.76);

    // Gold plating is deliberately concentrated at the head rather than tinting
    // the entire double-hint Hold.
    if (multi) {
      const coat = c.createLinearGradient(
        0,
        -cap * 0.65,
        0,
        Math.min(L, w * 1.15),
      );
      coat.addColorStop(0, "rgba(255,224,98,1)");
      coat.addColorStop(0.22, "rgba(255,207,48,.78)");
      coat.addColorStop(0.6, "rgba(255,207,48,.20)");
      coat.addColorStop(1, "rgba(255,207,48,0)");
      c.fillStyle = coat;
      c.fillRect(-panelW / 2, 0, panelW, Math.min(L, w * 1.15));
    }

    const railColor = multi ? "rgba(255,246,207,.98)" : "rgba(255,255,255,.98)",
      headColor = multi ? "rgba(255,208,56,.98)" : "rgba(117,231,255,.96)";
    // Fixed outer side rails.
    c.fillStyle = "rgba(5,11,18,.92)";
    c.fillRect(-w * 0.46, cap * 0.56, dark, L - cap * 1.12);
    c.fillRect(w * 0.46 - dark, cap * 0.56, dark, L - cap * 1.12);
    c.fillStyle = railColor;
    c.fillRect(-w * 0.5, cap * 0.56, rail, L - cap * 1.12);
    c.fillRect(w * 0.5 - rail, cap * 0.56, rail, L - cap * 1.12);

    // Fixed head cap (centered on the note time position).
    c.fillStyle = "rgba(5,11,18,.94)";
    c.beginPath();
    c.moveTo(-w * 0.5, -cap * 0.56);
    c.lineTo(-w * 0.43, cap * 0.56);
    c.lineTo(-w * 0.35, cap * 0.56);
    c.lineTo(-w * 0.43, -cap * 0.56);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(w * 0.5, -cap * 0.56);
    c.lineTo(w * 0.43, cap * 0.56);
    c.lineTo(w * 0.35, cap * 0.56);
    c.lineTo(w * 0.43, -cap * 0.56);
    c.closePath();
    c.fill();
    c.fillStyle = railColor;
    c.beginPath();
    c.moveTo(-w * 0.5, -cap * 0.56);
    c.lineTo(-w * 0.5 + rail, -cap * 0.56);
    c.lineTo(-w * 0.43 + rail, cap * 0.56);
    c.lineTo(-w * 0.43, cap * 0.56);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(w * 0.5, -cap * 0.56);
    c.lineTo(w * 0.5 - rail, -cap * 0.56);
    c.lineTo(w * 0.43 - rail, cap * 0.56);
    c.lineTo(w * 0.43, cap * 0.56);
    c.closePath();
    c.fill();
    c.fillStyle = headColor;
    c.fillRect(-panelW / 2, -cap * 0.12, panelW, cap * 0.4);
    c.fillStyle = "rgba(255,255,255,.68)";
    c.fillRect(-panelW / 2, -cap * 0.12, panelW, Math.max(1, cap * 0.08));

    // Fixed tail cap, mirrored at the end of the Hold.
    c.fillStyle = "rgba(5,11,18,.94)";
    c.beginPath();
    c.moveTo(-w * 0.5, L + cap * 0.56);
    c.lineTo(-w * 0.43, L - cap * 0.56);
    c.lineTo(-w * 0.35, L - cap * 0.56);
    c.lineTo(-w * 0.43, L + cap * 0.56);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(w * 0.5, L + cap * 0.56);
    c.lineTo(w * 0.43, L - cap * 0.56);
    c.lineTo(w * 0.35, L - cap * 0.56);
    c.lineTo(w * 0.43, L + cap * 0.56);
    c.closePath();
    c.fill();
    c.fillStyle = railColor;
    c.beginPath();
    c.moveTo(-w * 0.5, L + cap * 0.56);
    c.lineTo(-w * 0.5 + rail, L + cap * 0.56);
    c.lineTo(-w * 0.43 + rail, L - cap * 0.56);
    c.lineTo(-w * 0.43, L - cap * 0.56);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(w * 0.5, L + cap * 0.56);
    c.lineTo(w * 0.5 - rail, L + cap * 0.56);
    c.lineTo(w * 0.43 - rail, L - cap * 0.56);
    c.lineTo(w * 0.43, L - cap * 0.56);
    c.closePath();
    c.fill();
    c.fillStyle = "rgba(163,170,179,.90)";
    c.fillRect(-panelW / 2, L - cap * 0.28, panelW, cap * 0.4);
    c.fillStyle = "rgba(255,255,255,.62)";
    c.fillRect(-panelW / 2, L - cap * 0.28, panelW, Math.max(1, cap * 0.08));
    c.restore();
  }

  // 5.4: Hold ribbons are rasterized only once per width/style bucket. Each frame
  // reuses the cached image with a three-slice draw, so head/tail keep their
  // proportions while the gradient middle is stretched. This removes the many
  // createLinearGradient/path/shadow operations that previously ran for every
  // visible Hold on every frame.
  function makeHoldSurface(w, h) {
    const safeW = safeCanvasDimension(w), safeH = safeCanvasDimension(h);
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(safeW, safeH);
    const cv = document.createElement("canvas");
    cv.width = safeW;
    cv.height = safeH;
    return cv;
  }
  function buildHoldSkin(width, multi = false, miss = false) {
    const safeWidth = clamp(finiteNumber(width, 48), 4, 4096),
      logicalW = Math.max(28, Math.round(safeWidth / 4) * 4),
      baseLength = Math.max(240, logicalW * 4.2),
      baseCap = clamp(logicalW * 0.115, 6, 24),
      cap = Math.min(baseCap, baseLength * 0.48);
    const sidePad = Math.max(8, logicalW * 0.16),
      topPad = cap * 0.72 + 4,
      bottomPad = cap * 0.72 + 4,
      logicalTexW = logicalW + sidePad * 2,
      logicalTexH = baseLength + topPad + bottomPad;
    // Cap the raster density. Long Hold quality is governed mainly by width; a
    // huge vertical texture only wastes memory and fill-rate on mobile devices.
    const rasterScale = clamp(192 / logicalW, 1, 2.25),
      rw = Math.max(24, Math.round(logicalTexW * rasterScale)),
      rh = Math.max(96, Math.round(logicalTexH * rasterScale));
    const cv = makeHoldSurface(rw, rh),
      g = cv.getContext("2d", { alpha: true, colorSpace: "srgb" });
    g.imageSmoothingEnabled = true;
    try { g.imageSmoothingQuality = "high"; } catch {}
    g.setTransform(rasterScale, 0, 0, rasterScale, 0, 0);
    g.translate(sidePad + logicalW / 2, topPad);
    drawDefaultHoldRibbon(g, logicalW, baseLength, multi);
    if (miss) {
      // Bake the Miss appearance into the cached skin rather than applying an
      // expensive CSS/canvas filter every frame.
      g.save();
      g.globalCompositeOperation = "source-atop";
      g.fillStyle = "rgba(112,126,139,.32)";
      g.fillRect(-logicalW / 2 - sidePad, -topPad, logicalTexW, logicalTexH);
      g.restore();
    }
    const minY = -topPad,
      maxY = baseLength + bottomPad,
      headCut = cap * 0.92,
      tailCut = baseLength - cap * 0.92;
    return {
      canvas: cv,
      logicalW,
      baseLength,
      rasterScale,
      sidePad,
      topPad,
      bottomPad,
      minY,
      maxY,
      headCut,
      tailCut,
    };
  }
  function drawCachedHoldRibbon(c, width, length, multi, miss, cache) {
    if (!(length > 0.35) || !(width > 1)) return;
    const bucket = Math.max(28, Math.round(width / 4) * 4),
      key = `${bucket}|${multi ? 1 : 0}|${miss ? 1 : 0}`;
    let skin = cache.get(key);
    if (!skin) {
      skin = buildHoldSkin(bucket, multi, miss);
      cache.set(key, skin);
      if (cache.size > HYPER120_PREWARM_HOLD_SKINS * 2)
        cache.delete(cache.keys().next().value);
    }
    const sw = skin.canvas.width,
      sh = skin.canvas.height,
      rs = skin.rasterScale,
      scaleW = width / skin.logicalW;
    const srcY = (y) => (y - skin.minY) * rs,
      srcH = (a, b) => (b - a) * rs;
    const headDestTop = skin.minY * scaleW,
      headDestBottom = skin.headCut * scaleW,
      tailDestTop = length - (skin.baseLength - skin.tailCut) * scaleW,
      tailDestBottom = length + (skin.maxY - skin.baseLength) * scaleW;
    const x = -width / 2,
      dw = width;
    if (tailDestTop <= headDestBottom + 1) {
      // Very short remnants are rare; one scaled draw is cheaper and avoids
      // slice overlap artifacts.
      c.drawImage(
        skin.canvas,
        0,
        0,
        sw,
        sh,
        x,
        headDestTop,
        dw,
        Math.max(1, tailDestBottom - headDestTop),
      );
      return;
    }
    const hy0 = skin.minY,
      hy1 = skin.headCut,
      by0 = skin.headCut,
      by1 = skin.tailCut,
      ty0 = skin.tailCut,
      ty1 = skin.maxY;
    c.drawImage(
      skin.canvas,
      0,
      srcY(hy0),
      sw,
      srcH(hy0, hy1),
      x,
      headDestTop,
      dw,
      headDestBottom - headDestTop,
    );
    c.drawImage(
      skin.canvas,
      0,
      srcY(by0),
      sw,
      srcH(by0, by1),
      x,
      headDestBottom,
      dw,
      tailDestTop - headDestBottom,
    );
    c.drawImage(
      skin.canvas,
      0,
      srcY(ty0),
      sw,
      srcH(ty0, ty1),
      x,
      tailDestTop,
      dw,
      tailDestBottom - tailDestTop,
    );
  }

  // 11.4: Phira hold.png is a vertical atlas. holdAtlas stores the source
  // pixels reserved for the top tail and bottom head; only the middle is
  // stretched. The source is vertically reversed because local +Y runs from
  // the judgement-line head toward the Hold tail.
  function drawPackHoldRibbon(c, pack, width, length, multi, started) {
    if (!pack || !(length > 0.35) || !(width > 1)) return false;
    if(pack.originalPhigros){
      const body=multi&&pack.images.holdMH?pack.images.holdMH:pack.images.hold,
        head=multi&&pack.images.holdHeadMH?pack.images.holdHeadMH:pack.images.holdHead,
        tail=pack.images.holdTail;
      if(!body||!head||!tail)return false;
      const iw=body.naturalWidth||body.width,unit=width/iw,
        ppu=multi&&pack.images.holdMH?(Number(pack.info.holdHighlightPPU)||100):100;
      const draw=(img,dy,dh,dw=width)=>{
        c.save();c.translate(-dw/2,dy+dh);c.scale(1,-1);c.drawImage(img,0,0,img.naturalWidth||img.width,img.naturalHeight||img.height,0,0,dw,dh);c.restore();
      };
      draw(body,0,length);
      const hh=(head.naturalHeight||head.height)*unit;
      if(!started||pack.holdKeepHead)draw(head,-hh,hh);
      const tailUnit=unit*ppu/100;draw(tail,length,(tail.naturalHeight||tail.height)*tailUnit,(tail.naturalWidth||tail.width)*tailUnit);
      return true;
    }
    const key =
        multi && pack.images?.holdMH
          ? "holdMH"
          : pack.images?.hold
            ? "hold"
            : null,
      img = key ? pack.images[key] : null;
    if (!img) return false;
    const iw = img.naturalWidth || img.width,
      ih = img.naturalHeight || img.height,
      atlas = pack.holdAtlas?.[key] || [0, 0],
      tailPx = clamp(Math.round(Number(atlas[0]) || 0), 0, ih),
      headPx = clamp(Math.round(Number(atlas[1]) || 0), 0, ih - tailPx);
    if (
      !(
        iw > 0 &&
        ih > 0 &&
        tailPx + headPx < ih - 1 &&
        (tailPx > 0 || headPx > 0)
      )
    )
      return false;
    const bodyPx = ih - tailPx - headPx,
      ratio = width / iw,
      headH = headPx * ratio,
      tailH = tailPx * ratio,
      compact = !!pack.holdCompact;
    const slice = (sy, sh, dy, dh) => {
      if (!(sh > 0 && dh > 0.01)) return;
      c.save();
      c.translate(-width / 2, dy + dh);
      c.scale(1, -1);
      c.drawImage(img, 0, sy, iw, sh, 0, 0, width, dh);
      if (PACK_HOLD_OPACITY_BOOST > 0) {
        c.globalAlpha *= PACK_HOLD_OPACITY_BOOST;
        c.drawImage(img, 0, sy, iw, sh, 0, 0, width, dh);
      }
      c.restore();
    };
    slice(tailPx, bodyPx, 0, length);
    if ((!started || pack.holdKeepHead) && headPx > 0)
      slice(ih - headPx, headPx, compact ? -headH / 2 : -headH, headH);
    if (tailPx > 0)
      slice(0, tailPx, compact ? length - tailH / 2 : length, tailH);
    return true;
  }

  class PhiPostProcessor {
    constructor(source, shaderSources = null) {
      this.source = source;
      this.shaderSources = shaderSources || new Map();
      this.canvas = document.createElement("canvas");
      this.canvas.className = "phiPostCanvas";
      Object.assign(this.canvas.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: "2",
        display: "none",
      });
      source.parentElement?.appendChild(this.canvas);
      this.gl = this.canvas.getContext("webgl", {
          // Transparent post-processing output keeps the independent DOM artwork
          // visible beneath untouched pixels and cannot become an opaque black cover.
          alpha: true,
          antialias: false,
          depth: false,
          stencil: false,
          premultipliedAlpha: true,
          preserveDrawingBuffer: false,
          powerPreference: "high-performance",
        }) ||
        this.canvas.getContext("experimental-webgl", {
          alpha: true,
          antialias: false,
          depth: false,
          stencil: false,
          premultipliedAlpha: true,
          preserveDrawingBuffer: false,
        });
      this.programs = new Map();
      this.failed = new Set();
      this.runtimeFailed = new Set();
      this.contextLost = false;
      this.width = 0;
      this.height = 0;
      this.sourceTex = null;
      this.pingTex = [];
      this.fbo = [];
      this.buffer = null;
      this.copyProgram = null;
      this.uniformScratch = new Float32Array(4);
      this.enabled = false;
      this.onContextLost = (event) => {
        event?.preventDefault?.();
        this.contextLost = true;
        this.disable();
        Diagnostics.warn("RenderEngine.postprocess", "WebGL 上下文丢失，本局已安全停用后处理并保留基础画面");
      };
      this.onContextRestored = () => {
        try {
          this.programs.clear(); this.failed.clear(); this.runtimeFailed.clear();
          this.sourceTex = null; this.pingTex = []; this.fbo = []; this.buffer = null; this.copyProgram = null;
          this.contextLost = false; this.init();
          Diagnostics.info("RenderEngine.postprocess", "WebGL 上下文已恢复并重建后处理资源");
        } catch (error) { this.contextLost = true; this.disable(); Diagnostics.warn("RenderEngine.postprocess", error?.message || String(error)); }
      };
      if (this.gl) {
        this.canvas.addEventListener("webglcontextlost", this.onContextLost, false);
        this.canvas.addEventListener("webglcontextrestored", this.onContextRestored, false);
        this.init();
      }
    }
    init() {
      const gl = this.gl;
      this.buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      this.copyProgram = this.programForSource(
        "__copy__",
        `precision mediump float; varying vec2 uv; uniform sampler2D screenTexture; void main(){gl_FragColor=texture2D(screenTexture,uv);}`,
      );
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    }
    vertexSource() {
      return `attribute vec2 aPosition; varying vec2 uv; void main(){uv=(aPosition+1.0)*0.5;gl_Position=vec4(aPosition,0.0,1.0);}`;
    }
    builtinSource(kind) {
      if (/chromatic/.test(kind))
        return `precision mediump float; varying vec2 uv; uniform sampler2D screenTexture; uniform vec2 screenSize; uniform float power; void main(){float q=clamp(abs(power),0.0,0.25);vec2 d=vec2(q*0.16*min(screenSize.x,screenSize.y)/screenSize.x,0.0);vec4 c=texture2D(screenTexture,uv);float r=texture2D(screenTexture,uv+d).r;float b=texture2D(screenTexture,uv-d).b;gl_FragColor=vec4(r,c.g,b,c.a);}`;
      if (/radialblur|radial_blur/.test(kind))
        return `precision mediump float; varying vec2 uv; uniform sampler2D screenTexture; uniform float power; void main(){vec2 center=vec2(0.5);vec2 delta=uv-center;float p=clamp(abs(power),0.0,0.25);vec4 sum=vec4(0.0);float w=0.0;for(int i=0;i<16;i++){float f=float(i)/15.0;float k=1.0-p*f*5.0;float ww=1.0-f*0.55;sum+=texture2D(screenTexture,center+delta*k)*ww;w+=ww;}gl_FragColor=sum/max(w,0.0001);}`;
      if (/vignette/.test(kind))
        return `precision mediump float; varying vec2 uv; uniform sampler2D screenTexture; uniform float extend; uniform float radius; void main(){vec4 c=texture2D(screenTexture,uv);float d=distance(uv,vec2(0.5));float r=clamp(radius/30.0,0.25,0.85);float v=smoothstep(r*0.55,0.72,d)*clamp(0.18+extend,0.0,0.72);gl_FragColor=vec4(c.rgb*(1.0-v),c.a);}`;
      if (/sobel/.test(kind))
        return `precision mediump float; varying vec2 uv; uniform sampler2D screenTexture; uniform vec2 screenSize; uniform float strength; float lum(vec2 p){return dot(texture2D(screenTexture,p).rgb,vec3(.299,.587,.114));} void main(){vec2 d=1.0/screenSize;float gx=-lum(uv-d)+lum(uv+vec2(d.x,-d.y))-2.0*lum(uv-vec2(d.x,0.0))+2.0*lum(uv+vec2(d.x,0.0))-lum(uv+vec2(-d.x,d.y))+lum(uv+d);float gy=-lum(uv-d)-2.0*lum(uv-vec2(0.0,d.y))-lum(uv+vec2(d.x,-d.y))+lum(uv+vec2(-d.x,d.y))+2.0*lum(uv+vec2(0.0,d.y))+lum(uv+d);float edge=sqrt(gx*gx+gy*gy);vec4 c=texture2D(screenTexture,uv);gl_FragColor=vec4(mix(c.rgb,vec3(edge),clamp(strength,0.0,1.0)),c.a);}`;
      if (/rays|godray|light/.test(kind))
        return `precision mediump float; varying vec2 uv; uniform sampler2D screenTexture; uniform vec2 lightpos; uniform float exposure; uniform float decay; uniform float density; uniform float weight; void main(){vec4 color=texture2D(screenTexture,uv);vec2 delta=uv-lightpos;vec2 q=uv;float illum=1.0;vec4 rays=vec4(0.0);for(int i=0;i<32;i++){q-=delta*density;vec4 s=vec4(0.0);if(q.x>=0.0&&q.x<=1.0&&q.y>=0.0&&q.y<=1.0)s=texture2D(screenTexture,q);rays+=s*illum*weight;illum*=decay;}gl_FragColor=vec4((color+rays*exposure).rgb,color.a);}`;
      return "";
    }
    normalizeFragment(source) {
      let text = String(source || "").replace(/^\uFEFF/, "").trim();
      if (/^#version\s+100/m.test(text))
        text = text.replace(/^#version\s+100\s*/m, "");
      return text;
    }
    compile(type, source) {
      const gl = this.gl,
        shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const msg = gl.getShaderInfoLog(shader) || "shader compile failed";
        gl.deleteShader(shader);
        throw new Error(msg);
      }
      return shader;
    }
    programForSource(key, fragment) {
      if (this.programs.has(key)) return this.programs.get(key);
      if (this.failed.has(key)) return null;
      const gl = this.gl;
      try {
        const vs = this.compile(gl.VERTEX_SHADER, this.vertexSource()),
          fs = this.compile(gl.FRAGMENT_SHADER, this.normalizeFragment(fragment)),
          program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
          throw new Error(gl.getProgramInfoLog(program) || "shader link failed");
        const uniforms = new Map(),
          count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) || 0;
        for (let i = 0; i < count; i++) {
          const info = gl.getActiveUniform(program, i),
            name = String(info.name || "").replace(/\[0\]$/, "");
          uniforms.set(name, {
            type: info.type,
            size: info.size,
            location: gl.getUniformLocation(program, name),
          });
        }
        const record = {
          program,
          position: gl.getAttribLocation(program, "aPosition"),
          uniforms,
        };
        this.programs.set(key, record);
        return record;
      } catch (e) {
        console.warn(`RPE shader ${key} 编译失败：`, e);
        this.failed.add(key);
        return null;
      }
    }
    programForEffect(effect) {
      const kind = String(effect?.kind || basename(effect?.shader || "")).toLowerCase(),
        shaderName = String(effect?.shader || "").toLowerCase(),
        source =
          this.shaderSources.get(shaderName) ||
          this.shaderSources.get(basename(shaderName)) ||
          this.builtinSource(kind);
      if (!source) return null;
      return this.programForSource(`effect:${shaderName || kind}`, source);
    }
    makeTexture() {
      const gl = this.gl,
        tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }
    resize() {
      const gl = this.gl,
        w = this.source.width | 0,
        h = this.source.height | 0;
      if (!(w > 0 && h > 0)) return false;
      if (w === this.width && h === this.height) return true;
      this.width = this.canvas.width = w;
      this.height = this.canvas.height = h;
      if (!this.sourceTex) this.sourceTex = this.makeTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (let i = 0; i < 2; i++) {
        if (!this.pingTex[i]) this.pingTex[i] = this.makeTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.pingTex[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        if (!this.fbo[i]) this.fbo[i] = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i]);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pingTex[i], 0);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return true;
    }
    bindProgram(record, inputTexture) {
      const gl = this.gl;
      gl.useProgram(record.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.enableVertexAttribArray(record.position);
      gl.vertexAttribPointer(record.position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTexture);
      const sampler = record.uniforms.get("screenTexture");
      if (sampler?.location) gl.uniform1i(sampler.location, 0);
    }
    setUniforms(record, effect, time) {
      const gl = this.gl;
      for (const [name, spec] of record.uniforms) {
        const loc = spec.location;
        if (loc == null || name === "screenTexture") continue;
        if (name === "screenSize") {
          gl.uniform2f(loc, this.width, this.height);
          continue;
        }
        if (name === "time") {
          gl.uniform1f(loc, Number(time) || 0);
          continue;
        }
        const events = effect?.vars?.[name];
        if (!events?.length) continue;
        const first = events[0]?.a;
        if (ArrayBuffer.isView(first) || Array.isArray(first)) {
          const len = first.length || 2,
            value = rpeVectorValueFast(events, time, first, this.uniformScratch);
          if (spec.type === gl.FLOAT_VEC2) gl.uniform2f(loc, value[0], value[1]);
          else if (spec.type === gl.FLOAT_VEC3) gl.uniform3f(loc, value[0], value[1], value[2]);
          else if (spec.type === gl.FLOAT_VEC4) gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
          continue;
        }
        const value = eventValueFast(events, time, 0);
        if (spec.type === gl.INT || spec.type === gl.BOOL) gl.uniform1i(loc, Math.round(value));
        else gl.uniform1f(loc, value);
      }
    }
    drawPass(record, inputTexture, framebuffer, effect, time, scissor = null, clear = true) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, this.width, this.height);
      if (clear) {
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      if (scissor) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(scissor.x, scissor.y, scissor.w, scissor.h);
      } else gl.disable(gl.SCISSOR_TEST);
      this.bindProgram(record, inputTexture);
      if (effect) this.setUniforms(record, effect, time);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disable(gl.SCISSOR_TEST);
    }
    upload() {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
    }
    warm(effects) {
      if (!this.gl || !effects?.length || !this.resize()) return false;
      try {
        this.upload();
        const seen = new Set();
        for (const effect of effects) {
          const record = this.programForEffect(effect);
          if (!record || seen.has(record.program)) continue;
          seen.add(record.program);
          this.drawPass(record, this.sourceTex, this.fbo[0], effect, Number(effect.st) || 0, { x: 0, y: 0, w: 1, h: 1 }, true);
        }
        this.gl.finish();
        this.disable();
        return true;
      } catch (e) {
        console.warn("RPE GPU 后处理预热失败，将在播放时自动回退：", e);
        this.disable();
        return false;
      }
    }
    render(effects, time, scissorProvider = null) {
      if (!this.gl || this.contextLost || !effects?.length || !this.resize()) {
        this.disable();
        return false;
      }
      try {
        this.upload();
        let input = this.sourceTex,
          ping = 0,
          used = 0;
        for (const effect of effects) {
          const runtimeKey = String(effect?.shader || effect?.kind || "unnamed-effect").toLowerCase();
          if (this.runtimeFailed.has(runtimeKey)) continue;
          const record = this.programForEffect(effect);
          if (!record) continue;
          const target = this.fbo[ping],
            scissor = effect.global === false ? scissorProvider?.(effect) : null;
          if (scissor === false) continue;
          try {
            if (scissor) {
              this.drawPass(this.copyProgram, input, target, null, time, null, true);
              this.drawPass(record, input, target, effect, time, scissor, false);
            } else this.drawPass(record, input, target, effect, time, null, true);
            input = this.pingTex[ping];
            ping ^= 1;
            used++;
          } catch (error) {
            // Isolate one malformed effect instead of dropping the complete chain
            // or retrying the same exception every frame.
            this.runtimeFailed.add(runtimeKey);
            Diagnostics.warn("RenderEngine.postprocess", `已隔离异常后处理：${runtimeKey}`, {
              message: error?.message || String(error),
            });
          }
        }
        if (!used) {
          this.disable();
          return false;
        }
        this.drawPass(this.copyProgram, input, null, null, time, null, true);
        if (!this.enabled) {
          this.canvas.style.display = "block";
          this.enabled = true;
        }
        // Keep the native foreground visible above the effect layer. The shader
        // still produces trails/halos around transparent edges, but cannot bleach
        // the centre colour of Notes or judgement lines.
        this.source.style.opacity = "";
        return true;
      } catch (e) {
        Diagnostics.error("RenderEngine.postprocess", e, { action:"已关闭对应 WebGL 后处理并保留 Canvas 基础画面" });
        this.disable();
        return false;
      }
    }
    disable() {
      if (!this.enabled) return;
      this.enabled = false;
      if (this.canvas) this.canvas.style.display = "none";
      if (this.source) this.source.style.opacity = "";
    }
    destroy() {
      this.disable();
      const gl = this.gl;
      if (gl) {
        for (const record of this.programs?.values?.() || []) try { gl.deleteProgram(record.program); } catch {}
        try { if (this.copyProgram?.program) gl.deleteProgram(this.copyProgram.program); } catch {}
        for (const texture of [this.sourceTex, ...(this.pingTex || [])]) try { if (texture) gl.deleteTexture(texture); } catch {}
        for (const framebuffer of this.fbo || []) try { if (framebuffer) gl.deleteFramebuffer(framebuffer); } catch {}
        try { if (this.buffer) gl.deleteBuffer(this.buffer); } catch {}
      }
      this.canvas?.removeEventListener?.("webglcontextlost", this.onContextLost, false);
      this.canvas?.removeEventListener?.("webglcontextrestored", this.onContextRestored, false);
      try {gl?.getExtension("WEBGL_lose_context")?.loseContext();}catch{}
      if(this.canvas)this.canvas.width=this.canvas.height=1;
      this.canvas?.remove();
      this.canvas = null;
      this.gl = null;
      this.programs?.clear();
      this.failed?.clear();
      this.runtimeFailed?.clear();
    }
  }


  function isAppleTouchDevice() {
    const ua = String(navigator.userAgent || "");
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(navigator.maxTouchPoints || 0) > 1);
  }


  function canvasBlob(canvas, type = "image/jpeg", quality = 0.84) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => blob && blob.size > 0 ? resolve(blob) : reject(new Error("磨砂背景编码失败")), type, quality);
      } catch (error) { reject(error); }
    });
  }
  function boxBlurPass(src, dst, w, h, radius, horizontal) {
    const channels = 4, span = radius * 2 + 1;
    if (horizontal) {
      for (let y = 0; y < h; y++) {
        let sr = 0, sg = 0, sb = 0, sa = 0;
        const row = y * w;
        for (let k = -radius; k <= radius; k++) {
          const x = clamp(k, 0, w - 1), i = (row + x) * channels;
          sr += src[i]; sg += src[i + 1]; sb += src[i + 2]; sa += src[i + 3];
        }
        for (let x = 0; x < w; x++) {
          const o = (row + x) * channels;
          dst[o] = sr / span; dst[o + 1] = sg / span; dst[o + 2] = sb / span; dst[o + 3] = sa / span;
          const lx = clamp(x - radius, 0, w - 1), rx = clamp(x + radius + 1, 0, w - 1),
            li = (row + lx) * channels, ri = (row + rx) * channels;
          sr += src[ri] - src[li]; sg += src[ri + 1] - src[li + 1];
          sb += src[ri + 2] - src[li + 2]; sa += src[ri + 3] - src[li + 3];
        }
      }
    } else {
      for (let x = 0; x < w; x++) {
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let k = -radius; k <= radius; k++) {
          const y = clamp(k, 0, h - 1), i = (y * w + x) * channels;
          sr += src[i]; sg += src[i + 1]; sb += src[i + 2]; sa += src[i + 3];
        }
        for (let y = 0; y < h; y++) {
          const o = (y * w + x) * channels;
          dst[o] = sr / span; dst[o + 1] = sg / span; dst[o + 2] = sb / span; dst[o + 3] = sa / span;
          const ty = clamp(y - radius, 0, h - 1), by = clamp(y + radius + 1, 0, h - 1),
            ti = (ty * w + x) * channels, bi = (by * w + x) * channels;
          sr += src[bi] - src[ti]; sg += src[bi + 1] - src[ti + 1];
          sb += src[bi + 2] - src[ti + 2]; sa += src[bi + 3] - src[ti + 3];
        }
      }
    }
  }
  async function createStaticFrostedBlob(image, viewportW = 16, viewportH = 9, backgroundDim = 0.6) {
    const iw = Number(image?.naturalWidth || image?.width) || 0,
      ih = Number(image?.naturalHeight || image?.height) || 0;
    if (!(iw > 0 && ih > 0)) throw new Error("曲绘尺寸无效");
    const safeViewportW = Math.max(1, finiteNumber(viewportW, 16)),
      safeViewportH = Math.max(1, finiteNumber(viewportH, 9)),
      aspect = Math.max(0.5, safeViewportW / safeViewportH),
      targetSide = Math.min(FROSTED_RASTER_MAX_SIDE, Math.max(96, Math.ceil(safeViewportW * Math.max(1, devicePixelRatio || 1)))),
      tw = safeCanvasDimension(Math.min(iw, targetSide), 960, 8192),
      th = safeCanvasDimension(Math.min(ih, Math.max(72, tw / aspect)), 540, 8192),
      canvas = document.createElement("canvas");
    canvas.width = tw; canvas.height = th;
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!ctx) throw new Error("无法建立磨砂背景画布");
    const sourceAspect = iw / ih;
    let sx = 0, sy = 0, sw = iw, sh = ih;
    if (sourceAspect > aspect) { sw = ih * aspect; sx = (iw - sw) * 0.5; }
    else { sh = iw / aspect; sy = (ih - sh) * 0.5; }
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, tw, th);
    const frame = ctx.getImageData(0, 0, tw, th),
      a = new Uint8ClampedArray(frame.data),
      b = new Uint8ClampedArray(a.length),
      radius = Math.max(4, Math.round(Math.min(tw, th) / 42));
    let maxChannel = 0, alphaCount = 0;
    for (let i = 0; i < a.length; i += 4) {
      maxChannel = Math.max(maxChannel, a[i], a[i + 1], a[i + 2]);
      if (a[i + 3] > 8) alphaCount++;
    }
    if (alphaCount < tw * th * 0.7 || maxChannel < 3) throw new Error("曲绘像素读取异常");
    let src = a, dst = b;
    for (let pass = 0; pass < 3; pass++) {
      boxBlurPass(src, dst, tw, th, radius, true); [src, dst] = [dst, src];
      boxBlurPass(src, dst, tw, th, radius, false); [src, dst] = [dst, src];
    }
    for (let i = 0; i < src.length; i += 4) {
      const gray = src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114,
        sat = 0.84, bright = clamp(1 - clamp(Number(backgroundDim) || 0, 0, 1) * 0.37, 0.35, 1);
      src[i] = clamp((gray + (src[i] - gray) * sat) * bright, 0, 255);
      src[i + 1] = clamp((gray + (src[i + 1] - gray) * sat) * bright, 0, 255);
      src[i + 2] = clamp((gray + (src[i + 2] - gray) * sat) * bright, 0, 255);
      src[i + 3] = 255;
    }
    frame.data.set(src);
    ctx.putImageData(frame, 0, 0);
    return canvasBlob(canvas, "image/png");
  }

  async function createStaticFrostedBlobThreaded(blob, viewportW = 16, viewportH = 9, backgroundDim = 0.6) {
    if (!(blob instanceof Blob) || typeof Worker !== "function" || typeof OffscreenCanvas !== "function")
      throw new Error("当前环境没有可用的 OffscreenCanvas Worker");
    const workerSource = `
      const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
      ${boxBlurPass.toString()}
      self.onmessage=async(event)=>{
        try{
          const {blob,viewportW,viewportH,dim,maxSide}=event.data;
          const bitmap=await createImageBitmap(blob),iw=bitmap.width,ih=bitmap.height;
          if(!(iw>0&&ih>0))throw new Error('曲绘尺寸无效');
          const vw=Number.isFinite(Number(viewportW))?Math.max(1,Number(viewportW)):16,
            vh=Number.isFinite(Number(viewportH))?Math.max(1,Number(viewportH)):9,
            side=Number.isFinite(Number(maxSide))?Math.max(96,Math.min(8192,Number(maxSide))):2048,
            aspect=Math.max(.5,vw/vh),tw=Math.max(96,Math.round(Math.min(iw,side))),th=Math.max(72,Math.round(tw/aspect)),
            canvas=new OffscreenCanvas(tw,th),ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
          if(!ctx)throw new Error('无法建立后台磨砂画布');
          const sourceAspect=iw/ih;let sx=0,sy=0,sw=iw,sh=ih;
          if(sourceAspect>aspect){sw=ih*aspect;sx=(iw-sw)*.5}else{sh=iw/aspect;sy=(ih-sh)*.5}
          ctx.drawImage(bitmap,sx,sy,sw,sh,0,0,tw,th);bitmap.close?.();
          const frame=ctx.getImageData(0,0,tw,th),a=new Uint8ClampedArray(frame.data),b=new Uint8ClampedArray(a.length),
            radius=Math.max(4,Math.round(Math.min(tw,th)/42));
          let src=a,dst=b;
          for(let pass=0;pass<3;pass++){boxBlurPass(src,dst,tw,th,radius,true);[src,dst]=[dst,src];boxBlurPass(src,dst,tw,th,radius,false);[src,dst]=[dst,src]}
          const bright=clamp(1-clamp(Number(dim)||0,0,1)*.37,.35,1);
          for(let i=0;i<src.length;i+=4){const gray=src[i]*.299+src[i+1]*.587+src[i+2]*.114,sat=.84;src[i]=clamp((gray+(src[i]-gray)*sat)*bright,0,255);src[i+1]=clamp((gray+(src[i+1]-gray)*sat)*bright,0,255);src[i+2]=clamp((gray+(src[i+2]-gray)*sat)*bright,0,255);src[i+3]=255}
          frame.data.set(src);ctx.putImageData(frame,0,0);
          const output=await canvas.convertToBlob({type:'image/png'});
          self.postMessage({ok:true,blob:output});
        }catch(error){self.postMessage({ok:false,error:error?.message||String(error)})}
      };`,
      url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })),
      worker = new Worker(url);
    try {
      const task = new Promise((resolve, reject) => {
        worker.onmessage = (event) => event.data?.ok ? resolve(event.data.blob) : reject(new Error(event.data?.error || "后台磨砂失败"));
        worker.onerror = (event) => reject(new Error(event.message || "后台磨砂线程失败"));
        worker.postMessage({ blob, viewportW, viewportH, dim: backgroundDim, maxSide: Math.min(FROSTED_RASTER_MAX_SIDE, Math.ceil(Math.max(96, viewportW * Math.max(1, devicePixelRatio || 1)))) });
      });
      const output = await withTimeout(task, 10000, "后台磨砂线程超时");
      Diagnostics.info("RenderWorker.background", "曲绘已由 OffscreenCanvas Worker 预处理", { bytes: output?.size || 0 });
      return output;
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  }

  class HighRefreshController {
    constructor() {
      this.active = false;
      this.requestAccepted = false;
      this.samples = 0;
      this.cadenceEma = 0; this.cadenceFloor=0; this.cadenceCandidate=0; this.cadenceCandidateCount=0;
    }
    start() {
      if (this.active) return;
      this.active = true;
      this.requestAccepted = false;
      this.samples = 0;
      this.cadenceEma = 0; this.cadenceFloor=0; this.cadenceCandidate=0; this.cadenceCandidateCount=0;
    }
    observe(interval) {
      if (!this.active || !Number.isFinite(interval) || interval <= 0) return;
      if (interval > 3.5 && interval < 40) {
        if(!this.cadenceCandidate||interval<this.cadenceCandidate*.82||interval>this.cadenceCandidate*1.22){
          this.cadenceCandidate=interval;this.cadenceCandidateCount=1;
        }else{this.cadenceCandidate=this.cadenceCandidate*.8+interval*.2;this.cadenceCandidateCount++;}
        if(this.cadenceCandidateCount>=8)this.cadenceFloor=this.cadenceFloor?Math.min(this.cadenceFloor,this.cadenceCandidate):this.cadenceCandidate;
      } else {
        this.cadenceCandidate=0;this.cadenceCandidateCount=0;
      }
      this.samples = Math.min(360, this.samples + 1);
      this.cadenceEma = this.cadenceEma
        ? this.cadenceEma * 0.92 + interval * 0.08
        : interval;
      // rAF is intentionally left uncapped. We only measure what the browser
      // actually delivers, then make the performance budget follow that cadence.
      if (this.samples >= 24) this.requestAccepted = this.cadenceEma < 10.2;
    }
    measuredHz() {
      if (!(this.samples >= 12 && this.cadenceEma > 0)) return 0;
      // Do not round 110 Hz up to a claimed 120 Hz. The stable fastest cadence
      // separately sets the work budget; this number reports delivered callbacks.
      return 1000 / this.cadenceEma;
    }
    targetMs(fallback = FRAME_TARGET_MS) {
      const hz = this.measuredHz();
      const measured=hz>=45?1000/hz:(this.cadenceFloor||fallback);
      return this.cadenceFloor>0?Math.min(measured,this.cadenceFloor):measured;
    }
    stop() {
      this.active = false;
      this.requestAccepted = false;
      this.samples = 0;
      this.cadenceEma = 0; this.cadenceFloor=0; this.cadenceCandidate=0; this.cadenceCandidateCount=0;
    }
    setActive(value) {
      if (value) this.start();
      else this.stop();
    }
  }
  const highRefreshController = new HighRefreshController();


  class PerformanceMonitor {
    constructor() {
      this.samples = new Float32Array(180);
      this.work = new Float32Array(180);
      this.index = 0;
      this.count = 0;
      this.max = 0;
      this.intervalEma = 0;
      this.visible = false;
      this.miniEnabled = false;
      this.gameActive = false;
      this.nextPaint = 0;
      this.el = null;
      this.miniEl = null;
      this.sixtySince = 0;
      this.capNoticeShown = false;
      this.longTasks = 0;
      try { this.longTaskObserver = new PerformanceObserver((list) => { this.longTasks += list.getEntries().length; }); this.longTaskObserver.observe({ type: "longtask", buffered: true }); } catch {}
    }
    ensureElement() {
      if (this.el) return this.el;
      const el = document.createElement("div");
      el.id = "phiPerformanceOverlay";
      el.className = "phiPerfOverlay hidden";
      el.textContent = "开始游玩后显示输入与帧率详情";
      document.body.appendChild(el);
      this.el = el;
      return el;
    }
    ensureMiniElement() {
      if (this.miniEl) return this.miniEl;
      const el = document.createElement("div");
      el.id = "phiFpsOverlay";
      el.className = "phiFpsOverlay hidden";
      el.textContent = "FPS --";
      document.body.appendChild(el);
      this.miniEl = el;
      return el;
    }
    setMiniEnabled(value) {
      this.miniEnabled = !!value;
      if (!this.miniEnabled && !this.miniEl) return;
      this.ensureMiniElement().classList.toggle("hidden", !(this.miniEnabled && this.gameActive));
    }
    setGameActive(value) {
      this.gameActive = !!value;
      highRefreshController.setActive(this.gameActive);
      if (this.miniEl) this.miniEl.classList.toggle("hidden", !(this.miniEnabled && this.gameActive));
      if (!this.gameActive) {
        this.index = 0;
        this.count = 0;
        this.max = 0;
        this.intervalEma = 0;
        this.sixtySince = 0;
        this.capNoticeShown = false;
      }
    }
    frame(engine, interval, drawCost, workCost, now, force = false) {
      if (Number.isFinite(interval) && interval > 0) {
        this.samples[this.index++ % this.samples.length] = interval;
        this.count = Math.min(this.count + 1, this.samples.length);
        this.max = Math.max(this.max * 0.995, interval);
        this.intervalEma = this.intervalEma
          ? this.intervalEma * 0.9 + interval * 0.1
          : interval;
      }
      if (!this.visible && !this.miniEnabled) return;
      if (!force && now < this.nextPaint) return;
      this.nextPaint = now + FPS_MINI_PAINT_MS;
      const fps = this.intervalEma ? 1000 / this.intervalEma : 0,
        detectedHz = highRefreshController.measuredHz();
      if (this.miniEnabled && this.gameActive) {
        const mini=this.ensureMiniElement();mini.classList.remove("hidden");mini.textContent=`FPS ${fps?fps.toFixed(1):"--"}`;
      }

      if (!this.visible) return;
      let sum = 0;
      for (let i = 0; i < this.count; i++) {
        const value = this.samples[i];
        this.work[i] = value;
        sum += value;
      }
      const values = this.work.subarray(0, this.count);
      values.sort();
      const avg = this.count ? sum / this.count : 0,
        p99 = this.count ? values[Math.min(this.count - 1, Math.floor(this.count * 0.99))] : 0,
        fullFps = avg ? 1000 / avg : 0,
        low = p99 ? 1000 / p99 : 0;
      const el = this.ensureElement();
      el.textContent = [
        `修复版本 ${PHI_VERSIONS.runtime}`,
        `FPS ${fullFps.toFixed(1)} | 1% low ${low.toFixed(1)}`,
        `Frame ${avg.toFixed(2)} ms | Max ${this.max.toFixed(2)} ms | Work ${Number(workCost || 0).toFixed(2)} ms | Draw ${Number(drawCost || 0).toFixed(2)} ms`,
        `帧稳定：音频时钟直驱 | 输入几何独立 | 画布按设备预算固定`,
        `rAF 实测 ${detectedHz ? detectedHz.toFixed(1) + " Hz" : "探测中"} | 帧预算 ${engine?.systemFrameTargetMs ? engine.systemFrameTargetMs.toFixed(2) : "8.33"} ms`,
        engine?.chart?.kind === "pjsk"
          ? `点按接收 ${engine?.inputStats?.edges || 0} | PJSK 判定见游戏分数`
          : `点按接收 ${engine?.inputStats?.edges || 0} | 蓝键/长条 ${engine?.inputStats?.accepted || 0} | 无候选 ${engine?.inputStats?.noCandidate || 0} | 噪域 ${engine?.inputStats?.blocked || 0} | 早 Bad 保护 ${engine?.inputStats?.earlyGuard || 0}`,
        `输入接管 ${engine?.inputStats?.bridges || 0} | 补收 ${engine?.inputStats?.recovered || 0} | 最大派发延迟 ${Number(engine?.inputStats?.maxDispatchMs || 0).toFixed(1)} ms`,
        `原始按下 Pointer ${engine?.inputStats?.pointerDown || 0} / Touch ${engine?.inputStats?.touchStart || 0} | 缓冲中按下 ${engine?.inputStats?.buffered || 0}`,
        engine?.streamSession ? `音乐/谱面时钟差 ${((Number(engine.clockValue||0)-Number(engine.audio?.currentTime||0))*1000).toFixed(1)} ms | 音乐缓冲 ${PhiHostedMedia.bufferedAhead(engine.audio).toFixed(1)} 秒` : `音频后端 ${engine?.musicUsingWebAudio?'Web Audio':'媒体元素'}`,
        `判定候选 ${engine?.metricsCandidates || 0} | 空间候选 ${engine?.metricsIndexedCandidates || 0} / ${engine?.noteItems?.length || 0} | 实绘 ${engine?.metricsDrawnNotes || 0}`,
        `粒子 ${engine?.effects?.length || 0} | DPR ${Number(engine?.baseDpr || 1).toFixed(2)} × ${Number(engine?.renderQuality || 1).toFixed(2)} | backing ${engine?.canvas?.dataset?.backingSize || "--"}`,
        `抖动帧 ${engine?.jankFrames || 0} | 判定邻近抖动 ${engine?.hitJankFrames || 0} | Audio ${Engine._hitMixer ? "Worklet Mixer" : "BufferSource fallback"}`,
        `后端 Canvas2D${engine?.postProcessor?.gl ? " + WebGL 后处理" : ""} | Audio drift ${(Number(engine?.clockDrift || 0) * 1000).toFixed(2)} ms`,
      ].join("\n");
    }
    snapshot() {
      const values = Array.from(this.samples.subarray(0, this.count)).filter((value) => value > 0).sort((a, b) => a - b), pick = (q) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * q))] : 0;
      return { samples: values.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: values.length ? values[values.length - 1] : 0, longTasks: this.longTasks };
    }
    refresh(source) {
      if (!source) return;
      // Paint the latest input counters without inventing a frame-time sample.
      this.frame(source,0,source.drawCostAvg||0,source.frameWorkAvg||0,performance.now(),true);
    }
    toggle(force) {
      this.visible = force == null ? !this.visible : !!force;
      this.ensureElement().classList.toggle("hidden", !this.visible);
      const button = $("#inputDiagnosticsBtn");
      if (button) {
        button.setAttribute("aria-pressed",String(this.visible));
        button.textContent = this.visible ? "关闭输入与帧率详情" : "输入与帧率详情";
      }
      if (this.visible && typeof engine === "object" && engine) this.refresh(engine);
    }
  }
  const performanceMonitor = new PerformanceMonitor();

  class KeyboardInputManager {
    constructor() {
      this.down = new Set();
      this.boundDown = (event) => this.keyDown(event);
      this.boundUp = (event) => this.keyUp(event);
      this.boundBlur = () => this.clear("blur");
      window.addEventListener("keydown", this.boundDown, { capture: true });
      window.addEventListener("keyup", this.boundUp, { capture: true });
      window.addEventListener("blur", this.boundBlur);
    }
    async load() {}
    isTypingTarget(target) {
      return !!target?.closest?.('input,textarea,select,[contenteditable="true"]');
    }
    isGameplayKey(event) {
      const code = event?.code || "";
      if (!code || KEYBOARD_RESERVED_CODES.has(code) || KEYBOARD_MODIFIER_CODES.has(code)) return false;
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      return true;
    }
    keyDown(event) {
      const code = event.code;
      if (this.isTypingTarget(event.target)) return;
      if (code === "F1") { event.preventDefault(); Diagnostics.toggle(); return; }
      if (code === "F2") { event.preventDefault(); performanceMonitor.toggle(); return; }
      if (code === "F3") { event.preventDefault(); applyChartRevealEnabled(!chartRevealEnabled); return; }
      if (code === "F11") { toast("F11 全屏由浏览器管理；部分 WebView 可能不支持"); return; }
      if (code === "Escape") {
        event.preventDefault();
        if (engine?.running) engine.paused ? engine.resume() : engine.pause("keyboard");
        return;
      }
      if (code === "Enter") {
        if (!$("#pausePanel")?.classList.contains("hidden")) { event.preventDefault(); engine?.resume(); }
        return;
      }
      if (code === "KeyR" && engine?.running && engine.paused && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const targetEngine = engine;
        void targetEngine.restart().catch((error) => {
          if (engine === targetEngine) toast(`重新开始失败：${error?.message || error}`, true, 7000);
        });
        return;
      }
      if (event.repeat || !this.isGameplayKey(event)) return;
      if (!engine?.running || engine.paused || engine.starting || engine.resumePending || engine.autoplay) return;
      event.preventDefault();
      this.down.add(code);
      engine.keyboardDown(code);
    }
    keyUp(event) {
      const code = event.code;
      if (!this.down.has(code)) return;
      event.preventDefault();
      this.down.delete(code);
      engine?.keyboardUp(code);
    }
    clear(reason = "clear") {
      if (!this.down.size) return;
      this.down.clear();
      engine?.keyboardAllReleased(performance.now() / 1000);
      Diagnostics.info("InputManager.keyboard", "全区域键盘状态已清理", { reason });
    }
    hasGameplayKey() { return this.down.size > 0; }
  }
  let keyboardInput = null;

  // A dedicated AudioWorklet mixes judgement sounds on Web Audio's render
  // thread. Every accepted judgement gets its own voice; the optimization only
  // moves mixing off the main thread and never merges authored feedback.
  // Safari versions without AudioWorklet keep the proven BufferSource fallback.
  function phiHitAudioWorkletModule() {
    class PhiHitMixerProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.samples = new Map();
        this.voices = new Array(1024).fill(null);
        this.port.onmessage = (event) => {
          const m = event.data || {};
          if (m.type === "sample") {
            this.samples.set(m.id, { channels: m.channels || [], rate: Number(m.rate) || sampleRate });
            return;
          }
          if (m.type === "reset") {
            this.samples.clear();
            this.voices.fill(null);
            return;
          }
          if (m.type === "flush") {
            this.voices.fill(null);
            return;
          }
          if (m.type === "stop") {
            for (let i = 0; i < this.voices.length; i++)
              if (this.voices[i]?.voice === m.voice) this.voices[i] = null;
            return;
          }
          if (m.type !== "play") return;
          const sample = this.samples.get(m.id);
          if (!sample?.channels?.[0]?.length) return;
          let slot = -1;
          for (let i = 0; i < this.voices.length; i++) if (!this.voices[i]) { slot = i; break; }
          if (slot < 0) { this.port.postMessage({ type: "overflow", dropped: 1 }); return; }
          this.voices[slot] = {
            voice: m.voice,
            sample,
            start: Math.max(currentFrame, Math.round((Number(m.when) || 0) * sampleRate)),
            position: 0,
            gain: Number.isFinite(m.gain) ? m.gain : 1,
          };
        };
      }
      process(_inputs, outputs) {
        const output = outputs[0];
        if (!output?.length) return true;
        const frames = output[0].length, blockStart = currentFrame;
        for (let channel = 0; channel < output.length; channel++) output[channel].fill(0);
        for (let vi = 0; vi < this.voices.length; vi++) {
          const voice = this.voices[vi];
          if (!voice || blockStart + frames <= voice.start) continue;
          const channels = voice.sample.channels,
            sourceLength = channels[0].length,
            step = voice.sample.rate / sampleRate,
            first = Math.max(0, voice.start - blockStart);
          let position = voice.position;
          for (let i = first; i < frames; i++) {
            const sourceIndex = Math.floor(position), nextIndex = Math.min(sourceLength - 1, sourceIndex + 1), fraction = position - sourceIndex;
            if (sourceIndex >= sourceLength) break;
            for (let channel = 0; channel < output.length; channel++) {
              const source = channels[Math.min(channel, channels.length - 1)] || channels[0],
                a = source[sourceIndex] || 0, b = source[nextIndex] || 0;
              output[channel][i] += (a + (b - a) * fraction) * voice.gain;
            }
            position += step;
          }
          voice.position = position;
          if (position >= sourceLength) this.voices[vi] = null;
        }
        return true;
      }
    }
    registerProcessor("phi-hit-mixer-44", PhiHitMixerProcessor);
    class NativeNoiseFilter extends AudioWorkletProcessor {
      static get parameterDescriptors(){return [{name:'cutoff',defaultValue:0,minValue:0,maxValue:22000,automationRate:'k-rate'}];}
      constructor(){super();this.cutoff=-1;this.z=[[0,0],[0,0]];this.b=[1,0,0];this.a=[0,0];}
      process(inputs,outputs,params){
        const cutoff=params.cutoff[0],input=inputs[0],output=outputs[0];
        if(cutoff!==this.cutoff){
          if(cutoff<=0||this.cutoff<=0)this.z=[[0,0],[0,0]];
          this.cutoff=cutoff;
          if(cutoff>0){const w=2*Math.PI*Math.min(cutoff,sampleRate*.49)/sampleRate,c=Math.cos(w),alpha=Math.sin(w)/(2*Math.SQRT1_2),a0=1+alpha;this.b=[(1-c)/2/a0,(1-c)/a0,(1-c)/2/a0];this.a=[-2*c/a0,(1-alpha)/a0];}
        }
        for(let ch=0;ch<output.length;ch++){
          const src=input[ch]||input[0],dst=output[ch],z=this.z[Math.min(ch,1)];
          if(!src){dst.fill(0);continue;}
          if(cutoff<=0){dst.set(src);continue;}
          for(let i=0;i<dst.length;i++){const x=src[i],y=this.b[0]*x+z[0];z[0]=this.b[1]*x-this.a[0]*y+z[1];z[1]=this.b[2]*x-this.a[1]*y;dst[i]=y;}
        }
        return true;
      }
    }
    registerProcessor('phi-native-noise-filter-61',NativeNoiseFilter);
  }

  class PhiHitAudioMixer {
    constructor(context, node) {
      this.context = context;
      this.node = node;
      this.sampleIds = new WeakMap();
      this.nextSampleId = 1;
      this.nextVoiceId = 1;
      this.playMessage = { type: "play", id: 0, voice: 0, when: 0, gain: 1 };
      this.voiceHandle = Object.freeze({ __phiWorkletVoice: true, stop() {} });
    }
    static async create(context, output) {
      if (!context?.audioWorklet?.addModule || typeof AudioWorkletNode !== "function") return null;
      const source = `(${phiHitAudioWorkletModule.toString()})()`,
        url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      try {
        await withTimeout(context.audioWorklet.addModule(url), 5000, "AudioWorklet 初始化超时");
        const node = new AudioWorkletNode(context, "phi-hit-mixer-44", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: "explicit",
        });
        node.connect(output);
        return new PhiHitAudioMixer(context, node);
      } finally { URL.revokeObjectURL(url); }
    }
    reset() {
      this.node.port.postMessage({ type: "reset" });
      this.sampleIds = new WeakMap();
      this.nextSampleId = 1;
    }
    register(buffer) {
      if (!buffer) return 0;
      const known = this.sampleIds.get(buffer);
      if (known) return known;
      const id = this.nextSampleId++, count = Math.min(2, Math.max(1, buffer.numberOfChannels || 1)),
        channels = [], transfers = [];
      for (let channel = 0; channel < count; channel++) {
        const data = new Float32Array(buffer.length);
        buffer.copyFromChannel(data, channel);
        channels.push(data);
        transfers.push(data.buffer);
      }
      this.sampleIds.set(buffer, id);
      this.node.port.postMessage({ type: "sample", id, channels, rate: buffer.sampleRate }, transfers);
      return id;
    }
    play(buffer, when = null) {
      const id = this.register(buffer);
      if (!id) return null;
      const now = this.context.currentTime,
        start = Number.isFinite(when) ? Math.max(now, Number(when)) : now;
      const voice = this.nextVoiceId++;
      // postMessage clones synchronously, so one mutable envelope can be reused
      // for every judgement without allocating a fresh JS object on the input
      // event stack. Autoplay cancellation flushes the mixer as one operation.
      const message = this.playMessage;
      message.id = id;
      message.voice = voice;
      message.when = start;
      this.node.port.postMessage(message);
      return this.voiceHandle;
    }
    flush() {
      this.node.port.postMessage({ type: "flush" });
    }
    destroy() {
      try { this.flush(); this.node.disconnect(); } catch {}
    }
  }

  class Engine {
    static _ac = null;
    static _hitOut = null;
    static _hitMixer = null;
    static _hitMixerPromise = null;
    static _hitMixerSamples = [];
    static sharedAudioContext() {
      if (this._ac && this._ac.state !== "closed") return this._ac;
      this._hitOut = null;
      return (this._ac = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "interactive",
      }));
    }
    static resetSharedAudioContext(reason = "reset") {
      const old = this._ac;
      try { this._hitMixer?.destroy?.(); } catch {}
      this._ac = null;
      this._hitOut = null;
      this._hitMixer = null;
      this._hitMixerPromise = null;
      this._hitMixerSamples = [];
      this._hitVolume = -1;
      if (old && old.state !== "closed") {
        try { old.close?.().catch?.(() => {}); } catch {}
      }
      Diagnostics.info("AudioEngine.context", "已重建 Web Audio 会话", { reason });
    }
    static primeAudioFromGesture(primeMedia = true) {
      // This is called synchronously by the existing song click, before loading.
      const tasks=[];
      try{
        if(this._ac?.state==='interrupted')this.resetSharedAudioContext('gesture-interrupted');
        const ac=this.sharedAudioContext();
        tasks.push(this.ensureAudioContextRunning(1600,false));
        const silent=ac.createBufferSource();silent.buffer=ac.createBuffer(1,128,ac.sampleRate);
        silent.connect(ac.destination);silent.onended=()=>silent.disconnect();silent.start(0);
      }catch(error){tasks.push(Promise.reject(error));}
      if(primeMedia){
        try{
          this._primedMusicElement?.pause();
          if(!this._silenceURL){
            const bytes=new Uint8Array(44+2048),view=new DataView(bytes.buffer),put=(at,text)=>{for(let i=0;i<text.length;i++)bytes[at+i]=text.charCodeAt(i);};
            put(0,'RIFF');view.setUint32(4,bytes.length-8,true);put(8,'WAVE');put(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,22050,true);view.setUint32(28,44100,true);view.setUint16(32,2,true);view.setUint16(34,16,true);put(36,'data');view.setUint32(40,2048,true);
            this._silenceURL=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
          }
          const audio=new Audio(this._silenceURL);audio.preload='auto';audio.loop=true;audio.muted=false;audio.setAttribute('playsinline','');
          this._primedMusicElement=audio;tasks.push(Promise.resolve(audio.play()));
        }catch(error){tasks.push(Promise.reject(error));}
      }
      return Promise.allSettled(tasks);
    }
    static async ensureAudioContextRunning(timeoutMs = 1600, allowRebuild = true) {
      const ac=this.sharedAudioContext();
      if(ac.state!=='running')await withTimeout(Promise.resolve(ac.resume()),timeoutMs,'Safari 音频会话恢复超时');
      if(ac.state!=='running')throw new Error(`音频会话尚未运行（${ac.state}）`);
      return ac;
    }
    static async ensureHitMixer(pack = null, customHitSounds = null) {
      const ac = this.sharedAudioContext();
      if (!ac?.audioWorklet?.addModule || typeof AudioWorkletNode !== "function") return null;
      if (!this._hitMixer || this._hitMixer.context !== ac) {
        if (!this._hitMixerPromise) {
          this._hitMixerPromise = PhiHitAudioMixer.create(ac, this.hitSoundOutput())
            .then((mixer) => (this._hitMixer = mixer))
            .catch((error) => {
              Diagnostics.warn("AudioEngine.worklet", error?.message || String(error), { fallback: "AudioBufferSourceNode" });
              return null;
            })
            .finally(() => { this._hitMixerPromise = null; });
        }
        await this._hitMixerPromise;
      }
      const mixer = this._hitMixer;
      if (!mixer) return null;
      const unique = new Set();
      for (const buffer of Object.values(pack?.sounds || {})) if (buffer) unique.add(buffer);
      if (customHitSounds?.values)
        for (const buffer of customHitSounds.values()) if (buffer) unique.add(buffer);
      const samples = [...unique],
        cached = this._hitMixerSamples,
        unchanged = cached.length === samples.length && samples.every((buffer, index) => buffer === cached[index]);
      if (unchanged) {
        mixer.flush();
        return mixer;
      }
      mixer.reset();
      for (const buffer of samples) mixer.register(buffer);
      this._hitMixerSamples = samples;
      Diagnostics.info("AudioEngine.worklet", "判定音已切换到独立 AudioWorklet 混音线程", { samples: samples.length, voices: HIT_AUDIO_VOICE_LIMIT });
      return mixer;
    }
    static hitSoundOutput() {
      if (this._hitOut) return this._hitOut;
      const ac = this.sharedAudioContext(), input = ac.createGain();
      input.gain.value = clamp(Number(hitSoundVolume) || 0, 0, HIT_SOUND_MAX) * HIT_SOUND_OUTPUT_TRIM;
      this._hitVolume = input.gain.value;
      input.connect(ac.destination);
      return (this._hitOut = input);
    }
    constructor(record, chart, pack) {
      this.record = record;
      this.chart = chart;
      this.pack = pack;
      this.packageNoteScale = clamp(Number(record?.meta?.noteScale ?? 1) || 1, 0.05, 8);
      this.customHitSounds = new Map();
      this.canvas = $("#gameCanvas");
      // Present a complete frame through the compositor. Front-buffer rendering
      // can expose clearRect() before the notes are drawn and visibly flash.
      this.canvas.style.opacity = "";
      this.canvas.style.display = "block";
      this.canvas.style.background = "transparent";
      for (const orphan of gameplayDocument().querySelectorAll(".phiPostCanvas")) orphan.remove();
      this.ctx =
        this.canvas.getContext("2d", {
          alpha: true,
          desynchronized: false,
          willReadFrequently: false,
          colorSpace: "srgb",
        }) || this.canvas.getContext("2d", { alpha: true, desynchronized: false, colorSpace: "srgb" })
          || this.canvas.getContext("2d", { alpha: true });
      this.canvasHasAlpha = this.ctx?.getContextAttributes?.().alpha !== false;
      this.isAppleTouch = isAppleTouchDevice();
      const pjskCores = Math.max(1, Number(navigator.hardwareConcurrency) || 8),
        pjskMemory = Math.max(1, Number(navigator.deviceMemory) || 8),
        pjskVeryLow = chart.kind === "pjsk" && (pjskCores <= 2 || pjskMemory <= 2),
        pjskLow = chart.kind === "pjsk" && !pjskVeryLow && (pjskCores <= 4 || pjskMemory <= 4);
      // PJSK has a perspective stage that Phigros mode does not need to fill.
      // On low-end lab/integrated-GPU devices, reduce only the Canvas backing
      // density and static stage raster; DOM HUD/input/audio/judgement stay native.
      this.pjskLiteMode = chart.kind === "pjsk" ? {
        renderScale: pjskVeryLow ? 0.72 : pjskLow ? 0.84 : 1,
        stageScale: pjskVeryLow ? 0.68 : pjskLow ? 0.82 : 1,
        cores: pjskCores, memory: pjskMemory,
      } : null;
      this.pjskStageCache = null;
      this.pjskStageCacheKey = "";
      // Pointer Events + pointer capture can become unstable with several simultaneous
      // fingers on some mobile browsers. Use the native multi-touch contact model
      // whenever this is a touch-capable device: changedTouches delivers every
      // changed finger in one event and Touch.identifier remains independent.
      // Mouse/pen keep the PointerEvent path. This does not alter the rAF/render cap.
      this.useNativeTouchInput =
        typeof TouchEvent !== "undefined" &&
        "ontouchstart" in window &&
        (Number(navigator.maxTouchPoints) || 0) > 0;
      const preparedStream=record._preparedStream&&!record._preparedStream.controller.signal.aborted?record._preparedStream:null;
      this.audio = preparedStream?.audio || Engine._primedMusicElement || new Audio();
      Engine._primedMusicElement=null;
      this.audio.preload = "auto";
      this.audioURL = "";
      this.musicBuffer = null;
      this.streamSession = preparedStream;
      this.streamBuffering=false;this.streamRecoveryPending=false;this.streamRecoveryAbort=null;
      this.inputClockPauses=[];
      this.musicSource = null;
      this.musicGain = null;
      this.musicUsingWebAudio = false;
      this.musicPlaying = false;
      this.musicStartCtx = 0;
      this.musicOffset = 0;
      this.musicRate = 1;
      this.musicToken = 0;
      this.pendingAutoSounds = new Set();
      this.audioPumpTimer = 0;
      this.bgURL = record.bgBlob ? URL.createObjectURL(record.bgBlob) : "";
      this.renderBgURL = "";
      this.bgImage = null;
      this.renderBgImage = null;
      this.backgroundShadeAlpha = 0.24;
      this.backgroundDrawWarned = false;
      this.backgroundRenderState = "idle";
      this.backgroundDatasetRenderer = "";
      this.backgroundDatasetState = "";
      this.pointer = new Map();
      this.pointerPool = [];
      // Native TouchEvent bookkeeping is deliberately separate from PointerEvent.
      // blocked ids began on gameplay UI controls; live ids are reused as a scratch
      // set when reconciling event.touches so no per-frame arrays are allocated.
      this.nativeTouchBlocked = new Set();
      this.nativeTouchLiveIds = new Set();
      this.nativeTouchChangedIds = new Set();
      this.nativePointerLinks = new Map();
      this.inputDownReceipts = [];
      this.nativeTouchEndedAt = new Map();
      this.inputStats = { pointerDown:0, touchStart:0, edges:0, accepted:0, noCandidate:0, blocked:0, earlyGuard:0, bridges:0, recovered:0, buffered:0, maxDispatchMs:0 };
      // On iPadOS/Safari the surface already owns gestures through touch-action:none.
      // Let high-frequency touchmove stay passive so WebKit never waits for JS before
      // compositor progress; touchstart/gesturestart remain cancelable arbitration gates.
      this.nativeTouchMovePassive =
        (!globalThis.CSS || typeof CSS.supports !== "function" || CSS.supports("touch-action", "none"));
      this.running = false;
      this.paused = false;
      this.starting = false;
      this.resumePending = false;
      this.transitionToken = 0;
      this.pauseReason = "";
      this.backgroundPaused = false;
      this.backgroundPauseOffset = 0;
      this.backgroundGeneration = 0;
      this.audioWakePromise = null;
      this.restartPending = false;
      this.raf = 0;
      this.loopTimer = 0;
      this.counts = [0, 0, 0, 0];
      this.actualCounts = [0, 0, 0, 0];
      this.actualCombo = 0;
      this.actualMaxCombo = 0;
      this.earlyLate = [0, 0];
      this.combo = 0;
      this.maxCombo = 0;
      this.usedModeSwitch = false;
      this.total = 0;
      this.effects = [];
      this.badGhosts = [];
      this.hitParticlePool = [];
      this.hitParticlePoolPerfect = [];
      this.hitParticlePoolGood = [];
      this.hitParticleCountPerfect = 0;
      this.hitParticleCountGood = 0;
      this.hitFxDurationCached = 0.5;
      this.hitFxAtlasPerfect = null;
      this.hitFxAtlasGood = null;
      this.hitEffectPool = [];
      // Judgement/audio are synchronous; only visual burst materialization is queued
      // to rAF. This keeps dense multi-finger input handlers allocation/geometry-light.
      this.hitRequestQueue = [];
      this.hitRequestPool = [];
      this.assetImages = new Map();
      this.shaderSources = new Map();
      this.renderLines = [...chart.lines].sort(
        (a, b) => ((a.z || 0) - (b.z || 0)) || ((a.id || 0) - (b.id || 0)),
      );
      // Bounded RPE texture raster/tint cache. Large transparent PNGs and
      // animated colorEvents are rasterized once per quantized state instead of
      // being rescaled and recomposited on every 120 Hz frame.
      this.rpeTextureRasterCache = new Map();
      this.rpeTextureRasterBytes = 0;
      this.rpeTextureRasterLimit = this.isAppleTouch ? 72 * 1024 * 1024 : 144 * 1024 * 1024;
      this.rpeTextureRasterEntries = this.isAppleTouch ? 72 : 128;
      this.rpeTextureCacheHits = 0;
      this.rpeTextureCacheMisses = 0;
      this.rpeTexturePrewarmCount = 0;
      this.rpeTexturePrewarmBytes = 0;
      this.frameTime = NaN;
      this.frameStamp = 0;
      this.inputFrameTime=NaN;this.inputFrameStamp=0;this.inputFrameLines=[];
      this.frameLines = chart.lines.map(() => ({
        stamp: 0,
        busy: 0,
        x: 0,
        y: 0,
        rot: 0,
        alpha: 1,
        cx: 0,
        cy: 0,
        ux: 1,
        uy: 0,
        vx: 0,
        vy: 1,
        cur: 0,
        screenRot: 0,
        color: [255, 255, 255],
        colorCss: "#ffffff",
        colorWhite: true,
      }));
      this.noteBase = 0;
      this.noteWidth = 0;
      this.pointScratchA = { x: 0, y: 0, line: null, dist: 0, along: 0, rawBase: 0 };
      this.pointScratchB = { x: 0, y: 0, line: null, dist: 0, along: 0, rawBase: 0 };
      this.candidateScratch = { L: null, n: null, dt: 0, d: 0, t: 0, target: 0, signed: 0, visualT: 0, visualSigned: 0 };
      this.keyboardCandidateScratch = { L: null, n: null, dt: 0, t: 0, target: 0, signed: 0, visualT: 0, visualSigned: 0 };
      this.keyboardPointer = { id: "keyboard", x: 0, y: 0, active: true, keyboard: true };
      this.layoutLocked = false;
      this.inputRect = { left: 0, top: 0, width: 1, height: 1 };
      this.isTouchMac =
        navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1;
      this.surfaceW = 0;
      this.surfaceH = 0;
      this.layoutSurfaceW = 0;
      this.layoutSurfaceH = 0;
      this.viewScale = 1;
      this.viewX = 0;
      this.viewY = 0;
      this.visibleLogicalBounds = { left: 0, top: 0, right: 0, bottom: 0 };
      this.fullscreenState = fullscreenActive();
      this.reflowTimer = 0;
      this.clockReady = false;
      this.clockValue = 0;
      this.clockLastPerf = 0;
      this.clockLastActual = -1;
      this.clockLastMediaPerf = 0;
      this.clockDrift = 0;
      this.autoplay = autoplayEnabled;
      this.usedAutoplay = false;
      this.usedReveal = !!chartRevealEnabled;
      this.usedKeyboard = false;
      this.invincibleMode = invincibleEnabled;
      this.usedInvincible = this.invincibleMode;
      this.invincibleFeedbackKind = 0; // 0=AP gold, 1=temporary FC blue, 2=temporary white break
      this.invincibleFeedbackUntil = 0;
      this.holdSkinCache = new Map();
      this.noteSkinCache = new Map();
      this.nextHudPerf = 0;
      this.nextProgressPerf = 0;
      this.frameNow = 0;
      this.perfSampleCounter = 0;
      this.missedVblankRecent = 0;
      this.lastHitPerf = -Infinity;
      this.qualityChangeRequestedAt = 0;
      this.jankFrames = 0;
      this.hitJankFrames = 0;
      this.extraEffects = rpeParseExtra(record.extraText || "");
      this.extraStartIndex = 0;
      this.extraLastTime = -Infinity;
      this.activeExtraEffects = [];
      this.visibleExtraEffects = [];
      this.postProcessor = null;
      this.rpeTextureId = 0;
      this.uiAttached = new Set();
      this.uiAttachMap = null;
      this.vignetteCache = new Map();
      this.effectVectorScratch = new Float32Array(2);
      this.effectScissorScratch = { x: 0, y: 0, w: 0, h: 0 };
      this.singlePointerEvent = [null];
      this.extraEffectsDirty = true;
      this.effectCanvas = null;
      this.effectCtx = null;
      this.foregroundFxCanvas = null;
      this.foregroundFxCtx = null;
      this.foregroundFxVisible = false;
      this.baseDpr = 1;
      const texturedLineCount = (chart.lines || []).reduce(
        (count, line) => count + (line?.texture || line?.textureName ? 1 : 0), 0,
      );
      this.isHeavyVisualChart =
        (chart.lines?.length || 0) >= 120 ||
        (chart.noteCount || 0) >= 2200 ||
        texturedLineCount >= 10 ||
        this.extraEffects.length >= 5;
      this.appleQualityCeiling = this.isHeavyVisualChart
        ? APPLE_HEAVY_CHART_START_QUALITY
        : APPLE_120_START_QUALITY;
      this.renderQuality = this.isAppleTouch ? this.appleQualityCeiling : 1;
      this.pendingResolution = false;
      this.drawCostAvg = 0;
      this.frameWorkAvg = 0;
      this.frameWorkPeak = 0;
      this.frameIntervalAvg = 0;
      this.refreshInterval = 0;
      this.systemFrameTargetMs = FRAME_TARGET_MS;
      this.highRefreshProbeUntil = performance.now() + HIGH_REFRESH_PROBE_MS;
      this.lastFramePerf = 0;
      this.nextFramePerf = 0;
      this.visualTime = NaN;
      this.currentVisualTime = NaN;
      this.lastQualityAdjust = 0;
      this.lastQualityRaise = 0;
      this.lastResolutionChange = -Infinity;
      this.qualityOverloadStreak = 0;
      this.qualitySevereStreak = 0;
      this.qualityHeadroomStreak = 0;
      this.metricsCandidates = 0;
      this.metricsDrawnNotes = 0;
      this.frameLineNoteVisible = new Uint8Array(chart.lines.length);
      this.frameLineCoverEnabled = new Uint8Array(chart.lines.length);
      this.frameLineAppearBefore = new Float64Array(chart.lines.length);
      this.frameCanvasScale = 1;
      this.frameCanvasOffsetX = 0;
      this.frameCanvasOffsetY = 0;
      this.hudScoreEls = [$("#scoreText"), $("#innerScoreText")].filter(Boolean);
      this.hudComboEls = [$("#comboText"), $("#innerComboText")].filter(Boolean);
      this.hudComboBoxes = [$("#comboHud"), $("#innerComboHud")].filter(Boolean);
      this.hudProgressEls = [$("#progressBar"), $("#innerProgressBar")].filter(Boolean);
      this.lastHudScore = "";
      this.lastHudCombo = "";
      this.lastHudVisible = null;
      this.lastHudAutoplay = null;
      this.lastProgressPct = -1;
      this.officialLineSpan = { from: 0, to: 0 };
      this.renderBucketStep = RENDER_BUCKET_STEP;
      this.renderBucketOrigin = -3;
      this.renderBuckets = [];
      this.completeRenderLayers = null;
      this.completeRenderBucket = null;
      this.spatialRenderIndex = [];
      this.frameRenderLayers = [null, [], [], [], []];
      this.frameRenderBucket = { layers: this.frameRenderLayers };
      this.renderIndexPersistent = 0;
      this.metricsIndexedCandidates = 0;
      this.renderIndexTimer = 0;
      this.noteItems = [];
      for (const L of chart.lines) {
        for (const n of L.notes) {
          const item = { L, n };
          n._item = item;
          this.noteItems.push(item);
          if (!n.fake) this.total += chart.kind === "pjsk" && n.type === 3 ? (n._pjskHeadHidden?0:1)+(n._pjskTicks?.length||0)+(n._pjskTailHidden?0:1) : 1;
        }
      }
      this.noteItems.sort((a, b) => a.n.time - b.n.time);
      this.noteTimes = Float64Array.from(this.noteItems, (x) => x.n.time);
      this.autoSoundNotes = this.noteItems.filter((x) => !x.n.fake);
      this.autoSoundTimes = Float64Array.from(
        this.autoSoundNotes,
        (x) => x.n.time,
      );
      this.autoSoundIndex = 0;
      this.autoJudgeIndex = 0;
      this.judgeFeedIndex = 0;
      this.pendingJudge = new Set();
      this.activeHolds = new Set();
      // Modern Android pointermove already exposes coalesced samples. On Apple touch,
      // pointerrawupdate can arrive earlier under dense multi-touch; listen to both
      // there and deduplicate identical samples in pointerMove().
      this.pointerMoveEvents =
        this.isAppleTouch && "onpointerrawupdate" in window
          ? ["pointerrawupdate", "pointermove"]
          : ["pointermove"];
      this.bound = {
        down: (e) => this.pointerDown(e),
        move: (e) => this.pointerMove(e),
        up: (e) => this.pointerUp(e),
        cancel: (e) => this.pointerCancel(e),
        lost: (e) => this.pointerCancel(e),
        touchstart: (e) => this.touchStart(e),
        touchmove: (e) => this.touchMove(e),
        touchend: (e) => this.touchEnd(e),
        touchcancel: (e) => this.touchCancel(e),
        gesture: (e) => this.nativeGestureGuard(e),
        resize: () => {
          if(this._offlineExport)return;
          syncGameViewportCSS();
          this.resize();
          this.scheduleViewportReflow(false);
          this.handleOrientation();
        },
        fullscreen: () => {
          if(this._offlineExport)return;
          syncGameViewportCSS();
          this.scheduleViewportReflow(true);
        },
        orientation: () => {
          if(this._offlineExport)return;
          syncGameViewportCSS();
          this.resize();
          this.scheduleViewportReflow(true);
          this.handleOrientation();
        },
        visibility: () => {
          if (document.hidden) this.handlePageSuspended("visibility");
          else this.handlePageRestored("visibility");
        },
        pagehide: () => this.handlePageSuspended("pagehide"),
        pageshow: () => this.handlePageRestored("pageshow"),
        freeze: () => this.handlePageSuspended("freeze"),
        resumePage: () => this.handlePageRestored("resume"),
        mediaSync: () => this.syncClock(true),
        loop: (t) => this.loop(t),
      };
    }
    setAutoplay(value) {
      this.autoplay = !!value;
      if (this.autoplay) {
        this.usedAutoplay = true;
        this.clearPointerStates();
        this.prepareAutoplayScheduler();
        this.prepareAutoJudge(this.time);
        if (this.musicPlaying) this.startAudioPump();
      } else {
        this.stopAudioPump();
        this.cancelAutoplayAudio();
        for(const item of this.activeHolds){if(item.n.autoStarted){item.n.autoStarted=false;item.n.holdPointer=null;item.n.releaseAt=Infinity;}}
        this.seekJudgeFeed(this.time);
      }
      refreshAutoplayUI();
    }
    setPlaybackRate(value) {
      const canonical = canonicalDecimalInput(value), rate = Number(canonical);
      if (!(rate > 0) || !Number.isFinite(rate)) throw new Error("游玩速度必须是大于 0 的有效数字");
      const offset = this.musicCurrentTime();
      this.musicRate = rate;
      this.audio.playbackRate = rate;
      this.musicOffset = offset;
      this.clockValue = offset;
      this.clockReady = false;
      syncPauseTransportUI(this);
      return canonical;
    }
    seekPausedMusic(musicTime) {
      if (!this.paused) return false;
      const target = clamp(Number(musicTime) || 0, 0, this.musicDuration());
      this.stopMusic(false);
      this.musicOffset = target;
      if (this.backgroundPaused) this.backgroundPauseOffset = target;
      try { this.audio.currentTime = target; } catch {}
      this.clockValue = target;
      this.clockLastActual = target;
      this.clockReady = true;
      this.clearPointerStates();
      this.pendingJudge.clear();
      this.activeHolds.clear();
      this.counts = [0, 0, 0, 0];
      this.actualCounts = [0, 0, 0, 0];
      this.combo = this.maxCombo = this.actualCombo = this.actualMaxCombo = 0;
      this.earlyLate = [0, 0];
      const chartTime = target - Number(this.chart.offset || 0),
        syntheticJudge = skippedNoteJudgement(this.autoplay, this.invincibleMode),
        syntheticName = JUDGE_NAMES[syntheticJudge];
      for (const item of this.noteItems) {
        const n = item.n;
        n.state = 0;
        n.inputMissDeadline = 0;
        n.judge = null;
        n.holdPointer = null;
        n.holdHeadDiff = 0;
        n.releaseAt = Infinity;
        n.autoStarted = false;
        n.flickArmed = false;
        n.flickPointer = null;
        n.dragArmed = false;
        n.dragPointer = null;
        if (n.fake || n.time >= chartTime) continue;
        n.state = 1;
        n.judge = syntheticName;
        n.resultAt = chartTime;
        this.counts[syntheticJudge]++;
        this.actualCounts[syntheticJudge]++;
        if (syntheticJudge <= 1) {
          this.combo++;
          this.actualCombo++;
          this.maxCombo = Math.max(this.maxCombo, this.combo);
          this.actualMaxCombo = Math.max(this.actualMaxCombo, this.actualCombo);
        } else {
          this.combo = 0;
          this.actualCombo = 0;
        }
      }
      if (this.autoplay) this.usedAutoplay = true;
      if (this.invincibleMode) this.usedInvincible = true;
      this.prepareAutoplayScheduler(chartTime);
      this.prepareAutoJudge(chartTime);
      this.seekJudgeFeed(chartTime);
      this.visualTime = NaN;
      this.lastHudScore = this.lastHudCombo = "";
      this.lastProgressPct = -1;
      resetPjskState(this,chartTime);
      resetPjskState(this);
      this.updateHUD();
      this.draw(chartTime);
      syncPauseTransportUI(this);
      return true;
    }
    setInvincible(value) {
      this.invincibleMode = !!value;
      if (this.invincibleMode) {
        this.usedInvincible = true;
        const judged = this.counts[0] + this.counts[1] + this.counts[2] + this.counts[3];
        this.counts[0] = judged;
        this.counts[1] = this.counts[2] = this.counts[3] = 0;
        this.combo = judged;
        this.maxCombo = Math.max(this.maxCombo, judged);
      }
      this.invincibleFeedbackKind = 0;
      this.invincibleFeedbackUntil = 0;
      this.lastHudScore = "";
      this.lastHudCombo = "";
      this.lastHudVisible = null;
      refreshInvincibleUI();
    }
    triggerInvincibleFeedback(judgement, frameNow = performance.now()) {
      if (!this.invincibleMode || judgement <= 0) return;
      this.usedInvincible = true;
      const nextKind = judgement === 1 ? 1 : 2;
      // A real combo break must not be downgraded to a blue Good flash by a
      // simultaneous or immediately-following Note. White remains dominant.
      if (!(this.invincibleFeedbackKind === 2 && frameNow < this.invincibleFeedbackUntil))
        this.invincibleFeedbackKind = nextKind;
      this.invincibleFeedbackUntil = frameNow + 1000;
      if (this.invincibleFeedbackKind === 2) this.lastHudVisible = null;
    }
    invincibleFeedbackActive(frameNow = performance.now()) {
      if (!this.invincibleMode || frameNow >= this.invincibleFeedbackUntil) {
        if (this.invincibleFeedbackKind) this.invincibleFeedbackKind = 0;
        return 0;
      }
      return this.invincibleFeedbackKind;
    }
    invincibleLineColor(frameNow = performance.now()) {
      const feedback = this.invincibleFeedbackActive(frameNow);
      return feedback === 2 ? "#ffffff" : feedback === 1 ? PHI_COLORS.fc : PHI_COLORS.ap;
    }
    invincibleComboSuppressed(frameNow = performance.now()) {
      return this.invincibleFeedbackActive(frameNow) === 2;
    }
    ensureMediaAudioSource() {
      if (!this.audioURL) {
        this.audioURL = this.record.streamAudioURL ? PhiHostedMedia.url(this.record.streamAudioURL) : URL.createObjectURL(this.record.audioBlob);
        this.audio.loop=false;this.audio.muted=false;
        if(this.audio.src!==this.audioURL){this.audio.src=this.audioURL;this.audio.load();}
      }
      return this.audio;
    }
    async recoverStreamBuffer(){
      if(!this.streamSession||!this.running||this.paused||this.starting||this.resumePending||this.streamRecoveryPending||this.musicDuration()-this.musicCurrentTime()<.3)return;
      if(this.audio.readyState>=3||PhiHostedMedia.bufferedAhead(this.audio)>.25)return;
      const session=this.streamSession,token=this.transitionToken,status=$('#streamBufferStatus'),cancellation=new AbortController();
      const active=()=>this.running&&!this.paused&&!this.starting&&!this.resumePending&&this.transitionToken===token;
      this.streamRecoveryPending=true;this.streamRecoveryAbort=cancellation;
      let began=performance.now(),recovered=false;
      const pauses=this.inputClockPauses||=[],pauseInterval={start:began,end:Infinity};
      pauses.push(pauseInterval);if(pauses.length>64)pauses.shift();
      this.streamBuffering=true;this.cancelLoop();this.syncClock(true);
      if(status){status.textContent='音乐缓冲中（谱面同步暂停）';status.classList.remove('hidden');}
      try{
        // A seek or decoder hiccup can emit waiting with playable audio still in
        // the buffer. Do not interrupt a chord for a transient notification.
        await sleep(180);
        if(!active()||document.hidden||this.audio.readyState>=3||PhiHostedMedia.bufferedAhead(this.audio)>.25)return;
        this.pauseMusic();this.syncClock(true);this.draw(this.time);
        if(status){status.textContent='正在缓冲音乐…';status.classList.remove('hidden');}
        session.onProgress=state=>{if(active()&&status)status.textContent=`正在缓冲音乐… ${state.ahead.toFixed(1)} 秒`;};
        this.streamStalls=(this.streamStalls||0)+1;
        await session.wait(Math.min(12,4+this.streamStalls*2),{signal:cancellation.signal});
        if(!active()||document.hidden)return;
        // Keep the same media position and all live contacts. In particular this
        // must not use manual pause/resume, which clears fingers and seeks again.
        await withTimeout(this.audio.play(),5000,'音乐恢复播放未响应');
        if(!active()||document.hidden){if(this.paused||!this.running)this.audio.pause();return;}
        this.rebaseBufferedInput(began,performance.now());recovered=true;
        this.syncClock(true);this.visualTime=NaN;this.lastFramePerf=0;
      }catch(error){
        if(error.name!=='AbortError'&&active()){
          this.pause('buffering-error');toast(error.message,true,6500);
        }
      }finally{
        pauseInterval.end=performance.now();
        if(!recovered&&active()){
          this.rebaseBufferedInput(began,performance.now());this.syncClock(true);this.visualTime=NaN;this.lastFramePerf=0;
        }
        session.onProgress=null;this.streamRecoveryPending=false;this.streamBuffering=false;this.streamRecoveryAbort=null;
        if(engine===this&&status)status.classList.add('hidden');
        if(active()&&!document.hidden)this.scheduleLoop();
      }
    }
    rebaseBufferedInput(began,now){
      const from=began/1000,to=now/1000;
      for(const {n} of this.activeHolds)
        if(Number.isFinite(n.releaseAt))n.releaseAt+=to-Math.max(from,Math.min(to,n.releaseAt));
      for(const {n} of this.pendingJudge||[]){
        if(Number.isFinite(n.dragArmUntil)&&n.dragArmUntil>from)n.dragArmUntil+=to-from;
        if(n.inputMissDeadline>began)n.inputMissDeadline+=now-began;
      }
      for(const p of this.pointer.values()){
        if(p.ghostUntil>from)p.ghostUntil+=to-from;
        p.startX=p.lastX=p.x;p.startY=p.lastY=p.y;p.startT=p.lastT=now;p.speed=0;
      }
    }
    async prepareHostedArtwork(){
      if(!this.record.artworkAsset||this._offlineExport||!globalThis.PhiHostedMedia)return;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),350);
      const active=()=>engine===this&&!this.running&&!controller.signal.aborted;
      try{
        // The 640px stage is ample for a blurred backdrop. Freeze the selected
        // texture before init; no decode, blur worker or image swap during notes.
        await PhiHostedMedia.artwork(this.record.artworkAsset,{fromStage:1,maxStage:1,signal:controller.signal,active,onStage:(blob,stage)=>{
          if(!active())return;
          if(this.bgURL)URL.revokeObjectURL(this.bgURL);
          this.record.bgBlob=blob;this.bgURL=URL.createObjectURL(blob);
          $('#gameView').dataset.artworkStage=String(stage);setLoadingArtwork(blob);
        }});
      }finally{clearTimeout(timer);controller.abort();}
    }
    musicDuration() {
      return this.musicUsingWebAudio
        ? this.musicBuffer?.duration || this.record.duration || 1
        : (Number.isFinite(this.audio.duration)&&this.audio.duration>0?this.audio.duration:this.record.duration)||1;
    }
    musicCurrentTime() {
      if (!this.musicUsingWebAudio) return Number(this.audio.currentTime) || 0;
      const dur = this.musicDuration();
      if (!this.musicPlaying) return clamp(this.musicOffset, 0, dur);
      const ac = Engine.sharedAudioContext(),
        elapsed =
          Math.max(0, ac.currentTime - this.musicStartCtx) * this.musicRate;
      return clamp(this.musicOffset + elapsed, 0, dur);
    }
    ensureMusicGain() {
      if(this.musicGain&&this.musicGainContext===Engine.sharedAudioContext())return this.musicGain;
      try{this.musicGain?.disconnect();this.noiseAudioNode?.disconnect();}catch{}
      const ac = Engine.sharedAudioContext(),
        g = ac.createGain();
      g.gain.value = 1;
      this.musicGainContext=ac;
      if(this.chart.kind==='pgr'&&this.chart.blockAreas?.length){
        try{
          this.noiseAudioNode=new AudioWorkletNode(ac,'phi-native-noise-filter-61',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});
        }catch{
          this.noiseAudioNode=ac.createBiquadFilter();this.noiseAudioNode.type='lowpass';this.noiseAudioNode.Q.value=-3.01029995664;this.noiseAudioNode.frequency.value=Math.min(22000,ac.sampleRate*.49);
        }
        g.connect(this.noiseAudioNode);this.noiseAudioNode.connect(ac.destination);
      }else g.connect(ac.destination);
      this.musicGain = g;
      return g;
    }
    async startMusic(offset = 0) {
      if (!this.musicUsingWebAudio) {
        this.ensureMediaAudioSource();
        if(this.streamSession){
          try{
            await Engine.ensureAudioContextRunning(1600,false);
            if(!this.mediaMusicSource){this.mediaMusicSource=Engine.sharedAudioContext().createMediaElementSource(this.audio);this.mediaMusicSource.connect(this.ensureMusicGain());}
          }catch(error){Diagnostics.warn('AudioEngine.stream',error.message);}
        }
        try {
          const position=clamp(offset,0,this.musicDuration());
          if(Math.abs(this.audio.currentTime-position)>.025)this.audio.currentTime=position;
        } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
        if(this.streamSession)await this.streamSession.wait();
        await withTimeout(this.audio.play(),5000,'Safari 音乐播放未响应');
        return;
      }
      let ac;
      try{ac=await Engine.ensureAudioContextRunning(1600,false);}
      catch(error){this.musicUsingWebAudio=false;return this.startMusic(offset);}
      this.audio.pause();this.audio.loop=false;
      this.cancelAutoplayAudio();
      if (this.musicSource) {
        try {
          this.musicSource.stop();
        } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
        this.musicSource = null;
      }
      const dur = this.musicDuration();
      offset = clamp(Number(offset) || 0, 0, Math.max(0, dur - 0.001));
      const src = ac.createBufferSource(),
        token = ++this.musicToken;
      src.buffer = this.musicBuffer;
      src.playbackRate.value = this.musicRate;
      src.connect(this.ensureMusicGain());
      this.musicSource = src;
      this.musicOffset = offset;
      this.musicStartCtx = ac.currentTime + AUDIO_START_GUARD;
      this.musicPlaying = true;
      src.onended = () => {
        if (token !== this.musicToken || !this.musicPlaying) return;
        this.musicPlaying = false;
        this.musicOffset = dur;
        this.stopAudioPump();
        if (this.running && !this.paused) this.finish();
      };
      src.start(this.musicStartCtx, offset);
      clearTimeout(this.audioStartWatchdog);
      this.audioStartWatchdog=setTimeout(()=>{
        if(!this.running||this.paused||!this.musicUsingWebAudio||token!==this.musicToken)return;
        if(ac.currentTime>this.musicStartCtx+.01)return;
        // An actually stalled context after start gets an automatic media retry.
        // No pre-play clock gate and no extra user-facing activation control.
        const at=this.musicOffset;this.pauseMusic();this.musicUsingWebAudio=false;
        this.startMusic(at).then(()=>this.syncClock(true)).catch(error=>{this.pause('music-error');toast('音乐播放失败：'+error.message,true,7000);});
      },650);
      this.prepareAutoplayScheduler(offset - this.chart.offset);
      this.prepareAutoJudge(offset - this.chart.offset);
      if (this.autoplay) this.startAudioPump();
    }
    pauseMusic() {
      this.stopAudioPump();
      if (!this.musicUsingWebAudio) {
        this.audio.pause();
        return;
      }
      this.musicOffset = clamp(Math.max(this.musicCurrentTime(), Number(this.clockValue) || 0), 0, this.musicDuration());
      this.musicPlaying = false;
      this.musicToken++;
      const src = this.musicSource;
      this.musicSource = null;
      if (src)
        try {
          src.stop();
        } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      this.cancelAutoplayAudio();
    }
    stopMusic(reset = false) {
      clearTimeout(this.audioStartWatchdog);
      this.stopAudioPump();
      if (!this.musicUsingWebAudio) {
        this.audio.pause();
        if (reset)
          try {
            this.audio.currentTime = 0;
          } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
        return;
      }
      if (!reset) this.musicOffset = this.musicCurrentTime();
      this.musicPlaying = false;
      this.musicToken++;
      const src = this.musicSource;
      this.musicSource = null;
      if (src)
        try {
          src.stop();
        } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      this.cancelAutoplayAudio();
      if (reset) this.musicOffset = 0;
    }
    musicContextTimeForChart(chartTime) {
      if (!this.musicUsingWebAudio || !this.musicPlaying) return null;
      const musicTime = Number(chartTime) + Number(this.chart.offset || 0);
      return (
        this.musicStartCtx + (musicTime - this.musicOffset) / this.musicRate
      );
    }
    prepareAutoplayScheduler(
      at = this.musicCurrentTime() - Number(this.chart.offset || 0),
    ) {
      this.autoSoundIndex = lowerBoundNumeric(this.autoSoundTimes, at - 0.025);
    }
    prepareAutoJudge(at = this.time) {
      this.autoJudgeIndex = lowerBoundNumeric(this.noteTimes, at - 0.025);
    }
    startAudioPump() {
      this.stopAudioPump();
      if (!this.autoplay || !this.musicUsingWebAudio || !this.musicPlaying)
        return;
      const tick = () => {
        this.audioPumpTimer = 0;
        if (
          !this.autoplay ||
          !this.musicPlaying ||
          this.paused ||
          !this.running
        )
          return;
        this.scheduleAutoplayAudio();
        this.audioPumpTimer = setTimeout(tick, AUDIO_PUMP_MS);
      };
      tick();
    }
    stopAudioPump() {
      if (this.audioPumpTimer) {
        clearTimeout(this.audioPumpTimer);
        this.audioPumpTimer = 0;
      }
    }
    cancelAutoplayAudio() {
      const ac = Engine.sharedAudioContext();
      Engine._hitMixer?.flush?.();
      for (const item of this.pendingAutoSounds) {
        if (item.when > ac.currentTime - 0.01)
          item.n.autoSoundScheduled = false;
        try {
          item.source.stop();
        } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      }
      this.pendingAutoSounds.clear();
      // Worklet voices do not allocate main-thread onended callbacks. Reset only
      // the small scheduled look-ahead window when pausing/restarting.
      const chartNow = this.time,
        lo = lowerBoundNumeric(this.autoSoundTimes, chartNow - 0.05),
        hi = lowerBoundNumeric(this.autoSoundTimes, chartNow + AUTO_AUDIO_LOOKAHEAD + 0.08);
      for (let i = lo; i < hi; i++) this.autoSoundNotes[i].n.autoSoundScheduled = false;
      this.prepareAutoplayScheduler();
    }
    scheduleAutoplayAudio() {
      if (!this.autoplay || !this.musicUsingWebAudio || !this.musicPlaying)
        return;
      const chartNow = this.time,
        horizon = chartNow + AUTO_AUDIO_LOOKAHEAD,
        ac = Engine.sharedAudioContext();
      while (this.autoSoundIndex < this.autoSoundNotes.length) {
        const item = this.autoSoundNotes[this.autoSoundIndex],
          n = item.n;
        if (n.time > horizon) break;
        this.autoSoundIndex++;
        if (n.state !== 0 || n.autoSoundScheduled || n.time < chartNow - 0.04)
          continue;
        const when = this.musicContextTimeForChart(n.time);
        if (!Number.isFinite(when)) continue;
        const key = n.type === 4 ? "flick" : n.type === 2 ? "drag" : "click",
          source = this.playSound(key, Math.max(when, ac.currentTime + 0.002), n);
        if (!source) continue;
        n.autoSoundScheduled = true;
        if (source.__phiWorkletVoice) continue;
        const pending = { source, n, when };
        this.pendingAutoSounds.add(pending);
        source.onended = () => this.pendingAutoSounds.delete(pending);
      }
    }
    setBackgroundElementSource(url, fallback = true, state = "source", force = false) {
      const view = $("#gameView"), el = $("#gameBg"), imageEl = $("#gameBgImage");
      if (!view || !el || !imageEl) return;
      const safeUrl = String(url || "");
      el.dataset.backgroundState = state;
      el.dataset.backgroundRenderer = state === "baked" ? "single-static-frosted-raster" : "single-source-fallback";
      imageEl.classList.toggle("sourceFallback", !!fallback && state !== "baked");
      imageEl.classList.toggle("bakedFrosted", state === "baked");
      if (safeUrl) {
        imageEl.classList.remove("hiddenBackground");
        if (force || imageEl.getAttribute("src") !== safeUrl) {
          imageEl.setAttribute("src", safeUrl);
        }
      } else {
        imageEl.removeAttribute("src");
        imageEl.classList.add("hiddenBackground");
      }
      // Never duplicate the artwork on #gameView or #gameBg. A single image layer
      // avoids two full-screen blur surfaces and a third background texture.
      view.style.backgroundImage = "";
      el.style.backgroundImage = "";
    }
    mountGameplayBackground(force = true) {
      const baked = !!this.renderBgURL,
        url = baked ? this.renderBgURL : this.bgURL,
        state = url ? (baked ? "baked" : "source-visible") : "missing";
      this.backgroundRenderState = state;
      this.setBackgroundElementSource(url, !baked, state, force);
    }
    async buildStaticBackground() {
      this.renderBgImage = null;
      this.backgroundShadeAlpha = 0;
      if (this.renderBgURL) { URL.revokeObjectURL(this.renderBgURL); this.renderBgURL = ""; }
      if (!(this.record.bgBlob instanceof Blob) || this.record.bgBlob.size < 1) {
        this.bgImage = null;
        this.backgroundRenderState = "missing";
        Diagnostics.warn("Background.missing", "当前谱面记录没有有效曲绘 Blob", { name:this.record?.name || "", bgName:this.record?.bgName || "" });
        return;
      }
      if (!this.bgURL) {
        try { this.bgURL = URL.createObjectURL(this.record.bgBlob); } catch (_) { this.bgURL = ""; }
      }
      this.backgroundRenderState = this.bgURL ? "prepared" : "missing";
      try {
        this.bgImage = this.bgURL ? await imageFromPersistentURL(this.bgURL) : await imageFromBlob(this.record.bgBlob);
      } catch (error) {
        this.bgImage = null;
        Diagnostics.warn("Background.decode", error?.message || String(error), { name:this.record?.name || "", bgName:this.record?.bgName || "" });
      }
    }
    async preparePerformanceBackground() {
      if (!this.bgImage || this.renderBgURL) return !!this.renderBgURL;
      let candidateURL = "";
      try {
        const viewportW = this.surfaceW || innerWidth,
          viewportH = this.surfaceH || innerHeight,
          dim = this.record.meta?.backgroundDim ?? 0.6;
        let blob;
        try {
          blob = this.chart.kind === "pjsk" ? await createPjskBackgroundBlob(this.bgImage, viewportW, viewportH, dim) : await createStaticFrostedBlobThreaded(this.record.bgBlob, viewportW, viewportH, dim);
        } catch (workerError) {
          Diagnostics.warn("RenderWorker.background", workerError?.message || String(workerError), { fallback: "main-thread-loading-stage" });
          blob = this.chart.kind === "pjsk" ? await createPjskBackgroundBlob(this.bgImage, viewportW, viewportH, dim) : await createStaticFrostedBlob(this.bgImage, viewportW, viewportH, dim);
        }
        candidateURL = URL.createObjectURL(blob);
        const image = await imageFromPersistentURL(candidateURL);
        if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) throw new Error("磨砂背景解码失败");
        this.renderBgURL = candidateURL;
        candidateURL = "";
        this.renderBgImage = image;
        this.backgroundRenderState = "baked";
        this.mountGameplayBackground(true);
        return true;
      } catch (error) {
        if (candidateURL) URL.revokeObjectURL(candidateURL);
        Diagnostics.warn("Background.frosted", error?.message || String(error));
        this.renderBgImage = null;
        this.backgroundRenderState = this.bgURL ? "source-visible" : "missing";
        this.mountGameplayBackground(true);
        return false;
      }
    }
    drawGameplayBackground(c,t=this.time) {
      const canvas = this.canvas;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      try { c.filter = "none"; } catch {}
      if (this.canvasHasAlpha) c.clearRect(0, 0, canvas.width, canvas.height);
      else {
        // Extremely old WebKit builds may ignore alpha:true. Use transparent-style
        // clearing where supported; otherwise keep the fallback visible rather than
        // paying the permanent full-screen screen-blend cost used in 23.4.
        c.clearRect(0, 0, canvas.width, canvas.height);
      }
      // Disabled/ready noise is additive, not an opaque dark overlay. Its base
      // must include the DOM artwork before the additive pixels enter Canvas2D.
      this.nativeNoiseOpaqueBackground=false;
      if(this.chart.kind==='pgr')for(const zone of nativeBlockZones(this,t))if(!zone.active){this.nativeNoiseOpaqueBackground=true;break;}
      if(this.nativeNoiseOpaqueBackground){
        const image=this.renderBgImage||this.bgImage,w=canvas.width,h=canvas.height;
        c.fillStyle='#000';c.fillRect(0,0,w,h);
        if(image){
          const iw=image.naturalWidth||image.width,ih=image.naturalHeight||image.height,q=Math.max(w/iw,h/ih);
          c.drawImage(image,(w-iw*q)/2,(h-ih*q)/2,iw*q,ih*q);
          if(!this.renderBgImage){const dim=Math.max(0,Math.min(1,Number(this.record?.meta?.backgroundDim??.6)));c.fillStyle=`rgba(0,0,0,${dim})`;c.fillRect(0,0,w,h);}
        }
      }
      const renderer = this.nativeNoiseOpaqueBackground?"opaque-scene-for-native-additive-noise":"transparent-canvas-over-single-static-background",
        state = this.backgroundRenderState;
      if (this.backgroundDatasetRenderer !== renderer) {
        this.backgroundDatasetRenderer = renderer;
        canvas.dataset.backgroundRenderer = renderer;
      }
      if (this.backgroundDatasetState !== state) {
        this.backgroundDatasetState = state;
        canvas.dataset.backgroundState = state;
      }
    }
    async loadCustomHitSounds() {
      const names = [...new Set(this.noteItems.map((item) => String(item.n.hitsound || "").trim()).filter(Boolean))],
        standard = /^(?:tap|click|drag|flick)\.(?:mp3|ogg|wav)$/i,
        files = [...(this.record.supplementalFiles || []), ...(this.record.assets || [])];
      await mapLimit(names.filter((name) => !standard.test(basename(name))), this.isAppleTouch ? 1 : 2, async (name) => {
        const file = byNameFrom(files, name, this.record.assetBaseDir || archiveDirname(this.record.chartFileName || ""));
        if (!file) {
          Diagnostics.warn("ChartImporter.hitsound", `找不到自定义打击音：${name}`);
          return;
        }
        try {
          const buffer = await audioBufferFromBlob(file.blob), full = archivePathKey(name), leaf = basename(name).toLowerCase();
          this.customHitSounds.set(full, buffer);
          this.customHitSounds.set(leaf, buffer);
        } catch (error) {
          Diagnostics.warn("ChartImporter.hitsound", `${name}：${error.message || error}`);
        }
      });
    }
    async init() {
      // 先挂载原始 Blob 曲绘，再并行准备其余资源；即使图片解码较慢或失败，CSS 背景也会立即显示。
      await this.buildStaticBackground();
      const backgroundImage = this.bgImage || (this.record.bgBlob
        ? await imageFromBlob(this.record.bgBlob).catch(() => null)
        : null);
      this.bgImage = backgroundImage;
      const visualAssets = this.record.assets || [],
        // iPad/WebKit can spike memory badly when several multi-megapixel RPE
        // textures decode at once. Two workers keep the UI responsive and lower
        // the peak without changing any asset or chart semantics.
        assetLoad = mapLimit(visualAssets, this.isAppleTouch ? 2 : 4, async (a, assetIndex) => {
          const full = String(a.name || "").toLowerCase(),
            base = basename(full).toLowerCase();
          if (SHADER_EXT.test(full)) {
            try {
              const text = await withTimeout(
                blobText(a.blob),
                6000,
                `${base || "着色器"} 读取超时`,
              );
              this.shaderSources.set(full, text);
              this.shaderSources.set(base, text);
            } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
            return;
          }
          try {
            const sameBackground =
                backgroundImage &&
                (a.blob === this.record.bgBlob ||
                  basename(a.name).toLowerCase() ===
                    basename(this.record.bgName).toLowerCase()),
              image = sameBackground
                ? backgroundImage
                : await withTimeout(
                    imageFromBlob(a.blob),
                    this.isAppleTouch ? 18000 : 12000,
                    `${base || "图片资源"} 解码超时`,
                  );
            this.assetImages.set(full, image);
            this.assetImages.set(base, image);
            if (this.isAppleTouch && (assetIndex & 5) === 5)
              await new Promise((resolve) => setTimeout(resolve, 0));
          } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
        });
      await Promise.all([assetLoad, this.loadCustomHitSounds()]);
      for (const L of this.renderLines) {
        L._textureImage = L.texture
          ? this.assetImages.get(String(L.texture).toLowerCase()) ||
            this.assetImages.get(basename(String(L.texture)).toLowerCase()) ||
            null
          : null;
        if (L._textureImage && !L._textureImage._rpeTextureId)
          L._textureImage._rpeTextureId = ++this.rpeTextureId;
      }
      this.resize();
      await this.prewarmRPETextureRasters();
      if(this.chart.kind === "pgr" && this.chart.blockAreas?.length){
        this.nativeBlockRenderer=await createNativeBlockRenderer(this);
        this.nativeBlockRenderer.prepare(-Number(this.chart.offset||0));
      }
      this.initUIAttachMap();
      this.prepareNoteGeometry();
      this.prewarmHitFeedback();
      if (this.chart.kind === "pjsk" && this.w > 0 && this.h > 0) {
        // Build all Canvas sprites and the static lane stage while still loading.
        ensurePjskSkin(this);
        const stage = pjskStageGeometry(this), scale = this.pjskLiteMode?.stageScale || 1;
        this.pjskStageCache = buildPjskStageCache(this, stage);
        this.pjskStageCacheKey = `${Math.round(this.w)}x${Math.round(this.h)}:${stage.lanes}:${scale}`;
      }
      // Capture at document scope: on iPad a second finger can be retargeted to
      // a transparent HUD descendant instead of the canvas while the first
      // finger owns capture. Each contact still gets one pointerId/state object.
      document.addEventListener("pointerdown", this.bound.down, {
        passive: false,
        capture: true,
      });
      if (this.useNativeTouchInput) {
        // Capture-phase TouchEvents give us the complete changedTouches set before
        // any HUD descendant can interfere. touchstart remains non-passive to own
        // Safari gesture arbitration. On Apple, touchmove is passive because the
        // gameplay surface already declares touch-action:none; this removes the
        // synchronous main-thread scroll-decision barrier at 120-Hz input rates.
        document.addEventListener("touchstart", this.bound.touchstart, { passive: false, capture: true });
        document.addEventListener("touchmove", this.bound.touchmove, { passive: this.nativeTouchMovePassive, capture: true });
        document.addEventListener("touchend", this.bound.touchend, { passive: true, capture: true });
        document.addEventListener("touchcancel", this.bound.touchcancel, { passive: true, capture: true });
        // iOS Safari can begin its proprietary pinch gesture even when the game
        // surface has touch-action:none. Cancel gesture arbitration before it can
        // fan out touchcancel to one or more contacts in a chord.
        document.addEventListener("gesturestart", this.bound.gesture, { passive: false, capture: true });
        document.addEventListener("gesturechange", this.bound.gesture, { passive: false, capture: true });
      }
      for (const ev of this.pointerMoveEvents)
        // #gameView/#gameCanvas already declare touch-action:none. Keeping every
        // high-rate move event cancelable forces WebKit to synchronously wait on
        // the main thread before scrolling decisions and can starve 120-Hz rAF
        // during rapid multi-touch. Passive delivery preserves every sample and
        // judgment while removing that input-to-compositor barrier.
        window.addEventListener(ev, this.bound.move, { passive: true });
      window.addEventListener("pointerup", this.bound.up, { passive: true });
      window.addEventListener("pointercancel", this.bound.cancel, {
        passive: true,
      });
      window.addEventListener("lostpointercapture", this.bound.lost, { passive: true });
      window.addEventListener("resize", this.bound.resize);
      window.addEventListener("orientationchange", this.bound.orientation);
      screen.orientation?.addEventListener?.("change", this.bound.orientation);
      window.visualViewport?.addEventListener("resize", this.bound.resize);
      document.addEventListener("fullscreenchange", this.bound.fullscreen);
      document.addEventListener(
        "webkitfullscreenchange",
        this.bound.fullscreen,
      );
      document.addEventListener("visibilitychange", this.bound.visibility);
      window.addEventListener("pagehide", this.bound.pagehide);
      window.addEventListener("pageshow", this.bound.pageshow);
      document.addEventListener?.("freeze", this.bound.freeze);
      document.addEventListener?.("resume", this.bound.resumePage);
      for (const ev of ["playing", "seeked", "canplay"])
        this.audio.addEventListener(ev, this.bound.mediaSync);
      this.audio.addEventListener("ended", () => {
        if (!this.musicUsingWebAudio) this.finish();
      });
      try {
        if(this.record.streamAudioURL&&!this._offlineExport)throw new Error('使用边下边播音轨');
        this.musicBuffer = await audioBufferFromBlob(this.record.audioBlob);
        this.musicUsingWebAudio = !!this.musicBuffer;
      } catch {
        this.musicUsingWebAudio = false;
      }
      if(this.record.builtin && this.musicBuffer){
        const last=Math.max(0,...this.chart.lines.flatMap(line=>(line.notes||[]).map(note=>Math.max(note.time,note.end||0))))+Number(this.chart.offset||0);
        if(this.musicBuffer.duration+.25<last)throw new Error('内置音频不完整，不能提前结束谱面');
      }
      if (!this.musicUsingWebAudio) {
        this.ensureMediaAudioSource();
        if(this.record.streamAudioURL){
          this.audio.className='phiMusicStream';this.audio.hidden=true;this.audio.setAttribute('aria-hidden','true');
          $('#gameView').appendChild(this.audio);
          this.streamSession ||= new PhiHostedMedia.Stream(this.audio,this.record.streamSpec);
          this.streamSession.onProgress=state=>{
            setLoadingStatus(`音乐已缓冲 ${state.ahead.toFixed(1)} 秒 · 目标 ${Math.ceil(state.target)} 秒`);
            const status=$('#streamBufferStatus');if(status)status.textContent=`正在缓冲音乐… ${state.ahead.toFixed(1)} 秒`;
          };
          await (this.record._streamReady || this.streamSession.wait());
          this.streamSession.onProgress=null;
          this.bound.streamWaiting=()=>this.recoverStreamBuffer();
          this.audio.addEventListener('waiting',this.bound.streamWaiting);
        }else await new Promise((res, rej) => {
          this.audio.oncanplaythrough = res;
          this.audio.onerror = () => rej(new Error("音乐文件无法播放"));
          setTimeout(res, 3500);
        });
      }
      try {
        // Safari can leave resume() pending forever outside user activation.
        // Loading assets must finish independently; start() owns activation.
        if(Engine.sharedAudioContext().state==='running')
          await withTimeout(Engine.ensureHitMixer(this.pack,this.customHitSounds),6000,'判定音初始化超时');
      } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
    }
    applyCanvasResolution() {
      if (!(this.surfaceW > 0 && this.surfaceH > 0)) return;
      if(this._offlineExport){
        this.dpr=this._exportDpr||1;
        const pw=Math.round(this.surfaceW*this.dpr),ph=Math.round(this.surfaceH*this.dpr);
        if(this.canvas.width!==pw||this.canvas.height!==ph){this.canvas.width=pw;this.canvas.height=ph;this.effectCanvas=null;this.effectCtx=null;}
        this.ctx.imageSmoothingEnabled=true;this.ctx.imageSmoothingQuality='high';
        this.canvas.dataset.renderDpr=String(this.dpr);this.canvas.dataset.backingSize=`${pw}x${ph}`;
        return;
      }
      const safeBaseDpr = clamp(finiteNumber(this.baseDpr, 1), 0.5, MAX_RENDER_DPR),
        pjskScale = this.chart.kind === "pjsk"
          ? Math.min(clamp(Number(this.pjskLiteMode?.renderScale) || 1, 0.55, 1), 1.65 / safeBaseDpr)
          : 1,
        modeBase = lowResolutionMode
          ? Math.min(safeBaseDpr * LOW_RES_DPR_SCALE, LOW_RES_DPR_CAP)
          : safeBaseDpr * clamp(finiteNumber(this.renderQuality, 1), PERF_QUALITY_MIN, 1) * pjskScale,
        modeFloor = lowResolutionMode
          ? Math.min(modeBase, LOW_RES_DPR_FLOOR)
          : this.chart.kind === "pjsk"
            ? Math.min(modeBase, 0.68)
            : Math.max(1, safeBaseDpr * PERF_QUALITY_MIN),
        dpr = clamp(modeBase, Math.min(modeBase, modeFloor), safeBaseDpr),
        pw = safeCanvasDimension(this.surfaceW * dpr),
        ph = safeCanvasDimension(this.surfaceH * dpr);
      if (this.canvas.width !== pw || this.canvas.height !== ph) {
        this.canvas.width = pw;
        this.canvas.height = ph;
        this.effectCanvas = null;
        this.effectCtx = null;
      }
      this.dpr = dpr;
      this.ctx.imageSmoothingEnabled = true;
      try { this.ctx.imageSmoothingQuality = this.renderQuality < 0.9 ? "medium" : "high"; } catch {}
      this.canvas.dataset.lowResolution = lowResolutionMode ? "1" : "0";
      this.canvas.dataset.hyper120Quality = Number(this.renderQuality || 1).toFixed(2);
      this.canvas.dataset.renderDpr = dpr.toFixed(3);
      this.canvas.dataset.backingSize = `${pw}x${ph}`;
    }
    playfieldAspect() {
      const raw = Number(this.record?.meta?.aspectRatio);
      return Number.isFinite(raw) && raw >= 1 && raw <= 3 ? raw : 16 / 9;
    }
    applyLogicalLayout() {
      if (!(this.surfaceW > 0 && this.surfaceH > 0)) return;
      if (chartRevealEnabled) {
        const aspect=this.playfieldAspect(),fitW=Math.min(this.surfaceW,this.surfaceH*aspect);
        this.w=fitW;this.h=fitW/aspect;
      } else if (this.chart.kind !== 'pjsk') {
        // lchzh3473/sim-phi src/core.ts Renderer._resizeCanvas:
        // canvasfg.width = min(widthLowRes, heightLowRes * 16 / 9);
        // canvasfg.height = heightLowRes; artwork stays on the full canvas.
        this.w=Math.min(this.surfaceW,this.surfaceH*16/9);
        this.h=this.surfaceH;
      } else {
        this.w=this.surfaceW;this.h=this.surfaceH;
      }
      this.nativeBlockFrame = null;
      this.layoutSurfaceW = this.surfaceW;
      this.layoutSurfaceH = this.surfaceH;
      this.noteBase = Math.min(this.w, (this.h * 16) / 9);
      this.noteWidth = this.noteBase * (this.chart.kind === "pjsk" ? 0.065 : this.pack?.originalPhigros ? 989/8080 : 0.15625);
      // Limit only the off-screen raster length, not the authored geometry.
      // Extremely large PGR Hold multipliers (for example 999) need to cross
      // the screen but must not ask Canvas to scale a texture millions of px.
      this.holdDrawLengthCap = Math.hypot(this.w, this.h) * 3.5;
      this.updateOfficialLineSpan();
    }
    resize() {
      if(this._offlineRenderActive)return;
      this.nativeNoiseHudCache=null;
      const r = this.canvas.getBoundingClientRect();
      if (!(Number.isFinite(r.width) && Number.isFinite(r.height) && r.width >= 8 && r.height >= 8)) return;
      this.inputRect.left = r.left;
      this.inputRect.top = r.top;
      this.inputRect.width = r.width;
      this.inputRect.height = r.height;
      const nativeDpr = Math.max(1, finiteNumber(globalThis.devicePixelRatio, 1));
      // Choose a stable fill budget before rendering. Judgement and touch
      // coordinates stay in CSS/logical pixels regardless of backing density.
      this.baseDpr = globalThis.PhiPerformance
        ? PhiPerformance.renderDpr(r.width,r.height,nativeDpr,{cores:Number(navigator.hardwareConcurrency)||8,memory:Number(navigator.deviceMemory)||8,heavy:this.isHeavyVisualChart})
        : Math.min(nativeDpr,2);
      this.surfaceW = r.width;
      this.surfaceH = r.height;
      this.applyCanvasResolution();
      if (!this.layoutLocked) this.applyLogicalLayout();
      this.updateViewport();
    }
    updatePlayfieldFrame() {
      const gv = $("#gameView");
      if (!gv) return;
      $("#innerHudLogical")?.style.setProperty("--inner-hud-unit", `${this.w/682}px`);
      $("#innerHudLogical")?.style.setProperty("--inner-hud-y", `${this.h/512}px`);
      const active = !!chartRevealEnabled,
        x = active ? this.viewX : 0,
        y = active ? this.viewY : 0,
        w = active ? this.w * this.viewScale : this.surfaceW,
        h = active ? this.h * this.viewScale : this.surfaceH,
        hasOuter =
          active &&
          (x > 0.5 ||
            y > 0.5 ||
            w < this.surfaceW - 0.5 ||
            h < this.surfaceH - 0.5);
      gv.classList.toggle("revealMode", active);
      gv.classList.toggle("revealDualHud", hasOuter);
      gv.style.setProperty(
        "--surface-w",
        `${Math.max(1, this.surfaceW).toFixed(2)}px`,
      );
      gv.style.setProperty(
        "--surface-h",
        `${Math.max(1, this.surfaceH).toFixed(2)}px`,
      );
      gv.style.setProperty("--playfield-x", `${Math.max(0, x).toFixed(2)}px`);
      gv.style.setProperty("--playfield-y", `${Math.max(0, y).toFixed(2)}px`);
      gv.style.setProperty("--playfield-w", `${Math.max(1, w).toFixed(2)}px`);
      gv.style.setProperty("--playfield-h", `${Math.max(1, h).toFixed(2)}px`);
      gv.style.setProperty(
        "--playfield-logical-w",
        `${Math.max(1, this.w).toFixed(2)}px`,
      );
      gv.style.setProperty(
        "--playfield-logical-h",
        `${Math.max(1, this.h).toFixed(2)}px`,
      );
      gv.style.setProperty(
        "--playfield-scale",
        String(Math.max(0.0001, this.viewScale)),
      );
    }
    updateViewport() {
      this.inputFrameTime=NaN;
      if (!(this.w > 0 && this.h > 0)) this.applyLogicalLayout();
      const base =
          Math.min(this.surfaceW / this.w, this.surfaceH / this.h) || 1,
        scale = chartRevealEnabled
          ? normalizedChartRevealScale(chartRevealScale)
          : 1;
      this.viewScale = base * scale;
      this.viewX = (this.surfaceW - this.w * this.viewScale) / 2;
      this.viewY = (this.surfaceH - this.h * this.viewScale) / 2;
      const inv = 1 / Math.max(0.0001, this.viewScale);
      const bounds = this.visibleLogicalBounds;
      bounds.left = -this.viewX * inv;
      bounds.top = -this.viewY * inv;
      bounds.right = (this.surfaceW - this.viewX) * inv;
      bounds.bottom = (this.surfaceH - this.viewY) * inv;
      this.updatePlayfieldFrame();
      this.nativeNoiseHudCache=null;
    }
    prepareNoteGeometry() {
      if (!(this.w > 0 && this.h > 0)) return;
      const baseWidth = this.noteWidth || Math.min(this.w, (this.h * 16) / 9) * (this.chart.kind === "pjsk" ? 0.065 : 0.15625),
        packHoldBase = this.pack?.images?.hold || null;
      for (const item of this.noteItems) {
        const n = item.n,
          speed = finiteNumber(n.speed, 1),
          size = clamp(finiteNumber(n.size, 1), 0.05, 8),
          nw = baseWidth * size * noteSizeScale * this.packageNoteScale,
          nh = Math.max(3, nw * NOTE_THICKNESS_RATIO);
        n._along = finiteNumber(n.x, 0) * this.w * 0.50625;
        n._speedN = speed;
        n._nativeHoldHidden = !!n.nativeHoldHidden;
        n._alphaN = finiteNumber(n.alpha, 1);
        n._sizeN = size;
        n._nw = nw;
        n._nh = nh;
        n._yOffsetPx = (this.chart.kind === "rpe" || finiteNumber(n.yOffset, 0))
          ? (finiteNumber(n.yOffset, 0) / 900) * this.h * speed
          : 0;
        if (n.type === 3) {
          const holdKey = n.multi && this.pack?.images?.holdMH
              ? "holdMH"
              : this.pack?.images?.hold
                ? "hold"
                : null,
            holdImg = holdKey ? this.pack.images[holdKey] : null,
            ratio = holdImg && holdKey === "holdMH" && packHoldBase
              ? clamp(
                  finiteNumber(holdImg.naturalWidth || holdImg.width, 1) /
                    Math.max(1, finiteNumber(packHoldBase.naturalWidth || packHoldBase.width, 1)),
                  0.75,
                  1.45,
                )
              : 1;
          n._holdKey = holdKey;
          n._holdW = holdImg ? nw * ratio : nw * HOLD_WIDTH_RATIO;
          if(this.pack?.originalPhigros && this.chart.kind!=='pjsk' && holdImg){
            const ppu=holdKey==='holdMH'?Number(this.pack.info.holdHighlightPPU)||100:100;
            n._holdW=nw*(holdImg.naturalWidth||holdImg.width)/989*100/ppu;
          }
        } else {
          const key = n.type === 1 ? "tap" : n.type === 2 ? "drag" : "flick",
            mhKey = key + "MH",
            // Default notes get the generated gold coat. Custom packs instead
            // use their own MH/HL texture exactly; when it is absent, keep the
            // pack's ordinary coloured texture without adding another coat.
            imgKey = n.multi && this.pack?.images?.[mhKey]
              ? mhKey
              : this.pack?.images?.[key]
                ? key
                : key === "tap" && this.pack?.images?.click
                  ? "click"
                  : null;
          n._skinKey = key;
          n._imgKey = imgKey;
          n._img = imgKey ? this.pack.images[imgKey] : null;
          n._imgBounds = imgKey ? this.pack?.imageBounds?.[imgKey] || null : null;
          if(this.pack?.builtin && n.multi && /MH$/.test(imgKey||"")){
            const normal=this.pack.images[key], normalBounds=this.pack.imageBounds?.[key],
              sourceWidth=Number(n._imgBounds?.sw)||n._img?.naturalWidth||n._img?.width||1,
              baseWidth=Number(normalBounds?.sw)||normal?.naturalWidth||normal?.width||sourceWidth;
            n._nw=nw*sourceWidth/baseWidth;
          }
          if(this.pack?.originalPhigros && this.chart.kind!=='pjsk' && n._img){
            n._nw=nw*(n._img.naturalWidth||n._img.width)/989;
          }
          n._imgHeight = n._img
            ? normalizedTextureHeight(this.pack, imgKey, key, nh, n._nw)
            : nh;
        }
      }
    }
    prewarmGameplaySkins() {
      // Engine.init() runs while #gameView is still display:none. At that stage
      // WebKit correctly reports a 0×0 rect and Note geometry has not been built.
      // Never pass those undefined dimensions to Canvas width/height; lockLayout
      // invokes this again after the gameplay surface becomes visible.
      if (!(this.w > 0 && this.h > 0 && this.noteWidth > 0)) {
        Diagnostics.info("RenderEngine.prewarm", "等待可见布局后再预热 Note/Hold 栅格");
        return false;
      }
      if (this.chart.kind === "pjsk") {
        ensurePjskSkin(this);
        const stage = pjskStageGeometry(this), scale = this.pjskLiteMode?.stageScale || 1,
          key = `${Math.round(this.w)}x${Math.round(this.h)}:${stage.lanes}:${scale}`;
        if (!this.pjskStageCache || this.pjskStageCacheKey !== key) {
          this.pjskStageCache = buildPjskStageCache(this, stage);
          this.pjskStageCacheKey = key;
        }
        Diagnostics.info("RenderEngine.prewarm", "已预热 PJSK 固定轨道与新版打击特效", { lanes:stage.lanes, renderScale:this.pjskLiteMode?.renderScale || 1 });
        return true;
      }
      const noteFrequency = new Map(), holdFrequency = new Map();
      for (let i = 0; i < this.noteItems.length; i++) {
        const n = this.noteItems[i].n;
        if (n.type === 3) {
          if (n._nativeHoldHidden || n.nativeHoldHidden || n._holdKey) continue;
          const bucket = Math.max(28, Math.round((Number(n._holdW) || this.noteWidth) / 4) * 4),
            key = `${bucket}|${n.multi ? 1 : 0}`,
            entry = holdFrequency.get(key);
          if (entry) entry.count++;
          else holdFrequency.set(key, { key, bucket, multi: !!n.multi, count: 1 });
          continue;
        }
        if (n._img) continue;
        const logicalW = Math.max(16, Math.round((Number(n._nw) || this.noteWidth) / 4) * 4),
          bodyH = Math.max(3, n.type === 4 ? (Number(n._nh) || 3) * FLICK_THICKNESS_GAIN : (Number(n._nh) || 3)),
          key = `${n.type}:${n.multi && !this.pack ? 1 : 0}:${logicalW}:${Math.round(bodyH * 2)}`,
          entry = noteFrequency.get(key);
        if (entry) entry.count++;
        else noteFrequency.set(key, { n, count: 1 });
      }
      const noteEntries = [...noteFrequency.values()].sort((a, b) => b.count - a.count)
        .slice(0, HYPER120_PREWARM_NOTE_SKINS);
      for (let i = 0; i < noteEntries.length; i++) {
        const n = noteEntries[i].n;
        try {
          defaultNoteSkin(this.noteSkinCache, n.type, !!n.multi && !this.pack, n._nw, n._nh);
        } catch (error) {
          Diagnostics.warn("RenderEngine.prewarm.note", error?.message || String(error));
        }
      }
      const holdEntries = [...holdFrequency.values()].sort((a, b) => b.count - a.count)
        .slice(0, Math.max(1, Math.floor(HYPER120_PREWARM_HOLD_SKINS / 2)));
      for (let i = 0; i < holdEntries.length; i++) {
        const entry = holdEntries[i];
        try {
          this.holdSkinCache.set(`${entry.bucket}|${entry.multi ? 1 : 0}|0`, buildHoldSkin(entry.bucket, entry.multi, false));
          this.holdSkinCache.set(`${entry.bucket}|${entry.multi ? 1 : 0}|1`, buildHoldSkin(entry.bucket, entry.multi, true));
        } catch (error) {
          Diagnostics.warn("RenderEngine.prewarm.hold", error?.message || String(error));
        }
      }
      Diagnostics.info("RenderEngine.prewarm", "已在倒计时前预热 Note/Hold 栅格", {
        noteSkins: this.noteSkinCache.size,
        holdSkins: this.holdSkinCache.size,
      });
      return true;
    }
    reflowLayout() {
      if (!(this.surfaceW > 0 && this.surfaceH > 0)) return;
      this.applyLogicalLayout();
      this.layoutLocked = true;
      this.prepareNoteGeometry();
      this.updateViewport();
      for (const p of this.pointer.values()) {
        if (!Number.isFinite(p.clientX) || !Number.isFinite(p.clientY)) continue;
        this.eventPoint(p,p);
        p.startX=p.lastX=p.x; p.startY=p.lastY=p.y;
        p.startT=p.lastT=performance.now(); p.speed=0;
      }
      this.frameTime = NaN;
      this.buildRenderBuckets();
    }
    scheduleViewportReflow(force = false) {
      if(this._offlineExport)return;
      clearTimeout(this.reflowTimer);
      this.reflowTimer = setTimeout(() => {
        this.reflowTimer = 0;
        syncGameViewportCSS();
        this.resize();
        const fs = fullscreenActive(),
          modeChanged = fs !== this.fullscreenState,
          oldW = this.layoutSurfaceW || this.surfaceW,
          oldH = this.layoutSurfaceH || this.surfaceH,
          wr = Math.abs(this.surfaceW - oldW) / Math.max(1, oldW),
          hr = Math.abs(this.surfaceH - oldH) / Math.max(1, oldH),
          oldAspect = oldW / Math.max(1, oldH),
          newAspect = this.surfaceW / Math.max(1, this.surfaceH),
          aspectChanged = Math.abs(newAspect - oldAspect) > 0.1;
        this.fullscreenState = fs;
        if (
          this.layoutLocked &&
          (force || modeChanged || wr > 0.08 || hr > 0.08 || aspectChanged)
        )
          this.reflowLayout();
      }, 140);
    }
    lockLayout() {
      if (!(this.surfaceW > 0 && this.surfaceH > 0)) this.resize();
      this.fullscreenState = fullscreenActive();
      try {
        this.reflowLayout();
        this.prewarmGameplaySkins();
      } catch (e) {
        console.error("渲染索引建立失败，启用完整保底索引", e);
        this.applyLogicalLayout();
        this.layoutLocked = true;
        this.prepareNoteGeometry();
        this.buildFallbackRenderBuckets();
        this.updateViewport();
        // Cache warm-up is an optimization and must never prevent a chart from
        // starting, including malformed community values.
        try { this.prewarmGameplaySkins(); }
        catch (error) { Diagnostics.warn("RenderEngine.prewarm.fallback", error?.message || String(error)); }
      }
    }
    buildFallbackRenderBuckets() {
      let end = Math.max(1, this.musicDuration());
      for (const item of this.noteItems)
        end = Math.max(end, Number(item.n.end || item.n.time) || 0);
      const step = this.renderBucketStep,
        origin = this.renderBucketOrigin,
        count = Math.ceil((end + 1 - origin) / step) + 2,
        buckets = new Array(count);
      for (const item of this.noteItems) {
        const n = item.n;
        if (n.type === 3 && n.nativeHoldHidden) continue;
        const start = Math.max(origin, n.time - 3),
          finish = Math.max(n.time, n.end || n.time) + 0.6,
          a = Math.max(0, Math.floor((start - origin) / step)),
          b = Math.min(count - 1, Math.ceil((finish - origin) / step));
        for (let bi = a; bi <= b; bi++) {
          let bucket = buckets[bi];
          if (!bucket) bucket = buckets[bi] = { layers: [null, [], [], [], []] };
          bucket.layers[n.type].push(item);
        }
      }
      this.renderBuckets = buckets;
    }
    officialLineAuthoredAspect() {
      const raw = Number(this.record?.meta?.aspectRatio);
      return Number.isFinite(raw) && raw > 0 ? raw : PGR_LINE_OFFICIAL_ASPECT;
    }
    officialLineReferenceWidth() {
      if (this._officialLineReferenceWidth > 0) return this._officialLineReferenceWidth;
      return Math.max(1, this.h * this.officialLineAuthoredAspect());
    }
    officialLineThickness(scaleY = 1) {
      const base = this._officialLineBaseThickness > 0
        ? this._officialLineBaseThickness
        : (this.officialLineReferenceWidth() / PGR_LINE_REFERENCE_WIDTH) * PGR_LINE_REFERENCE_THICKNESS;
      return Math.max(1, base * Math.abs(Number(scaleY) || 0));
    }
    updateOfficialLineSpan() {
      this._officialLineReferenceWidth = Math.max(1, this.h * this.officialLineAuthoredAspect());
      this._officialLineBaseThickness =
        (this._officialLineReferenceWidth / PGR_LINE_REFERENCE_WIDTH) * PGR_LINE_REFERENCE_THICKNESS;
      const half = pgrLineHalfToWorld(
        this.record?.meta?.lineLength,
        this._officialLineReferenceWidth,
      );
      this.officialLineSpan.from = -half;
      this.officialLineSpan.to = half;
    }
    lineDrawSpan() {
      return this.officialLineSpan;
    }
    scheduleRenderIndexRebuild() {
      clearTimeout(this.renderIndexTimer);
      this.renderIndexTimer = setTimeout(() => {
        this.renderIndexTimer = 0;
        if (this.layoutLocked) this.buildRenderBuckets();
      }, 140);
    }
    buildRenderBuckets() {
      if (!(this.w > 0 && this.h > 0)) return;
      /*
       * Hyper120 exact broad phase. A Note's perpendicular distance from its line
       * is `(floor-currentFloor)*speed`; line translation/rotation cannot make a
       * point whose perpendicular component is larger than the farthest viewport
       * corner visible. Grouping by conservative speed bands therefore lets us
       * binary-search floor positions without a guessed temporal corridor. Slow,
       * malformed and Hold notes retain an exact fallback path.
       */
      const lineIndex = this.chart.lines.map(() => ({
        bandMaps: new Map(),
        groups: [],
        persistent: [],
        holds: [],
        maxExtent: Math.max(8, this.noteWidth * 1.5),
      }));
      let persistentCount = 0;
      for (let i = 0; i < this.noteItems.length; i++) {
        const item = this.noteItems[i], n = item.n;
        if (n.type < 1 || n.type > 4) continue;
        if (n.type === 3 && (n._nativeHoldHidden || n.nativeHoldHidden)) continue;
        const target = lineIndex[item.L.id],
          speed = Math.abs(Number.isFinite(n._speedN) ? n._speedN : Number(n.speed || 1)),
          shift = Number(n.yOffset || 0) / Math.max(1e-6, 900 * 0.34 * noteSpeedScale),
          key = Number(n.floor) + shift,
          artW = Number(n._nw) || this.noteWidth,
          artH = Number(n._imgHeight || n._nh) || artW * NOTE_THICKNESS_RATIO;
        if (!target) continue;
        target.maxExtent = Math.max(target.maxExtent, Math.hypot(artW, artH) * 0.72 + 4);
        if (n.type === 3) {
          const endKey = (this.chart.kind === "pgr" ? Number(n.floor) + Math.max(0,n.end-n.time)*Math.abs(Number(n.sourceSpeed)||0) : Number(n.endFloor ?? n.floor)) + shift;
          n._renderStartKey = key;
          n._renderEndKey = endKey;
          n._renderAbsSpeed = speed;
          target.holds.push(item);
          continue;
        }
        let bandMin = 0;
        if (Number.isFinite(key) && Number.isFinite(speed)) {
          for (let bi = 0; bi < HYPER120_SPEED_BANDS.length; bi++) {
            const candidate = HYPER120_SPEED_BANDS[bi];
            if (candidate <= speed + 1e-12) bandMin = candidate;
            else break;
          }
        }
        if (!(bandMin > 0)) {
          target.persistent.push(item);
          persistentCount++;
          continue;
        }
        let bucket = target.bandMaps.get(bandMin);
        if (!bucket) target.bandMaps.set(bandMin, (bucket = []));
        bucket.push({ key, item });
      }
      for (const target of lineIndex) {
        for (const [minSpeed, entries] of target.bandMaps) {
          entries.sort((a, b) => a.key - b.key);
          target.groups.push({
            minSpeed,
            keys: Float64Array.from(entries, (entry) => entry.key),
            items: entries.map((entry) => entry.item),
          });
        }
        target.groups.sort((a, b) => a.minSpeed - b.minSpeed);
        target.bandMaps.clear();
        target.bandMaps = null;
      }
      this.spatialRenderIndex = lineIndex;
      this.renderIndexPersistent = persistentCount + lineIndex.reduce((sum, line) => sum + line.holds.length, 0);
      this.completeRenderLayers = null;
      this.completeRenderBucket = null;
      this.renderBuckets = [];
      this.frameTime = NaN;
    }
    renderBucketAt(t) {
      if(this.chart.kind === "pjsk")return null;
      const index = this.spatialRenderIndex;
      if (!index?.length) {
        if (this.completeRenderBucket) return this.completeRenderBucket;
        const bi = Math.max(0, Math.floor((t - this.renderBucketOrigin) / this.renderBucketStep));
        return this.renderBuckets?.[bi] || null;
      }
      const layers = this.frameRenderLayers;
      for (let type = 1; type <= 4; type++) layers[type].length = 0;
      const vis = this.visibleLogicalBounds,
        worldUnit = Math.max(1e-6, this.h * 0.34 * noteSpeedScale);
      let candidates = 0;
      for (let lineId = 0; lineId < index.length; lineId++) {
        const source = index[lineId], ls = this.frameLines[lineId];
        if (!source || !ls) continue;
        const farX = Math.max(Math.abs(ls.cx - vis.left), Math.abs(ls.cx - vis.right)),
          farY = Math.max(Math.abs(ls.cy - vis.top), Math.abs(ls.cy - vis.bottom)),
          rawLimit = (Math.hypot(farX, farY) + source.maxExtent) / worldUnit + HYPER120_SPATIAL_MARGIN;
        for (let gi = 0; gi < source.groups.length; gi++) {
          const group = source.groups[gi],
            span = rawLimit / group.minSpeed,
            lo = lowerBoundNumeric(group.keys, ls.cur - span),
            hi = lowerBoundNumeric(group.keys, ls.cur + span + 1e-9);
          for (let i = lo; i < hi; i++) {
            const item = group.items[i], n = item.n,
              lateMiss = n.state === 1 && n.judge === "miss" && t < n.time + NOTE_FADEOUT_TIME;
            if (n.state === 1 && !lateMiss) continue;
            if (n.fake && t >= n.time) continue;
            if (!n.fake && t >= n.time + NOTE_FADEOUT_TIME && n.state === 1) continue;
            layers[n.type].push(item);
            candidates++;
          }
        }
        for (let i = 0; i < source.persistent.length; i++) {
          const item = source.persistent[i], n = item.n,
            lateMiss = n.state === 1 && n.judge === "miss" && t < n.time + NOTE_FADEOUT_TIME;
          if (n.state === 1 && !lateMiss) continue;
          if (n.fake && t >= n.time) continue;
          layers[n.type].push(item);
          candidates++;
        }
        for (let i = 0; i < source.holds.length; i++) {
          const item = source.holds[i], n = item.n,
            end = Number(n.end || n.time),
            speed = Math.max(1e-9, Number(n._renderAbsSpeed) || 0),
            span = rawLimit / speed,
            startKey = Number(n._renderStartKey),
            endKey = Number(n._renderEndKey),
            minKey = Math.min(startKey, endKey),
            maxKey = Math.max(startKey, endKey),
            active = t >= n.time - 1e-6 && t < end + NOTE_FADEOUT_TIME,
            floorVisible = Number.isFinite(minKey) && minKey <= ls.cur + span && maxKey >= ls.cur - span;
          if (n.state === 1 && t >= end) continue;
          if (n.fake && t >= end) continue;
          if (!active && !floorVisible) continue;
          layers[3].push(item);
          candidates++;
        }
      }
      this.metricsIndexedCandidates = candidates;
      return this.frameRenderBucket;
    }
    syncClock(hard = false) {
      if (this.musicUsingWebAudio) {
        const actual = this.musicCurrentTime();
        this.clockValue = actual;
        this.clockLastActual = actual;
        this.clockLastPerf = performance.now() / 1000;
        this.clockDrift = 0;
        this.clockReady = true;
        return actual;
      }
      const actual = Number(this.audio.currentTime) || 0,
        now = performance.now() / 1000,
        rate = Number(this.audio.playbackRate) || 1;
      if (hard || !this.clockReady) {
        this.clockValue = actual;
        this.clockLastPerf = now;
        this.clockLastActual = actual;
        this.clockLastMediaPerf = now;
        this.clockDrift = 0;
        this.clockReady = true;
        return actual;
      }
      const dt = clamp(now - this.clockLastPerf, 0, 0.1);
      this.clockLastPerf = now;
      const mediaAdvanced = Math.abs(actual - this.clockLastActual) > 0.00025;
      if (mediaAdvanced) {
        this.clockLastActual = actual;
        this.clockLastMediaPerf = now;
      }
      let predicted = this.clockValue + dt * rate,
        drift = actual - predicted;
      const stalled = this.streamBuffering || this.audio.paused ||
        this.audio.readyState < 3 || now - this.clockLastMediaPerf > SYNC_STALL_GUARD;
      // HTMLMediaElement.currentTime is commonly published at 60 Hz even when
      // requestAnimationFrame runs at 120 Hz. Correcting toward every quantized
      // media sample produces a sawtooth clock: alternate frames move and pause.
      // Between real discontinuities, performance.now() is the stable oscillator;
      // only snap on seek/stall or a drift large enough to represent a true jump.
      if (stalled || this.audio.seeking || Math.abs(drift) > 0.05) predicted = actual;
      else predicted = clamp(predicted,actual-.004,actual+.025);
      this.clockDrift = 0;
      const cap = Number.isFinite(this.audio.duration)
        ? this.audio.duration
        : Infinity;
      // Never keep an old predicted lead when the actual media clock stalls or
      // seeks back. That made the chart judge ahead of music on weak links.
      this.clockValue = clamp(predicted, 0, cap);
      return this.clockValue;
    }
    audioTime() {
      if (this.musicUsingWebAudio) return this.musicCurrentTime();
      if (!this.running || this.paused || this.audio.paused)
        return Number(this.audio.currentTime) || 0;
      return this.syncClock(false);
    }
    get time() {
      return Math.max(-3, this.audioTime() - this.chart.offset);
    }
    get judgeTime() {
      const adaptive = clamp(
        (Number(this.clockDrift) || 0) * 0.28,
        -0.012,
        0.012,
      );
      return this.time + judgeTimingLead + adaptive;
    }
    cancelLoop() {
      if (this.loopTimer) {
        clearTimeout(this.loopTimer);
        this.loopTimer = 0;
      }
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
    }
    hideCountdown() {
      const el = $("#countdown");
      if (el) {
        el.classList.add("hidden");
        el.textContent = "";
      }
    }
    async countdown(token = this.transitionToken) {
      const el = $("#countdown");
      el.classList.remove("hidden");
      for (const x of ["3", "2", "1"]) {
        if (token !== this.transitionToken || !this.running) {
          this.hideCountdown();
          return false;
        }
        el.textContent = x;
        await sleep(650);
      }
      if (token !== this.transitionToken || !this.running) {
        this.hideCountdown();
        return false;
      }
      const ok = token === this.transitionToken && this.running;
      this.hideCountdown();
      return ok;
    }
    async start(withCountdown = true) {
      const token = ++this.transitionToken;
      this.resumePending = false;
      this.cancelLoop();
      this.reset();
      this.running = true;
      this.paused = true;
      this.starting = true;
      this.usedAutoplay = this.autoplay;
      this.usedInvincible ||= this.invincibleMode;
      this.usedReveal ||= chartRevealEnabled;
      syncAssistIndicators(this);
      this.hideCountdown();
      $("#pausePanel").classList.add("hidden");
      if (withCountdown && !(await this.countdown(token))) {
        if (token === this.transitionToken) this.starting = false;
        return;
      }
      if (token !== this.transitionToken || !this.running) return;
      try {
        await this.ensureAudioSessionReady(this.audioWakePromise);
        this.audioWakePromise = null;
        if(this.chart.kind!=="pjsk"){
          this.prepareFrame(0);
          this.draw(0);
          triggerGameplayIntro();
          await sleep(matchMedia("(prefers-reduced-motion: reduce)").matches?20:1450);
          if(token!==this.transitionToken || !this.running)return;
        }
        await this.startMusic(0);
      } catch (e) {
        if (token === this.transitionToken) {
          this.starting = false;
          this.paused = true;
          $("#pausePanel").classList.remove("hidden");
        }
        throw e;
      }
      if (token !== this.transitionToken || !this.running) {
        this.pauseMusic();
        return;
      }
      this.paused = false;
      this.starting = false;
      this.syncClock(true);
      this.lastFramePerf = 0;
      this.nextFramePerf = 0;
      this.frameIntervalAvg = 0;
      this.refreshInterval = 0;
      this.frameWorkAvg = 0;
      this.frameWorkPeak = 0;
      this.qualityOverloadStreak = 0;
      this.qualitySevereStreak = 0;
      this.qualityHeadroomStreak = 0;
      this.systemFrameTargetMs = FRAME_TARGET_MS;
      this.highRefreshProbeUntil = performance.now() + HIGH_REFRESH_PROBE_MS;
      this.visualTime = NaN;
      this.seekJudgeFeed(this.time);
      this.scheduleLoop();
    }
    reset() {
      this.streamRecoveryAbort?.abort();this.streamBuffering=false;
      this.inputFrameTime=NaN;
      clearTimeout(this.referenceFinishTimer);this.referenceFinishing=false;
      $("#gameView")?.classList.remove("phiStageIntro","phiStageOutro");
      keyboardInput?.clear("engine.reset");
      this.cancelLoop();
      this.stopMusic(true);
      this.nativeNoiseAudio=null;
      this.inputClockPauses=[];
      if(this.noiseAudioNode?.parameters)this.noiseAudioNode.parameters.get('cutoff').value=0;
      this.usedModeSwitch = false;
      this.clockReady = false;
      this.clockValue = 0;
      this.clockLastPerf = 0;
      this.clockLastActual = -1;
      this.clockLastMediaPerf = 0;
      this.clockDrift = 0;
      this.visualTime = NaN;
      this.currentVisualTime = NaN;
      this.counts = [0, 0, 0, 0];
      this.actualCounts = [0, 0, 0, 0];
      this.actualCombo = 0;
      this.actualMaxCombo = 0;
      this.earlyLate = [0, 0];
      this.combo = 0;
      this.maxCombo = 0;
      for (let i = 0; i < this.effects.length; i++)
        this.releaseHitEffect(this.effects[i]);
      this.effects.length = 0;
      this.clearPendingHitEffects();
      this.badGhosts.length = 0;
      this.autoSoundIndex = 0;
      this.autoJudgeIndex = 0;
      this.judgeFeedIndex = 0;
      this.pendingJudge.clear();
      this.activeHolds.clear();
      for (const item of this.noteItems) {
        const n = item.n;
        n.state = 0;
        n.holdPointer = null;
        n.holdHeadDiff = 0;
        n.releaseAt = Infinity;
        n.judge = null;
        n.inputMissDeadline = 0;
        n.autoStarted = false;
        n.autoSoundScheduled = false;
        n.resultAt = -Infinity;
        n.holdMiss = false;
        n.holdFxAt = Infinity;
        n.flickArmed = false;
        n.flickArmAt = -Infinity;
        n.flickPointer = null;
        n.dragArmed = false;
        n.dragPointer = null;
        n.dragArmUntil = -Infinity;
      }
      this.lastHudScore = "";
      this.lastHudCombo = "";
      this.lastHudVisible = null;
      this.lastHudAutoplay = null;
      for (const key of Object.keys(this.inputStats)) this.inputStats[key] = 0;
      this.lastProgressPct = -1;
      this.nextProgressPerf = 0;
      this.lastHitPerf = -Infinity;
      this.jankFrames = 0;
      this.hitJankFrames = 0;
      this.paintProgress(0);
      resetPjskState(this);
      this.updateHUD();
    }
    stop(reason = "stop") {
      this.streamRecoveryAbort?.abort();this.streamBuffering=false;$('#streamBufferStatus')?.classList.add('hidden');
      clearTimeout(this.referenceFinishTimer);this.referenceFinishing=false;
      $("#gameView")?.classList.remove("phiStageIntro","phiStageOutro");
      keyboardInput?.clear("engine.stop");
      ++this.transitionToken;
      this.resumePending = false;
      this.starting = false;
      this.hideCountdown();
      this.resetAttachedUI();
      this.running = false;
      this.paused = true;
      this.pauseReason = reason;
      this.cancelLoop();
      clearTimeout(this.renderIndexTimer);
      this.stopMusic(false);
      this.audio.pause();
      document.removeEventListener("pointerdown", this.bound.down, true);
      if (this.useNativeTouchInput) {
        document.removeEventListener("touchstart", this.bound.touchstart, true);
        document.removeEventListener("touchmove", this.bound.touchmove, true);
        document.removeEventListener("touchend", this.bound.touchend, true);
        document.removeEventListener("touchcancel", this.bound.touchcancel, true);
        document.removeEventListener("gesturestart", this.bound.gesture, true);
        document.removeEventListener("gesturechange", this.bound.gesture, true);
      }
      for (const ev of this.pointerMoveEvents)
        window.removeEventListener(ev, this.bound.move);
      window.removeEventListener("pointerup", this.bound.up);
      window.removeEventListener("pointercancel", this.bound.cancel);
      window.removeEventListener("lostpointercapture", this.bound.lost);
      window.removeEventListener("resize", this.bound.resize);
      window.removeEventListener("orientationchange", this.bound.orientation);
      screen.orientation?.removeEventListener?.(
        "change",
        this.bound.orientation,
      );
      window.visualViewport?.removeEventListener("resize", this.bound.resize);
      document.removeEventListener("fullscreenchange", this.bound.fullscreen);
      document.removeEventListener(
        "webkitfullscreenchange",
        this.bound.fullscreen,
      );
      document.removeEventListener("visibilitychange", this.bound.visibility);
      window.removeEventListener("pagehide", this.bound.pagehide);
      window.removeEventListener("pageshow", this.bound.pageshow);
      document.removeEventListener?.("freeze", this.bound.freeze);
      document.removeEventListener?.("resume", this.bound.resumePage);
      clearTimeout(this.reflowTimer);
      for (const ev of ["playing", "seeked", "canplay"])
        this.audio.removeEventListener(ev, this.bound.mediaSync);
      this.clearPointerStates();
      this.streamSession?.destroy();
      if(this.bound.streamWaiting)this.audio.removeEventListener('waiting',this.bound.streamWaiting);
      try{this.mediaMusicSource?.disconnect();}catch{}
      this.mediaMusicSource=null;
      this.audio.pause();this.audio.removeAttribute('src');this.audio.load();
      this.audio.remove();
      if (this.audioURL?.startsWith('blob:')) URL.revokeObjectURL(this.audioURL);
      if (this.bgURL) URL.revokeObjectURL(this.bgURL);
      if (this.renderBgURL) URL.revokeObjectURL(this.renderBgURL);
      this.bgImage = null;
      this.renderBgImage = null;
      this.backgroundRenderState = "idle";
      this.backgroundDatasetRenderer = "idle";
      this.backgroundDatasetState = "idle";
      this.canvas.dataset.backgroundRenderer = "idle";
      this.canvas.dataset.backgroundState = "idle";
      const gameView = $("#gameView"), gameBg = $("#gameBg"), gameBgImage = $("#gameBgImage");
      if (gameView) gameView.style.backgroundImage = "";
      if (gameBg) {
        gameBg.dataset.backgroundState = "idle";
        gameBg.style.backgroundImage = "";
      }
      if (gameBgImage) {
        gameBgImage.classList.remove("sourceFallback", "bakedFrosted");
        gameBgImage.classList.add("hiddenBackground");
        gameBgImage.removeAttribute("src");
      }
      this.canvas.style.opacity = "";
      this.canvas.style.display = "block";
      this.postProcessor?.destroy();
      this.nativeBlockRenderer?.destroy();this.nativeBlockRenderer=null;
      this.nativeNoiseOverlay?.remove();this.nativeNoiseOverlay=null;this.nativeNoiseOverlayCtx=null;this.nativeNoiseHudCache=null;
      this.noiseAudioNode?.disconnect();this.noiseAudioNode=null;
      this.nativeBlockFrame=null;this.nativeBlockTimeline=null;
      this.postProcessor = null;
      this.clearRPETextureRasterCache();
      this.foregroundFxCanvas?.remove();
      this.foregroundFxCanvas = null;
      this.foregroundFxCtx = null;
      this.foregroundFxVisible = false;
    }
    beginAudioWakeFromGesture() {
      // This method is called before the first await in a click handler. Safari
      // therefore receives the AudioContext.resume() request while user activation
      // is still valid, rather than after the 3-2-1 countdown.
      const preservedTime = Number(this.audio.currentTime) || 0,
        preservedMuted = !!this.audio.muted;
      let mediaPrime = Promise.resolve();
      if (!this.musicUsingWebAudio) {
        try {
          this.audio.muted = true;
          const playResult = this.audio.play();
          mediaPrime = Promise.resolve(playResult).then(() => {
            this.audio.pause();
            try { this.audio.currentTime = preservedTime; } catch {}
            this.audio.muted = preservedMuted;
          }, () => { this.audio.muted = preservedMuted; });
        } catch { this.audio.muted = preservedMuted; }
      }
      const contextPrime = Engine.ensureAudioContextRunning(1400, true);
      return Promise.allSettled([contextPrime, mediaPrime]);
    }
    async ensureAudioSessionReady(primePromise = null) {
      if(primePromise)await withTimeout(primePromise,2200,'音频唤醒超时').catch(()=>null);
      try{
        await Engine.ensureAudioContextRunning(1600,false);
        // Do not test currentTime before scheduling music. Safari may not render
        // an idle graph yet; that was a false failure and caused the old loop.
        await withTimeout(Engine.ensureHitMixer(this.pack,this.customHitSounds),6000,'判定音准备超时');
        return true;
      }catch(error){
        Diagnostics.warn('AudioEngine.session',error.message,{playback:'gesture-primed media element'});
        this.stopMusic(false);this.musicUsingWebAudio=false;
        this.ensureMediaAudioSource();return true;
      }
    }
    handlePageSuspended(reason = "hidden") {
      if (this._offlineExport || !this.running) return;
      this.backgroundGeneration++;
      this.backgroundPaused = true;
      this.backgroundPauseOffset = this.musicCurrentTime();
      if (!this.paused || this.resumePending || this.starting) this.pause(reason);
      else {
        this.cancelLoop();
        this.pauseMusic();
      }
    }
    handlePageRestored(reason = "visible") {
      if (this._offlineExport || !this.running) return;
      this.backgroundGeneration++;
      this.cancelLoop();
      this.syncClock(true);
      this.clearPointerStates();
      requestAnimationFrame(() => {
        if (this._offlineExport || !this.running || document.hidden) return;
        syncGameViewportCSS();
        this.resize();
        this.mountGameplayBackground(true);
        if (this.postProcessor?.gl?.isContextLost?.()) {
          this.postProcessor.destroy();
          this.postProcessor = null;
        }
        this.draw(this.time);
      });
      Diagnostics.info("GameState.lifecycle", "页面已返回前台，等待用户继续", { reason, offset: this.musicCurrentTime() });
    }
    pause(reason = "manual") {
      this.streamRecoveryAbort?.abort();this.streamBuffering=false;$('#streamBufferStatus')?.classList.add('hidden');
      keyboardInput?.clear("engine.pause");
      if (!this.running) return;
      if (this.paused && !this.resumePending && !this.starting) return;
      ++this.transitionToken;
      this.resumePending = false;
      this.starting = false;
      this.paused = true;
      this.pauseReason = reason;
      this.cancelLoop();
      this.pauseMusic();
      this.syncClock(true);
      this.clearPointerStates();
      this.hideCountdown();
      syncChartRevealUI();
      $("#pausePanel").classList.remove("moreOpen");
      $("#pauseMoreBtn")?.setAttribute("aria-expanded", "false");
      $("#pauseMoreSheet")?.setAttribute("aria-hidden", "true");
      $("#pausePanel").classList.remove("hidden");
      syncPauseTransportUI(this); syncPausedPjskControls();
      performanceMonitor.refresh(this);
    }
    async resume() {
      if (!this.paused || this.resumePending || this.starting) return;
      const audioWake = this.beginAudioWakeFromGesture(),
        offset = this.backgroundPaused ? this.backgroundPauseOffset : this.musicCurrentTime(),
        token = ++this.transitionToken;
      this.audioWakePromise = audioWake;
      this.resumePending = true;
      this.cancelLoop();
      $("#pausePanel").classList.add("hidden");
      if (
        !(await this.countdown(token)) ||
        token !== this.transitionToken ||
        !this.running
      ) {
        if (token === this.transitionToken) this.resumePending = false;
        return;
      }
      try {
        await this.ensureAudioSessionReady(audioWake);
        syncGameViewportCSS();
        this.resize();
        this.mountGameplayBackground(true);
        await this.startMusic(offset);
      } catch (e) {
        if (token === this.transitionToken) {
          this.resumePending = false;
          this.paused = true;
          $("#pausePanel").classList.remove("hidden");
          toast("继续播放失败：" + e.message, true);
        }
        return;
      }
      if (token !== this.transitionToken || !this.running) {
        this.pauseMusic();
        return;
      }
      this.paused = false;
      this.resumePending = false;
      this.backgroundPaused = false;
      this.pauseReason = "";
      this.audioWakePromise = null;
      this.syncClock(true);
      this.lastFramePerf = 0;
      this.nextFramePerf = 0;
      this.frameIntervalAvg = 0;
      this.refreshInterval = 0;
      this.frameWorkAvg = 0;
      this.frameWorkPeak = 0;
      this.qualityOverloadStreak = 0;
      this.qualitySevereStreak = 0;
      this.qualityHeadroomStreak = 0;
      this.systemFrameTargetMs = FRAME_TARGET_MS;
      this.highRefreshProbeUntil = performance.now() + HIGH_REFRESH_PROBE_MS;
      this.visualTime = NaN;
      this.seekJudgeFeed(this.time);
      this.scheduleLoop();
    }
    async restart() {
      if (!this.record || !this.chart) throw new Error("当前谱面已经释放，无法重新开始");
      if (this.restartPending) return;
      this.restartPending = true;
      this.audioWakePromise = this.beginAudioWakeFromGesture();
      this.hideCountdown();
      $("#pausePanel").classList.add("hidden");
      this.backgroundPaused = false;
      try {
        // start() performs the reset synchronously before its first await, so the
        // old run is cleared immediately. The gesture prime is then consumed once
        // instead of rebuilding the audio path twice for every restart.
        await this.start(false);
      } finally {
        this.restartPending = false;
      }
    }
    handleOrientation() {
      if (this.running) this.scheduleViewportReflow(true);
    }
    scheduleLoop() {
      if (!this.running || this.paused || this.streamBuffering || this.raf) return;
      this.raf = requestAnimationFrame(this.bound.loop);
    }
    adaptPerformance(workCost, now, frameInterval) {
      if (!(workCost >= 0)) return;
      this.frameWorkAvg = this.frameWorkAvg
        ? this.frameWorkAvg * 0.94 + workCost * 0.06
        : workCost;
      this.frameWorkPeak = Math.max(workCost, (Number(this.frameWorkPeak) || 0) * 0.91);
      if (frameInterval > 4 && frameInterval < 40) {
        this.frameIntervalAvg = this.frameIntervalAvg
          ? this.frameIntervalAvg * 0.94 + frameInterval * 0.06
          : frameInterval;
        // Keep the fastest stable cadence as the display baseline. A single
        // missed vblank must not redefine a 120-Hz panel as 60 Hz.
        if (!this.refreshInterval || frameInterval < this.refreshInterval * 1.22)
          this.refreshInterval = this.refreshInterval
            ? this.refreshInterval * 0.97 + frameInterval * 0.03
            : frameInterval;
      }

      const interval = Number(this.frameIntervalAvg) || FRAME_TARGET_MS,
        cost = Number(this.frameWorkAvg) || 0,
        peak = Number(this.frameWorkPeak) || 0,
        measuredTarget = highRefreshController.targetMs(FRAME_TARGET_MS);
      if (highRefreshController.samples >= 24) {
        this.systemFrameTargetMs = measuredTarget;
      } else if (now >= this.highRefreshProbeUntil && cost < 6.4 && peak < 7.4) {
        if (interval >= 13.2) this.systemFrameTargetMs = 1000 / 60;
        else if (interval >= 9.8) this.systemFrameTargetMs = 1000 / 90;
        else this.systemFrameTargetMs = FRAME_TARGET_MS;
      } else this.systemFrameTargetMs = FRAME_TARGET_MS;

      if (lowResolutionMode) return;
      // Hyper120 only changes the backing store after sustained overload. The
      // broad-phase index, caches and audio thread carry the common case without
      // a resolution change; the adaptive ladder is the final thermal/fill-rate
      // safety net for tablet-class GPUs.
      if (PERF_QUALITY_LEVELS.length === 1) return;
      // iPad Pro stability mode: render resolution is selected before gameplay
      // and remains immutable for the whole song. Mid-song backing-store changes
      // can cost multiple vblanks even when the average workload is light.
      if (this.isAppleTouch && APPLE_FIXED_120_QUALITY) return;
      const target = this.systemFrameTargetMs,
        frameJank = frameInterval > target * 1.52,
        currentHeavy = workCost > target * 0.72,
        averagedHeavy = cost > target * 0.67,
        peakHeavy = peak > target * 0.93,
        cadenceHeavy = frameInterval > target * 1.18 || interval > target * 1.14,
        severe = workCost > target * 1.08 || cost > target * 0.91 || frameInterval > target * 1.62,
        overloaded = currentHeavy || averagedHeavy || cadenceHeavy || (frameJank && peakHeavy),
        hasHeadroom = workCost < target * 0.42 && cost < target * 0.45 && interval < target * 1.06;

      this.qualityOverloadStreak = overloaded
        ? Math.min(1000, this.qualityOverloadStreak + 1)
        : Math.max(0, this.qualityOverloadStreak - 2);
      this.qualitySevereStreak = severe
        ? Math.min(1000, this.qualitySevereStreak + 1)
        : Math.max(0, this.qualitySevereStreak - 3);
      this.qualityHeadroomStreak = hasHeadroom
        ? Math.min(4000, this.qualityHeadroomStreak + 1)
        : Math.max(0, this.qualityHeadroomStreak - 4);

      if (now - this.lastQualityAdjust < PERF_ADJUST_INTERVAL) return;
      this.lastQualityAdjust = now;
      if (now - this.lastResolutionChange < PERF_RESIZE_COOLDOWN_MS) return;

      let index = 0, nearest = Infinity;
      for (let i = 0; i < PERF_QUALITY_LEVELS.length; i++) {
        const distance = Math.abs(PERF_QUALITY_LEVELS[i] - this.renderQuality);
        if (distance < nearest) { nearest = distance; index = i; }
      }
      let nextIndex = index;
      if (
        this.qualitySevereStreak >= PERF_SEVERE_STREAK ||
        this.qualityOverloadStreak >= PERF_OVERLOAD_STREAK
      ) {
        // One level only. Canvas backing-store reallocations are intentionally
        // rare because the resize itself is more visible than one isolated jank.
        nextIndex = Math.min(PERF_QUALITY_LEVELS.length - 1, index + 1);
        this.qualityOverloadStreak = 0;
        this.qualitySevereStreak = 0;
        this.qualityHeadroomStreak = 0;
      } else if (
        PERF_ALLOW_MIDSONG_RECOVERY &&
        this.qualityHeadroomStreak >= PERF_HEADROOM_STREAK &&
        now - this.lastQualityRaise >= PERF_RECOVERY_INTERVAL
      ) {
        const ceilingIndex = this.isAppleTouch
          ? Math.max(0, PERF_QUALITY_LEVELS.indexOf(
              Number(this.appleQualityCeiling) || APPLE_120_START_QUALITY,
            ))
          : 0;
        nextIndex = Math.max(ceilingIndex, index - 1);
        this.qualityHeadroomStreak = 0;
        this.lastQualityRaise = now;
      }
      const next = PERF_QUALITY_LEVELS[nextIndex];
      if (next !== this.renderQuality) {
        this.renderQuality = next;
        this.pendingResolution = true;
        this.qualityChangeRequestedAt = now;
        this.lastResolutionChange = now;
      }
    }
    smoothVisualTime(rawTime, frameInterval) {
      if (!Number.isFinite(rawTime)) return 0;
      if (!Number.isFinite(this.visualTime) || frameInterval <= 0) {
        this.visualTime = rawTime;
        return rawTime;
      }
      const predicted =
          this.visualTime +
          (frameInterval / 1000) * (Number(this.musicRate) || 1),
        drift = rawTime - predicted;
      if (rawTime < this.visualTime - 0.01 || Math.abs(drift) > 0.05)
        this.visualTime = rawTime;
      else this.visualTime = predicted + drift * Math.min(1,Math.max(0,frameInterval)/64);
      return this.visualTime;
    }
    loop(now = performance.now()) {
      this.raf = 0;
      if (!this.running || this.paused || this.streamBuffering) return;
      this.frameNow = now;
      if (this.pendingResolution) {
        // Never reallocate the backing store on top of a judgement burst. Wait
        // for an effects gap; a long sustained overload still has a bounded
        // escape hatch so recovery cannot be postponed forever.
        const safeGap = this.effects.length === 0 && now - this.lastHitPerf > 420,
          forced = now - this.qualityChangeRequestedAt > 1800;
        if (safeGap || forced) {
          this.pendingResolution = false;
          this.applyCanvasResolution();
        }
      }
      const frameInterval = this.lastFramePerf ? now - this.lastFramePerf : 0;
      this.lastFramePerf = now;
      highRefreshController.observe(frameInterval);
      const cadence=highRefreshController.targetMs(frameInterval||FRAME_TARGET_MS),
        missedVblank=frameInterval>cadence*1.5;
      if (missedVblank) this.missedVblankRecent = 18;
      else if (this.missedVblankRecent > 0) this.missedVblankRecent--;
      if (missedVblank) {
        this.jankFrames++;
        if (now - this.lastHitPerf < 90) this.hitJankFrames++;
      }
      // Lightweight cadence estimate for visual-time smoothing. No timers, no
      // allocations, no resolution changes.
      if (frameInterval > 4 && frameInterval < 40) {
        if (!this.refreshInterval || frameInterval < this.refreshInterval * 1.22)
          this.refreshInterval = this.refreshInterval
            ? this.refreshInterval * 0.985 + frameInterval * 0.015
            : frameInterval;
      }
      const t = this.time,
        visualT = this.smoothVisualTime(t, frameInterval),
        // Sample one out of four frames even with overlays hidden. The previous
        // build disabled the adaptive controller whenever the FPS UI was closed.
        samplePerf = performanceMonitor.visible || performanceMonitor.miniEnabled ||
          (++this.perfSampleCounter % PERF_SAMPLE_EVERY === 0),
        workStart = samplePerf ? performance.now() : 0;
      this.prepareFrame(visualT);
      this.currentVisualTime = visualT;
      this.update(t, now, visualT);
      // Materialize hit visuals once per rAF, outside TouchEvent callbacks.
      this.flushHitEffects();
      const drawStart = samplePerf ? performance.now() : 0;
      this.draw(visualT, now);
      let drawCost = this.drawCostAvg || 0,
        workCost = this.frameWorkAvg || 0;
      if (samplePerf) {
        const end = performance.now();
        drawCost = end - drawStart;
        workCost = end - workStart;
        this.drawCostAvg = this.drawCostAvg ? this.drawCostAvg * 0.88 + drawCost * 0.12 : drawCost;
        this.adaptPerformance(workCost, now, frameInterval);
      }
      performanceMonitor.frame(this, frameInterval, drawCost, workCost, now);
      this.scheduleLoop();
    }
    computeLineFrame(L, t, stamp, frames=this.frameLines) {
      const f =
        frames[L.id] ||
        (frames[L.id] = { color: [255, 255, 255] });
      if (f.stamp === stamp) return f;
      if (f.busy === stamp) return f;
      f.busy = stamp;
      let x = L.moveXLayers
          ? rpeLayerValueFast(L.moveXLayers, t, 0)
          : eventValueFast(L.moveX, t, 0),
        y = L.moveYLayers
          ? rpeLayerValueFast(L.moveYLayers, t, 0)
          : eventValueFast(L.moveY, t, 0),
        rot = L.rotateLayers
          ? rpeLayerValueFast(L.rotateLayers, t, 0)
          : eventValueFast(L.rotate, t, 0),
        alpha = L.alphaLayers
          ? rpeLayerValueFast(L.alphaLayers, t, 0)
          : clamp(eventValueFast(L.alpha, t, 1), 0, 1),
        scaleX = 1,
        scaleY = 1,
        incline = 0,
        text = "";
      let color = f.color || [255, 255, 255];
      if (L.isRPE) {
        scaleX = L.scaleX?.length ? eventValueFast(L.scaleX, t, 1) : 1;
        scaleY = L.scaleY?.length ? eventValueFast(L.scaleY, t, 1) : 1;
        incline = L.incline?.length ? eventValueFast(L.incline, t, 0) : 0;
        if (L.color?.length)
          color = rpeColorValueFast(L.color, t, DEFAULT_LINE_COLOR, color);
        else {
          color[0] = 255;
          color[1] = 255;
          color[2] = 255;
        }
        if (L.text?.length) text = rpeTextValueFast(L.text, t, "");
      }
      const lineLength = L.lineLengthEvents?.length ? eventValueFast(L.lineLengthEvents, t, L.lineLength || 6) : (L.lineLength || 6);
      if (L.parent != null && this.chart.lines[L.parent]) {
        const p = this.computeLineFrame(this.chart.lines[L.parent], t, stamp, frames);
        if (L.isRPE) {
          // RPE/Phira 的 father 位移以同一谱面世界坐标记录：子线只叠加父线平移。
          // scaleX/scaleY 是父线自身图像或线段尺寸，不能再次缩放子线坐标；
          // 父线 alpha 也不应隐式吞掉子线。rotateWithFather 仅控制角度继承。
          x += p.x;
          y += p.y;
          if (L.rotateWithParent) rot += p.rot;
        } else {
          x += p.x;
          y += p.y;
          if (L.rotateWithParent) rot += p.rot;
          alpha *= clamp(Number(p.alpha) || 0, 0, 1);
        }
      }
      const screenRot = -rot,
        ri = clamp(Math.round(Number(color[0]) || 0), 0, 255),
        gi = clamp(Math.round(Number(color[1]) || 0), 0, 255),
        bi = clamp(Math.round(Number(color[2]) || 0), 0, 255),
        colorKey = (ri << 16) | (gi << 8) | bi;
      if (f.colorKey !== colorKey) {
        f.colorKey = colorKey;
        f.colorCss = `rgb(${ri},${gi},${bi})`;
        f.colorWhite = ri === 255 && gi === 255 && bi === 255;
      }
      f.x = x;
      f.y = y;
      f.rot = rot;
      f.alpha = alpha;
      f.scaleX = scaleX;
      f.scaleY = scaleY;
      f.incline = incline;
      f.color = color;
      f.text = text;
      f.lineLength = Math.max(0.01, Number(lineLength) || 6);
      if (f.screenRot !== screenRot || !Number.isFinite(f.ux)) {
        const r = (screenRot * Math.PI) / 180;
        f.screenRot = screenRot;
        f.rotRad = r;
        f.ux = Math.cos(r);
        f.uy = Math.sin(r);
        f.vx = -f.uy;
        f.vy = f.ux;
      }
      f.cx = this.w / 2 + (x * this.w) / 2;
      f.cy = this.h / 2 - (y * this.h) / 2;
      f.cur = L.floorAt(Math.max(0, t));
      f.stamp = stamp;
      f.busy = 0;
      return f;
    }
    prepareFrame(t) {
      this.frameTime = t;
      const stamp = ++this.frameStamp;
      const lines = this.chart.lines;
      for (let i = 0; i < lines.length; i++) this.computeLineFrame(lines[i], t, stamp);
    }
    lineScreen(L, t) {
      if(this.frameLines[L.id]&&Math.abs(t-this.frameTime)<=1/240)return this.frameLines[L.id];
      // An input sample needs this line and its ancestors, not every line in the
      // chart. Keep input samples out of the immutable current render frame.
      if(!Number.isFinite(this.inputFrameTime)||Math.abs(t-this.inputFrameTime)>1/240){
        this.inputFrameTime=t;this.inputFrameStamp++;
      }
      return this.computeLineFrame(L,t,this.inputFrameStamp,this.inputFrameLines);
    }
    notePointInto(L, n, t, out = this.pointScratchA) {
      const ls = this.lineScreen(L, t),
        speed = Number.isFinite(n._speedN)
          ? n._speedN
          : (Number.isFinite(Number(n.speed)) ? Number(n.speed) : 1),
        rawBase = (n.floor - ls.cur) * speed,
        yOffset = Number.isFinite(n._yOffsetPx)
          ? n._yOffsetPx
          : this.chart.kind === "rpe"
            ? (Number(n.yOffset || 0) / 900) * this.h * speed
            : 0,
        dist =
          (rawBase * this.h * 0.34 * noteSpeedScale + yOffset) *
          (Number.isFinite(n.directionSign) ? n.directionSign : (n.above ? -1 : 1));
      let along = Number.isFinite(n._along) ? n._along : n.x * this.w * 0.50625;
      if (this.chart.kind === "rpe" && n.type !== 3 && ls.incline) {
        const yNorm =
            rawBase * 0.68 * noteSpeedScale +
            ((Number(n.yOffset || 0) * 2) / 900) * speed,
          factor = 1 - Math.sin((ls.incline * Math.PI) / 180) * yNorm * 1.25;
        along *= factor;
      }
      out.x = ls.cx + ls.ux * along + ls.vx * dist;
      out.y = ls.cy + ls.uy * along + ls.vy * dist;
      out.line = ls;
      out.dist = dist;
      out.along = along;
      out.rawBase = rawBase;
      return out;
    }
    notePoint(L, n, t) {
      return this.notePointInto(L, n, t, this.pointScratchA);
    }
    noteJudgePointInto(L, n, t, out = this.pointScratchB) {
      const ls = this.lineScreen(L, t);
      if (this.chart.kind === "pjsk") {
        const stage = pjskStageGeometry(this),
          lane = clamp(n.type === 3 && t >= n.time && n.end > n.time
            ? pjskSlideLane(n, (t - n.time) / (n.end - n.time)) : Number(n._pjskLane) || 0, 0, stage.lanes - 1),
          p = pjskPoint(stage, lane, 1);
        out.x = p.x;
        out.y = p.y;
        out.line = ls;
        out.along = p.x - stage.cx;
        out.dist = 0;
        out.rawBase = 0;
        return out;
      }
      const along = Number.isFinite(n._along) ? n._along : n.x * this.w * 0.50625;
      out.x = ls.cx + ls.ux * along;
      out.y = ls.cy + ls.uy * along;
      out.line = ls;
      out.along = along;
      out.dist = 0;
      out.rawBase = 0;
      return out;
    }
    noteJudgePoint(L, n, t) {
      return this.noteJudgePointInto(L, n, t, this.pointScratchB);
    }
    touchLineX(L, x, y, t = this.time) {
      const ls = this.lineScreen(L, t);
      return (x - ls.cx) * ls.ux + (y - ls.cy) * ls.uy;
    }
    judgeHalfWidth(n) {
      const specialGain =
        n?.type === 2 ? DRAG_JUDGE_WIDTH_GAIN :
        n?.type === 4 ? FLICK_JUDGE_WIDTH_GAIN : 1;
      if (this.chart.kind === "pjsk") {
        const stage = pjskStageGeometry(this), laneW = (stage.bottomHalf * 2) / stage.lanes,
          span = clamp(Number(n?.type === 3 && this.time >= n.time
            ? pjskSlideSpan(n,(this.time-n.time)/Math.max(1e-6,n.end-n.time))
            : n?._pjskSpan) || 1, 1, stage.lanes);
        // Lane-relative judgement follows the same width as the AUTO visual Note.
        return Math.max(14, laneW * span * 0.48 * clamp(touchSensitivity, 0.8, 1.7) * specialGain);
      }
      return (
        Math.max(92, this.w * 0.118125 * JUDGE_GAIN * touchSensitivity) *
        Math.max(0.25, Number(n.judgeArea || 1)) *
        specialGain
      );
    }
    touchMatchesNote(L, n, p, t = this.time) {
      if(nativeBlockTouchBlocked(this,p.x,p.y,t,p.id))return false;
      return this.touchCoordinatesMatchNote(L, n, p.x, p.y, t);
    }
    touchCoordinatesMatchNote(L, n, x, y, t = this.time) {
      if (this.chart.kind === "pjsk") {
        const stage = pjskStageGeometry(this),
          lane = n.type === 3 && t >= n.time && n.end > n.time
            ? pjskSlideLane(n, (t - n.time) / (n.end - n.time))
            : Number(n._pjskLane) || 0,
          p = pjskPoint(stage, clamp(lane, 0, stage.lanes - 1), 1);
        return Math.abs(x - p.x) <= this.judgeHalfWidth(n);
      }
      const along = Number.isFinite(n._along)
          ? n._along
          : n.x * this.w * 0.50625,
        tx = this.touchLineX(L, x, y, t);
      return Math.abs(tx - along) <= this.judgeHalfWidth(n);
    }
    findTouchForNote(
      L, n, t = this.time, allowCancelGhost = false,
      now = performance.now() / 1000, preferredId = null,
    ) {
      const keyboard = keyboardInput?.hasGameplayKey();
      if (keyboard) return this.keyboardPointer;
      const preferred =
        preferredId != null && preferredId !== "keyboard"
          ? this.pointer.get(preferredId)
          : null;
      // Hold continuity is lane/position based, not finger-ID based. Keep the
      // original contact when it is still valid, but allow any other live finger
      // on the same judgement-line position to take over immediately. This makes
      // deliberate hand swaps and Touch.identifier changes transparent.
      if (
        preferred && preferred.active !== false &&
        this.touchMatchesNote(L, n, preferred, t)
      ) return preferred;
      for (const replacement of this.pointer.values()) {
        if (replacement === preferred || replacement.active === false) continue;
        if (this.touchMatchesNote(L, n, replacement, t)) return replacement;
      }
      // Browser-generated touchcancel may temporarily hide a physically held
      // contact. Ghosts are considered only after all genuinely live contacts,
      // so a real second finger always wins the handoff.
      if (allowCancelGhost) {
        if (
          preferred && preferred.cancelled === true &&
          Number(preferred.ghostUntil) > now &&
          this.touchMatchesNote(L, n, preferred, t)
        ) return preferred;
        for (const ghost of this.pointer.values()) {
          if (ghost === preferred || ghost.active !== false || ghost.cancelled !== true) continue;
          if (Number(ghost.ghostUntil) <= now) continue;
          if (this.touchMatchesNote(L, n, ghost, t)) return ghost;
        }
      }
      return null;
    }
    manualTargetTime(n) {
      return n.time + (n.type === 2 || n.type === 4 ? specialJudgeDelay : 0);
    }
    seekJudgeFeed(at) {
      this.pendingJudge.clear();
      this.judgeFeedIndex = lowerBoundNumeric(this.noteTimes, at - BAD - 0.35);
    }
    update(t = this.time, frameNow = performance.now(), geometryT = t) {
      const nowSec = frameNow / 1000,
        jt =
          t +
          judgeTimingLead +
          clamp((Number(this.clockDrift) || 0) * 0.28, -0.012, 0.012);
      if (this.chart.kind === "pjsk") updatePjskJudgement(this,t,frameNow);
      if (this.chart.kind !== "pjsk" && this.autoplay) {
        while (
          this.autoJudgeIndex < this.noteItems.length &&
          this.noteItems[this.autoJudgeIndex].n.time <= t
        ) {
          const item = this.noteItems[this.autoJudgeIndex++],
            n = item.n;
          if (n.fake || n.state !== 0) continue;
          this.usedAutoplay = true;
          if (n.type === 3) {
            n.state = 2;
            n.holdPointer = "autoplay";
            n.releaseAt = Infinity;
            n.judge = "perfect";
            n.autoStarted = true;
            n.holdFxAt = t + (this.chart.kind === "pjsk" ? PJSK_HOLD_FX_INTERVAL : HOLD_HIT_FX_INTERVAL);
            this.activeHolds.add(item);
            if (!n.autoSoundScheduled) this.playSound("click", null, n);
            this.hitEffect(item.L, n, 0, t);
          } else this.commit(n, 0, 0, item.L);
        }
      }
      if (this.chart.kind !== "pjsk" && !this.autoplay) {
        this.keyboardContinuous(t);
        while (
          this.judgeFeedIndex < this.noteItems.length &&
          this.noteItems[this.judgeFeedIndex].n.time <= jt + Math.max(BAD, DRAG_LATE_WINDOW, FLICK_ARM_LATE) + 0.18
        ) {
          const item = this.noteItems[this.judgeFeedIndex++];
          if (!item.n.fake) this.pendingJudge.add(item);
        }
        for (const item of this.pendingJudge) {
          const L = item.L,
            n = item.n;
          if (n.state === 1) {
            this.pendingJudge.delete(item);
            continue;
          }
          if (n.state === 2) {
            this.activeHolds.add(item);
            this.pendingJudge.delete(item);
            continue;
          }
          const target = this.manualTargetTime(n);
          if(n.flickArmed){const p=this.pointer.get(n.flickPointer);if(p&&nativeBlockTouchBlocked(this,p.x,p.y,t,p.id)){n.flickArmed=false;n.flickPointer=null;}}
          if(n.dragArmed){const p=this.pointer.get(n.dragPointer);if(p&&nativeBlockTouchBlocked(this,p.x,p.y,t,p.id)){n.dragArmed=false;n.dragPointer=null;n.dragArmUntil=-Infinity;}}
          if (n.type === 4 && n.state === 0 && n.flickArmed) {
            if (jt >= target) {
              this.commit(n, 0, jt - target, L);
              this.pendingJudge.delete(item);
              continue;
            }
            if (jt - target > FLICK_ARM_LATE) {
              n.flickArmed = false;
              n.flickPointer = null;
            }
          }
          if (n.type === 2 && n.state === 0) {
            const earlyWindow = DRAG_PREARM_EARLY * clamp(touchSensitivity, 0.9, 1.35);
            if (jt >= target - earlyWindow && jt <= target + DRAG_LATE_WINDOW) {
              const touch = this.findTouchForNote(L, n, geometryT, true, nowSec);
              if (touch) {
                n.dragArmed = true;
                n.dragPointer = touch.id;
                n.dragArmUntil = nowSec + DRAG_ARM_GRACE * clamp(touchSensitivity, 0.9, 1.45);
              }
              const armed = n.dragArmed && nowSec <= Number(n.dragArmUntil);
              if (jt >= target && (touch || armed)) {
                this.commit(n, 0, jt - target, L);
                this.pendingJudge.delete(item);
                continue;
              }
            }
          }
          const missLimit =
            n.type === 3 ? GOOD :
            n.type === 2 ? DRAG_LATE_WINDOW :
            n.type === 4 ? FLICK_ARM_LATE : BAD;
          if (n.state === 0 && jt - target > missLimit) {
            // rAF can run before an already queued touch task after a long
            // frame. Leave a short dispatch opportunity before finalizing Miss.
            // Eligibility still uses the original event timestamp and exactly
            // the same judgement windows; a genuinely late press cannot score.
            if (n.type === 1 || n.type === 3) {
              if (!n.inputMissDeadline) n.inputMissDeadline = frameNow + INPUT_DISPATCH_GRACE_MS;
              if (frameNow < n.inputMissDeadline) continue;
            }
            this.commit(n, 3, 0, L);
            this.pendingJudge.delete(item);
            continue;
          }
          n.inputMissDeadline = 0;
        }
      }
      for (const item of this.activeHolds) {
        const L = item.L,
          n = item.n;
        if (n.state !== 2) {
          this.activeHolds.delete(item);
          continue;
        }
        const end = n.end || n.time;
        if (n.autoStarted) {
          if (t >= n.holdFxAt && t < end - HOLD_TAIL_EARLY) {
            this.hitEffect(L, n, 0, t);
            n.holdFxAt += this.chart.kind === "pjsk" ? PJSK_HOLD_FX_INTERVAL : HOLD_HIT_FX_INTERVAL;
            if (n.holdFxAt <= t) n.holdFxAt = t + (this.chart.kind === "pjsk" ? PJSK_HOLD_FX_INTERVAL : HOLD_HIT_FX_INTERVAL);
          }
          if (t >= end - HOLD_TAIL_EARLY) this.commit(n, 0, 0, L);
          continue;
        }
        const touch = this.findTouchForNote(
            L, n, geometryT, true, nowSec, n.holdPointer,
          ),
          // Never let chart/BPM-derived Hold grace fall below the global short
          // release tolerance. A tiny all-fingers-up gap (for example during a
          // fast hand swap) therefore resumes normally instead of becoming Miss.
          grace =
            Math.max(
              HOLD_GRACE,
              clamp(Number(n.holdGrace) || HOLD_GRACE, 0.04, 0.5),
            ) * clamp(touchSensitivity, 0.9, 1.45);
        if (touch) {
          n.holdPointer = touch.id;
          n.releaseAt = Infinity;
          if (t >= n.holdFxAt && t < end - HOLD_TAIL_EARLY) {
            this.hitEffect(L, n, n.judge === "good" ? 1 : 0, t);
            n.holdFxAt += this.chart.kind === "pjsk" ? PJSK_HOLD_FX_INTERVAL : HOLD_HIT_FX_INTERVAL;
            if (n.holdFxAt <= t) n.holdFxAt = t + (this.chart.kind === "pjsk" ? PJSK_HOLD_FX_INTERVAL : HOLD_HIT_FX_INTERVAL);
          }
        } else if (!Number.isFinite(n.releaseAt)) n.releaseAt = nowSec;
        if (
          Number.isFinite(n.releaseAt) &&
          nowSec - n.releaseAt > grace &&
          jt < end - HOLD_TAIL_EARLY
        )
          this.commit(n, 3, 0, L);
        else if (jt >= end - HOLD_TAIL_EARLY)
          this.commit(n, n.judge === "good" ? 1 : 0, finiteNumber(n.holdHeadDiff, 0), L);
      }
      for (const [id, p] of this.pointer)
        if (p.active === false && Number(p.ghostUntil) <= nowSec) {
          this.pointer.delete(id);
          this.releasePointerState(p);
        }
      let ew = 0;
      for (let i = 0; i < this.effects.length; i++) {
        const e = this.effects[i];
        if (frameNow - e.at < (e.duration || 0.52) * 1000)
          this.effects[ew++] = e;
        else this.releaseHitEffect(e);
      }
      this.effects.length = ew;
      let bw = 0;
      for (let i = 0; i < this.badGhosts.length; i++) {
        const e = this.badGhosts[i];
        if (frameNow - e.at < (e.duration || BAD_GHOST_TIME) * 1000)
          this.badGhosts[bw++] = e;
      }
      this.badGhosts.length = bw;
      if (frameNow >= this.nextHudPerf) {
        this.nextHudPerf = frameNow + HUD_PUMP_MS;
        this.updateHUD();
      }
      if (frameNow >= this.nextProgressPerf) {
        this.nextProgressPerf = frameNow + PROGRESS_PUMP_MS;
        // Keep progress on the compositor without forcing style work at the full
        // 120-Hz gameplay cadence. This element is only a few pixels high.
        const progressScale = clamp(this.audioTime() / Math.max(0.001, this.musicDuration()), 0, 1);
        if (Math.abs(progressScale - this.lastProgressPct) > 0.000001) {
          this.paintProgress(progressScale);
          this.lastProgressPct = progressScale;
        }
      }
    }
    touchPointerId(touch) {
      // PointerEvent pointerIds are non-negative in normal browser input. Keep
      // native Touch identifiers in a separate negative namespace with no strings
      // or per-frame allocations.
      return -1 - (Number(touch?.identifier) || 0);
    }
    touchPoint(touch, out = null) {
      const r = this.inputRect,
        target = out || {},
        inv = 1 / Math.max(0.0001, this.viewScale);
      target.x = (touch.clientX - r.left - this.viewX) * inv;
      target.y = (touch.clientY - r.top - this.viewY) * inv;
      return target;
    }
    touchInsidePlayfield(touch) {
      const r = this.inputRect,
        x = touch.clientX - r.left,
        y = touch.clientY - r.top;
      return (
        x >= 0 && x <= (this.surfaceW || this.w * this.viewScale) &&
        y >= 0 && y <= (this.surfaceH || this.h * this.viewScale)
      );
    }
    acquireTouchState(touch, eventTimeStamp) {
      const p = this.pointerPool.pop() || {},
        now = this.eventPerformanceTime(eventTimeStamp);
      this.touchPoint(touch, p);
      p.clientX = touch.clientX; p.clientY = touch.clientY;
      p.id = this.touchPointerId(touch);
      p.nativeTouch = true;
      p.touchPointer = false;
      p.pointerAlias = null;
      p.downJudged = false;
      p.downT = now;
      p.nativeDownT = now;
      p.downReceipt = null;
      p.downClientX = touch.clientX; p.downClientY = touch.clientY;
      p.noiseBlocked = false;
      p.cancelled = false;
      p.active = true;
      p.ghostUntil = 0;
      p.lastX = p.startX = p.x;
      p.lastY = p.startY = p.y;
      p.lastT = p.startT = now;
      p.speed = 0;
      p.flickReady = true;
      p.flickDirX = 0;
      p.flickDirY = 0;
      p.lastFlickAt = 0;
      return p;
    }
    matchDownReceipt(native, id, clientX, clientY, at) {
      const records=this.inputDownReceipts||[],seen=native?'touchSeen':'pointerSeen',other=native?'pointerSeen':'touchSeen';
      let best=null,score=Infinity;
      for(let i=records.length-1;i>=0;i--){
        const r=records[i],dt=Math.abs(at-r.at),distance=(clientX-r.x)**2+(clientY-r.y)**2;
        const within=r.recovered ? at>=r.earliestAt-1&&at<=r.at+12 : dt<=12;
        if(r[seen]||!r[other]||!within||distance>36)continue;
        const rank=dt+distance*.01;if(rank<score){best=r;score=rank;}
      }
      if(best){best[seen]=true;best[native?'touchId':'pointerId']=id;if(best.recovered){best.at=at;best.recovered=false;}}
      return best;
    }
    rememberDownReceipt(p, recovered = false) {
      const records=this.inputDownReceipts||=([]),native=!!p.nativeTouch;
      const r={at:p.downT,x:p.downClientX,y:p.downClientY,pointerSeen:!native,touchSeen:native,
        pointerId:native?null:p.id,touchId:native?p.id:null,ended:false,endAt:Infinity,recovered,
        earliestAt:recovered?Math.min(p.downT,this.nativeTouchSnapshotTime??p.downT-250):p.downT-12};
      records.push(r);if(records.length>128)records.shift();p.downReceipt=r;return r;
    }
    findTouchBridge(clientX, clientY, stamp, native, motion = false, after = -Infinity) {
      let best = null, bestDistance = 24 * 24;
      for (const p of this.pointer.values()) {
        const cancelledFallback = !native && p.cancelled && p.ghostUntil > performance.now()/1000 && Math.abs(stamp-(motion?p.lastT:p.downT)) <= 12;
        if (p.downT<after-1 || (p.active === false && !cancelledFallback) || p.nativeTouch !== native ||
            (native ? p.pointerAlias != null : !p.touchPointer) ||
            // The reverse-order match must be tight: an older native-only
            // finger must not consume a new nearby finger's pointerdown.
            Math.abs(stamp - (motion ? p.lastT : p.downT)) > (native ? 12 : 80)) continue;
        // A missing touchstart may first surface as touchmove after a fast
        // swipe. Match the latest pointer sample, not the now-distant down point.
        const px = motion ? this.inputRect.left+this.viewX+p.x*this.viewScale : p.downClientX,
          py = motion ? this.inputRect.top+this.viewY+p.y*this.viewScale : p.downClientY,
          distance = (clientX-px)**2 + (clientY-py)**2;
        if (distance <= bestDistance) { best = p; bestDistance = distance; }
      }
      return best;
    }
    adoptNativeTouch(touch, stamp, motion = false, receipt = null) {
      const at = this.eventPerformanceTime(stamp),
        after=Math.max(this.nativeTouchEndedAt?.get(this.touchPointerId(touch))??-Infinity,this.nativeTouchSnapshotTime??-Infinity),
        p = receipt ? this.pointer.get(receipt.pointerId) : this.findTouchBridge(touch.clientX,touch.clientY,at,false,motion,after) ||
          (motion ? this.findTouchBridge(touch.clientX,touch.clientY,at,false,false,after) : null);
      if (!p) {
        const fresh=this.acquireTouchState(touch,stamp);
        if(receipt){fresh.downReceipt=receipt;fresh.downJudged=true;}
        return fresh;
      }
      const oldId = p.id, pid = this.touchPointerId(touch);
      this.pointer.delete(oldId);
      p.id = pid; p.nativeTouch = true; p.pointerAlias = oldId;
      p.nativeDownT = at;
      p.active = true; p.cancelled = false; p.ghostUntil = 0;
      if(p.downReceipt)p.downReceipt.touchId=pid;
      (this.nativePointerLinks ||= new Map()).set(oldId,pid);
      // The earlier PointerEvent may already own a Hold or armed special note.
      // Hand off the same contact, including its noise-area latch, atomically.
      for (const {n} of this.activeHolds) if (n.holdPointer === oldId) n.holdPointer = pid;
      for (const {n} of this.pendingJudge || []) {
        if (n.dragPointer === oldId) n.dragPointer = pid;
        if (n.flickPointer === oldId) n.flickPointer = pid;
      }
      if (this.inputStats) this.inputStats.bridges++;
      return p;
    }
    judgeContactDown(p, audioT, recovered = false) {
      if (p.downJudged) return;
      if (!p.downReceipt) this.rememberDownReceipt(p,recovered);
      p.downJudged = true;
      if (recovered && this.inputStats) this.inputStats.recovered++;
      this.tryTap(p.id,p.x,p.y,audioT);
      this.tryArmDrag(p.id,p.x,p.y,audioT);
    }
    nativeGestureGuard(e) {
      if (!this.useNativeTouchInput || !this.running || this.paused || this.starting || this.resumePending) return;
      // Only suppress browser gesture arbitration while gameplay owns at least one
      // native contact. This leaves non-game UI gestures untouched.
      const target = e.target instanceof Element ? e.target : null;
      if ((this.pointer.size || target?.closest('#gameView')) && e.cancelable) e.preventDefault();
    }
    releaseNativeTouchContact(pid, p, nowSec = performance.now() / 1000, eventTime = nowSec*1000) {
      if (!p) return false;
      for (const item of this.activeHolds)
        if (item.n.holdPointer === pid) item.n.releaseAt = Math.min(Number(item.n.releaseAt) || Infinity, nowSec);
      this.pointer.delete(pid);
      this.releasePointerState(p,eventTime);
      return true;
    }
    recoverNativeTouchSnapshot(
      e,
      { synthesizeMissingDown = false, reconcileMissing = false, reviveLive = true, motion = false } = {},
    ) {
      if (!this.useNativeTouchInput || !e || e.touches == null) return false;
      const touches = e.touches, live = this.nativeTouchLiveIds;
      live.clear();
      let changedAny = false;
      const eventAudioTime = synthesizeMissingDown ? this.eventAudioTime(e) : this.time;
      for (let i = 0; i < touches.length; i++) {
        const touch = touches[i], pid = this.touchPointerId(touch);
        live.add(pid);
        if (this.nativeTouchBlocked.has(pid)) continue;
        const at=this.eventPerformanceTime(e);
        let latest=null;
        for(const r of this.inputDownReceipts||[])if(r.touchId===pid&&r.at<=at&&(!latest||r.at>latest.at))latest=r;
        // The other API may deliver an old live snapshot after a real lift.
        // That snapshot must not resurrect the ended finger as a new Tap.
        if(latest?.ended&&at<=latest.endAt)continue;
        let unpaired=null;
        const after=Math.max(this.nativeTouchEndedAt?.get(pid)??-Infinity,this.nativeTouchSnapshotTime??-Infinity);
        for(const r of this.inputDownReceipts||[])if(r.pointerSeen&&r.touchId==null&&r.at>=after-1&&r.at<=at&&at<=r.endAt&&
          (touch.clientX-r.x)**2+(touch.clientY-r.y)**2<=36&&(!unpaired||r.at>unpaired.at))unpaired=r;
        if(unpaired){
          unpaired.touchId=pid;
          if(unpaired.ended){this.nativeTouchBlocked.add(pid);continue;}
        }
        if (touch.target instanceof Element &&
            touch.target.closest("button,input,select,textarea,a,[contenteditable='true']")) {
          this.nativeTouchBlocked.add(pid);
          continue;
        }
        let p = this.pointer.get(pid);
        if (p) {
          if(this.eventPerformanceTime(e)<p.lastT-0.01)continue;
          // A Safari touchcancel is not proof that the finger left the glass. If a
          // later authoritative snapshot still contains the identifier, immediately
          // restore it as a live contact without generating a second Tap edge.
          if (reviveLive && (p.active === false || p.cancelled === true)) {
            this.touchPoint(touch, p);
            p.lastX = p.x; p.lastY = p.y;
            p.lastT = this.eventPerformanceTime(e);
            p.active = true; p.cancelled = false; p.ghostUntil = 0;
            changedAny = true;
          }
          p.clientX = touch.clientX; p.clientY = touch.clientY;
          const q = this.touchPoint(touch, this.pointScratchB || (this.pointScratchB = {}));
          if (synthesizeMissingDown && (Math.abs(q.x-p.x) > .01 || Math.abs(q.y-p.y) > .01))
            this.processNativeTouchMotion(touch,p,eventAudioTime,this.eventPerformanceTime(e));
          else { p.x=q.x; p.y=q.y; }
          continue;
        }
        if (!this.touchInsidePlayfield(touch)) continue;
        // `touches` is authoritative. During dense iPad chords WebKit can omit one
        // contact from changedTouches. Recovering only position (50.4 behavior)
        // made blue Tap/Hold starts impossible until that finger moved. A missing
        // contact first observed on start/move now receives exactly one reconstructed
        // down edge, then becomes an ordinary independent contact.
        p = this.adoptNativeTouch(touch, e.timeStamp, motion, unpaired);
        this.pointer.set(pid, p);
        if (synthesizeMissingDown) {
          this.judgeContactDown(p,eventAudioTime,true);
        }
        changedAny = true;
      }
      if (reconcileMissing) {
        const nowSec = performance.now() / 1000;
        for (const [pid, p] of this.pointer) {
          if(!p||p.downT>this.eventPerformanceTime(e)+.001)continue;
          if(!p.nativeTouch){
            if(p.touchPointer&&touches.length===0)this.releaseNativeTouchContact(pid,p,nowSec,this.eventPerformanceTime(e));
            continue;
          }
          if (live.has(pid)) continue;
          if (p.cancelled && p.ghostUntil > nowSec) continue;
          // The inverse failure also occurs: touchend/cancel changedTouches can omit
          // one identifier. A state absent from authoritative `touches` must not
          // remain as a ghost active finger that steals Hold/Drag ownership.
          this.releaseNativeTouchContact(pid, p, nowSec, this.eventPerformanceTime(e));
          changedAny = true;
        }
        for (const pid of this.nativeTouchBlocked)
          if (!live.has(pid)) this.nativeTouchBlocked.delete(pid);
      }
      this.nativeTouchSnapshotTime=Math.max(this.nativeTouchSnapshotTime||0,this.eventPerformanceTime(e));
      return changedAny;
    }
    touchStart(e) {
      if (
        !this.useNativeTouchInput || !this.running || this.paused ||
        this.starting || this.resumePending || this.autoplay
      ) return;
      const changed = e.changedTouches;
      if (this.inputStats) this.inputStats.touchStart+=changed?.length||0;
      let accepted = false;
      const eventAudioTime = this.eventAudioTime(e);
      for (let i = 0; i < (changed?.length || 0); i++) {
        const touch = changed[i],
          target = touch.target instanceof Element ? touch.target : null;
        const pid = this.touchPointerId(touch);
        if (
          !this.touchInsidePlayfield(touch) ||
          target?.closest("button,input,select,textarea,a,[contenteditable='true']")
        ) {
          this.nativeTouchBlocked.add(pid);
          continue;
        }
        this.nativeTouchBlocked.delete(pid);
        const receipt=this.matchDownReceipt(true,pid,touch.clientX,touch.clientY,this.eventPerformanceTime(e));
        if(receipt?.ended){this.nativeTouchBlocked.add(pid);accepted=true;continue;}
        // identifier reuse is legal after a finished contact. Replace any stale
        // state instead of swallowing a new physical finger.
        const stale = this.pointer.get(pid);
        if (stale) {
          if(receipt&&stale.downReceipt===receipt){stale.downT=receipt.at;stale.nativeDownT=this.eventPerformanceTime(e);accepted=true;continue;}
          // The same edge can first appear in another finger's live snapshot.
          if (stale.active !== false && Math.abs(this.eventPerformanceTime(e)-stale.nativeDownT) <= 1) {
            accepted = true;
            continue;
          }
          this.pointer.delete(pid);
          this.releasePointerState(stale,this.eventPerformanceTime(e)-.001);
        }
        // A real native touchstart is a new edge unless an unpaired opposite
        // source receipt proves otherwise. Nearby live fingers are independent.
        const p = receipt ? this.adoptNativeTouch(touch,e.timeStamp,false,receipt) : this.acquireTouchState(touch,e.timeStamp);
        this.pointer.set(pid, p);
        this.judgeContactDown(p,eventAudioTime);
        accepted = true;
      }
      // A second/third finger can occasionally be absent from changedTouches while
      // still present in the authoritative live snapshot. Recover it before the
      // browser gets a chance to promote the chord into a page gesture.
      this.recoverNativeTouchSnapshot(e, {
        synthesizeMissingDown: true,
        reconcileMissing: true,
        reviveLive: true,
      });
      if ((accepted || this.pointer.size) && e.cancelable) e.preventDefault();
    }
    armDragAlongPath(pid, x, y, eventAudioTime, fromX, fromY) {
      // A single coalesced move may cross several lanes. Each successful commit
      // removes one candidate; an early pre-arm stops at its own uncommitted note.
      const limit = this.chart.kind === "pjsk" ? this.chart.pjskLaneCount : 4;
      for (let i = 0; i < limit; i++) {
        if (!this.tryArmDrag(pid, x, y, eventAudioTime, fromX, fromY)) break;
        if (this.candidateScratch.n?.state === 0) break;
      }
    }
    armFlickAlongPath(pid, x, y, eventAudioTime, fromX, fromY) {
      const limit = this.chart.kind === "pjsk" ? this.chart.pjskLaneCount : 1;
      for (let i = 0; i < limit; i++) {
        if (!this.tryFlick(pid, x, y, eventAudioTime, fromX, fromY)) break;
        if (this.candidateScratch.n?.state === 0) break;
      }
    }
    processNativeTouchMotion(touch, p, eventAudioTime, now, recovered = false) {
      if(now<p.lastT-0.01)return;
      const pid = p.id, q = this.pointScratchA;
      const qx=(touch.clientX-this.inputRect.left-this.viewX)/this.viewScale,
        qy=(touch.clientY-this.inputRect.top-this.viewY)/this.viewScale;
      if(!recovered&&p.active!==false&&!p.cancelled&&Math.abs(now-p.lastT)<=POINTER_DUPLICATE_EPS_MS&&
         Math.abs(qx-p.lastX)<=POINTER_DUPLICATE_EPS_PX&&Math.abs(qy-p.lastY)<=POINTER_DUPLICATE_EPS_PX)return;
      p.active = true;
      p.cancelled = false;
      p.ghostUntil = 0;
      this.touchPoint(touch, q);
      p.clientX = touch.clientX; p.clientY = touch.clientY;
      const prevX = p.lastX, prevY = p.lastY,
        dt = Math.max(0.5, now - p.lastT),
        dx = q.x - prevX, dy = q.y - prevY,
        step = Math.hypot(dx, dy),
        instantSpeed = (step / dt) * 1000;
      p.speed = Math.max(p.speed * 0.34, instantSpeed);
      p.lastX = p.x = q.x;
      p.lastY = p.y = q.y;
      p.lastT = now;
      if (recovered) {
        p.startX = p.x; p.startY = p.y; p.startT = now;
        this.judgeContactDown(p,eventAudioTime,true);
      }
      this.armDragAlongPath(pid, p.x, p.y, eventAudioTime, prevX, prevY);
      const travelX = q.x - p.startX,
        travelY = q.y - p.startY,
        travel = Math.hypot(travelX, travelY),
        elapsed = now - p.startT,
        needSpeed = FLICK_SPEED / clamp(touchSensitivity, 0.85, 1.8),
        needTravel = FLICK_TRAVEL / clamp(touchSensitivity, 0.9, 1.55),
        moveLen = Math.max(0.0001, step),
        moveDirX = dx / moveLen, moveDirY = dy / moveLen,
        reversed = p.flickDirX || p.flickDirY
          ? moveDirX * p.flickDirX + moveDirY * p.flickDirY < -0.12
          : false,
        continuousRearm =
          !p.flickReady && now - p.lastFlickAt >= FLICK_REARM_MS &&
          travel >= needTravel * FLICK_REARM_TRAVEL_GAIN;
      if (!p.flickReady && (p.speed < needSpeed * 0.38 || reversed || continuousRearm)) {
        p.flickReady = true;
        p.startX = p.x; p.startY = p.y; p.startT = now;
      }
      if (
        p.flickReady && now - p.lastFlickAt > 36 &&
        (p.speed >= needSpeed || (travel >= needTravel && elapsed <= 280))
      ) {
        this.armFlickAlongPath(pid, p.x, p.y, eventAudioTime, prevX, prevY);
        p.lastFlickAt = now;
        p.flickReady = false;
        const dirLen = Math.max(0.0001, Math.hypot(travelX, travelY));
        p.flickDirX = travelX / dirLen;
        p.flickDirY = travelY / dirLen;
        p.startX = p.x; p.startY = p.y; p.startT = now;
      }
    }
    touchMove(e) {
      if (!this.useNativeTouchInput || !this.running || this.paused ||
          this.starting || this.resumePending || this.autoplay) return;
      const changed = e.changedTouches, seen = this.nativeTouchChangedIds;
      seen.clear();
      let tracked = false;
      const eventAudioTime = this.eventAudioTime(e),
        now = this.eventPerformanceTime(e);
      for (let i = 0; i < (changed?.length || 0); i++) {
        const touch = changed[i], pid = this.touchPointerId(touch);
        seen.add(pid);
        let p = this.pointer.get(pid), recovered = false;
        if (!p && !this.nativeTouchBlocked.has(pid) && this.touchInsidePlayfield(touch)) {
          if (touch.target instanceof Element && touch.target.closest("button,input,select,textarea,a,[contenteditable='true']")) {
            this.nativeTouchBlocked.add(pid);
            continue;
          }
          p = this.adoptNativeTouch(touch, e.timeStamp, true);
          this.pointer.set(pid, p);
          recovered = !p.downJudged;
        }
        if (!p) continue;
        tracked = true;
        this.processNativeTouchMotion(touch, p, eventAudioTime, now, recovered);
      }
      // WebKit may omit one moving finger from changedTouches during a chord.
      // The full touches snapshot still carries its latest independent position.
      const live = e.touches;
      for (let i = 0; i < (live?.length || 0); i++) {
        const touch = live[i], pid = this.touchPointerId(touch);
        if (seen.has(pid) || this.nativeTouchBlocked.has(pid)) continue;
        const p = this.pointer.get(pid);
        if (!p || (p.active !== false && !p.cancelled && Math.abs(touch.clientX - this.inputRect.left - this.viewX - p.x * this.viewScale) < 0.25 &&
                   Math.abs(touch.clientY - this.inputRect.top - this.viewY - p.y * this.viewScale) < 0.25)) continue;
        tracked = true;
        this.processNativeTouchMotion(touch, p, eventAudioTime, now);
      }
      this.recoverNativeTouchSnapshot(e, {
        synthesizeMissingDown: true, reconcileMissing: true, reviveLive: true, motion: true,
      });
      if (!this.nativeTouchMovePassive && (tracked || this.pointer.size) && e.cancelable) e.preventDefault();
    }
    touchEnd(e) {
      if (!this.useNativeTouchInput) return;
      const changed = e.changedTouches;
      const ended=this.nativeTouchEndedAt||=(new Map());
      for(let i=0;i<(changed?.length||0);i++){const pid=this.touchPointerId(changed[i]);ended.set(pid,Math.max(ended.get(pid)||0,this.eventPerformanceTime(e)));}
      while(ended.size>128)ended.delete(ended.keys().next().value);
      // event.touches excludes fingers that truly ended. Reconcile from it first so
      // even a missing changedTouches identifier cannot leave a stale active state.
      this.recoverNativeTouchSnapshot(e, {
        synthesizeMissingDown: false,
        reconcileMissing: true,
        reviveLive: true,
      });
      if (!changed?.length) return;
      const now = performance.now() / 1000;
      for (let i = 0; i < changed.length; i++) {
        const pid = this.touchPointerId(changed[i]), p = this.pointer.get(pid);
        this.nativeTouchBlocked.delete(pid);
        // Normal changedTouches still gets an explicit release if the snapshot was
        // incomplete/non-standard. The helper is idempotent after reconciliation.
        if (p&&p.downT<=this.eventPerformanceTime(e)+.001) this.releaseNativeTouchContact(pid, p, now, this.eventPerformanceTime(e));
      }
    }
    touchCancel(e) {
      if (!this.useNativeTouchInput) return;
      const changed = e.changedTouches;
      if (!changed?.length) return;
      const now = performance.now() / 1000,
        grace = MULTITOUCH_CANCEL_GRACE * clamp(touchSensitivity, 0.9, 1.35);
      // Safari may cancel one contact while the physical finger is still down when
      // another finger lands/leaves or a proprietary gesture recognizer briefly
      // takes arbitration. Treat cancel differently from a real touchend: retain
      // only that finger's last coordinate for a short, bounded rebind window.
      // A matching newly-issued Touch identifier can then take ownership of the
      // same Hold; an actual lift still uses touchEnd() and releases immediately.
      for (let i = 0; i < changed.length; i++) {
        const pid = this.touchPointerId(changed[i]), p = this.pointer.get(pid);
        this.nativeTouchBlocked.delete(pid);
        if (!p) continue;
        p.active = false;
        p.cancelled = true;
        p.ghostUntil = now + grace;
      }
      this.recoverNativeTouchSnapshot(e, {
        synthesizeMissingDown: false,
        reconcileMissing: false,
        reviveLive: true,
      });
    }
    pointerDown(e) {
      if (
        !this.running ||
        this.paused ||
        this.starting ||
        this.resumePending ||
        this.autoplay
      )
        return;
      const target = e.target instanceof Element ? e.target : null;
      if (!this.eventInsidePlayfield(e) || target?.closest("button,input,select,textarea,a,[contenteditable='true']")) return;
      if (this.inputStats) this.inputStats.pointerDown++;
      const nativeBridge = this.useNativeTouchInput && e.pointerType === "touch";
      if (nativeBridge) {
        const linked=this.nativePointerLinks?.get(e.pointerId),old=this.pointer.get(linked);
        if(old&&Math.abs(this.eventPerformanceTime(e)-old.downT)<=.08)return;
        if(linked!=null){this.nativePointerLinks.delete(e.pointerId);if(old?.pointerAlias===e.pointerId)old.pointerAlias=null;}
        const receipt=this.matchDownReceipt(false,e.pointerId,e.clientX,e.clientY,this.eventPerformanceTime(e));
        if(receipt?.ended)return;
        const p = receipt ? this.pointer.get(receipt.touchId) : null;
        if (p) {
          p.downT=receipt.at;
          p.pointerAlias = e.pointerId;
          (this.nativePointerLinks ||= new Map()).set(e.pointerId,p.id);
          if (this.inputStats) this.inputStats.bridges++;
          return;
        }
        if(receipt)return;
      } else if (e.cancelable) e.preventDefault();
      const previous=this.pointer.get(e.pointerId);
      if(previous){
        if(Math.abs(this.eventPerformanceTime(e)-previous.downT)<=.08)return;
        this.pointer.delete(e.pointerId);this.releasePointerState(previous,this.eventPerformanceTime(e)-.001);
      }
      try {
        if (!nativeBridge) this.canvas.setPointerCapture?.(e.pointerId);
      } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      const p = this.acquirePointerState(e);
      this.pointer.set(e.pointerId, p);
      const eventAudioTime = this.eventAudioTime(e);
      this.judgeContactDown(p,eventAudioTime);
    }
    pointerMove(e) {
      // Once the native contact takes over, only TouchEvent drives its motion.
      // Until then a real pointerdown remains a complete independent fallback.
      if (this.useNativeTouchInput && e.pointerType === "touch" && !this.pointer.has(e.pointerId)) return;
      if (
        !this.running ||
        this.paused ||
        this.starting ||
        this.resumePending ||
        this.autoplay
      )
        return;
      let p = this.pointer.get(e.pointerId);
      if (!p && ((e.buttons | 0) !== 0 || e.pointerType === "touch")) {
        const target=e.target instanceof Element?e.target:null;
        if(!this.eventInsidePlayfield(e)||target?.closest("button,input,select,textarea,a,[contenteditable='true']"))return;
        p = this.acquirePointerState(e);
        this.pointer.set(e.pointerId, p);
        this.judgeContactDown(p,this.eventAudioTime(e),true);
      }
      if (!p) return;
      p.active = true;
      p.cancelled = false;
      p.ghostUntil = 0;
      let all = e.getCoalescedEvents?.();
      if (!all?.length) {
        this.singlePointerEvent[0] = e;
        all = this.singlePointerEvent;
      }
      const q = this.pointScratchA;
      for (let si = 0; si < all.length; si++) {
        const ev = all[si];
        this.eventPoint(ev, q);
        const now = this.eventPerformanceTime(ev),
          prevX = p.lastX,
          prevY = p.lastY;
        if(now<p.lastT-0.01)continue;
        // pointerrawupdate + pointermove may expose the same physical sample. Do
        // not let an exact duplicate collapse flick speed or re-arm state.
        if (
          Math.abs(now - p.lastT) <= POINTER_DUPLICATE_EPS_MS &&
          Math.abs(q.x - prevX) <= POINTER_DUPLICATE_EPS_PX &&
          Math.abs(q.y - prevY) <= POINTER_DUPLICATE_EPS_PX
        ) continue;
        const dt = Math.max(0.5, now - p.lastT),
          dx = q.x - prevX,
          dy = q.y - prevY,
          step = Math.hypot(dx, dy),
          instantSpeed = (step / dt) * 1000,
          eventAudioTime = this.eventAudioTime(ev);
        p.speed = Math.max(p.speed * 0.34, instantSpeed);
        p.lastX = p.x = q.x;
        p.lastY = p.y = q.y;
        p.lastT = now;
        // Drag acquisition happens on input samples as well as the render/update
        // loop. This prevents dense multi-touch frames from skipping a yellow
        // note between two 120-Hz judgement scans.
        this.armDragAlongPath(e.pointerId, p.x, p.y, eventAudioTime, prevX, prevY);
        const travelX = q.x - p.startX,
          travelY = q.y - p.startY,
          travel = Math.hypot(travelX, travelY),
          elapsed = now - p.startT,
          needSpeed = FLICK_SPEED / clamp(touchSensitivity, 0.85, 1.8),
          needTravel = FLICK_TRAVEL / clamp(touchSensitivity, 0.9, 1.55),
          moveLen = Math.max(0.0001, step),
          moveDirX = dx / moveLen,
          moveDirY = dy / moveLen,
          reversed =
            p.flickDirX || p.flickDirY
              ? moveDirX * p.flickDirX + moveDirY * p.flickDirY < -0.12
              : false;
        // One finger moving continuously in one direction may judge only one
        // Flick. It rearms after slowing down or reversing direction, matching
        // the observable official left-right streaming behavior.
        const continuousRearm =
          !p.flickReady &&
          now - p.lastFlickAt >= FLICK_REARM_MS &&
          travel >= needTravel * FLICK_REARM_TRAVEL_GAIN;
        if (!p.flickReady && (p.speed < needSpeed * 0.38 || reversed || continuousRearm)) {
          p.flickReady = true;
          p.startX = p.x;
          p.startY = p.y;
          p.startT = now;
        }
        if (
          p.flickReady &&
          now - p.lastFlickAt > 36 &&
          (p.speed >= needSpeed || (travel >= needTravel && elapsed <= 280))
        ) {
          this.armFlickAlongPath(e.pointerId, p.x, p.y, eventAudioTime, prevX, prevY);
          p.lastFlickAt = now;
          p.flickReady = false;
          const dirLen = Math.max(0.0001, Math.hypot(travelX, travelY));
          p.flickDirX = travelX / dirLen;
          p.flickDirY = travelY / dirLen;
          p.startX = p.x;
          p.startY = p.y;
          p.startT = now;
        }
      }
    }
    pointerUp(e) {
      if (this.useNativeTouchInput && e.pointerType === "touch") {
        const pid = this.nativePointerLinks?.get(e.pointerId);
        if (pid != null) {
          this.releaseNativeTouchContact(pid,this.pointer.get(pid),undefined,this.eventPerformanceTime(e));
          this.nativePointerLinks.delete(e.pointerId);
          return;
        }
      }
      if (this.autoplay) {
        const discarded = this.pointer.get(e.pointerId);
        this.pointer.delete(e.pointerId);
        this.releasePointerState(discarded);
        return;
      }
      const p = this.pointer.get(e.pointerId);
      if (p) {
        const now = performance.now() / 1000;
        for (const item of this.activeHolds)
          if (item.n.holdPointer === e.pointerId) item.n.releaseAt = now;
        this.pointer.delete(e.pointerId);
        this.releasePointerState(p,this.eventPerformanceTime(e));
      }
      try {
        this.canvas.releasePointerCapture?.(e.pointerId);
      } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
    }
    pointerCancel(e) {
      if (this.useNativeTouchInput && e.pointerType === "touch" && !this.pointer.has(e.pointerId)) return;
      const p = this.pointer.get(e.pointerId);
      if (!p) return;
      const now = performance.now() / 1000;
      for (const item of this.activeHolds)
        if (item.n.holdPointer === e.pointerId) item.n.releaseAt = now;
      // iPadOS can emit a transient pointercancel while several fingers are
      // already down. Retain the last coordinate briefly so Hold/Drag judgement
      // does not collapse during that browser-level interruption; a real pointerup
      // still releases immediately. Any resumed move reactivates this state.
      p.active = false;
      p.cancelled = true;
      p.ghostUntil = now + MULTITOUCH_CANCEL_GRACE * clamp(touchSensitivity, 0.9, 1.35);
      try { this.canvas.releasePointerCapture?.(e.pointerId); } catch {}
    }
    eventInsidePlayfield(e) {
      const r = this.inputRect,
        x = e.clientX - r.left,
        y = e.clientY - r.top;
      return (
        x >= 0 && x <= (this.surfaceW || this.w * this.viewScale) &&
        y >= 0 && y <= (this.surfaceH || this.h * this.viewScale)
      );
    }
    eventPerformanceTime(e) {
      const now = performance.now();
      let value = typeof e === "number" ? e : Number(e?.timeStamp);
      if (value > 1e12) value -= Number(performance.timeOrigin) || Date.now() - now;
      return Number.isFinite(value) && value > 0 && value <= now + 50 ? Math.min(value,now) : now;
    }
    eventAudioTime(e) {
      const at=this.eventPerformanceTime(e),now=performance.now();
      let elapsed=now-at;
      if (this.inputStats) this.inputStats.maxDispatchMs = Math.max(this.inputStats.maxDispatchMs,elapsed);
      // A buffered second is not a second of music. Subtract only wall time
      // during which the transport actually advanced after this input sample.
      for(const interval of this.inputClockPauses||[])elapsed-=Math.max(0,Math.min(now,interval.end)-Math.max(at,interval.start));
      return this.time - Math.max(0,elapsed)/1000 * (Number(this.musicRate) || 1);
    }
    inputCapturedWhileBuffered(at) {
      return Number.isFinite(at)&&(this.inputClockPauses||[]).some(interval=>at>=interval.start&&at<interval.end);
    }
    eventPoint(e, out = null) {
      const r = this.inputRect,
        target = out || {},
        inv = 1 / Math.max(0.0001, this.viewScale);
      target.x = (e.clientX - r.left - this.viewX) * inv;
      target.y = (e.clientY - r.top - this.viewY) * inv;
      return target;
    }
    acquirePointerState(e) {
      const p = this.pointerPool.pop() || {},
        now = this.eventPerformanceTime(e);
      this.eventPoint(e, p);
      p.id = e.pointerId;
      p.nativeTouch = false;
      p.touchPointer = e.pointerType === "touch";
      p.pointerAlias = null;
      p.downJudged = false;
      p.downReceipt = null;
      p.downT = now;
      p.downClientX = e.clientX; p.downClientY = e.clientY;
      p.noiseBlocked = false;
      p.cancelled = false;
      p.active = true;
      p.ghostUntil = 0;
      p.lastX = p.startX = p.x;
      p.lastY = p.startY = p.y;
      p.lastT = p.startT = now;
      p.speed = 0;
      p.flickReady = true;
      p.flickDirX = 0;
      p.flickDirY = 0;
      p.lastFlickAt = 0;
      return p;
    }
    releasePointerState(p, endedAt = performance.now()) {
      if (!p) return;
      if(p.downReceipt){p.downReceipt.ended=true;p.downReceipt.endAt=Math.min(p.downReceipt.endAt,endedAt);}
      if (p.pointerAlias != null) this.nativePointerLinks?.delete(p.pointerAlias);
      p.pointerAlias = null;
      p.active = false;
      p.cancelled = false;
      p.nativeTouch = false;
      p.noiseBlocked = false;
      p.id = null;
      if (this.pointerPool.length < 16) this.pointerPool.push(p);
    }
    clearPointerStates() {
      for (const p of this.pointer.values()) this.releasePointerState(p);
      this.pointer.clear();
      this.nativeTouchBlocked?.clear();
      this.nativeTouchLiveIds?.clear();
      this.nativeTouchChangedIds?.clear();
      this.nativePointerLinks?.clear();
      if(this.inputDownReceipts)this.inputDownReceipts.length=0;
      this.nativeTouchSnapshotTime=0;
      this.nativeTouchEndedAt?.clear();
    }
    findCandidateMask(
      typeMask, x, y, out = this.candidateScratch, eventAudioTime = NaN,
      fromX = NaN, fromY = NaN, allowBuffered = false,
    ) {
      if(this.streamBuffering&&!allowBuffered)return null;
      const blockT=Number.isFinite(eventAudioTime)?eventAudioTime:this.time;
      if(nativeBlockTouchBlocked(this,x,y,blockT))return null;
      if(Number.isFinite(fromX)&&nativeBlockTouchBlocked(this,fromX,fromY,blockT)){fromX=NaN;fromY=NaN;}
      const audioT = Number.isFinite(eventAudioTime) ? eventAudioTime : this.time,
        visualT = Number.isFinite(eventAudioTime) ? eventAudioTime : (Number.isFinite(this.currentVisualTime) ? this.currentVisualTime : audioT),
        t =
          audioT +
          judgeTimingLead +
          clamp((Number(this.clockDrift) || 0) * 0.28, -0.012, 0.012),
        span = Math.max(BAD, DRAG_LATE_WINDOW, FLICK_ARM_EARLY, FLICK_ARM_LATE) + Math.max(0.18, specialJudgeDelay + 0.08),
        lo = lowerBoundNumeric(this.noteTimes, audioT - span),
        hi = lowerBoundNumeric(this.noteTimes, audioT + span);
      const earliestTapHold = (typeMask & ~((1 << 1) | (1 << 3))) === 0;
      this.metricsCandidates = hi - lo;
      let bestItem = null,
        bestScore = Infinity,
        bestTarget = Infinity,
        bestDt = 0,
        bestDx = 0,
        bestSigned = 0,
        bestVisualSigned = 0;
      for (let i = lo; i < hi; i++) {
        const item = this.noteItems[i],
          L = item.L,
          n = item.n;
        if (n.fake || n.state !== 0 || !(typeMask & (1 << n.type))) continue;
        const target = this.manualTargetTime(n),
          signed = t - target,
          visualSigned = audioT - target,
          dt = Math.abs(signed);
        if (n.type === 4) {
          if (signed < -FLICK_ARM_EARLY || signed > FLICK_ARM_LATE)
            continue;
        } else if (n.type === 1) {
          if (dt > BAD) continue;
        } else if (n.type === 3) {
          // Hold starts can be Perfect/Good/Miss, never Bad.
          if (dt > GOOD) continue;
        } else if (n.type === 2) {
          if (dt > DRAG_LATE_WINDOW) continue;
        } else if (dt > BAD) continue;
        let dx;
        if (this.chart.kind === "pjsk") {
          const stage = pjskStageGeometry(this), lane = clamp(Number(n._pjskLane) || 0, 0, stage.lanes - 1),
            targetX = pjskPoint(stage, lane, 1).x;
          dx = Math.abs(x - targetX);
          if (Number.isFinite(fromX)) {
            const minX = Math.min(fromX, x), maxX = Math.max(fromX, x);
            dx = targetX >= minX && targetX <= maxX ? 0 : Math.min(dx, Math.abs(fromX - targetX));
          }
        } else {
          const ls = this.lineScreen(L, visualT),
            along = Number.isFinite(n._along) ? n._along : n.x * this.w * 0.50625,
            touchAlong = (x - ls.cx) * ls.ux + (y - ls.cy) * ls.uy;
          dx = Math.abs(touchAlong - along);
          if (Number.isFinite(fromX) && Number.isFinite(fromY)) {
            const fromAlong = (fromX - ls.cx) * ls.ux + (fromY - ls.cy) * ls.uy,
              minAlong = Math.min(fromAlong, touchAlong),
              maxAlong = Math.max(fromAlong, touchAlong);
            dx = along >= minAlong && along <= maxAlong
              ? 0
              : Math.min(dx, Math.abs(fromAlong - along));
          }
        }
        const radius = this.judgeHalfWidth(n);
        if (dx > radius) continue;
        const timeScore = Math.abs(visualSigned),
          score = timeScore + dx / Math.max(1, this.w);
        if (
          earliestTapHold
            ? target < bestTarget - 0.0005 ||
              (Math.abs(target - bestTarget) <= 0.0005 && score < bestScore)
            : score < bestScore
        ) {
          bestTarget = target;
          bestScore = score;
          bestItem = item;
          bestDt = dt;
          bestDx = dx;
          bestSigned = signed;
          bestVisualSigned = visualSigned;
        }
      }
      if (!bestItem) return null;
      out.L = bestItem.L;
      out.n = bestItem.n;
      out.dt = bestDt;
      out.d = bestDx;
      out.t = t;
      out.target = bestTarget;
      out.signed = bestSigned;
      out.visualT = visualT;
      out.visualSigned = bestVisualSigned;
      return out;
    }
    tapProtectedByEarlierSpecial(tapCandidate, x, y) {
      const tap = tapCandidate?.n;
      // Protect a following Tap only from an *early Bad* press intended for a
      // closer Drag/Flick. Never veto an otherwise valid Perfect/Good Tap.
      if (!tap || tap.type !== 1 || tapCandidate.signed >= -GOOD) return false;
      const visualT = tapCandidate.visualT,
        t = tapCandidate.t,
        span = Math.max(BAD, DRAG_LATE_WINDOW, FLICK_ARM_EARLY, FLICK_ARM_LATE) + Math.max(0.18, specialJudgeDelay + 0.08),
        lo = lowerBoundNumeric(this.noteTimes, visualT - span),
        hi = lowerBoundNumeric(this.noteTimes, visualT + span);
      for (let i = lo; i < hi; i++) {
        const item = this.noteItems[i],
          L = item.L,
          n = item.n;
        if (n.fake || n.state !== 0 || (n.type !== 2 && n.type !== 4)) continue;
        const authoredGap = tap.time - n.time;
        if (
          authoredGap <= SPECIAL_TAP_SAME_TIME_EPS ||
          authoredGap > SPECIAL_TAP_PROTECT_GAP
        )
          continue;
        const target = this.manualTargetTime(n),
          signed = t - target,
          visualSigned = visualT - target;
        if (Math.abs(signed) >= Math.abs(tapCandidate.signed)) continue;
        if (n.type === 4) {
          if (signed < -FLICK_ARM_EARLY || signed > FLICK_ARM_LATE)
            continue;
        } else if (Math.abs(signed) > DRAG_LATE_WINDOW) continue;
        if (this.touchCoordinatesMatchNote(L, n, x, y, visualT)) return true;
      }
      return false;
    }
    tryTap(pid, x, y, eventAudioTime = NaN) {
      const stats = this.inputStats;
      if (stats) stats.edges++;
      const contact=this.pointer?.get(pid),capturedAt=contact?.downReceipt?.at??contact?.downT,
        frozenCapture=this.inputCapturedWhileBuffered(capturedAt),historical=this.streamBuffering&&Number.isFinite(capturedAt)&&!frozenCapture;
      if(frozenCapture||(this.streamBuffering&&!historical)){if(stats)stats.buffered=(stats.buffered||0)+1;return;}
      if(nativeBlockTouchBlocked(this,x,y,Number.isFinite(eventAudioTime)?eventAudioTime:this.time,pid)){if(stats)stats.blocked++;return;}
      if(this.chart.kind === "pjsk")return pjskInput(this,"tap",x,y,eventAudioTime,NaN,NaN,pid);
      let c = this.findCandidateMask((1 << 1) | (1 << 3), x, y, this.candidateScratch, eventAudioTime,NaN,NaN,historical);
      if (!c) { if (stats) stats.noCandidate++; return; }
      if (c.n.type === 1 && this.tapProtectedByEarlierSpecial(c, x, y)) {
        if (stats) stats.earlyGuard++;
        c = this.findCandidateMask(1 << 3, x, y, this.candidateScratch, eventAudioTime,NaN,NaN,historical);
        if (!c) return;
      }
      if (stats) stats.accepted++;
      const diff = c.t - c.target;
      if (c.n.type === 3) {
        c.n.state = 2;
        c.n.holdPointer = pid;
        c.n.releaseAt = Infinity;
        c.n.judge = Math.abs(diff) <= PERFECT ? "perfect" : "good";
        c.n.holdHeadDiff = diff;
        c.n.holdFxAt = this.time + (this.chart.kind === "pjsk" ? PJSK_HOLD_FX_INTERVAL : HOLD_HIT_FX_INTERVAL);
        this.activeHolds.add(c.n._item);
        this.pendingJudge.delete(c.n._item);
        this.playSound("click", null, c.n);
        this.hitEffect(c.L, c.n, c.n.judge === "good" ? 1 : 0);
      } else {
        const j =
          Math.abs(diff) <= PERFECT ? 0 : diff >= -GOOD && diff <= GOOD ? 1 : 2;
        this.commit(c.n, j, diff, c.L);
      }
    }
    tryArmDrag(pid, x, y, eventAudioTime = NaN, fromX = NaN, fromY = NaN) {
      if(this.streamBuffering)return false;
      if(nativeBlockTouchBlocked(this,x,y,Number.isFinite(eventAudioTime)?eventAudioTime:this.time,pid))return false;
      if(this.chart.kind === "pjsk")return false;
      const c = this.findCandidateMask(
        1 << 2, x, y, this.candidateScratch, eventAudioTime, fromX, fromY,
      );
      if (!c) return false;
      const earlyWindow = DRAG_PREARM_EARLY * clamp(touchSensitivity, 0.9, 1.35);
      if (c.signed < -earlyWindow || c.signed > DRAG_LATE_WINDOW) return false;
      c.n.dragArmed = true;
      c.n.dragPointer = pid;
      c.n.dragArmUntil =
        performance.now() / 1000 + DRAG_ARM_GRACE * clamp(touchSensitivity, 0.9, 1.45);
      this.pendingJudge.add(c.n._item);
      if (c.t >= c.target) {
        this.commit(c.n, 0, c.t - c.target, c.L);
        this.pendingJudge.delete(c.n._item);
      }
      return true;
    }
    tryFlick(pid, x, y, eventAudioTime = NaN, fromX = NaN, fromY = NaN) {
      if(this.streamBuffering)return false;
      if(nativeBlockTouchBlocked(this,x,y,Number.isFinite(eventAudioTime)?eventAudioTime:this.time,pid))return false;
      if(this.chart.kind === "pjsk")return pjskInput(this,"flick",x,y,eventAudioTime,fromX,fromY,pid);
      const c = this.findCandidateMask(
        1 << 4, x, y, this.candidateScratch, eventAudioTime, fromX, fromY,
      );
      if (!c) return false;
      if (c.t >= c.target) {
        this.commit(c.n, 0, c.t - c.target, c.L);
        return true;
      }
      c.n.flickArmed = true;
      c.n.flickArmAt = c.visualT;
      c.n.flickPointer = pid;
      this.pendingJudge.add(c.n._item);
      return true;
    }

    keyboardCandidateMask(typeMask, dueOnly = false, out = this.keyboardCandidateScratch) {
      if(this.streamBuffering)return null;
      const visualT = this.time,
        t = visualT + judgeTimingLead + clamp((Number(this.clockDrift) || 0) * 0.28, -0.012, 0.012),
        span = Math.max(BAD, DRAG_LATE_WINDOW, FLICK_ARM_EARLY, FLICK_ARM_LATE) + Math.max(0.18, specialJudgeDelay + 0.08),
        lo = lowerBoundNumeric(this.noteTimes, visualT - span),
        hi = lowerBoundNumeric(this.noteTimes, visualT + span);
      const earliestTapHold = (typeMask & ~((1 << 1) | (1 << 3))) === 0;
      this.metricsCandidates = hi - lo;
      let bestItem = null, bestScore = Infinity, bestTarget = Infinity,
        bestSigned = 0, bestVisualSigned = 0, bestDt = 0;
      for (let i = lo; i < hi; i++) {
        const item = this.noteItems[i], L = item.L, n = item.n;
        if (n.fake || n.state !== 0 || !(typeMask & (1 << n.type))) continue;
        const target = this.manualTargetTime(n), signed = t - target,
          visualSigned = visualT - target, dt = Math.abs(signed);
        if (dueOnly && signed < -0.0005) continue;
        if (n.type === 4) {
          if (signed < -FLICK_ARM_EARLY || signed > FLICK_ARM_LATE) continue;
        } else if (n.type === 1) {
          if (dt > BAD) continue;
        } else if (n.type === 3) {
          if (dt > GOOD) continue;
        } else if (n.type === 2) {
          if (dt > DRAG_LATE_WINDOW) continue;
        } else if (dt > BAD) continue;
        const score = Math.abs(visualSigned);
        if (earliestTapHold
          ? (target < bestTarget - 0.0005 || (Math.abs(target - bestTarget) <= 0.0005 && score < bestScore))
          : score < bestScore) {
          bestTarget = target;
          bestScore = score;
          bestItem = item;
          bestSigned = signed;
          bestVisualSigned = visualSigned;
          bestDt = dt;
        }
      }
      if (!bestItem) return null;
      out.L = bestItem.L;
      out.n = bestItem.n;
      out.t = t;
      out.target = bestTarget;
      out.signed = bestSigned;
      out.visualT = visualT;
      out.visualSigned = bestVisualSigned;
      out.dt = bestDt;
      return out;
    }
    keyboardDown(code) {
      if(this.streamBuffering)return;
      if(this.chart.kind === "pjsk"){
        const k=SEKAI_KEYS.indexOf(code),f=SEKAI_FLICK_KEYS.indexOf(code);if(k<0&&f<0)return;
        this.usedKeyboard=true;const s=pjskStageGeometry(this),x=s.cx-s.bottomHalf+((k>=0?k:f)+.5)*s.bottomHalf*2/6;
        if(f>=0)pjskInput(this,"tap",x,s.judgeY,this.time);
        return pjskInput(this,f>=0?"flick":"tap",x,s.judgeY,this.time);
      }
      if (this.autoplay) return;
      this.usedKeyboard = true;
      syncAssistIndicators(this);
      const candidate = this.keyboardCandidateMask((1 << 1) | (1 << 3));
      if (candidate) {
        const diff = candidate.t - candidate.target;
        if (candidate.n.type === 3) {
          candidate.n.state = 2;
          candidate.n.holdPointer = "keyboard";
          candidate.n.releaseAt = Infinity;
          candidate.n.judge = Math.abs(diff) <= PERFECT ? "perfect" : "good";
          candidate.n.holdHeadDiff = diff;
          candidate.n.holdFxAt = this.time + (this.chart.kind === "pjsk" ? PJSK_HOLD_FX_INTERVAL : HOLD_HIT_FX_INTERVAL);
          this.activeHolds.add(candidate.n._item);
          this.pendingJudge.delete(candidate.n._item);
          this.playSound("click", null, candidate.n);
          this.hitEffect(candidate.L, candidate.n, candidate.n.judge === "good" ? 1 : 0);
        } else {
          const judgement = Math.abs(diff) <= PERFECT ? 0 : diff >= -GOOD && diff <= GOOD ? 1 : 2;
          this.commit(candidate.n, judgement, diff, candidate.L);
        }
      }
      // A held keyboard state behaves like a continuous full-area contact:
      // yellow Drag and red Flick are consumed as they reach their line.
      this.keyboardContinuous(this.time);
    }
    keyboardUp() {
      if (!keyboardInput?.hasGameplayKey()) this.keyboardAllReleased(performance.now() / 1000);
    }
    keyboardAllReleased(now = performance.now() / 1000) {
      for (const item of this.activeHolds) {
        if (item.n.holdPointer === "keyboard" && !Number.isFinite(item.n.releaseAt)) item.n.releaseAt = now;
      }
    }
    keyboardContinuous() {
      if(this.chart.kind === "pjsk")return;
      if (!keyboardInput?.hasGameplayKey()) return;
      // Consume all due Drag/Flick notes, including simultaneous notes, without
      // creating per-key bindings or scanning the full chart.
      for (let guard = 0; guard < 32; guard++) {
        const candidate = this.keyboardCandidateMask((1 << 2) | (1 << 4), true);
        if (!candidate) break;
        this.commit(candidate.n, 0, candidate.visualT - candidate.target, candidate.L);
      }
    }

    playSound(k, when = null, note = null) {
      const customName = String(note?.hitsound || "").trim(),
        standard = /^(?:tap|click|drag|flick)\.(?:mp3|ogg|wav)$/i;
      if (customName && !standard.test(basename(customName))) {
        const buffer = this.customHitSounds.get(archivePathKey(customName)) || this.customHitSounds.get(basename(customName).toLowerCase());
        if (buffer) {
          try {
            const ac = Engine.sharedAudioContext(), output = Engine.hitSoundOutput(),
              targetVolume = clamp(Number(hitSoundVolume) || 0, 0, HIT_SOUND_MAX) * HIT_SOUND_OUTPUT_TRIM,
              startAt = Number.isFinite(when) ? Math.max(when, ac.currentTime) : ac.currentTime;
            if (Engine._hitVolume !== targetVolume) {
              output.gain.value = targetVolume;
              Engine._hitVolume = targetVolume;
            }
            if (Engine._hitMixer?.context === ac)
              return Engine._hitMixer.play(buffer, startAt);
            const source = ac.createBufferSource();
            source.buffer = buffer;
            source.connect(output);
            source.start(startAt);
            return source;
          } catch (error) { Diagnostics.warn("AudioEngine.customHit", error?.message || String(error)); }
        }
      }
      return playPackHitSound(this.pack, k, hitSoundVolume, when);
    }
    commit(n, j, diff, L) {
      if (n.state === 1) return;
      const actualJudge = j,
        holdTail = n.type === 3 && n.state === 2;
      if (!this.invincibleMode && j === 2 && n.type === 1 && diff < 0) this.spawnBadGhost(L, n);
      n.flickArmed = false;
      n.flickPointer = null;
      n.dragArmed = false;
      n.dragPointer = null;
      n.dragArmUntil = -Infinity;
      n.state = 1;
      n.judge = JUDGE_NAMES[actualJudge];
      n.resultAt = this.time;
      n.holdMiss = !this.invincibleMode && n.type === 3 && actualJudge >= 2;
      this.pendingJudge.delete(n._item);
      this.activeHolds.delete(n._item);
      this.actualCounts[actualJudge]++;
      if (actualJudge <= 1) { this.actualCombo++; this.actualMaxCombo = Math.max(this.actualMaxCombo, this.actualCombo); } else this.actualCombo = 0;
      if (this.invincibleMode) {
        this.usedInvincible = true;
        this.triggerInvincibleFeedback(actualJudge);
        this.counts[0]++;
        this.combo++;
        this.maxCombo = Math.max(this.maxCombo, this.combo);
        if (actualJudge <= 1 && !holdTail) {
          this.hitEffect(L, n, actualJudge);
          if (!(this.autoplay && n.autoSoundScheduled))
            this.playSound(n.type === 4 ? "flick" : n.type === 2 ? "drag" : "click", null, n);
        }
        return;
      }
      this.counts[actualJudge]++;
      if (actualJudge === 1 && Number.isFinite(diff)) this.earlyLate[diff < 0 ? 0 : 1]++;
      if (actualJudge <= 1) {
        this.combo++;
        this.maxCombo = Math.max(this.maxCombo, this.combo);
        if (!holdTail) {
          this.hitEffect(L, n, actualJudge);
          if (!(this.autoplay && n.autoSoundScheduled))
            this.playSound(n.type === 4 ? "flick" : n.type === 2 ? "drag" : "click", null, n);
        }
      } else this.combo = 0;
    }
    spawnBadGhost(L, n) {
      const geometryAt = Number.isFinite(this.currentVisualTime) ? this.currentVisualTime : this.time,
        p = this.notePoint(L, n, geometryAt),
        scale = clamp(Number(n.size || 1), 0.05, 8),
        nw =
          (this.noteWidth || Math.min(this.w, (this.h * 16) / 9) * (this.chart.kind === "pjsk" ? 0.065 : 0.15625)) *
          scale *
          noteSizeScale * this.packageNoteScale,
        nh = Math.max(3, nw * NOTE_THICKNESS_RATIO),
        imgKey = this.pack?.images?.tap
          ? "tap"
          : this.pack?.images?.click
            ? "click"
            : null;
      this.badGhosts.push({
        x: p.x,
        y: p.y,
        rot: p.line.screenRot,
        above: n.above,
        nw,
        nh,
        imgKey,
        at: performance.now(),
        duration: BAD_GHOST_TIME,
      });
    }
    drawBadGhost(c, e, frameNow) {
      const age = (frameNow - e.at) / 1000,
        u = clamp(age / (e.duration || BAD_GHOST_TIME), 0, 1),
        alpha = 1 - u;
      if (alpha <= 0.001) return;
      const img = e.imgKey ? this.pack?.images?.[e.imgKey] : null,
        b = e.imgKey ? this.pack?.imageBounds?.[e.imgKey] : null,
        dh = img
          ? normalizedTextureHeight(this.pack, e.imgKey, "tap", e.nh, e.nw)
          : e.nh;
      c.save();
      c.globalAlpha = alpha;
      c.translate(e.x, e.y);
      c.rotate((e.rot * Math.PI) / 180);
      if (!e.above) c.scale(1, -1);
      if (img) {
        if (b) {
          const sx = Math.max(0, Math.floor(Number(b.sx) || 0)),
            sy = Math.max(0, Math.floor(Number(b.sy) || 0)),
            ex = Math.min(img.naturalWidth || img.width, Math.ceil((Number(b.sx) || 0) + (Number(b.sw) || 0))),
            ey = Math.min(img.naturalHeight || img.height, Math.ceil((Number(b.sy) || 0) + (Number(b.sh) || 0)));
          c.drawImage(
            img,
            sx,
            sy,
            Math.max(1, ex - sx),
            Math.max(1, ey - sy),
            -e.nw / 2,
            -dh / 2,
            e.nw,
            dh,
          );
        } else c.drawImage(img, -e.nw / 2, -dh / 2, e.nw, dh);
        c.globalCompositeOperation = "source-atop";
        c.fillStyle = "rgb(108,67,67)";
        c.fillRect(-e.nw / 2, -dh / 2, e.nw, dh);
      } else drawDefaultBar(c, e.nw, e.nh, "#6c4343", "#8b5555");
      c.restore();
    }
    prewarmHitFeedback() {
      // Every burst variant is fully randomized before the countdown. Gameplay
      // only pops a ready array; no Math.random/cos/sin/object creation occurs at
      // the instant a Note is judged.
      try {
        if (this.chart.kind === "pjsk") {
          ensurePjskSkin(this);
          this.hitFxAtlasPerfect = null;
          this.hitFxAtlasGood = null;
          this.hitFxDurationCached = PJSK_HIT_FX_DURATION;
        } else {
          this.hitFxAtlasPerfect = hitFxAtlas(this.pack, false);
          this.hitFxAtlasGood = hitFxAtlas(this.pack, true);
          this.hitFxDurationCached = hitFxDuration(this.pack);
        }
      } catch (error) {
        Diagnostics.warn("HitFeedback.prewarm", error?.message || String(error));
      }
      try { Engine.hitSoundOutput(); } catch {}
      const perfect = normalizedHitParticleSpec(this.pack, false),
        good = normalizedHitParticleSpec(this.pack, true),
        each = this.chart.kind === "pjsk" ? 24 : Math.max(8, Math.floor(HIT_PARTICLE_POOL_LIMIT / 2));
      this.hitParticleCountPerfect = perfect.count;
      this.hitParticleCountGood = good.count;
      if (!this.hitParticlePoolPerfect.length)
        for (let i = 0; i < each; i++)
          this.hitParticlePoolPerfect.push(createHitParticles(96, false, i + 1, this.pack, []));
      if (!this.hitParticlePoolGood.length)
        for (let i = 0; i < each; i++)
          this.hitParticlePoolGood.push(createHitParticles(96, true, 1001 + i, this.pack, []));
      // Keep the legacy pool populated for compatibility/self-test visibility,
      // but gameplay does not randomize from it anymore.
      this.hitParticlePool.length = 0;
      if (!this.hitEffectPool.length)
        for (let i = 0; i < HIT_EFFECT_POOL_LIMIT; i++)
          this.hitEffectPool.push({
            x: 0, y: 0, size: 0, at: 0, duration: 0, good: false,
            ux: 1, uy: 0, vx: 0, vy: 1, particles: null, particleCount: 0,
          });
      if (!this.hitRequestPool.length)
        for (let i = 0; i < HIT_EFFECT_POOL_LIMIT; i++)
          this.hitRequestPool.push({ L: null, n: null, j: 0, at: 0 });
    }
    releaseHitParticles(particles, good = false) {
      if (!Array.isArray(particles)) return;
      const pool = good ? this.hitParticlePoolGood : this.hitParticlePoolPerfect,
        limit = Math.max(8, Math.floor(HIT_PARTICLE_POOL_LIMIT / 2));
      if (pool.length < limit) pool.push(particles);
    }
    releaseHitEffect(effect) {
      if (!effect) return;
      this.releaseHitParticles(effect.particles, !!effect.good);
      effect.particles = null;
      effect.particleCount = 0;
      if (this.hitEffectPool.length < HIT_EFFECT_POOL_LIMIT)
        this.hitEffectPool.push(effect);
    }
    hitEffect(L, n, j, at = this.time) {
      this.lastHitPerf = performance.now();
      const request = this.hitRequestPool.pop() || {};
      request.L = L; request.n = n; request.j = j; request.at = at;
      this.hitRequestQueue.push(request);
    }
    emitHitEffect(L, n, j, at = this.time) {
      const geometryAt = Number.isFinite(this.currentVisualTime) ? this.currentVisualTime : at,
        p = this.noteJudgePoint(L, n, geometryAt),
        good = j === 1;
      let size;
      if (this.chart.kind === "pjsk") {
        const stage = pjskStageGeometry(this), lane = clamp(Number(n._pjskLane) || 0, 0, stage.lanes - 1),
          span = clamp(Math.round(Number(n._pjskSpan) || 1), 1, stage.lanes),
          metric = pjskAutoNoteMetrics(stage, lane, span, 1);
        size = Math.max(30, metric.width * 1.34 * clamp(Number(hitFxSizeScale) || 1, 0.85, 1.45));
      } else {
        const scale = clamp(Number(n.size || 1), 0.05, 8),
          noteSize =
            (this.noteWidth || Math.min(this.w, (this.h * 16) / 9) * (this.chart.kind === "pjsk" ? 0.065 : 0.15625)) *
            scale *
            noteSizeScale * this.packageNoteScale;
        size = noteSize * hitFxSizeScale * (1.54/1.18);
      }
      const pool = good ? this.hitParticlePoolGood : this.hitParticlePoolPerfect,
        particles = pool.pop() || createHitParticles(size, good, null, this.pack, []),
        effect = this.hitEffectPool.pop() || {};
      effect.x = p.x;
      effect.y = p.y;
      effect.size = size;
      effect.at = this.frameNow || performance.now();
      effect.duration = this.chart.kind === "pjsk" ? PJSK_HIT_FX_DURATION : (this.hitFxDurationCached || 0.5);
      effect.good = good;
      effect.particleCount = good ? this.hitParticleCountGood : this.hitParticleCountPerfect;
      effect.ux = p.line?.ux ?? 1;
      effect.uy = p.line?.uy ?? 0;
      effect.vx = (p.line?.vx ?? 0) * (Number.isFinite(n.directionSign) ? n.directionSign : (n.above ? -1 : 1));
      effect.vy = (p.line?.vy ?? 1) * (Number.isFinite(n.directionSign) ? n.directionSign : (n.above ? -1 : 1));
      effect.particles = particles;
      this.effects.push(effect);
    }
    flushHitEffects() {
      const queue = this.hitRequestQueue;
      for (let i = 0; i < queue.length; i++) {
        const request = queue[i];
        this.emitHitEffect(request.L, request.n, request.j, request.at);
        request.L = null; request.n = null; request.j = 0; request.at = 0;
        if (this.hitRequestPool.length < HIT_EFFECT_POOL_LIMIT) this.hitRequestPool.push(request);
      }
      queue.length = 0;
    }
    clearPendingHitEffects() {
      const queue = this.hitRequestQueue;
      for (let i = 0; i < queue.length; i++) {
        const request = queue[i];
        request.L = null; request.n = null; request.j = 0; request.at = 0;
        if (this.hitRequestPool.length < HIT_EFFECT_POOL_LIMIT) this.hitRequestPool.push(request);
      }
      queue.length = 0;
    }
    accuracy() {
      if(this.chart.kind === "pjsk"){const c=this.pjskCounts||[0,0,0,0,0];return this.total?(c[0]+c[1]*.7+c[2]*.5)/this.total:1;}
      return this.total
        ? (this.counts[0] + this.counts[1] * 0.65) / this.total
        : 1;
    }
    score() {
      if (!(this.total > 0)) return 0;
      if(this.chart.kind === "pjsk")return Math.round(this.accuracy()*1000000);
      if (this.counts[0] === this.total) return 1000000;
      return Math.round(
        (0.9 * this.accuracy() +
          (0.1 * this.maxCombo) / Math.max(1, this.total)) *
          1000000,
      );
    }
    paintProgress(value) {
      const original=this.chart.kind!=='pjsk'&&!!this.pack?.progressIconURL,
        transform=original?`translateX(${((value-1)*100).toFixed(6)}%)`:`scaleX(${value.toFixed(6)})`;
      for(const bar of this.hudProgressEls)bar.style.transform=transform;
    }
    updateHUD() {
      if(this.chart.kind === "pjsk"){const life=gameplayDocument().querySelector(".pjskLifeHud i"),value=Math.round(this.pjskLife??1000);if(this._lastLife!==value){if(life)life.style.transform=`scaleX(${value/1000})`;if($("#pjskLifeValue"))$("#pjskLifeValue").textContent=String(value);gameplayDocument().querySelector(".pjskLifeHud")?.setAttribute("aria-label",`生命 ${value} / 1000`);this._lastLife=value;}}
      const score = fmtScore(this.score()),
        combo = String(this.combo),
        visible = (this.chart.kind === "pjsk" ? this.combo > 0 : this.combo > 2) && !(this.invincibleMode && this.invincibleComboSuppressed());
      if (score !== this.lastHudScore) {
        for (const el of this.hudScoreEls) el.textContent = score;
        this.lastHudScore = score;
      }
      if (visible && combo !== this.lastHudCombo) {
        for (const el of this.hudComboEls) el.textContent = combo;
        this.lastHudCombo = combo;
      } else if (!visible && this.lastHudVisible !== false) {
        // Keep the last numeric glyph during the fade so COMBO never shifts upward.
        this.lastHudCombo = "";
      }
      if (visible !== this.lastHudVisible) {
        const opacity = visible ? "1" : "0";
        for (const el of this.hudComboBoxes) el.style.opacity = opacity;
        this.lastHudVisible = visible;
      }
      if (this.autoplay !== this.lastHudAutoplay) {
        syncAutoplayHud(this.autoplay);
        this.lastHudAutoplay = this.autoplay;
      }
    }
    initUIAttachMap() {
      const item = (...els) => {
        const filtered = els.filter(Boolean);
        return {
          els: filtered,
          baseTransforms: new Map(
            filtered.map((el) => {
              const value = getComputedStyle(el).transform;
              return [el, value && value !== "none" ? value : ""];
            }),
          ),
          lastOpacity: "",
          lastTransforms: new Map(),
        };
      };
      this.uiAttachMap = {
        pause: item($("#pauseBtn"), $("#innerPauseBtn")),
        combonumber: item($("#comboText"), $("#innerComboText")),
        combo: item(
          $("#comboHud")?.querySelector(".comboLabel"),
          $("#innerComboHud")?.querySelector(".comboLabel"),
        ),
        score: item($("#scoreText"), $("#innerScoreText")),
        bar: item(
          $("#progressBar")?.parentElement,
          $("#innerProgressBar")?.parentElement,
        ),
        name: item($("#gameSongName"), $("#innerGameSongName")),
        level: item($("#gameDifficulty"), $("#innerGameDifficulty")),
      };
    }
    applyAttachedUI(L, ls) {
      const item = this.uiAttachMap?.[String(L.attachUI || "").toLowerCase()],
        els = item?.els;
      if (!els?.length) return;
      const tx = ls.x * this.w * 0.5,
        ty = -ls.y * this.h * 0.5,
        sx = Number.isFinite(ls.scaleX) ? ls.scaleX : 1,
        sy = Number.isFinite(ls.scaleY) ? ls.scaleY : 1,
        opacity = clamp(ls.alpha, 0, 1).toFixed(4),
        authored = `translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px) rotate(${ls.screenRot.toFixed(3)}deg) scale(${sx.toFixed(4)},${sy.toFixed(4)})`;
      if (item.lastOpacity !== opacity) {
        for (const el of els) {
          el.style.opacity = opacity;
          this.uiAttached.add(el);
        }
        item.lastOpacity = opacity;
      }
      for (const el of els) {
        const base = item.baseTransforms?.get(el) || "",
          transform = base ? `${base} ${authored}` : authored;
        if (item.lastTransforms?.get(el) === transform) continue;
        el.style.transformOrigin = "50% 50%";
        el.style.transform = transform;
        this.uiAttached.add(el);
        item.lastTransforms?.set(el, transform);
      }
    }
    resetAttachedUI() {
      if (!this.uiAttached) return;
      for (const el of this.uiAttached) {
        el.style.removeProperty("opacity");
        el.style.removeProperty("transform");
        el.style.removeProperty("transform-origin");
      }
      for (const item of Object.values(this.uiAttachMap || {})) {
        item.lastOpacity = "";
        item.lastTransforms?.clear();
      }
      this.uiAttached.clear();
    }
    lineIntersectsViewport(L, ls) {
      if (L.attachUI) return true;
      if (!(ls.alpha > 0.001)) return false;
      const vis = this.visibleLogicalBounds;
      let halfW = 0, halfH = 0;
      if (L.lineKind === "texture" && L._textureImage) {
        const im = L._textureImage, spec = L.lineCsv,
          unit = spec
            ? (spec.useLineScale ? Math.min(this.h / 1080, this.w / 810) : this.h / 1080) * (Number(spec.scale) || 1)
            : this.w / 1350;
        halfW = (im.naturalWidth || im.width) * unit * (spec ? Math.abs(Number(spec.aspect) || 1) : 1) * Math.abs(ls.scaleX || 1) * 0.5;
        halfH = (im.naturalHeight || im.height) * unit * Math.abs(ls.scaleY || 1) * 0.5;
      } else if (L.lineKind === "text") {
        const text = String(ls.text || "");
        if (L._textCacheSource !== text) {
          L._textCacheSource = text;
          L._textCacheLines = text.split("\n");
        }
        const lines = L._textCacheLines,
          font = Math.max(4, (50 * this.w) / 1350);
        let chars = 1;
        for (let i = 0; i < lines.length; i++) if (lines[i].length > chars) chars = lines[i].length;
        halfW = chars * font * 0.36 * Math.abs(ls.scaleX || 1);
        halfH = Math.max(1, lines.length) * font * 0.62 * Math.abs(ls.scaleY || 1);
      } else {
        const authored = Math.max(0.01, Number(ls.lineLength || L.lineLength || this.record.meta?.lineLength) || 6);
        halfW =
          chartLineLengthToWorld(authored, this.officialLineReferenceWidth()) * 0.5 * Math.abs(ls.scaleX || 1);
        halfH = this.officialLineThickness(ls.scaleY || 1) * 0.5;
      }
      const ex = Math.abs(ls.ux) * halfW + Math.abs(ls.vx) * halfH + 3,
        ey = Math.abs(ls.uy) * halfW + Math.abs(ls.vy) * halfH + 3;
      return !(ls.cx + ex < vis.left || ls.cx - ex > vis.right || ls.cy + ey < vis.top || ls.cy - ey > vis.bottom);
    }
    officialLineIntersectsViewport(ls, half, thickness = 6) {
      const vis = this.visibleLogicalBounds,
        ex = Math.abs(ls.ux) * half + Math.abs(ls.vx) * thickness + 3,
        ey = Math.abs(ls.uy) * half + Math.abs(ls.vy) * thickness + 3;
      return !(ls.cx + ex < vis.left || ls.cx - ex > vis.right || ls.cy + ey < vis.top || ls.cy - ey > vis.bottom);
    }
    quantizeRPETextureColor(value) {
      // 8-step quantization limits animated tint cache churn while remaining
      // visually smooth at 120 Hz (at most 33 states per channel transition).
      return clamp(Math.round((Number(value) || 0) / 8) * 8, 0, 255);
    }
    rpeTextureRasterDimensions(image, targetPixelW, targetPixelH) {
      const iw = Math.max(1, Number(image?.naturalWidth || image?.width || 1)),
        ih = Math.max(1, Number(image?.naturalHeight || image?.height || 1)),
        reqW = Math.max(1, Math.ceil(Math.abs(Number(targetPixelW) || 1))),
        reqH = Math.max(1, Math.ceil(Math.abs(Number(targetPixelH) || 1))),
        // Source F: no arbitrary 2048/4096 long-axis cap. A tinted RPE texture is
        // rasterized to at least its final physical draw footprint (up to the
        // source artwork's own native pixels), so an 8K source remains 8K-capable
        // when the display/reveal footprint actually needs those pixels.
        targetScale = Math.min(1, Math.max(reqW / iw, reqH / ih)),
        sourceLong = Math.max(iw, ih),
        quantizedScale = Math.max(1 / sourceLong, Math.ceil(targetScale * 256) / 256);
      return {
        w: Math.max(1, Math.min(iw, Math.round(iw * quantizedScale))),
        h: Math.max(1, Math.min(ih, Math.round(ih * quantizedScale))),
        iw,
        ih,
      };
    }
    evictRPETextureRasterCache() {
      while (
        this.rpeTextureRasterCache.size > this.rpeTextureRasterEntries ||
        this.rpeTextureRasterBytes > this.rpeTextureRasterLimit
      ) {
        const first = this.rpeTextureRasterCache.keys().next().value;
        if (first == null) break;
        const entry = this.rpeTextureRasterCache.get(first);
        this.rpeTextureRasterCache.delete(first);
        this.rpeTextureRasterBytes = Math.max(0, this.rpeTextureRasterBytes - Number(entry?.bytes || 0));
      }
    }
    clearRPETextureRasterCache() {
      this.rpeTextureRasterCache?.clear();
      this.rpeTextureRasterBytes = 0;
    }
    getRPETextureSurface(image, color, targetPixelW, targetPixelH) {
      if (!image) return null;
      const dims = this.rpeTextureRasterDimensions(image, targetPixelW, targetPixelH),
        r = this.quantizeRPETextureColor(color?.[0] ?? 255),
        g = this.quantizeRPETextureColor(color?.[1] ?? 255),
        b = this.quantizeRPETextureColor(color?.[2] ?? 255),
        white = r === 255 && g === 255 && b === 255,
        needsDownsample = dims.iw > dims.w * 1.35 || dims.ih > dims.h * 1.35;
      // Untinted images stay on the browser's native decoded-image path. Browser
      // compositors generally cache this scaling better than a canvas copy; the
      // custom raster cache is reserved for correctness-critical colorEvents.
      if (white) return image;
      const id = image._rpeTextureId || 0,
        key = `${id}|${dims.w}x${dims.h}|${r},${g},${b}`,
        cached = this.rpeTextureRasterCache.get(key);
      if (cached?.canvas) {
        this.rpeTextureCacheHits++;
        // Refresh insertion order for bounded LRU eviction.
        this.rpeTextureRasterCache.delete(key);
        this.rpeTextureRasterCache.set(key, cached);
        return cached.canvas;
      }
      this.rpeTextureCacheMisses++;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = dims.w;
        canvas.height = dims.h;
        const g2 = canvas.getContext("2d", { alpha: true, colorSpace: "srgb" }) || canvas.getContext("2d", { alpha: true });
        if (!g2) return image;
        g2.imageSmoothingEnabled = true;
        g2.imageSmoothingQuality = "high";
        g2.clearRect(0, 0, dims.w, dims.h);
        g2.globalCompositeOperation = "source-over";
        g2.drawImage(image, 0, 0, dims.w, dims.h);
        if (!white) {
          // RPE colorEvents are multiplicative tints. Replacing opaque pixels with
          // a flat source-atop fill destroys authored luminance and made Algebra's
          // final Problem8 image become a solid red block.
          g2.globalCompositeOperation = "multiply";
          g2.fillStyle = `rgb(${r},${g},${b})`;
          g2.fillRect(0, 0, dims.w, dims.h);
          g2.globalCompositeOperation = "destination-in";
          g2.drawImage(image, 0, 0, dims.w, dims.h);
          g2.globalCompositeOperation = "source-over";
        }
        const bytes = dims.w * dims.h * 4,
          entry = { canvas, bytes };
        this.rpeTextureRasterCache.set(key, entry);
        this.rpeTextureRasterBytes += bytes;
        this.evictRPETextureRasterCache();
        return canvas;
      } catch (error) {
        Diagnostics.warn("RenderEngine.texture", "RPE 贴图预栅格化失败，已回退原图", { message: error?.message || String(error) });
        return image;
      }
    }
    async prewarmRPETextureRasters() {
      // Prewarm small/static tints first, then animated tints in timeline order.
      // The dynamic pass runs last so late-song transitions (such as Algebra's
      // Problem8 white-to-red question) remain the newest LRU entries instead of
      // being evicted by unrelated startup work.
      const staticBudget = this.isAppleTouch ? 6 * 1024 * 1024 : 12 * 1024 * 1024,
        totalBudget = Math.min(
          this.rpeTextureRasterLimit * 0.88,
          this.isAppleTouch ? 28 * 1024 * 1024 : 52 * 1024 * 1024,
        ),
        startBytes = this.rpeTextureRasterBytes,
        staticTasks = [],
        dynamicTasks = [],
        seen = new Set();
      for (let li = 0; li < this.renderLines.length; li++) {
        const L = this.renderLines[li],
          image = L._textureImage,
          events = L.color || [];
        if (!image || !events.length) continue;
        // Respect authored scales below 1.0. Starting at 1 made a 40%-sized
        // Problem8 prewarm allocate full-resolution surfaces, exhausting the cache
        // and then missing every runtime lookup.
        let maxX = (L.scaleX || []).length ? 0.01 : 1,
          maxY = (L.scaleY || []).length ? 0.01 : 1;
        for (const e of L.scaleX || []) maxX = Math.max(maxX, Math.abs(Number(e.a) || 0), Math.abs(Number(e.b) || 0));
        for (const e of L.scaleY || []) maxY = Math.max(maxY, Math.abs(Number(e.a) || 0), Math.abs(Number(e.b) || 0));
        const unit = Math.max(1, this.w || innerWidth || 1350) / 1350,
          targetW = (image.naturalWidth || image.width || 1) * unit * maxX * Math.max(1, this.frameCanvasScale || 1),
          targetH = (image.naturalHeight || image.height || 1) * unit * maxY * Math.max(1, this.frameCanvasScale || 1);
        for (const e of events) {
          const a = e.a || DEFAULT_LINE_COLOR,
            b = e.b || a,
            changing = Math.abs((a[0] || 0) - (b[0] || 0)) + Math.abs((a[1] || 0) - (b[1] || 0)) + Math.abs((a[2] || 0) - (b[2] || 0)) > 1,
            task = { image, targetW, targetH, a, b, st: Number(e.st) || 0, li };
          (changing ? dynamicTasks : staticTasks).push(task);
        }
      }
      staticTasks.sort((a, b) => a.st - b.st || a.li - b.li);
      dynamicTasks.sort((a, b) => a.st - b.st || a.li - b.li);
      let generated = 0;
      const warmColor = async (task, color, phaseBudget) => {
        const r = this.quantizeRPETextureColor(color?.[0] ?? 255),
          g = this.quantizeRPETextureColor(color?.[1] ?? 255),
          b = this.quantizeRPETextureColor(color?.[2] ?? 255);
        if (r === 255 && g === 255 && b === 255) return true;
        const dims = this.rpeTextureRasterDimensions(task.image, task.targetW, task.targetH),
          key = `${task.image._rpeTextureId || 0}|${dims.w}x${dims.h}|${r},${g},${b}`;
        if (seen.has(key) || this.rpeTextureRasterCache.has(key)) return true;
        const estimated = dims.w * dims.h * 4,
          used = this.rpeTextureRasterBytes - startBytes;
        if (used + estimated > phaseBudget || used + estimated > totalBudget) return false;
        seen.add(key);
        const before = this.rpeTextureRasterBytes;
        this.getRPETextureSurface(task.image, [r, g, b], task.targetW, task.targetH);
        if (this.rpeTextureRasterBytes > before) generated++;
        if ((generated & 7) === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        return true;
      };
      for (const task of staticTasks) {
        if (!(await warmColor(task, task.a, staticBudget))) break;
      }
      // Animated states are intentionally warmed after static states. Runtime uses
      // the same 8-step quantization, so no new raster should be allocated mid-song
      // while the authored colour transition is visible.
      for (const task of dynamicTasks) {
        for (let q = 0; q <= 32; q++) {
          const u = q / 32,
            color = [
              lerp(Number(task.a[0] ?? 255), Number(task.b[0] ?? 255), u),
              lerp(Number(task.a[1] ?? 255), Number(task.b[1] ?? 255), u),
              lerp(Number(task.a[2] ?? 255), Number(task.b[2] ?? 255), u),
            ];
          if (!(await warmColor(task, color, totalBudget))) break;
        }
        if (this.rpeTextureRasterBytes - startBytes >= totalBudget) break;
      }
      this.rpeTexturePrewarmCount = generated;
      this.rpeTexturePrewarmBytes = Math.max(0, this.rpeTextureRasterBytes - startBytes);
      this.rpeTexturePrewarmDynamicCount = dynamicTasks.length;
      if (generated) Diagnostics.info("RenderEngine.texture", `预热 ${generated} 个 RPE 染色贴图状态`, {
        bytes: this.rpeTexturePrewarmBytes,
        animatedTransitions: dynamicTasks.length,
      });
    }
    lineUsesJudgmentStateColor(L, ls, authoredLength = 6, thickness = 4) {
      // RPE often reuses a normal white "line" as a full-screen mask, flash or
      // background by scaling it tens or hundreds of times. AP/FC feedback is a
      // gameplay status and must not recolor those decorative surfaces.
      if (!L || L.lineKind === "texture" || L.lineKind === "text" || !ls?.colorWhite) return false;
      const hasPlayableNote = L._hasPlayableNote ??
          (L._hasPlayableNote = (L.notes || []).some((note) => !note.fake)),
        baseThickness = Math.max(0.01, this.officialLineThickness(1)),
        visualThickness = Math.abs(Number(thickness) || 0),
        authored = Math.abs(Number(authoredLength) || 0);
      return hasPlayableNote && visualThickness <= baseThickness * 4.5 && authored <= 24;
    }
    expandRPEMaskRect(ls, half, thickness) {
      // RPE masks are authored against chart coordinates. On a taller 4:3 or
      // portrait surface, a near-full-screen rectangle must stretch to the real
      // viewport instead of leaving the authored-aspect strips visible.
      const vis = this.visibleLogicalBounds,
        corners = [
          [vis.left, vis.top], [vis.right, vis.top],
          [vis.left, vis.bottom], [vis.right, vis.bottom],
        ];
      let needU = 0, needV = 0;
      for (let i = 0; i < 4; i++) {
        const dx = corners[i][0] - ls.cx,
          dy = corners[i][1] - ls.cy;
        needU = Math.max(needU, Math.abs(dx * ls.ux + dy * ls.uy));
        needV = Math.max(needV, Math.abs(dx * ls.vx + dy * ls.vy));
      }
      const halfV = Math.abs(thickness) * 0.5,
        nearFull = half >= needU * 0.72 && halfV >= needV * 0.72;
      if (!nearFull) return { half, thickness };
      return {
        half: Math.max(half, needU + 3),
        thickness: Math.max(Math.abs(thickness), (needV + 3) * 2),
      };
    }
    drawRPELine(c, L, ls, lineColor) {
      if (L.attachUI) {
        this.applyAttachedUI(L, ls);
        return;
      }
      if (ls.alpha <= 0.001) return;
      const color = ls.colorCss || "#ffffff",
        sx = Number.isFinite(ls.scaleX) ? ls.scaleX : 1,
        sy = Number.isFinite(ls.scaleY) ? ls.scaleY : 1,
        s = this.frameCanvasScale,
        ox = this.frameCanvasOffsetX,
        oy = this.frameCanvasOffsetY,
        tx = ox + s * ls.cx,
        ty = oy + s * ls.cy;
      c.globalAlpha = ls.alpha;
      c.globalCompositeOperation = "source-over";
      if (L.lineKind === "texture" && L._textureImage) {
        const im = L._textureImage, spec = L.lineCsv,
          unit = spec
            ? (spec.useLineScale ? Math.min(this.h / 1080, this.w / 810) : this.h / 1080) * (Number(spec.scale) || 1)
            : this.w / 1350,
          dw = (im.naturalWidth || im.width) * unit * (spec ? Math.abs(Number(spec.aspect) || 1) : 1) * Math.abs(sx),
          dh = (im.naturalHeight || im.height) * unit * Math.abs(sy),
          signX = Math.sign(sx) || 1,
          signY = Math.sign(sy) || 1;
        if (dw > 0.05 && dh > 0.05) {
          c.setTransform(
            s * ls.ux * signX,
            s * ls.uy * signX,
            s * ls.vx * signY,
            s * ls.vy * signY,
            tx,
            ty,
          );
          const tint = spec && !spec.useLineColor ? DEFAULT_LINE_COLOR : (spec?.useLineColor
            ? (lineColor === PHI_COLORS.ap ? [255,236,160] : lineColor === PHI_COLORS.fc ? [162,238,255] : DEFAULT_LINE_COLOR)
            : ls.color || DEFAULT_LINE_COLOR),
            surface = this.getRPETextureSurface(
            im,
            tint,
            Math.abs(dw * s),
            Math.abs(dh * s),
          ) || im;
          if (spec?.useBackgroundDim) c.filter = `brightness(${clamp(1 - Number(this.record.meta?.backgroundDim ?? 0.6) * 0.37, 0.35, 1)})`;
          c.drawImage(surface, -dw / 2, -dh / 2, dw, dh);
          c.filter = "none";
          // Invincible AP/FC feedback must never recolor arbitrary RPE image
          // textures. Only normal judgment-line geometry uses the state colour.
        }
        return;
      }
      if (L.lineKind === "text") {
        const text = String(ls.text || "");
        if (text) {
          const font = Math.max(4, (50 * this.w) / 1350);
          c.setTransform(
            s * ls.ux * (sx || 0.0001),
            s * ls.uy * (sx || 0.0001),
            s * ls.vx * (sy || 0.0001),
            s * ls.vy * (sy || 0.0001),
            tx,
            ty,
          );
          c.fillStyle = color;
          c.textAlign = "center";
          c.textBaseline = "middle";
          c.font = `500 ${font}px "PhiEmbeddedSaira","PingFang SC","PhiCJK","Noto Sans CJK SC","Microsoft YaHei",sans-serif`;
          if (L._textCacheSource !== text) {
            L._textCacheSource = text;
            L._textCacheLines = text.split("\n");
          }
          const lines = L._textCacheLines || [text],
            lh = font * 1.16,
            oyText = (-(lines.length - 1) * lh) / 2;
          for (let i = 0; i < lines.length; i++) c.fillText(lines[i], 0, oyText + i * lh);
        }
        return;
      }
      const authored = Math.max(0.01, Number(ls.lineLength || L.lineLength || this.record.meta?.lineLength) || 6);
      let half = chartLineLengthToWorld(authored, this.officialLineReferenceWidth()) * 0.5 * Math.abs(sx),
        thickness = this.officialLineThickness(sy);
      if (this.chart.kind === "rpe") {
        const expanded = this.expandRPEMaskRect(ls, half, thickness);
        half = expanded.half;
        thickness = expanded.thickness;
      }
      c.setTransform(s * ls.ux, s * ls.uy, s * ls.vx, s * ls.vy, tx, ty);
      c.fillStyle = this.lineUsesJudgmentStateColor(L, ls, authored, thickness) ? lineColor : color;
      c.fillRect(-half, -thickness / 2, half * 2, thickness);
    }
    warmPostProcessing() {
      if (!this.extraEffects?.length) return false;
      if (!this.postProcessor)
        this.postProcessor = new PhiPostProcessor(this.canvas, this.shaderSources);
      return this.postProcessor.warm(this.extraEffects);
    }
    activeEffectsAt(t) {
      const all = this.extraEffects || [];
      if (!all.length) return this.activeExtraEffects;
      let changed = false;
      if (t < this.extraLastTime || t - this.extraLastTime > 2) {
        this.extraStartIndex = 0;
        this.activeExtraEffects.length = 0;
        while (this.extraStartIndex < all.length && all[this.extraStartIndex].st <= t) {
          const e = all[this.extraStartIndex++];
          if (e.et >= t) this.activeExtraEffects.push(e);
        }
        changed = true;
      } else {
        while (this.extraStartIndex < all.length && all[this.extraStartIndex].st <= t) {
          const e = all[this.extraStartIndex++];
          if (e.et >= t) {
            this.activeExtraEffects.push(e);
            changed = true;
          }
        }
        const oldLength = this.activeExtraEffects.length;
        let w = 0;
        for (let i = 0; i < oldLength; i++) {
          const e = this.activeExtraEffects[i];
          if (e.st <= t && e.et >= t) this.activeExtraEffects[w++] = e;
        }
        if (w !== oldLength) changed = true;
        this.activeExtraEffects.length = w;
      }
      this.extraLastTime = t;
      this.extraEffectsDirty ||= changed;
      if (this.extraEffectsDirty && this.activeExtraEffects.length > 1)
        this.activeExtraEffects.sort((a, b) => a.order - b.order || a.id - b.id);
      this.extraEffectsDirty = false;
      return this.activeExtraEffects;
    }
    visibleEffectsAt(t) {
      const active = this.activeEffectsAt(t), out = this.visibleExtraEffects;
      out.length = 0;
      for (const e of active) {
        const kind = e._kind || (e._kind = String(e.kind || e.shader || "").toLowerCase());
        let visible = true;
        if (/chromatic|radialblur|radial_blur/.test(kind))
          visible = Math.abs(rpeExtraValue(e, "power", t, 0)) > 0.00005;
        else if (/sobel/.test(kind))
          visible = Math.abs(rpeExtraValue(e, "strength", t, 0)) > 0.00005;
        else if (/rays|godray|light/.test(kind))
          visible = Math.abs(rpeExtraValue(e, "exposure", t, 0.5) * rpeExtraValue(e, "weight", t, 0.3)) > 0.00005;
        if (visible) out.push(e);
      }
      return out;
    }
    effectScissor(effect) {
      const id = Number(effect?.line);
      if (!Number.isInteger(id) || id < 0 || !this.chart.lines[id]) return null;
      const L = this.chart.lines[id],
        ls = this.frameLines[id];
      if (!ls) return null;
      let halfW = this.w * 0.75,
        halfH = Math.max(8, this.noteWidth * 1.5);
      if (L.lineKind === "texture" && L._textureImage) {
        const im = L._textureImage, unit = this.w / 1350;
        halfW = (im.naturalWidth || im.width) * unit * Math.abs(ls.scaleX || 1) * 0.5;
        halfH = (im.naturalHeight || im.height) * unit * Math.abs(ls.scaleY || 1) * 0.5;
      } else if (L.lineKind === "text") {
        const text = String(ls.text || "");
        if (L._textCacheSource !== text) {
          L._textCacheSource = text;
          L._textCacheLines = text.split("\n");
        }
        const font = Math.max(4, (50 * this.w) / 1350), lines = L._textCacheLines;
        let chars = 1;
        for (const x of lines) chars = Math.max(chars, x.length);
        halfW = chars * font * 0.42 * Math.abs(ls.scaleX || 1);
        halfH = lines.length * font * 0.7 * Math.abs(ls.scaleY || 1);
      }
      const ex = Math.abs(ls.ux) * halfW + Math.abs(ls.vx) * halfH + this.noteWidth * 2,
        ey = Math.abs(ls.uy) * halfW + Math.abs(ls.vy) * halfH + this.noteWidth * 2,
        leftCss = this.viewX + (ls.cx - ex) * this.viewScale,
        rightCss = this.viewX + (ls.cx + ex) * this.viewScale,
        topCss = this.viewY + (ls.cy - ey) * this.viewScale,
        bottomCss = this.viewY + (ls.cy + ey) * this.viewScale,
        sx = this.canvas.width / Math.max(1, this.surfaceW),
        sy = this.canvas.height / Math.max(1, this.surfaceH),
        x0 = clamp(Math.floor(leftCss * sx), 0, this.canvas.width),
        x1 = clamp(Math.ceil(rightCss * sx), 0, this.canvas.width),
        y0 = clamp(Math.floor(topCss * sy), 0, this.canvas.height),
        y1 = clamp(Math.ceil(bottomCss * sy), 0, this.canvas.height);
      if (x1 <= x0 || y1 <= y0) return false;
      const out = this.effectScissorScratch;
      out.x = x0;
      out.y = this.canvas.height - y1;
      out.w = x1 - x0;
      out.h = y1 - y0;
      return out;
    }
    ensureForegroundFxUnderlay(width, height) {
      if (!this.foregroundFxCanvas) {
        const layer = document.createElement("canvas");
        layer.className = "phiForegroundFxUnderlay";
        this.canvas.parentElement?.insertBefore(layer, this.canvas);
        this.foregroundFxCanvas = layer;
        this.foregroundFxCtx = layer.getContext("2d", { alpha: true, colorSpace: "srgb" }) || layer.getContext("2d", { alpha: true });
      }
      if (this.foregroundFxCanvas.width !== width || this.foregroundFxCanvas.height !== height) {
        this.foregroundFxCanvas.width = width;
        this.foregroundFxCanvas.height = height;
      }
      if (!this.foregroundFxVisible) {
        this.foregroundFxCanvas.style.display = "block";
        this.foregroundFxVisible = true;
      }
      return this.foregroundFxCtx;
    }
    hideForegroundFxUnderlay() {
      if (!this.foregroundFxCanvas || !this.foregroundFxVisible) return;
      this.foregroundFxVisible = false;
      this.foregroundFxCanvas.style.display = "none";
      this.foregroundFxCtx?.clearRect(0, 0, this.foregroundFxCanvas.width, this.foregroundFxCanvas.height);
    }
    drawExtraEffectsFallback(t, effects) {
      if (!effects?.length) { this.hideForegroundFxUnderlay(); return; }
      const source = this.canvas,
        rasterScale = 1,
        sw = Math.max(2, Math.round(source.width * rasterScale)),
        sh = Math.max(2, Math.round(source.height * rasterScale)),
        c = this.ensureForegroundFxUnderlay(sw, sh);
      if (!c) return;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      c.filter = "none";
      c.clearRect(0, 0, sw, sh);
      if (!this.effectCanvas) {
        this.effectCanvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(sw, sh) : document.createElement("canvas");
        this.effectCtx = this.effectCanvas.getContext("2d", { alpha: true, colorSpace: "srgb" }) || this.effectCanvas.getContext("2d", { alpha: true });
      }
      if (this.effectCanvas.width !== sw || this.effectCanvas.height !== sh) {
        this.effectCanvas.width = sw;
        this.effectCanvas.height = sh;
      }
      const ec = this.effectCtx;
      ec.setTransform(1, 0, 0, 1, 0, 0);
      ec.globalAlpha = 1;
      ec.globalCompositeOperation = "source-over";
      ec.filter = "none";
      ec.clearRect(0, 0, sw, sh);
      ec.drawImage(source, 0, 0, source.width, source.height, 0, 0, sw, sh);
      for (const e of effects) {
        const kind = e._kind || (e._kind = String(e.kind || e.shader || "").toLowerCase());
        if (/vignette/.test(kind)) {
          const extend = clamp(rpeExtraValue(e, "extend", t, 0.18), 0, 0.75),
            radius = clamp(rpeExtraValue(e, "radius", t, 15) / 30, 0.25, 0.85),
            g = c.createRadialGradient(sw / 2, sh / 2, Math.min(sw, sh) * radius * 0.55, sw / 2, sh / 2, Math.hypot(sw, sh) * 0.55);
          g.addColorStop(0, "rgba(0,0,0,0)");
          g.addColorStop(1, `rgba(0,0,0,${Math.min(0.72, 0.18 + extend)})`);
          c.fillStyle = g;
          c.fillRect(0, 0, sw, sh);
          continue;
        }
        if (!/chromatic|radialblur|rays|sobel/.test(kind)) continue;
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        if (/chromatic/.test(kind)) {
          const power = clamp(Math.abs(rpeExtraValue(e, "power", t, 0)), 0, 0.25),
            shift = Math.max(1, power * Math.min(sw, sh) * 0.16);
          c.globalCompositeOperation = "screen";
          c.globalAlpha = clamp(0.07 + power * 1.25, 0.07, 0.24);
          c.filter = "sepia(1) saturate(8) hue-rotate(-48deg)";
          c.drawImage(this.effectCanvas, shift, 0, sw, sh);
          c.filter = "sepia(1) saturate(8) hue-rotate(142deg)";
          c.drawImage(this.effectCanvas, -shift, 0, sw, sh);
        } else if (/radialblur/.test(kind)) {
          const power = clamp(Math.abs(rpeExtraValue(e, "power", t, 0)), 0, 0.25),
            steps = this.isAppleTouch ? 3 : 5;
          c.globalAlpha = 0.055;
          for (let i = 1; i <= steps; i++) {
            const q = 1 + power * i * 0.5, dw = sw * q, dh = sh * q;
            c.drawImage(this.effectCanvas, (sw - dw) / 2, (sh - dh) / 2, dw, dh);
          }
        } else if (/sobel/.test(kind)) {
          const strength = clamp(rpeExtraValue(e, "strength", t, 0), 0, 1);
          c.globalAlpha = strength * 0.58;
          c.filter = "grayscale(1) contrast(3.2)";
          c.drawImage(this.effectCanvas, 0, 0, sw, sh);
        } else if (/rays/.test(kind)) {
          const pos = rpeExtraVector(e, "lightpos", t, [0.5, 0.5], this.effectVectorScratch),
            exposure = clamp(rpeExtraValue(e, "exposure", t, 0.5), 0, 2),
            density = clamp(rpeExtraValue(e, "density", t, 0.1), 0, 1),
            lx = pos[0] * sw, ly = pos[1] * sh,
            steps = this.isAppleTouch ? 3 : 6;
          c.globalCompositeOperation = "screen";
          c.globalAlpha = Math.min(0.1, exposure * 0.05);
          for (let i = 1; i <= steps; i++) {
            const q = 1 + density * i * 0.12, dw = sw * q, dh = sh * q;
            c.drawImage(this.effectCanvas, lx - lx * q, ly - ly * q, dw, dh);
          }
        }
        c.restore();
      }
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      c.filter = "none";
    }
    draw(t = this.time, frameNow = performance.now()) {
      const c = this.ctx,
        w = this.w,
        h = this.h;
      if (Math.abs(t - this.frameTime) > 1 / 240) this.prepareFrame(t);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      // Canvas-first background: this remains visible even when WebKit promotes
      // the gameplay Canvas to an opaque surface.
      this.drawGameplayBackground(c,t);
      const d = this.dpr || 1,
        baseScale = d * this.viewScale,
        baseX = d * this.viewX,
        baseY = d * this.viewY;
      this.frameCanvasScale = baseScale;
      this.frameCanvasOffsetX = baseX;
      this.frameCanvasOffsetY = baseY;
      this.metricsDrawnNotes = 0;
      c.save();c.setTransform(baseScale,0,0,baseScale,baseX,baseY);
      drawNativeBlocks(this,c,t,true);
      c.restore();
      c.save();
      c.setTransform(baseScale, 0, 0, baseScale, baseX, baseY);
      if (!chartRevealEnabled) {
        c.beginPath();
        c.rect(0, 0, w, h);
        c.clip();
      }
      const bucket = this.renderBucketAt(t),
        layers = bucket?.layers,
        lineColor = this.invincibleMode
          ? this.invincibleLineColor(frameNow)
          : this.counts[2] + this.counts[3] === 0
            ? this.counts[1] === 0
              ? PHI_COLORS.ap
              : PHI_COLORS.fc
            : "#ffffff";
      if (this.chart.kind === "pjsk") {
        drawPjskScene(this, c, t, bucket);
      } else if (this.chart.kind === "rpe") {
        const visibleFlags = this.frameLineNoteVisible,
          coverFlags = this.frameLineCoverEnabled,
          appearValues = this.frameLineAppearBefore;
        for (let ri = 0; ri < this.renderLines.length; ri++) {
          const L = this.renderLines[ri],
            ls = this.frameLines[L.id];
          let coverEnabled = !L.showBelow,
            appearBefore = Infinity,
            noteVisible = true;
          if (ls.alpha < 0) {
            const code = Math.floor(-ls.alpha + 1e-6);
            if (code === 1) noteVisible = false;
            if (code === 2) coverEnabled = true;
            appearBefore = code >= 100 && code < 1000 ? (code - 100) / 10 : Infinity;
          }
          visibleFlags[L.id] = noteVisible ? 1 : 0;
          coverFlags[L.id] = coverEnabled ? 1 : 0;
          appearValues[L.id] = appearBefore;
          if (this.lineIntersectsViewport(L, ls)) this.drawRPELine(c, L, ls, lineColor);
        }
        for (let li = 0; li < NOTE_RENDER_ORDER.length; li++) {
          const items = layers?.[NOTE_RENDER_ORDER[li]];
          if (!items) continue;
          for (let i = 0; i < items.length; i++) {
            const item = items[i], id = item.L.id;
            if (!visibleFlags[id]) continue;
            this.drawNote(item.L, item.n, t, !!coverFlags[id], appearValues[id]);
          }
        }
      } else {
        const span = this.officialLineSpan,
          lineFrom = span.from,
          lineTo = span.to,
          lineWidth = Math.max(1, lineTo - lineFrom),
          officialThickness = this.officialLineThickness(1);
        for (let ri = 0; ri < this.renderLines.length; ri++) {
          const L = this.renderLines[ri],
            ls = this.frameLines[L.id];
          if (!(ls.alpha > 0.001) || !this.officialLineIntersectsViewport(ls, lineWidth * 0.5, officialThickness * 0.5)) continue;
          c.setTransform(
            baseScale * ls.ux,
            baseScale * ls.uy,
            baseScale * ls.vx,
            baseScale * ls.vy,
            baseX + baseScale * ls.cx,
            baseY + baseScale * ls.cy,
          );
          c.globalAlpha = ls.alpha;
          c.globalCompositeOperation = "source-over";
          const custom = L._textureImage;
          if (custom) {
            const spec = L.lineCsv;
            if (spec) {
              const unit = (spec.useLineScale ? Math.min(this.h / 1080, this.w / 810) : this.h / 1080) * (Number(spec.scale) || 1),
                customW = (custom.naturalWidth || custom.width) * unit * (Number(spec.aspect) || 1),
                customH = (custom.naturalHeight || custom.height) * unit,
                tint = lineColor === PHI_COLORS.ap ? [255,236,160] : lineColor === PHI_COLORS.fc ? [162,238,255] : DEFAULT_LINE_COLOR,
                surface = spec.useLineColor
                  ? this.getRPETextureSurface(custom, tint, Math.abs(customW * baseScale), Math.abs(customH * baseScale)) || custom
                  : custom;
              if (spec.useBackgroundDim) c.filter = `brightness(${clamp(1 - Number(this.record.meta?.backgroundDim ?? 0.6) * 0.37, 0.35, 1)})`;
              c.drawImage(surface, -customW / 2, -customH / 2, customW, customH);
              c.filter = "none";
            } else {
              const customH = officialThickness * 3;
              // A direct PGR extension texture has no line.csv sizing metadata;
              // retain the established full-line fallback and do not recolor it.
              c.drawImage(custom, lineFrom, -customH / 2, lineWidth, customH);
            }
          } else {
            c.fillStyle = lineColor;
            c.fillRect(lineFrom, -officialThickness / 2, lineWidth, officialThickness);
          }
        }
        for (let li = 0; li < NOTE_RENDER_ORDER.length; li++) {
          const items = layers?.[NOTE_RENDER_ORDER[li]];
          if (!items) continue;
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            this.drawNote(item.L, item.n, t, true, Infinity);
          }
        }
      }
      c.restore();
      c.save();
      c.setTransform(baseScale, 0, 0, baseScale, baseX, baseY);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      if (!chartRevealEnabled) { c.beginPath(); c.rect(0,0,w,h); c.clip(); }
      for (let i = 0; i < this.badGhosts.length; i++)
        this.drawBadGhost(c, this.badGhosts[i], frameNow);
      for (let i = 0; i < this.effects.length; i++) {
        const e = this.effects[i],
          age = (frameNow - e.at) / 1000;
        // Visual-fidelity lock: every accepted judgement keeps its complete
        // atlas animation and all authored particles until its natural duration
        // ends. Frame pressure may never delete an earlier burst or skip layers.
        if (this.chart.kind === "pjsk") drawPjskHitFx(c, e, age, this);
        else {
          drawHitFxFrame(c, this.pack, e.x, e.y, e.size || this.noteWidth || 96, age, !!e.good);
          drawHitParticles(c, e, age, 1);
        }
      }
      c.restore();
      const activeEffects = this.visibleEffectsAt(t);
      if (activeEffects.length) {
        if (!this.postProcessor)
          this.postProcessor = new PhiPostProcessor(this.canvas, this.shaderSources);
        if (this.postProcessor.render(activeEffects, t, (e) => this.effectScissor(e)))
          this.hideForegroundFxUnderlay();
        else this.drawExtraEffectsFallback(t, activeEffects);
      } else {
        this.postProcessor?.disable();
        this.hideForegroundFxUnderlay();
      }
      drawNativeNoiseOverlay(this,t);
    }
    drawNote(L, n, t, coverEnabled = true, appearBefore = Infinity) {
      const isHold = n.type === 3,
        holdEnd = n.end || n.time,
        holdJudged = isHold && n.state === 1,
        lateMissVisual =
          !isHold &&
          n.state === 1 &&
          n.judge === "miss" &&
          t < n.time + NOTE_FADEOUT_TIME;
      if (isHold && (n._nativeHoldHidden || n.nativeHoldHidden)) return;
      if (n.state === 1 && !isHold && !lateMissVisual) return;
      // Fake Click/Drag/Flick keep their authored behavior and vanish at the
      // line. Real unhit notes continue below the line while fading for 160 ms.
      if (n.fake && !isHold && t >= n.time) return;
      if (n.fake && isHold && t >= holdEnd) return;
      if (holdJudged && t >= holdEnd) return;
      if (
        this.chart.kind === "rpe" &&
        Number.isFinite(n.visibleTime) &&
        n.visibleTime < n.time &&
        t < n.time - n.visibleTime
      )
        return;
      if (
        Number.isFinite(appearBefore) &&
        appearBefore !== Infinity &&
        t < n.time - appearBefore
      )
        return;
      let p = this.notePoint(L, n, t),
        future = t < n.time - 1e-6;
      if (future && coverEnabled) {
        if (isHold) {
          const endFloor = n.endFloor ?? n.floor,
            endRaw =
              (endFloor - p.line.cur) *
              (Number.isFinite(n._speedN) ? n._speedN : Number(n.speed || 1)),
            partial =
              !!n.fake ||
              !!n.visualCritical ||
              !!this.record.meta?.holdPartialCover;
          if (partial) {
            if (p.rawBase <= -COVER_EPS && endRaw <= -COVER_EPS) return;
          } else if (p.rawBase <= -COVER_EPS) return;
        } else if (p.rawBase <= -COVER_EPS) return;
      }
      if (!isHold && t >= n.time + NOTE_FADEOUT_TIME) return;
      // The head of every Hold, including an unjudged/fake Hold, stays on the
      // judgement line after its start while the body shrinks toward the tail.
      if (isHold && t >= n.time) {
        const q = this.noteJudgePoint(L, n, t);
        p.x = q.x;
        p.y = q.y;
        p.along = q.along;
        p.dist = 0;
        p.rawBase = 0;
      }
      const c = this.ctx,
        nw = Number.isFinite(n._nw)
          ? n._nw
          : (this.noteWidth || Math.min(this.w, (this.h * 16) / 9) * (this.chart.kind === "pjsk" ? 0.065 : 0.15625)) *
            clamp(Number(n.size || 1), 0.05, 8) *
            noteSizeScale * this.packageNoteScale,
        nh = Number.isFinite(n._nh) ? n._nh : Math.max(3, nw * NOTE_THICKNESS_RATIO),
        holdW = Number.isFinite(n._holdW) ? n._holdW : nw * HOLD_WIDTH_RATIO,
        fade = isHold
          ? 1
          : clamp(1 - Math.max(0, t - n.time) / NOTE_FADEOUT_TIME, 0, 1);
      let alpha = (Number.isFinite(n._alphaN) ? n._alphaN : n.alpha ?? 1) * fade;
      if (isHold && n.holdMiss) alpha *= HOLD_MISS_ALPHA;
      if (alpha <= 0.001) return;
      if (isHold) {
        const endFloor = n.endFloor ?? n.floor,
          speedN = Number.isFinite(n._speedN) ? n._speedN : Number(n.speed || 1),
          authoredTailSide = Math.sign((endFloor - n.floor) * speedN) || 1;
        let endRaw = this.chart.kind === "pgr" ? (t < n.time ? n.floor-p.line.cur : 0) + Math.max(0,n.end-Math.max(t,n.time)) * (Number(n.sourceSpeed)||0) : (endFloor - p.line.cur) * speedN;
        if (t >= n.time) endRaw = Math.max(0, endRaw * authoredTailSide) * authoredTailSide;
        const endDist =
            (endRaw * this.h * 0.34 * noteSpeedScale +
              (Number.isFinite(n._yOffsetPx) ? n._yOffsetPx : 0)) *
            (n.above ? -1 : 1),
          ex = p.line.cx + p.line.ux * p.along + p.line.vx * endDist,
          ey = p.line.cy + p.line.uy * p.along + p.line.vy * endDist,
          margin = Math.max(holdW * 1.25, nw * 1.10, this.noteWidth * 1.5, 8),
          minX = Math.min(p.x, ex) - margin,
          maxX = Math.max(p.x, ex) + margin,
          minY = Math.min(p.y, ey) - margin,
          maxY = Math.max(p.y, ey) + margin;
        const vis = this.visibleLogicalBounds;
        if (
          maxX < vis.left ||
          minX > vis.right ||
          maxY < vis.top ||
          minY > vis.bottom
        )
          return;
        const dx = ex - p.x,
          dy = ey - p.y,
          len = Math.hypot(dx, dy);
        if (len > 0.35) {
          const vx = dx / len,
            vy = dy / len,
            s = this.frameCanvasScale,
            ox = this.frameCanvasOffsetX,
            oy = this.frameCanvasOffsetY;
          c.setTransform(
            s * p.line.ux,
            s * p.line.uy,
            s * vx,
            s * vy,
            ox + s * p.x,
            oy + s * p.y,
          );
          c.globalAlpha = alpha;
          c.globalCompositeOperation = "source-over";
          if (!drawPackHoldRibbon(c, this.pack, holdW, len, !!n.multi, t >= n.time))
            drawCachedHoldRibbon(c, holdW, len, !!n.multi, !!n.holdMiss, this.holdSkinCache);
          if (Array.isArray(n.tint) && n.tint.length >= 3) {
            c.globalCompositeOperation = "source-atop";
            c.fillStyle = `rgb(${clamp(Number(n.tint[0]) || 0,0,255)},${clamp(Number(n.tint[1]) || 0,0,255)},${clamp(Number(n.tint[2]) || 0,0,255)})`;
            c.fillRect(-holdW / 2, 0, holdW, len);
            c.globalCompositeOperation = "source-over";
          }
          this.metricsDrawnNotes++;
        }
        return;
      }
      const visible = this.visibleLogicalBounds,
        displayH = Number.isFinite(n._imgHeight) ? n._imgHeight : Math.max(nh, nw * NOTE_THICKNESS_RATIO),
        halfAlong = nw * 0.5,
        halfAcross = displayH * 0.5,
        edgeEpsilon = 2 / Math.max(1, this.dpr || 1),
        extentX = Math.abs(p.line.ux) * halfAlong + Math.abs(p.line.vx) * halfAcross + edgeEpsilon,
        extentY = Math.abs(p.line.uy) * halfAlong + Math.abs(p.line.vy) * halfAcross + edgeEpsilon;
      // Correctness-only cull: reject only when the complete transformed artwork
      // is outside. If a Note is half outside, its intersecting half is drawn now.
      if (
        p.x + extentX < visible.left || p.x - extentX > visible.right ||
        p.y + extentY < visible.top || p.y - extentY > visible.bottom
      ) return;
      const key = n._skinKey || (n.type === 1 ? "tap" : n.type === 2 ? "drag" : "flick"),
        imgKey = n._imgKey || null,
        img = n._img || (imgKey ? this.pack?.images?.[imgKey] : null);
      const flipY = (n.faceFlip ?? !n.above) ? -1 : 1,
        s = this.frameCanvasScale,
        ox = this.frameCanvasOffsetX,
        oy = this.frameCanvasOffsetY;
      c.setTransform(
        s * p.line.ux,
        s * p.line.uy,
        s * p.line.vx * flipY,
        s * p.line.vy * flipY,
        ox + s * p.x,
        oy + s * p.y,
      );
      c.globalAlpha = alpha;
      c.globalCompositeOperation = "source-over";
      if (img) {
        const dw = nw,
          dh = Number.isFinite(n._imgHeight)
            ? n._imgHeight
            : normalizedTextureHeight(this.pack, imgKey, key, nh, nw),
          b = n._imgBounds || this.pack?.imageBounds?.[imgKey];
        // Custom pack textures are final artwork. Do not add a second coat.
        if (b) {
          const sx = Math.max(0, Math.floor(Number(b.sx) || 0)),
            sy = Math.max(0, Math.floor(Number(b.sy) || 0)),
            ex = Math.min(img.naturalWidth || img.width, Math.ceil((Number(b.sx) || 0) + (Number(b.sw) || 0))),
            ey = Math.min(img.naturalHeight || img.height, Math.ceil((Number(b.sy) || 0) + (Number(b.sh) || 0)));
          c.drawImage(img, sx, sy, Math.max(1, ex - sx), Math.max(1, ey - sy), -dw / 2, -dh / 2, dw, dh);
        } else c.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      } else {
        const skin = defaultNoteSkin(
          this.noteSkinCache,
          n.type,
          !!n.multi && !this.pack,
          nw,
          nh,
        );
        c.drawImage(skin.canvas, -skin.w / 2, -skin.h / 2, skin.w, skin.h);
      }
      if (Array.isArray(n.tint) && n.tint.length >= 3) {
        c.globalCompositeOperation = "source-atop";
        c.fillStyle = `rgb(${clamp(Number(n.tint[0]) || 0,0,255)},${clamp(Number(n.tint[1]) || 0,0,255)},${clamp(Number(n.tint[2]) || 0,0,255)})`;
        c.fillRect(-nw / 2, -displayH / 2, nw, displayH);
        c.globalCompositeOperation = "source-over";
      }
      this.metricsDrawnNotes++;
    }
    settleResultJudgements() {
      const at = this.time;
      this.update(at, performance.now(), at);
      for (const {L,n} of this.noteItems) {
        if (n.fake || n.state === 1) continue;
        if (this.chart.kind === "pjsk") {
          if (!n._sekaiHeadDone) {
            if (!n._pjskHeadHidden) recordPjskJudge(this,n,4,0,L,false);
            n._sekaiHeadDone = true;
          }
          if (n.type === 3) {
            const ticks = n._pjskTicks || [];
            for (let i = n._sekaiTickIndex || 0; i < ticks.length; i++) recordPjskJudge(this,n,4,0,L,false);
            n._sekaiTickIndex = ticks.length;
            if (!n._sekaiTailDone && !n._pjskTailHidden) recordPjskJudge(this,n,4,0,L,false);
            n._sekaiTailDone = true;
          }
          n.state = 1;
        } else this.commit(n,3,0,L);
      }
      this.updateHUD();
      this.paintProgress(1);
    }
    finish() {
      if (!this.running || this.referenceFinishing) return;
      this.settleResultJudgements();
      performanceMonitor.refresh(this);
      const token=++this.transitionToken;
      this.referenceFinishing=true;
      this.running=false;this.paused=true;this.resumePending=false;this.starting=false;
      this.hideCountdown();this.cancelLoop();this.stopAudioPump();this.stopMusic(false);this.clearPointerStates();
      const view=$("#gameView"), delay=this.chart.kind==="pjsk"?0:3900;
      view.classList.toggle("phiHasOutroLine",!!this.frameLines?.some(line=>line?.alpha>.01));
      view.classList.remove("phiStageIntro");view.classList.add("phiStageOutro");
      clearTimeout(this.referenceFinishTimer);
      this.referenceFinishTimer=setTimeout(()=>{
        if(token!==this.transitionToken || !this.referenceFinishing)return;
        this.referenceFinishing=false;view.classList.remove("phiStageOutro");showResults(this);
      },delay);
    }
  }

  let resultArtworkURL = "";
  function clearResultArtwork() {
    if (resultArtworkURL) {
      try {
        URL.revokeObjectURL(resultArtworkURL);
      } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      resultArtworkURL = "";
    }
    const jacket = $("#resultJacketBg"),
      backdrop = $("#resultBackdrop"), profile = $("#resultProfileArt");
    if (jacket) jacket.style.backgroundImage = "";
    if (backdrop) backdrop.style.backgroundImage = "";
    if (profile) profile.style.backgroundImage = "";
  }
  function applyResultArtwork(record) {
    clearResultArtwork();
    if (record?.bgBlob)
      try {
        resultArtworkURL = URL.createObjectURL(record.bgBlob);
        const img = `url('${resultArtworkURL}')`,
          jacket = $("#resultJacketBg"),
          backdrop = $("#resultBackdrop"), profile = $("#resultProfileArt");
        if (jacket) jacket.style.backgroundImage = img;
        if (backdrop) backdrop.style.backgroundImage = img;
        if (profile) { if(dualMenuMode==="pjsk")profile.style.backgroundImage=img;else profile.style.removeProperty("background-image"); }
      } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
  }
  function resultGradeFor(e, s, counts = e.counts) {
    const total=Number(e.total)||0, complete=total>0&&counts.reduce((a,b)=>a+b,0)===total;
    if (!(total>0)) return "F";
    return complete && counts[0] === total
      ? "Φ"
      : complete && counts[2] + counts[3] === 0
        ? "V"
        : s >= 960000
          ? "V"
          : s >= 920000
            ? "S"
            : s >= 880000
              ? "A"
              : s >= 820000
                ? "B"
                : s >= 700000
                  ? "C"
                  : "F";
  }
  function scoreFromCounts(counts, maxCombo, total) {
    if (!(total > 0)) return 0;
    if (counts[0] === total) return 1000000;
    const accuracy = total ? (counts[0] + counts[1] * 0.65) / total : 1;
    return Math.round((0.9 * accuracy + 0.1 * maxCombo / Math.max(1, total)) * 1000000);
  }
  function qualificationFor(engine) {
    const assistFlags = { autoplay: !!engine.usedAutoplay, invincible: !!engine.usedInvincible, reveal: !!engine.usedReveal, keyboard: !!engine.usedKeyboard, modeSwitch: !!engine.usedModeSwitch, pjskMode: engine.chart?.kind === "pjsk" };
    const ranked = !Object.values(assistFlags).some(Boolean);
    return { ranked, assistFlags, rulesetVersion: RULESET_VERSION, inputClass: assistFlags.keyboard ? "keyboard" : "pointer" };
  }
  function syncAssistIndicators(target = engine) {
    // Assistance still stays isolated from ranked best scores, but gameplay no
    // longer paints the red UNRANKED/AUTOPLAY banner over the chart.
    return target ? qualificationFor(target) : { ranked: true, assistFlags: {} };
  }
  function resultBestStorageKey(record) {
    const songIdentity = String(record?.scoreIdentity || record?.chartContentId || record?.id || record?.key || record?.name || "unknown");
    const difficultyIdentity = String(record?.difficulty ?? record?.difficultyName ?? record?.level ?? record?.meta?.level ?? difficultyCaptionFor(record));
    return RULESET_VERSION + "::" + encodeURIComponent(songIdentity + "::" + difficultyIdentity);
  }
  function legacyResultBestStorageKey(record) {
    const songIdentity = String(record?.id ?? record?.key ?? record?.chartId ?? record?.name ?? record?.meta?.name ?? "unknown");
    const difficultyIdentity = String(record?.difficulty ?? record?.difficultyName ?? record?.level ?? record?.meta?.level ?? difficultyCaptionFor(record));
    return "phi.offline.bestScore.v1::" + encodeURIComponent(songIdentity + "::" + difficultyIdentity);
  }
  function fallbackGradeForStoredScore(score) {
    const s = Math.max(0, Math.min(1000000, Math.round(Number(score) || 0)));
    return s >= 1000000 ? "Φ" : s >= 960000 ? "V" : s >= 920000 ? "S" : s >= 880000 ? "A" : s >= 820000 ? "B" : s >= 700000 ? "C" : s > 0 ? "F" : "—";
  }
  function loadStoredBestScore(record) {
    const key = resultBestStorageKey(record), cached = scoreCache.get(key);
    if (cached) return Math.max(0, Math.min(1000000, Math.round(Number(cached.score) || 0)));
    try {
      const value = Number(localStorage.getItem(legacyResultBestStorageKey(record)));
      if (Number.isFinite(value) && value > 0) {
        const migrated = { key, score: Math.round(value), grade: fallbackGradeForStoredScore(value), ranked: true, rulesetVersion: RULESET_VERSION, chartContentId: record?.chartContentId || record?.id || "", migratedFrom: "localStorage-v1" };
        scoreCache.set(key, migrated); if (storageReady) dbPutScore(migrated).catch(() => {});
        return migrated.score;
      }
    } catch (error) { Diagnostics.warn("Result.bestScore.migrate", error?.message || String(error)); }
    return 0;
  }
  function loadStoredBestGrade(record, score = loadStoredBestScore(record)) {
    return String(scoreCache.get(resultBestStorageKey(record))?.grade || fallbackGradeForStoredScore(score));
  }
  function updateResultNewBest(record, score, grade = "", qualification = { ranked: true }) {
    const row = $("#resultNewBestLine"), previousEl = $("#resultPreviousBest"), deltaEl = $("#resultScoreDelta");
    if (!row || !qualification.ranked) { row?.classList.add("hidden"); return false; }
    const previous = loadStoredBestScore(record), current = Math.max(0, Math.min(1000000, Math.round(score))), isNewBest = current > previous;
    row.classList.toggle("hidden", !isNewBest);
    if (isNewBest) {
      if (previousEl) previousEl.textContent = fmtScore(previous);
      if (deltaEl) deltaEl.textContent = "+" + String(current - previous).padStart(7, "0");
      const value = { key: resultBestStorageKey(record), score: current, grade: grade || fallbackGradeForStoredScore(current), ranked: true,
        rulesetVersion: RULESET_VERSION, engineVersion: PHI_VERSIONS.runtime, chartContentId: record?.chartContentId || record?.id || "",
        assistFlags: qualification.assistFlags, inputClass: qualification.inputClass, updatedAt: new Date().toISOString() };
      scoreCache.set(value.key, value); dbPutScore(value).catch((error) => Diagnostics.warn("Result.bestScore.write", error?.message || String(error)));
    } else { if (previousEl) previousEl.textContent = ""; if (deltaEl) deltaEl.textContent = ""; }
    return isNewBest;
  }
  let pausedModeSwitchBusy = false;
  function syncPausedPjskControls() {
    const button = $("#pausePjskBtn"), lanes = $("#pausePjskLanes"), active = engine?.chart?.kind === "pjsk";
    if (button) {
      button.textContent = engine?.chart?.nativePjsk ? "PJSK · 原生 SUS" : active ? "PJSK · 关闭" : "PJSK · 开启";
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = pausedModeSwitchBusy || !engine?.paused || !!engine?.chart?.nativePjsk;
    }
    if (lanes) {
      if (active && !pausedModeSwitchBusy) lanes.value = String(engine.chart.pjskLaneCount || PJSK_DEFAULT_LANES);
      else if (!active && !pausedModeSwitchBusy) {
        try { lanes.value = String(clamp(Number(localStorage.getItem("phi.pjsk.lanes")) || PJSK_DEFAULT_LANES, PJSK_MIN_LANES, PJSK_MAX_LANES)); } catch {}
      }
      lanes.disabled = pausedModeSwitchBusy || !engine?.paused || !!engine?.chart?.nativePjsk;
    }
    for (const id of ["#resumeBtn", "#restartBtn", "#quitBtn", "#pauseSeekRange"])
      if ($(id)) $(id).disabled = pausedModeSwitchBusy;
  }
  async function switchPausedPjskMode(enable, requestedLanes) {
    const previous = engine;
    if (pausedModeSwitchBusy || !previous?.running || !previous.paused || previous.starting || previous.resumePending || previous.chart.nativePjsk) return;
    const lanes = clamp(Math.round(Number(requestedLanes) || PJSK_DEFAULT_LANES), PJSK_MIN_LANES, PJSK_MAX_LANES);
    if ((previous.chart.kind === "pjsk") === !!enable && (!enable || previous.chart.pjskLaneCount === lanes)) return;
    pausedModeSwitchBusy = true;
    syncPausedPjskControls();
    const offset = previous.musicCurrentTime(), rate = previous.musicRate, record = previous.record,
      previousPjsk = previous.chart.kind === "pjsk", previousLanes = previous.chart.pjskLaneCount || lanes,
      assist = { autoplay: previous.autoplay, invincible: previous.invincibleMode,
        usedAutoplay: previous.usedAutoplay, usedInvincible: previous.usedInvincible,
        usedReveal: previous.usedReveal, usedKeyboard: previous.usedKeyboard };
    let stopped = false;
    const mountPausedEngine = async (chart) => {
      const next = new Engine(record, chart, previous.pack);
      try {
        await next.init();
        next.autoplay = assist.autoplay; next.invincibleMode = assist.invincible;
        next.usedAutoplay = assist.usedAutoplay; next.usedInvincible = assist.usedInvincible;
        next.usedReveal = assist.usedReveal; next.usedKeyboard = assist.usedKeyboard;
        next.usedModeSwitch = true;
        next.musicRate = rate; next.audio.playbackRate = rate;
        next.running = true; next.paused = true;
        next.mountGameplayBackground(true);
        await next.preparePerformanceBackground();
        next.warmPostProcessing(); next.lockLayout();
        next.seekPausedMusic(offset);
        engine = next; window.__phiEngine = next;
        document.body.classList.toggle("pjskModeActive", chart.kind === "pjsk");
        syncPjskAutoNoteSizeUI(); syncPauseTransportUI(next);
        return next;
      } catch (error) { next.stop("mode-switch-failed"); throw error; }
    };
    try {
      const source = applyRecordChartMetadata(parseChart(record.parser, record.chartText, null, record.meta || {}), record);
      const chart = enable ? convertChartToPjsk(source, lanes) : source;
      previous.stop("mode-switch"); stopped = true;
      await mountPausedEngine(chart);
      try { localStorage.setItem("phi.pjsk.lanes", String(lanes)); } catch {}
      toast(`已切换${enable ? ` PJSK ${lanes}K` : "原谱模式"}，曲目位置保留；切换后的本局成绩重新计算`, false, 5200);
    } catch (error) {
      Diagnostics.warn("GameState.mode-switch", error?.message || String(error));
      if (stopped) {
        try {
          const source = applyRecordChartMetadata(parseChart(record.parser, record.chartText, null, record.meta || {}), record);
          await mountPausedEngine(previousPjsk ? convertChartToPjsk(source, previousLanes) : source);
        } catch (restoreError) {
          Diagnostics.error("GameState.mode-restore", restoreError);
          await backToLibrary();
        }
      }
      toast(`切换 PJSK 失败：${error?.message || error}`, true, 7000);
    } finally {
      pausedModeSwitchBusy = false; syncPausedPjskControls();
    }
  }
  async function startChart(rec, loadingPrepared = false, playOptions = null) {
    const loadToken=playOptions?.loadToken??++songLoadToken;
    try {
      clearResultArtwork();
      if (!loadingPrepared) await beginLoadingPresentation(rec, rec?.bgBlob || libraryFocusBgBlob);
      currentRecord = rec;
      suspendLibraryVisuals();
      await nextVisualCommit();
      await (playOptions?.preparation || Promise.all([ensureBuiltinMaterialForPlay(),loadSavedOrAdjacentOfficialFont()]));
      assertSongLoad(loadToken);
      const parsedChart = applyRecordChartMetadata(parseChart(rec.parser, rec.chartText, null, rec.meta || {}), rec),
        usePjsk = playOptions?.mode === "pjsk" || (!playOptions?.mode && dualMenuMode === "pjsk"),
        chart = usePjsk ? convertChartToPjsk(parsedChart, playOptions?.lanes || 12) : parsedChart;
      if(chart.compatibilityReport?.warnings?.length)Diagnostics.warn("Chart.compatibility",chart.compatibilityReport.warnings.join("；"));
      document.body.classList.toggle("pjskModeActive", chart.kind === "pjsk");
      engine?.stop();
      if(playOptions?.offlineExport)phiExportViewport?.syncRoot();
      engine = new Engine(rec, chart, activePack);
      engine._offlineExport=!!playOptions?.offlineExport;
      engine._exportDpr=Number(playOptions?.exportDpr)||1;
      await prepareNativeBlockTextures(chart);
      assertSongLoad(loadToken);
      syncPjskAutoNoteSizeUI();
      engine.audioWakePromise = firstPlayAudioPrime;
      firstPlayAudioPrime = null;
      window.__phiEngine = engine;
      syncGameViewportCSS();
      $("#gameView").classList.remove("hidden");
      await nextVisualCommit();
      // Fill caption slots before initialization/prewarming can snapshot HUD.
      applyGameMetadata(rec);
      await engine.prepareHostedArtwork();
      assertSongLoad(loadToken);
      await engine.init();
      assertSongLoad(loadToken);
      $("#libraryView").classList.add("hidden");
      $("#resultView").classList.add("hidden");
      syncGameViewportCSS();
      applyGameMetadata(rec);
      $("#gameView").classList.remove("hidden");
      // iPad WebKit may discard Blob image textures created while an ancestor was
      // display:none. Bind again only after the gameplay tree is actually visible.
      engine.mountGameplayBackground(true);
      performanceMonitor.setGameActive(true);
      await new Promise((r) =>
        requestAnimationFrame(() => {
          syncGameViewportCSS();
          engine.resize();
          engine.mountGameplayBackground(true);
          r();
        }),
      );
      // 40.0.0: never enter fullscreen automatically. Keep the browser's
      // current viewport and let the user/browser own fullscreen state.
      await sleep(32);
      syncGameViewportCSS();
      engine.resize();
      engine.mountGameplayBackground(true);
      await engine.preparePerformanceBackground();
      assertSongLoad(loadToken);
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
      syncGameViewportCSS();
      engine.resize();
      engine.mountGameplayBackground(true);
      engine.warmPostProcessing();
      engine.lockLayout();
      await finishLoadingPresentation(loadToken);
      assertSongLoad(loadToken);
      if(playOptions?.offlineExport){
        engine.reset();engine.running=true;engine.paused=true;engine.starting=false;
        performanceMonitor.setGameActive(false);return;
      }
      await engine.start(false);
    } catch (e) {
      if(e.name==='AbortError'||loadToken!==songLoadToken)return;
      performanceMonitor.setGameActive(false);
      cancelLoadingPresentation();
      try { engine?.stop(); } catch {}
      engine = null;
      $("#gameView")?.classList.add("hidden");
      $("#resultView")?.classList.add("hidden");
      $("#libraryView")?.classList.remove("hidden");
      resumeLibraryVisuals();
      toast(`无法开始：${e.message}`, true, 7000);
      if(playOptions?.offlineExport)throw e;
    }
  }
  // All reference measurements use the recording's 682 x 512 logical frame.
  // Text remains live text and gameplay remains the normal interactive engine.
  let referenceRouteToken = 0, referenceInitialSelection = false;
  function syncReferenceViewport() {
    const sourceRoot=document.documentElement,vv=window.visualViewport;
    const read=(view,root)=>({
      w:Math.max(1,Math.round(Number(view?.width)>=8?view.width:root.clientWidth||innerWidth||682)),
      h:Math.max(1,Math.round(Number(view?.height)>=8?view.height:root.clientHeight||innerHeight||512)),
      x:Math.max(0,Number(view?.offsetLeft)||0),y:Math.max(0,Number(view?.offsetTop)||0)
    });
    const apply=(root,box)=>{
      const {w,h,x,y}=box;
      for(const [key,value]of Object.entries({'--ref-u':w/682,'--ref-y':h/512,'--ref-w':w,'--ref-h':h,'--scene-u':w/682,'--scene-y':h/512,'--phi-visible-w':w,'--phi-visible-h':h,'--phi-visible-x':x,'--phi-visible-y':y}))root.style.setProperty(key,`${value}px`);
    };
    const visible=read(vv,sourceRoot);apply(sourceRoot,visible);
    if(phiExportViewport?.document){
      const fixed={w:phiExportViewport.width,h:phiExportViewport.height,x:0,y:0};
      apply(phiExportViewport.document.documentElement,fixed);return{w:fixed.w,h:fixed.h};
    }
    return{w:visible.w,h:visible.h};
  }
  function referenceScene(name) {
    const previous=document.body.dataset.referenceScene;
    if(name==='home'&&previous&&previous!=='home')globalThis.PhiOpening?.show(false);
    else if(name!=='home')globalThis.PhiOpening?.stop();
    for (const [id,scene] of [["#refHome","home"],["#refCollection","collection"],["#refInterlude","interlude"]])
      $(id)?.classList.toggle("hidden",scene!==name);
    $("#libraryView")?.classList.toggle("hidden",name!=="library");
    document.body.dataset.referenceScene=name;
    syncReferenceViewport();
    if (name==="library") requestAnimationFrame(()=>centerReferenceSelection(libraryFocusCard,false));
  }
  async function referenceEnterLibrary() {
    const token=++referenceRouteToken;
    referenceScene("interlude");
    await sleep(matchMedia("(prefers-reduced-motion: reduce)").matches?30:2650);
    if (token===referenceRouteToken) referenceScene("library");
  }
  let referenceScrollFrame=0;
  function updateReferenceRows() {
    referenceScrollFrame=0;
    if (document.body.dataset.menuMode!=="phi") return;
    const list=$("#chartList"), box=list?.getBoundingClientRect();
    if (!box) return;
    const w=window.visualViewport?.width || document.documentElement.clientWidth || 682,
      h=window.visualViewport?.height || document.documentElement.clientHeight || 512,
      chosen=libraryFocusCard?._groupItems?.[libraryFocusCard?._selectedDifficulty||0],
      tier=difficultyInfoFor(chosen||{}).tier;
    for (const card of list.querySelectorAll(".card")) {
      const rect=card.getBoundingClientRect(), y=(rect.top+rect.height/2)/h*512,
        indent=clamp(66-(y-212)*.25,2,124);
      card.style.setProperty("--ref-row-indent",`${indent*w/682}px`);
      card.dataset.refNoTier=String(tier==="AT" && !card._groupItems?.some(item=>difficultyInfoFor(item).tier==="AT"));
    }
  }
  function centerReferenceSelection(card,smooth=true) {
    if (!card?.isConnected || document.body.dataset.menuMode!=="phi") return;
    const host=$("#chartList"), box=host.getBoundingClientRect(), rect=card.getBoundingClientRect(),
      h=window.visualViewport?.height || document.documentElement.clientHeight || 512,
      target=host.scrollTop+rect.top+rect.height/2-h*212/512;
    host.scrollTo({top:Math.max(0,target),behavior:smooth?"smooth":"instant"});
    updateReferenceRows();
  }
  function referenceSelectInitialTrack() {
    if (referenceInitialSelection) { updateReferenceRows(); return; }
    const match=[...$("#chartList").querySelectorAll(".card")].find(card=>
      card._groupItems?.some(item=>libraryPayload(item).id?.startsWith("leave-all-behind-")));
    if (!match) return;
    referenceInitialSelection=true;
    focusLibraryCard(match);
    requestAnimationFrame(()=>centerReferenceSelection(match,false));
  }
  function installReferenceUI() {
    syncReferenceViewport();
    $("#refHome").onclick=()=>{
      if (document.body.dataset.referenceScene!=="home") return;
      if(globalThis.PhiOpening&&!PhiOpening.readyForStart()){PhiOpening.enableFromGesture();return;}
      ++referenceRouteToken;
      Engine.primeAudioFromGesture(false);
      referenceScene("collection");
    };
    $("#refCollectionBack").onclick=()=>{++referenceRouteToken;referenceScene("home");};
    $('#loadingBack').onclick=()=>{
      ++songLoadToken;
      songLoadStream?.destroy();
      if(songLoadStream){songLoadStream.audio.pause();songLoadStream.audio.removeAttribute('src');songLoadStream.audio.load();songLoadStream=null;}
      try{engine?.stop();}catch{}
      engine=null;currentRecord=null;performanceMonitor.setGameActive(false);
      $('#gameView').classList.add('hidden');
      cancelLoadingPresentation();resumeLibraryVisuals();referenceScene('library');
    };
    $("#refLibraryBack").onclick=()=>{++referenceRouteToken;referenceScene("collection");};
    for (const button of document.querySelectorAll("[data-reference-open-library]")) button.onclick=referenceEnterLibrary;
    $("#refCollectionSettings").onclick=openSettingsPanel;
    $("#refCourse").onclick=(event)=>{
      event.stopPropagation();
      referenceEnterLibrary().then(()=>{setLibraryMoreOpen(true);});
    };
    const tabs=$(".dualModeTabs");
    if (tabs) $("#libraryMoreSheet").appendChild(tabs);
    $("#phiVideoSort b").textContent="等级降序";
    $("#rEarly").parentElement.classList.add("refEarly");
    $("#rLate").parentElement.classList.add("refLate");
    for (const profile of [$(".libraryOfficialProfile"),$(".resultProfile")]) {
      const name=profile.querySelector("b");if(name)name.textContent="TYC";
      const level=document.createElement("div");level.className="refPlayerLevel";
      level.innerHTML="<b>50</b><span>15.62</span>";profile.appendChild(level);
    }
    $("#resultRetry").innerHTML='<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M24 9a11 11 0 1 0 2 12M24 2v9H15"/></svg>';
    $("#resultBack").innerHTML='<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 16h22M19 7l9 9-9 9"/></svg>';
    $("#chartList").addEventListener("scroll",()=>{
      if (!referenceScrollFrame) referenceScrollFrame=requestAnimationFrame(updateReferenceRows);
    },{passive:true});
    window.addEventListener("resize",()=>{syncReferenceViewport();updateReferenceRows();applyResultGeometry();},{passive:true});
    window.visualViewport?.addEventListener("resize",syncReferenceViewport,{passive:true});
    window.visualViewport?.addEventListener("scroll",()=>{
      syncReferenceViewport();if(engine&&!engine._offlineExport)engine.bound.resize();
    },{passive:true});
    document.fonts?.addEventListener?.("loadingdone",()=>{
      if(engine){engine.nativeNoiseHudCache=null;engine.pjskExportHudCache=null;}
    });
    document.addEventListener("keydown",event=>{
      if(event.key!=="Escape" || !["home","collection","interlude"].includes(document.body.dataset.referenceScene))return;
      ++referenceRouteToken;referenceScene("home");
    });
    referenceScene(new URLSearchParams(location.search).has("skipIntro")?"library":"home");
  }

  // Lossless schema/column storage only; none of the authored chart values change.
  function decodePackedNativeChart(bytes){return PhiChartCodec.decodePacked(bytes);}

  async function decompressNativeChartLzma(packed,expectedSize){
    if(!globalThis.PhiChartCodec)await loadHostedScript('./js/chart-codec.js');
    if(!window.LZMA)await loadHostedScript('./js/vendor/lzma.js');
    const bytes=await new Promise((resolve,reject)=>{
      window.LZMA.decompress(packed,(result,error)=>{
        if(error){reject(error);return;}
        resolve(typeof result==='string'?new TextEncoder().encode(result):Uint8Array.from(result));
      });
    });
    if(bytes.length!==expectedSize)throw new Error('内置谱面解压长度不一致');
    return bytes;
  }

  // Native blockAreaList playback. Geometry/mask/shader ports reference
  // Phira-Pro (GPL-3.0); the full license and readable shader source are embedded.
  const BLOCK_EASE_TABLES=Array.from({length:15},(_,type)=>Float32Array.from({length:101},(_,i)=>{
    const u=i/100;if(type===0)return u;if(type===13)return 0;if(type===14)return 1;
    const p=Math.floor((type-1)/3)+2,k=(type-1)%3;
    return k===0?u**p:k===1?1-(1-u)**p:u<.5?2**(p-1)*u**p:1-(2-2*u)**p/2;
  }));
  function blockEase(type,u){u=Math.max(0,Math.min(1,u));const p=u*100,i=Math.floor(p),a=BLOCK_EASE_TABLES[type]||BLOCK_EASE_TABLES[0];return i>=100?a[100]:a[i]+(p-i)*(a[i+1]-a[i]);}
  function blockLast(events,t){let lo=0,hi=events.length;while(lo<hi){const m=(lo+hi)>>>1;if(events[m].time<=t)lo=m+1;else hi=m;}return lo-1;}
  function blockPair(v,def=0){return {x:Number.isFinite(+v?.x)?+v.x:def,y:Number.isFinite(+v?.y)?+v.y:def};}
  function prepareNativeBlocks(list){return (Array.isArray(list)?list:[]).map((b,id)=>({
    ...b,id,topRightPercentage:blockPair(b.topRightPercentage),bottomLeftPercentage:blockPair(b.bottomLeftPercentage),
    appearTime:+b.appearTime,enableTime:+b.enableTime,disableTime:+b.disableTime,disappearTime:+b.disappearTime,isSubtract:!!b.isSubtract,
    moveEvents:(b.moveEvents||[]).map(e=>({...e,time:+e.time,endPosition:blockPair(e.endPosition)})).sort((a,b)=>a.time-b.time),
    rotateEvents:(b.rotateEvents||[]).map(e=>({...e,time:+e.time,anchor:blockPair(e.anchor),rotation:+e.rotation||0})).sort((a,b)=>a.time-b.time),
    scaleEvents:(b.scaleEvents||[]).map(e=>({...e,time:+e.time,anchor:blockPair(e.anchor),scale:blockPair(e.scale,1)})).sort((a,b)=>a.time-b.time)
  })).filter(b=>[b.appearTime,b.enableTime,b.disableTime,b.disappearTime].every(Number.isFinite));}
  const blockPrefixCache=new WeakMap();
  let phiPlayfieldMode = 'authored';
  function nativeBlockViewport(e) {
    const scale = Math.max(.0001, Number(e.viewScale) || 1),
      out = e.nativeBlockViewportRect || (e.nativeBlockViewportRect = {});
    out.x = -(Number(e.viewX) || 0) / scale;
    out.y = -(Number(e.viewY) || 0) / scale;
    out.w = (Number(e.surfaceW) || e.w) / scale;
    out.h = (Number(e.surfaceH) || e.h) / scale;
    out.aspect = out.w / out.h;
    return out;
  }
  function blockPct(p,aspect){return {x:2*p.x-1,y:(2*p.y-1)/aspect};}
  function blockScaleCenter(c,a,next,cur){const rx=Math.abs(cur.x)<1e-44?1:next.x/cur.x,ry=Math.abs(cur.y)<1e-44?1:next.y/cur.y;return{x:a.x+rx*(c.x-a.x),y:a.y+ry*(c.y-a.y)};}
  function blockRotateCenter(c,a,degrees){const r=degrees*Math.PI/180,s=Math.sin(r),q=Math.cos(r),x=c.x-a.x,y=c.y-a.y;return{x:a.x+q*x-s*y,y:a.y+s*x+q*y};}
  function nativeBlockTransform(b,t,aspect,out={center:{x:0,y:0}}){
    const se=b.scaleEvents,re=b.rotateEvents,me=b.moveEvents,si=se.length?Math.max(0,blockLast(se,t)):-1,ri=re.length?Math.max(0,blockLast(re,t)):-1,mi=me.length?Math.max(0,blockLast(me,t)):-1;
    let cache=blockPrefixCache.get(b);
    if(!cache||cache.aspect!==aspect){
      const scales=[{x:1,y:1,bx:0,by:0}],rotates=[{c:1,s:0,bx:0,by:0}];
      for(let k=0;k+1<se.length;k++){const a=blockPct(se[k].anchor,aspect),cur=se[k].scale,next=se[k+1].scale,rx=Math.abs(cur.x)<1e-44?1:next.x/cur.x,ry=Math.abs(cur.y)<1e-44?1:next.y/cur.y,p=scales[k];scales.push({x:rx*p.x,y:ry*p.y,bx:rx*p.bx+(1-rx)*a.x,by:ry*p.by+(1-ry)*a.y});}
      for(let k=0;k+1<re.length;k++){const a=blockPct(re[k].anchor,aspect),v=(re[k+1].rotation-re[k].rotation)*Math.PI/180,c=Math.cos(v),sn=Math.sin(v),p=rotates[k];rotates.push({c:c*p.c-sn*p.s,s:sn*p.c+c*p.s,bx:c*p.bx-sn*p.by+a.x-c*a.x+sn*a.y,by:sn*p.bx+c*p.by+a.y-sn*a.x-c*a.y});}
      const bl=blockPct(b.bottomLeftPercentage,aspect),tr=blockPct(b.topRightPercentage,aspect);
      cache={aspect,scales,rotates,x:(bl.x+tr.x)/2,y:(bl.y+tr.y)/2,hx:(tr.x-bl.x)/2,hy:(tr.y-bl.y)/2};blockPrefixCache.set(b,cache);
    }
    let sx=si<0?1:se[si].scale.x,sy=si<0?1:se[si].scale.y,rotation=ri<0?0:re[ri].rotation,cx=cache.x,cy=cache.y;
    if(si>=0&&si+1<se.length){const a=se[si],z=se[si+1],u=z.time>a.time?(t-a.time)/(z.time-a.time):1;sx+=blockEase(a.easeTypeX,u)*(z.scale.x-sx);sy+=blockEase(a.easeTypeY,u)*(z.scale.y-sy);}
    if(ri>=0&&ri+1<re.length){const a=re[ri],z=re[ri+1];rotation+=blockEase(a.easeType,z.time>a.time?(t-a.time)/(z.time-a.time):1)*(z.rotation-rotation);}
    if(si>=0){const p=cache.scales[si];cx=p.x*cx+p.bx;cy=p.y*cy+p.by;if(si+1<se.length){const a=se[si],ax=2*a.anchor.x-1,ay=(2*a.anchor.y-1)/aspect,rx=Math.abs(a.scale.x)<1e-44?1:sx/a.scale.x,ry=Math.abs(a.scale.y)<1e-44?1:sy/a.scale.y;cx=ax+rx*(cx-ax);cy=ay+ry*(cy-ay);}}
    if(ri>=0){const p=cache.rotates[ri],x=cx;cx=p.c*x-p.s*cy+p.bx;cy=p.s*x+p.c*cy+p.by;if(ri+1<re.length){const a=re[ri],ax=2*a.anchor.x-1,ay=(2*a.anchor.y-1)/aspect,r=(rotation-a.rotation)*Math.PI/180,sn=Math.sin(r),co=Math.cos(r),x=cx-ax,y=cy-ay;cx=ax+co*x-sn*y;cy=ay+sn*x+co*y;}}
    if(mi>=0){const a=me[mi];let x=a.endPosition.x,y=a.endPosition.y;if(mi+1<me.length){const z=me[mi+1],u=z.time>a.time?(t-a.time)/(z.time-a.time):1;x+=blockEase(a.easeTypeX,u)*(z.endPosition.x-x);y+=blockEase(a.easeTypeY,u)*(z.endPosition.y-y);}cx+=2*x-1-cache.x;cy+=(2*y-1)/aspect-cache.y;}
    out.center.x=cx;out.center.y=cy;out.hx=Math.abs(cache.hx*sx);out.hy=Math.abs(cache.hy*sy);out.angle=rotation*Math.PI/180;out.cos=Math.cos(out.angle);out.sin=Math.sin(out.angle);return out;
  }
  class NativeBlockTimeline {
    constructor(areas){this.areas=areas;this.events=areas.flatMap((b,i)=>b.appearTime<b.disappearTime?[[b.appearTime,i,true],[b.disappearTime,i,false]]:[]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||(+a[2])-(+b[2]));this.visible=new Set();this.cursor=0;this.time=-Infinity;this.ids=[];}
    at(t){
      let lo=0,hi=this.events.length;while(lo<hi){const m=(lo+hi)>>>1;if(this.events[m][0]<=t)lo=m+1;else hi=m;}const end=lo;let changed=end!==this.cursor;
      while(this.cursor>end){const [,id,on]=this.events[--this.cursor];if(on)this.visible.delete(id);else this.visible.add(id);}
      while(this.cursor<end){const [,id,on]=this.events[this.cursor++];if(on)this.visible.add(id);else this.visible.delete(id);}
      if(changed)this.ids=[...this.visible].sort((a,b)=>a-b);this.time=t;return this.ids;
    }
  }
  function nativeBlockZones(e,t){
    const areas=e.chart.kind==='pgr'?e.chart.blockAreas:[];if(!areas?.length)return [];
    const time=t+(Number(e.chart.offset)||0),aspect=nativeBlockViewport(e).aspect;
    if(!e.nativeBlockTimeline||e.nativeBlockTimeline.areas!==areas)e.nativeBlockTimeline=new NativeBlockTimeline(areas);
    if(e.nativeBlockFrame?.time===time&&e.nativeBlockFrame.aspect===aspect)return e.nativeBlockFrame.zones;
    const zones=e.nativeBlockZoneList||(e.nativeBlockZoneList=[]),pool=e.nativeBlockZonePool||(e.nativeBlockZonePool=[]);zones.length=0;
    for(const id of e.nativeBlockTimeline.at(time)){
      const b=areas[id];let z=pool[id];if(!z)z=pool[id]={center:{x:0,y:0}};nativeBlockTransform(b,time,aspect,z);if(!z.hx||!z.hy)continue;
      const active=time>=b.enableTime&&time<b.disableTime,ready=!active&&time<b.enableTime&&time>=b.enableTime-.5,
        opacity=!active&&!ready&&time<b.enableTime?Math.max(0,Math.min(1,(time-b.appearTime)/.5)):1;
      z.active=active;z.ready=ready;z.opacity=opacity;z.invert=b.isSubtract;zones.push(z);
    }
    const frame=e.nativeBlockFrame||(e.nativeBlockFrame={});frame.time=time;frame.aspect=aspect;frame.zones=zones;return zones;
  }
  function nativeBlockContains(z,x,y,aspect,inset=0){
    const dx=x-z.center.x,dy=y-z.center.y,c=z.cos??Math.cos(z.angle),s=z.sin??Math.sin(z.angle),px=c*dx+s*dy,py=-s*dx+c*dy,sgn=z.invert?1:-1,
      hx=z.hx*(1+2*sgn*Math.min(.25,inset/Math.max(1e-12,2*z.hx))),hy=z.hy*(1+2*sgn*Math.min(.25,inset/Math.max(1e-12,2*z.hy)));
    return Math.abs(px)<=hx&&Math.abs(py)<=hy;
  }
  function nativeBlockTouchBlocked(e,x,y,t=e.time,pid=null){
    if(e.chart.kind!=='pgr'||!e.chart.blockAreas?.length)return false;
    const contact=pid==null?null:e.pointer?.get(pid);if(contact?.noiseBlocked)return true;
    const viewport=nativeBlockViewport(e),aspect=viewport.aspect,px=2*(x-viewport.x)/viewport.w-1,py=(1-2*(y-viewport.y)/viewport.h)/aspect;let normal=0,sub=0;
    for(const z of nativeBlockZones(e,t)){if(!z.active)continue;if(nativeBlockContains(z,px,py,aspect,0)){if(z.invert)sub++;else normal=1;}}
    const blocked=normal!==(sub&1);if(blocked&&contact)contact.noiseBlocked=true;return blocked;
  }
  // GPU pass order, material parameters and shader bytes are taken from
  // Adai-add/PhiraiAd a60b49ad30b4748327df9a5fae794278a3978520 (GPL-3.0).
  // This bridge supplies browser canvases, chart rectangles and native contacts.
  let nativeBlockTextures=null,nativeBlockTexturePromise=null;
  async function prepareNativeBlockTextures(chart){
    if(chart.kind!=='pgr'||!chart.blockAreas?.length)return;
    if(!nativeBlockTexturePromise)nativeBlockTexturePromise=(async()=>{
      const node=$('#phiNativeBlockResources'),spec=JSON.parse(node.textContent||dec.decode(await PhiHostedMedia.bytes(node.dataset.src))),textures={};
      const entries=Object.entries(spec.textures);let next=0;
      await Promise.all(Array.from({length:Math.min(3,entries.length)},async()=>{
        while(next<entries.length){const [name,url]=entries[next++],image=new Image(),ready=new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;});image.src=url;await withTimeout(ready,12000,`噪域材质 ${name} 解码超时`);textures[name]=image;}
      }));
      nativeBlockTextures={...textures,...spec};return nativeBlockTextures;
    })().catch(error=>{nativeBlockTexturePromise=null;throw error;});
    return nativeBlockTexturePromise;
  }
  const NATIVE_GPU_IDENTITY=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  class NativeBlockRenderer {
    constructor(e){
      this.engine=e;this.canvas=document.createElement('canvas');this.small=document.createElement('canvas');this.smallCtx=this.small.getContext('2d',{alpha:false});this.targets=[];this.programs={};this.assets={};this.buffers=[];this.geometry=Array.from({length:6},()=>new Float32Array(0));this.versions=new Array(6).fill(0);this.scratch=[];this.hoverSlots=Array.from({length:10},()=>({id:null,scale:0,from:0,to:0,at:0,x:0,y:0,seen:false}));this.activeTouches=new Float32Array(20);this.activeTouchCount=0;
      this.gl=this.canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
      if(!this.gl)throw new Error('噪域需要设备的 WebGL 支持');
      this.onContextLost=event=>{event.preventDefault();this.lost=true;};
      this.canvas.addEventListener('webglcontextlost',this.onContextLost);
      // Rebuild on the next play. Never restart shader compilation in a live song.
      if(!(e.w>0&&e.h>0))throw new Error('噪域初始化前游戏画布尺寸无效');
      const areas=e.chart.blockAreas||[];for(const b of areas)nativeBlockTransform(b,b.appearTime,nativeBlockViewport(e).aspect);
      let cap=64;while(cap<Math.max(1,areas.length)*54)cap*=2;this.geometryArena={capacity:cap,a:Array.from({length:6},()=>new Float32Array(cap)),b:Array.from({length:6},()=>new Float32Array(cap)),lengths:new Int32Array(6),counts:new Int32Array(6)};
    }
    program(vert,frag){
      const gl=this.gl,p=gl.createProgram(),shaders=[];
      try {
        const compile=(type,source)=>{
          const shader=gl.createShader(type);shaders.push(shader);
          // No LOD intrinsics are used. Do not enable an unnecessary extension.
          source=source.replace(/#ifdef GL_EXT_shader_texture_lod\s*#extension GL_EXT_shader_texture_lod : enable\s*#endif/g,'');
          // Explicit matching varying precision is required by strict GLES linkers.
          source=source.replace(/varying\s+(?:(?:lowp|mediump|highp)\s+)?(vec[234]|float)\s+(uv|col)\s*;/g,'varying highp $1 $2;');
          gl.shaderSource(shader,source);gl.compileShader(shader);
          if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader)||'噪域着色器编译失败');
          gl.attachShader(p,shader);
        };
        compile(gl.VERTEX_SHADER,vert);compile(gl.FRAGMENT_SHADER,frag);gl.linkProgram(p);
        if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p)||'噪域着色器链接失败');
        const uniforms=new Map();for(let i=0;i<gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS);i++){const info=gl.getActiveUniform(p,i);uniforms.set(info.name.replace(/\[0\]$/,''),{location:gl.getUniformLocation(p,info.name),type:info.type});}
        const result={p,uniforms,position:gl.getAttribLocation(p,'position'),texcoord:gl.getAttribLocation(p,'texcoord'),color:gl.getAttribLocation(p,'color0')};
        gl.useProgram(p);this.uniform(result,'Model',NATIVE_GPU_IDENTITY);this.uniform(result,'Projection',NATIVE_GPU_IDENTITY);return result;
      } catch(error) {gl.deleteProgram(p);throw error;}
      finally {for(const shader of shaders)gl.deleteShader(shader);}
    }
    async initialize(){
      const gl=this.gl,spec=nativeBlockTextures;
      for(const [name,source] of Object.entries(spec.programs)){
        await nextVisualCommit();
        try{this.programs[name]=this.program(source.vert,source.frag);}
        catch(error){throw new Error(`${name}: ${error.message}`);}
      }
      // The upstream renderer specializes the no-touch uniform branch as well.
      const active=spec.programs.ActiveBlock_program_0,split=active.frag.indexOf('void main()'),noTouch=active.frag.slice(0,split).replace(/uniform\s+(?:(?:lowp|mediump|highp)\s+)?int\s+_TouchPosCount\s*;/,'')+active.frag.slice(split).replace(/\b_TouchPosCount\b/g,'0').replace('texture2D(_EffectRT, (floor(vs_TEXCOORD0.xy * _HoverSize) + 0.5) / _HoverSize).b','0.0');
      this.programs.activeNoTouch=this.program(active.vert,noTouch);
      for(const count of [1,2]){const frag=active.frag.slice(0,split).replace(/uniform\s+(?:(?:lowp|mediump|highp)\s+)?int\s+_TouchPosCount\s*;/,'')+active.frag.slice(split).replace(/\b_TouchPosCount\b/g,String(count));this.programs['activeTouch'+count]=this.program(active.vert,frag);await nextVisualCommit();}
      for(const [name,frag] of Object.entries(spec.support))if(name!=='VERT'){
        await nextVisualCommit();this.programs[name]=this.program(spec.support.VERT,frag);
      }
      this.programs.fusedEffect=this.program(spec.support.VERT,spec.support.PACK_EFFECT.replace('texture2D(Edge,uv).r','texture2D(Glow,uv).b'));
      this.programs.hoverSprite=this.program(spec.support.VERT,spec.support.SPRITE.replace('texture2D(Texture,uv)*col','vec4(texture2D(Texture,uv).a) * col'));
      this.buffer=gl.createBuffer();this.buffers.push(this.buffer);this.quad=new Float32Array([-1,-1,0,0,0, 1,-1,0,1,0, -1,1,0,0,1, -1,1,0,0,1, 1,-1,0,1,0, 1,1,0,1,1]);
      for(const [name,key] of Object.entries({noise:'texture_30',spark:'texture_17',grain:'texture_15',touch:'touch'})){
        const image=spec[key],texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,name==='touch'?gl.CLAMP_TO_EDGE:gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,name==='touch'?gl.CLAMP_TO_EDGE:gl.REPEAT);this.assets[name]={texture,width:image.width,height:image.height};
      }
      this.assets.blank=this.target(1,1,false,false);
      for(const name of ['BlockCompose_program_0','BlockCompose_program_1'])this.setProperties(this.programs[name],spec.materials['6']);
      this.setProperties(this.programs.ReadyBlock_program_0,spec.materials['11']);this.setProperties(this.programs.DisabledBlock_program_0,spec.materials['8']);this.setProperties(this.programs.ActiveBlock_program_0,spec.materials['5']);this.setProperties(this.programs.activeNoTouch,spec.materials['5']);for(const count of [1,2])this.setProperties(this.programs['activeTouch'+count],spec.materials['5']);
      // Keep upstream material 5 for active noise and material 8 for disabled noise.
      this.vertexCapacity=Math.max(4096,this.geometryArena.capacity*4);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,this.vertexCapacity,gl.DYNAMIC_DRAW);
      this.enabledAttributes=[];this.frameTextures=new Array(21);this.changedGroups=new Uint8Array(6);
      this.touchViews=Array.from({length:10},(_,i)=>this.activeTouches.subarray(i*2,i*2+2));
      this.blockTime=new Float32Array(4);this.timeProps={_BlockTime:this.blockTime};this.readyTimeProps={_Time:this.blockTime};this.glowProps={_DilateTexelSize:new Float32Array(4),_PassWeight:0,_GlowFirstPass:0};
      this.finalProps={_BlockTime:this.blockTime,_ScreenParams:new Float32Array(4),_ProjectionParams:[1,.1,100,.01],_EffectRT_TexelSize:this.glowProps._DilateTexelSize,_HoverSize:new Float32Array(2),_RemoveDistortion:0,_TouchPosShine:1,_TouchPosCount:0};
      for(let i=0;i<10;i++)this.finalProps['_TouchPos'+i]=this.touchViews[i];
      this.subtractPasses=[['SubtractBlockBlender_program_0',6,1],['SubtractBlockBlender_program_1',7,3],['SubtractBlockBlender_program_1',10,5]];this.subtractProps={_ClampThresholdLow:.09,_ClampThresholdHigh:.12};this.glowWeights=[.45856798,.28286123,.15658922,.07305908,.02494781];
      this.hoverVertices=new Float32Array(600);this.hoverViews=Array.from({length:11},(_,i)=>this.hoverVertices.subarray(0,i*60));
      this.activeBounds=new Float64Array(4);this.disabledBounds=new Float64Array(4);this.activeClip=new Int32Array(4);this.disabledClip=new Int32Array(4);this.glowClip=new Int32Array(4);
      this.hoverLocal=[[-.14,.22],[.22,-.22],[.22,.22],[-.16,-.22],[-.22,.15],[-.22,-.11]];this.hoverIndices=[5,4,3,0,3,4,1,3,0,2,1,0];
      gl.disable(gl.DITHER);gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);
      // Execute both final shader variants during loading, before the first touch.
      const warm=this.target(1,1,false,false),bindings={_MaskRT:this.assets.white||(this.assets.white=this.whiteTexture()),_EffectRT:this.assets.white,_DisplaceMap:this.assets.noise,_SparkMap:this.assets.spark,_NoiseMap:this.assets.grain,_SceneColor:this.assets.blank},props={_ScreenParams:[16,16,1,1],_ProjectionParams:[1,.1,100,.01],_EffectRT_TexelSize:[1,1,1,1],_HoverSize:[1,1],_TouchPosCount:10};
      for(let i=0;i<10;i++)props['_TouchPos'+i]=[.5,.5];
      for(const name of ['activeNoTouch','activeTouch1','activeTouch2','ActiveBlock_program_0'])this.pass(name,warm,bindings,props);
      this.pass('DisabledBlock_program_0',warm,{_ComposeRT:this.assets.white,_DisplaceMap:this.assets.noise,_SparkMap:this.assets.spark},this.timeProps,'add');
      this.pass('ReadyBlock_program_0',warm,{_DisabledNormalBlockRT:this.assets.white,_DisabledSubtractBlockRT:this.assets.blank,_ComposeRT:this.assets.white},this.readyTimeProps,'alpha-add');
      gl.finish();gl.deleteTexture(warm.texture);gl.deleteFramebuffer(warm.framebuffer);
    }
    uniform(program,name,value){
      const gl=this.gl,u=program.uniforms.get(name);if(!u)return;
      if(typeof value==='number'){if(u.cached===value)return;u.cached=value;}
      else {const n=u.type===gl.FLOAT_VEC2?2:u.type===gl.FLOAT_VEC3?3:u.type===gl.FLOAT_VEC4?4:16;let a=u.cached,same=!!a;if(!a)a=u.cached=new Float32Array(n);for(let i=0;i<n;i++){const v=Math.fround(value[i]);if(a[i]!==v)same=false;a[i]=v;}if(same)return;value=a;}
      switch(u.type){case gl.INT:case gl.BOOL:case gl.SAMPLER_2D:gl.uniform1i(u.location,value);break;case gl.FLOAT:gl.uniform1f(u.location,value);break;case gl.FLOAT_VEC2:gl.uniform2fv(u.location,(value.length===2?value:value.slice(0,2)));break;case gl.FLOAT_VEC3:gl.uniform3fv(u.location,(value.length===3?value:value.slice(0,3)));break;case gl.FLOAT_VEC4:gl.uniform4fv(u.location,(value.length===4?value:value.slice(0,4)));break;case gl.FLOAT_MAT4:gl.uniformMatrix4fv(u.location,false,value);break;}
    }
    setProperties(program,properties){const gl=this.gl;gl.useProgram(program.p);for(const [name,value] of Object.entries(properties))this.uniform(program,name,value);}
    target(width,height,linear=false,track=true){
      const gl=this.gl,texture=gl.createTexture(),framebuffer=gl.createFramebuffer();
      if(!texture||!framebuffer){if(texture)gl.deleteTexture(texture);if(framebuffer)gl.deleteFramebuffer(framebuffer);throw new Error('噪域 GPU 资源不足');}
      gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,linear?gl.LINEAR:gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,linear?gl.LINEAR:gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){gl.deleteFramebuffer(framebuffer);gl.deleteTexture(texture);throw new Error('噪域 GPU 缓冲创建失败');}const out={texture,framebuffer,width,height};if(track)this.targets.push(out);this.clear(out);return out;
    }
    clear(target){const gl=this.gl;gl.bindFramebuffer(gl.FRAMEBUFFER,target?.framebuffer||null);gl.disable(gl.SCISSOR_TEST);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);}
    bind(program,target,vertices=this.quad,colors=false){
      const gl=this.gl,stride=colors?36:20;gl.bindFramebuffer(gl.FRAMEBUFFER,target?.framebuffer||null);gl.viewport(0,0,target?.width||this.width,target?.height||this.height);gl.useProgram(program.p);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
      if(vertices.byteLength>this.vertexCapacity){while(vertices.byteLength>this.vertexCapacity)this.vertexCapacity*=2;gl.bufferData(gl.ARRAY_BUFFER,this.vertexCapacity,gl.DYNAMIC_DRAW);this.vertexSource=null;}
      if(vertices!==this.quad||this.vertexSource!==this.quad){gl.bufferSubData(gl.ARRAY_BUFFER,0,vertices);this.vertexSource=vertices;}
      if(this.attributePosition!==program.position||this.attributeTexcoord!==program.texcoord||this.attributeColor!==program.color||this.attributeColors!==colors){
        for(const index of this.enabledAttributes)if(index!==program.position&&index!==program.texcoord&&(!colors||index!==program.color))gl.disableVertexAttribArray(index);
        this.enabledAttributes.length=0;if(program.position>=0){gl.enableVertexAttribArray(program.position);gl.vertexAttribPointer(program.position,3,gl.FLOAT,false,stride,0);this.enabledAttributes.push(program.position);}if(program.texcoord>=0){gl.enableVertexAttribArray(program.texcoord);gl.vertexAttribPointer(program.texcoord,2,gl.FLOAT,false,stride,12);this.enabledAttributes.push(program.texcoord);}if(program.color>=0){if(colors){gl.enableVertexAttribArray(program.color);gl.vertexAttribPointer(program.color,4,gl.FLOAT,false,stride,20);this.enabledAttributes.push(program.color);}else{gl.disableVertexAttribArray(program.color);gl.vertexAttrib4f(program.color,255,255,255,255);}}
        this.attributePosition=program.position;this.attributeTexcoord=program.texcoord;this.attributeColor=program.color;this.attributeColors=colors;
      }
    }
    sampler(program,name,target,unit){if(!program.uniforms.has(name))return unit;const gl=this.gl;gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,target.texture);this.uniform(program,name,unit);return unit+1;}
    pass(name,target,bindings,properties=null,blend=null,vertices=null,clip=null){
      const gl=this.gl,p=this.programs[name];if(!blend){gl.disable(gl.BLEND);this.clear(target);}this.bind(p,target,vertices||this.quad);if(blend){gl.enable(gl.BLEND);gl.blendFunc(blend==='alpha-add'?gl.SRC_ALPHA:gl.ONE,blend==='over'?gl.ONE_MINUS_SRC_ALPHA:gl.ONE);}let unit=0;for(const key in bindings)unit=this.sampler(p,key,bindings[key],unit);if(properties)for(const key in properties)this.uniform(p,key,properties[key]);if(clip){gl.enable(gl.SCISSOR_TEST);gl.scissor(clip[0],clip[1],clip[2],clip[3]);}gl.drawArrays(gl.TRIANGLES,0,(vertices||this.quad).length/5);if(clip)gl.disable(gl.SCISSOR_TEST);gl.disable(gl.BLEND);
    }
    resize(width,height){
      if(width===this.width&&height===this.height)return;const gl=this.gl;for(const t of this.targets){gl.deleteFramebuffer(t.framebuffer);gl.deleteTexture(t.texture);}this.targets=[];this.width=width;this.height=height;this.canvas.width=width;this.canvas.height=height;this.attributeColors=null;
      const bw=Math.max(1,Math.floor(width/8)),bh=Math.max(1,Math.floor(height/8)),ew=bw*2,eh=bh*2;this.bw=bw;this.bh=bh;this.ew=ew;this.eh=eh;
      this.rt=Array.from({length:21},(_,i)=>this.target(i>=18&&i<20?1:i===11||i===12||i===13||i===16?ew:i===17?Math.max(1,Math.floor(width/6)):bw,i>=18&&i<20?1:i===11||i===12||i===13||i===16?eh:i===17?Math.max(1,Math.floor(height/6)):bh,i===16||i===17));
      this.finalProps._ScreenParams.set([width,height,1+1/width,1+1/height]);this.finalProps._HoverSize.set([bw,bh]);this.glowProps._DilateTexelSize.set([1/ew,1/eh,ew,eh]);
      this.small.width=this.rt[17].width;this.small.height=this.rt[17].height;this.geometry=Array.from({length:6},()=>new Float32Array(0));this.cachedVersions=new Array(6).fill(-1);if(this.geometryArena)this.geometryArena.lengths.fill(-1);this.lastTime=NaN;this.maskValid=this.disabledCompositeValid=this.hoverWasVisible=false;
    }
    coverage(bounds,width,height,mx,my,out){
      const x=Math.floor(Math.max(0,Math.min(1,bounds[0]-mx))*width),y=Math.floor(Math.max(0,Math.min(1,bounds[1]-my))*height);
      out[0]=x;out[1]=y;out[2]=Math.max(0,Math.ceil(Math.max(0,Math.min(1,bounds[2]+mx))*width)-x);out[3]=Math.max(0,Math.ceil(Math.max(0,Math.min(1,bounds[3]+my))*height)-y);return out;
    }
    buildGeometry(zones){
      const aspect=nativeBlockViewport(this.engine).aspect,needed=Math.max(1,zones.length)*54;
      if(!this.geometryArena||this.geometryArena.capacity<needed){let cap=64;while(cap<needed)cap*=2;this.geometryArena={capacity:cap,a:Array.from({length:6},()=>new Float32Array(cap)),b:Array.from({length:6},()=>new Float32Array(cap)),lengths:new Int32Array(6),counts:new Int32Array(6)};this.geometry=Array.from({length:6},()=>new Float32Array(0));}
      const arena=this.geometryArena,counts=arena.counts;counts.fill(0);
      this.activeBounds[0]=this.activeBounds[1]=this.disabledBounds[0]=this.disabledBounds[1]=Infinity;this.activeBounds[2]=this.activeBounds[3]=this.disabledBounds[2]=this.disabledBounds[3]=-Infinity;
      for(const z of zones){const c=z.cos,sin=z.sin,group=(z.active?0:z.ready?2:4)+(+z.invert),list=arena.b[group],bounds=group<4?this.activeBounds:this.disabledBounds;let at=counts[group];
        for(let k=0;k<6;k++){const sx=k===0||k===3||k===5?-1:1,sy=k<2||k===3?-1:1,x=z.hx*sx,y=z.hy*sy;const px=z.center.x+c*x-sin*y,py=(z.center.y+sin*x+c*y)*aspect;list[at++]=px;list[at++]=py;const ux=px*.5+.5,uy=py*.5+.5;if(!Number.isFinite(ux)||!Number.isFinite(uy)){bounds[0]=bounds[1]=0;bounds[2]=bounds[3]=1;}else{bounds[0]=Math.min(bounds[0],ux);bounds[1]=Math.min(bounds[1],uy);bounds[2]=Math.max(bounds[2],ux);bounds[3]=Math.max(bounds[3],uy);}list[at++]=0;list[at++]=sx<0?0:1;list[at++]=sy<0?0:1;list[at++]=255;list[at++]=z.invert?z.opacity*255:255;list[at++]=255;list[at++]=z.invert?25.5:z.opacity*255;}
        counts[group]=at;
      }
      for(let side=0;side<2;side++){
        const ready=arena.b[2+side],combined=arena.b[4+side],n=counts[2+side],offset=counts[4+side];
        for(let i=0;i<n;i++)combined[offset+i]=ready[i];counts[4+side]+=n;
      }
      for(let k=0;k<6;k++){const count=counts[k],next=arena.b[k],old=arena.a[k];let changed=count!==arena.lengths[k];if(!changed)for(let i=0;i<count;i++)if(next[i]!==old[i]){changed=true;break;}if(changed){arena.a[k]=next;arena.b[k]=old;arena.lengths[k]=count;this.geometry[k]=next.subarray(0,count);this.versions[k]++;}}
      for(const z of zones)if(z.ready){
        const rx=Math.abs(z.cos*z.hx)+Math.abs(z.sin*z.hy),ry=(Math.abs(z.sin*z.hx)+Math.abs(z.cos*z.hy))*aspect,b=this.disabledBounds;
        b[0]=Math.min(b[0],(z.center.x-rx)*.5+.5);b[2]=Math.max(b[2],(z.center.x+rx)*.5+.5);
        b[1]=Math.min(b[1],(z.center.y*aspect-ry)*.5+.5);b[3]=Math.max(b[3],(z.center.y*aspect+ry)*.5+.5);
      }
      this.zones=zones;
    }
    renderMask(group){
      const gl=this.gl,target=this.rt[group],p=this.programs.SPRITE,verts=this.geometry[group],phase=Math.floor(group/2),invert=!!(group&1);this.clear(target);if(!verts.length)return;
      this.bind(p,target,verts,true);this.sampler(p,'Texture',this.assets.white||(this.assets.white=this.whiteTexture()),0);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);gl.drawArrays(gl.TRIANGLES,0,verts.length/9);
      gl.disable(gl.BLEND);
    }
    whiteTexture(){const gl=this.gl,t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);return{texture:t,width:1,height:1};}
    updateHover(t){
      const e=this.engine,viewport=nativeBlockViewport(e),time=t+(+e.chart.offset||0);if(time<this.lastHoverTime)for(const h of this.hoverSlots){h.id=null;h.scale=h.from=h.to=0;}this.lastHoverTime=time;this.activeTouchCount=0;
      for(const h of this.hoverSlots){const u=Math.max(0,Math.min(1,(time-h.at)/.1));h.scale=h.from+(h.to-h.from)*u;h.seen=false;}
      for(const [id,p] of e.pointer){if(p.active===false||!nativeBlockTouchBlocked(e,p.x,p.y,t,id))continue;const i=this.activeTouchCount++;if(i<10){this.activeTouches[i*2]=(p.x-viewport.x)/viewport.h;this.activeTouches[i*2+1]=1-(p.y-viewport.y)/viewport.h;}let h=this.hoverSlots.find(h=>h.id===id);if(!h){h=this.hoverSlots.find(h=>h.id===null);if(!h)continue;h.id=id;h.scale=h.from=0;h.to=1;h.at=time;}h.x=(p.x-viewport.x)/viewport.w;h.y=1-(p.y-viewport.y)/viewport.h;h.seen=true;}
      this.activeTouchCount=Math.min(10,this.activeTouchCount);updateNativeNoiseAudio(e,this.activeTouchCount>0,time);for(const h of this.hoverSlots)if(h.id!==null&&!h.seen){h.id=null;h.from=h.scale;h.to=0;h.at=time;}
      const target=this.rt[14],gl=this.gl,p=this.programs.hoverSprite,aspect=viewport.aspect,local=this.hoverLocal,indices=this.hoverIndices,vertices=this.hoverVertices,bounds=this.activeBounds;let at=0,count=0;
      for(const h of this.hoverSlots){if(h.scale<=0)continue;count++;const rx=.22/aspect*h.scale*1.15,ry=.22*h.scale*1.15;bounds[0]=Math.min(bounds[0],h.x-rx);bounds[1]=Math.min(bounds[1],h.y-ry);bounds[2]=Math.max(bounds[2],h.x+rx);bounds[3]=Math.max(bounds[3],h.y+ry);for(const index of indices){const point=local[index],x=point[0],y=point[1];vertices[at++]=h.x*2-1+x*2/aspect*h.scale*1.15;vertices[at++]=h.y*2-1+y*2*h.scale*1.15;vertices[at++]=0;vertices[at++]=x/.44+.5;vertices[at++]=y/.44+.5;}}
      if(count||this.hoverWasVisible)this.clear(target);
      if(count){gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);this.bind(p,target,this.hoverViews[count]);this.sampler(p,'Texture',this.assets.touch,0);gl.drawArrays(gl.TRIANGLES,0,at/5);gl.disable(gl.BLEND);}
      this.hoverWasVisible=count>0;return count>0;
    }
    prepare(t){
      const e=this.engine;if(this.lost||this.gl.isContextLost())throw new Error('噪域 WebGL 上下文丢失');
      const limits=this.limits||(this.limits={texture:this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE),renderbuffer:this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE),viewport:this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS)}),
        viewport=nativeBlockViewport(e),
        nativeScale=Math.max(.1,Number(e.dpr*e.viewScale)||1),
        // Noise is already a low-resolution /8 upstream effect; keep its full-screen
        // resolve independent of the Retina note canvas to avoid 9x fill-rate cost.
        scale=Math.min(nativeScale,1.25,Math.sqrt(1800000/(viewport.w*viewport.h)),limits.texture/Math.max(viewport.w,viewport.h),limits.renderbuffer/Math.max(viewport.w,viewport.h),limits.viewport[0]/viewport.w,limits.viewport[1]/viewport.h);
      this.resize(Math.max(1,Math.floor(viewport.w*scale)),Math.max(1,Math.floor(viewport.h*scale)));const time=t+(+e.chart.offset||0);if(this.lastTime===time)return this.visible;
      this.blockTime[0]=time/20;this.blockTime[1]=time;this.blockTime[2]=time*2;this.blockTime[3]=time*3;
      this.lastTime=time;this.buildGeometry(nativeBlockZones(e,t));const tex=this.frameTextures;tex.fill(this.assets.blank);const changed=this.changedGroups;
      for(let i=0;i<6;i++){changed[i]=this.cachedVersions[i]!==this.versions[i];if(changed[i]){this.renderMask(i);this.cachedVersions[i]=this.versions[i];}if(this.geometry[i].length)tex[i]=this.rt[i];}
      const active=!!(this.geometry[0].length||this.geometry[1].length),ready=!!(this.geometry[2].length||this.geometry[3].length),disabled=!!(this.geometry[4].length||this.geometry[5].length);
      for(const [program,target,input] of this.subtractPasses)if(this.geometry[input].length){tex[target]=this.rt[target];if(changed[input])this.pass(program,this.rt[target],{_MainTex:tex[input]},this.subtractProps);}
      if(active){tex[8]=this.rt[8];this.pass('BlockCompose_program_0',this.rt[8],{_NormalBlockRT:tex[0],_SubtractBlockRT:tex[6],_DisplaceMap:this.assets.noise},this.timeProps);}
      if(ready){tex[9]=this.rt[9];if(this.geometry[3].length){if(changed[2]||changed[3])this.pass('BlockCompose_program_1',this.rt[9],{_DisabledNormalBlockRT:tex[2],_DisabledSubtractBlockRT:tex[7]});}else tex[9]=tex[2];}
      let glow=tex[8];if(active){const properties=this.glowProps,weights=this.glowWeights;for(let i=0;i<5;i++){properties._PassWeight=weights[i];properties._GlowFirstPass=i===0?1:0;const out=this.rt[12+i%2],clip=this.coverage(this.activeBounds,this.ew,this.eh,.11+8/this.ew,.11+8/this.eh,this.glowClip);this.pass('GlowMask_program_0',out,{_MainTex:glow,_ComposeRT:tex[8]},properties,null,null,clip);glow=out;}}
      const hover=this.updateHover(t);tex[14]=hover?this.rt[14]:this.assets.blank;
      if(active||ready||hover){if(active||!this.maskValid||changed[0]||changed[1]||changed[2]||changed[3]){this.pass('PACK_MASK',this.rt[15],{Active:tex[8],Ready:this.assets.blank,Normal:this.assets.blank,Subtract:this.assets.blank});this.maskValid=true;}tex[15]=this.rt[15];if(active||hover){this.pass('fusedEffect',this.rt[16],{Edge:tex[11],Glow:glow,Hover:tex[14]});tex[16]=this.rt[16];}}
      if(disabled){if(this.geometry[5].length){tex[20]=this.rt[20];if(!this.disabledCompositeValid||changed[4]||changed[5]){this.pass('BlockCompose_program_1',this.rt[20],{_DisabledNormalBlockRT:tex[4],_DisabledSubtractBlockRT:tex[10]});this.disabledCompositeValid=true;}}else tex[20]=tex[4];}
      this.coverage(this.activeBounds,this.width,this.height,.11+8/this.ew,.11+8/this.eh,this.activeClip);this.coverage(this.disabledBounds,this.width,this.height,2/this.bw,2/this.bh,this.disabledClip);
      this.frameTextures=tex;this.active=active;this.ready=ready;this.disabled=disabled;this.hover=hover;this.visible=active||ready||disabled||hover;return this.visible;
    }
    uploadScene(){
      const e=this.engine,gl=this.gl;
      this.captureScene(e.frameCanvasOffsetX||0,e.frameCanvasOffsetY||0,e.frameCanvasScale||e.dpr*e.viewScale||1);
      gl.bindTexture(gl.TEXTURE_2D,this.rt[17].texture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,this.small);
    }
    captureScene(bx,by,sc){
      const e=this.engine,g=this.smallCtx,w=this.small.width,h=this.small.height,image=e.renderBgImage||e.bgImage;
      g.setTransform(1,0,0,1,0,0);g.globalCompositeOperation='copy';g.fillStyle='#000';g.fillRect(0,0,w,h);g.globalCompositeOperation='source-over';
      if(image){
        const iw=image.naturalWidth||image.width,ih=image.naturalHeight||image.height,
          sw=e.surfaceW||e.w,sh=e.surfaceH||e.h,cover=Math.max(sw/iw,sh/ih),
          sx=(iw-sw/cover)/2,sy=(ih-sh/cover)/2;
        g.drawImage(image,sx,sy,sw/cover,sh/cover,0,0,w,h);
        if(!e.renderBgImage){g.fillStyle='rgba(0,0,0,.6)';g.fillRect(0,0,w,h);}
      }
      g.drawImage(e.canvas,0,0,e.canvas.width,e.canvas.height,0,0,w,h);
      if(e.postProcessor?.canvas?.style.display!=='none'&&e.postProcessor?.canvas)g.drawImage(e.postProcessor.canvas,0,0,w,h);
      captureNativeNoiseHud(e,g,w,h);
    }
    composite(c,clip,additive){
        const e=this.engine;
        const sx=clip[0],sy=this.height-clip[1]-clip[3],sw=clip[2],sh=clip[3],viewport=nativeBlockViewport(e);
        if(!sw||!sh)return;
        c.save();c.globalAlpha=1;c.globalCompositeOperation=additive?'lighter':'source-over';
        c.drawImage(this.canvas,sx,sy,sw,sh,viewport.x+sx*viewport.w/this.width,viewport.y+sy*viewport.h/this.height,sw*viewport.w/this.width,sh*viewport.h/this.height);c.restore();
    }
    draw(c,t,disabled){
      if(!this.prepare(t)||this.lost)return;
      const e=this.engine,time=t+(+e.chart.offset||0),tex=this.frameTextures;
      if(disabled){
        if(this.disabled){
          this.clear(null);
          this.pass('DisabledBlock_program_0',null,{_ComposeRT:tex[20],_DisplaceMap:this.assets.noise,_SparkMap:this.assets.spark},this.timeProps,'add',null,this.disabledClip);
          this.composite(c,this.disabledClip,true);
        }
        if(this.ready){
          this.clear(null);
          this.pass('ReadyBlock_program_0',null,{_DisabledNormalBlockRT:tex[2],_DisabledSubtractBlockRT:tex[7],_ComposeRT:tex[20]},this.readyTimeProps,'alpha-add',null,this.activeClip);
          this.composite(c,this.activeClip,true);
        }
        return;
      }
      if(!(this.active||this.hover))return;
      // Capture only after notes and hit feedback have been drawn. The snapshot
      // also includes the DOM HUD and the already composited lower noise pass.
      if(this.sceneCaptureTime!==time){this.uploadScene();this.sceneCaptureTime=time;}
      this.clear(null);
      const props=this.finalProps;props._TouchPosCount=this.activeTouchCount;
      this.pass(this.activeTouchCount===1?'activeTouch1':this.activeTouchCount===2?'activeTouch2':this.activeTouchCount||this.hover?'ActiveBlock_program_0':'activeNoTouch',null,{_MaskRT:tex[15],_EffectRT:tex[16],_DisplaceMap:this.assets.noise,_SparkMap:this.assets.spark,_NoiseMap:this.assets.grain,_SceneColor:this.rt[17]},props,'over',null,this.activeClip);
      this.composite(c,this.activeClip,false);
    }
    destroy(){const gl=this.gl;if(!gl)return;this.canvas.removeEventListener('webglcontextlost',this.onContextLost);for(const t of this.targets){gl.deleteTexture(t.texture);gl.deleteFramebuffer(t.framebuffer);}for(const a of Object.values(this.assets)){gl.deleteTexture(a.texture);if(a.framebuffer)gl.deleteFramebuffer(a.framebuffer);}for(const p of Object.values(this.programs))gl.deleteProgram(p.p);for(const b of this.buffers)gl.deleteBuffer(b);gl.getExtension('WEBGL_lose_context')?.loseContext();this.gl=null;this.canvas.width=this.canvas.height=this.small.width=this.small.height=1;}
  }
  async function createNativeBlockRenderer(e){
    let renderer;
    try{
      if(!(Number.isFinite(e.w)&&Number.isFinite(e.h)&&e.w>0&&e.h>0))throw new Error('游戏画布尺寸尚未就绪');
      renderer=new NativeBlockRenderer(e);await renderer.initialize();
      e.canvas.dataset.noiseRenderer='webgl-native';
      e.canvas.dataset.noiseSource='Adai-add/PhiraiAd@a60b49ad';
      Diagnostics.info('RenderEngine.noise','原项目噪域 GPU 流程已就绪',{width:e.w,height:e.h});
      return renderer;
    }catch(error){renderer?.destroy();throw new Error(`噪域 GPU 初始化失败：${error.message}`);}
  }
  // ActiveBlock samples sceneColorRT (BlockRenderingController / ActiveBlock).
  // Browser DOM is not a Canvas source: mirror the existing HUD into that one
  // low-resolution scene capture, then composite native noise above the DOM.
  // Text styles/anchors are cached until layout changes, avoiding frame-time
  // layout reads. The visible HUD, its controls and hit targets stay unchanged.
  function gameplayTextBaseline(el,surface){
    const box=el.getBoundingClientRect(),style=getComputedStyle(el),marker=el.ownerDocument.createElement('span');
    // A nonzero layout box avoids iOS WebKit's zero-rect optimization for
    // zero-size inline boxes inside clipped captions and offscreen frames.
    marker.setAttribute('aria-hidden','true');
    marker.style.cssText='display:inline-block!important;vertical-align:baseline!important;width:1px!important;height:1px!important;padding:0!important;margin:0!important;border:0!important;line-height:0!important;letter-spacing:0!important;opacity:0!important;float:none!important;position:static!important;transform:none!important';
    let baseline;
    try{el.appendChild(marker);baseline=marker.getBoundingClientRect().bottom-surface.top;}
    finally{marker.remove();}
    const lo=box.top-surface.top,hi=box.bottom-surface.top;
    if(Number.isFinite(baseline)&&baseline>=lo-.5&&baseline<=hi+.5&&box.height>0)return baseline;
    // Recover a baseline from the same font's real metrics if Safari returns
    // a stale/zero marker rect. Never cache a caption above/outside the frame.
    const c=el.ownerDocument.createElement('canvas').getContext('2d');
    c.font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const metric=c.measureText(el.textContent||'0'),size=parseFloat(style.fontSize)||16;
    const ascent=metric.fontBoundingBoxAscent??metric.actualBoundingBoxAscent??size*.8,
      descent=metric.fontBoundingBoxDescent??metric.actualBoundingBoxDescent??size*.2,
      line=parseFloat(style.lineHeight)||ascent+descent,
      top=lo+(parseFloat(style.borderTopWidth)||0)+(parseFloat(style.paddingTop)||0);
    return Math.max(lo,Math.min(hi,top+(line-ascent-descent)/2+ascent));
  }
  function gameplayTextGeometry(el,surface){
    const empty=!el.textContent;if(empty)el.textContent='0';
    try{return{rect:el.getBoundingClientRect(),baseline:gameplayTextBaseline(el,surface)};}
    finally{if(empty)el.textContent='';}
  }
  function captureNativeNoiseHud(e,g,w,h){
    if(e.chart.kind==='pjsk')return;
    const view=e.canvas.parentElement,moving=view?.classList.contains('phiStageIntro')||view?.classList.contains('phiStageOutro');
    let cache=e.nativeNoiseHudCache;
    if(cache&&(cache.moving!==moving||(moving&&cache.frame!==e.frameNow)))cache=null;
    if(!cache){
      const surface=e.canvas.getBoundingClientRect(),items=[],pause=[],bars=[];
      const add=(selector,combo=false)=>{
        for(const el of gameplayDocument().querySelectorAll(selector)){
          const geometry=gameplayTextGeometry(el,e.canvas.getBoundingClientRect()),r=geometry.rect,s=getComputedStyle(el);
          if(!(r.width&&r.height)||s.display==='none'||s.visibility==='hidden')continue;
          const align=combo?'center':s.textAlign==='right'||s.textAlign==='end'?'right':s.textAlign==='center'?'center':'left';
          let x=r.left-surface.left+(align==='center'?r.width/2:align==='right'?r.width:0);
          if(combo){const box=el.closest('.comboHud')?.getBoundingClientRect();if(box)x=box.left-surface.left+box.width/2;}
          items.push({el,combo,align,x,y:r.top-surface.top+r.height/2,width:combo?e.surfaceW:r.width,
            font:`${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`,
            baseline:geometry.baseline,kerning:s.fontKerning,stretch:s.fontStretch,caps:s.fontVariantCaps,
            color:s.color,spacing:s.letterSpacing==='normal'?'0px':s.letterSpacing,
            ellipsis:s.textOverflow==='ellipsis'});
        }
      };
      add('#scoreText,#innerScoreText');add('#comboText,#innerComboText,.comboLabel',true);
      add('#gameSongName,#innerGameSongName,#gameDifficulty,#innerGameDifficulty');
      for(const el of gameplayDocument().querySelectorAll('#pauseBtn,#innerPauseBtn')){
        const r=el.getBoundingClientRect(),s=getComputedStyle(el,'::before');if(!r.width||!r.height)continue;
        const after=getComputedStyle(el,'::after'),width=e.pack?.images?.pause?parseFloat(s.width):Math.max(parseFloat(s.width)||0,(parseFloat(after.left)||0)+(parseFloat(after.width)||0));
        pause.push({x:r.left-surface.left,y:r.top-surface.top,w:width||15,h:parseFloat(s.height)||18,first:parseFloat(s.width)||4.7,second:parseFloat(after.width)||4.7,gap:parseFloat(after.left)||10.4,opacity:exportOpacity(el)});
      }
      for(const el of gameplayDocument().querySelectorAll('#progressBar,#innerProgressBar')){
        const r=el.parentElement.getBoundingClientRect();if(r.width&&r.height)bars.push({x:r.left-surface.left,y:r.top-surface.top,w:r.width,h:r.height});
      }
      cache=e.nativeNoiseHudCache={items,pause,bars,moving,frame:e.frameNow};
    }
    g.save();g.scale(w/e.surfaceW,h/e.surfaceH);g.textAlign='center';g.textBaseline='alphabetic';
    for(const item of cache.items){
      if(item.combo&&!e.lastHudVisible)continue;
      let text=item.el.textContent;if(!text)continue;
      g.font=item.font;g.fillStyle=item.color;
      if('fontKerning' in g)g.fontKerning=item.kerning;if('fontStretch' in g)g.fontStretch=item.stretch;if('fontVariantCaps' in g)g.fontVariantCaps=item.caps;
      if('letterSpacing' in g)g.letterSpacing=item.spacing;
      g.textAlign=item.align;
      if(item.ellipsis&&g.measureText(text).width>item.width){
        if(item.originalText!==text){
          item.originalText=text;let lo=0,hi=text.length;
          while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(g.measureText(text.slice(0,mid)+'…').width<=item.width)lo=mid;else hi=mid-1;}
          item.fittedText=text.slice(0,lo)+'…';
        }
        text=item.fittedText;
      }
      const metric=g.measureText(text),ascent=metric.fontBoundingBoxAscent??metric.actualBoundingBoxAscent,
        descent=metric.fontBoundingBoxDescent??metric.actualBoundingBoxDescent;
      g.fillText(text,item.x,item.baseline);
    }
    if('letterSpacing' in g)g.letterSpacing='0px';
    const pause=e.pack?.images?.pause;
    for(const r of cache.pause){
      if(pause){const scale=Math.min(r.w/pause.naturalWidth,r.h/pause.naturalHeight),pw=pause.naturalWidth*scale,ph=pause.naturalHeight*scale;g.drawImage(pause,r.x+(r.w-pw)/2,r.y+(r.h-ph)/2,pw,ph);}
      else {g.fillStyle='#fff';g.fillRect(r.x,r.y,r.first,r.h);g.fillRect(r.x+r.gap,r.y,r.second,r.h);}
    }
    g.fillStyle='#aaa';const progress=clamp(e.musicCurrentTime()/Math.max(.001,e.musicDuration()),0,1),progressImage=e.pack?.images?.progress;
    for(const r of cache.bars){
      if(progressImage){g.save();g.beginPath();g.rect(r.x,r.y,r.w,r.h);g.clip();g.drawImage(progressImage,r.x+(progress-1)*r.w,r.y,r.w,r.h);g.restore();}
      else g.fillRect(r.x,r.y,r.w*progress,r.h);
    }
    g.restore();
  }
  function drawNativeNoiseOverlay(e,t){
    if(e.chart.kind!=='pgr'||!e.chart.blockAreas?.length)return;
    let canvas=e.nativeNoiseOverlay,c=e.nativeNoiseOverlayCtx;
    if(!canvas){
      canvas=e.nativeNoiseOverlay=document.createElement('canvas');canvas.className='phiNativeNoiseOverlay';
      canvas.setAttribute('aria-hidden','true');e.canvas.parentElement.appendChild(canvas);
      c=e.nativeNoiseOverlayCtx=canvas.getContext('2d',{alpha:true,desynchronized:false});
    }
    if(canvas.width!==e.canvas.width||canvas.height!==e.canvas.height){canvas.width=e.canvas.width;canvas.height=e.canvas.height;e.nativeNoiseHudCache=null;}
    c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,canvas.width,canvas.height);
    c.setTransform(e.frameCanvasScale,0,0,e.frameCanvasScale,e.frameCanvasOffsetX,e.frameCanvasOffsetY);
    drawNativeBlocks(e,c,t,false);
  }

  function drawNativeBlocks(e,c,t,disabled){
    if(e.chart.kind!=='pgr'||!e.chart.blockAreas?.length||e.nativeBlockRenderError)return;
    try{
      if(!e.nativeBlockRenderer)throw new Error('噪域 GPU 尚未初始化');
      e.nativeBlockRenderer.draw(c,t,disabled);
    }catch(error){
      e.nativeBlockRenderError=error;
      Diagnostics.error('RenderEngine.noise',error);
      if(!e.running)throw error;
      e.pause('noise-gpu-error');
      showDialog('噪域 GPU 渲染中断','<p>点击重建 GPU 后，从暂停位置继续。</p><button id="noiseGpuRetry">重建 GPU</button><pre id="noiseGpuDetail" style="white-space:pre-wrap"></pre>');
      $('#noiseGpuDetail').textContent=error.message;
      $('#noiseGpuRetry').onclick=async()=>{
        const button=$('#noiseGpuRetry');button.disabled=true;
        try{e.nativeBlockRenderer?.destroy();e.nativeBlockRenderer=await createNativeBlockRenderer(e);e.nativeBlockRenderError=null;closeDialog();}
        catch(next){$('#noiseGpuDetail').textContent=next.message;button.disabled=false;}
      };
    }
  }

  function updateNativeNoiseAudio(e,on,time){
    // Port of LowPassTransition: 100 ms, 1500 Hz blocked / 22000 Hz released.
    let q=e.nativeNoiseAudio;if(!q)q=e.nativeNoiseAudio={cutoff:1500,requested:false,enabled:false,start:1500,target:1500,elapsed:0,moving:false,lastTime:time};
    const dt=Math.max(0,Math.min(.1,time-q.lastTime));q.lastTime=time;
    if(on!==q.requested){q.requested=on;q.start=q.cutoff;q.target=on?1500:22000;q.elapsed=0;q.moving=true;if(on)q.enabled=true;}
    if(q.moving){if(q.elapsed<.1){q.elapsed+=dt;q.cutoff=q.start+(q.target-q.start)*Math.min(1,q.elapsed/.1);}else{q.cutoff=q.target;q.moving=false;if(!q.requested)q.enabled=false;}}
    const cutoff=q.enabled?q.cutoff:0;
    if(e.noiseAudioNode&&(q.sentCutoff!==cutoff||q.sentNode!==e.noiseAudioNode)){q.sentCutoff=cutoff;q.sentNode=e.noiseAudioNode;const param=e.noiseAudioNode.parameters?.get('cutoff');if(param)param.value=cutoff;else{e.noiseAudioNode.frequency.value=cutoff||Math.min(22000,e.musicGainContext.sampleRate*.49);}}
  }

  function phiResultGeometry(width,height) {
    const w=Math.max(1,finiteNumber(width,1)),h=Math.max(1,finiteNumber(height,1)),slope=.25,portrait=h>w,
      shape=(x,y,width,height)=>({x,y,w:width,h:height,cut:height*slope});
    if(portrait){
      const jacket=shape(w*.04,h*.1,w*.92,h*.30),hero=shape(w*.04,h*.422,w*.92,h*.17),
        dual=shape(w*.0584,hero.y+hero.h+h*.018,w*.8648,h*.085),
        judges=shape(w*.0768,dual.y+dual.h+h*.018,w*.828,h*.085);
      return{w,h,slope,angle:Math.atan(slope)*180/Math.PI,portrait,jacket,hero,dual,judges};
    }
    const jacket=shape(w*38/682,h*145/512,w*354/682,h*222/512),gap=w*9/682,
      edge=jacket.x+jacket.w,right=w*650/682,
      row=(y,height)=>{const x=edge-slope*(y-jacket.y+height)+gap,r=right-slope*(y-jacket.y);return shape(x,y,r-x,height);},
      hero=row(jacket.y,h*112/512),dual=row(jacket.y+h*127/512,h*41/512),judges=row(jacket.y+h*182/512,h*41/512);
    return{w,h,slope,angle:Math.atan(slope)*180/Math.PI,portrait,gap,jacket,hero,dual,judges};
  }
  function applyResultGeometry() {
    const view=$("#resultView");
    if (!view || view.classList.contains("hidden") || document.body.classList.contains("pjskResultActive")) return;
    const box=view.getBoundingClientRect();
    if (!(box.width>0 && box.height>0)) return;
    const layout=phiResultGeometry(box.width,box.height);
    for (const name of ["jacket","hero","dual","judges"]) {
      const rect=layout[name];
      for (const key of ["x","y","w","h","cut"]) view.style.setProperty(`--phi-result-${name}-${key}`,`${rect[key].toFixed(4)}px`);
    }
    view.dataset.resultGeometry=layout.portrait?"portrait":"landscape";
  }
  let resultLayoutObserver=null;
  function observeResultGeometry() {
    if (!resultLayoutObserver && typeof ResizeObserver!=="undefined") {
      resultLayoutObserver=new ResizeObserver(applyResultGeometry);
      resultLayoutObserver.observe($("#resultView"));
    }
    applyResultGeometry();
  }
  window.addEventListener("resize",applyResultGeometry,{passive:true});
  const PHI_RANK_TEXTURES={"\u03a6":"./assets/ui/ranks/5d3bc75bae79fdca.png","FC":"./assets/ui/ranks/6080cb7d19810f08.png","V":"./assets/ui/ranks/602647573a1ed710.png","S":"./assets/ui/ranks/e028ea44f7240e3e.png","A":"./assets/ui/ranks/879cb7144773b901.png","B":"./assets/ui/ranks/444ae38a149b83eb.png","C":"./assets/ui/ranks/c21610beb20f13b2.png","F":"./assets/ui/ranks/5f9b5a608aac94cf.png"};
  function paintResultGrade(el,label,counts,total){
    const key=label==='Φ'?'Φ':label==='V'&&counts.reduce((a,b)=>a+b,0)===total&&counts[2]===0&&counts[3]===0?'FC':label,url=PHI_RANK_TEXTURES[key];
    if(!url){el.textContent=label;return;}
    const image=document.createElement('img');image.className='phiOriginalRank';image.alt=key==='FC'?'FULL COMBO':key==='Φ'?'ALL PERFECT':label;
    image.width=121;image.height=128;image.src=url;el.replaceChildren(image);el.dataset.rank=key;
  }
  function showResults(e) {
    performanceMonitor.setGameActive(false);
    document.body.classList.remove("phiGameplayActive", "pjskModeActive");
    document.body.classList.add("phiResultActive");
    $("#gameView").classList.add("hidden");
    const resultView = $("#resultView");
    resultView.classList.remove("hidden", "resultSequence");
    void resultView.offsetWidth;
    resultView.classList.add("resultSequence");
    const qualification = qualificationFor(e),
      assistedCounts = e.usedInvincible ? e.actualCounts : e.counts,
      resultCounts = assistedCounts,
      resultMaxCombo = e.usedInvincible ? e.actualMaxCombo : e.maxCombo,
      s = e.usedInvincible ? scoreFromCounts(resultCounts, resultMaxCombo, e.total) : e.score(),
      acc = e.total ? (resultCounts[0] + resultCounts[1] * 0.65) / e.total : 1,
      record = e.record || currentRecord || {},
      resultGradeText = resultGradeFor(e, s, resultCounts);
    applyResultArtwork(record);
    const resultName = String(cleanGameplaySongName(record?.name || record?.meta?.name || "未命名曲目"));
    $("#resultSongTitle").textContent = resultName;
    applyLengthClass($("#resultSongTitle"), resultName);
    $("#resultDifficulty").textContent = difficultyCaptionFor(record);
    $("#resultScore").textContent = fmtScore(s);
    updateResultNewBest(record, s, resultGradeText, qualification);
    const qualificationEl = $("#resultQualification");
    if (qualificationEl) {
      const hideAutoplayBanner = !!qualification.assistFlags.autoplay;
      qualificationEl.classList.toggle("hidden", hideAutoplayBanner);
      if (!hideAutoplayBanner) {
        qualificationEl.textContent = qualification.ranked ? "RANKED · POINTER" : "UNRANKED · " + Object.entries(qualification.assistFlags).filter(([, on]) => on).map(([name]) => name.toUpperCase()).join(" + ");
        qualificationEl.classList.toggle("unranked", !qualification.ranked);
      }
    }
    $("#rPerfect").textContent = resultCounts[0];
    $("#rGood").textContent = resultCounts[1];
    $("#rBad").textContent = resultCounts[2];
    $("#rMiss").textContent = resultCounts[3];
    $("#rEarly").textContent = e.earlyLate?.[0] || 0;
    $("#rLate").textContent = e.earlyLate?.[1] || 0;
    $("#rAcc").textContent = (acc * 100).toFixed(2) + "%";
    const profileLevel = $("#resultProfileLevel"); if (profileLevel) profileLevel.textContent = difficultyCaptionFor(record);
    $("#rMaxCombo").textContent = resultMaxCombo;
    updatePjskResults(e);
    if(e.chart.kind!=="pjsk")$("#resultProfileArt").style.removeProperty("background-image");
    const resultGradeEl = $("#resultGrade");
    if(e.chart.kind !== "pjsk")paintResultGrade(resultGradeEl,resultGradeText,resultCounts,e.total);
    if(e.chart.kind !== "pjsk")$(".resultSyncTag").textContent="RESULT";
    resultGradeEl.classList.toggle("phiGrade", resultGradeText === "Φ");
    resultGradeEl.classList.toggle("fcGrade", resultGradeText !== "Φ" && resultCounts[2] === 0 && resultCounts[3] === 0);
    observeResultGeometry();
  }
  async function backToLibrary() {
    performanceMonitor.setGameActive(false);
    try { engine?.stop("back-to-library"); }
    catch (error) { Diagnostics.warn("GameState.cleanup", error?.message || String(error)); }
    engine = null;
    document.body.classList.remove("phiGameplayActive", "phiResultActive", "pjskModeActive", "pjskResultActive");
    clearResultArtwork();
    $("#resultView")?.classList.remove("resultSequence");
    $("#pausePanel").classList.add("hidden");
    $("#gameView").classList.add("hidden");
    $("#resultView").classList.add("hidden");
    $("#libraryView").classList.remove("hidden");
    resumeLibraryVisuals();
    if (libraryFocusCard?.isConnected) syncLibraryFocus(libraryFocusCard);
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
    if (!libraryLoadedOnce || libraryDirty || libraryLastRenderedQuery !== librarySearchQuery.trim().toLowerCase())
      renderLibrary();
  }


  let resultActionPending = false;
  async function retryFromResult() {
    if (resultActionPending) return;
    const targetEngine = engine,
      record = targetEngine?.record || currentRecord;
    if (!record) {
      toast("没有可重新开始的谱面", true);
      return;
    }
    resultActionPending = true;
    const retryButton = $("#resultRetry"),
      backButton = $("#resultBack");
    if (retryButton) retryButton.disabled = true;
    if (backButton) backButton.disabled = true;
    try {
      clearResultArtwork();
      $("#resultView")?.classList.remove("resultSequence");
      document.body.classList.remove("phiResultActive");
      document.body.classList.add("phiGameplayActive");
      document.body.classList.toggle("pjskModeActive", targetEngine?.chart?.kind === "pjsk");
      $("#resultView").classList.add("hidden");
      $("#libraryView").classList.add("hidden");
      $("#gameView").classList.remove("hidden");
      syncGameViewportCSS();
      applyGameMetadata(record);
      performanceMonitor.setGameActive(true);
      if (!targetEngine || targetEngine !== engine)
        throw new Error("旧引擎已经释放");
      targetEngine.mountGameplayBackground(true);
      targetEngine.resize();
      await targetEngine.restart();
    } catch (error) {
      performanceMonitor.setGameActive(false);
      document.body.classList.remove("phiGameplayActive");
      document.body.classList.add("phiResultActive");
      $("#gameView").classList.add("hidden");
      $("#resultView").classList.remove("hidden");
      if (engine) applyResultArtwork(engine.record || record);
      toast(`无法重新开始：${error?.message || error}`, true, 7000);
    } finally {
      resultActionPending = false;
      if (retryButton) retryButton.disabled = false;
      if (backButton) backButton.disabled = false;
    }
  }

  function formatTransportTime(seconds) {
    const whole = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
  }
  function syncPauseTransportUI(targetEngine = engine) {
    const range = $("#pauseSeekRange"), value = $("#pauseSeekValue"), input = $("#pausePlaybackRateInput");
    if (!targetEngine) return;
    const duration = Math.max(0.001, targetEngine.musicDuration()), current = clamp(targetEngine.musicCurrentTime(), 0, duration);
    if (range && document.activeElement !== range) range.value = String(Math.round(current / duration * 1000));
    if (value) value.textContent = `${formatTransportTime(current)} / ${formatTransportTime(duration)}`;
    const canonicalRate = canonicalDecimalInput(String(targetEngine.musicRate || 1));
    if (input && document.activeElement !== input) input.value = canonicalRate;
    document.querySelectorAll("#pauseRateButtons [data-rate]").forEach((button) =>
      button.classList.toggle("active", Number(button.dataset.rate) === Number(targetEngine.musicRate)));
  }
  let pauseSeekRAF = 0;
  function applyPauseSeekFromControl() {
    pauseSeekRAF = 0;
    const targetEngine = engine, range = $("#pauseSeekRange");
    if (!targetEngine?.paused || !range) return;
    targetEngine.seekPausedMusic(targetEngine.musicDuration() * Number(range.value) / 1000);
  }
  function applyPausePlaybackRate(value) {
    if (!engine?.paused) return;
    try {
      engine.setPlaybackRate(value);
    } catch (error) {
      toast(error?.message || "游玩速度无效", true);
      syncPauseTransportUI(engine);
    }
  }

  const libraryViewEl = $("#libraryView"), libraryMoreBtn = $("#libraryMoreBtn"), libraryMoreSheet = $("#libraryMoreSheet");
  function setLibraryMoreOpen(open) {
    const next = !!open;
    libraryViewEl?.classList.toggle("libraryToolsOpen", next);
    libraryMoreBtn?.setAttribute("aria-expanded", next ? "true" : "false");
    libraryMoreSheet?.setAttribute("aria-hidden", next ? "false" : "true");
  }
  if (libraryMoreBtn) libraryMoreBtn.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setLibraryMoreOpen(!libraryViewEl?.classList.contains("libraryToolsOpen"));
  };
  document.addEventListener("click", (event) => {
    if (!libraryViewEl?.classList.contains("libraryToolsOpen")) return;
    if (libraryMoreBtn?.contains(event.target) || libraryMoreSheet?.contains(event.target)) return;
    setLibraryMoreOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !libraryViewEl?.classList.contains("libraryToolsOpen")) return;
    setLibraryMoreOpen(false);
    libraryMoreBtn?.focus({ preventScroll:true });
  });
  $("#openSettings").onclick = openSettingsPanel;
  $("#pauseSettingsBtn").onclick = openSettingsPanel;
  $("#settingsCloseTop").onclick = closeSettingsPanel;
  $("#settingsDone").onclick = closeSettingsPanel;
  $("#latencyStartBtn").onclick = startLatencyCalibration;
  $("#latencyTapBtn").addEventListener("pointerdown", recordLatencyTap, {
    passive: false,
  });
  $("#resetDisplaySettings").onclick = () => {
    PHI_MODULES.LandscapeLayout.setMode('authored');
    applyNoteScale(builtinDefault("noteScale"));
    applyOfficialNoteSpeed();
    applySpecialJudgeDelay(builtinDefault("specialJudgeDelay"));
    applyJudgeTimingLead(builtinDefault("judgeTimingLead"));
    applyTouchSensitivity(builtinDefault("touchSensitivity"));
    applyHitFxSize(builtinDefault("hitFxSizeScale"));
    applyHitSoundVolume(builtinDefault("hitSoundVolume"));
    applyLowResolutionMode(!!builtinDefault("lowResolution"));
    applyFpsCounterEnabled(!!builtinDefault("showFpsCounter"));
    setAutoplayEnabled(!!builtinDefault("autoplay"));
    setInvincibleEnabled(!!builtinDefault("invincibleMode"));
  };
  $("#noteSizeRange").oninput = (e) =>
    applyNoteScale(Number(e.target.value) / 100);
  $("#speedScaleRange").oninput = (e) =>
    applyExactNoteSpeedPercent(e.target.value);
  $("#speedScaleValue").onchange = (e) =>
    applyExactNoteSpeedPercent(e.target.value);
  $("#speedScaleValue").onkeydown = (e) => {
    if (e.key === "Enter") {
      applyExactNoteSpeedPercent(e.currentTarget.value);
      e.currentTarget.blur();
    }
  };
  $("#resetOfficialSpeed").onclick = () =>
    applyOfficialNoteSpeed();
  $("#specialJudgeRange").oninput = (e) =>
    applySpecialJudgeDelay(Number(e.target.value) / 1000);
  $("#judgeTimingRange").oninput = (e) =>
    applyJudgeTimingLead(Number(e.target.value) / 1000);
  $("#touchSensitivityRange").oninput = (e) =>
    applyTouchSensitivity(Number(e.target.value) / 100);
  $("#hitFxSizeRange").oninput = (e) =>
    applyHitFxSize(Number(e.target.value) / 100);
  $("#hitSoundVolumeRange").oninput = (e) =>
    applyHitSoundVolume(Number(e.target.value) / 100);
  $("#lowResolutionToggle").onchange = (e) =>
    applyLowResolutionMode(e.target.checked);
  $("#fpsCounterToggle").onchange = (e) =>
    applyFpsCounterEnabled(e.target.checked);
  $("#invincibleToggle").onchange = (e) =>
    setInvincibleEnabled(e.target.checked);
  window.addEventListener("resize", () => {
    if (!$("#settingsPanel").classList.contains("hidden")) drawNotePreview();
  });
  const librarySearch = $("#librarySearch");
  if (librarySearch)
    librarySearch.oninput = (e) => {
      librarySearchQuery = String(e.target.value || "");
      if($("#pjskMusicSearch"))$("#pjskMusicSearch").value=librarySearchQuery;
      clearTimeout(librarySearchTimer);
      librarySearchTimer = setTimeout(() => {
        librarySearchTimer = 0;
        renderLibrary();
      }, LIBRARY_SEARCH_DEBOUNCE_MS);
    };
  function openChartImportDialog() {
    showDialog(
      "导入谱面",
      `<div style="display:grid;gap:12px"><p style="margin:0;color:#cad6e1;line-height:1.65">可一次导入单个谱包、多个 ZIP／PEZ、散装文件，或一个包含多首歌和多难度的完整文件夹。解析与存储全部在本机完成。</p><button class="btn primary" id="pickChartFiles" type="button">选择 ZIP／PEZ 或文件</button><button class="btn" id="pickChartFolder" type="button">选择完整文件夹</button><small style="color:#8da2b7;line-height:1.55">支持 PGR v1/v3、RPE、PEC、info.yml / info.json / info.txt / info.csv 与 line.csv；同一包中的每一张可识别谱面都会分别加入谱面库。</small></div>`,
    );
    $("#pickChartFiles").onclick = () => { $("#dialog").classList.add("hidden"); $("#chartInput").click(); };
    $("#pickChartFolder").onclick = () => { $("#dialog").classList.add("hidden"); $("#chartFolderInput").click(); };
  }
  $("#importCharts").onclick = openChartImportDialog;
  $("#libraryTransfer").onclick = openLibraryTransferDialog;
  $("#importOfficialFont").onclick = () => toast("本版本已将 Saira Regular 嵌入 HTML；无需单独导入，也不会受 file:// 或 URL 存储来源影响。", false, 5000);
  $("#officialFontInput").onchange = (e) => { e.target.value = ""; };
  $("#libraryTransferInput").onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const button = $("#importLibraryMigration");
    try { await importLibraryMigrationPackage(file, button); }
    catch (error) { toast(`迁移包导入失败：${error.message}`, true, 9000); }
  };
  $("#chartInput").onchange = async (e) => { const files = e.target.files; try { await importChartFiles(files); } catch (error) { Diagnostics.error("ChartImporter.input", error); toast(`导入失败：${error.message || error}`, true, 8000); } finally { e.target.value = ""; } };
  $("#chartFolderInput").onchange = async (e) => { const files = e.target.files; try { await importChartFiles(files); } catch (error) { Diagnostics.error("ChartImporter.folder", error); toast(`导入失败：${error.message || error}`, true, 8000); } finally { e.target.value = ""; } };
  $("#importPack").onclick = () => $("#packInput").click();
  $("#packInput").onchange = async (e) => {
    if (e.target.files[0]) await importResourcePack(e.target.files[0]);
    e.target.value = "";
  };
  $("#showHelp").onclick = () =>
    showDialog(
      "使用说明",
      `<div class="report">1. 选择曲目与难度，点击 START 开始游玩。曲绘与音乐会在入场画面中准备完成。
2. Tap 需要轻触，Hold 需要持续按住，Drag 需要接触，Flick 需要滑动。激活的噪域会阻挡区域内的触摸；离开噪域后，需要抬起手指再按下。
3. 点击右上角暂停；键盘 Esc 暂停／继续。暂停时可调整歌曲位置、速度，或重新开始。切换应用与锁屏也会暂停游戏。
4. 可导入 ZIP／PEZ、完整文件夹、PGR JSON、RPE JSON、PEC 和 SUS 谱面；请将音乐、曲绘与谱面一同导入。PJSK 模式支持原生 SUS 和其他谱面的固定轨道改编。
5. 每个难度旁的“导出 ZIP”会保存对应谱面、音乐、曲绘和补充资源。无敌与自动模式的成绩单独记录。
6. 已导入的谱面和设置保存在当前浏览器。更换域名、浏览器或从文件版迁移到 HTTPS 版时，可使用“库迁移”导入／导出曲库。</div>`,
    );
  $("#pauseAutoBtn").onclick = toggleAutoplay;
  $("#pauseInvincibleBtn").onclick = toggleInvincible;
  $("#pauseRevealBtn").onclick = () =>
    applyChartRevealEnabled(!chartRevealEnabled);
  $("#pausePjskBtn").onclick = () => {
    const selector = $("#pausePjskLanes");
    void switchPausedPjskMode(engine?.chart?.kind !== "pjsk", selector?.value);
  };
  $("#pausePjskLanes").onchange = (event) => {
    if (engine?.chart?.kind === "pjsk") void switchPausedPjskMode(true, event.target.value);
    else try { localStorage.setItem("phi.pjsk.lanes", event.target.value); } catch {}
  };
  $("#revealScaleRange").oninput = (e) =>
    applyChartRevealScale(Number(e.target.value) / 100);
  $("#pauseSeekRange").oninput = () => {
    if (!pauseSeekRAF) pauseSeekRAF = requestAnimationFrame(applyPauseSeekFromControl);
  };
  $("#pauseSeekRange").onchange = applyPauseSeekFromControl;
  for (const button of document.querySelectorAll("#pauseRateButtons [data-rate]"))
    button.onclick = () => applyPausePlaybackRate(button.dataset.rate);
  $("#pausePlaybackRateInput").onchange = (e) => applyPausePlaybackRate(e.target.value);
  $("#pausePlaybackRateInput").onkeydown = (e) => {
    if (e.key === "Enter") { applyPausePlaybackRate(e.currentTarget.value); e.currentTarget.blur(); }
  };
  function pauseButtons() {
    return ["#pauseBtn", "#innerPauseBtn"].map($).filter(Boolean);
  }
  function pausePointerDown(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    if (!engine?.running || engine.paused || engine.starting || engine.resumePending) return;
    engine.pause();
  }
  for (const pauseButton of pauseButtons()) {
    pauseButton.addEventListener("pointerdown", pausePointerDown, {
      passive: false,
      capture: true,
    });
    pauseButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    pauseButton.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  $("#resumeBtn").onclick = () => {
    if (pausedModeSwitchBusy) return;
    engine?.resume();
  };
  $("#restartBtn").onclick = () => {
    if (pausedModeSwitchBusy) return;
    const targetEngine = engine;
    if (!targetEngine) return;
    void targetEngine.restart().catch((error) => {
      if (engine === targetEngine) toast(`重新开始失败：${error?.message || error}`, true, 7000);
    });
  };
  $("#quitBtn").onclick = () => {
    backToLibrary();
  };
  $("#resultBack").onclick = backToLibrary;
  $("#resultRetry").onclick = retryFromResult;


  let pjskPendingItem = null, pjskPendingCard = null;
  function ensurePjskConvertPanel() {
    let panel = document.getElementById("pjskConvertPanel");
    if (panel) return panel;
    panel = document.createElement("section"); panel.id="pjskConvertPanel"; panel.className="pjskConvertPanel hidden"; panel.setAttribute("aria-hidden","true");
    panel.innerHTML=`<div class="pjskConvertBox" role="dialog" aria-modal="true" aria-labelledby="pjskConvertTitle"><div class="pjskConvertHead"><div><h2 id="pjskConvertTitle">PJSK 改编设置</h2><p>保留时间轴和音符类型，使用统一键宽和有序和弦分配改编为固定轨道；默认 12 细分轨。原生 SUS 直接使用谱面指定的键宽。</p></div><button id="pjskConvertClose" class="pjskConvertClose" type="button" aria-label="关闭">×</button></div><div class="pjskLaneField"><label><b>轨数 <span id="pjskLaneLabel">12K</span></b><input id="pjskLaneRange" type="range" min="2" max="24" step="1" value="12"></label><input id="pjskLaneNumber" class="pjskLaneNumber" type="number" min="2" max="24" step="1" value="12" inputmode="numeric"></div><div class="pjskConvertHint">改编谱每个 Note 使用相同的键宽，不再根据密度随机缩窄。超出轨道容量的和弦会在诊断中提示。原生 SUS 保留作者排键。</div><div class="pjskLicenseNote">PJSK 透视/接近数学参考 Next-SEKAI 的 MIT 开源实现；全部内置曲目离线运行。</div><div class="pjskConvertActions"><button id="pjskConvertCancel" class="btn" type="button">取消</button><button id="pjskConvertStart" class="btn primary" type="button">转换并开始</button></div></div>`;
    document.getElementById("app")?.appendChild(panel);
    const range=panel.querySelector("#pjskLaneRange"), number=panel.querySelector("#pjskLaneNumber"), label=panel.querySelector("#pjskLaneLabel");
    const sync=(value)=>{ const lanes=clamp(Math.round(Number(value)||12),PJSK_MIN_LANES,PJSK_MAX_LANES); range.value=String(lanes); number.value=String(lanes); label.textContent=`${lanes}K`; };
    range.oninput=()=>sync(range.value); number.oninput=()=>sync(number.value);
    const close=()=>{ panel.classList.add("hidden"); panel.setAttribute("aria-hidden","true"); pjskPendingItem=null; pjskPendingCard=null; };
    panel.querySelector("#pjskConvertClose").onclick=close; panel.querySelector("#pjskConvertCancel").onclick=close;
    panel.addEventListener("pointerdown",e=>{ if(e.target===panel) close(); });
    panel.querySelector("#pjskConvertStart").onclick=async()=>{
      const item=pjskPendingItem, card=pjskPendingCard, lanes=clamp(Math.round(Number(number.value)||12),PJSK_MIN_LANES,PJSK_MAX_LANES); if(!item) return close();
      const start=panel.querySelector("#pjskConvertStart"); start.disabled=true; firstPlayAudioPrime=Engine.primeAudioFromGesture();
      try {
        close();
        const c=libraryPayload(item), fallback=card?._bgBlob || libraryFocusBgBlob;
        if(item.builtin) await startBuiltinPack(c,{mode:"pjsk",lanes});
        else { await beginLoadingPresentation(c,fallback); const full=await resolvePlayableRecord(c); updateLoadingPresentation(full,fallback); await startChart(full,true,{mode:"pjsk",lanes}); }
      } catch(error) { cancelLoadingPresentation(); toast(`PJSK 转换/启动失败：${error?.message||error}`,true,8000); }
      finally { start.disabled=false; }
    };
    return panel;
  }
  function openPjskConvertPanel(item, card) {
    pjskPendingItem=item; pjskPendingCard=card;
    const panel=ensurePjskConvertPanel(), range=panel.querySelector("#pjskLaneRange"), number=panel.querySelector("#pjskLaneNumber"), label=panel.querySelector("#pjskLaneLabel");
    let savedLanes = PJSK_DEFAULT_LANES; try { savedLanes = Number(localStorage.getItem("phi.pjsk.lanes")) || PJSK_DEFAULT_LANES; } catch {}
    const lanes=clamp(Math.round(savedLanes),PJSK_MIN_LANES,PJSK_MAX_LANES); range.value=number.value=String(lanes); label.textContent=`${lanes}K`;
    const persist=()=>{ try{localStorage.setItem("phi.pjsk.lanes",String(clamp(Math.round(Number(number.value)||lanes),PJSK_MIN_LANES,PJSK_MAX_LANES)));}catch{} };
    range.addEventListener("change",persist,{once:true}); number.addEventListener("change",persist,{once:true}); panel.classList.remove("hidden"); panel.setAttribute("aria-hidden","false"); setTimeout(()=>range.focus(),0);
  }


  function installNextUI() {
    const inputDiagnostics = $("#inputDiagnosticsBtn");
    if (inputDiagnostics) inputDiagnostics.onclick = () => performanceMonitor.toggle();
    const inputVersion = $("#inputDiagnosticsVersion");
    if (inputVersion) inputVersion.textContent = ` 当前修复版本：${PHI_VERSIONS.runtime}`;
    const dialog = $("#dialog");
    dialog?.setAttribute("role", "dialog"); dialog?.setAttribute("aria-modal", "true"); dialog?.setAttribute("aria-labelledby", "dialogTitle");
    dialog?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); closeDialog(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])")].filter((el) => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.documentElement.dataset.phiRuntime = PHI_VERSIONS.runtime;
    syncAssistIndicators(engine);
  }

  async function runPhiSelfTests() {
    const results = [], test = async (name, fn) => { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: error?.message || String(error) }); } };
    const assert = (value, message = "assertion failed") => { if (!value) throw new Error(message); };
    await test("strict archive paths", () => { assert(safeArchivePath("song/chart.json") === "song/chart.json"); assert(!safeArchivePath("../secret")); assert(!safeArchivePath("/absolute")); assert(!safeArchivePath("CON/file")); });
    await test("SHA-256 identity", async () => assert((await audioContentSignature(new Blob(["phi"]))).startsWith("sha256:")));
    await test("offline metadata", () => { const meta = JSON.parse(document.getElementById("phiBuildMetadata").textContent); assert(/^[a-f0-9]{64}$/.test(meta.coreSha256)); assert(meta.runtime === PHI_VERSIONS.runtime); });
    await test("canonical speed input", () => { assert(canonicalDecimalInput("0001.5000") === "1.5"); assert(canonicalDecimalInput("0.0500") === "0.05"); });
    await test("seek prefix judgement", () => { assert(skippedNoteJudgement(true, false) === 0); assert(skippedNoteJudgement(false, true) === 0); assert(skippedNoteJudgement(false, false) === 3); });
    await test("pause transport controls", () => { assert($("#pauseSeekRange")?.type === "range"); assert($("#pausePlaybackRateInput")); });
    await test("built-in resources", async () => { assert(BUILTIN_PACKS.length > 0); assert(BUILTIN_RESOURCE_PACK); const pack=await loadBuiltinResourcePack(); assert(["tap","hold","flick","drag"].every(key=>pack?.images?.[key]),"Bundled note textures did not decode"); });
    await test("PJSK fixed-lane conversion", () => { const sample=parsePGR({formatVersion:3,offset:0,judgeLineList:[{bpm:120,speedEvents:[{startTime:0,endTime:128,value:1}],notesAbove:[{type:1,time:32,holdTime:0,positionX:-3,speed:0},{type:4,time:32,holdTime:0,positionX:3,speed:1}],notesBelow:[],judgeLineDisappearEvents:[],judgeLineMoveEvents:[],judgeLineRotateEvents:[]}]}); const converted=convertChartToPjsk(sample,12); assert(converted.kind==="pjsk"&&converted.pjskLaneCount===12&&converted.lines[0].notes.every(n=>n.speed===1),"PJSK conversion did not normalize fixed-lane flow"); });
    await test("SUS authored widths, BPM and slide path", () => {
      const chart=parseChart('sus', '#BPM01: 120\n#BPM02: 240\n#00002: 4\n#00008: 0102\n#00012: 1200\n#00032a: 12000000\n#00032a: 00000023');
      assert(chart.nativePjsk&&chart.lines[0].notes.some(n=>n._pjskSpan===2),'SUS lane width lost');
      assert(chart.lines[0].notes.some(n=>n.type===3&&n._pjskPath?.length===2),'SUS slide missing');
      assert(Math.abs(chart.lines[0].notes.find(n=>n.type===3).end-1.25)<1e-6,'SUS BPM integration');
    });
    await test("PJSK conversion has no invented widths or slide paths", () => {
      const sample=parseChart('sus','#BPM01: 120\n#00008: 01\n#00012: 1200');
      assert(convertChartToPjsk(sample)===sample,'native chart was converted');
    });
    await test("PJSK projection grows toward the line", () => {
      for (const lanes of [2, 3, 12, 24]) {
        const stage = pjskStageGeometry({w:1600,h:900,chart:{pjskLaneCount:lanes}});
        let previous = 0;
        for (const travel of [.08,.25,.5,.75,.92,1]) {
          const width = pjskAutoNoteMetrics(stage,0,1,travel).width;
          assert(width >= previous, `${lanes}K Note shrank near the line`);
          previous = width;
        }
      }
    });
    await test("PJSK curved long-note path", () => {
      const path = {_pjskLane:0,_pjskMidLane:.65,_pjskTailLane:1};
      assert(pjskSlideLane(path,0) === 0 && pjskSlideLane(path,1) === 1 &&
        pjskSlideLane(path,.5) > 0 && pjskSlideLane(path,.5) < 1,
        "long-note bend must meet both playable ends");
    });
    await test("official PGR timing and flow", () => {
      assert(Math.abs((60 / 32) - 1.875) < 1e-12, "PGR 32nd-beat constant changed");
      assert(Math.abs(0.34 * builtinDefault("noteSpeedScale") - 0.6) < 1e-12, "official 60% viewport flow mismatch");
      const sample = parsePGR({ formatVersion:3, offset:0, judgeLineList:[{ bpm:120, speedEvents:[{startTime:0,endTime:128,value:1}], notesAbove:[{type:1,time:32,holdTime:0,positionX:0,speed:1,floorPosition:9.25},{type:3,time:64,holdTime:32,positionX:0,speed:2,floorPosition:4.5}], notesBelow:[], judgeLineDisappearEvents:[], judgeLineMoveEvents:[], judgeLineRotateEvents:[] }] });
      const tap = sample.lines[0].notes[0], hold = sample.lines[0].notes[1];
      assert(tap.floor === 9.25, "authored floorPosition was not preserved");
      assert(Math.abs((hold.endFloor - hold.floor) - 0.5) < 1e-12, "Hold length must use holdSeconds before note.speed");
    });
    await test("assist isolation", () => { const q = qualificationFor({ usedAutoplay: true, usedInvincible: false, usedReveal: false, usedKeyboard: false }); assert(!q.ranked && q.assistFlags.autoplay); });
    await test("native chord snapshot reconstructs down edge", () => {
      const probe = Object.create(Engine.prototype);
      probe.useNativeTouchInput = true; probe.pointer = new Map(); probe.pointerPool = [];
      probe.nativeTouchBlocked = new Set(); probe.nativeTouchLiveIds = new Set(); probe.activeHolds = new Set();
      probe.inputRect = { left:0, top:0, width:1000, height:500 }; probe.viewX = 0; probe.viewY = 0; probe.viewScale = 1; probe.w = 1000; probe.h = 500; Object.defineProperty(probe,"time",{value:1,writable:true});
      let taps = 0, drags = 0; probe.tryTap = () => { taps++; }; probe.tryArmDrag = () => { drags++; }; probe.releasePointerState = () => {}; probe.eventAudioTime = () => 1;
      const touch = { identifier:7, clientX:220, clientY:180 };
      probe.recoverNativeTouchSnapshot({ touches:[touch], timeStamp:100 }, { synthesizeMissingDown:true, reconcileMissing:true, reviveLive:true });
      assert(probe.pointer.size === 1 && taps === 1 && drags === 1, "snapshot-only finger did not receive one down edge");
      probe.recoverNativeTouchSnapshot({ touches:[], timeStamp:108 }, { reconcileMissing:true, reviveLive:true });
      assert(probe.pointer.size === 0, "stale native contact survived authoritative empty snapshot");
    });
    await test("touch and pointer down share exactly one physical edge", () => {
      for (const pointerFirst of [true,false]) {
        const probe=Object.create(Engine.prototype), stamp=performance.now();
        Object.assign(probe,{useNativeTouchInput:true,running:true,pointer:new Map(),pointerPool:[],nativePointerLinks:new Map(),nativeTouchBlocked:new Set(),nativeTouchLiveIds:new Set(),activeHolds:new Set(),pendingJudge:new Set(),inputRect:{left:0,top:0},viewX:0,viewY:0,viewScale:1,w:1000,h:500});
        let taps=0;probe.tryTap=()=>taps++;probe.tryArmDrag=()=>{};probe.eventAudioTime=()=>1;
        const touch={identifier:1,clientX:300,clientY:200},pointer={pointerId:7,pointerType:"touch",clientX:300,clientY:200,timeStamp:stamp};
        const native={changedTouches:[touch],touches:[touch],timeStamp:stamp};
        if(pointerFirst){probe.pointerDown(pointer);probe.touchStart(native);}else{probe.touchStart(native);probe.pointerDown(pointer);}
        assert(taps===1&&probe.pointer.size===1,"same physical contact was lost or counted twice");
        probe.pointerUp(pointer);
        assert(probe.pointer.size===0&&probe.nativePointerLinks.size===0,"ended bridge remained active");
      }
    });
    await test("refresh meter never reports 110 Hz as 120", () => {
      const cadence=new HighRefreshController();cadence.start();
      for(let i=0;i<60;i++)cadence.observe(1000/110);
      assert(Math.abs(cadence.measuredHz()-110)<1e-8,"refresh meter rounded up the actual cadence");
      for(let i=0;i<40;i++)cadence.observe(100);
      assert(cadence.measuredHz()<15,"slow frames were omitted from the actual cadence");
    });
    await test("Hold handoff prefers live replacement contact", () => {
      const probe = Object.create(Engine.prototype), old = { id:-2, active:false, cancelled:true, ghostUntil:99 }, replacement = { id:-3, active:true };
      probe.pointer = new Map([[old.id, old], [replacement.id, replacement]]);
      probe.keyboardPointer = { id:"keyboard" };
      probe.touchMatchesNote = (_L, _n, p) => p === replacement;
      const found = probe.findTouchForNote({}, {}, 0, true, 1, old.id);
      assert(found === replacement, "live replacement did not take Hold ownership");
    });
    await test("multi-contact note-type isolation", () => {
      const probe = Object.create(Engine.prototype);
      Object.defineProperty(probe,"time",{value:1,writable:true}); probe.chart={kind:"pgr"}; probe.clockDrift = 0; probe.currentVisualTime = 1; probe.w = 1200;
      probe.candidateScratch = {}; probe.pendingJudge = new Set(); probe.activeHolds = new Set(); probe.metricsCandidates = 0;
      probe.lineScreen = () => ({ cx:0, cy:0, ux:1, uy:0 }); probe.judgeHalfWidth = () => 90;
      probe.commit = (n) => { n.state = 1; n._probeHit = true; }; probe.playSound = () => {}; probe.hitEffect = () => {};
      const L = { id:0 }, hold = { type:3,time:.9,end:2,_along:100,state:2,fake:false }, heldBlue = { type:1,time:1,_along:100,state:1,fake:false },
        secondBlue = { type:1,time:1,_along:300,state:0,fake:false }, yellow = { type:2,time:1,_along:500,state:0,fake:false }, red = { type:4,time:1,_along:700,state:0,fake:false };
      const notes = [hold, heldBlue, secondBlue, yellow, red].sort((a,b) => a.time - b.time);
      probe.noteItems = notes.map((n) => { const item = { L, n }; n._item = item; return item; });
      probe.noteTimes = Float64Array.from(probe.noteItems, (item) => item.n.time);
      probe.tryTap(-9, 300, 300, 1); probe.tryArmDrag(-10, 500, 300, 1); probe.tryFlick(-11, 700, 300, 1);
      assert(secondBlue._probeHit && yellow._probeHit && red._probeHit, "another active contact locked Tap/Drag/Flick judgement");
    });
    await test("iPad chord move recovers omitted changedTouches", () => {
      const probe = Object.create(Engine.prototype);
      probe.useNativeTouchInput = true; probe.running = true; probe.paused = false;
      probe.starting = false; probe.resumePending = false; probe.autoplay = false;
      probe.pointer = new Map(); probe.pointerPool = []; probe.activeHolds = new Set();
      probe.nativeTouchBlocked = new Set(); probe.nativeTouchLiveIds = new Set();
      probe.nativeTouchChangedIds = new Set(); probe.pointScratchA = {};
      probe.inputRect = { left:0, top:0 }; probe.viewX = probe.viewY = 0;
      probe.viewScale = 1; probe.w = 1000; probe.h = 500;
      probe.eventAudioTime = () => 1; probe.tryTap = () => {};
      const segments = []; probe.armDragAlongPath = (id, x, y, _t, fromX) => segments.push([id, fromX, x]);
      probe.armFlickAlongPath = () => {};
      const first = { identifier:1, clientX:100, clientY:200 },
        second = { identifier:2, clientX:300, clientY:200 };
      probe.pointer.set(-2, probe.acquireTouchState(first, 100));
      probe.pointer.set(-3, probe.acquireTouchState(second, 100));
      const firstMoved = { ...first, clientX:130 }, secondMoved = { ...second, clientX:480 };
      probe.touchMove({ changedTouches:[firstMoved], touches:[firstMoved,secondMoved], timeStamp:115 });
      assert(probe.pointer.size === 2 && probe.pointer.get(-2).x === 130 && probe.pointer.get(-3).x === 480,
        "omitted finger position or other contact was lost");
      assert(segments.some(([id, fromX, toX]) => id === -3 && fromX === 300 && toX === 480),
        "cross-lane motion did not reach the independent gesture path");
    });
    await test("hit visuals defer outside input callback", () => {
      const probe = Object.create(Engine.prototype);
      probe.hitRequestQueue = []; probe.hitRequestPool = []; probe.frameNow = 0; probe.lastHitPerf = 0; Object.defineProperty(probe,"time",{value:1,writable:true});
      let emitted = 0; probe.emitHitEffect = () => { emitted++; };
      probe.hitEffect({}, {}, 0, 1);
      assert(emitted === 0 && probe.hitRequestQueue.length === 1, "hit visual ran synchronously");
      probe.flushHitEffects();
      assert(emitted === 1 && probe.hitRequestQueue.length === 0, "deferred hit visual did not flush exactly once");
    });
    await test("host injection stripped", () => {
      assert(!document.querySelector("[data-oneopenai-tracker-block],[data-oneopenai-sentinel-guard]"));
      const polluted = [...document.querySelectorAll("script[src],link[href]")].some((el) => /cloudflareinsights|\/_ooa\/|\/(?:Static|Web)\//i.test(el.getAttribute("src") || el.getAttribute("href") || ""));
      assert(!polluted, "host/network asset survived standalone cleanup");
    });
    await test("unique DOM ids", () => { const ids = [...document.querySelectorAll("[id]")].map((el) => el.id); assert(ids.length === new Set(ids).size); });
    await test("same-origin resource policy", () => assert(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content.includes("connect-src 'self'")));
    const passed = results.filter((item) => item.ok).length, report = { passed, total: results.length, results, versions: PHI_VERSIONS };
    Diagnostics.info("SelfTest", `自检 ${passed}/${results.length} 通过`, report);
    document.documentElement.dataset.phiSelfTest = passed === results.length ? "pass" : "fail";
    window.__phiSelfTestResult = report;
    return report;
  }


  let dualMenuMode='phi';
  function setDualMenuMode(mode){
    dualMenuMode=mode==='pjsk'?'pjsk':'phi';document.body.dataset.menuMode=dualMenuMode;
    document.querySelectorAll('.dualModeTabs button').forEach(b=>{const on=b.dataset.mode===dualMenuMode;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
    const kicker=$('.libraryFocusKicker');if(kicker)kicker.textContent=dualMenuMode==='pjsk'?'MUSIC SELECT / SOLO LIVE':'SELECT MUSIC';
    setLibraryMoreOpen(false);syncLibraryFocus();syncPjskAutoNoteSizeUI();previewEpoch=0;
    if(!$('#settingsPanel').classList.contains('hidden'))drawNotePreview();
  }
  function installDualUI(){
    document.body.dataset.menuMode='phi';
    document.body.dataset.pjskListMode='grid';
    $('#pjskMusicSearch').oninput=(event)=>{const search=$('#librarySearch');search.value=event.target.value;search.dispatchEvent(new Event('input',{bubbles:true}));};
    $('#pjskListToggle').onclick=()=>{const list=document.body.dataset.pjskListMode!=='list';document.body.dataset.pjskListMode=list?'list':'grid';$('#pjskListToggle').textContent=list?'▦ 网格':'☷ 列表';$('#pjskListToggle').setAttribute('aria-pressed',String(list));};
    const list=$('#chartList');list.addEventListener('keydown',event=>{if(!event.target.classList.contains('card'))return;const cards=[...list.querySelectorAll('.card')],at=cards.indexOf(event.target),columns=dualMenuMode==='pjsk'&&document.body.dataset.pjskListMode!=='list'?getComputedStyle(list).gridTemplateColumns.split(' ').length:1,delta=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:event.key==='ArrowDown'?columns:event.key==='ArrowUp'?-columns:0;if(delta){event.preventDefault();const next=cards[clamp(at+delta,0,cards.length-1)];focusLibraryCard(next);next.focus({preventScroll:true});next.scrollIntoView({block:'nearest'});}});
    const sortHost=$('#chartList'),observer=new MutationObserver(()=>{const cards=[...sortHost.querySelectorAll('.card')];$('.libraryOfficialProfileText span').textContent=cards.length+' 首曲目';});observer.observe(sortHost,{childList:true});
    document.querySelectorAll('.dualModeTabs button').forEach(b=>b.onclick=()=>setDualMenuMode(b.dataset.mode));
    $('#phiVideoSettings').onclick=openSettingsPanel;
    $('#phiVideoRandom').onclick=()=>{const cards=[...document.querySelectorAll('#chartList .card')];cards[Math.floor(Math.random()*cards.length)]?.click();};
    let sortAsc=false;
    $('#phiVideoSort').onclick=()=>{
      sortAsc=!sortAsc;const host=$('#chartList');const cards=[...host.querySelectorAll('.card')];
      cards.sort((a,b)=>(Number(a.dataset.videoLevel)||0)-(Number(b.dataset.videoLevel)||0));if(!sortAsc)cards.reverse();
      for(const card of cards)host.appendChild(card);$('#phiVideoSort b').textContent=sortAsc?'等级升序':'等级降序';
    };
    $('#pauseMoreBtn').onclick=()=>{
      const panel=$('#pausePanel'),on=!panel.classList.contains('moreOpen');panel.classList.toggle('moreOpen',on);
      $('#pauseMoreBtn').setAttribute('aria-expanded',String(on));$('#pauseMoreSheet').setAttribute('aria-hidden',String(!on));
      if(on){syncPauseTransportUI(engine);syncPausedPjskControls();}
    };
    new MutationObserver(()=>{const panel=$('#pausePanel');if(panel.classList.contains('hidden')&&panel.classList.contains('moreOpen'))panel.classList.remove('moreOpen');}).observe($('#pausePanel'),{attributes:true,attributeFilter:['class']});
    const help=$('#showHelp');if(help)help.onclick=()=>showDialog('双模式游玩',
      '<p>PHIGROS：导入 PGR JSON / RPE / PEC 谱包，保留动态判定线、上下出键和原谱事件。</p><p>PJSK：导入 SUS 和配套音乐，保留原谱 12 细分轨、键宽、滑键、BPM 和变速。选择 PJSK 标签后，其他格式会改编为统一宽度的固定轨道谱。</p><p>触控：轻点蓝键，按住并跟随绿色滑键，滑动粉色 Flick。六列键盘：S D F J K L；上方 W E R U I O 对应 Flick。Esc 暂停。</p><p>暂停 → 更多：切换模式、流速、校准和练习进度。原生 SUS 始终使用 PJSK。</p><p>两种模式是离线模拟器。PJSK 显示本地归一化成绩，不包含官方角色、技能与队伍加成。</p>');
  }
  function updatePjskResults(e){
    const active=e.chart.kind==='pjsk';document.body.classList.toggle('pjskResultActive',active);
    $('#greatResultMetric').classList.toggle('hidden',!active);
    const grid=$('.resultJudgeGrid');grid.querySelectorAll('.resultMetric').forEach(el=>{
      if(el.querySelector('#rEarly')||el.querySelector('#rLate'))el.classList.toggle('hidden',active);
    });
    if(!active){$(".resultSyncTag").textContent="RESULT";return;}
    const counts=e.pjskCounts||[0,0,0,0,0];
    ['rPerfect','rGreat','rGood','rBad','rMiss'].forEach((id,i)=>$('#'+id).textContent=counts[i]);
    $('#rAcc').textContent=(e.accuracy()*100).toFixed(2)+'%';
    $('#resultScore').textContent=fmtScore(e.score());
    $('#resultGrade').textContent=counts[0]===e.total?'AP':counts[2]+counts[3]+counts[4]===0?'FC':'';
    $('.resultSyncTag').textContent='LIVE RESULT';
  }

  // Deterministic offline rendering. These are the same Engine draw/update and
  // original noise shaders used by live gameplay; no MediaRecorder/rAF capture.
  const VIDEO_EXPORT_ASPECTS=Object.freeze({'4:3':[4,3],'9:16':[9,16],'16:9':[16,9]});
  const VIDEO_EXPORT_RESOLUTIONS=Object.freeze([1080,1440,2160]);
  function videoExportSpec(options={}){
    const aspect=options.aspect==='9'?'9:16':String(options.aspect||'4:3'),ratio=VIDEO_EXPORT_ASPECTS[aspect],resolution=Number(options.resolution||1080),fps=Number(options.fps||60);
    if(!ratio||!VIDEO_EXPORT_RESOLUTIONS.includes(resolution)||![30,60,120].includes(fps))throw Error('请选择 4:3 / 9:16 / 16:9、1080P～4K 和 30 / 60 / 120 fps。');
    const [a,b]=ratio,portrait=a<b,width=portrait?resolution:Math.round(resolution*a/b),height=portrait?Math.round(resolution*b/a):resolution;
    return {width,height,fps,aspect,resolution};
  }
  let videoExportJob=null,videoExportLast=null,videoExportSelection=null;
  // A real fixed-size CSS viewport: media queries, vw/vh, fonts and HUD geometry
  // all see the selected video aspect, independently of the host device.
  class PhiExportViewport {
    static async create(width,height){
      if(phiExportViewport)throw Error('导出布局尚未释放。');
      const view=new PhiExportViewport();
      view.width=width;view.height=height;view.dpr=1;
      view.frame=document.createElement('iframe');
      view.frame.title='视频逐帧渲染';view.frame.setAttribute('aria-hidden','true');view.frame.tabIndex=-1;
      view.frame.style.cssText=`position:fixed;left:-30000px;top:0;width:${width}px;height:${height}px;border:0;pointer-events:none;opacity:0;`;
      view.url=URL.createObjectURL(new Blob(['<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'],{type:'text/html'}));
      try{
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('无法建立固定比例画面。')),15000);
          view.frame.onload=()=>{clearTimeout(timer);resolve();};
          view.frame.onerror=()=>{clearTimeout(timer);reject(Error('无法打开视频渲染画面。'));};
          view.frame.src=view.url;document.body.appendChild(view.frame);
        });
        view.document=view.frame.contentDocument;
        await Promise.all([...document.querySelectorAll('style,link[rel="stylesheet"]')].map(style => {
          if (style.tagName !== 'LINK') { view.document.head.appendChild(style.cloneNode(true)); return Promise.resolve(); }
          return new Promise((resolve, reject) => {
            const link = style.cloneNode(true); link.href = style.href;
            link.onload = resolve; link.onerror = () => reject(Error('视频导出样式加载失败。'));
            view.document.head.appendChild(link);
          });
        }));
        view.syncRoot();
        // CSS-connected FontFace objects cannot be added to another document's
        // FontFaceSet (InvalidModificationError in Safari). The copied style
        // rules create independent faces from the exact same embedded bytes.
        await view.loadFonts();
        const css=view.document.createElement('style');
        css.textContent='html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;overflow:hidden!important}#gameView{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;min-height:0!important}#gameView,#gameView *{animation:none!important;transition:none!important}';
        view.document.head.appendChild(css);
        view.gameView=document.querySelector('#gameView');
        if(!view.gameView)throw Error('游戏画面不存在。');
        view.anchor=document.createComment('video-export-game-view');view.gameView.before(view.anchor);
        let container=view.document.body;
        const parents=[];for(let p=view.gameView.parentElement;p&&p!==document.body;p=p.parentElement)parents.unshift(p);
        for(const parent of parents){const clone=parent.cloneNode(false);container.appendChild(clone);container=clone;}
        container.appendChild(view.gameView);
        phiExportViewport=view;
        syncGameViewportCSS();
        await view.loadFonts();
        return view;
      }catch(error){view.close();throw error;}
    }
    async loadFonts(){
      const fonts=this.document.fonts;
      if(!fonts?.load)throw Error('浏览器无法加载导出画面的原字体。');
      const required=await withTimeout(fonts.load('400 16px "PhiEmbeddedSaira"','0123456789 AUTOPLAY COMBO PHIGROS'),20000,'导出原字体加载超时，请重试。');
      if(!required.length||required.some(face=>face.status!=='loaded'))throw Error('原版 Saira 字体没有加载完成，已停止导出。');
      await withTimeout(fonts.load('16px "PhiCJK"','乐曲难度自动游玩'),20000,'导出中文字体加载超时，请重试。');
      await withTimeout(Promise.all([fonts.ready,document.fonts.ready]),20000,'导出字体尚未准备完成，请重试。');
    }
    syncRoot(){
      if(!this.document)return;
      for(const [from,to] of [[document.documentElement,this.document.documentElement],[document.body,this.document.body]]){
        for(const attr of from.attributes)to.setAttribute(attr.name,attr.value);
      }
      const root=this.document.documentElement;
      root.style.setProperty('--phi-safe-area-bottom','0px');
      for(const [key,value] of Object.entries({'--ref-u':this.width/682,'--ref-y':this.height/512,'--ref-w':this.width,'--ref-h':this.height,'--scene-u':this.width/682,'--scene-y':this.height/512}))root.style.setProperty(key,`${value}px`);
    }
    close(){
      if(this.anchor?.parentNode&&this.gameView)this.anchor.replaceWith(this.gameView);
      if(phiExportViewport===this)phiExportViewport=null;
      this.frame?.remove();if(this.url)URL.revokeObjectURL(this.url);
      syncGameViewportCSS();
    }
  }

  // Store only tiny metadata in memory. MP4 bytes stay in OPFS, including
  // while the browser's download subsystem consumes their native Blob URL.
  function phiVideoStoreWorker(){
    const valid=p=>typeof p==='string'&&p.endsWith('.mp4')&&!/[\\/]/.test(p);
    const root=()=>navigator.storage.getDirectory().then(r=>r.getDirectoryHandle('phi-video-exports',{create:true}));
    async function put(dir,entry){
      if(!valid(entry.path))throw Error('无效的视频文件名。');
      const handle=await dir.getFileHandle(entry.path+'.json',{create:true}),data=new TextEncoder().encode(JSON.stringify(entry));
      if(handle.createWritable){const out=await handle.createWritable();try{await out.write(data);await out.close();}catch(e){try{await out.abort();}catch{}throw e;}}
      else if(handle.createSyncAccessHandle){const out=await handle.createSyncAccessHandle();try{out.truncate(0);let n=0;while(n<data.length){const size=out.write(data.subarray(n),{at:n});if(!size)throw Error('保存视频目录失败。');n+=size;}out.flush();}finally{out.close();}}
      else throw Error('浏览器不支持保存视频目录。');
      return entry;
    }
    async function complete(file){
      if(file.size<128)return false;
      const head=new Uint8Array(await file.slice(0,12).arrayBuffer()),tail=new Uint8Array(await file.slice(-16).arrayBuffer());
      // Fragmented MP4 is finalized with an mfro box. This also recovers videos
      // from earlier app versions and a reload between finalization and commit.
      return String.fromCharCode(...head.slice(4,8))==='ftyp'&&String.fromCharCode(...tail.slice(4,8))==='mfro';
    }
    onmessage=async({data:m})=>{
      try{
        const dir=await root();let result;
        if(m.type==='put')result=await put(dir,m.entry);
        else if(m.type==='delete'){
          if(!valid(m.path))throw Error('无效的视频文件名。');
          await dir.removeEntry(m.path);try{await dir.removeEntry(m.path+'.json');}catch{}result=true;
        }else if(m.type==='list'){
          result=[];
          for await(const [name,handle]of dir.entries()){
            if(handle.kind!=='file'||!valid(name))continue;
            try{
              const file=await handle.getFile();if(!await complete(file))continue;
              let entry;try{const meta=await(await dir.getFileHandle(name+'.json')).getFile();if(meta.size<=65536)entry=JSON.parse(await meta.text());}catch{}
              if(!entry||entry.path!==name||entry.state!=='complete'){
                entry={...(entry?.path===name?entry:{}),path:name,name:entry?.name||name,state:'complete',created:entry?.created||file.lastModified,recovered:true};
                try{await put(dir,entry);}catch{}
              }
              result.push({...entry,size:file.size});
            }catch{}
          }
          result.sort((a,b)=>(b.created||0)-(a.created||0));
        }else throw Error('未知的视频保存操作。');
        postMessage({id:m.id,result});
      }catch(e){postMessage({id:m.id,error:e.message,name:e.name});}
    };
  }
  const PhiVideoStore={
    entries:[],
    async call(type,data={}){
      const url=URL.createObjectURL(new Blob(['('+phiVideoStoreWorker.toString()+')()'],{type:'text/javascript'})),worker=new Worker(url);
      try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('读取已保存视频超时。')),120000);worker.onmessage=({data:m})=>{clearTimeout(timer);if(m.error){const e=Error(m.error);e.name=m.name;reject(e);}else resolve(m.result);};worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message||'视频文件操作失败。'));};worker.postMessage({id:1,type,...data});});}
      finally{worker.terminate();URL.revokeObjectURL(url);}
    },
    async list(){this.entries=await this.call('list');return this.entries;},
    async put(entry){await this.call('put',{entry});this.entries=[entry,...this.entries.filter(x=>x.path!==entry.path)];return entry;},
    async file(entry){const dir=await(await navigator.storage.getDirectory()).getDirectoryHandle('phi-video-exports');return(await dir.getFileHandle(entry.path)).getFile();},
    async remove(path){if(videoExportJob||videoExportSaving)throw Error('请等待当前操作完成。');await this.call('delete',{path});this.entries=this.entries.filter(x=>x.path!==path);if(videoExportLast?.path===path){URL.revokeObjectURL(videoExportLast.url);videoExportLast=null;}await refreshSavedVideos();},
    async persist(){try{if(!await navigator.storage.persisted?.())await navigator.storage.persist?.();}catch{}}
  };
  let videoExportSaving=false,videoHistoryGeneration=0;
  function videoNeedsDownload(entry){return entry.size>32*1048576||(entry.height>=2160&&entry.fps>=120);}
  function videoExportDescription(entry){return`${entry.aspect?entry.aspect+' · ':''}${entry.width?entry.width+'×'+entry.height+' / '+entry.fps+' fps · ':''}${(entry.size/1048576).toFixed(1)} MB`;}
  function showVideoExportActions(){
    const save=$('#videoExportSave'),share=$('#videoExportShare'),entry=videoExportLast;
    if(!save||!share)return;
    const ready=entry&&!videoExportJob&&!videoExportSaving;
    save.hidden=share.hidden=!ready;
    if(!ready){save.removeAttribute('href');return;}
    save.href=entry.url;save.download=entry.name;save.textContent='下载 MP4';
    share.textContent=videoNeedsDownload(entry)?'存储大视频':'分享／存储';
    if(!videoNeedsDownload(entry)&&!navigator.canShare?.({files:[entry.file]}))share.hidden=true;
  }
  async function selectSavedVideo(path,announce=true){
    if(videoExportJob||videoExportSaving)return;
    const entry=PhiVideoStore.entries.find(x=>x.path===path);if(!entry)return;
    const file=await PhiVideoStore.file(entry);if(videoExportJob||videoExportSaving)return;
    if(videoExportLast?.url)URL.revokeObjectURL(videoExportLast.url);
    videoExportLast={...entry,file,url:URL.createObjectURL(file)};showVideoExportActions();
    if(announce)setVideoExportStatus(`已保存 · ${entry.name} · ${videoExportDescription(entry)}。可刷新或下次打开本网站后继续下载。`,1);
  }
  async function refreshSavedVideos(restore=false){
    const target=$('#videoExportHistory');if(!target)return;const generation=++videoHistoryGeneration;
    try{
      const entries=await PhiVideoStore.list();if(generation!==videoHistoryGeneration)return;
      target.replaceChildren();
      if(!entries.length){target.textContent='暂无已保存的视频。';return;}
      for(const entry of entries){
        const row=document.createElement('div');row.className='videoSavedRow';
        const text=document.createElement('span');text.textContent=entry.name+' · '+videoExportDescription(entry);row.append(text);
        const get=document.createElement('button');get.type='button';get.textContent='选择下载';get.disabled=!!videoExportJob||videoExportSaving;
        get.onclick=()=>selectSavedVideo(entry.path).catch(e=>setVideoExportStatus('读取失败：'+e.message));row.append(get);
        const remove=document.createElement('button');remove.type='button';remove.textContent='删除';remove.disabled=get.disabled;
        let armed=false;remove.onclick=()=>{if(!armed){armed=true;remove.textContent='确认删除';return;}PhiVideoStore.remove(entry.path).catch(e=>setVideoExportStatus('删除失败：'+e.message));};row.append(remove);target.append(row);
      }
      if(restore&&!videoExportJob&&!videoExportSaving&&!videoExportLast)await selectSavedVideo(entries[0].path);
      showVideoExportActions();
    }catch(e){target.textContent='无法读取已保存视频：'+e.message;}
  }
  function downloadSavedVideo(event){
    const entry=videoExportLast;
    if(!entry||videoExportJob||videoExportSaving){event?.preventDefault();return;}
    if(typeof showSaveFilePicker==='function'){
      event?.preventDefault();saveVideoWithPicker(entry);return;
    }
    // A disk-backed File URL lets Safari download without JS reading/copying
    // the entire MP4. Never navigate this page or create a video preview here.
    setVideoExportStatus('已交给浏览器下载。视频仍保存在本网站，可随时再次下载。大视频下载后可在“文件”中分享。',1);
  }
  async function saveVideoWithPicker(entry){
    if(videoExportSaving||videoExportJob)return;videoExportSaving=true;showVideoExportActions();
    let out;
    try{
      const handle=await showSaveFilePicker({suggestedName:entry.name,types:[{description:'MP4 视频',accept:{'video/mp4':['.mp4']}}]});
      const file=await PhiVideoStore.file(entry);out=await handle.createWritable();
      for(let offset=0;offset<file.size;offset+=1048576)await out.write(await file.slice(offset,offset+1048576).arrayBuffer());
      await out.close();out=null;setVideoExportStatus('视频已下载，网站中的已保存版本仍可使用。',1);
    }catch(e){try{await out?.abort();}catch{}if(e.name!=='AbortError')setVideoExportStatus('下载未完成：'+e.message+'。视频已保留，可重试。');}
    finally{videoExportSaving=false;showVideoExportActions();}
  }
  function shareSavedVideo(){
    const entry=videoExportLast;if(!entry||videoExportJob||videoExportSaving)return;
    if(videoNeedsDownload(entry)){$('#videoExportSave').click();return;}
    // Bound the platform share-sheet's full-file memory cost. Large/high-rate
    // exports always use the download path, even if canShare returns true.
    videoExportSaving=true;
    let promise;try{promise=navigator.share({files:[entry.file],title:entry.name});}catch(e){promise=Promise.reject(e);}
    showVideoExportActions();
    Promise.resolve(promise).catch(e=>{if(e.name!=='AbortError')setVideoExportStatus('分享未完成，请使用“下载 MP4”。视频已保留。');}).finally(()=>{videoExportSaving=false;showVideoExportActions();});
  }
  function releaseVideoExportResources(e){
    if(!e)return;
    for(const key of ['canvas','effectCanvas','foregroundFxCanvas','nativeNoiseOverlay']){const c=e[key];if(c)c.width=c.height=1;}
    try{e.audio?.removeAttribute('src');e.audio?.load();}catch{}
    e.musicBuffer=null;e.assetImages?.clear();e.customHitSounds?.clear();e.rpeTextureRasterCache?.clear();
    e.nativeNoiseHudCache=e.pjskExportHudCache=e.exportBackgroundCache=null;
  }

  class PhiEncoderClient {
    constructor(){
      this.id=0;this.pending=new Map();
      this.url=new URL('./workers/video-encoder.js',document.baseURI).href;
      this.worker=new Worker(this.url);
      this.worker.onmessage=({data:m})=>{const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);if(m.error){const error=Error(m.error);error.name=m.errorName||"Error";error.operation=m.operation;error.workerStack=m.errorStack;p.reject(error);}else p.resolve(m.result);};
      this.worker.onerror=e=>this.close(Error(e.message||'编码线程中断。'));
      this.worker.onmessageerror=()=>this.close(Error('编码帧传输失败。'));
    }
    call(type,data={},transfer=[]){
      if(!this.worker)return Promise.reject(new Error('编码已经取消。'));
      return new Promise((resolve,reject)=>{
        const id=++this.id,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('编码器长时间没有响应，已停止导出。'));},300000);
        this.pending.set(id,{resolve,reject,timer});
        try{this.worker.postMessage({id,type,...data},transfer);}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
      });
    }
    close(error=new DOMException('已取消导出','AbortError')){
      this.worker?.terminate();this.worker=null;URL.revokeObjectURL(this.url);
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    }
  }
  function exportMediaSample(buffer,channel,position){
    const data=buffer.getChannelData(Math.min(channel,buffer.numberOfChannels-1)),i=Math.floor(position),u=position-i;
    return (data[i]||0)*(1-u)+(data[Math.min(i+1,data.length-1)]||0)*u;
  }
  class PhiExportAudioMixer {
    constructor(e,start,end){
      this.music=e.musicBuffer;this.rate=this.music.sampleRate;this.cursor=Math.round(start*this.rate);this.end=Math.round(end*this.rate);this.origin=start;
      this.gain=clamp(Number(hitSoundVolume)||0,0,HIT_SOUND_MAX)*HIT_SOUND_OUTPUT_TRIM;
      const offset=Number(e.chart.offset)||0;
      this.hits=e.autoSoundNotes.map(({n})=>{
        const key=n.type===4?'flick':n.type===2?'drag':'click',custom=String(n.hitsound||'').trim(),buffer=e.customHitSounds.get(archivePathKey(custom))||e.customHitSounds.get(basename(custom).toLowerCase())||e.pack?.sounds?.[key];
        return buffer?{frame:Math.round((n.time+offset)*this.rate),buffer}:null;
      }).filter(Boolean).sort((a,b)=>a.frame-b.frame);
      this.active=[];this.feed=0;
      while(this.feed<this.hits.length&&this.hits[this.feed].frame<this.cursor){const hit=this.hits[this.feed++];if(hit.frame+hit.buffer.duration*this.rate>this.cursor)this.active.push(hit);}
    }
    next(until){
      const limit=Math.min(this.end,Math.round(until*this.rate)),count=Math.min(4096,limit-this.cursor);if(count<=0)return null;
      const first=this.cursor,last=first+count,data=new Float32Array(count*2),music=this.music;
      for(let ch=0;ch<2;ch++){const source=music.getChannelData(Math.min(ch,music.numberOfChannels-1));for(let i=0;i<count;i++)data[i*2+ch]=source[first+i]||0;}
      while(this.feed<this.hits.length&&this.hits[this.feed].frame<last)this.active.push(this.hits[this.feed++]);
      for(const hit of this.active){
        const step=hit.buffer.sampleRate/this.rate,lo=Math.max(0,hit.frame-first),hi=Math.min(count,Math.ceil(hit.frame+hit.buffer.length/step-first));
        for(let ch=0;ch<2;ch++)for(let i=lo;i<hi;i++)data[i*2+ch]+=exportMediaSample(hit.buffer,ch,(first+i-hit.frame)*step)*this.gain;
      }
      // The output device clips a final stereo mix at full scale. Apply that
      // same final boundary to the AAC input, without normalizing the song.
      for(let i=0;i<data.length;i++)data[i]=Math.max(-1,Math.min(1,data[i]));
      let n=0;for(const hit of this.active)if(hit.frame+hit.buffer.duration*this.rate>last)this.active[n++]=hit;this.active.length=n;
      this.cursor=last;return {data,frames:count,timestamp:first/this.rate-this.origin,sampleRate:this.rate};
    }
  }
  function exportHudRect(e,el){const r=el.getBoundingClientRect();return {x:r.left-e.inputRect.left,y:r.top-e.inputRect.top,w:r.width,h:r.height};}
  function exportOpacity(el){let alpha=1;for(let item=el;item&&item.id!=='gameView';item=item.parentElement)alpha*=Number(getComputedStyle(item).opacity);return alpha;}
  function exportHudBox(e,el){
    if(!el)return null;const s=getComputedStyle(el),r=exportHudRect(e,el);
    return {r,color:s.backgroundColor,radius:parseFloat(s.borderTopLeftRadius)||0,border:parseFloat(s.borderTopWidth)||0,borderColor:s.borderTopColor,opacity:exportOpacity(el)};
  }
  function paintExportBox(c,box,width=null){
    if(!box)return;const r=box.r,w=width??r.w;c.save();c.globalAlpha=box.opacity;c.fillStyle=box.color;c.beginPath();c.roundRect(r.x,r.y,w,r.h,Math.min(box.radius,r.h/2,w/2));c.fill();
    if(box.border){c.strokeStyle=box.borderColor;c.lineWidth=box.border;c.stroke();}c.restore();
  }
  function exportPseudoText(e,el,pseudo){
    if(!el)return null;const s=getComputedStyle(el,pseudo),value=s.content;
    if(!value||value==='none'||value==='normal')return null;
    const r=exportHudRect(e,el),size=parseFloat(s.fontSize),height=parseFloat(s.lineHeight)||size*1.2,top=parseFloat(s.top),bottom=parseFloat(s.bottom);
    return {value:value.slice(1,-1),x:r.x+(parseFloat(s.left)||0),y:r.y+(Number.isFinite(top)?top:r.h-(Number.isFinite(bottom)?bottom:0)-height),h:height,font:`${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`,color:s.color,spacing:s.letterSpacing==='normal'?'0px':s.letterSpacing};
  }
  function paintPjskExportHud(e,c){
    // Read live CSS geometry once. Text values and life/progress remain dynamic.
    let cache=e.pjskExportHudCache;
    if(!cache){
      const texts=[];for(const selector of ['#scoreText','#gameSongName','#gameDifficulty','#pauseBtn','.pjskLifeHud span','#pjskLifeValue','#comboText','#comboHud .comboLabel']){
        for(const el of gameplayDocument().querySelectorAll(selector)){
          const s=getComputedStyle(el),geometry=gameplayTextGeometry(el,e.canvas.getBoundingClientRect()),box=geometry.rect,r={x:box.left-e.inputRect.left,y:box.top-e.inputRect.top,w:box.width,h:box.height};if(!r.w||!r.h||s.display==='none')continue;
          const combo=el.closest('.comboHud'),align=s.textAlign==='right'?'right':s.textAlign==='center'||combo?'center':'left';
          texts.push({el,r,baseline:geometry.baseline,combo:!!combo,align,font:`${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`,color:s.color,spacing:s.letterSpacing==='normal'?'0px':s.letterSpacing,opacity:el.closest('.comboHud')?1:exportOpacity(el),gradient:el.id==='comboText'});
        }
      }
      const score=gameplayDocument().querySelector('#gameView>.gameTop>.hud'),life=gameplayDocument().querySelector('.pjskLifeHud'),fill=life?.querySelector('i'),bar=$('#progressBar')?.parentElement;
      cache=e.pjskExportHudCache={texts,score:exportHudBox(e,score),pause:exportHudBox(e,$('#pauseBtn')),life:exportHudBox(e,life),fill:exportHudBox(e,fill),bar:bar?exportHudRect(e,bar):null,pseudo:[exportPseudoText(e,score,'::before'),exportPseudoText(e,life,'::before')].filter(Boolean)};
    }
    if(cache.bar){const r=cache.bar;c.fillStyle='#ffffff18';c.fillRect(r.x,r.y,r.w,r.h);c.fillStyle='#fff';c.fillRect(r.x,r.y,r.w*clamp(e.musicCurrentTime()/e.musicDuration(),0,1),r.h);}
    paintExportBox(c,cache.score);paintExportBox(c,cache.life);paintExportBox(c,cache.pause);
    if(cache.fill)paintExportBox(c,cache.fill,cache.fill.r.w*clamp((e.pjskLife??1000)/1000,0,1));
    for(const item of cache.pseudo){
      c.font=item.font;c.textAlign='left';c.textBaseline='alphabetic';c.fillStyle=item.color;if('letterSpacing' in c)c.letterSpacing=item.spacing;
      const m=c.measureText(item.value),a=m.fontBoundingBoxAscent??m.actualBoundingBoxAscent,d=m.fontBoundingBoxDescent??m.actualBoundingBoxDescent;c.fillText(item.value,item.x,item.y+item.h/2+(a-d)/2);
    }
    for(const item of cache.texts){
      if(item.combo&&!e.lastHudVisible)continue;let value=item.el.textContent;if(!value)continue;
      c.save();c.globalAlpha=item.opacity;c.font=item.font;c.textAlign=item.align;c.textBaseline='alphabetic';if('letterSpacing' in c)c.letterSpacing=item.spacing;
      const r=item.r,x=r.x+(item.align==='right'?r.w:item.align==='center'?r.w/2:0),metric=c.measureText(value),ascent=metric.fontBoundingBoxAscent??metric.actualBoundingBoxAscent,descent=metric.fontBoundingBoxDescent??metric.actualBoundingBoxDescent,y=r.y+r.h/2+(ascent-descent)/2;
      c.fillStyle=item.color;
      if(item.gradient){const g=c.createLinearGradient(0,r.y,0,r.y+r.h);g.addColorStop(0,'#ffe3f9');g.addColorStop(.25,'#ffe3f9');g.addColorStop(.65,'#e9dbff');g.addColorStop(1,'#aeefff');c.fillStyle=g;c.strokeStyle='#a784bb';c.lineWidth=1;c.strokeText(value,x,y);}
      if(!item.combo&&item.el.id==='gameSongName'&&metric.width>r.w){while(value.length&&c.measureText(value+'…').width>r.w)value=value.slice(0,-1);value+='…';}
      c.fillText(value,x,item.baseline);c.restore();
    }
    if('letterSpacing' in c)c.letterSpacing='0px';
  }
  function paintExportBackground(e,c){
    let cache=e.exportBackgroundCache;
    if(!cache){
      const el=$('#gameBgImage'),s=getComputedStyle(el),r=exportHudRect(e,el),view=getComputedStyle($('#gameView')),shade=getComputedStyle($('#gameBg'));
      cache=e.exportBackgroundCache={r,visible:s.display!=='none'&&s.visibility!=='hidden',opacity:Number(s.opacity),base:view.backgroundColor,shade:shade.backgroundImage};
    }
    c.save();c.fillStyle=cache.base;c.fillRect(0,0,e.surfaceW,e.surfaceH);
    const image=e.renderBgImage||e.bgImage;
    if(cache.visible&&image){
      const r=cache.r,iw=image.naturalWidth||image.width,ih=image.naturalHeight||image.height,q=Math.max(r.w/iw,r.h/ih);
      c.globalAlpha=cache.opacity;c.drawImage(image,r.x+(r.w-iw*q)/2,r.y+(r.h-ih*q)/2,iw*q,ih*q);c.globalAlpha=1;
    }
    // These colors are read from the existing live CSS gradient, not a second
    // background treatment. Baked artwork already contains the blur and dim.
    if(cache.shade&&cache.shade!=='none'){
      const colors=cache.shade.match(/rgba?\([^)]+\)/g);
      if(colors?.length===2){const g=c.createLinearGradient(0,0,0,e.surfaceH);g.addColorStop(0,colors[0]);g.addColorStop(1,colors[1]);c.fillStyle=g;c.fillRect(0,0,e.surfaceW,e.surfaceH);}
    }
    c.restore();
  }
  class PhiOfflineRenderSession {
    constructor(e,width,height){
      this.e=e;this.step=0;this.time=0;this.width=width;this.height=height;
      this.scale=width/e.surfaceW;this.left=0;this.top=0;
      if(Math.abs(e.surfaceW/e.surfaceH-width/height)>1e-5)throw Error('视频布局比例校验失败。');
      this.canvas=document.createElement('canvas');this.canvas.width=width;this.canvas.height=height;this.ctx=this.canvas.getContext('2d',{alpha:false});
      e._exportMusicTime=0;e._offlineExport=true;e.autoplay=true;e.usedAutoplay=true;e.invincibleMode=false;e.usedInvincible=false;e.musicRate=1;e.musicPlaying=false;
      e.musicCurrentTime=()=>e._exportMusicTime;e.audioTime=()=>e._exportMusicTime;e.playSound=()=>null;
      e.reset();e.nextHudPerf=0;e.nextProgressPerf=0;e.dpr=this.scale;e.renderQuality=1;
      e.canvas.width=Math.max(1,Math.round(e.surfaceW*this.scale));e.canvas.height=Math.max(1,Math.round(e.surfaceH*this.scale));
      e.ctx.imageSmoothingEnabled=true;e.ctx.imageSmoothingQuality='high';e.nativeNoiseHudCache=null;e.pjskExportHudCache=null;
      for(const {n} of e.noteItems)n.autoSoundScheduled=true;
      e.running=true;e.paused=true;e.starting=false;$('#pausePanel').classList.add('hidden');
      $('#gameView').classList.remove('phiStageIntro','phiStageOutro');
      e._offlineRenderActive=true;
      performanceMonitor.setGameActive(false);
    }
    render(musicTime){
      const e=this.e;
      if(musicTime<this.time-1e-8)throw Error('离线渲染时间不能倒退。');
      while(this.step/120<=musicTime+1e-8){
        const at=this.step++/120,t=at-Number(e.chart.offset||0);e._exportMusicTime=at;e.frameNow=1+at*1000;
        e.prepareFrame(t);e.currentVisualTime=t;e.update(t,e.frameNow,t);e.flushHitEffects();
      }
      this.time=musicTime;e._exportMusicTime=musicTime;e.frameNow=1+musicTime*1000;const t=musicTime-Number(e.chart.offset||0);e.currentVisualTime=t;e.prepareFrame(t);e.updateHUD();e.paintProgress(clamp(musicTime/e.musicDuration(),0,1));
      if(e.chart.kind==='rpe'){e.nativeNoiseHudCache=null;e.pjskExportHudCache=null;}
      e.draw(t,e.frameNow);
      if(e.nativeBlockRenderError)throw e.nativeBlockRenderError;
      const c=this.ctx;c.setTransform(1,0,0,1,0,0);c.fillStyle='#000';c.fillRect(0,0,this.width,this.height);
      c.save();c.translate(this.left,this.top);c.beginPath();c.rect(0,0,e.surfaceW*this.scale,e.surfaceH*this.scale);c.clip();
      c.save();c.scale(this.scale,this.scale);paintExportBackground(e,c);c.restore();
      if(e.foregroundFxCanvas&&e.foregroundFxVisible)c.drawImage(e.foregroundFxCanvas,0,0,e.surfaceW*this.scale,e.surfaceH*this.scale);
      c.drawImage(e.canvas,0,0,e.surfaceW*this.scale,e.surfaceH*this.scale);
      if(e.postProcessor?.canvas&&e.postProcessor.canvas.style.display!=='none')c.drawImage(e.postProcessor.canvas,0,0,e.surfaceW*this.scale,e.surfaceH*this.scale);
      c.save();c.scale(this.scale,this.scale);
      if(e.chart.kind==='pjsk')paintPjskExportHud(e,c);else captureNativeNoiseHud(e,c,e.surfaceW,e.surfaceH);
      c.restore();
      if(e.nativeNoiseOverlay)c.drawImage(e.nativeNoiseOverlay,0,0,e.surfaceW*this.scale,e.surfaceH*this.scale);
      c.restore();return this.canvas;
    }
    close(){this.canvas.width=this.canvas.height=1;}
  }
  async function removeVideoExportTemp(path){
    if(!path)return;
    try{const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('phi-video-exports');await root.removeEntry(path);}catch{}
  }
  function setVideoExportStatus(text,progress=null){
    const el=$('#videoExportStatus');if(el)el.textContent=text;
    if(progress!=null){const p=$('#videoExportProgress');if(p){p.value=clamp(progress,0,1);p.hidden=false;}}
  }
  function cancelVideoExport(){if(videoExportJob){videoExportJob.cancelled=true;videoExportJob.client?.close();setVideoExportStatus('正在取消并释放编码资源…');}}
  async function runVideoExport(record,options={}){
    if(videoExportJob||videoExportSaving)throw Error('请等待当前视频操作完成。');
    if(!isSecureContext||typeof VideoFrame!=='function'||!navigator.storage?.getDirectory)throw Error('此浏览器没有提供视频编码和本地文件空间，请通过 HTTPS 或 localhost 在支持 WebCodecs 的浏览器打开。');
    const spec=videoExportSpec(options),{width,height,fps,aspect}=spec;
    const job={cancelled:false,client:null,path:`phi-video-${Date.now()}-${crypto.randomUUID()}.mp4`,session:null,viewport:null,wake:null,phase:'读取原谱'};videoExportJob=job;
    let exportEngine=null,success=false,finished=null;
    const check=()=>{if(job.cancelled)throw new DOMException('已取消导出','AbortError');if(job.failure)throw job.failure;if(job.interrupted)throw Error(job.interrupted);};
    try{
      setVideoExportStatus('正在准备固定比例画面、原谱和编码器…',0);
      record=libraryPayload(record);
      const stored=record?._summary?await resolvePlayableRecord(record):record,builtin=BUILTIN_PACKS.find(item=>item.id===(stored?.builtinEntryId||(!stored?.chartText?stored?.id:null)));
      const full=builtin?await materializeBuiltinPack(builtin):stored;
      if(!full?.chartText)throw Error('没有可导出的谱面。');
      showVideoExportActions();PhiVideoStore.persist();
      // Name the native disk file up front, avoiding a second File wrapper at
      // the end. Never replace/delete a previous successful export.
      job.path=`${safeExportStem(full.name)}_${width}x${height}_${fps}fps_${crypto.randomUUID().slice(0,8)}.mp4`;
      const draft={path:job.path,name:`${safeExportStem(full.name)}_${difficultyInfoFor(full).tier||'CHART'}_${width}x${height}_${fps}fps_AutoPlay.mp4`,created:Date.now(),state:'encoding',width,height,fps,aspect};
      await PhiVideoStore.put(draft);check();
      check();if(engine)await backToLibrary();
      // Use a stable logical CSS height at every output resolution. Pixel
      // density increases detail without changing relative font/Note sizes.
      const logicalHeight=720,logicalWidth=720*width/height;
      job.phase='准备画面和原字体';job.viewport=await PhiExportViewport.create(logicalWidth,logicalHeight);
      check();
      job.phase='加载音乐与原始材质';
      await startChart(full,true,{mode:options.mode||dualMenuMode,lanes:options.lanes||12,offlineExport:true,exportDpr:height/logicalHeight});
      exportEngine=engine;
      if(!exportEngine?.record||!exportEngine.musicBuffer)throw Error('谱面或音乐初始化失败，无法导出。');
      await job.viewport.loadFonts();check();
      const duration=exportEngine.musicBuffer.duration,start=clamp(Number(options.start)||0,0,duration),end=clamp(Number(options.end)||duration,start,duration);
      if(end<=start)throw Error('导出时长无效。');
      const totalFrames=Math.ceil((end-start)*fps-1e-8),audioFrames=Math.round(end*exportEngine.musicBuffer.sampleRate)-Math.round(start*exportEngine.musicBuffer.sampleRate);
      const mixer=new PhiExportAudioMixer(exportEngine,start,end),session=job.session=new PhiOfflineRenderSession(exportEngine,width,height);
      try{await Engine.sharedAudioContext().suspend();}catch{}
      const firstCanvas=session.render(start),codecKey=`phi-fast-codec-v2:${navigator.userAgent}:${width}x${height}:${fps}`;
      let preferredCodec,preferredLatencyMode;try{const saved=JSON.parse(localStorage.getItem(codecKey)||'null');if(saved&&Date.now()-saved.at<7*86400000){preferredCodec=saved.codec;preferredLatencyMode=saved.latencyMode;}}catch{}
      job.phase='初始化视频编码器';const client=job.client=new PhiEncoderClient();
      setVideoExportStatus(preferredCodec?'正在准备本机快速编码器…':'正在测试本机编码速度并选择快速编码器…',0);
      const probeFrame=new VideoFrame(firstCanvas,{timestamp:0,duration:Math.round(1e6/fps),alpha:'discard'});let info;
      try{info=await client.call('init',{frame:probeFrame,options:{width,height,fps,totalFrames,audioFrames,preferredCodec,preferredLatencyMode,sampleRate:exportEngine.musicBuffer.sampleRate,storageName:job.path,title:cleanGameplaySongName(full.name)+' · AutoPlay'}},[probeFrame]);}finally{probeFrame.close();}
      job.path=info.path;try{localStorage.setItem(codecKey,JSON.stringify({at:Date.now(),codec:info.codec,latencyMode:info.latencyMode}));}catch{}
      check();try{job.wake=await navigator.wakeLock?.request('screen');}catch{}
      // A hidden tab may run slower. It must never skip a timestamp or switch
      // to wall-clock capture. Actual page freeze simply pauses this loop.
      const began=performance.now(),audioStride=Math.max(1,Math.round(fps/10)),flight=[];let paintAt=began,yieldAt=began;
      for(let i=0;i<totalFrames;i++){
        check();
        job.phase=`编码第 ${i+1} 帧`;
        const at=start+i/fps,next=Math.min(end,start+(i+1)/fps),canvas=i===0?firstCanvas:session.render(at);
        if(options.onFrame)await options.onFrame(canvas,i,at);
        // Feed contiguous PCM in ~100 ms batches in the same message as video.
        // This changes transport boundaries only, never samples or timestamps.
        const audio=[];
        if(i%audioStride===0||i===totalFrames-1){let chunk;const until=Math.min(end,start+(Math.floor(i/audioStride)+1)*audioStride/fps);while((chunk=mixer.next(until))){check();audio.push({...chunk,data:chunk.data.buffer});}}
        const timestamp=Math.round(i*1e6/fps),frame=new VideoFrame(canvas,{timestamp,duration:Math.round((next-start)*1e6)-timestamp,alpha:'discard'});
        // Overlap the next frame's rendering with the worker's current encode.
        // Keep at most two frames, never queue the song in RAM. Close every
        // transferred snapshot and observe failures immediately.
        flight.push(client.call('video',{frame,index:i,audio,expectedTimestamp:timestamp,expectedDuration:Math.round((next-start)*1e6)-timestamp},[frame,...audio.map(x=>x.data)]).catch(error=>{job.failure||=error;}).finally(()=>frame.close()));
        if(flight.length>=2){await flight.shift();check();}
        const now=performance.now();
        if(now-paintAt>150){const speed=((i+1)/fps)/Math.max(.001,(now-began)/1000);setVideoExportStatus(`正在编码 · ${i+1} / ${totalFrames} 帧 · ${speed.toFixed(2)} 倍速${document.hidden?' · 后台继续':''}`,(i+1)/totalFrames);paintAt=now;}
        if(now-yieldAt>12){await new Promise(r=>setTimeout(r,0));yieldAt=performance.now();}
      }
      await Promise.all(flight);check();
      check();job.phase='封装并校验视频';setVideoExportStatus('正在封装 MP4 并校验完整帧数…',1);
      const result=await client.call('finish');check();
      if(result.frames!==totalFrames||result.packets!==totalFrames||result.audioSamples!==audioFrames)throw Error(`编码校验失败：预期 ${totalFrames} 帧，实际 ${result.packets} 帧。`);
      mixer.music=null;mixer.hits.length=0;mixer.active.length=0;
      success=true;
      job.phase='保存视频文件';const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('phi-video-exports'),handle=await root.getFileHandle(result.path),blob=await handle.getFile();
      if(blob.size<128)throw Error('编码文件为空。');
      // From this point the finalized file must survive even if a metadata or
      // UI operation fails. Recovery can recognize its final MP4 footer.
      const entry={...draft,...result,state:'complete',size:blob.size,verified:true,expectedFrames:totalFrames,seconds:end-start,elapsed:(performance.now()-began)/1000,codec:info.codec,encoderScores:info.encoderScores,audioEncoder:info.audioEncoder,layout:[exportEngine.surfaceW,exportEngine.surfaceH],counts:exportEngine.counts.slice(),total:exportEngine.total};
      try{await PhiVideoStore.put(entry);}catch(e){Diagnostics.warn('VideoExport.catalog',e.message);}
      if(videoExportLast?.url)URL.revokeObjectURL(videoExportLast.url);
      finished=videoExportLast={...entry,file:blob,url:URL.createObjectURL(blob)};
      setVideoExportStatus('视频已保存，正在释放编码与绘图资源…',1);
    }catch(error){
      setVideoExportStatus(job.cancelled||error.name==='AbortError'?'已取消导出。':`导出失败（${job.phase}）：${error.message}${error.name&&error.name!=='Error'?' ['+error.name+']':''}`);throw error;
    }finally{
      job.client?.close();job.session?.close();try{await job.wake?.release();}catch{}
      try{if(exportEngine)await backToLibrary();}finally{job.viewport?.close();}
      releaseVideoExportResources(exportEngine);exportEngine=null;job.client=job.session=job.viewport=null;
      if(!success){await removeVideoExportTemp(job.path);try{const dir=await(await navigator.storage.getDirectory()).getDirectoryHandle('phi-video-exports');await dir.removeEntry(job.path+'.json');}catch{}}
      videoExportJob=null;
      const begin=$('#videoExportStart'),cancel=$('#videoExportCancel');if(begin)begin.disabled=false;if(cancel){cancel.disabled=false;cancel.textContent='关闭';}
      for(const el of document.querySelectorAll('#videoExportDialog select'))el.disabled=false;
      if(finished)setVideoExportStatus(`编码完成并已保存 · ${videoExportDescription(finished)} · ${finished.frames} 帧全部校验通过。可刷新或下次打开本网站后继续下载。${videoNeedsDownload(finished)?' 大视频请先下载到“文件”后分享。':''}`,1);
      showVideoExportActions();await refreshSavedVideos();
    }
    return finished;
  }
  function openVideoExport(record=null){
    if(videoExportJob||videoExportSaving)return;
    if(!record){
      if(engine?.record&&!$('#gameView').classList.contains('hidden')){engine.pause();record=engine.record;}
      else{const item=libraryFocusCard?._groupItems?.[libraryFocusCard?._selectedDifficulty||0];record=item?libraryPayload(item):null;}
    }
    if(!record){openSavedVideoLibrary();return;}
    videoExportSelection={record,mode:engine?.chart?.kind==='pjsk'?'pjsk':dualMenuMode,lanes:engine?.chart?.pjskLaneCount||12};
    ensureVideoExportDialog();$('#videoExportSong').textContent=cleanGameplaySongName(record.name)+' · '+difficultyInfoFor(record).caption;
    $('#videoExportDialog').classList.remove('hidden');$('#videoExportStart').disabled=false;$('#videoExportProgress').hidden=true;
    setVideoExportStatus('从头以 AutoPlay 导出完整游玩画面。');showVideoExportActions();refreshSavedVideos(true);
  }
  function openSavedVideoLibrary(){
    if(videoExportJob||videoExportSaving)return;
    ensureVideoExportDialog();videoExportSelection=null;$('#videoExportSong').textContent='已保存的视频';$('#videoExportStart').disabled=true;
    $('#videoExportDialog').classList.remove('hidden');setVideoExportStatus('选择已保存的视频，可继续下载。');showVideoExportActions();refreshSavedVideos(true);
  }
  function ensureVideoExportDialog(){
    if($('#videoExportDialog'))return;
    const panel=document.createElement('section');panel.id='videoExportDialog';panel.className='hidden';
    panel.innerHTML=`<div class="videoExportBox" role="dialog" aria-modal="true" aria-labelledby="videoExportTitle"><h2 id="videoExportTitle">导出视频</h2><p id="videoExportSong"></p><div class="videoExportOptions"><label>画面比例<select id="videoExportAspect"><option value="4:3" selected>4:3 · 默认</option><option value="9:16">9:16 · 竖屏</option><option value="16:9">16:9 · 横屏</option></select></label><label>分辨率<select id="videoExportResolution"><option value="1080">1080P · 1440×1080</option><option value="1440">1440P · 1920×1440</option><option value="2160">2160P · 2880×2160</option></select></label><label>帧率<select id="videoExportFps"><option value="30">30 fps</option><option value="60" selected>60 fps</option><option value="120">120 fps</option></select></label></div><p class="videoExportHint">MP4 · 自动游玩 · 音乐与打击音。按所选比例完整排版，逐帧编码；速度取决于设备性能。导出会结束当前游玩，完成后回到选歌。</p><progress id="videoExportProgress" max="1" value="0" hidden></progress><p id="videoExportStatus" role="status"></p><div class="videoExportActions"><button id="videoExportCancel" type="button">关闭</button><button id="videoExportStart" type="button">开始编码</button><a id="videoExportSave" hidden>下载 MP4</a><button id="videoExportShare" type="button" hidden>分享／存储</button></div><details id="videoExportSaved" open><summary>已保存的视频</summary><p class="videoExportHint">视频保留在本设备的本网站中，刷新或下次打开仍可下载。大视频先下载到“文件”后再分享。清除网站数据会删除这些视频。</p><div id="videoExportHistory" role="list" aria-label="已保存的视频">正在读取…</div><button id="videoExportRefresh" type="button">刷新列表</button></details></div>`;
    const style=document.createElement('style');style.textContent='#videoExportSaved{margin-top:20px;border-top:1px solid #ffffff30;padding-top:16px}#videoExportSaved summary{cursor:pointer;font-weight:600}.videoSavedRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;border-bottom:1px solid #ffffff20;padding:12px 0}.videoSavedRow span{flex:1 1 220px;overflow-wrap:anywhere;font-size:14px}.videoSavedRow button,#videoExportRefresh{font-size:14px;padding:8px 10px}#videoExportHistory{max-height:32vh;overflow:auto}';panel.append(style);
    document.body.appendChild(panel);
    $('#videoExportAspect').onchange=()=>{for(const option of $('#videoExportResolution').options){const s=videoExportSpec({aspect:$('#videoExportAspect').value,resolution:Number(option.value)});option.textContent=`${option.value}P · ${s.width}×${s.height}`;}};
    $('#videoExportStart').onclick=async()=>{
      if(videoExportJob||videoExportSaving||!videoExportSelection)return;Engine.primeAudioFromGesture();
      const options={mode:videoExportSelection.mode,lanes:videoExportSelection.lanes,aspect:$('#videoExportAspect').value,resolution:Number($('#videoExportResolution').value),fps:Number($('#videoExportFps').value)};
      $('#videoExportStart').disabled=true;$('#videoExportCancel').textContent='取消导出';$('#videoExportSave').hidden=true;$('#videoExportShare').hidden=true;
      for(const el of panel.querySelectorAll('select,.videoSavedRow button'))el.disabled=true;
      try{await runVideoExport(videoExportSelection.record,options);}catch(e){Diagnostics.warn('VideoExport',e?.message||String(e));}
      finally{$('#videoExportCancel').textContent='关闭';}
    };
    $('#videoExportCancel').onclick=()=>{if(videoExportJob)cancelVideoExport();else panel.classList.add('hidden');};
    $('#videoExportSave').onclick=downloadSavedVideo;
    $('#videoExportShare').onclick=shareSavedVideo;
    $('#videoExportRefresh').onclick=()=>refreshSavedVideos(true);
  }
  function installVideoExportUI(){
    const library=$('#libraryFocusExport'),pause=$('#pauseMoreSheet');
    if(library&&!$('#libraryVideoExport')){const b=document.createElement('button');b.id='libraryVideoExport';b.className=library.className;b.textContent='导出视频';b.type='button';b.onclick=()=>openVideoExport();library.after(b);const history=document.createElement('button');history.id='librarySavedVideos';history.type='button';history.className=library.className;history.textContent='已保存视频';history.onclick=openSavedVideoLibrary;b.after(history);}
    if(pause&&!$('#pauseVideoExport')){const b=document.createElement('button');b.id='pauseVideoExport';b.type='button';b.textContent='导出视频';b.onclick=()=>openVideoExport();pause.prepend(b);}
  }
  registerModule('VideoExporter',{open:openVideoExport,run:runVideoExport,cancel:cancelVideoExport,last:()=>videoExportLast,active:()=>!!videoExportJob,saved:PhiVideoStore,openSaved:openSavedVideoLibrary,selectSaved:selectSavedVideo,refreshSaved:refreshSavedVideos,spec:videoExportSpec,Viewport:PhiExportViewport,OfflineSession:PhiOfflineRenderSession,AudioMixer:PhiExportAudioMixer});
  installVideoExportUI();

  registerModule("AppBootstrap", { installNextUI, runSelfTests:runPhiSelfTests });
  registerModule("CapabilityDetector", CapabilityDetector);
  registerModule("ErrorBoundary", { reportRecoverable });
  registerModule("Diagnostics", Diagnostics);
  registerModule("StorageManager", { openDB, dbGetSetting, dbPutSetting, dbGetChart, dbGetChartSummary, dbPutChart, dbDeleteChart, chartSummaryFromRecord, exportLibraryMigrationPackage, importLibraryMigrationPackage, mode:()=>storageMode });
  registerModule("BuiltinCatalog",{entries:BUILTIN_PACKS,materialize:materializeBuiltinPack});
  registerModule("ResourceManager", { loadResourcePack, importResourcePack, loadBuiltinResourcePack });
  registerModule("BackgroundRenderer", { createFrostedBackgroundBlob, imageLumaMetrics, imageFromPersistentURL });
  registerModule("ArchiveScanner", { ZipArchive, unpackFile, safeArchivePath, limits:PHI_SECURITY_LIMITS });
  registerModule("ExportManager", { buildStoredZip, exportPackageEntries, exportInfoYAML });
  registerModule("ChartDetector", { sniffChart });
  registerModule("PjskMode", { convert:convertChartToPjsk, geometry:pjskStageGeometry, metrics:pjskAutoNoteMetrics, travel:pjskTravel, slideLane:pjskSlideLane, judge:pjskGrade, reset:resetPjskState, input:pjskInput, update:updatePjskJudgement });
  registerModule("ChartParser", { parseChart, SUSParser:parseSUS, RPEParser:parseRPE, OfficialParser:parsePGR, PECParser:parsePEC, CompatibilityNormalizer:compatibilityNormalizeChart });
  registerModule("ChartImporter", { buildChartRecord, buildChartRecords, parseCSVRows, parseInfoCSV, parseLineCSV, normalizeMeta, applyRecordChartMetadata });
  registerModule("TimelineCompiler", { BPMMap, eventValueFast, rpeLayerValueFast });
  registerModule("EventIndex", { lowerBoundNumeric });
  registerModule("TransformSystem", { normalizeRpeAbove, normalizeParentGraph, pgrLineHalfToWorld, chartLineLengthToWorld, resolveLineEndpoints });
  registerModule("RenderEngine", { Engine, PhiPostProcessor, noteRenderOrder:[...NOTE_RENDER_ORDER] });
  registerModule("AudioEngine", { sharedAudioContext:()=>Engine.sharedAudioContext(), PhiHitAudioMixer, workletModule:phiHitAudioWorkletModule });
  registerModule("Hyper120", { createStaticFrostedBlobThreaded, speedBands:[...HYPER120_SPEED_BANDS], qualityLevels:[...PERF_QUALITY_LEVELS], performanceSampleEvery:PERF_SAMPLE_EVERY });
  registerModule("InputManager", { KeyboardInputManager });
  registerModule("LandscapeLayout", { viewport:nativeBlockViewport, zones:nativeBlockZones, blocked:nativeBlockTouchBlocked,
    prepareBlocks:prepareNativeBlocks, prepareTextures:prepareNativeBlockTextures, Renderer:NativeBlockRenderer, getMode:()=>phiPlayfieldMode,
    setMode:(value)=>{ phiPlayfieldMode='authored';
      const select=$('#phiPlayfieldMode'); if(select)select.value=phiPlayfieldMode;
      if(engine){engine.reflowLayout();if(engine.paused)engine.draw(engine.time);}
      return phiPlayfieldMode; } });
  registerModule("JudgeEngine", { windows:{perfect:PERFECT,good:GOOD,bad:BAD,dragEarly:DRAG_PREARM_EARLY,dragLate:DRAG_LATE_WINDOW,flickEarly:FLICK_ARM_EARLY,flickLate:FLICK_ARM_LATE}, holdBad:false, dragPerfectOnly:true, flickPerfectOnly:true });
  registerModule("MaterialManager", { importResourcePack, loadResourcePack });
  registerModule("ShaderManager", { PhiPostProcessor });
  registerModule("GameStateManager", { current:()=>engine, startChart, backToLibrary });
  registerModule("UIManager", { toast, showDialog, installNextUI, renderLibrary });
  registerModule("PerformanceManager", performanceMonitor);
  registerModule("BuilderBridge", { versions:PHI_VERSIONS });
  window.PhiOfflineNext=Object.freeze({ versions:PHI_VERSIONS, limits:PHI_SECURITY_LIMITS, modules:PHI_MODULES, runSelfTests:runPhiSelfTests, diagnostics:Diagnostics });
  keyboardInput=new KeyboardInputManager();
  installNextUI();
  installDualUI();
  document.documentElement.style.setProperty("--ref-menu-image",`url("${REFERENCE_THUMBNAILS["LeaveAllBehind.rider"]}")`);
  installReferenceUI();

  const PHI_SELF_TEST_MODE = new URLSearchParams(location.search).get("phiSelfTest") === "1";
  if (PHI_SELF_TEST_MODE) setTimeout(runPhiSelfTests, 0);


  if (!PHI_SELF_TEST_MODE) (async function init() {
    try {
      db = await openDB();
      storageMode = "persistent";
      storageReady = true;
      void requestDurableStorage();
    } catch (e) {
      activateTemporaryStorage(e, false);
    }
    void loadSavedOrAdjacentOfficialFont();
    const [,settingRecords]=await Promise.all([loadScoreCache(),dbGetAllSettings(),keyboardInput.load()]);
    const startupSettings=new Map(settingRecords.map(record=>[record.key,record]));
    for(const [key,record] of startupSettings)sessionStore.settings.set(key,record);
    if (BUILTIN_RESOURCE_PACK) {
      const status = $("#packStatus");
      if (status)
        status.innerHTML = `皮肤：<strong>${BUILTIN_RESOURCE_PACK.name || "内置皮肤"}</strong><small style="margin-left:6px;color:var(--muted)">已内置 · 空闲时预热</small>`;
      bootResourcePackPromise = null;
      const warm = () => {
        if(document.hidden||engine?.running||!$('#loadingView')?.classList.contains('hidden'))return;
        if (activePack || bootResourcePackPromise) return;
        bootResourcePackPromise = loadBuiltinResourcePack().then((loaded) => {
          if (loaded && !activePack) { activePack = loaded; updatePackStatus(); }
          return loaded;
        }).catch((e) => {
          Diagnostics.warn("MaterialManager.embedded.preload", e?.message || String(e), { action:"游玩时重试" });
          bootResourcePackPromise = null;
          return null;
        });
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => (globalThis.requestIdleCallback ? requestIdleCallback(warm,{timeout:1800}) : setTimeout(warm,80)), {once:true});
      else (globalThis.requestIdleCallback ? requestIdleCallback(warm,{timeout:1800}) : setTimeout(warm,80));
    } else bootResourcePackPromise = null;
    try {
      syncChartRevealUI();
      setStorageModeUI();
      // Migrate the previous guessed 4:3 setting; upstream geometry is authoritative.
      PHI_MODULES.LandscapeLayout.setMode('authored');
      const ns = startupSettings.get("noteScale");
      applyNoteScale(ns?.value ?? builtinDefault("noteScale"), false);
      const savedSpeed = startupSettings.get("noteSpeedExactPercent");
      if (!applyExactNoteSpeedPercent(savedSpeed?.value ?? OFFICIAL_SPEED_PERCENT_EXACT, false))
        applyOfficialNoteSpeed();
      const sj = startupSettings.get("specialJudgeDelay");
      applySpecialJudgeDelay(
        sj?.value ?? builtinDefault("specialJudgeDelay"),
        false,
      );
      const jt = startupSettings.get("judgeTimingLead");
      applyJudgeTimingLead(
        jt?.value ?? builtinDefault("judgeTimingLead"),
        false,
      );
      const ts = startupSettings.get("touchSensitivity");
      applyTouchSensitivity(
        ts?.value ?? builtinDefault("touchSensitivity"),
        false,
      );
      const fx = startupSettings.get("hitFxSizeScale");
      applyHitFxSize(fx?.value ?? builtinDefault("hitFxSizeScale"), false);
      const hv = startupSettings.get("hitSoundVolume");
      applyHitSoundVolume(hv?.value ?? builtinDefault("hitSoundVolume"), false);
      const lr = startupSettings.get("lowResolution");
      applyLowResolutionMode(
        lr?.value ?? !!builtinDefault("lowResolution"),
        false,
      );
      const fps = startupSettings.get("showFpsCounter");
      applyFpsCounterEnabled(
        fps?.value ?? !!builtinDefault("showFpsCounter"),
        false,
      );
      const revealScaleSetting = startupSettings.get("chartRevealScale");
      applyChartRevealScale(
        revealScaleSetting?.value ?? CHART_REVEAL_SCALE_DEFAULT,
        false,
      );
      const revealEnabledSetting = startupSettings.get("chartRevealEnabled");
      applyChartRevealEnabled(revealEnabledSetting?.value ?? false, false);
      const auto = startupSettings.get("autoplay");
      setAutoplayEnabled(
        auto?.value ?? !!builtinDefault("autoplay"),
        false,
        false,
      );
      const invincible = startupSettings.get("invincibleMode");
      setInvincibleEnabled(
        invincible?.value ?? !!builtinDefault("invincibleMode"),
        false,
        false,
      );
      const p = startupSettings.get("activePack");
      // Retire the old bundled fkh skin, while retaining user-imported packs.
      if (p && !/fkh|苏八拉稀/i.test(String(p.name)+' '+String(p.author)))
        try {
          activePack = await loadResourcePack(p);
        } catch (e) {
          toast(
            isTemporaryStorage()
              ? "临时材质包读取失败，将尝试内置材质"
              : "已保存的材质包读取失败，将尝试内置材质",
            true,
          );
        }
      if (!activePack && builtinResourcePackCache) activePack = builtinResourcePackCache;
      updatePackStatus();
      refreshAutoplayUI();
      await renderLibrary();
      scheduleLegacyStorageMigration();
      if (isTemporaryStorage()) announceTemporaryStorage();
    } catch (e) {
      Diagnostics.error("AppBootstrap.init", e);
      activePack = null;
      if (BUILTIN_RESOURCE_PACK)
        try {
          activePack = await (bootResourcePackPromise ||
            loadBuiltinResourcePack());
        } catch (error) { Diagnostics.warn("Runtime.recoverable", error?.message || String(error)); }
      updatePackStatus();
      refreshAutoplayUI();
      try { await renderLibrary(); } catch (error) { Diagnostics.error("Library.render", error); }
      scheduleLegacyStorageMigration();
      if (isTemporaryStorage()) announceTemporaryStorage();
      else toast(`本机存储已保留，但初始化部分功能失败：${e.message}`, true, 7000);
    }
  })();
})();


