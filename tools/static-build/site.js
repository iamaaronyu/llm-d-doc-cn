(function () {
  var root = window.__ROOT__ || '.';
  // 移动端导航抽屉
  var btn = document.getElementById('menu-btn'), side = document.getElementById('sidebar'), scrim = document.getElementById('scrim');
  function setNav(open) {
    side.classList.toggle('open', open); scrim.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (btn) btn.addEventListener('click', function () { setNav(!side.classList.contains('open')); });
  if (scrim) scrim.addEventListener('click', function () { setNav(false); });
  var cur = side && side.querySelector('[aria-current="page"]');
  if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block: 'center' }); window.scrollTo(0, 0); } catch (e) {} }

  // 复制代码
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button.copy');
    if (!b) return;
    var code = b.closest('.codeblock').querySelector('code');
    var text = code.innerText;
    function done(ok) { b.textContent = ok ? '已复制' : '请手动复制'; setTimeout(function () { b.textContent = '复制'; }, 1600); }
    try {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { selectCode(code); done(false); });
    } catch (err) { selectCode(code); done(false); }
  });
  function selectCode(el) { var r = document.createRange(); r.selectNodeContents(el); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }

  // 本页目录高亮
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var map = {};
    tocLinks.forEach(function (a) { map[decodeURIComponent(a.getAttribute('href').slice(1))] = a; });
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting && map[en.target.id]) { tocLinks.forEach(function (a) { a.classList.remove('on'); }); map[en.target.id].classList.add('on'); }
      });
    }, { rootMargin: '-70px 0px -70% 0px' });
    Object.keys(map).forEach(function (id) { var h = document.getElementById(id); if (h) obs.observe(h); });
  }

  // 站内搜索（标题、小节与正文的子串匹配，支持中文）
  var input = document.getElementById('search-input'), box = document.getElementById('search-results');
  if (!input) return;
  var sel = -1;
  function escHtml(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function mark(s, q) { var i = s.toLowerCase().indexOf(q); return i < 0 ? escHtml(s) : escHtml(s.slice(0, i)) + '<mark>' + escHtml(s.slice(i, i + q.length)) + '</mark>' + escHtml(s.slice(i + q.length)); }
  function search(q) {
    var idx = window.__SEARCH__ || [], res = [];
    q = q.trim().toLowerCase();
    if (!q) return res;
    var terms = q.split(/\s+/);
    idx.forEach(function (d) {
      var score = 0, hit = null, tl = d.t.toLowerCase(), xl = d.x.toLowerCase();
      for (var k = 0; k < terms.length; k++) {
        var t = terms[k], s = 0;
        if (tl.indexOf(t) >= 0) s += 10;
        for (var j = 0; j < d.h.length; j++) if (d.h[j][0].toLowerCase().indexOf(t) >= 0) { s += 5; if (!hit) hit = d.h[j]; break; }
        if (xl.indexOf(t) >= 0) s += 1;
        if (!s) return;
        score += s;
      }
      var pos = xl.indexOf(terms[0]), snip = '';
      if (pos >= 0) { var st = Math.max(0, pos - 24); snip = (st ? '…' : '') + d.x.slice(st, pos + 60); }
      res.push({ d: d, score: score, hit: hit, snip: snip });
    });
    return res.sort(function (a, b) { return b.score - a.score; }).slice(0, 12);
  }
  function render() {
    var q = input.value, res = search(q), ql = q.trim().split(/\s+/)[0].toLowerCase();
    sel = -1;
    if (!q.trim()) { box.hidden = true; return; }
    box.innerHTML = res.length ? res.map(function (r) {
      var href = root + '/' + r.d.u + (r.hit ? '#' + r.hit[1] : '');
      return '<a href="' + escHtml(href) + '"><b>' + mark(r.d.t, ql) + (r.hit ? ' › ' + mark(r.hit[0], ql) : '') + '</b><small>' + mark(r.snip, ql) + '</small></a>';
    }).join('') : '<div class="search-empty">没有找到与“' + escHtml(q) + '”相关的内容</div>';
    box.hidden = false;
  }
  input.addEventListener('input', render);
  input.addEventListener('focus', function () { if (input.value.trim()) render(); });
  input.addEventListener('keydown', function (e) {
    var items = box.querySelectorAll('a');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach(function (a, i) { a.classList.toggle('sel', i === sel); });
    } else if (e.key === 'Enter') {
      var t = items[sel >= 0 ? sel : 0]; if (t) location.href = t.getAttribute('href');
    } else if (e.key === 'Escape') { box.hidden = true; input.blur(); }
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.search')) box.hidden = true; });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== input && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); }
  });
})();
