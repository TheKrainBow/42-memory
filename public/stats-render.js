import { escapeHtml, formatDuration } from "/assets/common.js";

// Validated on the dark chart surface (lightness band, chroma, CVD, contrast).
export const CHART_COLORS = { HORDE: "#ef5a22", ALLIANCE: "#4f8fef" };

export function verdictText(game) {
  if (game.settings.mode === "versus") {
    const { HORDE: horde, ALLIANCE: alliance } = game.coalitionScores;
    return horde === alliance ? `Égalité ${horde} - ${alliance}` :
      horde > alliance ? `Victoire Horde ${horde} - ${alliance}` :
      `Victoire Alliance ${alliance} - ${horde}`;
  }
  return `${game.foundCount} / ${game.wordCount} mots trouvés`;
}

function leaderboardRow(player, index, metric) {
  return `
    <div class="leaderboard-row">
      <span class="leaderboard-rank">#${index + 1}</span>
      ${player.image_url ? `<img class="avatar" src="${escapeHtml(player.image_url)}" alt="" />` : ""}
      <strong class="leaderboard-login">${escapeHtml(player.login)}</strong>
      <span class="leaderboard-stats">${metric}</span>
    </div>
  `;
}

export function renderLeaderboards({ byFoundEl, byFailsEl, players }) {
  byFoundEl.innerHTML = players
    .map((p, i) => leaderboardRow(p, i, `${p.found_count} trouvés`))
    .join("") || `<div class="empty-copy">Aucun joueur.</div>`;
  const byFails = [...players].sort((a, b) => b.mistake_count - a.mistake_count || a.login.localeCompare(b.login));
  byFailsEl.innerHTML = byFails
    .map((p, i) => leaderboardRow(p, i, `${p.mistake_count} erreurs`))
    .join("") || `<div class="empty-copy">Aucun joueur.</div>`;
}

// Cumulative "found words over time" step chart. Inline SVG, one series in
// coop, one per coalition in versus. Time axis starts when writing opens.
export function renderFoundChart({ container, legend, game }) {
  const versus = game.settings.mode === "versus";
  const revealOffset = game.settings.revealSeconds;
  const gameEndS = game.finishedAt
    ? Math.max(1, Math.round((new Date(game.finishedAt) - new Date(game.startedAt)) / 1000) - revealOffset)
    : game.settings.writeSeconds;
  const maxT = Math.max(30, gameEndS);
  const maxY = game.wordCount;

  const seriesDefs = versus
    ? [
        { key: "HORDE", label: "Horde", color: CHART_COLORS.HORDE },
        { key: "ALLIANCE", label: "Alliance", color: CHART_COLORS.ALLIANCE },
      ]
    : [{ key: "ALL", label: "Mots trouvés", color: "var(--accent)" }];

  const points = (game.timeline ?? []).map((item) => ({
    t: Math.max(0, item.t - revealOffset),
    key: versus ? item.coalition : "ALL",
  }));

  const series = seriesDefs.map((def) => {
    let count = 0;
    const steps = [{ t: 0, v: 0 }];
    for (const point of points) {
      if (point.key !== def.key) {
        continue;
      }
      count += 1;
      steps.push({ t: point.t, v: count });
    }
    steps.push({ t: maxT, v: count });
    return { ...def, steps, total: count };
  });

  const W = 860;
  const H = 340;
  const PAD = { top: 14, right: 88, bottom: 30, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (t) => PAD.left + (t / maxT) * plotW;
  const y = (v) => PAD.top + plotH - (v / maxY) * plotH;

  const gridLines = [0.25, 0.5, 0.75, 1].map((frac) => {
    const value = Math.round(maxY * frac);
    return `
      <line x1="${PAD.left}" y1="${y(value)}" x2="${PAD.left + plotW}" y2="${y(value)}" class="chart-grid" />
      <text x="${PAD.left - 8}" y="${y(value) + 4}" class="chart-tick" text-anchor="end">${value}</text>
    `;
  }).join("");

  const timeTicks = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    const t = Math.round(maxT * frac);
    return `<text x="${x(t)}" y="${H - 8}" class="chart-tick" text-anchor="middle">${formatDuration(t * 1000)}</text>`;
  }).join("");

  const paths = series.map((s) => {
    const d = s.steps
      .map((step, i) => {
        const px = x(step.t).toFixed(1);
        const py = y(step.v).toFixed(1);
        // step-after: hold the value until the next found word.
        return i === 0 ? `M ${px} ${py}` : `H ${px} V ${py}`;
      })
      .join(" ");
    const last = s.steps[s.steps.length - 1];
    return `
      <path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" />
      <circle cx="${x(last.t)}" cy="${y(last.v)}" r="4" fill="${s.color}" stroke="var(--bg-1)" stroke-width="2" />
      <text x="${x(last.t) + 10}" y="${y(last.v) + 4}" class="chart-end-label">${s.total}</text>
    `;
  }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="found-chart-svg" role="img" aria-label="Mots trouvés au fil du temps">
      ${gridLines}
      <line x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${PAD.left + plotW}" y2="${PAD.top + plotH}" class="chart-axis" />
      ${timeTicks}
      ${paths}
      <line data-crosshair x1="0" y1="${PAD.top}" x2="0" y2="${PAD.top + plotH}" class="chart-crosshair" visibility="hidden" />
    </svg>
    <div class="chart-tooltip" hidden></div>
  `;

  legend.innerHTML = series.length > 1
    ? series.map((s) => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}</span>`).join("")
    : "";

  // Hover layer: crosshair + tooltip with each series' count at that time.
  const svg = container.querySelector("svg");
  const crosshair = container.querySelector("[data-crosshair]");
  const tooltip = container.querySelector(".chart-tooltip");
  svg.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const frac = (event.clientX - rect.left) / rect.width;
    const t = Math.min(maxT, Math.max(0, ((frac * W) - PAD.left) / plotW * maxT));
    if (frac * W < PAD.left || frac * W > PAD.left + plotW) {
      crosshair.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
      return;
    }
    crosshair.setAttribute("x1", x(t));
    crosshair.setAttribute("x2", x(t));
    crosshair.setAttribute("visibility", "visible");
    const rows = series.map((s) => {
      let value = 0;
      for (const step of s.steps) {
        if (step.t <= t) {
          value = step.v;
        }
      }
      return `<div><span class="legend-dot" style="background:${s.color}"></span>${escapeHtml(s.label)} : <strong>${value}</strong></div>`;
    }).join("");
    tooltip.innerHTML = `<div class="chart-tooltip-time">${formatDuration(t * 1000)}</div>${rows}`;
    tooltip.hidden = false;
    const tooltipX = Math.min(rect.width - 150, Math.max(0, event.clientX - rect.left + 14));
    tooltip.style.left = `${tooltipX}px`;
    tooltip.style.top = `12px`;
  });
  svg.addEventListener("mouseleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
  });
}
