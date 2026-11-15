/*
 * Anime4K for Jellyfin. Paste into the JavaScript Injector plugin. MIT license, see README.
 * No ?. / ||= / import() on purpose: the injector's editor chokes on them.
 */
(function () {
  if (window.__a4k) return;
  window.__a4k = true;

  var LIB = 'https://esm.sh/anime4k-webgpu@1.0.0';
  var MODES = [
    ['ModeA', 'Mode A', 'Cleans up blur and compression, then upscales. Meant for 1080p anime. Good default.'],
    ['ModeB', 'Mode B', 'Softer cleanup, then upscales. Better for ringing and aliasing from downscaling. Meant for 720p.'],
    ['ModeC', 'Mode C', 'Denoise and upscale, no cleanup pass. For 480p or clean sources. Can make ringing worse.'],
    ['ModeAA', 'Mode A+A', 'Mode A with a second cleanup pass. Slower, can oversharpen 1080p.'],
    ['ModeBB', 'Mode B+B', 'Mode B with a second cleanup pass. Slower.'],
    ['ModeCA', 'Mode C+A', 'Mode C plus a cleanup pass. Looks slightly better than C, slower.'],
    ['CNNx2M', 'CNN x2 M', 'Plain 2x upscale, no cleanup. Lightest, try this on a weak GPU.'],
    ['CNNx2VL', 'CNN x2 VL', 'Plain 2x upscale, bigger model. More detail, heavier.'],
    ['CNNx2UL', 'CNN x2 UL', 'Plain 2x upscale, biggest model. Most detail, heaviest.'],
  ];
  function modeDesc(id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i][0] === id) return MODES[i][2];
    return '';
  }
  var HEIGHTS = ['720', '1080', '1440', '2160'];
  var DEFAULT_MODE = 'ModeA';

  function load(k, d) { var v = localStorage.getItem(k); return v === null ? d : v; }
  function enabled() { return load('a4k-enabled', '1') !== '0'; }
  function screenH() { return Math.round(screen.height * (window.devicePixelRatio || 1)); }
  function mode() {
    var m = load('a4k-mode', DEFAULT_MODE);
    for (var i = 0; i < MODES.length; i++) if (MODES[i][0] === m) return m;
    return DEFAULT_MODE;
  }
  function maxH() {
    var v = load('a4k-maxh', 'auto');
    return v === 'auto' ? screenH() : (parseInt(v, 10) || screenH());
  }

  var status = 'idle';
  var active = null;

  var libP = null;
  function lib() {
    if (libP) return libP;
    libP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.type = 'module';
      s.textContent = "import * as m from '" + LIB + "'; window.__a4kLib = m; window.dispatchEvent(new Event('a4k-lib'));";
      window.addEventListener('a4k-lib', function () { resolve(window.__a4kLib); }, { once: true });
      s.onerror = function () { libP = null; reject(new Error('lib import failed')); };
      document.head.appendChild(s);
    });
    return libP;
  }

  var devP = null;
  function gpu() {
    if (!navigator.gpu) return Promise.reject(new Error('no WebGPU in this browser'));
    if (!devP) {
      devP = navigator.gpu.requestAdapter().then(function (a) {
        if (!a) throw new Error('no GPU adapter');
        return a.requestDevice();
      });
      devP.catch(function () { devP = null; });
    }
    return devP;
  }

  var WGSL = [
    'struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };',
    '@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {',
    '  var p = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));',
    '  var o: VO;',
    '  o.pos = vec4f(p[i], 0, 1);',
    '  o.uv = vec2f((p[i].x + 1) / 2, (1 - p[i].y) / 2);',
    '  return o;',
    '}',
    '@group(0) @binding(0) var s: sampler;',
    '@group(0) @binding(1) var t: texture_2d<f32>;',
    '@fragment fn fs(v: VO) -> @location(0) vec4f {',
    '  return textureSampleLevel(t, s, v.uv, 0.0);',
    '}',
  ].join('\n');

  async function attach(video) {
    var MODEL = mode(), MAXH = maxH();
    var isPreset = MODEL.indexOf('Mode') === 0;
    status = 'starting ' + MODEL + '...';
    var m = await lib();
    var L = m[MODEL] ? m : (m.default || m);
    var Upscaler = L[MODEL];
    if (typeof Upscaler !== 'function') throw new Error(MODEL + ' not found in library exports');
    var device = await gpu();

    var canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:-1;';
    var parent = video.parentElement;
    var prevIsolation = parent.style.isolation;
    parent.style.isolation = 'isolate';
    parent.insertBefore(canvas, video);
    var ctx = canvas.getContext('webgpu');
    var format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device: device, format: format, alphaMode: 'opaque' });
    video.style.opacity = '0';

    // Firefox won't take a <video> in copyExternalImageToTexture, so frames go through a 2D canvas
    var scratch = document.createElement('canvas');
    var sctx = scratch.getContext('2d');

    var mod = device.createShaderModule({ code: WGSL });
    var render = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: format }] },
    });
    var sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    var inTex = null, pipe = null, bind = null, vw = 0, vh = 0, stopped = false;

    function rebuild() {
      vw = video.videoWidth; vh = video.videoHeight;
      scratch.width = vw; scratch.height = vh;
      if (inTex) inTex.destroy();
      inTex = device.createTexture({
        size: [vw, vh], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
               GPUTextureUsage.RENDER_ATTACHMENT,
      });
      var th = Math.min(MAXH, vh * 2), tw = Math.round(vw * th / vh);
      pipe = isPreset
        ? new Upscaler({ device: device, inputTexture: inTex,
            nativeDimensions: { width: vw, height: vh },
            targetDimensions: { width: tw, height: th } })
        : new Upscaler({ device: device, inputTexture: inTex });
      var out = pipe.getOutputTexture();
      canvas.height = Math.min(MAXH, out.height);
      canvas.width = Math.round(vw * canvas.height / vh);
      bind = device.createBindGroup({
        layout: render.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: out.createView() },
        ],
      });
      status = 'running ' + MODEL + ': ' + vw + 'x' + vh + ' -> ' + canvas.width + 'x' + canvas.height;
      console.log('[a4k] ' + status);
    }

    function schedule(cb) {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(cb);
      else requestAnimationFrame(cb);
    }

    function tick() {
      if (stopped) return;
      try {
        if (video.videoWidth && (video.videoWidth !== vw || video.videoHeight !== vh)) {
          if (video.videoHeight >= MAXH) {
            status = 'skipped: source ' + video.videoHeight + 'p >= max ' + MAXH + 'p';
            stop(false);
            return;
          }
          rebuild();
        }
        if (pipe && video.readyState >= 2) {
          sctx.drawImage(video, 0, 0, vw, vh);
          device.queue.copyExternalImageToTexture({ source: scratch }, { texture: inTex }, [vw, vh]);
          var enc = device.createCommandEncoder();
          pipe.pass(enc);
          var rp = enc.beginRenderPass({
            colorAttachments: [{
              view: ctx.getCurrentTexture().createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear', storeOp: 'store',
            }],
          });
          rp.setPipeline(render);
          rp.setBindGroup(0, bind);
          rp.draw(3);
          rp.end();
          device.queue.submit([enc.finish()]);
        }
      } catch (e) {
        console.error('[a4k] frame failed', e);
        status = 'failed: ' + (e && e.message ? e.message : e);
        stop(true);
        return;
      }
      schedule(tick);
    }

    function stop(failed) {
      stopped = true;
      canvas.remove();
      parent.style.isolation = prevIsolation;
      video.style.opacity = '';
      if (inTex) inTex.destroy();
      video.__a4k = !!failed;
      active = null;
    }

    active = { video: video, stop: stop };
    schedule(tick);
  }

  function findVideo() {
    return document.querySelector('video.htmlvideoplayer') || document.querySelector('video');
  }

  function restart() {
    var v = findVideo();
    if (active) active.stop(false);
    if (v) v.__a4k = false;
    status = 'restarting...';
  }

  var panel = null, statusEl = null;

  function ensureStyle() {
    if (document.getElementById('a4kStyle')) return;
    var st = document.createElement('style');
    st.id = 'a4kStyle';
    var ACC = 'rgb(var(--abyss-accent, 0, 164, 220))';
    st.textContent = [
      '@keyframes a4kIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}',
      '#a4kBtn{position:relative}',
      '#a4kBtn.a4k-on::after{content:"";position:absolute;bottom:4px;left:50%;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:' + ACC + '}',
      '#a4kPanel{position:fixed;right:24px;bottom:110px;z-index:2147483000;pointer-events:auto;cursor:default;box-sizing:border-box;',
      '  width:330px;max-width:calc(100vw - 32px);padding:18px 20px;color:#f5f5f7;font-family:inherit;font-size:14px;line-height:1.45;',
      '  color-scheme:dark;background:rgba(18,18,20,.58);-webkit-backdrop-filter:blur(28px) saturate(1.4);backdrop-filter:blur(28px) saturate(1.4);',
      '  border:1px solid rgba(255,255,255,.09);border-radius:min(var(--abyss-radius,24px),24px);box-shadow:0 12px 40px rgba(0,0,0,.55);',
      '  animation:a4kIn .28s cubic-bezier(.2,.8,.2,1)}',
      '#a4kPanel .a4k-title{font-size:16px;font-weight:600;letter-spacing:.2px;margin-bottom:6px}',
      '#a4kPanel .a4k-row{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:12px 0}',
      '#a4kPanel .a4k-label{color:rgba(245,245,247,.72);font-size:13px}',
      '#a4kPanel .a4k-note{margin:-4px 0 0;padding:10px 14px;border-radius:16px;background:rgba(255,255,255,.05);color:rgba(245,245,247,.72);font-size:12.5px}',
      '#a4kPanel .a4k-hint{margin:8px 2px 0;color:rgba(245,245,247,.5);font-size:12px}',
      '#a4kPanel .a4k-status{margin-top:14px;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.06);color:rgba(245,245,247,.7);font-size:12px;word-break:break-word}',
      '#a4kPanel .a4k-select{appearance:none;-webkit-appearance:none;font:inherit;font-size:13px;color:#f5f5f7;cursor:pointer;max-width:190px;',
      '  padding:7px 32px 7px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.1);outline:none;',
      '  background:rgba(255,255,255,.08) url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23f5f5f7%22 stroke-width=%222.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M6 9l6 6 6-6%22/%3E%3C/svg%3E") no-repeat right 12px center;',
      '  transition:background-color .2s cubic-bezier(.2,.8,.2,1),border-color .2s}',
      '#a4kPanel .a4k-select:hover{background-color:rgba(255,255,255,.14)}',
      '#a4kPanel .a4k-select:focus-visible{border-color:' + ACC + '}',
      '#a4kPanel .a4k-select option{background:#1c1c1e;color:#f5f5f7}',
      '#a4kPanel .a4k-switch{position:relative;width:44px;height:26px;padding:0;border-radius:999px;border:1px solid rgba(255,255,255,.12);',
      '  background:rgba(255,255,255,.1);cursor:pointer;transition:background .25s cubic-bezier(.2,.8,.2,1)}',
      '#a4kPanel .a4k-switch span{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#f5f5f7;',
      '  transition:transform .25s cubic-bezier(.2,.8,.2,1),background .25s}',
      '#a4kPanel .a4k-switch[aria-checked=true]{background:' + ACC + '}',
      '#a4kPanel .a4k-switch[aria-checked=true] span{transform:translateX(18px);background:#16161a}',
      '#a4kPanel .a4k-switch:focus-visible{outline:2px solid ' + ACC + ';outline-offset:2px}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function closePanel() { if (panel) { panel.remove(); panel = null; statusEl = null; } }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function row(label, control) {
    var d = el('div', 'a4k-row');
    d.appendChild(el('span', 'a4k-label', label));
    d.appendChild(control);
    return d;
  }

  function select(options, current, onChange) {
    var s = el('select', 'a4k-select');
    options.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0]; op.textContent = o[1];
      if (o[0] === current) op.selected = true;
      s.appendChild(op);
    });
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  function toggle(on, onChange) {
    var b = el('button', 'a4k-switch');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.appendChild(document.createElement('span'));
    b.addEventListener('click', function () {
      var v = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', v ? 'true' : 'false');
      onChange(v);
    });
    return b;
  }

  function openPanel() {
    ensureStyle();
    // on body, not inside the player: the controls layer would sit on top of it
    panel = el('div');
    panel.id = 'a4kPanel';
    ['click', 'dblclick', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'pointerdown', 'keydown', 'keyup', 'wheel']
      .forEach(function (t) { panel.addEventListener(t, function (e) { e.stopPropagation(); }); });

    panel.appendChild(el('div', 'a4k-title', 'Anime4K'));

    panel.appendChild(row('Enabled', toggle(enabled(), function (v) {
      localStorage.setItem('a4k-enabled', v ? '1' : '0');
    })));

    var note = el('div', 'a4k-note', modeDesc(mode()));
    panel.appendChild(row('Mode', select(MODES, mode(), function (val) {
      localStorage.setItem('a4k-mode', val);
      note.textContent = modeDesc(val);
      restart();
    })));
    panel.appendChild(note);
    panel.appendChild(el('div', 'a4k-hint', 'Pick whatever looks best.'));

    var hopts = [['auto', 'Auto (' + screenH() + 'p)']];
    HEIGHTS.forEach(function (h) { hopts.push([h, h + 'p']); });
    panel.appendChild(row('Max height', select(hopts, load('a4k-maxh', 'auto'), function (val) {
      localStorage.setItem('a4k-maxh', val); restart();
    })));
    panel.appendChild(el('div', 'a4k-hint', 'Sources at or above this are left alone.'));

    statusEl = el('div', 'a4k-status', status);
    panel.appendChild(statusEl);

    document.body.appendChild(panel);
  }

  function ensureUI() {
    var sub = document.querySelector('.btnSubtitles');
    var btn = document.getElementById('a4kBtn');
    if (!sub || !sub.parentElement || !findVideo()) { closePanel(); return; }
    if (!btn) {
      btn = sub.cloneNode(false);
      btn.className = sub.className.replace(/\bbtnSubtitles\b/g, 'a4kBtn').replace(/\bhide\b/g, '');
      btn.id = 'a4kBtn';
      btn.removeAttribute('hidden');
      btn.style.display = '';
      btn.title = 'Anime4K';
      btn.setAttribute('aria-label', 'Anime4K');
      var icon = document.createElement('span');
      icon.className = 'material-icons';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" style="display:block">' +
        '<path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"/></svg>';
      btn.appendChild(icon);
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (panel) closePanel(); else openPanel();
      });
      sub.parentElement.insertBefore(btn, sub);
    }
    ensureStyle();
    if (btn.classList) btn.classList.toggle('a4k-on', !!active);
    if (statusEl) statusEl.textContent = status;
  }

  document.addEventListener('click', function (e) {
    if (!panel) return;
    var b = document.getElementById('a4kBtn');
    if (panel.contains(e.target) || (b && b.contains(e.target))) return;
    closePanel();
  });

  setInterval(function () {
    var v = findVideo();
    if (active && (!active.video.isConnected || !enabled())) active.stop(false);
    if (!enabled()) status = 'off';
    else if (!active && v && v.videoWidth > 0) {
      if (v.videoHeight >= maxH()) {
        status = 'skipped: source ' + v.videoHeight + 'p >= max ' + maxH() + 'p';
      } else if (v.parentElement && !v.__a4k) {
        v.__a4k = true;
        attach(v).catch(function (e) {
          console.error('[a4k] failed, leaving video alone', e);
          status = 'failed: ' + (e && e.message ? e.message : e);
          v.style.opacity = '';
          var c = v.parentElement && v.parentElement.querySelector('canvas[style*="object-fit"]');
          if (c) c.remove();
        });
      }
    }
    ensureUI();
  }, 700);

  addEventListener('keydown', function (e) {
    if (e.shiftKey && e.key.toLowerCase() === 'u' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {
      localStorage.setItem('a4k-enabled', enabled() ? '0' : '1');
      console.log('[a4k]', enabled() ? 'on' : 'off');
    }
  });
})();
