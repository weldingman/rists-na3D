


/**
 * 3D Crossword (clean single-file p5.js)
 * - JSON-driven (load from file OR embedded OR generate fallback)
 * - Connected slices in EVERY plane (XY for each z, XZ for each y, YZ for each x) when generating
 * - Clues only in 3 directions: paremale (+X), alla (+Y), sisse (+Z)
 * - UI:
 *    - Base navigation: XY / TAB toggles to XZ or YZ based on last XY axis
 *    - Mouse wheel changes depth (XY: Z, XZ: Y, YZ: X)
 *    - Click grid to select
 *    - Type letters into cells (optional, solution stored separately)
 * - Clues displayed UNDER the grid in 3 columns, filtered to the ones whose start-number cell is visible
 * - Clicking a clue jumps to its start cell and switches view appropriately
 * - Button + 'J' downloads the currently loaded puzzle JSON
 *
 * Put this as sketch.js in p5 editor.
 * If loading a JSON file, place it next to sketch and set JSON_ADDRESS.
 */

// ---------------- CONFIG ----------------
const CFG = {
  // Used only for generation fallback (if no JSON is loaded)
  GEN_NX: 24,
  GEN_NY: 24,
  GEN_NZ: 8,
  targetBlockFrac: 0.18,
  minOpenPerSlice: 12,
  maxTries: 30000,

  // Viewport
  VIEW_W: 10,
  VIEW_H: 10,
  CELL: 34,
  MARGIN: 16,
  PANEL_W: 440,     // right status area width
  CLUE_AREA_H: 500, // bottom clue area height
};

// Choose one source:
// 1) Embedded JSON (paste full puzzle object) -> set USE_EMBEDDED_JSON true
// 2) JSON file (loadJSON) -> set USE_EMBEDDED_JSON false and set JSON_ADDRESS
// 3) If file missing/unavailable, it will auto-generate.
const USE_EMBEDDED_JSON = false;
const EMBEDDED_JSON = null; // paste puzzle object here if wanted
const JSON_ADDRESS = "cross3d-4(12).json";

// ---------------- STATE ----------------
let puzzleJSON = null;   // loaded JSON data
let puzzle = null;       // active puzzle object (the one we render/download)

let NX = 0, NY = 0, NZ = 0; // dimensions from loaded puzzle

// world[z][y][x] = { block, ch, sol, numR, numD, numI }
let world = [];
let clues = { R: [], D: [], I: [] };
let clueHitboxes = []; // canvas-coordinate hitboxes for bottom clues

// View controls
let view = "XY"; // XY | XZ | YZ
let cur = { x: 0, y: 0, z: 0 };
let cam = { u: 0, v: 0 };
let depthX = 0, depthY = 0;

// Last XY movement chooses TAB plane
let lastAxis = "x";          // "x" | "y"
let lastDir = { dx: 1, dy: 0 };

// ---------------- LOADING ----------------
function preload() {
  if (!USE_EMBEDDED_JSON) {
    // If file doesn't exist / fails, p5 will print error in console and puzzleJSON may remain null.
    puzzleJSON = loadJSON(JSON_ADDRESS, () => {}, () => {});
  }
}

function setup() {
  createCanvas(
    CFG.MARGIN * 2 + CFG.VIEW_W * CFG.CELL + CFG.PANEL_W,
    CFG.MARGIN * 2 + CFG.VIEW_H * CFG.CELL + CFG.CLUE_AREA_H
  );

  textFont("monospace");
  textAlign(CENTER, CENTER);

  // Download button
  const btn = createButton("Laadi JSON alla");
  btn.position(10, height + 10);
  btn.mousePressed(downloadPuzzleJSON);

  // Decide source and load
  if (USE_EMBEDDED_JSON && EMBEDDED_JSON) {
    loadPuzzleFromJSON(EMBEDDED_JSON);
  } else if (puzzleJSON && (puzzleJSON.dims || puzzleJSON.nx)) {
    loadPuzzleFromJSON(puzzleJSON);
  } else {
    generatePuzzleJSON();
    loadPuzzleFromJSON(puzzle);
  }

  // Pick first open cell
  outer:
  for (let z = 0; z < NZ; z++) {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        if (!cell(x, y, z).block) {
          cur = { x, y, z };
          break outer;
        }
      }
    }
  }
  depthX = cur.x;
  depthY = cur.y;
}

function draw() {
  background(18);
  ensureCursorVisible();
  drawGrid();
  drawRightStatus();
  drawBottomClues();
}

