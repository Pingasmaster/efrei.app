import { createRouter } from "./router.js";
import { createState } from "./state.js";
import { createApi } from "./api.js";
import { createOddsStream } from "./realtime.js";
import { renderHome } from "./views/home.js";
import { renderLogin } from "./views/login.js";
import { renderSignup } from "./views/signup.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderChat } from "./views/chat.js";
import { renderSettings } from "./views/settings.js";
import { showOnboardingOverlay } from "./views/onboarding.js";
import { renderNotFound } from "./views/not-found.js";

const viewRoot = document.querySelector("#view");
const rawApiBase = document.querySelector("meta[name=api-base]")?.content?.trim();
let apiBase = rawApiBase || window.location.origin;
if (apiBase.startsWith("/")) {
    apiBase = `${window.location.origin}${apiBase}`;
}

const state = createState();
const api = createApi({ baseUrl: apiBase, state });
let cleanupView = null;
let cleanupOnboarding = null;

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

// Check if onboarding should be shown
const checkOnboarding = () => {
    if (state.showOnboarding && !state.onboardingCompleted) {
        cleanupOnboarding = showOnboardingOverlay(state, () => {
            cleanupOnboarding = null;
        });
    }
};

const routes = {
    "/": renderHome,
    "/login": renderLogin,
    "/signup": renderSignup,
    "/dashboard": renderDashboard,
    "/chat": renderChat,
    "/settings": renderSettings,
    "/not-found": renderNotFound
};

// Page titles in French
const pageTitles = {
    "/": "Central E",
    "/login": "Central E - Connexion",
    "/signup": "Central E - Inscription",
    "/dashboard": "Central E - Tableau de bord",
    "/chat": "Central E - Assistant IA",
    "/settings": "Central E - Parametres",
    "/not-found": "Central E - Page non trouvee"
};

createRouter({
    routes,
    onRoute: (path, view, navigate) => {
        // Cleanup previous view
        if (cleanupView) {
            cleanupView();
            cleanupView = null;
        }

        // Cleanup onboarding if navigating away
        if (cleanupOnboarding && path !== "/dashboard") {
            cleanupOnboarding();
            cleanupOnboarding = null;
        }

        // Render the view
        if (typeof view === "function") {
            cleanupView = view(viewRoot, { api, state, path, navigate }) || null;
        }

        // Update page title
        document.title = pageTitles[path] || `Central E - ${path.replace("/", "")}`;
        updateActiveLinks(path);

        // Check if onboarding should be shown (after navigating to dashboard)
        if (path === "/dashboard") {
            setTimeout(checkOnboarding, 100);
        }
    }
});

// Subscribe to state changes to handle onboarding
state.subscribe((snapshot) => {
    if (snapshot.showOnboarding && !snapshot.onboardingCompleted && !cleanupOnboarding) {
        // Only show onboarding if we're on the dashboard
        if (window.location.pathname === "/dashboard") {
            cleanupOnboarding = showOnboardingOverlay(state, () => {
                cleanupOnboarding = null;
            });
        }
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

registerServiceWorker();
setupRealtime();
