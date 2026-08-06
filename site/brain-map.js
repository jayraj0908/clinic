/* COPIED from public/js/brain-map.js by scripts/build-site-data.mjs.
   Do not edit here. Edit the original and rebuild, so the dashboard
   and the public site never drift apart. */
/* Sailz brain-map — the radial "sunburst ring" constellation renderer.
 *
 * Extracted from public/index.html (the original dashboard-only inline
 * implementation) so the exact same rendering, camera tweens, ring/strip
 * morph, semantic zoom, and click-to-focus behaviour can be reused by the
 * public site's showcase map (site/index.html) without duplicating the
 * engine. This file owns rendering and interaction mechanics ONLY — no
 * product logic (no sidebar content, no "is this agent connected" status
 * strings, no dashboard chrome DOM ids). Callers pass already-computed
 * node state in and get told about clicks/hover/focus changes via plain
 * callbacks; everything after that (what a sidebar says, what a detail
 * panel shows) is the caller's job.
 *
 * Classic script (not an ES module) — assigns `window.createBrainMap` —
 * matching this repo's existing plain-<script> convention and so the
 * static-only public/site/ deploy can load it with a plain <script src>
 * and zero build step.
 *
 * ------------------------------- Data shape --------------------------------
 * createBrainMap(mountEl, { nodes, edges, options }) -> controller
 *
 * nodes: array of two kinds, discriminated by `kind`:
 *   Hub   { id, kind:'hub', label, sub, glyph, color (0xRRGGBB int),
 *           state: 'active'|'dormant'|'empty' }
 *     - 'active'  fully lit — a real agent is live in this hub
 *     - 'dormant' a not-yet-activated agent could go here (dim ring + '+')
 *     - 'empty'   purely decorative, nothing possible here
 *   Leaf  { id, kind:'leaf', hubId, label, branchFrac (0..1 position among
 *           this hub's branches), forkOffset (radians, 0 for a branch
 *           root, ±small for its forks), dist (radial distance from hub,
 *           e.g. 110 for a root / 185 for a fork — caller's call),
 *           state: 'live'|'paused'|'placeholder', disconnected?:boolean }
 *     - 'live'        real, running agent workflow
 *     - 'paused'      real agent exists but isn't currently running
 *     - 'placeholder' decorative / not built yet
 *     - disconnected: true dims it further (a real workflow whose tool
 *       integration isn't connected) — meaningless when state is placeholder
 *
 * Hub order in the `nodes` array (filtered to kind:'hub') is the ring
 * order — index 0 at -90°, clockwise from there, same as the original.
 *
 * edges: array of { from, to } id pairs (hub-to-leaf or leaf-to-leaf) —
 * resolved once at build time to the live node containers, then redrawn
 * every frame following their current (possibly mid-morph) positions,
 * exactly like the original's object-reference edges.
 *
 * options:
 *   theme: 'dark'|'light' (default 'dark')
 *   resizeTo: an element (or window) the PIXI canvas auto-sizes to —
 *     defaults to `window` (the dashboard's original fullscreen behaviour);
 *     the site's showcase mode passes its own bounded container instead.
 *   onHubClick(hubId)
 *   onNodeClick(hubId, leafId)
 *   onHover({kind, id, label, sub, x, y} | null) — x/y are page-space
 *     coordinates (already includes the canvas's own offset), so the
 *     caller can position its own DOM tooltip directly.
 *   onFocusChange(hubId | null) — fires on focusHub/back/next/prev
 *
 * controller:
 *   focusHub(hubId)         — zoom into a hub (ring -> tree morph)
 *   focusNode(hubId, leafId)— zoom into a hub AND frame one of its leaves
 *   next() / prev()         — step to the adjacent hub while focused
 *   back()                  — collapse focus back to the ring overview
 *   setHalo(hubId, leafId|null) — highlight ring around one leaf (or clear)
 *   setTheme(theme)
 *   rebuildHub(hubNode, leafNodes, edgesForThisHub) — tears down and
 *     rebuilds ONE hub's leaves in place (e.g. after the caller activates
 *     an agent and has fresh state) without touching any other hub, the
 *     camera, or scroll position — mirrors the original's rebuildDept()
 *   destroy()
 * ---------------------------------------------------------------------------
 */
