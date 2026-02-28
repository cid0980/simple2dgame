import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "./firebase";

type ScreenMode = "lobby" | "game";
type HazardKind = "bubble" | "meteor" | "drone";
type Hazard = {
  id: number;
  kind: HazardKind;
  x: number;
  y: number;
  size: number;
  speed: number;
  wobble: number;
  wobbleFreq: number;
  age: number;
  weight: number;
};
type Coin = { id: number; x: number; y: number; ttl: number };
type Pulse = { id: number; x: number; y: number; age: number; ttl: number; maxRadius: number };
type LeaderboardEntry = { id: string; username: string; score: number; date: number };
type Skin = { id: string; name: string; price: number; fill: string; glow: string };
type WavePhase = {
  name: string;
  spawnMultiplier: number;
  speedMultiplier: number;
  patternChance: number;
  extraSpawnChance: number;
};

const BOARD_W = 340;
const BOARD_H = 500;
const PLAYER_SIZE = 28;
const BASE_SPEED = 220;
const BASE_COOLDOWN = 1.7;

const DEFAULT_PIN = "1234";
const LEADERBOARD_COLLECTION = "leaderboard";
const ACCOUNTS_COLLECTION = "accounts";

const BEST_KEY = "pixel-best";
const COIN_KEY = "pixel-coins";
const MOVE_KEY = "pixel-move-level";
const ATTACK_KEY = "pixel-attack-level";
const ATTACK_CD_KEY = "pixel-attack-cooldown";
const SOUND_KEY = "pixel-sound-enabled";
const USERNAME_KEY = "pixel-username";
const SESSION_KEY = "pixel-session-authed";
const SKIN_KEY = "pixel-skin-selected";
const SKIN_UNLOCK_KEY = "pixel-skin-unlocked";

const SKINS: Skin[] = [
  { id: "neon", name: "Neon", price: 0, fill: "linear-gradient(135deg,#67e8f9,#14b8a6)", glow: "0 0 26px rgba(45,212,191,0.65)" },
  { id: "amber", name: "Amber", price: 20, fill: "linear-gradient(135deg,#fde68a,#f59e0b)", glow: "0 0 26px rgba(251,191,36,0.65)" },
  { id: "rose", name: "Rose", price: 28, fill: "linear-gradient(135deg,#fda4af,#fb7185)", glow: "0 0 26px rgba(251,113,133,0.65)" },
  { id: "lime", name: "Lime", price: 34, fill: "linear-gradient(135deg,#bef264,#22c55e)", glow: "0 0 26px rgba(74,222,128,0.65)" },
];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const random = (min: number, max: number) => Math.random() * (max - min) + min;
const normalizeName = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 18);
const toNameKey = (value: string) =>
  normalizeName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "player";
const moveCost = (level: number) => 8 + level * 6;
const attackCost = (level: number) => 10 + level * 7;
const lanePatterns: number[][] = [
  [0, 1, 2, 3, 4],
  [4, 3, 2, 1, 0],
  [0, 2, 4],
  [4, 2, 0],
  [1, 3, 1, 3],
  [0, 1, 3, 4],
  [2, 1, 2, 3],
];

const weightByKind = (kind: HazardKind) => {
  if (kind === "meteor") return 3;
  if (kind === "drone") return 2;
  return 1;
};

const getWavePhase = (elapsed: number): WavePhase => {
  const cycle = elapsed % 85;
  if (cycle < 20) {
    return {
      name: "Wave 1 - Warmup",
      spawnMultiplier: 0.9,
      speedMultiplier: 0.88,
      patternChance: 0.2,
      extraSpawnChance: 0,
    };
  }
  if (cycle < 45) {
    return {
      name: "Wave 2 - Crossfire",
      spawnMultiplier: 1,
      speedMultiplier: 1,
      patternChance: 0.45,
      extraSpawnChance: 0.15,
    };
  }
  if (cycle < 75) {
    return {
      name: "Wave 3 - Pattern Storm",
      spawnMultiplier: 1.15,
      speedMultiplier: 1.2,
      patternChance: 0.75,
      extraSpawnChance: 0.34,
    };
  }
  return {
    name: "Wave 4 - Breather",
    spawnMultiplier: 0.75,
    speedMultiplier: 0.78,
    patternChance: 0.1,
    extraSpawnChance: 0,
  };
};

