#!/usr/bin/env node

/*
  scripts/generate-snake.js

  Generates dist/snake.svg based on the GitHub contribution grid for the repository owner.
  - Fetches contribution calendar via GraphQL (contributionsCollection.contributionCalendar)
  - Builds the grid (7 rows, N weeks)
  - Occupied cell = contributionCount > 0
  - Uses A* pathfinding with heavy penalty for occupied cells and small penalty for turns
  - Builds a smooth path and emits an animated SVG to dist/snake.svg
*/

const fs = require('fs');
const path = require('path');
const util = require('util');

const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);

const GITHUB_API = 'https://api.github.com/graphql';
const GITHUB_REST = 'https://api.github.com';

async function run() {
  try {
    const repo = process.env.GITHUB_REPOSITORY || '';
    const username = repo ? repo.split('/')[0] : (process.env.USERNAME || process.env.USER || 'rahulbhattsd');
    const token = process.env.GITHUB_TOKEN || '';

    console.log(`Generating snake for user: ${username}`);
    if (!token) {
      console.log('No GITHUB_TOKEN found in env. Will try unauthenticated GraphQL (public data), but rate limits may apply.');
    }

    // Fetch contribution calendar via GraphQL
    const calendar = await fetchContributionCalendar(username, token);
    if (!calendar || !calendar.weeks || calendar.weeks.length === 0) {
      throw new Error('Contribution calendar fetch returned no weeks.');
    }

    // Build grid: rows=7, cols=weeks.length
    const weeks = calendar.weeks;
    const rows = 7;
    const cols = weeks.length;
    const grid = Array.from({ length: rows }, () => Array(cols).fill(0));
    const colorGrid = Array.from({ length: rows }, () => Array(cols).fill('#ebedf0'));
    const dateGrid = Array.from({ length: rows }, () => Array(cols).fill(null));

    for (let x = 0; x < cols; x++) {
      const week = weeks[x];
      if (!week || !week.contributionDays) continue;
      for (let y = 0; y < rows; y++) {
        const day = week.contributionDays[y];
        if (!day) continue;
        const occupied = (day.contributionCount || 0) > 0 ? 1 : 0;
        grid[y][x] = occupied;
        colorGrid[y][x] = day.color || (occupied ? '#0e4429' : '#ebedf0');
        dateGrid[y][x] = day.date;
      }
    }

    // Dimensions and visual settings
    const cellSize = 12;
    const gap = 4;
    const padding = 12;
    const width = padding * 2 + cols * cellSize + (cols - 1) * gap;
    const height = padding * 2 + rows * cellSize + (rows - 1) * gap;
    const totalCells = rows * cols;

    // Pathfinding params
    const occupiedCost = 10000; // very high cost to avoid occupied cells
    const emptyCost = 1;
    const turnPenalty = 0.5; // small penalty to encourage straighter paths

    // Path length target (25% of available cells clamped)
    const targetRatio = 0.28;
    const minCells = 10;
    const maxRatio = 0.45;
    const targetLength = Math.max(minCells, Math.floor(totalCells * Math.min(maxRatio, targetRatio)));

    console.log(`Grid: ${rows} rows x ${cols} cols => ${totalCells} cells.`);
    console.log(`Target snake length (cells): ${targetLength}`);

    // Helper: find candidate start cell (first available empty cell scanning left->right, top->bottom)
    const start = findStartCell(grid, rows, cols);
    if (!start) {
      throw new Error('No start cell found (grid appears fully occupied).');
    }

    console.log(`Start cell chosen at r=${start.r}, c=${start.c}`);

    // Greedily build path by selecting successive farthest empty waypoints and connecting with A*
    const pathCells = await buildSnakePath(grid, rows, cols, start, targetLength, {
      occupiedCost,
      emptyCost,
      turnPenalty
    });

    if (!pathCells || pathCells.length < 2) {
      throw new Error('Pathfinding failed to produce a usable path.');
    }

    console.log(`Computed path length: ${pathCells.length} cells`);

    // Map cells to coordinates (center of cell)
    function cellCenter(r, c) {
      const x = padding + c * (cellSize + gap) + cellSize / 2;
      const y = padding + r * (cellSize + gap) + cellSize / 2;
      return { x, y };
    }

    const centers = pathCells.map(([r, c]) => cellCenter(r, c));

    // Build smooth path string from centers (Catmull-Rom to Bezier)
    const pathD = buildSmoothPath(centers);

    // Determine animation duration proportional to path length (but bounded)
    const baseDuration = 6; // seconds
    const dur = Math.min(20, Math.max(baseDuration, Math.round(pathCells.length / 4)));

    // Build SVG content
    const svg = buildSVG({
      width,
      height,
      padding,
      rows,
      cols,
      cellSize,
      gap,
      colorGrid,
      dateGrid,
      pathD,
      pathCells,
      centers,
      dur
    });

    // Write dist/snake.svg
    await mkdir(path.join(process.cwd(), 'dist'), { recursive: true });
    const outPath = path.join(process.cwd(), 'dist', 'snake.svg');
    await writeFile(outPath, svg, 'utf8');
    console.log(`Wrote ${outPath}`);
    console.log('Generation complete.');

  } catch (err) {
    console.error('ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

/* --- Helpers --- */

async function fetchContributionCalendar(username, token) {
  const query = `
    query ($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
                color
              }
            }
          }
        }
      }
    }
  `;
  const body = JSON.stringify({ query, variables: { login: username } });
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'github-profile-snake-generator'
  };
  if (token) headers['Authorization'] = `bearer ${token}`;

  const res = await fetch(GITHUB_API, { method: 'POST', headers, body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}: ${text}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error('GraphQL returned errors: ' + JSON.stringify(json.errors));
  }
  const calendar = json.data && json.data.user && json.data.user.contributionsCollection && json.data.user.contributionsCollection.contributionCalendar;
  if (!calendar) {
    throw new Error('No contributionCalendar found for user.');
  }
  return calendar;
}

function findStartCell(grid, rows, cols) {
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      if (grid[r][c] === 0) return { r, c };
    }
  }
  // fallback to any cell
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) if (grid[r][c] >= 0) return { r, c };
  return null;
}