// ---------------- DOWNLOAD ----------------
function downloadPuzzleJSON() {
  if (!puzzle) return;
  const d = puzzle.dims ?? { nx: NX, ny: NY, nz: NZ };
  saveJSON(puzzle, 'crossword3d_${d.nx}x${d.ny}x${d.nz}.json');
}

// ---------------- JSON API ----------------
function loadPuzzleFromJSON(js) {
  const dims = js.dims ?? { nx: js.nx, ny: js.ny, nz: js.nz };
  NX = dims.nx; NY = dims.ny; NZ = dims.nz;

  // Build empty world
  world = new Array(NZ);
  for (let z = 0; z < NZ; z++) {
    world[z] = new Array(NY);
    for (let y = 0; y < NY; y++) {
      world[z][y] = new Array(NX);
      for (let x = 0; x < NX; x++) {
        world[z][y][x] = { block: false, ch: "", sol: "", numR: 0, numD: 0, numI: 0 };
      }
    }
  }

  // Blocks
  for (const b of (js.blocks ?? [])) {
    if (inBounds(b.x, b.y, b.z)) world[b.z][b.y][b.x].block = true;
  }

  // Reset clues always
  clues = { R: [], D: [], I: [] };
  clearNumbers();

  // -------------------------
  // FORMAT A (NEW): words[]
  // -------------------------
  if (Array.isArray(js.words) && js.words.length > 0) {
    // 1) Write solution letters from words into world.sol (and detect conflicts)
    for (const w of js.words) {
      const dir = w.dir; // "R"|"D"|"I"
      const dx = dir === "R" ? 1 : 0;
      const dy = dir === "D" ? 1 : 0;
      const dz = dir === "I" ? 1 : 0;

      let x = w.start.x, y = w.start.y, z = w.start.z;
      const ans = (w.answer ?? "").toUpperCase();

      for (let i = 0; i < ans.length; i++) {
        if (!inBounds(x, y, z)) {
          console.error("WORD OUT OF BOUNDS", w, { x, y, z });
          break;
        }
        const ce = world[z][y][x];
        if (ce.block) {
          console.error("WORD HITS BLOCK", w, { x, y, z });
          break;
        }

        const ch = ans[i];
        if (ce.sol && ce.sol !== ch) {
          console.error("CROSSING CONFLICT", w, { x, y, z, had: ce.sol, wants: ch });
        }
        ce.sol = ch;

        x += dx; y += dy; z += dz;
      }
    }

    // 2) Build clues from words (viewer-format)
    //    Numbering: same start-cell gets same number.
    const startToNumber = new Map(); // "x,y,z" -> n
    let nextN = 1;

    for (const w of js.words) {
      const key = `${w.start.x},${w.start.y},${w.start.z}`;
      let n = startToNumber.get(key);
      if (!n) { n = nextN++; startToNumber.set(key, n); }

      const dir = w.dir;
      const c = {
        n,
        start: { x: w.start.x, y: w.start.y, z: w.start.z },
        len: (w.answer ?? "").length,
        hint: w.clue ?? (dir === "R" ? "paremale" : dir === "D" ? "alla" : "sisse"),
        answer: (w.answer ?? "").toUpperCase(),
      };

      clues[dir].push(c);
    }

    // 3) Apply numbering to start cells (for drawing numbers)
    for (const c of clues.R) setNum("R", c);
    for (const c of clues.D) setNum("D", c);
    for (const c of clues.I) setNum("I", c);

    // 4) Optional: also attach computed answers from world.sol (should match)
    attachAnswersToClues();

    puzzle = js;
    return;
  }

  // -------------------------
  // FORMAT B (LEGACY): solution[] + clues{}
  // -------------------------
  for (const s of (js.solution ?? [])) {         // <-- SIIN oli sul viga: js.answer
    if (!inBounds(s.x, s.y, s.z)) continue;
    const ce = world[s.z][s.y][s.x];
    if (!ce.block) ce.sol = s.ch ?? "";
  }

  const hasClues = js.clues && (js.clues.R?.length || js.clues.D?.length || js.clues.I?.length);
  if (hasClues) {
    clues = {
      R: js.clues.R ?? [],
      D: js.clues.D ?? [],
      I: js.clues.I ?? [],
    };
    ensureHintFields();
  } else {
    clues = computeCluesFromWorld();
    ensureHintFields();
  }

  for (const c of clues.R) setNum("R", c);
  for (const c of clues.D) setNum("D", c);
  for (const c of clues.I) setNum("I", c);

  attachAnswersToClues();
  puzzle = js;
}


