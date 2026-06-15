const form = document.getElementById("startGameForm");
const seedInput = document.getElementById("seedInput");
const randomizeSeedButton = document.getElementById("randomizeSeedButton");

function randomSeed() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

if (seedInput && !seedInput.value) {
  seedInput.value = String(randomSeed());
}

if (randomizeSeedButton) {
  randomizeSeedButton.addEventListener("click", () => {
    if (seedInput) {
      seedInput.value = String(randomSeed());
      seedInput.focus();
      seedInput.select();
    }
  });
}

if (form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector("[data-start-game]");
    const seed = Number.parseInt(seedInput?.value || "", 10);
    const payload = Number.isFinite(seed) && seed > 0 ? { seed } : {};

    submitButton.setAttribute("aria-busy", "true");
    submitButton.disabled = true;
    try {
      const response = await fetch("/api/game/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error("Unable to create a new game");
      }
      window.location.href = "/tv";
    } finally {
      submitButton.removeAttribute("aria-busy");
      submitButton.disabled = false;
    }
  });
}