async function buildSnakePath(grid, rows, cols, start, targetLength, costs) {
  // Strategy:
  // - Maintain visited set
  // - From current position, find farthest empty cell (Manhattan) not visited that yields a valid A* path
  // - Append path segment (excluding the starting duplicate)
  // - Stop when targetLength reached or cannot extend further
  const visited = new Set();
  const path = [[start.r, start.c]];
  visited.add(`${start.r},${start.c}`);
  let current = start;
  let attemptsWithoutProgress = 0;

  // Precompute empty cell list
  const emptyCells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] === 0) emptyCells.push([r, c]);
    }
  }

  // If few empty cells, allow going through occupied cells if required
  const maxAttempts = 500;

  while (path.length < targetLength && attemptsWithoutProgress < maxAttempts) {
    // pick candidate farthest empty cell by Manhattan distance from current, that is not the current cell
    let candidate = null;
    let bestDist = -1;
    for (const [r, c] of emptyCells) {
      const key = `${r},${c}`;
      if (visited.has(key)) continue;
      const dist = Math.abs(r - current.r) + Math.abs(c - current.c);
      if (dist > bestDist) {
        bestDist = dist;
        candidate = { r, c };
      }
    }
    // If no empty candidate left, attempt to pick any not-visited cell (including occupied)
    if (!candidate) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const key = `${r},${c}`;
          if (visited.has(key)) continue;
          const dist = Math.abs(r - current.r) + Math.abs(c - current.c);
          if (dist > bestDist) {
            bestDist = dist;
            candidate = { r, c };
          }
        }
      }
      if (!candidate) break;
    }

    // Run A* from current to candidate
    const segment = aStar(grid, rows, cols, current, candidate, costs);
    if (!segment || segment.length === 0) {
      // can't reach candidate; mark as visited to avoid trying again
      attemptsWithoutProgress++;
      // mark candidate as visited to skip next time
      const key = `${candidate.r},${candidate.c}`;
      visited.add(key);
      continue;
    }

    // Append segment excluding the first cell (duplicate)
    for (let i = 1; i < segment.length; i++) {
      const [r, c] = segment[i];
      const key = `${r},${c}`;
      if (!visited.has(key)) {
        path.push([r, c]);
        visited.add(key);
      }
      if (path.length >= targetLength) break;
    }
    current = { r: path[path.length - 1][0], c: path[path.length - 1][1] };
    attemptsWithoutProgress = 0;
  }

  // If still too short, try a fallback spanning towards some other cells
  if (path.length < Math.max(6, Math.floor(targetLength * 0.66))) {
    console.log('Path shorter than desired; attempting greedy walk to fill length.');
    // greedy walk: try neighbours to extend
    let cur = { r: path[path.length - 1][0], c: path[path.length - 1][1] };
    let loopGuard = 0;
    while (path.length < targetLength && loopGuard++ < 1000) {
      const neighbors = neighborsList(cur.r, cur.c, rows, cols);
      // pick the neighbor with lowest cost not already in path
      neighbors.sort((a, b) => {
        const costA = grid[a[0]][a[1]] === 0 ? costs.emptyCost : costs.occupiedCost;
        const costB = grid[b[0]][b[1]] === 0 ? costs.emptyCost : costs.occupiedCost;
        return costA - costB;
      });
      let added = false;
      for (const [nr, nc] of neighbors) {
        const key = `${nr},${nc}`;
        if (path.find(p => p[0] === nr && p[1] === nc)) continue;
        path.push([nr, nc]);
        added = true;
        cur = { r: nr, c: nc };
        break;
      }
      if (!added) break;
    }
  }

  return path;
}