function clearNumbers() {
  for (let z = 0; z < NZ; z++)
    for (let y = 0; y < NY; y++)
      for (let x = 0; x < NX; x++) {
        const ce = cell(x, y, z);
        ce.numR = ce.numD = ce.numI = 0;
      }
}

function setNum(kind, c) {
  const s = c.start;
  if (!inBounds(s.x, s.y, s.z)) return;
  const ce = cell(s.x, s.y, s.z);
  if (kind === "R") ce.numR = c.n;
  if (kind === "D") ce.numD = c.n;
  if (kind === "I") ce.numI = c.n;
}

function ensureHintFields() {
 
  
  // for (const c of clues.R) if (!c.hint) c.hint = "paremale";
  for (const c of clues.R) console.log(c);
  for (const c of clues.D) if (!c.hint) c.hint = "alla";
  for (const c of clues.I) if (!c.hint) c.hint = "sisse";
}

// ---------------- GENERATION (fallback) ----------------
function generatePuzzleJSON() {
  // build open world in generator dims
  const genNX = CFG.GEN_NX, genNY = CFG.GEN_NY, genNZ = CFG.GEN_NZ;

  // temp generator world using same 'world' structure but with generator dims
  NX = genNX; NY = genNY; NZ = genNZ;
  world = new Array(NZ);
  for (let z = 0; z < NZ; z++) {
    world[z] = new Array(NY);
    for (let y = 0; y < NY; y++) {
      world[z][y] = new Array(NX);
      for (let x = 0; x < NX; x++) {
        world[z][y][x] = { block: false, ch: "", sol: "", numR: 0, numD: 0, numI: 0 };
      }
    }
  }

  generateConnectedBlocks();

  // Blocks list
  const blocks = [];
  for (let z = 0; z < NZ; z++)
    for (let y = 0; y < NY; y++)
      for (let x = 0; x < NX; x++)
        if (cell(x, y, z).block) blocks.push({ x, y, z });

  // Dummy solution
  const solution = [];
  for (let z = 0; z < NZ; z++)
    for (let y = 0; y < NY; y++)
      for (let x = 0; x < NX; x++) {
        const ce = cell(x, y, z);
        if (ce.block) continue;
        const ch = pseudoLetter(x, y, z);
        ce.sol = ch;
        solution.push({ x, y, z, ch });
      }

  // Clues
  const jsClues = computeDirectionalCluesJSON();

  puzzle = {
    dims: { nx: NX, ny: NY, nz: NZ },
    blocks,
    solution,
    clues: jsClues,
  };

  // After generation, puzzle is loaded by setup() via loadPuzzleFromJSON(puzzle)
}

function generateConnectedBlocks() {
  const total = NX * NY * NZ;
  const targetBlocks = Math.floor(total * CFG.targetBlockFrac);
  let blocks = 0;
  let tries = 0;

  while (blocks < targetBlocks && tries < CFG.maxTries) {
    tries++;
    const x = (Math.random() * NX) | 0;
    const y = (Math.random() * NY) | 0;
    const z = (Math.random() * NZ) | 0;
    const ce = cell(x, y, z);
    if (ce.block) continue;

    ce.block = true;
    if (
      sliceOpenCountXY(z) >= CFG.minOpenPerSlice &&
      sliceOpenCountXZ(y) >= CFG.minOpenPerSlice &&
      sliceOpenCountYZ(x) >= CFG.minOpenPerSlice &&
      allSlicesConnected()
    ) {
      blocks++;
    } else {
      ce.block = false;
    }
  }
}

// Connectivity helpers (using current NX/NY/NZ)
function sliceOpenCountXY(z) {
  let c = 0;
  for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) if (!cell(x, y, z).block) c++;
  return c;
}
function sliceOpenCountXZ(y) {
  let c = 0;
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) if (!cell(x, y, z).block) c++;
  return c;
}
function sliceOpenCountYZ(x) {
  let c = 0;
  for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) if (!cell(x, y, z).block) c++;
  return c;
}

function allSlicesConnected() {
  for (let z = 0; z < NZ; z++) if (!isConnectedXY(z)) return false;
  for (let y = 0; y < NY; y++) if (!isConnectedXZ(y)) return false;
  for (let x = 0; x < NX; x++) if (!isConnectedYZ(x)) return false;
  return true;
}

