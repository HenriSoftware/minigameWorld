/* Pixel Arcade - single-file app logic (no dependencies)
   - Router between menu and minigames
   - 3 games:
     1) BYTE RUNNER (canvas endless dodge)
     2) NEON CLICKER (idle/clicker loop)
     3) GLITCH REACT (reaction/streak loop)
*/

(() => {
  "use strict";

  // ---------- Utilities ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => performance.now();

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    }
  };

  // "Sound" toggle is purely UI here (no audio files). Kept to extend later.
  const sound = {
    enabled: store.get("px_sound", false),
    set(v){
      this.enabled = !!v;
      store.set("px_sound", this.enabled);
      updateSoundChip();
    }
  };

  // ---------- DOM ----------
  const screenMenu = $("#screenMenu");
  const screenGame = $("#screenGame");
  const gameHost = $("#gameHost");

  const btnHome = $("#btnHome");
  const btnBack = $("#btnBack");
  const btnRestart = $("#btnRestart");
  const btnPause = $("#btnPause");
  const btnMute = $("#btnMute");

  const gameTitle = $("#gameTitle");
  const gameSubtitle = $("#gameSubtitle");

  const bestRunnerTag = $("#bestRunnerTag");
  const bestClickerTag = $("#bestClickerTag");
  const bestReactTag = $("#bestReactTag");

  function showScreen(which){
    const menu = which === "menu";
    screenMenu.classList.toggle("screen--active", menu);
    screenGame.classList.toggle("screen--active", !menu);
  }

  function setHeader(title, subtitle){
    gameTitle.textContent = title;
    gameSubtitle.textContent = subtitle;
  }

  function updateSoundChip(){
    btnMute.setAttribute("aria-pressed", String(sound.enabled));
    btnMute.textContent = `Sound: ${sound.enabled ? "ON" : "OFF"}`;
  }
  updateSoundChip();

  // ---------- Global Game Shell controls ----------
  let activeGame = null;

  function mountGame(gameId){
    if (activeGame?.unmount) activeGame.unmount();
    gameHost.innerHTML = "";

    activeGame = games[gameId];
    if (!activeGame) return;

    setHeader(activeGame.title, activeGame.subtitle);
    activeGame.mount(gameHost);

    btnPause.disabled = !activeGame.togglePause;
    btnPause.setAttribute("aria-pressed", "false");
    btnPause.textContent = "Pause";

    showScreen("game");
    refreshMenuBadges();
  }

  function backToMenu(){
    if (activeGame?.unmount) activeGame.unmount();
    activeGame = null;
    gameHost.innerHTML = "";
    showScreen("menu");
    refreshMenuBadges();
  }

  btnHome.addEventListener("click", backToMenu);
  btnBack.addEventListener("click", backToMenu);

  btnRestart.addEventListener("click", () => {
    activeGame?.restart?.();
    refreshMenuBadges();
  });

  btnPause.addEventListener("click", () => {
    if (!activeGame?.togglePause) return;
    const paused = activeGame.togglePause();
    btnPause.setAttribute("aria-pressed", String(paused));
    btnPause.textContent = paused ? "Resume" : "Pause";
  });

  btnMute.addEventListener("click", () => sound.set(!sound.enabled));

  // Menu cards
  $$(".card").forEach(card => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-open");
      mountGame(id);
    });
  });

  // ---------- Shared UI builders ----------
  function el(tag, className, attrs = {}){
    const n = document.createElement(tag);
    if (className) n.className = className;
    for (const [k,v] of Object.entries(attrs)){
      if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else n.setAttribute(k, v);
    }
    return n;
  }

  function makeHud(leftPills, rightPills){
    const hud = el("div", "hud");
    const left = el("div", "hud__left");
    const right = el("div", "hud__right");

    leftPills.forEach(p => left.appendChild(p));
    rightPills.forEach(p => right.appendChild(p));

    hud.append(left, right);
    return hud;
  }

  function pill(text, cls=""){
    return el("div", `pill ${cls}`.trim(), { text });
  }

  // ---------- GAME 1: BYTE RUNNER ----------
  function createByteRunner(){
    const KEY = "px_best_runner";
    let best = store.get(KEY, 0);

    let root = null;
    let canvas, ctx;
    let raf = 0;

    // game state
    let running = false;
    let paused = false;
    let alive = true;

    const W = 360; // internal resolution for crisp pixel look
    const H = 480;

    const lanes = 3;
    const laneX = (i) => (W * (0.2 + i * 0.3)); // positions 20%, 50%, 80%
    let playerLane = 1;

    let lastT = 0;
    let tAcc = 0;

    let speed = 110;           // pixels/sec baseline
    let speedGain = 10;        // grows over time
    let score = 0;
    let distance = 0;

    let obstacles = [];        // {lane, y, h}
    let spawnTimer = 0;
    let spawnEvery = 0.85;     // seconds, decreases gradually

    // input
    let pointerDown = null;

    function reset(){
      running = true;
      paused = false;
      alive = true;

      playerLane = 1;

      lastT = 0;
      tAcc = 0;

      speed = 110;
      score = 0;
      distance = 0;

      obstacles = [];
      spawnTimer = 0;
      spawnEvery = 0.85;

      draw(0); // immediate render
    }

    function togglePause(){
      if (!running) return true;
      paused = !paused;
      return paused;
    }

    function stop(){
      running = false;
      paused = false;
      cancelAnimationFrame(raf);
      raf = 0;
    }

    function spawnObstacle(){
      const lane = Math.floor(Math.random() * lanes);
      const h = 18 + Math.floor(Math.random() * 18);
      obstacles.push({ lane, y: -h, h });
    }

    function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh){
      return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    }

    function update(dt){
      if (!alive) return;

      // ramp difficulty
      distance += speed * dt;
      speed += speedGain * dt;
      spawnEvery = clamp(0.85 - (distance / 80000), 0.35, 0.85);

      // scoring: smooth and satisfying
      score += (12 + speed * 0.05) * dt;

      // spawn
      spawnTimer += dt;
      if (spawnTimer >= spawnEvery){
        spawnTimer = 0;
        spawnObstacle();
        // occasional second obstacle for spike moments (rare)
        if (Math.random() < 0.10 && distance > 2000) spawnObstacle();
      }

      // move obstacles
      obstacles.forEach(o => { o.y += speed * dt; });

      // cull
      obstacles = obstacles.filter(o => o.y < H + 60);

      // collision
      const px = laneX(playerLane) - 14;
      const py = H - 70;
      const pw = 28;
      const ph = 28;

      for (const o of obstacles){
        const ox = laneX(o.lane) - 18;
        const oy = o.y;
        const ow = 36;
        const oh = o.h;
        if (rectsOverlap(px, py, pw, ph, ox, oy, ow, oh)){
          alive = false;
          best = Math.max(best, Math.floor(score));
          store.set(KEY, best);
          break;
        }
      }
    }

    function draw(dt){
      if (!ctx) return;

      // background
      ctx.clearRect(0,0,W,H);
      ctx.fillStyle = "#05060b";
      ctx.fillRect(0,0,W,H);

      // subtle gradient
      const g = ctx.createLinearGradient(0,0,0,H);
      g.addColorStop(0, "rgba(124,247,255,0.10)");
      g.addColorStop(0.5, "rgba(167,139,250,0.08)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0,0,W,H);

      // lanes
      ctx.globalAlpha = 0.7;
      for (let i=0;i<lanes;i++){
        const x = laneX(i);
        ctx.fillStyle = "rgba(232,240,255,0.10)";
        for (let y=0; y<H; y+=24){
          ctx.fillRect(x-1, y + ((Math.floor(distance/18)+i)%2)*10, 2, 10);
        }
      }
      ctx.globalAlpha = 1;

      // obstacles
      for (const o of obstacles){
        const x = laneX(o.lane);
        const y = o.y;

        // body
        ctx.fillStyle = "rgba(251,113,133,0.95)";
        ctx.fillRect(x-18, y, 36, o.h);

        // highlight pixel strip
        ctx.fillStyle = "rgba(255,255,255,0.30)";
        ctx.fillRect(x-18, y, 6, o.h);
      }

      // player
      const px = laneX(playerLane);
      const py = H - 70;

      ctx.fillStyle = "rgba(124,247,255,0.95)";
      ctx.fillRect(px-14, py, 28, 28);

      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillRect(px-14, py, 6, 28);

      // HUD overlay inside canvas (pixel font look)
      ctx.fillStyle = "rgba(232,240,255,0.85)";
      ctx.font = "10px monospace";
      ctx.fillText(`SCORE ${Math.floor(score)}`, 12, 18);
      ctx.fillText(`BEST  ${best}`, 12, 32);

      // status
      if (!alive){
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0,0,W,H);

        ctx.fillStyle = "rgba(232,240,255,0.95)";
        ctx.font = "bold 16px monospace";
        ctx.fillText("GAME OVER", 110, 210);

        ctx.font = "12px monospace";
        ctx.fillText("Press Restart (or Enter)", 82, 236);
      } else if (paused){
        ctx.fillStyle = "rgba(0,0,0,0.40)";
        ctx.fillRect(0,0,W,H);
        ctx.fillStyle = "rgba(232,240,255,0.95)";
        ctx.font = "bold 16px monospace";
        ctx.fillText("PAUSED", 132, 230);
      }
    }

    function loop(t){
      if (!running){
        draw(0);
        return;
      }
      raf = requestAnimationFrame(loop);

      if (!lastT) lastT = t;
      const dt = Math.min(0.05, (t - lastT) / 1000);
      lastT = t;

      if (!paused && alive){
        update(dt);
      }
      draw(dt);
    }

    function moveLane(dir){
      if (!alive) return;
      playerLane = clamp(playerLane + dir, 0, lanes-1);
    }

    function onKey(e){
      if (e.repeat) return;

      if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") moveLane(-1);
      if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") moveLane(+1);

      if (e.key === "Enter") {
        if (!alive) reset();
      }

      if (e.key === " "){
        e.preventDefault();
        togglePause();
      }
    }

    function onPointerDown(ev){
      const p = pointerPoint(ev);
      pointerDown = { x: p.x, y: p.y, t: now() };
    }
    function onPointerUp(ev){
      if (!pointerDown) return;
      const p = pointerPoint(ev);
      const dx = p.x - pointerDown.x;
      const dy = p.y - pointerDown.y;
      const dt = now() - pointerDown.t;

      pointerDown = null;

      // swipe left/right
      if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy) && dt < 400){
        moveLane(dx < 0 ? -1 : +1);
      }
    }
    function pointerPoint(ev){
      const e = ev.touches ? ev.touches[0] : ev;
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // UI mount
    function mount(host){
      root = el("div","stack");

      const hud = makeHud(
        [pill("BYTE RUNNER", "pill--good"), pill(`BEST ${best}`)],
        [pill("← → / A D", "pill--warn"), pill("Swipe", "pill--warn")]
      );

      const wrap = el("div","canvasWrap");
      canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      ctx = canvas.getContext("2d", { alpha: false });

      wrap.appendChild(canvas);

      const touch = el("div","touchBar");
      const leftBtn = el("button","touchBtn",{ type:"button", text:"LEFT" });
      const rightBtn = el("button","touchBtn",{ type:"button", text:"RIGHT" });
      leftBtn.addEventListener("click", () => moveLane(-1));
      rightBtn.addEventListener("click", () => moveLane(+1));
      touch.append(leftBtn, rightBtn);

      const tip = el("div","note", { html: `
        <div class="note__title">Loop Design</div>
        <div style="color: var(--muted); font-size:12px; line-height:1.7;">
          The game is intentionally minimal: quick deaths, instant restarts, and steadily rising speed.
          Your best score is saved locally.
        </div>
      `});

      root.append(hud, wrap, touch, tip);
      host.appendChild(root);

      // listeners
      window.addEventListener("keydown", onKey);
      canvas.addEventListener("pointerdown", onPointerDown, { passive:true });
      canvas.addEventListener("pointerup", onPointerUp, { passive:true });
      canvas.addEventListener("touchstart", onPointerDown, { passive:true });
      canvas.addEventListener("touchend", onPointerUp, { passive:true });

      reset();
      stop();
      running = true;
      raf = requestAnimationFrame(loop);
    }

    function unmount(){
      stop();
      window.removeEventListener("keydown", onKey);
      if (canvas){
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("touchstart", onPointerDown);
        canvas.removeEventListener("touchend", onPointerUp);
      }
      root = null; canvas = null; ctx = null;
    }

    return {
      id: "runner",
      title: "BYTE RUNNER",
      subtitle: "Endless lane dodge • speed ramps • instant restarts",
      mount, unmount,
      restart: reset,
      togglePause
    };
  }

  // ---------- GAME 2: NEON CLICKER ----------
  function createNeonClicker(){
    const KEY = "px_clicker_state";
    const state = store.get(KEY, {
      bits: 0,
      total: 0,
      bpc: 1,          // bits per click
      bps: 0,          // bits per second
      upgrades: { core: 0, drip: 0, crit: 0 }
    });

    let root = null;
    let tickTimer = 0;
    let raf = 0;
    let last = 0;
    let paused = false;

    const upgradeDefs = [
      {
        id:"core",
        title:"Core Boost",
        desc:"+1 bits per click",
        base: 25,
        mult: 1.22,
        buy(){
          state.upgrades.core++;
          state.bpc += 1;
        }
      },
      {
        id:"drip",
        title:"Background Drip",
        desc:"+1 bits per second",
        base: 60,
        mult: 1.28,
        buy(){
          state.upgrades.drip++;
          state.bps += 1;
        }
      },
      {
        id:"crit",
        title:"Glitch Crit",
        desc:"More critical clicks (bigger spikes)",
        base: 120,
        mult: 1.35,
        buy(){
          state.upgrades.crit++;
        }
      }
    ];

    const calcCost = (u) => {
      const lvl = state.upgrades[u.id] || 0;
      return Math.floor(u.base * Math.pow(u.mult, lvl));
    };

    function save(){ store.set(KEY, state); }
    function togglePause(){ paused = !paused; return paused; }

    function addBits(n){
      state.bits += n;
      state.total += n;
      save();
      render();
      refreshMenuBadges();
    }

    function clickGain(){
      const critChance = clamp(0.08 + state.upgrades.crit * 0.02, 0.08, 0.40);
      const crit = Math.random() < critChance;
      const mult = crit ? (3 + Math.min(4, state.upgrades.crit)) : 1;
      return { gain: state.bpc * mult, crit };
    }

    function loop(t){
      raf = requestAnimationFrame(loop);
      if (!last) last = t;
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;

      if (paused) return;

      // passive income
      tickTimer += dt;
      if (tickTimer >= 0.2){
        const steps = Math.floor(tickTimer / 0.2);
        tickTimer -= steps * 0.2;
        const gain = (state.bps * 0.2) * steps;
        if (gain > 0){
          state.bits += gain;
          state.total += gain;
          save();
          render();
          refreshMenuBadges();
        }
      }
    }

    // DOM refs
    let bitsEl, bpcEl, bpsEl, burstEl, listEl;

    function render(){
      if (!root) return;
      const bits = Math.floor(state.bits);
      bitsEl.textContent = `${bits.toLocaleString()} bits`;
      bpcEl.textContent = `${state.bpc} / click`;
      bpsEl.textContent = `${state.bps} / sec`;

      // shop list
      listEl.innerHTML = "";
      for (const u of upgradeDefs){
        const cost = calcCost(u);
        const can = state.bits >= cost;

        const item = el("div","listItem");
        const meta = el("div","listItem__meta");
        meta.append(
          el("div","listItem__title",{ text: `${u.title} (Lv ${state.upgrades[u.id] || 0})` }),
          el("div","listItem__desc",{ text: `${u.desc} • Cost: ${cost.toLocaleString()} bits` })
        );

        const btn = el("button","buyBtn",{ type:"button", text: can ? "BUY" : "NEED MORE" });
        btn.disabled = !can;
        btn.addEventListener("click", () => {
          const c = calcCost(u);
          if (state.bits < c) return;
          state.bits -= c;
          u.buy();
          save();
          render();
          refreshMenuBadges();
        });

        item.append(meta, btn);
        listEl.appendChild(item);
      }
    }

    function restart(){
      state.bits = 0;
      state.total = 0;
      state.bpc = 1;
      state.bps = 0;
      state.upgrades = { core: 0, drip: 0, crit: 0 };
      save();
      render();
      refreshMenuBadges();
    }

    function mount(host){
      root = el("div","stack");

      const hud = makeHud(
        [pill("NEON CLICKER","pill--good"), pill("Infinite progression")],
        [pill("Tap / Click","pill--warn"), pill("Buy upgrades","pill--warn")]
      );

      const wrap = el("div","shop");

      // Left: Click button + stats
      const left = el("div","stack");

      const stats = el("div","hud");
      bitsEl = el("div","pill pill--good",{ text:"0 bits" });
      bpcEl = el("div","pill",{ text:"1 / click" });
      bpsEl = el("div","pill",{ text:"0 / sec" });
      stats.append(
        el("div","hud__left"), el("div","hud__right")
      );
      stats.firstChild.append(bitsEl);
      stats.lastChild.append(bpcEl, bpsEl);

      const btn = el("button","bigBtn",{ type:"button", text:"GENERATE BITS" });
      burstEl = el("div","note",{ html: `
        <div class="note__title">Satisfying Loop</div>
        <div style="color: var(--muted); font-size:12px; line-height:1.7;">
          Click for spikes. Add passive income. Keep it minimal, keep it addictive.
        </div>
      `});

      btn.addEventListener("click", () => {
        const { gain, crit } = clickGain();
        addBits(gain);
        // micro feedback text
        burstEl.querySelector("div:last-child").textContent =
          crit ? `CRIT! +${gain} bits` : `+${gain} bits`;
      });

      left.append(stats, btn, burstEl);

      // Right: Shop
      const right = el("div","stack");
      right.append(el("div","note",{ html: `
        <div class="note__title">Upgrades</div>
        <div style="color: var(--muted); font-size:12px; line-height:1.7;">
          Costs scale smoothly to keep the loop going.
        </div>
      `}));

      const list = el("div","list");
      listEl = list;
      right.append(list);

      wrap.append(left, right);
      root.append(hud, wrap);
      host.appendChild(root);

      // start ticking
      paused = false;
      tickTimer = 0;
      last = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);

      render();
    }

    function unmount(){
      cancelAnimationFrame(raf);
      raf = 0;
      root = null;
    }

    return {
      id: "clicker",
      title: "NEON CLICKER",
      subtitle: "Clicks + upgrades • idle drip • infinite scaling",
      mount, unmount,
      restart,
      togglePause
    };
  }

  // ---------- GAME 3: GLITCH REACT ----------
  function createGlitchReact(){
    const KEY = "px_best_react";
    let best = store.get(KEY, 0);

    let root = null;
    let paused = false;

    // state
    let live = false;
    let streak = 0;
    let timeLeft = 1.5;      // shrinks over time
    let timer = 0;
    let targetIndex = 0;     // 0..3
    let raf = 0;
    let last = 0;

    // DOM
    let streakEl, bestEl, timeEl, msgEl;
    let pads = [];

    const keys = ["h","j","k","l"];

    function saveBest(){
      best = Math.max(best, streak);
      store.set(KEY, best);
    }

    function newTarget(){
      const next = Math.floor(Math.random() * 4);
      targetIndex = next;
      timer = 0;
      timeLeft = clamp(1.55 - streak * 0.03, 0.55, 1.55);
      render();
    }

    function hit(i){
      if (!live || paused) return;

      if (i === targetIndex){
        streak++;
        msgEl.textContent = "Perfect.";
        newTarget();
      } else {
        // fail
        msgEl.textContent = "Miss.";
        end();
      }
    }

    function end(){
      live = false;
      saveBest();
      render();
      refreshMenuBadges();
    }

    function start(){
      live = true;
      streak = 0;
      msgEl.textContent = "Focus.";
      newTarget();
      render();
    }

    function restart(){
      start();
    }

    function togglePause(){
      paused = !paused;
      return paused;
    }

    function onKey(e){
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      const idx = keys.indexOf(k);
      if (idx >= 0) hit(idx);
      if (k === "enter" && !live) start();
    }

    function loop(t){
      raf = requestAnimationFrame(loop);
      if (!last) last = t;
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;

      if (!live || paused) return;

      timer += dt;
      if (timer >= timeLeft){
        msgEl.textContent = "Too slow.";
        end();
      } else {
        render();
      }
    }

    function render(){
      if (!root) return;

      streakEl.textContent = `Streak: ${streak}`;
      bestEl.textContent = `Best: ${best}`;

      const remaining = live ? Math.max(0, timeLeft - timer) : 0;
      timeEl.textContent = live
        ? `Time: ${remaining.toFixed(2)}s`
        : `Time: —`;

      pads.forEach((p, i) => p.classList.toggle("pad--active", live && i === targetIndex));
    }

    function mount(host){
      root = el("div","stack");

      const hud = makeHud(
        [pill("GLITCH REACT","pill--good"), pill("H J K L / Tap pads","pill--warn")],
        [pill("Streak chasing","pill--warn")]
      );

      const stats = el("div","hud");
      const left = el("div","hud__left");
      const right = el("div","hud__right");

      streakEl = pill("Streak: 0","pill--good");
      bestEl = pill(`Best: ${best}`);
      timeEl = pill("Time: —","pill--warn");

      left.append(streakEl, timeEl);
      right.append(bestEl);

      stats.append(left, right);

      const note = el("div","note",{ html: `
        <div class="note__title">How it works</div>
        <div style="color: var(--muted); font-size:12px; line-height:1.7;">
          A highlighted pad appears. Hit the matching key (<strong>H</strong>/<strong>J</strong>/<strong>K</strong>/<strong>L</strong>)
          before the timer runs out. The window shrinks as your streak grows.
        </div>
      `});

      msgEl = el("div","note",{ html: `
        <div class="note__title">Status</div>
        <div style="color: var(--muted); font-size:12px; line-height:1.7;">Press Enter to start.</div>
      `}).querySelector("div:last-child");

      const padsWrap = el("div","reactPads");
      pads = [];
      for (let i=0;i<4;i++){
        const p = el("div","pad",{ role:"button", tabindex:"0" });
        p.append(
          el("div","pad__key",{ text: keys[i].toUpperCase() }),
          el("div","pad__hint",{ text: "tap" })
        );
        p.addEventListener("click", () => hit(i));
        p.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") hit(i);
        });
        pads.push(p);
        padsWrap.appendChild(p);
      }

      root.append(hud, stats, padsWrap, note, msgEl.parentElement);
      host.appendChild(root);

      window.addEventListener("keydown", onKey);

      paused = false;
      live = false;
      last = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);

      render();
    }

    function unmount(){
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
      raf = 0;
      root = null;
      pads = [];
    }

    return {
      id: "react",
      title: "GLITCH REACT",
      subtitle: "Reflex loop • shrinking timing window • streak-based",
      mount, unmount,
      restart,
      togglePause
    };
  }

  // ---------- Registry ----------
  const games = {
    runner: createByteRunner(),
    clicker: createNeonClicker(),
    react: createGlitchReact()
  };

  function refreshMenuBadges(){
    const runnerBest = store.get("px_best_runner", 0);
    bestRunnerTag.textContent = `Best: ${runnerBest}`;

    const clickerState = store.get("px_clicker_state", { total: 0 });
    bestClickerTag.textContent = `Bits: ${Math.floor(clickerState.total || 0).toLocaleString()}`;

    const reactBest = store.get("px_best_react", 0);
    bestReactTag.textContent = `Best: ${reactBest}`;
  }
  refreshMenuBadges();

  // Start on menu
  showScreen("menu");
})();
