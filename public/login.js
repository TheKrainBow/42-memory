const screen = document.querySelector("[data-page='login']");
const loginStep = document.getElementById("loginStep");
const coalitionStep = document.getElementById("coalitionStep");
const loginButton = document.getElementById("loginButton");
const message = document.getElementById("loginMessage");
const coalitionMessage = document.getElementById("coalitionMessage");
const loginProfile = document.getElementById("loginProfile");
const nextPath = screen?.dataset.next || "/";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function continueToApp() {
  window.location.href = nextPath;
}

function showCoalitionStep(user) {
  loginProfile.innerHTML = `
    ${user.imageUrl ? `<img class="avatar avatar-lg" src="${escapeHtml(user.imageUrl)}" alt="" />` : ""}
    <strong>${escapeHtml(user.login)}</strong>
  `;
  loginStep.hidden = true;
  coalitionStep.hidden = false;
}

// The user is through once connected AND holding a coalition (the coalition
// drives the site theme); otherwise switch to the coalition choice step.
function handleUser(user) {
  if (!user) {
    return false;
  }
  if (user.needsCoalition) {
    showCoalitionStep(user);
  } else {
    continueToApp();
  }
  return true;
}

async function fetchMe() {
  const response = await fetch(`/api/me?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }
  return (await response.json()).user;
}

function openLoginPopup() {
  const width = 520;
  const height = 720;
  const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
  window.open("/auth/42", "ft42auth", `width=${width},height=${height},left=${left},top=${top},popup=yes`);
  message.textContent = "Connexion en cours dans la fenêtre 42…";
  message.className = "message";
  startSessionWatch();
}

let watchTimer = null;

// Fallback when the popup's postMessage is lost (blocked opener, COOP…):
// poll the session until the login completes.
function startSessionWatch() {
  if (watchTimer) {
    return;
  }
  watchTimer = setInterval(async () => {
    if (handleUser(await fetchMe())) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }, 1500);
}

window.addEventListener("message", async (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== "42-auth") {
    return;
  }
  if (event.data.ok) {
    handleUser(await fetchMe());
  } else {
    message.textContent = event.data.error || "Connexion 42 impossible.";
    message.className = "message error";
  }
});

loginButton?.addEventListener("click", openLoginPopup);

for (const button of coalitionStep?.querySelectorAll("[data-coalition]") ?? []) {
  button.addEventListener("click", async () => {
    const response = await fetch("/api/me/coalition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coalition: button.dataset.coalition }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      coalitionMessage.textContent = payload.error || "Choix impossible, réessayez.";
      coalitionMessage.className = "message error";
      return;
    }
    continueToApp();
  });
}