function isConnectedXY(zFix) {
  let start = null, open = 0;
  for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
    if (!cell(x, y, zFix).block) { open++; if (!start) start = { x, y }; }
  }
  if (open === 0) return false;

  const vis = new Uint8Array(NX * NY);
  const qx = [start.x], qy = [start.y];
  vis[start.y * NX + start.x] = 1;
  let seen = 1;

  while (qx.length) {
    const cx = qx.pop(), cy = qy.pop();
    const neigh = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx, dy] of neigh) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= NX || ny < 0 || ny >= NY) continue;
      const idx = ny * NX + nx;
      if (vis[idx]) continue;
      if (cell(nx, ny, zFix).block) continue;
      vis[idx] = 1; seen++;
      qx.push(nx); qy.push(ny);
    }
  }
  return seen === open;
}

function isConnectedXZ(yFix) {
  let start = null, open = 0;
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    if (!cell(x, yFix, z).block) { open++; if (!start) start = { x, z }; }
  }
  if (open === 0) return false;

  const vis = new Uint8Array(NX * NZ);
  const qx = [start.x], qz = [start.z];
  vis[start.z * NX + start.x] = 1;
  let seen = 1;

  while (qx.length) {
    const cx = qx.pop(), cz = qz.pop();
    const neigh = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx, dz] of neigh) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= NX || nz < 0 || nz >= NZ) continue;
      const idx = nz * NX + nx;
      if (vis[idx]) continue;
      if (cell(nx, yFix, nz).block) continue;
      vis[idx] = 1; seen++;
      qx.push(nx); qz.push(nz);
    }
  }
  return seen === open;
}

function isConnectedYZ(xFix) {
  let start = null, open = 0;
  for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) {
    if (!cell(xFix, y, z).block) { open++; if (!start) start = { y, z }; }
  }
  if (open === 0) return false;

  const vis = new Uint8Array(NY * NZ);
  const qy = [start.y], qz = [start.z];
  vis[start.z * NY + start.y] = 1;
  let seen = 1;

  while (qy.length) {
    const cy = qy.pop(), cz = qz.pop();
    const neigh = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dy, dz] of neigh) {
      const ny = cy + dy, nz = cz + dz;
      if (ny < 0 || ny >= NY || nz < 0 || nz >= NZ) continue;
      const idx = nz * NY + ny;
      if (vis[idx]) continue;
      if (cell(xFix, ny, nz).block) continue;
      vis[idx] = 1; seen++;
      qy.push(ny); qz.push(nz);
    }
  }
  return seen === open;
}

function pseudoLetter(x, y, z) {
  const v = (x * 73 + y * 151 + z * 199 + 17) % 26;
  return String.fromCharCode(65 + v);
}

// ---------------- CLUES (generation + fallback) ----------------
function computeDirectionalCluesJSON() {
  const R = [], D = [], I = [];
  let n = 0;

  for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
    const ce = cell(x, y, z);
    if (ce.block) continue;

    const startsR = (x === 0 || cell(x - 1, y, z).block) && (x + 1 < NX && !cell(x + 1, y, z).block);
    const startsD = (y === 0 || cell(x, y - 1, z).block) && (y + 1 < NY && !cell(x, y + 1, z).block);
    const startsI = (z === 0 || cell(x, y, z - 1).block) && (z + 1 < NZ && !cell(x, y, z + 1).block);

    if (startsR || startsD || startsI) n++;

    if (startsR) {
      const len = wordLen(x, y, z, 1, 0, 0);
      R.push({ n, len, start: { x, y, z }, hint: "paremale" });
    }
    if (startsD) {
      const len = wordLen(x, y, z, 0, 1, 0);
      D.push({ n, len, start: { x, y, z }, hint: "alla" });
    }
    if (startsI) {
      const len = wordLen(x, y, z, 0, 0, 1);
      I.push({ n, len, start: { x, y, z }, hint: "sisse" });
    }
  }

  return { R, D, I };
}

function computeCluesFromWorld() {
  // Same as computeDirectionalCluesJSON but without adding hint
  const R = [], D = [], I = [];
  let n = 0;

  for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
    const ce = cell(x, y, z);
    if (ce.block) continue;

    const startsR = (x === 0 || cell(x - 1, y, z).block) && (x + 1 < NX && !cell(x + 1, y, z).block);
    const startsD = (y === 0 || cell(x, y - 1, z).block) && (y + 1 < NY && !cell(x, y + 1, z).block);
    const startsI = (z === 0 || cell(x, y, z - 1).block) && (z + 1 < NZ && !cell(x, y, z + 1).block);

    if (startsR || startsD || startsI) n++;

    if (startsR) R.push({ n, len: wordLen(x, y, z, 1, 0, 0), start: { x, y, z }, hint: "paremale" });
    if (startsD) D.push({ n, len: wordLen(x, y, z, 0, 1, 0), start: { x, y, z }, hint: "alla" });
    if (startsI) I.push({ n, len: wordLen(x, y, z, 0, 0, 1), start: { x, y, z }, hint: "sisse" });
  }

  return { R, D, I };
}

