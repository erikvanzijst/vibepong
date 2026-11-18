import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { appName } from "@/config";

// ---------------------------------------------------------------- constants
const W = 840; // playfield long axis, internal units
const H = 560; // playfield short axis, internal units
const PADDLE_W = 12;
const PADDLE_H = 84;
const BALL = 10;
const WIN_SCORE = 11;

// How far the player's paddle sits from its own wall, in playfield units.
// In portrait the paddle is pushed further in, so a thumb resting at the
// bottom of the screen never covers it.
const PLAYER_X = 22;
const PLAYER_X_PORTRAIT = 88;
const CPU_X = W - 22;

// ---------------------------------------------------------------- sound
// Tiny 8-bit square-wave synth using the Web Audio API (no assets).
let audioCtx: AudioContext | null = null;
let muted = false;

function ensureAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

function beep(
  freq: number,
  dur: number,
  opts: { type?: OscillatorType; vol?: number; slide?: number } = {},
) {
  if (muted) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const { type = "square", vol = 0.18, slide } = opts;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  const t0 = ctx.currentTime;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(slide, 1), t0 + dur);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur);
}

// Composite sound effects composed from simple beeps.
const sfx = {
  paddle() {
    beep(220, 0.05, { type: "square", vol: 0.22, slide: 180 });
  },
  wall() {
    beep(145, 0.04, { type: "square", vol: 0.16, slide: 120 });
  },
  score() {
    beep(140, 0.16, { type: "sawtooth", vol: 0.2, slide: 90 });
    beep(70, 0.24, { type: "square", vol: 0.18, slide: 45 });
  },
  serve() {
    beep(320, 0.06, { type: "square", vol: 0.18, slide: 480 });
  },
  win() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => setTimeout(() => beep(f, 0.12, { vol: 0.2 }), i * 110));
  },
};

type Mode = "attract" | "serve" | "play" | "over";

interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface World {
  vertical: boolean; // portrait: playfield turned a quarter turn
  inset: number; // player's paddle distance from its wall
  mode: Mode;
  difficulty: 1 | 2 | 3;
  pY: number;
  cY: number;
  cAimY: number;
  cReactTimer: number;
  ball: Ball;
  scoreP: number;
  scoreC: number;
  keys: { up: boolean; down: boolean };
  mouseActive: boolean;
  mouseY: number;
  speed: number;
  serveTimer: number;
  flash: number;
  time: number;
}

interface Layout {
  vertical: boolean;
  compact: boolean; // small chrome for phones and short windows
  rail: boolean; // switches beside the screen, for short landscape windows
  pad: number; // bezel thickness
  w: number; // on-screen playfield width in css px
  h: number;
}

// Portrait: the playfield is turned a quarter turn so the player's paddle is
// at the bottom of the screen (Arkanoid style).
const isPortrait = (w: number, h: number) => h > w * 1.05;
// Phones and small windows trade the full marquee and control plate for a
// slim title bar and switch row, which leaves the CRT most of the screen.
const isCompact = (w: number, h: number) => w < 1100 || h < 760;
// A short landscape window (a phone held sideways) has width to spare and
// height to lose, so its switches move to a rail beside the screen.
const hasRail = (w: number, h: number) => !isPortrait(w, h) && h < 560;

const viewport = () =>
  typeof window === "undefined" ? { w: 1280, h: 800 } : { w: window.innerWidth, h: window.innerHeight };

function layoutFor(w: number, h: number, canvasW: number, canvasH: number): Layout {
  const compact = isCompact(w, h);
  return {
    vertical: isPortrait(w, h),
    compact,
    rail: hasRail(w, h),
    pad: compact ? 6 : 14,
    w: canvasW,
    h: canvasH,
  };
}

function initialLayout(): Layout {
  const { w, h } = viewport();
  const vertical = isPortrait(w, h);
  return layoutFor(w, h, vertical ? H : W, vertical ? W : H);
}

