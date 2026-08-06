"use client";

import { useEffect, useRef, useState } from "react";
import { SESSION_DATA } from "./sessions";

const APP_VERSION = "p2-2026-08-05"; // bump on deploy to verify auto-deploy went live

const TYPES = {
  teach: { label: "Teaching", color: "#4f8ef7" },
  studio: { label: "Practical", color: "#3dbf7a" },
  break: { label: "Break", color: "#e6b23c" },
  crit: { label: "Critique / Share", color: "#b07df0" },
  admin: { label: "Housekeeping", color: "#7a828f" },
};
const TARGET_MIN = SESSION_DATA.target; // 180 (3-hour contact target)
const TEACH_BUDGET = 45; // soft teaching-minutes budget per session

// ---- formatting -----------------------------------------------------------
const pad = (n) => String(n).padStart(2, "0");
function fmtMS(ms) {
  const neg = ms < 0;
  ms = Math.abs(ms);
  return `${neg ? "+" : ""}${pad(Math.floor(ms / 60000))}:${pad(
    Math.floor((ms % 60000) / 1000)
  )}`;
}
function fmtHM(ms) {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}
function fmtHMS(ms) {
  const t = Math.floor(ms / 1000);
  return `${Math.floor(t / 3600)}:${pad(Math.floor((t % 3600) / 60))}:${pad(
    t % 60
  )}`;
}