function wordLen(x, y, z, dx, dy, dz) {
  let len = 0;
  while (inBounds(x, y, z) && !cell(x, y, z).block) {
    len++;
    x += dx; y += dy; z += dz;
  }
  return len;
}

function attachAnswersToClues() {
  for (const c of clues.R) c.answer = readWordFromSolution(c.start, 1, 0, 0);
  for (const c of clues.D) c.answer = readWordFromSolution(c.start, 0, 1, 0);
  for (const c of clues.I) c.answer = readWordFromSolution(c.start, 0, 0, 1);
}

function readWordFromSolution(start, dx, dy, dz) {
  let { x, y, z } = start;
  let s = "";
  while (inBounds(x, y, z) && !cell(x, y, z).block) {
    s += (cell(x, y, z).sol || "?");
    x += dx; y += dy; z += dz;
  }
  return s;
}

// ---------------- WORLD HELPERS ----------------
function cell(x, y, z) {
  return world[z][y][x];
}

function inBounds(x, y, z) {
  return x >= 0 && x < NX && y >= 0 && y < NY && z >= 0 && z < NZ;
}

// ---------------- VIEW MAPPING ----------------
// XY: u=x v=y fixed z=cur.z
// XZ: u=x v=z fixed y=depthY
// YZ: u=y v=z fixed x=depthX
function planeBounds() {
  if (view === "XY") return { Umax: NX, Vmax: NY };
  if (view === "XZ") return { Umax: NX, Vmax: NZ };
  return { Umax: NY, Vmax: NZ };
}

function viewToWorld(i, j) {
  const u = cam.u + i, v = cam.v + j;
  if (view === "XY") return { x: u, y: v, z: cur.z };
  if (view === "XZ") return { x: u, y: depthY, z: v };
  return { x: depthX, y: u, z: v };
}

function worldToView(x, y, z) {
  if (view === "XY") return { i: x - cam.u, j: y - cam.v };
  if (view === "XZ") return { i: x - cam.u, j: z - cam.v };
  return { i: y - cam.u, j: z - cam.v };
}

function ensureCursorVisible() {
  const { Umax, Vmax } = planeBounds();
  let uCur, vCur;
  if (view === "XY") { uCur = cur.x; vCur = cur.y; }
  else if (view === "XZ") { uCur = cur.x; vCur = cur.z; }
  else { uCur = cur.y; vCur = cur.z; }

  cam.u = constrain(cam.u, 0, max(0, Umax - CFG.VIEW_W));
  cam.v = constrain(cam.v, 0, max(0, Vmax - CFG.VIEW_H));

  if (uCur < cam.u) cam.u = uCur;
  if (uCur >= cam.u + CFG.VIEW_W) cam.u = uCur - CFG.VIEW_W + 1;
  if (vCur < cam.v) cam.v = vCur;
  if (vCur >= cam.v + CFG.VIEW_H) cam.v = vCur - CFG.VIEW_H + 1;

  cam.u = constrain(cam.u, 0, max(0, Umax - CFG.VIEW_W));
  cam.v = constrain(cam.v, 0, max(0, Vmax - CFG.VIEW_H));
}