// ---------------------------------------------------------------- game
export function HomePage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>(initialLayout);

  const [mode, setMode] = useState<Mode>("attract");
  const [difficulty, setDifficulty] = useState<1 | 2 | 3>(2);
  const [scoreP, setScoreP] = useState(0);
  const [scoreC, setScoreC] = useState(0);
  const [winner, setWinner] = useState<"YOU" | "CPU" | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  // Mutable game world lives in refs (no re-render during the loop)
  const state = useRef<World>({
    vertical: layout.vertical,
    inset: layout.vertical ? PLAYER_X_PORTRAIT : PLAYER_X,
    mode: "attract",
    difficulty: 2,
    pY: H / 2 - PADDLE_H / 2,
    cY: H / 2 - PADDLE_H / 2,
    cAimY: H / 2, // centre of the CPU paddle's (stale) destination, in play units
    cReactTimer: 0,
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
    scoreP: 0,
    scoreC: 0,
    keys: { up: false, down: false },
    mouseActive: false,
    mouseY: H / 2,
    speed: 0,
    serveTimer: 0,
    flash: 0,
    time: 0,
  });

  // Fit the CRT into the space the chrome leaves, keeping the playfield's
  // aspect ratio. The page never scales itself down with a transform, so the
  // canvas is always as large as the window allows.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const fit = () => {
      const { w: vw, h: vh } = viewport();
      const pad = isCompact(vw, vh) ? 6 : 14;
      const vertical = isPortrait(vw, vh);
      const iw = vertical ? H : W;
      const ih = vertical ? W : H;
      const aw = area.clientWidth - pad * 2;
      const ah = area.clientHeight - pad * 2;
      if (aw <= 0 || ah <= 0) return;
      const k = Math.min(aw / iw, ah / ih);
      setLayout(
        layoutFor(vw, vh, Math.max(1, Math.floor(iw * k)), Math.max(1, Math.floor(ih * k))),
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(area);
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
    };
  }, []);

  // Keep the world in step with the layout: same physics turned a quarter
  // turn, with the player's paddle a little further from its wall.
  useLayoutEffect(() => {
    const s = state.current;
    s.vertical = layout.vertical;
    s.inset = layout.vertical ? PLAYER_X_PORTRAIT : PLAYER_X;
  }, [layout.vertical]);

  // ------------------------------------------------------------ controls
  const press = (k: "up" | "down", v: boolean) => {
    state.current.keys[k] = v;
    if (v) {
      state.current.mouseActive = false;
      ensureAudio();
      wakeToServe();
    }
  };
  const wakeToServe = () => {
    const s = state.current;
    allowAudio();
    if (s.mode === "attract" || s.mode === "over") {
      s.scoreP = 0;
      s.scoreC = 0;
      setScoreP(0);
      setScoreC(0);
      setWinner(null);
      beginServe();
      setMode("serve");
      s.mode = "serve";
    }
  };
  const startGame = () => {
    const s = state.current;
    allowAudio();
    s.scoreP = 0;
    s.scoreC = 0;
    setScoreP(0);
    setScoreC(0);
    setWinner(null);
    beginServe();
    setMode("serve");
    s.mode = "serve";
  };
  const beginServe = () => {
    const s = state.current;
    s.mode = "serve";
    s.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
    s.serveTimer = 60;
  };
  const launch = () => {
    const s = state.current;
    if (s.mode !== "serve") return;
    const base = 5.4 + s.difficulty * 0.9;
    s.speed = base; // rally speed resets on every serve, like the original
    const ang = (Math.random() - 0.5) * 0.7;
    const dir = Math.random() < 0.5 ? 1 : -1;
    s.ball.vx = Math.cos(ang) * base * dir;
    s.ball.vy = Math.sin(ang) * base;
    s.mode = "play";
    setMode("play");
    sfx.serve();
  };
  const tapScreen = () => {
    const s = state.current;
    if (s.mode === "attract" || s.mode === "over") wakeToServe();
    else if (s.mode === "serve") launch();
    allowAudio();
  };
  const setDiff = (d: 1 | 2 | 3) => {
    setDifficulty(d);
    state.current.difficulty = d;
    allowAudio();
  };
  const toggleMute = () => {
    muted = !muted;
    setIsMuted(muted);
    allowAudio();
  };
  const allowAudio = () => {
    if (!muted) ensureAudio();
  };

  // keys
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") press("up", true);
      else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") press("down", true);
      else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        launch();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") press("up", false);
      else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") press("down", false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // pointer (mouse + touch): the paddle follows the pointer along the axis it
  // can move on — vertical in landscape, horizontal in portrait. The other
  // axis is ignored, so a finger can rest well below the paddle on a phone.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const move = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const s = state.current;
      s.mouseActive = true;
      const along = s.vertical
        ? ((e.clientX - rect.left) / rect.width) * H
        : ((e.clientY - rect.top) / rect.height) * H;
      s.mouseY = clamp(along, PADDLE_H / 2, H - PADDLE_H / 2);
      s.pY = s.mouseY - PADDLE_H / 2;
    };
    const down = () => tapScreen();
    window.addEventListener("pointermove", move);
    canvas.addEventListener("pointerdown", down);
    return () => {
      window.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerdown", down);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 16.6667, 3);
      last = now;
      const s = state.current;
      step(s, dt);
      draw(ctx, s);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const step = (s: World, dt: number) => {
    const py = 6.4;
    if (s.keys.up) s.pY -= py * dt;
    if (s.keys.down) s.pY += py * dt;
    if (s.mouseActive) {
      s.pY = s.mouseY - PADDLE_H / 2;
    }
    s.pY = clamp(s.pY, 0, H - PADDLE_H);
    s.time = (s.time ?? 0) + dt;

    if (s.mode === "play") {
      const b = s.ball;

      // CPU: act like a human tracking the ball — no future-trajectory
      // prediction. It re-aims at the ball's *current* position only every
      // so often (a reaction delay), with aim error, and moves no faster
      // than the player's paddle can.
      s.cReactTimer -= dt;
      if (s.cReactTimer <= 0) {
        s.cReactTimer = cpuReactInterval(s.difficulty);
        const err = (4 - s.difficulty) * 0.22 * PADDLE_H + (Math.random() - 0.5) * 18;
        s.cAimY = clamp(b.y + err, PADDLE_H / 2, H - PADDLE_H / 2);
      }
      const cpuMax = 4.4 + s.difficulty * 0.6; // always a bit slower than the player
      const dy = s.cAimY - (s.cY + PADDLE_H / 2);
      s.cY += clamp(dy, -cpuMax * dt, cpuMax * dt);

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.y <= 0) {
        b.y = 0;
        b.vy = Math.abs(b.vy);
        sfx.wall();
      } else if (b.y >= H) {
        b.y = H;
        b.vy = -Math.abs(b.vy);
        sfx.wall();
      }

      // player paddle
      if (b.vx < 0 && b.x <= s.inset + PADDLE_W && b.x > s.inset - 6) {
        const cy = s.pY + PADDLE_H / 2;
        if (b.y >= s.pY - BALL / 2 && b.y <= s.pY + PADDLE_H + BALL / 2) {
          const rel = (b.y - cy) / (PADDLE_H / 2);
          const ang = rel * 0.9;
          const speed = bumpSpeed(s);
          b.vx = Math.abs(Math.cos(ang) * speed);
          b.vy = Math.sin(ang) * speed;
          b.x = s.inset + PADDLE_W + 1;
          sfx.paddle();
        }
      }
      // cpu paddle
      if (b.vx > 0 && b.x >= CPU_X - PADDLE_W - BALL && b.x < W - 16) {
        const cy = s.cY + PADDLE_H / 2;
        if (b.y >= s.cY - BALL / 2 && b.y <= s.cY + PADDLE_H + BALL / 2) {
          const rel = (b.y - cy) / (PADDLE_H / 2);
          const ang = rel * 0.9;
          const speed = bumpSpeed(s);
          b.vx = -Math.abs(Math.cos(ang) * speed);
          b.vy = Math.sin(ang) * speed;
          b.x = CPU_X - PADDLE_W - BALL - 1;
          sfx.paddle();
        }
      }

      // scoring
      if (b.x < -BALL * 2) {
        s.scoreC++;
        setScoreC(s.scoreC);
        sfx.score();
        afterPoint(s);
      } else if (b.x > W + BALL * 2) {
        s.scoreP++;
        setScoreP(s.scoreP);
        sfx.score();
        afterPoint(s);
      }
    } else if (s.mode === "attract") {
      // attract: gentle cpu-only demo
      s.cAimY = (Math.sin(s.time * 0.004) * 0.5 + 0.5) * (H - PADDLE_H) + PADDLE_H / 2;
      const dy = s.cAimY - (s.cY + PADDLE_H / 2);
      s.cY += clamp(dy, -3.2 * dt, 3.2 * dt);
    }

    if (s.mode === "serve") {
      s.serveTimer -= dt;
      if (s.serveTimer <= 0) launch();
    }
  };

  const afterPoint = (s: World) => {
    if (s.scoreP >= WIN_SCORE) {
      setWinner("YOU");
      s.mode = "over";
      setMode("over");
      sfx.win();
    } else if (s.scoreC >= WIN_SCORE) {
      setWinner("CPU");
      s.mode = "over";
      setMode("over");
      sfx.win();
    } else {
      beginServe();
      setMode("serve");
    }
  };

  const canvasW = layout.vertical ? H : W;
  const canvasH = layout.vertical ? W : H;
  const off = (d: 1 | 2 | 3) => difficulty === d;
  // A landscape phone has width to spare and height to lose, so its switches
  // move to a rail beside the CRT and the screen keeps the full height.
  const sideRail = layout.rail;
  const touchPad = layout.vertical && layout.compact;

  const mute = (cls: string) => (
    <button
      onClick={toggleMute}
      className={`arcade-solid-btn border-none outline-none ${cls}`}
      aria-label={isMuted ? "Unmute" : "Mute"}
    >
      {isMuted ? "MUT" : "SND"}
    </button>
  );
  const diffPad = (cls: string, dir: "row" | "col" = "row") => (
    <div className={`flex gap-1.5 ${dir === "col" ? "flex-col" : ""}`}>
      {([1, 2, 3] as const).map((d) => (
        <button
          key={d}
          onClick={() => setDiff(d)}
          aria-label={`Difficulty ${d}`}
          className={`arcade-solid-btn border-none outline-none ${cls} ${off(d) ? "on" : ""}`}
        >
          {d}
        </button>
      ))}
    </div>
  );

  return (
    <div
      className="flex h-[100dvh] w-screen flex-col items-center justify-center overflow-hidden bg-[#050402]"
      style={{
        paddingTop: `max(${layout.compact ? 6 : 12}px, env(safe-area-inset-top))`,
        paddingBottom: `max(${layout.compact ? 6 : 12}px, env(safe-area-inset-bottom))`,
        paddingLeft: `max(${layout.compact ? 6 : 12}px, env(safe-area-inset-left))`,
        paddingRight: `max(${layout.compact ? 6 : 12}px, env(safe-area-inset-right))`,
      }}
    >
      <div
        className={`woodgrain-panel relative flex h-full w-full max-w-[1060px] overflow-hidden shadow-[0_30px_80px_rgba(0,0,0,0.8)] ${
          sideRail ? "flex-row" : "flex-col"
        } ${layout.compact ? "rounded-[10px] p-1.5" : "max-h-[900px] rounded-[22px] p-5"}`}
      >
        {/* Marquee */}
        {!sideRail && layout.compact && (
          <header className="flex shrink-0 items-center justify-between px-1 pb-1.5">
            <div className="flex items-center gap-2">
              <h1 className="arcade-marquee-text text-lg">{appName}</h1>
              <span
                className={`coin-op-led h-2 w-2 rounded-full ${mode === "play" ? "on" : "off"}`}
              />
            </div>
            {mute("h-6 w-10 rounded-sm text-[8px]")}
          </header>
        )}
        {!layout.compact && (
          <header className="mb-4 flex shrink-0 items-center justify-between px-3">
            <div className="flex flex-col leading-none">
              <span className="arcade-marquee-text text-[13px]">ATARI</span>
              <span className="mt-1 hidden text-[10px] uppercase tracking-[0.28em] text-[#d9b97a]/80 sm:block">
                Est. 1972 · Coin-Op
              </span>
            </div>
            <h1 className="arcade-marquee-text text-4xl sm:text-5xl">{appName}</h1>
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-2">
                {mute("h-6 w-10 rounded-sm text-[9px]")}
                <span className={`coin-op-led h-3 w-3 rounded-full ${mode === "play" ? "on" : "off"}`} />
                <span className={`coin-op-led h-3 w-3 rounded-full ${winner ? "on" : "off"}`} />
              </div>
              <span className="text-[9px] uppercase tracking-[0.24em] text-[#d9b97a]/70">
                Insert Coin
              </span>
            </div>
          </header>
        )}

        {/* CRT screen, sized to whatever the chrome leaves behind */}
        <main
          ref={areaRef}
          className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center"
        >
          <div
            className={`metal-bezel relative shrink-0 ${layout.compact ? "rounded-[8px]" : "rounded-[18px]"}`}
            style={{ padding: layout.pad }}
          >
            <div
              className="relative overflow-hidden rounded-[4px] bg-black"
              style={{ width: layout.w, height: layout.h }}
            >
              <canvas
                ref={canvasRef}
                width={canvasW}
                height={canvasH}
                className="block h-full w-full"
                style={{ imageRendering: "pixelated", touchAction: "none" }}
              />
              <div className="crt-scanlines pointer-events-none absolute inset-0" />
              <div className="crt-vignette pointer-events-none absolute inset-0" />
              <div className="crt-flicker pointer-events-none absolute inset-0 bg-[rgba(139,255,163,0.02)]" />
            </div>
          </div>

          {/* In portrait the paddle lives at the bottom of the screen; the
              deck left below it is a place to rest the thumb and swipe. */}
          {touchPad && (
            <div
              onPointerDown={tapScreen}
              style={{ touchAction: "none" }}
              className="relative mt-1.5 flex min-h-0 w-full flex-1 flex-col items-center justify-start overflow-hidden rounded-md border-t border-black/40 bg-[#0b0907]/60 pt-2.5"
            >
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-[radial-gradient(ellipse_at_50%_130%,rgba(139,255,163,0.07),transparent_70%)]" />
              <span className="pointer-events-none text-[8px] uppercase tracking-[0.3em] text-[#e8d9b0]/35">
                Swipe left / right
              </span>
            </div>
          )}
        </main>

        {/* Landscape phone: switches stacked beside the screen */}
        {sideRail && (
          <aside className="brushed-aluminum-plate my-0.5 ml-1.5 flex w-11 shrink-0 flex-col items-center justify-between gap-1 rounded-md py-1.5">
            {mute("h-6 w-9 rounded-sm text-[8px]")}
            {diffPad("h-7 w-8 rounded text-[11px]", "col")}
            <button
              onClick={startGame}
              className="arcade-solid-btn h-9 w-9 rounded text-[8px] border-none outline-none"
            >
              START
            </button>
          </aside>
        )}

        {/* Control panel */}
        {!sideRail && layout.compact && (
          <div className="brushed-aluminum-plate mt-1.5 flex shrink-0 items-center justify-between gap-2 rounded-md px-2 py-1.5">
            {diffPad("h-7 w-9 rounded text-[11px]")}
            <div className="flex items-center gap-2">
              <span className="text-[8px] uppercase tracking-[0.24em] text-[#e8d9b0]/55">1P</span>
              <button
                onClick={startGame}
                className="arcade-solid-btn h-7 w-[70px] rounded text-[10px] border-none outline-none"
              >
                START
              </button>
            </div>
          </div>
        )}
        {!sideRail && !layout.compact && (
          <div className="brushed-aluminum-plate mt-5 flex shrink-0 flex-wrap items-center justify-between gap-4 rounded-[16px] p-5">
            <button
              className="arcade-round relative h-16 w-16 select-none border-none outline-none"
              style={{ borderRadius: 9999 }}
              onPointerDown={() => wakeToServe()}
              aria-label="Start"
            />
            <div className="flex flex-col items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.3em] text-[#e8d9b0]/70">
                Difficulty
              </span>
              {diffPad("h-9 w-12 rounded-md text-xs")}
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <button
                onClick={startGame}
                className="arcade-solid-btn h-11 w-24 rounded-md text-xs border-none outline-none"
              >
                START
              </button>
              <span className="text-[9px] uppercase tracking-[0.2em] text-[#e8d9b0]/60">
                1 Player
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

const RALLY_CAP = 1.7; // max speed multiplier relative to the serve speed
const RALLY_STEP = 1.035; // speed multiplier per paddle hit

// The original Pong's ball accelerates while a rally is alive and resets on a
// miss. Servings set `speed` to the base; each return nudges it up to a cap.
function bumpSpeed(s: { speed: number; difficulty: number }) {
  const base = 5.4 + s.difficulty * 0.9;
  const cap = base * RALLY_CAP;
  s.speed = Math.min(Math.max(s.speed, base) * RALLY_STEP, cap);
  return s.speed;
}

// How often (in frames) the CPU re-evaluates where the ball actually is. A
// longer interval = a slower, more human reaction time at lower difficulty.
function cpuReactInterval(difficulty: number) {
  return 0.3 - (difficulty - 1) * 0.09;
}

// ---------------------------------------------------------------- draw
function draw(ctx: CanvasRenderingContext2D, s: World) {
  const vertical = s.vertical;
  const cw = vertical ? H : W;
  const ch = vertical ? W : H;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000b04";
  ctx.fillRect(0, 0, cw, ch);

  // Portrait turns the playfield a quarter turn: the player's wall (logical
  // x = 0) lands at the bottom of the screen, Arkanoid style, and the CPU's
  // wall at the top. Landscape is drawn as is.
  if (vertical) ctx.setTransform(0, -1, 1, 0, 0, W);

  // centre dashed line
  ctx.strokeStyle = "rgba(139,255,163,0.32)";
  ctx.lineWidth = 4;
  ctx.setLineDash([18, 22]);
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.setLineDash([]);

  // faint floor behind the player's paddle, marking the gutter
  if (vertical) {
    ctx.strokeStyle = "rgba(139,255,163,0.10)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(s.inset - 12, 0);
    ctx.lineTo(s.inset - 12, H);
    ctx.stroke();
  }

  // paddles
  ctx.fillStyle = "#8bffa3";
  ctx.shadowColor = "rgba(139,255,163,0.85)";
  ctx.shadowBlur = 14;
  ctx.fillRect(s.inset, s.pY, PADDLE_W, PADDLE_H);
  ctx.fillRect(CPU_X - PADDLE_W, s.cY, PADDLE_W, PADDLE_H);

  // ball
  ctx.fillRect(s.ball.x - BALL / 2, s.ball.y - BALL / 2, BALL, BALL);
  ctx.shadowBlur = 0;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (vertical) drawHudPortrait(ctx, s);
  else drawHudLandscape(ctx, s);
}

function drawHudLandscape(ctx: CanvasRenderingContext2D, s: World) {
  ctx.fillStyle = "rgba(139,255,163,0.92)";
  ctx.font = "bold 64px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(String(s.scoreP), W / 2 - 70, 24);
  ctx.fillText(String(s.scoreC), W / 2 + 70, 24);

  if (s.mode === "attract") {
    textScrim(ctx, W / 2, H / 2 + 8, W, 210);
    centerText(ctx, "PONG", 92, 0.6, W / 2, H / 2 - 34);
    centerText(ctx, "PRESS START OR TAP TO BEGIN", 24, 0.95, W / 2, H / 2 + 54);
  } else if (s.mode === "serve") {
    textScrim(ctx, W / 2, H / 2, W, 110);
    centerText(ctx, "PRESS START / SPACE", 22, 0.8, W / 2, H / 2);
  } else if (s.mode === "over") {
    textScrim(ctx, W / 2, H / 2, W, 140);
    centerText(ctx, "GAME OVER", 60, 0.6, W / 2, H / 2);
  }
}

function drawHudPortrait(ctx: CanvasRenderingContext2D, s: World) {
  const cw = H;
  const ch = W;

  // scoreboard across the top of the screen (the CPU's end)
  ctx.fillStyle = "rgba(139,255,163,0.92)";
  ctx.font = "bold 54px monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText(String(s.scoreP), 24, 44);
  ctx.textAlign = "right";
  ctx.fillText(String(s.scoreC), cw - 24, 44);

  ctx.fillStyle = "rgba(139,255,163,0.45)";
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "left";
  ctx.fillText("YOU", 26, 104);
  ctx.textAlign = "right";
  ctx.fillText("CPU", cw - 26, 104);
  ctx.textAlign = "center";

  if (s.mode === "attract") {
    textScrim(ctx, cw / 2, ch * 0.4 + 20, cw, 260);
    centerText(ctx, "PONG", 88, 0.6, cw / 2, ch * 0.4);
    centerText(ctx, "TAP TO BEGIN", 28, 0.95, cw / 2, ch * 0.4 + 76);
  } else if (s.mode === "serve") {
    textScrim(ctx, cw / 2, ch * 0.5, cw, 120);
    centerText(ctx, "TAP TO SERVE", 26, 0.8, cw / 2, ch * 0.5);
  } else if (s.mode === "over") {
    textScrim(ctx, cw / 2, ch * 0.46 + 24, cw, 190);
    centerText(ctx, "GAME OVER", 54, 0.6, cw / 2, ch * 0.46);
    centerText(ctx, "TAP TO PLAY AGAIN", 22, 0.9, cw / 2, ch * 0.46 + 62);
  }
}

// Soft dark band behind the overlay text, so the ball passing under it never
// fights the lettering.
function textScrim(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
) {
  const g = ctx.createLinearGradient(0, cy - h / 2, 0, cy + h / 2);
  g.addColorStop(0, "rgba(0,11,4,0)");
  g.addColorStop(0.5, "rgba(0,11,4,0.8)");
  g.addColorStop(1, "rgba(0,11,4,0)");
  ctx.fillStyle = g;
  ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
}

function centerText(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
  glow: number,
  x: number,
  y: number,
) {
  ctx.fillStyle = "rgba(139,255,163,0.9)";
  ctx.shadowColor = "rgba(139,255,163,0.8)";
  ctx.shadowBlur = 16 * glow;
  ctx.font = `bold ${size}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
}
