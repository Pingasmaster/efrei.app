import { createRouter } from "./router.js";
import { createState } from "./state.js";
import { createApi } from "./api.js";
import { createOddsStream } from "./realtime.js";
import { renderHome } from "./views/home.js";
import { renderLogin } from "./views/login.js";
import { renderSignup } from "./views/signup.js";
import { renderNotFound } from "./views/not-found.js";

const viewRoot = document.querySelector("#view");
const statusEl = document.querySelector("[data-auth-status]");
const rawApiBase = document.querySelector("meta[name=api-base]")?.content?.trim();
let apiBase = rawApiBase || window.location.origin;
if (apiBase.startsWith("/")) {
    apiBase = `${window.location.origin}${apiBase}`;
}

const state = createState();
const api = createApi({ baseUrl: apiBase, state });
let cleanupView = null;

const updateStatus = () => {
    if (!statusEl) return;
    statusEl.textContent = state.token ? "Signed in" : "Guest";
};

const updateActiveLinks = (path) => {
    const navLinks = document.querySelectorAll("a[data-link]");
    navLinks.forEach((link) => {
        const url = new URL(link.href);
        if (url.pathname === path) {
            link.setAttribute("aria-current", "page");
        } else {
            link.removeAttribute("aria-current");
        }
    });
};

const routes = {
    "/": renderHome,
    "/login": renderLogin,
    "/signup": renderSignup,
    "/not-found": renderNotFound
};

createRouter({
    routes,
    onRoute: (path, view, navigate) => {
        if (cleanupView) {
            cleanupView();
            cleanupView = null;
        }
        if (typeof view === "function") {
            cleanupView = view(viewRoot, { api, state, updateStatus, path, navigate }) || null;
        }
        document.title = path === "/" ? "Efrei.app" : `Efrei.app · ${path.replace("/", "")}`;
        updateStatus();
        updateActiveLinks(path);
    }
});

const registerServiceWorker = () => {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
};

const setupRealtime = () => {
    const wsBase = apiBase.replace(/^http/, "ws");
    const stream = createOddsStream({
        url: `${wsBase}/ws/odds`,
        onStatus: (status) => state.setOddsStatus(status),
        onMessage: (payload) => {
            if (payload?.type === "odds" && Array.isArray(payload.events)) {
                state.setOdds(payload.events);
            }
        }
    });
    stream.connect();
};

state.subscribe(updateStatus);
registerServiceWorker();
setupRealtime();