(function () {
  function createBrainMap(mountEl, { nodes = [], edges = [], options = {} } = {}) {
    const opts = Object.assign(
      {
        theme: "dark",
        resizeTo: window,
        onHubClick: () => {},
        onNodeClick: () => {},
        onHover: () => {},
        onFocusChange: () => {},
      },
      options
    );

    /* ------------------------------ tiny math utils ------------------------------ */
    const lerp = (a, b, t) => a + (b - a) * t;
    function lerpAngle(a, b, t) {
      let d = b - a;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      return a + d * t;
    }
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
    function easeOutBack(t) { const s = 1.70158; t = t - 1; return t * t * ((s + 1) * t + s) + 1; }
    function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    function blendGray(colorInt, factor) {
      const r = (colorInt >> 16) & 255, g = (colorInt >> 8) & 255, b = colorInt & 255;
      const gray = (r + g + b) / 3;
      const nr = Math.round(r + (gray - r) * factor), ng = Math.round(g + (gray - g) * factor), nb = Math.round(b + (gray - b) * factor);
      return (nr << 16) | (ng << 8) | nb;
    }
    function truncateLabel(s, maxLen) {
      return s.length > maxLen ? s.slice(0, maxLen - 1).trimEnd() + "…" : s;
    }

    const ICONS = ["✉", "☎", "▤", "✎", "⌗", "⚙", "☰", "✦", "◍", "⌘", "♲", "◔", "✚", "⚖", "☷", "⚑"];
    const CORE = { x: 0, y: 0 };
    const RING_R = 230;

    /* ------------------------------ pixi setup ------------------------------ */
    const app = new PIXI.Application({
      resizeTo: opts.resizeTo, antialias: true, background: "#0a0a0d",
      resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true,
    });
    mountEl.appendChild(app.view);
    app.stage.eventMode = "static";
    const world = new PIXI.Container();
    world.eventMode = "static";
    app.stage.addChild(world);
    const layerStars = new PIXI.Container();
    const layerPie = new PIXI.Container();
    const layerGhost = new PIXI.Container();
    const layerCore = new PIXI.Container();
    const layerFlash = new PIXI.Sprite();
    const layerEdges = new PIXI.Graphics();
    const layerNodes = new PIXI.Container();
    layerNodes.eventMode = "static";
    const layerLabels = new PIXI.Container();
    const layerDeptTx = new PIXI.Container();
    world.addChild(layerStars, layerPie, layerGhost, layerCore, layerEdges, layerNodes, layerLabels, layerDeptTx, layerFlash);
    layerStars.eventMode = "none"; layerPie.eventMode = "none"; layerGhost.eventMode = "none"; layerCore.eventMode = "none";
    layerEdges.eventMode = "none"; layerLabels.eventMode = "none"; layerDeptTx.eventMode = "none";
    layerFlash.eventMode = "none";

    function makeGlow(size) {
      const c = document.createElement("canvas"); c.width = c.height = size;
      const g = c.getContext("2d");
      const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.25, "rgba(255,255,255,.55)");
      gr.addColorStop(0.6, "rgba(255,255,255,.12)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(0, 0, size, size);
      return PIXI.Texture.from(c);
    }
    const GLOW = makeGlow(128);
    const pieGlow = new PIXI.Sprite(GLOW);
    pieGlow.anchor.set(0.5); pieGlow.blendMode = PIXI.BLEND_MODES.ADD; pieGlow.alpha = 0;
    layerPie.addChild(pieGlow);
    function makeDot(size) {
      const c = document.createElement("canvas"); c.width = c.height = size;
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.beginPath(); g.arc(size / 2, size / 2, size / 2 - 1, 0, 7); g.fill();
      return PIXI.Texture.from(c);
    }
    const DOT = makeDot(32);
    layerFlash.texture = GLOW; layerFlash.anchor.set(0.5); layerFlash.tint = 0xfff2cf; layerFlash.alpha = 0;
    layerFlash.scale.set(6); layerFlash.position.set(CORE.x, CORE.y);

    /* ------------------------------ deterministic starfield ------------------ */
    function mulberry32(a) {
      return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const srnd = mulberry32(42);
    const SR = (a, b) => a + srnd() * (b - a);
    for (let i = 0; i < 130; i++) {
      const s = new PIXI.Sprite(DOT); s.anchor.set(0.5);
      s.x = SR(-1600, 1600); s.y = SR(-1200, 1200);
      s.scale.set(SR(0.02, 0.05)); s.alpha = SR(0.05, 0.25); s.tint = 0xe8e6e0;
      layerStars.addChild(s);
    }

    /* --------------------------- core particle cluster ------------------------ */
    const coreHaze = new PIXI.Sprite(GLOW); coreHaze.anchor.set(0.5); coreHaze.tint = 0xa8384a;
    coreHaze.scale.set(2.4); coreHaze.alpha = 0.28; coreHaze.position.set(CORE.x, CORE.y);
    layerCore.addChild(coreHaze);
    const CORE_PALETTE = [0xf0e6c8, 0xd9c78f, 0xfff8e8, 0xe8d9a8, 0xe0904a];
    const coreDust = [];
    for (let i = 0; i < 220; i++) {
      const a = SR(0, 6.283), r = Math.pow(srnd(), 0.6) * 30;
      const p = new PIXI.Sprite(DOT); p.anchor.set(0.5);
      p.scale.set(SR(0.015, 0.045));
      p.tint = CORE_PALETTE[Math.floor(SR(0, CORE_PALETTE.length))];
      p.alpha = SR(0.3, 0.9);
      p.x = CORE.x + Math.cos(a) * r; p.y = CORE.y + Math.sin(a) * r * 0.85;
      p._base = { x: p.x, y: p.y, alpha: p.alpha };
      coreDust.push(p); layerCore.addChild(p);
    }

    /* ------------------------------ theme ------------------------------------ */
    const PAL = {
      dark: { bg: 0x0a0a0d, ink: 0xfaf6ea, dim: 0xc4beac, ghost: 0xe8e6e0, leafDim: 0xe4ddc8,
        hubFill: 0x0c0c0e, coreDot: 0xfdf9ee, shadowDot: 0xa8a398, iconDiscFill: 0x0b0b0d,
        chipFill: 0x08080a, chipAlpha: 0.72, starAlpha: 1 },
      light: { bg: 0xffffff, ink: 0x18150f, dim: 0x4a4638, ghost: 0x141210, leafDim: 0x3a362a,
        hubFill: 0xf3f1ea, coreDot: 0x18150f, shadowDot: 0x4a463c, iconDiscFill: 0xf3f1ea,
        chipFill: 0xf3f1ea, chipAlpha: 0.72, starAlpha: 0.22 },
    };
    let theme = opts.theme === "light" ? "light" : "dark";
    app.renderer.background.color = PAL[theme].bg;
    layerStars.alpha = PAL[theme].starAlpha;
    function redrawChip(lb, chip) {
      const p = PAL[theme];
      chip.clear();
      chip.beginFill(p.chipFill, p.chipAlpha).drawRoundedRect(-lb.width / 2 - 6, -3, lb.width + 12, lb.height + 6, 6).endFill();
    }
    function redrawHubFill(gfx) {
      const p = PAL[theme];
      gfx.clear(); gfx.beginFill(p.hubFill, 0.94).drawCircle(0, 0, 15).endFill();
    }
    function redrawIdisc(gfx, deptColor) {
      const p = PAL[theme];
      gfx.clear();
      gfx.beginFill(p.iconDiscFill, 0.94).drawCircle(0, 0, 10).endFill();
      gfx.lineStyle(1, deptColor, 0.6).drawCircle(0, 0, 10);
    }
    function applyTheme() {
      const p = PAL[theme];
      app.renderer.background.color = p.bg;
      layerStars.alpha = p.starAlpha;
      for (const H of hubs) {
        const dimmed = H.def.state !== "active";
        H.nm.style.fill = H.def.state === "active" ? p.ink : (H.def.state === "dormant" ? p.leafDim : p.dim);
        H.sb.style.fill = p.dim;
        H.ghost.style.fill = p.ghost;
        redrawHubFill(H.hFill);
        for (const N of H.leaves) {
          N.core.tint = N.shadowed ? p.shadowDot : p.coreDot;
          redrawIdisc(N.idisc, H.def.color);
          N.lb.style.fill = p.leafDim;
          redrawChip(N.lb, N.lblChip);
        }
      }
    }

    /* ----------------------------- build hubs (ring) --------------------------- */
    const hubDefs = nodes.filter((n) => n.kind === "hub");
    const N_HUB = hubDefs.length;
    const STRIP_GAP = 620;
    const TREE_Y = 0;
    const hubs = [];
    const hubById = {};
    let iconIdx = 0;

    function paintHub(H) {
      const def = H.def;
      const active = def.state === "active";
      const dormant = def.state === "dormant";
      const hubColor = active ? def.color : blendGray(def.color, dormant ? 0.32 : 0.45);
      H.hubGlow.tint = hubColor;
      H.hubGlow.alpha = active ? 0.32 : dormant ? 0.26 : 0.2;
      H.hCore.clear();
      H.hCore.beginFill(hubColor, active ? 0.95 : dormant ? 0.7 : 0.55).drawCircle(0, 0, 7).endFill();
      H.hRing.clear();
      H.hRing.lineStyle(2, hubColor, active ? 1 : dormant ? 0.85 : 0.6).drawCircle(0, 0, 16);
      H.hRing.lineStyle(1.2, hubColor, active ? 0.4 : dormant ? 0.4 : 0.22).drawCircle(0, 0, 22);
      H.hGlyph.text = dormant ? "+" : def.glyph || "";
      H.hGlyph.style.fill = active ? 0xffffff : hubColor;
      H.hGlyph.alpha = active ? 1 : dormant ? 1 : 0.85;
      H.nm.style.fill = active ? PAL[theme].ink : dormant ? PAL[theme].leafDim : PAL[theme].dim;
      H.ghostBase = active ? 0.02 : dormant ? 0.013 : 0.008;
      H.ghost.alpha = H.ghostBase;
    }

    function makeLeafNode(H, leafDef) {
      const isReal = leafDef.state === "live" || leafDef.state === "paused";
      const runningNow = leafDef.state === "live";
      let nodeDim = isReal ? (runningNow ? 1 : 0.6) : 0.32;
      if (leafDef.disconnected) nodeDim = Math.min(nodeDim, 0.38);
      const shadowed = !isReal || !runningNow;
      const nodeColor = shadowed ? blendGray(H.def.color, 0.55) : H.def.color;

      const node = new PIXI.Container();
      const g = new PIXI.Sprite(GLOW); g.anchor.set(0.5); g.tint = nodeColor;
      const rad = 7;
      g.scale.set(rad / 24); g.alpha = (0.5 + 0.12 * (isReal && runningNow ? 1 : 0)) * nodeDim;
      const core = new PIXI.Sprite(DOT); core.anchor.set(0.5);
      core.scale.set(rad / 16); core.tint = shadowed ? PAL[theme].shadowDot : PAL[theme].coreDot; core.alpha = nodeDim;
      const iconC = new PIXI.Container();
      const idisc = new PIXI.Graphics();
      redrawIdisc(idisc, H.def.color);
      const iglyph = new PIXI.Text(ICONS[iconIdx++ % ICONS.length], { fontFamily: "Inter", fontSize: 9, fill: H.def.color });
      iglyph.anchor.set(0.5, 0.54);
      iconC.addChild(idisc, iglyph); iconC.alpha = 0;
      const haloRing = new PIXI.Graphics();
      haloRing.lineStyle(2, 0xffffff, 0.9).drawCircle(0, 0, rad + 6); haloRing.alpha = 0;
      node.addChild(g, core, iconC, haloRing);

      const shortLabel = truncateLabel((leafDef.label || "").toUpperCase(), 22);
      const lb = new PIXI.Text(shortLabel, { fontFamily: "Inter", fontWeight: "600", fontSize: 6.5, fill: PAL[theme].leafDim, letterSpacing: 1.3 });
      lb.anchor.set(0.5, 0);
      const lblChip = new PIXI.Graphics();
      const lblWrap = new PIXI.Container();
      lblWrap.addChild(lblChip, lb);
      lblWrap.alpha = 0;
      layerLabels.addChild(lblWrap);
      requestAnimationFrame(() => redrawChip(lb, lblChip));

      const N = {
        id: leafDef.id, cont: node, glow: g, iconC, haloRing, label: lblWrap, lb, lblChip,
        branchFrac: leafDef.branchFrac || 0, forkOffset: leafDef.forkOffset || 0, dist: leafDef.dist || 110,
        dim: nodeDim, isReal, runningNow, core, idisc, shadowed,
      };

      node.eventMode = "static"; node.cursor = "pointer"; node.hitArea = new PIXI.Circle(0, 0, 20);
      node.on("pointertap", () => {
        if (dragDist >= 6) return;
        selectNode(H.id, N);
      });
      node.on("pointerover", () => {
        setHoverTarget(H.id);
        emitHover({ kind: "leaf", id: N.id, label: leafDef.label, sub: H.def.label }, node);
        lblWrap.alpha = 1;
      });
      node.on("pointerout", () => { setHoverTarget(null); emitHover(null); lblWrap.alpha = 0; });
      layerNodes.addChild(node);

      H.leaves.push(N);
      return node;
    }

    function buildHubLeaves(H) {
      const leafDefs = nodes.filter((n) => n.kind === "leaf" && n.hubId === H.id);
      for (const leafDef of leafDefs) makeLeafNode(H, leafDef);
    }

    // Resolve the `edges` param (id pairs) into live container references —
    // done once per (re)build, then redrawEdges() just reads live .position
    // off those references every frame, exactly like the original's
    // object-reference edges.
    let resolvedEdges = [];
    function resolveEdges() {
      const byId = { ...hubById };
      for (const H of hubs) for (const N of H.leaves) byId[N.id] = N.cont;
      resolvedEdges = edges
        .map((e) => ({ a: byId[e.from], b: byId[e.to], hubId: nodeHubOf(e.to) || nodeHubOf(e.from) }))
        .filter((e) => e.a && e.b);
    }
    function nodeHubOf(id) {
      const n = nodes.find((x) => x.id === id);
      if (!n) return null;
      return n.kind === "hub" ? n.id : n.hubId;
    }

    function rebuildDept(hubId) {
      const H = hubById[hubId];
      if (!H) return;
      H.leaves.forEach((N) => { N.cont.destroy({ children: true }); N.label.destroy({ children: true }); });
      H.leaves = [];
      paintHub(H);
      buildHubLeaves(H);
      resolveEdges();
      edgesDirty = true;
    }

    hubDefs.forEach((def, di) => {
      const ringAngle = -Math.PI / 2 + di * ((2 * Math.PI) / N_HUB);
      const ringX = Math.cos(ringAngle) * RING_R, ringY = Math.sin(ringAngle) * RING_R;
      const stripX = (di - (N_HUB - 1) / 2) * STRIP_GAP;
      const H = { id: def.id, def, di, ringAngle, ringX, ringY, stripX, leaves: [] };

      H.ghost = new PIXI.Text(def.label, { fontFamily: "Cormorant Garamond", fontSize: 74, fontWeight: "500", fill: PAL[theme].ghost, letterSpacing: 16 });
      H.ghost.anchor.set(0.5); H.ghostBase = def.state === "active" ? 0.02 : 0.008; H.ghost.alpha = H.ghostBase;
      layerGhost.addChild(H.ghost);

      const hubColor = def.state === "active" ? def.color : blendGray(def.color, 0.65);
      const hub = new PIXI.Container();
      const hGlow = new PIXI.Sprite(GLOW); hGlow.anchor.set(0.5); hGlow.tint = hubColor;
      hGlow.scale.set(0.62); hGlow.alpha = 0.32;
      const hFill = new PIXI.Graphics(); redrawHubFill(hFill);
      const hCore = new PIXI.Graphics();
      hCore.beginFill(hubColor, def.state === "active" ? 0.95 : 0.35).drawCircle(0, 0, 7).endFill();
      const hRing = new PIXI.Graphics();
      hRing.lineStyle(2, hubColor, def.state === "active" ? 1 : 0.45).drawCircle(0, 0, 16);
      hRing.lineStyle(1.2, hubColor, def.state === "active" ? 0.4 : 0.14).drawCircle(0, 0, 22);
      const hGlyph = new PIXI.Text(def.glyph || "", { fontFamily: "Inter", fontSize: 13, fill: def.state === "active" ? 0xffffff : hubColor });
      hGlyph.anchor.set(0.5, 0.52);
      hub.addChild(hGlow, hFill, hCore, hRing, hGlyph);
      hub.eventMode = "static"; hub.cursor = "pointer"; hub.hitArea = new PIXI.Circle(0, 0, 30);
      hub.on("pointertap", () => { if (dragDist < 6) opts.onHubClick(def.id); });
      hub.on("pointerover", () => { setHoverTarget(def.id); emitHover({ kind: "hub", id: def.id, label: def.label, sub: def.sub }, hub); });
      hub.on("pointerout", () => { setHoverTarget(null); emitHover(null); });
      layerNodes.addChild(hub);
      H.hub = hub; H.hubGlow = hGlow; H.hubPh = di * 1.7; H.hFill = hFill; H.hCore = hCore; H.hRing = hRing; H.hGlyph = hGlyph;
      hubById[def.id] = hub;

      H.nm = new PIXI.Text(def.label, { fontFamily: "Cormorant Garamond", fontWeight: "600", fontSize: 16, fill: def.state === "active" ? PAL[theme].ink : PAL[theme].dim, letterSpacing: 6 });
      H.nm.anchor.set(0.5, 0);
      H.sb = new PIXI.Text((def.sub || "").toUpperCase(), { fontFamily: "Inter", fontWeight: "500", fontSize: 6.5, fill: PAL[theme].dim, letterSpacing: 2.6 });
      H.sb.anchor.set(0.5, 0);
      layerDeptTx.addChild(H.nm, H.sb);

      paintHub(H);
      buildHubLeaves(H);
      hubs.push(H);
    });
    resolveEdges();

    function updatePieGlow() {
      const target = focused != null ? hubIndexOf(focused) : hubIndexOf(hoverHubId);
      if (target < 0 || morph > 0.6) { pieGlow.alpha = 0; return; }
      const H = hubs[target];
      pieGlow.tint = H.def.color;
      pieGlow.position.copyFrom(H.hub.position);
      pieGlow.scale.set(5.2);
      pieGlow.alpha = 0.4 * (1 - morph / 0.6);
    }
    function hubIndexOf(hubId) { return hubId == null ? -1 : hubs.findIndex((h) => h.id === hubId); }

    /* --------------------------- deterministic layout -------------------------- */
    let morph = 0, morphTween = null;
    let edgesDirty = true;
    function startMorph(to, dur) { morphTween = { t: 0, dur, from: morph, to }; }

    function updateLayout() {
      const m = morph;
      for (const H of hubs) {
        const hx = lerp(H.ringX, H.stripX, m), hy = lerp(H.ringY, TREE_Y, m);
        H.hub.position.set(hx, hy);
        const nmScale = 1 + m * 0.5;
        H.nm.scale.set(nmScale);
        H.nm.position.set(hx, hy + 30);
        H.sb.position.set(hx, hy + 30 + 34 * nmScale);
        H.ghost.position.set(hx, hy - 40);
        for (const N of H.leaves) {
          const ringSpread = Math.PI * 0.28;
          const ringFan = H.ringAngle + (N.branchFrac - 0.5) * ringSpread + N.forkOffset;
          const treeFan = lerp(-2.5, -0.64, N.branchFrac) + N.forkOffset;
          const ang = lerpAngle(ringFan, treeFan, m);
          const dist = lerp(N.dist * 0.68, N.dist, m);
          const nx = hx + Math.cos(ang) * dist, ny = hy + Math.sin(ang) * dist;
          N.cont.position.set(nx, ny);
          N.label.position.set(nx, ny + 12);
        }
      }
    }
    function redrawEdges() {
      layerEdges.clear();
      for (const E of resolvedEdges) {
        const H = hubById2(E.hubId);
        const spot = H ? (H._spot === undefined ? 1 : H._spot) : 1;
        const highlightTarget = focused != null ? focused : hoverHubId;
        const isTarget = highlightTarget == null || E.hubId === highlightTarget;
        const col = H && H.def.state === "active" ? H.def.color : blendGray(H ? H.def.color : 0xffffff, 0.5);
        const w = 0.9, alpha = 0.25;
        layerEdges.lineStyle(isTarget ? w + 0.3 : w, col, (isTarget ? alpha + 0.15 : alpha) * spot);
        layerEdges.moveTo(E.a.x, E.a.y); layerEdges.lineTo(E.b.x, E.b.y);
        const mx = (E.a.x + E.b.x) / 2, my = (E.a.y + E.b.y) / 2;
        layerEdges.beginFill(0xc9a066, alpha * 0.8 * spot).drawCircle(mx, my, 1).endFill();
      }
    }
    function hubById2(id) { return hubs.find((h) => h.id === id); }

    /* --------------------------- hover spotlight -------------------------------- */
    let hoverHubId = null;
    function setHoverTarget(id) { hoverHubId = id; edgesDirty = true; }
    function emitHover(payload, displayObj) {
      if (!payload) { opts.onHover(null); return; }
      const p = displayObj.getGlobalPosition();
      const rect = app.view.getBoundingClientRect();
      opts.onHover({ ...payload, x: rect.left + p.x, y: rect.top + p.y });
    }

    /* ------------------------------ camera -------------------------------- */
    let cam = { s: 1, x: 0, y: 0 };
    let tween = null;
    // Camera shifts sideways when the caller has an overlay panel open
    // (controller.setPanelOpen(true)) so the panel never covers the
    // focused content — sbShiftT is the 0/1 target, sbShift eases toward
    // it every frame in the ticker below.
    let sbShift = 0, sbShiftT = 0;
    function applyCam() {
      const w = app.screen.width, h = app.screen.height;
      world.scale.set(cam.s);
      world.position.set(w / 2 - cam.x * cam.s + sbShift, h / 2 - cam.y * cam.s);
    }
    function tweenTo(s, x, y, dur, overshoot) {
      tween = { t: 0, dur: dur || 700, from: { ...cam }, to: { s, x, y }, overshoot: overshoot || 0 };
    }
    function idleScale() {
      const w = app.screen.width, h = app.screen.height;
      return Math.max(0.4, Math.min(1, Math.min(w / 760, h / 600)));
    }
    function fitAll() { tweenTo(idleScale(), 0, 0, 650, 0); }
    function deptFocusScale() {
      const w = app.screen.width, h = app.screen.height;
      return Math.max(1.0, Math.min(1.7, Math.min(w / 1100, h / 1000) * 1.35));
    }
    function focusCamTarget(H) {
      const w = app.screen.width, h = app.screen.height;
      const s = deptFocusScale();
      const hubScreenY = h * 0.78;
      tweenTo(s, H.stripX, (h / 2 - hubScreenY) / s, 900, 0.35);
    }
    function finalTreePos(H, N) {
      const treeFan = lerp(-2.5, -0.64, N.branchFrac) + N.forkOffset;
      return { x: H.stripX + Math.cos(treeFan) * N.dist, y: TREE_Y + Math.sin(treeFan) * N.dist };
    }

    let dragging = false, lx = 0, ly = 0, dragDist = 0;
    app.view.addEventListener("pointerdown", (e) => { dragging = true; dragDist = 0; lx = e.clientX; ly = e.clientY; });
    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      dragDist += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
      lx = e.clientX; ly = e.clientY;
    });
    window.addEventListener("pointerup", () => { dragging = false; });

    app.view.addEventListener("pointermove", (e) => {
      if (focused != null || morph > 0.3) return;
      const rect = app.view.getBoundingClientRect();
      const sx = (e.clientX - rect.left) * (app.screen.width / rect.width);
      const sy = (e.clientY - rect.top) * (app.screen.height / rect.height);
      const p = world.toLocal(new PIXI.Point(sx, sy));
      const dx = p.x - CORE.x, dy = p.y - CORE.y;
      const r = Math.hypot(dx, dy);
      if (r < 44 || r > RING_R + 170) { if (hoverHubId != null) setHoverTarget(null); return; }
      const ang = Math.atan2(dy, dx);
      const step = (2 * Math.PI) / N_HUB;
      let best = -1, bestDiff = Infinity;
      for (let di = 0; di < N_HUB; di++) {
        const a = -Math.PI / 2 + di * step;
        const diff = Math.abs((((ang - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
        if (diff < bestDiff) { bestDiff = diff; best = di; }
      }
      const target = bestDiff <= step / 2 ? hubs[best].id : null;
      if (hoverHubId !== target) setHoverTarget(target);
    });
    app.view.addEventListener("pointerleave", () => { if (focused == null) setHoverTarget(null); });

    /* ---------------------------- focus flow ---------------------------------- */
    let focused = null;
    function focusHub(hubId) {
      const H = hubById2(hubId);
      if (!H) return;
      focused = hubId;
      startMorph(1, 900);
      focusCamTarget(H);
      triggerBloom();
      opts.onFocusChange(focused);
    }
    function next() { step(1); }
    function prev() { step(-1); }
    function step(dir) {
      if (focused == null) return;
      const i = hubIndexOf(focused);
      const nextI = ((i + dir) % hubs.length + hubs.length) % hubs.length;
      focused = hubs[nextI].id;
      const H = hubs[nextI];
      const w = app.screen.width, h = app.screen.height;
      const s = deptFocusScale();
      const hubScreenY = h * 0.78;
      tweenTo(s, H.stripX, (h / 2 - hubScreenY) / s, 550, 0);
      opts.onFocusChange(focused);
    }
    function focusNode(hubId, leafId) {
      const H = hubById2(hubId);
      if (!H) return;
      const N = H.leaves.find((n) => n.id === leafId);
      const wasFocused = focused === hubId;
      if (!wasFocused) { focused = hubId; startMorph(1, 900); triggerBloom(); opts.onFocusChange(focused); }
      const w = app.screen.width, h = app.screen.height;
      const p = N ? finalTreePos(H, N) : { x: H.stripX, y: TREE_Y };
      const s = Math.max(1.7, Math.min(2.6, Math.min(w / 750, h / 700) * 1.7));
      const nodeScreenY = h * 0.55;
      tweenTo(s, p.x, (h / 2 - nodeScreenY) / s, wasFocused ? 280 : 900, wasFocused ? 0 : 0.3);
    }
    function back() {
      if (focused == null) { fitAll(); return; }
      focused = null;
      startMorph(0, 700); fitAll();
      triggerBloom();
      opts.onFocusChange(null);
    }
    let bloomT = 0;
    function triggerBloom() { bloomT = 1; }

    function setHalo(hubId, leafId) {
      for (const H of hubs) for (const N of H.leaves) N.haloRing.alpha = 0;
      if (hubId == null || leafId == null) return;
      const H = hubById2(hubId);
      const N = H && H.leaves.find((n) => n.id === leafId);
      if (N) N.haloRing.alpha = 1;
    }

    /* ------------------------------ ticker ------------------------------------ */
    let t = 0, lastSkillA = -1;
    app.ticker.add((delta) => {
      const dt = Math.min(delta / 60, 0.05);
      t += dt;
      let layoutDirty = false;

      if (morphTween) {
        morphTween.t += delta * 16.7;
        const k = easeInOut(Math.min(1, morphTween.t / morphTween.dur));
        morph = morphTween.from + (morphTween.to - morphTween.from) * k;
        if (morphTween.t >= morphTween.dur) { morph = morphTween.to; morphTween = null; }
        layoutDirty = true;
      }
      if (tween) {
        tween.t += delta * 16.7;
        const p = Math.min(1, tween.t / tween.dur);
        const kZoom = tween.overshoot ? easeOutBack(p) : easeOutCubic(p);
        const kPos = easeOutCubic(p);
        cam.s = lerp(tween.from.s, tween.to.s, kZoom);
        cam.x = lerp(tween.from.x, tween.to.x, kPos);
        cam.y = lerp(tween.from.y, tween.to.y, kPos);
        if (p >= 1) tween = null;
      }
      const shiftGoal = sbShiftT * Math.min(230, app.screen.width * 0.15);
      if (Math.abs(shiftGoal - sbShift) > 0.4) sbShift += (shiftGoal - sbShift) * Math.min(1, dt * 14);
      applyCam();

      if (layoutDirty) { updateLayout(); edgesDirty = true; }
      if (edgesDirty) { redrawEdges(); edgesDirty = false; }

      // spotlight: while a hub is focused, only IT stays fully lit — every
      // other hub (already sitting in its own strip slot) fades to a faint
      // ghost. In ring view (nothing focused), the same mechanism drives
      // the fast hover spotlight instead.
      const highlightTarget = focused != null ? focused : hoverHubId;
      const nothingActive = highlightTarget == null;
      for (const H of hubs) {
        const isTarget = !nothingActive && H.id === highlightTarget;
        const targetA = isTarget ? 1 : 0.08;
        H._spot = H._spot === undefined ? 1 : H._spot;
        H._spot += (targetA - H._spot) * Math.min(1, dt * 10);
        H.hub.alpha = H._spot;
        H.ghost.alpha = H.ghostBase * Math.max(0.3, H._spot);
        for (const N of H.leaves) N.cont.alpha = H._spot;

        const targetTxtA = isTarget ? 1 : nothingActive ? 0.78 : 0.05;
        H._txtSpot = H._txtSpot === undefined ? 0.78 : H._txtSpot;
        H._txtSpot += (targetTxtA - H._txtSpot) * Math.min(1, dt * 10);
        H.nm.alpha = H._txtSpot; H.sb.alpha = H._txtSpot;
      }
      edgesDirty = true;

      const s = cam.s, m = morph;
      const deptA = Math.max(clamp01((1.5 - s) / 0.6) * (1 - m), m);
      const skillA = Math.max(clamp01((s - 1.2) / 0.7), m * 0.9);
      layerDeptTx.alpha = deptA;
      layerLabels.alpha = 1; // per-node label alpha (hover-only) drives visibility
      layerGhost.alpha = 0.3 + 0.35 * clamp01((s - 0.8) / 1.3);
      updatePieGlow();
      if (Math.abs(skillA - lastSkillA) > 0.01) {
        for (const H of hubs) for (const N of H.leaves) N.iconC.alpha = skillA;
        lastSkillA = skillA;
      }

      for (const H of hubs) {
        H.hubGlow.alpha = H.def.state === "active" ? 0.5 + Math.sin(t * 1.4 + H.hubPh) * 0.35 : 0.15;
      }
      // Only actively-running real leaves get a per-frame pulse. NOTE: the
      // original dashboard code this was ported from references an N.idx
      // that's never actually assigned (Math.sin(t*1.6+undefined) => NaN),
      // so in production this pulse has always silently no-op'd — left
      // exactly as-is (not "fixed") so pixel parity with the live
      // dashboards holds; fixing it would be a visible behavior change.
      for (const H of hubs) for (const N of H.leaves) {
        if (N.isReal && N.runningNow) N.glow.alpha = (0.75 + Math.sin(t * 1.6 + N.idx) * 0.15) * N.dim;
      }

      coreHaze.alpha = (theme === "light" ? 0.09 : 0.24) + Math.sin(t * 0.6) * (theme === "light" ? 0.02 : 0.05);
      if (Math.floor(t * 20) % 3 === 0) for (const p of coreDust) p.alpha = p._base.alpha * (0.85 + 0.15 * Math.sin(t * 1.1 + p._base.x * 0.05));

      if (bloomT > 0) {
        bloomT -= dt / 0.45;
        const b = Math.max(0, bloomT);
        layerFlash.alpha = Math.sin(Math.PI * clamp01(1 - b)) * 0.35 * clamp01(b * 3);
      }
    });

    function selectNode(hubId, N) {
      opts.onNodeClick(hubId, N.id);
    }

    // Deliberately no camera tween yet — a fresh page load calls this
    // before web fonts have necessarily loaded, and starting the reveal
    // tween immediately would let the dive-in animation play against
    // wrong-font (fallback) label metrics for a frame. Static initial
    // pose only (camera stays at its default {s:1,x:0,y:0} until the
    // caller calls back(), typically once its own reveal condition —
    // e.g. document.fonts.ready — is met, matching the original inline
    // implementation's own boot sequencing exactly).
    updateLayout();
    redrawEdges();

    return {
      focusHub, focusNode, next, prev, back, setHalo,
      getFocused() { return focused; },
      // The raw PIXI canvas element — exposed so the caller can bind its
      // own map-area-specific listeners (double-click-to-back, etc.)
      // scoped to just the canvas, not the whole page.
      view: app.view,
      // Viewport size changed (window resize, device rotation) — the
      // renderer itself auto-resizes (resizeTo), but the camera's fit
      // target (idle-scale or focused-hub framing) is a function of
      // viewport size too, so it needs a fresh tween to the new target,
      // exactly like the original's own resize listener.
      resize() { if (focused == null) fitAll(); else focusCamTarget(hubById2(focused)); },
      // Shifts the camera sideways to keep the focused content clear of a
      // caller-owned overlay panel (e.g. the dashboard's left sidebar) —
      // purely a camera compensation, so it lives here rather than
      // requiring the caller to reach into camera internals.
      setPanelOpen(open) { sbShiftT = open ? 1 : 0; },
      setTheme(next) { theme = next === "light" ? "light" : "dark"; applyTheme(); },
      rebuildHub(hubNode, leafNodesForThisHub, edgesForThisHub) {
        const idx = hubDefs.findIndex((d) => d.id === hubNode.id);
        if (idx === -1) return;
        hubDefs[idx] = hubNode;
        const nIdx = nodes.findIndex((n) => n.kind === "hub" && n.id === hubNode.id);
        if (nIdx !== -1) nodes[nIdx] = hubNode;
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (nodes[i].kind === "leaf" && nodes[i].hubId === hubNode.id) nodes.splice(i, 1);
        }
        nodes.push(...leafNodesForThisHub);
        for (let i = edges.length - 1; i >= 0; i--) {
          if (nodeHubOf(edges[i].from) === hubNode.id || nodeHubOf(edges[i].to) === hubNode.id) edges.splice(i, 1);
        }
        edges.push(...edgesForThisHub);
        const H = hubById2(hubNode.id);
        H.def = hubNode;
        rebuildDept(hubNode.id);
      },
      destroy() { app.destroy(true, { children: true, texture: true, baseTexture: true }); },
    };
  }

  window.createBrainMap = createBrainMap;
})();