function aStar(grid, rows, cols, start, goal, costs) {
  const startKey = `${start.r},${start.c}`;
  const goalKey = `${goal.r},${goal.c}`;

  // Each state: {r,c,dir} where dir is previous move direction index 0..3 or null
  const dirs = [
    [-1, 0], // up (0)
    [0, 1],  // right (1)
    [1, 0],  // down (2)
    [0, -1]  // left (3)
  ];

  const open = new TinyPriorityQueue((a, b) => a.f - b.f);
  const cameFrom = new Map();
  const gScore = new Map();

  function key(r, c, dir) {
    return `${r},${c},${dir === null ? 'n' : dir}`;
  }

  const startStateKey = key(start.r, start.c, null);
  gScore.set(startStateKey, 0);
  open.push({ r: start.r, c: start.c, dir: null, f: heuristic(start, goal) });

  while (open.size) {
    const current = open.pop();
    const curKey = key(current.r, current.c, current.dir);

    if (current.r === goal.r && current.c === goal.c) {
      // Reconstruct path. We ignore dir keys for final output
      const path = [];
      let k = curKey;
      while (k) {
        const v = cameFrom.get(k);
        const parts = k.split(',');
        const rr = parseInt(parts[0], 10);
        const cc = parseInt(parts[1], 10);
        path.push([rr, cc]);
        k = v;
      }
      path.reverse();
      return path;
    }

    for (let d = 0; d < dirs.length; d++) {
      const nr = current.r + dirs[d][0];
      const nc = current.c + dirs[d][1];
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const occupied = grid[nr][nc] > 0;
      const base = occupied ? costs.occupiedCost : costs.emptyCost;
      let tentativeG = (gScore.get(curKey) || Infinity) + base;

      // turn penalty
      if (current.dir !== null && current.dir !== d) tentativeG += costs.turnPenalty;

      const neighKey = key(nr, nc, d);
      const prevG = gScore.get(neighKey) || Infinity;
      if (tentativeG < prevG) {
        gScore.set(neighKey, tentativeG);
        const f = tentativeG + heuristic({ r: nr, c: nc }, goal);
        cameFrom.set(neighKey, curKey);
        open.push({ r: nr, c: nc, dir: d, f });
      }
    }
  }

  // No path
  return null;
}

function heuristic(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
}

function neighborsList(r, c, rows, cols) {
  const res = [];
  if (r - 1 >= 0) res.push([r - 1, c]);
  if (c + 1 < cols) res.push([r, c + 1]);
  if (r + 1 < rows) res.push([r + 1, c]);
  if (c - 1 >= 0) res.push([r, c - 1]);
  return res;
}

// Tiny binary heap / priority queue (min)
class TinyPriorityQueue {
  constructor(comparator) {
    this.data = [];
    this.comparator = comparator || ((a, b) => a - b);
  }
  push(item) {
    this.data.push(item);
    this._siftUp();
  }
  pop() {
    if (this.size === 0) return undefined;
    const top = this.data[0];
    const bottom = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = bottom;
      this._siftDown();
    }
    return top;
  }
  _siftUp() {
    let idx = this.data.length - 1;
    while (idx > 0) {
      let parent = Math.floor((idx - 1) / 2);
      if (this.comparator(this.data[idx], this.data[parent]) < 0) {
        [this.data[idx], this.data[parent]] = [this.data[parent], this.data[idx]];
        idx = parent;
      } else break;
    }
  }
  _siftDown() {
    let idx = 0;
    const len = this.data.length;
    while (true) {
      let left = idx * 2 + 1;
      let right = idx * 2 + 2;
      let smallest = idx;
      if (left < len && this.comparator(this.data[left], this.data[smallest]) < 0) smallest = left;
      if (right < len && this.comparator(this.data[right], this.data[smallest]) < 0) smallest = right;
      if (smallest !== idx) {
        [this.data[idx], this.data[smallest]] = [this.data[smallest], this.data[idx]];
        idx = smallest;
      } else break;
    }
  }
  get size() { return this.data.length; }
}