// ---- browser-storage persistence -----------------------------------------
const LS_PRESETS = "uxcap_presets_v1"; // { [sessionIdx]: [{name,min,type}] }
const LS_LIVE = "uxcap_live_v1"; // running-session snapshot
const lsGet = (k) => {
  try {
    return JSON.parse(localStorage.getItem(k));
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};
const lsDel = (k) => {
  try {
    localStorage.removeItem(k);
  } catch {}
};
function savePreset(s) {
  const all = lsGet(LS_PRESETS) || {};
  all[s.sessionIdx] = s.blocks.map((b) => ({
    name: b.name,
    min: b.plannedMin,
    type: b.type,
  }));
  lsSet(LS_PRESETS, all);
}
function saveLive(s) {
  if (s.phase === "idle" || s.phase === "done") {
    lsDel(LS_LIVE);
    return;
  }
  lsSet(LS_LIVE, {
    sessionIdx: s.sessionIdx,
    cur: s.cur,
    phase: s.phase,
    accumMs: s.accumMs,
    lastResume: s.lastResume,
    startedAt: s.startedAt,
    savedAt: Date.now(),
    blocks: s.blocks.map((b) => ({
      name: b.name,
      min: b.plannedMin,
      type: b.type,
      actualMs: b.actualMs,
      skipped: b.skipped,
    })),
  });
}

// ---- state model ----------------------------------------------------------
function makeSession(idx) {
  const src = SESSION_DATA.sessions[idx];
  return {
    sessionIdx: idx,
    blocks: src.blocks.map((b) => ({
      name: b.name,
      type: b.type,
      plannedMin: b.min,
      actualMs: null,
      skipped: false,
    })),
    homework: src.homework,
    cur: 0,
    phase: "idle", // idle | running | paused | done
    accumMs: 0,
    lastResume: null,
    startedAt: null,
  };
}
function applyPreset(base, stored) {
  if (Array.isArray(stored) && stored.length) {
    base.blocks = stored.map((b) => ({
      name: String(b.name),
      type: TYPES[b.type] ? b.type : "studio",
      plannedMin: Math.max(0, +b.min || 0),
      actualMs: null,
      skipped: false,
    }));
  }
  return base;
}
function restoreFromSnap(snap) {
  return {
    sessionIdx: snap.sessionIdx,
    blocks: snap.blocks.map((b) => ({
      name: b.name,
      type: TYPES[b.type] ? b.type : "studio",
      plannedMin: Math.max(0, +b.min || 0),
      actualMs: b.actualMs == null ? null : b.actualMs,
      skipped: !!b.skipped,
    })),
    homework: SESSION_DATA.sessions[snap.sessionIdx].homework,
    cur: Math.min(snap.cur, snap.blocks.length - 1),
    phase: snap.phase === "running" ? "running" : "paused",
    accumMs: snap.accumMs || 0,
    lastResume: snap.phase === "running" ? snap.lastResume : null,
    startedAt: snap.startedAt || Date.now(),
  };
}

const clone = (s) => ({ ...s, blocks: s.blocks.map((b) => ({ ...b })) });

function curElapsedMs(s) {
  return (
    s.accumMs +
    (s.phase === "running" && s.lastResume ? Date.now() - s.lastResume : 0)
  );
}
function totalElapsedMs(s) {
  let t = 0;
  for (let i = 0; i < s.cur; i++) t += s.blocks[i].actualMs || 0;
  if (s.phase !== "idle" && s.phase !== "done") t += curElapsedMs(s);
  return t;
}
function projectedTotalMs(s) {
  let t = 0;
  s.blocks.forEach((b, i) => {
    const plan = b.plannedMin * 60000;
    if (b.actualMs != null) t += b.actualMs;
    else if (b.skipped) t += 0;
    else if (i === s.cur && s.phase !== "idle" && s.phase !== "done")
      t += Math.max(curElapsedMs(s), plan);
    else t += plan;
  });
  return t;
}
function advancePastSkipped(s) {
  while (s.cur < s.blocks.length && s.blocks[s.cur].skipped) {
    s.blocks[s.cur].actualMs = 0;
    s.cur++;
  }
}

export default function Home() {
  const [state, setState] = useState(() => makeSession(0));
  const [, setTick] = useState(0);
  const [addName, setAddName] = useState("");
  const [addMin, setAddMin] = useState("10");
  const [addType, setAddType] = useState("studio");
  const [editingIndex, setEditingIndex] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [dropMark, setDropMark] = useState(null);
  const [resumeSnap, setResumeSnap] = useState(null);

  const hydratedRef = useRef(false);

  // Ticks while running so the derived countdown advances.
  useEffect(() => {
    if (state.phase !== "running") return;
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [state.phase]);

  // On mount (client only): apply saved edits for session 0 and detect a
  // running session left over from a refresh/close.
  useEffect(() => {
    const presets = lsGet(LS_PRESETS) || {};
    if (presets[0]) setState(applyPreset(makeSession(0), presets[0]));
    const snap = lsGet(LS_LIVE);
    const valid =
      snap &&
      typeof snap.sessionIdx === "number" &&
      SESSION_DATA.sessions[snap.sessionIdx] &&
      Array.isArray(snap.blocks) &&
      Date.now() - (snap.savedAt || 0) <= 6 * 3600 * 1000;
    if (valid) setResumeSnap(snap);
    else if (snap) lsDel(LS_LIVE);
    hydratedRef.current = true;
  }, []);

  // Persist agenda edits + live timing on every real state change. Held off
  // until hydration and while a resume prompt is pending (so we don't clobber
  // the snapshot the user hasn't decided on yet).
  useEffect(() => {
    if (!hydratedRef.current || resumeSnap) return;
    saveLive(state);
    savePreset(state);
  }, [state, resumeSnap]);

  // ---- resume prompt ------------------------------------------------------
  const doResume = () => {
    setEditingIndex(null);
    setState(restoreFromSnap(resumeSnap));
    setResumeSnap(null);
  };
  const discardResume = () => {
    lsDel(LS_LIVE);
    setResumeSnap(null);
  };

  // ---- actions ------------------------------------------------------------
  const loadSession = (idx) => {
    setEditingIndex(null);
    const presets = lsGet(LS_PRESETS) || {};
    setState(applyPreset(makeSession(idx), presets[idx]));
  };

  const startPause = () =>
    setState((prev) => {
      if (prev.phase === "done") return prev;
      const s = clone(prev);
      if (s.phase === "running") {
        s.accumMs = curElapsedMs(prev);
        s.lastResume = null;
        s.phase = "paused";
      } else {
        if (s.phase === "idle") {
          s.startedAt = Date.now();
          advancePastSkipped(s);
        }
        if (s.cur >= s.blocks.length) {
          s.phase = "done";
          s.lastResume = null;
          return s;
        }
        s.lastResume = Date.now();
        s.phase = "running";
      }
      return s;
    });

  const nextBlock = () =>
    setState((prev) => {
      if (prev.phase === "idle" || prev.phase === "done") return prev;
      const s = clone(prev);
      s.blocks[s.cur].actualMs = curElapsedMs(prev);
      s.cur++;
      advancePastSkipped(s);
      s.accumMs = 0;
      if (s.cur >= s.blocks.length) {
        s.phase = "done";
        s.lastResume = null;
      } else {
        s.lastResume = Date.now();
        if (s.phase === "paused") s.phase = "running";
      }
      return s;
    });

  const resetAll = () => {
    if (
      state.phase !== "idle" &&
      !window.confirm("Reset this session's timer? Timing is cleared.")
    )
      return;
    setEditingIndex(null);
    lsDel(LS_LIVE);
    const presets = lsGet(LS_PRESETS) || {};
    setState(applyPreset(makeSession(state.sessionIdx), presets[state.sessionIdx]));
  };

  const restoreDefaults = () => {
    if (!window.confirm("Restore this session's default agenda? Saved edits are discarded."))
      return;
    setEditingIndex(null);
    const all = lsGet(LS_PRESETS) || {};
    delete all[state.sessionIdx];
    lsSet(LS_PRESETS, all);
    setState(makeSession(state.sessionIdx));
  };

  // per-item edit mode
  const patchBlock = (i, patch) =>
    setState((prev) => {
      const b = prev.blocks[i];
      if (!b || b.actualMs != null || prev.phase === "done") return prev;
      const s = clone(prev);
      s.blocks[i] = { ...s.blocks[i], ...patch };
      return s;
    });
  const setName = (i, v) => patchBlock(i, { name: v });
  const setType = (i, v) => patchBlock(i, { type: v });
  const setMinutes = (i, raw) => {
    const n = parseInt(raw, 10);
    patchBlock(i, { plannedMin: Number.isNaN(n) ? 0 : Math.max(0, n) });
  };

  const adjust = (i, deltaMin) =>
    setState((prev) => {
      const b = prev.blocks[i];
      if (!b || b.actualMs != null || b.skipped || prev.phase === "done")
        return prev;
      const s = clone(prev);
      s.blocks[i].plannedMin = Math.max(0, s.blocks[i].plannedMin + deltaMin);
      return s;
    });

  const toggleSkip = (i) =>
    setState((prev) => {
      const b = prev.blocks[i];
      if (!b || b.actualMs != null || prev.phase === "done") return prev;
      if (i === prev.cur && prev.phase !== "idle") return prev;
      const s = clone(prev);
      s.blocks[i].skipped = !s.blocks[i].skipped;
      return s;
    });

  const removeBlock = (i) => {
    const b = state.blocks[i];
    if (!b || b.actualMs != null || state.phase === "done") return;
    if (i === state.cur && state.phase !== "idle") return;
    if (!window.confirm(`Remove "${b.name}"?`)) return;
    setEditingIndex(null);
    setState((prev) => {
      const s = clone(prev);
      s.blocks.splice(i, 1);
      if (i < s.cur) s.cur--;
      return s;
    });
  };

  const submitAdd = () => {
    setEditingIndex(null);
    setState((prev) => {
      if (prev.phase === "done") return prev;
      const s = clone(prev);
      const min = Math.max(0, Math.min(120, parseInt(addMin, 10) || 10));
      const type = TYPES[addType] ? addType : "studio";
      s.blocks.splice(s.cur + 1, 0, {
        name: addName.trim() || "Extra studio time",
        type,
        plannedMin: min,
        actualMs: null,
        skipped: false,
      });
      return s;
    });
    setAddName("");
  };

  // drag reorder (future blocks only; past/current locked)
  const moveBlock = (from, to) =>
    setState((prev) => {
      if (prev.phase === "done") return prev;
      const minIns = prev.phase === "idle" ? 0 : prev.cur + 1;
      if (from < minIns || from >= prev.blocks.length) return prev;
      to = Math.max(minIns, Math.min(to, prev.blocks.length));
      if (to === from || to === from + 1) return prev;
      const s = clone(prev);
      const [b] = s.blocks.splice(from, 1);
      s.blocks.splice(to > from ? to - 1 : to, 0, b);
      return s;
    });

  // ---- derived ------------------------------------------------------------
  const s = state;
  const running = s.phase === "running";
  const done = s.phase === "done";
  const idle = s.phase === "idle";
  const curIndex = Math.min(s.cur, s.blocks.length - 1);
  const cur = s.blocks[curIndex];
  const curPlanMs = cur.plannedMin * 60000;
  const elapsed = idle || done ? 0 : curElapsedMs(s);
  const remaining = curPlanMs - elapsed;
  const over = remaining < 0;
  const minIns = idle ? 0 : s.cur + 1;

  const projMs = projectedTotalMs(s);
  const deltaMin = Math.round((projMs - TARGET_MIN * 60000) / 60000);
  const pillClass = deltaMin > 0 ? "over" : deltaMin < 0 ? "under" : "ok";
  const pillText =
    deltaMin === 0
      ? `On target · ${fmtHM(projMs)}`
      : deltaMin > 0
      ? `+${deltaMin} min over · ${fmtHM(projMs)}`
      : `${Math.abs(deltaMin)} min under 3:00 · ${fmtHM(projMs)}`;

  const teachPlan = s.blocks
    .filter((b) => b.type === "teach" && !b.skipped)
    .reduce((a, b) => a + b.plannedMin, 0);
  const teachUsed = Math.round(
    s.blocks
      .filter((b) => b.type === "teach")
      .reduce((a, b) => a + (b.actualMs || 0), 0) /
      60000 +
      (cur.type === "teach" &&
      !idle &&
      !done &&
      s.blocks[s.cur] &&
      s.blocks[s.cur].actualMs == null
        ? elapsed / 60000
        : 0)
  );

  let nj = s.cur + 1;
  while (nj < s.blocks.length && s.blocks[nj].skipped) nj++;
  const nextBlockObj = s.blocks[nj];

  const doneTotal = done
    ? s.blocks.reduce((a, b) => a + (b.actualMs || 0), 0)
    : 0;
  const doneDelta = doneTotal - TARGET_MIN * 60000;

  const wrap =
    s.startedAt && !done
      ? new Date(Date.now() + (projMs - totalElapsedMs(s))).toLocaleTimeString(
          [],
          { hour: "numeric", minute: "2-digit" }
        )
      : "";

  useEffect(() => {
    if (done) document.title = "Session complete";
    else
      document.title =
        (over && !idle ? "OVER " : "") +
        fmtMS(idle ? curPlanMs : remaining) +
        " · " +
        cur.name;
  });

  const startLabel = running ? "⏸ Pause" : idle ? "▶ Start" : "▶ Resume";
  const nextLabel =
    s.cur === s.blocks.length - 1 ? "Finish session ✓" : "Next block ▸";

  return (
    <main className="app">
      <header className="app-header">
        <h1>UX Capstone · Session Timer</h1>
        <select
          className="session-select"
          value={s.sessionIdx}
          onChange={(e) => loadSession(Number(e.target.value))}
          aria-label="Session"
        >
          {SESSION_DATA.sessions.map((sess, i) => (
            <option key={i} value={i}>
              {sess.name}
            </option>
          ))}
        </select>
        <button className="btn-primary" onClick={startPause} disabled={done}>
          {startLabel}
        </button>
        <button onClick={nextBlock} disabled={idle || done}>
          {nextLabel}
        </button>
        <button className="btn-warn" onClick={resetAll}>
          Reset
        </button>
        <div className={"pill " + pillClass}>{pillText}</div>
      </header>

      {resumeSnap && (
        <div className="resume-banner">
          <span>
            Resume the session in progress? (
            {SESSION_DATA.sessions[resumeSnap.sessionIdx].name.split(":")[0]},
            block {resumeSnap.cur + 1} of {resumeSnap.blocks.length})
          </span>
          <span className="resume-actions">
            <button className="btn-primary" onClick={doResume}>
              Resume
            </button>
            <button onClick={discardResume}>Discard</button>
          </span>
        </div>
      )}

      <div className="layout">
        {/* ---- left column: NOW + homework ---- */}
        <div className="col">
          <section className="card now">
            {done ? (
              <>
                <div className="nowlabel">Session complete</div>
                <div className="block-name">
                  {SESSION_DATA.sessions[s.sessionIdx].name.split(":")[0].trim()}
                </div>
                <div className="clock">{fmtHMS(doneTotal)}</div>
                <div
                  className="done-banner"
                  style={{ color: doneDelta >= 0 ? "var(--ok)" : "var(--over)" }}
                >
                  {doneDelta >= 0
                    ? `3-hour mark met (+${Math.round(
                        doneDelta / 60000
                      )} min), contact hours banked ✓`
                    : `⚠ ${Math.round(
                        -doneDelta / 60000
                      )} min short of the 3-hour mark`}
                </div>
              </>
            ) : (
              <>
                <div className="nowlabel">
                  {idle ? "Ready. Press Start" : running ? "Now" : "Paused"}
                </div>
                <div className="block-name">{cur.name}</div>
                <div
                  className="block-type"
                  style={{ color: TYPES[cur.type].color }}
                >
                  {TYPES[cur.type].label}
                </div>
                <div className={"clock" + (over && !idle ? " overtime" : "")}>
                  {fmtMS(idle ? curPlanMs : remaining)}
                </div>
                <div className="subclock">
                  {idle
                    ? "planned"
                    : over
                    ? "over. Advance when ready"
                    : `remaining of ${cur.plannedMin} min`}
                </div>
                <div className="blockbar">
                  <div
                    style={{
                      width:
                        (idle
                          ? 0
                          : Math.min(
                              100,
                              curPlanMs === 0 ? 100 : (elapsed / curPlanMs) * 100
                            )) + "%",
                      background: over ? "var(--over)" : TYPES[cur.type].color,
                    }}
                  />
                </div>
                <div className="nextup">
                  {nextBlockObj ? (
                    <>
                      Up next: <b>{nextBlockObj.name}</b> ·{" "}
                      {nextBlockObj.plannedMin} min
                    </>
                  ) : (
                    "Final block"
                  )}
                </div>
                <div className="quick">
                  <button onClick={() => adjust(curIndex, -5)} disabled={done}>
                    −5 min
                  </button>
                  <button onClick={() => adjust(curIndex, -1)} disabled={done}>
                    −1 min
                  </button>
                  <button onClick={() => adjust(curIndex, 1)} disabled={done}>
                    +1 min
                  </button>
                  <button onClick={() => adjust(curIndex, 5)} disabled={done}>
                    +5 min
                  </button>
                </div>
              </>
            )}
          </section>

          <section
            className={
              "card hwcard" +
              (!done && !idle && s.cur === s.blocks.length - 1 ? " active" : "")
            }
          >
            <h2 className="hw-title">
              {s.homework.length ? "This week's homework" : "Homework"}
            </h2>
            {s.homework.length ? (
              <ul className="hw">
                {s.homework.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            ) : (
              <p className="none">None. That&apos;s a wrap on the capstone. 🎓</p>
            )}
          </section>
        </div>

        {/* ---- right column: agenda (read view) ---- */}
        <section className="card agenda">
          <h2 className="agenda-title">
            {SESSION_DATA.sessions[s.sessionIdx].name}
          </h2>

          <div className="sessionbar">
            {s.blocks.map((b, i) => {
              const planMs = b.plannedMin * 60000;
              const fillPct =
                b.actualMs != null
                  ? 100
                  : i === s.cur && !idle && !done
                  ? Math.min(100, planMs === 0 ? 100 : (elapsed / planMs) * 100)
                  : 0;
              return (
                <div
                  key={i}
                  className="seg"
                  style={{
                    flex: b.skipped ? "0.6" : String(Math.max(b.plannedMin, 0.5)),
                    opacity: b.skipped ? 0.3 : 1,
                  }}
                >
                  <i
                    style={{
                      width: fillPct + "%",
                      background: TYPES[b.type].color,
                    }}
                  />
                </div>
              );
            })}
          </div>

          <div className="meta-line">
            <span>
              Elapsed {fmtHM(totalElapsedMs(s))} / {fmtHM(TARGET_MIN * 60000)}
            </span>
            <span>{wrap ? `Projected wrap ${wrap}` : ""}</span>
          </div>

          <table className="agenda-table">
            <thead>
              <tr>
                <th></th>
                <th></th>
                <th>Block</th>
                <th></th>
                <th>Plan</th>
                <th>Actual</th>
                <th>Adjust</th>
              </tr>
            </thead>
            <tbody>
              {s.blocks.map((b, i) => {
                const meta = TYPES[b.type] || TYPES.studio;
                const isPast = b.actualMs != null;
                const isCurrent = i === s.cur && !done;
                const lockLive = i === s.cur && !idle;
                const dm = isPast
                  ? Math.round((b.actualMs - b.plannedMin * 60000) / 60000)
                  : 0;
                const editable = !isPast && !done;

                if (editable && editingIndex === i) {
                  return (
                    <tr
                      key={i}
                      className={"editing" + (b.skipped ? " skipped" : "")}
                    >
                      <td className="drag-handle">⠿</td>
                      <td>
                        <span
                          className="dot"
                          style={{ background: meta.color }}
                        />
                      </td>
                      <td colSpan={5}>
                        <div className="edit-row">
                          <input
                            type="text"
                            value={b.name}
                            aria-label="Block name"
                            autoFocus
                            onChange={(e) => setName(i, e.target.value)}
                            onKeyDown={(e) =>
                              e.key === "Enter" && setEditingIndex(null)
                            }
                          />
                          <input
                            type="number"
                            min="0"
                            value={b.plannedMin}
                            aria-label="Minutes"
                            onChange={(e) => setMinutes(i, e.target.value)}
                          />
                          <select
                            value={b.type}
                            aria-label="Type"
                            onChange={(e) => setType(i, e.target.value)}
                          >
                            {Object.entries(TYPES).map(([k, t]) => (
                              <option key={k} value={k}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn-primary"
                            onClick={() => setEditingIndex(null)}
                          >
                            ✓ Done
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }

                const canDrag = !done && i >= minIns;
                return (
                  <tr
                    key={i}
                    draggable={canDrag}
                    onDragStart={
                      canDrag
                        ? (e) => {
                            setDragIdx(i);
                            try {
                              e.dataTransfer.effectAllowed = "move";
                            } catch {}
                          }
                        : undefined
                    }
                    onDragEnd={() => {
                      setDragIdx(null);
                      setDropMark(null);
                    }}
                    onDragOver={(e) => {
                      if (dragIdx == null || dragIdx === i || i < minIns) return;
                      e.preventDefault();
                      const r = e.currentTarget.getBoundingClientRect();
                      setDropMark({
                        i,
                        before: e.clientY < r.top + r.height / 2,
                      });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragIdx == null) return;
                      const r = e.currentTarget.getBoundingClientRect();
                      const before = e.clientY < r.top + r.height / 2;
                      const from = dragIdx;
                      setDragIdx(null);
                      setDropMark(null);
                      moveBlock(from, i + (before ? 0 : 1));
                    }}
                    className={
                      (isPast ? "done" : isCurrent ? "current" : "") +
                      (b.skipped ? " skipped" : "") +
                      (i === dragIdx ? " dragging" : "") +
                      (dropMark && dropMark.i === i
                        ? dropMark.before
                          ? " drop-above"
                          : " drop-below"
                        : "")
                    }
                  >
                    <td
                      className="drag-handle"
                      title={canDrag ? "Drag to reorder" : ""}
                      style={{ cursor: canDrag ? "grab" : "default" }}
                    >
                      ⠿
                    </td>
                    <td>
                      <span
                        className="dot"
                        style={{ background: meta.color }}
                      />
                    </td>
                    <td className="bname">{b.name}</td>
                    <td>
                      <span
                        className="tag"
                        style={{ color: meta.color, borderColor: meta.color }}
                      >
                        {b.type}
                      </span>
                    </td>
                    <td className="plan">{b.plannedMin}m</td>
                    <td
                      className={
                        "actual" +
                        (isPast
                          ? b.actualMs > b.plannedMin * 60000 + 30000
                            ? " over"
                            : " under-t"
                          : "")
                      }
                    >
                      {b.skipped
                        ? "skipped"
                        : isPast
                        ? fmtMS(b.actualMs).replace("+", "") +
                          (dm !== 0 ? ` (${dm > 0 ? "+" : ""}${dm})` : "")
                        : "–"}
                    </td>
                    <td>
                      <div className="adj">
                        <button
                          onClick={() => adjust(i, -1)}
                          disabled={isPast || b.skipped || done}
                        >
                          −1
                        </button>
                        <button
                          onClick={() => adjust(i, 1)}
                          disabled={isPast || b.skipped || done}
                        >
                          +1
                        </button>
                        <button
                          onClick={() => toggleSkip(i)}
                          disabled={isPast || done || lockLive}
                          title={b.skipped ? "Un-skip" : "Skip block"}
                        >
                          {b.skipped ? "↺" : "⏭"}
                        </button>
                        <button
                          onClick={() => removeBlock(i)}
                          disabled={isPast || done || lockLive}
                          title="Remove block"
                        >
                          ✕
                        </button>
                        {editable && (
                          <button
                            onClick={() => setEditingIndex(i)}
                            title="Edit name, minutes, or type"
                          >
                            ✎
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="addform">
            <input
              type="text"
              placeholder="New block name (e.g., Extra studio help)"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitAdd()}
            />
            <input
              type="number"
              min="0"
              max="120"
              value={addMin}
              aria-label="Minutes"
              onChange={(e) => setAddMin(e.target.value)}
            />
            <select
              value={addType}
              aria-label="Type"
              onChange={(e) => setAddType(e.target.value)}
            >
              {Object.entries(TYPES).map(([k, t]) => (
                <option key={k} value={k}>
                  {t.label}
                </option>
              ))}
            </select>
            <button onClick={submitAdd} disabled={done}>
              ＋ Add below current
            </button>
            <button onClick={restoreDefaults} title="Restore default agenda">
              ↺ defaults
            </button>
          </div>

          <div className="teachline">
            Teaching budget: <b>{teachPlan} min planned</b> (target ≤{" "}
            {TEACH_BUDGET}) · {teachUsed} min used
            <div className="teachmeter">
              <span
                style={{
                  width: Math.min(100, (teachPlan / TEACH_BUDGET) * 100) + "%",
                  background: teachPlan > TEACH_BUDGET ? "var(--over)" : "var(--ok)",
                }}
              />
            </div>
          </div>
        </section>
      </div>

      <footer className="app-footer" data-build={APP_VERSION}>
        Target 3:00:00 per session · 7 sessions × 3 hrs = 21 contact hours ·
        completed blocks lock · drag ⠿ to reorder · edits &amp; a running session
        are saved in this browser.{" "}
        <span className="build">{`build ${APP_VERSION}`}</span>
      </footer>
    </main>
  );
}
