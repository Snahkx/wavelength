import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:8000";


type Player = { id: string; name: string };
type LeaderRow = { id: string; name: string; score: number };

type RevealPayload = {
  target: number;
  finalGuess: number;
  dist: number;
  delta: number;
  total: number;
  perPlayer?: Record<string, { guess: number | null; dist: number | null; pts: number }>;
  cluePts?: number;
};

type RoomState = {
  code: string;
  hostId: string | null;
  players: Player[];
  playerScores: Record<string, number>;
  phase: "LOBBY" | "CLUE" | "GUESS" | "REVEAL" | "GAMEOVER";
  cluegiverId: string | null;
  spectrum: { left: string; right: string } | null;
  clue: string;
  guesses: { id: string; value: number }[];
  locked: string[];
  score: number;
  finalGuess: number | null;
  lastReveal: RevealPayload | null;
  secretTarget?: number;
  promptPoolCount?: number;
  totalRounds: number;
  currentRound: number;
  leaderboard: LeaderRow[] | null;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function badgeStyle(bg: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderRadius: 999,
    fontWeight: 900,
    fontSize: 12,
    background: bg,
    border: "1px solid rgba(255,255,255,0.14)",
    boxShadow: "0 0 18px rgba(0,0,0,0.25)",
    whiteSpace: "nowrap",
  };
}

