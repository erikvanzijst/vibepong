import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------- constants
const W = 840; // playfield width, internal units
const H = 560; // playfield height, internal units
const PADDLE_W = 12;
const PADDLE_H = 84;
const BALL = 10;
const WIN_SCORE = 11;

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

  const [mode, setMode] = useState<Mode>("attract");
  const [difficulty, setDifficulty] = useState<1 | 2 | 3>(2);
  const [scoreP, setScoreP] = useState(0);
  const [scoreC, setScoreC] = useState(0);
  const [winner, setWinner] = useState<"YOU" | "CPU" | null>(null);

  // Mutable game world lives in refs (no re-render during the loop)
  const state = useRef({
    mode: "attract" as Mode,
    difficulty: 2 as 1 | 2 | 3,
    pY: H / 2 - PADDLE_H / 2,
    cY: H / 2 - PADDLE_H / 2,
    cTarget: H / 2 - PADDLE_H / 2,
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 } as Ball,
    scoreP: 0,
    scoreC: 0,
    keys: { up: false, down: false },
    serveTimer: 0,
    flash: 0,
    time: 0,
  });

  // ------------------------------------------------------------ controls
  const press = (k: "up" | "down", v: boolean) => {
    state.current.keys[k] = v;
    if (v) wakeToServe();
  };
  const wakeToServe = () => {
    const s = state.current;
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
    const speed = 5.4 + s.difficulty * 0.9;
    const ang = (Math.random() - 0.5) * 0.7;
    const dir = Math.random() < 0.5 ? 1 : -1;
    s.ball.vx = Math.cos(ang) * speed * dir;
    s.ball.vy = Math.sin(ang) * speed;
    s.mode = "play";
    setMode("play");
  };
  const setDiff = (d: 1 | 2 | 3) => {
    setDifficulty(d);
    state.current.difficulty = d;
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
    s.pY = clamp(s.pY, 0, H - PADDLE_H);
    s.time = (s.time ?? 0) + dt;

    if (s.mode === "play") {
      // CPU tracks the ball with reaction lag & top speed
      const maxSpeed = 3.4 + s.difficulty * 0.9;
      const err = (difficultyError(s.difficulty) * H) / 2;
      s.cTarget = clamp(s.ball.y - PADDLE_H / 2 + err, 0, H - PADDLE_H);
      const dy = s.cTarget - s.cY;
      const stepA = clamp(dy, -maxSpeed * dt, maxSpeed * dt);
      s.cY += stepA;

      const b = s.ball;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.y <= 0) {
        b.y = 0;
        b.vy = Math.abs(b.vy);
      } else if (b.y >= H) {
        b.y = H;
        b.vy = -Math.abs(b.vy);
      }

      // player paddle
      if (b.vx < 0 && b.x <= 22 + PADDLE_W && b.x > 16) {
        const cy = s.pY + PADDLE_H / 2;
        if (b.y >= s.pY - BALL / 2 && b.y <= s.pY + PADDLE_H + BALL / 2) {
          const rel = (b.y - cy) / (PADDLE_H / 2);
          const speed = Math.hypot(b.vx, b.vy);
          const ang = rel * 0.9;
          b.vx = Math.abs(Math.cos(ang) * speed);
          b.vy = Math.sin(ang) * speed;
          b.x = 22 + PADDLE_W + 1;
        }
      }
      // cpu paddle
      if (b.vx > 0 && b.x >= W - 22 - PADDLE_W - BALL && b.x < W - 16) {
        const cy = s.cY + PADDLE_H / 2;
        if (b.y >= s.cY - BALL / 2 && b.y <= s.cY + PADDLE_H + BALL / 2) {
          const rel = (b.y - cy) / (PADDLE_H / 2);
          const speed = Math.hypot(b.vx, b.vy);
          const ang = rel * 0.9;
          b.vx = -Math.abs(Math.cos(ang) * speed);
          b.vy = Math.sin(ang) * speed;
          b.x = W - 22 - PADDLE_W - BALL - 1;
        }
      }

      // scoring
      if (b.x < -BALL * 2) {
        s.scoreC++;
        setScoreC(s.scoreC);
        afterPoint(s);
      } else if (b.x > W + BALL * 2) {
        s.scoreP++;
        setScoreP(s.scoreP);
        afterPoint(s);
      }
    } else if (s.mode === "serve" || s.mode === "attract" || s.mode === "over") {
      // attract: gentle cpu-only demo
      if (s.mode === "attract") {
        s.cTarget = (Math.sin(s.time * 0.004) * 0.5 + 0.5) * (H - PADDLE_H);
        const dy = s.cTarget - s.cY;
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
    } else if (s.scoreC >= WIN_SCORE) {
      setWinner("CPU");
      s.mode = "over";
      setMode("over");
    } else {
      beginServe();
      setMode("serve");
    }
  };

  return (
    <div className="flex h-[100dvh] w-screen items-center justify-center bg-[#050402] p-4">
      <div className="woodgrain-panel relative flex w-full max-w-[1060px] flex-col rounded-[22px] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.8)]">
        {/* Marquee */}
        <div className="mb-5 flex items-center justify-between px-3">
          <div className="flex flex-col leading-none">
            <span className="arcade-marquee-text text-[13px]">ATARI</span>
            <span className="mt-1 text-[10px] uppercase tracking-[0.28em] text-[#d9b97a]/80">
              Est. 1972 · Coin-Op
            </span>
          </div>
          <h1 className="arcade-marquee-text text-4xl sm:text-5xl">PONG</h1>
          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
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
              style={{ imageRendering: "pixelated" }}
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

function difficultyError(d: number) {
  // higher difficulty = smaller aiming error / faster
  return (4 - d) * 0.22;
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