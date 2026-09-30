const SOURCE = `
struct Params { size: vec2f, time: f32, scroll: f32, velocity: f32, nonsense: f32, hue: f32, pulse: f32 };
@group(0) @binding(0) var<uniform> p: Params;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  return vec4f(positions[i], 0., 1.);
}
fn palette(t: f32) -> vec3f { return .5 + .5 * cos(6.28318 * (vec3f(t) + vec3f(0., .32, .67))); }
@fragment fn fs(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  var uv = (pixel.xy / p.size - .5) * vec2f(p.size.x / p.size.y, 1.);
  let t = p.time * .16 + p.scroll * .45;
  uv.x += sin(uv.y * 9. + t) * p.velocity * .025;
  let center = vec2f(.05 * sin(t), -.06);
  let q = uv - center;
  let radius = length(q);
  let angle = atan2(q.y, q.x);
  let shape = .20 + .03 * sin(angle * (3. + floor(p.nonsense * 4.)) + t);
  let ring = exp(-abs(radius - shape) * 65.);
  let inner = exp(-abs(radius - shape * .7) * 100.);
  let tunnel = pow(.5 + .5 * sin(radius * 65. - t * 3. + angle * 2.), 12.) * .10;
  let swirl = .5 + .5 * sin(angle * 3. + radius * 20. - t);
  var color = vec3f(.035, .025, .075) + palette(p.hue + radius + t * .035) * (.13 * swirl + tunnel);
  color += palette(p.hue + angle * .08) * (ring * .8 + inner * .35) * (0.7 + p.nonsense * .5);
  let grid = abs(fract((uv + vec2f(0., p.scroll * .025)) * 22.) - .5);
  let stars = pow(max(0., 1. - length(grid) * 7.), 5.);
  color += vec3f(.48, .72, .74) * stars * .28;
  color += palette(p.hue + .2) * p.pulse * exp(-radius * 5.) * .25;
  color *= .7 + .3 * (1. - smoothstep(.2, .75, radius));
  return vec4f(color, 1.);
}`;

export class DoomShader {
  constructor(canvas) {
    this.canvas = canvas; this.alive = true; this.active = true; this.visible = true;
    this.values = { scroll:0, velocity:0, nonsense:.5, hue:.5, pulse:0 };
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.onMotion = () => { cancelAnimationFrame(this.frame); this.frame = 0; this.requestFrame(); };
    this.onVisibility = () => { if (document.hidden) { cancelAnimationFrame(this.frame); this.frame = 0; } else this.requestFrame(); };
    this.motion.addEventListener('change', this.onMotion);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize = new ResizeObserver(() => this.requestFrame()); this.resize.observe(canvas);
    this.visibility = new IntersectionObserver(([entry]) => { this.visible = entry.isIntersecting; if (!this.visible) { cancelAnimationFrame(this.frame); this.frame = 0; } else this.requestFrame(); });
    this.visibility.observe(canvas);
    canvas.dataset.renderer = 'starting';
    this.ready = this.prepare();
  }
  async prepare() {
    try {
      if (!navigator.gpu) throw new Error('WebGPU unavailable');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference:'low-power' });
      if (!this.alive) return;
      if (!adapter) throw new Error('No GPU adapter');
      const device = await adapter.requestDevice();
      if (!this.alive) { device.destroy(); return; }
      this.device = device;
      device.lost.then(info => { if (this.alive) this.fallback(info.message || 'Device lost'); });
      device.addEventListener('uncapturederror', event => { event.preventDefault(); this.fallback(event.error.message); });
      this.context = this.canvas.getContext('webgpu');
      if (!this.context) throw new Error('No WebGPU canvas');
      const format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({ device, format, alphaMode:'opaque' });
      const module = device.createShaderModule({ code:SOURCE });
      this.pipeline = await device.createRenderPipelineAsync({ layout:'auto', vertex:{ module, entryPoint:'vs' }, fragment:{ module, entryPoint:'fs', targets:[{format}] }, primitive:{ topology:'triangle-list' } });
      if (!this.alive || this.failed) return;
      this.buffer = device.createBuffer({ size:32, usage:GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.bind = device.createBindGroup({ layout:this.pipeline.getBindGroupLayout(0), entries:[{ binding:0, resource:{buffer:this.buffer} }] });
      this.canvas.dataset.renderer = 'webgpu'; this.requestFrame();
    } catch (error) { if (this.alive) this.fallback(error.message); }
  }
  fallback(reason) {
    if (this.failed) return;
    this.failed = true; cancelAnimationFrame(this.frame); this.frame = 0;
    this.canvas.dataset.renderer = 'css'; this.canvas.dataset.reason = reason;
    this.context?.unconfigure(); this.buffer?.destroy(); this.device?.destroy();
  }
  update(values) { Object.assign(this.values,values); this.requestFrame(); }
  setActive(active) { this.active = active; if (!active) { cancelAnimationFrame(this.frame); this.frame = 0; } else this.requestFrame(); }
  requestFrame() { if (!this.frame && this.alive && !this.failed && this.bind && this.active && this.visible && !document.hidden) this.frame = requestAnimationFrame(now=>this.draw(now)); }
  draw(now) {
    this.frame = 0;
    if (!this.alive || this.failed || !this.active || !this.visible || document.hidden) return;
    if (!this.lastDraw || now - this.lastDraw >= 32 || this.motion.matches) {
      try {
        const rect = this.canvas.getBoundingClientRect();
        const ratio = Math.min(devicePixelRatio || 1, 1.5);
        const width = Math.max(1,Math.min(900,Math.round(rect.width*ratio))), height = Math.max(1,Math.min(1100,Math.round(rect.height*ratio)));
        if (this.canvas.width !== width) this.canvas.width = width;
        if (this.canvas.height !== height) this.canvas.height = height;
        const v = this.values;
        this.device.queue.writeBuffer(this.buffer,0,new Float32Array([width,height,this.motion.matches ? 0 : now/1000,v.scroll,this.motion.matches ? 0 : v.velocity,v.nonsense,v.hue,this.motion.matches ? 0 : v.pulse]));
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments:[{ view:this.context.getCurrentTexture().createView(), clearValue:{r:0,g:0,b:0,a:1}, loadOp:'clear',storeOp:'store' }] });
        pass.setPipeline(this.pipeline); pass.setBindGroup(0,this.bind); pass.draw(3); pass.end(); this.device.queue.submit([encoder.finish()]);
        this.canvas.dataset.frames = String((Number(this.canvas.dataset.frames)||0)+1);
        v.velocity *= .88; v.pulse *= .9; this.lastDraw = now;
      } catch (error) { this.fallback(error.message); return; }
    }
    if (!this.motion.matches) this.requestFrame();
  }
  destroy() {
    this.alive = false; cancelAnimationFrame(this.frame); this.frame = 0;
    this.resize.disconnect(); this.visibility.disconnect(); this.motion.removeEventListener('change',this.onMotion); document.removeEventListener('visibilitychange',this.onVisibility);
    this.context?.unconfigure(); this.buffer?.destroy(); this.device?.destroy();
  }
}