/** Wheel that can show many green guesses + red target. Needle shows `value`. */
function WavelengthWheel(props: {
  value: number;
  onChange?: (v: number) => void;
  disabled?: boolean;
  leftLabel?: string;
  rightLabel?: string;
  showTarget?: number | null;
  showGuesses?: { id: string; guess: number; color: string }[] | null;

}) {
  const { value, onChange, disabled, leftLabel, rightLabel, showTarget, showGuesses } = props;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const W = 900;
  const H = 520;
  const cx = W / 2;
  const cy = 440;
  const rOuter = 320;
  const rInner = 215;

  function valueToTheta(v: number) {
    const t = clamp(v, 0, 100) / 100;
    return Math.PI * (1 - t);
  }
  function thetaToValue(theta: number) {
    const th = clamp(theta, 0, Math.PI);
    return Math.round(((Math.PI - th) / Math.PI) * 100);
  }
  function polar(theta: number, r: number) {
    return { x: cx + Math.cos(theta) * r, y: cy - Math.sin(theta) * r };
  }
  function arcPath(r: number) {
    const a0 = polar(Math.PI, r);
    const a1 = polar(0, r);
    return `M ${a0.x} ${a0.y} A ${r} ${r} 0 0 1 ${a1.x} ${a1.y}`;
  }
  function donutPath(rOut: number, rIn: number) {
    const out0 = polar(Math.PI, rOut);
    const out1 = polar(0, rOut);
    const in0 = polar(0, rIn);
    const in1 = polar(Math.PI, rIn);
    return [
      `M ${out0.x} ${out0.y}`,
      `A ${rOut} ${rOut} 0 0 1 ${out1.x} ${out1.y}`,
      `L ${in0.x} ${in0.y}`,
      `A ${rIn} ${rIn} 0 0 0 ${in1.x} ${in1.y}`,
      "Z",
    ].join(" ");
  }

  function getValueFromPointerEvent(e: React.PointerEvent) {
    const svg = svgRef.current;
    if (!svg) return value;

    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const sx = (px / rect.width) * W;
    const sy = (py / rect.height) * H;

    const dx = sx - cx;
    const dy = sy - cy;

    let theta = Math.atan2(-dy, dx);
    if (theta < 0) theta = 0;
    if (theta > Math.PI) theta = Math.PI;

    return thetaToValue(theta);
  }

  function onPointerDown(e: React.PointerEvent) {
    if (disabled || !onChange) return;
    e.preventDefault();
    (e.currentTarget as any).setPointerCapture?.(e.pointerId);
    setDragging(true);
    onChange(getValueFromPointerEvent(e));
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging) return;
    if (disabled || !onChange) return;
    e.preventDefault();
    onChange(getValueFromPointerEvent(e));
  }
  function onPointerUp() {
    setDragging(false);
  }

  const v = clamp(value, 0, 100);
  const p = polar(valueToTheta(v), rOuter - 16);

  const targetMarker =
    showTarget == null ? null : polar(valueToTheta(clamp(showTarget, 0, 100)), rOuter - 16);

  const guessMarkers =
    !showGuesses || showGuesses.length === 0
      ? []
      : showGuesses.map((g) => ({
          ...polar(valueToTheta(clamp(g.guess, 0, 100)), rOuter - 16),
          id: g.id,
          color: g.color,
        }));


  return (
    <div style={wheelStyles.wrap}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={wheelStyles.svg}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <path d={donutPath(rOuter, rInner)} fill="rgba(255,255,255,0.06)" stroke="rgba(0,255,255,0.18)" />

        {Array.from({ length: 11 }).map((_, i) => {
          const tickV = i * 10;
          const theta = valueToTheta(tickV);
          const a = polar(theta, rOuter);
          const b = polar(theta, rOuter - 28);
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="rgba(255,255,255,0.22)"
              strokeWidth={3}
            />
          );
        })}

        <path d={arcPath(rOuter)} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={4} />
        <path d={arcPath(rInner)} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={3} />

        {/* Needle */}
        <line x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="rgba(255,255,255,0.22)" strokeWidth={3} />

        {/* All player guesses */}
        {guessMarkers.map((m) => (
          <circle
            key={m.id}
            cx={m.x}
            cy={m.y}
            r={10}
            fill={m.color}
            opacity={0.92}
          />
        ))}

        {/* Target */}
        {targetMarker && <circle cx={targetMarker.x} cy={targetMarker.y} r={13} fill="rgba(255,70,110,0.98)" />}

        {/* Pointer knob */}
        <circle cx={p.x} cy={p.y} r={14} fill="white" opacity={disabled ? 0.7 : 0.98} />
        <circle cx={cx} cy={cy} r={16} fill="rgba(255,255,255,0.18)" />
      </svg>

      <div style={wheelStyles.labels}>
        <div style={wheelStyles.labelLeft}>{leftLabel ?? ""}</div>
        <div style={wheelStyles.labelRight}>{rightLabel ?? ""}</div>
      </div>

      <div style={wheelStyles.valueLine}>
        <span style={{ opacity: 0.75 }}>Pointer:</span> <b style={{ marginLeft: 8 }}>{v}</b>
        {disabled && <span style={{ marginLeft: 10, opacity: 0.65 }}>(locked)</span>}
      </div>
    </div>
  );
}

const wheelStyles: Record<string, React.CSSProperties> = {
  wrap: { width: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column" },
  svg: {
    width: "100%",
    flex: "1 1 auto",
    minHeight: 0,
    maxHeight: "100%",
    display: "block",
    borderRadius: 18,
    touchAction: "none",
    background: "linear-gradient(180deg, rgba(0,255,255,0.06), rgba(255,70,110,0.03))",
    border: "1px solid rgba(255,255,255,0.10)",
    boxShadow: "0 0 40px rgba(0,255,255,0.06)",
  },
  labels: { display: "flex", justifyContent: "space-between", marginTop: 10, fontWeight: 900 },
  labelLeft: { opacity: 0.95, color: "rgba(0,255,255,0.95)" },
  labelRight: { opacity: 0.95, color: "rgba(255,70,110,0.95)" },
  valueLine: { marginTop: 6, fontSize: 13, opacity: 0.9 },
};

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);

  const [name, setName] = useState("Player");
  const [codeInput, setCodeInput] = useState("");
  const [roomCode, setRoomCode] = useState<string | null>(null);

  const [room, setRoom] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [clueText, setClueText] = useState("");
  const [myPointer, setMyPointer] = useState(50);

  const [promptText, setPromptText] = useState("Cold | Hot\nBoring | Exciting\nOverrated | Underrated\nChaotic | Orderly");
  const [roundsChoice, setRoundsChoice] = useState<number>(5);

  const myId = socket?.id ?? null;

  const isHost = useMemo(() => !!room && !!myId && room.hostId === myId, [room, myId]);
  const isCluegiver = useMemo(() => !!room && !!myId && room.cluegiverId === myId, [room, myId]);

  const myLocked = useMemo(() => {
    if (!room || !myId) return false;
    return room.locked.includes(myId);
  }, [room, myId]);

  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"] });
    setSocket(s);

    const onJoined = ({ code }: { code: string }) => {
      setRoomCode(code);
      setError(null);
    };

    const onState = (state: RoomState) => {
      setRoom(state);
      setError(null);

      const sid = s.id;
      if (sid) {
        const mine = state.guesses.find((g) => g.id === sid);
        if (mine && typeof mine.value === "number") setMyPointer(mine.value);
      }

      if (state.phase === "LOBBY") {
        if (typeof state.totalRounds === "number") setRoundsChoice(state.totalRounds);
      }
    };

    const onErr = ({ message }: { message: string }) => setError(message);

    s.on("room:joined", onJoined);
    s.on("room:state", onState);
    s.on("room:error", onErr);

    return () => {
      s.off("room:joined", onJoined);
      s.off("room:state", onState);
      s.off("room:error", onErr);
      s.disconnect();
    };
  }, []);

  function createRoom() {
    setError(null);
    socket?.emit("room:create", { name });
  }
  function joinRoom() {
    setError(null);
    const code = codeInput.trim().toUpperCase();
    if (!code) return;
    socket?.emit("room:join", { code, name });
  }

  function applyPrompts() {
    if (!roomCode) return;
    socket?.emit("prompts:set", { code: roomCode, text: promptText });
  }

  function setRoundsOnServer(v: number) {
    if (!roomCode) return;
    socket?.emit("config:setRounds", { code: roomCode, totalRounds: v });
  }

  function startGame() {
    setError(null);
    if (!roomCode) return;
    socket?.emit("game:start", { code: roomCode, totalRounds: roundsChoice });
  }

  function replayGame() {
    if (!roomCode) return;
    socket?.emit("game:replay", { code: roomCode });
  }

  function submitClue() {
    setError(null);
    if (!roomCode) return;
    socket?.emit("round:clue", { code: roomCode, text: clueText });
    setClueText("");
  }

  function sendPointer(v: number) {
    setMyPointer(v);
    if (!roomCode) return;
    socket?.emit("round:guess", { code: roomCode, value: v });
  }

  function lockGuess() {
    if (!roomCode) return;
    socket?.emit("round:lock", { code: roomCode });
  }

  function revealNow() {
    if (!roomCode) return;
    socket?.emit("round:revealNow", { code: roomCode });
  }

  function nextRound() {
    if (!roomCode) return;
    socket?.emit("round:next", { code: roomCode });
  }

  // JOIN SCREEN
  if (!roomCode) {
    return (
      <div style={styles.pageCenter}>
        <div style={styles.card}>
          <h1 style={styles.title}>Wavelength</h1>
          <p style={styles.sub}>Online • Custom Prompts • Rounds • Individual Scoring</p>

          <label style={styles.label}>Your name</label>
          <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} />

          <div style={{ height: 14 }} />
          <button style={styles.buttonPrimary} onClick={createRoom}>Create Room</button>

          <div style={{ height: 14 }} />
          <label style={styles.label}>Join room code</label>
          <input style={styles.input} value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="ABCDE" />
          <button style={styles.buttonGhost} onClick={joinRoom}>Join Room</button>

          {error && <p style={styles.error}>{error}</p>}
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div style={styles.pageCenter}>
        <div style={styles.card}><h2 style={styles.title}>Joining…</h2></div>
      </div>
    );
  }

  const left = room.spectrum?.left ?? "";
  const right = room.spectrum?.right ?? "";
  const reveal = room.lastReveal;

  const showTargetToAll = room.phase === "REVEAL" && reveal?.target != null;

  const roundInfo = room.phase === "LOBBY" ? "" : `Round ${room.currentRound} / ${room.totalRounds}`;

  return (
    <div style={styles.page}>
      <div style={styles.topbar}>
        <div>
          <div style={styles.roomCodeRow}>
            <span style={styles.roomLabel}>Room:</span>
            <span style={styles.roomCodeValue}>{room.code}</span>
            {roundInfo && <span style={styles.roundChip}>{roundInfo}</span>}
          </div>
          <div style={styles.small}>
            Players: {room.players.length} • Team Score: <b style={{ color: "rgba(0,255,255,0.95)" }}>{room.score}</b>
          </div>
        </div>

        {isHost && room.phase === "LOBBY" && (
          <button style={styles.buttonPrimaryInline} onClick={startGame}>Start Game</button>
        )}

        {isHost && room.phase === "GAMEOVER" && (
          <button style={styles.buttonPrimaryInline} onClick={replayGame}>Replay</button>
        )}
      </div>

      <div style={styles.grid}>
        {/* LEFT */}
        <div style={styles.panelLeft}>
          <div style={styles.panelTitleRow}>
            <h3 style={styles.h3}>Players</h3>
            <span style={badgeStyle("rgba(255,70,110,0.16)")}>⭐ SCOREBOARD</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {room.players.map((p, idx) => {
              const score = room.playerScores?.[p.id] ?? 0;
              const hue = (idx * 75) % 360;
              const chipBg = `hsla(${hue}, 90%, 60%, 0.16)`;
              const chipFg = `hsla(${hue}, 90%, 70%, 0.95)`;
              return (
                <div key={p.id} style={styles.playerRow}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <div style={{ ...styles.playerDot, background: chipFg, boxShadow: `0 0 18px ${chipFg}` }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={styles.playerName}>
                        {p.name}
                        {p.id === room.hostId ? " (Host)" : ""}
                        {p.id === room.cluegiverId ? " 🎤" : ""}
                        {p.id === myId ? " (You)" : ""}
                      </div>
                      <div style={styles.smallMuted}>{room.locked.includes(p.id) ? "Locked ✅" : "—"}</div>
                    </div>
                  </div>

                  <div style={{ ...badgeStyle(chipBg), color: chipFg }}>{score} pts</div>
                </div>
              );
            })}
          </div>

          <div style={styles.rulesBox}>
            <div style={{ fontWeight: 950, marginBottom: 8 }}>SCORING</div>
            <div style={styles.ruleLine}><span style={{ color: "rgba(0,255,180,0.95)" }}>4</span> ≤ 10 away</div>
            <div style={styles.ruleLine}><span style={{ color: "rgba(0,255,255,0.95)" }}>3</span> ≤ 17 away</div>
            <div style={styles.ruleLine}><span style={{ color: "rgba(160,120,255,0.95)" }}>2</span> ≤ 24 away</div>
            <div style={styles.ruleLine}><span style={{ color: "rgba(255,200,80,0.95)" }}>1</span> ≤ 34 away</div>
            <div style={styles.ruleLine}><span style={{ color: "rgba(255,80,110,0.95)" }}>0</span> &gt; 34 away</div>
          </div>
        </div>

        {/* RIGHT */}
        <div style={styles.panelRight}>
          <div style={styles.rightHeader}>
            <div>
              <div style={styles.phaseTitle}>PHASE: {room.phase}</div>
              {room.spectrum && (
                <div style={styles.spectrumTitle}>
                  <span style={{ color: "rgba(0,255,255,0.95)" }}>{left}</span> ↔{" "}
                  <span style={{ color: "rgba(255,70,110,0.95)" }}>{right}</span>
                </div>
              )}
            </div>

            {isHost && room.phase === "GUESS" && (
              <button style={styles.buttonGhostInline} onClick={revealNow}>Force Reveal</button>
            )}
          </div>

          <div style={styles.rightBody}>
            {/* LOBBY */}
            {room.phase === "LOBBY" && (
              <div style={styles.lobbyBox}>
                <div style={styles.lobbyTitle}>Custom Prompt Pack (Host)</div>
                <div style={styles.small}>Each line: <b>Left | Right</b></div>

                <div style={styles.roundsRow}>
                  <div style={{ fontWeight: 900, opacity: 0.9 }}>Rounds:</div>
                  <select
                    style={styles.select}
                    value={roundsChoice}
                    onChange={(e) => {
                      const v = clamp(Number(e.target.value), 1, 50);
                      setRoundsChoice(v);
                      if (isHost) setRoundsOnServer(v);
                    }}
                    disabled={!isHost}
                  >
                    {[3, 5, 7, 10, 15, 20].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  <div style={styles.smallMuted}>Game ends after {roundsChoice} rounds.</div>
                </div>

                {isHost ? (
                  <>
                    <textarea
                      style={styles.textarea}
                      value={promptText}
                      onChange={(e) => setPromptText(e.target.value)}
                    />

                    <div style={{ display: "flex", gap: 10, marginTop: 10, flex: "0 0 auto" }}>
                      <button style={{ ...styles.buttonPrimary, width: "auto", flex: 1, minWidth: 0 }} onClick={applyPrompts}>
                        Apply Prompts
                      </button>
                      <button style={{ ...styles.buttonGhost, width: "auto", flex: 1, minWidth: 0 }} onClick={startGame}>
                        Start Game
                      </button>
                    </div>
                  </>
                ) : (
                  <div style={styles.small}>Waiting for host… (prompts: <b>{room.promptPoolCount ?? 0}</b>)</div>
                )}
              </div>
            )}

            {/* CLUE */}
            {room.phase === "CLUE" && (
              <div style={styles.stack}>
                {isCluegiver ? (
                  <>
                    <div style={styles.secretBox}>
                      <div style={styles.small}>SECRET TARGET (only you)</div>
                      <div style={styles.secretNum}>{room.secretTarget ?? "?"}</div>
                      <div style={styles.smallMuted}>Give a clue to guide guesses near this.</div>
                    </div>

                    <input style={styles.input} value={clueText} onChange={(e) => setClueText(e.target.value)} placeholder="Type your clue…" />
                    <button style={styles.buttonPrimary} onClick={submitClue}>Send Clue</button>
                  </>
                ) : (
                  <div style={styles.centerNote}>Cluegiver is thinking…</div>
                )}
              </div>
            )}

            {/* GUESS */}
            {room.phase === "GUESS" && (
              <div style={styles.fitColumn}>
                <div style={styles.clueBox}>
                  <div style={styles.small}>CLUE</div>
                  <div style={styles.clueText}>{room.clue || "(no clue?)"}</div>
                </div>

                {isCluegiver ? (
                  <div style={styles.centerNote}>You’re the cluegiver — you don’t move the wheel.</div>
                ) : (
                  <>
                    <div style={styles.wheelArea}>
                      <WavelengthWheel
                        value={myPointer}
                        onChange={myLocked ? undefined : sendPointer}
                        disabled={myLocked}
                        leftLabel={left}
                        rightLabel={right}
                      />
                    </div>

                    <div style={styles.actionsRow}>
                      <button style={styles.buttonPrimary} onClick={lockGuess} disabled={myLocked}>
                        {myLocked ? "Locked ✅" : "Lock In"}
                      </button>
                      <div style={styles.smallMuted}>Everyone locks → auto reveal</div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* REVEAL */}
            {room.phase === "REVEAL" && (
              <div style={styles.fitColumn}>
                <div style={styles.clueBox}>
                  <div style={styles.small}>CLUE</div>
                  <div style={styles.clueText}>{room.clue}</div>
                </div>

                <div style={styles.wheelArea}>
                  <WavelengthWheel
                    value={
                      myId && room.lastReveal?.perPlayer?.[myId]?.guess != null
                        ? room.lastReveal.perPlayer[myId].guess!
                        : room.lastReveal?.finalGuess ?? 50
                    }
                    disabled
                    leftLabel={left}
                    rightLabel={right}
                    showTarget={showTargetToAll ? room.lastReveal?.target ?? null : null}
                    showGuesses={
                      room.lastReveal?.perPlayer
                        ? room.players
                            .map((p, idx) => {
                              const g = room.lastReveal?.perPlayer?.[p.id]?.guess;
                              if (typeof g !== "number") return null;

                              // SAME color rule as your left scoreboard
                              const hue = (idx * 75) % 360;
                              const color = `hsla(${hue}, 90%, 70%, 0.95)`;

                              return { id: p.id, guess: g, color };
                            })
                            .filter(Boolean) as { id: string; guess: number; color: string }[]
                        : null
                    }
                  />
                </div>

                <div style={styles.revealBox}>
                  {room.lastReveal ? (
                    (() => {
                      const me = myId ? room.lastReveal?.perPlayer?.[myId] : undefined;
                      const myGuess = me?.guess ?? null;
                      const myDist = me?.dist ?? null;
                      const myPts = me?.pts ?? null;

                      return (
                        <>
                          <div style={styles.revealLine}>
                            Your Round:{" "}
                            <b style={{ color: "rgba(0,255,180,0.95)" }}>+{myPts ?? 0}</b> pts
                            {me == null && <span style={styles.smallMuted}> (no guess)</span>}
                          </div>

                          <div style={styles.revealLine}>
                            Your Guess <b>{myGuess ?? "—"}</b> • Target <b>{room.lastReveal.target}</b> • Dist{" "}
                            <b>{myDist ?? "—"}</b>
                          </div>

                          <div style={styles.smallMuted}>Green = players’ guesses • Red = target</div>
                        </>
                      );
                    })()
                  ) : (
                    <div style={styles.small}>Revealing…</div>
                  )}

                  {isHost && (
                    <button style={styles.buttonPrimary} onClick={nextRound}>
                      {room.currentRound >= room.totalRounds ? "Finish Game" : "Next Round"}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* GAME OVER */}
            {room.phase === "GAMEOVER" && (
              <div style={styles.gameOverBox}>
                <div style={styles.gameOverTitle}>🏁 Game Over</div>
                <div style={styles.smallMuted}>Final leaderboard</div>

                <div style={styles.leaderList}>
                  {(room.leaderboard ?? []).map((r, i) => (
                    <div key={r.id} style={styles.leaderRow}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <div style={styles.placePill}>{i + 1}</div>
                        <div style={{ fontWeight: 950, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.name}
                        </div>
                      </div>
                      <div style={badgeStyle("rgba(0,255,255,0.14)")}>{r.score} pts</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    style={{ ...styles.buttonGhost, width: "auto", flex: 1, minWidth: 0 }}
                    onClick={() => window.location.reload()}
                  >
                    Leave
                  </button>

                  <button
                    style={{ ...styles.buttonPrimary, width: "auto", flex: 1, minWidth: 0 }}
                    onClick={replayGame}
                    disabled={!isHost}
                    title={!isHost ? "Only host can replay" : ""}
                  >
                    Replay
                  </button>
                </div>
              </div>
            )}

            {error && <div style={styles.error}>{error}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    width: "auto",
    overflowY: "auto",
    overflowX: "hidden",
    minHeight: "100vh",
    height: "auto",


    background:
      "radial-gradient(circle at 20% 10%, rgba(0,255,255,0.12), transparent 45%)," +
      "radial-gradient(circle at 80% 20%, rgba(255,70,110,0.14), transparent 50%)," +
      "radial-gradient(circle at 50% 80%, rgba(160,120,255,0.10), transparent 55%)," +
      "linear-gradient(180deg, #070A12, #06060F)",
    color: "white",
    padding: 14,
    fontFamily: "system-ui, Segoe UI, Arial",
  },

  pageCenter: {
    width: "100vw",
    height: "100vh",
    overflow: "hidden",
    display: "grid",
    placeItems: "center",
    background:
      "radial-gradient(circle at 20% 10%, rgba(0,255,255,0.12), transparent 45%)," +
      "radial-gradient(circle at 80% 20%, rgba(255,70,110,0.14), transparent 50%)," +
      "radial-gradient(circle at 50% 80%, rgba(160,120,255,0.10), transparent 55%)," +
      "linear-gradient(180deg, #070A12, #06060F)",
    color: "white",
    padding: 14,
    fontFamily: "system-ui, Segoe UI, Arial",
  },

  topbar: {
    height: 64,
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    padding: "10px 12px",
    borderRadius: 18,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.10)",
    boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
  },

  roomCodeRow: { display: "flex", alignItems: "baseline", gap: 10 },
  roomLabel: { fontWeight: 950, fontSize: 16, letterSpacing: 0.6, opacity: 0.95 },
  roomCodeValue: { fontWeight: 1000, fontSize: 18, letterSpacing: 0, color: "rgba(0,255,255,0.95)" },
  roundChip: {
    marginLeft: 6,
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 950,
    background: "rgba(160,120,255,0.16)",
    border: "1px solid rgba(255,255,255,0.12)",
    opacity: 0.95,
  },

  small: { opacity: 0.78, fontSize: 13 },
  smallMuted: { opacity: 0.6, fontSize: 12 },

  // ✅ no clipping: height = full viewport minus topbar minus page padding top/bottom
  grid: {
    height: "calc(100vh - 64px - 28px)",
    marginTop: 14,
    display: "grid",
    gridTemplateColumns: "minmax(320px, 380px) minmax(0, 1fr)",
    gap: 14,
    minHeight: 0,
    overflow: "hidden",
  },

  panelLeft: {
    height: "100%",
    minHeight: 0,
    borderRadius: 18,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.10)",
    boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
    padding: 14,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    overflow: "hidden",
  },

  panelRight: {
    height: "100%",
    minHeight: 0,
    borderRadius: 18,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.10)",
    boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
    padding: 14,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },

  panelTitleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
  h3: { margin: 0, fontSize: 18, fontWeight: 950 },

  playerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    padding: "10px 10px",
    borderRadius: 14,
    background: "rgba(0,0,0,0.22)",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  playerDot: { width: 10, height: 10, borderRadius: 999 },
  playerName: { fontWeight: 900, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },

  rulesBox: {
    marginTop: 16,
    padding: 12,
    borderRadius: 16,
    background: "rgba(0,0,0,0.22)",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  ruleLine: { marginTop: 6, opacity: 0.85, fontSize: 13 },

  rightHeader: {
    flex: "0 0 auto",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingBottom: 10,
  },
  phaseTitle: { fontWeight: 950, letterSpacing: 1.2, fontSize: 16 },
  spectrumTitle: { marginTop: 6, fontWeight: 950, fontSize: 18 },

  // ✅ NEVER clip: allow tiny scroll when needed
  rightBody: {
    flex: "1 1 auto",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    overflowY: "auto",
    paddingBottom: 10,
  },

  stack: { display: "flex", flexDirection: "column", gap: 10 },
  fitColumn: { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 10 },

  // wheel area sized so buttons + reveal box fit on laptops
  wheelArea: { flex: "1 1 auto", minHeight: 0, display: "flex", maxHeight: "44vh" },

  actionsRow: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingTop: 6,
  },

  clueBox: {
    padding: 12,
    borderRadius: 16,
    background: "rgba(0,0,0,0.22)",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  clueText: { marginTop: 6, fontSize: 18, fontWeight: 950 },

  revealBox: {
    padding: 12,
    borderRadius: 16,
    background: "rgba(0,0,0,0.22)",
    border: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  revealLine: { fontSize: 14, opacity: 0.9 },

  secretBox: {
    padding: 14,
    borderRadius: 16,
    background: "linear-gradient(180deg, rgba(255,70,110,0.14), rgba(0,0,0,0.22))",
    border: "1px solid rgba(255,255,255,0.10)",
    boxShadow: "0 0 40px rgba(255,70,110,0.08)",
  },
  secretNum: { fontSize: 52, fontWeight: 1000, marginTop: 6 },

  centerNote: { flex: "1 1 auto", display: "grid", placeItems: "center", opacity: 0.75, fontWeight: 850 },

  lobbyBox: {
    flex: "1 1 auto",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 12,
    borderRadius: 16,
    background: "rgba(0,0,0,0.22)",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  lobbyTitle: { fontWeight: 950, fontSize: 16, letterSpacing: 0.6 },

  roundsRow: { display: "flex", alignItems: "center", gap: 10, flex: "0 0 auto" },
  select: {
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.25)",
    color: "white",
    outline: "none",
    fontWeight: 900,
  },

  textarea: {
    flex: "0 0 auto",
    height: "clamp(160px, 28vh, 300px)",
    width: "100%",
    resize: "none",
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.25)",
    color: "white",
    outline: "none",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: 1.4,
  },

  label: { display: "block", marginTop: 12, marginBottom: 6, opacity: 0.9 },
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.25)",
    color: "white",
    outline: "none",
  },

  buttonPrimary: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 14,
    border: "none",
    background: "linear-gradient(90deg, rgba(0,255,255,0.95), rgba(160,120,255,0.90))",
    color: "black",
    fontWeight: 950,
    cursor: "pointer",
    boxShadow: "0 10px 30px rgba(0,255,255,0.10)",
  },
  buttonGhost: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(0,0,0,0.15)",
    color: "white",
    fontWeight: 900,
    cursor: "pointer",
  },

  buttonPrimaryInline: {
    padding: "10px 14px",
    borderRadius: 14,
    border: "none",
    background: "linear-gradient(90deg, rgba(0,255,255,0.95), rgba(255,70,110,0.92))",
    color: "black",
    fontWeight: 950,
    cursor: "pointer",
  },
  buttonGhostInline: {
    padding: "10px 14px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(0,0,0,0.15)",
    color: "white",
    fontWeight: 900,
    cursor: "pointer",
  },

  card: {
    width: "min(720px, 92vw)",
    padding: 24,
    borderRadius: 18,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.10)",
    boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
  },
  title: { fontSize: 34, fontWeight: 1000, margin: 0, letterSpacing: 0.6 },
  sub: { opacity: 0.78, marginTop: 8 },

  // GAME OVER
  gameOverBox: {
    flex: "1 1 auto",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: 14,
    borderRadius: 16,
    background: "rgba(0,0,0,0.22)",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  gameOverTitle: { fontSize: 22, fontWeight: 1000 },
  leaderList: { display: "flex", flexDirection: "column", gap: 10, paddingTop: 8, paddingBottom: 6 },
  leaderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 10px",
    borderRadius: 14,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.10)",
  },
  placePill: {
    width: 28,
    height: 28,
    borderRadius: 999,
    display: "grid",
    placeItems: "center",
    fontWeight: 1000,
    background: "rgba(255,200,80,0.14)",
    border: "1px solid rgba(255,255,255,0.10)",
  },

  error: { color: "rgba(255,120,140,0.98)", fontWeight: 900 },
};
