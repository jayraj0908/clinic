/* Sailz brain map — the same constellation the product renders, packaged
   for the marketing site.

   This is a faithful port of the PixiJS map in public/index.html: seeded
   starfield, the maroon-hazed core dust cluster, glow-sprite hubs in each
   agent's own colour, curved edges with travelling pulses, label chips,
   and a camera that tweens to a hub when you click it and expands that
   agent's workflows as leaves around it.

   Two modes:
     ambient:true   slow drift, no interaction, used behind the hero
     ambient:false  the real thing, used in the brain section

   Everything here is decorative-with-a-purpose. If PIXI is missing or
   WebGL is unavailable, init() returns null and the page falls back to
   the DOM node list, which carries the same information as real buttons.

   window.SailzMap(container, opts) -> {setBlueprint, focus, clearFocus,
                                        resize, pause, resume, destroy}
*/
(function () {
  "use strict";

  var CORE = { x: 0, y: 0 };
  var RING = 250;

  // Seeded RNG so the starfield and dust are identical on every reload.
  // A field that reshuffles on refresh reads as noise; one that holds
  // still reads as a place.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function hexToNum(hex) {
    if (typeof hex === "number") return hex;
    return parseInt(String(hex).replace("#", ""), 16) || 0xc9a066;
  }

  function makeGlow(size) {
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.25, "rgba(255,255,255,.55)");
    gr.addColorStop(0.6, "rgba(255,255,255,.12)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, size, size);
    return PIXI.Texture.from(c);
  }

  function makeDot(size) {
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 1, 0, 7);
    g.fill();
    return PIXI.Texture.from(c);
  }

  window.SailzMap = function (container, opts) {
    opts = opts || {};
    var ambient = !!opts.ambient;
    var onSelect = opts.onSelect || function () {};
    var AGENTS = opts.agents || {};

    if (typeof PIXI === "undefined" || !container) return null;

    var app;
    try {
      app = new PIXI.Application({
        resizeTo: container,
        antialias: true,
        backgroundAlpha: 0,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });
    } catch (e) {
      return null; // no WebGL, no canvas fallback available
    }
    container.appendChild(app.view);
    app.view.style.display = "block";
    app.stage.eventMode = ambient ? "none" : "static";

    var world = new PIXI.Container();
    world.eventMode = ambient ? "none" : "static";
    app.stage.addChild(world);

    var layerStars = new PIXI.Container();
    var layerHalo = new PIXI.Container();
    var layerCore = new PIXI.Container();
    var layerEdges = new PIXI.Graphics();
    var layerLeaves = new PIXI.Container();
    var layerNodes = new PIXI.Container();
    var layerLabels = new PIXI.Container();
    world.addChild(layerStars, layerHalo, layerCore, layerEdges, layerLeaves, layerNodes, layerLabels);
    // Decorative layers must not hit-test. A container with a non-'none'
    // eventMode swallows clicks aimed at what is underneath it even at
    // alpha 0, which is the classic "nothing is clickable" bug.
    [layerStars, layerHalo, layerCore, layerEdges, layerLabels, layerLeaves].forEach(function (l) {
      l.eventMode = "none";
    });
    layerNodes.eventMode = ambient ? "none" : "static";

    var GLOW = makeGlow(128);
    var DOT = makeDot(32);

    /* ---------------------------- starfield ---------------------------- */
    var srnd = mulberry32(42);
    var SR = function (a, b) { return a + srnd() * (b - a); };
    for (var i = 0; i < 150; i++) {
      var s = new PIXI.Sprite(DOT);
      s.anchor.set(0.5);
      s.x = SR(-1500, 1500);
      s.y = SR(-1100, 1100);
      s.scale.set(SR(0.02, 0.055));
      s.alpha = SR(0.05, 0.28);
      s.tint = 0xe8e6e0;
      layerStars.addChild(s);
    }

    /* ------------------------- core dust cluster ------------------------ */
    var coreHaze = new PIXI.Sprite(GLOW);
    coreHaze.anchor.set(0.5);
    coreHaze.tint = 0xa8384a;
    coreHaze.scale.set(2.6);
    coreHaze.alpha = 0.3;
    coreHaze.position.set(CORE.x, CORE.y);
    layerCore.addChild(coreHaze);

    var coreGold = new PIXI.Sprite(GLOW);
    coreGold.anchor.set(0.5);
    coreGold.tint = 0xc9a066;
    coreGold.scale.set(1.5);
    coreGold.alpha = 0.35;
    coreGold.blendMode = PIXI.BLEND_MODES.ADD;
    coreGold.position.set(CORE.x, CORE.y);
    layerCore.addChild(coreGold);

    var CORE_PALETTE = [0xf0e6c8, 0xd9c78f, 0xfff8e8, 0xe8d9a8, 0xe0904a];
    var coreDust = [];
    for (var d = 0; d < 240; d++) {
      var ang = SR(0, 6.283);
      var rad = Math.pow(srnd(), 0.6) * 32;
      var p = new PIXI.Sprite(DOT);
      p.anchor.set(0.5);
      p.scale.set(SR(0.015, 0.048));
      p.tint = CORE_PALETTE[Math.floor(SR(0, CORE_PALETTE.length))];
      p.alpha = SR(0.3, 0.9);
      p.x = CORE.x + Math.cos(ang) * rad;
      p.y = CORE.y + Math.sin(ang) * rad * 0.85;
      p._base = { x: p.x, y: p.y, alpha: p.alpha, drift: SR(0.4, 1.6), phase: SR(0, 6.283) };
      coreDust.push(p);
      layerCore.addChild(p);
    }

    /* ------------------------------ hubs -------------------------------- */
    var hubs = [];      // {id, node, x, y, color, primary, dormant, leaves[]}
    var focused = null;
    var hovered = null;

    function clearHubs() {
      hubs.forEach(function (h) {
        h.node.destroy({ children: true });
        h.label.destroy({ children: true });
        h.leaves.forEach(function (lf) { lf.c.destroy({ children: true }); });
      });
      hubs = [];
      focused = null;
      hovered = null;
    }

    function buildHub(entry, idx, total) {
      var a = AGENTS[entry.id];
      if (!a) return null;
      var color = hexToNum(a.color);
      // Primary sits at 12 o'clock. The eye lands on the thing they are
      // actually buying before it wanders.
      var theta = -Math.PI / 2 + (idx * 2 * Math.PI) / total;
      var x = CORE.x + Math.cos(theta) * RING;
      var y = CORE.y + Math.sin(theta) * RING * 0.78;

      var node = new PIXI.Container();
      node.position.set(x, y);
      node.eventMode = ambient ? "none" : "static";
      node.cursor = "pointer";

      var glow = new PIXI.Sprite(GLOW);
      glow.anchor.set(0.5);
      glow.tint = color;
      glow.blendMode = PIXI.BLEND_MODES.ADD;
      glow.scale.set(entry.primary ? 0.9 : 0.62);
      glow.alpha = entry.dormant ? 0.2 : entry.primary ? 0.6 : 0.4;
      node.addChild(glow);

      var ring = new PIXI.Graphics();
      ring.lineStyle(1, color, entry.dormant ? 0.35 : 0.8);
      ring.drawCircle(0, 0, entry.primary ? 17 : 13);
      node.addChild(ring);

      var disc = new PIXI.Graphics();
      disc.beginFill(0x0b0b0e, 0.94).drawCircle(0, 0, entry.primary ? 15 : 11).endFill();
      node.addChild(disc);

      var glyph = new PIXI.Text(a.glyph || "◇", {
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: entry.primary ? 13 : 10,
        fill: color,
      });
      glyph.anchor.set(0.5);
      node.addChild(glyph);

      if (entry.primary) {
        var halo = new PIXI.Graphics();
        halo.lineStyle(1, 0xc9a066, 0.45);
        halo.drawCircle(0, 0, 26);
        node.addChild(halo);
        node._halo = halo;
      }

      // Label chip lives on its own layer so it never intercepts a click
      // meant for the node underneath it.
      var labelWrap = new PIXI.Container();
      var text = new PIXI.Text(a.name, {
        fontFamily: "Inter, system-ui, sans-serif",
        fontWeight: "600",
        fontSize: 9.5,
        fill: entry.dormant ? 0x8a8a86 : 0xe8e6e0,
        letterSpacing: 0.3,
      });
      text.anchor.set(0.5, 0);
      var chip = new PIXI.Graphics();
      chip.beginFill(0x08080a, 0.72)
        .drawRoundedRect(-text.width / 2 - 7, -3, text.width + 14, text.height + 6, 6)
        .endFill();
      labelWrap.addChild(chip, text);
      labelWrap.position.set(x, y + (entry.primary ? 26 : 21));
      layerLabels.addChild(labelWrap);

      var hub = {
        id: entry.id, node: node, label: labelWrap, x: x, y: y, color: color,
        primary: !!entry.primary, dormant: !!entry.dormant, glow: glow,
        baseGlowScale: glow.scale.x, baseGlowAlpha: glow.alpha,
        leaves: [], pulse: Math.random(),
      };

      // Workflow leaves, hidden until this hub is focused. This is the
      // product's semantic zoom: the map shows agents, focusing an agent
      // shows what that agent actually does.
      (a.workflows || []).slice(0, 5).forEach(function (w, li, arr) {
        var spread = Math.PI * 0.85;
        var base = Math.atan2(y - CORE.y, x - CORE.x);
        var lt = base - spread / 2 + (arr.length === 1 ? spread / 2 : (li * spread) / (arr.length - 1));
        var lx = x + Math.cos(lt) * 86;
        var ly = y + Math.sin(lt) * 86;
        var c = new PIXI.Container();
        c.position.set(lx, ly);
        c.alpha = 0;
        var ldot = new PIXI.Sprite(DOT);
        ldot.anchor.set(0.5);
        ldot.scale.set(0.1);
        ldot.tint = color;
        c.addChild(ldot);
        var lt2 = new PIXI.Text(w.label, {
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 8,
          fill: 0xc4beac,
        });
        lt2.anchor.set(0.5, 0);
        lt2.y = 7;
        var lchip = new PIXI.Graphics();
        lchip.beginFill(0x08080a, 0.8)
          .drawRoundedRect(-lt2.width / 2 - 5, 5, lt2.width + 10, lt2.height + 4, 5)
          .endFill();
        c.addChild(lchip, lt2);
        layerLeaves.addChild(c);
        hub.leaves.push({ c: c, x: lx, y: ly });
      });

      if (!ambient) {
        node.on("pointerover", function () { hovered = hub; });
        node.on("pointerout", function () { if (hovered === hub) hovered = null; });
        node.on("pointertap", function (e) {
          e.stopPropagation();
          setFocus(focused === hub ? null : hub);
          onSelect(focused ? focused.id : null);
        });
      }

      layerNodes.addChild(node);
      hubs.push(hub);
      return hub;
    }

    /* ----------------------------- camera ------------------------------ */
    var cam = { x: 0, y: 0, scale: 1 };
    var camTarget = { x: 0, y: 0, scale: 1 };
    var camFrom = { x: 0, y: 0, scale: 1 };
    var camT = 1;
    var CAM_MS = 620;
    var camStart = 0;

    function tweenTo(x, y, scale) {
      camFrom = { x: cam.x, y: cam.y, scale: cam.scale };
      camTarget = { x: x, y: y, scale: scale };
      camStart = performance.now();
      camT = 0;
    }

    function setFocus(hub) {
      focused = hub;
      if (hub) tweenTo(-hub.x * 1.35, -hub.y * 1.35, 1.35);
      else tweenTo(0, 0, 1);
    }

    if (!ambient) {
      app.stage.on("pointertap", function () {
        if (focused) { setFocus(null); onSelect(null); }
      });
    }

    /* ---------------------------- animation ---------------------------- */
    var t0 = performance.now();
    var running = true;

    function frame(now) {
      if (!running) return;
      var t = (now - t0) / 1000;

      // camera
      if (camT < 1) {
        camT = Math.min(1, (now - camStart) / CAM_MS);
        var e = easeInOut(camT);
        cam.x = camFrom.x + (camTarget.x - camFrom.x) * e;
        cam.y = camFrom.y + (camTarget.y - camFrom.y) * e;
        cam.scale = camFrom.scale + (camTarget.scale - camFrom.scale) * e;
      }
      var w = app.renderer.width / app.renderer.resolution;
      var h = app.renderer.height / app.renderer.resolution;
      world.scale.set(cam.scale);
      world.position.set(w / 2 + cam.x * cam.scale, h / 2 + cam.y * cam.scale);

      // core dust: slow breathing orbit
      for (var i = 0; i < coreDust.length; i++) {
        var p = coreDust[i], b = p._base;
        p.x = b.x + Math.sin(t * 0.35 * b.drift + b.phase) * 2.4;
        p.y = b.y + Math.cos(t * 0.3 * b.drift + b.phase) * 2.0;
        p.alpha = b.alpha * (0.72 + 0.28 * Math.sin(t * 1.1 + b.phase));
      }
      coreGold.alpha = 0.3 + 0.09 * Math.sin(t * 0.9);
      coreHaze.scale.set(2.6 + 0.09 * Math.sin(t * 0.55));

      // ambient slow rotation, so the hero never sits perfectly still
      if (ambient) world.rotation = Math.sin(t * 0.05) * 0.05;

      // edges + travelling pulses
      layerEdges.clear();
      for (var k = 0; k < hubs.length; k++) {
        var hb = hubs[k];
        var dim = focused && focused !== hb;
        var alpha = hb.dormant ? 0.07 : hb.primary ? 0.3 : 0.14;
        if (dim) alpha *= 0.35;
        layerEdges.lineStyle(hb.primary ? 1.3 : 1, hb.color, alpha);
        layerEdges.moveTo(CORE.x, CORE.y);
        layerEdges.quadraticCurveTo((CORE.x + hb.x) / 2, (CORE.y + hb.y) / 2 - 26, hb.x, hb.y);

        if (!hb.dormant) {
          var prog = ((t / 3.2) + hb.pulse) % 1;
          var px = CORE.x + (hb.x - CORE.x) * prog;
          var py = CORE.y + (hb.y - CORE.y) * prog - Math.sin(Math.PI * prog) * 26;
          layerEdges.beginFill(hb.color, dim ? 0.25 : 0.9)
            .drawCircle(px, py, hb.primary ? 2.6 : 1.9).endFill();
        }

        // hover and focus response
        var want = hb === hovered || hb === focused ? 1.45 : 1;
        hb.glow.scale.set(hb.glow.scale.x + (hb.baseGlowScale * want - hb.glow.scale.x) * 0.12);
        var wantA = hb === hovered || hb === focused ? Math.min(0.95, hb.baseGlowAlpha * 1.9) : hb.baseGlowAlpha;
        if (dim) wantA *= 0.4;
        hb.glow.alpha += (wantA - hb.glow.alpha) * 0.12;
        var wantNodeA = dim ? 0.35 : 1;
        hb.node.alpha += (wantNodeA - hb.node.alpha) * 0.12;
        hb.label.alpha += ((dim ? 0.15 : 1) - hb.label.alpha) * 0.12;
        if (hb.node._halo) hb.node._halo.rotation = t * 0.25;

        // leaves fade in only for the focused hub
        var leafWant = hb === focused ? 1 : 0;
        for (var li = 0; li < hb.leaves.length; li++) {
          var lf = hb.leaves[li];
          lf.c.alpha += (leafWant - lf.c.alpha) * 0.1;
          if (lf.c.alpha > 0.01) {
            layerEdges.lineStyle(1, hb.color, 0.22 * lf.c.alpha);
            layerEdges.moveTo(hb.x, hb.y);
            layerEdges.lineTo(lf.x, lf.y);
          }
        }
      }

      app.render();
      requestAnimationFrame(frame);
    }
    app.ticker.stop(); // we drive rendering ourselves so pause() is real
    requestAnimationFrame(frame);

    /* ------------------------------ api -------------------------------- */
    return {
      setBlueprint: function (roster) {
        clearHubs();
        var list = (roster || []).filter(function (r) { return AGENTS[r.id]; });
        list.forEach(function (entry, idx) { buildHub(entry, idx, list.length); });
        tweenTo(0, 0, 1);
      },
      focus: function (agentId) {
        var hub = hubs.filter(function (h) { return h.id === agentId; })[0] || null;
        setFocus(hub);
      },
      clearFocus: function () { setFocus(null); },
      resize: function () { app.resize(); },
      pause: function () { running = false; },
      resume: function () {
        if (running) return;
        running = true;
        t0 = performance.now() - 1;
        requestAnimationFrame(frame);
      },
      destroy: function () {
        running = false;
        app.destroy(true, { children: true });
      },
    };
  };
})();
