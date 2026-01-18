export const createState = () => {
    const tokenKey = "efrei_token";
    const refreshTokenKey = "efrei_refresh_token";
    const onboardingKey = "efrei_onboarding_completed";
    const themeKey = "efrei_theme";
    const userPrefsKey = "efrei_user_prefs";
    let token = localStorage.getItem(tokenKey);
    let refreshToken = localStorage.getItem(refreshTokenKey);
    let odds = [];
    let betslip = [];
    let oddsStatus = "offline";
    let selectedDate = new Date();
    let showOnboarding = false;
    let onboardingCompleted = localStorage.getItem(onboardingKey) === "true";
    let theme = localStorage.getItem(themeKey) || "system";
    let userPrefs = JSON.parse(localStorage.getItem(userPrefsKey) || "{}");
    const listeners = new Set();

    // Apply theme on load
    applyThemeToDocument(theme);

    // Helper function to apply theme to document
    function applyThemeToDocument(currentTheme) {
        const root = document.documentElement;
        root.removeAttribute("data-theme");
        if (currentTheme === "light") {
            root.setAttribute("data-theme", "light");
        } else if (currentTheme === "dark") {
            root.setAttribute("data-theme", "dark");
        }
        // 'system' uses prefers-color-scheme media query
    }

    const notify = () => {
        const snapshot = { token, refreshToken, odds, betslip, oddsStatus, selectedDate, showOnboarding, onboardingCompleted, theme, userPrefs };
        listeners.forEach((listener) => listener(snapshot));
    };

    const setToken = (nextToken) => {
        token = nextToken;
        if (token) {
            localStorage.setItem(tokenKey, token);
        } else {
            localStorage.removeItem(tokenKey);
        }
        notify();
    };

    const setRefreshToken = (nextToken) => {
        refreshToken = nextToken;
        if (refreshToken) {
            localStorage.setItem(refreshTokenKey, refreshToken);
        } else {
            localStorage.removeItem(refreshTokenKey);
        }
        notify();
    };

    const clearToken = () => setToken(null);
    const clearRefreshToken = () => setRefreshToken(null);
    const clearAuth = () => {
        setToken(null);
        setRefreshToken(null);
    };

    const setOdds = (nextOdds) => {
        odds = Array.isArray(nextOdds) ? nextOdds : [];
        notify();
    };

    const setOddsStatus = (status) => {
        oddsStatus = status || "offline";
        notify();
    };

    const addSlip = (selection) => {
        if (!selection || !selection.id) return;
        if (betslip.some((item) => item.id === selection.id)) return;
        betslip = [...betslip, selection];
        notify();
    };

    const removeSlip = (id) => {
        betslip = betslip.filter((item) => item.id !== id);
        notify();
    };

    const clearSlip = () => {
        betslip = [];
        notify();
    };

    const setSelectedDate = (date) => {
        selectedDate = date instanceof Date ? date : new Date(date);
        notify();
    };

    const setShowOnboarding = (value) => {
        showOnboarding = Boolean(value);
        notify();
    };

    const completeOnboarding = () => {
        onboardingCompleted = true;
        showOnboarding = false;
        localStorage.setItem(onboardingKey, "true");
        notify();
    };

    const setTheme = (newTheme) => {
        theme = newTheme || "system";
        localStorage.setItem(themeKey, theme);
        applyThemeToDocument(theme);
        notify();
    };

    const setUserPrefs = (prefs) => {
        userPrefs = { ...userPrefs, ...prefs };
        localStorage.setItem(userPrefsKey, JSON.stringify(userPrefs));
        notify();
    };

    const subscribe = (listener) => {
        listeners.add(listener);
        listener({ token, refreshToken, odds, betslip, oddsStatus, selectedDate, showOnboarding, onboardingCompleted, theme, userPrefs });
        return () => listeners.delete(listener);
    };

    return {
        get token() {
            return token;
        },
        get refreshToken() {
            return refreshToken;
        },
        get odds() {
            return odds;
        },
        get betslip() {
            return betslip;
        },
        get oddsStatus() {
            return oddsStatus;
        },
        get selectedDate() {
            return selectedDate;
        },
        get showOnboarding() {
            return showOnboarding;
        },
        get onboardingCompleted() {
            return onboardingCompleted;
        },
        get theme() {
            return theme;
        },
        get userPrefs() {
            return userPrefs;
        },
        setToken,
        setRefreshToken,
        clearToken,
        clearRefreshToken,
        clearAuth,
        setOdds,
        setOddsStatus,
        addSlip,
        removeSlip,
        clearSlip,
        setSelectedDate,
        setShowOnboarding,
        completeOnboarding,
        setTheme,
        setUserPrefs,
        subscribe
    };
};
