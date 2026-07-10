// Deterministic word-cloud layout: positions are computed on a fixed virtual
// canvas from the seed and the word list only, so every screen with the same
// seed gets the same arrangement regardless of viewport size.

export function normalizeWord(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function createRng(initialSeed) {
  let t = initialSeed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts) {
  const source = parts.join("|");
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffle(list, rng) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function rectsOverlap(a, b, padding) {
  return !(
    a.right + padding < b.left ||
    a.left - padding > b.right ||
    a.bottom + padding < b.top ||
    a.top - padding > b.bottom
  );
}

const VIRTUAL_WIDTH = 1920;
const VIRTUAL_HEIGHT = 840;
const BASE_VIRTUAL_FONT = 16;
const MAX_VIRTUAL_FONT = 44;
const MIN_VIRTUAL_FONT = 10;
const PLACEMENT_PADDING = 6;
export const MIN_FONT_SIZE = 10;

// Conservative box for the rendered word (font-weight 800, letter-spacing
// -0.04em): estimates must be >= the real rendered size or words can touch.
function estimateWordBox(word, fontSize) {
  return {
    width: String(word).length * fontSize * 0.66 + fontSize,
    height: fontSize * 1.6,
  };
}

// Deterministic last resort when random placement keeps colliding: walk a
// coarse grid from a seeded start and take the first free spot, relaxing the
// padding before ever allowing an overlap.
function findFallbackSpot(box, placed, rng) {
  const step = 14;
  const cols = Math.max(1, Math.floor((VIRTUAL_WIDTH - box.width) / step));
  const rows = Math.max(1, Math.floor((VIRTUAL_HEIGHT - box.height) / step));
  const total = cols * rows;
  const start = Math.floor(rng() * total);

  for (const padding of [PLACEMENT_PADDING, 2, 0]) {
    for (let k = 0; k < total; k += 1) {
      const cell = (start + k) % total;
      const left = (cell % cols) * step;
      const top = Math.floor(cell / cols) * step;
      const rect = { left, top, right: left + box.width, bottom: top + box.height };
      if (!placed.some((item) => rectsOverlap(rect, item, padding))) {
        return rect;
      }
    }
  }

  const left = rng() * (VIRTUAL_WIDTH - box.width);
  const top = rng() * (VIRTUAL_HEIGHT - box.height);
  return { left, top, right: left + box.width, bottom: top + box.height };
}

// In strict mode, a word that cannot be placed without overlap makes the whole
// layout fail (returns null) instead of falling back — that is what the
// font-size search probes.
function computeVirtualLayout(seed, labels, fontSize, strict) {
  const rng = createRng(hashSeed(seed, labels.length, fontSize));
  // Widest words first: they are the hardest to fit. Ties (same length) keep
  // the seeded shuffle order, so the layout still varies with the seed.
  const order = shuffle(labels.map((_, index) => index), rng)
    .sort((a, b) => labels[b].length - labels[a].length);
  const placed = [];
  const positions = new Array(labels.length);

  for (const index of order) {
    const box = estimateWordBox(labels[index], fontSize);
    const maxLeft = Math.max(1, VIRTUAL_WIDTH - box.width);
    const maxTop = Math.max(1, VIRTUAL_HEIGHT - box.height);
    let candidate = null;

    for (let attempt = 0; attempt < 2500 && !candidate; attempt += 1) {
      const left = rng() * maxLeft;
      const top = rng() * maxTop;
      const rectCandidate = {
        left,
        top,
        right: left + box.width,
        bottom: top + box.height,
      };
      if (!placed.some((item) => rectsOverlap(rectCandidate, item, PLACEMENT_PADDING))) {
        candidate = rectCandidate;
      }
    }

    if (!candidate) {
      if (strict) {
        return null;
      }
      candidate = findFallbackSpot(box, placed, rng);
    }

    placed.push(candidate);
    positions[index] = {
      leftFrac: candidate.left / VIRTUAL_WIDTH,
      topFrac: candidate.top / VIRTUAL_HEIGHT,
    };
  }

  return positions;
}

// Start at the base size, grow the font one step at a time until a size
// produces an overlap, then settle below that overlapping size.
export function resolveVirtualLayout(seed, labels) {
  let size = BASE_VIRTUAL_FONT;
  let positions = computeVirtualLayout(seed, labels, size, true);

  while (!positions && size > MIN_VIRTUAL_FONT) {
    size -= 1;
    positions = computeVirtualLayout(seed, labels, size, true);
  }
  if (!positions) {
    return {
      fontSize: MIN_VIRTUAL_FONT,
      positions: computeVirtualLayout(seed, labels, MIN_VIRTUAL_FONT, false),
    };
  }

  while (size < MAX_VIRTUAL_FONT) {
    const next = computeVirtualLayout(seed, labels, size + 1, true);
    if (!next) {
      let target = Math.max(MIN_VIRTUAL_FONT, size - 1);
      let settled = computeVirtualLayout(seed, labels, target, true);
      while (!settled && target > MIN_VIRTUAL_FONT) {
        target -= 1;
        settled = computeVirtualLayout(seed, labels, target, true);
      }
      return settled ? { fontSize: target, positions: settled } : { fontSize: size, positions };
    }
    size += 1;
    positions = next;
  }

  return { fontSize: size, positions };
}

export const VIRTUAL_CANVAS = { width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT };
