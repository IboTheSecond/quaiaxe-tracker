/**
 * assets/page.js - the two small behaviours of the page shell, as a classic script (no modules, no storage):
 *   1. reveal on scroll for the .rv sections. It fails open: no IntersectionObserver, reduced motion, or a 2.5 s
 *      backstop shows everything, so content is never trapped behind an event that may not fire.
 *   2. the block height in the header: one JSON-RPC call (quai_blockNumber) to the RPC URL in the page's own
 *      config block, every 12 s while the tab is visible.
 * It sets no cookies and keeps nothing in the browser's own storage.
 */
(function () {
  'use strict';
  var root = document.documentElement;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var el = function (id) { return document.getElementById(id); };
  var loc = function () { return root.lang === 'tr' ? 'tr-TR' : 'en-US'; };

  // ---------- reveal on scroll ----------
  var rv = [].slice.call(document.querySelectorAll('.rv'));
  function showAll() { rv.forEach(function (n) { n.classList.add('in'); }); }
  if (rv.length) {
    if (reduce || !('IntersectionObserver' in window)) {
      showAll();
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e, i) {
          if (!e.isIntersecting) return;
          var t = e.target;
          setTimeout(function () { t.classList.add('in'); }, Math.min(i * 70, 210));
          io.unobserve(t);
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
      rv.forEach(function (n) { io.observe(n); });
      setTimeout(showAll, 2500);
    }
  }

  // ---------- header block height ----------
  var RPC = null;
  try { RPC = JSON.parse(el('trk-config').textContent).rpc || null; } catch (e) { RPC = null; }

  // Count up to a new figure instead of snapping to it. Skipped entirely under reduced motion.
  function countTo(node, from, to, fmt) {
    if (reduce || from === to) { node.textContent = fmt(to); return; }
    var t0 = performance.now();
    var dur = 700;
    (function step(now) {
      var p = Math.min(1, (now - t0) / dur);
      var ease = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(Math.round(from + (to - from) * ease));
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  if (RPC && el('height')) {
    var lastHeight = 0;
    var fmtHeight = function (n) { return n.toLocaleString(loc()); };
    var readHeight = function () {
      if (document.hidden && lastHeight) return;
      fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'quai_blockNumber', params: [] }),
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j || !j.result) throw new Error('no height');
          var h = Number(BigInt(j.result));
          if (el('beat')) el('beat').classList.add('live');
          if (h !== lastHeight) {
            if (lastHeight) countTo(el('height'), lastHeight, h, fmtHeight);
            else el('height').textContent = fmtHeight(h);
            lastHeight = h;
          }
        })
        .catch(function () { if (el('beat')) el('beat').classList.remove('live'); });
    };
    readHeight();
    setInterval(readHeight, 12000);
  }
})();
