/* Sailz showcase map — a thin adapter over the product's own renderer.
 *
 * This file used to be a second, simplified constellation written just for
 * the marketing site, which meant the site showed something that merely
 * resembled the product. It no longer renders anything itself. All of the
 * drawing, camera tweens, ring-to-tree morph, semantic zoom, hover and
 * click-to-focus behaviour comes from `brain-map.js`, which is a build-time
 * copy of `public/js/brain-map.js` — the exact module the client dashboard
 * uses. Change the dashboard map and this changes with it.
 *
 * What is left here is translation: turn the seven departments plus one
 * vertical's agent roster into the {nodes, edges} shape the renderer wants,
 * the same way the dashboard's own deptDefsToMapData() does.
 *
 * window.SailzShowcaseMap(mountEl, opts) -> controller
 */
(function () {
  "use strict";

  // The renderer wants PIXI-style integer colours; departments.json holds
  // designer-friendly hex strings.
  function toInt(hex) {
    return parseInt(String(hex).replace("#", ""), 16) || 0xc9a066;
  }

  // Same shape the dashboard uses: split a flat workflow list into Y-shaped
  // branches (a root plus up to two forks) so real agent workflows fan out
  // exactly like the hand-authored decorative ones.
  function chunkToYBranches(items) {
    var out = [];
    for (var i = 0; i < items.length; i += 3) {
      var chunk = items.slice(i, i + 3);
      out.push({ root: chunk[0], forks: chunk.slice(1) });
    }
    return out;
  }

  function normLeaf(x) {
    return typeof x === "string" ? { label: x, detail: x } : x;
  }

  window.SailzShowcaseMap = function (mountEl, opts) {
    opts = opts || {};
    var D = opts.data || {};
    var AGENTS = D.agents || {};
    var DEPARTMENTS = D.departments || [];
    var AGENT_DEPT = D.agentDept || {};
    var onSelect = opts.onSelect || function () {};
    var onHover = opts.onHover || function () {};
    var onFocusChange = opts.onFocusChange || function () {};

    if (typeof PIXI === "undefined" || typeof window.createBrainMap !== "function" || !mountEl) {
      return null;
    }

    var ctl = null;
    // leafId -> {agentId, workflow} so a click on a branch can open the
    // agent that actually owns that workflow.
    var leafOwner = {};
    // department name -> {activeAgents[], dormantAgents[]}
    var deptRoster = {};

    /* ------------------------- roster for a vertical ----------------------- */
    function rosterOf(bp) {
      var out = [];
      if (!bp) return out;
      if (bp.primary) out.push({ id: bp.primary, dormant: false });
      if (bp.coPrimary) out.push({ id: bp.coPrimary, dormant: false });
      (bp.agents || []).forEach(function (id) {
        if (id !== bp.primary && id !== bp.coPrimary) out.push({ id: id, dormant: false });
      });
      (bp.dormant || []).forEach(function (id) { out.push({ id: id, dormant: true }); });
      return out.filter(function (r) { return AGENTS[r.id]; });
    }

    /* --------------------------- nodes and edges --------------------------- */
    function buildMapData(bp) {
      var nodes = [], edges = [];
      leafOwner = {};
      deptRoster = {};

      var roster = rosterOf(bp);
      roster.forEach(function (r) {
        var dept = AGENT_DEPT[r.id];
        if (!dept) return;
        if (!deptRoster[dept]) deptRoster[dept] = { active: [], dormant: [] };
        deptRoster[dept][r.dormant ? "dormant" : "active"].push(r.id);
      });

      DEPARTMENTS.forEach(function (def) {
        var mine = deptRoster[def.name] || { active: [], dormant: [] };
        var hasActive = mine.active.length > 0;
        var hasDormant = mine.dormant.length > 0;

        nodes.push({
          id: def.name,
          kind: "hub",
          label: def.name,
          sub: def.sub,
          glyph: def.glyph,
          color: toInt(def.color),
          // Identical semantics to the dashboard: lit when a real agent runs
          // here, dim-with-a-plus when one could be switched on, decorative
          // when this vertical has nothing here at all.
          state: hasActive ? "active" : hasDormant ? "dormant" : "empty",
        });

        // Real agent workflows become branches, appended to the decorative
        // ones, exactly as buildDeptDefs() does on the dashboard.
        var branches = (def.branches || []).slice();
        var realSkill = {};
        mine.active.concat(mine.dormant).forEach(function (agentId) {
          var a = AGENTS[agentId];
          if (!a) return;
          (a.workflows || []).forEach(function (w) { realSkill[w.label] = agentId; });
          branches = branches.concat(chunkToYBranches(a.workflows || []));
        });

        var nB = branches.length || 1;
        branches.forEach(function (branchDef, bi) {
          var branchFrac = nB === 1 ? 0.5 : bi / (nB - 1);
          var rootLabel = normLeaf(branchDef.root).label;
          var rootId = def.name + "::" + rootLabel;
          pushLeaf(def, mine, realSkill, nodes, rootId, rootLabel, branchFrac, 0, 110);
          edges.push({ from: def.name, to: rootId });

          (branchDef.forks || []).forEach(function (fork, fi) {
            var forkLabel = normLeaf(fork).label;
            var forkId = def.name + "::" + forkLabel;
            pushLeaf(def, mine, realSkill, nodes, forkId, forkLabel, branchFrac,
                     (fi % 2 === 0 ? 1 : -1) * 0.13, 185);
            edges.push({ from: rootId, to: forkId });
          });
        });
      });

      return { nodes: nodes, edges: edges };
    }

    function pushLeaf(def, mine, realSkill, nodes, id, label, branchFrac, forkOffset, dist) {
      var agentId = realSkill[label];
      var isReal = !!agentId;
      var isDormant = isReal && mine.dormant.indexOf(agentId) !== -1;
      if (isReal) leafOwner[id] = { agentId: agentId, workflow: label };
      nodes.push({
        id: id, kind: "leaf", hubId: def.name, label: label,
        branchFrac: branchFrac, forkOffset: forkOffset, dist: dist,
        state: !isReal ? "placeholder" : isDormant ? "paused" : "live",
      });
    }

    /* ------------------------------- create -------------------------------- */
    function create(bp) {
      var data = buildMapData(bp);
      try {
        ctl = window.createBrainMap(mountEl, {
          nodes: data.nodes,
          edges: data.edges,
          options: {
            theme: "dark",
            // The dashboard map fills the window; the site's lives in a
            // bounded card, so it sizes to its own container instead.
            resizeTo: mountEl,
            onHubClick: function (hubId) {
              if (opts.ambient) return;
              var mine = deptRoster[hubId] || { active: [], dormant: [] };
              var all = mine.active.concat(mine.dormant);
              // A department with exactly one agent opens that agent
              // directly, same one-click behaviour the dashboard has.
              if (all.length === 1) { onSelect(all[0], hubId); return; }
              onSelect(null, hubId);
            },
            onNodeClick: function (hubId, leafId) {
              if (opts.ambient) return;
              var owner = leafOwner[leafId];
              onSelect(owner ? owner.agentId : null, hubId, owner ? owner.workflow : null);
            },
            onHover: function (payload) { if (!opts.ambient) onHover(payload); },
            onFocusChange: function (hubId) { if (!opts.ambient) onFocusChange(hubId); },
          },
        });
      } catch (e) {
        ctl = null;
      }
      return ctl;
    }

    if (!create(opts.blueprint)) return null;

    /* --------------------------------- api --------------------------------- */
    return {
      // Switching vertical changes which departments are lit and which
      // branches exist, so the whole map is rebuilt. rebuildHub() only
      // handles one hub at a time and every hub can change here.
      setBlueprint: function (bp) {
        if (ctl) ctl.destroy();
        create(bp);
      },
      // Frame the department a given agent lives in, and its workflow if
      // one was named.
      focusAgent: function (agentId, workflow) {
        if (!ctl) return;
        var dept = AGENT_DEPT[agentId];
        if (!dept) return;
        if (workflow) {
          var leafId = dept + "::" + workflow;
          if (leafOwner[leafId]) { ctl.focusNode(dept, leafId); return; }
        }
        ctl.focusHub(dept);
      },
      focusDept: function (dept) { if (ctl) ctl.focusHub(dept); },
      back: function () { if (ctl) ctl.back(); },
      next: function () { if (ctl) ctl.next(); },
      prev: function () { if (ctl) ctl.prev(); },
      getFocused: function () { return ctl ? ctl.getFocused() : null; },
      setPanelOpen: function (open) { if (ctl) ctl.setPanelOpen(open); },
      resize: function () { if (ctl) ctl.resize(); },
      view: function () { return ctl ? ctl.view : null; },
      destroy: function () { if (ctl) { ctl.destroy(); ctl = null; } },
    };
  };
})();
