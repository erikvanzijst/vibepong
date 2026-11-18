import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { appName } from "@/config";

// ---------------------------------------------------------------- constants
const W = 840; // playfield width, internal units
const H = 560; // playfield height, internal units
const PADDLE_W = 12;
const PADDLE_H = 84;
const BALL = 10;
const WIN_SCORE = 11;

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

// ---------------------------------------------------------------- game
export function HomePage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cabinetRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  const [mode, setMode] = useState<Mode>("attract");
  const [difficulty, setDifficulty] = useState<1 | 2 | 3>(2);
  const [scoreP, setScoreP] = useState(0);
  const [scoreC, setScoreC] = useState(0);
  const [winner, setWinner] = useState<"YOU" | "CPU" | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  // Mutable game world lives in refs (no re-render during the loop)
  const state = useRef({
    mode: "attract" as Mode,
    difficulty: 2 as 1 | 2 | 3,
    pY: H / 2 - PADDLE_H / 2,
    cY: H / 2 - PADDLE_H / 2,
    cAimY: H / 2, // center of the CPU paddle's (stale) destination, in play units
    cReactTimer: 0,
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 } as Ball,
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

  // Scale the whole cabinet down when the window is smaller than it is, so the
  // marquee and control panel stay on screen on short laptop viewports.
  useLayoutEffect(() => {
    const fit = () => {
      const cabinet = cabinetRef.current;
      if (!cabinet) return;
      const { offsetWidth, offsetHeight } = cabinet;
      if (!offsetWidth || !offsetHeight) return;
      setScale(
        Math.min(
          1,
          (window.innerWidth - 24) / offsetWidth,
          (window.innerHeight - 24) / offsetHeight,
        ),
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (cabinetRef.current) observer.observe(cabinetRef.current);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

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

  // pointer (mouse + touch) paddle + serve
  useEffect(() => {
    const canvas = canvasRef.current!;
    const move = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.height === 0) return;
      const y = ((e.clientY - rect.top) / rect.height) * H;
      const s = state.current;
      s.mouseActive = true;
      s.mouseY = clamp(y, PADDLE_H / 2, H - PADDLE_H / 2);
      s.pY = s.mouseY - PADDLE_H / 2;
    };
    const down = () => {
      const s = state.current;
      if (s.mode === "attract" || s.mode === "over") wakeToServe();
      else if (s.mode === "serve") launch();
      allowAudio();
    };
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

  const step = (s: typeof state.current, dt: number) => {
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
      if (b.vx < 0 && b.x <= 22 + PADDLE_W && b.x > 16) {
        const cy = s.pY + PADDLE_H / 2;
        if (b.y >= s.pY - BALL / 2 && b.y <= s.pY + PADDLE_H + BALL / 2) {
          const rel = (b.y - cy) / (PADDLE_H / 2);
          const ang = rel * 0.9;
          const speed = bumpSpeed(s);
          b.vx = Math.abs(Math.cos(ang) * speed);
          b.vy = Math.sin(ang) * speed;
          b.x = 22 + PADDLE_W + 1;
          sfx.paddle();
        }
      }
      // cpu paddle
      if (b.vx > 0 && b.x >= W - 22 - PADDLE_W - BALL && b.x < W - 16) {
        const cy = s.cY + PADDLE_H / 2;
        if (b.y >= s.cY - BALL / 2 && b.y <= s.cY + PADDLE_H + BALL / 2) {
          const rel = (b.y - cy) / (PADDLE_H / 2);
          const ang = rel * 0.9;
          const speed = bumpSpeed(s);
          b.vx = -Math.abs(Math.cos(ang) * speed);
          b.vy = Math.sin(ang) * speed;
          b.x = W - 22 - PADDLE_W - BALL - 1;
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
    } else if (s.mode === "serve" || s.mode === "attract" || s.mode === "over") {
      // attract: gentle cpu-only demo
      if (s.mode === "attract") {
        s.cAimY = (Math.sin(s.time * 0.004) * 0.5 + 0.5) * (H - PADDLE_H) + PADDLE_H / 2;
        const dy = s.cAimY - (s.cY + PADDLE_H / 2);
        s.cY += clamp(dy, -3.2 * dt, 3.2 * dt);
      }
    }

    if (s.mode === "serve") {
      s.serveTimer -= dt;
      if (s.serveTimer <= 0) launch();
    }
  };

  const afterPoint = (s: typeof state.current) => {
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

  return (
    <div className="flex h-[100dvh] w-screen items-center justify-center overflow-hidden bg-[#050402] p-2">
      <div
        ref={cabinetRef}
        style={{ transform: `scale(${scale})` }}
        className="woodgrain-panel relative flex w-full max-w-[1060px] flex-col rounded-[22px] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.8)]"
      >
        {/* Marquee */}
        <div className="mb-5 flex items-center justify-between px-3">
          <div className="flex flex-col leading-none">
            <span className="arcade-marquee-text text-[13px]">ATARI</span>
            <span className="mt-1 hidden text-[10px] uppercase tracking-[0.28em] text-[#d9b97a]/80 sm:block">
              Est. 1972 · Coin-Op
            </span>
          </div>
          <h1 className="arcade-marquee-text text-4xl sm:text-5xl">{appName}</h1>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <button
                onClick={toggleMute}
                className="arcade-solid-btn h-6 w-10 rounded-sm text-[9px] border-none outline-none"
                aria-label={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted ? "MUT" : "SND"}
              </button>
              <span className={`coin-op-led h-3 w-3 rounded-full ${mode === "play" ? "on" : "off"}`} />
              <span className={`coin-op-led h-3 w-3 rounded-full ${winner ? "on" : "off"}`} />
            </div>
            <span className="text-[9px] uppercase tracking-[0.24em] text-[#d9b97a]/70">
              Insert Coin
            </span>
          </div>
        </div>

        {/* CRT screen */}
        <div className="metal-bezel relative rounded-[18px] p-4">
          <div className="relative overflow-hidden rounded-[6px] bg-black">
            <canvas
              ref={canvasRef}
              width={W}
              height={H}
              className="block w-full"
              style={{ imageRendering: "pixelated", touchAction: "none" }}
            />
            <div className="crt-scanlines pointer-events-none absolute inset-0" />
            <div className="crt-vignette pointer-events-none absolute inset-0" />
            <div className="crt-flicker pointer-events-none absolute inset-0 bg-[rgba(139,255,163,0.02)]" />
          </div>
        </div>

        {/* Control panel */}
        <div className="brushed-aluminum-plate mt-5 flex flex-wrap items-center justify-between gap-4 rounded-[16px] p-5">
          <button
            className="arcade-round relative h-16 w-16 select-none border-none outline-none"
            style={{
              borderRadius: 9999,
            }}
            onPointerDown={() => wakeToServe()}
          />
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.3em] text-[#e8d9b0]/70">
              Difficulty
            </span>
            <div className="flex gap-2">
              {([1, 2, 3] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDiff(d)}
                  className={`arcade-solid-btn h-9 w-12 rounded-md text-xs border-none outline-none ${
                    difficulty === d ? "on" : ""
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
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
  return 0.30 - (difficulty - 1) * 0.09;
}

// ---------------------------------------------------------------- draw
function draw(ctx: CanvasRenderingContext2D, s: {
  mode: Mode; pY: number; cY: number; ball: Ball; scoreP: number; scoreC: number;
}) {
  ctx.fillStyle = "#000b04";
  ctx.fillRect(0, 0, W, H);

  // center dashed line
  ctx.strokeStyle = "rgba(139,255,163,0.32)";
  ctx.lineWidth = 4;
  ctx.setLineDash([18, 22]);
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.setLineDash([]);

  // score
  ctx.fillStyle = "rgba(139,255,163,0.92)";
  ctx.font = "bold 64px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(String(s.scoreP), W / 2 - 70, 24);
  ctx.fillText(String(s.scoreC), W / 2 + 70, 24);

  // paddles
  ctx.fillStyle = "#8bffa3";
  ctx.shadowColor = "rgba(139,255,163,0.85)";
  ctx.shadowBlur = 14;
  ctx.fillRect(22, s.pY, PADDLE_W, PADDLE_H);
  ctx.fillRect(W - 22 - PADDLE_W, s.cY, PADDLE_W, PADDLE_H);

  // ball
  ctx.fillRect(s.ball.x - BALL / 2, s.ball.y - BALL / 2, BALL, BALL);
  ctx.shadowBlur = 0;

  // overlays
  if (s.mode === "attract") {
    centerText(ctx, "PONG", 92, 0.6);
    centerText(ctx, "PRESS START OR TAP TO BEGIN", 24, 0.95);
  } else if (s.mode === "serve") {
    centerText(ctx, "PRESS START / SPACE", 22, 0.8);
  } else if (s.mode === "over") {
    centerText(ctx, "GAME OVER", 60, 0.6);
  }
}

function centerText(ctx: CanvasRenderingContext2D, text: string, size: number, glow: number) {
  ctx.fillStyle = "rgba(139,255,163,0.9)";
  ctx.shadowColor = "rgba(139,255,163,0.8)";
  ctx.shadowBlur = 16 * glow;
  ctx.font = `bold ${size}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, W / 2, H / 2);
  ctx.shadowBlur = 0;
}