export function App() {
  const [screenMode, setScreenMode] = useState<ScreenMode>("lobby");
  const [showSettings, setShowSettings] = useState(false);
  const [showLevelUp, setShowLevelUp] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  const [isTouch, setIsTouch] = useState(false);
  const [boardScale, setBoardScale] = useState(1);

  const [userName, setUserName] = useState("Player");
  const [nameDraft, setNameDraft] = useState("Player");
  const [pinDraft, setPinDraft] = useState(DEFAULT_PIN);
  const [showPin, setShowPin] = useState(false);
  const [sessionAuthed, setSessionAuthed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SESSION_KEY) === "1";
  });
  const [accountKey, setAccountKey] = useState("");
  const hasConfirmedName = sessionAuthed;
  const setHasConfirmedName = (_value: boolean) => setSessionAuthed(false);
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [leaderboardStatus, setLeaderboardStatus] = useState<"loading" | "ready" | "error">("loading");
  const [coinSyncStatus, setCoinSyncStatus] = useState<"idle" | "syncing" | "ok" | "error">("idle");
  const [championToast, setChampionToast] = useState("");
  const [toast, setToast] = useState("");

  const [player, setPlayer] = useState({ x: BOARD_W / 2 - PLAYER_SIZE / 2, y: BOARD_H - 74 });
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [coins, setCoins] = useState<Coin[]>([]);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [coinBank, setCoinBank] = useState(0);
  const [runCoins, setRunCoins] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [attackCooldown, setAttackCooldown] = useState(0);
  const [lastAttackText, setLastAttackText] = useState("No attack yet");
  const [waveLabel, setWaveLabel] = useState("Wave 1 - Warmup");
  const [adaptiveLabel, setAdaptiveLabel] = useState("Adaptive: neutral");

  const [moveLevel, setMoveLevel] = useState(0);
  const [attackLevel, setAttackLevel] = useState(0);
  const [skinId, setSkinId] = useState("neon");
  const [unlockedSkins, setUnlockedSkins] = useState<string[]>(["neon"]);

  const [joystickVisual, setJoystickVisual] = useState({ x: 0, y: 0, active: false });

  const playerRef = useRef(player);
  const hazardsRef = useRef<Hazard[]>([]);
  const coinsRef = useRef<Coin[]>([]);
  const pulsesRef = useRef<Pulse[]>([]);
  const scoreRef = useRef(0);
  const attackCooldownRef = useRef(0);
  const elapsedRef = useRef(0);
  const spawnRef = useRef(0);
  const coinRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const idRef = useRef(1);
  const runningRef = useRef(false);
  const keysRef = useRef<Set<string>>(new Set());
  const touchRef = useRef({ x: 0, y: 0, active: false });
  const joystickPointerRef = useRef<number | null>(null);
  const submittedRef = useRef(false);
  const audioRef = useRef<AudioContext | null>(null);
  const patternQueueRef = useRef<number[]>([]);
  const adaptiveRef = useRef(0);
  const lastScoreProbeRef = useRef(0);

  const topThree = leaderboard.slice(0, 3);
  const moveSpeed = BASE_SPEED + moveLevel * 28;
  const currentSkin = useMemo(() => SKINS.find((entry) => entry.id === skinId) ?? SKINS[0], [skinId]);
  const baseCooldown = useMemo(() => clamp(BASE_COOLDOWN - attackLevel * 0.16, 0.35, 1.7), [attackLevel]);

  useEffect(() => {
    const savedName = normalizeName(window.localStorage.getItem(USERNAME_KEY) ?? "");
    const savedSession = window.localStorage.getItem(SESSION_KEY) === "1";

    if (savedName) {
      setUserName(savedName);
      setNameDraft(savedName);
    }

    if (savedSession && savedName && savedName.toLowerCase() !== "player") {
      setSessionAuthed(true);
      setAccountKey(toNameKey(savedName));
      setShowSettings(false);
      setAuthError("");
      return;
    }

    setSessionAuthed(false);
    setShowSettings(true);
    setAuthError("Login/register first, then play.");
  }, []);

  useEffect(() => {
    const savedCooldownRaw = window.localStorage.getItem(ATTACK_CD_KEY);
    const savedCooldown = savedCooldownRaw ? Number(savedCooldownRaw) : 0;
    if (!Number.isFinite(savedCooldown) || savedCooldown <= 0) return;
    const normalized = clamp(savedCooldown, 0, 12);
    setAttackCooldown(normalized);
    attackCooldownRef.current = normalized;
  }, []);

  const playTone = useCallback(
    (frequency: number, duration = 0.08, type: OscillatorType = "sine", gainValue = 0.04) => {
      if (!soundEnabled) return;
      try {
        if (!audioRef.current) audioRef.current = new window.AudioContext();
        const context = audioRef.current;
        if (context.state === "suspended") void context.resume();
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(frequency, context.currentTime);
        gain.gain.setValueAtTime(gainValue, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
        osc.connect(gain);
        gain.connect(context.destination);
        osc.start();
        osc.stop(context.currentTime + duration);
      } catch {
        
      }
    },
    [soundEnabled],
  );

  const fetchLeaderboard = useCallback(async () => {
    try {
      setLeaderboardStatus("loading");
      const q = query(collection(db, LEADERBOARD_COLLECTION), orderBy("score", "desc"), limit(50));
      const snapshot = await getDocs(q);
      const rows = snapshot.docs.map((entry) => {
        const data = entry.data();
        return {
          id: entry.id,
          username: typeof data.username === "string" ? data.username : "Player",
          score: typeof data.score === "number" ? Math.floor(data.score) : 0,
          date: typeof data.date === "number" ? data.date : Date.now(),
        };
      });
      setLeaderboard(rows);
      setLeaderboardStatus("ready");
      return rows;
    } catch {
      setLeaderboardStatus("error");
      return [] as LeaderboardEntry[];
    }
  }, []);

  const submitScore = useCallback(
    async (value: number) => {
      const cleanName = normalizeName(userName);
      if (!cleanName || cleanName.toLowerCase() === "player") return;
      const scoreValue = Math.max(0, Math.floor(value));
      const rowRef = doc(db, LEADERBOARD_COLLECTION, toNameKey(cleanName));

      try {
        await runTransaction(db, async (transaction) => {
          const row = await transaction.get(rowRef);
          if (!row.exists()) {
            transaction.set(rowRef, {
              username: cleanName,
              score: scoreValue,
              date: Date.now(),
              createdAt: serverTimestamp(),
            });
            return;
          }
          const prev = typeof row.data().score === "number" ? row.data().score : 0;
          if (scoreValue > prev || row.data().username !== cleanName) {
            transaction.update(rowRef, {
              username: cleanName,
              score: Math.max(prev, scoreValue),
              date: Date.now(),
              createdAt: row.data().createdAt,
            });
          }
        });
      } catch {
        
      }

      const updated = await fetchLeaderboard();
      if (updated.length > 0 && updated[0].id === toNameKey(cleanName)) {
        setChampionToast(`Champion! ${cleanName} is now #1`);
        playTone(740, 0.12, "triangle", 0.05);
        playTone(920, 0.12, "sine", 0.04);
      }
    },
    [fetchLeaderboard, playTone, userName],
  );

  const handleSaveProfile = useCallback(async () => {
    const cleanName = normalizeName(nameDraft);
    const cleanPin = pinDraft.replace(/\D/g, "").slice(0, 8);

    if (!cleanName || cleanName.toLowerCase() === "player") {
      setAuthError("Choose a unique username.");
      return;
    }
    if (cleanPin.length < 4) {
      setAuthError("PIN must be 4-8 digits.");
      return;
    }

    setAuthBusy(true);
    setAuthError("");

    try {
      const key = toNameKey(cleanName);
      const accountRef = doc(db, ACCOUNTS_COLLECTION, key);
      const accountSnap = await getDoc(accountRef);

      if (!accountSnap.exists()) {
        await setDoc(accountRef, {
          username: cleanName,
          pin: cleanPin,
          coins: coinBank,
          moveLevel,
          attackLevel,
          attackCooldown: Number(attackCooldown.toFixed(2)),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        const accountData = accountSnap.data();
        const storedPin = typeof accountData.pin === "string" ? accountData.pin : DEFAULT_PIN;
        if (storedPin !== cleanPin) {
          setAuthError("Wrong PIN for this username.");
          return;
        }

        const cloudCoins = typeof accountData.coins === "number" ? Math.max(0, Math.floor(accountData.coins)) : null;
        const cloudMoveLevel = typeof accountData.moveLevel === "number" ? clamp(Math.floor(accountData.moveLevel), 0, 8) : null;
        const cloudAttackLevel = typeof accountData.attackLevel === "number" ? clamp(Math.floor(accountData.attackLevel), 0, 8) : null;
        const cloudAttackCooldown =
          typeof accountData.attackCooldown === "number" ? clamp(Number(accountData.attackCooldown), 0, 12) : null;
        if (cloudCoins !== null) {
          setCoinBank(cloudCoins);
          window.localStorage.setItem(COIN_KEY, String(cloudCoins));
        }
        if (cloudMoveLevel !== null) {
          setMoveLevel(cloudMoveLevel);
          window.localStorage.setItem(MOVE_KEY, String(cloudMoveLevel));
        }
        if (cloudAttackLevel !== null) {
          setAttackLevel(cloudAttackLevel);
          window.localStorage.setItem(ATTACK_KEY, String(cloudAttackLevel));
        }
        if (cloudAttackCooldown !== null) {
          setAttackCooldown(cloudAttackCooldown);
          attackCooldownRef.current = cloudAttackCooldown;
          window.localStorage.setItem(ATTACK_CD_KEY, String(cloudAttackCooldown));
        }
      }

      const leaderboardRef = doc(db, LEADERBOARD_COLLECTION, key);
      const leaderboardSnap = await getDoc(leaderboardRef);
      if (!leaderboardSnap.exists()) {
        await setDoc(leaderboardRef, {
          username: cleanName,
          score: 0,
          date: Date.now(),
          createdAt: serverTimestamp(),
        });
      }

      setUserName(cleanName);
      setNameDraft(cleanName);
      setPinDraft(cleanPin);
      setSessionAuthed(true);
      setAccountKey(key);
      window.localStorage.setItem(USERNAME_KEY, cleanName);
      window.localStorage.setItem(SESSION_KEY, "1");
      setShowSettings(false);
      setToast(`Name saved as "${cleanName}"`);
      playTone(760, 0.08, "triangle", 0.05);
      await fetchLeaderboard();
    } catch {
      setAuthError("Login failed. Please update Firebase rules.");
    } finally {
      setAuthBusy(false);
    }
  }, [attackLevel, coinBank, fetchLeaderboard, moveLevel, nameDraft, pinDraft, playTone]);

  useEffect(() => {
    if (!sessionAuthed || !accountKey) return;

    const timer = window.setTimeout(async () => {
      try {
        await setDoc(
          doc(db, ACCOUNTS_COLLECTION, accountKey),
          {
            moveLevel,
            attackLevel,
            attackCooldown: Number(attackCooldown.toFixed(2)),
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      } catch {
        
      }
    }, 280);

    return () => window.clearTimeout(timer);
  }, [accountKey, attackCooldown, attackLevel, moveLevel, sessionAuthed]);

  useEffect(() => {
    window.localStorage.setItem(ATTACK_CD_KEY, String(Number(attackCooldown.toFixed(2))));
  }, [attackCooldown]);

  const spawnHazard = useCallback(() => {
    const difficulty = clamp(elapsedRef.current / 55, 0, 1);
    const wave = getWavePhase(elapsedRef.current);
    const adaptive = adaptiveRef.current;

    if (wave.spawnMultiplier < 1 && Math.random() > wave.spawnMultiplier) {
      return;
    }

    const kinds: HazardKind[] = ["bubble", "meteor", "drone"];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const sizeBoost = Math.random() < 0.28 + difficulty * 0.1 ? 1 : 0;
    const size = kind === "bubble" ? 30 + sizeBoost * 8 : kind === "meteor" ? 34 + sizeBoost * 10 : 27 + sizeBoost * 7;
    const weight = weightByKind(kind) + sizeBoost;
    const baseSpeed = kind === "bubble" ? 72 : kind === "meteor" ? 80 : 96;

    if (patternQueueRef.current.length === 0 && Math.random() < wave.patternChance) {
      const chosen = lanePatterns[Math.floor(Math.random() * lanePatterns.length)];
      patternQueueRef.current = [...chosen];
    }
    const lane = patternQueueRef.current.length > 0 ? patternQueueRef.current.shift() ?? Math.floor(random(0, 5)) : Math.floor(random(0, 5));
    const laneCount = 5;
    const laneStep = BOARD_W / laneCount;
    const laneCenter = lane * laneStep + laneStep / 2;
    const rawX = laneCenter - size / 2 + random(-laneStep * 0.18, laneStep * 0.18);

    const hazard: Hazard = {
      id: idRef.current++,
      kind,
      x: clamp(rawX, 8, BOARD_W - size - 8),
      y: -size - 2,
      size,
      speed: clamp((baseSpeed + random(-8, 8) + difficulty * 84) * wave.speedMultiplier * (1 + adaptive * 0.32), 56, 260),
      wobble: random(-14, 14),
      wobbleFreq: random(1.4, 3.2),
      age: 0,
      weight,
    };
    hazardsRef.current = [...hazardsRef.current, hazard];

    if (Math.random() < wave.extraSpawnChance + adaptive * 0.2) {
      const mirroredLane = 4 - lane;
      const mirrorSize = Math.max(24, size - 4);
      const mirrorCenter = mirroredLane * laneStep + laneStep / 2;
      hazardsRef.current = [
        ...hazardsRef.current,
        {
          id: idRef.current++,
          kind,
          x: clamp(mirrorCenter - mirrorSize / 2 + random(-laneStep * 0.15, laneStep * 0.15), 8, BOARD_W - mirrorSize - 8),
          y: -mirrorSize - 12,
          size: mirrorSize,
          speed: clamp((baseSpeed + random(-10, 10) + difficulty * 92) * wave.speedMultiplier * 0.95 * (1 + adaptive * 0.28), 56, 260),
          wobble: random(-10, 10),
          wobbleFreq: random(1.5, 3),
          age: 0,
          weight: Math.max(1, weight - 1),
        },
      ];
    } else if (wave.spawnMultiplier > 1 && Math.random() < wave.spawnMultiplier - 1) {
      const laneCount = 5;
      const laneStep = BOARD_W / laneCount;
      const sideLane = Math.random() < 0.5 ? 0 : 4;
      const sideCenter = sideLane * laneStep + laneStep / 2;
      const sideSize = Math.max(24, size - 6);
      hazardsRef.current = [
        ...hazardsRef.current,
        {
          id: idRef.current++,
          kind: Math.random() < 0.5 ? "bubble" : "drone",
          x: clamp(sideCenter - sideSize / 2 + random(-laneStep * 0.12, laneStep * 0.12), 8, BOARD_W - sideSize - 8),
          y: -sideSize - 4,
          size: sideSize,
          speed: clamp((baseSpeed + random(-12, 12) + difficulty * 75) * wave.speedMultiplier * 0.92, 52, 240),
          wobble: random(-8, 8),
          wobbleFreq: random(1.2, 2.8),
          age: 0,
          weight: 1,
        },
      ];
    }

    setHazards(hazardsRef.current);
  }, []);

  const spawnCoin = useCallback(() => {
    const coin: Coin = {
      id: idRef.current++,
      x: random(26, BOARD_W - 26),
      y: random(72, BOARD_H - 56),
      ttl: 4,
    };
    coinsRef.current = [...coinsRef.current, coin];
    setCoins(coinsRef.current);
  }, []);

  const performAttack = useCallback(() => {
    if (!runningRef.current || attackCooldownRef.current > 0) return;
    const px = playerRef.current.x + PLAYER_SIZE / 2;
    const py = playerRef.current.y + PLAYER_SIZE / 2;
    const attackRange = 132;

    const targets = hazardsRef.current
      .map((hazard) => {
        const hx = hazard.x + hazard.size / 2;
        const hy = hazard.y + hazard.size / 2;
        return { hazard, dist: Math.hypot(hx - px, hy - py) };
      })
      .filter(({ hazard, dist }) => dist <= attackRange + hazard.size / 2)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 4);

    pulsesRef.current = [...pulsesRef.current, { id: idRef.current++, x: px, y: py, age: 0, ttl: 0.4, maxRadius: 148 }];
    setPulses(pulsesRef.current);

    if (targets.length === 0) {
      adaptiveRef.current = clamp(adaptiveRef.current - 0.03, -0.35, 0.45);
      attackCooldownRef.current = baseCooldown;
      setAttackCooldown(baseCooldown);
      setLastAttackText(`Miss / ${baseCooldown.toFixed(2)}s`);
      playTone(250, 0.07, "square", 0.04);
      return;
    }

    const hitIds = new Set(targets.map((t) => t.hazard.id));
    const totalWeight = targets.reduce((sum, t) => sum + t.hazard.weight, 0);
    const cd = baseCooldown + totalWeight * 0.35 + Math.max(0, targets.length - 1) * 0.12;
    adaptiveRef.current = clamp(adaptiveRef.current + (targets.length >= 3 ? 0.045 : 0.02), -0.35, 0.45);

    hazardsRef.current = hazardsRef.current.filter((hazard) => !hitIds.has(hazard.id));
    setHazards(hazardsRef.current);
    scoreRef.current += targets.reduce((sum, t) => sum + 6 + t.hazard.weight * 3, 0);

    attackCooldownRef.current = cd;
    setAttackCooldown(cd);
    setScore(Math.floor(scoreRef.current));
    setLastAttackText(`${targets.length} hit / W${totalWeight} / ${cd.toFixed(2)}s`);
    playTone(520, 0.08, "triangle", 0.05);
    playTone(760, 0.08, "sine", 0.04);
  }, [baseCooldown, playTone]);

  const resetRun = useCallback(() => {
    setIsRunning(true);
    setGameOver(false);
    setScore(0);
    setRunCoins(0);
    setAttackCooldown(0);
    setLastAttackText("No attack yet");

    const start = { x: BOARD_W / 2 - PLAYER_SIZE / 2, y: BOARD_H - 74 };
    setPlayer(start);
    playerRef.current = start;

    hazardsRef.current = [];
    coinsRef.current = [];
    pulsesRef.current = [];
    setHazards([]);
    setCoins([]);
    setPulses([]);

    scoreRef.current = 0;
    attackCooldownRef.current = 0;
    elapsedRef.current = 0;
    spawnRef.current = 0;
    coinRef.current = 0;
    submittedRef.current = false;
    adaptiveRef.current = 0;
    patternQueueRef.current = [];
    lastScoreProbeRef.current = 0;
    touchRef.current = { x: 0, y: 0, active: false };
    setJoystickVisual({ x: 0, y: 0, active: false });
    setWaveLabel("Wave 1 - Warmup");
    setAdaptiveLabel("Adaptive: neutral");
  }, []);

  const endRun = useCallback(() => {
    if (!runningRef.current) return;
    setIsRunning(false);
    setGameOver(true);
    const final = Math.floor(scoreRef.current);
    setBestScore((prev) => Math.max(prev, final));
    if (!submittedRef.current) {
      submittedRef.current = true;
      void submitScore(final);
    }
    playTone(180, 0.12, "sawtooth", 0.06);
    playTone(135, 0.18, "square", 0.04);
  }, [playTone, submitScore]);

  const handlePlay = useCallback(() => {
    const savedSession = window.localStorage.getItem(SESSION_KEY) === "1";
    const savedName = normalizeName(window.localStorage.getItem(USERNAME_KEY) ?? "");

    if (!sessionAuthed && savedSession && savedName && savedName.toLowerCase() !== "player") {
      setSessionAuthed(true);
      setUserName(savedName);
      setNameDraft(savedName);
      setAccountKey(toNameKey(savedName));
    }

    if (!(sessionAuthed || (savedSession && savedName && savedName.toLowerCase() !== "player"))) {
      setShowSettings(true);
      setAuthError("Login/register first, then play.");
      return;
    }
    setScreenMode("game");
    resetRun();
    window.scrollTo({ top: 0, behavior: "auto" });
    playTone(640, 0.08, "triangle", 0.05);
  }, [playTone, resetRun, sessionAuthed]);

  useEffect(() => {
    if (!sessionAuthed) return;
    if (!userName || userName.toLowerCase() === "player") return;

    const key = accountKey || toNameKey(userName);
    const timer = window.setTimeout(() => {
      setCoinSyncStatus("syncing");
      void setDoc(
        doc(db, ACCOUNTS_COLLECTION, key),
        {
          username: userName,
          coins: Math.max(0, Math.floor(coinBank)),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      )
        .then(() => {
          setCoinSyncStatus("ok");
        })
        .catch(() => {
          setCoinSyncStatus("error");
        });
    }, 320);

    return () => window.clearTimeout(timer);
  }, [accountKey, coinBank, sessionAuthed, userName]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => {
      const phase = getWavePhase(elapsedRef.current);
      setWaveLabel(phase.name);

      const scoreGain = scoreRef.current - lastScoreProbeRef.current;
      lastScoreProbeRef.current = scoreRef.current;
      const hazardPressure = hazardsRef.current.length;

      let nextAdaptive = adaptiveRef.current;
      if (scoreGain >= 14 && hazardPressure <= 6) {
        nextAdaptive += 0.06;
      } else if (scoreGain <= 4 || hazardPressure >= 10) {
        nextAdaptive -= 0.07;
      } else {
        nextAdaptive += (Math.random() - 0.5) * 0.02;
      }
      nextAdaptive = clamp(nextAdaptive, -0.35, 0.45);
      adaptiveRef.current = nextAdaptive;

      if (nextAdaptive > 0.14) {
        setAdaptiveLabel(`Adaptive: ramping +${Math.round(nextAdaptive * 100)}%`);
      } else if (nextAdaptive < -0.1) {
        setAdaptiveLabel(`Adaptive: easing ${Math.round(Math.abs(nextAdaptive) * 100)}%`);
      } else {
        setAdaptiveLabel("Adaptive: neutral");
      }
    }, 900);

    return () => window.clearInterval(timer);
  }, [isRunning]);

  const buyMove = () => {
    const cost = moveCost(moveLevel);
    if (coinBank < cost || moveLevel >= 8) return;
    setCoinBank((prev) => prev - cost);
    setMoveLevel((prev) => prev + 1);
    setToast(`Move level increased to ${moveLevel + 1}`);
  };

  const buyAttack = () => {
    const cost = attackCost(attackLevel);
    if (coinBank < cost || attackLevel >= 8) return;
    setCoinBank((prev) => prev - cost);
    setAttackLevel((prev) => prev + 1);
    setToast(`Attack level increased to ${attackLevel + 1}`);
  };

  const buyOrEquipSkin = (skin: Skin) => {
    if (unlockedSkins.includes(skin.id)) {
      setSkinId(skin.id);
      setToast(`${skin.name} equipped`);
      return;
    }
    if (coinBank < skin.price) return;
    setCoinBank((prev) => prev - skin.price);
    setUnlockedSkins((prev) => [...prev, skin.id]);
    setSkinId(skin.id);
    setToast(`${skin.name} unlocked`);
  };

  const handleJoystickDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    joystickPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const maxRadius = rect.width * 0.31;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const dist = Math.hypot(dx, dy);
    const ratio = dist > maxRadius ? maxRadius / dist : 1;
    const x = dx * ratio;
    const y = dy * ratio;
    setJoystickVisual({ x, y, active: true });
    touchRef.current = { x: x / maxRadius, y: y / maxRadius, active: true };
  };

  const handleJoystickMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (joystickPointerRef.current !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const maxRadius = rect.width * 0.31;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const dist = Math.hypot(dx, dy);
    const ratio = dist > maxRadius ? maxRadius / dist : 1;
    const x = dx * ratio;
    const y = dy * ratio;
    setJoystickVisual({ x, y, active: true });
    touchRef.current = { x: x / maxRadius, y: y / maxRadius, active: true };
  };

  const handleJoystickUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (joystickPointerRef.current !== event.pointerId) return;
    joystickPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    touchRef.current = { x: 0, y: 0, active: false };
    setJoystickVisual({ x: 0, y: 0, active: false });
  };

  useEffect(() => {
    const detectTouch = () => {
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      setIsTouch(coarse || navigator.maxTouchPoints > 0);
    };
    detectTouch();
    window.addEventListener("resize", detectTouch);
    return () => window.removeEventListener("resize", detectTouch);
  }, []);

  useEffect(() => {
    const recalcScale = () => {
      if (screenMode !== "game") {
        setBoardScale(1);
        return;
      }
      const topBar = 58;
      const controls = isTouch ? 142 : 60;
      const availableHeight = window.innerHeight - topBar - controls - 12;
      const widthScale = (window.innerWidth - 18) / BOARD_W;
      const heightScale = availableHeight / BOARD_H;
      setBoardScale(clamp(Math.min(widthScale, heightScale), 0.82, 1.15));
    };
    recalcScale();
    window.addEventListener("resize", recalcScale);
    return () => window.removeEventListener("resize", recalcScale);
  }, [isTouch, screenMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      keysRef.current.add(event.key.toLowerCase());
      if (event.code === "Space") {
        event.preventDefault();
        performAttack();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [performAttack]);

  useEffect(() => {
    runningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    playerRef.current = player;
  }, [player]);

  useEffect(() => {
    const tick = (time: number) => {
      if (!runningRef.current) {
        frameRef.current = null;
        return;
      }

      const prev = (tick as unknown as { prev?: number }).prev ?? time;
      const dt = clamp((time - prev) / 1000, 0, 0.04);
      (tick as unknown as { prev?: number }).prev = time;

      elapsedRef.current += dt;
      spawnRef.current += dt;
      coinRef.current += dt;

      let vx = 0;
      let vy = 0;
      const keys = keysRef.current;
      if (keys.has("arrowleft") || keys.has("a")) vx -= 1;
      if (keys.has("arrowright") || keys.has("d")) vx += 1;
      if (keys.has("arrowup") || keys.has("w")) vy -= 1;
      if (keys.has("arrowdown") || keys.has("s")) vy += 1;

      if (touchRef.current.active) {
        vx = clamp(vx + touchRef.current.x, -1, 1);
        vy = clamp(vy + touchRef.current.y, -1, 1);
      }
      if (vx !== 0 && vy !== 0) {
        vx *= 0.707;
        vy *= 0.707;
      }

      const nextPlayer = {
        x: clamp(playerRef.current.x + vx * moveSpeed * dt, 0, BOARD_W - PLAYER_SIZE),
        y: clamp(playerRef.current.y + vy * moveSpeed * dt, 0, BOARD_H - PLAYER_SIZE),
      };
      playerRef.current = nextPlayer;
      setPlayer(nextPlayer);

      attackCooldownRef.current = Math.max(0, attackCooldownRef.current - dt);
      setAttackCooldown(attackCooldownRef.current);

      const spawnInterval = clamp(1.05 - elapsedRef.current * 0.01, 0.42, 1.05);
      if (spawnRef.current >= spawnInterval) {
        spawnRef.current = 0;
        spawnHazard();
      }
      if (coinRef.current >= 2.4) {
        coinRef.current = 0;
        spawnCoin();
      }

      const px = nextPlayer.x + PLAYER_SIZE / 2;
      const py = nextPlayer.y + PLAYER_SIZE / 2;

      hazardsRef.current = hazardsRef.current
        .map((hazard) => {
          const age = hazard.age + dt;
          return {
            ...hazard,
            age,
            y: hazard.y + hazard.speed * dt,
            x: clamp(hazard.x + Math.sin(age * hazard.wobbleFreq) * hazard.wobble * dt, 0, BOARD_W - hazard.size),
          };
        })
        .filter((hazard) => hazard.y < BOARD_H + hazard.size);
      setHazards(hazardsRef.current);

      for (const hazard of hazardsRef.current) {
        const hx = hazard.x + hazard.size / 2;
        const hy = hazard.y + hazard.size / 2;
        const reach = (hazard.size + PLAYER_SIZE) / 2 - 2;
        if (Math.hypot(hx - px, hy - py) < reach) {
          endRun();
          break;
        }
      }

      let collected = 0;
      coinsRef.current = coinsRef.current
        .map((coin) => ({ ...coin, ttl: coin.ttl - dt }))
        .filter((coin) => {
          if (coin.ttl <= 0) return false;
          if (Math.hypot(coin.x - px, coin.y - py) < PLAYER_SIZE * 0.8) {
            collected += 1;
            return false;
          }
          return true;
        });
      if (collected > 0) {
        setRunCoins((prev) => prev + collected);
        setCoinBank((prev) => prev + collected);
        scoreRef.current += collected * 2;
        setScore(Math.floor(scoreRef.current));
        playTone(900, 0.05, "sine", 0.05);
      }
      setCoins(coinsRef.current);

      pulsesRef.current = pulsesRef.current
        .map((pulse) => ({ ...pulse, age: pulse.age + dt }))
        .filter((pulse) => pulse.age < pulse.ttl);
      setPulses(pulsesRef.current);

      scoreRef.current += dt * 2.2;
      setScore(Math.floor(scoreRef.current));
      frameRef.current = requestAnimationFrame(tick);
    };

    if (isRunning && frameRef.current === null) frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [endRun, isRunning, moveSpeed, playTone, spawnCoin, spawnHazard]);

  useEffect(() => {
    void fetchLeaderboard();
  }, [fetchLeaderboard]);

  useEffect(() => {
    const savedBest = Number.parseInt(localStorage.getItem(BEST_KEY) ?? "0", 10);
    const savedCoins = Number.parseInt(localStorage.getItem(COIN_KEY) ?? "0", 10);
    const savedMove = Number.parseInt(localStorage.getItem(MOVE_KEY) ?? "0", 10);
    const savedAttack = Number.parseInt(localStorage.getItem(ATTACK_KEY) ?? "0", 10);
    const savedName = normalizeName(localStorage.getItem(USERNAME_KEY) ?? "Player");
    const savedSound = localStorage.getItem(SOUND_KEY);
    const savedSkin = localStorage.getItem(SKIN_KEY) ?? "neon";
    const savedUnlocked = localStorage.getItem(SKIN_UNLOCK_KEY);

    setBestScore(Number.isNaN(savedBest) ? 0 : savedBest);
    setCoinBank(Number.isNaN(savedCoins) ? 0 : savedCoins);
    setMoveLevel(Number.isNaN(savedMove) ? 0 : clamp(savedMove, 0, 8));
    setAttackLevel(Number.isNaN(savedAttack) ? 0 : clamp(savedAttack, 0, 8));
    setUserName(savedName || "Player");
    setNameDraft(savedName || "Player");
    setHasConfirmedName(Boolean(savedName && savedName.toLowerCase() !== "player"));
    if (savedSound !== null) setSoundEnabled(savedSound !== "0");
    if (SKINS.some((entry) => entry.id === savedSkin)) setSkinId(savedSkin);

    if (savedUnlocked) {
      try {
        const parsed = JSON.parse(savedUnlocked) as string[];
        const safe = parsed.filter((id) => SKINS.some((skin) => skin.id === id));
        setUnlockedSkins(safe.length > 0 ? Array.from(new Set(["neon", ...safe])) : ["neon"]);
      } catch {
        setUnlockedSkins(["neon"]);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(BEST_KEY, String(bestScore));
  }, [bestScore]);

  useEffect(() => {
    localStorage.setItem(COIN_KEY, String(coinBank));
  }, [coinBank]);

  useEffect(() => {
    localStorage.setItem(MOVE_KEY, String(moveLevel));
  }, [moveLevel]);

  useEffect(() => {
    localStorage.setItem(ATTACK_KEY, String(attackLevel));
  }, [attackLevel]);

  useEffect(() => {
    localStorage.setItem(USERNAME_KEY, userName);
  }, [userName]);

  useEffect(() => {
    localStorage.setItem(SOUND_KEY, soundEnabled ? "1" : "0");
  }, [soundEnabled]);

  useEffect(() => {
    localStorage.setItem(SKIN_KEY, skinId);
    localStorage.setItem(SKIN_UNLOCK_KEY, JSON.stringify(unlockedSkins));
  }, [skinId, unlockedSkins]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!championToast) return;
    const timer = window.setTimeout(() => setChampionToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [championToast]);

  const boardStyle = useMemo(
    () => ({
      width: BOARD_W,
      height: BOARD_H,
      transform: `scale(${boardScale})`,
      transformOrigin: "top center",
      touchAction: "none" as const,
    }),
    [boardScale],
  );

  return (
    <main className="min-h-dvh w-full bg-[radial-gradient(circle_at_20%_10%,rgba(250,204,21,0.18),transparent_38%),radial-gradient(circle_at_85%_15%,rgba(56,189,248,0.28),transparent_40%),linear-gradient(160deg,#021038,#00142f_55%,#011b42)] px-3 py-3 text-slate-100">
      <section className="mx-auto w-full max-w-[560px]">
        {screenMode === "lobby" && (
          <div className="rounded-3xl border border-white/15 bg-slate-950/65 p-4 backdrop-blur-sm">
            <p className="text-[11px] uppercase tracking-[0.34em] text-amber-200/90">Arcade challenge</p>
            <h1 className="mt-3 text-[30px] leading-none text-cyan-100" style={{ fontFamily: "var(--font-arcade)" }}>
              Pixel Dodge
            </h1>
            <p className="mt-3 text-xs text-cyan-200/80">Character: Neon Runner</p>

            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-xl border border-cyan-200/30 bg-slate-900/60 px-2 py-2">User: {userName}</div>
              <div className="rounded-xl border border-emerald-200/30 bg-slate-900/60 px-2 py-2">Best: {bestScore}</div>
              <div className="rounded-xl border border-amber-200/30 bg-slate-900/60 px-2 py-2">Coins: {coinBank}</div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button type="button" onClick={handlePlay} className="rounded-xl bg-gradient-to-r from-cyan-300 to-teal-400 px-5 py-3 text-sm font-extrabold uppercase tracking-[0.16em] text-slate-950">
                Play
              </button>
              <button type="button" onClick={() => setShowSettings(true)} className="rounded-xl border border-white/30 bg-slate-900/60 px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] text-slate-100">
                Settings
              </button>
              <button type="button" onClick={() => setShowLevelUp(true)} className="rounded-xl border border-lime-200/35 bg-lime-300/15 px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] text-lime-100">
                Level Up
              </button>
              <button type="button" onClick={() => setShowLeaderboard(true)} className="rounded-xl border border-cyan-200/35 bg-cyan-300/15 px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] text-cyan-100 sm:col-span-3">
                Full Leaderboard
              </button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {topThree.map((entry, idx) => (
                <div key={entry.id} className="rounded-2xl border border-white/15 bg-slate-950/70 p-3">
                  <p className="text-[11px] uppercase tracking-[0.28em] text-slate-400">Top {idx + 1}</p>
                  <p className="mt-2 text-xl text-cyan-100">{entry.username}</p>
                  <p className="mt-1 text-3xl text-amber-300" style={{ fontFamily: "var(--font-arcade)", lineHeight: 1 }}>
                    {entry.score}
                  </p>
                </div>
              ))}
            </div>

            <p className="mt-3 text-xs text-slate-400">
              {leaderboardStatus === "loading" ? "Syncing leaderboard..." : leaderboardStatus === "error" ? "Leaderboard sync failed." : "Leaderboard live from Firebase"}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {coinSyncStatus === "syncing"
                ? "Saving coins to cloud..."
                : coinSyncStatus === "ok"
                  ? "Coins saved to cloud"
                  : coinSyncStatus === "error"
                    ? "Coin sync blocked by Firebase rules"
                    : ""}
            </p>
          </div>
        )}

        {screenMode === "game" && (
          <div className="grid h-[100dvh] grid-rows-[auto_minmax(0,1fr)_auto] gap-1 overflow-hidden pb-[max(env(safe-area-inset-bottom),6px)]">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setScreenMode("lobby");
                  setIsRunning(false);
                  setGameOver(false);
                }}
                className="rounded-xl border border-white/30 bg-slate-900/70 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-100"
              >
                Back Lobby
              </button>
              <div className="rounded-xl border border-white/20 bg-slate-950/70 px-3 py-2 text-xs text-cyan-100">
                Score: <span className="font-bold text-amber-200">{score}</span>
              </div>
            </div>

            <div className="min-h-0">
              <div className="relative mx-auto rounded-2xl border border-cyan-200/30 bg-[#020b22]/90 shadow-[inset_0_0_30px_rgba(34,211,238,0.12)]" style={boardStyle}>
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_15%,rgba(34,211,238,0.2),transparent_40%),radial-gradient(circle_at_70%_80%,rgba(59,130,246,0.22),transparent_35%)]" />

                {pulses.map((pulse) => {
                  const progress = pulse.age / pulse.ttl;
                  const radius = pulse.maxRadius * progress;
                  return (
                    <div
                      key={pulse.id}
                      className="pointer-events-none absolute rounded-full border border-cyan-300/60"
                      style={{ width: radius * 2, height: radius * 2, left: pulse.x - radius, top: pulse.y - radius, opacity: 1 - progress }}
                    />
                  );
                })}

                {coins.map((coin) => (
                  <div key={coin.id} className="absolute h-5 w-5 rounded-full bg-gradient-to-br from-yellow-200 to-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.85)]" style={{ left: coin.x - 10, top: coin.y - 10 }} />
                ))}

                {hazards.map((hazard) => (
                  <div
                    key={hazard.id}
                    className={`absolute flex items-center justify-center font-black text-white ${hazard.kind === "meteor" ? "rounded-md border border-rose-100/30 bg-gradient-to-br from-orange-300 to-rose-600" : hazard.kind === "bubble" ? "rounded-full border border-cyan-100/35 bg-gradient-to-br from-cyan-200/90 to-blue-500" : "rounded-sm border border-fuchsia-100/30 bg-gradient-to-br from-fuchsia-300 to-indigo-500"}`}
                    style={{ width: hazard.size, height: hazard.size, transform: `translate(${hazard.x}px,${hazard.y}px)`, fontSize: 12 }}
                  >
                    {hazard.weight}
                  </div>
                ))}

                <div
                  className="absolute rounded-sm border border-white/60"
                  style={{ width: PLAYER_SIZE, height: PLAYER_SIZE, transform: `translate(${player.x}px, ${player.y}px)`, backgroundImage: currentSkin.fill, boxShadow: currentSkin.glow }}
                />

                <div className="absolute left-2 top-2 rounded-lg bg-slate-950/70 px-2 py-1 text-xs text-yellow-100">Run coins: {runCoins}</div>
                <div className="absolute left-2 top-10 rounded-lg bg-slate-950/70 px-2 py-1 text-[10px] text-cyan-100">
                  <p>{waveLabel}</p>
                  <p className="text-[9px] text-cyan-200/80">{adaptiveLabel}</p>
                </div>
                <div className="absolute right-2 top-2 rounded-lg bg-slate-950/80 px-2 py-1 text-[11px] text-cyan-100">
                  <p>ATK CD: {attackCooldown.toFixed(1)}s</p>
                  <p className="text-[10px] text-cyan-200/90">Base: {baseCooldown.toFixed(2)}s</p>
                  <p className="text-[10px] text-cyan-200/90">Last: {lastAttackText}</p>
                </div>

                {!isRunning && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/75 px-6 text-center">
                    <p className="mb-3 text-xl text-cyan-100" style={{ fontFamily: "var(--font-arcade)" }}>
                      {gameOver ? "Game Over" : "Ready?"}
                    </p>
                    <p className="mb-4 text-sm text-slate-200">Use joystick on mobile, WASD/Arrows on desktop, Space for attack.</p>
                    <button type="button" onClick={resetRun} className="rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-6 py-2 text-sm font-bold text-slate-950">
                      {gameOver ? "Play Again" : "Start Run"}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {isTouch ? (
              <div className="no-touch-select rounded-2xl border border-white/15 bg-slate-950/85 p-2 backdrop-blur">
                <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                  <div className="flex justify-center">
                    <div
                      className="no-touch-select relative h-28 w-28 rounded-full border border-cyan-200/35 bg-cyan-200/10"
                      style={{ touchAction: "none" }}
                      onPointerDown={handleJoystickDown}
                      onPointerMove={handleJoystickMove}
                      onPointerUp={handleJoystickUp}
                      onPointerCancel={handleJoystickUp}
                      onLostPointerCapture={handleJoystickUp}
                    >
                      <div className="absolute inset-[18%] rounded-full border border-cyan-200/25" />
                      <div className="absolute inset-[34%] rounded-full border border-cyan-200/25" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div
                          className="h-10 w-10 rounded-full bg-cyan-300/80 shadow-[0_0_20px_rgba(34,211,238,0.45)]"
                          style={{ transform: `translate3d(${joystickVisual.active ? joystickVisual.x : 0}px, ${joystickVisual.active ? joystickVisual.y : 0}px, 0)`, transition: joystickVisual.active ? "none" : "transform 120ms ease-out" }}
                        />
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onPointerDown={performAttack}
                    disabled={!isRunning || attackCooldown > 0}
                    className="mobile-attack-button flex min-h-[104px] min-w-[104px] flex-col items-center justify-center rounded-3xl border border-orange-200/50 bg-gradient-to-br from-orange-300/35 to-rose-400/35 px-2 text-center text-sm font-extrabold uppercase tracking-[0.04em] text-orange-100 active:scale-95 disabled:opacity-45"
                  >
                    <span className="mobile-attack-button__title">Attack</span>
                    <span className="mobile-attack-button__state mt-2 text-[11px] font-semibold tracking-[0.04em]">{attackCooldown > 0 ? `${attackCooldown.toFixed(1)}s` : "Ready"}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex justify-center">
                <button type="button" onClick={performAttack} className="rounded-full border border-orange-200/40 bg-orange-300/20 px-6 py-2 text-xs font-bold uppercase tracking-[0.2em] text-orange-100">
                  Attack (Space)
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {showLevelUp && (
        <div className="fixed inset-0 z-30 overflow-y-auto bg-slate-950/75 p-3 sm:p-4">
          <div className="flex min-h-full items-start justify-center py-2 sm:items-center">
            <div className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/20 bg-slate-900 p-4">
              <div className="sticky top-0 z-10 -mx-4 -mt-4 mb-2 flex items-center justify-between border-b border-white/10 bg-slate-900/95 px-4 py-3">
                <h2 className="text-lg text-cyan-100" style={{ fontFamily: "var(--font-arcade)" }}>Level Up Lab</h2>
                <button type="button" onClick={() => setShowLevelUp(false)} className="text-xs uppercase tracking-[0.2em] text-slate-300">Close</button>
              </div>

              <div className="space-y-3">
                <div className="rounded-xl border border-white/15 bg-slate-950/70 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-cyan-200">Move speed Lv.{moveLevel}</p>
                  <p className="mt-1 text-sm text-slate-300">Current speed: {moveSpeed}px/s</p>
                  <p className="text-xs text-cyan-100/90">Each level adds +28px/s</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" onClick={buyMove} disabled={coinBank < moveCost(moveLevel) || moveLevel >= 8} className="rounded-lg bg-cyan-300/20 px-3 py-2 text-xs font-bold uppercase tracking-[0.2em] text-cyan-100 disabled:opacity-40">Upgrade ({moveCost(moveLevel)})</button>
                    <button type="button" onClick={() => setMoveLevel((prev) => Math.max(0, prev - 1))} disabled={moveLevel <= 0} className="rounded-lg bg-slate-200/20 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-100 disabled:opacity-40">Decrease</button>
                  </div>
                </div>

                <div className="rounded-xl border border-white/15 bg-slate-950/70 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-orange-200">Attack tech Lv.{attackLevel}</p>
                  <p className="mt-1 text-sm text-slate-300">Base cooldown: {baseCooldown.toFixed(2)}s</p>
                  <p className="text-xs text-orange-100/90">Each level reduces -0.16s (min 0.35s)</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" onClick={buyAttack} disabled={coinBank < attackCost(attackLevel) || attackLevel >= 8} className="rounded-lg bg-orange-300/20 px-3 py-2 text-xs font-bold uppercase tracking-[0.2em] text-orange-100 disabled:opacity-40">Upgrade ({attackCost(attackLevel)})</button>
                    <button type="button" onClick={() => setAttackLevel((prev) => Math.max(0, prev - 1))} disabled={attackLevel <= 0} className="rounded-lg bg-slate-200/20 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-100 disabled:opacity-40">Decrease</button>
                  </div>
                </div>

                <div className="rounded-xl border border-white/15 bg-slate-950/70 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-lime-200">Color skins</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {SKINS.map((skin) => {
                      const unlocked = unlockedSkins.includes(skin.id);
                      const active = skin.id === skinId;
                      return (
                        <button
                          key={skin.id}
                          type="button"
                          onClick={() => buyOrEquipSkin(skin)}
                          disabled={!unlocked && coinBank < skin.price}
                          className="rounded-xl border border-white/15 bg-slate-900/75 p-2 text-left disabled:opacity-40"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-slate-100">{skin.name}</span>
                            {active ? <span className="text-xs text-emerald-300">Equipped</span> : null}
                          </div>
                          <div className="mt-2 h-8 w-full rounded-md border border-white/20" style={{ backgroundImage: skin.fill }} />
                          <p className="mt-1 text-xs text-slate-300">{unlocked ? "Tap to equip" : `Unlock: ${skin.price} coins`}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-slate-950/80 p-3 sm:p-4">
          <div className="flex min-h-full items-start justify-center py-2 sm:items-center">
            <div className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/20 bg-slate-900 p-4">
              <div className="sticky top-0 z-10 -mx-4 -mt-4 mb-3 flex items-center justify-between border-b border-white/10 bg-slate-900/95 px-4 py-3">
                <h2 className="text-base text-cyan-100" style={{ fontFamily: "var(--font-arcade)" }}>Login / Settings</h2>
                {hasConfirmedName ? (
                  <button type="button" onClick={() => setShowSettings(false)} className="rounded-lg border border-white/25 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-200">Close</button>
                ) : (
                  <span className="text-[11px] uppercase tracking-[0.16em] text-amber-200">Required before play</span>
                )}
              </div>

              <div className="rounded-xl border border-white/10 bg-slate-950/65 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-amber-100">Player Profile</p>
                <label className="mt-2 block text-[11px] uppercase tracking-[0.16em] text-slate-300">Username</label>
                <input
                  value={nameDraft}
                  maxLength={18}
                  onChange={(event) => {
                    setNameDraft(event.target.value);
                    if (authError) setAuthError("");
                  }}
                  className="mt-1 w-full rounded-lg border border-white/20 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-300"
                />

                <label className="mt-3 block text-[11px] uppercase tracking-[0.16em] text-slate-300">PIN (default 1234)</label>
                <div className="mt-1 flex gap-2">
                  <input
                    value={pinDraft}
                    type={showPin ? "text" : "password"}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={8}
                    onChange={(event) => {
                      setPinDraft(event.target.value.replace(/\D/g, "").slice(0, 8));
                      if (authError) setAuthError("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleSaveProfile();
                    }}
                    className="w-full rounded-lg border border-white/20 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-300"
                  />
                  <button type="button" onClick={() => setShowPin((prev) => !prev)} className="rounded-lg border border-white/20 bg-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-200">
                    {showPin ? "Hide" : "Show"}
                  </button>
                </div>

                <button type="button" onClick={() => void handleSaveProfile()} disabled={authBusy} className="mt-3 rounded-lg bg-amber-300/20 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-amber-100 disabled:opacity-50">
                  {authBusy ? "Checking..." : "Login / Register"}
                </button>
                {authError && <p className="mt-2 text-xs text-rose-200">{authError}</p>}
              </div>

              <div className="mt-3 rounded-xl border border-white/10 bg-slate-950/65 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-cyan-200">Audio</p>
                <button type="button" onClick={() => setSoundEnabled((prev) => !prev)} className="mt-2 rounded-lg bg-cyan-300/20 px-3 py-2 text-xs font-bold uppercase tracking-[0.2em] text-cyan-100">
                  {soundEnabled ? "Sound: On" : "Sound: Off"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showLeaderboard && (
        <div className="fixed inset-0 z-30 overflow-y-auto bg-slate-950/80 p-3">
          <div className="mx-auto w-full max-w-md rounded-2xl border border-white/20 bg-slate-900 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-cyan-100" style={{ fontFamily: "var(--font-arcade)" }}>Global Leaderboard</h3>
              <button type="button" onClick={() => setShowLeaderboard(false)} className="text-xs uppercase tracking-[0.2em] text-slate-300">Close</button>
            </div>
            <div className="space-y-2">
              {leaderboard.map((entry, index) => (
                <div key={entry.id} className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm">
                  <span className="text-slate-200">#{index + 1} {entry.username}</span>
                  <span className="font-semibold text-amber-200">{entry.score}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed left-1/2 top-5 z-50 -translate-x-1/2 rounded-full border border-emerald-300/50 bg-emerald-400/20 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-emerald-100 shadow-lg backdrop-blur">
          {toast}
        </div>
      )}

      {championToast && (
        <div className="fixed left-1/2 top-16 z-50 -translate-x-1/2 rounded-xl border border-amber-300/50 bg-amber-300/20 px-5 py-3 text-center text-xs font-bold uppercase tracking-[0.14em] text-amber-100 shadow-lg backdrop-blur">
          {championToast}
        </div>
      )}
    </main>
  );
}