// ---------------- DRAW: GRID ----------------
function drawGrid() {
  push();
  translate(CFG.MARGIN, CFG.MARGIN);

  // cursor highlight
  // const pv = worldToView(cur.x, cur.y, cur.z);
  // if (pv.i >= 0 && pv.i < CFG.VIEW_W && pv.j >= 0 && pv.j < CFG.VIEW_H) {
  //   noStroke();
  //   fill(80, 150, 220, 130);
  //   rect(pv.i * CFG.CELL, pv.j * CFG.CELL, CFG.CELL, CFG.CELL);
  // }
  
  const pad = getViewPadding();
  const pv0 = worldToView(cur.x, cur.y, cur.z);
  const pv = { i: pv0.i + pad.padLeft, j: pv0.j + pad.padTop };
  
  // const pad = getViewPadding();

for (let j = 0; j < CFG.VIEW_H; j++) {
  for (let i = 0; i < CFG.VIEW_W; i++) {
    const x = i * CFG.CELL, y = j * CFG.CELL;

    // map screen cell -> plane coords with centering
    const ii = i - pad.padLeft;
    const jj = j - pad.padTop;

    // padding outside the actual plane (e.g. NZ < VIEW_H)
    if (ii < 0 || jj < 0 || ii >= pad.Umax || jj >= pad.Vmax) {
      fill(8);
      stroke(40);
      rect(x, y, CFG.CELL, CFG.CELL);
      stroke(85);
      continue;
    }

    const w = viewToWorld(ii, jj);

    // now w is guaranteed in plane bounds; still keep safety check:
    if (!inBounds(w.x, w.y, w.z)) {
      fill(8);
      stroke(40);
      rect(x, y, CFG.CELL, CFG.CELL);
      stroke(85);
      continue;
    }



  stroke(85);
    
  // for (let j = 0; j < CFG.VIEW_H; j++) {
  //   for (let i = 0; i < CFG.VIEW_W; i++) {
  //     const w = viewToWorld(i, j);
  //     const x = i * CFG.CELL, y = j * CFG.CELL;

      // if (!inBounds(w.x, w.y, w.z)) {
      //   noStroke();
      //   fill(8);
      //   rect(x, y, CFG.CELL, CFG.CELL);
      //   stroke(85);
      //   continue;
      // }
  

      // if(!inBounds(w.x,w.y,w.z)){
      //   // out-of-bounds: joonista ikka ruuduraam, et ei näiks "peidetud"
      //   fill(8);
      //   stroke(40);          // nõrgem raam
      //   rect(x, y, CFG.CELL, CFG.CELL);
      //   stroke(85);          // restore
      //   continue;
      // }


      const ce = cell(w.x, w.y, w.z);
      if (ce.block) {
        fill(10);
        rect(x, y, CFG.CELL, CFG.CELL);
        continue;
      }

      noFill();
      rect(x, y, CFG.CELL, CFG.CELL);

      // number (start cell)
      const num = ce.numR || ce.numD || ce.numI;
      if (num) {
        noStroke();
        fill(170);
        textAlign(LEFT, TOP);
        textSize(10);
        text(num, x + 3, y + 2);
        stroke(85);
      }

      // typed char
      if (ce.ch) {
        noStroke();
        fill(235);
        textAlign(CENTER, CENTER);
        textSize(CFG.CELL * 0.55);
        text(ce.ch, x + CFG.CELL / 2, y + CFG.CELL / 2 + 2);
        stroke(85);
      }
    }
  }

  pop();
}

// ---------------- DRAW: RIGHT STATUS ----------------
function drawRightStatus() {
  const px = CFG.MARGIN * 2 + CFG.VIEW_W * CFG.CELL;
  const py = CFG.MARGIN;

  push();
  translate(px, py);
  fill(230);
  noStroke();
  textAlign(LEFT, TOP);

  textSize(14);
  text(`View: ${view}`, 0, 0);

  textSize(12);
  text(`Cursor: x=${cur.x} y=${cur.y} z=${cur.z}`, 0, 22);

  if (view === "XY") {
    text(`Scroll: Z=${cur.z} | TAB: ${lastAxis === "x" ? "XZ (scroll=Y)" : "YZ (scroll=X)"}`, 0, 42);
  } else if (view === "XZ") {
    text(`XZ | depth Y=${depthY} | TAB back`, 0, 42);
  } else {
    text(`YZ | depth X=${depthX} | TAB back`, 0, 42);
  }

  drawLastMoveArrow(0, 70);

  textSize(11);
  text("J: laadi JSON alla", 0, 180);

  pop();
}

function drawLastMoveArrow(x, y) {
  push();
  translate(x, y);

  fill(28);
  stroke(90);
  rect(0, 0, 92, 92, 10);

  const cx = 46, cy = 46;
  stroke(160);
  line(cx, 10, cx, 82);
  line(10, cy, 82, cy);

  const dx = lastDir.dx, dy = lastDir.dy;
  if (dx || dy) {
    stroke(240);
    strokeWeight(3);
    const ax = cx + dx * 28;
    const ay = cy + dy * 28;
    line(cx, cy, ax, ay);

    strokeWeight(2);
    const ang = atan2(ay - cy, ax - cx);
    const h = 10;
    line(ax, ay, ax - h * cos(ang - 0.6), ay - h * sin(ang - 0.6));
    line(ax, ay, ax - h * cos(ang + 0.6), ay - h * sin(ang + 0.6));
    strokeWeight(1);
  }

  noStroke();
  fill(210);
  textAlign(CENTER, CENTER);
  textSize(10);
  text("Last XY", 46, 10);

  pop();
}

