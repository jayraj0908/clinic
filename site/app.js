/* Sailz site behaviour.
   Nothing here is decorative for its own sake: the map is the product's
   map, the demo is a real call flow, the screens are the real dashboard
   rebuilt in HTML, and the booking chat produces the same structured lead
   the old form did. */
(function () {
  "use strict";

  var D = window.SAILZ_DATA || { agents: {}, blueprints: [] };
  var AGENTS = D.agents, BPS = D.blueprints;
  var $ = function (id) { return document.getElementById(id); };
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ============================ loading screen ========================= */
  // A short, honest loader: it draws the same core cluster the brain map
  // uses, assembling from scattered dust. It never fakes a long wait; the
  // bar tracks real font and script readiness and then finishes.
  (function loader() {
    var el = $("loader"), fill = $("loadFill"), pct = $("loadPct");
    var cv = $("loadCanvas"), ctx = cv && cv.getContext ? cv.getContext("2d") : null;
    var value = 0, target = 12, done = false;

    var dust = [];
    if (ctx) {
      for (var i = 0; i < 180; i++) {
        var a = Math.random() * Math.PI * 2;
        var r = Math.pow(Math.random(), 0.6) * 46;
        dust.push({
          hx: 220 + Math.cos(a) * r, hy: 110 + Math.sin(a) * r * 0.8,
          sx: Math.random() * 440, sy: Math.random() * 220,
          s: Math.random() * 1.6 + 0.4, al: Math.random() * 0.6 + 0.25,
        });
      }
    }
    var PAL = ["#f0e6c8", "#d9c78f", "#fff8e8", "#e8d9a8", "#e0904a"];

    function paint(p) {
      if (!ctx) return;
      ctx.clearRect(0, 0, 440, 220);
      var g = ctx.createRadialGradient(220, 110, 0, 220, 110, 90);
      g.addColorStop(0, "rgba(168,56,74," + (0.3 * p) + ")");
      g.addColorStop(1, "rgba(168,56,74,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, 440, 220);
      for (var i = 0; i < dust.length; i++) {
        var d = dust[i];
        var x = d.sx + (d.hx - d.sx) * p, y = d.sy + (d.hy - d.sy) * p;
        ctx.globalAlpha = d.al * (0.25 + 0.75 * p);
        ctx.fillStyle = PAL[i % PAL.length];
        ctx.beginPath(); ctx.arc(x, y, d.s, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function tick() {
      value += (target - value) * 0.08;
      if (target >= 100 && target - value < 0.6) value = 100;
      var v = Math.round(value);
      if (fill) fill.style.width = v + "%";
      if (pct) pct.textContent = v;
      paint(value / 100);
      if (v >= 100 && !done) {
        done = true;
        setTimeout(function () {
          el.classList.add("done");
          document.body.classList.remove("loading");
          window.dispatchEvent(new Event("sailz:ready"));
        }, 260);
        return;
      }
      requestAnimationFrame(tick);
    }

    // Real signals rather than a timer pretending to be one.
    target = 30;
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { target = Math.max(target, 68); });
    } else { target = 68; }
    window.addEventListener("load", function () { target = 100; });
    setTimeout(function () { target = Math.max(target, 82); }, 700);
    setTimeout(function () { target = 100; }, 2600); // never trap a visitor behind a stalled asset

    if (reduce) {
      el.classList.add("done");
      document.body.classList.remove("loading");
      window.dispatchEvent(new Event("sailz:ready"));
    } else {
      requestAnimationFrame(tick);
    }
  })();

  /* =============================== nav ================================ */
  (function nav() {
    var n = $("nav"), bar = $("navProgress");
    function onScroll() {
      n.classList.toggle("stuck", window.scrollY > 40);
      var h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (h > 0 ? (window.scrollY / h) * 100 : 0) + "%";
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  })();

  /* ============================ reveal system ========================= */
  (function reveals() {
    // Split the hero headline into words so it lands one word at a time.
    document.querySelectorAll("[data-split]").forEach(function (el) {
      var html = el.innerHTML;
      // Preserve the <em> wrapper by splitting inside each text node.
      var tmp = document.createElement("div");
      tmp.innerHTML = html;
      var idx = 0;
      (function walk(node) {
        Array.prototype.slice.call(node.childNodes).forEach(function (child) {
          if (child.nodeType === 3) {
            var frag = document.createDocumentFragment();
            child.nodeValue.split(/(\s+)/).forEach(function (part) {
              if (!part.trim()) { frag.appendChild(document.createTextNode(part)); return; }
              var s = document.createElement("span");
              s.className = "word";
              s.style.transitionDelay = (idx++ * 0.045) + "s";
              s.textContent = part;
              frag.appendChild(s);
            });
            node.replaceChild(frag, child);
          } else if (child.nodeType === 1) walk(child);
        });
      })(tmp);
      el.innerHTML = tmp.innerHTML;
    });

  })();

  // Observing has to happen AFTER every section that injects markup has
  // run, or anything built by script (the pricing cards) is created with
  // opacity 0 and never observed, so it stays invisible forever. Exposed
  // rather than inlined so a later injection can register itself too.
  var revealIO = null;
  function observeReveals(scope) {
    var els = (scope || document).querySelectorAll("[data-reveal]:not(.seen),.word:not(.seen)");
    if (!("IntersectionObserver" in window)) {
      Array.prototype.forEach.call(els, function (e) { e.classList.add("in", "seen"); });
      return;
    }
    if (!revealIO) {
      revealIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add("in"); revealIO.unobserve(e.target); }
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    }
    Array.prototype.forEach.call(els, function (e) { e.classList.add("seen"); revealIO.observe(e); });
  }
  window.sailzObserveReveals = observeReveals;

  /* ============================== ticker ============================== */
  (function ticker() {
    var row = $("tickerRow");
    if (!row) return;
    // Illustrative of the kinds of events an owner sees in their feed.
    var items = [
      "Inbound call answered in 2 rings",
      "Appointment booked, Thursday 2:00pm",
      "Caller asked about pricing, message taken",
      "Lead enriched from public sources, 4 citations",
      "Outbound batch paused for quiet hours",
      "Do not call request honoured immediately",
      "Order taken, allergy flagged to a human",
      "Librarian proposed 3 facts for approval",
      "RFP answered in 6 minutes",
      "Confirmation text queued",
    ];
    var html = items.map(function (t) {
      return '<span class="ticker-item"><i class="tdot"></i><b>' + esc(t) + "</b></span>";
    }).join("");
    row.innerHTML = html + html; // doubled so the marquee loop is seamless
  })();

  /* ============================== pricing ============================= */
  (function pricing() {
    // Mirrors docs/SAILZ-PRICING.md. That document is what a human
    // negotiates with; if the two disagree, the document wins.
    var PLANS = [
      { id: "solo", name: "Solo", price: "199", setup: "$500 setup",
        forWho: "One operator. A consultant, an agent, a one-chair practice.",
        items: ["<b>1 agent</b> plus the Librarian", "<b>300</b> talk minutes a month",
                "1 phone number", "100 research lookups a month",
                "Simple mode and the full brain map", "Weekly email report"] },
      { id: "business", name: "Business", price: "499", setup: "$500 setup", featured: true,
        forWho: "One location with a front desk and real phone volume.",
        items: ["<b>Up to 3 agents</b> plus the Librarian", "<b>1,000</b> talk minutes a month",
                "2 phone numbers", "500 research lookups a month",
                "Calls, Leads, and Calendar or Orders", "Monthly review with us"] },
      { id: "multi", name: "Multi", price: "999", setup: "$1,500 setup",
        forWho: "Multi-location, hotel groups and franchises. Anyone with more than one P&L.",
        items: ["<b>Unlimited agents</b>", "<b>2,500</b> talk minutes a month",
                "Up to 3 locations, then $249 each", "2,000 research lookups a month",
                "Cross-location roll-up", "Shared Slack channel, 4 hour response"] },
    ];
    $("prices").innerHTML = PLANS.map(function (p, i) {
      return '<div class="price' + (p.featured ? " featured" : "") + '" data-reveal data-d="' + (i + 1) + '">'
        + (p.featured ? '<div class="price-tag">Most chosen</div>' : "")
        + '<div class="price-name">' + p.name + "</div>"
        + '<div class="price-for">' + p.forWho + "</div>"
        + '<div class="price-amt">$' + p.price + "<small> a month</small></div>"
        + '<div class="price-setup">' + p.setup + "</div>"
        + "<ul>" + p.items.map(function (x) { return "<li>" + x + "</li>"; }).join("") + "</ul>"
        + '<a class="btn ' + (p.featured ? "btn-primary" : "btn-ghost") + '" href="#talk" data-plan="'
        + p.id + '">Start with ' + p.name + '<span class="arrow">&rarr;</span></a></div>';
    }).join("");
    observeReveals($("prices"));
  })();

  /* =============================== brain ============================== */
  var mapApi = null, heroApi = null;
  var activeWorkflow = null, focusedDept = null;
  var Q = new URLSearchParams(window.location.search);
  var current = BPS.filter(function (b) { return b.vertical === Q.get("v"); })[0] || BPS[0] || null;
  var selected = (current && AGENTS[Q.get("a")]) ? Q.get("a") : null;

  var TAB_LABELS = { dash: "Dashboard", calls: "Calls", leads: "Leads", calendar: "Calendar",
                     orders: "Orders", teach: "Teach", work: "Chart" };
  var ALL_TABS = ["dash", "calls", "leads", "calendar", "orders", "teach", "work"];

  function rosterFor(bp) {
    var out = [];
    if (!bp) return out;
    if (bp.primary) out.push({ id: bp.primary, primary: true, dormant: false });
    if (bp.coPrimary) out.push({ id: bp.coPrimary, primary: true, dormant: false });
    (bp.agents || []).forEach(function (id) {
      if (id !== bp.primary && id !== bp.coPrimary) out.push({ id: id, primary: false, dormant: false });
    });
    (bp.dormant || []).forEach(function (id) { out.push({ id: id, primary: false, dormant: true }); });
    return out.filter(function (r) { return AGENTS[r.id]; });
  }

  function tabChips(bp) {
    return ALL_TABS.map(function (t) {
      var on = (bp.tabs || []).indexOf(t) !== -1;
      return '<span class="chip ' + (on ? "on" : "off") + '">' + TAB_LABELS[t] + "</span>";
    }).join("");
  }

  // The drawer is detail only: one department, or one agent. It opens over
  // the canvas and the renderer shifts the camera clear of it.
  function renderPanel() {
    var panel = $("panel");
    if (!current) {
      panel.classList.remove("open");
      panel.innerHTML = "";
      return;
    }

    var close = '<button class="panel-close" id="panelClose" type="button" aria-label="Close">&times;</button>';

    if (selected && AGENTS[selected]) {
      var a = AGENTS[selected];
      var isPrimary = selected === current.primary || selected === current.coPrimary;
      var isDormant = (current.dormant || []).indexOf(selected) !== -1;
      panel.innerHTML = close
        + '<div class="panel-kicker" style="color:' + esc(a.color) + '">'
          + (isPrimary ? "Primary agent" : isDormant ? "Available, not switched on" : "Supporting agent")
        + "</div>"
        + "<h3>" + esc(a.name) + "</h3>"
        + '<p class="panel-desc">' + esc(a.description) + "</p>"
        + ((a.workflows && a.workflows.length)
            ? '<div><div class="panel-sub">What it actually does</div>'
              + a.workflows.map(function (w) {
                  var on = activeWorkflow === w.label;
                  return '<div class="wf"' + (on ? ' style="background:rgba(201,160,102,.07)"' : "") + '>'
                    + '<span class="wf-dot" style="background:' + esc(a.color) + '"></span>'
                    + "<span><b>" + esc(w.label) + "</b><span>" + esc(w.detail) + "</span></span></div>";
                }).join("") + "</div>"
            : "")
        + '<div><div class="panel-sub">Runs on</div><div class="chips">'
          + (a.tools || []).map(function (t) { return '<span class="chip">' + esc(t) + "</span>"; }).join("")
          + '<span class="chip">' + (a.schedule ? "on a schedule" : "event driven") + "</span>"
        + "</div></div>"
        + (isDormant
            ? '<div class="panel-note">This one ships switched off. It shows on your map from day one '
              + "and turns on when you want it. No rebuild, no new contract.</div>"
            : "");
      panel.classList.add("open");
      wireClose();
      return;
    }

    if (focusedDept) {
      var dept = (D.departments || []).filter(function (x) { return x.name === focusedDept; })[0];
      var here = rosterFor(current).filter(function (r) { return (D.agentDept || {})[r.id] === focusedDept; });
      panel.innerHTML = close
        + '<div class="panel-kicker"' + (dept ? ' style="color:' + esc(dept.color) + '"' : "") + '>Department</div>'
        + "<h3>" + esc(focusedDept) + "</h3>"
        + '<p class="panel-desc">' + esc(dept ? dept.sub : "") + "</p>"
        + (here.length
            ? '<div><div class="panel-sub">' + (here.length === 1 ? "Agent here" : "Agents here") + "</div>"
              + here.map(function (r) {
                  var ag = AGENTS[r.id];
                  return '<button class="dept-agent' + (r.dormant ? " dormant" : "") + '" type="button" '
                    + 'data-agent="' + esc(r.id) + '">'
                    + '<span class="nb-glyph" style="background:' + esc(ag.color) + "22;color:" + esc(ag.color) + '">'
                      + esc(ag.glyph) + "</span>"
                    + "<span><span class=\"nb-name\">" + esc(ag.name) + "</span>"
                    + '<span class="nb-tag">' + esc(r.dormant ? "available, not switched on" : ag.tagline)
                    + "</span></span></button>";
                }).join("") + "</div>"
            : '<div class="panel-note">Nothing runs here for a '
              + esc((current.shortLabel || current.label).toLowerCase())
              + " business, so it stays dark on your map. The branches you can see are what could go here "
              + "if you ever needed it.</div>");
      panel.classList.add("open");
      wireClose();
      return;
    }

    panel.classList.remove("open");
  }

  function wireClose() {
    var c = $("panelClose");
    if (c) c.addEventListener("click", function () {
      selected = null; activeWorkflow = null; focusedDept = null;
      if (mapApi) { mapApi.back(); mapApi.setPanelOpen(false); }
      markPressed(); renderPanel(); syncUrl();
    });
  }

  // Always-visible context under the map, so the canvas itself stays clean.
  function renderSummary() {
    var el = $("vsummary");
    if (!el || !current) return;
    el.innerHTML =
      "<div>"
      + '<div class="vs-head">' + esc(current.headline) + "</div>"
      + '<p class="vs-pain">' + esc(current.pain) + "</p>"
      + '<div class="vs-live"><i></i>' + esc(current.liveExample || "") + "</div>"
      + "</div>"
      + '<div class="vs-col">'
        + '<div class="vs-block"><div class="panel-sub">What you would watch</div><div class="chips">'
          + (current.kpis || []).map(function (k) { return '<span class="chip on">' + esc(k) + "</span>"; }).join("")
        + "</div></div>"
        + '<div class="vs-block"><div class="panel-sub">Your dashboard has exactly these tabs</div>'
          + '<div class="chips">' + tabChips(current) + "</div></div>"
        + '<div class="panel-note">' + esc(current.compliance) + "</div>"
      + "</div>";
  }

  function syncUrl() {
    if (!window.history || !window.history.replaceState || !current) return;
    var q = "?v=" + encodeURIComponent(current.vertical)
          + (selected ? "&a=" + encodeURIComponent(selected) : "");
    window.history.replaceState(null, "", q + window.location.hash);
  }

  function markPressed() {
    document.querySelectorAll("[data-agent]").forEach(function (el) {
      el.setAttribute("aria-pressed", String(el.dataset.agent === selected));
    });
    var core = $("stageCore");
    if (core) core.classList.toggle("hide", !!selected);
  }

  function select(id, fromMap, workflow) {
    selected = (selected === id) ? null : id;
    activeWorkflow = selected ? (workflow || null) : null;
    markPressed();
    renderPanel();
    syncUrl();
    if (mapApi && !fromMap) {
      if (selected) mapApi.focusAgent(selected, activeWorkflow);
      else mapApi.back();
    }
    if (mapApi) mapApi.setPanelOpen(!!selected);
  }

  // A department was clicked that holds more than one agent, so there is no
  // single agent to open. Show what lives there instead of doing nothing.
  function selectDept(dept) {
    selected = null;
    activeWorkflow = null;
    focusedDept = dept;
    markPressed();
    renderPanel();
    syncUrl();
  }

  // Small screens and the no-WebGL fallback get a grouped list, not one long
  // run of agents. Department first, expand to its agents, tap one for the
  // detail. Same information as the canvas, in a shape a thumb can work.
  var openDept = null;
  function buildNodeList() {
    var list = $("nodeList");
    var roster = rosterFor(current);
    // Open the primary agent's department by default so a visitor on a phone
    // lands on something, rather than seven closed rows.
    if (openDept === null && current && current.primary) {
      openDept = (D.agentDept || {})[current.primary] || null;
    }
    var byDept = {};
    roster.forEach(function (r) {
      var d = (D.agentDept || {})[r.id];
      if (!d) return;
      (byDept[d] = byDept[d] || []).push(r);
    });

    list.innerHTML = (D.departments || []).map(function (def) {
      var mine = byDept[def.name] || [];
      var isOpen = openDept === def.name;
      var count = mine.length
        ? mine.length + (mine.length === 1 ? " agent" : " agents")
        : "nothing here for you";
      return '<div class="deptrow' + (mine.length ? "" : " empty") + (isOpen ? " open" : "") + '">'
        + '<button class="deptrow-head" type="button" data-dept="' + esc(def.name) + '"'
          + (mine.length ? "" : " disabled") + ' aria-expanded="' + isOpen + '">'
          + '<span class="deptrow-dot" style="background:' + esc(def.color) + '"></span>'
          + "<span><span class=\"deptrow-name\">" + esc(def.name) + "</span>"
          + '<span class="deptrow-sub">' + esc(def.sub) + "</span></span>"
          + '<span class="deptrow-count">' + esc(count) + "</span>"
        + "</button>"
        + (isOpen && mine.length
            ? '<div class="deptrow-body">' + mine.map(function (r) {
                var a = AGENTS[r.id];
                return '<button class="nodebtn' + (r.dormant ? " dormant" : "") + '" type="button" '
                  + 'data-agent="' + esc(r.id) + '" aria-pressed="' + (selected === r.id) + '">'
                  + '<span class="nb-glyph" style="background:' + esc(a.color) + "22;color:" + esc(a.color) + '">'
                    + esc(a.glyph) + "</span>"
                  + "<span><span class=\"nb-name\">" + esc(a.name) + "</span>"
                  + '<span class="nb-tag">' + esc(r.dormant ? "available, not switched on" : a.tagline)
                  + "</span></span>"
                  + (r.primary ? '<span class="nb-badge">Primary</span>' : "")
                  + "</button>";
              }).join("") + "</div>"
            : "")
        + "</div>";
    }).join("");
  }

  function renderBrain() {
    if (!current) { renderPanel(); return; }
    var inRoster = rosterFor(current).some(function (r) { return r.id === selected; });
    if (selected && (!AGENTS[selected] || !inRoster)) selected = null;
    $("hubName").textContent = current.shortLabel || current.label;
    buildNodeList();
    renderSummary();
    if (mapApi) {
      mapApi.setBlueprint(current);
      if (selected) mapApi.focusAgent(selected, activeWorkflow);
    }
    markPressed();
    renderPanel();
    syncUrl();
  }

  (function brainInit() {
    var vt = $("verticals");
    vt.innerHTML = BPS.map(function (bp) {
      return '<button class="vpill" role="tab" data-v="' + esc(bp.vertical) + '" aria-selected="'
        + (current && bp.vertical === current.vertical) + '">' + esc(bp.shortLabel || bp.label) + "</button>";
    }).join("");
    vt.addEventListener("click", function (e) {
      var b = e.target.closest("[data-v]");
      if (!b) return;
      var bp = BPS.filter(function (x) { return x.vertical === b.dataset.v; })[0];
      if (!bp || bp === current) return;
      current = bp; selected = null; activeWorkflow = null; focusedDept = null; openDept = null;
      Array.prototype.forEach.call(vt.children, function (c) {
        c.setAttribute("aria-selected", String(c === b));
      });
      renderBrain();
    });
    $("stage").addEventListener("click", function (e) {
      var d = e.target.closest("[data-dept]");
      if (d && !d.disabled) {
        openDept = (openDept === d.dataset.dept) ? null : d.dataset.dept;
        buildNodeList();
        return;
      }
      var b = e.target.closest("[data-agent]");
      if (b) select(b.dataset.agent);
    });
    renderBrain();
  })();

  /* ============================ pixi map boot ========================= */
  // Building the map costs a WebGL context, textures and several hundred
  // display objects. A visitor who never scrolls past the hero should not
  // pay for any of it, so it is built the first time the section comes
  // within a screen of the viewport.
  function initMap() {
    var stage = $("stage");
    var tip = $("mapTip");

    mapApi = window.SailzShowcaseMap ? window.SailzShowcaseMap(stage, {
      data: D,
      blueprint: current,
      onSelect: function (agentId, dept, workflow) {
        if (agentId) select(agentId, true, workflow);
        else selectDept(dept);
      },
      onHover: function (payload) {
        if (!tip) return;
        if (!payload) { tip.classList.remove("show"); return; }
        tip.innerHTML = '<b>' + esc(payload.label) + '</b>'
          + (payload.sub ? '<span>' + esc(payload.sub) + '</span>' : '');
        // onHover gives page-space coordinates already offset for the
        // canvas, so the tooltip can be positioned straight from them.
        tip.style.left = payload.x + "px";
        tip.style.top = payload.y + "px";
        tip.classList.add("show");
      },
      onFocusChange: function (dept) {
        focusedDept = dept;
        var back = $("mapBack");
        if (back) back.classList.toggle("show", !!dept);
        var core = $("stageCore");
        if (core) core.classList.toggle("hide", !!dept);
        if (!dept) { selected = null; activeWorkflow = null; markPressed(); renderPanel(); syncUrl(); }
      },
    }) : null;

    if (!mapApi) {
      // No WebGL, or PIXI blocked. The DOM list is already rendered and
      // carries the same information as real buttons.
      stage.classList.add("nogl");
    } else if (selected) {
      mapApi.focusAgent(selected, activeWorkflow);
    }

    var back = $("mapBack");
    if (back) back.addEventListener("click", function () { if (mapApi) mapApi.back(); });

    window.addEventListener("resize", function () {
      if (mapApi) mapApi.resize();
    });
  }

  window.addEventListener("sailz:ready", function () {
    if (reduce) { $("stage").classList.add("nogl"); return; }
    // Small screens never build the canvas at all: they get the grouped
    // department list, which is the readable and tappable version.
    if (window.innerWidth <= 1000) { $("stage").classList.add("nogl"); return; }
    if (!("IntersectionObserver" in window)) { initMap(); return; }
    var once = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) {
        once.disconnect();
        initMap();
      }
    }, { rootMargin: "100% 0px" });
    once.observe($("brain"));
  });

  /* ============================== hero dust =========================== */
  // The hero used to run a second full WebGL map. Two live PIXI contexts on
  // one page is a lot of GPU for scenery that nobody can click, and at any
  // reasonable size it collided with the headline. This is the Sailz core
  // on its own: one 2D canvas, ~200 particles, capped at 30fps, paused the
  // moment it scrolls out of view.
  (function heroDust() {
    var cv = $("heroDust");
    if (!cv || reduce) return;
    var ctx = cv.getContext ? cv.getContext("2d") : null;
    if (!ctx) return;

    var PAL = ["#f0e6c8", "#d9c78f", "#fff8e8", "#e8d9a8", "#e0904a"];
    var dust = [], W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    var running = true, last = 0;

    function size() {
      var r = cv.getBoundingClientRect();
      W = r.width; H = r.height;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dust = [];
      var cx = W / 2, cy = H / 2;
      for (var i = 0; i < 200; i++) {
        var a = Math.random() * Math.PI * 2;
        var rad = Math.pow(Math.random(), 0.6) * Math.min(W, H) * 0.16;
        dust.push({
          x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad * 0.85,
          r: Math.random() * 1.5 + 0.35, a: Math.random() * 0.6 + 0.25,
          drift: Math.random() * 1.2 + 0.4, phase: Math.random() * 6.283,
          c: PAL[i % PAL.length],
        });
      }
    }

    function frame(now) {
      if (!running) return;
      // 30fps is plenty for drifting dust and halves the work.
      if (now - last < 33) { requestAnimationFrame(frame); return; }
      last = now;
      var t = now / 1000;
      ctx.clearRect(0, 0, W, H);

      var cx = W / 2, cy = H / 2;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(W, H) * 0.42);
      g.addColorStop(0, "rgba(168,56,74,.20)");
      g.addColorStop(0.55, "rgba(201,160,102,.055)");
      g.addColorStop(1, "rgba(168,56,74,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      for (var i = 0; i < dust.length; i++) {
        var d = dust[i];
        ctx.globalAlpha = d.a * (0.65 + 0.35 * Math.sin(t * 1.1 + d.phase));
        ctx.fillStyle = d.c;
        ctx.beginPath();
        ctx.arc(d.x + Math.sin(t * 0.35 * d.drift + d.phase) * 3.5,
                d.y + Math.cos(t * 0.3 * d.drift + d.phase) * 3, d.r, 0, 6.284);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    }

    size();
    window.addEventListener("resize", size);
    requestAnimationFrame(frame);

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && !running) { running = true; requestAnimationFrame(frame); }
          else if (!e.isIntersecting) running = false;
        });
      }, { threshold: 0 }).observe(cv);
    }
  })();

  /* ============================= call demo ============================ */
  (function demo() {
    var SCRIPTS = [
      {
        id: "inbound", tab: "A new patient calls at 6:10pm", glyph: "☎",
        name: "AI Receptionist", sub: "inbound line, after hours",
        note: "The practice was closed. Nobody missed the call, and nobody stayed late.",
        turns: [
          { who: "them", text: "Hi, are you taking new patients? I chipped a tooth." },
          { who: "us", text: "We are, and I am sorry about the tooth. I am the practice's AI assistant. Is this causing you pain right now?" },
          { who: "them", text: "It aches but it is bearable." },
          { who: "us", text: "Understood. I have an emergency slot tomorrow at 8:00am, or Thursday at 2:00pm. Which suits you?" },
          { who: "them", text: "Tomorrow at eight." },
          { who: "us", text: "Booked. What is the best mobile number for your confirmation text? We will also send a reminder before your visit. Message rates may apply and you can reply STOP any time.", meta: "consent captured on the call" },
        ],
        steps: [
          { t: "Caller identified as new", s: "No record found, so a lead was opened rather than a chart." },
          { t: "Live calendar checked", s: "Real availability, not a guess at what might be free." },
          { t: "Slot held during the call", s: "Booked before the caller hung up, so it cannot be double sold." },
          { t: "Consent captured verbatim", s: "The SMS disclosure was read out, which is what makes the reminder legal." },
          { t: "Confirmation and reminder queued", s: "Owner sees it in the morning feed with the transcript attached." },
        ],
      },
      {
        id: "outbound", tab: "Your list gets worked", glyph: "↪",
        name: "Calling Agent", sub: "outbound, paced",
        note: "Nine calls a day was the old ceiling. The ceiling was never the interest, it was the hours.",
        turns: [
          { who: "us", text: "Morning, this is an AI assistant calling on behalf of a retirement plan consultancy. Do you have a moment?" },
          { who: "them", text: "We are happy with our current provider." },
          { who: "us", text: "That is fair, and I am not asking you to change anything. Most firms we speak to have not had their plan benchmarked in a few years. Would a 15 minute review be useful, or should I leave it?" },
          { who: "them", text: "A review would be alright, actually." },
          { who: "us", text: "I have Tuesday at 10:00am or Wednesday at 3:00pm.", meta: "checking the real calendar" },
          { who: "them", text: "Tuesday works." },
        ],
        steps: [
          { t: "Company researched before dialling", s: "Public business information only, and every fact carries a source link." },
          { t: "Consent basis checked", s: "A lead without a recorded lawful basis is never dialled." },
          { t: "Quiet hours and do not call applied", s: "Server side, before the number is even handed to the dialler." },
          { t: "Objection handled once, then stopped", s: "One follow up. Not interested means not called again." },
          { t: "Meeting written to the calendar", s: "And the outcome logged against the lead automatically." },
        ],
      },
    ];

    var idx = 0, timer = null, started = false;

    function renderTabs() {
      $("demoTabs").innerHTML = SCRIPTS.map(function (s, i) {
        return '<button class="vpill" role="tab" data-demo="' + i + '" aria-selected="' + (i === idx) + '">'
          + esc(s.tab) + "</button>";
      }).join("");
    }

    function play(i) {
      idx = i;
      var s = SCRIPTS[i];
      clearTimeout(timer);
      renderTabs();
      $("demoGlyph").innerHTML = s.glyph;
      $("demoName").textContent = s.name;
      $("demoSub").textContent = s.sub;
      $("demoNote").textContent = s.note;
      $("demoBody").innerHTML = "";
      $("demoSteps").innerHTML = s.steps.map(function (st, k) {
        return '<div class="step" data-step="' + k + '"><span class="step-tick">&#10003;</span>'
          + "<span><b>" + esc(st.t) + "</b><span>" + esc(st.s) + "</span></span></div>";
      }).join("");

      var body = $("demoBody"), turn = 0;
      function next() {
        if (turn >= s.turns.length) {
          // let the last step land, then loop to the other script
          timer = setTimeout(function () { play((i + 1) % SCRIPTS.length); }, 4200);
          return;
        }
        var t = s.turns[turn];
        var typing = null;
        if (t.who === "us") {
          typing = document.createElement("div");
          typing.className = "typing";
          typing.innerHTML = "<i></i><i></i><i></i>";
          body.appendChild(typing);
          body.scrollTop = body.scrollHeight;
        }
        var delay = t.who === "us" ? 900 : 260;
        timer = setTimeout(function () {
          if (typing) typing.remove();
          var b = document.createElement("div");
          b.className = "bubble " + t.who;
          b.innerHTML = esc(t.text) + (t.meta ? "<small>" + esc(t.meta) + "</small>" : "");
          body.appendChild(b);
          while (body.children.length > 6) body.removeChild(body.firstChild);
          // Reveal the matching behind-the-scenes step as the call moves.
          var stepIdx = Math.min(s.steps.length - 1, Math.floor((turn / s.turns.length) * s.steps.length));
          var stepEl = document.querySelector('[data-step="' + stepIdx + '"]');
          if (stepEl) stepEl.classList.add("on");
          turn++;
          timer = setTimeout(next, t.who === "us" ? 1500 : 1100);
        }, delay);
      }
      next();
    }

    $("demoTabs").addEventListener("click", function (e) {
      var b = e.target.closest("[data-demo]");
      if (b) play(+b.dataset.demo);
    });
    renderTabs();

    // Only start when the section is actually on screen, and stop when it
    // leaves, so the tab is not animating in the background forever.
    if ("IntersectionObserver" in window && !reduce) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && !started) { started = true; play(0); }
          else if (!e.isIntersecting && started) { clearTimeout(timer); started = false; }
        });
      }, { threshold: 0.25 });
      io.observe($("work"));
    } else {
      play(0);
    }
  })();

  /* =========================== booking chat =========================== */
  // A real conversation that produces the same structured lead a form
  // would. It runs entirely client side today, so it works on a static
  // deploy with no API key and no cost. When the HQ endpoint exists
  // (prompt 20, stage 4) it posts there instead, and the questions can be
  // handed to the model without changing anything the visitor sees.
  (function booking() {
    var log = $("bookLog"), form = $("bookForm"), input = $("bookInput"),
        send = $("bookSend"), quicks = $("bookQuicks"), status = $("bookStatus"),
        prog = $("bookProgress");
    var lead = {}, step = 0, busy = false, finished = false;
    var openedAt = Date.now();
    var ENDPOINT = (window.SAILZ_LEAD_ENDPOINT || "").trim();

    // Real conversation (server/siteHost.js + server/research.js, Claude
    // Haiku) when it's live on this deployment; the scripted STEPS flow
    // below is the automatic fallback whenever it isn't — disabled,
    // rate-limited, erroring, or timing out. Same bubble/typing UI either
    // way, so a visitor never sees which mode they're in.
    var CHAT_ENDPOINT = "/api/site/chat";
    var aiMode = null; // null = still probing, true = AI, false = scripted
    var conversationId = null;
    function withTimeout(ms) { try { return AbortSignal.timeout(ms); } catch (e) { return undefined; } }

    function startAI() {
      // No fetch at all (an old browser, or a locked-down one) is not an
      // error to catch later, it throws right here. Fall back to the
      // scripted intake before touching the network.
      if (typeof fetch !== "function" || !CHAT_ENDPOINT) { aiMode = false; start(); return; }
      var t = typing();
      status.textContent = "thinking";
      fetch(CHAT_ENDPOINT, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hi" }), signal: withTimeout(12000),
      })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .then(function (data) {
          t.remove();
          aiMode = true;
          conversationId = data.conversationId;
          bubble("them", esc(data.reply));
          status.textContent = "ready when you are";
          input.disabled = false; send.disabled = false;
          try { input.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
        })
        .catch(function () {
          t.remove();
          aiMode = false;
          start();
        });
    }

    function submitAI(raw) {
      var value = String(raw == null ? "" : raw).trim();
      if (!value || busy || finished) return;
      bubble("us", esc(value));
      input.value = ""; busy = true; input.disabled = true; send.disabled = true;
      var t = typing();
      fetch(CHAT_ENDPOINT, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conversationId, message: value }), signal: withTimeout(35000),
      })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .then(function (data) {
          t.remove();
          bubble("them", esc(data.reply));
          busy = false;
          if (data.done) {
            finished = true;
            status.textContent = "sent";
            input.disabled = true; send.disabled = true;
          } else {
            input.disabled = false; send.disabled = false;
            try { input.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
          }
        })
        .catch(function () {
          t.remove();
          busy = false;
          // One AI turn failed mid-conversation — drop to the scripted
          // flow rather than dead-ending the visitor.
          aiMode = false;
          bubble("them", esc("Let's switch to a quick form so this doesn't get lost."));
          input.disabled = false; send.disabled = false;
          askStep();
        });
    }

    function switchToScriptedFlow() {
      aiMode = false;
      finished = false;
      lead = {}; step = 0;
      log.innerHTML = "";
      input.disabled = false; send.disabled = false; input.value = "";
      status.textContent = "ready when you are";
      start();
    }

    var STEPS = [
      {
        key: "vertical",
        ask: function () { return "What kind of business are you? I will show you the version of this built for you."; },
        quicks: function () {
          return BPS.map(function (b) { return { label: b.shortLabel || b.label, value: b.vertical }; })
            .concat([{ label: "Something else", value: "other" }]);
        },
        answer: function (v) {
          var bp = BPS.filter(function (b) { return b.vertical === v; })[0];
          lead.vertical = v;
          if (bp) {
            // Switch the map above to their industry while they talk. Small
            // thing, but it makes the page feel like it is listening.
            var pill = document.querySelector('.vpill[data-v="' + bp.vertical + '"]');
            if (pill) pill.click();
            return bp.pain + " Is that roughly your problem too?";
          }
          return "Understood. Tell me in your own words what keeps getting dropped.";
        },
        skipNext: false,
      },
      {
        key: "problem",
        ask: function () { return "What keeps getting dropped? Plain words are fine."; },
        quicks: function () {
          return [
            { label: "We miss calls", value: "We miss calls, especially after hours." },
            { label: "Nobody follows up", value: "Leads come in and nobody follows up." },
            { label: "We should be calling out", value: "We have a list we should be calling and never do." },
          ];
        },
        answer: function (v) { lead.message = v; return "That is the common one. Two more questions and I will hand you to Jay."; },
      },
      {
        key: "volume",
        ask: function () { return "Roughly how many calls a week does someone have to answer?"; },
        quicks: function () {
          return [
            { label: "Under 20", value: "under 20" },
            { label: "20 to 150", value: "20 to 150" },
            { label: "More than 150", value: "more than 150" },
            { label: "We make calls, not take them", value: "outbound" },
          ];
        },
        answer: function (v) {
          lead.volume = v;
          // Honest plan guidance rather than always steering to the top tier.
          if (v === "under 20" || v === "outbound") { lead.plan = "Solo"; return "Solo, $199 a month, is almost certainly the right size for that. I will note it."; }
          if (v === "20 to 150") { lead.plan = "Business"; return "That is Business, $499 a month. Enough included minutes that you will not think about it."; }
          if (v === "more than 150") { lead.plan = "Multi"; return "At that volume it is Multi, $999 a month, and worth checking whether you have more than one location."; }
          lead.plan = "to discuss";
          return "Noted. We will size it properly on the call.";
        },
      },
      { key: "business", ask: function () { return "What is the business called?"; },
        answer: function (v) { lead.business = v; return "Thanks."; } },
      { key: "name", ask: function () { return "And your name?"; },
        answer: function (v) { lead.name = v; return "Good to meet you, " + v.split(" ")[0] + "."; } },
      { key: "email", ask: function () { return "Best email for the calendar invite?"; },
        validate: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? null : "That does not look like an email. Try again?"; },
        answer: function (v) { lead.email = v; return "Got it."; } },
      { key: "phone", ask: function () { return "A phone number, if you would like us to call rather than email. You can skip this."; },
        quicks: function () { return [{ label: "Skip", value: "" }]; },
        answer: function (v) { lead.phone = v; return null; } },
    ];

    function bubble(who, text, cls) {
      var b = document.createElement("div");
      b.className = "bubble " + who + (cls ? " " + cls : "");
      b.innerHTML = text;
      log.appendChild(b);
      log.scrollTop = log.scrollHeight;
      return b;
    }

    function typing() {
      var t = document.createElement("div");
      t.className = "typing";
      t.innerHTML = "<i></i><i></i><i></i>";
      log.appendChild(t);
      log.scrollTop = log.scrollHeight;
      return t;
    }

    // Sailz speaks on the left ("them" from the visitor's point of view),
    // the visitor answers on the right.
    function say(text, after, delay) {
      busy = true;
      send.disabled = true;
      var t = typing();
      setTimeout(function () {
        t.remove();
        bubble("them", esc(text));
        busy = false;
        send.disabled = false;
        // Only relevant the first time: startAI() leaves the input
        // disabled while it probes, and falls back to this scripted
        // start() on failure — this is what re-enables typing for that
        // path. A no-op every other time (input is already enabled).
        input.disabled = false;
        if (after) after();
      }, delay || Math.min(1100, 320 + text.length * 11));
    }

    function renderProgress() {
      prog.innerHTML = STEPS.map(function (_, i) {
        return '<i class="' + (i < step ? "on" : "") + '"></i>';
      }).join("");
    }

    function renderQuicks() {
      var s = STEPS[step];
      var list = (s && s.quicks) ? s.quicks() : [];
      quicks.innerHTML = list.map(function (q) {
        return '<button class="quick" type="button" data-v="' + esc(q.value) + '">' + esc(q.label) + "</button>";
      }).join("");
    }

    function askStep() {
      renderProgress();
      if (step >= STEPS.length) { finish(); return; }
      var s = STEPS[step];
      say(s.ask(), function () {
        renderQuicks();
        input.placeholder = "Type your answer";
        // preventScroll matters: the chat starts itself when the section
        // scrolls into view, and a plain focus() yanks the page down past
        // the heading a second after the visitor arrives.
        try { input.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
      });
    }

    function submitAnswer(raw) {
      if (busy || finished) return;
      var s = STEPS[step];
      var value = String(raw == null ? "" : raw).trim();
      var isSkip = s.key === "phone" && value === "";
      if (!value && !isSkip) return;
      if (s.validate) {
        var err = s.validate(value);
        if (err) { bubble("us", esc(value)); say(err); return; }
      }
      bubble("us", esc(isSkip ? "Skip for now" : value));
      input.value = "";
      quicks.innerHTML = "";
      var reply = s.answer(value);
      step++;
      if (reply) say(reply, askStep);
      else askStep();
    }

    function finish() {
      finished = true;
      status.textContent = "sending";
      input.disabled = true;
      send.disabled = true;
      quicks.innerHTML = "";
      var summary = '<div class="book-summary"><dl>'
        + "<dt>Business</dt><dd>" + esc(lead.business || "") + "</dd>"
        + "<dt>Contact</dt><dd>" + esc(lead.name || "") + ", " + esc(lead.email || "")
          + (lead.phone ? ", " + esc(lead.phone) : "") + "</dd>"
        + "<dt>Likely plan</dt><dd>" + esc(lead.plan || "to discuss") + "</dd>"
        + "</dl></div>";
      var t = typing();
      setTimeout(function () {
        t.remove();
        bubble("them", "Here is what I have. Sending it to Jay now." + summary);
        deliver();
      }, 700);
    }

    function mailtoFallback() {
      var body = "Name: " + (lead.name || "") + "\nBusiness: " + (lead.business || "")
        + "\nEmail: " + (lead.email || "") + "\nPhone: " + (lead.phone || "not given")
        + "\nVertical: " + (lead.vertical || "") + "\nCall volume: " + (lead.volume || "")
        + "\nLikely plan: " + (lead.plan || "") + "\n\n" + (lead.message || "");
      window.location.href = "mailto:hello@sailz.org?subject="
        + encodeURIComponent("Sailz enquiry: " + (lead.business || "new"))
        + "&body=" + encodeURIComponent(body);
      status.textContent = "over to your email app";
      say("Your email app should be opening with all of this filled in. Hit send and we will reply within one business day.");
    }

    function deliver() {
      // No endpoint configured, or a browser without fetch: the visitor
      // still gets their enquiry delivered rather than a dead end.
      if (!ENDPOINT || typeof fetch !== "function") { setTimeout(mailtoFallback, 500); return; }
      var payload = {};
      for (var k in lead) if (Object.prototype.hasOwnProperty.call(lead, k)) payload[k] = lead[k];
      var hp = $("hpWebsite");
      payload.company_website = hp ? hp.value : "";
      payload.elapsedMs = Date.now() - openedAt;
      fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" },
                        body: JSON.stringify(payload) })
        .then(function (r) { if (!r.ok) throw new Error(r.status); })
        .then(function () {
          status.textContent = "sent";
          say("Sent. You will hear from us within one business day, and we will come to the call having read this.");
        })
        .catch(mailtoFallback);
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (aiMode) submitAI(input.value); else submitAnswer(input.value);
    });
    quicks.addEventListener("click", function (e) {
      var b = e.target.closest("[data-v]");
      if (b && !aiMode) submitAnswer(b.dataset.v);
    });
    $("bookReset").addEventListener("click", function () {
      if (aiMode) { switchToScriptedFlow(); return; }
      lead = {}; step = 0; finished = false;
      log.innerHTML = ""; input.disabled = false; input.value = "";
      status.textContent = "ready when you are";
      start();
    });
    $("bookUseForm").addEventListener("click", switchToScriptedFlow);

    // Pre-fill the intent when someone arrives from a pricing card.
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-plan]");
      if (b) lead.planInterest = b.dataset.plan;
    });

    var opened = false;
    function start() {
      say("Hello. I am the same kind of agent Sailz builds for its clients, "
        + "so this is a conversation rather than a form. It takes about a minute.", askStep, 700);
    }
    // input/send start disabled: startAI() enables them once the probe
    // resolves (either into AI mode, or into the scripted start() below,
    // which enables them itself via say()/askStep()).
    input.disabled = true; send.disabled = true;
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && !opened) { opened = true; startAI(); }
        });
      }, { threshold: 0.3 });
      io.observe($("talk"));
    } else { startAI(); }
    renderProgress();
  })();

  /* ================================ misc ============================== */
  observeReveals(document);

  // Arriving on sailz.org/#pricing scrolls before the fonts and the
  // injected sections have settled, so the browser's first jump lands in
  // the wrong place. Re-aim once the page has stopped moving.
  // syncUrl() rewrites the query string with replaceState, so the browser
  // has seen this URL before and will happily restore an old scroll offset
  // over the top of our own hash aim. Take that over.
  if (window.history && "scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
  }

  window.addEventListener("load", function () {
    var hash = window.location.hash;
    if (!hash || hash === "#top") { window.scrollTo(0, 0); return; }
    var target = document.querySelector(hash);
    if (!target) return;
    setTimeout(function () {
      target.scrollIntoView({ behavior: "auto", block: "start" });
    }, 260);
  });

  window.addEventListener("load", function () {
    setTimeout(function () {
      document.querySelectorAll("[data-reveal]:not(.in),.word:not(.in)").forEach(function (e) {
        var r = e.getBoundingClientRect();
        if (r.top < window.innerHeight * 1.2) e.classList.add("in");
      });
    }, 1200);
  });
  $("yr").textContent = new Date().getFullYear();
})();