/* Smooth path builder: Catmull-Rom to Bezier
   Input: array of points [{x,y}, ...]
   Output: 'M x y C ...' path string
*/
function buildSmoothPath(points) {
  if (!points || points.length === 0) return '';
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }
  // Catmull-Rom parameters
  const cr2bezier = (pts, i) => {
    // Convert CR segment to cubic Bezier points
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1] || p1;
    const p3 = pts[i + 2] || p2;
    const bp1 = {
      x: p1.x + (p2.x - p0.x) / 6,
      y: p1.y + (p2.y - p0.y) / 6
    };
    const bp2 = {
      x: p2.x - (p3.x - p1.x) / 6,
      y: p2.y - (p3.y - p1.y) / 6
    };
    return { bp1, bp2 };
  };

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const { bp1, bp2 } = cr2bezier(points, i);
    d += ` C ${bp1.x} ${bp1.y}, ${bp2.x} ${bp2.y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function buildSVG(opts) {
  const {
    width,
    height,
    rows,
    cols,
    cellSize,
    gap,
    colorGrid,
    dateGrid,
    pathD,
    pathCells,
    centers,
    dur
  } = opts;

  // Draw background (transparent-friendly but with subtle dark panel)
  const bgRect = `<rect x="0" y="0" width="${width}" height="${height}" fill="transparent"/>`;

  // Contribution cells (draw them after the snake path so cells appear on top if needed)
  let cells = '';
  const padding = 0;
  const cellPad = 0;
  const topPad = 0;
  const totalWidth = width;
  const totalHeight = height;
  const left = 0;
  const top = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = left + padding + c * (cellSize + gap);
      const y = top + padding + r * (cellSize + gap);
      const color = colorGrid[r][c] || '#ebedf0';
      const date = dateGrid[r][c] || '';
      const title = `${date}`;
      cells += `
        <rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}"
          rx="3" ry="3"
          fill="${color}">
          <title>${title}</title>
        </rect>
      `;
    }
  }

  // Snake path stroke styling
  const snakeColor = '#ffb86b'; // distinct color against greens
  const snakeStrokeWidth = Math.max(6, Math.min(10, Math.round(cellSize * 0.6)));
  const pathId = 'snakePath';

  // Path background (subtle glow)
  const pathBg = `<path id="${pathId}-bg" d="${pathD}" fill="none" stroke="#2b2b2b" stroke-opacity="0.18" stroke-width="${snakeStrokeWidth + 6}" stroke-linecap="round" stroke-linejoin="round"/>`;

  // Main path
  const pathMain = `<path id="${pathId}" d="${pathD}" fill="none" stroke="${snakeColor}" stroke-width="${snakeStrokeWidth}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.95"/>`;

  // Head circle that follows the path using animateMotion
  const head = `
    <g id="snakeHead" transform="translate(0,0)">
      <circle r="${snakeStrokeWidth/2}" fill="#ff6b6b" stroke="#fff" stroke-width="1" />
      <circle r="${Math.max(1, Math.round(snakeStrokeWidth/6))}" cx="${snakeStrokeWidth/3}" cy="${-snakeStrokeWidth/3}" fill="#fff" opacity="0.9" />
    </g>
    <animateMotion xlink:href="#snakeHead" dur="${dur}s" repeatCount="indefinite">
      <mpath xlink:href="#${pathId}" />
    </animateMotion>
  `;

  // Snake body animation: use stroke-dasharray to make a traveling dash look
  // Compute dash length heuristically relative to path length; but path length isn't known without DOM.
  // We'll use a repeating dash pattern and animate dashoffset to create motion illusion.
  const bodyAnim = `
    <animate xlink:href="#${pathId}" attributeName="stroke-dashoffset" from="0" to="-200" dur="${dur}s" repeatCount="indefinite" />
    <animate xlink:href="#${pathId}-bg" attributeName="stroke-dashoffset" from="0" to="-200" dur="${dur}s" repeatCount="indefinite" />
  `;

  // Combine everything. Draw path first (so it's behind cells) to ensure contribution squares remain fully visible.
  // Then draw path top overlay head (subtle) if desired. To keep contribution colors visible, main stroke uses semi-opaque color and is relatively narrow.
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Animated snake moving through my GitHub contribution graph">
  <title>Snake animation over contribution graph</title>
  ${bgRect}
  <g id="snakeLayer" transform="translate(0,0)">
    ${pathBg}
    ${pathMain}
    ${bodyAnim}
  </g>
  <g id="cellsLayer">
    ${cells}
  </g>
  <g id="headLayer">
    ${head}
  </g>
</svg>
  `;
  return svg;
}

run();