//---------------- DRAW: BOTTOM CLUES ----------------
function drawBottomClues() {
  clueHitboxes = [];

  const baseX = CFG.MARGIN;
  const baseY = CFG.MARGIN * 2 + CFG.VIEW_H * CFG.CELL + 10;

  const areaW = CFG.VIEW_W * CFG.CELL + CFG.PANEL_W;
  const colGap = 16;
  const colW = Math.floor((areaW - colGap * 2) / 3);
  const lineH = 16;

  push();
  translate(baseX, baseY);
  fill(230);
  noStroke();
  textAlign(LEFT, TOP);

  textSize(13);
  text("Nähtavad vihjed (start-numbrid, mis on praegu ruudustikus):", 0, 0);
  const y0 = 22;

  const visR = getVisibleClues("R");
  const visD = getVisibleClues("D");
  const visI = getVisibleClues("I");

  drawClueColumn("PAREMALE", "R", visR, 0 * (colW + colGap), y0, colW, lineH);
  drawClueColumn("ALLA", "D", visD, 1 * (colW + colGap), y0, colW, lineH);
  drawClueColumn("SISSE", "I", visI, 2 * (colW + colGap), y0, colW, lineH);

  pop();
}

function drawClueColumn(title, kind, list, x, y, w, lineH) {
  textSize(12);
  text(title, x, y);
  y += 16;

  const maxLines = Math.floor((CFG.CLUE_AREA_H - 60) / lineH);
  for (let idx = 0; idx < list.length && idx < maxLines; idx++) {
    const c = list[idx];
    // const label = `${c.n}. ${c.hint} (${c.len})`;
    const ans = c.answer ?? "";
    // const label = '${c.n}. ${c.hint} (${c.len})  ${ans};
    const label = `${c.n}. ${c.hint} (${c.len})  ${c.answer ?? ""}`;


    if (cur.x === c.start.x && cur.y === c.start.y && cur.z === c.start.z) {
      noStroke();
      fill(60, 110, 180, 90);
      rect(x, y - 1, w, lineH, 6);
      fill(230);
    }

    text(label, x, y);

    // Hitbox in CANVAS coordinates (not local)
    clueHitboxes.push({
      x: CFG.MARGIN + x,
      y: (CFG.MARGIN * 2 + CFG.VIEW_H * CFG.CELL + 10) + (y - 1),
      w,
      h: lineH,
      kind,
      clue: c
    });

    y += lineH;
  }

  if (list.length > maxLines) {
    text("...", x, y);
  }
}

function getVisibleClues(kind) {
  const list = kind === "R" ? clues.R : kind === "D" ? clues.D : clues.I;

  const u0 = cam.u, v0 = cam.v;
  const u1 = cam.u + CFG.VIEW_W - 1;
  const v1 = cam.v + CFG.VIEW_H - 1;

  const out = [];
  for (const c of list) {
    const s = c.start;

    if (view === "XY") {
      if (s.z !== cur.z) continue;
      if (s.x < u0 || s.x > u1) continue;
      if (s.y < v0 || s.y > v1) continue;
      out.push(c);
    } else if (view === "XZ") {
      if (s.y !== depthY) continue;
      if (s.x < u0 || s.x > u1) continue;
      if (s.z < v0 || s.z > v1) continue;
      out.push(c);
    } else { // YZ
      if (s.x !== depthX) continue;
      if (s.y < u0 || s.y > u1) continue;
      if (s.z < v0 || s.z > v1) continue;
      out.push(c);
    }
  }
  return out;
}

// ---------------- INPUT ----------------
function mousePressed() {
  const pad = getViewPadding();

  // mouse -> screen cell (0..VIEW-1)
  const i = floor((mouseX - CFG.MARGIN) / CFG.CELL);
  const j = floor((mouseY - CFG.MARGIN) / CFG.CELL);

  if (i >= 0 && i < CFG.VIEW_W && j >= 0 && j < CFG.VIEW_H) {

    // screen cell -> plane coords (remove centering)
    const ii = i - pad.padLeft;
    const jj = j - pad.padTop;

    // clicked in padding area (outside actual plane)
    if (ii < 0 || jj < 0 || ii >= pad.Umax || jj >= pad.Vmax) {
      return; // do nothing
    }

    const w = viewToWorld(ii, jj);
    if (inBounds(w.x, w.y, w.z) && !cell(w.x, w.y, w.z).block) {
      cur = { x: w.x, y: w.y, z: w.z };
      depthX = cur.x; depthY = cur.y;
      return;
    }
  }


  // 2) Clue click
  for (const hb of clueHitboxes) {
    if (mouseX >= hb.x && mouseX <= hb.x + hb.w && mouseY >= hb.y && mouseY <= hb.y + hb.h) {
      jumpToClue(hb.kind, hb.clue);
      return;
    }
  }
}

function jumpToClue(kind, c) {
  // R/D are naturally in XY
  if (kind === "R" || kind === "D") {
    view = "XY";
    cur = { x: c.start.x, y: c.start.y, z: c.start.z };
    depthX = cur.x; depthY = cur.y;

    if (kind === "R") { lastAxis = "x"; lastDir = { dx: 1, dy: 0 }; }
    else { lastAxis = "y"; lastDir = { dx: 0, dy: 1 }; }
  } else {
    // I: open XZ or YZ depending on lastAxis
    if (lastAxis === "x") {
      view = "XZ";
      depthY = c.start.y;
      cur = { x: c.start.x, y: depthY, z: c.start.z };
    } else {
      view = "YZ";
      depthX = c.start.x;
      cur = { x: depthX, y: c.start.y, z: c.start.z };
    }
  }
  cam.u = 0; cam.v = 0;
}

function mouseWheel(event) {
  const step = event.delta > 0 ? 1 : -1;

  if (view === "XY") {
    cur.z = constrain(cur.z + step, 0, NZ - 1);
  } else if (view === "XZ") {
    depthY = constrain(depthY + step, 0, NY - 1);
    cur.y = depthY;
  } else {
    depthX = constrain(depthX + step, 0, NX - 1);
    cur.x = depthX;
  }
  return false;
}

function keyPressed() {
  //if (key === "j" || key === "J") {
    // downloadPuzzleJSON();
    //return;
  //}

  if (keyCode === TAB) {
    if (view === "XY") {
      if (lastAxis === "x") { view = "XZ"; depthY = cur.y; }
      else { view = "YZ"; depthX = cur.x; }
      cam.u = 0; cam.v = 0;
    } else {
      view = "XY";
      cam.u = 0; cam.v = 0;
    }
    return false;
  }

  if (keyCode === LEFT_ARROW) { moveInView(-1, 0); return; }
  if (keyCode === RIGHT_ARROW) { moveInView(1, 0); return; }
  if (keyCode === UP_ARROW) { moveInView(0, -1); return; }
  if (keyCode === DOWN_ARROW) { moveInView(0, 1); return; }

  if (keyCode === BACKSPACE || keyCode === DELETE) {
    const ce = cell(cur.x, cur.y, cur.z);
    if (!ce.block) ce.ch = "";
    return false;
  }

  const ch = normalizeChar(key);
  if (ch) {
    const ce = cell(cur.x, cur.y, cur.z);
    if (!ce.block) ce.ch = ch;
  }
}

function normalizeChar(k) {
  if (!k || k.length !== 1) return null;
  const up = k.toUpperCase();
  const ok = "ABCDEFGHIJKLMNOPQRSTUVWXYZÕÄÖÜŠŽ";
  return ok.includes(up) ? up : null;
}

function moveInView(du, dv) {
  let nx = cur.x, ny = cur.y, nz = cur.z;

  if (view === "XY") {
    nx += du; ny += dv;
    if (du !== 0) { lastAxis = "x"; lastDir = { dx: du, dy: 0 }; }
    if (dv !== 0) { lastAxis = "y"; lastDir = { dx: 0, dy: dv }; }
  } else if (view === "XZ") {
    nx += du; nz += dv; ny = depthY;
  } else {
    ny += du; nz += dv; nx = depthX;
  }

  if (!inBounds(nx, ny, nz)) return;
  if (cell(nx, ny, nz).block) return;

  cur = { x: nx, y: ny, z: nz };
  depthX = cur.x; depthY = cur.y;
}

function getViewPadding() {
  const { Umax, Vmax } = planeBounds();
  const padU = max(0, CFG.VIEW_W - Umax);
  const padV = max(0, CFG.VIEW_H - Vmax);
  return {
    Umax, Vmax,
    padLeft: floor(padU / 2),
    padTop: floor(padV / 2),
  };
}


